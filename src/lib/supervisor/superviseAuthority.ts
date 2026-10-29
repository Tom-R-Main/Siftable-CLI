/**
 * How long the supervisor may keep an attempt running (first-run U2d-2).
 *
 * The cap is the earliest authority the server has confirmed: the claim
 * expiry returned by consume and by each dispatch heartbeat, and the compute
 * grant's expiry. A failed, hung or unknown heartbeat never moves it. Server
 * times are wall-clock; the cap is held on the monotonic clock, converted when
 * a confirmation arrives, so a wall-clock change cannot extend local execution.
 */

/** Stop this long before the confirmed expiry, so teardown finishes inside it. */
export const TEARDOWN_MARGIN_MS = 15_000;
/** The host clock may differ from the database clock by up to this much (NTP-synced hosts). */
export const CLOCK_ALLOWANCE_MS = 30_000;
/** The server renews at most 300 s from its own clock, which is never earlier than the request. */
export const MAX_RENEWAL_MS = 300_000;
/** `deadlineAt` on a dispatch heartbeat; the server refuses more than 30 s. */
export const HEARTBEAT_BUDGET_MS = 25_000;
const MIN_RENEWAL_DELAY_MS = 5_000;
const MAX_RENEWAL_DELAY_MS = 60_000;

export interface SupervisorClock {
  /** Wall-clock milliseconds, comparable with server timestamps. */
  wallMs(): number;
  /** Monotonic milliseconds; never goes backwards. */
  monoMs(): number;
}

export const systemClock: SupervisorClock = {
  wallMs: () => Date.now(),
  monoMs: () => performance.now(),
};

/**
 * The monotonic time by which the attempt must be stopped, from one confirmed
 * expiry. `sentMono` is when the request that returned it was sent: the
 * server's 300 s cannot run from earlier than that.
 */
export function confirmedCap(clock: SupervisorClock, expiresAt: string, sentMono: number): number {
  const expiresWall = Date.parse(expiresAt);
  if (!Number.isFinite(expiresWall)) return Number.NEGATIVE_INFINITY;
  const nowMono = clock.monoMs();
  const fromWall = nowMono + (expiresWall - CLOCK_ALLOWANCE_MS - clock.wallMs());
  return Math.min(fromWall, sentMono + MAX_RENEWAL_MS) - TEARDOWN_MARGIN_MS;
}

/**
 * The starting caps from consume. `grantCap` is the compute grant's bound
 * (+Infinity without a grant), which no renewal lifts; `cap` also includes
 * the claim's. A claim with no stated expiry confers no running time.
 */
export function initialCaps(
  clock: SupervisorClock, claim: {claimExpiresAt?: unknown; computeGrantExpiresAt?: unknown}, sentMono: number,
): {cap: number; grantCap: number} {
  const grantCap = typeof claim.computeGrantExpiresAt === 'string'
    ? confirmedCap(clock, claim.computeGrantExpiresAt, sentMono) : Number.POSITIVE_INFINITY;
  return {cap: renewedCap(clock, claim.claimExpiresAt, sentMono, grantCap), grantCap};
}

/**
 * A renewal replaces the claim bound but never lifts the grant bound. The
 * caller passes the grant cap it took at consume (or +Infinity without one).
 */
export function renewedCap(clock: SupervisorClock, claimExpiresAt: unknown, sentMono: number, grantCap: number): number {
  if (typeof claimExpiresAt !== 'string') return Number.NEGATIVE_INFINITY;
  return Math.min(confirmedCap(clock, claimExpiresAt, sentMono), grantCap);
}

/** When to renew next: halfway to the cap, between 5 s and 60 s, and never past the cap. */
export function nextRenewalDelay(capMono: number, nowMono: number): number {
  const remaining = capMono - nowMono;
  if (remaining <= 0) return 0;
  return Math.min(remaining, Math.max(MIN_RENEWAL_DELAY_MS, Math.min(MAX_RENEWAL_DELAY_MS, remaining / 2)));
}

/** The heartbeat's `deadlineAt`: a short, server-checked wall-clock budget. */
export function heartbeatDeadlineAt(clock: SupervisorClock): string {
  return new Date(clock.wallMs() + HEARTBEAT_BUDGET_MS).toISOString();
}
