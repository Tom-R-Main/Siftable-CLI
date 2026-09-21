import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "bun:test";

import * as agentHarness from "../agent-harness";
import { createConversationMemory } from "../agent-harness/framework/memory";
import {
  digestJson,
  InMemorySessionEventStore,
  JsonlSessionEventStore,
  SessionConcurrencyError,
  SessionKernel,
  type ModelResponseSnapshot,
  type SessionEvent,
  type SessionEventContext,
  type SessionEventStore,
} from "../agent-harness/framework/session";
import { createStore } from "../agent-harness/framework/store";
import { listPendingSessionInstructions } from "../sessionMailbox";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const storeDataDirectory = join(testDirectory, "..", ".data");

function deterministicKernel(
  store: SessionEventStore = new InMemorySessionEventStore(),
  sessionId = `boundary-${randomUUID()}`,
): SessionKernel {
  let eventIndex = store.read(sessionId).length;
  return new SessionKernel({
    sessionId,
    store,
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
    eventIdFactory: () => `event-${++eventIndex}`,
  });
}

function requestReferences(
  session: SessionKernel,
  tools: Array<{ name: string } & Record<string, unknown>> = [],
) {
  return {
    history: {
      throughSeq: session.getEvents().length,
      messageCount: session.getHistory().length,
      sha256: digestJson(session.getHistory()),
    },
    systemPromptSha256: digestJson("boundary prompt"),
    tools: {
      names: tools.map((tool) => tool.name).sort(),
      sha256: digestJson(tools),
    },
  };
}

type TurnStepContext = SessionEventContext & { turnId: string; stepId: string };

function appendModelResponse(
  session: SessionKernel,
  context: TurnStepContext,
  data: ModelResponseSnapshot,
): void {
  const calls = data.toolCalls ?? (data.toolCall === undefined ? [] : [data.toolCall]);
  const tools = [...new Set(calls.map((call) => call.name))].map((name) => ({ name }));
  session.append({
    type: "model/request-prepared",
    data: requestReferences(session, tools),
    ...context,
  });
  session.append({ type: "model/response-received", data, ...context });
}

function uniqueStoreName(): string {
  return `agent-harness-boundary-${randomUUID()}`;
}

function removeStoreArtifacts(name: string): void {
  if (!existsSync(storeDataDirectory)) return;
  const prefix = `${name}.json`;
  for (const entry of readdirSync(storeDataDirectory)) {
    if (entry === prefix || entry.startsWith(`${prefix}.`)) {
      rmSync(join(storeDataDirectory, entry), { force: true });
    }
  }
}

