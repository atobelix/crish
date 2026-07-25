# 审计报告：第九部分 渲染性能与内存管理（9.1-9.3）

> 审计日期: 2026-07-23
> 目标版本: refactor_plan.md 第 968-1013 行
> 代码审计范围: StreamRenderBuffer.ts, markdownCache.ts (LruCache), compute-worker.ts, memory-manager.ts, cache.ts, dynamic-adaptation.ts

---

## 9.1 `StreamRenderBuffer` 帧预算自适应（第 970-978 行）

### 现状确认

**文件**: `apps/crish-desktop/src/api/StreamRenderBuffer.ts`

- 第 45 行：`private frameBudgetMs = 12` — 硬编码 12ms
- 第 47 行：`private maxBytesPerFrame = 8192` — 硬编码 8KB
- 第 54-62 行：构造函数虽接受 `options` 覆盖，但实际调用方（`useChatStream` 等）未传任何参数，等价于全固定。

**实际运行机制**：`flushFrame()`（第 179-262 行）在每帧末尾用 `performance.now() >= deadline`（第 203 行）检查时间预算是否耗尽。但这测量的是**字符串拼接时间**，而非 Markdown 编译时间——真正的 Markdown 编译在 Worker 中异步执行（`useChatStream` → `parseMarkdownToHtmlAsync`），不在本类的作用域内。

### 对原方案的评价

#### EMA 算法（alpha=0.2）

| 方面 | 评价 |
|---|---|
| 响应速度 | 均值半衰期 ≈ ln(0.5)/ln(1-0.2) ≈ **3.1 帧**，约 50ms（60fps），对帧级波动适度平滑 |
| 稳定性 | alpha=0.2 是常用的平滑值，能过滤单帧毛刺又不至于反应太迟钝。合理。 |
| 冷启动问题 | 前 10 帧的 EMA 值偏倚严重。**原方案未提及冷启动策略**。 |

#### 钳位范围 8-20ms

- **8ms 下限**：相当于 125fps 的预算。一台 60Hz 屏幕的设备永远不需要低于 16ms 的预算（rAF 约每 16.67ms 触发一次）。8ms 会在低端机上强制分两帧处理，增加调度开销。
- **20ms 上限**：相当于 50fps 预算。如果设备以 30fps 运行（降频/省电模式），20ms 会让主线程超负荷。
- **核心问题**：钳位范围不应是绝对时间，而应**相对于当前刷新率**。60Hz 下合理范围是 8-14ms；30Hz（省电模式）下应为 16-28ms。

#### 缺少对降频场景的响应

原方案仅依赖过去 10 帧的 EMA，没有对**突发降频**（拔电源、CPU 热节流）提供快速响应路径。

### 改进方案

#### 9.1.3 自适应帧预算——改进设计

```typescript
interface AdaptiveBudgetConfig {
  /** EMA 平滑系数（正常态） */
  alpha: number;           // default 0.2
  /** 降频态加速系数（检测到连续超帧时使用） */
  fastAlpha: number;       // default 0.5
  /** 连续超帧阈值（触发快速衰减） */
  consecutiveOverrunThreshold: number; // default 3
  /** 预算相对于 rAF 间隔的比例上限 */
  budgetRatioMax: number;  // default 0.75 (即最多占 rAF 间隔的 75%)
  /** 预算相对于 rAF 间隔的比例下限 */
  budgetRatioMin: number;  // default 0.35
  /** 窗口帧数（计算 moving percentile 用） */
  windowSize: number;      // default 20
}
```

**核心逻辑**（在 `StreamRenderBuffer` 中新增）：

1. **帧耗时采集点修正**：不在 `flushFrame` 内测（只测字符串拼接），改为在 `useChatStream` 中测量 `parseMarkdownToHtmlAsync` 的完整耗时，经 postMessage 回传。

2. **EMA + 感知降频**：
   ```
   if (consecutiveOverruns >= threshold) {
       // 降频快速响应：加大 alpha 让预算快速收缩
       effectiveAlpha = fastAlpha;
   } else {
       effectiveAlpha = normalAlpha;
   }
   newBudget = effectiveAlpha * measuredMs + (1 - effectiveAlpha) * oldBudget;
   ```

