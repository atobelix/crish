# 桌面消息与分散 UI（MSG）

> **给执行 AI 的硬性规则**
> 1. 彻底改进：正确性先于搬目录。不留双来源、双表面、别名导出、只为兼容的 CSS 引用。
> 2. 禁止作弊：不加 `eslint-disable` / `@ts-ignore` / `@ts-expect-error`；不调基线；不删断言；不用 `--no-verify`。
> 3. 测试只在 MSG-P6 跑 `npm run typecheck`、`lint`、`test`。Node 24。改动阶段不跑。
> 4. 每阶段一提交：`refactor(MSG-P<n>): <中文摘要> [BATCH-DESKTOP-MESSAGES]`。
> 5. 只在 `C:\Users\orange\rf-msg` 改。不 stash、不 push、不动主仓库。
> 6. 门控非空即停。不改 `components/ui/**`（归 UI）。设置/扩展不与组件库抢文件。
> 7. 行号是 2026-10-29 快照（HEAD `bf3d60fa3`）。开工按符号 `rg` 重定位。

| 项 | 值 |
|---|---|
| 代号 | MSG |
| 分支 | `refactor/desktop-messages` |
| worktree | `C:\Users\orange\rf-msg` |
| 批次标签 | `[BATCH-DESKTOP-MESSAGES]` |
| 进度 | 同目录 `desktop-messages-ui.progress.md`（写在 worktree，不写主仓库） |
| 基点 | CF 已合入的集成结果。MSG-P1 还要求 MessageContent 上的 CF 删除已经完成 |

## a. 范围与门控

### a.1 纳入
- P0：`components/chat-message/MessageContent.tsx`、`searchExpandBridge.ts`，以及把 `sessionId` 从父组件传下来所必经的列表组件（开工时用 `rg activeSessionId` 列文件，只改传递，不改 store）。
- 工具卡片：`components/chat-tool-call/**`（不含 UI 原语）。
- 审批与侧栏、输入框、卡片的 P1：`agent-card/**`、`sidebar/**`（菜单收敛除外，见 a.2）、`chat-composer/**`、`chat-card/**`、`chat-message-row` 里除 MD 占用外的死组件。
- 后阶段：`components/settings/**`（不含账号/多设备在写文件）、`extensions-surface/**`、`plugins/**`、`settings-extensions/**`、`settings-mcp/**`、`settings-skills/**`。

### a.2 不纳入
- `components/ui/**` 一律不改。菜单最终形态等 UI 方案把原语 API 定下来；本模块不删 `ContextMenu` / `SmartPanel`。
- SS 的 store、流式 hook、取消链。MSG-01 只停止在消息组件里读全局 `activeSessionId`，不改 session store 结构。
- CF 的扩展、槽位、`renderThought` / `renderTools`。本模块不第二次删除。
- MD 占用：`MarkdownBlockItem`、`StreamingMarkdownView`、`ReasoningRow`、`api/markdown/**`、`FoldableProcessSection` 的 `calcAccordionDuration`。
- 账号在写：`AccountAuthCard.tsx`、`SettingsDevicesTab.tsx`、`authStore`、`authApi`、`multiDevice`。
- 中文文案抽取归 I18N。本模块不改 `t()` 签名，不批量删中文字面量。

### a.3 门控
| 阶段 | porcelain 必须为空 |
|---|---|
| MSG-P1 | `components/chat-message`；且 CF 已合入 |
| MSG-P2 | `components/chat-tool-call` |
| MSG-P3 | `components/agent-card` `chat-composer` `chat-card` `chat-message-row/ArtifactCapsuleSyncLine.tsx` |
| MSG-P4 | 本阶段点名的 sidebar 文件。编写时脏：`Sidebar.module.css`、`SidebarFooter.test.tsx`、`UserProfileCard.tsx`。不点名它们就不要改 |
| MSG-P5 | `components/settings` `extensions-surface` `plugins` `settings-extensions` `settings-mcp` `settings-skills`。编写时脏：`AccountAuthCard.tsx`、其 module.css（已删除未提交）、`SettingsDevicesTab.tsx`、`SettingsQuickMenu.tsx`。账号文件除外仍须整目录为空才开工，避免半截样式 |

编写时 `chat-message` 目录 porcelain 为空，但必须先等 CF，否则和 `MessageContent` 冲突。

## b. 核实表

