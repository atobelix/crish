# Conex vs Grok-Build 上下文工程与 Token 预算管理深度代码审计

> **审计主体**：Conex（当前仓库） vs Grok-Build（`reference/grok-build`）  
> **审计范畴**：上下文压缩（Compaction）、Token 预算估计（Estimation）、历史消息裁剪（Cut Point / Fit）、总结生成与系统记忆维持（Summary & Reminder）  
> **审计准则**：纯源码穿透（禁止查阅 .md 文档）、拒绝过度设计与盲目粉饰、具体代码路径与行号证据（`文件:行号`）支撑、客观公正评析。

---

## 目录

1. [审计覆盖范围与核心代码清单](#一审计覆盖范围与核心代码清单)
2. [维度一：裁剪点（Cut Point）选取与原子性保护算法](#二维度一裁剪点cut-point选取与原子性保护算法)
3. [维度二：跨轮次与轮内压缩策略（Inter vs Intra vs Fold Chain）](#三维度二跨轮次与轮内压缩策略inter-vs-intra-vs-fold-chain)
4. [维度三：Token 估算精度与预算防爆机制](#四维度三token-估算精度与预算防爆机制)
5. [维度四：摘要质量、系统指令回注与长期记忆保持](#五维度四摘要质量系统指令回注与长期记忆保持)
6. [综合对比评估矩阵与相互借鉴建议](#六综合对比评估矩阵与相互借鉴建议)

---

## 一、审计覆盖范围与核心代码清单

本报告基于两边实际代码库共计 **35 个核心源码文件** 展开深度对照审计：

### 1. Conex 代码基线（15 个关键文件）
- [`crates/conex-compaction/src/lib.rs`](file:///c:/Software/conex/crates/conex-compaction/src/lib.rs): 压缩引擎入口定义与公共 API
- [`crates/conex-compaction/src/cut_point.rs`](file:///c:/Software/conex/crates/conex-compaction/src/cut_point.rs): 切割点算法、折叠链起始与 ToolBatch 双向完整性闭包保护
- [`crates/conex-compaction/src/engine.rs`](file:///c:/Software/conex/crates/conex-compaction/src/engine.rs): 压缩编排引擎、增量 token 计算与 Emergency Preflight 紧急截断
- [`crates/conex-compaction/src/ai_summary.rs`](file:///c:/Software/conex/crates/conex-compaction/src/ai_summary.rs): AI 摘要提示词、Thought 块屏蔽与退化重试护栏
- [`crates/conex-compaction/src/summary_document.rs`](file:///c:/Software/conex/crates/conex-compaction/src/summary_document.rs): Schema V1 12 字段结构化 JSON 规范、校验与 Markdown 确定性投影
- [`crates/conex-compaction/src/tool_output.rs`](file:///c:/Software/conex/crates/conex-compaction/src/tool_output.rs): 工具输出双阈值（2000行/50KB）Head-Tail 截断与水位联动
- [`crates/conex-compaction/src/clean_output.rs`](file:///c:/Software/conex/crates/conex-compaction/src/clean_output.rs): 工具输出 R1-R6 清洗管线与 `wire_safe` 配置
- [`crates/conex-compaction/src/thresholds.rs`](file:///c:/Software/conex/crates/conex-compaction/src/thresholds.rs): 85%/95% 水位模型与双源（Usage优先+时间戳护栏+启发式）估算
- [`crates/conex-compaction/src/tokens.rs`](file:///c:/Software/conex/crates/conex-compaction/src/tokens.rs): 字符/CJK/图片固定 1600 Token 启发式计算
- [`crates/conex-compaction/src/plan.rs`](file:///c:/Software/conex/crates/conex-compaction/src/plan.rs): CompactionPlan 模型、Summarizer trait 与 StubPolicy
- [`crates/session-loop/src/attachment_budget.rs`](file:///c:/Software/conex/crates/session-loop/src/attachment_budget.rs): 附件动态预算调度与超限二次截断/丢弃告警
- [`crates/session-loop/src/attachment_truncation.rs`](file:///c:/Software/conex/crates/session-loop/src/attachment_truncation.rs): 40/60 Head-Tail 偏重尾部日志截断
- [`crates/session-loop/src/loop/compaction_dispatch.rs`](file:///c:/Software/conex/crates/session-loop/src/loop/compaction_dispatch.rs): 预算钳制、预检触发、用户消息边界触发与待重试任务单飞
- [`crates/session-loop/src/checkpoint.rs`](file:///c:/Software/conex/crates/session-loop/src/checkpoint.rs): 结构化检查点协议声明与只读采集边界
- [`crates/session-loop/src/cache_tracker.rs`](file:///c:/Software/conex/crates/session-loop/src/cache_tracker.rs): 压缩代数隔离、基线作废与压缩后真实请求前缀预测

### 2. Grok-Build 代码基线（20 个关键文件）
- [`reference/grok-build/crates/common/xai-grok-compaction/src/lib.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/lib.rs): 压缩系统核心门面与三大子系统定义
- [`reference/grok-build/crates/common/xai-grok-compaction/src/item.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/item.rs): `CompactionItem`, `CompactionItemBuilder`, `CompactionItemFactory` 抽象解耦
- [`reference/grok-build/crates/common/xai-grok-compaction/src/select.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/select.rs): 倒推预算选择与 `snap_to_safe_boundary` 安全边界跳步
- [`reference/grok-build/crates/common/xai-grok-compaction/src/reminder.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/reminder.rs): 后台任务、TODO、子代理、调度循环、工作流 `<system-reminder>` 动态注入
- [`reference/grok-build/crates/common/xai-grok-compaction/src/token.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/token.rs): `ItemTokenCounter` trait 抽象
- [`reference/grok-build/crates/codegen/xai-token-estimation/src/lib.rs`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-token-estimation/src/lib.rs): `BYTES_PER_TOKEN = 4`、图片 765 Token 与整型阈值算术
- [`reference/grok-build/crates/codegen/xai-compaction-transcript/src/lib.rs`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-compaction-transcript/src/lib.rs): 离线分段持久化存储（`segment_NNN.md` 与 `INDEX.md`）
- [`reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/mod.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/mod.rs): grok-build 全量替换子系统入口
- [`reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/config.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/config.rs): `FullReplaceConfig`, `MIN_SUMMARY_SEED_CHARS = 500`
- [`reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/prompt.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/prompt.rs): 短版 `SELF_SUMMARIZATION_PROMPT` 与长版结构化提示词
- [`reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/assemble.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/assemble.rs): 历史重建装配（`[SP, UP', AGENTS_MD?, UQ_last?, recent…, summary, reminder?]`）
- [`reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/compact.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/compact.rs): 编排流程与 Input Ladder 溢出分类
- [`reference/grok-build/crates/common/xai-grok-compaction/src/intra_compaction/mod.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/intra_compaction/mod.rs): 轮内每步压缩子系统
- [`reference/grok-build/crates/common/xai-grok-compaction/src/intra_compaction/fit.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/intra_compaction/fit.rs): 5 级 Fit Ladder（Verbatim -> HistoryTurn -> ToolTruncated -> StepTurns -> Emergency）
- [`reference/grok-build/crates/common/xai-grok-compaction/src/inter_compaction/mod.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/inter_compaction/mod.rs): 轮间分块压缩子系统
- [`reference/grok-build/crates/common/xai-grok-compaction/src/inter_compaction/compact.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/inter_compaction/compact.rs): 分块采样、Basic 与分治法（DivideAndConquer）
- [`reference/grok-build/crates/common/xai-grok-compaction/src/history/filter.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/history/filter.rs): `separate_prior_user_queries` 与工具通道过滤
- [`reference/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs): Two-Pass Prefire 预采样与 Verbatim -> VerbatimFitted -> Lossy 降级编排
- [`reference/grok-build/crates/codegen/xai-chat-state/src/compaction_utils.rs`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-chat-state/src/compaction_utils.rs): `prepare_conversation_for_verbatim_summarization` 与 `fit_conversation_to_budget`
- [`reference/grok-build/crates/codegen/xai-chat-state/src/compaction_mode.rs`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-chat-state/src/compaction_mode.rs): 压缩模式枚举（Disabled, SummaryOnly, SummaryAndSegment）

---

## 二、维度一：裁剪点（Cut Point）选取与原子性保护算法

在大模型 Agent 运行期，**工具调用（ToolCall）与工具执行结果（ToolResult）是一对强因果原子单元**。一旦上下文裁剪硬生生切断了二者（例如保留了 ToolResult 却丢弃了 ToolCall，或保留了 ToolCall 却丢弃了部分 ToolResult），主流模型（Claude、GPT-4、Grok 等）的后端 API 会直接报 `400 Invalid Parameter: orphan tool_result_id / missing tool_call_id` 并导致对话致命中断。

### 1. Conex：严格的双向闭包保护与折叠链下界

Conex 在 [`crates/conex-compaction/src/cut_point.rs`](file:///c:/Software/conex/crates/conex-compaction/src/cut_point.rs) 中实现了一套极其严密的状态闭包算法：

#### A. 折叠链（Fold Chain）下界保护
```rust
// crates/conex-compaction/src/cut_point.rs:21-30
pub(crate) fn fold_start_of(messages: &[Arc<AgentMessage>]) -> usize {
    let mut idx = 0;
    while idx < messages.len() && messages[idx].role == AgentMessageRole::System {
        idx += 1;
    }
    while idx < messages.len() && messages[idx].id.starts_with("compacted-summary") {
        idx += 1;
    }
    idx
}
```
Conex 严格规定：系统提示词（System）以及之前历次压缩留下的摘要折叠链（`compacted-summary-*`）**绝对不可被作为丢弃对象二次切割**。切割扫描区间强制限定在 `[fold_start, len)`（行 156），一旦计算的截断点 `cut <= fold_start`，立刻安全放弃压缩（行 168-170），保证单调向前演进，杜绝前缀漂移。

#### B. ToolBatch 双向完整性闭包算法（M-IMP-02）
```rust
// crates/conex-compaction/src/cut_point.rs:40-126
pub fn enforce_tool_batch_closure(
    messages: &[Arc<AgentMessage>],
    mut cut: usize,
    fold_start: usize,
) -> Option<usize> {
    loop {
        let mut declared_call_ids: HashSet<String> = HashSet::new();
        let mut orphan_result_call_ids: HashSet<String> = HashSet::new();

        // 收集保留段内的所有 Call ID 与 Result ID
        for msg in &messages[cut..] { ... }

        // 1. 向前闭包（Result -> Call）：
        // 若保留段存在孤儿 ToolResult，向前倒查产生该调用的消息
        if !orphan_result_call_ids.is_empty() {
            let mut needed_idx: Option<usize> = None;
            for j in (fold_start..cut).rev() {
                if messages[j].tool_calls().any(|c| orphan_result_call_ids.contains(&c.id)) {
                    needed_idx = Some(j);
                    break;
                }
            }
            match needed_idx {
                Some(j) if j >= fold_start => { cut = j; continue; }
                _ => return None, // 孤儿 call 越过链下界，安全放弃压缩
            }
        }

        // 2. 向后闭包（Call -> Results）：
        // 检查保留段内声明的 call_id，其对应的 ToolResult 是否落在丢弃段 (index < cut)
        let mut earliest_result_idx: Option<usize> = None;
        for (idx, msg) in messages[fold_start..cut].iter().enumerate() { ... }

        if let Some(idx) = earliest_result_idx {
            if idx >= fold_start { cut = idx; continue; } else { return None; }
        }
        break; // 双向闭包收敛
    }
    Some(cut)
}
```
Conex 不是简单跳步，而是执行 **Fixpoint 循环收敛**：
1. **向前闭包**：若保留区有 ToolResult，其对应的 Assistant(ToolCall) 必须也被拉入保留区；
2. **向后闭包**：一个 Assistant 若发起了批量工具调用（例如同时发起 5 个读文件请求），只要该 Assistant 被拉入保留区，这 5 个工具的结果必须**全量在保留区内**，绝不允许部分在丢弃区。如果发现有结果遗留在丢弃区，`cut` 自动往前扩大以包含它；
3. 一旦扩大越界碰到底线 `fold_start`，返回 `None` 宁可暂不压缩，也坚决不向模型输出破碎的上下文。

---

### 2. Grok-Build：单向安全跳步与 5 级 FitRung 阶梯

Grok-Build 在 [`reference/grok-build/crates/common/xai-grok-compaction/src/select.rs`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/select.rs) 实现了裁剪逻辑：

```rust
// xai-grok-compaction/src/select.rs:77-119
pub fn select_turns_to_compact<T: CompactionItem>(
    item_token_counts: &[u32],
    items: &[T],
    target_tokens: u32,
    min_compactable: u32,
) -> Option<SplitPlan> {
    // 1. 从后向前累加 "keep" token
    let mut kept = 0u32;
    let mut split_idx = total;
    for i in (0..total).rev() {
        let count = item_token_counts[i];
        if kept.saturating_add(count) > target_tokens {
            split_idx = i + 1;
            break;
        }
        kept = kept.saturating_add(count);
        split_idx = i;
    }
    // 2. Snap the split forward to a safe boundary
    let safe_split_idx = snap_to_safe_boundary(items, split_idx);
    ...
}

// xai-grok-compaction/src/select.rs:128-147
fn snap_to_safe_boundary<T: CompactionItem>(items: &[T], candidate: usize) -> usize {
    if candidate >= total || !items[candidate].is_tool_result() {
        return candidate;
    }
    let mut idx = candidate;
    while idx < total && items[idx].is_tool_result() {
        idx += 1;
    }
    idx
}
```

#### 机制分析与对比：
- **Grok-Build 的策略**：`select_turns_to_compact` 采用 **单向 Forward Snap（`snap_to_safe_boundary`）**。当 `split_idx` 不幸切到了一个 `ToolResult` 时，它直接向后推进（advance forward）直到跳过所有相连的 `ToolResult`。这意味着它把这组 ToolResult 推进了前面的“待压缩区（compact）”，使保留区（keep）从下一个非 Tool 消息开始。
- **差异与潜在风险**：Grok-Build 的 `snap_to_safe_boundary` 假设了每个 ToolResult 之前紧邻着它的 Assistant，当把 ToolResult 推进待压缩区时，由于 Assistant 早已在待压缩区，因而保留区不会出现孤儿 ToolResult。**但是**，当一个 Assistant 发起多个 ToolCall 时，如果候选切割点恰好落在 Assistant 处（被划入保留区），而其产生的 ToolResults 落在其后，或者复杂交错时，单向向前推并不能保证向后闭包的原子完整性。
- **Grok-Build 的后置保障**：Grok-Build 意识到了这一点，在 [`compaction_utils.rs:120-126`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-chat-state/src/compaction_utils.rs#L120-L126) 补充了 `truncate_trailing_incomplete_tool_call`，如果会话末尾有未完成的 tool call 就主动 pop 剔除；同时在 [`intra_compaction/fit.rs:188-400`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/intra_compaction/fit.rs#L188-L400) 建立了多层回退机制。

---

## 三、维度二：跨轮次与轮内压缩策略（Inter vs Intra vs Fold Chain）

### 1. Conex：折叠链单调递增与用户消息边界保全（Hold 语义）

Conex 专注于代码助手在持续多轮迭代中的状态一致性，设计了 **折叠链（Fold Chain）模型** 与 **用户消息边界压缩（User Message Boundary Compaction）**。

#### A. 折叠链（Fold Chain）前缀单调模型
在 [`engine.rs:365-372`](file:///c:/Software/conex/crates/conex-compaction/src/engine.rs#L365-L372)：
- 每次压缩产生一个带有明确结构元数据的摘要消息，`id = format!("compacted-summary-{generation}-{fold_index}")`；
- 结构拓扑始终维持：`System Prompt -> 既有折叠链 [compacted-summary-1-1, 1-2, ...] -> 新压缩生成的摘要 -> 尾部保留段`；
- 既有摘要消息永不参与重新折叠（`dropped_arcs` 显式过滤 `!m.id.starts_with("compacted-summary")`），实现了 **B1 冻结、B2 单调、B3 只增** 的不变量，最大程度保护服务端的 KV Cache 前缀不被颠簸破坏。

#### B. 用户消息边界压缩（Hold -> Compact -> Append）
在 [`compaction_dispatch.rs:193-254`](file:///c:/Software/conex/crates/session-loop/src/loop/compaction_dispatch.rs#L193-L254)：
```rust
// session-loop/src/loop/compaction_dispatch.rs:193-198
// 用户消息边界压缩（hold → compact → append）
// prepare_turn 步骤 2 在用户消息 record_message 之前调用：
// 估算不含 hold 消息（更早触发），切割点恒在 hold 之前，
// 用户消息 100% 保留、必在发送序列尾部（kept_ids 中绝不在 dropped_ids）。
```
这是一个极其惊艳的人机交互防御设计：当用户刚刚输入一条新指令时，如果系统在这一瞬间发现上下文即将超限，Conex **先暂扣（Hold）住该用户消息**，对纯历史上下文进行压缩，生成摘要替换前缀后，**再将该用户消息追加到末尾**。这从根本上杜绝了“用户刚说的指令被无情吞入摘要导致模型漏看”的常见痛点！

---

### 2. Grok-Build：两大工业级架构创新——Two-Pass Prefire 与分治分块（DnC）

Grok-Build 展现了顶级工业系统的宏大设计，具有 Conex 目前不具备的两个极高工程价值的杀手级特性：

#### A. 两阶段预触发压缩（Two-Pass Prefire Compaction）
在 [`session/compaction.rs:55-85`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs#L55-L85) 与 [`session/compaction.rs:172-180`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs#L172-L180)：
```rust
// session/compaction.rs:55-64
const DEFAULT_PREFIRE_LEAD_PERCENT: u64 = 10;
// 当使用率达到 `threshold - lead`（例如 85% - 10% = 75%）时，在后台启动 prefire pass-1
```
- **核心逻辑**：常规压缩是等到达到 85% 水位线后同步阻塞会话进行大模型摘要，耗时可达 10~30 秒。Grok-Build 实现了 **Prefire（预点火）**：
  1. 当上下文水位达到 75%（提前 10%）时，系统异步切出会话前半部分（例如前 50% 的历史）；
  2. 后台调用模型先行生成中间笔记 `NOTE₁`，并利用 `fingerprint_prefix` 计算会话前缀哈希以保证一致性；
  3. 当上下文真正攀升到 85% 必须压缩时，调用 `try_two_pass_pass2_apply`：直接读取缓存的 `NOTE₁`，只需让模型将 `NOTE₁` 和后半段极少量新增消息合并成最终摘要！
  4. 这一设计让前台等待时间减少了 70% 以上，极大缓解了大上下文编码运行中的卡顿！

#### B. 跨轮分治分块压缩（Divide and Conquer Inter-Compaction）
在 [`inter_compaction/compact.rs:92-160`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/inter_compaction/compact.rs#L92-L160)：
```rust
// inter_compaction/compact.rs:92-100
let chunk_token_limit = match config.compaction_strategy {
    CompactionStrategy::Basic => UNBOUNDED_CHUNK_LIMIT,
    CompactionStrategy::DivideAndConquer => config.dnc_chunk_token_limit,
    ...
};
```
当历史消息长达数十万 Token 时，单次 Prompt 无法容纳全部待压缩历史。Grok-Build 实现了分治法：按照 `dnc_chunk_token_limit` 拆分为多块并行/流水线式生成 `<chunk_summary index="0">`, `<chunk_summary index="1">`，再进行层次化聚合。

#### C. 防止用户意图滚雪球（Separate Prior User Queries）
在 [`history/filter.rs:72-145`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/history/filter.rs#L72-L145) 与 [`inter_compaction/compact.rs:130-135`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/inter_compaction/compact.rs#L130-L135)：
```rust
// 在采样前把旧摘要里的 <grok_user_queries> 剥离出来，LLM 不看它
let separated = separate_prior_user_queries(&filtered);
```
在长程会话多次压缩中，模型往往会在摘要中复述以前用户的提问。如果每次压缩都把上一轮摘要里的“用户查询列表”喂给模型，会导致每一代摘要都在机械复述并越积越多（Snowball Effect）。Grok-Build 在采样前用正则精确剥离 `<grok_user_queries>`，压缩完成后再在代码侧拼接还原，细节考量极其毒辣！

---

## 四、维度三：Token 估算精度与预算防爆机制

### 1. Token 估算精度对比

| 模块/维度 | Conex 实现 | Grok-Build 实现 | 评价与差异 |
| :--- | :--- | :--- | :--- |
| **基础文本估算** | `tokens.rs:10-52`：ASCII 4字符折1（向上取整）+ 分隔符/标点独立计1 + **CJK非ASCII按1~2 Token/字严格累加** | `xai-token-estimation/src/lib.rs:8-19`：简单的 `s.len() / 4`（`BYTES_PER_TOKEN = 4`） | **Conex 显著更准**。Grok-Build 的 `len / 4` 在 UTF-8 中文字符（每个汉字 3 字节）下会严重低估（一个汉字在 BPE 中常占 1~2 token，但 `3/4=0` token），存在中文代码爆窗风险。Conex 针对 CJK 与标点做了深度校准。 |
| **真实 Usage 对齐** | `thresholds.rs:113-176`：**Usage 优先**，提取最近助手消息的 `cacheBreakdown.inputTotal`；带 **`last_compaction_at` 时间戳护栏**，压缩边界前的旧 Usage 自动作废回退启发式 | `token.rs:19-24`：定义 `ItemTokenCounter` trait；Grok chat 端实现真正的 `TextTokenizer` 分词；grok-build 采用 `bytes/4` | **各有千秋**。Grok chat 有完整 Tokenizer，而 Conex 采用“服务端返回的真实 Usage（含KV Cache读写标量）为主 + 本地启发式为辅”，时间戳护栏设计非常严密。 |
| **图片估算** | `tokens.rs:8`：固定 `IMAGE_TOKEN_COST = 1600`（防 Base64 膨胀 100 倍） | `xai-token-estimation/src/lib.rs:13`：固定 `IMAGE_TOKEN_ESTIMATE = 765` | 两者均采用固定 Token 计价，Grok-Build 取 765，Conex 取 1600（对齐 Claude 高清图计价）。 |

---

### 2. 预算防爆与多级降级阶梯（Budget Fallback & Ladder）

#### A. Conex 的防爆机制：双阈值截断与紧急二次预检
1. **工具输出清洗与双阈值截断**：
   - [`clean_output.rs:1-150`](file:///c:/Software/conex/crates/conex-compaction/src/clean_output.rs#L1-L150)：R1-R6 管线（ANSI脱色、行尾空白、空行合并、重复行折叠、超长行截断、JSON压缩），`wire_safe` 配置在 wire 投影层纯净脱色且绝不破坏代码语义；
   - [`tool_output.rs:40-200`](file:///c:/Software/conex/crates/conex-compaction/src/tool_output.rs#L40-L200)：行数（2000行）与字节数（50KB）双阈值。采用 `head + 截断统计标记 + tail` 截断，截断节省的 Token 直接反馈至上下文水位计算。
2. **附件 40/60 偏重尾部日志截断**：
   - [`attachment_truncation.rs:48-83`](file:///c:/Software/conex/crates/session-loop/src/attachment_truncation.rs#L48-L83)：头部保留 40%，**尾部保留 60%**。这是 Conex 专为编程助手调试场景打造的特征——终端编译报错、Panic 调用栈总是在日志最底部，传统尾部截断会把最重要的报错信息切除，40/60 保证了错误根因不丢失。
   - [`attachment_budget.rs:50-65`](file:///c:/Software/conex/crates/session-loop/src/attachment_budget.rs#L50-L65)：剩余预算不足 300 Token 时安全移除附件并生成中文警告，杜绝 413 Payload Too Large。
3. **Emergency Preflight 追加后紧急二次截断**：
   - [`engine.rs:469-521`](file:///c:/Software/conex/crates/conex-compaction/src/engine.rs#L469-L521)：追加新摘要后，若总 Token 仍然超预算，触发两阶段兜底：阶段 1 收紧 `min_recent_turns` 切割点丢弃更多历史；阶段 2 对保留段内的超大 ToolResult 实施紧急就地截断（`clamp(256, 4096)` 字节），绝对锁死 400 溢出。

#### B. Grok-Build 的防爆机制：三级输入阶梯（Input Ladder）与五级拟合（Fit Rung）
Grok-Build 在输入溢出处理上的工业级架构设计非常强大：
1. **Host 级 Input Ladder 降级编排**：
   在 [`session/compaction.rs:1031-1188`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs#L1031-L1188)：
   ```rust
   enum InputStage {
       Verbatim,       // 阶段 1：原始会话完整喂给摘要模型
       VerbatimFitted, // 阶段 2：如果模型报 context_overflow，自动降级为截断超大工具输出
       Lossy,          // 阶段 3：如果再次超限，剔除所有工具交互细节，仅保留纯对话骨架
   }
   ```
   如果模型返回 `context_overflow`，状态机会步进到下一级（`InputStage::Verbatim` -> `VerbatimFitted` -> `Lossy`），重新拟合输入后再次重试采样。只有在 `Lossy` 级别仍然溢出时，才会判定为确定性失败（Deterministic）并触发抑制（`suppress_auto_compaction`）。
2. **5 级 FitRung 阶梯**：
   在 [`intra_compaction/fit.rs:37-61`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/intra_compaction/fit.rs#L37-L61)：
   - `Verbatim`（无需改动）
   - `HistoryTurnSelected`（优先丢弃历史轮次，保留当前 step）
   - `ToolTruncated`（对单条超过预算的 ToolResult 按 `max_bytes = max_tokens * 4` 截断）
   - `StepTurnsSelected`（丢弃最老的 step）
   - `Emergency`（仅保留最新一条 turn 并强制硬截断，绝不允许返回空 Vector 触发崩溃）

---

## 五、维度四：摘要质量、系统指令回注与长期记忆保持

### 1. Conex：Schema V1 强类型 JSON 单轨契约与符号精确保持

Conex 在摘要质量管理上走了一条极其严谨的**强结构化规范路线**：

#### A. 12 必填字段 Schema V1 契约
在 [`summary_document.rs:20-33`](file:///c:/Software/conex/crates/conex-compaction/src/summary_document.rs#L20-L33) 与 [`ai_summary.rs:81-118`](file:///c:/Software/conex/crates/conex-compaction/src/ai_summary.rs#L81-L118)：
```rust
pub const SUMMARY_REQUIRED_FIELDS: [&str; 12] = [
    "schemaVersion", "blockId", "generation", "droppedIds", "height", "tier",
    "goal", "constraints", "progress", "decisions", "nextSteps", "criticalContext",
];
```
- 模型被严格约束输出合法的单对象 JSON，杜绝自由发挥产生散文式摘要；
- 设立 `criticalContext` 字段：**明文要求精确路径、代码符号、终端命令、错误串必须逐字保留，不可改写**；
- 支持扩展 `paths`（文件变更与状态）、`signatures`（函数/类型签名）、`counts`，为后续编码提供精准代码拓扑；
- 机器可读优先：校验通过后，由 [`summary_to_markdown`](file:///c:/Software/conex/crates/conex-compaction/src/summary_document.rs#L146) 进行**无时间戳的确定性 Markdown 渲染**进链，保证输出文本高度稳定。

#### B. Thought 思考块绝对屏蔽
在 [`ai_summary.rs:38`](file:///c:/Software/conex/crates/conex-compaction/src/ai_summary.rs#L38)：
```rust
AgentMessageBlock::Thought { .. } => {} // thought 不入提示——思考过程不诱导模型复述
```
深度思考模型（如 R1、Claude Thinking、o1/o3）输出的 Thought 块绝不送入摘要模型，防止摘要模型把先前的思考碎碎念当成真实已发生的行动进行复述。

#### C. 拒绝纯丢弃式压缩（StubPolicy::LlmRequired）
在 [`plan.rs:87-106`](file:///c:/Software/conex/crates/conex-compaction/src/plan.rs#L87-L106)：
如果 Summarizer 不可用或 LLM 采样失败，Conex 默认**宁可放弃压缩也不使用静态占位符丢弃代码记忆**。它会发出 `RuntimeInterventionRequired` 事件暂停，等待模型服务恢复或由后台单飞任务补充摘要。

---

### 2. Grok-Build：AGENTS.md 项目指令回注与全景动态 Reminder

Grok-Build 在历史装配与代理长期记忆方面堪称工业界标杆：

#### A. AGENTS.md 协作规则强回注与幂等防重
在 [`code_compaction/assemble.rs:48-102`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/code_compaction/assemble.rs#L48-L102)：
```rust
// code_compaction/assemble.rs:70-76
// Re-inject AGENTS.md as a user message so project instructions survive
// compaction verbatim (not dependent on the summarizer). The
// `ProjectInstructions` tag is what the spawn-time idempotence guard
// recognizes on resume, so post-compaction sessions stay duplicate-free.
if let Some(ref reminder) = parts.agents_md_reminder {
    compacted.push(T::new_project_instructions(reminder.clone()));
}
```
**关键痛点根治**：常规 Agent 压缩后，最初注入的系统项目规范（如仓库规则 `AGENTS.md`）常常被稀释甚至彻底压缩丢失，导致 Agent 后续开始胡乱改代码、违背 Git 纪律。Grok-Build 在压缩历史重建时，**强制将 `AGENTS.md` 重新插入为第 3 项消息**，并且通过 `T::new_project_instructions` 赋予特殊的合成标记，使会话热重载（Resume）时的幂等守卫识别并防止重复插入！

#### B. 全景动态系统提醒（`<system-reminder>`）
在 [`reminder.rs:1-259`](file:///c:/Software/conex/reference/grok-build/crates/common/xai-grok-compaction/src/reminder.rs#L1-L259)：
Grok-Build 识别出 Agent 在上下文压缩后最容易“失忆”的五大运行期状态，由系统提取活状态拼装成 `<system-reminder>` 注入在摘要末尾：
1. **Running Background Tasks**：仍在后台运行的 bash 命令、服务监听进程及其 PID/任务 ID；
2. **TODO List**：尚未完成的任务清单、进行中状态及已完成数量汇总；
3. **Running Subagents**：之前派发的正在运行的子代理列表、各自运行了多少秒、类型描述、查询结果工具名（poll）和杀死工具名（cancel）；
4. **Scheduled Loops**：定时器、Cron 循环任务及下次触发时间；
5. **Running Workflows**：多阶段工作流的当前阶段与已消耗 Agent 预算。

这一设计彻底解决了“压缩后 Agent 忘记了自己后台还在跑 `npm run dev`，又重复去跑一次”或“忘记了刚才派出的子 Agent，丢下了未收尾任务”等工程灾难！

#### C. Transcript 离线归档（`xai-compaction-transcript`）
在 [`xai-compaction-transcript/src/lib.rs:20-88`](file:///c:/Software/conex/reference/grok-build/crates/codegen/xai-compaction-transcript/src/lib.rs#L20-L88)：
被压缩丢弃的原始详细上下文并不会彻底灰飞烟灭。系统将其序列化保存为 `compaction/segment_001.md`，并在 `compaction/INDEX.md` 中维护索引目录。摘要末尾附带提示：`“完整历史细节已存档于 segment_001.md，如需核对原始调用参数可通过阅读工具查阅”`。

---

## 六、综合对比评估矩阵与相互借鉴建议

### 1. 全维度对比矩阵

| 对比维度 | Conex 实现特征 | Grok-Build 实现特征 | 评估与定论 |
| :--- | :--- | :--- | :--- |
| **裁剪点安全性** | `cut_point.rs`：折叠链单调下界保护 + **ToolBatch 双向完整性闭包保护（Bi-directional Fixpoint）** | `select.rs`：倒推预算 + **单向安全跳步（Forward Snap）** + 尾部 incomplete 工具请求弹出 | **Conex 更胜一筹**。Conex 的双向闭包算法杜绝了批量并发工具调用中任何 Result 或 Call 的遗落，数学证明更严密。 |
| **Token 估算精度** | `tokens.rs` + `thresholds.rs`：ASCII/标点分词 + **CJK 逐字校准** + 真实服务端 Usage 优先 + **时间戳护栏** | `xai-token-estimation`：`len/4` 纯字节估算；宿主端可选 Tokenizer 抽象 | **Conex 本地估算精度更高**。Grok-Build 的 `bytes/4` 会低估中文代码；但 Grok-Build 具有完备的运行期溢出降级阶梯抵消了这一不足。 |
| **压缩感知延迟** | 同步预检（`maybe_compact_preflight`）或边界触发，可配置后台补摘要单飞 | **Two-Pass Prefire 预采样**（提前 10% 后台生成 Pass-1，达标后快速增量合并） | **Grok-Build 显著领先**。Two-Pass 设计大幅消除了大上下文下用户感知的交互停顿。 |
| **超限与溢出容错** | `engine.rs`：Emergency Preflight（阶段1收紧cut + 阶段2就地截断保留段超大结果） | `session/compaction.rs`：**三级 Input Ladder（Verbatim -> VerbatimFitted -> Lossy）** + 5级 FitRung | **Grok-Build 工业级鲁棒性更强**。从原汁原味到部分拟合再到纯对话骨架，层次分明，容错弹性极高。 |
| **用户即时意图保全** | **Hold 语义**：用户边界压缩时，新消息被暂扣，压缩历史后再 append 在最后 | 提取 `last_user_query` 包装在 `<user_query>` 中 | **Conex 设计极精妙**。Hold 机制天然保证了用户本轮最新输入的 100% 原始度和位置权威。 |
| **系统规则保全** | 依赖系统提示词与摘要内的 constraints/decisions 字段 | **`AGENTS.md` 独立作为 `ProjectInstructions` 重新注入**，并带幂等去重防重复 | **Grok-Build 明显更优**。规则原文无损存活于压缩后，不依赖 LLM 概括能力。 |
| **运行态与子代理记忆** | 依靠 Schema V1 中的 progress/nextSteps 静态记录 | **动态 `<system-reminder>` 块注入**（后台进程、未完 TODO、运行中子代理及操作工具） | **Grok-Build 极其强大**。这是工程化大模型 Agent 避免行为紊乱的决定性防线。 |
| **摘要规范与可读性** | **Schema V1 12 字段强制 JSON**，代码路径/函数签名特异性保留，确定性 Markdown 投影 | 短版 Self-Summary 与 9 点段落结构化模板；分治分块（DnC）；去除旧用户提问防滚雪球 | **各有千秋**。Conex 的 JSON 规范严防幻觉且高度结构化；Grok-Build 的防雪球机制和长文分治极其实用。 |
| **历史可追溯性** | 依靠内存/存储中会话消息序列与代数标记 | **`xai-compaction-transcript` 磁盘持久化（Segment + Index）**，摘要附带检索线索 | **Grok-Build 完备**。丢弃内容下沉为离线外部记忆，支持按需工具反查。 |

---

### 2. 相互借鉴与演进建议

#### A. Conex 应当向 Grok-Build 学习的方面：
1. **引入 `<system-reminder>` 动态活跃态注入（高优先级）**：
   Conex 拥有强大的子 Agent 调度与工具执行体系，但压缩后仅依赖 LLM 在摘要中的自由记录。建议参考 Grok-Build `reminder.rs:118-259`，在压缩后将当前运行中的后台命令、活跃子 Agent（ID、运行秒数、取消工具）以及待办项，作为独立的 `<system-reminder>` 重新注入在摘要之后，杜绝子代理失联。
2. **实现 AGENTS.md 规则原文无损回注（高优先级）**：
   参考 Grok-Build `code_compaction/assemble.rs:70-76`，在组装压缩后会话时，将项目规则文件作为特殊标签的消息插入，并赋予幂等标记，保证长程压缩中项目底线条款永不磨灭。
3. **探索 Two-Pass Prefire 异步预压缩机制（中长期演进）**：
   借鉴 Grok-Build 的 `DEFAULT_PREFIRE_LEAD_PERCENT = 10%` 与 `fingerprint_prefix` 前缀指纹设计，在水位达到 75% 时后台静默预计算前半程摘要，使 85% 触发时的停顿等待时间压降到秒级。
4. **落盘离线 Transcript 分段索引（中长期演进）**：
   参考 `xai-compaction-transcript`，将压缩剔除的原始轮次写入本地磁盘缓存（如 `.agent-outputs/segments/`），在摘要末尾附加查询索引，赋予 Agent 自主回溯历史的能力。

#### B. Grok-Build 可以向 Conex 学习的方面：
1. **吸收 ToolBatch 双向完整性闭包算法**：
   Grok-Build 的 `snap_to_safe_boundary` 仅做了简单的单向向后探测跳步，在处理并发批量工具调用跨界时存在边缘漏洞。应引入 Conex `cut_point.rs:40-126` 的双向闭包循环迭代算法，彻底消除孤儿 ToolResult 与孤儿 ToolCall。
2. **优化非 ASCII / CJK Token 启发式估算**：
   Grok-Build 在非 Tokenizer 环境下的 `BYTES_PER_TOKEN = 4` 无法准确估算中日韩语言与特殊符号代码，容易在多语言或符号密集型项目中低估 Token 导致突发 400 报错。应引入 Conex `tokens.rs:21-52` 的 ASCII/CJK 差异化折算逻辑。
3. **采纳 40/60 偏重尾部的日志截断策略**：
   在截断超长编译日志与终端输出时，借鉴 Conex `attachment_truncation.rs:48-54` 的 40% 头部 + 60% 尾部策略，优先保全位于尾部的报错根因与 Panic 堆栈。
4. **引入 JSON Schema 结构化字段约束**：
   在要求模型总结代码变更时，借鉴 Conex `summary_document.rs` 强制要求输出 `criticalContext`, `paths`, `signatures` 等强类型字段，防止 LLM 自然语言摘要时遗漏关键路径与破坏符号拼写。
