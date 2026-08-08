//! AI 压缩摘要通道（M10 / C9：AI 摘要生成 + 退化重试护栏）
//!
//! conex-compaction 保持纯算法、无运行时依赖（既有 crate 定位，P4 §3.4.4）：
//!
//! - **五字段模板**：固定压缩文档结构（任务目标/已完成/待办/关键决策/
//!   文件清单），模板常量 + 生成函数 + 结构校验（04 C9 第 3 条，
//!   字段不得省略）；
//! - **摘要提示词**：把被丢弃消息渲染为模型输入，提示输出五字段模板；
//!   存在既有摘要时传入做迭代合并（P4 §3.4.3 / 02 Top 9
//!   「Previous Summary + New Conversation」）；
//! - **退化重试护栏**：空/过短摘要（< 500 字符，对齐 grok
//!   MIN_SUMMARY_SEED_CHARS）视为瞬态，至多重试 N 次（默认 3 次、
//!   3s 间隔、wall-clock 预算兜底）后仍失败才降级回退占位符
//!   （02 Top 3；降级语义由调用方经 [crate::compaction::Summarizer]
//!   的 Err 路径落到既有 `[Compacted N...]` 占位符，不阻塞 run）；
//! - **covers_up_to_turn 落库载荷**：压缩覆盖到哪一轮（被丢弃段内
//!   用户回合数），随 [compaction_event_details] 产出事件 details
//!   载荷（02 Top 9，M11 拼接注入消费）。
//!
//! provider 调用通道：真实模型调用由调用方（session-loop 壳层）实现
//! [crate::compaction::Summarizer] 注入（经 agent-provider 通道，
//! Q5 暂定引擎内部调用、独立小预算）；本模块只提供重试护栏与模板协议。

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use conex_types::{AgentMessage, AgentMessageBlock};

use crate::compaction::Summarizer;

// ── 五字段模板（04 C9 第 3 条：固定结构，不得省略字段）──

/// 压缩文档标题（模板固定行）
pub const SUMMARY_TEMPLATE_HEADER: &str = "## 压缩摘要";

/// 五字段清单（固定顺序；校验与提示词均以此为准）
pub const SUMMARY_TEMPLATE_FIELDS: [&str; 5] = ["任务目标", "已完成", "待办", "关键决策", "文件清单"];

/// 无内容字段的占位写法（模板语义：字段不得省略）
pub const SUMMARY_EMPTY_FIELD_MARKER: &str = "(none)";

/// 结构化摘要五字段内容（[format_structured_summary] 的输入）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredSummaryFields {
    /// 任务目标（本轮/子任务目标一句话）
    pub task_goal: String,
    /// 已完成（要点列表，每条 ≤ 30 字）
    pub completed: String,
    /// 待办（要点列表）
    pub pending: String,
    /// 关键决策（决策点与理由，每条 ≤ 50 字）
    pub key_decisions: String,
    /// 文件清单（涉及文件路径列表）
    pub file_list: String,
}

/// 按五字段模板格式化压缩文档（固定结构，字段不省略；空字段写
/// [SUMMARY_EMPTY_FIELD_MARKER]）
pub fn format_structured_summary(fields: &StructuredSummaryFields) -> String {
    format!(
        "{header}\n- 任务目标：{task_goal}\n- 已完成：{completed}\n- 待办：{pending}\n- 关键决策：{key_decisions}\n- 文件清单：{file_list}",
        header = SUMMARY_TEMPLATE_HEADER,
        task_goal = or_none(&fields.task_goal),
        completed = or_none(&fields.completed),
        pending = or_none(&fields.pending),
        key_decisions = or_none(&fields.key_decisions),
        file_list = or_none(&fields.file_list),
    )
}

fn or_none(value: &str) -> &str {
    if value.trim().is_empty() {
        SUMMARY_EMPTY_FIELD_MARKER
    } else {
        value
    }
}

/// 校验文本是否为合法五字段压缩文档（标题 + 五个字段前缀行全部在场；
/// 字段顺序与格式不符视为非法，返回缺项说明）
pub fn validate_structured_summary(text: &str) -> Result<(), String> {
    if !text.contains(SUMMARY_TEMPLATE_HEADER) {
        return Err(format!("缺少模板标题 {SUMMARY_TEMPLATE_HEADER}"));
    }
    let mut missing: Vec<&str> = Vec::new();
    for field in SUMMARY_TEMPLATE_FIELDS {
        let prefix = format!("- {field}：");
        if !text.lines().any(|line| line.trim_start().starts_with(&prefix)) {
            missing.push(field);
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("缺少字段：{}", missing.join(" / ")))
    }
}

