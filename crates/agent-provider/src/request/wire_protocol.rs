//! 模型级协议路由与端点构建单一真源（G4；多模型适配战役 R1 T1.6 / TU-01）
//!
//! 战役不变式 I1：chat / responses / anthropic / gemini 四协议请求构建 + 解析 + 接线全通。
//!
//! 本模块实现 2026 最新架构下的协议决议状态机与端点 URL 规范化拼装：
//! 1. 单向协议决议公式：EffectiveProtocol = Model.protocol ≻ Provider.protocol ≻ "openai/chat"；
//! 2. 规范化端点 URL 拼装纯函数：[build_endpoint_url]，彻底根除基于 URL Substring 的盲猜；
//! 3. 兼容既有 [WireProtocol] 枚举与旧版 [resolve_wire_protocol] 入口，内部统一走三级决议。

use crate::config::Endpoint;
use crate::models::catalog_types::ProtocolKind;
use crate::models::ModelCatalog;
use serde::{Deserialize, Serialize};
use std::fmt;

/// 模型级 wire 协议（单一真源 [resolve_wire_protocol] 的输出；R1 T1.6 契约登记，TU-01 统一扩展）。
///
/// URL / 请求体 builder / 解析器三处统一据此选择，禁止散落硬编码判据。
/// 保持与 [ProtocolKind] 的双向无缝转换。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WireProtocol {
    /// OpenAI 兼容 chat-completions (POST /chat/completions)
    #[default]
    Chat,
    /// OpenAI Responses API (POST /responses)
    Responses,
    /// Anthropic Messages API (POST /v1/messages)
    Anthropic,
    /// Google Gemini generateContent (POST /v1beta/...)
    Gemini,
}

#[allow(non_upper_case_globals)]
impl WireProtocol {
    /// 兼容 ProtocolKind 命名风格的关联常量别名
    pub const OpenAiChat: WireProtocol = WireProtocol::Chat;
    pub const OpenAiResponses: WireProtocol = WireProtocol::Responses;
    pub const AnthropicMessages: WireProtocol = WireProtocol::Anthropic;
    pub const GoogleGenerateContent: WireProtocol = WireProtocol::Gemini;

    /// 稳定短字面量（诊断 / 契约登记 / 既有兼容用）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    /// 获取协议标准 Wire 字符串标识（对齐 ProtocolKind::as_str，如 "openai/chat"）
    pub fn wire_name(self) -> &'static str {
        ProtocolKind::from(self).as_str()
    }

    /// 转换为统一模型目录的 [ProtocolKind]
    pub fn protocol_kind(self) -> ProtocolKind {
        self.into()
    }

    /// 从统一模型目录的 [ProtocolKind] 转换
    pub fn from_protocol_kind(kind: ProtocolKind) -> Self {
        kind.into()
    }

    /// 解析字符串为协议枚举（大小写不敏感，支持全称与常见短别名容错）
    pub fn from_raw_str(s: &str) -> Option<Self> {
        let normalized = s.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "openai/chat" | "chat" | "openai-chat" => Some(Self::Chat),
            "openai/responses" | "responses" | "openai-responses" => Some(Self::Responses),
            "anthropic/messages" | "anthropic" | "messages" | "anthropic-messages" => {
                Some(Self::Anthropic)
            }
            "google/generate-content" | "google" | "gemini" | "generate-content" => {
                Some(Self::Gemini)
            }
            _ => None,
        }
    }

    /// 返回当前协议对应的规范化端点 URL 路径
    pub fn resolve_endpoint_url(&self, base_url: &str) -> String {
        build_endpoint_url((*self).into(), base_url)
    }
}

impl fmt::Display for WireProtocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl From<ProtocolKind> for WireProtocol {
    fn from(kind: ProtocolKind) -> Self {
        match kind {
            ProtocolKind::OpenAiChat => WireProtocol::Chat,
            ProtocolKind::OpenAiResponses => WireProtocol::Responses,
            ProtocolKind::AnthropicMessages => WireProtocol::Anthropic,
            ProtocolKind::GoogleGenerateContent => WireProtocol::Gemini,
        }
    }
}

