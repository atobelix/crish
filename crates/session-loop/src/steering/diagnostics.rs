//! 自终止诊断（D4：非 error 语义）
//!
//! 背景（01 第四章 D2/D4）：TS 端在 turn-complete 检测到「承诺调用工具但
//! 未调用」时发射观测性诊断（`runtime-error` + retryable:true）。裁决：
//! - **D2**：tool-promise 机制删除——`promisedToolsWithoutCall` 计数器删除，
//!   run 内不再注入 tool-promise nudge；
//! - **D4**：自终止观测保留，但事件语义改为**非 error 诊断**（不改变收场
//!   reason、不 retryable），字段含 toolCallCount / turnIndex / maxTurns /
//!   promisedToolsWithoutCall。
//!
//! 本结构按 D4 保留字段结构；因 D2 计数已删除，`promised_tools_without_call`
//! 恒为 0，诊断条件默认不触发。具体数值由 orchestrator（B4）在收场决策时
//! 填写并广播为诊断事件（对齐 01 §五.10：观测性事件与 endReason 正交）。

use serde::{Deserialize, Serialize};

/// 自终止诊断载荷（对齐 01 D4：非 error 语义的 provider-diagnostic 类事件）
///
/// 序列化字段名（camelCase）：`toolCallCount` / `turnIndex` / `maxTurns` /
/// `promisedToolsWithoutCall`。
///
/// **注意（T06.3 Q09 标注）**：本类型为 D2/D4 契约保留结构——字段结构按
/// 文档承诺不可变（serde 序列化契约），仅测试与观测消费（divergence.rs）；
/// 生产代码请勿新增依赖。
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfTerminationDiagnostic {
    /// 当前轮工具调用数量
    pub tool_call_count: u32,
    /// 当前轮次编号
    pub turn_index: u32,
    /// 最大轮次上限
    pub max_turns: u32,
    /// 结构保留位：D2 删除 tool-promise 计数后恒为 0（由 orchestrator 填）
    pub promised_tools_without_call: u32,
}

impl SelfTerminationDiagnostic {
    /// 构建诊断载荷（D2：promised_tools_without_call 固定为 0）
    pub fn new(tool_call_count: u32, turn_index: u32, max_turns: u32) -> Self {
        Self {
            tool_call_count,
            turn_index,
            max_turns,
            promised_tools_without_call: 0,
        }
    }

    /// 是否应发射诊断事件。
    ///
    /// D2 删除 tool-promise 机制后恒为 false（计数恒 0）；
    /// 保留判定位供 orchestrator 观测扩展（对齐 D4「保留自终止观测」）。
    pub fn should_emit(&self) -> bool {
        self.promised_tools_without_call > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 字段结构与序列化名称（toolCallCount/turnIndex/maxTurns/promisedToolsWithoutCall）
    #[test]
    fn serde_roundtrip_uses_d4_field_names() {
        let diagnostic = SelfTerminationDiagnostic {
            tool_call_count: 3,
            turn_index: 2,
            max_turns: 16,
            promised_tools_without_call: 1,
        };
        let json = serde_json::to_value(diagnostic).expect("序列化");
        assert_eq!(
            json,
            serde_json::json!({
                "toolCallCount": 3,
                "turnIndex": 2,
                "maxTurns": 16,
                "promisedToolsWithoutCall": 1,
            }),
            "camelCase 字段名与 01 D4 一致"
        );
        let back: SelfTerminationDiagnostic = serde_json::from_value(json).expect("反序列化");
        assert_eq!(back, diagnostic);
    }

    /// D2：new() 的 promisedToolsWithoutCall 恒为 0
    #[test]
    fn new_sets_promised_tools_without_call_to_zero() {
        let diagnostic = SelfTerminationDiagnostic::new(3, 2, 16);
        assert_eq!(
            diagnostic.promised_tools_without_call, 0,
            "D2 删除计数后为 0"
        );
        assert_eq!(diagnostic.tool_call_count, 3);
        assert_eq!(diagnostic.turn_index, 2);
        assert_eq!(diagnostic.max_turns, 16);
    }

    /// D2：默认构造不触发诊断（非 error 语义，仅观测保留）
    #[test]
    fn should_emit_is_false_by_default() {
        let diagnostic = SelfTerminationDiagnostic::new(0, 0, 16);
        assert!(!diagnostic.should_emit(), "tool-promise 删除后不触发");
        assert_eq!(diagnostic, SelfTerminationDiagnostic::new(0, 0, 16));
    }

    /// 非 error 语义：载荷本身不含任何 error/reason 字段（仅诊断数据）
    #[test]
    fn payload_is_pure_diagnostic_data() {
        let diagnostic = SelfTerminationDiagnostic::new(1, 3, 16);
        let json = serde_json::to_value(diagnostic).expect("序列化");
        let keys: Vec<String> = json.as_object().expect("对象").keys().cloned().collect();
        assert!(
            !keys
                .iter()
                .any(|k| k.contains("error") || k.contains("reason")),
            "诊断载荷无 error/reason 字段（不参与收场裁决）"
        );
    }
}
