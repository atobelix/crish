# P1：通用缓存前缀稳定性工程（Rust 引擎层）

- 方案编号：P1（前缀稳定性）
- 撰写日期：2026-08-03
- 方案性质：实现方案（只写文档，未修改任何源代码）
- 输入材料：
  - `docs/cache-optimization/02-comparison/comparison.md`（对比与缺口分析，本方案解决其 2.1/2.2/2.3 及 3.1 中"前缀稳定性"相关缺口）
  - `docs/cache-optimization/01-reference-research/` 下 codex-cli / opencode / jcode / deepseek-reasonix 四份调研（tools 排序与 schema 规范化、system 稳定性、前缀不变量测试的参考实现）
  - crish 实际代码（全部经本代理实读核实，行号以实读为准，见第 2 节）
- 文件域（本方案只允许改动这些区域）：
  - `crates/session-loop`（LoopState / build_request / tools_schema / SessionLoopOptions / ProviderRequest）
  - `crates/agent-provider/src/request` 的构造部分（build.rs / messages.rs / tools.rs / 新增 schema.rs）
  - `apps/agent-workbench/src-tauri` 的 engine.rs 与 core_run_commands.rs 的 systemPrompt 通路
  - `apps/crish-desktop` 的 ConnectionLifecycle.ts（systemPrompt 组装与透传的配合点）
- 边界：历史消息回流（P4）、cache_control 断点框架（P2）与开关数据（P3）、压缩与溢出恢复（P4）不属本方案，见第 6 节。【A1 审计修正】原稿"历史消息回流（P2）、cache_control 断点（P3）"归属错误：历史回流属 P4（P4 方案定位），断点注入框架属 P2（P3 只提供开关数据），详见 §6.1/§6.2。

---

## ① 目标与范围

### 1.1 目标

让 crish 发给 LLM 的请求**前缀在字节层面 100% 稳定**：同一会话、同一轮 run 内（工具循环多轮调用），以及同一配置下的跨 run 之间，请求前缀（system 消息 + tools 数组 + 历史消息）逐字节一致。这是 DeepSeek/GLM/Kimi 等自动前缀缓存能命中的物理前提（vendor-cache-mechanisms.md:420-424 的通用规则：任意格式差异都可能导致整段缓存失效）。

本方案不做"命中率测量"（由测量层 plan agent 负责），只做"让命中成为可能"的工程：

1. **tools 定义排序与 schema 规范化**（参考 codex 固定流水线序 + jcode `sort_by(name)` + opencode `sanitizeOpenAISchema`）：统一规则、明确落点、保证跨请求字节一致；
2. **system prompt 通路修复**：修复 `core_run_task` 静默丢弃 `systemPrompt` 的问题；修复前端 guidance 拼接的不确定形态；确立"静态前置、动态后置"的构造纪律；
3. **消息构造确定性**：JSON 序列化字段顺序固定、schema 规范化（ref / enum / required 排序）、tool_call id 稳定性与 arguments 规范化序列化、DeepSeek 工具轮次 `reasoning_content` 键存在性；
4. **会话内 append-only 不变量**：run 内对话构造顺序保证、动态内容后置原则；
5. **前缀稳定性测试与回归防护**：单元测试（两次请求 tools 字节一致）+ 集成测试（参考 codex `prompt_caching.rs` 的断言模式）。

### 1.2 范围（做）

| 维度 | 内容 | 落点 |
|---|---|---|
| A. tools 确定性 | `list_definitions` 按名排序；run 内快照锁定；schema 规范化（新建 `canonicalize_schema`）；canonical JSON 序列化函数 | agent-tools registry.rs / session-loop streaming.rs、LoopState / agent-provider request（新增 schema.rs、改 tools.rs） |
| B. system prompt 通路 | `core_run_task` 增加 `system_prompt` 参数；SessionLoopOptions / ProviderRequest 透传；前端 guidance 拼接函数化；`build_system_prompt` 单点构造 | core_run_commands.rs / engine.rs / session-loop / ConnectionLifecycle.ts |
| C. 消息构造确定性 | 字段顺序钉死；tool_call id 消毒；arguments 规范化序列化；DeepSeek `reasoning_content` 键存在性（Require 模式空串兜底） | messages.rs / engine.rs |
| D. append-only 不变量 | 追加点清单化；动态内容后置纪律；水合只发生在 run 创建时 | session-loop（文档化 + 测试） |
| E. 测试与回归 | 单元 + 集成 + 前端测试；字节级断言 | 各 crate 测试模块 / ConnectionLifecycle.tauri.test.ts |

### 1.3 非范围（明确不做，记入边界）

- **历史消息回流 / 会话水合**（comparison.md 2.13）：**P4 负责**（P4 §3.2 混合路线：SessionHistoryCache + with_initial_conversation_arc）。P1 只提供"回流之后前缀稳定"的物理前提与 `canonical_json_string`（稳定序列化基础，供 P1 测试与 P4 前缀哈希投影等复用；P2/P6 的缓存键已定为会话 ID 派生，**不再做内容哈希**）。【A1 审计修正】原稿"P2 负责 / P2 前缀哈希的基础函数"归属错误：历史回流属 P4；内容哈希已被 P2 §3.1.1 / P6 R3 废弃。
- **cache_control 断点 / prompt_cache_key / 会话亲和头**（comparison.md 2.4/2.6）：**P2 负责注入框架（载体/预算/放置/键派生），P3 负责开关与数据（行为矩阵/模型目录）**。【A1 审计修正】原稿"P3 负责"表述不完整：P2 的 A/B 子主题才是注入实现方。
- **压缩接线 / PayloadTooLarge 恢复阶梯 / 窗口钳制**（comparison.md 2.8/2.9）：P4 负责。P1 只在其纪律层面与其对齐（append-only、compaction 是唯一 cache-reset 点）。
- **usage 字段补齐（DeepSeek 顶层 hit/miss、Kimi cached_tokens）与命中率展示**（comparison.md 2.5/2.10/2.11）：测量层 plan agent 负责。
- **core_run_task 其余被静默丢弃的参数**（`mcpDisabledTools` / `budgetDifficulty` / `content` / `hasImages` / `attachments` / `visibleGoal` / `maxRounds` / `maxStalledRounds`）：不属本方案，相关 agent 按各自任务接线，本方案只修 `systemPrompt` 一条通路。
- **`stream_error.rs` 的恢复阶梯**：只读引用（其注释"真实压缩落地后恢复阶梯"是 P4 的登记），本方案不改。
- **会话持久化模型（conex-db / sessionRustDb）**：不属本方案。

---

## ② 现状证据（全部经实读核实）

### 2.1 tools 按注册序输出、无排序、无快照

