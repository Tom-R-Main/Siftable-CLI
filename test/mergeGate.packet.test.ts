/**
 * Lane D D2 — pure packet assembly + scope containment. No git, no kernel: feed
 * assembleMergePacket the gathered facts and assert the verdict + blockers for
 * each failure mode. This is where the "scope is a hard contract; --rw-any is
 * exempt" decision and the "every failing condition becomes its own blocker"
 * rule are pinned down.
 */
import {assembleMergePacket, type MergeGateChild, type MergeGateInputs} from "../interactive-tui/mergeGate";
import {filesOutsideScope, pathMatchesScope} from "../interactive-tui/planning/scope";
import type {DiffFile} from "../interactive-tui/worktreeService";

function child(over: Partial<MergeGateChild> = {}): MergeGateChild {
  return {
    sessionId: 2,
    parentSessionId: 1,
    repoRoot: "/repo",
    branch: "sift/work-abc123",
    baseBranch: "main",
    baseCommit: "base000",
    worktreePath: "/wt/work",
    accessMode: "read_write",
    writeScope: ["src/a.ts"],
    ...over,
  };
}

function diff(path: string, additions = 1, deletions = 0): DiffFile {
  return {path, additions, deletions, binary: false};
}

function inputs(over: Partial<MergeGateInputs> = {}): MergeGateInputs {
  return {
    child: child(),
    baseTip: "tip111",
    headCommit: "head222",
    behindBy: 0,
    changedFiles: [diff("src/a.ts", 3, 1)],
    conflicts: [],
    dirty: false,
    ...over,
  };
}

describe("pathMatchesScope / filesOutsideScope", () => {
  it("matches exact paths, directory prefixes, and globs", () => {
    expect(pathMatchesScope("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathMatchesScope("src/a.ts", "src")).toBe(true); // dir prefix
    expect(pathMatchesScope("src/deep/b.ts", "src")).toBe(true);
    expect(pathMatchesScope("src/a.ts", "src/*.ts")).toBe(true);
    expect(pathMatchesScope("src/deep/b.ts", "src/*.ts")).toBe(false); // * is one segment
    expect(pathMatchesScope("src/deep/b.ts", "src/**")).toBe(true);
    expect(pathMatchesScope("lib/a.ts", "src")).toBe(false);
  });

  it("is case- and ./-insensitive, like the claim-time scope tokens", () => {
    expect(pathMatchesScope("./SRC/A.ts", "src/a.ts")).toBe(true);
  });

  it("treats an empty scope as 'nothing is out of scope'", () => {
    expect(filesOutsideScope(["anything.ts", "x/y.ts"], [])).toEqual([]);
  });

  it("returns the out-of-scope paths, sorted", () => {
    expect(filesOutsideScope(["src/a.ts", "zzz.ts", "lib/x.ts"], ["src"])).toEqual(["lib/x.ts", "zzz.ts"]);
  });
});

describe("assembleMergePacket — verdicts", () => {
  it("ready_to_merge when committed, conflict-free, and in scope", () => {
    const p = assembleMergePacket(inputs());
    expect(p.verdict).toBe("ready_to_merge");
    expect(p.blockers).toEqual([]);
    expect(p.outOfScope).toEqual([]);
    expect(p.totalAdditions).toBe(3);
    expect(p.totalDeletions).toBe(1);
  });

  it("merge_blocked with a conflict blocker naming the files", () => {
    const p = assembleMergePacket(inputs({conflicts: ["src/a.ts"]}));
    expect(p.verdict).toBe("merge_blocked");
    expect(p.conflicts).toEqual(["src/a.ts"]);
    expect(p.blockers.some((b) => b.includes("conflicts with main") && b.includes("src/a.ts"))).toBe(true);
  });

  it("merge_blocked when the diff strays outside the declared scope", () => {
    const p = assembleMergePacket(
      inputs({changedFiles: [diff("src/a.ts"), diff("src/secret.ts")], child: child({writeScope: ["src/a.ts"]})}),
    );
    expect(p.verdict).toBe("merge_blocked");
    expect(p.outOfScope).toEqual(["src/secret.ts"]);
    expect(p.blockers.some((b) => b.includes("outside declared scope"))).toBe(true);
  });

  it("unscoped (--rw-any) child skips the scope check", () => {
    const p = assembleMergePacket(
      inputs({changedFiles: [diff("anywhere.ts")], child: child({writeScope: []})}),
    );
    expect(p.outOfScope).toEqual([]);
    expect(p.verdict).toBe("ready_to_merge");
  });

  it("merge_blocked when the child worktree is dirty", () => {
    const p = assembleMergePacket(inputs({dirty: true}));
    expect(p.verdict).toBe("merge_blocked");
    expect(p.blockers.some((b) => b.includes("uncommitted changes"))).toBe(true);
  });

  it("stacks one blocker per failed condition (dirty + conflict + out-of-scope)", () => {
    const p = assembleMergePacket(
      inputs({
        dirty: true,
        conflicts: ["src/a.ts"],
        changedFiles: [diff("src/a.ts"), diff("out.ts")],
        child: child({writeScope: ["src/a.ts"]}),
      }),
    );
    expect(p.verdict).toBe("merge_blocked");
    expect(p.blockers).toHaveLength(3);
  });

  it("records base drift (behindBy) for the merge view", () => {
    const p = assembleMergePacket(inputs({behindBy: 4}));
    expect(p.behindBy).toBe(4);
    expect(p.verdict).toBe("ready_to_merge"); // drift alone does not block; conflicts do
  });
});
