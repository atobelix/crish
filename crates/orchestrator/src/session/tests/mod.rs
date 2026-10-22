use serde_json::json;

use super::*;

mod leaf_checkpoint;
mod record_time;
mod rewind;
mod tree_ops;

fn tree() -> SessionTree {
    SessionTree::new("session_a")
}

/// 追加根 → 子 → 孙 的链，返回三个节点
fn chain(tree: &mut SessionTree) -> (SessionTreeEntry, SessionTreeEntry, SessionTreeEntry) {
    let root = tree.append("root", json!({ "text": "root" })).unwrap();
    let mid = tree.append("mid", json!({ "text": "mid" })).unwrap();
    let leaf = tree.append("leaf", json!({ "text": "leaf" })).unwrap();
    (root, mid, leaf)
}
