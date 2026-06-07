/**
 * planning-core — pure, deterministic graph planner for `sift interactive`.
 *
 * This is a self-contained port of the math in
 * `exf-app/src/services/projectPlanningService.ts` (Cynefin duration models,
 * hard precedence + tearable soft couplings, Kahn topo order, Monte Carlo
 * criticality, positional complexity, priority ranking). It has NO dependency
 * on a database, env, logger, or the network — the same `(nodes, edges, seed)`
 * always produce the same `PlanSnapshot`.
 *
 * Scope boundary: this module decides *ordering, criticality, and which work
 * must serialize*. It does not fetch work items, spawn agents, or run git — the
 * adapter (`agentWork.ts`) and the merge-master lanes own that. Keeping it pure
 * is what lets a `planning_engine.zig` drop in behind `computePlan` later
 * (mirroring how `threadEngine` mirrors its Zig kernel) once a bench lane proves
 * the Monte Carlo is a felt cost.
 *
 * Determinism note: run-to-run determinism within this implementation is
 * guaranteed (mulberry32 seeded from the inputs hash). Byte-identical parity
 * with the backend TS is NOT a goal — the agent-work graph is transient and
 * never compared against a persisted backend snapshot.
 */
import { createHash } from "node:crypto";

export type CynefinDomain = "clear" | "complicated" | "complex" | "aporetic" | "chaotic";

export type DurationModel =
  | { kind: "point"; days: number }
  | { kind: "beta"; a: number; m: number; b: number }
  | { kind: "lognormal"; mu: number; sigma: number; failureProb?: number };

export interface TaskNode {
  id: string;
  title: string;
  effort: string; // trivial | small | medium | large | epic | unknown
  planning: {
    cynefinDomain: CynefinDomain;
    reversibility?: number | null; // 0 (irreversible) .. 1 (fully reversible)
    durationModel?: DurationModel | null;
  };
}

export interface HardDependency {
  source: string;
  target: string;
  lagMinutes?: number;
}

export interface SoftCoupling {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  couplingType: "resource" | "information";
  strength: number; // 0..1
}

export interface PriorityRecommendation {
  taskId: string;
  priority: number;
  reason: string | null;
  components: {
    topoBlock: number;
    complexInherit: number;
    irreversibility: number;
    criticality: number;
  };
}

export interface TornEdge {
  sourceTaskId: string;
  targetTaskId: string;
  couplingType: "resource" | "information";
  reason: string;
}

export interface InvalidCycle {
  taskIds: string[];
  via: "precedence";
}

export interface PlanInput {
  tasks: TaskNode[];
  hardEdges: HardDependency[];
  softEdges: SoftCoupling[];
  seed?: string;
  options?: { trials?: number };
}

export interface PlanSnapshot {
  inputsHash: string;
  status: "ready" | "blocked";
  sccGroups: string[][];
  clusterAssignment: Record<string, number>;
  tornEdges: TornEdge[];
  invalidCycles: InvalidCycle[];
  topoOrder: string[];
  mcPercentiles: { p50: number; p80: number; p95: number } | null;
  criticalCorridor: Array<{ taskId: string; criticality: number }>;
  priorityRanking: PriorityRecommendation[];
}

type GraphEdgeLike = { source: string; target: string };

const DEFAULT_TRIALS = 1000;

// --- deterministic RNG + samplers (ported verbatim) -------------------------

function stablePercentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1));
  return values[index];
}

