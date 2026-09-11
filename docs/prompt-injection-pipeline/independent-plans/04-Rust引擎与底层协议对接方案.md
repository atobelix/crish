# 04-Rust 引擎与底层协议对接方案

> **文档定位**：本文件为「上下文提示词注入流水线（Prompt Injection Pipeline）」战役的核心独立方案文档，代号 `04-Rust引擎与底层协议对接方案`。
> **权威输入**：
> - 仓库协作纪律与反退避原则：`AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`
> - Rust 内核引擎实现：`apps/agent-workbench/src-tauri/src/engine_build.rs`、`src/run/run_launch.rs`、`src/run/run_idle.rs`、`src/run/run_history.rs`
> - 核心循环与上下文注入：`crates/session-loop/`（`cache_tracker.rs`、`provider.rs`、`compaction_dispatch.rs`）、`crates/agent-tools/src/subagent_inject.rs`
> - 缓存与多模型适配：`crates/agent-provider/src/request/`（`cache.rs`、`cache_policy.rs`、`build_anthropic.rs`、`build_chat.rs`）、`crates/conex-compaction/`
> - 前端 IPC 通信层：`apps/crish-desktop/src/api/chat-bridge/`（`streamSession.ts`、`streamFinishControl.ts`、`historyMessages.ts`）、`packages/`

---

## 目录

