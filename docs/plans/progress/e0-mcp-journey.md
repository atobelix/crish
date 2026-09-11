# E0-4 mcp-user-journey — live tauri-mcp smoke (partial)

**Policy:** Record only what was observed live. Do **not** invent PASS for send / stop / multi-unit / model runs.

## Related gates (already green elsewhere)

| Gate | Doc | Result |
|------|-----|--------|
| E0-1 invariants | [`e0-invariants.md`](./e0-invariants.md) | **16 tests PASS** (I-DRAFT / I-PROJ / I-SHELL / I-PTY + message upsert) |
| E0-2 typecheck | [`e0-typecheck.md`](./e0-typecheck.md) | **PASS** — 5 packages, 0 errors |
| Wave 5+6 targeted vitest | [`wave5-6-integration.md`](./wave5-6-integration.md) | **239 tests PASS** |
| Progress ledger | [`system-control-ledger.md`](./system-control-ledger.md) | E0 remains **partial** |

---

## Run: W9-MCP-1 — E0-4 slice A (I-DRAFT new-chat)

| Item | Value |
|------|-------|
| **Agent** | MCP Verifier W9-MCP-1 |
| **Timestamp** | 2026-07-29 (live re-verify) |
| **Scope** | E0-4 slice A: I-DRAFT 「新对话」 journey |
| **Tooling** | tauri-mcp (`query_page` / `execute_js` / DOM click) |
| **App** | Crish **0.1.0** · window `main` · `http://localhost:5174/` |
| **OS** | Windows |
| **Overall slice A** | **PASS** |

### Environment

| Check | Observation | Verdict |
|-------|-------------|---------|
| `app_info` | Crish 0.1.0, main visible, URL `http://localhost:5174/` | **PASS** — app running |
| `state` | title `Crish · AI 工作台`, readyState complete | **PASS** |
| Store facades | `__CRISH_SESSION_STORE__` / `__CRISH_LAYOUT_STORE__` / `__CRISH_TREE_STORE__` / `__CRISH_STORE__` all present | **PASS** |

### Baseline (before journey)

| Field | Value |
|-------|-------|
| `activeSessionId` | (precondition set to real session before click) |
| `sessions.length` | **19** |
| `draftsInSessions` (`id === '__pending_draft__'`) | **0** |
| Session titles | Real user titles（你好啊 / 分析代码仓库 / 这是一条测试消息…）— **not** mock「测试会话 A/B/C」 |

### Step table — I-DRAFT 「新对话」

| # | Step | Assert | Observed | Verdict |
|---|------|--------|----------|---------|
| 1 | App running | app_info + URL | Crish 0.1.0 @ `localhost:5174` | **PASS** |
| 2 | Precondition: leave draft | open historical `sess-1784141628869` | `activeSessionId=sess-1784141628869` | **PASS** |
| 3 | Click sidebar 「新对话」 | `sessions.length` unchanged | **19 → 19** | **PASS** |
| 4 | After 1st 「新对话」 | no `__pending_draft__` in `sessions[]` | `draftsInSessions=0` | **PASS** |
| 5 | After 1st 「新对话」 | active is pending draft | `activeSessionId=__pending_draft__` | **PASS** |
| 6 | 2nd click 「新对话」 | still no empty-shell growth | `sessions.length=19`, drafts=0, active stays `__pending_draft__` | **PASS** |
| 7 | Draft empty UI | empty prompt / disabled send | 「我们该在 … 中处理什么？」; send `disabled` +「无法发送：请输入消息或添加附件」; tab「新对话」 | **PASS** |
| 8 | Optional: historical open + hydrate | messages load; list/map same ref | title「你好啊」; `listMessages=14`, `mapMessages=14`, **`sameRef=true`** | **PASS** |
| 9 | Real data only | no mock A/B/C | `mockABC=false` | **PASS** |

### Final numeric snapshot (this run)

```
before:              { active: sess-1784141628869, len: 19, drafts: 0 }
afterFirstNewChat:   { active: __pending_draft__,  len: 19, drafts: 0 }
afterSecondNewChat:  { active: __pending_draft__,  len: 19, drafts: 0 }
hydrate(你好啊):     { listMessages: 14, mapMessages: 14, sameRef: true }
```

