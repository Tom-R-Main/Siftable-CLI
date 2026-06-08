/**
 * Skills loader for the sift interactive copilot.
 *
 * A "skill" is a folder with a `SKILL.md` (YAML frontmatter + markdown body),
 * following the Agent Skills open standard (Anthropic) that Claude Code, Codex,
 * and opencode all share. We deliberately read the SAME directories those tools
 * use so the existing ecosystem (e.g. gstack) works unmodified:
 *
 *   project:  <root>/{.sift,.claude,.codex,.agents}/skills/<name>/SKILL.md
 *   user:     ~/{.claude,.codex,.agents}/skills, ~/.config/sift/skills
 *   builtin:  shipped alongside this package (skills/<name>/SKILL.md)
 *
 * Progressive disclosure: discovery reads only frontmatter (name + description)
 * for the system-prompt index; the full body is loaded lazily by the `skill`
 * tool when the agent decides a skill is relevant.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillSource = "project" | "user" | "builtin";

export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Absolute path to the skill directory (where bundled resources live). */
  dir: string;
  source: SkillSource;
}

export interface LoadedSkill {
  info: SkillInfo;
  /** SKILL.md body with the frontmatter stripped. */
  body: string;
  /** Bundled resource files (relative to the skill dir), excluding SKILL.md. */
  files: string[];
}

export interface DiscoverOptions {
  /** Workspace/repo root. Defaults to SIFT_WORKSPACE_ROOT. */
  projectRoot?: string;
  /** Session cwd. Defaults to SIFT_USER_CWD or process.cwd(). */
  cwd?: string;
  home?: string;
  /** Vendored builtin skills dir. Defaults to ./skills next to this module. */
  builtinDir?: string;
}

const SKILL_FILE = "SKILL.md";
const PROJECT_NAMESPACES = [".sift", ".claude", ".codex", ".agents"];
const MAX_SCAN_DEPTH = 2; // <root>/<name>/SKILL.md and <root>/<pack>/<name>/SKILL.md
const MAX_DIRS_PER_ROOT = 2000;
const MAX_BUNDLED_FILES = 20;
const IGNORED_DIRS = new Set(["node_modules", ".git", ".zig-cache", "dist", "zig-out"]);

/** Default builtin skills directory (shipped with this package). */
export function builtinSkillsDir(): string {
  return fileURLToPath(new URL("./skills", import.meta.url));
}

/**
 * Discover all skills visible from the current workspace. Returns one entry per
 * unique skill name; project skills override user skills override builtins.
 */
