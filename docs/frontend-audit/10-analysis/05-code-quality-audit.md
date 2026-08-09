# 前端代码规范与代码质量审计报告
> 审计范围：`apps/crish-desktop/src`（生产 606 文件 / 130,533 行；测试 326 文件）+ `tests/` 19 文件 + 根级门禁（eslint.config.js / .dependency-cruiser.cjs / scripts/check-*.mjs / vitest.config.ts）。
> 审计方式：只读静态分析 + 自动化扫描脚本；全部结论附 `文件:行号` 证据与实测统计。
> 审计日期：2026-08-09。
> 关联文档：`docs/frontend-audit/10-analysis/01-style-consistency-audit.md`（CSS 层）、`02-component-architecture-audit.md`（组件层）、`03-state-management-audit.md`（store 层）、`04-frontend-backend-communication-audit.md`（通信层）、`06-engineering-build-audit.md`（工程化）。

## 0. 结论摘要

- **整体判断：类型安全地基扎实，错误处理存在系统性静默失败面，声明的门禁与落地执行存在偏差。**
- 核心量化证据：
  - 生产代码 `: any` 43 处（其中 38 处集中在 chat-composer 4 个文件豁免区）、`as any` 实代码仅 2 处、`@ts-ignore`/`@ts-nocheck` **0 处**——类型面整体干净；`unknown` 1389 处、`as unknown as` 167 处（IPC 边界窄化模式成熟）。
  - **空 catch 块 306 个**（生产 715 个 catch 中 43% 为空体或仅注释），`.catch(() => {})` 33 处——且**无 TS 侧吞错基线门禁**（`check-swallowed-errors.mjs` 仅覆盖 Rust crates/，见 scripts/check-swallowed-errors.mjs:41-49）。
  - **RL-03 行数门禁声明与执行脱节**：`.agents/AGENTS.md` 声称「>650 行硬性阻断 PR」，但 `scripts/check-line-counts.mjs --all` 实测 **44 违规 + 19 警告（665 文件）**，其中 18 个文件 >650 行（最大 pricingStore.ts 1571 行）；该脚本未接入 package.json 与 CI（见 §7）。
  - 测试质量强：断言 12,651 个（`toBeTruthy` 仅 0.7%）、跳过测试 0、`.only` 0、覆盖率阈值 45/70/65/45 已落地 CI。
- 严重度：**P0 × 0、P1 × 2、P2 × 6、P3 × 7**，见 §8。

---

## 1. 类型安全

### 1.1 `any` 使用面（实测）

| 模式 | 生产代码 | 测试代码 | 说明 |
|---|---|---|---|
| `: any` 注解 | **43 处 / 6 文件** | 14 处 | 38 处集中在 chat-composer 豁免区（见下） |
| `as any` 强制转换 | **2 处实代码** + 4 处注释提及 | ~59 处 | 生产仅 SlashExtension.ts:293、TiptapSlashMenu.tsx:89 |
| `any[]` | **0 处** | 14 处 | 生产零使用 ✓ |
| `@ts-ignore` / `@ts-nocheck` | **0 处** | 0 处 | 全仓零使用 ✓ |
| `@ts-expect-error` | **0 处** | 8 处 | 全部为对抗性测试的故意非法输入（binaryFrame.adversarial.test.ts 6 处、memoryLeak.test.tsx:134、publishToolDiffs.test.ts:130）✓ |
| `eslint-disable` | 37 行 | — | 4 文件级 + 33 行内（见 1.3） |

**生产 `: any` 分布**（rg -o 实测）：
- `components/chat-composer/SlashExtension.ts`：**29 处**——Tiptap `command({ editor, range }: { editor: any; range?: any })` 签名逐行重复（SlashExtension.ts:27/41/55/69/83/97/111/125...），Tiptap 插件 API 互操作逃逸。
- `components/chat-composer/TiptapEditorField.tsx`：6 处；`components/chat-composer/composerTypes.ts`：5 处。
- `store/workspace-shell/openTool.ts:1`、`store/layout-helpers/store-types.ts:1`、`store/layout-helpers/layout-core-actions.ts:1`——各 1 处散点。

