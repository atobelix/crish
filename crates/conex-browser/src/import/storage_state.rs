//! storage_state 辅助通道（维度 16 §5）
//!
//! - **导出**（§5.2）：CDP `Storage.getCookies` 结果 → Playwright 标准 JSON
//!   （cookies 数组 + 可选 `origins[].localStorage`）；**内存传递**——返回内存
//!   字符串，本模块不落盘（§5.4 强制面：写盘仅走前端显式「另存为」路径）；
//!   **导出需显式授权**：调用方必须传 [`ExportAuthorization::Confirmed`]
//!   （授权对话框确认后），否则返回 [`StorageStateError::NotAuthorized`]。
//! - **导入**（§5.3）：JSON 解析 → **domain 守卫**（拒绝非法 domain / 空 host /
//!   非 http(s) 域形态：`javascript:`、`http://…`、带路径/端口/分隔符形态）→
//!   [`ImportPlan`]：`Network.setCookies` 批量注入参数 + localStorage
//!   **origin 守卫**恢复脚本（脚本内先校验 `window.location.origin` 再
//!   `setItem`，防跨站污染，对照 storage_state_watchdog.py:270-308）。
//! - **幂等**：同 (domain, name, path) 去重（**覆盖语义**，最后一次出现者胜）；
//!   会话 cookie（expires ≤ 0）导入时**移除 expires 字段**（§5.1 归一化，
//!   对照 storage_state_watchdog.py:252-264 的归一化处理）。
//!
//! 上限（§5.3 解析校验）：JSON 大小 10MB、cookie 数量 5000（超限提示分批）。
//! 日志/审计脱敏纪律（§5.4）：本模块不产生任何日志/事件负载；cookie value
//! 仅在内存结构中出现。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁、无文件 IO（纯内存转换）。

use crate::cdp::domains::{Cookie as CdpCookie, SetCookieParam};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// storage_state JSON 大小上限（§5.3：10MB）。
pub const STORAGE_STATE_MAX_BYTES: usize = 10 * 1024 * 1024;
/// cookie 数量上限（§5.3：超限提示分批导入）。
pub const STORAGE_STATE_MAX_COOKIES: usize = 5000;
/// 会话 cookie 的 expires 标记值（§5.1：-1 表示会话 cookie）。
pub const SESSION_COOKIE_EXPIRES: i64 = -1;

/// 导出授权位（§5.2：导出属敏感动作，走既有审批面 `dangerous=true`；
/// 调用方必须在授权对话框确认后才传 `Confirmed`——显式授权，不默认放行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportAuthorization {
    /// 授权对话框已确认（含 cookie 数量与域名清单预览）。
    Confirmed,
    /// 未确认/被拒绝（返回 `NotAuthorized`，不执行导出）。
    Denied,
}

/// storage_state 单条 cookie（Playwright 标准格式字段面：
/// `httpOnly`/`sameSite` camelCase 键，§5.1）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default = "default_path")]
    pub path: String,
    /// -1 表示会话 cookie（§5.1）。
    #[serde(default = "default_expires")]
    pub expires: i64,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub secure: bool,
    /// `Strict` / `Lax` / `None`（缺失不输出，§5.1 sameSite 取值）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

/// localStorage 条目（`origins[].localStorage` 元素）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageItem {
    pub name: String,
    pub value: String,
}

/// storage_state 单个 origin（`origins[]` 元素）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageOrigin {
    pub origin: String,
    /// localStorage 条目（Playwright 格式键 `localStorage`，见 §5.1）。
    #[serde(default, rename = "localStorage")]
    pub local_storage: Vec<StorageItem>,
}

/// storage_state 整体（Playwright 兼容格式，§5.1）：
/// `{ "cookies": [...], "origins": [...] }`；origins 可选。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageState {
    #[serde(default)]
    pub cookies: Vec<StorageCookie>,
    #[serde(default)]
    pub origins: Vec<StorageOrigin>,
}

impl StorageState {
    /// 从 CDP `Storage.getCookies` / `Network.getAllCookies` 结果转换
    /// （§5.2 字段归一化，对照 session.py:1427-1470）：
    /// 会话 cookie（expires ≤ 0）→ `expires = -1`；sameSite 归一化为
    /// `Strict`/`Lax`/`None`（`no_restriction` 旧值 → `None`，非法值丢弃）。
    /// localStorage 需 `DOMStorage` 域聚合，本入口不采集（origins 为空，
    /// 导出侧聚合为接线遗留，见 [`ImportPlan`] 的注入面说明）。
    pub fn from_cdp_cookies(cookies: &[CdpCookie]) -> Self {
        StorageState {
            cookies: cookies
                .iter()
                .map(|c| StorageCookie {
                    name: c.name.clone(),
                    value: c.value.clone(),
                    domain: c.domain.clone(),
                    path: c.path.clone(),
                    expires: if c.expires <= 0.0 {
                        SESSION_COOKIE_EXPIRES
                    } else {
                        c.expires as i64
                    },
                    http_only: c.http_only,
                    secure: c.secure,
                    same_site: normalize_same_site(c.same_site.as_deref()),
                })
                .collect(),
            origins: Vec::new(),
        }
    }

