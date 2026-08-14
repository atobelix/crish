//! 多 profile 引擎侧投影（多模型适配战役 R5 T5.2a · G3 收敛）。
//!
//! 断链根因（00-问题基线.md G3 修正段）：前端 `providerProfiles` 多 profile 已就位
//! （`profileCatalog.ts` 预置 `opencode-go` → `https://opencode.ai/zen/go/v1` +
//! `deepseek-v4-flash`），但引擎侧 `ApiConfigStore` 是单提供方投影——每次
//! `config_profile_apply` 都覆盖同一生效槽（base_url/model 落单全局 store），
//! profileId 只作用于密钥槽（`secrets/{profileId}.dpapi`），端点/模型互不复用。
//!
//! 本模块承载多提供方**投影**：把「活跃 profileId → 每 profile 独立端点/模型/
//! 凭据」持久化到独立 `profile-config.json`（不触碰既有扁平
//! `provider-config.json`，避免破坏 `config_get` / `config_update` 单轨旧路径），
//! 并经 [resolve_active_context] 解析成引擎生效三件套。`ApiConfigStore` 的
//! `effective_*` 函数族在活跃 profile 就绪时优先投影 profile（对齐 C2 的
//! per-provider 语义），否则回退既有单轨（引擎既有测试零改动）。
//!
//! 对齐 C2 契约（round1-小结.md）：`providers` 映射键 = profileId；无引用凭据落
//! `secrets/{provider_id}.dpapi`；env 预留 `{P}_*` 前缀回退（投影面以运行时写
//! 入为准，env 面由 `ProviderConfigStore`（crates）承载）。本模块只做壳侧投影，
//! 不改 `crates/`（主控纪律）。

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
};

use serde::{Deserialize, Serialize};

use conex_types::CoreError;

use super::persistence::{config_dir, profile_secret_path, sanitize_profile_secret_id};
use super::resolution::normalize_provider_endpoint;
use super::with_profile_secrets;

/// 每 profile 的非敏感生效配置（敏感 apiKey 不入本结构，落 `secrets/{id}.dpapi`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileConfig {
    /// 服务端基础地址（必填：三件套之一）。
    pub(crate) base_url: Option<String>,
    /// 模型名（必填：三件套之一）。
    pub(crate) model: Option<String>,
    /// 端点（chat-completions / responses / auto；None = 默认 chat-completions，00 D3）。
    pub(crate) endpoint: Option<String>,
    /// 是否流式（None = 默认 true）。
    pub(crate) stream: Option<bool>,
}

/// profile 状态持久化载荷（独立 `profile-config.json`，与扁平单轨文件隔离）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedProfileState {
    /// 当前活跃 profileId（None = 未启用 profile，回退单轨旧路径）。
    pub(crate) active_profile_id: Option<String>,
    /// profileId → 每 profile 生效端点/模型（多提供方并存，互不复用）。
    pub(crate) profiles: BTreeMap<String, ProfileConfig>,
}

impl PersistedProfileState {
    fn config_path() -> PathBuf {
        config_dir().join("profile-config.json")
    }

    pub(crate) fn load() -> Self {
        let path = Self::config_path();
        match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create profile config directory: {error}"))?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self)
            .map_err(|error| format!("Failed to encode profile config: {error}"))?;
        fs::write(&tmp, format!("{text}\n"))
            .map_err(|error| format!("Failed to write profile config: {error}"))?;
        fs::rename(&tmp, path)
            .map_err(|error| format!("Failed to replace profile config: {error}"))?;
        Ok(())
    }
}

/// 解析出的活跃 profile 生效上下文（引擎 provider 三件套 + 端点/流式）。
#[derive(Debug, Clone)]
pub(crate) struct ActiveProviderContext {
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) endpoint: String,
    pub(crate) stream: bool,
}

/// 读取指定 profile 的 DPAPI 密钥（无密钥或缺失 → None；与 `config_profile_apply`
/// 的密钥槽读取同源，见 credentials.rs 密钥槽命令）。
pub(crate) fn read_profile_key(profile_id: &str) -> Result<Option<String>, String> {
    let path = profile_secret_path(profile_id)?;
    with_profile_secrets(|store| {
        store.read(&path).map_err(|error| {
            CoreError::Internal(format!(
                "Failed to read profile secret ({profile_id}): {error}"
            ))
        })
    })
    .map_err(|error| error.to_string())
    .map(|value| value.filter(|value| !value.is_empty()))
}

