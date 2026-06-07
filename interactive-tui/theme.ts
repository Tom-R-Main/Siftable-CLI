/**
 * TUI color schemes for `sift interactive`.
 *
 * The active palette is a reactive Solid store (`theme`) so it can be swapped at
 * runtime from Settings → Appearance (the /theme picker) and the whole UI
 * recolors live. Call-sites keep reading `theme.bg` etc. unchanged — store
 * property reads inside JSX are tracked, so a scheme swap repaints everything.
 *
 * The default ("Sieve") concept: your raw input is unsifted noise; the
 * assistant's reply is the signal you sifted out — warm amber is reserved for
 * meaning, structure recedes to warm-dark, status colors appear only for live
 * state. Other schemes echo the product app (Bauhaus Klein blue), the marketing
 * site (Brutalist emerald), and the pre-redesign look (Classic blue).
 */
import { createStore } from "solid-js/store";
import { SyntaxStyle } from "@opentui/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Theme = {
  bg: string;
  bgMuted: string;
  raised: string;
  border: string;
  borderActive: string;
  text: string;
  muted: string;
  dim: string;
  accent: string;
  accentStrong: string;
  signal: string;
  signalText: string;
  cool: string;
  user: string;
  roleYou: string;
  roleAssistant: string;
  shell: string;
  tool: string;
  ok: string;
  warn: string;
  err: string;
  transcriptSelection: string;
};

export type SchemeName =
  | "sieve"
  | "salmon"
  | "rose-pine"
  | "everforest"
  | "gruvbox"
  | "nord"
  | "solarized"
  | "bauhaus"
  | "mono"
  | "classic";

export type Scheme = { name: SchemeName; label: string; description: string; colors: Theme };

