import {Args, Command, Flags} from '@oclif/core';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {CELL_RENDER_MISSING_MESSAGE, resolveCellRenderBin} from '../lib/cell-render.js';

/** Read all of stdin to a string (used when no file argument is given). */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export default class Mermaid extends Command {
  static description =
    'Render a Mermaid diagram to the terminal (flowchart, sequence, state, class, ER, C4, architecture, mindmap). Reads a .mmd file or stdin.';

  static enableJsonFlag = true;

  static examples = [
    '<%= config.bin %> mermaid diagram.mmd',
    '<%= config.bin %> mermaid diagram.mmd --ascii --color none',
    'cat diagram.mmd | <%= config.bin %> mermaid --max-width 100',
  ];

  static args = {
    file: Args.string({description: 'Path to a .mmd file (omit to read stdin)', required: false}),
  };

  static flags = {
    ascii: Flags.boolean({description: 'Use ASCII glyphs instead of Unicode box drawing'}),
    unicode: Flags.boolean({description: 'Use Unicode box drawing (default)'}),
    color: Flags.string({description: 'Color mode', options: ['none', 'truecolor'], default: 'truecolor'}),
    width: Flags.integer({description: 'Fit into an exact N-column pane (pads/clips)'}),
    height: Flags.integer({description: 'Fit into an exact N-row pane (pads/clips)'}),
    'max-width': Flags.integer({description: 'Bound the diagram to N columns (no padding)'}),
    'max-height': Flags.integer({description: 'Bound the diagram to N rows (no padding)'}),
    overflow: Flags.string({
      description: 'What to do when the diagram exceeds the bounds',
      options: ['allow', 'clip', 'error'],
      default: 'clip',
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Mermaid);

    const bin = resolveCellRenderBin();
    if (!bin) this.error(CELL_RENDER_MISSING_MESSAGE);

    // Resolve the source to a concrete file path; stage stdin through a temp file
    // because the renderer reads a path, not stdin.
    let path: string;
    let tempDir: string | null = null;
    if (args.file) {
      path = isAbsolute(args.file) ? args.file : resolve(process.cwd(), args.file);
      if (!existsSync(path)) this.error(`File not found: ${args.file}`);
    } else {
      const source = readStdin().trim();
      if (!source) this.error('No input: pass a .mmd file or pipe Mermaid source on stdin.');
      tempDir = mkdtempSync(join(tmpdir(), 'sift-mermaid-'));
      path = join(tempDir, 'diagram.mmd');
      writeFileSync(path, `${source}\n`, 'utf8');
    }

    const cliArgs = ['mermaid', path, flags.ascii ? '--ascii' : '--unicode', '--color', flags.color];
    if (flags.width != null) cliArgs.push('--width', String(flags.width));
    if (flags.height != null) cliArgs.push('--height', String(flags.height));
    if (flags['max-width'] != null) cliArgs.push('--max-width', String(flags['max-width']));
    if (flags['max-height'] != null) cliArgs.push('--max-height', String(flags['max-height']));
    cliArgs.push('--overflow', flags.overflow);

    try {
      // JSON mode captures the rendered text; otherwise stream straight through so
      // truecolor escapes reach the real terminal unmangled.
      if (this.jsonEnabled()) {
        const res = spawnSync(bin, cliArgs, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
        if (res.status !== 0) {
          return {ok: false, error: (res.stderr || '').trim() || `cell-render exited ${res.status}`};
        }
        return {ok: true, text: res.stdout ?? ''};
      }

      const res = spawnSync(bin, cliArgs, {stdio: 'inherit'});
      if (res.error) this.error(`Failed to run cell-render: ${res.error.message}`);
      if (typeof res.status === 'number' && res.status !== 0) this.exit(res.status);
      return undefined;
    } finally {
      if (tempDir) rmSync(tempDir, {recursive: true, force: true});
    }
  }
}
