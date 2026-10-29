//! Conex-MD 序列化：`BlockTree` → 契约字符串。
//!
//! # 结构-only S（自研 raising）
//! - 每个块：独占行 `<!--c:UUID-->` + 内容行；子块紧随父内容之后（DFS）。
//! - 文本取自 `text_snapshot`（plain）；**不含** yrs 富文本往返。
//! - **P** 已接线 markdown-rs（见 [`crate::parse`]）；**S 不走库 to_md**（plans/03 §3.2）。
//!
//! # 缩进规则（保证 P∘S 结构闭合）
//! - 标题：章节子块不缩进（parse 侧按标题级别重组章节）
//! - 列表项：子块按 marker 内容缩进（bullet 2 空格；ordered 位数 + 2）
//! - 引用 / callout：子块加 `> ` 前缀；空行保留 `>`
//! - 脚注定义：子块缩进 4 空格
//!
//! # Agent 读路径
//! [`document_to_md`] / [`serialize_tree`] 即契约 **S(树)**：`get_md` / Agent 读必须走
//! **即时序列化**，禁止默认读陈旧 exports / mirror（见 `plans/03-MD契约.md` §S1 / §2）。

use crate::{
    BlockId, BlockKind, BlockNode, BlockProps, BlockTree, CODE_LANG_ATTR, CODE_META_ATTR,
    FOOTNOTE_LABEL_ATTR, ORDERED_LIST_ITEM_NUMBER_ATTR, TASK_CHECKED_ATTR,
};

/// 将整棵块树序列化为 Conex-MD 文本（含块 ID 注释）。
///
/// 与 [`document_to_md`] 语义相同；保留此名以对齐 P/S 记号 `S(t)`。
pub fn serialize_tree(tree: &BlockTree) -> String {
    document_to_md(tree)
}

