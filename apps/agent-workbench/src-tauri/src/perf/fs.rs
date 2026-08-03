//! 性能工具 - 文件系统：分块读取 / 文件信息。
//!
//! 变更记录：
//! - PE-03 已定 `perf_fs_*` 命令删除注册（实现降为内部 fn 或整体删除）；
//! - G11a：perf_fs_read_chunk / perf_fs_file_info / perf_fs_watch_start /
//!   perf_fs_watch_stop 命令与目录监听机制（WATCHERS / start_watcher_internal /
//!   FsWatchEvent 系列）整段删除（main.rs 注册面零命中，前端无消费方）；
//! - `read_chunk` / `file_info` 保留为测试直接覆盖的核心实现（本文件测试
//!   逐条断言），等待 core_* 命令面迁移时复用。

use memmap2::Mmap;
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

// 测试专用：非 test 构建下无 bin 消费者（perf_fs_* 命令已删，PE-03 迁移
// core_* 前仅测试覆盖），dead_code 静音。
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChunk {
    pub(crate) data: Vec<u8>,
    pub(crate) offset: u64,
    pub(crate) size: usize,
    pub(crate) file_size: u64,
    pub(crate) is_eof: bool,
}

// 测试专用：同 FileChunk（仅测试覆盖，等待 core_* 迁移复用）。
#[cfg_attr(not(test), allow(dead_code))]
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

// 测试专用：同 FileChunk。
#[cfg_attr(not(test), allow(dead_code))]
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
        // 豁免 unsafe_code：memmap2 0.9 的 map/map_copy* 全部为 unsafe
        // （文件截断期间访问映射区间属 UB 面），无 safe 等价 API；
        // 本函数只读映射整文件后取分块，性能关键路径保留 mmap
        // （SAFETY 见下方注释），经评审后允许。
        #[allow(unsafe_code)]
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

// 测试专用：同 FileChunk。
#[cfg_attr(not(test), allow(dead_code))]
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
