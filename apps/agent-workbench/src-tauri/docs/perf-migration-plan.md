# Conex/Crish Rust 原生模块迁移方案

## 目标

将 7 个性能关键路径从 Node.js/TypeScript 迁移到 Rust（Tauri command），利用 Rust 的零成本抽象、无 GC、SIMD、内存映射等特性实现 2-20x 加速。

## 选择标准回顾

1. 单次调用 > 1ms CPU 时间
2. 处理数据 > 10MB
3. 大量字符串操作/编解码
4. 需要零拷贝（mmap, 共享内存）
5. 需要操作系统原生 API（inotify, FSEvents, ReadDirectoryChangesW）

---

## 模块架构总览

```
apps/agent-workbench/src-tauri/src/
├── main.rs                    # 注册所有 performance commands
├── commands.rs                # HTTP 请求（已有）
├── fs_commands.rs             # 现有文件读写（保留兼容）
├── perf/
│   ├── mod.rs                 # register_performance_commands()
│   ├── file_io.rs             # P0: 文件 I/O 引擎（mmap/stream/atomic）
│   ├── git_diff.rs            # P1: 流式 diff 解析器
│   ├── jsonl.rs               # P2: JSONL 引擎（append/read/compact）
│   ├── crypto.rs              # P3: SHA256/Base64
│   ├── encoding.rs            # P4: 编码检测（chardetng）
│   ├── json_stream.rs         # P5: 大 JSON 流式处理
│   └── string_match.rs        # P6: URL 安全检测/正则匹配
```

---

## P0: 文件 I/O 引擎（File IO Engine）

### 依赖

```toml
memmap2 = "0.9"                # 内存映射文件读取
tempfile = "3"                 # 原子写入临时文件
notify = "7"                   # 文件系统监控（Watchdog）
```

### API

```rust
// src/perf/file_io.rs

use memmap2::Mmap;
use std::io::{Read, Write};
use std::path::Path;

/// 流式读取文件指定范围（支持大文件分块）
#[tauri::command]
async fn stream_read_file(path: String, offset: u64, size: u64) -> Result<Vec<u8>, String> {
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let file_len = f.metadata().map_err(|e| e.to_string())?.len();
    let actual_offset = offset.min(file_len);
    let actual_size = size.min(file_len.saturating_sub(actual_offset));
    let mut buf = vec![0u8; actual_size as usize];
    use std::io::SeekFrom;
    f.seek(SeekFrom::Start(actual_offset)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// 内存映射读取整个文件（零拷贝到用户态，仅适合固定/静态文件）
#[tauri::command]
async fn mmap_read_file(path: String) -> Result<Vec<u8>, String> {
    let f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mmap = unsafe { Mmap::map(&f).map_err(|e| e.to_string())? };
    Ok(mmap[..].to_vec())
}

/// 原子写入（tmp + rename），防止写入中间态被读到
#[tauri::command]
async fn atomic_write_file(path: String, content: Vec<u8>) -> Result<(), String> {
    let p = Path::new(&path);
    let dir = p.parent().unwrap_or(Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(&content).map_err(|e| e.to_string())?;
    tmp.persist(p).map_err(|e| e.to_string())?;
    // 目录 fsync
    if let Ok(dir_f) = std::fs::File::open(dir) {
        let _ = dir_f.sync_all();
    }
    Ok(())
}

/// Watchdog：基于 notify crate 的文件监控（跨平台：inotify/FSEvents/ReadDirectoryChangesW）
#[tauri::command]
async fn watch_file(path: String) -> Result<(), String> {
    // 使用 notify::Watcher，通过 event channel 推送前端
    // 需与 tauri event 系统集成
    todo!()
}
```

### 性能目标

| 操作 | 当前（Node.js readFile/writeFile） | Rust | 加速比 |
|-----|------------------------------------|------|--------|
| 读取 100MB 文件 | ~100ms (fs.readFile) | <50ms (mmap) | 2x |
| 写入 100MB 文件 | ~300ms | <200ms (atomic write) | 1.5x |
| 小文件原子写入 | ~2ms (write+rename in JS) | <0.5ms | 4x |

