//! 统一发送层（维度 11 §4：五段管线 幂等→急停→审批→审计→传输）
//!
//! ```text
//! execute(cmd) ──▶ ⓪ 能力集 ① 幂等  ② 急停  ③ 审批  ④ 审计(before)  ⑤ 传输+超时  ⑥ 审计(after)
//! ```
//!
//! - 插桩点 = 唯一函数 `CommandSender::execute`，无旁路（send_page/send_browser
//!   均构造 Command 走本管线；恢复期 enable 序列属引擎内部流程，直连低层 client）
//! - ⓪ 能力集（R-12）：attach 会话只读白名单检查（`CommandPolicyHooks::attach_caps`
//!   注入，默认 None = 不启用）——fail-closed，先于幂等/审批一切阶段，拒绝返回
//!   `CdpError::CapabilityDenied` + Blocked 审计，不可审批豁免（17 §2.3 红线同级）
//! - **attach 会话面**（39-E3，R-12 接线）：[AttachCdpProxy]——引擎侧 CDP 会话面
//!   （WS 服务端，loopback 随机端口）。外部浏览器类 MCP（chrome-devtools-mcp 族）
//!   经 `--browserUrl` 指向本会话面而非直连受管实例端点：命令逐条经
//!   [CommandSender::execute] 五段管线（⓪ 能力集拦截在真实连接路径生效），事件经
//!   [ReadonlyCaps::filter_events] 只透传白名单事件。**挂载自检**：bind 前置校验
//!   [CommandSender::has_attach_caps]（hooks 未注入能力集 = 接线不完整 → 拒绝启动，
//!   防「代理已挂载但拦截未生效」的静默安全漏洞）
//! - 幂等：sender 层在途合并（同 IdKey 并发共享同一 pending，仅一次 WS 发送）+
//!   工具层 `hooks::idempotent` 短路（已完成命令缓存）
//! - 急停：`emergency_stop` 旗置位 → 新命令拒绝；`abort_token` 取消在途
//! - 审批：`dangerous == true` 挂起等 `approve`；Deny → 审计(Denied) + 拒绝不发送
//! - 审计：before（method/session/目标摘要，参数已脱敏）/ after（结果 + 耗时）
//! - `CancellationToken`：watch<bool> 自研 30 行实现（workspace 无 tokio-util
//!   直接依赖，零新增依赖；§4.2 注释口径）
//! - `CommandChannel`：发送通道抽象（transport 实现；测试可注入直连 client）

use crate::cdp::error::CdpError;
use crate::cdp::session_caps::ReadonlyCaps;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

mod attach_proxy;
mod channel;
mod pipeline;

pub use attach_proxy::AttachCdpProxy;
pub use channel::{Command, CommandChannel};
pub use pipeline::CommandSender;

/// 常规命令默认超时（§2.3 常规命令 30s，agent-browser 同款）。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// 幂等键（session+method+params hash；Eq+Hash 供在途合并表）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IdKey {
    pub session: Option<String>,
    pub method: String,
    pub params_hash: u64,
}

impl IdKey {
    pub fn new(session: Option<String>, method: impl Into<String>, params: &Value) -> Self {
        IdKey {
            session,
            method: method.into(),
            params_hash: hash_params(params),
        }
    }
}

/// 参数确定性 hash（FNV-1a over 紧凑 JSON 字节；跨调用稳定，防碰撞余量足够）。
fn hash_params(params: &Value) -> u64 {
    let bytes = params.to_string().into_bytes();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 审计阶段（§4.2 BrowserAuditEvent.phase）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditPhase {
    /// 发送前（含目标摘要）
    Before,
    /// 发送后（结果摘要 + 耗时）
    After,
    /// 审批拒绝（未发送）
    Denied,
    /// 门禁拦截（window.open 域名门禁等，维度 17 接线）
    Blocked,
}

/// 审批/审计视图（参数已脱敏：target_summary 为 url/节点摘要，敏感字段 [REDACTED]）。
#[derive(Debug, Clone)]
pub struct CdpCommandView {
    pub method: String,
    pub session: String,
    pub target_summary: String,
    pub dangerous: bool,
}

/// 审计事件（before/after 两相 + 拒绝/拦截）。
#[derive(Debug, Clone)]
pub struct BrowserAuditEvent {
    pub phase: AuditPhase,
    pub cmd: CdpCommandView,
    pub ok: bool,
    pub duration_ms: Option<u64>,
    /// 动作基于的页面版本（事后还原，13 文档 §4；本层不持有跟踪器，由引擎侧回填）
    pub snapshot_version: u64,
}

/// 审批拒绝（理由进审计与错误面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDenied {
    pub reason: String,
}

