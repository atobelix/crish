//! `subagent` 批量派发域测试（SR-06a 拆分）：T-D-06 tasks 批量 / C6 流程关联字段。
//!
//! 全部既有测试原样迁移（零删除）；`use super::*` 经父模命名空间取共享替身与门面 re-export。

#![allow(clippy::disallowed_methods)]

use super::*;

use crate::context::{create_mock_tool_context, ToolContext};
use crate::definition::Tool;

// ── T-D-06：批量派发（tasks 数组）──────────────────────────────

#[tokio::test]
async fn tool_batch_rejects_tasks_and_prompt_together() {
    // 单发/批量互斥（防歧义）：tasks 与 prompt 同给 → 结构化拒绝，
    // 不得发起任何 spawn
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({
                "prompt": "单发任务",
                "tasks": [{ "prompt": "批量任务 A" }]
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("互斥"));
    assert!(spawner.requests().is_empty(), "互斥拒绝不得发起 spawn");
}

#[tokio::test]
async fn tool_batch_rejects_empty_or_non_array_tasks() {
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(&ctx, serde_json::json!({ "tasks": [] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("不得为空"));
    let err = tool
        .execute(&ctx, serde_json::json!({ "tasks": "not-an-array" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(spawner.requests().is_empty());
}

#[tokio::test]
async fn tool_batch_rejects_top_level_single_params() {
    // 批量模式下顶层单发参数不适用（条目内字段为准）：显式给出即
    // 结构化拒绝，防静默歧义（与 prompt+tasks 互斥同一语义）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    for (key, value) in [
        ("agentId", serde_json::json!("def-x")),
        ("role", serde_json::json!("researcher")),
        ("capabilityMode", serde_json::json!("read-only")),
    ] {
        let mut args = serde_json::json!({ "tasks": [{ "prompt": "任务" }] });
        args[key] = value;
        let err = tool.execute(&ctx, args).await.unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input", "{key} 必须被拒");
        assert!(err.to_string().contains("不适用"), "{key} 文案须说明不适用");
    }
    assert!(spawner.requests().is_empty());
}

#[tokio::test]
async fn tool_batch_rejects_unknown_enum_in_task_item() {
    // 条目级枚举拒绝（对齐单发 role/capabilityMode 拒绝面）：
    // 任一条目非法 → 整体拒绝，零 spawn
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({
                "tasks": [
                    { "prompt": "任务 A" },
                    { "prompt": "任务 B", "role": "wizard" }
                ]
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("未知角色"));
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({
                "tasks": [{ "prompt": "任务 A", "capabilityMode": "super" }]
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("未知能力模式"));
    // 条目缺 prompt / prompt 为空 → 拒绝
    let err = tool
        .execute(&ctx, serde_json::json!({ "tasks": [{ "role": "researcher" }] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(spawner.requests().is_empty(), "任一条目非法不得发起 spawn");
}

#[tokio::test]
async fn tool_batch_dispatches_three_tasks_in_order() {
    // 一次派发 3 个任务：经默认 spawn_many 循环单发逐条装配请求
    // （顺序保持），出站信封为 results 数组（每条 subagentId/status）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = ToolContext {
        session_id: "parent-sess".to_string(),
        ..create_mock_tool_context()
    };
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "tasks": [
                    { "prompt": "任务 A", "role": "researcher", "displayLabel": "调研员" },
                    { "prompt": "任务 B", "capabilityMode": "read-only", "description": "调研 B" },
                    { "prompt": "任务 C" }
                ]
            }),
        )
        .await
        .expect("批量派发应成功");
    let requests = spawner.requests();
    assert_eq!(requests.len(), 3, "3 个任务逐条 spawn");
    assert_eq!(requests[0].prompt, "任务 A");
    assert_eq!(requests[1].prompt, "任务 B");
    assert_eq!(requests[2].prompt, "任务 C");
    // 条目字段逐条装配
    assert_eq!(requests[0].role, Some(SubagentRole::Researcher));
    assert_eq!(requests[0].display_label.as_deref(), Some("调研员"));
    assert_eq!(requests[1].capability_mode, Some(SubagentCapabilityMode::ReadOnly));
    assert_eq!(requests[1].description.as_deref(), Some("调研 B"));
    assert_eq!(requests[2].role, None, "条目缺省字段 = None");
    // 父会话 = 工具执行会话；流程关联/扩展点恒 None
    for req in &requests {
        assert_eq!(req.parent_session_id, "parent-sess");
        assert_eq!(req.flow_node_id, None);
        assert!(!req.is_composite);
        assert_eq!(req.model_override, None, "批量路径 model_override 恒 None");
    }
    // 出站信封：results 数组，每条含 subagentId/subagentRunId/sessionId/status
    let results = out["results"].as_array().expect("results 必须是数组");
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["subagentId"], "sub-1");
    assert_eq!(results[0]["status"], "running");
    assert_eq!(results[0]["displayLabel"], "调研员");
    assert_eq!(results[2]["sessionId"], "sub-sess-1");
}

#[tokio::test]
async fn tool_batch_without_spawner_returns_structured_unavailable() {
    let tool = RunSubagentTool::new();
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(&ctx, serde_json::json!({ "tasks": [{ "prompt": "任务" }] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "common.unsupported");
    assert!(err.to_string().contains("未接线"));
}

#[tokio::test]
async fn spawn_many_default_impl_loops_single_spawn() {
    // 默认实现契约：循环单发（非原子兜底）——2 个请求逐条走 spawn，
    // 记录 2 次、返回 2 条结果；原子语义由覆写实现承担（DbSpawner）
    let spawner = RecordingSpawner::ok();
    let reqs = vec![
        request("任务 A", "sess-main", Some("run-main")),
        request("任务 B", "sess-main", Some("run-main")),
    ];
    let results = spawner
        .spawn_many(&reqs)
        .await
        .expect("默认实现逐条 spawn 应成功");
    assert_eq!(results.len(), 2);
    assert_eq!(spawner.requests().len(), 2);
    assert_eq!(spawner.requests()[0].prompt, "任务 A");
    assert_eq!(spawner.requests()[1].prompt, "任务 B");
}

// ── C6 调度器扩展：流程关联字段（flow_node_id / is_composite）────────

#[tokio::test]
async fn tool_direct_path_carries_no_flow_correlation() {
    // 工具直调路径：flow 字段恒为 None/false（流程关联只由调度器
    // 经 spawner 直接 spawn 时携带，C6 文件域约定）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    tool.execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .unwrap();
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].flow_node_id, None, "工具路径不携带流程节点");
    assert!(!requests[0].is_composite, "工具路径不标记综合节点");
}

#[tokio::test]
async fn flow_correlation_fields_echo_through_spawner() {
    // 调度器路径：spawn 请求携带 flow_node_id + is_composite，
    // spawner 结果回显 flow_node_id（引擎侧据此把 run 关联回依赖图）
    let spawner = RecordingSpawner::ok();
    let mut req = request("综合任务", "sess-main", Some("run-main"));
    req.flow_node_id = Some("node-gate".to_string());
    req.is_composite = true;
    let result = spawner.spawn(&req).await.expect("spawn 应成功");
    assert_eq!(
        result.flow_node_id.as_deref(),
        Some("node-gate"),
        "结果必须回显流程节点 id"
    );
    assert_eq!(
        spawner.requests()[0].flow_node_id.as_deref(),
        Some("node-gate"),
        "请求必须携带流程节点 id"
    );
    assert!(spawner.requests()[0].is_composite, "请求必须携带综合节点标记");
}

// ── LK-02 工具直调真键（parent_tool_call_id = ctx.tool_call_id）──────

#[tokio::test]
async fn tool_direct_path_propagates_tool_call_id() {
    // LK-02 S5 测钉：工具直调路径 parent_tool_call_id = ctx.tool_call_id
    // 真键（exec_single 注入；行 + 事件体链路自动透传）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = ToolContext {
        tool_call_id: Some("call-lk02-1".to_string()),
        ..create_mock_tool_context()
    };
    tool.execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .unwrap();
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].parent_tool_call_id.as_deref(),
        Some("call-lk02-1"),
        "工具直调必须携带 ctx.tool_call_id 真键"
    );
}

#[tokio::test]
async fn tool_batch_path_propagates_tool_call_id_to_each_request() {
    // LK-02 S5 测钉（批量路径）：tasks 逐条请求均携带 ctx.tool_call_id
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = ToolContext {
        tool_call_id: Some("call-lk02-batch".to_string()),
        ..create_mock_tool_context()
    };
    tool.execute(
        &ctx,
        serde_json::json!({
            "tasks": [{ "prompt": "任务 A" }, { "prompt": "任务 B" }]
        }),
    )
    .await
    .unwrap();
    let requests = spawner.requests();
    assert_eq!(requests.len(), 2);
    for req in &requests {
        assert_eq!(
            req.parent_tool_call_id.as_deref(),
            Some("call-lk02-batch"),
            "批量路径每条请求都必须携带真键"
        );
    }
}

#[tokio::test]
async fn tool_direct_path_without_tool_call_id_keeps_none() {
    // LK-02 诚实边界：非工具上下文（ctx.tool_call_id = None）→ 请求
    // parent_tool_call_id = None（不编造 id）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    tool.execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .unwrap();
    assert!(
        spawner.requests()[0].parent_tool_call_id.is_none(),
        "非工具上下文不得编造调用 id"
    );
}

