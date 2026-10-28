//! 路由型审计 sink（15-T-6 裁决 D9）：run 级桥注册表 + G10 denied 计数
//!
//! - 工具级审计（shell/delete 等工具经 `BuiltinToolConfig.audit_sink`
//!   发射的 security-audit）按 session_id 路由到该会话当前活动 run 的
//!   审计桥（[BridgeAuditSink] → 缓冲事件桥 → 前端审计面板 per-run 面
//!   实时可见，34-T7 口径；L4（F12）已补落库面——桥内持久化通道 →
//!   events 表审计底账）；
//! - **域隔离边界**（30 §9 最终口径）：任务域审计（10-P3
//!   TaskAuditAccumulator → EventBridge 直发，operation=command-exec）
//!   **不经本 sink**——本 sink 只承接工具面审计，两路均以
//!   security-audit 事件形态经 run 桥到达前端，无重复无遗漏；
//! - 计数面（G10）：denied 决策同步计入共享 [DeniedStats]（与
//!   agent-tools `CountingAuditSink` :94-105 同构语义），月度报告
//!   经 [DeniedStats::summary] 拉取。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::audit::AuditSink;
use agent_tools::audit::SecurityAuditSink;
use conex_types::denied_stats::DeniedStats;
use conex_types::events::{AgentEvent, SecurityAuditDecision};

/// 毒丸恢复计数（B1-5 观测化：RoutingAuditSink routes 锁中毒恢复次数；
/// 对齐 registry.rs / note_memory.rs 「tracing::error! 成对 + 计数」样板，
/// 零新依赖；本文件 4 处 routes 锁共用）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言面；`test-hooks` 门控——壳层毒化测试
/// 跨 crate 使用；生产构建不暴露）
#[cfg(any(test, feature = "test-hooks"))]
pub fn audit_poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
}

/// 路由型审计 sink（15-T-6 接线，裁决 D9）：run 级桥注册表 +
/// G10 denied 计数
#[derive(Debug)]
pub struct RoutingAuditSink {
    /// session_id → 该会话当前活动 run 的审计桥（run 启动注册、收口注销）
    routes: Mutex<HashMap<String, AuditSink>>,
    /// G10 denied 计数（引擎级共享实例）
    stats: Arc<DeniedStats>,
}

impl RoutingAuditSink {
    /// 新建路由注册表（共享统计实例）
    pub fn new(stats: Arc<DeniedStats>) -> Self {
        Self {
            routes: Mutex::new(HashMap::new()),
            stats,
        }
    }

    /// run 启动注册；同 session 多 run 并发 → 后注册者覆盖（新 run 覆盖
    /// 旧 run，与事件收口旁路点口径一致——会话内串行守卫下同 session
    /// 同时仅一个活动 run，覆盖为防御性语义）
    pub fn register(&self, session_id: &str, sink: AuditSink) {
        self.routes
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "RoutingAuditSink routes 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .insert(session_id.to_string(), sink);
    }

    /// run 收口强制注销（防 session 泄漏）；重复注销幂等
    pub fn unregister(&self, session_id: &str) {
        self.routes
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "RoutingAuditSink routes 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .remove(session_id);
    }

    /// 已注册路由数（测试断言面：收口注销无残留）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费
    pub fn route_count(&self) -> usize {
        self.routes
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "RoutingAuditSink routes 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .len()
    }

    /// 毒化 routes 锁（B1-5 毒化测注入：持锁线程内 panic → 中毒状态；
    /// 对齐 agent-tools test_support::poison_std_lock 形态。`test-hooks`
    /// 门控——壳层毒化测试跨 crate 使用；生产构建不暴露）
    #[cfg(any(test, feature = "test-hooks"))]
    pub fn poison_routes_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _guard = self.routes.lock().unwrap();
                    panic!("模拟持锁 panic（毒化 routes 锁）");
                });
            });
        }));
    }
}

impl SecurityAuditSink for RoutingAuditSink {
    fn emit(&self, event: &AgentEvent) {
        let AgentEvent::SecurityAudit {
            session_id,
            decision,
            ..
        } = event
        else {
            return;
        };
        // G10：denied 决策同步计数（与 CountingAuditSink 同构语义，
        // 其余决策转发不计数）
        if *decision == SecurityAuditDecision::Denied {
            self.stats.record_security_audit_denied();
        }
        // 锁内仅取路由句柄克隆，不持锁跨 emit 调用（sink 可能重入）
        let sink = self
            .routes
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "RoutingAuditSink routes 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .get(session_id)
            .cloned();
        match sink {
            Some(sink) => sink.emit(event),
            None => {
                // 无活动 run / 未注册 → tracing 兜底（Noop 语义不 panic）
                tracing::debug!(
                    target: "audit",
                    session_id,
                    "审计事件无活动 run 路由，tracing 兜底"
                );
            }
        }
    }
}
