import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail, renderTable } from '../../../lib/output.js';

const CHOICES = ['approve_only', 'send_now', 'send_later'] as const;

export default class RelationshipsComposerDispatch extends BaseCommand {
  static description = 'Keep exact approval, send now, or schedule one governed relationship message';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    choice: Flags.string({ description: 'Dispatch outcome', options: [...CHOICES], required: true }),
    at: Flags.string({ description: 'ISO-8601 time required for send_later' }),
    'expected-version': Flags.integer({ description: 'Current optimistic session version', required: true, min: 1 }),
    'idempotency-key': Flags.string({ description: 'Stable retry key for this exact choice and time', required: true }),
    yes: Flags.boolean({ description: 'Confirm this governed dispatch choice' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerDispatch);
    const choice = flags.choice as typeof CHOICES[number];
    if (choice === 'send_later' && !flags.at) throw new Error('--at is required with --choice send_later');
    if (choice !== 'send_later' && flags.at) throw new Error('--at is only valid with --choice send_later');
    const scheduledFor = flags.at ? new Date(flags.at) : null;
    if (scheduledFor && !Number.isFinite(scheduledFor.getTime())) throw new Error('--at must be a valid ISO-8601 timestamp');
    if (!await this.confirmAction(`Commit relationship composer choice ${choice}?`, flags)) return { cancelled: true };

    const response = await this.apiRequest<{ dispatch: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/dispatches`,
      {
        method: 'POST',
        body: {
          expectedVersion: flags['expected-version'],
          idempotencyKey: flags['idempotency-key'],
          choice,
          ...(scheduledFor ? { scheduledFor: scheduledFor.toISOString() } : {}),
        },
      },
    );
    const current = response.dispatch.current as Record<string, unknown> | null;
    const receipts = Array.isArray(response.dispatch.receipts)
      ? response.dispatch.receipts as Record<string, unknown>[]
      : [];
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Session', args.id],
        ['Choice', choice],
        ['Status', current?.status ?? 'not recorded'],
        ['Action', current?.actionId ?? 'relationship.communication.send'],
        ['Scheduled for', current?.scheduledFor ?? 'not scheduled'],
        ['Provider message', current?.providerMessageId ?? 'not available'],
        ['Recovery', (current?.recovery as Record<string, unknown> | undefined)?.label ?? 'none'],
      ]);
      if (receipts.length) renderTable(receipts, [
        { key: 'createdAt', header: 'Time' },
        { key: 'status', header: 'Receipt' },
        { key: 'choice', header: 'Choice' },
      ]);
    }
    return response.dispatch;
  }
}