| 编号 | 结论 | 符号 |
|---|---|---|
| MSG-01 | **仍存在，P0** | `MessageContent` 内 `useSessionStore((s) => s.activeSessionId)`，接着 `useSessionRuntimeStatus(sessionId)`。分屏非活动会话会读到活动会话的运行态 |
| MSG-02 | **仍存在，P0** | `handleToggleSection` 调用 `setMessageProcessExpanded(sectionId, …)`；effect 里 `subscribeMessageProcessExpansion(msg.id, …)`。桥的键是第一个参数（`setExpanded(msgId)`）。写入用 sectionId，订阅用消息 id，通知对不上 |
| MSG-03 | 仍存在 | render 期间写 `timelineCacheRef.current`（`buildAssistantTimelineCached` 之后）并递增 `streamPhaseRef`。`streamText.slice(msg.streamTextOffset)` 三处：无条件切、`textCursor > 1` 才切、另一处再切 |
| MSG-04 | 仍存在 | 段回调依赖完整 `streamText`，尾部 token 会重渲染全部 `FoldableProcessSection` |
| MSG-05 | 部分 | 桥不是 0 引用：`MessageContent` 在用，但是错键。`jumpToSearchHit`、`useMessageProcessExpanded`、`expandMessageProcess` 的生产调用只有测试（`searchExpandBridge.test.ts`、`MessageContent.terminalConvergence.test.tsx`）。`:82` `console.error` 仍在。Map 无生产清理入口 |
| MSG-06 | 仍存在 | `MessageContent.tsx` 物理 582 行（UI 上限 500，硬阻断 650）。`displayMsg = msg` 无意义。中文「回复中断」交给 I18N，本阶段只拆文件 |
| TC-01 | 仍存在 | `ModernToolCall` / `ModernJsonToolCall` / `ModernTerminalToolCall` / `ModernApprovalCard` 生产互引，没有业务 import。`useTransientFlag.ts` 只在注释里提到测试名 |
| TC-02 | 仍存在 | `ToolCallDiffPreview.tsx` `import styles from './ModernToolCall.module.css'` |
| TC-03 | 仍存在 | `export const DiffCard = ToolCallDiffPreview`；`ModernTerminalToolCall.tsx` 的 `export const TerminalCard` |
| TC-04 | 部分 | 两套 diff：`ToolCallDiffPreview` 与 `diff/DiffCard`。第三套 `renderTools` 归 CF，不在这里删。本阶段不合并 1,181 行的 `DiffCard.module.css`（和 workspace 交叉），只断掉 Modern 别名和死组件 |
| TC-05 | 仍存在 | `toolExpansionState.ts`、`toolHeaderPresentation.ts`、`toolOutputParser.ts` 在组件目录且超过业务逻辑 400 行上限。下沉，不改行为 |
| SET-01 | 仍存在 | `SettingsScheduleTab`（`SettingsPanel` lazy）与 `ScheduledTasksPanel`（`ChatCard` lazy）都渲染工作流列表。`WorkflowForm` 同时 import 两套 CSS |
| SET-03 | 仍存在 | `WorkflowForm.tsx` 583 行；`:114` 有 `eslint-disable-next-line max-lines-per-function`。修函数拆分后删掉这行禁用，禁止新增禁用 |
| SET-02/04/05/06 | 仍存在 | 类型双份、中文、自造 `t` 签名、`console.warn`。中文与 `t` 类型归 I18N；本模块只去 `console.warn`、去双类型、去禁用注释 |
| SET-07 | 开工再证 | `settingsBrowserLib.ts` 是否纯 re-export、`ExternalSessionImport.module.css` 是否 0 import。0 引用才删 |
| EXT-01..05 | 仍存在为线索 | `ExternalSessionImportModal` 566 行；`useExtensionMarket` 在 tsx。`McpDetailWorkbench` 的 `as any` 要补类型，不 `ts-expect-error`。静态 `import { t }` 归 I18N |
| AG-01 | 仍存在 | `ApprovalAskCard.tsx` 物理 669 行，超过 650 硬阻断。`:157-182` `propX ?? rawMeta.X`，且 `riskMetaProp` 本身被当成 metadata |
| AG-04 | 仍存在 | `rg` `import { ApprovalCountdown }` 0 命中。`useApprovalCountdown` 被卡片使用，**不删 hook**。`InlineAgentThinkingFold` 0 生产引用（MD-P3 若已删则本阶段探针为 0，不重复删） |
| CMP-04 | 部分 | `ComposerNoticeBar` 是指向 `ComposerEmbeddedNotice` 的兼容别名，测试仍 import 旧名。删别名并改测试 import，不删提示条行为 |
| CC-03 | 仍存在 | `ArtifactCapsuleSyncLine` 仅测试引用 |
| X-01/X-02 | 后阶段 | 组件直接调 IPC 与 `getState()`。不在 P0 做。`ToastContext` 的 `as any` 若在 `services/toast`，与 UI 方案的 UI-04 重叠：**MSG 不改 toast 文件**，避免两模块同时改 |
| SB-01 菜单 | 不做实现 | `ContextMenuFlyout` 仍在（物理约 455 非空行量级，文件在 sidebar）。改到统一 Menu 会写 `components/ui` 或依赖其未定 API。本模块只在 UI 合入后另开阶段，且仍不改 `components/ui` 源文件 |