function hashToSeed(hash: string): number {
  return parseInt(hash.slice(0, 8), 16) >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    return sampleGamma(1 + shape, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded so a pathological RNG stream can never hang the planner.
  for (let guard = 0; guard < 10000; guard += 1) {
    const x = sampleNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // mean fallback
}

function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

function samplePert(a: number, m: number, b: number, rng: () => number): number {
  if (!(b > a)) return Math.max(a, m, b, 0.1);
  const lambda = 4;
  const alpha = 1 + lambda * ((m - a) / (b - a));
  const beta = 1 + lambda * ((b - m) / (b - a));
  return a + sampleBeta(alpha, beta, rng) * (b - a);
}

function domainVariance(domain: CynefinDomain): number {
  switch (domain) {
    case "clear":
      return 0;
    case "complicated":
      return 0.3;
    case "complex":
      return 1;
    case "aporetic":
      return 2;
    case "chaotic":
      return 4;
    default:
      return 1;
  }
}

function normalizeDurationModel(task: TaskNode): DurationModel {
  if (task.planning.durationModel) return task.planning.durationModel;

  const effortBase: Record<string, number> = {
    trivial: 0.25,
    small: 0.75,
    medium: 2,
    large: 4,
    epic: 8,
    unknown: 1.5,
  };
  const base = effortBase[task.effort] ?? effortBase.unknown;

  switch (task.planning.cynefinDomain) {
    case "clear":
      return { kind: "point", days: base };
    case "complicated":
      return { kind: "beta", a: Math.max(0.25, base * 0.6), m: base, b: Math.max(base * 1.6, base + 0.5) };
    case "complex":
      return { kind: "lognormal", mu: Math.log(Math.max(base * 1.5, 0.5)), sigma: 0.65, failureProb: 0.15 };
    case "aporetic":
      return { kind: "lognormal", mu: Math.log(Math.max(base * 1.75, 0.75)), sigma: 0.8, failureProb: 0.3 };
    case "chaotic":
      return { kind: "lognormal", mu: Math.log(Math.max(base * 2, 1)), sigma: 1, failureProb: 1 };
    default:
      return { kind: "beta", a: Math.max(0.25, base * 0.6), m: base, b: Math.max(base * 1.6, base + 0.5) };
  }
}

function sampleDuration(task: TaskNode, rng: () => number): number {
  const model = normalizeDurationModel(task);
  if (task.planning.cynefinDomain === "chaotic") return Number.POSITIVE_INFINITY;
  switch (model.kind) {
    case "point":
      return Math.max(model.days, 0.05);
    case "beta":
      return Math.max(samplePert(model.a, model.m, model.b, rng), 0.05);
    case "lognormal":
      if ((model.failureProb ?? 0) > 0 && rng() < (model.failureProb ?? 0)) return Number.POSITIVE_INFINITY;
      return Math.max(Math.exp(model.mu + model.sigma * sampleNormal(rng)), 0.05);
    default:
      return 1;
  }
}

// --- graph helpers (ported) -------------------------------------------------

function taskComparator(taskMap: Map<string, TaskNode>) {
  return (left: string, right: string): number => {
    const a = taskMap.get(left);
    const b = taskMap.get(right);
    const byTitle = (a?.title ?? left).localeCompare(b?.title ?? right);
    return byTitle !== 0 ? byTitle : left.localeCompare(right);
  };
}

function adjacencyFor(nodeIds: string[], edges: GraphEdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const nodeId of nodeIds) map.set(nodeId, []);
  for (const edge of edges) {
    if (!map.has(edge.source) || !map.has(edge.target)) continue;
    map.get(edge.source)!.push(edge.target);
  }
  return map;
}

// Iterative Tarjan SCC (recursion in the backend; flattened here so deep
// agent-work graphs can't blow the stack — same component output + sort).
function tarjan(nodeIds: string[], edges: GraphEdgeLike[]): string[][] {
  const adjacency = adjacencyFor(nodeIds, edges);
  let index = 0;
  const indexMap = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  for (const root of nodeIds) {
    if (indexMap.has(root)) continue;
    // work stack of (node, next-neighbour-index)
    const work: Array<{ node: string; i: number }> = [{ node: root, i: 0 }];
    indexMap.set(root, index);
    lowLink.set(root, index);
    index += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length) {
      const frame = work[work.length - 1];
      const neighbours = adjacency.get(frame.node) ?? [];
      if (frame.i < neighbours.length) {
        const next = neighbours[frame.i];
        frame.i += 1;
        if (!indexMap.has(next)) {
          indexMap.set(next, index);
          lowLink.set(next, index);
          index += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, i: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, indexMap.get(next)!));
        }
      } else {
        if (lowLink.get(frame.node) === indexMap.get(frame.node)) {
          const component: string[] = [];
          let current: string | undefined;
          do {
            current = stack.pop();
            if (!current) break;
            onStack.delete(current);
            component.push(current);
          } while (current !== frame.node);
          components.push(component.sort((a, b) => a.localeCompare(b)));
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1];
          lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
        }
      }
    }
  }
  return components;
}

function hasSelfLoop(nodeId: string, edges: GraphEdgeLike[]): boolean {
  return edges.some((edge) => edge.source === nodeId && edge.target === nodeId);
}

function chooseTearEdge(component: string[], softEdges: SoftCoupling[]): SoftCoupling | null {
  const members = new Set(component);
  const candidates = softEdges
    .filter((edge) => members.has(edge.sourceTaskId) && members.has(edge.targetTaskId))
    .sort((a, b) => {
      if (a.strength !== b.strength) return a.strength - b.strength;
      if (a.couplingType !== b.couplingType) return a.couplingType === "resource" ? -1 : 1;
      const bySource = a.sourceTaskId.localeCompare(b.sourceTaskId);
      return bySource !== 0 ? bySource : a.targetTaskId.localeCompare(b.targetTaskId);
    });
  return candidates[0] ?? null;
}

