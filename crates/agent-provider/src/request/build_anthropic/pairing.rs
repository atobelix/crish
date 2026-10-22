//! Anthropic 工具调用配对守卫与出站 Fail-Closed 校验（自 build_anthropic.rs 平移）。

use super::messages::to_anthropic_messages;
use crate::error::RequestBuildError;
use crate::request::messages::WIRE_CONTINUATION_NOTE;
use crate::request::RequestBuildContext;
use serde_json::Value;
use std::collections::BTreeSet;

/// 检测 Anthropic wire 消息序列中的孤儿 tool_use（纯只读，不改写不伪造）。
///
/// 遍历 messages：assistant content 中 `type:"tool_use"` 的 `id` 记入 pending；
/// user content 中 `type:"tool_result"` 的 `tool_use_id` 消去对应 pending。
/// 遍历结束后 pending 非空 → 孤儿（上游 Anthropic API 将 400：
/// `each tool_use block must have a corresponding tool_result block`）。
/// 返回排序后的孤儿 ID 列表（顺序稳定，供会话循环补齐重试逐 ID 对账）。
pub fn detect_anthropic_unpaired_tool_calls(messages: &[Value]) -> Vec<String> {
    let mut pending: BTreeSet<String> = BTreeSet::new();
    for msg in messages {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or_default();
        let Some(content) = msg.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in content {
            let block_type = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if role == "assistant" && block_type == "tool_use" {
                if let Some(id) = block.get("id").and_then(Value::as_str) {
                    if !id.trim().is_empty() {
                        pending.insert(id.to_string());
                    }
                }
            } else if role == "user" && block_type == "tool_result" {
                if let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) {
                    pending.remove(tool_use_id);
                }
            }
        }
    }
    pending.into_iter().collect()
}

/// Anthropic 出站成对性校验入口（详案 02 §3.4 分级守门）。
///
/// 导线层刚性拦截孤儿工具调用：返回 [RequestBuildError::UnpairedToolCalls]（含排序
/// `orphan_ids`）并记录 `tracing::error!` 结构化日志——调用方（会话循环出站
/// 组装处）据此执行「本地合成补齐 → 单次重试组包」；仍失败则标记会话
/// `wire_pairing_poisoned`。**禁止**在导线层静默插入假 tool_result，也**禁止**
/// 使用 panic!() 中断进程。
pub fn validate_anthropic_tool_pairing(messages: &[Value]) -> Result<(), RequestBuildError> {
    let orphan_ids = detect_anthropic_unpaired_tool_calls(messages);
    if orphan_ids.is_empty() {
        return Ok(());
    }
    let err = RequestBuildError::UnpairedToolCalls {
        protocol: "anthropic",
        orphan_ids,
    };
    tracing::error!(
        target: "agent_provider::wire_pairing",
        protocol = "anthropic",
        error = %err,
        orphan_ids = ?err.orphan_ids(),
        "导线层刚性拦截带毒请求出站（禁止静默伪造 tool_result；调用方须走补齐重试闭环）"
    );
    Err(err)
}

/// 出站前从 [RequestBuildContext] 直接成对性预检（不经过 build 入口）。
/// 孤儿 → 返回 `Err(UnpairedToolCalls)`。
/// 供 engine_provider 在调用 `build_anthropic_request_body` 前软失败拦截。
pub fn validate_anthropic_pairing_from_context(
    context: &RequestBuildContext,
) -> Result<(), RequestBuildError> {
    let messages = to_anthropic_messages(context);
    validate_anthropic_tool_pairing(&messages)
}

/// build 入口接线的 fail-closed 守门（安全过滤孤儿 tool_use，绝不产出带毒请求体）。
///
/// `build_anthropic_request_body` 返回签名保持 `Value`（既有 ~100 调用面零
/// 破坏）：拦截到孤儿 tool_use 时 `tracing::error!` 记录并安全过滤掉未配对的 tool_use 块，
/// 避免 client 进程因 panic 崩溃，同时防止带毒请求出站引发 400 报错。
pub(crate) fn fail_closed_anthropic_pairing_gate(messages: &mut [Value]) {
    if let Err(err) = validate_anthropic_tool_pairing(messages) {
        tracing::error!(
            target: "agent_provider::wire_pairing",
            protocol = "anthropic",
            error = %err,
            orphan_ids = ?err.orphan_ids(),
            "build_anthropic 入口守门拦截：过滤带毒孤儿工具调用，安全 Fail-Closed"
        );
        let orphan_set: BTreeSet<&str> = err.orphan_ids().iter().map(|s| s.as_str()).collect();
        for msg in messages.iter_mut() {
            if msg.get("role").and_then(Value::as_str) == Some("assistant") {
                if let Some(content) = msg.get_mut("content").and_then(Value::as_array_mut) {
                    content.retain(|block| {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                            !orphan_set.contains(id)
                        } else {
                            true
                        }
                    });
                    let has_text_or_tool = content.iter().any(|block| {
                        match block.get("type").and_then(Value::as_str) {
                            Some("tool_use") => true,
                            Some("text") => block
                                .get("text")
                                .and_then(Value::as_str)
                                .is_some_and(|t| !t.trim().is_empty()),
                            _ => false,
                        }
                    });
                    if !has_text_or_tool {
                        content.retain(|block| {
                            !(block.get("type").and_then(Value::as_str) == Some("text")
                                && block
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .is_some_and(|t| t.trim().is_empty()))
                        });
                        content.push(serde_json::json!({
                            "type": "text",
                            "text": WIRE_CONTINUATION_NOTE
                        }));
                    }
                }
            }
        }
    }
}
