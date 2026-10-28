//! 查询域契约类型与纯解析面（core_get_status / read-*-events /
//! get-run-snapshot 三命令的数据契约）
//!
//! 自壳层 `core_query_commands.rs` 下沉的类型与纯函数；壳层保留
//! `#[tauri::command]` 薄壳与 build_status 组装（依赖宿主 log_dir /
//! 配置单例）。全部 wire 形状（camelCase）在此冻结。

use conex_types::events::{AgentEventEnvelope, RunCacheStats, EVENT_ENVELOPE_SCHEMA_VERSION};
use serde::Serialize;

// ===== 分页常量（S-15/S-16：显式上限，防无界查询）=====

/// 默认每页事件数（对齐 daemon read-*-events 的 maxEvents 缺省）。
pub const DEFAULT_PAGE_SIZE: u64 = 200;
/// 每页事件数上限（超出按上限截断，不报错）。
pub const MAX_PAGE_SIZE: u64 = 1000;
/// 会话 / run id 长度上限（参数校验，S-15/S-16）。
pub const ID_MAX_LEN: usize = 512;

// ===== CoreStatus 字段集（AU-04 F2 冻结 v1）=====

/// provider 配置状态（输出侧唯一名 `providerStatus`；前端解析层兼容 provider/config 只读路径）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// 三态：null = store 未初始化/无法判定；false = 明确无 key
    pub has_api_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_mode: Option<String>,
}

/// 诊断条目（PE-04 T04.5：{ts, level, message}，环形缓冲 20，最旧在前）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEntry {
    /// epoch ms
    pub ts: i64,
    /// trace / debug / info / warn / error
    pub level: String,
    pub message: String,
}

/// 最近错误（PE-04 T04.5：{kind, detail, ts}，AtomicSlot 驱动）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastErrorEntry {
    /// CoreError kind（InvalidInput / Io / NotFound / Cancelled / Encoding / Internal）
    pub kind: String,
    /// 错误详情（人读）
    pub detail: String,
    /// epoch ms
    pub ts: i64,
}

/// restore 域状态（PE-08 T08.6，F2 冻结形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStatus {
    /// pending / done / failed（failed 不阻塞启动，run 命令照常可用）
    pub state: &'static str,
    /// full-replay / snapshot-incremental；pending 时为空串
    pub mode: String,
    /// 快照回退说明（None = 未回退/无说明）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_note: Option<String>,
    /// 本次恢复打断的 run 数（in-flight → interrupted）
    pub interrupted_count: usize,
    /// 事件流锚点（lastSequence 增量流；无事件时 0）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sequence: Option<u64>,
}

/// snapshot 域状态（PE-08 T08.6，F2 冻结形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStatus {
    /// 已加载快照代数（无快照 = 0）
    pub generation: u64,
    /// 快照写入时间（epoch ms；未保存过 = None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written_at: Option<i64>,
    /// 最近一次快照保存失败（P16 显式标记；None = 无失败）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// 后台任务最近终态条目（T-AB-19：core_get_status.backgroundTasks.lastFinished）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastTaskTerminal {
    pub task_id: String,
    /// 终态 wire 名（completed / failed / killed）
    pub status: String,
    /// 终态时间（epoch ms）
    pub finished_at_ms: i64,
}

/// 崩溃台账条目（T5-1b：core_get_status.lastCrash；进程内 panic 崩溃
/// 标记读出面——conex-telemetry panic hook 写崩溃文件后记录的「最后一次
/// 崩溃」，前端心跳轮询一并读取，把死文件变成可读崩溃台账）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCrashInfo {
    /// 崩溃文件名（`crash-YYYYMMDD-HHMMSS-<thread>.log`）
    pub file_name: String,
    /// 崩溃时刻（epoch ms）
    pub timestamp_ms: u64,
}

/// 后台任务汇总域（T-AB-19 增量：core_get_status.backgroundTasks 数据源；
/// 前端状态栏与诊断面板展示）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTasksSummary {
    pub active_count: usize,
    pub daemon_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_finished: Option<LastTaskTerminal>,
}

