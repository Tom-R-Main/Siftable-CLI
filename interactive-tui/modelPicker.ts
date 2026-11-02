import { stringWidth } from "bun";

interface ModelRow {
  id: string;
  label: string;
  description: string;
}

export function orderModelChoices<T extends ModelRow>(choices: readonly T[], favorites: readonly string[]): T[] {
  const saved = new Set(favorites);
  return [...choices.filter((choice) => saved.has(choice.id)), ...choices.filter((choice) => !saved.has(choice.id))];
}

export function toggleModelFavorite<T extends ModelRow>(choices: readonly T[], favorites: readonly string[], selected: T) {
  const next = favorites.includes(selected.id) ? favorites.filter((id) => id !== selected.id) : [...favorites, selected.id];
  return { favorites: next, selectedIndex: orderModelChoices(choices, next).findIndex((choice) => choice.id === selected.id) };
}

export function clipModelText(text: string, columns: number): string {
  if (columns <= 0) return "";
  if (stringWidth(text) <= columns) return text;
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (stringWidth(result + segment) > columns - 1) break;
    result += segment;
  }
  return `${result}…`;
}

/** Reserve a real gutter, clipping each column by terminal cells before joining. */
export function modelPickerRow(choice: ModelRow, choices: readonly ModelRow[], columns: number, selected: boolean, favorite: boolean, current: boolean): string {
  const width = Math.max(0, columns);
  const prefix = `${selected ? "›" : " "} ${favorite ? "★" : " "} `;
  const available = Math.max(0, width - stringWidth(prefix));
  const nameWidth = Math.min(Math.max(...choices.map((row) => stringWidth(row.label)), 0), available < 24 ? available : Math.floor((available - 2) * 0.55));
  const name = clipModelText(choice.label, nameWidth);
  const descriptionWidth = Math.max(0, available - nameWidth - 2);
  const description = `${current ? "current · " : ""}${choice.description}`;
  return clipModelText(prefix + name + (descriptionWidth > 0 ? " ".repeat(nameWidth - stringWidth(name) + 2) + clipModelText(description, descriptionWidth) : ""), width);
}

export function modelPickerWindow<T>(choices: readonly T[], selectedIndex: number, terminalRows: number) {
  const count = Math.max(1, Math.min(choices.length, terminalRows - 12));
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(count / 2), choices.length - count));
  return choices.slice(start, start + count).map((choice, offset) => ({ choice, index: start + offset }));
}
