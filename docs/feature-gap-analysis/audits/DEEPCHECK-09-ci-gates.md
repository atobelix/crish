# DEEPCHECK-09：CI 门禁与工程健康全局实测（只读 + 实测）

- 子代理：E5（CI 门禁与工程健康检查，只读分析 + 实测）
- 核对窗口：HEAD = 679bde5b（2026-08-09）；**工作区存在大规模未提交重构**（memory-resilience 战役：crates/session-loop、orchestrator、agent-tools、conex-db、conex-compaction 等 30+ 文件改动 + 10+ untracked 新文件），实测结论分「工作区态」与「HEAD 态」标注
- 性质：只读；除 `node scripts/generate-engine-bindings.mjs` 外未修改任何源码（生成后已按 SHA-256 校验与原文件字节一致并保留备份）；仅产出本文档
- 日期：2026-08-09

---

## 〇、结论摘要（TL;DR）

| 层 | Job | 本地实测 | CI 结论 |
|---|---|---|---|
| 快 | typecheck | 14.1s 绿 | ✅ |
| 快 | lint（eslint） | **58 errors / 4 warnings** | 🔴 **必红** |
| 快 | lint（depcruise） | `--ignore "dist/"` 参数不存在（unknown option） | 🔴 **命令本身失效**；改用仓库脚本口径仍有 2 条 no-circular |
| 快 | vitest-fast | 355 文件 / 5342 用例全绿；覆盖率 55.36/77.44/74.04/55.36 > 45/70/65/45 | ✅ |
| 快 | audit | **11 漏洞（4 moderate + 7 high，undici@7.28.0 via jsdom）** | 🔴 **必红** |
| 快 | engine-bindings-drift | 5 个生成文件 SHA-256 与原文件逐一一致 | ✅ |
| 快 | cargo-deny / secret-scan | GH Action，本地未装工具 | ⚠️ 未本地实测 |
| 快 | rust-check | `cargo check --workspace --locked` 绿（1 warning） | ✅ |
| 快 | rust-unit-fast | `cargo test -p conex-types -p session-loop --locked` 绿 | ✅ |
| 中 | rust-test | 3126 passed / 0 failed / 13 ignored；增量 85–112s；4 跑中 1 次 exit 101（输出丢失未归因） | ✅（45min 预算宽裕）；101 需留意 |
| 中 | clippy + baseline | 未实测（耗时长） | ⚠️ |
| 中 | test（vitest 全量） | 368 文件 / 5384 用例全绿，87.3s | ✅ |
| 中 | test:integration（F3） | 12 文件 / 40 用例全绿，2.7s | ✅ |
| 中 | machete | **`notify` 未使用依赖（经 grep 复核为真阳性）** | 🔴 **必红** |
| 中 | e2e（Playwright smoke） | 需浏览器 + markdown-editor dev server | ⚠️ 未本地实测 |
| 中 | knip | 464 warn 项（91 exports + 373 types），error 级 0，exit 0 | ✅ |
| 中 | governance-baselines（3 脚本） | 工作区态 **3/3 红**（unwrap +2、吞错 +3、crate-size 15 文件未登记） | 🔴 工作区态红；HEAD 态未验证（涉未提交重构） |

**一句话**：CI 快层 lint（eslint 58 + depcruise 失效）与 audit（11 漏洞）**必红**，中层 machete 必红；「全量门禁绿」声明不实的核心是 eslint 与 audit 从未被清掉；其余门禁实测全绿。

---

## 一、eslint 58 errors 全量明细

### 1.1 实测方法

- 命令与 CI 完全一致：`npx eslint .`（eslint 9.39.5，flat config `eslint.config.js`），退出码 1
- 汇总：**62 problems = 58 errors + 4 warnings**；其中 **1 error + 1 warning 可 `--fix`**（`prefer-const` 1 个；unused eslint-disable 1 个）
- 注：`apps/agent-workbench/src-tauri` 是 Rust 目录，无 lint 面（显式传入会被 eslint 判为 ignored，不影响 `eslint .` 结果）

### 1.2 规则分布

