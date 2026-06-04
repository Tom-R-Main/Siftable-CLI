import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  discoverLocalWorkspaces,
  getWorkspaceRoot,
  setSessionCwd,
} from '../../interactive-tui/navigation';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('interactive navigation state', () => {
  const previousCwd = process.env.SIFT_USER_CWD;
  const previousRoot = process.env.SIFT_WORKSPACE_ROOT;

  afterEach(() => {
    restoreEnv('SIFT_USER_CWD', previousCwd);
    restoreEnv('SIFT_WORKSPACE_ROOT', previousRoot);
  });

  it('keeps workspace root at the git root when session cwd is a package subdirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-nav-root-'));
    await mkdir(join(root, '.git'), {recursive: true});
    await mkdir(join(root, 'packages', 'exf-cli'), {recursive: true});
    process.env.SIFT_USER_CWD = join(root, 'packages', 'exf-cli');
    delete process.env.SIFT_WORKSPACE_ROOT;

    try {
      expect(getWorkspaceRoot()).toBe(root);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('retargets workspace root when changing to a sibling repo', async () => {
    const projects = await mkdtemp(join(tmpdir(), 'sift-nav-projects-'));
    const first = join(projects, 'first');
    const second = join(projects, 'second');
    await mkdir(join(first, '.git'), {recursive: true});
    await mkdir(join(first, 'packages', 'cli'), {recursive: true});
    await mkdir(join(second, '.git'), {recursive: true});
    process.env.SIFT_USER_CWD = join(first, 'packages', 'cli');
    process.env.SIFT_WORKSPACE_ROOT = first;

    try {
      const result = setSessionCwd('../../../second');
      expect(result.cwd).toBe(second);
      expect(result.workspaceRoot).toBe(second);
      expect(result.workspaceRootChanged).toBe(true);
      expect(process.env.SIFT_USER_CWD).toBe(second);
      expect(process.env.SIFT_WORKSPACE_ROOT).toBe(second);
    } finally {
      await rm(projects, {recursive: true, force: true});
    }
  });

  it('discovers nearby local workspaces with project signals', async () => {
    const projects = await mkdtemp(join(tmpdir(), 'sift-nav-discover-'));
    const wanted = join(projects, 'missionary-repo');
    const other = join(projects, 'other-repo');
    await mkdir(wanted, {recursive: true});
    await mkdir(join(other, '.git'), {recursive: true});
    await writeFile(join(wanted, 'package.json'), '{"name":"missionary-repo"}\n', 'utf8');

    try {
      const result = await discoverLocalWorkspaces({roots: [projects], query: 'missionary', maxDepth: 1});
      expect(result.matches[0].root).toBe(wanted);
      expect(result.matches[0].signals).toContain('package.json');
    } finally {
      await rm(projects, {recursive: true, force: true});
    }
  });
});
