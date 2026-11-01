//! G5a 远程附件面（C24 content/hasImages）：网关透传落点与服务端钳制。
//!
//! - 带 content + hasImages=true 的远程 run → parts 写入用户消息
//!   metadata.contentParts（沿 run_launch 既有断言面：TestProvider
//!   请求快照回读用户消息）；
//! - hasImages 非 true 时 content 不进元数据（引擎语义，网关不改写）；
//! - 不带两字段的旧载荷 → 用户消息 metadata 为 None（行为不变）；
//! - content 总量 / 单 dataUrl 超限 → cmd.invalid 明确拒绝（run 不发起）。

use std::sync::Arc;

use agent_provider::config::Endpoint;
use conex_device_protocol::{DeviceErrorCode, RunTaskParams};
use conex_types::message::AgentMessageRole;
use conex_types::permission::PermissionMode;
use session_loop::provider::ProviderCall;
use session_loop::stream::{ProviderStreamEvent, StopReason};
use session_loop::testing::TestProvider;

use crate::core_backend::CoreStateBackend;
use crate::server::backend::ApiBackend;

use super::{g5_test_session_entry, r2_test_core_state, recording_bridge};

/// 与 session_ops::t08 同款装配：内存库 + TestProvider 单轮文本收口。
async fn content_test_backend() -> (CoreStateBackend, Arc<TestProvider>, conex_db::LocalDb) {
    let (bridge, _emitter) = recording_bridge();
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&g5_test_session_entry("s1"))
        .expect("会话条目");
    static G5A_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = G5A_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_g5a_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(conex_run::run::CoreRunState::new(
        Arc::new(orchestrator::persist::LocalDbStore::new(db.clone())),
        db.clone(),
        snapshots,
        bridge,
        Arc::new(conex_run::status_diagnostics::StatusDiagnostics::new()),
        None,
    ));
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("远程附件 run 收口。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let routed: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
    let config = conex_run::engine_provider::EngineProviderConfig {
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
    (CoreStateBackend::new(state), provider, db)
}

/// 等 run 收口（agent-end 事件落库；对齐 t08 断言面）
async fn wait_agent_end(db: &conex_db::LocalDb) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
        if events.iter().any(|event| event.event_type == "agent-end") {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "agent-end 未在窗口内落库——run 未正常收口"
        );
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
}

fn run_params(content: Option<serde_json::Value>, has_images: Option<bool>) -> RunTaskParams {
    RunTaskParams {
        session_id: Some("s1".to_string()),
        prompt: "看这张图".to_string(),
        prompt_ref: None,
        mode: None,
        cwd: None,
        permission_mode: Some(PermissionMode::Ask),
        history: None,
        client_message_id: None,
        content,
        has_images,
    }
}

/// 取首个 provider 请求中的用户消息 metadata
fn first_user_metadata(provider: &TestProvider) -> Option<serde_json::Value> {
    let messages = provider.request_messages(0);
    let user = messages
        .iter()
        .find(|message| matches!(message.role, AgentMessageRole::User))
        .expect("provider 请求必须含用户消息");
    user.metadata.clone()
}

/// 带图 parts（桌面 multimodal.ts 同构：text part + image_url part）
fn sample_parts() -> serde_json::Value {
    serde_json::json!([
        { "type": "text", "text": "看这张图" },
        {
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,iVBORw0KGgo=", "detail": "auto" },
            "name": "a.png",
            "mime": "image/png"
        }
    ])
}

#[tokio::test]
async fn g5a_remote_run_with_content_lands_content_parts() {
    let (backend, provider, db) = content_test_backend().await;
    let parts = sample_parts();
    let result = backend
        .run_task(run_params(Some(parts.clone()), Some(true)))
        .await;
    assert!(result.is_ok(), "带附件远程 run 必须正常发起：{result:?}");
    wait_agent_end(&db).await;
    let metadata = first_user_metadata(&provider).expect("带图 run 的用户消息必须有 metadata");
    assert_eq!(
        metadata["contentParts"], parts,
        "content parts 必须原样写入 metadata.contentParts"
    );
}

#[tokio::test]
async fn g5a_remote_run_content_without_has_images_not_in_metadata() {
    let (backend, provider, db) = content_test_backend().await;
    // 非视觉降级形态：content 为纯文本 parts、hasImages=false——
    // 引擎语义下不进 contentParts，网关透传不改写
    let parts = serde_json::json!([{ "type": "text", "text": "- notes.txt" }]);
    let result = backend.run_task(run_params(Some(parts), Some(false))).await;
    assert!(
        result.is_ok(),
        "纯文本 parts 远程 run 必须正常发起：{result:?}"
    );
    wait_agent_end(&db).await;
    assert_eq!(
        first_user_metadata(&provider),
        None,
        "hasImages 非 true 时用户消息 metadata 必须为 None"
    );
}

#[tokio::test]
async fn g5a_remote_run_without_content_keeps_plain_text() {
    let (backend, provider, db) = content_test_backend().await;
    let result = backend.run_task(run_params(None, None)).await;
    assert!(result.is_ok(), "旧载荷远程 run 必须正常发起：{result:?}");
    wait_agent_end(&db).await;
    assert_eq!(
        first_user_metadata(&provider),
        None,
        "旧载荷（无 content/hasImages）用户消息 metadata 必须为 None"
    );
}

#[tokio::test]
async fn g5a_remote_run_content_total_over_limit_rejected() {
    let backend = CoreStateBackend::new(r2_test_core_state());
    // 单 text part 约 800 KB → 序列化总量超过 RUN_CONTENT_MAX_BYTES
    let content = serde_json::json!([{ "type": "text", "text": "x".repeat(800_000) }]);
    let err = backend
        .run_task(run_params(Some(content), None))
        .await
        .expect_err("content 总量超限必须被拒绝");
    assert_eq!(
        err.device_code(),
        DeviceErrorCode::CmdInvalid,
        "总量超限必须回 cmd.invalid：{err:?}"
    );
}

#[tokio::test]
async fn g5a_remote_run_data_url_over_limit_rejected() {
    let backend = CoreStateBackend::new(r2_test_core_state());
    // 单 dataUrl 约 717 KB（> 700 KiB 上限），但 content 总量仍在
    // 总量上限内——隔离验证单 dataUrl 钳制
    let data_url = format!("data:image/png;base64,{}", "A".repeat(717_000));
    let content = serde_json::json!([
        { "type": "image_url", "image_url": { "url": data_url, "detail": "auto" } }
    ]);
    let err = backend
        .run_task(run_params(Some(content), Some(true)))
        .await
        .expect_err("单 dataUrl 超限必须被拒绝");
    assert_eq!(
        err.device_code(),
        DeviceErrorCode::CmdInvalid,
        "dataUrl 超限必须回 cmd.invalid：{err:?}"
    );
}
