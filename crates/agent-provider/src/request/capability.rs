//! 模型能力描述只读接口（G8-a · 多模型适配战役 R2 T2.4）
//!
//! 描述面只读数据：[ModelCapability] 暴露一个模型的稳定能力描述（supports_reasoning /
//! 档位白名单 / 默认档位 / wire 协议），供 3 处消费：
//! - **前端档位面板**（R5 T5.2b 唯一数据源，S-B7）；
//! - **请求校验面**（R4 T4.1 数据源，档位白名单判断依据）；
//! - 目录服务 / 诊断。
//!
//! ## 战役不变式 I4（能力描述与请求校验分离：描述面不隐藏提供方）
//!
//! - **合并语义（模型级优先、系列级兜底）**：模型级档位载体存在且提供档位非空
//!   （[ModelCatalogEntry::offered_levels]）→ 以模型级白名单为准；未声明（或声明
//!   非法/空）→ 回落系列级能力表（[infer_thinking_capability] 的 levels）。
//!   「交集语义」落定说明：模型级存在时以模型级为准（模型显式声明其完整白名单，
//!   比系列级更细），系列级仅作兜底，不做集合求交（求交会引入模型级未覆盖的系列档，
//!   违背「未覆盖档位不出现」；且模型级声明本身即对系列能力的细粒度修正）。
//! - **不隐藏提供方纪律**：单模型的坏配置（如 tiers 声明非法/空、`supports_reasoning`
//!   显式 false）只把**该模型**描述为保守默认（supports_reasoning=false 或系列级兜底），
//!   绝不抛错、绝不影响同 provider 其它模型的描述（对齐
//!   `llm-pi-ai/README.zh.md:115`「坏配置暴露在被执行处而非描述处」，由
//!   `capability_tests.rs` 的「A 坏配置 B 仍可描述」用例钉死）。
//! - **档位白名单只含支持的档位**（隐藏档不出现）；`efforts` 是**规范档位**——
//!   G6 wire 拼写改名（如 `{"medium":"high"}`）不进入白名单，白名单恒为规范名。
//!
//! ## 依赖方向
//!
//! 本模块位于 request 层：依赖 [crate::request::WireProtocol]（[resolve_wire_protocol]）、
//! [crate::models::ModelCatalog] 与 [infer_thinking_capability]。**不反向污染 models
//! 层**——`models/catalog.rs` 文档明确「catalog.rs 不依赖 request/parse 层」，故本接口
//! 放 request 层而非 models 层，保持既有依赖方向（与 vendor_capability.rs / wire_protocol.rs
//! 同区位）。
//!
//! ## 消费注意（契约登记，R4 T4.1 / R5 T5.2b 用）
//!
//! - `supports_reasoning == false` → 前端不渲染档位面板、请求面不落 reasoning 参数；
//! - `efforts` 为规范档位白名单（字典语义「未覆盖档位不出现」），请求面以其做支持判定；
//! - `default_effort` 为**派生默认**（取 efforts 首个），非显式配置；前端作面板默认高亮。

use crate::config::Endpoint;
use crate::models::{ModelCatalog, ModelCatalogEntry};
use crate::request::{infer_thinking_capability, resolve_wire_protocol, WireProtocol};

/// 模型能力描述（描述面只读数据；G8-a 契约登记）。
///
/// 均为纯派生字段，消费方只读；不承载请求构建逻辑（请求侧走 R4 校验面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCapability {
    /// 是否支持 reasoning。粗粒度门：模型级档位白名单非空 / catalog `supports_reasoning`
    /// 能力位 / 系列级能力表三源合并（见 [describe_model]）。
    pub supports_reasoning: bool,
    /// 档位白名单（规范档位字符串，只含支持的档位，隐藏档不出现）。
    /// 模型级存在时 = [ModelCatalogEntry::offered_levels]（字典序并集）；
    /// 系列级兜底时 = 系列能力表 levels 的规范名（不含 Off）。
    pub efforts: Vec<String>,
    /// 派生默认档位（efforts 首个；efforts 为空 → None）。非显式配置。
    pub default_effort: Option<String>,
    /// 模型级 wire 协议（复用 C4 [WireProtocol] 单一真源 [resolve_wire_protocol]）。
    pub wire_protocol: WireProtocol,
}

/// 描述一个模型的能力（G8-a 只读描述接口，合并 `infer_thinking_capability` + catalog 能力位）。
///
/// ## 合并语义
/// 1. **档位白名单**：模型级 [ModelCatalogEntry::offered_levels] 非空 → 以模型级为准；
///    未声明 / 非法(空) → 系列级 [infer_thinking_capability] levels 兜底（规范名）。
/// 2. **supports_reasoning**：模型级白名单非空 → true；否则 = series.supported
///    ∧ catalog 粗粒度门控（entry 不存在或 entry.supports_reasoning 非 false）。
///    即 catalog 显式 `supports_reasoning=false` 时保守为 false（不隐藏，仅该模型）。
/// 3. **default_effort**：efforts 首个（派生默认）。
/// 4. **wire_protocol**：[resolve_wire_protocol] 单一真源（C4；mode → supports_responses →
///    endpoint → chat 兜底）。
///
/// 纯函数：无 IO、无状态、只读 [ModelCatalog]；任何 bad config 不 panic（不隐藏提供方）。
pub fn describe_model(
    catalog: &ModelCatalog,
    vendor: &str,
    model: &str,
    endpoint: Option<Endpoint>,
) -> ModelCapability {
    let entry = catalog.lookup(vendor, model);
    let series = infer_thinking_capability(model);

    // 1. 模型级档位白名单优先：offered_levels 提供档并集（隐藏档不入集、规范档位）。
    let model_levels = entry
        .map(ModelCatalogEntry::offered_levels)
        .unwrap_or_default();

    // 2. 档位白名单 + supports_reasoning 合并（模型级非空 → 模型级为准）。
    let (efforts, supports_reasoning) = if !model_levels.is_empty() {
        (model_levels, true)
    } else {
        // 模型级未声明/非法 → 系列级兜底，叠加 catalog 能力位粗粒度保守门控。
        let series_levels: Vec<String> = series
            .levels
            .iter()
            .map(|level| level.as_str().to_owned())
            .collect();
        // entry 不存在（未知模型）→ 无门控（true）；存在且显式 supports_reasoning=false → 保守 false。
        let coarse_gate = entry.is_none_or(|entry| entry.supports_reasoning);
        (series_levels, series.supported && coarse_gate)
    };

    // 3. 派生默认档位（efforts 首个；空 → None）。
    let default_effort = (!efforts.is_empty()).then(|| efforts[0].clone());

    // 4. wire 协议单一真源（C4）。
    let wire_protocol = resolve_wire_protocol(catalog, vendor, model, endpoint);

    ModelCapability {
        supports_reasoning,
        efforts,
        default_effort,
        wire_protocol,
    }
}

#[cfg(test)]
#[path = "capability_tests.rs"]
mod tests;
