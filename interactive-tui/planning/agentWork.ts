/**
 * agentWork — adapter from the Siftable agent-work queue to planning-core.
 *
 * Work items don't carry an explicit `dependsOn`, so this module *derives* the
 * graph:
 *   - hard edges  — consecutive lane letters within a lane family
 *                   ("mergeMaster lane B" → "lane C" …), and queueRank order
 *                   among siblings under the same parent task.
 *   - soft edges  — resource coupling from overlapping write scope, shared lane
 *                   family, or shared parent task (the "these edit the same
 *                   files, serialize them" signal).
 *
 * The output feeds `computePlan`. Nothing here is persisted; the graph is
 * rebuilt on each `/plan work`. See planning/core.ts for the math and the
 * merge-master lanes for where claim-time enforcement consumes the clusters.
 */
import {
  computePlan,
  type PlanInput,
  type PlanSnapshot,
  type SoftCoupling,
  type TaskNode,
  type CynefinDomain,
  type HardDependency,
} from "./core";
import { scopeOverlap, scopeTokenSet } from "./scope";

/** Loose shape of a work item as returned by the REST list endpoint. */
export interface RawWorkItem {
  id: string;
  title?: string | null;
  prompt?: string | null;
  status?: string | null;
  taskId?: string | null;
  queueRank?: number | null;
  writeScope?: Record<string, unknown> | null;
  verificationCommands?: string[] | null;
}

const ACTIVE_STATUSES = new Set(["queued", "claimed", "running", "needs_review", "blocked", "ready"]);

const LANE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// --- field inference --------------------------------------------------------

function inferDomain(title: string, prompt: string, hasVerify: boolean): CynefinDomain {
  const text = `${title} ${prompt}`.toLowerCase();
  if (/\b(spike|investigate|audit|explore|research|proof|prove|reconcile|triage)\b/.test(text)) {
    return "aporetic";
  }
  if (/\b(design|architect|architecture|native|zig|migrate|migration|refactor)\b/.test(text)) {
    return "complex";
  }
  if (hasVerify && title.length <= 60) return "clear";
  return "complicated";
}

function inferEffort(title: string): string {
  const text = title.toLowerCase();
  if (/\b(end-to-end|harness|service|pipeline|suite)\b/.test(text)) return "large";
  if (/\b(fix|tweak|polish|rename|bump)\b/.test(text)) return "small";
  return "medium";
}

function inferReversibility(item: RawWorkItem, title: string): number {
  const mode = String((item.writeScope as Record<string, unknown> | null)?.mode ?? "").toLowerCase();
  if (mode === "read-only" || mode === "read_only") return 0.9;
  if (/\b(migrate|migration|schema|deploy|delete|drop|merge)\b/.test(title.toLowerCase())) return 0.3;
  return 0.5;
}

/** Pull a flat set of scope tokens (paths, tags, modules) from writeScope. */
export function scopeTokens(item: RawWorkItem): Set<string> {
  const raw: string[] = [];
  const scope = item.writeScope;
  if (scope && typeof scope === "object") {
    for (const value of Object.values(scope)) {
      if (typeof value === "string") raw.push(value);
      else if (Array.isArray(value)) {
        for (const entry of value) if (typeof entry === "string") raw.push(entry);
      }
    }
  }
  return scopeTokenSet(raw);
}

/** Lane family + letter from a title like "mergeMaster lane C: spawn child…". */
function laneOf(title: string): { family: string; letter: string } | null {
  const match = /^(.*?)\blane\s+([A-Z])\b/i.exec(title);
  if (!match) return null;
  const family = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return { family: family || "lane", letter: match[2].toUpperCase() };
}

// --- graph construction -----------------------------------------------------

/** For each node, the set of nodes reachable from it via hard edges (excl. self). */
function transitiveReachability(nodeIds: string[], hardEdges: HardDependency[]): Map<string, Set<string>> {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of hardEdges) adj.get(e.source)?.push(e.target);
  const out = new Map<string, Set<string>>();
  for (const start of nodeIds) {
    const seen = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(adj.get(cur) ?? []));
    }
    out.set(start, seen);
  }
  return out;
}

