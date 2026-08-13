//! 合并（R3-01：D7 §3.4.2 / M8 §3.4.2 实现规范）
//!
//! 合并规则表（窗口可注入时钟，纯函数可测）：
//!
//! | 窗口 | 规则 | 产出 |
//! | --- | --- | --- |
//! | 60s | run-terminal(Completed) + 前 60s 内 subagent-ended(Completed) | 「run 完成，含 N 个子代理」 |
//! | 60s | 同 batch 多条 approval-requested（事件体无 batchId，按 session + 窗口近似） | 「N 项操作待批准」 |
//! | 10min | 同 session 多条 task-failed | 「N 个后台任务失败」 |
//! | 10min | 同 cron_id 多次 cron-fired | 「cron 已触发 N 次」 |
//! | 10min | task-suspicious 后跟 task-failed（同 task_id） | 「任务卡死后失败」（只推 failed） |
//!
//! 语义说明（实现取舍，对齐桌面 500ms drain 先例）：
//! - 累积族（subagent 完成 / 审批 / task-failed / cron）先入桶，窗口到期
//!   由 [CoalesceState::flush] 产出合并推送；审批桶另有「批次结束」提前
//!   关闭信号（[CoalesceState::close_approvals]，引擎消费 tool-batch-end，
//!   审批「全组先发」场景零额外等待）；
//! - 关闭信号族（run-terminal 完成 / task-failed 接 suspicious）当场产出
//!   （跨桶合并是这两条规则的语义核心）；
//! - task-suspicious 本身 P0 立即下发，suspicious 桶仅作「卡死已失败」
//!   合并的标记（D7：suspicious 后跟 failed → 只推 failed 的落地形态）。

use std::collections::HashMap;

use super::intent::PayloadDigest;
use super::scenes::SceneId;

/// 合并窗口配置（D7 §3.4.2；毫秒）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoalesceWindows {
    /// run-terminal + subagent-ended(Completed) 合并窗口（60s）
    pub subagent_run_terminal_ms: u64,
    /// 同批审批合并窗口（60s）
    pub approval_batch_ms: u64,
    /// 同 session task-failed 合并窗口（10min）
    pub task_failed_ms: u64,
    /// 同 cron_id 合并窗口（10min）
    pub cron_ms: u64,
    /// task-suspicious → task-failed 合并窗口（10min）
    pub suspicious_then_failed_ms: u64,
}

impl Default for CoalesceWindows {
    fn default() -> Self {
        Self {
            subagent_run_terminal_ms: 60_000,
            approval_batch_ms: 60_000,
            task_failed_ms: 600_000,
            cron_ms: 600_000,
            suspicious_then_failed_ms: 600_000,
        }
    }
}

/// 待合并推送（[CoalesceState] 桶输入）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPush {
    /// 场景（同族合并）
    pub scene: SceneId,
    /// 所属会话
    pub session_id: String,
    /// 单条去重键（入桶前已过 [crate::push::dedupe]）
    pub dedupe_key: String,
    /// 同组合并键（runId / sessionId / cronId / taskId——按场景族）
    pub group_key: String,
    /// 卡死合并键（仅 task-failed 携带：task_id，供「卡死已失败」
    /// 合并查找 suspicious 标记；其余场景为 `None`）
    pub suspicious_key: Option<String>,
    /// 到达时刻（epoch 毫秒）
    pub arrived_at_ms: u64,
    /// 载荷摘要（copy 层输入）
    pub digest: PayloadDigest,
}

/// 合并产物（「N 项…」摘要推送的决策输入）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedPush {
    /// 合并后场景（同族首条场景）
    pub scene: SceneId,
    /// 所属会话
    pub session_id: String,
    /// 合并条数（≥1；run 完成合并 = 子代理数 + 1）
    pub count: usize,
    /// 合并推送去重键（含首条时刻，窗口唯一，防 24h 去重误杀后续窗口）
    pub dedupe_key: String,
    /// 载荷摘要（copy 层按场景 + count 渲染）
    pub digest: PayloadDigest,
    /// 桶内首条时刻（epoch 毫秒）
    pub first_at_ms: u64,
    /// 桶内末条时刻（epoch 毫秒）
    pub last_at_ms: u64,
}

/// 合并桶（同组合并键的累积条目）
#[derive(Debug)]
struct Bucket {
    scene: SceneId,
    session_id: String,
    first: PendingPush,
    items: Vec<PendingPush>,
    window_ms: u64,
}

