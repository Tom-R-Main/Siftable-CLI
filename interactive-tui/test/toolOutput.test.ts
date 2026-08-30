import {afterEach, describe, expect, it} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  boundToolOutput,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  MIN_TOOL_OUTPUT_MAX_BYTES,
  MIN_TOOL_OUTPUT_MAX_LINES,
} from "../agent-harness/framework/tool-output";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, {recursive: true, force: true});
});

function tempSpillDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sift-tool-output-"));
  cleanups.push(dir);
  return dir;
}

describe("boundToolOutput", () => {
  it("passes content under both caps through byte-identical", () => {
    const serialized = JSON.stringify({success: true, data: {finished: true}});
    const out = boundToolOutput(serialized, undefined, "call-1");
    expect(out).toEqual({
      content: serialized,
      truncated: false,
      byteCount: Buffer.byteLength(serialized),
      lineCount: 1,
    });
  });

  it("applies the documented defaults", () => {
    expect(DEFAULT_TOOL_OUTPUT_MAX_BYTES).toBe(50 * 1024);
    expect(DEFAULT_TOOL_OUTPUT_MAX_LINES).toBe(2000);
  });

  it("keeps head and tail lines of oversized multi-line content with a marker", () => {
    const lines = Array.from({length: 100}, (_, i) => `line-${i}`);
    const out = boundToolOutput(lines.join("\n"), {maxLines: 10, maxBytes: 4096}, "call-2");
    expect(out.truncated).toBe(true);
    expect(out.lineCount).toBe(100);
    expect(out.content).toContain("line-0"); // head survives
    expect(out.content).toContain("line-99"); // tail survives
    expect(out.content).not.toContain("line-50"); // middle elided
    expect(out.content).toContain("[tool output truncated:");
    expect(out.content).toContain("full output not retained");
    expect(out.content.split("\n").length).toBeLessThanOrEqual(11);
    expect(Buffer.byteLength(out.content)).toBeLessThanOrEqual(4096); // byte cap honored
  });

  it("byte-slices a single enormous line instead of eliding everything", () => {
    const serialized = JSON.stringify({success: true, data: {blob: "x".repeat(200_000)}});
    const out = boundToolOutput(serialized, {maxBytes: 8 * 1024}, "call-3");
    expect(out.truncated).toBe(true);
    expect(out.content).toContain('{"success":true'); // head of the JSON survives
    expect(out.content).toContain("[tool output truncated:");
    expect(Buffer.byteLength(out.content)).toBeLessThanOrEqual(8 * 1024); // cap honored, marker included
    expect(Buffer.byteLength(out.content)).toBeGreaterThan(4 * 1024); // not degenerate
  });

  it("treats non-finite and non-positive caps as the defaults, not as no cap", () => {
    const small = "z".repeat(10 * 1024);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      const out = boundToolOutput(small, {maxBytes: bad, maxLines: bad}, "call-bad");
      expect(out).toEqual({content: small, truncated: false, byteCount: 10 * 1024, lineCount: 1});
    }
    const big = "z".repeat(60 * 1024);
    const out = boundToolOutput(big, {maxBytes: Number.NaN}, "call-bad-big");
    expect(out.truncated).toBe(true); // default cap applies
    expect(Buffer.byteLength(out.content)).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_BYTES);
  });

  it("raises a cap too small to honor to the documented minimum and honors it", () => {
    const spillDir = tempSpillDir();
    const out = boundToolOutput("z".repeat(10_000), {maxBytes: 64, maxLines: 2, spillDir}, "call-tiny");
    expect(out.truncated).toBe(true);
    expect(out.fullOutputRef).toBeDefined();
    expect(Buffer.byteLength(out.content)).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_MAX_BYTES);
    expect(out.content.split("\n").length).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_MAX_LINES);
    expect(out.content).toContain("z".repeat(64)); // real content survives, not marker-only
  });

  it("spills the complete bytes to a 0600 file and references it in the marker", () => {
    const spillDir = tempSpillDir();
    const serialized = `big:${"y".repeat(100_000)}`;
    const out = boundToolOutput(serialized, {maxBytes: 4096, spillDir}, "call_4");
    expect(out.truncated).toBe(true);
    expect(out.fullOutputRef).toBeDefined();
    expect(out.content).toContain(`full output at ${out.fullOutputRef}`);
    expect(readFileSync(out.fullOutputRef!, "utf8")).toBe(serialized);
    expect(statSync(out.fullOutputRef!).mode & 0o777).toBe(0o600);
  });

  it("sanitizes hostile call ids in the spill filename", () => {
    const spillDir = tempSpillDir();
    const out = boundToolOutput("z".repeat(10_000), {maxBytes: 1024, spillDir}, "../../evil id");
    expect(out.fullOutputRef).toBeDefined();
    expect(out.fullOutputRef!.startsWith(spillDir)).toBe(true);
    expect(out.fullOutputRef).not.toContain("..");
  });

  it("never overwrites a spill file: a recurring call id gets a new immutable file", () => {
    const spillDir = tempSpillDir();
    const first = boundToolOutput(`first:${"a".repeat(10_000)}`, {maxBytes: 1024, spillDir}, "call-7");
    const second = boundToolOutput(`second:${"b".repeat(10_000)}`, {maxBytes: 1024, spillDir}, "call-7");
    expect(first.fullOutputRef).toBeDefined();
    expect(second.fullOutputRef).toBeDefined();
    expect(second.fullOutputRef).not.toBe(first.fullOutputRef);
    // The bytes named by the first journal event are still the first payload.
    expect(readFileSync(first.fullOutputRef!, "utf8")).toContain("first:");
    expect(readFileSync(second.fullOutputRef!, "utf8")).toContain("second:");
    expect(statSync(first.fullOutputRef!).mode & 0o777).toBe(0o600);
    expect(statSync(second.fullOutputRef!).mode & 0o777).toBe(0o600);
  });

  it("tolerates spill failure: truncation stands, no ref is claimed", () => {
    const out = boundToolOutput("z".repeat(10_000), {
      maxBytes: 1024,
      spillDir: "/dev/null/not-a-directory",
    }, "call-5");
    expect(out.truncated).toBe(true);
    expect(out.fullOutputRef).toBeUndefined();
    expect(out.content).toContain("full output not retained");
  });

  it("does not split a multibyte codepoint at the byte-slice boundary", () => {
    const serialized = "é".repeat(10_000); // 2 bytes per char, single line
    const out = boundToolOutput(serialized, {maxBytes: 1025}, "call-6");
    expect(out.truncated).toBe(true);
    expect(out.content).not.toContain("�");
    expect(Buffer.byteLength(out.content)).toBeLessThanOrEqual(1025);
  });
});