### Notes / tooling

- Sidebar 「新对话」 exercised via `#crish-sidebar button` with text `新对话` (`.click()`). tauri-mcp synthetic pointer on session `treeitem` did not always update store; native DOM `click()` / store `setActiveSessionId` used where synthetic path was unreliable for **precondition only**. Assertion path for 新对话 used real sidebar button click.
- Earlier mid-run observation: empty message arrays on some sessions before hydrate settle; final re-open of「你好啊」showed **14** messages with list/map same ref after settle.
- Brief intermediate observation once showed `listMessages=14` / `mapMessages=15` / `sameRef=false` mid-hydrate; **final** assert after settle is **14/14 sameRef=true** — recorded as PASS for getSessionForWrite path.

### Explicitly NOT verified (still pending for full E0-4)

| Step | Status |
|------|--------|
| Type user message and **send** to a live model | **Not run** |
| Tool call / tool column during a real turn | **Not run** |
| **Stop** mid-stream (L2) / force (L3) against live run | **Not run** |
| Continue-after-abort | **Not run** |
| Restart / rehydrate journey | **Not run** |
| E0-5 multi-unit / split dual conversation | **Not run** |

---

## Prior run: W7-9 — draft smoke (2026-07-29)

**Agent:** Docs Agent W7-9
**Scope:** Live tauri-mcp verification of Crish desktop draft / new-chat path (E0-4 slice)

### Journey steps exercised (prior)

#### 1. Initial state — draft already active

| Check | Observation | Verdict |
|-------|-------------|---------|
| `activeSessionId` | Already `__pending_draft__` | I-DRAFT active path ready |
| Sessions list | Real session titles (not mock「测试会话 A/B/C」) | UI looks production-backed |

#### 2. Click 「新对话」 — I-DRAFT live smoke

| Check | Before → After | Verdict |
|-------|----------------|---------|
| `sessions.length` | 19 → **19** (unchanged) | No empty shell mint |
| `draftsInSessions` | **0** | Draft not listed in `sessions[]` |
| `activeSessionId` | remains `__pending_draft__` | Pending draft path stable |

**I-DRAFT (live MCP):** **PASS**

#### 3. Empty / draft UI

| Check | Observation | Verdict |
|-------|-------------|---------|
| Empty state UI | Present for draft | **OK** |
| Composer send when empty | Disabled (expected) | **OK** |
| Stop / send controls in DOM | Present for new chat | **OK** (DOM only; not exercised against a live model) |

#### 4. Session list content note

| Check | Observation | Verdict |
|-------|-------------|---------|
| Sidebar titles | Real titles, not mock A/B/C | **OK** |
| `messages.length` on listed sessions in `getState` snapshot | Often **0** | **Observation only** — lazy remote shells + Stream D body path; see [`session-body-empty-gap.md`](./session-body-empty-gap.md) (W9-DATA) |

---

## Summary (latest = W9-MCP-1)

| Slice | Result |
|-------|--------|
| Store facades wired | **PASS** |
| I-DRAFT via 「新对话」 (no shell mint, draft stays active) | **PASS** (re-verified W9-MCP-1) |
| Double-click 新对话 — no empty shell growth | **PASS** |
| Draft empty UI + empty-send disabled | **PASS** |
| Real session titles in list | **PASS** |
| Optional historical hydrate + sameRef | **PASS** (14 msgs, sameRef true) |
| Full send → tool → stop → restart journey | **PENDING** |
| Multi-unit / split (E0-5) | **PENDING** |

**E0-4 overall:** **partial** — slice A (I-DRAFT new-chat) **PASS** live; full user journey still open.

## Follow-ups

1. Live send with a configured provider; assert stream UI + message upsert.
2. Stop / force while streaming; assert run-control L2/L3.
3. Optional tool turn + restart hydrate.
4. E0-5 dual-unit MCP when shell split path is ready for hand-test.
5. Keep ledger E0 **partial** until full journey + any remaining full-desktop gate close.
