export interface CollectionNavigationOptions {
  nextCursor?: string | null;
  total?: number | null;
  cursorSupported: boolean;
  completeOverride?: boolean;
}

export function collectionNavigation(
  returned: number,
  limit: number,
  options: CollectionNavigationOptions,
) {
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : Math.max(returned, 1);
  const nextCursor = options.nextCursor ?? null;
  const total = options.total ?? null;
  const inferredComplete = options.cursorSupported
    ? nextCursor === null
    : nextCursor === null && (total !== null ? returned >= total : returned < effectiveLimit);
  const complete = options.completeOverride ?? inferredComplete;
  const continuationMissing = !complete && nextCursor === null;

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
