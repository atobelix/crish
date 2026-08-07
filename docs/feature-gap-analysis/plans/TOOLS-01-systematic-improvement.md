# TOOLS-01：crish 工具系统系统性改进方案（流式输出 / 能力元数据 / 版本化与多工具集 / schema 确定性）

> 文档类型：系统性改进方案（feature-gap analysis 系列，方案编号 TOOLS-01）
> 依据参考：grok-build（`reference/grok-build/crates/common/xai-tool-runtime`、`xai-tool-protocol`、`xai-tool-types`；`crates/codegen/xai-grok-tools`）、opencode（`reference/opencode/packages/opencode/src/session/llm/request.ts`）、codex-cli（`reference/codex-cli/codex-rs/core/src/tools/spec_plan.rs`）
> 依据现状：`crates/agent-tools/src/`（2026-08-07 全量通读）、`crates/session-loop/src/tool_exec.rs`、`crates/conex-types/src/tool.rs`、`crates/agent-provider/src/request/{tools,schema}.rs`、`crates/agent-provider/src/models/catalog.{rs,json}`
> 编写日期：2026-08-07
> 约束：本方案只做分析与设计，不落地代码；各阶段改动点均标注文件级落点与验收标准，供后续轮次拆解为任务卡

---

## 0. 方案速览（结论先行）

### 0.1 一句话定位

crish 工具系统（agent-tools）的 **Tool trait 是"一次性入参→一次性返回值"（Value→Value）**，缺少 grok-build 的流式输出（`[Progress*, Terminal]`）、能力元数据（ToolCapabilities）、工具版本化（behavior_preset）与多工具集（concise）四类机制；但确定性面（name 升序、canonicalize_schema R2.1-R2.9、tools 快照锁定）已基本对齐 opencode/codex。本方案以**四个逻辑阶段**补齐差距：阶段 1 流式输出协议（向后兼容默认方法，不引入 typed Args/Output 关联类型）、阶段 2 能力元数据（声明面取代名单面）、阶段 3 版本化与多工具集（与模型目录 v2 的 151 条 supports 位联动）、阶段 4 schema 与确定性增强（与 canonicalize_schema 衔接收口）。

### 0.2 阶段总览

| 阶段                   | 目标                                                            | 核心设计决策                                                                                                                          | 文件域                                                                                                                     | 工作量 |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| S1 流式输出协议        | ToolStream（Progress+Terminal）接入现有 Tool trait              | **新方法 + 默认实现**，不换 trait、不引入 typed Args/Output；ToolProgress 复用 `conex-types` 已预留的 `AgentEvent::ToolUpdate` 事件面 | agent-tools（definition/executor/新 streaming 模块）、session-loop（tool_exec）、conex-types（tool.rs 扩展）、orchestrator | L      |
| S2 能力元数据          | ToolCapabilities（read_only/scope/streaming/max_concurrency）   | 声明面取代 readonly.rs 名单面；消费方：权限门快路径、执行期并发信号量、前端渲染、schema 裁剪                                          | agent-tools（新 capabilities 模块/definition.rs）、tool_exec.rs、permission.rs、readonly.rs                                | M      |
| S3 版本化与多工具集    | behavior_preset + concise 集 + 模型目录 v2 联动                 | 目录 v2 **只读消费**（只增不改用户测试资产）；模型级 toolset 选择挂 `ensure_tools_snapshot` 点位；默认 `current` 全量集零行为变化     | agent-tools（新 versions 模块）、session-loop（streaming.rs）、agent-provider（catalog.json 扩展 + 消费）                  | M-L    |
| S4 schema 与确定性增强 | 注册门禁、schema 幂等校验、name 字符集、strict/tool_choice 联动 | 不引入 schemars（手工 json! schema + 注册期校验器），与 R1-R5 规则面收口                                                              | agent-tools（tools/mod.rs 注册面）、agent-provider（request/tools.rs）                                                     | S-M    |

依赖链：S1 → S2（streaming 声明字段）→ S3（behavior_version 字段）；S4 独立可与 S1-S3 并行。

### 0.3 关键决策速览

| 编号 | 决策                                                                                                                                            | 理由                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | **不换 trait 基座**：在现有 `Tool` trait 上追加带默认实现的 `execute_stream()`，默认实现 = `execute()` 结果包成单元素流                         | grok 的 typed Args/Output + schemars 需要改造全部 17 内置工具 + MCP 适配器，且引入新依赖；Value 类型擦除面（对齐 grok `ToolDyn`）已足够承载流式 |
| D2   | **流式不绕过任何既有防线**：审批、中间件 before 链、写路径互斥、幂等记录全部在"流之前/终值之后"的既有时序上操作                                 | 阶段 4 冲突分析（§4）逐条给出时序论证                                                                                                           |
| D3   | **Progress 不参与幂等键**：幂等按 Terminal 终值记录；去重命中时零 Progress 直接返回 deduplicated 终值                                           | Progress 是非确定性中间状态，进键会击穿去重语义                                                                                                 |
| D4   | **目录 v2 只读消费**：151 条 supports 位是用户测试资产，只增不改；模型级 toolset 用新增可选字段（缺省走默认全量集）                             | 防破坏既有目录测试基线（catalog.rs 校验套件）                                                                                                   |
| D5   | **多工具集 = 注册表实例面**：沿用 `filter_registry_for_task_type`（readonly.rs:102-116）既有裁剪先例，不引入 grok 的 ToolNamespace 命名空间前缀 | 前缀化会破坏既有工具名契约（前端硬依赖 tool-start.call.toolName）                                                                               |

---

## 1. 现状盘点（完整执行链）

### 1.1 抽象与注册

