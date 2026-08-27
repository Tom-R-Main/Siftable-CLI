import {afterEach, describe, expect, it} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {installStagedRuntime} from "../scripts/build-packaged-runtime.mjs";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sift-packaged-runtime-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, {recursive: true, force: true});
  }
});

describe("packaged runtime installation", () => {
  it("atomically replaces the prior runtime and removes its backup", () => {
    const root = temporaryRoot();
    const runtime = join(root, "runtime");
    const staged = join(root, "staged");
    mkdirSync(runtime);
    mkdirSync(staged);
    writeFileSync(join(runtime, "marker.txt"), "old\n");
    writeFileSync(join(staged, "marker.txt"), "new\n");

    installStagedRuntime(staged, runtime);

    expect(readFileSync(join(runtime, "marker.txt"), "utf8")).toBe("new\n");
    expect(existsSync(staged)).toBe(false);
    expect(readdirSync(root)).toEqual(["runtime"]);
  });

  it("restores the prior runtime when staged installation fails", () => {
    const root = temporaryRoot();
    const runtime = join(root, "runtime");
    const missingStage = join(root, "missing-stage");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "marker.txt"), "preserve me\n");

    expect(() => installStagedRuntime(missingStage, runtime)).toThrow();

    expect(readFileSync(join(runtime, "marker.txt"), "utf8")).toBe("preserve me\n");
    expect(readdirSync(root)).toEqual(["runtime"]);
  });
});
