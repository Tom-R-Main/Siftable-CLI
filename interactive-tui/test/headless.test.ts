import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseHeadlessOptions } from '../headless';
import {SessionKernel, type SessionEvent} from '../agent-harness/framework/session';

type Mode = 'source' | 'cli-source' | 'cli-packaged';
type ProviderBody = {model: string; stream?: boolean; messages: Array<{role: string; content?: unknown}>; tools?: Array<{function: {name: string}}>};
const packageRoot = process.env.SIFT_TEST_CLI_PACKAGE_ROOT
  ? resolve(process.env.SIFT_TEST_CLI_PACKAGE_ROOT)
  : resolve(import.meta.dir, '../..');
const packagedEnabled = process.env.SIFT_TEST_PACKAGED_RUNTIME === '1';

function completion(body: ProviderBody, message: Record<string, unknown>, id = 'reply') {
  return Response.json({id, model: body.model, choices: [{index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 4}});
}
function toolMessage(name: string, args: Record<string, unknown>, id: string) {
  return {role: 'assistant', content: null, tool_calls: [{id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]};
}

async function fixture(
  respond: (body: ProviderBody, index: number) => Response | Promise<Response>,
  check: (input: {root: string; bodies: ProviderBody[]; run: (options?: {mode?: Mode; args?: string[]; env?: Record<string, string>; onStdout?: (text: string) => void; onStart?: (sendSignal: (signal: NodeJS.Signals) => void) => void; onControl?: (control: {write: (text: string) => void; end: () => void}) => void}) => Promise<{stdout: string; stderr: string; exit: number}>}) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'sift-headless-test-'));
  const bodies: ProviderBody[] = [];
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as ProviderBody;
    bodies.push(body);
    return respond(body, bodies.length);
  }});
  try {
    await check({root, bodies, run: async ({mode = 'source', args = [], env: extraEnv = {}, onStdout, onStart, onControl} = {}) => {
      const node = process.env.SIFT_TEST_NODE || Bun.which('node');
      if (mode !== 'source' && !node) throw new Error('Node is required for public CLI parity tests.');
      const entry = mode === 'source'
        ? [process.execPath, resolve(import.meta.dir, '../headless.ts')]
        : [node!, join(packageRoot, 'bin/run.js'), 'agent', 'run'];
      const child = Bun.spawn([...entry, '--provider', 'meta', '--model', 'fixture',
        '--base-url', `http://127.0.0.1:${server.port}/v1`, '--prompt', 'Repair candidate.txt',
        '--cwd', root, '--session', 'fixture', '--deadline-ms', '8000', ...args], {
        cwd: root,
        env: {
          PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`, HOME: root,
          META_API_KEY: 'fixture-key', SIFT_CONFIG_DIR: join(root, 'config'), EXF_CONFIG_DIR: join(root, 'legacy-config'),
          SIFT_INTERACTIVE_RUNTIME: mode === 'cli-packaged' ? 'packaged' : 'source',
          SIFT_SESSION_EVENT_ROOT: join(root, 'events'), SIFT_CONTEXT_COMPACTION: '0', SIFT_EXPLORER_MODE: 'off',
          ...extraEnv,
        },
        stdin: onControl ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      onStart?.(signal => child.kill(signal));
      if (onControl && child.stdin && typeof child.stdin !== 'number') onControl({write: text => { child.stdin.write(text); child.stdin.flush(); }, end: () => { child.stdin.end(); }});
      const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
      const collect = async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let text = '';
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          text += decoder.decode(value, {stream: true});
          onStdout?.(text);
        }
        return text + decoder.decode();
      };
      try {
        const [stdout, stderr, exit] = await Promise.all([collect(), new Response(child.stderr).text(), child.exited]);
        expect(stdout).not.toContain('fixture-key');
        expect(stderr).not.toContain('fixture-key');
        return {stdout, stderr, exit};
      } finally { clearTimeout(timeout); }
    }});
  } finally {
    server.stop(true);
    await rm(root, {recursive: true, force: true});
  }
}
function jsonl(stdout: string) { return stdout.trim().split('\n').map(line => JSON.parse(line)); }
function requireSuccess(result: {exit: number; stdout: string; stderr: string}) {
  if (result.exit !== 0) throw new Error(`Headless exit ${result.exit}: ${result.stderr}\n${result.stdout}`);
}

describe('production headless brain', () => {
  test('supervisor handoff rejects a missing control pipe before inference', async () => {
    await fixture(body => completion(body, {role: 'assistant', content: 'Must not dispatch.'}), async ({bodies, run}) => {
      const result = await run({args: ['--supervisor-handoff']});
      expect(result.exit).toBe(1);
      expect(result.stderr).toContain('inherited stdin control pipe');
      expect(bodies).toHaveLength(0);
    });
  });

  for (const outcome of ['release', 'EOF', 'wrong-run', 'timeout', 'signal'] as const) {
    test(`supervisor handoff ${outcome}: retains jobs for grading, then confirms cleanup`, async () => {
      let workspace = '';
      const code = 'require("fs").writeFileSync("job.pid", String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
      await fixture(async (body, index) => {
        if (index === 2) {
          const deadline = Date.now() + 2000;
          while (true) {
            try { await readFile(join(workspace, 'job.pid')); break; }
            catch { if (Date.now() > deadline) throw new Error('Job did not become ready'); await Bun.sleep(10); }
          }
        }
        return completion(body, index === 1
          ? toolMessage('start_process_job', {command: `exec node -e '${code}'`}, 'start-job')
          : {role: 'assistant', content: 'Service is ready for external checks.'});
      }, async ({root, bodies, run}) => {
        workspace = root;
        let control: {write: (text: string) => void; end: () => void};
        let signal: (signal: NodeJS.Signals) => void;
        let observed = false;
        let aliveDuringHandoff = false;
        const result = await run({args: ['--approval', 'allow', '--supervisor-handoff', '--handoff-timeout-ms', '5000', '--deadline-ms', '4000'],
          onControl: value => { control = value; }, onStart: value => { signal = value; },
          onStdout: stdout => {
            if (observed) return;
            const lines = stdout.split('\n').filter(line => line.endsWith('}'));
            const ready = lines.map(line => JSON.parse(line)).find(event => event.type === 'handoff.ready');
            if (!ready) return;
            observed = true;
            // Delay valid release beyond the original model deadline: grading
            // has its own finite window and must not launch further requests.
            // The deadline leaves room for the fixture's 2 s job-readiness wait
            // on a loaded runner; the delay stays inside the 5 s handoff window.
            setTimeout(() => {
              void readFile(join(root, 'job.pid'), 'utf8').then(text => {
                try { process.kill(Number(text), 0); aliveDuringHandoff = true; } catch { /* assertion below */ }
                if (outcome === 'release') control.write(JSON.stringify({type: 'handoff.release', session: ready.session, runId: ready.runId}) + '\n');
                if (outcome === 'EOF') control.end();
                if (outcome === 'wrong-run') control.write(JSON.stringify({type: 'handoff.release', session: ready.session, runId: 'stale-run'}) + '\n');
                if (outcome === 'signal') signal('SIGINT');
              });
            }, outcome === 'release' ? 4200 : 0);
          }});
        expect(observed).toBe(true);
        expect(aliveDuringHandoff).toBe(true);
        expect(bodies).toHaveLength(2);
        expect(result.exit).toBe(outcome === 'release' ? 0 : outcome === 'signal' ? 130 : 1);
        const events = jsonl(result.stdout);
        expect(events.at(-1).type).toBe(outcome === 'release' ? 'run.completed' : outcome === 'signal' ? 'run.interrupted' : 'run.failed');
        const pid = Number(await readFile(join(root, 'job.pid'), 'utf8'));
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        expect(alive).toBe(false);
      });
    }, 15_000);
  }

  test('validates bounded options before loading the engine', () => {
    const args = ['--prompt', 'hello', '--provider', 'meta', '--model', 'fixture'];
    expect(parseHeadlessOptions(args).approval).toBe('deny');
    expect(parseHeadlessOptions([...args, '--base-url', 'http://127.2.0.1/v1']).baseUrl).toBe('http://127.2.0.1/v1');
    for (const [flag, value] of [['--max-rounds', 'NaN'], ['--max-rounds', '257'], ['--deadline-ms', '0'], ['--max-output-tokens', '131073'], ['--session', '../escape'], ['--effort', 'invalid'], ['--base-url', 'http://remote.example/v1'], ['--base-url', 'https://key:secret@provider.example/v1']]) {
      expect(() => parseHeadlessOptions([...args, flag!, value!])).toThrow();
    }
  });

  for (const mode of ['source', 'cli-source', 'cli-packaged'] as const) {
    const modeTest = mode === 'cli-packaged' ? test.skipIf(!packagedEnabled) : test;
    modeTest(`${mode}: actual read/write loop, JSONL receipts, and no hosted credential`, async () => {
      await fixture((body, index) => completion(body, index < 3
        ? toolMessage(index === 1 ? 'read_file' : 'write_file', {path: 'candidate.txt', ...(index === 2 ? {content: 'repaired'} : {})}, `call-${index}`)
        : {role: 'assistant', content: 'Repair complete.'}, `reply-${index}`), async ({root, bodies, run}) => {
        await writeFile(join(root, 'candidate.txt'), 'old');
        const result = await run({mode, args: ['--approval', 'allow']});
        requireSuccess(result);
        expect(bodies).toHaveLength(3);
        expect(await readFile(join(root, 'candidate.txt'), 'utf8')).toBe('repaired');
        const events = jsonl(result.stdout);
        expect(events.every((event, index) => event.seq === index + 1 && event.schemaVersion === 1)).toBe(true);
        expect(events.at(-1).type).toBe('run.completed');
        expect(events.at(-1).providerReceipts).toHaveLength(3);
        expect(events.at(-1).providerReceipts[0].servedModel).toBe('fixture');
        expect(events.filter(event => event.type === 'tool_result')).toHaveLength(2);
        expect(result.stderr).not.toContain('Personal Access Token');
      });
    }, 15_000);

    modeTest(`${mode}: background jobs survive tool calls and drain at shutdown`, async () => {
      const code = 'require("fs").writeFileSync("job.pid", String(process.pid)); setInterval(() => {}, 1000)';
      let workspace = '';
      await fixture(async (body, index) => {
        if (index === 2) {
          // Starting the process is distinct from application readiness.
          const deadline = Date.now() + 2000;
          while (true) {
            try { await readFile(join(workspace, 'job.pid')); break; }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
              await new Promise(resolveWait => setTimeout(resolveWait, 10));
            }
          }
        }
        return completion(body, index === 1
          ? toolMessage('start_process_job', {command: `exec node -e '${code}'`}, 'start-job')
          : index === 2 ? toolMessage('list_process_jobs', {}, 'list-jobs')
          : {role: 'assistant', content: 'Job inspected; ending the session.'});
      }, async ({root, bodies, run}) => {
        workspace = root;
        const result = await run({mode, args: ['--approval', 'allow']});
        requireSuccess(result);
        expect(bodies).toHaveLength(3);
        const events = jsonl(result.stdout);
        const tools = events.filter(event => event.type === 'tool_result');
        expect(tools).toHaveLength(2);
        expect(tools.every(event => event.toolResult.success)).toBe(true);
        expect(JSON.stringify(tools[1])).toContain('running');
        const pid = Number(await readFile(join(root, 'job.pid'), 'utf8'));
        expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        expect(alive).toBe(false);
        expect(events.at(-1).type).toBe('run.completed');
      });
    }, 15_000);

    modeTest(`${mode}: shell results project one output body and retain diagnostic receipts`, async () => {
      await fixture((body, index) => completion(body, index === 1
        ? toolMessage('run_terminal_command', {command: "printf 'stdout-marker'; printf 'stderr-marker' >&2; exit 1"}, 'shell-projection')
        : {role: 'assistant', content: 'Observed exit 1.'}), async ({root, bodies, run}) => {
        const result = await run({mode, args: ['--approval', 'allow']});
        requireSuccess(result);
        expect(bodies).toHaveLength(2);
        const modelContent = String(bodies[1]!.messages.find(message => message.role === 'tool')?.content);
        const model = JSON.parse(modelContent);
        expect(model).toMatchObject({success: false, executionOutcome: 'failed', data: {exitCode: 1, output: 'stdout-marker\nstderr-marker'}});
        expect(model.data.stdout).toBeUndefined();
        expect(model.data.stderr).toBeUndefined();
        expect(model.data.command).toBeUndefined();
        expect(modelContent.match(/stdout-marker/g)).toHaveLength(1);
        const journalNames = (await readdir(join(root, 'events'))).filter(name => name.endsWith('.jsonl'));
        const journal = jsonl(await readFile(join(root, 'events', journalNames[0]!), 'utf8'));
        const receipt = journal.find(event => event.type === 'tool/result').data.result;
        expect(receipt.data).toMatchObject({stdout: 'stdout-marker', stderr: 'stderr-marker', exitCode: 1});
      });
    }, 15_000);

    modeTest(`${mode}: staged native engine compacts resumed history`, async () => {
      let turn = 0;
      await fixture(body => {
        turn += 1;
        return completion(body, {role: 'assistant', content: `${'answer '.repeat(60)}${turn}`}, `turn-${turn}`);
      }, async ({root, run}) => {
        // Each invocation appends a completed turn to the same resumed session.
        for (let index = 0; index < 4; index += 1) requireSuccess(await run({mode, args: ['--approval', 'allow']}));
        // A window too small for the resumed history forces the pre-turn
        // compaction pass; the packaged runtime must load its staged native
        // engine rather than degrade silently.
        const result = await run({mode, args: ['--approval', 'allow'], env: {SIFT_CONTEXT_COMPACTION: '1', SIFT_CONTEXT_WINDOW: '800'}});
        requireSuccess(result);
        const journalNames = (await readdir(join(root, 'events'))).filter(name => name.endsWith('.jsonl'));
        const journal = jsonl(await readFile(join(root, 'events', journalNames[0]!), 'utf8'));
        expect(journal.filter(event => event.type === 'compaction/planner-unavailable')).toHaveLength(0);
        expect(journal.some(event => event.type === 'history/replaced' && event.data?.reason === 'compaction_applied')).toBe(true);
      });
    }, 30_000);

    modeTest(`${mode}: streamed text arrives before completion and prints exactly once`, async () => {
      let firstOutput!: () => void;
      const observed = new Promise<void>(resolveObserved => {firstOutput = resolveObserved;});
      let serverFinished = false;
      let firstBeforeCompletion = false;
      await fixture(body => {
        expect(body.stream).toBe(true);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({async start(controller) {
          const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({id: 'stream-reply', model: body.model, choices: [{index: 0, delta, finish_reason}]})}\n\n`));
          send({role: 'assistant', content: 'Streamed '});
          // A buffered implementation cannot release this gate until the timeout.
          let timer: ReturnType<typeof setTimeout>;
          await Promise.race([observed, new Promise<void>(resolveWait => {timer = setTimeout(resolveWait, 1000);})]);
          clearTimeout(timer!);
          send({content: 'answer.'});
          send({}, 'stop');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          serverFinished = true;
          controller.close();
        }}), {headers: {'content-type': 'text/event-stream'}});
      }, async ({run}) => {
        const result = await run({mode, args: ['--format', 'text'], onStdout: text => {
          if (text.includes('Streamed ')) { firstBeforeCompletion ||= !serverFinished; firstOutput(); }
        }});
        requireSuccess(result);
        expect(firstBeforeCompletion).toBe(true);
        expect(result.stdout).toBe('Streamed answer.\n');
      });
    }, 15_000);

    modeTest(`${mode}: a withdrawn user-directed answer never becomes the result; a streamed one is marked in place`, async () => {
      const withdrawn = 'Approve running the recovery commands and I will finish.';
      const accepted = 'Recovered 9 rows into recover.json.';
      // Non-streamed responses: the withdrawn answer is simply never projected.
      await fixture((body, index) => completion(body, {role: 'assistant', content: index === 1 ? withdrawn : accepted}), async ({bodies, run}) => {
        const text = await run({mode, args: ['--format', 'text', '--approval', 'allow']});
        requireSuccess(text);
        expect(bodies).toHaveLength(2);
        expect(text.stdout).toBe(`${accepted}\n`);
      });
      await fixture((body, index) => completion(body, {role: 'assistant', content: index === 1 ? withdrawn : accepted}), async ({run}) => {
        const result = await run({mode, args: ['--approval', 'allow']});
        requireSuccess(result);
        const events = jsonl(result.stdout);
        expect(events.find(event => event.type === 'status' && event.phase === 'settlement')).toMatchObject({status: 'withdrawn', streamed: false});
        expect(events.at(-1).type).toBe('run.completed');
        expect(events.at(-1).text).toBe(accepted);
      });
      // Streamed responses already reached stdout, so the withdrawal is marked in place.
      const sse = (body: ProviderBody, content: string) => {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({start(controller) {
          const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({id: 'stream-reply', model: body.model, choices: [{index: 0, delta, finish_reason}]})}\n\n`));
          send({role: 'assistant', content});
          send({}, 'stop');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }}), {headers: {'content-type': 'text/event-stream'}});
      };
      await fixture((body, index) => sse(body, index === 1 ? withdrawn : accepted), async ({bodies, run}) => {
        const text = await run({mode, args: ['--format', 'text', '--approval', 'allow']});
        requireSuccess(text);
        expect(bodies).toHaveLength(2);
        const marker = '[withdrawn: the answer above asked an absent user to act; retrying once]';
        expect(text.stdout).toContain(withdrawn);
        expect(text.stdout).toContain(marker);
        expect(text.stdout.trimEnd().endsWith(accepted)).toBe(true);
        expect(text.stdout.indexOf(marker)).toBeGreaterThan(text.stdout.indexOf(withdrawn));
        expect(text.stdout.indexOf(marker)).toBeLessThan(text.stdout.indexOf(accepted));
        expect(text.stdout.match(new RegExp(accepted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
      });
    }, 30_000);

    modeTest(`${mode}: final answer excludes tool progress and failed partial text stays separate`, async () => {
      for (const fail of [false, true]) {
        await fixture((body, index) => index === 1
          ? completion(body, {...toolMessage('read_file', {path: 'candidate.txt'}, 'read-1'), content: 'Inspecting candidate. '})
          : fail ? Response.json({error: {message: 'fixture terminal rejection'}}, {status: 400})
            : completion(body, {role: 'assistant', content: 'Final answer.'}), async ({root, run}) => {
          await writeFile(join(root, 'candidate.txt'), 'candidate');
          const result = await run({mode});
          expect(result.exit).toBe(fail ? 1 : 0);
          const events = jsonl(result.stdout), terminal = events.at(-1);
          expect(terminal.text).toBe(fail ? '' : 'Final answer.');
          expect(terminal.progressText).toBe('Inspecting candidate. ');
          expect(events.filter(event => event.type === 'token').map(event => event.content).join(''))
            .toBe(fail ? 'Inspecting candidate. ' : 'Inspecting candidate. Final answer.');
          if (!fail) expect(events.find(event => event.type === 'done')).toMatchObject({phase: 'final', result: {text: 'Final answer.'}});
        });
      }
    });

    modeTest(`${mode}: streamed tool progress and final answer retain separate response boundaries`, async () => {
      await fixture((body, index) => {
        const delta = index === 1 ? {content: 'Inspecting candidate. ', tool_calls: [{index: 0, id: 'read-stream', type: 'function', function: {name: 'read_file', arguments: '{"path":"candidate.txt"}'}}]}
          : {content: 'Final streamed answer.'};
        const frames = [
          {id: `stream-${index}`, model: body.model, choices: [{index: 0, delta, finish_reason: null}]},
          {id: `stream-${index}`, choices: [{index: 0, delta: {}, finish_reason: index === 1 ? 'tool_calls' : 'stop'}]},
        ];
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
      }, async ({root, run}) => {
        await writeFile(join(root, 'candidate.txt'), 'candidate');
        const result = await run({mode}); requireSuccess(result);
        const events = jsonl(result.stdout);
        expect(events.at(-1)).toMatchObject({text: 'Final streamed answer.', progressText: 'Inspecting candidate. '});
        expect(events.filter(event => event.type === 'token').map(event => event.content).join('')).toBe('Inspecting candidate. Final streamed answer.');
      });
    });

    modeTest(`${mode}: configured failed check reaches the model, repairs and passes in the same turn`, async () => {
      await fixture((body, index) => {
        if (index === 1) return completion(body, {role: 'assistant', content: 'Tentatively done.'});
        if (index === 2) {
          expect(JSON.stringify(body.messages.at(-1))).toContain('candidate is broken');
          return completion(body, toolMessage('read_file', {path: 'candidate.txt'}, 'read-for-repair'));
        }
        if (index === 3) return completion(body, toolMessage('write_file', {path: 'candidate.txt', content: 'repaired'}, 'repair-1'));
        return completion(body, {role: 'assistant', content: 'Repaired and checked.'});
      }, async ({root, bodies, run}) => {
        await writeFile(join(root, 'candidate.txt'), 'broken');
        const result = await run({mode, args: ['--approval', 'allow', '--max-rounds', '4', '--verify-file', 'candidate.txt',
          '--verify-command', JSON.stringify([process.execPath, '-e', 'if(require("fs").readFileSync("candidate.txt","utf8")!=="repaired"){console.error("candidate is broken");process.exit(1)}'])]});
        requireSuccess(result);
        expect(bodies).toHaveLength(4);
        const events = jsonl(result.stdout), terminal = events.at(-1);
        expect(terminal).toMatchObject({text: 'Repaired and checked.', progressText: 'Tentatively done.', verification: {status: 'passed'}, result: {rounds: 4}});
        expect(events.filter(event => event.type === 'verification').map(event => event.receipt.status)).toEqual(['unknown', 'failed', 'unknown', 'passed']);
        expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      });
    });

    modeTest(`${mode}: cleanup edits invalidate a previously passing check`, async () => {
      let workspace = '';
      await fixture(async (body, index) => {
        if (index === 1) return completion(body, toolMessage('start_process_job', {command:
          `exec '${process.execPath}' -e 'require("fs").writeFileSync("started.txt","yes");process.on("SIGTERM",()=>{require("fs").writeFileSync("candidate.txt","changed at shutdown");process.exit(0)});setInterval(()=>{},100)'`}, 'job-1'));
        for (let i = 0; i < 100; i++) {
          try {await readFile(join(workspace, 'started.txt')); break;} catch {await Bun.sleep(5);}
        }
        return completion(body, {role: 'assistant', content: 'Checked candidate.'});
      }, async ({root, run}) => {
        workspace = root;
        await writeFile(join(root, 'candidate.txt'), 'candidate');
        const result = await run({mode, args: ['--approval', 'allow', '--verify-file', 'candidate.txt',
          '--verify-command', JSON.stringify([process.execPath, '-e', 'process.exit(0)'])]});
        expect(result.exit).toBe(1);
        const events = jsonl(result.stdout), terminal = events.at(-1);
        expect(events.some(event => event.type === 'verification' && event.receipt.status === 'passed')).toBe(true);
        expect(terminal).toMatchObject({type: 'run.failed', verification: {status: 'stale', reason: 'candidate_changed_since_check'}, result: {verification: {status: 'stale'}}});
        expect(events.some(event => event.type === 'verification' && event.observation === 'after_shutdown')).toBe(true);
      });
    });

    for (const verificationCase of [
      {status: 'passed', code: 'console.log("explicit check passed")', exit: 0},
      {status: 'failed', code: 'console.error("explicit check failed"); process.exit(9)', exit: 1},
      {status: 'stale', code: 'require("fs").writeFileSync("candidate.txt", "changed during check")', exit: 1},
    ]) {
      modeTest(`${mode}: verification ${verificationCase.status} is candidate-bound and durably recorded`, async () => {
        await fixture(body => completion(body, {role: 'assistant', content: 'Agent turn completed.'}), async ({root, bodies, run}) => {
          await writeFile(join(root, 'candidate.txt'), 'candidate');
          await writeFile(join(root, 'second.txt'), 'second candidate');
          const result = await run({mode, args: ['--approval', 'allow', '--max-rounds', '1',
            '--verify-command', JSON.stringify([process.execPath, '-e', verificationCase.code]),
            '--verify-file', 'candidate.txt', '--verify-file', 'second.txt']});
          if (result.exit !== verificationCase.exit) throw new Error(`Unexpected verification exit ${result.exit}: ${result.stderr}\n${result.stdout}`);
          expect(bodies).toHaveLength(1);
          const terminal = jsonl(result.stdout).at(-1);
          const expectedStatus = verificationCase.status === 'passed' ? 'completed' : 'limit_reached';
          expect(terminal).toMatchObject({type: `run.${expectedStatus}`, status: expectedStatus, verification: {status: verificationCase.status, dispatched: true}});
          expect(terminal.verification.files).toEqual(['candidate.txt', 'second.txt']);
          expect(terminal.verification.before.files).toHaveLength(2);
          expect(terminal.verification.after.files).toHaveLength(2);
          if (verificationCase.status === 'passed') expect(terminal.verification.before.sha256).toBe(terminal.verification.after.sha256);
          if (verificationCase.status === 'stale') expect(terminal.verification.before.sha256).not.toBe(terminal.verification.after.sha256);
          const journalNames = (await readdir(join(root, 'events'))).filter(name => name.endsWith('.jsonl'));
          expect(journalNames).toHaveLength(1);
          const serialized = await readFile(join(root, 'events', journalNames[0]!), 'utf8');
          expect(serialized).not.toContain('fixture-key');
          const journal = serialized.trim().split('\n').map(line => JSON.parse(line)) as SessionEvent[];
          const started = journal.filter(event => event.type === 'verification/started');
          const recorded = journal.filter(event => event.type === 'verification/recorded');
          expect(started).toHaveLength(1);
          expect(recorded).toHaveLength(1);
          expect(started[0]!.seq).toBeLessThan(recorded[0]!.seq);
          expect(started[0]!.data.receipt).toMatchObject({id: terminal.verification.id, status: 'unknown', completedAt: '', reason: 'check_in_progress'});
          expect(recorded[0]!.data.receipt).toMatchObject({id: terminal.verification.id, status: verificationCase.status});
          const replay = new SessionKernel({sessionId: journal[0]!.sessionId, store: {read: () => journal, append: () => {throw new Error('Read-only replay cannot append');}}});
          expect(replay.getEvents().filter(event => event.type === 'verification/recorded')).toHaveLength(1);
        });
      }, 15_000);
    }

    modeTest(`${mode}: JSON output is exactly one object`, async () => {
      await fixture(body => completion(body, {role: 'assistant', content: 'One answer.'}), async ({run}) => {
        const result = await run({mode, args: mode === 'source' ? ['--format', 'json'] : ['--json']});
        requireSuccess(result);
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({schemaVersion: 1, type: 'run.completed', text: 'One answer.', session: 'fixture'});
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
      });
    }, 15_000);

    modeTest(`${mode}: denied approval hides mutating tools from the model`, async () => {
      const gated = ['run_terminal_command', 'start_process_job', 'write_file', 'edit_file', 'merge_branch'];
      const toolNames = (body: ProviderBody) => (body.tools ?? []).map(tool => tool.function.name);
      await fixture(body => completion(body, {role: 'assistant', content: 'Read only.'}), async ({run, bodies}) => {
        requireSuccess(await run({mode, args: ['--approval', 'deny']}));
        expect(bodies).toHaveLength(1);
        const denied = toolNames(bodies[0]!);
        expect(denied.length).toBeGreaterThan(0);
        expect(denied.filter(name => gated.includes(name))).toEqual([]);
        requireSuccess(await run({mode, args: ['--approval', 'allow']}));
        expect(toolNames(bodies[1]!)).toEqual(expect.arrayContaining(['write_file', 'edit_file', 'run_terminal_command']));
      });
    }, 30_000);
  }

  for (const args of [
    ['--verify-command', 'not-json', '--verify-file', 'candidate.txt'],
    ['--verify-command', '[]', '--verify-file', 'candidate.txt'],
    ['--verify-command', '["/usr/bin/true"]'],
    ['--verify-file', 'candidate.txt'],
    ['--verify-command', '[""]', '--verify-file', 'candidate.txt'],
    ['--verify-command', '["/usr/bin/true"]', '--verify-file', ''],
  ]) {
    test(`invalid verification configuration dispatches no model calls: ${JSON.stringify(args)}`, async () => {
      await fixture(body => completion(body, {role: 'assistant', content: 'Must never be called.'}), async ({bodies, run}) => {
        const result = await run({args});
        expect(result.exit).not.toBe(0);
        expect(bodies).toHaveLength(0);
      });
    }, 15_000);
  }

  test('completed session resume includes prior user and assistant history', async () => {
    await fixture((body, index) => completion(body, {role: 'assistant', content: index === 1 ? 'First completed answer.' : 'Resumed completed answer.'}, `resume-${index}`), async ({bodies, run}) => {
      requireSuccess(await run());
      requireSuccess(await run());
      expect(bodies).toHaveLength(2);
      expect(bodies[1]!.messages.some(message => message.role === 'assistant' && message.content === 'First completed answer.')).toBe(true);
      expect(bodies[1]!.messages.filter(message => message.role === 'user')).toHaveLength(2);
    });
  }, 20_000);

  test('default-deny leaves a requested write unchanged', async () => {
    await fixture((body, index) => completion(body, index === 1
      ? toolMessage('write_file', {path: 'candidate.txt', content: 'unauthorized change'}, 'write-denied')
      : {role: 'assistant', content: 'Write was denied.'}), async ({root, run}) => {
      await writeFile(join(root, 'candidate.txt'), 'original');
      const result = await run();
      requireSuccess(result);
      expect(await readFile(join(root, 'candidate.txt'), 'utf8')).toBe('original');
      const events = jsonl(result.stdout);
      expect(events[0].approval).toBe('deny');
      expect(events.filter(event => event.type === 'tool_result')).toHaveLength(1);
      expect(JSON.stringify(events.filter(event => event.type === 'tool_result'))).toMatch(/denied|declined|cancelled/i);
    });
  }, 15_000);

  test.skipIf(process.platform === 'win32')('repeated SIGINT waits for a TERM-ignoring shell to settle', async () => {
    await fixture(body => completion(body, toolMessage('run_terminal_command', {
      command: `trap '' TERM; printf '%s' "$$" > shell.pid; printf ready > shell.ready; while :; do sleep 0.1; done`,
    }, 'interrupt-shell')), async ({root, run}) => {
      let sendSignal: ((signal: NodeJS.Signals) => void) | undefined;
      let shellPid: number | undefined;
      const pending = run({args: ['--approval', 'allow'], onStart: signal => {sendSignal = signal;}});
      try {
        const readyDeadline = Date.now() + 3000;
        while (true) {
          try {
            if (await readFile(join(root, 'shell.ready'), 'utf8') === 'ready') break;
          } catch { /* Wait only for this test-owned child marker. */ }
          if (Date.now() >= readyDeadline) throw new Error('Supervised shell did not start.');
          await Bun.sleep(10);
        }
        shellPid = Number(await readFile(join(root, 'shell.pid'), 'utf8'));
        expect(Number.isSafeInteger(shellPid) && shellPid > 1).toBe(true);
        sendSignal!('SIGINT');
        await Bun.sleep(50);
        sendSignal!('SIGINT');
        const result = await pending;
        expect(result.exit).toBe(130);
        const events = jsonl(result.stdout);
        expect(events.filter(event => event.type === 'run.interrupted')).toHaveLength(1);
        expect(events.at(-1).type).toBe('run.interrupted');
        let alive = true;
        try { process.kill(-shellPid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        expect(alive).toBe(false);
      } finally {
        sendSignal?.('SIGTERM');
        await pending;
        if (shellPid && Number.isSafeInteger(shellPid) && shellPid > 1) {
          try { process.kill(-shellPid, 'SIGKILL'); } catch { /* Already reaped. */ }
        }
      }
    });
  }, 15_000);

  test('max-rounds produces a nonzero run.limit_reached terminal receipt', async () => {
    await fixture((body, index) => completion(body, index === 1
      ? toolMessage('read_file', {path: 'candidate.txt'}, `read-${index}`)
      : {role: 'assistant', content: 'The allowed tool round is exhausted.'}), async ({root, bodies, run}) => {
      await writeFile(join(root, 'candidate.txt'), 'fixture');
      const result = await run({args: ['--max-rounds', '1']});
      expect(result.exit).toBe(1);
      // One tool round plus the existing tool-disabled finalizer request.
      expect(bodies).toHaveLength(2);
      expect(jsonl(result.stdout).filter(event => event.type === 'tool_result')).toHaveLength(1);
      expect(jsonl(result.stdout).at(-1)).toMatchObject({type: 'run.limit_reached', status: 'limit_reached'});
    });
  }, 15_000);
});
