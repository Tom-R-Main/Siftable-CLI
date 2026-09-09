import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

describe('native mutation receipt contract', () => {
  let root: string;
  let path: string;
  let savedBun: unknown;
  let savedNoNative: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sift-native-mutation-'));
    path = join(root, 'file.txt');
    await writeFile(path, 'foo');
    savedBun = (globalThis as any).Bun;
    savedNoNative = process.env.SIFT_NO_NATIVE;
    (globalThis as any).Bun = {};
    delete process.env.SIFT_NO_NATIVE;
    jest.resetModules();
  });

  afterEach(async () => {
    jest.dontMock('../../interactive-tui/native/fs_engine');
    jest.dontMock('bun:ffi');
    if (savedBun === undefined) delete (globalThis as any).Bun;
    else (globalThis as any).Bun = savedBun;
    if (savedNoNative === undefined) delete process.env.SIFT_NO_NATIVE;
    else process.env.SIFT_NO_NATIVE = savedNoNative;
    await rm(root, {recursive: true, force: true});
  });

  function load(edit: jest.Mock, write: jest.Mock, version: number | 'missing' = 1) {
    const close = jest.fn();
    jest.doMock('../../interactive-tui/native/fs_engine', () => ({default: path}), {virtual: true});
    jest.doMock('bun:ffi', () => ({
      FFIType: {ptr: 0, u32: 1},
      dlopen: (_path: string, definitions: Record<string, unknown>) => {
        if ('sift_fs_mutation_abi_version' in definitions) {
          if (version === 'missing') throw new Error('Missing mutation ABI symbol');
          return {symbols: {sift_fs_mutation_abi_version: () => version}, close};
        }
        return {symbols: {sift_fs_edit_text: edit, sift_fs_write_text: write}};
      },
    }), {virtual: true});
    let engine!: typeof import('../../interactive-tui/fsEngine');
    jest.isolateModules(() => {engine = require('../../interactive-tui/fsEngine');});
    return {engine, close};
  }

  it.each(['missing', 0, 2] as const)('never invokes mutations from unapproved ABI %s', async version => {
    const edit = jest.fn();
    const write = jest.fn();
    const {engine, close} = load(edit, write, version);
    expect((await engine.editText(path, 'foo', 'foobar', {root})).source).toBe('ts');
    expect(await readFile(path, 'utf8')).toBe('foobar');
    expect((await engine.writeText(path, 'replacement', {root})).source).toBe('ts');
    expect(edit).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(version === 'missing' ? 0 : 1);
  });

  it.each(['edit', 'write'] as const)('%s retries a certified pre-write buffer refusal, then commits once', async kind => {
    let commits = 0;
    const mutate = jest.fn((...args: any[]) => {
      if (mutate.mock.calls.length === 1) {
        expect(require('node:fs').readFileSync(path, 'utf8')).toBe('foo');
        args[10][0] = 6000;
        return 9;
      }
      commits += 1;
      writeFileSync(path, 'foobar');
      const bytes = Buffer.from(JSON.stringify({path, bytesWritten: 6, replacements: 1, created: false, newHash: 123}));
      args[7].set(bytes); args[9][0] = bytes.length;
      return 0;
    });
    const {engine} = load(mutate, mutate);
    const result = kind === 'edit'
      ? await engine.editText(path, 'foo', 'foobar', {root})
      : await engine.writeText(path, 'foobar', {root});
    expect(result.source).toBe('zig');
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(commits).toBe(1);
    expect(await readFile(path, 'utf8')).toBe('foobar');
  });

  it.each(['edit', 'write'] as const)('%s exhausts sizing without switching to TS', async kind => {
    const mutate = jest.fn(() => 9);
    const {engine} = load(mutate, mutate);
    const promise = kind === 'edit'
      ? engine.editText(path, 'foo', 'foobar', {root})
      : engine.writeText(path, 'foobar', {root});
    await expect(promise).rejects.toThrow(/receipt remained too small/);
    await expect(promise).rejects.toMatchObject({mutationState: 'not_applied'});
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(await readFile(path, 'utf8')).toBe('foo');
  });

  it.each(['edit', 'write'] as const)('%s stops after a committed result cannot be decoded', async kind => {
    const mutate = jest.fn((...args: any[]) => {
      writeFileSync(path, 'foobar');
      args[7][0] = 123; args[9][0] = 1; // Invalid JSON after a possible commit.
      return 0;
    });
    const {engine} = load(mutate, mutate);
    const promise = kind === 'edit'
      ? engine.editText(path, 'foo', 'foobar', {root})
      : engine.writeText(path, 'foobar', {root});
    await expect(promise).rejects.toMatchObject({mutationState: 'applied'});
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await readFile(path, 'utf8')).toBe('foobar');
  });

  it.each(['edit', 'write'] as const)('%s preserves unknown errors after possible effects', async kind => {
    const mutate = jest.fn(() => {writeFileSync(path, 'foobar'); throw new Error('Native invocation lost');});
    const {engine} = load(mutate, mutate);
    const promise = kind === 'edit'
      ? engine.editText(path, 'foo', 'foobar', {root})
      : engine.writeText(path, 'foobar', {root});
    await expect(promise).rejects.toThrow('Native invocation lost');
    await expect(promise).rejects.toMatchObject({mutationState: 'unknown'});
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await readFile(path, 'utf8')).toBe('foobar');
  });

  it.each(['edit', 'write'] as const)('%s never retries a native IO failure or falls back after it', async kind => {
    const mutate = jest.fn(() => {writeFileSync(path, 'foobar'); return 13;});
    const {engine} = load(mutate, mutate);
    const promise = kind === 'edit'
      ? engine.editText(path, 'foo', 'foobar', {root})
      : engine.writeText(path, 'foobar', {root});
    const error = await promise.catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(engine.AmbiguousEditError);
    expect(error.mutationState).toBe('unknown');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await readFile(path, 'utf8')).toBe('foobar');
  });

  it.each(['edit', 'write'] as const)('TS %s records applied when cache delivery fails after rename', async kind => {
    const mutate = jest.fn();
    const {engine} = load(mutate, mutate, 'missing');
    const fs = require('node:fs/promises') as typeof import('node:fs/promises');
    const rename = fs.rename;
    let clear: jest.SpyInstance | undefined;
    const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      clear = jest.spyOn(Map.prototype, 'clear').mockImplementationOnce(() => {throw new Error('Cache delivery failed');});
    });
    let failure: unknown;
    try {
      failure = await (kind === 'edit'
        ? engine.editText(path, 'foo', 'foobar', {root})
        : engine.writeText(path, 'foobar', {root})).catch(value => value);
    } finally {
      clear?.mockRestore();
      renameSpy.mockRestore();
    }
    expect(failure).toBeInstanceOf(engine.MutationReceiptError);
    expect(failure).toMatchObject({mutationState: 'applied', message: 'Cache delivery failed'});
    expect(mutate).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe('foobar');
  });

  it.each([[12], [9, 12]])('types pre-write ambiguous rejection after statuses %j', async (...statuses: number[]) => {
    await writeFile(path, 'repeat repeat');
    const pending = [...statuses];
    const mutate = jest.fn(() => pending.shift());
    const {engine} = load(mutate, mutate);
    await expect(engine.editText(path, 'repeat', 'new', {root})).rejects.toBeInstanceOf(engine.AmbiguousEditError);
    expect(mutate).toHaveBeenCalledTimes(statuses.length);
    expect(await readFile(path, 'utf8')).toBe('repeat repeat');
  });

  it('bounds a native requested receipt allocation', async () => {
    const mutate = jest.fn((...args: any[]) => {args[10][0] = 0xffffffff; return 9;});
    const {engine} = load(mutate, mutate);
    await expect(engine.editText(path, 'foo', 'foobar', {root})).rejects.toThrow(/1 MiB limit/);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await readFile(path, 'utf8')).toBe('foo');
  });
});
