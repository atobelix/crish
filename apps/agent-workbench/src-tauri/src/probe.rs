//! 原生服务商连通性探活与模型扫描模块（Batch 1 · G3 独立模块）。
//!
//! 职责与安全特性：
//! - `provider_probe_ping`：底层直接读取 DPAPI 密钥（`read_profile_key`），
//!   发起轻量 HTTP 请求进行连通性检查与毫秒级 RTT 延迟测量，非崩溃型返回；
//! - `provider_probe_scan_models`：底层携带 DPAPI 密钥直接请求 `GET /models`，
//!   解析模型列表并自动合并至 `ModelCatalog`（`upsert_from_scan`），同时将
//!   模型列表持久化到 `profile-config.json`；
//! - 凭据安全：前端冷启动与运行期无需在内存保留明文 API Key，零明文泄露。

use std::{
    collections::HashSet,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use agent_provider::models::{ModelCatalog, ScannedModel};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::{persistence::load_profiles_config, profile::read_profile_key};

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

#[derive(Debug, Clone)]
struct ProbeTarget {
    display_name: String,
    base_url: String,
    endpoint_type: String,
    model_to_test: String,
}

fn resolve_probe_target(
    profile_id: &str,
    requested_model: Option<&str>,
) -> Result<ProbeTarget, (u16, String)> {
    let state = load_profiles_config();
    let live = crate::engine_provider::protocol::live_catalog();

    let state_profile = state.profiles.get(profile_id);
    let live_provider = live.tree.providers.get(profile_id);

    if state_profile.is_none() && live_provider.is_none() {
        return Err((404, format!("未找到服务商配置 [{profile_id}]")));
    }

    let display_name = live_provider
        .and_then(|p| p.display_name.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| profile_id.to_string());

    let base_url = live_provider
        .and_then(|p| p.base_url.clone())
        .or_else(|| state_profile.and_then(|p| p.base_url.clone()))
        .filter(|s| !s.trim().is_empty());

    let base_url = match base_url {
        Some(u) => u.trim().trim_end_matches('/').to_string(),
        None => {
            return Err((400, format!("服务商 [{display_name}] 未配置 Base URL 地址")));
        }
    };

    let endpoint_type = live_provider
        .map(|p| match p.protocol {
            agent_provider::models::ProtocolKind::AnthropicMessages => "anthropic".to_string(),
            agent_provider::models::ProtocolKind::GoogleGenerateContent => "gemini".to_string(),
            agent_provider::models::ProtocolKind::OpenAiResponses => "responses".to_string(),
            _ => "chat-completions".to_string(),
        })
        .or_else(|| state_profile.and_then(|p| p.endpoint.clone()))
        .unwrap_or_else(|| "chat-completions".to_string());

    let model_to_test = requested_model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .or_else(|| live_provider.and_then(|p| p.models.first().map(|m| m.id.clone())))
        .or_else(|| state_profile.and_then(|p| p.model.clone()))
        .or_else(|| state_profile.and_then(|p| p.models.first().cloned()))
        .unwrap_or_else(|| "deepseek-chat".to_string());

    Ok(ProbeTarget {
        display_name,
        base_url,
        endpoint_type,
        model_to_test,
    })
}

/// 原生探活核心逻辑
pub async fn probe_ping_core(req: ProbePingRequest) -> ProbePingResult {
    let profile_id = req.profile_id.trim();
    if profile_id.is_empty() {
        return ProbePingResult {
            ok: false,
            latency_ms: None,
            status_code: Some(400),
            error: Some("profile_id 不能为空".to_string()),
        };
    }

    let target = match resolve_probe_target(profile_id, req.model.as_deref()) {
        Ok(t) => t,
        Err((code, err)) => {
            return ProbePingResult {
                ok: false,
                latency_ms: None,
                status_code: Some(code),
                error: Some(err),
            };
        }
    };

    // 读取 DPAPI 密钥（若 DPAPI 缺失，支持回退到 live_catalog 中的配置密钥）
    let api_key = match read_profile_key(profile_id) {
        Ok(Some(k)) if !k.trim().is_empty() => Some(k.trim().to_string()),
        _ => crate::engine_provider::protocol::live_catalog()
            .tree
            .providers
            .get(profile_id)
            .and_then(|p| p.api_key.clone())
            .filter(|k| !k.trim().is_empty()),
    };

    let api_key = match api_key {
        Some(k) => k,
        None => {
            return ProbePingResult {
                ok: false,
                latency_ms: None,
                status_code: Some(401),
                error: Some(format!(
                    "服务商 [{}] 未配置 API Key，请先输入密钥并保存",
                    target.display_name
                )),
            };
        }
    };

    let timeout_duration = Duration::from_millis(req.timeout_ms.unwrap_or(15000));
    let client = match reqwest::Client::builder().timeout(timeout_duration).build() {
        Ok(c) => c,
        Err(e) => {
            return ProbePingResult {
                ok: false,
                latency_ms: None,
                status_code: Some(500),
                error: Some(format!("构建 HTTP 客户端失败: {e}")),
            };
        }
    };

    let req_builder = match target.endpoint_type.as_str() {
        "anthropic" => {
            let url = agent_provider::request::build_endpoint_url(
                agent_provider::models::ProtocolKind::AnthropicMessages,
                &target.base_url,
            );
            let mut headers = HeaderMap::new();
            if let Ok(val) = HeaderValue::from_str(&api_key) {
                headers.insert("x-api-key", val);
            }
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            let body = serde_json::json!({
                "model": target.model_to_test,
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 1
            });
            client.post(url).headers(headers).json(&body)
        }
        "gemini" => {
            let base_url = target.base_url.trim_end_matches('/');
            // 优先 header x-goog-api-key（与生产轨 gemini_request_headers 同规），
            // 避免 key 拼进 query 进访问日志；Gemini 官方与兼容网关均支持该头。
            let url = format!(
                "{base_url}/v1beta/models/{}:generateContent",
                target.model_to_test
            );
            let body = serde_json::json!({
                "contents": [{"parts": [{"text": "hi"}]}],
                "generationConfig": {"maxOutputTokens": 1}
            });
            client
                .post(url)
                .header("x-goog-api-key", &api_key)
                .header(CONTENT_TYPE, "application/json")
                .json(&body)
        }
        _ => {
            // 默认 OpenAI / DeepSeek / ChatCompletions
            let url = agent_provider::request::build_endpoint_url(
                agent_provider::models::ProtocolKind::OpenAiChat,
                &target.base_url,
            );
            let mut headers = HeaderMap::new();
            if let Ok(val) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
                headers.insert(AUTHORIZATION, val);
            }
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            let body = serde_json::json!({
                "model": target.model_to_test,
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 1
            });
            client.post(url).headers(headers).json(&body)
        }
    };

    let started = Instant::now();
    let retry_clone = req_builder.try_clone();
    let resp_res = match req_builder.send().await {
        Ok(resp) if resp.status().as_u16() == 429 => {
            if let Some(retry) = retry_clone {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                retry.send().await
            } else {
                Ok(resp)
            }
        }
        other => other,
    };

    match resp_res {
        Ok(resp) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            let status_code = resp.status().as_u16();
            if resp.status().is_success() {
                ProbePingResult {
                    ok: true,
                    latency_ms: Some(latency_ms),
                    status_code: Some(status_code),
                    error: None,
                }
            } else if status_code == 429 {
                // HTTP 429 表明网络已连通、Base URL 与 API Key 均鉴权通过，仅触发服务商 TPM/RPM 限流
                ProbePingResult {
                    ok: true,
                    latency_ms: Some(latency_ms),
                    status_code: Some(status_code),
                    error: None,
                }
            } else {
                let err_text = resp.text().await.unwrap_or_default();
                let short_err = if err_text.chars().count() > 200 {
                    let truncated: String = err_text.chars().take(200).collect();
                    format!("{truncated}...")
                } else {
                    err_text
                };
                ProbePingResult {
                    ok: false,
                    latency_ms: Some(latency_ms),
                    status_code: Some(status_code),
                    error: Some(format!("服务端响应异常 (HTTP {status_code}): {short_err}")),
                }
            }
        }
        Err(err) => {
            let latency_ms = started.elapsed().as_millis() as u64;
            let error_msg = if err.is_timeout() {
                format!("连接超时 (超过 {}ms)", timeout_duration.as_millis())
            } else if err.is_connect() {
                "无法连接到服务端，请检查 Base URL 与网络连接".to_string()
            } else {
                format!("网络请求失败: {err}")
            };
            ProbePingResult {
                ok: false,
                latency_ms: Some(latency_ms),
                status_code: None,
                error: Some(error_msg),
            }
        }
    }
}

