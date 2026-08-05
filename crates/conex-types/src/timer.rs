//! 定时器域类型（T-CF-04：02-CF 定时唤醒与工具方案 §4.1 冻结类型）
//!
//! [TimerCondition] / [TimerHandle] / [TimerDeclaration] 是 AI 侧 set_timer
//! 工具（agent-tools，T-CF-05）与引擎侧 TimerRegistry
//! （apps/agent-workbench/src-tauri/src/timers.rs，T-CF-06/T-CF-09）之间的
//! 跨层契约形状：工具返回句柄、注册表持久化声明、唤醒逻辑读剩余时间。
//!
//! serde 命名：枚举 wire kebab-case（[TimerCondition]）、结构体字段 camelCase
//! （对齐前端解析层与既有事件信封字段命名，02-CF §四 前言）。
//! 本模块不依赖事件域：timer-fired / timer-cancelled 事件见 events.rs
//! （§4.7 事件接入表）。

use serde::{Deserialize, Serialize};

/// 定时器早退条件（REQ-C02：REQ-agent-engine-capabilities.md:309-313）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimerCondition {
    /// 无条件等到期，除非显式取消
    Never,
    /// 收到任何来源消息即取消
    Any,
    /// 仅指定 task-id 的消息可触发早退（含 agent-id 同义复用）
    Task(String),
}

/// 定时器句柄（工具返回给 AI 的引用，可作取消入参）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimerHandle {
    /// 定时器 id（timer-<seq>，命名风格对齐 task-<seq> 先例）
    pub timer_id: String,
    /// 绝对到期时刻（epoch 毫秒）
    pub expires_at_ms: u64,
    /// 回显入参（秒）
    pub duration_seconds: u64,
    /// 到期注入的提示内容
    pub prompt: String,
    /// 回显入参（早退条件）
    pub condition: TimerCondition,
}

/// 持久化声明（session_meta `timer_*` 键的 JSON 形状；
/// 对齐 DispatchDeclaration 先例 wait_subagents.rs:124-199）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimerDeclaration {
    /// 定时器 id（timer-<seq>）
    pub timer_id: String,
    /// 落库时刻（epoch 毫秒；重启后剩余时间 = expires_at_ms - now）
    pub created_at_ms: u64,
    /// 绝对到期时刻（epoch 毫秒）
    pub expires_at_ms: u64,
    /// 到期注入的提示内容
    pub prompt: String,
    /// 早退条件
    pub condition: TimerCondition,
    /// 已到期标志（重启后避免重复注入）
    pub fired: bool,
    /// 已取消标志
    pub cancelled: bool,
}

impl TimerDeclaration {
    /// 剩余毫秒（到期/超时后为 0，saturating 防下溢；写法对齐
    /// DispatchDeclaration::remaining_wait_ms wait_subagents.rs:138-147——
    /// 与 dispatch 声明不同，定时器声明恒有截止时刻，故直接返回数值
    /// 而非 Option）
    pub fn remaining_ms(&self, now_ms: u64) -> u64 {
        self.expires_at_ms.saturating_sub(now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 三种条件 JSON 往返一致（wire kebab-case：never/any + Task 的
    /// newtype 载荷 `{"task": "<id>"}`）
    #[test]
    fn timer_condition_serde_roundtrip() {
        let cases = [
            (TimerCondition::Never, json!("never")),
            (TimerCondition::Any, json!("any")),
            (TimerCondition::Task("task-42".into()), json!({"task": "task-42"})),
        ];
        for (cond, wire) in cases {
            let out = serde_json::to_value(&cond).unwrap();
            assert_eq!(out, wire, "TimerCondition 序列化 wire 值不符");
            let back: TimerCondition = serde_json::from_value(wire).unwrap();
            assert_eq!(back, cond, "TimerCondition 反序列化回环不符");
        }
    }

    /// 到期前后剩余时间计算正确：到期前 = expires - now；到点/超时后
    /// = 0（不出现负数或溢出，对齐 remaining_wait_ms 的 saturating 语义）
    #[test]
    fn timer_declaration_remaining_ms() {
        let decl = TimerDeclaration {
            timer_id: "timer-1".into(),
            created_at_ms: 1_000_000,
            expires_at_ms: 1_030_000,
            prompt: "检查编译".into(),
            condition: TimerCondition::Never,
            fired: false,
            cancelled: false,
        };
        assert_eq!(decl.remaining_ms(1_010_000), 20_000, "到期前剩余毫秒");
        assert_eq!(decl.remaining_ms(1_030_000), 0, "到点必须为 0");
        assert_eq!(decl.remaining_ms(1_040_000), 0, "超时后必须为 0（不溢出为负数）");
        assert_eq!(
            decl.remaining_ms(u64::MAX),
            0,
            "超大 now 不得下溢（saturating 兜底）"
        );
    }

    /// TimerHandle / TimerDeclaration camelCase wire 形状锚定（02-CF §4.1）
    #[test]
    fn timer_types_serialize_camel_case() {
        let handle = TimerHandle {
            timer_id: "timer-1".into(),
            expires_at_ms: 1_030_000,
            duration_seconds: 30,
            prompt: "检查编译".into(),
            condition: TimerCondition::Any,
        };
        let json = serde_json::to_value(&handle).unwrap();
        assert_eq!(json["timerId"], "timer-1");
        assert_eq!(json["expiresAtMs"], 1_030_000);
        assert_eq!(json["durationSeconds"], 30);
        assert_eq!(json["prompt"], "检查编译");
        assert_eq!(json["condition"], "any");
        let back: TimerHandle = serde_json::from_value(json).unwrap();
        assert_eq!(back, handle, "TimerHandle roundtrip 保真");

        let decl = TimerDeclaration {
            timer_id: "timer-1".into(),
            created_at_ms: 1_000_000,
            expires_at_ms: 1_030_000,
            prompt: "检查编译".into(),
            condition: TimerCondition::Task("task-42".into()),
            fired: true,
            cancelled: false,
        };
        let json = serde_json::to_value(&decl).unwrap();
        assert_eq!(json["createdAtMs"], 1_000_000);
        assert_eq!(json["expiresAtMs"], 1_030_000);
        assert_eq!(json["fired"], true);
        assert_eq!(json["cancelled"], false);
        assert_eq!(json["condition"]["task"], "task-42");
        let back: TimerDeclaration = serde_json::from_value(json).unwrap();
        assert_eq!(back, decl, "TimerDeclaration roundtrip 保真");
    }
}
