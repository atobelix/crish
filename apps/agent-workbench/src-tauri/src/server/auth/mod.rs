//! 令牌哈希存储与 Bearer 鉴权（D2 §7：SHA-256 哈希落 pairing.json）
//!
//! - **签发**：32 字节 CSPRNG → hex 64 字符令牌（明文只返回客户端一次）；
//!   落盘只存 SHA-256 哈希（`config_dir()/pairing.json`，D2 §7.3 形状）
//!   ——文件泄露 ≠ 令牌泄露；
//! - **校验**：`Authorization: Bearer <token>` → SHA-256 → 常量时间比较
//!   + revoked 检查（axum 中间件 [require_bearer_token]；校验失败 → 401）；
//! - **持久化**：原子写（tmp + rename，对齐 `config/persistence.rs` 先例）；
//!   权限位（Unix 0600 / Windows ACL 收紧）与撤销全链归 R1-07。

mod hmac;
mod middleware;
mod nonce;
mod token;

pub use hmac::*;
pub use middleware::{require_bearer_token, require_signed_request};
pub use nonce::*;
pub use token::*;

/// 令牌原始字节数（D2 §7.2：32 字节 CSPRNG，hex 64 字符）
// R1-02 备注：R1-07 配对签发消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub const TOKEN_BYTES: usize = 32;
/// pairing.json 结构版本
// R1-02 备注：R1-07 撤销全链消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub const PAIRING_FILE_VERSION: u32 = 1;

/// 默认 Nonce 容量上限（LRU 驱逐）
pub const DEFAULT_NONCE_CAPACITY: usize = 10_000;
/// 默认时钟偏移容忍阈值（300 秒 = 5 分钟）
pub const DEFAULT_CLOCK_SKEW_MS: u64 = 300_000;
/// 全局时钟透传 Header 名
pub const SERVER_TIME_HEADER: &str = "X-Server-Time-Ms";

#[cfg(test)]
mod tests;
