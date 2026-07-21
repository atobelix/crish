# Streaming Transport Contract

Date: 2026-06-09

Scope: provider streams, daemon WebSocket events, sidecar reconnects, and Workbench replay.

## Product Rule

Crish should treat streaming as a durable transport contract, not a UI convenience. Every stream must have:

- one owner and one cancellation boundary
- a monotonic cursor or sequence where replay is possible
- one terminal result
- explicit cleanup of readers, sockets, subprocesses, and pending requests
- a slow-consumer policy
- enough diagnostics to reconnect or explain failure

This applies across `AgentRuntime -> AgentOrchestrator -> agent-daemon -> Tauri sidecar -> Workbench`.

## Reference Lessons

Claude-style bridge code is useful mainly for sequence discipline. Its SSE transport carries a high-water mark across transport swaps so reconnects do not replay from zero or skip unseen events. The important idea for Conex is not the exact transport, but that every reconnectable stream needs a scoped cursor tied to a session/run/event-log identity.

Codex-style tests are useful as a verification pattern. Its SSE test helpers model chunked delivery, gated chunks, malformed requests, empty streams, and completed events. Conex should keep adding fake provider and fake daemon stream tests instead of relying on live provider behavior.

Pi/OMP-style stream wrappers are useful for terminal-state discipline. Streams should coalesce deltas where useful, forward abort signals to the provider, preserve caller aborts, and settle `done` or `error` once. Lazy or idle provider streams must become typed timeout/stall results instead of hanging.

Readable stream semantics give the low-level guardrails: honor backpressure, do not write after close/destroy, release reader locks, propagate abort, and make finish/error cleanup idempotent.

## Crish Contract

Provider streams:

- Use provider-neutral events: `start`, `delta`, `tool-call`, `diagnostic`, `stop`, `error`.
- Prefer Responses-first OpenAI-compatible streaming when the route supports it; fall back to chat-completions only as an endpoint capability decision.
- Abort must cancel the current reader/body and must not enter retry.
- Consumer early return must cancel the upstream body.
- First-byte and idle timeouts are typed stream diagnostics, not generic runtime errors.
- Stream terminal events settle once. A source throwing after stop must not emit a second terminal state.

Daemon run events:

- Orchestrator events are immutable JSON snapshots at emit time.
- Durable runs append before broadcast. If append fails, the run becomes degraded/failed instead of advertising replayable history.
- Runtime events, terminal run events, approvals, and goal events share one event log sequence.
- History replay and live events must go through the same projector/reducer.

Sidecar and WebSocket:

- Every query has a `requestId`; success and error responses match by `requestId`.
- Uncorrelated daemon errors are diagnostics, not a reason to reject the oldest pending query.
- Writer, reader, heartbeat, or process failure must reject all pending queries with request context.
- Disconnect snapshots should include reason, count, generation, last reconnect attempt, and rejected pending count.
- Runs are daemon-owned; a Workbench socket disconnect drops only the live sink. Recovery uses status plus event replay.

Backpressure:

- Provider stdout/body bridges pause the source when the consumer queue is full and resume on pull/drain.
- WebSocket send failure or excessive buffer closes that client and records a diagnostic.
- UI delta floods should be coalesced at the Workbench projection/render layer; daemon event logs remain semantically complete.

### Client → Daemon stream control (Crish Desktop)

When the desktop render buffer exceeds a high-water mark (~64KB of unconsumed stream text), the client signals the daemon to stop pushing live deltas for that run. When the buffer drains below a low-water mark (~16KB), it signals resume. Chunks already received are never dropped on the client; the daemon side pause-buffers outbound events.

| Path             | Encoding                                                        | Payload                                        |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Binary preferred | `STREAM_PAUSE` `0x21` / `STREAM_RESUME` `0x22`                  | UTF-8 JSON meta `{ "runId": "<id>" }`          |
| JSON fallback    | `{ "type": "stream-pause" \| "stream-resume", "runId": "..." }` | First-class inbound protocol types (validated) |

Daemon behavior (`StreamBackpressureRegistry` + `RunHandler`):

1. **pause** — mark run paused; `for await` of orchestrator events waits on `waitIfPaused`; sink `send` buffers messages (drop-oldest at cap, default 512) instead of WS push.
2. **resume** — clear pause, flush buffer to the originating WebSocket (or broadcast if socket gone), wake waiters, resume real-time push.
3. **run end / cancel** — `clearRun` drops pause state and waiters (no leak).

Binary frames still ACK with `STREAM_ACK`. JSON path returns correlated `pong` after apply. Empty `runId` on JSON is a validation error; binary may omit meta and no-op.

## Required Tests

- SSE body ignores abort until our reader cancellation path fires.
- Consumer exits an async iterator early and upstream body is cancelled.
- Stop followed by source throw still produces one terminal result.
- Slow WebSocket client triggers transport diagnostics without killing daemon-owned runs.
- Restart/reconnect resumes using event log metadata and sequence, not only session/run id.
- Session history replay and live stream produce identical projected task snapshots.
- Benchmark covers daemon ready time, WebSocket connect time, status RTT, first token latency, event throughput, memory, and reconnect recovery.

## Current Gaps

- Benchmark currently measures daemon ready, WebSocket connect, and `get-status` RTT. First-token latency and event throughput still need fake-provider support.
- Bun remains an experimental runtime candidate until the same stream/abort/fs/process tests pass under Bun TS and Bun compiled builds.
- Provider route selection must use route capabilities and health, not only model display names.
- Workbench still needs more visible diagnostics for slow session list and replay paths.
