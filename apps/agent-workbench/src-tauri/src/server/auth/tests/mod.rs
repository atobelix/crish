//! server::auth 单元测试（自 server/auth.rs 内联 `mod tests` 原样搬迁，按主题分文件）

// 测试临时目录清理豁免（clippy.toml 豁免面：测试代码临时目录清理，
// 非产品删除路径，mod 级 allow + 理由——产品删除走 conex-fs trash）
#![allow(clippy::disallowed_methods)]
use super::*;
use std::fs;
use std::path::PathBuf;

mod nonce_hmac;
mod token;

/// 独立临时文件路径（进程 id + 计数器保证测试互不干扰）
fn temp_file(tag: &str) -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "crish-md-test-{}-{tag}-{n}.json",
        std::process::id()
    ))
}