export const SCHEMES: Scheme[] = [
  {
    name: "sieve",
    label: "Sieve",
    description: "warm amber signal on charcoal",
    colors: {
      bg: "#0a0a0a",
      bgMuted: "#141210",
      raised: "#1c1813",
      border: "#2a241c",
      borderActive: "#f5b700",
      text: "#f5efe6",
      muted: "#a8a094",
      dim: "#6b6358",
      accent: "#f5b700",
      accentStrong: "#ffce4d",
      signal: "#f5b700",
      signalText: "#ffce4d",
      cool: "#5C9DFF",
      user: "#cabfa9",
      roleYou: "#cabfa9",
      roleAssistant: "#ffce4d",
      shell: "#b89cff",
      tool: "#b0a08a",
      ok: "#2dc2a3",
      warn: "#ff9f45",
      err: "#ff6b6b",
      transcriptSelection: "#1c1813",
    },
  },
  {
    name: "salmon",
    label: "Salmon",
    description: "soft coral on warm dusk — gentle, low-strain",
    colors: {
      bg: "#1c1718",
      bgMuted: "#241d1e",
      raised: "#2c2324",
      border: "#3a2f30",
      borderActive: "#ff9d8a",
      text: "#f2e4e1",
      muted: "#c3aaa6",
      dim: "#8a7370",
      accent: "#f5a097",
      accentStrong: "#ffbfb4",
      signal: "#f5a097",
      signalText: "#ffbfb4",
      cool: "#7fc8c0",
      user: "#d8b8b2",
      roleYou: "#d8b8b2",
      roleAssistant: "#ffbfb4",
      shell: "#c8a0e0",
      tool: "#b39a96",
      ok: "#9cc49a",
      warn: "#e8b463",
      err: "#fb6f6f",
      transcriptSelection: "#2c2324",
    },
  },
  {
    name: "rose-pine",
    label: "Rosé Pine",
    description: "muted rose & iris — cozy, easy on the eyes",
    colors: {
      bg: "#232136",
      bgMuted: "#2a273f",
      raised: "#393552",
      border: "#44415a",
      borderActive: "#ea9a97",
      text: "#e0def4",
      muted: "#908caa",
      dim: "#6e6a86",
      accent: "#c4a7e7",
      accentStrong: "#ea9a97",
      signal: "#c4a7e7",
      signalText: "#f6c177",
      cool: "#9ccfd8",
      user: "#908caa",
      roleYou: "#908caa",
      roleAssistant: "#f6c177",
      shell: "#c4a7e7",
      tool: "#9ccfd8",
      ok: "#5fb3a1",
      warn: "#f6c177",
      err: "#eb6f92",
      transcriptSelection: "#2a273f",
    },
  },
  {
    name: "everforest",
    label: "Everforest",
    description: "soft forest green — designed for comfort",
    colors: {
      bg: "#2d353b",
      bgMuted: "#343f44",
      raised: "#3d484d",
      border: "#475258",
      borderActive: "#a7c080",
      text: "#d3c6aa",
      muted: "#9da9a0",
      dim: "#7a8478",
      accent: "#a7c080",
      accentStrong: "#dbbc7f",
      signal: "#a7c080",
      signalText: "#dbbc7f",
      cool: "#7fbbb3",
      user: "#9da9a0",
      roleYou: "#9da9a0",
      roleAssistant: "#dbbc7f",
      shell: "#d699b6",
      tool: "#83c092",
      ok: "#a7c080",
      warn: "#e69875",
      err: "#e67e80",
      transcriptSelection: "#343f44",
    },
  },
  {
    name: "gruvbox",
    label: "Gruvbox",
    description: "warm retro, soft contrast",
    colors: {
      bg: "#282828",
      bgMuted: "#32302f",
      raised: "#3c3836",
      border: "#504945",
      borderActive: "#fabd2f",
      text: "#ebdbb2",
      muted: "#a89984",
      dim: "#7c6f64",
      accent: "#fe8019",
      accentStrong: "#fabd2f",
      signal: "#fe8019",
      signalText: "#fabd2f",
      cool: "#83a598",
      user: "#d5c4a1",
      roleYou: "#d5c4a1",
      roleAssistant: "#fabd2f",
      shell: "#d3869b",
      tool: "#8ec07c",
      ok: "#b8bb26",
      warn: "#d79921",
      err: "#fb4934",
      transcriptSelection: "#32302f",
    },
  },
  {
    name: "nord",
    label: "Nord",
    description: "cool muted blue-grey, low contrast",
    colors: {
      bg: "#2e3440",
      bgMuted: "#3b4252",
      raised: "#434c5e",
      border: "#4c566a",
      borderActive: "#88c0d0",
      text: "#eceff4",
      muted: "#d8dee9",
      dim: "#7b88a1",
      accent: "#88c0d0",
      accentStrong: "#8fbcbb",
      signal: "#88c0d0",
      signalText: "#8fbcbb",
      cool: "#81a1c1",
      user: "#d8dee9",
      roleYou: "#d8dee9",
      roleAssistant: "#88c0d0",
      shell: "#b48ead",
      tool: "#81a1c1",
      ok: "#a3be8c",
      warn: "#ebcb8b",
      err: "#bf616a",
      transcriptSelection: "#3b4252",
    },
  },
  {
    name: "solarized",
    label: "Solarized",
    description: "the classic precision-tuned eye-comfort palette",
    colors: {
      bg: "#002b36",
      bgMuted: "#073642",
      raised: "#0a4453",
      border: "#11505f",
      borderActive: "#2aa198",
      text: "#93a1a1",
      muted: "#839496",
      dim: "#657b83",
      accent: "#268bd2",
      accentStrong: "#2aa198",
      signal: "#268bd2",
      signalText: "#2aa198",
      cool: "#6c71c4",
      user: "#839496",
      roleYou: "#839496",
      roleAssistant: "#2aa198",
      shell: "#6c71c4",
      tool: "#2aa198",
      ok: "#859900",
      warn: "#b58900",
      err: "#dc322f",
      transcriptSelection: "#073642",
    },
  },
  {
    name: "bauhaus",
    label: "Bauhaus",
    description: "Klein blue on zinc — matches the app",
    colors: {
      bg: "#000000",
      bgMuted: "#09090b",
      raised: "#18181b",
      border: "#27272a",
      borderActive: "#4b63ff",
      text: "#fafafa",
      muted: "#a1a1aa",
      dim: "#71717a",
      accent: "#1e40ff",
      accentStrong: "#4b63ff",
      signal: "#1e40ff",
      signalText: "#5C9DFF",
      cool: "#5C9DFF",
      user: "#a1a1aa",
      roleYou: "#a1a1aa",
      roleAssistant: "#5C9DFF",
      shell: "#8b5cf6",
      tool: "#7FA8C9",
      ok: "#2dc2a3",
      warn: "#f5b700",
      err: "#ff6b6b",
      transcriptSelection: "#14213a",
    },
  },
  {
    name: "mono",
    label: "Mono",
    description: "brutalist emerald, grayscale",
    colors: {
      bg: "#0A0A0A",
      bgMuted: "#111111",
      raised: "#161616",
      border: "#1C1C1C",
      borderActive: "#00E5AA",
      text: "#F0F0F0",
      muted: "#8A8A8A",
      dim: "#5A5A5A",
      accent: "#00C896",
      accentStrong: "#00E5AA",
      signal: "#00C896",
      signalText: "#00E5AA",
      cool: "#00E5AA",
      user: "#C7C7C7",
      roleYou: "#C7C7C7",
      roleAssistant: "#00E5AA",
      shell: "#8A8A8A",
      tool: "#8A8A8A",
      ok: "#00C896",
      warn: "#f5b700",
      err: "#ff6b6b",
      transcriptSelection: "#161616",
    },
  },
  {
    name: "classic",
    label: "Classic",
    description: "the original Twitter-blue look",
    colors: {
      bg: "#000000",
      bgMuted: "#070707",
      raised: "#13283A",
      border: "#2F2F2F",
      borderActive: "#1D9BF0",
      text: "#F5F5F5",
      muted: "#9CA3AF",
      dim: "#6B7280",
      accent: "#1D9BF0",
      accentStrong: "#5CB9FF",
      signal: "#1D9BF0",
      signalText: "#5CB9FF",
      cool: "#5CB9FF",
      user: "#8DDDB6",
      roleYou: "#8DDDB6",
      roleAssistant: "#5CB9FF",
      shell: "#C7A0FF",
      tool: "#7FA8C9",
      ok: "#8DDDB6",
      warn: "#f5b700",
      err: "#ff6b6b",
      transcriptSelection: "#13283A",
    },
  },
];