3. **相对于刷新率的钳位**：
   ```
   const rafInterval = 1000 / (refreshRate || 60);
   minBudget = rafInterval * budgetRatioMin;    // e.g., 60Hz → 5.8ms
   maxBudget = rafInterval * budgetRatioMax;    // e.g., 60Hz → 12.5ms
   ```

4. **降频快速检测**——在 `StreamRenderBuffer` 中新增 Battery API 监听：
   ```typescript
   // 在 StreamRenderBuffer 中可选注入
   if ('getBattery' in navigator) {
     const battery = await navigator.getBattery();
     battery.addEventListener('chargingchange', () => {
       if (!battery.charging) {
         // 拔电源：立即将 alpha 提升到 0.5 持续 2 秒
         this.boostAlpha(0.5, 2000);
       }
     });
   }
   ```

5. **maxBytesPerFrame 自适应**：跟随 `frameBudgetMs` 按比例调整。经验公式：`maxBytesPerFrame = baseBytes * (frameBudgetMs / 12)`，其中 `baseBytes = 8192`。

---

## 9.2 `markdownCache` 内存压力响应策略细化（第 982-995 行）

### 现状确认

**文件**: `packages/shared-utils/src/cache.ts`（LruCache 实现）+ `apps/crish-desktop/src/api/markdownCache.ts`

- `LruCache.shrink(targetRatio)`（cache.ts:94-105）：从 Map 迭代器中逐条删除最旧条目，直到 `map.size <= maxEntries * ratio` 且 `bytesUsed <= maxBytes * ratio`。
- `markdownCache.applyMarkdownCacheMemoryPressure()`（markdownCache.ts:188-209）：接收 `'low' | 'high' | number`，映射到 ratio（low=0.5, high=0.25, number=自定义），然后调用 `MARKDOWN_HTML_CACHE.shrink(ratio)`。
- `MemoryManager.handlePressure()`（memory-manager.ts:108-131）：按内存压力等级映射 ratio（Level1→0.8, Level2→0.5, Level3→0.1），遍历所有注册 cache 调用 `shrink(ratio)`。

**现有策略的本质**：纯 LRU + 比例收缩。Map 按**插入顺序**迭代，而 LruCache 的 `get()` 会 delete+re-set 来模拟访问序（cache.ts:54-57），所以 `map.keys().next()` 确实是"最久未访问"条目。

### 对原方案的评价

原方案提出三级时间窗口清除（5min → 1min → 最近），有明显改进但也有问题：

| 原方案内容 | 分析 |
|---|---|
| "超过 5 分钟未访问的条目" | 需要存储 `lastAccessedAt` 时间戳。当前 LruCache 只维护**相对顺序**，不维护**绝对时间**。 |
| "每次清除检查当前内存是否已低于阈值" | 这已经是 `shrink()` 的 loop 行为（逐条删除直到达标）——原方案没有增加新东西。 |
| 三级时间窗口 | 粒度还是不够细。重度压力（ratio=0.25）下可能需要清除更近期条目。 |

**核心缺陷**：时间窗口方案在极端压力下退化到与现有 LRU 无差别——因为所有条目都可能是"最近访问"的（流式输出场景下，大部分缓存条目可能都在 1 分钟内被访问过）。

### 改进方案

#### 9.2.3 混合清除策略——改进设计

在 `LruCache` 或 `markdownCache` 层增加**访问频率追踪**，而非仅依赖时间窗口。

##### 策略：频率 × 时效性 × 大小 综合评分

```typescript
interface EvictableEntry {
  key: string;
  lastAccessedAt: number;  // 上次访问时间戳
  accessCount: number;     // 总访问次数
  size: number;            // 估算字节数
  isHot: boolean;          // 是否"热点"守住
}
```

**清除优先级评分公式**（分值越高越优先清除）：

