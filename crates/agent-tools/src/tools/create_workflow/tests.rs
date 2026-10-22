//! create_workflow 单元测试（自 create_workflow.rs `mod tests` 整体搬迁，用例与断言逐字保留）

use super::*;
use crate::context::create_mock_tool_context;
use crate::definition::Tool;
use async_trait::async_trait;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// ── 测试替身 ──────────────────────────────────────────────────

/// 记录式工作流创建通道：记录 create 调用，按预设结果应答
#[derive(Debug)]
struct RecordingWorkflowChannel {
    calls: Mutex<Vec<WorkflowCreateInput>>,
    outcome: Result<WorkflowCreateOutput, WorkflowCreateError>,
}

impl RecordingWorkflowChannel {
    fn new(outcome: Result<WorkflowCreateOutput, WorkflowCreateError>) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            outcome,
        }
    }

    fn calls(&self) -> Vec<WorkflowCreateInput> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl WorkflowCreationChannel for RecordingWorkflowChannel {
    async fn create(
        &self,
        input: WorkflowCreateInput,
    ) -> Result<WorkflowCreateOutput, WorkflowCreateError> {
        self.calls.lock().unwrap().push(input);
        self.outcome.clone()
    }
}

/// 基于 LocalDb session_meta 的测试工作流创建通道：
/// 验证单轨索引键 `sched_index` 与 `sched:{id}` / `sched_{id}` / `workflow:{id}` 落盘元数据契约
struct DbBackedWorkflowChannel {
    db: conex_db::LocalDb,
    seq: Mutex<u64>,
}

impl std::fmt::Debug for DbBackedWorkflowChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DbBackedWorkflowChannel")
    }
}

impl DbBackedWorkflowChannel {
    fn new(db: conex_db::LocalDb) -> Self {
        Self {
            db,
            seq: Mutex::new(0),
        }
    }
}

#[async_trait]
impl WorkflowCreationChannel for DbBackedWorkflowChannel {
    async fn create(
        &self,
        input: WorkflowCreateInput,
    ) -> Result<WorkflowCreateOutput, WorkflowCreateError> {
        let id_num = {
            let mut g = self.seq.lock().unwrap();
            let current = *g;
            *g += 1;
            current
        };
        let workflow_id = format!("cron-{id_num}");
        let meta_json = input.to_persisted_meta_json(&workflow_id);
        let serialized = serde_json::to_string(&meta_json).unwrap();

        // 落盘 sched_{id}、sched:{id}、workflow:{id} 元数据
        self.db
            .set_session_meta(&format!("sched_{workflow_id}"), &serialized)
            .unwrap();
        self.db
            .set_session_meta(&format!("sched:{workflow_id}"), &serialized)
            .unwrap();
        self.db
            .set_session_meta(&format!("workflow:{workflow_id}"), &serialized)
            .unwrap();

        // 单轨索引写入 SESSION_META_INDEX_KEY ("sched_index")
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        if !index.contains(&workflow_id) {
            index.push(workflow_id.clone());
            self.db
                .set_session_meta(
                    SESSION_META_INDEX_KEY,
                    &serde_json::to_string(&index).unwrap(),
                )
                .unwrap();
        }

        let next_run_at = input
            .resolved_cron_expression()
            .map(|_| "2026-10-13T01:00:00.000Z".to_string());
        Ok(WorkflowCreateOutput {
            workflow_id,
            name: input.name,
            next_run_at,
        })
    }
}

/// 成功应答（参数回显）
fn ok_output() -> WorkflowCreateOutput {
    WorkflowCreateOutput {
        workflow_id: "cron-0".to_string(),
        name: "每日巡检".to_string(),
        next_run_at: Some("2026-09-03T01:00:00.000Z".to_string()),
    }
}

// ── 工具行为 ──────────────────────────────────────────────────

#[tokio::test]
async fn create_workflow_forwards_daily_input() {
    let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "name": "每日巡检",
                "prompt": "检查仓库状态并简短回复",
                "scheduleType": "daily",
                "dailyTime": "09:00",
                "cwd": "C:/work/conex",
            }),
        )
        .await
        .unwrap();
    let calls = channel.calls();
    assert_eq!(calls.len(), 1);
    let input = &calls[0];
    assert_eq!(input.name, "每日巡检");
    assert_eq!(input.prompt, "检查仓库状态并简短回复");
    assert_eq!(input.schedule_type, "daily");
    assert_eq!(input.daily_time.as_deref(), Some("09:00"));
    assert_eq!(input.interval_minutes, None);
    assert_eq!(input.cron_expression, None);
    assert_eq!(input.cwd.as_deref(), Some("C:/work/conex"));
    assert_eq!(
        input.enabled, None,
        "enabled 缺省透传 None（引擎按 true 兜底）"
    );
    // 输出信封：workflowId / name / nextRunAt / text 摘要
    assert_eq!(out["workflowId"], "cron-0");
    assert_eq!(out["name"], "每日巡检");
    assert_eq!(out["nextRunAt"], "2026-09-03T01:00:00.000Z");
    assert_eq!(out["cronExpression"], "0 9 * * *");
    assert!(out["text"].as_str().unwrap().contains("每日巡检"));
    assert!(out["text"].as_str().unwrap().contains("下次执行"));
}

