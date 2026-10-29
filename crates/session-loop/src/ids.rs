//! 会话消息 id 生成（单一来源）
//!
//! `{prefix}-{unix_millis}-{seq}`：全 crate 共用一个进程级单调序号，主循环
//! handler 与 steering 注入等调用点并发生成也互不重复（同毫秒内靠序号区分）。

use std::sync::atomic::{AtomicU64, Ordering};

/// 进程级消息 id 序号
static MESSAGE_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成唯一消息 id（前缀 + 毫秒时间戳 + 序号）
pub(crate) fn new_message_id(prefix: &str) -> String {
    let n = MESSAGE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", conex_shared::time::unix_millis())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use conex_types::message::AgentMessageMetadataKind;

    use super::new_message_id;
    use crate::steering::{build_steering_message, metadata_kind_wire, SteeringReason};

    /// R6：两调用点（handler 直调 / steering 注入构造）以同一前缀多线程并发
    /// 各生成 5000 个 id，合计 1 万个无重复
    #[test]
    fn concurrent_ids_from_both_call_sites_are_unique() {
        const THREADS_PER_SITE: usize = 4;
        const PER_THREAD: usize = 1250;
        let prefix = metadata_kind_wire(AgentMessageMetadataKind::Steering);
        let mut workers = Vec::new();
        for _ in 0..THREADS_PER_SITE {
            let prefix = prefix.clone();
            workers.push(std::thread::spawn(move || {
                (0..PER_THREAD)
                    .map(|_| new_message_id(&prefix))
                    .collect::<Vec<_>>()
            }));
            workers.push(std::thread::spawn(|| {
                (0..PER_THREAD)
                    .map(|_| build_steering_message(SteeringReason::ToolErrors, 1).id)
                    .collect::<Vec<_>>()
            }));
        }
        let mut seen = HashSet::new();
        for worker in workers {
            for id in worker.join().expect("生成线程不应 panic") {
                assert!(seen.insert(id), "消息 id 重复");
            }
        }
        assert_eq!(seen.len(), 2 * THREADS_PER_SITE * PER_THREAD);
    }
}
