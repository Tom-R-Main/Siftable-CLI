/**
 * The /work hub's command-layer helpers (commands.ts): loadWorkBoard (board data
 * shared with /queue + the overlay), workItemEvidence (the `v` action's query),
 * and createHandoffWorkItem (the payload shared with /handoff). The pure reducer
 * is covered in ../workHubOverlay.test.ts; these tests cover the data shaping +
 * API plumbing against the mocked client.
 */
import {loadWorkBoard, workItemEvidence, createHandoffWorkItem, interactiveCommands} from "../../interactive-tui/commands";
import type {WorkBoardItem} from "../../interactive-tui/workHubOverlay";
import {buildCommandContext, response} from "../helpers/interactive-command-context";

describe("loadWorkBoard", () => {
  it("normalizes agents + work items (snake/camel, scope, criteria)", async () => {
    const {ctx} = buildCommandContext();
    (ctx.apiClient.listWorkItems as jest.Mock).mockReturnValue(
      response({
        workItems: [
          {
            id: "11111111-2222-3333-4444-555555555555",
            title: "Fix paste",
            status: "running",
            assigned_alias: "codex",
            claim_owner: "codex@tty1",
            prompt: "fix the composer",
            write_scope: {include: ["src/composer/**", "src/x.ts"]},
            verification_commands: ["npm test -- composer"],
            acceptance_criteria: [{text: "paste preserved", met: false}],
            blocked_reason: "waiting on #other",
          },
        ],
      }),
    );
    const board = await loadWorkBoard(ctx);
    expect(board.agents).toEqual([{alias: "codex", status: "active"}]);
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toEqual({
      id: "11111111-2222-3333-4444-555555555555",
      title: "Fix paste",
      status: "running",
      agent: "codex",
      owner: "codex@tty1",
      prompt: "fix the composer",
      writeScope: ["src/composer/**", "src/x.ts"],
      verification: ["npm test -- composer"],
      acceptance: ["paste preserved"],
      blockers: ["waiting on #other"],
    });
  });

  it("falls back gracefully on sparse rows", async () => {
    const {ctx} = buildCommandContext();
    (ctx.apiClient.listWorkItems as jest.Mock).mockReturnValue(response({workItems: [{id: "x"}]}));
    const board = await loadWorkBoard(ctx);
    expect(board.items[0]).toMatchObject({
      id: "x",
      title: "(untitled)",
      status: "unknown",
      agent: "-",
      owner: null,
      writeScope: [],
      acceptance: [],
      blockers: [],
    });
  });
});

describe("workItemEvidence", () => {
  it("builds a query from title + acceptance + prompt and searches code", async () => {
    const {ctx} = buildCommandContext();
    (ctx.apiClient.searchCode as jest.Mock).mockReturnValue(
      response({results: [{filePath: "src/a.ts", startLine: 10, symbolName: "foo"}, {filePath: "src/a.test.ts", startLine: 1}]}),
    );
    const item: WorkBoardItem = {
      id: "i1",
      title: "Fix paste",
      status: "queued",
      agent: "codex",
      owner: null,
      prompt: "the composer drops the first line",
      writeScope: ["src/**"],
      verification: ["npm test"],
      acceptance: ["paste preserved"],
      blockers: [],
    };
    const text = await workItemEvidence(ctx, item);
    const query = (ctx.apiClient.searchCode as jest.Mock).mock.calls[0][0].query as string;
    expect(query).toBe("Fix paste. paste preserved. the composer drops the first line");
    expect(text).toContain("Evidence: Fix paste");
    expect(text).toContain("src/a.ts:10 foo");
    expect(text).toContain("Test evidence:");
    expect(text).toContain("src/a.test.ts");
  });
});

describe("createHandoffWorkItem", () => {
  it("builds the work-item payload (acceptance as {text,met}) and returns the confirmation", async () => {
    const {ctx, createdWork} = buildCommandContext();
    const msg = await createHandoffWorkItem(ctx, {
      title: "Do the thing",
      agent: "claude",
      files: ["src/a.ts", "src/b.ts"],
      acceptance: ["compiles", "tests pass"],
      verify: ["npm test"],
    });
    expect(ctx.apiClient.createWorkItem).toHaveBeenCalledTimes(1);
    const payload = createdWork[0] as Record<string, any>;
    expect(payload.title).toBe("Do the thing");
    expect(payload.assignedAlias).toBe("claude");
    expect(payload.inputContext.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(payload.acceptanceCriteria).toEqual([
      {text: "compiles", met: false},
      {text: "tests pass", met: false},
    ]);
    expect(payload.verificationCommands).toEqual(["npm test"]);
    expect(msg).toBe("Work item created: work-new · Do the thing");
  });
});

describe("/work command registration", () => {
  it("registers /work (alias w) visible and hides the folded inspect verbs", () => {
    const byName = new Map(interactiveCommands.map((c) => [c.name, c]));
    const work = byName.get("work");
    expect(work).toBeDefined();
    expect(work?.hidden).toBeFalsy();
    expect(work?.aliases).toContain("w");
    for (const folded of ["queue", "focus", "recap", "ship"]) {
      expect(byName.get(folded)?.hidden).toBe(true);
    }
    // The rich-arg commands stay visible (faster typed than menu-driven).
    for (const visible of ["plan", "handoff", "proof"]) {
      expect(byName.get(visible)?.hidden).toBeFalsy();
    }
  });

  it("text fallback prints the board grouped by status", async () => {
    const {ctx, messages} = buildCommandContext();
    const work = interactiveCommands.find((c) => c.name === "work");
    await work!.run(ctx, []);
    const text = messages.at(-1)?.text ?? "";
    expect(text).toContain("Work");
    expect(text).toContain("codex (active)");
    expect(text).toContain("Fix composer");
    expect(text).toContain("needs_review");
  });
});
