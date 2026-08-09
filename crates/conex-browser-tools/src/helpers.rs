//! 入参解析与校验助手（对齐 agent-tools tools/mod.rs 风格，独立实现——该处助手为
//! pub(crate)，不可跨 crate 复用）
//!
//! 校验纪律（防注入/防异常入参）：
//! - 缺参/类型错/非整数值/越界 → 结构化 `tool.invalid_input`；
//! - 未知键拒绝（`additionalProperties: false` 的执行面闭环）；
//! - 控制字符与超长字符串护栏（恶意字符串样本零执行面，R-5 纪律延伸）；
//! - URL 仅 http/https（about:blank/newtab 特例），scheme 门禁前置（17 §4.3 步骤 1）；
//! - 上传路径过工作区校验（canonicalize + symlink 双保险，17 §7.2）。

use agent_tools::definition::ToolError;
use conex_types::error::codes;
use serde_json::Value;
use std::path::{Path, PathBuf};
use url::Url;

/// 入参必须是 JSON 对象（非对象入参一律结构化拒绝）。
pub fn ensure_object(args: &Value) -> Result<(), ToolError> {
    if args.is_object() {
        Ok(())
    } else {
        Err(ToolError::invalid_input("入参必须是 JSON 对象"))
    }
}

/// 必填字符串参数。
pub fn require_string(args: &Value, key: &str) -> Result<String, ToolError> {
    ensure_object(args)?;
    match args.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        Some(Value::String(_)) => Err(ToolError::invalid_input(format!("参数 {key} 不能为空"))),
        Some(_) => Err(ToolError::invalid_input(format!("参数 {key} 必须是字符串"))),
        None => Err(ToolError::invalid_input(format!("缺少必填参数：{key}"))),
    }
}

/// 可选字符串参数。
pub fn optional_string(args: &Value, key: &str) -> Result<Option<String>, ToolError> {
    ensure_object(args)?;
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(ToolError::invalid_input(format!("参数 {key} 必须是字符串"))),
    }
}

/// 可选布尔参数。
pub fn optional_bool(args: &Value, key: &str) -> Result<Option<bool>, ToolError> {
    ensure_object(args)?;
    match args.get(key) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(ToolError::invalid_input(format!("参数 {key} 必须是布尔值"))),
    }
}

/// 必填 u64 参数（接受整数 JSON 数字；负数/小数/越界/非数字一律拒绝）。
pub fn require_u64(args: &Value, key: &str) -> Result<u64, ToolError> {
    match optional_u64(args, key)? {
        Some(v) => Ok(v),
        None => Err(ToolError::invalid_input(format!("缺少必填参数：{key}"))),
    }
}

/// 可选 u64 参数。
pub fn optional_u64(args: &Value, key: &str) -> Result<Option<u64>, ToolError> {
    ensure_object(args)?;
    match args.get(key) {
        None => Ok(None),
        Some(Value::Number(n)) => number_as_u64(n)
            .map(Some)
            .map_err(|e| ToolError::invalid_input(format!("参数 {key} 必须是整数（0 起）：{e}"))),
        Some(_) => Err(ToolError::invalid_input(format!("参数 {key} 必须是整数"))),
    }
}

/// 可选 u32 参数（u64 校验 + 上界）。
pub fn optional_u32(args: &Value, key: &str) -> Result<Option<u32>, ToolError> {
    match optional_u64(args, key)? {
        Some(v) if v > u64::from(u32::MAX) => Err(ToolError::invalid_input(format!(
            "参数 {key} 超出范围（0..{}）",
            u32::MAX
        ))),
        Some(v) => Ok(Some(v as u32)),
        None => Ok(None),
    }
}

/// 必填字符串数组参数（元素必须是字符串）。
pub fn require_string_array(args: &Value, key: &str) -> Result<Vec<String>, ToolError> {
    match optional_string_array(args, key)? {
        Some(v) => Ok(v),
        None => Err(ToolError::invalid_input(format!("缺少必填参数：{key}"))),
    }
}

/// 可选字符串数组参数。
pub fn optional_string_array(args: &Value, key: &str) -> Result<Option<Vec<String>>, ToolError> {
    ensure_object(args)?;
    match args.get(key) {
        None => Ok(None),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Value::String(s) => out.push(s.clone()),
                    _ => {
                        return Err(ToolError::invalid_input(format!(
                            "参数 {key} 的元素必须是字符串"
                        )))
                    }
                }
            }
            Ok(Some(out))
        }
        Some(_) => Err(ToolError::invalid_input(format!(
            "参数 {key} 必须是字符串数组"
        ))),
    }
}

/// 未知键拒绝（schema `additionalProperties: false` 的执行面闭环）。
pub fn reject_unknown(args: &Value, allowed: &[&str]) -> Result<(), ToolError> {
    ensure_object(args)?;
    let Some(map) = args.as_object() else {
        return Ok(());
    };
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(ToolError::invalid_input(format!("未知参数：{key}")));
        }
    }
    Ok(())
}