/// 发送层策略钩子。conex-browser 不依赖 agent-tools：本 trait 在核心侧定义，
/// 引擎侧（conex-browser-tools）用 agent-tools 的审批/审计设施实现并注入（评审乙 §2.11）。
#[async_trait]
pub trait CommandPolicyHooks: Send + Sync {
    /// 幂等判定：返回已有结果则短路（None = 继续发送；在途合并由 sender 层处理）
    async fn idempotent(&self, key: &IdKey) -> Option<Result<Value, CdpError>>;
    /// 审批：Ok(()) = 放行；Err(Deny{reason}) = 拒绝（审计由实现方负责发射）
    async fn approve(&self, cmd: &CdpCommandView) -> Result<(), ApprovalDenied>;
    /// 审计发射（before/after/denied/blocked 四相）
    fn audit(&self, event: BrowserAuditEvent);
    /// 急停旗（共享 AtomicBool，全局急停按钮/快捷键置位，§4.1 ②）
    fn emergency_stop(&self) -> Arc<AtomicBool>;
    /// abort 令牌（用户接管/急停时触发；取消全部在途命令）
    fn abort_token(&self) -> CancellationToken;
    /// 会话只读能力集（R-12，34 §5.2 E-3）：attach 会话由引擎侧注入，
    /// 非白名单命令 fail-closed 拒绝（先于幂等/审批一切阶段，不可审批豁免）。
    /// **默认 None = 不启用**——正常 browser_* 工具面（无 attach 会话）不受影响。
    fn attach_caps(&self) -> Option<Arc<ReadonlyCaps>> {
        None
    }
}

/// 取消令牌：watch<bool> 自研实现（30 行，零新增依赖；§4.2 注释口径：
/// tokio_util 若 workspace 已有则复用，否则自研——本仓库未直接依赖 tokio-util）。
#[derive(Clone)]
pub struct CancellationToken {
    tx: Arc<tokio::sync::watch::Sender<bool>>,
    /// 保活接收端：`watch::Sender::send` 在**无任何接收者**时返回 Err 且不更新值
    /// （tokio 1.x 实测，2026-08-09）——令牌必须自持一个接收端，`cancel()` 才生效；
    /// 否则无订阅者场景（如维度 14 动作层 abort 检查）下取消是静默空操作。
    _rx: Arc<tokio::sync::watch::Receiver<bool>>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(false);
        CancellationToken {
            tx: Arc::new(tx),
            _rx: Arc::new(rx),
        }
    }

    /// 触发取消（幂等）。
    pub fn cancel(&self) {
        // 令牌自身持有接收端（`_rx`），send 正常不可能失败；若失败说明
        // 不变量被破坏，必须留痕（否则取消静默失效 → 在途命令永不返回）。
        if let Err(err) = self.tx.send(true) {
            tracing::warn!("取消信号发送失败（令牌接收端缺失，取消可能失效）：{err}");
        }
    }

    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }

    /// 等待取消（在途命令取消路径）。
    pub async fn cancelled(&self) {
        let mut rx = self.tx.subscribe();
        // 已取消则立即返回
        if *rx.borrow() {
            return;
        }
        // 发送端已释放（令牌被 Drop）→ 不会再有取消信号；按「已取消」返回是
        // 既有语义，但必须留痕，避免与「真的收到取消」混淆。
        if let Err(err) = rx.changed().await {
            tracing::debug!("取消等待：令牌已释放（按已取消返回）：{err}");
        }
    }
}

#[cfg(test)]
mod tests;