- `crates/agent-tools/src/registry.rs:62-68`：`list_definitions` 直接 `list()`（按 `order` 注册序）逐条克隆，**无排序**。注册序由 `register` 时的 `self.order.push(name)`（registry.rs:40）决定。
- `crates/agent-tools/src/tools/mod.rs:50-66`：内置工具注册顺序为 `read_file → write_file → list_dir → file_stat → grep_search → fuzzy_find → shell_command → diff_text`——这个顺序只是"代码书写顺序"，无语义理由。
- `crates/session-loop/src/loop/handlers/streaming.rs:262-269`：`tools_schema` **每次 `build_request` 调用时**（即工具循环每一轮）都从注册表重建，无快照锁定。
- `crates/session-loop/src/loop/handlers/streaming.rs:253-259`：`build_request` 每轮调用 `tools_schema(state)`。
- 对照参考实现：
  - jcode：`defs.sort_by(|a, b| a.name.cmp(&b.name))`，注释原文 "Sort by name for deterministic ordering - critical for prompt cache hits"（jcode-cache-analysis.md:299-305）；且首轮后冻结工具快照 `locked_tools`（jcode-cache-analysis.md:306-318）。
  - opencode：`Object.entries(tools).toSorted(...)`（opencode-cache-analysis.md:182）；`sanitizeOpenAISchema` 递归规范化（opencode-cache-analysis.md:185，transform.ts:1378-1459）。
  - codex：工具 schema 序列化不排序但构建顺序是固定流水线（spec_plan.rs），并有集成测试断言两轮请求 tools 数组完全一致（codex-cli-cache-analysis.md:160-164）。
  - 百炼官方文档直接点名：工具定义需保证列表顺序、字段顺序、字段结构完全一致，否则缓存失效（vendor-cache-mechanisms.md:359）。
- crish TS 侧参考实现（已软废弃但可迁移）：`apps/crish-desktop/src/api/directFetchBridge.ts:37-61`（`canonicalizeJsonSchema`：properties/required 排序）、:64-76（`formatStableTools`：按名排序）；该路径已被 ConnectionLifecycle 声明非产品 SoT（directFetchBridge.ts:4-11）且降级分支已删（ConnectionLifecycle.ts:8-17）。

### 2.2 system prompt 主路径恒为 None、前端参数被静默丢弃

- `apps/agent-workbench/src-tauri/src/engine.rs:218-233`：`build_context` 硬编码 `system_prompt: None`，主路径实际不发送任何 system 消息。
- `apps/agent-workbench/src-tauri/src/core_run_commands.rs:919-929`：`core_run_task` 签名（run_id/session_id/prompt/mode/cwd/permission_mode/client_message_id/assistant_client_message_id）**没有 systemPrompt 参数**——前端传参被 serde 静默忽略。
- 前端确实组装并下发 systemPrompt：
  - `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts:233-247`：把 response style 指导语（`guidance`）与 `options.systemPrompt`（`base`）拼接为 `responseStyleSystemPrompt`，且含一个特殊分支：`base.includes('Response style:')` 时原样透传、否则 `base + "\n\n" + guidance`、base 为空则只发 guidance——**同一配置下存在三种形态，拼接形态不确定**。
  - ConnectionLifecycle.ts:271-275：`systemPrompt = responseStyleSystemPrompt || base`。
  - ConnectionLifecycle.ts:307：`...(systemPrompt ? { systemPrompt } : {})` 经 `startRunTask` 下发。
- 消息映射层已有 system 前置能力但未被使用：`crates/agent-provider/src/request/messages.rs:325-329`（system_prompt 非空时前置 system 消息）、`messages.rs:398-415`（`system_prompt_message`，含 user-prefix 重写）。
- 对照参考实现：
  - jcode：static（指令文件/base/skills，带断点）+ dynamic（date/git/memory，不带断点）拆分，动态内容收进缓存前缀末尾之后（jcode-cache-analysis.md:36-49）。
  - pi：system prompt 一次构造整轮复用，仅工具集/资源变更时重建（pi-cache-analysis.md:322-326）。
  - codex：instructions 确定性构造，优先级 config override > 会话历史 > 模型默认（codex-cli-cache-analysis.md:166-170）。

### 2.3 消息构造：字段顺序固定但无字节级保障、tool_call id 原样透传、reasoning 键可缺失

- `messages.rs:76-103`：`ChatMessage::to_value` 字段插入序固定（role → content → tool_call_id → reasoning_content → tool_calls）——形态确定，但**没有测试钉死**。
- `messages.rs:352-360`：assistant 消息的 `tool_calls[].id` 取 `call.id` **原样**序列化（无消毒）；`arguments` 用 `serde_json::to_string(&call.input)`（messages.rs:357）——【A2 审计修正】原稿"在 preserve_order 构建下序列化字节取决于 wire 解析时的键序，跨构建不稳定"不成立：本 workspace 未启用 serde_json preserve_order（见 §2.4 修正），`Map` 为 BTreeMap，`to_string` 输出确定。保留 C2 的 `canonical_json_string` 仅作**防御性确定性 + 与 P6 R2 规则跨侧对齐**（理由同 §2.4 修正）。
- `messages.rs:298-308`：`reasoning_content_object` 在 Omit 模式下不回传；Include 模式下思考为空 → None。`ReasoningContentMode::Require` 的注释（messages.rs:26-27）声明"无思考内容也回传"，但**实现未落地**（思考为空时仍返回 None）。
- `engine.rs:207-215`：`request_options` 未设置 `reasoning_content`，`build.rs:152` 兜底 `ReasoningContentMode::Omit`——**DeepSeek 工具循环轮次的 assistant 消息永远不带 `reasoning_content` 键**。参考 Reasonix 的实测结论：DeepSeek thinking 模式下 tool_calls 回合缺该键直接 400（deepseek-reasonix-cache-analysis.md:116-127，"总是发送该 key，空串也发"）；opencode 同样对每条 assistant 消息补 `{type:"reasoning", text:""}`（opencode-cache-analysis.md:186）。
- `messages.rs:365-367`：assistant 消息"无正文、无工具调用、无思考回传"时整条跳过——Require 模式下若思考为空串，`reasoning_content: Some("")` 使跳过条件不成立（键存在），行为正确。

### 2.4 请求体构建管线：字段插入序固定（含 preserve_order 隐患）

- `build.rs:102-177`：`build_chat_completions_request_body` 的字段插入序固定（model → stream → temperature → top_p → max_tokens → reasoning → messages → tools → tool_choice → stream_options）——管线序确定。
- 【A2 审计修正】**preserve_order 双态结论不成立（原稿此处断言有误，实测纠正）**：`cargo tree -i serde_json -e features`（workspace 全成员）与 `cargo tree -p crish-agent-workbench -i serde_json -e features` 均显示 serde_json 启用的特性只有 `default / raw_value / std / alloc / unbounded_depth`——**全 workspace（含 app build）没有启用 `serde_json/preserve_order`**。schemars 0.8.22 的 `preserve_order` 特性定义为 `preserve_order = ["indexmap"]`，只启用 schemars 自身的 indexmap 依赖，**不联动 serde_json 的 preserve_order**（已核对 registry 源码 Cargo.toml）。因此：
  - 本 workspace 任何构建形态下 `serde_json::Map` 都是 **BTreeMap（键字典序）**，app build 与 crate 测试 build 的键序列化行为**一致**，不存在"同一代码两种字节行为"的双态；
  - 原稿"app build 里 schema properties 键序 = json! 书写序、测试 build 里 = 字典序"的后果描述不成立；
  - 单元测试"字节相等"断言在同进程内两次构建对比时**天然成立**，无需为规避双态而特设约束。
  - **修正后的工程动机**（不改变本方案交付物，仅纠正理由）：`canonicalize_schema` / `canonical_json_string` 仍有价值——①与 P6 §3.1（R2 规则表）的 TS 侧规范化规则对齐（跨侧字节一致，这是前缀命中的真实约束）；②防御性确定性：未来若任一 crate 引入 serde_json preserve_order（如直接依赖或 feature 注入）或 wire 侧出现依赖键序的解析路径，规范化保证不漂移；③`canonical_json_string` 是 P2 前缀哈希（TS buildStableCacheKey 的 Rust 侧对应物）的稳定输入基础。
