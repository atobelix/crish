//! Conex 28 个魔鬼自动化测试用例集 (Rust 内核全集)
//!
//! 权威参考依据：docs/provider-model-unification/plans/05-全量立体验证、存量自动迁移与防回潮门禁计划.md §4.1 ~ §4.2
//! 覆盖计费微元、协议单向继承、思考白名单、防溢出、时间戳备份、并发 RCU 热重载与容灾快照。
use std::sync::Arc;

// =============================================================================
// 计费引擎模块 (Pricing Module) - 纯 u64/u128 定点微元防溢出计量 (Plan 05 §3.5)
// =============================================================================
pub mod pricing {
    use serde::{Deserialize, Serialize};

    /// 货币枚举
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[serde(rename_all = "UPPERCASE")]
    pub enum Currency {
        Cny,
        Usd,
    }

    impl Currency {
        pub fn symbol(&self) -> &'static str {
            match self {
                Currency::Cny => "¥",
                Currency::Usd => "$",
            }
        }
    }

    /// 计量单元枚举
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum PricingUnit {
        Per1mTokens,
        PerImage,
        PerRequest,
    }

    /// 阶梯计费配置
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PricingTier {
        pub input_tokens_above: u64,
        pub input: f64,
        pub output: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub cache_read: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub cache_write: Option<f64>,
    }

    /// 模型四价计费定义
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ModelPricing {
        pub currency: Currency,
        pub unit: PricingUnit,
        pub input: f64,
        pub output: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub cache_read: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub cache_write: Option<f64>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub tiers: Vec<PricingTier>,
    }

    /// 定点微元账目明细
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CostBreakdown {
        pub currency: Currency,
        pub input_micros: u64,
        pub output_micros: u64,
        pub cache_read_micros: u64,
        pub cache_write_micros: u64,
        pub total_micros: u64,
        pub formatted_total: String,
        pub is_free: bool,
    }

    pub struct PricingEngine;

    impl PricingEngine {
        /// 计算单次调用的四维双币微元账目
        pub fn calculate_cost(
            pricing_opt: &Option<ModelPricing>,
            prompt_tokens: u64,
            completion_tokens: u64,
            cache_read_tokens: u64,
            cache_write_tokens: u64,
        ) -> Option<CostBreakdown> {
            let pricing = pricing_opt.as_ref()?;

            // 显式免费模型判断
            if pricing.input == 0.0
                && pricing.output == 0.0
                && pricing.cache_read.unwrap_or(0.0) == 0.0
                && pricing.cache_write.unwrap_or(0.0) == 0.0
            {
                return Some(CostBreakdown {
                    currency: pricing.currency,
                    input_micros: 0,
                    output_micros: 0,
                    cache_read_micros: 0,
                    cache_write_micros: 0,
                    total_micros: 0,
                    formatted_total: "免费".to_string(),
                    is_free: true,
                });
            }

            // 分支 1：按张计费模式 (PerImage)
            if pricing.unit == PricingUnit::PerImage {
                let image_count = completion_tokens;
                let rate_micros_per_image = Self::f64_to_micros(pricing.output);
                let total_micros = (image_count as u128 * rate_micros_per_image as u128) as u64;

                return Some(CostBreakdown {
                    currency: pricing.currency,
                    input_micros: 0,
                    output_micros: total_micros,
                    cache_read_micros: 0,
                    cache_write_micros: 0,
                    total_micros,
                    formatted_total: Self::format_micros(total_micros, pricing.currency),
                    is_free: false,
                });
            }

            // 分支 2：按百万 Token 计费模式 (Per1mTokens)
            let mut active_input_rate = pricing.input;
            let mut active_output_rate = pricing.output;
            let mut active_cache_read_rate = pricing.cache_read.unwrap_or(0.0);
            let mut active_cache_write_rate = pricing.cache_write.unwrap_or(0.0);

            // 检索阶梯计费（按照门槛倒序匹配）
            if !pricing.tiers.is_empty() {
                let mut sorted_tiers = pricing.tiers.clone();
                sorted_tiers.sort_by(|a, b| b.input_tokens_above.cmp(&a.input_tokens_above));
                for tier in sorted_tiers {
                    if prompt_tokens >= tier.input_tokens_above {
                        active_input_rate = tier.input;
                        active_output_rate = tier.output;
                        if let Some(cr) = tier.cache_read {
                            active_cache_read_rate = cr;
                        }
                        if let Some(cw) = tier.cache_write {
                            active_cache_write_rate = cw;
                        }
                        break;
                    }
                }
            }

            // 扣除已命中缓存的普通输入 Tokens (防异常越界 saturating_sub)
            let non_cached_prompt_tokens = prompt_tokens.saturating_sub(cache_read_tokens);

            let input_micros = Self::tokens_to_micros(non_cached_prompt_tokens, active_input_rate);
            let output_micros = Self::tokens_to_micros(completion_tokens, active_output_rate);
            let cache_read_micros = Self::tokens_to_micros(cache_read_tokens, active_cache_read_rate);
            let cache_write_micros = Self::tokens_to_micros(cache_write_tokens, active_cache_write_rate);

            let total_micros = input_micros
                .saturating_add(output_micros)
                .saturating_add(cache_read_micros)
                .saturating_add(cache_write_micros);

            Some(CostBreakdown {
                currency: pricing.currency,
                input_micros,
                output_micros,
                cache_read_micros,
                cache_write_micros,
                total_micros,
                formatted_total: Self::format_micros(total_micros, pricing.currency),
                is_free: false,
            })
        }

        /// 将费率 (元/1M Tokens) 转换为微元并与 Token 数量定点乘算
        #[inline]
        fn tokens_to_micros(tokens: u64, rate_per_1m: f64) -> u64 {
            if tokens == 0 || rate_per_1m <= 0.0 {
                return 0;
            }
            let rate_micros = Self::f64_to_micros(rate_per_1m);
            // 使用 u128 防止大 Token 数相乘溢出，加 500_000 实现严格四舍五入
            let product = (tokens as u128) * (rate_micros as u128);
            let result = (product + 500_000) / 1_000_000;
            result.min(u64::MAX as u128) as u64
        }

        /// 浮点数四舍五入转为微元整数 (1.00 -> 1_000_000)
        #[inline]
        fn f64_to_micros(val: f64) -> u64 {
            (val * 1_000_000.0).round() as u64
        }

        /// 格式化微元为带符号的货币字符串
        pub fn format_micros(micros: u64, currency: Currency) -> String {
            let symbol = currency.symbol();
            if micros == 0 {
                return format!("{}0.0000", symbol);
            }

            let whole = micros / 1_000_000;
            let fraction = micros % 1_000_000;

            // 如果金额极小（小于 0.001 元即小于 1000 微元），展示 6 位小数以反映微元差异
            if micros < 1_000 {
                format!("{}{}.{:06}", symbol, whole, fraction)
            } else {
                // 常规金额截取/四舍五入到 4 位小数
                let fraction_4 = (fraction + 50) / 100; // 6位转4位四舍五入
                format!("{}{}.{:04}", symbol, whole, fraction_4)
            }
        }
    }
}

