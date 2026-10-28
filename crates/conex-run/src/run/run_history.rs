//! run/run_history.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use conex_compaction::count_tokens;
use conex_types::context::ContextBudget;
use conex_types::history::HistoryMessage;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use session_loop::RunOutcome;

use crate::engine_handle::EngineHandle;

use super::{
    SESSION_HISTORY_MAX_SESSIONS, SESSION_HISTORY_MESSAGE_TOKEN_OVERHEAD,
    SESSION_HISTORY_TOKEN_BUDGET,
};
// ── SessionHistoryCache（T-29：per-session 历史缓存）────────────

/// 引擎壳侧 per-session 历史缓存（P4 阶段 1-3/1-4，任务单元 T-29）
///
/// - 结构：`session_id → Vec<HistoryMessage>`——与前端 `history` 参数
///   同构（混合路线统一载荷形态，P4 §3.2.3）；
/// - 内存态、不落库：避免与前端全量写 session_messages 双写冲突
///   （P4 §1.3 验收红线 2）；不改写会话语义；
/// - 写入时机：run 收口（[drive_run_loop] 收口处，[RunOutcome]::messages
///   收口映射后原子替换 = 压缩后缓存基线重建，P4 §3.6 I5 / C13）；
/// - 读取：下次 run 组装 history 参数（[core_run_task]：前端 history
///   为空/未传时回退本缓存——混合路线"引擎侧缓存主"）；
/// - 容量护栏：每会话消息条数上限 + 会话数上限（防膨胀）。
pub(crate) struct SessionHistoryCache {
    pub(crate) inner: Mutex<CacheInner>,
    /// 每会话 token 预算（DEEPCHECK-01 P0 起替代消息条数上限）
    pub(crate) max_tokens: usize,
    /// 会话数上限
    pub(crate) max_sessions: usize,
}

pub(crate) struct CacheInner {
    pub(crate) sessions: HashMap<String, Vec<HistoryMessage>>,
    /// 写入顺序（FIFO 淘汰最久未更新的会话；重复写入移到末尾 ≈ LRU）
    pub(crate) order: VecDeque<String>,
}

impl SessionHistoryCache {
    /// 新建缓存（默认容量：每会话 `SESSION_HISTORY_TOKEN_BUDGET` token、
    /// 最多 `SESSION_HISTORY_MAX_SESSIONS` 个会话）
    pub(crate) fn new() -> Self {
        Self::with_limits(SESSION_HISTORY_TOKEN_BUDGET, SESSION_HISTORY_MAX_SESSIONS)
    }

    /// 新建缓存（显式容量；测试用小容量验证上限语义）
    /// `max_tokens`：每会话 token 预算（DEEPCHECK-01 P0 起替代消息条数上限）
    pub(crate) fn with_limits(max_tokens: usize, max_sessions: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                sessions: HashMap::new(),
                order: VecDeque::new(),
            }),
            max_tokens,
            max_sessions,
        }
    }

    /// 读取会话历史（下次 run 组装 history 参数的缓存源；None = 无缓存）
    pub(crate) fn get(&self, session_id: &str) -> Option<Vec<HistoryMessage>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .get(session_id)
            .cloned()
    }

    /// 写入会话历史（run 收口原子替换）
    ///
    /// 写入前执行两级护栏（DEEPCHECK-01 P0：锚点 + 预算，跨 run 前缀稳定）：
    /// 1. token 预算：超预算按 [truncate_history_with_anchor] 截断——首条
    ///    user 锚点恒在 + 尾部预算窗口（不再固定条数尾部滑窗）；
    /// 2. 安全前缀：逐条前移直到首条为 user（不保留孤儿 tool/system
    ///    首条与带未配对 ToolCall 的 assistant 首条——wire 400 风险）。
    ///
    /// 会话数超限：FIFO 淘汰最久未更新的会话。
    pub(crate) fn store(&self, session_id: &str, mut messages: Vec<HistoryMessage>) {
        truncate_history_with_anchor(&mut messages, self.max_tokens);
        ensure_safe_prefix(&mut messages);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = inner.order.iter().position(|id| id == session_id) {
            inner.order.remove(pos);
        }
        inner.order.push_back(session_id.to_string());
        while inner.order.len() > self.max_sessions {
            if let Some(oldest) = inner.order.pop_front() {
                inner.sessions.remove(&oldest);
            }
        }
        inner.sessions.insert(session_id.to_string(), messages);
    }
}

