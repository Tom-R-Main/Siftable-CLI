import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseEntityRef} from '../../lib/entity-ref.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class GraphExplain extends BaseCommand {
  static description = 'Explain a bounded graph path between two entities';

  static args = {
    source: Args.string({description: 'Source entity reference as type:uuid', required: true}),
    target: Args.string({description: 'Target entity reference as type:uuid', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    depth: Flags.integer({description: 'Maximum path depth, backend clamps to 1-5', default: 4}),
    'frontier-limit': Flags.integer({description: 'Maximum links to inspect per path expansion, backend clamps to 1-1000', default: 500}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GraphExplain);
    let source;
    let target;
    try {
      source = parseEntityRef(args.source);
      target = parseEntityRef(args.target);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid entity reference.');
    }

    const client = await this.client(flags);
    const response = await client.getEntityPath(source.entityType, source.entityId, target.entityType, target.entityId, {
      maxDepth: flags.depth,
      frontierLimit: flags['frontier-limit'],
    });
    this.handleApiError(response);
    const explanation = ((response.data as any)?.path ?? {}) as {
      found?: boolean;
      maxDepth?: number;
      pathLength?: number;
      path?: any[];
      truncated?: boolean;
    };
    const path = explanation.path ?? [];
    const result = {
      ok: true,
      source: args.source,
      target: args.target,
      found: Boolean(explanation.found),
      maxDepth: explanation.maxDepth ?? flags.depth,
      pathLength: explanation.pathLength ?? path.length,
      path,
      truncated: Boolean(explanation.truncated),
      next: explanation.found
        ? []
        : ['Increase --depth within backend caps, or run graph neighbors on each endpoint to inspect disconnected neighborhoods.'],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Source', args.source],
        ['Target', args.target],
        ['Found', explanation.found ? 'yes' : 'no'],
        ['Path length', result.pathLength],
      ]);
      if (path.length > 0) {
        this.log('');
        renderTable(path.map((step) => ({
          from: formatEndpoint(step.from),
          type: step.linkType,
          direction: step.direction,
          to: formatEndpoint(step.to),
          contextField: step.contextField,
        })), [
          {key: 'from', header: 'From'},
          {key: 'type', header: 'Link'},
          {key: 'direction', header: 'Direction'},
          {key: 'to', header: 'To'},
          {key: 'contextField', header: 'Context'},
        ]);
      }
    }

    return result;
  }
}

function formatEndpoint(endpoint: {entityType?: string; entityId?: string; label?: string} | undefined): string {
  if (!endpoint) {
    return '';
  }
  const ref = `${endpoint.entityType ?? 'entity'}:${endpoint.entityId ?? ''}`;
  return endpoint.label ? `${endpoint.label} (${ref})` : ref;
}
