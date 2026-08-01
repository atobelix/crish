//! 事件缓冲（B6.3：按 runId 事件队列 + 高水位丢帧策略，03 §5.3-6）
//!
//! 背压内移：事件在**入队时即序列化**为 payload 字符串（AA-06 P9，
//! EventBuffer 存 `(DropClass, String)`），丢帧判定只需事件类别，
//! flush 直接 emit 字符串。
//!
//! 丢帧类目（PE-09 §0.3 契约点 2 / T11.5.3 锚定 `buffer.rs:41-58` 语义）：
//! - [DropClass::Soft]（Delta）：`message-delta` 可丢——前端以 message-end
//!   全文兜底（03 §5.3-6 / EventRouter.ts:240-250），丢帧不丢 message-end；
//! - [DropClass::Critical]：terminal / 审批 / 工具等事件**永不丢**
//!   （含 message-end 全文兜底，03 §5.1-6）。
//!
//! 水位语义：
//! - `soft_limit`（Soft 水位）：优先丢 **Soft 旧帧**（最早的 message-delta）
//!   为新事件腾位；缓冲全 Critical 时新 Soft 事件直接丢（不占用空间）；
//! - `critical_limit`（Critical 水位）：新 **Critical 事件永不丢**——先驱逐
//!   现有 Soft 旧帧；无 Soft 可驱逐时缓冲可超限（防御性接受）。

use std::collections::{HashMap, VecDeque};

use conex_types::events::AgentEvent;

/// 丢帧类目（03 §5.3-6：delta 可丢、terminal/审批/工具不可丢）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropClass {
    /// 可丢（message-delta；message-end 全文兜底）
    Soft,
    /// 永不丢（terminal / 审批 / 工具 / message-end 等）
    Critical,
}

/// 事件类别 → 丢帧类目
///
/// 仅 `message-delta` 属 [DropClass::Soft]（T09.1 实时轨/收口轨共用，
/// 丢帧不丢 message-end——03 §5.3-6 契约）。
pub fn drop_class_of(event: &AgentEvent) -> DropClass {
    if matches!(event, AgentEvent::MessageDelta { .. }) {
        DropClass::Soft
    } else {
        DropClass::Critical
    }
}

/// 入队结果（S-8 修复：丢帧可观测，供 [crate::core_event_bridge::EmitReport]
/// 汇入 tracing 计数）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnqueueOutcome {
    /// 是否实际入队
    pub buffered: bool,
    /// 因背压被丢弃的条数
    pub dropped: usize,
}

/// 单个 run 的事件队列（按插入序）
#[derive(Debug, Default)]
struct RunQueue {
    entries: VecDeque<(DropClass, String)>,
}

/// 按 runId 的事件缓冲（高水位丢 Delta 旧帧，Critical 永不丢）
///
/// 线程安全：经调用方持有（[std::sync::Mutex<EventBuffer>]），锁不跨 await
/// 持有（AA-02 并发模型注记）；buffer.rs 与 buffer.rs 测试均不依赖 Tauri。
#[derive(Debug)]
pub struct EventBuffer {
    /// Soft 水位（达此水位后优先丢 Soft 旧帧）
    soft_limit: usize,
    /// Critical 水位（达此水位后新 Soft 事件直接丢）
    critical_limit: usize,
    /// run_id → 事件队列
    runs: HashMap<String, RunQueue>,
}

impl EventBuffer {
    /// 新建事件缓冲（显式水位）
    pub fn new(soft_limit: usize, critical_limit: usize) -> Self {
        Self {
            soft_limit: soft_limit.max(1),
            critical_limit: critical_limit.max(soft_limit.max(1)),
            runs: HashMap::new(),
        }
    }

