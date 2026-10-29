import {describe, expect, it} from 'vitest';
import {servicePath, serviceUnit} from './supervisorService.js';

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
  it('starts the named binaries directly, with homes hidden and the runtime input directory created', () => {
    const unit = serviceUnit({node: '/usr/bin/node', cli: '/usr/lib/node_modules/@siftable/cli/bin/run.js'});
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@siftable/cli/bin/run.js machine supervise\n');
    for (const line of ['ProtectHome=yes', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'Restart=on-failure', 'Slice=siftable.slice',
      'RuntimeDirectory=siftable-attempts', 'Requires=docker.service']) {
      expect(unit).toContain(`${line}\n`);
    }
    expect(unit).not.toMatch(/Environment=.*PATH|nvm/);
  });
});