- `engine.rs:246`：body 由 `build_chat_completions_request_body` 构建后 `reqwest .json(&body)` 序列化。

### 2.5 会话内 append-only 现状：天然成立但无纪律与测试

- 追加点只有 4 个，全部是 append 语义：
  - `crates/session-loop/src/loop/handlers/mod.rs:150-158`（`record_message`：user/steering 消息入队消费路径）；
  - `crates/session-loop/src/loop/handlers/streaming.rs:344-353`（`commit_message_with_deltas`：assistant 收口路径）；
  - `crates/session-loop/src/steering/mod.rs:270-289`（`SteeringCoordinator::apply`：steering 注入消息 append）；
  - `crates/session-loop/src/loop/mod.rs:293-303`（`with_initial_conversation` / `with_initial_conversation_arc`：run 创建时的水合入口，产品路径未使用）。
- `prepare_turn.rs:34-36`：消息从输入队列出队后 `record_message`——**追加发生在对话尾部**，不前置、不改写。
- `LoopState.conversation`（handlers/mod.rs:68）：`Vec<Arc<AgentMessage>>`，`mem::take` 收口移交（mod.rs:509-530）。
- 对照参考：Reasonix 全工程重心 = "让服务端缓存尽可能命中"：append-only 增长 + compaction 是唯一低频 cache-reset 点（deepseek-reasonix-cache-analysis.md:11-25）；记忆/动态内容一律**尾部注入**（`<memory-recall>` 块追加到 user turn 尾部，deepseek-reasonix-cache-analysis.md:179-189）；jcode 用"序列化到最后一个断点的前缀字节对比"测试钉死尾部注入不移动前缀（jcode-cache-analysis.md:70-79）。

### 2.6 测试基建现状

- `crates/session-loop/src/testing/mod.rs:31-46`、:240-262：`TestProvider` 已支持**请求记录**（`requests()` 返回 `Vec<RequestSnapshot>`，含 messages / tools / max_tokens）——集成测试可直接复用，断言两次调用 tools 一致与 messages 前缀 append-only。
- codex 的参考断言：`prompt_tools_are_consistent_across_requests` 两轮请求 tools 数组一致（codex-cli-cache-analysis.md:164）；`prefixes_context_and_instructions_once_and_consistently_across_requests` 断言 body2 input 前缀 = body1 全量（codex-cli-cache-analysis.md:153-154）。
- 前端测试：`apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.tauri.test.ts:128-142` 已断言 startRunTask 参数形状（不包含 type 字段），扩展 systemPrompt 断言即可。

---

## ③ 设计

### 3.1 总原则（自然内化到 crish 架构）

1. **请求构造真源在 Rust**（comparison.md 3.2）：所有字节稳定性工程落在 `agent-provider/src/request` 与 `session-loop`，TS 侧只做参数透传与配合点（comparison.md 3.3）。
2. **静态在前、动态在后**：system prompt 与 tools 是静态前缀，构造一次整轮复用（pi 语义）；任何动态内容（时间、cwd、会话上下文、memory）只允许出现在 user 消息尾部，永不进入 system 前缀。
3. **确定性优先于整洁**：宁可发"不必要"的键（DeepSeek `reasoning_content` 空串）也不改变历史字节（Reasonix 原则，deepseek-reasonix-cache-analysis.md:261）。
4. **单一构造点**：同一份数据（system prompt、tools 列表、消息映射）在同一函数里完成规范化，杜绝两处实现漂移。

### 3.2 A：tools 确定性（排序 + 快照锁定 + schema 规范化）

#### A1. 注册表输出排序

放 `agent-tools` 的 `list_definitions`（对齐 jcode tool/mod.rs:339-341 的 `sort_by(name)`）。**只排序 `list_definitions`，不动 `list()`**：`list()` 的注册序是执行面语义（工具执行顺序/幂等域），与请求前缀无关，改动它会破坏 `list_preserves_registration_order` 测试（registry.rs:126-133）与执行器行为。

```rust
// crates/agent-tools/src/registry.rs
/// 按注册顺序列出工具定义（对齐 TS resolveForLLM 的消费面）
/// P1：改为按 name 升序排序输出——tools 数组是请求前缀的一部分，
/// 注册序（代码书写序/插件加载序）可能漂移，名称序在进程重启间稳定
/// （对齐 jcode `sort_by(name)`：deterministic ordering is critical
/// for prompt cache hits）。
pub fn list_definitions(&self) -> Vec<ToolDefinition> {
    let mut defs: Vec<ToolDefinition> = self
        .list()
        .iter()
        .map(|t| t.definition().clone())
        .collect();
    defs.sort_by(|a, b| a.name.cmp(&b.name));
    defs
}
```

【A1 审计修正】排序比较用 `String::cmp` 即 UTF-8 码点序，与 P6 §3.1 R1 完全一致（R1 禁止 localeCompare）；实现注释中请引用 P6 R1 作为规则真源（P6 §3.1 是 TS/Rust 双侧共享规范）。

#### A2. run 内快照锁定

crish 的产品形态：注册表是 engine 级只读 `Arc<ToolRegistry>`（engine.rs:455、467-476 只注册内置工具，无 MCP 晚注册），run 内注册表内容不可变。因此"快照锁定"在 crish 语境简化为：**run 内首次构建后缓存，工具循环轮次间复用**（对齐 codex 固定流水线 + opencode 每次请求稳定；jcode 的"首轮后冻结 + MCP 恰好一次重检"复杂度在本项目不必要，注册表没有运行时注册路径）。

```rust
// crates/session-loop/src/loop/handlers/mod.rs（LoopState 新增字段）
pub(crate) struct LoopState {
    // ...
    /// P1：工具 schema 快照（run 内首次构建后锁定；注册表 run 内不可变，
    /// 工具循环轮次间复用保证前缀字节稳定）
    pub(crate) tools_snapshot: Option<Vec<crate::provider::ToolSchema>>,
    // ...
}

// crates/session-loop/src/loop/handlers/streaming.rs
/// 工具定义导出（P1：快照锁定——首次构建后缓存，不再每轮重建）
fn tools_schema(state: &LoopState) -> &[ToolSchema] {
    state.tools_snapshot.as_deref().expect("build_request 前必须已构建工具快照")
}

/// 构建工具快照（run 内一次；入口：preparing-turn 完成、首次 build_request 前）
fn ensure_tools_snapshot(state: &mut LoopState) {
    if state.tools_snapshot.is_none() {
        state.tools_snapshot = Some(
            state
                .tool_registry
                .list_definitions()
                .iter()
                .map(ToolSchema::from_definition)
                .collect(),
        );
    }
}
```

`LoopState::new`（handlers/mod.rs:89-112）初始化 `tools_snapshot: None`；`ensure_tools_snapshot` 的调用点放在 `build_request` 的调用方（streaming::handle 第 2 步，streaming.rs:48）——借用冲突处理：`streaming::handle` 已有 `&mut LoopState`，先 `ensure_tools_snapshot(state)` 再 `build_request(state)`（不可变借用快照）。**清理时机**：run 收口（converge）时不需要清理——每 run 重建 LoopState（engine.rs:755-773 produce 每 run new），快照生命周期天然 = run 生命周期；但测试路径跨 run 复用同一 loop 时（mod.rs:287-303 注释），`with_initial_conversation*` 后快照仍有效（注册表未变），语义正确。**length 阶梯升级（stream_error.rs:77-93）不影响 tools，快照无需重建。**

#### A3. schema 规范化（新增 `agent-provider/src/request/schema.rs`）

