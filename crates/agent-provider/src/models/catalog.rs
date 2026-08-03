//! 模型目录（Model Catalog）：内置静态表 + 多级兜底查询（P3 §3.1）
//!
//! - [ModelCatalogEntry]：一个 provider 通道下一个模型的完整元数据。字段集按
//!   00-catalog §12.1 草案缩窄到实现层必须字段；全字段可缺省（struct 级
//!   `#[serde(default)]`），缺字段条目可正常反序列化（对齐 A3 P2-10 裁决）。
//! - [ModelCatalog]：内置表 + 版本号。[ModelCatalog::lookup] 按 litellm
//!   `_get_model_info_helper` 顺序多级兜底：精确 → 去版本后缀 → vendor 默认 → None。
//!
//! 本模块不依赖 request/parse 层；行为矩阵（T-19）、TTL 表（T-21）等上层只通过
//! [ModelCatalog] 查询接口消费，禁止散落硬编码判定。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 模型目录条目（一个 provider 通道下一个模型的完整元数据）
///
/// 字段集按 00-catalog §12.1 草案缩窄；全部字段提供 Default（`#[serde(default)]`），
/// 缺字段条目可解析（A3 P2-10 由测试钉死）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelCatalogEntry {
    // ── 标识 ──
    /// API 模型标识（唯一键，如 deepseek-v4-flash）
    pub model: String,
    /// 通道/网关标识（dashscope / volcengine / qianfan；直连 = 官方厂商名）
    pub provider: String,
    /// 官方厂商（转售场景区分通道价与官方直连价；决定缓存行为矩阵取哪个 vendor）
    pub vendor: String,
    /// 协议模式："chat" | "responses" | "both"
    pub mode: Option<String>,
    /// 计价币种：USD / CNY（转售价多为 CNY，00-catalog §12.1）
    pub currency: Option<String>,
    /// 计价单位（per_1M）
    pub unit: Option<String>,

    // ── 窗口 ──
    /// 输入上下文窗口（token）
    pub context_window: Option<u64>,
    pub max_input_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,

    // ── 价格（P3 只建模不计算；P5 成本计算消费）──
    /// 未缓存输入价（per_1M）
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    /// 缓存命中价（read/refresh，per_1M）
    pub cache_read_price: Option<f64>,
    /// 通用缓存写入价（OpenAI GPT-5.6+ 1.25x 口径）
    pub cache_write_price: Option<f64>,
    /// Anthropic 系 5m TTL 写入价
    pub cache_write_price_5m: Option<f64>,
    /// Anthropic 系 1h TTL 写入价（无则省略）
    pub cache_write_price_1h: Option<f64>,
    /// 缓存存储费（$/1M·h 或 ¥/1M·h，Gemini / 方舟有值）
    pub storage_price_per_1m_hour: Option<f64>,
    /// 长上下文价格阈值（Grok 200K / Gemini 3.1 Pro 200K）
    pub long_context_threshold: Option<u64>,
    pub long_context_input_price: Option<f64>,
    /// DeepSeek 峰谷定价标记（北京 9:00-12:00 / 14:00-18:00 2 倍，生效日期待官方公告）
    pub peak_pricing_2x: bool,

    // ── 缓存语义 ──
    /// 最低可缓存前缀（Anthropic 512~4096 / Kimi 256 / MiniMax 512 …；缺省由
    /// [ModelCatalog::prompt_cache_min_tokens_for] 回退 1024，对齐 litellm 默认值）
    pub prompt_cache_min_tokens: Option<u64>,
    /// 缓存类型："automatic" | "explicit" | "both" | "none"
    pub cache_type: Option<String>,
    /// 缓存机制："prefix" | "similarity" | "disk_unit" | "session"
    pub cache_mechanism: Option<String>,
    /// 是否支持 Anthropic 式 cache_control 断点
    pub supports_cache_control: bool,
    /// 是否参与任何形式缓存
    pub supports_prompt_caching: bool,
    /// 断点上限（Anthropic/MiniMax 4、百炼 4）
    pub breakpoint_max: Option<u8>,
    /// 回溯窗口（Anthropic/百炼 20）
    pub lookback_blocks: Option<u16>,
    /// 模型级 TTL（值域 "5m" / "1h" / "24h"，对齐 00-catalog §12.1；
    /// T-21 ttl.rs 消费时映射为其 CacheTtl 枚举）
    pub cache_ttl: Option<String>,
    /// 旧轨模型写免费（OpenAI 旧模型/Kimi/DeepSeek）
    pub cache_write_free: bool,

    // ── 协议/能力位 ──
    /// Responses API 支持（DeepSeek 仅 v4-flash；engine.rs provider_url 判定用）
    pub supports_responses: bool,
    pub supports_reasoning: bool,
    /// 是否接受 reasoning_effort 参数（OpenAI/DeepSeek/Qwen/GLM/Kimi 原生格式）
    pub supports_reasoning_effort: bool,
    pub supports_vision: bool,
    pub supports_function_calling: bool,
    pub supports_parallel_function_calling: bool,
    pub supports_system_messages: bool,
    pub supports_response_schema: bool,

    // ── 溯源 ──
    pub deprecation_date: Option<String>,
    /// 条目数据来源（00-catalog 各节 URL）
    pub source_url: Option<String>,
    /// 条目核实日期（00-catalog 数据获取日期 2026-08-02）
    pub data_verified_at: Option<String>,
}

