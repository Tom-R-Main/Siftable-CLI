/**
 * Correlates tool_result events with the transcript row created by their
 * tool_call, so parallel same-name calls settle the RIGHT rows even when
 * results arrive out of order.
 *
 * Matching:
 *   - A result WITH a callId settles only its exact row. An unknown or
 *     already-settled id fails closed (null): an orphan, duplicate, or
 *     provider-mismatched result must never steal another active call's row.
 *   - A result WITHOUT a callId settles the oldest unsettled row with the
 *     same tool name (FIFO). There is no correct pairing for out-of-order
 *     completions without an id, but FIFO guarantees every row settles
 *     exactly once — the old last-row match left earlier rows spinning.
 *   - With neither an id nor a registered name, fall back to the most recent
 *     tool row (legacy behavior).
 */
export class ToolRowTracker {
  private byCallId = new Map<string, { name: string; rowIdx: number }>();
  private byName = new Map<string, number[]>();
  private lastIdx: number | null = null;

  /** Record the transcript row index a tool_call just occupied. */
  register(name: string, callId: string | undefined, rowIdx: number): void {
    this.lastIdx = rowIdx;
    if (callId) this.byCallId.set(callId, { name, rowIdx });
    const rows = this.byName.get(name) ?? [];
    rows.push(rowIdx);
    this.byName.set(name, rows);
  }

  /** Row index the matching tool_result should settle, or null when unknown. */
  settle(name: string, callId: string | undefined): number | null {
    if (callId) {
      const registered = this.byCallId.get(callId);
      if (registered === undefined) return null; // fail closed — see module doc
      // The call id is authoritative. Remove the row from the name queue it
      // was registered under, even if a malformed result supplies another
      // tool name, so the row can never settle twice.
      this.consumeRow(registered.rowIdx);
      return registered.rowIdx;
    }
    const rows = this.byName.get(name);
    if (rows?.length) {
      const idx = rows[0];
      this.consumeRow(idx);
      return idx;
    }
    if (this.lastIdx === null) return null;
    const idx = this.lastIdx;
    this.consumeRow(idx);
    return idx;
  }

  /**
   * Close every row that never received a live result event. Turn teardown
   * uses this to stop cancelled or interrupted calls from rendering as active
   * forever; it does not fabricate tool execution receipts.
   */
  drain(): number[] {
    const rows = new Set<number>();
    for (const queued of this.byName.values()) {
      for (const rowIdx of queued) rows.add(rowIdx);
    }
    this.byCallId.clear();
    this.byName.clear();
    this.lastIdx = null;
    return [...rows].sort((a, b) => a - b);
  }

  private consumeRow(rowIdx: number): void {
    for (const [name, rows] of this.byName) {
      const at = rows.indexOf(rowIdx);
      if (at >= 0) rows.splice(at, 1);
      if (rows.length === 0) this.byName.delete(name);
    }
    for (const [id, mapped] of this.byCallId) {
      if (mapped.rowIdx === rowIdx) this.byCallId.delete(id);
    }
    if (this.lastIdx === rowIdx) {
      this.lastIdx = null;
      for (const rows of this.byName.values()) {
        for (const openRowIdx of rows) {
          if (this.lastIdx === null || openRowIdx > this.lastIdx) this.lastIdx = openRowIdx;
        }
      }
    }
  }
}