/// 把 profile 配置应用到状态并持久化（config_profile_apply 消费）。仅存非敏感
/// 端点/模型；apiKey 走 `config_secret_set` 落 DPAPI 槽（壳命令面既有路径）。
pub(crate) fn apply_profile_config(
    state: &mut PersistedProfileState,
    profile_id: &str,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let id = sanitize_profile_secret_id(profile_id)?;
    // 活跃 profile = 最近应用者（UI 切换语义：apply 即激活）。
    state.active_profile_id = Some(id.clone());
    let entry = state.profiles.entry(id).or_default();
    // 只覆盖传入字段（merge，不 clobber 未传字段——saveProfileBaseUrl 只传
    // baseUrl、activateProfileModel 传 baseUrl+model、saveProfileKey 传 key）。
    if let Some(url) = base_url.map(|value| value.trim().to_string()).filter(|v| !v.is_empty()) {
        entry.base_url = Some(url);
    }
    if let Some(model) = model.map(|value| value.trim().to_string()).filter(|v| !v.is_empty()) {
        entry.model = Some(model);
    }
    state.save()
}

/// 清除活跃 profile（config_update 手动轨写 baseUrl/model 时切回单轨语义）。
pub(crate) fn clear_active_profile(state: &mut PersistedProfileState) -> Result<(), String> {
    if state.active_profile_id.is_none() {
        return Ok(());
    }
    state.active_profile_id = None;
    state.save()
}

/// 解析活跃 profile 生效上下文：活跃 profile 且 base_url/model/key 三件套齐备
/// → Some；任一缺失 → None（引擎保持未就绪/回退单轨，与旧降级语义一致）。
pub(crate) fn resolve_active_context(
    state: &PersistedProfileState,
) -> Result<Option<ActiveProviderContext>, String> {
    let active = match state.active_profile_id.as_deref() {
        Some(id) => id,
        None => return Ok(None),
    };
    let config = match state.profiles.get(active) {
        Some(config) => config,
        // 持久化里已无该 profile（容错）：视为未启用，回退单轨不报错。
        None => return Ok(None),
    };
    let base_url = config
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty());
    let model = config
        .model
        .clone()
        .filter(|value| !value.trim().is_empty());
    if base_url.is_none() || model.is_none() {
        return Ok(None);
    }
    let api_key = read_profile_key(active)?.filter(|key| !key.is_empty());
    // 三件套任一缺失 → 未就绪（对齐 load_provider_endpoint 降级语义）。
    let (base_url, model, api_key) = match (base_url, model, api_key) {
        (Some(base_url), Some(model), Some(api_key)) => (base_url, model, api_key),
        _ => return Ok(None),
    };
    let endpoint = config
        .endpoint
        .clone()
        .and_then(normalize_provider_endpoint)
        .unwrap_or_else(|| "chat-completions".to_string());
    Ok(Some(ActiveProviderContext {
        base_url,
        api_key,
        model,
        endpoint,
        stream: config.stream.unwrap_or(true),
    }))
}

/// 构建 config_get 快照的 providers 清单（多提供方并存展示；K-02 不含明文）。
pub(crate) fn snapshot_providers(state: &PersistedProfileState) -> Vec<serde_json::Value> {
    let active = state.active_profile_id.as_deref();
    let mut providers: Vec<serde_json::Value> = state
        .profiles
        .iter()
        .map(|(id, config)| {
            serde_json::json!({
                "profileId": id,
                "baseUrl": config.base_url.as_deref().unwrap_or(""),
                "model": config.model.as_deref().unwrap_or(""),
                "endpoint": config.endpoint.as_deref().unwrap_or("chat-completions"),
                "active": active == Some(id.as_str()),
            })
        })
        .collect();
    // 活跃 profile 已含在映射；确保映射至少包含活跃条目（容错兜底）。
    if providers.is_empty() {
        if let Some(active) = active {
            providers.push(serde_json::json!({
                "profileId": active,
                "baseUrl": "",
                "model": "",
                "endpoint": "chat-completions",
                "active": true,
            }));
        }
    }
    providers
}