侧栏报告编号 SB-01 与沙箱模块 SB 无关。

## c. 目标架构

一条消息投影：`projectMessageSegments(msg, streamState, sessionId)` 纯函数。`sessionId` 只来自 props（列表从窗格上下文传入）。组件渲染期间不写 ref。

过程段展开键只有 sectionId，存在该消息的 state 里。没有模块级桥。搜索跳转若产品仍要，用 store 里同一套 sectionId；本方案不保留无调用方的 `jumpToSearchHit`。

工具调用只走 `ChatToolCallBlock` → `CompactToolRow`。Modern* 族删除。`ToolCallDiffPreview` 使用自己的 module css。

定时任务一个 `ScheduleWorkbench`，设置页与聊天入口都渲染它。表单一套，不要「内联 + 弹窗」两份草稿类型。

审批字段只从显式 props 来：`expiresAtMs` / `timeoutMs` / `timeoutPolicy`。不从 `riskMeta.metadata` 回退。卡片拆到 650 行以下。

## d. 删除清单

- `searchExpandBridge.ts` 及只覆盖它的测试。保留「展开当前消息过程段」的行为测试，改到新纯函数上，断言不减。
- Modern* 四个 tsx、`ModernToolCall.test.tsx`、在 `ToolCallDiffPreview` 改挂自己的 css 之后的 `ModernToolCall.module.css`。
- `export const DiffCard = ToolCallDiffPreview` 与 Modern 的 `TerminalCard` 别名。
- `ApprovalCountdown.tsx`（组件文件）。不删 `useApprovalCountdown.ts`。
- `InlineAgentThinkingFold.tsx`（若 MD 未删）。
- `ComposerNoticeBar.tsx` 别名文件。测试改为 `ComposerEmbeddedNotice`。
- `ArtifactCapsuleSyncLine.tsx` 若生产 `rg` 仍为 0。
- `chat-composer/useChatApproval.ts` 若仍是 re-export。调用方改直接路径。
- `WorkflowForm` 上的 `eslint-disable-next-line`。靠拆函数满足规则，不靠禁用。
- 0 引用的 `ExternalSessionImport.module.css`、`settingsBrowserLib.ts` 垫片（P5 用 `rg` 复证）。

不删：`components/ui` 任何文件；用户可见中文（交给 I18N 建键）；`DiffCard` 本体。

## e. 分阶段与探针

**MSG-P0** 不改代码。复跑 §b。确认 `MessageContent` 里已没有 `renderThought`（CF 完成）。若仍有，停，不要在本模块删槽位。

**MSG-P1** `sessionId` 改为 props。删除对 `activeSessionId` 的读取。投影收成纯函数，三处 `streamTextOffset` 收成一处。展开键只用 sectionId，删 `searchExpandBridge`。拆 `MessageContent` 到 ≤ 500。探针：

```
rg -n "activeSessionId" apps/crish-desktop/src/components/chat-message/MessageContent.tsx
rg -n "searchExpandBridge|setMessageProcessExpanded" apps/crish-desktop/src -g "!**/*test*"
rg -n "streamText\.slice\(msg\.streamTextOffset\)" apps/crish-desktop/src/components/chat-message
```

预期全 0。父组件传入的 props 名用 `sessionId`，允许命中。

**MSG-P2** 删 Modern*。`ToolCallDiffPreview` 独立 css 后删旧 module。删两个别名导出。解析文件挪到 `api/presentation/`（若目录名冲突，用现有 `api/tool-presentation`，不新建第二套）。探针：`rg -n "ModernToolCall|ModernApprovalCard|export const TerminalCard|export const DiffCard" apps/crish-desktop/src -g "!**/*test*"` → 0。

