import {sanitizeTerminalLine, sanitizeTerminalText, truncate} from './output.js';

/** Request detail types and their text rendering for `sift work` runtime commands. */

export interface RuntimeQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{label: string; description: string; value?: string}>;
  optionsOmitted?: number;
  allowCustomAnswer?: boolean;
  multiSelect?: boolean;
}

export interface RuntimePatchFile {
  path: string;
  added: number;
  removed: number;
}

export interface RuntimeRequestDetail {
  text?: string;
  /** The agent's text was cut before it reached Sift; textOriginalLength is its length before cutting. */
  textTruncated?: boolean;
  textOriginalLength?: number;
  files?: RuntimePatchFile[];
  filesOmitted?: number;
  questions?: RuntimeQuestion[];
}

/** Characters of request text printed inline; --full-detail prints all of it. */
export const REQUEST_TEXT_PREVIEW = 500;

export interface RequestRenderOptions {
  /** Print the whole stored text, line by line, instead of a one-line preview. */
  fullDetail?: boolean;
}

/** A path shown quoted when surrounding spaces would otherwise be invisible. */
function displayPath(path: string): string {
  const clean = sanitizeTerminalLine(path);
  return clean === clean.trim() ? clean : JSON.stringify(clean);
}

export function renderRequestDetail(detail: RuntimeRequestDetail, options: RequestRenderOptions): string[] {
  const lines: string[] = [];
  const text = detail.text;
  if (text) {
    if (options.fullDetail) {
      for (const line of sanitizeTerminalText(text).split(/\r?\n/)) lines.push(`  ${line}`);
    } else {
      const flat = sanitizeTerminalLine(text);
      lines.push(`  ${truncate(flat, REQUEST_TEXT_PREVIEW)}`);
      if (flat.length > REQUEST_TEXT_PREVIEW) {
        lines.push(`  (Showing ${REQUEST_TEXT_PREVIEW} of ${text.length} stored characters. Add --full-detail to print all of it.)`);
      }
    }
    if (detail.textTruncated && typeof detail.textOriginalLength === 'number') {
      lines.push(`  (The agent's text was cut to ${text.length} of ${detail.textOriginalLength} characters before it reached Sift. The rest is only in the agent session.)`);
    }
  }
  // Files can all be omitted (paths too long to list); the count still shows.
  const files = detail.files ?? [];
  const omitted = detail.filesOmitted ?? 0;
  if (files.length + omitted > 0) {
    lines.push(`  Files (${files.length + omitted}):`);
    for (const file of files) lines.push(`    ${displayPath(file.path)} +${file.added} -${file.removed}`);
    if (omitted > 0) lines.push(`    ${files.length ? 'and ' : ''}${omitted} ${files.length ? 'more ' : ''}not listed`);
  }
  return lines;
}
