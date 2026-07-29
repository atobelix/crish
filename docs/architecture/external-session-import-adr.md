# ADR: External Conversation Import (Claude Code + Codex CLI)

**Status**: Accepted  
**Date**: 2026-07  
**Owner**: `apps/crish-desktop/src/api/import/**`  
**Related**: Session lifecycle (`session-pending-draft-adr.md`), session export (`sessionExport.ts`), workspace FS guard

---

## 1. Context

Users of Crish often already have local agent history from:

1. **Claude Code** (Anthropic CLI / VS Code host)
2. **OpenAI Codex CLI**

They want a **click-to-import** path in Settings and FirstRunWizard so existing transcripts become Crish sessions without re-running agents. Import must be **opt-in**, **read-only**, and must not scan the user’s home directory from CI agents or build scripts.

---

## 2. Decision

Ship a **one-shot external session import** pipeline:

```
[UI click] → detect local roots → list session metadata
         → user selects sessions → parse JSONL → map → createSession + addMessage
```

- Pure TypeScript parsers and mappers first (unit-tested, no UI coupling).
- Discovery runs **only in-app** when the user opens Import UI, via Tauri FS APIs with an **allow-root** set to the detected config directory (not the whole home tree as a free scan surface).
- No live sync, no background watcher, no bidirectional write-back to Claude/Codex.

---

## 3. Sources and on-disk layouts (public docs + in-repo reference)

### 3.1 Claude Code

| Item | Path / pattern |
| ---- | -------------- |
| Config home | `%USERPROFILE%\.claude` (Windows) or `~/.claude` (POSIX); override `CLAUDE_CONFIG_DIR` |
| Projects root | `<config>/projects/` |
| Project dir name | munged cwd: non-alphanumeric → `-` (e.g. `C:\Software\conex` → `C--Software-conex`) |
| Session file | `<projects>/<munged>/<session-uuid>.jsonl` |
| Global prompt history | `<config>/history.jsonl` (**not imported** as sessions; optional future “composer history” only) |

**Reference in repo**: `reference/claudeCode/utils/sessionStorage.ts`, `sessionStoragePortable.ts`, `listSessionsImpl.ts`, `types/logs.ts`.

**JSONL line kinds (import cares about)**:

| `type` | Role |
| ------ | ---- |
| `user` / `assistant` | Transcript turns (`message.content` string or Anthropic content blocks) |
| `custom-title` / `ai-title` / `summary` / `last-prompt` | Title / preview metadata |
| `file-history-snapshot`, `attachment`, `progress`, sidechain | Skipped or best-effort |

Content blocks: `text`, `thinking`, `tool_use` (`id`, `name`, `input`), `tool_result` (`tool_use_id`, `content`).

### 3.2 OpenAI Codex CLI

| Item | Path / pattern |
| ---- | -------------- |
| Codex home | `%USERPROFILE%\.codex` or `~/.codex`; override `CODEX_HOME` |
| Sessions tree | `<codex-home>/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| History index | `<codex-home>/history.jsonl` (resume index / search — **not** primary transcript) |

**Reference in repo**: `reference/codex-cli/codex-rs/app-server/tests/common/rollout.rs`, `protocol/src/models.rs` (`ResponseItem`, `ContentItem`).

**Rollout envelope** (each line):

```json
{ "timestamp": "<RFC3339>", "type": "<kind>", "payload": { ... } }
```

| Envelope `type` | Import handling |
| --------------- | --------------- |
| `session_meta` | Source id, cwd, model provider, createdAt |
| `response_item` | Conversation: `message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call*`, … |
| `event_msg` | UI events (`user_message`, token counts); used for preview fallback only when needed |

Public confirmation of layout: Codex docs / community (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).

---

## 4. Mapping to Crish schema

Target store types live in `apps/crish-desktop/src/store/types.ts`:

| External | Crish |
| -------- | ----- |
| Session / thread id | New Crish `SessionState.id` (minted); preserve source id in import provenance metadata on the mapper result (not required on store until UI needs it) |
| Title / first prompt / customTitle | `SessionState.title` |
| Project cwd / munged project folder | `SessionState.folder` (humanized when possible) |
| User / assistant text | `SessionMessage.sender` + `text` |
| Thinking / reasoning summary | `SessionMessage.thinking` |
| Tool use + result | `SessionMessage.toolCalls[]` (`id`, `name`, `arguments`, `status`, `output`) |
| Timeline order | `SessionMessage.blocks` (`text` / `tool_call`) when tools present |
| Timestamps | `SessionMessage.timestamp` (epoch ms); session `timestamp` ISO |

**Non-mapped (v1)**: subagent sidechains, MCP raw envelopes, binary/image blobs, file-history snapshots, PR links, git branch as first-class fields (may appear only in title/folder heuristics).

Import result shape (API layer):

```ts
ImportedCrishSession {
  source: 'claude-code' | 'codex'
  sourcePath: string
  sourceSessionId: string
  title: string
  folder: string
  messages: SessionMessage[]
  createdAtMs?: number
  warnings: string[]  // parse skips, truncated files, unknown line types
}
```

UI/store commit path (later, not this ADR’s scaffold): `createSession({ title, folder, activate:false })` then `addMessage` for each mapped message. Prefer not reusing pending-draft for bulk import.

---

## 5. Privacy & security

| Rule | Detail |
| ---- | ------ |
| Opt-in only | No scan until user opens Import UI or FirstRun import step |
| Read-only | Never write/modify Claude or Codex files |
| Allow-root FS | Tauri `list_directory` / `read_file_content` invoked with `workspaceRoot` = detected config root (`.claude` or `.codex`), not unrestricted home |
| No body logging | Parsers/detectors must not `console.log` full message bodies; errors may log counts/paths only |
| No user transcripts in git | Fixtures are synthetic only under `__fixtures__/` |
| Size caps | Skip or truncate giant JSONL (align with Claude’s ~50 MB transcript caution; default hard cap configurable, e.g. 32 MB read) |
| Secrets | Treat transcripts as sensitive; do not upload or send to telemetry |

---

## 6. Discovery algorithm (in-app)

1. Resolve roots (never recursive home scan) in order:
   - Explicit `ImportPathEnv` / Settings UI custom roots (`localStorage` `crish_import_claude_root` / `crish_import_codex_root`)
   - Process env when available: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` (desktop Vite bundle has empty `process.env`; product path is UI persistence)
   - Default: `<home>/.claude` and `<home>/.codex`
