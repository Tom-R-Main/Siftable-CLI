/**
 * Lane F — the /rebase · /sendback · /reject command handlers. Pure over
 * ctx.sessions (the TUI backs them with the real controller; here spies). Checks
 * id resolution (explicit + active-child), the send-back instruction-required
 * path, free-text reason capture, and that controller refusals surface verbatim.
 */
import {interactiveCommands, type InteractiveCommandContext} from "../../interactive-tui/commands";
import {buildCommandContext} from "../helpers/interactive-command-context";

function run(ctx: InteractiveCommandContext, name: string, args: string[] = []): void {
  const cmd = interactiveCommands.find((c) => c.name === name || c.aliases?.includes(name));
  if (!cmd) throw new Error(`command not found: ${name}`);
  void cmd.run(ctx, args);
}

function lastText(messages: {text: string}[]): string {
  return messages[messages.length - 1]?.text ?? "";
}

describe("/rebase", () => {
  it("rebases the given child and reports the new verdict", () => {
    const rebase = jest.fn(() => ({ok: true as const, rebased: true, headCommit: "abcdef1234567", verdict: "ready_to_merge" as const, statusApplied: true}));
    const {ctx, messages} = buildCommandContext({sessions: {...stubSessions(), rebase}});
    run(ctx, "rebase", ["2"]);
    expect(rebase).toHaveBeenCalledWith(2);
    expect(lastText(messages)).toContain("rebased #2");
    expect(lastText(messages)).toContain("ready to merge");
  });

  it("surfaces conflicts and points at /sendback when the rebase is refused", () => {
    const rebase = jest.fn(() => ({ok: false as const, reason: "rebase onto main conflicts", conflicts: ["shared.txt"]}));
    const {ctx, messages} = buildCommandContext({sessions: {...stubSessions(), rebase}});
    run(ctx, "rebase", ["2"]);
    expect(lastText(messages)).toContain("shared.txt");
    expect(lastText(messages)).toContain("/sendback 2");
  });

  it("falls back to the active child when no id is given", () => {
    const rebase = jest.fn(() => ({ok: true as const, rebased: false, headCommit: "0000000aaaa", verdict: "ready_to_merge" as const, statusApplied: true}));
    const {ctx} = buildCommandContext({sessions: {...stubSessions(), activeChildId: jest.fn(() => 7), rebase}});
    run(ctx, "rebase", []);
    expect(rebase).toHaveBeenCalledWith(7);
  });
});

describe("/sendback", () => {
  it("requires instructions", () => {
    const sendBack = jest.fn();
    const {ctx, messages} = buildCommandContext({sessions: {...stubSessions(), sendBack}});
    run(ctx, "sendback", ["2"]);
    expect(sendBack).not.toHaveBeenCalled();
    expect(lastText(messages)).toMatch(/needs instructions/);
  });

  it("posts the instruction (id + free text) to the child", () => {
    const sendBack = jest.fn(() => ({ok: true as const, posted: true, conversationKey: "k"}));
    const {ctx, messages} = buildCommandContext({sessions: {...stubSessions(), sendBack}});
    run(ctx, "sendback", ["2", "rebase", "onto", "main", "and", "re-resolve"]);
    expect(sendBack).toHaveBeenCalledWith(2, "rebase onto main and re-resolve");
    expect(lastText(messages)).toContain("sent #2 back to work");
  });

  it("treats the whole arg string as the instruction for the active child", () => {
    const sendBack = jest.fn(() => ({ok: true as const, posted: true, conversationKey: "k"}));
    const {ctx} = buildCommandContext({sessions: {...stubSessions(), activeChildId: jest.fn(() => 5), sendBack}});
    run(ctx, "sendback", ["fix", "the", "test"]);
    expect(sendBack).toHaveBeenCalledWith(5, "fix the test");
  });

  it("surfaces a controller refusal", () => {
    const sendBack = jest.fn(() => ({ok: false as const, reason: "already running"}));
    const {ctx, messages} = buildCommandContext({sessions: {...stubSessions(), sendBack}});
    run(ctx, "sendback", ["2", "do it"]);
    expect(lastText(messages)).toContain("already running");
  });
});

describe("/reject", () => {
  it("rejects the child and captures a free-text reason", () => {
    const reject = jest.fn(() => ({ok: true as const}));
    const {ctx, messages} = buildCommandContext({sessions: {...stubSessions(), reject}});
    run(ctx, "reject", ["2", "out", "of", "scope"]);
    expect(reject).toHaveBeenCalledWith(2, "out of scope");
    expect(lastText(messages)).toContain("rejected #2");
    expect(lastText(messages)).toContain("worktree + branch kept");
  });

  it("surfaces a controller refusal (e.g. not reviewed yet)", () => {
    const reject = jest.fn(() => ({ok: false as const, reason: "review it first"}));
    const {ctx, messages} = buildCommandContext({sessions: {...stubSessions(), reject}});
    run(ctx, "reject", ["2"]);
    expect(lastText(messages)).toContain("review it first");
  });
});

/** The minimal sessions shape the recovery commands touch. */
function stubSessions() {
  return {
    list: jest.fn(() => []),
    activeChildId: jest.fn(() => null),
    spawn: jest.fn(() => ({ok: false as const, reason: "stub"})),
    enter: jest.fn(() => ({ok: false as const, reason: "stub"})),
    leave: jest.fn(() => ({ok: false as const, reason: "stub"})),
    review: jest.fn(() => ({ok: false as const, reason: "stub"})),
    mergeView: jest.fn(() => ({rows: [], readyCount: 0, blockedCount: 0, totalAdditions: 0, totalDeletions: 0})),
    merge: jest.fn(() => ({ok: false as const, reason: "stub"})),
    rebase: jest.fn(() => ({ok: false as const, reason: "stub"})),
    sendBack: jest.fn(() => ({ok: false as const, reason: "stub"})),
    reject: jest.fn(() => ({ok: false as const, reason: "stub"})),
  };
}
