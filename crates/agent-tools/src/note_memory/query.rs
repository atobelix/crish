//! Memory 只读路径（**SD-28** · query / outline / get_md）
//!
//! **≠ EL-05**；**≠ W6-E**；即时 S(树)；**禁止** disk mirror。
//! Memory 测绿 **禁关**生产。

use super::MemoryNoteBackend;
use crate::note_plan_ops::MemDoc;
use crate::note_types::{
    NoteBackendError, NoteOutline, NoteOutlineNode, NoteQueryBlockHit, NoteQueryBlocksParams,
    NoteQueryBlocksResult,
};
use crate::poison::POISON_RECOVERIES;
use std::sync::atomic::Ordering;

impl MemoryNoteBackend {
    /// 组合查询块摘要（内存过滤）
    pub(super) fn run_query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        if params.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let limit = params.limit.unwrap_or(50).clamp(1, 200) as usize;

        let docs = self.docs.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
            tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let doc = match docs.get(&params.doc_id) {
            Some(d) => d,
            None => {
                return Ok(NoteQueryBlocksResult {
                    blocks: vec![],
                    truncated: false,
                });
            }
        };

        let kind_filter: Option<std::collections::HashSet<&str>> = params
            .kind_in
            .as_ref()
            .map(|v| v.iter().map(|s| s.as_str()).collect());

        let mut hits: Vec<NoteQueryBlockHit> = Vec::new();
        for b in &doc.blocks {
            if let Some(ref kinds) = kind_filter {
                if !kinds.is_empty() && !kinds.contains(b.kind.as_str()) {
                    continue;
                }
            }
            if let Some(ref text) = params.text_match {
                if !text.is_empty() && !b.text.contains(text.as_str()) {
                    continue;
                }
            }
            if let Some(ref attrs_eq) = params.attrs_eq {
                let mut ok = true;
                for (k, v) in attrs_eq {
                    match b.attrs.get(k) {
                        Some(bv) if bv == v => {}
                        _ => {
                            ok = false;
                            break;
                        }
                    }
                }
                if !ok {
                    continue;
                }
            }
            // ref_to：谁引用了该块 → 块的 refs_to 含目标
            if let Some(ref target) = params.ref_to {
                if !target.is_empty() && !b.refs_to.iter().any(|r| r == target) {
                    continue;
                }
            }
            // ref_from：该块引用了谁 → 源块 id 匹配且有出边（返回被引用目标）
            // 简化：ref_from=X 时返回 X 的 refs_to 指向的块
            if let Some(ref source) = params.ref_from {
                if !source.is_empty() {
                    // 当前块必须是 source 引用的目标之一
                    let source_block = doc.blocks.iter().find(|x| x.id == *source);
                    match source_block {
                        Some(src) if src.refs_to.iter().any(|r| r == &b.id) => {}
                        _ => continue,
                    }
                }
            }

            hits.push(NoteQueryBlockHit {
                id: b.id.clone(),
                kind: b.kind.clone(),
                snippet: b.text.chars().take(200).collect(),
                attrs: b.attrs.clone(),
            });
        }