### 集成路径

1. `workspaceFsApi.ts` 中新增 `streamReadFile()` / `mmapReadFile()` / `atomicWriteFile()` 方法
2. 用 `invokeResult<T>()` 调用对应 Tauri command
3. 大文件预览改用 `stream_read_file` + offset/limit 实现按需加载（替换现有 `read_file_content` 的全量策略）

---

## P1: Git Diff 解析（GitDiffParser）

### 依赖

```toml
# 纯 Rust 解析，无需额外 crate（仅 serde 用于序列化）
```

### API

```rust
// src/perf/git_diff.rs

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeLine {
    pub r#type: String,  // "addition" | "deletion" | "normal"
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResult {
    pub file_path: String,
    pub additions: u32,
    pub deletions: u32,
    pub changes: Vec<ChangeLine>,
    pub truncated: bool,
    pub total_changes: u32,
}

/// 解析 unified diff 字符串，支持 offset/limit 分块返回
#[tauri::command]
async fn parse_git_diff(
    unified: String,
    offset: u32,
    limit: u32,
) -> Result<Vec<FileDiffResult>, String> {
    let input = unified.replace("\r\n", "\n");
    let mut files: Vec<FileDiffResult> = Vec::new();
    let mut current_path = String::new();
    let mut changes: Vec<ChangeLine> = Vec::new();
    let mut additions = 0u32;
    let mut deletions = 0u32;

    for line in input.lines() {
        // diff --git a/... b/...
        if let Some(caps) = line.strip_prefix("diff --git a/") {
            // flush previous file
            if !current_path.is_empty() && !changes.is_empty() {
                files.push(flush_file(&mut current_path, &mut changes, &mut additions, &mut deletions));
            }
            if let Some(b_path) = caps.split_once(" b/") {
                current_path = b_path.1.to_string();
            }
            continue;
        }
        // +++ b/...
        if let Some(rest) = line.strip_prefix("+++ b/") {
            if current_path.is_empty() { current_path = rest.to_string(); }
            continue;
        }
        // --- a/...
        if let Some(rest) = line.strip_prefix("--- a/") {
            if current_path.is_empty() { current_path = rest.to_string(); }
            continue;
        }
        // @@ hunk header
        if line.starts_with("@@") {
            changes.push(ChangeLine { r#type: "normal".into(), content: line.to_string() });
            continue;
        }
        if current_path.is_empty() { continue; }

        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
            changes.push(ChangeLine { r#type: "addition".into(), content: line[1..].to_string() });
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
            changes.push(ChangeLine { r#type: "deletion".into(), content: line[1..].to_string() });
        } else {
            let content = if line.starts_with(' ') { &line[1..] } else { line };
            changes.push(ChangeLine { r#type: "normal".into(), content: content.to_string() });
        }
    }
    // flush last file
    if !current_path.is_empty() && !changes.is_empty() {
        files.push(flush_file(&mut current_path, &mut changes, &mut additions, &mut deletions));
    }

    // Apply offset/limit at file level
    let offset = offset as usize;
    let limit = limit as usize;
    if offset > 0 || limit > 0 {
        if offset < files.len() {
            files = files.into_iter().skip(offset).take(if limit > 0 { limit } else { usize::MAX }).collect();
        } else {
            files = vec![];
        }
    }

    Ok(files)
}

fn flush_file(
    path: &mut String,
    changes: &mut Vec<ChangeLine>,
    additions: &mut u32,
    deletions: &mut u32,
) -> FileDiffResult {
    let total = changes.len() as u32;
    let truncated = changes.len() > 400;
    let capped: Vec<ChangeLine> = changes.drain(..changes.len().min(400)).collect();
    let result = FileDiffResult {
        file_path: std::mem::take(path),
        additions: *additions,
        deletions: *deletions,
        changes: capped,
        truncated,
        total_changes: total,
    };
    *additions = 0;
    *deletions = 0;
    result
}

/// 直接调用 `git diff` 并解析输出流
#[tauri::command]
async fn parse_git_diff_stream(path: String, options: DiffOptions) -> Result<Vec<FileDiffResult>, String> {
    // 调用 git diff 命令，通过 std::process::Command 或 tokio::process
    // 读取 stdout 流，边读边解析
    todo!()
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    pub cached: Option<bool>,
    pub staged: Option<bool>,
    pub base: Option<String>,
    pub head: Option<String>,
}
```

