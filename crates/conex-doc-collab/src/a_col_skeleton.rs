//! **W6-D-S** Skeleton：in-process **A-COL-01** 子集轨锚点
//!
//! # 轨与包标识
//! - 包 ID：**W6-D-S**（必须带 `-S`；Skeleton 轨；**禁止**去 `-S` 冒充 Strict）
//! - 文件域：`crates/conex-doc-collab/**`（本模块 + harness + `tests/a_col_dual_peer`）
//! - 调度：`docs/block-workspace-architecture/plans/09-执行任务包索引.md` W6-D-S
//!
//! # 骨架可测点（本包交付 · 子集）
//! 1. **包 ID 可点名**：[`W6_D_S_PACKAGE_ID`] == `"W6-D-S"` 且 `ends_with("-S")`
//! 2. **A-COL-01 子集契约**：in-process 双 peer（[`crate::DualSessionHarness`]）上
//!    - 并发 insert 不同块 → 结构 id 并集一致
//!    - 同块 text 互推 → 文本收敛
//!    - delete ∥ 远端 update → 删胜（M1 方向）
//! 3. 测路径：`tests/a_col_dual_peer.rs`、`tests/a_col_subset_skeleton.rs`、本模块 unit
//!
//! # 诚实边界（强制 · 禁止假关）
//! - **≠ W6-D** Strict（A-COL 全族满语义 + 脚手架退出条件）
//! - **≠ EL-04**（须 W1-F + **W6-D** + G-HYD；见 `plans/08` / `acceptance/EL-dashboard`）
//! - **≠ A-COL-01…08 满语义** / 状态哈希可复算终局 / 结构真 CRDT encode
//! - 结构侧仍可走 JSON 重放（[`crate::SimplifiedEncodedOps`]）；**不得**叙事为 A-COL 终局
//! - **不抹** W1-U（A-MEM-04 / A-COL-04 / undo）与既有 dual peer 绿测
//!
//! # 与 plans/09
//! | 包 | 轨 | 完成定义 |
//! | -- | -- | -------- |
//! | **W6-D** | Strict | A-COL 双 peer 完成度（全族满语义） |
//! | **W6-D-S** | Skeleton | in-process A-COL-01 **子集**（本文） |

/// **W6-D-S** Skeleton 包标识（测 / 文档 / 调度对账）。
///
/// 必须保留 `-S` 后缀；去 `-S` 即冒充 **W6-D** Strict，禁止。
pub const W6_D_S_PACKAGE_ID: &str = "W6-D-S";

/// 本 Skeleton 轨绑定的 A 断言族子集（单 ID 方向；**非** A-COL-01…08 满表）。
pub const W6_D_S_A_COL_SUBSET: &str = "A-COL-01";

/// 子集场景清单（可点名；与 `tests/a_col_dual_peer.rs` 对齐）。
///
/// 绿 = Skeleton 子集可证伪；**≠** A-COL-01 满语义关账。
pub const W6_D_S_A_COL_01_SCENARIOS: &[&str] = &[
    "concurrent_insert_diff_blocks_id_union",
    "same_block_concurrent_text_converge",
    "same_block_sequential_text_converge",
    "delete_vs_remote_text_delete_wins",
    "delete_vs_remote_props_delete_wins",
    "delete_then_lagged_text_not_found",
];

/// 文档/测用：本包 **不** 关闭的项（假关检查清单）。
pub const W6_D_S_NOT_CLOSING: &[&str] = &[
    "EL-04",
    "W6-D Strict A-COL 全族满语义",
    "A-COL-01…08 满语义 + 状态哈希终局",
    "结构真 CRDT encode / 脚手架退出（A-INV-08）",
];

/// 轨标签：Skeleton（对照 Strict）。
pub const W6_D_S_TRACK: &str = "Skeleton";

/// 断言本 crate 锚点是否宣称 W6-D-S 包 ID（调度/测共用）。
#[inline]
pub fn is_w6_d_s_package_id(id: &str) -> bool {
    id == W6_D_S_PACKAGE_ID
}

/// 包 ID 是否带 Skeleton 后缀（`-S`）。
#[inline]
pub fn package_id_is_skeleton_track() -> bool {
    W6_D_S_PACKAGE_ID.ends_with("-S") && W6_D_S_PACKAGE_ID == "W6-D-S"
}

/// 诚实：本包 **不得** 被解释为关闭 EL-04 或 W6-D Strict。
#[inline]
pub fn does_not_close_el04_or_w6_d() -> bool {
    W6_D_S_NOT_CLOSING.iter().any(|s| s.contains("EL-04"))
        && W6_D_S_NOT_CLOSING.iter().any(|s| s.contains("W6-D Strict"))
        && package_id_is_skeleton_track()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a_col::A_COL_01;

    /// 包锚：常量与 `-S` 叙事；诚实钉 ≠ W6-D / ≠ EL-04。
    #[test]
    fn w6_d_s_package_id_is_skeleton_track() {
        assert_eq!(W6_D_S_PACKAGE_ID, "W6-D-S");
        assert!(
            W6_D_S_PACKAGE_ID.ends_with("-S"),
            "Skeleton 轨必须带 -S；禁止去 -S 冒充 Strict"
        );
        assert!(package_id_is_skeleton_track());
        assert!(is_w6_d_s_package_id("W6-D-S"));
        assert!(!is_w6_d_s_package_id("W6-D"));
        assert_eq!(W6_D_S_TRACK, "Skeleton");
        // 诚实钉：≠ EL-04 / ≠ W6-D Strict / ≠ A-COL 满语义
        assert!(does_not_close_el04_or_w6_d());
        assert!(W6_D_S_NOT_CLOSING.iter().any(|s| s.contains("EL-04")));
        assert!(W6_D_S_NOT_CLOSING.iter().any(|s| s.contains("W6-D Strict")));
        assert!(W6_D_S_NOT_CLOSING.iter().any(|s| s.contains("A-COL-01…08")));
        let _ = "W6-D-S ≠ W6-D / ≠ EL-04 满关";
    }

    /// 子集契约：W6-D-S 轨绑定 A-COL-01（单 ID 子集，非 01…08 满表）。
    #[test]
    fn w6_d_s_binds_a_col_01_subset_not_full_family() {
        assert_eq!(W6_D_S_A_COL_SUBSET, "A-COL-01");
        assert_eq!(W6_D_S_A_COL_SUBSET, A_COL_01);
        assert_eq!(W6_D_S_A_COL_01_SCENARIOS.len(), 6);
        assert!(W6_D_S_A_COL_01_SCENARIOS
            .iter()
            .any(|s| s.contains("id_union")));
        assert!(W6_D_S_A_COL_01_SCENARIOS
            .iter()
            .any(|s| s.contains("text_converge")));
        assert!(W6_D_S_A_COL_01_SCENARIOS
            .iter()
            .any(|s| s.contains("delete_wins")));
        // 子集 ≠ 满族：不得把本常量写成 A-COL-01…08
        assert!(!W6_D_S_A_COL_SUBSET.contains('…'));
        assert!(!W6_D_S_A_COL_SUBSET.contains("02"));
    }
}
