# E0 / W9-MCP-2 — Stop control + shell multi-unit readiness (live tauri-mcp)

**Agent:** MCP Verifier Agent W9-MCP-2  
**Date:** 2026-07-29  
**Scope:** Live tauri-mcp verification of composer **Stop** presence / W7-5 copy + shell **multi-unit** readiness  
**Tooling:** tauri-mcp against running Crish desktop  
**Policy:** Record only what was observed live. Do **not** invent AI send PASS without a real model turn. Stop DOM was exercised via **store probe** (`message.status = 'processing'`), not via a live model stream.

## Environment

| Item | Value |
|------|-------|
| App | Crish **0.1.0** |
| Window | `main` |
| URL | `http://localhost:5174/` |
| OS | Windows (x86_64) |
| Viewport | 1320×880 (CSS) |
| Date | 2026-07-29 |

## Store / bridge facades

| Facade / helper | Present |
|-----------------|---------|
| `__CRISH_LAYOUT_STORE__` | **yes** |
| `__CRISH_SESSION_STORE__` | **yes** |
| `__CRISH_TREE_STORE__` | **yes** |
| `__CRISH_STORE__` | **yes** |
| `shell_snapshot` | **yes** |
| `open_session` / `open_new_draft` | **yes** |

---

## Journey results

### 1. App up (`app_info` / `state`)

| Check | Observation | Verdict |
|-------|-------------|---------|
| App name/version | Crish 0.1.0 | **PASS** |
| Window visible | `main`, title Crish / Crish · AI 工作台 | **PASS** |
| URL | `http://localhost:5174/` | **PASS** |
| readyState | `complete` | **PASS** |

### 2. Composer Stop when processing

| Check | Observation | Verdict |
|-------|-------------|---------|
| Idle draft (not processing) | `[data-testid=composer-stop]` **absent** | **PASS** (hidden when `!isProcessing`) |
| Composer input | `[data-testid=chat-input]` present | **PASS** |
| Send control idle | send button present; `aria-label` = `无法发送：请输入消息或添加附件`; **disabled**; **no** `title=` | **PASS** |
| Forced processing (store probe) | Opened `sess-1784141628869`, injected assistant msg `status: 'processing'` | setup only |
| Stop appears when processing | `[data-testid=composer-stop]` **visible** (32×32, opacity 1) | **PASS** |
| `data-stop-level` | `l2` | **PASS** |
| Queue button while processing | text `排队` present alongside Stop | **PASS** |
| After probe cleared | Stop **hidden** again; send returns | **PASS** |
| Live model mid-stream Stop click | **not run** (no model turn) | **SKIPPED** |
| Force cancel (Shift / long-press) live | **not run** | **SKIPPED** |

**Note:** `isProcessing` is derived as `messages.some(m => m.status === 'processing')` (`useChatCardState`). Probe messages were withdrawn after inspection; history restored to 14 msgs without `mcp-probe-*` ids.

### 3. Tooltip / aria (W7-5)

Live DOM on Stop (while processing probe active):

| Attribute | Live value | Expected (W7-5) | Verdict |
|-----------|------------|-----------------|---------|
| `aria-label` | `停止生成（协作停止）。Shift+点击或长按可强制取消` | 协作停止 + Shift/长按 + 强制取消 | **PASS** |
| `title` (native) | `null` | none (Tooltip only) | **PASS** |
| `data-testid` | `composer-stop` | `composer-stop` | **PASS** |
| `data-stop-level` | `l2` | L2 cooperative default | **PASS** |
| Tooltip portal text | Synthetic hover did **not** open `[role=tooltip]` in MCP | content wired in source | **SKIPPED** (hover portal) |

Source wiring (for cross-check; not a live hover proof):

| Constant / binding | Value |
|--------------------|-------|
| `STOP_TOOLTIP` | `停止生成（协作停止）。Shift+点击或长按：强制取消` |
| `STOP_ARIA_LABEL` | `停止生成（协作停止）。Shift+点击或长按可强制取消` |
| UI | `<Tooltip content={STOP_TOOLTIP}>` + `aria-label={STOP_ARIA_LABEL}` in `ComposerField.tsx` |

### 4. Multi-unit readiness (E0-5)

| Check | Observation | Verdict |
|-------|-------------|---------|
| `shell_snapshot.shellReady` | `true` | **PASS** |
| `openTabs` (final) | **2** tabs: draft `新对话` + `你好啊` (`sess-1784141628869`) | **PASS** (multi-tab strip) |
| Chat leaves in tree (`panelId === 'chat'`) | **1** leaf | single chat unit |
| Tree topology | horizontal branch: chat leaf + files leaf (tool dock), **not** multi-chat | observation |
| Unit strip | `[data-testid=unit-session-tab]` + `unit-strip-new-session` present | **PASS** (single-unit chrome) |
| `chat-body` / `chat-footer` / `chat-input` count | **1** each | single unit UI |
| Obvious multi-chat split UI button | **none** found (no 分屏/split control in interactive map) | — |
| Store APIs available | `tree.splitLeaf`, `layout.splitScreenWorkspace` exist | code readiness only |
| Multi-chat unit split exercised | **not** attempted without clear UI path | **NOT EXERCISED** |

**E0-5 multi-unit split:** **NOT EXERCISED** — only one chat leaf; multi-tab on one leaf is not multi-unit. No obvious split button to drive a second chat unit live.

### 5. Console errors during actions (`query_logs` between markers)

| Level | Note | Verdict |
|-------|------|---------|
| error (between markers) | 1× `ResizeObserver loop completed with undelivered notifications` | **WARN** (benign browser noise) |
| warn (session buffer) | Sidecar restart timeouts; IPC custom protocol → postMessage fallback; stale Tauri callback ids | pre-existing / env; not introduced as stop-control regressions |
| Probe-related app crashes | none observed | **PASS** |

---

## Summary table

| Gate | Result | Notes |
|------|--------|-------|
| App up | **PASS** | Crish 0.1.0 @ localhost:5174 |
| Composer present (input + send) | **PASS** | idle draft + real session |
| Stop hidden when idle | **PASS** | no `composer-stop` |
| Stop visible when `isProcessing` | **PASS** | store probe only |
| Stop aria W7-5 (协作停止 / Shift·长按 / 强制取消) | **PASS** | live `aria-label` |
| Stop no native `title=` | **PASS** | Tooltip-only policy |
| Stop Tooltip portal text | **SKIPPED** | synthetic hover did not open portal |
| Live model send | **SKIPPED** | policy: no invented model PASS |
| Live Stop L2 click / L3 force | **SKIPPED** | needs real stream |
| Multi-tab strip readiness | **PASS** | openTabs length 2 after session open |
| Multi-unit (multi chat leaf) split | **NOT EXERCISED** | chatLeafCount=1; no obvious UI split |
| Console hard fail on probe | **PASS** | only ResizeObserver noise in window |

## Explicitly NOT claimed

- AI **send** to a live model
- Stop mid-stream against a real engine run (L2 cooperative)
- Force cancel L3 (Shift+click / long-press + confirm) live
- Multi-chat unit layout restore / split UX

## Related docs

- Prior journey (draft / new-chat): [`e0-mcp-journey.md`](./e0-mcp-journey.md)
- Stop unit tests: `apps/crish-desktop/src/components/chat-composer/ComposerField.stop.test.tsx`
- Stop source: `apps/crish-desktop/src/components/chat-composer/ComposerField.tsx`
