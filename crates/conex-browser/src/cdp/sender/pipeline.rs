//! 五段管线唯一插桩点 CommandSender::execute，以及在途幂等合并表与守卫。

use super::{
    AuditPhase, BrowserAuditEvent, CdpCommandView, Command, CommandChannel, CommandPolicyHooks,
    IdKey,
};
use crate::cdp::error::{CancelReason, CdpError};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// 在途幂等合并表（IdKey → 结果广播；并发同键共享同一 pending）。
type InFlightMap =
    Arc<std::sync::Mutex<HashMap<IdKey, tokio::sync::broadcast::Sender<Result<Value, CdpError>>>>>;

/// 在途幂等守卫：结果发布 + 完成/取消时从合并表移除（Drop 同步清理）。
struct InFlightGuard {
    map: InFlightMap,
    key: IdKey,
    tx: tokio::sync::broadcast::Sender<Result<Value, CdpError>>,
    /// true = 尚未发布结果（Drop 时发布 Cancelled）
    armed: bool,
}

impl InFlightGuard {
    fn publish(&mut self, result: Result<Value, CdpError>) {
        // 合并等待方可能已全部放弃（超时/取消），无订阅者即无人接收——
        // 不构成命令失败（真实结果已由本次调用返回给主调用方），仅 debug。
        if let Err(err) = self.tx.send(result) {
            tracing::debug!("在途结果无等待方（丢弃）：{err}");
        }
        self.armed = false;
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        // 中途退出（急停/审批拒绝/取消）：合并等待方收到取消错误
        if self.armed {
            if let Err(err) = self.tx.send(Err(CdpError::Cancelled {
                reason: CancelReason::Aborted,
            })) {
                tracing::debug!("取消结果无等待方（丢弃）：{err}");
            }
        }
        if let Ok(mut map) = self.map.lock() {
            map.remove(&self.key);
        }
    }
}

/// 统一发送层（五段管线唯一插桩点）。
pub struct CommandSender {
    channel: Arc<dyn CommandChannel>,
    hooks: Arc<dyn CommandPolicyHooks>,
    in_flight: InFlightMap,
}

