// Durable user preferences for sift interactive, persisted to
// ~/.siftable/prefs.json. Mirrors the audio.ts sounds-pref pattern (same dir).
// Load is cached; saves merge a partial patch over the current file so callers
// only write the slice they own. All disk I/O is best-effort — a missing or
// corrupt file degrades to defaults rather than throwing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

let cache: SiftPrefs | null = null;

export function loadPrefs(): SiftPrefs {
  if (cache) return cache;
  try {
    if (existsSync(PREF_FILE)) {
      const parsed = JSON.parse(readFileSync(PREF_FILE, "utf8")) as SiftPrefs;
      cache = parsed && typeof parsed === "object" ? parsed : {};
      return cache;
    }
  } catch {
    /* corrupt or unreadable prefs — fall back to defaults */
  }
  cache = {};
  return cache;
}

/** Merge a partial update into the saved prefs and write them back. */
export function savePrefs(patch: Partial<SiftPrefs>): void {
  const next: SiftPrefs = { ...loadPrefs(), ...patch };
  cache = next;
  try {
    mkdirSync(PREF_DIR, { recursive: true });
    writeFileSync(PREF_FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}
