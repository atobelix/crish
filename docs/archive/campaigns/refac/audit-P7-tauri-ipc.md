# Audit: 第七部分 Tauri IPC 与 Sidecar 连接稳定性

> 审计依据：`docs/refac/refactor_plan.md:872-920`
>
> 审计范围：7.1 Sidecar 连接世代计数竞态 / 7.2 编码检测 chardetng 调用性能开销 / 7.3 SSE 帧 Buffer 超限优雅处理
>
> 审计日期：2026-07-23

---

## 7.1 Sidecar 连接世代计数竞态

### 7.1.1 当前实现审计

**文件**：`apps/agent-workbench/src-tauri/src/sidecar/types.rs`

| 符号 | 类型 | 行号 |
|---|---|---|
| `SIDECAR_CONNECTION_GENERATION` | `AtomicU64` | 186 |
| `next_connection_generation()` | `fetch_add(1, Ordering::Relaxed)` | 239-241 |
| `SidecarConnection.generation` | `u64` | 106 |
| `SidecarSender.generation` | `u64` | 112 |

**关键路径**：

1. `connection.rs:684` — 调用 `next_connection_generation()` 获取新 generation
2. `connection.rs:734` — 传入 `connect_sidecar_websocket(app, generation, port)` 建立 WebSocket
3. `connection.rs:846-876` — writer task 捕获 `writer_generation`，断线时调 `disconnect_sidecar_generation(writer_generation, ...)`
4. `connection.rs:896-948` — reader task 捕获 `reader_generation`，断线时调 `disconnect_sidecar_generation(reader_generation, ...)`
5. `connection.rs:399-411` — `disconnect_sidecar_generation` 执行：`if guard.as_ref().is_some_and(|sidecar| sidecar.generation == generation) { *guard = None; }`

**竞态分析**：

原方案（`Ordering::Relaxed` + `u64` 自增）的核心问题不是 generation 取值阶段的原子性——`AtomicU64::fetch_add` 本身就是原子的。真正的竞态在 卸载/重连 的时序上：

```
时间线 T：
  T0: Generation=1 连接建立，reader task 持有 reader_generation=1
  T1: WebSocket 断线，reader task 开始执行 disconnect_sidecar_generation(1, ...)
  T2: 调度器 切换，reader task 未立即执行
  T3: 启动重连成功，Generation=2 连接建立，SidecarConnection 被替换为 generation=2
  T4: reader task 恢复执行，disconnect_sidecar_generation(1, ...) 拿到锁
      → 检查 sidecar.generation (现在是 2) == 1 → false，什么都不做
      → ✅ 正确，不会误杀新连接
```

但危险场景是反过来的：

```
  T0: Generation=1 连接建立
  T1: WebSocket 断线，重连启动
  T2: Generation=2 连接建立，SidecarConnection 被替换为 generation=2
  T3: Generation=2 的 writer task 启动，但还未进入 select! 循环
  T4: Generation=1 的 writer task 延迟执行 disconnect_sidecar_generation(1, ...)  — 此时 sidecar.generation==2，不匹配 → 无事
  T5: Generation=2 的 writer task 进入循环后断线，调用 disconnect_sidecar_generation(2, ...)
      → 此时若 Generation=3 已建立 → 同样安全
```

**结论**：当前 `u64` 世代计数在**功能上是正确的**，不存在"旧连接事件被新连接错误处理"的竞态。`disconnect_sidecar_generation` 的精确相等比较已经避免了误杀。真正的问题是：

1. **单调递增永不重置**：`AtomicU64` 在进程生命周期内永不归零，长时间运行可能出现 web 级的绕回（2^64 实际不可能，但语义上不安全）。
2. **`Ordering::Relaxed` 问题**：虽然 `fetch_add` 原子性没问题，但其他与 generation 相关的加载/存储未用 `Acquire`/`Release`，在弱内存序架构（ARM）上可能出现 reader 看到 stale 值。
3. **缺乏会话身份验证**：generation 只是一个序号，客户端可以伪造。如果 sidecar 协议对外开放（例如支持远程调试），攻击者可构造任意 generation 来干扰连接管理。

### 7.1.2 原方案评审：`ConnectionToken` (UUID+时间戳复合键)

原方案提议：

```rust
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ConnectionToken {
    pub session: uuid::Uuid,
    pub connected_at: std::time::SystemTime,
}
```

**优点**：
- UUID 不可预测，防止伪造
- 时间戳可做过期判断、调试追踪
- `Hash` + `Eq` 可直接用于 `HashMap` 查找