    /// 序列化为标准 JSON（§5.2 **内存传递**：返回字符串，不落盘；
    /// 写盘仅走前端显式「另存为」路径）。
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("storage_state 序列化不可失败")
    }
}

/// 解析并校验 storage_state JSON（§5.3 解析校验）：
/// 大小上限 → 合法 JSON → cookie 数量上限 → domain 守卫 → origin 守卫。
/// 未知字段静默丢弃（字段白名单由 serde 结构面保证）。
pub fn parse_storage_state(json: &str) -> Result<StorageState, StorageStateError> {
    if json.len() > STORAGE_STATE_MAX_BYTES {
        return Err(StorageStateError::TooLarge {
            bytes: json.len(),
            max: STORAGE_STATE_MAX_BYTES,
        });
    }
    let state: StorageState =
        serde_json::from_str(json).map_err(|e| StorageStateError::Json(e.to_string()))?;
    if state.cookies.len() > STORAGE_STATE_MAX_COOKIES {
        return Err(StorageStateError::TooManyCookies {
            count: state.cookies.len(),
            max: STORAGE_STATE_MAX_COOKIES,
        });
    }
    for c in &state.cookies {
        validate_cookie_domain(&c.domain).map_err(|reason| StorageStateError::InvalidDomain {
            domain: c.domain.clone(),
            reason,
        })?;
    }
    for o in &state.origins {
        validate_origin(&o.origin).map_err(|reason| StorageStateError::InvalidOrigin {
            origin: o.origin.clone(),
            reason,
        })?;
    }
    Ok(state)
}

/// domain 守卫（§5.3：拒绝非法 domain / 空 host / 非 http(s) 域形态）。
/// 合法域形态：ASCII 主机名形态，允许前导点（domain cookie）、字母/数字/
/// 连字符/下划线/点；拒绝含协议分隔符（`:`——含 `javascript:`、
/// `http://…`、带端口）、路径、用户信息、空格、控制字符、`%` 等。
pub fn validate_cookie_domain(domain: &str) -> Result<(), String> {
    let host = domain.trim();
    if host.is_empty() {
        return Err("domain 为空".to_string());
    }
    if host.len() > 253 {
        return Err(format!("domain 超长（{} 字节 > 253）", host.len()));
    }
    for ch in host.chars() {
        let ok = ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_';
        if !ok {
            return Err(format!(
                "含非法字符 `{ch}`（仅允许字母/数字/点/连字符/下划线）"
            ));
        }
    }
    // 空 host 形态：仅点/连字符等非字母数字字符构成
    if !host.chars().any(|ch| ch.is_ascii_alphanumeric()) {
        return Err("host 不含任何字母/数字（空 host 形态）".to_string());
    }
    Ok(())
}

/// origin 守卫（§5.3：localStorage 注入须为 http(s) 且无路径的合法 origin）。
pub fn validate_origin(origin: &str) -> Result<(), String> {
    if origin.is_empty() {
        return Err("origin 为空".to_string());
    }
    let url = url::Url::parse(origin).map_err(|e| format!("非法 URL：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("非 http(s) 协议（{}）", url.scheme()));
    }
    if url.host().is_none() {
        return Err("origin 无 host".to_string());
    }
    if !(url.path().is_empty() || url.path() == "/") {
        return Err(format!("origin 不允许带路径（{}）", url.path()));
    }
    Ok(())
}

/// 构建 localStorage 注入计划（§5.3 注入面）：
/// `Page.addScriptToEvaluateOnNewDocument` 恢复脚本，**按 origin 作用域守卫**
/// ——脚本内先校验 `window.location.origin` 再 `setItem`（防跨站污染）。
/// origin 尾部斜杠归一化（`location.origin` 恒无尾部斜杠）。
pub fn origin_guard_script(origin: &str, items: &[StorageItem]) -> String {
    let origin = normalize_origin(origin);
    // JS 字符串字面量：JSON 字符串转义与 JS 字符串转义兼容（引号/反斜杠/换行）
    let origin_lit = serde_json::to_string(origin).expect("字符串序列化不可失败");
    let mut source = String::from("(() => { if (window.location.origin !== ");
    source.push_str(&origin_lit);
    source.push_str(") { return; }\n");
    for item in items {
        let name_lit = serde_json::to_string(&item.name).expect("字符串序列化不可失败");
        let value_lit = serde_json::to_string(&item.value).expect("字符串序列化不可失败");
        source.push_str("  try { localStorage.setItem(");
        source.push_str(&name_lit);
        source.push_str(", ");
        source.push_str(&value_lit);
        source.push_str("); } catch (e) {}\n");
    }
    source.push_str("})();");
    source
}

/// 单个 origin 恢复脚本（注入面元素）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginScript {
    /// 目标 origin（`Page.addScriptToEvaluateOnNewDocument` 关联文档校验用）。
    pub origin: String,
    /// 已含 origin 守卫的注入脚本源码。
    pub source: String,
}

