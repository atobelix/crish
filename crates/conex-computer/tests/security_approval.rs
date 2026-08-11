//! 全动作审批状态机穷举测试（S4：04 §4.2——Ask 逐次审批、三态裁决、
//! 载荷字段、并发互斥、急停竞态）。
//!
//! 验证面：
//! - require_approval → Pending（在途登记）→ settle 收口（Granted / Denied）；
//! - 三态约束：Pending 不能作裁决、id 不匹配拒绝、一次一票（重复裁决拒绝）；
//! - 载荷字段：动作名 + 参数摘要 + 目标窗口标题 + 物理坐标（04 §4.2）；
//! - 并发：在途期间并发请求拒绝；多线程发起恰好一个 Pending；
//! - 急停竞态：急停后不发起审批、Pending 中急停只接受拒绝裁决、
//!   复位后恢复审批流。

use conex_computer::coord::Point;
use conex_computer::security::{
    Approval, ApprovalError, ApprovalGate, ApprovalRequest, EmergencyStop,
};
use std::sync::Arc;
use std::thread;

/// 构造 type 类动作审批载荷（`type` 参数摘要载明文，04 §4.2）
fn type_request() -> ApprovalRequest {
    ApprovalRequest {
        action: "computer_type".into(),
        params_summary: "type 明文：rm -rf /tmp/x".into(),
        window_title: Some("记事本".into()),
        position: None,
    }
}

/// 发起审批 → Pending（在途登记，序号自 1 起）
#[test]
fn require_returns_pending_and_registers() {
    let gate = ApprovalGate::new();
    let request = type_request();
    let Approval::Pending { id } = gate.require_approval(request.clone()) else {
        panic!("首次发起必须 Pending");
    };
    assert!(id >= 1, "序号自 1 起");
    assert_eq!(gate.pending(), Some((id, request)), "在途登记必须可见");
}

/// 放行裁决：settle(Granted) → Granted 收口，在途清空，裁决可查
#[test]
fn settle_granted_closes_pending() {
    let gate = ApprovalGate::new();
    let Approval::Pending { id } = gate.require_approval(type_request()) else {
        panic!("应 Pending");
    };
    let verdict = gate.settle(id, Approval::Granted).expect("放行裁决应成功");
    assert_eq!(verdict, Approval::Granted);
    assert_eq!(gate.pending(), None, "裁决后无在途");
    let (last_id, _, last) = gate.last_verdict().expect("应有最近裁决");
    assert_eq!(last_id, id);
    assert_eq!(last, Approval::Granted);
}

/// 拒绝裁决：Denied 收口（零注入语义面——拒绝即不执行）
#[test]
fn settle_denied_closes_pending() {
    let gate = ApprovalGate::new();
    let Approval::Pending { id } = gate.require_approval(type_request()) else {
        panic!("应 Pending");
    };
    let verdict = gate
        .settle(id, Approval::Denied { reason: "用户拒绝".into() })
        .expect("拒绝裁决应成功");
    assert_eq!(verdict, Approval::Denied { reason: "用户拒绝".into() });
    assert_eq!(gate.pending(), None);
}

/// 逐次审批语义：在途期间并发请求被拒；收口后可再发起（序号递增）
#[test]
fn sequential_approval_one_at_a_time() {
    let gate = ApprovalGate::new();
    let Approval::Pending { id: first_id } = gate.require_approval(type_request()) else {
        panic!("应 Pending");
    };
    match gate.require_approval(type_request()) {
        Approval::Denied { reason } => {
            assert!(reason.contains("并发"), "拒绝原因应说明并发语义：{reason}")
        }
        other => panic!("在途期间并发请求必须拒绝，实得 {other:?}"),
    }
    gate.settle(first_id, Approval::Granted).unwrap();
    let Approval::Pending { id: second_id } = gate.require_approval(type_request()) else {
        panic!("收口后应可再发起");
    };
    assert_ne!(first_id, second_id, "审批序号必须递增");
    gate.settle(second_id, Approval::Granted).unwrap();
}

/// 裁决约束穷举：Pending 不能作裁决；id 不匹配拒绝；一次一票（重复拒绝）
#[test]
fn settle_constraints() {
    let gate = ApprovalGate::new();
    let Approval::Pending { id } = gate.require_approval(type_request()) else {
        panic!("应 Pending");
    };
    // Pending 不能作为裁决注入
    assert_eq!(
        gate.settle(id, Approval::Pending { id: 99 }),
        Err(ApprovalError::InvalidVerdict)
    );
    // id 不匹配：在途是 id，注入 id+100 → NoSuchApproval（在途不被消费）
    assert_eq!(
        gate.settle(id + 100, Approval::Granted),
        Err(ApprovalError::NoSuchApproval(id + 100))
    );
    // 正常裁决后重复注入同一 id → AlreadySettled（一次一票）
    gate.settle(id, Approval::Denied { reason: "r".into() }).unwrap();
    assert_eq!(
        gate.settle(id, Approval::Granted),
        Err(ApprovalError::AlreadySettled)
    );
    // 无在途且非最近 id → NoSuchApproval
    assert!(matches!(
        gate.settle(42, Approval::Granted),
        Err(ApprovalError::NoSuchApproval(42))
    ));
}

