# 统一 Prompt SSOT 集中库与斜杠命令收敛深度审计报告

> **审计位**：架构与代码安全执行期审计位
> **对照基准**：
> - `docs/prompt-injection-pipeline/00-总方案-统一提示词与上下文注入通道架构规划.md`
> - `docs/prompt-injection-pipeline/detailed-plans/01-统一Prompt集中库与模板详案.md`
> - `docs/prompt-injection-pipeline/detailed-plans/02-对话流可见注入卡片协议与呈现详案.md`
> - `docs/prompt-injection-pipeline/detailed-plans/05-定时任务编排助手落地实践详案.md`
> - `AGENTS.md`（§7 严禁补丁与立体验证、§8 反过度设计、§11 前端代码行数与解耦门禁）
>
> **审计范围**：
> - `apps/crish-desktop/src/prompts/**`（types, registry, compiler, core, environment, modes 及测试）
> - `apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts`、`slashContextCards.ts`
> - `apps/crish-desktop/src/api/resolveSlashCommand.ts`（挂载于 api 域的纯解析模块）
> - `apps/crish-desktop/src/api/chat-bridge/streamSession.ts`、`streamFinishControl.ts`
> - `apps/crish-desktop/src/api/goalModeContinuation.ts`、`apps/crish-desktop/src/api/skillsApi.ts`
> - 历史删除文件 `slash-prefixes.ts`、`composerSeed.ts`、`workflowAssistantPrompt.ts` 零残留核查
>
> **审计时间**：2026-09-02
> **审计结论**：**通过（PASS）**，核心契约严密落地，死代码与旧暗流彻底清零，行数门禁全绿；报告记录 2 项深层防注入演进点与 3 项结构微观不对称备忘。

---

## 一、自动化门禁与测试基线验证

本次审计首先对相关模块执行了全套静态检查、单元测试及代码行数门禁扫描，结果如下：

| 验证维度 | 验证指令 | 现场执行结果 | 状态 |
| :--- | :--- | :--- | :---: |
| **TypeScript 严格类型检查** | `npm run typecheck` | 扫描 `crish-desktop`、`agent-workbench`、`shared-types`、`shared-utils`，0 错误退出（exit code 0） | ✅ PASS |
| **Prompt 快照与编译器测试** | `npx vitest run apps/crish-desktop/src/prompts` | 2 个测试文件，26 项用例 100% 通过（逐字节快照锁定与防注入单测） | ✅ PASS |
| **斜杠命令与关联链路测试** | `npx vitest run resolveSlashCommand slashSendDraftManager skillsApi goalModeController` | 4 个测试套件，115 项用例 100% 通过 | ✅ PASS |
| **代码行数门禁（RL-03）** | `npm run check:line-counts` | 全局扫描 1158 个文件，0 违规，0 硬阻断；本次重构涉及文件全部合规 | ✅ PASS |
| **Git 工作区纯净度** | `git status --short` | 工作区完全 clean，无未跟踪残留或冲突 | ✅ PASS |

---

## 二、核心审计要点深度审查

### 1. 提示词集中库的模块化、类型安全与插值引擎防注入机制