```
evictionScore = w1 * timeDecay(lastAccessedAt)
               + w2 * sizeBonus(size)
               - w3 * frequencyBonus(accessCount)
```

其中：
- `timeDecay(t)` = (now - t) / 60000（分钟级老化）
- `sizeBonus(s)` = s / avgEntrySize（大条目加分，优先清）
- `frequencyBonus(c)` = log2(c + 1)（高频条目减分，保护之）
- 权重 w1=0.4, w2=0.3, w3=0.3（可在极端压力下调整，例如 w3 降至 0.1）

**冷热保护增强**：
- 每当 `get()` 命中，如果 `accessCount++` 后超过阈值（如 3），标记 `isHot = true`。
- `isHot` 条目在压力等级 < 3 时**豁免清除**；仅当 `level === 3`（critical）时才可被清除。
- 豁免条目数量上限 `maxHotProtected = maxEntries * 0.05`（最多保护 5%）。

##### 与 MemoryManager 的集成

修改 `MemoryManager.handlePressure()`（memory-manager.ts）的 pressure debounce：
- 当前 debounce 是 5 秒内不做两次（memory-manager.ts:93-97）。**太保守**——连续的高频垃圾回收可能被抑制。
- 改为：压力等级 *上升时* 立即执行；压力等级 *下降时* 才 debounce。

##### 新增 API 签名

```typescript
// markdownCache.ts
export function applyMarkdownCacheMemoryPressure(
  levelOrRatio: 'low' | 'high' | number = 'low',
  options?: {
    /** 是否启用热度保护 */
    enableHotProtection?: boolean;
    /** 是否跳过 isHot 豁免（critical 时） */
    forceEvictHot?: boolean;
  },
): { evicted: number; entries: number; approxBytes: number }
```

---

## 9.3 `compute-worker.ts` 任务优先级队列（第 999-1011 行）

### 现状确认

**文件**: `apps/crish-desktop/src/workers/compute-worker.ts`

- 第 175-271 行：`self.onmessage` 是一个**同步 dispatch**——每次收到消息立即进入对应的 `case` 分支。
- 所有 `case` 均使用 `await`，意味着当前消息处理完毕前，后续消息在浏览器的 Worker 消息队列中排队（**FIFO 顺序**）。
- 没有任何优先级概念：`sha256` 和 `session.search` 完全平等排队。

**具体问题场景**（原方案描述正确）：
- 当 `session.search`（全 Session 搜索，O(n) 字符串遍历）正在执行时，后续的 `sha256` 校验消息必须等待其完成。对于流式消息完整性校验，这会直接延迟 UI 更新。

### 对原方案的评价

| 原方案内容 | 分析 |
|---|---|
| 两级优先级队列 | 太少。至少需要三级：Critical/High/Normal。 |
| "高优先级优先处理" | 不完善——没有处理**正在执行中的低优先级任务被高优先级任务阻塞**的场景。当前 Worker 是单线程，一旦开始执行 `session.search`，高优先级任务只能等它完成后才能开始。 |
| 优先级分类 | sha256 和 base64 放一起合理。但缺少 "critical" 级别给 `ping`（alive 检测）和 `encoding.detect`（阻塞文件打开）。 |

### 改进方案

#### 9.3.3 多级优先级 + 抢占式调度

##### 优先级分级

| 级别 | 标签 | 任务类型 | 容忍延迟 |
|---|---|---|---|
| P0 | Critical | `ping`（心跳探活） | < 50ms |
| P1 | High | `sha256`、`base64.encode`、`base64.decode`、`encoding.detect` | < 200ms |
| P2 | Normal | `diff.parse`、`json.stringify`、`json.parse`、`budget.text`、`externalize.blobs` | < 1000ms |
| P3 | Low | `session.search` | < 5000ms |

##### 优先级队列数据结构

