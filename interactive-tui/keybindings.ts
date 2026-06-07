/**
 * Keyboard chord classification for the interactive composer.
 *
 * Copy must always be EXPLICIT: either the `/copy` command, or a modifier-based
 * chord (Cmd+C, Ctrl+Shift+C). A bare alphabetic key — most importantly a lone
 * "c" on a blank composer — must type normally and never trigger copy. This
 * module is the single source of truth for that decision so the input path and
 * its tests can't drift. See interactive.keybindings.test.ts.
 */

/** Minimal structural shape of an OpenTUI KeyEvent we care about for chords. */
export interface ChordKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  super?: boolean;
}

/**
 * True only for the explicit, modifier-based "copy" chords:
 *   - Cmd+C  (terminals that preserve the meta/super modifier)
 *   - Ctrl+Shift+C  (Windows/Linux terminal convention)
 *
 * A bare "c" (or any bare alphabetic key) is never a copy chord — it types.
 */
export function isExplicitCopyChord(key: ChordKey): boolean {
  if (key.name !== "c") return false;
  const isCmd = Boolean(key.meta || key.super);
  return isCmd || Boolean(key.ctrl && key.shift);
}
