import {describe, expect, it} from 'vitest';
import {INPUT_ROOT, servicePath, serviceUnit} from './supervisorService.js';

describe('servicePath', () => {
  const identity = (file: string) => file;

  it('accepts absolute paths outside any home', () => {
    expect(servicePath('/usr/local/bin/node', 'node', identity)).toBe('/usr/local/bin/node');
  });

  it('refuses relative paths, home paths, and links that resolve into a home', () => {
    expect(() => servicePath('node', 'node', identity)).toThrow(/absolute/);
    expect(() => servicePath('/root/.nvm/versions/node/v22/bin/node', 'node', identity)).toThrow(/home directory/);
    expect(() => servicePath('/home/ubuntu/sift/bin/run.js', 'CLI', identity)).toThrow(/home directory/);
    expect(() => servicePath('/usr/local/bin/sift', 'CLI', () => '/home/ubuntu/.npm-global/lib/sift/bin/run.js')).toThrow(/home directory/);
  });
});

describe('serviceUnit', () => {
  it('starts the named binaries directly, with homes hidden', () => {
    const unit = serviceUnit({node: '/usr/bin/node', cli: '/usr/lib/node_modules/@siftable/cli/bin/run.js'});
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@siftable/cli/bin/run.js machine supervise\n');
    for (const line of ['ProtectHome=yes', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'Restart=on-failure', 'Slice=siftable.slice',
      'Requires=docker.service']) {
      expect(unit).toContain(`${line}\n`);
    }
    expect(unit).not.toMatch(/Environment=.*PATH|nvm/);
  });

  // Native run 2026-10-30: RuntimeDirectory emptied the kept agent log, patch and install log on every unit restart.
  it('keeps attempt inputs and kept evidence on storage a restart or reboot does not empty', () => {
    const unit = serviceUnit({node: '/usr/bin/node', cli: '/usr/lib/node_modules/@siftable/cli/bin/run.js'});
    expect(unit).not.toMatch(/^(RuntimeDirectory|StateDirectory|CacheDirectory|LogsDirectory|TemporaryFileSystem)/m);
    expect(INPUT_ROOT).toMatch(/^\/var\/lib\/siftable\/[a-z]+$/);
    expect(INPUT_ROOT).not.toMatch(/^\/(run|tmp|var\/run|var\/tmp|dev\/shm)(\/|$)/);
  });
});
