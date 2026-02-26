import * as readline from 'node:readline';

export interface Column {
  key: string;
  header: string;
  get?: (row: Record<string, unknown>) => string;
}

export function renderTable(data: Record<string, unknown>[], columns: Column[]): void {
  if (data.length === 0) {
    console.log('No results found.');
    return;
  }

  const getValue = (row: Record<string, unknown>, col: Column): string => {
    const val = col.get ? col.get(row) : row[col.key];
    return val != null ? String(val) : '—';
  };

  const widths = columns.map(col => {
    const maxData = Math.max(...data.map(row => getValue(row, col).length));
    return Math.max(col.header.length, maxData, 2);
  });

  const header = columns.map((col, i) => col.header.padEnd(widths[i])).join('  ');
  const separator = columns.map((_, i) => '─'.repeat(widths[i])).join('  ');

  console.log(header);
  console.log(separator);

  for (const row of data) {
    const line = columns.map((col, i) => getValue(row, col).padEnd(widths[i])).join('  ');
    console.log(line);
  }
}

export function renderDetail(pairs: [string, unknown][]): void {
  const maxKey = Math.max(...pairs.map(([key]) => key.length));
  for (const [key, value] of pairs) {
    console.log(`${key.padEnd(maxKey)}  ${value ?? '—'}`);
  }
}

export function formatDate(isoString?: string | null): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString();
}

export function formatDateTime(isoString?: string | null): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
}

export async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({input: process.stdin, output: process.stderr});
  const answer = await new Promise<string>(resolve => {
    rl.question(`${message} (y/N) `, resolve);
  });
  rl.close();
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '…';
}
