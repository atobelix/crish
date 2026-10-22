//! 网络计数器与 CDP 错误分类测试。

use std::time::Duration;

use crate::action::ActionErrorKind;
use crate::action::ops::error::map_cdp_error;
use crate::action::ops::network::NetworkCounter;
use crate::cdp::bus::BrowserEvent;
use crate::cdp::error::CdpError;

/// CdpError → ActionError 分类映射（14 §5.1 表逐行回归，R-9）。
#[test]
fn cdp_error_classification() {
    let cases = vec![
        (
            CdpError::ContextGone {
                method: "m".to_string(),
                message: "Target closed".to_string(),
            },
            ActionErrorKind::TargetClosed,
        ),
        (
            CdpError::ContextGone {
                method: "m".to_string(),
                message: "Execution context was destroyed".to_string(),
            },
            ActionErrorKind::ContextGone,
        ),
        (
            CdpError::ContextGone {
                method: "m".to_string(),
                message: "Cannot find context with specified id".to_string(),
            },
            ActionErrorKind::ContextGone,
        ),
        (
            CdpError::ContextGone {
                method: "m".to_string(),
                message: "Frame was detached".to_string(),
            },
            ActionErrorKind::ContextGone,
        ),
        (CdpError::ConnectionLost, ActionErrorKind::ConnectionLost),
        (
            CdpError::Timeout {
                method: "m".to_string(),
                elapsed: Duration::from_secs(1),
            },
            ActionErrorKind::Timeout,
        ),
        (
            CdpError::Cancelled {
                reason: crate::cdp::error::CancelReason::Aborted,
            },
            ActionErrorKind::Aborted,
        ),
        (
            CdpError::ApprovalDenied {
                reason: "no".to_string(),
            },
            ActionErrorKind::ApprovalDenied,
        ),
        (
            CdpError::NotReady("重启中".to_string()),
            ActionErrorKind::TargetRestarting,
        ),
        (CdpError::NoActiveTab, ActionErrorKind::TargetClosed),
        (
            CdpError::Server {
                code: -32000,
                message: "No node with given id found".to_string(),
            },
            ActionErrorKind::NodeStale,
        ),
        (
            CdpError::Server {
                code: -32000,
                message: "Could not compute box model".to_string(),
            },
            ActionErrorKind::NodeStale,
        ),
        (
            CdpError::BadParams {
                method: "m".to_string(),
                message: "bad".to_string(),
            },
            ActionErrorKind::InvalidInput,
        ),
        // M4：内部/序列化错误不得归 ContextGone（重试不会自愈，Fatal 不重试）
        (
            CdpError::Internal {
                method: Some("m".to_string()),
                message: "锁中毒恢复".to_string(),
            },
            ActionErrorKind::Unsupported,
        ),
        (
            CdpError::Serialize {
                method: "m".to_string(),
                message: "信封编码失败".to_string(),
            },
            ActionErrorKind::Unsupported,
        ),
        (
            CdpError::DomainUnavailable {
                method: "m".to_string(),
            },
            ActionErrorKind::Unsupported,
        ),
    ];
    for (cdp, expected) in cases {
        let mapped = map_cdp_error(cdp, "test");
        assert_eq!(mapped.kind, expected, "分类不符：{}", mapped.message);
        assert!(mapped.cdp_raw.is_some(), "应携带 CDP 错误原文");
    }
}

/// 在途计数维护（wait_for NetworkIdle 输入面）。
#[tokio::test]
async fn network_counter_tracks_in_flight() {
    let bus = crate::cdp::bus::BusHandle::new(64, 4);
    let counter = NetworkCounter::new(bus.subscribe());
    bus.publish(BrowserEvent::NetworkRequest {
        request_id: "r1".to_string(),
        url: "https://e.com".to_string(),
        method: "GET".to_string(),
        status: None,
    });
    bus.publish(BrowserEvent::NetworkRequest {
        request_id: "r2".to_string(),
        url: "https://e.com".to_string(),
        method: "GET".to_string(),
        status: None,
    });
    // 订阅任务异步消费
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(counter.in_flight(), 2);
    bus.publish(BrowserEvent::NetworkDone {
        request_id: "r1".to_string(),
        ok: true,
        size: None,
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(counter.in_flight(), 1, "loadingFinished 应减一");
}

/// M3：Drop 后订阅任务终止——不再泄漏常驻任务（任务不持有 Arc<Self> 自保活）。
#[tokio::test]
async fn network_counter_task_terminates_on_drop() {
    let bus = crate::cdp::bus::BusHandle::new(64, 4);
    let counter = NetworkCounter::new(bus.subscribe());
    let abort = counter.handle.abort_handle();
    bus.publish(BrowserEvent::NetworkRequest {
        request_id: "r1".to_string(),
        url: "https://e.com".to_string(),
        method: "GET".to_string(),
        status: None,
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(counter.in_flight(), 1, "Drop 前计数正常");
    assert!(!abort.is_finished(), "Drop 前任务存活");
    drop(counter);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if abort.is_finished() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Drop 后订阅任务必须终止"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