**问题**：
1. **未实现 `Serialize`/`Deserialize`** — 必须序列化才能通过 WebSocket 发送给 daemon/client。`SystemTime` 的 serde 实现不是默认的，需要 `serde` feature 或自定义。
2. **数据量大**：`Uuid`（16 字节）+ `SystemTime`（可能的 12 字节）+ 序列化开销 → 每次消息多 30-60 字节。对高频小消息场景有影响。
3. **`SystemTime` 的可靠比较**：`SystemTime` 可能因 NTP 调整而回拨，导致 `connected_at` 比较不可靠。用 `Instant` 更合适，但 `Instant` 不可序列化。
4. **服务端需要维护活跃 Token 集合**：如果 daemon（服务端）需要对每个消息验证 Token，则需要维护一个 `HashSet<ConnectionToken>`，增加了内存和查找开销。

### 7.1.3 改进方案（审计建议）

#### 方案 A（推荐）：引入 `ConnectionId` 包装类型 + 内存序修复

```rust
/// A non-forgeable connection identifier.
///
/// Layout: [8 bytes timestamp_ms][8 bytes random]
/// Total: 16 bytes, comparable, serializable, unforgeable.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionId(u64, u64);

impl ConnectionId {
    pub fn new() -> Self {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let rand = thread_rng().next_u64();
        Self(ts, rand)
    }
}
```

此方案：
- 16 字节，与 UUID 等大，但 Wire 格式为 `[u64; 2]`，序列化极简
- 组合时间戳+随机数，碰撞概率可以忽略（2^64 空间）
- 不需要服务端维护集合；每个消息携带 Token，接收端直接比较
- `Serialize`/`Deserialize` 用 `#[serde(transparent)]` 直接输出 `[u64, u64]`

#### 方案 B（轻量改进）：保留 `u64`，改为 `AtomicU64` + 启动随机种子

```rust
static SIDECAR_CONNECTION_GENERATION: AtomicU64 = AtomicU64::new(rand::thread_rng().next_u64());
```

- 解决绕回预测问题
- 保留 `u64` 的简单比较
- 不增加消息大小
- 不解决伪造问题

**综合建议**：采用方案 A。对 `connection.rs:399` 的 `disconnect_sidecar_generation` 改为 `disconnect_sidecar_connection(conn_id)`，签名从 `u64` 改为 `ConnectionId`，所有引用处同步更新。

#### 额外修复：内存序

`types.rs:239-241` 中 `Ordering::Relaxed` 应改为 `Ordering::SeqCst`：

```rust
pub(crate) fn next_connection_generation() -> u64 {
    SIDECAR_CONNECTION_GENERATION.fetch_add(1, Ordering::SeqCst)
}
```

或在改用 `ConnectionId` 后完全消除该原子变量。

### 7.1.4 `ConnectionToken`/`ConnectionId` 的序列化/反序列化场景

| 场景 | 方向 | 说明 |
|---|---|---|
| WebSocket 握手 | Daemon → Client | 连接建立时，daemon 在 ready frame 中发送 Token。格式应为 JSON 字符串或数组。 |
| 客户端消息头 | Client → Daemon | 每条消息（request/command/event）携带 Token 作为元数据字段。 |
| Supervisor 快照 | 内部 | `SidecarSupervisorSnapshot.generation` 应改为 `ConnectionId`，便于诊断。 |
| RunStream 恢复 | 内部 | `RunStreamRecoveryState.disconnected_generation` 应改为 `ConnectionId`。 |
| 诊断日志 | 内部 | `SidecarCommandDiagnostic`、`RunStreamRecoveryDiagnostic` 中的 `generation` 改为 `ConnectionId`。 |
| Tauri 前端事件 | Rust → Frontend | `disconnect` 事件负载中的 `generation` 字段需同步更新。 |

**序列化格式设计**：

```rust
// 内部内存布局
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnectionId(u64, u64);  // (timestamp_ms, random)

// JSON wire format: [1732233600000, 987654321]
impl Serialize for ConnectionId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: Serializer {
        [self.0, self.1].serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ConnectionId { /* 对称反解 */ }
```

---

## 7.2 编码检测 `chardetng` 调用性能开销

### 7.2.1 当前实现审计

**文件**：`apps/agent-workbench/src-tauri/src/perf/encoding.rs`

**关键路径**：