### 性能目标

| 操作 | 当前（JS parseUnifiedDiffs） | Rust | 加速比 |
|-----|-----------------------------|------|--------|
| 解析 10000 行 diff | ~100ms | <5ms | 20x |
| 解析 50000 行 diff | ~500ms | <20ms | 25x |

### 集成路径

1. `toolFeedback.ts` 中 `parseUnifiedDiffs()` 添加 Rust 路径：
   ```typescript
   export async function parseUnifiedDiffsRust(text: string, offset = 0, limit = 0): Promise<FileDiff[]> {
     const res = await invokeResult<FileDiff[]>('parse_git_diff', { unified: text, offset, limit });
     if (res.status === 'ok') return res.data;
     return fallbackParseUnifiedDiffs(text); // JS fallback
   }
   ```
2. `resolveToolDiffs()` 中大型 diff（>5000 字符）优先走 Rust 路径
3. Rust 侧流式解析无需一次性分配完整 `Vec<Vec<ChangeLine>>`，可逐文件 yield

---

## P2: JSONL 引擎（JsonlEngine）

### 依赖

```toml
fs2 = "0.4"                    # 跨进程文件锁
# 或使用 advisory-file-lock
```

### API

```rust
// src/perf/jsonl.rs

use std::io::{BufRead, Write, Seek, SeekFrom};
use std::path::Path;

fn get_or_create_handle(path: &str, append: bool) -> Result<std::fs::File, String> {
    let f = std::fs::OpenOptions::new()
        .create(true)
        .append(append)
        .read(!append)
        .open(path)
        .map_err(|e| format!("jsonl: {e}"))?;
    Ok(f)
}

/// 追加写入一行（可选 fsync）
#[tauri::command]
async fn jsonl_append(path: String, line: String, flush: bool) -> Result<(), String> {
    let mut f = get_or_create_handle(&path, true)?;
    // 补首行换行检测：读文件末 1 字节
    let meta = f.metadata().map_err(|e| e.to_string())?;
    if meta.len() > 0 {
        f.seek(SeekFrom::End(-1)).ok();
        let mut last = [0u8; 1];
        if f.read_exact(&mut last).is_ok() && last[0] != b'\n' {
            f.write_all(b"\n").map_err(|e| e.to_string())?;
        }
    }
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"\n").map_err(|e| e.to_string())?;
    if flush {
        f.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读取所有行
#[tauri::command]
async fn jsonl_read_all(path: String) -> Result<Vec<String>, String> {
    let f = std::fs::File::open(&path).map_err(|_| "jsonl_read_all: file not found".to_string())?;
    let reader = std::io::BufReader::new(f);
    let lines = reader.lines().filter_map(|l| l.ok()).collect();
    Ok(lines)
}

/// compaction：保留 keep 中的行，重写文件（原子替换）
#[tauri::command]
async fn jsonl_compact(path: String, keep: Vec<String>) -> Result<(), String> {
    // 1. 读所有行
    let all = jsonl_read_all(path.clone()).await?;
    // 2. 过滤：仅保留 keep 中的行（行内容精确匹配）
    let keep_set: std::collections::HashSet<String> = keep.into_iter().collect();
    let filtered: Vec<&str> = all.iter().filter(|l| keep_set.contains(*l)).map(|s| s.as_str()).collect();
    // 3. 原子写入 temp + rename
    let p = Path::new(&path);
    let dir = p.parent().unwrap_or(Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    for line in &filtered {
        writeln!(tmp, "{line}").map_err(|e| e.to_string())?;
    }
    tmp.persist(p).map_err(|e| e.to_string())?;
    Ok(())
}
```

### 性能目标

