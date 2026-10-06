/**
 * Frame snapshots for presentational TUI components, rendered through opentui's
 * test renderer (native Zig core, Bun-only — this suite cannot run under the
 * Node/ts-jest CLI tests). `captureCharFrame()` returns the rendered grid as a
 * string; we snapshot it so layout/wording regressions in the components users
 * actually see are caught.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { TestRecorder } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import { ApprovalOverlay, AssistantReply } from "../views";
import { buildSyntaxStyle, theme } from "../theme";
import type { ConfirmSpec } from "../confirmGate";

async function frameOf(node: () => unknown): Promise<string> {
  const { renderer, renderOnce, captureCharFrame } = await testRender(node, { width: 60, height: 10 });
  await renderOnce();
  const frame = captureCharFrame();
  renderer.destroy();
  return frame;
}

describe("ApprovalOverlay frame", () => {
  it("renders a command approval with all decisions offered", async () => {
    const request: ConfirmSpec = {
      kind: "command",
      path: "rm -rf build/",
      detail: "cwd: /repo",
    };
    expect(await frameOf(() => <ApprovalOverlay request={request} theme={theme} />)).toMatchSnapshot();
  });

  it("renders a write approval", async () => {
    const request: ConfirmSpec = {
      kind: "write",
      path: "src/app.ts",
      detail: "+128 bytes",
    };
    expect(await frameOf(() => <ApprovalOverlay request={request} theme={theme} />)).toMatchSnapshot();
  });

  it("omits the detail line when there is no detail", async () => {
    const request: ConfirmSpec = { kind: "edit", path: "src/app.ts", detail: "" };
    expect(await frameOf(() => <ApprovalOverlay request={request} theme={theme} />)).toMatchSnapshot();
  });

  it("drops the 'always' and 'bypass' affordances when disabled", async () => {
    const request: ConfirmSpec = {
      kind: "command",
      path: "curl https://example.test",
      detail: "network egress",
      allowAlways: false,
      allowBypass: false,
    };
    expect(await frameOf(() => <ApprovalOverlay request={request} theme={theme} />)).toMatchSnapshot();
  });
});

describe("AssistantReply streaming", () => {
  const VISIBLE = "Response remains visible";
  // Each tail, and text that is on screen only once that tail has rendered.
  const TAILS = {
    paragraph: ["\n\nmore text", "more text"],
    fence: ["\n\n```ts\nconst x = 1\n```\n", "const x = 1"],
    table: ["\n\n| a | b |\n|---|---|\n| 1 | 2 |", "1"],
  } as const;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  // Renders one reply driven by signals, waits until `ready` text is on screen,
  // then records every frame produced while `change` runs and until `done`
  // text is on screen. Code blocks highlight asynchronously, so fixed render
  // counts are not enough under load; each wait polls with a deadline.
  async function framesDuring(
    initial: string,
    change: (set: { text: (t: string) => void; streaming: (s: boolean) => void }) => void,
    done: string,
  ): Promise<string[]> {
    const [text, setText] = createSignal(initial);
    const [streaming, setStreaming] = createSignal(true);
    const style = buildSyntaxStyle(theme);
    const { renderer, renderOnce, captureCharFrame } = await testRender(
      () => <AssistantReply text={text()} streaming={streaming()} syntaxStyle={style} theme={theme} />,
      { width: 40, height: 12 },
    );
    const settleUntil = async (needle: string) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        await renderOnce();
        await tick();
        if (captureCharFrame().includes(needle)) return;
        if (Date.now() > deadline) throw new Error(`"${needle}" never rendered:\n${captureCharFrame()}`);
      }
    };
    try {
      await settleUntil(VISIBLE);
      const recorder = new TestRecorder(renderer);
      recorder.rec();
      change({ text: setText, streaming: setStreaming });
      await settleUntil(done);
      // A completion can re-render after `done` first appears; keep recording.
      for (let i = 0; i < 3; i += 1) {
        await renderOnce();
        await tick();
      }
      recorder.stop();
      return recorder.recordedFrames.map((f) => f.frame);
    } finally {
      renderer.destroy();
    }
  }

  for (const [name, [tail, marker]] of Object.entries(TAILS)) {
    it(`keeps earlier blocks on screen while a ${name} streams in`, async () => {
      const head = `# Hello\n\n${VISIBLE}`;
      const frames = await framesDuring(head, (set) => set.text(head + tail), marker);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((f) => f.includes(VISIBLE))).toBe(true);
    });

    it(`shows the settled ${name} after the stream completes`, async () => {
      const full = `# Hello\n\n${VISIBLE}${tail}`;
      const frames = await framesDuring(full, (set) => set.streaming(false), VISIBLE);
      expect(frames.at(-1)).toContain(VISIBLE);
      expect(frames.at(-1)).toContain(marker);
    });
  }

  // @opentui/core 0.3.1 rebuilds every top-level block when `streaming` turns
  // false, so the reply blanks for one or two frames on completion. Fixed
  // upstream in opentui #1469 (c45f25ed). When the dependency upgrade lands
  // this starts passing and `it.failing` turns red: switch it to `it`.
  it.failing("never blanks the reply on stream completion", async () => {
    const full = `# Hello\n\n${VISIBLE}${TAILS.paragraph[0]}`;
    const frames = await framesDuring(full, (set) => set.streaming(false), VISIBLE);
    expect(frames.every((f) => f.includes(VISIBLE))).toBe(true);
  });
});
