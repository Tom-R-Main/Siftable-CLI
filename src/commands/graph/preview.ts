import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseEntityRef} from '../../lib/entity-ref.js';
import {renderDetail} from '../../lib/output.js';

export default class GraphPreview extends BaseCommand {
  static description = 'Preview one graph entity';

  static args = {
    entity: Args.string({description: 'Entity reference as type:uuid', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GraphPreview);
    let entity;
    try {
      entity = parseEntityRef(args.entity);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid entity reference.');
    }

    const client = await this.client(flags);
    const response = await client.getEntityPreview(entity.entityType, entity.entityId);
    this.handleApiError(response);
    const result = response.data as Record<string, unknown>;
    const preview = (result.preview ?? {}) as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Type', preview.entityType ?? entity.entityType],
        ['ID', preview.entityId ?? entity.entityId],
        ['Label', preview.label],
        ['Description', preview.description],
      ]);
    }

    return result;
  }
}
