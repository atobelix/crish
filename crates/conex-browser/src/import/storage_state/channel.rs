//! storage_state localStorage 注入/导出执行面（LocalStorageChannel 及真实 CDP 实现）。

use super::model::{normalize_origin, validate_origin, StorageItem, StorageOrigin, StorageState};
use super::plan::ImportPlan;
use super::{ExportAuthorization, StorageStateError};
use crate::cdp::domains::names::{
    DOM_STORAGE_ENABLE, DOM_STORAGE_GET_DOM_STORAGE_ITEMS, DOM_STORAGE_SET_DOM_STORAGE_ITEM,
    PAGE_ADD_SCRIPT_TO_EVALUATE_ON_NEW_DOCUMENT,
};
use crate::cdp::domains::{
    AddScriptToEvaluateOnNewDocumentParams, Cookie as CdpCookie, GetDOMStorageItemsParams,
    GetDOMStorageItemsResult, SetDOMStorageItemParams, StorageId,
};
use crate::BrowserSession;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// localStorage 注入/导出执行面（§5.3 注入 + §5.2 导出聚合；J1b 接线点）
// ---------------------------------------------------------------------------

/// DOMStorage/Page 注入执行面抽象（发送层解耦——测试经 mock 断言 wire 参数，
/// 真实实现见 [`SessionLocalStorageChannel`]）。
#[async_trait]
pub trait LocalStorageChannel: Send + Sync {
    /// 注册 origin 守卫恢复脚本（`Page.addScriptToEvaluateOnNewDocument`；
    /// 作用于后续新文档——页面脚本执行前恢复；重复导入按注册序叠加，旧脚本
    /// 先执行、新脚本后执行，最终值胜——覆盖语义由注册序保证）。
    async fn add_init_script(&self, source: &str) -> Result<(), StorageStateError>;
    /// 直写某 origin 的 localStorage（`DOMStorage.setDOMStorageItem`；
    /// storageId.securityOrigin 由调用方按 origin 守卫校验后构造）。
    async fn set_dom_storage_item(
        &self,
        security_origin: &str,
        key: &str,
        value: &str,
    ) -> Result<(), StorageStateError>;
    /// 读取某 origin 的 localStorage（`DOMStorage.getDOMStorageItems`；
    /// 导出侧聚合输入，返回 (name, value) 对）。
    async fn get_dom_storage_items(
        &self,
        security_origin: &str,
    ) -> Result<Vec<(String, String)>, StorageStateError>;
}

/// 真实注入执行通道（经 `BrowserSession` 统一发送层；绑定目标标签会话——
/// `Page.addScriptToEvaluateOnNewDocument` 与 DOMStorage 命令均按会话路由）。
pub struct SessionLocalStorageChannel {
    session: Arc<BrowserSession>,
    session_id: String,
    /// `DOMStorage.enable` 一次性惰性发送（幂等；命令面本身不依赖 enable，
    /// 但协议惯例在直写/读取前使域就绪，防事件面缺失）。
    enabled: AtomicBool,
}

impl SessionLocalStorageChannel {
    /// 绑定活动标签会话（无活动标签 → `Inject` 错误）。
    pub fn for_active(session: Arc<BrowserSession>) -> Result<Self, StorageStateError> {
        let current = session
            .current_session()
            .map_err(|e| map_inject_error("current_session", e))?;
        Ok(SessionLocalStorageChannel {
            session,
            session_id: current.session,
            enabled: AtomicBool::new(false),
        })
    }

    /// 绑定具体标签会话（P1 多标签：per-tab 注入路由）。
    pub fn with_session(session: Arc<BrowserSession>, session_id: String) -> Self {
        SessionLocalStorageChannel {
            session,
            session_id,
            enabled: AtomicBool::new(false),
        }
    }

