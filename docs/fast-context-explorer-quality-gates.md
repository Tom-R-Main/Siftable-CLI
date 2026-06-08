# Fast Context Explorer Quality Gates

Status: implemented behind rollout flags
Owner surface: `packages/exf-cli/interactive-tui`
Related baseline: `packages/exf-cli/docs/repo-explorer-eval.md`

## Goal

Rebuild Repo Explorer into a Fast Context style retrieval subsystem:

```text
main model -> cheap retrieval model -> parallel glob/grep/read -> compact file+range artifact -> main model
```

The retrieval model must return evidence, not conclusions. The main model should receive bounded file and line-range context with confidence and warnings, not a prose repository report.

This program is intentionally gate-heavy. A stage is not done until deterministic tests and the named evidence artifact prove the behavior. Live-model runs are allowed as smoke tests, but they do not prove correctness.

## Non-Negotiable Invariants

- Retrieval output is a compact artifact of files and line ranges.
- Generic workspace key files are never promoted to primary evidence without query, path, or cwd/package support.
- The active cwd is searched and scored before the workspace root.
- Scout/fanout failure is partial evidence, not a green success.
- Deterministic tests use fake agents or direct tool calls; CI must not require a live model.
- Tool economics favor many parallel traversal calls with strict output caps, not tiny call limits.
- Zig owns only narrow traversal or byte-scanning kernels after correctness parity and benchmark proof.
- TypeScript owns model/provider routing, JSON orchestration, UI state, command routing, and rollout flags.

## Quality Gate Matrix

| Gate | Scope | Must Produce | Blocks On |
| --- | --- | --- | --- |
| G0 Baseline | Current Explorer behavior | Baseline JSON and markdown summary | Existing eval harness and tests |
| G1 Artifact Contract | Retrieval artifact schema | Model-free schema tests | Invalid/oversized/no-evidence cases |
| G2 Tool Layer | `glob`, `grep`, `read_many` | Fixture repo tool tests | Stable sorting, caps, skips, line numbers |
| G3 Scout Orchestration | Fast Context style turns | Fake-scout parallelism tests | Turn/call/output/time caps |
| G4 Cwd Scoring | Package-local retrieval | Cwd fixture evals | CLI prompt must not rank unrelated apps |
| G5 UI Truthfulness | Explorer activity rendering | Snapshot tests | Weak evidence and duplicate rows |
| G6 Eval Harness | File/range retrieval scoring | Deterministic eval report | Precision-weighted file/range metrics |
| G7 Zig Native Lane | Native traversal acceleration | Parity tests and benchmarks | Zig 0.16.0 gates and before/after numbers |
| G8 Rollout | Flags and fallback | Rollout smoke matrix | One-env rollback and no raw context dumps |

## G0: Baseline

Purpose: freeze current Explorer behavior before changing semantics.

Implementation tasks:
- Extend `packages/exf-cli/scripts/eval-repo-explorer.ts` only if needed to emit all current fields as JSON.
- Keep the existing fake-agent path as the deterministic baseline.
- Add baseline prompts that reproduce known failures:
  - `how does our cli work?`
  - `why does Explorer show duplicate blocks?`
  - `where is command routing?`
  - `where is repo_explorer injected?`
  - `what owns native file search?`

Deterministic tests:
- Eval runs without network or live model.
- Each prompt emits mode, query count, suggested files, scout/fanout status, elapsed time, report chars, and post-Explorer tool counts.
- The bad CLI prompt records the current incorrect or weak candidate behavior before it is fixed.

Required evidence:
- `npm run explorer:eval --workspace @siftable/cli -- --json --quick`
- `npm test --workspace @siftable/cli -- --runInBand`
- `cd packages/exf-cli/interactive-tui && bun test`

Pass criteria:
- Baseline report is deterministic across two local runs except timing fields.
- Baseline documents failures as expected failures, not regressions.

## G1: Retrieval Artifact Contract

Purpose: replace prose reports with a strict retrieval artifact.

Proposed shape:

