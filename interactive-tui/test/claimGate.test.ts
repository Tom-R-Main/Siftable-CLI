/**
 * Tests for Gate A — claim-time write-scope serialization — and the shared
 * scope predicate it rides on.
 *
 * Forces the pure-TS registry fallback (SIFT_NO_NATIVE) so the gate is exercised
 * deterministically without the Zig dylib.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
process.env.SIFT_NO_NATIVE = "1";

import { describe, it, expect, beforeEach } from "bun:test";
import { scopeTokenSet, scopesConflict, scopeOverlap, sharedScopeTokens } from "../planning/scope";
import {
  createParentSession,
  createGatedChildSession,
  evaluateChildAdmission,
  transitionSessionStatus,
  listMergeMasterSessions,
  resetMergeMasterForTests,
  type CreateChildInput,
} from "../mergeMaster";

describe("scope predicate", () => {
  it("normalizes case and whitespace into a token set", () => {
    const set = scopeTokenSet([" Web/App.tsx ", "web/app.tsx", ""]);
    expect([...set]).toEqual(["web/app.tsx"]);
  });

  it("detects conflict on any shared token, ignores empties", () => {
    expect(scopesConflict(["a.ts", "b.ts"], ["b.ts"])).toBe(true);
    expect(scopesConflict(["a.ts"], ["b.ts"])).toBe(false);
    expect(scopesConflict([], ["a.ts"])).toBe(false);
  });

  it("computes Jaccard overlap and shared tokens", () => {
    expect(scopeOverlap(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
    expect(sharedScopeTokens(["b", "a"], ["c", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("Gate A admission", () => {
  let parentId: number;

  const child = (over: Partial<CreateChildInput>): CreateChildInput => ({
    parentSessionId: parentId,
    accessMode: "read_write",
    branch: "sift/child",
    worktreePath: "/repo/wt/child",
    sessionCwd: "/repo/wt/child",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    ...over,
  });

  beforeEach(() => {
    resetMergeMasterForTests();
    parentId = createParentSession({
      repoRoot: "/repo",
      launchDir: "/repo",
      sessionCwd: "/repo",
      branch: "main",
    });
  });

  it("admits the first write-capable child", () => {
    const res = createGatedChildSession(child({ branch: "sift/a", worktreePath: "/repo/wt/a", writeScope: ["src/a.ts"] }));
    expect(res.admitted).toBe(true);
  });

  it("blocks a second child that shares scope, and creates nothing", () => {
    createGatedChildSession(child({ branch: "sift/a", worktreePath: "/repo/wt/a", writeScope: ["src/a.ts"] }));
    const before = listMergeMasterSessions().length;
    const res = createGatedChildSession(child({ branch: "sift/b", worktreePath: "/repo/wt/b", writeScope: ["src/a.ts"] }));
    expect(res.admitted).toBe(false);
    expect(listMergeMasterSessions().length).toBe(before); // no session spawned
    if (!res.admitted) {
      expect(res.admission.sharedScope).toEqual(["src/a.ts"]);
      expect(res.admission.reason).toContain("shared scope");
    }
  });

  it("admits a child with a disjoint scope (parallel-safe)", () => {
    createGatedChildSession(child({ branch: "sift/a", worktreePath: "/repo/wt/a", writeScope: ["src/a.ts"] }));
    const res = createGatedChildSession(child({ branch: "sift/b", worktreePath: "/repo/wt/b", writeScope: ["src/b.ts"] }));
    expect(res.admitted).toBe(true);
  });

  it("never blocks a read_only child even on shared scope", () => {
    createGatedChildSession(child({ branch: "sift/a", worktreePath: "/repo/wt/a", writeScope: ["src/a.ts"] }));
    const verdict = evaluateChildAdmission({ accessMode: "read_only", writeScope: ["src/a.ts"] });
    expect(verdict.admit).toBe(true);
  });

  it("frees scope when the holding child reaches a terminal status", () => {
    const first = createGatedChildSession(
      child({ branch: "sift/a", worktreePath: "/repo/wt/a", writeScope: ["src/a.ts"] })
    );
    expect(first.admitted).toBe(true);
    // While running, an overlapping candidate is blocked…
    expect(evaluateChildAdmission({ accessMode: "read_write", writeScope: ["src/a.ts"] }).admit).toBe(false);
    // …then the holder is abandoned (running → abandoned is terminal)…
    if (first.admitted) transitionSessionStatus(first.sessionId, "abandoned");
    // …and the scope is released.
    expect(evaluateChildAdmission({ accessMode: "read_write", writeScope: ["src/a.ts"] }).admit).toBe(true);
  });
});
