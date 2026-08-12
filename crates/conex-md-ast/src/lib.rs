//! Conex-MD 契约层：parse / serialize / apply 片段（W2-A / **W2-B** / **W2-A 扩表**）。
//!
//! - 类型 **re-export** 自 `conex-doc-collab`（T3 单归属，不平行定义 BlockId）
//! - 机器主编码：`<!--c:UUID-->` 独占行（W0-B / 15）
//! - **P 主路径**：`markdown`（markdown-rs）GFM mdast → lowering → BlockIR（见 [`PARSE_BACKEND`]）
//! - **S**：自研即时序列化（不信任库 to_md）；Agent `get_md` = [`document_to_md`]
//! - **mode / N**：[`parse_md`] / [`serialize_md`] / [`normalize_md`]（W2-A 扩表；一等面）
//! - **不含** inline 富文本 yrs 往返；文本走 `text_snapshot` plain
//!
//! # 公共 API
//! - [`document_to_md`] / [`serialize_tree`]：Agent **`get_md` 读路径 = 即时 S(树)**（禁止陈旧 mirror）
//! - [`parse_document`] / [`parse_document_detailed`]（含 [`LossyReport`]）
//! - [`parse_md`] / [`serialize_md`] / [`normalize_md`] + [`MdMode`]（pure-gfm / conex）
//! - [`apply_md_fragment`] → [`ApplyReport`]（ops + lossy + new_ids；W2-B：lossy 可观测；失败零半树）
//! - [`strip_conex_id_comments`]（pure-gfm 辅助；mode 面优先用 [`serialize_md`]）
//! - [`encode_block_id_line`] / [`decode_block_id_line`]
//! - 退役：[`parse_document_handwritten`]（非默认）
//!
//! # 诚实边界（W2-A / W2-B / W2-A 扩表 / gfm-core 加深 / W2-A 续加深）
//! - **已接线** markdown-rs 为 GFM P 主路径（W2-A）
//! - **已交付** ApplyReport 透出 lossy（W2-B）；失败整批 Err、不 mutate target
//! - **已交付** mode 一等 + normalize 最低集 + 码/列表 golden 加深（W2-A 扩表）
//! - **已加深** gfm-core Table/TaskItem **kind 方向**：collab IR **无** `Table`/`TaskItem` 变体 →
//!   表=Paragraph+`structure_note`（行列/对齐 plain）；任务=Bullet/Ordered+勾选 plain+列表级 note
//! - **已续加深**（W2-A 本包）：任务项嵌套段落；围栏 lang/meta → `structure_note`（不进 Code 载荷）；
//!   嵌套 blockquote 扁平 plain；同秩嵌套列表扁平为兄弟（真嵌套列表语义未关）
//! - **未关闭**：**≠ A-MD 全表** / **≠ A-MD-01 全集** / **≠ EL-06**；Table/TaskItem kind **未入 collab**；
//!   围栏 info **未** 进 kind；**禁止** 本批 golden 关 EL-06
//! - **≠ A-MD-04**：零半树 ≠ merge 后 P∘S≡ 联测全集
//!
//! # 权威
//! `docs/block-workspace-architecture/plans/03-MD契约.md`；A-MD / RT-1…；禁止 HTML 反推块树。

#![allow(missing_docs)]

pub use conex_doc_collab::{
    BlockId, BlockKind, BlockNode, BlockProps, BlockTree, Op, Origin, block_id_from_comment,
    block_id_to_comment,
};

mod apply;
mod assemble;
mod mode;
mod parse;
mod parse_handwritten;
mod parse_mdast;
mod serialize;

