import { parseArgs } from 'node:util';
import { fstatSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BrainAskResult, BrainEvent } from './brain';
import { SupervisorHandoff } from './supervisorHandoff';

export interface HeadlessOptions {
  prompt: string;
  provider: string;
  model: string;
  cwd: string;
  session: string;
  approval: 'deny' | 'allow';
  format: 'jsonl' | 'json' | 'text';
  deadlineMs: number;
  maxRounds: number;
  baseUrl?: string;
  effort?: string;
  maxOutputTokens?: number;
  verifyArgv?: string[];
  verifyFiles?: string[];
  supervisorHandoff?: boolean;
  handoffTimeoutMs?: number;
}

export function parseHeadlessOptions(args: string[]): HeadlessOptions {
  const { values } = parseArgs({ args, options: {
    prompt: {type: 'string'}, provider: {type: 'string'}, model: {type: 'string'},
    cwd: {type: 'string'}, session: {type: 'string'}, approval: {type: 'string'},
    format: {type: 'string'}, 'deadline-ms': {type: 'string'}, 'max-rounds': {type: 'string'},
    'verify-command': {type: 'string'}, 'verify-file': {type: 'string', multiple: true},
    'base-url': {type: 'string'}, effort: {type: 'string'}, 'max-output-tokens': {type: 'string'},
    'supervisor-handoff': {type: 'boolean'}, 'handoff-timeout-ms': {type: 'string'},
  }});
  if (!values.prompt?.trim() || !values.provider || !values.model) throw new Error('prompt, provider, and model are required');
  const cwd = realpathSync(values.cwd || process.cwd());
  if (!statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  const approval = values.approval || 'deny';
  const format = values.format || 'jsonl';
  if (approval !== 'deny' && approval !== 'allow') throw new Error('approval must be deny or allow');
  if (format !== 'jsonl' && format !== 'json' && format !== 'text') throw new Error('format must be jsonl, json, or text');
  const positive = (value: string | undefined, fallback: number, cap: number) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > cap) throw new Error(`limit must be an integer between 1 and ${cap}`);
    return parsed;
  };
  if (values.session && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values.session)) throw new Error('invalid session identifier');
  if (values.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort)) throw new Error('invalid reasoning effort');
  if (values['base-url']) {
    const endpoint = new URL(values['base-url']);
    const loopback = (['localhost', '[::1]'].includes(endpoint.hostname) || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname));
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('base-url requires HTTPS or loopback HTTP without credentials, query, or fragment');
  }
  let verifyArgv: string[] | undefined;
  if (values['verify-command']) {
    const command: unknown = JSON.parse(values['verify-command']);
    if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== 'string' || !command[0].trim() || command.some(part => typeof part !== 'string' || part.includes('\0'))) throw new Error('verify-command must be a nonempty JSON argv array');
    if (!values['verify-file']?.length) throw new Error('verify-command requires at least one verify-file');
    verifyArgv = command;
  } else if (values['verify-file']?.length) throw new Error('verify-file requires verify-command');
  if (values['verify-file']?.some(file => !file.trim() || file.includes('\0'))) throw new Error('verify-file must name a candidate file');
  if (values['supervisor-handoff'] && format !== 'jsonl') throw new Error('supervisor-handoff requires jsonl format');
  if (values['handoff-timeout-ms'] && !values['supervisor-handoff']) throw new Error('handoff-timeout-ms requires supervisor-handoff');
  return {
    supervisorHandoff: values['supervisor-handoff'],
    handoffTimeoutMs: values['supervisor-handoff'] ? positive(values['handoff-timeout-ms'], 300_000, 1_800_000) : undefined,
    verifyArgv, verifyFiles: values['verify-file'],
    prompt: values.prompt, provider: values.provider, model: values.model, cwd,
    session: values.session || randomUUID(), approval, format,
    deadlineMs: positive(values['deadline-ms'], 600_000, 86_400_000),
    maxRounds: positive(values['max-rounds'], 24, 256),
    baseUrl: values['base-url'], effort: values.effort,
    maxOutputTokens: values['max-output-tokens'] === undefined ? undefined : positive(values['max-output-tokens'], 8192, 131072),
  };
}