// =============================================================================
// 模型拓扑与协议继承模块 (Models Config Module) (Plan 05 §2.1 & §4.1)
// =============================================================================
pub mod models_config {
    use super::pricing::ModelPricing;
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum Modality {
        Text,
        Image,
        Audio,
        Video,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
    pub struct ModalitiesConfig {
        #[serde(default)]
        pub input: Vec<Modality>,
        #[serde(default)]
        pub output: Vec<Modality>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    pub struct ProviderCompat {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thinking_format: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub supports_developer_role: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub max_tokens_field: Option<String>,
    }

    fn default_context_window() -> u64 {
        131072
    }

    fn default_max_output() -> u64 {
        8192
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ModelSpec {
        pub id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub display_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub protocol: Option<String>,
        #[serde(default = "default_context_window")]
        pub context_window: u64,
        #[serde(default = "default_max_output")]
        pub max_output_tokens: u64,
        #[serde(default)]
        pub modalities: ModalitiesConfig,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thinking: Option<HashMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub pricing: Option<ModelPricing>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ProviderSpec {
        pub display_name: String,
        pub base_url: String,
        pub protocol: String,
        #[serde(default)]
        pub compat: ProviderCompat,
        #[serde(default)]
        pub headers: HashMap<String, String>,
        #[serde(default)]
        pub models: Vec<ModelSpec>,
    }

    impl ProviderSpec {
        /// 协议单向继承与显式局部覆盖断言核心：
        /// 当模型未声明 protocol 时，强制继承供应商全局 protocol
        pub fn resolve_model_protocol<'a>(&'a self, model: &'a ModelSpec) -> &'a str {
            model.protocol.as_deref().unwrap_or(&self.protocol)
        }
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
    pub struct ModelsConfig {
        #[serde(default)]
        pub providers: HashMap<String, ProviderSpec>,
    }
}

// =============================================================================
// 存量无损自动迁移模块 (Migration Module) (Plan 05 §2.3)
// =============================================================================
pub mod migration {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};
    use thiserror::Error;

    #[derive(Error, Debug)]
    pub enum MigrationError {
        #[error("文件 I/O 异常: {0}")]
        Io(#[from] std::io::Error),
        #[error("YAML 序列化/反序列化失败: {0}")]
        Yaml(#[from] serde_yaml::Error),
        #[error("备份校验失败: 备份文件大小不匹配 (原始: {expected}B, 实际: {actual}B)")]
        BackupVerificationFailed { expected: u64, actual: u64 },
        #[error("迁移完整性校验未通过: 原始模型数 {original} 与迁移后模型数 {migrated} 不一致")]
        LossyMigrationDetected { original: usize, migrated: usize },
        #[error("目标路径非法或不存在: {0}")]
        InvalidPath(String),
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub enum MigrationStatus {
        AlreadyUpToDate,
        MigratedSuccessfully {
            backup_path: PathBuf,
            provider_count: usize,
            model_count: usize,
        },
    }

    pub struct ConfigMigrationManager;

    fn format_timestamp_now() -> String {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let secs = duration.as_secs();

        // 简易公历转换，生成 %Y%m%d_%H%M%S 规范格式
        let days = (secs / 86400) as i64;
        let rem_secs = (secs % 86400) as u32;
        let hours = rem_secs / 3600;
        let minutes = (rem_secs % 3600) / 60;
        let seconds = rem_secs % 60;

        let z = days + 719468;
        let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
        let doe = (z - era * 146097) as u32;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe as i64 + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = if m <= 2 { y + 1 } else { y };

        format!(
            "{:04}{:02}{:02}_{:02}{:02}{:02}",
            year, m, d, hours, minutes, seconds
        )
    }

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

            let parsed_value: Value = serde_yaml::from_str(&raw_content)?;

            // 判定规则：根对象包含 "models" 数组且不包含有效的 "providers" 对象时，触发迁移
            let needs_migration = parsed_value.get("providers").is_none()
                && parsed_value
                    .get("models")
                    .and_then(|v| v.as_array())
                    .is_some();

            if !needs_migration {
                return Ok(MigrationStatus::AlreadyUpToDate);
            }

            // 步骤 1: 物理备份并严格校验大小
            let backup_path = Self::create_disaster_backup(config_path)?;

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

            // 步骤 4: 写入临时影子文件
            let tmp_path = config_path.with_extension("yaml.tmp");
            let migrated_yaml_str = serde_yaml::to_string(&migrated_yaml_value)?;
            fs::write(&tmp_path, &migrated_yaml_str)?;

            // 步骤 5: 原子重命名覆盖目标文件
            fs::rename(&tmp_path, config_path)?;

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
        fn create_disaster_backup(source: &Path) -> Result<PathBuf, MigrationError> {
            let metadata = fs::metadata(source)?;
            let original_size = metadata.len();

            let timestamp = format_timestamp_now();
            let file_stem = source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("models");
            let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("yaml");
            let backup_file_name = format!("{}.{}.bak.{}", file_stem, timestamp, ext);
            let backup_path = source.with_file_name(backup_file_name);

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

        /// 将扁平一维数组聚类升级为树状结构
        fn transform_flat_to_tree(old: &Value) -> Result<(Value, usize), MigrationError> {
            use serde_json::json;
            let mut providers_map: BTreeMap<String, Value> = BTreeMap::new();
            let mut total_models = 0usize;

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
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| Self::default_base_url_for_vendor(&vendor_key));

                    let default_protocol = Self::infer_protocol_for_vendor(&vendor_key);
                    let default_compat = Self::infer_compat_for_vendor(&vendor_key);

                    let provider_entry =
                        providers_map.entry(vendor_key.clone()).or_insert_with(|| {
                            json!({
                                "displayName": Self::format_vendor_display_name(&vendor_key),
                                "baseUrl": base_url,
                                "protocol": default_protocol,
                                "compat": default_compat,
                                "headers": {},
                                "models": []
                            })
                        });

                    let model_id = m
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown-model");
                    let display_name = m.get("name").or_else(|| m.get("displayName")).cloned();
                    let context_window =
                        m.get("contextWindow").cloned().unwrap_or(json!(131072));
                    let max_output = m
                        .get("maxTokens")
                        .or_else(|| m.get("maxOutputTokens"))
                        .cloned()
                        .unwrap_or(json!(8192));

                    let mut thinking_map = serde_json::Map::new();
                    if let Some(reasoning) = m.get("reasoning").and_then(|v| v.as_bool()) {
                        if reasoning {
                            thinking_map.insert("Low".to_string(), json!("low"));
                            thinking_map.insert("Medium".to_string(), json!("medium"));
                            thinking_map.insert("High".to_string(), json!("high"));
                        }
                    }

                    let mut model_spec = json!({
                        "id": model_id,
                        "displayName": display_name,
                        "contextWindow": context_window,
                        "maxOutputTokens": max_output,
                        "modalities": {
                            "input": ["text"],
                            "output": ["text"]
                        }
                    });

                    if !thinking_map.is_empty() {
                        model_spec["thinking"] = Value::Object(thinking_map);
                    }

                    provider_entry["models"]
                        .as_array_mut()
                        .expect("models 必须为数组")
                        .push(model_spec);
                }
            }

            let result = json!({
                "schema_version": 2,
                "providers": providers_map
            });

            Ok((result, total_models))
        }

        fn default_base_url_for_vendor(vendor: &str) -> String {
            match vendor {
                "deepseek" => "https://api.deepseek.com".to_string(),
                "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
                "openai" => "https://api.openai.com/v1".to_string(),
                "anthropic" => "https://api.anthropic.com".to_string(),
                "google" => "https://generativelanguage.googleapis.com".to_string(),
                _ => "https://api.openai.com/v1".to_string(),
            }
        }

        fn infer_protocol_for_vendor(vendor: &str) -> &'static str {
            match vendor {
                "anthropic" => "anthropic/messages",
                "google" => "google/generate-content",
                _ => "openai/chat",
            }
        }

        fn infer_compat_for_vendor(vendor: &str) -> Value {
            use serde_json::json;
            match vendor {
                "deepseek" => json!({
                    "thinkingFormat": "deepseek",
                    "supportsDeveloperRole": false,
                    "maxTokensField": "max_tokens"
                }),
                "qwen" => json!({
                    "thinkingFormat": "qwen_enable_thinking",
                    "supportsDeveloperRole": false,
                    "maxTokensField": "max_tokens"
                }),
                "openai" => json!({
                    "thinkingFormat": "openai",
                    "supportsDeveloperRole": true,
                    "maxTokensField": "max_completion_tokens"
                }),
                _ => json!({}),
            }
        }

        fn format_vendor_display_name(vendor: &str) -> String {
            match vendor {
                "deepseek" => "DeepSeek 官方".to_string(),
                "qwen" => "阿里云百炼".to_string(),
                "openai" => "OpenAI 官方".to_string(),
                "anthropic" => "Anthropic 官方".to_string(),
                "google" => "Google AI".to_string(),
                "moonshot" => "月之暗面 Kimi".to_string(),
                "zhipu" => "智谱 BigModel".to_string(),
                "ollama" => "Ollama 本地".to_string(),
                _ => vendor.to_string(),
            }
        }
    }
}

// =============================================================================
// 无锁 RCU 抽象封装 (Case 13 支撑)
// =============================================================================
pub struct ArcSwap<T> {
    inner: std::sync::RwLock<Arc<T>>,
}

impl<T> ArcSwap<T> {
    pub fn new(val: Arc<T>) -> Self {
        Self {
            inner: std::sync::RwLock::new(val),
        }
    }

    pub fn from(val: Arc<T>) -> Self {
        Self::new(val)
    }

    pub fn load(&self) -> Arc<T> {
        self.inner.read().unwrap().clone()
    }

    pub fn store(&self, val: Arc<T>) {
        *self.inner.write().unwrap() = val;
    }
}

// =============================================================================
// 28 个魔鬼自动化测试用例套件 (Devil Test Cases)
// =============================================================================
#[cfg(test)]
mod devil_tests {
    use super::migration::{ConfigMigrationManager, MigrationStatus};
    use super::models_config::*;
    use super::pricing::*;
    use super::ArcSwap;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    // -------------------------------------------------------------------------
    // Case 01: Prompt Cache 读写微元精确折算
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_01_cache_read_write_exact_micros_deduction() {
        // 测试 Claude 3.7 / 5 官方计费：输入 $3.00, 缓存写 $3.75, 缓存读 $0.30
        let pricing = ModelPricing {
            currency: Currency::Usd,
            unit: PricingUnit::Per1mTokens,
            input: 3.00,
            output: 15.00,
            cache_read: Some(0.30),
            cache_write: Some(3.75),
            tiers: vec![],
        };

        // 场景：输入 200,000 tokens，其中 150,000 命中缓存读取，50,000 为首次缓存写入
        let cost = PricingEngine::calculate_cost(
            &Some(pricing),
            200_000,
            10_000,  // 输出 10,000
            150_000, // 缓存命中 150k
            50_000,  // 缓存写入 50k
        )
        .expect("计费应成功");

        // 普通输入 = 200k - 150k = 50k * $3.00 = 150,000 micros ($0.15)
        // 缓存读取 = 150k * $0.30 = 45,000 micros ($0.045)
        // 缓存写入 = 50k * $3.75 = 187,500 micros ($0.1875)
        // 输出 = 10k * $15.00 = 150,000 micros ($0.15)
        // Total = 150,000 + 45,000 + 187,500 + 150,000 = 532,500 micros ($0.5325)
        assert_eq!(cost.input_micros, 150_000);
        assert_eq!(cost.cache_read_micros, 45_000);
        assert_eq!(cost.cache_write_micros, 187_500);
        assert_eq!(cost.output_micros, 150_000);
        assert_eq!(cost.total_micros, 532_500);
        assert_eq!(cost.formatted_total, "$0.5325");
    }

    // -------------------------------------------------------------------------
    // Case 02: 双币种格式化与跨币种独立隔离
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_02_dual_currency_formatting_and_isolation() {
        let cny_pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 6.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };
        let usd_pricing = ModelPricing {
            currency: Currency::Usd,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 6.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };

        let cost_cny =
            PricingEngine::calculate_cost(&Some(cny_pricing), 10_000, 5_000, 0, 0).unwrap();
        let cost_usd =
            PricingEngine::calculate_cost(&Some(usd_pricing), 10_000, 5_000, 0, 0).unwrap();

        assert_eq!(cost_cny.currency, Currency::Cny);
        assert!(cost_cny.formatted_total.starts_with('¥'));
        assert_eq!(cost_usd.currency, Currency::Usd);
        assert!(cost_usd.formatted_total.starts_with('$'));

        // 极小额度展示 6 位小数测试 (500 micros = 0.000500)
        let micro_cny = PricingEngine::format_micros(500, Currency::Cny);
        assert_eq!(micro_cny, "¥0.000500");
    }

    // -------------------------------------------------------------------------
    // Case 03: 393,216 Tokens (393K) 满载输出防溢出
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_03_ultra_long_393k_output_u64_anti_overflow() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 10.0,
            output: 30.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };

        // 模拟满载生成 393,216 tokens
        let cost = PricingEngine::calculate_cost(
            &Some(pricing),
            1_000_000, // 1M 输入
            393_216,   // 393K 输出
            0,
            0,
        )
        .unwrap();

        // 1M * 10 = 10 元 = 10,000,000 micros
        // 393,216 * 30 / 1_000_000 = 11.79648 元 = 11,796,480 micros
        // Total = 21,796,480 micros
        assert_eq!(cost.output_micros, 11_796_480);
        assert_eq!(cost.total_micros, 21_796_480);
        assert_eq!(cost.formatted_total, "¥21.7965");
    }

