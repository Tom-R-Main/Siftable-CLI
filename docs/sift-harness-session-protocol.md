# Sift harness session protocol

Status: implemented for AGENT-RUNTIME-31 (protocol version 1).
Code: `interactive-tui/sessionServer.ts`, `interactive-tui/questionGate.ts`,
the `--session-mode` entry in `interactive-tui/headless.ts`.

## Decision

The long-lived harness session speaks newline-delimited JSON over stdin and
stdout. It does not implement the Agent Client Protocol (ACP) in this change.

Reasons:

1. The work item requires event replay from a cursor, with monotonically
   increasing sequence numbers that survive a process restart. ACP's
   `session/update` notifications carry no sequence number, and `session/load`
   replays a whole conversation rather than resuming from a cursor. We would
   have had to add this as an extension either way.
2. ACP does not report token usage in its baseline methods. The protocol here
   reports usage per turn and per session.
3. The one-shot `sift agent run` output already uses the event envelope
   `{schemaVersion, seq, session, ...}`. The benchmark tooling and supervisors
   already parse it. Session mode keeps the same envelope, so those consumers
   can parse session-mode events with their existing parser.
4. ACP is JSON-RPC 2.0 with requests in both directions, and permission
   requests are agent-to-client RPCs. Here, approvals and questions are
   ordinary events in the replayable stream. A client that reconnects can
   replay them and still answer a request that is pending, because the answer
   is keyed by `requestId` rather than by an RPC id from a connection that no
   longer exists.

ACP remains a plausible later adapter over this server. Its methods map
directly: `session/prompt` to `prompt`, `session/cancel` to `cancel`,
`session/update` to events, `session/request_permission` to
`approval.request` and `approval.respond`, and `elicitation/create` to
`question.request` and `question.answer`.

## Transport

    bun interactive-tui/headless.ts --session-mode --provider P --model M \
      [--cwd DIR] [--session ID] [--deadline-ms N] [--max-rounds N] \
      [--base-url URL] [--effort E] [--max-output-tokens N]

- One JSON object per line in each direction, UTF-8. Lines longer than
  1 MiB are rejected with `line_too_long` and skipped.
- stdout carries only protocol lines. Diagnostics go to stderr.
- One process serves one session. The session holds at most one active turn,
  so there is one tool loop per session. The durable journal lease and a
  separate wire-log lease stop a second process from serving the same session.
- `--prompt`, `--approval`, `--verify-*`, `--supervisor-handoff`, and any
  `--format` other than `jsonl` are refused in session mode. The one-shot mode
  and its flags are unchanged.
- Approvals prompt the client. No standing allow or deny policy applies.
- EOF on stdin, SIGINT, SIGTERM, and `shutdown` all run the same shutdown:
  stop the active turn and wait for its confirmed stop, close the engine, then
  emit `session.closed`.

## Commands (client to server)

Every command has an `id` (a nonempty string of at most 128 characters, or a
safe integer) and a `type`. Each command receives exactly one response:

    {"type":"response","id":...,"ok":true,...}
    {"type":"response","id":...,"ok":false,"error":{"code":"...","message":"..."}}

Responses are not events. They have no `seq` and are not replayed.

| type | fields | response |
| --- | --- | --- |
| `initialize` | `protocolVersion: 1` | `session`, `lastSeq`, `resumed`, `busy`, `agent`, `capabilities` (engine-specific: `questions` is false for Codex; `usage.source` names where usage comes from) |
| `prompt` | `input` (string, 1..262144 chars) | `turnId` |
| `approval.respond` | `requestId`, `decision` (`deny` \| `allow` \| `always` \| `bypass`) | `status: applied` or `already_resolved` (with the original decision and source) |
| `question.answer` | `requestId`, and `answer` (string) or `decline: true` | `status: applied` or `already_resolved` |
| `cancel` | optional `turnId` | `status: stopping`, `already_stopping`, or `no_active_turn` |
| `replay` | `after` (cursor, default 0), `limit` (1..10000, default 1000) | `events`, `through`, `lastSeq`, `more` |
| `usage` | | `usage: {session, complete, lastTurn, turns}`; `lastTurn` is null before any turn or when the engine reported no usage |
| `shutdown` | | `status: closed`, `exitCode` |

Every command except `initialize` and `shutdown` requires a prior
`initialize`. After shutdown starts, other commands return `shutting_down`.

Error codes: `parse_error`, `invalid_request`, `unsupported_version`,
`not_initialized`, `unknown_command`, `turn_in_progress`, `stop_unconfirmed`, `unknown_request`,
`decision_not_offered`, `shutting_down`, `line_too_long`.

## Events (server to client)

    {"schemaVersion":1,"seq":N,"session":"...","ts":"ISO-8601","type":"...","turnId":"...",...}

