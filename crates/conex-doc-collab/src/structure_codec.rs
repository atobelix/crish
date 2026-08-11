//! 结构可逆 encode / decode（G-HYD-1 / P-ENC 形态 A：整树 snapshot）。
//!
//! # 字节格式（可文档化）
//!
//! ```text
//! [magic 4B = b"CDCS"] [version u8 = 1] [serde_json body]
//! body = StructureSnapshotV1 { rev: u64, tree: BlockTree }
//! ```
//!
//! - **禁止** 生产路径以 `rev.to_le_bytes()` 作为唯一结构载荷。
//! - 每次 `on_committed` 写入**完整树 snapshot**（含各节点 `text_snapshot`），便于 hydrate。
//! - `conex-workspace-store` compact 后 snapshot 为 length-prefix framing：
//!   `[u32_le len][chunk]...`；hydrate 时遍历帧，**最后一帧**成功解码的结构胜出；
//!   非结构 chunk（如 yrs 文本）跳过（文本权威以树内 `text_snapshot` 为准）。

use crate::ir::BlockTree;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 结构载荷 magic：Conex Doc Collab Structure。
pub const STRUCTURE_MAGIC: &[u8; 4] = b"CDCS";
/// 当前结构 snapshot 版本。
pub const STRUCTURE_VERSION: u8 = 1;

/// 结构 snapshot 正文（version 1）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructureSnapshotV1 {
    pub rev: u64,
    pub tree: BlockTree,
}

/// 结构编解码错误（hydrate 侧映射为 [`crate::session::HydrateError`]）。
#[derive(Debug, Error, PartialEq, Eq)]
pub enum StructureCodecError {
    #[error("bad structure magic")]
    BadMagic,
    #[error("unknown structure version: {0}")]
    UnknownVersion(u8),
    #[error("structure json: {0}")]
    Json(String),
    #[error("framed snapshot corrupt: {0}")]
    Framed(String),
    #[error("no structure payload in blob")]
    Empty,
}

/// 字节是否以 CDCS 结构 magic 开头。
#[inline]
pub fn is_structure_payload(bytes: &[u8]) -> bool {
    bytes.len() >= 5 && &bytes[0..4] == STRUCTURE_MAGIC
}

/// 编码整树结构 snapshot（G-HYD-1）。
pub fn encode_structure_payload(rev: u64, tree: &BlockTree) -> Vec<u8> {
    let body = StructureSnapshotV1 {
        rev,
        tree: tree.clone(),
    };
    let json = serde_json::to_vec(&body).expect("StructureSnapshotV1 serialize");
    let mut out = Vec::with_capacity(5 + json.len());
    out.extend_from_slice(STRUCTURE_MAGIC);
    out.push(STRUCTURE_VERSION);
    out.extend_from_slice(&json);
    out
}

/// 解码单帧 CDCS 结构载荷。
pub fn decode_structure_payload(bytes: &[u8]) -> Result<StructureSnapshotV1, StructureCodecError> {
    if bytes.len() < 5 || &bytes[0..4] != STRUCTURE_MAGIC {
        return Err(StructureCodecError::BadMagic);
    }
    let ver = bytes[4];
    if ver != STRUCTURE_VERSION {
        return Err(StructureCodecError::UnknownVersion(ver));
    }
    serde_json::from_slice(&bytes[5..]).map_err(|e| StructureCodecError::Json(e.to_string()))
}

/// 从 snapshot blob 恢复结构：支持单帧 CDCS，或 store compact 的 length-prefix 多帧。
///
/// - 空字节 → [`StructureCodecError::Empty`]
/// - 有内容但无任何可解码结构 → 对应错误
/// - 多帧时取**最后**成功的结构帧
pub fn decode_structure_from_snapshot(
    bytes: &[u8],
) -> Result<StructureSnapshotV1, StructureCodecError> {
    if bytes.is_empty() {
        return Err(StructureCodecError::Empty);
    }
    // 路径 1：整段即 CDCS
    if is_structure_payload(bytes) {
        return decode_structure_payload(bytes);
    }
    // 路径 2：length-prefix framing（与 workspace-store compact 对齐）
    let mut offset = 0usize;
    let mut last: Option<StructureSnapshotV1> = None;
    let mut saw_frame = false;
    while offset + 4 <= bytes.len() {
        let len = u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("4 bytes"),
        ) as usize;
        offset += 4;
        if offset + len > bytes.len() {
            return Err(StructureCodecError::Framed(format!(
                "chunk len {len} exceeds remaining {}",
                bytes.len() - offset
            )));
        }
        let chunk = &bytes[offset..offset + len];
        offset += len;
        saw_frame = true;
        if is_structure_payload(chunk) {
            last = Some(decode_structure_payload(chunk)?);
        }
        // 非结构帧（yrs 文本等）跳过
    }
    if !saw_frame {
        return Err(StructureCodecError::Framed(
            "not CDCS and not length-prefix framed".into(),
        ));
    }
    last.ok_or(StructureCodecError::Empty)
}

/// 结构同构比较（id / parent / order / kind / props / children / text_snapshot）。
pub fn structure_eq(a: &BlockTree, b: &BlockTree) -> bool {
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_id::BlockId;
    use crate::ir::{BlockKind, BlockNode, BlockProps, BlockTree};

    fn sample_tree() -> (BlockId, BlockTree) {
        let id = BlockId::new();
        let mut tree = BlockTree::default();
        tree.root_children.push(id);
        tree.nodes.insert(
            id,
            BlockNode {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some("hello".into()),
                children: vec![],
            },
        );
        (id, tree)
    }

    #[test]
    fn encode_decode_roundtrip() {
        let (_id, tree) = sample_tree();
        let bytes = encode_structure_payload(7, &tree);
        assert!(is_structure_payload(&bytes));
        assert_ne!(bytes, 7u64.to_le_bytes().to_vec());
        assert!(bytes.len() > 8, "不得退化为 rev LE 占位");
        let snap = decode_structure_payload(&bytes).unwrap();
        assert_eq!(snap.rev, 7);
        assert!(structure_eq(&snap.tree, &tree));
    }

    #[test]
    fn framed_snapshot_last_structure_wins() {
        let (_id, tree1) = sample_tree();
        let (_id2, mut tree2) = sample_tree();
        // 改 tree2 文本以区分
        if let Some(n) = tree2.nodes.values_mut().next() {
            n.text_snapshot = Some("second".into());
        }
        let s1 = encode_structure_payload(1, &tree1);
        let s2 = encode_structure_payload(2, &tree2);
        let text_chunk = b"yrs-opaque-not-structure";
        let mut framed = Vec::new();
        for c in [&s1[..], &text_chunk[..], &s2[..]] {
            let len = c.len() as u32;
            framed.extend_from_slice(&len.to_le_bytes());
            framed.extend_from_slice(c);
        }
        let snap = decode_structure_from_snapshot(&framed).unwrap();
        assert_eq!(snap.rev, 2);
        assert!(structure_eq(&snap.tree, &tree2));
    }

    #[test]
    fn rev_le_bytes_is_not_structure() {
        let bad = 42u64.to_le_bytes().to_vec();
        assert!(!is_structure_payload(&bad));
        assert!(decode_structure_payload(&bad).is_err());
        assert!(decode_structure_from_snapshot(&bad).is_err());
    }
}
