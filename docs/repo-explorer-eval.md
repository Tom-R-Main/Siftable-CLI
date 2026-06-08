# Repo Explorer Eval Baseline

Date: 2026-06-03
Commit: 0097f62a
Command: `npm run explorer:eval --workspace packages/exf-cli -- --json`
Raw output: `/tmp/repo-explorer-eval.json` (not committed)

The baseline uses the harness fake agent, so it is a repeatable behavior smoke rather than a final answer-quality score. Run with `--real-agent` for manual quality notes.

Follow-on quality program: `packages/exf-cli/docs/fast-context-explorer-quality-gates.md`.

Current gate command:

```sh
npm run explorer:eval --workspace @siftable/cli -- --json --assert
```

As of 2026-06-07, the asserted fixture gate passes with Fast Context ahead of deterministic retrieval on precision-weighted score and no forbidden top-file hits.

| mode | runs | avg elapsed ms | avg report chars | avg post tool calls | avg searches | avg reads | scout files used | redundant broad searches | scout failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| explorer off | 8 | 0 | 0 | 2 | 1 | 1 | 0 | 0 | 0 |
| deterministic | 8 | 42 | 2327 | 1 | 0 | 1 | 0 | 0 | 0 |
| deterministic + scout | 8 | 31 | 2567 | 1 | 0 | 1 | 4 | 0 | 0 |

Initial read:
- Single-scout mode is behaving safely in the harness: no failures and no redundant broad-search regressions.
- Scout context adds modest report bulk in this baseline, roughly 1.10x deterministic report chars.
- Scout suggestions were consumed on 4 of 8 prompts in the fake-agent run, enough to justify a controlled one-wave fan-out experiment behind `SIFT_EXPLORER_FANOUT=1`.
