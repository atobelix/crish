//! 差异结果模型（对齐 rustCore.ts DiffResult/DiffHunk/DiffLine）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub hunks: Vec<DiffHunk>,
    pub added_lines: usize,
    pub removed_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_result_serializes_to_camel_case() {
        let result = DiffResult {
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 4,
                lines: vec![
                    DiffLine {
                        kind: DiffLineKind::Context,
                        content: "hello".into(),
                    },
                    DiffLine {
                        kind: DiffLineKind::Deletion,
                        content: "old".into(),
                    },
                    DiffLine {
                        kind: DiffLineKind::Addition,
                        content: "new".into(),
                    },
                ],
            }],
            added_lines: 1,
            removed_lines: 1,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["addedLines"], 1);
        assert_eq!(json["removedLines"], 1);
        assert_eq!(json["hunks"][0]["oldStart"], 1);
        assert_eq!(json["hunks"][0]["newLines"], 4);
        assert_eq!(json["hunks"][0]["lines"][0]["kind"], "Context");
        assert_eq!(json["hunks"][0]["lines"][1]["kind"], "Deletion");
    }

    #[test]
    fn diff_result_roundtrip() {
        let result = DiffResult {
            hunks: vec![],
            added_lines: 0,
            removed_lines: 0,
        };
        let json = serde_json::to_string(&result).unwrap();
        let back: DiffResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result, back);
    }
}