/// 控制字符护栏（防注入样本；\t\n\r 为合法文本格式字符放行）。
pub fn validate_no_control_chars(text: &str, what: &str) -> Result<(), ToolError> {
    if text
        .chars()
        .any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r')
    {
        return Err(ToolError::invalid_input(format!(
            "{what} 含非法控制字符（防注入护栏）"
        )));
    }
    Ok(())
}

/// URL 校验（仅 http/https；about:blank/about:newtab 特例，17 §4.3 步骤 1）。
pub fn validate_http_url(input: &str) -> Result<Url, ToolError> {
    if input.chars().count() > 4096 {
        return Err(ToolError::invalid_input("URL 超长（> 4096 字符）"));
    }
    let parsed =
        Url::parse(input).map_err(|e| ToolError::invalid_input(format!("URL 非法：{e}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        "about" => {
            let page = parsed.path();
            if page == "blank" || page == "newtab" {
                Ok(parsed)
            } else {
                Err(ToolError::invalid_input(format!(
                    "仅支持 http/https（about:blank 特例），收到 about:{page}"
                )))
            }
        }
        other => Err(ToolError::invalid_input(format!(
            "仅支持 http/https（about:blank 特例），收到 {other}"
        ))),
    }
}

/// 工作区路径校验（17 §7.2：canonicalize + symlink 双保险 + 组件边界）。
///
/// 解析后必须是工作区根之内的真实文件路径；越出工作区 → `tool.path_escape`，
/// 不存在/不可访问 → `tool.invalid_input`（14 §9.1 步骤 2 语义）。
pub fn resolve_workspace_path(root: &Path, input: &str) -> Result<PathBuf, ToolError> {
    if input.is_empty() || input.chars().count() > 4096 {
        return Err(ToolError::invalid_input("文件路径非法（空或超长）"));
    }
    let candidate = Path::new(input);
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    // canonicalize 同时解析符号链接：链接目标越出工作区在规范化后仍被前缀校验拦截
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|e| ToolError::invalid_input(format!("文件不存在或不可访问：{input}（{e}）")))?;
    let root_canonical = std::fs::canonicalize(root).map_err(|e| {
        ToolError::invalid_input(format!("工作区根不可访问：{}（{e}）", root.display()))
    })?;
    if !canonical.starts_with(&root_canonical) {
        return Err(ToolError::new(
            codes::TOOL_PATH_ESCAPE,
            format!("路径越出工作区：{input}"),
        ));
    }
    Ok(canonical)
}

/// URL 脱敏（17 §6.2）：query/片段中敏感参数值只留参数名（值替换为 `<redacted>`）。
pub fn redact_url_query(url: &str) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_string();
    };
    // 键名模式：小写包含匹配（过度脱敏安全优先）
    const SENSITIVE_KEYS: [&str; 11] = [
        "token",
        "key",
        "secret",
        "pass",
        "auth",
        "sign",
        "session",
        "sig",
        "cookie",
        "credential",
        "api",
    ];
    let redacted: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| {
            let lower = k.to_ascii_lowercase();
            if SENSITIVE_KEYS.iter().any(|pat| lower.contains(pat)) {
                (k.into_owned(), "<redacted>".to_string())
            } else {
                (k.into_owned(), v.into_owned())
            }
        })
        .collect();
    if redacted.is_empty() {
        return url.to_string();
    }
    {
        let mut pairs = parsed.query_pairs_mut();
        pairs.clear();
        for (k, v) in redacted {
            pairs.append_pair(&k, &v);
        }
    }
    parsed.to_string()
}

