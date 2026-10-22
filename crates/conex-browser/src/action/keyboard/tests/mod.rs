//! action::keyboard 单元测试：公共导入与 executor 构造辅助（自 keyboard.rs 平移）。

use super::*;
use crate::action::mocks::*;
use crate::action::{
    ActionError, ActionErrorKind, ActionExecutor, ElementMeta, ElementRef, TYPE_CHUNK_DELAY_MS,
};
use crate::cdp::sender::CancellationToken;
use std::sync::Arc;
use std::time::Duration;

mod keys;
mod select;
mod typing;
mod typing_verify;

fn executor(
    ops: MockOps,
    snapshot: MockSnapshotStore,
) -> (ActionExecutor, MockOps, Arc<RecordingDelay>) {
    let token = CancellationToken::new();
    let delay = Arc::new(RecordingDelay::new());
    let exec = ActionExecutor::new(Arc::new(ops.clone()), Arc::new(snapshot), token)
        .with_gate(Arc::new(AllowGate))
        .with_delay(delay.clone());
    (exec, ops, delay)
}
