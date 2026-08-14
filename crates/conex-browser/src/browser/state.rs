//! 生命周期状态机（维度 10 §6.2 迁移表，纯逻辑可穷举测试）
//!
//! 迁移表（§6.2 权威 + 两处补充扩展，注释标注）：
//!
//! | 当前 | 事件 | 目标 | 迁移动作 |
//! |---|---|---|---|
//! | Stopped | Start | Launching{1} | SpawnBrowser |
//! | Launching | PortReady | Running | RunningReady |
//! | Launching | LaunchFailed(attempt<3) | Launching{n+1} | RetryLaunch |
//! | Launching | LaunchFailed(attempt=3) | Stopped | GiveUp（清理 profile） |
//! | Running | Stop{graceful} | Stopping{true} | BeginGracefulStop |
//! | Running | Stop{force} | Stopping{false} | BeginForceStop |
//! | Running | CrashDetected(未超限) | Crashed{restarts+1} | CrashEnter |
//! | Running | CrashDetected(超限) | Stopped | CrashAbort（保留导航栈数据） |
//! | Crashed | RestartTick | Launching{1} | RestartBrowser（复用 profile） |
//! | Crashed | Stop | Stopped | StoppedClean（意图取消重启，扩展） |
//! | Launching | Stop | Stopped | StoppedClean（启动中取消，扩展） |
//! | Stopping | StopExited | Stopped | StoppedClean（删 profile） |
//! | Stopping | StopTimeout | Stopped | StoppedAfterKill（杀树+删 profile） |
//!
//! 其余全部 (state, event) 组合 → `Transition::Invalid`（非法迁移，调用方记 warning）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁；`on()` 纯同步不可失败。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 进程状态（§6.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserState {
    /// 未启动/已销毁。
    Stopped,
    /// 启动中（重试计数）。
    Launching { attempt: u8 },
    /// 运行中（CDP 已连、已验证）。
    Running,
    /// 崩溃，待重启或放弃（重启定时器期间工具面不可用，R-9-4）。
    Crashed { reason: CrashReason, restarts: u8 },
    /// 停止中。
    Stopping { graceful: bool },
}

/// 崩溃原因（§6.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReason {
    ProcessExit(i32),
    CdpDisconnected,
    LaunchEarlyExit(i32),
    Unknown,
}

/// 状态机事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateEvent {
    /// 外部意图：启动。
    Start,
    /// 端口就绪 + 验证通过（§5.2）。
    PortReady,
    /// 本次启动尝试失败（attempt 计数由状态机维护）。
    LaunchFailed,
    /// 外部意图：停止。
    Stop { graceful: bool },
    /// 运行中检测到崩溃（进程退出非意图 / CdpDisconnected 次级信号）。
    CrashDetected { reason: CrashReason },
    /// 崩溃重启定时器到点。
    RestartTick,
    /// 停止等待中进程退出（≤5s）。
    StopExited,
    /// 停止等待超时（5s → 杀树）。
    StopTimeout,
}

/// 迁移动作（调用方执行语义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// Stopped --Start--> Launching{1}：解析二进制 → 建 profile → spawn → 轮询端口。
    SpawnBrowser { attempt: u8 },
    /// Launching --PortReady--> Running：上报端点、发射 StateChanged。
    RunningReady,
    /// Launching --LaunchFailed(attempt<3)--> Launching{n+1}：清理本次残留后重试。
    RetryLaunch { attempt: u8 },
    /// Launching --LaunchFailed(attempt=3)--> Stopped：清理 profile + 发射终态错误。
    GiveUp,
    /// Running --Stop{graceful}--> Stopping{true}：Browser.close → wait_or_kill(5s)。
    BeginGracefulStop,
    /// Running --Stop{force}--> Stopping{false}：直接杀树。
    BeginForceStop,
    /// Running --CrashDetected--> Crashed{n+1}：冻结导航栈 + 发射 CrashRestarting + 定时器。
    CrashEnter { restarts: u8 },
    /// Running --CrashDetected(超限)--> Stopped：CrashLoopDetected 终态（保留导航栈数据）。
    CrashAbort { restarts: u8 },
    /// Crashed --RestartTick--> Launching{1}：复用 profile（仅删 DevToolsActivePort）。
    RestartBrowser { restarts: u8 },
    /// Stopping --StopExited--> Stopped：删 profile。
    StoppedClean,
    /// Stopping --StopTimeout--> Stopped：杀树 + 删 profile。
    StoppedAfterKill,
    /// 非法迁移（状态机拒绝，调用方记 warning）。
    Invalid {
        state: BrowserState,
        event: StateEvent,
    },
}

