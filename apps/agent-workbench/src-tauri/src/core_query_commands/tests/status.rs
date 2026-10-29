//! core_query_commands 测试 · 状态投影 / 分页 / 事件信封解析。

use super::super::*;

use conex_run::core_error::CoreError;
use conex_run::core_query::{LastTaskTerminal, DEFAULT_PAGE_SIZE, ID_MAX_LEN, MAX_PAGE_SIZE};

#[test]
fn build_status_serializes_to_camel_case() {
    let status = build_status(
        true,
        "0.1.0".to_string(),
        true,
        true,
        true,
        false,
        ProviderStatus {
            has_api_key: Some(false),
            model: None,
            base_url: None,
            credential_mode: Some("direct".to_string()),
        },
        "info".to_string(),
        r"C:\logs".to_string(),
        vec![DiagnosticEntry {
            ts: 1_700_000_000_000,
            level: "error".to_string(),
            message: "disk full".to_string(),
        }],
        Some(LastErrorEntry {
            kind: "Io".to_string(),
            detail: "store.append_event: disk full".to_string(),
            ts: 1_700_000_000_001,
        }),
        RestoreStatus {
            state: "done",
            mode: "full-replay".to_string(),
            snapshot_note: None,
            interrupted_count: 2,
            last_sequence: Some(41),
        },
        SnapshotStatus {
            generation: 1,
            written_at: Some(1_700_000_000_002),
            last_error: None,
        },
        BackgroundTasksSummary {
            active_count: 3,
            daemon_count: 1,
            last_finished: Some(LastTaskTerminal {
                task_id: "task-9".to_string(),
                status: "completed".to_string(),
                finished_at_ms: 1_700_000_000_003,
            }),
        },
        // P-7（R2-07 D-02 收尾）：activeRuns / pendingApprovals 摘要
        vec![ActiveRunSummary {
            run_id: "r-1".to_string(),
            session_id: "s-1".to_string(),
            status: "running".to_string(),
            started_at: 1_700_000_000_004,
            // prompt 兜底：runs 表无 prompt 持久化，恒空串
            prompt: String::new(),
        }],
        vec![PendingApprovalSummary {
            tool_call_id: "tc-9".to_string(),
            tool_name: "shell:write".to_string(),
            run_id: Some("r-1".to_string()),
            summary: Some("npm test 需要执行权限".to_string()),
        }],
        // T5-1b：崩溃台账（进程内 panic 崩溃标记）
        Some(LastCrashInfo {
            file_name: "crash-20260816-120000-main.log".to_string(),
            timestamp_ms: 1_700_000_000_005,
        }),
    );
    let json = serde_json::to_value(&status).unwrap();
    // 基线字段 camelCase
    assert_eq!(json["initialized"], true);
    assert_eq!(json["version"], "0.1.0");
    assert_eq!(json["engineReady"], true);
    assert_eq!(json["searchIndexReady"], true);
    assert_eq!(json["dbReady"], true);
    assert_eq!(
        json["compactionReady"], false,
        "未接线压缩 = false（诚实化）"
    );
    // providerStatus（PE-01 T01.1）
    assert_eq!(json["providerStatus"]["hasApiKey"], false);
    assert_eq!(json["providerStatus"]["credentialMode"], "direct");
    assert!(
        json["providerStatus"].get("model").is_none(),
        "None 字段跳过"
    );
    // PE-04 增量
    assert_eq!(json["logLevel"], "info");
    assert_eq!(json["logDir"], r"C:\logs");
    assert_eq!(json["diagnostics"][0]["ts"], 1_700_000_000_000_i64);
    assert_eq!(json["diagnostics"][0]["level"], "error");
    assert_eq!(json["diagnostics"][0]["message"], "disk full");
    assert_eq!(json["lastError"]["kind"], "Io");
    assert_eq!(json["lastError"]["detail"], "store.append_event: disk full");
    assert_eq!(json["lastError"]["ts"], 1_700_000_000_001_i64);
    // PE-08 增量
    assert_eq!(json["restore"]["state"], "done");
    assert_eq!(json["restore"]["mode"], "full-replay");
    assert_eq!(json["restore"]["interruptedCount"], 2);
    assert_eq!(json["restore"]["lastSequence"], 41);
    assert_eq!(json["snapshot"]["generation"], 1);
    assert_eq!(json["snapshot"]["writtenAt"], 1_700_000_000_002_i64);
    // T-AB-19 增量（后台任务汇总）
    assert_eq!(json["backgroundTasks"]["activeCount"], 3);
    assert_eq!(json["backgroundTasks"]["daemonCount"], 1);
    assert_eq!(json["backgroundTasks"]["lastFinished"]["taskId"], "task-9");
    assert_eq!(
        json["backgroundTasks"]["lastFinished"]["status"],
        "completed"
    );
    assert_eq!(
        json["backgroundTasks"]["lastFinished"]["finishedAtMs"],
        1_700_000_000_003_i64
    );
    // P-7 增量（activeRuns / pendingApprovals；M6 §4.1.1 形状）
    assert_eq!(json["activeRuns"][0]["runId"], "r-1");
    assert_eq!(json["activeRuns"][0]["sessionId"], "s-1");
    assert_eq!(json["activeRuns"][0]["status"], "running");
    assert_eq!(json["activeRuns"][0]["startedAt"], 1_700_000_000_004_i64);
    assert_eq!(json["activeRuns"][0]["prompt"], "", "prompt 兜底恒空串");
    assert_eq!(json["pendingApprovals"][0]["toolCallId"], "tc-9");
    assert_eq!(json["pendingApprovals"][0]["toolName"], "shell:write");
    assert_eq!(json["pendingApprovals"][0]["runId"], "r-1");
    assert_eq!(
        json["pendingApprovals"][0]["summary"],
        "npm test 需要执行权限"
    );
    // T5-1b 增量（崩溃台账）
    assert_eq!(
        json["lastCrash"]["fileName"],
        "crash-20260816-120000-main.log"
    );
    assert_eq!(json["lastCrash"]["timestampMs"], 1_700_000_000_005_i64);
    // 不得出现 snake_case 键
    for key in [
        "search_index_ready",
        "db_ready",
        "compaction_ready",
        "provider_status",
        "log_level",
        "log_dir",
        "last_error",
        "background_tasks",
        "active_count",
        "daemon_count",
        "last_finished",
        "active_runs",
        "pending_approvals",
        "last_crash",
    ] {
        assert!(json.get(key).is_none(), "不得出现 snake_case 键 {key}");
    }
}

