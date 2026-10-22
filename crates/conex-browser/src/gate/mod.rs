//! 域名门禁正式实现（维度 17 §4，R-7/R-11 接线位）
//!
//! **权威声明（R-7）**：`DomainGate` 结构与匹配语义以维度 17 §4 为全项目唯一权威；
//! 本模块即该权威的**正式实现**（M7 接线位，`conex-browser/src/gate/`），
//! 补齐 browser-tools `MvpDomainGate` 模块头登记的未接线面：
//! ① 60s DNS 重绑定窗口重复校验（§4.3 步骤 4，R-11）；
//! ② 传输层 `Network.setBlockedURLs`（§4.3 传输层，R-11）。
//!
//! 结构（17 §4.2 文档结构 DomainGate ↔ 本模块 `FormalDomainGate`，命名避让既有 trait）：
//! - 匹配语义（§4.2 定死）：`example.com` = 根域 + 任意子域；`*.example.com` =
//!   任意子域（不含根域）；`*`/`**` = 任意；IP 字面量可入白/黑名单；
//!   TLD 通配（`example.*`）配置期拒绝；黑名单命中不可豁免（含 full-access）；
//! - 判定流程（§4.3）：scheme 门禁 → IP 字面量段表（不触发 DNS）→
//!   主机名解析级校验（fail-closed）→ 60s 重绑定窗口每动作复查；
//! - 传输层（§4.3 传输层，R-11）：[`blocked_urls`] 段表程序化生成
//!   （保留/内网段 + 云元数据 `169.254.169.254` + 链路本地），
//!   [`TransportGate`] 经 [`SetBlockedSender`] 下发 + iframe 导航订阅兜底重挂。

mod check;
pub mod formal;
pub(crate) mod pattern;
pub mod segments;
pub mod transport;
pub mod types;

#[cfg(test)]
mod tests;

pub use formal::FormalDomainGate;
pub use transport::{SetBlockedSender, TransportGate, blocked_urls};
pub use types::{GateClock, HostResolver, REBINDING_WINDOW, SystemClock, SystemResolver};
