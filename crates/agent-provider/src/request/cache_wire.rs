//! wire 施加面（SR-06e · 拆分 · ≠ EL）
//!
//! 从 request/cache.rs 拆出的实现域：在 wire 消息序列上施加断点
//! （[super::apply_cache_controls] / [super::cache_control_for_ttl] /
//! [super::text_to_parts_with_cc]）。纯后处理 pass，与 to_chat_messages 解耦。
//!
//! 门面（request/cache.rs）re-export 全部公开符号，对外路径不变。

use super::{BreakpointPlan, BreakpointReport, CacheControl, TtlBucket};
use crate::request::messages::{ChatContent, ChatContentPart, ChatMessage};

/// 在 wire 消息序列上施加断点（A 子主题的注入执行面；纯后处理 pass，与
/// to_chat_messages 解耦——既有 0 深拷贝映射保持纯函数，断点逻辑独立可测）
///
/// 锚点规则（对齐 pi 三锚点 anthropic-messages.ts:991-1000/1256-1278/1320、
/// Kimi 三锚点 kimi-code-cache-analysis.md:109-117）：
/// - system：第一条 role=system 消息（user-prefix 模式下 system prompt 已被改写
///   为 user 角色，回退首条 user 消息），文本内容改写为 parts 数组形态
///   （string content 无法携带 cache_control，pi-cache-analysis.md:139）；
/// - messages：最后一条 role=user 或 role=tool 消息（工具循环内 tool_result
///   承载历史缓存；OpenAI 兼容线路上 tool 结果落在 role=tool 消息）；
///   端点支持消息级断点（supports_message_cache_control=true，Anthropic 原生
///   端点"顶层自动模式"）时挂消息级字段、不改写内容；部分兼容端点只认
///   content part 级（false）时挂最后一个文本块；
/// - 可缓存类型白名单：text 块（image/document/tool_result 等随 wire 扩展）；
/// - TTL 桶 → 块级断点值（[super::cache_control_for_ttl]）；
/// - plan 全 false → 零报告且请求字节与未施加时完全一致；
/// - 锚点不存在（无 system/user/tool 消息）或无可缓存文本块 → dropped 记账，
///   不报错（P5 归因消费，P5 §3.4.3）。
///
/// 【接线】载体字段 ChatContentPart::Text.cache_control / ChatMessage.cache_control
/// 由 T-14（messages.rs）交付；本函数为 T-15 build.rs post-pass 的调用面
/// （`apply_cache_controls(&mut wire, &plan, policy.ttl, supports_message_cache_control)`）。
pub fn apply_cache_controls(
    messages: &mut [ChatMessage],
    plan: &BreakpointPlan,
    ttl: TtlBucket,
    supports_message_cache_control: bool,
) -> BreakpointReport {
    let mut report = BreakpointReport::default();
    if !plan.has_any() {
        return report;
    }
    let cc = cache_control_for_ttl(ttl);

    // system 锚点：首条 role=system 消息；user-prefix 模式（无 system 角色）
    // 回退首条 user 消息。文本内容改写为 parts 形态挂断点。
    let system_index = if plan.system {
        messages
            .iter()
            .position(|m| m.role == "system")
            .or_else(|| messages.iter().position(|m| m.role == "user"))
    } else {
        None
    };
    match system_index {
        Some(index) => {
            if apply_part_level_cc(&mut messages[index], cc) {
                report.placed += 1;
            } else {
                report.dropped += 1;
            }
        }
        // 请求了 system 断点但锚点不存在 → 无法放置，dropped 记账
        None => {
            if plan.system {
                report.dropped += 1;
            }
        }
    }

    // messages 锚点：最后一条 role=user / role=tool 消息
    let messages_index = if plan.messages {
        messages.iter().rposition(|m| m.role == "user" || m.role == "tool")
    } else {
        None
    };
    match messages_index {
        Some(index) => {
            // system 回退锚点与 messages 锚点重合（单条 user 消息场景）→
            // 不重复放置（断点已由 system 锚点落在同一消息上）
            if Some(index) == system_index {
                return report;
            }
            let placed = if supports_message_cache_control {
                // 端点支持消息级断点：整条消息挂 cache_control（无内容改写，
                // Anthropic 原生端点顶层自动模式载体）
                if messages[index].cache_control.is_some() {
                    false
                } else {
                    messages[index].cache_control = Some(cc);
                    true
                }
            } else {
                apply_part_level_cc(&mut messages[index], cc)
            };
            if placed {
                report.placed += 1;
            } else {
                report.dropped += 1;
            }
        }
        // 请求了 messages 断点但锚点不存在 → 无法放置，dropped 记账
        None => {
            if plan.messages {
                report.dropped += 1;
            }
        }
    }
    report
}

/// part 级断点施加：Text 内容改写为 parts 形态挂断点；Parts 内容挂到最后一个
/// 文本块（白名单）；content=None / 无文本块 → 无法放置返回 false（计入 dropped）
fn apply_part_level_cc(message: &mut ChatMessage, cc: CacheControl) -> bool {
    match message.content.take() {
        Some(ChatContent::Text(text)) => {
            message.content = Some(text_to_parts_with_cc(&text, cc));
            true
        }
        Some(ChatContent::Parts(mut parts)) => {
            let cacheable = parts
                .iter_mut()
                .rev()
                .find_map(|part| match part {
                    ChatContentPart::Text { cache_control, .. } => Some(cache_control),
                    _ => None,
                });
            match cacheable {
                Some(part_cc) => {
                    *part_cc = Some(cc);
                    message.content = Some(ChatContent::Parts(parts));
                    true
                }
                // 纯图片等无文本块 → 白名单外，无法放置
                None => {
                    message.content = Some(ChatContent::Parts(parts));
                    false
                }
            }
        }
        None => false,
    }
}

/// TTL 桶 → 块级断点值（Anthropic 系 wire 值映射；T-15 工具级附加
/// to_cache_aware_tool 同款复用，避免双实现漂移）
pub fn cache_control_for_ttl(ttl: TtlBucket) -> CacheControl {
    match ttl {
        TtlBucket::FiveMinutes => CacheControl::Ephemeral,
        TtlBucket::OneHour => CacheControl::Ephemeral1h,
    }
}

/// 文本消息 → parts 数组形态（对齐 pi：string content 无法携带 cache_control，
/// pi-cache-analysis.md:139；kimi-code-cache-analysis.md:113-117）
///
/// 输出 `Parts([Text { text, cache_control: Some(cc) }])`——调用方（system/messages
/// 锚点施加、T-15 断点改写）把 string content 改写为可携带断点的形态；
/// wire 形状：`{"type":"text","text":..,"cache_control":{"type":"ephemeral"}[,"ttl":"1h"]}`。
pub fn text_to_parts_with_cc(text: &str, cc: CacheControl) -> ChatContent {
    ChatContent::Parts(vec![ChatContentPart::Text {
        text: text.to_string(),
        cache_control: Some(cc),
    }])
}
