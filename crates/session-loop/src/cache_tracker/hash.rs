//! 请求签名投影与 FNV-1a 零分配哈希实现（P5 §3.4.1 / SL-PERF-14）

use std::sync::Arc;

use conex_telemetry::cache::RequestSignature;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};

use super::types::{FNV_OFFSET_BASIS, FNV_PRIME};
use crate::provider::ToolSchema;

/// FNV-1a 栈上零分配流式哈希写入器（SL-PERF-14：实现 `std::fmt::Write` 与
/// `std::io::Write`，彻底消除 `Vec<u8>` 扩容与 `serde_json::to_string` 堆分配）
#[derive(Debug, Clone, Copy)]
pub(super) struct Fnv1aWriter(u64);

impl Default for Fnv1aWriter {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

impl Fnv1aWriter {
    #[inline]
    pub(super) const fn new() -> Self {
        Self(FNV_OFFSET_BASIS)
    }

    #[inline]
    pub(super) fn update(&mut self, bytes: &[u8]) {
        let mut hash = self.0;
        for &byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        self.0 = hash;
    }

    #[inline]
    pub(super) fn update_byte(&mut self, byte: u8) {
        self.0 ^= u64::from(byte);
        self.0 = self.0.wrapping_mul(FNV_PRIME);
    }

    #[inline]
    pub(super) const fn finish(self) -> u64 {
        self.0
    }
}

impl std::fmt::Write for Fnv1aWriter {
    #[inline]
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.update(s.as_bytes());
        Ok(())
    }
}

impl std::io::Write for Fnv1aWriter {
    #[inline]
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.update(buf);
        Ok(buf.len())
    }

    #[inline]
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// FNV-1a 64 位哈希（简单稳定：跨进程 / 跨编译器版本确定，供基线持久化后
/// 跨 run 比对；对齐 jcode 用 DefaultHasher 的等价目的，P5 §3.4.1「与 jcode
/// 同」——FNV 实现无标准库算法版本漂移风险）
pub(super) fn fnv1a(bytes: &[u8]) -> u64 {
    let mut writer = Fnv1aWriter::new();
    writer.update(bytes);
    writer.finish()
}

/// 折叠两条哈希（FNV 增量风格：两段 8 字节小端拼接再哈希——顺序敏感）
pub(super) fn fnv1a_mix(a: u64, b: u64) -> u64 {
    let mut writer = Fnv1aWriter::new();
    writer.update(&a.to_le_bytes());
    writer.update(&b.to_le_bytes());
    writer.finish()
}

/// 角色标签（投影输入；显式常量避免依赖 serde 的 rename 细节）
fn role_tag(role: AgentMessageRole) -> &'static str {
    match role {
        AgentMessageRole::System => "system",
        AgentMessageRole::User => "user",
        AgentMessageRole::Assistant => "assistant",
        AgentMessageRole::Tool => "tool",
    }
}

/// 消息哈希投影（保留项 = role + blocks 类型与内容 + 工具调用参数；
/// 剔除项 = created_at / metadata / client_message_id / content 兜底，
/// P5 §3.4.1 投影清单；SL-PERF-14 零堆分配流式哈希）
pub(super) fn message_hash(message: &AgentMessage) -> u64 {
    let mut hasher = Fnv1aWriter::new();
    hasher.update(role_tag(message.role).as_bytes());
    for block in &message.blocks {
        block_hash(block, &mut hasher);
    }
    hasher.finish()
}

/// 块哈希投影（带类型标签前缀——「text」与「thought」同文不混淆；
/// SL-PERF-14：直接写入栈上 `Fnv1aWriter`，0 字节堆分配）
fn block_hash(block: &AgentMessageBlock, out: &mut Fnv1aWriter) {
    match block {
        AgentMessageBlock::Text { text } => {
            out.update(b"text\0");
            out.update(text.as_bytes());
        }
        AgentMessageBlock::Thought { text, redacted } => {
            out.update(b"thought\0");
            out.update(text.as_bytes());
            out.update_byte(redacted.unwrap_or(false) as u8);
        }
        AgentMessageBlock::ToolCall(call) => {
            out.update(b"tool-call\0");
            out.update(call.id.as_bytes());
            out.update_byte(0);
            out.update(call.tool_name.as_bytes());
            out.update_byte(0);
            // 入参 JSON（serde_json::Value 为 BTreeMap 键序 → 流式 to_writer 字节序列与 to_string 完全一致）
            // 错误面显式处置（BLK-05）：Fnv1aWriter 常驻内存、且 Value 键恒为字符串，
            // 序列化不应失败；真失败时记日志并写入稳定占位标记，避免静默把该段
            // 从视图里抹掉（占位也保证同输入恒得同签名）
            if let Err(err) = serde_json::to_writer(&mut *out, &call.input) {
                tracing::warn!(
                    tool_call_id = %call.id,
                    error = %err,
                    "缓存签名：工具入参 JSON 序列化失败，写入占位标记（签名不完整）"
                );
                out.update(b"\0<json-error>");
            }
        }
        AgentMessageBlock::ToolResult {
            tool_call_id,
            tool_name,
            output,
            is_error,
        } => {
            out.update(b"tool-result\0");
            out.update(tool_call_id.as_bytes());
            out.update_byte(0);
            out.update(tool_name.as_bytes());
            out.update_byte(0);
            out.update_byte(*is_error as u8);
            // 输出内容投影 text 正文（剔除状态 / 元数据噪声）
            out.update(output.text.as_deref().unwrap_or("").as_bytes());
        }
        AgentMessageBlock::Image(img) => {
            out.update(b"image\0");
            out.update(img.mime_type.as_bytes());
            out.update_byte(0);
            if let Some(alt) = &img.alt {
                out.update(alt.as_bytes());
            }
            out.update_byte(0);
            if let Some(url) = &img.url {
                out.update(url.as_bytes());
            }
        }
    }
}

