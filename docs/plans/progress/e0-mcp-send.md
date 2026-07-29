# E0-4 / W10-MCP-1 — full-ish send journey (live tauri-mcp)

**Agent:** MCP Verifier Agent W10-MCP-1  
**Date:** 2026-07-29 (live)  
**Scope:** E0-4 send path — minimal user message → assistant stream (if model/API works); Stop L2 only if stream starts  
**Tooling:** tauri-mcp (`query_page`, `execute_js`, `type_text`, `click`, `log_mark`, `query_logs`, `app_bridge`, `wait_for`)  
**Policy:** Record only what was observed live. **Do not invent PASS.** No claim of tool-call column / restart / rehydrate unless observed as part of this send.

| Overall | **SKIP** (send path exercised; model/daemon turn failed before any token stream) |
|---------|----------------------------------------------------------------------------------|

---

## Environment

| Item | Value |
|------|-------|
| App | Crish **0.1.0** |
| Window | `main` (visible) |
| URL | `http://localhost:5174/` |
| Title | `Crish · AI 工作台` |
| OS | Windows x86_64 |
| Viewport (CSS) | 1320×880 |
| Log marker | `e0-send-ping` |

---

## Preconditions

### 1. App / store facades

| Check | Observation | Verdict |
|-------|-------------|---------|
| `app_info` | Crish 0.1.0, main @ `http://localhost:5174/` | **PASS** |
| `state` | readyState `complete` | **PASS** |
| `__CRISH_STORE__` / `__CRISH_SESSION_STORE__` | present | **PASS** |
| `app_bridge` | `open_session`, `open_new_draft`, `shell_snapshot` | **PASS** |

### 2. Model selected (UI + settings)

| Field | Observed value |
|-------|----------------|
| UI model selector (`[data-testid=model-selector-button]`) | **deepseek-v4-flash** |
| `appSettings.defaultModel` | `deepseek-v4-flash` |
| `appSettings.defaultProvider` | `opencode-go` |
| `appSettings.defaultThinkingLevel` | `xhigh` |
| `appSettings.transport` | `http` |
| `appSettings.enabledModels` | `gemini-2.0-pro-exp`, `gemini-2.0-flash-thinking`, `gemini-1.5-flash`, `gemini-1.5-pro` |
| Chat footer toolbar | text includes `完全访问 deepseek-v4-flash` |

### 3. Providers / credentials (no secrets)

| Check | Observation |
|-------|-------------|
| `store.providers` | **array length 0** (empty) |
| Per-provider `apiKey` / secret dump | **not present** in store snapshot (nothing to dump) |
| `hasKey` boolean surface | **N/A** — no provider profile objects with key fields; routing appears settings-driven (`defaultProvider=opencode-go`) rather than populated `providers[]` |
| Configured enough to *attempt* send? | **Yes** — composer accepted send with selected model; daemon accepted run-task enough to return a validation error (not “no model selected”) |

---

## Journey steps

### Setup

| # | Step | Observed | Verdict |
|---|------|----------|---------|
| 0 | `open_new_draft` | `activeTabSessionId=__pending_draft__`, store `activeSessionId=__pending_draft__` | **PASS** |
| 1 | Composer idle | `[data-testid=chat-input]` present; send `aria-label=无法发送：请输入消息或添加附件`, **disabled** | **PASS** |
| 2 | `log_mark` begin `e0-send-ping` | marker inserted | setup |

### Type + send

| # | Step | Observed | Verdict |
|---|------|----------|---------|
| 3 | Type `ping` into `[data-testid=chat-input]` | input value = `ping` | **PASS** |
| 4 | Send enabled | button `aria-label=发送`, `disabled=false` | **PASS** |
| 5 | Click send (`button[aria-label='发送']`) | synthetic click applied | **PASS** (UI action) |
| 6 | Draft commit | new session **`sess-1785261003856`**, title **`ping`**, `sessions.length` 19→**20** | **PASS** (I-DRAFT commit path) |
| 7 | User message persisted | `user-msg-ms4yb2oh-69469e98-0000`, `sender=user`, `text=ping`, `status=completed` | **PASS** |
| 8 | Wait ≤30s for stream / Stop | `wait_for` Stop/alert **timed out 15s**; no sustained `processing`/`streaming` | **no stream** |
| 9 | Assistant outcome | assistant msg `assistant-msg-ms4yb2oj-cf106e3c-0001`, text **「这一轮没有顺利完成，请查看诊断信息后重试。」**; `toolCalls=[]`; **no** streamed tokens | **FAIL path / SKIP full send** |