- **ToolDefinition（声明面）**：`crates/agent-tools/src/definition.rs:27-46`——`name / description / input_schema / dangerous / fatal_on_error`，serde camelCase，缺 schema 回退兜底形状（`default_input_schema()` definition.rs:12-18）。无能力元数据字段、无版本字段。
- **Tool trait（执行面）**：`definition.rs:139-158`——一次性 Value→Value：
  ```rust
  #[async_trait]
  pub trait Tool: Send + Sync {
      fn name(&self) -> &str;
      fn definition(&self) -> &ToolDefinition;
      async fn execute(&self, ctx: &ToolContext, args: serde_json::Value)
          -> Result<serde_json::Value, ToolError>;
  }
  ```
  幂等性由执行器外挂守卫保证（definition.rs:137-138 注释），工具自身不感知。
- **ToolError**：`definition.rs:72-132`——包一层 CrishError（`tool.not_found / tool.invalid_input / tool.execution_failed / tool.version_conflict / tool.write_path_conflict / tool.write_not_allowed` 等）。
- **ToolRegistry**：`registry.rs:22-226`——HashMap+order 保序；`register`（同名冲突 → `tool.version_conflict`）、`register_runtime`（&self 后置注册，MCP/插件用）、`get/has/list`、`list_definitions`（name 升序 + 定义改写链 on_definition，registry.rs:168-189）、`with_definition_transformers/add_definition_transformer`（E4）。
- **内置工具 17 个**：`tools/mod.rs:104-165` `register_builtin_tools_with_config`——background_task / cancel_timer / delete_dir / delete_file / diff_text / file_stat / fuzzy_find / grep_search / list_dir / multi_replace_file_content / read_file / resolve_output_dir / run_subagent / set_timer / shell_command / wait_subagents / write_file。工具会话数据经 `ToolContext` 读取（R3 T9）。
- **MCP 桥**：`mcp/bridge.rs:459+` `McpToolAdapter` 实现 `Tool`（tools/call 经适配器进统一执行器），工具名前缀 `mcp_<server>__<tool>`。

### 1.2 执行链（session-loop ToolExecutor，`crates/session-loop/src/tool_exec.rs`）

```
AgentSessionLoop (loop/mod.rs)
  └─ ProviderStreamEvent::tool_call → executing_tools handler → ToolExecutor::execute_batch (tool_exec.rs:252)
       ├─ 分组：Parallel 并行组 / Sequential/Exclusive 顺序项 (tool_exec.rs:270-286)
       ├─ 每项 execute_one (tool_exec.rs:~500)：
       │    ├─ 权限判定 call_verdict → PermissionVerdict (permission.rs decide 三态矩阵)
       │    ├─ Deny → 直接拒绝；NeedsApproval → ApprovalRequested 事件先行 → 审批门等待 (tool_exec.rs:578-644)
       │    ├─ 通过后 execute_single (tool_exec.rs:667)：
       │    │    ├─ registry.get → ToolContext 组装（ask 通道/写路径注册表/配额/产出目录，tool_exec.rs:721-752）
       │    │    ├─ middleware before_execute 链（超时竞速窗口；Block/Err/超时→阻止，tool_exec.rs:768-810）
       │    │    ├─ hooks tool.pre 广播（HookRegistry，可阻止，tool_exec.rs:813-833）
       │    │    ├─ execute_with_output_policy（executor.rs:73-134）：
       │    │    │    ├─ 幂等 check（命中 → 直接返回 deduplicated 终值，零执行）
       │    │    │    ├─ tool.execute(ctx, args)（abort-aware 超时竞速，tool_exec.rs:886-893）
       │    │    │    ├─ 输出预算 summarize 截断（output.rs summarize，contextBudget 标记）
       │    │    │    └─ 幂等 record（失败执行不记录）
       │    │    ├─ hooks tool.post 广播（成功/失败，tool_exec.rs:940-1005）
       │    │    └─ middleware on_result / on_error 链（可改写输出/仅观察，tool_exec.rs:963-1005）
       │    └─ ToolEvent::ToolEnd（含输出/错误码/耗时，tool_exec.rs:648-656）
       ├─ fatalOnError 判定 → 致命错误收场 (tool_exec.rs:645-647)
       └─ ToolEvent::BatchEnd → 事件翻译层 → AgentEvent（orchestrator/normalize.rs）
```

### 1.3 事件面（AgentEvent）

- `crates/conex-types/src/events.rs:365-407`：Tool 域事件 **tool-start / tool-update / tool-end / tool-batch-start / tool-batch-end / tool-input-repaired**。
- `ToolUpdate`（events.rs:375-382）携带 `ToolProgressUpdate`（`conex-types/src/tool.rs:140-153`：`text / json / metadata` 三可选字段）——**已预留但生产代码零发射**（仅测试与 normalize.rs:360 存在）；前端契约注释明确 `update.metadata.kind === 'tool-args-delta'` 为预留消费面。这是阶段 1 的天然出站通道。
- 事件信封（runId/sequence/schemaVersion）由 emit 层统一注入（events.rs:901+），新增事件类型零成本扩展。

### 1.4 防线设施（阶段 4 冲突分析的对象）

| 设施       | 位置                                     | 语义                                                                                                                                   |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 权限三态   | permission.rs:78-151                     | decide / decide_with_redline（红线先行，full-access 不豁免）/ decide_command / decide_command_with_revert（C3 大面积回退门禁）         |
| 中间件链   | middleware.rs:95-146 + tool_exec.rs 接线 | on_definition（同步改写）/ before_execute / on_result / on_error，超时竞速 2000/2000/1000ms                                            |
| 写路径互斥 | write_paths.rs:310-419                   | WritePathRegistry 声明+TTL+同持有者豁免；T-D-08 硬沙箱（check_write_allowance_for_ctx 先于 claim_write_guard，write_paths.rs:458-475） |
| 自动备份   | backup.rs:51-153                         | BackupMiddleware before_execute 写前快照进回收站域，失败即 Block                                                                       |
| 幂等守卫   | idempotency.rs:108-309                   | check/record/clear，域=run:session，键=工具名+参数规范 hash / snapshotTag + 存在性探针（executor.rs:145-170）                          |
| 只读裁剪   | readonly.rs:56-116                       | WRITE_TOOL_NAMES/READONLY_TOOL_NAMES 名单 + filter_registry_for_task_type 六类型默认集（fail-closed）                                  |
| 探索配额   | explore_quota.rs + context.rs:139-150    | 只读子代理每会话至多写 1 份文档                                                                                                        |

