/**
 * Tests for the cell-render bridge.
 *
 * `extractMermaidBlocks` is pure and always tested. The render functions are
 * exercised only when the `cell-render` binary is locatable, so the suite stays
 * green on machines without the image-to-ascii repo built.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  extractMermaidBlocks,
  renderMermaidSource,
  resolveCellRenderBin,
} from "../cellRender";

describe("extractMermaidBlocks", () => {
  it("returns nothing for prose with no fenced mermaid", () => {
    expect(extractMermaidBlocks("just some text\n\n```ts\nconst x = 1;\n```")).toEqual([]);
  });

  it("extracts a single mermaid block, stripping fences and info string", () => {
    const md = "Here is a diagram:\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nDone.";
    expect(extractMermaidBlocks(md)).toEqual(["flowchart TD\n  A --> B"]);
  });

  it("extracts multiple blocks in source order", () => {
    const md = [
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "text between",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hi",
      "```",
    ].join("\n");
    expect(extractMermaidBlocks(md)).toEqual([
      "flowchart LR\n  A --> B",
      "sequenceDiagram\n  A->>B: hi",
    ]);
  });

  it("handles tilde fences and a trailing info string", () => {
    const md = "~~~mermaid theme=dark\nstateDiagram-v2\n  [*] --> S\n~~~";
    expect(extractMermaidBlocks(md)).toEqual(["stateDiagram-v2\n  [*] --> S"]);
  });

  it("ignores empty mermaid blocks", () => {
    expect(extractMermaidBlocks("```mermaid\n\n```")).toEqual([]);
  });
});

describe("renderMermaidSource (requires cell-render binary)", () => {
  const available = resolveCellRenderBin() !== null;
  const maybe = available ? it : it.skip;

  maybe("renders a flowchart to terminal cells", () => {
    const result = renderMermaidSource("flowchart TD\n  A[Start] --> B[Done]", {
      glyph: "ascii",
      color: "none",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Start");
    expect(result.text).toContain("Done");
  });

  maybe("reports a precise diagnostic on a syntax error", () => {
    const result = renderMermaidSource("flowchart TD\n  A --> ", { color: "none" });
    expect(result.ok).toBe(false);
    expect(result.error && result.error.length).toBeGreaterThan(0);
  });

  it("returns a clear error (not a throw) on empty source", () => {
    const result = renderMermaidSource("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("rewrites the staged temp path out of inline syntax errors", () => {
    const result = renderMermaidSource("plan");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mermaid:");
    expect(result.error).not.toContain("/var/folders");
    expect(result.error).not.toContain("diagram.mmd");
  });
});

describe("builtin skill examples (requires cell-render binary)", () => {
  const available = resolveCellRenderBin() !== null;
  const maybe = available ? it : it.skip;

  // Each skill claims every example is verified-renderable; enforce it so a
  // skill can never drift to syntax outside the renderer's supported subset.
  for (const skill of ["mermaid", "plan"]) {
    maybe(`every \`\`\`mermaid block in the ${skill} skill renders cleanly`, () => {
      const md = readFileSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), "utf8");
      const blocks = extractMermaidBlocks(md);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const result = renderMermaidSource(block, { color: "none" });
        if (!result.ok) throw new Error(`${skill} example failed: ${result.error}\n---\n${block}`);
        expect(result.ok).toBe(true);
      }
    });
  }
});
