//! 脱敏（维度 13 §5：密码/凭据字段过滤，单一出口）
//!
//! 红线：快照文本是模型输入，绝不允许凭据经快照泄露（提示词注入防护的一部分）。
//! - D1：`input[type=password]` 的 value/valuetext 一律过滤，序列化输出 `value=[REDACTED]`
//! - D2：`autocomplete` 敏感项过滤 value（current-password/new-password/cc-number 等）
//! - D3：AX 侧同步清除（合并阶段即拦截，不流入后续阶段，防御纵深）
//! - D4：placeholder/aria-label/title 不视为机密，正常输出（不误伤可读性）
//! - D5：不做高熵值启发式猜测（字段级规则已覆盖凭据主入口）
//! - D6：审计/调试日志中的快照片段同样经本模块过滤（与维度 17 日志脱敏联动）

/// 敏感 autocomplete 值清单（D2；小写比较）。
pub const SENSITIVE_AUTOCOMPLETE: &[&str] = &[
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-cvc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-type",
    "card-number",
    "username",
];

/// 脱敏占位符（序列化 `value=[REDACTED]`，保留「这是敏感字段」语义不泄值）。
pub const REDACTED: &str = "[REDACTED]";

/// 敏感 AX property 名（D3：value/valuetext 在 AX 合并阶段即清除）。
pub const SENSITIVE_AX_PROPERTIES: &[&str] = &["value", "valuetext"];

/// 读取属性值（大小写不敏感匹配）。
fn attr_value<'a>(attributes: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// 判定字段是否敏感（D1/D2 共用单出口）：
/// `input[type=password]`，或 `autocomplete` 值命中敏感清单。
pub fn is_sensitive_input(tag: &str, attributes: &[(String, String)]) -> bool {
    if !tag.eq_ignore_ascii_case("input") {
        return false;
    }
    // D1：type=password（属性值先 trim——`type="password "` 尾随空白不得绕过，
    // M6-1；与下方 autocomplete 分支的 trim 口径一致）
    if attr_value(attributes, "type")
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("password"))
    {
        return true;
    }
    // D2：autocomplete 敏感项
    if let Some(ac) = attr_value(attributes, "autocomplete") {
        let ac = ac.trim().to_ascii_lowercase();
        // autocomplete 允许多 token（如 "current-password new-password"），任一命中即敏感
        if SENSITIVE_AUTOCOMPLETE
            .iter()
            .any(|s| ac.split_whitespace().any(|tok| tok == *s))
        {
            return true;
        }
    }
    false
}

/// 输出安全的 value 值（D1/D2 过滤出口）：
/// 敏感字段 → `Some(REDACTED)` 占位；非敏感 → 原值；无 value 属性 → None。
pub fn safe_value(tag: &str, attributes: &[(String, String)]) -> Option<String> {
    let value = attr_value(attributes, "value")?;
    if is_sensitive_input(tag, attributes) {
        Some(REDACTED.to_string())
    } else {
        Some(value.to_string())
    }
}

/// 批量裁剪 + 脱敏（序列化属性准备）：敏感字段的 value 清除为占位，
/// 其余字段原样保留（D4：placeholder/aria-label/title 不误伤）。
pub fn redact_attributes(attributes: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(attributes.len());
    let mut value_seen = false;
    for (k, v) in attributes {
        if k.eq_ignore_ascii_case("value") {
            value_seen = true;
            if is_sensitive_input("input", attributes) {
                out.push((k.clone(), REDACTED.to_string()));
            } else {
                out.push((k.clone(), v.clone()));
            }
        } else {
            out.push((k.clone(), v.clone()));
        }
    }
    // 敏感输入无 value 属性时补占位（保留「这是敏感字段」的语义）
    if !value_seen && is_sensitive_input("input", attributes) {
        out.push(("value".to_string(), REDACTED.to_string()));
    }
    out
}

/// D3：AX 侧 value/valuetext 清除（合并阶段调用；敏感 property 一律拒绝放行）。
pub fn redact_ax_property(name: &str) -> bool {
    SENSITIVE_AX_PROPERTIES
        .iter()
        .any(|s| s.eq_ignore_ascii_case(name))
}

/// D6：日志片段脱敏——快照片段若含敏感输入语义（type=password 或敏感
/// autocomplete 且带 value=），整体打占位，杜绝凭据入日志。
/// 序列化路径已由 `redact_attributes` 过滤；本函数是审计日志的兜底防线。
///
/// 覆盖形态（M6-2）：文本形态 `value=…` 与 JSON 形态 `"value":…`（日志/
/// 调试输出两类）；type=password 的裸/引号/JSON 引号变体与 autocomplete 敏感项。
pub fn redact_fragment(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    // 文本形态 value=… 或 JSON 形态 "value":… / "value" :…
    let has_value = lower.contains("value=")
        || lower.contains("\"value\":")
        || lower.contains("\"value\" :");
    if has_value {
        let password_semantics = PASSWORD_TYPE_PATTERNS
            .iter()
            .any(|p| lower.contains(p))
            || (lower.contains("autocomplete")
                && SENSITIVE_AUTOCOMPLETE
                    .iter()
                    .any(|s| lower.contains(s)));
        if password_semantics {
            return REDACTED.to_string();
        }
    }
    text.to_string()
}

