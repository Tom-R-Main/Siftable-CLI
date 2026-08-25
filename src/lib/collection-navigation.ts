export interface CollectionNavigationOptions {
  nextCursor?: string | null;
  total?: number | null;
  cursorSupported: boolean;
}

export function collectionNavigation(
  returned: number,
  limit: number,
  options: CollectionNavigationOptions,
) {
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : Math.max(returned, 1);
  const nextCursor = options.nextCursor ?? null;
  const total = options.total ?? null;
  const complete = options.cursorSupported
    ? nextCursor === null
    : nextCursor === null && (total !== null ? returned >= total : returned < effectiveLimit);
  const continuationMissing = !complete && !options.cursorSupported;

  return {
    page: {
      returned,
      nextCursor,
      total,
      complete,
      snapshotId: null,
    },
    omissions: [
      ...(total === null ? ['totalCount'] : []),
      ...(continuationMissing ? ['continuationCursor'] : []),
    ],
    warnings: continuationMissing
      ? ['The collection may contain more results, but this backend does not expose a continuation cursor. Narrow filters or raise the limit.']
      : [],
  };
}
