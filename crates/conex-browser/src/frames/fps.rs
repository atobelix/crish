//! 帧率档位与升降档控制器（维度 12 §2.1/§2.5）
//!
//! - `FpsLevel`：Base 8fps / Interactive 15fps / Burst 20fps 三档（12 文档 §2.5 表）；
//! - 帧率控制 = ack pacing：协议无 fps 参数，帧泵持住 `Page.screencastFrameAck`
//!   的时长 = `1000 / fps`（收到 ack 后 Chrome 才产生下一帧）；
//! - `FpsController`：升降档（前端 `input_active` 信号 / AI 动作事件驱动）
//!   + 静止回落计时器（2s 无输入且无 AI 动作 → 回落 Base，§2.5）。

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 帧率档位（12 文档 §2.5 表）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FpsLevel {
    /// Base：面板静止且无 AI 动作，8fps（ack 持住 125ms）。
    Base,
    /// Interactive：用户交互 / AI 动作序列执行中，15fps（ack 持住 67ms）。
    Interactive,
    /// Burst：拖拽 / 连续滚动 / AI 拖放与动画回显，20fps 上限（ack 持住 50ms）。
    Burst,
}

impl FpsLevel {
    /// 档位帧率（fps）。
    pub const fn fps(self) -> u32 {
        match self {
            FpsLevel::Base => 8,
            FpsLevel::Interactive => 15,
            FpsLevel::Burst => 20,
        }
    }

    /// 档位 ack 持住时长（1000/fps 取整；67ms 向上取整保证不超 15fps 上限）。
    pub const fn hold_ms(self) -> u64 {
        match self {
            FpsLevel::Base => 125,
            FpsLevel::Interactive => 67,
            FpsLevel::Burst => 50,
        }
    }
}

/// 档位共享状态（回落计时器任务持有，防 Arc 自保活泄漏）。
struct FpsInner {
    /// 当前档位（FpsLevel 的 u8 表示）。
    level: AtomicU8,
    /// 活动代数：每次活动信号 +1；回落计时器捕获代数，到期时代数未变才回落
    /// （新活动到达后旧计时器不得压制新档位）。
    activity_gen: AtomicU64,
}

/// 升降档控制器（帧泵持住时长查询 + 静止回落）。
pub struct FpsController {
    inner: Arc<FpsInner>,
    /// 静止回落窗口（默认 2s，12 文档 §2.5）。
    idle_timeout: Duration,
    /// 测试注入：固定 ack 持住时长（None = 按档位换算）。
    hold_override: Option<Duration>,
}

impl FpsController {
    /// 新建控制器（初始档位 / 回落窗口 / 持住覆盖可注入）。
    pub fn new(
        initial: FpsLevel,
        idle_timeout: Duration,
        hold_override: Option<Duration>,
    ) -> Arc<Self> {
        Arc::new(FpsController {
            inner: Arc::new(FpsInner {
                level: AtomicU8::new(initial as u8),
                activity_gen: AtomicU64::new(0),
            }),
            idle_timeout,
            hold_override,
        })
    }

    /// 当前档位。
    pub fn current(&self) -> FpsLevel {
        match self.inner.level.load(Ordering::Relaxed) {
            1 => FpsLevel::Interactive,
            2 => FpsLevel::Burst,
            _ => FpsLevel::Base,
        }
    }

    /// 当前 ack 持住时长（测试注入的固定值优先，否则按档位换算）。
    pub fn hold(&self) -> Duration {
        match self.hold_override {
            Some(d) => d,
            None => Duration::from_millis(self.current().hold_ms()),
        }
    }

    /// 显式设档（回落 Base / AI 动作结束等显式降档；不重置静止计时器）。
    pub fn set_level(&self, level: FpsLevel) {
        self.inner.level.store(level as u8, Ordering::SeqCst);
    }

