//! 会话互斥激活门(18 §6 / 04 §2 S3 任务 1-3 契约面)。
//!
//! 纯逻辑模块:激活状态机 + 切换清理清单契约,不依赖任何设备/运行时,
//! 全平台可编译、可穷举单测。
//!
//! 状态机三态(18 §6.1):[`Idle`] / [`BrowserActive`] / [`DesktopActive`]。
//! 电脑操作会话与浏览器会话**不可同时活跃**:切换仅限用户显式请求
//! (`request_browser` / `request_desktop`,AI 工具无切换能力);
//! 对方会话活跃时请求返回互斥错误(`tool.session.exclusive`,18 §6.3,
//! 守卫检查点在审批之前)。
//!
//! 切换协议(调用方接线,本模块只定义契约与状态机):
//! 1. 用户显式发起切换(面板按钮/设置);
//! 2. `cleanup_plan(target)` 取需要清理的对方资源清单(阻塞完成语义);
//! 3. 调用方按清单顺序阻塞执行清理(帧流停/令牌吊销/快照作废等,本模块不执行);
//! 4. `release()` 回 [`Idle`](任态→Idle 清理);
//! 5. 重新 `request_browser` / `request_desktop` 激活目标会话。
//!
//! 并发安全:状态以 `AtomicU8` 原子编码(0=Idle/1=Browser/2=Desktop),
//! 请求经 CAS 串行化(线性一致),无锁无阻塞;同状态重复请求幂等(重入安全)。

use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};

/// 会话激活模式(18 §6.1 状态机三态;电脑操作与浏览器不可同时活跃)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    /// 无会话活跃(会话结束/急停/空闲超时后的落点)
    Idle = 0,
    /// 浏览器会话活跃(浏览器工具面可用)
    BrowserActive = 1,
    /// 电脑操作会话活跃(computer_* 工具面可用)
    DesktopActive = 2,
}

impl SessionMode {
    /// 是否有会话活跃(Idle 为 false)
    pub fn is_active(self) -> bool {
        self != Self::Idle
    }

    /// 是否浏览器会话活跃(工具面守卫 `browser_*` 判据)
    pub fn is_browser(self) -> bool {
        self == Self::BrowserActive
    }

    /// 是否电脑操作会话活跃(工具面守卫 `computer_*` 判据)
    pub fn is_desktop(self) -> bool {
        self == Self::DesktopActive
    }

    /// 编码为原子状态值(与 `AtomicU8` 存储面一致)
    fn as_u8(self) -> u8 {
        match self {
            Self::Idle => 0,
            Self::BrowserActive => 1,
            Self::DesktopActive => 2,
        }
    }

    /// 从原子状态值解码(防御未知值 → Idle;仅 unsafe 面可能产生未知值)
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::BrowserActive,
            2 => Self::DesktopActive,
            _ => Self::Idle,
        }
    }
}

impl fmt::Display for SessionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Idle => "Idle(空闲)",
            Self::BrowserActive => "BrowserActive(浏览器会话)",
            Self::DesktopActive => "DesktopActive(电脑操作会话)",
        };
        f.write_str(s)
    }
}

/// 激活请求错误(04 §2 S3 任务 3 / 18 §6.3 互斥守卫错误码语义)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ActivationError {
    /// 互斥拒绝:对方会话活跃,无法直接切换到目标会话。
    /// 须用户显式确认,先 `cleanup_plan` 清理、`release` 回 Idle,再重新请求。
    #[error("会话互斥(tool.session.exclusive): 当前为{current}, 无法直接切换到{target}")]
    Exclusive {
        /// 当前活跃会话
        current: SessionMode,
        /// 被拒绝的目标会话
        target: SessionMode,
    },
}

/// 切换清理清单的抽象条目(04 §2 S3 任务 2 / 18 §6.2 契约面)。
///
/// 具体清理动作由调用方(executor 接线)执行——本模块只定义契约与顺序,
/// 不触碰任何设备/会话资源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CleanupAction {
    /// 浏览器侧:停止 screencast 帧流(18 §6.2 ①)
    BrowserFrameStreamStop,
    /// 浏览器侧:挂起浏览器 AI 会话(吊销令牌/快照版本作废由调用方执行)
    BrowserSessionSuspend,
    /// 桌面侧:输入注入复位(未完成的按下/拖拽状态复位)
    DesktopInputReset,
    /// 桌面侧:挂起桌面会话(停止截屏源/轮询/UIA 订阅)
    DesktopSuspend,
}

/// 会话激活互斥门(18 §6 / 04 §2 S3 任务 1-3)。
///
/// 状态以 `AtomicU8` 原子编码([`SessionMode`] 判别值),请求经 CAS 串行化:
/// - `request_*`:Idle → 目标态(首次 CAS 胜出);同态重复请求幂等;
///   对方活跃返回 [`ActivationError::Exclusive`]。
/// - `release`:任意态 → Idle,返回先前状态(任态→Idle 清理)。
///
/// 线程安全:`Send + Sync`,可经 `Arc` 共享给工具执行器/面板接线。
#[derive(Default)]
pub struct ActivationGate {
    /// 原子状态编码(0=Idle/1=Browser/2=Desktop;`AtomicU8::default()`=0 对齐 Idle)
    mode: AtomicU8,
}