**生产 `as any` 实代码 2 处**：`SlashExtension.ts:293` `(component?.ref as any)?.onKeyDown(props) ?? false`（Tiptap 组件 ref 逃逸）；`TiptapSlashMenu.tsx:89` `props.editor as any`。

**结论**：`any` 不是全局性问题，而是**chat-composer 一个域内的结构性豁免**（4 个文件文件级 `/* eslint-disable @typescript-eslint/no-explicit-any */`，见 composerTypes.ts:1、SlashExtension.ts:1、TiptapEditorField.tsx:1、markdownSerializer.ts:1）。这是与 `check-no-as-any-store.mjs` 门禁（store/layout-helpers/workspace-shell/hooks 生产文件零容忍，scripts/check-no-as-any-store.mjs:48-61）**刻意划分的豁免区**：store 层零 any 是硬门禁，chat-composer 因 Tiptap API 类型残缺整体豁免。豁免有注释声明但**无边界说明**（如"仅限 Tiptap 插件 API 对接层，禁止业务逻辑使用"），存在扩散风险。

### 1.2 unknown / 双转窄化 / 非空断言

- `unknown` 全仓 **1389 处**——错误处理、IPC 解析广泛使用，成熟度高。
- `as unknown as` **167 处 = 生产 33 + 测试 134**。生产集中在 IPC 边界解析层：`api/chat-bridge/handlers/eventParser.ts` 10 处（如 eventParser.ts:285 `(r.output as unknown as ToolBatchResult['output'])`）、dispatch.ts 3 处、messageHandlers.ts 1 处。**这是"JSON 不可信载荷 → 结构化类型"的标准窄化模式，属正当使用**。
- **非空断言 `!` 约 290 处**（生产）：大量为 `lines[i]!`、`m![1]!`、`bytes[2]!`（applyFileDiff.ts:145、binaryFrame.ts:178、goalModeController.ts:118、IncrementalMarkdownParser.ts:114 等）。根因是 `tsconfig.base.json:18` 开启 `noUncheckedIndexedAccess: true` 后数组/正则组访问返回 `T | undefined`，代码用 `!` 表达"越界由前置判断保证"。**使用正确但无统一约定**（部分配合防御判断、部分裸用），属于可接受的工程权衡，未发现 panic 风险聚集点。

### 1.3 eslint 定制与豁免（均有注释背书）

37 行 `eslint-disable` 全部带理由注释：exhaustive-deps 20 行（如 ApprovalAskCard.tsx:312 注明"字段级依赖有意为之"）、no-control-regex 11 行（C0 剥离，均有中文说明）、no-explicit-any 文件级 4 行、no-unused-vars 测试 1 行、others 1 行。**无一例无理由豁免**，纪律性良好。

### 1.4 zod 使用比例

- 实际 import zod：**仅 2 文件**（`services/ConfigService.ts:1`、`services/config-schema.ts:1`）。
- 其余 8 处提及 zod 的文件（parseResult.ts、eventParser.ts、engineEventSchema.ts、eventType.ts、toolUtils.ts、ApprovalHandler.ts、layoutTreeStore.ts、EventRouter.test.ts）均为**手写轻量 schema**，注释明确说明"不引入 zod 依赖时的 safeParse 等价物"（engineEventSchema.ts:2）。
- **策略分化**：配置域用 zod 全量 schema；事件/IPC 域手写轻量校验器。各有利弊（zod 运行时开销 vs 手写漂移），但**无成文决策记录**，新代码可能两边摇摆。

### 1.5 tsconfig 严格度

- 基础：`strict: true` + `noUncheckedIndexedAccess: true` + `exactOptionalPropertyTypes: true`（tsconfig.base.json:8/18/19）——严格基线 ✓。
- **app 层放松两项**：`noUnusedLocals: false`、`exactOptionalPropertyTypes: false`（tsconfig.app.json:27-29，注释 "Relax non-fatal lint strictness for bundler build"）——有声明、有注释，属有意放松。