    /// 活动信号：升档 + 重置静止计时器（用户输入 / AI 动作开始）。
    ///
    /// 回落语义：计时器到期时若期间无新活动（代数未变）→ 回落 Base。
    pub fn mark_activity(&self, level: FpsLevel) {
        let gen = self.inner.activity_gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner.level.store(level as u8, Ordering::SeqCst);
        let inner = self.inner.clone();
        let timeout = self.idle_timeout;
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            if inner.activity_gen.load(Ordering::SeqCst) == gen {
                inner.level.store(FpsLevel::Base as u8, Ordering::SeqCst);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 档位表（12 文档 §2.5）：Base 8fps/125ms、Interactive 15fps/67ms、
    /// Burst 20fps/50ms。
    #[test]
    fn fps_level_table() {
        assert_eq!(FpsLevel::Base.fps(), 8);
        assert_eq!(FpsLevel::Base.hold_ms(), 125);
        assert_eq!(FpsLevel::Interactive.fps(), 15);
        assert_eq!(FpsLevel::Interactive.hold_ms(), 67);
        assert_eq!(FpsLevel::Burst.fps(), 20);
        assert_eq!(FpsLevel::Burst.hold_ms(), 50);
    }

    /// 持住时长查询：无覆盖按档位，有覆盖用注入值（测试路径）。
    #[test]
    fn fps_hold_override_priority() {
        let ctl = FpsController::new(FpsLevel::Base, Duration::from_secs(2), None);
        assert_eq!(ctl.hold(), Duration::from_millis(125));
        let ctl = FpsController::new(FpsLevel::Base, Duration::from_secs(2), Some(Duration::ZERO));
        assert_eq!(ctl.hold(), Duration::ZERO);
        assert_eq!(ctl.current(), FpsLevel::Base);
    }

    /// 静止回落（12 文档 §2.5）：活动信号升档 → 2s 内保持 → 到期回落 Base；
    /// 新活动到达后旧计时器不得压制（代数守卫）。
    /// 真实时钟 + 裕度断言（回落窗口 2s，检查点与到期点均留 ≥100ms 裕度）。
    #[tokio::test]
    async fn fps_idle_fallback_with_generation_guard() {
        let ctl = FpsController::new(FpsLevel::Base, Duration::from_secs(2), Some(Duration::ZERO));

        // 升档 → 2s 内保持（检查点 1.5s，距到期 500ms 裕度）
        ctl.mark_activity(FpsLevel::Burst);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(ctl.current(), FpsLevel::Burst, "2s 内保持 Burst");
        // 到期回落（1.5s+0.6s=2.1s > 2s，计时器必已触发）
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(ctl.current(), FpsLevel::Base, "2s 到期回落 Base");

        // 代数守卫：新活动后旧计时器不得压制新档位
        ctl.mark_activity(FpsLevel::Interactive); // 计时器 T2 于 +2s 到期
        tokio::time::sleep(Duration::from_millis(1500)).await;
        ctl.mark_activity(FpsLevel::Burst); // 计时器 T3 于 +2s 到期
                                            // +0.7s：T2 已到期（代数不匹配应跳过），T3 距到期 1.3s
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(
            ctl.current(),
            FpsLevel::Burst,
            "新活动后旧计时器到期不得回落"
        );
        // +1.4s：T3 到期 → 回落（检查点距到期点 100ms 裕度）
        tokio::time::sleep(Duration::from_millis(1400)).await;
        assert_eq!(ctl.current(), FpsLevel::Base);
    }

    /// 显式降档（set_level Base）不依赖计时器。
    #[test]
    fn fps_explicit_set_level() {
        let ctl = FpsController::new(FpsLevel::Base, Duration::from_secs(2), None);
        ctl.set_level(FpsLevel::Interactive);
        assert_eq!(ctl.current(), FpsLevel::Interactive);
        ctl.set_level(FpsLevel::Base);
        assert_eq!(ctl.current(), FpsLevel::Base);
    }
}
