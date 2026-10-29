# CF · 删除 conversation-flow

> **给执行 AI 的硬性规则**（完整版见同目录 `README.md`）
> 1. D1 已决：删除。不保留空钩子、空槽位、no-op 导出或 re-export。
> 2. 不改默认主链的视觉与交互。不借机重写 `ReasoningRow`、`ChatToolCallBlock`。测默认主链的断言一条不删。
> 3. 测试只在 CF-P5。提交：`refactor(CF-P<n>): <摘要> [BATCH-CONVERSATION-FLOW-REMOVAL]`。无 BOM。
> 4. worktree `C:\Users\orange\rf-cf`，分支 `refactor/conversation-flow-removal`。不 stash、不 push。lock 文件只用 `npm install --package-lock-only --ignore-scripts` 重生成。不得在 worktree 里写 `node_modules`（它是指向主仓库的 junction）。
> 5. 进度写 `C:\Users\orange\conex-review\plans\conversation-flow删除.progress.md`。
> 6. Node 24。
> 7. 行号是 `bf3d60fa3` 快照。CF-P0 必须重跑探针。若发现生产入口已经接上（激活函数不再恒为 false），停工，记为新待决项。

| 项 | 值 |
|---|---|
| 方案代号 | `CF` |
| 波次 | W4。门控 G-CF 到 W4 末仍不满足则顺延到 W5，排在 Markdown 模块之前 |
| 已决 | **D1 = 删除**扩展、`packages/conversation-flow`、两个零注册方槽位、`renderThought` / `renderTools` 穿透 |

依据：`plans\conversation-flow删除.md`、ROADMAP §9.2 D1。

## a. 范围

生产永不激活。`extensions/conversation-flow/activate.ts` 的 `shouldActivateOfficialConversationFlow()` 返回 `officialOverride ?? false`。唯一 setter `setOfficialConversationFlowActivateForTesting` 只被 `ChatComposerWrapper.composer-above.test.tsx` 调用。`entry-core.tsx` 只在它为 true 时调用 `activateConversationFlow()`。

2026-08-18 引入（`2a7bcf97e`、`3621f063f`），约 10 周未打开。近期提交都在缩它（`c18eeb808`、`bf3d60fa3`）。

| 部分 | 位置 | 事实 |
|---|---|---|
| 扩展 | `apps/crish-desktop/src/extensions/conversation-flow/` | 约 34 个文件 |
| 包 | `packages/conversation-flow/` | 约 13 个文件，唯一消费方是该扩展 |
| 槽位 | `workspace.chat.stream`（`ChatCard.tsx` 的 SlotOutlet）、`workspace.chat.composerAbove`（`ChatComposerWrapper.tsx`） | 唯一注册方是 activate.ts。键在 `workspaceChatStream.slot.ts`、`workspaceChatComposerAbove.slot.ts`，props 在 `chatComposerAboveProps.ts` |
| 主链分支 | `CompactToolRow.tsx`：插件开时 `return null`，藏起 `ApprovalAskCard`。`flowScrubberModel.ts`：`[data-conversation-flow="on"]` | 生产恒走「插件关」 |
| 穿透 | `renderThought` / `renderTools` | 编写时 10 个文件、约 72 处。`settings-mcp/McpServerTools.tsx` 只是同名注释，不动 |
| 常量 | `workers/index.ts` 的 `TOOL_OUTPUT_DOM_CHAR_CAP`、`TOOL_OUTPUT_PIXEL_CAP` | 唯一使用方在 CF |
| 配置 | 根与 desktop 的 package.json、vite alias、package-lock、`check-i18n-unused-keys.mjs`、`inspect-index-contents.cjs`、`token-registry.json`、`test-utils/entryChainSources.ts` 的注释 | 随包删除 |

用户可见功能不丢：审批走 `ApprovalAskCard` / `useChatApprovalState`，thinking 走 `ReasoningRow`，工具调用走 `ChatToolCallBlock`。CF 独有的 PurposeBlock / ArtifactChip / SubagentBlock / PermissionBar 从未到达用户。

可改文件就是上表这些，外加删除后变成未使用的 i18n 键（只删不增），以及基线记录里指向被删文件的条目（只删）。其他文件不改。

## b. 问题清单

- CF-1：激活门恒 false，扩展和包只在测试里运行（g6 MD-07）。
- CF-2：平行渲染栈。thinking 渲染器因此多一套；工具展示多一个入口。
- CF-3：主链为一个从不注册的插件留了 2 个槽位、1 个隐藏分支、1 个 DOM 标记和约 72 处 prop 穿透。
- CF-4：独立 workspace 包参与 typecheck、i18n 扫描、token 扫描、vite alias。

## c. 目标架构

聊天渲染只有一条主链：ChatCard → ChatMessageList → MessageContent → ProcessItemRenderer / ChatToolCallBlock / ReasoningRow。没有可被外部覆盖的 `renderThought` / `renderTools`。

view-registry（slotCore）本身保留，note-paper 等还在用。只删这两个零注册方的槽位键。

`CompactToolRow` 无条件渲染 `ApprovalAskCard`，也就是现在生产里实际生效的分支。`flowScrubberModel` 删掉 `data-conversation-flow` 分支，留下生产生效的路径。

## d. 删除清单

整目录：扩展目录、`packages/conversation-flow/`。

代码：entry-core 的 import 与激活；两个 SlotOutlet 和槽位键；`CompactToolRow` 的插件分支；`flowScrubberModel` 的标记分支；`renderThought` / `renderTools` 全链（`narrativeRenderSlots.ts` 若只服务于此，整文件删除）；workers 里的两个常量。

配置：根 package.json 的 workspace 项与 typecheck 片段；desktop package.json 依赖；vite alias；lock 里的对应条目；三个 scripts 里的条目；entryChainSources 注释。