impl CommandSender {
    pub fn new(channel: Arc<dyn CommandChannel>, hooks: Arc<dyn CommandPolicyHooks>) -> Self {
        CommandSender {
            channel,
            hooks,
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// attach 会话面装配自检（R-12，39-E3）：hooks 是否已注入只读能力集
    /// （`attach_caps() != None`）。[AttachCdpProxy::bind] 前置校验用——接线不完整
    /// （未注入能力集）时拒绝启动，防止「代理已挂载但拦截未生效」的静默安全漏洞。
    pub fn has_attach_caps(&self) -> bool {
        self.hooks.attach_caps().is_some()
    }
    /// 五段管线执行（能力集→幂等→急停→审批→审计→传输→审计）。
    pub async fn execute(&self, cmd: Command) -> Result<Value, CdpError> {
        // —— ⓪ 会话只读能力集（R-12）：attach 会话白名单检查（fail-closed，
        //    先于一切阶段——非白名单命令不进入幂等合并/缓存/审批，拒绝不可豁免）——
        if let Some(caps) = self.hooks.attach_caps() {
            if !caps.allows_command(&cmd.method) {
                let view = CdpCommandView {
                    method: cmd.method.clone(),
                    session: cmd.session_id.clone().unwrap_or_default(),
                    target_summary: cmd.summary.clone(),
                    dangerous: cmd.dangerous,
                };
                // Blocked 相位：门禁拦截语义（维度 17 接线，含 attach 能力集拦截面）
                self.hooks.audit(BrowserAuditEvent {
                    phase: AuditPhase::Blocked,
                    cmd: view,
                    ok: false,
                    duration_ms: None,
                    snapshot_version: 0,
                });
                return Err(CdpError::CapabilityDenied { method: cmd.method });
            }
        }

        // —— ① 幂等：在途合并（同键并发共享同一 pending，仅一次 WS 发送）——
        let mut guard = None;
        if let Some(key) = cmd.idempotency_key.clone() {
            let existing = self
                .in_flight
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&key)
                .cloned();
            match existing {
                Some(tx) => {
                    // 已在途：共享结果，不再发送
                    let mut rx = tx.subscribe();
                    return rx.recv().await.unwrap_or_else(|_| {
                        Err(CdpError::Internal {
                            method: Some(cmd.method.clone()),
                            message: "幂等合并通道关闭".to_string(),
                        })
                    });
                }
                None => {
                    let (tx, _) = tokio::sync::broadcast::channel(1);
                    self.in_flight
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .insert(key.clone(), tx.clone());
                    guard = Some(InFlightGuard {
                        map: self.in_flight.clone(),
                        key,
                        tx,
                        armed: true,
                    });
                }
            }
        }

        // —— ①' 幂等：工具层短路（已完成命令缓存，agent-tools idempotency 语义）——
        if let Some(key) = &cmd.idempotency_key {
            if let Some(result) = self.hooks.idempotent(key).await {
                // H3 修复：命中时先把结果发布给在途合并等待方，再返回——
                // 否则 guard Drop（armed=true）会向共享 broadcast 发布 Cancelled，
                // 并发同键调用方拿到错误的取消语义而非正确缓存结果。
                if let Some(g) = guard.as_mut() {
                    g.publish(result.clone());
                }
                return result;
            }
        }

        // —— ② 急停：置位即拒绝新命令 ——
        if self.hooks.emergency_stop().load(Ordering::SeqCst) {
            let err = Err(CdpError::Cancelled {
                reason: CancelReason::EmergencyStop,
            });
            if let Some(g) = guard.as_mut() {
                g.publish(err.clone());
            }
            return err;
        }

        let view = CdpCommandView {
            method: cmd.method.clone(),
            session: cmd.session_id.clone().unwrap_or_default(),
            target_summary: cmd.summary.clone(),
            dangerous: cmd.dangerous,
        };

        // —— ③ 审批：dangerous 命令挂起等决 ——
        if cmd.dangerous {
            if let Err(denied) = self.hooks.approve(&view).await {
                self.hooks.audit(BrowserAuditEvent {
                    phase: AuditPhase::Denied,
                    cmd: view,
                    ok: false,
                    duration_ms: None,
                    snapshot_version: 0,
                });
                let err = Err(CdpError::ApprovalDenied {
                    reason: denied.reason,
                });
                if let Some(g) = guard.as_mut() {
                    g.publish(err.clone());
                }
                return err;
            }
        }

        // —— ④ 审计（before）——
        self.hooks.audit(BrowserAuditEvent {
            phase: AuditPhase::Before,
            cmd: view.clone(),
            ok: true,
            duration_ms: None,
            snapshot_version: 0,
        });

        // —— ⑤ 传输 + 超时 + abort 抢断（§2.5 并发管理 + §2.3 超时）——
        let started = Instant::now();
        let token = self.hooks.abort_token();
        let send = self.channel.send_command(
            &cmd.method,
            Some(cmd.params),
            cmd.session_id.as_deref(),
            cmd.timeout,
        );
        let result = tokio::select! {
            r = send => r,
            _ = token.cancelled() => Err(CdpError::Cancelled {
                reason: CancelReason::Aborted,
            }),
        };

        // 发布合并结果（在途等待方共享同一结果）
        if let Some(g) = guard.as_mut() {
            g.publish(result.clone());
        }

        // —— ⑥ 审计（after）——
        self.hooks.audit(BrowserAuditEvent {
            phase: AuditPhase::After,
            cmd: view,
            ok: result.is_ok(),
            duration_ms: Some(started.elapsed().as_millis() as u64),
            snapshot_version: 0,
        });

        result
    }
}
