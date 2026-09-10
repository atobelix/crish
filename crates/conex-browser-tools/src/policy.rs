//! 发送层策略钩子 MVP 实现（27 接线方案 §2.4 D-D：AllowAllPolicy）
//!
//! `CommandPolicyHooks`（conex-browser/cdp/sender.rs:102-113）五钩子的
//! MVP 形态——**单一判定点纪律**（17 §2.2）：命令级审批与审计出站由工具层
//! 既有设施承担（dangerous + PermissionMode 三态 + AskChannel / SecurityAuditSink），
//! 发送层不重复拦截、不双份记账：
//!
//! - `idempotent` → `None`（不短路：在途合并由 sender 层处理）；
//! - `approve` → `Ok(())`（CDP 命令级审批放行；审批判定点唯一在工具层执行器）；
//! - `audit` → tracing 占位（M-4 审计出站接线 P1；脱敏纪律不落敏感值）；
//! - `emergency_stop` / `abort_token` → **真实信号源**（27 §2.5 M-2 桥）：
//!   引擎注入共享 `Arc<AtomicBool>`（急停旗）与 `CancellationToken`（在途
//!   命令逐 id 取消）；令牌按启动/run 周期经 [AllowAllPolicy::reset] 换新——
//!   新周期不继承上一周期的取消态（防跨 run 毒化会话），急停旗随复位清零。
//!
//! 消费方：引擎侧 `BrowserSlot` 在 `BrowserSession::connect` 时注入
//! `Arc<AllowAllPolicy>`（27 §2.4 连接注入点）。

use conex_browser::cdp::error::CdpError;
use conex_browser::cdp::sender::{
    ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, CommandPolicyHooks, IdKey,
};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 发送层策略 MVP 实现（approve 放行 + 审计占位 + 真实急停信号源）。
pub struct AllowAllPolicy {
    /// 急停旗（共享 AtomicBool；sender 层置位后**新命令**拒绝，§4.1 ②）。
    /// 与 abort 令牌同周期：reset 时复位，防跨周期毒化。
    emergency_stop: Arc<AtomicBool>,
    /// 当前周期 abort 令牌（在途命令逐 id 取消；reset 换新）。
    abort: Mutex<CancellationToken>,
}

impl AllowAllPolicy {
    /// 构造（引擎在 connect 时注入共享急停旗与当前周期令牌）。
    pub fn new(emergency_stop: Arc<AtomicBool>, abort: CancellationToken) -> Self {
        AllowAllPolicy {
            emergency_stop,
            abort: Mutex::new(abort),
        }
    }

    /// 换新令牌 + 复位急停旗（每启动/run 周期调用：新周期从干净状态开始）。
    pub fn reset(&self, token: CancellationToken) {
        *self.abort.lock().unwrap_or_else(|p| p.into_inner()) = token;
        self.emergency_stop.store(false, Ordering::SeqCst);
    }

    /// 当前周期令牌（引擎侧取消/测试断言用）。
    pub fn abort_token(&self) -> CancellationToken {
        self.abort.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// 急停旗（引擎侧置位/测试断言用）。
    pub fn emergency_stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.emergency_stop)
    }
}