【A1 审计修正】本节的 `canonicalize_schema` 规则已按 P6-ts-shell-sync.md §3.1 规则真源（R1/R2）逐条对齐（原稿存在四处冲突：非对象"原样返回" vs R2.1、布尔 schema vs R2.2、type 数组不收敛 vs R2.3、全量字典序 vs R2.9 固定键序）。P1 实现与单测以 P6 §3.1 为准；跨侧字节一致性由 P6 §3.5.2 的 rust-parity 样例表钉死——P1 落地时把样例表复制为 cargo 测试（登记进阶段 1 步骤 1.2/1.3 的测试清单）。排序规则 R1 与 P1 A1 已一致（`String::cmp` 即 UTF-8 码点序，无 localeCompare 冲突，见 A1 后注）。

迁移 directFetchBridge.ts:37-61 的 `canonicalizeJsonSchema` 语义，并扩到 opencode `sanitizeOpenAISchema` 的规范化面（opencode-cache-analysis.md:185）。**为什么在 agent-provider 而不在 agent-tools**：工具注册表（agent-tools）是执行域，其 `ToolDefinition` 序列化（definition.rs:27-46，camelCase）是内部契约；wire 域（OpenAI tools 格式）的规范化属于请求构造层，agent-provider 已有 `to_openai_tool` / `to_responses_tool` 作为单一出口，在此单点接线。

```rust
// crates/agent-provider/src/request/schema.rs（新增）
//! JSON Schema 规范化（P1：前缀稳定性——schema 是 tools 数组的一部分，
//! properties/required 键序漂移会打爆整段缓存前缀）。

/// 递归规范化 JSON Schema：确定性重建（幂等）。
///
/// 规则（对齐 directFetchBridge.canonicalizeJsonSchema + opencode
/// sanitizeOpenAISchema）：
/// - 非对象 / 空 schema：归一为 `{"type":"object","properties":{}}`（P6 R2.1）；
/// - 布尔 schema：`true` / `false` → `{"type":"string"}`（P6 R2.2，opencode 语义）；
/// - `type`：字符串原样；数组 → 过滤合法类型（object/array/string/number/
///   integer/boolean/null）去重；过滤后单元素 → 收敛为单值字符串；
///   过滤后为空 → 删除该键（P6 R2.3）；
/// - `properties`：键按码点升序，值递归应用本表（P6 R2.4）；
/// - `required`：去重 + 码点升序；非数组 → 删除该键（P6 R2.5）；
/// - `const` → `enum: [const值]` 并删除 const 键（P6 R2.6）；
/// - `$defs` / `definitions`：键按码点升序，每个定义递归应用本表（P6 R2.7）；
/// - `items` / `oneOf` / `anyOf` / `allOf`（数组/对象）递归应用本表，数组顺序
///   保留（顺序是语义）；`additionalProperties`（对象）/ `not` / `if` / `then`
///   / `else`：递归（P6 R2.8 之外的一致性扩展）；
/// - `$ref`：视为叶子，原样保留、不深入（无法解析远端引用）；
/// - 其余键（title/description/enum/pattern/minimum 等）：原样保留；
/// - 输出键序固定：`type` → `properties` → `required` → `items` → `enum`
///   → `$defs` → 其余键按码点升序（P6 R2.9）——**不是全量字典序**，
///   必须与 TS 侧 `canonicalizeJsonSchema` 字节一致；
/// - 对象键重写方式：重建时按上述固定序逐键插入（【A2 审计修正】
///   本 workspace 无 preserve_order 双态（见 §2.4 修正）——排序插入是
///   防御性确定性 + 与 P6 R2.9 字节对齐，而非规避双态）。
pub fn canonicalize_schema(value: &Value) -> Value;

/// 确定性 JSON 序列化：递归把对象键按字典序排序后输出字符串。
///
/// 用途：
/// 1. 测试断言（preserve_order 双态下字节一致，见 P1 §2.4 发现）；
/// 2. P2 前缀哈希（comparison.md 2.6 的 buildStableCacheKey 的 Rust 侧
///    哈希输入）；
/// 3. tool_call arguments 的 wire 序列化（见 C2）。
pub fn canonical_json_string(value: &Value) -> String;
```

`canonicalize_schema` 实现要点（preserve_order 感知）：重建对象时**按排序后的键集合逐键插入**——preserve_order 开启时 IndexMap 保此插入序，未开启时 BTreeMap 自动排序，两种构建形态输出一致。`canonical_json_string` 同构：深度优先收集 `(key, value)` 排序后递归序列化。

#### A4. 接线点：`to_openai_tool` / `to_responses_tool` 内单点规范化

```rust
// crates/agent-provider/src/request/tools.rs
pub fn to_openai_tool(tool: &ToolDefinition) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": canonicalize_schema(&tool.effective_input_schema()),
        }
    })
}
```

所有工具（内置 + 未来 MCP）经此出口，schema 字节一致。**注意 `effective_input_schema`（tools.rs:22-30）返回克隆的 Value，canonicalize 在克隆上做，不污染注册表。**

### 3.3 B：system prompt 通路

#### B1. 参数通路（四层透传，单一规范化点）

```
前端 startRunTask{ systemPrompt }          （ConnectionLifecycle.ts:307，原样透传）
  → core_run_task(system_prompt)            （core_run_commands.rs:919-929 加参数）
  → SessionLoopOptions.system_prompt        （session-loop mod.rs:126 加字段）
  → ProviderRequest.system_prompt           （session-loop provider.rs:74 加字段）
  → RequestBuildContext.system_prompt       （engine.rs:218-233 透传）
  → messages.rs:325-329 前置 system 消息     （已有能力，接线即生效）
```

规范化只在入站做一次：

```rust
// crates/agent-provider/src/request/build.rs
/// system prompt 稳定构造（P1：单点规范化——trim + 单段化；空 → None）。
///
/// 前端 guidance 拼接（ConnectionLifecycle 的 base+"\n\n"+guidance）改为
/// 入站前完成（见 B2），Rust 侧只负责 trim 与空值归一，保证同一配置下
/// 字节确定。
pub fn build_system_prompt(system_prompt: Option<String>) -> Option<String> {
    let trimmed = system_prompt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    Some(trimmed)
}
```

调用点：`core_run_commands.rs` 装配 options 处（core_run_commands.rs:1019-1023 附近）调 `build_system_prompt(system_prompt)` 后存入 `SessionLoopOptions.system_prompt`。

#### B2. 前端 guidance 拼接函数化（消除形态漂移）

现状问题（ConnectionLifecycle.ts:233-247）：三形态拼接（`includes('Response style:')` 原样 / base+guidance / 仅 guidance），且 guidance 文案表（styleMap）与 systemPrompt 在文本层粘合——一旦 responseStyle 文案常量被编辑或 styleKey 变化，systemPrompt 全文变化，整个静态前缀作废。修复：

```ts
// apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts
/**
 * P1：systemPrompt 组装纯函数化——消除三形态漂移。
 * 规则：base 与 guidance 各自 trim 后按固定分隔符 "\n\n" 拼接；
 * guidance 为空 → 仅 base；base 为空 → 仅 guidance；两者皆空 → undefined。
 * 删除 base.includes('Response style:') 特殊分支（同一配置下形态唯一）。
 */
function composeSystemPrompt(
  base: string | undefined,
  guidance: string | undefined
): string | undefined { /* 纯函数实现 + 单测 */ }
```

