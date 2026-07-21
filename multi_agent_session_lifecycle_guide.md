# 会话生命周期重构 — Pending Draft 多 Agent 执行指南

**文档版本**: v1.0  
**ADR**: `docs/architecture/session-pending-draft-adr.md`  
**项目根**: `c:\Software\conex`  
**前端**: `apps/crish-desktop/src`

---

## 硬接口（每轮遵守）

1. `sessions[]` 只含可持久化会话
2. 用户「新对话」只允许 `enterDraftMode`，禁止直接 `createSession`
3. `createSession`：mint / explicitId / activate:false — **禁止** empty-shell reuse
4. 需真实 sid → 只调 `commitDraftIfNeeded`
5. folder 绑定点 = commit 时的 `draftFolder`

---

## Round 0 调用面盘点（已完成）

| 调用点                                                               | 意图                | 处置                                                                                      |
| -------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `Sidebar.handleNewSession`                                           | 用户新对话          | → `enterDraftMode`                                                                        |
| `ChatCard.handleCreateSessionFromEmpty`                              | 空态 CTA            | → `enterDraftMode`                                                                        |
| `App.tsx` / `useAppKeyboard` 快捷键                                  | 用户新对话          | → `enterDraftMode`                                                                        |
| `SidebarSessionList` 项目/常规下新建                                 | 用户新对话 + folder | → `enterDraftMode(folder)`                                                                |
| `WorkspaceChromeBars`                                                | 用户新对话          | → `enterDraftMode`                                                                        |
| `useChatStream` 发送/缺 sid                                          | 提交                | → `commitDraftIfNeeded`                                                                   |
| `ScheduledTasksPanel` / `SettingsScheduleTab`                        | 系统占位            | **保留** `createSession({ activate:false })`                                              |
| `storeAccess` createSession wrapper                                  | 透传                | 保留；调用方分流                                                                          |
| 测试内 `createSession({ id })`                                       | fixture             | 保留 mint                                                                                 |
| `store/actions/session.ts`                                           | 死平行实现          | **删除或停止导出**（真相源仅 `sessionActions.ts`）                                        |
| `layoutHelpers` / `sessionDaemonSync` / `prepareSessionsForUi` prune | 磁盘/合并净化       | Round 7 改为 hydrate 净化策略，过渡期可保留 prune **仅用于合并/hydrate**，create 路径禁用 |

---

## 轮次架构

```
R0 盘点（上表）
R1  draftSession 模块 + store 字段
R2  setActive 豁免 + enterDraftMode + persist/hydrate
R3  createSession 去复用 + 删 prune 调用（create 路径）
R4  全部用户入口 → enterDraftMode
R5  commitDraftIfNeeded + useChatStream
R6  ChatCard/EmptyState UI
R7  测试重写 + shouldList 重写 + 可选 hydrate 清空壳
R8  FINAL
```

---

## 反偷懒

- 每轮输出改动清单 + vitest/tsc
- 禁止跨轮改无关模块
- `rg findReusableEmptyShell` 在 R3 后 create 路径为 0

---

## 执行记录

| Round | 状态 | 备注                                                      |
| ----- | ---- | --------------------------------------------------------- |
| 0     | DONE | 调用面表见上                                              |
| 1–3   | DONE | draftSession + enterDraft/commit + create 无 reuse        |
| 4–6   | DONE | 入口 enterDraftMode + useChatStream commit + ChatCard UI  |
| 7     | DONE | shouldList 空壳 false + 测试改写                          |
| 8     | DONE | tsc 0；session 核心 239 tests pass；全量 desktop 见 FINAL |
