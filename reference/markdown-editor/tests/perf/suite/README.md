# 基准套件（tests/perf/suite/）

下一代性能基准体系（plan-A6 基准固化落地）：为「避免跳动 + 做到极致」建立
**可量化、防回退**的指标集——帧内分布、滚动跳动、选区丢失、补全闪烁、
内存曲线、表格流式六组指标 + 三档套件 + CI 降档接入。

## 目录结构

```
tests/perf/suite/
├── runner.mjs               # 调度器：矩阵调度 + 档位判定 + 报告聚合 + 退出码
├── budgets.mjs              # 阈值常量总表（M1-M6 全部 + 三档；「改一处」原则）
├── lib/
│   ├── stats.mjs            # 中位数/百分位/3σ 剔除/汇总/帧率档位（既有口径复刻）
│   ├── pagesrc.mjs          # 页面探针源码库（rAF 采样/ramp 探针/选区/节点身份/表格）
│   └── env.mjs              # 环境指纹（CDP SystemInfo GPU 判定）+ 服务器拉起 + CDP 辅助
├── scenarios/
│   ├── scroll-smooth.mjs    # 平滑滚动跳动检测（M2a/M2b/M1）
│   ├── stream-scenarios.mjs # 场景矩阵 16 组合（M1/M2a/M2c/M2b）
│   ├── selection-direct.mjs # 直刷期间选区完整性（M3）
│   ├── completion.mjs       # 补全闪烁（M4）
│   ├── memory-cycle.mjs     # 内存曲线与循环泄漏门禁（M5）
│   └── table-stream.mjs     # 表格流式列宽定型（M6）
├── reports/                 # suite-report-<date>.json（阈值命中明细，gitignore 建议）
└── README.md                # 本文档
```

与既有脚本的关系（A6 §4.3）：`tests/perf/` 下的 baseline-collect /
baseline-recollect / stream-inject-500 / final-verify 四脚本与三份数据产物
**零改动保留**——它们承载 R0/R2/R3/R6 历史口径的可复现性（终验对比表依赖
同一口径）；本套件单向提取其统计工具与页面函数，独立运行。

## 运行方式

```bash
node tests/perf/suite/runner.mjs                        # 默认 ci 档（headless）
PERF_TIER=nightly node tests/perf/suite/runner.mjs      # nightly 全矩阵（Windows 用 $env:PERF_TIER='nightly'）
node tests/perf/suite/runner.mjs --tier local           # 本机档（同 nightly 可裁剪）
node tests/perf/suite/runner.mjs --scenario scroll-smooth   # 单场景复跑
node tests/perf/suite/runner.mjs --dry-run              # 校验注册表/预算/执行计划（不启动浏览器）
node tests/perf/suite/runner.mjs --node-only            # 数据层降级（store 纯函数，浏览器项未采集）
```

- 环境变量：`PERF_TIER`（ci|nightly|local）、`PERF_BASE_URL`（dev server
  地址，默认 `http://localhost:5174`——与现有 e2e 端口口径一致）；
- 前置：dev server 已启动或可自动拉起（`npm run dev`）；Playwright
  chromium 已安装；nightly 档需要 GPU 有头环境。

## 三档（A6 §3.3）

| 档位 | 渲染后端 | 场景范围 | 判定口径 | 预估时长 |
|---|---|---|---|---|
| `ci` | headless | scroll-smooth + 矩阵 ci 子集 4 组合 + 选区/补全专项（7 场景） | 中位数 + 长任务计数 + 0 容忍结构指标（M2a/M2b/M2c/M3/M4）；帧率降档为 ≥30fps 硬门槛（p95<33ms） | ~3-5 分钟 |
| `nightly` | GPU 有头 | 全矩阵 16 组合 + 内存循环 3 轮 + 表格流式 + L2 trace（21 场景） | 全档（60fps p95<16.6ms）+ 0 容忍指标 + M5c 泄漏门禁 | ~25-30 分钟 |
| `local` | 本机自动 | 同 nightly 可裁剪（--scenario / --quick 走 ci 子集） | 全档 | 开发者自定 |

退出码：0 = 全部通过（含首采定档告警）；1 = 存在 FAIL/ERROR。
报告：`reports/suite-report-<date>.json`（阈值命中明细，报告即「失败归属证据」）。

## 指标清单（M1-M6）

