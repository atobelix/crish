use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::Path,
};

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JsonlReadResult {
    pub(crate) records: Vec<serde_json::Value>,
    pub(crate) line_count: usize,
    pub(crate) truncated: bool,
    pub(crate) parse_errors: Vec<JsonlParseError>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JsonlParseError {
    pub(crate) line: usize,
    pub(crate) message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JsonlWriteResult {
    pub(crate) path: String,
    pub(crate) records_written: usize,
    pub(crate) bytes_written: u64,
}

pub(crate) fn read_jsonl_lines(path: &Path, max_lines: Option<u32>) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open JSONL file: {e}"))?;
    let reader = BufReader::new(file);
    let max = max_lines.unwrap_or(u32::MAX) as usize;
    let mut lines: Vec<String> = Vec::new();

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| format!("Failed to read JSONL line: {e}"))?;
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if lines.len() >= max {
            break;
        }
        lines.push(trimmed);
    }

    Ok(lines)
}

pub(crate) fn append_jsonl_lines(path: &Path, lines: &[String], flush: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent dirs: {e}"))?;
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Failed to open JSONL file for append: {e}"))?;

    for line in lines {
        writeln!(file, "{line}").map_err(|e| format!("Failed to write JSONL line: {e}"))?;
    }

    if flush {
        file.sync_all().map_err(|e| format!("Failed to sync file: {e}"))?;
    }

    Ok(())
}

#[allow(dead_code)]
pub(crate) fn read_jsonl(path: &Path, max_records: Option<usize>) -> Result<JsonlReadResult, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open JSONL file: {e}"))?;
    let reader = BufReader::new(file);
    let max = max_records.unwrap_or(usize::MAX);
    let mut records: Vec<serde_json::Value> = Vec::new();
    let mut parse_errors: Vec<JsonlParseError> = Vec::new();
    let mut truncated = false;
    let mut line_count = 0usize;

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| format!("Failed to read JSONL line: {e}"))?;
        line_count += 1;

        if records.len() >= max {
            truncated = true;
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(value) => records.push(value),
            Err(e) => {
                parse_errors.push(JsonlParseError {
                    line: line_count,
                    message: format!("{e}"),
                });
            }
        }
    }

    Ok(JsonlReadResult {
        records,
        line_count,
        truncated,
        parse_errors,
    })
}

pub(crate) fn write_jsonl(
    path: &Path,
    records: &[serde_json::Value],
    append: bool,
) -> Result<JsonlWriteResult, String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent dirs: {e}"))?;
        }
    }

    if append {
        let lines: Vec<String> = records
            .iter()
            .map(|r| serde_json::to_string(r).map_err(|e| format!("Failed to serialize record: {e}")))
            .collect::<Result<Vec<_>, String>>()?;
        append_jsonl_lines(path, &lines, false)?;

        let file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
        let bytes_written = file.metadata().map(|m| m.len()).unwrap_or(0);
        return Ok(JsonlWriteResult {
            path: path.to_string_lossy().to_string(),
            records_written: records.len(),
            bytes_written,
        });
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!append)
        .open(path)
        .map_err(|e| format!("Failed to open JSONL file for writing: {e}"))?;

    let mut records_written = 0usize;
    for record in records {
        let line = serde_json::to_string(record)
            .map_err(|e| format!("Failed to serialize record: {e}"))?;
        writeln!(file, "{line}").map_err(|e| format!("Failed to write JSONL line: {e}"))?;
        records_written += 1;
    }

    let bytes_written = file
        .metadata()
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(JsonlWriteResult {
        path: path.to_string_lossy().to_string(),
        records_written,
        bytes_written,
    })
}

fn resolve_path(
    path: &str,
    workspace_root: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    use crate::fs_commands::WorkspaceFsGuard;
    let guard = WorkspaceFsGuard::from_optional_root(workspace_root)
        .map_err(|e| format!("Workspace guard error: {}", e.message))?;
    if std::path::Path::new(path).exists() {
        guard.resolve_existing(path).map_err(|e| e.message)
    } else {
        guard.resolve_for_write(path).map_err(|e| e.message)
    }
}

#[tauri::command]
pub(crate) fn perf_jsonl_read(
    path: String,
    max_lines: Option<u32>,
    workspace_root: Option<String>,
) -> Result<Vec<String>, String> {
    let resolved = resolve_path(&path, workspace_root.as_deref())?;
    read_jsonl_lines(&resolved, max_lines)
}

#[tauri::command]
pub(crate) fn perf_jsonl_append(
    path: String,
    lines: Vec<String>,
    flush: Option<bool>,
    workspace_root: Option<String>,
) -> Result<(), String> {
    let resolved = resolve_path(&path, workspace_root.as_deref())?;
    append_jsonl_lines(&resolved, &lines, flush.unwrap_or(false))
}

#[tauri::command]
pub(crate) fn perf_jsonl_write(
    path: String,
    records: Vec<serde_json::Value>,
    append: Option<bool>,
    workspace_root: Option<String>,
) -> Result<JsonlWriteResult, String> {
    let resolved = resolve_path(&path, workspace_root.as_deref())?;
    write_jsonl(&resolved, &records, append.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("perf-jsonl-test-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn roundtrip_jsonl() {
        let dir = temp_dir();
        let path = dir.join("test.jsonl");
        let records = vec![
            serde_json::json!({"a": 1, "b": "hello"}),
            serde_json::json!({"a": 2, "b": "world"}),
        ];

        let written = write_jsonl(&path, &records, false).expect("write");
        assert_eq!(written.records_written, 2);

        let read = read_jsonl(&path, None).expect("read");
        assert_eq!(read.records.len(), 2);
        assert_eq!(read.records[0]["a"], 1);
        assert_eq!(read.records[1]["b"], "world");
        assert!(!read.truncated);
        assert!(read.parse_errors.is_empty());
    }

    #[test]
    fn append_jsonl() {
        let dir = temp_dir();
        let path = dir.join("append.jsonl");
        let records = vec![serde_json::json!({"n": 1})];

        write_jsonl(&path, &records, false).expect("write first");
        write_jsonl(&path, &records, true).expect("append");

        let read = read_jsonl(&path, None).expect("read");
        assert_eq!(read.records.len(), 2);
    }

    #[test]
    fn max_records_truncation() {
        let dir = temp_dir();
        let path = dir.join("truncate.jsonl");
        let records = vec![
            serde_json::json!({"i": 1}),
            serde_json::json!({"i": 2}),
            serde_json::json!({"i": 3}),
        ];
        write_jsonl(&path, &records, false).expect("write");

        let read = read_jsonl(&path, Some(2)).expect("read");
        assert_eq!(read.records.len(), 2);
        assert!(read.truncated);
    }

    #[test]
    fn handle_malformed_lines() {
        let dir = temp_dir();
        let path = dir.join("malformed.jsonl");
        fs::write(&path, "{\"valid\": true}\nnot-json\n{\"also\": \"valid\"}\n")
            .expect("write malformed");

        let read = read_jsonl(&path, None).expect("read");
        assert_eq!(read.records.len(), 2);
        assert_eq!(read.parse_errors.len(), 1);
        assert_eq!(read.parse_errors[0].line, 2);
    }

    #[test]
    fn skip_comments_and_empty() {
        let dir = temp_dir();
        let path = dir.join("comments.jsonl");
        fs::write(&path, "# this is a comment\n\n{\"x\": 1}\n").expect("write");

        let read = read_jsonl(&path, None).expect("read");
        assert_eq!(read.records.len(), 1);
    }
}