```typescript
// 在 Worker 内实现（compute-worker.ts 顶部新增）

type TaskPriority = 0 | 1 | 2 | 3; // P0=P3

interface QueuedTask {
  id: string;
  type: string;
  payload: unknown;
  transferables?: Transferable[];
  priority: TaskPriority;
  enqueuedAt: number;    // 入队时间戳
  age: number;           // 等待轮次（用于老化提升）
}

class PriorityTaskQueue {
  private queues: QueuedTask[][] = [[], [], [], []];
  private highWaterMark = 0;     // 当前最高非空队列索引

  enqueue(task: QueuedTask): void;
  dequeue(): QueuedTask | undefined;
  /** 老化：每轮调度后将 Long-Waiting 的低优先级任务提升 */
  ageAndPromote(): void;
}
```

##### 防饿死机制

**方案 A：优先级老化（推荐）**

```
ageAndPromote():
  for each level from P3 up to P1:
    for each task in queue[level]:
      task.age++
      if task.age > PROMOTION_THRESHOLD:
        // 提升一级
        queue[level-1].push(task)
        remove from queue[level]
```

- `PROMOTION_THRESHOLD` = 5（即等待超过 5 轮调度周期后被提升一级）
- P0 不老化（已经最高）

**方案 B：预留时间片**

```
schedule():
  // 至少每 4 个任务处理一个 Low 级别任务
  const slotCounters = [0, 0, 0, 0];
  // 按 WRR（Weighted Round Robin）比例分配:
  // P0:P1:P2:P3 = 1:2:2:1
  // 即每 6 个任务, 1个P0, 2个P1, 2个P2, 1个P3
```

**推荐组合**：老化为主 + WRR 保底。既避免饿死，又保证高优先级吞吐。

##### 当前任务抢占

由于 Web Worker 不支持真正抢占，采用**协作式中断**：

```typescript
// 在长时间任务中插入 yield 检查点
async function sessionSearch(/*...*/): Promise<...> {
  const YIELD_INTERVAL = 10; // 每处理 10 条消息检查一次
  for (let i = 0; i < messages.length; i++) {
    // ... 处理逻辑 ...

    if ((i % YIELD_INTERVAL) === 0) {
      // 检查是否有高优先级任务等待
      await checkPriorityYield();
    }
  }
}

// 对外暴露检查点
async function checkPriorityYield(): Promise<void> {
  // 如果高优先级队列非空，暂停当前任务，让它重新入队尾
  // 注意：这会丢失当前进度，所以 sessionSearch 需要维护 iterator state
}
```

但 Web Worker 中尚无标准的中断机制。更实际的方案是**任务分片**：

```typescript
// sessionSearch 改为 generator/迭代器，每批处理完后 yield
function* sessionSearchBatch(
  query: string,
  messages: Array<...>,
  batchSize = 20,
): Generator<Array<...>, void, unknown> {
  for (let i = 0; i < messages.length; i += batchSize) {
    yield messages.slice(i, i + batchSize).map(msg => /* scoring */);
  }
}
```

然后调度器持有生成器，每轮调度执行一批。如果高优先级任务到达，保存生成器状态，先处理高优先级任务。

##### 实现变更摘要

对 `compute-worker.ts` 的改动：

```typescript
// 新增
const taskQueue = new PriorityTaskQueue();
const activeGenerators = new Map<string, Generator>(); // 分片任务状态
const TASK_PRIORITY: Record<string, TaskPriority> = {
  ping: 0,
  sha256: 1,
  'base64.encode': 1,
  'base64.decode': 1,
  'encoding.detect': 1,
  'diff.parse': 2,
  'json.stringify': 2,
  'json.parse': 2,
  'budget.text': 2,
  'externalize.blobs': 2,
  'session.search': 3,
  'clear-cache': 2,
};

// 调度循环（替换原有 onmessage 直出模式）
async function schedulerLoop(): Promise<void> {
  while (true) {
    taskQueue.ageAndPromote();
    const task = taskQueue.dequeue();
    if (!task) { /* sleep? */ break; }
    await processTask(task);
  }
}

self.onmessage = (e) => {
  const { id, type, payload, transferables } = e.data;
  const priority = TASK_PRIORITY[type] ?? 2;
  taskQueue.enqueue({ id, type, payload, transferables, priority, enqueuedAt: Date.now(), age: 0 });
  // 触发调度（但确保只有一个调度循环在运行）
  ensureSchedulerRunning();
};
```

