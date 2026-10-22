use super::*;

/// 导出格式 golden（§5.1 Playwright 标准 JSON 精确比对：
/// 会话 cookie expires=-1、持久 cookie 原值、标志位透传、sameSite 保留）。
#[test]
fn export_golden_json() {
    let cookies = vec![
        cdp_cookie(|c| {
            c.name = "sessionid".to_string();
            c.expires = -1.0; // 会话 cookie
            c.session = true;
        }),
        cdp_cookie(|c| {
            c.name = "persist".to_string();
            c.value = "p".to_string();
            c.domain = "example.com".to_string();
            c.expires = 1_750_000_000.0;
            c.http_only = false;
            c.secure = false;
            c.same_site = None;
        }),
    ];
    let state = export_storage_state(&cookies, ExportAuthorization::Confirmed).expect("导出");
    assert_eq!(
        state.to_json(),
        r#"{"cookies":[{"name":"sessionid","value":"abc123","domain":".example.com","path":"/","expires":-1,"httpOnly":true,"secure":true,"sameSite":"Lax"},{"name":"persist","value":"p","domain":"example.com","path":"/","expires":1750000000,"httpOnly":false,"secure":false}],"origins":[]}"#
    );
}

/// 导出需显式授权（§5.2）：Denied → NotAuthorized；Confirmed → Ok。
#[test]
fn export_requires_authorization() {
    assert!(matches!(
        export_storage_state(&[], ExportAuthorization::Denied),
        Err(StorageStateError::NotAuthorized)
    ));
    assert!(export_storage_state(&[], ExportAuthorization::Confirmed).is_ok());
}

/// CDP 归一化（§5.2）：no_restriction → None；非法 sameSite → 省略；
/// expires ≤ 0（会话）→ -1。
#[test]
fn export_cdp_normalization() {
    let cookies = vec![
        cdp_cookie(|c| {
            c.same_site = Some("no_restriction".to_string());
            c.expires = -1.0;
        }),
        cdp_cookie(|c| {
            c.same_site = Some("Weird".to_string());
            c.expires = 0.0;
        }),
        cdp_cookie(|c| {
            c.same_site = Some("strict".to_string()); // 小写容错
        }),
    ];
    let state = export_storage_state(&cookies, ExportAuthorization::Confirmed).expect("导出");
    assert_eq!(state.cookies[0].same_site.as_deref(), Some("None"));
    assert_eq!(state.cookies[0].expires, -1, "会话 cookie → -1");
    assert_eq!(state.cookies[1].same_site, None, "非法 sameSite → 省略");
    assert_eq!(state.cookies[1].expires, -1, "expires=0 按会话处理");
    assert_eq!(
        state.cookies[2].same_site.as_deref(),
        Some("Strict"),
        "小写归一化"
    );
}

/// domain 守卫拒绝集（§5.3）：非法 domain / 空 host / 非 http(s) 域形态。
/// 函数级直接断言（含 JSON 转义面不便表达的字符用例）+ JSON 入口集成断言。
#[test]
fn domain_guard_rejects() {
    let bad = [
        "",            // 空
        "   ",         // 全空白
        "javascript:", // 协议形态
        "http://example.com",
        "https://example.com/",
        "example.com/path",
        "example.com:8080",
        "a b.com",
        "exa@mple.com",
        "exa#mple.com",
        "exa%mple.com",
        "exa\\mple.com",
        ".",                   // 仅点（空 host 形态）
        "-",                   // 仅连字符（空 host 形态）
        "...",                 // 仅点（空 host 形态）
        "e\u{0007}xample.com", // 控制字符
        &"a".repeat(254),      // 超长 host
    ];
    for domain in bad {
        assert!(
            validate_cookie_domain(domain).is_err(),
            "domain `{domain}` 应被拒绝"
        );
    }
    // JSON 入口集成：代表性非法形态经 parse_storage_state 同样拒绝
    let jsons = [
        r#"{"cookies":[{"name":"n","value":"v","domain":""}]}"#,
        r#"{"cookies":[{"name":"n","value":"v","domain":"javascript:"}]}"#,
        r#"{"cookies":[{"name":"n","value":"v","domain":"http://example.com"}]}"#,
    ];
    for json in jsons {
        assert!(
            matches!(
                parse_storage_state(json),
                Err(StorageStateError::InvalidDomain { .. })
            ),
            "JSON 入口 `{json}` 应报 InvalidDomain"
        );
    }
}