/// JSON 数字 → u64（整数性 + 非负 + 范围校验；拒绝小数/负数/非有限值）。
fn number_as_u64(n: &serde_json::Number) -> Result<u64, String> {
    if let Some(v) = n.as_u64() {
        return Ok(v);
    }
    if let Some(v) = n.as_i64() {
        if v < 0 {
            return Err(format!("负数 {v}"));
        }
        return Ok(v as u64);
    }
    if let Some(v) = n.as_f64() {
        if !v.is_finite() {
            return Err("非有限值".to_string());
        }
        if v < 0.0 {
            return Err(format!("负数 {v}"));
        }
        if v.fract() != 0.0 {
            return Err(format!("非整数 {v}"));
        }
        if v > u64::MAX as f64 {
            return Err(format!("超出 u64 范围 {v}"));
        }
        return Ok(v as u64);
    }
    Err("无法解析的数字".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn require_string_contract() {
        let args = json!({ "url": "https://a.example" });
        assert_eq!(require_string(&args, "url").unwrap(), "https://a.example");
        assert!(require_string(&json!({ "url": 1 }), "url").is_err());
        assert!(require_string(&json!({ "url": "" }), "url").is_err());
        assert!(require_string(&json!({}), "url").is_err());
        assert!(require_string(&json!([]), "url").is_err(), "非对象入参拒绝");
    }

    #[test]
    fn u64_parsing_accepts_integers_rejects_others() {
        for good in [json!(0), json!(3), json!(3.0), json!(u64::MAX)] {
            assert_eq!(
                optional_u64(&json!({ "n": good }), "n").unwrap(),
                Some(good.as_u64().unwrap_or(good.as_f64().unwrap() as u64))
            );
        }
        for bad in [
            json!(-1),
            json!(1.5),
            json!(u64::MAX as f64 * 2.0),
            json!("3"),
            json!(true),
        ] {
            assert!(
                optional_u64(&json!({ "n": bad }), "n").is_err(),
                "应拒绝：{bad}"
            );
        }
        assert_eq!(optional_u64(&json!({}), "n").unwrap(), None);
    }

    #[test]
    fn u32_bounds_enforced() {
        assert_eq!(optional_u32(&json!({ "n": 5 }), "n").unwrap(), Some(5));
        let huge = u64::from(u32::MAX) + 1;
        assert!(optional_u32(&json!({ "n": huge }), "n").is_err());
    }

    #[test]
    fn string_array_contract() {
        assert_eq!(
            require_string_array(&json!({ "files": ["a.txt", "b.txt"] }), "files").unwrap(),
            vec!["a.txt", "b.txt"]
        );
        assert!(require_string_array(&json!({ "files": [1] }), "files").is_err());
        assert!(require_string_array(&json!({}), "files").is_err());
    }

    #[test]
    fn unknown_keys_rejected() {
        assert!(reject_unknown(&json!({ "url": "x" }), &["url"]).is_ok());
        assert!(reject_unknown(&json!({ "url": "x", "evil": 1 }), &["url"]).is_err());
        assert!(reject_unknown(&json!({}), &[]).is_ok());
        assert!(reject_unknown(&json!([]), &[]).is_err());
    }

    #[test]
    fn control_chars_rejected() {
        assert!(validate_no_control_chars("正常文本\n第二行", "text").is_ok());
        assert!(validate_no_control_chars("bad\x00text", "text").is_err());
        assert!(validate_no_control_chars("bad\u{1b}text", "text").is_err());
    }

    #[test]
    fn http_url_validation() {
        assert!(validate_http_url("https://example.com/a?b=1").is_ok());
        assert!(validate_http_url("http://127.0.0.1:8080/").is_ok());
        assert!(validate_http_url("about:blank").is_ok());
        assert!(validate_http_url("about:newtab").is_ok());
        assert!(validate_http_url("javascript:alert(1)").is_err());
        assert!(validate_http_url("ftp://example.com/").is_err());
        assert!(validate_http_url("file:///C:/x").is_err());
        assert!(validate_http_url("not a url").is_err());
        assert!(validate_http_url("about:settings").is_err());
    }

    /// 工作区路径：越界 → path_escape；不存在 → invalid_input；符号链接越界同样拦截。
    #[test]
    fn workspace_path_contract() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        let inside = ws.join("inner");
        std::fs::create_dir_all(&inside).unwrap();
        let file = inside.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let file_canonical = std::fs::canonicalize(&file).unwrap();

        let ok = resolve_workspace_path(ws, "inner/a.txt").unwrap();
        assert_eq!(ok, file_canonical, "canonicalize 后与真实路径一致");

        let abs = resolve_workspace_path(ws, file.to_str().unwrap()).unwrap();
        assert_eq!(abs, file_canonical);

        // 越出工作区（真实存在的文件 → canonicalize 成功 → 前缀校验拦截）
        let outside = dir.path().parent().unwrap().join("outside.txt");
        std::fs::write(&outside, "z").unwrap();
        let escape = resolve_workspace_path(ws, "../outside.txt");
        assert_eq!(
            escape.unwrap_err().code(),
            codes::TOOL_PATH_ESCAPE,
            ".. 穿越应 path_escape"
        );

        let missing = resolve_workspace_path(ws, "nope.txt");
        assert!(missing.is_err());

        // 符号链接指向工作区外 → canonicalize 后前缀校验拦截
        #[cfg(unix)]
        {
            let outside = ws.join("../symlink-target.txt");
            std::fs::write(&outside, "y").unwrap();
            let link = inside.join("link.txt");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            let err = resolve_workspace_path(ws, "inner/link.txt").unwrap_err();
            assert_eq!(err.code(), codes::TOOL_PATH_ESCAPE);
        }
    }

    #[test]
    fn url_query_redaction() {
        assert_eq!(
            redact_url_query("https://a.example/login?token=abc&page=2"),
            "https://a.example/login?token=%3Credacted%3E&page=2"
        );
        assert_eq!(
            redact_url_query("https://a.example/plain?q=hello"),
            "https://a.example/plain?q=hello"
        );
        // 无 query 原样返回
        assert_eq!(
            redact_url_query("https://a.example/plain"),
            "https://a.example/plain"
        );
        // 非法 URL 原样返回（不落 panic）
        assert_eq!(redact_url_query("://broken"), "://broken");
    }
}
