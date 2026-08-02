# Conex/Crish 计算层终极性能设计方案

> 基于代码盘点（shared-utils / agent-daemon / agent-runtime / agent-orchestrator）的完整性设计。

---

## A) Worker 池设计

### A1. 架构总览

```
┌──────────────────────────────────────────────────────┐
│                   WorkerPool                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ Worker 1 │  │ Worker 2 │  │ Worker 3 │  ...       │
│  │ (thread) │  │ (thread) │  │ (thread) │            │
│  └──────────┘  └──────────┘  └──────────┘            │
│  ┌──────────────────────────────────────────────────┐ │
│  │            RingBuffer<WorkItem>                  │ │
│  │  [P0]  [P1]  [P2]  [P3]  [P4]  [P5]  [P6] ...  │ │
│  └──────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────┐ │
│  │  DedupMap<sha256 → Promise<PendingWork>>         │ │
│  └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### A2. Worker 生命周期

```typescript
interface WorkerPoolConfig {
  minWorkers: number;  // max(1, cpuCores - 1)
  maxWorkers: number;  // cpuCores * 2
  idleTimeoutMs: number; // 60_000
  taskQueueCapacity: number; // 保守: 2048
  maxPayloadBytes: number;   // 序列化消息最大 32MB
}

type TaskPriority = 0 | 1 | 2 | 3;
// 0 = 用户交互 (immediate)
// 1 = 可见渲染 (markdown, diff highlight)
// 2 = 预加载 (checkpoint, git status)
// 3 = 后台同步 (event store flush, compaction)

interface WorkItem {
  id: string;
  type: 'cpu-bound' | 'io-bound' | 'hybrid';
  priority: TaskPriority;
  payload: unknown;
  transferable?: ArrayBuffer[];
  abortController: AbortController;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
  startedAt?: number;
}
```

#### 创建策略

```
启动时: 预创建 minWorkers 个 Worker
负载触发: 当 RingBuffer size > minWorkers * 4 时创建新 Worker（直到 maxWorkers）
回收: Worker 空闲超 idleTimeoutMs 时 terminate，保留至少 minWorkers
紧急: 所有 Worker 繁忙且队列 > 阈值时，短时突破 maxWorkers（弹性的 overflow workers）
```

#### 调度算法: 优先级注入式 Work Stealing

```
1. 每个 Worker 维护自己的 RingBuffer
2. 主调度器用「优先级桶」存储任务
3. 空闲 Worker 优先从自己的队列头部取任务
4. 队列空时从其他 Worker 尾部偷取最低优先级任务
5. 当高优任务 (P0/P1) 到达且所有 Worker 繁忙时：
   a. 从最忙 Worker 偷取其最低优任务挂起
   b. 插入高优任务
   c. 被挂起的任务后续重新排队
```

#### 取消机制

```typescript
// Worker 侧
self.onmessage = (e) => {
  const { id, payload, signal } = e.data;
  const abortHandler = () => { /* 清理中间状态 */ };
  signal.addEventListener('abort', abortHandler);
  
  executeTask(payload).finally(() => {
    signal.removeEventListener('abort', abortHandler);
  });
};

// 主线程侧
pool.cancelTask(taskId: string): boolean {
  const item = this.pendingTasks.find(t => t.id === taskId);
  if (item) {
    item.abortController.abort();
    this.removeFromQueue(item);
    return true;
  }
  // 已分发到 Worker：通过 MessageChannel 发送取消信号
  this.sendCancelToWorker(taskId);
  return false;
}
```

#### 任务路由规则

| 任务类型 | CPU-bound | I/O-bound | 路由目标 |
|---------|-----------|-----------|---------|
| SHA256 哈希 | yes | no | Worker / GPU |
| Markdown 渲染 | yes | no | Worker |
| Git diff 解析 | yes | no | Rust (Tauri) |
| JSON 序列化 | yes | no | Worker |
| base64 编解码 | yes | no | Worker / GPU |
| 文件读取 | no | yes | libuv 线程池 |
| 文件写入 | no | yes | libuv + batcher |
| WebSocket 消息 | no | yes | 主线程 |

### A3. 实现位置

`packages/shared-utils/src/worker-pool.ts` — 纯 Node.js 实现，使用 `worker_threads`。

---

## B) 计算去重方案

### B1. LRU 计算结果缓存

```typescript
class ComputationCache<K, V> {
  private cache: LruMap<K, CachedValue<V>>;
  private pending: Map<K, Promise<V>>; // 正在进行的计算

  constructor(capacity: number, ttlMs: number);
  
