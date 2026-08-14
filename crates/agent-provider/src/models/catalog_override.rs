//! 扫描合并与覆盖变更面（SR-06e · 拆分 · ≠ EL）
//!
//! 从 models/catalog.rs 拆出的实现域（T-24：运行时合并与覆盖，任何变更
//! version +1）：
//! - 扫描模型类型（[super::ScannedCapabilities] / [super::ScannedModel]）
//! - [super::ModelCatalog::upsert_from_scan] / [super::ModelCatalog::entries_snapshot]
//! - [super::ModelCatalog::with_overrides] 覆盖面（白名单表在本文定义）
//!
//! 门面（models/catalog.rs）re-export 公开符号，对外路径不变。

use serde::{Deserialize, Serialize};

use super::{CatalogError, ModelCatalog, ModelCatalogEntry};

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

impl ModelCatalog {
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

    /// 某 provider 路由的 models 列表整体替换（对齐 DSH profile `models` 语义）。
    ///
    /// 语义：声明列表后，该路由（`entry.provider == provider`）**只服务列表内模型**——
    /// 列表未点名的既有本路由条目一律移除；未调用本入口（未声明）时原 catalog 全量
    /// 服务。与 [Self::upsert_from_scan]（逐条扫描合并）/ [Self::with_overrides]
    /// （条目覆盖白名单）三模式并存、互不干扰，且不受对方先执行顺序影响。
    ///
    /// 覆盖项校验沿用既有白名单纪律（[OVERRIDE_WHITELIST] / [OVERRIDE_BOOL_FIELDS]）：
    /// - 项必须是对象，`vendor` + `model` 必填作身份键（定义服务模型）；`provider`
    ///   出现时**必须等于路由参数**（禁改 provider 键）；白名单外字段整项拒绝；
    /// - 模型身份键（model/provider/vendor）只用于定位/定义，禁止借替换改名或跨路由
    ///   挪动——`vendor::model` 键已被**其它 provider 路由**占用时拒绝（防键冲突）；
    /// - 全量校验先行，任一项非法 → 整体返回 [CatalogError]，目录零改动（对齐 DSH
    ///   "拒绝而不是跳过"）；成功则已变更（新增/合并字段/移除未点名旧条目）版本号 +1。
    ///
    /// 返回：成功 = 变更后版本号；失败 = `CatalogError`（ForbiddenField /
    /// InvalidOverride，目录未变化）。
    pub fn replace_models(
        &mut self,
        provider: &str,
        models: &[serde_json::Value],
    ) -> Result<u64, CatalogError> {
        let provider = provider.trim();
        if provider.is_empty() {
            return Err(CatalogError::InvalidOverride(
                "replace_models provider 不能为空".to_string(),
            ));
        }

        // ── 阶段一：全量解析 + 校验（任一项非法即整体拒绝，目录零改动）──
        // 每项预解析为 (键, 解析条目, 原对象)，原对象仅供能力位"键显式出现"判定。
        let mut items: Vec<(
            String,
            ModelCatalogEntry,
            serde_json::Map<String, serde_json::Value>,
        )> = Vec::with_capacity(models.len());
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for item in models {
            let obj = item.as_object().ok_or_else(|| {
                CatalogError::InvalidOverride("模型项必须是 JSON 对象".to_string())
            })?;
            validate_override_keys(obj)?;
            let parsed: ModelCatalogEntry = serde_json::from_value(item.clone())
                .map_err(|e| CatalogError::InvalidOverride(e.to_string()))?;
            if parsed.vendor.trim().is_empty() || parsed.model.trim().is_empty() {
                return Err(CatalogError::InvalidOverride(
                    "模型项缺少 vendor/model 身份键".to_string(),
                ));
            }
            if !parsed.provider.trim().is_empty() && parsed.provider.trim() != provider {
                return Err(CatalogError::ForbiddenField("provider".to_string()));
            }
            let key = ModelCatalogEntry::key(&parsed.vendor, &parsed.model);
            // 重复声明同一 vendor::model → 列表歧义，拒绝
            if !seen.insert(key.clone()) {
                return Err(CatalogError::InvalidOverride(format!(
                    "重复声明模型键：{key}"
                )));
            }
            // 键已被其它 provider 路由占用 → 防键冲突（禁改 vendor 挪动条目）
            if let Some(existing) = self.entries.get(&key) {
                if existing.provider != provider {
                    return Err(CatalogError::ForbiddenField("provider".to_string()));
                }
            }
            items.push((key, parsed, obj.clone()));
        }

        // ── 阶段二：应用（已全量校验通过，绝无失败分支）──
        let allowed: std::collections::BTreeSet<String> =
            items.iter().map(|(k, _, _)| k.clone()).collect();
        let mut changed = false;

        // 1) 移除本路由未列入 allowed 的既有条目（只服务列表内模型）
        let provider_owned: Vec<String> = self
            .entries
            .iter()
            .filter(|(k, e)| e.provider == provider && !allowed.contains(*k))
            .map(|(k, _)| k.clone())
            .collect();
        for key in provider_owned {
            self.entries.remove(&key);
            changed = true;
        }

        // 2) 逐项应用（既有条目字段合并 / 新建默认条目 + 白名单覆盖）
        for (key, parsed, obj) in &items {
            let existed = self.entries.contains_key(key);
            let pre = self.entries.get(key).cloned();
            let entry = self
                .entries
                .entry(key.clone())
                .or_insert_with(|| ModelCatalogEntry {
                    model: parsed.model.clone(),
                    provider: provider.to_string(),
                    vendor: parsed.vendor.clone(),
                    ..Default::default()
                });
            // 白名单字段合併（语义同 apply_override_item；缺失字段 = 不动）
            if let Some(value) = parsed.context_window {
                entry.context_window = Some(value);
            }
            if let Some(value) = parsed.max_output_tokens {
                entry.max_output_tokens = Some(value);
            }
            if let Some(value) = parsed.input_price {
                entry.input_price = Some(value);
            }
            if let Some(value) = parsed.output_price {
                entry.output_price = Some(value);
            }
            if let Some(value) = parsed.cache_read_price {
                entry.cache_read_price = Some(value);
            }
            if let Some(value) = parsed.cache_write_price {
                entry.cache_write_price = Some(value);
            }
            if let Some(value) = parsed.cache_write_price_5m {
                entry.cache_write_price_5m = Some(value);
            }
            if let Some(value) = parsed.cache_write_price_1h {
                entry.cache_write_price_1h = Some(value);
            }
            if let Some(value) = parsed.storage_price_per_1m_hour {
                entry.storage_price_per_1m_hour = Some(value);
            }
            if let Some(value) = parsed.prompt_cache_min_tokens {
                entry.prompt_cache_min_tokens = Some(value);
            }
            apply_bool_fields(entry, parsed, obj);
            if !existed || pre.as_ref() != Some(entry) {
                changed = true;
            }
        }

        if changed {
            self.version += 1;
        }
        Ok(self.version)
    }

