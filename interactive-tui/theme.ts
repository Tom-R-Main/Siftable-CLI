/**
 * The TUI color palette. Extracted from index.tsx so presentational components
 * (views.tsx) and their snapshot tests can share the exact same theme the app
 * renders with.
 */
export const theme = {
  bg: "#000000",
  bgMuted: "#070707",
  border: "#2F2F2F",
  text: "#F5F5F5",
  muted: "#9CA3AF",
  accent: "#1D9BF0",
  accentStrong: "#5CB9FF",
  user: "#8DDDB6",
  shell: "#C7A0FF",
  tool: "#7FA8C9",
  transcriptSelection: "#13283A",
};

export type Theme = typeof theme;