1. [执行摘要与架构全景](#一执行摘要与架构全景)
2. [ContextInjectionKind 注入顺序与契约梳理](#二contextinjectionkind-注入顺序与契约梳理)
   - 2.1 [冻结注入顺序与协议设计](#21-冻结注入顺序与协议设计)
   - 2.2 [四类注入段的语义、来源与载荷规范](#22-四类注入段的语义来源与载荷规范)
   - 2.3 [RunTaskOptions 参数契约与入站规范化](#23-runtaskoptions-参数契约与入站规范化)
   - 2.4 [主 Agent 与子代理（Subagent）装配差异矩阵](#24-主-agent-与子代理subagent装配差异矩阵)
3. [前端 IPC 注入通道与底层 ContextInjector 衔接](#三前端-ipc-注入通道与底层-contextinjector-衔接)
   - 3.1 [端到端通信链路拓扑](#31-端到端通信链路拓扑)
   - 3.2 [高性能数据流与零冗余传输](#32-高性能数据流与零冗余传输)
   - 3.3 [字节级一致性（Byte-Level Determinism）保障](#33-字节级一致性byte-level-determinism保障)
   - 3.4 [注入段体积预算与确定性截断策略](#34-注入段体积预算与确定性截断策略)
4. [多轮流式生成、上下文窗口与 Prompt Caching 兼容性](#四多轮流式生成上下文窗口与-prompt-caching-兼容性)
   - 4.1 [多轮流式生成与注入生命周期解耦](#41-多轮流式生成与注入生命周期解耦)
   - 4.2 [上下文窗口（Context Window）与动态预算计算](#42-上下文窗口context-window与动态预算计算)
   - 4.3 [系统提示词缓存（Prompt Caching）深度兼容与测量](#43-系统提示词缓存prompt-caching深度兼容与测量)
   - 4.4 [厂商差异化适配矩阵（Anthropic / OpenAI / DeepSeek / Qwen）](#44-厂商差异化适配矩阵anthropic--openai--deepseek--qwen)
5. [架构演进路径与升级路线图](#五架构演进路径与升级路线图)
6. [立体化测试与验证断言矩阵](#六立体化测试与验证断言矩阵)

---

## 一、执行摘要与架构全景

在 Conex / Crish 的架构中，提示词（Prompt）与上下文注入是连接用户意图、前端交互状态、工作区环境以及大模型内核的核心纽带。随着多 Agent 协同、动态工具发现（Skills / MCP）、多轮长会话自愈以及大模型提示词缓存（Prompt Caching）等高级特性的引入，上下文注入面临着三大核心工程挑战：

1. **注入顺序与语义确定性**：跨模块注入内容必须保证严格的单调递增顺序，任何段落漂移都会破坏模型注意力集中度与 KV 缓存前缀。
2. **IPC 高性能与字节级保真**：前端与 Rust 内核通信必须保持低延迟、轻量化，并在跨轮执行、上下文压缩恢复等场景下保证静态前缀的逐字节一致。
3. **多模型生态与缓存优化协同**：在兼顾流式输出、上下文预算钳制（Context Budget Clamping）与历史压缩的同时，最大化利用各厂商的 Prompt Caching 机制（如 Anthropic 4 断点、OpenAI `prompt_cache_key`、DeepSeek/Qwen 隐式前缀缓存）。

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           前端 Crish Desktop (React / TS)                       │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────┐  │
│  │    Chat Composer UI     │  │  ProviderProfiles Store │  │ Workspace Store │  │
│  └────────────┬────────────┘  └────────────┬────────────┘  └────────┬────────┘  │
│               │                            │                        │           │
│               ▼                            ▼                        ▼           │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ streamSession.ts / streamFinishControl.ts: composeSystemPrompt, History  │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
└────────────────────────────────────────┼────────────────────────────────────────┘
                                         │ Tauri IPC: `core_run_task`
                                         ▼ (RunTaskOptions Payload)
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      Tauri 壳层 / 命令入口 (src/run/run_launch.rs)              │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ 1. 入参校验与规范化 (build_system_prompt, parse_reasoning_effort)         │  │
│  │ 2. 状态装配 (Goal / ContextState / ContextBudget / WriteClaims 沙箱)      │  │
│  │ 3. 构造 ContextInjector (System -> Skills -> Mcp -> AgentDefinition)      │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
└────────────────────────────────────────┼────────────────────────────────────────┘
                                         │ SessionLoopProducer::with_context_injector
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  Rust 内核构建层 (src/engine_build.rs)                          │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ ContextInjector::render(base)                                             │  │
│  │ ├─ 排序: CONTEXT_INJECTION_ORDER (稳定排序, 同类型保留 push 序)           │  │
│  │ ├─ 格式化: `## {title}\n{content}` (段间 `\n\n` 分隔)                     │  │
│  │ └─ 指纹计算: static_fingerprint (FNV-1a 64, `@dynamic` 字段豁免)          │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
│                                        ▼
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ 装配 SessionLoopOptions.assembly.system_prompt (归类 wire system 角色)    │  │
│  │ 装配 CacheTrackingConfig + 注入 SessionCacheState                         │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
└────────────────────────────────────────┼────────────────────────────────────────┘
                                         │ AgentSessionLoop::run()
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                 核心循环与预算调度 (crates/session-loop/)                      │
│  ┌─────────────────────────────────┐   ┌─────────────────────────────────────┐  │
│  │ CompactionDispatch 压缩编排     │   │ CacheStatsTracker 缓存遥测          │  │
│  │ ├─ estimate_context(双源估算)   │   │ ├─ capture_signature (增量哈希)     │  │
│  │ ├─ clamp_max_tokens(预算钳制)   │   │ ├─ record_usage / detect_miss       │  │
│  │ └─ 独立于压缩预算(System保留)   │   │ └─ 跨 run 会话缓存状态维护          │  │
│  └────────────────┬────────────────┘   └──────────────────┬──────────────────┘  │
│                   │                                       │                     │
│                   └───────────────────┬───────────────────┘                     │
│                                       ▼ ProviderRequest { system_prompt, ... }  │
└───────────────────────────────────────┼─────────────────────────────────────────┘
                                        │ ProviderCall::stream()
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                   多模型适配与协议层 (crates/agent-provider/)                   │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ build_anthropic / build_chat / build_gemini / build_responses            │  │
│  │ ├─ allocate_breakpoints: 4 断点分配 (tools -> system -> messages)         │  │
│  │ ├─ OpenAI 系: prompt_cache_key 钳制 64 码点                               │  │
│  │ └─ DeepSeek / Qwen 系: 隐式前缀缓存优化 (保证前缀字节绝对稳定)            │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、ContextInjectionKind 注入顺序与契约梳理

### 2.1 冻结注入顺序与协议设计

Rust 内核引擎在 `apps/agent-workbench/src-tauri/src/engine_build.rs` 中明确定义并冻结了注入段类型的顺序契约：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum ContextInjectionKind {
    /// 1. 系统提示词基础段（systemPrompt；先于一切注入段）
    System,
    /// 2. Skill 定义段
    Skills,
    /// 3. MCP 工具声明段
    Mcp,
    /// 4. Agent 定义段
    AgentDefinition,
}

pub(crate) const CONTEXT_INJECTION_ORDER: [ContextInjectionKind; 4] = [
    ContextInjectionKind::System,
    ContextInjectionKind::Skills,
    ContextInjectionKind::Mcp,
    ContextInjectionKind::AgentDefinition,
];
```

#### 顺序不变性铁律（Ordering Invariants）
1. **排序即协议（Sort-as-Protocol）**：`ContextInjectionKind` 的 enum 声明顺序、`Ord` 派生比较顺序与 `CONTEXT_INJECTION_ORDER` 常量数组三者必须完全一致。
2. **乱序容忍与稳定重排**：调用方在任意阶段、按任意顺序调用 `ContextInjector::push()`，在最终 `ContextInjector::render()` 阶段均会通过 `sort_by_key(|injection| injection.kind)` 进行确定性重排。
3. **同类段落的追加稳定性（FIFO Stability）**：相同 `ContextInjectionKind` 的多个注入段在排序时保持稳定的 `push` 顺序（Stable Sort），确保先注入的 System 指引始终位于后注入的 System 指引之前。

### 2.2 四类注入段的语义、来源与载荷规范

| 注入段类型 (`ContextInjectionKind`) | 典型段落标题 (`title`) | 数据来源与装配点 | 渲染模板 / 载荷结构 | 动态性标记 (`@dynamic`) |
| :--- | :--- | :--- | :--- | :--- |
| **`System`** | `基础系统提示` | 前端下发的 `options.system_prompt` | 用户自定义系统提示词文本 | 否 |
| **`System`** | `响应风格` | 前端 `responseStyleGuidance` | `Response style: <minimal\|concise\|balanced\|thorough>...` | 否 |
| **`System`** | `阶段总结` | `assemble_system_prompt_with_stages` | `阶段总结：N 条\n\n<markdown>` | 否（跨 Run 确定性渲染） |
| **`System`** | `子代理角色约束` | `push_subagent_role_constraint` | `你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配...` | 否（冻结文案，全文匹配） |
| **`System`** | `会话注入（started_at）` | `subagent_session_injections` | `@dynamic\n会话创建于：<ISO8601> (<epoch_ms>)` | **是**（时间戳动态豁免） |
| **`System`** | `git 回退谨慎指引` | `subagent_session_injections` | 禁止破坏他人提交、严格 `git commit --only` 指引 | 否 |
| **`System`** | `注释保留规范` | `comment_preservation_section` | 约束代码替换时保留原注释 | 否 |
| **`System`** | `权限申请指引` | `permission_relay_injection` | 任务类型与越权审批上报指引 | 否 |
| **`System`** | `文档产出目录` | `output_dir_injection` | `产出目录已锁定为：<path>` | 否 |
| **`Skills`** | `Skill 定义` | `EngineHandle::skill_context_injection` | `- <name>（<scope>）：<description>\n<content>` | 否 |
| **`Mcp`** | `MCP 工具声明` | `EngineHandle::mcp_context_injection` | `- <name>：<description>` | 否 |
| **`AgentDefinition`** | `Agent 定义` | 专有角色提示词 / 外部传入 Agent 规格 | Agent 职责定义、执行清单与约束 | 否 |

### 2.3 RunTaskOptions 参数契约与入站规范化

前端与后端通过 Tauri IPC 调用的主数据契约定义于 `apps/agent-workbench/src-tauri/src/run/run_launch.rs`：

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskOptions {
    pub run_id: String,
    pub session_id: String,
    pub prompt: Option<String>,
    pub mode: Option<String>,
    pub cwd: Option<String>,
    pub permission_mode: Option<String>,
    pub client_message_id: Option<String>,
    pub assistant_client_message_id: Option<String>,
    pub system_prompt: Option<String>,
    pub history: Option<Vec<HistoryMessage>>,
    pub context_window: Option<u32>,
    pub parent_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_config: Option<SubagentRunConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_stalled_rounds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_state: Option<String>,
}
```

#### 入站参数的解析与规范化流水线：
1. **基础标识与串行校验**：
   - `run_id` 与 `session_id` 经 `trim()` 校验非空，若空立即返回 `CoreError::InvalidInput`。
   - `active_runs` 互斥锁检测当前会话是否已有活动 Run，防止并发写入造成状态竞争（串行守卫）。
2. **系统提示词与阶段总结组装**：
   - 原始 `system_prompt` 经 `build_system_prompt`（`trim()` 且过滤空串）后，传入 `assemble_system_prompt_with_stages`。
   - 自动拉取会话持久化的阶段总结记录（Stage Summaries），拼装在系统提示词尾部。
3. **思考档位与模式解析**：
   - `reasoning_effort` 经 `parse_reasoning_effort` 映射为 `session_loop::ReasoningEffort` 枚举（`Off/Auto/Minimal/Low/Medium/High/Xhigh`），未知格式宽容回退为 `None`。
   - `mode == "goal"` 时提取 `visible_goal`、`max_rounds`（默认 12）、`max_stalled_rounds`（默认 2）并初始化 `GoalState`。
4. **上下文预算（ContextBudget）解析**：
   - 经 `resolve_context_budget(context_window, &subagent_config, &engine)` 解析：主会话优先采用前端下发或目录查询值；子代理若未传则由生效模型 Catalog 自动兜底。

### 2.4 主 Agent 与子代理（Subagent）装配差异矩阵

主 Agent 与子代理共用 `core_run_task` 底层执行引擎，但在上下文注入与安全沙箱上有严格的分离：

| 维度 / 配置项 | 主 Agent Run (`subagent_config == None`) | 子代理 Run (`subagent_config == Some(...)`) |
| :--- | :--- | :--- |
| **角色约束段注入** | **严格禁止**（断言确保不含 `push_subagent_role_constraint`） | **强制注入**（`## 子代理角色约束`：禁止自行创建子 Agent） |
| **时间戳与指引注入** | 不注入 `started_at` 动态段 | 注入 `started_at`、`git 回退谨慎指引`、`权限申请指引` |
| **文档产出目录** | 不注入（主控自由决定） | 注入 `## 文档产出目录`（指定 `.agent-outputs/` 目录） |
| **工具注册表裁剪** | 具备全部工具（含 `run_subagent`, `send_message`, `kill_subagent`） | **严格剔除** `run_subagent`、`send_message`、`kill_subagent`；按 `task_type` 白名单裁剪 |
| **写路径沙箱** | 全局工作区权限（受 permission_mode 约束） | 严格受限：仅限 `allowed_write_paths` 或 implementation 根目录 |
| **探索类文档配额** | 无限制 | `design`/`review` 任务限制 `ExploreDocsQuotaContext` (quota=1) |
| **唤醒监听器 (Watcher)** | 会话首次出现时惰性 spawn `ensure_wake_watcher` | **禁止 spawn**（子代理收口即终态，防共享队列误消费） |

---

## 三、前端 IPC 注入通道与底层 ContextInjector 衔接

### 3.1 端到端通信链路拓扑

前端到内核的注入调用链路经过高度收敛，不存在旁路或冗余通道：

```
[前端: streamSession.ts]
  │
  ├─ 1. composeSystemPrompt(options.systemPrompt, responseStyleGuidance)
  ├─ 2. buildHistoryMessages(body, { excludeId }) -> history
  ├─ 3. takePendingContextState() -> contextState
  ├─ 4. resolveContextWindow(sets) -> contextWindow
  │
  ▼
[Tauri IPC: transport.request('core_run_task', payload)]
  │
  ▼
[Rust 壳层: run_launch.rs::core_run_task]
  │
  ├─ 1. 参数解构与规范化
  ├─ 2. assemble_system_prompt_with_stages -> base_system_prompt
  ├─ 3. ContextInjector 装配 (子代理指引 / started_at / 目录)
  ├─ 4. 构造 SessionLoopProducer 并传递 context_injector
  │
  ▼
[Rust 内核: engine_build.rs::SessionLoopProducer::produce]
  │
  ├─ 1. ContextInjector::render(base_system_prompt) -> full_system_prompt
  ├─ 2. 写入 SessionLoopOptions.assembly.system_prompt
  ├─ 3. 构造 AgentSessionLoop 并启动
  │
  ▼
[会话循环: session-loop/src/loop/]
  │
  └─ 组装 ProviderRequest { system_prompt: Some(&str), messages, tools, ... }
```

### 3.2 高性能数据流与零冗余传输

为了确保在多轮高频交互与海量工具调用下依然保持微秒级响应，方案遵循以下性能设计规范：

1. **借用生命周期与零深拷贝（Zero-Copy Borrowing）**：
   - `ProviderRequest<'a>` 中的 `system_prompt` 与 `messages` 均采用借用切片（`Option<&'a str>` 与 `&'a [Arc<AgentMessage>]`）。
   - 在 `produce()` 阶段将 `ContextInjector::render()` 产出的字符串一次性存入 `SessionLoopOptions`，在多轮循环内只进行不可变借用解引用，杜绝每轮重新分配。
2. **单次渲染与惰性拼接**：
   - `ContextInjector` 仅在 Run 启动时（`SessionLoopProducer::produce`）执行一次 `render()`，产出扁平化的系统提示词。
   - 段落拼接使用预估容量的 `Vec<String>` 一次性 `concat()`，避免字符串频繁扩容重分配。
3. **单向信标传递与无状态 IPC**：
   - 前端通过 `core_run_task` 单向传递本次 Run 所需的全部参数快照，后端执行完毕后通过收口事件流（Event Stream）回传，无需前端维护繁琐的握手同步状态机。

### 3.3 字节级一致性（Byte-Level Determinism）保障

字节级一致性是大模型前缀缓存（Prompt Caching）能够命中且测试可快照断言的核心基石。

#### 1. 静态指纹哈希算法（FNV-1a 64）
`ContextInjector` 实现了 `static_fingerprint()` 方法，用于对非动态注入段进行确定性指纹计算：
```rust
pub(crate) fn static_fingerprint(&self) -> u64 {
    let mut ordered = self.injections.clone();
    ordered.sort_by_key(|injection| injection.kind);
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV_OFFSET_BASIS
    for injection in ordered {
        if injection.content.contains("@dynamic") {
            continue; // 动态段豁免静态指纹校验
        }
        for byte in injection.title.bytes().chain(injection.content.bytes()) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x1000_0000_01b3); // FNV_PRIME
        }
    }
    hash
}
```

#### 2. `@dynamic` 动态字段豁免与边界隔离
- 时间戳字段（如子代理 `started_at`、检查点时间戳）必须显式打上 `@dynamic` 标记。
- 凡带有 `@dynamic` 的段落，不参与静态指纹比对与跨 Run 缓存断言，其余静态文本（如工具说明、技能正文、角色约束）必须满足逐字节一致。

#### 3. 跨平台文本归一化
- 所有 Rust 源码与注入模板强制采用 **UTF-8 无 BOM** 编码。
- 段落换行统一使用标准 LF（`\n`），段与段之间使用双换行（`\n\n`）隔离。
- Unicode 码点安全截断：涉及 Key 生成（如 OpenAI 缓存键）时，统一按 Unicode 码点（`chars().take(64)`）而非字节截断，防止中文字符被截断为非法字节序列。

### 3.4 注入段体积预算与确定性截断策略

为防止恶意的超长 MCP 工具描述或过量技能定义撑爆系统提示词窗口，`ContextInjector` 配备了体积预算截断器 `truncate_to_budget`：

```rust
pub(crate) fn truncate_to_budget(&mut self, budget_bytes: usize) -> usize {
    let mut retained = Vec::new();
    let mut used = 0usize;
    let mut dropped = 0usize;
    let mut ordered = std::mem::take(&mut self.injections);
    ordered.sort_by_key(|injection| injection.kind);

    for injection in ordered {
        // 动态段（如时间戳）体积极小，默认保留
        if injection.content.contains("@dynamic") {
            retained.push(injection);
            continue;
        }
        let size = injection.title.len() + injection.content.len() + 8;
        if used + size > budget_bytes {
            dropped += 1;
            continue; // 优先级低的扩展段被丢弃，优先保留核心 System 段
        }
        used += size;
        retained.push(injection);
    }
    self.injections = retained;
    dropped
}
```
- **截断优先级原则**：按 `ContextInjectionKind` 升序保留。优先保留 `System`（基础指令与约束），超限时按序放弃 `AgentDefinition` -> `Mcp` -> `Skills` 的超长部分，绝不导致整个请求崩溃。

---

## 四、多轮流式生成、上下文窗口与 Prompt Caching 兼容性

### 4.1 多轮流式生成与注入生命周期解耦

在多轮工具交互循环（Multi-Turn Tool Execution Loop）中，上下文注入与对话消息流严格隔离：

```
LLM Wire Request Payload:
┌────────────────────────────────────────────────────────────────────────┐
│ system: "基础提示词\n\n## 阶段总结...\n\n## Skill 定义...\n\n## MCP..." │  <-- 汇入 system 角色
├────────────────────────────────────────────────────────────────────────┤
│ messages: [                                                            │  <-- 仅包含对话历史
│   { role: "user", content: "..." },                                    │
│   { role: "assistant", content: [{ type: "tool_use", ... }] },         │
│   { role: "user", content: [{ type: "tool_result", ... }] }            │
│ ]                                                                      │
└────────────────────────────────────────────────────────────────────────┘
```

#### 关键架构解耦点：
1. **System 角色隔离**：所有注入段均通过 `ContextInjector::render()` 汇入 `system_prompt`（在 Anthropic 中为顶层 `system` 字段，在 OpenAI/Chat 格式中为首条 `role: "system"` 消息）。对话消息列表 `messages` 中**严禁**混入 `role: "system"`，确保对话轮次在视觉与逻辑上的纯净。
2. **压缩预算独立性**：`conex-compaction`（上下文压缩引擎）仅扫描并压缩 `messages` 对话列表中的历史交互。注入段从物理结构上不进入压缩输入，因而在发生上下文压缩（Compaction）时，系统指令与工具/技能定义永远不会被误丢弃或错误裁剪。
3. **流式事件旁路广播**：在多轮循环中，模型吐出的 `TextDelta` 与 `ThoughtDelta` 通过 `DeltaSink` / `LiveEventSink` 实时推送到前端，而底层的注入段保持完全只读与静态，不干扰流式事件的高频发射。

### 4.2 上下文窗口（Context Window）与动态预算计算

Rust 内核通过 `crates/session-loop/src/loop/compaction_dispatch.rs` 与 `conex-types::ContextBudget` 实现对上下文窗口的精细控制。

#### 1. 双源上下文估算（`estimate_context`）
在发送 LLM 请求前，内核计算当前上下文的 Token 占用：
- **实测 Usage 优先**：扫描对话中最后一条带 `TurnUsage` 的 assistant 消息，取其 `input_total`（包含历史提示词、系统指令与已缓存 Token），其后的增量消息按字符启发式补算。
- **启发式兜底**：若无实测 Usage（首轮或冷启动），则对全部消息文本 + `system_prompt` 文本 + `tools` 的 JSON Schema 整体体积进行分块估算。

#### 2. Max Tokens 动态安全钳制算法（`clamp_max_tokens`）
为防止单次请求的 `max_tokens` 与当前上下文总和超过模型上下文窗口上限，执行以下钳制公式：
$$\text{available} = \text{context\_window} - \text{estimate} - \text{safety\_tokens}$$
$$\text{final\_max\_tokens} = \max(1, \min(\text{requested}, \text{available}))$$

- 默认安全垫 `safety_tokens = 4096`。
- **下限保护**：当 $\text{available} < \text{CLAMP\_MIN\_AVAILABLE} (256)$ 时，说明上下文已极度拥挤，此时不再强制缩紧 `max_tokens`（避免产出垃圾截断结果），而是触发上下文压缩预检（`maybe_compact_preflight`）。

#### 3. 压缩切割与工具调用配对保护
当预检触发压缩时，`conex-compaction` 的 `find_cut_point` 算法会从尾部倒推保留区间，并强制执行**工具配对校验**：
- 保留段内的每一个 `ToolResult` 必须在保留段内找到对应的 `ToolCall`。
- 若存在孤儿 `ToolResult`，自动向前扩展保留窗口直到配对完整，绝不在工具调用中间发生截断。

### 4.3 系统提示词缓存（Prompt Caching）深度兼容与测量

提示词缓存（Prompt Caching）是降低长会话延迟与 API 成本的关键。本方案在设计上确保注入流水线与缓存机制达成 100% 契合。

#### 1. 静态前缀稳定律（Static Prefix Invariance）
大模型缓存机制（无论是隐式前缀树还是显式断点）均要求从提示词第 0 字节开始尽可能长地保持字符完全一致：
- `System` 基础段、`Skills` 技能段、`Mcp` 工具段由于其静态特性，在同一项目会话中保持完全不变。
- 排序规则确保静态段置于最前，动态段（如带 `@dynamic` 的时间戳或末尾用户消息）置于最后，从而最大化静态前缀的长度。

#### 2. 缓存测量跟踪器（`CacheStatsTracker`）
内核通过 `crates/session-loop/src/cache_tracker.rs` 对每次请求进行缓存遥测（只测不改）：
- **请求签名捕获 (`capture_signature`)**：在 `build_request` 前，计算 System + Tools + Messages 的哈希签名。
- **增量哈希优化 (`messages_hash` incremental fold)**：当 System 与 Tools 不变且 Messages 仅追加时，下一轮仅对新追加消息计算哈希并与上一轮折叠，避免 $O(N)$ 全量重算。
- **Miss 归因与审计 (`MissAttribution`)**：自动识别缓存未命中原因并记录：
  - `ColdCache`：距离上次请求超过 TTL 或新会话首轮。
  - `PrefixDivergence`：前缀内容发生变更（如技能被动态修改）。
  - `CompactionEviction`：会话发生了上下文压缩，历史前缀重构。
  - `ModelSwitch` / `ProviderSwitch`：切换了模型或服务商。
  - `TtlExpired`：缓存租期自然过期。

### 4.4 厂商差异化适配矩阵（Anthropic / OpenAI / DeepSeek / Qwen）

不同厂商在底层协议层对缓存的支持形态各异，`agent-provider` 实现了自动分流与适配：

| 厂商 / 协议族 | 缓存机制 (`CacheMechanism`) | 系统提示词处理与断点分配策略 | 会话级缓存键 / 请求头 |
| :--- | :--- | :--- | :--- |
| **Anthropic (Messages API)** | 显式断点 (`Explicit`) | 4 断点预算分配（`allocate_breakpoints`）：<br>1. `tools` 尾部注入 `{"type":"ephemeral"}`<br>2. `system` 顶层注入 `{"type":"ephemeral"}`<br>3. `messages` 倒数第二轮 user 注入<br>4. 预留扩展 | `anthropic-version: 2023-06-01`<br>无额外键字段 |
| **OpenAI (Chat / Responses)** | Key 机制 / 隐式前缀 (`Key` / `Implicit`) | 依赖静态前缀一致性；首条消息设为 `role: "system"` | 自动派发 `prompt_cache_key`（由 `session_id` 经 Unicode 钳制 64 码点派生） |
| **DeepSeek** | 隐式前缀缓存 (`Auto`) | 严格省略 `cache_control`（`omit_cache_control = true`），依靠服务端前缀匹配 | 无额外键，依赖 System + Tools 字节级绝对稳定 |
| **Qwen / 百炼** | 会话亲和 / 显式控制 (`Header` / `Explicit`) | 支持 `x-dashscope-session-cache` 头或兼容 Anthropic 格式 | 注入 `session_id` 亲和请求头，保持节点路由粘性 |

---

## 五、架构演进路径与升级路线图

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                            演进路径与里程碑规划                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 阶段一：现有能力收口与硬化 (Current -> Stabilization)                           │
│ ├─ [已就绪] 锁定 CONTEXT_INJECTION_ORDER (System -> Skills -> Mcp -> AgentDef)   │
│ ├─ [已就绪] 统一 RunTaskOptions 契约，支持思考档位与 Goal 模式三字段             │
│ └─ [验证中] 消除 run_launch.rs 与 engine_build.rs 中未接线的 dead_code 警告      │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 阶段二：动态提示词增量编译与缓存指纹优化 (Optimization Phase)                     │
│ ├─ [规划] 引入注入段级哈希缓存（Segment Level Cache）：各注入段独立计算 Hash     │
│ ├─ [规划] 在前端与 Rust 引擎之间建立增量注入协议，避免多轮传输重复的 Skills/Mcp  │
│ └─ [规划] 扩展 ContextInjector 支持条件注入（Condition-based Injection Filter）  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 阶段三：跨 Run 上下文状态机与分布式调度 (Future Evolution)                       │
│ ├─ [探索] 会话分支（Fork）与重放（Replay）场景下的注入一致性继承                 │
│ ├─ [探索] 多模型混合路由下的自适应提示词编译器（Prompt Adaptor Pipeline）        │
│ └─ [探索] 统一遥测看板：实时展示各会话的 Prompt Cache 命中率与节约 Token 统计    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 六、立体化测试与验证断言矩阵

为彻底践行反退避与零容忍作弊纪律，本对接方案必须通过以下立体化测试套件的刚性拦截：

### 6.1 单元测试与确定性断言（Unit & Invariant Tests）
1. **注入顺序冻结断言**：
   - 测试用例：`engine_tests::injection_order_contract_is_frozen`
   - 断言：`CONTEXT_INJECTION_ORDER == [System, Skills, Mcp, AgentDefinition]`，且与 enum Ord 排序完全相等。
2. **乱序注入重排与字节稳定性断言**：
   - 测试用例：`engine_tests::injector_render_respects_frozen_order_and_is_byte_stable`
   - 断言：无论 push 顺序为何，render 输出的子字符串位置恒满足 `System < Skills < Mcp < AgentDefinition`；同一配置两次 render 产出逐字节相等（`assert_eq!(rendered, second)`）。
3. **角色约束与主子 Agent 隔离断言**：
   - 测试用例：`engine_tests::main_agent_run_excludes_subagent_role_constraint` 与 `subagent_run_system_prompt_contains_frozen_constraint`
   - 断言：主 Agent 的 System Prompt 绝不含角色约束标题与文案；子代理 System Prompt 必须全文包含冻结文案。
4. **截断与体积预算断言**：
   - 测试用例：验证 `truncate_to_budget` 在字节超限时，优先保留 System 段，截断低优先级段，截断后不产生残缺段落。

### 6.2 跨模块集成测试（Integration Tests）
1. **Produce 级 ProviderRequest 校验**：
   - 验证 `SessionLoopProducer::produce` 后生成的 `ProviderRequest` 中，`system_prompt` 包含所有激活的注入段，且 `messages` 数组中**不含**任何 `role == System` 的条目。
2. **IPC 参数序列化/反序列化保真测试**：
   - 验证前端 `streamSession.ts` 组装的 JSON Payload 在 Rust 侧反序列化为 `RunTaskOptions` 时，`reasoningEffort`、`visibleGoal`、`history` 等字段零数据丢失。

### 6.3 性能基准与门禁（Performance Gate）
1. **注入渲染耗时门禁**：
   - 在包含 50 个 Skills 和 100 个 MCP 工具的大型上下文配置下，`ContextInjector::render()` 耗时必须 $\le 50\,\mu\text{s}$。
2. **零内存泄漏与锁安全性**：
   - 跨 Run 执行 10,000 次，内存无持续增长，所有 Mutex / RwLock 无死锁与锁中毒风险。

---

> **结语**：本设计方案通过严格的顺序契约、零深拷贝数据流、字节级指纹保障与多模型差异化缓存适配，为 Rust 内核引擎与前端 IPC 通信层构建了兼具高可靠性与极致性能的上下文注入流水线。
