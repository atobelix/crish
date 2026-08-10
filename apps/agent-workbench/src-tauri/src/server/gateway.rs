//! 帧网关（R1-10：D5 §7.2 / §7.5 帧大小与读超时的纯逻辑判定）
//!
//! 职责（无网络副作用，全部为可单测纯函数）：
//!
//! - 帧大小校验：单帧 ≤ 1 MiB（[MAX_FRAME_BYTES]，D3 §5.5 / D5 §7.5
//!   「JSON 帧 ≤ 1 MB；超限直接断连 + 审计」），返回结构化判定
//!   [FrameVerdict]（含实际字节数与上限，供错误帧/审计携带）；
//! - 读超时判定：空闲读超时 10s（[READ_TIMEOUT_MS]，D5 §7.2「空闲读超时
//!   10s → 关闭 + 释放槽位」；§7.5「慢速攻击：读超时 10s 覆盖半帧传输」），
//!   纯函数 [read_timeout_exceeded] 判定「自最近活动起是否超过超时窗口」，
//!   时钟回退安全（saturating_sub）。
//!
//! ## 接线现状（R1-10）
//!
//! - ws.rs 读循环（handle_text）的帧大小检查已切换为本模块
//!   [validate_frame_size]（1 MiB 单一事实源）；
//! - ws.rs 心跳 task 的空闲判定已切换为本模块 [read_timeout_exceeded]
//!   （判定逻辑单一事实源；当前超时值沿用 D2 §10.2 的 90s 心跳超时——10s
//!   空闲读超时与 30s 服务端 Ping 节奏不兼容，见 R1-10 汇报）。

use conex_types::device::version::MAX_FRAME_BYTES;

/// 空闲读超时（毫秒）：D5 §7.2「空闲读超时 10s」/ §7.5 慢速攻击覆盖半帧
// R1-10 备注：当前 ws.rs 心跳侧沿用 D2 90s 超时（10s 与 30s Ping 节奏不
// 兼容，见模块头注）；常量由测试消费，未来会话层接线——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
pub const READ_TIMEOUT_MS: u64 = 10_000;

/// 帧大小判定（结构化，D3 §5.5 / D5 §7.5；T-13 断言映射目标）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameVerdict {
    /// 帧大小合法（≤ 1 MiB）
    Ok,
    /// 帧超上限（携带实际字节数与上限；调用方断链并报 frame_too_large）
    TooLarge { bytes: usize, max: usize },
}

/// 帧大小校验（1 MiB 上限；超限 → [FrameVerdict::TooLarge]，含字节数与
/// 上限供错误帧/审计使用）
pub fn validate_frame_size(bytes: usize) -> FrameVerdict {
    if bytes > MAX_FRAME_BYTES {
        FrameVerdict::TooLarge {
            bytes,
            max: MAX_FRAME_BYTES,
        }
    } else {
        FrameVerdict::Ok
    }
}

/// 读超时判定（纯函数）：自 last_activity_ms 起经过 timeout_ms 毫秒即判定
/// 超时（`now - last >= timeout`；saturating_sub 防时钟回退误判）
pub fn read_timeout_exceeded(last_activity_ms: u64, now_ms: u64, timeout_ms: u64) -> bool {
    now_ms.saturating_sub(last_activity_ms) >= timeout_ms
}

/// 默认空闲读超时判定（10s，D5 §7.2）
// R1-10 备注：测试消费 + 未来会话层接线——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub fn idle_read_timeout_exceeded(last_activity_ms: u64, now_ms: u64) -> bool {
    read_timeout_exceeded(last_activity_ms, now_ms, READ_TIMEOUT_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T-13 断言锚：帧 ≤ 1 MiB 放行、> 1 MiB 拒绝（D5 §7.5 / D3 §5.5 边界）
    #[test]
    fn gateway_frame_size_1mb_boundary() {
        assert_eq!(validate_frame_size(0), FrameVerdict::Ok);
        assert_eq!(
            validate_frame_size(MAX_FRAME_BYTES),
            FrameVerdict::Ok,
            "恰好 1 MiB 必须放行"
        );
        assert!(
            matches!(
                validate_frame_size(MAX_FRAME_BYTES + 1),
                FrameVerdict::TooLarge { .. }
            ),
            "超 1 字节即拒绝"
        );
    }

    /// T-13 断言锚：结构化判定携带实际字节数与上限（错误帧/审计数据源）
    #[test]
    fn gateway_frame_verdict_carries_bytes_and_max() {
        assert_eq!(
            validate_frame_size(MAX_FRAME_BYTES + 1),
            FrameVerdict::TooLarge {
                bytes: MAX_FRAME_BYTES + 1,
                max: MAX_FRAME_BYTES,
            }
        );
    }

    /// T-13 断言锚：读超时 10s 边界（9_999ms 未超，10_000ms 超）
    #[test]
    fn gateway_read_timeout_10s_boundary() {
        assert!(
            !idle_read_timeout_exceeded(0, READ_TIMEOUT_MS - 1),
            "9_999ms 不得判定超时"
        );
        assert!(
            idle_read_timeout_exceeded(0, READ_TIMEOUT_MS),
            "10_000ms 必须判定超时"
        );
        assert!(idle_read_timeout_exceeded(0, READ_TIMEOUT_MS + 50_000));
        // 最近活动 = 当前时刻 → 未超时
        assert!(!idle_read_timeout_exceeded(1_000, 1_000));
    }

    /// 自定义超时窗口的纯判定（未来会话层接线复用同一函数）
    #[test]
    fn gateway_read_timeout_custom_window() {
        assert!(!read_timeout_exceeded(0, 9_999, 10_000));
        assert!(read_timeout_exceeded(0, 10_000, 10_000));
        assert!(read_timeout_exceeded(0, 30_000, 10_000));
        assert!(
            !read_timeout_exceeded(30_000, 0, 10_000),
            "时钟回退必须按未超时处理"
        );
    }

    /// 时钟回退安全：now < last（系统时间回拨）→ 不误判超时（saturating）
    #[test]
    fn gateway_read_timeout_clock_regress_safe() {
        assert!(!read_timeout_exceeded(50_000, 1_000, 10_000));
        assert_eq!(1_000u64.saturating_sub(50_000), 0);
    }
}
