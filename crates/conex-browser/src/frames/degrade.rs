//! 静态帧降级源（U-3 裁决：screencast 不可用时的降级路径，仅降级用）
//!
//! screencast 不可用（startScreencast 失败 / 能力探测无 screencast 能力）时，
//! 按 U-3 裁决以 **1fps `Page.captureScreenshot` 轮询** 持续供帧：
//! - 每 `static_interval`（默认 1s）发一次 captureScreenshot，base64 JPEG
//!   解码后经 `FrameSink` 推帧（`FrameOut` 兼容，帧序号独立起算）；
//! - 帧宽高取自 JPEG SOF 段（`Page.captureScreenshot` 协议不返回尺寸；
//!   解析失败用配置名义尺寸兜底）；
//! - 单拍截屏失败不中断轮询（下一拍重试），且每拍经 `current_session`
//!   重新路由——天然跨重连存活。
//!
//! 调度权在 `ScreencastSession`（session.rs：进入/退出/状态机集成）——
//! 本模块只提供轮询循环与 JPEG 尺寸解析的纯函数面，不持有会话对象
//! （任务被 abort 即终止，无自保活）。

use crate::cdp::domains::names::PAGE_CAPTURE_SCREENSHOT;
use crate::cdp::domains::{CaptureScreenshotParams, CaptureScreenshotResult};
use crate::cdp::sender::Command;
use crate::frames::session::{ScreencastEvent, StatsInner};
use crate::frames::sink::{FrameOut, FrameSink};
use crate::BrowserSession;
use base64::Engine;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

/// 降级轮询间隔默认值（U-3 裁决：1fps，可经 `ScreencastConfig.static_interval` 配置）。
pub(crate) const STATIC_POLL_INTERVAL_DEFAULT: Duration = Duration::from_secs(1);
/// 单次 captureScreenshot 命令超时默认值（2s：不显著拖慢 1fps 节奏）。
pub(crate) const STATIC_CAPTURE_TIMEOUT_DEFAULT: Duration = Duration::from_secs(2);

/// JPEG SOF（Start of Frame）标记判定：C0-CF 中除 C4(DHT)/C8(JPG)/CC(DAC)
/// 外的全部为 SOF 标记——段内固定偏移存图像高度/宽度。
pub(crate) fn is_sof_marker(marker: u8) -> bool {
    (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC)
}

/// 从 JPEG 原始字节解析图像尺寸。SOF 段布局：
/// `FF C0 [len:2] [precision:1] [height:2] [width:2] ...`（多字节高字节在前）。
/// 返回 `(width, height)`；非 JPEG / 截断 / EOI 先于 SOF → None。
pub(crate) fn jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    // SOI 校验（FF D8）
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 3 < data.len() {
        if data[i] != 0xFF {
            return None; // 段遍历失步（防御性终止，不做猜测修复）
        }
        let marker = data[i + 1];
        match marker {
            // 连续填充 0xFF：仅推进到下一个有效标记
            0xFF => i += 1,
            // 无段长标记：SOI / 临时保留 0x01 / RST D0-D7
            0xD8 | 0x01 | 0xD0..=0xD7 => i += 2,
            // EOI：扫描完成仍未见 SOF
            0xD9 => return None,
            _ => {
                if is_sof_marker(marker) {
                    if data.len() < i + 9 {
                        return None;
                    }
                    let height = u16::from_be_bytes([data[i + 5], data[i + 6]]);
                    let width = u16::from_be_bytes([data[i + 7], data[i + 8]]);
                    return Some((u32::from(width), u32::from(height)));
                }
                // 常规段：跳过 [len:2] 声明的段长
                let seg_len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
                if seg_len < 2 {
                    return None; // 非法段长（防御性终止）
                }
                i += 2 + seg_len;
            }
        }
    }
    None
}

/// captureScreenshot 响应 base64 → JPEG 原始字节。
pub(crate) fn decode_base64_jpeg(encoded: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("base64 解码失败：{e}"))
}

/// 降级轮询上下文（任务入参聚合；由 `ScreencastSession` 构建，任务内自持）。
pub(crate) struct StaticPollCtx {
    pub(crate) session: Arc<BrowserSession>,
    pub(crate) sink: Arc<FrameSink>,
    pub(crate) stats: Arc<StatsInner>,
    pub(crate) events: broadcast::Sender<ScreencastEvent>,
    /// 轮询间隔（U-3 默认 1s = 1fps，可配）。
    pub(crate) interval: Duration,
    /// 单次 captureScreenshot 命令超时。
    pub(crate) capture_timeout: Duration,
    /// JPEG 质量（透传配置）。
    pub(crate) quality: i32,
    /// JPEG SOF 解析失败时的名义尺寸兜底（协议不返回宽高）。
    pub(crate) fallback_width: u32,
    pub(crate) fallback_height: u32,
}

