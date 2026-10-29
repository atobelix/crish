//! HTML 转义工具（渲染器与代码高亮共用）。
//!
//! 统一转义 `& < > " '`，正文与属性共用同一函数：
//! 双引号属性使用 `&quot;`，单引号使用 `&#39;`，两者同时转义可以安全地
//! 放进单引号或双引号包裹的属性值中。

/// HTML 正文/属性转义到目标 String 缓冲区，消除中间临时堆分配。
#[inline]
pub fn escape_html_into(s: &str, out: &mut String) {
    let mut last = 0;
    for (i, b) in s.bytes().enumerate() {
        let rep = match b {
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'"' => "&quot;",
            b'\'' => "&#39;",
            _ => continue,
        };
        out.push_str(&s[last..i]);
        out.push_str(rep);
        last = i + 1;
    }
    out.push_str(&s[last..]);
}

/// HTML 属性值转义到目标 String 缓冲区。
#[inline]
pub fn escape_html_attr_into(s: &str, out: &mut String) {
    escape_html_into(s, out);
}

/// HTML 正文/属性转义。
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_html_into(s, &mut out);
    out
}

/// HTML 属性值转义（双引号包裹的属性值）。
pub fn escape_html_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_html_attr_into(s, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_all_html_metacharacters() {
        assert_eq!(
            escape_html("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }

    #[test]
    fn escape_into_appends_without_extra_allocation_contract() {
        let mut out = String::from("prefix:");
        escape_html_into("a<b", &mut out);
        assert_eq!(out, "prefix:a&lt;b");
    }
}
