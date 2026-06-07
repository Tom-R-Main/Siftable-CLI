import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  batchReadFiles,
  clearWorkspaceFileCache,
  codeSearch,
  contentHash,
  editText,
  findLocalFiles,
  inspectLocalWorkspace,
  readText,
  scanRepositoryManifest,
  searchLiteral,
  writeText,
} from '../../interactive-tui/fsEngine';

describe('sift interactive — fs engine fallback policy', () => {
  let root: string;

  beforeEach(async () => {
    clearWorkspaceFileCache();
    root = await mkdtemp(join(tmpdir(), 'sift-fs-engine-'));
    await mkdir(join(root, 'src'), {recursive: true});
    await mkdir(join(root, 'node_modules', 'dep'), {recursive: true});
    await mkdir(join(root, 'vendor', 'dep'), {recursive: true});
    await mkdir(join(root, 'dist'), {recursive: true});
    await mkdir(join(root, 'target'), {recursive: true});
    await mkdir(join(root, '.hidden'), {recursive: true});
    await writeFile(join(root, 'src', 'alpha.txt'), 'one\nneedle here\nthree\n', 'utf8');
    await writeFile(join(root, 'src', 'beta.txt'), 'needle again\n', 'utf8');
    await writeFile(join(root, 'src', 'brain.ts'), 'export function buildLocalTools() { return "needle"; }\n', 'utf8');
    await writeFile(join(root, 'src', 'positions.txt'), 'a\npin pin\nzz pin\n', 'utf8');
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await writeFile(join(root, 'node_modules', 'dep', 'ignored.txt'), 'needle in dependency\n', 'utf8');
    await writeFile(join(root, 'vendor', 'dep', 'ignored.txt'), 'needle in vendor\n', 'utf8');
    await writeFile(join(root, 'dist', 'generated.txt'), 'needle in dist\n', 'utf8');
    await writeFile(join(root, 'target', 'artifact.txt'), 'needle in target\n', 'utf8');
    await writeFile(join(root, '.hidden', 'ignored.txt'), 'needle hidden\n', 'utf8');
    await writeFile(join(root, 'large.txt'), `${'x'.repeat(128)}\n`, 'utf8');
    await writeFile(join(root, 'large-match.txt'), `${'x'.repeat(128)}bulkmarker\n`, 'utf8');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
  });

  afterEach(async () => {
    clearWorkspaceFileCache();
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

  it('can explicitly include vendor and build-output directories separately', async () => {
    const vendorResult = await searchLiteral(root, 'needle', {maxMatches: 10, includeVendor: true});
    expect(vendorResult.matches.map((match) => match.path).sort()).toEqual([
      'node_modules/dep/ignored.txt',
      'src/alpha.txt',
      'src/beta.txt',
      'src/brain.ts',
      'vendor/dep/ignored.txt',
    ]);

    const buildResult = await searchLiteral(root, 'needle', {maxMatches: 10, includeBuildOutputs: true});
    expect(buildResult.matches.map((match) => match.path).sort()).toEqual([
      'dist/generated.txt',
      'src/alpha.txt',
      'src/beta.txt',
      'src/brain.ts',
      'target/artifact.txt',
    ]);
  });

  it.each([
    [{}, ['src/alpha.txt', 'src/beta.txt', 'src/brain.ts']],
    [{includeHidden: true}, ['.hidden/ignored.txt', 'src/alpha.txt', 'src/beta.txt', 'src/brain.ts']],
    [{includeVendor: true}, ['node_modules/dep/ignored.txt', 'src/alpha.txt', 'src/beta.txt', 'src/brain.ts', 'vendor/dep/ignored.txt']],
    [{includeBuildOutputs: true}, ['dist/generated.txt', 'src/alpha.txt', 'src/beta.txt', 'src/brain.ts', 'target/artifact.txt']],
    [{includeHidden: true, includeVendor: true}, ['.hidden/ignored.txt', 'node_modules/dep/ignored.txt', 'src/alpha.txt', 'src/beta.txt', 'src/brain.ts', 'vendor/dep/ignored.txt']],
    [{includeHidden: true, includeBuildOutputs: true}, ['.hidden/ignored.txt', 'dist/generated.txt', 'src/alpha.txt', 'src/beta.txt', 'src/brain.ts', 'target/artifact.txt']],
    [{includeVendor: true, includeBuildOutputs: true}, ['dist/generated.txt', 'node_modules/dep/ignored.txt', 'src/alpha.txt', 'src/beta.txt', 'src/brain.ts', 'target/artifact.txt', 'vendor/dep/ignored.txt']],
    [{includeHidden: true, includeVendor: true, includeBuildOutputs: true}, ['.hidden/ignored.txt', 'dist/generated.txt', 'node_modules/dep/ignored.txt', 'src/alpha.txt', 'src/beta.txt', 'src/brain.ts', 'target/artifact.txt', 'vendor/dep/ignored.txt']],
  ] as Array<[Parameters<typeof searchLiteral>[2], string[]]>)('matches search policy flag combination %#', async (caps, expectedPaths) => {
    const result = await searchLiteral(root, 'needle', {maxMatches: 20, ...caps});
    expect(result.matches.map((match) => match.path).sort()).toEqual(expectedPaths);
  });

  it('honors gitignore only when a git context exists and exposes an override', async () => {
    const parent = join(root, 'parent');
    const plainRepo = join(parent, 'plain-repo');
    await mkdir(join(plainRepo, 'src'), {recursive: true});
    await writeFile(join(parent, '.gitignore'), '*\n', 'utf8');
    await writeFile(join(plainRepo, 'src', 'visible.txt'), 'parent ignored should not matter\n', 'utf8');

    const plain = await searchLiteral(plainRepo, 'parent ignored', {maxMatches: 10});
    expect(plain.matches.map((match) => match.path)).toEqual(['src/visible.txt']);

    await mkdir(join(root, '.git'), {recursive: true});
    await mkdir(join(root, '.vscode'), {recursive: true});
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n.vscode/*\n!.vscode/settings.json\n', 'utf8');
    await writeFile(join(root, 'ignored.txt'), 'git ignored needle\n', 'utf8');
    await writeFile(join(root, '.vscode', 'settings.json'), 'whitelisted hidden needle\n', 'utf8');
    await writeFile(join(root, '.vscode', 'extensions.json'), 'ignored hidden needle\n', 'utf8');

    const respected = await searchLiteral(root, 'git ignored', {maxMatches: 10});
    expect(respected.matches).toHaveLength(0);
    expect(respected.stats.skippedByReason.gitignore).toBeGreaterThan(0);

    const overridden = await searchLiteral(root, 'git ignored', {maxMatches: 10, respectGitignore: false});
    expect(overridden.matches.map((match) => match.path)).toEqual(['ignored.txt']);

    const hiddenAllowed = await searchLiteral(root, 'hidden needle', {maxMatches: 10, includeHidden: true});
    expect(hiddenAllowed.matches.map((match) => match.path)).toEqual(['.vscode/settings.json']);
  });

  it('reports binary, invalid UTF-8, and too-large skips separately', async () => {
    const result = await searchLiteral(root, 'needle', {maxMatches: 20, maxFileBytes: 64});

    expect(result.stats.skippedByReason.binary).toBe(1);
    expect(result.stats.skippedByReason.invalidUtf8).toBe(1);
    expect(result.stats.skippedByReason.tooLarge).toBe(2);
    expect(result.stats.capped).toBe(false);
    expect(result.stats.capReason).toBeNull();
    expect(result.stats.bytesScanned).toBeGreaterThan(0);
  });

  it('honors maxFileBytes overrides for large text files', async () => {
    const blocked = await searchLiteral(root, 'bulkmarker', {maxMatches: 10, maxFileBytes: 64});
    expect(blocked.matches).toHaveLength(0);
    expect(blocked.stats.skippedByReason.tooLarge).toBeGreaterThanOrEqual(1);
    expect(blocked.stats.capReason).toBeNull();

    const allowed = await searchLiteral(root, 'bulkmarker', {maxMatches: 10, maxFileBytes: 512});
    expect(allowed.matches.map((match) => match.path)).toEqual(['large-match.txt']);
    expect(allowed.stats.capReason).toBeNull();
  });

  it('reports cap reasons for maxMatches and maxFiles', async () => {
    const byMatches = await searchLiteral(root, 'needle', {maxMatches: 1});
    expect(byMatches.stats.capped).toBe(true);
    expect(byMatches.stats.capReason).toBe('maxMatches');

    const capRoot = join(root, 'cap-files');
    await mkdir(capRoot, {recursive: true});
    await writeFile(join(capRoot, 'one.txt'), 'absent here\n', 'utf8');
    await writeFile(join(capRoot, 'two.txt'), 'absent there\n', 'utf8');
    const byFiles = await searchLiteral(capRoot, 'absent', {maxFiles: 1, maxMatches: 100});
    expect(byFiles.stats.capped).toBe(true);
    expect(byFiles.stats.capReason).toBe('maxFiles');
  });

  it('supports cheaper detail levels for broad search', async () => {
    const paths = await searchLiteral(root, 'pin', {maxMatches: 10, detail: 'paths'});
    expect(paths.matches).toEqual([
      {path: 'src/positions.txt', line: 0, column: 0, byteStart: 0, byteEnd: 0, preview: ''},
    ]);

    const locations = await searchLiteral(root, 'pin', {maxMatches: 10, detail: 'locations'});
    expect(locations.matches.map((match) => match.preview)).toEqual(['', '', '']);
    expect(locations.matches.map((match) => ({line: match.line, column: match.column}))).toEqual([
      {line: 2, column: 1},
      {line: 2, column: 5},
      {line: 3, column: 4},
    ]);

    const snippets = await searchLiteral(root, 'pin', {maxMatches: 10, detail: 'snippets'});
    expect(snippets.matches.every((match) => match.preview.includes('pin'))).toBe(true);
  });

  it('uses an amortized cursor for multi-match line and byte-column metadata', async () => {
    const result = await searchLiteral(root, 'pin', {maxMatches: 10});
    const positions = result.matches
      .filter((match) => match.path === 'src/positions.txt')
      .map((match) => ({line: match.line, column: match.column, byteStart: match.byteStart, byteEnd: match.byteEnd}));

    expect(positions).toEqual([
      {line: 2, column: 1, byteStart: 2, byteEnd: 5},
      {line: 2, column: 5, byteStart: 6, byteEnd: 9},
      {line: 3, column: 4, byteStart: 13, byteEnd: 16},
    ]);
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

  it('emits a deterministic repository scan manifest with the shared traversal policy', async () => {
    const manifest = await scanRepositoryManifest(root, {maxFiles: 100, maxDepth: 8, maxFileBytes: 64, sourceOnly: false});

    expect(manifest.source).toBe('ts');
    expect(manifest.files.map((file) => file.path)).toEqual([
      'package.json',
      'src/alpha.txt',
      'src/beta.txt',
      'src/brain.ts',
      'src/positions.txt',
    ]);
    expect(manifest.stats.scannedFiles).toBe(5);
    expect(manifest.stats.skippedByReason.vendor).toBeGreaterThanOrEqual(2);
    expect(manifest.stats.skippedByReason.buildOutput).toBeGreaterThanOrEqual(2);
    expect(manifest.stats.skippedByReason.hidden).toBeGreaterThanOrEqual(1);
    expect(manifest.stats.skippedByReason.binary).toBe(1);
    expect(manifest.stats.skippedByReason.invalidUtf8).toBe(1);
    expect(manifest.stats.bytesScanned).toBeGreaterThan(0);
  });

  it('finds files by path/name separately from content search', async () => {
    const result = await findLocalFiles({root, query: 'brain', limit: 10});

    expect(result.matches[0].path).toBe('src/brain.ts');
    expect(result.matches[0].indices.length).toBeGreaterThan(0);
  });

  it('uses the same gitignore-aware traversal for path and code search', async () => {
    await mkdir(join(root, '.git'), {recursive: true});
    await writeFile(join(root, '.gitignore'), 'src/ignored.ts\n', 'utf8');
    await writeFile(join(root, 'src', 'ignored.ts'), 'export const ignoredSymbol = "ignored literal";\n', 'utf8');

    const paths = await findLocalFiles({root, query: 'ignored', limit: 10});
    expect(paths.matches.map((match) => match.path)).not.toContain('src/ignored.ts');

    const pathOverride = await findLocalFiles({root, query: 'ignored', limit: 10, respectGitignore: false});
    expect(pathOverride.matches.map((match) => match.path)).toContain('src/ignored.ts');

    const code = await codeSearch({root, intent: 'find ignored literal', queries: ['ignored literal'], forceRefresh: true});
    expect(code.spans.map((span) => span.path)).not.toContain('src/ignored.ts');

    const codeOverride = await codeSearch({root, intent: 'find ignored literal', queries: ['ignored literal'], respectGitignore: false, forceRefresh: true});
    expect(codeOverride.spans.map((span) => span.path)).toContain('src/ignored.ts');
  });

  it('reuses and invalidates the session workspace file cache', async () => {
    const cold = await findLocalFiles({root, query: 'brain', limit: 10});
    const warm = await findLocalFiles({root, query: 'alpha', limit: 10});

    expect(cold.stats.cacheHit).toBe(false);
    expect(warm.stats.cacheHit).toBe(true);
    expect(warm.stats.fileSetId).toBe(cold.stats.fileSetId);

    await writeText(join(root, 'src', 'cache-new.ts'), 'export const cacheNew = true;\n', {root});
    const afterWrite = await findLocalFiles({root, query: 'cache-new', limit: 10});

    expect(afterWrite.stats.cacheHit).toBe(false);
    expect(afterWrite.stats.fileSetId).not.toBe(cold.stats.fileSetId);
    expect(afterWrite.matches[0].path).toBe('src/cache-new.ts');
  });

  it('ranks broad code search spans and suggests batch reads', async () => {
    const result = await codeSearch({root, intent: 'where is buildLocalTools used', queries: ['buildLocalTools']});

    expect(result.spans[0].path).toBe('src/brain.ts');
    expect(result.stats.fileSetId).toBeTruthy();
    expect(result.stats.eligibleFiles).toBeGreaterThan(0);
    expect(result.stats.phaseTimings).toEqual(expect.objectContaining({
      totalWallMs: expect.any(Number),
      cacheLookupWallMs: expect.any(Number),
      fileSetBuildWallMs: expect.any(Number),
      fileSetStatWallMs: expect.any(Number),
      fileSetReadWallMs: expect.any(Number),
      searchWallMs: expect.any(Number),
      searchReadWallMs: expect.any(Number),
      searchScanWallMs: expect.any(Number),
      shapeWallMs: expect.any(Number),
      previewWallMs: expect.any(Number),
    }));
    expect(result.stats.phaseTimings?.totalWallMs).toBeGreaterThanOrEqual(0);
    expect(result.followups[0]).toMatchObject({
      tool: 'batch_read_files',
      args: expect.objectContaining({path: 'src/brain.ts'}),
    });
  });

  it('can force-refresh code search file-set cache and opt into content cache diagnostics', async () => {
    const cold = await codeSearch({root, intent: 'where is buildLocalTools used', queries: ['buildLocalTools']});
    const forced = await codeSearch({
      root,
      intent: 'where is buildLocalTools used',
      queries: ['buildLocalTools'],
      forceRefresh: true,
    });

    expect(cold.stats.cacheHit).toBe(false);
    expect(forced.stats.cacheHit).toBe(false);

    clearWorkspaceFileCache(root);
    const first = await codeSearch({
      root,
      intent: 'where is buildLocalTools used',
      queries: ['buildLocalTools'],
      useContentCache: true,
    });
    const second = await codeSearch({
      root,
      intent: 'where is needle used',
      queries: ['needle'],
      useContentCache: true,
    });

    expect(first.stats.contentCache).toMatchObject({enabled: true});
    expect(first.stats.contentCache?.missFiles).toBeGreaterThan(0);
    expect(second.stats.contentCache).toMatchObject({enabled: true});
    expect(second.stats.contentCache?.hitFiles).toBeGreaterThan(0);
    expect(second.stats.contentCache?.hitBytes).toBeGreaterThan(0);
    expect(first.stats.contentCache?.storedBytes).toBeGreaterThan(0);
    expect(second.stats.contentCache?.currentBytes).toBeGreaterThan(0);
    expect(second.stats.contentCache?.evictions).toBeGreaterThanOrEqual(0);
    expect(second.stats.contentCache?.skippedTooLarge).toBeGreaterThanOrEqual(0);
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

describe('sift interactive — fs engine write/edit (A1 fallback)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sift-fs-write-'));
    await writeFile(join(root, 'note.txt'), 'hello world\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, {recursive: true, force: true});
  });

  it('writes a new file and reports it as created', async () => {
    const target = join(root, 'fresh.txt');
    const result = await writeText(target, 'brand new\n', {root});

    expect(result.source).toBe('ts');
    expect(result.created).toBe(true);
    expect(result.bytesWritten).toBe(Buffer.byteLength('brand new\n'));
    expect((await readFile(target)).toString('utf8')).toBe('brand new\n');
  });

  it('overwrites an existing file and reports it as not created', async () => {
    const target = join(root, 'note.txt');
    const result = await writeText(target, 'replaced\n', {root});

    expect(result.created).toBe(false);
    expect((await readFile(target)).toString('utf8')).toBe('replaced\n');
  });

  it('refuses to clobber an existing file in create-only mode', async () => {
    await expect(writeText(join(root, 'note.txt'), 'no\n', {root, createOnly: true})).rejects.toThrow(/already exists/);
  });

  it('creates parent directories when makePath is set', async () => {
    const target = join(root, 'nested', 'deep', 'file.txt');
    await writeText(target, 'deep\n', {root, makePath: true});
    expect((await readFile(target)).toString('utf8')).toBe('deep\n');
  });

  it('rejects writes outside the writable root', async () => {
    const outside = join(tmpdir(), 'sift-escape-should-not-exist.txt');
    await expect(writeText(outside, 'nope\n', {root})).rejects.toThrow(/outside the writable root/);
  });

  it('rejects path traversal even with a matching prefix', async () => {
    await expect(writeText(join(root, '..', 'escape.txt'), 'nope\n', {root})).rejects.toThrow(/outside the writable root/);
  });

  it('applies a unique exact-match edit', async () => {
    const target = join(root, 'note.txt');
    const result = await editText(target, 'world', 'there', {root});

    expect(result.source).toBe('ts');
    expect(result.replacements).toBe(1);
    expect((await readFile(target)).toString('utf8')).toBe('hello there\n');
  });

  it('rejects an edit whose old text is not found', async () => {
    await expect(editText(join(root, 'note.txt'), 'absent', 'x', {root})).rejects.toThrow(/no match/);
  });

  it('rejects an ambiguous edit by default and allows it when uniqueness is off', async () => {
    const target = join(root, 'dup.txt');
    await writeFile(target, 'aa\n', 'utf8');
    await expect(editText(target, 'a', 'b', {root})).rejects.toThrow(/ambiguous/);

    const result = await editText(target, 'a', 'b', {root, requireUnique: false});
    expect(result.replacements).toBe(2);
    expect((await readFile(target)).toString('utf8')).toBe('bb\n');
  });

  it('honors a freshness token and refuses a stale edit', async () => {
    const target = join(root, 'note.txt');
    const original = (await readFile(target)).toString('utf8');
    const goodHash = contentHash(original);

    // Matching hash → edit proceeds.
    await editText(target, 'hello', 'hi', {root, expectedHash: goodHash});
    expect((await readFile(target)).toString('utf8')).toBe('hi world\n');

    // A wrong hash → stale, edit refused.
    await expect(editText(target, 'world', 'earth', {root, expectedHash: goodHash})).rejects.toThrow(/stale/);
  });

  it('rejects edits outside the writable root', async () => {
    const outside = join(tmpdir(), 'sift-edit-escape.txt');
    await writeFile(outside, 'x\n', 'utf8');
    try {
      await expect(editText(outside, 'x', 'y', {root})).rejects.toThrow(/outside the writable root/);
    } finally {
      await rm(outside, {force: true});
    }
  });
});