/// 降级轮询主循环：首帧立即截取（快速反馈），随后每 `interval` 一拍。
/// 截屏失败跳过本拍（下一拍重试，不中断节奏）；任务被 abort 即终止
/// （exit_static 路径，不持有会话自保活）。
pub(crate) async fn static_poll_loop(ctx: StaticPollCtx) {
    let mut seq = 0u64;
    loop {
        if let Some((width, height, data)) = capture_one(&ctx).await {
            seq += 1;
            ctx.stats.add_static_frame();
            let bytes = data.len();
            let frame = FrameOut {
                seq,
                width,
                height,
                data,
            };
            // 背压丢帧（满时丢队首保新帧，语义同帧泵 §2.4）
            if let Some(replaced) = ctx.sink.push(frame) {
                ctx.stats.add_dropped();
                let _ = ctx.events.send(ScreencastEvent::FrameDropped {
                    seq: replaced.seq,
                    queued: ctx.sink.len(),
                });
            }
            let _ = ctx.events.send(ScreencastEvent::FrameSent { seq, bytes });
        }
        tokio::time::sleep(ctx.interval).await;
    }
}

/// 单拍截屏：current_session → Page.captureScreenshot → base64 解码 → JPEG 尺寸。
/// 失败返回 None（调用方跳过本拍，节奏不受影响）。
async fn capture_one(ctx: &StaticPollCtx) -> Option<(u32, u32, Vec<u8>)> {
    let sref = match ctx.session.current_session() {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!("降级截屏：无活动标签会话（下一拍重试）：{e}");
            return None;
        }
    };
    let params = CaptureScreenshotParams {
        format: Some("jpeg".to_string()),
        quality: Some(ctx.quality),
        clip: None,
        capture_beyond_viewport: None,
    };
    let cmd = Command::new(PAGE_CAPTURE_SCREENSHOT)
        .params(params)
        .with_session(&sref.session)
        .with_timeout(ctx.capture_timeout);
    let result = match ctx.session.send::<CaptureScreenshotResult>(cmd).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("降级截屏失败（下一拍重试）：{e}");
            return None;
        }
    };
    let jpeg = match decode_base64_jpeg(&result.data) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("降级截屏 base64 解码失败（下一拍重试）：{e}");
            return None;
        }
    };
    let (width, height) =
        jpeg_dimensions(&jpeg).unwrap_or((ctx.fallback_width, ctx.fallback_height));
    Some((width, height, jpeg))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 测试用最小 JPEG（SOI + APP0 + SOF0 + EOI；无熵编码段，仅供尺寸解析）。
    /// APP0 段长 0x0010 = 2（长度字段自身）+ 14（JFIF 载荷）；SOF0 段长
    /// 0x000B = 2 + 1（精度）+ 2（高）+ 2（宽）+ 1（分量数）+ 3（分量信息）。
    pub(crate) fn tiny_test_jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        v.extend_from_slice(b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00");
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08]);
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    /// SOF0 尺寸解析：宽高高字节在前，正确命中。
    #[test]
    fn jpeg_dimensions_from_sof0() {
        let jpeg = tiny_test_jpeg(400, 600);
        assert_eq!(jpeg_dimensions(&jpeg), Some((400, 600)));
    }

    /// 常规段跳过：SOF0 前插入 DQT（FF DB）段，仍须命中 SOF。
    #[test]
    fn jpeg_dimensions_skips_regular_segments() {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        v.extend_from_slice(b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00");
        v.extend_from_slice(&[0xFF, 0xDB, 0x00, 0x03, 0x00]); // DQT 段（len 3 = 长度字段 2 + 载荷 1）
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08]);
        v.extend_from_slice(&480u16.to_be_bytes());
        v.extend_from_slice(&640u16.to_be_bytes());
        v.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(jpeg_dimensions(&v), Some((640, 480)));
    }

    /// 拒绝面：非 JPEG / EOI 先于 SOF / SOF 段截断。
    #[test]
    fn jpeg_dimensions_rejects_non_jpeg() {
        assert_eq!(jpeg_dimensions(b"not a jpeg"), None);
        assert_eq!(jpeg_dimensions(&[0xFF, 0xD8, 0xFF, 0xD9]), None, "EOI 先于 SOF → None");
        assert_eq!(jpeg_dimensions(&[0xFF, 0xD8, 0xFF, 0xC0]), None, "SOF 段截断 → None");
        assert_eq!(jpeg_dimensions(&[0x00, 0x01, 0x02, 0x03]), None, "无 SOI → None");
    }

    /// 填充字节防御面：段后连续 0xFF 再 SOF（非法但不应误判/误读）。
    #[test]
    fn jpeg_dimensions_fill_bytes_between_markers() {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xFF, 0xC0, 0x00, 0x0B, 0x08]);
        v.extend_from_slice(&100u16.to_be_bytes());
        v.extend_from_slice(&200u16.to_be_bytes());
        v.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
        assert_eq!(jpeg_dimensions(&v), Some((200, 100)));
    }

    /// base64 解码往返 + 非法输入拒绝。
    #[test]
    fn decode_base64_jpeg_roundtrip() {
        let jpeg = tiny_test_jpeg(8, 8);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        assert_eq!(decode_base64_jpeg(&encoded).unwrap(), jpeg);
        assert!(decode_base64_jpeg("!!!not-base64!!!").is_err());
        assert!(decode_base64_jpeg("").is_ok(), "空串可解码为空字节（由调用方尺寸兜底）");
    }
}
