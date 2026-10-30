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
use conex_run::core_error::CoreError;
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
/// 代理策略与引擎主链路（engine_provider/connection.rs）对齐：默认跟随
/// 系统代理解析（reqwest 环境代理语义），`provider.proxy_url` 显式配置优先。
fn probe_client(
    config: &ResolvedProviderConfig,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(timeout);
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
    // 代理策略与引擎主链路一致：默认跟随系统代理解析（不再硬编码 no_proxy），
    // 本机依赖 TUN/代理出网时探活与实连行为保持同路
    let client = match reqwest::Client::builder().timeout(timeout).build() {
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
    let provider_config =
        conex_run::engine_provider::engine_provider_config_from_resolved(&resolved);
    let provider = conex_run::engine_provider::HttpProviderCall::new(client, provider_config);
    let messages = vec![Arc::new(AgentMessage {
        id: "provider-probe".into(),
        role: AgentMessageRole::User,
        created_at: conex_run::engine_provider::now_iso_utc(),
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
        ProtocolKind::AnthropicMessages => {
            let mut b = client.get(url).header(
                "anthropic-version",
                agent_provider::request::ANTHROPIC_VERSION,
            );
            if !api_key.trim().is_empty() {
                b = b.header("x-api-key", api_key);
            }
            b
        }
        ProtocolKind::GoogleGenerateContent => {
            let mut b = client.get(url);
            if !api_key.trim().is_empty() {
                b = b.header("x-goog-api-key", api_key);
            }
            b
        }
        ProtocolKind::OpenAiChat | ProtocolKind::OpenAiResponses => {
            let mut b = client.get(url);
            if !api_key.trim().is_empty() {
                b = b.header(AUTHORIZATION, format!("Bearer {api_key}"));
            }
            b
        }
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
) -> Result<ProbePingResult, CoreError> {
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
) -> Result<ProbeScanResult, CoreError> {
    Ok(probe_scan_models_core(ProbeScanRequest {
        profile_id,
        timeout_ms,
    })
    .await)
}

#[cfg(test)]
mod tests;
