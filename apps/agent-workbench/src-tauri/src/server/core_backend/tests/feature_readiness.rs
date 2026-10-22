use std::sync::Arc;

use conex_types::device::commands::{
    SettingsConfirmAction, SettingsConfirmParams, SettingsConfirmStatus,
};
use conex_types::device::{
    CancelRunParams, DeviceErrorCode, PauseAutomationParams, PermissionMode, RunTaskParams,
    SearchFilesParams,
};

use crate::core_backend::CoreStateBackend;
use crate::server::backend::ApiBackend;

use super::{r2_test_core_state, search_backend};

/// C21：命中映射（relPath 剥离工作区根 + 统一 `/`；kind/size 缺省
/// None——搜索索引只存路径，注册表 optional 字段缺省合法）
#[tokio::test]
async fn r2_12_search_files_maps_hits_to_relative_paths() {
    let backend = search_backend(
        vec![
            "C:/proj/src/main.rs".to_string(),
            "C:/proj/README.md".to_string(),
        ],
        Some("C:/proj"),
    );
    let result = backend
        .search_files(SearchFilesParams {
            query: "main".to_string(),
            root: None,
            max_results: None,
        })
        .await
        .expect("搜索应成功");
    assert_eq!(result.results.len(), 1);
    assert_eq!(result.results[0].rel_path, "src/main.rs");
    assert_eq!(result.results[0].kind, None);
    assert_eq!(result.results[0].size, None);
}

/// C21：root 相对路径按组件边界过滤（root=src → 仅 src 子树命中；
/// 目录边界锚定——根目录的 main.rs 与 docs/ 下 main 均不误命中）
#[tokio::test]
async fn r2_12_search_files_filters_by_relative_root() {
    let backend = search_backend(
        vec![
            "C:/proj/src/main.rs".to_string(),
            "C:/proj/src/lib.rs".to_string(),
            "C:/proj/docs/main-guide.md".to_string(),
            "C:/proj/main.rs".to_string(),
        ],
        Some("C:/proj"),
    );
    let result = backend
        .search_files(SearchFilesParams {
            query: "main".to_string(),
            root: Some("src".to_string()),
            max_results: Some(10),
        })
        .await
        .expect("搜索应成功");
    let paths: Vec<&str> = result.results.iter().map(|h| h.rel_path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["src/main.rs"],
        "root=src 仅命中 src 子树：{paths:?}"
    );
}

/// C21：校验面（空 query / 超长 query / 绝对 root / 索引未接线）
#[tokio::test]
async fn r2_12_search_files_validation_errors() {
    let backend = search_backend(vec!["C:/proj/src/main.rs".to_string()], Some("C:/proj"));
    let cases = [
        (
            "query 为空",
            SearchFilesParams {
                query: "  ".to_string(),
                root: None,
                max_results: None,
            },
        ),
        (
            "query 超长（>256）",
            SearchFilesParams {
                query: "x".repeat(257),
                root: None,
                max_results: None,
            },
        ),
        (
            "root 绝对路径",
            SearchFilesParams {
                query: "main".to_string(),
                root: Some("C:/proj/src".to_string()),
                max_results: None,
            },
        ),
    ];
    for (label, params) in cases {
        let err = backend.search_files(params).await.expect_err("应拒绝");
        assert_eq!(err.device_code(), DeviceErrorCode::CmdInvalid, "{label}");
    }
    // 索引未接线 → cmd.engine_not_ready（诚实降级）
    let unwired = CoreStateBackend::new(r2_test_core_state());
    let err = unwired
        .search_files(SearchFilesParams {
            query: "main".to_string(),
            root: None,
            max_results: None,
        })
        .await
        .expect_err("未接线应拒绝");
    assert_eq!(err.device_code(), DeviceErrorCode::CmdEngineNotReady);
}