    /// `DOMStorage.enable` 惰性发送（每通道一次性，幂等）。
    async fn ensure_enabled(&self) -> Result<(), StorageStateError> {
        if self.enabled.load(Ordering::Relaxed) {
            return Ok(());
        }
        // 响应体无意义（enable 回执），但类型参数必须显式给出——用 turbofish
        // 而非 `let _: T = ...`，避免「丢弃赋值」形态掩盖真实错误面（错误经 ? 上抛）。
        self.session
            .send_page::<serde_json::Value>(
                &self.session_id,
                DOM_STORAGE_ENABLE,
                serde_json::json!({}),
            )
            .await
            .map_err(|e| map_inject_error("DOMStorage.enable", e))?;
        self.enabled.store(true, Ordering::Relaxed);
        Ok(())
    }
}

#[async_trait]
impl LocalStorageChannel for SessionLocalStorageChannel {
    async fn add_init_script(&self, source: &str) -> Result<(), StorageStateError> {
        self.session
            .send_page::<serde_json::Value>(
                &self.session_id,
                PAGE_ADD_SCRIPT_TO_EVALUATE_ON_NEW_DOCUMENT,
                AddScriptToEvaluateOnNewDocumentParams {
                    source: source.to_string(),
                    world_name: None,
                },
            )
            .await
            .map_err(|e| map_inject_error("Page.addScriptToEvaluateOnNewDocument", e))?;
        Ok(())
    }

    async fn set_dom_storage_item(
        &self,
        security_origin: &str,
        key: &str,
        value: &str,
    ) -> Result<(), StorageStateError> {
        self.ensure_enabled().await?;
        self.session
            .send_page::<serde_json::Value>(
                &self.session_id,
                DOM_STORAGE_SET_DOM_STORAGE_ITEM,
                SetDOMStorageItemParams {
                    storage_id: StorageId {
                        security_origin: security_origin.to_string(),
                        is_local_storage: true,
                    },
                    key: key.to_string(),
                    value: value.to_string(),
                },
            )
            .await
            .map_err(|e| map_inject_error("DOMStorage.setDOMStorageItem", e))?;
        Ok(())
    }

    async fn get_dom_storage_items(
        &self,
        security_origin: &str,
    ) -> Result<Vec<(String, String)>, StorageStateError> {
        self.ensure_enabled().await?;
        let result: GetDOMStorageItemsResult = self
            .session
            .send_page(
                &self.session_id,
                DOM_STORAGE_GET_DOM_STORAGE_ITEMS,
                GetDOMStorageItemsParams {
                    storage_id: StorageId {
                        security_origin: security_origin.to_string(),
                        is_local_storage: true,
                    },
                },
            )
            .await
            .map_err(|e| map_inject_error("DOMStorage.getDOMStorageItems", e))?;
        Ok(result
            .entries
            .into_iter()
            .filter_map(|pair| {
                if pair.len() == 2 {
                    Some((pair[0].clone(), pair[1].clone()))
                } else {
                    None
                }
            })
            .collect())
    }
}

/// CdpError → StorageStateError 映射（注入/读取命令面）。
fn map_inject_error(method: &str, err: crate::cdp::error::CdpError) -> StorageStateError {
    StorageStateError::Inject {
        method: method.to_string(),
        message: err.to_string(),
    }
}

/// 注入执行统计（审计面：数量脱敏，不含任何值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InjectStats {
    /// 已注册 origin 守卫恢复脚本数。
    pub scripts: usize,
    /// 已直写 localStorage 条目数。
    pub items: usize,
}