impl ModelCatalogEntry {
    /// 目录条目键（"{vendor}::{model}"，与 [ModelCatalog] 内部键格式一致）
    fn key(vendor: &str, model: &str) -> String {
        format!("{vendor}::{model}")
    }
}

/// 扫描模型能力位猜测（前端 `ModelCapabilityKey` 三键 → supports_* 映射面；T-24/T-25）
///
/// 仅承载"扫描/猜测"来源的能力位；未知（None）= 不合并该位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannedCapabilities {
    /// tools → [ModelCatalogEntry::supports_function_calling]
    pub tools: Option<bool>,
    /// vision → [ModelCatalogEntry::supports_vision]
    pub vision: Option<bool>,
    /// reasoning → [ModelCatalogEntry::supports_reasoning]
    pub reasoning: Option<bool>,
}

/// 扫描结果单模型（前端 `scanProviderModels` 上送面，`catalog_refresh` 入参）
///
/// 字段语义对齐 modelCatalog.ts：`context_length`/`max_model_len` 或猜测值 →
/// [Self::context_window]；`guessModelCapabilities` → [Self::capabilities]。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScannedModel {
    /// API 模型标识（扫描列表原样；空串忽略）
    pub model: String,
    /// 厂商（可缺省；缺省回退 `catalog_refresh` 的 provider 参数作 vendor 键）
    pub vendor: Option<String>,
    /// 上下文窗口（≤0 视为缺失）
    pub context_window: Option<u64>,
    /// 输出上限（≤0 视为缺失）
    pub max_output_tokens: Option<u64>,
    /// 能力位猜测（None = 该模型无能力位数据）
    pub capabilities: Option<ScannedCapabilities>,
}

/// 目录变更错误（T-24：覆盖白名单拒绝；"失败不阻塞仅记录"语义下用于记录/计数）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CatalogError {
    /// 覆盖项含白名单外字段，或试图改动禁覆盖键（model / provider / vendor）
    #[error("覆盖白名单外字段：{0}")]
    ForbiddenField(String),
    /// 覆盖项结构非法（非对象 / 缺身份键 / 字段类型错误）
    #[error("覆盖项无效：{0}")]
    InvalidOverride(String),
}

/// 运行时模型目录（内置表 + 覆盖 + 扫描合并的单一真源；T-24 扩展
/// `with_overrides` / `upsert_from_scan` 变更入口，任何变更版本号 +1）
#[derive(Debug, Clone)]
pub struct ModelCatalog {
    /// 键 = "{vendor}::{model}"（同模型多通道按 provider 区分）
    entries: BTreeMap<String, ModelCatalogEntry>,
    /// 单调递增版本号（对齐 litellm `_model_cost_mutation_generation`；下游 memoize 失效键）
    version: u64,
}

impl ModelCatalog {
    /// 内置表：catalog.json 编译期打包（include_str!，无运行时 IO、离线可用）。
    ///
    /// 解析失败即 panic——转录错误由"catalog.json serde 全量解析"单测钉死。
    pub fn bundled() -> Self {
        let entries = serde_json::from_str(include_str!("catalog.json"))
            .expect("内置 catalog.json 必须可解析（serde 全量解析测试钉死转录错误）");
        Self { entries, version: 0 }
    }

    /// 当前版本号（下游 memoize 失效键；内置表为 0，T-24 覆盖/合并时 bump）
    pub fn version(&self) -> u64 {
        self.version
    }

    /// 多级兜底查找（对齐 litellm `_get_model_info_helper` 顺序）：
    /// 精确 "vendor::model" → 逐级去版本后缀（-0731 / -20250826，如
    /// `deepseek-v4-flash-0731` → `deepseek-v4-flash`）→ vendor 级默认条目
    /// （model="*"）→ None。
    pub fn lookup(&self, vendor: &str, model: &str) -> Option<&ModelCatalogEntry> {
        let mut probe = ModelCatalogEntry::key(vendor, model);
        if self.entries.contains_key(&probe) {
            return self.entries.get(&probe);
        }
        // 逐级去版本后缀重试（v4-flash 官方版本号即 DeepSeek-V4-Flash-0731）
        while let Some(stripped) = strip_version_suffix(&probe) {
            probe = stripped;
            if let Some(entry) = self.entries.get(&probe) {
                return Some(entry);
            }
        }
        // vendor 级默认条目（model="*"；未配置 → None）
        self.entries.get(&ModelCatalogEntry::key(vendor, "*"))
    }

    /// 便捷：上下文窗口钳制（P4/压缩层消费；窗口缺失 → None）
    pub fn context_window_for(&self, vendor: &str, model: &str) -> Option<u64> {
        self.lookup(vendor, model).and_then(|entry| entry.context_window)
    }

    /// 便捷：输出上限
    pub fn max_output_for(&self, vendor: &str, model: &str) -> Option<u64> {
        self.lookup(vendor, model).and_then(|entry| entry.max_output_tokens)
    }