#[async_trait::async_trait]
impl CommandPolicyHooks for AllowAllPolicy {
    /// 不短路：在途合并由 sender 层幂等表承担，已完成命令缓存留工具层。
    async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
        None
    }

    /// CDP 命令级审批放行（17 §2.2 单一判定点：权限面在工具层执行器）。
    async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
        Ok(())
    }

    /// 审计出站占位（M-4 P1 接线；tracing 调试通道，脱敏纪律不落敏感值）。
    fn audit(&self, event: BrowserAuditEvent) {
        tracing::debug!(
            phase = ?event.phase,
            method = %event.cmd.method,
            session = %event.cmd.session,
            ok = event.ok,
            "CDP 审计占位（M-4 出站接线 P1）"
        );
    }

    fn emergency_stop(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.emergency_stop)
    }

    fn abort_token(&self) -> CancellationToken {
        self.abort_token()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_browser::cdp::sender::{Command, CommandChannel, CommandSender};
    use std::time::Duration;

    /// 记录型通道：记录命令并回包（dangerous 命令断言放行与否的核心）；
    /// `hang = true` 时命令永不回包（在途取消断言用）。
    struct FakeChannel {
        sent: Arc<Mutex<Vec<String>>>,
        hang: bool,
    }

    #[async_trait::async_trait]
    impl CommandChannel for FakeChannel {
        async fn send_command(
            &self,
            method: &str,
            _params: Option<Value>,
            _session_id: Option<&str>,
            _timeout: Duration,
        ) -> Result<Value, CdpError> {
            self.sent
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(method.to_string());
            if self.hang {
                std::future::pending::<()>().await;
            }
            Ok(Value::Null)
        }
        async fn send_command_no_wait(
            &self,
            method: &str,
            _params: Option<Value>,
            _session_id: Option<&str>,
        ) -> Result<(), CdpError> {
            self.sent
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(method.to_string());
            if self.hang {
                std::future::pending::<()>().await;
            }
            Ok(())
        }
        fn is_ready(&self) -> bool {
            true
        }
    }

    fn setup() -> (
        Arc<AllowAllPolicy>,
        Arc<FakeChannel>,
        Arc<Mutex<Vec<String>>>,
    ) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let policy = Arc::new(AllowAllPolicy::new(
            Arc::new(AtomicBool::new(false)),
            CancellationToken::new(),
        ));
        let channel = Arc::new(FakeChannel {
            sent: Arc::clone(&sent),
            hang: false,
        });
        (policy, channel, sent)
    }

    /// 组装 sender（命令面全过统一发送层）。
    fn sender(policy: Arc<AllowAllPolicy>, channel: Arc<FakeChannel>) -> CommandSender {
        CommandSender::new(channel, policy)
    }

    /// T-核心：dangerous 命令 approve 放行（无 ApprovalDenied）+ 命令到达通道。
    #[tokio::test]
    async fn approve_allows_dangerous_commands() {
        let (policy, channel, sent) = setup();
        let sender = sender(policy, channel);
        let out = sender
            .execute(
                Command::new("Input.insertText")
                    .params(serde_json::json!({ "text": "x" }))
                    .dangerous(),
            )
            .await;
        assert!(out.is_ok(), "dangerous 命令应被放行：{out:?}");
        assert_eq!(sent.lock().unwrap_or_else(|p| p.into_inner()).len(), 1);
    }

    /// idempotent 不短路：带幂等键的命令仍真实发送（None 语义）。
    #[tokio::test]
    async fn idempotent_never_short_circuits() {
        let (policy, channel, sent) = setup();
        let sender = sender(policy, channel);
        let key = IdKey::new(
            None,
            "Page.navigate",
            &serde_json::json!({ "url": "https://e.com" }),
        );
        let out = sender
            .execute(
                Command::new("Page.navigate")
                    .params(serde_json::json!({ "url": "https://e.com" }))
                    .idempotent(key),
            )
            .await;
        assert!(out.is_ok());
        assert_eq!(sent.lock().unwrap_or_else(|p| p.into_inner()).len(), 1);
    }

    /// 急停旗置位 → 新命令拒绝（EmergencyStop）且零发送（sender 层 §4.1 ②）。
    #[tokio::test]
    async fn emergency_stop_flag_rejects_new_commands() {
        let (policy, channel, sent) = setup();
        policy.emergency_stop().store(true, Ordering::SeqCst);
        let sender = sender(policy, channel);
        let err = sender
            .execute(Command::new("Page.navigate").params(serde_json::json!({ "url": "x" })))
            .await
            .expect_err("急停应拒绝新命令");
        assert!(matches!(
            err,
            CdpError::Cancelled {
                reason: conex_browser::cdp::error::CancelReason::EmergencyStop
            }
        ));
        assert!(sent.lock().unwrap_or_else(|p| p.into_inner()).is_empty());
    }

    /// abort 令牌取消在途命令（sender 层 select 抢断，CdpError::Cancelled）。
    #[tokio::test]
    async fn abort_token_cancels_inflight() {
        let (policy, channel, _sent) = setup();
        // 挂起通道：命令永不回包，直到令牌取消（在途取消断言）
        let hang_channel = Arc::new(FakeChannel {
            sent: Arc::clone(&channel.sent),
            hang: true,
        });
        let token = policy.abort_token();
        let sender = sender(policy, hang_channel);
        let task = tokio::spawn(async move {
            sender
                .execute(Command::new("Page.navigate").params(serde_json::json!({ "url": "x" })))
                .await
        });
        // 等命令进入传输段（挂起中）
        tokio::time::sleep(Duration::from_millis(50)).await;
        token.cancel();
        let err = task.await.expect("任务失败").expect_err("应被取消");
        assert!(matches!(
            err,
            CdpError::Cancelled {
                reason: conex_browser::cdp::error::CancelReason::Aborted
            }
        ));
    }

    /// reset 换新周期：上一周期取消态不继承（令牌换新 + 急停旗复位）。
    #[test]
    fn reset_opens_fresh_epoch() {
        let (policy, _channel, _sent) = setup();
        let old = policy.abort_token();
        old.cancel();
        policy.emergency_stop().store(true, Ordering::SeqCst);
        assert!(old.is_cancelled());

        policy.reset(CancellationToken::new());
        let fresh = policy.abort_token();
        assert!(!fresh.is_cancelled(), "新周期令牌不得继承取消态");
        assert!(
            !policy.emergency_stop().load(Ordering::SeqCst),
            "急停旗随 reset 复位"
        );
        // 旧令牌的取消不影响新周期
        fresh.cancel();
        assert!(fresh.is_cancelled());
    }
}
