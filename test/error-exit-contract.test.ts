import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

describe('CLI error exit contract', () => {
  it('uses the JSON parser error code as the process exit code', () => {
    const cliRoot = process.cwd();
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(cliRoot, 'bin/run.js'),
        'tasks',
        'bulk-delete',
        '--phase',
        'definitely_invalid',
        '--json',
        '--no-input',
      ],
      {
        cwd: cliRoot,
        encoding: 'utf8',
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        exit: 2,
      },
    });
  });
});