    /// 便捷：最低可缓存前缀（条目缺失或未收录 → 回退 1024，
    /// 对齐 litellm `DEFAULT_MINIMUM_PROMPT_CACHE_TOKEN_COUNT`）
    pub fn prompt_cache_min_tokens_for(&self, vendor: &str, model: &str) -> u64 {
        self.lookup(vendor, model)
            .and_then(|entry| entry.prompt_cache_min_tokens)
            .unwrap_or(1024)
    }

    /// 便捷：缓存资格判定（未知模型保守为不支持，对齐 jcode"否则视为不支持"）
    pub fn supports_prompt_caching_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.supports_prompt_caching)
    }

    /// 便捷：Responses API 支持（engine.rs `provider_url` 判定用；未知模型保守为不支持）
    pub fn supports_responses_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.supports_responses)
    }

    // ===== T-24：运行时合并与覆盖（P3 §3.1.3 优先级 2/3，任何变更 version +1）=====

    /// 全量条目快照（按 vendor::model 字典序；`catalog_get` 下发面）
    pub fn entries_snapshot(&self) -> Vec<ModelCatalogEntry> {
        self.entries.values().cloned().collect()
    }

    /// 合并前端扫描结果（P3 §3.1.3 优先级 2：`scanProviderModels` 上送）。
    ///
    /// 合并范围：context_window / max_output_tokens / 能力位猜测
    /// （tools→supports_function_calling、vision→supports_vision、
    /// reasoning→supports_reasoning）；**不覆盖价格族与缓存语义**（扫描无这些
    /// 字段，内置 00-catalog 价格保持真源）。
    ///
    /// - 已收录条目：扫描提供即覆盖（运行时 /models 的 context_length 是通道侧真源）；
    /// - 未收录模型：按扫描猜测新建条目（vendor 缺省回退 provider；缓存语义
    ///   保守默认，未知厂商行为由行为矩阵兜底）；
    /// - 非正窗口 / 输出上限视为缺失（防御扫描给 0 / 负值）；
    /// - 至少一项生效时 version +1，返回合并后版本号。
    pub fn upsert_from_scan(&mut self, provider: &str, scan: &[ScannedModel]) -> u64 {
        let provider = provider.trim();
        let mut changed = false;
        for item in scan {
            let model = item.model.trim();
            if model.is_empty() {
                continue;
            }
            let vendor = item
                .vendor
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .unwrap_or(provider);
            let key = ModelCatalogEntry::key(vendor, model);
            // 未收录模型按猜测新建（身份字段来自扫描；其余字段保守默认）
            if !self.entries.contains_key(&key) {
                self.entries.insert(
                    key.clone(),
                    ModelCatalogEntry {
                        model: model.to_string(),
                        provider: provider.to_string(),
                        vendor: vendor.to_string(),
                        ..Default::default()
                    },
                );
                changed = true;
            }
            let entry = self.entries.get_mut(&key).expect("刚插入 / 已存在");
            // 只合并窗口 / 输出上限 / 能力位，不触碰价格与缓存语义
            if let Some(window) = item.context_window.filter(|v| *v > 0) {
                if entry.context_window != Some(window) {
                    entry.context_window = Some(window);
                    changed = true;
                }
            }
            if let Some(output) = item.max_output_tokens.filter(|v| *v > 0) {
                if entry.max_output_tokens != Some(output) {
                    entry.max_output_tokens = Some(output);
                    changed = true;
                }
            }
            if let Some(caps) = item.capabilities {
                if let Some(tools) = caps.tools {
                    if entry.supports_function_calling != tools {
                        entry.supports_function_calling = tools;
                        changed = true;
                    }
                }
                if let Some(vision) = caps.vision {
                    if entry.supports_vision != vision {
                        entry.supports_vision = vision;
                        changed = true;
                    }
                }
                if let Some(reasoning) = caps.reasoning {
                    if entry.supports_reasoning != reasoning {
                        entry.supports_reasoning = reasoning;
                        changed = true;
                    }
                }
            }
        }
        if changed {
            self.version += 1;
        }
        self.version
    }

    /// 应用用户覆盖（P3 §3.1.3 优先级 3：`catalog-overrides.json` 或 config `extra` 域）。
    ///
    /// 规则：
    /// - 覆盖项必须是对象，且携带 vendor + model 身份键定位**既有**条目
    ///   （provider 可选；出现时须与条目通道一致）；
    /// - 白名单字段 = 窗口 / 输出上限 / 价格族 / prompt_cache_min_tokens +
    ///   supports_* 能力位（见 [OVERRIDE_WHITELIST] / [OVERRIDE_BOOL_FIELDS]）；
    ///   白名单外字段（mode / currency / cacheType 等）整项拒绝；
    /// - **禁覆盖** model / provider / vendor 三键（防键冲突）：身份键只允许
    ///   原值定位，指向不存在条目（借覆盖新增 / 改名）或通道不一致即拒绝；
    /// - 失败不阻塞仅记录：逐项校验，被拒项 `tracing::warn!` 记录并继续；
    /// - 至少一项生效时 version +1。
    ///
    /// 返回被拒绝的覆盖项数（0 = 全部生效）。
    pub fn with_overrides(&mut self, overrides: &[serde_json::Value]) -> usize {
        let mut rejected = 0usize;
        for item in overrides {
            if let Err(problem) = self.apply_override_item(item) {
                rejected += 1;
                tracing::warn!(
                    target: "catalog",
                    error = %problem,
                    "覆盖项已拒绝（仅记录，不阻断启动）"
                );
            }
        }
        if !overrides.is_empty() && rejected < overrides.len() {
            self.version += 1;
        }
        rejected
    }

    /// 单条覆盖项应用（键级白名单校验 → 整项 serde 解析 → 身份定位 → 字段合并）。
    fn apply_override_item(&mut self, item: &serde_json::Value) -> Result<(), CatalogError> {
        let obj = item.as_object().ok_or_else(|| {
            CatalogError::InvalidOverride("覆盖项必须是 JSON 对象".to_string())
        })?;
        // 键级白名单：身份键 model/provider/vendor 只用于定位，其余必须命中白名单
        for key in obj.keys() {
            if !matches!(key.as_str(), "model" | "provider" | "vendor")
                && !OVERRIDE_WHITELIST.contains(&key.as_str())
                && !OVERRIDE_BOOL_FIELDS.iter().any(|(k, _, _)| *k == key)
            {
                return Err(CatalogError::ForbiddenField(key.clone()));
            }
        }
        // 整项 serde 解析：字段类型错误（窗口为字符串等）→ InvalidOverride
        let patch: ModelCatalogEntry = serde_json::from_value(item.clone())
            .map_err(|e| CatalogError::InvalidOverride(e.to_string()))?;
        // 身份定位：vendor + model 必填
        if patch.vendor.trim().is_empty() || patch.model.trim().is_empty() {
            return Err(CatalogError::InvalidOverride(
                "覆盖项缺少 vendor/model 身份键".to_string(),
            ));
        }
        let key = ModelCatalogEntry::key(&patch.vendor, &patch.model);
        let Some(existing) = self.entries.get(&key) else {
            // 目标条目不存在：不能借覆盖新增 / 改名条目（model/vendor 键禁覆盖，防键冲突）
            return Err(CatalogError::ForbiddenField("model".to_string()));
        };
        if !patch.provider.trim().is_empty() && patch.provider != existing.provider {
            return Err(CatalogError::ForbiddenField("provider".to_string()));
        }
        // 字段合并（白名单已校验；Option 字段仅显式提供时生效）
        let entry = self.entries.get_mut(&key).expect("身份键已存在");
        if let Some(value) = patch.context_window {
            entry.context_window = Some(value);
        }
        if let Some(value) = patch.max_output_tokens {
            entry.max_output_tokens = Some(value);
        }
        if let Some(value) = patch.input_price {
            entry.input_price = Some(value);
        }
        if let Some(value) = patch.output_price {
            entry.output_price = Some(value);
        }
        if let Some(value) = patch.cache_read_price {
            entry.cache_read_price = Some(value);
        }
        if let Some(value) = patch.cache_write_price {
            entry.cache_write_price = Some(value);
        }
        if let Some(value) = patch.cache_write_price_5m {
            entry.cache_write_price_5m = Some(value);
        }
        if let Some(value) = patch.cache_write_price_1h {
            entry.cache_write_price_1h = Some(value);
        }
        if let Some(value) = patch.storage_price_per_1m_hour {
            entry.storage_price_per_1m_hour = Some(value);
        }
        if let Some(value) = patch.long_context_input_price {
            entry.long_context_input_price = Some(value);
        }
        if let Some(value) = patch.prompt_cache_min_tokens {
            entry.prompt_cache_min_tokens = Some(value);
        }
        // 能力位：键显式出现才应用（支持显式 false 关闭；缺失 = 不动）
        for (wire_key, read, write) in OVERRIDE_BOOL_FIELDS {
            if obj.contains_key(*wire_key) {
                write(entry, read(&patch));
            }
        }
        Ok(())
    }
}