### 1.5 请求构造面（确定性现状）

- **快照锁定**：`session-loop/src/loop/handlers/streaming.rs:326-337` `ensure_tools_snapshot`——run 内一次从 `list_definitions()` 构建 `ToolSchema` 快照（provider.rs:99-117），轮次间复用保证前缀字节稳定。
- **确定性排序**：`registry.rs:168-174` name 按 UTF-8 码点升序（P6 §3.1 R1，String::cmp，禁 localeCompare）——对齐 opencode request.ts:184（`toSorted(localeCompare)`）的确定性目标且更强（码点序跨环境稳定）。
- **schema 规范化**：`agent-provider/src/request/schema.rs:38-80` `canonicalize_schema`（R2.1-R2.9：type 数组收敛、properties/required 排序、const→enum、$ref 叶子、固定键序）——在克隆上做，不污染注册表（request/tools.rs:42-53 注释）。`to_openai_tool` / `to_responses_tool`（strict:false）双出口单点接线。
- **工具级缓存断点**：`to_cache_aware_tool`（request/tools.rs:79-87）仅最后一个工具附加 cache_control（Anthropic 系断点）。

### 1.6 模型目录 v2

- `crates/agent-provider/src/models/catalog.json`：schema "2.0"，151 条（OpenAI 34 / Anthropic 11 / 御十家，catalog.rs:663），能力位含 `supportsFunctionCalling / supportsParallelFunctionCalling / supportsToolChoice / supportsSystemMessages / supportsResponseSchema / supportsComputerUse` 等。
- 消费面：`catalog.rs` 的 ModelCatalog 查询（supports_*_for）+ behavior.rs 缓存语义；**当前无"按模型选择工具集"的消费**——tools 数组无条件全量下发（supportsFunctionCalling=false 的模型也会收到 tools，真实缺口）。

---

## 2. 差距分析（vs grok-build / opencode / codex）

### 2.1 参考实现要点

**grok-build（重点参考）**：

- `xai-tool-runtime/src/tool.rs:36-112`：`Tool` trait 带关联类型 `Args: Deserialize + JsonSchema` / `Output: Serialize + ToolOutput`；`execute(ctx, args: Self::Args) -> impl Future<Output = ToolStream<Self::Output>> + Send`（RPITIT，非 async_trait）；默认实现包 `run()` 为单元素流（tool.rs:87-96）；`ToolDyn` 类型擦除面（tool.rs:336-402）Value 入参 → `ToolStream<TypedToolOutput>`。
- `ToolStream<T> = Pin<Box<dyn Stream<Item = ToolStreamItem<T>> + Send>>`；`ToolStreamItem = Progress(ToolProgress) | Terminal(Result<T, ToolError>)`（tool.rs:116-133）；流不变式：任意多 Progress、恰好一个 Terminal 且恒为末项。
- `ToolProgress = Text{text} | Content{blocks} | Custom{subkind,payload}`（tool.rs:137-153）；helper `terminal_only` / `with_progress`（tool.rs:206-227）。
- `xai-tool-protocol/src/capabilities.rs:9-51`：`ToolCapabilities { streaming: Option<StreamingSpec{subkind, max_delta_bytes}>, supports_cancel, max_concurrency, is_read_only, hooks, behavior_version, max_frame_bytes, timeout_ms, tool_scope: Option<ToolScope{Read|Write}> }`——全默认保守（无流式/不可取消/单并发）。
- `xai-grok-tools/src/versions.rs`：`behavior_preset` 目录（current / legacy-0.4.10 / release-x 预置集），`TOOL_VERSION_REGISTRY`（7 个受管工具），生命周期 Active/Deprecated/RemovalCandidate，`resolve_version_with_warnings`（per_tool_override > preset.tool_defaults > current；未受管工具 None）。
- 多工具集：`ToolNamespace`（GrokBuild / GrokBuildConcise / GrokBuildHashline / Codex / OpenCode / MCP，types/tool.rs:20-46）；concise 集 = 共享实现 + 紧凑输出（implementations/grok_build_concise/）。
- `should_list(ctx)` 每轮动态裁剪（tool.rs:75-77）+ `has_dynamic_description`。

**opencode**：工具按名确定性排序（request.ts:184）；OpenAI Responses 族硬编码 `strict:false`（request.ts:149-158，兼容 MCP/动态 schema）；权限 + 用户配置过滤 `resolveTools`（request.ts:208-214）。

**codex-cli**：`spec_plan.rs` 启动期确定性注册（显式 spec 表，PlannedTools 顺序固定）；ToolExposure 分级曝光。

### 2.2 差距表

| 维度          | crish 现状                                                     | grok-build                                                                                                                           | opencode / codex                  | 差距级别                                              |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------- |
| 流式输出      | 无（execute 一次性返回；`ToolUpdate` 事件面已预留但零发射）    | `[Progress*, Terminal]` 流 + ToolDyn 类型擦除                                                                                        | —（TS 侧无等价物）                | **大**：长命令/大读盘期间前端全黑，模型零中间反馈     |
| 能力元数据    | 无（dangerous 布尔 + readonly 名单硬编码 readonly.rs:30-46）   | ToolCapabilities 全字段（is_read_only / tool_scope / max_concurrency / streaming / supports_cancel / behavior_version / timeout_ms） | Permission 系统（禁用面）         | **大**：并发控制、权限门、渲染、裁剪全是名单/无声明面 |
| 工具版本化    | 无（tool.version_conflict 仅防重名）                           | behavior_preset + 每工具版本注册表 + 生命周期                                                                                        | —                                 | **中**：无 legacy 回退/无合约演进手段                 |
| 多工具集      | task_type 六类型默认集（readonly.rs:102-116，已先例）          | ToolNamespace 命名空间（concise/hashline/codex 集）                                                                                  | agent 级 tools 过滤               | **中**：缺"同一工具不同实现变体"与模型级选择          |
| 模型能力联动  | 无（tools 全量下发，无视 supportsFunctionCalling=false）       | —                                                                                                                                    | provider 级能力表                 | **中**：151 条 supports 位未被工具面消费              |
| schema 生成   | 手工 json!（17 处）                                            | typed Args + schemars 自动生成                                                                                                       | AI SDK jsonSchema                 | **小-中**：手工 schema 缺类型联动与注册期校验         |
| schema 确定性 | canonicalize_schema R2.1-R2.9 + name 升序 + 快照锁定（已落地） | —（协议层 proto 生成）                                                                                                               | localeCompare 排序 + strict:false | **无差距**（R1-R5 已覆盖；比 opencode 更强：码点序）  |
| 执行期并发    | 仅按 call.concurrency 分组（Parallel/Sequential/Exclusive）    | 每工具 max_concurrency 声明                                                                                                          | —                                 | **中**：并行组内无每工具并发上限                      |
| 取消          | abort_token 检查点 + drop 即取消（tool_exec.rs:884-893）       | supports_cancel 声明 + hook Cancel                                                                                                   | 中断语义                          | **小**：机制已有，缺声明面                            |

