/**
 * Tests for the agent-work planner: planning-core determinism + the adapter
 * that derives a dependency graph from the live work queue.
 *
 * The flagship fixture is the real mergeMaster lane queue (B→C→D→E→F→G, all
 * editing the same files). A correct planner must (a) recover that order from
 * the lane letters and (b) flag the whole family as a single serialize group.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect } from "bun:test";
import { computePlan, type PlanInput } from "../planning/core";
import { buildAgentWorkGraph, planAgentWork, planToMermaid, type RawWorkItem } from "../planning/agentWork";
import { renderMermaidSource, resolveCellRenderBin } from "../cellRender";

// The mergeMaster lanes as they appear in the real queue (lane A is done).
const MERGE_MASTER_QUEUE: RawWorkItem[] = [
  { id: "g", title: "mergeMaster lane G: end-to-end Git proof harness", status: "queued" },
  { id: "f", title: "mergeMaster lane F: conflict send-back and rebase workflow", status: "queued" },
  { id: "e", title: "mergeMaster lane E: parent merge view and squash-merge action", status: "queued" },
  { id: "d", title: "mergeMaster lane D: merge packet and ready-to-merge gate", status: "queued" },
  { id: "c", title: "mergeMaster lane C: spawn child session into worktree and show agent bar", status: "queued" },
  { id: "b", title: "mergeMaster lane B: child worktree lifecycle service", status: "queued" },
  // a terminal item that must be excluded from planning:
  { id: "a", title: "mergeMaster lane A: session and Git state model", status: "done" },
];

describe("buildAgentWorkGraph", () => {
  it("excludes terminal (done/cancelled) items", () => {
    const { input } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    expect(input.tasks.map((t) => t.id).sort()).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("derives a hard lane chain B→C→D→E→F→G", () => {
    const { input } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const edgeSet = new Set(input.hardEdges.map((e) => `${e.source}->${e.target}`));
    expect(edgeSet).toEqual(new Set(["b->c", "c->d", "d->e", "e->f", "f->g"]));
  });

  it("does not add redundant soft couplings on already hard-ordered pairs", () => {
    const { input } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    // Consecutive lanes are hard-ordered, so no soft edge should duplicate them.
    for (const soft of input.softEdges) {
      const key = `${soft.sourceTaskId}->${soft.targetTaskId}`;
      const rev = `${soft.targetTaskId}->${soft.sourceTaskId}`;
      const hard = new Set(input.hardEdges.map((e) => `${e.source}->${e.target}`));
      expect(hard.has(key) || hard.has(rev)).toBe(false);
    }
  });

  it("uses authoritative API dependencies as hard edges with their gate metadata intact", () => {
    const queue: RawWorkItem[] = [
      {id: "predecessor", title: "Build substrate", status: "running"},
      {
        id: "successor",
        title: "Ship consumer",
        status: "queued",
        dependencies: [{
          predecessorId: "predecessor",
          title: "Build substrate",
          status: "running",
          verificationState: "unverified",
          requiredGate: "verified",
          satisfied: false,
        }],
        claimability: {
          state: "waiting",
          blockedBy: [{
            predecessorId: "predecessor",
            title: "Build substrate",
            status: "running",
            verificationState: "unverified",
            requiredGate: "verified",
            satisfied: false,
          }],
        },
      },
    ];
    const graph = buildAgentWorkGraph(queue);
    expect(graph.authoritativeHardEdges).toEqual([{source: "predecessor", target: "successor"}]);
    expect(graph.planningOnlyHardEdges).toEqual([]);
    expect(graph.input.hardEdges).toContainEqual({source: "predecessor", target: "successor"});
  });

  it("never lets an inferred lane edge reverse an authoritative dependency", () => {
    const queue: RawWorkItem[] = [
      {
        id: "b",
        title: "mergeMaster lane B: second",
        status: "queued",
        dependencies: [{
          predecessorId: "c",
          requiredGate: "commands_passed",
          satisfied: false,
        }],
      },
      {id: "c", title: "mergeMaster lane C: first", status: "running"},
    ];
    const graph = buildAgentWorkGraph(queue);
    expect(graph.input.hardEdges).toEqual([{source: "c", target: "b"}]);
    expect(computePlan(graph.input).status).toBe("ready");
  });

  it("drops a planning-only edge that would close a cycle through authoritative precedence", () => {
    const queue: RawWorkItem[] = [
      {id: "a", title: "mergeMaster lane A: first hint", status: "queued"},
      {id: "b", title: "mergeMaster lane B: second hint", status: "queued"},
      {
        id: "c",
        title: "mergeMaster lane C: authoritative first",
        status: "running",
        dependencies: [{predecessorId: "a", requiredGate: "done", satisfied: false}],
      },
    ];
    const graph = buildAgentWorkGraph(queue, {declaredEdges: [{source: "c", target: "a"}]});
    expect(computePlan(graph.input).status).toBe("ready");
    expect(graph.input.hardEdges).not.toContainEqual({source: "c", target: "a"});
  });
});

describe("computePlan on the mergeMaster lanes", () => {
  it("recovers the B→C→D→E→F→G topological order", () => {
    const { input } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const snapshot = computePlan(input);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.topoOrder).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("groups all lanes into a single serialize cluster (shared scope)", () => {
    const { input } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const snapshot = computePlan(input);
    const clusterIds = new Set(Object.values(snapshot.clusterAssignment));
    expect(clusterIds.size).toBe(1); // one family → one cluster → must serialize
  });

  it("needs no edge tearing — a clean chain produces zero torn couplings", () => {
    const { input } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    expect(input.softEdges.length).toBe(0); // fully chained → no redundant couplings
    const snapshot = computePlan(input);
    expect(snapshot.tornEdges.length).toBe(0);
  });

  it("is deterministic across runs", () => {
    const { input } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const a = computePlan(input);
    const b = computePlan(input);
    expect(a.inputsHash).toBe(b.inputsHash);
    expect(a.topoOrder).toEqual(b.topoOrder);
    expect(a.criticalCorridor).toEqual(b.criticalCorridor);
    expect(a.mcPercentiles).toEqual(b.mcPercentiles);
  });
});

describe("planAgentWork rendering", () => {
  it("produces a human-readable plan that names the order and serialization", () => {
    const { text, snapshot } = planAgentWork(MERGE_MASTER_QUEUE);
    expect(snapshot.status).toBe("ready");
    expect(text).toContain("Suggested order:");
    expect(text).toContain("serialize group");
    expect(text).toContain("child worktree lifecycle service"); // lane B, first
  });

  it("handles an empty queue without throwing", () => {
    const { text } = planAgentWork([]);
    expect(text).toContain("0 active items");
  });

  it("separates enforced queue gates from planning-only precedence", () => {
    const queue: RawWorkItem[] = [
      {id: "a", title: "lane A substrate", status: "running"},
      {
        id: "b",
        title: "lane B consumer",
        status: "queued",
        dependencies: [{predecessorId: "a", title: "lane A substrate", requiredGate: "verified", satisfied: false}],
        claimability: {state: "waiting", blockedBy: []},
      },
      {id: "c", title: "lane C follow-up", status: "queued"},
    ];
    const {text} = planAgentWork(queue, {declaredEdges: [{source: "b", target: "c"}]});
    expect(text).toContain("Authoritative queue gates (enforced by claim)");
    expect(text).toContain("lane B consumer — waiting; after lane A substrate [verified]");
    expect(text).toContain("Planning-only precedence:");
    expect(text).toContain("do not affect queue claimability");
  });
});

describe("planToMermaid", () => {
  it("emits a flowchart of the real precedence DAG", () => {
    const { input, included } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const snapshot = computePlan(input);
    const mermaid = planToMermaid(snapshot, input.hardEdges, included);
    expect(mermaid.startsWith("flowchart TD")).toBe(true);
    // One node per active item + one edge per hard precedence edge (B→C→…→G = 5).
    expect((mermaid.match(/^\s+n\d+\[/gm) ?? []).length).toBe(6);
    expect((mermaid.match(/-->/g) ?? []).length).toBe(5);
  });

  it("stays inside the renderer subset — no forbidden syntax leaks into labels", () => {
    const { input, included } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const mermaid = planToMermaid(computePlan(input), input.hardEdges, included);
    // Titles contain ':' which would break a [] label — it must be sanitized out.
    const labels = [...mermaid.matchAll(/\[(.*?)\]/g)].map((m) => m[1]);
    for (const label of labels) {
      expect(label).not.toMatch(/[[\](){}|<>"#&;:]/);
    }
    expect(mermaid).not.toContain("subgraph");
  });

  it("adds NO dotted serialize edges when a cluster is already hard-chained", () => {
    // The mergeMaster lanes are one cluster but fully hard-ordered B→…→G, so the
    // solid arrows already serialize them — no redundant dotted spine.
    const { input, included } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const mermaid = planToMermaid(computePlan(input), input.hardEdges, included);
    expect(mermaid).not.toContain("-.->");
  });

  it("draws a dotted serialize edge between shared-scope items with no hard order", () => {
    // Two items editing the same file (so one cluster, soft-coupled, NOT hard
    // ordered) → dotted spine; an unrelated item stays free.
    const queue: RawWorkItem[] = [
      { id: "x", title: "refactor auth module", status: "queued", writeScope: { include: ["src/auth/login.ts"] } },
      { id: "y", title: "tweak auth session", status: "queued", writeScope: { include: ["src/auth/login.ts"] } },
      { id: "z", title: "update docs", status: "queued", writeScope: { include: ["docs/readme.md"] } },
    ];
    const { input, included } = buildAgentWorkGraph(queue);
    const mermaid = planToMermaid(computePlan(input), input.hardEdges, included);
    expect((mermaid.match(/-\.->/g) ?? []).length).toBe(1);
    expect(mermaid).not.toContain("-->"); // no hard precedence in this queue
  });

  it("returns empty string for a blocked or empty plan (text explains those)", () => {
    expect(planToMermaid({ status: "blocked" } as never, [], [])).toBe("");
    const { input, included } = buildAgentWorkGraph([]);
    expect(planToMermaid(computePlan(input), input.hardEdges, included)).toBe("");
  });

  const maybe = resolveCellRenderBin() !== null ? it : it.skip;
  maybe("the generated graph renders cleanly through cell-render", () => {
    const { input, included } = buildAgentWorkGraph(MERGE_MASTER_QUEUE);
    const mermaid = planToMermaid(computePlan(input), input.hardEdges, included);
    const result = renderMermaidSource(mermaid, { color: "none" });
    if (!result.ok) throw new Error(`planToMermaid output failed to render: ${result.error}\n---\n${mermaid}`);
    expect(result.ok).toBe(true);
  });
});

describe("computePlan safety", () => {
  it("marks a hard precedence cycle as blocked", () => {
    const input: PlanInput = {
      tasks: [
        { id: "x", title: "X", effort: "medium", planning: { cynefinDomain: "clear" } },
        { id: "y", title: "Y", effort: "medium", planning: { cynefinDomain: "clear" } },
      ],
      hardEdges: [
        { source: "x", target: "y" },
        { source: "y", target: "x" },
      ],
      softEdges: [],
    };
    const snapshot = computePlan(input);
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.topoOrder).toEqual([]);
    expect(snapshot.invalidCycles.length).toBe(1);
  });

  it("tears the weakest soft coupling to break a soft cycle", () => {
    const input: PlanInput = {
      tasks: [
        { id: "p", title: "P", effort: "small", planning: { cynefinDomain: "clear" } },
        { id: "q", title: "Q", effort: "small", planning: { cynefinDomain: "clear" } },
      ],
      hardEdges: [],
      softEdges: [
        { id: "p:q", sourceTaskId: "p", targetTaskId: "q", couplingType: "resource", strength: 0.9 },
        { id: "q:p", sourceTaskId: "q", targetTaskId: "p", couplingType: "resource", strength: 0.3 },
      ],
    };
    const snapshot = computePlan(input);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.tornEdges.length).toBe(1);
    expect(snapshot.tornEdges[0].sourceTaskId).toBe("q"); // weaker (0.3) torn
  });
});