/// 覆盖白名单（camelCase 键，与 [ModelCatalogEntry] serde 键一致）：
/// 窗口 / 输出上限 / 价格族 / 最低可缓存前缀。
/// 禁覆盖键 model / provider / vendor 不在此列——身份键只用于定位，值必须与目标条目一致。
const OVERRIDE_WHITELIST: &[&str] = &[
    "contextWindow",
    "maxOutputTokens",
    "inputPrice",
    "outputPrice",
    "cacheReadPrice",
    "cacheWritePrice",
    "cacheWritePrice5m",
    "cacheWritePrice1h",
    "storagePricePer1mHour",
    "longContextInputPrice",
    "promptCacheMinTokens",
];

/// 能力位覆盖表条目：(wire 键, 读 patch 字段, 写 entry 字段)
type BoolFieldAccessor = (
    &'static str,
    fn(&ModelCatalogEntry) -> bool,
    fn(&mut ModelCatalogEntry, bool),
);

/// 能力位覆盖表（[BoolFieldAccessor] 元组表）：
///
/// 显式出现才应用（`{"supportsVision": false}` 可关闭能力位；键缺失 = 不动）。
const OVERRIDE_BOOL_FIELDS: &[BoolFieldAccessor] = &[
        ("supportsCacheControl", |e| e.supports_cache_control, |e, v| e.supports_cache_control = v),
        ("supportsPromptCaching", |e| e.supports_prompt_caching, |e, v| e.supports_prompt_caching = v),
        ("supportsResponses", |e| e.supports_responses, |e, v| e.supports_responses = v),
        ("supportsReasoning", |e| e.supports_reasoning, |e, v| e.supports_reasoning = v),
        ("supportsReasoningEffort", |e| e.supports_reasoning_effort, |e, v| e.supports_reasoning_effort = v),
        ("supportsVision", |e| e.supports_vision, |e, v| e.supports_vision = v),
        ("supportsFunctionCalling", |e| e.supports_function_calling, |e, v| e.supports_function_calling = v),
        ("supportsParallelFunctionCalling", |e| e.supports_parallel_function_calling, |e, v| e.supports_parallel_function_calling = v),
        ("supportsSystemMessages", |e| e.supports_system_messages, |e, v| e.supports_system_messages = v),
        ("supportsResponseSchema", |e| e.supports_response_schema, |e, v| e.supports_response_schema = v),
    ];

