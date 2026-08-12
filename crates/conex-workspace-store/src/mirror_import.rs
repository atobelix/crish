//! W2-E Strict · P6 import 提案：三路策略 + Op 批 **或** 冲突报告。
//!
//! # 模块内聚（**SD-26** 策略/X-05 门面 · **SD-37** 块级 diff 再抽）
//! - **本文件**：策略 / 入参 / 结果 / `import_mirror_proposal` / X-05 门禁
//! - [`propose`]（`mirror_import_propose.rs`）：`propose_block_level_ops` 块级 diff
//! - [`tests`]（`mirror_import_tests.rs`）：单元测外置（**SD-26**）
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::mirror_import::*` / `mirror` re-export）
//!
//! # X-05 / 禁静默覆盖（不回退）
//! - `unpushed_op_count > 0` 且策略非显式 [`ThreeWayStrategy::DropUnacked`] →
//!   [`ImportMirrorResult::Conflict`] 且 `silent_overwrite_blocked = true`。
//! - `import_mirror_proposal` **只提案**，从不 `apply` / 从不改 `doc_updates`。
//!
//! # 诚实边界
//! - **SD-26** · **SD-37** · **≠ EL-03** · **≠ inotify** · **≠** 默认双开 poll+OS
//! - **≠ A-INV-02 产品 UI**（不弹三路对话框）。
//! - 块级 diff **≠** 产品 fullRemount 唯一路径（本模块 **禁止** 默认 fullRemount）。
//! - **≠** 重做 E2′ / E3 / os_watch；**≠** 整包重做 SD-26。

use super::mirror_detect::{MirrorDriftClass, MirrorDriftReport};
use super::{content_hash, StoreError, WorkspaceStore};
use conex_doc_collab::{BlockTree, Op};
use conex_md_ast::parse_document_detailed;

/// 块级 diff 提案（**SD-37**）：`propose_block_level_ops`（**非** fullRemount）。
#[path = "mirror_import_propose.rs"]
mod propose;

use propose::propose_block_level_ops;

// ─── 策略 / 入参 / 结果 ───────────────────────────────────────────────────

/// 三路策略枚举（`02` §2.4 / round-E P6）。
///
/// 须由调用方 **显式** 选择；本 crate **不**在 unpushed>0 时默认 DropUnacked。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreeWayStrategy {
    /// 保留本地 unpushed，将 mirror 导入为 **候选** 补丁（可拒；不删本地独有块）。
    RetainLocalAndReimport,
    /// **显式** 丢弃未 ACK 本地，以 mirror 侧为准生成含 Delete 的提案。
    DropUnacked,
    /// 标记冲突，不产出可自动 apply 的 Op 批。
    ConflictBlocks,
}

/// `import_mirror_proposal` 入参。
#[derive(Debug, Clone)]
pub struct ImportMirrorOpts<'a> {
    /// 三路策略；**无默认静默 DropUnacked**。
    pub strategy: ThreeWayStrategy,
    /// 未推送 / 未 ACK 本地 op 数量。`>0` 时禁静默覆盖（X-05）。
    pub unpushed_op_count: usize,
    /// 当前权威树；用于块级 diff 提案。缺省则无法产 Op 批（仅冲突/无变更）。
    pub authority_tree: Option<&'a BlockTree>,
}

impl<'a> ImportMirrorOpts<'a> {
    pub fn new(strategy: ThreeWayStrategy) -> Self {
        Self {
            strategy,
            unpushed_op_count: 0,
            authority_tree: None,
        }
    }

    pub fn with_unpushed(mut self, n: usize) -> Self {
        self.unpushed_op_count = n;
        self
    }

    pub fn with_authority_tree(mut self, tree: &'a BlockTree) -> Self {
        self.authority_tree = Some(tree);
        self
    }
}

/// 冲突块摘要（ConflictBlocks / 双变人工路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictBlockInfo {
    pub block_id: String,
    pub reason: String,
}

/// [`WorkspaceStore::import_mirror_proposal`] 输出：**提案或冲突**，永不静默 apply。
#[derive(Debug, Clone)]
pub enum ImportMirrorResult {
    /// 无需从 mirror 导入（无漂移 / 仅权威变 / 文件未变）。
    NoChange { report: MirrorDriftReport },
    /// 可交给上层 `DocSession::apply` 的 **候选** Op 批（本函数 **不** apply）。
    OpBatch {
        report: MirrorDriftReport,
        strategy: ThreeWayStrategy,
        ops: Vec<Op>,
        /// mirror 源 MD 的 content hash。
        source_md_hash: String,
        /// 是否声明保留 unpushed（RetainLocal 路径）。
        preserves_unpushed: bool,
        /// 是否声明将丢弃 unpushed（仅 DropUnacked 且 unpushed>0）。
        discards_unpushed: bool,
        /// **非** fullRemount：true 表示块级 diff，而非「唯一路径=整树重挂」。
        is_block_level_diff: bool,
    },
    /// 冲突报告：存在 unpushed 且未显式 Drop，或策略为 ConflictBlocks。
    Conflict {
        report: MirrorDriftReport,
        reason: String,
        unpushed_op_count: usize,
        /// X-05：静默覆盖已被拦截。
        silent_overwrite_blocked: bool,
        /// 建议调用方可改选的策略。
        suggested_strategies: Vec<ThreeWayStrategy>,
        conflicted_blocks: Vec<ConflictBlockInfo>,
    },
}

impl ImportMirrorResult {
    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Conflict { .. })
    }

    pub fn silent_overwrite_blocked(&self) -> bool {
        match self {
            Self::Conflict {
                silent_overwrite_blocked,
                ..
            } => *silent_overwrite_blocked,
            _ => false,
        }
    }

    pub fn ops(&self) -> Option<&[Op]> {
        match self {
            Self::OpBatch { ops, .. } => Some(ops.as_slice()),
            _ => None,
        }
    }
}

impl WorkspaceStore {
    /// **import 提案**：产出 Op 批 **或** 冲突报告；**不**写权威、**不** apply。
    ///
    /// # X-05 / 禁静默覆盖
    /// - `unpushed_op_count > 0` 且 `strategy != DropUnacked` →
    ///   [`ImportMirrorResult::Conflict`] 且 `silent_overwrite_blocked = true`
    ///   （RetainLocal 在无 unpushed 或 unpushed=0 时才产 Op；有 unpushed 时同样走冲突，
    ///   避免「假保留」实际盖写——候选补丁须上层显式二次确认后另调 Drop/清空 unpushed）。
    /// - **禁止**默认 fullRemount：成功路径为块级 diff（`is_block_level_diff = true`）。
    ///
    /// # 工具面
    /// 本 API **不是**「读 mirror 当 get_md」；工具默认读仍须即时 S(树)。
    pub fn import_mirror_proposal(
        &self,
        doc_id: &str,
        authority_rev: u64,
        opts: &ImportMirrorOpts<'_>,
    ) -> Result<ImportMirrorResult, StoreError> {
        let report = self.detect_mirror_drift(doc_id, authority_rev)?;

        // 无需从 mirror 拉内容
        match report.class {
            MirrorDriftClass::None | MirrorDriftClass::AuthorityOnly | MirrorDriftClass::NoMeta => {
                return Ok(ImportMirrorResult::NoChange { report });
            }
            MirrorDriftClass::MissingFile => {
                return Ok(ImportMirrorResult::Conflict {
                    report,
                    reason: "mirror 文件缺失，无法 import".into(),
                    unpushed_op_count: opts.unpushed_op_count,
                    silent_overwrite_blocked: opts.unpushed_op_count > 0,
                    suggested_strategies: vec![ThreeWayStrategy::ConflictBlocks],
                    conflicted_blocks: vec![],
                });
            }
            MirrorDriftClass::MirrorOnly | MirrorDriftClass::Both => {}
        }

        // X-05：有 unpushed 时，非显式 DropUnacked → 冲突报告（禁静默盖）
        if opts.unpushed_op_count > 0 && opts.strategy != ThreeWayStrategy::DropUnacked {
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: format!(
                    "存在 {} 条 unpushed op；拒绝静默覆盖。须显式 DropUnacked，或先清空/推送本地 op 后再 RetainLocalAndReimport",
                    opts.unpushed_op_count
                ),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: true,
                suggested_strategies: vec![
                    ThreeWayStrategy::DropUnacked,
                    ThreeWayStrategy::ConflictBlocks,
                    ThreeWayStrategy::RetainLocalAndReimport,
                ],
                conflicted_blocks: vec![],
            });
        }

        // 显式 ConflictBlocks：只报告，不产 Op
        if opts.strategy == ThreeWayStrategy::ConflictBlocks {
            let blocks = self.list_text_conflicts(&report, opts.authority_tree)?;
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: "策略 ConflictBlocks：标记冲突，不自动 apply".into(),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: opts.unpushed_op_count > 0,
                suggested_strategies: vec![
                    ThreeWayStrategy::DropUnacked,
                    ThreeWayStrategy::RetainLocalAndReimport,
                ],
                conflicted_blocks: blocks,
            });
        }

        let Some(authority) = opts.authority_tree else {
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: "缺少 authority_tree，无法生成块级 Op 提案（拒绝 fullRemount 兜底）".into(),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: opts.unpushed_op_count > 0,
                suggested_strategies: vec![opts.strategy],
                conflicted_blocks: vec![],
            });
        };

        if !report.file_exists {
            return Ok(ImportMirrorResult::Conflict {
                report,
                reason: "mirror 文件不可读".into(),
                unpushed_op_count: opts.unpushed_op_count,
                silent_overwrite_blocked: false,
                suggested_strategies: vec![],
                conflicted_blocks: vec![],
            });
        }

        let md = std::fs::read_to_string(&report.path)?;
        let source_md_hash = content_hash(md.as_bytes());
        let parsed = parse_document_detailed(&md)
            .map_err(|e| StoreError::Persist(format!("import_mirror_proposal parse: {e}")))?;
        let mirror_tree = parsed.tree;

        let ops = propose_block_level_ops(authority, &mirror_tree, opts.strategy);

        let preserves_unpushed = opts.strategy == ThreeWayStrategy::RetainLocalAndReimport;
        let discards_unpushed =
            opts.strategy == ThreeWayStrategy::DropUnacked && opts.unpushed_op_count > 0;

        Ok(ImportMirrorResult::OpBatch {
            report,
            strategy: opts.strategy,
            ops,
            source_md_hash,
            preserves_unpushed,
            discards_unpushed,
            is_block_level_diff: true,
        })
    }

    /// 冲突块列表（同 ID 文本不一致）。
    fn list_text_conflicts(
        &self,
        report: &MirrorDriftReport,
        authority: Option<&BlockTree>,
    ) -> Result<Vec<ConflictBlockInfo>, StoreError> {
        let Some(authority) = authority else {
            return Ok(vec![]);
        };
        if !report.file_exists {
            return Ok(vec![]);
        }
        let md = std::fs::read_to_string(&report.path)?;
        let parsed = match parse_document_detailed(&md) {
            Ok(p) => p,
            Err(e) => {
                return Ok(vec![ConflictBlockInfo {
                    block_id: "*".into(),
                    reason: format!("parse 失败: {e}"),
                }]);
            }
        };
        let mut out = Vec::new();
        for (id, mnode) in &parsed.tree.nodes {
            if let Some(anode) = authority.get(id) {
                let at = anode.text_snapshot.as_deref().unwrap_or("");
                let mt = mnode.text_snapshot.as_deref().unwrap_or("");
                if at != mt {
                    out.push(ConflictBlockInfo {
                        block_id: id.to_string(),
                        reason: format!("文本不一致 authority={at:?} mirror={mt:?}"),
                    });
                }
            }
        }
        Ok(out)
    }
}

// ── 测试（SD-26 外置） ─────────────────────────────────────────────────────

#[cfg(test)]
#[path = "mirror_import_tests.rs"]
mod tests;
