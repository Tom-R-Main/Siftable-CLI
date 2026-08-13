import {describe, expect, it} from "bun:test";
import {
  draftToHandoffInput,
  emptyHandoffDraft,
  formatWorkRow,
  handoffPreviewLines,
  initialWorkState,
  reduceWorkKey,
  workDetailLines,
  type WorkBoardItem,
} from "../workHubOverlay";

function boundedItem(): WorkBoardItem {
  return {
    id: "work-1",
    title: "Ship the control plane",
    status: "queued",
    agent: "codex",
    owner: null,
    prompt: "Make the contract legible.",
    writeScope: ["packages/exf-cli/interactive-tui"],
    excludedScope: ["packages/exf-cli/interactive-tui/native/**"],
    verification: ["bun test"],
    acceptance: ["Rows show readiness"],
    blockers: [],
    claimability: "ready",
    contract: {
      classification: "bounded",
      profile: "coding",
      enabledActions: ["read", "write", "test"],
      acceptanceCriteriaCount: 1,
      verificationCommandCount: 1,
      verifiedCommandCount: 0,
      verificationState: "unverified",
      explanation: null,
    },
  };
}

describe("work contract hub", () => {
  it("renders compact classification, proof, and grouped contract detail", () => {
    const item = boundedItem();
    expect(formatWorkRow(item)).toContain("bounded:coding · 0/1 proof · unverified · queued");
    expect(workDetailLines(item)).toEqual(expect.arrayContaining([
      expect.stringContaining("Outcome"),
      expect.stringContaining("Authority"),
      expect.stringContaining("Boundary"),
      expect.stringContaining("Proof"),
      expect.stringContaining("Execution"),
    ]));
  });

  it("explains legacy items instead of presenting them as runnable", () => {
    const item = boundedItem();
    item.contract = {
      ...item.contract!,
      classification: "legacy",
      profile: null,
      explanation: "Re-author this item through handoff before running it.",
    };
    expect(formatWorkRow(item)).toContain("legacy · proof missing");
    expect(workDetailLines(item).join("\n")).toContain("Re-author this item");
  });

  it("routes x on a selected row to the contracted run action", () => {
    expect(reduceWorkKey(initialWorkState(), {sequence: "x"}, [boundedItem()])).toEqual({
      kind: "runWork",
      rowIdx: 0,
    });
  });

  it("requires a complete coding contract before preview and confirmation", () => {
    const incomplete = {...emptyHandoffDraft(), title: "Incomplete", fieldIdx: 4};
    const rejected = reduceWorkKey({stage: "handoffForm", draft: incomplete}, {name: "return"}, []);
    expect(rejected.kind).toBe("handoff");
    expect(draftToHandoffInput(incomplete).ok).toBe(false);

    const draft = {
      ...incomplete,
      files: "packages/exf-cli/interactive-tui",
      acceptance: "The board is legible",
      verify: "bun test test/workHubOverlay.test.ts",
    };
    const mapped = draftToHandoffInput(draft);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    if (!("contract" in mapped.input)) throw new Error("expected bounded contract");
    expect(mapped.input.contract.profile).toBe("coding");
    expect(mapped.input.contract.boundary.writeScope.include).toEqual(["packages/exf-cli/interactive-tui"]);
    expect(handoffPreviewLines(draft).join("\n")).toContain("Execution  assign codex · queued");

    const preview = reduceWorkKey({stage: "handoffForm", draft}, {name: "return"}, []);
    expect(preview.kind).toBe("none");
    if (preview.kind !== "none") return;
    expect(preview.state.stage).toBe("handoffPreview");
    expect(reduceWorkKey(preview.state, {name: "return"}, [])).toEqual({kind: "handoff", draft});
  });

  it("toggles read-only profile without raw JSON and clears write scope", () => {
    const draft = {...emptyHandoffDraft(), files: "src/**", excludeFiles: "src/generated/**", fieldIdx: 1};
    const action = reduceWorkKey({stage: "handoffForm", draft}, {name: "right"}, []);
    expect(action.kind).toBe("none");
    if (action.kind !== "none" || action.state.stage !== "handoffForm") return;
    expect(action.state.draft.profile).toBe("read_only");
    expect(action.state.draft.files).toBe("");
    expect(action.state.draft.excludeFiles).toBe("");
  });
});
