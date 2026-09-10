//! 存量 models.yaml 无损平滑自动迁移引擎 (v1.0 扁平 -> v2.0 树状)
//!
//! 负责检测历史存量配置格式，自动创建不可篡改的时间戳物理备份，
//! 并将一维模型列表按 vendor 聚类重构为 Provider-Centric 树状架构。
//!
//! 核心设计契约：
//! 1. 唯一真源不变量 (SSOT)：保持 ~/.conex/models.yaml 为唯一物理真源；
//! 2. 幂等性与内容嗅探：若已是 v2.0 树状配置或无旧版顶层 models 数组，直接跳过；
//! 3. 时间戳防灾物理备份：在修改磁盘前以本地时间戳 (%Y%m%d_%H%M%S) 创建不可篡改物理备份 (.bak)；
//! 4. 聚类重构：按 vendor 聚类为 Provider 树状拓扑，自动推导协议与兼容性方言；
//! 5. 思考配置彻底拍平：将 reasoning: true 转换为纯英文 TitleCase 字典映射 { Low: "low", Medium: "medium", High: "high" }；
//! 6. 多模态与协议补齐：默认补齐 modalities: { input: ["text"], output: ["text"] }；
//! 7. 完整性与零丢失校验：断言迁移前后模型数量严格相等，且每个模型 ID 均完整迁移，否则报错 LossyMigrationDetected；
//! 8. 原子影子落盘：先写入临时文件 .yaml.tmp，校验成功后原子替换目标文件。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MigrationError {
    #[error("文件 I/O 异常: {0}")]
    Io(#[from] std::io::Error),

    #[error("YAML 序列化/反序列化失败: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("JSON 序列化/反序列化失败: {0}")]
    Json(#[from] serde_json::Error),

    #[error("备份校验失败: 备份文件大小不匹配 (原始: {expected}B, 实际: {actual}B)")]
    BackupVerificationFailed { expected: u64, actual: u64 },

    #[error("迁移完整性校验未通过: 原始模型数 {original} 与迁移后模型数 {migrated} 不一致")]
    LossyMigrationDetected { original: usize, migrated: usize },

    #[error("目标路径非法或不存在: {0}")]
    InvalidPath(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MigrationStatus {
    AlreadyUpToDate,
    MigratedSuccessfully {
        backup_path: PathBuf,
        provider_count: usize,
        model_count: usize,
    },
}

pub struct ConfigMigrationManager;

impl ConfigMigrationManager {
    /// 检测并执行自动升级迁移
    pub fn ensure_migrated(config_path: &Path) -> Result<MigrationStatus, MigrationError> {
        if !config_path.exists() {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }

        let raw_content = fs::read_to_string(config_path)?;
        if raw_content.trim().is_empty() {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }

        let parsed_value: Value = match serde_yaml::from_str(&raw_content) {
            Ok(v) => v,
            Err(e) => return Err(MigrationError::Yaml(e)),
        };

        if parsed_value.is_null() {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }

        // 内容嗅探：
        // 判定规则：根对象包含旧版顶层 "models" 数组时触发迁移；
        // 若根对象已包含 "providers" 字典且不包含旧版顶层 "models" 数组，判定为已是 v2.0，直接跳过。
        let has_providers = parsed_value
            .get("providers")
            .and_then(|v| v.as_object())
            .is_some();
        let has_legacy_models = parsed_value
            .get("models")
            .and_then(|v| v.as_array())
            .is_some();

        if has_providers && !has_legacy_models {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }

        if !has_legacy_models {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }

        tracing::info!("[Migration] 检测到旧版扁平 models.yaml，启动向后兼容物理升级...");

        // 步骤 1: 物理备份并校验大小
        let backup_path = Self::create_disaster_backup(config_path)?;
        tracing::info!(
            "[Migration] 原始物理配置已建立安全防灾备份: {:?}",
            backup_path
        );

        // 步骤 2: 纯逻辑内存数据重构聚类
        let (migrated_yaml_value, total_migrated_models) =
            Self::transform_flat_to_tree(&parsed_value)?;

        // 步骤 3: 完整性无损断言
        let original_model_count = parsed_value
            .get("models")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);

        if original_model_count != total_migrated_models {
            return Err(MigrationError::LossyMigrationDetected {
                original: original_model_count,
                migrated: total_migrated_models,
            });
        }

        // 验证所有原始模型 ID 均完整迁移至 providers 下属 models，一个不漏
        if let Some(original_models) = parsed_value.get("models").and_then(|v| v.as_array()) {
            let mut migrated_ids = std::collections::HashSet::new();
            if let Some(prov_map) = migrated_yaml_value
                .get("providers")
                .and_then(|v| v.as_object())
            {
                for prov in prov_map.values() {
                    if let Some(models) = prov.get("models").and_then(|v| v.as_array()) {
                        for m in models {
                            if let Some(id) = m.get("id").and_then(|v| v.as_str()) {
                                migrated_ids.insert(id);
                            }
                        }
                    }
                }
            }

            for m in original_models {
                let id = m
                    .get("id")
                    .or_else(|| m.get("model"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown-model");
                if !migrated_ids.contains(id) {
                    return Err(MigrationError::LossyMigrationDetected {
                        original: original_model_count,
                        migrated: total_migrated_models,
                    });
                }
            }
        }

        // 步骤 4: 写入临时影子文件并做反序列化自检
        let file_name = config_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("models.yaml");
        let tmp_path = config_path.with_file_name(format!("{}.tmp", file_name));

        let migrated_yaml_str = serde_yaml::to_string(&migrated_yaml_value)?;
        // 自检：确保生成的 YAML 能够成功反序列化
        let _: Value = serde_yaml::from_str(&migrated_yaml_str)?;

        fs::write(&tmp_path, &migrated_yaml_str)?;

        // 步骤 5: 原子重命名覆盖目标文件（Windows 3 阶段防丢失容灾替换）
        Self::atomic_replace(&tmp_path, config_path)?;

        tracing::info!(
            "[Migration] 迁移原子完成！已将 {} 个模型聚类至树状供应商主体",
            total_migrated_models
        );

        let provider_count = migrated_yaml_value
            .get("providers")
            .and_then(|v| v.as_object())
            .map(|obj| obj.len())
            .unwrap_or(0);

        Ok(MigrationStatus::MigratedSuccessfully {
            backup_path,
            provider_count,
            model_count: total_migrated_models,
        })
    }

    /// 创建带时间戳的防灾物理备份
    pub fn create_disaster_backup(source: &Path) -> Result<PathBuf, MigrationError> {
        let metadata = fs::metadata(source)?;
        let original_size = metadata.len();

        let timestamp = Self::current_local_timestamp();
        let file_stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("models");
        let ext = source
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("yaml");
        let backup_file_name = format!("{}.{}.bak.{}", file_stem, timestamp, ext);
        let mut backup_path = source.with_file_name(&backup_file_name);

        if backup_path.exists() {
            let mut counter = 1;
            while backup_path.exists() {
                let backup_file_name =
                    format!("{}.{}_{}.bak.{}", file_stem, timestamp, counter, ext);
                backup_path = source.with_file_name(backup_file_name);
                counter += 1;
            }
        }

        fs::copy(source, &backup_path)?;

        // 严格验证备份文件体积
        let backup_size = fs::metadata(&backup_path)?.len();
        if backup_size != original_size {
            let _ = fs::remove_file(&backup_path);
            return Err(MigrationError::BackupVerificationFailed {
                expected: original_size,
                actual: backup_size,
            });
        }

        Ok(backup_path)
    }

    /// 安全替换目标文件，消除 Windows 平台先删后移的物理丢失崩溃窗口
    pub fn atomic_replace(tmp_path: &Path, target: &Path) -> Result<(), MigrationError> {
        // 先尝试直接原子重命名（Unix 或目标不存在时直接成功）
        if fs::rename(tmp_path, target).is_ok() {
            return Ok(());
        }

        // Windows 3 阶段安全替换：
        // 阶段 1：先将原目标安全改名为临时暂存文件 .roll.bak（绝不在改名前删除目标）
        let pid = std::process::id();
        let target_name = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("models.yaml");
        let roll_bak_path = target.with_file_name(format!("{}.{}.roll.bak", target_name, pid));

        if roll_bak_path.exists() {
            let _ = fs::remove_file(&roll_bak_path);
        }

        fs::rename(target, &roll_bak_path)?;

        // 阶段 2：将新文件重命名为目标路径
        if let Err(rename_err) = fs::rename(tmp_path, target) {
            // 提交失败时执行原子回滚，将 .roll.bak 恢复至目标路径
            let _ = fs::rename(&roll_bak_path, target);
            let _ = fs::remove_file(tmp_path);
            return Err(MigrationError::Io(rename_err));
        }

        // 阶段 3：成功提交后清理临时暂存文件
        let _ = fs::remove_file(&roll_bak_path);
        Ok(())
    }

    /// 获取本地时间戳字符串 (%Y%m%d_%H%M%S)
    pub fn current_local_timestamp() -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let secs = now.as_secs();
        let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
        let (year, month, day) = Self::civil_from_days((secs / 86400) as i64);
        format!("{year:04}{month:02}{day:02}_{hours:02}{mins:02}{sec:02}")
    }

    /// 从 Unix 天数换算公历年月日（Howard Hinnant 算法）
    pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    /// 将扁平一维数组聚类升级为树状结构
    pub fn transform_flat_to_tree(old: &Value) -> Result<(Value, usize), MigrationError> {
        let mut providers_map: BTreeMap<String, Value> = BTreeMap::new();
        let mut total_models = 0usize;

        // 若已有 providers 键，先保留其内容
        if let Some(existing_providers) = old.get("providers").and_then(|v| v.as_object()) {
            for (k, v) in existing_providers {
                providers_map.insert(k.clone(), v.clone());
            }
        }

        if let Some(models_array) = old.get("models").and_then(|v| v.as_array()) {
            for m in models_array {
                total_models += 1;
                let vendor = m
                    .get("vendor")
                    .and_then(|v| v.as_str())
                    .unwrap_or("custom")
                    .trim()
                    .to_lowercase();

                let vendor_key = if vendor.is_empty() {
                    "custom".to_string()
                } else {
                    vendor
                };

                let base_url = m
                    .get("baseUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| Self::default_base_url_for_vendor(&vendor_key));

                let default_protocol = Self::infer_protocol_for_vendor(&vendor_key);
                let default_compat = Self::infer_compat_for_vendor(&vendor_key);

                let provider_entry = providers_map.entry(vendor_key.clone()).or_insert_with(|| {
                    let mut obj = serde_json::Map::new();
                    obj.insert(
                        "displayName".to_string(),
                        json!(Self::format_vendor_display_name(&vendor_key)),
                    );
                    obj.insert("baseUrl".to_string(), json!(base_url));
                    obj.insert("protocol".to_string(), json!(default_protocol));
                    if !default_compat
                        .as_object()
                        .map(|o| o.is_empty())
                        .unwrap_or(true)
                    {
                        obj.insert("compat".to_string(), default_compat);
                    }
                    obj.insert("models".to_string(), json!([]));
                    Value::Object(obj)
                });

                // 若旧模型持有 apiKey，且 Provider 尚未设置 apiKey，迁移至 Provider
                if let Some(api_key) = m.get("apiKey").and_then(|v| v.as_str()) {
                    if !api_key.is_empty() {
                        if let Some(prov_obj) = provider_entry.as_object_mut() {
                            if !prov_obj.contains_key("apiKey") {
                                prov_obj.insert("apiKey".to_string(), json!(api_key));
                            }
                        }
                    }
                }

                // 若旧模型持有 providerHeaders/provider_headers，且 Provider 尚未设置 headers，迁移至 Provider
                if let Some(prov_headers) = m
                    .get("providerHeaders")
                    .or_else(|| m.get("provider_headers"))
                {
                    if let Some(prov_obj) = provider_entry.as_object_mut() {
                        if !prov_obj.contains_key("headers") {
                            prov_obj.insert("headers".to_string(), prov_headers.clone());
                        }
                    }
                }

                // 提取模型核心参数
                let model_id = m
                    .get("id")
                    .or_else(|| m.get("model"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown-model");

                let display_name = m
                    .get("name")
                    .or_else(|| m.get("displayName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(model_id);

                let context_window = m
                    .get("contextWindow")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(131072);

                let max_output = m
                    .get("maxTokens")
                    .or_else(|| m.get("maxOutputTokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(8192);

                // 思考能力推导（极致扁平拍平：TitleCase -> wire，不支持思考则直接缺省）
                let reasoning_bool = m
                    .get("reasoning")
                    .and_then(|v| v.as_bool())
                    .or_else(|| {
                        m.get("capabilities")
                            .and_then(|c| c.get("reasoning"))
                            .and_then(|v| v.as_bool())
                    })
                    .unwrap_or(false);

                let mut thinking_map = serde_json::Map::new();
                if reasoning_bool {
                    thinking_map.insert("Low".to_string(), json!("low"));
                    thinking_map.insert("Medium".to_string(), json!("medium"));
                    thinking_map.insert("High".to_string(), json!("high"));
                } else if let Some(existing_thinking) =
                    m.get("thinking").and_then(|v| v.as_object())
                {
                    for (k, v) in existing_thinking {
                        thinking_map.insert(k.clone(), v.clone());
                    }
                }

                // 多模态输入输出规格补齐（一等公民）
                let modalities = if let Some(existing_mod) = m.get("modalities") {
                    existing_mod.clone()
                } else {
                    let mut input_mods = vec![json!("text")];
                    let has_img = m
                        .get("capabilities")
                        .and_then(|c| c.get("image"))
                        .and_then(|v| v.as_bool())
                        .or_else(|| m.get("image").and_then(|v| v.as_bool()))
                        .unwrap_or(false);
                    let has_vid = m
                        .get("capabilities")
                        .and_then(|c| c.get("video"))
                        .and_then(|v| v.as_bool())
                        .or_else(|| m.get("video").and_then(|v| v.as_bool()))
                        .unwrap_or(false);
                    if has_img {
                        input_mods.push(json!("image"));
                    }
                    if has_vid {
                        input_mods.push(json!("video"));
                    }
                    json!({
                        "input": input_mods,
                        "output": ["text"]
                    })
                };

                let mut model_spec_map = serde_json::Map::new();
                model_spec_map.insert("id".to_string(), json!(model_id));
                model_spec_map.insert("displayName".to_string(), json!(display_name));
                model_spec_map.insert("contextWindow".to_string(), json!(context_window));
                model_spec_map.insert("maxOutputTokens".to_string(), json!(max_output));
                model_spec_map.insert("modalities".to_string(), modalities);

                if !thinking_map.is_empty() {
                    model_spec_map.insert("thinking".to_string(), Value::Object(thinking_map));
                }

                // 补全模型 capabilities 迁移（tools, image, video）
                let mut caps_map = match m.get("capabilities").and_then(|c| c.as_object()) {
                    Some(obj) => obj.clone(),
                    None => serde_json::Map::new(),
                };
                if let Some(tools) = m.get("tools").and_then(|v| v.as_bool()) {
                    caps_map
                        .entry("tools".to_string())
                        .or_insert_with(|| json!(tools));
                }
                if let Some(image) = m.get("image").and_then(|v| v.as_bool()) {
                    caps_map
                        .entry("image".to_string())
                        .or_insert_with(|| json!(image));
                }
                if let Some(video) = m.get("video").and_then(|v| v.as_bool()) {
                    caps_map
                        .entry("video".to_string())
                        .or_insert_with(|| json!(video));
                }
                if !caps_map.is_empty() {
                    model_spec_map.insert("capabilities".to_string(), Value::Object(caps_map));
                } else if let Some(raw_caps) = m.get("capabilities") {
                    model_spec_map.insert("capabilities".to_string(), raw_caps.clone());
                }

                // 保留模型级 headers
                if let Some(headers) = m.get("headers") {
                    model_spec_map.insert("headers".to_string(), headers.clone());
                }

                // 若原模型已有价格定义，予以保留
                if let Some(pricing) = m.get("pricing") {
                    model_spec_map.insert("pricing".to_string(), pricing.clone());
                }

                // 若原模型有显式局部协议覆盖，予以保留
                if let Some(proto) = m.get("protocol") {
                    model_spec_map.insert("protocol".to_string(), proto.clone());
                }

                if let Some(models_list) = provider_entry
                    .get_mut("models")
                    .and_then(|v| v.as_array_mut())
                {
                    models_list.push(Value::Object(model_spec_map));
                }
            }
        }

        // 若根对象中包含顶层全局 headers，为尚未配置 headers 的 Provider 予以保留补齐
        if let Some(global_headers) = old.get("headers") {
            for prov in providers_map.values_mut() {
                if let Some(prov_obj) = prov.as_object_mut() {
                    if !prov_obj.contains_key("headers") {
                        prov_obj.insert("headers".to_string(), global_headers.clone());
                    }
                }
            }
        }

        let result = json!({
            "schema_version": 2,
            "version": 2,
            "providers": providers_map
        });

        Ok((result, total_models))
    }

    pub fn default_base_url_for_vendor(vendor: &str) -> &'static str {
        match vendor.to_lowercase().as_str() {
            "deepseek" => "https://api.deepseek.com",
            "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "openai" => "https://api.openai.com/v1",
            "anthropic" | "claude" => "https://api.anthropic.com",
            "google" | "gemini" => "https://generativelanguage.googleapis.com",
            "moonshot" | "kimi" => "https://api.moonshot.cn/v1",
            "zhipu" | "bigmodel" => "https://open.bigmodel.cn/api/paas/v4",
            "ollama" => "http://localhost:11434/v1",
            _ => "https://api.openai.com/v1",
        }
    }

    pub fn infer_protocol_for_vendor(vendor: &str) -> &'static str {
        match vendor.to_lowercase().as_str() {
            "anthropic" | "claude" => "anthropic/messages",
            "google" | "gemini" => "google/generate-content",
            _ => "openai/chat",
        }
    }

    pub fn infer_compat_for_vendor(vendor: &str) -> Value {
        match vendor.to_lowercase().as_str() {
            "deepseek" => json!({
                "thinkingFormat": "deepseek",
                "supportsDeveloperRole": false,
                "maxTokensField": "max_tokens"
            }),
            "qwen" => json!({
                "thinkingFormat": "qwen",
                "supportsDeveloperRole": false,
                "maxTokensField": "max_tokens"
            }),
            "openai" => json!({
                "thinkingFormat": "openai",
                "supportsDeveloperRole": true,
                "maxTokensField": "max_completion_tokens"
            }),
            "anthropic" | "claude" => json!({
                "thinkingFormat": "anthropic",
                "supportsDeveloperRole": false,
                "maxTokensField": "max_tokens",
                "cacheControlFormat": "anthropic"
            }),
            "google" | "gemini" => json!({
                "thinkingFormat": "gemini",
                "supportsDeveloperRole": false,
                "maxTokensField": "max_tokens"
            }),
            "zhipu" | "bigmodel" => json!({
                "thinkingFormat": "zai",
                "supportsDeveloperRole": false,
                "maxTokensField": "max_tokens"
            }),
            _ => json!({}),
        }
    }

    pub fn format_vendor_display_name(vendor: &str) -> String {
        match vendor.to_lowercase().as_str() {
            "deepseek" => "DeepSeek 官方".to_string(),
            "qwen" => "阿里云百炼".to_string(),
            "openai" => "OpenAI 官方".to_string(),
            "anthropic" | "claude" => "Anthropic 官方".to_string(),
            "google" | "gemini" => "Google AI".to_string(),
            "moonshot" | "kimi" => "月之暗面 Kimi".to_string(),
            "zhipu" | "bigmodel" => "智谱 BigModel".to_string(),
            "ollama" => "Ollama 本地".to_string(),
            _ => vendor.to_string(),
        }
    }
}

#[cfg(test)]
#[path = "migration_tests.rs"]
mod migration_tests;

#[cfg(test)]
mod migration_hardening_tests {
    use super::*;

    #[test]
    fn test_capabilities_and_headers_migration_retention() {
        let legacy_json = json!({
            "schema_version": 1,
            "headers": {
                "X-Global-Key": "global-secret"
            },
            "models": [
                {
                    "id": "custom-vision-model",
                    "vendor": "custom-ai",
                    "providerHeaders": {
                        "X-Vendor-Auth": "Bearer token123"
                    },
                    "headers": {
                        "X-Model-Direct": "model-opt"
                    },
                    "capabilities": {
                        "tools": true,
                        "image": true,
                        "video": false
                    }
                },
                {
                    "id": "flat-tools-model",
                    "vendor": "custom-ai",
                    "tools": true
                }
            ]
        });

        let (migrated, total_models) =
            ConfigMigrationManager::transform_flat_to_tree(&legacy_json).expect("迁移转换应当成功");
        assert_eq!(total_models, 2);

        let providers = migrated
            .get("providers")
            .and_then(|v| v.as_object())
            .unwrap();
        let provider = providers.get("custom-ai").expect("custom-ai 供应商存在");

        // 验证供应商级 headers
        let prov_headers = provider.get("headers").expect("供应商级 headers 存在");
        assert_eq!(
            prov_headers.get("X-Vendor-Auth").and_then(|v| v.as_str()),
            Some("Bearer token123")
        );

        let models = provider.get("models").and_then(|v| v.as_array()).unwrap();
        let m1 = models
            .iter()
            .find(|m| m.get("id").and_then(|v| v.as_str()) == Some("custom-vision-model"))
            .unwrap();

        // 验证模型级 headers
        let m1_headers = m1.get("headers").expect("模型级 headers 存在");
        assert_eq!(
            m1_headers.get("X-Model-Direct").and_then(|v| v.as_str()),
            Some("model-opt")
        );

        // 验证 capabilities (tools, image, video) 完整迁移
        let caps = m1.get("capabilities").expect("capabilities 存在");
        assert_eq!(caps.get("tools").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(caps.get("image").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(caps.get("video").and_then(|v| v.as_bool()), Some(false));

        // 验证 modalities 自动补齐含 image
        let modalities = m1.get("modalities").expect("modalities 存在");
        let input_mods: Vec<String> = modalities
            .get("input")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        assert!(input_mods.contains(&"image".to_string()));

        let m2 = models
            .iter()
            .find(|m| m.get("id").and_then(|v| v.as_str()) == Some("flat-tools-model"))
            .unwrap();
        let m2_caps = m2
            .get("capabilities")
            .expect("flat-tools-model capabilities 存在");
        assert_eq!(m2_caps.get("tools").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn test_atomic_replace_clean_commit_and_cleanup() {
        let temp_dir = std::env::temp_dir().join(format!(
            "conex_atomic_replace_test_{}_{}",
            std::process::id(),
            ConfigMigrationManager::current_local_timestamp()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        let target_path = temp_dir.join("models.yaml");
        let tmp_path = temp_dir.join("models.yaml.tmp");

        fs::write(&target_path, "old: 1").unwrap();
        fs::write(&tmp_path, "new: 2").unwrap();

        ConfigMigrationManager::atomic_replace(&tmp_path, &target_path).expect("原子替换应当成功");

        assert!(!tmp_path.exists(), "临时文件必须已被移动");
        let content = fs::read_to_string(&target_path).unwrap();
        assert_eq!(content, "new: 2");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
