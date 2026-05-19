import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class PeopleGraph extends BaseCommand {
  static description = 'Show a person-centered relationship graph';

  static args = {
    id: Args.string({description: 'Person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    depth: Flags.integer({description: 'Relationship graph depth', default: 2}),
    'include-inactive': Flags.boolean({description: 'Include inactive relationship edges'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleGraph);
    const client = await this.client(flags);
    const response = await client.getPeopleFocusGraph(args.id, {
      depth: flags.depth,
      includeInactive: flags['include-inactive'],
    });
    this.handleApiError(response);
    const graph = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      const nodes = Array.isArray(graph.nodes) ? graph.nodes as Record<string, unknown>[] : [];
      const edges = Array.isArray(graph.edges) ? graph.edges as Record<string, unknown>[] : [];
      renderDetail([
        ['Focus person', (graph.focusPersonId ?? args.id) as string],
        ['Nodes', nodes.length],
        ['Edges', edges.length],
      ]);
      if (nodes.length > 0) {
        this.log('');
        renderTable(nodes, [
          {key: 'id', header: 'ID'},
          {key: 'name', header: 'Name'},
          {key: 'relationshipToUser', header: 'Relationship'},
        ]);
      }
    }

    return graph;
  }
}