/// core_get_status 返回体（AU-04 F2 冻结 v1，serde camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    /// setup 完成标记（PE-01 T01.2 真实化：setup 失败 = false，不假装成功）
    pub initialized: bool,
    /// 壳版本（CARGO_PKG_VERSION）
    pub version: String,
    /// 引擎（session-loop）就绪
    pub engine_ready: bool,
    /// 搜索索引就绪（真实化：文件数 > 0 推断）
    pub search_index_ready: bool,
    /// 会话数据库就绪（SharedDb 真实值）
    pub db_ready: bool,
    /// 压缩能力接线标记（PE-01 T01.2：未接线 = false）
    pub compaction_ready: bool,
    pub provider_status: ProviderStatus,
    // ── PE-04 增量（T04.5-1）──
    /// 当前生效日志级别（conex_telemetry::current_level 同源）
    pub log_level: String,
    /// 日志文件层目录（面板可展示路径）
    pub log_dir: String,
    /// 最近诊断（环形 20，最旧在前；前端展示时自行 reverse）
    pub diagnostics: Vec<DiagnosticEntry>,
    /// 最近错误（AtomicSlot；None = 无错误记录）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<LastErrorEntry>,
    // ── PE-08 增量（T08.6）──
    pub restore: RestoreStatus,
    pub snapshot: SnapshotStatus,
    // ── T-AB-19 增量（run 生命周期整合）──
    /// 后台任务汇总（活跃任务数 / 守护进程数 / 最近终态；未接线或
    /// 查询失败 = 全零缺省——前端展示「无任务」）
    pub background_tasks: BackgroundTasksSummary,
    // ── P-7 增量（R2-07 D-02 收尾：/v1/status activeRuns/pendingApprovals
    // 字段补全；M6 §4.1.1 形状，注册表 StatusResult 可选字段——桌面端
    // 总是下发数组，空数组合法）──
    /// 活动 run 摘要列表（运行时真源：活动注册表；prompt 兜底空串）
    pub active_runs: Vec<crate::run::ActiveRunSummary>,
    /// 待审批摘要列表（C13 对账投影 M6 摘要子集）
    pub pending_approvals: Vec<crate::run::PendingApprovalSummary>,
    // ── T5-1b 增量（崩溃台账：进程内 panic 崩溃标记读出面）──
    /// 最近崩溃标记（None = 进程内无 panic；前端心跳轮询读取）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_crash: Option<LastCrashInfo>,
}

/// 事件分页返回（对齐 daemon read-*-events 协议：前端 `sessionEventHydrate.ts`
/// `{events, nextAfterSequence, hasMore}` 消费面）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    /// 本页事件（AgentEventEnvelope 扁平 JSON：`{type, runId, sequence, schemaVersion, ...}`，
    /// 按 sequence 升序）
    pub events: Vec<serde_json::Value>,
    /// 下一页游标（本页最后一条事件 sequence；空页 = 入参 after_sequence）
    pub next_after_sequence: u64,
    /// 是否还有更多事件
    pub has_more: bool,
}

/// run 执行统计（usage 域；前端 `parseRunSnapshotUsage` 消费面）。
///
/// P5 S5 / T-40：缓存字段扩展（cacheMissTokens / hitRatio / writeRatio /
/// missedTokens / warmUntilMs）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    /// 有真实样本的次数（0 = 无真实样本，调用方回退估算）
    #[serde(default)]
    pub sample_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// 缓存未命中输入（服务端直报优先，否则按 C9 口径推导）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_tokens: Option<u64>,
    /// 命中率 = cache_read / input_total（input_total == 0 → None，前端隐藏）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_ratio: Option<f64>,
    /// 写入占比 = cache_write / input_total
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_ratio: Option<f64>,
    /// 本 run 审计出的浪费量（detectMiss 累计；0 = 无浪费）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missed_tokens: Option<u64>,
    /// 缓存温暖截止（epoch ms；前端据此驱动冷缓存提示；None = 无 TTL 数据）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_until_ms: Option<u64>,
    /// 引擎微元账（plans/05 T5.3：唯一算费入口 = PricingEngine；None = 未定价）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<agent_provider::pricing::CostBreakdown>,
}

