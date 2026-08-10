# plan-A6：热路径基准固化（分析）

> 任务来源：方向一打磨·轮 1 分析 A6（主 Agent 派发，纯分析任务）。
> 输入：`src/core/metrics.ts`（B6/N10 指标核心化）、`tests/perf/` 四脚本与三份数据产物、
> `docs/analysis/round-R6-report.md`（帧内 JS <4ms 口径）、01 预算表、03 G8 降档机制。
> 目标：为「避免跳动 + 做到极致」建立**可量化、防回退**的基准体系——帧内分布、
> 滚动跳动、选区丢失、补全闪烁、内存曲线、表格流式六组指标 + 分层套件 + CI 降档接入。

## 〇、结论先行

1. **现状缺口明确**：既有 `metrics.ts` 只有 FPS/缓存/物化/搜索批次/布局抖动五类；`tests/perf/`
   只有「帧间隔 + longtask + 堆采样」三类探针。**用户核心关切「跳动」完全没有指标**，
   且「选区丢失」「补全闪烁」「表格流式」「帧内 JS/layout/paint 分离」四项全部空白。
2. **新指标六组**（M1-M6）：跳动类（M2 帧间位移突变 + 滚动条/内容一致性）与选区丢失（M3）、
   补全闪烁（M4）是「0 容忍」硬门槛指标——不设宽容阈值，任何一次即 FAIL；帧内分布（M1）
   分两级采集（L1 廉价计数器 / L2 CDP trace 权威）；内存（M5）与表格列宽（M6）为
   「现测值 + 余量」定档，M6 首次采集定档后收窄。
3. **套件形态**：新建 `tests/perf/suite/`（共享 lib + 场景矩阵 + runner），`PERF_TIER=ci|nightly|local`
   三档降档（沿用 09 §50 已确立的 VITEST_PERF_TIER 命名），ci 档以「中位数 + 长任务 +
   0 容忍结构指标」判定（对齐 review-03 §276 口径），nightly 全矩阵 + GPU + trace。
4. **既有资产零删除**：四脚本与数据产物原样保留（历史口径可复现），共享统计与页面函数
   源码单向提取到 `suite/lib/`，metrics.ts 只增不改。
5. **附带发现（须上报主 Agent）**：`playwright.config.ts:4-8` 残留未解决的
   `<<<<<<< Updated upstream / ======= / >>>>>>> Stashed changes` 合并冲突标记
   （5173 vs 5174 baseURL 冲突），属基础设施卫生问题，建议排期修复。

---

## 一、现状盘点

### 1.1 metrics.ts（src/core/metrics.ts:1-226）覆盖与缺口

| 既有指标 | 采集面 | 形态 | 缺口判定 |
|---|---|---|---|
| FPS（P50/P95 + samples） | rAF 帧间隔滚动窗口 120 帧（metrics.ts:113-167） | 快照现算分位 | 有——但只给「每帧总间隔」，**拆不出 JS/layout/paint 分布** |
| 缓存命中 | MarkdownParser.getCacheStats（metrics.ts:170） | 静态统计 | 有 |
| 物化计数 | EditorStore.materializeViews 接线（metrics.ts:195） | 单调计数 | 有 |
| 搜索批次 | recordSearchBatch 登记（metrics.ts:199） | 单调计数 | 有（登记点已留） |
| 布局抖动 | layoutThrashCount 哨兵（metrics.ts:203） | 单调计数 | 有——但只数 getBoundingClientRect 次数，**不量化跳动后果** |

**metrics.ts 缺口**：无任何「视觉连续性」度量——滚动跳动、选区丢失、补全闪烁、
表格列宽定型、帧相位（JS/layout/paint）累计，全部为零。且指标实例只有「计数自增」
一种写入面，没有「记录采样值（如跳动像素、重建行数）」的接口形态。

### 1.2 tests/perf 采集口径覆盖与缺口

| 脚本 | 轮次 | 覆盖 | 探针 |
|---|---|---|---|
| baseline-collect.mjs | R0 | 加载计时 / append 拷贝曲线 / store 击键 / 全链路击键 / ArrowLeft / 强制跳变滚动 | performance.now 环绕 + rAF 帧间隔 + layoutThrash |
| baseline-recollect.mjs | R2 | 同上 + 物化探针 + 主数组引用检查 + 数据层净值 | 同上 |
| stream-inject-500.mjs | R3-D | 流式四场景（A 纯文本/B 代码/C 公式/D 编辑+流）60s×500tps | rAF 帧间隔 + longtask + performance.memory 1s 采样 + chunk 计时 + 文本一致性 |
| final-verify.mjs | R6 | 交互项（headless）+ 流式四场景（GPU）+ 内存稳态 + 对比表 | 同 R3-D + 滚动 longtask + 堆起止快照 |

