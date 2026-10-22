use super::*;
use crate::action::mocks::*;
use crate::cdp::sender::CancellationToken;
use std::sync::Arc;

fn exec_with(
    ops: MockOps,
    snapshot: MockSnapshotStore,
) -> (
    ActionExecutor,
    MockOps,
    MockSnapshotStore,
    CancellationToken,
) {
    let token = CancellationToken::new();
    let executor = ActionExecutor::new(
        Arc::new(ops.clone()),
        Arc::new(snapshot.clone()),
        token.clone(),
    )
    .with_gate(Arc::new(AllowGate))
    .with_delay(Arc::new(RecordingDelay::new()));
    (executor, ops, snapshot, token)
}

fn click_req(version: u64, backend: i64) -> ActionRequest {
    ActionRequest {
        tab_id: "t1".to_string(),
        snapshot_version: version,
        element: Some(ElementRef {
            index: 0,
            backend_node_id: backend,
        }),
        primitive: Primitive::Click {
            button: MouseButton::Left,
            count: 1,
        },
    }
}

fn click_with_count(count: u8) -> ActionRequest {
    ActionRequest {
        tab_id: "t1".to_string(),
        snapshot_version: 1,
        element: Some(ElementRef {
            index: 0,
            backend_node_id: 11,
        }),
        primitive: Primitive::Click {
            button: MouseButton::Left,
            count,
        },
    }
}

mod pipeline_retry;
mod recovery;
mod validate;
