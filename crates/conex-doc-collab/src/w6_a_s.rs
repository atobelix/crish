//! **W6-A-S** Skeleton：A-BLK 契约/属性 **抽样**轨锚点
//!
//! # 轨与包标识
//! - 包 ID：**W6-A-S**（必须带 `-S`；Skeleton 轨；**禁止**去 `-S` 冒充 Strict）
//! - 文件域：`crates/conex-doc-collab/tests/a_blk_contract.rs` +
//!   `packages/block-paper/**` A-BLK 测 + 本模块
//! - 调度：`docs/block-workspace-architecture/plans/09-执行任务包索引.md` W6-A-S
//! - 进度：`docs/block-workspace-architecture/plans/acceptance/A-BLK-progress.md`
//!
//! # 骨架可测点（本包交付 · 抽样）
//! 1. **包 ID 可点名**：[`W6_A_S_PACKAGE_ID`] == `"W6-A-S"` 且 `ends_with("-S")`
//! 2. A-BLK 抽样场景表（可点名；与 `tests/a_blk_contract.rs` 对齐）
//! 3. 余量加深（本波）：A-BLK-08 turn_into 保 `block_id` + 文本（≠ 选区 e2e / ≠ EL-01）
//!
//! # 诚实边界（强制 · 禁止假关）
//! - **≠ W6-A** Strict（A-BLK 全表 e2e / 产品拖放 / turn-into UI）
//! - **≠ EL-01**（块工作区完成）
//! - **≠** A-BLK-01…14 满表关闭
//!
//! # 与 plans/09
//! | 包 | 轨 | 完成定义 |
//! | -- | -- | -------- |
//! | **W6-A** | Strict | A-BLK 全表 e2e / 产品路径 |
//! | **W6-A-S** | Skeleton | A-BLK 契约/属性 **抽样**（本文 + a_blk 测） |

/// **W6-A-S** Skeleton 包标识（测 / 文档 / 调度对账）。
///
/// 必须保留 `-S` 后缀；去 `-S` 即冒充 **W6-A** Strict，禁止。
pub const W6_A_S_PACKAGE_ID: &str = "W6-A-S";

/// 本 Skeleton 轨绑定的 A 断言族（抽样族名；**非** A-BLK 全表关账）。
pub const W6_A_S_A_BLK_FAMILY: &str = "A-BLK";

/// 可点名抽样场景（与 `tests/a_blk_contract.rs` / TS `chrome.a_blk.test.ts` 对齐）。
///
/// 绿 = Skeleton 抽样可证伪；**≠** A-BLK 全表 / EL-01 关账。
pub const W6_A_S_A_BLK_SCENARIOS: &[&str] = &[
    "a_blk_01_block_id_stable_create_move_delete",
    "a_blk_01_undo_restores_block_id_after_delete",
    "a_blk_04_move_single_reorder_order",
    "a_blk_06_indent_nest_via_move_parent",
    "a_blk_07_cross_doc_import_must_regen_block_ids",
    "a_blk_08_turn_into_preserves_block_id_and_text",
    "a_blk_11_unknown_flavour_placeholder_preserves_text_and_id",
];

/// 文档/测用：本包 **不** 关闭的项（假关检查清单）。
pub const W6_A_S_NOT_CLOSING: &[&str] = &[
    "EL-01",
    "W6-A Strict A-BLK 全表 e2e",
    "A-BLK-01…14 满表关闭",
    "产品拖放预览 / turn-into 恢复 UI / 选区 e2e",
];

/// 轨标签：Skeleton（对照 Strict）。
pub const W6_A_S_TRACK: &str = "Skeleton";

/// 断言本 crate 锚点是否宣称 W6-A-S 包 ID（调度/测共用）。
#[inline]
pub fn is_w6_a_s_package_id(id: &str) -> bool {
    id == W6_A_S_PACKAGE_ID
}

/// 包 ID 是否带 Skeleton 后缀（`-S`）。
#[inline]
pub fn package_id_is_skeleton_track() -> bool {
    W6_A_S_PACKAGE_ID.ends_with("-S") && W6_A_S_PACKAGE_ID == "W6-A-S"
}

/// 诚实：本包 **不得** 被解释为关闭 EL-01 或 W6-A Strict。
#[inline]
pub fn does_not_close_el01_or_w6_a() -> bool {
    W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("EL-01"))
        && W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("W6-A Strict"))
        && package_id_is_skeleton_track()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 包锚：常量与 `-S` 叙事；诚实钉 ≠ W6-A / ≠ EL-01。
    #[test]
    fn w6_a_s_package_id_is_skeleton_track() {
        assert_eq!(W6_A_S_PACKAGE_ID, "W6-A-S");
        assert!(
            W6_A_S_PACKAGE_ID.ends_with("-S"),
            "Skeleton 轨必须带 -S；禁止去 -S 冒充 Strict"
        );
        assert!(package_id_is_skeleton_track());
        assert!(is_w6_a_s_package_id("W6-A-S"));
        assert!(!is_w6_a_s_package_id("W6-A"));
        assert_eq!(W6_A_S_TRACK, "Skeleton");
        // 诚实钉：≠ EL-01 / ≠ W6-A Strict / ≠ A-BLK 满表
        assert!(does_not_close_el01_or_w6_a());
        assert!(W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("EL-01")));
        assert!(W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("W6-A Strict")));
        assert!(W6_A_S_NOT_CLOSING.iter().any(|s| s.contains("A-BLK-01…14")));
        let _ = "W6-A-S ≠ W6-A / ≠ EL-01 满关";
    }

    /// 子集契约：W6-A-S 轨绑定 A-BLK 族抽样（非 01…14 满表关账）。
    #[test]
    fn w6_a_s_binds_a_blk_sample_scenarios_not_full_table() {
        assert_eq!(W6_A_S_A_BLK_FAMILY, "A-BLK");
        assert!(
            !W6_A_S_A_BLK_SCENARIOS.is_empty(),
            "抽样场景表不得为空"
        );
        assert!(
            W6_A_S_A_BLK_SCENARIOS
                .iter()
                .any(|s| s.contains("a_blk_08_turn_into")),
            "本波余量加深须点名 A-BLK-08 turn_into 场景"
        );
        assert!(
            W6_A_S_A_BLK_SCENARIOS
                .iter()
                .any(|s| s.contains("a_blk_01")),
            "既有 A-BLK-01 抽样须仍在表中"
        );
        // 族名 ≠ 满表：不得把本常量写成 A-BLK-01…14
        assert!(!W6_A_S_A_BLK_FAMILY.contains('…'));
        assert!(!W6_A_S_A_BLK_FAMILY.contains("01"));
    }
}
