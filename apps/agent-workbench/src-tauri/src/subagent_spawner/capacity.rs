use std::sync::Arc;

use super::tracking::RunTracking;

/// 生成后即参与容量预留的标识，避免 launcher 运行期间才产生 owner id。
pub(crate) struct SpawnIds {
    pub(crate) subagent_id: String,
    pub(crate) subagent_run_id: String,
    pub(crate) session_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReservationState {
    Pending,
    Launching,
    Settled,
}

/// 容量预留守卫：交给后台启动任务前取消时释放；移交后由后台失败收口或
/// 子代理真实终态消费 owner token。
pub(crate) struct CapacityReservation {
    tracking: Arc<RunTracking>,
    run_id: String,
    state: ReservationState,
}

impl CapacityReservation {
    pub(crate) fn new(tracking: Arc<RunTracking>, run_id: &str) -> Self {
        Self {
            tracking,
            run_id: run_id.to_string(),
            state: ReservationState::Pending,
        }
    }

    pub(crate) fn begin_launch(&mut self) {
        self.state = ReservationState::Launching;
    }

    pub(crate) fn transfer_to_background(&mut self) {
        self.state = ReservationState::Settled;
    }

    pub(crate) fn release_now(&mut self) {
        let _ = self.tracking.release_run_ownership(&self.run_id);
        self.state = ReservationState::Settled;
    }
}

impl Drop for CapacityReservation {
    fn drop(&mut self) {
        if self.state == ReservationState::Pending {
            self.tracking.cancel_pending_run(&self.run_id);
        }
    }
}