#[tokio::test]
async fn create_workflow_auto_binds_current_session_id() {
    let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    let mut ctx = create_mock_tool_context();
    ctx.session_id = "sess-chat-123".to_string();
    ctx.workspace_root = PathBuf::from("C:/Projects/conex");

    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "name": "自动绑定巡检",
                "prompt": "每日检查分支状态",
                "scheduleType": "daily",
                "dailyTime": "09:00"
            }),
        )
        .await
        .unwrap();

    let calls = channel.calls();
    assert_eq!(calls.len(), 1);
    let input = &calls[0];
    assert_eq!(input.target_session_id.as_deref(), Some("sess-chat-123"));
    assert_eq!(input.execution_mode.as_deref(), Some("current_session"));
    assert_eq!(input.target_mode.as_deref(), Some("current"));
    assert_eq!(
        input.cwd.as_deref(),
        Some("C:/Projects/conex"),
        "未传 cwd 时应自动继承 ctx.workspace_root"
    );

    assert_eq!(out["targetSessionId"], "sess-chat-123");
    assert_eq!(out["target_session_id"], "sess-chat-123");
    assert_eq!(out["executionMode"], "current_session");
    assert_eq!(out["execution_mode"], "current_session");
    assert_eq!(out["targetMode"], "current");
    let text = out["text"].as_str().unwrap();
    assert!(text.contains("已绑定当前对话（会话 ID: sess-chat-123）"));
    assert!(text.contains("Cron 表达式: 0 9 * * *"));
}

#[tokio::test]
async fn create_workflow_explicit_isolated_execution_mode_clears_target_session() {
    let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    let mut ctx = create_mock_tool_context();
    ctx.session_id = "sess-chat-123".to_string();

    // 1. 显式传入 execution_mode = "isolated"
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "name": "后台巡检",
                "prompt": "静默执行检查",
                "scheduleType": "cron",
                "cronExpression": "*/15 * * * *",
                "execution_mode": "isolated"
            }),
        )
        .await
        .unwrap();

    let calls = channel.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].target_session_id, None);
    assert_eq!(calls[0].execution_mode.as_deref(), Some("isolated"));
    assert_eq!(calls[0].target_mode.as_deref(), Some("isolated"));
    assert!(out["targetSessionId"].is_null());
    assert!(out["target_session_id"].is_null());
    assert_eq!(out["execution_mode"], "isolated");
    assert_eq!(out["targetMode"], "isolated");
    assert!(out["text"]
        .as_str()
        .unwrap()
        .contains("独立专用后台会话（isolated）"));

    // 2. 显式传入 targetSessionId = "isolated" / "independent"
    let channel2 = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool2 = CreateWorkflowTool::with_channel(Some(channel2.clone()));
    tool2
        .execute(
            &ctx,
            serde_json::json!({
                "name": "后台巡检2",
                "prompt": "静默执行检查",
                "targetSessionId": "independent"
            }),
        )
        .await
        .unwrap();
    assert_eq!(channel2.calls()[0].target_session_id, None);
    assert_eq!(
        channel2.calls()[0].execution_mode.as_deref(),
        Some("isolated")
    );
}

