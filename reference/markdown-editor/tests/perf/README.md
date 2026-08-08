# R0 性能基线采集（2026-08-09）

> 定位：为「百万行文档 + 500 token/s 流式 + 60/120/140fps」目标采集**修复前**量化基线，
> 并证实已知性能问题：`appendText` 每次全量浅拷贝 lines 数组（O(全文)）。
> 对齐分析文档：`docs/analysis/01-性能帧率路线.md`（问题 3/5/6 的 P0/P1 项）。
> 原始数据：`baseline-20260809.json`（本目录，由采集脚本生成）。

## 一、采集方法

### 脚本用法

```bash
node tests/perf/baseline-collect.mjs               # 浏览器模式（默认）
node tests/perf/baseline-collect.mjs --node-only   # node 降级模式（仅 store 层纯函数基准）
node tests/perf/baseline-collect.mjs --no-browser  # 跳过浏览器探测，直接降级
PERF_BASE_URL=http://localhost:5173 node tests/perf/baseline-collect.mjs  # 覆盖 server 地址
```

### 浏览器模式前置条件

- 5173 已存在 dev server（`npm run dev`），或脚本自动拉起 vite（`npm run dev`，40 秒内轮询就绪）；
- Playwright chromium 已安装（`npx playwright install chromium`）；
- 浏览器模式失败时脚本**自动降级**为 node 模式（仅报 store 层数据，浏览器专属项标记未采集），不会空手而归。

### 计时口径（避免外部计时污染）

| 项 | 口径 |
|---|---|
| 计时来源 | 全部在页面内 `performance.now()` 环绕，Playwright 只负责驱动与收集结果 |
| 样本口径 | 每组 ≥5 次采样，报告中位数（抗 GC / JIT 预热噪声） |
| 帧间隔 | 页面内连续 rAF 打点，报告 P50 / P95 / P99 与 >16.7ms 掉帧数 |
| 文档构造 | 纯文本行 `'L'+i+'_'*20`（无 fence / 表格 / 标题），隔离数据层成本 |
| 加载完成判定 | `setText` 返回后轮询 `lines.length` 达到目标行数（分块加载走 requestIdleCallback） |
| 击键全链路 | 隐藏 textarea 走 native value setter + `input` 事件 → `insertText` → React 提交 → 光标层测量落定 |
| 光标移动 | 真实 `keydown`(ArrowLeft) 事件派发，计时到 store 状态落定（含 `getText()` 全量 join 成本） |
| 滚动场景 | 每帧强制 `scrollTop` 在 0 ↔ 文档底部间跳变，制造每帧全窗口重排 + 测量压力 |

### node 降级模式

`vite.ssrLoadModule('/src/core/EditorStore.ts')` 在 node 进程内直接加载 store（无 window，走 `setTimeout` 分块分支），
只跑：setText 加载计时、insertText store 层、append 拷贝曲线三组纯函数基准。

## 二、机器环境（本次实测）

| 项 | 值 |
|---|---|
| 平台 | Windows 10/11（win32） |
| Node | v24.11.0 |
| 浏览器 | Headless Chrome 151.0.7922.34（Playwright chromium） |
| UA 语言 | zh-CN |
| CPU 逻辑核 | 12（navigator.hardwareConcurrency） |
| 内存 | 32 GB（navigator.deviceMemory） |
| dev server | http://localhost:5173（vite，运行中） |
| rAF 名义帧率 | 60Hz（P50 帧间隔 16.7ms） |

## 三、结果表（浏览器模式实测）

