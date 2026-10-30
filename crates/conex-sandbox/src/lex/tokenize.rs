//! 唯一分词：复合命令拆段、段内拆参、命令名规范化。

use super::quote::is_escape_requiring;

/// 复合命令拆段：`&&`、`;`、`||`、`|`、`|&`、换行。引号内与转义后不拆。
pub(crate) fn split_segments(line: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            current.push(c);
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            current.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                current.push(c);
            }
            '&' => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    push_trimmed(&mut segments, &current);
                    current = String::new();
                } else if current.trim().is_empty()
                    || current.ends_with('>')
                    || current.ends_with('<')
                    || chars.peek() == Some(&'>')
                {
                    // 行首与号是调用运算符。紧贴重定向符的与号属于重定向，不是后台分隔。
                    current.push('&');
                } else {
                    push_trimmed(&mut segments, &current);
                    current = String::new();
                }
            }
            ';' | '|' => {
                if c == '|' && (chars.peek() == Some(&'|') || chars.peek() == Some(&'&')) {
                    chars.next();
                }
                push_trimmed(&mut segments, &current);
                current = String::new();
            }
            '\n' | '\r' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                push_trimmed(&mut segments, &current);
                current = String::new();
            }
            _ => current.push(c),
        }
    }
    push_trimmed(&mut segments, &current);
    segments
}

fn push_trimmed(segments: &mut Vec<String>, current: &str) {
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        segments.push(trimmed.to_string());
    }
}

/// 段内拆参：剥离引号，还原反引号转义，保留 Windows 路径反斜杠。
pub(crate) fn split_command_args_normalized(segment: &str) -> (String, Vec<String>) {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut chars = segment.chars().peekable();

    while let Some(c) = chars.next() {
        if quote == Some('\'') {
            if c == '\'' {
                quote = None;
            } else {
                current.push(c);
            }
            started = true;
            continue;
        }

        if quote == Some('"') {
            if c == '"' {
                quote = None;
            } else if c == '`' {
                if let Some(next_c) = chars.next() {
                    current.push(next_c);
                }
            } else {
                current.push(c);
            }
            started = true;
            continue;
        }

        if c == '`' {
            if let Some(next_c) = chars.next() {
                current.push(next_c);
                started = true;
            }
            continue;
        }

        if c == '\\' {
            let after_drive = current.len() >= 2
                && current.as_bytes()[current.len() - 2].is_ascii_alphabetic()
                && current.as_bytes()[current.len() - 1] == b':';
            if let Some(&next_c) = chars.peek() {
                if is_escape_requiring(next_c) && !after_drive {
                    chars.next();
                    current.push(next_c);
                    started = true;
                    continue;
                }
            }
            current.push(c);
            started = true;
            continue;
        }

        match c {
            '\'' | '"' => {
                quote = Some(c);
                started = true;
            }
            c if c.is_whitespace() => {
                if started && !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                started = false;
            }
            _ => {
                current.push(c);
                started = true;
            }
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    if tokens.is_empty() {
        (String::new(), Vec::new())
    } else {
        let command = tokens.remove(0);
        (command, tokens)
    }
}

/// 命令名规范化：去引号、去路径、去可执行文件后缀、小写，并归一常见别名。
pub(crate) fn normalize_token(token: &str) -> String {
    let trimmed = token.trim();
    let name = if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = {
        let bytes = base.as_bytes();
        let n = bytes.len();
        if n >= 4 && bytes[n - 4..].eq_ignore_ascii_case(b".exe") {
            &base[..n - 4]
        } else {
            base
        }
    };
    let lower = stem.to_lowercase();
    if lower == "ri" {
        return "remove-item".to_string();
    }
    if lower == "%" {
        return "foreach-object".to_string();
    }
    if lower == "icm" {
        return "invoke-command".to_string();
    }
    lower
}

#[cfg(test)]
mod tests {
    use super::split_segments;

    #[test]
    fn redirect_ampersand_stays_inside_the_segment() {
        assert_eq!(
            split_segments("echo x >&2; exit 7"),
            vec!["echo x >&2".to_string(), "exit 7".to_string()]
        );
        assert_eq!(
            split_segments("echo x 2>&1; exit 7"),
            vec!["echo x 2>&1".to_string(), "exit 7".to_string()]
        );
        assert_eq!(
            split_segments("echo x &>file; exit 7"),
            vec!["echo x &>file".to_string(), "exit 7".to_string()]
        );
        assert_eq!(
            split_segments("echo x <&0; exit 7"),
            vec!["echo x <&0".to_string(), "exit 7".to_string()]
        );
    }

    #[test]
    fn bare_ampersand_still_separates_background_commands() {
        assert_eq!(
            split_segments("sleep 1 & echo x"),
            vec!["sleep 1".to_string(), "echo x".to_string()]
        );
    }
}
