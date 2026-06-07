/**
 * Regression coverage for the "plain c starts a message" fix.
 *
 * A bare alphabetic key — most importantly a lone "c" on a blank composer —
 * must type normally and never trigger copy. Copy is explicit: the modifier
 * chords (Cmd+C, Ctrl+Shift+C) or the /copy command. isExplicitCopyChord is the
 * single source of truth the input path consults, so asserting it here pins the
 * behavior without standing up the full TUI.
 */
import {isExplicitCopyChord, type ChordKey} from '../../interactive-tui/keybindings';

const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');

describe('isExplicitCopyChord', () => {
  it('does not treat a bare "c" as copy (it types instead)', () => {
    expect(isExplicitCopyChord({name: 'c', sequence: 'c'})).toBe(false);
  });

  it('never treats any bare alphabetic key as copy', () => {
    for (const ch of LOWER) {
      expect(isExplicitCopyChord({name: ch, sequence: ch})).toBe(false);
      // Shift alone (uppercase typing) is still typing, not a copy chord.
      expect(isExplicitCopyChord({name: ch, sequence: ch.toUpperCase(), shift: true})).toBe(false);
    }
  });

  it('recognizes the explicit Cmd+C chord', () => {
    expect(isExplicitCopyChord({name: 'c', meta: true})).toBe(true);
    expect(isExplicitCopyChord({name: 'c', super: true} as ChordKey)).toBe(true);
  });

  it('recognizes the explicit Ctrl+Shift+C chord', () => {
    expect(isExplicitCopyChord({name: 'c', ctrl: true, shift: true})).toBe(true);
  });

  it('does not treat bare Ctrl+C as copy (that is the interrupt chord)', () => {
    expect(isExplicitCopyChord({name: 'c', ctrl: true})).toBe(false);
  });
});
