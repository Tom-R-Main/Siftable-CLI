/** Scan completeness is independent of successful tool execution and display limits. */
export interface SearchScan {
  status: "complete" | "partial" | "failed" | "cancelled";
  reasons: string[];
}

export interface SearchPresentation {
  clipped: boolean;
  reasons: string[];
}

export function completeSearchScan(): SearchScan {
  return {status: "complete", reasons: []};
}

export function mergeSearchScans(...scans: SearchScan[]): SearchScan {
  const severity = {complete: 0, partial: 1, failed: 2, cancelled: 3};
  return {
    status: scans.reduce<SearchScan["status"]>((status, scan) => severity[scan.status] > severity[status] ? scan.status : status, "complete"),
    reasons: [...new Set(scans.flatMap(scan => scan.reasons))],
  };
}

export function searchScanFromStats(stats: {
  capped?: boolean;
  capReason?: string | null;
  skippedByReason?: Partial<Record<"ioError" | "invalidUtf8" | "tooLarge" | "depth", number>>;
}): SearchScan {
  const reasons: string[] = [];
  if (stats.capped || stats.capReason) reasons.push(stats.capReason ?? "scanCap");
  for (const reason of ["ioError", "invalidUtf8", "tooLarge", "depth"] as const) {
    if ((stats.skippedByReason?.[reason] ?? 0) > 0) reasons.push(reason);
  }
  return {status: reasons.length ? "partial" : "complete", reasons: [...new Set(reasons)]};
}

export function searchPresentation(...reasons: string[]): SearchPresentation {
  return {clipped: reasons.length > 0, reasons: [...new Set(reasons)]};
}

export function searchCancellation(signal?: AbortSignal): SearchScan {
  return signal?.aborted ? {status: "cancelled", reasons: ["cancelled"]} : completeSearchScan();
}

/** Prevent NaN/negative limits or native u32 wrapping from changing search scope silently. */
export function validateSearchLimits(limits: Record<string, number | undefined>): void {
  for (const [name, value] of Object.entries(limits)) {
    const minimum = ["maxDepth", "contextLines", "previewBytes"].includes(name) ? 0 : 1;
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff)) {
      throw new Error(`${name} must be an integer between ${minimum} and 4294967295`);
    }
  }
}