/// 导入统计（审计面：数量脱敏，不含 cookie value）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportStats {
    /// 注入计划最终 cookie 数（去重 + 过滤后）。
    pub cookies: usize,
    /// 同 (domain, name, path) 去重丢弃数（覆盖语义）。
    pub dropped_dupes: usize,
    /// 空 name 非法 cookie 跳过数。
    pub skipped_empty_name: usize,
    /// origin 数（含 localStorage 的）。
    pub origins: usize,
    /// localStorage 条目总数。
    pub local_storage_items: usize,
}

/// 导入注入计划（§5.3）：`Network.setCookies` wire 参数 + localStorage 守卫脚本。
#[derive(Debug, Clone)]
pub struct ImportPlan {
    /// cookie 批量注入参数（**wire-ready**：会话 cookie 不带 `expires` 字段，
    /// §5.1 归一化；`Option` 字段一律省略而非输出 null）。
    pub cookies: Vec<CookieInjectParam>,
    /// localStorage 注入恢复脚本（`Page.addScriptToEvaluateOnNewDocument`）。
    pub origin_scripts: Vec<OriginScript>,
    /// 导入统计（审计）。
    pub stats: ImportStats,
}

impl ImportPlan {
    /// 转换为 CDP `Storage.setCookies` / `Network.setCookies` 类型化参数
    /// （会话 cookie `expires: None` 原样透传——CDP 对可选参数 null/缺省
    /// 等价视为未设置；类型化参数面由 cdp/domains.rs 提供）。
    pub fn to_cdp_params(&self) -> Vec<SetCookieParam> {
        self.cookies
            .iter()
            .map(|c| SetCookieParam {
                name: c.name.clone(),
                value: c.value.clone(),
                domain: c.domain.clone(),
                url: None,
                path: c.path.clone(),
                expires: c.expires.map(|e| e as f64),
                http_only: c.http_only,
                secure: c.secure,
                same_site: c.same_site.clone(),
            })
            .collect()
    }
}

/// cookie 注入参数（wire 形态，§5.1 Playwright 兼容字段面）：
/// 会话 cookie（expires ≤ 0）**不输出 expires 字段**（导入时移除，
/// 归一化处理对照 storage_state_watchdog.py:252-264）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieInjectParam {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

/// 由校验后的 storage_state 构建注入计划（幂等：同 (domain, name, path)
/// 去重、**覆盖语义**最后出现者胜；会话 cookie 移除 expires 字段）。
pub fn build_import_plan(state: &StorageState) -> ImportPlan {
    // 空 name cookie 非法（CDP setCookies 拒绝空 name），先过滤再去重
    let mut valid: Vec<&StorageCookie> = Vec::new();
    let mut skipped_empty_name = 0usize;
    for c in &state.cookies {
        if c.name.is_empty() {
            skipped_empty_name += 1;
        } else {
            valid.push(c);
        }
    }
    // 去重（覆盖语义）：同 (domain, name, path) 仅保留最后一次出现
    let mut index: HashMap<(String, String, String), usize> = HashMap::new();
    let mut cookies: Vec<CookieInjectParam> = Vec::new();
    let mut dropped_dupes = 0usize;
    for c in valid {
        let key = (c.domain.clone(), c.name.clone(), c.path.clone());
        let param = CookieInjectParam {
            name: c.name.clone(),
            value: c.value.clone(),
            domain: Some(c.domain.clone()),
            path: Some(c.path.clone()),
            // §5.1 归一化：会话 cookie（expires ≤ 0）不输出 expires 字段
            expires: if c.expires <= 0 {
                None
            } else {
                Some(c.expires)
            },
            http_only: Some(c.http_only),
            secure: Some(c.secure),
            same_site: normalize_same_site(c.same_site.as_deref()),
        };
        match index.get(&key) {
            Some(&i) => {
                cookies[i] = param; // 覆盖语义：最后一次出现者胜
                dropped_dupes += 1;
            }
            None => {
                index.insert(key, cookies.len());
                cookies.push(param);
            }
        }
    }
    let origin_scripts: Vec<OriginScript> = state
        .origins
        .iter()
        .map(|o| OriginScript {
            origin: normalize_origin(&o.origin).to_string(),
            source: origin_guard_script(&o.origin, &o.local_storage),
        })
        .collect();
    let stats = ImportStats {
        cookies: cookies.len(),
        dropped_dupes,
        skipped_empty_name,
        origins: origin_scripts.len(),
        local_storage_items: state.origins.iter().map(|o| o.local_storage.len()).sum(),
    };
    ImportPlan {
        cookies,
        origin_scripts,
        stats,
    }
}