/// localStorage 注入执行（§5.3）：两机制互补——
///
/// ① `Page.addScriptToEvaluateOnNewDocument` 注册 origin 守卫恢复脚本：作用于
///    未来文档，页面脚本执行前恢复（主题/首屏状态无闪变），脚本内校验
///    `window.location.origin` 防跨站污染；
/// ② `DOMStorage.setDOMStorageItem` 直写当前页：立即生效，无需重载；storageId
///    securityOrigin 按 origin 守卫校验（防御性再检，拒绝非法 origin——
///    不在任何 CDP 命令前放行）。
///
/// 取舍说明：仅 ① → 已加载页面缺失恢复值（须重载才生效）；仅 ② → 页面自身
/// 初始化逻辑先于注入执行（恢复语义后置，主题/首屏闪变）。两机制互补覆盖
/// 「当前页立即生效 + 后续导航依旧保持」。重复导入为覆盖语义（直写同键覆盖；
/// 脚本按注册序后执行者胜），无错误累积。
pub async fn inject_origin_scripts(
    channel: &dyn LocalStorageChannel,
    plan: &ImportPlan,
) -> Result<InjectStats, StorageStateError> {
    let mut scripts = 0usize;
    let mut items = 0usize;
    for script in &plan.origin_scripts {
        validate_origin(&script.origin).map_err(|reason| StorageStateError::InvalidOrigin {
            origin: script.origin.clone(),
            reason,
        })?;
        channel.add_init_script(&script.source).await?;
        scripts += 1;
        for item in &script.items {
            channel
                .set_dom_storage_item(&script.origin, &item.name, &item.value)
                .await?;
            items += 1;
        }
    }
    Ok(InjectStats { scripts, items })
}

/// 导出侧 origins 聚合（§5.2 可选通道）：`DOMStorage.getDOMStorageItems` 按
/// origin 读取 localStorage → `origins[]`；origin 守卫：非法 origin 在发出
/// 读取命令前拒绝（`InvalidOrigin`）。
pub async fn collect_local_storage(
    channel: &dyn LocalStorageChannel,
    origins: &[String],
) -> Result<Vec<StorageOrigin>, StorageStateError> {
    let mut out = Vec::new();
    for origin in origins {
        validate_origin(origin).map_err(|reason| StorageStateError::InvalidOrigin {
            origin: origin.clone(),
            reason,
        })?;
        let entries = channel.get_dom_storage_items(origin).await?;
        out.push(StorageOrigin {
            origin: normalize_origin(origin).to_string(),
            local_storage: entries
                .into_iter()
                .map(|(name, value)| StorageItem { name, value })
                .collect(),
        });
    }
    Ok(out)
}

/// 导出（§5.2 扩展面）：cookie 面同 [`export_storage_state`]（显式授权 +
/// 内存传递）；origins 面经 `DOMStorage.getDOMStorageItems` 聚合（带守卫）。
/// 授权拒绝发生在任何 CDP 命令之前。
pub async fn export_storage_state_with_origins(
    cookies: &[CdpCookie],
    origins: &[String],
    auth: ExportAuthorization,
    channel: &dyn LocalStorageChannel,
) -> Result<StorageState, StorageStateError> {
    if auth == ExportAuthorization::Denied {
        return Err(StorageStateError::NotAuthorized);
    }
    let mut state = StorageState::from_cdp_cookies(cookies);
    state.origins = collect_local_storage(channel, origins).await?;
    Ok(state)
}

/// 由 cookie domain 推导导出 origins 清单（§5.2 导出聚合的 origin 来源）：
/// 每个唯一 host 一个 origin——协议取 https（该 host 存在 secure cookie 时）
/// 否则 http（secure cookie 仅出现在 https 页面，纯非 secure cookie 多为
/// http 本地开发面，按此判定可对齐 localStorage 实际存放 origin）；
/// 前导点去除（domain cookie）；无法构成合法 http(s) origin 的 host 跳过
/// （与读取前 origin 守卫同一 [`validate_origin`] 口径，防异常 domain 污染
/// localStorage 跨站读取面）。输出按字典序保证确定性（HashMap 无序遍历
/// 不得泄漏到 JSON 形状）。空 cookie 列表 → 空 origins。
pub fn export_origins_from_cookies(cookies: &[CdpCookie]) -> Vec<String> {
    let mut by_host: HashMap<String, bool> = HashMap::new();
    for c in cookies {
        let host = c.domain.trim_start_matches('.');
        let secure = by_host.entry(host.to_string()).or_insert(false);
        *secure = *secure || c.secure;
    }
    let mut origins: Vec<String> = by_host
        .into_iter()
        .filter_map(|(host, secure)| {
            let scheme = if secure { "https" } else { "http" };
            let origin = format!("{scheme}://{host}");
            if validate_origin(&origin).is_ok() {
                Some(origin)
            } else {
                None
            }
        })
        .collect();
    origins.sort();
    origins
}
