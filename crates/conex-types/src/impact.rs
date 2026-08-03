//! 操作影响面评估结果（I2-S8：审计事件载荷与审批弹窗数据源）
//!
//! 删除/回退类操作执行前计算影响面（文件数 / 总大小 / 目录数 / 跨目录），
//! 作为 `security-audit` 事件载荷与（S9）审批弹窗数据源。计算实现
//! （遍历）在 conex-fs（`conex_fs::impact::assess`），本类型属于双端
//! 事件契约（wire 结构），故定义在本 crate 供事件注册表与生成链路消费。

use serde::{Deserialize, Serialize};

/// 谨慎标记阈值（05 §13.1「>20 文件或跨目录谨慎」语义）
pub const IMPACT_FLAG_FILE_THRESHOLD: u64 = 20;

/// 影响面评估结果（camelCase 对齐工具输出与事件载荷）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactAssessment {
    /// 目标文件数（直接文件 + 目录内递归文件；符号链接按单文件计）
    pub file_count: u64,
    /// 总大小（字节）
    pub total_size_bytes: u64,
    /// 目录目标数
    pub directory_count: u64,
    /// 文件目标分布在多个父目录（跨目录结构）
    pub cross_directory: bool,
    /// 谨慎标记（file_count > [IMPACT_FLAG_FILE_THRESHOLD]）
    pub flagged: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impact_assessment_serializes_camel_case() {
        let impact = ImpactAssessment {
            file_count: 2,
            total_size_bytes: 8,
            directory_count: 1,
            cross_directory: false,
            flagged: false,
        };
        let json = serde_json::to_value(impact).unwrap();
        assert_eq!(json["fileCount"], 2);
        assert_eq!(json["totalSizeBytes"], 8);
        assert_eq!(json["directoryCount"], 1);
        assert_eq!(json["crossDirectory"], false);
        assert_eq!(json["flagged"], false);
        let back: ImpactAssessment = serde_json::from_value(json).unwrap();
        assert_eq!(impact, back, "影响面载荷 roundtrip 保真");
    }

    #[test]
    fn impact_threshold_constant_aligns_docs() {
        // 05 §13.1「>20 文件或跨目录谨慎」：严格大于 20 才标记
        assert_eq!(IMPACT_FLAG_FILE_THRESHOLD, 20);
    }
}
