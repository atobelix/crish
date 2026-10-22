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
//! - **注入执行**（§5.3）：[`inject_origin_scripts`]——origin 守卫恢复脚本经
//!   `Page.addScriptToEvaluateOnNewDocument` 注册（未来文档，页面脚本执行前
//!   恢复）+ `DOMStorage.setDOMStorageItem` 直写当前页（立即生效；storageId
//!   securityOrigin 按 origin 守卫校验，拒绝非法 origin）；发送层经
//!   [`LocalStorageChannel`] 抽象（真实实现 [`SessionLocalStorageChannel`]，
//!   测试 mock 断言 wire 参数）。
//! - **导出聚合**（§5.2）：[`collect_local_storage`]——`DOMStorage.getDOMStorageItems`
//!   按 origin 读取（带守卫），经 [`export_storage_state_with_origins`] 并入导出面；
//!   origin 清单由 [`export_origins_from_cookies`] 从 cookie domain 推导
//!   （协议按 secure 标志，读取前 origin 守卫过滤）。
//! - **幂等**：同 (domain, name, path) 去重（**覆盖语义**，最后一次出现者胜）；
//!   会话 cookie（expires ≤ 0）导入时**移除 expires 字段**（§5.1 归一化，
//!   对照 storage_state_watchdog.py:252-264 的归一化处理）。
//!
//! 上限（§5.3 解析校验）：JSON 大小 10MB、cookie 数量 5000（超限提示分批）。
//! 日志/审计脱敏纪律（§5.4）：本模块不产生任何日志/事件负载；cookie value
//! 仅在内存结构中出现。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁、无文件 IO（纯内存转换）。

mod channel;
mod model;
mod plan;

pub use channel::{
    collect_local_storage, export_origins_from_cookies, export_storage_state_with_origins,
    inject_origin_scripts, InjectStats, LocalStorageChannel, SessionLocalStorageChannel,
};
pub use model::{
    origin_guard_script, parse_storage_state, validate_cookie_domain, validate_origin,
    StorageCookie, StorageItem, StorageOrigin, StorageState,
};
pub use plan::{
    build_import_plan, export_storage_state, CookieInjectParam, ImportPlan, ImportStats,
    OriginScript,
};

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
    /// CDP 注入/读取命令失败（写入与导出聚合共用）。
    #[error("localStorage CDP 命令失败[{method}]：{message}")]
    Inject { method: String, message: String },
}

#[cfg(test)]
mod tests;
