//! 错误码元信息唯一声明表。
//!
//! 每个域文件以 `error_catalog_table!` 宏声明条目；宏展开为静态 `ENTRIES`。
//! 码字符串真源是 [`crate::error::codes`]，本目录只声明 title / category /
//! retryable / public / action 元信息，不再手写 `HashMap` 插入样板。

use super::CrishErrorInfo;
use once_cell::sync::Lazy;
use std::collections::HashMap;

mod agent_runtime;
mod infra;
mod tool;

/// 声明顺序：agent_runtime → tool → infra（与拆分前注册表插入顺序一致）。
pub(super) fn entries() -> impl Iterator<Item = &'static CrishErrorInfo> {
    agent_runtime::ENTRIES
        .iter()
        .chain(tool::ENTRIES)
        .chain(infra::ENTRIES)
}

/// 错误码元信息注册表（TS 端 CRISH_ERROR_REGISTRY 同构）。
pub(super) static CRISH_ERROR_REGISTRY: Lazy<HashMap<&'static str, CrishErrorInfo>> =
    Lazy::new(|| {
        let entries: Vec<&'static CrishErrorInfo> = entries().collect();
        let mut m = HashMap::with_capacity(entries.len());
        for entry in entries {
            m.insert(entry.code, entry.clone());
        }
        m
    });
