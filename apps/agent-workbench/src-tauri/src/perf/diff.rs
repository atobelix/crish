use conex_run::core_error::CoreError;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffHunk {
    pub(crate) old_start: u64,
    pub(crate) old_count: u64,
    pub(crate) new_start: u64,
    pub(crate) new_count: u64,
    pub(crate) header: String,
    pub(crate) lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffLine {
    pub(crate) kind: DiffLineKind,
    pub(crate) content: String,
    pub(crate) old_lineno: Option<u64>,
    pub(crate) new_lineno: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffLineKind {
    Context,
    Addition,
    Deletion,
    NoNewline,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffFile {
    pub(crate) old_path: String,
    pub(crate) new_path: String,
    pub(crate) status: DiffFileStatus,
    pub(crate) hunks: Vec<DiffHunk>,
    pub(crate) stats: DiffStats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
// G11a 备注：Copied 变体当前解析器不产出（git 摘要语义完整面），
// 枚举整体 dead_code 静音保留序列化契约。
#[allow(dead_code)]
pub(crate) enum DiffFileStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffStats {
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    pub(crate) hunks: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffParseResult {
    pub(crate) files: Vec<DiffFile>,
    pub(crate) total_additions: usize,
    pub(crate) total_deletions: usize,
    pub(crate) total_files: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffResult {
    pub(crate) files: Vec<DiffFile>,
    pub(crate) truncated: bool,
}

fn parse_diff_status(old: &str, new: &str) -> DiffFileStatus {
    if old == "/dev/null" {
        DiffFileStatus::Added
    } else if new == "/dev/null" {
        DiffFileStatus::Deleted
    } else if old != new {
        DiffFileStatus::Renamed
    } else {
        DiffFileStatus::Modified
    }
}

fn strip_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")) {
        rest.to_string()
    } else {
        path.to_string()
    }
}

pub(crate) fn parse_unified_diff(input: &str) -> Result<DiffParseResult, CoreError> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut total_additions = 0usize;
    let mut total_deletions = 0usize;

    let mut old_path: Option<String> = None;
    let mut new_path: Option<String> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut file_additions = 0usize;
    let mut file_deletions = 0usize;

    for line in input.lines() {
        if line.starts_with("diff --git ") {
            if let (Some(old), Some(new)) = (old_path.take(), new_path.take()) {
                if let Some(hunk) = current_hunk.take() {
                    hunks.push(hunk);
                }
                let status = parse_diff_status(&old, &new);
                files.push(DiffFile {
                    old_path: old,
                    new_path: new,
                    status,
                    stats: DiffStats {
                        additions: file_additions,
                        deletions: file_deletions,
                        hunks: hunks.len(),
                    },
                    hunks: std::mem::take(&mut hunks),
                });
                file_additions = 0;
                file_deletions = 0;
            }
            continue;
        }

        if let Some(rest) = line.strip_prefix("--- ") {
            old_path = Some(strip_prefix(rest));
            continue;
        }

        if let Some(rest) = line.strip_prefix("+++ ") {
            new_path = Some(strip_prefix(rest));
            continue;
        }

        if let Some(hunk_header) = line.strip_prefix("@@ ") {
            if let Some(end) = hunk_header.find(" @@") {
                let ranges = &hunk_header[..end];
                let parts: Vec<&str> = ranges.split_whitespace().collect();
                if parts.len() >= 2 {
                    let parse_range = |r: &str| -> Option<(u64, u64)> {
                        let r = &r[1..];
                        if let Some((start, count)) = r.split_once(',') {
                            Some((start.parse().ok()?, count.parse().ok()?))
                        } else {
                            Some((r.parse().ok()?, 1))
                        }
                    };
                    if let (Some(old_range), Some(new_range)) = (
                        parts.first().and_then(|p| parse_range(p)),
                        parts.get(1).and_then(|p| parse_range(p)),
                    ) {
                        if let Some(hunk) = current_hunk.take() {
                            hunks.push(hunk);
                        }
                        current_hunk = Some(DiffHunk {
                            old_start: old_range.0,
                            old_count: old_range.1,
                            new_start: new_range.0,
                            new_count: new_range.1,
                            header: hunk_header.to_string(),
                            lines: Vec::new(),
                        });
                        continue;
                    }
                }
            }
        }

        if let Some(ref mut hunk) = current_hunk {
            let content = if line.starts_with('\n') {
                "\n".to_string()
            } else {
                line.to_string()
            };

            if let Some(rest) = line.strip_prefix('+') {
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Addition,
                    content: rest.to_string(),
                    old_lineno: None,
                    new_lineno: Some(hunk.new_start + count_additions(&hunk.lines)),
                });
                file_additions += 1;
                total_additions += 1;
            } else if let Some(rest) = line.strip_prefix('-') {
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Deletion,
                    content: rest.to_string(),
                    old_lineno: Some(hunk.old_start + count_deletions(&hunk.lines)),
                    new_lineno: None,
                });
                file_deletions += 1;
                total_deletions += 1;
            } else if line.starts_with("\\ ") {
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::NoNewline,
                    content: line.to_string(),
                    old_lineno: None,
                    new_lineno: None,
                });
            } else {
                let ctx_offset = count_context(&hunk.lines);
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Context,
                    content: line.strip_prefix(' ').unwrap_or(&content).to_string(),
                    old_lineno: Some(hunk.old_start + ctx_offset),
                    new_lineno: Some(hunk.new_start + ctx_offset),
                });
            }
        }
    }

    if let (Some(old), Some(new)) = (old_path.take(), new_path.take()) {
        if let Some(hunk) = current_hunk.take() {
            hunks.push(hunk);
        }
        let status = parse_diff_status(&old, &new);
        files.push(DiffFile {
            old_path: old,
            new_path: new,
            status,
            stats: DiffStats {
                additions: file_additions,
                deletions: file_deletions,
                hunks: hunks.len(),
            },
            hunks: std::mem::take(&mut hunks),
        });
    }

    Ok(DiffParseResult {
        total_files: files.len(),
        total_additions,
        total_deletions,
        files,
    })
}