/// 审批载荷：动作名 + 参数摘要 + 目标窗口标题 + 物理坐标全字段传递
/// （04 §4.2 审批载荷四要素）
#[test]
fn approval_payload_carries_window_title_and_position() {
    let request = ApprovalRequest {
        action: "computer_click".into(),
        params_summary: "left_click".into(),
        window_title: Some("记事本 - 无标题".into()),
        position: Some(Point::new(683, 384)),
    };
    let gate = ApprovalGate::new();
    let Approval::Pending { id } = gate.require_approval(request.clone()) else {
        panic!("应 Pending");
    };
    assert_eq!(gate.pending().map(|(_, r)| r), Some(request.clone()));
    gate.settle(id, Approval::Granted).unwrap();
    assert_eq!(gate.last_verdict().map(|(_, r, _)| r), Some(request));
}

/// 载荷便捷构造：new(action, summary) 窗口标题与坐标缺省为 None
#[test]
fn approval_request_new_defaults_optional_fields() {
    let request = ApprovalRequest::new("computer_wait", "wait 5s");
    assert_eq!(request.action, "computer_wait");
    assert_eq!(request.params_summary, "wait 5s");
    assert_eq!(request.window_title, None);
    assert_eq!(request.position, None);
}

/// 急停竞态 1：急停生效后发起审批 → 拒绝（不发起、零注入、零状态残留）
#[test]
fn estop_blocks_new_approval() {
    let stop = Arc::new(EmergencyStop::new());
    let gate = ApprovalGate::with_stop(Arc::clone(&stop));
    stop.panel_stop();
    match gate.require_approval(type_request()) {
        Approval::Denied { reason } => {
            assert!(reason.contains("急停"), "拒绝原因应说明急停：{reason}")
        }
        other => panic!("急停后审批必须拒绝，实得 {other:?}"),
    }
    assert_eq!(gate.pending(), None, "拒绝路径零状态残留");
}

/// 急停竞态 2：审批 Pending 中急停 → 只接受拒绝裁决（放行被拒：
/// 急停后绝不触碰输入设备）
#[test]
fn estop_during_pending_only_accepts_deny() {
    let stop = Arc::new(EmergencyStop::new());
    let gate = ApprovalGate::with_stop(Arc::clone(&stop));
    let Approval::Pending { id } = gate.require_approval(type_request()) else {
        panic!("应 Pending");
    };
    stop.global_stop();
    assert_eq!(
        gate.settle(id, Approval::Granted),
        Err(ApprovalError::Stopped),
        "急停后禁止放行裁决"
    );
    let verdict = gate
        .settle(id, Approval::Denied { reason: "急停取消审批".into() });
    assert!(
        matches!(verdict, Ok(Approval::Denied { .. })),
        "急停后拒绝裁决可收口（不留悬挂审批），实得 {verdict:?}"
    );
    assert_eq!(gate.pending(), None);
}

/// 急停竞态 3：急停 + 复位后可恢复正常审批流
#[test]
fn estop_reset_restores_approval_flow() {
    let stop = Arc::new(EmergencyStop::new());
    let gate = ApprovalGate::with_stop(Arc::clone(&stop));
    stop.hotkey_trigger();
    assert!(matches!(
        gate.require_approval(type_request()),
        Approval::Denied { .. }
    ));
    stop.reset();
    let Approval::Pending { id } = gate.require_approval(type_request()) else {
        panic!("复位后审批流必须恢复");
    };
    assert_eq!(gate.settle(id, Approval::Granted), Ok(Approval::Granted));
}

/// 急停竞态 4：急停旗复位前拒绝裁决可收口悬挂审批（急停 → 拒绝 → 复位，
/// 完整生命周期的零悬挂保证）
#[test]
fn estop_deny_then_reset_leaves_no_dangling() {
    let stop = Arc::new(EmergencyStop::new());
    let gate = ApprovalGate::with_stop(Arc::clone(&stop));
    let Approval::Pending { id } = gate.require_approval(type_request()) else {
        panic!("应 Pending");
    };
    stop.panel_stop();
    gate.settle(id, Approval::Denied { reason: "急停".into() }).unwrap();
    stop.reset();
    assert_eq!(gate.pending(), None, "复位后不得有悬挂审批");
    let Approval::Pending { id: id2 } = gate.require_approval(type_request()) else {
        panic!("应 Pending");
    };
    assert_eq!(gate.settle(id2, Approval::Granted), Ok(Approval::Granted));
}

/// 并发：多线程同时发起审批 → 恰好一个 Pending，其余拒绝（单次审批 +
/// 互斥锁保护）
#[test]
fn concurrent_require_exactly_one_pending() {
    let gate = Arc::new(ApprovalGate::new());
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let gate = Arc::clone(&gate);
            thread::spawn(move || gate.require_approval(type_request()))
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let pending_count = results
        .iter()
        .filter(|r| matches!(r, Approval::Pending { .. }))
        .count();
    let denied_count = results
        .iter()
        .filter(|r| matches!(r, Approval::Denied { .. }))
        .count();
    assert_eq!(pending_count, 1, "并发发起必须恰好一个 Pending");
    assert_eq!(denied_count, 7, "其余必须被并发拒绝");
    // 收口：对在途 Pending 注入拒绝裁决（避免悬挂，同时验证竞态产物可裁决）
    let gate = Arc::try_unwrap(gate).expect("引用计数应归零");
    let (id, _) = gate.pending().expect("应存在在途审批");
    gate.settle(id, Approval::Denied { reason: "并发测试收口".into() })
        .expect("并发测试的 Pending 应可裁决");
    assert_eq!(gate.pending(), None);
}
