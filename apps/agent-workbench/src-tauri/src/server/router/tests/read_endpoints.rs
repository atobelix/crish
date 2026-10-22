//! router 测试：只读查询面 C01-C10 端点

use super::*;

#[tokio::test]
async fn status_endpoint_returns_m6_subset() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app.oneshot(authed_get("/v1/status", &token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["initialized"], true);
    assert_eq!(body["engineReady"], true);
    assert_eq!(body["providerStatus"]["model"], "deepseek-v4");
    assert_eq!(body["restore"]["state"], "done");
    assert_eq!(body["activeRuns"][0]["runId"], "r-1");
    assert_eq!(body["pendingApprovals"][0]["toolCallId"], "tc-9");
}

#[tokio::test]
async fn query_params_are_percent_decoded() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    // %2D = '-'（编码后的查询值仍应正确解码 → 200 而非 400）
    let response = app
        .clone()
        .oneshot(authed_get("/v1/runs/r-1/snapshot?sessionId=s%2D1", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // 非法百分号编码 → cmd.invalid 400
    let response = app
        .oneshot(authed_get("/v1/runs/r-1/snapshot?sessionId=s%ZZ1", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.invalid");
}

// ── R1-03 只读面：C02 run 快照 ──

#[tokio::test]
async fn run_snapshot_endpoint_returns_snapshot() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/runs/r-1/snapshot?sessionId=s-1", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["snapshot"]["runId"], "r-1");
    assert_eq!(body["snapshot"]["status"], "running");
    assert_eq!(body["snapshot"]["cursor"], 127);
    assert_eq!(body["snapshot"]["usage"]["sampleCount"], 3);
}

#[tokio::test]
async fn run_snapshot_unknown_run_is_404() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/runs/r-missing/snapshot", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

// ── R1-03 只读面：C03 会话事件分页（游标契约核心）──

#[tokio::test]
async fn session_events_cursor_pagination_forward() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    // afterSequence=2 开区间 + maxEvents=2 → 取 [3,4]，hasMore
    let response = app
        .oneshot(authed_get(
            "/v1/sessions/s-1/events?afterSequence=2&maxEvents=2",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["events"].as_array().unwrap().len(), 2);
    assert_eq!(body["events"][0]["sequence"], 3);
    assert_eq!(body["events"][1]["sequence"], 4);
    assert_eq!(body["nextAfterSequence"], 4);
    assert_eq!(body["hasMore"], true);
    assert_eq!(body["latestSequence"], 5);
}

#[tokio::test]
async fn session_events_next_page_terminates() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get(
            "/v1/sessions/s-1/events?afterSequence=4&maxEvents=10",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["events"].as_array().unwrap().len(), 1);
    assert_eq!(body["events"][0]["sequence"], 5);
    assert_eq!(body["nextAfterSequence"], 5);
    assert_eq!(body["hasMore"], false);
}

#[tokio::test]
async fn session_events_default_page_size_200() {
    let state = test_state_with(Some(MockBackend::with_events(250)));
    let token = issue_token(&state);
    let app = build_router(state);
    // 缺省 maxEvents = 200（对齐 EventPage 契约）
    let response = app
        .oneshot(authed_get("/v1/sessions/s-1/events", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["events"].as_array().unwrap().len(), 200);
    assert_eq!(body["hasMore"], true);
}

#[tokio::test]
async fn session_events_max_events_clamped_to_1000() {
    let state = test_state_with(Some(MockBackend::with_events(1500)));
    let token = issue_token(&state);
    let app = build_router(state);
    // maxEvents=10000 夹紧到 1000（对齐 normalize_max_events，不报错）
    let response = app
        .oneshot(authed_get(
            "/v1/sessions/s-1/events?maxEvents=10000",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["events"].as_array().unwrap().len(), 1000);
    assert_eq!(body["hasMore"], true);
}

#[tokio::test]
async fn session_events_empty_page_keeps_cursor() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    // 游标越过尾部 → 空页，nextAfterSequence 保持入参（对齐 EventPage）
    let response = app
        .oneshot(authed_get(
            "/v1/sessions/s-1/events?afterSequence=99",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["events"].as_array().unwrap().len(), 0);
    assert_eq!(body["nextAfterSequence"], 99);
    assert_eq!(body["hasMore"], false);
}

#[tokio::test]
async fn session_events_unknown_session_is_404() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/sessions/s-missing/events", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

#[tokio::test]
async fn session_events_invalid_params_are_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    for (uri, label) in [
        (
            "/v1/sessions/s-1/events?afterSequence=abc",
            "afterSequence 非数字",
        ),
        (
            "/v1/sessions/s-1/events?afterSequence=-5",
            "afterSequence 负值",
        ),
        ("/v1/sessions/s-1/events?maxEvents=-5", "maxEvents 负值"),
        (
            "/v1/sessions/s-1/events?direction=sideways",
            "direction 非法",
        ),
    ] {
        let response = app.clone().oneshot(authed_get(uri, &token)).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{label} 必须 400"
        );
        let body = json_body(response).await;
        assert_eq!(
            body["code"], "cmd.invalid",
            "{label} 错误码应为 cmd.invalid"
        );
    }
}

// ── R1-03 只读面：C04 run 事件分页 ──

#[tokio::test]
async fn run_events_endpoint_paginates_by_cursor() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .clone()
        .oneshot(authed_get(
            "/v1/runs/r-1/events?afterSequence=0&maxEvents=3",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["events"].as_array().unwrap().len(), 3);
    assert_eq!(body["nextAfterSequence"], 3);
    assert_eq!(body["hasMore"], true);
    // 未知 run → 404（对齐 core_read_run_events NotFound 语义）
    let response = app
        .oneshot(authed_get("/v1/runs/r-missing/events", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

// ── R1-03 只读面：C05 会话列表 ──

#[tokio::test]
async fn list_sessions_endpoint_returns_index() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/sessions?includeLastMessage=true", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["sessions"][0]["id"], "s-1");
    assert_eq!(body["sessions"][0]["title"], "修复登录页 bug");
    assert_eq!(body["sessions"][0]["messageCount"], 42);
    assert_eq!(body["sessions"][0]["engineCursor"], 128);
}

// ── R1-03 只读面：C06 后台任务列表 ──

#[tokio::test]
async fn list_tasks_endpoint_returns_summary() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app.oneshot(authed_get("/v1/tasks", &token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(body["tasks"][0]["taskId"], "t-1");
    assert_eq!(body["tasks"][0]["status"], "running");
    assert_eq!(body["tasks"][1]["status"], "completed");
    assert!(
        body["tasks"][0].get("output").is_none(),
        "列表不携带输出内容"
    );
}

// ── R1-03 只读面：C07 任务输出补取 ──

#[tokio::test]
async fn task_output_endpoint_paginates_lines() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    // afterLine 偏移分页
    let response = app
        .clone()
        .oneshot(authed_get(
            "/v1/tasks/t-1/output?maxLines=10&afterLine=5",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["lines"].as_array().unwrap().len(), 10);
    assert_eq!(body["lines"][0], "line 5");
    assert_eq!(body["lines"][9], "line 14");
    assert_eq!(body["lineCount"], 100);
    assert_eq!(body["nextAfterLine"], 15);
    assert_eq!(body["hasMore"], true);
    assert_eq!(body["truncated"], true);
    // 缺省整页（maxLines 缺省 200 > 100 行 → 全部 + 无更多）
    let response = app
        .oneshot(authed_get("/v1/tasks/t-1/output", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["lines"].as_array().unwrap().len(), 100);
    assert_eq!(body["hasMore"], false);
}

#[tokio::test]
async fn task_output_unknown_task_is_404() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/tasks/t-missing/output", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

// ── R1-03 只读面：C08 流程快照 ──

#[tokio::test]
async fn flow_snapshot_endpoint_returns_dag_summary() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .clone()
        .oneshot(authed_get("/v1/sessions/s-1/flow", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["flow"]["agents"][0]["agentId"], "sub-3");
    assert_eq!(body["flow"]["agents"][0]["status"], "running");
    // 未知会话 → 404
    let response = app
        .oneshot(authed_get("/v1/sessions/s-missing/flow", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

// ── R1-03 只读面：C09 命令清单 ──

#[tokio::test]
async fn list_commands_endpoint_returns_manifest() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/commands", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["contractVersion"], "1.0.0");
    assert_eq!(body["commands"][0]["name"], "core_get_status");
    assert_eq!(body["commands"][0]["surface"], "engine");
    assert_eq!(body["commands"][0]["registered"], true);
}

// ── R1-03 只读面：C10 搜索索引状态 ──

#[tokio::test]
async fn search_index_endpoint_returns_ready_state() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/search/index", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["ready"], true);
    assert_eq!(body["state"]["totalFiles"], 1200);
}

// ── R1-03 只读面：错误映射 ──

#[tokio::test]
async fn backend_not_wired_returns_500_internal() {
    let state = test_state();
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app.oneshot(authed_get("/v1/status", &token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = json_body(response).await;
    assert_eq!(body["code"], "internal");
}

#[tokio::test]
async fn failing_backend_maps_http_status_by_code_domain() {
    let state = test_state_with(Some(MockBackend::failing(DeviceErrorCode::Internal)));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .clone()
        .oneshot(authed_get("/v1/sessions", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = json_body(response).await;
    assert_eq!(body["code"], "internal");

    // engine 未就绪 → 409（D2 §8.1.2 映射）
    let state = test_state_with(Some(MockBackend::failing(
        DeviceErrorCode::CmdEngineNotReady,
    )));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app.oneshot(authed_get("/v1/status", &token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.engine_not_ready");
}

// ── R1-04 写面：鉴权 ──