### Stop (L2) — only if stream starts

| # | Step | Observed | Verdict |
|---|------|----------|---------|
| 10 | Stream starts | **did not** — `gotRealText=false`, `elapsedSec=0` on run-complete | **SKIPPED** |
| 11 | Click Stop L2 / assert `isProcessing` clears | **not run** (no mid-stream UI) | **SKIPPED** |

---

## Message snapshot (`sess-1785261003856` / title `ping`)

```
user:      id=user-msg-ms4yb2oh-69469e98-0000
           text="ping"  status=completed
           blocks=[{ type: "text", content: "ping" }]

assistant: id=assistant-msg-ms4yb2oj-cf106e3c-0001
           text="这一轮没有顺利完成，请查看诊断信息后重试。"
           thinking=""
           toolCalls=[]
           (no status=processing/streaming retained; failure immediate)
```

`runId` from stream logs: **`run-ms4yb2ok-hjd6wf`**

---

## Logs summary (`query_logs` between `e0-send-ping`)

Critical sequence (JS):

1. **`[crish-desktop][daemon-error]`**  
   `Invalid run-task message: $.clientMessageId: Unexpected field; $.assistantClientMessageId: Unexpected field`

2. **`[crish-stream]`** `scope=daemon-error`  
   - message: `这一轮没有顺利完成，请查看诊断信息后重试。`  
   - runId: `run-ms4yb2ok-hjd6wf`  
   - raw reason: same Unexpected field validation  
   - sessionId: `sess-1785261003856`  
   - context: `lastTool=null`, `toolCount=0`

3. **`[crish-stream]`** `scope=run-complete` / `kind=complete`  
   - message: `流正常收口`  
   - `gotRealText: false`, `elapsedSec: 0`, `toolCount: 0`

4. **`[crish-desktop][fetchRunSnapshotUsage]`**  
   `Run not found: run-ms4yb2ok-hjd6wf`

Also observed later in the same marker window (not send-root-cause, environment noise):

- IPC custom protocol → postMessage fallback (`Failed to fetch`)
- Vite reconnect / bootstrap re-run (HMR or reload mid-session)
- `[DesktopDaemonClient] Sidecar restart timed out after 3s polling`
- `[SessionSync] engine does not support sync-pull; pull disabled`

**Interpretation:** Frontend **did** attempt a live run against the daemon. The daemon **rejected the run-task payload schema** (`clientMessageId` / `assistantClientMessageId` unexpected). No model token stream occurred. This is **not** a successful E0-4 send; root blocker is **daemon ↔ desktop run-task contract mismatch**, not missing composer UI.

---

## Explicit non-claims

| Item | Status |
|------|--------|
| Successful assistant token stream | **NOT observed** |
| Stop L2 mid-stream clears `isProcessing` | **NOT run** |
| Force cancel L3 | **NOT run** |
| Tool column / tool calls during turn | **NOT observed** (`toolCount=0`) |
| Restart / rehydrate after successful turn | **NOT claimed** (vite reconnect noise only) |
| Multi-unit dual conversation | **NOT this agent’s scope** |

---

## Verdict table

| Gate | Result | Evidence |
|------|--------|----------|
| App up + model selected | **PASS** | `deepseek-v4-flash` / `opencode-go` |
| Provider keys in store | **N/A / empty `providers[]`** | hasKey surface absent; settings-driven |
| Type + send UI | **PASS** | `ping` → send click |
| Draft → real session on first send | **PASS** | `sess-1785261003856` title `ping` |
| Live model stream | **SKIP / FAIL** | daemon-error schema reject; no tokens |
| Stop L2 on live stream | **SKIPPED** | no stream to stop |
| **E0-4 full-ish send** | **SKIP** | exercised end-to-end; model/API path blocked by daemon validation |

---

## Follow-up (for implementers; not verified here)

- Align run-task JSON schema: desktop currently sends `clientMessageId` / `assistantClientMessageId`; daemon reports them as **Unexpected field**.
- Re-run this agent after schema fix: expect stream → optional Stop L2 → document **partial PASS** or full send PASS only if tokens observed.

---

## Related docs

| Doc | Relation |
|-----|----------|
| [`e0-mcp-journey.md`](./e0-mcp-journey.md) | I-DRAFT 「新对话」 slice **PASS**; send was still pending |
| [`e0-mcp-stop-shell.md`](./e0-mcp-stop-shell.md) | Stop DOM via **store probe** only; live mid-stream Stop still skipped |
| [`system-control-ledger.md`](./system-control-ledger.md) | E0 overall remains partial |
