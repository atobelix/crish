//! relay server 体积拆分测试（M7）。

use super::*;

#[test]
fn ticket_replay_guard_blocks_second_use() {
    let replay = TicketReplay::default();
    assert!(replay.mark("jti-1", now_ms_u64() / 1000 + 60));
    assert!(!replay.mark("jti-1", now_ms_u64() / 1000 + 60));
}