1. `perf_encoding_detect`（行 90-93）— Tauri command，每次调用都会：
   - 从 JS 接收 `Vec<u8>`（全量文件数据）
   - 调用 `detect_encoding`（行 18-38）
   - `detect_encoding` 内部：先 BOM 匹配（行 58-65）；失败则创建 `EncodingDetector::new()` + `detector.feed(data, true)` + `detector.guess_assess(None, true)`

2. `perf_encoding_decode`（行 100-106）— 若无 `encoding_hint`，调用 `detect_encoding` 内部做全量检测。

**性能瓶颈**：

- `EncodingDetector::new()` 分配内部状态（约 4KB 缓冲区 + 概率模型表）
- `detector.feed(data, true)` 扫描至少 `data.len()` 字节（上限由 JS 端控制，但通常是整个文件）
- `detector.guess_assess(None, true)` 做统计学分析
- **每次 Tauri invoke 传递 `Vec<u8>` 已有一次跨 FFI 拷贝的开销**，叠加 chardetng 的扫描使成本加倍

**当前调用模式**：

- `agent-workbench/src/shared/perf-backend.ts:385-391` — `detectEncoding` 方法
- `crish-desktop/src/api/perf-backend.ts:96-122` — `detectEncoding` 方法
- 前端在"批量读取源代码目录"场景下，对每个文件都会调一次 detect/decode

### 7.2.2 原方案评审：LRU 缓存 1000 条

原方案提议基于 `(文件路径, mtime)` 的 LRU 缓存，上限 1000 条。

**LRU 1000 条评估**：

- 每条缓存约 100-200 字节（路径 ~200B + mtime ~8B + encoding label ~20B + flags ~4B）→ 总计约 200KB
- 1000 条对于"读取源代码目录"场景通常够用（Linux 内核源码约 70K 文件，1000 是 1.4%）
- 实际操作中，用户很少一次性打开超过 1000 个文件

**问题**：

1. **mtime 粒度问题**：`std::fs::Metadata::modified()` 在某些文件系统（FAT32、旧版 SMB）上精度仅 2 秒。如果在 2 秒内修改文件并重新检测，缓存可能返回过时结果。
2. **文件重命名**：文件路径变了但内容没变，应重新检测。LRU key 是路径，重命名后旧缓存失效 → 正确。
3. **硬链接**：同一 inode 不同路径，当前方案会各自缓存，浪费空间。可通过 `(device, inode)` 消重，但在跨平台（wasm 不支持 stat）的场景下不可行。
4. **无主动失效机制**：文件在 IDE 中被编辑保存后，若前端不主动调用 invalidation API，缓存只会因 LRU 淘汰被动失效。

### 7.2.3 改进方案

#### 核心设计

```rust
use std::path::PathBuf;
use std::time::SystemTime;
use lru::LruCache;
use std::num::NonZeroUsize;

pub(crate) struct EncodingCache {
    inner: Mutex<LruCache<CacheKey, CachedEntry>>,
}

#[derive(Hash, PartialEq, Eq, Clone)]
struct CacheKey {
    path: PathBuf,
    mtime_s: i64,        // 秒级 mtime（消除亚秒抖动）
}

struct CachedEntry {
    encoding: String,
    confidence: f32,
    has_bom: bool,
    mtime_ns: i64,       // 纳秒级用于精确校验
    cached_at: SystemTime,
}
```

#### 关键改进点（vs 原方案）

**1. mtime 秒级取整 + 纳秒级二次校验**：

```rust
fn make_key(path: &Path) -> Option<(i64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let duration = mtime.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    let secs = duration.as_secs() as i64;
    let nanos = duration.subsec_nanos() as i64;
    Some((secs, nanos))
}
```

- Key 使用 `mtime_s` 做 `Hash`（秒级），避免纳秒抖动导致缓存 miss
- Entry 内保留 `mtime_ns`，命中后二次校验，确保文件内容确实未变

**2. 显式 Invalidation API**：

```rust
#[tauri::command]
pub(crate) fn perf_encoding_invalidate_cache(paths: Vec<String>) {
    let mut cache = ENCODING_CACHE.inner.lock();
    for path in &paths {
        let key = CacheKey::from_path_str(path);
        cache.pop(&key);
    }
}
```

前端在文件保存后调此 API，主动清除对应缓存。

也可扩展为：

```rust
#[tauri::command]
pub(crate) fn perf_encoding_invalidate_all() { /* clear entire cache */ }
```

**3. 缓存容量调优**：`max(1000, max(500, estimate_file_count / 2))`

不硬编码 1000，改为根据场景动态：