---

## 2. 错误处理

### 2.1 吞错面（核心发现）

生产代码 catch 语句共 **715 个**（500 个无绑定 `catch {` + 215 个 `catch (e) {`），其中**空体（含仅注释）306 个**：无绑定 289 + 有绑定 17。

- **空 catch 高发文件**（前 10）：`TerminalCard.xterm.tsx` 15、`api/session-persistence/sessionRustDb.ts` 13、`api/session-persistence/sessionLocalStorage.ts` 9、`hooks/chat-stream/useStreamCallbacks.ts` 9、`api/provider-profiles/profileStore.ts` 8、`api/fontStore.ts` 7、`api/previewBrowserStore.ts` 7、`api/themeStore.ts` 7、`api/chat-bridge/ConnectionLifecycle.ts` 6、`services/CrossTabCoordinator.ts` 6。
- **形态分类**：
  - localStorage/存储尽力写（半正当，但零日志）：agentProfiles.ts:76、beforeunloadFlush.ts:60/75、commandPermissions.ts:165、composerSeed.ts:14、engineConfig.ts:570、appMode.ts:31/47/62。
  - JSON.parse 兜底：workspaceShellStore.ts:592 `catch { return {}; }`、io-worker.ts:19。
  - 有注释说明的（可接受）：workspaceShellStore.ts:642 `/* 反向投影失败不阻塞 tree 渲染 */`、helpers.ts:50/73（Worker 失败走同步兜底）。
  - **无注释无日志的纯空块**（问题面）：覆盖 ~110 个生产文件，无法区分"有意忽略"与"忘记处理"。
- **Promise 链静默**：`.catch(() => {})` **33 处**（bootstrap-full.ts:8、bootstrap-services.ts:81/116、useChatApprovalHandlers.ts 4 处、workspaceShellStore.ts 3 处、FilesCard.tsx:83、FileActions.tsx:52-54、FileViewerCard.tsx:113/276、sessionRustDb.ts:1160 等）+ `.catch((e) => {})` 变体 10 处。
- **与门禁对照**：`scripts/check-swallowed-errors.mjs` 只扫 `crates/`（Rust `let _ =` / `Ok(_) =>` 模式，check-swallowed-errors.mjs:41-49），**前端无对应吞错基线门禁**——306 空 catch + 33 空 catch 链在门禁雷达外，与 Rust 侧的零容忍纪律不对称。

### 2.2 错误日志与脱敏（K-05）

- `LoggerService`（services/LoggerService.ts）实现完整 K-05 脱敏：`redactSecrets(msg)` + `redactDeep(meta)` 全局钩子（LoggerService.ts:100-105、58-62），环形缓冲 200 条，dev 彩色输出/生产 JSON 行（LoggerService.ts:114-136）。**脱敏实现达标**。
- 但 LoggerService 仅被 **12 个文件**引用——306 个空 catch 中绝大多数不经过任何日志面。吞错与"无日志"叠加，线上排障盲区真实存在。
- `ErrorStore`（services/ErrorStore.ts:74-119）提供错误分级/去重（classifyError）能力，未被空 catch 面采用。

### 2.3 console 残留

- `console.log` 生产实代码 **4 处**：performanceEngine.ts:68、migrateFromLocalStorage.ts:169（**两处无 dev 守卫**）、withLogger.ts:108-109（store dev 中间件，有守卫）、LoggerService.ts:135（日志后端自身，正当）。
- `console.debug` 生产 6 处：bootstrap-*.ts 性能标记 3 处、main.tsx:121、messageUserProjection.ts:693、LoggerService.ts:121（后端）。无 warn/error 滥用，console 纪律整体良好。

---

## 3. 命名与结构

### 3.1 文件名风格（components 层实测）