---

## 3. 改进方案设计（四阶段）

### 3.1 阶段 1：流式输出协议（S1）

#### 3.1.1 目标

引入 grok 的 `[Progress*, Terminal]` 流式执行面，让 shell_command（长命令）、read_file（大文件分段）等工具在**执行期间**向前端推送增量；既有 16+ 工具零改动、行为逐字节不变。

#### 3.1.2 设计裁决：新 trait 还是向后兼容包装？

**裁决：不新建 trait 基座，在现有 `Tool` trait 上追加带默认实现的 `execute_stream()`（D1）**。理由：

1. 现有 `Tool` 是 `dyn` 对象（`Arc<dyn Tool>` 注册表），grok 的 typed Args/Output 关联类型 + RPITIT 会破坏 dyn 兼容性（grok 为此单独造了 `ToolDyn` 类型擦除层——相当于把现有 17 工具 + MCP 适配器全部重写一遍 + 引入 schemars 依赖）；
2. crish 已有 `ToolDyn` 等价物：`execute(ctx, args: Value) -> Result<Value, ToolError>` 本身就是 Value 擦除面，只差"流的形状"；
3. 默认实现 = `execute` 结果包成单元素流（等价 grok tool.rs:87-96 的默认 execute 包 run），旧工具天然升级。

**结论：方法级默认实现 + 可选 override，不用新 trait。**

#### 3.1.3 接口设计（Rust 类型签名）

新增 `crates/agent-tools/src/streaming.rs`（对齐 grok xai-tool-runtime/src/tool.rs 的流形状，但值类型为 `serde_json::Value`）：

```rust
// streaming.rs —— 流式工具输出协议
use futures_core::Stream;

/// 一次工具调用产生的流：任意多 Progress，恰好一个 Terminal 且恒为末项。
pub type ToolStream = Pin<Box<dyn Stream<Item = ToolStreamItem> + Send>>;

/// 流中一项
pub enum ToolStreamItem {
    /// 中间进度（零或多个）
    Progress(ToolProgress),
    /// 终值（恰好一个，恒为末项）
    Terminal(Result<serde_json::Value, ToolError>),
}

/// 开放式进度载荷（对齐 grok ToolProgress；序列化 tag="kind" snake_case）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolProgress {
    /// 自由文本增量（stdout 块、日志行）
    Text { text: String },
    /// 富内容块（预留：图片/资源，阶段 1 只定义类型不实现）
    Content { blocks: Vec<ContentBlock> },
    /// 工具自定义进度（subkind 为工具自有稳定判别符）
    Custom { subkind: String, payload: serde_json::Value },
}

/// 单元素流（默认实现的构造助手）：terminal_only(result)
pub fn terminal_only(result: Result<serde_json::Value, ToolError>) -> ToolStream;
/// 进度流 + 终值：with_progress(progress: impl Stream<Item = ToolProgress>, terminal: impl Future<Output = Result<serde_json::Value, ToolError>>) -> ToolStream
pub fn with_progress<P, F>(progress: P, terminal: F) -> ToolStream
where
    P: Stream<Item = ToolProgress> + Send + 'static,
    F: Future<Output = Result<serde_json::Value, ToolError>> + Send + 'static;
```

