import {normalizeMetaModel} from './metaModels';

/** Provider id that routes the brain to the Codex app-server engine. */
export const CODEX_PROVIDER = 'codex';
/** Local harness default model — used to decide when to pass a model override to Codex. */
export const DEFAULT_AGENT_HARNESS_MODEL = 'google/gemini-3.8-flash';

export interface InitialBrainModel {
  provider: string;
  model: string;
  baseUrl: string | undefined;
  effort: string | undefined;
}

/** Resolve startup selection without modifying credentials or persisted preferences. */
export function initialBrainModel(env: NodeJS.ProcessEnv = process.env): InitialBrainModel {
  const provider = env.EXECUTERM_MODEL_PROVIDER || (env.EXECUTERM_MODEL ? 'openrouter' : CODEX_PROVIDER);
  const model = provider.toLowerCase() === 'meta'
    ? normalizeMetaModel(env.EXECUTERM_MODEL)
    : env.EXECUTERM_MODEL || (provider === CODEX_PROVIDER ? 'gpt-6.1-sol' : DEFAULT_AGENT_HARNESS_MODEL);
  return {
    provider,
    model,
    baseUrl: env.SIFT_MODEL_BASE_URL,
    effort: env.EXECUTERM_MODEL_EFFORT || undefined,
  };
}