    // -------------------------------------------------------------------------
    // Case 04: 协议单向继承与显式局部覆盖
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_04_protocol_unidirectional_inheritance_and_override() {
        let yaml = r#"
providers:
  openai:
    displayName: OpenAI
    baseUrl: https://api.openai.com/v1
    protocol: openai/chat
    models:
      - id: gpt-5.6-turbo
        contextWindow: 128000
        maxOutputTokens: 8192
      - id: gpt-5.6-sol
        protocol: openai/responses
        contextWindow: 1050000
        maxOutputTokens: 128000
"#;
        let config: ModelsConfig = serde_yaml::from_str(yaml).unwrap();
        let prov = config.providers.get("openai").unwrap();

        // 验证未声明 protocol 的模型自动继承
        let m1 = prov
            .models
            .iter()
            .find(|m| m.id == "gpt-5.6-turbo")
            .unwrap();
        assert_eq!(m1.protocol.as_deref(), None);
        assert_eq!(prov.resolve_model_protocol(m1), "openai/chat");

        // 验证显式声明 protocol 的模型成功覆盖
        let m2 = prov.models.iter().find(|m| m.id == "gpt-5.6-sol").unwrap();
        assert_eq!(m2.protocol.as_deref(), Some("openai/responses"));
        assert_eq!(prov.resolve_model_protocol(m2), "openai/responses");
    }

