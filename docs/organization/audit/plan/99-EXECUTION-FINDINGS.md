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

## P2 长尾收敛清单（knip warn 级，PS-02 T2.6 登记，不阻塞门禁）

| 项                | 量  | 位置                                                                                                                                                                                                                                                       | 收敛建议                                                                          |
| ----------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Unused exports    | 595 | 全仓（agent-workbench/shared 为主）                                                                                                                                                                                                                        | 按域分批收敛（每域一批，导出即消费或删除）；收敛后把 `rules.exports` 收紧为 error |
| Duplicate exports | 5   | messageWindow.ts（EXPAND_OLDER_STEP/SHOW_ALL_OLDER_THRESHOLD）、tauriInvoke.ts（invokeCmd/tryInvokeTauri）、OverviewQuickActions（OverviewQuickActions/OverviewQuickPrompts）、OverviewStats（OverviewStats/OverviewMetrics）、DevHealthOverlay（default） | 逐文件去重（保留消费方引用的名字）                                                |

## F-004：并行任务 PS-03 期间快层门禁被未提交改动阻塞（PS-02 T2.2/T2.4 验收边界）

- **描述**：`npm run test:coverage -- --project=unit` 与 `npm run test` 在 PS-02 执行期 EXIT=1，唯一失败为 F-001（sessionPersistence 被 PS-03 未提交改动破坏）。经 stash 验证 HEAD 基线全绿；PS-02 改动（vitest 项目重构/coverage 口径）未引入任何失败（5225/5226 通过，唯一失败 = F-001）。
- **建议**：PS-03 前端持久化族落地后重跑快层门禁，恢复 EXIT=0。

## F-005：markdown-editor 保护名单 2 spec 依赖 pre-M3/M4 交互模型（PS-02 T2.7 子集偏差登记）

- **位置**：`tests/e2e/ime-composition.spec.ts`、`tests/e2e/keyboard-navigation.spec.ts`
- **描述**：两 spec 依赖 pre-M3/M4 引擎交互模型：① 空文本时编辑器常驻（`setText('')` 后仍可点击 `.editor-container` 输入）——f772eb99 起 App 空文本卸载编辑器（`textLength > 0` 才渲染 MarkdownEngine，"生成万行超大文档..."占位）；② `window.useEditorStore` 全局——f772eb99 起契约改为 `__CRISH_SESSION_STORE__`（后者已按当前契约修复，前者为引擎设计变更）。实测两 spec 确定性失败（9 失败中的 3 个；另 cursor-debug 1 + editor-fuzz-thrash 5 为既存失败，非保护名单）。D3 要求冒烟子集含 ime-composition，但含已知必红 spec = 复现"知病未医"门禁（T2.2 刚消除的反模式）；PS-02 边界不授权重写用户对抗性测试的交互模型（编辑器域）。
- **处置**：冒烟子集 = ast-block-tables / cache-telemetry / cache-metrics / format-checker / wysiwyg-interaction（3 保护 + 2 缓存锚点，实测全绿），偏差注释登记于 ci-mid.yml e2e job。
- **建议**：编辑器域适配任务（ime/keyboard 重写到 M3/M4 交互模型：非空文本 + HiddenInput textarea 路径）后，两 spec 回归冒烟子集。

## F-006：tests/e2e 12 个 spec 硬编码 5173 端口（PS-02 T2.7 修复）

- **位置**：tests/e2e/*.spec.ts（ast-block-tables / format-checker / ime-composition / keyboard-navigation / wysiwyg-interaction / active-token / bug-repro / console-errors / cursor-debug / cursor-position / debug-style / syntax-render）
- **描述**：12 个 spec `page.goto('http://localhost:5173/')` 硬编码 markdown-editor dev server 端口；主应用已迁移 5174（strictPort）。CI ubuntu 无 5173 服务 → 全部必红；本地因 20:37 启动的 markdown-editor dev server（旧契约 bundle）掩盖问题。修复：playwright.config.ts webServer 数组化，第二项 `npm --prefix reference/markdown-editor run dev`（url 5173，reuseExistingServer 本地复用）；ime/keyboard 的 window 契约已同步当前 main.tsx（`__CRISH_SESSION_STORE__`）。
- **建议**：其余 7 个 5173 spec（非保护名单，含 cursor-debug/editor-fuzz-thrash 等）在编辑器域任务中一并迁移到契约化 URL（baseURL 相对路径）。

## F-004：T3.3 红测试与修复实现被并行 persist 任务整文件暂存吸收（PS-03 T3.3 执行期）

- **发现日期**：2026-08-07（PS-03 T3.3 执行期）
- **位置**：`crates/conex-db/src/sessions.rs` + `crates/conex-db/tests/orphan_grace_contract.rs`
- **描述**：T3.3 执行时并行任务（P0-2/PERSIST-03，persist 批次）正以**未提交**状态占据同一文件族（sessions.rs 已含 run 豁免、orphan_grace_contract.rs 已含 v2 测试）。T3.3 的红测试（5 个用例，追加于文件尾）写好后，并行任务以整文件暂存提交（7e2cde0f）将**实现（run 豁免 + pending 豁免 + hydrated 豁免）与 T3.3 全部测试一并吸收入库**——两段提交（红测试单独一笔）无法按字面执行。红证据改在修复前 HEAD（d4d8853b）临时 worktree 上实跑确认：7 个保护用例全红（含 T3.3 三个主用例），9 个既有宽限期用例全绿。
- **建议**：同文件族任务派发时明确「提交归属」（谁 commit、何时 commit），或强制串行；并行批次的整文件暂存会吞掉相邻任务的未提交测试，验收方应接受「红证据 + 同提交含测试」的替代证据链。

## F-005：T3.3 子项 touch_session 生产接线声明留登记（PS-03 T3.3 执行期）

- **发现日期**：2026-08-07（PS-03 T3.3 执行期）
- **位置**：`crates/conex-db/src/sessions.rs:283-297`（touch_session 现状：仅 tests.rs 使用，生产零调用——R2 §3 结构性缺位）
- **描述**：任务书 T3.3 子项「touch 接线（二阶段可选）」：引擎侧 run 启动/终态落库处（crates/orchestrator run 写入面）与前端活跃会话心跳调用 `touch_session`。实现轮评估：接线面横跨 crates/orchestrator 与前端，超出本任务「只改 conex-db」约束，按任务书条款声明留登记。**必做项（删除条件防护）已落地**：两分支 DELETE 共用 protected 条件（hydrated 豁免 + 非终态 run 豁免 queued/initializing/running/awaiting-approval/completing/cancelling + 未决 pending_inputs 豁免，sessions.rs:235-247），与宽限期 `updated_at < grace_cutoff` AND 协同。
- **建议**：后续批次接线 touch 时，注意与 upsert_session_entry（前端 350ms persist 顺带刷新 updated_at）的语义叠加；接线后 `touch_session` 才承担「运行期活跃」刷新职责。
