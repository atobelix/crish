# 执行发现登记（Execution Findings）

> 依据：`00-EXECUTION-CODE-OF-CONDUCT.md` §4.4——发现任务书未覆盖的真实问题，编号 + 位置 + 描述 + 建议，登记本文件，不上报不擅自修。

## F-001：sessionPersistence 单测被并行任务 PS-03 未提交改动破坏（PS-02 执行期）

- **发现日期**：2026-08-07（PS-02 执行期）
- **位置**：`apps/crish-desktop/src/api/sessionPersistence.test.ts`（"persistAllSessions with empty list clears index and does not invent sessions"）
- **描述**：PS-02 T2.1/T2.2 验收本地全量 `npm run test` 与快层 `npm run test:coverage -- --project=unit` 时，该用例失败（`expected [ { id: 'm', sender: 'user', …(2) } ] to deeply equal []`，`persistAllSessions([], '', [])` 后 `loadSessionBody('old')` 未清空）。经 `git stash push`（仅 4 个 session-persistence 文件）验证：HEAD 基线该文件 37/37 全绿；失败由**并行任务 PS-03 前端持久化文件族**（串行链 T3.2→T5.1→T5.3→T3.6）的未提交改动引入（`sessionRustDb.ts`/`migrateFromLocalStorage.ts` 工作区修改），非 PS-02 改动所致。
- **处置**：PS-02 不越界修改该文件族（B9 范围纪律 + 00-REMEDIATION-DECISIONS.md 串行链归属）；该失败登记为 PS-03 收尾时的回归项。
- **建议**：PS-03 前端持久化族收尾时，将 `sessionPersistence.test.ts` 全量纳入回归；其提交应保证快层 `npm run test:coverage -- --project=unit` 恢复 EXIT=0。

## F-002：vitest 无 `--list` CLI 选项（PS-02 T2.1 验收方式调整）

- **位置**：`node_modules/vitest`（3.2.7）
- **描述**：任务书 T2.7 验收标准 ② 使用 `npx playwright test tests/e2e --list`（Playwright 支持）；vitest 侧"收集清单"没有 `--list` 选项（实测 `Unknown option --list`，CACError），vitest 收集面以 `--reporter=verbose` 输出 grep 验证（0 个 tests/e2e 文件，唯一例外 tauri-native-smoke 归属 native-smoke 项目）。
- **建议**：验收口径以 verbose reporter grep 为准，已在 PS-02 报告注明。

## F-003：apps/crish-desktop/tests/recovery/store-boundary.test.ts 既存引用缺陷（PS-02 T2.1 修复）

- **位置**：`apps/crish-desktop/tests/recovery/store-boundary.test.ts:14`
- **描述**：`useSessionStore.setState(_s => ({ sessions: [...s.sessions, …`——形参 `_s` 但引用 `s`，`ReferenceError: s is not defined`。git blame 确认 d82f7468 创建文件时即存在（"handles creating 1000 sessions" 用例从未通过）。根因：测试代码笔误（真实缺陷形态），非 PS-02 引入。已按 T2.1"扩前先确认四目录用例全绿"要求修复为 `_s.sessions`（最小改动，属测试代码修复，任务书允许）。
- **建议**：无后续动作（已修复并随 T2.1 提交）。