```rust
pub(crate) fn with_encoding_cache<T>(f: impl FnOnce(&mut LruCache<...>) -> T) -> T {
    let mut cache = ENCODING_CACHE.inner.lock();
    let target_size = estimate_active_file_count();
    cache.resize(NonZeroUsize::new(target_size.max(500)).unwrap());
    f(&mut *cache)
}
```

但此方案复杂度过高，**建议仍使用固定 2000 条**（较原方案翻倍），因为：
- `LruCache` 按路径哈希索引，路径平均 ~200B → 2000 条 ~400KB，仍可接受
- 用户目录通常不超过 2000 个文件同时打开

**4. 缓存 warmup（可选增强）**：

```rust
pub(crate) fn perf_encoding_cache_warmup(paths: Vec<String>) {
    // 后台线程预检测, 填充缓存
    tokio::spawn(async move {
        for chunk in paths.chunks(50) {
            let mut cache = ENCODING_CACHE.inner.lock();
            for path in chunk {
                if /* cache miss */ {
                    drop(cache);  // 暂时释放锁
                    let data = fs::read(path).ok();
                    let result = detect_encoding(&data);
                    cache = ENCODING_CACHE.inner.lock();
                    cache.put(key, result);
                }
            }
        }
    });
}
```

**5. 编码确实变了怎么办？—— Invalidation 策略完整设计**

| 触发条件 | 策略 | 实现方式 |
|---|---|---|
| 用户保存文件（IDE 内） | 立即逐出 | 前端调用 `perf_encoding_invalidateCache([path])` |
| 文件 mtime 变化（前台检测时发现） | 自动更新 | 缓存命中后发现 `mtime != current_mtime`，逐出并重新检测（不在原 key 上 in-place 更新，避免 ABA 问题） |
| 文件重命名 | 自动失效 | 旧路径 key 永不再被查询，自然 LRU 淘汰 |
| 目录整体变更（git checkout、批量导入） | 批量失效 | 前端调 `perf_encoding_invalidateCache(paths[])` |
| 检测结果置信度低（`confidence < 0.7`） | 不缓存 | 仅在 `confidence >= 0.7` 时写入缓存，避免缓存误判结果 |
| 周期性全量失效（TTL） | 可选，建议不实现 | 编码检测结果不像凭据有安全 TTL 需求，不需要时间基失效 |

**最终缓存插入点修改** (`encoding.rs:18`)：

```rust
fn detect_encoding(data: &[u8]) -> EncodingDetectResult {
    if let Some(bom_enc) = detect_bom(data) {
        // BOM 结果总是写入缓存
        return EncodingDetectResult { ... };
    }
    // non-BOM: 仅在置信度 >= 0.7 时缓存
    // 由调用方（perf_encoding_detect）决定是否缓存
    ...
}
```

### 7.2.4 缓存命中的非功能指标

| 指标 | 预期值 |
|---|---|
| 单次 `chardetng` 调用延迟 | ~50-200μs（4096 字节样本） |
| 缓存命中延迟 | ~1μs（HashMap lookup） |
| 1000 次编码检测（缓存全部 miss） | ~100ms |
| 1000 次编码检测（缓存全部 hit） | ~1ms |
| 1000 条缓存内存占用 | ~200KB |
| 建议容量 | 2000 条（~400KB） |

---

## 7.3 SSE 帧 Buffer 超限优雅处理

### 7.3.1 当前实现审计

**文件**：`crates/conex-stream/src/parser/sse.rs`

**关键代码**：

```rust
// sse.rs:52-54
if self.buffer.len() > MAX_FRAME_SIZE {
    return Err(StreamError::FrameTooLarge { size: self.buffer.len() });
}
```

**传播链**：

1. `sse.rs:53` — `SseFrameParser::feed_bytes` 返回 `Err(StreamError::FrameTooLarge { size })`
2. `anthropic.rs:353` — `self.sse.feed_bytes(frame)?` — 使用 `?` 向上传播
3. `openai_chat.rs:267` — 同上
4. `gemini.rs:196` — 同上
5. `mod.rs:107` — `StreamError::FrameTooLarge { size: usize }` 定义
6. 最终由调用 `StreamParser::feed()` 的上层循环处理

**上游处理的查询**：

`StreamError` 最终由 Tauri command 或 stream consumer 的 `main_loop` 处理。通常模式是：

```rust
// pseudocode: 上层消费循环
loop {
    match parser.feed(&chunk) {
        Ok(events) => process_events(events),
        Err(e) => {
            emit_error(e);
            break;  // 断流！
        }
    }
}
```