/// domain 守卫接受集：前导点（domain cookie）/ 子域 / IP / localhost /
/// 连字符 / 下划线。
#[test]
fn domain_guard_accepts() {
    let ok = [
        ".example.com",
        "example.com",
        "sub.example.com",
        "127.0.0.1",
        "localhost",
        "ex-ample.com",
        "_priv.example.com",
        "a..b",
    ];
    for domain in ok {
        let json =
            format!(r#"{{"cookies":[{{"name":"n","value":"v","domain":"{domain}","path":"/"}}]}}"#);
        assert!(
            parse_storage_state(&json).is_ok(),
            "domain `{domain}` 应被接受"
        );
    }
}

/// 导入注入参数断言（mock CDP 面）：会话 cookie 移除 expires 字段
/// （§5.1 归一化）、持久 cookie 保留、sameSite 归一化、标志位透传。
#[test]
fn import_injection_params() {
    let json = r#"{
            "cookies": [
                {
                    "name": "sessionid", "value": "abc123", "domain": ".example.com",
                    "path": "/", "expires": -1, "httpOnly": true, "secure": true,
                    "sameSite": "lax"
                },
                {
                    "name": "persist", "value": "p", "domain": "example.com",
                    "path": "/", "expires": 1750000000, "httpOnly": false,
                    "secure": false, "sameSite": "None", "unknownField": "dropped"
                }
            ],
            "origins": [],
            "unknownTop": "dropped"
        }"#;
    let state = parse_storage_state(json).expect("解析");
    assert_eq!(state.cookies.len(), 2, "未知字段白名单丢弃");
    let plan = build_import_plan(&state);
    // wire 形态断言（§5.3：Network.setCookies 注入参数）
    let v = serde_json::to_value(&plan.cookies).expect("序列化");
    assert_eq!(v[0]["name"], "sessionid");
    assert_eq!(v[0]["domain"], ".example.com");
    assert_eq!(v[0]["path"], "/");
    assert_eq!(v[0]["httpOnly"], true);
    assert_eq!(v[0]["secure"], true);
    assert_eq!(v[0]["sameSite"], "Lax", "小写 sameSite 归一化为 Lax");
    assert!(
        v[0].get("expires").is_none(),
        "会话 cookie 移除 expires 字段"
    );
    assert_eq!(v[1]["expires"], 1750000000, "持久 cookie 保留 expires");
    // 类型化 CDP 参数面（Storage.setCookies / Network.setCookies）
    let cdp = plan.to_cdp_params();
    assert_eq!(cdp.len(), 2);
    assert!(
        cdp[0].expires.is_none(),
        "会话 cookie 类型化参数 expires=None"
    );
    assert_eq!(cdp[1].expires, Some(1_750_000_000.0));
    assert_eq!(cdp[1].same_site.as_deref(), Some("None"));
    // wire 回归（N2：None 字段必须省略而非 null，Chrome 151 拒绝 null）：
    // 会话 cookie 的 expires 为 None → 键省略；to_cdp_params 恒置 url=None
    // → url 键不得出现；Some 字段（domain/path/httpOnly/secure/sameSite）
    // 正常输出
    let wire = serde_json::to_string(&cdp).expect("类型化参数序列化");
    assert!(
        !wire.contains("null"),
        "to_cdp_params 的 wire JSON 不得含 null：{wire}"
    );
    let v: serde_json::Value = serde_json::from_str(&wire).expect("回读");
    let session = &v[0];
    assert_eq!(session["name"], "sessionid");
    assert_eq!(session["domain"], ".example.com");
    assert_eq!(session["path"], "/");
    assert_eq!(session["httpOnly"], true, "httpOnly Some(true) 显式输出");
    assert_eq!(session["secure"], true);
    assert_eq!(session["sameSite"], "Lax", "归一化 sameSite 显式输出");
    for key in ["url", "expires"] {
        assert!(
            session.get(key).is_none(),
            "会话 cookie wire 不得含 `{key}` 键（None 省略）：{session}"
        );
    }
    assert_eq!(v[1]["expires"], 1_750_000_000.0);
    assert_eq!(v[1]["sameSite"], "None");
    assert!(v[1].get("url").is_none(), "url 恒 None 须省略");
    assert_eq!(plan.stats.cookies, 2);
    assert_eq!(plan.stats.origins, 0);
}

/// 幂等去重（覆盖语义）：同 (domain, name, path) 保留最后出现者；
/// path 不同则两条并存。
#[test]
fn import_dedup_last_wins() {
    let json = r#"{
            "cookies": [
                { "name": "sid", "value": "first", "domain": "example.com", "path": "/" },
                { "name": "sid", "value": "last", "domain": "example.com", "path": "/" },
                { "name": "sid", "value": "other-path", "domain": "example.com", "path": "/app" }
            ]
        }"#;
    let plan = build_import_plan(&parse_storage_state(json).expect("解析"));
    assert_eq!(plan.stats.cookies, 2, "同键覆盖 + path 不同并存");
    assert_eq!(plan.stats.dropped_dupes, 1);
    let by_path: std::collections::HashMap<_, _> = plan
        .cookies
        .iter()
        .map(|c| (c.path.clone().unwrap_or_default(), c.value.clone()))
        .collect();
    assert_eq!(
        by_path.get("/").map(String::as_str),
        Some("last"),
        "覆盖语义：最后一次出现者胜"
    );
    assert_eq!(by_path.get("/app").map(String::as_str), Some("other-path"));
}