---

## 补充问题

### Q1：设备突然降频（如笔记本拔电源），自适应帧预算如何快速响应？

**当前已有的基础设施**：

- `dynamic-adaptation.ts` 已有 `FpsMonitor` 和内存压力监测
- `memory-manager.ts` 有定期的 `check()` 循环
- `performance-tier.ts` 有 `shouldDowngrade()` / `shouldUpgrade()`

**这些现有的不足**：
1. `MemoryManager.check()` 每 30 秒才运行一次（memory-manager.ts:14），无法响应秒级的降频
2. `DynamicAdaptationEngine.onFpsSample()` 每秒才采样一次 FPS（dynamic-adaptation.ts:127-140），且 drop rate > 30% 才降级，阈值太高
3. 没有任何 Battery API 监听

**改进建议**：

1. **增加 Battery API 监听**（StreamRenderBuffer 中）：
   ```typescript
   if ('getBattery' in navigator) {
     navigator.getBattery().then(battery => {
       const handler = () => {
         if (!battery.charging) {
           // 拔电：快速收缩预算
           this.frameBudgetMs = Math.min(this.frameBudgetMs, 8);
           this.boostAlpha(0.6, 3000); // 3秒快速适应期
         }
       };
       battery.addEventListener('chargingchange', handler);
       battery.addEventListener('levelchange', handler); // 低电量也触发
     });
   }
   ```

2. **增加帧预算的"急刹"模式**——当 `consecutiveOverruns >= 2`（连续两帧超预算）时：
   - 立即将预算减半：`frameBudgetMs = max(minBudget, frameBudgetMs * 0.5)`
   - 恢复条件：连续 10 帧没有超预算，才以 EMA 回升

3. **利用 `navigator.connection`**（NetworkInformation API）：
   - 当 `effectiveType` 从 `'4g'` 降为 `'3g'` 或 `'2g'` 时，可作为降频信号辅助判断（设备可能在移动环境下主动降频省电）

### Q2：compute-worker 高优先级任务队列如何防止低优先级任务"饿死"？

详见上方 9.3.3 的**防饿死机制**一节。核心是三管齐下：

| 机制 | 效果 | 实现代价 |
|---|---|---|
| **老化提升（Aging）** | 等待 N 轮后自动提升优先级 | 低：额外 age 字段 + 定时扫描 |
| **加权轮询（WRR）** | 保证最低处理配额 | 低：计数器 + 权重表 |
| **任务分片（Yield）** | 长任务主动让出控制权 | 中：需将同步函数改为 Generator/分步迭代器 |

**推荐默认值**：
- 老化阈值: 5 轮（约 50ms/轮，即 ~250ms 等待后提升一级）
- WRR 权重: P0:P1:P2:P3 = 1:3:4:2（每 10 个任务至少 2 个 P3）
- 分片大小: `session.search` 每批 20 条消息

---

## 总结：对原方案的综合评价

| 子项 | 原方案合理性 | 主要不足 | 本报告改进点 |
|---|---|---|---|
| 9.1 帧预算自适应 | EMA alpha=0.2 合理 | 测量点错误（测了字符串拼接而非 markdown 编译）；钳位范围未考虑刷新率；无降频快速响应 | 修正测量点；按 rAF interval 相对钳位；Battery API + consecutive overrun 急刹 |
| 9.2 缓存分层清除 | 方向正确 | 时间窗口在极端压力下退化到等价 LRU；未考虑访问频率；需存储绝对时间戳增加开销 | 频率×时效性×大小综合评分；isHot 热点保护；权重可随压力等级调节 |
| 9.3 任务优先级 | 两级分类正确但有遗漏 | 无防饿死；无抢占；级别太少；未处理正在执行的低优任务 | 四级优先级 + 老化 + WRR + 任务分片（协作式抢占） |