**已覆盖**：帧间隔 P50/P95/P99、>16.7ms/>33.3ms 掉帧数、longtask 计数/总时长、
堆增长（起止 + 1s 采样峰值）、layoutThrash 增量、文本一致性、append 数据层净值。

**缺口（逐项对照任务书）**：

| 缺口 | 说明 |
|---|---|
| **滚动跳动指标（核心关切）完全缺失** | 现有滚动测试（baseline-collect.mjs:297-324）是「每帧 0↔maxTop 强制跳变」——只测**最坏情形帧间隔**，测不出「内容停顿后突然前跳」「滚动条位置与渲染内容错位」这类**体感跳动**；01 §5.2 P1 的「scrollTop 50% → blockAt 预测行 vs 实际渲染首行误差」指标设计存在但从未落地 |
| 帧内 JS/layout/paint 分离缺失 | R2 报告只能靠「CDP profile 归因」事后手算（JS ~4ms，其余 ~12ms 为 headless 渲染惩罚），非可重复采集；round-R6 的「帧内 JS <4ms」口径无脚本化实现 |
| 选区丢失率缺失 | 直刷（C3）对末行 token span 命令式写 textContent（MarkdownEngine.tsx:690-701），dirty 行卸载安全网（MarkdownEngine.tsx:960-974）在滚动离开时会 flush——**这些路径都会触碰用户选区，但没有任何量化** |
| 补全闪烁缺失 | 软渲染 → 完成态切换（N1 核心体验）要求「同一节点样式切换、零 DOM 重建」，无指标验证 |
| 内存无门槛 | 堆探针只有报告无断言（README §十九「无泄漏迹象」是人工结论）；G9 heap-growth 口径（3 轮循环稳态增量 ≤5%）未在 perf 脚本落地 |
| 表格流式缺失 | TableStore.setColumnWidth/setTableWidths（TableStore.ts:32-50）每次内容增长都可能重新定型列宽 → reflow；流式表格场景从未采集 |

### 1.3 缺口总表（→ 指标编号映射）

| 缺口 | 新指标 | 优先级 |
|---|---|---|
| 帧内分布 | M1 | P0（防回归的归因底座） |
| 滚动跳动 | M2 | **P0（用户核心关切，本轮主线）** |
| 选区丢失 | M3 | P0（直刷安全面） |
| 补全闪烁 | M4 | P0（N1 视觉稳定化验收面） |
| 内存门槛 | M5 | P1（既有数据可立即定档） |
| 表格流式 | M6 | P1（流式表格专项） |

---

## 二、指标设计

### 2.1 M1 帧内分布（JS / layout / paint 分离）

- **定义**：单帧主线程时间拆分为三段——JS（事件处理 + 数据层 + React 提交）、
  layout（强制重排 + 样式重算）、paint（绘制）。P50/P95 口径（对齐 round-R6「帧内
  JS <4ms、P95 口径」）。粒度分级：**L1 窗口聚合**（CI 可跑）+ **L2 单帧分解**（nightly 诊断）。
- **采集**：
  - **L1（廉价，每次基准必跑）**：三路并采——
    ① rAF 回调体内打点：`t0 = performance.now()` 进回调 → 回调体结束（含同步 React
    commit/useLayoutEffect）`t1` → JS 段 = `t1 - t0`（近似，含被迫同步 layout）；
    ② longtask observer（>50ms JS 块，既有）；
    ③ CDP `Performance.getMetrics` 500ms 轮询，取 `TaskDuration / ScriptDuration /
    LayoutDuration / RecalcStyleDuration / PaintDuration / LayoutCount / RecalcStyleCount`
    的**窗口增量**，除以窗口内帧数 → 「layout/帧」「paint/帧」归属（Chrome 主维护计数器，
    免 trace 解析，headless/GPU 同源可比）。
  - **L2（权威，nightly 专属）**：CDP `Tracing.start`（categories: `devtools.timeline,
    blink.user_timing,v8`）抓 3s 滚动窗口，按帧归组解析事件：`RunTask`（主线程任务 =
    JS+layout+paint 总和）、`Layout`（blink Layout 事件）、`UpdateLayoutTree`、
    `Paint`/`Commit`（cc 层）——输出每帧 JS/layout/paint 的 P50/P95/P99。
- **阈值**（校准见 §5.2）：