impl RunUsage {
    /// 从 run 级缓存统计映射为快照 usage（P5 S5 / T-40；数据源 =
    /// `RunOutcome.cache_stats`（tracker.finish 产物）或 conex-db
    /// `get_run_usage`（runs 表 v5 列）——两者同型）。
    ///
    /// - `sample_count == 0` → None（「无样本 → 前端隐藏而非 0% 误导」）；
    /// - hit_ratio / write_ratio 不直接透传（DB 落库不存派生值），
    ///   统一按 C9 恒等式重算：`input_total = miss + read + write`。
    pub fn from_run_cache_stats(
        stats: RunCacheStats,
        pricing: Option<&agent_provider::models::catalog_types::ModelPricingSpec>,
    ) -> Option<RunUsage> {
        if stats.sample_count == 0 {
            return None;
        }
        let input_total = stats
            .cache_miss_tokens
            .saturating_add(stats.cache_read_tokens)
            .saturating_add(stats.cache_write_tokens);
        let ratio = |part: u64| (input_total != 0).then(|| part as f64 / input_total as f64);
        // 唯一算费入口：PricingEngine 微元（扣 cache_read、不扣 cache_write；
        // pricing None → cost None = 未定价，不是 0）
        let cost = agent_provider::pricing::PricingEngine::calculate_cost(
            &pricing.cloned(),
            stats.prompt_tokens,
            stats.completion_tokens,
            stats.cache_read_tokens,
            stats.cache_write_tokens,
        );
        Some(RunUsage {
            prompt_tokens: stats.prompt_tokens,
            completion_tokens: stats.completion_tokens,
            total_tokens: stats.total_tokens,
            sample_count: stats.sample_count,
            cache_read_tokens: Some(stats.cache_read_tokens),
            cache_write_tokens: Some(stats.cache_write_tokens),
            cache_miss_tokens: Some(stats.cache_miss_tokens),
            hit_ratio: ratio(stats.cache_read_tokens),
            write_ratio: ratio(stats.cache_write_tokens),
            missed_tokens: Some(stats.missed_tokens),
            warm_until_ms: stats.warm_until_ms,
            cost,
        })
    }
}

/// run 快照（`{snapshot: {...}}` 包装；对齐 daemon get-run-snapshot 协议——
/// `StreamRecovery` / `parseRunSnapshotUsage` 均先读 `res.snapshot`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotResponse {
    pub snapshot: RunSnapshot,
}

/// run 快照本体（status 字面量对齐 conex-db `RunStatus::as_str`：queued / running /
/// completed / failed / cancelled / ...）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: String,
    pub session_id: String,
    pub status: String,
    /// 事件序列游标（已分配最大 sequence）
    pub cursor: u64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    /// 终态错误文案（failed 收场时）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// usage 域（引擎未接线统计时缺省）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<RunUsage>,
}

/// 参数校验：session_id 非空 + 长度上限（S-15/S-16，显式 InvalidInput）。
pub fn require_session_id(session_id: &str) -> Result<(), crate::core_error::CoreError> {
    if session_id.trim().is_empty() {
        return Err(crate::core_error::CoreError::InvalidInput(
            "session_id must not be empty".to_string(),
        ));
    }
    if session_id.len() > ID_MAX_LEN {
        return Err(crate::core_error::CoreError::InvalidInput(format!(
            "session_id too long (max {ID_MAX_LEN})"
        )));
    }
    Ok(())
}

