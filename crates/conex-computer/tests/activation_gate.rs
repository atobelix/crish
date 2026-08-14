//! ActivationGate 会话互斥测试(04 §2 S3 / 18 §6 契约面)。
//!
//! 覆盖:状态机全迁移表(合法/非法)、互斥拒绝与错误语义、释放后切换、
//! 重入幂等、并发请求串行化(多线程争抢)、清理清单契约(切换时返回对方清理项)、
//! 序列化契约(面板/工具层消费面)。
//!
//! 纯逻辑测试:不触碰任何设备,全平台可跑。

use std::sync::{Arc, Barrier};

use conex_computer::activation::{ActivationError, ActivationGate, CleanupAction, SessionMode};

/// 状态机操作(全迁移表用例的操作维度)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    /// 请求激活浏览器会话
    RequestBrowser,
    /// 请求激活电脑操作会话
    RequestDesktop,
    /// 释放当前会话回 Idle
    Release,
}

/// 将门驱动到指定初始态(Idle 时仅做幂等释放)
fn drive_to(gate: &ActivationGate, mode: SessionMode) {
    match mode {
        SessionMode::Idle => {
            gate.release();
        }
        SessionMode::BrowserActive => {
            gate.release();
            gate.request_browser().expect("驱动到浏览器态失败");
        }
        SessionMode::DesktopActive => {
            gate.release();
            gate.request_desktop().expect("驱动到桌面态失败");
        }
    }
}

/// 状态机全迁移表(合法/非法):9 组 (初始态 × 操作) 全覆盖。
/// 合法迁移:Idle→Browser、Idle→Desktop、任态→Idle(release)、同态重入;
/// 非法迁移:Browser↔Desktop 直接互斥拒绝(须经 Idle + 清理协议)。
#[test]
fn activation_state_machine_full_transition_table() {
    let cases: [(SessionMode, Op, bool, SessionMode); 9] = [
        // (初始态, 操作, 期望成功?, 期望终态)
        (
            SessionMode::Idle,
            Op::RequestBrowser,
            true,
            SessionMode::BrowserActive,
        ),
        (
            SessionMode::Idle,
            Op::RequestDesktop,
            true,
            SessionMode::DesktopActive,
        ),
        (SessionMode::Idle, Op::Release, true, SessionMode::Idle),
        (
            SessionMode::BrowserActive,
            Op::RequestBrowser,
            true,
            SessionMode::BrowserActive,
        ),
        (
            SessionMode::BrowserActive,
            Op::RequestDesktop,
            false,
            SessionMode::BrowserActive,
        ),
        (
            SessionMode::BrowserActive,
            Op::Release,
            true,
            SessionMode::Idle,
        ),
        (
            SessionMode::DesktopActive,
            Op::RequestDesktop,
            true,
            SessionMode::DesktopActive,
        ),
        (
            SessionMode::DesktopActive,
            Op::RequestBrowser,
            false,
            SessionMode::DesktopActive,
        ),
        (
            SessionMode::DesktopActive,
            Op::Release,
            true,
            SessionMode::Idle,
        ),
    ];
    for (idx, (init, op, expect_ok, expect_final)) in cases.into_iter().enumerate() {
        let gate = ActivationGate::new();
        drive_to(&gate, init);
        let ok = match op {
            Op::RequestBrowser => gate.request_browser().is_ok(),
            Op::RequestDesktop => gate.request_desktop().is_ok(),
            Op::Release => {
                gate.release();
                true
            }
        };
        assert_eq!(ok, expect_ok, "用例 {idx}: 初始 {init:?} 执行 {op:?}");
        assert_eq!(
            gate.current(),
            expect_final,
            "用例 {idx} 终态不符: 初始 {init:?} 执行 {op:?}"
        );
    }
}

