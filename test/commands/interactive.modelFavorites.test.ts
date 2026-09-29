import {
  INTERACTIVE_MODEL_CHOICES,
  favoriteModelIds,
  pickerLabelWidth,
  pickerModelChoices,
  toggleFavoriteModel,
} from '../../interactive-tui/commands';
import * as prefs from '../../interactive-tui/prefs';

beforeEach(() => {
  jest.spyOn(prefs, 'loadPrefs').mockReturnValue({});
  jest.spyOn(prefs, 'savePrefs').mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('model favorites', () => {
  it('contains one row per model ID', () => {
    const ids = INTERACTIVE_MODEL_CHOICES.map((choice) => choice.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns no favorites by default and ignores unknown ids', () => {
    expect(favoriteModelIds()).toEqual([]);
    expect(pickerModelChoices()).toBe(INTERACTIVE_MODEL_CHOICES);
    jest.mocked(prefs.loadPrefs).mockReturnValue({ favorites: ['no-such-model', 42 as unknown as string] });
    expect(favoriteModelIds()).toEqual(['no-such-model']);
    expect(pickerModelChoices()).toBe(INTERACTIVE_MODEL_CHOICES);
  });

  it('toggles favorites and persists them', () => {
    const id = 'openrouter/openai/gpt-5.4-nano';
    expect(toggleFavoriteModel(id)).toEqual({ favorites: [id], added: true, saved: true });
    expect(prefs.savePrefs).toHaveBeenCalledWith({ favorites: [id] });
    jest.mocked(prefs.loadPrefs).mockReturnValue({ favorites: [id] });
    expect(toggleFavoriteModel(id)).toEqual({ favorites: [], added: false, saved: true });
    expect(prefs.savePrefs).toHaveBeenCalledWith({ favorites: [] });
  });

  it('does not report a new favorite when persistence fails', () => {
    jest.mocked(prefs.savePrefs).mockReturnValue(false);
    expect(toggleFavoriteModel('codex/gpt-6-astra')).toEqual({ favorites: [], added: true, saved: false });
  });

  it('floats starred models first in catalog order', () => {
    const nano = 'openrouter/openai/gpt-5.4-nano';
    const opus = 'openrouter/anthropic/claude-opus-5.5';
    jest.mocked(prefs.loadPrefs).mockReturnValue({ favorites: [nano, opus] });
    const ordered = pickerModelChoices();
    // Starred float first in catalog order (Opus precedes Nano), not starring order.
    expect(ordered[0].id).toBe(opus);
    expect(ordered[1].id).toBe(nano);
    expect(ordered).toHaveLength(INTERACTIVE_MODEL_CHOICES.length);
    expect(new Set(ordered.map((choice) => choice.id))).toEqual(
      new Set(INTERACTIVE_MODEL_CHOICES.map((choice) => choice.id)),
    );
  });
});

describe('pickerLabelWidth', () => {
  it('clears the longest label with room to spare', () => {
    const longest = Math.max(...INTERACTIVE_MODEL_CHOICES.map((choice) => choice.label.length));
    expect(pickerLabelWidth()).toBe(longest + 4);
    for (const choice of INTERACTIVE_MODEL_CHOICES) {
      expect(choice.label.padEnd(pickerLabelWidth())).toMatch(/ {4}$/);
    }
  });
});