impl Bucket {
    fn merged(&self, count: usize) -> MergedPush {
        let last = self.items.last().unwrap_or(&self.first);
        MergedPush {
            scene: self.scene,
            session_id: self.session_id.clone(),
            count,
            dedupe_key: format!(
                "merged:{}:{}:{}",
                self.scene.as_str(),
                self.group_key_of(),
                self.first.arrived_at_ms
            ),
            digest: self.first.digest.clone(),
            first_at_ms: self.first.arrived_at_ms,
            last_at_ms: last.arrived_at_ms,
        }
    }

    fn group_key_of(&self) -> String {
        self.first.group_key.clone()
    }
}

/// 合并状态机（桶 + 窗口；纯内存，时钟注入可测）
#[derive(Debug, Default)]
pub struct CoalesceState {
    windows: CoalesceWindows,
    buckets: HashMap<String, Bucket>,
    /// task-suspicious 标记（task_id → 记录时刻；供 task-failed 合并）
    suspicious: HashMap<String, u64>,
}

impl CoalesceState {
    /// 用窗口配置构造
    pub fn new(windows: CoalesceWindows) -> Self {
        Self {
            windows,
            buckets: HashMap::new(),
            suspicious: HashMap::new(),
        }
    }

    /// 注入待合并推送（累积族：subagent 完成 / 审批 / cron / task-failed）。
    ///
    /// 返回 `Some(MergedPush)` 表示**当场产出**（仅 task-failed 命中
    /// suspicious 标记时；其余场景返回 `None`，由 [Self::flush] /
    /// [Self::close_approvals] / [Self::close_run] 产出）。
    pub fn push(&mut self, pending: PendingPush) -> Option<MergedPush> {
        match pending.scene {
            // 卡死 → 失败合并（10min 窗口内只推 failed）
            SceneId::TaskFailed => {
                if let Some(task_id) = &pending.suspicious_key {
                    if let Some(&at) = self.suspicious.get(task_id) {
                        if pending.arrived_at_ms.saturating_sub(at)
                            < self.windows.suspicious_then_failed_ms
                        {
                            self.suspicious.remove(task_id);
                            let merged = MergedPush {
                                scene: SceneId::TaskFailed,
                                session_id: pending.session_id.clone(),
                                count: 2,
                                dedupe_key: format!(
                                    "merged:task-failed:{}:{}",
                                    task_id, pending.arrived_at_ms
                                ),
                                digest: pending.digest,
                                first_at_ms: at,
                                last_at_ms: pending.arrived_at_ms,
                            };
                            return Some(merged);
                        }
                        self.suspicious.remove(task_id);
                    }
                }
                self.accumulate(pending);
                None
            }
            SceneId::SubagentCompleted
            | SceneId::ApprovalRequested
            | SceneId::CronFired => {
                self.accumulate(pending);
                None
            }
            // 其余场景不走合并桶（调用方不应路由到这里，防御性原样产出）
            _ => Some(MergedPush {
                scene: pending.scene,
                session_id: pending.session_id.clone(),
                count: 1,
                dedupe_key: pending.dedupe_key.clone(),
                digest: pending.digest.clone(),
                first_at_ms: pending.arrived_at_ms,
                last_at_ms: pending.arrived_at_ms,
            }),
        }
    }

    /// 记录 task-suspicious 标记（卡死 → 失败合并用；同 task 重复
    /// suspicious 覆盖为最新时刻，D7：非终态可重复）
    pub fn record_suspicious(&mut self, task_id: &str, at_ms: u64) {
        self.suspicious.insert(task_id.to_string(), at_ms);
    }

    /// 关闭信号：run-terminal(Completed) 到达。
    ///
    /// 前 60s 内同 run 有子代理完成桶 → 合并「run 完成，含 N 个子代理」；
    /// 否则原样单条产出（count = 1）。
    pub fn close_run(&mut self, pending: PendingPush) -> MergedPush {
        let bucket_key = format!("subagent:{}", pending.group_key);
        let mut merged = if let Some(bucket) = self.buckets.remove(&bucket_key) {
            if pending.arrived_at_ms.saturating_sub(bucket.first.arrived_at_ms)
                < self.windows.subagent_run_terminal_ms
            {
                let mut m = bucket.merged(bucket.items.len() + 1);
                m.session_id = pending.session_id.clone();
                m.last_at_ms = pending.arrived_at_ms;
                m
            } else {
                // 桶已超出窗口：先产出子代理合并，再单条产 run
                let m = bucket.merged(bucket.items.len() + 1);
                let single = Self::single_from_pending(pending);
                return m.merge_latest(single);
            }
        } else {
            Self::single_from_pending(pending)
        };
        merged.scene = SceneId::RunCompleted;
        merged
    }

