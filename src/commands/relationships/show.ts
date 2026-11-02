import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

interface CollaborationEventEntry {
  eventType?: string;
  actorUserId?: string;
  versionBefore?: number;
  versionAfter?: number;
  occurredAt?: string;
  detail?: {commentExcerpt?: string; nextActionTitle?: string};
}

function renderHistory(events: CollaborationEventEntry[]): string[] {
  return events.map((event) => {
    const versions = `v${event.versionBefore ?? '?'} -> v${event.versionAfter ?? '?'}`;
    const headline = event.detail?.commentExcerpt ?? event.detail?.nextActionTitle ?? '';
    const suffix = headline ? ` — ${headline}` : '';
    return `- ${event.occurredAt ?? 'unknown-time'} ${event.eventType ?? 'event'} ${versions} by ${event.actorUserId ?? 'unknown'}${suffix}`;
  });
}

export default class RelationshipsShow extends BaseCommand {
  static description = 'Show the current relationship collaboration snapshot';
  static args = {
    entity: Args.string({description: 'Relationship entity as opportunity:<uuid> or prospect:<uuid>', required: true}),
  };
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipsShow);
    const match = /^(opportunity|prospect):([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(args.entity.trim());
    if (!match) this.error('Entity must be opportunity:<uuid> or prospect:<uuid>.');
    const response = await this.apiRequest<{snapshot: Record<string, unknown>}>(
      flags,
      `/api/v1/ontology/relationship-collaboration/${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
    );
    if (!this.jsonEnabled()) {
      const {events, ...summary} = response.snapshot;
      this.log(JSON.stringify(summary, null, 2));
      const history = Array.isArray(events) ? events as CollaborationEventEntry[] : [];
      this.log(`Collaboration history (${history.length}):`);
      for (const line of renderHistory(history)) this.log(line);
    }
    return response.snapshot;
  }
}
