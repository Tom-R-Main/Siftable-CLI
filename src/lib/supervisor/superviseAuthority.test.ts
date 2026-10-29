import {describe, expect, it} from 'vitest';
import {
  CLOCK_ALLOWANCE_MS,
  confirmedCap,
  heartbeatDeadlineAt,
  initialCaps,
  MAX_RENEWAL_MS,
  nextRenewalDelay,
  renewedCap,
  type SupervisorClock,
  TEARDOWN_MARGIN_MS,
} from './superviseAuthority.js';

const WALL = Date.parse('2026-10-29T06:00:00.000Z');
/** Wall and monotonic clocks that move together unless a test moves one alone. */
function clock(start = {wall: WALL, mono: 1_000}) {
  const state = {...start};
  const c: SupervisorClock & {advance(ms: number): void; jumpWall(ms: number): void} = {
    wallMs: () => state.wall, monoMs: () => state.mono,
    advance: (ms) => { state.wall += ms; state.mono += ms; },
    jumpWall: (ms) => { state.wall += ms; },
  };
  return c;
}
const at = (offsetMs: number) => new Date(WALL + offsetMs).toISOString();

describe('confirmedCap', () => {
  it('stops before the confirmed expiry by the margin and the clock allowance', () => {
    const c = clock();
    expect(confirmedCap(c, at(120_000), c.monoMs())).toBe(1_000 + 120_000 - CLOCK_ALLOWANCE_MS - TEARDOWN_MARGIN_MS);
  });

  it('never runs past 300 s from when the request was sent, whatever the server clock says', () => {
    const c = clock();
    expect(confirmedCap(c, at(3_600_000), c.monoMs())).toBe(1_000 + MAX_RENEWAL_MS - TEARDOWN_MARGIN_MS);
  });

  it('is unusable for a malformed expiry', () => {
    expect(confirmedCap(clock(), 'soon', 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('is not extended by a wall-clock jump after it was taken', () => {
    const c = clock();
    const cap = confirmedCap(c, at(120_000), c.monoMs());
    c.jumpWall(-3_600_000);
    expect(nextRenewalDelay(cap, c.monoMs())).toBeLessThanOrEqual(cap - c.monoMs());
    expect(cap).toBe(confirmedCap(clock(), at(120_000), 1_000));
  });
});

describe('initialCaps and renewedCap', () => {
  it('takes the earlier of the claim and the compute grant, and a renewal never lifts the grant bound', () => {
    const c = clock();
    const {cap, grantCap} = initialCaps(c, {claimExpiresAt: at(300_000), computeGrantExpiresAt: at(90_000)}, c.monoMs());
    expect(cap).toBe(grantCap);
    c.advance(10_000);
    expect(renewedCap(c, at(310_000), c.monoMs(), grantCap)).toBe(grantCap);
  });

  it('confers no running time without a claim expiry, and none from a renewal without one', () => {
    const c = clock();
    expect(initialCaps(c, {computeGrantExpiresAt: at(90_000)}, c.monoMs()).cap).toBe(Number.NEGATIVE_INFINITY);
    expect(renewedCap(c, undefined, c.monoMs(), Number.POSITIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('follows a renewal that grants less than 60 s', () => {
    const c = clock();
    const cap = renewedCap(c, at(50_000), c.monoMs(), Number.POSITIVE_INFINITY);
    expect(cap - c.monoMs()).toBe(50_000 - CLOCK_ALLOWANCE_MS - TEARDOWN_MARGIN_MS);
    expect(nextRenewalDelay(cap, c.monoMs())).toBe(5_000);
  });
});

describe('nextRenewalDelay', () => {
  it('renews halfway to the cap, between 5 s and 60 s, and never after it', () => {
    expect(nextRenewalDelay(1_000 + 250_000, 1_000)).toBe(60_000);
    expect(nextRenewalDelay(1_000 + 40_000, 1_000)).toBe(20_000);
    expect(nextRenewalDelay(1_000 + 3_000, 1_000)).toBe(3_000);
    expect(nextRenewalDelay(1_000, 2_000)).toBe(0);
  });
});

describe('heartbeatDeadlineAt', () => {
  it('stays inside the server\'s 30 s budget', () => {
    expect(Date.parse(heartbeatDeadlineAt(clock())) - WALL).toBeLessThanOrEqual(30_000);
  });
});