/// Agent / 工具 **`get_md` / `document_get_md` 读路径**：对当前权威块树做 **即时 S**。
///
/// - 输出 = Conex-MD 契约字符串（`<!--c:UUID-->` 独占行 + 内容 DFS）
/// - **不是** 读磁盘 mirror / `exports/**` 陈旧快照
/// - 实现上与 [`serialize_tree`] 为同一路径（别名封装，便于工具面命名对齐）
///
/// 对应不变量：A-MD 读侧；`plans/03-MD契约.md`「Agent `get_md` = 即时 S(树)」。
pub fn document_to_md(tree: &BlockTree) -> String {
    let mut roots = tree.root_children.clone();
    tree.sort_sibling_ids(&mut roots);

    let mut lines: Vec<String> = Vec::new();
    for (i, id) in roots.iter().enumerate() {
        if i > 0 {
            lines.push(String::new());
        }
        serialize_node(tree, id, "", &mut lines);
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn serialize_node(tree: &BlockTree, id: &BlockId, prefix: &str, lines: &mut Vec<String>) {
    let Some(node) = tree.get(id) else {
        return;
    };

    lines.push(format!("{prefix}{}", node.id.to_html_comment()));
    write_block_content(node, prefix, lines);

    let mut children = node.children.clone();
    tree.sort_sibling_ids(&mut children);
    if children.is_empty() {
        return;
    }
    let child_prefix = child_prefix(node, prefix);
    for child in &children {
        // 空行须携带容器延续标记（引用 `>`），否则引用会被空行截断。
        lines.push(child_prefix.trim_end().to_string());
        serialize_node(tree, child, &child_prefix, lines);
    }
}

/// 子块相对父块的缩进 / 引用前缀。
fn child_prefix(node: &BlockNode, prefix: &str) -> String {
    match &node.kind {
        BlockKind::Heading { .. } => prefix.to_string(),
        BlockKind::BulletItem => format!("{prefix}  "),
        BlockKind::OrderedItem => {
            format!("{prefix}{}", " ".repeat(ordered_number(node).to_string().len() + 2))
        }
        BlockKind::TaskItem { ordered } => {
            let width = if *ordered {
                ordered_number(node).to_string().len() + 2
            } else {
                2
            };
            format!("{prefix}{}", " ".repeat(width))
        }
        BlockKind::Quote | BlockKind::Callout { .. } => format!("{prefix}> "),
        BlockKind::FootnoteDefinition => format!("{prefix}    "),
        _ => format!("{prefix}    "),
    }
}

fn write_block_content(node: &BlockNode, prefix: &str, lines: &mut Vec<String>) {
    let text = node.text_snapshot.as_deref().unwrap_or("");

    match &node.kind {
        BlockKind::Heading { level } => {
            let n = (*level).clamp(1, 6) as usize;
            let hashes: String = std::iter::repeat_n('#', n).collect();
            if text.is_empty() {
                lines.push(format!("{prefix}{hashes}"));
            } else {
                let mut iter = text.lines();
                let first = iter.next().unwrap_or("");
                lines.push(format!("{prefix}{hashes} {first}"));
                for line in iter {
                    lines.push(format!("{prefix}{line}"));
                }
            }
        }
        BlockKind::Paragraph => {
            push_text_lines(lines, prefix, &protect_block_start(text));
        }
        BlockKind::BulletItem => {
            push_list_item_lines(lines, prefix, "-", text, None);
        }
        BlockKind::OrderedItem => {
            let marker = format!("{}.", ordered_number(node));
            push_list_item_lines(lines, prefix, &marker, text, None);
        }
        BlockKind::TaskItem { ordered } => {
            let marker = if *ordered {
                format!("{}.", ordered_number(node))
            } else {
                "-".to_string()
            };
            push_list_item_lines(lines, prefix, &marker, text, Some(task_checked(node)));
        }
        BlockKind::Code => {
            let fence = code_fence(text);
            let info = code_info(node);
            lines.push(format!("{prefix}{fence}{info}"));
            for line in text.lines() {
                lines.push(format!("{prefix}{line}"));
            }
            lines.push(format!("{prefix}{fence}"));
        }
        BlockKind::Quote => {
            if text.is_empty() {
                if node.children.is_empty() {
                    lines.push(format!("{prefix}>"));
                }
            } else {
                push_quote_text(lines, prefix, &protect_block_start(text));
            }
        }
        BlockKind::Callout { kind } => {
            push_callout_text(lines, prefix, kind, text);
        }
        BlockKind::Divider => lines.push(format!("{prefix}---")),
        BlockKind::Table => {
            if text.is_empty() {
                lines.push(format!("{prefix}|  |"));
                lines.push(format!("{prefix}| --- |"));
            } else {
                for line in text.lines() {
                    lines.push(format!("{prefix}{line}"));
                }
            }
        }
        BlockKind::Math => {
            lines.push(format!("{prefix}$$"));
            for line in text.lines() {
                lines.push(format!("{prefix}{line}"));
            }
            lines.push(format!("{prefix}$$"));
        }
        BlockKind::FootnoteDefinition => {
            let label = attr_str(&node.props, FOOTNOTE_LABEL_ATTR).unwrap_or("note");
            let mut iter = text.lines();
            let first = iter.next().unwrap_or("");
            if first.is_empty() {
                lines.push(format!("{prefix}[^{label}]:"));
            } else {
                lines.push(format!("{prefix}[^{label}]: {first}"));
            }
            for line in iter {
                lines.push(format!("{prefix}    {line}"));
            }
        }
        BlockKind::Unknown { .. } => {
            push_text_lines(lines, prefix, text);
        }
    }
}

fn push_text_lines(lines: &mut Vec<String>, prefix: &str, text: &str) {
    if text.is_empty() {
        lines.push(prefix.trim_end().to_string());
        return;
    }
    for line in text.split('\n') {
        lines.push(format!("{prefix}{line}"));
    }
}

fn push_list_item_lines(
    lines: &mut Vec<String>,
    prefix: &str,
    marker: &str,
    text: &str,
    task: Option<bool>,
) {
    let continuation = format!("{prefix}{}", " ".repeat(marker.len() + 1));
    let head = match task {
        Some(true) => format!("{marker} [x]"),
        Some(false) => format!("{marker} [ ]"),
        None => marker.to_string(),
    };
    let first = text.lines().next().unwrap_or("");
    let first = if task.is_none() {
        protect_literal_task_marker(first)
    } else {
        first.to_string()
    };
    if first.is_empty() {
        lines.push(format!("{prefix}{head}"));
    } else {
        lines.push(format!("{prefix}{head} {first}"));
    }
    for line in text.lines().skip(1) {
        lines.push(format!("{continuation}{line}"));
    }
}

/// 非任务列表项若文本以 `[ ]` / `[x]` 开头，转义首字符避免被解析成任务项。
fn protect_literal_task_marker(text: &str) -> String {
    let rest = text
        .strip_prefix("[ ]")
        .or_else(|| text.strip_prefix("[x]"))
        .or_else(|| text.strip_prefix("[X]"));
    match rest {
        Some(rest) if rest.is_empty() || rest.starts_with(char::is_whitespace) => {
            format!("\\{text}")
        }
        _ => text.to_string(),
    }
}

fn push_quote_text(lines: &mut Vec<String>, prefix: &str, text: &str) {
    if text.is_empty() {
        lines.push(format!("{prefix}>"));
        return;
    }
    for line in text.split('\n') {
        if line.is_empty() {
            lines.push(format!("{prefix}>"));
        } else {
            lines.push(format!("{prefix}> {line}"));
        }
    }
}

fn push_callout_text(lines: &mut Vec<String>, prefix: &str, kind: &str, text: &str) {
    let marker = format!("[!{}]", kind.to_ascii_uppercase());
    let mut iter = text.split('\n');
    let first = iter.next().unwrap_or("");
    if first.is_empty() {
        lines.push(format!("{prefix}> {marker}"));
    } else {
        lines.push(format!("{prefix}> {marker} {first}"));
    }
    for line in iter {
        if line.is_empty() {
            lines.push(format!("{prefix}>"));
        } else {
            lines.push(format!("{prefix}> {line}"));
        }
    }
}

fn code_info(node: &BlockNode) -> String {
    let lang = attr_str(&node.props, CODE_LANG_ATTR);
    let meta = attr_str(&node.props, CODE_META_ATTR);
    match (lang, meta) {
        (Some(lang), Some(meta)) => format!("{lang} {meta}"),
        (Some(lang), None) => lang.to_string(),
        (None, Some(meta)) => format!(" {meta}"),
        (None, None) => String::new(),
    }
}

/// 围栏长度：比正文中最长反引号串多一，最少 3。
fn code_fence(text: &str) -> String {
    let mut max_run = 0usize;
    for line in text.lines() {
        let run = line.chars().take_while(|c| *c == '`').count();
        max_run = max_run.max(run);
    }
    "`".repeat((max_run + 1).max(3))
}

fn ordered_number(node: &BlockNode) -> u64 {
    node.props
        .attrs
        .get(ORDERED_LIST_ITEM_NUMBER_ATTR)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1)
}

fn task_checked(node: &BlockNode) -> bool {
    node.props
        .attrs
        .get(TASK_CHECKED_ATTR)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn attr_str<'a>(props: &'a BlockProps, key: &str) -> Option<&'a str> {
    props.attrs.get(key).and_then(serde_json::Value::as_str)
}

