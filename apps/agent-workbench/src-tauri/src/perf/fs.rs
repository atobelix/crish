//! 性能工具 - 文件系统：分块读取 / 文件信息 / 目录监听。
//!
//! 路径解析（PE-07 T07.2 变更）：不再接收 `workspace_root` 参数（该参数入口已删除），
//! 统一经 `crate::workspace` 的 WorkspaceRegistry 解析（信任锚，B1）——
//! 前端多余参数被 Tauri 忽略，Rust 侧只认注册表授权的活动根。

use memmap2::Mmap;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChunk {
    pub(crate) data: Vec<u8>,
    pub(crate) offset: u64,
    pub(crate) size: usize,
    pub(crate) file_size: u64,
    pub(crate) is_eof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileInfo {
    pub(crate) size: u64,
    pub(crate) modified: u64,
    pub(crate) created: Option<u64>,
    pub(crate) is_file: bool,
    pub(crate) is_dir: bool,
    pub(crate) is_symlink: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FsWatchEvent {
    pub(crate) kind: String,
    pub(crate) paths: Vec<String>,
    pub(crate) timestamp: u64,
}

struct ActiveWatcher {
    _watcher: RecommendedWatcher,
    _stop_tx: Option<oneshot::Sender<()>>,
}

static WATCHERS: OnceLock<Mutex<HashMap<String, ActiveWatcher>>> = OnceLock::new();

fn watchers() -> &'static Mutex<HashMap<String, ActiveWatcher>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册表解析：经 WorkspaceRegistry 活动根解析已存在的文件路径。
fn resolve_existing(app: &AppHandle, path: &str) -> Result<std::path::PathBuf, String> {
    let guard = crate::workspace::resolve_guard(app, "")
        .map_err(|e| format!("Workspace guard error: {}", e.message))?;
    guard.resolve_existing(path).map_err(|e| e.message)
}

pub(crate) fn read_chunk(path: &Path, offset: u64, size: usize) -> Result<FileChunk, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let file_size = file
        .metadata()
        .map_err(|e| format!("Failed to read metadata: {e}"))?
        .len();

    if offset >= file_size {
        return Ok(FileChunk {
            data: Vec::new(),
            offset,
            size: 0,
            file_size,
            is_eof: true,
        });
    }

    let read_size = size.min((file_size - offset) as usize);
    let mut data = vec![0u8; read_size];

    if read_size >= 65536 {
        // SAFETY: Mmap::map 创建文件只读内存映射。调用方保证：
        // - 文件未被另一线程/进程同时截断或改写
        // - 文件句柄在 mmap 生命周期内保持有效
        // - 经 offset+read_size 访问的映射区间在文件边界内
        // 成功后 mmap 提供文件内容的只读视图。
        let mmap = unsafe {
            Mmap::map(&file).map_err(|e| format!("Failed to mmap file: {e}"))?
        };
        let end = (offset as usize + read_size).min(mmap.len());
        data.copy_from_slice(&mmap[offset as usize..end]);
    } else {
        let mut file = file;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to seek file: {e}"))?;
        file.read_exact(&mut data)
            .map_err(|e| format!("Failed to read file chunk: {e}"))?;
    }

    Ok(FileChunk {
        data,
        offset,
        size: read_size,
        file_size,
        is_eof: (offset as usize + read_size) >= file_size as usize,
    })
}

pub(crate) fn file_info(path: &Path) -> Result<FileInfo, String> {
    let sym_meta = std::fs::symlink_metadata(path).map_err(|e| format!("Failed to stat file: {e}"))?;
    let is_symlink = sym_meta.is_symlink();
    let meta = if is_symlink {
        std::fs::metadata(path).map_err(|e| format!("Failed to stat symlink target: {e}"))?
    } else {
        sym_meta
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(FileInfo {
        size: meta.len(),
        modified,
        created,
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        is_symlink,
    })
}

fn start_watcher_internal(
    path: String,
    app_handle: AppHandle,
    recursive: bool,
) -> Result<String, String> {
    let watch_path = std::fs::canonicalize(Path::new(&path))
        .map_err(|e| format!("Failed to canonicalize watch path: {e}"))?;
    let watcher_id = format!("perf-fs-watcher-{}", ts_id());

    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<FsWatchEvent>();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let kind = format_event_kind(&event.kind);
                if kind == "Other" {
                    return;
                }
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .filter_map(|p| p.to_str().map(String::from))
                    .collect();
                let timestamp = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let _ = event_tx.send(FsWatchEvent {
                    kind,
                    paths,
                    timestamp,
                });
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create file watcher: {e}"))?;

    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    watcher
        .watch(&watch_path, mode)
        .map_err(|e| format!("Failed to start watching path: {e}"))?;

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    let emit_handle = app_handle.clone();
    tokio::spawn(async move {
        let mut last_emit = tokio::time::Instant::now();
        let debounce = Duration::from_millis(100);
        let mut pending: Option<FsWatchEvent> = None;

        loop {
            tokio::select! {
                Some(event) = event_rx.recv() => {
                    pending = Some(event);
                    let elapsed = last_emit.elapsed();
                    if elapsed >= debounce {
                        if let Some(ev) = pending.take() {
                            let _ = emit_handle.emit("perf:fs:changed", &ev);
                            last_emit = tokio::time::Instant::now();
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    if let Some(ev) = pending.take() {
                        if last_emit.elapsed() >= debounce {
                            let _ = emit_handle.emit("perf:fs:changed", &ev);
                            last_emit = tokio::time::Instant::now();
                        }
                    }
                }
                _ = &mut stop_rx => {
                    break;
                }
            }
        }
    });

    let mut registry = watchers()
        .lock()
        .map_err(|e| format!("Watcher registry lock: {e}"))?;
    registry.insert(
        watcher_id.clone(),
        ActiveWatcher {
            _watcher: watcher,
            _stop_tx: Some(stop_tx),
        },
    );

    Ok(watcher_id)
}

fn format_event_kind(kind: &EventKind) -> String {
    match kind {
        EventKind::Create(_) => "Create".to_string(),
        EventKind::Modify(_) => "Modify".to_string(),
        EventKind::Remove(_) => "Remove".to_string(),
        EventKind::Any => "Any".to_string(),
        _ => "Other".to_string(),
    }
}

fn ts_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            SystemTime::now().hash(&mut hasher);
            format!("{:x}", hasher.finish())
        })
}

#[tauri::command]
pub(crate) fn perf_fs_read_chunk(
    app: AppHandle,
    path: String,
    offset: u64,
    size: u32,
) -> Result<FileChunk, String> {
    let resolved = resolve_existing(&app, &path)?;
    read_chunk(&resolved, offset, size as usize)
}

#[tauri::command]
pub(crate) fn perf_fs_file_info(app: AppHandle, path: String) -> Result<FileInfo, String> {
    let resolved = resolve_existing(&app, &path)?;
    file_info(&resolved)
}

#[tauri::command]
pub(crate) fn perf_fs_watch_start(
    app: AppHandle,
    path: String,
    recursive: Option<bool>,
) -> Result<String, String> {
    let resolved = resolve_existing(&app, &path)?;
    start_watcher_internal(
        resolved.to_string_lossy().to_string(),
        app,
        recursive.unwrap_or(false),
    )
}

#[tauri::command]
pub(crate) fn perf_fs_watch_stop(watcher_id: String) -> Result<(), String> {
    let mut registry = watchers()
        .lock()
        .map_err(|e| format!("Watcher registry lock: {e}"))?;
    registry
        .remove(&watcher_id)
        .ok_or_else(|| format!("Watcher not found: {watcher_id}"))?;
    Ok(())
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
        let dir = env::temp_dir().join(format!("perf-fs-test-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn read_chunk_basic() {
        let dir = temp_dir();
        let path = dir.join("test.bin");
        let content = b"Hello, World! This is a test file.";
        fs::write(&path, content).expect("write test file");

        let chunk = read_chunk(&path, 0, 5).expect("read chunk");
        assert_eq!(chunk.data, b"Hello");
        assert_eq!(chunk.offset, 0);
        assert_eq!(chunk.size, 5);
        assert!(!chunk.is_eof);
    }

    #[test]
    fn read_chunk_eof() {
        let dir = temp_dir();
        let path = dir.join("eof.bin");
        fs::write(&path, b"abc").expect("write");

        let chunk = read_chunk(&path, 10, 5).expect("read past eof");
        assert!(chunk.data.is_empty());
        assert!(chunk.is_eof);
    }

    #[test]
    fn read_chunk_exact_remaining() {
        let dir = temp_dir();
        let path = dir.join("exact.bin");
        fs::write(&path, b"abcdef").expect("write");

        let chunk = read_chunk(&path, 3, 3).expect("read remaining");
        assert_eq!(chunk.data, b"def");
        assert!(chunk.is_eof);
    }

    #[test]
    fn read_chunk_large_uses_mmap() {
        let dir = temp_dir();
        let path = dir.join("large.bin");
        let content = vec![0xABu8; 131072];
        fs::write(&path, &content).expect("write large file");

        let chunk = read_chunk(&path, 0, 65536).expect("read large chunk");
        assert_eq!(chunk.size, 65536);
        assert_eq!(chunk.data[0], 0xAB);
        assert_eq!(chunk.data[65535], 0xAB);
        assert!(!chunk.is_eof);
    }

    #[test]
    fn file_info_basic() {
        let dir = temp_dir();
        let path = dir.join("info.txt");
        fs::write(&path, b"test data").expect("write");

        let info = file_info(&path).expect("get info");
        assert_eq!(info.size, 9);
        assert!(info.is_file);
        assert!(!info.is_dir);
        assert!(info.modified > 0);
    }

    #[test]
    fn file_info_nonexistent() {
        let dir = temp_dir();
        let result = file_info(&dir.join("nonexistent.txt"));
        assert!(result.is_err());
    }
}