#### 1.1 模块化分层与 Facade 设计
- **目录结构严格映射分层协议**：
  - [`types.ts`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/types.ts#L14-L24)：定义了 `PromptLayer`（L0 core ~ L5 dynamic），将静态基座（core/environment）与动态模式（mode）在类型层面做了严格隔离；
  - [`compiler/`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/interpolate.ts#L1-L63)：包含零外部依赖、无正则回溯的插值引擎 `interpolate.ts` 与结构转义器 `escaping.ts`；
  - [`core/`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/core/systemCore.ts#L1-L48)：承载 L0 静态基座 `SYSTEM_CORE_PROMPT` 与响应风格 `RESPONSE_STYLE_PROMPT`；
  - [`environment/`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/environment/hostEnvironment.ts#L1-L41)：承载 L1 运行时宿主环境 `HOST_ENVIRONMENT_PROMPT`；
  - [`modes/`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/modes/workflowAssistant.ts#L1-L71)：承载 L2 动态模式指令（`workflowAssistant`、`goalMode`、`grillMe`、`codeReview`）；
  - [`registry.ts`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/registry.ts#L14-L49)：实现单例 `PromptRegistry`，同步注册全量模板，支持按 ID 与 Layer 查询；
  - [`index.ts`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/index.ts#L1-L16)：集中导出 Facade 门面，禁止外部深层私有引用。

#### 1.2 类型安全与编译/运行期双重防护
- **泛型约束**：`PromptTemplate<TParams>`（[`types.ts:50`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/types.ts#L50)）将参数强类型化，例如：
  - `SYSTEM_CORE_PROMPT`: `{ customSystemPrompt?: string }`
  - `HOST_ENVIRONMENT_PROMPT`: `{ os: string; shell: string; workspaceRoot: string }`（三者必填，编译期拦截遗漏）
  - `GRILL_ME_PROMPT`: `{ topic: string; maxQuestions?: number }`
  - `GOAL_MODE_PROMPT`: `{ goal: string; currentRound: number; maxRounds: number; openTasksBlock?: string }`
- **运行时缺参安全回退**：
  在 [`interpolate.ts:46-52`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/interpolate.ts#L46-L52)，当实参出现 `undefined` 或 `null` 时：
  ```ts
  if (val === undefined || val === null) {
    console.warn(`[PromptCompiler] Missing param "${key}" for prompt "${meta.id}". Falling back to empty.`);
    return '';
  }
  ```
  严格遵循「纯函数不抛未捕获异常」原则，控制台告警并安全降级为空字符串，避免在对话主流或发送预检中造成 UI 崩溃。
- **双语回退链**：[`interpolate.ts:30-37`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/interpolate.ts#L30-L37) 实现了 `ctx?.locale ?? meta.defaultLocale ?? 'zh-CN'` 选择机制，未指定或不支持的语言安全回落至 `zh-CN`。

#### 1.3 插值引擎与防注入机制（escaping.ts / interpolate.ts）
- **算法复杂度与性能**：
  占位符正则采用 [`PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/interpolate.ts#L14)，不含任何嵌套量词或交错分组，从根本上杜绝了正则灾难性回溯（ReDoS）风险。单次模板渲染耗时经评测 <0.05ms，无需维护额外的复杂编译缓存池（符合反过度设计红线）。
- **Markdown 分隔线注入拦截**：
  [`escaping.ts:7-23`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/escaping.ts#L7-L23) 通过按行扫描正则 `HARD_RULE_LINE_RE = /^\s*([-_=*]{3,})\s*$/`，将用户或动态参数中独立成行的 3 个及以上连续分隔符（如 `---`、`===`、`___`、`***`）自动转义包裹为行内代码块（如 `` `---` ``）。
  - **效果**：阻断了恶意动态参数伪造 Markdown 横向分隔线切断系统提示词结构或伪装 YAML frontmatter 的注入行为。
  - **数组元素逐行转义**：[`interpolate.ts:53-57`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/interpolate.ts#L53-L57) 确保数组参数在按行拼接前，每个元素均独立经过 `escapePromptValue` 转义，单测覆盖完整（[`interpolate.test.ts:65`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/__tests__/interpolate.test.ts#L65)）。
- **深度防注入边界挖掘（改进建议）**：
  1. **代码块围栏标记（Backticks Fences）未转义**：`HARD_RULE_LINE_RE` 仅匹配 `[-_=*]`，若动态参数包含独立行的三反引号（```` ``` ````）或系统提示词仿真标记（如 ```` ```system ````），当前尚未对反引号做转义包裹，在大模型特定格式下存在潜在格式截断风险；
  2. **类 XML/HTML 伪标签未过滤**：针对部分 Claude/GPT 模型的 `<system>`、`<rules>` 标记，未作语义转义；
  3. **首尾 Trim**：`escapePromptValue` 执行了 `.trim()`，对纯代码段的缩进保留良好，但会削减外部显式空行（符合设计预期）。

---

### 2. 静态 System Prompt 逐字节不可变（Prompt Caching 命中）的实现是否严密

#### 2.1 静态系统基座与动态模式的分水岭设计
大模型厂商（Anthropic Claude, OpenAI, DeepSeek 等）的前缀缓存（Prompt Caching）要求系统消息前缀在字节级别绝对恒定。任何在系统消息中掺杂动态会话 ID、动态时间戳、轮次计数或动态模式指令的行为，都会造成整段缓存被击穿。
- **架构隔离断言**：
  - L0/L1 静态基座资产（`systemCore.ts`、`responseStyles.ts`、`hostEnvironment.ts`）严格定位为会话生命周期内逐字节不变；
  - L2 动态模式（`goalMode`、`grillMe`、`workflowAssistant`）全部通过 `slashSendPreflight.ts` 渲染为**消息载荷（modelText）**与**可见卡片（contextInjectionDispatcher）**，**绝对禁止回拼进 System Prompt**；
  - 静态单测锁定：[`prompts.snapshot.test.ts:48-58`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/__tests__/prompts.snapshot.test.ts#L48-L58) 明确断言 `相同参数渲染结果逐字节恒等（Prompt Caching 命中前提）`，并已持久化入 Snapshot。

#### 2.2 流式会话组装点（streamSession.ts & streamFinishControl.ts）核验
- **调用链核查**：
  在 [`streamSession.ts:107-137`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/streamSession.ts#L107-L137)：
  ```ts
  const styleLevel = resolveResponseStyle(sets?.responseStyle);
  responseStyleGuidance = getResponseStyleDescription(styleLevel, 'en-US');
  ...
  const systemPrompt = composeSystemPrompt(
    options?.systemPrompt,
    responseStyleGuidance
  );
  ```
  在 [`streamFinishControl.ts:13-21`](file:///c:/Software/conex/apps/crish-desktop/src/api/chat-bridge/streamFinishControl.ts#L13-L21)：
  ```ts
  export function composeSystemPrompt(
    base: string | undefined,
    guidance: string | undefined
  ): string | undefined {
    const b = typeof base === 'string' ? base.trim() : '';
    const g = typeof guidance === 'string' ? guidance.trim() : '';
    if (b && g) return `${b}\n\n${g}`;
    return b || g || undefined;
  }
  ```
  - `options.systemPrompt` 来自 Provider Profile 配置，在会话中恒定；
  - `responseStyleGuidance` 来自全局设置项，通过集中库中固化的 `RESPONSE_STYLE_GUIDANCE_MAP['en-US']` 单行常量映射，文本恒定；
  - 组装过程为纯字符串拼接，零动态时间、零随机数，因此同一配置下的每次流式请求发往引擎的 `systemPrompt` 均具备**逐字节不可变性**，能够完美命中大模型缓存。

#### 2.3 资产与接入现状核验（第 1~2 轮主控裁决落地）
- **核查发现**：
  `SYSTEM_CORE_PROMPT`（5 条工程协作纪律）与 `HOST_ENVIRONMENT_PROMPT`（宿主与运行环境）目前已在 `src/prompts/` 集中库中完整就绪并通过快照测试，但**暂未直接拼入 `streamSession.ts:composeSystemPrompt`**。
- **依据查证**：
  查验 `docs/prompt-injection-pipeline/audits/01-执行审计-第1-2轮.md:23` 及 `实现波调度状态.md:64`：
  > “`SYSTEM_CORE_PROMPT` 暂不接入 `composeSystemPrompt`——直接拼接会改变现有 system 文本行为，是否引入由后续 wire 投影轮次再定。”
- **审计结论**：当前未直接拼接是主控审慎控制 wire 变更的既定决策，未发生架构越界或意外破坏现有模型的 System Prompt 语义。

---

### 3. slashSendPreflight 拆分出 slashContextCards 后的复杂度与代码行数合规性

#### 3.1 代码行数指标核算（AGENTS.md §11 / RL-03 门禁）
根据仓库规范，业务逻辑代码有效行预算为 ≤ 400 行。通过自动化门禁脚本 `scripts/check-line-counts.mjs` 现场核算：

| 模块文件路径 | 承担职责类别 | 物理总行数 | 有效代码行数 | 行数预算上限 | 合规判定 |
| :--- | :--- | :---: | :---: | :---: | :---: |
| [`hooks/chat-stream/slashSendPreflight.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts) | 发送前置校验与 Payload 组装 | 418 | **368** | ≤ 400 | ✅ PASS (合规) |
| [`hooks/chat-stream/slashContextCards.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashContextCards.ts) | 斜杠命令与附件可见卡片派发 | 95 | **77** | ≤ 400 | ✅ PASS (精炼) |
| [`api/resolveSlashCommand.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/resolveSlashCommand.ts) | 纯函数式命令与别名解析器 | 449 | **319** | ≤ 400 | ✅ PASS (合规) |
| [`api/workflow-api/workflowAssistantCard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/workflow-api/workflowAssistantCard.ts) | 定时编排助手卡片构建派发 | 73 | **52** | ≤ 400 | ✅ PASS (精炼) |
| [`hooks/chat-stream/slashSendDraftManager.ts`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendDraftManager.ts) | 草稿暂存、清空与回填撤销 | 137 | **101** | ≤ 400 | ✅ PASS (合规) |

#### 3.2 架构职责与圈复杂度（Cyclomatic Complexity）改善
- **拆分前问题**：原 `slashSendPreflight.ts` 承担了命令字符串解析、别名匹配、多种卡片组装、草稿 DOM 控制、附件转码等上帝组件职责，代码超标严重。
- **拆分后边界收敛**：
  1. **解析与副作用解耦**：`resolveSlashCommand.ts` 沉淀为纯函数，零外部 Store/网络/DOM 依赖，通过规格驱动的 `SLASH_COMMAND_SPECS` 映射所有英文与中文别名；
  2. **卡片构造收口**：`slashContextCards.ts` 专一负责将上下文注入转换为统一契约 `MessageContextInjection` 提交给 `contextInjectionDispatcher`；
  3. **预检主管道扁平化**：`runPreflightChecks`（[`slashSendPreflight.ts:82-317`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L82-L317)）仅维护一条自上而下的安全检查短路分支（引擎就绪检查 → 导航类命令分流 → `/schedule` 预填/对齐分流 → 缺参守卫 → `/skill` 发现 → `/learn` 规则持久化 → `/compact` 压缩分流），各分支清晰无深层嵌套；
  4. **Payload 组装标准化**：`assembleChatPayload`（[`slashSendPreflight.ts:332-417`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L332-L417)）专职组装目标模式、多模态附件、文件批注，逻辑干净收敛。

---

### 4. /schedule、/grill-me、/goal、/skill 触发时是否统一派发可见卡片与标头化文本

#### 4.1 四大命令与附件的端到端行为比对

| 命令 | 触发入口与行号 | 派发可见卡片 | 卡片类型 (kind) 与标题 | 模型文本标头 (Wire 载荷) | 所见即所知 (WYSIWYG) 一致性 |
| :--- | :--- | :---: | :--- | :--- | :---: |
| **`/schedule`** (无参) | [`slashSendPreflight.ts:151-171`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L151-L171) | ✅ | `schedule_trigger`<br>`⚡ 定时任务编排助手模式 (Workflow Grill-Me)` | `[系统上下文注入 · 定时任务编排助手]` | ✅ 一致（预填草稿 + 派发卡片，零 AI 轮次） |
| **`/schedule`** (带参) | [`slashSendPreflight.ts:174-188`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L174-L188) | ✅ | `schedule_trigger`<br>`⚡ 定时任务编排助手模式 (Workflow Grill-Me)` | `[系统上下文注入 · 定时任务编排助手]` | ✅ 完全一致（卡片内容即下发文本） |
| **`/grill-me`** | [`slashSendPreflight.ts:364-372`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L364-L372) | ✅ | `runtime_steering`<br>`🤝 需求对齐模式 (Grill-Me)` | `[系统上下文注入 · 需求对齐模式]` | ✅ 完全一致（`rendered` 同步进卡片与 modelText） |
| **`/goal`** (首轮) | [`slashSendPreflight.ts:341-362`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L341-L362) | ✅ | `runtime_steering`<br>`🎯 目标推进模式 (Goal Mode)` | `[目标模式 · 系统指令]`（Wire）<br>*注：卡片带外层 `[系统上下文注入 · 目标推进模式]`* | ⚠️ 存在微观不对称（详见下文） |
| **`/goal`** (续写轮) | [`goalModeContinuation.ts:269-273`](file:///c:/Software/conex/apps/crish-desktop/src/api/goalModeContinuation.ts#L269-L273) | ❌ (防刷屏) | 不重复派卡 | `[目标模式 · 系统指令]` | ✅ 符合产品口径（首轮立项，后续静默推进） |
| **`/skill`** | [`slashSendPreflight.ts:221-230`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L221-L230) | ✅ | `skill`<br>`🛠️ 技能上下文：${skill.name}` | `【技能：${skill.name}】` | ✅ 完全一致（`formatSkillInjection` 产物双向投递） |
| **附件** (图片/文本) | [`slashSendPreflight.ts:394`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L394) | ✅ | `file_context`<br>`🖼️/📎 附件：${name}` | `[图片附件 · ...] / [文件附件 · ...]` | ✅ 完全一致 |

#### 4.2 审查发现的微观不对称点（Inconsistencies & Findings）
1. **`/goal` 卡片标头双层包装与 Wire 文本不一致**：
   - 查看 [`slashContextCards.ts:40`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashContextCards.ts#L40)：
     `const goalCard = \`[系统上下文注入 · 目标推进模式]\n\n\${directive}\`;`
   - 而 `directive` 来自 [`buildGoalModePrefix`](file:///c:/Software/conex/apps/crish-desktop/src/api/goalModeContinuation.ts#L78)，其内部渲染自 `GOAL_MODE_PROMPT`，模样本身就已自带第一行标头 `[目标模式 · 系统指令]`；
   - 导致卡片展示内容为双层标头：
     ```text
     [系统上下文注入 · 目标推进模式]

     [目标模式 · 系统指令]
     你正在自主执行一项长期工程目标...
     ```
   - 但在 [`slashSendPreflight.ts:361`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L361) 中，实际下发给模型的 `modelText` 却是：
     `modelText = \`\${directive}\${goalText}\`;`
     即下发给模型的并不含最外层的 `[系统上下文注入 · 目标推进模式]`，仅有 `[目标模式 · 系统指令]`；
   - **影响评估**：不影响模型对长期目标模式指令的理解，但违背了严格的 WYSIWYG（所见即所知）单真理源原则。
2. **标头标点风格微观差异**：
   - `/schedule`、`/grill-me` 采用半角方括号加间隔号：`[系统上下文注入 · XXX]`；
   - `/skill` 采用全角黑方括号：`【技能：XXX】`（源自 [`skillsApi.ts:274`](file:///c:/Software/conex/apps/crish-desktop/src/api/skillsApi.ts#L274)）；
   - 建议在后续技能层标准化时统一对齐为 `[系统上下文注入 · 技能 · XXX]`。

---

### 5. 排查是否存在任何硬编码散落文本与未清理的旧暗流

#### 5.1 负产出与已删除文件 0 残留核查
通过全仓库范围的代码级深度 Grep 与文件系统物理探测，核实历史暗流清除情况：

| 历史技术债 / 遗留项 | 预期处置动作 | 现实物理状态 | 代码引用残留 | 审计结论 |
| :--- | :--- | :---: | :---: | :---: |
| `slash-prefixes.ts` | 物理彻底删除 | 磁盘已不存在（0 个文件） | **0 处**（仅 `slashSendPreflight.ts:368` 存在 1 处重构说明注释） | ✅ 彻底清理 |
| `GRILL_ME_PREFIX` 硬编码 | 彻底销毁旧拼接 | 已销毁 | **0 处**引用 | ✅ 彻底清理 |
| `workflowAssistantPrompt.ts` | 乱码草案物理删除 | 磁盘已不存在（0 个文件） | **0 处**（仅在取代该文件的注释中提及历史背景） | ✅ 彻底清理 |
| `composerSeed.ts` (单键通道) | 物理删除 sessionStorage 暗流 | 磁盘已不存在（0 个文件） | **0 处**引用（统一收拢于 `sessionDraftManager`） | ✅ 彻底清理 |
| `STYLE_DESCS` / `STYLE_ZH_MAP` | 迁出 `streamSession.ts` | 原文件已清退 | **0 处**硬编码散落字典（已收敛至 `responseStyles.ts`） | ✅ 彻底清理 |
| `let pendingAnnotations` 全局数组 | 消除跨会话串扰 | 会话池替代 | **0 处**全局数组（`workspaceFsApi.ts` 已使用 Map 隔离） | ✅ 彻底清理 |

#### 5.2 散落文本与待清理收敛项排查
1. **`SKILL_INJECTION_TEMPLATE` 就地实现问题**：
   在 [`apps/crish-desktop/src/api/skillsApi.ts:261-279`](file:///c:/Software/conex/apps/crish-desktop/src/api/skillsApi.ts#L261-L279)，虽然使用了统一的 `createPromptTemplate` 编译器，但该模板：
   - 仍然驻留在 `src/api/` 目录下，未纳入 `src/prompts/` 统一目录；
   - 未在 [`PromptRegistry`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/registry.ts#L17-L25) 中注册（`PromptRegistry.listAll()` 目前为 7 个模板，不含该项）；
   - 代码行已标明注释：`skills（L4）层集中资产待技能注入后续收口轮迁入 src/prompts/skills/skillFormatter.ts`，应纳入后续规划。
2. **`WORKFLOW_CREATE_TEMPLATE` 局部常量**：
   在 [`api/workflow-api/workflowAssistantCard.ts:14-20`](file:///c:/Software/conex/apps/crish-desktop/src/api/workflow-api/workflowAssistantCard.ts#L14-L20)，`/schedule` 无参时的引导模板是一个裸字符串数组 `join('\n')`。虽然其本质是前端草稿引导占位，而非直接送给模型的指令，但未来若涉及多语言国际化，应提取为模板资源。
3. **`slashSendPreflight.ts` 中的硬编码正则**：
   在 [`slashSendPreflight.ts:149`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L149)：
   `const restText = rawInput.replace(/^\/(schedule|定时任务|定时)\s*/i, '').trim();`
   这里硬编码了别名列表，而 [`resolveSlashCommand.ts:70-76`](file:///c:/Software/conex/apps/crish-desktop/src/api/resolveSlashCommand.ts#L70-L76) 中的 `SLASH_COMMAND_SPECS` 已经定义了 `['定时', '定时任务']`。建议此处直接利用解析结果或从 spec 生成正则，消除潜在别名维护漂移。

---

## 三、缺陷与风险清单（Defect & Risk Catalog）

| 序号 | 等级 | 缺陷/风险项 | 涉及文件与行号 | 根因与表现 | 建议行动 |
| :---: | :---: | :--- | :--- | :--- | :--- |
| **D-01** | **P2** | `/goal` 可见卡片与下发模型文本标头不对称 | [`slashContextCards.ts:40`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashContextCards.ts#L40)<br>[`slashSendPreflight.ts:361`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L361) | 卡片正文包裹了 `[系统上下文注入 · 目标推进模式]`，而 `directive` 内部又有 `[目标模式 · 系统指令]`，导致卡片呈现双层标头，且与下发给模型的 `modelText` 产生微小偏差。 | 将 `slashContextCards.ts` 中 `goalCard` 与 `modelText` 对齐为一致的单一标头，践行严格 WYSIWYG。 |
| **D-02** | **P2** | `SKILL_INJECTION_TEMPLATE` 未纳入集中库与注册表 | [`skillsApi.ts:261`](file:///c:/Software/conex/apps/crish-desktop/src/api/skillsApi.ts#L261)<br>[`prompts/registry.ts:17`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/registry.ts#L17) | 模板就地定义在 API 消费侧，未迁入 `prompts/` 集中库，且未在 `PromptRegistry` 登记，破坏了全量模板 SSOT 单点自省能力。 | 在后续技能收口轮次将其迁至 `prompts/skills/skillFormatter.ts` 并完成注册。 |
| **D-03** | **P3** | Markdown 代码块反引号围栏与类 XML 标签防注入盲区 | [`compiler/escaping.ts:7`](file:///c:/Software/conex/apps/crish-desktop/src/prompts/compiler/escaping.ts#L7) | `HARD_RULE_LINE_RE` 仅匹配 `[-_=*]{3,}`，未覆盖 ` ``` ` 代码块分隔线或 `<system>` 伪标签，恶意构造参数可能越界。 | 扩展 `escaping.ts`，增加对反引号行与伪系统标签的轻量转义保护。 |
| **D-04** | **P3** | `slashSendPreflight.ts` 存在别名硬编码匹配 | [`slashSendPreflight.ts:149`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts#L149) | `rawInput.replace(/^\/(schedule\|定时任务\|定时)\s*/i, '')` 与 `SLASH_COMMAND_SPECS` 别名定义重复。 | 改为从 `SLASH_COMMAND_SPECS` 获取 aliases 或在解析层直接产出 `restText`。 |

---

## 四、审计总结

本次深度审计对 Prompt SSOT 集中库与斜杠命令收敛的所有目标代码进行了详尽核查：
1. **架构收敛成功**：以 `prompts/` 为核心的 SSOT 集中库结构清晰，类型安全完备，插值引擎零外部依赖且具备基础 Markdown 结构防注入能力；
2. **前缀缓存保障有力**：System Prompt 保持了高纯度与会话内逐字节恒等，动态模式指令全部转移至用户消息侧与可见卡片侧，大模型 Prompt Caching 机制得到可靠保护；
3. **行数与解耦达标**：拆分后的 `slashSendPreflight.ts`（368 行）、`slashContextCards.ts`（77 行）及 `resolveSlashCommand.ts`（319 行）全部严格控制在 400 行业务逻辑预算之内，CI 门禁全绿通过；
4. **历史技术债彻底出清**：`slash-prefixes.ts`、`workflowAssistantPrompt.ts` 乱码文件、`composerSeed.ts` 单键通道等已完成物理删除与代码 0 残留验证；
5. **后续改进明确**：审计识别出的 `/goal` 标头一致性微调（D-01）与技能模板归仓（D-02）已建档留痕，可在后续专项中平滑收口。

综合判定本次重构达到交付质量标准，**审计予以通过**。