#[test]
fn build_status_defaults_are_honest() {
    let status = build_status(
        false,
        "0.1.0".to_string(),
        false,
        false,
        false,
        false,
        ProviderStatus {
            has_api_key: None,
            model: None,
            base_url: None,
            credential_mode: None,
        },
        "info".to_string(),
        String::new(),
        Vec::new(),
        None,
        RestoreStatus {
            state: "pending",
            mode: String::new(),
            snapshot_note: None,
            interrupted_count: 0,
            last_sequence: None,
        },
        SnapshotStatus {
            generation: 0,
            written_at: None,
            last_error: None,
        },
        BackgroundTasksSummary::default(),
        Vec::new(),
        Vec::new(),
        None,
    );
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["initialized"], false);
    assert_eq!(json["providerStatus"]["hasApiKey"], serde_json::Value::Null);
    assert_eq!(json["diagnostics"], serde_json::json!([]));
    assert!(
        json.get("lastError").is_none(),
        "无错误记录时 lastError 缺省"
    );
    assert_eq!(json["restore"]["state"], "pending");
    assert!(json["restore"].get("lastSequence").is_none());
    assert_eq!(json["snapshot"]["generation"], 0);
    assert_eq!(json["backgroundTasks"]["activeCount"], 0, "未接线汇总 = 0");
    assert_eq!(json["backgroundTasks"]["daemonCount"], 0);
    assert!(
        json["backgroundTasks"].get("lastFinished").is_none(),
        "无终态任务时 lastFinished 缺省"
    );
    // P-7：空态 activeRuns / pendingApprovals 下发空数组（注册表可选
    // 字段——桌面端总是下发数组，空数组合法）
    assert_eq!(json["activeRuns"], serde_json::json!([]));
    assert_eq!(json["pendingApprovals"], serde_json::json!([]));
    // T5-1b：无崩溃标记时 lastCrash 缺省（诚实化，不下发 null）
    assert!(
        json.get("lastCrash").is_none(),
        "无崩溃标记时 lastCrash 缺省"
    );
}

