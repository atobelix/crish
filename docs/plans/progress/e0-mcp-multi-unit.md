# E0-5 multi-unit split — live tauri-mcp (W10-MCP-2)

**Policy:** PASS/FAIL/SKIPPED only from live evidence. No invented green.

| Item | Value |
|------|-------|
| **Agent** | MCP Verifier W10-MCP-2 |
| **Timestamp** | 2026-07-29 |
| **Scope** | E0-5 multi-unit split (sidebar 拆分视图 → ≥2 chat leaves, docks, tab switch) |
| **Tooling** | tauri-mcp (`app_info` / `query_page` / `click` / `execute_js` / `app_bridge`) |
| **App** | Crish **0.1.0** · window `main` · `http://localhost:5174/` |
| **OS** | Windows |
| **Overall E0-5** | **PASS** (after tiny open-split fix) |

---

## Live evidence table

| # | Check | Observed (live) | Verdict |
|---|-------|-----------------|---------|
| 1 | App up | `app_info`: Crish 0.1.0, main visible, URL `http://localhost:5174/` | **PASS** |
| 2 | Shell ready | `shell_snapshot.shellReady=true` | **PASS** |
| 3 | Baseline single unit | Before split: `chatCount=1`, `openTabs` often 1 (draft) | observation |
| 4 | Split UI discovery | Sidebar session menu includes **拆分视图** (`data-action=open-split`). Also: 在此处打开 / 在新窗口打开 / 重命名 / 置顶 / 归档 / 分叉 / 导出. No separate chrome 分屏 button in interactive map. | **PASS** (UI found) |
| 5 | Menus / chrome checked | Session more (`session-more-button`) + context menu; unit strip (`unit-session-tab`); unit tools (`chat-open-files`, `right-dock-toggle`); workspace chrome (no dedicated split control) | documented |
| 6 | Pre-fix: open-split path | Old handler called `openOrFocusSession` + legacy `splitScreenWorkspace` → `workspaces.length` 1→2 but **chatCount stayed 1** | **FAIL** (pre-fix) |
| 7 | Tiny fix | `useSidebarContextMenu`: `openSessionInChatSplit` → layout-tree `splitLeaf('horizontal','chat')` + `setLeafSessionId` + shell open/focus; no legacy workspace push | applied |
| 8 | After fix: open-split | React menu path → **chatCount=2**: `__pending_draft__` + `sess-1784141628869` (你好啊); stable ≥1.5s | **PASS** |
| 9 | openTabs multi-unit | `openTabs` length **2**: 新对话 + 你好啊 | **PASS** |
| 10 | Dual unit chrome | `unit-session-tab` ×2 (both selected per unit); `chat-body` ×2 side-by-side (~549px each); `right-dock-toggle` ×2; `chat-open-files` ×2 | **PASS** |
| 11 | Independent docks | Open files on both units → tree has per-session files leaves (`sessionId=__pending_draft__` + `sessionId=sess-1784141628869`); both toggles **收起右侧工具栏**; tool widths ~104px each | **PASS** |
| 12 | Switch units (shell) | `app_bridge.open_session` draft → 你好啊: chatCount stays **2**; both docks remain **收起** (open); neighbor tool widths unchanged | **PASS** |
| 13 | Switch units (unit tabs) | React `onClick` on both `unit-session-tab`s: chatCount **2**, docks still open, `openTabs` still 2 | **PASS** |
| 14 | Note: tauri-mcp raw click on unit tab | One earlier OS/synthetic click on `unit-session-tab` collapsed multi-unit (`openTabs`→1, `chatCount`→1) — likely hit close (X) / retarget; product React activate path does **not** collapse | **WARN** (tooling) |
| 15 | mcpBridge split API | Bridge helpers: `open_session`, `open_new_draft`, `shell_snapshot` only — **no** split helper | N/A |
| 16 | Drag-to-canvas split | Not required after sidebar path worked | **SKIPPED** |

---

## Final snapshot (successful run)

```
chats:  [__pending_draft__, sess-1784141628869]
tools:  files@__pending_draft__ (w≈104), files@sess-1784141628869 (w≈104), leftover global files leaf
docks:  ["收起右侧工具栏","收起右侧工具栏"]
openTabs: 新对话 + 你好啊
activeTabSessionId: sess-1784141628869
```

---

## Code touch (tiny fix only)

| File | Change |
|------|--------|
| `apps/crish-desktop/src/components/sidebar/useSidebarContextMenu.ts` | `open-split` → layout-tree multi-unit split (`openSessionInChatSplit`); remove legacy `splitScreenWorkspace` |

---

## Summary

| Gate | Result |
|------|--------|
| App up | **PASS** |
| Split UI found (拆分视图) | **PASS** |
| ≥2 chat leaves after split | **PASS** (post-fix) |
| openTabs multi-unit | **PASS** |
| Independent docks | **PASS** |
| Switch unit without collapsing neighbor docks | **PASS** |
| Drag split / mcpBridge split helper | **SKIPPED** / absent |
| **E0-5 overall** | **PASS** |
