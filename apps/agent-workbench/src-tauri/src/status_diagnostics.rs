//! 状态诊断（PE-04 T04.5：core_get_status 诊断段的数据源）
//!
//! - [StatusDiagnostics]：子系统诊断**环形 20 条**（T04.5-1 形状
//!   `SubsystemDiagnostic { subsystem, ready, message, updatedAt }`，
//!   camelCase；字段接线由 core_query_commands.rs 消费——本任务只写模块，
//!   接线归 R2）；
//! - [AtomicSlot]：`lastError` 由 **AtomicSlot** 驱动（F2/C4/D16）——任何
//!   error 收场或 catch 兜底时写入（core_run_commands.rs 的 finalize_failed
//!   与事件桥的 runtime-error 事件处），命令读取返回；载荷为
//!   [conex_types::CrishErrorPayload]（`to_error_payload` 产出，PE-06 类型）。
//!
//! 并发：std [std::sync::Mutex] 只保护短临界区（记录/读取），不跨 await
//! 持有（AA-02 并发模型注记：std Mutex 均未跨 await 持有）。

use std::collections::VecDeque;
use std::sync::Mutex;

use conex_types::CrishErrorPayload;
use serde::Serialize;

/// 诊断环形缓冲容量（T04.5-1：最近 20 条）
pub const DIAGNOSTICS_RING_CAPACITY: usize = 20;

/// 子系统诊断条目（T04.5-1 形状，camelCase wire）
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubsystemDiagnostic {
    /// 子系统标识（engine / db / restore / snapshot / ...）
    pub subsystem: String,
    /// 是否就绪（真实值，无硬编码 true——T04.5-1 验收）
    pub ready: bool,
    /// 说明文案（就绪信息 / 未就绪原因）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 最近更新时间（epoch ms）
    pub updated_at: i64,
}

/// lastError 单槽（AtomicSlot 语义：写覆盖、读克隆；None = 无最近错误）
///
/// F2 冻结：`lastError: CrishErrorPayload | null`——任何 error 收场或
/// catch 兜底时写入，命令读取返回；写入点 = finalize_failed 与事件桥的
/// runtime-error 事件处（PE-04 T04.5-1）。
#[derive(Debug)]
pub struct AtomicSlot<T> {
    inner: Mutex<Option<T>>,
}

impl<T> AtomicSlot<T> {
    /// 新建空槽
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// 写入（覆盖旧值）
    pub fn set(&self, value: T) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(value);
        }
    }

    // G11a 备注：clear/is_some 非 test 构建无 bin 消费者（lastError 写入读
    // 只走 set/get），测试逐条覆盖（atomic_slot_is_generic 等）——dead_code 静音。
    /// 清除（置 None）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
    }

    /// 读取（克隆；None = 尚未写入）
    pub fn get(&self) -> Option<T>
    where
        T: Clone,
    {
        self.inner.lock().ok().and_then(|guard| guard.clone())
    }

    /// 是否已有值
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_some(&self) -> bool {
        self.inner
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }
}

impl<T> Default for AtomicSlot<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// 状态诊断（环形 20 条 + lastError AtomicSlot）
#[derive(Debug, Default)]
pub struct StatusDiagnostics {
    /// 子系统诊断环形缓冲（最近 20 条，新条目在前）
    entries: Mutex<VecDeque<SubsystemDiagnostic>>,
    /// 最近错误槽（T04.5-1 lastError 驱动）
    last_error: AtomicSlot<CrishErrorPayload>,
}

impl StatusDiagnostics {
    /// 新建状态诊断
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录一条子系统诊断（环形 20 条：新条目在前，超出丢弃最旧）
    pub fn record(&self, subsystem: impl Into<String>, ready: bool, message: Option<String>) {
        let entry = SubsystemDiagnostic {
            subsystem: subsystem.into(),
            ready,
            message,
            updated_at: now_ms(),
        };
        if let Ok(mut guard) = self.entries.lock() {
            guard.push_front(entry);
            while guard.len() > DIAGNOSTICS_RING_CAPACITY {
                guard.pop_back();
            }
        }
    }

    /// 读取全部诊断条目（新条目在前；供 core_get_status.diagnostics 组装）
    pub fn entries(&self) -> Vec<SubsystemDiagnostic> {
        self.entries
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 写入 lastError（T04.5-1：error 收场 / catch 兜底时调用）
    pub fn set_last_error(&self, error: CrishErrorPayload) {
        self.last_error.set(error);
    }

    // G11a 备注：clear_last_error 非 test 构建无 bin 消费者（lastError 清除
    // 未接线），测试覆盖（last_error_slot_roundtrip）——dead_code 静音。
    /// 清除 lastError
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn clear_last_error(&self) {
        self.last_error.clear();
    }

    /// 读取 lastError（None = 无最近错误）
    pub fn last_error(&self) -> Option<CrishErrorPayload> {
        self.last_error.get()
    }
}

/// 当前 UTC 毫秒时间戳（epoch ms）
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(code: &str) -> CrishErrorPayload {
        conex_types::CrishError::new(code, "模拟错误").to_error_payload(0)
    }

    /// 环形 20 条：超出丢弃最旧，新条目在前
    #[test]
    fn ring_capacity_keeps_newest_20() {
        let diagnostics = StatusDiagnostics::new();
        for i in 0..25 {
            diagnostics.record(format!("sub-{i}"), true, Some(format!("第 {i} 条")));
        }
        let entries = diagnostics.entries();
        assert_eq!(entries.len(), DIAGNOSTICS_RING_CAPACITY);
        assert_eq!(entries[0].subsystem, "sub-24", "最新条目在前");
        assert_eq!(entries[19].subsystem, "sub-5", "最旧的 5 条被丢弃");
        assert!(entries[0].ready);
        assert!(entries[0].updated_at > 0, "updatedAt 为 epoch ms");
    }

    /// lastError AtomicSlot：写入/读取/清除
    #[test]
    fn last_error_slot_roundtrip() {
        let diagnostics = StatusDiagnostics::new();
        assert!(diagnostics.last_error().is_none(), "初始为 null");
        diagnostics.set_last_error(payload("common.unknown"));
        let error = diagnostics.last_error().expect("写入后应可读");
        assert_eq!(error.code, "common.unknown");
        assert!(error.message.contains("模拟错误"));
        // 覆盖写入
        diagnostics.set_last_error(payload("tool.execution_failed"));
        assert_eq!(
            diagnostics.last_error().unwrap().code,
            "tool.execution_failed"
        );
        // 清除
        diagnostics.clear_last_error();
        assert!(diagnostics.last_error().is_none());
    }

    /// AtomicSlot 泛型独立可用（T04.5-1：载荷由 to_error_payload 产出）
    #[test]
    fn atomic_slot_is_generic() {
        let slot = AtomicSlot::<u64>::new();
        assert!(!slot.is_some());
        slot.set(42);
        assert!(slot.is_some());
        assert_eq!(slot.get(), Some(42));
        slot.clear();
        assert_eq!(slot.get(), None);
    }

    /// 诊断与 lastError 互不干扰
    #[test]
    fn diagnostics_and_last_error_are_independent() {
        let diagnostics = StatusDiagnostics::new();
        diagnostics.record("engine", true, Some("ready".to_string()));
        diagnostics.set_last_error(payload("provider.auth"));
        assert_eq!(diagnostics.entries().len(), 1);
        assert_eq!(diagnostics.last_error().unwrap().code, "provider.auth");
    }
}