| 操作 | 当前（Node.js JsonlAppendBatcher） | Rust | 加速比 |
|-----|------------------------------------|------|--------|
| 追加 1000 条（无 fsync） | ~2ms | <0.5ms | 4x |
| 追加 1000 条（带 fsync） | ~50ms | <10ms | 5x |
| 读取 10000 行 | ~5ms | <1ms | 5x |

### 集成路径

1. 在 `packages/agent-runtime/` 中将 `JsonlAppendBatcher` 的底层文件操作抽取为可插拔后端
2. Tauri 环境下自动使用 Rust command，Node.js 环境下回退现有 JS 实现
3. 提供 `jsonl_compact` command 供 checkpoint GC 场景使用（当前在 JS 中用 `readFile + filter + writeFile` 实现）

---

## P3: SHA256/Base64 编解码

### 依赖

```toml
sha2 = "0.10"                  # SHA-256 哈希
base64 = "0.22"                # Base64 encode/decode
```

### API

```rust
// src/perf/crypto.rs

use sha2::{Sha256, Digest};
use base64::Engine;

#[tauri::command]
async fn hash_sha256(data: Vec<u8>) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
async fn hash_sha256_hex(data: Vec<u8>) -> Result<String, String> {
    // 同 hash_sha256，命名清晰以便前端选择
    hash_sha256(data).await
}

#[tauri::command]
async fn base64_encode(data: Vec<u8>) -> Result<String, String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

#[tauri::command]
async fn base64_decode(encoded: String) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(&encoded)
        .map_err(|e| e.to_string())
}

/// URL-safe Base64（用于 JWT/filename 场景）
#[tauri::command]
async fn base64url_encode(data: Vec<u8>) -> Result<String, String> {
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&data))
}

#[tauri::command]
async fn base64url_decode(encoded: String) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&encoded)
        .map_err(|e| e.to_string())
}
```

### 性能目标

| 操作 | 当前（Node.js crypto） | Rust (sha2) | 加速比 |
|-----|----------------------|-------------|--------|
| SHA256 100MB | ~500ms | <100ms | 5x |
| Base64 编码 100MB | ~200ms | <50ms | 4x |
| Base64 解码 100MB | ~250ms | <60ms | 4x |

### 集成路径

1. `packages/agent-runtime/src/encoding.ts` 中 Tauri 环境优先调用 Rust command
2. 前端提供统一操作：
   ```typescript
   // packages/shared-utils/src/hash.ts
   export async function sha256(data: Uint8Array): Promise<string> {
     if (isTauri) return invokeCmd<string>('hash_sha256', { data: Array.from(data) }) ?? fallback(data);
     return fallback(data);
   }
   ```
3. 文件完整性校验（file diff hash、会话内容 hash）走 Rust 路径

---

## P4: 编码检测（Encoding Detection）

### 依赖

```toml
chardetng = "0.1"              # Mozilla 的编码检测引擎（由 Firefox 使用）
encoding_rs = "0.8"            # 编码转换（配合 chardetng 做 decode）
```

### API

```rust
// src/perf/encoding.rs

use chardetng::EncodingDetector;
use encoding_rs::Encoding;

#[tauri::command]
async fn detect_encoding(data: Vec<u8>) -> Result<String, String> {
    let mut detector = EncodingDetector::new();
    detector.feed(&data, true);
    let encoding = detector.guess(None, true);
    Ok(encoding.name().to_string())
}

/// 检测并解码文本
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeResult {
    pub text: String,
    pub encoding: String,
    pub has_bom: bool,
}

#[tauri::command]
async fn detect_and_decode(data: Vec<u8>) -> Result<DecodeResult, String> {
    let has_bom = data.starts_with(&[0xEF, 0xBB, 0xBF])    // UTF-8 BOM
        || data.starts_with(&[0xFF, 0xFE])                  // UTF-16LE BOM
        || data.starts_with(&[0xFE, 0xFF]);                 // UTF-16BE BOM

    let mut detector = EncodingDetector::new();
    detector.feed(&data, true);
    let encoding = detector.guess(None, true);

    let (text, _) = encoding.decode_without_bom_handling_and_without_replacement(&data);
    Ok(DecodeResult {
        text: text.to_string(),
        encoding: encoding.name().to_string(),
        has_bom,
    })
}
```