    /// 批次结束信号：tool-batch-end 到达时提前关闭该 session 的审批桶
    /// （审批「全组先发」场景无需等 60s 窗口；无桶则空返回）
    pub fn close_approvals(&mut self, session_id: &str, now_ms: u64) -> Vec<MergedPush> {
        let key = format!("approval:{session_id}");
        let Some(bucket) = self.buckets.remove(&key) else {
            return Vec::new();
        };
        let mut merged = bucket.merged(bucket.items.len() + 1);
        merged.last_at_ms = now_ms;
        vec![merged]
    }

    /// 周期 drain：产出**窗口已到期**的桶（窗口从首条到达时刻起算；
    /// 未到期桶留待下次 flush / 关闭信号——这是「10min 窗口内 N 次合并」
    /// 语义的承载点）
    pub fn flush(&mut self, now_ms: u64) -> Vec<MergedPush> {
        let mut out = Vec::new();
        self.buckets.retain(|_, bucket| {
            let expired =
                now_ms.saturating_sub(bucket.first.arrived_at_ms) >= bucket.window_ms;
            if expired {
                out.push(bucket.merged(bucket.items.len() + 1));
            }
            !expired
        });
        // suspicious 标记过期清理（不产出——suspicious 已在到达时下发）
        self.suspicious
            .retain(|_, at| now_ms.saturating_sub(*at) < self.windows.suspicious_then_failed_ms);
        out
    }

    /// 强制 drain 全部桶（R3-02/03 装配在应用退出/会话切换时可调用；
    /// 正常周期运行请用 [Self::flush] 保持窗口语义；`_now_ms` 保留
    /// 签名对称（flush 系调用点统一传当前时刻），当前实现不依赖时刻）
    pub fn flush_all(&mut self, _now_ms: u64) -> Vec<MergedPush> {
        let mut out = Vec::new();
        for (_, bucket) in self.buckets.drain() {
            out.push(bucket.merged(bucket.items.len() + 1));
        }
        self.suspicious.clear();
        out
    }

    /// 桶内条目数（诊断/测试用）
    pub fn pending_count(&self) -> usize {
        self.buckets.values().map(|b| b.items.len() + 1).sum()
    }

    fn accumulate(&mut self, pending: PendingPush) {
        let (bucket_key, window_ms) = match pending.scene {
            SceneId::SubagentCompleted => (format!("subagent:{}", pending.group_key), self.windows.subagent_run_terminal_ms),
            SceneId::ApprovalRequested => (format!("approval:{}", pending.group_key), self.windows.approval_batch_ms),
            SceneId::CronFired => (format!("cron:{}", pending.group_key), self.windows.cron_ms),
            SceneId::TaskFailed => (format!("task-failed:{}", pending.group_key), self.windows.task_failed_ms),
            _ => return,
        };
        match self.buckets.get_mut(&bucket_key) {
            Some(bucket) => {
                bucket.items.push(pending);
            }
            None => {
                let first = pending.clone();
                self.buckets.insert(
                    bucket_key,
                    Bucket {
                        scene: pending.scene,
                        session_id: first.session_id.clone(),
                        first,
                        items: vec![pending],
                        window_ms,
                    },
                );
            }
        }
    }

    fn single_from_pending(pending: PendingPush) -> MergedPush {
        MergedPush {
            scene: pending.scene,
            session_id: pending.session_id.clone(),
            count: 1,
            dedupe_key: pending.dedupe_key.clone(),
            digest: pending.digest.clone(),
            first_at_ms: pending.arrived_at_ms,
            last_at_ms: pending.arrived_at_ms,
        }
    }
}

