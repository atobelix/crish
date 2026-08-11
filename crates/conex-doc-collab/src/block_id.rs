//! 稳定块 ID：机器主编码 `<!--c:ID-->`（见 15 / W0-B）。

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use uuid::Uuid;

/// 产品层块 ID（非 yrs 内部 id）。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BlockId(Uuid);

impl BlockId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }

    /// `<!--c:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-->`
    pub fn to_html_comment(&self) -> String {
        format!("<!--c:{}-->", self.0)
    }
}

impl Default for BlockId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for BlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl fmt::Debug for BlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "BlockId({})", self.0)
    }
}

impl FromStr for BlockId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

/// 从 `<!--c:UUID-->` 解析；失败返回 None。
pub fn block_id_from_comment(line: &str) -> Option<BlockId> {
    let t = line.trim();
    let rest = t.strip_prefix("<!--c:")?.strip_suffix("-->")?;
    BlockId::from_str(rest.trim()).ok()
}

pub fn block_id_to_comment(id: &BlockId) -> String {
    id.to_html_comment()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_roundtrip() {
        let id = BlockId::new();
        let c = id.to_html_comment();
        assert_eq!(block_id_from_comment(&c), Some(id));
    }

    #[test]
    fn rejects_garbage() {
        assert!(block_id_from_comment("<!--c:not-a-uuid-->").is_none());
        assert!(block_id_from_comment("plain").is_none());
    }
}