| ID | 指标 | 定义 | 采集方法 | 阈值（ci / nightly） | 定档状态 |
|---|---|---|---|---|---|
| M1a | 帧内 JS P95 | 单帧 JS 段（含 React 提交）P95 | rAF 打点近似（L1）；CDP trace（L2 nightly） | ≤4ms / ≤4ms | 已定档（R2/R6 校准） |
| M1b | 帧内 layout+paint P95 | 单帧 layout+paint 段 | CDP 计数器窗口增量 ÷ 帧数（L1）；trace（L2） | ≤20ms（headless）/ ≤12ms（GPU） | 已定档（渲染后端分档） |
| M1c | 长任务计数 | >50ms 任务次数（滚动 3s） | PerformanceObserver | 0 warn / ≥2 fail | 已定档（R6 实测 1×99ms） |
| M2a | 帧间位移突变 | **相对脱节**：anchorDelta vs actualDelta 偏差；绝对突变/freeze 为报告项 | 匀速 ramp 探针（120px/帧 @60Hz） | 脱节 0 次（0 容忍） | 0 容忍硬门槛 |
| M2b | 滚动条/内容一致性 | 锚点行误差 + scrollHeight 误差 | 20 位置采样（5%→95%） | P95 ≤1 行 / ≤1% | 已定档（01 §5.2 P1） |
| M2c | 直刷期间滚动 | 流式+滚动并发脱节 | M2a 探针叠加场景 D2 变体 | 脱节 0 次（0 容忍） | 0 容忍硬门槛 |
| M3 | 选区丢失率 | 丢失数 / 直刷 chunk 数 | 页面探针 + 引擎登记点双通道 | 0 次/会话（0 容忍） | 0 容忍硬门槛 |
| M4 | 补全闪烁 | 完成态切换存量行重建数 | 节点身份比对 + MutationObserver | 0 行（0 容忍） | 0 容忍硬门槛 |
| M5a | 堆增长（60s 注入） | 起止差 | performance.memory 1s 采样 | ≤60MB | 已定档（R6 +26.9~+43.1） |
| M5b | 堆峰值 | 采样最大值 | 同上 | ≤256MB | 已定档（R6 ≤163.9） |
| M5c | 循环泄漏 | 3 轮 GC 后稳态增量 | 3 轮注入+空闲+强制 GC | ≤5%（nightly） | 已定档（G9 口径） |
| M6a | 表格列宽定型修正 | 单表修正次数 | 页面包装 setColumnWidth/setTableWidths | ≤2 次 | **首采定档** |
| M6b | 表格 reflow | LayoutCount/秒 | CDP 计数器 | ≤无表格基线×2 | **首采定档** |

## 定档说明（诚实标注，A6 §5.2 定档协议）

- **0 容忍类（M2a/M2b/M2c/M3/M4）无放行协议**：阈值是目标语义而非统计
  宽松度；任何一次脱节/丢失/重建即 FAIL（A6 §3.3「0 容忍类指标无放行」）。
- **M2a 判定口径（review-P3 维度 4 修订）**：主指标为 **anchorDelta vs
  actualDelta 相对脱节**（内容与滚动条不一致 = 跳动定义本体）——headless
  丢帧时两侧同步放大（双峰 120/240），relErr 仍 ≈ 0 不误报；绝对突变
  （maxJumpErrPx）与 freeze 序列仅为报告项（证据链）。
- **M2b 判定口径（首跑实测修订）**：引擎行定位存在系统偏移（B1 scrollMap
  内容高度接管引入，本机实测 ~3686px），线性绝对模型不适用——改用
  **相邻位置差分预测**（ΔscrollTop/行高推进，系统偏移在差分中抵消），
  误差 P95 ≤ 1 行（本机首跑实测 0-1 行）；混合行高组合判首行索引单调性。
- **M6a/M6b 首跑采集定档**：无历史数据，当前阈值为设计推定值。**首跑实测
  发现**：`setColumnWidth/setTableWidths` 引擎侧零调用方（B4 列宽定型未
  落地）——表格行已解析渲染（line-table DOM 结构存在），但定型登记点无
  处触发，M6a 首采登记为「未接线」（na 不判 FAIL）。B4 落地后回填定档。
  首跑产物即 `reports/suite-report-<date>.json` 入库；实测稳定后按实测回写
  `budgets.mjs` 并附更新理由（**禁止静默放宽**）。
- **M3 首跑发现（上报主 Agent）**：直刷写后相邻行用户选区被折叠
  （诊断：rangeCount=1 且 anchorInDoc=true 但所选文本变空）——即 A6 §6
  预测的「直刷写死选区」既有缺陷被量化证实，属 B3 域（选区跨直刷行纳入
  canDirect 禁入条件）修复面；M3 指标是 B3 修复的验收面。