```ts
interface ExplorerRetrievalArtifact {
  files: Array<{
    path: string;
    ranges: Array<{ startLine: number; endLine: number }>;
    reason: string;
    confidence: number;
    source: "deterministic" | "scout" | "fanout";
  }>;
  missedAreas: string[];
  warnings: string[];
  stats: {
    mode: "quick" | "medium" | "deep";
    turns: number;
    toolCalls: number;
    parallelBatches: number;
    elapsedMs: number;
    filesSearched: number;
    matchesFound: number;
    truncated: boolean;
  };
}
```

Implementation tasks:
- Add parser and normalizer in `interactive-tui/explorer.ts`.
- Deduplicate by `path + startLine + endLine`.
- Clamp confidence to `[0, 1]`.
- Clamp max files, ranges per file, reason length, warnings, and total serialized chars.
- Make injection use the artifact, not the full prose report.

Deterministic tests:
- Valid artifact is preserved.
- Invalid JSON fails closed with a warning.
- Missing `files` yields low evidence.
- Out-of-range line numbers are rejected or normalized.
- Duplicate ranges collapse deterministically.
- Oversized output is truncated with `stats.truncated=true`.
- No evidence can produce `high` or `medium` confidence.

Required evidence:
- New unit tests beside Explorer tests or under `packages/exf-cli/test`.
- `npm test --workspace @siftable/cli -- --runInBand`

Pass criteria:
- The main model-visible injected context is only the compact artifact plus fixed safety instructions.
- Existing `formatExplorerReport` may remain for debug, but it is not the default model context in Fast Context mode.

## G2: Deterministic Tool Layer

Purpose: provide the restricted cross-platform traversal tools needed by a cheap retrieval model.

Tools:
- `glob_local_files`: path discovery by glob.
- `grep_local_files`: regex content search.
- `read_many_regions`: bounded file/range reads.

Implementation tasks:
- Add tool handlers in `interactive-tui/brain.ts` or extract a testable helper module.
- Reuse existing `fsEngine.ts` policy where possible.
- Prefer cwd-relative search by default.
- Include result metadata: count, truncated, root, elapsedMs, skippedByReason.

Fixture repo requirements:
- Nested package: `packages/exf-cli`.
- Unrelated app path: `apps/best-edit`.
- Generated/ignored dirs: `node_modules`, `dist`, `.git`, `.zig-cache`, `zig-out`.
- Hidden safe files and env-like files.
- Tests and source files with overlapping terms.

Deterministic tests:
- Glob returns stable sorted paths.
- Grep supports regex and include filters.
- Grep returns line numbers and snippets with caps.
- Reads preserve requested order and line numbers.
- Reads refuse or skip secret-like files unless explicitly allowed.
- Skip diagnostics match TypeScript and native traversal policy where applicable.

Required evidence:
- Tool tests run without a model.
- `cd packages/exf-cli/interactive-tui && bun test`

Pass criteria:
- Tool outputs are bounded, deterministic, and safe to show to a retrieval model.
- Search tools report truncation rather than silently dropping results.

## G3: Scout Orchestration

Purpose: align scout economics with Fast Context: high parallelism, short horizon, strict output caps.

Target profiles:

| Profile | Turns | Parallel Calls Per Turn | Max Calls | Wall Clock Target |
| --- | ---: | ---: | ---: | ---: |
| quick | 2 | 4 | 8 | 2500ms |
| medium | 4 | 8 | 32 | 5000ms |
| deep | 6 | 8 | 48 | 9000ms |

Implementation tasks:
- Replace the current tiny `maxToolCalls` scout budget with turn-aware budgets.
- Count parallel batches separately from tool calls.
- Add fake-scout execution tests that force 8 calls in one turn.
- Penalize duplicate calls in stats and warnings.
- Preserve partial artifacts on timeout.

Deterministic tests:
- 8 fake tool calls in one turn execute as one parallel batch.
- Max turns are enforced.
- Max calls are enforced.
- Timeout returns partial artifact and warning.
- Duplicate calls are counted.
- Bad tool-call JSON fails closed.

Required evidence:
- Model-free fake-scout tests.
- Eval run comparing deterministic, scout, and fanout modes.

Pass criteria:
- A medium run can perform up to 32 bounded traversal calls.
- Scout failure never turns the whole Explorer row green.

## G4: Cwd-First Scoring

Purpose: prevent repo-root fallback from overriding the active package context.

