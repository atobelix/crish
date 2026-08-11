use crate::block_id::BlockId;
use crate::ir::{BlockKind, BlockProps};
use serde::{Deserialize, Serialize};

/// 变更来源标签（写入 `CommitBatch`）。
///
/// **≠ A-COL-04**：枚举存在 ≠ undo 可按 origin 过滤已交付；过滤语义待 W1-U。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    User,
    Agent,
    Remote,
    System,
}

/// 结构化 Op（树）；文本细粒度另走 text_edit。
///
/// # Wire（JSON）
/// `#[serde(tag = "op", rename_all = "snake_case")]`：
/// `{ "op": "insert" | "update_props" | "move" | "delete" | "text_edit", ... }`。
/// 与 TS `@crish/block-paper-contract` `CollabOpWire` / `structureIntentToOps` 对齐。
///
/// # 写路径纪律
/// UI StructureIntent **不得**直接写盘；须 Intent → wire JSON → [`ops_from_json`] →
/// [`crate::DocSession::apply`]。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Insert {
        id: BlockId,
        parent: Option<BlockId>,
        /// fractional index 字符串，排序键
        order: String,
        kind: BlockKind,
        props: BlockProps,
    },
    UpdateProps {
        id: BlockId,
        props: BlockProps,
    },
    Move {
        id: BlockId,
        new_parent: Option<BlockId>,
        order: String,
    },
    Delete {
        id: BlockId,
    },
    /// 叶子文本编辑：经 `TextEngine`（yrs YText，crate 私有）应用。
    TextEdit {
        id: BlockId,
        /// **Unicode 标量（char）偏移**（与 W0 骨架一致）；引擎内换算为 UTF-8 字节再写 yrs。
        start: u32,
        end: u32,
        insert: String,
    },
}

/// 从 JSON 字节解析 `Vec<Op>`（wire：tag=`op`、snake_case）。
///
/// 供 TS bridge（`submitStructureToCollabWire`）/ 测试 / IPC 入口；
/// 权威变更仍须 [`crate::DocSession::apply`]。
///
/// W3-D 子集可测路径（真 apply，非 mock）：
/// `tests/w3_d_structure_intent_or_wire_apply.rs` · `w3_d_structure_intent_or_wire_applys_to_session`。
pub fn ops_from_json(bytes: &[u8]) -> Result<Vec<Op>, serde_json::Error> {
    serde_json::from_slice(bytes)
}

/// 从 JSON 字符串解析 `Vec<Op>`。
pub fn ops_from_json_str(s: &str) -> Result<Vec<Op>, serde_json::Error> {
    serde_json::from_str(s)
}

/// 将 ops 编码为 JSON 字节（与 [`ops_from_json`] 对称）。
pub fn ops_to_json(ops: &[Op]) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(ops)
}

/// 将 ops 编码为 JSON 字符串。
pub fn ops_to_json_string(ops: &[Op]) -> Result<String, serde_json::Error> {
    serde_json::to_string(ops)
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::block_id::BlockId;
    use crate::ir::{BlockKind, BlockProps};
    use crate::session::DocSession;
    use std::str::FromStr;

    fn sample_id() -> BlockId {
        BlockId::from_str("11111111-1111-1111-1111-111111111111").unwrap()
    }

    #[test]
    fn ops_from_json_insert_roundtrip_and_apply() {
        // 与 TS collabOpsToJson / structureIntentToOps insert 形状一致
        let json = r#"[
          {
            "op": "insert",
            "id": "11111111-1111-1111-1111-111111111111",
            "parent": null,
            "order": "a0",
            "kind": "paragraph",
            "props": { "attrs": {} }
          }
        ]"#;

        let ops = ops_from_json_str(json).expect("parse wire insert");
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::Insert {
                id,
                parent,
                order,
                kind,
                ..
            } => {
                assert_eq!(*id, sample_id());
                assert_eq!(*parent, None);
                assert_eq!(order, "a0");
                assert_eq!(*kind, BlockKind::Paragraph);
            }
            other => panic!("expected insert, got {other:?}"),
        }

        // 可测桥：wire → apply 一条 insert
        let mut s = DocSession::new("wire-insert");
        s.apply(Origin::User, &ops).expect("apply wire insert");
        let node = s.tree().get(&sample_id()).expect("node after apply");
        assert_eq!(node.kind, BlockKind::Paragraph);
        assert_eq!(node.order, "a0");
        assert_eq!(s.tree().root_children, vec![sample_id()]);
    }

    #[test]
    fn ops_to_json_and_from_json_roundtrip_all_variants() {
        let id = sample_id();
        let mut props = BlockProps::default();
        props
            .attrs
            .insert("collapsed".into(), serde_json::json!(true));
        let ops = vec![
            Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Delete { id },
            Op::Move {
                id,
                new_parent: Some(id),
                order: "b0".into(),
            },
            Op::UpdateProps {
                id,
                props: props.clone(),
            },
            Op::TextEdit {
                id,
                start: 0,
                end: 1,
                insert: "x".into(),
            },
            Op::Insert {
                id,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Heading { level: 1 },
                props: BlockProps::default(),
            },
        ];
        let bytes = ops_to_json(&ops).unwrap();
        let back = ops_from_json(&bytes).unwrap();
        assert_eq!(back.len(), ops.len());
        // tag 名
        let s = ops_to_json_string(&ops).unwrap();
        assert!(s.contains(r#""op":"insert""#));
        assert!(s.contains(r#""op":"delete""#));
        assert!(s.contains(r#""op":"move""#));
        assert!(s.contains(r#""new_parent""#));
        assert!(s.contains(r#""op":"update_props""#));
        assert!(s.contains(r#""op":"text_edit""#));
    }

    #[test]
    fn ops_from_json_rejects_ui_delete_blocks_shape() {
        // TS 旧镜像形状不得被当成 collab Op
        let bad = r#"[{"type":"delete_blocks","blockIds":["a"]}]"#;
        assert!(ops_from_json_str(bad).is_err());
    }
}
