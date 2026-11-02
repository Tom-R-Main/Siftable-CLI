import {constants, closeSync, fstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {relative, isAbsolute, sep} from 'node:path';
import type {SessionEvent} from './agent-harness/framework/session';

/** Read a bounded page from an output referenced by this session, never an arbitrary path. */
export function readSessionOutput(events: readonly SessionEvent[], reference: number | string, spillRoot: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Output offset must be a nonnegative byte offset');
  const event = [...events].reverse().find(event => event.type === 'tool/result' && (typeof reference === 'number' ? event.seq === reference : event.data.toolCallId === reference));
  if (!event || event.type !== 'tool/result') throw new Error('No tool result with that reference in this session');
  const maxBytes = 16_384;
  if (!event.data.output?.fullOutputRef) {
    if (event.data.output?.truncated) throw new Error('Full output was not retained; only the recorded excerpt is available');
    const bytes = Buffer.from(event.data.result === undefined
      ? event.data.modelContent ?? JSON.stringify(event.data.error ?? '')
      : JSON.stringify(event.data.result));
    return {seq: event.seq, text: bytes.subarray(offset, offset + maxBytes).toString('utf8'), offset, nextOffset: Math.min(bytes.length, offset + maxBytes), bytes: bytes.length, more: offset + maxBytes < bytes.length};
  }
  const root = realpathSync(spillRoot);
  const target = realpathSync(event.data.output.fullOutputRef);
  const path = relative(root, target);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) || target !== event.data.output.fullOutputRef) throw new Error('Output reference escapes its retained evidence directory');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Retained output is not a regular file');
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, stat.size - offset)));
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    return {seq: event.seq, text: buffer.subarray(0, count).toString('utf8'), offset, nextOffset: offset + count, bytes: stat.size, more: offset + count < stat.size};
  } finally { closeSync(fd); }
}