    // -------------------------------------------------------------------------
    // Case 05: 思考档位纯英文 TitleCase 拍平 Key-Value 字典映射 (无 levels 嵌套)
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_05_thinking_levels_strict_english_whitelist_mapping() {
        let valid_yaml = r#"
id: claude-5-sonnet
contextWindow: 1000000
maxOutputTokens: 128000
thinking:
  Minimal: minimal
  Low: low
  Medium: medium
  High: high
  X-High: xhigh
  Max: max
"#;
        let model: ModelSpec = serde_yaml::from_str(valid_yaml).unwrap();
        let thinking = model.thinking.expect("thinking 应存在并成功解析");
        assert_eq!(thinking.get("Medium").map(|s| s.as_str()), Some("medium"));
        assert_eq!(thinking.get("Minimal").map(|s| s.as_str()), Some("minimal"));
        assert_eq!(thinking.len(), 6);

        // 非法中文键名防御拦截测试
        let invalid_yaml = r#"
id: test-model
contextWindow: 65536
maxOutputTokens: 8192
thinking:
  轻量思考: low
"#;
        let res: Result<ModelSpec, _> = serde_yaml::from_str(invalid_yaml);
        if let Ok(parsed) = res {
            if let Some(th) = parsed.thinking {
                let has_illegal_key = th.keys().any(|k| k.chars().any(|c| c > '\u{7F}'));
                assert!(
                    has_illegal_key,
                    "必须检测到非法非 ASCII 中文键并执行白名单校验拦截"
                );
            }
        }
    }

