//! BG3 唤醒通道：后台工具落定 → `tool-wake` steering 条目。
//!
//! 结构对齐 [crate::task_event_consumer::TaskEventConsumer]（任务域
//! 唤醒消费面）：同一共享 [PendingMessageQueue] 实例（装配注入，
//! 与 TaskEventConsumer 同源——WakeWatcher 只认这一条队列）、同一
//! `replace_or_enqueue` 原位合并口径、同一 is_steering 受保护位。
//! 差异只在分组与文案域：
//! - 分组名 `tool-wake`（与 shell 进程任务的 `task-wake` 严格区分，
//!   两域互不冒充——本通道是进程内工具执行落定，task-wake 是子进程
//!   任务终态）；
//! - 合并粒度 = 会话：条目带目标 session_id，同会话多次落定原位
//!   替换、只保留最新一条（task-wake v1 的降级语义先例：批量聚合
//!   留待后续，本批先保证「有唤醒、不风暴」）；
//! - 条目消费与 run 拉起护栏在 WakeWatcher 侧（wake_watcher.rs
//!   不动），本通道只负责入队。
//!
//! 条目文本 = 工具名 + 终态 + 结果摘要；摘要截断上限与工具输出
//! 预算 G8 同值（2000 行 / 50KiB），不另造第二套截断口径——
//! TaskEventConsumer 的摘要是单行模板、无截断构造可复用，故同值
//! 实现于本模块并在此声明。

use std::sync::{Arc, Mutex};

use conex_types::events::ToolSettledStatus;
use conex_types::tool::ToolBatchResult;
use orchestrator::steering_queue::{PendingMessageQueue, SteeringInputEntry};

/// tool-wake 分组名（条目 id 与 group_id 同值，对齐 task-wake 先例）
pub const TOOL_WAKE_GROUP_ID: &str = "tool-wake";

/// 唤醒摘要行数上限（G8 工具输出预算同值）
pub const WAKE_SUMMARY_MAX_LINES: usize = 2000;
/// 唤醒摘要字节上限（G8 工具输出预算同值：50KiB）
pub const WAKE_SUMMARY_MAX_BYTES: usize = 50 * 1024;

/// 后台工具唤醒消费者（CoreRunState 装配单例，与 TaskEventConsumer
/// 共享同一 PendingMessageQueue 实例）
#[derive(Debug)]
pub struct ToolWakeConsumer {
    queue: Arc<Mutex<PendingMessageQueue>>,
}

impl ToolWakeConsumer {
    pub fn new(queue: Arc<Mutex<PendingMessageQueue>>) -> Self {
        Self { queue }
    }

    /// 共享 steering 队列实例（装配同源断言用）
    pub fn queue(&self) -> &Arc<Mutex<PendingMessageQueue>> {
        &self.queue
    }

    /// 后台工具落定 → tool-wake 条目（桥 sink 在发射 tool-settled
    /// 的同一迁移内调用；run 活跃时条目在下一 steering 边界被
    /// 消费，run 空闲时由 WakeWatcher 拉起——两种情形共用本入口）
    pub fn on_settled(
        &self,
        session_id: &str,
        tool_name: &str,
        status: ToolSettledStatus,
        result: &ToolBatchResult,
    ) {
        let headline = match status {
            ToolSettledStatus::Ok => format!("后台工具 {tool_name} 已完成"),
            ToolSettledStatus::Error => format!("后台工具 {tool_name} 执行失败"),
            ToolSettledStatus::Cancelled => format!("后台工具 {tool_name} 已取消"),
            ToolSettledStatus::OutcomeUnknown => {
                format!("后台工具 {tool_name} 结果未知")
            }
        };
        let digest = result_digest(result);
        let text = if digest.is_empty() {
            headline
        } else {
            format!("{headline}：{digest}")
        };
        self.enqueue(session_id, text);
    }

    /// 冷启动合成专用文案：上次会话遗留的未落定后台工具（无执行
    /// 结果可摘要，条目文本显式声明来源与未知语义）
    pub fn on_cold_start_unsettled(&self, session_id: &str, tool_name: &str) {
        self.enqueue(
            session_id,
            format!("上次会话有后台工具未完成：{tool_name}（进程退出，结果未知）"),
        );
    }

    fn enqueue(&self, session_id: &str, text: String) {
        let entry = SteeringInputEntry {
            session_id: session_id.to_string(),
            id: TOOL_WAKE_GROUP_ID.to_string(),
            text: truncate_wake_summary(&text),
            attachments: Vec::new(),
            enqueued_at: conex_shared::time::now_millis(),
            group_id: Some(TOOL_WAKE_GROUP_ID.to_string()),
            is_steering: true,
        };
        self.queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace_or_enqueue(entry);
    }
}