`definition.rs` 的 `Tool` trait 追加（带默认实现，既有 impl 零改动）：

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn definition(&self) -> &ToolDefinition;

    /// 一次性执行（既有面，保持不变；流式工具亦实现，供非流式消费者取聚合终值）
    async fn execute(&self, ctx: &ToolContext, args: serde_json::Value)
        -> Result<serde_json::Value, ToolError>;

    /// 流式执行（S1 新增；默认实现 = execute 结果包单元素流，旧工具零改动）。
    /// 流不变式：任意多 Progress、恰好一个 Terminal 且恒为末项；
    /// 实现须自查 ctx.abort_token（abort 后停止推送并尽快收口）。
    async fn execute_stream(&self, ctx: &ToolContext, args: serde_json::Value) -> ToolStream {
        terminal_only(self.execute(ctx, args).await)
    }
}
```

说明：`execute_stream` 返回 `ToolStream`（Pin<Box<dyn Stream>>）而非 grok 的 RPITIT——`dyn Tool` 需要装箱，且避免 async_trait 与 RPITIT 混用。

#### 3.1.4 执行器改造（executor.rs）

`execute_with_output_policy` 增加流式消费路径（新函数 `execute_stream_with_output_policy`，旧函数保持不动供直连调用方使用）：

```rust
/// S1：流式执行 + 输出策略 + 幂等 + 进度回调
pub async fn execute_stream_with_output_policy(
    tool: &dyn Tool,
    args: Value,
    tool_ctx: &ToolContext,
    ctx: &ExecutorContext,
    guard: Option<&ToolIdempotencyGuard>,
    policy: &ToolExecutionPolicy,
    progress: Option<Arc<dyn Fn(ToolProgress) + Send + Sync>>,   // 进度转发回调（None = 丢弃 Progress）
) -> Result<ToolResult, ToolError>;
```

流程（与旧路径的差异点）：

1. 幂等 check：**命中 → 返回 deduplicated 终值且零 Progress**（D3：Progress 不参与幂等键，见 §4.3）；
2. 消费流：`while let Some(item) = stream.next().await`——Progress → 经 `progress` 回调转发（并做累计字节预算，见 §4.4）；Terminal → 取终值，走既有 summarize 截断；
3. 幂等 record：与旧路径一致（失败/中断不记录）。

#### 3.1.5 事件衔接（与 AgentEvent）

- **出站映射**：Progress 经 `progress` 回调 → 执行器转 `ToolEvent::ToolProgress`（tool_events.rs 新变体）→ 事件翻译层映射为 `AgentEvent::ToolUpdate`（events.rs:375-382 已存在，`ToolProgressUpdate{text/json/metadata}` 形状已冻结）：
  - `ToolProgress::Text{text}` → `ToolProgressUpdate{ text: Some(text), json: None, metadata: Some({"kind":"tool-progress"}) }`；
  - `ToolProgress::Custom{subkind, payload}` → `json: payload` + `metadata: {"kind": subkind}`（与前端预留的 `metadata.kind === 'tool-args-delta'` 消费面同槽位扩展，前端契约 `contracts/engine-events.json` 登记新 kind 字面量）；
  - `ToolProgress::Content` → 阶段 1 仅类型定义，`metadata.kind === 'content-blocks'` 预留。
- **时序契约**：`tool-start → tool-update* → tool-end`（对齐既有 ToolEvent 序列头注 tool_events.rs:3-6）；ToolUpdate 的 batch_id/tool_call_id 字段已有（events.rs:376-381），无契约破坏。
- **前端消费**：ToolEnd 终值仍是模型回投的唯一来源（ToolUpdate 是展示面，不进消息历史——避免污染对话缓存前缀，对齐 P1 前缀稳定原则）。

#### 3.1.6 首个流式工具：shell_command

`tools/shell.rs` 的 `execute` 拆出流式实现：`async fn execute_stream` 用 tokio process 逐行/逐块读 stdout/stderr（async read），每块 `ToolProgress::Text` 推送，进程退出后 Terminal 返回聚合结果（含既有 output/json 形状，保持工具返回契约不变）。`maxOutputBytes` 语义升级为**累计流式字节预算**：超限停止推送并标记 truncation（与现状 200KB 上限一致，只是从"事后截断"变"实时截断"）。

#### 3.1.7 兼容策略

- 旧工具（16+ MCP 适配器）：不实现 `execute_stream` → 默认实现包 `execute`，行为与现状逐字节一致；
- 旧消费方：直连 `execute` / `execute_with_output_policy` 路径不动；`Tool` trait 新增方法为默认实现，**非破坏性 trait 扩展**（Rust 允许，无 semver 问题）；
- `ToolError`、ToolDefinition 不变。

#### 3.1.8 验收

- 单元：`terminal_only`/`with_progress` 形状与不变式（Progress 前、Terminal 恒末项）；默认实现包 execute 行为等价旧路径（字节断言）；
- 集成：shell_command 长命令（如 `npm run build`）mock 流式输出逐块出站 ToolUpdate 事件，事件序 tool-start → tool-update* → tool-end；
- 回归：既有 17 工具经 execute_stream 消费路径输出与旧路径一致（快照/字节测试）；
- 幂等：流式工具同参二次调用 → deduplicated 终值、零 Progress；
- abort：流中途 abort → 流被 drop（对齐现状 drop 即取消），已发 Progress 保留。

#### 3.1.9 依赖 / 测试策略 / 工作量

- 依赖：`futures-core`（或 `tokio-stream`，按 Cargo.toml 现有依赖选型）进 agent-tools；
- 测试策略：agent-tools 单测（流形状/预算）+ session-loop 集成（事件序/abort）+ orchestrator 事件映射；
- 工作量：**L**（约 3 个 crate 的改动面 + shell 流式改造 + 事件接线）。

---

### 3.2 阶段 2：能力元数据（S2）

#### 3.2.1 目标

补齐 grok `ToolCapabilities` 的声明面，替代硬编码名单（readonly.rs:30-46），为权限门、并发控制、前端渲染、tools schema 裁剪提供单一事实源。

#### 3.2.2 接口设计

新增 `crates/agent-tools/src/capabilities.rs`：

```rust
/// 工具能力声明（对齐 grok ToolCapabilities 子集；全默认保守）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCapabilities {
    /// 只读标记：不修改外部状态（等价 grok is_read_only；对应 WRITE_TOOL_NAMES 名单迁移面）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
    /// 多代理写协调作用域（对齐 grok tool_scope；缺省 Read）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ToolScope>,
    /// 流式声明（S1 工具填写；缺省 None = 不产生 Progress）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<StreamingSpec>,
    /// 工具接受的并发调用上限（None = 不限；消费方：执行期信号量）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<u32>,
    /// 单次调用超时覆盖（毫秒；None = 用批级 options.timeout）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// 行为版本（S3 消费；None = current）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolScope { Read, Write }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingSpec {
    /// 稳定 snake_case 判别符（如 "bash_output_chunk"）
    pub subkind: String,
    /// 单帧 delta 字节上限（UTF-8 安全；缺省运行时 16 KiB）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_delta_bytes: Option<u32>,
}
```

`Tool` trait 追加默认方法 + `ToolDefinition` 增加序列化字段：

```rust
pub trait Tool: Send + Sync {
    // ……既有 name/definition/execute/execute_stream……
    /// 能力声明（S2；默认全保守，旧工具零改动）
    fn capabilities(&self) -> ToolCapabilities { ToolCapabilities::default() }
}

