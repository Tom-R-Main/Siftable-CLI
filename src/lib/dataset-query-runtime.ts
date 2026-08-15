import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

interface DatasetQueryRuntime {
  validateSiftDatasetFilters(
    value: unknown,
    options?: {label?: string; fieldKey?: 'field' | 'property'; maxItems?: number},
  ): Array<{path: string; message: string}>;
  validateSiftDatasetSorts(
    value: unknown,
    options?: {label?: string; maxItems?: number},
  ): Array<{path: string; message: string}>;
}

let loadedRuntime: DatasetQueryRuntime | undefined;

export function datasetQueryRuntime(): DatasetQueryRuntime {
  if (loadedRuntime) return loadedRuntime;
  const candidates = [
    resolve(__dirname, 'vendor', 'datasetQueryContract.js'),
    resolve(__dirname, '..', '..', '..', 'shared', 'dist', 'types', 'datasetQueryContract.js'),
  ];
  const runtimePath = candidates.find(candidate => existsSync(candidate));
  if (!runtimePath) {
    throw new Error('Canonical dataset query runtime is unavailable. Rebuild @siftable/cli.');
  }
  const runtime = require(runtimePath) as Partial<DatasetQueryRuntime>;
  if (
    typeof runtime.validateSiftDatasetFilters !== 'function'
    || typeof runtime.validateSiftDatasetSorts !== 'function'
  ) {
    throw new Error(`Invalid canonical dataset query runtime at ${runtimePath}`);
  }
  loadedRuntime = runtime as DatasetQueryRuntime;
  return loadedRuntime;
}
