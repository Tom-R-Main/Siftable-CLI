import {spawn} from 'node:child_process';

export interface BoundedProcessResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export async function runBoundedStdioProcess(input: {
  executable: string;
  args: string[];
  stdin?: string | Buffer;
  stdoutLimit: number;
  stderrLimit?: number;
  timeoutMs?: number;
  operation: string;
}): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {PATH: '/usr/bin:/bin'},
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (result: BoundedProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    timer = setTimeout(() => {
      fail(new Error(`${input.operation} timed out`));
      child.kill('SIGKILL');
    }, input.timeoutMs ?? 10_000);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > input.stdoutLimit) {
        fail(new Error(`${input.operation} returned too much data`));
        child.kill('SIGKILL');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > (input.stderrLimit ?? 4096)) {
        fail(new Error(`${input.operation} returned too much error output`));
        child.kill('SIGKILL');
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('close', code => {
      finish({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.stdin.end(input.stdin);
  });
}
