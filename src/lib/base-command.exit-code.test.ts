import {describe, expect, it} from 'vitest';
import {BaseCommand, portableExitCode} from './base-command.js';

class ExitCodeProbe extends BaseCommand {
  async run(): Promise<unknown> {
    return undefined;
  }

  errorJson(err: Error & {statusCode?: number; oclif?: {exit?: number}}): unknown {
    return this.toErrorJson(err);
  }

  apiError(response: {statusCode: number; error?: string; data?: unknown}): void {
    this.handleApiError(response);
  }
}

describe('portableExitCode', () => {
  it('maps transport status zero to a failed process exit', () => {
    expect(portableExitCode(Object.assign(new Error('x'), {oclif: {exit: 0}}))).toBe(1);
    expect(portableExitCode(Object.assign(new Error('x'), {exitCode: 0}))).toBe(1);
  });

  it('keeps portable non-zero codes and folds invalid codes to one', () => {
    expect(portableExitCode(Object.assign(new Error('x'), {oclif: {exit: 3}}))).toBe(3);
    expect(portableExitCode(Object.assign(new Error('x'), {oclif: {exit: 255}}))).toBe(255);
    expect(portableExitCode(Object.assign(new Error('x'), {oclif: {exit: 404}}))).toBe(1);
    expect(portableExitCode(Object.assign(new Error('x'), {oclif: {exit: -1}}))).toBe(1);
    expect(portableExitCode(new Error('x'))).toBe(1);
  });
});

describe('BaseCommand failure exit semantics', () => {
  it('keeps statusCode zero in JSON while reporting a non-zero exit', () => {
    const probe = new ExitCodeProbe([], {} as never);
    const error = Object.assign(new Error('Network error: fetch failed'), {
      statusCode: 0,
      oclif: {exit: 0},
    });

    expect(probe.errorJson(error)).toEqual(expect.objectContaining({
      error: expect.objectContaining({statusCode: 0, exit: 1}),
    }));
  });

  it('throws a non-zero Oclif exit for transport failures', () => {
    const probe = new ExitCodeProbe([], {} as never);

    expect(() => probe.apiError({statusCode: 0, error: 'Network error: fetch failed'}))
      .toThrow(expect.objectContaining({statusCode: 0, oclif: expect.objectContaining({exit: 1})}));
  });

  it.each([401, 403, 404, 429, 500])('keeps HTTP %s failures non-zero and portable', statusCode => {
    const probe = new ExitCodeProbe([], {} as never);
    let thrown: (Error & {oclif?: {exit?: number}}) | undefined;
    try {
      probe.apiError({statusCode, error: `status ${statusCode}`});
    } catch (error) {
      thrown = error as typeof thrown;
    }

    expect(thrown).toBeDefined();
    expect(portableExitCode(thrown!)).toBeGreaterThanOrEqual(1);
  });
});
