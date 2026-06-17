import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSkillPreflightContext,
  matchPreflightSkills,
  renderSkillPreflight,
} from "../skillPreflight";
import type { SkillInfo } from "../skillsEngine";

const tmpRoots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sift-preflight-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function zigSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "zig",
    description: "Build, review, debug, migrate, or optimize Zig code.",
    path: "/skills/zig/SKILL.md",
    dir: "/skills/zig",
    source: "user",
    preflight: {
      providers: ["git_status", "repo_map", "sift_work", "recent_notes", "code_search_hints", "env_schema_names"],
      query: "zig native tui ffi",
      maxChars: 8000,
    },
    ...overrides,
  };
}

describe("skill preflight", () => {
  it("matches explicitly named and inferred skills", () => {
    const skills = [zigSkill(), { ...zigSkill({ name: "mermaid", description: "Render diagrams." }), preflight: undefined }];
    expect(matchPreflightSkills("$zig fix the native parser", skills).map((skill) => skill.name)).toContain("zig");
    expect(matchPreflightSkills("build.zig fails in the native TUI module", skills).map((skill) => skill.name)).toContain("zig");
  });

  it("renders bounded read-only context from providers", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "jest", build: "tsc" } }), "utf8");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".env.example"), "OPENAI_API_KEY=\nSIFT_WORKSPACE_ID=\n", "utf8");
    writeFileSync(join(root, ".env"), "SHOULD_NOT_APPEAR=secret\n", "utf8");

    const apiClient = {
      listWorkItems: async () => ({ statusCode: 200, data: { workItems: [{ title: "Native parser", status: "queued", assignedAlias: "codex" }] } }),
      listCodeRepositories: async () => ({ statusCode: 200, data: { repositories: [{ id: "repo-1", rootPath: root }] } }),
      searchCode: async () => ({ statusCode: 200, data: { results: [{ filePath: "interactive-tui/native/skill_meta.zig", startLine: 12, symbolName: "parseMeta" }] } }),
      searchNotes: async () => ({ statusCode: 200, data: { results: [{ title: "Zig note", snippet: "native parser boundary" }] } }),
    };

    const rendered = await renderSkillPreflight({
      userText: "$zig extend skill metadata",
      cwd: root,
      workspaceRoot: root,
      skills: [zigSkill()],
      apiClient,
    });

    expect(rendered.text).toContain("Matched skills:");
    expect(rendered.text).toContain("## sift_work");
    expect(rendered.text).toContain("Native parser");
    expect(rendered.text).toContain("skill_meta.zig");
    expect(rendered.text).toContain("OPENAI_API_KEY");
    expect(rendered.text).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("appends context to string and multimodal chat input without changing visible text", () => {
    const stringInput = appendSkillPreflightContext("fix zig", "context");
    expect(stringInput).toContain("<skill_preflight_context>");
    expect(stringInput).toContain("fix zig");

    const multi = appendSkillPreflightContext([{ type: "text", text: "fix zig" }, { type: "image", mime: "image/png", dataUrl: "data:" }], "context");
    expect(Array.isArray(multi)).toBe(true);
    expect(Array.isArray(multi) && multi[0].type === "text" ? multi[0].text : "").toContain("<skill_preflight_context>");
  });
});