/// type=password 语义的常见序列化形态（小写匹配；引号/无引号/JSON）。
const PASSWORD_TYPE_PATTERNS: [&str; 5] = [
    "type=password",
    "type=\"password",
    "type='password",
    "\"type\":\"password",
    "\"type\": \"password",
];

/// M2：遍历增强树收集敏感输入 backendNodeId（D1/D2 同源判定）。
///
/// 供快照文档携带密码标记（`SnapshotDocument.password_backend_ids`），工具面
/// `is_password` 输入目标判定（密码框走 insertText/只比对长度不回读明文）与
/// 脱敏共用同一敏感判定出口，杜绝两处判定口径漂移。
pub fn sensitive_input_backend_ids(roots: &[crate::snapshot::collect::EnhancedNode])
    -> std::collections::HashSet<i64> {
    fn walk(
        node: &crate::snapshot::collect::EnhancedNode,
        out: &mut std::collections::HashSet<i64>,
    ) {
        if let Some(tag) = node.tag.as_deref() {
            if is_sensitive_input(tag, &node.attributes) {
                out.insert(node.backend_node_id);
            }
        }
        for child in &node.children {
            walk(child, out);
        }
    }
    let mut out = std::collections::HashSet::new();
    for root in roots {
        walk(root, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// D1：type=password 的 value 一律过滤为占位（含大小写变体）。
    #[test]
    fn redact_password_value_filtered() {
        let a = attrs(&[("type", "password"), ("value", "s3cret")]);
        assert!(is_sensitive_input("input", &a));
        assert_eq!(safe_value("input", &a).as_deref(), Some(REDACTED));
        let r = redact_attributes(&a);
        assert_eq!(
            r.iter().find(|(k, _)| k == "value").map(|(_, v)| v.as_str()),
            Some(REDACTED)
        );
        assert!(!r.iter().any(|(_, v)| v == "s3cret"), "密码明文不得流入输出");
    }

    /// D1 大小写：`type="Password"` 同样敏感。
    #[test]
    fn redact_password_case_insensitive() {
        let a = attrs(&[("type", "Password"), ("value", "x")]);
        assert!(is_sensitive_input("input", &a));
        assert_eq!(safe_value("input", &a).as_deref(), Some(REDACTED));
    }

    /// D2：autocomplete 敏感项全清单逐一断言（变体全覆盖）。
    #[test]
    fn redact_autocomplete_sensitive_variants() {
        for sensitive in [
            "current-password",
            "new-password",
            "one-time-code",
            "cc-number",
            "cc-cvc",
            "cc-exp",
            "cc-exp-month",
            "cc-exp-year",
            "cc-type",
            "card-number",
            "username",
        ] {
            let a = attrs(&[("autocomplete", sensitive), ("value", "secret-v")]);
            assert!(
                is_sensitive_input("input", &a),
                "autocomplete={sensitive} 应命中敏感清单"
            );
            assert_eq!(safe_value("input", &a).as_deref(), Some(REDACTED));
        }
    }

    /// D2 多 token 变体：`autocomplete="current-password new-password"` 任一命中即敏感。
    #[test]
    fn redact_autocomplete_multi_token() {
        let a = attrs(&[("autocomplete", "current-password new-password"), ("value", "v")]);
        assert!(is_sensitive_input("input", &a));
    }

    /// D2 非敏感 autocomplete（如 name/email）不误伤。
    #[test]
    fn redact_autocomplete_benign_kept() {
        let a = attrs(&[("autocomplete", "email"), ("value", "a@b.c")]);
        assert!(!is_sensitive_input("input", &a));
        assert_eq!(safe_value("input", &a).as_deref(), Some("a@b.c"));
    }

    /// D4：placeholder/aria-label/title 不视为机密，正常输出。
    #[test]
    fn redact_placeholder_not_redacted() {
        let a = attrs(&[
            ("type", "password"),
            ("placeholder", "请输入密码"),
            ("aria-label", "密码输入框"),
            ("title", "提示"),
            ("value", "x"),
        ]);
        let r = redact_attributes(&a);
        assert!(
            r.iter().any(|(k, v)| k == "placeholder" && v == "请输入密码"),
            "占位提示语无泄密面，不得误伤"
        );
        assert!(r.iter().any(|(k, v)| k == "title" && v == "提示"));
        assert!(r.iter().any(|(k, v)| k == "aria-label" && v == "密码输入框"));
        assert!(
            r.iter().any(|(k, v)| k == "value" && v == "[REDACTED]"),
            "value 仍应脱敏"
        );
    }

    /// D5：非密码 input 的 value 原样保留（不做启发式猜测）。
    #[test]
    fn redact_plain_input_value_kept() {
        let a = attrs(&[("type", "text"), ("value", "搜索词")]);
        assert!(!is_sensitive_input("input", &a));
        assert_eq!(safe_value("input", &a).as_deref(), Some("搜索词"));
    }

    /// 非 input 标签（如 select 的 value）不受 D1/D2 影响。
    #[test]
    fn redact_non_input_not_affected() {
        let a = attrs(&[("value", "abc")]);
        assert!(!is_sensitive_input("select", &a));
        assert_eq!(safe_value("select", &a).as_deref(), Some("abc"));
    }

    /// D3：AX value/valuetext 在合并阶段即拒绝放行。
    #[test]
    fn redact_ax_properties_blocked() {
        assert!(redact_ax_property("value"));
        assert!(redact_ax_property("valuetext"));
        assert!(!redact_ax_property("name"));
        assert!(!redact_ax_property("role"));
    }

    /// D6：日志片段兜底——含敏感语义的 value= 片段整体占位。
    #[test]
    fn redact_fragment_log_guard() {
        assert_eq!(
            redact_fragment("type=password value=abc"),
            "[REDACTED]",
            "密码框语义片段应整体占位"
        );
        assert_eq!(
            redact_fragment("autocomplete=current-password value=abc"),
            "[REDACTED]"
        );
        assert_eq!(
            redact_fragment("value=普通文本"),
            "value=普通文本",
            "无敏感语义的片段不得误伤"
        );
        assert_eq!(
            redact_fragment("type=text value=abc"),
            "type=text value=abc"
        );
    }

    /// 敏感输入无 value 属性时补占位（保持语义）。
    #[test]
    fn redact_missing_value_gets_placeholder() {
        let a = attrs(&[("type", "password"), ("placeholder", "密码")]);
        let r = redact_attributes(&a);
        assert_eq!(
            r.iter().find(|(k, _)| k == "value").map(|(_, v)| v.as_str()),
            Some(REDACTED)
        );
    }

    /// M6-1：type 值尾随空白（`type="password "`）不得绕过敏感判定
    /// （trim 口径与 autocomplete 分支一致）。
    #[test]
    fn redact_password_type_trailing_space_sensitive() {
        let a = attrs(&[("type", "password "), ("value", "s3cret")]);
        assert!(
            is_sensitive_input("input", &a),
            "type=\"password \"（尾随空白）必须命中敏感判定"
        );
        assert_eq!(safe_value("input", &a).as_deref(), Some(REDACTED));
        let leading = attrs(&[("type", " password"), ("value", "s3cret")]);
        assert!(is_sensitive_input("input", &leading), "前导空白同样命中");
        let mixed = attrs(&[("type", "  PaSsWoRd  "), ("value", "s3cret")]);
        assert!(is_sensitive_input("input", &mixed), "大小写+空白组合命中");
    }

    /// M6-2：JSON 形态日志片段（`{"value":"…","type":"password"}`）整体脱敏——
    /// 旧实现仅匹配文本形态 `value=`，JSON 日志直接泄漏明文。
    #[test]
    fn redact_fragment_json_form_guard() {
        // type 在前 / value 在前 / 冒号后带空格 / 引号内尾随空白
        let cases = [
            r#"{"value":"s3cret","type":"password"}"#,
            r#"{"type":"password","value":"s3cret"}"#,
            r#"{"type": "password", "value": "s3cret"}"#,
            r#"{"value":"s3cret","type":"password "}"#,
            r#"<input type="password" value="s3cret">"#,
            r#"<input type='password' value='s3cret'>"#,
        ];
        for c in cases {
            assert_eq!(
                redact_fragment(c),
                REDACTED,
                "JSON/引号形态敏感片段必须整体占位：{c}"
            );
        }
        // 否定面：无敏感语义的 JSON 不得误伤
        assert_eq!(
            redact_fragment(r#"{"value":"hello","type":"text"}"#),
            r#"{"value":"hello","type":"text"}"#,
            "非敏感 JSON 不得误伤"
        );
        assert_eq!(
            redact_fragment(r#"{"type":"text","value":"search"}"#),
            r#"{"type":"text","value":"search"}"#
        );
    }

    /// M2：增强树敏感输入收集——password/敏感 autocomplete 命中、嵌套子树遍历、
    /// 非敏感与文本节点排除。
    #[test]
    fn sensitive_input_backend_ids_walk() {
        use crate::snapshot::collect::EnhancedNode;
        let roots = vec![
            EnhancedNode::element("input", 1).attr("type", "password"),
            EnhancedNode::element("input", 2)
                .attr("type", "text")
                .attr("autocomplete", "current-password"),
            EnhancedNode::element("form", 3).push(EnhancedNode::element("input", 4)
                .attr("type", "password ")
                .push(EnhancedNode::text_node("掩码文本", 5))),
            EnhancedNode::element("input", 6).attr("type", "text"),
        ];
        let sensitive = sensitive_input_backend_ids(&roots);
        assert_eq!(sensitive, [1, 2, 4].into_iter().collect(), "敏感集合应含 password/autocomplete 输入");
        assert!(!sensitive.contains(&3), "容器不敏感");
        assert!(!sensitive.contains(&5), "文本节点不敏感");
        assert!(!sensitive.contains(&6), "普通 text 输入不敏感");
    }
}