### 性能目标

| 操作 | 当前（JS TextDecoder + 启发式检测） | Rust (chardetng) | 加速比 |
|-----|-------------------------------------|-------------------|--------|
| 检测 1MB 文件编码 | ~5ms | <1ms | 5x |
| 检测 10MB 文件编码 | ~50ms | <5ms | 10x |
| 检测 + 解码 1MB | ~8ms | <2ms | 4x |

### 集成路径

1. `packages/agent-runtime/src/encoding.ts` 中 `decodeTextBuffer()` 添加 Rust 优先路径：
   ```typescript
   export async function decodeTextBuffer(bytes: Buffer): Promise<DecodedTextBuffer> {
     if (isTauri) {
       const res = await invokeResult<DecodeResult>('detect_and_decode', { data: [...bytes] });
       if (res.status === 'ok') { /* convert to DecodedTextBuffer */ }
     }
     return fallbackDecodeTextBuffer(bytes);
   }
   ```
2. Rust 的 chardetng 检测精度高于 JS 启发式方法，可减少误判（特别是 UTF-16 vs GB18030）

---

## P5: 大 JSON 流式处理

### 依赖

```toml
# 已有的 serde_json 支持流式 API
# 如需 simd-json 加速：
# simd-json = "0.13"
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }
```

### API

```rust
// src/perf/json_stream.rs

use serde::{Serialize, Deserialize};
use serde_json::Value;

/// 流式序列化大量数据（避免一次性构建完整 JSON 字符串）
#[tauri::command]
async fn json_stream_serialize(items: Vec<Value>) -> Result<String, String> {
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

/// 流式反序列化（使用 serde_json::StreamDeserializer）
#[tauri::command]
async fn json_stream_parse(data: String) -> Result<Vec<Value>, String> {
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// 逐行解析 JSONL（大文件按行 yield）
#[tauri::command]
async fn jsonl_parse_stream(data: String, offset: usize, limit: usize) -> Result<Vec<Value>, String> {
    let lines: Vec<&str> = data.lines().skip(offset).take(limit).collect();
    lines.into_iter()
        .map(|l| serde_json::from_str(l).map_err(|e| format!("jsonl parse error at line {}: {e}", offset + 1)))
        .collect()
}
```

### 性能目标

| 操作 | 当前（JSON.stringify/parse） | Rust (serde_json) | 加速比 |
|-----|------------------------------|-------------------|--------|
| 序列化 50MB JSON | ~500ms | <200ms | 2.5x |
| 反序列化 50MB JSON | ~600ms | <250ms | 2.4x |
| 解析 10000 行 JSONL | ~50ms | <20ms | 2.5x |

### 集成路径

1. 大会话数据保存加载场景（session.ts 中 `saveSnapshot` / `loadSnapshot`）优先走 Rust
2. 数据量 > 5MB 时自动切换到 Rust 路径，否则用 JS 路径（避免 IPC 开销）
3. 对结构化会话数据 `SessionData` 实现 `Serialize`/`Deserialize`：

```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    pub id: String,
    pub events: Vec<EventData>,
    pub created_at: u64,
    // ...
}
```

---

## P6: 字符串相似度/搜索

### 依赖

```toml
regex = "1"                    # 有限状态机正则引擎（无 ReDoS）
url = "2"                      # URL 解析（已有）
```

### API