export function discoverSkills(opts: DiscoverOptions = {}): SkillInfo[] {
  const home = opts.home ?? homedir();
  const projectRoot = opts.projectRoot ?? process.env.SIFT_WORKSPACE_ROOT ?? undefined;
  const cwd = opts.cwd ?? process.env.SIFT_USER_CWD ?? process.cwd();
  const builtinDir = opts.builtinDir ?? builtinSkillsDir();

  const groups: Array<{ source: SkillSource; roots: string[] }> = [
    { source: "project", roots: projectRoots([projectRoot, cwd]) },
    {
      source: "user",
      roots: [
        join(home, ".claude", "skills"),
        join(home, ".codex", "skills"),
        join(home, ".agents", "skills"),
        join(home, ".config", "sift", "skills"),
      ],
    },
    { source: "builtin", roots: [builtinDir] },
  ];

  const byName = new Map<string, SkillInfo>();
  for (const group of groups) {
    for (const root of dedupe(group.roots)) {
      if (!existsSync(root)) continue;
      for (const found of scanRoot(root)) {
        const info = parseSkillFile(found, group.source);
        if (!info) continue;
        if (!byName.has(info.name)) byName.set(info.name, info); // earlier group/root wins
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a skill's body and bundled file list (progressive disclosure level 2/3). */
export function loadSkill(name: string, skills: SkillInfo[]): LoadedSkill | null {
  const info = skills.find((s) => s.name === name);
  if (!info) return null;
  let raw = "";
  try {
    raw = readFileSync(info.path, "utf8");
  } catch {
    return null;
  }
  return { info, body: stripFrontmatter(raw).trim(), files: listBundledFiles(info.dir) };
}

/** Max skills advertised in the system prompt (level 1). Keeps the prompt lean
 * even when the user has a large global skill pack (e.g. gstack ~50 skills); the
 * `skill` tool can still load any discovered skill by name beyond this cap. */
export const DEFAULT_SKILL_PROMPT_LIMIT = 50;

/**
 * Frontmatter index for the system prompt (level 1 — name + description only).
 * Builtin and project skills are listed first so workspace-relevant skills always
 * make the cut; the remainder is summarized as a count.
 */
export function formatSkillsForPrompt(skills: SkillInfo[], limit = DEFAULT_SKILL_PROMPT_LIMIT): string {
  if (skills.length === 0) return "";
  const rank: Record<SkillSource, number> = { builtin: 0, project: 1, user: 2 };
  const ordered = [...skills].sort(
    (a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name),
  );
  const shown = ordered.slice(0, Math.max(1, limit));
  const lines = shown.map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  const remainder = ordered.length - shown.length;
  if (remainder > 0) lines.push(`- …and ${remainder} more (run /skills to list; load any by name with the skill tool)`);
  return [
    "",
    "## Skills",
    "These reusable skills provide specialized instructions for specific tasks. " +
      "When a task matches a skill's description, call the `skill` tool with its name to load the full instructions before proceeding. " +
      "Do not guess a skill's contents from its name.",
    ...lines,
  ].join("\n");
}

/** Human-readable listing for the `/skills` slash command. */
export function formatSkillsList(skills: SkillInfo[]): string {
  if (skills.length === 0) {
    return "No skills found. Add SKILL.md folders under .sift/skills, ~/.claude/skills, ~/.codex/skills, or ~/.agents/skills.";
  }
  const order: SkillSource[] = ["project", "user", "builtin"];
  const out: string[] = [`${skills.length} skill${skills.length === 1 ? "" : "s"} available:`];
  for (const source of order) {
    const group = skills.filter((s) => s.source === source);
    if (group.length === 0) continue;
    out.push(`\n[${source}]`);
    for (const s of group) out.push(`  ${s.name} — ${s.description || "(no description)"}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------

function projectRoots(bases: Array<string | undefined>): string[] {
  const roots: string[] = [];
  for (const base of bases) {
    if (!base) continue;
    for (const ns of PROJECT_NAMESPACES) {
      roots.push(join(base, ns, "skills"));
    }
  }
  return roots;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Find every SKILL.md under a root, bounded in depth and breadth, cycle-safe. */
function scanRoot(root: string): string[] {
  const found: string[] = [];
  const visited = new Set<string>();
  let budget = MAX_DIRS_PER_ROOT;

  const walk = (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH || budget <= 0) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes(SKILL_FILE)) found.push(join(dir, SKILL_FILE));

    for (const entry of entries) {
      if (budget <= 0) break;
      if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue;
      const child = join(dir, entry);
      if (!isDir(child)) continue;
      budget -= 1;
      walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory(); // follows symlinks (gstack installs are symlinks)
  } catch {
    return false;
  }
}

function parseSkillFile(skillMdPath: string, source: SkillSource): SkillInfo | null {
  let raw = "";
  try {
    raw = readFileSync(skillMdPath, "utf8");
  } catch {
    return null;
  }
  const meta = readSkillMeta(raw);
  if (!meta) return null;
  const dir = skillMdPath.slice(0, skillMdPath.length - (SKILL_FILE.length + 1));
  return { name: meta.name, description: meta.description, path: skillMdPath, dir, source };
}

// --- Native frontmatter parser (Zig skill_meta) with a pure-TS fallback ------
//
// SKILL.md frontmatter parsing lives in native/skill_meta.zig — the codex-in-Rust
// → Zig analog, since a byte/line parser is native-kernel territory. The dylib is
// loaded over Bun FFI when present; under ts-jest/node it is absent and the
// `parseFrontmatter` reader below is the byte-for-byte-equivalent fallback. The
// two MUST stay in lockstep (the Zig inline tests are the contract of record).

type SkillMetaSymbols = {
  sift_skill_parse: (
    content: Uint8Array,
    contentLen: number,
    out: Uint8Array,
    outCap: number,
    written: Uint32Array,
    needed: Uint32Array,
  ) => number;
};

let skillMetaSyms: SkillMetaSymbols | null | undefined;

function skillMetaNative(): SkillMetaSymbols | null {
  if (skillMetaSyms !== undefined) return skillMetaSyms;
  if (typeof Bun === "undefined" || process.env.SIFT_NO_NATIVE === "1") {
    skillMetaSyms = null;
    return skillMetaSyms;
  }
  try {
    const { default: libraryPath } = require("./native/skill_meta") as { default: string };
    if (!existsSync(libraryPath)) {
      skillMetaSyms = null;
      return skillMetaSyms;
    }
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen(libraryPath, {
      sift_skill_parse: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.u32,
      },
    });
    skillMetaSyms = lib.symbols as unknown as SkillMetaSymbols;
  } catch {
    skillMetaSyms = null;
  }
  return skillMetaSyms;
}

const skillMetaEncoder = new TextEncoder();
const skillMetaDecoder = new TextDecoder();

/** Run the native parser; null when the dylib is unavailable OR it's not a skill. */
function parseMetaNative(raw: string): { name: string; description: string } | null {
  const syms = skillMetaNative();
  if (!syms) return null;
  const content = skillMetaEncoder.encode(raw);
  let cap = 4096;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = new Uint8Array(cap);
    const written = new Uint32Array(1);
    const needed = new Uint32Array(1);
    const status = syms.sift_skill_parse(content, content.length, out, cap, written, needed);
    if (status === 1) return null; // not a skill (no frontmatter / no name)
    if (status === 0) {
      return JSON.parse(skillMetaDecoder.decode(out.subarray(0, written[0]))) as {
        name: string;
        description: string;
      };
    }
    cap = Math.max(needed[0], cap * 2); // output too small — grow once and retry
  }
  return null;
}

/** Skill name/description: native (Zig) when the dylib is loaded, else the TS fallback. */
function readSkillMeta(raw: string): { name: string; description: string } | null {
  const native = parseMetaNative(raw);
  if (native) return native;
  // A null from the native path is authoritative ONLY when the dylib actually
  // ran; if it's unavailable (node/jest), parse with the TS fallback instead.
  if (skillMetaNative()) return null;
  const fm = parseFrontmatter(raw);
  const name = (fm.name || "").trim();
  if (!name) return null;
  return { name, description: (fm.description || "").trim() };
}

/**
 * Minimal frontmatter reader. Extracts top-level `key: value` scalars from the
 * leading `---` block — enough for `name` and `description`. Tolerates (ignores)
 * the list/nested fields skills use (triggers, allowed-tools, metadata, etc.).
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const block = frontmatterBlock(raw);
  if (block == null) return {};
  const out: Record<string, string> = {};
  for (const rawLine of block.split("\n")) {
    // Drop a trailing CR so CRLF files parse identically to LF — JS regex `.`/`$`
    // don't span `\r`, so without this `name: x\r` fails to match (the native
    // skill_meta.zig parser strips it too; the two must stay in lockstep).
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // nested / list item — skip
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (!value) continue; // a key introducing a block (e.g. `triggers:`) — skip
    value = value.replace(/^["']/, "").replace(/["']$/, "");
    out[key] = value;
  }
  return out;
}

function frontmatterBlock(raw: string): string | null {
  const normalized = raw.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return null;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return null;
  return normalized.slice(normalized.indexOf("\n") + 1, end);
}

function stripFrontmatter(raw: string): string {
  const normalized = raw.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return normalized;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized;
  const afterClose = normalized.indexOf("\n", end + 1);
  return afterClose === -1 ? "" : normalized.slice(afterClose + 1);
}

function listBundledFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_BUNDLED_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_BUNDLED_FILES) break;
      if (entry === SKILL_FILE && prefix === "") continue;
      if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue;
      const child = join(current, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (isDir(child)) walk(child, rel, depth + 1);
      else files.push(rel);
    }
  };
  walk(dir, "", 0);
  return files.sort();
}