        let truncated = hits.len() > limit;
        if truncated {
            hits.truncate(limit);
        }
        Ok(NoteQueryBlocksResult {
            blocks: hits,
            truncated,
        })
    }

    /// 文档标题大纲（heading 栈式建树）
    pub(super) fn run_document_outline(
        &self,
        doc_id: &str,
        max_depth: Option<u32>,
    ) -> Result<NoteOutline, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let max_depth = max_depth.unwrap_or(6).clamp(1, 16);

        let docs = self.docs.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
            tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let doc = match docs.get(doc_id) {
            Some(d) => d,
            None => {
                return Ok(NoteOutline {
                    outline: vec![],
                    truncated: false,
                });
            }
        };

        // 收集 heading 扁平列表
        let mut flat: Vec<(String, u32, String)> = Vec::new();
        let mut saw_deeper = false;
        for b in &doc.blocks {
            if b.kind != "heading" || b.level == 0 {
                continue;
            }
            if b.level > max_depth {
                saw_deeper = true;
                continue;
            }
            flat.push((b.id.clone(), b.level, b.text.clone()));
        }

        // 栈式建树
        let mut roots: Vec<NoteOutlineNode> = Vec::new();
        for (id, level, title) in flat {
            let node = NoteOutlineNode {
                id,
                level,
                title,
                children: vec![],
            };
            insert_outline_node(&mut roots, node);
        }

        Ok(NoteOutline {
            outline: roots,
            truncated: saw_deeper,
        })
    }

    /// 即时 S(树) → Conex-MD；无文档 = 空串（禁止 mirror 回退）
    pub(super) fn run_get_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let docs = self.docs.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-3 观测化）
            tracing::error!("MemoryNoteBackend docs 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let Some(doc) = docs.get(doc_id) else {
            // 无文档 = 空树即时 S；禁止 mirror 回退
            return Ok(String::new());
        };
        Ok(serialize_mem_doc_to_md(doc))
    }
}

/// Memory 文档 → 即时 Conex-MD 风格串（含 `<!--c:id-->`；id 可为非 UUID）
fn serialize_mem_doc_to_md(doc: &MemDoc) -> String {
    let mut out = String::new();
    for (i, b) in doc.blocks.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        // 与生产 `<!--c:UUID-->` 同形；Memory 伪 id 仍写出，便于 Agent 定位块
        out.push_str(&format!("<!--c:{}-->\n", b.id));
        match b.kind.as_str() {
            "heading" => {
                let level = b.level.clamp(1, 6) as usize;
                let hashes: String = std::iter::repeat_n('#', level.max(1)).collect();
                if b.text.is_empty() {
                    out.push_str(&hashes);
                } else {
                    out.push_str(&format!("{hashes} {}", b.text));
                }
            }
            _ => out.push_str(&b.text),
        }
        out.push('\n');
    }
    out
}

/// 将节点插入大纲树（按 level 嵌套）
fn insert_outline_node(roots: &mut Vec<NoteOutlineNode>, node: NoteOutlineNode) {
    if roots.is_empty() || node.level <= roots.last().map(|r| r.level).unwrap_or(1) {
        // 与根同级或更浅 → 作为新根（简化：始终尝试挂到最深可挂父）
        // 更精确：找最后一个 level < node.level 的路径
    }
    // 递归：从 roots 找最深的 level < node.level 的节点挂 children
    if !try_insert_child(roots, &node) {
        roots.push(node);
    }
}

fn try_insert_child(nodes: &mut [NoteOutlineNode], node: &NoteOutlineNode) -> bool {
    // 从后往前找可挂父
    for i in (0..nodes.len()).rev() {
        if nodes[i].level < node.level {
            // 先尝试挂到该节点的子树
            if try_insert_child(&mut nodes[i].children, node) {
                return true;
            }
            nodes[i].children.push(node.clone());
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::super::capture::with_capture;
    use super::*;
    use crate::poison::{poison_recovery_count, poison_test_guard};

    /// B1-3 毒化测：docs 锁中毒后 query_blocks 正常返回 + error 日志出现 +
    /// 毒丸恢复计数 +1（三要素）
    #[test]
    fn poisoned_docs_lock_query_recovers_with_log_and_count() {
        let _serial = poison_test_guard();
        let backend = MemoryNoteBackend::new();
        let before = poison_recovery_count();
        crate::test_support::poison_std_lock(&backend.docs);
        let (result, lines) = with_capture(|| {
            backend.run_query_blocks(NoteQueryBlocksParams {
                doc_id: "d".into(),
                ..Default::default()
            })
        });
        let result = result.unwrap();
        assert!(result.blocks.is_empty(), "毒化后查询语义不变（恢复模式）");
        assert!(
            lines.iter().any(|l| l.contains("锁中毒")),
            "缺少锁中毒 error 日志，捕获：\n{}",
            lines.join("\n")
        );
        assert_eq!(
            poison_recovery_count(),
            before + 1,
            "docs 锁中毒恢复必须计数 +1"
        );
    }
}