| 相位 | ci（headless） | nightly（GPU） | 依据 |
|---|---|---|---|
| JS P95/帧 | ≤ 4ms | ≤ 4ms | R2 profile 击键全链路 JS ~4ms（R2 报告 §八），R6 全链路 1.0ms 后 JS 主体更轻；01 §4.2 预算 1+2+3+4+5 ≈ 1.0ms 已达标 |
| layout+paint P95/帧 | ≤ 20ms | ≤ 12ms | headless 软件渲染惩罚（R2/R6 报告已证实）与 GPU 实测（流式总帧 P95 10.2-14.6ms 中扣除 JS） |
| 长任务（滚动 3s） | 0 warn，≥2 fail | 0 warn，≥2 fail | R6 实测 1×99ms；对齐 03 §9.2 G8 long-task 口径 |

### 2.2 M2 滚动跳动指标（新，核心关切）

两个子指标，全部落在**新增的「平滑滚动」场景**（与既有的强制 0↔maxTop 跳变口径正交）：

**M2a 帧间位移突变检测（视觉连续性）**
- **定义**：受控匀速滚动（`scrollTop` 按线性 ramp 每帧 +120px @60Hz，等价 60fps 下
  滚动速度 7200px/s），逐帧记录**实际位移量**与**内容锚点位移量**：
  - `actualDelta_i = scrollTop_i - scrollTop_{i-1}`（滚动容器真实位移）；
  - `anchorDelta_i = anchorRowTop_i - anchorRowTop_{i-1}`（首个可见行 data-index 的
    offsetTop 变化，即**内容**相对视口的位移）；
  - 稳态期望：两者均 ≈ 120px。**跳动** = 内容停顿后补偿性突进（滚轮事件积压、
    渲染卡顿后追赶）或内容与滚动条脱节。
- **采集**：页面内 rAF 循环驱动 ramp + 探针（Playwright evaluate 自包含函数，
  复用既有 pageScrollFrames 骨架改造——保持脚本在页面内打点防外部计时污染）。
  统计口径：`jumpCount`（|delta - median(delta)| > 阈值 的帧数）、
  `maxFrameDeltaErr`（最大偏差 px）、`freezeFrameCount`（delta < 2px 的停顿帧数，
  停顿后若跟跳变 → 跳动证据链）。
- **阈值**：`jumpCount = 0`（3s 平滑滚动）；`maxFrameDeltaErr ≤ 8px`（< 半行高 28px/2，
  视觉不可感）；`freezeFrameCount` 为报告项（≥2 连续停顿帧 + 后续补偿突进 = 判定跳动）。

**M2b 滚动条位置 vs 内容位置一致性**
- **定义**：程序化滚动到文档中部（`scrollTop = scrollHeight × 50%`）后，
  比较**行高模型预测**与**实际渲染**：`anchorRowError = |HeightMap.indexAt(scrollTop) -
  实际首个渲染行 [data-index]|`（行）；以及滚动条总高误差
  `scrollHeightError = |HeightMap.totalSize - scroller.scrollHeight| / totalSize`（%）。
- **采集**：01 §5.2 P1 指标的落地——采样 20 个程序化滚动位置（5%→95% 步进 5%），
  每个位置 rAF 两帧后读 `[data-index]` 首行与 scrollHeight；node 降级模式可回放
  `indexAt` 侧（纯数据层校验）。
- **阈值**：`anchorRowError` P95 ≤ 1 行；`scrollHeightError` ≤ 1%。

**M2c 直刷期间滚动（流式 + 滚动并发，防回退关键场景）**
- **定义**：流式注入（500tps）期间用户匀速滚动——直刷 dirty 行滚动离开窗口触发
  flush（MarkdownEngine.tsx:898-925）→ 同步 appendText + React 提交 → 潜在跳动。
- **采集**：M2a 探针叠加到流式场景 D 变体（D2：流式 + 滚动）。
- **阈值**：流式期间 `jumpCount = 0`、`maxFrameDeltaErr ≤ 8px`（硬门槛——
  直刷 flush 不得产生可感跳动）。

### 2.3 M3 选区丢失率（新）

- **定义**：直刷（C3）期间，用户选区（anchor 端落在直刷行/跨直刷行）被中断的次数，
  除以直刷 chunk 总数：`selectionLossRate = selectionLostCount / directFlushChunkCount`。
  「中断」= 直刷写 textContent 后 DOM 选区消失/锚点漂移/所选文本与参考模型切片不一致。
