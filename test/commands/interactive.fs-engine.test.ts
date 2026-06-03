import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  batchReadFiles,
  codeSearch,
  findLocalFiles,
  inspectLocalWorkspace,
  readText,
  searchLiteral,
} from '../../interactive-tui/fsEngine';

describe('sift interactive — fs engine fallback policy', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sift-fs-engine-'));
    await mkdir(join(root, 'src'), {recursive: true});
    await mkdir(join(root, 'node_modules', 'dep'), {recursive: true});
    await mkdir(join(root, '.hidden'), {recursive: true});
    await writeFile(join(root, 'src', 'alpha.txt'), 'one\nneedle here\nthree\n', 'utf8');
    await writeFile(join(root, 'src', 'beta.txt'), 'needle again\n', 'utf8');
    await writeFile(join(root, 'src', 'brain.ts'), 'export function buildLocalTools() { return "needle"; }\n', 'utf8');
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await writeFile(join(root, 'node_modules', 'dep', 'ignored.txt'), 'needle in dependency\n', 'utf8');
    await writeFile(join(root, '.hidden', 'ignored.txt'), 'needle hidden\n', 'utf8');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  it('reads bounded UTF-8 text and reports truncation', async () => {
    const result = await readText(join(root, 'src', 'alpha.txt'), 8);

    expect(result.source).toBe('ts');
    expect(result.content).toBe('one\nneed');
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(8);
  });

  it('searches literal text while skipping noisy, hidden, and binary files', async () => {
    const result = await searchLiteral(root, 'needle', {maxMatches: 10});

    expect(result.source).toBe('ts');
    expect(result.matches.map((match) => match.path).sort()).toEqual([
      'src/alpha.txt',
      'src/beta.txt',
      'src/brain.ts',
    ]);
    expect(result.stats.matches).toBe(3);
    expect(result.stats.skippedFiles).toBeGreaterThanOrEqual(3);
  });

  it('respects maxMatches and reports truncation', async () => {
    const result = await searchLiteral(root, 'needle', {maxMatches: 1});

    expect(result.matches).toHaveLength(1);
    expect(result.stats.truncated).toBe(1);
  });

  it('summarizes workspace shape without reading noisy directories', async () => {
    const result = await inspectLocalWorkspace(root);

    expect(result.languages.some((lang) => lang.language === 'typescript')).toBe(true);
    expect(result.keyFiles.map((file) => file.path)).toContain('package.json');
    expect(result.symbols.some((symbol) => symbol.symbol === 'buildLocalTools')).toBe(true);
    expect(result.stats.scannedFiles).toBeGreaterThan(0);
  });

  it('finds files by path/name separately from content search', async () => {
    const result = await findLocalFiles({root, query: 'brain', limit: 10});

    expect(result.matches[0].path).toBe('src/brain.ts');
    expect(result.matches[0].indices.length).toBeGreaterThan(0);
  });

  it('ranks broad code search spans and suggests batch reads', async () => {
    const result = await codeSearch({root, intent: 'where is buildLocalTools used', queries: ['buildLocalTools']});

    expect(result.spans[0].path).toBe('src/brain.ts');
    expect(result.followups[0]).toMatchObject({
      tool: 'batch_read_files',
      args: expect.objectContaining({path: 'src/brain.ts'}),
    });
  });

  it('reads several file ranges in one bounded call', async () => {
    const result = await batchReadFiles([
      {path: 'src/alpha.txt', startLine: 2, endLine: 2},
      {path: 'src/brain.ts', startLine: 1, endLine: 1},
    ], root);

    expect(result.files).toHaveLength(2);
    expect(result.files[0].content).toContain('2: needle here');
    expect(result.files[1].content).toContain('buildLocalTools');
  });
});