/// 渲染单条消息为摘要提示词片段（text/tool-call/tool-result 三通道，
/// thought 不入提示——思考过程不诱导模型复述）
fn render_message_text(message: &AgentMessage) -> String {
    let mut out = String::new();
    for block in &message.blocks {
        match block {
            AgentMessageBlock::Text { text } => out.push_str(text),
            AgentMessageBlock::Thought { .. } => {}
            AgentMessageBlock::ToolCall(call) => {
                out.push_str(&format!(
                    "\n[工具调用] {} 入参：{}",
                    call.tool_name,
                    call.input
                ));
            }
            AgentMessageBlock::ToolResult {
                tool_name,
                output,
                is_error,
                ..
            } => {
                let mut body = String::new();
                if let Some(text) = &output.text {
                    body.push_str(text);
                }
                if let Some(json) = &output.json {
                    body.push_str(&json.to_string());
                }
                if !body.is_empty() {
                    body = format!("：{body}");
                }
                out.push_str(&format!(
                    "\n[工具结果] {tool_name}{body}{}",
                    if *is_error { "（错误）" } else { "" }
                ));
            }
        }
    }
    out
}

/// 构建摘要提示词（被丢弃消息 + 既有摘要迭代合并；输出要求为五字段
/// 固定模板，调用方把结果经 [validate_structured_summary] 校验后
/// 用 [format_structured_summary] 语义落库）
pub fn build_summarize_prompt(dropped: &[AgentMessage], existing: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str(
        "你负责为对话中被压缩的历史消息生成结构化压缩摘要。\
         输出必须使用下面的固定模板（五字段，不得省略任何字段；\
         某字段无内容时写 (none)）：\n\n",
    );
    out.push_str(SUMMARY_TEMPLATE_HEADER);
    out.push_str("\n- 任务目标：<本轮/子任务目标一句话>\n");
    out.push_str("- 已完成：<要点列表，每条 ≤ 30 字>\n");
    out.push_str("- 待办：<要点列表>\n");
    out.push_str("- 关键决策：<决策点与理由，每条 ≤ 50 字>\n");
    out.push_str("- 文件清单：<涉及文件路径列表>\n\n");
    out.push_str("只输出压缩摘要文档本身，不附加其他说明；条目保持精炼。\n\n");
    if let Some(existing) = existing {
        if !existing.trim().is_empty() {
            out.push_str("## 既有摘要（合并进新摘要，不要重复既有内容）\n");
            out.push_str(existing);
            out.push_str("\n\n");
        }
    }
    out.push_str("## 待摘要的历史消息\n");
    for message in dropped {
        out.push_str(&format!(
            "\n[{}] {}\n",
            role_name(message.role),
            render_message_text(message)
        ));
    }
    out
}

fn role_name(role: conex_types::AgentMessageRole) -> &'static str {
    match role {
        conex_types::AgentMessageRole::System => "系统",
        conex_types::AgentMessageRole::User => "用户",
        conex_types::AgentMessageRole::Assistant => "助手",
        conex_types::AgentMessageRole::Tool => "工具",
    }
}

// ── 退化摘要判定（对齐 grok MIN_SUMMARY_SEED_CHARS = 500）──

/// 空/过短摘要判定：字符数（含空白剔除后）低于下限视为退化（瞬态），
/// 走重试；下限默认 [MIN_SUMMARY_SEED_CHARS_DEFAULT]
pub fn is_degenerate_summary(text: &str, min_chars: usize) -> bool {
    text.trim().chars().count() < min_chars
}

/// 摘要可接受性判定：非退化（字符数达标）**或**符合五字段模板结构。
///
/// 五字段模板文档可合法地短于 500 字符（「任务目标一句话」设计），
/// 结构完整即视为有效；字符下限针对非模板输出的空/垃圾文本
/// （对齐 grok MIN_SUMMARY_SEED_CHARS 的退化检测意图）。
pub fn is_acceptable_summary(text: &str, min_chars: usize) -> bool {
    !is_degenerate_summary(text, min_chars) || validate_structured_summary(text).is_ok()
}

// ── 退化重试护栏（02 Top 3：空/过短 = 瞬态，重试 N 次后降级）──

/// 摘要重试策略（可配；session_meta 键见常量定义，默认值对齐 grok
/// code_compaction/config.rs：max_attempts=3、间隔 3s、500 字符下限、
/// wall-clock 预算兜底防推理 runaway）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryRetryPolicy {
    /// 总尝试次数（含首次；默认 3，对齐 grok max_attempts=3）
    pub max_attempts: u32,
    /// 两次尝试间等待（默认 3000ms）
    pub retry_interval_ms: u64,
    /// 退化摘要字符下限（默认 500，对齐 grok MIN_SUMMARY_SEED_CHARS）
    pub min_summary_chars: usize,
    /// wall-clock 总预算（默认 300s，对齐 grok wall_clock_budget_secs=300；
    /// None = 不设墙钟上限）
    pub wall_clock_budget_ms: Option<u64>,
}

impl Default for SummaryRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: SUMMARY_MAX_ATTEMPTS_DEFAULT,
            retry_interval_ms: SUMMARY_RETRY_INTERVAL_MS_DEFAULT,
            min_summary_chars: MIN_SUMMARY_SEED_CHARS_DEFAULT,
            wall_clock_budget_ms: Some(SUMMARY_WALL_CLOCK_BUDGET_MS_DEFAULT),
        }
    }
}

