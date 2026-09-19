// Durable user preferences for sift interactive, persisted to
// ~/.siftable/prefs.json. Mirrors the audio.ts sounds-pref pattern (same dir).
// Load is cached; saves merge a partial patch over the current file so callers
// only write the slice they own. All disk I/O is best-effort — a missing or
// corrupt file degrades to defaults rather than throwing.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PREF_DIR = join(homedir(), ".siftable");
const PREF_FILE = join(PREF_DIR, "prefs.json");

// Theme and sounds persist in their own stores (theme.ts → appearance.json,
// audio.ts → sounds.json); this file owns the prefs that had no home: the
// selected brain model and the Explorer settings.
export interface SiftPrefs {
  /** Last-selected brain model, by catalog id, plus its reasoning effort. */
  model?: { id: string; effort?: string };
  /** Last-applied Explorer settings (mode/model/budget). */
  explorer?: { mode: string; modelId: string; budget: string };
  /** Model-picker favorites, as catalog ids, in the order they were starred. */
  favorites?: string[];
}

/** Only consult the older standalone file if prefs has no favorites field.
 * An explicitly empty favorites list must not resurrect removed stars. */
export function restoreLegacyFavorites(prefs: SiftPrefs, legacyFile = join(PREF_DIR, "model-favorites.json")): SiftPrefs {
  if (Array.isArray(prefs.favorites)) return prefs;
  try {
    const legacy: unknown = JSON.parse(readFileSync(legacyFile, "utf8"));
    if (legacy && typeof legacy === "object" && "favorites" in legacy && Array.isArray(legacy.favorites)) {
      return { ...prefs, favorites: [...new Set(legacy.favorites.filter((id): id is string => typeof id === "string" && id.length > 0))] };
    }
  } catch { /* No usable legacy preferences. */ }
  return prefs;
}

const cache = new Map<string, SiftPrefs>();

export function loadPrefs(file = PREF_FILE): SiftPrefs {
  const cached = cache.get(file);
  if (cached) return cached;
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as SiftPrefs;
      const restored = restoreLegacyFavorites(parsed && typeof parsed === "object" ? parsed : {}, join(dirname(file), "model-favorites.json"));
      cache.set(file, restored);
      return restored;
    }
  } catch {
    /* corrupt or unreadable prefs — fall back to defaults */
  }
  const restored = restoreLegacyFavorites({}, join(dirname(file), "model-favorites.json"));
  cache.set(file, restored);
  return restored;
}

/** Merge a partial update into the saved prefs and write them back. */
export function savePrefs(patch: Partial<SiftPrefs>, file = PREF_FILE): boolean {
  const next: SiftPrefs = { ...loadPrefs(file), ...patch };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    cache.set(file, next);
    return true;
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup. */ }
    return false;
  }
}
