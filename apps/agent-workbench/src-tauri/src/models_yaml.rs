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
//! - schema `deny_unknown_fields`：拼错字段名直接报错，不留静默死字段。

use agent_provider::migration::{ConfigMigrationManager, MigrationStatus};
use conex_types::CoreError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 磁盘真源文件名（位于 `~/.conex/` 下）
pub(crate) const MODELS_YAML_FILENAME: &str = "models.yaml";

/// 内置模板（数据来源：`docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`）
const DEFAULT_MODELS_YAML: &str = include_str!("models.default.yaml");

// ===== Schema（serde camelCase 对齐前端 TS 镜像类型）=====

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelsYamlProtocol {
    #[serde(rename = "openai/chat")]
    OpenAiChat,
    #[serde(rename = "openai/responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic/messages")]
    AnthropicMessages,
    #[serde(rename = "google/generate-content")]
    GoogleGenerateContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelsYamlBillingUnit {
    Token,
    PerImage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelsYamlCurrency {
    USD,
    CNY,
}

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsYamlPricingV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<ModelsYamlCurrency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_image: Option<f64>,
    // 兼容 v1 命名
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsYamlModelV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ModelsYamlProtocol>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<serde_yaml::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelsYamlPricingV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modalities: Option<serde_yaml::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelsYamlCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<serde_yaml::Value>,
}

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
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<serde_yaml::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelsYamlModelV2>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedModelsYamlFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<std::collections::BTreeMap<String, ModelsYamlProviderV2>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelsYamlModel>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedModelsYaml {
    pub version: Option<u32>,
    pub providers: Option<std::collections::BTreeMap<String, ModelsYamlProviderV2>>,
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
    pub models: Vec<ModelsYamlModel>,
    /// 内置模板原文（「恢复标准模版」单一来源）
    pub template: String,
    /// 本次读取是否触发了播种
    pub seeded: bool,
    /// 磁盘内容解析失败时的诊断（content 原样返回，编辑器可修复后保存）
    pub parse_error: Option<ModelsYamlDiagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<std::collections::BTreeMap<String, ModelsYamlProviderV2>>,
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
    pub models: Vec<ModelsYamlModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<std::collections::BTreeMap<String, ModelsYamlProviderV2>>,
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

/// 解析 + 语义校验（支持 v2 树状与 v1 扁平结构）。
/// 失败返回结构化诊断（serde_yaml 错误透传行/列号）。
fn parse_models_yaml(content: &str) -> Result<ParsedModelsYaml, ModelsYamlDiagnostic> {
    let file: UnifiedModelsYamlFile = match serde_yaml::from_str(content) {
        Ok(f) => f,
        Err(err) => {
            let (line, column) = err
                .location()
                .map(|loc| (loc.line() as u32, loc.column() as u32))
                .unzip();
            return Err(ModelsYamlDiagnostic {
                line,
                column,
                message: err.to_string(),
            });
        }
    };

    if let Some(providers) = file.providers {
        let mut flattened_models = Vec::new();
        let mut seen_models = std::collections::HashSet::new();

        for (provider_id, provider) in &providers {
            if provider_id.trim().is_empty() {
                return Err(ModelsYamlDiagnostic {
                    line: None,
                    column: None,
                    message: "存在供应商标识为空的条目".into(),
                });
            }
            for m in &provider.models {
                let model_id = m.id.as_deref().or(m.model.as_deref()).unwrap_or("");
                if model_id.trim().is_empty() {
                    return Err(ModelsYamlDiagnostic {
                        line: None,
                        column: None,
                        message: format!("供应商 {provider_id} 存在 ID 为空的模型"),
                    });
                }
                let key = format!("{provider_id}::{model_id}");
                if !seen_models.insert(key) {
                    return Err(ModelsYamlDiagnostic {
                        line: None,
                        column: None,
                        message: format!("供应商 {provider_id} 中模型 ID 重复: {model_id}"),
                    });
                }

                let pricing = m.pricing.as_ref().map(|p| ModelsYamlPricing {
                    input_per_m_tok: p.input.or(p.input_per_m_tok),
                    output_per_m_tok: p.output.or(p.output_per_m_tok),
                    cache_read_per_m_tok: p.cache_read.or(p.cache_read_per_m_tok),
                    cache_write_per_m_tok: p.cache_write.or(p.cache_write_per_m_tok),
                    billing_unit: p.billing_unit,
                    per_image_cost: p.per_image.or(p.per_image_cost),
                    currency: p.currency,
                });

                flattened_models.push(ModelsYamlModel {
                    model: model_id.to_string(),
                    vendor: provider_id.clone(),
                    vendor_display_name: provider.display_name.clone(),
                    display_name: m.display_name.clone(),
                    context_window: m.context_window,
                    max_output_tokens: m.max_output_tokens,
                    protocol: m.protocol.or(provider.protocol),
                    capabilities: m.capabilities.clone(),
                    pricing,
                });
            }
        }

        Ok(ParsedModelsYaml {
            version: file.version.or(Some(2)),
            providers: Some(providers),
            models: flattened_models,
        })
    } else if let Some(models) = file.models {
        let mut seen = std::collections::HashSet::new();
        for entry in &models {
            if entry.model.trim().is_empty() {
                return Err(ModelsYamlDiagnostic {
                    line: None,
                    column: None,
                    message: "存在 model 为空的条目".into(),
                });
            }
            if entry.vendor.trim().is_empty() {
                return Err(ModelsYamlDiagnostic {
                    line: None,
                    column: None,
                    message: format!("模型 {} 缺少 vendor", entry.model),
                });
            }
            if !seen.insert(entry.model.as_str()) {
                return Err(ModelsYamlDiagnostic {
                    line: None,
                    column: None,
                    message: format!("model 条目重复: {}", entry.model),
                });
            }
        }
        Ok(ParsedModelsYaml {
            version: file.version,
            providers: None,
            models,
        })
    } else {
        // 空文件、仅含注释、或 version: 2 单行（符合默认空供应商规范）
        Ok(ParsedModelsYaml {
            version: file.version.or(Some(2)),
            providers: Some(std::collections::BTreeMap::new()),
            models: Vec::new(),
        })
    }
}

/// 诊断 → `CoreError::InvalidInput`（保存面唯一错误通道，行/列写入消息文本）
fn diagnostic_to_core_error(diag: &ModelsYamlDiagnostic) -> CoreError {
    match (diag.line, diag.column) {
        (Some(line), Some(column)) => CoreError::invalid_input(format!(
            "models.yaml 校验失败（第 {line} 行 第 {column} 列）：{}",
            diag.message
        )),
        (Some(line), None) => {
            CoreError::invalid_input(format!("models.yaml 校验失败（第 {line} 行）：{}", diag.message))
        }
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
        (std::fs::read_to_string(path).map_err(|e| CoreError::Io(e.to_string()))?, false)
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
pub(crate) fn workbench_save_models_yaml(content: String) -> Result<SaveModelsYamlResult, CoreError> {
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
        assert!(parsed.models.is_empty(), "默认模板必须保持干干净净的空 providers，不带任何默认垃圾");
        assert_eq!(parsed.version, Some(2));
        assert!(parsed.providers.as_ref().map(|p| p.is_empty()).unwrap_or(false));

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

        let res = read_models_yaml_at(&path, sample_yaml()).expect("损坏文件也必须返回 content");
        assert!(!res.seeded);
        assert!(res.parse_error.is_some(), "必须携带结构化诊断");
        assert!(res.models.is_empty(), "解析失败时镜像必须为空，不得毒化");

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
    fn validate_rejects_unknown_field() {
        let bad = "models:\n  - model: a\n    vendor: b\n    unknowField: 1";
        let res = validate_models_yaml_content(bad);
        assert!(!res.valid, "未知字段必须拒绝（deny_unknown_fields）");
    }

    #[test]
    fn validate_rejects_duplicate_model_and_missing_vendor() {
        let dup = "models:\n  - model: a\n    vendor: b\n  - model: a\n    vendor: c";
        let res = validate_models_yaml_content(dup);
        assert!(!res.valid);
        assert!(res.message.as_deref().unwrap_or_default().contains("重复"));

        let no_vendor = "models:\n  - model: a\n    vendor: \"\"";
        let res = validate_models_yaml_content(no_vendor);
        assert!(!res.valid);
        assert!(res.message.as_deref().unwrap_or_default().contains("vendor"));
    }

    #[test]
    fn validate_accepts_empty_models_list() {
        let res = validate_models_yaml_content("models: []");
        assert!(res.valid, "空字典是诚实合法态");
    }

    #[test]
    fn validate_accepts_v2_empty_providers() {
        let res = validate_models_yaml_content("version: 2\nproviders: {}\n");
        assert!(res.valid, "version: 2, providers: {{}} 是绝对最高规范的默认合法态");
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
        assert!(providers.contains_key("deepseek"), "必须按 vendor 聚类生成 deepseek 供应商");
        let deepseek = &providers["deepseek"];
        assert_eq!(deepseek.models.len(), 2, "deepseek 供应商下必须包含 2 个模型");

        // 验证展平模型列表
        assert_eq!(res.models.len(), 2);
        assert!(res.models.iter().any(|m| m.model == "deepseek-chat"));
        assert!(res.models.iter().any(|m| m.model == "deepseek-reasoner"));

        // 验证磁盘内容已实际更新为 v2
        let disk_content = std::fs::read_to_string(&path).expect("读取落盘内容");
        assert!(disk_content.contains("version: 2"));
        assert!(disk_content.contains("providers:"));
        assert_eq!(disk_content, res.content, "返回的 content 必须与落盘内容一致");

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
}