  async getOrCompute(
    key: K,
    compute: () => Promise<V>,
    signal?: AbortSignal
  ): Promise<V> {
    // 1. 命中缓存 → 返回
    const cached = this.cache.get(key);
    if (cached && !this.isExpired(cached)) return cached.value;
    
    // 2. 有相同 key 正在计算 → 等待同一 Promise
    const pending = this.pending.get(key);
    if (pending) return pending;
    
    // 3. 新建计算
    const promise = compute();
    this.pending.set(key, promise);
    try {
      const value = await promise;
      this.cache.set(key, { value, timestamp: Date.now() });
      return value;
    } finally {
      this.pending.delete(key);
    }
  }
}
```

### B2. 去重粒度

| 计算类型 | 缓存 key | TTL | 容量 |
|---------|---------|-----|------|
| Git diff 输出 | `sha256(cwd + paths + staged)` | 5s | 50 |
| Markdown → HTML | `sha256(markdown)` | 60s | 200 |
| SHA256 文件哈希 | `filePath + mtime + size` | 30s | 500 |
| JSON 解析 | `sha256(raw)` | 10s | 100 |
| 文件编码检测 | `filePath + firstBytes` | 300s | 200 |

### B3. 缓存层级

```
Memory (L1): LruMap, 最快, 容量最小
  ↓ miss
Tauri/Rust (L2): 通过命令查询 mmap'd index
  ↓ miss
全量计算 (L3): Worker pool
```

### B4. 实现位置

`packages/shared-utils/src/computation-cache.ts`

---

## C) GPU 加速方案

### C1. 平台检测流程

```typescript
async function detectGpuCapability(): Promise<GpuCapability> {
  // 1. WebGPU (Tauri webview)
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) return { level: 'webgpu', adapter };
  }
  
  // 2. Canvas 2D (用于图像缩放)
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    if (ctx) return { level: 'canvas-2d' };
  }
  
  // 3. WebGL (fallback)
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl');
    if (gl) return { level: 'webgl', gl };
  } catch {}
  
  // 4. 纯 CPU
  return { level: 'none' };
}
```

### C2. 双路径实现

```typescript
class Sha256Provider {
  // GPU 路径 (WebGPU)
  async hashViaWebGPU(data: Uint8Array): Promise<string> {
    const shader = `
      @group(0) @binding(0) var<storage, read> input: array<u32>;
      @group(0) @binding(1) var<storage, read_write> output: array<u32>;
      
      // WGSL SHA-256 实现
      // ...
    `;
    // ...
  }
  
  // CPU 路径 (Worker 线程池)
  async hashViaCpu(data: Uint8Array): Promise<string> {
    return this.workerPool.submitTask({
      type: 'cpu-bound',
      payload: { op: 'sha256', data },
    });
  }
  
  // 自适应路由
  async hash(data: Uint8Array): Promise<string> {
    if (data.length < 1024) return this.hashViaCpu(data); // 小数据 CPU 更快
    if (this.gpuLevel === 'webgpu') return this.hashViaWebGPU(data);
    return this.hashViaCpu(data);
  }
}
```

### C3. 适合 GPU 的计算

| 操作 | GPU 加速收益 | 小数据阈值 | 备注 |
|-----|------------|-----------|------|
| SHA256 | 3-10x | > 1MB | 大文件哈希显著加速 |
| base64 编解码 | 2-5x | > 512KB | 大文本编码 |
| 图像缩放 | 10-50x | 任何大小 | Canvas 2D 已足够 |
| 批量 JSON serialize | 1-3x | > 100KB | 收益有限 |

### C4. 实现位置

`packages/shared-utils/src/gpu/` — GPU 检测 + 各运算的 GPU 实现

---

## D) Rust 原生模块清单

### D1. 选择标准

| 标准 | 阈值 | 说明 |
|-----|------|------|
| 单次调用延迟 | >1ms | 高于此值值得用 Rust |
| 数据吞吐量 | >10MB | 流式处理 |
| CPU 密集 | 持续 >5ms | 避免阻塞主线程 |
| 系统调用密集 | 频繁 >100次/秒 | 如文件 stat |

### D2. 迁移清单

| # | 模块 | 当前实现 | Rust 优先级 | 理由 |
|---|------|---------|-----------|------|
| 1 | **Git diff 解析** | `child_process.spawn('git diff')` + JS 解析 stdout | **P0** | spawn 进程 5-20ms + 解析 1-10ms，高频调用 |
| 2 | **JSONL 读写** | Node.js `fs/promises` + 全量 parse | **P0** | event store / session store 核心路径，频繁 readAll |
| 3 | **SHA256 哈希** | `crypto.createHash('sha256')` | **P0** | 文件 + 消息哈希，检查点大量调用 |
| 4 | **base64 编解码** | `Buffer.toString('base64')` | **P1** | 频繁但不重；放到 P1 |
| 5 | **文件编码检测** | JS 启发式扫描 | **P1** | Rust 的 `charset`/`encoding_rs` 更准确更快 |
| 6 | **mmap file read** | `fs.readFile` 全量读入 | **P1** | Rust `memmap2` 实现零拷贝大文件读取 |
| 7 | **Checkpoint 打包** | JS 逐文件 read + write | **P2** | 可先用 Worker 优化，后期移 Rust |

### D3. Rust 模块接口示例

```rust
// packages/agent-runtime/native/src/lib.rs

