//! 模型字典真源（`~/.conex/models.yaml`）：读（缺则播种）/ 校验 / 原子保存。
//!
//! 真源裁决：磁盘 YAML 是全系统模型字典的绝对唯一真源；前端持有的只是
//! 本模块解析产物的只读镜像。解析只在 Rust（serde_yaml）发生，前端不重复实现。
//!
//! 设计要点：
//! - 路径归 Rust 所有（`USERPROFILE`/`HOME` + `.conex/models.yaml`），命令不收
//!   前端路径参数，杜绝路径注入；
//! - 首次读取文件缺失 → `include_str!` 模板经 `conex_fs::atomic_write_file` 播种
//!   （幂等：文件存在即不播种）；
//! - 写入统一走 conex-fs 原子写事务（临时文件 → 替换 → `.bak` 回滚位）；
//! - 校验错误携带行/列号，经 `CoreError::InvalidInput` 或结构化诊断透传前端；
//! - 读/校验/保存与 live_catalog 共用 `UnifiedModelsConfig::from_yaml_str`；
//!   旧键只在该读边界认一次。v1 扁平升级仍在 ConfigMigrationManager。

use agent_provider::migration::{ConfigMigrationManager, MigrationStatus};
use agent_provider::models::{
    CompatSpec, CurrencyKind, ModalitiesSpec, ModelPricingSpec, ModelSpec, ProtocolKind,
    ProviderSpec, UnifiedModelsConfig, YamlParseError,
};
use conex_types::CoreError;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 磁盘真源文件名（位于 `~/.conex/` 下）
pub(crate) const MODELS_YAML_FILENAME: &str = "models.yaml";

/// 内置模板（数据来源：`docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`）
const DEFAULT_MODELS_YAML: &str = include_str!("models.default.yaml");

// ===== Schema（serde camelCase 对齐前端 TS 镜像类型 / catalog_types）=====

/// 与内核 `ProtocolKind` 同一枚举：写出 `google/generate-content`，读可认 `google/interactions`。
pub type ModelsYamlProtocol = ProtocolKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelsYamlBillingUnit {
    Token,
    PerImage,
}

/// 与内核 `CurrencyKind` 同构（写出 `USD` / `CNY`）。
pub type ModelsYamlCurrency = CurrencyKind;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelsYamlCapabilities {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tools: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub image: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub video: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reasoning: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelsYamlPricing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_per_m_tok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_per_m_tok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_per_m_tok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_per_m_tok: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing_unit: Option<ModelsYamlBillingUnit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_image_cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<ModelsYamlCurrency>,
}

/// lossy 扁平投影（v1 / 调试）：不含 thinking、modalities、compat、供应商 baseUrl/apiKey/headers。
/// 禁止任何新代码把它当思考或模态真源；真源只在 `providers` 树。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelsYamlModel {
    /// 模型标识（必填，全表唯一）
    pub model: String,
    /// 供应商标识（必填）
    pub vendor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ModelsYamlProtocol>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelsYamlCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelsYamlPricing>,
}

/// v2 价格 DTO：从内核 `ModelPricingSpec` 投影。旧键只在 `UnifiedModelsConfig::from_yaml_str` 读边界认一次。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsYamlPricingV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<ModelsYamlCurrency>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "inputPerMTok",
        alias = "input_per_m_tok"
    )]
    pub input: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "outputPerMTok",
        alias = "output_per_m_tok"
    )]
    pub output: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "cacheReadPerMTok",
        alias = "cache_read_per_m_tok"
    )]
    pub cache_read: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "cacheWritePerMTok",
        alias = "cache_write_per_m_tok"
    )]
    pub cache_write: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "perImageCost",
        alias = "per_image_cost"
    )]
    pub per_image: Option<f64>,
}

/// v2 模型节点：与 §4.1 / `ModelSpec` serde 同构（yaml 侧字段可缺省，不发明 128K）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsYamlModelV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// 仅读边界：与 `id` 二选一。写出跳过，IPC 只发 `id`。
    #[serde(default, skip_serializing)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ModelsYamlProtocol>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "contextLength"
    )]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    /// TitleCase → wire 保序字典，与 `ModelSpec.thinking` 同构。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelsYamlPricingV2>,
    /// 直接复用内核 `ModalitiesSpec`，禁止再复制一套 `{image,video}` 布尔结构。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModalitiesSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelsYamlCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatSpec>,
}