/// 参数校验：run_id 非空 + 长度上限。
pub fn require_run_id(run_id: &str) -> Result<(), crate::core_error::CoreError> {
    if run_id.trim().is_empty() {
        return Err(crate::core_error::CoreError::InvalidInput(
            "run_id must not be empty".to_string(),
        ));
    }
    if run_id.len() > ID_MAX_LEN {
        return Err(crate::core_error::CoreError::InvalidInput(format!(
            "run_id too long (max {ID_MAX_LEN})"
        )));
    }
    Ok(())
}

/// 归一化 max_events：缺省 DEFAULT_PAGE_SIZE，夹紧到 [1, MAX_PAGE_SIZE]。
pub fn normalize_max_events(max_events: Option<u64>) -> usize {
    max_events
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE) as usize
}

/// 信封解析三态统计（DM-06 / D-01：消灭「库里躺着读不出」的静默丢弃）。
///
/// 计数供调用方告警/观测：corrupt 与 passthrough 是异常形状（磁盘损坏 /
/// 不可合成行），synthesized 是正常兼容面（legacy / 直写镜像行合成透出）。
/// 三态均**不抛错、不中断整批**读取（防御语义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EnvelopeParseStats {
    /// 态 1：非法 JSON（无法解析为任何 JSON 值）——跳过
    pub corrupt_skipped: usize,
    /// 态 2：typed 信封（AgentEventEnvelope 反序列化成功）——正常解析 + sequence 回填
    pub typed: usize,
    /// 态 3a：合法 JSON 但缺 type 标签（run-interrupted / recovery-* 镜像 /
    /// legacy 行）——D8 合成 fallback 透出
    pub synthesized: usize,
    /// 态 3b：合法 JSON 但非对象（数组/标量，无法合成事件对象）——
    /// rawPayload 包装透出（显式保留原文，不静默丢弃）
    pub passthrough: usize,
}

/// 把持久化事件行解析为 wire JSON（`{type, runId, sequence, schemaVersion, ...}`），
/// 三态处理（DM-06 / D-01 完成定义 ①）：
/// 1. **corrupt**：非法 JSON → 跳过 + 计数（磁盘损坏不中断整页）；
/// 2. **typed 信封**：正常 AgentEventEnvelope → 解析 + **sequence 回填**
///    （行级 sequence 列 → 信封 sequence 字段，列 = sequence 权威，G-05）；
/// 3. **无 type 标签的合法 JSON**（run-interrupted / recovery-* 镜像 / legacy
///    行）→ [synthesize_fallback_wire] D8 合成 fallback 透出，**不丢弃**；
///    非对象 JSON 经 rawPayload 包装显式透出。
pub fn parse_envelopes(
    events: &[orchestrator::persist::PersistedEvent],
) -> (Vec<(u64, serde_json::Value)>, EnvelopeParseStats) {
    let mut stats = EnvelopeParseStats::default();
    let mut out = Vec::with_capacity(events.len());
    for event in events {
        let value: serde_json::Value = match serde_json::from_str(&event.payload) {
            Ok(value) => value,
            Err(_) => {
                // 态 1：非法 JSON 跳过（磁盘损坏防御，不中断整批读取）
                stats.corrupt_skipped += 1;
                continue;
            }
        };
        let wire = match serde_json::from_value::<AgentEventEnvelope>(value.clone()) {
            Ok(mut envelope) => {
                // 态 2：typed 信封——sequence 列权威回填（G-05）；DM-07 P3：
                // runId 取值 = payload 信封优先，缺失时列值兜底
                stats.typed += 1;
                envelope.sequence = Some(event.sequence);
                if envelope.run_id.is_none() {
                    envelope.run_id = event.run_id.clone();
                }
                envelope_to_value(&envelope)
            }
            Err(_) => {
                // 态 3：无 type 标签 → D8 合成 fallback（typed 优先顺序不变）
                if value.is_object() {
                    stats.synthesized += 1;
                } else {
                    stats.passthrough += 1;
                }
                Some(synthesize_fallback_wire(event, &value))
            }
        };
        if let Some(wire) = wire {
            out.push((event.sequence, wire));
        }
    }
    (out, stats)
}

