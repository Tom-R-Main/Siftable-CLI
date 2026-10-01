import {Flags} from '@oclif/core';
import {resolveToken} from './auth.js';
import {BaseCommand, DEFAULT_API_URL, type ApiContextFlags} from './base-command.js';
import {sanitizeTerminalLine} from './output.js';
import {
  type ApiResult,
  type RuntimeControl,
  type RuntimeControlResult,
  type RuntimeRequest,
  type RuntimeRequestKind,
  WORK_RUNTIME_OUTPUT_VERSION,
  LedgerEndNotFoundError,
  WorkItemFollower,
  type WatchRecord,
  WorkRuntimeApi,
  WorkRuntimeApiError,
  describeControlState,
  isControlSettled,
  isControlSuccess,
  newControlIdempotencyKey,
  normalizeControlIdempotencyKey,
  openUrlInBrowser,
  renderRequestLines,
  renderWatchRecord,
  resolveAppOrigin,
  runtimeRequestDecisionUrl,
  isAbortError,
  sendControlWithRetry,
  sleep,
  waitScope,
} from './work-runtime.js';

/**
 * `--json` output of `sift work approve` and `sift work answer` is JSON Lines.
 * While the request is pending, the first line is `decision_required`, written
 * before the command starts waiting; the last line is `outcome`.
 */
export interface WorkDecisionRequiredRecord {
  version: typeof WORK_RUNTIME_OUTPUT_VERSION;
  type: 'decision_required';
  workItemId: string;
  requestId: string;
  kind: RuntimeRequestKind;
  /** Open this page with a signed-in session to decide the request. */
  url: string;
  browserOpened: boolean;
}

export interface WorkDecisionOutput {
  version: typeof WORK_RUNTIME_OUTPUT_VERSION;
  type: 'outcome';
  workItemId: string;
  requestId: string;
  kind: RuntimeRequestKind;
  /** The web-app page where a signed-in person decides this request. */
  decisionUrl: string;
  /** Whether the platform URL opener started. False with --no-browser, when the opener failed, or when the request was already closed. */
  browserOpened: boolean;
  /**
   * The request's stored state when the CLI stopped observing. `timed_out`: still
   * pending at --timeout. `interrupted`: still pending when Ctrl-C stopped the wait (exit 130).
   */
  outcome: 'resolved' | 'expired' | 'superseded' | 'timed_out' | 'interrupted';
  /** The request as last read by ID from the server, including any stored resolution and delivery state. */
  request: RuntimeRequest;
}

/** `--json` output of `sift work send` and `sift work interrupt` (version 1). */
export interface WorkControlOutput {
  version: typeof WORK_RUNTIME_OUTPUT_VERSION;
  /** False when the server returned an existing control: a retry with the same key, or an interrupt already open. */
  applied: boolean;
  control: RuntimeControl;
  /** The key sent with every attempt of this invocation. Pass it back with --idempotency-key to retry safely. */
  idempotencyKey: string;
  /** HTTP attempts this invocation made (retries reuse the same key). */
  requestAttempts: number;
  /** Present with --wait: whether the control reached a final state before the timeout. */
  settled?: boolean;
  /** Present with --wait when not settled: `timeout`, or `signal` for Ctrl-C (exit 130). */
  stoppedBy?: 'timeout' | 'signal';
}

function envValue(primary: string, legacy: string): string | undefined {
  return process.env[primary] || process.env[legacy];
}

/** Shared plumbing for `sift work watch|attach|send|interrupt|approve|answer`. */
export abstract class WorkRuntimeCommand extends BaseCommand {
  static controlFlags = {
    'idempotency-key': Flags.string({
      description: 'Retry key (1-128 of A-Z a-z 0-9 . _ : -). Default: a new key per invocation, reused for its own retries',
    }),
    retries: Flags.integer({description: 'Retries after a transport error, 408, 429 or 5xx, with the same key', min: 0, max: 5, default: 2}),
    wait: Flags.boolean({description: 'Wait until the server records a final state for the control'}),
    timeout: Flags.integer({description: 'Seconds to wait with --wait', min: 1, default: 120}),
    'retry-delay-ms': Flags.integer({hidden: true, min: 0, default: 500}),
    'poll-ms': Flags.integer({hidden: true, min: 0, default: 1_000}),
  };