/// v2 供应商节点：与 §4.1 / `ProviderSpec` serde 同构（headers / compat / 凭据均保留）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsYamlProviderV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ModelsYamlProtocol>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<IndexMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelsYamlModelV2>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedModelsYaml {
    pub version: Option<u32>,
    pub providers: Option<IndexMap<String, ModelsYamlProviderV2>>,
    pub models: Vec<ModelsYamlModel>,
}

// ===== IPC 结果 DTO =====

/// 结构化诊断（行/列号可能缺省——语义级错误无位置信息）
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsYamlDiagnostic {
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadModelsYamlResult {
    pub path: String,
    pub content: String,
    /// lossy 扁平投影，禁止生产消费（无 thinking/modalities/baseUrl/apiKey）。真源是 `providers`。
    pub models: Vec<ModelsYamlModel>,
    /// 内置模板原文（「恢复标准模版」单一来源）
    pub template: String,
    /// 本次读取是否触发了播种
    pub seeded: bool,
    /// 磁盘内容解析失败时的诊断（content 原样返回，编辑器可修复后保存）
    pub parse_error: Option<ModelsYamlDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// 与 §4.1 树同构的 v2 providers（camelCase）。解析失败为 `None`；空文件为 `Some({})`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<IndexMap<String, ModelsYamlProviderV2>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateModelsYamlResult {
    pub valid: bool,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsYamlResult {
    pub path: String,
    /// lossy 扁平投影，禁止生产消费。镜像校验请读 `providers`。
    pub models: Vec<ModelsYamlModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// 与 §4.1 树同构的 v2 providers（camelCase）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<IndexMap<String, ModelsYamlProviderV2>>,
}

// ===== 路径解析 =====

fn user_home_dir() -> Result<PathBuf, CoreError> {
    std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .ok_or_else(|| CoreError::Io("无法定位用户主目录（USERPROFILE/HOME 均未设置）".into()))
}

fn models_yaml_path() -> Result<PathBuf, CoreError> {
    Ok(user_home_dir()?.join(".conex").join(MODELS_YAML_FILENAME))
}

// ===== 解析与校验 =====

fn yaml_parse_error_to_diagnostic(err: YamlParseError) -> ModelsYamlDiagnostic {
    ModelsYamlDiagnostic {
        line: err.line,
        column: err.column,
        message: err.message,
    }
}

/// 解析 + 语义校验：与 live_catalog / `reload_live_catalog` 共用
/// [UnifiedModelsConfig::from_yaml_str_detailed]。DTO 从内核树投影，禁止第二套 serde。
///
/// v1 扁平 `models` 在此为 Err（不在 live 里静默升级）；升级仍在
/// `ConfigMigrationManager::ensure_migrated` / IPC 读路径。
fn parse_models_yaml(content: &str) -> Result<ParsedModelsYaml, ModelsYamlDiagnostic> {
    let tree = UnifiedModelsConfig::from_yaml_str_detailed(content)
        .map_err(yaml_parse_error_to_diagnostic)?;
    Ok(project_unified_to_parsed(&tree))
}

fn project_unified_to_parsed(tree: &UnifiedModelsConfig) -> ParsedModelsYaml {
    let mut flattened_models = Vec::new();
    let mut providers = IndexMap::new();
    for (provider_id, provider) in &tree.providers {
        for model in &provider.models {
            flattened_models.push(flatten_model_lossy(provider_id, provider, model));
        }
        providers.insert(provider_id.clone(), project_provider_v2(provider));
    }
    ParsedModelsYaml {
        version: Some(tree.version),
        providers: Some(providers),
        models: flattened_models,
    }
}

fn project_provider_v2(provider: &ProviderSpec) -> ModelsYamlProviderV2 {
    ModelsYamlProviderV2 {
        display_name: provider.display_name.clone(),
        base_url: provider.base_url.clone(),
        protocol: Some(provider.protocol),
        api_key: provider.api_key.clone(),
        headers: provider.headers.clone(),
        compat: provider.compat.clone(),
        models: provider.models.iter().map(project_model_v2).collect(),
    }
}

fn project_model_v2(model: &ModelSpec) -> ModelsYamlModelV2 {
    ModelsYamlModelV2 {
        id: Some(model.id.clone()),
        model: None,
        display_name: model.display_name.clone(),
        protocol: model.protocol,
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
        thinking: model.thinking.clone(),
        pricing: model.pricing.as_ref().map(project_pricing_v2),
        modalities: model.modalities.clone(),
        capabilities: None,
        compat: model.compat.clone(),
    }
}

fn project_pricing_v2(pricing: &ModelPricingSpec) -> ModelsYamlPricingV2 {
    ModelsYamlPricingV2 {
        currency: Some(pricing.currency),
        input: Some(pricing.input),
        output: Some(pricing.output),
        cache_read: pricing.cache_read,
        cache_write: pricing.cache_write,
        per_image: pricing.per_image,
    }
}

/// lossy 投影：只填扁平身份与旧价键，不拷 thinking/modalities/compat/baseUrl/apiKey。
fn flatten_model_lossy(
    provider_id: &str,
    provider: &ProviderSpec,
    model: &ModelSpec,
) -> ModelsYamlModel {
    ModelsYamlModel {
        model: model.id.clone(),
        vendor: provider_id.to_string(),
        vendor_display_name: provider.display_name.clone(),
        display_name: model.display_name.clone(),
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
        protocol: Some(model.effective_protocol(provider)),
        capabilities: None,
        pricing: model.pricing.as_ref().map(|p| ModelsYamlPricing {
            input_per_m_tok: Some(p.input),
            output_per_m_tok: Some(p.output),
            cache_read_per_m_tok: p.cache_read,
            cache_write_per_m_tok: p.cache_write,
            billing_unit: None,
            per_image_cost: p.per_image,
            currency: Some(p.currency),
        }),
    }
}

/// 诊断 → `CoreError::InvalidInput`（保存面唯一错误通道，行/列写入消息文本）
fn diagnostic_to_core_error(diag: &ModelsYamlDiagnostic) -> CoreError {
    match (diag.line, diag.column) {
        (Some(line), Some(column)) => CoreError::invalid_input(format!(
            "models.yaml 校验失败（第 {line} 行 第 {column} 列）：{}",
            diag.message
        )),
        (Some(line), None) => CoreError::invalid_input(format!(
            "models.yaml 校验失败（第 {line} 行）：{}",
            diag.message
        )),
        _ => CoreError::invalid_input(format!("models.yaml 校验失败：{}", diag.message)),
    }
}

// ===== 内部实现（路径注入，供单测）=====

/// 读取：缺文件播种 → 存量自动升级迁移 → 返回 content + 解析产物（解析失败不吞 content，编辑器可修复）
fn read_models_yaml_at(path: &Path, template: &str) -> Result<ReadModelsYamlResult, CoreError> {
    let (content, seeded) = if path.exists() {
        // 若目标文件存在，在解析前先调用 ConfigMigrationManager::ensure_migrated 安全检查与升级
        match ConfigMigrationManager::ensure_migrated(path) {
            Ok(MigrationStatus::MigratedSuccessfully {
                backup_path,
                provider_count,
                model_count,
            }) => {
                tracing::info!(
                    backup = %backup_path.display(),
                    providers = provider_count,
                    models = model_count,
                    "[models.yaml] 存量旧版配置自动升级迁移成功，已转换为 v2 树状架构"
                );
            }
            Ok(MigrationStatus::AlreadyUpToDate) => {
                // 已是最新版配置，继续正常流程
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    path = %path.display(),
                    "[models.yaml] 存量迁移检查未执行（可能格式错误或部分损坏），保留原始文件供解析器诊断"
                );
            }
        }
        (
            std::fs::read_to_string(path).map_err(|e| CoreError::Io(e.to_string()))?,
            false,
        )
    } else {
        conex_fs::atomic_write_file(path, template.as_bytes())
            .map_err(|e| CoreError::Io(format!("播种 models.yaml 失败: {e}")))?;
        (template.to_string(), true)
    };

    let (models, version, providers, parse_error) = match parse_models_yaml(&content) {
        Ok(parsed) => (parsed.models, parsed.version, parsed.providers, None),
        Err(diag) => (Vec::new(), None, None, Some(diag)),
    };

    Ok(ReadModelsYamlResult {
        path: path.display().to_string(),
        content,
        models,
        template: template.to_string(),
        seeded,
        parse_error,
        version,
        providers,
    })
}

/// 校验（不落盘）
fn validate_models_yaml_content(content: &str) -> ValidateModelsYamlResult {
    match parse_models_yaml(content) {
        Ok(_) => ValidateModelsYamlResult {
            valid: true,
            line: None,
            column: None,
            message: None,
        },
        Err(diag) => ValidateModelsYamlResult {
            valid: false,
            line: diag.line,
            column: diag.column,
            message: Some(diag.message),
        },
    }
}

/// 保存：先校验（fail-closed）→ conex-fs 原子写 → 触发协议层热重载
fn save_models_yaml_at(path: &Path, content: &str) -> Result<SaveModelsYamlResult, CoreError> {
    let parsed = parse_models_yaml(content).map_err(|diag| diagnostic_to_core_error(&diag))?;
    conex_fs::atomic_write_file(path, content.as_bytes())
        .map_err(|e| CoreError::Io(format!("写入 models.yaml 失败: {e}")))?;

    // 触发协议层运行时目录热重载
    crate::engine_provider::protocol::reload_live_catalog();

    Ok(SaveModelsYamlResult {
        path: path.display().to_string(),
        models: parsed.models,
        version: parsed.version,
        providers: parsed.providers,
    })
}

// ===== Tauri 命令 =====

#[tauri::command]
pub(crate) fn workbench_read_models_yaml() -> Result<ReadModelsYamlResult, CoreError> {
    read_models_yaml_at(&models_yaml_path()?, DEFAULT_MODELS_YAML)
}

#[tauri::command]
pub(crate) fn workbench_validate_models_yaml(
    content: String,
) -> Result<ValidateModelsYamlResult, CoreError> {
    Ok(validate_models_yaml_content(&content))
}

#[tauri::command]
pub(crate) fn workbench_save_models_yaml(
    content: String,
) -> Result<SaveModelsYamlResult, CoreError> {
    save_models_yaml_at(&models_yaml_path()?, &content)
}

// ===== 单测 =====

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

    /// 独立临时目录（进程内自增 + 进程号，避免并行用例互踩）
    fn temp_dir(tag: &str) -> PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "conex-models-yaml-{}-{}-{tag}-{seq}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn sample_yaml() -> &'static str {
        DEFAULT_MODELS_YAML
    }

    #[test]
    fn template_parses_and_is_wellformed() {
        let parsed = parse_models_yaml(sample_yaml()).expect("内置模板必须可解析");
        assert!(
            parsed.models.is_empty(),
            "默认模板必须保持干干净净的空 providers，不带任何默认垃圾"
        );
        assert_eq!(parsed.version, Some(2));
        assert!(parsed
            .providers
            .as_ref()
            .map(|p| p.is_empty())
            .unwrap_or(false));

        let populated = r#"
version: 2
providers:
  deepseek:
    displayName: "DeepSeek"
    baseUrl: "https://api.deepseek.com"
    protocol: "openai/chat"
    models:
      - id: "deepseek-v4-pro"
        displayName: "DeepSeek V4 Pro"
        contextWindow: 1048576
"#;
        let res = parse_models_yaml(populated).expect("v2 树状结构必须可解析");
        assert_eq!(res.models.len(), 1);
        assert_eq!(res.models[0].model, "deepseek-v4-pro");
        assert_eq!(res.models[0].vendor, "deepseek");
    }

    #[test]
    fn read_seeds_missing_file_idempotently() {
        let dir = temp_dir("seed");
        let path = dir.join(MODELS_YAML_FILENAME);

        let first = read_models_yaml_at(&path, sample_yaml()).expect("首次读取应播种");
        assert!(first.seeded);
        assert!(path.exists(), "播种后文件必须落盘");
        assert!(first.parse_error.is_none());
        assert!(first.models.is_empty(), "默认空播种模型列表必须为空");
        assert_eq!(first.content, sample_yaml());

        // 第二次读取：不重复播种（幂等），内容一致
        let second = read_models_yaml_at(&path, sample_yaml()).expect("二次读取");
        assert!(!second.seeded);
        assert_eq!(second.content, first.content);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_returns_content_with_parse_error_for_corrupt_file() {
        let dir = temp_dir("corrupt");
        let path = dir.join(MODELS_YAML_FILENAME);
        std::fs::write(&path, "models: [ { model: broken").expect("写入损坏内容");

        let before = std::fs::read_to_string(&path).expect("读损坏原文");
        let res = read_models_yaml_at(&path, sample_yaml()).expect("损坏文件也必须返回 content");
        assert!(!res.seeded);
        assert!(res.parse_error.is_some(), "必须携带结构化诊断");
        assert!(res.models.is_empty(), "解析失败时镜像必须为空，不得毒化");
        assert!(
            res.providers.is_none(),
            "解析失败必须 providers=None，禁止吞成空配置成功"
        );
        assert_eq!(
            std::fs::read_to_string(&path).expect("再读磁盘"),
            before,
            "损坏文件读取不得覆盖磁盘"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_reports_line_and_column_for_syntax_error() {
        let bad = "models:\n  - model: a\n    vendor: b\n  bad-indent: [";
        let res = validate_models_yaml_content(bad);
        assert!(!res.valid);
        assert!(res.line.is_some(), "语法错误必须带行号");
        assert!(res.message.is_some());
    }

    #[test]
    fn validate_rejects_v1_flat_models_not_silent_upgrade() {
        let v1 = "models:\n  - model: a\n    vendor: b";
        let res = validate_models_yaml_content(v1);
        assert!(!res.valid, "v1 扁平不得在 save/validate 静默升级");
        assert!(res.message.as_deref().unwrap_or_default().contains("v1"));
    }

    #[test]
    fn validate_rejects_duplicate_model_id_in_v2() {
        let dup = r#"
version: 2
providers:
  acme:
    models:
      - id: a
      - id: a
"#;
        let res = validate_models_yaml_content(dup);
        assert!(!res.valid);
        assert!(res.message.as_deref().unwrap_or_default().contains("重复"));

        let empty_id = r#"
version: 2
providers:
  acme:
    models:
      - id: ""
"#;
        let res = validate_models_yaml_content(empty_id);
        assert!(!res.valid);
        assert!(res.message.as_deref().unwrap_or_default().contains("为空"));
    }

    #[test]
    fn validate_rejects_v1_empty_models_list() {
        let res = validate_models_yaml_content("models: []");
        assert!(
            !res.valid,
            "v1 空 models 不得当诚实空树；诚实空树是 providers: {{}}"
        );
    }

    #[test]
    fn validate_accepts_v2_empty_providers() {
        let res = validate_models_yaml_content("version: 2\nproviders: {}\n");
        assert!(
            res.valid,
            "version: 2, providers: {{}} 是绝对最高规范的默认合法态"
        );
    }

    #[test]
    fn save_roundtrip_and_atomic_rejects_invalid() {
        let dir = temp_dir("save");
        let path = dir.join(MODELS_YAML_FILENAME);

        // 合法保存：内容一致
        let saved = save_models_yaml_at(&path, sample_yaml()).expect("合法内容应保存成功");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), sample_yaml());
        assert!(saved.models.is_empty());
        assert!(saved.path.ends_with(MODELS_YAML_FILENAME));

        // 非法保存：报错且原文件不被破坏
        let before = std::fs::read_to_string(&path).unwrap();
        let invalid = "models:\n  - model: [unclosed";
        let err = save_models_yaml_at(&path, invalid).expect_err("非法内容必须被拒绝");
        assert!(matches!(err, CoreError::InvalidInput(_)));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            before,
            "失败保存不得破坏原文件"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_creates_missing_parent_dir() {
        let dir = temp_dir("mkdir");
        let path = dir.join("nested").join(MODELS_YAML_FILENAME);
        let res = save_models_yaml_at(&path, sample_yaml()).expect("父目录缺失应自动创建");
        assert!(path.exists());
        assert!(res.models.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_auto_migrates_legacy_flat_yaml_to_v2_tree() {
        let dir = temp_dir("migration");
        let path = dir.join(MODELS_YAML_FILENAME);

        let legacy_yaml = r#"
schema_version: 1
models:
  - id: "deepseek-chat"
    name: "DeepSeek V3"
    vendor: "deepseek"
    baseUrl: "https://api.deepseek.com"
    contextWindow: 65536
    maxTokens: 8192
    reasoning: false
  - id: "deepseek-reasoner"
    name: "DeepSeek R1"
    vendor: "deepseek"
    baseUrl: "https://api.deepseek.com"
    contextWindow: 131072
    maxTokens: 32768
    reasoning: true
"#;
        std::fs::write(&path, legacy_yaml).expect("写入旧版扁平配置");

        let res = read_models_yaml_at(&path, sample_yaml()).expect("读取旧版文件应成功升级迁移");
        assert!(!res.seeded, "已存在的文件不属于播种");
        assert!(res.parse_error.is_none(), "迁移后解析不应报错");
        assert_eq!(res.version, Some(2), "迁移后版本必须为 2");

        let providers = res.providers.expect("迁移后必须包含 providers 树状结构");
        assert!(
            providers.contains_key("deepseek"),
            "必须按 vendor 聚类生成 deepseek 供应商"
        );
        let deepseek = &providers["deepseek"];
        assert_eq!(
            deepseek.models.len(),
            2,
            "deepseek 供应商下必须包含 2 个模型"
        );

        // 验证展平模型列表
        assert_eq!(res.models.len(), 2);
        assert!(res.models.iter().any(|m| m.model == "deepseek-chat"));
        assert!(res.models.iter().any(|m| m.model == "deepseek-reasoner"));

        // 验证磁盘内容已实际更新为 v2
        let disk_content = std::fs::read_to_string(&path).expect("读取落盘内容");
        assert!(disk_content.contains("version: 2"));
        assert!(disk_content.contains("providers:"));
        assert_eq!(
            disk_content, res.content,
            "返回的 content 必须与落盘内容一致"
        );

        // 验证是否生成了物理时间戳备份文件 (.bak)
        let bak_exists = std::fs::read_dir(&dir)
            .expect("读取目录")
            .filter_map(|e| e.ok())
            .any(|e| e.path().to_string_lossy().contains(".bak"));
        assert!(bak_exists, "自动升级时必须生成时间戳物理备份 .bak 文件");

        // 幂等性验证：二次读取时已是最新版，不应重复备份或修改
        let second = read_models_yaml_at(&path, sample_yaml()).expect("二次读取");
        assert!(!second.seeded);
        assert_eq!(second.content, res.content);
        assert_eq!(second.version, Some(2));
        assert_eq!(second.models.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// plans/01 §7.1 最小 yaml：往返真源是 `providers.acme`，扁平 models 不得当 thinking 真源。
    fn acme_min_yaml() -> &'static str {
        r#"version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: https://example.invalid/v1
    protocol: openai/chat
    apiKey: $ACME_API_KEY
    models:
      - id: acme-think
        displayName: Acme Think
        contextWindow: 128000
        thinking:
          Low: low
          High: high
        modalities:
          input: [text, image]
          output: [text]
        pricing:
          currency: USD
          input: 1
          output: 2
          cacheRead: 0.1
          cacheWrite: 0.2
"#
    }

    fn assert_acme_provider_tree(providers: &IndexMap<String, ModelsYamlProviderV2>) {
        let acme = providers.get("acme").expect("providers.acme 必须存在");
        assert_eq!(acme.display_name.as_deref(), Some("Acme"));
        assert_eq!(acme.base_url.as_deref(), Some("https://example.invalid/v1"));
        assert_eq!(acme.protocol, Some(ProtocolKind::OpenAiChat));
        assert_eq!(acme.api_key.as_deref(), Some("$ACME_API_KEY"));
        assert_eq!(acme.models.len(), 1);
        let model = &acme.models[0];
        assert_eq!(model.id.as_deref(), Some("acme-think"));
        assert_eq!(model.display_name.as_deref(), Some("Acme Think"));
        assert_eq!(model.context_window, Some(128000));
        let thinking = model.thinking.as_ref().expect("thinking 字典必须保留");
        assert_eq!(thinking.get("Low").map(String::as_str), Some("low"));
        assert_eq!(thinking.get("High").map(String::as_str), Some("high"));
        let modalities = model.modalities.as_ref().expect("modalities 必须保留");
        assert!(modalities.supports_input("image"));
        assert!(modalities.supports_input("text"));
        assert!(modalities.supports_output("text"));
        let pricing = model.pricing.as_ref().expect("pricing 必须保留");
        assert_eq!(pricing.currency, Some(CurrencyKind::Usd));
        assert_eq!(pricing.input, Some(1.0));
        assert_eq!(pricing.output, Some(2.0));
        assert_eq!(pricing.cache_read, Some(0.1));
        assert_eq!(pricing.cache_write, Some(0.2));
    }

    #[test]
    fn acme_roundtrip_providers_keep_thinking_and_modalities() {
        let dir = temp_dir("acme");
        let path = dir.join(MODELS_YAML_FILENAME);
        let yaml = acme_min_yaml();

        let saved = save_models_yaml_at(&path, yaml).expect("§7.1 yaml 必须保存成功");
        let disk = std::fs::read_to_string(&path).expect("读磁盘");
        assert!(disk.contains("thinking:"), "磁盘必须保留 thinking");
        assert!(disk.contains("modalities:"), "磁盘必须保留 modalities");
        assert!(disk.contains("cacheRead:"), "磁盘必须保留 cacheRead");
        assert!(disk.contains("baseUrl:"), "磁盘必须保留 baseUrl");
        assert!(disk.contains("apiKey:"), "磁盘必须保留 apiKey");
        assert!(disk.contains("protocol:"), "磁盘必须保留 protocol");
        assert!(disk.contains("https://example.invalid/v1"));
        assert!(disk.contains("$ACME_API_KEY"));

        let saved_providers = saved
            .providers
            .as_ref()
            .expect("save 必须返回 providers 树");
        assert_acme_provider_tree(saved_providers);

        // 扁平 models 即使仍返回，也只是 lossy 身份投影，不得当 thinking 真源
        assert_eq!(saved.models.len(), 1);
        assert_eq!(saved.models[0].model, "acme-think");
        assert_eq!(saved.models[0].vendor, "acme");

        let read = read_models_yaml_at(&path, sample_yaml()).expect("再读必须成功");
        assert!(read.parse_error.is_none());
        let read_providers = read.providers.as_ref().expect("read 必须返回 providers 树");
        assert_acme_provider_tree(read_providers);

        let live = agent_provider::models::LiveModels::from_yaml_str(&disk)
            .expect("save 后的磁盘必须能被 live 同一套 from_yaml_str 吃下");
        assert!(live.parse_error.is_none());
        assert_eq!(
            live.find("acme", "acme-think")
                .and_then(|m| m.thinking.as_ref())
                .and_then(|t| t.get("Low"))
                .map(String::as_str),
            Some("low"),
            "§7.1 thinking.Low 在 IPC 与 live 必须等值"
        );

        let json = serde_json::to_value(read_providers.get("acme").unwrap()).expect("序列化 acme");
        assert_eq!(json["models"][0]["thinking"]["Low"], "low");
        assert!(json["models"][0]["pricing"].get("inputPerMTok").is_none());
        assert!(json["models"][0]["pricing"]
            .get("cacheReadPerMTok")
            .is_none());
        assert_eq!(json["models"][0]["pricing"]["cacheRead"], 0.1);
        assert_eq!(json["models"][0]["contextWindow"], 128000);
        assert!(json["models"][0].get("contextLength").is_none());
        assert_eq!(json["baseUrl"], "https://example.invalid/v1");
        assert_eq!(json["apiKey"], "$ACME_API_KEY");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_file_is_honest_empty_providers() {
        let parsed = parse_models_yaml("").expect("空文件必须是诚实空树，不是解析失败");
        assert_eq!(parsed.version, Some(2));
        assert!(
            parsed
                .providers
                .as_ref()
                .map(|p| p.is_empty())
                .unwrap_or(false),
            "空文件 providers=Some({{}})"
        );
        assert!(parsed.models.is_empty());

        let comments_only = parse_models_yaml("# 仅注释\n").expect("仅注释视为空树");
        assert!(comments_only
            .providers
            .as_ref()
            .map(|p| p.is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn read_boundary_normalizes_legacy_keys_once() {
        let yaml = r#"
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: https://example.invalid/v1
    protocol: google/interactions
    apiKey: $ACME_API_KEY
    compat:
      thinkingFormat: google
    models:
      - id: acme-think
        contextLength: 128000
        compat:
          thinkingFormat: qwen_enable_thinking
        pricing:
          currency: USD
          inputPerMTok: 1
          output_per_m_tok: 2
          cacheReadPerMTok: 0.1
          cacheWritePerMTok: 0.2
"#;
        let parsed = parse_models_yaml(yaml).expect("旧键必须在读边界被认一次");
        let acme = parsed
            .providers
            .as_ref()
            .expect("providers")
            .get("acme")
            .expect("acme");
        assert_eq!(acme.protocol, Some(ProtocolKind::GoogleGenerateContent));
        assert_eq!(
            acme.compat.as_ref().and_then(|c| c.thinking_format),
            Some(agent_provider::models::ThinkingFormat::Gemini)
        );
        let model = &acme.models[0];
        assert_eq!(model.context_window, Some(128000));
        assert_eq!(
            model.compat.as_ref().and_then(|c| c.thinking_format),
            Some(agent_provider::models::ThinkingFormat::Qwen)
        );
        let pricing = model.pricing.as_ref().expect("pricing");
        assert_eq!(pricing.input, Some(1.0));
        assert_eq!(pricing.output, Some(2.0));
        assert_eq!(pricing.cache_read, Some(0.1));
        assert_eq!(pricing.cache_write, Some(0.2));

        let json = serde_json::to_value(acme).expect("写出归一");
        assert_eq!(json["protocol"], "google/generate-content");
        assert_eq!(json["compat"]["thinkingFormat"], "gemini");
        assert_eq!(json["models"][0]["compat"]["thinkingFormat"], "qwen");
        assert_eq!(json["models"][0]["contextWindow"], 128000);
        assert!(json["models"][0].get("contextLength").is_none());
        assert!(json["models"][0]["pricing"].get("inputPerMTok").is_none());
        assert!(json["models"][0]["pricing"]
            .get("input_per_m_tok")
            .is_none());
        assert_eq!(json["models"][0]["pricing"]["input"], 1.0);
        assert_eq!(json["models"][0]["pricing"]["cacheRead"], 0.1);
    }

    #[test]
    fn missing_display_name_parses_on_ipc_and_live() {
        let yaml = r#"
version: 2
providers:
  acme:
    protocol: openai/chat
    models:
      - id: acme-think
        thinking:
          Low: low
"#;
        let parsed = parse_models_yaml(yaml).expect("IPC 缺 displayName 必须能解析");
        let acme = parsed
            .providers
            .as_ref()
            .expect("providers")
            .get("acme")
            .expect("acme");
        assert_eq!(acme.display_name, None);
        assert_eq!(acme.base_url, None);
        assert_eq!(
            acme.models[0]
                .thinking
                .as_ref()
                .and_then(|t| t.get("Low"))
                .map(String::as_str),
            Some("low")
        );

        let live = agent_provider::models::LiveModels::from_yaml_str(yaml)
            .expect("live 缺 displayName 必须能解析，禁止 IPC 能存、live 却 Err");
        assert!(live.parse_error.is_none());
        assert_eq!(
            live.tree
                .find_provider("acme")
                .and_then(|p| p.display_name.as_deref()),
            None
        );
        assert_eq!(
            live.find("acme", "acme-think")
                .and_then(|m| m.thinking.as_ref())
                .and_then(|t| t.get("Low"))
                .map(String::as_str),
            Some("low")
        );
    }
}
