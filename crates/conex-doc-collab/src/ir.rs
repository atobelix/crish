use crate::block_id::BlockId;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;

/// 字符串 fractional index 比较（Wave 0：字典序即可；并发同键时由调用方用 id 等破序）。
#[inline]
pub fn cmp_order(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Paragraph,
    Heading { level: u8 },
    BulletItem,
    OrderedItem,
    Code,
    Quote,
    Divider,
    /// 未知 flavour 占位
    Unknown { flavour: String },
}

impl BlockKind {
    /// 纸面 flavour / slash catalog id → [`BlockKind`]。
    ///
    /// 对齐 TS `@crish/block-paper-contract` `flavourToCollabKind`：
    /// `heading-1`→Heading{1}、`bullet`→BulletItem、未识别→Unknown。
    ///
    /// 供 CONN-D：`pending_turn_into_flavour` 消费与 `Op::TurnInto` 从 flavour 构造。
    pub fn from_flavour(flavour: &str) -> Self {
        let raw = flavour.trim();
        let f = raw.to_ascii_lowercase();
        if f.is_empty() || f == "paragraph" || f == "text" || f == "p" {
            return BlockKind::Paragraph;
        }
        // heading / heading-N / heading_N
        if let Some(rest) = f.strip_prefix("heading") {
            let level = parse_heading_level_suffix(rest).unwrap_or(1);
            return BlockKind::Heading { level };
        }
        match f.as_str() {
            "h1" => BlockKind::Heading { level: 1 },
            "h2" => BlockKind::Heading { level: 2 },
            "h3" => BlockKind::Heading { level: 3 },
            "h4" => BlockKind::Heading { level: 4 },
            "h5" => BlockKind::Heading { level: 5 },
            "h6" => BlockKind::Heading { level: 6 },
            "bullet" | "bullet_item" | "bullet-item" | "list" | "ul" => {
                BlockKind::BulletItem
            }
            "ordered" | "ordered_item" | "ordered-item" | "numbered" | "ol" => {
                BlockKind::OrderedItem
            }
            "code" | "code_block" | "code-block" => BlockKind::Code,
            "quote" | "blockquote" => BlockKind::Quote,
            "divider" | "hr" | "horizontal_rule" => BlockKind::Divider,
            _ => BlockKind::Unknown {
                // 保留原始 flavour（非 lower），与 TS unknown 分支一致
                flavour: if raw.is_empty() {
                    f
                } else {
                    raw.to_string()
                },
            },
        }
    }
}

/// `heading` 后缀：`""` / `"-1"` / `"_2"` / `"3"` → level 1..=6。
fn parse_heading_level_suffix(rest: &str) -> Option<u8> {
    let s = rest.trim_start_matches(['-', '_']);
    if s.is_empty() {
        return Some(1);
    }
    let n: u8 = s.parse().ok()?;
    if (1..=6).contains(&n) {
        Some(n)
    } else {
        Some(1)
    }
}

/// attrs 键：TS `turnIntoIntentToProvisionalOps` 写入的待转类型标记。
///
/// CONN-D：`DocSession::apply` 在 `UpdateProps` 时**消费**此键并改 [`BlockNode::kind`]；
/// 标记本身保留作审计；**权威 kind 以节点 `kind` 为准**，UI 不得单读本 attrs 当 flavour。
pub const PENDING_TURN_INTO_FLAVOUR_ATTR: &str = "pending_turn_into_flavour";

/// 若 props.attrs 含 `pending_turn_into_flavour` 字符串，映射为 [`BlockKind`]。
pub fn pending_turn_into_kind(props: &BlockProps) -> Option<BlockKind> {
    let v = props.attrs.get(PENDING_TURN_INTO_FLAVOUR_ATTR)?;
    let s = v.as_str()?;
    Some(BlockKind::from_flavour(s))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BlockProps {
    #[serde(default)]
    pub attrs: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockNode {
    pub id: BlockId,
    pub parent: Option<BlockId>,
    pub order: String,
    pub kind: BlockKind,
    pub props: BlockProps,
    /// 冷藏文本快照（H1）；热路径可空而由 TextEngine 提供
    #[serde(default)]
    pub text_snapshot: Option<String>,
    pub children: Vec<BlockId>,
}

/// 内存块树（权威结构侧）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BlockTree {
    pub root_children: Vec<BlockId>,
    pub nodes: HashMap<BlockId, BlockNode>,
}

impl BlockTree {
    pub fn get(&self, id: &BlockId) -> Option<&BlockNode> {
        self.nodes.get(id)
    }

    /// 按 `order` 字典序（再以 BlockId UUID 破平）排序给定兄弟列表。
    pub fn sort_sibling_ids(&self, ids: &mut [BlockId]) {
        ids.sort_by(|a, b| {
            let oa = self.nodes.get(a).map(|n| n.order.as_str()).unwrap_or("");
            let ob = self.nodes.get(b).map(|n| n.order.as_str()).unwrap_or("");
            cmp_order(oa, ob).then_with(|| a.as_uuid().cmp(&b.as_uuid()))
        });
    }

    /// 重排某父下的 children（`None` = 文档根）。
    pub fn resort_children_of(&mut self, parent: Option<BlockId>) {
        // 先取出 order 快照再排，避免同时可变借用 nodes 与 children
        let snapshot: Vec<(BlockId, String)> = {
            let ids: &[BlockId] = match parent {
                Some(pid) => match self.nodes.get(&pid) {
                    Some(n) => &n.children,
                    None => return,
                },
                None => &self.root_children,
            };
            ids.iter()
                .map(|id| {
                    let order = self
                        .nodes
                        .get(id)
                        .map(|n| n.order.clone())
                        .unwrap_or_default();
                    (*id, order)
                })
                .collect()
        };
        let mut sorted = snapshot;
        sorted.sort_by(|(a, oa), (b, ob)| {
            cmp_order(oa, ob).then_with(|| a.as_uuid().cmp(&b.as_uuid()))
        });
        let ordered: Vec<BlockId> = sorted.into_iter().map(|(id, _)| id).collect();
        match parent {
            Some(pid) => {
                if let Some(n) = self.nodes.get_mut(&pid) {
                    n.children = ordered;
                }
            }
            None => self.root_children = ordered,
        }
    }
}

#[cfg(test)]
mod order_tests {
    use super::cmp_order;
    use std::cmp::Ordering;

    #[test]
    fn cmp_order_lexicographic() {
        assert_eq!(cmp_order("a0", "a1"), Ordering::Less);
        assert_eq!(cmp_order("b0", "a9"), Ordering::Greater);
        assert_eq!(cmp_order("a0", "a0"), Ordering::Equal);
    }
}
