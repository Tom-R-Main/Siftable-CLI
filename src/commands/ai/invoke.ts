import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import type {
  AiStreamTransport,
  AiTransport,
} from '../../lib/ai-transport.js';

export default class AiInvoke extends BaseCommand {
  static description = 'Invoke an eligible connected model (requires ai:invoke and ai:connections:use)';
  static requiredScope = 'ai:invoke';
  static flags = {
    ...BaseCommand.baseFlags,
    connection: Flags.string({
      description: 'Model Connection UUID returned by sift ai list',
      required: true,
    }),
    model: Flags.string({
      description: 'Eligible model ID returned by sift ai list',
      required: true,
    }),
    prompt: Flags.string({
      description: 'Prompt text',
      required: true,
    }),
    'max-output-tokens': Flags.integer({
      description: 'Maximum output tokens (1-32768)',
      min: 1,
      max: 32_768,
    }),
    stream: Flags.boolean({
      description: 'Consume and print incremental connected-model output',
      default: false,
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AiInvoke);
    const client: AiTransport & AiStreamTransport = await this.client(flags);
    const input = {
      connectionId: flags.connection,
      model: flags.model,
      prompt: flags.prompt,
      maxOutputTokens: flags['max-output-tokens'],
    };
    if (flags.stream) {
      let text = '';
      let finishReason = 'unknown';
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      for await (const event of client.generateAiStream(input)) {
        if (event.type === 'delta') {
          text += event.text;
          if (!this.jsonEnabled()) this.log(event.text);
        }
        if (event.type === 'usage') {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
        }
        if (event.type === 'completed') finishReason = event.finishReason;
        if (event.type === 'failed') {
          this.error(`Connected model stream failed (${event.code}).`, {
            exit: event.statusCode,
          });
        }
      }
      return {
        connectionId: flags.connection,
        model: flags.model,
        text,
        finishReason,
        usage: {inputTokens, outputTokens},
      };
    }
    const result = await client.generateAi({
      ...input,
    });
    this.handleAiApiError(result, 'ai:invoke');
    const response = result.data?.response;
    if (!response) this.error('AI response was unavailable.');
    const output = {
      connectionId: response.connectionId,
      model: response.model,
      text: response.text,
      finishReason: response.finishReason,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
    if (!this.jsonEnabled()) this.log(output.text);
    return output;
  }
}
