//! Store `apply_md_fragment` 真路径（**SD-06** 纵向切开）
//!
//! 从 `store_backend` 巨石抽出 MD 片段应用：
//! - batch token / intent 幂等
//! - mode 分支（AppendToBlock / ApplyMdFragment / InsertBlocks）
//! - W4-A：`ApplyReport.lossy` → [`NoteApplyMdResult::lossy`]
//! - `commit_ops` 原子批
//!
//! # SD-06 边界
//! - **本模块职责**：apply_md 写路径 + lossy/order 辅助
//! - **不**含 plan→collab / hydrate 投影 / outline
//! - **≠ EL-05**；**≠ A-AGT 满表**；**禁止**只写 ops 丢 lossy

use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteApplyMode, NoteBackendError, NoteLossyItem,
    NoteLossyReport,
};
use conex_doc_collab::{BlockId, Op};
use conex_md_ast::{apply_md_fragment, LossyReport, MdError};
use conex_workspace_store::commit_ops;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::store_backend::{
    map_commit_err, origin_from_req, SlowPathProbe, StoreNoteBackend,
};
use crate::store_plan_ops::parse_block_id;

/// 毒丸恢复计数（B1-1 观测化：本文件 intents / per-doc 锁中毒恢复次数；
/// 对齐 registry.rs「tracing::error! 成对 + 计数」样板，零新依赖）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言用；S3 埋点消费面就绪后解除 cfg(test)）
#[cfg(test)]
pub(crate) fn poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
}

impl StoreNoteBackend {
    /// 从 ops 收集新 Insert 的 block id（字符串）。
    pub(crate) fn collect_insert_ids(ops: &[Op]) -> Vec<String> {
        ops.iter()
            .filter_map(|op| match op {
                Op::Insert { id, .. } => Some(id.to_string()),
                _ => None,
            })
            .collect()
    }

    /// W4-A：`conex_md_ast::LossyReport` → 工具契约 [`NoteLossyReport`]（叶子形状，无 md-ast 依赖）。
    pub(crate) fn map_lossy(report: &LossyReport) -> NoteLossyReport {
        NoteLossyReport {
            items: report
                .items
                .iter()
                .map(|i| NoteLossyItem {
                    code: i.code.clone(),
                    detail: i.detail.clone(),
                    line: i.line,
                })
                .collect(),
        }
    }

    /// 若指定 after_block_id：把挂到同一父下的根级 Insert 的 order 改写到 after 之后。
    pub(crate) fn rewrite_orders_after(
        ops: &mut [Op],
        after: &BlockId,
        tree: &conex_doc_collab::BlockTree,
    ) {
        let after_order = match tree.get(after) {
            Some(n) => n.order.clone(),
            None => return,
        };
        let after_parent = tree.get(after).and_then(|n| n.parent);
        let mut seq = 0u32;
        for op in ops.iter_mut() {
            if let Op::Insert {
                parent, order, ..
            } = op
            {
                if *parent == after_parent {
                    // fractional 简化：after_order + 后缀保证字典序靠后
                    *order = format!("{after_order}~{seq:04}");
                    seq += 1;
                }
            }
        }
    }

