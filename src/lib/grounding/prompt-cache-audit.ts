import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {errorResult, EvidenceResult, nowIso} from './types.js';

export interface PromptCacheAuditInput {
  projectRoot?: string;
  files?: string[];
}

export interface PromptCacheSignals extends Record<string, unknown> {
  filesChecked: string[];
  cacheControlHits: string[];
  cachedTokenLoggingHits: string[];
  volatileContextHints: string[];
}

export function collectPromptCacheAudit(input: PromptCacheAuditInput = {}): EvidenceResult<PromptCacheSignals> {
  const projectRoot = input.projectRoot || process.cwd();
  const files = input.files || [
    'exf-app/src/services/assistantToolRunner.ts',
    'exf-app/src/services/openrouterClient.ts',
    'exf-app/src/services/llmRouter.ts',
  ];
  const empty: PromptCacheSignals = {
    filesChecked: [],
    cacheControlHits: [],
    cachedTokenLoggingHits: [],
    volatileContextHints: [],
  };

  try {
    const signals: PromptCacheSignals = {...empty};
    for (const file of files) {
      const path = join(projectRoot, file);
      if (!existsSync(path)) continue;
      signals.filesChecked.push(file);
      const text = readFileSync(path, 'utf8');
      if (text.includes('cache_control') || text.includes('cacheControl')) {
        signals.cacheControlHits.push(file);
      }
      if (text.includes('cachedTokens') || text.includes('cacheWriteTokens')) {
        signals.cachedTokenLoggingHits.push(file);
      }
      if (/imageContextSummary|currentTime|Date\(|retrieval|context/i.test(text)) {
        signals.volatileContextHints.push(file);
      }
    }

    return {
      ok: true,
      mode: 'pattern',
      subject: 'prompt caching',
      fetchedAt: nowIso(),
      signals,
      warnings: signals.cacheControlHits.length === 0 ? ['No cache_control usage found in checked files.'] : [],
      errors: [],
    };
  } catch (error) {
    return errorResult('pattern', 'prompt caching', error, empty);
  }
}
