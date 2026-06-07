/**
 * Lane D D4 — the /ready command. Pure over ctx.sessions.review (the TUI backs
 * it with the real controller; here a spy). Checks: resolves the active child
 * when no id is given, errors clearly when there is none, renders the packet
 * verdict + blockers, passes --commit through as autoCommit, and points a
 * dirty-blocked child at the one-step fix.
 */
import {interactiveCommands, type InteractiveCommandContext} from "../../interactive-tui/commands";
import {buildCommandContext} from "../helpers/interactive-command-context";
import type {MergePacket} from "../../interactive-tui/mergeGate";

function run(ctx: InteractiveCommandContext, name: string, args: string[] = []): void {
  const cmd = interactiveCommands.find((c) => c.name === name || c.aliases?.includes(name));
  if (!cmd) throw new Error(`command not found: ${name}`);
  void cmd.run(ctx, args);
}

function packet(over: Partial<MergePacket> = {}): MergePacket {
  return {
    childSessionId: 2,
    parentSessionId: 1,
    baseBranch: "main",
    childBranch: "sift/feature-abc123",
    baseCommit: "base0",
    baseTip: "tip0",
    behindBy: 0,
    headCommit: "head0",
    files: [{path: "src/a.ts", additions: 3, deletions: 1, binary: false}],
    totalAdditions: 3,
    totalDeletions: 1,
    conflicts: [],
    outOfScope: [],
    dirty: false,
    verdict: "ready_to_merge",
    blockers: [],
    ...over,
  };
}

function lastText(messages: {text: string}[]): string {
  return messages[messages.length - 1]?.text ?? "";
}

describe("/ready", () => {
  it("reviews the active child when no id is given, rendering the ready verdict", () => {
    const review = jest.fn(() => ({ok: true as const, packet: packet(), statusApplied: true, committed: false}));
    const {ctx, messages} = buildCommandContext({
      sessions: {
        list: jest.fn(() => []),
        activeChildId: jest.fn(() => 2),
        spawn: jest.fn(),
        enter: jest.fn(),
        leave: jest.fn(),
        review,
      },
    });
    run(ctx, "ready", []);
    expect(review).toHaveBeenCalledWith(2, {autoCommit: false});
    expect(lastText(messages)).toContain("ready to merge");
    expect(lastText(messages)).toContain("+3 −1");
  });

  it("errors when there is no active child and no id", () => {
    const review = jest.fn();
    const {ctx, messages} = buildCommandContext({
      sessions: {
        list: jest.fn(() => []),
        activeChildId: jest.fn(() => null),
        spawn: jest.fn(),
        enter: jest.fn(),
        leave: jest.fn(),
        review,
      },
    });
    run(ctx, "ready", []);
    expect(review).not.toHaveBeenCalled();
    expect(lastText(messages)).toContain("no active child");
  });

  it("targets the named child id and renders blockers", () => {
    const review = jest.fn(() => ({
      ok: true as const,
      statusApplied: true,
      committed: false,
      packet: packet({verdict: "merge_blocked", conflicts: ["src/a.ts"], blockers: ["conflicts with main in: src/a.ts"]}),
    }));
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review},
    });
    run(ctx, "ready", ["7"]);
    expect(review).toHaveBeenCalledWith(7, {autoCommit: false});
    expect(lastText(messages)).toContain("merge blocked");
    expect(lastText(messages)).toContain("conflicts with main");
  });

  it("passes --commit through as autoCommit and notes the commit", () => {
    const review = jest.fn(() => ({ok: true as const, statusApplied: true, committed: true, packet: packet()}));
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => 2), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review},
    });
    run(ctx, "ready", ["--commit"]);
    expect(review).toHaveBeenCalledWith(2, {autoCommit: true});
    expect(lastText(messages)).toContain("committed working changes first");
  });

  it("points a dirty-blocked child at the one-step --commit fix", () => {
    const review = jest.fn(() => ({
      ok: true as const,
      statusApplied: true,
      committed: false,
      packet: packet({verdict: "merge_blocked", dirty: true, blockers: ["child worktree has uncommitted changes"]}),
    }));
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => 2), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review},
    });
    run(ctx, "ready", []);
    expect(lastText(messages)).toContain("/ready 2 --commit");
  });

  it("surfaces a hard failure (unknown/terminal child)", () => {
    const review = jest.fn(() => ({ok: false as const, reason: "child #9 is merged (terminal) — nothing to review"}));
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review},
    });
    run(ctx, "ready", ["9"]);
    expect(lastText(messages)).toContain("terminal");
  });
});