/// 空 name cookie 跳过（CDP setCookies 拒绝空 name），计入统计。
#[test]
fn import_skips_empty_name() {
    let json = r#"{
            "cookies": [
                { "name": "", "value": "no-name", "domain": "example.com", "path": "/" },
                { "name": "ok", "value": "v", "domain": "example.com", "path": "/" }
            ]
        }"#;
    let plan = build_import_plan(&parse_storage_state(json).expect("解析"));
    assert_eq!(plan.stats.skipped_empty_name, 1);
    assert_eq!(plan.stats.cookies, 1);
}

/// localStorage origin 守卫脚本形态（§5.3）：脚本内校验 origin 再 setItem；
/// name/value 经 JS 字符串转义（引号/反斜杠）注入。
#[test]
fn origin_guard_script_shape() {
    let items = vec![
        StorageItem {
            name: "theme".to_string(),
            value: "dark".to_string(),
        },
        StorageItem {
            name: "k\"1\\".to_string(),
            value: "v'2".to_string(),
        },
    ];
    let script = origin_guard_script("https://example.com", &items);
    assert!(
        script.contains(r#"window.location.origin !== "https://example.com""#),
        "必须校验 window.location.origin（防跨站污染）"
    );
    assert!(script.contains(r#"localStorage.setItem("theme", "dark")"#));
    assert!(
        script.contains(r#"localStorage.setItem("k\"1\\", "v'2")"#),
        "引号/反斜杠须转义"
    );
    assert!(script.starts_with("(() => {"));
    assert!(script.ends_with("})();"));
}

/// origin 守卫拒绝：非 http(s) 协议 / 带路径 / 无 host / 非 URL。
#[test]
fn origin_guard_rejects() {
    let bad = [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "not-a-url",
        "http://",
        "https://",
        "https://example.com/path", // origin 不允许带路径
        "",
    ];
    for origin in bad {
        let json =
            format!(r#"{{"cookies":[],"origins":[{{"origin":"{origin}","localStorage":[]}}]}}"#);
        assert!(
            matches!(
                parse_storage_state(&json),
                Err(StorageStateError::InvalidOrigin { .. })
            ),
            "origin `{origin}` 应被拒绝"
        );
    }
}

/// origin 守卫接受：http/https 无路径。
#[test]
fn origin_guard_accepts() {
    for origin in [
        "https://example.com",
        "http://localhost:3000",
        "https://sub.example.com/",
    ] {
        let json = format!(
            r#"{{"cookies":[],"origins":[{{"origin":"{origin}","localStorage":[{{"name":"k","value":"v"}}]}}]}}"#
        );
        let state = parse_storage_state(&json).expect("解析");
        let plan = build_import_plan(&state);
        assert_eq!(plan.stats.local_storage_items, 1);
        assert_eq!(plan.stats.origins, 1);
        assert_eq!(plan.origin_scripts[0].origin, origin.trim_end_matches('/'));
    }
}

/// 大小上限（§5.3：10MB）——超限在 JSON 解析前拦截。
#[test]
fn size_limit_enforced() {
    let huge = "x".repeat(STORAGE_STATE_MAX_BYTES + 1);
    assert!(matches!(
        parse_storage_state(&huge),
        Err(StorageStateError::TooLarge { .. })
    ));
}

/// cookie 数量上限（§5.3：5000）——超限提示分批。
#[test]
fn cookie_count_limit_enforced() {
    let mut cookies = Vec::new();
    for i in 0..=STORAGE_STATE_MAX_COOKIES {
        cookies.push(format!(
            r#"{{"name":"n{i}","value":"v","domain":"example.com","path":"/"}}"#
        ));
    }
    let json = format!(r#"{{"cookies":[{}]}}"#, cookies.join(","));
    assert!(matches!(
        parse_storage_state(&json),
        Err(StorageStateError::TooManyCookies { count, .. }) if count == STORAGE_STATE_MAX_COOKIES + 1
    ));
    // 恰好等于上限 → 通过
    cookies.pop();
    let json = format!(r#"{{"cookies":[{}]}}"#, cookies.join(","));
    assert!(parse_storage_state(&json).is_ok());
}
