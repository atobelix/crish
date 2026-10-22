//! 错误码元信息注册表：按错误码域分文件登记，插入顺序与拆分前完全一致
//! （agent_runtime → tool → infra，各文件内部保持原相对顺序）。

use super::CrishErrorInfo;
use once_cell::sync::Lazy;
use std::collections::HashMap;

mod agent_runtime;
mod infra;
mod tool;

/// 错误码元信息注册表（TS 端 CRISH_ERROR_REGISTRY 同构，102 条）
pub(super) static CRISH_ERROR_REGISTRY: Lazy<HashMap<&'static str, CrishErrorInfo>> =
    Lazy::new(|| {
        let mut m = HashMap::with_capacity(102);
        agent_runtime::register(&mut m);
        tool::register(&mut m);
        infra::register(&mut m);
        m
    });