/// C21 装配语义（R2-12c → C21 收尾）：with_search_state 注入后，后端与
/// 命令面共享同一实例——空索引 → 空命中（而非 engine_not_ready）；
/// 索引经共享状态原子交换重建后，search_files / get_search_index
/// 立即可见（装配生产可用的关键性质；main.rs ⑪a 注入路径的等价验证）
#[tokio::test]
async fn r2_12_search_files_sees_live_index_through_shared_state() {
    let state = Arc::new(crate::core_commands::SharedSearchState {
        files: std::sync::RwLock::new(Arc::new(Vec::new())),
    });
    let backend = CoreStateBackend::new(r2_test_core_state()).with_search_state(Arc::clone(&state));

    // ① 装配后空索引：搜索成功返回空命中，不报 engine_not_ready；
    //    get_search_index 就绪事实与索引同源（空 → false）
    let empty = backend
        .search_files(SearchFilesParams {
            query: "main".to_string(),
            root: None,
            max_results: None,
        })
        .await
        .expect("装配后空索引不报错");
    assert!(
        empty.results.is_empty(),
        "空索引 → 空命中：{:?}",
        empty.results
    );
    assert!(
        !backend
            .get_search_index()
            .await
            .expect("search index 查询")
            .ready,
        "空索引 → ready=false（实时事实源）"
    );

    // ② 命令面重建（原子交换 Arc）→ 同一实例立即生效
    *state.files.write().unwrap() = Arc::new(vec![
        "C:/proj/src/main.rs".to_string(),
        "C:/proj/README.md".to_string(),
    ]);
    let hits = backend
        .search_files(SearchFilesParams {
            query: "main".to_string(),
            root: None,
            max_results: None,
        })
        .await
        .expect("重建后应命中");
    assert_eq!(hits.results.len(), 1, "重建后经共享实例立即可见");
    assert_eq!(
        hits.results[0].rel_path, "C:/proj/src/main.rs",
        "未注入根时 relPath 回退原路径"
    );
    assert!(
        backend
            .get_search_index()
            .await
            .expect("search index 查询")
            .ready,
        "重建后 ready=true（实时事实源）"
    );
}

/// C21：maxResults 钳制 [1, 100]（注册表桌面端钳制）
#[tokio::test]
async fn r2_12_search_files_clamps_max_results() {
    let files: Vec<String> = (0..150).map(|i| format!("C:/proj/f{i}.rs")).collect();
    let backend = search_backend(files, Some("C:/proj"));
    let result = backend
        .search_files(SearchFilesParams {
            query: "f".to_string(),
            root: None,
            max_results: Some(10_000),
        })
        .await
        .expect("搜索应成功");
    assert_eq!(result.results.len(), 100, "maxResults 超限钳制到 100");
    let result = backend
        .search_files(SearchFilesParams {
            query: "f".to_string(),
            root: None,
            max_results: Some(0),
        })
        .await
        .expect("搜索应成功");
    assert_eq!(result.results.len(), 1, "maxResults 钳制下限 1");
}

/// C30：设置确认回执（query → expired / withdraw → withdrawn；
/// 空 confirmRequestId → cmd.invalid）
#[tokio::test]
async fn r2_12_settings_confirm_receipts() {
    let backend = CoreStateBackend::new(r2_test_core_state());
    let withdrawn = backend
        .settings_confirm(SettingsConfirmParams {
            confirm_request_id: "req-1".to_string(),
            action: SettingsConfirmAction::Withdraw,
        })
        .await
        .expect("撤回应成功");
    assert_eq!(withdrawn.status, SettingsConfirmStatus::Withdrawn);
    assert!(withdrawn.reason.is_some(), "撤回回执应携带原因（回执语义）");
    let queried = backend
        .settings_confirm(SettingsConfirmParams {
            confirm_request_id: "req-1".to_string(),
            action: SettingsConfirmAction::Query,
        })
        .await
        .expect("查询应成功");
    assert_eq!(queried.status, SettingsConfirmStatus::Expired);
    assert!(queried.reason.is_some(), "查询回执应携带原因（回执语义）");
    let err = backend
        .settings_confirm(SettingsConfirmParams {
            confirm_request_id: "  ".to_string(),
            action: SettingsConfirmAction::Query,
        })
        .await
        .expect_err("空 id 应拒绝");
    assert_eq!(err.device_code(), DeviceErrorCode::CmdInvalid);
}