/// 互斥拒绝 + 错误语义:Browser 活跃时 request_desktop 拒绝,
/// 错误携带当前/目标态,Display 含 `tool.session.exclusive`,状态不变。
#[test]
fn request_desktop_rejected_while_browser_active_with_exclusive_semantics() {
    let gate = ActivationGate::new();
    gate.request_browser().expect("激活浏览器失败");
    let err = gate.request_desktop().expect_err("应返回互斥错误");
    assert_eq!(
        err,
        ActivationError::Exclusive {
            current: SessionMode::BrowserActive,
            target: SessionMode::DesktopActive,
        }
    );
    assert!(
        err.to_string().contains("tool.session.exclusive"),
        "错误码缺失: {err}"
    );
    assert_eq!(
        gate.current(),
        SessionMode::BrowserActive,
        "被拒后状态不得改变"
    );
}

/// 互斥拒绝镜像:Desktop 活跃时 request_browser 拒绝
#[test]
fn request_browser_rejected_while_desktop_active_with_exclusive_semantics() {
    let gate = ActivationGate::new();
    gate.request_desktop().expect("激活桌面失败");
    let err = gate.request_browser().expect_err("应返回互斥错误");
    assert!(matches!(
        err,
        ActivationError::Exclusive {
            current: SessionMode::DesktopActive,
            target: SessionMode::BrowserActive,
        }
    ));
    assert!(err.to_string().contains("tool.session.exclusive"));
    assert_eq!(gate.current(), SessionMode::DesktopActive);
}

/// 释放后切换:先激活一方 → 释放 → 再激活另一方 → 再释放回 Idle
#[test]
fn release_then_switch_roundtrip() {
    let gate = ActivationGate::new();
    gate.request_browser().expect("激活浏览器失败");
    assert_eq!(gate.release(), SessionMode::BrowserActive);
    assert_eq!(gate.current(), SessionMode::Idle);
    gate.request_desktop().expect("激活桌面失败");
    assert_eq!(gate.current(), SessionMode::DesktopActive);
    assert_eq!(gate.release(), SessionMode::DesktopActive);
    assert_eq!(gate.current(), SessionMode::Idle);
}

/// release 语义:返回先前模式;Idle 时幂等空操作
#[test]
fn release_returns_previous_mode_and_is_idempotent() {
    let gate = ActivationGate::new();
    assert_eq!(gate.release(), SessionMode::Idle);
    assert_eq!(gate.current(), SessionMode::Idle);
    gate.request_browser().expect("激活浏览器失败");
    assert_eq!(gate.release(), SessionMode::BrowserActive);
    assert_eq!(gate.release(), SessionMode::Idle);
}

/// 重入幂等:同状态重复请求不报错、不改变状态
#[test]
fn reentrant_same_state_request_idempotent() {
    let gate = ActivationGate::new();
    for _ in 0..3 {
        gate.request_browser().expect("重入请求应幂等成功");
        assert_eq!(gate.current(), SessionMode::BrowserActive);
    }
    gate.release();
    for _ in 0..3 {
        gate.request_desktop().expect("重入请求应幂等成功");
        assert_eq!(gate.current(), SessionMode::DesktopActive);
    }
}

/// 并发请求串行化:16 线程同时请求浏览器,全部成功(CAS 首个迁移,其余幂等),
/// 终态唯一且为 BrowserActive。
#[test]
fn concurrent_same_side_requests_serialized() {
    const N: usize = 16;
    let gate = Arc::new(ActivationGate::new());
    let barrier = Arc::new(Barrier::new(N));
    let handles: Vec<_> = (0..N)
        .map(|_| {
            let gate = Arc::clone(&gate);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                gate.request_browser()
            })
        })
        .collect();
    for (i, h) in handles.into_iter().enumerate() {
        h.join()
            .expect("线程崩溃")
            .unwrap_or_else(|e| panic!("线程 {i} 请求应成功: {e}"));
    }
    assert_eq!(gate.current(), SessionMode::BrowserActive);
}