Implementation tasks:
- Treat `SIFT_USER_CWD` / session cwd as the first retrieval root.
- Search workspace root second.
- Add domain query terms:
  - `cli`
  - `command`
  - `commands`
  - `sift`
  - `siftable`
  - `exf`
  - `oclif`
  - `interactive`
  - `auth`
  - `work`
  - `tasks`
  - `brain`
  - `toolview`
- Mark workspace key files as orientation hints unless supported by a query or cwd package signal.

Deterministic tests:
- From `packages/exf-cli`, `how does our cli work?` ranks CLI files before unrelated apps.
- `apps/best-edit/*` never appears in top candidates for the CLI prompt.
- `queries.length === 0` produces low evidence, not primary candidates.
- Package-local `package.json`, command files, and `interactive-tui` files receive cwd boost.

Required evidence:
- Unit tests for query compilation.
- Fixture eval for cwd-first ranking.

Pass criteria:
- The known screenshot failure is impossible in deterministic tests.

## G5: UI Truthfulness

Purpose: make activity rows communicate evidence quality rather than optimistic completion.

Implementation tasks:
- Extend `ExplorerActivityView` with evidence quality:
  - `fallbackOnly`
  - `queryCount`
  - `matchCount`
  - `rangeCount`
  - `confidence`
  - `partial`
- Render one live/final Explorer row, not duplicate fanout and final rows.
- Rename display from generic `checked repo` to evidence-based states.

Example rows:

```text
Fast Context · 24 calls · 6 files · 14 ranges · 4.2s · high
Fast Context · fallback only · 0 matches · 4 warnings
Fast Context · partial · 0/4 scouts · 8 calls · low
```

Deterministic tests:
- `0 matches` renders as fallback-only or low evidence.
- `0/4 scouts` renders warning/partial state.
- Duplicate fanout/final events collapse.
- Snapshot tests cover high, partial, failed, and fallback-only states.

Required evidence:
- `cd packages/exf-cli/interactive-tui && bun test test/render.test.tsx`
- Snapshot review for intentional output changes.

Pass criteria:
- UI never says `checked repo` when evidence is weak.
- Repeated Explorer blocks are gone.

## G6: Eval Harness

Purpose: prove retrieval quality before defaulting Fast Context mode on.

Fixture format:

```ts
interface ExplorerEvalFixture {
  prompt: string;
  cwd: string;
  expectedFiles: string[];
  expectedRanges?: Array<{ path: string; startLine: number; endLine: number }>;
  forbiddenTopFiles?: string[];
}
```

Metrics:
- File precision.
- File recall.
- Range precision.
- Range recall.
- Latency.
- Tool calls.
- Parallel batches.
- Injected context bytes.
- Scout/fanout failures.

Scoring:
- Weight precision higher than recall.
- Treat forbidden top files as hard failures.
- Treat context bytes over cap as hard failure.

Deterministic tests:
- Fixture scoring is pure and snapshot-tested.
- Fake retrieval artifacts produce known scores.
- Current bad cases fail before the implementation and pass after it.

Required evidence:
- `npm run explorer:eval --workspace @siftable/cli -- --json`
- Committed fixture file or snapshot report.

Pass criteria:
- Fast Context mode beats current deterministic mode on precision-weighted score.
- No fixture regresses to unrelated top candidates.

## G7: Zig Native Lane

Purpose: accelerate traversal only where measured. Zig is not the orchestration layer.

Version assumption:
- Local `zig version`: `0.16.0`.
- Existing native surface: `packages/exf-cli/interactive-tui/build.zig`.

Allowed Zig scope:
- File traversal.
- Byte search.
- Repo manifest/index generation.
- Compact deterministic scanners.

Disallowed Zig scope unless separately justified:
- Model/provider SDKs.
- Auth.
- HTTP streaming.
- JSON-heavy orchestration.
- UI state.
- Command routing.

Implementation tasks:
- Add native functionality only behind a TypeScript fallback.
- Keep C ABI narrow: pointer-plus-length inputs, explicit output buffers, status codes.
- Mirror TypeScript behavior exactly before benchmarking.

Deterministic tests:
- Native and TypeScript traversal produce equal file sets on fixture repos.
- Native and TypeScript grep produce equal line/range results.
- Gitignore and generated-dir skip behavior match.
- Large, binary, invalid UTF-8, hidden, and env-like files are covered.
- FFI status codes and output truncation are covered.

