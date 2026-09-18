/**
 * Command-prefix approval grants. The safety boundary is the tokenizer: only a
 * single simple command may become a grant, so every compound / redirected /
 * expanding form must tokenize to null and keep prompting.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { afterEach, describe, expect, it } from "bun:test";
import { CommandGrants, tokenizeCommand } from "../commandPolicy";
import { commandGrants, requestConfirm, resetBypass, resolveApproval, setConfirmListener, type ConfirmRequest } from "../confirmGate";
import { withExecutionContext, type ToolExecutionContext } from "../agent-harness/framework/execution-context";

afterEach(() => { resetBypass(); setConfirmListener(null); });

describe("tokenizeCommand", () => {
  it("splits simple commands with quotes and escapes", () => {
    expect(tokenizeCommand("git status")).toEqual(["git", "status"]);
    expect(tokenizeCommand("  npm   test  --  --grep 'a b'  ")).toEqual(["npm", "test", "--", "--grep", "a b"]);
    expect(tokenizeCommand('echo "hello world" it\\ works')).toEqual(["echo", "hello world", "it works"]);
    expect(tokenizeCommand('printf "%s\\n" x')).toEqual(["printf", "%s\\n", "x"]);
    expect(tokenizeCommand("grep -n 'a;b|c' file")).toEqual(["grep", "-n", "a;b|c", "file"]);
    expect(tokenizeCommand('echo "not $HOME"')).toBeNull(); // expansion inside double quotes
    expect(tokenizeCommand("echo '$HOME'")).toEqual(["echo", "$HOME"]); // literal inside single quotes
  });

  it("refuses every compound, redirected, expanding or malformed form", () => {
    for (const command of [
      "git status && rm -rf /", "git status; rm -rf /", "git status | sh", "git status || true", "git status & ",
      "cat < secret", "echo hi > file", "echo $(whoami)", "echo `whoami`", "echo $HOME", "(git status)",
      "git status # comment", "echo 'unterminated", 'echo "unterminated', "echo trailing\\", "", "   ",
      "git status\nrm -rf /",
    ]) {
      expect(tokenizeCommand(command), JSON.stringify(command)).toBeNull();
    }
  });

  it("refuses glob, brace, and tilde syntax even when quoted", () => {
    // Quoted and unquoted forms tokenize identically but the shell expands
    // only the unquoted form, so neither may become a reusable grant.
    for (const command of [
      "cat *.txt", "cat '*.txt'", 'cat "*.txt"', "rm build/*", "ls ?", "ls '?'",
      "cat file[12]", "cat 'file[12]'", "echo ~", "echo '~'", "echo {a,b}", "echo '{a,b}'",
      "grep 'a*b' file", "cat \\*.txt",
    ]) {
      expect(tokenizeCommand(command), JSON.stringify(command)).toBeNull();
    }
    // Untouched literals still grant.
    expect(tokenizeCommand("cat notes.txt")).toEqual(["cat", "notes.txt"]);
    expect(tokenizeCommand("echo 'a;b|c'")).toEqual(["echo", "a;b|c"]);
  });
});

describe("CommandGrants", () => {
  it("matches token prefixes per scope and ignores duplicates", () => {
    const grants = new CommandGrants();
    grants.grant("s1", ["git", "status"]);
    grants.grant("s1", ["git", "status"]);
    expect(grants.list("s1")).toEqual([["git", "status"]]);
    expect(grants.matches("s1", ["git", "status"])).toBe(true);
    expect(grants.matches("s1", ["git", "status", "--short"])).toBe(true);
    expect(grants.matches("s1", ["git"])).toBe(false);
    expect(grants.matches("s1", ["git", "push"])).toBe(false);
    expect(grants.matches("s1", ["gitx", "status"])).toBe(false); // whole tokens, not string prefixes
    expect(grants.matches("s2", ["git", "status"])).toBe(false);
    grants.grant("s1", []);
    expect(grants.list("s1")).toHaveLength(1);
  });

  it("refuses all-assignment grants but keeps env-prefixed command grants", () => {
    const grants = new CommandGrants();
    grants.grant("s1", ["FOO=bar"]);
    grants.grant("s1", ["FOO=bar", "BAZ=qux"]);
    expect(grants.list("s1")).toEqual([]);
    expect(grants.matches("s1", ["FOO=bar"])).toBe(false);
    expect(grants.matches("s1", ["FOO=bar", "anything"])).toBe(false);
    // A pinned command word stays grantable: extra args, not a new command.
    grants.grant("s1", ["FOO=bar", "npm", "test"]);
    expect(grants.list("s1")).toEqual([["FOO=bar", "npm", "test"]]);
    expect(grants.matches("s1", ["FOO=bar", "npm", "test", "--watch"])).toBe(true);
    expect(grants.matches("s1", ["FOO=bar", "npm"])).toBe(false);
    expect(grants.matches("s1", ["FOO=bar", "evil"])).toBe(false);
  });

  it("refuses launcher-only prefixes but keeps launcher-led commands", () => {
    const grants = new CommandGrants();
    for (const prefix of [
      ["env"], ["env", "FOO=bar"], ["env", "-i"], ["sudo"], ["sudo", "-u", "root"],
      ["sh"], ["bash", "-c"],
    ]) {
      grants.grant("s1", prefix);
    }
    expect(grants.list("s1")).toEqual([]);
    expect(grants.matches("s1", ["env", "sh", "-c", "evil"])).toBe(false);
    // The original prefix is preserved: matching still sees every word.
    grants.grant("s1", ["env", "FOO=bar", "npm", "test"]);
    expect(grants.list("s1")).toEqual([["env", "FOO=bar", "npm", "test"]]);
    expect(grants.matches("s1", ["env", "FOO=bar", "npm", "test", "--watch"])).toBe(true);
    expect(grants.matches("s1", ["env", "FOO=bar", "npm"])).toBe(false);
    expect(grants.matches("s1", ["env", "evil"])).toBe(false);
    // Flag operands are setup, not executables — but a real command stays grantable.
    grants.grant("s1", ["sudo", "-u", "root", "systemctl", "status"]);
    expect(grants.list("s1")).toHaveLength(2);
    expect(grants.matches("s1", ["sudo", "-u", "root", "systemctl", "status"])).toBe(true);
  });
});

describe.serial("requestConfirm command grants", () => {
  const ctx: ToolExecutionContext = { sessionId: "sess", turnId: "t", callId: "c", workspaceRoot: "/", sessionCwd: "/", approval: { policy: "ask", scopeId: "scope-a" } };
  const confirm = (path: string, context = ctx) => withExecutionContext(context, () => requestConfirm({ kind: "command", path, detail: "" }));
  function answering(decision: "allow" | "deny" | "always") {
    const requests: ConfirmRequest[] = [];
    setConfirmListener((request) => { requests.push(request); resolveApproval(request.id, decision); });
    return requests;
  }

  it("records 'always' as an argv grant and skips the prompt for prefix-matching reruns", async () => {
    let requests = answering("always");
    expect(await confirm("git status")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.allowAlways).not.toBe(false);
    expect(commandGrants.list("scope-a")).toEqual([["git", "status"]]);

    requests = answering("deny");
    expect(await confirm("git status --short")).toBe(true); // granted, listener not consulted
    expect(await confirm("git  status")).toBe(true);        // whitespace-insensitive via argv
    expect(requests).toHaveLength(0);
    expect(await confirm("git push")).toBe(false);          // different argv prompts (and is denied)
    expect(requests).toHaveLength(1);
  });

  it("never grants compound commands, even when the user answers 'always'", async () => {
    let requests = answering("always");
    expect(await confirm("git status && rm -rf /")).toBe(true); // approved once
    expect(requests[0]!.allowAlways).toBe(false);                // but the UI must not offer "always"
    expect(commandGrants.list("scope-a")).toEqual([]);
    requests = answering("deny");
    expect(await confirm("git status && rm -rf /")).toBe(false); // prompts again
    expect(requests).toHaveLength(1);
  });

  it("never grants bare assignments, even when the user answers 'always'", async () => {
    let requests = answering("always");
    expect(await confirm("FOO=bar")).toBe(true); // approved once
    expect(commandGrants.list("scope-a")).toEqual([]); // but no reusable grant is recorded
    requests = answering("deny");
    expect(await confirm("FOO=bar rm -rf /")).toBe(false); // prompts again: no widened grant
    expect(requests).toHaveLength(1);
  });

  it("never grants bare launchers, even when the user answers 'always'", async () => {
    let requests = answering("always");
    expect(await confirm("env")).toBe(true); // approved once
    expect(commandGrants.list("scope-a")).toEqual([]); // but no reusable grant is recorded
    requests = answering("deny");
    expect(await confirm("env sh -c 'rm -rf /'")).toBe(false); // prompts again: no widened grant
    expect(requests).toHaveLength(1);
  });

  it("does not let a simple-command grant cover a compound command sharing its prefix", async () => {
    answering("always");
    expect(await confirm("git status")).toBe(true);
    const requests = answering("deny");
    expect(await confirm("git status; rm -rf /")).toBe(false);
    expect(await confirm("git status | sh")).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("scopes grants to the authority scope", async () => {
    answering("always");
    expect(await confirm("git status")).toBe(true);
    const requests = answering("deny");
    const other = { ...ctx, approval: { policy: "ask" as const, scopeId: "scope-b" } };
    expect(await confirm("git status", other)).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("does not grant for write/edit kinds or for always-approval tools", async () => {
    let requests = answering("always");
    expect(await withExecutionContext(ctx, () => requestConfirm({ kind: "write", path: "/tmp/x", detail: "" }))).toBe(true);
    expect(commandGrants.list("scope-a")).toEqual([]);
    requests = answering("always");
    expect(await confirm("git status", { ...ctx, toolApproval: "always" })).toBe(true);
    expect(requests[0]!.allowAlways).toBe(false);
    expect(commandGrants.list("scope-a")).toEqual([]);
  });

  it("resetBypass clears grants", async () => {
    answering("always");
    expect(await confirm("git status")).toBe(true);
    resetBypass();
    expect(commandGrants.list("scope-a")).toEqual([]);
  });
});
