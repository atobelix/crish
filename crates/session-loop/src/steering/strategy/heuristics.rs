//! 策略检测算法与启发式探针（对齐 TS runtime-helpers.ts）

use std::collections::HashMap;
use std::sync::Arc;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::ToolOutput;

use crate::steering::SteeringReason;

/// 检测最近连续工具错误环（对齐 TS detectRecentToolErrorLoop）
///
/// 自消息尾部向前扫描：跳过 system/assistant 消息，遇 user 消息停止；
/// 只统计 tool 消息的 `tool-result` 块。语义要点：
/// - 最近一条非失败的 tool-result 即判定无环（返回空）；
/// - `softDeny: true` 的失败结果不计（非真实失败）；
/// - 连续失败数达到 `min_errors` 即返回 `tool-errors`。
///
/// 载荷为 Arc 共享形态（PE-09 T09.3.2，读字段自动 deref）。
pub fn detect_recent_tool_error_loop(
    messages: &[Arc<AgentMessage>],
    min_errors: usize,
) -> Option<SteeringReason> {
    let mut errors = 0usize;
    for message in messages.iter().rev() {
        match message.role {
            AgentMessageRole::System | AgentMessageRole::Assistant => continue,
            AgentMessageRole::User => break,
            AgentMessageRole::Tool => {}
        }
        for block in &message.blocks {
            let AgentMessageBlock::ToolResult {
                output, is_error, ..
            } = block
            else {
                continue;
            };
            if !is_tool_result_failure(output, *is_error) {
                return None;
            }
            errors += 1;
            if errors >= min_errors {
                return Some(SteeringReason::ToolErrors);
            }
        }
    }
    None
}

/// 检测最近重复工具调用环（对齐 TS detectRepeatedToolCallLoop）
///
/// 自消息尾部向前扫描：遇 user 消息停止；统计 assistant 消息的
/// `tool-call` 块，签名 = `工具名:入参JSON`。同一签名出现次数达到
/// `min_repeats` 即返回 `tool-loop`。载荷为 Arc 共享形态（PE-09 T09.3.2）。
pub fn detect_repeated_tool_call_loop(
    messages: &[Arc<AgentMessage>],
    min_repeats: usize,
) -> Option<SteeringReason> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for message in messages.iter().rev() {
        if message.role == AgentMessageRole::User {
            break;
        }
        if message.role != AgentMessageRole::Assistant {
            continue;
        }
        for call in message.tool_calls() {
            let signature = format!(
                "{}:{}",
                call.tool_name,
                serde_json::to_string(&call.input).unwrap_or_default()
            );
            let next = counts.get(&signature).copied().unwrap_or(0) + 1;
            if next >= min_repeats {
                return Some(SteeringReason::ToolLoop);
            }
            counts.insert(signature, next);
        }
    }
    None
}

/// tool-result 是否真实失败（对齐 TS isToolResultFailure）
///
/// - `output.json.softDeny === true` → 非失败（审批软拒绝）；
/// - 块级 `is_error` → 失败；
/// - 输出中带非零退出码（json `exitCode`/`exit_code` 或文本
///   `Exit code: N`）→ 失败；退出码 0 → 非失败。
pub(crate) fn is_tool_result_failure(output: &ToolOutput, is_error: bool) -> bool {
    if let Some(json) = &output.json {
        if json
            .as_object()
            .and_then(|o| o.get("softDeny"))
            .and_then(|v| v.as_bool())
            == Some(true)
        {
            return false;
        }
    }
    if is_error {
        return true;
    }
    if let Some(json) = &output.json {
        for key in ["exitCode", "exit_code"] {
            if let Some(code) = json.get(key).and_then(|v| v.as_i64()) {
                return code != 0;
            }
        }
    }
    if let Some(text) = &output.text {
        if let Some(code) = exit_code_from_text(text) {
            return code != 0;
        }
    }
    false
}

/// 从文本中解析 `Exit code: N`（大小写不敏感，N 可为负）
pub(crate) fn exit_code_from_text(text: &str) -> Option<i64> {
    let needle = "exit code:";
    let lower = text.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(needle) {
        let start = from + rel + needle.len();
        let mut rest = lower[start..].trim_start().chars().peekable();
        let negative = rest.peek() == Some(&'-');
        if negative {
            rest.next();
        }
        let digits: String = rest.take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            // F3-01（P2 批 6）：非法数字段不得提前终止扫描——`?` 会把
            // "exit code: unknown\nexit code: 1" 误判为非失败；continue
            // 继续找后续合法段
            let Ok(magnitude) = digits.parse::<i64>() else {
                from = start;
                continue;
            };
            return Some(if negative { -magnitude } else { magnitude });
        }
        from = start;
    }
    None
}