pub use apply::{ApplyReport, apply_md_fragment};
pub use mode::{
    MdMode, ParseOpts, SerializeOpts, normalize_md, parse_md, serialize_md,
};
pub use parse::{PARSE_BACKEND, ParseOutput, parse_document, parse_document_detailed};
#[allow(deprecated)]
pub use parse_handwritten::{parse_document_detailed_handwritten, parse_document_handwritten};
pub use serialize::{document_to_md, serialize_tree};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MdError {
    #[error("lossy: {0}")]
    Lossy(String),
    #[error("parse: {0}")]
    Parse(String),
    /// 片段中的块 ID 已存在于目标文档 → 整批失败（W2-B 钉死策略）。
    #[error("id conflict: {0} already exists in document")]
    IdConflict(String),
    /// `parent` 不在目标树中。
    #[error("unknown parent: {0}")]
    UnknownParent(String),
}

/// 单条有损/诊断项（pure-gfm 剥离、缺 ID、未知结构等）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LossyItem {
    /// 机器可读码，如 `stripped_block_ids` / `missing_block_id` / `duplicate_block_id`
    pub code: String,
    pub detail: String,
    pub line: Option<usize>,
}

/// 有损点汇总。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LossyReport {
    pub items: Vec<LossyItem>,
}

impl LossyReport {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn push(&mut self, code: impl Into<String>, detail: impl Into<String>, line: Option<usize>) {
        self.items.push(LossyItem {
            code: code.into(),
            detail: detail.into(),
            line,
        });
    }
}

/// 规格：机器主编码独占行 `<!--c:UUID-->`（W0-B / 15）。
pub const BLOCK_ID_COMMENT_PREFIX: &str = "<!--c:";

/// 将块 ID 编码为 MD 起始注释行。
pub fn encode_block_id_line(id: &BlockId) -> String {
    id.to_html_comment()
}

/// 解析块起始行上的 ID。
pub fn decode_block_id_line(line: &str) -> Option<BlockId> {
    block_id_from_comment(line)
}

/// pure-gfm：剥离 conex 块 ID 注释行（普通 HTML 注释保留）。
pub fn strip_conex_id_comments(md: &str) -> String {
    strip_conex_id_comments_detailed(md).0
}

/// pure-gfm 剥离 + 计数（调用方写入 `lossy: stripped_block_ids`）。
pub fn strip_conex_id_comments_detailed(md: &str) -> (String, LossyReport) {
    let mut report = LossyReport::default();
    let mut kept: Vec<&str> = Vec::new();
    let mut stripped = 0usize;
    for (idx, line) in md.lines().enumerate() {
        if block_id_from_comment(line.trim()).is_some() {
            stripped += 1;
            report.push(
                "stripped_block_ids",
                format!("line {}: 剥离块 ID 注释", idx + 1),
                Some(idx + 1),
            );
        } else {
            kept.push(line);
        }
    }
    if stripped > 0 {
        report.push(
            "stripped_block_ids_count",
            format!("共剥离 {stripped} 条 <!--c:…--> 行"),
            None,
        );
    }
    let body = kept.join("\n");
    (body, report)
}