  static decisionFlags = {
    'no-browser': Flags.boolean({description: 'Print the decision URL instead of opening it'}),
    'app-url': Flags.string({
      description: 'Web app origin for the decision page (default: SIFT_APP_URL, else derived from --api-url)',
      env: 'SIFT_APP_URL',
    }),
    timeout: Flags.integer({description: 'Seconds to wait for the decision', min: 1, default: 900}),
    'poll-ms': Flags.integer({hidden: true, min: 0, default: 2_000}),
  };

  static watchFlags = {
    'after-sequence': Flags.integer({description: 'Follow from after this ledger sequence instead of the current end', min: 0}),
    'wait-ms': Flags.integer({
      description: 'Long-poll window per ledger request; runtime requests and controls refresh after each window',
      min: 1_000,
      max: 30_000,
      default: 10_000,
    }),
    timeout: Flags.integer({description: 'Stop following after this many seconds (0 = no limit)', min: 0, default: 0}),
    once: Flags.boolean({description: 'Print the current state (and backlog) once, then exit'}),
    'keep-following': Flags.boolean({description: 'Keep following after the live execution attempt ends'}),
  };

  protected runtimeApi(flags: ApiContextFlags): WorkRuntimeApi {
    const token = flags.token || envValue('SIFT_TOKEN', 'EXF_TOKEN') || resolveToken();
    if (!token) this.error('No authentication token found. Run `sift auth login` or set SIFT_TOKEN.');
    return new WorkRuntimeApi({
      apiUrl: flags['api-url'] || envValue('SIFT_API_URL', 'EXF_API_URL') || DEFAULT_API_URL,
      token,
      workspaceId: this.workspaceId(flags.workspace),
    });
  }

  /** Converts a failed API call into the CLI's standard error output and exit code. */
  protected unwrapApi<T>(result: ApiResult<T>): T {
    if (!result.ok) {
      this.handleApiError({statusCode: result.status, error: result.error || `HTTP ${result.status}`});
      // handleApiError always throws for an error body; this keeps the type checker honest.
      throw new Error(`API error (${result.status})`);
    }
    return result.body;
  }

  /** In --json mode every record is one compact JSON line (JSON Lines); otherwise readable text. */
  protected emitRecord(record: WatchRecord): void {
    if (this.jsonEnabled()) {
      console.log(JSON.stringify(record));
      return;
    }
    for (const line of renderWatchRecord(record)) console.log(line);
  }

  protected async follow(
    api: WorkRuntimeApi,
    workItemId: string,
    flags: {
      'after-sequence'?: number;
      'wait-ms': number;
      timeout: number;
      once?: boolean;
      'keep-following'?: boolean;
    },
    backlog: number,
    onFollower?: (follower: WorkItemFollower, signal: AbortSignal, stop: () => void) => void,
    beforeEnd?: () => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    const follower = new WorkItemFollower(api, {
      workItemId,
      afterSequence: flags['after-sequence'],
      backlog,
      waitMs: flags['wait-ms'],
      timeoutMs: flags.timeout * 1000,
      once: Boolean(flags.once),
      exitOnAttemptEnd: !flags['keep-following'],
      signal: controller.signal,
      emit: record => this.emitRecord(record),
      beforeEnd,
    });
    onFollower?.(follower, controller.signal, onSigint);
    try {
      const reason = await follower.run();
      if (reason === 'drain_incomplete') process.exitCode = 1;
    } catch (error) {
      if (error instanceof LedgerEndNotFoundError) this.error(error.message, {exit: 1});
      if (error instanceof WorkRuntimeApiError) {
        this.handleApiError({statusCode: error.status, error: error.body || `HTTP ${error.status}`});
      }
      throw error;
    } finally {
      process.off('SIGINT', onSigint);
      controller.abort();
    }
  }