/// 两条合并推送的末条时刻取大（close_run 窗口超限时拼合产物用）
impl MergedPush {
    fn merge_latest(mut self, other: MergedPush) -> MergedPush {
        self.last_at_ms = self.last_at_ms.max(other.last_at_ms);
        self.count = self.count.saturating_add(other.count);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(scene: SceneId, session: &str, group: &str, at: u64) -> PendingPush {
        PendingPush {
            scene,
            session_id: session.to_string(),
            dedupe_key: format!("{:?}:{group}", scene),
            group_key: group.to_string(),
            suspicious_key: None,
            arrived_at_ms: at,
            digest: PayloadDigest {
                session_id: session.to_string(),
                biz_key: group.to_string(),
                digest: None,
                detail: None,
            },
        }
    }

    #[test]
    fn run_terminal_merges_subagents_within_60s() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::SubagentCompleted, "s-7", "run-42", 1_000));
        state.push(pending(SceneId::SubagentCompleted, "s-7", "run-42", 2_000));
        // 30s 后 run 完成 → 当场合并（2 子代理 + 1 run）
        let merged = state.close_run(pending(SceneId::RunCompleted, "s-7", "run-42", 31_000));
        assert_eq!(merged.scene, SceneId::RunCompleted);
        assert_eq!(merged.count, 3);
        assert_eq!(merged.dedupe_key, "merged:run-completed:run-42:1000");
        assert!(merged.dedupe_key.contains("run-42"), "窗口唯一键含 runId");
        assert_eq!(state.pending_count(), 0, "合并后桶清空");
    }

    #[test]
    fn run_terminal_without_subagents_single() {
        let mut state = CoalesceState::default();
        let merged = state.close_run(pending(SceneId::RunCompleted, "s-7", "run-9", 1_000));
        assert_eq!(merged.scene, SceneId::RunCompleted);
        assert_eq!(merged.count, 1);
    }

    #[test]
    fn subagent_bucket_beyond_window_flushes_separately() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::SubagentCompleted, "s-7", "run-1", 1_000));
        // 61s 后 run 完成：子代理桶已超窗口 → 子代理合并 + run 单条拼合
        let merged = state.close_run(pending(SceneId::RunCompleted, "s-7", "run-1", 61_000));
        assert_eq!(merged.count, 2, "子代理合并(1) + run 单条(1) 拼合");
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn approval_batch_merges_by_session() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::ApprovalRequested, "s-7", "s-7", 1_000));
        state.push(pending(SceneId::ApprovalRequested, "s-7", "s-7", 2_000));
        // 批次结束信号（tool-batch-end）→ 提前关闭，无需等 60s
        let merged = state.close_approvals("s-7", 3_000);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].scene, SceneId::ApprovalRequested);
        assert_eq!(merged[0].count, 2);
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn approval_flush_after_window() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::ApprovalRequested, "s-7", "s-7", 1_000));
        // 窗口未到 → flush 不产出
        assert!(state.flush(50_000).is_empty());
        // 60s 窗口到期 → 产出
        let out = state.flush(61_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].count, 1);
    }

    #[test]
    fn task_failed_merges_by_session_window_10min() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::TaskFailed, "s-7", "s-7", 1_000));
        state.push(pending(SceneId::TaskFailed, "s-7", "s-7", 300_000));
        // 10min 窗口未满 → 未产出
        assert!(state.flush(599_000).is_empty());
        // 窗口满（首条 + 10min）→ 「N 个后台任务失败」
        let out = state.flush(601_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].scene, SceneId::TaskFailed);
        assert_eq!(out[0].count, 2);
    }

    #[test]
    fn cron_merges_by_cron_id() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::CronFired, "s-7", "cron-2", 1_000));
        state.push(pending(SceneId::CronFired, "s-7", "cron-2", 5_000));
        let out = state.flush(601_000);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].count, 2);
        assert!(out[0].dedupe_key.contains("cron-2"));
    }

    #[test]
    fn suspicious_then_failed_merges_within_10min() {
        let mut state = CoalesceState::default();
        state.record_suspicious("t-12", 1_000);
        // 5min 后 failed → 当场合并（count=2，只推 failed 形态）
        let mut p = pending(SceneId::TaskFailed, "s-7", "s-7", 300_000);
        p.suspicious_key = Some("t-12".to_string());
        let merged = state.push(p).expect("suspicious → failed 应合并产出");
        assert_eq!(merged.scene, SceneId::TaskFailed);
        assert_eq!(merged.count, 2);
        assert!(merged.dedupe_key.contains("t-12"));
        // 标记已消费
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn suspicious_expired_then_failed_no_merge() {
        let mut state = CoalesceState::default();
        state.record_suspicious("t-13", 1_000);
        // 超过 10min 窗口：suspicious 标记先过期清理
        state.flush(601_000);
        let mut p = pending(SceneId::TaskFailed, "s-7", "s-7", 601_000);
        p.suspicious_key = Some("t-13".to_string());
        let merged = state.push(p);
        assert!(merged.is_none(), "窗口外不合并，走 task-failed 累积桶");
        assert_eq!(state.pending_count(), 1);
    }

    #[test]
    fn buckets_isolated_by_group_key() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::CronFired, "s-7", "cron-1", 1_000));
        state.push(pending(SceneId::CronFired, "s-7", "cron-2", 2_000));
        let out = state.flush(601_000);
        assert_eq!(out.len(), 2, "不同 cron 独立成桶");
    }

    #[test]
    fn flush_all_drains_everything() {
        let mut state = CoalesceState::default();
        state.push(pending(SceneId::CronFired, "s-7", "cron-1", 1_000));
        state.record_suspicious("t-1", 1_000);
        let out = state.flush_all(2_000);
        assert_eq!(out.len(), 1);
        assert_eq!(state.pending_count(), 0);
    }
}