| 规则 | errors | 可 autofix |
|---|---|---|
| `@typescript-eslint/no-unused-vars` | 55 | 否 |
| `@typescript-eslint/ban-ts-comment`（`@ts-ignore` → 需 `@ts-expect-error`） | 2 | 否 |
| `prefer-const` | 1 | **是** |

warnings 4 个（不阻塞，CI 无 `--max-warnings 0`）：react-refresh/only-export-components 1（AgentTeamBoard.tsx）、react-hooks/exhaustive-deps 1（TiptapEditorField.tsx:300）、no-explicit-any 1（TiptapSlashMenu.tsx:89）、unused eslint-disable 1（plugin-sdk/plugin-fs.ts:113）。

### 1.3 归属分组（缓存域 / 并行域 / 公共 + 测试域）

| 归属 | 文件数 | errors | 代表性文件 |
|---|---|---|---|
| 缓存/持久化域 | 3 | 3 | markdownRender.ts、sessionLocalStorage.ts、sessionPersistenceTypes.ts |
| 并行/子代理域 | 2 | 8 | subagentApi.ts（buildCollaboratorPrompt 死码）1、streamState.ts（7 项未用 import，流式状态机残留）7 |
| 公共前端域（组件/store/api，含 tests/visual） | 26 | 40 | ChatMessageRow.tsx 6、sessionStore.ts 4、store/types.ts 3、storeAccessCore.ts 2、tests/visual/helpers.ts 3 等 |
| 测试/基建域（tests/e2e） | 4 | 6 | mock-engine.ts 2、ast-block-tables.spec.ts 2、debug-style.spec.ts 1、matrix-ime-selection.spec.ts 1 |
| packages 公共库 | 1 | 1 | shared-types/session-workspace.ts（SESSION_PANE_ROLES 仅作类型使用） |
| **合计** | **36** | **58** | — |

### 1.4 36 文件完整明细表

