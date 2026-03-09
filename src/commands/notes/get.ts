import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, formatDate} from '../../lib/output.js';

/** Lightweight TipTap JSON → Markdown converter for CLI display. */
function tiptapToMarkdown(content: any[]): string {
  let out = '';
  for (const block of content) {
    switch (block.type) {
      case 'paragraph':
        out += inlineText(block.content) + '\n';
        break;
      case 'heading': {
        const level = block.attrs?.level || 2;
        out += '#'.repeat(level) + ' ' + inlineText(block.content) + '\n';
        break;
      }
      case 'codeBlock': {
        const lang = block.attrs?.language || '';
        out += '```' + lang + '\n' + inlineText(block.content) + '\n```\n';
        break;
      }
      case 'bulletList':
        if (block.content) {
          for (const item of block.content) {
            if (item.type === 'listItem' && item.content) {
              out += '- ' + tiptapToMarkdown(item.content).trimEnd() + '\n';
            }
          }
        }
        break;
      case 'orderedList':
        if (block.content) {
          block.content.forEach((item: any, i: number) => {
            if (item.type === 'listItem' && item.content) {
              out += `${i + 1}. ` + tiptapToMarkdown(item.content).trimEnd() + '\n';
            }
          });
        }
        break;
      case 'blockquote':
        if (block.content) {
          const inner = tiptapToMarkdown(block.content);
          out += inner.split('\n').map((l: string) => l ? `> ${l}` : '>').join('\n') + '\n';
        }
        break;
      case 'horizontalRule':
        out += '---\n';
        break;
      default:
        if (block.content) out += inlineText(block.content) + '\n';
    }
  }
  return out;
}

function inlineText(content: any[] | undefined): string {
  if (!content) return '';
  return content.map((c: any) => {
    if (c.type === 'text') return c.text || '';
    if (c.type === 'hardBreak') return '\n';
    return c.text || '';
  }).join('');
}

export default class NotesGet extends BaseCommand {
  static description = 'Get a note with full content';

  static args = {
    id: Args.string({description: 'Note ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(NotesGet);
    const client = await this.client(flags);
    const response = await client.getNote(args.id);
    this.handleApiError(response);

    const note = this.unwrapOne(response, 'note') as Record<string, any>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', note.id],
        ['Title', note.title],
        ['Type', note.noteType],
        ['Project', note.projectId],
        ['Created', formatDate(note.createdAt as string)],
        ['Updated', formatDate(note.updatedAt as string)],
      ]);
      // Prefer rich contentJson rendering, fall back to plain content
      if (note.contentJson?.content) {
        this.log('\n---\n');
        this.log(tiptapToMarkdown(note.contentJson.content as any[]));
      } else if (note.content) {
        this.log('\n---\n');
        this.log(note.content as string);
      }
    }

    return response.data;
  }
}
