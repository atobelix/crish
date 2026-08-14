//! 密码框抑制登记穷举测试（S4：04 §4.5 / 18 §3.3 数据面抑制——UIA 层已
//! 实现文本不读取，本模块登记约束常量与键名判定纯函数，供审计与工具层消费）。
//!
//! 验证面：
//! - 占位符常量登记（`<password>` / `<redacted>`）；
//! - 键名模式库登记（password / passwd / pwd / secret / token）；
//! - 命中判定：大小写不敏感 + 子串命中（保守脱敏方向）；
//! - 非命中：普通字段名 / 中文名 / 空串不误伤；
//! - 脱敏函数：命中 → 占位符，未命中 → 原文。

use conex_computer::security::{
    is_password_field_name, redact_password_field, PASSWORD_KEYNAME_PATTERNS, PASSWORD_PLACEHOLDER,
    PASSWORD_REDACTION_PLACEHOLDER,
};

/// 占位符常量登记（UIA 输出不落实际字符，04 §4.5 ①：占位符可记长度、
/// 不记内容）
#[test]
fn placeholder_constants_registered() {
    assert_eq!(PASSWORD_PLACEHOLDER, "<password>");
    assert_eq!(PASSWORD_REDACTION_PLACEHOLDER, "<redacted>");
}

/// 键名模式库登记（18 §3.3：password / passwd / pwd / secret / token 五项）
#[test]
fn keyname_patterns_registered() {
    assert_eq!(
        PASSWORD_KEYNAME_PATTERNS,
        &["password", "passwd", "pwd", "secret", "token"],
        "键名模式库必须与 18 §3.3 登记一致"
    );
}

/// 命中判定：大小写不敏感 + 子串命中（保守脱敏——宁可多脱敏不漏脱）
#[test]
fn keyname_hit_variants() {
    for hit in [
        "password",
        "Password",
        "PASSWORD",
        "passwd",
        "pwd",
        "PWD",
        "secret",
        "Secret",
        "token",
        "Token",
        "access_token",
        "userPassword",
        "confirm_password_field",
        "pwdBox",
        "api_secret_key",
    ] {
        assert!(is_password_field_name(hit), "应命中键名模式：{hit:?}");
    }
}

/// 非命中：普通字段名 / 中文名 / 空串不误伤
#[test]
fn non_keyname_fields_untouched() {
    for miss in [
        "",
        "name",
        "title",
        "value",
        "button",
        "text",
        "email",
        "phone",
        "用户名",
        "登录",
        "标题",
        "确认",
        "验证码",
    ] {
        assert!(!is_password_field_name(miss), "不应命中键名模式：{miss:?}");
    }
}

/// 脱敏函数：命中 → 占位符；未命中 → 原文（原文保真，不落敏感内容）
#[test]
fn redact_preserves_or_redacts() {
    assert_eq!(
        redact_password_field("login_password"),
        PASSWORD_REDACTION_PLACEHOLDER
    );
    assert_eq!(
        redact_password_field("password"),
        PASSWORD_REDACTION_PLACEHOLDER
    );
    assert_eq!(redact_password_field("标题"), "标题");
    assert_eq!(redact_password_field("name"), "name");
}

/// 键名模式库只读面：常量模式不被改动（登记即契约）
#[test]
fn patterns_are_contractual_constants() {
    let patterns = PASSWORD_KEYNAME_PATTERNS;
    assert_eq!(patterns.len(), 5, "模式库规模锁定为 5 项");
    for pattern in patterns {
        assert!(!pattern.is_empty(), "模式不得为空串");
    }
}
