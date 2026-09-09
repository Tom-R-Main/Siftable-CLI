import * as filesystem from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {clearWorkspaceFileCache, codeSearch, findLocalFiles, searchLiteral, scanRepositoryManifest} from '../../interactive-tui/fsEngine';
import {globLocalFilesForExplorer, grepLocalFilesForExplorer} from '../../interactive-tui/explorer';

describe('search completeness survives collection, shaping and caching', () => {
  let root: string;
  beforeEach(async () => {
    clearWorkspaceFileCache();
    root = await filesystem.mkdtemp(join(tmpdir(), 'sift-search-complete-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks(); clearWorkspaceFileCache();
    await filesystem.rm(root, {recursive: true, force: true});
  });
  const file = (name: string, content = 'nothing here\n') => filesystem.writeFile(join(root, name), content);

  it('distinguishes complete zero from capped zero and excluded scope', async () => {
    await file('a.ts'); await file('b.ts', 'needle\n');
    const complete = await searchLiteral(root, 'absent');
    expect(complete.stats.scan).toEqual({status: 'complete', reasons: []});
    expect(complete.matches).toEqual([]);
    const capped = await searchLiteral(root, 'needle', {maxFiles: 1});
    expect(capped.matches).toEqual([]);
    expect(capped.stats.scan).toEqual({status: 'partial', reasons: ['maxFiles']});
    await filesystem.mkdir(join(root, 'node_modules')); await file('node_modules/hidden.ts', 'secret needle');
    const excluded = await searchLiteral(root, 'secret');
    expect(excluded.stats.scan.status).toBe('complete');
    expect(excluded.stats.skippedByReason.vendor).toBe(1);
  });

  it('rejects file and missing roots before returning misleading absence', async () => {
    await file('a.ts');
    for (const badRoot of [join(root, 'a.ts'), join(root, 'missing')]) {
      await expect(searchLiteral(badRoot, 'x')).rejects.toThrow();
      await expect(codeSearch({root: badRoot, intent: 'x'})).rejects.toThrow();
      await expect(findLocalFiles({root: badRoot, query: 'x'})).rejects.toThrow();
      await expect(scanRepositoryManifest(badRoot)).rejects.toThrow();
    }
  });

  it('keeps an IO omission partial through code search and the file-set cache', async () => {
    await file('a.ts'); await file('b.ts');
    const originalRead = filesystem.readFile;
    jest.spyOn(jest.requireActual('node:fs/promises'), 'readFile').mockImplementation(((path: unknown, ...args: unknown[]) => {
      if (String(path) === join(root, 'b.ts')) return Promise.reject(Object.assign(new Error('fixture read failure'), {code: 'EIO'}));
      return (originalRead as (...values: unknown[]) => unknown)(path, ...args);
    }) as typeof filesystem.readFile);
    const first = await codeSearch({root, intent: 'missing', queries: ['missing']});
    expect(first.stats.scan.status).toBe('partial'); expect(first.stats.scan.reasons).toContain('ioError');
    expect(first.stats.skippedByReason.ioError).toBe(1);
    first.stats.scan.reasons.push('caller-mutation'); first.stats.skippedByReason.ioError = 99;
    const cached = await findLocalFiles({root, query: 'missing', maxFiles: 2000});
    expect(cached.stats.cacheHit).toBe(true); expect(cached.stats.scan.reasons).toEqual(['ioError']);
    expect(cached.stats.skippedByReason.ioError).toBe(1);
  });

  it('keeps output selection separate from complete scanning in find/code/glob', async () => {
    await file('alpha.ts', 'needle\n'); await file('alpha-two.ts', 'needle\n'); await file('alpha-three.ts', 'needle\n');
    const found = await findLocalFiles({root, query: 'alpha', limit: 1});
    expect(found.matches).toHaveLength(1); expect(found.stats.scan.status).toBe('complete');
    expect(found.stats.presentation).toEqual({clipped: true, reasons: ['limit']});
    const code = await codeSearch({root, intent: 'needle', queries: ['needle'], maxSpans: 1});
    expect(code.stats.scan.status).toBe('complete'); expect(code.stats.presentation.reasons).toContain('maxSpans');
    const glob = await globLocalFilesForExplorer({root, pattern: '*.ts', maxFiles: 1});
    expect(glob.stats.scan.status).toBe('complete'); expect(glob.stats.presentation.clipped).toBe(true);
  });

  it('retains query scan caps even when selected spans collapse to one', async () => {
    await file('a.ts', 'needle '.repeat(30));
    const result = await codeSearch({root, intent: 'needle', queries: ['needle'], maxSpans: 1});
    expect(result.stats.scan).toEqual({status: 'partial', reasons: ['maxMatches']});
    expect(result.spans).toHaveLength(1);
  });

  it('treats file byte and UTF-8 omissions as partial rather than proven zero', async () => {
    await file('a.ts', 'x'.repeat(20));
    const capped = await searchLiteral(root, 'needle', {maxFileBytes: 5});
    expect(capped.stats.scan.reasons).toContain('tooLarge'); expect(capped.matches).toEqual([]);
    await filesystem.writeFile(join(root, 'b.ts'), Buffer.from([0xff]));
    const invalid = await codeSearch({root, intent: 'needle'});
    expect(invalid.stats.scan.reasons).toContain('invalidUtf8');
  });

  it('returns cancellation metadata without caching it as a complete empty scan', async () => {
    await file('a.ts', 'needle'); const controller = new AbortController(); controller.abort();
    for (const result of [await searchLiteral(root, 'needle', {signal: controller.signal}), await codeSearch({root, intent: 'needle', signal: controller.signal}), await findLocalFiles({root, query: 'a', signal: controller.signal})]) {
      expect(result.stats.scan.status).toBe('cancelled'); expect(result.stats.scan.reasons).toContain('cancelled');
    }
    const fresh = await findLocalFiles({root, query: 'a'});
    expect(fresh.stats.scan.status).toBe('complete'); expect(fresh.matches).toHaveLength(1);
  });

  it('retains grep read clipping and match cap as partial scan metadata', async () => {
    await file('a.ts', 'x'.repeat(100000) + 'needle');
    const clipped = await grepLocalFilesForExplorer({root, pattern: 'needle'});
    expect(clipped.matches).toEqual([]); expect(clipped.stats.scan.reasons).toContain('maxBytes');
    await file('a.ts', 'needle\nneedle\n'); clearWorkspaceFileCache();
    const capped = await grepLocalFilesForExplorer({root, pattern: 'needle', maxMatches: 1});
    expect(capped.stats.scan.reasons).toContain('maxMatches');
  });
  it('rejects empty compiled queries and records omitted explicit queries as partial', async () => {
    await file('a.ts', 'needle');
    await expect(codeSearch({root, intent: 'find'})).rejects.toThrow(/literal query/);
    const result = await codeSearch({root, intent: '', queries: [...Array.from({length: 8}, (_, index) => `absent${index}`), 'needle']});
    expect(result.spans).toEqual([]); expect(result.stats.scan).toEqual({status: 'partial', reasons: ['maxQueries']});
  });

  it('rejects invalid limits instead of allowing NaN or native integer wrapping', async () => {
    for (const maxFiles of [0, -1, NaN, Infinity, 0x1_0000_0000]) {
      await expect(searchLiteral(root, 'needle', {maxFiles})).rejects.toThrow(/integer/);
      await expect(codeSearch({root, intent: 'needle', maxFiles})).rejects.toThrow(/integer/);
      await expect(findLocalFiles({root, query: 'needle', maxFiles})).rejects.toThrow(/integer/);
      await expect(grepLocalFilesForExplorer({root, pattern: 'needle', maxFiles})).rejects.toThrow(/integer/);
    }
  });

  it('marks a clipped literal preview without claiming that scanning was partial', async () => {
    await file('a.ts', 'before '.repeat(20) + 'needle' + ' after'.repeat(20));
    const result = await searchLiteral(root, 'needle', {previewBytes: 8});
    expect(result.stats.scan.status).toBe('complete');
    expect(result.stats.presentation).toEqual({clipped: true, reasons: ['previewBytes']});
  });

});