    /// 事务化 apply MD 片段（写路径入口；由 [`NoteBackend`](agent_tools::note_backend::NoteBackend) 委托）。
    pub(crate) async fn apply_md_fragment_inner(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError> {
        if req.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }

        // 1. batch token 可选校验
        self.validate_batch_token_sync(req.batch_id.as_deref())?;

        // 2. intent 幂等
        if let Some(ref intent) = req.intent_id {
            if intent.trim().is_empty() {
                return Err(NoteBackendError::Invalid(
                    "intent_id must be non-empty when provided".into(),
                ));
            }
            let intents = self.intents.lock().unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "intents 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
            if let Some(prev) = intents.get(intent) {
                let mut out = prev.clone();
                out.idempotent = true;
                out.inserted = 0;
                return Ok(out);
            }
        }

        let origin = origin_from_req(&req);
        // B3：per-doc 锁——mode 生成 ops + commit 全程持 doc 锁（原子性不变）
        let arc = self.session_handle(&req.doc_id)?;
        // S3 埋点：获取点前发起计时（锁外），acquire 返回后立即结束；告警锁外析构
        let mut probe = SlowPathProbe::start(&req.doc_id);
        let mut session = arc.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
            tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        probe.finish_lock();

        // 3. 按 mode 生成 Ops + 保留 lossy（W4-A：进 NoteApplyMdResult）
        let (ops, lossy): (Vec<Op>, NoteLossyReport) = match req.mode {
            NoteApplyMode::AppendToBlock => {
                let target_id = if let Some(ref after) = req.after_block_id {
                    parse_block_id(after, "after_block_id")?
                } else if let Some(last) = session.tree().root_children.last() {
                    *last
                } else {
                    return Err(NoteBackendError::NotFound(
                        "append_to_block: no target block".into(),
                    ));
                };
                if session.tree().get(&target_id).is_none() {
                    return Err(NoteBackendError::NotFound(format!(
                        "block not found: {target_id}"
                    )));
                }
                let current = session.read_text(&target_id);
                let start = current.chars().count() as u32;
                let mut insert = String::new();
                if !current.is_empty() && !req.markdown.is_empty() {
                    insert.push('\n');
                }
                insert.push_str(req.markdown.trim_end());
                // append 不经 MD parse，无 lossy
                (
                    vec![Op::TextEdit {
                        id: target_id,
                        start,
                        end: start,
                        insert,
                    }],
                    NoteLossyReport::default(),
                )
            }
            NoteApplyMode::ApplyMdFragment | NoteApplyMode::InsertBlocks => {
                let parent = match req.parent_id.as_deref() {
                    Some(p) if !p.trim().is_empty() => {
                        Some(parse_block_id(p, "parent_id")?)
                    }
                    _ => None,
                };
                // parent 存在性：apply_md_fragment 会 UnknownParent；after 可隐式定父
                let mut parent = parent;
                let after_id = match req.after_block_id.as_deref() {
                    Some(a) if !a.trim().is_empty() => {
                        let aid = parse_block_id(a, "after_block_id")?;
                        let node = session.tree().get(&aid).ok_or_else(|| {
                            NoteBackendError::NotFound(format!(
                                "after_block_id not found: {aid}"
                            ))
                        })?;
                        if parent.is_none() {
                            parent = node.parent;
                        }
                        Some(aid)
                    }
                    _ => None,
                };

                // W2-B + W4-A：ApplyReport 取 ops 并透出 lossy → 工具 result
                let mut report = apply_md_fragment(session.tree(), parent, &req.markdown)
                    .map_err(map_md_err)?;
                if let Some(aid) = after_id {
                    Self::rewrite_orders_after(&mut report.ops, &aid, session.tree());
                }
                let lossy = Self::map_lossy(&report.lossy);
                (report.ops, lossy)
            }
        };

        // 空 ops（空 markdown）合法；仍返回 lossy（通常为空）
        if ops.is_empty() {
            let result = NoteApplyMdResult {
                block_ids: vec![],
                inserted: 0,
                idempotent: false,
                lossy,
            };
            if let Some(ref intent) = req.intent_id {
                let mut intents = self.intents.lock().unwrap_or_else(|e| {
                    // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                    tracing::error!(target: "conex_note_runtime", "intents 锁中毒，按恢复模式继续：{e}");
                    POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                    e.into_inner()
                });
                intents.insert(intent.clone(), result.clone());
            }
            return Ok(result);
        }

        let block_ids = match req.mode {
            NoteApplyMode::AppendToBlock => {
                // 追加模式返回目标 id
                ops.iter()
                    .filter_map(|op| match op {
                        Op::TextEdit { id, .. } => Some(id.to_string()),
                        _ => None,
                    })
                    .collect()
            }
            _ => Self::collect_insert_ids(&ops),
        };
        let inserted = match req.mode {
            NoteApplyMode::AppendToBlock => 0,
            _ => block_ids.len() as u32,
        };

        // 4. commit_ops：session.apply + apply_projection_diff（原子；失败零半树）
        commit_ops(&mut session, &self.store, origin, &ops).map_err(map_commit_err)?;

        let result = NoteApplyMdResult {
            block_ids,
            inserted,
            idempotent: false,
            lossy,
        };

        if let Some(ref intent) = req.intent_id {
            let mut intents = self.intents.lock().unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "intents 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
            intents.insert(intent.clone(), result.clone());
        }
        Ok(result)
    }
}

/// MdError → NoteBackendError。
pub(crate) fn map_md_err(e: MdError) -> NoteBackendError {
    match e {
        MdError::IdConflict(id) => NoteBackendError::IdConflict(id),
        MdError::UnknownParent(p) => {
            NoteBackendError::NotFound(format!("parent_id not found: {p}"))
        }
        MdError::Parse(m) | MdError::Lossy(m) => NoteBackendError::ApplyFailed(m),
    }
}