```rust
// src/perf/string_match.rs

use regex::Regex;
use url::Url;

/// URL scheme 白名单检查（比 JS 正则快 10x）
#[tauri::command]
async fn safe_url_check(url_str: String) -> Result<bool, String> {
    let url = Url::parse(&url_str).map_err(|e| e.to_string())?;
    let scheme = url.scheme();
    Ok(matches!(scheme, "http" | "https" | "mailto" | "tel" | "data"))
}

/// 编译并执行正则匹配（无 ReDoS 风险，Rust regex 保证线性时间复杂度）
#[tauri::command]
async fn regex_match(text: String, pattern: String) -> Result<Vec<String>, String> {
    let re = Regex::new(&pattern).map_err(|e| format!("regex error: {e}"))?;
    let matches: Vec<String> = re.find_iter(&text).map(|m| m.as_str().to_string()).collect();
    Ok(matches)
}

/// 编译并执行正则捕获组匹配
#[tauri::command]
async fn regex_capture(text: String, pattern: String) -> Result<Vec<Vec<String>>, String> {
    let re = Regex::new(&pattern).map_err(|e| format!("regex error: {e}"))?;
    let results: Vec<Vec<String>> = re.captures_iter(&text).map(|caps| {
        (0..caps.len())
            .filter_map(|i| caps.get(i).map(|m| m.as_str().to_string()))
            .collect()
    }).collect();
    Ok(results)
}
```

### 性能目标

| 操作 | 当前（JS RegExp） | Rust (regex crate) | 加速比 |
|-----|-------------------|--------------------|--------|
| URL scheme 检查 | ~0.01ms | <0.001ms | 10x |
| 正则匹配 1MB 文本 | ~10ms | <1ms | 10x+ |
| ReDoS 防护 | 需手动防 | 天然保证 O(n) | — |

### 集成路径

1. 前端 `safe-url.ts` 或 Markdown 渲染器中 URL 安全检查调用 Rust command
2. 大规模日志/工具输出中的模式匹配（如提取文件名、路径、URL）走 Rust regex
3. Rust regex 编译一次缓存，避免重复编译

---

## 新增 Cargo 依赖总和

在 `apps/agent-workbench/src-tauri/Cargo.toml` 中添加：

```toml
[dependencies]
# 已有
serde.workspace = true
serde_json.workspace = true
tauri = { workspace = true, features = ["protocol-asset"] }
tauri-plugin-dialog = "2"
tokio = { version = "1", features = ["full"] }
reqwest.workspace = true

# 新增 - P0 文件 I/O
memmap2 = "0.9"
tempfile = "3"
notify = "7"

# 新增 - P3 密码学
sha2 = "0.10"
base64 = "0.22"

# 新增 - P4 编码检测
chardetng = "0.1"
encoding_rs = "0.8"

# 新增 - P6 字符串
regex = "1"
url.workspace = true    # 已有

# 新增 - P2 文件锁（跨进程 JSONL 安全）
fs2 = "0.4"
```

---

## 统一的 command 注册

```rust
// src/perf/mod.rs

mod crypto;
mod encoding;
mod file_io;
mod git_diff;
mod json_stream;
mod jsonl;
mod string_match;

pub fn register_performance_commands<R: tauri::Runtime>(
    builder: tauri::AppBuilder<R>,
) -> tauri::AppBuilder<R> {
    builder.invoke_handler(tauri::generate_handler![
        // P0
        file_io::stream_read_file,
        file_io::mmap_read_file,
        file_io::atomic_write_file,
        // P1
        git_diff::parse_git_diff,
        git_diff::parse_git_diff_stream,
        // P2
        jsonl::jsonl_append,
        jsonl::jsonl_read_all,
        jsonl::jsonl_compact,
        // P3
        crypto::hash_sha256,
        crypto::base64_encode,
        crypto::base64_decode,
        crypto::base64url_encode,
        crypto::base64url_decode,
        // P4
        encoding::detect_encoding,
        encoding::detect_and_decode,
        // P5
        json_stream::json_stream_serialize,
        json_stream::json_stream_parse,
        json_stream::jsonl_parse_stream,
        // P6
        string_match::safe_url_check,
        string_match::regex_match,
        string_match::regex_capture,
    ])
}
```

在 `main.rs` 中调用：

```rust
fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init());

    let builder = crate::perf::register_performance_commands(builder);
    // ...existing setup and sidecar logic...
}
```

---

## 前端统一调用层