/// 崩溃重启预算（30s 窗口内 3 次上限，§6.2/§6.4）。
#[derive(Debug, Clone, Copy)]
pub struct CrashBudget {
    pub window: Duration,
    pub max_restarts: u8,
}

impl Default for CrashBudget {
    fn default() -> Self {
        CrashBudget {
            window: Duration::from_secs(30),
            max_restarts: 3,
        }
    }
}

/// 状态机（纯逻辑：attempt 计数、restarts 计数、崩溃时间窗）。
#[derive(Debug, Clone)]
pub struct StateMachine {
    state: BrowserState,
    attempt: u8,
    restarts: u8,
    /// 崩溃时间戳（滑动窗口去旧）。
    crash_times: VecDeque<Instant>,
}

impl Default for StateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl StateMachine {
    pub fn new() -> Self {
        StateMachine {
            state: BrowserState::Stopped,
            attempt: 0,
            restarts: 0,
            crash_times: VecDeque::new(),
        }
    }

    pub fn state(&self) -> BrowserState {
        self.state
    }

    /// 已累计崩溃次数（诊断面）。
    pub fn restarts(&self) -> u8 {
        self.restarts
    }

    /// 事件驱动迁移（now 注入保证崩溃窗口判定可测）。
    pub fn on(&mut self, event: StateEvent, now: Instant, budget: &CrashBudget) -> Transition {
        let transition = self.compute(event, now, budget);
        match transition {
            Transition::SpawnBrowser { attempt } => {
                self.state = BrowserState::Launching { attempt };
                self.attempt = attempt;
            }
            Transition::RunningReady => self.state = BrowserState::Running,
            Transition::RetryLaunch { attempt } => {
                self.state = BrowserState::Launching { attempt };
                self.attempt = attempt;
            }
            Transition::GiveUp => {
                self.state = BrowserState::Stopped;
                self.attempt = 0;
            }
            Transition::BeginGracefulStop | Transition::BeginForceStop => {
                let graceful = matches!(transition, Transition::BeginGracefulStop);
                self.state = BrowserState::Stopping { graceful };
            }
            Transition::CrashEnter { restarts } => {
                self.restarts = restarts;
                self.state = BrowserState::Crashed {
                    reason: match event {
                        StateEvent::CrashDetected { reason } => reason,
                        _ => CrashReason::Unknown,
                    },
                    restarts,
                };
            }
            Transition::CrashAbort { restarts } => {
                self.restarts = restarts;
                self.state = BrowserState::Stopped;
            }
            Transition::RestartBrowser { restarts } => {
                self.state = BrowserState::Launching { attempt: 1 };
                self.attempt = 1;
                self.restarts = restarts;
            }
            Transition::StoppedClean | Transition::StoppedAfterKill => {
                self.state = BrowserState::Stopped;
                self.attempt = 0;
            }
            Transition::Invalid { .. } => {}
        }
        transition
    }