**MSG-P3** 审批单字段来源；拆 `ApprovalAskCard` 到 ≤ 650 且目标 ≤ 500。删死组件与 `ComposerNoticeBar` 别名。不改 `PinActionWithPicker`（UI-03）。探针：`rg -n "rawMeta\.(expiresAtMs|timeoutMs|timeoutPolicy)" apps/crish-desktop/src/components/agent-card` → 0；`rg -n "ComposerNoticeBar" apps/crish-desktop/src` → 0。

**MSG-P4** 只拆 `Sidebar.tsx` / `SessionRow.tsx` 的状态与行渲染，**不**改 `ContextMenuFlyout` 的实现、不改在写的 `UserProfileCard` / `Sidebar.module.css`。中文前缀匹配 `/^已归档:/` 不在本模块改逻辑（I18N / 结构化 toast 一起做）。若必须碰脏文件，停。

**MSG-P5** 门控整目录为空后：一个 `ScheduleWorkbench`；删第二套表单类型；`WorkflowForm` 拆开并删除 eslint-disable。外部导入合成一个工作台加 hook。`as any` 改成 shared-types 已有字段；缺字段则停，记待决，不在这里改 ST 的生成器，也不要 `as any`。组件里的 IPC 调用挪到该 feature 的 hook，hook 放 `hooks/` 或现有 api 封装之后，**不**新写第二套 invoke。

**MSG-P6** §h。

## f. 禁止捷径

- 不留 `searchExpandBridge` 的空实现或 deprecated 导出。
- 不用 `sessionId = sessionIdProp || activeSessionId`。
- 不把 Modern CSS 改名后继续给两处用。
- 不为压行数去删用户可见按钮或断言。
- 不新增 `eslint-disable`。P5 必须去掉 WorkflowForm 已有的那一条。
- 不修改 `components/ui` 来「顺便」收敛菜单。
- 不改 `t(key, 中文)`。缺键留给 I18N。

## g. 规范

`check:line-counts`：tsx ≤ 500，硬阻断 > 650（`ApprovalAskCard` 现 669，P3 必须降到 650 以下）。业务 ts ≤ 400。基线只降。`npx knip` 无新的未使用导出。ESLint 不放宽 `max-lines-per-function`。

## h. 测试

只在 MSG-P6，worktree，Node 24：

```
npm run typecheck
npm run lint
npm run test
npm run check:line-counts
npx knip
```

回归：R1 非活动窗格的消息不跟随全局 active 的 runtime；R2 过程段折叠按 section 保持；R3 工具卡片仍走 Compact 行，审批按钮在；R4 设置与聊天两处定时任务是同一个工作台；R5 Modern 删除后 diff 预览仍有样式。

## i. 审计

- [ ] A1 探针为 0 的项没有残留
- [ ] A2 diff 不含 `components/ui/**`、不含 store 会话文件、不含 conversation-flow
- [ ] A3 无新的 eslint-disable / ts-ignore / ts-expect-error
- [ ] A4 删除的测试只对应被删接缝；R1–R5 断言还在
- [ ] A5 账号在写文件不在 diff 里

## j. 与 SS/CF/ST 的文件冲突

- CF 改 `MessageContent`、`ChatCard`、`ChatComposerWrapper`、`CompactToolRow`。**MSG-P1 / 任何 ChatCard 编辑排在 CF 合入之后。** 不删 `renderThought`。
- SS 改 `store/session*` 与流式 hook。MSG 只加 props，不改这些文件。若父列表在 SS 的 diff 里尚未合入，MSG-P1 停。
- ST 改生成类型。EXT 的 `as any` 若要新字段，停，不手写第二份 McpServer。
- MD 占用见 a.2。`FoldableProcessSection.tsx` 若只需改时长，归 MD；MSG 拆消息时不要重排该函数。
- UI 独占 `components/ui/**`。侧栏菜单文件留到 UI 原语稳定后的后续提交，本方案 P4 明确不改 `ContextMenuFlyout.tsx`。

## k. 已决

- D1：CF 先删平行渲染。本模块按删除后的 `MessageContent` 做 P0，不把 MD-07 再做一遍。
- MSG-01、MSG-02 编写时仍在，放第一阶段。
- 新 UI 原语不是死代码。菜单双轨不在本模块用删除 `components/ui` 的方式解决。
- I-02 误报与取消链归 SS。X-02 里读 `activeSessionId` 的部分就是 MSG-01，toast 的 `as any` 不在本模块改。
- 中文清零归 I18N。本模块拆开的组件里留下的中文，由 I18N 在 MSG-P5 合入之后抽取。