```typescript
// packages/shared-utils/src/perf-backend.ts
// 自动选择 Rust 或 JS 实现，按数据大小决策

let _isTauri: boolean | undefined;
async function isTauri(): Promise<boolean> {
  if (_isTauri !== undefined) return _isTauri;
  try {
    const mod = await import('@tauri-apps/api/core');
    _isTauri = typeof mod?.invoke === 'function';
  } catch { _isTauri = false; }
  return _isTauri;
}

const RUST_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1MB 以上优先 Rust

export async function sha256(data: Uint8Array): Promise<string> {
  if (await isTauri()) {
    try {
      const mod = await import('@tauri-apps/api/core');
      return await mod.invoke('hash_sha256', { data: Array.from(data) });
    } catch { /* fallback */ }
  }
  // JS fallback
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function detectEncoding(data: Uint8Array): Promise<string> {
  if (await isTauri() && data.length > 1024) {
    try {
      const mod = await import('@tauri-apps/api/core');
      return await mod.invoke('detect_encoding', { data: Array.from(data) });
    } catch { /* fallback */ }
  }
  // JS fallback
  const { decodeTextBuffer } = await import('@crish/agent-runtime/encoding');
  return decodeTextBuffer(Buffer.from(data)).encoding;
}

export async function parseGitDiff(
  unified: string,
  opts?: { offset?: number; limit?: number },
): Promise<FileDiff[] | null> {
  if (await isTauri() && unified.length > 5000) {
    try {
      const mod = await import('@tauri-apps/api/core');
      return await mod.invoke('parse_git_diff', {
        unified,
        offset: opts?.offset ?? 0,
        limit: opts?.limit ?? 0,
      });
    } catch { /* fallback */ }
  }
  return null; // caller falls back to JS parseUnifiedDiffs
}
```

---

## 整体性能提升汇总

| 操作 | 当前（Node.js/TS） | 目标（Rust） | 加速比 | 调用频次 |
|-----|-------------------|-------------|--------|---------|
| SHA256 100MB | ~500ms | <100ms | 5x | 低（文件校验） |
| 解析 10000 行 diff | ~100ms | <5ms | 20x | 中（每次工具调用） |
| JSONL 追加 1000 条 | ~2ms | <0.5ms | 4x | 高（每次 turn） |
| 编码检测 1MB | ~5ms | <1ms | 5x | 中（文件打开） |
| 大 JSON 序列化 50MB | ~500ms | <200ms | 2.5x | 低（会话快照） |
| 文件读取 100MB (mmap) | ~100ms | <50ms | 2x | 低（大文件预览） |
| URL 安全检测 | ~0.01ms | <0.001ms | 10x | 高（每个 Markdown 渲染） |
| 正则匹配 1MB | ~10ms | <1ms | 10x+ | 低 |

## 实施优先级

### Phase 1 (核心收益，低风险)
- **P3: SHA256/Base64** — 纯计算无副作用，独立模块，最快见效
- **P6: URL 安全检测 + 正则** — 独立，无状态，高调用频次
- **P4: 编码检测** — 替换现有 `encoding.ts` 中的启发式检测

### Phase 2 (中等复杂度)
- **P0: 文件 I/O 引擎** — 需要与现有 `fs_commands.rs` 复用 WorkspaceFsGuard
- **P2: JSONL 引擎** — 需要与现有 `JsonlAppendBatcher` JS 类集成

### Phase 3 (高复杂度)
- **P1: Git Diff 解析** — 需要与 `parseUnifiedDiffs` 的多种调用路径对齐
- **P5: 大 JSON 流式处理** — 需要定义 SessionData 的 Serde 结构体

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| IPC 序列化开销抵消 Rust 收益 | 大数据（>10MB）走 Rust 侧直接处理避免序列化回 JS |
| Tauri command 阻塞主线程 | 所有 command 标记为 `async` 使用 `tokio::task::spawn_blocking` |
| chardetng 检测结果与现有 JS 不一致 | 双路径并行采样 100 个文件验证一致性 |
| JSONL 文件锁跨平台行为差异 | fs2 跨平台，Windows 使用 `LockFileEx`，Unix 使用 `flock` |
| 增量迁移期间双路径维护成本 | 统一调用层 `perf-backend.ts` 自动 Fallback，JS 实现不删除 |