impl SummaryRetryPolicy {
    /// 边界钳制：max_attempts 至少 1
    pub fn normalized(&self) -> Self {
        Self {
            max_attempts: self.max_attempts.max(1),
            ..self.clone()
        }
    }
}

/// 单轮摘要结果（[summarize_with_guard] 的产出；[RetryGuardSummarizer]
/// 记录最近一次供事件留痕）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryOutcome {
    /// 成功摘要文本（None = 最终降级，调用方回退占位符）
    pub summary: Option<String>,
    /// 是否降级（重试次数耗尽仍失败/退化）
    pub degraded: bool,
    /// 实际尝试次数（含首次）
    pub attempts: u32,
    /// 退化（过短）尝试次数
    pub degenerate_attempts: u32,
    /// 最近一次失败原因（成功时为 None）
    pub last_error: Option<String>,
}

/// 重试决策（纯函数，便于注入时钟测试）：已用次数未达上限且未超墙钟
/// 预算时允许下一次尝试
pub fn retry_allowed(attempts_used: u32, elapsed_ms: u64, policy: &SummaryRetryPolicy) -> bool {
    let policy = policy.normalized();
    if attempts_used >= policy.max_attempts {
        return false;
    }
    match policy.wall_clock_budget_ms {
        Some(budget) => elapsed_ms < budget,
        None => true,
    }
}