async function waitForPaths(paths: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for: ${paths.join(", ")}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

describe("Siftable agent-harness public boundary", () => {
  it("exports only the TUI runtime primitives", () => {
    expect(Object.keys(agentHarness).sort()).toEqual([
      "JsonlSessionEventStore",
      "createChatAgent",
      "defineTool",
      "err",
      "ok",
    ]);
  });
});

describe("Siftable agent-harness durability boundary", () => {
  it("publishes concurrent cross-process mailbox instructions without loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "siftable-session-mailbox-"));
    const conversationKey = `mailbox-boundary-${randomUUID()}`;
    const mailboxModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "sessionMailbox.ts",
    )).href;
    const childSource = `
      import { enqueueSessionInstruction } from ${JSON.stringify(mailboxModuleUrl)};
      const [rootDir, conversationKey, instructionId] = process.argv.slice(1);
      enqueueSessionInstruction(conversationKey, \`instruction \${instructionId}\`, {
        rootDir,
        idFactory: () => instructionId,
      });
    `;
    const children = Array.from({length: 12}, (_, index) => {
      const instructionId = `mailbox-${index.toString().padStart(2, "0")}`;
      return spawn(process.execPath, [
        "--eval",
        childSource,
        root,
        conversationKey,
        instructionId,
      ], {
        cwd: join(testDirectory, "..", "..", "..", ".."),
        stdio: ["ignore", "ignore", "pipe"],
      });
    });

    try {
      const results = await Promise.all(children.map(waitForChild));
      expect(results).toEqual(Array.from({length: children.length}, () => ({
        code: 0,
        stderr: "",
      })));
      const pending = listPendingSessionInstructions(conversationKey, {rootDir: root});
      expect(pending).toHaveLength(children.length);
      expect(pending.map((record) => record.instructionId).sort()).toEqual(
        Array.from({length: children.length}, (_, index) => (
          `mailbox-${index.toString().padStart(2, "0")}`
        )),
      );
    } finally {
      for (const child of children) child.kill();
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("preserves the primary mailbox failure when close or unlink cleanup also fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "siftable-session-mailbox-cleanup-"));
    const mailboxModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "sessionMailbox.ts",
    )).href;
    const childSource = `
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      const [mailboxModuleUrl, rootDir, mode] = process.argv.slice(1);
      const realFs = { ...fs };
      const realCloseSync = fs.closeSync;
      let primaryRaised = false;
      mock.module("node:fs", () => ({
        ...realFs,
        ...(mode === "unlink"
          ? {
              linkSync() { throw new Error("primary-link"); },
              unlinkSync() { throw new Error("cleanup-unlink"); },
            }
          : {
              fchmodSync() {
                primaryRaised = true;
                throw new Error("primary-fchmod");
              },
              closeSync(fd) {
                if (primaryRaised) throw new Error("cleanup-close");
                return realCloseSync(fd);
              },
            }),
      }));
      const mailbox = await import(mailboxModuleUrl + "?cleanup=" + mode + "-" + Date.now());
      const expected = mode === "unlink" ? "primary-link" : "primary-fchmod";
      try {
        mailbox.enqueueSessionInstruction("cleanup-test", "instruction", {
          rootDir,
          idFactory: () => "cleanup-test",
        });
        console.error("mailbox enqueue unexpectedly succeeded");
        process.exitCode = 1;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== expected) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      }
    `;

    try {
      for (const mode of ["close", "unlink"]) {
        const child = spawn(process.execPath, [
          "--eval",
          childSource,
          mailboxModuleUrl,
          root,
          mode,
        ], {
          cwd: join(testDirectory, "..", "..", "..", ".."),
          stdio: ["ignore", "ignore", "pipe"],
        });
        const result = await waitForChild(child);
        expect(result.code, result.stderr).toBe(0);
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("distinguishes durable cleanup from indeterminate post-publication sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "siftable-session-mailbox-published-"));
    const mailboxModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "sessionMailbox.ts",
    )).href;
    const childSource = `
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      const [mailboxModuleUrl, rootDir, mode] = process.argv.slice(1);
      const realFs = { ...fs };
      let published = false;
      mock.module("node:fs", () => ({
        ...realFs,
        linkSync(existingPath, newPath) {
          realFs.linkSync(existingPath, newPath);
          published = true;
        },
        unlinkSync(path) {
          if (mode === "unlink" && published && String(path).endsWith(".tmp")) {
            throw new Error("post-publication-unlink");
          }
          return realFs.unlinkSync(path);
        },
        fsyncSync(fd) {
          if (mode === "fsync" && published) {
            throw new Error("post-publication-fsync");
          }
          return realFs.fsyncSync(fd);
        },
      }));
      const mailbox = await import(mailboxModuleUrl + "?published=" + mode + "-" + Date.now());
      const conversationKey = "published-test-" + mode;
      const instructionId = "published-test-" + mode;
      let record;
      try {
        record = mailbox.enqueueSessionInstruction(conversationKey, "instruction", {
          rootDir,
          idFactory: () => instructionId,
        });
        if (mode === "fsync") {
          console.error("post-publication fsync unexpectedly reported durable success");
          process.exitCode = 1;
        }
      } catch (error) {
        if (
          mode !== "fsync"
          || !(error instanceof mailbox.SessionMailboxPublicationIndeterminateError)
          || error.receipt.instructionId !== instructionId
        ) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
        record = error.receipt;
      }
      const pending = mailbox.listPendingSessionInstructions(conversationKey, { rootDir });
      if (record.instructionId !== instructionId || pending.length !== 1) {
        console.error(JSON.stringify({ record, pending }));
        process.exitCode = 1;
      }
    `;

    try {
      for (const mode of ["unlink", "fsync"]) {
        const child = spawn(process.execPath, [
          "--eval",
          childSource,
          mailboxModuleUrl,
          root,
          mode,
        ], {
          cwd: join(testDirectory, "..", "..", "..", ".."),
          stdio: ["ignore", "ignore", "pipe"],
        });
        const result = await waitForChild(child);
        expect(result.code, result.stderr).toBe(0);
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("rejects forged model replay and orphan tool history", () => {
    const session = deterministicKernel(new InMemorySessionEventStore(), "forged-replay");
    const context = { turnId: "forged-turn", stepId: "forged-step" };
    session.append({ type: "turn/started", data: {}, turnId: context.turnId });
    session.append({ type: "step/started", data: { index: 0 }, ...context });

    expect(() => session.append({
      type: "model/response-received",
      data: { text: "forged answer" },
      ...context,
    })).toThrow(/no preceding unmatched model request/);
    expect(() => session.appendMessage(
      { role: "assistant", content: "forged answer" },
      context,
    )).toThrow(/no recorded model response to project/);

    const persistedForgery: SessionEvent = {
      schemaVersion: 1,
      sessionId: session.getEvents()[0]!.sessionId,
      seq: session.getEvents().length + 1,
      eventId: "persisted-forged-response",
      timestamp: "2026-08-25T12:00:00.000Z",
      type: "model/response-received",
      data: { text: "persisted forgery" },
      ...context,
    };
    expect(
      () => new InMemorySessionEventStore([...session.getEvents(), persistedForgery]),
    ).toThrow(/no preceding unmatched model request/);

    appendModelResponse(session, context, { text: "no tool requested" });
    session.appendMessage({ role: "assistant", content: "no tool requested" }, context);
    const orphanCall = { id: "orphan-call", name: "write", args: {} };
    expect(() => session.append({
      type: "tool/call",
      data: { call: orphanCall },
      ...context,
    })).toThrow(/was not declared by an assistant response/);
    expect(() => session.append({
      type: "tool/result",
      data: {
        toolCallId: orphanCall.id,
        toolName: orphanCall.name,
        outcome: "succeeded",
        modelContent: "{}",
      },
      ...context,
    })).toThrow(/was not declared by an assistant response/);
  });

  it("rolls an unprojected later response back to its step continuation checkpoint", () => {
    const store = new InMemorySessionEventStore();
    const sessionId = "later-response-checkpoint";
    const session = deterministicKernel(store, sessionId);
    const turnId = "retained-tool-turn";
    const toolContext = { turnId, stepId: "retained-tool-step" };
    const finalContext = { turnId, stepId: "unprojected-final-step" };
    const call = { id: "retained-call", name: "inspect", args: { path: "file.ts" } };
    const stateA = {
      key: "openai.responses",
      continuationId: "response-a",
      fingerprint: digestJson("fingerprint-a"),
    };
    const stateB = {
      key: "openai.responses",
      continuationId: "response-b",
      fingerprint: digestJson("fingerprint-b"),
    };
    const toolContent = '{"success":true,"data":"retained"}';

    session.append({ type: "turn/started", data: {}, turnId });
    session.appendMessage({ role: "user", content: "inspect then summarize" }, { turnId });
    session.append({ type: "step/started", data: { index: 0 }, ...toolContext });
    appendModelResponse(session, toolContext, { toolCall: call });
    session.setAdapterSessionState(stateA, toolContext);
    session.appendMessage({
      role: "assistant",
      content: JSON.stringify(call.args),
      toolCallId: call.id,
      toolName: call.name,
    }, toolContext);
    session.append({ type: "tool/call", data: { call }, ...toolContext });
    session.append({ type: "tool/execution-started", data: { call }, ...toolContext });
    session.append({
      type: "tool/result",
      data: {
        toolCallId: call.id,
        toolName: call.name,
        outcome: "succeeded",
        result: { success: true, data: "retained" },
        modelContent: toolContent,
      },
      ...toolContext,
    });
    session.appendMessage({
      role: "tool",
      content: toolContent,
      toolCallId: call.id,
      toolName: call.name,
    }, toolContext);
    session.append({
      type: "step/completed",
      data: { outcome: "completed", reason: "tool_results" },
      ...toolContext,
    });

    session.append({ type: "step/started", data: { index: 1 }, ...finalContext });
    appendModelResponse(session, finalContext, { text: "summary that was never projected" });
    session.setAdapterSessionState(stateB, finalContext);

    expect(session.recoverInterrupted("crashed before assistant projection").map(
      (event) => event.type,
    )).toEqual(["adapter/state-updated", "step/completed", "turn/interrupted"]);
    expect(session.getAdapterSessionState("openai.responses")).toEqual(stateA);
    expect(session.getHistory().map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(session.getHistory().some(
      (message) => message.content === "summary that was never projected",
    )).toBe(false);

    const replayed = deterministicKernel(store, sessionId);
    expect(replayed.getAdapterSessionState("openai.responses")).toEqual(stateA);
    expect(replayed.getHistory()).toEqual(session.getHistory());
    expect(replayed.recoverInterrupted()).toHaveLength(0);
  });

  it("preserves a concurrent thread extension across repeated stale projections", () => {
    const name = uniqueStoreName();
    try {
      const projection = [{ role: "user" as const, content: "journal message" }];
      const staleWriter = createConversationMemory(createStore(name));
      expect(staleWriter.atomicMutations).toBe(true);
      staleWriter.replaceMessages("shared-thread", projection);

      createConversationMemory(createStore(name)).addMessage(
        "shared-thread",
        { role: "assistant", content: "concurrent extension" },
      );
      staleWriter.replaceMessages("shared-thread", projection);
      staleWriter.replaceMessages("shared-thread", projection);

      expect(createConversationMemory(createStore(name)).getRecent(
        "shared-thread",
        Number.MAX_SAFE_INTEGER,
      )).toEqual([
        ...projection,
        { role: "assistant", content: "concurrent extension" },
      ]);
    } finally {
      removeStoreArtifacts(name);
    }
  });

  it("serializes cross-process conversation mutations under the store lock", async () => {
    const name = uniqueStoreName();
    const barrierRoot = mkdtempSync(join(tmpdir(), "siftable-memory-atomic-"));
    const firstReady = join(barrierRoot, "first-ready");
    const firstRelease = join(barrierRoot, "first-release");
    const secondStarted = join(barrierRoot, "second-started");
    const secondEntered = join(barrierRoot, "second-entered");
    const storeModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "agent-harness",
      "framework",
      "store.ts",
    )).href;
    const memoryModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "agent-harness",
      "framework",
      "memory.ts",
    )).href;
    const childSource = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createStore } from ${JSON.stringify(storeModuleUrl)};
      import { createConversationMemory } from ${JSON.stringify(memoryModuleUrl)};
      const [name, role, firstReady, firstRelease, secondStarted, secondEntered] = process.argv.slice(1);
      const base = createStore(name);
      const store = new Proxy(base, {
        get(target, property, receiver) {
          if (property !== "mutate") return Reflect.get(target, property, receiver);
          return (id, mutation) => target.mutate(id, (current) => {
            if (role === "first") {
              writeFileSync(firstReady, "", { mode: 0o600 });
              const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
              while (!existsSync(firstRelease)) Atomics.wait(sleeper, 0, 0, 5);
            } else {
              writeFileSync(secondEntered, "", { mode: 0o600 });
            }
            return mutation(current);
          });
        },
      });
      if (role === "second") writeFileSync(secondStarted, "", { mode: 0o600 });
      createConversationMemory(store).addMessage("shared", { role: "user", content: role });
    `;
    const args = (role: string) => [
      "--eval",
      childSource,
      name,
      role,
      firstReady,
      firstRelease,
      secondStarted,
      secondEntered,
    ];
    const children: ChildProcess[] = [];

    try {
      createStore(name);
      const first = spawn(process.execPath, args("first"), {
        cwd: join(testDirectory, "..", "..", "..", ".."),
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(first);
      await waitForPaths([firstReady]);
      const second = spawn(process.execPath, args("second"), {
        cwd: join(testDirectory, "..", "..", "..", ".."),
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(second);
      await waitForPaths([secondStarted]);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(existsSync(secondEntered)).toBe(false);

      writeFileSync(firstRelease, "", { mode: 0o600 });
      for (const result of await Promise.all(children.map(waitForChild))) {
        expect(result.code, result.stderr).toBe(0);
      }
      expect(createConversationMemory(createStore(name)).getRecent(
        "shared",
        Number.MAX_SAFE_INTEGER,
      ).map((message) => message.content)).toEqual(["first", "second"]);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      removeStoreArtifacts(name);
      rmSync(barrierRoot, { recursive: true, force: true });
    }
  });

  it("bounds a synchronous store lock stall when a live owner remains wedged", async () => {
    const name = uniqueStoreName();
    const barrierRoot = mkdtempSync(join(tmpdir(), "siftable-store-timeout-"));
    const ready = join(barrierRoot, "ready");
    const storeModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "agent-harness",
      "framework",
      "store.ts",
    )).href;
    const childSource = `
      import { writeFileSync } from "node:fs";
      import { createStore } from ${JSON.stringify(storeModuleUrl)};
      const [name, ready] = process.argv.slice(1);
      const store = createStore(name);
      store.mutate("held", () => {
        writeFileSync(ready, "", { mode: 0o600 });
        const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        Atomics.wait(sleeper, 0, 0, 2_000);
        return { action: "set", value: 1, result: undefined };
      });
    `;
    const child = spawn(process.execPath, ["--eval", childSource, name, ready], {
      cwd: join(testDirectory, "..", "..", "..", ".."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const childExit = waitForChild(child);

    try {
      createStore(name);
      await waitForPaths([ready]);
      const started = performance.now();
      const timerDelay = new Promise<number>((resolve) => {
        setTimeout(() => resolve(performance.now() - started), 0);
      });

      expect(() => createStore(name).set("contender", 2)).toThrow(
        /timed out waiting for another process to update store/,
      );

      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(400);
      expect(elapsed).toBeLessThan(1_500);
      expect(await timerDelay).toBeLessThan(1_500);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await childExit;
      removeStoreArtifacts(name);
      rmSync(barrierRoot, {recursive: true, force: true});
    }
  });

  it("refreshes the lock wait window when a different live owner takes over", async () => {
    const name = uniqueStoreName();
    const barrierRoot = mkdtempSync(join(tmpdir(), "siftable-store-turnover-"));
    const ready = join(barrierRoot, "ready");
    const lockPath = join(storeDataDirectory, `${name}.json.lock`);
    const childSource = `
      import { linkSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
      import { basename, dirname, join } from "node:path";
      const [lockPath, ready] = process.argv.slice(1);
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const publish = (token) => {
        const claim = lockPath + "." + process.pid + "." + token + ".claim";
        writeFileSync(claim, JSON.stringify({ pid: process.pid, token }) + "\\n", { mode: 0o600 });
        linkSync(claim, lockPath);
        return claim;
      };
      const first = publish("11111111-1111-4111-8111-111111111111");
      writeFileSync(ready, "", { mode: 0o600 });
      const directory = dirname(lockPath);
      const lockName = basename(lockPath);
      while (!readdirSync(directory).some((entry) => (
        entry.startsWith(lockName + ".") &&
        entry.endsWith(".claim") &&
        join(directory, entry) !== first
      ))) Atomics.wait(sleeper, 0, 0, 1);
      Atomics.wait(sleeper, 0, 0, 350);
      const second = lockPath + "." + process.pid + ".22222222-2222-4222-8222-222222222222.claim";
      const handoff = second + ".handoff";
      writeFileSync(second, JSON.stringify({
        pid: process.pid,
        token: "22222222-2222-4222-8222-222222222222",
      }) + "\\n", { mode: 0o600 });
      linkSync(second, handoff);
      renameSync(handoff, lockPath);
      rmSync(first, { force: true });
      Atomics.wait(sleeper, 0, 0, 350);
      rmSync(lockPath, { force: true });
      rmSync(second, { force: true });
    `;
    const child = spawn(process.execPath, ["--eval", childSource, lockPath, ready], {
      cwd: join(testDirectory, "..", "..", "..", ".."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const childExit = waitForChild(child);

    try {
      createStore(name);
      await waitForPaths([ready]);
      const started = performance.now();
      createStore(name).set("contender", 2);
      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(600);
      expect(elapsed).toBeLessThan(1_500);
      expect((await childExit).code).toBe(0);
      expect(createStore<number>(name).get("contender")).toBe(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await childExit;
      removeStoreArtifacts(name);
      rmSync(barrierRoot, {recursive: true, force: true});
    }
  });

  it("keeps the cumulative lock wait bounded during sustained owner turnover", async () => {
    const name = uniqueStoreName();
    const barrierRoot = mkdtempSync(join(tmpdir(), "siftable-store-turnover-bound-"));
    const ready = join(barrierRoot, "ready");
    const lockPath = join(storeDataDirectory, `${name}.json.lock`);
    const childSource = `
      import { randomUUID } from "node:crypto";
      import { linkSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
      import { basename, dirname, join } from "node:path";
      const [lockPath, ready] = process.argv.slice(1);
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const publish = () => {
        const token = randomUUID();
        const claim = lockPath + "." + process.pid + "." + token + ".claim";
        writeFileSync(claim, JSON.stringify({ pid: process.pid, token }) + "\\n", { mode: 0o600 });
        return claim;
      };
      let current = publish();
      linkSync(current, lockPath);
      writeFileSync(ready, "", { mode: 0o600 });
      const directory = dirname(lockPath);
      const lockName = basename(lockPath);
      while (!readdirSync(directory).some((entry) => (
        entry.startsWith(lockName + ".") &&
        entry.endsWith(".claim") &&
        join(directory, entry) !== current
      ))) Atomics.wait(sleeper, 0, 0, 1);

      for (let index = 0; index < 20; index += 1) {
        Atomics.wait(sleeper, 0, 0, 150);
        const next = publish();
        const handoff = next + ".handoff";
        linkSync(next, handoff);
        renameSync(handoff, lockPath);
        rmSync(current, { force: true });
        current = next;
      }
      rmSync(lockPath, { force: true });
      rmSync(current, { force: true });
    `;
    const child = spawn(process.execPath, ["--eval", childSource, lockPath, ready], {
      cwd: join(testDirectory, "..", "..", "..", ".."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const childExit = waitForChild(child);

    try {
      createStore(name);
      await waitForPaths([ready]);
      const started = performance.now();
      expect(() => createStore(name).set("contender", 2)).toThrow(
        /timed out waiting to update store/,
      );
      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(1_800);
      expect(elapsed).toBeLessThan(2_500);
      expect((await childExit).code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await childExit;
      removeStoreArtifacts(name);
      rmSync(barrierRoot, {recursive: true, force: true});
    }
  });

  it("advances stale store recovery generations without replacing prior gates", () => {
    const name = uniqueStoreName();
    const store = createStore<number>(name);
    const lockPath = join(storeDataDirectory, `${name}.json.lock`);
    const reclaimPath = `${lockPath}.reclaim`;
    const staleOwner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const crashedReclaimer = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const crashedSuccessor = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(staleOwner.pid).toBeTruthy();
    expect(crashedReclaimer.pid).toBeTruthy();
    expect(crashedSuccessor.pid).toBeTruthy();
    const staleToken = "11111111-1111-4111-8111-111111111111";
    const reclaimToken = "22222222-2222-4222-8222-222222222222";
    const successorToken = "33333333-3333-4333-8333-333333333333";
    const staleClaim = `${lockPath}.${staleOwner.pid}.${staleToken}.claim`;
    const reclaimClaim = `${lockPath}.${crashedReclaimer.pid}.${reclaimToken}.claim`;
    const successorClaim = `${lockPath}.${crashedSuccessor.pid}.${successorToken}.claim`;

    try {
      writeFileSync(staleClaim, `${JSON.stringify({ pid: staleOwner.pid, token: staleToken })}\n`, {
        mode: 0o600,
      });
      linkSync(staleClaim, lockPath);
      writeFileSync(reclaimClaim, `${JSON.stringify({
        pid: crashedReclaimer.pid,
        token: reclaimToken,
      })}\n`, { mode: 0o600 });
      linkSync(reclaimClaim, reclaimPath);
      writeFileSync(successorClaim, `${JSON.stringify({
        pid: crashedSuccessor.pid,
        token: successorToken,
      })}\n`, { mode: 0o600 });
      linkSync(successorClaim, `${lockPath}.reclaim.${reclaimToken}`);
      const firstGateIdentity = statSync(reclaimPath);

      store.set("recovered", 1);

      expect(store.get("recovered")).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
      expect(statSync(reclaimPath).ino).toBe(firstGateIdentity.ino);
      expect(existsSync(`${lockPath}.reclaim.${reclaimToken}`)).toBe(true);
      expect(existsSync(`${lockPath}.reclaim.${successorToken}`)).toBe(false);
    } finally {
      removeStoreArtifacts(name);
    }
  });

  it.each([1, 3])("rejects a lock path with an invalid link count of %s", (linkCount) => {
    const name = uniqueStoreName();
    const store = createStore<number>(name);
    const lockPath = join(storeDataDirectory, `${name}.json.lock`);

    try {
      writeFileSync(lockPath, `${JSON.stringify({pid: process.pid, token: randomUUID()})}\n`, {
        mode: 0o600,
      });
      if (linkCount === 3) {
        linkSync(lockPath, `${lockPath}.fixture-claim`);
        linkSync(lockPath, `${lockPath}.unexpected-alias`);
      }
      expect(() => store.set("unsafe", 1)).toThrow(`inconsistent link count (${linkCount})`);
    } finally {
      removeStoreArtifacts(name);
    }
  });

  it.each(["descriptor-republish", "path-unlink", "path-republish", "path-retire"])(
    "retries a reclaim gate publication changed during inspection: %s", async (interleaving) => {
    const name = uniqueStoreName();
    const storeModuleUrl = pathToFileURL(join(
      testDirectory, "..", "agent-harness", "framework", "store.ts",
    )).href;
    const childSource = `
      import { randomUUID } from "node:crypto";
      import { spawnSync } from "node:child_process";
      import * as fs from "node:fs";
      import { join } from "node:path";
      import { mock } from "bun:test";
      const [storeModuleUrl, dataDirectory, name, interleaving] = process.argv.slice(1);
      fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      const lockPath = join(dataDirectory, name + ".json.lock");
      const stalePid = spawnSync(process.execPath, ["--eval", "process.exit(0)"]).pid;
      const staleToken = randomUUID();
      const staleClaim = lockPath + "." + stalePid + "." + staleToken + ".claim";
      fs.writeFileSync(staleClaim, JSON.stringify({ pid: stalePid, token: staleToken }), { mode: 0o600 });
      fs.linkSync(staleClaim, lockPath);
      const gatePath = lockPath + ".reclaim";
      const gateToken = randomUUID();
      const gateClaim = lockPath + "." + process.pid + "." + gateToken + ".claim";
      fs.writeFileSync(gateClaim, JSON.stringify({ pid: process.pid, token: gateToken }), { mode: 0o600 });
      fs.linkSync(gateClaim, gatePath);

      const realFs = { ...fs };
      let gateFd, interleaved = false, released = false;
      const releaseGate = () => {
        realFs.rmSync(gatePath, { force: true });
        realFs.rmSync(gateClaim, { force: true });
        released = true;
      };
      mock.module("node:fs", () => ({
        ...realFs,
        openSync(target, ...args) {
          const fd = realFs.openSync(target, ...args);
          if (target === gatePath && !interleaved) gateFd = fd;
          return fd;
        },
        fstatSync(fd, ...args) {
          if (fd === gateFd && !interleaved && interleaving === "descriptor-republish") {
            // The owner releases the gate, then republishes the same immutable
            // claim while this reader holds a descriptor to that exact inode.
            realFs.unlinkSync(gatePath);
            const detached = realFs.fstatSync(fd, ...args);
            if (detached.nlink !== 1) throw new Error("Fixture did not detach the gate");
            realFs.linkSync(gateClaim, gatePath);
            interleaved = true;
            return detached;
          }
          return realFs.fstatSync(fd, ...args);
        },
        lstatSync(target, ...args) {
          if (target === gatePath && !interleaved && interleaving !== "descriptor-republish") {
            // lstat can resolve the dentry before unlink but copy the inode's
            // link count afterwards. Return that exact inode with its new count.
            realFs.lstatSync(target, ...args);
            realFs.unlinkSync(gatePath);
            if (interleaving === "path-retire") releaseGate();
            const detached = realFs.fstatSync(gateFd);
            if (interleaving === "path-republish") realFs.linkSync(gateClaim, gatePath);
            interleaved = true;
            return detached;
          }
          const info = realFs.lstatSync(target, ...args);
          if (target === gateClaim && interleaved && !released) releaseGate();
          return info;
        },
        readFileSync(target, ...args) {
          const value = realFs.readFileSync(target, ...args);
          if (target === gateFd && interleaved && !released && interleaving === "descriptor-republish") {
            // Finish the live peer's recovery, allowing the next retry to win.
            releaseGate();
          }
          return value;
        },
      }));
      try {
        const { createStore } = await import(storeModuleUrl + "?gate-republish=" + Date.now());
        const store = createStore(name);
        store.set("recovered", 1);
        if (!interleaved || !released || store.get("recovered") !== 1) {
          throw new Error("Republished gate was not recovered");
        }
      } catch (error) {
        realFs.writeFileSync(lockPath + ".fixture-error", error instanceof Error ? error.message : String(error), { mode: 0o600 });
        process.exitCode = 1;
      } finally {
        for (const target of [staleClaim, lockPath, gateClaim, gatePath]) realFs.rmSync(target, { force: true });
      }
    `;
    const child = spawn(process.execPath, ["--eval", childSource, storeModuleUrl, storeDataDirectory, name, interleaving], {
      cwd: join(testDirectory, "..", "..", "..", ".."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const result = await waitForChild(child);
      const diagnosticPath = join(storeDataDirectory, `${name}.json.lock.fixture-error`);
      const diagnostic = existsSync(diagnosticPath) ? await Bun.file(diagnosticPath).text() : "";
      expect({...result, diagnostic}).toEqual({code: 0, stderr: "", diagnostic: ""});
      expect(createStore<number>(name).get("recovered")).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      removeStoreArtifacts(name);
    }
  });

  it("preserves lock inspection failures while still reporting standalone close failures", async () => {
    const storeModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "agent-harness",
      "framework",
      "store.ts",
    )).href;
    const childSource = `
      import { randomUUID } from "node:crypto";
      import * as fs from "node:fs";
      import { join } from "node:path";
      import { mock } from "bun:test";
      const [storeModuleUrl, dataDirectory, name, mode] = process.argv.slice(1);
      fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      const lockPath = join(dataDirectory, name + ".json.lock");
      const claimPath = lockPath + ".fixture";
      const owner = mode === "malformed"
        ? "{not-json"
        : mode === "invalid-owner"
          ? JSON.stringify({ pid: 0, token: "not-a-uuid" }) + "\\n"
          : JSON.stringify({ pid: process.pid, token: randomUUID() }) + "\\n";
      fs.writeFileSync(claimPath, owner, { mode: 0o600 });
      fs.linkSync(claimPath, lockPath);

      const realFs = { ...fs };
      let ownerRead = false;
      mock.module("node:fs", () => ({
        ...realFs,
        readFileSync(target, ...args) {
          if (typeof target === "number") ownerRead = true;
          return realFs.readFileSync(target, ...args);
        },
        closeSync(fd) {
          if (ownerRead) {
            ownerRead = false;
            throw new Error("cleanup-close");
          }
          return realFs.closeSync(fd);
        },
      }));

      try {
        const { createStore } = await import(storeModuleUrl + "?cleanup=" + mode + "-" + Date.now());
        createStore(name).set("blocked", 1);
        console.error("store mutation unexpectedly succeeded");
        process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const expected = mode === "malformed"
          ? "is malformed"
          : mode === "invalid-owner"
            ? "invalid process owner"
            : "could not close store lock";
        if (!message.includes(expected)) {
          console.error(message);
          process.exitCode = 1;
        }
      } finally {
        realFs.rmSync(claimPath, { force: true });
        realFs.rmSync(lockPath, { force: true });
      }
    `;

    for (const mode of ["valid", "malformed", "invalid-owner"]) {
      const name = uniqueStoreName();
      const child = spawn(process.execPath, [
        "--eval",
        childSource,
        storeModuleUrl,
        storeDataDirectory,
        name,
        mode,
      ], {
        cwd: join(testDirectory, "..", "..", "..", ".."),
        stdio: ["ignore", "ignore", "pipe"],
      });
      const result = await waitForChild(child);
      expect(result.code, result.stderr).toBe(0);
      removeStoreArtifacts(name);
    }
  });

  // Each independent round keeps the default test deadline; process startup
  // for all 48 contenders must not consume one shared five-second budget.
  it.each([1, 2, 3])("retries a concurrently released stale-recovery gate without reporting a cycle (round %i)", async () => {
    const contenders = 16;
    const storeModuleUrl = pathToFileURL(join(
      testDirectory,
      "..",
      "agent-harness",
      "framework",
      "store.ts",
    )).href;
    const childSource = `
      import { existsSync, writeFileSync } from "node:fs";
      import { createStore } from ${JSON.stringify(storeModuleUrl)};
      const [name, id, ready, start] = process.argv.slice(1);
      writeFileSync(ready, "", { mode: 0o600 });
      const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      while (!existsSync(start)) Atomics.wait(sleeper, 0, 0, 1);
      createStore(name).set(id, id);
    `;

    const name = uniqueStoreName();
    const barrierRoot = mkdtempSync(join(tmpdir(), "siftable-store-recovery-race-"));
    const start = join(barrierRoot, "start");
    const lockPath = join(storeDataDirectory, `${name}.json.lock`);
    const staleOwner = spawnSync(process.execPath, ["--eval", "process.exit(0)"]);
    const staleToken = randomUUID();
    const staleClaim = `${lockPath}.${staleOwner.pid}.${staleToken}.claim`;
    const children: ChildProcess[] = [];

    try {
      createStore(name);
      expect(staleOwner.pid).toBeTruthy();
      writeFileSync(staleClaim, `${JSON.stringify({
        pid: staleOwner.pid,
        token: staleToken,
      })}\n`, {mode: 0o600});
      linkSync(staleClaim, lockPath);

      const readyPaths = Array.from({length: contenders}, (_, index) => (
        join(barrierRoot, `ready-${index}`)
      ));
      for (let index = 0; index < contenders; index += 1) {
        children.push(spawn(process.execPath, [
          "--eval",
          childSource,
          name,
          `contender-${index}`,
          readyPaths[index]!,
          start,
        ], {
          cwd: join(testDirectory, "..", "..", "..", ".."),
          stdio: ["ignore", "ignore", "pipe"],
        }));
      }
      const childExits = children.map(waitForChild);
      await waitForPaths(readyPaths);
      writeFileSync(start, "", {mode: 0o600});

      const results = await Promise.all(childExits);
      const stderr = results.map((result) => result.stderr).filter(Boolean).join("\n");
      expect(results.map((result) => result.code), stderr).toEqual(
        Array.from({length: contenders}, () => 0),
      );
      expect(createStore<string>(name).entries().map(([id]) => id).sort()).toEqual(
        Array.from({length: contenders}, (_, index) => `contender-${index}`).sort(),
      );
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      removeStoreArtifacts(name);
      rmSync(barrierRoot, {recursive: true, force: true});
    }
  });

  it("serializes session lease recovery without unlinking another contender's gate", () => {
    const root = mkdtempSync(join(tmpdir(), "siftable-session-lease-"));
    const sessionId = "shared-session";
    const store = new JsonlSessionEventStore({ rootDir: root });
    const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
    const leasePath = join(root, `${digest}.lease`);
    const held = store.acquireLease(sessionId);

    try {
      expect(() => new JsonlSessionEventStore({ rootDir: root }).acquireLease(sessionId)).toThrow(
        SessionConcurrencyError,
      );
      held.release();

      const replacement = new JsonlSessionEventStore({ rootDir: root }).acquireLease(sessionId);
      replacement.release();
      expect(existsSync(leasePath)).toBe(false);

      const staleOwner = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      expect(staleOwner.pid).toBeTruthy();
      const staleToken = "44444444-4444-4444-8444-444444444444";
      const staleClaim = `${leasePath}.${staleOwner.pid}.${staleToken}.claim`;
      writeFileSync(staleClaim, `${JSON.stringify({
        pid: staleOwner.pid,
        token: staleToken,
      })}\n`, { mode: 0o600 });
      linkSync(staleClaim, leasePath);

      const gateToken = "55555555-5555-4555-8555-555555555555";
      const gateClaim = `${leasePath}.${process.pid}.${gateToken}.claim`;
      const reclaimGate = `${leasePath}.reclaim.${staleToken}`;
      writeFileSync(gateClaim, `${JSON.stringify({
        pid: process.pid,
        token: gateToken,
      })}\n`, { mode: 0o600 });
      linkSync(gateClaim, reclaimGate);
      const staleIdentity = statSync(leasePath);

      expect(() => store.acquireLease(sessionId)).toThrow(SessionConcurrencyError);
      expect(statSync(leasePath).ino).toBe(staleIdentity.ino);

      rmSync(reclaimGate, { force: true });
      rmSync(gateClaim, { force: true });
      const recovered = store.acquireLease(sessionId);
      recovered.release();
      expect(existsSync(leasePath)).toBe(false);
      expect(existsSync(staleClaim)).toBe(false);
    } finally {
      held.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
