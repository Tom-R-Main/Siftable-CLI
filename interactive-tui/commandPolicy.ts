/**
 * Command-prefix approval grants — what "always allow" means for a shell command.
 *
 * This is approval policy, not confinement. A grant lets a repeated command skip
 * the prompt; it does not sandbox anything. To keep the grant meaningful, a
 * command only qualifies when it can be read as a single argv: quote-aware
 * word splitting with NO control operators, redirections, or expansions
 * outside quotes. Anything compound (`a && b`, `a | b`, `a; b`), redirected,
 * or subject to `$…`/backtick expansion tokenizes to `null` and must be
 * approved every time — we never split such a string and approve its parts.
 *
 * Glob, brace, and tilde syntax is rejected even inside quotes: executors run
 * the original string through `/bin/sh -c`, and quoted and unquoted forms
 * tokenize identically (`rm '*'` and `rm *` both read `["rm", "*"]`), so a
 * grant recorded for the quoted form would also approve the expanding form.
 * Commands carrying `* ? [ ~ {` in any token stay ungrantable and prompt
 * every time.
 *
 * A grant with no fixed executable is likewise ungrantable: a bare
 * assignment command (`FOO=bar`) tokenizes to `["FOO=bar"]`, and a bare
 * launcher (`env`, `sudo`, `sh`) tokenizes to itself, so recording either as
 * an "always" grant would prefix-match an arbitrary nested command
 * (`FOO=bar <anything>`, `env sh -c "…"`). Executors run the original string
 * through `/bin/sh -c`, where leading assignments and launchers are just
 * context for whatever follows. Grants must pin a real command word after
 * removing leading assignments, launcher words, and flags; `FOO=bar npm
 * test` and `env npm test` are grantable, `FOO=bar` and `env` are not.
 * The stored rule keeps the original prefix — normalization only removes
 * unsafe grant candidates, never widens matching.
 *
 * Rules are token prefixes: a rule `["git", "status"]` matches `git status`
 * and `git status --short`. The "always" decision records the exact argv of
 * the approved command; shorter prefixes are available to hosts that
 * configure them explicitly.
 */

const CONTROL_CHARS = new Set([";", "&", "|", "<", ">", "(", ")", "$", "`", "\n"]);

/**
 * Split a shell command into argv words if — and only if — it is a single
 * simple command. Returns `null` for compound commands, redirections,
 * expansions, comments, or unbalanced quotes.
 */
export function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null; else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === "\\") {
        const next = command[i + 1];
        if (next === undefined) return null;
        if (next === '"' || next === "\\" || next === "$" || next === "`") { current += next; i += 1; continue; }
        current += ch;
        continue;
      }
      if (ch === "$" || ch === "`") return null;
      current += ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (inToken) { tokens.push(current); current = ""; inToken = false; }
      continue;
    }
    if (CONTROL_CHARS.has(ch)) return null;
    if (ch === "#" && !inToken) return null;
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined || next === "\n") return null;
      current += next;
      i += 1;
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inToken = true; continue; }
    current += ch;
    inToken = true;
  }
  if (quote !== null) return null;
  if (inToken) tokens.push(current);
  if (tokens.length === 0) return null;
  // Shell expansion syntax (`* ? [ ~ {`) is ungrantable even when quoted: the
  // tokenizer strips quotes, so quoted and unquoted forms would share one
  // grant while the shell expands only the unquoted form at execution time.
  if (tokens.some((token) => /[*?\[{~]/.test(token))) return null;
  return tokens;
}

/** Per-scope command-prefix grants. Scopes are trusted authority scopes, never model input. */
export class CommandGrants {
  private readonly rules = new Map<string, string[][]>();

  /**
   * Record a prefix rule for a scope. Duplicate rules are ignored, as are
   * prefixes with no fixed executable: after removing leading assignments,
   * launcher words, and flags, a real command word must remain, or the rule
   * would prefix-match an arbitrary nested command (`env` → `env sh -c "…"`).
   * The original prefix is stored — normalization only refuses candidates.
   */
  grant(scope: string, prefix: readonly string[]): void {
    if (prefix.length === 0) return;
    if (!hasFixedExecutable(prefix)) return;
    const existing = this.rules.get(scope) ?? [];
    if (existing.some((rule) => sameTokens(rule, prefix))) return;
    existing.push([...prefix]);
    this.rules.set(scope, existing);
  }

  /** True when some rule for the scope is a token prefix of `argv`. */
  matches(scope: string, argv: readonly string[]): boolean {
    const rules = this.rules.get(scope);
    if (!rules) return false;
    return rules.some((rule) => rule.length <= argv.length && rule.every((token, index) => token === argv[index]));
  }

  list(scope: string): string[][] {
    return (this.rules.get(scope) ?? []).map((rule) => [...rule]);
  }

  clear(scope?: string): void {
    if (scope === undefined) this.rules.clear(); else this.rules.delete(scope);
  }
}

/** A leading `NAME=value` word: environment for the command, not the command itself. */
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * Words that run an arbitrary nested command instead of being one: a grant
 * pinning only these (plus assignments and flags) never pins what executes.
 */
const LAUNCHER_TOKENS = new Set([
  "env", "sudo", "doas", "su", "runuser", "xargs",
  "nice", "nohup", "stdbuf", "timeout",
  "sh", "bash", "dash", "zsh", "ksh", "fish",
]);

/**
 * True when the prefix pins a real command word past its setup words. Flags
 * consume their value (a flag's operand, like `root` in `sudo -u root`, is
 * not an executable), and a bare `--` ends setup: what follows is the
 * command line. Anything else stops the scan and counts as the command word.
 */
function hasFixedExecutable(prefix: readonly string[]): boolean {
  let index = 0;
  while (index < prefix.length) {
    const token = prefix[index]!;
    if (token === "--") { index += 1; break; }
    if (ASSIGNMENT_TOKEN.test(token) || LAUNCHER_TOKENS.has(token)) { index += 1; continue; }
    if (token.startsWith("-")) { index += 2; continue; }
    break;
  }
  return index < prefix.length;
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}