interface BuiltGraph {
  input: PlanInput;
  /** Items that were active and included in the plan, in input order. */
  included: RawWorkItem[];
  /** Hard edges the adapter derived this run (lane chains + sibling rank) — what `--apply` persists. */
  derivedHardEdges: HardDependency[];
}

export interface BuildOptions {
  /** Durable precedence edges (from the plan overlay) to merge as hard edges. */
  declaredEdges?: Array<{ source: string; target: string }>;
}

export function buildAgentWorkGraph(items: RawWorkItem[], opts: BuildOptions = {}): BuiltGraph {
  const active = items.filter((item) => ACTIVE_STATUSES.has(String(item.status ?? "queued")));
  const tasks: TaskNode[] = active.map((item) => {
    const title = String(item.title ?? item.id);
    const prompt = String(item.prompt ?? "");
    const hasVerify = Array.isArray(item.verificationCommands) && item.verificationCommands.length > 0;
    return {
      id: item.id,
      title,
      effort: inferEffort(title),
      planning: {
        cynefinDomain: inferDomain(title, prompt, hasVerify),
        reversibility: inferReversibility(item, title),
      },
    };
  });

  const byId = new Map(active.map((item) => [item.id, item]));
  const hardEdges: HardDependency[] = [];
  const softEdges: SoftCoupling[] = [];

  // 1. Lane chains → hard precedence (B before C before D …) per family.
  const laneFamilies = new Map<string, Array<{ id: string; letter: string }>>();
  for (const item of active) {
    const lane = laneOf(String(item.title ?? ""));
    if (!lane) continue;
    const list = laneFamilies.get(lane.family) ?? [];
    list.push({ id: item.id, letter: lane.letter });
    laneFamilies.set(lane.family, list);
  }
  for (const list of laneFamilies.values()) {
    list.sort((a, b) => LANE_LETTERS.indexOf(a.letter) - LANE_LETTERS.indexOf(b.letter));
    for (let i = 1; i < list.length; i += 1) {
      hardEdges.push({ source: list[i - 1].id, target: list[i].id });
    }
  }

  // 2. Sibling work items under the same human task → queueRank precedence.
  const byTask = new Map<string, RawWorkItem[]>();
  for (const item of active) {
    if (!item.taskId) continue;
    const list = byTask.get(item.taskId) ?? [];
    list.push(item);
    byTask.set(item.taskId, list);
  }
  for (const list of byTask.values()) {
    if (list.length < 2) continue;
    const ranked = list
      .filter((item) => typeof item.queueRank === "number")
      .sort((a, b) => (a.queueRank as number) - (b.queueRank as number));
    for (let i = 1; i < ranked.length; i += 1) {
      hardEdges.push({ source: ranked[i - 1].id, target: ranked[i].id });
    }
  }

  // Snapshot what we derived (lane chains + sibling rank) before folding in the
  // durable overlay — `--apply` persists exactly these.
  const derivedHardEdges = hardEdges.map((e) => ({ ...e }));

  // 2b. Declared precedence from the overlay → hard edges (active endpoints only,
  // deduped against derived edges). These are what `--apply`/`--after` recorded.
  const activeIds = new Set(active.map((i) => i.id));
  const hardKeySet = new Set(hardEdges.map((e) => `${e.source}->${e.target}`));
  for (const edge of opts.declaredEdges ?? []) {
    if (!activeIds.has(edge.source) || !activeIds.has(edge.target)) continue;
    const key = `${edge.source}->${edge.target}`;
    if (hardKeySet.has(key)) continue;
    hardKeySet.add(key);
    hardEdges.push({ source: edge.source, target: edge.target });
  }

  // 3. Soft resource couplings: shared scope / lane family / parent task.
  //
  // A resource coupling is *symmetric* ("these edit the same thing, serialize
  // them") — it has no inherent direction. We therefore (a) skip pairs already
  // ordered by hard precedence, transitively (the chain + clustering already
  // serialize those — a directed soft edge there would only fight the chain and
  // get torn), and (b) orient the remaining couplings by one stable total order
  // so they can never form a cycle and never need tearing.
  const reachable = transitiveReachability(active.map((i) => i.id), hardEdges);
  const orderKey = (item: RawWorkItem): string => {
    const lane = laneOf(String(item.title ?? ""));
    const lanePart = lane ? `${lane.family}:${String(LANE_LETTERS.indexOf(lane.letter)).padStart(3, "0")}` : "~";
    return `${lanePart}|${String(item.title ?? item.id)}|${item.id}`;
  };
  const scopes = new Map(active.map((item) => [item.id, scopeTokens(item)]));
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      // Already serialized by precedence (directly or transitively)? Skip.
      if (reachable.get(a.id)?.has(b.id) || reachable.get(b.id)?.has(a.id)) continue;

      let strength = 0;
      const overlap = scopeOverlap(scopes.get(a.id)!, scopes.get(b.id)!);
      if (overlap > 0) strength = Math.max(strength, Math.min(1, 0.4 + 0.6 * overlap));

      const laneA = laneOf(String(a.title ?? ""));
      const laneB = laneOf(String(b.title ?? ""));
      if (laneA && laneB && laneA.family === laneB.family) strength = Math.max(strength, 0.8);

      if (a.taskId && a.taskId === b.taskId) strength = Math.max(strength, 0.7);

      if (strength > 0) {
        // Orient by stable total order → acyclic regardless of how many pairs.
        const [src, dst] = orderKey(a) <= orderKey(b) ? [a, b] : [b, a];
        softEdges.push({
          id: `${src.id}:${dst.id}`,
          sourceTaskId: src.id,
          targetTaskId: dst.id,
          couplingType: "resource",
          strength: Number(strength.toFixed(4)),
        });
      }
    }
  }

  return { input: { tasks, hardEdges, softEdges }, included: active, derivedHardEdges };
}

