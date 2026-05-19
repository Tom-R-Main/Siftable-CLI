import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {errorResult, EvidenceResult, nowIso} from './types.js';

export interface ModelFactsInput {
  model?: string;
  projectRoot?: string;
}

export interface ModelFactsSignals extends Record<string, unknown> {
  envPins: string[];
  routingFilesPresent: string[];
  providerCapabilitiesPresent: boolean;
}

const MODEL_ENV_KEYS = [
  'LLM_INSTANT_MODEL',
  'LLM_EXPERT_MODEL',
  'LLM_EXPERT_FALLBACK_MODEL',
  'LLM_GLUE_MODEL',
  'LLM_FAST_CONTEXT_MODEL',
];

export function collectModelFacts(input: ModelFactsInput = {}): EvidenceResult<ModelFactsSignals> {
  const projectRoot = input.projectRoot || process.cwd();
  const empty: ModelFactsSignals = {
    envPins: [],
    routingFilesPresent: [],
    providerCapabilitiesPresent: false,
  };

  try {
    const routingFiles = [
      'exf-app/src/services/llmRouter.ts',
      'exf-app/src/services/openrouterClient.ts',
      'exf-app/src/services/assistantToolRunner.ts',
      'exf-app/src/config/env.ts',
    ];
    const routingFilesPresent = routingFiles.filter((file) => existsSync(join(projectRoot, file)));
    const providerCapabilitiesPath = join(projectRoot, 'exf-app/src/services/tools/providerCapabilities.ts');
    const envPath = join(projectRoot, 'exf-app/src/config/env.ts');
    const envPins = existsSync(envPath)
      ? MODEL_ENV_KEYS.filter((key) => readFileSync(envPath, 'utf8').includes(key))
      : [];

    return {
      ok: true,
      mode: 'model',
      subject: input.model || 'model policy',
      fetchedAt: nowIso(),
      signals: {
        envPins,
        routingFilesPresent,
        providerCapabilitiesPresent: existsSync(providerCapabilitiesPath),
      },
      warnings: [],
      errors: [],
    };
  } catch (error) {
    return errorResult('model', input.model || 'model policy', error, empty);
  }
}