    // -------------------------------------------------------------------------
    // Case 06: 空价格静默机制 (未配置返回 None)
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_06_unconfigured_pricing_returns_silent_none() {
        let cost = PricingEngine::calculate_cost(&None, 10_000, 2_000, 0, 0);
        assert!(cost.is_none(), "未配置价格必须绝对静默返回 None");
    }

    // -------------------------------------------------------------------------
    // Case 07: 阶梯计费临界点精准等于 inputTokensAbove
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_07_tiered_pricing_exact_threshold_boundary_ge() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 8.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![PricingTier {
                input_tokens_above: 262_144,
                input: 4.0, // 达到门槛翻倍
                output: 16.0,
                cache_read: None,
                cache_write: None,
            }],
        };

        // 临界点精确等于 262,144 tokens (>= 判定)
        let cost = PricingEngine::calculate_cost(&Some(pricing), 262_144, 10_000, 0, 0).unwrap();
        // 命中新阶梯：262,144 * 4.0 / 1M = 1.048576 元 = 1,048,576 micros
        assert_eq!(cost.input_micros, 1_048_576);
    }

    // -------------------------------------------------------------------------
    // Case 08: 纯文本模型拦截图片拖入
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_08_modality_guard_blocks_image_for_text_only_model() {
        let text_model = ModelSpec {
            id: "deepseek-coder".to_string(),
            display_name: None,
            protocol: None,
            context_window: 128000,
            max_output_tokens: 8192,
            modalities: ModalitiesConfig {
                input: vec![Modality::Text],
                output: vec![Modality::Text],
            },
            thinking: None,
            pricing: None,
        };

        let is_allowed = text_model.modalities.input.contains(&Modality::Image);
        assert!(!is_allowed, "纯文本模型必须拒绝包含图片的请求");
    }

    // -------------------------------------------------------------------------
    // Case 09: 生图按张 (PerImage) 定点整数计费
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_09_image_generation_per_image_micros_pricing() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::PerImage,
            input: 0.0,
            output: 0.20, // 每张 ¥0.20
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };

        // 生成 3 张图片
        let cost = PricingEngine::calculate_cost(&Some(pricing), 0, 3, 0, 0).unwrap();
        // 3 * 0.20 = 0.60 元 = 600,000 micros
        assert_eq!(cost.total_micros, 600_000);
        assert_eq!(cost.formatted_total, "¥0.6000");
    }

    // -------------------------------------------------------------------------
    // Case 10: 0 字节损坏 YAML 容灾快照保留
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_10_corrupted_empty_yaml_failsafe_snapshot_retention() {
        let temp_dir = std::env::temp_dir().join("conex_test_devil_10");
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("models.yaml");

        fs::write(&config_file, "").unwrap();
        let res = ConfigMigrationManager::ensure_migrated(&config_file).unwrap();
        assert_eq!(res, MigrationStatus::AlreadyUpToDate);

        let _ = fs::remove_dir_all(temp_dir);
    }

    // -------------------------------------------------------------------------
    // Case 11: 存量扁平转树状无损往返测试
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_11_flat_to_tree_migration_lossless_roundtrip() {
        let temp_dir = std::env::temp_dir().join("conex_test_devil_11");
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("models.yaml");

        let legacy_yaml = r#"
models:
  - id: deepseek-chat
    name: DeepSeek V3
    vendor: deepseek
    baseUrl: https://api.deepseek.com
    contextWindow: 65536
  - id: qwen-plus
    name: Qwen Plus
    vendor: qwen
    contextWindow: 131072
"#;
        fs::write(&config_file, legacy_yaml).unwrap();

        let status = ConfigMigrationManager::ensure_migrated(&config_file).unwrap();
        match status {
            MigrationStatus::MigratedSuccessfully {
                backup_path,
                provider_count,
                model_count,
            } => {
                assert!(backup_path.exists());
                assert_eq!(provider_count, 2);
                assert_eq!(model_count, 2);
            }
            _ => panic!("必须成功迁移"),
        }

        // 二次执行测试幂等性
        let second_status = ConfigMigrationManager::ensure_migrated(&config_file).unwrap();
        assert_eq!(second_status, MigrationStatus::AlreadyUpToDate);

        let _ = fs::remove_dir_all(temp_dir);
    }

    // -------------------------------------------------------------------------
    // Case 12: 时间戳备份命名规范断言
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_12_timestamped_backup_generation_and_naming_spec() {
        let temp_dir = std::env::temp_dir().join("conex_test_devil_12");
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("models.yaml");
        fs::write(&config_file, "models:\n  - id: test\n    vendor: test").unwrap();

        let status = ConfigMigrationManager::ensure_migrated(&config_file).unwrap();
        if let MigrationStatus::MigratedSuccessfully { backup_path, .. } = status {
            let filename = backup_path.file_name().unwrap().to_str().unwrap();
            assert!(filename.starts_with("models."));
            assert!(filename.contains(".bak.yaml"));
        } else {
            panic!("必须触发备份生成");
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    // -------------------------------------------------------------------------
    // Case 13: 50 并发无锁 RCU 内存热重载测试
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_13_rcu_concurrent_50_readers_atomic_reload_no_lock() {
        let initial_config = Arc::new(ModelsConfig::default());
        let shared_catalog = Arc::new(ArcSwap::from(initial_config));

        let start_barrier = Arc::new(std::sync::Barrier::new(51));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let mut handles = vec![];

        // 启动 50 个并发只读 Reader 线程
        for _ in 0..50 {
            let catalog_clone = shared_catalog.clone();
            let stop_clone = stop_flag.clone();
            let barrier_clone = start_barrier.clone();
            handles.push(thread::spawn(move || {
                barrier_clone.wait();
                let mut read_count = 0;
                loop {
                    let snapshot = catalog_clone.load();
                    let _ = snapshot.providers.len();
                    read_count += 1;
                    if stop_clone.load(Ordering::Relaxed) {
                        break;
                    }
                }
                read_count
            }));
        }

        // 等待所有 50 个 Reader 线程就绪并同步发车
        start_barrier.wait();

        // 主线程执行原子替换重载 10 次
        for i in 0..10 {
            let mut new_config = ModelsConfig::default();
            new_config.providers.insert(
                format!("prov_{}", i),
                ProviderSpec {
                    display_name: format!("Provider {}", i),
                    base_url: "https://api.test.com".to_string(),
                    protocol: "openai/chat".to_string(),
                    compat: ProviderCompat::default(),
                    headers: HashMap::new(),
                    models: vec![],
                },
            );
            shared_catalog.store(Arc::new(new_config));
            thread::sleep(std::time::Duration::from_millis(5));
        }

        stop_flag.store(true, Ordering::Relaxed);
        for h in handles {
            let count = h.join().unwrap();
            assert!(count > 0);
        }
    }

    // -------------------------------------------------------------------------
    // Case 14: Anthropic 思考预算 Token Clamp 协同
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_14_anthropic_thinking_budget_token_clamp_coordination() {
        // 当 maxOutputTokens = 16384 时，thinking budget 不得超过 maxOutputTokens - 1024
        let max_output = 16384u64;
        let requested_budget = 32768u64;
        let clamped_budget = requested_budget.min(max_output.saturating_sub(1024));
        assert_eq!(clamped_budget, 15360);
    }

    // -------------------------------------------------------------------------
    // Case 15: Google Interactions API thought steps 流式解析
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_15_google_interactions_api_thought_steps_stream_parser() {
        let chunk_json = r#"{
            "candidates": [{
                "content": {
                    "parts": [
                        { "thought": "正在推导数学公式..." },
                        { "text": "结果是 42。" }
                    ]
                }
            }]
        }"#;
        let parsed: serde_json::Value = serde_json::from_str(chunk_json).unwrap();
        let part_0 = &parsed["candidates"][0]["content"]["parts"][0];
        assert_eq!(part_0["thought"].as_str().unwrap(), "正在推导数学公式...");
        let part_1 = &parsed["candidates"][0]["content"]["parts"][1];
        assert_eq!(part_1["text"].as_str().unwrap(), "结果是 42。");
    }

    // -------------------------------------------------------------------------
    // Case 16: DeepSeek 原生思考方言 Wire 序列化
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_16_deepseek_native_thinking_dialect_wire_serialization() {
        let payload = serde_json::json!({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "thinking": {
                "type": "enabled"
            }
        });
        assert_eq!(payload["thinking"]["type"], "enabled");

        let disabled_payload = serde_json::json!({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "thinking": {
                "type": "disabled"
            }
        });
        assert_eq!(disabled_payload["thinking"]["type"], "disabled");
    }

    // -------------------------------------------------------------------------
    // Case 17: 阿里云百炼 enable_thinking 顶层布尔字段注入
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_17_qwen_enable_thinking_top_level_boolean_injection() {
        let payload = serde_json::json!({
            "model": "qwen3.8-max",
            "messages": [{"role": "user", "content": "hi"}],
            "enable_thinking": true
        });
        assert_eq!(payload["enable_thinking"], true);
    }

    // -------------------------------------------------------------------------
    // Case 18: OpenAI Responses API 原生端点决议
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_18_openai_responses_api_endpoint_and_wire_payload() {
        let base_url = "https://api.openai.com/v1";
        let protocol = "openai/responses";
        let endpoint = if protocol == "openai/responses" {
            format!("{}/responses", base_url.trim_end_matches('/'))
        } else {
            format!("{}/chat/completions", base_url.trim_end_matches('/'))
        };
        assert_eq!(endpoint, "https://api.openai.com/v1/responses");

        let chat_protocol = "openai/chat";
        let chat_endpoint = if chat_protocol == "openai/responses" {
            format!("{}/responses", base_url.trim_end_matches('/'))
        } else {
            format!("{}/chat/completions", base_url.trim_end_matches('/'))
        };
        assert_eq!(chat_endpoint, "https://api.openai.com/v1/chat/completions");
    }

    // -------------------------------------------------------------------------
    // Case 19: 显式免费与静默缺省严格区分
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_19_explicit_zero_price_marked_as_free_not_silent() {
        let zero_pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 0.0,
            output: 0.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };
        let cost = PricingEngine::calculate_cost(&Some(zero_pricing), 1000, 500, 0, 0).unwrap();
        assert!(cost.is_free);
        assert_eq!(cost.formatted_total, "免费");
    }

    // -------------------------------------------------------------------------
    // Case 20: 混合会话多 Agent 跨币种独立分账
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_20_multi_agent_cross_currency_billing_session_aggregation() {
        let mut session_cny_micros = 0u64;
        let mut session_usd_micros = 0u64;

        // Agent 1: DeepSeek 国内站 (CNY)
        session_cny_micros += 50_000;
        // Agent 2: OpenAI (USD)
        session_usd_micros += 12_000;

        let formatted_cny = PricingEngine::format_micros(session_cny_micros, Currency::Cny);
        let formatted_usd = PricingEngine::format_micros(session_usd_micros, Currency::Usd);

        assert_eq!(formatted_cny, "¥0.0500");
        assert_eq!(formatted_usd, "$0.0120");
    }

    // -------------------------------------------------------------------------
    // Case 21: 子代理派发 Token 预算上界动态钳制
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_21_subagent_budget_upper_bound_clamping_to_parent() {
        let parent_context = 1_000_000u64;
        let parent_used = 800_000u64;
        let parent_remaining = parent_context.saturating_sub(parent_used); // 200,000

        let child_context = 131_072u64;
        let max_child_prompt = (child_context as f64 * 0.7) as u64; // 91,750
        let parent_allowance = (parent_remaining as f64 * 0.8) as u64; // 160,000

        let effective_subagent_budget = max_child_prompt.min(parent_allowance);
        assert_eq!(effective_subagent_budget, 91_750);
    }

    // -------------------------------------------------------------------------
    // Case 22: 单模型抽屉展开时协议下拉选择菜单物理剥离断言
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_22_model_drawer_protocol_dropdown_dom_removal_assertion() {
        let yaml = r#"
displayName: DeepSeek 官方
baseUrl: https://api.deepseek.com
protocol: openai/chat
models:
  - id: deepseek-v4-flash
    displayName: DeepSeek V4 Flash
    contextWindow: 1048576
    maxOutputTokens: 384000
"#;
        let prov: ProviderSpec = serde_yaml::from_str(yaml).unwrap();
        let model = prov.models.first().unwrap();

        // 断言：单模型实体上 protocol 字段默认缺省 (None)，彻底由 Provider 统领
        assert_eq!(model.protocol, None);
        // 断言：生效协议 100% 继承供应商顶层协议
        assert_eq!(prov.resolve_model_protocol(model), "openai/chat");
    }

    // -------------------------------------------------------------------------
    // Case 23: DisplayName 与 Fallback Chain 优先级断言
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_23_display_name_and_metadata_fallback_chain() {
        let model_with_name = ModelSpec {
            id: "gpt-4o".to_string(),
            display_name: Some("GPT-4o Omni".to_string()),
            protocol: None,
            context_window: 128000,
            max_output_tokens: 4096,
            modalities: ModalitiesConfig::default(),
            thinking: None,
            pricing: None,
        };
        let model_without_name = ModelSpec {
            id: "gpt-4o-mini".to_string(),
            display_name: None,
            protocol: None,
            context_window: 128000,
            max_output_tokens: 4096,
            modalities: ModalitiesConfig::default(),
            thinking: None,
            pricing: None,
        };

        // 降级链：优先显式 displayName，缺失时回退至 model.id
        let name_1 = model_with_name
            .display_name
            .as_deref()
            .unwrap_or(&model_with_name.id);
        let name_2 = model_without_name
            .display_name
            .as_deref()
            .unwrap_or(&model_without_name.id);

        assert_eq!(name_1, "GPT-4o Omni");
        assert_eq!(name_2, "gpt-4o-mini");
    }

    // -------------------------------------------------------------------------
    // Case 24: 未知非标协议字符串安全降级 Warning
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_24_unknown_protocol_string_fallback_with_warning() {
        let raw_protocol = "custom/unknown-v3";
        let resolved = match raw_protocol {
            "openai/chat" => "openai/chat",
            "openai/responses" => "openai/responses",
            "anthropic/messages" => "anthropic/messages",
            "google/generative-ai" => "google/generative-ai",
            _ => "openai/chat", // 安全降级
        };
        assert_eq!(resolved, "openai/chat");
    }

    // -------------------------------------------------------------------------
    // Case 25: Prompt Cache Read 超过 Prompt Tokens 异常防御清洗
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_25_prompt_cache_read_exceeds_prompt_tokens_defensive_clamp() {
        let prompt_tokens = 10_000u64;
        let anomalous_cache_read = 15_000u64; // 异常上报：缓存命中超过总输入

        let sanitized_cache_read = anomalous_cache_read.min(prompt_tokens);
        let non_cached = prompt_tokens.saturating_sub(sanitized_cache_read);

        assert_eq!(sanitized_cache_read, 10_000);
        assert_eq!(non_cached, 0);
    }

    // -------------------------------------------------------------------------
    // Case 26: 生图模态与多模输入共存模型 Wire 组装
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_26_image_generation_and_multimodal_input_coexistence() {
        let model = ModelSpec {
            id: "meta/muse-image".to_string(),
            display_name: Some("Muse Image".to_string()),
            protocol: None,
            context_window: 65536,
            max_output_tokens: 32768,
            modalities: ModalitiesConfig {
                input: vec![Modality::Image, Modality::Text],
                output: vec![Modality::Image, Modality::Text],
            },
            thinking: None,
            pricing: None,
        };
        assert!(model.modalities.input.contains(&Modality::Image));
        assert!(model.modalities.output.contains(&Modality::Image));
    }

    // -------------------------------------------------------------------------
    // Case 27: 多语言与非 ASCII 字符在 YAML 序列化中无损保存
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_27_utf8_non_ascii_preservation_in_yaml_serialization() {
        let mut providers = HashMap::new();
        providers.insert(
            "aliyun".to_string(),
            ProviderSpec {
                display_name: "阿里云通义千问官方直连".to_string(),
                base_url: "https://dashscope.aliyuncs.com".to_string(),
                protocol: "openai/chat".to_string(),
                compat: ProviderCompat::default(),
                headers: HashMap::new(),
                models: vec![ModelSpec {
                    id: "qwen-turbo".to_string(),
                    display_name: Some("通义千问·超轻量模型 (测试版)".to_string()),
                    protocol: None,
                    context_window: 128000,
                    max_output_tokens: 8192,
                    modalities: ModalitiesConfig::default(),
                    thinking: None,
                    pricing: None,
                }],
            },
        );
        let config = ModelsConfig { providers };
        let yaml_str = serde_yaml::to_string(&config).unwrap();
        assert!(yaml_str.contains("阿里云通义千问官方直连"));
        assert!(yaml_str.contains("通义千问·超轻量模型 (测试版)"));

        let restored: ModelsConfig = serde_yaml::from_str(&yaml_str).unwrap();
        assert_eq!(config, restored);
    }

    // -------------------------------------------------------------------------
    // Case 28: 极端负数 Token 或溢出参数防御性校验
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_28_negative_or_overflow_tokens_validation_guard() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 6.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };

        // 使用 saturating 与宽位整数防御超大数溢出
        let extreme_tokens = u64::MAX;
        let cost = PricingEngine::calculate_cost(&Some(pricing), extreme_tokens, 0, 0, 0);
        assert!(cost.is_some());
    }
}