fn count_additions(lines: &[DiffLine]) -> u64 {
    lines
        .iter()
        .filter(|l| matches!(l.kind, DiffLineKind::Addition))
        .count() as u64
}

fn count_deletions(lines: &[DiffLine]) -> u64 {
    lines
        .iter()
        .filter(|l| matches!(l.kind, DiffLineKind::Deletion))
        .count() as u64
}

fn count_context(lines: &[DiffLine]) -> u64 {
    lines
        .iter()
        .filter(|l| matches!(l.kind, DiffLineKind::Context))
        .count() as u64
}

pub(crate) fn parse_diff_truncated(input: &str, max_lines: Option<u32>) -> DiffResult {
    let max = max_lines.unwrap_or(10000) as usize;
    let lines: Vec<&str> = input.lines().collect();
    let truncated = lines.len() > max;
    let input = if truncated {
        lines[..max].join("\n")
    } else {
        input.to_string()
    };
    let parsed = parse_unified_diff(&input).unwrap_or(DiffParseResult {
        files: Vec::new(),
        total_additions: 0,
        total_deletions: 0,
        total_files: 0,
    });
    DiffResult {
        files: parsed.files,
        truncated,
    }
}

#[tauri::command]
pub(crate) fn perf_diff_parse(
    unified_diff: String,
    max_lines: Option<u32>,
) -> Result<DiffResult, CoreError> {
    Ok(parse_diff_truncated(&unified_diff, max_lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_diff() {
        let input = "\
diff --git a/src/main.rs b/src/main.rs
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!(\"hello\");
+    println!(\"hello world\");
+    println!(\"goodbye\");
 }
";
        let result = parse_unified_diff(input).expect("parse diff");
        assert_eq!(result.total_files, 1);
        assert_eq!(result.total_additions, 2);
        assert_eq!(result.total_deletions, 1);
        let file = &result.files[0];
        assert_eq!(file.old_path, "src/main.rs");
        assert_eq!(file.new_path, "src/main.rs");
        assert_eq!(file.hunks.len(), 1);
        let hunk = &file.hunks[0];
        assert_eq!(hunk.lines.len(), 5);
        assert!(matches!(hunk.lines[0].kind, DiffLineKind::Context));
        assert!(matches!(hunk.lines[1].kind, DiffLineKind::Deletion));
        assert!(matches!(hunk.lines[2].kind, DiffLineKind::Addition));
        assert!(matches!(hunk.lines[3].kind, DiffLineKind::Addition));
        assert!(matches!(hunk.lines[4].kind, DiffLineKind::Context));
    }

    #[test]
    fn parse_new_file_diff() {
        let input = "\
diff --git a/new.rs b/new.rs
new file mode 100644
--- /dev/null
+++ b/new.rs
@@ -0,0 +1,3 @@
+fn new_func() {
+    todo!()
+}
";
        let result = parse_unified_diff(input).expect("parse new file diff");
        assert_eq!(result.total_files, 1);
        assert!(matches!(result.files[0].status, DiffFileStatus::Added));
    }

    #[test]
    fn parse_empty_string() {
        let result = parse_unified_diff("").expect("parse empty");
        assert_eq!(result.total_files, 0);
        assert_eq!(result.total_additions, 0);
        assert_eq!(result.total_deletions, 0);
    }

    #[test]
    fn parse_deleted_file_diff() {
        let input = "\
diff --git a/old.rs b/old.rs
deleted file mode 100644
--- a/old.rs
+++ /dev/null
@@ -1,2 +0,0 @@
-fn old_func() {
-}
";
        let result = parse_unified_diff(input).expect("parse deleted file diff");
        assert_eq!(result.total_files, 1);
        assert!(matches!(result.files[0].status, DiffFileStatus::Deleted));
        assert_eq!(result.total_deletions, 2);
    }
}