/// T-AB-19：后台任务汇总 wire 形状（camelCase + lastFinished 缺省规则）
#[test]
fn background_tasks_summary_serializes_camel_case() {
    let summary = BackgroundTasksSummary {
        active_count: 2,
        daemon_count: 1,
        last_finished: Some(LastTaskTerminal {
            task_id: "task-3".to_string(),
            status: "killed".to_string(),
            finished_at_ms: 1_700_000_000_010,
        }),
    };
    let json = serde_json::to_value(&summary).unwrap();
    assert_eq!(json["activeCount"], 2);
    assert_eq!(json["daemonCount"], 1);
    assert_eq!(json["lastFinished"]["taskId"], "task-3");
    assert_eq!(json["lastFinished"]["status"], "killed");
    assert_eq!(json["lastFinished"]["finishedAtMs"], 1_700_000_000_010_i64);
    assert!(json.get("active_count").is_none(), "不得出现 snake_case 键");

    let empty = BackgroundTasksSummary::default();
    let json = serde_json::to_value(&empty).unwrap();
    assert_eq!(json["activeCount"], 0);
    assert!(json.get("lastFinished").is_none(), "缺省值跳过序列化");
}

#[test]
fn normalize_max_events_clamps() {
    assert_eq!(normalize_max_events(None), DEFAULT_PAGE_SIZE as usize);
    assert_eq!(normalize_max_events(Some(0)), 1);
    assert_eq!(normalize_max_events(Some(500)), 500);
    assert_eq!(normalize_max_events(Some(10_000)), MAX_PAGE_SIZE as usize);
}

#[test]
fn paginate_splits_pages() {
    let all: Vec<u64> = (1..=10).collect();
    let (page, has_more) = paginate(all.clone(), 4);
    assert_eq!(page, vec![1, 2, 3, 4]);
    assert!(has_more);
    let (page, has_more) = paginate(all.clone(), 10);
    assert_eq!(page, all);
    assert!(!has_more);
    let (page, has_more) = paginate::<u64>(vec![], 4);
    assert!(page.is_empty());
    assert!(!has_more);
}

#[test]
fn require_ids_validate() {
    assert!(require_session_id("s1").is_ok());
    assert!(require_session_id("  ").is_err());
    assert!(require_run_id("").is_err());
    let long = "x".repeat(ID_MAX_LEN + 1);
    match require_run_id(&long) {
        Err(CoreError::InvalidInput(detail)) => assert!(detail.contains("too long")),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

#[test]
fn parse_envelopes_skips_corrupt_payloads() {
    use orchestrator::persist::PersistedEvent;
    let events = vec![
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 1,
            event_type: "agent-start".to_string(),
            payload: r#"{"type":"agent-start","sessionId":"s1","sequence":1,"schemaVersion":1,"runId":"r1","timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
            run_id: None,
            created_at: "2026-01-01 00:00:00.001".to_string(),
        },
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 2,
            event_type: "agent-start".to_string(),
            payload: "not-json".to_string(),
            run_id: None,
            created_at: "2026-01-01 00:00:00.002".to_string(),
        },
    ];
    let (parsed, stats) = parse_envelopes(&events);
    assert_eq!(parsed.len(), 1, "损坏载荷跳过");
    assert_eq!(parsed[0].0, 1);
    assert_eq!(parsed[0].1["runId"], "r1");
    assert_eq!(parsed[0].1["sequence"], 1);
    assert_eq!(parsed[0].1["schemaVersion"], 1);
    assert_eq!(stats.corrupt_skipped, 1, "态 1 计数不静默");
    assert_eq!(stats.typed, 1);
    assert_eq!(stats.synthesized, 0);
}