    fn compute(&mut self, event: StateEvent, now: Instant, budget: &CrashBudget) -> Transition {
        let state = self.state;
        match (state, event) {
            // —— 合法迁移（§6.2 全表）——
            (BrowserState::Stopped, StateEvent::Start) => Transition::SpawnBrowser { attempt: 1 },
            (BrowserState::Launching { .. }, StateEvent::PortReady) => Transition::RunningReady,
            (BrowserState::Launching { attempt }, StateEvent::LaunchFailed) => {
                if attempt < 3 {
                    Transition::RetryLaunch {
                        attempt: attempt + 1,
                    }
                } else {
                    Transition::GiveUp
                }
            }
            (BrowserState::Running, StateEvent::Stop { graceful: true }) => {
                Transition::BeginGracefulStop
            }
            (BrowserState::Running, StateEvent::Stop { graceful: false }) => {
                Transition::BeginForceStop
            }
            (BrowserState::Running, StateEvent::CrashDetected { .. }) => {
                self.record_crash(now, budget);
                let restarts = self.restarts;
                if restarts > budget.max_restarts {
                    Transition::CrashAbort { restarts }
                } else {
                    Transition::CrashEnter { restarts }
                }
            }
            (BrowserState::Crashed { .. }, StateEvent::RestartTick) => Transition::RestartBrowser {
                restarts: self.restarts,
            },
            // 扩展（文档未列但必要）：崩溃窗口/启动中收到停止意图 → 直接收敛
            (BrowserState::Crashed { .. }, StateEvent::Stop { .. }) => Transition::StoppedClean,
            (BrowserState::Launching { .. }, StateEvent::Stop { .. }) => Transition::StoppedClean,
            (BrowserState::Stopping { .. }, StateEvent::StopExited) => Transition::StoppedClean,
            (BrowserState::Stopping { .. }, StateEvent::StopTimeout) => {
                Transition::StoppedAfterKill
            }
            // —— 非法迁移（全部其余组合）——
            _ => Transition::Invalid { state, event },
        }
    }

    /// 记录崩溃并维护 30s 滑动窗口（超窗时间戳剔除；窗口边界 ≥ 视为出窗）。
    fn record_crash(&mut self, now: Instant, budget: &CrashBudget) {
        self.crash_times.push_back(now);
        while let Some(&oldest) = self.crash_times.front() {
            if now.duration_since(oldest) >= budget.window {
                self.crash_times.pop_front();
            } else {
                break;
            }
        }
        self.restarts = self.crash_times.len() as u8;
    }