**问题**：任何 `FrameTooLarge` 都会导致 `break`，关闭整个 SSE 流。

### 7.3.2 原方案评审："跳过并记录" + `FrameSkipped` 事件

原方案提议：
1. 改为跳过超大帧而非中断连接
2. 发送 `FrameSkipped` 特殊事件通知上层
3. 上层的 `ToolAccumulator` 收到 `FrameSkipped` 后，将该帧对应的 Tool Call 标记为 `incomplete`，触发流恢复或降级处理

**问题 1：`FrameSkipped` 事件不存在于 `StreamEvent` 枚举中**

`mod.rs:19-76` 的 `StreamEvent` 枚举包含 `ToolCallBegin/ToolCallDelta/ToolCallEnd/Error/Stop` 等，但没有 `FrameSkipped`。需要新增变体：

```rust
// 新增于 mod.rs
/// A frame was skipped due to exceeding buffer limits.
FrameSkipped {
    size: usize,
    limit: usize,
    /// The tool call ID that was being accumulated when the skip happened.
    affected_tool_call_id: Option<String>,
},
```

**问题 2：`SseFrameParser` 的 feed_bytes 签名限制**

当前 `feed_bytes` 返回 `Result<Vec<SseFrame>, StreamError>`。改为"跳过并记录"需要改变行为：

- 不能直接返回 `FrameSkipped`，因为此时还没有完整的 Frame 可以解析
- 需要在 buffer 超限时清空 buffer、跳过数据、继续解析后面的帧

```rust
pub fn feed_bytes(&mut self, bytes: &[u8]) -> Result<Vec<SseFrame>, StreamError> {
    self.buffer.extend_from_slice(bytes);

    let mut frames = Vec::new();
    loop {
        // ... boundary search ...

        let Some(end) = boundary else {
            // buffer 超限 → 跳过当前累积数据
            if self.buffer.len() > MAX_FRAME_SIZE {
                // 记录跳过后清空 buffer，继续解析后续数据
                let skipped_size = self.buffer.len();
                // 不能在此处插入 StreamEvent（feed_bytes 不知晓 ToolAccumulator）
                // 需要上层协作
                // ✅ 可以返回一个特殊帧来传递此信息
                frames.push(SseFrame {
                    event: Some("__frame_skipped__".to_string()),
                    data: serde_json::json!({"size": skipped_size, "limit": MAX_FRAME_SIZE}).to_string(),
                });
                self.buffer.clear();
                continue;  // 继续解析（buffer 已清空，不会再次触发超限）
            }
            break;
        };

        // ... 正常帧解析 ...
    }
    Ok(frames)
}
```

**问题 2 继续：`SseFrameParser` 不应该注入业务语义**

`SseFrameParser` 是低级协议解析层，不应该知道 `FrameSkipped` 这样的高级事件。更好的设计：

```rust
// 在 sse.rs 新增
/// A parsed frame or a skip signal.
#[derive(Debug, Clone)]
pub enum SseOutput {
    Frame(SseFrame),
    BufferOverflow { size: usize, limit: usize },
}
```

`feed_bytes` 返回 `Result<Vec<SseOutput>, StreamError>`，其中 `Err` 仅用于不可恢复的错误（如 UTF-8 解码失败），`BufferOverflow` 成为普通输出。

然后在各 provider parser 中：

```rust
// anthropic.rs:353 修改
for output in self.sse.feed_bytes(frame)? {
    match output {
        SseOutput::Frame(sse_frame) => {
            self.process_frame(&sse_frame.data)?;
        }
        SseOutput::BufferOverflow { size, limit } => {
            self.events.push_back(StreamEvent::FrameSkipped {
                size, limit,
                affected_tool_call_id: self.current_tool_call_id(),
            });
        }
    }
}
```

**问题 3：`ToolAccumulator` 缺少 `incomplete` 标记**

当前 `ToolAccumulator` 只有 `start/append/finish` 三个操作，没有"标记为 incomplete"的接口。需要新增：

