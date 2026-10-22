//! 运行时多模型树（LiveModels）快照及 UnifiedModelsConfig 投影

use std::collections::BTreeMap;

use crate::models::catalog_types::{
    ModelRef, ModelSpec, ProtocolKind, ProviderSpec, UnifiedModelsConfig,
};

use super::entry::ModelCatalogEntry;
use super::store::ModelCatalog;

/// yaml 树 + 扁平目录投影。`live_catalog()` 持有本结构，而不是只持有目录。
///
/// - `revision`：本快照派生自的**已提交修订**。生产路径恒等于
///   `ModelsStore::committed().revision`（同一次提交事务内刷新，杜绝修订撕裂）；
///   空字符串 = 内存夹具（yaml 字符串 / 纯树注入），未绑定任何提交。
/// - `tree` 是第一公民（与 IPC `providers` 同构）
/// - `catalog` 是丢失信息的 lookup 投影，供既有价格/窗口 API
/// - `find` 按 `(provider_id, model_id)` 精确命中 `ModelSpec`，不做后缀/`*`/跨厂商 `[0]`
/// - `parse_error`：显式错误态。`None` = 诚实空树或成功快照；`Some` = 解析失败，
///   **不得**把空 `providers` 当成「用户清空了配置」。
///
/// 装载失败时调用方必须保持上一份成功快照，禁止把 `Err` 写成空 `providers`。
#[derive(Debug, Clone)]
pub struct LiveModels {
    pub revision: String,
    pub tree: UnifiedModelsConfig,
    pub catalog: ModelCatalog,
    pub parse_error: Option<String>,
}

impl LiveModels {
    /// 诚实空树 + 空目录（文件缺失）。不是 `catalog.json`。`parse_error` 为 None。
    pub fn empty() -> Self {
        Self {
            revision: String::new(),
            tree: UnifiedModelsConfig::default(),
            catalog: ModelCatalog::empty(),
            parse_error: None,
        }
    }

    /// 首次解析失败的显式错误态：tree 为空但 `parse_error` 为 Some。
    /// 调用方必须据此区分「没有配置」与「坏文件」，禁止安装成成功快照。
    pub fn parse_failed(message: impl Into<String>) -> Self {
        Self {
            revision: String::new(),
            tree: UnifiedModelsConfig::default(),
            catalog: ModelCatalog::empty(),
            parse_error: Some(message.into()),
        }
    }

    /// yaml → 树 + 投影（内存夹具；`revision` 未绑定提交）。与 IPC 同一套
    /// [UnifiedModelsConfig::from_yaml_str]。**不读盘**。
    pub fn from_yaml_str(yaml_str: &str) -> Result<Self, String> {
        Self::from_unified(UnifiedModelsConfig::from_yaml_str(yaml_str)?)
    }

    /// 纯投影（内存夹具；`revision` 未绑定提交）。
    pub fn from_unified(tree: UnifiedModelsConfig) -> Result<Self, String> {
        Self::project(String::new(), tree)
    }

    /// 生产唯一装载路径：**已提交树 → 纯投影**，并绑定该提交的修订。
    ///
    /// 输入只能来自 `ModelsStore::committed()`（`models.yaml` 的唯一读面），
    /// 因此本函数是纯函数：不读盘、不解析 yaml、不引入第二份真相源。
    pub fn from_committed(
        revision: impl Into<String>,
        tree: UnifiedModelsConfig,
    ) -> Result<Self, String> {
        Self::project(revision.into(), tree)
    }

    fn project(revision: String, mut tree: UnifiedModelsConfig) -> Result<Self, String> {
        tree.normalize_for_commit()?;
        let catalog = project_unified_to_catalog(&tree);
        Ok(Self {
            revision,
            tree,
            catalog,
            parse_error: None,
        })
    }

    /// 精确命中 `(provider_id, model_id)` 的模型规格（不做后缀 / `*` / 跨厂商回落）。
    pub fn find(&self, provider_id: &str, model_id: &str) -> Option<&ModelSpec> {
        self.tree.find_model(provider_id, model_id)
    }
}

/// 从 v2 树投影 [ModelCatalog]。thinking 键保持 TitleCase；modalities 走 `{input,output}`。
pub(crate) fn project_unified_to_catalog(tree: &UnifiedModelsConfig) -> ModelCatalog {
    let mut entries = BTreeMap::new();
    for (provider_id, provider) in &tree.providers {
        for model in &provider.models {
            let entry = project_model_entry(provider_id, provider, model);
            entries.insert(ModelCatalogEntry::key(provider_id, &model.id), entry);
        }
    }
    ModelCatalog {
        entries,
        version: 1,
    }
}

pub(crate) fn project_model_entry(
    provider_id: &str,
    provider: &ProviderSpec,
    model: &ModelSpec,
) -> ModelCatalogEntry {
    // 折叠语义（轨G P2 · 文档化钉死）：yaml 树投影**故意**把 vendor 折叠为
    // provider_id——v2 models.yaml 以 provider 通道为第一公民，不做
    // 「官方厂商 vs 通道」二分（那是 catalog.json 源的字段模型）。
    // 消费方（catalog key / override 合并 / UI 费率表）统一以 provider_id
    // 作 vendor 位；若未来要恢复独立字段，须同步改 ProjectModelEntry 全链路
    // 与 catalog_override 合并规则，禁止单点解折叠。见 catalog_tests
    // `yaml_projection_folds_vendor_into_provider_id`。
    let mut entry = ModelCatalogEntry {
        model: model.id.clone(),
        api_model: Some(model.id.clone()),
        id: Some(ModelRef::new(provider_id, &model.id).key()),
        provider: provider_id.to_string(),
        vendor: provider_id.to_string(),
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
        ..Default::default()
    };

    let proto = model.effective_protocol(provider);
    entry.protocol = Some(proto.as_str().to_string());
    entry.supports_responses = proto == ProtocolKind::OpenAiResponses;

    if let Some(pricing) = &model.pricing {
        entry.currency = Some(pricing.currency.code().to_string());
        entry.input_price = pricing.input;
        entry.output_price = pricing.output;
        entry.cache_read_price = pricing.cache_read;
        entry.cache_write_price = pricing.cache_write;
        entry.cache_write_free = entry.cache_write_price == Some(0.0);
        entry.supports_prompt_caching =
            entry.cache_read_price.is_some() || entry.cache_write_price.is_some();
    }

    if let Some(thinking) = &model.thinking {
        if !thinking.is_empty() {
            let mut tiers = BTreeMap::new();
            for (key, wire) in thinking {
                tiers.insert(key.clone(), Some(wire.clone()));
            }
            entry.thinking_tiers = Some(tiers);
            entry.supports_reasoning = true;
            entry.supports_reasoning_effort = true;
        }
    }

    if let Some(mods) = &model.modalities {
        entry.input_modalities = Some(mods.input.clone());
        entry.output_modalities = Some(mods.output.clone());
        entry.supports_vision = mods.supports_input("image");
        entry.supports_video_input = mods.supports_input("video");
        entry.supports_audio_input = mods.supports_input("audio");
        entry.supports_pdf_input = mods.supports_input("pdf") || mods.supports_input("file");
        entry.supports_audio_output = mods.supports_output("audio");
    }

    entry.cache_ttl = model.cache_ttl.clone();
    entry.supports_function_calling = model.supports_tools == Some(true);
    if let Some(compat) = model.effective_compat(provider) {
        entry.thinking_format = compat
            .thinking_format
            .map(|format| format.as_str().to_string());
    }

    entry
}
