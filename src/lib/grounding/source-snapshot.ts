import {createHash} from 'node:crypto';
import {errorResult, EvidenceResult, nowIso} from './types.js';

export interface SourceSnapshotInput {
  urls: string[];
}

export interface SourceSnapshotSignals extends Record<string, unknown> {
  snapshots: Array<{
    url: string;
    status: number;
    contentType: string | null;
    sha256: string;
    bytes: number;
  }>;
}

export async function collectSourceSnapshot(input: SourceSnapshotInput): Promise<EvidenceResult<SourceSnapshotSignals>> {
  const empty: SourceSnapshotSignals = {snapshots: []};

  try {
    const snapshots = [];
    for (const url of input.urls) {
      const response = await fetch(url);
      const body = await response.text();
      snapshots.push({
        url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: Buffer.byteLength(body),
      });
    }

    return {
      ok: true,
      mode: 'pattern',
      subject: 'source snapshot',
      fetchedAt: nowIso(),
      signals: {snapshots},
      warnings: [],
      errors: [],
    };
  } catch (error) {
    return errorResult('pattern', 'source snapshot', error, empty);
  }
}
