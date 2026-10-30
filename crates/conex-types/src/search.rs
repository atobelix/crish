//! 搜索命中模型（对齐 rustCore.ts FileHit）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub score: i32,
    pub match_indices: Vec<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_hit_serializes_to_camel_case() {
        let hit = FileHit {
            path: "src/main.rs".into(),
            score: 95,
            match_indices: vec![0, 4, 8],
        };
        let json = serde_json::to_value(&hit).unwrap();
        assert_eq!(json["path"], "src/main.rs");
        assert_eq!(json["score"], 95);
        assert_eq!(json["matchIndices"], serde_json::json!([0, 4, 8]));
    }

    #[test]
    fn file_hit_roundtrip() {
        let hit = FileHit {
            path: "test.ts".into(),
            score: 42,
            match_indices: vec![1, 3],
        };
        let json = serde_json::to_string(&hit).unwrap();
        let back: FileHit = serde_json::from_str(&json).unwrap();
        assert_eq!(hit, back);
    }
}