- **采集**（双通道）：
  1. **页面探针（首选，零源码改动）**：流式场景 D2 中建立参考模型，每直刷 chunk
     （判定：`store.getLine(lastIdx)` 未变而 DOM token span textContent 增长）后
     `document.getSelection()` 快照比对——rangeCount、anchorNode 归属、所选文本 =
     参考模型切片；不一致 → +1。
  2. **引擎登记点（落地期）**：metrics 新增 `recordSelectionLost()`；
     MarkdownEngine C3 直写（MarkdownEngine.tsx:690-701）前快照选区、直写后比对，
     丢失即登记——O(1) 原生计数，免页面探针逐 chunk 比对。
- **阈值**：**0 容忍**——`selectionLostCount = 0` / 会话（任何丢失即 FAIL；
  直刷的「宁可少直刷不可误刷」哲学延伸：宁可少直刷不可断选区，直写前置判定
  应把「选区跨直刷行」纳入禁入条件，见 §6 风险）。

### 2.4 M4 补全闪烁指标（新）

- **定义**：流式完成（streamEnd / 软渲染 → 完成态切换）时，**已存在行的 DOM 节点
  身份变化数**（重建 = 视觉闪烁源）。理想值 0——同一节点仅样式/类切换
  （N1「软渲染视觉稳定化」的量化验收面）。
- **采集**：页面探针——streamEnd 前一帧与后一帧对窗口内每个 `[data-index]` 行：
  `remountedCount = #{oldEl !== newEl}`；叠加 MutationObserver 记录完成帧
  `addedNodes` 数量（流式新增行除外）。引擎侧可后续加 `recordCompletionRebuild(n)`。
- **阈值**：`remountedCount = 0`（0 容忍）；完成帧新增节点数 ≤ 该帧实际新增行数
  （允许流式新行挂载，禁止存量行重建）。

### 2.5 M5 内存曲线

- **定义**：① 100 万行文档加载 + 流式 60s 注入的 JS 堆曲线
  （`performance.memory.usedJSHeapSize`，1s 采样：起点/峰值/终点/增长）；
  ② **GC 后稳态**（场景结束 + 3s 空闲后堆最小值）；③ **循环泄漏门禁**：
  3 轮「注入 60s → 空闲 30s」后 GC 后稳态增量；④ GC 暂停（longtask ≥100ms
  且空闲期归因）。
- **采集**：复用 R3-D/R6 既有堆探针（stream-inject-500.mjs 内嵌），扩展：每轮
  采样完整曲线（非仅起止）+ 每轮末 3s 空闲采样取 min；场景间 CDP
  `HeapProfiler.collectGarbage` 强制回收防串扰。
- **阈值**（校准见 §5.2）：

| 指标 | 阈值 | 现测值（R6） |
|---|---|---|
| 60s 注入堆增长 | ≤ 60MB | +26.9 ~ +43.1MB |
| 峰值 | ≤ 256MB | ≤ 163.9MB |
| 3 轮循环 GC 后稳态增量 | ≤ 5% | 新口径（首次采集） |
| GC 归因长任务 | 报告项（无硬门槛） | C 场景修复后 1 次 |

### 2.6 M6 表格流式列宽定型（新）