export const DEFAULT_SCHEME: SchemeName = "sieve";

export function schemeByName(name: string | undefined): Scheme {
  return SCHEMES.find((s) => s.name === name) ?? SCHEMES[0];
}

export function schemeIndexOf(name: SchemeName): number {
  const i = SCHEMES.findIndex((s) => s.name === name);
  return i < 0 ? 0 : i;
}

// ── Active theme (reactive) ─────────────────────────────────────────────────
const [theme, setThemeStore] = createStore<Theme>({ ...schemeByName(DEFAULT_SCHEME).colors });
export { theme };

let _active: SchemeName = DEFAULT_SCHEME;
export const currentSchemeName = (): SchemeName => _active;

/** Swap the active palette. Every key is overwritten, so the UI repaints. */
export function applyScheme(name: SchemeName): void {
  const scheme = schemeByName(name);
  _active = scheme.name;
  setThemeStore({ ...scheme.colors });
}

// ── Persistence (~/.siftable/appearance.json) ───────────────────────────────
const APPEARANCE_FILE = join(homedir(), ".siftable", "appearance.json");

export function loadSavedScheme(): SchemeName {
  try {
    if (!existsSync(APPEARANCE_FILE)) return DEFAULT_SCHEME;
    const parsed = JSON.parse(readFileSync(APPEARANCE_FILE, "utf8")) as { scheme?: string };
    return schemeByName(parsed.scheme).name;
  } catch {
    return DEFAULT_SCHEME;
  }
}

export function saveScheme(name: SchemeName): void {
  try {
    mkdirSync(join(homedir(), ".siftable"), { recursive: true });
    writeFileSync(APPEARANCE_FILE, `${JSON.stringify({ scheme: name }, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort — appearance is not worth crashing the TUI over */
  }
}

// ── Markdown + code-block highlight theme, derived from a palette ────────────
// Tree-sitter capture scopes → palette; unknown scopes fall back to `default`.
// fromStyles accepts hex strings (ColorInput) directly. Rebuilt when the scheme
// changes (see the memo in index.tsx) so assistant markdown recolors too.
export function buildSyntaxStyle(t: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: t.text },
    "markup.heading": { fg: t.signalText, bold: true },
    "markup.strong": { fg: t.text, bold: true },
    "markup.italic": { fg: t.user, italic: true },
    "markup.strikethrough": { fg: t.dim },
    "markup.list": { fg: t.signal },
    "markup.quote": { fg: t.muted, italic: true },
    "markup.raw": { fg: t.cool },
    "markup.raw.block": { fg: t.text },
    "markup.link": { fg: t.cool, underline: true },
    "markup.link.label": { fg: t.cool },
    "markup.link.url": { fg: t.cool, underline: true },
    "string.special.url": { fg: t.cool, underline: true },
    keyword: { fg: t.warn },
    string: { fg: t.ok },
    number: { fg: t.signalText },
    boolean: { fg: t.signalText },
    constant: { fg: t.signalText },
    comment: { fg: t.dim, italic: true },
    function: { fg: t.cool },
    type: { fg: t.signalText },
    variable: { fg: t.text },
    property: { fg: t.text },
    attribute: { fg: t.signal },
    tag: { fg: t.warn },
    label: { fg: t.signal },
    operator: { fg: t.muted },
    punctuation: { fg: t.muted },
  });
}