- **PascalCase 250 个**（组件文件 `AgentCard.tsx` 等）+ **camelCase 89 个**（`use*` hooks + `*Utils/*Lib/*Types/types/helpers/index` 惯例：agentCardUtils.ts、topBarDragLib.ts、composerTypes.ts、settingsTabsMeta.ts 等）+ kebab 1 个。
- 形成事实惯例：**组件 PascalCase、hooks/utils/类型 camelCase**。该惯例**无成文声明**，但代码自洽度高，偏差极少（1 个 kebab 文件）。

### 3.2 目录命名（混用三轨）

- 一级目录 32 个 lower（api/store/utils/services/constants...）、27 个 kebab（chat-composer、chat-message-list、workspace-shell、layout-helpers、settings-mcp...）、7 个 Pascal（`components/Tooltip` + `components/ui/{Button,Dialog,Input,Menu,Select,Tooltip}`）、4 个 snake（`__tests__`/`__fixtures__`，惯例保留）。
- **不一致点**：`components/ui/*` 用 Pascal 目录，其余组件目录用 kebab；`components/Tooltip` 顶层独立于 `components/ui/Tooltip`。kebab 与 lower 之间（如 `api/import` vs `api/store-access`）也无统一单复数规则。属可容忍但应声明的差异。

### 3.3 重复组件（缺陷）

- **Tooltip 双版本并存**：`components/Tooltip/Tooltip.tsx`（135 行，**仅 1 处 import**）vs `components/ui/Tooltip/Tooltip.tsx`（267 行，其余全部消费方）。旧版应为死代码（01 样式审计已发现 `--tooltip-translate` 双 Tooltip 4 处问题）。两文件均列入 eslint react-refresh 豁免清单（eslint.config.js:174/190）。

### 3.4 导出方式与 barrel

- **default export 仅 1 处**（App.tsx:333）——named-only 一致性极佳 ✓。
- barrel index 11 个：store/（门禁强制 re-export 三门面，check-no-as-any-store.mjs:259-264）、api/import、api/transport、hooks/chat-stream、store/{layout-helpers,layout-tree,workspace-shell}、workers、components/ui 及其子组件。barrel 使用克制且集中在分层边界 ✓。

---

## 4. 注释规范

- **中文占比 64.5%**（16,104 条注释：中文 10,391 / 英文 5,707），符合"中文注释"仓库约定；英文注释集中在测试命名与少量模块头。
- **TODO 4 处**（2 条实质：layoutAnimationStore.ts:12/40 "无外部引用，可删除"）、**FIXME 0 处**、**HACK 0 处**（3 处匹配为英文注释中 "hack" 一词的说明文字，非标记）。
- **@deprecated 纪律**：eslint 本地规则 `deprecated-requires-reference` 强制 @deprecated 必须带 @see/@removeWhen（eslint.config.js:7-38），hydrateWorkspaceShell.ts:32 等符合 ✓。
- **注释-代码同步性抽查**：SlashExtension.ts 头注声明 "CI Guardrail: Max 400 lines of effective code"，实测有效 396 行——**自洽**；store/README.md 的 7 store 实例/门面表与 check-no-as-any-store.mjs 门禁断言一致；未发现"注释声称但行为不符"的典型反例。主要风险是 §5.5 的 11 处重复剥离逻辑注释各自为政（一处修复另处不跟）。

---

## 5. 代码异味

### 5.1 超长函数（>100 行：22 条命中，去重后 ~18 个唯一）