测试：只删「测 CF 本身」或「测被删接缝」的用例，例如 `ChatMessageList.narrative-slots.test.ts`、composer-above 测试里「插件开」的用例、`ChatCard.stream-slot.test.tsx` 里测槽位的部分。测默认主链的断言不删。每删一条，progress 写理由。

## e. 分阶段步骤

**CF-P0 · 复核，不改代码**
- 门控满足后，在 worktree 重跑 §i 的探针，记录基线命中数。
- 确认 `shouldActivateOfficialConversationFlow` 仍恒为 false。
- 列出 CF 用到的 i18n 键，逐个 `rg` 其他使用方，得到「将变为未使用的键」清单。
- 若生产入口已接上，停工。

**CF-P1 · 删除扩展与激活**
- 删扩展目录、entry-core 激活、entryChainSources 注释。
- 判据：§i 的 CF-1。

**CF-P2 · 删除槽位与主链分支**
- ChatCard、ChatComposerWrapper 的 SlotOutlet 与订阅；槽位键；`CompactToolRow` 保留「插件关」分支；`flowScrubberModel` 保留无标记的路径。
- 判据：CF-2。

**CF-P3 · 删除渲染穿透**
- 从 props 类型到渲染点逐层删除 `renderThought` / `renderTools`。默认渲染直接内联，不留可选覆盖参数。
- 判据：CF-3。

**CF-P4 · 删除包与配置**
- 删 `packages/conversation-flow`。改 package.json、vite alias、scripts、workers 常量、i18n 未使用键。
- lock 只用 `npm install --package-lock-only --ignore-scripts`。
- 判据：CF-4。`git diff --stat <base> -- package-lock.json` 只有删除。

**CF-P5 · 验证**（§h）。

## f. 禁止事项

不留空钩子。不改默认主链视觉。不在主仓库 `node_modules` 上写。不加 eslint-disable / ts-ignore / knip ignore。不放宽 check-i18n、knip、token 门禁。`CompactToolRow` 不得留成「插件开则隐藏审批卡」——那条分支删掉之后，审批卡必须仍然渲染。

## g. 项目规范

TypeScript strict。`npx knip` 不得出现新的未使用导出。i18n 键只删不增。基线记录只删指向已删文件的条目。

## h. 集中测试

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:desktop-helpers
npm run test:e2e:smoke
npx knip
npm run check:i18n
node scripts/check-i18n-unused-keys.mjs --strict
node scripts/check-token-consistency.mjs
npm run check:line-counts
```

回归点写进 progress，每条对应用例和结果：
- R1 待审批工具调用在默认链显示 ApprovalAskCard，批准和拒绝都还能走
- R2 thinking 由 ReasoningRow 渲染，流式增量正常
- R3 工具调用块展开和折叠
- R4 flow scrubber 在长对话里定位正确
- R5 输入框上方没有残留空白

## i. 审计清单

`$B = refactor/conversation-flow-removal`，`$R = C:\Software\conex`。

```powershell
git -C $R ls-tree -d $B apps/crish-desktop/src/extensions/conversation-flow
# 无输出
git -C $R grep -nE "activateConversationFlow|shouldActivateOfficialConversationFlow|setOfficialConversationFlowActivateForTesting" $B -- apps
# 0
git -C $R grep -nE "workspace\.chat\.(stream|composerAbove)|data-conversation-flow" $B -- apps packages
# 0
git -C $R grep -nE "\brenderThought\b|\brenderTools\b|narrativeRenderSlots" $B -- apps/crish-desktop/src ":!apps/crish-desktop/src/components/settings-mcp"
# 0（基线约 72）
git -C $R ls-tree -d $B packages/conversation-flow
# 无输出
git -C $R grep -nE "conversation-flow|ConversationFlow|TOOL_OUTPUT_DOM_CHAR_CAP|TOOL_OUTPUT_PIXEL_CAP" $B -- apps packages scripts package.json package-lock.json knip.config.ts ":!*.md"
# 0
```

- [ ] A1 探针达到预期
- [ ] A2 ROADMAP §7.3 作弊清单无未授权项
- [ ] A3 删掉的测试都能对上 d 节的「测 CF 或被删接缝」
- [ ] A4 改动文件全部落在 a 的范围内
- [ ] A5 R1–R5 有用例与输出

## j. 风险与门控

**G-CF**（输出为空，且 SS 已合入集成分支）：

```powershell
git -C C:\Software\conex status --porcelain -- package.json package-lock.json apps/crish-desktop/package.json apps/crish-desktop/vite.config.ts scripts/check-i18n-unused-keys.mjs scripts/inspect-index-contents.cjs scripts/token-registry.json apps/crish-desktop/src/i18n apps/crish-desktop/src/extensions/conversation-flow packages/conversation-flow apps/crish-desktop/src/components/chat-card apps/crish-desktop/src/components/chat-message apps/crish-desktop/src/components/chat-message-list apps/crish-desktop/src/components/chat-tool-call apps/crish-desktop/src/entry-core.tsx apps/crish-desktop/src/workers
```

编写时根 package.json、lock、desktop package.json、vite.config.ts、i18n 在写，**门控未满足**。

基于含 SS 的集成结果开分支。SS-P6 会改 chat-message 一带的 store 读取。

与 ST 串行。对 Markdown 方案的影响：MD-07、MD-08 随本模块消失；thinking 渲染器从 4 套降为 3 套。W5 的 markdown 方案不得重做这部分。

最大风险是 `CompactToolRow` 删反分支。R1 覆盖。

## k. 已决事项

D1 = 删除。没有「激活转正」这条路。没有剩余的「待用户决策」。