/// 结果摘要：优先 output.text（成功输出与错误文案同槽），其次
/// output.json 紧凑序列化；皆空 → 空摘要（只留标题行）
fn result_digest(result: &ToolBatchResult) -> String {
    if let Some(text) = &result.output.text {
        if !text.trim().is_empty() {
            return text.clone();
        }
    }
    if let Some(json) = &result.output.json {
        return json.to_string();
    }
    String::new()
}

/// G8 同值截断：先行数、后字节（char 边界安全），截断显式留痕
pub fn truncate_wake_summary(text: &str) -> String {
    let mut truncated = false;
    let mut out: String = if text.lines().count() > WAKE_SUMMARY_MAX_LINES {
        truncated = true;
        text.lines()
            .take(WAKE_SUMMARY_MAX_LINES)
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text.to_string()
    };
    if out.len() > WAKE_SUMMARY_MAX_BYTES {
        let mut cut = WAKE_SUMMARY_MAX_BYTES;
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        truncated = true;
    }
    if truncated {
        out.push_str("\n…（摘要已按上限截断）");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::tool::ToolOutput;

    fn consumer() -> (ToolWakeConsumer, Arc<Mutex<PendingMessageQueue>>) {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        (ToolWakeConsumer::new(Arc::clone(&queue)), queue)
    }

    fn ok_result(text: &str) -> ToolBatchResult {
        ToolBatchResult {
            id: "c1".to_string(),
            tool_name: "read_file".to_string(),
            output: ToolOutput::text(text.to_string()),
            is_error: false,
            duration_ms: 100,
        }
    }

    fn drain(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
        queue
            .lock()
            .unwrap()
            .dequeue_by_group(TOOL_WAKE_GROUP_ID)
    }

    /// 场景 1：落定入队——条目落在目标会话、is_steering 受保护、
    /// 文案含工具名与结果摘要
    #[test]
    fn settled_enqueues_steering_entry_for_target_session() {
        let (consumer, queue) = consumer();
        consumer.on_settled("s1", "read_file", ToolSettledStatus::Ok, &ok_result("文件内容"));
        let entries = drain(&queue);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.session_id, "s1");
        assert_eq!(entry.group_id.as_deref(), Some(TOOL_WAKE_GROUP_ID));
        assert!(entry.is_steering, "steering 条目容量挤占时受保护");
        assert!(entry.text.contains("read_file"));
        assert!(entry.text.contains("文件内容"));
    }

    /// 场景 2：同会话多落定合并一条（原位替换，只保留最新）；
    /// 跨会话不串（各自一条）
    #[test]
    fn multiple_settles_merge_into_one_entry_per_session() {
        let (consumer, queue) = consumer();
        consumer.on_settled("s1", "tool_a", ToolSettledStatus::Ok, &ok_result("A"));
        consumer.on_settled("s1", "tool_b", ToolSettledStatus::Error, &ToolBatchResult {
            id: "c2".to_string(),
            tool_name: "tool_b".to_string(),
            output: ToolOutput {
                text: Some("boom".to_string()),
                json: Some(serde_json::json!({ "code": "tool.execution_failed" })),
                artifacts: None,
            },
            is_error: true,
            duration_ms: 3,
        });
        consumer.on_settled("s2", "tool_c", ToolSettledStatus::Ok, &ok_result("C"));
        let entries = drain(&queue);
        assert_eq!(entries.len(), 2, "同会话合一条、跨会话各自一条");
        let s1 = entries.iter().find(|e| e.session_id == "s1").unwrap();
        assert!(s1.text.contains("tool_b"), "同会话只保留最新落定：{}", s1.text);
        assert!(!s1.text.contains("tool_a"));
        let s2 = entries.iter().find(|e| e.session_id == "s2").unwrap();
        assert!(s2.text.contains("tool_c"));
    }

    /// 场景 3：超长摘要按 G8 同值截断（字节上限 + 留痕），且截断点
    /// 落在 char 边界（多字节文本不炸）
    #[test]
    fn oversized_digest_truncated_with_marker_at_char_boundary() {
        let (consumer, queue) = consumer();
        let big = "数".repeat(30_000); // 90_000 字节 > 50KiB
        consumer.on_settled("s1", "read_file", ToolSettledStatus::Ok, &ok_result(&big));
        let entries = drain(&queue);
        assert_eq!(entries.len(), 1);
        let text = &entries[0].text;
        assert!(text.contains("摘要已按上限截断"), "截断必须留痕");
        assert!(
            text.len() <= WAKE_SUMMARY_MAX_BYTES + 64,
            "截断后字节数应回到上限附近，实际 {}",
            text.len()
        );
    }

    /// 冷启动文案：显式「上次会话有后台工具未完成」
    #[test]
    fn cold_start_entry_uses_dedicated_wording() {
        let (consumer, queue) = consumer();
        consumer.on_cold_start_unsettled("s1", "shell");
        let entries = drain(&queue);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].text.contains("上次会话有后台工具未完成"));
        assert!(entries[0].text.contains("shell"));
    }
}
