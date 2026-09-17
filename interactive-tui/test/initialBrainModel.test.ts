import {describe, expect, it} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {CODEX_DEFAULT_MODEL} from '../codexEngine';

const brainPath = fileURLToPath(new URL('../brain.ts', import.meta.url));

function initialModel(overrides: Record<string, string> = {}) {
  const env = {...process.env};
  delete env.EXECUTERM_MODEL_PROVIDER;
  delete env.EXECUTERM_MODEL;
  delete env.EXECUTERM_MODEL_EFFORT;
  const result = Bun.spawnSync([process.execPath, '-e',
    `const {getBrainModel} = await import(${JSON.stringify(brainPath)}); process.stdout.write(JSON.stringify(getBrainModel()));`,
  ], {env: {...env, ...overrides}, stdout: 'pipe', stderr: 'pipe'});
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

describe('fresh interactive model defaults', () => {
  it('starts new installs with GPT-5.6 Sol through Codex', () => {
    expect(initialModel()).toEqual({provider: 'codex', model: CODEX_DEFAULT_MODEL});
  });

  it('preserves the OpenRouter route for a legacy model-only override', () => {
    expect(initialModel({EXECUTERM_MODEL: 'google/gemini-3.8-flash'}))
      .toEqual({provider: 'openrouter', model: 'google/gemini-3.8-flash'});
  });

  it('preserves an explicit personal Meta provider/model override', () => {
    expect(initialModel({EXECUTERM_MODEL_PROVIDER: 'meta', EXECUTERM_MODEL: 'muse-spark-1.3-contributor'}))
      .toEqual({provider: 'meta', model: 'muse-spark-1.3-contributor'});
  });
});
