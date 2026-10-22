//! storage_state 导入计划（cookie 注入参数 + origin 守卫脚本）与导出面。

use super::model::{
    normalize_origin, normalize_same_site, origin_guard_script, StorageCookie, StorageItem,
    StorageState,
};
use super::{ExportAuthorization, StorageStateError};
use crate::cdp::domains::{Cookie as CdpCookie, SetCookieParam};
use serde::Serialize;
use std::collections::HashMap;

/// 单个 origin 恢复脚本（注入面元素）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginScript {
    /// 目标 origin（`Page.addScriptToEvaluateOnNewDocument` 关联文档校验用；
    /// `DOMStorage` 直写 storageId.securityOrigin 同源）。
    pub origin: String,
    /// 已含 origin 守卫的注入脚本源码。
    pub source: String,
    /// 直写条目（与守卫脚本同源同序；重复导入为覆盖语义——`setItem` 直写
    /// 天然覆盖，同键多次写入最终值胜，见 [`ImportPlan`] 幂等说明）。
    pub items: Vec<StorageItem>,
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
    /// （会话 cookie `expires: None` 原样透传——类型面由 cdp/domains.rs 提供，
    /// `Option` 字段 None 一律省略而非输出 null：Chrome 151 拒绝 null 字段，
    /// N2 缺陷）。
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
            items: o.local_storage.clone(),
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