```rust
impl ToolAccumulator {
    /// Mark a tool call as incomplete (e.g., its frame was skipped).
    /// The tool call remains in the accumulator but will never receive more data.
    pub fn mark_incomplete(&mut self, key: &str) -> Result<(), String> {
        let entry = self.tools.get_mut(key)
            .ok_or_else(|| format!("Unknown tool key: {key}"))?;
        entry.provider_executed = true;  // or add a dedicated `incomplete: bool` field
        Ok(())
    }

    /// Finish a tool call as incomplete, returning partial arguments.
    pub fn finish_incomplete(&mut self, key: &str) -> Result<Option<ToolCallResult>, String> {
        let entry = self.tools.remove(key)
            .ok_or_else(|| format!("Unknown tool key: {key}"))?;
        // 即使参数不完整也返回，上层决定是重试还是降级
        let sanitized = sanitize_tool_json(&entry.arguments);
        let input = serde_json::from_str(&sanitized).unwrap_or(serde_json::Value::Null);
        Ok(Some(ToolCallResult {
            id: entry.id,
            tool_name: entry.name,
            arguments_text: entry.arguments,
            input,
            index: entry.index,
        }))
    }
}
```

### 7.3.3 改进后的完整处理流程

```
SSE chunk 到达
   ↓
SseFrameParser.feed_bytes()
   ├─ 正常帧 → SseOutput::Frame → 上游 parser → StreamEvent → 前端
   └─ buffer 超限 →
        SseOutput::BufferOverflow { size, limit }
        ↓
        AnthropicMessagesStreamParser.feed()
          ↓
        StreamEvent::FrameSkipped {
            size: 2097152,
            limit: 1048576,
            affected_tool_call_id: Some("toolu_abc123"),
        }
          ↓
        Tauri event emit ("workbench-run-event")
          ↓
        前端 StreamEventHandler
          ├─ 当前 tool call 标记为 incomplete
          ├─ 发送流恢复请求（run/recover）
          └─ 显示"部分 tool call 因数据过大被跳过"提示
```

### 7.3.4 关键修改清单

| 文件 | 修改 | 行号 |
|---|---|---|
| `crates/conex-stream/src/parser/sse.rs` | 新增 `SseOutput` 枚举；`feed_bytes` 返回类型由 `Result<Vec<SseFrame>, StreamError>` 改为 `Result<Vec<SseOutput>, StreamError>`；新增 `FrameTooLarge` 到 `SseOutput::BufferOverflow` 的跳过逻辑 | 39-78 |
| `crates/conex-stream/src/parser/mod.rs` | 新增 `StreamEvent::FrameSkipped` 变体 | 19-76 |
| `crates/conex-stream/src/parser/anthropic.rs` | `process_frame` 适配 `SseOutput`；处理 `BufferOverflow` 生成 `StreamEvent::FrameSkipped` | 353 |
| `crates/conex-stream/src/parser/openai_chat.rs` | 同上 | 267 |
| `crates/conex-stream/src/parser/gemini.rs` | 同上 | 196 |
| `crates/conex-stream/src/state/tool_accumulator.rs` | 新增 `mark_incomplete` 和 `finish_incomplete` 方法 | 41-152 |
| `apps/agent-workbench/src-tauri/src/sidecar/connection.rs` | WebSocket read loop 中添加 `StreamEvent::FrameSkipped` 的 emit 路径 | 896-948 |

---

## 总结：审计发现严重程度

| 编号 | 发现 | 严重程度 | 说明 |
|---|---|---|---|
| 7.1-A | `Ordering::Relaxed` 在 ARM 上的正确性 | 中 | x86 上无害，ARM（Apple Silicon 即将支持）上可能出 bug |
| 7.1-B | `ConnectionToken` 缺少 `Serialize`/`Deserialize` 设计 | 高 | 原方案未考虑 Wire 序列化，是无法落地的 |
| 7.1-C | `SystemTime` 因 NTP 不可靠 | 低 | 改用 `(timestamp_ms, random)` 复合方案解决 |
| 7.2-A | chardetng 每次新建 `EncodingDetector` | 中 | LRU 缓存可解决，但需补充 invalidation API |
| 7.2-B | 编码缓存无主动失效机制 | 中 | 需要新增 Tauri command |
| 7.2-C | 低置信度结果不应缓存 | 低 | 需在缓存写入前加 `confidence >= 0.7` 守卫 |
| 7.3-A | `FrameSkipped` 事件在代码中不存在 | 高 | 原方案是概念性的，需要完整新增 `StreamEvent` 变体 |
| 7.3-B | `SseFrameParser` 返回类型不支持 skip | 高 | 需改为 `Result<Vec<SseOutput>, StreamError>` |
| 7.3-C | `ToolAccumulator` 缺少 incomplete 支持 | 高 | 需要新增 `mark_incomplete` + `finish_incomplete` |
| 7.3-D | `StreamEvent::FrameSkipped` 在 connection.rs 中不可见 | 中 | 需要增加 emit 路径 |
