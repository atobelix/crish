# 03 插件生态与上下文架构对比：kimi-code / opencode → Crish

> 本报告为纯调研文档（只读分析，不改代码）。对比两个参考项目的插件运行时、hook 事件面、
> 工具注入、上下文注入与官方插件形态，对照 Crish 现有插件声明面与接线现状，
> 输出差距清单、三步走路线评估与 Top 10 借鉴点，供 improvement/ 方案系列直接引用。

## 目录

1. [结论摘要](#结论摘要)
2. [主题一：插件模型](#主题一插件模型)
3. [主题二：hook 事件面](#主题二hook-事件面)
4. [主题三：工具注入与 transform](#主题三工具注入与-transform)
5. [主题四：上下文 / 系统提示词注入](#主题四上下文--系统提示词注入)
6. [主题五：官方插件形态](#主题五官方插件形态)
7. [专项评估：Crish 生态起步三步走](#专项评估crish-生态起步三步走)
8. [Top 10 借鉴点](#top-10-借鉴点)
9. [引用文件索引](#引用文件索引)

---

## 结论摘要

- **opencode 是"代码型插件"标杆**：`Plugin = (input, options) => Promise<Hooks>`，函数即插件；
  加载管线三段分离（npm 安装 → entrypoint 探测 → 版本兼容门），运行时按顺序触发
  `(input, output) => Promise<void>` 双参钩子，输出对象原地改写；事件订阅、工具定义改写、
  系统上下文代数全部有真实接线。
- **kimi 是"声明式插件"标杆**：manifest 驱动（skills / mcpServers / sessionStart / hooks /
  commands），**无代码运行时**（`tools`/`apps`/`inject`/`bootstrap` 字段显式报"不支持"）；
  hooks 走外部命令形态（Claude Code 风格 16 事件），插件能力通过 `IPluginService` 消费面
  （技能目录、会话启动注入、MCP 服务器、外部 hooks）注入主 Agent。
- **Crish 现状是"声明面完备、引擎零接线"**：plugin-sdk 的 manifest + TrustGate + 14 钩子 +
  PluginAPI 双重校验齐全（且 loader/store/trust-gate 刚补测试），但引擎侧只有 3 个事件
  （turn.end / tool.pre / tool.post，`hooks.rs`）与 ToolMiddleware 三钩子（`middleware.rs`），
  14 钩子与 24 引擎事件之间无桥接。opencode 的 `tool.definition`（工具定义改写）与
  system-context 代数（可插拔上下文源）在 Crish 完全没有对应物。
- **路线建议**：三步走方向成立，但顺序建议微调——步 1 补"工具定义改写面"与"插件事件桥"
  两个缺口后再做官方插件试点；官方导入插件优先参考 kimi 的纯声明式形态（减少第一代
  插件运行时在 Tauri 环境的动态加载风险）。

---

## 主题一：插件模型

### 1.1 opencode：函数即插件（代码型）

**核心类型**（`reference/opencode/packages/plugin/src/index.ts:74`）：

```ts
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
```

- `PluginInput`（index.ts:56-66）：`client`（SDK 客户端，可回调宿主服务）、`project`、
  `directory`、`worktree`、`experimental_workspace.register()`（工作区适配器）、`serverUrl`、
  `$`（Bun shell）。
- `Hooks`（index.ts:222-335）共 21 个可选项，按能力分五类：
  - **auth**：`AuthHook`（index.ts:88-163）——OAuth/API 凭据方法定义 + prompts
    （text/select + `when` 规则），插件可自定义登录流程；`provider` 钩子（index.ts:214-217）
    可返回模型目录。
  - **tool**：`tool` 字段直接注册自定义工具（index.ts:226-228）；`tool.definition`
    （index.ts:334）改写既有工具描述与参数；`tool.execute.before/after`（index.ts:266-281）。
  - **permission**：`permission.ask`（index.ts:261）可拦截审批并把状态改为
    `"ask" | "deny" | "allow"`。
  - **event**：`event`（index.ts:224）订阅宿主全部公开事件。
  - **chat / 上下文**：`chat.message`、`chat.params`（改 temperature/topP 等）、`chat.headers`
    （改请求头）、`experimental.chat.messages.transform`、`experimental.chat.system.transform`
    （改 system 数组）、`experimental.session.compacting`（改压缩提示词）、
    `experimental.compaction.autocontinue`（跳过压缩后自动续跑）。
- **双参模式**：所有"trigger 型"钩子统一 `(input, output) => Promise<void>`，钩子只改
  `output` 对象、不返回值；`TriggerName` 类型约束在 index.ts:40-42 用条件类型推导。

**运行时与加载**（`reference/opencode/packages/opencode/src/plugin/loader.ts`）：

- 加载管线三段分离（loader.ts:86-133）：`resolvePluginTarget`（npm 按需安装）→
  `createPluginEntry`（按 `package.json` 的 `exports["./server"]` / `exports["./tui"]` 探测
  entrypoint，install.ts:128-163）→ npm 插件过 `checkPluginCompatibility` 版本门
  （loader.ts:125-131，file:// 本地插件跳过）。
- `load()` 只做 `await import(entry)`（loader.ts:136-145）；file 插件安装失败可等依赖后
  重试一次（loader.ts:215-230），**但一旦 import 失败即为终态**——Bun 会缓存失败的动态
  import（loader.ts:207 注释明示）。
- 触发实现（`reference/opencode/packages/opencode/src/plugin/index.ts:280-293`）：
  `Plugin.trigger(name, input, output)` 按注册顺序逐插件执行，输出对象原地改写。
- 失败策略：加载阶段逐级上报并发布 `Session.Event.Error`（plugin/index.ts:194-211）；
  单个插件加载失败**不阻断其他插件**（applyPlugin 包 tryPromise + tapError + catch 继续，
  plugin/index.ts:220-238）；config 钩子失败仅记日志（plugin/index.ts:241-249）。
- 生命周期：`dispose` 在实例销毁时逐个调用（plugin/index.ts:261-274）；事件订阅按
  **每工作目录实例**建立（InstanceState，plugin/index.ts:130, 251-259）。
- 内置插件（auth 提供商）就是直接 import 的普通函数（plugin/index.ts:65-82
  internalPlugins：CodexAuth、CopilotAuth、GitlabAuth、XaiAuth 等），与外部插件同一套
  Hooks 契约——"官方插件 = 内置函数"先例。
- v2 双 API（`packages/plugin/src/v2/`）：`effect/plugin.ts:4-16` 定义
  `Plugin { id, effect: (context) => Effect<void> }` + `define()`；`promise/` 目录同构
  Promise 版。v2 提供能力模块：agent / aisdk / catalog / command / context / event /
  filesystem / integration / location / npm / path / reference / registration / skill。
  核心侧加载器（`packages/core/src/plugin.ts:43-83`）用 KeyedMutex + Scope.fork 管理
  插件生命周期、显式检测加载循环（"Plugin load cycle detected"）。
- 配置形态：`plugin?: Array<string | [string, PluginOptions]>`（index.ts:70-72），
  `opencode plugin add` 用 jsonc-parser 保注释写回 config（install.ts:168-179, 421-439）。

### 1.2 kimi：manifest 即插件（声明式）

（`reference/kimi-code/packages/agent-core-v2/src/app/plugin/`）

- 双 manifest 路径：`kimi.plugin.json` 或 `.kimi-plugin/plugin.json`（manifest.ts:16-17）。
- manifest 字段（manifest.ts:111-126）：`name/version/description/keywords/homepage/license/
  author/skills/sessionStart/mcpServers/hooks/commands/interface/skillInstructions`。
- **显式声明不支持运行时字段**（manifest.ts:19-26）：`tools`、`apps`、`inject`、`configFile`、
  `config_file`、`bootstrap` 出现时打 info 级诊断 "present but not supported by Kimi plugins"
  ——kimi 插件**没有 JS 执行面**，能力全部映射到宿主既有机制（MCP 服务器、技能、外部钩子）。
- 安装/更新链路：`github-resolver.ts` 用 codeload tarball + GitHub Atom feed 解析 commit
  SHA（github-resolver.ts:35-56，无 REST API 依赖）；`manager.ts` 管理 installed 记录、
  重载、汇总；`IPluginService`（plugin.ts:47-64）暴露消费面：`listPluginCommands` /
  `pluginSkillRoots` / `enabledSessionStarts` / `enabledMcpServers` / `enabledHooks`。
- 插件技能注入：`sessionSkillCatalog/pluginSkillSource.ts` 把启用插件的技能以优先级 5
  汇入技能目录（builtin 之上、user/workspace 之下），`onDidReload` 重发射给下游。
- 官方插件样例（`plugins/official/kimi-datasource/kimi.plugin.json`）：纯声明——
  `mcpServers.data`（node 启动本地脚本）+ `interface` 展示元数据 + 配套 `SKILL.md`
  （SKILL.md 即"会话内使用说明书"，教模型按 `mcp__plugin-kimi-datasource_data__*`
  命名规范调用工具）。

### 1.3 Crish 现状

- 声明面（`packages/plugin-sdk/` + `packages/shared-types/src/plugin.ts`）：
  - `PluginManifest`（shared-types/src/plugin.ts:26-51）：id/name/version/origin/trustLevel/
    entry/declaredHooks/declaredTools/declaredMcpServers/declaredAgents/permissions/
    minHostVersion；
  - 14 钩子事件名（plugin-sdk/src/manifest/manifest.ts:22-57：6 现有 + 8 新增 + tool.error）；
  - 信任两级 restricted/full（shared-types/src/plugin.ts:8）、权限六种
    （shared-types/src/plugin.ts:17-23）、`PluginActivationApi`（observe/on/registerTool/
    registerMcpServer，shared-types/src/plugin.ts:54-66）；
  - `PluginAPI` 实现（plugin-sdk/src/api/plugin-api.ts:62-185）：前置 assertCapability /
    assertPermission 即时拦截 + Loader 后置 validate 全量比对（双重校验）；
  - loader / store / trust-gate / registry 均已实现并有测试（`src/__tests__/` 10 个文件）。
- 引擎侧（`crates/`）：
  - `session-loop/src/hooks.rs`：HookRegistry 仅 3 事件（TurnEnd / ToolPre / ToolPost，
    hooks.rs:30-37），同步 handler（`HookHandler::handle`，hooks.rs:138-144），
    失败策略 swallow/log/propagate（hooks.rs:127-135）；
  - `agent-tools/src/middleware.rs`：ToolMiddleware 三钩子 before_execute / on_result /
    on_error（middleware.rs:56-96），已接线到 `ToolExecutor::execute_single`
    （见 docs/multi-agent-repair/06 决策记录）。
- 已知缺口（docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md:6-7）：14 个插件
  钩子全部死声明；plugin-sdk 的 manifest 与 shared-types 的 manifest 类型不一致是已知
  协调点（plugin-api.ts:40-45 注释）。

### 1.4 差距 / 可借鉴点

| 维度 | opencode | kimi | Crish | 借鉴 |
| --- | --- | --- | --- | --- |
| 插件本质 | 函数 + Hooks 对象 | manifest 声明映射宿主机制 | manifest + activate(api) 命令式 | 保持 Crish 现状（命令式激活 + 声明清单校验已是两者合流形态） |
| 加载 | npm 按需装 + 三段管线 + 版本门 | github tarball + SHA 固定 | loader/store 有测试，npm origin 推迟 Phase 2 | opencode loader 的**阶段分离与逐阶段错误报告**值得抄（loader.ts:86-192） |
| 失败语义 | 单插件失败不阻断、错误发事件 | info 级诊断累积 | propagate 不中断会话（已定） | 需补"错误事件化"（opencode publishPluginError，plugin/index.ts:135-137） |
| 官方/内置 | 内置插件 = 普通函数 | 官方插件 = 纯声明 + SKILL.md | 无先例 | kimi 形态（见主题五） |
| 安全 | 无 TrustGate（信任=安装来源+版本门） | realpath + isWithin 路径防逃逸（manifest.ts:162-225） | TrustGate 两级信任 + 能力清单 | **kimi 的 manifest 路径逃逸校验**可直接补进 Crish trust-gate 校验链 |
| v2 双 API | effect / promise 两套 | 无 | 无 | 不建议 Crish 学（双 API 是 opencode 自身迁移代价），只需 promise 单 API |

---

## 主题二：hook 事件面

### 2.1 opencode：事件总线 + 插件订阅

- 事件总线（`reference/opencode/packages/core/src/event.ts`）：EventV2 基于 Effect PubSub，
  事件定义在 `@opencode-ai/schema/event`，**持久化事件**（durable）落 SQLite 支持 replay
  （event.ts:46-62 `readAggregate`）；`events.listen` 供订阅。
- 插件订阅：每工作目录实例 `events.listen`（plugin/index.ts:251-259），按
  `event.location?.directory` 过滤本目录事件后转发给每个插件 `hook["event"]?.({...})`。
- 事件类型公开面：`packages/core/src/public-event-manifest.ts`（公开事件清单）+
  `schema/event` 定义注册表；插件能订阅任意注册事件，无白名单。
- 压缩相关事件可被插件改：`experimental.session.compacting` / `compaction.autocontinue`
  （plugin/src/index.ts:305-326）。

### 2.2 kimi：外部命令钩子（Claude Code 风格）

- 16 个事件类型（`agent-core-v2/src/agent/externalHooks/types.ts:3-20`）：PreToolUse /
  PostToolUse / PostToolUseFailure / PermissionRequest / PermissionResult / UserPromptSubmit /
  Stop / StopFailure / Interrupt / SessionStart / SessionEnd / SubagentStart / SubagentStop /
  PreCompact / PostCompact / Notification。
- `HookDef`（types.ts:24-31）：`{ event, matcher?, command, timeout?, cwd?, env? }`——
  **matcher 字段**可对工具类事件做模式匹配细分。
- 执行模型（runner.ts:58-120）：`runHook` spawn shell 子进程，默认 30s 超时（runner.ts:30）、
  AbortSignal 支持、stdout/stderr JSON 输出按 schema 解析（HookJsonOutputSchema，
  runner.ts:53-56），结果 `allow/block + message + hookSpecificOutput`
  （types.ts:33-42）；超时/失败**默认 allow**（runner.ts:72, 111, 117）——守门者不可用时
  放行优先。
- 钩子来源双通道：配置段 `[[hooks]]`（configSection.ts，TOML snake_case ↔ camelCase
  转换）+ 插件 manifest 的 `hooks` 字段（manifest.ts:287-309），统一汇入
  `IPluginService.enabledHooks()`。
- 事件消费面还有"会话启动注入"：`sessionStart.skill`（manifest.ts:227-245）——会话开始时
  把指定 skill 内容注入上下文。

### 2.3 Crish 现状与桥接方案

- 事件面三层并存：
  1. **24 个引擎事件**（`packages/shared-types/src/events.ts`）：agent 2 + turn 2 +
     message 3 + tool 6 + compression 2 + diagnostic 9；
  2. **14 个钩子事件声明**（plugin-sdk manifest.ts:22-57）；
  3. **Rust HookRegistry 实装 3 事件**（hooks.rs:30-37）。
- 已有桥接基调（06 决策记录）：`turn.end` → turn_complete.rs 步骤 4.5（Block = stop 建议）；
  `tool.pre/tool.post` → execute_single 内与 middleware 链共享点位；顺序
  middleware before → tool.pre → 执行 → tool.post → middleware on_result/on_error
  （06 文档:33-45, 96-104）。
- **桥接缺口**：24 引擎事件 → 14 钩子事件的映射表不存在；observe/on 双模式
  （`HookMode = 'observe' | 'on'`，shared-types/src/hooks.ts:26）未进 Rust 侧；
  handler 为同步回调（06 文档遗留："生态轮转 async_trait"）；timeout/abort 未并入
  竞速窗口（06 文档:148-152）；`model.beforeRequest/afterResponse`（映射
  provider 层的 `events.rs`）与 `context.compact.*`（映射 compression 域事件）无接线点。

### 2.4 差距 / 可借鉴点

- **事件订阅模型**：opencode 是"插件订阅任意事件"（每个钩子全量转发 + location 过滤），
  kimi 是"事件白名单 + matcher 细分"。Crish 更适合 **24 → 14 的显式映射表**（声明式、
  可测），而不是全量转发——禁令 14 已要求事件名冻结，映射表天然是桥。
- **kimi 的 matcher 字段**（types.ts:25-27）对 `tool.pre/tool.post` 极有价值：可按
  工具名正则细分，避免插件收到全部工具事件。Crish 的 ToolPrePayload 只有 toolName
  精确值，Rust HookEvent 无 matcher 概念——可在桥接层做 matcher 过滤而非改事件面。
- **kimi 的"超时默认 allow"**（runner.ts:72, 111, 117）与 Crish 的
  "propagate 不中断会话"原则互补：Crish 缺的是**超时语义**（HookRegistration.timeoutMs
  已有声明，06 文档确认未接入运行时）。
- **错误事件化**：opencode 插件失败发布 `Session.Event.Error`（plugin/index.ts:135-137）
  与 Crish 24 事件里的 `runtime-error` 可对应——插件错误应进入诊断事件流而非裸日志。

---

## 主题三：工具注入与 transform

### 3.1 opencode：定义改写 + 执行包裹 + 四维过滤

- **工具定义改写**（`packages/opencode/src/tool/registry.ts:305-334`）：`tools()` 在每次
  为模型生成工具清单时，对每个工具触发 `plugin.trigger("tool.definition", { toolID },
  output)`，钩子可改 `description` 与 `parameters`——**按 (provider, model, agent) 动态
  生成时改写**，不是注册时改写。
- **插件注册新工具**：`Hooks.tool`（plugin/src/index.ts:226-228）返回 `ToolDefinition`
  对象（description/args/execute，registry.ts:350-352 的 isPluginTool 判别），经
  `createPluginTool` 合入 custom 工具集。
- **执行包裹**（`packages/opencode/src/session/tools.ts:102-132`）：每个工具 execute 内
  依次 `tool.execute.before`（可改 args）→ 执行 → `tool.execute.after`（output 归一为
  `{ title, output, metadata }`，index.ts:274-281）。MCP 资源工具同款包裹
  （session/tools.ts:175-218）。
- **四维过滤链**（session/tools.ts:92-97 → registry.tools）：`modelID`、`providerID`
  （registry.ts:288-294：webSearch 按 provider 开关、gpt 系列走 patch 工具）、`agent`
  （权限合并 Permission.merge，session/tools.ts:87-88）、`permission`
  （Permission.visibleTools 可见性）。
- 权限与工具的联动：`ctx.ask`（session/tools.ts:81-90）把工具调用转换为权限询问，
  审批挂在工具执行上下文上。

### 3.2 kimi：权限策略链

- 工具策略：`sessionToolPolicy` + `permissionGate` + `toolApproval` 分层
  （agent-core-v2/src/session/ 与 src/agent/ 对应目录）；外部 hooks 的 PreToolUse /
  PostToolUse（matcher 按工具名）在权限判定前后插入。
- 插件工具形态统一走 MCP：`mcp__<server>__<tool>` 命名（官方插件 SKILL.md 明示），
  插件本身不注册原生工具函数——工具注入完全依赖 MCP 声明。

### 3.3 Crish 现状

- `ToolMiddleware`（agent-tools/src/middleware.rs:56-96）：before_execute（Proceed 改输入 /
  Block）、on_result（Passthrough / Replace）、on_error（仅观察）；已接线，优先级
  "审批 > 中间件"（06 文档:31-52）。
- `HookRegistry` tool.pre/tool.post 与 middleware 共享点位（06 文档:96-104）。
- 缺口：
  1. **无"工具定义改写"面**——opencode 的 `tool.definition` 等价物缺失，引擎按
     (provider, model) 动态裁剪工具时插件无从参与；
  2. **registerTool 未接线**——PluginAPI.registerTool（plugin-api.ts:106-113）声明存在，
     但 engine 侧工具注册表（agent-tools 的 ToolRegistry）没有插件工具注入路径；
  3. **四维过滤链无对应**——registry 侧 providerID/modelID/agent/permission 四维
     过滤在 Crish 只有审批一维（PermissionVerdict），工具可见性按模型动态开关未定义；
  4. `tool.error`（第 14 钩子，保留 ToolHook.onError 控制能力）与 Rust 侧
     on_error"仅观察"不一致——Rust 的 on_error 不能改写错误或转 retry 信号。

### 3.4 差距 / 可借鉴点

- **优先补 tool.definition 等价面**（价值最高，见 Top 10 第 1 条）：在 Crish 工具清单
  构建点（引擎给 provider 发工具 schema 前）加一个 transform 面，中间件/插件可改
  description 与 parameters；Rust 侧可作为 ToolMiddleware 的第 4 钩子
  `on_definition` 或独立 trait 方法。
- **四维过滤链**可借鉴 opencode 的"生成时过滤"（registry.ts:286-298）而非"注册时
  过滤"——Crish 的 agent-tools 工具注册表只有静态定义，需要补"按 providerID/modelID
  动态裁剪"的入口，与 tool.definition 面共享同一个构建点。
- **tool.execute.after 的输出归一契约**（{title, output, metadata}）值得抄：Crish 的
  ToolPostPayload 只有 output/ isError/ durationMs，没有 title/metadata 位
  （hooks.rs:71-78）——插件审计类中间件（如记录工具用途）需要 title。
- kimi 的"插件工具统一 MCP"模式适合 Crish 做**插件工具的第二形态**（声明 mcp 服务器
  即可，无需代码），与 registerTool 代码形态并存。

---

## 主题四：上下文 / 系统提示词注入

### 4.1 opencode：System Context 代数

（`reference/opencode/packages/core/src/system-context/index.ts`，全文 320 行，是
Crish C10 最直接的理论参考）

- `Source<A>`（index.ts:32-39）：`key`（命名空间 Key，index.ts:22-24 正则约束
  `域/名字`）、`codec`（Schema 编解码）、`load`（观测源）、`baseline(current)`（基线渲染）、
  `update(previous, current)`（增量渲染）、`removed?(previous)`（移除渲染）。
- `make`（index.ts:135-173）：把类型化源闭包为**不透明 SystemContext**，隐藏值类型，
  统一与别的源组合；`combine`（index.ts:176-180）顺序组合 + 重复 Key 立即报错
  （DuplicateKeyError，index.ts:91-97）。
- 三阶段语义（index.ts:197-291）：
  - `initialize`（index.ts:198-206）：观测全部源 → 任一 unavailable → `InitializationBlocked`
    错误（缺源时宁可阻塞不构造残缺基线）；
  - `reconcile`（index.ts:218-280）：与上一代 Snapshot 比对（等价判断走 codec
    的 toEquivalence，index.ts:138），产出 `Unchanged | Updated{text, snapshot} |
    Replace`；
  - `replace`（index.ts:283-291）：重建完整代数；若已承认的源 unavailable →
    `ReplacementBlocked`（等待而非静默降级）。
- Snapshot（index.ts:49-57）：持久化的结构化比对状态 `{ value, removed? }`——代际
  diff 不需要重放历史消息。
- 内置源：`core/instructions`（instruction-context.ts:20-89，AGENTS.md 向上发现 +
  global config AGENTS.md）、`core/environment`、`core/date`、`core/builtins`
  （builtins.ts:26-42）；注册表 `SystemContextRegistry.register` 允许新源注册。
- 消费：session/prompt.ts:1257-1280 组装 system（skills + env + instructions +
  mcpInstructions + modelMsgs），压缩不触碰 system 段（AGENTS.md 指引 "Keep durable
  prompt admission separate"）。

### 4.2 kimi：prompt / skill 注入

- 会话启动注入：manifest `sessionStart.skill`（manifest.ts:227-245），每次会话开始注入
  skill 内容（`enabledSessionStarts()`，plugin.ts:60）；
- 技能目录注入：`pluginSkillSource` 优先级 5（pluginSkillSource.ts:27-29，builtin 之上、
  user/workspace 之下，同名冲突项目级优先）；
- 工具注入即 MCP 描述注入（mcpServers 声明 → 会话 MCP 客户端）；
- 压缩：PreCompact/PostCompact 外部钩子可观测压缩（types.ts:16-17），但没有
  "压缩后重注入"的独立预算概念。

### 4.3 Crish 现状（C10）

- C10 规格（docs/multi-agent-repair/04-Agent功能需求设计.md:310-329）：
  - 重注入：MCP 工具集 / skill 内容 / agent 定义在**每次上下文构建时重新读取**并注入
    压缩后形态，**不与会话历史共享压缩预算**；
  - 独立性：system 段字节级一致（同一配置两次构建 system 段字节相同，可断言）；
  - 实装点：`apps/agent-workbench/src-tauri/src/engine.rs:218-233`（build_context，
    system_prompt 现为 None）；注入读取面 `agent-tools/src/mcp/bridge.rs`、
    `fs_commands/skills.rs`。
- 现状：C10 是需求设计，未实装；无插件可注册自定义上下文源的面。

### 4.4 差距 / 可借鉴点

- **opencode 的 Source 代数与 Crish C10 是同一件事的两个抽象层次**：C10 定义了
  "重注入 + 独立预算 + 字节一致"的产品语义；opencode 定义了实现代数（观测 →
  基线/增量渲染 → snapshot 比对 → replace 阻塞）。C10 实装时直接映射：
  - `load` ↔ 每次构建重读 MCP/skill/agent 定义；
  - `baseline/update` ↔ 注入结构的"压缩后形态"渲染（C9 摘要模板输出）；
  - `snapshot` ↔ C10 的字节一致性断言机制（同一配置两次构建字节相同 =
    baseline 幂等）；
  - `unavailable → InitializationBlocked` ↔ C10 禁用开关语义的反面（不静默注入残缺
    上下文）。
- **可扩展点**：opencode 的 registry 允许插件注册自定义系统上下文源（如
  instruction-context 是内置源之一）。Crish 可给 PluginActivationApi 预留
  `registerSystemContext`（或先不做，C10 落地后再开面——避免第一代插件运行时同时
  承担太多扩展点）。
- kimi 的 `sessionStart.skill` 是"轻量重注入"先例：Crish 的 `session.start` 钩子
  （14 钩子之一）可承载等价语义，插件通过 observe/on 注入会话开场内容。

---

## 主题五：官方插件形态

### 5.1 参考项目先例

- **kimi：官方插件 = 纯声明包**（`plugins/official/kimi-datasource/`）：
  `kimi.plugin.json`（mcpServers + interface）+ `SKILL.md`（使用说明书）+ 配套 bin 脚本；
  `plugins/marketplace.json` 是官方市场索引。官方插件与第三方插件同一条 manifest /
  安装/更新管线（github-resolver + manager），无特权代码路径。
- **opencode：官方能力 = 内置插件函数**（plugin/index.ts:65-82）：Codex / Copilot /
  Gitlab / Xai 等 auth 插件直接 import 进进程，与 npm 插件同一 Hooks 契约；
  `plugin/openai/codex.ts` 是官方 ChatGPT/Codex 集成插件。**"第一方能力用插件形态
  分发"是 opencode 的既定做法**。
- **Claude Code**：hooks 外部命令形态，官方 hooks 文档即插件生态入口（本仓库
  reference/claudeCode 目录可对照）。
- **对话导入/迁移类插件先例：两个参考项目都没有**。kimi 有 `sessionExport`
  （app/sessionExport，导出），opencode 有 share 能力（packages/opencode/src/share），
  但都是宿主内置功能，未插件化。**结论：Crish 把导入做成官方插件是生态首创**，
  无直接先例，形态上可组合参考上面两种。

### 5.2 Crish 现状与建议形态

- 拟插件化的资产：`apps/crish-desktop/src/api/import/` 纯函数层——
  `parseClaudeCodeJsonl.ts`（Claude 会话解析）、`parseCodexRolloutJsonl.ts`（Codex
  解析）、`mapToCrishSession.ts`（映射为 SessionMessage）、`detectExternalSessions.ts`
  （检测）、`importSessions.ts`（导入编排）、`importFsHost.ts` / `importRootSettings.ts`
  （宿主接口），全部有测试（6 个 *.test.ts）。
- 建议形态（两步拆分）：
  1. **解析/映射纯函数 → 插件包**（无宿主依赖，天然满足 plugin-sdk 的纯函数面）；
  2. **宿主侧导入编排**（scan/detect/importFsHost）暂留应用层，插件只暴露
     `parse*` + `map*` 能力（manifest.declaredHooks 可声明 `session.start` 或自定义
     命令），避免第一代插件运行时必须承载 UI/文件系统能力。
- 命名参考：manifest 支持 `declaredAgents`（shared-types/src/plugin.ts:46），导入插件
  可顺带声明"导入助手"子代理——这是 Crish 相比两个参考项目独有的差异化点。

---

## 专项评估：Crish 生态起步三步走

> 拟议路线：步 1 插件运行时 → 步 2 hook 桥 → 步 3 官方插件试点。逐步骤评估合理性、
> 参考实现与坑。

### 步 1：插件运行时（TS 面收口 + Rust 引擎接线）

**评估：方向成立，但范围建议收敛为"两件事"。**

1. **TS 面收口**：plugin-sdk 的 loader/store/trust-gate 已补测试，但存在两个已知
   结构问题须先解决：
   - plugin-sdk manifest 与 shared-types manifest 双轨（plugin-api.ts:40-45 注释明示）——
   建议以 shared-types 为准收敛，否则官方插件打包时类型漂移不可避免；
   - `HookMode` / `HookFailStrategy` / `timeoutMs` 字段（shared-types/src/hooks.ts:73-79）
   与 Rust 侧只有 failStrategy 对齐（hooks.rs:127-135），其余未接入。
2. **Rust 引擎接线**：从 3 事件扩到 14 事件的前提是**事件桥**（见步 2），而非逐个
   接线——否则每扩一个事件都要改 session-loop 内部，违背 06 文档的"骨架 + 后续轮
   加变体"意图（hooks.rs:5-7 注释）。

**参考实现**：opencode loader 的三段管线与逐阶段错误报告（loader.ts:86-192）；
kimi manifest 的路径逃逸校验（manifest.ts:162-225）补 TrustGate。

**坑**：
- opencode 明确踩过"动态 import 失败被 Bun 缓存"（loader.ts:207）——Tauri webview /
  Node 环境要提前验证动态 import 失败的重试语义，file 插件一次失败后重试是否
  缓存同样适用；
- kimi 用"不支持的运行时字段打 info"（manifest.ts:131-142）做前向兼容——Crish 若
  Phase 2 放开 npm origin，manifest 校验器需要有类似的未知字段降级策略，否则老插件
  报错即失败。

### 步 2：hook 桥（24 引擎事件 → 14 钩子）

**评估：这是三步里最关键的一步，也是当前缺口最大的一步。**

- 需要的产物：
  1. **映射表文档**：24 引擎事件（events.ts 六域）→ 14 钩子事件（manifest.ts:22-57）
     的双向映射（含"哪些引擎事件没有钩子对应、哪些钩子没有引擎事件源"），
     并冻结为测试（仿照 `hookPayloadMap` 类型层面的对应）；
  2. **Rust 侧事件源补齐**：model.beforeRequest/afterResponse 接
     `crates/agent-provider/src/events.rs`；context.compact.* 接 compression 域；
     session.start/end、subagent.start/end 接 orchestrator；
  3. **observe/on 语义落地**：observe = 广播（现有 dispatch），on = 串行 + 控制信号
     （HookControlSignal，shared-types/src/plugin.ts:77-82：continue/stop/block/
     modifiedInput/modifiedOutput）。
- **参考实现**：opencode 的 trigger 顺序执行 + 输出原地改写（plugin/index.ts:280-293）
  与 Crish 的 on 模式控制信号语义最接近；opencode 的事件订阅按实例隔离
  （plugin/index.ts:251-259）对应 Crish 的 run 级 HookRegistry 复用（hooks.rs:163-166）。
- **坑**：
  - 不要把 24 事件全量塞进插件订阅面——按 kimi 的 matcher 思路（types.ts:25-27）
    做事件细分过滤，否则插件 handler 噪声大、测试面失控；
  - 超时/abort 必须并入（06 文档:148-152 已列遗留）：kimi 的"超时默认 allow"
    （runner.ts:117）可作为 tool.pre 超时语义的默认值，符合"插件错误不应杀死 run"。

### 步 3：官方插件试点（Claude/Codex 导入）

**评估：试点对象选择合理（资产成熟：纯函数 + 测试齐全），但建议形态做一次减法。**

- 参考 kimi-datasource 形态：官方插件 = 声明包 + 文档（SKILL.md 式使用说明），
  能力挂在宿主既有机制上。导入插件的"宿主既有机制"= parse/map 纯函数注册为
  工具或命令；**第一版不要要求插件运行时支持 UI 回调**（导入进度、文件选择依赖
  前端），否则插件 SDK 被迫提前开大面。
- 参考 opencode internalPlugins 形态（plugin/index.ts:65-82）：第一版官方插件可以
  直接内置于应用（非动态加载），验证 Hooks 契约后再外置 npm 包——风险最小。
- **坑**：导入插件的 manifest 需要声明的是"工具 + 只读能力"，权限面
  （file:access 等，shared-types/src/plugin.ts:17-23）需与现有导入实现的文件访问
  半径一致（importFsHost.ts 是宿主注入的——插件化后要改成经 PluginAPI 注入，
  否则违反 plugin-api.ts 的"依赖全注入"原则，plugin-api.ts:6-8）。

### 三步总评

| 步骤 | 合理性 | 主要风险 | 前置依赖 |
| --- | --- | --- | --- |
| 步 1 插件运行时 | 高（TS 面已大半完成） | 双轨 manifest 未收敛、Tauri 动态加载语义未验证 | 无 |
| 步 2 hook 桥 | 高（价值最大） | 事件映射表无存量、on 模式控制信号与现有 HookAction 需对齐 | 步 1 的 Rust 侧激活入口 |
| 步 3 官方插件试点 | 中高 | 试点范围易膨胀（UI/FS 依赖） | 步 1 + 步 2 的注册/触发链路 |

建议微调：**步 1 与步 2 并行**（TS 面收口与事件桥互不阻塞），步 3 在步 1 完成即启动
（用内置插件形态，不等步 2 全量事件）。

---

## Top 10 借鉴点

| # | 借鉴点 | 来源（文件:行号） | 实现提示 |
| --- | --- | --- | --- |
| 1 | **tool.definition 工具定义改写面**：按 (provider, model) 生成工具清单时触发 transform | `reference/opencode/packages/opencode/src/tool/registry.ts:305-334` | Crish 在引擎发工具 schema 前加单点 transform（可先做 ToolMiddleware 第 4 钩子 `on_definition`）；与四维过滤共享同一构建点 |
| 2 | **插件加载三段管线 + 逐阶段错误报告**（install / entry / compatibility → 错误事件化） | `reference/opencode/packages/opencode/src/plugin/loader.ts:86-192`、`plugin/index.ts:194-211` | 复刻 resolve() 的 ok/err 判别联合，错误发布为 24 事件里的 runtime-error；file 插件重试语义先验证动态 import 缓存行为 |
| 3 | **System Context 代数**（Key 命名源 / baseline+update 渲染 / snapshot 比对 / unavailable 阻塞） | `reference/opencode/packages/core/src/system-context/index.ts:21-320` | C10 实装的直接理论映射：load↔重读，snapshot↔字节一致性断言，InitializationBlocked↔不静默注入残缺上下文 |
| 4 | **kimi manifest 路径逃逸校验**（`./` 前缀 + realpath + isWithin） | `reference/kimi-code/packages/agent-core-v2/src/app/plugin/manifest.ts:162-225, 465-468` | 补进 Crish trust-gate 校验链（skills/mcp 命令/cwd 三个字段同款校验） |
| 5 | **事件 matcher 细分**（hook 按模式匹配过滤，而非全量转发） | `reference/kimi-code/packages/agent-core-v2/src/agent/externalHooks/types.ts:24-31` | 24→14 桥接层做 matcher 过滤（tool.pre/tool.post 按工具名正则），不改事件面 |
| 6 | **(input, output) 双参钩子 + 顺序执行 + 输出原地改写** | `reference/opencode/packages/plugin/src/index.ts:40-42, 222-335`；`opencode/src/plugin/index.ts:280-293` | 对齐 Crish on 模式 HookControlSignal（continue/stop/block/modifiedInput/modifiedOutput 已是等价物）；顺序执行保证插件间确定性 |
| 7 | **官方插件纯声明形态 + SKILL.md 使用说明书** | `reference/kimi-code/plugins/official/kimi-datasource/kimi.plugin.json`、`SKILL.md` | 官方导入插件第一版 = 声明包 + 内置函数（internalPlugins 模式，`plugin/index.ts:65-82`），不提前开 UI 面 |
| 8 | **插件失败不杀死 run 的完整错误链**（加载失败→事件、钩子失败→降级、超时→默认放行） | `reference/opencode/packages/opencode/src/plugin/index.ts:220-249`；`kimi-code/.../externalHooks/runner.ts:72,111,117` | Crish 已定 propagate 不中断会话，缺"超时默认 allow"与"错误进事件流"两环 |
| 9 | **四维工具过滤链**（providerID / modelID / agent / permission 生成时过滤） | `reference/opencode/packages/opencode/src/session/tools.ts:92-97`、`tool/registry.ts:286-298` | Crish 工具注册表补动态裁剪入口（与借鉴点 1 同点位）；当前只有审批一维 |
| 10 | **插件技能目录优先级注入**（插件源固定优先级，同名冲突规则化） | `reference/kimi-code/packages/agent-core-v2/src/session/sessionSkillCatalog/pluginSkillSource.ts:27-33` | 对应 Crish 14 钩子 session.start / C10 的 skill 重注入；冲突优先级（project > user > plugin）先文档化再实现 |

---

## 引用文件索引

### 参考项目

| 项目 | 文件 | 关键内容 |
| --- | --- | --- |
| opencode | `packages/plugin/src/index.ts` | Plugin/Hooks/AuthHook/PluginInput 全类型（335 行） |
| opencode | `packages/plugin/src/v2/effect/plugin.ts` | v2 effect 插件定义 |
| opencode | `packages/opencode/src/plugin/loader.ts` | 三段加载管线 + 重试语义 |
| opencode | `packages/opencode/src/plugin/install.ts` | 安装 + jsonc 保注释写 config |
| opencode | `packages/opencode/src/plugin/index.ts` | 插件状态/触发/事件订阅/内置插件 |
| opencode | `packages/opencode/src/plugin/shared.ts` | npm 解析 / entrypoint 探测 |
| opencode | `packages/core/src/plugin.ts` | v2 插件生命周期（锁/Scope/失败缓存） |
| opencode | `packages/core/src/event.ts` | EventV2 事件总线（PubSub + durable replay） |
| opencode | `packages/core/src/system-context/index.ts` | System Context 代数（全文） |
| opencode | `packages/core/src/system-context/builtins.ts`、`instruction-context.ts` | 内置上下文源 |
| opencode | `packages/opencode/src/tool/registry.ts` | tool.definition 触发 / 四维过滤 |
| opencode | `packages/opencode/src/session/tools.ts` | tool.execute.before/after 包裹 |
| opencode | `packages/opencode/src/session/prompt.ts` | system 组装（:1257-1280） |
| kimi | `packages/agent-core-v2/src/app/plugin/manifest.ts` | manifest 解析 + 路径安全校验 |
| kimi | `packages/agent-core-v2/src/app/plugin/plugin.ts` | IPluginService 消费面 |
| kimi | `packages/agent-core-v2/src/app/plugin/github-resolver.ts` | 无 REST API 的 tarball + Atom SHA |
| kimi | `packages/agent-core-v2/src/app/plugin/manager.ts` | 安装/重载/物化 |
| kimi | `packages/agent-core-v2/src/agent/externalHooks/types.ts`、`runner.ts`、`configSection.ts` | 16 事件外部命令钩子 + 超时语义 |
| kimi | `packages/agent-core-v2/src/session/sessionSkillCatalog/pluginSkillSource.ts` | 插件技能优先级注入 |
| kimi | `plugins/official/kimi-datasource/` | 官方插件先例（kimi.plugin.json + SKILL.md） |

### Crish

| 文件 | 关键内容 |
| --- | --- |
| `packages/plugin-sdk/src/api/plugin-api.ts` | PluginAPI 双重校验 + 依赖注入面 |
| `packages/plugin-sdk/src/manifest/manifest.ts` | 14 钩子事件名清单 |
| `packages/shared-types/src/plugin.ts` | PluginManifest/权限/信任/激活 API |
| `packages/shared-types/src/hooks.ts` | 事件名 / HookMode / HookRegistration |
| `packages/shared-types/src/events.ts` | 24 引擎事件（六域） |
| `crates/session-loop/src/hooks.rs` | HookRegistry 3 事件 + 失败策略 |
| `crates/agent-tools/src/middleware.rs` | ToolMiddleware 三钩子 |
| `docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md` | 接线点位与优先级语义 |
| `docs/multi-agent-repair/04-Agent功能需求设计.md` | C10 系统上下文重注入规格（:310-329） |
| `apps/crish-desktop/src/api/import/` | Claude/Codex 导入纯函数层（拟插件化资产） |

---

> 本报告生成于 2026-08-03，供 improvement/ 方案系列引用。
