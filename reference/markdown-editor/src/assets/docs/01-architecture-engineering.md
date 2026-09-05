# 计算机科学与前沿系统架构示例集 (01-System-Architecture-Samples)

> 本文档为 Conex / Crish 混合渲染 Markdown 编辑器的核心基准示例库与高复杂度排版验证集。
> 涵盖分布式共识、高性能异步并发运行时、GPU 通用计算着色器、LSM-Tree 存储内核与 Linux 零拷贝网络等真实前沿技术架构。
> 所有排版元素均遵循基准垂直网格（`--grid-size: 28px`）与几何守恒（Geometric Conservation）律，彻底取代玩具代码与无意义占位符。

---

## 目录索引 (Architecture Table of Contents)

1. [分布式共识与高可用状态机复制 (Distributed Consensus & Multi-Raft)](#1-分布式共识与高可用状态机复制-distributed-consensus--multi-raft)
2. [高性能异步运行时与工作窃取调度器 (Rust Tokio Work-Stealing Runtime)](#2-高性能异步运行时与工作窃取调度器-rust-tokio-work-stealing-runtime)
3. [GPU 通用计算与着色器矩阵并行加速 (WebGPU & Compute Shader Pipeline)](#3-gpu-通用计算与着色器矩阵并行加速-webgpu--compute-shader-pipeline)
4. [高性能存储引擎与 LSM-Tree 级联压实 (Storage Engine & Compaction Dynamics)](#4-高性能存储引擎与-lsm-tree-级联压实-storage-engine--compaction-dynamics)
5. [Linux 内核异步 I/O 与零拷贝网络传输 (Kernel io_uring & eBPF Observability)](#5-linux-内核异步-io-与零拷贝网络传输-kernel-io_uring--ebpf-observability)
6. [28px 网格规范与排版几何守恒验证准则 (28px Baseline & Geometric Conservation)](#6-28px-网格规范与排版几何守恒验证准则-28px-baseline--geometric-conservation)

---

## 1. 分布式共识与高可用状态机复制 (Distributed Consensus & Multi-Raft)

在分布式键值存储与分布式事务内核中，多 Raft 组（Multi-Raft Groups）通过状态机复制（SMR, State Machine Replication）构建线性一致性（Linearizable Consistency）读写通路。

### 1.1 核心状态转移数学规约与不变式 (Invariants)

Raft 集群中任意任期（Term）$T$ 与日志槽位（Log Index）$I$ 必须严格满足以下偏序不变式：

1. **选举安全性 (Election Safety)**：在任意给定期限内，最多只允许一个 Leader 获得多数派 Quorum 裁决并当选。
2. **Leader 只追加原则 (Leader Append-Only)**：Leader 绝不覆写或截断自身日志，仅允许单向递增追加。
3. **日志匹配性 (Log Matching)**：若两份日志在 $(T_k, I_k)$ 具有相同任期与索引，则其在 $[0, I_k]$ 区间内的所有条目必须严格一致。

$$
\text{QuorumSize}(N) = \left\lfloor \frac{N}{2} \right\rfloor + 1 \quad \text{其中} \quad \sum_{i \in \text{Voters}} w_i \ge \text{Threshold}
$$

### 1.2 高危特殊字符与行内符号转义压力测试

行内代码必须能无损解析高危符号、正则元字符、嵌套尖括号泛型及位移操作，且垂直高度必须锁定于 28px 基准：

- 跨核原子比较交换：`atomic::compare_exchange_weak<LogEntry*>` 与内存序 `std::memory_order_acq_rel`
- 危险正则匹配与转义序列：`regex_replace(raw, r"(\\x1b\[[0-9;]*[mK])", "")`
- 结构体字面量位运算：`paxos_ballot_t{ .epoch = (u64)-1, .node_id = 0x7FFF_FFFF, .flags = (FLAG_SYNC | FLAG_BARRIER) }`
- 复杂借用切片与函数指针：`&mut [u8; 4096]`、`fn(&mut StateMachine, &[u8]) -> Result<Option<TxReceipt>, RaftError>`
- 复杂嵌套泛型映射：`Arc<RwLock<BTreeMap<LogIndex, (Term, Vec<u8>)>>>`
- 包含反斜杠与管道符号：`cat /var/log/raft.log | grep -E "^\[ERROR\]\|\[PANIC\]" | awk '{print $1, $4}'`

### 1.3 核心状态机驱动与日志应用 (Rust 实现)

以下是具备快照（Snapshot）流式处理与租约读（LeaseRead）检查的生产级 Rust 状态机应用核心实现：

```rust
// 01: Multi-Raft 核心日志应用与状态机推进逻辑
// 02: 保证无锁日志读取与批量持久化屏障
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerRole {
    Follower,
    Candidate,
    Leader { lease_deadline_ns: u64 },
    Learner,
}

#[derive(Debug)]
pub struct CommitEntry {
    pub index: u64,
    pub term: u64,
    pub payload: Vec<u8>,
    pub callback: Option<oneshot::Sender<Result<u64, RaftError>>>,
}

pub struct StateMachineDriver {
    applied_index: Arc<AtomicU64>,
    commit_rx: mpsc::Receiver<CommitEntry>,
    storage: Arc<dyn RaftStorageEngine + Send + Sync>,
}

impl StateMachineDriver {
    /// 批量应用已达成共识的提交日志条目 (Batch Apply)
    pub async fn run_apply_loop(mut self) -> Result<(), RaftError> {
        let mut buffer = Vec::with_capacity(256);
        
        while self.commit_rx.recv_many(&mut buffer, 256).await > 0 {
            let mut last_index = self.applied_index.load(Ordering::Acquire);
            
            for entry in buffer.drain(..) {
                if entry.index <= last_index {
                    // 幂等防卫：忽略已持久化状态机索引的重放条目
                    continue;
                }
                
                // 执行状态机状态转换
                let apply_result = self.storage.apply_command(entry.index, &entry.payload).await;
                
                if let Some(cb) = entry.callback {
                    let _ = cb.send(apply_result);
                }
                
                last_index = entry.index;
            }
            
            // 提交全局已生效位点并通知对端同步屏障
            self.applied_index.store(last_index, Ordering::Release);
            self.storage.flush_applied_barrier(last_index).await?;
        }
        
        Ok(())
    }
}
```

### 1.4 系统运行参数矩阵与生产状态标记

下表汇总 Multi-Raft 分布式一致性引擎的关键运行参数、度量基线与生命周期状态：

| 配置键名 (Configuration Key) | 默认推荐值 | 动态热加载 | 物理度量基准 | 当前生命周期状态 | 调优影响与备注说明 |
| :--------------------------- | :--------: | :--------: | :----------- | :--------------- | :----------------- |
| `raft.election-timeout-min` | `150ms` | ❌ 否 | 物理毫秒网格 | ==ACTIVE_PROD== | 避免跨可用区网络抖动造成脑裂重选 |
| `raft.election-timeout-max` | `300ms` | ❌ 否 | 物理毫秒网格 | ==ACTIVE_PROD== | 随机化去中心化打散探测周期 |
| `raft.max-batch-append-size` | `1024` | ✅ 是 | 内存槽位计数 | ==OPTIMIZED== | 单次批量网络包聚合最大阈值 |
| `raft.legacy-heartbeat-v1` | `50ms` | ❌ 否 | 时钟中断次数 | ~~deprecated~~ | 旧版单向轮询机制，已全面升级为事件驱动 |
| `raft.lease-read-duration` | `120ms` | ✅ 是 | 绝对单调时钟 | ==STABLE== | 依靠时钟同步免除状态机网络往返 RTT |
| `raft.snapshot-chunk-bytes` | `64MiB` | ✅ 是 | 连续物理内存 | ==EXPERIMENTAL== | 超大状态机压缩流式分片并发传输 |

> [!IMPORTANT]
> **脑裂防御与 Quorum 绝对隔离律**：
> 在出现网络分区（Network Partition）时，少数派分区必须在检测到连续心跳丢失后退化为 `PeerRole::Follower`，并坚决拒绝任何本地脏读（Dirty Read）。若未开启 `raft.lease-read-duration` 单调时钟校验，严禁执行本地读状态穿透！

> [!WARNING]
> **未持久化日志空洞腐败风险**：
> 当节点发生硬件断电或内核崩溃时，若 `fdatasync()` 在写入 WAL（Write-Ahead Logging）文件前返回，可能产生空洞日志。必须结合 CRC32C 校验和与日志头魔数 `0x52414654`（ASCII: RAFT）对连续性做刚性断言校验。

---

## 2. 高性能异步运行时与工作窃取调度器 (Rust Tokio Work-Stealing Runtime)

现代高性能网络服务器与异步系统核心依托双端无锁环形队列（Chase-Lev Work-Stealing Deque）实现任务均衡。

### 2.1 任务调度与多级工作窃取步骤模型

系统调度器的主处理循环包含严格的阶段规约：

1. **本地队列优先消费 (LIFO Hot Cache)**：
   - 优先尝试从本线程本地核心 `LocalRunQueue`（容量 256）弹出任务；
   - 保持 CPU L1/L2 Cache 局部性，减少上下文总线无效颠簸。
2. **全局溢出队列巡检 (Global FIFO Injector)**：
   - 每隔 61 次本地循环，强制从全局注入器获取 `GlobalInjectorQueue` 任务；
   - 避免全局任务发生极端饿死（Starvation Prevention）。
3. **跨核心窃取与指数退避 (Cross-Core Steal)**：
   - 当本地队列耗尽时，生成随机伪随机掩码（Fast-Random Mask）定位兄弟 Worker；
   - 使用原子 CAS 操作窃取目标队列一半（`len / 2`）的排队任务；
   - 连续失败时执行指数退避 `std::hint::spin_loop()` 与内核凭证让渡。

### 2.2 生产级协程调度状态追踪器 (Go 实现)

Go 运行时内部 P-M-G 模型调度与抢占观测工具实现：

```go
// 01: Go 运行时调度器 Goroutine 状态机与工作窃取模拟器
package scheduler

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
	"unsafe"
)

type GStatus uint32

const (
	GIdle      GStatus = iota // 0: 闲置状态
	GRunnable                 // 1: 位于就绪执行队列
	GRunning                  // 2: 正在物理线程 M 运行
	GSyscall                  // 3: 阻塞于内核系统调用
	GWaiting                  // 4: 阻塞于通道读写或锁竞争
	GDead                     // 5: 堆栈已回收
)

// G 代表轻量级逻辑执行单元
type G struct {
	ID        uint64
	Status    uint32 // 原子操作映射 GStatus
	StackBase uintptr
	SchedPC   uintptr
	Fn        func(ctx context.Context) error
}

// WorkQueue 采用环形缓冲区设计无锁窃取队列
type WorkQueue struct {
	head uint32
	tail uint32
	ring [256]*G
}

func (q *WorkQueue) Push(g *G) bool {
	h := atomic.LoadUint32(&q.head)
	t := q.tail
	if t-h >= 256 {
		return false // 本地队列溢出，需上交 Global Injector
	}
	slot := t & 255
	*(*unsafe.Pointer)(unsafe.Pointer(&q.ring[slot])) = unsafe.Pointer(g)
	atomic.StoreUint32(&q.tail, t+1)
	return true
}

func (q *WorkQueue) StealHalf(target *WorkQueue) int {
	// CAS 无锁环形批量窃取逻辑
	t := atomic.LoadUint32(&target.tail)
	h := atomic.LoadUint32(&target.head)
	count := int(t - h)
	if count <= 0 {
		return 0
	}
	stealCount := (count + 1) / 2
	// 内存屏障与批量迁移...
	return stealCount
}
```

### 2.3 调试快捷键与运行时环境变量配置

在桌面调试与生产追踪过程中，可通过以下快捷热键与环境变量精准控制运行时行为：

- 呼出异步任务火焰图抽样分析：按下 <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F12</kbd>
- 暂停指定 Worker 线程进行内存快照：按下 <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Break</kbd>
- 切换渲染视图与 28px 基线对齐参考网格：按下 <kbd>Cmd</kbd> + <kbd>Option</kbd> + <kbd>G</kbd>

```bash
# 环境变量配置示例：启用极致跟踪与内存调试
export RUST_LOG="tokio=trace,runtime::worker=debug,conex::editor=trace"
export TOKIO_WORKER_THREADS=16
export CRISH_AFFINITY_POLICY="L3_CACHE_LOCALITY"
export MALLOC_CONF="dirty_decay_ms:1000,muzzy_decay_ms:1000,background_thread:true"

# 启动性能剖析后台采集代理
perf record -F 997 -g --call-graph dwarf -p $(pgrep conex-engine) -- sleep 30
```

> [!NOTE]
> **NUMA 架构绑核优化要点**：
> 跨 CPU Socket 访问远程内存会导致访存延迟陡增约 $2.5\times$。生产环境建议通过 `hwloc` 或 `numactl --cpunodebind=0 --membind=0` 将异步 Worker 线程与内存分配绝对锁死于单一 NUMA 节点内部。

> [!TIP]
> **避免伪共享（False Sharing）陷阱**：
> 每个 Worker 线程本地持有的计数器变量（如 `steal_attempts`、`tasks_completed`）必须使用 `#[repr(align(64))]` 或 128 字节对齐，确保各线程的独立写操作落在互不重叠的 CPU 缓存行（Cache Line）上。

---

## 3. GPU 通用计算与着色器矩阵并行加速 (WebGPU & Compute Shader Pipeline)

在混合渲染编辑器与现代客户端架构中，大模型端侧推理与复杂几何矢量重排正迅速迁移至 WebGPU 计算着色器（Compute Shader）。

### 3.1 矩阵瓦片并行化与分块共享内存机制 (Tiled GEMM)

针对稠密矩阵乘法 $\mathbf{C} = \mathbf{A} \times \mathbf{B}$，通过将数据预加载入高速工作组共享内存（Workgroup Shared Memory），大幅降低对全局显存（VRAM）的高延迟读取：

$$
\mathbf{C}_{row, col} = \sum_{k=0}^{K-1} \mathbf{A}_{row, k} \cdot \mathbf{B}_{k, col}
$$

着色器工作组分配拓扑图如下：

- 工作组大小：`@workgroup_size(16, 16, 1)`（每个 Workgroup 包含 256 个并发硬件线程）
- 共享内存瓦片：`tileA[16][16]` 与 `tileB[16][16]` 占用 $16 \times 16 \times 4 = 1024$ 字节
- 硬件 SIMD 宽度（Subgroup / Warp）：32 线程同步

### 3.2 生产级 WGSL 计算着色器与 TypeScript 调用管线

```typescript
// 01: WebGPU 计算管线绑定与显存调度初始化
// 02: 保证与前端 60fps 渲染主循环完全异步解耦
export class GPUComputeDispatcher {
    private device!: GPUDevice;
    private pipeline!: GPUComputePipeline;

    public async initialize(shaderSource: string): Promise<void> {
        if (!navigator.gpu) {
            throw new Error("WebGPU 硬件抽象层不可用");
        }
        
        const adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance"
        });
        if (!adapter) throw new Error("无法初始化高性能物理 GPU 适配器");
        
        this.device = await adapter.requestDevice({
            requiredLimits: {
                maxComputeWorkgroupStorageSize: 32768,
                maxBufferSize: 1024 * 1024 * 1024 // 1GiB
            }
        });

        const shaderModule = this.device.createShaderModule({
            code: shaderSource
        });

        this.pipeline = await this.device.createComputePipelineAsync({
            layout: "auto",
            compute: {
                module: shaderModule,
                entryPoint: "main_gemm"
            }
        });
    }
}
```

```wgsl
// 01: WGSL (WebGPU Shading Language) 矩阵乘法分块计算着色器
// 02: 包含 Workgroup 屏障与无 bank conflict 共享内存访问

struct Uniforms {
    M: u32,
    N: u32,
    K: u32,
    alpha: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> matrixA: array<f32>;
@group(0) @binding(2) var<storage, read> matrixB: array<f32>;
@group(0) @binding(3) var<storage, read_write> matrixC: array<f32>;

const TILE_SIZE: u32 = 16u;
var<workgroup> tileA: array<array<f32, 16>, 16>;
var<workgroup> tileB: array<array<f32, 16>, 16>;

@compute @workgroup_size(16, 16, 1)
fn main_gemm(
    @builtin(global_invocation_id) global_id: vec3<u32>,
    @builtin(local_invocation_id) local_id: vec3<u32>,
    @builtin(workgroup_id) workgroup_id: vec3<u32>
) {
    let row = global_id.y;
    let col = global_id.x;
    var acc: f32 = 0.0;
    
    let numTiles = (u.K + TILE_SIZE - 1u) / TILE_SIZE;

    for (var t: u32 = 0u; t < numTiles; t = t + 1u) {
        let tiledColA = t * TILE_SIZE + local_id.x;
        if (row < u.M && tiledColA < u.K) {
            tileA[local_id.y][local_id.x] = matrixA[row * u.K + tiledColA];
        } else {
            tileA[local_id.y][local_id.x] = 0.0;
        }

        let tiledRowB = t * TILE_SIZE + local_id.y;
        if (col < u.N && tiledRowB < u.K) {
            tileB[local_id.y][local_id.x] = matrixB[tiledRowB * u.N + col];
        } else {
            tileB[local_id.y][local_id.x] = 0.0;
        }

        // 强制执行硬件级工作组屏障，确保共享显存数据同步
        workgroupBarrier();

        for (var k: u32 = 0u; k < TILE_SIZE; k = k + 1u) {
            acc = acc + tileA[local_id.y][k] * tileB[k][local_id.x];
        }

        workgroupBarrier();
    }

    if (row < u.M && col < u.N) {
        matrixC[row * u.N + col] = acc * u.alpha;
    }
}
```

---

## 4. 高性能存储引擎与 LSM-Tree 级联压实 (Storage Engine & Compaction Dynamics)

LSM-Tree（Log-Structured Merge-Tree）通过将随机写完全转化为顺序追加写，并在后台异步执行分层归并压实（Leveled Compaction），是现代大规模 KV 引擎（如 RocksDB / TiKV）的基石。

### 4.1 压实放大数学模型与性能演进

写入放大（Write Amplification Factor, WAF）定义为实际物理写盘数据量与逻辑用户写入数据量之比：

$$
\text{WAF}_{\text{leveled}} = 1 + \sum_{L=1}^{L_{\max}} T \approx 1 + L_{\max} \cdot T
$$

其中 $T \approx 10$ 为层级放大倍率（Level Multiplier），典型 6 层架构中 WAF 往往在 $15 \sim 30$ 之间波动。

- 传统更新方案：`~~In-Place B-Tree Update~~` —— 随机 I/O 导致 SSD 磨损加剧与严重写放大（~~deprecated~~）。
- 分层压实方案：`==Leveled Compaction Strategy==` —— 提供优异的点查性能与确定性空间占用（==RECOMMENDED==）。
- 大小阶梯压实：`==Size-Tiered Compaction Strategy==` —— 极致写入吞吐，但峰值需要预留 $50\%$ 空闲磁盘配额（==SPECIAL_PURPOSE==）。

### 4.2 存储引擎元数据与事务表定义 (SQL 模式)

```sql
-- 01: LSM-Tree 存储引擎 SSTable 层级元数据管理表
-- 02: 支持原子变更事务与 MVCC 版本追踪
CREATE TABLE IF NOT EXISTS engine_sstable_manifest (
    file_number     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    level           TINYINT UNSIGNED NOT NULL DEFAULT 0,
    smallest_key    VARBINARY(2048) NOT NULL,
    largest_key     VARBINARY(2048) NOT NULL,
    file_size_bytes BIGINT UNSIGNED NOT NULL,
    smallest_seqno  BIGINT UNSIGNED NOT NULL,
    largest_seqno   BIGINT UNSIGNED NOT NULL,
    creation_time   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    bloom_filter_len INT UNSIGNED NOT NULL,
    checksum_crc32c INT UNSIGNED NOT NULL,
    INDEX idx_level_keys (level, smallest_key(64), largest_key(64)),
    CONSTRAINT chk_level_range CHECK (level <= 7),
    CONSTRAINT chk_seqno_order CHECK (smallest_seqno <= largest_seqno)
) ENGINE=InnoDB ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8;

-- 03: 记录正在执行的后台归并压实事务状态 (Compaction Job Journal)
CREATE TABLE IF NOT EXISTS engine_compaction_journal (
    job_id          CHAR(36) NOT NULL PRIMARY KEY,
    source_level    TINYINT UNSIGNED NOT NULL,
    target_level    TINYINT UNSIGNED NOT NULL,
    input_files     JSON NOT NULL,
    output_files    JSON NULL,
    bytes_read      BIGINT UNSIGNED NOT NULL DEFAULT 0,
    bytes_written   BIGINT UNSIGNED NOT NULL DEFAULT 0,
    status          VARCHAR(32) NOT NULL DEFAULT 'IN_PROGRESS',
    started_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    completed_at    TIMESTAMP(3) NULL,
    error_message   TEXT NULL,
    INDEX idx_compaction_status (status, started_at)
);
```

### 4.3 压实放大与布隆过滤器性能分析 (Python 仿真)

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LSM-Tree 布隆过滤器假阳性率 (FPR) 与最优化内存位宽解析计算器
用于验证在 28px 网格中各行内数据统计指标展示
"""

import math
from typing import Dict, Tuple

class BloomFilterOptimizer:
    def __init__(self, target_fpr: float = 0.01):
        assert 0.0 < target_fpr < 1.0, "假阳性率必须严格在 (0, 1) 区间"
        self.target_fpr = target_fpr

    def compute_optimal_bits(self, capacity: int) -> Tuple[int, int]:
        """
        根据容量计算最优位数组长度 m 与哈希函数个数 k
        公式: m = - (n * ln(p)) / (ln(2)^2)
             k = (m / n) * ln(2)
        """
        n = capacity
        p = self.target_fpr
        m = - (n * math.log(p)) / (math.log(2) ** 2)
        k = (m / n) * math.log(2)
        
        return int(math.ceil(m)), int(round(k))

    def evaluate_space_overhead(self, num_keys: int) -> Dict[str, float]:
        total_bits, hash_count = self.compute_optimal_bits(num_keys)
        bytes_needed = total_bits / 8
        bits_per_key = total_bits / num_keys
        
        return {
            "bits_per_key": round(bits_per_key, 2),
            "optimal_hash_count": float(hash_count),
            "total_ram_mib": round(bytes_needed / (1024 * 1024), 3)
        }

if __name__ == "__main__":
    optimizer = BloomFilterOptimizer(target_fpr=0.005) # 0.5% 误判率
    metrics = optimizer.evaluate_space_overhead(num_keys=10_000_000)
    print(f"10M 键位内存开销: {metrics['total_ram_mib']} MiB, 散列函数: {metrics['optimal_hash_count']}")
```

---

## 5. Linux 内核异步 I/O 与零拷贝网络传输 (Kernel io_uring & eBPF Observability)

在高吞吐网关与流式富文本分发层中，内核 `io_uring` 与 eBPF 探针实现了系统调用免中断（Submission Queue Polling）与网络包纳秒级跟踪。

### 5.1 环形提交队列无锁状态模型

`io_uring` 在内核空间与用户空间之间共享一对无锁环形缓冲区：

- **SQ (Submission Queue)**：用户空间写入 I/O 请求条目（SQE），原子更新 `tail` 指针；
- **CQ (Completion Queue)**：内核空间写入完成条目（CQE），原子更新 `tail`，用户空间批量收割；
- **SQPOLL 特性**：内核创建专用内核线程轮询 SQ，实现 $0$ 次用户态至内核态切换（Zero Context Switches）。

### 5.2 生产环境排障与内核系统调优运维 (Bash 完整脚本)

```bash
#!/usr/bin/env bash
# ==============================================================================
# Linux 内核高性能网络与 io_uring 运行时环境基线自动化检测与调优
# 适用平台: Linux 5.15+ (x86_64 / aarch64)
# ==============================================================================
set -euo pipefail
IFS=$'\n\t'

echo "[+] 正在分析当前 Linux 内核配置与网络栈瓶颈..."

# 检查内核版本是否原生支持 io_uring 与 SQPOLL
KERNEL_MAJOR=$(uname -r | cut -d. -f1)
KERNEL_MINOR=$(uname -r | cut -d. -f2)

if [[ "${KERNEL_MAJOR}" -lt 5 ]] || { [[ "${KERNEL_MAJOR}" -eq 5 ]] && [[ "${KERNEL_MINOR}" -lt 10 ]]; }; then
    echo "[!] 警告: 当前内核版本 $(uname -r) 较低，推荐升级至 5.15 LTS 或更高版本以获得完整 io_uring 零拷贝特性。"
fi

# 调整核心套接字缓冲区与 backlog 队列上限
cat << 'EOF' | sudo tee /etc/sysctl.d/99-conex-latency-tuning.conf
# 开启 TCP BBR 拥塞控制算法与 fq 队列公平调度
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# 最大套接字监听挂起连接数
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 32768

# 接收与发送缓冲区自动调节范围 (min, default, max)
net.ipv4.tcp_rmem = 4096 87380 33554432
net.ipv4.tcp_wmem = 4096 65536 33554432

# 避免内存耗尽导致的无谓落盘阻塞
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
EOF

# 立即刷新生效内核参数
sudo sysctl -p /etc/sysctl.d/99-conex-latency-tuning.conf > /dev/null

echo "[+] 核心系统网络参数优化完毕，已进入生产就绪状态。"
```

### 5.3 生产排查清单与 eBPF 性能探测任务列表

- [x] 验证物理主机 CPU 虚拟化与硬件性能计数器（PMU）直通
- [x] 确立 `CONFIG_BPF_SYSCALL=y` 编译参数与 BPF CO-RE（Compile Once - Run Everywhere）支持
- [x] 部署 `bpftrace` 跟踪 TCP 首字节延迟（TTFB）与全双工 RTT 波动
  - [x] 注入 `tcp_probe` 挂载点，过滤端口 `port == 4000 || port == 8080`
  - [ ] 追踪 `sock:inet_sock_set_state` 状态机在 `TCP_SYN_SENT` 阶段的超时重传
  - [ ] 检查 NIC 网卡网线协商速率与丢包计数 `ethtool -S eth0 | grep -E "drop|error"`
- [ ] 实施内核页面映射零拷贝断言（Zero-Copy Page Flip Verification）

---

## 6. 28px 网格规范与排版几何守恒验证准则 (28px Baseline & Geometric Conservation)

Conex / Crish 编辑器在混合渲染模式下的核心不变量即为 **CSS 格式化上下文盒模型几何守恒定律**。无论光标位于哪一行、无论处于源码态（Source Mode）还是渲染态（Rendered Mode），均要求垂直位移差严格守恒：

$$
\Delta H = |H_{\text{rendered}} - H_{\text{source}}| \equiv 0 \quad (\text{其中} \; H \equiv 28\text{px})
$$

### 6.1 关键排版元素度量参数核算表

| 排版元素类型 (Element Token) | 视觉高度 (Height) | 内联行高 (Line Height) | 盒模型定位规范 (Layout Model) | 垂直位移差 $\Delta H$ | 几何守恒保证措施与规范说明 |
| :--------------------------- | :---------------: | :--------------------: | :--------------------------- | :-------------------: | :------------------------- |
| 普通文本行 `.line-block` | `28px` | `28px` | `display: block` | **$0.0\text{px}$** | 基准网格，无任何外边距膨胀 |
| 标题行 `.line-h1 ~ .line-h3` | `28px` | `28px` | `display: flex; align-items: center` | **$0.0\text{px}$** | 字号缩放但行盒绝对锁死 28px 网格 |
| 任务复选框 `.token-list-task` | `28px` | `28px` | `display: inline-flex; align-items: center` | **$0.0\text{px}$** | 清退 `vertical-align: sub`，Flex 居中 |
| 行内代码 `inline-code` | `20px` | `28px` | `display: inline; vertical-align: baseline` | **$0.0\text{px}$** | 上下 padding $\le 1\text{px}$，不撑爆 28px 行盒 |
| 快捷键胶囊 `<kbd>` | `18px` | `28px` | `display: inline-flex; align-items: center` | **$0.0\text{px}$** | 细边框 $0.5\text{px}$，柔和中轴对齐 |
| 状态高亮 `==ACTIVE==` | `22px` | `28px` | `display: inline; line-height: inherit` | **$0.0\text{px}$** | 背景色高亮，保持文本基线恒定 |
| 弃用删除线 `~~deprecated~~` | `auto` | `28px` | `text-decoration: line-through` | **$0.0\text{px}$** | 原生文本修饰，零几何形变 |

### 6.2 几何形变排查总结与无缝编辑承诺

1. **绝对禁止垂直外溢**：任何内联标记（如 `<kbd>`、`<code>`、`<span>`）的高度加上内边距与边框，绝对不得超过父容器的 28px 行盒上限。
2. **多语言代码块网格对齐**：代码块内每一行等宽字符严格遵循 `font-size: 13px; line-height: 28px;`，行号指示器垂直基线与代码文本像素级居中对齐。
3. **状态平滑过渡**：当用户在当前行输入或删除 Markdown 控制符号时，相邻上下所有行的物理 Y 轴坐标不产生哪怕 1 像素的跳动与回流（Reflow-Free Guarantee）。