/// C31：暂停定时自动执行（真实 scheduler 装配链——缺省 3600、
/// 钳制 [60, 86400]、重复暂停刷新 pausedUntil）
#[tokio::test]
async fn r2_12_pause_automation_via_real_scheduler() {
    let state = r2_test_core_state();
    assert!(
        state.scheduler_registry().is_some(),
        "真实引擎路径调度器应已装配"
    );
    let backend = CoreStateBackend::new(Arc::clone(&state));
    let before = crate::server::now_ms();
    let result = backend
        .pause_automation(PauseAutomationParams { duration_sec: None })
        .await
        .expect("暂停应成功");
    assert!(result.ok);
    assert!(
        result.paused_until >= before + 3600 * 1000,
        "缺省 durationSec=3600"
    );
    let registry = state.scheduler_registry().expect("调度器");
    assert_eq!(registry.pause_deadline(), Some(result.paused_until));
    // 钳制：<60 → 60；>86400 → 86400（注册表契约，桌面端钳制）
    let min = backend
        .pause_automation(PauseAutomationParams {
            duration_sec: Some(5),
        })
        .await
        .expect("钳制下限");
    let expected_min = before + 60 * 1000;
    assert!(min.paused_until >= expected_min, "钳制下限 60s：{min:?}");
    assert!(
        min.paused_until <= expected_min + 5_000,
        "钳制下限 60s（含余量）：{min:?}"
    );
    let max = backend
        .pause_automation(PauseAutomationParams {
            duration_sec: Some(999_999),
        })
        .await
        .expect("钳制上限");
    let expected_max = before + 86400 * 1000;
    assert!(max.paused_until >= expected_max, "钳制上限 86400s：{max:?}");
    assert!(
        max.paused_until <= expected_max + 5_000,
        "钳制上限 86400s（含余量）：{max:?}"
    );
    // 重复暂停刷新 pausedUntil（R2-11 §11）
    let refreshed = backend
        .pause_automation(PauseAutomationParams {
            duration_sec: Some(120),
        })
        .await
        .expect("刷新");
    assert!(
        refreshed.paused_until < max.paused_until,
        "刷新应覆盖旧截止"
    );
    assert_eq!(registry.pause_deadline(), Some(refreshed.paused_until));
}

/// C22：资源 URL 占位（ApiBackend 缺省实现 = 501 cmd.unknown——
/// F4 §5.4 资源代理未实现，诚实降级不捏造 URL）
#[tokio::test]
async fn r2_12_asset_url_placeholder_not_implemented() {
    let backend = CoreStateBackend::new(r2_test_core_state());
    let err = backend
        .asset_url(conex_types::device::AssetUrlParams {
            path: "docs/x.png".to_string(),
            kind: conex_types::device::AssetKind::Image,
        })
        .await
        .expect_err("占位端点必须返回错误");
    assert_eq!(err.device_code(), DeviceErrorCode::CmdUnknown);
}

// ── P-7（R2-07 D-02 收尾）：/v1/status activeRuns / pendingApprovals ──