    /// 单条覆盖项应用（键级白名单校验 → 整项 serde 解析 → 身份定位 → 字段合并）。
    fn apply_override_item(&mut self, item: &serde_json::Value) -> Result<(), CatalogError> {
        let obj = item
            .as_object()
            .ok_or_else(|| CatalogError::InvalidOverride("覆盖项必须是 JSON 对象".to_string()))?;
        // 键级白名单：身份键 model/provider/vendor 只用于定位，其余必须命中白名单
        validate_override_keys(obj)?;
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
        if let Some(value) = patch.prompt_cache_min_tokens {
            entry.prompt_cache_min_tokens = Some(value);
        }
        // 能力位：键显式出现才应用（支持显式 false 关闭；缺失 = 不动）
        apply_bool_fields(entry, &patch, obj);
        Ok(())
    }
}

/// 覆盖白名单（camelCase 键，与 [ModelCatalogEntry] serde 键一致）：
/// 窗口 / 输出上限 / 价格族 / 最低可缓存前缀。
/// 禁覆盖键 model / provider / vendor 不在此列——身份键只用于定位，值必须与目标条目一致。
/// v1 遗留 `longContextInputPrice` 随结构移除（v2 迁入 tieredPricing，03 §7.1）。
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
    (
        "supportsCacheControl",
        |e| e.supports_cache_control,
        |e, v| e.supports_cache_control = v,
    ),
    (
        "supportsPromptCaching",
        |e| e.supports_prompt_caching,
        |e, v| e.supports_prompt_caching = v,
    ),
    (
        "supportsResponses",
        |e| e.supports_responses,
        |e, v| e.supports_responses = v,
    ),
    (
        "supportsReasoning",
        |e| e.supports_reasoning,
        |e, v| e.supports_reasoning = v,
    ),
    (
        "supportsReasoningEffort",
        |e| e.supports_reasoning_effort,
        |e, v| e.supports_reasoning_effort = v,
    ),
    (
        "supportsVision",
        |e| e.supports_vision,
        |e, v| e.supports_vision = v,
    ),
    (
        "supportsFunctionCalling",
        |e| e.supports_function_calling,
        |e, v| e.supports_function_calling = v,
    ),
    (
        "supportsParallelFunctionCalling",
        |e| e.supports_parallel_function_calling,
        |e, v| e.supports_parallel_function_calling = v,
    ),
    (
        "supportsSystemMessages",
        |e| e.supports_system_messages,
        |e, v| e.supports_system_messages = v,
    ),
    (
        "supportsResponseSchema",
        |e| e.supports_response_schema,
        |e, v| e.supports_response_schema = v,
    ),
];

/// 键级白名单校验：身份键 model/provider/vendor 只用于定位，其余键必须命中
/// 覆盖白名单（[OVERRIDE_WHITELIST]）或能力位表（[OVERRIDE_BOOL_FIELDS]）；
/// 命中失败 → [CatalogError::ForbiddenField]。
fn validate_override_keys(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), CatalogError> {
    for key in obj.keys() {
        if !matches!(key.as_str(), "model" | "provider" | "vendor")
            && !OVERRIDE_WHITELIST.contains(&key.as_str())
            && !OVERRIDE_BOOL_FIELDS.iter().any(|(k, _, _)| *k == key)
        {
            return Err(CatalogError::ForbiddenField(key.clone()));
        }
    }
    Ok(())
}

/// 能力位应用：键显式出现才应用（支持显式 false 关闭；键缺失 = 不动），
/// 由 `obj` 判定显式性、`patch` 取新值写回 `entry`。
fn apply_bool_fields(
    entry: &mut ModelCatalogEntry,
    patch: &ModelCatalogEntry,
    obj: &serde_json::Map<String, serde_json::Value>,
) {
    for (wire_key, read, write) in OVERRIDE_BOOL_FIELDS {
        if obj.contains_key(*wire_key) {
            write(entry, read(patch));
        }
    }
}