// ToolDefinition 增加（serde default + skip_serializing_if，wire 向后兼容：
// 旧序列化不含该键，新序列化缺失时反序列化回默认）
#[serde(default, skip_serializing_if = "Option::is_none")]
pub capabilities: Option<ToolCapabilities>,
```

#### 3.2.3 消费方落点

| 消费方            | 落点                                                              | 改动                                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 权限门快路径      | `permission.rs` decide 族                                         | `read_only == true` 的调用在 plan 模式直接 Allow（对齐现状"非危险放行"语义）；`scope == Write` + dangerous → 三态矩阵不变。**行为等价性护栏**：迁移后 `readonly.rs` 名单版与 capabilities 版断言一致（双实现并存期）                       |
| 并发控制          | `tool_exec.rs` 并行组                                             | 组内按工具 `max_concurrency` 分槽（tokio Semaphore per tool）：shell_command max_concurrency=1（现状顺序语义硬化）、read_file 等高并发工具不设限。与 call.concurrency 分组的关系：**分组决定批语义，能力元数据决定执行期并发上限**（§4.6） |
| tools schema 裁剪 | `registry.rs` list_definitions 改写链点位 + streaming.rs 快照点位 | 新增按 capabilities 过滤（read_only 集/streaming 集）——与 E4 on_definition 链共享构建点，空过滤 = 现状                                                                                                                                     |
| 前端渲染          | AgentEvent::ToolStart / ToolUpdate                                | 按 streaming 声明决定渲染"实时输出"面板；ToolStart 载荷可带 capabilities 子集（新可选字段）                                                                                                                                                |
| 名单迁移          | `readonly.rs`                                                     | READONLY_TOOL_NAMES/WRITE_TOOL_NAMES 保留为**兼容断言**（测试校验名单 ⊆ capabilities 派生结果），逻辑面迁移到 capabilities                                                                                                                 |

#### 3.2.4 兼容策略与验收

- 兼容：ToolDefinition 新字段 `skip_serializing_if`（wire 字节对旧工具不变，回归护栏测试）；消费方全部"声明缺省 = 现状行为"（未装配 capabilities 的工具走名单回退，直至迁移完成）；
- 验收：17 个内置工具逐一声明正确 read_only/scope/streaming；plan 模式判定迁移后与名单版行为一致（全模式回归矩阵）；并发信号量生效（shell_command 同批并行调用退化为串行且结果等价）；tools 数组按 streaming 声明裁剪正确。
- 工作量：**M**（依赖 S1 的 streaming 声明字段，可并行起能力表登记）。

---

### 3.3 阶段 3：工具版本化与多工具集（S3）

#### 3.3.1 目标

引入 grok 的 behavior_preset 版本目录与"同一工具多实现变体"能力；与模型目录 v2 的 151 条 supports 位联动，实现模型级工具集选择（小模型用精简集、无工具能力模型零 tools）。

#### 3.3.2 版本化目录（对齐 grok versions.rs 子集）

新增 `crates/agent-tools/src/versions.rs`：

```rust
/// 行为版本生命周期（对齐 grok BehaviorLifecycle）
pub enum BehaviorLifecycle { Active, Deprecated, RemovalCandidate }

/// 受管工具注册表条目（name → 支持版本列表）
pub struct ToolVersionEntry { pub tool_name: &'static str, pub versions: &'static [VersionLifecycle] }

/// 预置集（bundle）：label → 每工具默认版本（缺省 current）
pub struct PresetEntry { pub name: &'static str, pub lifecycle: BehaviorLifecycle, pub tool_defaults: &'static [(&'static str, &'static str)] }

/// 解析：per_tool_override > preset.tool_defaults > "current"；未受管 → None
pub fn resolve_version(preset: &str, tool_name: &str, override_v: Option<&str>) -> Result<Option<String>, String>;
```

初始目录：`MANAGED_TOOLS = []`（阶段 3 只搭目录骨架 + 解析器 + 测试套件，暂无 legacy 版本需重建——比 grok 更保守）；`PRESETS = [current]`。语义：preset 未知 → Err；RemovalCandidate → Err；Deprecated → warn + 继续（对齐 grok versions.rs:356-434）。

#### 3.3.3 多工具集（concise 集）

- **模型**：沿用 `filter_registry_for_task_type`（readonly.rs:102-116）的"注册表实例裁剪"先例（D5，不引入 ToolNamespace 前缀——避免破坏前端硬依赖的 toolName 契约）。
- **concise 集定义**：新模块 `tools/concise/`，为 read_file / write_file / shell_command 提供"精简输出"变体（共享既有实现的核心逻辑 + 紧凑格式，对齐 grok grok_build_concise 的共享 impl 模式）：描述更短、输出更紧凑、错误文案精简。注册面：`register_concise_tools(registry)` 独立注册函数，产出精简注册表实例。
- **选择器**：`crates/agent-tools/src/toolsets.rs`（新）——`select_toolset(registry, model_capability) -> ToolRegistry`：
  - 全量集（默认）↔ concise 集 ↔ 只读集（复用 filter_registry_for_task_type）；
  - 只读选择器与既有 task_type 裁剪的关系：**task_type 先裁、model toolset 再裁**（两者均为注册表实例面，串行组合）。

#### 3.3.4 与模型目录 v2 联动（只读消费，D4）

- **catalog.json 扩展**（可选新字段，缺省兼容）：
  - 模型级 `toolset`（"full" | "concise" | 缺省 full）；
  - 模型级 `behaviorPreset`（缺省 "current"）；
  - 消费 `supportsFunctionCalling` / `supportsParallelFunctionCalling`（已有字段，不新增）。
- **catalog.rs**：新增查询 `toolset_for(vendor, model)` / `behavior_preset_for(vendor, model)`，缺省值回退；既有 151 条 supports 位与测试基线**零改动**。
- **引擎接线**：`session-loop/streaming.rs:326-337` `ensure_tools_snapshot` 改造——按当前模型能力选择注册表实例再取快照：
  - `supportsFunctionCalling == false` → tools 数组为空（修复 §1.6 缺口）；
  - `toolset == concise` → concise 注册表实例；
  - `behaviorPreset` → 解析后经 `ToolCapabilities.behavior_version`（S2 字段）透传（现阶段仅透传，工具侧按版本分支留到有 legacy 需求时实现）。
- **快照前缀稳定**：同一 (model, session) 组合 run 内锁定不变（现状语义保持）；模型切换 = 新 run 新快照。

#### 3.3.5 兼容策略与验收

- 兼容：默认模型（未配置 toolset/behaviorPreset）走全量集 + current，行为与现状逐字节一致；catalog.json 扩展字段反序列化缺省兼容（`#[serde(default)]`）；
- 验收：目录 v2 全部既有测试不破坏；supportsFunctionCalling=false 模型 tools 数组为空（快照断言）；concise 集注册表实例可装配且输出紧凑（样例断言）；resolve_version 解析器全分支测试（unknown preset/override 拒绝/未受管 None）；列表稳定性：tools 数组字节在 (model, run) 内恒定。
- 工作量：**M-L**（版本目录骨架 S 级、工具集变体 M、目录联动 M）。

