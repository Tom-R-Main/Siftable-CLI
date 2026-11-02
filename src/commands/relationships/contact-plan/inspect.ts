import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {formatDateTime, renderDetail, renderTable} from '../../../lib/output.js';

type ContactPlanRecord = Record<string, unknown>;

function record(value: unknown): ContactPlanRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ContactPlanRecord
    : {};
}

function records(value: unknown): ContactPlanRecord[] {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as ContactPlanRecord[]
    : [];
}

function sourceIdentity(value: unknown): string {
  const source = record(value);
  return `${source.kind ?? 'unknown'}:${source.id ?? 'unknown'}${source.locator ? `#${source.locator}` : ''}`;
}

function renderReasons(label: string, reasons: ContactPlanRecord[]): void {
  if (reasons.length === 0) return;
  console.log('');
  console.log(label);
  renderTable(reasons, [
    {key: 'severity', header: 'Severity'},
    {key: 'code', header: 'Code'},
    {key: 'message', header: 'Reason'},
    {key: 'sourceRef', header: 'Source', get: row => row.sourceRef ? sourceIdentity(row.sourceRef) : '—'},
  ]);
}

export function renderContactPlan(plan: ContactPlanRecord): void {
  const owner = record(plan.owner);
  const person = record(plan.person);
  const window = record(plan.window);
  const policy = record(plan.policy);
  const page = record(plan.page);
  const items = records(plan.items);
  const collisions = records(plan.collisions);
  const diagnostics = records(plan.diagnostics);

  renderDetail([
    ['Person', `${person.displayName ?? 'Unknown'} (${person.id ?? 'unknown'})`],
    ['Owner', `${owner.type ?? 'unknown'}:${owner.id ?? 'unknown'}`],
    ['Window', `${window.from ?? '—'} → ${window.to ?? '—'}`],
    ['Timezone', window.timezone ?? '—'],
    ['Policy', `${policy.state ?? 'unknown'} · live recheck required`],
    ['Items', `${page.returned ?? items.length}/${page.limit ?? items.length}${page.hasMore === true ? ' · more available' : ''}`],
  ]);

  if (items.length === 0) {
    console.log('');
    console.log('No relationship work appears in this window.');
  } else {
    console.log('');
    renderTable(items, [
      {
        key: 'effectiveAt',
        header: 'When',
        get: row => formatDateTime((row.occurredAt ?? row.plannedAt ?? row.observedAt) as string | null | undefined),
      },
      {key: 'state', header: 'State'},
      {key: 'channel', header: 'Channel'},
      {key: 'intent', header: 'Intent'},
      {key: 'title', header: 'Touch'},
      {key: 'approval', header: 'Approval', get: row => String(record(row.approval).state ?? 'none')},
      {key: 'outcome', header: 'Outcome', get: row => String(record(row.outcome).state ?? 'none')},
      {
        key: 'sourceRefs',
        header: 'Sources',
        get: row => Array.isArray(row.sourceRefs) ? row.sourceRefs.map(sourceIdentity).join(', ') : '—',
      },
    ]);
  }

  renderReasons('Communication-policy blocks', records(policy.blockingReasons));
  renderReasons('Communication-policy advisories', records(policy.advisories));

  if (collisions.length > 0) {
    console.log('');
    console.log('Collisions');
    renderTable(collisions, [
      {key: 'kind', header: 'Kind'},
      {key: 'reason', header: 'Reason'},
      {key: 'itemIds', header: 'Items', get: row => Array.isArray(row.itemIds) ? row.itemIds.join(', ') : '—'},
    ]);
  }

  if (diagnostics.length > 0) {
    console.log('');
    console.log('Diagnostics');
    renderTable(diagnostics, [
      {key: 'severity', header: 'Severity'},
      {key: 'code', header: 'Code'},
      {key: 'message', header: 'Message'},
      {key: 'sourceRef', header: 'Source', get: row => row.sourceRef ? sourceIdentity(row.sourceRef) : '—'},
    ]);
  }

  console.log('');
  console.log('Inspection only. Approval, scheduling, enrollment, and dispatch remain on their owning lifecycles.');
}

export default class RelationshipsContactPlanInspect extends BaseCommand {
  static description = 'Inspect one canonical person contact plan without mutating its source lifecycles';

  static args = {
    person: Args.string({description: 'Canonical person UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    from: Flags.string({description: 'Inclusive ISO-8601 inspection window start'}),
    to: Flags.string({description: 'Inclusive ISO-8601 inspection window end'}),
    timezone: Flags.string({description: 'IANA display timezone'}),
    limit: Flags.integer({description: 'Maximum projected items', min: 1, max: 250, default: 100}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipsContactPlanInspect);
    const client = await this.client(flags);
    const response = await client.getRelationshipContactPlan(args.person, {
      from: flags.from,
      to: flags.to,
      timezone: flags.timezone,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const plan = response.data?.plan ?? {};
    if (!this.jsonEnabled()) renderContactPlan(plan);
    return plan;
  }
}