| 指标 | 数值 | 说明 |
|---|---|---|
| 百万行加载（setText 完成） | **18.50 s** | 同步 53.6ms + 分块 18.4s；每 chunk 全量浅拷贝 lines + clone offsets + 全窗口重渲染 |
| 中部击键（50 万行第 25 万行，store 层） | **1.2 ms**（中位，样本 0.9-1.8） | 纯数据层：`[...lines]` + `lineOffsets.clone()` + codeBlockState 拷贝 + fence 重放 |
| 中部击键（全链路，含 React + 光标测量） | **8.0 ms**（中位，样本 5.5-19.7） | store 层 + 渲染提交 + 双份光标测量；首样本含 JIT 预热 |
| 光标移动 ArrowLeft ×100（50 万行） | 均值 **13.8 ms/键**，P50 13.4 / P95 17.0 | 主成本为每次 `getText()` 全量 `lines.join()`（O(全文)）+ 测量 |
| 快速滚动帧间隔（100 万行） | P50 **16.8 ms** / P95 **20.9 ms** | 179 帧中 91 帧 >16.7ms（51% 掉帧）；layoutThrash +270 次 getBoundingClientRect |

> 注：头部双开浏览器模式轮次间存在 headless 调度噪声（加载 18.5-20.4s、store 层击键 1.2-3.9ms），
> 结论方向一致；本表数值以 `baseline-20260809.json` 当前内容为准。

### appendText 拷贝量实测（证实 O(全文) 浅拷贝）

| 行数 | 数组引用变化 | 首元素共享 | 纯浅拷贝中位（[...lines]） | offsets.clone() 中位 | appendText 端到端中位 |
|---|---|---|---|---|---|
| 1 万 | true | true | <0.01 ms | <0.01 ms | <0.05 ms |
| 10 万 | true | true | <0.01 ms | <0.01 ms | 0.2 ms |
| 50 万 | true | true | 0.3 ms | 0.4 ms | 1.2 ms |
| 100 万 | true | true | 0.5 ms | 1.1 ms | 2.5 ms |

- **引用变化 = true**：每次 appendText 都生成全新的 lines 数组（`[...state.lines]`，EditorStore.ts:530）；
- **首元素共享 = true**：新数组元素与旧数组为同一批字符串引用——确认为**浅拷贝**（拷贝的是 100 万个指针，字符串本体不复制）；
- 曲线结论：三段耗时均随行数**近似线性增长**（10 万→100 万行：端到端 0.2→2.5ms，10 倍行数 10 倍耗时），与「O(全文) 每次流式 chunk」的定性一致——500 token/s 流式下每次 chunk 都要重抄全文，百万行时单 chunk 2.5ms 起、且随文档增长持续恶化（node 降级模式同构验证：0.03→0.5→1.5→3.6ms，曲线更干净）。

### 与修复目标对照（docs/analysis/01 §3.3 / §4.2 预算）

| 路径 | 基线实测 | 修复目标 | 差距 |
|---|---|---|---|
| 击键 store 层（50 万行中部） | 1.2-3.9 ms | ≤1 ms | 2-4 倍 |
| appendText 单 chunk（100 万行） | 2.5-3.0 ms | ≤1 ms（COW 后 O(256)） | 3 倍 |
| LineOffsetTree.clone()（100 万行） | 1.1-1.2 ms | 0.05-0.1 ms（块级 COW） | 11-24 倍 |
| 滚动帧（强制快速滚动） | P95 20.6-20.9ms，~50% 掉帧 | ≤1.5 ms JS | 需命令式位置更新（P6） |
| 光标移动（ArrowLeft） | 13.8-14.5 ms/键 | 击键帧 ≤1 ms | getText() 全量 join 需消除 |

## 四、复现与扩展

- 重跑：`node tests/perf/baseline-collect.mjs`（浏览器模式）后更新本表与 `baseline-20260809.json`；
- 注意：基准为**纯文本**文档构造，真实文档（标题/表格/math/代码块）的 fence 重放（问题 4）与行高测量（问题 1）成本不在本次范围内，建议后续轮次补充专项；
- 修复后对照：同一脚本重跑即得「修复后」曲线，与本表直接对比验收 P3/P5/P6 收益。

## 五、文件清单

| 文件 | 说明 |
|---|---|
| `baseline-collect.mjs` | 采集脚本（浏览器 + node 降级双模式） |
| `baseline-20260809.json` | 本次原始数据产物（含全量样本，非仅中位数） |
| `README.md` | 本文件：方法 / 环境 / 结果表 / 结论 |
