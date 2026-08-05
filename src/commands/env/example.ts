import {lstat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Flags} from '@oclif/core';
import {renderEnvExample} from '../../lib/environmentExample.js';
import {loadEnvironmentManifest} from '../../lib/environmentCommand.js';
import {checkoutRootFlag, OfflineEnvironmentCommand} from '../../lib/offlineEnvironmentCommand.js';

export default class EnvExample extends OfflineEnvironmentCommand {
  static summary = 'Generate a deterministic names-and-placeholders-only example';
  static description = 'Generate .env.example from .sift/environment.yaml after defining the contract. Output contains names and documentation-safe placeholders only; --write updates the checkout example.';
  static flags = {
    'checkout-root': checkoutRootFlag,
    write: Flags.boolean({description: 'Write the deterministic output to .env.example instead of displaying it'}),
  };

  async run(): Promise<{written: boolean; path: string | null}> {
    const {flags} = await this.parse(EnvExample);
    const checkoutRoot = this.resolveCheckoutRoot(flags['checkout-root']);
    const rendered = renderEnvExample(await loadEnvironmentManifest(checkoutRoot));
    if (!flags.write) {
      this.log(rendered.trimEnd());
      return {written: false, path: null};
    }
    const outputPath = path.join(checkoutRoot, '.env.example');
    try {
      const existing = await lstat(outputPath);
      if (existing.isSymbolicLink() || !existing.isFile()) this.error('.env.example must be a regular non-symlink file.', {exit: 1});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(outputPath, rendered, {encoding: 'utf8', mode: 0o644});
    this.log(`Wrote ${path.relative(checkoutRoot, outputPath)}`);
    return {written: true, path: outputPath};
  }
}
