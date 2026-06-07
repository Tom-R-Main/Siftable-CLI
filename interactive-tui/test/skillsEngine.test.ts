/**
 * Tests for the skills loader: discovery across project/user/builtin roots,
 * frontmatter parsing, precedence/dedupe, and lazy body loading.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