    /// 入队一条已序列化的事件载荷（按 runId 缓冲）
    ///
    /// 丢帧规则（03 §5.3-6 / PE-09 §0.3 契约点 2）：
    /// 1. 已达 Critical 水位 → 先驱逐 Soft 旧帧（Critical 永不丢）；
    /// 2. Soft 事件：已达 Soft 水位 → 优先丢 Soft 旧帧；缓冲全 Critical 时
    ///    丢本帧自身（不占用空间）；
    /// 3. Critical 事件：永不丢（无 Soft 可驱逐时缓冲可超限）。
    pub fn enqueue(&mut self, run_id: &str, class: DropClass, payload: String) -> EnqueueOutcome {
        let queue = self.runs.entry(run_id.to_string()).or_default();
        let mut dropped = 0usize;

        // 1. Critical 水位：先为 Critical 事件腾位（驱逐 Soft 旧帧）
        while queue.entries.len() >= self.critical_limit {
            if let Some(position) = queue
                .entries
                .iter()
                .position(|(c, _)| matches!(c, DropClass::Soft))
            {
                queue.entries.remove(position);
                dropped += 1;
            } else {
                // 全 Critical：永不丢，接受超限（防御性）
                break;
            }
        }

        match class {
            DropClass::Soft => {
                if queue.entries.len() >= self.soft_limit {
                    // Soft 水位：优先丢最早的 Soft 旧帧
                    if let Some(position) = queue
                        .entries
                        .iter()
                        .position(|(c, _)| matches!(c, DropClass::Soft))
                    {
                        queue.entries.remove(position);
                        dropped += 1;
                    } else {
                        // 缓冲已全 Critical：丢本帧自身（可丢类目）
                        return EnqueueOutcome {
                            buffered: false,
                            dropped: dropped + 1,
                        };
                    }
                }
                queue.entries.push_back((class, payload));
                EnqueueOutcome {
                    buffered: true,
                    dropped,
                }
            }
            DropClass::Critical => {
                // Critical 永不丢
                queue.entries.push_back((class, payload));
                EnqueueOutcome {
                    buffered: true,
                    dropped,
                }
            }
        }
    }

    /// 冲刷指定 run 的缓冲（按插入序返回全部待发载荷；冲刷后清空）
    pub fn drain(&mut self, run_id: &str) -> Vec<String> {
        self.runs
            .remove(run_id)
            .map(|queue| queue.entries.into_iter().map(|(_, payload)| payload).collect())
            .unwrap_or_default()
    }

    /// 指定 run 的缓冲长度（观测）
    pub fn len(&self, run_id: &str) -> usize {
        self.runs.get(run_id).map(|q| q.entries.len()).unwrap_or(0)
    }

    /// 是否为空（观测）
    pub fn is_empty(&self) -> bool {
        self.runs.values().all(|q| q.entries.is_empty())
    }

    /// 缓冲中待发的总条数（观测）
    pub fn total_len(&self) -> usize {
        self.runs.values().map(|q| q.entries.len()).sum()
    }

    /// 已缓冲的 run id 列表（观测）
    pub fn run_ids(&self) -> Vec<String> {
        self.runs.keys().cloned().collect()
    }

    /// 丢弃整个 run 的缓冲（run 终态清理；返回被丢弃条数）
    pub fn remove_run(&mut self, run_id: &str) -> usize {
        self.runs
            .remove(run_id)
            .map(|q| q.entries.len())
            .unwrap_or(0)
    }

    /// 清空全部缓冲
    pub fn clear(&mut self) {
        self.runs.clear();
    }
}

