import path from 'node:path';
import {runReadOnlyGit} from './gitCheckoutContext.js';

export interface IgnoreRule {
  source: string;
  line: number;
  pattern: string;
  sourceKind: 'repository' | 'checkout_local' | 'global';
}

export type IgnoreEvaluation =
  | {tracked: true; covered: false; reason: 'tracked_destination'}
  | {tracked: false; covered: false; reason: 'unignored_destination'}
  | {
      tracked: false;
      covered: true;
      strength: 'strong' | 'weak';
      rule: IgnoreRule;
      remediation?: string;
    };

function parseIgnoreRule(checkoutRoot: string, output: string): IgnoreRule | null {
  const record = output.trim().split('\n').at(-1);
  if (!record) return null;
  const tab = record.indexOf('\t');
  const provenance = tab >= 0 ? record.slice(0, tab) : record;
  const match = /^(.*):(\d+):(.*)$/.exec(provenance);
  if (!match) return null;
  const source = match[1];
  const absoluteSource = path.isAbsolute(source) ? path.normalize(source) : path.resolve(checkoutRoot, source);
  const relative = path.relative(checkoutRoot, absoluteSource);
  const sourceKind = relative === '.git/info/exclude' || /(?:^|[/\\])\.git[/\\]info[/\\]exclude$/.test(absoluteSource)
    ? 'checkout_local'
    : (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(absoluteSource) === '.gitignore')
      ? 'repository'
      : 'global';
  return {source: absoluteSource, line: Number(match[2]), pattern: match[3], sourceKind};
}

export async function evaluateGitIgnore(
  checkoutRoot: string,
  relativeDestination: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<IgnoreEvaluation> {
  const tracked = await runReadOnlyGit(
    checkoutRoot,
    ['ls-files', '--error-unmatch', '--', relativeDestination],
    environment,
  );
  if (tracked.exitCode === 0) return {tracked: true, covered: false, reason: 'tracked_destination'};
  const ignored = await runReadOnlyGit(
    checkoutRoot,
    ['check-ignore', '-v', '--no-index', '--', relativeDestination],
    environment,
  );
  if (ignored.exitCode !== 0) return {tracked: false, covered: false, reason: 'unignored_destination'};
  const rule = parseIgnoreRule(checkoutRoot, ignored.stdout);
  if (!rule) return {tracked: false, covered: false, reason: 'unignored_destination'};
  if (rule.pattern.startsWith('!')) {
    return {tracked: false, covered: false, reason: 'unignored_destination'};
  }
  if (rule.sourceKind === 'global') {
    return {
      tracked: false,
      covered: true,
      strength: 'weak',
      rule,
      remediation: 'Add a repository or checkout-local ignore rule; global excludes do not travel with the checkout.',
    };
  }
  return {tracked: false, covered: true, strength: 'strong', rule};
}
