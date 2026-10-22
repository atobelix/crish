//! `session` 测试旁挂入口（SR-06g · 拆分 · 测外置 · ≠ EL）。
//!
//! 由父模 [`crate::session`] 经 `#[path]` 接入（无孤儿）。子域：
//! - [`apply`]：apply 主路径 / MV-01…04 / 原子性
//! - [`atomic`]：A-INV-09a/c + A-MEM-01/02 + CommitBatch 同源 tx
//! - [`huge`]：A-HUGE / M2 分段
//! - [`hydrate`]：G-HYD + 远端文本合入
//! - [`hydrate_incremental`]：P-H2 回滚与增量 checkpoint
//! - [`undo`]：W1-U undo 域（A-COL-04 / A-MEM-04 / A-INV-09c 后半）
//!
//! 既有测试**零删除零改写**：逐块随行搬入（形状不变，测名不变）。
use super::*;
use crate::ir::{BlockKind, BlockProps};
use crate::op::Op;

#[path = "session_tests_apply.rs"]
mod apply;

#[path = "session_tests_atomic.rs"]
mod atomic;

#[path = "session_tests_huge.rs"]
mod huge;

#[path = "session_tests_hydrate.rs"]
mod hydrate;

#[path = "session_tests_hydrate_incremental.rs"]
mod hydrate_incremental;

#[path = "session_tests_undo.rs"]
mod undo;

fn insert_root(s: &mut DocSession, id: BlockId, order: &str) {
    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: order.into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
}
fn insert_child(s: &mut DocSession, id: BlockId, parent: BlockId, order: &str) {
    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: Some(parent),
            order: order.into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
}
/// 拼接 anchor 及其 `split_of` 兄弟正文（按 order）。
fn join_split_chain(s: &DocSession, anchor: BlockId) -> String {
    let parent = s.tree.get(&anchor).and_then(|n| n.parent);
    let siblings: Vec<BlockId> = match parent {
        Some(pid) => s
            .tree
            .get(&pid)
            .map(|n| n.children.clone())
            .unwrap_or_default(),
        None => s.tree.root_children.clone(),
    };
    let mut parts = Vec::new();
    for sid in siblings {
        if sid == anchor {
            parts.push(s.read_text(&sid));
            continue;
        }
        let is_seg = s
            .tree
            .get(&sid)
            .and_then(|n| n.props.attrs.get(ATTR_SPLIT_OF))
            .and_then(|v| v.as_str())
            .map(|x| x == anchor.to_string())
            .unwrap_or(false);
        if is_seg {
            parts.push(s.read_text(&sid));
        }
    }
    parts.concat()
}

/// B4：DocSession 为 Send（经 Mutex 跨线程）；!Sync 由 TextHost 收窄保证。
#[test]
fn doc_session_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<DocSession>();
}

fn count_split_segments(s: &DocSession, anchor: BlockId) -> usize {
    let parent = s.tree.get(&anchor).and_then(|n| n.parent);
    let siblings: Vec<BlockId> = match parent {
        Some(pid) => s
            .tree
            .get(&pid)
            .map(|n| n.children.clone())
            .unwrap_or_default(),
        None => s.tree.root_children.clone(),
    };
    let mut n = 0;
    for sid in siblings {
        if sid == anchor {
            n += 1;
            continue;
        }
        let is_seg = s
            .tree
            .get(&sid)
            .and_then(|node| node.props.attrs.get(ATTR_SPLIT_OF))
            .and_then(|v| v.as_str())
            .map(|x| x == anchor.to_string())
            .unwrap_or(false);
        if is_seg {
            n += 1;
        }
    }
    n
}
