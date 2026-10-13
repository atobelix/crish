//! 撤回副作用回滚（统一输入流收敛战役 R1 · 详案 §1.2-④，扩展点 D）
//!
//! # 「类别→回滚策略」注册表
//!
//! 类别轴 = `ToolCategory`（crates/conex-types/src/tool.rs，P1 保留为投影
//! 标签 + 策略分派键；评审 02 ②#3 + 核心模型 §7 纪律 1：**不新建第二类别
//! 枚举**）。默认映射按工具类别粗分：
//!
//! - `Terminal` → [RollbackStrategy::None]（命令类副作用不可自动回滚，
//!   保守不动作；大面积回退场景由上层 RevertPolicy 门禁另行裁决）；
//! - `Filesystem` → [RollbackStrategy::TrashRestore]（写前快照
//!   snapshot + restore_force，S10b 语义）；
//! - 其余类别（Network / Mcp / Skill / Agent / Internal）→ 保守默认
//!   [RollbackStrategy::None]（网络/外部副作用不可回滚；Internal 由
//!   工具名/实际类别细分，P1 接线真类别后自动收敛）。
//!
//! 职责分离（详案 §1.2-④）：**类别轴安全判定不读类别**（P1 决策 4，
//! permission 面），**回滚策略读类别**（扩展点 D）——两者解耦。
//!
//! # rollback_before 执行器
//!
//! 历史 path-only 写类入口经 trash 层 fail-closed 拒绝，不能再按路径消费
//! 快照。生产撤回由壳层按 ToolEnd owner 调用
//! [conex_fs::trash::TrashService::rollback_operations]；本执行器仅保留类别
//! 策略投影兼容面。只读/无副作用类仍由 [RollbackStrategy::None] 空实现。

use conex_types::tool::ToolCategory;

/// 工具类别 → 回滚策略（扩展点 D 数据驱动；不用 trait 树）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackStrategy {
    /// 只读/无副作用：空实现（无操作）
    None,
    /// 文件写类：写前快照 snapshot + restore_force（S10b 语义）
    TrashRestore,
    /// git 类：过 RevertPolicy 门禁后回滚（C3/C4 审批门禁为独立层，
    /// 撤回回滚若涉及大面积回退先过 `RevertPolicy.gate_verdict` 再执行）
    GitRevertGated,
}

/// 工具类别 → 回滚策略注册表（扩展点 D：插件可注册覆盖默认映射）
///
/// 类别轴 = `ToolCategory`（P1 保留为投影标签 + 策略分派键，不新建第二
/// 类别枚举）；`ToolCategory` 未实现 Hash（tool.rs 只读，P1 归属），
/// 注册表以线性表承载（类别轴 ≤7 项，查找代价可忽略，反过度设计）。
#[derive(Debug, Clone, Default)]
pub struct CategoryRollbackRegistry {
    map: Vec<(ToolCategory, RollbackStrategy)>,
}

impl CategoryRollbackRegistry {
    /// 默认映射（按工具类别粗分；保守默认 None，写类显式 TrashRestore）
    pub fn default_() -> Self {
        Self {
            map: vec![(ToolCategory::Filesystem, RollbackStrategy::TrashRestore)],
        }
    }

    /// 查询类别回滚策略（未登记类别 → 保守 None）
    pub fn strategy_for(&self, category: ToolCategory) -> RollbackStrategy {
        self.map
            .iter()
            .find(|(c, _)| *c == category)
            .map(|(_, s)| *s)
            .unwrap_or(RollbackStrategy::None)
    }

    /// 注册/覆盖类别策略（扩展点：插件可注册）
    pub fn register(&mut self, category: ToolCategory, strategy: RollbackStrategy) {
        if let Some(entry) = self.map.iter_mut().find(|(c, _)| *c == category) {
            entry.1 = strategy;
        } else {
            self.map.push((category, strategy));
        }
    }

    /// 类别清单（观测/断言）
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// 是否为空注册表
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// 单路径回滚结果（幂等降级：无快照/原路径已不在 → skipped）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathRollbackResult {
    /// 已还原（写前快照 restore_force 成功）
    Restored { path: String },
    /// 无对应写前快照（路径在边界后未被写，或快照已被消费）——幂等跳过
    Skipped { path: String, reason: String },
    /// 还原失败（checksum 校验失败 / 原路径非法等）
    Failed { path: String, error: String },
}

/// 撤回回滚执行器（扩展点 D 承载面）
///
/// `rollback_before(boundary, category_paths)` 是旧 path-only API。Filesystem
/// 非空路径无法与 ToolEnd owner 精确关联，trash 会返回错误，本执行器把它
/// 透传为 `Failed`；生产回滚须使用 owner-aware `rollback_operations`。
pub struct RollbackExecutor<'a> {
    registry: &'a CategoryRollbackRegistry,
    trash: Option<&'a conex_fs::trash::TrashService>,
}

impl<'a> RollbackExecutor<'a> {
    /// 装配执行器（trash 为写类回滚底座；None = 未接线，写类降级 skipped）
    pub fn new(
        registry: &'a CategoryRollbackRegistry,
        trash: Option<&'a conex_fs::trash::TrashService>,
    ) -> Self {
        Self { registry, trash }
    }