---

### 3.4 阶段 4：schema 与确定性增强（S4）

#### 3.4.1 目标

把 schema 面从"手工 json! 放任"收口为"注册期校验 + 幂等保证 + 字符集门禁"，与已落地的 canonicalize_schema / R1-R5 规则面形成闭环；补齐 opencode/codex 的确定性细节（strict:false 全系、tool_choice 联动）。

#### 3.4.2 改动点

| 项                 | 落点                                                          | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册期 schema 校验 | `tools/mod.rs` 注册助手（新 `validate_registered_tool` 门禁） | 注册时跑 `canonicalize_schema(effective_input_schema())` 幂等断言（canonicalize(canonicalize(x)) == canonicalize(x)）与形状断言（type 存在/required⊆properties）；**校验失败拒绝注册**（fail-closed，与 `tool.version_conflict` 同码族或新 `tool.invalid_schema`）——注意该函数在 agent-provider（request/schema.rs:38），agent-tools 不依赖 agent-provider（分层约束）→ 落点在 provider 侧"发布前校验"或把规范化移到共享 crate（如 conex-types），**裁决：规范化函数留在 agent-provider，agent-tools 注册门禁只做结构断言（非空/对象/字符串键），规范化校验由 agent-provider 的 `validate_tools_for_request` 在请求构造面执行** |
| name 字符集门禁    | `tools/mod.rs` 注册助手                                       | 对齐 `sanitize_tool_call_id`（agent-provider request/messages.rs:345）白名单语义：注册名须匹配 `[A-Za-z0-9_-]+`，违规拒绝注册（防 MCP 远端工具名注入面）                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| strict:false 全系  | `agent-provider request/tools.rs`                             | OpenAI chat 系补齐（对齐 opencode request.ts:149-158 对 OpenAI 族全部工具附加 strict:false；Responses 系已做 to_responses_tool:64）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| tool_choice 联动   | 请求构造面                                                    | `supportsToolChoice == false`（目录 v2 已有位）→ 请求不下发 tool_choice 字段（对齐现有 supports_* 消费模式）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 描述预算           | `registry.rs` list_definitions 改写链（E4 点位）              | 可选中间件：description 长度上限裁剪 + 重复描述告警（防 tools 前缀膨胀，P1 前缀稳定原则扩展）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 快照字节校验       | session-loop 测试面                                           | tools 快照哈希随 (model, session) 组合恒定的回归测试（现有 name 排序测试 registry.rs:312-327 的扩展）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

#### 3.4.3 与 R1-R5 的衔接说明

- R1（name 码点升序排序，P6 §3.1）：已落地（registry.rs:168-174），S4 只补测试面扩展；
- R2（canonicalize_schema R2.1-R2.9）：已落地（schema.rs:38-80），S4 补注册期/发布期校验；
- 剩余增强为 R1/R2 的消费侧闭环（工具名白名单、description 预算、strict/tool_choice 联动），不新增规则面。

#### 3.4.4 验收 / 工作量

- 验收：全部 17 工具 schema 通过发布期校验（canonicalize 幂等 + 形状断言）；非法注册名/非法 schema 拒绝注册（单元测试）；OpenAI chat 系 tools 请求字节含 strict:false（字节断言）；supportsToolChoice=false 模型请求无 tool_choice 字段；
- 工作量：**S-M**（可与 S1-S3 并行，独立文件面）。

---

## 4. 与现有系统冲突分析（新协议 × 既有防线）

### 4.1 流式是否会破坏 revert / 备份 / 审批？——不会

关键时序：**一切守门在流之前完成**。

- 审批：`call_verdict`（permission.rs）与 ApprovalGate 在 `execute_single` 之前（tool_exec.rs:578-644）——流式只改变 execute 内部形态，不改变"审批通过才进执行面"；
- 中间件 before 链（BackupMiddleware 快照）：运行于 execute 调用前（tool_exec.rs:768-810），流未开始——`BackupMiddleware` 的"失败即 Block"语义与流式无关；
- C3 回退门禁（decide_command_with_revert）：是权限判定层，同样在流前；
- 结论：**流式产生任何 Progress 之前，审批/备份/权限/互斥声明已完成**。流式不新增任何"边执行边审批"路径。

### 4.2 写路径互斥（write_paths）与流式

写类工具（write_file 等）的 `check_write_allowance_for_ctx` → `claim_write_guard` 在 `execute_stream` 内部第一段执行（流开始后立即完成声明），`WriteClaimGuard` RAII 随流 drop 释放——"冲突拒绝时不得写盘"语义保持（write_paths.rs 测试基线的扩展：流式路径同样不得在冲突时产出 Progress 或写盘）。流式工具（shell）本身不声明路径（命令内删除由语义层门禁覆盖，现状语义不变）。

### 4.3 幂等怎么定义 Progress？——按 Terminal 终值，Progress 不参与