  protected async sendControl(
    workItemId: string,
    input: {kind: 'instruction'; instruction: string} | {kind: 'interrupt'},
    flags: ApiContextFlags & {
      'idempotency-key'?: string;
      retries: number;
      wait?: boolean;
      timeout: number;
      'retry-delay-ms': number;
      'poll-ms': number;
    },
  ): Promise<WorkControlOutput> {
    let idempotencyKey: string;
    try {
      idempotencyKey = flags['idempotency-key']
        ? normalizeControlIdempotencyKey(flags['idempotency-key'])
        : newControlIdempotencyKey(input.kind);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const api = this.runtimeApi(flags);
    const {result, requestAttempts} = await sendControlWithRetry(api, workItemId, input, {
      idempotencyKey,
      retries: flags.retries,
      retryDelayMs: flags['retry-delay-ms'],
    });
    if (!result.ok && !this.jsonEnabled()) {
      this.logToStderr(`Retry safely with --idempotency-key ${idempotencyKey}`);
    }
    const sent: RuntimeControlResult = this.unwrapApi(result);
    const output: WorkControlOutput = {
      version: WORK_RUNTIME_OUTPUT_VERSION,
      applied: sent.applied,
      control: sent.control,
      idempotencyKey,
      requestAttempts,
    };
    if (!this.jsonEnabled()) {
      const noun = input.kind === 'interrupt' ? 'Interrupt' : 'Instruction';
      this.log(`${noun} ${sanitizeTerminalLine(sent.control.id)} for attempt ${sanitizeTerminalLine(sent.control.attemptId)}`);
      if (!sent.applied) this.log('The server returned an existing control (a retry of this key, or an interrupt that is already open).');
      this.log(describeControlState(sent.control));
    }
    if (flags.wait) {
      // Ctrl-C or the deadline aborts a stalled read as well as the pause between reads.
      const scope = waitScope(flags.timeout * 1000);
      let control = sent.control;
      try {
        while (!isControlSettled(control) && !scope.signal.aborted) {
          await sleep(flags['poll-ms'], scope.signal);
          const list = this.unwrapApi(await api.listControls(workItemId, scope.signal));
          const latest = list.controls.find(candidate => candidate.id === control.id);
          if (!latest) continue;
          if (latest.state !== control.state && !this.jsonEnabled()) this.log(describeControlState(latest));
          control = latest;
        }
      } catch (error) {
        if (!scope.cause() || !isAbortError(error)) throw error;
      } finally {
        scope.dispose();
      }
      output.control = control;
      output.settled = isControlSettled(control);
      if (!output.settled) {
        output.stoppedBy = scope.cause() === 'signal' ? 'signal' : 'timeout';
        if (!this.jsonEnabled()) {
          this.log(output.stoppedBy === 'signal'
            ? `Stopped waiting; last recorded state: ${control.state}.`
            : `Still ${control.state} after ${flags.timeout}s; stopped waiting.`);
        }
      }
      if (!isControlSuccess(control)) process.exitCode = output.stoppedBy === 'signal' ? 130 : 1;
    }
    return output;
  }

  /**
   * Opens the web page where a signed-in person decides one runtime request,
   * then observes the request list until the server records an outcome. The
   * CLI never calls the resolve endpoint: the server refuses access tokens
   * there, and the decision must come from the person's own session.
   */
  protected async decideInBrowser(
    kind: RuntimeRequestKind,
    workItemId: string,
    requestId: string | undefined,
    flags: ApiContextFlags & {'no-browser'?: boolean; 'app-url'?: string; timeout: number; 'poll-ms': number},
  ): Promise<WorkDecisionOutput | undefined> {
    const api = this.runtimeApi(flags);
    const noun = kind === 'approval' ? 'approval' : 'question';
    let request: RuntimeRequest | undefined;
    if (requestId) {
      // The exact read is not limited by the list cap, so an older request is addressable.
      const exact = await api.getRequest(workItemId, requestId.trim());
      if (!exact.ok && exact.status === 404) {
        this.error(`Not found: runtime request ${sanitizeTerminalLine(requestId)} on work item ${sanitizeTerminalLine(workItemId)}.`, {exit: 4});
      }
      request = this.unwrapApi(exact).request;
    } else {
      const lists = this.unwrapApi(await api.listRequestsWithOpen(workItemId));
      const open = lists.open.filter(candidate => candidate.state === 'pending' && candidate.kind === kind);
      if (open.length === 0) this.error(`No open ${noun} requests on work item ${sanitizeTerminalLine(workItemId)}.`, {exit: 4});
      if (open.length > 1) {
        this.error(
          `${open.length} open ${noun} requests; name one:\n${open.map(candidate => `  ${sanitizeTerminalLine(candidate.id)}  ${sanitizeTerminalLine(candidate.summary)}`).join('\n')}`,
          {exit: 2},
        );
      }
      request = open[0];
    }
    if (request.kind !== kind) {
      const other = request.kind === 'approval' ? 'approve' : 'answer';
      this.error(`Request ${sanitizeTerminalLine(request.id)} is a ${request.kind === 'approval' ? 'approval' : 'question'}; use \`sift work ${other}\`.`, {exit: 2});
    }
    let appOrigin: string;
    try {
      appOrigin = resolveAppOrigin(api.apiUrl, flags['app-url']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const decisionUrl = runtimeRequestDecisionUrl(appOrigin, workItemId, request.id);
    const output = (current: RuntimeRequest, browserOpened: boolean): WorkDecisionOutput => ({
      version: WORK_RUNTIME_OUTPUT_VERSION,
      type: 'outcome',
      workItemId,
      requestId: current.id,
      kind: current.kind,
      decisionUrl,
      browserOpened,
      outcome: current.state === 'pending' ? 'timed_out' : current.state,
      request: current,
    });
    if (request.state !== 'pending') {
      if (!this.jsonEnabled()) {
        this.log('This request is already closed; nothing to decide.');
        for (const line of renderRequestLines(request)) this.log(line);
      }
      if (request.state !== 'resolved') process.exitCode = 1;
      return this.finishDecision(output(request, false));
    }

    if (!this.jsonEnabled()) for (const line of renderRequestLines(request).slice(0, -1)) this.log(line);
    const browserOpened = flags['no-browser'] ? false : await openUrlInBrowser(decisionUrl);
    if (this.jsonEnabled()) {
      const required: WorkDecisionRequiredRecord = {
        version: WORK_RUNTIME_OUTPUT_VERSION,
        type: 'decision_required',
        workItemId,
        requestId: request.id,
        kind: request.kind,
        url: decisionUrl,
        browserOpened,
      };
      console.log(JSON.stringify(required));
    } else {
      if (browserOpened) this.log(`Opened ${decisionUrl}`);
      else if (flags['no-browser']) this.log(`Open ${decisionUrl}`);
      else this.log(`Could not open a browser. Open this page yourself: ${decisionUrl}`);
      this.log('Decide there with your signed-in session; access tokens cannot answer agent requests. Waiting for the decision...');
    }

    const deadline = Date.now() + flags.timeout * 1000;
    let current = request;
    // Ctrl-C or the deadline aborts a stalled read as well as the pause between reads.
    const scope = waitScope(Math.max(0, deadline - Date.now()));
    try {
      while (current.state === 'pending' && !scope.signal.aborted) {
        await sleep(flags['poll-ms'], scope.signal);
        // Read the selected request by ID: its true stored state, never a capped list.
        current = this.unwrapApi(await api.getRequest(workItemId, current.id, scope.signal)).request;
      }
    } catch (error) {
      if (!scope.cause() || !isAbortError(error)) throw error;
    } finally {
      scope.dispose();
    }
    const result = output(current, browserOpened);
    if (current.state === 'pending' && scope.cause() === 'signal') result.outcome = 'interrupted';
    if (!this.jsonEnabled()) {
      if (result.outcome === 'interrupted') this.log('Stopped waiting; the request is still pending. Run this command again to keep waiting.');
      else if (current.state === 'pending') this.log(`Still pending after ${flags.timeout}s. Run this command again to keep waiting.`);
      else for (const line of renderRequestLines(current)) this.log(line);
    }
    if (result.outcome !== 'resolved') process.exitCode = result.outcome === 'interrupted' ? 130 : 1;
    return this.finishDecision(result);
  }

  /** In --json mode the outcome is the last JSON Lines record; oclif prints nothing more. */
  private finishDecision(result: WorkDecisionOutput): WorkDecisionOutput | undefined {
    if (!this.jsonEnabled()) return result;
    console.log(JSON.stringify(result));
    return undefined;
  }
}
