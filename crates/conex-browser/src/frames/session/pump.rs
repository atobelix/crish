//! 帧泵任务与单帧处理（自 session.rs 平移）。

use super::types::{PumpShared, ScreencastConfig, ScreencastEvent, StatsInner};
use crate::cdp::bus::FrameChunk;
use crate::cdp::domains::names::PAGE_SCREENCAST_FRAME_ACK;
use crate::cdp::domains::ScreencastFrameAckParams;
use crate::cdp::sender::Command;
use crate::frames::fps::FpsController;
use crate::frames::sink::{FrameOut, FrameSink};
use crate::BrowserSession;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// 帧泵上下文（泵任务入参聚合，避免超长参数表）。
pub(crate) struct PumpContext {
    pub(crate) frames_rx: tokio::sync::mpsc::Receiver<FrameChunk>,
    pub(crate) shared: Arc<Mutex<PumpShared>>,
    pub(crate) sink: Arc<FrameSink>,
    pub(crate) fps: Arc<FpsController>,
    pub(crate) stats: Arc<StatsInner>,
    pub(crate) session: Arc<BrowserSession>,
    pub(crate) config: ScreencastConfig,
    pub(crate) events: broadcast::Sender<ScreencastEvent>,
}

/// 帧泵主循环：帧通道 → 泵出一帧 → 持住 ack（档位换算）→ ack。
/// 泵任务常驻（跨 start/stop/restart 存活），由代数与 running 开关协作。
pub(crate) async fn pump_loop(mut ctx: PumpContext) {
    let mut gen = 0u64;
    while let Some(chunk) = ctx.frames_rx.recv().await {
        ctx.stats.frames_received.fetch_add(1, Ordering::Relaxed);
        let (running, cur_gen) = {
            let shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
            (shared.running, shared.gen)
        };
        if !running {
            continue; // 停止期帧直接丢弃（不输出不 ack）
        }
        if cur_gen != gen {
            // 代数变化（start/restart）：seq 与去重表清零（旧 sessionId 序列作废）
            gen = cur_gen;
            let mut shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
            shared.seq = 0;
            shared.acked.clear();
        }
        pump_one(&mut ctx, chunk).await;
    }
}

/// 单帧处理：去重 → 输出（丢旧保新）→ 持住 ack → 发送 ack。
async fn pump_one(ctx: &mut PumpContext, chunk: FrameChunk) {
    let seq = {
        let mut shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
        shared.seq += 1;
        shared.seq
    };

    // 去重（防 CDP 重放，§2.1）：已 ack 的 (session, frame) 重复事件直接丢弃
    {
        let shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
        if shared
            .acked
            .iter()
            .any(|(s, f)| s == &chunk.session && *f == chunk.frame)
        {
            ctx.stats.duplicates_skipped.fetch_add(1, Ordering::Relaxed);
            if let Err(err) = ctx.events.send(ScreencastEvent::DuplicateSkipped { seq }) {
                tracing::debug!("帧流事件无订阅者（丢弃 DuplicateSkipped）：{err}");
            }
            return;
        }
    }

    // 输出：背压丢帧（满时丢队首保新帧，§2.4）
    let frame = FrameOut {
        seq,
        width: chunk.device_width,
        height: chunk.device_height,
        data: chunk.data.clone(),
    };
    if let Some(replaced) = ctx.sink.push(frame) {
        ctx.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
        if let Err(err) = ctx.events.send(ScreencastEvent::FrameDropped {
            seq: replaced.seq,
            queued: ctx.sink.len(),
        }) {
            tracing::debug!("帧流事件无订阅者（丢弃 FrameDropped）：{err}");
        }
    }
    ctx.stats.frames_sent.fetch_add(1, Ordering::Relaxed);
    if let Err(err) = ctx.events.send(ScreencastEvent::FrameSent {
        seq,
        bytes: chunk.data.len(),
    }) {
        tracing::debug!("帧流事件无订阅者（丢弃 FrameSent）：{err}");
    }

    // ack pacing：持住当前档位换算时长（§2.1：Chrome 收到 ack 后才产生下一帧）
    tokio::time::sleep(ctx.fps.hold()).await;

    // 发送 ack（短超时；失败记事件不中断泵——连接恢复后由重启路径接管）。
    // P1-A 遗留 1/2：params.sessionId 必须用帧内 ack_session（真实 Chrome 严格
    // 校验，用信封 session 会停滞帧流）；命令路由保持信封 session。
    let ack = Command::new(PAGE_SCREENCAST_FRAME_ACK)
        .params(ScreencastFrameAckParams {
            session_id: chunk.ack_session.clone(),
        })
        .with_session(&chunk.session)
        .with_timeout(ctx.config.ack_timeout);
    match ctx.session.send::<serde_json::Value>(ack).await {
        Ok(ack_reply) => {
            // ack 响应体（通常空对象）仅证明命令成功，不入统计；trace 留痕
            tracing::trace!("screencastFrameAck 响应：{ack_reply}");
            ctx.stats.acks_sent.fetch_add(1, Ordering::Relaxed);
            let mut shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
            shared.acked.push_back((chunk.session, chunk.frame));
            while shared.acked.len() > ctx.config.max_acked {
                shared.acked.pop_front();
            }
        }
        Err(e) => {
            ctx.stats.ack_failures.fetch_add(1, Ordering::Relaxed);
            if let Err(err) = ctx.events.send(ScreencastEvent::AckFailed {
                seq,
                message: e.to_string(),
            }) {
                tracing::debug!("帧流事件无订阅者（丢弃 AckFailed）：{err}");
            }
        }
    }
}
