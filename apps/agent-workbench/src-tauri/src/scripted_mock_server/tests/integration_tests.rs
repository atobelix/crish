//! 接入用例：真实 HttpProviderCall + 完整 run 装配走 mock wire。

#![allow(clippy::await_holding_lock)] // 单元测试持 LIVE_CATALOG_TEST_LOCK 跨网络 await

use super::super::*;

use agent_provider::config::Endpoint;
use conex_db::LocalDb;
use conex_run::core_event_bridge::EventBridge;
use conex_run::engine_provider::{EngineProviderConfig, HttpProviderCall};
use conex_run::run::{run_task_impl, BackoffDelayFn, CoreRunState, RunTaskOptions};
use conex_run::status_diagnostics::StatusDiagnostics;
use conex_types::message::AgentMessage;
use conex_types::SessionIndexEntry;
use orchestrator::persist::LocalDbStore;
use orchestrator::restore::{SnapshotFileStore, SnapshotStore};
use serde_json::json;
use std::future::Future;

// 与引擎 run 域键名镜像(键为契约,常量不可见处直接字面量)
const RETRY_BACKOFF_KEY: &str = "provider_retry_backoff_ms";
const FAIL_STREAK_KEY: &str = "provider_fail_streak";

/// 拉起器类型(与 conex_run::run::run_resume::ResumeLauncher 同构;
/// 该处经私有 use 重导入遮蔽 pub(crate) 定义,无法跨模块引用——本地
/// 等价类型别名,闭包底层类型一致即可传给 set_resume_launcher；
/// 返回 bool = 是否成功接手拉起，false 时引擎会回灌本轮注入条目)
type ResumeLauncher = Arc<
    dyn Fn(
            &Arc<CoreRunState>,
            &str,
            &str,
            Vec<AgentMessage>,
        ) -> Pin<Box<dyn Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// 忽略式事件发射器(装配 EventBridge 用;接入用例不消费事件面)
struct IgnoreEmitter;

impl conex_run::core_event_bridge::Emitter for IgnoreEmitter {
    fn emit(&self, _channel: &str, _payload: &str) {}
}

/// 测试临时快照文件序号(防并行冲突)
static SNAPSHOT_SEQ: AtomicU32 = AtomicU32::new(0);