| 长度 | 位置 |
|---|---|
| 459 | components/settings-skills/useSkillsSettingsState.ts:224-683 |
| 436 | components/settings-extensions/useExtensionMarket.tsx:188-624 |
| 393 | components/chat-card/useChatComposerProps.ts:126-519 |
| 358 | components/settings-models/useModelProfilesState.ts:188-546 |
| 344 | components/settings-mcp/McpServerList.tsx:161-505 |
| 329 | hooks/useAgentStream.ts:125-454 |
| 268 | components/settings-mcp/useMcpSettings.ts:97-365 |
| 260 | components/settings-skills/useSkillsSettingsState.ts:422-682 |
| 230 | components/chat-card/ProjectPickerMenu.tsx:54-284 |
| 229 | components/settings/useRulesState.ts:108-337 |
| 205 | components/workspace/usePreviewNavigation.ts:149-354 |
| 190/186 | components/workspace/workspaceChromeHooks.ts:85-275 |
| 165 | components/settings/SettingsQuickMenu.tsx:99-264 |
| 163 | components/chat-tool-call/ToolCallOutput.tsx:57-220 |
| 151 | components/files/FilesCard.tsx:124-275 |
| 135 | store/layout-helpers/store-persistence.ts:161-296 |
| 130 | hooks/chat-stream/useStreamCallbacks.ts:973-1103 |
| 105 | hooks/useVirtualScroll.ts:69-174 |

特征：**settings-* 系列 hook 是上帝函数重灾区**（useSkillsSettingsState/useExtensionMarket/useModelProfilesState/useMcpSettings 前五占四），均为"设置页加载 + 增删改 + 弹窗 + 权限"耦合的巨型 hook；useChatComposerProps 393 行为会话卡片全能力控制器。

### 5.2 超长文件（原始行数 >500：42 个；>650：18 个）

>650 清单（超过 .agents/AGENTS.md 声称的硬阻断线）：pricingStore.ts **1571**、sessionRustDb.ts 1186、useStreamCallbacks.ts 1098、modelCatalog.ts 1031、store/layout-tree/operations.ts 982、toolCardPresenter.ts 896、ModelConfigEditor.tsx 856、eventParser.ts 845、backgroundTasksApi.ts 795、themeStore.ts 794、clientApi.ts 791、tabDragGeometry.ts 753、goalModeController.ts 750、messageUserProjection.ts 749、ApprovalAskCard.tsx 742、adapterShape.ts 738、ConnectionLifecycle.ts 692、SidebarContextMenus.tsx 686。

### 5.3 深嵌套

- 生产 35 个文件存在 ≥25 空格缩进（约 8+ 层）的代码行，主要为 **JSX 条件渲染树**（App.tsx、CardPanelLayout.tsx、CardPanelHeader.tsx、InlineAgentPanel.tsx、SettingsUsageTab.tsx 等），逻辑层嵌套最深在 sessionCrudActions.ts:204-226、LeafToolTabStrip.tsx:163、FileBreadcrumb.tsx:159。JSX 三元链是主要来源，未见 5+ 层纯逻辑 if 嵌套的坏味道聚集。

### 5.4 魔法数字/字符串

- 启发式扫描 4+ 位裸数字字面量 ~268 处（含合法时间/尺寸常量，需人工甄别）。已确认实例：agentProfiles.ts:76 `slice(0, 24)`（24 条 agent 上限，无命名常量）、PermissionModeMenu 与 ui/Menu/position.ts 注释自曝的 "预估高度 140 的 hack"（position.ts:8）、withLogger.ts 等。数量级不失控，但部分语义数字未提常量。

### 5.5 重复代码块（函数级，最实锤）

**C0/不可见字符剥离逻辑在 11 个文件内联重复**，各带一行 `eslint-disable-next-line no-control-regex`：
applyFileDiff.ts:54、markdownSanitizer.ts:12-13、resolveSlashCommand.ts:115、FontSettingsSection.tsx:32-33、sessionSearch.ts:63-64、sessionTitle.ts:120-125、sessionExport.ts:140-146、previewBrowserStore.ts:59-60、toolFeedback.ts:379、firstRunWizardLib.ts:91-92（另有 parseAnsi.ts:54 ANSI ESC 变体）。
**漂移风险已实证**：sessionSearch.ts:64 与 sessionTitle.ts:121/125 已升级为 `(?![\u200D])[\p{Cf}...` + `no-misleading-character-class` 修复（ZWJ 保护），而 applyFileDiff/FontSettingsSection/sessionExport 等仍是 `[\u0000-\u001f\u007f]` 旧形态——同一逻辑三个版本。应下沉共享 util（如 utils/）。

