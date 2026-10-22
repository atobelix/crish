//! 构建状态：预算余量与统计计数，贯穿建树、索引分配与序列化各步骤。

use crate::snapshot::budget::{BudgetConfig, TruncationInfo, TruncationKind};
use std::collections::HashSet;

/// 构建状态（预算/统计贯穿构建与序列化）。
pub(super) struct BuildState {
    pub(super) nodes_left: usize,
    pub(super) selectors_left: usize,
    pub(super) output_left: usize,
    pub(super) element_count: usize,
    pub(super) selector_count: usize,
    pub(super) dropped_nodes: usize,
    pub(super) dropped_interactive: usize,
    pub(super) truncation: Option<TruncationInfo>,
    /// 树中全部 backendNodeId（合成索引碰撞避开用）
    pub(super) used_ids: HashSet<i64>,
    pub(super) synthetic_next: u32,
    pub(super) assigned: HashSet<u32>,
    pub(super) canvas: usize,
    pub(super) video: usize,
    pub(super) image: usize,
    pub(super) unoperable: usize,
    /// 文本截断计数（预算 3）
    pub(super) text_truncated: usize,
    /// 索引截断计数（预算 4）
    pub(super) selector_truncated: usize,
}

impl BuildState {
    pub(super) fn new(budgets: &BudgetConfig) -> Self {
        BuildState {
            nodes_left: budgets.max_tree_nodes,
            selectors_left: budgets.max_selector_indices,
            output_left: budgets.max_output_bytes,
            element_count: 0,
            selector_count: 0,
            dropped_nodes: 0,
            dropped_interactive: 0,
            truncation: None,
            used_ids: HashSet::new(),
            synthetic_next: 1,
            assigned: HashSet::new(),
            canvas: 0,
            video: 0,
            image: 0,
            unoperable: 0,
            text_truncated: 0,
            selector_truncated: 0,
        }
    }

    pub(super) fn note_truncation(&mut self, kind: TruncationKind) {
        if self.truncation.is_none() {
            self.truncation = Some(TruncationInfo {
                truncated_by: kind,
                dropped_nodes: 0,
                dropped_interactive: 0,
            });
        }
    }

    pub(super) fn finalize_truncation(mut self) -> Option<TruncationInfo> {
        if let Some(t) = self.truncation.as_mut() {
            t.dropped_nodes = self.dropped_nodes;
            t.dropped_interactive = self.dropped_interactive;
        }
        self.truncation
    }
}