/// 会话条目(对齐 conex_run::run::tests::subagent_test_session_entry)
fn session_entry(id: &str) -> SessionIndexEntry {
    SessionIndexEntry {
        id: id.to_string(),
        title: format!("会话 {id}"),
        folder: String::new(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-08-05T00:00:00.000Z".to_string(),
        updated_at: 1,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: Some(0),
        engine_last_run_id: None,
        hydrated_from_engine: Some(true),
    }
}

/// 构造真实 HttpProviderCall 注入的测试状态(mock server 走真实 wire;
/// 与 conex_run::run::tests::run_control_test_state 同构,自足独立)
fn run_state_with_http_provider(
    provider: Arc<HttpProviderCall>,
    base_url: &str,
) -> (Arc<CoreRunState>, LocalDb) {
    let db = LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&session_entry("s1"))
        .expect("会话条目");
    let seq = SNAPSHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> =
        Arc::new(SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_c3_mock_{}_{seq}_snapshot.json",
            std::process::id()
        ))));
    let bridge = EventBridge::new("workbench-run-event", Arc::new(IgnoreEmitter));
    let state = Arc::new(CoreRunState::new(
        Arc::new(LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    // 用户裁决：重试预算/上限可配置——本文件用例数请求次数不断言墙钟
    // 时长，统一注入 baseMs=1 快速策略，防缺省 750ms 指数退避把多次
    // 重试用例拖穿断言窗口。
    state.set_run_policy(Some(conex_run::run_policy::RunPolicy {
        retry_backoff: Some(conex_run::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(10),
    }));
    let config = EngineProviderConfig {
        base_url: base_url.to_string(),
        api_key: "test-key".to_string(),
        model: "deepseek-v4-flash".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: std::collections::BTreeMap::new(),
        ..Default::default()
    };
    // 参数位置 unsized coercion:Arc<HttpProviderCall> → Arc<dyn ProviderCall>
    state.engine().inject_provider_for_test(provider, config);
    (state, db)
}

/// 测试选项(对齐 conex_run::run::tests::test_options)
fn test_options(run_id: &str, session_id: &str, prompt: &str) -> RunTaskOptions {
    RunTaskOptions {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        prompt: Some(prompt.to_string()),
        mode: Some("task".to_string()),
        cwd: None,
        permission_mode: Some("full".to_string()),
        client_message_id: None,
        assistant_client_message_id: None,
        system_prompt: None,
        history: None,
        context_window: None,
        parent_run_id: None,
        subagent_config: None,
        visible_goal: None,
        max_rounds: None,
        max_stalled_rounds: None,
        reasoning_effort: None,
        context_state: None,
        content: None,
        has_images: None,
        max_turns: None,
    }
}

/// 轮询会话事件库中的 agent-end 事件(真实 loop 收口落库;返回 reason)
async fn wait_run_terminal(db: &LocalDb, session_id: &str, window: Duration) -> String {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        // 收口落库经 spawn_blocking 异步写 events 表——测试轮询可能撞上
        // 写侧表锁（query_events_collect: database table is locked）；
        // 锁竞速按「未就绪」重试，写侧完成后本查询自然成功。
        let events = match db.query_events(session_id, 0, Some(500)) {
            Ok(events) => events,
            Err(_) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "run-terminal 事件未在窗口内落库"
                );
                tokio::time::sleep(Duration::from_millis(30)).await;
                continue;
            }
        };
        for event in &events {
            // G-29 事件权威：run-terminal 是唯一终态事件（03 §5.2-2，
            // 旧 agent-end/run-completed/run-failed 已删），断言只认权威形态。
            if event.event_type != "run-terminal" {
                continue;
            }
            let payload: serde_json::Value =
                serde_json::from_str(&event.payload).expect("run-terminal 载荷为合法 JSON");
            if let Some(terminal) = payload["terminal"].as_str() {
                return terminal.to_string();
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run-terminal 事件未在窗口内落库"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// 轮询熔断键 count(收口 spawn_blocking 异步落键;窗口内未达则 panic)。
/// 熔断计数按会话命名空间落键（`{session_id}:provider_fail_streak`）。
async fn wait_for_fail_streak_count(db: &LocalDb, expected: u32, window: Duration) -> u32 {
    let deadline = tokio::time::Instant::now() + window;
    let key = format!("s1:{FAIL_STREAK_KEY}");
    loop {
        let raw = db.get_session_meta(&key).expect("熔断键读取");
        let count = raw
            .as_deref()
            .and_then(|r| serde_json::from_str::<serde_json::Value>(r).ok())
            .and_then(|v| v["count"].as_u64())
            .map(|c| c as u32)
            .unwrap_or(0);
        if count == expected {
            return count;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "熔断键 count 未达期望 {expected}(当前 {count})"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// 记录型拉起器替身(仅计数,不拉起新 run——避免续写 run 再次请求 mock
/// 使脚本消费与请求记录面复杂化)
fn counting_launcher(counter: Arc<AtomicU64>) -> ResumeLauncher {
    let launcher: ResumeLauncher = Arc::new(move |_state, _session_id, _mode, _messages| {
        let counter = Arc::clone(&counter);
        Box::pin(async move {
            counter.fetch_add(1, Ordering::SeqCst);
            true
        })
    });
    launcher
}

/// 正常 chat-completions SSE 帧序列(内容 + stop + [DONE])
fn ok_frames(text: &str) -> Vec<String> {
    vec![
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}).to_string(),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}).to_string(),
        "[DONE]".to_string(),
    ]
}

/// 清空代理环境变量(对齐 config_profile_apply 先例:保证请求真实
/// 直连本地 mock,不依赖机器代理配置)
fn clear_proxy_env() {
    for var in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::remove_var(var);
    }
}

/// 进程级 LIVE_CATALOG 是共享静态（protocol.rs:46），必须与
/// protocol / engine_provider 测试**共用同一把锁**串行安装夹具——
/// 否则并行时本模块会读到别的测试装的 catalog，chat 轨被误判为
/// responses 轨（实证 2026-09-15：本模块 4 个用例并行全红、单跑全绿，
/// 报错 `[invalid-stream] Responses stream ended without a terminal
/// response event`）。protocol.rs:486-489 的注释已声明该锁的共享契约，
/// 此前只覆盖了 protocol / engine_provider 两处，本模块漏接。
fn lock_live_catalog() -> std::sync::MutexGuard<'static, ()> {
    conex_run::engine_provider::protocol::LIVE_CATALOG_TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// 安装空树夹具 → `slots_for_model` 不命中 → `CatalogRequestProfile::fail_closed()`
/// （protocol = Chat、max_tokens_field = MaxTokens）。本模块全部用例都走
/// chat 轨，空树给出**确定性**剖面，不再依赖机器上真实 models.yaml 的内容。
fn install_chat_catalog() {
    conex_run::engine_provider::protocol::reload_live_catalog_from_yaml_str(
        "version: 2\nproviders: {}\n",
    )
    .expect("空树夹具");
}

// ── 用例①:429+Retry-After → 客户端等待 ≥Retry-After 后重试 ──

/// C3 用例①(429+Retry-After=2s):真实 wire 下内核退避等待
/// `max(750ms, retry-after)` 后重试成功——两次请求间隔 ≥2s 且
/// 第二次响应 200。30s 精确断言由既有虚拟时钟单测
/// (`stream_error.rs rate_limit_retry_after_waits_at_least_30s`)
/// 承担,本用例用短 Retry-After 验证同一机制在真实 HTTP 链路生效。
#[tokio::test]
async fn mock_429_retry_after_gates_client_retry() {
    clear_proxy_env();
    let server = ScriptedMockServer::start(vec![
        ScriptStep::rate_limit(2),
        ScriptStep::sse_ok(ok_frames("重试后成功")),
    ])
    .await;
    let provider = HttpProviderCall::new(
        reqwest::Client::new(),
        EngineProviderConfig {
            base_url: server.base_url("/v1"),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
            ..Default::default()
        },
    );
    let _live = lock_live_catalog();
    install_chat_catalog();
    let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
    state.run_restore().await;
    // 退避键装配:内核 750ms×2^(n-1)/8s 封顶/60s 预算(生产装配同键)
    db.set_session_meta(RETRY_BACKOFF_KEY, "[750,8000,60000]")
        .expect("退避键写入");
    run_task_impl(Arc::clone(&state), test_options("c3-429", "s1", "任务"))
        .await
        .expect("run 发起成功");
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(terminal, "completed", "429 重试后正常完成收场");
    let captured = server.wait_for(2).await;
    assert_eq!(captured.len(), 2, "429 后恰好重试 1 次");
    assert_eq!(captured[0].response_status, 429, "首请求 → 429");
    assert_eq!(captured[1].response_status, 200, "重试请求 → 200");
    let wait_ms = captured[1]
        .arrived_at
        .duration_since(captured[0].arrived_at)
        .as_millis();
    assert!(
        wait_ms >= 1900,
        "重试等待 ≥Retry-After(2s):实际 {wait_ms}ms(max(750,2000)=2000ms)"
    );
    assert!(
        captured[1].path.starts_with("/v1/chat/completions"),
        "重试请求同一端点:{}",
        captured[1].path
    );
}

// ── 用例②:5xx 序列 → 退避重试序列 ──

/// C3 用例②(5xx 序列):脚本 [500, 502, 503, 200] 按序号消费,
/// 每次 5xx 后内核退避 750ms 重试,第 4 次成功——断言请求数、
/// 响应状态序列与退避总时长(≥3×750ms)。
#[tokio::test]
async fn mock_5xx_sequence_backoffs_and_retries() {
    clear_proxy_env();
    let server = ScriptedMockServer::start(vec![
        ScriptStep::status(500),
        ScriptStep::status(502),
        ScriptStep::status(503),
        ScriptStep::sse_ok(ok_frames("5xx 退避后成功")),
    ])
    .await;
    let provider = HttpProviderCall::new(
        reqwest::Client::new(),
        EngineProviderConfig {
            base_url: server.base_url("/v1"),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
            ..Default::default()
        },
    );
    let _live = lock_live_catalog();
    install_chat_catalog();
    let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
    state.run_restore().await;
    db.set_session_meta(RETRY_BACKOFF_KEY, "[750,8000,60000]")
        .expect("退避键写入");
    let started = tokio::time::Instant::now();
    run_task_impl(Arc::clone(&state), test_options("c3-5xx", "s1", "任务"))
        .await
        .expect("run 发起成功");
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(terminal, "completed", "5xx 重试耗尽前成功收场");
    let captured = server.wait_for(4).await;
    assert_eq!(captured.len(), 4, "3 次 5xx + 1 次成功 = 4 个请求");
    let statuses: Vec<u16> = captured.iter().map(|c| c.response_status).collect();
    assert_eq!(statuses, vec![500, 502, 503, 200], "5xx 序列按脚本序号消费");
    let elapsed_ms = started.elapsed().as_millis();
    assert!(
        elapsed_ms >= 2000,
        "3 次 750ms 退避(≥2.25s):实际 {elapsed_ms}ms"
    );
    assert_eq!(server.consumed(), 4, "脚本消费 4 步");
}

// ── 用例③:断流(已产出)→ 部分保留 + providerErrorKind 标注 ──

/// C3 用例③(发数据后断流):真实 wire 断流(1 帧后掐断)→ 内核
/// 「已产出不重试」(仅 1 个请求)→ 部分保留收场 Stop → D7 结构化
/// 标注 providerErrorKind 被双消费端识别:① E1 续写判定拉起
/// (counting 替身 +1);② 熔断 S2 计数 +1(瞬态类计入)。
#[tokio::test]
async fn mock_stream_cut_after_data_partial_preserved_with_kind() {
    clear_proxy_env();
    let server =
        ScriptedMockServer::start(vec![ScriptStep::sse_cut(ok_frames("半截输出"), 1)]).await;
    let provider = HttpProviderCall::new(
        reqwest::Client::new(),
        EngineProviderConfig {
            base_url: server.base_url("/v1"),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
            ..Default::default()
        },
    );
    let _live = lock_live_catalog();
    install_chat_catalog();
    let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
    state.run_restore().await;
    // E1 续写退避置零(测试直接驱动,跳过跨 run 退避睡眠)
    let zero_backoff: BackoffDelayFn = Arc::new(|_attempt| Duration::ZERO);
    state.set_resume_backoff(Some(zero_backoff));
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    run_task_impl(Arc::clone(&state), test_options("c3-cut", "s1", "任务"))
        .await
        .expect("run 发起成功");
    // 部分保留断流:正常 Stop 收场(非 Error fatal)
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(terminal, "completed", "部分保留断流以正常完成收场");
    // 已产出不重试(内核三层纪律):仅 1 个请求
    let captured = server.wait_for(1).await;
    assert_eq!(captured.len(), 1, "已产出断流不重试(仅 1 次请求)");
    assert_eq!(captured[0].response_status, 200, "断流前已回 200+SSE 头");
    // D7 标注消费端①:E1 续写判定命中(providerErrorKind=network 被识别)
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if counter.load(Ordering::SeqCst) >= 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "E1 续写拉起未在窗口内发生(providerErrorKind 标注未被识别?)"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // D7 标注消费端②:熔断 S2 计数 +1(部分保留断流计入连续失败)
    let count = wait_for_fail_streak_count(&db, 1, Duration::from_secs(10)).await;
    assert_eq!(count, 1, "部分保留断流(瞬态类)计入熔断计数(S2)");
}

// ── 用例④:断流(未产出)→ 重试 ──

/// C3 用例④(未产出断流):脚本 [断流(0 帧), 正常流]——第一次仅
/// 200+SSE 头即截断,未产出 → 客户端安全重试(750ms 退避后),第二次
/// 正常流成功收场。
#[tokio::test]
async fn mock_stream_cut_before_data_retries() {
    clear_proxy_env();
    let server = ScriptedMockServer::start(vec![
        ScriptStep::sse_cut(ok_frames("不应输出"), 0),
        ScriptStep::sse_ok(ok_frames("重试后成功")),
    ])
    .await;
    let provider = HttpProviderCall::new(
        reqwest::Client::new(),
        EngineProviderConfig {
            base_url: server.base_url("/v1"),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
            ..Default::default()
        },
    );
    let _live = lock_live_catalog();
    install_chat_catalog();
    let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
    state.run_restore().await;
    db.set_session_meta(RETRY_BACKOFF_KEY, "[750,8000,60000]")
        .expect("退避键写入");
    run_task_impl(Arc::clone(&state), test_options("c3-cut0", "s1", "任务"))
        .await
        .expect("run 发起成功");
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    // G-29 事件权威：终态取值经权威映射收敛（旧 stop → completed），
    // 与同组其余 scripted 用例同源；语义仍为「重试后正常完成收场」。
    assert_eq!(terminal, "completed", "未产出断流重试后正常完成收场");
    let captured = server.wait_for(2).await;
    assert_eq!(captured.len(), 2, "未产出断流 → 重试 1 次(共 2 请求)");
    assert_eq!(captured[0].response_status, 200, "断流请求仍先回 200 头");
    assert_eq!(captured[1].response_status, 200, "重试请求 → 200 正常流");
    let wait_ms = captured[1]
        .arrived_at
        .duration_since(captured[0].arrived_at)
        .as_millis();
    assert!(
        wait_ms >= 650,
        "未产出断流重试等待退避 750ms:实际 {wait_ms}ms"
    );
    assert_eq!(server.consumed(), 2, "脚本两步按序消费");
}
