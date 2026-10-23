//! 原生服务商连通性探活与模型扫描模块（Batch 1 · G3 独立模块）。
//!
//! 职责与安全特性：
//! - `provider_probe_ping`：从同一已提交配置快照读取模型与凭据，
//!   发起轻量 HTTP 请求进行连通性检查与毫秒级 RTT 延迟测量，非崩溃型返回；
//! - `provider_probe_scan_models`：底层携带 DPAPI 密钥直接请求 `GET /models`，
//!   解析候选列表；只有用户确认并提交统一配置事务后才持久化；
//! - 凭据安全：前端冷启动与运行期无需在内存保留明文 API Key，零明文泄露。

use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use agent_provider::model_store::ResolvedProviderConfig;
use agent_provider::models::{ModelRef, ProtocolKind, ScannedModel};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};

const DEFAULT_PROBE_TIMEOUT_MS: u64 = 15_000;
use serde::{Deserialize, Serialize};

/// 探活请求参数（serde camelCase）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbePingRequest {
    pub profile_id: String,
    pub model: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// 探活结构化返回结果（非异常崩溃型契约）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbePingResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub status_code: Option<u16>,
    pub error: Option<String>,
}

/// 模型扫描请求参数（serde camelCase）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeScanRequest {
    pub profile_id: String,
    pub timeout_ms: Option<u64>,
}

/// 模型扫描返回结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeScanResult {
    pub ok: bool,
    pub models: Vec<ScannedModel>,
    pub error: Option<String>,
}

/// 解析服务端返回的多种 JSON 模型格式（OpenAI / Ollama / Gemini / Anthropic / 顶层数组）
pub fn parse_scanned_models(body: &serde_json::Value, profile_id: &str) -> Vec<ScannedModel> {
    let mut scanned = Vec::new();
    let mut seen_ids = HashSet::new();

    let mut add_item = |id_raw: &str, context_window: Option<u64>| {
        let trimmed = id_raw.trim();
        // 兼容 Gemini 前缀 "models/gemini-1.5-pro"
        let model_id = trimmed
            .strip_prefix("models/")
            .unwrap_or(trimmed)
            .to_string();
        if !model_id.is_empty() && seen_ids.insert(model_id.clone()) {
            scanned.push(ScannedModel {
                model: model_id,
                vendor: Some(profile_id.to_string()),
                context_window,
                max_output_tokens: None,
                capabilities: None,
            });
        }
    };

    if let Some(arr) = body.get("data").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                let cw = item
                    .get("context_window")
                    .or_else(|| item.get("context_length"))
                    .or_else(|| item.get("max_model_len"))
                    .and_then(|v| v.as_u64());
                add_item(id, cw);
            }
        }
    } else if let Some(arr) = body.get("models").and_then(|v| v.as_array()) {
        for item in arr {
            let id = item
                .get("name")
                .or_else(|| item.get("id"))
                .or_else(|| item.get("model"))
                .and_then(|v| v.as_str());
            if let Some(id) = id {
                let cw = item
                    .get("context_window")
                    .or_else(|| item.get("context_length"))
                    .or_else(|| item.get("input_token_limit"))
                    .or_else(|| item.get("inputTokenLimit"))
                    .and_then(|v| v.as_u64());
                add_item(id, cw);
            }
        }
    } else if let Some(arr) = body.as_array() {
        for item in arr {
            if let Some(id) = item
                .get("id")
                .or_else(|| item.get("name"))
                .or_else(|| item.get("model"))
                .and_then(|v| v.as_str())
            {
                let cw = item
                    .get("context_window")
                    .or_else(|| item.get("context_length"))
                    .and_then(|v| v.as_u64());
                add_item(id, cw);
            } else if let Some(id) = item.as_str() {
                add_item(id, None);
            }
        }
    }

    scanned
}

/// 代理和自定义头直接读取同一配置快照；非法配置返回错误，不静默跳过。
fn probe_client(
    config: &ResolvedProviderConfig,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(timeout).no_proxy();
    if let Some(proxy) = &config.provider.proxy_url {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "代理地址无效")?);
    }
    if let Some(headers) = &config.provider.headers {
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "自定义请求头名称无效")?;
            let value = HeaderValue::from_str(value).map_err(|_| "自定义请求头值无效")?;
            map.insert(name, value);
        }
        builder = builder.default_headers(map);
    }
    builder.build().map_err(|_| "无法创建供应商连接".into())
}

