//! 恢复监督任务与重连自动重启（自 session.rs 平移）。

use super::static_ctrl::StaticController;
use super::types::{
    PumpShared, ScreencastConfig, ScreencastError, ScreencastEvent, ScreencastStatus, StatsInner,
};
use crate::cdp::bus::BrowserEvent;
use crate::cdp::domains::names::{PAGE_START_SCREENCAST, PAGE_STOP_SCREENCAST};
use crate::cdp::domains::StartScreencastParams;
use crate::cdp::sender::Command;
use crate::BrowserSession;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, watch};

/// 监督循环上下文（收束 8 参数为结构体，防止参数爆炸）
#[derive(Clone)]
pub(crate) struct ScreencastSupervisorContext {
    pub session: Arc<BrowserSession>,
    pub config: ScreencastConfig,
    pub status_tx: watch::Sender<ScreencastStatus>,
    pub events: broadcast::Sender<ScreencastEvent>,
    pub pump: Arc<Mutex<PumpShared>>,
    pub stats: Arc<StatsInner>,
    pub static_ctrl: Arc<StaticController>,
}

/// 监督循环：ConnectionRestored（R-9-3）→ 激活态自动重启帧流。
pub(crate) async fn supervisor_loop(
    mut bus_rx: broadcast::Receiver<BrowserEvent>,
    ctx: ScreencastSupervisorContext,
) {
    while let Ok(ev) = bus_rx.recv().await {
        if let BrowserEvent::ConnectionRestored { epoch, .. } = ev {
            // 仅激活态需要重启（空闲/停止中不重启；降级模式投影 Active 同样覆盖）
            if *ctx.status_tx.borrow() != ScreencastStatus::Active {
                continue;
            }
            restart_screencast(&ctx, epoch).await;
        }
    }
}

/// 重连自动重启：Starting → 重试 startScreencast → Active（失败回 Idle，
/// 启用静态降级则保持 1fps 轮询——U-3）。
pub(crate) async fn restart_screencast(ctx: &ScreencastSupervisorContext, epoch: u64) {
    // 重启期状态/事件投递：无观察者不改变重启主流程（状态已由 status_tx 持有），
    // 故仅 debug 留痕，不上抛（重启结果由 result 分支决定）。
    if let Err(err) = ctx.status_tx.send(ScreencastStatus::Starting) {
        tracing::debug!("帧流状态无订阅者（丢弃 Starting）：{err}");
    }
    let mut result = Err(ScreencastError::NoActiveSession);
    for attempt in 1..=ctx.config.start_max_attempts {
        // 用户 stop 抢断 → 放弃重启（状态已被停止路径改写）
        if *ctx.status_tx.borrow() != ScreencastStatus::Starting {
            return;
        }
        result = send_start_screencast(&ctx.session, &ctx.config).await;
        if result.is_ok() {
            break;
        }
        if let Err(e) = result.as_ref() {
            tracing::warn!(
                "帧流重启失败（attempt={attempt}/{}）：{}",
                ctx.config.start_max_attempts,
                e
            );
        }
        tokio::time::sleep(ctx.config.start_retry_delay).await;
    }
    match result {
        Ok(()) => {
            if *ctx.status_tx.borrow() != ScreencastStatus::Starting {
                // 停止在命令在途期间抢断：回退刚启动的 screencast
                send_stop_screencast(&ctx.session, &ctx.config).await;
                return;
            }
            ctx.static_ctrl.exit(); // 切回 screencast 泵：先停降级轮询（防双源喂帧）
            let mut shared = ctx.pump.lock().unwrap_or_else(|p| p.into_inner());
            shared.running = true;
            shared.gen += 1; // 泵代数重置：旧 sessionId 序列作废
            drop(shared);
            ctx.stats.restarts.fetch_add(1, Ordering::Relaxed);
            if let Err(err) = ctx.status_tx.send(ScreencastStatus::Active) {
                tracing::debug!("帧流状态无订阅者（丢弃 Active）：{err}");
            }
            if let Err(err) = ctx.events.send(ScreencastEvent::Restarted { epoch }) {
                tracing::debug!("帧流事件无订阅者（丢弃 Restarted）：{err}");
            }
            tracing::info!("帧流已按原配置重启（epoch={epoch}）");
        }
        Err(e) => {
            ctx.pump.lock().unwrap_or_else(|p| p.into_inner()).running = false;
            // U-3 降级：重启失败且启用静态降级 → 保持 1fps 轮询（跨重连持续
            // 供帧——恢复条件取舍：保持降级直到显式 stop/start 重试，或下一次
            // 重连重启成功时切回；不自动反复探测 screencast 可用性）
            if ctx.config.static_fallback_enabled
                && *ctx.status_tx.borrow() == ScreencastStatus::Starting
            {
                ctx.static_ctrl
                    .enter(&format!("startScreencast 重启失败：{e}"));
                if let Err(err) = ctx.status_tx.send(ScreencastStatus::Active) {
                    tracing::debug!("帧流状态无订阅者（丢弃 Active）：{err}");
                }
            } else {
                if let Err(err) = ctx.status_tx.send(ScreencastStatus::Idle) {
                    tracing::debug!("帧流状态无订阅者（丢弃 Idle）：{err}");
                }
                if let Err(err) = ctx.events.send(ScreencastEvent::StartFailed {
                    message: e.to_string(),
                }) {
                    tracing::debug!("帧流事件无订阅者（丢弃 StartFailed）：{err}");
                }
            }
            tracing::warn!("帧流重启失败（重试耗尽），转入降级/Idle：{e}");
        }
    }
}

/// 发送 startScreencast（当前活动标签会话；恢复期无会话 → NoActiveSession）。
pub(crate) async fn send_start_screencast(
    session: &BrowserSession,
    config: &ScreencastConfig,
) -> Result<(), ScreencastError> {
    let sref = session
        .current_session()
        .map_err(|_| ScreencastError::NoActiveSession)?;
    let params = StartScreencastParams {
        format: Some(config.format.clone()),
        quality: Some(config.quality),
        max_width: Some(config.max_width),
        max_height: Some(config.max_height),
        every_nth_frame: Some(config.every_nth_frame),
    };
    session
        .send::<serde_json::Value>(
            Command::new(PAGE_START_SCREENCAST)
                .params(params)
                .with_session(&sref.session)
                .with_timeout(config.command_timeout),
        )
        .await
        .map_err(ScreencastError::Command)?;
    Ok(())
}

/// 发送 stopScreencast（best-effort：无会话/失败均不阻断清理）。
pub(crate) async fn send_stop_screencast(session: &BrowserSession, config: &ScreencastConfig) {
    if let Ok(sref) = session.current_session() {
        // best-effort 停止（不阻断清理）：命令失败仅告警留痕，否则「帧流已停」
        // 与「浏览器侧仍在推帧」无从区分。
        if let Err(e) = session
            .send::<serde_json::Value>(
                Command::new(PAGE_STOP_SCREENCAST)
                    .params(json!({}))
                    .with_session(&sref.session)
                    .with_timeout(config.command_timeout),
            )
            .await
        {
            tracing::warn!("stopScreencast 发送失败（best-effort，忽略）：{e}");
        }
    }
}
