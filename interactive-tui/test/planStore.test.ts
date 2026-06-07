/**
 * Tests for the durable plan overlay (planStore) and how declared precedence
 * edges flow back into the agent-work planner. This is the `--apply` / `--after`
 * persistence: edges recorded once are honored on every later /plan work.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadPlanOverlay, savePlanOverlay, addDeclaredEdges, planOverlayPath } from "../planning/planStore";
import { buildAgentWorkGraph, resolveWorkItemRef, type RawWorkItem } from "../planning/agentWork";
import { computePlan } from "../planning/core";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "planstore-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("planStore", () => {
  it("returns an empty overlay when none exists", () => {
    expect(loadPlanOverlay(root)).toEqual({ version: 1, declaredEdges: [] });
  });

  it("round-trips and dedups declared edges, skipping self-edges", () => {
    const first = addDeclaredEdges(root, [{ source: "a", target: "b" }, { source: "x", target: "x" }]);
    expect(first.added.map((e) => `${e.source}->${e.target}`)).toEqual(["a->b"]); // self-edge dropped
    expect(existsSync(planOverlayPath(root))).toBe(true);

    const second = addDeclaredEdges(root, [{ source: "a", target: "b" }, { source: "b", target: "c" }]);
    expect(second.added.map((e) => `${e.source}->${e.target}`)).toEqual(["b->c"]); // a->b deduped

    expect(loadPlanOverlay(root).declaredEdges.map((e) => `${e.source}->${e.target}`)).toEqual(["a->b", "b->c"]);
  });

  it("recovers from a corrupt overlay file", () => {
    savePlanOverlay(root, { version: 1, declaredEdges: [{ source: "a", target: "b" }] });
    rmSync(planOverlayPath(root));
    expect(loadPlanOverlay(root).declaredEdges).toEqual([]);
  });
});

describe("declared edges flow into the planner", () => {
  // Two items with no lane letters and no shared scope → planner can't infer order.
  const items: RawWorkItem[] = [
    { id: "design", title: "Design the schema", status: "queued" },
    { id: "build", title: "Build the importer", status: "queued" },
  ];

  it("honors a declared source→target as hard precedence", () => {
    const without = computePlan(buildAgentWorkGraph(items).input);
    // Default order is title/id sorted ("Build" < "Design") — NOT the real intent.
    expect(without.topoOrder).toEqual(["build", "design"]);

    const withEdge = computePlan(
      buildAgentWorkGraph(items, { declaredEdges: [{ source: "design", target: "build" }] }).input
    );
    expect(withEdge.topoOrder).toEqual(["design", "build"]); // taught precedence wins
    expect(withEdge.status).toBe("ready");
  });

  it("ignores declared edges whose endpoints are not active items", () => {
    const built = buildAgentWorkGraph(items, { declaredEdges: [{ source: "design", target: "ghost" }] });
    expect(built.input.hardEdges).toEqual([]); // ghost is not in the queue
  });

  it("keeps derived edges separate from declared, for --apply", () => {
    const laneItems: RawWorkItem[] = [
      { id: "b", title: "feat lane B: first", status: "queued" },
      { id: "c", title: "feat lane C: second", status: "queued" },
    ];
    const built = buildAgentWorkGraph(laneItems);
    expect(built.derivedHardEdges.map((e) => `${e.source}->${e.target}`)).toEqual(["b->c"]);
  });
});

describe("resolveWorkItemRef", () => {
  const items: RawWorkItem[] = [
    { id: "ce2f00", title: "Add token meter", status: "queued" },
    { id: "ab1200", title: "Restyle header", status: "queued" },
    { id: "ab3400", title: "Restyle footer", status: "queued" },
  ];

  it("resolves by exact id and by unique title substring", () => {
    expect(resolveWorkItemRef(items, "ce2f00")).toEqual({ id: "ce2f00" });
    expect(resolveWorkItemRef(items, "token")).toEqual({ id: "ce2f00" });
  });

  it("errors on ambiguous and missing references", () => {
    expect("error" in resolveWorkItemRef(items, "restyle")).toBe(true); // 2 matches
    expect("error" in resolveWorkItemRef(items, "nope")).toBe(true);
  });
});
