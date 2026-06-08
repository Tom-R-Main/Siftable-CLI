/**
 * Track B B4 — the /branches command surface. The overlay is opened by the TUI's
 * handleSlash interception; the command `run` is the text fallback (scripted /
 * non-overlay use), so it renders the dashboard via ctx.sessions.mergeView().
 * Also guards the collapse: /children /enter /leave /ready stay registered and
 * dispatchable but hidden, and `b` aliases /branches.
 */
import {interactiveCommands, type InteractiveCommandContext} from "../../interactive-tui/commands";
import {buildCommandContext} from "../helpers/interactive-command-context";
import type {ParentMergeView} from "../../interactive-tui/mergeView";

function find(name: string) {
  return interactiveCommands.find((c) => c.name === name || c.aliases?.includes(name));
}
function run(ctx: InteractiveCommandContext, name: string, args: string[] = []): void {
  const cmd = find(name);
  if (!cmd) throw new Error(`command not found: ${name}`);
  void cmd.run(ctx, args);
}
function lastText(messages: {text: string}[]): string {
  return messages[messages.length - 1]?.text ?? "";
}

const populated: ParentMergeView = {
  rows: [
    {sessionId: 2, branch: "sift/a", baseBranch: "main", status: "running", verdict: "ready_to_merge", files: 1, additions: 3, deletions: 1, behindBy: 0, blockers: []},
    {sessionId: 3, branch: "sift/b", baseBranch: "main", status: "merge_blocked", verdict: "merge_blocked", files: 1, additions: 0, deletions: 0, behindBy: 2, blockers: ["conflicts with main in: x.ts"]},
  ],
  readyCount: 1,
  blockedCount: 1,
  totalAdditions: 3,
  totalDeletions: 1,
};

describe("/branches command (text fallback)", () => {
  it("renders the dashboard from sessions.mergeView()", () => {
    const mergeView = jest.fn(() => populated);
    const {ctx, messages} = buildCommandContext({
      sessions: {list: jest.fn(() => []), activeChildId: jest.fn(() => null), spawn: jest.fn(), enter: jest.fn(), leave: jest.fn(), review: jest.fn(), mergeView, merge: jest.fn()},
    });
    run(ctx, "branches");
    expect(mergeView).toHaveBeenCalled();
    expect(lastText(messages)).toContain("Branches (/branches to open");
    expect(lastText(messages)).toContain("#2 sift/a → main");
    expect(lastText(messages)).toContain("1 ready · 1 blocked");
  });

  it("shows the empty-state hint when there are no children", () => {
    const {ctx, messages} = buildCommandContext(); // default stub → empty view
    run(ctx, "branches");
    expect(lastText(messages)).toContain("No child branches yet");
    expect(lastText(messages)).toContain("/branches to review and land");
  });

  it("is reachable via the `b` alias", () => {
    expect(find("b")?.name).toBe("branches");
  });
});

describe("collapsed mergeMaster commands", () => {
  it("/branches, /spawn and /merge stay visible; /children /enter /leave /ready are hidden", () => {
    expect(find("branches")?.hidden).toBeFalsy();
    expect(find("spawn")?.hidden).toBeFalsy();
    expect(find("merge")?.hidden).toBeFalsy();
    for (const name of ["children", "enter", "leave", "ready"]) {
      expect(find(name)?.hidden).toBe(true);
    }
  });

  it("hidden commands are still registered and dispatchable", () => {
    const {ctx} = buildCommandContext();
    for (const name of ["children", "enter", "leave", "ready"]) {
      expect(() => run(ctx, name)).not.toThrow();
    }
  });

  it("help lists /branches but omits the hidden four", () => {
    const {ctx, messages} = buildCommandContext();
    run(ctx, "help");
    const text = lastText(messages);
    expect(text).toContain("/branches");
    expect(text).not.toMatch(/\/children\b/);
    expect(text).not.toMatch(/\/enter\b/);
  });
});
