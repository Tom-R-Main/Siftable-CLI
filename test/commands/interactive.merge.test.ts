/**
 * Lane E E4 — the /merge command + its arg parser. Pure over ctx.sessions.merge
 * / ctx.sessions.mergeView (the TUI backs them with the real controller; here
 * spies). Checks: no-id renders the dashboard, a land renders the success line,
 * a blocked land surfaces the packet + reason, --keep and -m pass through, and a
 * bad id is rejected. parseMergeArgs is unit-tested for the tricky cases.
 */
import {interactiveCommands, parseMergeArgs, type InteractiveCommandContext} from "../../interactive-tui/commands";
import {buildCommandContext} from "../helpers/interactive-command-context";
import type {MergePacket} from "../../interactive-tui/mergeGate";
import type {ParentMergeView} from "../../interactive-tui/mergeView";

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

function view(over: Partial<ParentMergeView> = {}): ParentMergeView {
  return {
    rows: [
      {sessionId: 2, branch: "sift/a", baseBranch: "main", status: "running", verdict: "ready_to_merge", files: 1, additions: 3, deletions: 1, behindBy: 0, blockers: []},
      {sessionId: 3, branch: "sift/b", baseBranch: "main", status: "merge_blocked", verdict: "merge_blocked", files: 1, additions: 0, deletions: 0, behindBy: 2, blockers: ["conflicts with main in: x.ts"]},
    ],
    readyCount: 1,
    blockedCount: 1,
    totalAdditions: 3,
    totalDeletions: 1,
    ...over,
  };
}

function lastText(messages: {text: string}[]): string {
  return messages[messages.length - 1]?.text ?? "";
}

describe("parseMergeArgs", () => {
  it("parses an id", () => expect(parseMergeArgs(["2"])).toEqual({id: 2, keep: false, message: undefined}));
  it("parses id + -m message", () => expect(parseMergeArgs(["2", "-m", "land it"])).toEqual({id: 2, keep: false, message: "land it"}));
  it("parses --keep before the id", () => expect(parseMergeArgs(["--keep", "2"])).toEqual({id: 2, keep: true, message: undefined}));
  it("treats a quoted phrase (already one token) as the message", () =>
    expect(parseMergeArgs(["2", "-m", "two words"])).toEqual({id: 2, keep: false, message: "two words"}));
  it("no id → dashboard mode, no error", () => expect(parseMergeArgs([])).toEqual({id: undefined, keep: false, message: undefined}));
  it("rejects a bad id", () => expect(parseMergeArgs(["x"]).error).toMatch(/not a session id/));
});

describe("/merge", () => {
  it("renders the dashboard when given no id", () => {
    const mergeView = jest.fn(() => view());
    const merge = jest.fn();
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review: jest.fn(), mergeView, merge, rebase: jest.fn(), sendBack: jest.fn(), reject: jest.fn()},
    });
    run(ctx, "merge", []);
    expect(mergeView).toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(lastText(messages)).toContain("Branches (");
    expect(lastText(messages)).toContain("1 ready · 1 blocked");
  });

  it("lands a child and reports the new base + cleanup", () => {
    const merge = jest.fn(() => ({ok: true as const, merged: true, packet: packet(), baseCommit: "abcdef1234567", cleaned: true}));
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review: jest.fn(), mergeView: jest.fn(), merge, rebase: jest.fn(), sendBack: jest.fn(), reject: jest.fn()},
    });
    run(ctx, "merge", ["2"]);
    expect(merge).toHaveBeenCalledWith(2, {keep: false, message: undefined});
    expect(lastText(messages)).toContain("merged #2 → main (abcdef1)");
    expect(lastText(messages)).toContain("worktree + branch removed");
  });

  it("surfaces blockers and the packet when the land is refused", () => {
    const merge = jest.fn(() => ({
      ok: false as const,
      reason: "merge blocked: conflicts with main in: x.ts",
      packet: packet({verdict: "merge_blocked", conflicts: ["x.ts"], blockers: ["conflicts with main in: x.ts"]}),
    }));
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review: jest.fn(), mergeView: jest.fn(), merge, rebase: jest.fn(), sendBack: jest.fn(), reject: jest.fn()},
    });
    run(ctx, "merge", ["2"]);
    expect(lastText(messages)).toContain("merge blocked");
    expect(lastText(messages)).toContain("conflicts with main");
  });

  it("passes --keep and -m through", () => {
    const merge = jest.fn(() => ({ok: true as const, merged: true, packet: packet(), baseCommit: "0000000aaaa", cleaned: false}));
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review: jest.fn(), mergeView: jest.fn(), merge, rebase: jest.fn(), sendBack: jest.fn(), reject: jest.fn()},
    });
    run(ctx, "merge", ["2", "--keep", "-m", "ship it"]);
    expect(merge).toHaveBeenCalledWith(2, {keep: true, message: "ship it"});
    expect(lastText(messages)).toContain("worktree + branch kept");
  });

  it("rejects a bad id without calling merge", () => {
    const merge = jest.fn();
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review: jest.fn(), mergeView: jest.fn(), merge, rebase: jest.fn(), sendBack: jest.fn(), reject: jest.fn()},
    });
    run(ctx, "merge", ["nope"]);
    expect(merge).not.toHaveBeenCalled();
    expect(lastText(messages)).toContain("not a session id");
  });
});