impl Default for EventBuffer {
    fn default() -> Self {
        // 默认水位：Soft 64 / Critical 256（高密度 delta 流下先丢 delta 旧帧，
        // terminal/审批/工具事件常驻）
        Self::new(64, 256)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::message::AgentMessageBlock;

    fn delta(message_id: &str) -> AgentEvent {
        AgentEvent::MessageDelta {
            session_id: "s1".to_string(),
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            message_id: message_id.to_string(),
            block: AgentMessageBlock::Text {
                text: "chunk".to_string(),
            },
        }
    }

    fn terminal() -> AgentEvent {
        AgentEvent::RunTerminal {
            session_id: "s1".to_string(),
            run_id: "r1".to_string(),
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            terminal: conex_types::events::RunTerminalStatus::Completed,
            error: None,
        }
    }

    /// 类目判定：只有 message-delta 可丢（03 §5.3-6 契约）
    #[test]
    fn drop_class_mapping() {
        assert_eq!(drop_class_of(&delta("m1")), DropClass::Soft);
        assert_eq!(drop_class_of(&terminal()), DropClass::Critical);
        assert_eq!(
            drop_class_of(&AgentEvent::AgentStart {
                session_id: "s1".to_string(),
                timestamp: "t".to_string(),
            }),
            DropClass::Critical,
            "agent-start 不可丢"
        );
        assert_eq!(
            drop_class_of(&AgentEvent::MessageEnd {
                session_id: "s1".to_string(),
                message: std::sync::Arc::new(conex_types::message::AgentMessage {
                    id: "m1".to_string(),
                    role: conex_types::message::AgentMessageRole::Assistant,
                    created_at: "t".to_string(),
                    blocks: Vec::new(),
                    metadata: None,
                    client_message_id: None,
                    content: None,
                }),
            }),
            DropClass::Critical,
            "message-end 必达（全文兜底）"
        );
    }

    /// Soft 水位：优先丢最早的 Soft 旧帧，Critical 事件保留
    #[test]
    fn soft_water_drops_oldest_soft_frame_keeps_critical() {
        let mut buffer = EventBuffer::new(3, 8);
        buffer.enqueue("r1", DropClass::Critical, "agent-start".into());
        for i in 0..3 {
            buffer.enqueue("r1", DropClass::Soft, format!("delta-{i}"));
        }
        // 第 3 条 delta 到达 Soft 水位（3 条）：丢最早的 delta-0
        assert_eq!(
            buffer.drain("r1"),
            vec!["agent-start", "delta-1", "delta-2"],
            "丢最早的 delta，agent-start 保留"
        );

        // 重新装满后（soft_limit=4 场景）：再入队 Soft → 仍丢最早的 Soft 旧帧
        let mut buffer = EventBuffer::new(4, 8);
        buffer.enqueue("r1", DropClass::Critical, "agent-start".into());
        buffer.enqueue("r1", DropClass::Soft, "delta-0".into());
        buffer.enqueue("r1", DropClass::Soft, "delta-1".into());
        buffer.enqueue("r1", DropClass::Soft, "delta-2".into());
        let outcome = buffer.enqueue("r1", DropClass::Soft, "delta-3".into());
        assert!(outcome.buffered);
        assert_eq!(outcome.dropped, 1, "每次入队最多丢一条最旧 Soft");
        let drained = buffer.drain("r1");
        assert_eq!(
            drained,
            vec!["agent-start", "delta-1", "delta-2", "delta-3"],
            "丢最早的 delta-0，其余保留"
        );
    }

    /// Critical 水位：驱逐 Soft 旧帧为 Critical 腾位；全 Critical 时超限接受
    #[test]
    fn critical_water_evicts_soft_frames_and_never_drops_critical() {
        let mut buffer = EventBuffer::new(2, 3);
        buffer.enqueue("r1", DropClass::Soft, "delta-a".into());
        buffer.enqueue("r1", DropClass::Soft, "delta-b".into());
        buffer.enqueue("r1", DropClass::Critical, "tool-start".into());
        // 已达 Critical 水位（3 条）：新 Critical → 驱逐最早的 Soft
        let outcome = buffer.enqueue("r1", DropClass::Critical, "run-terminal".into());
        assert!(outcome.buffered);
        assert_eq!(outcome.dropped, 1);
        let drained = buffer.drain("r1");
        assert_eq!(
            drained,
            vec!["delta-b", "tool-start", "run-terminal"],
            "Critical 事件永不丢（terminal 必达）"
        );
    }

    /// 缓冲全 Critical 时：新 Soft 直接丢（不占用空间），Critical 仍可入队
    #[test]
    fn soft_dropped_when_queue_is_all_critical() {
        let mut buffer = EventBuffer::new(1, 2);
        buffer.enqueue("r1", DropClass::Critical, "a".into());
        buffer.enqueue("r1", DropClass::Critical, "b".into());
        // 已达 Critical 水位且全 Critical：新 Soft 丢本帧
        let outcome = buffer.enqueue("r1", DropClass::Soft, "delta".into());
        assert!(!outcome.buffered);
        assert_eq!(outcome.dropped, 1);
        // Critical 仍可入队（超限接受，永不丢）
        let outcome = buffer.enqueue("r1", DropClass::Critical, "c".into());
        assert!(outcome.buffered);
        let drained = buffer.drain("r1");
        assert_eq!(drained, vec!["a", "b", "c"]);
    }

    /// 按 runId 隔离：不同 run 缓冲互不影响
    #[test]
    fn buffer_is_isolated_per_run_id() {
        let mut buffer = EventBuffer::new(2, 4);
        buffer.enqueue("r1", DropClass::Critical, "r1-a".into());
        buffer.enqueue("r2", DropClass::Critical, "r2-a".into());
        assert_eq!(buffer.len("r1"), 1);
        assert_eq!(buffer.len("r2"), 1);
        assert_eq!(buffer.total_len(), 2);
        let mut ids = buffer.run_ids();
        ids.sort();
        assert_eq!(ids, vec!["r1".to_string(), "r2".to_string()]);
        assert_eq!(buffer.drain("r1"), vec!["r1-a".to_string()]);
        assert_eq!(buffer.len("r1"), 0);
        assert_eq!(buffer.len("r2"), 1);
        // run 终态清理：remove_run 返回被丢弃条数
        assert_eq!(buffer.remove_run("r2"), 1);
        assert!(buffer.is_empty());
    }
}