- **定义**：流式注入 ` ```table ` fence（markdown 表格逐行/逐单元格增长）时，
  列宽自然宽随内容变化被反复重定型 → reflow 次数。指标：
  ① `perTableWidthSettles`：单表列宽定型修正次数（首次定型后每次 setColumnWidth/
  setTableWidths 修正 +1）；② `tableLayoutDelta`：流式期间 CDP LayoutCount 增量；
  ③ 列宽收敛帧：同一列宽值连续保持 ≥5 帧 = 定型完成。
- **采集**：场景 E（500tps × 30s 表格注入，首个表格块居中）；页面内包装
  TableStore 的 setColumnWidth/setTableWidths 计数（按 tableId 分组）+ CDP
  LayoutCount 窗口增量 + MutationObserver 记录表格 DOM 宽度变化 >1px 次数。
  引擎侧登记点 `recordTableWidthSettle(tableId)` 落地期接入。
- **阈值**：每表定型修正 ≤ 2 次（首挂载 + 至多 1 次修正——内容稳定后列宽应收敛）；
  LayoutCount/秒 ≤ 无表格对照基线 × 2。**首次采集定档**（无历史数据，先登记后收窄，
  诚实标注）。

### 2.7 指标清单汇总表

| ID | 指标 | 定义 | 采集方法 | 阈值（ci） | 阈值（nightly） | 数据来源/校准 |
|---|---|---|---|---|---|---|
| M1a | 帧内 JS P95 | 单帧 JS 段（含 React 提交）P95 | rAF 打点 + longtask | ≤4ms | ≤4ms | R2 profile ~4ms；R6 1.0ms |
| M1b | 帧内 layout+paint P95 | 单帧 layout+paint 段 P95 | CDP 计数器（L1）/ trace（L2） | ≤20ms | ≤12ms | headless 惩罚 vs GPU 实测 |
| M1c | 长任务计数 | >50ms 任务次数（滚动 3s） | PerformanceObserver | ≥2 fail | ≥2 fail | R6 1×99ms |
| M2a | 帧间位移突变 | jumpCount / maxDeltaErr | 平滑滚动 ramp 探针 | 0 次 / ≤8px | 0 次 / ≤8px | 新指标，0 容忍 |
| M2b | 滚动条/内容一致性 | anchorRowError / scrollHeightError | 20 位置采样 | P95 ≤1 行 / ≤1% | 同 ci | 01 §5.2 P1 落地 |
| M2c | 直刷期间滚动 | 流式+滚动并发 jumpCount | M2a 探针叠加场景 D2 | 0 次 | 0 次 | 新指标，0 容忍 |
| M3 | 选区丢失率 | 丢失数 / 直刷 chunk 数 | 页面探针 / 引擎登记 | 0 次/会话 | 0 次/会话 | 新指标，0 容忍 |
| M4 | 补全闪烁 | 完成态切换存量行重建数 | 节点身份比对 + MutationObserver | 0 行 | 0 行 | 新指标，0 容忍 |
| M5a | 堆增长（60s 注入） | 起止差 | performance.memory 1s 采样 | ≤60MB | ≤60MB | +26.9~+43.1 |
| M5b | 堆峰值 | 采样最大值 | 同上 | ≤256MB | ≤256MB | ≤163.9 |
| M5c | 循环泄漏 | 3 轮 GC 后稳态增量 | 3 轮注入+空闲+强制 GC | —（nightly） | ≤5% | G9 口径落地 |
| M6a | 表格列宽定型修正 | 单表修正次数 | TableStore 包装计数 | ≤2 次 | ≤2 次 | 首次采集定档 |
| M6b | 表格 reflow | LayoutCount 增量 | CDP 计数器 | ≤基线×2 | ≤基线×2 | 首次采集定档 |

---

## 三、基准套件架构

### 3.1 脚本组织

```
tests/perf/
├── suite/                        # 新增：下一代基准套件（本期主体）
│   ├── runner.mjs                # 矩阵调度 + 档位判定 + 报告聚合 + 退出码
│   ├── budgets.mjs               # 阈值常量（M1-M6 全部 + 三档），对齐 03 §9.2「改一处」
│   ├── lib/
│   │   ├── stats.mjs             # median/pct/sum/summarizeSamples/fpsBand（从既有脚本提取）
│   │   ├── pagesrc.mjs           # PAGE_LOAD_DOC/PAGE_APPEND_BENCH/PAGE_STREAM_FN/GEN_SRC
│   │   │                         #   等源码字符串库（从 baseline-collect/final-verify/stream-inject 提取）
│   │   ├── probes.mjs            # 新探针：平滑滚动 ramp / 选区完整性 / 节点身份 / CDP 计数器/trace
│   │   └── env.mjs               # 环境指纹（UA/核数/内存/CDP SystemInfo GPU 判定）+ 服务器拉起
│   ├── scenarios/                # 场景定义（每场景 = 文档构造 + 交互驱动 + 指标组）
│   │   ├── interactive.mjs       # 加载/击键/ArrowLeft（复刻 R6 口径）
│   │   ├── scroll-smooth.mjs     # M2a/M2b/M1 平滑滚动场景（新）
│   │   ├── stream-scenarios.mjs  # A/B/C/D/D2 流式（复刻 R3-D 口径 + M2c）
│   │   ├── selection-direct.mjs  # M3 直刷+选区场景（新）
│   │   ├── completion.mjs        # M4 完成态切换场景（新）
│   │   ├── memory-cycle.mjs      # M5 三循环泄漏门禁（新）
│   │   └── table-stream.mjs      # M6 表格流式场景（新）
│   ├── README.md                 # 方法/环境/档位/复现
│   └── reports/                  # suite-report-<date>.json（gitignore 或入库基准快照，见 §3.4）
├── baseline-collect.mjs          # 既有脚本零改动保留（历史口径可复现）
├── baseline-recollect.mjs        # 同上
├── stream-inject-500.mjs         # 同上
├── final-verify.mjs              # 同上（二期可选 --suite 联动，见 §4.3）
└── README.md                     # 追加「基准套件」章节
```

### 3.2 场景矩阵（基线场景矩阵：行高/密度/fence 密度/滚动中注入）

| 轴 | 取值 | 说明 |
|---|---|---|
| 行高 | 标准 28px / 混合（标题 40px + 正文 28px） | 行高模型校准敏感轴 |
| 密度 | 纯文本 / fence 10% / fence 30% / 公式 5% | 渲染成本敏感轴（fence 重放、KaTeX） |
| 滚动中注入 | 无 / 有（500tps 流式 + 匀速滚动并发） | M2c 跳动关键轴 |

- 全矩阵 = 2 × 4 × 2 = **16 组合**（nightly 全跑）；
- **ci 子集** = 4 组合（28px 纯文本×无注入、28px 纯文本×滚动注入、混合行高×fence30%×无注入、
  28px 公式×滚动注入——覆盖四个敏感维度各一档）；
- 每组合挂载的指标组：帧率（帧间隔 P50/P95/P99 + 掉帧率 + 长任务）→ M1；
  平滑滚动组合附加 M2a/M2b；滚动注入组合附加 M2c；流式组合附加 chunk 成本与文本一致性；
  专项场景（selection-direct/completion/memory-cycle/table-stream）独立成卡。

### 3.3 阈值分层与 CI 接入（VITEST_PERF_TIER）

- **档位**（命名继承 09 §50 已确立的 VITEST_PERF_TIER，review-03 §196 判定的显式化落地）：

| 档位 | 渲染后端 | 场景范围 | 判定口径 | 预估时长 |
|---|---|---|---|---|
| `ci` | headless | 交互核心项 + ci 子集 4 组合 + 滚动平滑 + 选区/补全专项 | 中位数 + 长任务计数 + 0 容忍结构指标（M2a/M2b/M2c/M3/M4）；帧率降档为 ≥30fps 硬门槛（p95<33ms，对齐 03 §9.2 G8） | ~5 分钟 |
| `nightly` | GPU 有头 | 全矩阵 16 组合 + 流式四场景 + memory-cycle 3 轮 + M6 + L2 trace | 全档（60fps p95<16.6ms；120/140 名义可达档）+ 0 容忍指标 | ~25-30 分钟 |
| `local` | 本机自动 | 同 nightly 可裁剪（--quick 走 ci 子集） | 全档 | 开发者自定 |

- **CI 接入**：`package.json` 新增 `"test:bench": "node tests/perf/suite/runner.mjs"`
  （默认 `PERF_TIER=ci`，脚本内读 `process.env.PERF_TIER`，Windows 用
  `$env:PERF_TIER='nightly'` 传值，npm script 不内联 env 语法）；ci 档挂 CI slow 层或
  独立 job（对齐 03 §12.7 分层：任何一层失败阻塞合并，严禁 --no-verify 绕行）；
  nightly 挂定时任务。判定：退出码 0/1 + `suite-report-<date>.json`（含阈值命中明细，
  报告即「失败归属证据」）。
- **阈值放行协议**：0 容忍类指标无放行；阈值类指标 CI 抖动申诉走「3 次重跑中位数」，
  仍失败 → 基准快照比对，确认环境漂移而非代码回退后更新 `budgets.mjs` 并附更新理由
  （禁止静默放宽）。

### 3.4 防抖（环境噪声治理）

1. **环境指纹**：UA / hardwareConcurrency / deviceMemory / CDP `SystemInfo.getInfo`
   GPU vendorId+renderer（headless SwiftShader vs GPU 判定）写入报告头部——渲染后端
   归属可审计，防止「换环境不知道」；
2. **样本口径**：每组 ≥5 采样取中位数（既有惯例）+ **3σ 离群剔除**（> 均值+3σ 丢弃）；
3. **场景 3 轮重复**（nightly）：同场景 3 次中位数再取中位数；ci 单轮但判定以
   中位数/长任务/0 容忍为主（review-03 §276 口径）；
4. **渲染后端敏感指标分档**：M1b（layout+paint）按 tier 阈值隔离（headless 20ms /
   GPU 12ms），帧率判档以实际渲染后端档位对齐（01 §5.1 探测刷新率思想）；
5. **运行期守卫**：场景间 CDP `HeapProfiler.collectGarbage` + 5s 冷却 + 滚动/流式
   前统一 flushStreamTail 归一（R2 教训：尾段非空污染击键口径），防跨场景残留；
6. **基准快照机制**：首跑产物即 `suite-baseline-<date>.json`（入库，AGENTS.md 测试资产
   铁律），回归判定 = 当前产物 vs 快照，防「阈值漂移而不自知」。

---

## 四、与现有 metrics/perf 融合

### 4.1 metrics.ts 扩展面（只增不改，兼容 MetricsSnapshot 旧字段）

| 新 API | 语义 | 接线点 |
|---|---|---|
| `recordScrollJump(px: number)` | 帧间位移突变登记（px 采样值，滚动窗口） | 引擎 handleScrollFlush/批量测量 effect 中 anchor 突变检测（落地期）或套件探针（首期） |
| `recordSelectionLost()` | 选区中断计数 | MarkdownEngine C3 直写前后选区快照比对（MarkdownEngine.tsx:690-701 前后） |
| `recordCompletionRebuild(count: number)` | 完成态切换重建行数 | streamEnd 完成帧节点身份比对 |
| `recordTableWidthSettle(tableId: string)` | 列宽定型修正计数（按表） | TableStore.setColumnWidth/setTableWidths（TableStore.ts:32-50） |
| `recordFramePhases(jsMs, layoutMs, paintMs)` | 帧相位累计（L1 探针注入） | 套件页面探针（rAF 打点 + CDP 计数器归帧） |

`MetricsSnapshot` 新增 `scrollJumps / selectionLost / completionRebuilds /
tableWidthSettles / framePhases` 字段——旧消费方（main.tsx `__CRISH_METRICS__`、
metrics.test.ts 3b 兼容断言）不受影响。`tests/unit/metrics.test.ts` 同步补登记点测试
（§5.3）。

### 4.2 引擎接线点（落地期任务书输入）

- C3 直写（MarkdownEngine.tsx:690-701）：直写前 `document.getSelection()` 快照，
  直写后比对；被中断 → `recordSelectionLost()`；**建议同步评估**：把「选区跨直刷行」
  纳入 `canDirect` 禁入条件（防直刷写死选区）——属引擎行为变更，需评审后单独任务；
- streamEnd（MarkdownEngine.tsx:713-717）：完成帧节点身份比对 → `recordCompletionRebuild`；
- TableStore：setColumnWidth/setTableWidths 登记。

### 4.3 既有脚本改造面（复用 vs 扩展）

- **零删除、零入口改动**：baseline-collect / baseline-recollect / stream-inject-500 /
  final-verify 四脚本原样保留——它们承载 R0/R2/R3/R6 历史口径的**可复现性**（终验
  对比表依赖同一口径），删改即破坏对比基线；
- **单向提取（一期）**：统计工具与页面函数源码字符串（GEN_SRC / PAGE_*_SRC 等）复制
  到 `suite/lib/`，套件独立运行——既有脚本暂不切换，避免「改一行历史脚本 = 重验一轮」；
- **二期收敛（可选）**：final-verify.mjs 增加 `--suite` 联动模式（交互项复用套件），
  待套件稳定运行一轮后由主 Agent 裁决，本轮不承诺；
- **分工边界**：结构性计数（M2/M3/M4/M6 的引擎登记）在 src 内，浏览器/CDP 探针在
  套件内，经 `window.__CRISH_METRICS__` / `window.__CRISH_SESSION_STORE__` 汇合
  （与既有脚本同形态，不新开全局）。

---

## 五、测试方案

### 5.1 基准脚本可运行性

| 模式 | 能力 | 降级策略 |
|---|---|---|
| 浏览器（ci/nightly） | 全指标（帧率/跳动/选区/补全/内存/表格/CDP） | 5173 自动拉起（既有 spawnDevServer 提取到 lib）；失败自动降级 node |
| node 降级（--node-only） | 数据层指标：store 击键、append 净值、chunk 成本、文本一致性、M2b 的 indexAt 侧、M5 无 | 浏览器专属项标记未采集（既有惯例）；CDP 不可用时 L2 trace warn 跳过、M1 走 rAF 打点近似 |
| 环境守卫 | 无 performance.memory（非 Chromium）→ M5 标记未采集 | 不阻塞其余指标 |

### 5.2 阈值校准表（现有数据 → 拟定阈值 → 余量）

| 指标 | 现测值 | 来源 | 拟定阈值 | 余量 |
|---|---|---|---|---|
| 击键全链路中位 | 1.0ms | R6 终验 | ≤2ms | ×2 |
| 击键全链路 P95 | 1.2ms | R6 终验 samples | ≤4ms | ×3.3 |
| 击键 store 层中位 / P95 | 0.9 / 3.8ms | R6 终验 | ≤1 / ≤4ms | ×1.1 / ×1.05 |
| ArrowLeft 均值 / P95 | 14.5 / 17.4ms | R6 终验 | ≤17.5 / ≤21ms（相对 +20%） | 瓶颈登记项，不劣化即可 |
| 滚动帧 P95（强制跳变口径） | 21.8ms | R6 终验 | ≤25ms | +15% |
| 滚动 layoutThrash（3s） | +179 | R6 终验 | ≤200 | +12% |
| 滚动长任务 | 1×99ms | R6 终验 | 0 warn / ≥2 fail | — |
| 流式 P95（GPU 四场景） | 11.5-14.3ms | R6 终验 | <16.6ms | 任务口径（既有） |
| 流式 >33.3ms 掉帧率 | 0-0.04% | R6 终验 | ≤1% | — |
| 流式 chunk P95 | 0.3-0.7ms | R6 终验 | ≤1ms | — |
| 堆增长（60s） | +26.9~+43.1MB | R6 终验 | ≤60MB | +40% |
| 堆峰值 | ≤163.9MB | R6 终验 | ≤256MB | +56% |
| 百万行加载 | 12.25s | R6 终验 | ≤20s | +63%（CI 抖动余量） |
| 帧内 JS P95 | ~4ms（击键 profile） | R2 报告 §八 | ≤4ms | ×1（口径对齐 round-R6） |
| layout+paint P95 | headless 滚动总帧 21.8ms 减去 JS | R6 终验 | ci ≤20ms / nightly ≤12ms | 渲染后端分档 |

新指标（M2a/M2b/M2c/M3/M4/M6）无历史数据：**0 容忍类直接定档**（跳动 0 次、选区
0 次、重建 0 行——这是目标语义而非统计宽松度）；M6 首次采集定档（登记「首跑快照」后
下一轮收窄）。

### 5.3 单测与首跑任务

| 项 | 内容 |
|---|---|
| 单测扩展 | `tests/unit/metrics.test.ts` 补 5 个登记点（§4.1 新 API）用例；新增跳动检测纯函数单测（ramp 位移序列 → jumpCount/maxDeltaErr 判定）、选区中断判定纯函数单测（选区快照对 → 中断与否）——纯函数可 node 直测 |
| 可运行性冒烟 | runner 三模式（browser ci / node-only / CDP 缺失 warn）各跑通一遍 + 门禁 `npm test` 全绿 |
| 首跑任务 | 首跑产物 = `suite-baseline-<date>.json` 入库（AGENTS.md 铁律：新增测试资产立即提交） |

---

## 六、附带发现与风险

| 项 | 说明 |
|---|---|
| playwright.config.ts 合并冲突残留 | `playwright.config.ts:4-8` 存在 `<<<<<<< Updated upstream` 未解决标记（5173 vs 5174 baseURL）——当前任何 Playwright 解析都可能行为不确定；建议主 Agent 排期修复（不属本任务范围） |
| 直刷写死选区风险 | C3 直写绕过 React 直接改 textContent，若用户选区跨直刷行，DOM 选区可能被破坏——M3 的 0 容忍阈值可能暴露既有缺陷（当前无直刷场景下选区中断的测试）；引擎侧修复需单独评审（§4.2 建议的禁入条件） |
| M6 定档诚实性 | 表格流式无历史数据，阈值「≤2 次定型修正」为设计推定值，首跑后须按实测回写 budgets.mjs 并附理由 |
| ArrowLeft 瓶颈 | 14.5ms/键（getText 全量 join）为已登记瓶颈——基准套件将其定为「不劣化」相对阈值（+20%），修复后另行收窄（与 R6 遗留 2 对齐） |
| 强制跳变口径保留 | 既有「0↔maxTop 强制跳变」滚动口径继续保留（最坏情形参考），新增平滑滚动口径才是体感跳动判定——两者并存、角色分工在 README 注明 |

---

## 七、产出文件与本任务边界

- 本分析产出：本文件（plan-A6-基准固化.md，UTF-8 无 BOM，中文）；
- 落地建议拆解（供主 Agent 派发后续实现任务）：
  1. 套件基建（lib/runner/budgets/scenarios 骨架 + 三模式冒烟）——实现 Agent 1；
  2. M2 平滑滚动/跳动探针 + 场景（本任务书核心关切）——实现 Agent 2；
  3. M3/M4 探针与场景——实现 Agent 3；
  4. metrics.ts 扩展 + 引擎登记点接线 + 单测——实现 Agent 4；
  5. 首跑采集 + 基准快照入库 + budgets 定档——验证 Agent。
- 不 commit（分析任务约定）。