/// DEEPCHECK-01 P0：历史截断统一语义——「稳定锚点 + token 预算」（前端
/// buildHistoryMessages / 引擎缓存读写三层同语义，跨 run 请求前缀稳定）。
///
/// 语义：
/// 1. 预算内 → 原样保留（append-only，请求前缀天然字节稳定，服务端自动
///    前缀缓存全量命中——不再逐轮尾部滑窗整体漂移）；
/// 2. 超预算 → 锚点恒在：保留「首条 user 消息及其前的稳定头部」，其余从
///    最老消息起逐条让位直到尾部窗口装入预算（预算内尾部截断而非固定
///    条数截断）——锚点 = 会话首条 user，永不因截断消失，失配点收敛到
///    尾部增量；
/// 3. 尾部边界 wire 安全：截断点不落在孤儿 tool 消息（其 ToolCall 已被
///    截掉，结果在截断区必然紧随其调用，故只可能落在窗口起点）或携带
///    孤儿 ToolCall 的 assistant 上（wire 400 风险，与 [ensure_safe_prefix]
///    同语义；前端载荷仅 user/assistant 且单条自包含，无此步骤）。
pub(crate) fn truncate_history_with_anchor(messages: &mut Vec<HistoryMessage>, max_tokens: usize) {
    let total: usize = messages.iter().map(estimate_history_tokens).sum();
    if messages.is_empty() || total <= max_tokens {
        return;
    }
    // 锚点 = 首条 user 消息；无 user → 以首条为锚（退化形态仍保证前缀稳定）
    let anchor_end = messages
        .iter()
        .position(|m| m.sender == "user")
        .unwrap_or(0);
    let head_tokens: usize = messages[..=anchor_end]
        .iter()
        .map(estimate_history_tokens)
        .sum();
    // 尾部窗口：从旧到新尽量多带（tail_start 尽可能小，预算内）
    let mut tail_start = anchor_end + 1;
    let mut tail_tokens = total - head_tokens;
    while tail_start < messages.len() && head_tokens + tail_tokens > max_tokens {
        tail_tokens -= estimate_history_tokens(&messages[tail_start]);
        tail_start += 1;
    }
    // 尾部边界 wire 安全：跳过孤儿 tool 首条与携带孤儿 ToolCall 的
    // assistant（结果消息的调用恒在其前，孤儿只可能落在窗口起点）
    while tail_start < messages.len() {
        let must_drop = match messages[tail_start].sender.as_str() {
            "tool" | "system" => true,
            "assistant" => first_has_orphan_tool_call(&messages[tail_start..]),
            _ => false,
        };
        if !must_drop {
            break;
        }
        tail_start += 1;
    }
    // 移除锚点后到尾部窗口起点之间的中间段（锚点与尾部恒在）
    if tail_start > anchor_end + 1 {
        messages.drain(anchor_end + 1..tail_start);
    }
}

/// 单条 HistoryMessage 的 token 估算（对齐前端 estimateHistoryMessageTokens：
/// 复用 conex-compaction count_tokens 启发式——ASCII 单词约 4 字符/token、
/// 分隔符与 CJK 每字符 1 token；固定消息开销 8 token）。
///
/// 字段口径：缓存路径消息带完整 `blocks_json`（收口保真）→ 直接估算其
/// JSON 序列（覆盖 text/thinking/tool-call/tool-result 全部块与输出正文）；
/// 缺块（前端载荷形态）→ 按 text/thinking/tool_calls_json/
/// tool_call_results_json 合成字段估算。
pub(crate) fn estimate_history_tokens(entry: &HistoryMessage) -> usize {
    let content_tokens = if let Some(blocks) = entry.blocks_json.as_deref() {
        count_tokens(blocks)
    } else {
        entry.text.as_deref().map(count_tokens).unwrap_or(0)
            + entry.thinking.as_deref().map(count_tokens).unwrap_or(0)
            + entry
                .tool_calls_json
                .as_deref()
                .map(count_tokens)
                .unwrap_or(0)
            + entry
                .tool_call_results_json
                .as_deref()
                .map(count_tokens)
                .unwrap_or(0)
    };
    content_tokens + SESSION_HISTORY_MESSAGE_TOKEN_OVERHEAD
}