/// DM-06 态 3：无 type 标签的合法 JSON（run-interrupted / recovery-*
/// 镜像 / legacy 行）→ D8 合成 fallback，wire 含
/// type/runId/sequence/schemaVersion/sessionId 五键 + 原始字段透传
/// （消灭 G-02/G-20 读侧静默丢弃）。
#[test]
fn parse_envelopes_fallback_synthesizes_body_only_rows() {
    use orchestrator::persist::PersistedEvent;
    let events = vec![
        // run-interrupted 直写镜像（restore_manager 形状：InterruptedRun
        // record，payload 自带 run_id/session_id 键但**无顶层 type 键**）
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 5,
            event_type: "run-interrupted".to_string(),
            payload: r#"{"run_id":"r-9","session_id":"s1","previous_status":"running","status":"failed","reason":"daemon-restarted","error":"connection reset","timestamp":"2026-08-14T00:00:00Z"}"#.to_string(),
            run_id: None,
            created_at: "2026-08-14 00:00:00.005".to_string(),
        },
        // recovery-escalated 直写镜像（recovery.rs 形状：
        // {subagentRunId, kind, retries, elapsedMs}，无顶层 type 键）
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 6,
            event_type: "recovery-escalated".to_string(),
            payload: r#"{"subagentRunId":"sr-1","kind":"ladder1","retries":2,"elapsedMs":1500}"#.to_string(),
            run_id: None,
            created_at: "2026-08-14 00:00:00.006".to_string(),
        },
    ];
    let (parsed, stats) = parse_envelopes(&events);
    assert_eq!(parsed.len(), 2, "镜像行全部透出，不丢弃");
    assert_eq!(stats.synthesized, 2, "态 3a 合成计数");
    assert_eq!(stats.typed, 0, "镜像非 typed，不进态 2");
    assert_eq!(stats.corrupt_skipped, 0);

    // run-interrupted：五键 + 原始字段透传（type 键 = 列 event_type 权威）
    let interrupted = &parsed[0].1;
    assert_eq!(interrupted["type"], "run-interrupted");
    assert_eq!(interrupted["runId"], "r-9", "run_id 键映射为 runId");
    assert_eq!(interrupted["sequence"], 5, "sequence 列权威回填");
    assert_eq!(interrupted["schemaVersion"], 1);
    assert_eq!(interrupted["sessionId"], "s1");
    assert_eq!(interrupted["status"], "failed", "原始字段透传");
    assert_eq!(interrupted["reason"], "daemon-restarted");
    assert_eq!(interrupted["run_id"], "r-9", "原始键保留（透传不删键）");

    // recovery-* 镜像：五键 + subagentRunId 映射为 runId（归属推断）
    let escalated = &parsed[1].1;
    assert_eq!(escalated["type"], "recovery-escalated");
    assert_eq!(escalated["runId"], "sr-1", "subagentRunId 映射为 runId");
    assert_eq!(escalated["sequence"], 6);
    assert_eq!(escalated["schemaVersion"], 1);
    assert_eq!(escalated["sessionId"], "s1");
    assert_eq!(escalated["kind"], "ladder1", "原始字段透传");
    assert_eq!(escalated["retries"], 2);
}

/// DM-06 态 2/态 3：sequence 列权威回填（G-05）——旧行 payload 无
/// sequence 键时，wire sequence == 行级列值（typed 与 fallback 双路径）。
#[test]
fn parse_envelopes_sequence_backfilled() {
    use orchestrator::persist::PersistedEvent;
    let events = vec![
        // 旧帧 typed 信封：无 sequence 键（缺省解析 None → 列回填）
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 11,
            event_type: "agent-start".to_string(),
            payload: r#"{"type":"agent-start","sessionId":"s1","runId":"r1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
            run_id: None,
            created_at: "2026-01-01 00:00:00.011".to_string(),
        },
        // fallback 镜像：无 sequence 键 → 列回填
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 12,
            event_type: "run-interrupted".to_string(),
            payload: r#"{"run_id":"r-9","status":"failed"}"#.to_string(),
            run_id: None,
            created_at: "2026-01-01 00:00:00.012".to_string(),
        },
    ];
    let (parsed, _stats) = parse_envelopes(&events);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].1["sequence"], 11, "typed 旧帧列权威回填");
    assert_eq!(parsed[1].1["sequence"], 12, "fallback 列权威回填");
}

/// DM-06 态 3b：合法 JSON 但非对象（数组/标量）→ rawPayload 包装显式
/// 透出（标注 skippable 形态），不静默丢弃，计数走 passthrough。
#[test]
fn parse_envelopes_passthrough_non_object_rows() {
    use orchestrator::persist::PersistedEvent;
    let events = vec![
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 21,
            event_type: "legacy-weird".to_string(),
            payload: r#"[1,2,3]"#.to_string(),
            run_id: None,
            created_at: "2026-01-01 00:00:00.021".to_string(),
        },
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 22,
            event_type: "legacy-weird".to_string(),
            payload: r#""plain string""#.to_string(),
            run_id: None,
            created_at: "2026-01-01 00:00:00.022".to_string(),
        },
    ];
    let (parsed, stats) = parse_envelopes(&events);
    assert_eq!(parsed.len(), 2, "非对象行也透出，不丢弃");
    assert_eq!(stats.passthrough, 2, "态 3b 计数");
    assert_eq!(stats.synthesized, 0);
    assert_eq!(parsed[0].1["type"], "legacy-weird");
    assert_eq!(parsed[0].1["sequence"], 21);
    assert_eq!(parsed[0].1["rawPayload"], serde_json::json!([1, 2, 3]));
    assert_eq!(parsed[1].1["rawPayload"], "plain string");
}