`responseStyleSystemPrompt` 变量（ConnectionLifecycle.ts:200、237-250）改为 `guidance`（仅 styleMap 映射文案，不含 base），`systemPrompt = composeSystemPrompt(options?.systemPrompt, guidance)`（ConnectionLifecycle.ts:271-275 处）。**行为不变**（同配置下输出文案与现状相同），只把"拼接形态"收敛为单一函数并加测试。

#### B3. 动态内容后置原则（system prompt 稳定性纪律）

- **静态段**：systemPrompt（base + guidance）只依赖用户设置，不依赖 run/时间/会话状态。P1 期间动态内容为零注入，纪律先行：
  - system prompt 构造后整轮复用（pi:322-326 语义）——由 B1 的四层透传天然满足（options 在 run 内不可变）；
  - 禁止任何 handler 在 run 中途改写 system_prompt；
  - 未来动态内容（时间、cwd、memory）一律走"user 消息尾部追加"（与 D2 同一条纪律，参考 Reasonix `<memory-recall>` 尾部注入，deepseek-reasonix-cache-analysis.md:179-189）。
- **wire 形态**：保持 `SystemPromptWireMode::NativeSystemRole`（engine.rs:231 现状），system 消息固定第一条（messages.rs:325-329）。

### 3.4 C：消息构造确定性

#### C1. 字段顺序钉死（测试保障）

`ChatMessage::to_value` 插入序与 `build_chat_completions_request_body` 管线序已固定（§2.3/2.4），本方案以测试钉死（见 E1），不改代码结构。

#### C2. tool_call arguments 规范化序列化 + id 消毒

```rust
// crates/agent-provider/src/request/messages.rs
/// P1：tool_call id 规整为 [a-zA-Z0-9_-]（对齐 opencode scrub，
/// transform.ts:201-228）——部分 provider 回传非法 id 字符时，回放
/// 请求 400 且前缀漂移；幂等（已合法字符不变）。
pub fn sanitize_tool_call_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}
```

接线（messages.rs:352-360 assistant 分支 + :335-343 tool 分支）：
- `"id": call.id` → `"id": sanitize_tool_call_id(&call.id)`；
- `"arguments": serde_json::to_string(&call.input)` → `canonical_json_string(&call.input)`（preserve_order 双态下字节一致）。

**幂等性论证**：`canonical_json_string` 对相同语义 JSON 输出恒定；`sanitize_tool_call_id` 对已合法 id 无操作。两条都满足"历史字节不回改"——第二轮请求对同一历史消息映射出的 wire 与第一轮一致。

#### C3. DeepSeek 工具轮次 `reasoning_content` 键存在性（Require 语义落地）

```rust
// crates/agent-provider/src/request/messages.rs（Require 语义实现修正）
fn reasoning_content_object(message: &AgentMessage, mode: ReasoningContentMode) -> Option<String> {
    match mode {
        ReasoningContentMode::Omit => None,
        // P1：Require 模式无思考内容也回传空串——键存在性（DeepSeek
        // thinking 工具轮次缺键 400；空串兜底，Reasonix openai.go:669-680）
        ReasoningContentMode::Include => {
            let thought = thought_content(message);
            if thought.is_empty() { None } else { Some(thought) }
        }
        ReasoningContentMode::Require => {
            let thought = thought_content(message);
            Some(thought) // 空串也回传（to_value 对 Some("") 插入键，messages.rs:96-98）
        }
    }
}
```

```rust
// apps/agent-workbench/src-tauri/src/engine.rs（request_options 内）
/// P1：reasoning 键存在性按 vendor 推断——DeepSeek 工具循环轮次必须
/// 回传 reasoning_content（空串兜底），其余厂商 omit 保持现状。
fn reasoning_content_mode(&self) -> ReasoningContentMode {
    match infer_reasoning_vendor(Some(&self.config.base_url), Some(&self.config.model)) {
        ReasoningVendor::Deepseek => ReasoningContentMode::Require,
        _ => ReasoningContentMode::Omit,
    }
}
```

`request_options`（engine.rs:207-215）增加 `reasoning_content: Some(self.reasoning_content_mode())`。该字段是**请求级配置**（非历史字节），变化不会改写历史消息；对 DeepSeek 而言它是"每次都在"的稳定键，恰好消除"thinking 开→关"会话的前缀形态漂移（Reasonix 同款论证，deepseek-reasonix-cache-analysis.md:123）。

> 【A3 审计修正】（2026-08-03，A3-executability.md P0-1）：**本 C3 是 DeepSeek reasoning_content 键存在性的唯一实现**。P3 §3.4.1 曾设计第二套判定函数 `deepseek_reasoning_content_mode(vendor, effort_off)`（规则 2 主张 effort=off 时按历史字节 Include），与本 C3 的"恒 Require"语义**互斥**且落在同一代码点（`reasoning_content_object` + engine.rs 接线）。裁决：以本方案为准——工具轮次恒带 `reasoning_content` 键（空串兜底），消除 thinking 开关会话的前缀形态漂移（本 C3 论证）；P3 只提供 catalog 数据（`supports_reasoning` / effort 档位）作为本函数的输入，不再实现第二套判定。P3 文档已同步修正。

### 3.5 D：会话内 append-only 不变量

**不变量声明**（文档化 + 测试钉死）：

> 在一个 run 内，`state.conversation` 只允许通过 4 个追加点写入：`record_message`（handlers/mod.rs:150-158）、`commit_message_with_deltas`（streaming.rs:344-353）、`SteeringCoordinator::apply`（steering/mod.rs:270-289）、`with_initial_conversation*`（mod.rs:293-303，仅 run 创建时）。任何 handler 不得改写、重排、删除既有消息；动态内容（context 注入等）只允许在 user 消息入队时追加到其文本尾部。

- 现状已满足（§2.5），本方案做两件事：把该不变量写进代码注释（追加点标注 P1 不变量），并加测试（E2）保证未来改动不破坏。
- **水合只发生在 run 创建时**：`with_initial_conversation_arc`（mod.rs:300-303）是 P2 的历史回流入口，P1 先固定其语义——它在 `run()` 之前调用、一次生效，之后对话只增不改（与 jcode `locked_tools` 的"首轮快照"同一思路）。
- **与 P4 的对齐**：compaction 是唯一的"改写前缀"事件（Reasonix cache-reset 点），P1 不实现压缩，但把"压缩 = 唯一例外"写进不变量注释，P4 接线时以此为闸门。

### 3.6 E：测试设计

#### E1. 单元测试（两次构建字节一致）

| 测试 | 位置 | 断言 |
|---|---|---|
| `list_definitions_sorted_by_name_regardless_of_registration_order` | agent-tools registry 测试 | 乱序注册（z,a,m）→ 输出 [a,m,z]；`list()` 仍保注册序 |
| `canonicalize_schema_sorts_properties_and_required` | agent-provider schema 测试 | properties 键序与 required 数组排序 |
| `canonicalize_schema_const_to_enum` | 同上 | `{"const": 5}` → `{"enum":[5]}` |
| `canonicalize_schema_type_array_normalized` | 同上 | `["string","number","string"]` → 去重固定序 |
| `canonicalize_schema_ref_is_leaf` | 同上 | `$ref` 原样、不深入 |
| `canonicalize_schema_is_idempotent` | 同上 | `canonicalize(canonicalize(x)) == canonicalize(x)` |
| `canonical_json_string_is_order_independent` | 同上 | 同语义不同插入序的两个 Value → 相同字符串 |
| `to_openai_tool_bytes_stable_across_calls` | agent-provider tools 测试 | 同一 ToolDefinition 两次 `to_openai_tool` → `canonical_json_string` 相等（含规范化接线） |
| `request_body_bytes_identical_across_two_builds` | agent-provider build 测试 | 同 opts+context 两次 `build_chat_completions_request_body` → `to_string` 字节相等（同进程内对比，规避 preserve_order 双态） |
| `tool_call_arguments_canonical_serialization` | agent-provider messages 测试 | arguments 用规范序列化（键序无关） |
| `sanitize_tool_call_id_replaces_invalid_chars_and_is_idempotent` | 同上 | `"a b/c"` → `"a_b_c"`；`"call_1-2"` 不变；两次幂等 |
| `reasoning_content_require_emits_empty_string` | 同上 | Require 模式无思考 → `Some("")` 且 to_value 含键 |
| `tools_schema_snapshot_identical_across_build_requests` | session-loop 测试 | 两次 `build_request` → tools 快照同一引用/字节一致 |

