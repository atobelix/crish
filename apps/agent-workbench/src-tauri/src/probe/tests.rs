//! probe 测试（probe.rs 拆分）：模型扫描解析与探活请求。

#![allow(clippy::await_holding_lock)] // 单元测试持 CONFIG_TEST_LOCK 串行执行并跨越网络 await

use super::*;

#[test]
fn parse_scanned_models_openai_format() {
    let json = serde_json::json!({
        "object": "list",
        "data": [
            {
                "id": "gpt-4o",
                "object": "model",
                "created": 1715368132,
                "owned_by": "system",
                "context_window": 128000
            },
            {
                "id": "gpt-3.5-turbo",
                "object": "model",
                "created": 1677610602,
                "owned_by": "openai"
            }
        ]
    });

    let models = parse_scanned_models(&json, "openai-official");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model, "gpt-4o");
    assert_eq!(models[0].vendor, Some("openai-official".to_string()));
    assert_eq!(models[0].context_window, Some(128000));
    assert_eq!(models[1].model, "gpt-3.5-turbo");
    assert_eq!(models[1].context_window, None);
}

#[test]
fn parse_scanned_models_ollama_format() {
    let json = serde_json::json!({
        "models": [
            {
                "name": "llama3:latest",
                "model": "llama3:latest",
                "modified_at": "2024-05-01T00:00:00Z",
                "size": 4661224676_i64,
                "context_length": 8192
            },
            {
                "name": "qwen2.5-coder:7b",
                "model": "qwen2.5-coder:7b",
                "inputTokenLimit": 32768
            }
        ]
    });

    let models = parse_scanned_models(&json, "ollama-local");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model, "llama3:latest");
    assert_eq!(models[0].context_window, Some(8192));
    assert_eq!(models[1].model, "qwen2.5-coder:7b");
    assert_eq!(models[1].context_window, Some(32768));
}

#[test]
fn parse_scanned_models_gemini_format() {
    let json = serde_json::json!({
        "models": [
            {
                "name": "models/gemini-1.5-pro",
                "version": "001",
                "displayName": "Gemini 1.5 Pro",
                "inputTokenLimit": 2097152
            },
            {
                "name": "models/gemini-1.5-flash",
                "version": "001",
                "input_token_limit": 1048576
            }
        ]
    });

    let models = parse_scanned_models(&json, "google-gemini");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model, "gemini-1.5-pro");
    assert_eq!(models[0].context_window, Some(2097152));
    assert_eq!(models[1].model, "gemini-1.5-flash");
    assert_eq!(models[1].context_window, Some(1048576));
}

#[test]
fn parse_scanned_models_array_format() {
    let json_strings =
        serde_json::json!(["claude-3-5-sonnet", "claude-3-opus", "claude-3-5-sonnet"]);
    let models = parse_scanned_models(&json_strings, "anthropic-direct");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model, "claude-3-5-sonnet");
    assert_eq!(models[1].model, "claude-3-opus");

    let json_objects = serde_json::json!([
        {"id": "deepseek-chat", "context_window": 64000},
        {"id": "deepseek-reasoner", "max_model_len": 64000}
    ]);
    let ds_models = parse_scanned_models(&json_objects, "deepseek");
    assert_eq!(ds_models.len(), 2);
    assert_eq!(ds_models[0].model, "deepseek-chat");
    assert_eq!(ds_models[0].context_window, Some(64000));
    assert_eq!(ds_models[1].model, "deepseek-reasoner");
}

struct Fixture {
    _dir: tempfile::TempDir,
    store: std::sync::Arc<agent_provider::model_store::ModelsStore>,
    old_env: Option<std::ffi::OsString>,
}