/// 端到端：真实 run（write_file 危险工具 + ask 权限模式）→ 审批门
/// pending 注册 + run 停 awaiting-approval → get_status 的
/// activeRuns / pendingApprovals 均非空且字段形状 = M6 §4.1.1
/// （activeRuns：runId/sessionId/status/startedAt + prompt 兜底空串；
/// pendingApprovals：toolCallId/toolName/runId/summary）
#[tokio::test]
async fn p7_status_includes_active_runs_and_pending_approvals_end_to_end() {
    use agent_provider::config::Endpoint;
    use session_loop::provider::ProviderCall;
    use session_loop::stream::{ProviderStreamEvent, StopReason};
    use session_loop::testing::TestProvider;

    let state = r2_test_core_state();
    // TestProvider：文本 + 危险工具 write_file 调用（ask 模式 →
    // NeedsApproval → 审批门 request_approval；测试不裁决 → run 停在
    // awaiting-approval 保持活动——activeRuns/pendingApprovals 双非空）
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("写入文件。"),
        ProviderStreamEvent::tool_call(
            Some("call-p7".to_string()),
            "write_file",
            serde_json::json!({ "path": "x.md", "content": "p7" }),
        ),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let routed: Arc<dyn ProviderCall> = provider;
    let config = crate::engine::EngineProviderConfig {
        base_url: "http://test.local/v1".to_string(),
        api_key: "test-key".to_string(),
        model: "deepseek-v4-flash".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: std::collections::BTreeMap::new(),
        ..Default::default()
    };
    state.engine().inject_provider_for_test(routed, config);
    state.run_restore().await;
    state
        .local_db()
        .expect("local_db")
        .insert_session("s1", "s1")
        .expect("创建测试会话");

    let backend = CoreStateBackend::new(Arc::clone(&state));
    let result = backend
        .run_task(RunTaskParams {
            session_id: Some("s1".to_string()),
            prompt: "写入文件".to_string(),
            prompt_ref: None,
            mode: None,
            cwd: None,
            permission_mode: Some(PermissionMode::Ask),
            history: None,
            client_message_id: None,
        })
        .await
        .expect("run 应发起（ask 权限模式）");

    // 轮询 get_status 直到 pendingApprovals 非空（工具调用 → 审批门
    // pending 注册；run 未裁决保持活动，activeRuns 同时非空）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let status = loop {
        let value = backend.get_status().await.expect("get_status");
        let pending = value["pendingApprovals"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(0);
        let active = value["activeRuns"].as_array().map(Vec::len).unwrap_or(0);
        if pending > 0 && active > 0 {
            break value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "审批未在窗口内进入 pending：{value}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    // activeRuns 形状（M6 §4.1.1；wire 排序 = run_id 字典序）
    assert_eq!(status["activeRuns"][0]["runId"], result.run_id);
    assert_eq!(status["activeRuns"][0]["sessionId"], "s1");
    let run_status = status["activeRuns"][0]["status"]
        .as_str()
        .expect("status 应为字符串");
    assert!(
        ["queued", "initializing", "running", "awaiting-approval"].contains(&run_status),
        "活动 run 状态应在非终态集合内：{run_status}"
    );
    assert!(
        status["activeRuns"][0]["startedAt"].as_i64().is_some(),
        "startedAt 应为 epoch ms"
    );
    assert_eq!(
        status["activeRuns"][0]["prompt"], "",
        "prompt 兜底恒空串（runs 表无 prompt 持久化）"
    );
    // pendingApprovals 形状（M6 §4.1.1；wire 排序 = tool_call_id 字典序）
    assert_eq!(status["pendingApprovals"][0]["toolCallId"], "call-p7");
    assert_eq!(status["pendingApprovals"][0]["toolName"], "write_file");
    assert_eq!(status["pendingApprovals"][0]["runId"], result.run_id);
    assert_eq!(
        status["pendingApprovals"][0]["summary"], "call write_file",
        "审批门摘要（format!(\"call {{tool_name}}\")）透传"
    );
    // 收尾：取消 run（L3）释放审批等待（APPROVAL_TIMEOUT 120s
    // 超时不阻塞测试收尾；终态后 active_runs 移出注册表）
    let cancelled = backend
        .cancel_run(CancelRunParams {
            run_id: result.run_id.clone(),
            reason: Some("p7 测试收尾".to_string()),
        })
        .await;
    assert!(cancelled.is_ok(), "取消 run 收尾：{cancelled:?}");
}