/// 剥离尾部数字版本后缀（-0731 / -20250826 形态）；后缀非纯数字时不剥离，
/// 避免误伤如 `deepseek-v3` 这类本身含数字的模型名。
fn strip_version_suffix(probe: &str) -> Option<String> {
    let (base, suffix) = probe.rsplit_once('-')?;
    if !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(base.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内置表 serde 全量解析 + 键与条目身份字段一致（防转录漂移）+ 各厂商条目数钉死
    #[test]
    fn catalog_json_parses_fully_and_keys_match_entries() {
        let catalog = ModelCatalog::bundled();
        // ≈27 条起步（DeepSeek 2 / Anthropic 7 / OpenAI 2 / Kimi 1 / Grok 2 /
        // MiniMax 3 / Gemini 4 / GLM 4 / Qwen 3）
        assert!(catalog.entries.len() >= 27, "内置条目数 = {}", catalog.entries.len());
        for (key, entry) in &catalog.entries {
            assert_eq!(
                *key,
                ModelCatalogEntry::key(&entry.vendor, &entry.model),
                "键必须与 vendor::model 一致",
            );
            assert!(!entry.model.is_empty(), "{key} 缺 model");
            assert!(!entry.provider.is_empty(), "{key} 缺 provider");
            assert!(!entry.vendor.is_empty(), "{key} 缺 vendor");
            assert!(entry.source_url.is_some(), "{key} 缺 source_url");
            assert_eq!(
                entry.data_verified_at.as_deref(),
                Some("2026-08-02"),
                "{key} 核实日期须为 2026-08-02",
            );
        }
        // 各厂商条目数（转录范围钉死）
        let count = |vendor: &str| {
            catalog
                .entries
                .keys()
                .filter(|key| key.starts_with(&format!("{vendor}::")))
                .count()
        };
        assert_eq!(count("deepseek"), 2);
        assert_eq!(count("anthropic"), 7);
        assert_eq!(count("openai"), 2);
        assert_eq!(count("kimi"), 1);
        assert_eq!(count("grok"), 2);
        assert_eq!(count("minimax"), 3);
        assert_eq!(count("gemini"), 4);
        assert_eq!(count("glm"), 4);
        assert_eq!(count("qwen"), 3);
    }

    /// 精确命中：deepseek-v4-flash 及其关键字段
    #[test]
    fn lookup_exact_match_hits_bundled_entry() {
        let catalog = ModelCatalog::bundled();
        let flash = catalog
            .lookup("deepseek", "deepseek-v4-flash")
            .expect("内置 deepseek-v4-flash 必须命中");
        assert_eq!(flash.model, "deepseek-v4-flash");
        assert_eq!(flash.vendor, "deepseek");
        assert_eq!(flash.context_window, Some(1_000_000));
        assert_eq!(flash.input_price, Some(0.14));
        assert_eq!(flash.cache_read_price, Some(0.0028));
        assert_eq!(flash.output_price, Some(0.28));
        assert!(flash.supports_prompt_caching);
        assert!(flash.supports_responses);
        assert!(!flash.supports_cache_control);

        // v4-pro：Responses 尚未支持（官方口径 2026 年 8 月初加入）
        let pro = catalog
            .lookup("deepseek", "deepseek-v4-pro")
            .expect("内置 deepseek-v4-pro 必须命中");
        assert_eq!(pro.cache_read_price, Some(0.003625));
        assert!(!pro.supports_responses);
    }

    /// 版本后缀兜底：deepseek-v4-flash-0731（官方版本号）命中内置 v4-flash 条目
    #[test]
    fn lookup_strips_version_suffix() {
        let catalog = ModelCatalog::bundled();
        let entry = catalog
            .lookup("deepseek", "deepseek-v4-flash-0731")
            .expect("版本后缀必须兜底命中");
        assert_eq!(entry.model, "deepseek-v4-flash");
        assert_eq!(entry.cache_read_price, Some(0.0028));
        // 长日期形态（-YYYYMMDD）同样逐级剥离
        assert!(catalog.lookup("deepseek", "deepseek-v4-flash-20250826").is_some());
    }

    /// 未知模型 / 未知 vendor → None
    #[test]
    fn lookup_unknown_model_and_vendor_yield_none() {
        let catalog = ModelCatalog::bundled();
        assert!(catalog.lookup("deepseek", "unknown-model").is_none());
        assert!(catalog.lookup("unknown-vendor", "deepseek-v4-flash").is_none());
        assert!(catalog.lookup("unknown-vendor", "whatever").is_none());
    }

    /// vendor 级默认条目（model="*"）兜底：精确与去版本后缀均未命中时生效
    #[test]
    fn lookup_falls_back_to_vendor_default_entry() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "acme::*".to_owned(),
            ModelCatalogEntry {
                model: "*".to_owned(),
                provider: "acme".to_owned(),
                vendor: "acme".to_owned(),
                ..Default::default()
            },
        );
        let catalog = ModelCatalog { entries, version: 0 };
        assert!(catalog.lookup("acme", "anything-at-all").is_some());
        // 未配置 vendor 默认条目的厂商 → None
        assert!(catalog.lookup("other", "anything-at-all").is_none());
    }

    /// 精确条目优先于 vendor 默认条目
    #[test]
    fn lookup_prefers_exact_over_vendor_default() {
        let mut entries = BTreeMap::new();
        entries.insert(
            "acme::*".to_owned(),
            ModelCatalogEntry {
                model: "*".to_owned(),
                provider: "acme".to_owned(),
                vendor: "acme".to_owned(),
                ..Default::default()
            },
        );
        entries.insert(
            "acme::special".to_owned(),
            ModelCatalogEntry {
                model: "special".to_owned(),
                provider: "acme".to_owned(),
                vendor: "acme".to_owned(),
                ..Default::default()
            },
        );
        let catalog = ModelCatalog { entries, version: 0 };
        assert_eq!(catalog.lookup("acme", "special").unwrap().model, "special");
    }

    /// A3 P2-10：必填非 Option 字段全部有 Default，缺字段条目可解析
    #[test]
    fn entry_with_missing_fields_parses_with_defaults() {
        let minimal = r#"{"model":"x","provider":"p","vendor":"v"}"#;
        let entry: ModelCatalogEntry =
            serde_json::from_str(minimal).expect("缺字段条目必须可解析");
        assert_eq!(entry.model, "x");
        assert_eq!(entry.context_window, None);
        assert_eq!(entry.prompt_cache_min_tokens, None);
        assert_eq!(entry.source_url, None);
        assert_eq!(entry.mode, None);
        assert!(!entry.supports_prompt_caching);
        assert!(!entry.supports_cache_control);
        assert!(!entry.supports_responses);
        assert!(!entry.supports_reasoning_effort);
        // 空对象同样可解析（全部字段走 Default）
        let empty: ModelCatalogEntry = serde_json::from_str("{}").expect("空对象必须可解析");
        assert_eq!(empty.model, "");
        assert!(!empty.supports_prompt_caching);
    }

    /// 便捷查询：窗口/输出上限/最低可缓存前缀/缓存资格/Responses 支持/版本号
    #[test]
    fn convenience_queries_respect_catalog_and_defaults() {
        let catalog = ModelCatalog::bundled();
        // 窗口与输出上限
        assert_eq!(
            catalog.context_window_for("deepseek", "deepseek-v4-flash"),
            Some(1_000_000)
        );
        assert_eq!(
            catalog.max_output_for("anthropic", "claude-haiku-4-5"),
            Some(64_000)
        );
        // Gemini 3.x 窗口 00-catalog 未收录 → None（不沿用前端旧值 1M）
        assert_eq!(catalog.context_window_for("gemini", "gemini-3-6-flash"), None);
        // 最低可缓存前缀：收录值命中；未收录/未知模型回退 1024
        assert_eq!(catalog.prompt_cache_min_tokens_for("kimi", "kimi-k3"), 256);
        assert_eq!(
            catalog.prompt_cache_min_tokens_for("deepseek", "deepseek-v4-flash"),
            1024
        );
        assert_eq!(catalog.prompt_cache_min_tokens_for("nobody", "whatever"), 1024);
        // 缓存资格：内置开启；未知模型保守关闭
        assert!(catalog.supports_prompt_caching_for("anthropic", "claude-sonnet-4-5"));
        assert!(!catalog.supports_prompt_caching_for("nobody", "whatever"));
        // Responses：v4-flash 支持、v4-pro 不支持、未知不支持
        assert!(catalog.supports_responses_for("deepseek", "deepseek-v4-flash"));
        assert!(!catalog.supports_responses_for("deepseek", "deepseek-v4-pro"));
        assert!(!catalog.supports_responses_for("nobody", "whatever"));
        // 币种转录：Kimi 为 CNY、Anthropic 为 USD
        assert_eq!(
            catalog.lookup("kimi", "kimi-k3").unwrap().currency.as_deref(),
            Some("CNY")
        );
        assert_eq!(
            catalog.lookup("anthropic", "claude-sonnet-5").unwrap().currency.as_deref(),
            Some("USD")
        );
        // 内置表版本号从 0 起（T-24 覆盖/合并时 bump）
        assert_eq!(catalog.version(), 0);
    }

    /// Sonnet 5 促销价转录钉死（00-catalog §1.1：8/31 前 $2/$10；9/1 起涨价
    /// $3/$15 属 P5 定价模块日期区间切换，00-catalog §12.3 刷新清单）
    #[test]
    fn sonnet5_transcribes_promo_price() {
        let catalog = ModelCatalog::bundled();
        let sonnet5 = catalog
            .lookup("anthropic", "claude-sonnet-5")
            .expect("内置 claude-sonnet-5 必须命中");
        assert_eq!(sonnet5.input_price, Some(2.0));
        assert_eq!(sonnet5.cache_read_price, Some(0.2));
        assert_eq!(sonnet5.output_price, Some(10.0));
        assert_eq!(sonnet5.prompt_cache_min_tokens, Some(1024));
    }

    // ===== T-24：覆盖白名单（with_overrides）=====

    /// 白名单字段生效：窗口 / 输出上限 / 价格族 / 最低可缓存前缀 / 能力位，
    /// 生效后 version +1
    #[test]
    fn with_overrides_applies_whitelisted_fields_and_bumps_version() {
        let mut catalog = ModelCatalog::bundled();
        let rejected = catalog.with_overrides(&[serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash",
            "contextWindow": 200_000,
            "maxOutputTokens": 16_000,
            "cacheReadPrice": 0.001,
            "promptCacheMinTokens": 512,
            "supportsVision": true,
        })]);
        assert_eq!(rejected, 0, "白名单字段应全部生效");
        assert_eq!(catalog.version(), 1);
        let flash = catalog
            .lookup("deepseek", "deepseek-v4-flash")
            .expect("内置条目必须存在");
        assert_eq!(flash.context_window, Some(200_000));
        assert_eq!(flash.max_output_tokens, Some(16_000));
        assert_eq!(flash.cache_read_price, Some(0.001));
        assert_eq!(flash.prompt_cache_min_tokens, Some(512));
        assert!(flash.supports_vision);
        // 未覆盖字段保持内置真源
        assert_eq!(flash.input_price, Some(0.14));
        assert_eq!(flash.output_price, Some(0.28));
        assert!(flash.supports_prompt_caching);
    }

    /// 能力位可显式关闭（supportsVision: false），与"键缺失 = 不动"区分
    #[test]
    fn with_overrides_can_turn_off_capability_bit_explicitly() {
        let mut catalog = ModelCatalog::bundled();
        let rejected = catalog.with_overrides(&[serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash",
            "supportsVision": false,
            "supportsResponses": false,
        })]);
        assert_eq!(rejected, 0);
        let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
        assert!(!flash.supports_vision);
        assert!(!flash.supports_responses);
        // 键缺失的能力位不动
        assert!(flash.supports_prompt_caching);
    }

    /// model 键禁覆盖：身份键指向不存在的条目（借覆盖新增 / 改名）→ 整项拒绝，
    /// 版本号与目录不变
    #[test]
    fn with_overrides_rejects_forbidden_model_key() {
        let mut catalog = ModelCatalog::bundled();
        let version = catalog.version();
        let rejected = catalog.with_overrides(&[serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash-9999",
            "contextWindow": 200_000,
        })]);
        assert_eq!(rejected, 1, "model 键禁覆盖：目标不存在必须拒绝");
        assert_eq!(catalog.version(), version, "全部被拒不得 bump");
        // 未被借覆盖新增条目：entries 无该精确键（lookup 的版本后缀兜底命中
        // 的是内置基础条目，不代表覆盖生效）
        assert!(!catalog.entries.contains_key("deepseek::deepseek-v4-flash-9999"));
        assert_eq!(
            catalog.lookup("deepseek", "deepseek-v4-flash-9999").unwrap().model,
            "deepseek-v4-flash",
            "仅兜底命中内置基础条目，未新增/改名"
        );

        // provider 键禁覆盖：与既有条目通道不一致 → 拒绝
        let rejected = catalog.with_overrides(&[serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash",
            "provider": "other-channel",
        })]);
        assert_eq!(rejected, 1);
        assert_eq!(
            catalog.lookup("deepseek", "deepseek-v4-flash").unwrap().provider,
            "deepseek",
            "provider 不得被覆盖"
        );

        // 缺身份键（无 vendor/model）→ 拒绝
        let rejected = catalog.with_overrides(&[serde_json::json!({
            "contextWindow": 200_000,
        })]);
        assert_eq!(rejected, 1);
    }

    /// 白名单外字段（mode / currency / cacheType 等）→ 整项拒绝，条目不变
    #[test]
    fn with_overrides_rejects_non_whitelisted_fields_per_item() {
        let mut catalog = ModelCatalog::bundled();
        let rejected = catalog.with_overrides(&[serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash",
            "mode": "responses",
            "contextWindow": 300_000,
        })]);
        assert_eq!(rejected, 1, "白名单外字段必须拒绝该项");
        let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
        assert_eq!(flash.context_window, Some(1_000_000), "被拒项不得部分生效");
        assert_eq!(flash.mode.as_deref(), Some("both"), "白名单外字段不动（内置值保留）");

        // 字段类型错误（窗口为字符串）→ 拒绝
        let rejected = catalog.with_overrides(&[serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash",
            "contextWindow": "not-a-number",
        })]);
        assert_eq!(rejected, 1);
    }

    /// 混合批次：合法项生效（version +1）、非法项拒绝，互不阻塞（失败不阻塞仅记录）
    #[test]
    fn with_overrides_partial_batch_keeps_applied_items() {
        let mut catalog = ModelCatalog::bundled();
        let rejected = catalog.with_overrides(&[
            serde_json::json!({
                "vendor": "deepseek",
                "model": "deepseek-v4-flash",
                "contextWindow": 200_000,
            }),
            serde_json::json!({
                "vendor": "deepseek",
                "model": "deepseek-v4-flash-9999",
                "contextWindow": 200_000,
            }),
        ]);
        assert_eq!(rejected, 1, "仅非法项被拒");
        assert_eq!(catalog.version(), 1, "合法项生效 bump 一次");
        assert_eq!(
            catalog.lookup("deepseek", "deepseek-v4-flash").unwrap().context_window,
            Some(200_000)
        );
    }

    // ===== T-24：扫描合并（upsert_from_scan）=====

    /// 合并窗口 / 输出上限 / 能力位；**不覆盖价格族与缓存语义**；version +1
    #[test]
    fn upsert_from_scan_merges_window_and_caps_but_keeps_prices() {
        let mut catalog = ModelCatalog::bundled();
        let version = catalog.version();
        let scan = vec![ScannedModel {
            model: "deepseek-v4-flash".to_string(),
            vendor: Some("deepseek".to_string()),
            context_window: Some(64_000),
            max_output_tokens: Some(8_000),
            capabilities: Some(ScannedCapabilities {
                tools: Some(false),
                vision: Some(true),
                reasoning: Some(false),
            }),
        }];
        let new_version = catalog.upsert_from_scan("deepseek", &scan);
        assert_eq!(new_version, version + 1, "扫描有变更必须 bump");
        let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
        assert_eq!(flash.context_window, Some(64_000), "运行时窗口覆盖");
        assert_eq!(flash.max_output_tokens, Some(8_000));
        assert!(!flash.supports_function_calling);
        assert!(flash.supports_vision);
        assert!(!flash.supports_reasoning);
        // 价格族不被覆盖（扫描无价格字段）
        assert_eq!(flash.input_price, Some(0.14));
        assert_eq!(flash.cache_read_price, Some(0.0028));
        assert_eq!(flash.output_price, Some(0.28));
        // 缓存语义不被覆盖（扫描无缓存字段）
        assert!(flash.supports_prompt_caching);
        assert_eq!(flash.prompt_cache_min_tokens, None, "扫描不携带最低缓存前缀");
        assert_eq!(catalog.prompt_cache_min_tokens_for("deepseek", "deepseek-v4-flash"), 1024);
    }

    /// 未收录模型按猜测新建（vendor 缺省回退 provider）；重复合并幂等（不再 bump）
    #[test]
    fn upsert_from_scan_inserts_unknown_models_and_is_idempotent() {
        let mut catalog = ModelCatalog::bundled();
        let version = catalog.version();
        let scan = vec![ScannedModel {
            model: "gateway-7b".to_string(),
            vendor: None,
            context_window: Some(32_000),
            max_output_tokens: None,
            capabilities: Some(ScannedCapabilities {
                tools: Some(true),
                vision: None,
                reasoning: None,
            }),
        }];
        let new_version = catalog.upsert_from_scan("my-gateway", &scan);
        assert_eq!(new_version, version + 1);
        let entry = catalog.lookup("my-gateway", "gateway-7b").unwrap();
        assert_eq!(entry.model, "gateway-7b");
        assert_eq!(entry.provider, "my-gateway");
        assert_eq!(entry.vendor, "my-gateway", "vendor 缺省回退 provider");
        assert_eq!(entry.context_window, Some(32_000));
        assert!(entry.supports_function_calling);
        assert!(!entry.supports_vision, "能力位未提供 → 保守 false");
        assert_eq!(entry.input_price, None, "扫描无价格字段");
        // 幂等：同样扫描再次合并不产生变更 → 版本不变
        let again = catalog.upsert_from_scan("my-gateway", &scan);
        assert_eq!(again, new_version, "无变更不得重复 bump");
    }

    /// 空扫描 / 空模型名不产生变更
    #[test]
    fn upsert_from_scan_empty_or_blank_keeps_version() {
        let mut catalog = ModelCatalog::bundled();
        let version = catalog.version();
        assert_eq!(catalog.upsert_from_scan("p", &[]), version);
        assert_eq!(
            catalog.upsert_from_scan("p", &[ScannedModel { model: "  ".to_string(), ..Default::default() }]),
            version
        );
        assert_eq!(catalog.version(), version);
    }

    /// 全量快照：按键序返回、条目数与内部一致、不泄露内部可变性
    #[test]
    fn entries_snapshot_returns_sorted_copy() {
        let catalog = ModelCatalog::bundled();
        let snapshot = catalog.entries_snapshot();
        assert_eq!(snapshot.len(), catalog.entries.len());
        let mut keys: Vec<String> = snapshot
            .iter()
            .map(|e| ModelCatalogEntry::key(&e.vendor, &e.model))
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "快照必须按键序");
        let flash = snapshot
            .iter()
            .find(|e| e.model == "deepseek-v4-flash")
            .unwrap();
        assert_eq!(flash.input_price, Some(0.14));
    }
}
