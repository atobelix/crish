//! storage_state 数据模型：cookie/localStorage 结构、解析与 domain/origin 守卫。
//!
//! serde `default = "..."` 引用的 helper（default_path/default_expires）与
//! [`StorageCookie`] 同文件，保证字符串路径按本模块作用域解析。

use super::{
    StorageStateError, SESSION_COOKIE_EXPIRES, STORAGE_STATE_MAX_BYTES, STORAGE_STATE_MAX_COOKIES,
};
use crate::cdp::domains::Cookie as CdpCookie;
use serde::{Deserialize, Serialize};

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

/// sameSite 归一化：`Strict`/`Lax`/`None`（大小写容错）；
/// CDP 旧值 `no_restriction` → `None`；其他非法值 → None（字段省略）。
pub(super) fn normalize_same_site(same_site: Option<&str>) -> Option<String> {
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
pub(super) fn normalize_origin(origin: &str) -> &str {
    origin.trim_end_matches('/')
}
