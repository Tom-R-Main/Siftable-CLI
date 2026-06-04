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
import { ApprovalOverlay } from "../views";
import { theme } from "../theme";
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
