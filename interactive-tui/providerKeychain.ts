/**
 * OS-keychain storage for first-party model provider API keys.
 *
 * `/key <provider> <key>` keeps working exactly as before (process env for
 * this session) and additionally remembers the key in the system keychain so
 * the next launch can pick it up without another paste. Autoload is silent
 * and best-effort: a missing entry, a locked keychain, or an unsupported
 * platform degrades to the old session-only behavior with no prompts.
 *
 * Secrets never touch argv, prefs.json, logs, or error text. macOS transfers
 * the secret over stdin to `security -i` batch mode; Linux pipes it over
 * stdin to `secret-tool`. Windows has no backend here and reports
 * unavailable.
 */
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { accessSync } from "node:fs";

const SERVICE = "io.siftable.cli.provider-keys";
const SECRET_TOOL = "/usr/bin/secret-tool";
const RUN_TIMEOUT_MS = 2000;
const MAX_OUTPUT = 4096;

/** Env-var-shaped account names only — never a path, flag, or shell metachar. */
function checkAccount(envVar: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(envVar)) {
    throw new Error(`Refusing keychain access for non-env-var account: ${envVar}`);
  }
}

/** Single-line token secrets only: the macOS batch channel is line-oriented. */
function checkSecret(secret: string): void {
  if (!secret) throw new Error("Refusing to remember an empty key");
  if (/[\s]/.test(secret) || secret.length > 512) {
    throw new Error("Refusing to remember a key that is not a single-line token");
  }
}

export interface KeychainRunner {
  (exe: string, args: string[], stdin?: string): { code: number | null; stdout: string; timedOut: boolean };
}

function defaultRun(exe: string, args: string[], stdin?: string): { code: number | null; stdout: string; timedOut: boolean } {
  try {
    const result = spawnSync(exe, args, {
      input: stdin,
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    const timedOut =
      result.signal === "SIGTERM" &&
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return {
      code: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      timedOut,
    };
  } catch {
    return { code: null, stdout: "", timedOut: false };
  }
}

/** Whether this machine has a usable keychain backend (no prompt, no I/O). */
export function providerKeychainAvailable(
  platform: string = process.platform,
  hasSecretTool: () => boolean = () => {
    try {
      accessSync(SECRET_TOOL, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): boolean {
  if (platform === "darwin") return true;
  if (platform === "linux") return hasSecretTool();
  return false;
}

export interface KeychainOpts {
  platform?: string;
  run?: KeychainRunner;
  /** Test override for backend availability. */
  available?: boolean;
}

function backend(opts: KeychainOpts): { platform: string; run: KeychainRunner } | null {
  const platform = opts.platform ?? process.platform;
  if (!(opts.available ?? providerKeychainAvailable(platform))) return null;
  return { platform, run: opts.run ?? defaultRun };
}

/**
 * Recall a remembered key. Returns null when unavailable, missing, or locked —
 * callers treat null as "no remembered key" and move on silently.
 */
export function recallProviderKey(envVar: string, opts: KeychainOpts = {}): string | null {
  checkAccount(envVar);
  const ready = backend(opts);
  if (!ready) return null;
  let out = "";
  if (ready.platform === "darwin") {
    const result = ready.run("security", ["find-generic-password", "-s", SERVICE, "-a", envVar, "-w"]);
    if (result.code !== 0) return null;
    out = result.stdout;
  } else {
    const result = ready.run(SECRET_TOOL, ["lookup", "service", SERVICE, "account", envVar]);
    if (result.code !== 0) return null;
    out = result.stdout;
  }
  const secret = out.replace(/[\r\n]+$/, "");
  return secret.length > 0 ? secret : null;
}

/** Remember (upsert) a key. Throws with a value-free message on failure. */
export function rememberProviderKey(envVar: string, secret: string, opts: KeychainOpts = {}): void {
  checkAccount(envVar);
  checkSecret(secret);
  const ready = backend(opts);
  if (!ready) throw new Error("System keychain is unavailable on this platform");
  let code: number | null = null;
  if (ready.platform === "darwin") {
    // Batch mode takes the command (including the secret) over stdin so the
    // key never appears in process arguments. Verified: store/lookup/delete
    // round-trip with exit 0.
    code = ready.run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${envVar} -w ${secret}\n`).code;
  } else {
    code = ready.run(SECRET_TOOL, ["store", "--label=Siftable provider API key", "service", SERVICE, "account", envVar], `${secret}\n`).code;
  }
  if (code !== 0) throw new Error("System keychain refused the key");
}

/**
 * Forget a remembered key. Returns "missing" when no entry existed
 * (idempotent success) and "deleted" when one was removed; throws a
 * value-free error when deletion itself fails so callers never report a
 * false success that autoload would silently undo.
 */
export function forgetProviderKey(envVar: string, opts: KeychainOpts = {}): "deleted" | "missing" {
  checkAccount(envVar);
  const ready = backend(opts);
  if (!ready) return "missing";
  if (ready.platform === "darwin") {
    const result = ready.run("security", ["delete-generic-password", "-s", SERVICE, "-a", envVar]);
    if (result.code === 0) return "deleted";
    if (result.code === 44) return "missing"; // errSecItemNotFound
    throw new Error("System keychain refused the deletion");
  }
  const pre = ready.run(SECRET_TOOL, ["lookup", "service", SERVICE, "account", envVar]);
  // A hung backend must not read as "missing": the key may still be stored.
  if (pre.timedOut) throw new Error("System keychain refused the deletion");
  if (pre.code !== 0) return "missing";
  const cleared = ready.run(SECRET_TOOL, ["clear", "service", SERVICE, "account", envVar]);
  if (cleared.code !== 0) throw new Error("System keychain refused the deletion");
  return "deleted";
}