/// 测试面：从磁盘重载 profile 状态（写入隔离临时目录后的持久化断言用）。
#[cfg(test)]
pub(crate) fn reload_state() -> PersistedProfileState {
    PersistedProfileState::load()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_run_commands::{isolate_config_store, CONFIG_TEST_LOCK};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "crish-profile-test-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn apply_then_resolve_uses_profile_endpoint_and_key() {
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).expect("create dir");
        isolate_config_store(&dir);

        // 先落密钥槽（read_profile_key 读取 secrets/{id}.dpapi）
        super::super::credentials::config_secret_set(
            "opencode-go".to_string(),
            "sk-opencode".to_string(),
        )
        .expect("set key");

        let mut state = PersistedProfileState::default();
        apply_profile_config(
            &mut state,
            "opencode-go",
            Some("https://opencode.ai/zen/go/v1".to_string()),
            Some("deepseek-v4-flash".to_string()),
        )
        .expect("apply opencode-go");

        let context = resolve_active_context(&state)
            .expect("resolve")
            .expect("active profile 就绪");
        assert_eq!(context.base_url, "https://opencode.ai/zen/go/v1");
        assert_eq!(context.model, "deepseek-v4-flash");
        assert_eq!(context.api_key, "sk-opencode");
        // 未显式端点 → 默认 chat-completions（00 D3，opencode-go → chat 轨）。
        assert_eq!(context.endpoint, "chat-completions");
        assert!(context.stream);
    }

    #[test]
    fn multi_profile_isolation_switch_preserves_each() {
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).expect("create dir");
        isolate_config_store(&dir);

        super::super::credentials::config_secret_set("profile-a".to_string(), "sk-a".to_string())
            .expect("set a key");
        super::super::credentials::config_secret_set("profile-b".to_string(), "sk-b".to_string())
            .expect("set b key");

        let mut state = PersistedProfileState::default();
        apply_profile_config(
            &mut state,
            "profile-a",
            Some("https://a.example/v1".to_string()),
            Some("model-a".to_string()),
        )
        .expect("apply a");
        apply_profile_config(
            &mut state,
            "profile-b",
            Some("https://b.example/v1".to_string()),
            Some("model-b".to_string()),
        )
        .expect("apply b");

        // 活跃 = b；a 的映射保留（互不串扰）。
        assert_eq!(state.active_profile_id.as_deref(), Some("profile-b"));
        let context = resolve_active_context(&state)
            .expect("resolve")
            .expect("b 就绪");
        assert_eq!(context.base_url, "https://b.example/v1");
        assert_eq!(context.model, "model-b");
        assert_eq!(context.api_key, "sk-b");

        // 切回 a：a 的端点/模型/凭据独立恢复。
        apply_profile_config(
            &mut state,
            "profile-a",
            Some("https://a.example/v1".to_string()),
            Some("model-a".to_string()),
        )
        .expect("reapply a");
        let context = resolve_active_context(&state)
            .expect("resolve")
            .expect("a 就绪");
        assert_eq!(context.base_url, "https://a.example/v1");
        assert_eq!(context.model, "model-a");
        assert_eq!(context.api_key, "sk-a");
        // b 的映射仍在（不丢失）。
        assert!(state.profiles.contains_key("profile-b"));
    }

    #[test]
    fn persist_roundtrip_keeps_profiles_and_active() {
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).expect("create dir");
        isolate_config_store(&dir);

        let mut state = PersistedProfileState::default();
        apply_profile_config(
            &mut state,
            "opencode-go",
            Some("https://opencode.ai/zen/go/v1".to_string()),
            Some("deepseek-v4-flash".to_string()),
        )
        .expect("apply opencode-go");
        state.save().expect("save");

        // 从磁盘重载（同一隔离目录）：映射与活跃 id 持久化。
        let reloaded = reload_state();
        assert_eq!(
            reloaded.active_profile_id.as_deref(),
            Some("opencode-go")
        );
        let entry = reloaded
            .profiles
            .get("opencode-go")
            .expect("opencode-go 条目");
        assert_eq!(entry.base_url.as_deref(), Some("https://opencode.ai/zen/go/v1"));
        assert_eq!(entry.model.as_deref(), Some("deepseek-v4-flash"));
    }

    #[test]
    fn snapshot_providers_exposes_active_and_configured() {
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = PersistedProfileState::default();
        apply_profile_config(
            &mut state,
            "opencode-go",
            Some("https://opencode.ai/zen/go/v1".to_string()),
            Some("deepseek-v4-flash".to_string()),
        )
        .expect("apply opencode-go");
        apply_profile_config(
            &mut state,
            "deepseek",
            Some("https://api.deepseek.com".to_string()),
            Some("deepseek-chat".to_string()),
        )
        .expect("apply deepseek");

        let providers = snapshot_providers(&state);
        // 两提供方并存（I2：Tauri 壳 config 快照 ≥2 提供方）。
        assert_eq!(providers.len(), 2);
        let active_ids: Vec<&str> = providers
            .iter()
            .filter(|p| p["active"].as_bool().unwrap_or(false))
            .map(|p| p["profileId"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(active_ids, vec!["deepseek"], "最近应用者为活跃");
    }
}

