/** Current Meta routes and compatibility for retired local selections. */
export const META_DEFAULT_MODEL = 'muse-wonder-1.0';
export const META_SPARK_MODEL = 'muse-spark-1.3';

/** Keep old Contributor selections on Spark instead of moving them to Wonder. */
export function normalizeMetaModel(model?: string): string {
  const raw = model?.trim();
  if (!raw) return META_DEFAULT_MODEL;
  const unqualified = raw.replace(/^meta[:/]/i, '');
  const id = unqualified.toLowerCase();
  if (/^muse-spark(?:-1[.-][123])?(?:-contributor)?$/.test(id)
    || ['muse-contributor', 'spark-contributor', 'spark'].includes(id)) return META_SPARK_MODEL;
  if (/^muse-wonder(?:-1[.-]0)?$/.test(id)
    || ['meta', 'muse', 'wonder'].includes(id)) return META_DEFAULT_MODEL;
  return unqualified;
}
