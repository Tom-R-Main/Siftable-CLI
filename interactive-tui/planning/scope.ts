/**
 * scope — write-scope primitives shared by the planner and the merge-master
 * claim gate.
 *
 * A "scope" is the set of normalized path/resource tokens an item intends to
 * write. Two pieces of work *conflict* when their scopes share any token (they
 * would edit the same file/resource) and *overlap* by a Jaccard ratio used to
 * weight soft couplings. This is the single definition both the agent-work
 * planner (soft-coupling strength) and Gate A (claim-time serialization)
 * consume, so "do these collide?" means the same thing everywhere.
 */

/** Normalize an iterable of raw path/resource strings into a comparable token set. */
export function scopeTokenSet(tokens: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of tokens) {
    if (typeof raw !== "string") continue;
    const token = raw.trim().toLowerCase();
    if (token) out.add(token);
  }
  return out;
}

/** True when two scopes share at least one token (they would write the same thing). */
export function scopesConflict(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = a instanceof Set ? a : scopeTokenSet(a);
  const right = b instanceof Set ? b : scopeTokenSet(b);
  if (left.size === 0 || right.size === 0) return false;
  // Iterate the smaller set for the membership probe.
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (large.has(token)) return true;
  return false;
}

/** The specific tokens two scopes share, sorted — useful for explaining a block. */
export function sharedScopeTokens(a: Iterable<string>, b: Iterable<string>): string[] {
  const left = a instanceof Set ? a : scopeTokenSet(a);
  const right = b instanceof Set ? b : scopeTokenSet(b);
  const shared: string[] = [];
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (large.has(token)) shared.push(token);
  return shared.sort((x, y) => x.localeCompare(y));
}

/** Jaccard overlap of two scopes in [0,1]; 0 when either is empty. */
export function scopeOverlap(a: Iterable<string>, b: Iterable<string>): number {
  const left = a instanceof Set ? a : scopeTokenSet(a);
  const right = b instanceof Set ? b : scopeTokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (large.has(token)) inter += 1;
  const union = left.size + right.size - inter;
  return union === 0 ? 0 : inter / union;
}
