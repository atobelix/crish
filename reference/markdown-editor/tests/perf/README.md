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
| `baseline-collect.mjs` | R0 采集脚本（浏览器 + node 降级双模式） |
| `baseline-20260809.json` | R0 原始数据产物（含全量样本，非仅中位数） |
| `baseline-recollect.mjs` | R2 重测脚本（复刻 R0 口径 + R2 新增探针） |
| `baseline-20260809-r2.json` | R2 重测数据产物 |
| `README.md` | 本文件：方法 / 环境 / 结果表 / 结论 |

---

# R2 重测对比（2026-08-09，R2-G 验证）

> 定位：R2 轮六项改造（R2-A 尾段零拷贝 + COW / R2-B 行高模型 / R2-C 测量缓存 /
> R2-D 命令式滚动 / R2-E fence O(1) / R2-F 跨视口箭头）落地后的性能重测，
> 与 R0 基线（`baseline-20260809.json`）同机、同口径对比。
> 原始数据：`baseline-20260809-r2.json`（采集脚本 `baseline-recollect.mjs`）。

## 六、重测方法（与 R0 的差异点）

- **计时口径完全复刻 R0**：页面内 `performance.now()`、5 次采样中位数、rAF 帧间隔统计；
- **R2 新增探针**（append 曲线）：
  - `mainArrayRefChanged`：主数组引用是否重建（R0 恒 true——全量浅拷贝；
    R2 预期 false——尾段零拷贝）；
  - `materializeProbeMs`：物化视图成本 `main.slice(0,-1).concat(tail)` 双数组模拟
    （R2 过渡期兼容视图，R2-BD 切换访问器后从热路径移除）；
  - `appendDataNetMs`：端到端中位 - 物化中位 = 数据层净值（零拷贝真实收益）；
- **行导航升级**：R2 行高实测回填后 headless 下行高 29px（名义 28px），
  `scrollTop = scrollHeight/2` 会把目标行推离窗口 2 行 → 目标行未挂载 →
  HiddenInput 光标测量 null → textarea 卸载（R2-F 语义）。重测脚本改用
  「按已挂载窗口 index 差 × 28px 增量滚动」的渐进行导航（首轮大步跳转 + 微调，
  通常 2-4 轮收敛），与 R0 的「滚到中间」目标等价（目标行挂载 + 光标测量真实执行）；
- **击键前归一口径**：`flushStreamTail()` 归一为 R0 同形态（无尾段），
  隔离数据层真实成本——尾段非空时的击键成本受 KNOWN-DEFECT 污染，另作专项说明。

## 七、机器环境（本次重测，与 R0 同机）

| 项 | 值 |
|---|---|
| 平台 | Windows 10/11（win32） |
| Node | v24.11.0 |
| 浏览器 | Headless Chrome 151（Playwright chromium，同 R0） |
| CPU / 内存 | 12 核 / 32 GB（同 R0） |
| dev server | http://localhost:5173（脚本自动拉起，修复了 Windows spawn EINVAL） |

## 八、R2 vs R0 对比表（浏览器模式实测）