/// 模型扫描核心逻辑
pub async fn probe_scan_models_core(
    req: ProbeScanRequest,
    catalog: Option<Arc<RwLock<ModelCatalog>>>,
) -> ProbeScanResult {
    let profile_id = req.profile_id.trim();
    if profile_id.is_empty() {
        return ProbeScanResult {
            ok: false,
            models: vec![],
            error: Some("profile_id 不能为空".to_string()),
        };
    }

    let target = match resolve_probe_target(profile_id, None) {
        Ok(t) => t,
        Err((_code, err)) => {
            return ProbeScanResult {
                ok: false,
                models: vec![],
                error: Some(err),
            };
        }
    };

    let api_key = match read_profile_key(profile_id) {
        Ok(Some(k)) if !k.trim().is_empty() => Some(k.trim().to_string()),
        _ => crate::engine_provider::protocol::live_catalog()
            .tree
            .providers
            .get(profile_id)
            .and_then(|p| p.api_key.clone())
            .filter(|k| !k.trim().is_empty()),
    };

    let api_key = match api_key {
        Some(k) => k,
        None => {
            return ProbeScanResult {
                ok: false,
                models: vec![],
                error: Some(format!(
                    "服务商 [{}] 未配置 API Key，请先保存密钥后再扫描",
                    target.display_name
                )),
            };
        }
    };

    let timeout_duration = Duration::from_millis(req.timeout_ms.unwrap_or(15000));
    let client = match reqwest::Client::builder().timeout(timeout_duration).build() {
        Ok(c) => c,
        Err(e) => {
            return ProbeScanResult {
                ok: false,
                models: vec![],
                error: Some(format!("构建 HTTP 客户端失败: {e}")),
            };
        }
    };

    let req_builder = match target.endpoint_type.as_str() {
        "anthropic" => {
            let base_url = target.base_url.trim_end_matches('/');
            let url = if base_url.ends_with("/v1/models") || base_url.ends_with("/models") {
                base_url.to_string()
            } else if base_url.ends_with("/v1") {
                format!("{base_url}/models")
            } else {
                format!("{base_url}/v1/models")
            };
            client
                .get(url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
        }
        "gemini" => {
            let base_url = target.base_url.trim_end_matches('/');
            // 与探活同轨：header x-goog-api-key，key 不进 query / 访问日志。
            let url = format!("{base_url}/v1beta/models");
            client.get(url).header("x-goog-api-key", &api_key)
        }
        _ => {
            let base_url = target.base_url.trim_end_matches('/');
            let url = if base_url.ends_with("/models") {
                base_url.to_string()
            } else if base_url.ends_with("/v1") {
                format!("{base_url}/models")
            } else if base_url.ends_with("openai.com") || base_url.contains("sensenova.cn") {
                format!("{base_url}/v1/models")
            } else {
                format!("{base_url}/models")
            };
            client
                .get(url)
                .header(AUTHORIZATION, format!("Bearer {api_key}"))
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

    // 1. 同步合并至 ModelCatalog 内存真源
    if let Some(cat_arc) = catalog {
        if let Ok(mut cat) = cat_arc.write() {
            cat.upsert_from_scan(profile_id, &scanned_entries);
        }
    }

    // 2. 更新 profile-config.json 中的 models 映射
    let mut state = load_profiles_config();
    let p = state.profiles.entry(profile_id.to_string()).or_insert_with(|| {
        crate::config::profile::ProfileConfig {
            base_url: Some(target.base_url.clone()),
            endpoint: Some(target.endpoint_type.clone()),
            model: Some(target.model_to_test.clone()),
            stream: Some(true),
            models: vec![],
        }
    });
    let mut changed = false;
    for m in &scanned_entries {
        if !p.models.contains(&m.model) {
            p.models.push(m.model.clone());
            changed = true;
        }
    }
    if changed {
        let _ = state.save();
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
    catalog: State<'_, Arc<RwLock<ModelCatalog>>>,
) -> Result<ProbeScanResult, String> {
    Ok(probe_scan_models_core(
        ProbeScanRequest {
            profile_id,
            timeout_ms,
        },
        Some(catalog.inner().clone()),
    )
    .await)
}

#[cfg(test)]
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

    #[tokio::test]
    async fn probe_ping_empty_profile_id_returns_error() {
        let res = probe_ping_core(ProbePingRequest {
            profile_id: "".to_string(),
            model: None,
            timeout_ms: None,
        })
        .await;

        assert!(!res.ok);
        assert_eq!(res.status_code, Some(400));
        assert!(res.error.is_some());
    }

    #[tokio::test]
    async fn probe_ping_nonexistent_profile_returns_404() {
        let res = probe_ping_core(ProbePingRequest {
            profile_id: "nonexistent-profile-xyz-12345".to_string(),
            model: None,
            timeout_ms: None,
        })
        .await;

        assert!(!res.ok);
        assert_eq!(res.status_code, Some(404));
        assert!(res.error.unwrap().contains("未找到服务商配置"));
    }

    #[tokio::test]
    async fn probe_scan_models_nonexistent_profile_returns_error() {
        let res = probe_scan_models_core(
            ProbeScanRequest {
                profile_id: "nonexistent-profile-xyz-12345".to_string(),
                timeout_ms: None,
            },
            None,
        )
        .await;

        assert!(!res.ok);
        assert!(res.models.is_empty());
        assert!(res.error.unwrap().contains("未找到服务商配置"));
    }

    #[tokio::test]
    async fn probe_ping_and_scan_with_local_mock_server() {
        use axum::{
            routing::{get, post},
            Json, Router,
        };
        use std::net::SocketAddr;
        use tokio::net::TcpListener;

        let app = Router::new()
            .route(
                "/chat/completions",
                post(|| async {
                    Json(serde_json::json!({
                        "id": "chatcmpl-test",
                        "choices": [{"message": {"role": "assistant", "content": "hello"}}]
                    }))
                }),
            )
            .route(
                "/models",
                get(|| async {
                    Json(serde_json::json!({
                        "data": [
                            {"id": "mock-model-1", "context_window": 32000},
                            {"id": "mock-model-2", "context_window": 64000}
                        ]
                    }))
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        // 构造临时测试目录与隔离 Profile
        let test_dir =
            std::env::temp_dir().join(format!("crish-probe-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&test_dir);
        let prev_config_dir = std::env::var("CRISH_WORKBENCH_CONFIG_DIR").ok();
        std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", &test_dir);

        let profile_id = "test-mock-provider";
        let base_url = format!("http://{}", addr);

        // 写入 profile 配置
        let mut state = crate::config::profile::PersistedProfileState::load();
        let _ = crate::config::profile::apply_profile_config(
            &mut state,
            profile_id,
            Some(base_url.clone()),
            Some("mock-model-1".to_string()),
        );

        // 写入 profile secret key
        let _ =
            crate::config::config_secret_set(profile_id.to_string(), "mock-api-key".to_string());

        // 1. 测试 probe_ping_core
        let ping_res = probe_ping_core(ProbePingRequest {
            profile_id: profile_id.to_string(),
            model: Some("mock-model-1".to_string()),
            timeout_ms: Some(2000),
        })
        .await;

        assert!(ping_res.ok, "ping 应成功返回 ok=true: {:?}", ping_res.error);
        assert_eq!(ping_res.status_code, Some(200));
        assert!(ping_res.latency_ms.is_some());
        assert!(ping_res.error.is_none());

        // 2. 测试 probe_scan_models_core 并验证 ModelCatalog 合并
        let catalog = Arc::new(RwLock::new(ModelCatalog::bundled()));
        let initial_version = catalog.read().unwrap().version();

        let scan_res = probe_scan_models_core(
            ProbeScanRequest {
                profile_id: profile_id.to_string(),
                timeout_ms: Some(2000),
            },
            Some(catalog.clone()),
        )
        .await;

        assert!(scan_res.ok, "scan 应成功返回 ok=true: {:?}", scan_res.error);
        assert_eq!(scan_res.models.len(), 2);
        assert_eq!(scan_res.models[0].model, "mock-model-1");
        assert_eq!(scan_res.models[1].model, "mock-model-2");

        let updated_version = catalog.read().unwrap().version();
        assert!(
            updated_version > initial_version,
            "扫描后 catalog version 应递增 (from {initial_version} to {updated_version})"
        );

        // 清理环境
        if let Some(prev) = prev_config_dir {
            std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", prev);
        } else {
            std::env::remove_var("CRISH_WORKBENCH_CONFIG_DIR");
        }
        let _ = std::fs::remove_dir_all(&test_dir);
    }

    #[test]
    fn resolve_probe_target_prefers_live_provider_catalog() {
        let yaml = r#"
version: 2
providers:
  test-sensenova:
    displayName: senseNova
    baseUrl: https://token.sensenova.cn/v1
    protocol: openai/chat
    models:
      - id: deepseek-v4-flash
"#;
        crate::engine_provider::protocol::reload_live_catalog_from_yaml_str(yaml).unwrap();
        let target = resolve_probe_target("test-sensenova", None).expect("target should resolve");
        assert_eq!(target.display_name, "senseNova");
        assert_eq!(target.base_url, "https://token.sensenova.cn/v1");
        assert_eq!(target.model_to_test, "deepseek-v4-flash");
        assert_eq!(target.endpoint_type, "chat-completions");
    }
}
