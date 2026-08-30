import {afterEach, describe, expect, it} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  boundToolOutput,
  cleanupToolOutputSpillSession,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS,
  DEFAULT_TOOL_OUTPUT_SPILL_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_SPILL_MAX_FILES,
  DEFAULT_TOOL_OUTPUT_SPILL_ORPHAN_GRACE_MS,
  discardToolOutputSpill,
  garbageCollectToolOutputSpills,
  MIN_TOOL_OUTPUT_MAX_BYTES,
  MIN_TOOL_OUTPUT_MAX_LINES,
  resolveToolOutputSpillPolicy,
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
    expect(DEFAULT_TOOL_OUTPUT_SPILL_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(DEFAULT_TOOL_OUTPUT_SPILL_MAX_FILES).toBe(256);
    expect(DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_TOOL_OUTPUT_SPILL_ORPHAN_GRACE_MS).toBe(5 * 60 * 1000);
    expect(resolveToolOutputSpillPolicy({maxBytes: Number.NaN, maxFiles: 0, maxAgeMs: -1})).toEqual({
      maxBytes: DEFAULT_TOOL_OUTPUT_SPILL_MAX_BYTES,
      maxFiles: DEFAULT_TOOL_OUTPUT_SPILL_MAX_FILES,
      maxAgeMs: DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS,
      orphanGraceMs: DEFAULT_TOOL_OUTPUT_SPILL_ORPHAN_GRACE_MS,
    });
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
    expect(statSync(spillDir).mode & 0o777).toBe(0o700);
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

  it("enforces quota without deleting referenced spills or the new spill", () => {
    const spillDir = tempSpillDir();
    const first = boundToolOutput(`first:${"a".repeat(3000)}`, {
      maxBytes: 1024,
      spillDir,
      spillPolicy: {maxBytes: 7000, maxFiles: 2, orphanGraceMs: 0},
      protectedSpillRefs: [],
    }, "first");
    expect(first.fullOutputRef).toBeDefined();

    const second = boundToolOutput(`second:${"b".repeat(3000)}`, {
      maxBytes: 1024,
      spillDir,
      spillPolicy: {maxBytes: 7000, maxFiles: 2, orphanGraceMs: 0},
      protectedSpillRefs: [first.fullOutputRef!],
    }, "second");
    expect(second.fullOutputRef).toBeDefined();
    expect(existsSync(first.fullOutputRef!)).toBe(true);
    expect(existsSync(second.fullOutputRef!)).toBe(true);

    const refused = boundToolOutput(`third:${"c".repeat(3000)}`, {
      maxBytes: 1024,
      spillDir,
      spillPolicy: {maxBytes: 7000, maxFiles: 2, orphanGraceMs: 0},
      protectedSpillRefs: [first.fullOutputRef!, second.fullOutputRef!],
    }, "third");
    expect(refused.fullOutputRef).toBeUndefined();
    expect(existsSync(first.fullOutputRef!)).toBe(true);
    expect(existsSync(second.fullOutputRef!)).toBe(true);
    expect(readdirSync(spillDir)).toHaveLength(2);
  });

  it("garbage-collects expired and abandoned spills after the grace period", () => {
    const spillDir = tempSpillDir();
    const expired = join(spillDir, "expired.json");
    const orphan = join(spillDir, "orphan.json");
    const protectedPath = join(spillDir, "protected.json");
    for (const path of [expired, orphan, protectedPath]) {
      writeFileSync(path, path, {mode: 0o600, flag: "wx"});
    }
    const nowMs = Date.now();
    utimesSync(expired, new Date(nowMs - 20_000), new Date(nowMs - 20_000));
    utimesSync(orphan, new Date(nowMs - 10_000), new Date(nowMs - 10_000));
    utimesSync(protectedPath, new Date(nowMs - 10_000), new Date(nowMs - 10_000));

    const result = garbageCollectToolOutputSpills({
      spillDir,
      policy: {maxAgeMs: 15_000, orphanGraceMs: 5000},
      protectedPaths: [protectedPath],
      referencesComplete: true,
      nowMs,
    });
    expect(result.removed).toBe(2);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(protectedPath)).toBe(true);
  });

  it("does not collect a fresh orphan inside the crash-recovery grace period", () => {
    const spillDir = tempSpillDir();
    const fresh = join(spillDir, "fresh.json");
    writeFileSync(fresh, "fresh", {mode: 0o600, flag: "wx"});
    const nowMs = Date.now();
    const result = garbageCollectToolOutputSpills({
      spillDir,
      policy: {maxAgeMs: 60_000, orphanGraceMs: 5000},
      protectedPaths: [],
      referencesComplete: true,
      reserveBytes: 100,
      nowMs,
    });
    expect(result.removed).toBe(0);
    expect(result.withinQuota).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it("refuses quota reserve rather than deleting a fresh unjournaled spill", () => {
    const spillDir = tempSpillDir();
    const fresh = join(spillDir, "in-flight.json");
    writeFileSync(fresh, "x".repeat(100), {mode: 0o600, flag: "wx"});
    const result = garbageCollectToolOutputSpills({
      spillDir,
      policy: {maxBytes: 150, maxFiles: 2, orphanGraceMs: 5000},
      protectedPaths: [],
      referencesComplete: true,
      reserveBytes: 100,
      reserveFiles: 1,
      nowMs: Date.now(),
    });
    expect(result.withinQuota).toBe(false);
    expect(result.removed).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it("discards only a direct spill child after journal append failure", () => {
    const spillDir = tempSpillDir();
    const spill = boundToolOutput("x".repeat(10_000), {maxBytes: 1024, spillDir}, "failed-append");
    expect(spill.fullOutputRef).toBeDefined();
    expect(discardToolOutputSpill(spill.fullOutputRef!, spillDir)).toBe(true);
    expect(existsSync(spill.fullOutputRef!)).toBe(false);
    expect(discardToolOutputSpill(join(spillDir, "..", "outside.json"), spillDir)).toBe(false);
  });

  it("removes a session spill directory deterministically", () => {
    const spillDir = tempSpillDir();
    const spill = boundToolOutput("x".repeat(10_000), {maxBytes: 1024, spillDir}, "session-delete");
    expect(spill.fullOutputRef).toBeDefined();
    expect(cleanupToolOutputSpillSession(spillDir)).toBe(true);
    expect(existsSync(spillDir)).toBe(false);
    expect(cleanupToolOutputSpillSession(spillDir)).toBe(true);
  });

  it("refuses session cleanup without deleting owned spills when foreign files exist", () => {
    const spillDir = tempSpillDir();
    const spill = boundToolOutput("x".repeat(10_000), {maxBytes: 1024, spillDir}, "foreign-guard");
    expect(spill.fullOutputRef).toBeDefined();
    const foreign = join(spillDir, "keep.txt");
    writeFileSync(foreign, "foreign", {mode: 0o600, flag: "wx"});

    expect(cleanupToolOutputSpillSession(spillDir)).toBe(false);
    expect(existsSync(spill.fullOutputRef!)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it("repairs directory/file permissions without mutating prior spill bytes", () => {
    const spillDir = tempSpillDir();
    chmodSync(spillDir, 0o755);
    const first = boundToolOutput(`first:${"a".repeat(10_000)}`, {maxBytes: 1024, spillDir}, "immutable");
    expect(first.fullOutputRef).toBeDefined();
    const original = readFileSync(first.fullOutputRef!);
    chmodSync(first.fullOutputRef!, 0o644);
    const second = boundToolOutput(`second:${"b".repeat(10_000)}`, {
      maxBytes: 1024,
      spillDir,
      protectedSpillRefs: [first.fullOutputRef!],
    }, "immutable");
    expect(second.fullOutputRef).toBeDefined();
    expect(readFileSync(first.fullOutputRef!)).toEqual(original);
    expect(statSync(spillDir).mode & 0o777).toBe(0o700);
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