| 文件 | errors | 行号 | 主要符号 | 修复分级 |
|---|---|---|---|---|
| apps/crish-desktop/src/api/chat-bridge/handlers/streamState.ts | 7 | 1–7 | StreamCallbacks、formatRunFailureForUi、recordStreamDiag、assistantBubbleForFailure、classifySoftFailure、logInternalError、softFailureMessage（全部未用 import） | 手删 import |
| apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.tsx | 6 | 37–48 | MessageContent/Props、MessageActions/Props、MessageThinkingBlock/Props（6 个未用 import） | 手删 import |
| apps/crish-desktop/src/store/sessionStore.ts | 4 | 17,24–26 | useMemo、SessionMessage、SessionGoalTask、SessionGoalMode（未用 import） | 手删 import |
| apps/crish-desktop/src/store/types.ts | 3 | 126,129,417 | CronTargetSession、CronJobStatus、SessionMessageInput（未用 import） | 手删 import |
| apps/crish-desktop/tests/visual/helpers.ts | 3 | 17–19 | fullJourneyRunEvents、fenceRunEvents、tableRunEvents（未用常量） | 死代码删除 |
| apps/crish-desktop/src/api/store-access/storeAccessCore.ts | 2 | 43,48 | resolveSettingsUiState、cloneArray（局部死代码，疑似重构残留） | 死代码删除 |
| apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.memo.test.tsx | 2 | 15 | fireEvent、act（未用 import） | 手删 import |
| apps/crish-desktop/src/api/binaryFrame.ts | 1 | 23 | BINARY_FRAME_MAGIC（未用局部常量，同文件另有 BINARY_FRAME_MAGIC_0/1 导出） | 死代码删除 |
| apps/crish-desktop/src/api/codeHighlight.ts | 1 | 169 | highlightCodeAsync（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/api/collectRewindScope.ts | 1 | 14 | SessionMessage（未用 import） | 手删 import |
| apps/crish-desktop/src/api/markdownRender.ts | 1 | 17 | markdownHtmlCacheSize（局部死函数；与 markdownCache.ts:215 同名导出重复实现） | 死代码删除 |
| apps/crish-desktop/src/api/mcpApi.ts | 1 | 12 | eventBus（局部死常量；与 services/EventBus.ts:98 同名导出重复实现） | 死代码删除 |
| apps/crish-desktop/src/api/session-persistence/sessionLocalStorage.ts | 1 | 446 | resetOrphanScanCache（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/api/session-persistence/sessionPersistenceTypes.ts | 1 | 18 | WORKER_BATCH_THRESHOLD（未用常量） | 死代码删除 |
| apps/crish-desktop/src/api/skillsApi.ts | 1 | 573 | readSkillRaw（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/api/streamDiag.ts | 1 | 69 | getLastStreamDiag（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/api/subagentApi.ts | 1 | 59 | buildCollaboratorPrompt（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/api/workspaceChromeTabs.ts | 1 | 88 | isWorkspaceTabActive（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/components/bg-tasks/BgTaskActions.test.tsx | 1 | 212 | sendStub（仅作类型使用） | 手改 |
| apps/crish-desktop/src/components/bg-tasks/bgTaskCardLib.ts | 1 | 211 | bgTaskLogEmptyPlaceholder（局部死常量） | 死代码删除 |
| apps/crish-desktop/src/components/chat-composer/composerTypes.ts | 1 | 11 | React（未用 import） | 手删 import |
| apps/crish-desktop/src/components/chat-message-list/useScrollAnchor.ts | 1 | 15 | scheduleIdle（未用 import） | 手删 import |
| apps/crish-desktop/src/components/settings-skills/useSkillsSettingsState.test.tsx | 1 | 2 | React（未用 import） | 手删 import |
| apps/crish-desktop/src/components/shell/SessionTabDragContext.tsx | 1 | 71 | useIsMultiChatUnit（未用 import） | 手删 import |
| apps/crish-desktop/src/components/sidebar/session-list/sessionListUtils.ts | 1 | 14 | SESSION_PROJECT_LABEL_EXTRA（未用常量） | 死代码删除 |
| apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts | 1 | 26 | HIST_PANEL_ID（局部死常量；与 previewCardLib.ts:21 同名导出重复实现） | 死代码删除 |
| apps/crish-desktop/src/services/ShortcutPlatformAdapt.ts | 1 | 21 | eventToShortcutLabel（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/store/layout-helpers/ui-tool-column.ts | 1 | 40 | isToolColumnCollapsed（局部死函数） | 死代码删除 |
| apps/crish-desktop/src/store/layout-tree/treePanelAccess.ts | 1 | 21 | useLayoutTreeStore（未用 import；layoutTreeStore.ts:238 另有同名导出） | 手删 import |
| apps/crish-desktop/src/store/messageSnapshotsBridge.ts | 1 | 31 | `_ops` 永不重赋值（prefer-const） | **autofix（唯一可 `--fix`）** |
| apps/crish-desktop/src/store/workspace-shell/layoutRestorePolicy.ts | 1 | 18 | listToolLeaves（局部死函数；与 conversationUnit.ts:40 同名导出重复实现） | 死代码删除 |
| tests/e2e/ast-block-tables.spec.ts | 2 | 12,33 | `@ts-ignore` ×2（保护名单 spec） | 手改（`@ts-expect-error`，安全） |
| tests/e2e/mock-engine.ts | 2 | 449,845 | emitEngineEvent、cacheStatsUpdatedEvent（未用函数） | 死代码删除 |
| tests/e2e/debug-style.spec.ts | 1 | 1 | expect（未用 import） | 手删 import |
| tests/e2e/matrix-ime-selection.spec.ts | 1 | 39 | textLenAfter（赋值后未用） | 死代码删除 |
| packages/shared-types/src/session-workspace.ts | 1 | 17 | SESSION_PANE_ROLES（导出但仅作类型使用） | 手改（加 `export type` 或用 `import type` 消歧） |

### 1.5 修复难度分级统计