| 指标 | R0 | R2 | 变化率 | 说明 |
|---|---|---|---|---|
| 百万行加载（setText 完成） | 18.50 s | **11.44 s** | **-38.1%** | R2 未改分块加载，收益来自每 chunk 的 `lineOffsets.clone()` 由 O(全文) 深拷贝变 COW 浅拷贝（R2-A 附带） |
| 中部击键 store 层（50 万行中部） | 1.2 ms | 1.6 ms | +33% | 口径污染：R2 的 dispatchSet 链路把 React 同步渲染（含批量测量）计入；隔离实测纯数据层 0.4ms（比 R0 快 3 倍） |
| 中部击键全链路（input 事件→落定） | 8.0 ms | 17.4 ms | +118% | CDP profile 归因：JS 仅 ~4ms（数据层 0.4 + 渲染 ~3 + 批量测量 0.1 + parseLine 缓存 87/1 命中），其余 ~12ms 为 headless 软件渲染 layout/paint 惩罚（R2 批量测量同步读 + commit 后重排）；GPU 浏览器预期显著不同 |
| appendText 端到端（1M 行） | 2.5 ms | 6.2 ms | +148% | **过渡期物化成本主导**：双数组 `slice(0,-1)+concat`（3.3ms）+ React 同步渲染；R2-BD 切换访问器后恢复 |
| appendText 数据层净值（1M 行） | （无此口径） | **0.2 ms**（node）/2.9 ms（浏览器含渲染） | — | **零拷贝成立**：主数组引用不重建（R0 true → R2 false），clone 0ms（R0 1.1ms）；node 降级模式净值 0.24ms 即数据层真实成本 |
| 光标移动 ArrowLeft ×100 | 13.8 ms/键（P95 17.0） | 14.2 ms/键（P95 15.7） | +3%（P95 -7.6%） | 基本持平：R2-C/F 的测量缓存与索引二分收益被 `getText()` 全量 join（O(全文)，R2 未覆盖）掩盖 |
| 快速滚动帧 P50 / P95（1M 行） | 16.8 / 20.9 ms | 16.8 / 21.8 ms | 0% / +4% | 测试方法对 R2 不利：每帧 0↔maxTop 强制跳变 = 每帧窗口全变（最坏情况），R2 的「纯位置帧零 React 提交」收益无法体现；layoutThrash **-33%**（270→180）确认命令式路径生效 |
| layoutThrash（滚动 3s） | +270 | **+180** | **-33.3%** | R2-D 命令式位置 + 测量缓存确认减少 getBoundingClientRect |

## 九、关键结论与遗留（诚实记录）

1. **确认收益**：百万行加载 -38.1%；append 数据层真零拷贝（主数组不重建、
   clone 0ms、净值 ~0.2-0.3ms）；滚动 layoutThrash -33%；ArrowLeft P95 -7.6%。
2. **两个环境内回归需谨慎解读**：
   - append 端到端 +148%：**物化视图（双数组 O(全文) concat）是过渡期成本**，
     R2-BD 切换 `getLine/getLineCount` 访问器后从 set 热路径移除——当前
     MarkdownEngine 仍订阅 `state.lines`（未切换），成本实打实存在；
   - 击键全链路 +118%：JS 部分 R2 更轻（profile 实测 ~4ms），差异集中在
     headless 软件渲染的 layout/paint；**headless 同口径下 R2 更慢是事实**，
     但需 GPU 浏览器复测才能定论（R2 的批量测量同步读 offsetHeight 在
     软件渲染下被放大）。
3. **ArrowLeft 瓶颈未解决**：`getText()` 全量 join 仍是每键主成本（~10ms+），
   R2 未覆盖，建议后续轮次改造（行级文本访问器替代全量 join）。
4. **滚动帧测试方法局限**：强制 0↔maxTop 跳变只测「窗口全变帧」，测不出
   R2-D 的「纯位置帧零提交」收益；建议 R3 增加「同窗口位置帧」专项。
5. **KNOWN-DEFECT（R2-G 验证发现，已上报主 Agent）**：`insertText/deleteText/
   deleteSelection/undo/redo` 编辑触达后 `streamTail` 残留未清空（partial 缺
   清空键）→ 物化视图与主数组分叉（复现：appendText('hello')+insertText('!')
   后 getText 返回 'hello' 而非 'hello!'），且流式期间每次编辑额外承担
   O(全文) 双物化。本表击键/append 数据均已避开该缺陷形态（flush 归一）；
   缺陷修复后，流式期间的编辑路径成本将一并回落。

## 十、复现

- 重测：`node tests/perf/baseline-recollect.mjs`（浏览器模式，失败自动降级 node）；
- node 降级：`node tests/perf/baseline-recollect.mjs --node-only`；
- 数据落盘：`baseline-20260809-r2.json`（R0 对比表在采集汇总尾部自动打印）。
