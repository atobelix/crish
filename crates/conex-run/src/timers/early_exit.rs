//! 定时器早退判定与取消钩子（T-CF-07 §2/§3/§4）

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use conex_types::events::AgentEvent;
use conex_types::timer::TimerCondition;

use crate::timers::registry::TimerRegistry;
use crate::timers::types::{TimerCancelReason, TimerEvent};

impl TimerRegistry {
    /// 早退钩子（T-CF-07 §3）：事件面旁路点的判定入口——命中
    /// early_exit 表（Task 条件）或活跃 Any 定时器 → 取消 + 通知。
    ///
    /// 注意：本方法当前由测试面直接驱动；orchestrator `EventQueue::push`
    /// 与 Tauri 事件收口的旁路接线在 R-CF3 落地。
    #[allow(dead_code)] // R-CF3：事件收口接线后移除
    pub async fn on_event(&self, event: &AgentEvent) {
        // 自产事件（timer-fired / timer-cancelled）不参与早退判定——
        // 事件体带 timer_id 字段天然可识别；定时器事件不是「外部消息」
        // （T-CF-07 §2；timer_any_ignores_own_fire 测试覆盖）
        if matches!(
            event,
            AgentEvent::TimerFired { .. } | AgentEvent::TimerCancelled { .. }
        ) {
            return;
        }
        let senders = event_sender_ids(event);
        if senders.is_empty() {
            return;
        }
        let now = (self.now)();
        // Task 条件：early_exit 表精确命中（sender → timer_id）。
        // 注意：remove 的锁守卫必须提前释放再进取消流程——std Mutex
        // 不可重入，cancel_early_exit 内部会再次锁 early_exit（清表项），
        // 守卫活过 if-let 体即自锁死锁
        for sender in &senders {
            let timer_id = {
                let mut map = self.early_exit.lock().unwrap_or_else(|e| e.into_inner());
                map.remove(sender)
            };
            if let Some(timer_id) = timer_id {
                self.cancel_early_exit(&timer_id, sender, now);
            }
        }
        // Any 条件：全表扫描活跃 Any 定时器（Any 不参与冲突表，无映射
        // 可查，须扫描；命中全部取消）
        let any_hits: Vec<String> = {
            let timers = self.timers.lock().unwrap_or_else(|e| e.into_inner());
            timers
                .iter()
                .filter(|(_, e)| {
                    matches!(e.declaration.condition, TimerCondition::Any)
                        && !e.declaration.fired
                        && !e.declaration.cancelled
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        for timer_id in any_hits {
            let sender = senders.first().cloned().unwrap_or_default();
            self.cancel_early_exit(&timer_id, &sender, now);
        }
    }

    /// 早退取消（T-CF-07 §3/§4）：abort sleep + 标 cancelled 落库 +
    /// 发射 TimerCancelled(reason=early-exit) + 注入 steering 通知
    /// （「定时器 <id> 已因 <sender> 完成而取消」；同 group 替换防重复唤醒）
    pub fn cancel_early_exit(&self, timer_id: &str, sender: &str, cancelled_at_ms: u64) {
        let Some(entry) = self.take_entry(timer_id) else {
            // 已被并发取消/到期 → 幂等跳过
            return;
        };
        entry.task.abort();
        let mut declaration = entry.declaration;
        declaration.cancelled = true;
        self.store.save(&declaration);
        self.events.emit(TimerEvent::Cancelled {
            timer_id: timer_id.to_string(),
            reason: TimerCancelReason::EarlyExit,
            cancelled_at_ms,
        });
        self.pending.enqueue_steering(
            timer_id,
            format!("定时器 {timer_id} 已因 {sender} 完成而取消"),
            cancelled_at_ms,
        );
        tracing::info!(
            target: "timers",
            timer_id,
            sender,
            "早退命中：定时器已取消并注入通知"
        );
    }
}

/// 清理指向该定时器的全部 early_exit 映射（sender → timer_id 逆查）
pub fn clear_early_exit(early_exit: &Arc<Mutex<HashMap<String, String>>>, timer_id: &str) {
    early_exit
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, tid| tid != timer_id);
}

/// sender 归一化（T-CF-07 §2）：事件 → 可能的 sender 列表。
///
/// 覆盖：SubagentEnded.subagent_id、RunTerminal.run_id（含 agent-id
/// 同义复用）；定时器自产事件返回空（内部事件不参与早退）。注入类消息
/// （subagent_inject_message 的 id 语义）在 Tauri 事件收口无独立事件
/// 变体，R-CF3 接线时扩展。
pub fn event_sender_ids(event: &AgentEvent) -> Vec<String> {
    match event {
        AgentEvent::SubagentEnded { subagent_id, .. } => vec![subagent_id.clone()],
        AgentEvent::RunTerminal { run_id, .. } => vec![run_id.clone()],
        _ => Vec::new(),
    }
}

/// 到期触发（同步执行；spawn 任务内运行，panic 由 catch_unwind 兜底）：
/// 发射 TimerFired（Critical）→ steering 条目（group_id = timer-<id>，
/// replaceOrEnqueue 去重）→ 声明标 fired=true 落库。
///
/// 幂等：终态声明直接跳过（防重启重复注入）；timers 表移除与取消/早退
/// 竞态互斥——同步段无 await，先取锁者生效，后到者取 None 跳过。
pub fn fire_timer(
    timers: &Arc<Mutex<HashMap<String, crate::timers::registry::TimerEntry>>>,
    early_exit: &Arc<Mutex<HashMap<String, String>>>,
    pending: &Arc<dyn crate::timers::types::PendingSink>,
    events: &Arc<dyn crate::timers::types::EventSink>,
    store: &Arc<dyn crate::timers::store::TimerStore>,
    now: &Arc<dyn Fn() -> u64 + Send + Sync>,
    declaration: &conex_types::timer::TimerDeclaration,
) {
    // 幂等守卫：终态声明不注入（防重启重复注入）
    if declaration.fired || declaration.cancelled {
        return;
    }
    // 移除活跃条目（与取消/早退竞态互斥：先取锁者生效；后到者取 None
    // 幂等跳过）
    if timers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&declaration.timer_id)
        .is_none()
    {
        return;
    }
    clear_early_exit(early_exit, &declaration.timer_id);
    let fired_at_ms = now();
    // 1. 事件（Critical 数据面落库；适配器接线见头部注记）
    events.emit(TimerEvent::Fired {
        timer_id: declaration.timer_id.clone(),
        prompt: declaration.prompt.clone(),
        fired_at_ms,
    });
    // 2. steering 条目（唤醒面；text 含 prompt——唤醒摘要标准化
    //    由 T-CF-12 负责，此处按 §4.8 定时器到期模板落形）
    pending.enqueue_steering(
        &declaration.timer_id,
        format!(
            "{}（定时器 {} 已到期）",
            declaration.prompt, declaration.timer_id
        ),
        fired_at_ms,
    );
    // 3. 声明标 fired 落库（重启后避免重复注入）
    let mut fired = declaration.clone();
    fired.fired = true;
    store.save(&fired);
    tracing::info!(
        target: "timers",
        timer_id = %declaration.timer_id,
        "定时器已到期，steering 条目已注入"
    );
}

/// panic 载荷 → 人读文本（日志兜底用）
pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "非字符串 panic 载荷".to_string()
}