#[tokio::test]
async fn create_workflow_persists_sched_index_and_single_track_meta() {
    let db = conex_db::LocalDb::open_in_memory().expect("打开内存库应成功");
    let channel = Arc::new(DbBackedWorkflowChannel::new(db.clone()));
    let tool = CreateWorkflowTool::with_channel(Some(channel));

    let mut ctx = create_mock_tool_context();
    ctx.session_id = "sess-chat-123".to_string();

    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "name": "索引与落盘验证",
                "prompt": "执行代码健康检查",
                "scheduleType": "cron",
                "cronExpression": "0 9 * * 1-5"
            }),
        )
        .await
        .unwrap();

    let wf_id = out["workflowId"].as_str().unwrap();
    assert_eq!(wf_id, "cron-0");

    // 验证单轨索引键 "sched_index" 写入正确，且未使用旧 "sched_ids"
    assert!(
        db.get_session_meta("sched_ids").unwrap().is_none(),
        "严禁写入旧索引键 sched_ids"
    );
    let index_raw = db
        .get_session_meta(SESSION_META_INDEX_KEY)
        .unwrap()
        .expect("sched_index 必须存在");
    let index: Vec<String> = serde_json::from_str(&index_raw).unwrap();
    assert_eq!(index, vec!["cron-0".to_string()]);

    // 验证 sched:{id}、sched_{id}、workflow:{id} 落盘 JSON 可正常读取且包含双命名对齐字段
    for key in [
        format!("sched_{wf_id}"),
        format!("sched:{wf_id}"),
        format!("workflow:{wf_id}"),
    ] {
        let raw = db
            .get_session_meta(&key)
            .unwrap()
            .unwrap_or_else(|| panic!("{key} 应已落盘"));
        let meta: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(meta["target_session_id"], "sess-chat-123");
        assert_eq!(meta["targetSessionId"], "sess-chat-123");
        assert_eq!(meta["execution_mode"], "current_session");
        assert_eq!(meta["executionMode"], "current_session");
        assert_eq!(meta["target_mode"], "current");
        assert_eq!(meta["targetMode"], "current");
        assert_eq!(meta["expression"], "0 9 * * 1-5");
    }
}

#[tokio::test]
async fn create_workflow_schedule_type_defaults_manual() {
    let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    // scheduleType 缺省 → manual
    tool.execute(
        &ctx,
        serde_json::json!({ "name": "手动任务", "prompt": "p" }),
    )
    .await
    .unwrap();
    assert_eq!(channel.calls()[0].schedule_type, "manual");
    // 显式 intervalMinutes / cron 字段透传
    let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    tool.execute(
        &ctx,
        serde_json::json!({
            "name": "轮询",
            "prompt": "p",
            "scheduleType": "intervalMinutes",
            "intervalMinutes": 30,
            "enabled": false,
        }),
    )
    .await
    .unwrap();
    let input = &channel.calls()[0];
    assert_eq!(input.schedule_type, "intervalMinutes");
    assert_eq!(input.interval_minutes, Some(30));
    assert_eq!(input.enabled, Some(false));
    let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    tool.execute(
        &ctx,
        serde_json::json!({
            "name": "cron 任务",
            "prompt": "p",
            "scheduleType": "cron",
            "cronExpression": "0 9 * * *",
        }),
    )
    .await
    .unwrap();
    let input = &channel.calls()[0];
    assert_eq!(input.schedule_type, "cron");
    assert_eq!(input.cron_expression.as_deref(), Some("0 9 * * *"));
}

#[tokio::test]
async fn create_workflow_channel_none_unsupported() {
    let tool = CreateWorkflowTool::new();
    let ctx = create_mock_tool_context();
    // 未接线环境返回 common.unsupported（不 panic）
    let err = tool
        .execute(&ctx, serde_json::json!({ "name": "巡检", "prompt": "p" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "common.unsupported");
}

#[tokio::test]
async fn create_workflow_missing_name_prompt_rejected() {
    let channel = Arc::new(RecordingWorkflowChannel::new(Ok(ok_output())));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    // 缺 name → tool.invalid_input，不发起 create
    let err = tool
        .execute(&ctx, serde_json::json!({ "prompt": "p" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    // 空 name → tool.invalid_input
    let err = tool
        .execute(&ctx, serde_json::json!({ "name": "  ", "prompt": "p" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    // 缺 prompt → tool.invalid_input
    let err = tool
        .execute(&ctx, serde_json::json!({ "name": "巡检" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(channel.calls().is_empty(), "非法入参不得发起 create");
}

#[tokio::test]
async fn create_workflow_channel_error_mapped_structurally() {
    // 引擎侧语义校验错误（非法 cron）结构化透传，不 panic
    let channel = Arc::new(RecordingWorkflowChannel::new(Err(
        WorkflowCreateError::InvalidInput("cron 表达式非法".to_string()),
    )));
    let tool = CreateWorkflowTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({
                "name": "巡检",
                "prompt": "p",
                "scheduleType": "cron",
                "cronExpression": "0 0 0 * * *",
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("非法"));
}

#[tokio::test]
async fn workflow_error_code_mapping() {
    // 错误码映射回归（对齐 TimerError 风格）
    assert_eq!(
        WorkflowCreateError::InvalidInput("x".to_string()).code(),
        codes::TOOL_INVALID_INPUT
    );
    assert_eq!(
        WorkflowCreateError::Unsupported.code(),
        codes::COMMON_UNSUPPORTED
    );
    assert!(WorkflowCreateError::Unsupported
        .message()
        .contains("未接线"));
    assert!(WorkflowCreateError::InvalidInput("坏 cron".to_string())
        .message()
        .contains("坏 cron"));
}
