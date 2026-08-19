//! 会话级显式开启状态机穷举测试（维度 1 收敛后：新会话默认关闭、
//! 用户显式开启、未开启时动作零副作用、session_meta 持久化键语义、并发互斥）。
//!
//! 验证面：
//! - enable / disable 状态机全转换（重复开启按幂等吸收）；
//! - 未开启时动作准入拒绝（零副作用，不触碰输入设备 / 感知源）；
//! - session_meta 键名登记与持久化值 / 恢复语义（接线由引擎侧完成，
//!   本测试锁定键名常量与布尔语义）；
//! - 并发 enable 互斥（多线程安全）。

use conex_computer::security::{
    EnablementError, SessionEnablement, COMPUTER_USE_ENABLED_KEY,
};
use std::sync::Arc;
use std::thread;

/// 新会话默认关闭：未开启 → 工具面不挂载、动作准入拒绝
#[test]
fn new_session_disabled_by_default() {
    let e = SessionEnablement::new();
    assert!(!e.enabled(), "新会话必须默认关闭");
    assert!(!e.tool_mount_allowed(), "未开启时工具面不挂载");
    assert_eq!(
        e.check_action_allowed(),
        Err(EnablementError::NotEnabled),
        "未开启时动作准入拒绝"
    );
    assert_eq!(e.disabled_reason(), None, "从未开启无禁用原因");
}

/// enable → 开启：工具面挂载 + 动作准入放行
#[test]
fn enable_transitions_to_enabled() {
    let e = SessionEnablement::new();
    e.enable().expect("首次开启应成功");
    assert!(e.enabled());
    assert!(e.tool_mount_allowed(), "开启后工具面允许挂载");
    assert!(e.check_action_allowed().is_ok(), "开启后动作准入放行");
}

/// 重复开启按幂等吸收（维度 1 收敛：开启即承担责任，不报错）
#[test]
fn double_enable_is_idempotent() {
    let e = SessionEnablement::new();
    e.enable().expect("首次开启应成功");
    e.enable().expect("重复开启应幂等返回 Ok");
    assert!(e.enabled(), "重复开启不影响已开启状态");
    assert!(e.check_action_allowed().is_ok());
}

/// 开启 → 关闭（停止 / 会话结束回 Idle 的清理路径）：
/// 关闭后动作准入立即拒绝，原因可追溯
#[test]
fn disable_closes_session() {
    let e = SessionEnablement::new();
    e.enable().expect("首次开启应成功");
    e.disable("run 级停止");
    assert!(!e.enabled());
    assert_eq!(e.disabled_reason(), Some("run 级停止".into()));
    assert_eq!(
        e.check_action_allowed(),
        Err(EnablementError::NotEnabled),
        "关闭后动作准入拒绝（零副作用）"
    );
}

/// 已关闭时重复 disable 不报错，仅覆盖原因（清理路径可重复调用）
#[test]
fn disable_when_disabled_overwrites_reason_only() {
    let e = SessionEnablement::new();
    e.disable("会话结束清理");
    assert!(!e.enabled());
    e.disable("重复清理（原因覆盖）");
    assert!(!e.enabled());
    assert_eq!(e.disabled_reason(), Some("重复清理（原因覆盖）".into()));
}

/// 关闭 → 重新显式开启（恢复流程：恢复需重新显式开启）
#[test]
fn reenable_after_disable() {
    let e = SessionEnablement::new();
    e.enable().unwrap();
    e.disable("run 级停止");
    assert!(!e.enabled());
    e.enable().expect("关闭后可重新显式开启");
    assert!(e.enabled());
    assert_eq!(e.disabled_reason(), None, "重新开启后清除禁用原因");
}

/// 持久化语义：键名登记 + 落盘布尔值 + 启动恢复（覆盖式）
#[test]
fn session_meta_key_and_restore() {
    assert_eq!(
        COMPUTER_USE_ENABLED_KEY, "computer_use_enabled",
        "session_meta 键名必须与落盘键一致"
    );
    let e = SessionEnablement::new();
    assert!(!e.persisted_value(), "未开启 → 落盘 false");
    e.enable().unwrap();
    assert!(e.persisted_value(), "开启 → 落盘 true");

    // 引擎侧启动恢复：true → 开启态
    let restored_on = SessionEnablement::new();
    restored_on.restore_from_session_meta(true);
    assert!(restored_on.enabled());
    assert!(restored_on.persisted_value());
    assert!(restored_on.check_action_allowed().is_ok());

    // false → 关闭态
    let restored_off = SessionEnablement::new();
    restored_off.restore_from_session_meta(false);
    assert!(!restored_off.enabled());

    // 覆盖式恢复：已开启状态被 false 覆盖（引擎侧以 session_meta 为权威）
    let overwrite = SessionEnablement::new();
    overwrite.enable().unwrap();
    overwrite.restore_from_session_meta(false);
    assert!(!overwrite.enabled(), "恢复必须覆盖既有状态");
    assert_eq!(overwrite.disabled_reason(), None);
}

/// 未开启时动作拒绝：准入判据在执行之前，拒绝路径不改变任何状态
/// （零副作用——本模块纯判据，无设备调用面）
#[test]
fn not_enabled_action_rejected_zero_side_effect() {
    let e = SessionEnablement::new();
    for _ in 0..3 {
        assert_eq!(e.check_action_allowed(), Err(EnablementError::NotEnabled));
        assert!(!e.enabled(), "拒绝路径不得改变开启状态");
        assert!(!e.persisted_value(), "拒绝路径不得污染持久化值");
        assert_eq!(e.disabled_reason(), None, "拒绝路径不得登记原因");
    }
}

/// 并发：多线程同时 enable，全部成功（幂等语义，互斥锁保护线程安全）
#[test]
fn concurrent_enable_all_succeed() {
    let e = Arc::new(SessionEnablement::new());
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let e = Arc::clone(&e);
            thread::spawn(move || e.enable())
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let ok_count = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(ok_count, 8, "并发开启全部成功（幂等语义）");
    assert!(e.enabled());
}

/// 并发混合：enable / disable 轮流压测，最终状态一致、无锁死无 panic
/// （互斥锁不因争用损坏）
#[test]
fn concurrent_enable_disable_hammer() {
    let e = Arc::new(SessionEnablement::new());
    e.enable().unwrap();
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let e = Arc::clone(&e);
            thread::spawn(move || {
                for _ in 0..50 {
                    if i % 2 == 0 {
                        let _ = e.enable();
                    } else {
                        e.disable(format!("压测线程 {i}"));
                    }
                }
            })
        })
        .collect();
    for t in threads {
        t.join().expect("压测线程不得 panic");
    }
    // 压测后状态机仍可正常转换（互斥锁未损坏、状态未撕裂）
    e.disable("压测结束");
    assert!(!e.enabled());
    e.enable().expect("压测后仍可显式开启");
    assert!(e.enabled());
}