/// D8 合成 fallback（态 3）：缺 type 标签的合法 JSON（run-interrupted /
/// recovery-* 镜像 / legacy 行）→ 按列与 payload 已知键合成 wire，原始字段
/// 全量透传，**不丢弃**（消灭 G-02/G-20 读侧静默丢弃）。
fn synthesize_fallback_wire(
    event: &orchestrator::persist::PersistedEvent,
    payload: &serde_json::Value,
) -> serde_json::Value {
    let mut wire = serde_json::Map::new();
    match payload {
        serde_json::Value::Object(map) => {
            // 原始字段透传（镜像/legacy 行的全部已知键）
            wire.extend(map.clone());
            // type 键路由：行级 event_type 列权威（镜像行无此键，列补全）
            wire.insert("type".into(), serde_json::json!(event.event_type));
            // 契约键缺省补全（列权威；键显式 String——serde_json
            // entry<S: Into<String>> 泛型下 .into() 歧义）
            wire.entry("schemaVersion".to_string())
                .or_insert(serde_json::json!(EVENT_ENVELOPE_SCHEMA_VERSION));
            wire.entry("sessionId".to_string())
                .or_insert(serde_json::json!(event.session_id));
            // runId 取值顺序（DM-07 P3）：payload runId 键透传优先 → 列兜底 →
            // 镜像键推断（run_id snake_case / subagentRunId）
            if !wire.contains_key("runId") {
                let run_id = event.run_id.as_deref().or_else(|| {
                    ["run_id", "subagentRunId"]
                        .iter()
                        .find_map(|key| map.get(*key).and_then(serde_json::Value::as_str))
                });
                if let Some(run_id) = run_id {
                    wire.insert("runId".into(), serde_json::json!(run_id));
                }
            }
            // sequence 列权威回填（G-05；镜像行无 sequence 键）
            wire.insert("sequence".into(), serde_json::json!(event.sequence));
        }
        other => {
            // 无法合成事件对象的行：显式透出原文（rawPayload），不静默丢弃
            wire.insert("type".into(), serde_json::json!(event.event_type));
            wire.insert("sequence".into(), serde_json::json!(event.sequence));
            wire.insert(
                "schemaVersion".into(),
                serde_json::json!(EVENT_ENVELOPE_SCHEMA_VERSION),
            );
            wire.insert("sessionId".into(), serde_json::json!(event.session_id));
            wire.insert("rawPayload".into(), other.clone());
        }
    }
    serde_json::Value::Object(wire)
}

/// 信封 → 扁平 wire JSON（`{type, runId, sequence, schemaVersion, ...事件字段}`）。
pub fn envelope_to_value(envelope: &AgentEventEnvelope) -> Option<serde_json::Value> {
    serde_json::to_value(envelope).ok()
}

/// 解析防御统计告警（DM-06：corrupt 跳过与 passthrough 透出是异常形状——
/// 磁盘损坏 / 不可合成行，告警不静默；synthesized 是正常兼容面不告警防噪音）。
pub fn warn_parse_stats(scope: &str, session_id: &str, stats: &EnvelopeParseStats) {
    if stats.corrupt_skipped > 0 || stats.passthrough > 0 {
        tracing::warn!(
            scope = %scope,
            session_id = %session_id,
            corrupt_skipped = stats.corrupt_skipped,
            synthesized = stats.synthesized,
            passthrough = stats.passthrough,
            "事件解析防御统计（corrupt 跳过 / 非对象行透出）"
        );
    }
}

/// 纯分页：从全量（已按 sequence 升序）切出前 `max_events` 条，返回 (页, hasMore)。
pub fn paginate<T>(all: Vec<T>, max_events: usize) -> (Vec<T>, bool) {
    if all.len() <= max_events {
        return (all, false);
    }
    let page = all.into_iter().take(max_events).collect::<Vec<_>>();
    (page, true)
}