/// 工具集合哈希投影（{name, description, input_schema} 按序序列化；
/// 与 P4 `tools_prefix_json` 同源投影，字段顺序按 `serde_json::Value` 的 BTreeMap
/// 字典序 `description` → `input_schema` → `name` 借用流式写入 `Fnv1aWriter`，
/// 哈希结果与原 `serde_json::to_string` 字节序列完全一致，且 0 字节堆分配）
pub(super) fn tools_hash(tools: &[ToolSchema]) -> u64 {
    #[derive(serde::Serialize)]
    struct ToolSchemaHashProjection<'a> {
        description: &'a str,
        input_schema: &'a serde_json::Value,
        name: &'a str,
    }

    let mut hasher = Fnv1aWriter::new();
    hasher.update_byte(b'[');
    for (i, t) in tools.iter().enumerate() {
        if i > 0 {
            hasher.update_byte(b',');
        }
        let proj = ToolSchemaHashProjection {
            description: &t.description,
            input_schema: &t.input_schema,
            name: &t.name,
        };
        // 错误面显式处置（BLK-05）：同 block_hash——内存 writer 不应失败，
        // 真失败时记日志并写入占位标记，使工具表签名仍可复现（不静默丢弃该工具）
        if let Err(err) = serde_json::to_writer(&mut hasher, &proj) {
            tracing::warn!(
                tool_name = %proj.name,
                error = %err,
                "缓存签名：工具 schema 序列化失败，写入占位标记（签名不完整）"
            );
            hasher.update(b"\0<json-error>");
        }
    }
    hasher.update_byte(b']');
    hasher.finish()
}

/// 构建请求签名（system / tools / messages 投影 + 逐消息哈希链）。
/// `messages_hash` = 逐条哈希的顺序折叠（append-only 前缀对比输入）。
pub fn build_request_signature(
    system: Option<&str>,
    tools: &[ToolSchema],
    messages: &[Arc<AgentMessage>],
) -> RequestSignature {
    let system_hash = fnv1a(system.unwrap_or("").as_bytes());
    let tools_hash = tools_hash(tools);
    let message_hashes: Vec<u64> = messages.iter().map(|m| message_hash(m)).collect();
    let messages_hash = message_hashes.iter().copied().fold(0, fnv1a_mix);
    RequestSignature {
        system_hash,
        tools_hash,
        messages_hash,
        message_hashes,
        message_count: messages.len(),
        tool_count: tools.len(),
    }
}

/// 构建请求签名（增量版，1C-4）。
///
/// 常见路径：system / tools 不变，对话仅追加新消息 → 复用上一签名的
/// `message_hashes[..prev_count]` 与已折叠的 `messages_hash`，只对新增
/// 消息 `messages[prev_count..]` 做哈希并 fold，签名计算从每轮 O(N) 降为
/// O(新增消息数)。
///
/// 安全条件（任一不满足 → 回退全量重算，保证增量与全量结果恒等）：
/// - 上一签名存在且 `prev_count <= messages.len()`；
/// - `system_hash` / `tools_hash` 与上一签名一致（重新计算两个标量哈希
///   成本 O(1) / O(T)，远低于全量消息哈希 O(N)）。
///
/// 前缀消息被改写（如压缩）的路径由调用方在压缩时清除 `last_signature`
/// 强制全量重算覆盖（`on_compaction` / `capture_post_compaction`）。
pub fn build_request_signature_incremental(
    system: Option<&str>,
    tools: &[ToolSchema],
    messages: &[Arc<AgentMessage>],
    prev: Option<RequestSignature>,
) -> RequestSignature {
    let system_hash = fnv1a(system.unwrap_or("").as_bytes());
    let tools_hash = tools_hash(tools);
    // 增量适用判定：上一签名存在、前缀覆盖、system/tools 未变；
    // `if let` 直接消费过滤结果，避免「先 is_some 再 unwrap」的脆弱双写
    if let Some(prev) = prev.as_ref().filter(|p| {
        p.message_count <= messages.len()
            && p.system_hash == system_hash
            && p.tools_hash == tools_hash
    }) {
        let prev_count = prev.message_count;
        // 复用前缀哈希，只对新增消息计算
        let mut message_hashes = prev.message_hashes.clone();
        let mut messages_hash = prev.messages_hash;
        for m in &messages[prev_count..] {
            let h = message_hash(m);
            messages_hash = fnv1a_mix(messages_hash, h);
            message_hashes.push(h);
        }
        return RequestSignature {
            system_hash,
            tools_hash,
            messages_hash,
            message_hashes,
            message_count: messages.len(),
            tool_count: tools.len(),
        };
    }
    build_request_signature(system, tools, messages)
}
