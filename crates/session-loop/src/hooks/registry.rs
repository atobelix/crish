use super::types::{
    HandlerEntry, HookError, HookEvent, HookEventKind, HookFailStrategy, HookHandler, HookMode,
    HookRegisterOptions, SnapshotEntry,
};
use conex_types::events::AgentEvent;
use regex::Regex;
use std::sync::{Arc, RwLock};

pub type OutcomeSinkFn = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// 钩子注册表（广播分派；线程安全，可跨 run 复用）
///
/// 错误事件化重入护栏：不使用全局共享状态（如 AtomicBool），完全由
/// dispatch_inner 的 per-dispatch `error_eventing` 参数承担——error.occurred
/// 自身再分派时传 false 即可防级联；全局标志会在并发双失败路径误伤后到者
/// （swap 见 true 直接 return，丢掉 error.occurred）。
#[derive(Default)]
pub struct HookRegistry {
    pub(super) entries: RwLock<Vec<HandlerEntry>>,
    /// hook-outcome 观测镜像出口（D-03 EV-05）：dispatch 聚合出口发射
    /// AgentEvent::HookOutcome（Delta 级可丢）；None = 未接线，dispatch
    /// 语义不变（仅观测，不搬 HookEvent 插件通道）
    pub(super) outcome_sink: RwLock<Option<OutcomeSinkFn>>,
}

impl HookRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册 handler（默认：on 模式、无 matcher、无超时——保留既有
    /// 控制信号语义；分派按注册顺序）
    pub fn register(
        &self,
        kind: HookEventKind,
        strategy: HookFailStrategy,
        handler: Arc<dyn HookHandler>,
    ) {
        // 默认选项（matcher 缺省）下 register_with 不会失败；仍显式处置错误面
        // （BLK-05：不得丢弃注册结果），保证异常注册可见
        if let Err(err) = self.register_with(
            kind,
            strategy,
            handler,
            HookRegisterOptions {
                mode: HookMode::On,
                ..Default::default()
            },
        ) {
            tracing::error!(hook_kind = ?kind, error = %err, "hook 注册失败（register 默认选项）");
        }
    }

    /// 注册 observe 模式 handler（广播观察：Block 忽略、失败按策略处置）
    pub fn register_observe(
        &self,
        kind: HookEventKind,
        strategy: HookFailStrategy,
        handler: Arc<dyn HookHandler>,
    ) {
        // 同 [Self::register]：显式处置注册错误面（BLK-05）
        if let Err(err) = self.register_with(
            kind,
            strategy,
            handler,
            HookRegisterOptions {
                mode: HookMode::Observe,
                ..Default::default()
            },
        ) {
            tracing::error!(
                hook_kind = ?kind,
                error = %err,
                "hook 注册失败（register_observe 默认选项）"
            );
        }
    }

    /// 注册 handler（完整选项：mode / matcher / timeout）。
    ///
    /// matcher 为工具名正则（仅 tool.* 事件生效），非法正则注册即拒
    /// （HookError，03 §2.5）。
    pub fn register_with(
        &self,
        kind: HookEventKind,
        strategy: HookFailStrategy,
        handler: Arc<dyn HookHandler>,
        options: HookRegisterOptions,
    ) -> Result<(), HookError> {
        // matcher 校验（非法正则拒绝注册）
        let matcher = match &options.matcher {
            Some(pattern) => Some(
                Regex::new(pattern)
                    .map_err(|e| HookError::new(format!("非法 matcher 正则 '{pattern}'：{e}")))?,
            ),
            None => None,
        };
        self.entries
            .write()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续注册
                tracing::error!("hook 注册表写锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .push(HandlerEntry {
                kind,
                strategy,
                mode: options.mode,
                matcher,
                timeout_ms: options.timeout_ms,
                handler,
            });
        Ok(())
    }

    /// 已注册 handler 数（测试 / 观测）
    pub fn len(&self) -> usize {
        self.entries
            .read()
            .unwrap_or_else(|e| {
                tracing::error!("hook 注册表读锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .len()
    }

    /// 是否无任何注册
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 接线 hook-outcome 观测镜像出口（D-03 EV-05）：dispatch 出口处
    /// 每批次发射一次 AgentEvent::HookOutcome；不接线 = 无观测事件，
    /// dispatch 语义完全不变（纯观测，HookEvent 插件通道不受影响）。
    pub fn set_outcome_sink(&self, sink: OutcomeSinkFn) {
        *self.outcome_sink.write().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续接线
            tracing::error!("hook 观测出口写锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        }) = Some(sink);
    }

    /// 快照克隆（读锁不跨 handler 调用持有，避免 handler 内注册死锁）
    pub(super) fn snapshot_entries(&self) -> Vec<SnapshotEntry> {
        self.entries
            .read()
            .unwrap_or_else(|e| {
                tracing::error!("hook 注册表读锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .iter()
            .map(|entry| {
                (
                    entry.kind,
                    entry.strategy,
                    entry.mode,
                    entry.matcher.clone(),
                    entry.timeout_ms,
                    Arc::clone(&entry.handler),
                )
            })
            .collect::<Vec<_>>()
    }

    /// 判定条目是否因 kind/matcher 不匹配而跳过
    pub(super) fn entry_should_skip(
        entry_kind: HookEventKind,
        matcher: Option<&Regex>,
        event: &HookEvent,
    ) -> bool {
        if entry_kind != event.kind() {
            return true;
        }
        if let (Some(pattern), Some(tool_name)) = (matcher, event.tool_name()) {
            if !pattern.is_match(tool_name) {
                return true;
            }
        }
        false
    }
}