/// 导出入口（§5.2）：**需显式授权**（`Confirmed`），结果**内存传递**不落盘。
pub fn export_storage_state(
    cookies: &[CdpCookie],
    auth: ExportAuthorization,
) -> Result<StorageState, StorageStateError> {
    if auth == ExportAuthorization::Denied {
        return Err(StorageStateError::NotAuthorized);
    }
    Ok(StorageState::from_cdp_cookies(cookies))
}

/// sameSite 归一化：`Strict`/`Lax`/`None`（大小写容错）；
/// CDP 旧值 `no_restriction` → `None`；其他非法值 → None（字段省略）。
fn normalize_same_site(same_site: Option<&str>) -> Option<String> {
    match same_site.map(str::to_ascii_lowercase).as_deref() {
        Some("strict") => Some("Strict".to_string()),
        Some("lax") => Some("Lax".to_string()),
        Some("none") | Some("no_restriction") => Some("None".to_string()),
        _ => None,
    }
}

fn default_path() -> String {
    "/".to_string()
}

fn default_expires() -> i64 {
    SESSION_COOKIE_EXPIRES
}

/// origin 尾部斜杠归一化（`window.location.origin` 恒无尾部斜杠，
/// 注入脚本内比较须对齐；`http://localhost:3000/` → `http://localhost:3000`）。
fn normalize_origin(origin: &str) -> &str {
    origin.trim_end_matches('/')
}

/// storage_state 错误面。
#[derive(Debug, thiserror::Error)]
pub enum StorageStateError {
    /// JSON 非法。
    #[error("storage_state JSON 解析失败：{0}")]
    Json(String),
    /// 超出大小上限（§5.3）。
    #[error("storage_state 超限（{bytes} 字节 > 上限 {max} 字节）")]
    TooLarge { bytes: usize, max: usize },
    /// 超出 cookie 数量上限（§5.3：提示分批导入）。
    #[error("cookie 数量超限（{count} > 上限 {max}）")]
    TooManyCookies { count: usize, max: usize },
    /// domain 守卫拒绝（§5.3：非法 domain / 空 host / 非 http(s) 域形态）。
    #[error("非法 cookie domain（{domain}）：{reason}")]
    InvalidDomain { domain: String, reason: String },
    /// origin 守卫拒绝（非 http(s) / 带路径 / 无 host）。
    #[error("非法 origin（{origin}）：{reason}")]
    InvalidOrigin { origin: String, reason: String },
    /// 导出未获显式授权（§5.2）。
    #[error("导出未获显式授权（storage_state 属敏感动作，须授权对话框确认）")]
    NotAuthorized,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::domains::Cookie;

    fn cdp_cookie(overrides: impl Fn(&mut Cookie)) -> Cookie {
        let mut c = Cookie {
            name: "sid".to_string(),
            value: "abc123".to_string(),
            domain: ".example.com".to_string(),
            path: "/".to_string(),
            expires: 1_750_000_000.0,
            size: 10,
            http_only: true,
            secure: true,
            session: false,
            same_site: Some("Lax".to_string()),
            priority: Some("Medium".to_string()),
        };
        overrides(&mut c);
        c
    }

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
            let json = format!(
                r#"{{"cookies":[{{"name":"n","value":"v","domain":"{domain}","path":"/"}}]}}"#
            );
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
            let json = format!(
                r#"{{"cookies":[],"origins":[{{"origin":"{origin}","localStorage":[]}}]}}"#
            );
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

    /// 非法 JSON / 空对象 / 往返序列化。
    #[test]
    fn parse_tolerance_and_roundtrip() {
        assert!(matches!(
            parse_storage_state("{ not json !!"),
            Err(StorageStateError::Json(_))
        ));
        let empty = parse_storage_state("{}").expect("空对象");
        assert!(empty.cookies.is_empty() && empty.origins.is_empty());
        assert_eq!(empty.to_json(), r#"{"cookies":[],"origins":[]}"#);
        // 往返：导出 → 序列化 → 解析 → 注入参数一致
        let cookies = vec![cdp_cookie(|c| {
            c.name = "roundtrip".to_string();
        })];
        let state = export_storage_state(&cookies, ExportAuthorization::Confirmed).expect("导出");
        let json = state.to_json();
        let reparsed = parse_storage_state(&json).expect("重解析");
        assert_eq!(state, reparsed, "导出 → 序列化 → 解析往返一致");
    }
}
