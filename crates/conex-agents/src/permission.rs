//! 运行时权限单元：父链实时继承、只可收窄、批次边界生效。
//!
//! 设计要点（00 §4.1）：
//! - 子代理不保存权限快照，读父链当前值；
//! - 有效权限 = min(父有效权限, 子 ceiling, 子 own)；
//! - 父变更无需广播——下一次工具批次解析即生效；
//! - `ceiling` 是 spawn 时显式请求的上限（未请求 = Full，即完全跟随父）。

use std::sync::{Arc, RwLock};

use conex_types::PermissionMode;

/// 权限排序（Ask < Smart < Full）
pub const fn rank(mode: PermissionMode) -> u8 {
    match mode {
        PermissionMode::Ask => 0,
        PermissionMode::Smart => 1,
        PermissionMode::Full => 2,
    }
}

/// 取更严格的一档
pub fn min_mode(left: PermissionMode, right: PermissionMode) -> PermissionMode {
    if rank(left) <= rank(right) {
        left
    } else {
        right
    }
}

/// 运行时权限单元（主 run 为 root，子 run 挂到父单元下）
#[derive(Debug)]
pub struct PermissionCell {
    /// 本 run 自身显式设定（None = 不额外收窄）
    own: RwLock<Option<PermissionMode>>,
    /// 本 run 允许的上限（root = Full；子 = spawn 显式请求或 Full）
    ceiling: PermissionMode,
    /// 父单元（None = 主 agent，无父级限制）
    parent: Option<Arc<PermissionCell>>,
}

impl PermissionCell {
    /// 主 agent 根单元（初始模式即当前生效值）
    pub fn root(initial: PermissionMode) -> Arc<Self> {
        Arc::new(Self {
            own: RwLock::new(Some(initial)),
            ceiling: PermissionMode::Full,
            parent: None,
        })
    }

    /// 子代理单元：`ceiling=None` 表示完全跟随父；`Some(mode)` 为 spawn 时的显式收窄。
    pub fn child(parent: Arc<Self>, ceiling: Option<PermissionMode>) -> Arc<Self> {
        Arc::new(Self {
            own: RwLock::new(None),
            ceiling: ceiling.unwrap_or(PermissionMode::Full),
            parent: Some(parent),
        })
    }

    /// 当前有效权限（批次边界读取）
    pub fn effective(&self) -> PermissionMode {
        let base = self
            .parent
            .as_ref()
            .map(|parent| parent.effective())
            .unwrap_or(PermissionMode::Full);
        let own = *self.own.read().unwrap_or_else(|e| e.into_inner());
        min_mode(
            min_mode(base, self.ceiling),
            own.unwrap_or(PermissionMode::Full),
        )
    }

    /// 设置自身模式（root 可自由切换；子代理受 ceiling 与父级钳制）
    pub fn set(&self, mode: PermissionMode) {
        *self.own.write().unwrap_or_else(|e| e.into_inner()) =
            Some(min_mode(mode, self.ceiling));
    }

    /// 清除自身覆盖（回到跟随父/ceiling）
    pub fn clear_own(&self) {
        *self.own.write().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_follows_its_own_setting() {
        let root = PermissionCell::root(PermissionMode::Smart);
        assert_eq!(root.effective(), PermissionMode::Smart);
        root.set(PermissionMode::Full);
        assert_eq!(root.effective(), PermissionMode::Full);
        root.set(PermissionMode::Ask);
        assert_eq!(root.effective(), PermissionMode::Ask);
    }

    #[test]
    fn child_follows_parent_changes_when_not_narrowed() {
        let root = PermissionCell::root(PermissionMode::Smart);
        let child = PermissionCell::child(Arc::clone(&root), None);
        assert_eq!(child.effective(), PermissionMode::Smart);
        root.set(PermissionMode::Full);
        assert_eq!(child.effective(), PermissionMode::Full, "父变更子自动跟随");
        root.set(PermissionMode::Ask);
        assert_eq!(child.effective(), PermissionMode::Ask);
    }

    #[test]
    fn explicit_child_request_narrows_and_never_broadens() {
        let root = PermissionCell::root(PermissionMode::Full);
        let child = PermissionCell::child(Arc::clone(&root), Some(PermissionMode::Smart));
        assert_eq!(child.effective(), PermissionMode::Smart);
        child.set(PermissionMode::Full);
        assert_eq!(
            child.effective(),
            PermissionMode::Smart,
            "ceiling 阻止子代理自我放宽"
        );
        root.set(PermissionMode::Ask);
        assert_eq!(child.effective(), PermissionMode::Ask);
    }

    #[test]
    fn grandchild_clamps_through_chain() {
        let root = PermissionCell::root(PermissionMode::Full);
        let child = PermissionCell::child(Arc::clone(&root), None);
        let grandchild = PermissionCell::child(Arc::clone(&child), Some(PermissionMode::Smart));
        assert_eq!(grandchild.effective(), PermissionMode::Smart);
        root.set(PermissionMode::Ask);
        assert_eq!(grandchild.effective(), PermissionMode::Ask);
    }
}
