# 会话生命周期 Phase 2 — 空壳经济清除与数据层收口

**文档版本**: v1.0
**前置**: Phase 1 已完成（Pending Draft / commitDraftIfNeeded / 用户入口）
**ADR**: `docs/architecture/session-pending-draft-adr.md`
**项目根**: `c:\Software\conex`

---

## 1. Phase 1 已完成（禁止回退）

| 能力                                                                  | 状态 |
| --------------------------------------------------------------------- | ---- |
| `PENDING_DRAFT_SESSION_ID` + `enterDraftMode` / `commitDraftIfNeeded` | DONE |
| 用户新对话入口不 mint                                                 | DONE |
| `createSession` 无 empty-shell reuse                                  | DONE |
| `shouldListSessionInSidebar` 空壳 false                               | DONE |
| 草稿不落盘                                                            | DONE |

---

## 2. Phase 2 剩余问题（本指南目标）

| ID    | 问题                                                                                    | 处置                                                                                        |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| P2-01 | `store/actions/session.ts` 仍是带 reuse/prune 的死平行实现                              | **删除**文件或整文件改 re-export 禁止双真相                                                 |
| P2-02 | `findReusableEmptyShell` 仍在 sessionTitle / sessionIndex / 测试 / workflow 注释        | **删除**生产 API；测试改为 draft 或 prune 契约                                              |
| P2-03 | hydrate `prepareSessionsForUi` 仍 prune keep=active，可保留但语义改为「清磁盘历史空壳」 | **强化**：hydrate 时剪掉所有非 keep 空壳；keep 仅真实非空/置顶/定时/当前 active（非 draft） |
| P2-04 | `ChatEmptyState.shellWillReuse` 死 prop                                                 | **删除**                                                                                    |
| P2-05 | `sessionActions` delete/archive/branch 仍 `pruneEmptyShellsInPlace`                     | **保留**为 GC（合法）；注释标明非 reuse                                                     |
| P2-06 | draft 生命周期单元测试覆盖不全                                                          | **补** commit/folder/连点 契约测试                                                          |
| P2-07 | 无自动化冒烟描述可挂 CI                                                                 | **加** vitest 场景级契约（非 Playwright）                                                   |
| P2-08 | 测试套件插件仍是路线图                                                                  | **不本轮实现**；仅保持 `docs/testing/integrated-test-suite-plugin-roadmap.md`               |

---

## 3. 硬接口（延续 Phase 1）

1. `sessions[]` 只含可展示或系统占位（定时非默认标题）会话；默认空壳应被 hydrate 清除
2. 用户新对话只 `enterDraftMode`
3. `createSession` 禁止 reuse
4. 需真实 sid → `commitDraftIfNeeded`
5. **禁止**再引入 findReusableEmptyShell

---

## 4. 多轮架构

```
Phase2 Round A  死代码清除（actions/session + findReusable + EmptyState prop）
Phase2 Round B  hydrate/prepareSessionsForUi 语义收口 + 注释
Phase2 Round C  draft 契约测试加固
Phase2 Round D  FINAL：tsc + vitest + rg 反偷懒 + commit
```

### Round A — 死代码清除（可并行 A1 / A2）

#### Agent A1 — 删除 `store/actions/session.ts` 双实现

**核查**：`createSessionCrudActions` 无 layoutStore 引用 → 删除整个 `session.ts` 或改为：

```ts
/** @deprecated 真相源在 sessionActions.ts；勿再实现第二套 CRUD */
export {};
```

若 `actions/index` 导出了它，一并改。

**禁止**删 `sessionActions.ts`。

#### Agent A2 — 删除 findReusableEmptyShell 生产面

1. 删 `sessionTitle.findReusableEmptyShell` 及类型
2. 删 `sessionIndex` 中委托 wrapper（`findReusableEmptySession` 等）
3. 更新/删除依赖测试：`sessionTitle.test`、`sessionIndex.test`、`workflowApi.schedule.test`
4. `workflowApi.ts` 注释去掉 reuse 措辞
5. `ChatEmptyState`：删除 `shellWillReuse` prop 与 willReuse 展示逻辑

**保留** `pruneEmptyShellSessions` / `shellPruneKeepIds`（hydrate + GC）。

### Round B — Hydrate 净化

**文件**: `sessionTitle.prepareSessionsForUi`、`sessionPersistence.hydrateSessionsFromDisk`、必要时 `layoutHelpers`

语义：

```ts
// keepIds 默认：active（若非 draft）+ 所有非 isEmptyShellSession
// 或更强：keepIds = non-empty shells only；active empty 若仍是真实 id 可 keep 一条
// Phase2 策略（推荐）：
//   prune 掉 isEmptyShellSession 且 id !== activeSessionId（且 active 非 draft）
//   若 active 本身是空壳（历史路径）：仍 keep 该 active，避免当前焦点消失
//   草稿哨兵永不进 sessions，无需 keep
```

`sessionDaemonSync` 的 `pruneEmptyShells: true` 路径保持，作为合并 GC。

### Round C — 测试加固

新增/扩展 `sessionActions.test.ts` 或 `draftSession.test.ts`：

| 用例                     | 期望                                     |
| ------------------------ | ---------------------------------------- |
| enterDraftMode           | sessions 长度不变；active=pending        |
| 连点 enterDraft 3 次     | sessions 仍不变                          |
| commitDraftIfNeeded      | sessions+1；active 真 id；draftFolder 清 |
| commit 带 folder         | sess.folder === draftFolder              |
| setActive 真会话         | draftFolder 清                           |
| shouldList 空壳          | false                                    |
| hydrate 后无多余默认空壳 | prepareSessionsForUi 结果                |

### Round D — FINAL

```powershell
npx tsc --noEmit -p apps/crish-desktop
npx vitest run apps/crish-desktop
rg "findReusableEmptyShell" apps/crish-desktop/src  # 期望 0（或仅注释/changelog）
rg "createSessionCrudActions" apps/crish-desktop/src  # 期望 0
```

Commit：`refactor(session): phase2 purge shell economy and dead session CRUD`

---

## 5. 非目标（本 Phase 不做）

- Playwright/Tauri E2E 全套
- `activeSessionId` 改 null
- 自建 crish-testkit 实现
- 删除 pruneEmptyShellSessions 全文（仍需 GC）

---

## 6. 执行记录

| Round | 状态 | 备注                                                           |
| ----- | ---- | -------------------------------------------------------------- |
| A     | DONE | 删 actions/session.ts + findReusable* + EmptyState shell props |
| B     | DONE | prepareSessionsForUi pending 不 keep 空壳；GC 注释             |
| C     | DONE | draft 契约测试 + demo commit folder 小修                       |
| D     | DONE | 见 commit                                                      |