impl Fixture {
    fn new(base_url: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(agent_provider::model_store::ModelsStore::new(
            dir.path().join("models.yaml"),
            dir.path().join("secrets"),
            None,
        ));
        let base = store.read().unwrap();
        let tree = serde_json::from_value(serde_json::json!({
            "version":2,"activeModel":{"providerId":"test-provider","modelId":"mock-model-1"},
            "providers":{"test-provider":{"baseUrl":base_url,"protocol":"openai/chat","stream":true,
                "apiKeyRef":"env:CRISH_PROBE_FIXTURE_KEY",
                "models":[{"id":"mock-model-1","maxOutputTokens":32,"contextWindow":1024}]}}
        }))
        .unwrap();
        let old_env = std::env::var_os("CRISH_PROBE_FIXTURE_KEY");
        std::env::set_var("CRISH_PROBE_FIXTURE_KEY", "fixture-key");
        store.apply(tree, &base.revision).unwrap();
        crate::config::install_models_store_for_test(store.clone());
        Self {
            _dir: dir,
            store,
            old_env,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(value) = &self.old_env {
            std::env::set_var("CRISH_PROBE_FIXTURE_KEY", value);
        } else {
            std::env::remove_var("CRISH_PROBE_FIXTURE_KEY");
        }
        crate::config::reset_config_stores_for_test();
    }
}

#[tokio::test]
async fn probe_ping_empty_profile_id_returns_error() {
    let res = probe_ping_core(ProbePingRequest {
        profile_id: " ".into(),
        model: Some("m".into()),
        timeout_ms: None,
    })
    .await;
    assert!(!res.ok);
    assert!(res.error.is_some());
}

#[tokio::test]
async fn probe_ping_nonexistent_profile_returns_configuration_error() {
    let _guard = crate::config_test_support::CONFIG_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _fixture = Fixture::new("http://localhost:1");
    let res = probe_ping_core(ProbePingRequest {
        profile_id: "missing".into(),
        model: Some("m".into()),
        timeout_ms: None,
    })
    .await;
    assert!(!res.ok);
    assert!(res.error.unwrap().contains("供应商"));
}

#[tokio::test]
async fn probe_scan_models_nonexistent_profile_returns_error() {
    let _guard = crate::config_test_support::CONFIG_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _fixture = Fixture::new("http://localhost:1");
    let res = probe_scan_models_core(ProbeScanRequest {
        profile_id: "missing".into(),
        timeout_ms: None,
    })
    .await;
    assert!(!res.ok);
    assert!(res.models.is_empty());
}

#[tokio::test]
async fn probe_ping_and_scan_with_local_mock_server() {
    use axum::{
        routing::{get, post},
        Json, Router,
    };
    let _guard = crate::config_test_support::CONFIG_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let app = Router::new()
        .route("/chat/completions", post(|| async {
            ([(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
        }))
        .route("/models", get(|| async { Json(serde_json::json!({"data":[{"id":"mock-model-1"},{"id":"new-candidate"}]})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let fixture = Fixture::new(&format!("http://{addr}"));
    let before = std::fs::read_to_string(fixture.store.path()).unwrap();
    let ping = probe_ping_core(ProbePingRequest {
        profile_id: "test-provider".into(),
        model: Some("mock-model-1".into()),
        timeout_ms: Some(5000),
    })
    .await;
    assert!(ping.ok, "{:?}", ping.error);
    let scan = probe_scan_models_core(ProbeScanRequest {
        profile_id: "test-provider".into(),
        timeout_ms: Some(5000),
    })
    .await;
    assert!(scan.ok, "{:?}", scan.error);
    assert_eq!(scan.models.len(), 2);
    assert_eq!(
        std::fs::read_to_string(fixture.store.path()).unwrap(),
        before
    );
    assert_eq!(
        fixture.store.committed().unwrap().tree.providers["test-provider"]
            .models
            .len(),
        1
    );
    assert!(!fixture._dir.path().join("profile-config.json").exists());
    task.abort();
}

#[tokio::test]
async fn http_200_with_error_event_is_not_successful_probe() {
    use axum::{routing::post, Router};
    let _guard = crate::config_test_support::CONFIG_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let app = Router::new().route(
        "/chat/completions",
        post(|| async {
            (
                [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                "data: {\"error\":{\"message\":\"denied\"}}\n\n",
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let _fixture = Fixture::new(&format!("http://{addr}"));
    let result = probe_ping_core(ProbePingRequest {
        profile_id: "test-provider".into(),
        model: Some("mock-model-1".into()),
        timeout_ms: Some(5000),
    })
    .await;
    assert!(!result.ok);
    assert!(result.error.is_some());
    task.abort();
}

#[test]
fn resolve_probe_target_uses_committed_provider_only() {
    let _guard = crate::config_test_support::CONFIG_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let fixture = Fixture::new("https://example.test/v1");
    let target = fixture.store.resolve_provider("test-provider").unwrap();
    assert_eq!(
        target.provider.base_url.as_deref(),
        Some("https://example.test/v1")
    );
    assert_eq!(target.provider.protocol, ProtocolKind::OpenAiChat);
    assert!(fixture.store.resolve_provider("other").is_err());
}
