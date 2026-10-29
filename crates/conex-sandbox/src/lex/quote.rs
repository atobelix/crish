//! 引号、转义与包裹内容提取。
//!
//! 单引号内视为字面量。双引号内仍识别命令替换与反引号。
//! 反斜杠只在后接空白或元字符时按转义处理，避免 Windows 路径被拆坏。

use std::iter::Peekable;

/// 提取包裹内容：命令替换 `$()`、成对反引号、scriptblock `{…}`。
///
/// 嵌套深度不在此限制，递归深度由分析入口兜底。
pub(crate) fn extract_wrapped_content(segment_raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = segment_raw.chars().peekable();
    let mut in_single = false;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                in_single = false;
            }
            continue;
        }
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => {
                escaped = true;
            }
            '\'' => {
                in_single = true;
            }
            '$' => {
                if chars.peek() == Some(&'(') {
                    chars.next();
                    if let Some(inner) = take_balanced(&mut chars, '(', ')') {
                        out.push(inner);
                    }
                }
            }
            '`' => {
                if let Some(inner) = take_until_backtick(&mut chars) {
                    out.push(inner);
                }
            }
            '{' => {
                if let Some(inner) = take_balanced(&mut chars, '{', '}') {
                    out.push(inner);
                }
            }
            _ => {}
        }
    }
    out
}

/// 取配对括号内容（不含首括号）。括号不配平时返回空。
fn take_balanced<I>(chars: &mut Peekable<I>, open: char, close: char) -> Option<String>
where
    I: Iterator<Item = char>,
{
    let mut depth = 1usize;
    let mut inner = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                inner.push(next);
            }
            continue;
        }
        if c == open {
            depth += 1;
            inner.push(c);
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(inner);
            }
            inner.push(c);
        } else {
            inner.push(c);
        }
    }
    None
}

/// 取成对反引号内容（不含反引号）。未闭合时返回空。
fn take_until_backtick<I>(chars: &mut Peekable<I>) -> Option<String>
where
    I: Iterator<Item = char>,
{
    let mut inner = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                inner.push(next);
            }
            continue;
        }
        if c == '`' {
            return Some(inner);
        }
        inner.push(c);
    }
    None
}

/// 反斜杠后这些字符才按转义处理。其余保留反斜杠，使盘符路径不被损坏。
pub(crate) fn is_escape_requiring(c: char) -> bool {
    c.is_whitespace()
        || c == '\''
        || c == '"'
        || c == '\\'
        || c == '$'
        || c == '`'
        || c == ';'
        || c == '&'
        || c == '|'
        || c == '('
        || c == ')'
        || c == '<'
        || c == '>'
}