- **fence30 组合的 ci 档语义**：headless 软渲染下 fence 重放首轮成本
  （R6 已记载软件渲染惩罚，本机首跑实测 frameP95≈98ms、长任务 3 次）——
  ci 档该组合如实 FAIL，判定语义 = 回归趋势基线（对比首跑快照），
  **nightly GPU 档才是 fence 达标判定位**（R6 GPU 实测达标）。
- **M5c 仅 nightly 判定**（ci 单轮曲线只判 M5a/M5b）；**M6 仅 nightly/local**
  跑（ci 档不执行，场景注册表按档位过滤）。

## 防抖（环境噪声治理，A6 §3.4）

1. **环境指纹**：UA / hardwareConcurrency / deviceMemory / CDP
   `SystemInfo.getInfo` GPU vendorId+renderer（SwiftShader 软件渲染 vs GPU）
   写入报告头部——渲染后端归属可审计；
2. **样本口径**：每组 ≥5 采样取中位数 + 3σ 离群剔除（`lib/stats.mjs`）；
3. **场景 3 轮重复**（nightly 可加）；ci 单轮但判定以中位数/长任务/0 容忍为主；
4. **渲染后端敏感指标分档**：M1b 按 tier 阈值隔离（headless 20ms / GPU 12ms）；
5. **运行期守卫**：场景间 CDP `HeapProfiler.collectGarbage` + 5s 冷却；
6. **基准快照机制**：首跑产物即基准快照入库（AGENTS.md 测试资产铁律），
   回归判定 = 当前产物 vs 快照。

## 口径与边界（诚实标注）

- **M2a 锚点采样**：锚点行按 data-index 跨帧跟踪（优先沿用上一帧锚点行，
  其滚出视口才切换——防「每帧切换 → 零采样」）；切换帧跳过采样
  （anchorSwitchFrames 计入报告），切换不产生假脱节；
- **M3 直刷 chunk 计数**：帧采样对比「视口内最后一个 token span 文本
  长度」增长（MutationObserver 观察全容器在流式渲染下会饿死主线程，
  实测卡死，弃用）；选区验证仅在直刷写后的帧执行（虚拟化卸载视口外行
  导致的选区失效是正常语义，不计丢失——防误报）；引擎登记点
  `recordSelectionLost` 接线后切换引擎侧口径（engineProbe 标注 wired/pending）；
- **M3 选区行挂载与滚动稳定**：setText 后引擎可能异步复位滚动位置
  （实测：设置 scrollTop 后被复位为 0，与前一场景文档规模相关）——
  探针用「滚动读回值稳定」轮询重试 + 目标行挂载轮询等待，不依赖时序猜测；
- **M1a JS 段**：rAF 回调体打点近似（含被迫同步 layout），非 trace 级归因；
  L2 trace（nightly）为权威分解；
- **M6 表格场景**：滚动尾部跟随（表格行追加在文档末尾，视口不跟随则
  表格不渲染不计数——实测踩坑）；列宽定型为页面侧包装计数，未改动引擎
  源码；引擎侧零调用时如实登记「未接线」；
- **场景预热归一**：矩阵/滚动场景在采样前「触底→回中」预热——首次滚动
  触发的全量测量/物化/解析（fence 重放等）落在采样窗口外（R6
  flushStreamTail 归一教训同源，防抖第 5 条落地）；
- **node 降级**：仅 store 层纯函数基准（加载/append/insert 中位数），
  浏览器专属项标记未采集，不阻塞其余指标。

## CI 接入建议（待主 Agent 裁决排期）

`package.json` 新增 `"test:bench": "node tests/perf/suite/runner.mjs"`
（默认 PERF_TIER=ci；Windows 用 `$env:PERF_TIER='nightly'` 传值，npm script
不内联 env 语法）；ci 档挂 CI slow 层或独立 job，nightly 挂定时任务；
任何一层失败阻塞合并，严禁 `--no-verify` 绕行（AGENTS.md 零容忍条款）。

## 相关文档

- 设计：`docs/analysis/plan-A6-基准固化.md`（指标清单 M1-M6 + 套件架构 +
  三档 + 防抖）
- 评审：`docs/analysis/review-P3-方案评审.md`（M2a 相对脱节口径修订 +
  B6 顺带 playwright.config.ts 冲突修复的判定依据）
