//! 会话级显式开启状态机穷举测试（S4：04 §4.1——新会话默认关闭、用户显式
//! 开启、未开启时动作零副作用、session_meta 持久化键语义、并发互斥）。
//!
//! 验证面：
//! - enable / disable 状态机全转换（含严格转换：重复开启拒绝）；
//! - 未开启时动作准入拒绝（零副作用，不触碰输入设备 / 感知源）；
//! - session_meta 键名登记与持久化值 / 恢复语义（接线由引擎侧完成，
//!   本测试锁定键名常量与布尔语义）；
//! - 并发 enable 互斥（多线程恰好一个成功）。

use conex_computer::security::{
    COMPUTER_USE_ENABLED_KEY, EnableSource, EnablementError, SessionEnablement,
};
use std::sync::Arc;
use std::thread;

/// 新会话默认关闭（04 §4.1 第 2 点）：未开启 → 工具面不挂载、
/// 动作准入拒绝
#[test]
fn new_session_disabled_by_default() {
    let e = SessionEnablement::new();
    assert!(!e.enabled(), "新会话必须默认关闭");
    assert!(!e.tool_mount_allowed(), "未开启时工具面不挂载（S5 判据）");
    assert_eq!(
        e.check_action_allowed(),
        Err(EnablementError::NotEnabled),
        "未开启时动作准入拒绝"
    );
    assert_eq!(e.disabled_reason(), None, "从未开启无禁用原因");
}

/// enable(User) → 开启：工具面挂载 + 动作准入放行
#[test]
fn enable_transitions_to_enabled() {
    let e = SessionEnablement::new();
    e.enable(EnableSource::User).expect("首次开启应成功");
    assert!(e.enabled());
    assert!(e.tool_mount_allowed(), "开启后工具面允许挂载");
    assert!(e.check_action_allowed().is_ok(), "开启后动作准入放行");
}

/// 重复开启被拒（严格状态机：重复开启不被静默吸收），且不破坏已开启状态
#[test]
fn double_enable_rejected() {
    let e = SessionEnablement::new();
    e.enable(EnableSource::User).expect("首次开启应成功");
    assert_eq!(
        e.enable(EnableSource::User),
        Err(EnablementError::AlreadyEnabled),
        "重复开启必须被拒绝"
    );
    assert!(e.enabled(), "拒绝重复开启不影响已开启状态");
    assert!(e.check_action_allowed().is_ok());
}

/// 开启 → 关闭（挂起 / 急停 / 会话结束回 Idle 的清理路径）：
/// 关闭后动作准入立即拒绝，原因可追溯
#[test]
fn disable_closes_session() {
    let e = SessionEnablement::new();
    e.enable(EnableSource::User).expect("首次开启应成功");
    e.disable("空闲挂起（120s 无活动）");
    assert!(!e.enabled());
    assert_eq!(e.disabled_reason(), Some("空闲挂起（120s 无活动）".into()));
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

/// 关闭 → 重新显式开启（挂起恢复流程：恢复需重新显式开启，04 §4.4）
#[test]
fn reenable_after_disable() {
    let e = SessionEnablement::new();
    e.enable(EnableSource::User).unwrap();
    e.disable("空闲挂起");
    assert!(!e.enabled());
    e.enable(EnableSource::User).expect("关闭后可重新显式开启");
    assert!(e.enabled());
    assert_eq!(e.disabled_reason(), None, "重新开启后清除禁用原因");
}

/// 持久化语义：键名登记 + 落盘布尔值 + 启动恢复（覆盖式）
#[test]
fn session_meta_key_and_restore() {
    assert_eq!(
        COMPUTER_USE_ENABLED_KEY, "computer_use_enabled",
        "session_meta 键名必须与 04 §4.1 落盘键一致"
    );
    let e = SessionEnablement::new();
    assert!(!e.persisted_value(), "未开启 → 落盘 false");
    e.enable(EnableSource::User).unwrap();
    assert!(e.persisted_value(), "开启 → 落盘 true");

    // 引擎侧启动恢复：true → 开启态（来源恒为用户）
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
    overwrite.enable(EnableSource::User).unwrap();
    overwrite.restore_from_session_meta(false);
    assert!(!overwrite.enabled(), "恢复必须覆盖既有状态");
    assert_eq!(overwrite.disabled_reason(), None);
}

/// 未开启时动作拒绝：准入判据在审批之前（04 §4.2 守卫检查点），拒绝路径
/// 不改变任何状态（零副作用——本模块纯判据，无设备调用面）
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

/// 并发：多线程同时 enable，恰好一个成功，其余 AlreadyEnabled（互斥锁保护）
#[test]
fn concurrent_enable_exactly_one_succeeds() {
    let e = Arc::new(SessionEnablement::new());
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let e = Arc::clone(&e);
            thread::spawn(move || e.enable(EnableSource::User))
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let ok_count = results.iter().filter(|r| r.is_ok()).count();
    let denied_count = results
        .iter()
        .filter(|r| matches!(r, Err(EnablementError::AlreadyEnabled)))
        .count();
    assert_eq!(ok_count, 1, "并发开启必须恰好一个成功");
    assert_eq!(denied_count, 7, "其余线程必须收到 AlreadyEnabled");
    assert!(e.enabled());
}

/// 并发混合：enable / disable 轮流压测，最终状态一致、无锁死无 panic
/// （互斥锁不因争用损坏）
#[test]
fn concurrent_enable_disable_hammer() {
    let e = Arc::new(SessionEnablement::new());
    e.enable(EnableSource::User).unwrap();
    let threads: Vec<_> = (0..8)
        .map(|i| {
            let e = Arc::clone(&e);
            thread::spawn(move || {
                for _ in 0..50 {
                    if i % 2 == 0 {
                        let _ = e.enable(EnableSource::User);
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
    e.enable(EnableSource::User).expect("压测后仍可显式开启");
    assert!(e.enabled());
}