/// 原生探活核心逻辑
pub async fn probe_ping_core(req: ProbePingRequest) -> ProbePingResult {
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
    use futures_util::StreamExt;
    use session_loop::provider::{ProviderCall, ProviderRequest};
    use session_loop::stream::{ProviderStreamEvent, StopReason};
    use std::sync::Arc;

    const PROBE_OUTPUT_BUDGET: u32 = 16;
    let failure = |error: String| ProbePingResult {
        ok: false,
        latency_ms: None,
        status_code: None,
        error: Some(error),
    };
    let Some(model) = req
        .model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
    else {
        return failure("请选择要测试的模型".into());
    };
    let reference = ModelRef::new(req.profile_id, model);
    if let Err(error) = reference.validate() {
        return failure(error);
    }
    let resolved = match crate::config::blocking(move |store| store.resolve_model(&reference)).await
    {
        Ok(resolved) => resolved,
        Err(error) => return failure(error.message),
    };
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_PROBE_TIMEOUT_MS));
    if timeout.is_zero() {
        return failure("探活超时必须大于零".into());
    }
    let client = match reqwest::Client::builder()
        .timeout(timeout)
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return failure("无法创建探活连接".into()),
    };
    let budget = resolved
        .model
        .max_output_tokens
        .map_or(PROBE_OUTPUT_BUDGET, |limit| {
            limit.min(u64::from(PROBE_OUTPUT_BUDGET)) as u32
        });
    let secret = resolved.api_key.clone();
    let provider_config = crate::engine_provider::engine_provider_config_from_resolved(&resolved);
    let provider = crate::engine_provider::HttpProviderCall::new(client, provider_config);
    let messages = vec![Arc::new(AgentMessage {
        id: "provider-probe".into(),
        role: AgentMessageRole::User,
        created_at: crate::engine_provider::now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text {
            text: "Reply with OK.".into(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    })];
    let request = ProviderRequest {
        messages: &messages,
        tools: vec![],
        max_tokens: Some(budget),
        system_prompt: None,
        session_id: Some("provider-probe".into()),
        reasoning_effort: None,
    };
    let started = Instant::now();
    let result = tokio::time::timeout(timeout, async {
        let mut stream = provider
            .stream(&request)
            .await
            .map_err(|error| error.message)?;
        while let Some(event) = stream.next().await {
            match event.map_err(|error| error.message)? {
                ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error,
                    ..
                } => return Err(error.unwrap_or_else(|| "供应商返回错误终止".into())),
                ProviderStreamEvent::Stop { .. } => return Ok(()),
                _ => {}
            }
        }
        Err("响应缺少有效终止事件".into())
    })
    .await;
    let latency_ms = Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
    match result {
        Ok(Ok(())) => ProbePingResult {
            ok: true,
            latency_ms,
            status_code: None,
            error: None,
        },
        Ok(Err(error)) => ProbePingResult {
            ok: false,
            latency_ms,
            status_code: None,
            error: Some(error.replace(secret.as_str(), "[已隐藏]")),
        },
        Err(_) => ProbePingResult {
            ok: false,
            latency_ms,
            status_code: None,
            error: Some("供应商探活超时".into()),
        },
    }
}