- 幂等键只由"工具名 + 参数规范 hash / snapshotTag + 存在性探针"构成（idempotency.rs:316-332），**不含任何 Progress 内容**——Progress 是非确定性中间状态（实时输出），进键会击穿去重语义（同参两次执行 Progress 天然不同，但终值相同应去重）；
- 去重命中路径：返回 deduplicated 终值、**零 Progress**（执行器短路，executor.rs 幂等分支语义扩展）；
- 半执行中断（流中 Err / abort / 超时）：不记录幂等键（对齐现状"失败执行不记录"executor.rs:118-125）——重试重新执行，无假去重；
- 幂等记录时机：Terminal 收口成功后 record（与现状一致），Progress 已在 Terminal 前发完——记录时不影响已出站事件。

### 4.4 预算截断与流式轰炸

- 工具侧：`StreamingSpec.max_delta_bytes`（S2）约束单帧；shell 的 `maxOutputBytes` 升级为累计字节预算（§3.1.6）；
- 执行器侧：Progress 累计字节计数器——超预算后停止转发 Progress 并继续等 Terminal（终值仍走 summarize 截断），防"流式轰炸"击穿上下文窗口；
- 与 `ToolOutputBudgetOptions`（output.rs:82-88）的关系：Progress 走独立累计预算（展示面），Terminal 走既有 summarize 预算（模型面）——两层不混。

### 4.5 中间件 on_result 改写与 Progress 的关系

on_result 链（tool_exec.rs:963-1005）改写的是 **Terminal 终值**；已出站的 Progress 不回放、不参与改写（Progress 是展示面，tool-end 事件与模型回投只消费终值，§3.1.5）。语义：改写只作用于模型可见结果，不影响实时展示——与现状 on_result 只动 output 的语义一致。

### 4.6 并发控制的关系矩阵

| 控制面     | 现状                                                                    | S2 后                  | 关系                                                                                                                           |
| ---------- | ----------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 批内分组   | call.concurrency（Parallel/Sequential/Exclusive，tool_exec.rs:270-286） | 不变                   | **批语义**：决定哪些调用并发                                                                                                   |
| 执行期并发 | 无                                                                      | max_concurrency 信号量 | **上限语义**：并行组内每工具分槽——shell_command max_concurrency=1 等价"shell 绝不与其他 shell 并行"（现状 Exclusive 的声明化） |
| 写路径互斥 | WritePathRegistry（write_paths.rs）                                     | 不变                   | **路径级互斥**：与调用级并发正交，互不替代                                                                                     |

### 4.7 事件契约与前端

- 新增出站事件复用 `AgentEvent::ToolUpdate`（events.rs:375-382）既有变体 + `ToolProgressUpdate` 既有形状（tool.rs:140-153）——**无需新事件类型**，只需登记 metadata.kind 新字面量到 `contracts/engine-events.json` 并同步前端 partialToolArgs 消费面；
- 事件信封（runId/sequence/schemaVersion）由 emit 层注入，新增载荷零契约破坏；
- ToolUpdate 不进消息历史/缓存前缀（§3.1.5）——对话持久化与 P1 前缀稳定不受影响（cache_tracker.rs 只按 MessageBlock 计算，ToolUpdate 不在块内）。

### 4.8 与工具集裁剪（readonly / task_type）的组合

- 现有 task_type 裁剪（readonly.rs:102-116）是注册表实例面；S3 的 model toolset 选择同为注册表实例面——**串行组合**（task_type 先、model toolset 后，或反向按调用方语义定序），两套裁剪不互踩（均为"白名单过滤出新注册表"，无共享可变状态）；
- 只读集与 concise 集交集：只读裁剪后再套 concise 变体（read_file/list_dir/grep 的 concise 输出对只读子代理同样可用）。

### 4.9 模型目录 v2 保护（D4）

- 目录 v2（151 条 supports 位）是用户测试资产：S3 **只新增可选字段 + 新增查询函数**，不改既有字段值、不改 schema 版本（保持 "2.0"），既有 catalog.rs 测试基线（含 supports_* 覆盖/回退断言）必须全绿；
- 新增字段缺省 = 现状行为（全量集 / current preset / 全量 tools），保证未配置模型的字节级回归。

### 4.10 风险登记

| 风险                                                | 等级 | 缓解                                                                              |
| --------------------------------------------------- | ---- | --------------------------------------------------------------------------------- |
| 流式工具误用（不自查 abort_token，长跑不响应取消）  | 中   | 执行器 drop 即取消（现状语义）+ 文档/示例约束 + 测试注入（流中途 abort 断言收口） |
| Progress 轰炸击穿上下文/带宽                        | 中   | 双层预算（§4.4）+ max_delta_bytes + 累计截断标记                                  |
| capabilities 声明与名单双源漂移                     | 低   | 迁移期双实现并存 + 断言测试（名单 ⊆ capabilities 派生）                           |
| 模型级 toolset 选择导致快照漂移                     | 低   | 快照按 (model, session) 锁定；切换 = 新 run 新快照；字节恒定回归测试              |
| Tool trait 新增默认方法对第三方 impl 的 semver 影响 | 低   | Rust trait 默认方法向后兼容；文档标注"实现方可选 override"                        |

---

## 5. 实施顺序与依赖总结

```
S4（独立面，可与 S1-S3 并行）
S1 流式协议（L）───┬──→ S2 能力元数据（M）───┬──→ S3 版本化与多工具集（M-L）
                   │                         └─（behavior_version 字段消费）
                   └─（streaming 声明字段）
```

| 阶段 | 前置                    | 建议轮次   | 验收门禁（汇总）                                                                |
| ---- | ----------------------- | ---------- | ------------------------------------------------------------------------------- |
| S1   | 无（futures-core 依赖） | R-TOOLS-1  | 17 工具经流式路径字节等价回归 + shell 实时输出 + 事件序 + abort                 |
| S2   | S1                      | R-TOOLS-2  | 能力表登记 + 名单迁移断言 + 并发信号量 + plan 模式回归矩阵                      |
| S3   | S2                      | R-TOOLS-3  | resolve_version 全分支 + concise 集 + 目录 v2 测试零破坏 + tools 空数组缺口修复 |
| S4   | 无                      | 任意轮次内 | 注册门禁 + strict 全系 + tool_choice 联动 + 快照字节恒定                        |
