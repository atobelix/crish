use super::ChecklistItem;

/// 解析助手 markdown checklist（L1 主门禁；对齐前端 parseChecklistTasks，
/// goalModeController.ts:103-122）：
///
/// - 行格式 `^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$`；
/// - 丢弃「本轮总结 / 小结 / 回顾」类伪任务（对齐前端 PSEUDO_TASK_RE，
///   goalModeController.ts:22 / :114）。
pub fn parse_checklist(text: &str) -> Vec<ChecklistItem> {
    let mut items = Vec::new();
    for line in text.lines() {
        if let Some((done, body)) = parse_checklist_line(line) {
            items.push(ChecklistItem {
                text: body.to_string(),
                done,
            });
        }
    }
    items
}

/// 单行 checklist 解析（纯函数；行格式与前端正则同构）
fn parse_checklist_line(line: &str) -> Option<(bool, &str)> {
    let trimmed = line.trim_start();
    let after_marker = trimmed
        .strip_prefix('-')
        .or_else(|| trimmed.strip_prefix('*'))?;
    let after_marker = after_marker.trim_start();
    let after_bracket = after_marker.strip_prefix('[')?;
    let (mark, rest) = after_bracket.split_at(1);
    let done = match mark {
        " " => false,
        "x" | "X" => true,
        _ => return None,
    };
    let rest = rest.strip_prefix(']')?;
    // `\s+` 要求至少一个空白（与前端正则一致）
    let first_char = rest.chars().next()?;
    if !first_char.is_whitespace() {
        return None;
    }
    let body = rest.trim_start();
    if body.is_empty() {
        return None;
    }
    // 伪任务丢弃（前端 PSEUDO_TASK_RE /^本轮(总结|小结|回顾)/）
    if is_pseudo_task(body) {
        return None;
    }
    Some((done, body.trim_end()))
}

/// 伪任务判据（前端 PSEUDO_TASK_RE 同构扩充：`本轮总结` / `本轮小结` /
/// `本轮回顾` 或英文 `round summary` / `summary of this round` / `round recap` / `iteration summary` 开头）
fn is_pseudo_task(body: &str) -> bool {
    let trimmed = body.trim_start();
    if trimmed.starts_with("本轮总结")
        || trimmed.starts_with("本轮小结")
        || trimmed.starts_with("本轮回顾")
    {
        return true;
    }
    let lower = trimmed.to_lowercase();
    lower.starts_with("round summary")
        || lower.starts_with("summary of this round")
        || lower.starts_with("round recap")
        || lower.starts_with("iteration summary")
}

/// 文案 DONE 信号（L0 候选；对齐前端 replyLooksGoalDone，
/// goalModeController.ts:52-56）：`\bDONE\b`（大小写不敏感，ASCII 单词
/// 边界）或「目标已完成」/「全部任务完成」/「目标达成」/
/// "goal completed" / "all tasks completed" / "goal achieved"
pub fn reply_looks_goal_done(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains("目标已完成")
        || trimmed.contains("全部任务完成")
        || trimmed.contains("目标达成")
    {
        return true;
    }
    let lower = trimmed.to_lowercase();
    if lower.contains("goal completed")
        || lower.contains("all tasks completed")
        || lower.contains("goal achieved")
    {
        return true;
    }
    let bytes = lower.as_bytes();
    for (index, window) in bytes.windows(4).enumerate() {
        if window == b"done" {
            let prev_ok = index == 0 || !bytes[index - 1].is_ascii_alphanumeric();
            let next_ok = index + 4 >= bytes.len() || !bytes[index + 4].is_ascii_alphanumeric();
            if prev_ok && next_ok {
                return true;
            }
        }
    }
    false
}
