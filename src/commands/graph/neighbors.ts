import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseEntityRef} from '../../lib/entity-ref.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class GraphNeighbors extends BaseCommand {
  static description = 'Show local graph neighbors for an entity';

  static args = {
    entity: Args.string({description: 'Entity reference as type:uuid', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    depth: Flags.integer({description: 'Graph depth, backend clamps to 1-3', default: 1}),
    limit: Flags.integer({description: 'Maximum graph items, backend clamps to 1-200', default: 80}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GraphNeighbors);
    let entity;
    try {
      entity = parseEntityRef(args.entity);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid entity reference.');
    }

    const client = await this.client(flags);
    const response = await client.getEntityGraph(entity.entityType, entity.entityId, {
      depth: flags.depth,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;
    const graph = (result.graph ?? {}) as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      const nodes = (graph.nodes ?? []) as Record<string, unknown>[];
      const edges = (graph.edges ?? []) as Record<string, unknown>[];
      renderDetail([
        ['Entity', args.entity],
        ['Nodes', nodes.length],
        ['Edges', edges.length],
      ]);
      this.log('');
      renderTable(nodes, [
        {key: 'entityType', header: 'Type'},
        {key: 'entityId', header: 'ID'},
        {key: 'label', header: 'Label'},
      ]);
    }

    return result;
  }
}