| 分级 | 数量 | 说明 |
|---|---|---|
| autofix（`eslint --fix` 直接修） | 1 | messageSnapshotsBridge.ts:31 prefer-const |
| 手改（删未用 import 29 / `@ts-ignore`→`@ts-expect-error` 2 / 类型导出修正 1 / 测试桩 1） | 33 | 无风险、机械操作，一处一个动作 |
| 死代码删除（未用局部函数/常量） | 24 | 生产局部死码 14 + 测试域死码 6（helpers 3 / mock-engine 2 / matrix-ime 1）+ **4 个跨文件同名重复实现残留**（markdownHtmlCacheSize / eventBus / HIST_PANEL_ID / listToolLeaves，疑重构遗留，删除前建议先核对 git log 引用历史） |

> 与 DEEPCHECK-03 口径一致：22 errors 起、58 errors 现状，+36 的增量主体是 knip 收敛批次删除导出后遗留的 import/局部符号残留。

---

## 二、CI 配置与实际一致性（ci.yml / ci-mid.yml / ci-slow.yml）

### 2.1 三层结构

- **快层 ci.yml**（push/PR，paths-ignore docs/*.md/assets；9 jobs）：typecheck / lint（eslint + depcruise）/ vitest-fast（unit + coverage）/ audit / engine-bindings-drift / cargo-deny / secret-scan / rust-check / rust-unit-fast
- **中层 ci-mid.yml**（PR + main push；8 jobs）：rust-test（cargo test 全量）/ clippy（--all-targets + baseline ratchet）/ test（vitest 全量 3 项目）/ test:integration（F3 四目录）/ machete / e2e（Playwright smoke 子集 5 spec）/ knip / governance-baselines（unwrap + swallowed + crate-size）
- **慢层 ci-slow.yml**（nightly + dispatch + v* tag；3 jobs）：rust-stress（release + --ignored）/ stress-ts / e2e 全量 + cargo bench
- 覆盖阈值：vitest.config.ts 根 coverage 块 **45/70/65/45**，实测 55.36/77.44/74.04/55.36 —— **阈值低于基线 8~10 个点，安全余量真实存在**，与 ci.yml 注释声明一致。

### 2.2 CI 红绿模拟结论（当前代码态）

**必红的 job（4 个，其中快层 3 + 中层 1）：**

1. **lint（eslint）**：`npx eslint .` 实测 58 errors → exit 1（§一）。
2. **lint（depcruise）**：ci.yml:59 用 `--ignore "dist/"`，但 dependency-cruiser 16.10.4 CLI 无 `--ignore` 选项（`--help` 仅 `-x/--exclude` 与 `--ignore-known`）→ **未知参数即失败，此步从未可能通过**；即使用仓库脚本口径（`lint:depcruise` 无 `--ignore`），实测仍有 2 条 no-circular（InlineAgentPanel ↔ ChatToolCallBlock ↔ CompactToolRow；sessionLocalStorage ↔ sessionRustDb）→ exit 2。
3. **audit**：`npm audit --audit-level=moderate` 实测 **11 漏洞（4 moderate / 7 high）**，全部在 undici@7.28.0（jsdom@29.1.1 → undici，crish-desktop devDep 链）→ exit 1。
4. **machete（中层）**：`cargo machete` 实测 exit 1——`crish-agent-workbench` 声明 `notify = "8"`（Cargo.toml:35）但 src-tauri 源码 grep 复核：`notify` 的全部命中均为 TaskNotifier 方法名（notify_started/notify_failed…）或注释，**无 notify crate 引用 → 真阳性未使用依赖**（HEAD 与工作区一致，Cargo.toml 未改动）。

**工作区态红、HEAD 态未验证（1 个）：**

5. **governance-baselines（中层）**：3 脚本全部 exit 1——
   - `check-unwrap-baseline`：session-loop 生产 unwrap 12（基线 10，+2）
   - `check-swallowed-errors`：orchestrator `let_` +1、session-loop `let_` +2
   - `check-crate-size`：15 个文件超 600 行未登记豁免（含 untracked 新文件 project_tree.rs:967、summary_dispatch.rs:701，及 agent-tools/executor.rs:1304、conex-fs/watch.rs 等）
   - 三者指向的代码面（session-loop/orchestrator/agent-tools/conex-*）**正处于未提交重构态**（git status 30+ 修改 + 10+ untracked），无法判定 HEAD 态；**若该批改动直接入库而未同步刷新基线，中层必红**。

**绿色（9 个，本地实测）：** typecheck / vitest-fast（覆盖率达标）/ engine-bindings-drift（5 生成文件字节一致，`git diff --exit-code` 会绿）/ rust-check / rust-unit-fast / rust-test / test / test:integration / knip（warn 464 不阻塞，exit 0）。

**未本地实测（3 个）：** cargo-deny（Action）、secret-scan（gitleaks Action）、e2e smoke（Playwright + dev server）、clippy（编译时长成本高，且工作区重构态下结果无代表性）。

### 2.3 缓存目录 / 依赖安装问题

- `actions/setup-node@v4` + `cache: npm` 配置正确（npm ci 走 lockfile 缓存，9 个 node job 均有）；未发现缓存目录缺失或依赖安装参数问题。
- 唯一依赖面问题是 **audit 的 undici 链**：jsdom 29.1.1 固定携带 undici 7.28.0（4 moderate + 7 high，含 cookie 注入/CRLF 注入/请求重放类），`npm audit fix` 建议升级但受 jsdom 版本面约束，需评估 jsdom 升级或 audit 例外登记。

---

## 三、knip 实测（`npm run knip`）

- 结果：**464 项 warn（91 unused exports + 373 unused exported types），error 级 0（files/dependencies/devDependencies/unresolved 全过），exit 0** → knip 门禁本身绿。
- 按包分布：

| 归属 | 项数 | 典型内容 |
|---|---|---|
| apps/agent-workbench | 144 | workbench-contract/*（approval/conversation-rewind/disclosure-diagnostics 等类型面） |
| apps/crish-desktop | 167 | chat-card/chat-composer/chat-bridge 类型、markdown-parity-cases、store-access 等 |
| packages/shared-types | 98 | **generated/engine/parser.ts 36 个 parse\* 函数 + events.ts 2 个常量**（生成物面，parser.ts 导出面整段闲置）、session-workspace/subagent.ts 类型 |
| packages/plugin-sdk | 41 | skill-types、plugin 生命周期类型 |
| packages/shared-utils | 9 | bench/seek-sequence/streaming-diff-parser/prometheus-exporter |
| tests/ | 5 | mock-engine.ts、startup/stress runner 类型 |
| **合计** | **464** | — |

- 与 D3「913 项长尾」**不一致（无法复现）**：实测 464 项；913 可能是含 error 级历史口径、或此前未应用 ignore/ignoreFiles 的口径。建议以 464 为准并在登记文档中修正。
- **F-017/018/019 待接项现状（复测，与 DEEPCHECK-03 一致：3/3 仍真未接线）**：
  - F-017 RecoveryCoordinator：crates/orchestrator 定义 + 测试域构造，**生产（apps + session-loop）零调用** → 待接未死
  - F-018 deadlock detector：注入面就绪（core_run_commands.rs:210 `with_deadlock_detector`、:4011 装配），:2935-2939 注释明示信号源（wait 态标记）缺失 → 待接未死
  - F-019 setLogRedactor：logger.ts:30 定义 + index.ts:87 导出，生产零调用 → 待接未死

---

## 四、markdown-editor 门禁实测与 flake 根因

### 4.1 连跑 3 次记录

| 次数 | Test Files | Tests | Duration | EXIT |
|---|---|---|---|---|
| 1 | 25 passed (25) | **126 passed (126)** | 1.77s（transform 1.91s） | 0 |
| 2 | 25 passed (25) | **126 passed (126)** | 1.37s（transform 1.76s） | 0 |
| 3 | 25 passed (25) | **126 passed (126)** | 1.57s（transform 0.96s） | 0 |

命令：`npm test`（= `vitest run tests/unit`，vitest 4.1.10）。**3/3 全绿，A2 所述「首跑 12/20 偶发红」未复现。**

### 4.2 flake 根因判断

**根因已有前序记录（CODEBASE-02-frontend.md:150，A2 首跑同期）**：首次运行 `npm test` 时 **12/20 测试文件失败，全部因 `src/core/EditorStore.ts` transform 报 `[PARSE_ERROR] Expected a semicolon…`（vite:oxc 插件，405:15）**；随后连续 13+ 次全量重跑全绿（含单文件跑、--maxWorkers=1、清 .vite 缓存），无法复现。本次 E5 连跑 3 次亦全绿（3/3，126/126）。

| 候选 | 证据 | 判断 |
|---|---|---|
| **vite:oxc transform 首跑解析竞态（工具链缺陷）** | CODEBASE-02 实测记录：首跑 EditorStore.ts transform `[PARSE_ERROR] Expected a semicolon`（vite 8.2.1 + @vitejs/plugin-react 6.0.5 + oxc 解析器），此后 13+ 次重跑不可复现；与「首跑 12/20 偶发红、后续全绿」的形态完全吻合 | **根因（已实锤）** |
| 测试本身确定性缺陷 | 本套件 3 连跑 126/126 全绿；CODEBASE-02 记录 13+ 连跑全绿；grapheme/undo/parser-redos/chunk 各域无失败记录 | 无证据 |
| 并发负载下 worker 超时（E5 初始假设） | 该目录无 vitest.config（默认 testTimeout 5000 / retry 0），理论存在该风险，但**与 CODEBASE-02 记录的 transform 错误实锤不符，予以排除** | 排除 |

**结论**：flake 根因 = **工具链竞态（vite 8.2.1 的 oxc transform 在冷首跑时对 EditorStore.ts 偶发解析失败），非测试缺陷、非代码缺陷**；复现窗口仅限「冷启动首跑」，热缓存下不可复现（本审计 3/3 绿佐证）。工程处置建议：升级 vite/插件版本验证修复（当前 vite 8.2.1 属较新主版本线），或在门禁脚本首跑失败时自动重跑一次兜底（防御性措施，不掩盖根因）。

---

## 五、pre-commit 钩子一致性（为什么提交能过但 CI 会红）

- **钩子链路**：`.husky/pre-commit` = `npx lint-staged` + `git diff --check`；hooks 已安装（`.husky/_/pre-commit` 存在）。lint-staged 配置双写：`.lintstagedrc.json`（生效，`.{ts,tsx}` → `eslint --fix` + `prettier --write`；另有 `.css` → stylelint）与 package.json `lint-staged` 键（冗余，被 rc 文件优先遮蔽）。
- **差异根因（三点）**：
  1. **范围差**：lint-staged 只对**本次暂存文件**跑 `eslint --fix`；CI `npx eslint .` 全量扫描。58 errors 分布在 36 个文件，绝大多数提交不触碰这些文件 → 提交畅通，CI 必红。
  2. **可修复性差**：58 errors 中仅 1 个（prefer-const）可被 `--fix` 自动修；即使提交恰好碰到 error 文件，57 个不可 autofix 的 error 会直接拦下提交——所以「触碰即拦、不触碰即过」。
  3. **warnings 不阻塞**：4 个 warning（react-refresh/exhaustive-deps/no-explicit-any）在 pre-commit 与 CI 均不阻塞（无 `--max-warnings 0`），不是红因。
- **结论**：pre-commit 只能防「本次改动引入新 error」，不能防「存量 error」；CI 全量 lint 与 pre-commit 是互补而非等价门禁，当前存量 58 errors 使 CI lint 长期处于必红态，**任何「提交通过」都不能被解读为「门禁绿」**。

---

## 六、typecheck 完整性

- 命令 5 段：tsconfig.app / tsconfig.node / agent-workbench / shared-types / shared-utils（`npm run typecheck` 实测 14.1s 绿，exit 0）。
- **未覆盖目录（有 tsconfig.json 但不在 typecheck 脚本内）**：
  - `packages/plugin-import-claude-codex`
  - `packages/plugin-sdk`
  - `packages/test-utils`
- **未覆盖文件**：`apps/crish-desktop/src/**/*.test.ts(x)` 与 `src/__tests__/**`（tsconfig.app.json:25 显式 exclude）；根 `tests/` 目录（integration/fuzz/race/recovery/e2e/stress/startup 全部 TS）**无任何 tsconfig 覆盖**。
- 结论：**测试代码与 3 个 workspace 无类型门禁**——vitest 运行时错误可逃逸 typecheck；测试文件的类型正确性仅靠 IDE。

---

## 七、bundle 体积

- **`scripts/check-bundle-budget.mjs` 不存在**（glob 与 grep 全空，scripts/ 无任何 bundle/size 预算脚本）→ 预算门禁缺失，与 PERF-017「缺少 size-limit / bundle 分析」（docs/archive/redesign/architecture-improvement/00-问题总览.md:108）登记一致。
- 实测 `npm run build`（crish-desktop，tsc -b + vite 7.1.5，20.5s）：**App chunk = 1,164.80 kB / gzip 354.19 kB，超过 vite 默认 chunkSizeWarningLimit 1100 kB，build 输出告警**。
- 次大 chunk：vendor-lucide 553.08 kB（gzip 147.40）、vendor-react 516.33 kB（gzip 162.61）、chat-bridge 439.76 kB（gzip 124.85）、vendor-highlight 109.05 kB（gzip 34.46）。
- 历史参照：docs/rust-rewrite/21-phase-c-migration-log.md 记录 daemon-bridge 分包 325.78 kB / gzip 96.01 kB——当前主包体积高于历史记录值，无预算基线可比对。

---

## 八、测试耗时基线（CI 可行性）

| 套件 | 实测（本机，增量） | 用例规模 | CI timeout | 可行性 |
|---|---|---|---|---|
| `cargo test --workspace` | **85–112s** | 3126 passed / 13 ignored（89 个 test result 块） | 45 min（rust-test） | ✅ 宽裕（冷编译上 Ubuntu 亦在预算内） |
| `npm run test`（vitest 全量） | **87.3s**（vitest 自报 87.26s） | 368 文件 / 5384 用例 | 45 min | ✅ |
| `npm run test:coverage -- --project=unit`（快层） | **90.9s** | 355 文件 / 5342 用例，覆盖率 55.36/77.44/74.04/55.36 | 20 min | ✅ |
| F3（vitest.integration.config.ts） | **2.7s** | 12 文件 / 40 用例 | 45 min | ✅ |
| `npm run typecheck` | **14.1s** | 5 段 tsc | 20 min | ✅ |
| markdown-editor `npm test` | **1.4–1.8s** | 25 文件 / 126 用例 | —（非 CI job，Playwright webServer 前置） | ✅ |

**风险注记**：`cargo test --workspace` 4 连跑中 1 次 exit 101（84.6s 后退出，输出被丢弃未能归因；前后两轮均 3126/0 全绿）。虽非 CI 直接红因（CI 会保留输出可定位），但属**可观察的偶发不稳定信号**，建议 CI 首跑观察，若复现即抓取具体测试定位。

---

## 附：修复优先级建议

1. **eslint 58 → 0**（§一分类：1 autofix + 35 手改 + 22 死码删除，其中 4 个同名重复实现需先核 git 历史）——清掉后 CI lint 至少少一个红。
2. **depcruise CI 命令修正**：`--ignore "dist/"` → `-x "dist/"` 或去掉（仓库脚本 `lint:depcruise` 无此参数）；再处理 2 条 no-circular。
3. **audit 11 漏洞**：评估 jsdom 升级或 undici 例外登记（4 moderate / 7 high 无 bypass 面，但 audit-level=moderate 必红）。
4. **machete**：删除 apps/agent-workbench/src-tauri/Cargo.toml:35 的 `notify` 声明（真阳性，无消费）。
5. **治理基线**：memory-resilience 重构入库前刷新 unwrap/swallowed/crate-size 三基线，避免中层连锁红。
6. **bundle 预算脚本缺失**：补 `check-bundle-budget.mjs`（PERF-017 未闭环），当前 App chunk 1.16 MB / gzip 354 kB 需基线化。
7. **typecheck 覆盖面**：补 plugin-sdk / test-utils / plugin-import-claude-codex 与根 tests/ 的 tsc 段。