### 5.6 其他

- `ErrorStore`/`classifyError` 存在但空 catch 面未使用（见 §2.2）。
- 无 `let _ =`（TS 侧无该模式，JS 语义不同）；`void promise` 用法克制（bootstrap-services.ts:116 等合理）。

---

## 6. 测试质量

| 指标 | 实测 | 评价 |
|---|---|---|
| 测试文件数 | **326**（src 内 307 + tests/ 19）vs 生产 606 = **1:1.86** | 高覆盖比例 |
| 断言总数 | **12,651**（toBe 8,166 / toEqual 1,354 / toBeNull·toBeUndefined 812 / toBeTruthy 84 / 其余 2,235） | toBeTruthy 仅 **0.7%**，断言强度强 ✓ |
| 跳过测试 | **0**（describe.skip/it.skip/xit/todo 全仓零） | ✓ |
| .only 残留 | **0** | ✓ |
| 对抗性测试 | @ts-expect-error 8 处全为故意非法输入（binaryFrame.adversarial.test.ts 等）；SizeValidator.adversarial.test.ts、stressFuzzing.test.ts 等 chaos 套件 | 边界攻击意识强 ✓ |
| 覆盖门禁 | 45/70/65/45（vitest.config.ts 根配置，CI 快层 --coverage 强制执行） | 有落地基线 ✓ |
| 测试命名 | 混合中英（"2. 网络抖动与超流限流容错"、"Flow 1: UI Sensitive Approval Flow..."） | 描述性足够 |
| 测试分布 | api/ 117、store 28、components/workspace 9、chat-composer 7 等 | 核心域覆盖均衡 |

唯一弱项：断言以 `toBe` 单值为主（64.6%），快照（.snap 3 个）占比小——对 UI 结构类回归主要靠 toBe 精确值，可接受。

---

## 7. 规范文件与实现偏差

| 声明来源 | 声明 | 实现状态 | 偏差 |
|---|---|---|---|
| .agents/AGENTS.md 规则 1 | 行数门禁：UI ≤500 / 业务 ≤400 / 类型 ≤800，**>650 硬阻断** | `scripts/check-line-counts.mjs` 存在，但**未接入 package.json 任何 check 脚本、未接入 CI**（ci.yml 仅 typecheck/eslint/depcruise） | **严重偏差**：`--all` 实测 44 违规 + 19 警告；18 文件 >650 仍可正常入库。脚本自身也未实现">650 硬阻断"与"85% 预警"两级语义（check-line-counts.mjs:130-155 只有 pass/fail 两态，>limit 即 fail，与声明语义不符） |
| .agents/AGENTS.md 规则 4 | no-multi-comp（单文件多组件拦截）+ 单组件 useState ≤12 | **全仓无任何实现**（scripts/、eslint.config.js 均无） | 纯声明 |
| eslint.config.js | deprecated-requires-reference / Immer 禁 Object.assign / react-refresh 豁免 16 文件 | 全部实现 ✓ | 一致 |
| check-no-as-any-store.mjs | store + storeAccess + layout-helpers + workspace-shell + hooks 生产零 any/@ts-* | 实现，生产实测仅 chat-composer 豁免区外 2 处 `as any`、5 处散点 `: any` | 基本一致（豁免区外零违规）✓ |
| depcruise（.dependency-cruiser.cjs） | no-circular + 分层禁逆依赖（no-*-store-internal 等 13+ 规则） | CI 强制执行 ✓ | 一致 |
| tsconfig.app.json | 注释声明放松 noUnusedLocals/exactOptionalPropertyTypes | 实现 ✓ | 有注释背书，属有意放松 |
| 前端吞错门禁（对标 Rust check-swallowed-errors） | 无 | **不存在** | 306 空 catch 无基线 |

---