Required evidence:
- Native/TypeScript parity test output for changed traversal behavior.
- Before/after benchmark output for any speed claim.
- Required gates after touching Zig:

```sh
cd packages/exf-cli/interactive-tui
zig fmt --check $(git ls-files '*.zig')
bun run native:test
bun run native:build
bun run native:bench
```

Pass criteria:
- Correctness passes in Debug/ReleaseSafe lanes before benchmark claims.
- Any speedup claim includes before/after `native:bench` numbers.
- Native path can be disabled without changing behavior.

## G8: Rollout

Purpose: ship safely and preserve rollback.

Flags:
- `SIFT_EXPLORER=off|deterministic|fast-context`
- `SIFT_EXPLORER_THOROUGHNESS=quick|medium|deep`
- `SIFT_EXPLORER_MODEL`
- `SIFT_EXPLORER_PROVIDER`
- `SIFT_EXPLORER_DEBUG=1`

Implementation tasks:
- Keep deterministic mode available.
- Do not log raw file contents in debug stats.
- Log artifact stats and warnings only.
- Make one-env rollback work.

Deterministic tests:
- Each flag combination maps to expected mode.
- Missing model/provider falls back safely.
- Debug logging redacts file contents and secrets.
- `off` mode skips all Explorer work.

Required evidence:
- Fast Context eval report.
- Existing CLI build and manifest smoke:

```sh
npm run interactive:help --workspace @siftable/cli
```

Pass criteria:
- Fast Context can become default only after G0-G8 pass.
- Rollback to `SIFT_EXPLORER=deterministic` or `off` is verified.

## Implementation Order

1. G0 baseline and fixture prompts.
2. G1 artifact parser/normalizer.
3. G2 traversal tools.
4. G3 scout orchestration budgets and fake-scout tests.
5. G4 cwd-first scoring.
6. G5 UI truthfulness and snapshots.
7. G6 precision-weighted eval harness.
8. G7 native parity and benchmarks if profiling justifies Zig work.
9. G8 rollout flags and smoke matrix.

## Completion Definition

The program is complete only when:

- All gates have deterministic tests.
- All required commands for changed surfaces pass.
- Eval fixtures show Fast Context mode improves retrieval quality without context bloat.
- UI truthfully reports weak, partial, and failed evidence.
- Zig changes, if any, have parity evidence and benchmark evidence.
- Rollback is verified.

## Implementation Evidence

Last verified: 2026-06-07

Behavioral changes:
- G0-G1: Eval prompts and a normalized `<repo_explorer_artifact>` contract are in place.
- G2-G3: Restricted local `glob`, `grep`, and bounded region-read tools support higher-call scout traversal.
- G4: Package cwd and query evidence outrank repo-root fallback candidates.
- G5: Explorer activity rows report fallback/low/partial evidence instead of unconditional success.
- G6: The deterministic eval gate scores Fast Context against fixture expectations and fails on forbidden top files or context-cap violations.
- G7: No Zig traversal code was changed for this implementation; existing native lanes were used as parity/benchmark evidence.
- G8: `SIFT_EXPLORER=off|deterministic|fast-context` and `SIFT_EXPLORER_THOROUGHNESS=quick|medium|deep` provide rollout and rollback controls.

Verification commands:
- `npm run build --workspace @siftable/cli`
- `npm test --workspace @siftable/cli -- --runInBand`
- `cd packages/exf-cli/interactive-tui && bun test`
- `npm run interactive:help --workspace @siftable/cli`
- `npm run explorer:eval --workspace @siftable/cli -- --json --quick --assert`
- `npm run explorer:eval --workspace @siftable/cli -- --json --assert`
- `cd packages/exf-cli/interactive-tui && zig fmt --check $(git ls-files '*.zig')`
- `cd packages/exf-cli/interactive-tui && bun run native:test`
- `cd packages/exf-cli/interactive-tui && bun run native:build`
- `cd packages/exf-cli/interactive-tui && bun run native:bench`

Latest asserted eval gates:
- Quick: deterministic score `0.413`, Fast Context score `0.5`, forbidden top-file hits `0`, context-cap violations `0`.
- Full: deterministic score `0.26`, Fast Context score `0.295`, forbidden top-file hits `0`, context-cap violations `0`.
