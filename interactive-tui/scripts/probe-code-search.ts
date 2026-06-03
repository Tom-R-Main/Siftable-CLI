import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { clearWorkspaceFileCache, codeSearch } from "../fsEngine.ts";

type Scenario = {
  name: string;
  maxFiles: number;
  forceEachQuery?: boolean;
  useContentCache?: boolean;
};

const root = resolve(process.argv[2] || process.cwd());
const maxFiles = Number(process.argv[3] || 2000);
const absentQuery = `absent-${Date.now().toString(36)}-search-probe`;
const queries = [
  { name: "absent", query: absentQuery },
  { name: "rare", query: "SearchCaps" },
  { name: "common", query: "const" },
];
const scenarios: Scenario[] = [
  { name: "cold-no-cache", maxFiles, forceEachQuery: true },
  { name: "warm-file-set", maxFiles },
  { name: "warm-content-cache", maxFiles, useContentCache: true },
  { name: "narrowed-file-set", maxFiles: Math.min(maxFiles, 250) },
];

function ms(value: number | undefined): string {
  return value == null ? "0.0" : value.toFixed(1);
}

for (const scenario of scenarios) {
  clearWorkspaceFileCache(root);
  console.log(`\nscenario=${scenario.name} root=${root} maxFiles=${scenario.maxFiles}`);
  for (const item of queries) {
    const start = performance.now();
    const result = await codeSearch({
      root,
      intent: item.query,
      queries: [item.query],
      maxFiles: scenario.maxFiles,
      maxSpans: item.name === "common" ? 12 : 8,
      forceRefresh: scenario.forceEachQuery,
      useContentCache: scenario.useContentCache,
    });
    const wallMs = performance.now() - start;
    const timings = result.stats.phaseTimings;
    const content = result.stats.contentCache;
    console.log([
      `query=${item.name}`,
      `wall=${ms(wallMs)}`,
      `cacheHit=${result.stats.cacheHit}`,
      `eligible=${result.stats.eligibleFiles ?? 0}`,
      `searchedFiles=${result.stats.searchedFiles}`,
      `bytes=${result.stats.searchedBytes}`,
      `spans=${result.spans.length}`,
      `truncated=${result.stats.truncated}`,
      `fileSetBuild=${ms(timings?.fileSetBuildWallMs)}`,
      `search=${ms(timings?.searchWallMs)}`,
      `searchRead=${ms(timings?.searchReadWallMs)}`,
      `searchScan=${ms(timings?.searchScanWallMs)}`,
      `shape=${ms(timings?.shapeWallMs)}`,
      `preview=${ms(timings?.previewWallMs)}`,
      `contentHitBytes=${content?.hitBytes ?? 0}`,
      `contentMissBytes=${content?.missBytes ?? 0}`,
    ].join(" "));
  }
}