/// 编译期约束:Idle 编码为 0,与 `AtomicU8::default()`(0)一致,
/// 保证 `derive(Default)` 与 `new()` 同语义。
const _: () = assert!(SessionMode::Idle as u8 == 0);

impl ActivationGate {
    /// 构造互斥门,初始态 Idle
    pub const fn new() -> Self {
        Self {
            mode: AtomicU8::new(SessionMode::Idle as u8),
        }
    }

    /// 当前激活模式
    pub fn current(&self) -> SessionMode {
        SessionMode::from_u8(self.mode.load(Ordering::Acquire))
    }

    /// 显式请求激活浏览器会话(切换仅限用户显式请求,AI 工具无切换能力):
    /// - Idle → BrowserActive:迁移成功;
    /// - 已处于 BrowserActive:幂等返回成功(重入);
    /// - DesktopActive 活跃:返回互斥错误(`tool.session.exclusive`)。
    pub fn request_browser(&self) -> Result<(), ActivationError> {
        self.request(SessionMode::BrowserActive)
    }

    /// 显式请求激活电脑操作会话(语义同 [`request_browser`](Self::request_browser),目标为桌面):
    /// - Idle → DesktopActive:迁移成功;
    /// - 已处于 DesktopActive:幂等返回成功(重入);
    /// - BrowserActive 活跃:返回互斥错误(`tool.session.exclusive`)。
    pub fn request_desktop(&self) -> Result<(), ActivationError> {
        self.request(SessionMode::DesktopActive)
    }

    /// 释放当前会话,回 Idle(任态→Idle 清理)。
    /// 返回释放前的模式,供调用方核对清理清单([`cleanup_plan`](Self::cleanup_plan));
    /// Idle 时调用为幂等空操作。
    pub fn release(&self) -> SessionMode {
        let prev = self.mode.swap(SessionMode::Idle as u8, Ordering::AcqRel);
        SessionMode::from_u8(prev)
    }

    /// 切换到 `target` 前需要清理的对方资源清单(04 §2 S3 任务 2 契约面)。
    ///
    /// 返回语义(3×3 全矩阵):
    /// - 当前 Idle,或已处于目标态:空清单(无清理项);
    /// - 当前浏览器会话活跃(目标为 Desktop 或 Idle):浏览器侧清理
    ///   (帧流停 → 会话挂起,18 §6.2 ①);
    /// - 当前桌面会话活跃(目标为 Browser 或 Idle):桌面侧清理
    ///   (输入注入复位 → 挂起,18 §6.2 ②)。
    ///
    /// 清理由调用方按返回顺序阻塞执行(同步完成才允许进入新会话),
    /// 本模块只定义契约与顺序,不执行任何设备动作。
    pub fn cleanup_plan(&self, target: SessionMode) -> Vec<CleanupAction> {
        let current = self.current();
        if current == SessionMode::Idle || current == target {
            return Vec::new();
        }
        match current {
            SessionMode::BrowserActive => Self::browser_cleanup(),
            SessionMode::DesktopActive => Self::desktop_cleanup(),
            // 防御分支:Idle 已提前返回,逻辑上不可达
            SessionMode::Idle => Vec::new(),
        }
    }

    /// 浏览器侧清理清单(18 §6.2 ①):切离浏览器会话前须阻塞完成的资源项,顺序即执行顺序。
    pub fn browser_cleanup() -> Vec<CleanupAction> {
        vec![
            CleanupAction::BrowserFrameStreamStop,
            CleanupAction::BrowserSessionSuspend,
        ]
    }

    /// 桌面侧清理清单(18 §6.2 ②):切离桌面会话前须阻塞完成的资源项,顺序即执行顺序。
    pub fn desktop_cleanup() -> Vec<CleanupAction> {
        vec![
            CleanupAction::DesktopInputReset,
            CleanupAction::DesktopSuspend,
        ]
    }

    /// 激活请求核心:Idle 经 CAS 迁移(串行化),对方活跃拒绝,同态幂等。
    /// CAS 失败说明并发请求抢先迁移,重读状态再判(循环有界,不活锁)。
    fn request(&self, target: SessionMode) -> Result<(), ActivationError> {
        loop {
            match self.current() {
                cur if cur == target => return Ok(()),
                SessionMode::Idle => {
                    if self
                        .mode
                        .compare_exchange(
                            SessionMode::Idle as u8,
                            target.as_u8(),
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        return Ok(());
                    }
                }
                other => {
                    return Err(ActivationError::Exclusive {
                        current: other,
                        target,
                    })
                }
            }
        }
    }
}

impl fmt::Debug for ActivationGate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ActivationGate")
            .field("mode", &self.current())
            .finish()
    }
}