function clusterTasks(tasks: TaskNode[], hardEdges: HardDependency[], softEdges: SoftCoupling[]): Record<string, number> {
  const nodeIds = tasks.map((task) => task.id);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const undirected = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) undirected.set(nodeId, new Set());

  for (const edge of hardEdges) {
    undirected.get(edge.source)?.add(edge.target);
    undirected.get(edge.target)?.add(edge.source);
  }
  for (const edge of softEdges) {
    if (edge.strength < 0.45) continue;
    undirected.get(edge.sourceTaskId)?.add(edge.targetTaskId);
    undirected.get(edge.targetTaskId)?.add(edge.sourceTaskId);
  }

  const visited = new Set<string>();
  const clusters: string[][] = [];
  for (const nodeId of [...nodeIds].sort(taskComparator(taskMap))) {
    if (visited.has(nodeId)) continue;
    const stack = [nodeId];
    visited.add(nodeId);
    const component: string[] = [];
    while (stack.length) {
      const current = stack.pop()!;
      component.push(current);
      const neighbors = [...(undirected.get(current) ?? [])].sort(taskComparator(taskMap));
      for (const next of neighbors) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    clusters.push(component.sort(taskComparator(taskMap)));
  }

  clusters.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return taskComparator(taskMap)(a[0], b[0]);
  });

  const assignment: Record<string, number> = {};
  clusters.forEach((cluster, idx) => {
    cluster.forEach((taskId) => {
      assignment[taskId] = idx + 1;
    });
  });
  return assignment;
}