/**
 * Resolve a human-typed reference ("ce2f…" id, or a title substring) to exactly
 * one active work item id. Returns the id, or an error describing why it didn't
 * resolve uniquely — so `--after` can fail loudly instead of guessing.
 */
export function resolveWorkItemRef(items: RawWorkItem[], ref: string): { id: string } | { error: string } {
  const needle = ref.trim().toLowerCase();
  if (!needle) return { error: "empty reference" };
  const exact = items.find((i) => i.id.toLowerCase() === needle);
  if (exact) return { id: exact.id };
  const matches = items.filter((i) => String(i.title ?? "").toLowerCase().includes(needle));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) return { error: `no active work item matches "${ref}"` };
  return { error: `"${ref}" is ambiguous (${matches.length} matches); use a work item id` };
}

// --- rendering --------------------------------------------------------------

function urgencyLabel(priority: number): string {
  if (priority >= 0.6) return "Do first";
  if (priority >= 0.4) return "High";
  if (priority >= 0.25) return "Medium";
  if (priority >= 0.12) return "Later";
  return "Backlog";
}

function humanDays(days: number): string {
  const d = Math.round(days);
  if (d >= 30) {
    const months = Math.round(d / 30);
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  if (d >= 10) {
    const weeks = Math.round(d / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  return `${d} day${d === 1 ? "" : "s"}`;
}

function reasonFromComponents(c: {
  topoBlock: number;
  complexInherit: number;
  irreversibility: number;
  criticality: number;
}): string {
  const bits: string[] = [];
  if (c.topoBlock > 0) bits.push(`unblocks ${c.topoBlock} item${c.topoBlock === 1 ? "" : "s"}`);
  if (c.complexInherit > 0) bits.push(`${c.complexInherit} risky downstream`);
  if (c.criticality >= 0.4) bits.push("on the critical path");
  return bits.slice(0, 2).join(" · ");
}

export interface RenderedPlan {
  snapshot: PlanSnapshot;
  text: string;
  /** A `flowchart TD` of the *computed* plan graph, or "" when there's nothing to draw. */
  mermaid: string;
}

/**
 * Sanitize a work-item title into a short, subset-safe Mermaid node label.
 * The cell-render flowchart parser only tolerates plain text inside `[ ]`; any
 * of `[](){}|<>"#&;:` will break or garble the node, so strip them and truncate.
 */
function mermaidLabel(title: string): string {
  let t = title.replace(/\s+/g, " ").trim();
  // Compress a "<family> lane X: <rest>" title to "lane X <rest>" so the
  // distinctive part survives the length budget instead of the family prefix.
  t = t.replace(/^.*?\blane\s+([A-Z])\b\s*:?\s*/i, "lane $1 ");
  t = t.replace(/[[\](){}|<>"#&;:]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length > 30) t = `${t.slice(0, 29).trimEnd()}…`;
  return t || "item";
}

/**
 * Render the *computed* plan as a Mermaid `flowchart TD` — directly from the
 * real precedence DAG (`hardEdges`), critical corridor, and topo order. No LLM:
 * this is the same graph the text report describes, drawn. Returns "" when the
 * plan is blocked or empty (the text already explains those cases).
 *
 * Node shapes are restricted to `[ ]` and edges to `-->` to stay inside the
 * terminal renderer's supported subset; critical-path nodes get a `★` marker
 * (we can't use color/`style` in the subset).
 */
export function planToMermaid(snapshot: PlanSnapshot, hardEdges: HardDependency[], included: RawWorkItem[]): string {
  if (snapshot.status === "blocked" || included.length === 0) return "";
  const nodeId = new Map<string, string>();
  included.forEach((item, i) => nodeId.set(item.id, `n${i + 1}`));
  const titleOf = (id: string) => included.find((i) => i.id === id)?.title ?? id;
  const critical = new Set(
    snapshot.criticalCorridor.filter((e) => e.criticality >= 0.25).slice(0, 5).map((e) => e.taskId),
  );

  const lines: string[] = ["flowchart TD"];
  // Declare nodes in topo order so the layout reads top-to-bottom by sequence.
  const order = snapshot.topoOrder.length ? snapshot.topoOrder : included.map((i) => i.id);
  for (const id of order) {
    const nid = nodeId.get(id);
    if (!nid) continue;
    const star = critical.has(id) ? "★ " : "";
    lines.push(`  ${nid}[${star}${mermaidLabel(titleOf(id))}]`);
  }
  // Hard precedence edges (lane chains, sibling rank, declared/--after edges).
  for (const e of hardEdges) {
    const s = nodeId.get(e.source);
    const t = nodeId.get(e.target);
    if (s && t) lines.push(`  ${s} --> ${t}`);
  }

  // Serialize groups → dotted edges. A cluster of size >1 shares write scope and
  // must NOT run concurrently. Members already chained by hard precedence are
  // visually serialized by the solid arrows, so we only add a dotted spine
  // between cluster members that AREN'T already hard-ordered (directly or
  // transitively). Orient along topo order so the spine can't form a cycle.
  const reachable = transitiveReachability(included.map((i) => i.id), hardEdges);
  const topoIndex = new Map(order.map((id, i) => [id, i]));
  const clusters = new Map<number, string[]>();
  for (const [id, cid] of Object.entries(snapshot.clusterAssignment)) {
    if (!nodeId.has(id)) continue;
    (clusters.get(cid) ?? clusters.set(cid, []).get(cid)!).push(id);
  }
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => (topoIndex.get(a) ?? 1e9) - (topoIndex.get(b) ?? 1e9));
    for (let i = 1; i < members.length; i += 1) {
      const a = members[i - 1];
      const b = members[i];
      if (reachable.get(a)?.has(b) || reachable.get(b)?.has(a)) continue; // already serialized
      lines.push(`  ${nodeId.get(a)} -.-> ${nodeId.get(b)}`);
    }
  }
  return lines.join("\n");
}

export function planAgentWork(items: RawWorkItem[], opts: BuildOptions = {}): RenderedPlan {
  const { input, included } = buildAgentWorkGraph(items, opts);
  const snapshot = computePlan(input);
  const titleOf = (id: string) => included.find((i) => i.id === id)?.title ?? id;

  const lines: string[] = [];
  lines.push(`Plan · agent work queue (${included.length} active item${included.length === 1 ? "" : "s"})`);

  if (snapshot.status === "blocked") {
    lines.push("");
    lines.push("⚠ Plan is BLOCKED — cannot schedule until resolved:");
    for (const cycle of snapshot.invalidCycles) {
      lines.push(`  - precedence cycle: ${cycle.taskIds.map(titleOf).join(" → ")}`);
    }
    if (snapshot.invalidCycles.length === 0) {
      lines.push("  - a chaotic (crisis) item is present; stabilize it before planning.");
    }
    return { snapshot, text: lines.join("\n"), mermaid: "" };
  }

  if (snapshot.mcPercentiles) {
    const p = snapshot.mcPercentiles;
    lines.push(
      `Forecast: p50 ${humanDays(p.p50)} · p80 ${humanDays(p.p80)} · p95 ${humanDays(p.p95)} (Monte Carlo, 1000 trials)`
    );
  }

  // Suggested order = topo order, annotated with priority.
  const rankById = new Map(snapshot.priorityRanking.map((r) => [r.taskId, r]));
  lines.push("");
  lines.push("Suggested order:");
  snapshot.topoOrder.forEach((id, idx) => {
    const r = rankById.get(id);
    const label = r ? ` [${urgencyLabel(r.priority)}]` : "";
    const why = r ? reasonFromComponents(r.components) : "";
    lines.push(`  ${idx + 1}. ${titleOf(id)}${label}${why ? ` — ${why}` : ""}`);
  });

  // Parallel vs serialize: clusters of size >1 must serialize; singletons run in parallel.
  const clusters = new Map<number, string[]>();
  for (const [id, cid] of Object.entries(snapshot.clusterAssignment)) {
    const list = clusters.get(cid) ?? [];
    list.push(id);
    clusters.set(cid, list);
  }
  const serialGroups = [...clusters.values()].filter((g) => g.length > 1);
  const parallelSafe = [...clusters.values()].filter((g) => g.length === 1).flat();
  lines.push("");
  lines.push("Parallelism:");
  if (serialGroups.length === 0) {
    lines.push("  - all items are independent — safe to run in parallel.");
  } else {
    serialGroups.forEach((group, idx) => {
      lines.push(`  - serialize group ${idx + 1} (shared scope, do NOT run concurrently):`);
      for (const id of group) lines.push(`      · ${titleOf(id)}`);
    });
    if (parallelSafe.length) {
      lines.push(`  - parallel-safe (no scope overlap): ${parallelSafe.map(titleOf).join(", ")}`);
    }
  }

  // Critical path.
  if (snapshot.criticalCorridor.length) {
    lines.push("");
    lines.push("Likely critical path:");
    for (const entry of snapshot.criticalCorridor.slice(0, 5)) {
      lines.push(`  - ${titleOf(entry.taskId)} — ${Math.round(entry.criticality * 100)}% of simulations`);
    }
  }

  // Frame-before-committing (aporetic) warnings.
  const frameFirst = snapshot.priorityRanking.filter((r) => r.reason?.startsWith("Aporetic"));
  if (frameFirst.length) {
    lines.push("");
    lines.push("Frame before committing (uncertain — scope it before downstream work):");
    for (const r of frameFirst) lines.push(`  - ${titleOf(r.taskId)}`);
  }

  if (snapshot.tornEdges.length) {
    lines.push("");
    lines.push(`Note: tore ${snapshot.tornEdges.length} soft coupling(s) to break cycles (sequenced, not blocked).`);
  }

  return { snapshot, text: lines.join("\n"), mermaid: planToMermaid(snapshot, input.hardEdges, included) };
}
