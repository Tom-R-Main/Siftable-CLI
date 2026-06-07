/**
 * UI sound effects for `sift interactive`, played through OpenTUI's native
 * miniaudio engine. Mirrors the main app's interaction-feedback kit: the same
 * 11 WAVs (bundled under assets/sounds/), a shared 70ms rate-limiter so rapid
 * events don't machine-gun, and one named group for a single mute control.
 *
 * Disabled by default (matches the web app, which is opt-in). Toggle with the
 * `/sounds` command or `SIFT_SOUNDS=1`. The engine plays on the host running the
 * TUI — fine in the Dock; over SSH `start()` reports no device and we degrade to
 * silent. Every failure is swallowed: audio is never worth crashing the TUI.
 */
import { Audio, type AudioSound } from "@opentui/core";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SoundName =
  | "tap"
  | "confirm"
  | "notify"
  | "process"
  | "block"
  | "panelOpen"
  | "panelClose"
  | "toggleOn"
  | "toggleOff"
  | "listenStart"
  | "listenStop";

const SOUND_NAMES: SoundName[] = [
  "tap",
  "confirm",
  "notify",
  "process",
  "block",
  "panelOpen",
  "panelClose",
  "toggleOn",
  "toggleOff",
  "listenStart",
  "listenStop",
];

const SOUNDS_DIR = fileURLToPath(new URL("./assets/sounds/", import.meta.url));
const PREF_FILE = join(homedir(), ".siftable", "sounds.json");
const MIN_GAP_MS = 70; // mirrors the app's shared limiter — no double-fire spam
const DEFAULT_VOLUME = 0.6;

let engine: Audio | null = null;
let group = 0;
const loaded = new Map<SoundName, AudioSound>();
let available = false; // engine started against a real device
let enabled = false;
let initStarted = false;
let lastPlayMs = 0;

function loadPref(): boolean {
  const env = process.env.SIFT_SOUNDS?.toLowerCase();
  if (env === "1" || env === "true" || env === "on") return true;
  if (env === "0" || env === "false" || env === "off") return false;
  try {
    if (existsSync(PREF_FILE)) {
      const parsed = JSON.parse(readFileSync(PREF_FILE, "utf8")) as { enabled?: boolean };
      return Boolean(parsed.enabled);
    }
  } catch {
    /* ignore */
  }
  return false; // default off — opt-in, like the web app
}

function savePref(on: boolean): void {
  try {
    mkdirSync(join(homedir(), ".siftable"), { recursive: true });
    writeFileSync(PREF_FILE, `${JSON.stringify({ enabled: on }, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

async function ensureEngine(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  try {
    engine = Audio.create({ autoStart: false });
    engine.on("error", () => {
      /* degrade silently — never surface audio errors in the TUI */
    });
    group = engine.group("ui") ?? 0;
    if (!engine.start()) {
      available = false; // no output device (headless / SSH)
      return;
    }
    available = true;
    for (const name of SOUND_NAMES) {
      const path = join(SOUNDS_DIR, `${name}.wav`);
      if (!existsSync(path)) continue;
      const sound = await engine.loadSoundFile(path);
      if (sound != null) loaded.set(name, sound);
    }
  } catch {
    available = false;
  }
}

/** Restore the saved preference (call once on startup); loads the kit if on. */
export async function initSounds(): Promise<void> {
  enabled = loadPref();
  if (enabled) await ensureEngine();
}

export function soundsEnabled(): boolean {
  return enabled;
}

/** Toggle/SET sounds. Returns true when audio will actually be audible. */
export async function setSoundsEnabled(on: boolean): Promise<boolean> {
  enabled = on;
  savePref(on);
  if (on) {
    await ensureEngine();
    if (available) play("toggleOn");
  }
  return enabled && available;
}

/** Fire a UI sound. No-op when disabled, unavailable, unloaded, or rate-limited. */
export function play(name: SoundName, opts?: { volume?: number }): void {
  if (!enabled || !available || !engine) return;
  const sound = loaded.get(name);
  if (sound == null) return;
  const now = Date.now();
  if (now - lastPlayMs < MIN_GAP_MS) return;
  lastPlayMs = now;
  try {
    engine.play(sound, { volume: opts?.volume ?? DEFAULT_VOLUME, pan: 0, loop: false, groupId: group });
  } catch {
    /* ignore */
  }
}

export function disposeSounds(): void {
  try {
    engine?.dispose();
  } catch {
    /* ignore */
  }
  engine = null;
  available = false;
  loaded.clear();
  initStarted = false;
}