/// 保护段落 / 引用首行：避免 plain 文本被重新解析成块级结构。
///
/// - 行首危险标点（`#` / `>` / 列表 / 围栏 / HTML / 脚注 / callout）加反斜杠转义；
/// - 行首空白编码为字符实体，保证 `text_snapshot` 逐字往返。
fn protect_block_start(text: &str) -> String {
    let (first, rest) = match text.split_once('\n') {
        Some((first, rest)) => (first, Some(rest)),
        None => (text, None),
    };

    let lead_len = first.len() - first.trim_start_matches([' ', '\t']).len();
    let (lead, body) = first.split_at(lead_len);
    let mut out = String::new();
    if !lead.is_empty() {
        for ch in lead.chars() {
            match ch {
                ' ' => out.push_str("&#32;"),
                '\t' => out.push_str("&#9;"),
                other => out.push(other),
            }
        }
    }
    out.push_str(&escape_block_start(body));

    if let Some(rest) = rest {
        out.push('\n');
        out.push_str(rest);
    }
    out
}

fn escape_block_start(body: &str) -> String {
    if body.is_empty() {
        return String::new();
    }
    let first = body.chars().next().expect("non-empty");

    // 强调 / 代码分隔符：实体化整个起始 run，避免残留分隔符配对。
    if matches!(first, '*' | '_' | '`') {
        let run = body.chars().take_while(|c| *c == first).count();
        let entity = match first {
            '*' => "&#42;",
            '_' => "&#95;",
            _ => "&#96;",
        };
        let mut out = entity.repeat(run);
        out.push_str(&body[run..]);
        return out;
    }

    let dangerous_punct = matches!(first, '#' | '>' | '-' | '+');
    if dangerous_punct {
        return format!("\\{body}");
    }
    // 仅围栏形态的 `~~~` 会改块结构；行内删除线已在 plain 边界外。
    if body.starts_with("~~~") {
        return format!("\\{body}");
    }
    // HTML flow 只在行首 `<` 时成立。
    if first == '<' {
        return format!("\\{body}");
    }
    // 脚注定义 / GFM alert 标记只在行首有意义。
    if body.starts_with("[^") && body.contains("]:") {
        return format!("\\{body}");
    }
    if body.starts_with("[!") {
        return format!("\\{body}");
    }
    if body.starts_with("![") {
        return format!("\\{body}");
    }
    // 有序列表：数字串 + `.` / `)` + 空白或行尾。
    let digits = body.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits < body.len() {
        let punct = body[digits..].chars().next().unwrap_or(' ');
        if punct == '.' || punct == ')' {
            let after = body[digits + punct.len_utf8()..].chars().next();
            if after.is_none_or(|c| c.is_whitespace()) {
                let mut escaped = String::with_capacity(body.len() + 1);
                escaped.push_str(&body[..digits]);
                escaped.push('\\');
                escaped.push_str(&body[digits..]);
                return escaped;
            }
        }
    }
    body.to_string()
}
