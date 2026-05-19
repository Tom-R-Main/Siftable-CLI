import {ParsedEntityRef} from './entity-ref.js';

export interface GraphNodeLike {
  id?: string;
  type?: string;
  entityId?: string;
  entityType?: string;
  label?: string;
}

export interface GraphEdgeLike {
  id?: string;
  source?: string;
  target?: string;
  type?: string;
  context?: string;
  contextField?: string;
}

export interface GraphStep {
  from: string;
  to: string;
  edgeId?: string;
  type?: string;
  context?: string;
  contextField?: string;
}

function nodeId(node: GraphNodeLike): string {
  return String(node.id ?? node.entityId ?? '');
}

export function entityRefId(ref: ParsedEntityRef): string {
  return ref.entityId;
}

export function findGraphPath(
  graph: {nodes?: GraphNodeLike[]; edges?: GraphEdgeLike[]},
  source: ParsedEntityRef,
  target: ParsedEntityRef,
): {found: boolean; path: GraphStep[]; targetNode?: GraphNodeLike} {
  const sourceId = entityRefId(source);
  const targetId = entityRefId(target);
  const nodes = graph.nodes ?? [];
  const nodeById = new Map(nodes.map((node) => [nodeId(node), node]));
  const adjacency = new Map<string, GraphStep[]>();

  for (const edge of graph.edges ?? []) {
    const from = String(edge.source ?? '');
    const to = String(edge.target ?? '');
    if (!from || !to) continue;
    const forward: GraphStep = {
      from,
      to,
      edgeId: edge.id,
      type: edge.type,
      context: edge.context,
      contextField: edge.contextField,
    };
    const backward: GraphStep = {
      from: to,
      to: from,
      edgeId: edge.id,
      type: edge.type,
      context: edge.context,
      contextField: edge.contextField,
    };
    adjacency.set(from, [...(adjacency.get(from) ?? []), forward]);
    adjacency.set(to, [...(adjacency.get(to) ?? []), backward]);
  }

  const queue: Array<{id: string; path: GraphStep[]}> = [{id: sourceId, path: []}];
  const seen = new Set<string>([sourceId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === targetId) {
      return {found: true, path: current.path, targetNode: nodeById.get(targetId)};
    }
    for (const step of adjacency.get(current.id) ?? []) {
      if (seen.has(step.to)) continue;
      seen.add(step.to);
      queue.push({id: step.to, path: [...current.path, step]});
    }
  }

  return {found: sourceId === targetId, path: [], targetNode: nodeById.get(targetId)};
}