/// 模型扫描核心逻辑
pub async fn probe_scan_models_core(req: ProbeScanRequest) -> ProbeScanResult {
    let profile_id = req.profile_id.trim();
    if profile_id.is_empty() {
        return ProbeScanResult {
            ok: false,
            models: vec![],
            error: Some("profile_id 不能为空".to_string()),
        };
    }

    let id = profile_id.to_string();
    let config = match crate::config::blocking(move |store| store.resolve_provider(&id)).await {
        Ok(config) => config,
        Err(error) => {
            return ProbeScanResult {
                ok: false,
                models: vec![],
                error: Some(error.message),
            }
        }
    };
    let Some(base_url) = config
        .provider
        .base_url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
    else {
        return ProbeScanResult {
            ok: false,
            models: vec![],
            error: Some("供应商尚未配置服务地址".into()),
        };
    };
    let api_key = config.api_key.as_str();

    let timeout_duration =
        Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_PROBE_TIMEOUT_MS));
    let client = match probe_client(&config, timeout_duration) {
        Ok(c) => c,
        Err(e) => {
            return ProbeScanResult {
                ok: false,
                models: vec![],
                error: Some(format!("构建 HTTP 客户端失败: {e}")),
            };
        }
    };

    let endpoint = agent_provider::request::build_endpoint_url(config.provider.protocol, base_url);
    let url = match config.provider.protocol {
        ProtocolKind::OpenAiChat => format!(
            "{}/models",
            endpoint
                .strip_suffix("/chat/completions")
                .unwrap_or(&endpoint)
        ),
        ProtocolKind::OpenAiResponses => format!(
            "{}/models",
            endpoint.strip_suffix("/responses").unwrap_or(&endpoint)
        ),
        ProtocolKind::AnthropicMessages => format!(
            "{}/models",
            endpoint.strip_suffix("/messages").unwrap_or(&endpoint)
        ),
        ProtocolKind::GoogleGenerateContent => format!("{endpoint}/models"),
    };
    let req_builder = match config.provider.protocol {
        ProtocolKind::AnthropicMessages => client.get(url).header("x-api-key", api_key).header(
            "anthropic-version",
            agent_provider::request::ANTHROPIC_VERSION,
        ),
        ProtocolKind::GoogleGenerateContent => client.get(url).header("x-goog-api-key", api_key),
        ProtocolKind::OpenAiChat | ProtocolKind::OpenAiResponses => client
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {api_key}")),
    };

    let resp = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let error_msg = if e.is_timeout() {
                format!("连接超时 (超过 {}ms)", timeout_duration.as_millis())
            } else if e.is_connect() {
                "无法连接到服务端，请检查 Base URL 与网络连接".to_string()
            } else {
                format!("扫描模型失败: {e}")
            };
            return ProbeScanResult {
                ok: false,
                models: vec![],
                error: Some(error_msg),
            };
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        let short_err = if err_text.chars().count() > 200 {
            let truncated: String = err_text.chars().take(200).collect();
            format!("{truncated}...")
        } else {
            err_text
        };
        return ProbeScanResult {
            ok: false,
            models: vec![],
            error: Some(format!("扫描接口返回错误 HTTP {status}: {short_err}")),
        };
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            return ProbeScanResult {
                ok: false,
                models: vec![],
                error: Some(format!("解析模型 JSON 失败: {e}")),
            };
        }
    };

    let scanned_entries = parse_scanned_models(&body, profile_id);
    if scanned_entries.is_empty() {
        return ProbeScanResult {
            ok: false,
            models: vec![],
            error: Some("未从服务端发现任何可用模型".to_string()),
        };
    }

    ProbeScanResult {
        ok: true,
        models: scanned_entries,
        error: None,
    }
}

/// Tauri 命令入口：provider_probe_ping
#[tauri::command]
pub async fn provider_probe_ping(
    profile_id: String,
    model: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ProbePingResult, String> {
    Ok(probe_ping_core(ProbePingRequest {
        profile_id,
        model,
        timeout_ms,
    })
    .await)
}

/// Tauri 命令入口：provider_probe_scan_models
#[tauri::command]
pub async fn provider_probe_scan_models(
    profile_id: String,
    timeout_ms: Option<u64>,
) -> Result<ProbeScanResult, String> {
    Ok(probe_scan_models_core(ProbeScanRequest {
        profile_id,
        timeout_ms,
    })
    .await)
}

#[cfg(test)]
#[allow(clippy::await_holding_lock)] // 单元测试持 CONFIG_TEST_LOCK 串行执行并跨越网络 await
mod tests {
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
            })).unwrap();
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
        let _guard = crate::core_run_commands::CONFIG_TEST_LOCK
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
        let _guard = crate::core_run_commands::CONFIG_TEST_LOCK
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
        let _guard = crate::core_run_commands::CONFIG_TEST_LOCK
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
        let _guard = crate::core_run_commands::CONFIG_TEST_LOCK
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
        let _guard = crate::core_run_commands::CONFIG_TEST_LOCK
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
}