/// Tool-Promise 意图自愈侦测器（RUL-02：多层反向过滤 + 否定词过滤 + 中英双语行动意图匹配）
#[derive(Debug, Clone, Copy, Default)]
pub struct ToolPromiseDetector;

impl ToolPromiseDetector {
    /// 截取 Unicode 字符安全的尾部切片（杜绝 UTF-8 字节切断 Panic）
    pub fn safe_tail_slice(text: &str, max_chars: usize) -> &str {
        let char_count = text.chars().count();
        if char_count <= max_chars {
            return text;
        }
        let skip_chars = char_count - max_chars;
        text.char_indices()
            .nth(skip_chars)
            .map(|(idx, _)| &text[idx..])
            .unwrap_or(text)
    }

    /// 核心判定函数：返回 Some(action_snippet) 表示检测到行动承诺且通过过滤
    pub fn detect_action_promise(text: &str) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }

        // ── 第一层过滤：排除教程、代码示例与解释性排版 ──
        if trimmed.contains("```markdown")
            || trimmed.contains("```json")
            || trimmed.contains("```")
            || trimmed.contains("例如：")
            || trimmed.contains("例如:")
            || trimmed.contains("示例如下：")
            || trimmed.contains("示例如下:")
            || trimmed.contains("配置如下：")
            || trimmed.contains("配置如下:")
            || trimmed.contains("可以通过如下配置")
        {
            return None;
        }

        // ── 第二层过滤：排除向用户反问与等待确认 ──
        if trimmed.contains("是否需要")
            || trimmed.contains("您希望")
            || trimmed.contains("请确认")
            || trimmed.contains("如果你同意")
            || trimmed.contains("如果您同意")
            || trimmed.contains("如需继续请")
            || trimmed.ends_with('？')
            || trimmed.ends_with('?')
        {
            return None;
        }

        // ── 第三层过滤：排除第三人称与过去历史描述/复盘 ──
        if trimmed.contains("上一轮中")
            || trimmed.contains("在上一轮中")
            || trimmed.contains("之前已经")
            || trimmed.contains("刚才尝试了")
            || trimmed.contains("失败原因是")
            || trimmed.contains("执行失败了是因为")
            || trimmed.contains("系统报告了如下错误")
        {
            return None;
        }

        // ── 第四层过滤：排除否定词与明确不执行/禁止表达（DEC-01 裁决）──
        let negative_phrases = [
            "我不会",
            "禁止",
            "暂不执行",
            "没有调用",
            "并未调用",
            "不会调用",
            "不会执行",
            "不执行",
            "i will not",
            "will not run",
            "do not execute",
            "cannot execute",
        ];
        if negative_phrases.iter().any(|neg| trimmed.contains(neg)) {
            return None;
        }

        // ── 正向行动意图匹配（重点关注文本尾部 300 Unicode 字符） ──
        let tail = Self::safe_tail_slice(trimmed, 300);

        let action_patterns = [
            // 中文模式
            "尝试单独调用",
            "正在调用",
            "现在开始执行",
            "接下来使用",
            "准备运行",
            "尝试通过",
            "我将执行",
            "使用 PowerShell",
            "使用 shell_command",
            "重新运行",
            "尝试调用",
            "接下来执行",
            "我来调用",
            "开始执行",
            "我先执行",
            "让我来运行",
            "立即运行",
            // 英文模式（小写比对）
            "i will now run",
            "i will execute",
            "i will call",
            "let me run",
            "let me execute",
            "let me call",
            "now executing",
            "starting to run",
            "proceeding with",
            "running the command",
            "calling tool",
            "executing tool",
            "i'm going to run",
            "i am going to execute",
        ];

        let lower_tail = tail.to_lowercase();
        for pattern in &action_patterns {
            if let Some(pos) = lower_tail.rfind(pattern) {
                // 保证切片在合法字符边界
                let char_boundary_pos = tail
                    .char_indices()
                    .map(|(idx, _)| idx)
                    .rfind(|&idx| idx <= pos)
                    .unwrap_or(pos);
                let snippet = &tail[char_boundary_pos..];
                let end_pos = snippet
                    .find(['。', '！', '\n', '.', '!'])
                    .unwrap_or(snippet.len());
                let result = snippet[..end_pos].trim();
                if !result.is_empty() {
                    return Some(result.to_string());
                }
            }
        }

        None
    }
}