/// 缓存安全前缀化：首条不得为 tool/system（孤儿——需要前置上下文），
/// 也不得为携带未配对 ToolCall 的 assistant（孤儿调用——wire 400）。
/// 逐条前移直到首条为 user（或序列为空）。
pub(crate) fn ensure_safe_prefix(messages: &mut Vec<HistoryMessage>) {
    while let Some(first) = messages.first() {
        let must_drop = match first.sender.as_str() {
            "tool" | "system" => true,
            "assistant" => first_has_orphan_tool_call(messages),
            _ => false,
        };
        if must_drop {
            messages.remove(0);
        } else {
            break;
        }
    }
}

/// 首条 assistant 是否携带孤儿 ToolCall（其调用 id 在后续消息中无
/// 对应 ToolResult——截断落在 assistant(tool_calls) 与其结果之间）。
/// 全部调用都有结果才算配对完整（wire 要求每个 call 都有 result）。
pub(crate) fn first_has_orphan_tool_call(messages: &[HistoryMessage]) -> bool {
    let Some(first) = messages.first() else {
        return false;
    };
    let Some(blocks) = parse_blocks(first) else {
        return false;
    };
    let call_ids: Vec<&str> = blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::ToolCall(call) => Some(call.id.as_str()),
            _ => None,
        })
        .collect();
    if call_ids.is_empty() {
        return false;
    }
    let has_all_results = call_ids.iter().all(|call_id| {
        messages.iter().skip(1).any(|entry| {
            parse_blocks(entry).is_some_and(|entry_blocks| {
                entry_blocks.iter().any(|block| match block {
                    AgentMessageBlock::ToolResult { tool_call_id, .. } => tool_call_id == call_id,
                    _ => false,
                })
            })
        })
    });
    !has_all_results
}

/// 解析 HistoryMessage 的 blocks_json（缓存收口/读回均保真携带完整块序列）
pub(crate) fn parse_blocks(entry: &HistoryMessage) -> Option<Vec<AgentMessageBlock>> {
    entry
        .blocks_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<AgentMessageBlock>>(json).ok())
}

// ── T-29 收口映射：RunOutcome::messages → HistoryMessage ─────────

/// run 收口：对话消息 → HistoryMessage（任务书第 4 点）
///
/// - **全角色保真**（user/assistant/tool/system 都收口）：引擎缓存是
///   权威增量，工具结果（Tool 角色独立消息，executing_tools.rs:143-158）
///   必须原样续接，否则 wire 前缀 tool_call 无对应 result（400）；
///   hydrate.rs 的前端过滤规则（P4 §3.2.3 规则 2）只适用于 UI 载荷，
///   不适用于本收口路径（读回走 [cached_history_to_conversation] 保真水合）；
/// - `blocks_json` 保真（完整 AgentMessageBlock 序列）；`tool_calls_json`
///   /`tool_call_results_json` 置 None（有 blocks_json 时不再需要合成源）；
/// - `status = completed`（收口消息均为完成态）；
/// - `timestamp` = created_at 的 epoch ms 折算。
pub(crate) fn to_history_messages(outcome: &RunOutcome) -> Vec<HistoryMessage> {
    outcome
        .messages
        .iter()
        .map(|message| to_history_message(message.as_ref()))
        .collect()
}

/// 单条 AgentMessage → HistoryMessage（全角色保真）
pub(crate) fn to_history_message(message: &AgentMessage) -> HistoryMessage {
    HistoryMessage {
        id: message.id.clone(),
        sender: role_sender(message.role),
        text: non_empty(message.text()),
        thinking: non_empty(message.thought()),
        blocks_json: if message.blocks.is_empty() {
            None
        } else {
            serde_json::to_string(&message.blocks).ok()
        },
        tool_calls_json: None,
        tool_call_results_json: None,
        status: Some("completed".to_string()),
        timestamp: iso8601_to_epoch_millis(&message.created_at),
    }
}

/// 角色 → sender 字符串（与 hydrate.rs 规则 2 的 user/assistant 子集
/// 兼容，额外保留 tool/system——缓存路径读回不过滤）
pub(crate) fn role_sender(role: AgentMessageRole) -> String {
    match role {
        AgentMessageRole::System => "system",
        AgentMessageRole::User => "user",
        AgentMessageRole::Assistant => "assistant",
        AgentMessageRole::Tool => "tool",
    }
    .to_string()
}