#### E2. 集成测试（参考 codex prompt_caching.rs）

| 测试 | 位置 | 断言 |
|---|---|---|
| `two_turn_tool_loop_keeps_request_prefix_byte_stable` | session-loop 集成测试（复用 TestProvider.requests()，testing/mod.rs:111） | 脚本：call1 = ToolCall + Stop(ToolCall)，call2 = TextDelta + Stop；注册 echo 工具；run 后 `requests()[0].tools` 与 `requests()[1].tools` 的 canonical 序列化相等（对齐 codex `prompt_tools_are_consistent_across_requests`）；`requests()[1].messages[0]` 与 `requests()[0].messages[0]` 内容相等（前缀复用），messages[1..] 为追加段（对齐 codex `prefixes_context_and_instructions_once_and_consistently`） |
| `system_prompt_stable_across_runs_same_settings` | session-loop 集成测试 | 同 settings（system_prompt 相同）两次 run → 首次请求的 system 段字节一致（用 `with_initial_conversation_arc` 续接模拟跨 run） |
| `conversation_is_append_only_within_run` | session-loop 集成测试 | 工具循环 run 后：`RunOutcome.messages` 中每条消息的 Arc 内容与请求快照顺序一致，无重排/改写（append-only 不变量） |
| `build_context_passes_system_prompt_and_is_stable` | agent-workbench（app crate）engine 测试 | `build_context` 透传 `system_prompt`；两次构建上下文相同请求 → body 字节一致 |
| `compose_system_prompt_forms_are_canonical` | 前端 vitest（ConnectionLifecycle.tauri.test.ts） | 三形态（base / guidance / 两者）输出唯一确定；`systemPrompt` 参数出现在 startRunTask 调用中 |

#### E3. 测试命令（验收用）

```
cargo test -p agent-tools
cargo test -p agent-provider
cargo test -p session-loop
cargo test --workspace                      # 73 套件基线
npm run typecheck
npx vitest run src                          # 基线失败集中在既有 4 处，见第 5 节
```

---

## ④ 实施步骤（每步：改哪个文件、怎么改、为什么）

按依赖序分 4 个阶段，每阶段可独立提交（feat 域：`feat(cache-prefix)` 或按仓库风格拆 scope）。

### 阶段 1：tools 确定性（A）

**步骤 1.1** —— `crates/agent-tools/src/registry.rs`
- 改：`list_definitions`（registry.rs:63-68）内排序（§3.2 A1）。
- 加测试：`list_definitions_sorted_by_name_regardless_of_registration_order`（现有 `list_definitions_in_order_with_schema`（registry.rs:157-171）是顺序注册，不受影响；`list_preserves_registration_order`（registry.rs:126-133）断言 `list()`，不受影响）。
- 为什么：一行改动对齐 jcode/TS formatStableTools，消除注册序漂移；排序在输出面做，不碰执行面。

**步骤 1.2** —— 新增 `crates/agent-provider/src/request/schema.rs`
- 改：实现 `canonicalize_schema` + `canonical_json_string`（§3.2 A3）+ 全部单测。
- 在 `request/mod.rs`（mod.rs:11-14）挂 `pub mod schema;` 并 re-export 两函数。
- 为什么：schema 规范化是 tools 字节稳定与 P2 前缀哈希的公共基础，独立模块避免塞进 tools.rs 或 build.rs；`canonical_json_string` 同时服务测试（preserve_order 双态）与未来 P2。

**步骤 1.3** —— `crates/agent-provider/src/request/tools.rs`
- 改：`to_openai_tool`（tools.rs:38-47）与 `to_responses_tool`（tools.rs:50-58）的 `parameters` 改为 `canonicalize_schema(&tool.effective_input_schema())`；import `super::schema::canonicalize_schema`。
- 加测试：`to_openai_tool_bytes_stable_across_calls` + 现有 shape 测试（tools.rs:107-131）更新为期望规范化输出（如 properties 排序）。
- 为什么：wire 出口单点接线，所有工具统一规范化；`to_responses_tool` 同步处理防止 Responses 端点将来接入时漂移。

**步骤 1.4** —— `crates/session-loop/src/loop/handlers/mod.rs` + `streaming.rs`
- 改：`LoopState` 增加 `tools_snapshot: Option<Vec<ToolSchema>>`（handlers/mod.rs:55-85 结构体 + :89-112 构造器初始化 None）；`streaming.rs` 新增 `ensure_tools_snapshot`、`tools_schema` 改为返回 `&[ToolSchema]`（§3.2 A2）；`streaming::handle`（streaming.rs:47-48）在 `build_request` 前调 `ensure_tools_snapshot`。
- 加测试：`tools_schema_snapshot_identical_across_build_requests`（session-loop 单测：构造 LoopState，两次 ensure+build，快照字节一致且为同一缓存）。
- 为什么：工具循环轮次间复用同一快照（对齐"首轮锁定"），即使未来注册表引入运行时注册路径，run 内也稳定；借用形态 `&[ToolSchema]` 与 ProviderRequest 的 `Vec<ToolSchema>` 需要一次克隆——权衡后保留 `ProviderRequest.tools: Vec<ToolSchema>` 不变（provider.rs:78），`build_request` 里 `ensure_tools_snapshot` 后 `tools_snapshot.clone()`（8 个内置工具，克隆成本可忽略；避免动 ProviderCall 冻结契约，AU-04 F1）。

### 阶段 2：system prompt 通路（B）

**步骤 2.1** —— `crates/agent-provider/src/request/build.rs`
- 改：新增 `build_system_prompt`（§3.3 B1）+ 单测（trim/空值/None）。
- re-export：`request/mod.rs:16-19` 的 `pub use build::{...}` 增加 `build_system_prompt`。
- 为什么：规范化单点；agent-provider 是请求构造真源，前端/上层不感知拼接规则。

**步骤 2.2** —— `crates/session-loop/src/loop/mod.rs`（SessionLoopOptions）+ `crates/session-loop/src/provider.rs`（ProviderRequest）
- 改：`SessionLoopOptions`（mod.rs:126-156）增加 `pub system_prompt: Option<String>`；`Default`（mod.rs:158-173）补 `None`；`default_options_match_documented_defaults` 测试（mod.rs:546-558）补断言。
- 改：`ProviderRequest`（provider.rs:74-81）增加 `pub system_prompt: Option<&'a str>`；`build_request`（streaming.rs:253-259）填充 `system_prompt: state.options.system_prompt.as_deref()`。
- 为什么：system prompt 进入 run 的调用上下文（ProviderRequest 是"本次调用的全部上下文"，provider.rs:64-81 注释语义），engine 侧从 request 读取而非再开一路状态。