## 8. 严重度清单（P0–P3）

### P0：无

未发现安全级或数据完整性级缺陷（类型面、脱敏面、存储面均无即时风险）。

### P1（2 项）

1. **静默失败面无门禁**：306 空 catch + 33 `.catch(() => {})` 零日志零基线，Rust 侧有 check-swallowed-errors 而前端无对应物。处置：建立 TS 版吞错基线脚本（先 `--scan` 统计、登记基线、ratchet），高风险文件（sessionRustDb/useStreamCallbacks/ConnectionLifecycle）先行补 `logger.warn`。
2. **RL-03 行数门禁形同虚设**：声称的硬阻断（>650）与实现（未接线、语义两态）脱节，18 文件超线在库。处置：二选一——把 check-line-counts 接入 `check:desktop` 与 CI 并按声明实现三级语义（warning 85%/violation 100%/hard-block 650 需放宽逻辑）；或将声明降级为"建议基线"并在文档中明示 18 个超线文件的豁免状态。

### P2（6 项）

3. **上帝 hook 聚集**：useSkillsSettingsState 459 行 / useExtensionMarket 436 行 / useChatComposerProps 393 行等 18 个 >100 行函数；settings-* 系 hook 应拆"列表加载 / 变更提交 / 弹窗编排"三职责。
4. **Tooltip 双版本**：components/Tooltip（135 行，仅 1 消费方）与 components/ui/Tooltip（267 行）并存；确认旧版死代码后删除并迁移。
5. **C0 剥离逻辑 11 处内联重复且已漂移**（`\p{Cf}`+ZWJ 修复只落到 2 处）：下沉共享 util，消除 11 个 eslint-disable-next-line 的重复声明。
6. **chat-composer 豁免区无边界纪律**：4 文件文件级禁 any（43 处 `: any` 的 88% 在此），建议在豁免头注释中写明"仅 Tiptap 插件 API 对接层"并禁止业务逻辑沾染。
7. **console.log 生产残留**：performanceEngine.ts:68 与 migrateFromLocalStorage.ts:169 无 dev 守卫（withLogger 2 处有守卫可保留）。
8. **no-multi-comp / useState≤12 声明无实现**：要么实现（eslint 本地规则），要么从 .agents/AGENTS.md 删除，避免"纸面门禁"累积。

### P3（7 项）

9. 目录命名三轨混用（kebab/lower/Pascal）+ 单复数无规则，建议成文（`components/ui/*` 或并入 kebab 体系）。
10. 非空断言 ~290 处无统一约定（部分裸用、部分带防御判断），建议约定"数组索引访问必须附 bounds 判断或注释"。
11. zod 与手写 schema 策略分化无成文决策（2 文件 zod vs 10 文件手写），建议在文档中固化取舍。
12. 魔法数字散点（24 条 agent 上限、140 预估高度 hack 等），低风险、随重构消解。
13. `: any` 残留散点 5 处（openTool/store-types/layout-core-actions），可随手清理。
14. SlashExtension.ts 头部声明 "Max 400 lines" 与 RL-03 语义不一致（RL-03 为 400 上限 + 650 硬阻断），注释建议改为指向 check-line-counts。
15. 测试断言以 toBe 单值为主（64.6%），快照/结构断言占比低——非缺陷，后续可对高变区补充结构断言。

---

## 附录 A：审计方法

- 自动化脚本（临时，未入库）：空 catch 扫描、注释语言统计、函数长度/嵌套扫描、非空断言与魔法数字启发式；数字均已人工抽检确认。
- 门禁实测：`node scripts/check-line-counts.mjs --all`（44/19/665）；`rg` 全量模式统计（any/ts-*/catch/console/TODO 等 20+ 组）；eslint.config.js / .dependency-cruiser.cjs / ci.yml 静态核对。
- 人工抽检：空 catch 高发 6 文件、重复 Tooltip 两版本、C0 剥离 11 处对比、SlashExtension 豁免区、LoggerService K-05 实现。
