/**
 * Pure, prop-driven presentational components extracted from index.tsx so the
 * highest-stakes UI surfaces can be frame-snapshotted under opentui's test
 * renderer (see test/render.test.tsx) without mounting the whole App and its
 * live clients. These render the same markup the app does — index.tsx imports
 * them — so a snapshot guards what users actually see.
 */
import { Show } from "solid-js";
import type { SyntaxStyle } from "@opentui/core";
import type { ConfirmSpec } from "./confirmGate";
import type { Theme } from "./theme";

/**
 * An assistant reply. One <markdown> instance renders the reply both while it
 * streams and after it settles: opentui parses incrementally and keeps the
 * trailing block unstable until `streaming` turns false. Swapping a plain
 * <text> for a freshly mounted <markdown> on completion blanked the reply for
 * several frames while the new instance parsed.
 */
export function AssistantReply(props: {
  text: string;
  streaming: boolean;
  syntaxStyle: SyntaxStyle;
  theme: Theme;
}) {
  return (
    <>
      <text fg={props.theme.accentStrong}>siftable</text>
      <markdown
        content={props.text || "…"}
        streaming={props.streaming}
        syntaxStyle={props.syntaxStyle}
        internalBlockMode="top-level"
        fg={props.theme.text}
        bg={props.theme.bg}
      />
    </>
  );
}

/**
 * The approval overlay — the security gate that asks before Codex/brain runs a
 * command or writes a file. Its wording encodes which decisions are on offer
 * (`allowAlways` / `allowBypass`), so its layout is worth pinning.
 */
export function ApprovalOverlay(props: { request: ConfirmSpec; theme: Theme }) {
  const c = () => props.request;
  const theme = props.theme;
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      borderStyle="single"
      borderColor={theme.accentStrong}
      backgroundColor={theme.bgMuted}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.accentStrong} selectable={false}>
        {c().kind === "command" ? "Approve command?" : c().kind === "write" ? "Approve write?" : "Approve edit?"}
      </text>
      <text fg={theme.text} selectable={false}>{c().path}</text>
      <Show when={c().detail}>
        <text fg={theme.muted} selectable={false}>{c().detail}</text>
      </Show>
      <text fg={theme.muted} selectable={false}>
        {`y allow once · ${c().allowAlways === false ? "" : "a always allow this · "}${c().allowBypass === false ? "" : "b bypass all · "}n/Esc deny`}
      </text>
    </box>
  );
}