**步骤 2.3** —— `apps/agent-workbench/src-tauri/src/engine.rs`
- 改：`build_context`（engine.rs:218-233）的 `system_prompt: None` → `system_prompt: request.system_prompt.map(str::to_string)`；`request_options`（engine.rs:207-215）增加 `reasoning_content: Some(self.reasoning_content_mode())`（§3.4 C3，vender 推断函数一并加）。
- 为什么：两处修复合一（system prompt 透传 + DeepSeek reasoning 键存在性）；engine.rs:246 的 body 构建路径不变。

**步骤 2.4** —— `apps/agent-workbench/src-tauri/src/core_run_commands.rs`
- 改：`core_run_task` 签名（core_run_commands.rs:919-929）增加 `system_prompt: Option<String>`；装配 options（core_run_commands.rs:1019-1023）增加 `system_prompt: build_system_prompt(system_prompt),`。
- 为什么：修复"前端参数被 serde 静默丢弃"；入站规范化一次（步骤 2.1 的函数），全链透传原始。

**步骤 2.5** —— `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts`
- 改：新增 `composeSystemPrompt` 纯函数（§3.3 B2），删除 `base.includes('Response style:')` 特殊分支；`responseStyleSystemPrompt` 改名为 `responseStyleGuidance`（只含 styleMap 文案）；`systemPrompt = composeSystemPrompt(base, guidance)`。
- 改测试：`ConnectionLifecycle.tauri.test.ts:128-142` 增加 `systemPrompt` 断言；新增 composeSystemPrompt 三形态单测。
- 为什么：消除拼接形态漂移；透传行为不变（参数名仍为 systemPrompt）。

### 阶段 3：消息构造确定性（C）

**步骤 3.1** —— `crates/agent-provider/src/request/messages.rs`
- 改：`sanitize_tool_call_id`（§3.4 C2）；assistant 分支（messages.rs:352-360）id 消毒 + arguments 用 `canonical_json_string`；tool 分支（messages.rs:335-343）tool_call_id 消毒；`reasoning_content_object` 的 Require 语义落地（§3.4 C3）。
- 加测试：`sanitize_tool_call_id_*`、`tool_call_arguments_canonical_serialization`、`reasoning_content_require_emits_empty_string`。
- 注意：`role_map`/`wire_value_shape`（messages.rs:803-816）等既有测试断言 `arguments` 为 `{"path":"/a"}`（messages.rs:630）——规范化序列化在无 preserve_order 的测试 build 下输出相同（BTreeMap 本来就排序），断言不破。
- 为什么：wire 层单点；id 消毒幂等保证历史不回改；arguments 规范化消除跨构建字节差。

### 阶段 4：append-only 纪律 + 集成测试（D/E）

**步骤 4.1** —— `crates/session-loop/src/loop/handlers/mod.rs`（注释）、`streaming.rs`（注释）、`mod.rs`（注释）
- 改：在 4 个追加点（§2.5）与 `with_initial_conversation_arc` 处补充 P1 不变量注释（"本函数是 append-only 追加点之一；改写既有消息会破坏请求前缀，任何新写入必须追加尾部"）。
- 为什么：把纪律写进代码，评审/未来 agent 可审计。

**步骤 4.2** —— `crates/session-loop/src/loop/handlers/streaming.rs`（测试模块）或新测试文件
- 加：E2 三个集成测试（`two_turn_tool_loop_keeps_request_prefix_byte_stable`、`system_prompt_stable_across_runs_same_settings`、`conversation_is_append_only_within_run`），复用 `TestProvider.requests()`（testing/mod.rs:111）与 `RequestSnapshot`（testing/mod.rs:244-262）；tools 字节断言经 `canonical_json_string`（步骤 1.2 的函数，session-loop 需依赖 agent-provider？——不，session-loop 不依赖 agent-provider（provider.rs:1-22 契约注释）。**处理**：tools 断言在 session-loop 侧用 `serde_json::to_string(&schema)` 直接序列化（ToolSchema 三字段结构确定，工具内无嵌套对象顺序问题——input_schema 是 Value，其中 properties 键序在 session-loop 测试 build 下是 BTreeMap 排序，两次构建同 build 对比仍成立）。若需要与 app build 一致的断言，把 input_schema 规范化断言放 agent-provider 单测（步骤 1.2/1.3 已覆盖）。
- 为什么：session-loop 不依赖 agent-provider 的架构约束（provider.rs:1-22）决定集成断言在 loop 层用自身形态（ProviderRequest/ToolSchema），wire 字节断言下沉到 agent-provider。

**步骤 4.3** —— `apps/agent-workbench/src-tauri/src/engine.rs`（测试模块）
- 加：`build_context_passes_system_prompt_and_is_stable`（透传 + 两次构建字节一致，同进程对比）。
- 为什么：app crate 是唯一同时看到 request 构造与 preserve_order 的构建，端到端字节断言放这里最真实。

---

## ⑤ 验收标准

### 5.1 功能验收（对照方案主题逐条）

| # | 验收项 | 验证方式 |
|---|---|---|
| 1 | `list_definitions` 输出按 name 升序，与注册序无关 | `cargo test -p agent-tools` 新单测 |
| 2 | schema 规范化幂等且覆盖 properties/required/const/type 数组/$ref | `cargo test -p agent-provider` schema 单测 |
| 3 | 同一 run 内工具循环两次请求的 tools 字节一致 | `cargo test -p session-loop` 集成测试 |
| 4 | `core_run_task` 接收 systemPrompt 并到达请求体 system 消息 | `cargo test --workspace` + app 集成测试；前端 `ConnectionLifecycle.tauri.test.ts` 参数断言 |
| 5 | 同配置跨 run system 段字节一致 | `cargo test -p session-loop` 集成测试 |
| 6 | 前端 guidance 拼接单一形态（composeSystemPrompt 纯函数） | `npx vitest run src` 新单测 |
| 7 | DeepSeek 工具轮次 assistant 消息必带 `reasoning_content` 键（空串兜底） | `cargo test -p agent-provider` Require 单测 |
| 8 | tool_call id 消毒幂等、arguments 规范化序列化 | `cargo test -p agent-provider` messages 单测 |
| 9 | 对话 append-only（追加点清单 + 无改写路径） | `cargo test -p session-loop` 不变量集成测试 |
| 10 | 请求体两次构建字节一致 | `cargo test -p agent-provider` build 单测 + app 集成测试 |

### 5.2 测试命令（全部通过为验收）

```
cargo test -p agent-tools
cargo test -p agent-provider
cargo test -p session-loop
cargo test --workspace
npm run typecheck
npx vitest run src
```

- `cargo test --workspace` 基线 73 套件：本方案新增测试为增量，不允许破坏既有套件。
- 前端基线已知失败集中在 `oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf`（AGENTS.md 登记）：P1 改动文件（ConnectionLifecycle.ts、其测试）不触碰这些套件；若 `npx vitest run src` 出现**新增**失败，必须修复后合入。

### 5.3 字节级验收样例（手工复核路径）

带 `systemPrompt` 发起 run → 工具循环两轮 → 抓取两次请求体（tracing 或断点）：
- 两次请求的 `tools` 数组 `to_string` 完全一致；
- 第二次请求的 `messages[0..n]` 与第一次请求 `messages` 完全一致（仅尾部追加）；
- system 消息始终是 `messages[0]`。