    /// 按类别分派旧 path-only 回滚；Filesystem 非空路径会显式失败。
    ///
    /// `category_paths`：类别 → 输出路径清单（由调用方按撤回边界后
    /// tool-end 输出收集；路径去重后传入）。
    pub fn rollback_before(
        &self,
        boundary: u64,
        category_paths: &[(ToolCategory, Vec<String>)],
    ) -> Vec<PathRollbackResult> {
        let mut results = Vec::new();
        for (category, paths) in category_paths {
            match self.registry.strategy_for(*category) {
                RollbackStrategy::None => {
                    // 只读/无副作用：空实现（无操作）
                    for p in paths {
                        results.push(PathRollbackResult::Skipped {
                            path: p.clone(),
                            reason: "类别回滚策略为 None（无副作用/不可自动回滚）".into(),
                        });
                    }
                }
                RollbackStrategy::TrashRestore => {
                    let Some(_trash) = self.trash else {
                        for p in paths {
                            results.push(PathRollbackResult::Skipped {
                                path: p.clone(),
                                reason: "trash 底座未接线".into(),
                            });
                        }
                        continue;
                    };
                    let _ = boundary;
                    for p in paths {
                        results.push(PathRollbackResult::Failed {
                            path: p.clone(),
                            error: "path-only 回滚缺少事件 owner；生产回滚须使用 owner-aware rollback_operations".into(),
                        });
                    }
                }
                RollbackStrategy::GitRevertGated => {
                    // git 类：过 RevertPolicy 门禁后回滚——门禁层（C3/C4）
                    // 为独立审批面，撤回路径若触发大面积回退由上层先过
                    // gate_verdict 再调用本执行器；本执行器不做自动 git
                    // 回退（避免未经门禁的隐式大面积改写），登记 skipped
                    // 并注明（安全优先，fail-closed）。
                    for p in paths {
                        results.push(PathRollbackResult::Skipped {
                            path: p.clone(),
                            reason:
                                "git 类回滚须先过 RevertPolicy 门禁（C3/C4），撤回路径未自动执行"
                                    .into(),
                        });
                    }
                }
            }
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认映射：Filesystem → TrashRestore；其余保守 None；未登记类别 None
    #[test]
    fn default_registry_maps_categories() {
        let reg = CategoryRollbackRegistry::default_();
        assert_eq!(
            reg.strategy_for(ToolCategory::Filesystem),
            RollbackStrategy::TrashRestore
        );
        assert_eq!(
            reg.strategy_for(ToolCategory::Terminal),
            RollbackStrategy::None
        );
        assert_eq!(
            reg.strategy_for(ToolCategory::Network),
            RollbackStrategy::None
        );
        assert_eq!(
            reg.strategy_for(ToolCategory::Internal),
            RollbackStrategy::None
        );
        assert_eq!(reg.strategy_for(ToolCategory::Mcp), RollbackStrategy::None);
    }

    /// 扩展点：register 覆盖默认映射
    #[test]
    fn register_overrides_default() {
        let mut reg = CategoryRollbackRegistry::default_();
        reg.register(ToolCategory::Terminal, RollbackStrategy::GitRevertGated);
        assert_eq!(
            reg.strategy_for(ToolCategory::Terminal),
            RollbackStrategy::GitRevertGated
        );
    }

    /// 只读类空实现：None 策略路径 → skipped（无操作），不触碰 trash
    #[test]
    fn none_strategy_is_noop() {
        let reg = CategoryRollbackRegistry::default_();
        let exec = RollbackExecutor::new(&reg, None);
        let results = exec.rollback_before(
            42,
            &[(ToolCategory::Terminal, vec!["/ws/out.log".to_string()])],
        );
        assert_eq!(results.len(), 1);
        assert!(matches!(
            &results[0],
            PathRollbackResult::Skipped { reason, .. }
                if reason.contains("None")
        ));
    }

    /// trash 未接线：写类路径降级 skipped（不 panic）
    #[test]
    fn trash_restore_without_trash_base_is_skipped() {
        let reg = CategoryRollbackRegistry::default_();
        let exec = RollbackExecutor::new(&reg, None);
        let results = exec.rollback_before(
            42,
            &[(ToolCategory::Filesystem, vec!["/ws/a.txt".to_string()])],
        );
        assert!(matches!(
            &results[0],
            PathRollbackResult::Skipped { reason, .. }
                if reason.contains("trash 底座未接线")
        ));
    }

    /// 旧 path-only 回滚不得假报成功或消费边界外快照。
    #[test]
    fn trash_path_only_selection_is_reported_as_failed() {
        let reg = CategoryRollbackRegistry::default_();
        let trash = conex_fs::trash::TrashService::new(
            std::env::temp_dir().join("unused-retraction-trash-root"),
        );
        let exec = RollbackExecutor::new(&reg, Some(&trash));
        let results = exec.rollback_before(
            42,
            &[(ToolCategory::Filesystem, vec!["/ws/a.txt".to_string()])],
        );
        assert!(matches!(
            &results[0],
            PathRollbackResult::Failed { error, .. }
                if error.contains("缺少事件 owner")
        ));
    }

    /// git 类：fail-closed——不经门禁不自动回退
    #[test]
    fn git_gated_is_not_auto_executed() {
        let mut reg = CategoryRollbackRegistry::default_();
        reg.register(ToolCategory::Terminal, RollbackStrategy::GitRevertGated);
        let exec = RollbackExecutor::new(&reg, None);
        let results = exec.rollback_before(
            42,
            &[(ToolCategory::Terminal, vec!["/ws/repo".to_string()])],
        );
        assert!(matches!(
            &results[0],
            PathRollbackResult::Skipped { reason, .. }
                if reason.contains("RevertPolicy")
        ));
    }
}