impl From<WireProtocol> for ProtocolKind {
    fn from(proto: WireProtocol) -> Self {
        match proto {
            WireProtocol::Chat => ProtocolKind::OpenAiChat,
            WireProtocol::Responses => ProtocolKind::OpenAiResponses,
            WireProtocol::Anthropic => ProtocolKind::AnthropicMessages,
            WireProtocol::Gemini => ProtocolKind::GoogleGenerateContent,
        }
    }
}

/// 协议决议输入上下文（供纯函数或扩展场景使用）
#[derive(Debug, Clone, Default)]
pub struct ProtocolResolutionContext<'a> {
    /// 模型级显式配置协议（最优先）
    pub model_protocol: Option<&'a str>,
    /// 供应商级显式配置协议（次优先）
    pub provider_protocol: Option<&'a str>,
}

/// 三级协议决议纯函数 (Single Source of Truth)
///
/// 绝对不包含任何 URL Substring 猜测或模型 ID 启发式判定。
/// 严格执行单向决议公式：EffectiveProtocol = Model.protocol ≻ Provider.protocol ≻ "openai/chat"
pub fn resolve_effective_protocol(
    model_protocol: Option<ProtocolKind>,
    provider_protocol: Option<ProtocolKind>,
) -> ProtocolKind {
    model_protocol
        .or(provider_protocol)
        .unwrap_or(ProtocolKind::OpenAiChat)
}

/// 基于字符串上下文的三级协议决议包装函数
pub fn resolve_effective_protocol_from_context(
    ctx: &ProtocolResolutionContext<'_>,
) -> WireProtocol {
    let model_proto = ctx
        .model_protocol
        .and_then(WireProtocol::from_raw_str)
        .map(ProtocolKind::from);
    let provider_proto = ctx
        .provider_protocol
        .and_then(WireProtocol::from_raw_str)
        .map(ProtocolKind::from);
    WireProtocol::from(resolve_effective_protocol(model_proto, provider_proto))
}

/// 端点 URL 规范化拼装纯函数
///
/// 根除基于 URL Substring 的盲猜与假连通。
/// 规范化规则：
/// 1. 去除 `base_url` 末尾所有斜杠 `/`；
/// 2. 若为 `AnthropicMessages`：如果 `base_url` 已经以 `/v1/messages` 或 `/messages` 结尾，直接返回；若以 `/v1` 结尾，追加 `/messages`，否则追加 `/v1/messages`；
/// 3. 若为 `OpenAiResponses`：如果 `base_url` 已经以 `/responses` 结尾，直接返回；若以 `/v1` 结尾，追加 `/responses`，否则追加 `/v1/responses`；
/// 4. 若为 `OpenAiChat`：如果 `base_url` 已经以 `/chat/completions` 结尾，直接返回；若以 `/v1` 结尾，追加 `/chat/completions`；否则通用归一追加 `/v1/chat/completions`（OpenAI 兼容生态事实标准路径，无域名特判），避免 `//` 或 `/v1/v1`；
/// 5. 若为 `GoogleGenerateContent`：若以 `/v1beta` 结尾则直接返回，否则追加 `/v1beta`。
pub fn build_endpoint_url(protocol: ProtocolKind, base_url: &str) -> String {
    let (trimmed_base, query) = if let Some((p, q)) = base_url.trim().split_once('?') {
        (p.trim_end_matches('/'), Some(q.trim()))
    } else {
        (base_url.trim().trim_end_matches('/'), None)
    };
    let path = match protocol {
        ProtocolKind::AnthropicMessages => {
            if trimmed_base.ends_with("/v1/messages") || trimmed_base.ends_with("/messages") {
                trimmed_base.to_string()
            } else if trimmed_base.ends_with("/v1") {
                format!("{trimmed_base}/messages")
            } else {
                format!("{trimmed_base}/v1/messages")
            }
        }
        ProtocolKind::OpenAiResponses => {
            if trimmed_base.ends_with("/responses") {
                trimmed_base.to_string()
            } else if trimmed_base.ends_with("/v1") {
                format!("{trimmed_base}/responses")
            } else {
                format!("{trimmed_base}/v1/responses")
            }
        }
        ProtocolKind::OpenAiChat => {
            if trimmed_base.ends_with("/chat/completions") {
                trimmed_base.to_string()
            } else if trimmed_base.ends_with("/v1") {
                format!("{trimmed_base}/chat/completions")
            } else {
                // 通用归一：未含版本段即补 `/v1`（OpenAI 兼容生态事实标准路径，
                // 覆盖 openai.com / sensenova / 各类中转站 / DeepSeek 等；
                // 旧域名特判已废除——特判结果与本归一逐例一致）
                format!("{trimmed_base}/v1/chat/completions")
            }
        }
        ProtocolKind::GoogleGenerateContent => {
            if trimmed_base.ends_with("/v1beta") {
                trimmed_base.to_string()
            } else {
                format!("{trimmed_base}/v1beta")
            }
        }
    };
    if let Some(q) = query {
        if !q.is_empty() {
            return format!("{path}?{q}");
        }
    }
    path
}