/// 结构等价比较（ID / kind / 父子 / plain 文本；**忽略** order 字符串）。
/// 用于往返与 golden 断言。
pub fn structure_eq(a: &BlockTree, b: &BlockTree) -> bool {
    if a.root_children != b.root_children {
        return false;
    }
    if a.nodes.len() != b.nodes.len() {
        return false;
    }
    for (id, na) in &a.nodes {
        let Some(nb) = b.get(id) else {
            return false;
        };
        if na.parent != nb.parent || na.kind != nb.kind || na.children != nb.children {
            return false;
        }
        if na.text_snapshot != nb.text_snapshot {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::str::FromStr;

    #[test]
    fn id_line_roundtrip() {
        let id = BlockId::new();
        let line = encode_block_id_line(&id);
        assert_eq!(decode_block_id_line(&line), Some(id));
    }

    #[test]
    fn strip_comments() {
        let id = BlockId::new();
        let md = format!("{}\nhello\n", encode_block_id_line(&id));
        let s = strip_conex_id_comments(&md);
        assert!(s.contains("hello"));
        assert!(!s.contains("<!--c:"));
    }

    #[test]
    fn strip_preserves_normal_html_comments() {
        let md = "<!-- ordinary comment -->\npara\n<!--c:11111111-1111-4111-a111-111111111111-->\n";
        let (out, report) = strip_conex_id_comments_detailed(md);
        assert!(out.contains("<!-- ordinary comment -->"));
        assert!(out.contains("para"));
        assert!(!out.contains("<!--c:"));
        assert!(!report.is_empty());
    }

    #[test]
    fn serialize_parse_roundtrip_ids_and_kind() {
        let h = BlockId::from_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let p = BlockId::from_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let mut nodes = HashMap::new();
        nodes.insert(
            h,
            BlockNode {
                id: h,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::Heading { level: 2 },
                props: BlockProps::default(),
                text_snapshot: Some("章节".into()),
                children: vec![p],
            },
        );
        nodes.insert(
            p,
            BlockNode {
                id: p,
                parent: Some(h),
                order: "a0000".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some("正文".into()),
                children: vec![],
            },
        );
        let tree = BlockTree {
            root_children: vec![h],
            nodes,
        };
        let md = serialize_tree(&tree);
        let tree2 = parse_document(&md).unwrap();
        assert!(structure_eq(&tree, &tree2), "md=\n{md}");
    }

    #[test]
    fn bullet_items_flat() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
- 甲

<!--c:22222222-2222-4222-a222-222222222222-->
- 乙
";
        let tree = parse_document(md).unwrap();
        assert_eq!(tree.root_children.len(), 2);
        for id in &tree.root_children {
            assert_eq!(tree.get(id).unwrap().kind, BlockKind::BulletItem);
        }
        let again = parse_document(&serialize_tree(&tree)).unwrap();
        assert!(structure_eq(&tree, &again));
    }

    #[test]
    fn document_to_md_is_agent_read_path_s() {
        let p = BlockId::from_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let mut nodes = HashMap::new();
        nodes.insert(
            p,
            BlockNode {
                id: p,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some("Agent读路径".into()),
                children: vec![],
            },
        );
        let tree = BlockTree {
            root_children: vec![p],
            nodes,
        };
        let via_get = document_to_md(&tree);
        let via_s = serialize_tree(&tree);
        assert_eq!(via_get, via_s);
        let tree2 = parse_document(&via_get).unwrap();
        assert!(structure_eq(&tree, &tree2));
        assert_eq!(
            tree2.get(&p).unwrap().text_snapshot.as_deref(),
            Some("Agent读路径")
        );
    }

    #[test]
    fn strip_detailed_reports_count_and_per_line() {
        let id1 = BlockId::from_str("11111111-1111-4111-a111-111111111111").unwrap();
        let id2 = BlockId::from_str("22222222-2222-4222-a222-222222222222").unwrap();
        let md = format!(
            "{}\n第一段\n\n{}\n第二段\n",
            encode_block_id_line(&id1),
            encode_block_id_line(&id2)
        );
        let (out, report) = strip_conex_id_comments_detailed(&md);
        assert!(!out.contains("<!--c:"));
        assert!(out.contains("第一段"));
        assert!(out.contains("第二段"));
        let codes: Vec<_> = report.items.iter().map(|i| i.code.as_str()).collect();
        assert!(codes.contains(&"stripped_block_ids"));
        assert!(codes.contains(&"stripped_block_ids_count"));
        let count_item = report
            .items
            .iter()
            .find(|i| i.code == "stripped_block_ids_count")
            .unwrap();
        assert!(count_item.detail.contains('2'));
        assert_eq!(
            report
                .items
                .iter()
                .filter(|i| i.code == "stripped_block_ids")
                .count(),
            2
        );
    }

    #[test]
    fn parse_backend_constant_wired() {
        assert_eq!(PARSE_BACKEND, "markdown-rs");
    }
}