/// 空串 → None（HistoryMessage 载荷字段可选语义）
pub(crate) fn non_empty(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ── T-29 时间戳互逆（与 session-loop hydrate.rs 同源算法）────────

/// ISO8601 → epoch ms（引擎统一格式 `YYYY-MM-DDTHH:MM:SS.mmmZ`；
/// 宽容解析：毫秒段可缺省（`SSZ`），时区仅接受 Z；失败兜底 0）
pub(crate) fn iso8601_to_epoch_millis(iso: &str) -> i64 {
    let Some((date, rest)) = iso.split_once('T') else {
        return 0;
    };
    let mut parts = date.split('-');
    let (Some(year), Some(month), Some(day)) = (
        parts.next().and_then(|v| v.parse::<i64>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
    ) else {
        return 0;
    };
    let mut time = rest.split(':');
    let (Some(hour), Some(minute)) = (
        time.next().and_then(|v| v.parse::<i64>().ok()),
        time.next().and_then(|v| v.parse::<i64>().ok()),
    ) else {
        return 0;
    };
    let sec_rest = time.next().unwrap_or("0");
    let stripped = sec_rest.strip_suffix('Z').unwrap_or(sec_rest);
    let (sec, millis) = match stripped.split_once('.') {
        Some((s, ms)) => (
            s.parse::<i64>().unwrap_or(0),
            ms.parse::<i64>().unwrap_or(0),
        ),
        None => (stripped.parse::<i64>().unwrap_or(0), 0),
    };
    let days = days_from_civil(year, month, day);
    ((days * 86_400 + hour * 3600 + minute * 60 + sec) * 1000) + millis
}

/// 公历年月日 → Unix 天数（Howard Hinnant civil_from_days 的逆函数；
/// 与 session-loop hydrate.rs / steering mod.rs 同源算法）
pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// epoch ms → ISO8601（毫秒精度 UTC；算法与 session-loop hydrate.rs
/// iso8601_from_epoch_millis 同源——读回缓存还原 created_at 用）
pub(crate) fn epoch_millis_to_iso8601(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1000);
    let millis = epoch_ms.rem_euclid(1000);
    let (hours, minutes, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{sec:02}.{millis:03}Z")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法，与 session-loop
/// hydrate.rs:251-271 同源，不引入 chrono 依赖）
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

// ── T-29 读回水合与混合路线装配 ──────────────────────────────────

/// 缓存读回 → 对话（**保真水合**：T-29 缓存路径，与 T-28 前端载荷
/// 过滤规则互补——缓存是引擎权威增量，tool/system 角色与完整 blocks
/// 原样续接，工具结果配对不拆散；单条不可用（角色未知 / blocks 不可
/// 解析）宽容跳过，不中断整体）
///
/// DEEPCHECK-01 P0：读回前同样按「锚点 + token 预算」截断（与 store 写入
/// 语义对齐的防御性一致性；正常路径 store 已截断，此处幂等）。
pub(crate) fn cached_history_to_conversation(
    entries: Vec<HistoryMessage>,
) -> Vec<Arc<AgentMessage>> {
    let mut entries = entries;
    truncate_history_with_anchor(&mut entries, SESSION_HISTORY_TOKEN_BUDGET);
    entries
        .iter()
        .filter_map(|entry| {
            let role = match entry.sender.as_str() {
                "user" => AgentMessageRole::User,
                "assistant" => AgentMessageRole::Assistant,
                "tool" => AgentMessageRole::Tool,
                "system" => AgentMessageRole::System,
                _ => return None,
            };
            let blocks = parse_blocks(entry).unwrap_or_default();
            if blocks.is_empty() {
                return None;
            }
            Some(Arc::new(AgentMessage {
                id: entry.id.clone(),
                role,
                created_at: epoch_millis_to_iso8601(entry.timestamp),
                blocks,
                // metadata 裁剪（usage 等运行期数据不进 LLM 上下文，双保险）
                metadata: None,
                client_message_id: Some(entry.id.clone()),
                content: None,
            }))
        })
        .collect()
}

/// 历史装配源（P4 §3.2.3 混合路线：前端水合兜底 + 引擎侧缓存主）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistorySource {
    /// 前端 store 已完成消息（冷启动/重启后的第一个 run）
    Frontend,
    /// 引擎侧 SessionHistoryCache（运行期连续 run 的权威增量）
    Cache,
}

/// 历史源判定：前端 history 非空 → Frontend；为空/未传但缓存有值 →
/// Cache；两者皆无 → None（现状单消息 run，向后兼容）。
pub(crate) fn resolve_history_source(
    history: &Option<Vec<HistoryMessage>>,
    cached: Option<Vec<HistoryMessage>>,
) -> Option<(HistorySource, Vec<HistoryMessage>)> {
    match history {
        Some(h) if !h.is_empty() => Some((HistorySource::Frontend, h.clone())),
        _ => cached.map(|messages| (HistorySource::Cache, messages)),
    }
}

/// context_window 入站 → ContextBudget（P4 §3.3.2：reserve/safety 取
/// 默认 16384/4096；T-33 在 SessionLoopOptions.context_budget 消费钳制）
pub(crate) fn assemble_context_budget(context_window: u32) -> ContextBudget {
    ContextBudget {
        context_window,
        ..ContextBudget::default()
    }
}

/// 预算入站解析（resolve_context_budget，Wave 1 规范化）：
/// 显式 context_window（前端/调用方下发）优先；未下发时（普通主 run、空闲续 run、
/// 子代理 run），统一按生效模型 Provider Catalog 模型目录窗口兜底
/// （crate::engine_provider::protocol::effective_context_window），避免 budget is None
/// 导致预检与压缩断裂；若目录中模型窗口缺失，则回退为 None（不钳制）。
pub(crate) fn resolve_context_budget(
    context_window: Option<u32>,
    _subagent_config: &Option<crate::subagent_spawner::SubagentRunConfig>,
    engine: &EngineHandle,
) -> Option<ContextBudget> {
    match context_window {
        Some(window) => Some(assemble_context_budget(window)),
        None => engine
            .provider_config()
            .and_then(|config| crate::engine_provider::protocol::effective_context_window(&config))
            .map(assemble_context_budget),
    }
}

// ── COMPACTION-01 P0-1：压缩策略装配（session_meta 键面）────────────

/// session_meta 键（预留）：保留最近 token 预算覆盖
/// （conex-compaction 缺省 [conex_compaction::KEEP_RECENT_TOKENS_DEFAULT]）
pub(crate) const META_KEY_COMPACT_KEEP_RECENT_TOKENS: &str = "compact_keep_recent_tokens";
/// session_meta 键（预留）：保留最近完整回合数下限覆盖
/// （conex-compaction 缺省 [conex_compaction::MIN_RECENT_TURNS_DEFAULT]）
pub(crate) const META_KEY_COMPACT_MIN_RECENT_TURNS: &str = "compact_min_recent_turns";

/// session_meta 键 → [conex_compaction::compaction::CompactionPolicy]
/// （COMPACTION-01 P0-1 装配 helper：缺省 = 常量默认；键缺失 / 坏值回退
/// 默认 + warn，不 panic）。
///
/// `meta`：键 → 值读取面（生产经 `LocalDb::get_session_meta` 注入；
/// 测试注入内存表）。
pub(crate) fn compaction_policy_from_session_meta(
    meta: impl Fn(&str) -> Option<String>,
) -> conex_compaction::compaction::CompactionPolicy {
    let mut policy = conex_compaction::compaction::CompactionPolicy::default();
    if let Some(raw) = meta(conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS) {
        match raw.trim().parse::<usize>() {
            Ok(value) if value > 0 => policy.max_summary_tokens = value,
            _ => tracing::warn!(
                key = conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
                raw = %raw,
                default = conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 max_summary_tokens"
            ),
        }
    }
    if let Some(raw) = meta(META_KEY_COMPACT_KEEP_RECENT_TOKENS) {
        match raw.trim().parse::<usize>() {
            Ok(value) if value > 0 => policy.keep_recent_tokens = value,
            _ => tracing::warn!(
                key = META_KEY_COMPACT_KEEP_RECENT_TOKENS,
                raw = %raw,
                default = conex_compaction::KEEP_RECENT_TOKENS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 keep_recent_tokens"
            ),
        }
    }
    if let Some(raw) = meta(META_KEY_COMPACT_MIN_RECENT_TURNS) {
        match raw.trim().parse::<u32>() {
            Ok(value) if value > 0 => policy.min_recent_turns = value,
            _ => tracing::warn!(
                key = META_KEY_COMPACT_MIN_RECENT_TURNS,
                raw = %raw,
                default = conex_compaction::MIN_RECENT_TURNS_DEFAULT,
                "压缩策略键值非法 → 回退缺省 min_recent_turns"
            ),
        }
    }
    policy
}
