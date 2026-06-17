/**
 * Tests for the skills loader: discovery across project/user/builtin roots,
 * frontmatter parsing, precedence/dedupe, and lazy body loading.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  discoverSkills,
  formatSkillsForPrompt,
  formatSkillsList,
  loadSkill,
} from "../skillsEngine";

const tmpRoots: string[] = [];

function makeSkill(root: string, ns: string, name: string, frontmatter: string, body = "Body text."): void {
  const dir = join(root, ns, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "sift-skills-"));
  tmpRoots.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  it("finds skills under .claude/skills and .codex/skills in the project root", () => {
    const project = tempRoot();
    makeSkill(project, ".claude", "alpha", "name: alpha\ndescription: Alpha skill");
    makeSkill(project, ".codex", "beta", "name: beta\ndescription: Beta skill");
    const home = tempRoot(); // empty user home

    const skills = discoverSkills({ projectRoot: project, cwd: project, home, builtinDir: join(tempRoot(), "none") });
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    expect(skills.every((s) => s.source === "project")).toBe(true);
  });

  it("ignores list/nested frontmatter fields but keeps name+description (gstack shape)", () => {
    const project = tempRoot();
    makeSkill(
      project,
      ".claude",
      "gstack-codex",
      [
        "name: gstack-codex",
        "preamble-tier: 3",
        "version: 1.0.0",
        "description: OpenAI Codex CLI wrapper — three modes. (gstack)",
        "triggers:",
        "  - codex review",
        "  - second opinion",
        "allowed-tools:",
        "  - Bash",
      ].join("\n"),
    );
    const skills = discoverSkills({ projectRoot: project, cwd: project, home: tempRoot(), builtinDir: join(tempRoot(), "none") });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("gstack-codex");
    expect(skills[0].description).toBe("OpenAI Codex CLI wrapper — three modes. (gstack)");
  });

  it("parses scalar preflight metadata for dynamic context rendering", () => {
    const project = tempRoot();
    makeSkill(
      project,
      ".codex",
      "zig",
      [
        "name: zig",
        "description: Zig native work",
        "preflight: git_status,repo_map,code_search_hints",
        "preflight_query: zig native tui ffi",
        "preflight_max_chars: 5000",
      ].join("\n"),
    );
    const skills = discoverSkills({ projectRoot: project, cwd: project, home: tempRoot(), builtinDir: join(tempRoot(), "none") });
    expect(skills[0].preflight).toEqual({
      providers: ["git_status", "repo_map", "code_search_hints"],
      query: "zig native tui ffi",
      maxChars: 5000,
    });
  });

  it("lets project skills override user skills of the same name", () => {
    const project = tempRoot();
    const home = tempRoot();
    makeSkill(project, ".claude", "shared", "name: shared\ndescription: project version");
    // user-level ~/.claude/skills/shared
    mkdirSync(join(home, ".claude", "skills", "shared"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "skills", "shared", "SKILL.md"),
      "---\nname: shared\ndescription: user version\n---\nbody\n",
      "utf8",
    );

    const skills = discoverSkills({ projectRoot: project, cwd: project, home, builtinDir: join(tempRoot(), "none") });
    const shared = skills.find((s) => s.name === "shared");
    expect(shared?.source).toBe("project");
    expect(shared?.description).toBe("project version");
  });

  it("skips a SKILL.md with no name", () => {
    const project = tempRoot();
    makeSkill(project, ".claude", "nameless", "description: has no name");
    const skills = discoverSkills({ projectRoot: project, cwd: project, home: tempRoot(), builtinDir: join(tempRoot(), "none") });
    expect(skills).toHaveLength(0);
  });

  it("discovers the built-in mermaid skill shipped with the package", () => {
    // No overrides → real builtin dir is scanned.
    const skills = discoverSkills({ projectRoot: join(tempRoot(), "empty"), cwd: join(tempRoot(), "empty"), home: tempRoot() });
    const mermaid = skills.find((s) => s.name === "mermaid");
    expect(mermaid?.source).toBe("builtin");
    expect(mermaid?.description.toLowerCase()).toContain("mermaid");
  });
});

describe("loadSkill", () => {
  it("returns the body with frontmatter stripped and lists bundled files", () => {
    const project = tempRoot();
    const dir = join(project, ".claude", "skills", "withfiles");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: withfiles\ndescription: d\n---\n\nHello body.\n", "utf8");
    writeFileSync(join(dir, "scripts", "run.sh"), "echo hi\n", "utf8");

    const skills = discoverSkills({ projectRoot: project, cwd: project, home: tempRoot(), builtinDir: join(tempRoot(), "none") });
    const loaded = loadSkill("withfiles", skills);
    expect(loaded?.body).toBe("Hello body.");
    expect(loaded?.files).toContain("scripts/run.sh");
  });

  it("returns null for an unknown skill", () => {
    expect(loadSkill("nope", [])).toBeNull();
  });
});

describe("formatting", () => {
  it("renders an empty prompt section when there are no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  it("includes name + description lines in the prompt section", () => {
    const out = formatSkillsForPrompt([
      { name: "mermaid", description: "draw diagrams", path: "/x", dir: "/", source: "builtin" },
    ]);
    expect(out).toContain("## Skills");
    expect(out).toContain("- mermaid: draw diagrams");
  });

  it("groups the /skills listing by source", () => {
    const out = formatSkillsList([
      { name: "a", description: "x", path: "/", dir: "/", source: "project" },
      { name: "b", description: "y", path: "/", dir: "/", source: "builtin" },
    ]);
    expect(out).toContain("[project]");
    expect(out).toContain("[builtin]");
  });
});

// Cross-agent skills (plan, mermaid) must be reachable by Codex, which scans the
// repo's .agents/skills root. We expose them there as symlinks to the canonical
// builtin dirs; this guard fails if a symlink is deleted or drifts so the skills
// silently stop being advertised to Codex again.
describe("repo .agents/skills cross-agent symlinks (drift guard)", () => {
  // test file → interactive-tui → exf-cli → packages → repo root
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const canonicalDir = fileURLToPath(new URL("../skills", import.meta.url));

  for (const name of ["plan", "mermaid"]) {
    it(`.agents/skills/${name} symlinks to the canonical builtin skill`, () => {
      const link = join(repoRoot, ".agents", "skills", name);
      expect(existsSync(link)).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(canonicalDir, name)));
      // and the link actually resolves to a loadable SKILL.md
      expect(existsSync(join(link, "SKILL.md"))).toBe(true);
    });
  }
});