    /// 重置（新会话/显式刷新）。
    pub fn reset(&mut self) {
        *self = StateMachine::new();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Instant {
        Instant::now()
    }

    /// 独立规格：给定 (state, event, restarts) 的期望迁移（镜像 §6.2 表；
    /// attempt 从 state 本身解构，不单独传参）。
    fn spec(state: BrowserState, event: StateEvent, restarts: u8) -> Transition {
        match (state, event) {
            (BrowserState::Stopped, StateEvent::Start) => Transition::SpawnBrowser { attempt: 1 },
            (BrowserState::Launching { .. }, StateEvent::PortReady) => Transition::RunningReady,
            (BrowserState::Launching { attempt: a }, StateEvent::LaunchFailed) => {
                if a < 3 {
                    Transition::RetryLaunch { attempt: a + 1 }
                } else {
                    Transition::GiveUp
                }
            }
            (BrowserState::Running, StateEvent::Stop { graceful: true }) => {
                Transition::BeginGracefulStop
            }
            (BrowserState::Running, StateEvent::Stop { graceful: false }) => {
                Transition::BeginForceStop
            }
            (BrowserState::Running, StateEvent::CrashDetected { .. }) => Transition::CrashEnter {
                restarts: restarts + 1,
            },
            (BrowserState::Crashed { .. }, StateEvent::RestartTick) => {
                Transition::RestartBrowser { restarts }
            }
            (BrowserState::Crashed { .. }, StateEvent::Stop { .. }) => Transition::StoppedClean,
            (BrowserState::Launching { .. }, StateEvent::Stop { .. }) => Transition::StoppedClean,
            (BrowserState::Stopping { .. }, StateEvent::StopExited) => Transition::StoppedClean,
            (BrowserState::Stopping { .. }, StateEvent::StopTimeout) => {
                Transition::StoppedAfterKill
            }
            _ => Transition::Invalid { state, event },
        }
    }

    /// 将状态机驱动到指定状态（合法序列构造初始态；attempt/restarts 随构造自然演进）。
    fn drive_to(sm: &mut StateMachine, target: BrowserState) -> (u8, u8) {
        let budget = CrashBudget::default();
        match target {
            BrowserState::Stopped => (0, 0),
            BrowserState::Launching { attempt } => {
                sm.on(StateEvent::Start, now(), &budget);
                for _ in 1..attempt {
                    sm.on(StateEvent::LaunchFailed, now(), &budget);
                }
                (attempt, 0)
            }
            BrowserState::Running => {
                sm.on(StateEvent::Start, now(), &budget);
                sm.on(StateEvent::PortReady, now(), &budget);
                (0, 0)
            }
            BrowserState::Crashed { restarts, .. } => {
                sm.on(StateEvent::Start, now(), &budget);
                sm.on(StateEvent::PortReady, now(), &budget);
                // 先记录 restarts-1 次崩溃并重启回 Running，最后一次崩溃留在 Crashed
                for _ in 0..restarts.saturating_sub(1) {
                    sm.on(
                        StateEvent::CrashDetected {
                            reason: CrashReason::ProcessExit(1),
                        },
                        now(),
                        &budget,
                    );
                    sm.on(StateEvent::RestartTick, now(), &budget);
                    sm.on(StateEvent::PortReady, now(), &budget);
                }
                sm.on(
                    StateEvent::CrashDetected {
                        reason: CrashReason::ProcessExit(1),
                    },
                    now(),
                    &budget,
                );
                (0, restarts)
            }
            BrowserState::Stopping { graceful } => {
                sm.on(StateEvent::Start, now(), &budget);
                sm.on(StateEvent::PortReady, now(), &budget);
                sm.on(StateEvent::Stop { graceful }, now(), &budget);
                (0, 0)
            }
        }
    }

    /// 全迁移表穷举：所有 (state, event) 组合与独立规格逐对比对。
    #[test]
    fn exhaustive_transition_matrix() {
        let budget = CrashBudget::default();
        let states: Vec<BrowserState> = vec![
            BrowserState::Stopped,
            BrowserState::Launching { attempt: 1 },
            BrowserState::Launching { attempt: 2 },
            BrowserState::Launching { attempt: 3 },
            BrowserState::Running,
            BrowserState::Crashed {
                reason: CrashReason::Unknown,
                restarts: 2,
            },
            BrowserState::Stopping { graceful: true },
            BrowserState::Stopping { graceful: false },
        ];
        let events: Vec<StateEvent> = vec![
            StateEvent::Start,
            StateEvent::PortReady,
            StateEvent::LaunchFailed,
            StateEvent::Stop { graceful: true },
            StateEvent::Stop { graceful: false },
            StateEvent::CrashDetected {
                reason: CrashReason::ProcessExit(1),
            },
            StateEvent::RestartTick,
            StateEvent::StopExited,
            StateEvent::StopTimeout,
        ];
        let mut checked = 0usize;
        let mut illegal_checked = 0usize;
        let mut failures = Vec::new();
        for &state in &states {
            for &event in &events {
                let mut sm = StateMachine::new();
                let (_attempt, restarts) = drive_to(&mut sm, state);
                let actual = sm.on(event, now(), &budget);
                let expected = spec(state, event, restarts);
                // 归一化：Crashed 的 reason 仅为诊断面（驱动序列用 ProcessExit(1)，
                // 声明态用 Unknown），比较时忽略
                if norm(actual) != norm(expected) {
                    failures.push(format!(
                        "{state:?} × {event:?} → {actual:?}（规格期望 {expected:?}）"
                    ));
                }
                if matches!(expected, Transition::Invalid { .. }) {
                    illegal_checked += 1;
                } else {
                    checked += 1;
                }
                // 迁移后状态一致性（终态与表一致）
                match actual {
                    Transition::RunningReady => {
                        assert_eq!(sm.state(), BrowserState::Running, "{state:?} × {event:?}")
                    }
                    Transition::GiveUp
                    | Transition::CrashAbort { .. }
                    | Transition::StoppedClean
                    | Transition::StoppedAfterKill => {
                        assert_eq!(sm.state(), BrowserState::Stopped, "{state:?} × {event:?}")
                    }
                    _ => {}
                }
            }
        }
        assert!(
            failures.is_empty(),
            "迁移表穷举失败（{checked} 合法 / {illegal_checked} 非法检查）：\n{}",
            failures.join("\n")
        );
        assert!(checked >= 11, "合法迁移至少覆盖 §6.2 全表 11 行 + 扩展");
        assert!(
            illegal_checked >= 45,
            "非法组合必须穷举（8 状态 × 9 事件 − 合法 ≈ 49）：实际 {illegal_checked}"
        );
    }

    /// 归一化：Crashed 的 reason 仅为诊断面，比较时统一为 Unknown。
    fn norm(t: Transition) -> Transition {
        match t {
            Transition::Invalid { state, event } => Transition::Invalid {
                state: match state {
                    BrowserState::Crashed { restarts, .. } => BrowserState::Crashed {
                        reason: CrashReason::Unknown,
                        restarts,
                    },
                    s => s,
                },
                event,
            },
            other => other,
        }
    }

    /// 启动重试耗尽 → GiveUp（§6.2 第 4 行）。
    #[test]
    fn launch_retry_then_give_up() {
        let budget = CrashBudget::default();
        let mut sm = StateMachine::new();
        assert_eq!(
            sm.on(StateEvent::Start, now(), &budget),
            Transition::SpawnBrowser { attempt: 1 }
        );
        assert_eq!(sm.state(), BrowserState::Launching { attempt: 1 });
        assert_eq!(
            sm.on(StateEvent::LaunchFailed, now(), &budget),
            Transition::RetryLaunch { attempt: 2 }
        );
        assert_eq!(sm.state(), BrowserState::Launching { attempt: 2 });
        assert_eq!(
            sm.on(StateEvent::LaunchFailed, now(), &budget),
            Transition::RetryLaunch { attempt: 3 }
        );
        assert_eq!(
            sm.on(StateEvent::LaunchFailed, now(), &budget),
            Transition::GiveUp
        );
        assert_eq!(sm.state(), BrowserState::Stopped);
    }

    /// 崩溃 3 次内重启；第 4 次（30s 窗口内）→ CrashAbort（§6.2/§6.4）。
    #[test]
    fn crash_loop_aborts_after_3() {
        let budget = CrashBudget::default();
        let mut sm = StateMachine::new();
        let t0 = now();
        sm.on(StateEvent::Start, t0, &budget);
        sm.on(StateEvent::PortReady, t0, &budget);
        for n in 1..=3u8 {
            let t = t0 + Duration::from_secs(u64::from(n));
            assert_eq!(
                sm.on(
                    StateEvent::CrashDetected {
                        reason: CrashReason::ProcessExit(n.into())
                    },
                    t,
                    &budget
                ),
                Transition::CrashEnter { restarts: n }
            );
            assert!(matches!(sm.state(), BrowserState::Crashed { restarts: m, .. } if m == n));
            sm.on(StateEvent::RestartTick, t, &budget);
            sm.on(StateEvent::PortReady, t, &budget);
        }
        // 第 4 次崩溃（仍在 30s 窗口内）→ 超限
        let t4 = t0 + Duration::from_secs(4);
        assert_eq!(
            sm.on(
                StateEvent::CrashDetected {
                    reason: CrashReason::ProcessExit(4)
                },
                t4,
                &budget
            ),
            Transition::CrashAbort { restarts: 4 }
        );
        assert_eq!(sm.state(), BrowserState::Stopped);
    }

    /// 窗口滑动：30s 前的崩溃不计入预算（重启继续）。
    #[test]
    fn crash_window_slides() {
        let budget = CrashBudget::default();
        let mut sm = StateMachine::new();
        let t0 = now();
        sm.on(StateEvent::Start, t0, &budget);
        sm.on(StateEvent::PortReady, t0, &budget);
        for n in 1..=3u8 {
            let t = t0 + Duration::from_secs(u64::from(n));
            assert!(matches!(
                sm.on(
                    StateEvent::CrashDetected {
                        reason: CrashReason::ProcessExit(1)
                    },
                    t,
                    &budget
                ),
                Transition::CrashEnter { .. }
            ));
            sm.on(StateEvent::RestartTick, t, &budget);
            sm.on(StateEvent::PortReady, t, &budget);
        }
        // 第 4 次崩溃发生在窗口之外（首个崩溃恰满 30s → 出窗剔除）→ 仍可重启
        let t_far = t0 + Duration::from_secs(31);
        let t = sm.on(
            StateEvent::CrashDetected {
                reason: CrashReason::ProcessExit(1),
            },
            t_far,
            &budget,
        );
        assert!(
            matches!(t, Transition::CrashEnter { restarts: 3 }),
            "窗口外崩溃不触发超限：{t:?}"
        );
        assert_eq!(sm.restarts(), 3);
        assert_eq!(
            sm.state(),
            BrowserState::Crashed {
                reason: CrashReason::ProcessExit(1),
                restarts: 3
            }
        );
    }

    /// 重启保留 restarts 计数与状态（§6.4 第 3 步语义）。
    #[test]
    fn restart_preserves_budget_state() {
        let budget = CrashBudget::default();
        let mut sm = StateMachine::new();
        let t0 = now();
        sm.on(StateEvent::Start, t0, &budget);
        sm.on(StateEvent::PortReady, t0, &budget);
        sm.on(
            StateEvent::CrashDetected {
                reason: CrashReason::CdpDisconnected,
            },
            t0 + Duration::from_secs(2),
            &budget,
        );
        assert_eq!(sm.restarts(), 1);
        assert_eq!(
            sm.on(
                StateEvent::RestartTick,
                t0 + Duration::from_secs(2),
                &budget
            ),
            Transition::RestartBrowser { restarts: 1 }
        );
        assert_eq!(sm.state(), BrowserState::Launching { attempt: 1 });
        assert_eq!(sm.restarts(), 1, "重启不清零崩溃计数");
    }

    /// 停止意图在崩溃窗口内 → 立即收敛（扩展语义回归）。
    #[test]
    fn stop_during_crash_window_converges() {
        let budget = CrashBudget::default();
        let mut sm = StateMachine::new();
        let t0 = now();
        sm.on(StateEvent::Start, t0, &budget);
        sm.on(StateEvent::PortReady, t0, &budget);
        sm.on(
            StateEvent::CrashDetected {
                reason: CrashReason::Unknown,
            },
            t0,
            &budget,
        );
        assert_eq!(
            sm.on(StateEvent::Stop { graceful: true }, t0, &budget),
            Transition::StoppedClean
        );
        assert_eq!(sm.state(), BrowserState::Stopped);
    }

    /// 幂等防线：Stopped 状态下除 Start 外全部事件非法。
    #[test]
    fn stopped_accepts_only_start() {
        let budget = CrashBudget::default();
        let mut sm = StateMachine::new();
        for event in [
            StateEvent::PortReady,
            StateEvent::LaunchFailed,
            StateEvent::Stop { graceful: true },
            StateEvent::Stop { graceful: false },
            StateEvent::CrashDetected {
                reason: CrashReason::Unknown,
            },
            StateEvent::RestartTick,
            StateEvent::StopExited,
            StateEvent::StopTimeout,
        ] {
            assert!(
                matches!(sm.on(event, now(), &budget), Transition::Invalid { .. }),
                "Stopped 状态必须拒绝：{event:?}"
            );
        }
    }

    // ---------- 崩溃窗口 30s 边界（评审 P2 补强：>= 出窗语义逐秒断言） ----------

    /// 驱动到 Running（时间戳注入起点）。
    fn run_to_running() -> StateMachine {
        let mut sm = StateMachine::new();
        sm.on(StateEvent::Start, now(), &CrashBudget::default());
        sm.on(StateEvent::PortReady, now(), &CrashBudget::default());
        sm
    }

    /// 在 t 时刻崩溃并立即重启回 Running（确定性序列）。
    fn crash_and_restart(sm: &mut StateMachine, t: Instant, budget: &CrashBudget) {
        sm.on(
            StateEvent::CrashDetected {
                reason: CrashReason::ProcessExit(1),
            },
            t,
            budget,
        );
        sm.on(StateEvent::RestartTick, t, budget);
        sm.on(StateEvent::PortReady, t, budget);
    }

    /// 29s 边界：第 4 次崩溃发生在首崩后 29s → 仍在窗内（29 < 30）→ CrashAbort。
    #[test]
    fn crash_window_29s_still_inside() {
        let budget = CrashBudget::default();
        let mut sm = run_to_running();
        let t0 = now();
        for sec in [0u64, 10, 20, 29] {
            if sec == 29 {
                let t = sm.on(
                    StateEvent::CrashDetected {
                        reason: CrashReason::ProcessExit(4),
                    },
                    t0 + Duration::from_secs(sec),
                    &budget,
                );
                assert_eq!(
                    t,
                    Transition::CrashAbort { restarts: 4 },
                    "29s 仍在窗口内 → 超限"
                );
                assert_eq!(sm.state(), BrowserState::Stopped);
            } else {
                crash_and_restart(&mut sm, t0 + Duration::from_secs(sec), &budget);
            }
        }
    }

    /// 恰好 30s 边界：`>= window` 视为出窗（record_crash 剔除语义）——
    /// 首崩恰满 30s 不计入 → 第 4 次崩溃仍可重启（restarts=3）。
    #[test]
    fn crash_window_exact_30s_outside() {
        let budget = CrashBudget::default();
        let mut sm = run_to_running();
        let t0 = now();
        for sec in [0u64, 10, 20] {
            crash_and_restart(&mut sm, t0 + Duration::from_secs(sec), &budget);
        }
        // 第 4 次崩溃恰在 t0+30s：now - oldest = 30s >= window → 出窗剔除
        let t = sm.on(
            StateEvent::CrashDetected {
                reason: CrashReason::ProcessExit(4),
            },
            t0 + Duration::from_secs(30),
            &budget,
        );
        assert!(
            matches!(t, Transition::CrashEnter { restarts: 3 }),
            "恰好 30s 必须按出窗处理（>= 语义）：{t:?}"
        );
        assert_eq!(sm.restarts(), 3, "30s 前崩溃已被剔除");
        // 出窗后的新基线：下一个崩溃距最早崩溃（t=10s）不足 30s → 窗口内 4 次 → 超限
        crash_and_restart(&mut sm, t0 + Duration::from_secs(35), &budget);
        let t = sm.on(
            StateEvent::CrashDetected {
                reason: CrashReason::ProcessExit(7),
            },
            t0 + Duration::from_secs(39),
            &budget,
        );
        assert_eq!(
            t,
            Transition::CrashAbort { restarts: 4 },
            "新窗口内 4 次 → 超限"
        );
    }

    /// 窗口滑动：29s 间隔连续崩溃，首崩逐渐滑出、计数按窗口收敛
    /// （滑动去旧语义：窗口是时间窗而非「最近 N 次」）。
    #[test]
    fn crash_window_slides_gradually() {
        let budget = CrashBudget::default();
        let mut sm = run_to_running();
        let t0 = now();
        // 第 1 次（t=0）→ restarts=1
        crash_and_restart(&mut sm, t0, &budget);
        assert_eq!(sm.restarts(), 1);
        // 第 2 次（t=29s）：0 仍在窗内（29 < 30）→ restarts=2
        crash_and_restart(&mut sm, t0 + Duration::from_secs(29), &budget);
        assert_eq!(sm.restarts(), 2);
        // 第 3 次（t=58s）：0 出窗（58-0 >= 30），29 在窗内（58-29=29 < 30）→ restarts=2
        crash_and_restart(&mut sm, t0 + Duration::from_secs(58), &budget);
        assert_eq!(
            sm.restarts(),
            2,
            "窗口滑动：最旧崩溃被剔除，计数不随次数单调"
        );
        // 第 4 次（t=87s）：29 出窗（87-29=58 >= 30），58 在窗内 → restarts=2 → 仍可重启
        let t = sm.on(
            StateEvent::CrashDetected {
                reason: CrashReason::ProcessExit(4),
            },
            t0 + Duration::from_secs(87),
            &budget,
        );
        assert!(
            matches!(t, Transition::CrashEnter { restarts: 2 }),
            "滑动窗口内始终只有 2 次 → 不超限：{t:?}"
        );
        assert_eq!(sm.restarts(), 2);
    }
}
