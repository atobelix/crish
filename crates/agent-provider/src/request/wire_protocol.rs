//! 模型级协议路由单一真源（G4；多模型适配战役 R1 T1.6）
//!
//! 战役不变式 I1：chat / responses / anthropic / gemini 四协议请求构建 + 解析 + 接线
//! 全通。本文件提供 [WireProtocol] 枚举与 [resolve_wire_protocol] 纯函数——它是「模型点
//! → 走哪个 wire 协议」的唯一判据，URL / 请求体 builder / 解析器三处（R3 T3.2 消费）统一
//! 由此函数输出决定，对齐既有「URL/body/parser 三件套必须同轨」铁律
//! （`engine_provider.rs:259-262`；分析 01·G4，`analysis/01-协议与请求构建层对比.md:45`）。
//!
//! 单一真源：目录条目 `mode` 字段（`catalog.rs:59`，值域 `"chat"/"responses"/"both"`，
//! 本轮扩展 `"anthropic"/"gemini"`）成为**模型级协议路由键**，叠加 `supports_responses`
//! 能力位与全局 [Endpoint] 兜底。
//!
//! 决议优先级（设计，保持向后兼容）：
//!
//! 0. **点号→横线归一（A6）**：lookup 键采用**横线形态**（如 `gemini-2-5-pro`，目录顶层键
//!    `vendor::model` 全程横线），而 API 请求面常使用**点号异形体**（apiModel，如
//!    `gemini-2.5-pro`）——点号形态精确匹配目录键会落空而误走 chat 兜底。故在一次精确
//!    lookup 落空后，用「点号→横线」归一表单体重试一次（仅影响目录命中，不改写返回的
//!    protocol；未命中的点号模型仍以 chat 兜底语义落回原行为）。仅在该模型名含点号时
//!    触发，不影响既有横线键路径。
//! 1. **模型级 `mode`**（条目命中且 `mode` 有值，单一真源）：
//!    - `"responses"` → [WireProtocol::Responses]
//!    - `"anthropic"` → [WireProtocol::Anthropic]
//!    - `"gemini"`   → [WireProtocol::Gemini]
//!    - `"both"`     → 按 endpoint 或 vendor 推断：`endpoint == Responses` → Responses，
//!      否则 chat（00 D3：未显式指定恒 chat-completions）
//!    - `"chat"`     → [WireProtocol::Chat]
//!    - 其它未识别值 → 不据此裁定，落到下一级（最终 chat 兜底，不 panic）
//! 2. **`supports_responses` 能力位**（mode 缺失/未识别时）：能力位是**允许位**而非路由键
//!    （对齐 01 分析「supports_responses 是能力位，不是路由判据」），须叠加 endpoint 倾向
//!    responses 才取 Responses：`endpoint == Some(Responses) && supports_responses`
//!    → [WireProtocol::Responses]。
//! 3. **全局 [Endpoint]**（未知模型 / 无能力声明时的显式 responses 请求）：
//!    `endpoint == Some(Responses)` → [WireProtocol::Responses]。
//! 4. **chat 兜底**：以上均未命中（endpoint 缺省 / auto / chat-completions）→
//!    [WireProtocol::Chat]（00 D3：未显式指定恒 chat-completions）。

use crate::config::Endpoint;
use crate::models::ModelCatalog;

/// 模型级 wire 协议（单一真源 [resolve_wire_protocol] 的输出；R1 T1.6 契约登记）。
///
/// URL / 请求体 builder / 解析器三处统一据此选择，禁止散落硬编码判据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireProtocol {
    /// OpenAI 兼容 chat-completions
    Chat,
    /// OpenAI Responses API
    Responses,
    /// Anthropic Messages API（anthropic-version 头 / thinking.budget_tokens）
    Anthropic,
    /// Google Gemini generateContent（generationConfig.thinking_level / usageMetadata）
    Gemini,
}

impl WireProtocol {
    /// 稳定字面量（诊断 / 契约登记用）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

/// 模型级协议路由单一真源纯函数（G4；R1 T1.6）
///
/// ## 参数
/// - `catalog`：模型目录（fake/内置均可；[ModelCatalog::lookup] 兜底语义复用）
/// - `vendor` / `model`：目录 lookup 键（`{vendor}::{model}`）
/// - `endpoint`：全局端点（`None` = 未显式指定）；仅 `Some(Responses)` 有倾向
///
/// ## 决议优先级
/// 模型级 `mode` → `supports_responses` → 全局 [Endpoint] → chat 兜底。
/// 详见模块文档。纯函数：无 IO、无状态，只读 [ModelCatalog]。
pub fn resolve_wire_protocol(
    catalog: &ModelCatalog,
    vendor: &str,
    model: &str,
    endpoint: Option<Endpoint>,
) -> WireProtocol {
    let resolved_for_endpoint = |endpoint: Option<Endpoint>| match endpoint {
        Some(Endpoint::Responses) => WireProtocol::Responses,
        _ => WireProtocol::Chat,
    };

    // 0. 一次精确目录命中（含 model 级 mode 与 supports_responses 决定）。
    //    未命中且模型名含点号（apiModel 异形体）→ 用点号→横线归一表单体重试一次
    //    （A6；如 `gemini-2.5-pro` → 横线键 `gemini-2-5-pro`）。
    let mut effective_model = model;
    let normalized = model.contains('.').then(|| model.replace('.', "-"));
    if catalog.lookup(vendor, effective_model).is_none() {
        if let Some(norm) = normalized.as_deref() {
            effective_model = norm;
        }
    }

    // 1. 模型级 mode（单一真源）
    if let Some(entry) = catalog.lookup(vendor, effective_model) {
        if let Some(mode) = entry.mode.as_deref() {
            match mode {
                "responses" => return WireProtocol::Responses,
                "anthropic" => return WireProtocol::Anthropic,
                "gemini" => return WireProtocol::Gemini,
                "both" => {
                    // both：endpoint 倾向 responses → responses，否则 chat（00 D3）
                    return resolved_for_endpoint(endpoint);
                }
                "chat" => return WireProtocol::Chat,
                // 其它未识别值 → 落到下一级（不 panic，最终 chat 兜底）
                _ => {}
            }
        }
        // 2. supports_responses 能力位（mode 缺失/未识别）：允许位 + endpoint 倾向
        if entry.supports_responses && endpoint == Some(Endpoint::Responses) {
            return WireProtocol::Responses;
        }
    }

    // 3. 全局 endpoint（未知模型 / 无能力声明时的显式 responses 请求）
    resolved_for_endpoint(endpoint)
}

#[cfg(test)]
#[path = "wire_protocol_tests.rs"]
mod tests;