`seq` starts at 1 for a new session and increases by one per event, including
across process restarts of the same session. No event is written to stdout
until an fsync of the wire log covers its `seq` (group commit: events emitted
in the same event-loop tick share one fsync, and a response flushes every
earlier event first). A client therefore never holds a `seq` that a restart
could lose.

| type | meaning |
| --- | --- |
| `turn.started` | A prompt was admitted. |
| `token`, `tool_call`, `tool_result`, `status`, `provider`, `verification`, `done`, `error` | Brain events, the same shapes the one-shot mode emits. |
| `approval.request` | `requestId`, `kind`, `path`, `detail`, `decisions` (the decisions offered). |
| `approval.resolved` | `requestId`, `decision`, `source` (`client` or `cancelled`). |
| `question.request` | `requestId`, `question`, optional `options`. Raised by the `ask_user` tool. |
| `question.resolved` | `requestId`, `outcome` (`answered`, `declined`, `cancelled`). |
| `status` with `status: stopping` | A cancel, deadline, or shutdown began stopping the turn. |
| `usage` | `turn` and `cumulative` totals: requests, input, output, cached input, and total tokens, plus `complete`. `turn` is null when the engine reported no usage for the turn; that is "unavailable", not zero. `complete` becomes false for the rest of the session once any turn's usage was unavailable or partial, and `cumulative` is then a lower bound. `cumulative` spans every process that has served the session. It precedes the turn's terminal event. |
| `turn.completed`, `turn.failed`, `turn.limit_reached`, `turn.interrupted` | Terminal event of a turn that was not cancelled. Same fields as the one-shot `run.*` event. |
| `turn.stopped` | Terminal event of a cancelled turn whose engine proved it ended: `confirmed: true`, `reason` (`client`, `deadline`, `shutdown`), `jobCleanup` when known. |
| `turn.stop_unconfirmed` | Terminal event of a turn whose end could not be proven: `confirmed: false`. With `reason` `client`, `deadline`, or `shutdown`, the live engine did not confirm within its bound, and later prompts return `stop_unconfirmed` until the session is shut down and resumed. With `reason: process_exit` and `recovered: true`, the process that ran the turn died; see Replay and recovery. |
| `session.closed` | The last event of a process: `reason`, cumulative `usage`, `turns`. |

Each turn ends with exactly one terminal event. When a turn is cancelled,
`turn.stopped` is emitted only after the engine has proved the turn ended.
For the Sift harness, that means its tool loop has returned and the session's
process jobs have been stopped. For Codex, it means app-server sent
`turn/completed` after `turn/interrupt`. The interrupt acknowledgement alone
is not enough. If Codex does not confirm within 10 seconds, or disconnects
first, the turn ends with `turn.stop_unconfirmed` instead.

Results are read per engine. The harness always reports a status. Codex
reports none when a turn completes, so a Codex result with no error is
`turn.completed`.

Usage is also read per engine. The harness sums its provider receipts. Codex
sums the per-response `last` breakdowns from app-server's
`thread/tokenUsage/updated` notifications. A Codex turn that received none
reports `turn: null`. Pending approvals and questions
from that turn are revoked first, and their `*.resolved` events come before
`turn.stopped`.

## Idempotency

The server records every approval and question it relays. A response to a
request that is already resolved, whether by the client or by cancellation,
is reported as `already_resolved` with the recorded outcome, and it is never
applied again. A decision the request did not offer (for example `bypass` on a
non-bypassable request) returns `decision_not_offered`, and the request stays
pending.

## Replay and recovery

The wire log is `<session-event-root>/wire/<sha256(session)>.wire.jsonl`, with
file mode 0600. When the log file is created, the file and its directory are
fsynced before any event is sent, so the new directory entry is durable too.
Directories the store creates are fsynced by the store. The log sits next to the harness session journal
(`~/.siftable/session-events/v1` or `SIFT_SESSION_EVENT_ROOT`). A final
fragment with no newline, left by a crash during an append, is truncated when
the log is opened. Every event is fsynced before it is sent (see Events), so
a crash can lose only events that no client has seen.

To reconnect, start a new process with the same `--session`, send
`initialize` (it reports `resumed` and `lastSeq`), then page through
`replay {after: cursor}` until `more` is false. Cumulative usage and the turn
count are rebuilt from the log, so `usage` continues across restarts. The replay is taken
synchronously, so a live event can never fall between the replayed page and
the stream. If the previous process died during a turn, the new process closes
that turn once with `turn.stop_unconfirmed {reason: "process_exit",
recovered: true, confirmed: false}`. Nothing proves how the dead turn ended,
and processes it started may still be running. Its tool loop cannot continue
in the new process, so the resumed session accepts new turns. The harness
journal separately recovers the interrupted model turn.

## Not covered yet

- Image input in `prompt` (text only).
- Codex-provider turns do not raise `question.request`, and `initialize`
  reports `questions: false` for them. Codex approvals use the same gate and
  do round-trip.
- Replay keeps the session's events in memory. A very long session grows
  memory in proportion to its event count.
