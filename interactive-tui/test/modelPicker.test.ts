import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadPrefs, savePrefs, restoreLegacyFavorites } from "../prefs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringWidth } from "bun";
import { clipModelText, modelPickerRow, modelPickerWindow, orderModelChoices, toggleModelFavorite } from "../modelPicker";

const choices = [
  { id: "openrouter/claude", label: "Claude", description: "OpenRouter · premium" },
  { id: "anthropic/claude", label: "Claude (Anthropic)", description: "direct Anthropic API" },
  { id: "google/gemini", label: "Gemini 3.1 Flash-Lite (AI Studio)", description: "Google AI Studio · cheap scout" },
];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sift-model-picker-"));
  dirs.push(dir);
  return join(dir, ".siftable", "prefs.json");
}

describe("model favorites", () => {
  it("persists exact provider/model identities in the shared prefs across reopening", () => {
    const file = fixture();
    expect(savePrefs({model:{id:"codex/current"}, favorites:["anthropic/claude"]}, file)).toBe(true);
    const restored = JSON.parse(readFileSync(file, "utf8"));
    expect(restored).toEqual({ model: {id: "codex/current"}, favorites: ["anthropic/claude"] });
    expect(orderModelChoices(choices, restored.favorites).map((row) => row.id)).toEqual(["anthropic/claude", "openrouter/claude", "google/gemini"]);
  });
  it("retains selection when favoriting and unfavoriting reorders rows", () => {
    const added = toggleModelFavorite(choices, [], choices[2]);
    expect(added.selectedIndex).toBe(0);
    const removed = toggleModelFavorite(choices, added.favorites, choices[2]);
    expect(removed).toEqual({ favorites: [], selectedIndex: 2 });
  });
  it("restores legacy favorites only when shared prefs has no saved list", () => {
    const file = fixture();
    savePrefs({}, file);
    const legacy = join(file, "..", "model-favorites.json");
    writeFileSync(legacy, '{"favorites":[null,5,"", "future/model", "future/model"]}');
    expect(restoreLegacyFavorites({ model: { id: "codex/current" } }, legacy)).toEqual({model:{id:"codex/current"}, favorites:["future/model"]});
    expect(restoreLegacyFavorites({ favorites: [] }, legacy)).toEqual({ favorites: [] });
    expect(restoreLegacyFavorites({ favorites: ["anthropic/claude"] }, legacy)).toEqual({ favorites: ["anthropic/claude"] });
    expect(restoreLegacyFavorites(JSON.parse(readFileSync(file, "utf8")), legacy)).toEqual({ favorites: ["future/model"] });
    expect(savePrefs({favorites:[]}, file)).toBe(true);
    expect(loadPrefs(file)).toEqual({ favorites: [] });
    writeFileSync(legacy, '{');
    expect(restoreLegacyFavorites({}, legacy)).toEqual({});
  });
  it("reports failed persistence without updating the in-memory preference", () => {
    const file = fixture();
    // A file at the directory location prevents writes, independently of uid.
    writeFileSync(join(file, ".."), "blocked");
    expect([savePrefs({favorites:["a/b"]}, file), loadPrefs(file)]).toEqual([false, {}]);
  });
});

describe("model picker columns", () => {
  it("leaves an explicit gutter after the longest name", () => {
    const row = modelPickerRow(choices[2], choices, 110, true, true, false);
    expect(row).toContain("Gemini 3.1 Flash-Lite (AI Studio)  Google AI Studio");
    expect(row.startsWith("› ★ ")).toBe(true);
  });
  it("bounds rows at narrow and wide terminal sizes with Unicode names", () => {
    const unicode = { id: "test/model", label: "模型 👨‍👩‍👧‍👦 Café", description: "details 🐝 long output" };
    for (const width of [0, 1, 5, 20, 40, 60, 80, 120]) {
      expect(stringWidth(modelPickerRow(unicode, [...choices, unicode], width, true, true, true))).toBeLessThanOrEqual(width);
      expect(stringWidth(modelPickerRow(choices[2], choices, width, false, false, false))).toBeLessThanOrEqual(width);
    }
    expect(clipModelText("👨‍👩‍👧‍👦abc", 3)).toBe("👨‍👩‍👧‍👦…");
  });
});

it("keeps the selected model visible in a short terminal", () => {
  const catalog = Array.from({ length: 30 }, (_, index) => index);
  for (const selected of [0, 15, 29]) {
    const visible = modelPickerWindow(catalog, selected, 20);
    expect(visible.length).toBe(8);
    expect(visible.some((row) => row.index === selected)).toBe(true);
  }
});
