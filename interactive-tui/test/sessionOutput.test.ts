import {describe, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSessionOutput} from '../sessionOutput';
import type {SessionEvent} from '../agent-harness/framework/session';

describe('session output retrieval', () => {
  test('retrieves all retained bytes in bounded pages only by session reference', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sift-output-')));
    try {
      const file = join(root, 'spill-output');
      writeFileSync(file, 'x'.repeat(20_000));
      const events = [{seq: 4, type: 'tool/result', data: {toolCallId: 'call', output: {fullOutputRef: file}}}] as SessionEvent[];
      const first = readSessionOutput(events, 'call', root);
      expect(first.text).toHaveLength(16_384);
      expect(first.more).toBe(true);
      const next = readSessionOutput(events, 4, root, first.nextOffset);
      expect(first.text + next.text).toBe('x'.repeat(20_000));
      expect(next.more).toBe(false);
      expect(() => readSessionOutput(events, 5, root)).toThrow('No tool result');
      expect(() => readSessionOutput(events, 4, root, -1)).toThrow();
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  test('rejects a reference outside the spill root or a symlink', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sift-output-')));
    try {
      const spills = join(root, 'spills'); mkdirSync(spills);
      const file = join(root, 'private'); writeFileSync(file, 'private');
      symlinkSync(file, join(spills, 'link'));
      for (const fullOutputRef of [file, join(spills, 'link')]) {
        const events = [{seq: 4, type: 'tool/result', data: {toolCallId: 'call', output: {fullOutputRef}}}] as SessionEvent[];
        expect(() => readSessionOutput(events, 'call', spills)).toThrow('escapes');
      }
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  test('reports missing retained evidence without presenting excerpt as full output', () => {
    const events = [{seq: 4, type: 'tool/result', data: {toolCallId: 'call', modelContent: 'excerpt', output: {truncated: true}}}] as SessionEvent[];
    expect(() => readSessionOutput(events, 4, '/unused')).toThrow('not retained');
  });
});