---

## ⑥ 风险与依赖

### 6.1 对 P4（历史回流）的依赖与提供给 P4 的接口

【A1 审计修正】本节原稿整体指向 P2（"历史回流 / P2 前缀哈希"），归属错误：历史回流与 `with_initial_conversation_arc` 水合属 **P4**（P4 §3.2 路线 A/B 混合），P2 的缓存键为会话 ID 派生（P2 §3.1.1、P6 R3），**不做内容哈希**（buildStableCacheKey 内容哈希已被 P2/P6 明确废弃）。以下为本节修正后的契约。

- **依赖关系**：P1 不实现历史回流，但 **P4 水合**（P4 §3.2.3：core_run_task 增加 history + `SessionHistoryCache` + `with_initial_conversation_arc`）只有在 P1 的前缀稳定工程落地后才有收益——回流之后，前缀 = system + tools + 历史，P1 保证这三段各自的字节稳定性。
- **提供给 P4 的接口**：
  1. `canonical_json_string`（agent-provider::request::schema）——稳定序列化基础（P4 前缀哈希投影、P5 签名捕获可复用；P1 自身测试也用）；
  2. `ProviderRequest.system_prompt` 字段——水合后 system 段的前置已有通路；
  3. `with_initial_conversation_arc` 语义固定（run 创建时一次性、之后 append-only）。
- **与 P2 的衔接**：P1 不向 P2 交付接口；P2 的断点/键注入只依赖 P1 保证的"前缀字节稳定"（P2 §6.1 已登记为硬依赖）。
- **P4 完成前 P1 的即时价值**：同一 run 内工具循环多轮请求（DeepSeek 自动缓存按 64-token 块结算）从"tools 每轮重建 + 无 system"变为"system+tools 字节稳定"，轮内多轮调用即可开始命中；`reasoning_content` 键存在性同时修复 DeepSeek 工具循环潜在 400。

### 6.2 与其他计划的边界

| 计划 | 边界 |
|---|---|
| P2（wire 缓存参数/键稳定） | 不做 history 参数（历史回流归 P4）；P2 的断点/键注入依赖 P1 的前缀稳定才有命中对象 |
| P3（厂商/模型开关与数据） | 不注入断点、不建 CacheControl 载体（messages.rs:62-104 的 ChatMessage 不新增字段，载体由 P2 步骤 2 增加）；P3 只提供开关数据与模型目录 |
| P4（历史回流/上下文管理） | P1 不做 history 参数、不做压缩接线；`with_initial_conversation_arc` 语义固定由 P1 提供，P4 §3.2 消费 |
| 串行注意（同文件） | `engine.rs`（P1 步骤 2.3 × P2 步骤 4 × P3 步骤 4 × P4 阶段 1 × P5 S5）、`request/messages.rs`（P1 阶段 3 × P2 步骤 2 × P3 步骤 4）、`request/build.rs`（P1 步骤 2.1 × P2 步骤 3 × P3 步骤 4）、`session-loop provider.rs`（P1 步骤 2.2 × P2 步骤 4 的 ProviderRequest 同 struct）、`core_run_commands.rs`（P1 步骤 2.4 × P4 阶段 1 的 core_run_task 同签名）——按 P1 → P2 → P3 → P4 → P5 串行，同文件改动合并提交【A1 审计修正：原稿 P2 行把"历史回流"归 P2、P3 行把"断点注入"归 P3，均归属错误，已改为 P4/P2 职责】 |
| P4（压缩/恢复） | 不改 stream_error.rs 恢复阶梯（只读引用其 length_ladder）；不接 CompactionEngine；P4 的"压缩 = 唯一 cache-reset 点"与 P1 的 append-only 不变量在注释层对齐（§3.5） |
| 测量层 agent（usage/命中率） | 不做命中率统计与展示；`reasoning_content` Require 只改请求侧，不动 parse/usage |

### 6.3 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| **preserve_order 双态**：app build（schemars→tauri）开启 serde_json preserve_order（IndexMap 保插入序），crate 级测试 build 未开启（BTreeMap 排序）——同一代码两种字节行为 | 高 | ① 所有跨形态字节断言走 `canonical_json_string` 或同进程两次构建对比；② `canonicalize_schema` 重建时按键排序插入，两种形态输出一致；③ 验收标准 5.3 的手工复核走真实 app 路径 |
| tools 排序改变模型可见顺序 | 低 | DeepSeek/OpenAI 兼容端点无工具位置语义；jcode/opencode 均排序或固定序，无负面反馈；排序只在 `list_definitions` 输出面 |
| systemPrompt 首次真正到达模型（行为变化） | 中 | 这是修复"参数被丢弃"，模型行为从"无 system"变为"有 system"——需在 UI 侧确认文案（前端 guidance 文案保持不变，仅通路打通）；P1 合入说明中标注 |
| 前端 guidance 改动引入回归 | 低 | composeSystemPrompt 纯函数 + 既有 ConnectionLifecycle 测试更新；文案常量（styleMap）不动 |
| `reasoning_content` Require 模式对非 DeepSeek 厂商副作用 | 低 | 只在 vendor=DeepSeek 时启用（engine.rs 推断）；其余厂商保持 Omit（现状） |
| 工具循环集成测试的字节断言在 session-loop 层不可达 wire | 低 | session-loop 不依赖 agent-provider（provider.rs:1-22）；loop 层断言 ProviderRequest 形态稳定，wire 字节断言下沉 agent-provider 单测与 app 集成测试（步骤 4.2 说明） |
| 与既有测试的冲突 | 低 | `list_preserves_registration_order`（registry.rs:126-133）断言 `list()` 不受排序影响；`list_definitions_in_order_with_schema`（registry.rs:157-171）顺序注册，排序后断言仍成立；messages 既有 arguments 断言（messages.rs:630）在无 preserve_order 测试 build 下不破 |

### 6.4 未决问题（合入前需裁决）

1. `systemPrompt` 透传后，前端 styleMap 的 guidance 是否未来下沉为"前端只传 styleKey、Rust 维护文案表"（彻底静态化）？P1 选择最小改动（前端拼好传值，Rust 只做规范化），文案表下沉留待 P2 静态/动态拆分时评估。
2. `canonical_json_string` 是否同时用于**请求体发送序列化**（reqwest `.json()` 之外自定义序列化器）？P1 只用于工具 schema/arguments 与测试/哈希；全请求体规范化发送涉及 wire 行为变化（键序改变），暂不做，记入 P2 候选。

---

## 附：参考调研锚点索引（本方案引用）

| 引用点 | 调研文档 |
|---|---|
| jcode `sort_by(name)` / 快照锁定 / static-dynamic 拆分 / 前缀不变量测试 | jcode-cache-analysis.md:36-49、70-79、299-318 |
| opencode tools 排序 / schema 规范化 / strict:false / reasoning 补齐 / toolCallId 消毒 | opencode-cache-analysis.md:180-187、258-259 |
| codex 固定流水线序 / prompt_caching.rs 集成断言 / instructions 确定性 | codex-cli-cache-analysis.md:153-154、160-170 |
| Reasonix append-only / 记忆折叠 / reasoning_content 空串兜底 / 字节稳定优先 | deepseek-reasonix-cache-analysis.md:11-25、116-127、255-281 |
| pi system prompt 整轮复用 | pi-cache-analysis.md:322-326 |
| 百炼工具定义字节一致要求 | vendor-cache-mechanisms.md:359、420-424 |
| crish 对比缺口与优先级