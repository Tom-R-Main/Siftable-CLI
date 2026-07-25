import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchReadFiles,
  codeSearch,
  isSensitiveDiscoveryPath,
  searchLiteral,
} from "../fsEngine";
import { isSecretLikeExplorerPath } from "../explorer";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("authorized live code discovery", () => {
  it("uses one comprehensive secret denylist for direct and broad discovery", () => {
    const sensitivePaths = [
      ".npmrc",
      ".pypirc",
      "id_rsa",
      "service-account.json",
      "credentials.json",
      "secret.pem",
      "client.crt",
    ];

    for (const path of sensitivePaths) {
      expect(isSensitiveDiscoveryPath(path)).toBe(true);
      expect(isSecretLikeExplorerPath(path)).toBe(true);
    }
  });

  it("honors the worktree boundary, gitignore, secret exclusions, and result caps", async () => {
    const root = tempRoot("sift-live-code-");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "src/ignored.ts\n", "utf8");
    writeFileSync(join(root, "src", "auth.ts"), "export const authToken = verifySession();\n", "utf8");
    writeFileSync(join(root, "src", "ignored.ts"), "export const authToken = staleCopy();\n", "utf8");
    writeFileSync(join(root, "credentials.json"), "{\"authToken\":\"ultraSecretValue\"}\n", "utf8");

    const result = await codeSearch({
      root,
      authorizedRoot: root,
      intent: "authToken",
      queries: ["authToken"],
      maxFiles: 50,
      maxSpans: 1,
      respectGitignore: true,
    });

    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.path).toBe("src/auth.ts");
    expect(result.spans.some((span) => span.path.includes("ignored.ts"))).toBe(false);
    expect(result.spans.some((span) => span.path.includes("credentials.json"))).toBe(false);
    expect(result.stats.excludedSensitiveFiles).toBe(1);
    expect(result.stats.truncated).toBe(true);

    const literalResult = await searchLiteral(root, "ultraSecretValue", {
      excludeSensitive: true,
      respectGitignore: true,
    });
    expect(literalResult.matches).toHaveLength(0);
  });

  it("rejects an explicit root or symlink that escapes the authorized worktree", async () => {
    const authorizedRoot = tempRoot("sift-authorized-");
    const outsideRoot = tempRoot("sift-outside-");
    mkdirSync(join(outsideRoot, "src"), { recursive: true });
    writeFileSync(join(outsideRoot, "src", "outside.ts"), "export const outside = true;\n", "utf8");

    await expect(codeSearch({
      root: outsideRoot,
      authorizedRoot,
      intent: "outside",
    })).rejects.toThrow("escapes the authorized workspace");

    const link = join(authorizedRoot, "linked-outside");
    symlinkSync(outsideRoot, link, "dir");
    await expect(codeSearch({
      root: link,
      authorizedRoot,
      intent: "outside",
    })).rejects.toThrow("escapes the authorized workspace");

    const readResult = await batchReadFiles([{
      path: "linked-outside/src/outside.ts",
    }], authorizedRoot);
    expect(readResult.files[0]?.error).toContain("escapes the authorized workspace");
  });
});