#[tauri::command]
async fn native_git_diff(cwd: String, paths: Vec<String>, staged: bool) -> Result<GitDiffResult, String> {
    let output = Command::new("git")
        .args(["-C", &cwd, "diff"])
        .args(staged.then_some("--cached").into_iter())
        .args(&paths)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    
    let patch = String::from_utf8_lossy(&output.stdout).to_string();
    let stat = parse_diff_stat(&patch);
    let files = parse_name_status(&patch);
    
    Ok(GitDiffResult { patch, stat, files })
}

#[tauri::command]
async fn native_jsonl_read(file_path: String) -> Result<Vec<JsonValue>, String> {
    let file = File::open(&file_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if !line.trim().is_empty() {
            entries.push(serde_json::from_str::<JsonValue>(&line).map_err(|e| e.to_string())?);
        }
    }
    Ok(entries)
}

#[tauri::command]
async fn native_sha256_file(file_path: String) -> Result<String, String> {
    let mut file = File::open(&file_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
```

### D4. 集成方式

```
Node.js ↔ Tauri invoke ↔ Rust native module
         ↑
  通过 shared-types 定义接口协议
  错误码复用已有 error.ts 模式
  性能关键路径调用 Rust；非关键路径保持 JS
```

---

## E) 文件 I/O 终极方案

### E1. 当前问题

| 问题 | 位置 | 影响 |
|-----|------|------|
| `readFile()` 全量入内存 | checkpoints.ts, session.ts | 大文件 OOM |
| 无流式读取 | event-store.ts readAll | 事件日志全量 parse |
| 写路径手动 buffer | jsonl-append-batcher.ts | 已部分优化 |
| 无 mmap | 所有文件读取 | 大文件性能差 |

### E2. 流式文件读取

```typescript
class StreamingFileReader {
  private handle: FileHandle | undefined;
  private buffer: Buffer;
  private position: number = 0;
  
  constructor(path: string, options?: { highWaterMark?: number });
  
  async readNextBytes(size: number): Promise<Buffer | null>;
  async readLines(limit: number): Promise<string[]>;
  async pipeTo(writer: WritableStream, signal?: AbortSignal): Promise<void>;
  
  // 支持流式 JSONL 解析，不一次性加载全部
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    let remainder = '';
    while (true) {
      const chunk = await this.readNextBytes(65536);
      if (!chunk) break;
      const lines = (remainder + chunk.toString('utf8')).split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
    if (remainder.trim()) yield remainder;
  }
}
```

### E3. Mmap 大文件读取

```typescript
class MmapFileReader {
  private mapping: Buffer | null = null;
  private fd: number = -1;
  
  async open(path: string): Promise<void> {
    // Tauri invoke → Rust native_mmap_open
    // Rust 侧使用 memmap2 crate
  }
  
  readSlice(offset: number, length: number): Buffer {
    // 零拷贝：返回 mapping 的 subarray
    return this.mapping!.subarray(offset, offset + length);
  }
  
  close(): void {
    // munmap
  }
}
```

### E4. 分层写入策略

```
紧急写入 (用户操作, turn-end):
  writeFile + fsync (await)
  
批量写入 (事件流, session append):
  JsonlAppendBatcher → 累积 N 条或 T ms → 批量 write + fsync
  
后台刷盘 (checkpoint, 索引):
  低优先级 Worker → 后台 write + fsync（不阻塞主流程）
  
Write-ahead log (崩溃恢复):
  先写 WAL → 确认 → 更新数据文件 → 标记 WAL 完成
```

### E5. 文件监控

```typescript
// 平台自适应文件监视
class FileWatcher {
  private watcher: FSWatcher | null = null;
  
  watch(path: string, callback: (event: FileChangeEvent) => void): void {
    if (process.platform === 'win32') {
      // ReadDirectoryChangesW (Node.js fs.watch 已封装)
      this.watcher = fs.watch(path, { recursive: true }, callback);
    } else if (process.platform === 'darwin') {
      // FSEvents (使用 `fsevents` npm 包或 chokidar)
      this.watcher = chokidar.watch(path);
    } else {
      // inotify (fs.watch fallback)
      this.watcher = fs.watch(path, callback);
    }
  }
}
```

### E6. 实现位置

`packages/shared-utils/src/file/` — StreamingFileReader, MmapFileReader (通过 Tauri invoke), FileWatcher

---

## F) CPU 核心检测与自适应公式

### F1. 检测

```typescript
function detectCpuCores(): number {
  // Node.js 环境
  if (typeof require !== 'undefined') {
    const os = require('os');
    return os.cpus().length;
  }
  // Tauri webview 环境 (通过 Rust 暴露)
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency;
  }
  // 兜底
  return 4;
}
```

### F2. 自适应配置表

| CPU 核心数 | minWorkers | maxWorkers | LruCache 容量 | Diff 并行度 | 文件流式阈值 |
|-----------|-----------|-----------|--------------|------------|------------|
| 2 (旧双核) | 1 | 3 | 50 | 1 | 1MB |
| 4 (主流) | 3 | 8 | 200 | 2 | 5MB |
| 6 (中端) | 5 | 12 | 300 | 3 | 10MB |
| 8 (高端) | 7 | 16 | 500 | 4 | 20MB |
| 12+ (工作站) | 11 | 24 | 1000 | 6 | 50MB |
| 24+ (服务器) | 23 | 48 | 2000 | 8 | 100MB |

```typescript
function computeAdaptiveConfig(cpuCores: number): AdaptiveConfig {
  return {
    workerPool: {
      minWorkers: Math.max(1, cpuCores - 1),
      maxWorkers: cpuCores * 2,
    },
    lruCacheCapacity: Math.min(2000, Math.max(50, cpuCores * 60)),
    diffParallelism: Math.max(1, Math.floor(cpuCores / 2)),
    streamingThresholdMB: Math.min(100, Math.max(1, cpuCores * 2.5)),
    gpuEnabled: cpuCores <= 8, // 低核心数启用 GPU 补充
    ioConcurrency: Math.min(16, cpuCores * 2), // libuv 线程池并行度
  };
}
```

### F3. 运行时调整

```typescript
class AdaptiveCapacityManager {
  private config: AdaptiveConfig;
  private metrics: {
    avgWorkerUtilization: number;     // 最近 60s 平均 Worker 利用率
    avgQueueDepth: number;            // 平均队列深度
    avgTaskLatencyMs: number;         // 平均任务等待延迟
  };
  
  async adjust(): Promise<void> {
    if (this.metrics.avgQueueDepth > this.config.workerPool.maxWorkers * 2) {
      // 队列堆积：临时扩容
      this.config.workerPool.maxWorkers = Math.min(
        this.config.workerPool.maxWorkers + 2,
        os.cpus().length * 4
      );
    }
    if (this.metrics.avgWorkerUtilization < 0.3) {
      // 利用率低：缩容
      this.config.workerPool.maxWorkers = Math.max(
        this.config.workerPool.minWorkers,
        this.config.workerPool.maxWorkers - 1
      );
    }
    if (this.metrics.avgTaskLatencyMs > 100) {
      // 延迟过高：提升优先级注入频率
      this.config.injectionInterval = Math.max(1, this.config.injectionInterval - 1);
    }
  }
}
```

### F4. 实现位置

`packages/shared-utils/src/adaptive-capacity.ts`

---

## 实施路线图

### Phase 1 — 基础设施 (1-2 周)

```
1. WorkerPool 类 (worker-pool.ts) + 单元测试
2. ComputationCache (computation-cache.ts) + LruMap 增强
3. GPU 检测模块 (gpu/detect.ts)
4. 自适应配置 (adaptive-capacity.ts)
```

### Phase 2 — 文件 I/O 改造 (2-3 周)

```
1. StreamingFileReader 替换 event-store readAll
2. MmapFileReader 通过 Tauri invoke 调用 Rust
3. Checkpoint 流式读/写
4. 文件监视统一层
```

### Phase 3 — Rust 模块 (3-4 周)

```
1. git-diff 解析 Tauri command
2. jsonl-read/write Tauri command
3. sha256-file Tauri command
4. 编码检测 Tauri command
```

### Phase 4 — GPU 加速 (2-3 周)

```
1. WebGPU SHA256 shader
2. WebGPU base64 shader
3. Canvas 2D 图像缩放
4. 自适应路由 (GPU ↔ CPU ↔ Worker)
```

### Phase 5 — 集成与调优 (2 周)

```
1. AsyncMutex 统一替换所有手写 appendQueue
2. SessionRecorder 改用 WorkerPool append
3. 全面去重接入
4. 性能基准测试
```