function topologicalOrder(tasks: TaskNode[], hardEdges: HardDependency[], softEdges: SoftCoupling[]): string[] {
  const nodeIds = tasks.map((task) => task.id);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const compare = taskComparator(taskMap);
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, []);
    inDegree.set(nodeId, 0);
  }

  const combined = [
    ...hardEdges.map((edge) => ({ source: edge.source, target: edge.target })),
    ...softEdges.map((edge) => ({ source: edge.sourceTaskId, target: edge.targetTaskId })),
  ];
  for (const edge of combined) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)!.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue = nodeIds.filter((nodeId) => (inDegree.get(nodeId) ?? 0) === 0).sort(compare);
  const order: string[] = [];
  while (queue.length) {
    queue.sort(compare);
    const current = queue.shift()!;
    order.push(current);
    for (const next of adjacency.get(current) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if ((inDegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  return order.length === nodeIds.length ? order : [];
}

function buildPredecessorIndex(
  hardEdges: HardDependency[],
  softEdges: SoftCoupling[]
): Map<string, Array<{ source: string; lagDays: number }>> {
  const predecessors = new Map<string, Array<{ source: string; lagDays: number }>>();
  for (const edge of hardEdges) {
    const list = predecessors.get(edge.target) ?? [];
    list.push({ source: edge.source, lagDays: Math.max(edge.lagMinutes ?? 0, 0) / 1440 });
    predecessors.set(edge.target, list);
  }
  for (const edge of softEdges) {
    const list = predecessors.get(edge.targetTaskId) ?? [];
    list.push({ source: edge.sourceTaskId, lagDays: 0 });
    predecessors.set(edge.targetTaskId, list);
  }
  return predecessors;
}

interface SchedulingResult {
  percentiles: { p50: number; p80: number; p95: number } | null;
  criticality: Map<string, number>;
}

function monteCarloSchedule(
  tasks: TaskNode[],
  topoOrder: string[],
  hardEdges: HardDependency[],
  softEdges: SoftCoupling[],
  seed: number,
  trials = DEFAULT_TRIALS
): SchedulingResult {
  if (topoOrder.length === 0) return { percentiles: null, criticality: new Map() };
  if (tasks.some((task) => task.planning.cynefinDomain === "chaotic")) {
    return { percentiles: null, criticality: new Map(tasks.map((task) => [task.id, 0])) };
  }

  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const predecessors = buildPredecessorIndex(hardEdges, softEdges);
  const criticalCounts = new Map<string, number>();
  const makespans: number[] = [];
  const rng = mulberry32(seed);

  for (let trial = 0; trial < trials; trial += 1) {
    const finishTimes = new Map<string, number>();
    const bestPred = new Map<string, string | null>();
    let broke = false;

    for (const taskId of topoOrder) {
      const task = taskMap.get(taskId);
      if (!task) continue;
      const duration = sampleDuration(task, rng);
      if (!Number.isFinite(duration)) {
        makespans.push(Number.POSITIVE_INFINITY);
        broke = true;
        break;
      }
      let start = 0;
      let chosenPred: string | null = null;
      for (const pred of predecessors.get(taskId) ?? []) {
        const finish = (finishTimes.get(pred.source) ?? 0) + pred.lagDays;
        if (finish >= start) {
          start = finish;
          chosenPred = pred.source;
        }
      }
      finishTimes.set(taskId, start + duration);
      bestPred.set(taskId, chosenPred);
    }
    if (broke) continue;

    let lastNode: string | null = null;
    let makespan = 0;
    for (const taskId of topoOrder) {
      const finish = finishTimes.get(taskId) ?? 0;
      if (finish >= makespan) {
        makespan = finish;
        lastNode = taskId;
      }
    }
    makespans.push(makespan);

    const seen = new Set<string>();
    let current = lastNode;
    while (current) {
      if (seen.has(current)) break;
      seen.add(current);
      criticalCounts.set(current, (criticalCounts.get(current) ?? 0) + 1);
      current = bestPred.get(current) ?? null;
    }
  }

  const finiteMakespans = makespans.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const criticality = new Map<string, number>();
  tasks.forEach((task) => criticality.set(task.id, (criticalCounts.get(task.id) ?? 0) / Math.max(trials, 1)));

  if (finiteMakespans.length === 0) return { percentiles: null, criticality };

  return {
    percentiles: {
      p50: Number(stablePercentile(finiteMakespans, 0.5).toFixed(2)),
      p80: Number(stablePercentile(finiteMakespans, 0.8).toFixed(2)),
      p95: Number(stablePercentile(finiteMakespans, 0.95).toFixed(2)),
    },
    criticality,
  };
}

function rankPriorities(
  tasks: TaskNode[],
  hardEdges: HardDependency[],
  softEdges: SoftCoupling[],
  criticality: Map<string, number>
): PriorityRecommendation[] {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const candidateTasks = tasks.filter((task) => task.planning.cynefinDomain !== "chaotic");
  if (candidateTasks.length === 0) return [];

  const adjacency = adjacencyFor(
    tasks.map((task) => task.id),
    [
      ...hardEdges.map((edge) => ({ source: edge.source, target: edge.target })),
      ...softEdges.map((edge) => ({ source: edge.sourceTaskId, target: edge.targetTaskId })),
    ]
  );

  const raw = candidateTasks.map((task) => {
    const visited = new Set<string>();
    const stack = [...(adjacency.get(task.id) ?? [])];
    let topoBlock = 0;
    let complexInherit = 0;
    while (stack.length) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      topoBlock += 1;
      const nextTask = taskMap.get(current);
      if (nextTask && ["complex", "aporetic", "chaotic"].includes(nextTask.planning.cynefinDomain)) {
        complexInherit += 1;
      }
      stack.push(...(adjacency.get(current) ?? []));
    }
    return {
      taskId: task.id,
      topoBlock,
      complexInherit,
      irreversibility: Number((1 - (task.planning.reversibility ?? 0.5)).toFixed(4)),
      criticality: Number((criticality.get(task.id) ?? 0).toFixed(4)),
    };
  });

  const maxTopo = Math.max(1, ...raw.map((item) => item.topoBlock));
  const maxComplex = Math.max(1, ...raw.map((item) => item.complexInherit));

  return raw
    .map((item) => {
      const score =
        0.3 * (item.topoBlock / maxTopo) +
        0.3 * (item.complexInherit / maxComplex) +
        0.2 * item.irreversibility +
        0.2 * item.criticality;
      const task = taskMap.get(item.taskId);
      let reason: string | null = null;
      if (task?.planning.cynefinDomain === "aporetic") {
        reason = "Aporetic task: frame before committing downstream work";
      } else if ((item.criticality ?? 0) >= 0.5) {
        reason = "High schedule criticality";
      }
      return {
        taskId: item.taskId,
        priority: Number(score.toFixed(4)),
        reason,
        components: {
          topoBlock: item.topoBlock,
          complexInherit: item.complexInherit,
          irreversibility: item.irreversibility,
          criticality: item.criticality,
        },
      };
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.taskId.localeCompare(b.taskId);
    });
}

export function computeInputsHash(tasks: TaskNode[], hardEdges: HardDependency[], softEdges: SoftCoupling[]): string {
  const payload = {
    tasks: [...tasks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({ id: t.id, effort: t.effort, planning: t.planning })),
    hard: [...hardEdges]
      .map((e) => ({ s: e.source, t: e.target, lag: e.lagMinutes ?? 0 }))
      .sort((a, b) => `${a.s}->${a.t}`.localeCompare(`${b.s}->${b.t}`)),
    soft: [...softEdges]
      .map((e) => ({ s: e.sourceTaskId, t: e.targetTaskId, k: e.couplingType, w: e.strength }))
      .sort((a, b) => `${a.s}->${a.t}`.localeCompare(`${b.s}->${b.t}`)),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Pure planner entry point. Deterministic in (tasks, edges, seed).
 */
export function computePlan(input: PlanInput): PlanSnapshot {
  const { tasks, hardEdges } = input;
  const inputsHash = input.seed ?? computeInputsHash(tasks, hardEdges, input.softEdges);
  const nodeIds = tasks.map((task) => task.id).sort((a, b) => a.localeCompare(b));
  const remainingSoft = [...input.softEdges];
  const tornEdges: TornEdge[] = [];

  // Hard precedence cycles cannot be torn — they make the plan unschedulable.
  const hardCycleComponents = tarjan(
    nodeIds,
    hardEdges.map((edge) => ({ source: edge.source, target: edge.target }))
  ).filter((component) => component.length > 1 || hasSelfLoop(component[0], hardEdges));
  const invalidCycles: InvalidCycle[] = hardCycleComponents.map((component) => ({
    taskIds: [...component].sort((a, b) => a.localeCompare(b)),
    via: "precedence" as const,
  }));

  // Tear weakest soft edge until no cycle remains.
  let safety = remainingSoft.length + 1;
  while (safety > 0) {
    safety -= 1;
    const cycleEdges = [
      ...hardEdges.map((edge) => ({ source: edge.source, target: edge.target })),
      ...remainingSoft.map((edge) => ({ source: edge.sourceTaskId, target: edge.targetTaskId })),
    ];
    const cyclic = tarjan(nodeIds, cycleEdges).filter(
      (component) => component.length > 1 || hasSelfLoop(component[0], cycleEdges)
    );
    if (cyclic.length === 0) break;
    let selected: SoftCoupling | null = null;
    for (const component of cyclic) {
      selected = chooseTearEdge(component, remainingSoft);
      if (selected) break;
    }
    if (!selected) break;
    const removeIndex = remainingSoft.findIndex((edge) => edge.id === selected!.id);
    if (removeIndex >= 0) {
      remainingSoft.splice(removeIndex, 1);
      tornEdges.push({
        sourceTaskId: selected.sourceTaskId,
        targetTaskId: selected.targetTaskId,
        couplingType: selected.couplingType,
        reason:
          selected.couplingType === "resource"
            ? "Torn resource coupling to preserve schedulable precedence"
            : "Torn information coupling for assumption-based sequencing",
      });
    }
  }

  const clusterAssignment = clusterTasks(tasks, hardEdges, remainingSoft);
  const topoOrder = invalidCycles.length > 0 ? [] : topologicalOrder(tasks, hardEdges, remainingSoft);
  const scheduling = monteCarloSchedule(
    tasks,
    topoOrder,
    hardEdges,
    remainingSoft,
    hashToSeed(inputsHash),
    input.options?.trials ?? DEFAULT_TRIALS
  );
  const criticality = scheduling.criticality;

  const status: "ready" | "blocked" =
    invalidCycles.length > 0 || tasks.some((task) => task.planning.cynefinDomain === "chaotic") ? "blocked" : "ready";

  const priorityRanking = status === "blocked" ? [] : rankPriorities(tasks, hardEdges, remainingSoft, criticality);
  const criticalCorridor =
    status === "blocked"
      ? []
      : tasks
          .map((task) => ({ taskId: task.id, criticality: Number((criticality.get(task.id) ?? 0).toFixed(4)) }))
          .filter((entry) => entry.criticality >= 0.2)
          .sort((a, b) => b.criticality - a.criticality);

  return {
    inputsHash,
    status,
    sccGroups: tarjan(nodeIds, [
      ...hardEdges.map((edge) => ({ source: edge.source, target: edge.target })),
      ...input.softEdges.map((edge) => ({ source: edge.sourceTaskId, target: edge.targetTaskId })),
    ]),
    clusterAssignment,
    tornEdges,
    invalidCycles,
    topoOrder,
    mcPercentiles: status === "blocked" ? null : scheduling.percentiles,
    criticalCorridor,
    priorityRanking,
  };
}
