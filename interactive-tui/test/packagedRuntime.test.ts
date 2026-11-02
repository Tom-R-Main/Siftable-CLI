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

import {
  installStagedRuntime,
  nativeLibraryTargetFromProbe,
  stageNativeEngineLibraries,
} from "../scripts/build-packaged-runtime.mjs";

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

describe("nativeLibraryTargetFromProbe", () => {
  it("maps each native library format to its platform-arch key", () => {
    const cases: Array<[string, string, string]> = [
      ["Mach-O 64-bit dynamically linked shared library arm64", "libthread_engine.dylib", "darwin-arm64"],
      ["Mach-O 64-bit dynamically linked shared library x86_64", "libthread_engine.dylib", "darwin-x64"],
      ["ELF 64-bit LSB shared object, x86-64, version 1 (SYSV)", "libthread_engine.so", "linux-x64"],
      ["ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV)", "libthread_engine.so", "linux-arm64"],
      ["PE32+ executable (DLL) (console) x86-64, for MS Windows", "libthread_engine.dll", "win32-x64"],
      ["PE32+ executable (DLL) (console) Aarch64, for MS Windows", "libthread_engine.dll", "win32-arm64"],
    ];
    for (const [probe, filename, expected] of cases) {
      expect(nativeLibraryTargetFromProbe(probe, filename), filename).toBe(expected);
    }
  });

  it("rejects format/suffix mismatches and unidentifiable probes", () => {
    expect(() => nativeLibraryTargetFromProbe("ELF 64-bit LSB shared object, x86-64", "libthread_engine.dylib")).toThrow();
    expect(() => nativeLibraryTargetFromProbe("ASCII text", "libthread_engine.so")).toThrow();
    expect(() => nativeLibraryTargetFromProbe("ELF 64-bit LSB shared object, i386", "libthread_engine.so")).toThrow();
    expect(() => nativeLibraryTargetFromProbe("Mach-O 64-bit shared library arm64", "libthread_engine.bin")).toThrow();
  });
});

describe("stageNativeEngineLibraries", () => {
  it("fails when no thread_engine libraries exist", () => {
    const root = temporaryRoot();
    const nativeDir = join(root, "native");
    const staged = join(root, "staged");
    mkdirSync(nativeDir);
    mkdirSync(staged);
    writeFileSync(join(nativeDir, "unrelated.txt"), "not a library\n");

    expect(() => stageNativeEngineLibraries(nativeDir, staged)).toThrow(/libthread_engine/u);
    expect(readdirSync(staged)).toEqual([]);
  });

  // Requires a real library on disk so file(1) can identify it; skipped where
  // the host natives were never built (e.g. a clean checkout without zig).
  it.skipIf(!existsSync(join(__dirname, "..", "native", "libthread_engine.dylib"))
    && !existsSync(join(__dirname, "..", "native", "libthread_engine.so")))(
    "stages built libraries under platform-arch-keyed names", () => {
      const root = temporaryRoot();
      const staged = join(root, "staged");
      mkdirSync(staged);

      stageNativeEngineLibraries(join(__dirname, "..", "native"), staged);

      const stagedNames = readdirSync(staged);
      expect(stagedNames.length).toBeGreaterThan(0);
      for (const name of stagedNames) {
        expect(name).toMatch(/^libthread_engine\.(?:darwin|linux|win32)-(?:arm64|x64)\.(?:dylib|so|dll)$/u);
      }
      // The host platform's own key is always staged when the host lib exists.
      const hostSuffix = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
      if (existsSync(join(__dirname, "..", "native", `libthread_engine.${hostSuffix}`))) {
        expect(stagedNames).toContain(`libthread_engine.${process.platform}-${process.arch}.${hostSuffix}`);
      }
    },
  );
});