/// 并发互斥:8 浏览器 + 8 桌面线程从 Idle 争抢。
/// 不变量:仅一方胜出——所有成功请求同为胜方侧(首个迁移 + 其余幂等),
/// 所有败方侧请求返回互斥错误且错误码为 `tool.session.exclusive`。
#[test]
fn concurrent_opposing_requests_mutual_exclusion_holds() {
    const N: usize = 16;
    let gate = Arc::new(ActivationGate::new());
    let barrier = Arc::new(Barrier::new(N));
    let handles: Vec<_> = (0..N)
        .map(|i| {
            let gate = Arc::clone(&gate);
            let barrier = Arc::clone(&barrier);
            let want_desktop = i >= N / 2;
            std::thread::spawn(move || {
                barrier.wait();
                let result = if want_desktop {
                    gate.request_desktop()
                } else {
                    gate.request_browser()
                };
                (want_desktop, result)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|h| h.join().expect("线程崩溃"))
        .collect();
    let final_mode = gate.current();
    assert!(final_mode.is_active(), "争抢后必有一方活跃");
    let desktop_won = final_mode == SessionMode::DesktopActive;
    for (want_desktop, result) in results {
        match result {
            Ok(()) => {
                assert_eq!(
                    want_desktop, desktop_won,
                    "请求侧与胜方侧不符: 期望 {want_desktop} 成功但终态为 {final_mode:?}"
                );
            }
            Err(e) => {
                assert_ne!(
                    want_desktop, desktop_won,
                    "败方侧不应成功: {want_desktop} 但终态为 {final_mode:?}"
                );
                assert!(
                    e.to_string().contains("tool.session.exclusive"),
                    "错误码缺失: {e}"
                );
            }
        }
    }
    gate.release();
    assert_eq!(gate.current(), SessionMode::Idle);
}

/// 并发锤击压力:4 线程 × 2000 次混合操作(request/release),验证 CAS 循环
/// 无死锁/活锁/恐慌,终态始终为合法三态之一,最终释放回 Idle。
#[test]
fn concurrent_hammer_stress_state_integrity() {
    const THREADS: usize = 4;
    const OPS_PER_THREAD: usize = 2000;
    let gate = Arc::new(ActivationGate::new());
    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                for i in 0..OPS_PER_THREAD {
                    match (t + i) % 3 {
                        0 => {
                            let _ = gate.request_browser();
                        }
                        1 => {
                            let _ = gate.request_desktop();
                        }
                        _ => {
                            gate.release();
                        }
                    }
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("线程崩溃");
    }
    gate.release();
    assert_eq!(gate.current(), SessionMode::Idle, "释放后必回 Idle");
}

/// 清理清单契约:3×3 全矩阵——切换时返回对方清理项,
/// Idle/同态返回空清单;浏览器侧 2 项(帧流停/会话挂起)、桌面侧 2 项(注入复位/挂起)。
#[test]
fn cleanup_plan_contract_full_matrix() {
    let browser_clean = ActivationGate::browser_cleanup();
    assert_eq!(
        browser_clean,
        vec![
            CleanupAction::BrowserFrameStreamStop,
            CleanupAction::BrowserSessionSuspend,
        ]
    );
    let desktop_clean = ActivationGate::desktop_cleanup();
    assert_eq!(
        desktop_clean,
        vec![
            CleanupAction::DesktopInputReset,
            CleanupAction::DesktopSuspend
        ]
    );

    let cases: Vec<(SessionMode, SessionMode, Vec<CleanupAction>)> = vec![
        // (当前态, 目标态, 期望清理清单)
        (SessionMode::Idle, SessionMode::Idle, Vec::new()),
        (SessionMode::Idle, SessionMode::BrowserActive, Vec::new()),
        (SessionMode::Idle, SessionMode::DesktopActive, Vec::new()),
        (
            SessionMode::BrowserActive,
            SessionMode::BrowserActive,
            Vec::new(),
        ),
        (
            SessionMode::BrowserActive,
            SessionMode::DesktopActive,
            browser_clean.clone(),
        ),
        (SessionMode::BrowserActive, SessionMode::Idle, browser_clean),
        (
            SessionMode::DesktopActive,
            SessionMode::DesktopActive,
            Vec::new(),
        ),
        (
            SessionMode::DesktopActive,
            SessionMode::BrowserActive,
            desktop_clean.clone(),
        ),
        (SessionMode::DesktopActive, SessionMode::Idle, desktop_clean),
    ];
    for (idx, (init, target, expect)) in cases.into_iter().enumerate() {
        let gate = ActivationGate::new();
        drive_to(&gate, init);
        assert_eq!(
            gate.cleanup_plan(target),
            expect,
            "矩阵用例 {idx}: {init:?} → {target:?}"
        );
    }
}

/// 切换全协议(用户显式切换的接线顺序):
/// cleanup_plan(对方清理清单) → 调用方阻塞清理 → release → 重请求目标会话。
#[test]
fn switch_full_protocol_with_cleanup_plan() {
    let gate = ActivationGate::new();
    gate.request_browser().expect("激活浏览器失败");

    // Browser → Desktop:清理清单为浏览器侧 2 项
    assert_eq!(
        gate.cleanup_plan(SessionMode::DesktopActive),
        ActivationGate::browser_cleanup()
    );
    gate.release();
    gate.request_desktop().expect("激活桌面失败");
    assert_eq!(gate.current(), SessionMode::DesktopActive);

    // Desktop → Browser:清理清单为桌面侧 2 项
    assert_eq!(
        gate.cleanup_plan(SessionMode::BrowserActive),
        ActivationGate::desktop_cleanup()
    );
    gate.release();
    gate.request_browser().expect("激活浏览器失败");
    assert_eq!(gate.current(), SessionMode::BrowserActive);
}

/// 清理清单静态契约:两侧各恰 2 项,顺序即执行顺序(文档断言)
#[test]
fn cleanup_lists_contract_exact_entries() {
    let browser = ActivationGate::browser_cleanup();
    assert_eq!(browser.len(), 2);
    assert_eq!(browser[0], CleanupAction::BrowserFrameStreamStop);
    assert_eq!(browser[1], CleanupAction::BrowserSessionSuspend);
    let desktop = ActivationGate::desktop_cleanup();
    assert_eq!(desktop.len(), 2);
    assert_eq!(desktop[0], CleanupAction::DesktopInputReset);
    assert_eq!(desktop[1], CleanupAction::DesktopSuspend);
}

/// SessionMode 谓词与显示(工具面守卫与面板指示条消费面)
#[test]
fn session_mode_predicates_and_display() {
    assert!(!SessionMode::Idle.is_active());
    assert!(SessionMode::BrowserActive.is_active());
    assert!(SessionMode::DesktopActive.is_active());
    assert!(SessionMode::BrowserActive.is_browser());
    assert!(!SessionMode::DesktopActive.is_browser());
    assert!(SessionMode::DesktopActive.is_desktop());
    assert!(!SessionMode::BrowserActive.is_desktop());
    assert!(SessionMode::Idle.to_string().contains("Idle"));
    assert!(SessionMode::BrowserActive.to_string().contains("浏览器"));
    assert!(SessionMode::DesktopActive.to_string().contains("电脑操作"));
}

/// SessionMode 序列化契约(面板/事件总线消费面):snake_case 形态
#[test]
fn session_mode_serde_roundtrip() {
    for mode in [
        SessionMode::Idle,
        SessionMode::BrowserActive,
        SessionMode::DesktopActive,
    ] {
        let json = serde_json::to_string(&mode).expect("序列化失败");
        let back: SessionMode = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(mode, back);
    }
    assert_eq!(
        serde_json::to_string(&SessionMode::DesktopActive).expect("序列化失败"),
        r#""desktop_active""#
    );
}

/// CleanupAction 序列化契约(tag 形态,供工具层/审计层消费)
#[test]
fn cleanup_action_serde_roundtrip() {
    for action in [
        CleanupAction::BrowserFrameStreamStop,
        CleanupAction::BrowserSessionSuspend,
        CleanupAction::DesktopInputReset,
        CleanupAction::DesktopSuspend,
    ] {
        let json = serde_json::to_string(&action).expect("序列化失败");
        let back: CleanupAction = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(action, back);
    }
    assert_eq!(
        serde_json::to_string(&CleanupAction::BrowserFrameStreamStop).expect("序列化失败"),
        r#"{"kind":"browser_frame_stream_stop"}"#
    );
}

/// 默认构造与调试输出
#[test]
fn gate_default_and_debug() {
    let gate = ActivationGate::default();
    assert_eq!(gate.current(), SessionMode::Idle);
    assert!(format!("{gate:?}").contains("ActivationGate"));
    gate.request_browser().expect("激活浏览器失败");
    assert!(format!("{gate:?}").contains("BrowserActive"));
}