/** Run the production brain with a noninteractive approval adapter. */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
  if (options.supervisorHandoff) {
    const input = fstatSync(0);
    if (options.format !== 'jsonl' || (!input.isFIFO() && !input.isSocket())) throw new Error('supervisor-handoff requires JSONL and an inherited stdin control pipe');
  }
  // Set before loading the brain: no interactive renderer or hosted auth bootstrap.
  process.env.SIFT_LOCAL_ONLY = '1';
  process.env.SIFT_USER_CWD = options.cwd;
  process.env.SIFT_WORKSPACE_ROOT = options.cwd;
  process.env.SIFT_AGENT_MAX_ROUNDS = String(options.maxRounds);
  // CLI-044: the harness prompt and settlement check both key off this.
  process.env.SIFT_AGENT_NONINTERACTIVE = options.approval;
  if (options.maxOutputTokens !== undefined) process.env.SIFT_AGENT_MAX_OUTPUT_TOKENS = String(options.maxOutputTokens);
  const brain = await import('./brain');
  const approvals = await import('./confirmGate');
  const conversationKey = `headless:${options.session}:${options.cwd}`;
  brain.setAgentConversationKey(conversationKey);
  brain.setBrainModel({provider: options.provider, model: options.model, baseUrl: options.baseUrl, effort: options.effort});
  approvals.setConfirmListener((request) => {
    approvals.resolveApproval(request.id, options.approval === 'allow' ? 'allow' : 'deny');
  });
  const controller = new AbortController();
  const runId = randomUUID();
  let handoffError: Error | undefined;
  const handoff = options.supervisorHandoff ? new SupervisorHandoff(process.stdin, {session: options.session, runId}, error => {
    handoffError = error;
    controller.abort(error);
  }) : undefined;
  let seq = 0;
  const emit = (event: Record<string, unknown>) => {
    if (options.format === 'jsonl') process.stdout.write(`${JSON.stringify({schemaVersion: 1, seq: ++seq, session: options.session, runId, ...event})}\n`);
  };
  const stop = () => {
    if (controller.signal.aborted) return;
    emit({type: 'status', status: 'stopping'});
    controller.abort(new DOMException('Run interrupted', 'AbortError'));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const deadline = Date.now() + options.deadlineMs;
  const timer = setTimeout(stop, options.deadlineMs);
  let result: BrainAskResult = {text: '', status: 'failed'};
  let verification: import('./candidateVerification').CandidateVerificationReceipt | undefined;
  try {
    emit({type: 'session', provider: options.provider, model: options.model, cwd: options.cwd, approval: options.approval});
    result = await brain.agentHarnessAsk(options.prompt, (event: BrainEvent) => {
      emit(event);
      if (options.format === 'text' && event.type === 'token') process.stdout.write(event.content || '');
    }, controller.signal, {
      noninteractive: {approvalPolicy: options.approval},
      ...(options.verifyArgv ? {completionVerification: {
        argv: options.verifyArgv, files: options.verifyFiles || [],
        context: {workspaceRoot: options.cwd, sessionCwd: options.cwd, deadline,
          approval: {policy: options.approval, scopeId: runId}},
      }} : {}),
    });
    verification = result.verification;
    if (handoff && result.status === 'completed' && !result.error && (!options.verifyArgv || verification?.status === 'passed') && !controller.signal.aborted) {
      // The model is settled. Grading gets a separate bounded window, with no
      // more inference or tools; closeBrain retains ownership until release.
      clearTimeout(timer);
      await handoff.wait(options.handoffTimeoutMs ?? 300_000, controller.signal, emit);
    }
  } catch (error) {
    result = {...result, error: error instanceof Error ? error.message : String(error), status: controller.signal.aborted ? 'interrupted' : 'failed'};
  } finally {
    clearTimeout(timer);
    handoff?.dispose();
    approvals.rejectAllConfirms();
    approvals.setConfirmListener(null);
    try {
      await brain.closeBrain();
    } catch (error) {
      result = {...result!, status: 'failed', error: `${result?.error ? `${result.error}; ` : ''}Session shutdown failed: ${error instanceof Error ? error.message : String(error)}`};
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
  // Cleanup and a grader handoff can run after the model's passing check.
  // Observe freshness again, without dispatching any check or reopening a turn.
  if (verification?.status === 'passed') {
    const {verifyReceiptCurrent} = await import('./candidateVerification');
    const freshness = verifyReceiptCurrent(verification);
    if (!freshness.current) {
      verification = {...verification, status: 'stale', reason: freshness.reason || 'candidate_changed_after_turn'};
      emit({type: 'verification', phase: 'verification', receipt: verification, observation: 'after_shutdown'});
      result = {...result, verification, ...(result.result ? {result: {...result.result, verification}} : {}),
        status: result.status === 'completed' ? 'failed' : result.status,
        error: `${result.error ? `${result.error}; ` : ''}Candidate verification became stale after shutdown: ${verification.reason}`};
    }
  }
  if (handoffError) result = {...result, status: 'failed', error: handoffError.message};
  const status = handoffError ? 'failed' : controller.signal.aborted ? 'interrupted' : result.status === 'limit_reached' ? 'limit_reached' : result.error ? 'failed' : result.status || 'failed';
  const terminal = {type: `run.${status}`, ...result, status, ...(verification ? {verification} : {})};
  emit(terminal);
  if (options.format === 'json') process.stdout.write(`${JSON.stringify({schemaVersion: 1, session: options.session, ...terminal})}\n`);
  if (options.format === 'text') {
    process.stdout.write('\n');
    if (verification) process.stderr.write(`Verification ${verification.status}: ${verification.reason || `${verification.files.length} explicit candidate file(s)`}\n`);
    if (result.error) process.stderr.write(`${result.error}\n`);
  }
  return status === 'completed' && (!options.verifyArgv || verification?.status === 'passed') ? 0 : status === 'interrupted' ? 130 : 1;
}

// Bun sets import.meta.main for the entry module. The pinned @types/node used by
// CI predates the Node 24 typing, so read it through an explicit shape.
const invokedAsEntryPoint = (import.meta as ImportMeta & {main?: boolean}).main === true;
if (invokedAsEntryPoint) {
  // Libraries may log diagnostics; stdout is reserved for the public protocol.
  console.log = (...values: unknown[]) => console.error(...values);
  console.info = (...values: unknown[]) => console.error(...values);
  try {
    process.exitCode = await runHeadless(parseHeadlessOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