2. Probe existence of `projects/` and `sessions/` respectively under the chosen roots only.
3. **Claude**: list project dirs under `projects/`; for each, list `*.jsonl` whose basename is a UUID; lite-read head/tail (≤64 KB) for title preview + mtime + line-count estimate.
4. **Codex**: walk `sessions/YYYY/MM/DD/` shallow (depth 3); match `rollout-*.jsonl`; parse first lines for `session_meta` + first user preview.
5. Present list sorted by `mtime` desc; user multi-selects; full parse only for selected files.

Home directory for path resolution comes from host (`USERPROFILE` / `HOME`) via a small injectable env helper — **not** by recursively scanning `$HOME`.

---

## 7. Non-goals (v1)

- Live sync / file watchers against Claude or Codex
- Writing sessions back into Claude/Codex formats
- Importing `history.jsonl` as full sessions
- Importing remote Claude “CCR” cloud history (OAuth API)
- Cloning or vendoring **ccswitch** (or similar third-party switchers) unless only cited as docs
- Auto-import on every app start
- Perfect fidelity of sidechains, multi-agent Codex parent threads, or image payloads
- UI chrome beyond existing Settings / FirstRunWizard integration hooks (UI is a follow-up consumer of these modules)

---

## 8. Alternatives considered

| Alternative | Why not |
| ----------- | ------- |
| Always-on home scan at bootstrap | Privacy + startup cost |
| Shell out to `claude` / `codex` resume APIs | Extra runtime dep; not offline-friendly |
| Full Node `fs` from renderer | Prefer Tauri permissioned FS; keep parsers pure |
| Duplicate session store format 1:1 with Claude JSONL | Crish already has `SessionMessage`; mapper is cheaper than dual store |

---

## 9. Implementation ownership

| Path | Responsibility |
| ---- | -------------- |
| `docs/architecture/external-session-import-adr.md` | This decision record |
| `apps/crish-desktop/src/api/import/**` | Detect, parse, map, host FS adapter |
| `apps/crish-desktop/src/api/import/__fixtures__/**` | Synthetic JSONL only |
| Settings / FirstRunWizard (follow-up) | Click-to-import UX calling these APIs |

---

## 10. Open questions

1. **ccswitch / multi-CLI switchers**: Out of scope unless a path convention appears in public docs; do not clone those projects into the monorepo for import.
2. **Dedup** (resolved OPT-C5): Soft-dedup keys on `source + sourceSessionId` via `SessionState.importMeta`. Default policy `skip` (no overwrite); `reimport` opt-in for forced second copy. UI toast in Chinese when duplicates skipped.
3. **Codex archived sessions**: Whether to scan `archived/` sibling of `sessions/` (if present) — defer until product asks.
4. **Workspace binding**: Map imported `cwd` to an open Crish project folder vs free-text `folder` string only.
5. **FS allow-list UX** (resolved OPT-D6): Settings / FirstRunWizard ExternalSessionImport can set optional custom Claude/Codex roots via directory picker; persisted under `crish_import_claude_root` / `crish_import_codex_root`; clear restores defaults.

---

## 11. Consequences

- New pure TS package surface under `api/import` with high unit-test coverage.
- Existing workspace FS commands remain project-scoped for editor; import host reuses them with **config-root as temporary workspaceRoot**.
- Product can add FirstRun “Import from Claude / Codex” without redesigning session persistence.
