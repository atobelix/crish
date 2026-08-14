//! G5-compat 消息序列化消费辅助（SR-06e · 拆分 · ≠ EL；R2 T2.2/T2.3）
//!
//! 从 messages.rs 拆出的「[WireCompat] 上下文载体 + 模型级判定辅助」子模块：
//! - 序列化层（messages.rs / to_chat_messages_with_compat）按 [WireCompat] 驱动
//!   reasoning_content 强制键与 developer role；本模块承载判定入参载体与纯判定。
//! - 对齐 R1 T1.7 纯函数面（compat.rs 的 [resolve_developer_role] /
//!   [empty_content_wire_value]），保持「判定是纯函数消费，不是领域层逻辑」——
//!   不向 [AgentMessage] / 会话状态注入任何合成内容（INV-07 领域真实性）。
//!
//! SR-06e · 拆分 · ≠ EL：独立新子模块（[messages.rs] 经 `#[path]` 接线）。

use conex_types::message::AgentMessage;

use super::super::compat::resolve_developer_role;
use super::messages_content::thought_content;

/// wire 消息序列化 compat 上下文（G5-a/G5-b · T2.2/T2.3；R2 消息序列化消费面）
///
/// 承载 R1 T1.7 纯函数面的消费入参：vendor/model/base_url 用于判定 DeepSeek
/// （reasoning_content 模型级强制键）与 developer role。全部 `None`/`false` 的
/// 缺省形态 = 非 DeepSeek 默认轨：reasoning_content 不强制、system role 恒
/// `"system"`，与既有 `to_chat_messages` 四参入口的 wire 字节逐字节一致
/// （适配层 R3 T3.2 接线前，本入口不影响既有请求形状）。
#[derive(Debug, Clone, Copy, Default)]
pub struct WireCompat<'a> {
    /// 厂商名（DeepSeek 判定与 developer role 判定入参；`None` → 非 DeepSeek 轨）
    pub vendor: Option<&'a str>,
    /// 模型名（[resolve_developer_role] 的 `anthropic/`|`openai/` 前缀判定）
    pub model: Option<&'a str>,
    /// base_url（DeepSeek 判定与 developer role 的 openrouter 判定）
    pub base_url: Option<&'a str>,
    /// 是否支持 reasoning（developer role 判定的三要素之一）
    pub supports_reasoning: bool,
}

impl<'a> WireCompat<'a> {
    /// DeepSeek 厂商推断：vendor 名或 base_url 含 `"deepseek"`（逐字节确定，
    /// 与 R1 compat 纯函数同口径 lowercase）。`None` 入参 → `false`（默认轨）。
    pub fn is_deepseek(&self) -> bool {
        let vendor = self.vendor.unwrap_or("").to_ascii_lowercase();
        let url = self.base_url.unwrap_or("").to_ascii_lowercase();
        vendor.contains("deepseek") || url.contains("deepseek")
    }
}

/// system 消息 wire 角色（G5-a · T2.3）：[resolve_developer_role] 返回真 →
/// `"developer"`，否则 `"system"`（chat 轨 NativeSystemRole 分支消费；
/// user-prefix 分支由调用方恒置 `"user"` 不参与本判定）。
///
/// 缺省 [WireCompat]（supports_reasoning=false → 恒 `false`）时恒返回
/// `"system"`，与既有字节一致。判定是纯函数消费，不属地领域层。
pub fn resolve_system_role(compat: &WireCompat<'_>) -> &'static str {
    if resolve_developer_role(
        compat.vendor.unwrap_or(""),
        compat.model.unwrap_or(""),
        compat.base_url.unwrap_or(""),
        compat.supports_reasoning,
    ) {
        "developer"
    } else {
        "system"
    }
}

/// DeepSeek reasoning_content 模型级强制键取值（G5-b · T2.2）
///
/// DeepSeek 厂商 + 带 tool_calls 的回合 → 必带键：有思考回传思考、无思考空串
/// 兜底（对齐 DSH serialize.ts:99 的 tool-call 回合必带 passback 语义；直接读
/// [thought_content]，不经 [ReasoningContentMode]——模型级强制不以 Omit 的省略
/// 语义丢弃既有思考）。非 DeepSeek 或非 tool-call 回合 → 返回 `None`，由调用方
/// 沿用既有 mode 语义（不改写）。
pub fn deepseek_tool_call_reasoning(
    compat: &WireCompat<'_>,
    has_tool_call: bool,
    message: &AgentMessage,
) -> Option<String> {
    if !(compat.is_deepseek() && has_tool_call) {
        return None;
    }
    let thought = thought_content(message);
    if thought.is_empty() {
        Some(String::new())
    } else {
        Some(thought)
    }
}