/// 模型级协议路由单一真源纯函数（向后兼容桥接函数）
///
/// ## 参数
/// - `catalog`：模型目录（fake/内置均可；[ModelCatalog::lookup] 兜底语义复用）
/// - `vendor` / `model`：目录 lookup 键（`{vendor}::{model}`）
/// - `endpoint`：全局端点（`None` = 未显式指定）；仅 `Some(Responses)` 有倾向
///
/// ## 决议逻辑
/// 优先依托三级决议状态机：
/// 1. 检查模型目录中的 `mode`（`responses`, `anthropic`, `gemini`, `both`, `chat`）；
/// 2. 检查 `supports_responses` 能力位与全局 `Endpoint::Responses`；
/// 3. 调用 [resolve_effective_protocol] 完成单向决议与兜底。
pub fn resolve_wire_protocol(
    catalog: &ModelCatalog,
    vendor: &str,
    model: &str,
    endpoint: Option<Endpoint>,
) -> WireProtocol {
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

    let mut model_protocol = None;
    let mut provider_protocol = None;

    // 1. 模型级 mode（单一真源）
    if let Some(entry) = catalog.lookup(vendor, effective_model) {
        if let Some(mode) = entry.mode.as_deref() {
            match mode {
                "responses" => model_protocol = Some(ProtocolKind::OpenAiResponses),
                "anthropic" => model_protocol = Some(ProtocolKind::AnthropicMessages),
                "gemini" => model_protocol = Some(ProtocolKind::GoogleGenerateContent),
                "both" => {
                    // both：endpoint 倾向 responses → responses，否则 chat（00 D3）
                    model_protocol = Some(if endpoint == Some(Endpoint::Responses) {
                        ProtocolKind::OpenAiResponses
                    } else {
                        ProtocolKind::OpenAiChat
                    });
                }
                "chat" => model_protocol = Some(ProtocolKind::OpenAiChat),
                // 其它未识别值 → 落到下一级（不 panic，最终 chat 兜底）
                _ => {}
            }
        }
        // 2. supports_responses 能力位（mode 缺失/未识别）：允许位 + endpoint 倾向
        if model_protocol.is_none()
            && entry.supports_responses
            && endpoint == Some(Endpoint::Responses)
        {
            model_protocol = Some(ProtocolKind::OpenAiResponses);
        }
    }

    // 3. 全局 endpoint（未知模型 / 无能力声明时的显式 responses 请求）
    if model_protocol.is_none() && endpoint == Some(Endpoint::Responses) {
        provider_protocol = Some(ProtocolKind::OpenAiResponses);
    }

    // 4. 三级单向纯函数决议
    let effective = resolve_effective_protocol(model_protocol, provider_protocol);
    WireProtocol::from(effective)
}

#[cfg(test)]
#[path = "wire_protocol_tests.rs"]
mod tests;