/// DM-07 P3 收口（态 2）：typed 信封 runId 取值 = payload 优先，缺失时
/// run_id 列兜底——列已就绪（DM-01/DM-03），与 SQL by_run 过滤口径一致；
/// 列不覆盖 payload 既有 runId（legacy 行诚实兼容，不回写）。
#[test]
fn parse_envelopes_column_backfills_typed_runid() {
    use orchestrator::persist::PersistedEvent;
    let events = vec![
        // 态 2a：payload 无 runId 键 + 列 Some → 列兜底填充 wire runId
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 31,
            event_type: "agent-start".to_string(),
            payload: r#"{"type":"agent-start","sessionId":"s1","schemaVersion":1,"timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
            run_id: Some("r-c1".to_string()),
            created_at: "2026-01-01 00:00:00.031".to_string(),
        },
        // 态 2b：payload 有 runId + 列不同 → payload 优先（不覆盖）
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 32,
            event_type: "agent-start".to_string(),
            payload: r#"{"type":"agent-start","sessionId":"s1","runId":"r-payload","schemaVersion":1,"timestamp":"2026-01-01T00:00:00Z"}"#.to_string(),
            run_id: Some("r-column".to_string()),
            created_at: "2026-01-01 00:00:00.032".to_string(),
        },
    ];
    let (parsed, stats) = parse_envelopes(&events);
    assert_eq!(parsed.len(), 2);
    assert_eq!(stats.typed, 2);
    assert_eq!(parsed[0].1["runId"], "r-c1", "payload 缺 runId → 列兜底");
    assert_eq!(
        parsed[1].1["runId"], "r-payload",
        "payload 有 runId → 列不覆盖"
    );
}

/// DM-07 P3 收口（态 3）：fallback 合成 runId 取值顺序 = payload runId
/// 键 → run_id 列 → 镜像键推断（列优先于镜像键）。
#[test]
fn parse_envelopes_fallback_column_priority() {
    use orchestrator::persist::PersistedEvent;
    let events = vec![
        // 3a：payload 无 runId 键、列 Some、payload 有 subagentRunId → 列优先
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 41,
            event_type: "recovery-escalated".to_string(),
            payload: r#"{"subagentRunId":"sr-1","kind":"ladder1","retries":2}"#.to_string(),
            run_id: Some("r-col".to_string()),
            created_at: "2026-01-01 00:00:00.041".to_string(),
        },
        // 3b：payload 有 runId 键 + 列不同 → payload 优先
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 42,
            event_type: "run-interrupted".to_string(),
            payload: r#"{"runId":"r-p","run_id":"r-mirror","status":"failed"}"#.to_string(),
            run_id: Some("r-col".to_string()),
            created_at: "2026-01-01 00:00:00.042".to_string(),
        },
        // 3c：payload 无 runId、列 None → 镜像键推断兜底（既有行为保持）
        PersistedEvent {
            session_id: "s1".to_string(),
            sequence: 43,
            event_type: "recovery-escalated".to_string(),
            payload: r#"{"subagentRunId":"sr-2","kind":"ladder2","retries":1}"#.to_string(),
            run_id: None,
            created_at: "2026-01-01 00:00:00.043".to_string(),
        },
    ];
    let (parsed, stats) = parse_envelopes(&events);
    assert_eq!(parsed.len(), 3);
    assert_eq!(stats.synthesized, 3);
    assert_eq!(parsed[0].1["runId"], "r-col", "列优先于镜像键推断");
    assert_eq!(parsed[1].1["runId"], "r-p", "payload runId 键优先于列");
    assert_eq!(parsed[2].1["runId"], "sr-2", "无列无 payload → 镜像键兜底");
}