fn elapsed_ms_since(started: SystemTime) -> u64 {
    started
        .elapsed()
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 有界重试摘要驱动：对退化/失败结果至多重试 [SummaryRetryPolicy] 次数，
/// 每次等待 `retry_interval_ms`（由调用方注入 wait，测试可注入立即返回；
/// 生产侧注入真实睡眠/异步调度）。最终失败返回 `degraded=true` 且
/// `summary=None`——调用方（经 [Summarizer] Err 路径）回退既有
/// `[Compacted N...]` 占位符，不阻塞 run。
pub fn summarize_with_guard(
    summarizer: &dyn Summarizer,
    dropped: &[AgentMessage],
    existing: Option<&str>,
    policy: &SummaryRetryPolicy,
    wait: &mut dyn FnMut(Duration),
) -> SummaryOutcome {
    let started = SystemTime::now();
    let mut attempts: u32 = 0;
    let mut degenerate_attempts: u32 = 0;
    let mut last_error: Option<String>;
    loop {
        attempts += 1;
        match summarizer.summarize(dropped, existing) {
            Ok(text) if is_acceptable_summary(&text, policy.min_summary_chars) => {
                return SummaryOutcome {
                    summary: Some(text),
                    degraded: false,
                    attempts,
                    degenerate_attempts,
                    last_error: None,
                };
            }
            Ok(_) => {
                degenerate_attempts += 1;
                last_error = Some(format!(
                    "退化摘要（少于 {} 字符）",
                    policy.min_summary_chars
                ));
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
        if !retry_allowed(attempts, elapsed_ms_since(started), policy) {
            return SummaryOutcome {
                summary: None,
                degraded: true,
                attempts,
                degenerate_attempts,
                last_error,
            };
        }
        wait(Duration::from_millis(policy.retry_interval_ms));
    }
}

/// 摘要器包装：把 [summarize_with_guard] 折叠成 [Summarizer] trait，
/// 可直接注入 [crate::compaction::CompactionEngine::compact_agent_messages]
/// ——成功返回摘要，最终降级返回 Err（引擎回退 L1 占位符，语义不变）；
/// 最近一次 [SummaryOutcome] 由 [Self::last_outcome] 读取，供压缩事件
/// 记录降级事实（02 Top 3「降级事件记录事实，不阻塞会话循环」）。
pub struct RetryGuardSummarizer {
    inner: Box<dyn Summarizer>,
    policy: SummaryRetryPolicy,
    wait: Mutex<Box<dyn FnMut(Duration) + Send>>,
    last: Mutex<Option<SummaryOutcome>>,
}

impl RetryGuardSummarizer {
    /// 构造护栏（wait 由调用方注入：生产侧为真实睡眠/异步调度，
    /// 测试侧可注入立即返回）
    pub fn new(
        inner: Box<dyn Summarizer>,
        policy: SummaryRetryPolicy,
        wait: Box<dyn FnMut(Duration) + Send>,
    ) -> Self {
        Self {
            inner,
            policy,
            wait: Mutex::new(wait),
            last: Mutex::new(None),
        }
    }

    /// 最近一次摘要尝试结果（供事件留痕；尚未调用时为 None）
    pub fn last_outcome(&self) -> Option<SummaryOutcome> {
        self.last.lock().ok().and_then(|guard| guard.clone())
    }

    /// 当前重试策略（只读）
    pub fn policy(&self) -> &SummaryRetryPolicy {
        &self.policy
    }
}

impl Summarizer for RetryGuardSummarizer {
    fn summarize(
        &self,
        dropped: &[AgentMessage],
        existing: Option<&str>,
    ) -> Result<String, String> {
        let mut wait = self.wait.lock().expect("护栏 wait 锁可用");
        let outcome = summarize_with_guard(
            self.inner.as_ref(),
            dropped,
            existing,
            &self.policy,
            &mut *wait,
        );
        let result = outcome.summary.clone().ok_or_else(|| {
            outcome
                .last_error
                .clone()
                .unwrap_or_else(|| "摘要退化：重试次数耗尽".to_string())
        });
        if let Ok(mut last) = self.last.lock() {
            *last = Some(outcome);
        }
        result
    }
}

// ── covers_up_to_turn（02 Top 9：摘要覆盖到哪一轮，供拼接注入）──

/// 计算被压缩（丢弃）消息覆盖到第几轮：返回丢弃段内用户回合数
/// （1 起计；回合 = 一个 user 消息）。丢弃段为对话前缀时该计数即
/// 「摘要覆盖到第 N 轮」，支持「Previous Summary + New Conversation」
/// 拼接（M11 消费）。丢弃段不含任何用户消息时返回 None。
pub fn covers_up_to_turn_for_dropped(dropped: &[AgentMessage]) -> Option<u32> {
    let turns = dropped
        .iter()
        .filter(|m| m.role == conex_types::AgentMessageRole::User)
        .count() as u32;
    if turns == 0 {
        None
    } else {
        Some(turns)
    }
}

/// 压缩事件 details 载荷（camelCase，随 `context-compression-end` 的
/// `result.details` 落库）：coversUpToTurn / degraded / summaryAttempts
/// / droppedCount。调用方（session-loop 的 apply_compaction）把本载荷
/// 填入 [conex_types::tool::ContextCompressionRecord::details]，
/// 供后续 run 与 M11 消费。
pub fn compaction_event_details(
    dropped: &[AgentMessage],
    degraded: bool,
    summary_attempts: u32,
) -> serde_json::Value {
    serde_json::json!({
        "coversUpToTurn": covers_up_to_turn_for_dropped(dropped),
        "degraded": degraded,
        "summaryAttempts": summary_attempts,
        "droppedCount": dropped.len(),
    })
}

// ── 默认值与 session_meta 键（配置面 Q1：默认值在配置面、覆盖走
//    session_meta；键命名空间 compact_*，04 §3.5）──

/// 摘要总尝试次数默认（对齐 grok max_attempts=3）
pub const SUMMARY_MAX_ATTEMPTS_DEFAULT: u32 = 3;
/// 摘要重试间隔默认（3s）
pub const SUMMARY_RETRY_INTERVAL_MS_DEFAULT: u64 = 3_000;
/// 退化摘要字符下限默认（对齐 grok MIN_SUMMARY_SEED_CHARS=500）
pub const MIN_SUMMARY_SEED_CHARS_DEFAULT: usize = 500;
/// 摘要 wall-clock 预算默认（300s，对齐 grok wall_clock_budget_secs=300）
pub const SUMMARY_WALL_CLOCK_BUDGET_MS_DEFAULT: u64 = 300_000;

/// session_meta 键：摘要总尝试次数
pub const SESSION_META_KEY_COMPACT_SUMMARY_MAX_ATTEMPTS: &str = "compact_summary_max_attempts";
/// session_meta 键：摘要重试间隔（毫秒）
pub const SESSION_META_KEY_COMPACT_SUMMARY_RETRY_INTERVAL_MS: &str =
    "compact_summary_retry_interval_ms";
/// session_meta 键：退化摘要字符下限
pub const SESSION_META_KEY_COMPACT_SUMMARY_MIN_CHARS: &str = "compact_summary_min_chars";
/// session_meta 键：摘要 wall-clock 预算（毫秒）
pub const SESSION_META_KEY_COMPACT_SUMMARY_WALL_CLOCK_BUDGET_MS: &str =
    "compact_summary_wall_clock_budget_ms";

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};

    use super::{
        build_summarize_prompt, compaction_event_details, covers_up_to_turn_for_dropped,
        format_structured_summary, is_acceptable_summary, is_degenerate_summary, retry_allowed,
        summarize_with_guard, validate_structured_summary, RetryGuardSummarizer,
        StructuredSummaryFields, SummaryOutcome, SummaryRetryPolicy, SUMMARY_EMPTY_FIELD_MARKER,
        SUMMARY_TEMPLATE_FIELDS, SUMMARY_TEMPLATE_HEADER,
    };
    use crate::compaction::{CompactionEngine, CompactionPolicy, Summarizer};

    fn text_block(text: &str) -> AgentMessageBlock {
        AgentMessageBlock::Text {
            text: text.to_string(),
        }
    }

    fn amsg(
        id: &str,
        role: AgentMessageRole,
        created_at: &str,
        blocks: Vec<AgentMessageBlock>,
    ) -> Arc<AgentMessage> {
        Arc::new(AgentMessage {
            id: id.to_string(),
            role,
            created_at: created_at.to_string(),
            blocks,
            metadata: None,
            client_message_id: None,
            content: None,
        })
    }

    fn five_field_summary() -> String {
        format_structured_summary(&StructuredSummaryFields {
            task_goal: "实现双阈值压缩".to_string(),
            completed: "完成模板定义".to_string(),
            pending: "补充测试".to_string(),
            key_decisions: "常规线走 AI 摘要".to_string(),
            file_list: "crates/conex-compaction/src/lib.rs".to_string(),
        })
    }

    /// 可编程摘要器（mock provider 通道：按脚本依次返回成功/退化/失败；
    /// 脚本耗尽后按最后一项重复）
    struct ScriptedSummarizer {
        state: std::sync::Mutex<ScriptState>,
    }

    /// 脚本状态：剩余队列 + 最近弹出项（耗尽后重复最近项）
    struct ScriptState {
        queue: std::collections::VecDeque<Result<String, String>>,
        last: Option<Result<String, String>>,
    }

    impl ScriptedSummarizer {
        fn new(script: Vec<Result<String, String>>) -> Self {
            Self {
                state: std::sync::Mutex::new(ScriptState {
                    queue: script.into(),
                    last: None,
                }),
            }
        }
    }

    impl Summarizer for ScriptedSummarizer {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            let mut state = self.state.lock().unwrap();
            if let Some(item) = state.queue.pop_front() {
                let clone = item.clone();
                state.last = Some(clone);
                item
            } else {
                state
                    .last
                    .clone()
                    .expect("脚本必须至少有一项且已被消费")
            }
        }
    }

    fn empty_wait() -> Box<dyn FnMut(std::time::Duration) + Send> {
        Box::new(|_| {})
    }

    /// Arc 列表 → 值列表（摘要边界以 [AgentMessage] 传值形态为准）
    fn flat(messages: &[Arc<AgentMessage>]) -> Vec<AgentMessage> {
        messages.iter().map(|m| (**m).clone()).collect()
    }

    // ── 五字段模板 ──

    #[test]
    fn template_format_contains_all_five_fields() {
        let summary = five_field_summary();
        assert!(summary.starts_with(SUMMARY_TEMPLATE_HEADER));
        for field in SUMMARY_TEMPLATE_FIELDS {
            assert!(
                summary.contains(&format!("- {field}：")),
                "模板须含字段 {field}"
            );
        }
        // 空字段写 (none)，字段不省略
        let empty = format_structured_summary(&StructuredSummaryFields {
            task_goal: String::new(),
            completed: String::new(),
            pending: String::new(),
            key_decisions: String::new(),
            file_list: String::new(),
        });
        assert_eq!(empty.matches(SUMMARY_EMPTY_FIELD_MARKER).count(), 5);
        assert!(validate_structured_summary(&empty).is_ok());
    }

    #[test]
    fn template_validation_rejects_missing_fields() {
        assert!(validate_structured_summary(&five_field_summary()).is_ok());
        // 缺标题
        let no_header = five_field_summary().replace(SUMMARY_TEMPLATE_HEADER, "## 摘要");
        assert!(validate_structured_summary(&no_header).is_err());
        // 缺一个字段
        let no_file_list = five_field_summary().replace("- 文件清单：crates/conex-compaction/src/lib.rs", "");
        let err = validate_structured_summary(&no_file_list).unwrap_err();
        assert!(err.contains("文件清单"), "缺项说明须点名缺失字段：{err}");
        // 空字符串
        assert!(validate_structured_summary("").is_err());
    }

    // ── 摘要提示词 ──

    #[test]
    fn summarize_prompt_contains_template_and_dropped_context() {
        let dropped = vec![
            amsg(
                "u1",
                AgentMessageRole::User,
                "2026-08-04T10:00:00.000Z",
                vec![text_block("实现压缩模块")],
            ),
            amsg(
                "a1",
                AgentMessageRole::Assistant,
                "2026-08-04T10:00:01.000Z",
                vec![
                    text_block("已完成"),
                    AgentMessageBlock::ToolCall(ToolCallBlock {
                        id: "t1".to_string(),
                        tool_name: "read_file".to_string(),
                        input: serde_json::json!({"path": "src/lib.rs"}),
                    }),
                ],
            ),
        ];
        let prompt = build_summarize_prompt(&flat(&dropped), Some("OLD SUMMARY"));
        // 模板五字段在场
        for field in SUMMARY_TEMPLATE_FIELDS {
            assert!(prompt.contains(field), "提示词须含字段 {field}");
        }
        // 丢弃消息上下文 + 迭代合并
        assert!(prompt.contains("实现压缩模块"));
        assert!(prompt.contains("read_file"));
        assert!(prompt.contains("OLD SUMMARY"));
        assert!(prompt.contains("既有摘要"));
        // thought 块不入提示
        let thought = amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-04T10:00:02.000Z",
            vec![AgentMessageBlock::Thought {
                text: "内部思考过程".to_string(),
                redacted: None,
            }],
        );
        let prompt = build_summarize_prompt(&[(*thought).clone()], None);
        assert!(!prompt.contains("内部思考过程"));
    }

    // ── 退化判定 ──

    #[test]
    fn degenerate_summary_detection_threshold() {
        assert!(is_degenerate_summary("", 500));
        assert!(is_degenerate_summary("   ", 500));
        assert!(is_degenerate_summary(&"短".repeat(499), 500));
        assert!(!is_degenerate_summary(&"长".repeat(500), 500));
        // 可配下限
        assert!(is_degenerate_summary("abc", 10));
        assert!(!is_degenerate_summary("abc", 2));
    }

    /// 可接受性：字符达标的任意文本可用；模板结构完整的短文档也可用
    /// （五字段模板文档合法短于 500 字符）
    #[test]
    fn acceptable_summary_accepts_valid_template() {
        let summary = five_field_summary();
        assert!(is_degenerate_summary(&summary, 500), "模板文档通常短于 500 字符");
        assert!(is_acceptable_summary(&summary, 500), "结构完整即视为有效");
        assert!(!is_acceptable_summary("", 500));
        assert!(!is_acceptable_summary("退化", 500));
        assert!(is_acceptable_summary(&"长".repeat(500), 500));
    }

    // ── 重试决策（纯函数）──

    #[test]
    fn retry_allowed_respects_attempts_and_wall_clock() {
        let policy = SummaryRetryPolicy {
            max_attempts: 3,
            wall_clock_budget_ms: Some(1000),
            ..SummaryRetryPolicy::default()
        };
        // 次数：已用 1/2 次仍可重试，已用 3 次停
        assert!(retry_allowed(1, 0, &policy));
        assert!(retry_allowed(2, 0, &policy));
        assert!(!retry_allowed(3, 0, &policy));
        // 墙钟：预算内可、超预算停
        assert!(retry_allowed(1, 999, &policy));
        assert!(!retry_allowed(1, 1000, &policy));
        // 无墙钟上限
        let no_clock = SummaryRetryPolicy {
            wall_clock_budget_ms: None,
            ..SummaryRetryPolicy::default()
        };
        assert!(retry_allowed(2, u64::MAX, &no_clock));
        // max_attempts=0 钳到 1
        let zero = SummaryRetryPolicy {
            max_attempts: 0,
            wall_clock_budget_ms: None,
            ..SummaryRetryPolicy::default()
        };
        assert!(!retry_allowed(1, 0, &zero));
    }

    // ── 退化重试护栏 ──

    /// 前 2 次退化（过短）、第 3 次成功 → 成功，attempts=3，退化计数 2
    #[test]
    fn guard_retries_degenerate_then_succeeds() {
        let summarizer = ScriptedSummarizer::new(vec![
            Ok("过短".to_string()),
            Ok("仍过短".to_string()),
            Ok(five_field_summary()),
        ]);
        let waits = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let waits_arc = waits.clone();
        let mut wait = move |duration: std::time::Duration| {
            waits_arc.lock().unwrap().push(duration);
        };
        let outcome = summarize_with_guard(
            &summarizer,
            &[],
            None,
            &SummaryRetryPolicy::default(),
            &mut wait,
        );
        assert!(!outcome.degraded);
        assert_eq!(outcome.attempts, 3);
        assert_eq!(outcome.degenerate_attempts, 2);
        assert!(outcome.summary.as_deref().unwrap().contains("任务目标"));
        assert!(outcome.last_error.is_none());
        // 两次等待均为 3s 间隔
        assert_eq!(
            waits.lock().unwrap().clone(),
            vec![
                std::time::Duration::from_millis(3_000),
                std::time::Duration::from_millis(3_000)
            ]
        );
    }

    /// 全部退化 → 降级（summary=None、degraded=true），不抛错
    #[test]
    fn guard_degrades_after_exhaustion() {
        let summarizer = ScriptedSummarizer::new(vec![
            Ok("退化一".to_string()),
            Ok("退化二".to_string()),
            Ok("退化三".to_string()),
        ]);
        let outcome = summarize_with_guard(
            &summarizer,
            &[],
            None,
            &SummaryRetryPolicy::default(),
            &mut empty_wait(),
        );
        assert!(outcome.degraded);
        assert_eq!(outcome.attempts, 3);
        assert_eq!(outcome.degenerate_attempts, 3);
        assert!(outcome.summary.is_none());
        assert!(outcome.last_error.unwrap().contains("退化"));
    }

    /// 连续失败（Err）→ 重试后仍失败 → 降级并记录原因
    #[test]
    fn guard_failing_summarizer_degrades_with_error() {
        let summarizer = ScriptedSummarizer::new(vec![
            Err("provider error".to_string()),
            Err("provider error".to_string()),
            Err("provider error".to_string()),
        ]);
        let outcome = summarize_with_guard(
            &summarizer,
            &[],
            None,
            &SummaryRetryPolicy::default(),
            &mut empty_wait(),
        );
        assert!(outcome.degraded);
        assert_eq!(outcome.attempts, 3);
        assert_eq!(outcome.last_error.as_deref(), Some("provider error"));
    }

    /// 首试成功不等待、不重试
    #[test]
    fn guard_first_attempt_success_no_retry() {
        let summarizer = ScriptedSummarizer::new(vec![Ok(five_field_summary())]);
        let wait_count = std::sync::Arc::new(AtomicU32::new(0));
        let counter = wait_count.clone();
        let mut wait = move |_: std::time::Duration| {
            counter.fetch_add(1, Ordering::SeqCst);
        };
        let outcome = summarize_with_guard(
            &summarizer,
            &[],
            None,
            &SummaryRetryPolicy::default(),
            &mut wait,
        );
        assert!(!outcome.degraded);
        assert_eq!(outcome.attempts, 1);
        assert_eq!(wait_count.load(Ordering::SeqCst), 0);
    }

    /// 重试次数可配：max_attempts=1 单次失败即降级（改策略后触发行为变化）
    #[test]
    fn guard_respects_configurable_max_attempts() {
        let policy = SummaryRetryPolicy {
            max_attempts: 1,
            wall_clock_budget_ms: None,
            ..SummaryRetryPolicy::default()
        };
        let summarizer = ScriptedSummarizer::new(vec![Ok("退化".to_string())]);
        let outcome = summarize_with_guard(&summarizer, &[], None, &policy, &mut empty_wait());
        assert!(outcome.degraded);
        assert_eq!(outcome.attempts, 1);
        // 同一输入换回默认策略（3 次）→ 全部退化仍降级，但次数为 3
        let summarizer = ScriptedSummarizer::new(vec![Ok("退化".to_string())]);
        let outcome = summarize_with_guard(
            &summarizer,
            &[],
            None,
            &SummaryRetryPolicy::default(),
            &mut empty_wait(),
        );
        assert!(outcome.degraded);
        assert_eq!(outcome.attempts, 3);
    }

    /// 墙钟预算为 0：一次尝试后立即降级
    #[test]
    fn guard_wall_clock_budget_zero_stops_immediately() {
        let policy = SummaryRetryPolicy {
            max_attempts: 10,
            wall_clock_budget_ms: Some(0),
            ..SummaryRetryPolicy::default()
        };
        let summarizer = ScriptedSummarizer::new(vec![Err("超时".to_string())]);
        let outcome = summarize_with_guard(&summarizer, &[], None, &policy, &mut empty_wait());
        assert!(outcome.degraded);
        assert_eq!(outcome.attempts, 1);
    }

    /// Schema V1 合法摘要文档（Summarizer 成功路径返回；T-13 R-G 场景 A）。
    /// 正文 > 500 字符以通过护栏退化判定（grok MIN_SUMMARY_SEED_CHARS）
    fn summary_doc_json(goal: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "blockId": "unused",
            "generation": 1,
            "droppedIds": [],
            "height": 1,
            "tier": "chunk",
            "goal": goal,
            "constraints": [],
            "progress": [],
            "decisions": [],
            "nextSteps": [],
            "criticalContext": "折叠链冻结 + 中性 stub（R-C）+ Schema V1 文档 md 渲染投影（R-G）：链消息逐字节稳定，可追溯可恢复；同步单次尝试（R-F）；摘要就绪以块表为准，对话 stub 永不改写。".repeat(5),
        })
        .to_string()
    }

    // ── RetryGuardSummarizer（Summarizer 包装，可注入引擎）──

    /// 包装成功路径：引擎产出 LLM 摘要（Schema V1 文档 md 渲染），
    /// last_outcome 留痕
    #[test]
    fn retry_guard_wrapper_success_into_engine() {
        let guard = RetryGuardSummarizer::new(
            Box::new(ScriptedSummarizer::new(vec![Ok(summary_doc_json("实现双阈值压缩"))])),
            SummaryRetryPolicy::default(),
            empty_wait(),
        );
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-04T10:00:00.000Z", vec![text_block(&"长".repeat(100))]),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:01.000Z", vec![text_block(&"长".repeat(100))]),
            amsg("u2", AgentMessageRole::User, "2026-08-04T10:00:02.000Z", vec![text_block("keep")]),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-04T10:00:03.000Z", vec![text_block("keep")]),
        ];
        let keep = crate::count_agent_message_tokens(&messages[2]) + crate::count_agent_message_tokens(&messages[3]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&guard));
        assert!(plan.summary_is_llm);
        // md 渲染投影进链（T-13：合法 JSON 文档 → summary_to_markdown）
        assert!(plan.summary.contains("## Goal"));
        assert!(plan.summary.contains("实现双阈值压缩"));
        // 摘要消息入对话（system 后、保留段前）
        assert!(plan.messages.iter().any(|m| m.id.starts_with("compacted-summary")));
        // metadata 快照：LLM 成功 → committed
        let summary_msg = plan
            .messages
            .iter()
            .find(|m| m.id.starts_with("compacted-summary"))
            .expect("摘要消息须入对话");
        assert_eq!(summary_msg.metadata.as_ref().unwrap()["summary"]["state"], "committed");
        // last_outcome 留痕（成功、无降级）
        let outcome = guard.last_outcome().expect("护栏须记录最近一次结果");
        assert!(!outcome.degraded);
        assert_eq!(outcome.attempts, 1);
    }

    /// 包装失败路径：连续失败 → Err → 引擎回退中性 stub（不阻塞 run），
    /// last_outcome 记录降级事实
    #[test]
    fn retry_guard_wrapper_degrades_into_engine_placeholder() {
        let guard = RetryGuardSummarizer::new(
            Box::new(ScriptedSummarizer::new(vec![
                Err("provider error".to_string()),
                Err("provider error".to_string()),
                Err("provider error".to_string()),
            ])),
            SummaryRetryPolicy::default(),
            empty_wait(),
        );
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-04T10:00:00.000Z", vec![text_block(&"长".repeat(100))]),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:01.000Z", vec![text_block(&"长".repeat(100))]),
            amsg("u2", AgentMessageRole::User, "2026-08-04T10:00:02.000Z", vec![text_block("keep")]),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-04T10:00:03.000Z", vec![text_block("keep")]),
        ];
        let keep = crate::count_agent_message_tokens(&messages[2]) + crate::count_agent_message_tokens(&messages[3]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&guard));
        // 中性 stub 语义（T-13：R-C 永不改写；块 id + 丢弃数，无"生成中"措辞）
        assert!(!plan.summary_is_llm);
        assert!(
            plan.summary.contains("[Compacted(compacted-summary-1-1)"),
            "stub 须携带块 id：{}",
            plan.summary
        );
        assert!(plan.summary.contains("2 条消息"));
        assert!(!plan.summary.contains("生成中"));
        // 降级事实可读
        let outcome = guard.last_outcome().expect("护栏须记录最近一次结果");
        assert!(outcome.degraded);
        assert_eq!(outcome.attempts, 3);
        assert_eq!(outcome.last_error.as_deref(), Some("provider error"));
    }

    // ── covers_up_to_turn ──

    #[test]
    fn covers_up_to_turn_counts_dropped_user_turns() {
        let dropped = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-04T10:00:00.000Z", vec![text_block("system")]),
            amsg("u1", AgentMessageRole::User, "2026-08-04T10:00:01.000Z", vec![text_block("第一轮")]),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:02.000Z", vec![text_block("答复一")]),
            amsg("u2", AgentMessageRole::User, "2026-08-04T10:00:03.000Z", vec![text_block("第二轮")]),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-04T10:00:04.000Z", vec![text_block("答复二")]),
        ];
        // 丢弃段含 u1/a1/u2/a2 → 覆盖到第 2 轮
        assert_eq!(covers_up_to_turn_for_dropped(&flat(&dropped)), Some(2));
        // 丢弃段无用户消息 → None
        let no_user = vec![
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:00.000Z", vec![text_block("x")]),
        ];
        assert_eq!(covers_up_to_turn_for_dropped(&flat(&no_user)), None);
        assert_eq!(covers_up_to_turn_for_dropped(&[]), None);
    }

    /// 事件 details 载荷：camelCase 字段、覆盖边界、降级与尝试次数留痕
    #[test]
    fn compaction_event_details_payload_shape() {
        let dropped = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-04T10:00:00.000Z", vec![text_block("第一轮")]),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:01.000Z", vec![text_block("答复")]),
        ];
        let value = compaction_event_details(&flat(&dropped), true, 3);
        let map = value.as_object().expect("载荷必须是 JSON 对象");
        assert_eq!(map.get("coversUpToTurn"), Some(&serde_json::json!(1)));
        assert_eq!(map.get("degraded"), Some(&serde_json::json!(true)));
        assert_eq!(map.get("summaryAttempts"), Some(&serde_json::json!(3)));
        assert_eq!(map.get("droppedCount"), Some(&serde_json::json!(2)));
        // 无可覆盖轮次 → null
        let value = compaction_event_details(&[], false, 1);
        assert_eq!(value.get("coversUpToTurn"), Some(&serde_json::Value::Null));
        // 序列化回环稳定（camelCase 字段名）
        let roundtrip: serde_json::Value = serde_json::from_str(&serde_json::to_string(&value).unwrap()).unwrap();
        assert_eq!(roundtrip, value);
    }

    #[test]
    fn summary_outcome_shape() {
        let outcome = SummaryOutcome {
            summary: None,
            degraded: true,
            attempts: 3,
            degenerate_attempts: 0,
            last_error: Some("x".to_string()),
        };
        assert!(outcome.degraded);
    }
}
