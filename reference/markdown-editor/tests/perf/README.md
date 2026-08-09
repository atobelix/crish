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

---

# R3-D 流式注入验证（2026-08-09，500 token/s）

> 定位：验证「500 token/s 流式注入 + 60fps 保底（rAF 帧间隔 P95 < 16.6ms）」目标，
> 对齐 `docs/analysis/01-性能帧率路线.md` §4.1 流式帧 / §4.3 流式专项预算。
> 原始数据：`stream-inject-report.json`（本目录，采集脚本 `stream-inject-500.mjs`，
> `runs` 数组累积 headless 与 GPU 两轮）。

## 十一、方法（与 R0/R2 的差异点）

- **注入形态**：token 级 push（500 token/s 时间戳节拍，`setInterval(1ms)` 驱动）经
  「内联 StreamBuffer」（rAF 合并）→ **每帧 1 chunk → `store.appendText`**——对齐
  01 文档 §4.3「StreamBuffer 按 rAF 合并，每帧注入 ≤1 个 chunk」；60Hz 下每帧
  ≈8.3 token、GPU 100Hz 下每帧 ≈5 token（≈任务书「每帧 2-3 token 追加」量级）。
  收口 = `store.flushStreamTail()`（= streamEnd 的 stop-flush 语义）。
- **接线说明（诚实记录）**：`App.tsx` 未把 MarkdownEngine 的 engineRef 暴露到
  window（R5 宿主 `streamAppend/streamEnd` 接线未落地），注入走 `store.appendText`
  常规路径——即 streamAppend 的「回落等价路径」（MarkdownEngine.tsx:364-368），
  C3 直刷（纯文本末行命令式 DOM 写）不在本次压测范围；appendText 路径比直刷更重，
  **口径保守**。
- **场景定义**（各 500 token/s × 60s ≈ 3 万 token）：
  - A 纯文本：中文单词池循环（每 8 token 一换行），60s 末文档 ≈6.4 万字符；
  - B 代码块：每 40 token 插入一个 ```` ``` ```` 代码段（开 fence + 3 行代码 + 闭
    fence，段内 token 逐字到达 = **fence 中途闭合软渲染路径**），60s 末 ≈750 段、
    9.3 万字符；
  - C 公式块：每 60 token 插入一个 `$$` 公式段（KaTeX 渲染），60s 末 ≈500 段、
    8.5 万字符；
  - D 流式 + 用户编辑：初始 100 行文档，流式期间**每 2s 一次 insertText 到中部**
    （29 次，光标自然推进）；正确性 = 最终 `getText()` 与页面内参考模型**全量
    一致**（无丢字/乱序）。
- **判定**：`P95 < 16.6ms` 为 PASS（任务口径）；场景 D 附加文本一致性断言。
  注意 60Hz 名义帧间隔 16.67ms 本身 >16.6ms——P95 落入 [16.6,16.7) 属「名义帧
  无掉帧」，请结合 `>16.7ms` / `>33.3ms` 掉帧率与长任务数综合裁决。
- **探针**：rAF 帧间隔（页面内 performance.now）、PerformanceObserver longtask、
  `performance.memory.usedJSHeapSize`（1s 采样峰值）、appendText 单 chunk 计时。
- **踩坑记录（已修复，脚本内注释留存）**：① token 生成器段序列换行曾因双重转义
  层失效变成字面 `\n`、fence 段 `segAt` 退出重置导致段连续不断（场景 B/C 被污染
  为纯代码块序列 30 万字符）——用 `String.fromCharCode(10)` 与保留段起点修复，
  修复后 B/C 文档回落至 9.3/8.5 万字符；② `new Function` 全局作用域取不到外层
  scenario，改 `eval` 函数表达式注入。

## 十二、机器环境（本次实测，与 R0/R2 同机）

| 项 | 值 |
|---|---|
| 平台 | Windows 10/11（win32） |
| Node | v24.11.0 |
| 浏览器 | Chrome 151（Playwright chromium） |
| CPU / 内存 | 12 核 / 32 GB |
| dev server | http://localhost:5173（vite，脚本自动拉起） |
| headless 轮 | `chromium.launch({ headless: true })`——软件渲染，rAF 60Hz（P50 16.7ms） |
| GPU 轮 | `PERF_HEADED=1` 有头模式——硬件渲染，rAF ~100Hz（P50 9.9ms） |

## 十三、结果表（60s × 4 场景，双环境实测）

### headless（软件渲染，同 R0/R2 口径）——四场景文本一致均 true

| 场景 | 帧数 | P50 ms | P95 ms | P99 ms | >16.7ms | >33.3ms | 长任务 | 判定 |
|---|---|---|---|---|---|---|---|---|
| A 纯文本 | 3600 | 16.7 | 18.7 | 20.3 | 1730 | **0** | 0 | FAIL |
| B 代码块 | 3600 | 16.7 | 18.6 | 20.2 | 1747 | **0** | 0 | FAIL |
| C 公式块 | 3322 | 16.7 | 36.3 | 46.4 | 1645 | 226 | 16（958ms） | FAIL |
| D 编辑+流 | 3600 | 16.6 | 18.0 | 18.5 | 1582 | **0** | 0 | FAIL |

### GPU（有头，`PERF_HEADED=1`）——四场景文本一致均 true

| 场景 | 帧数 | P50 ms | P95 ms | P99 ms | >16.7ms | >33.3ms | 长任务 | 判定 |
|---|---|---|---|---|---|---|---|---|
| A 纯文本 | 6000 | 9.8 | **13.4** | 14.1 | 0 | 0 | 0 | **PASS** |
| B 代码块 | 5882 | 9.9 | **13.3** | 14.2 | 27 | 24 | 0 | **PASS** |
| C 公式块 | 5361 | 9.9 | **14.6** | 43.2 | 254 | 232 | 13（841ms） | **PASS** |
| D 编辑+流 | 5983 | 10.0 | **10.2** | 10.7 | 16 | 4 | 0 | **PASS** |

### 数据层单 chunk 成本（appendText，帧合并形态）

| 场景 | 浏览器 chunk P50/P95 ms（GPU 轮） | node 回放 P50/P95 ms |
|---|---|---|
| A 纯文本 | 0.2 / 0.3 | 0.022 / 0.056 |
| B 代码块 | 0.3 / 0.7 | 0.021 / 0.041 |
| C 公式块 | 0.3 / 0.7 | 0.015 / 0.035 |
| D 编辑+流 | 0.2 / 0.5 | 0.011 / 0.022 |

## 十四、结论

1. **GPU 渲染后端下四场景全部 PASS**（P95 10.2-14.6ms < 16.6ms，60fps 保底达成，
   实际 ~100Hz 运行）：纯文本/代码块/公式块/并发编辑四条流式路径的帧率均达标。
2. **场景 D 正确性：通过**——流式 60s 期间 29 次用户编辑（中部 insertText），
   最终文本与参考模型全量一致（无丢字/乱序），且 GPU P95 10.2ms（四场景最低，
   编辑触发的尾段合并/记账未引入额外帧负担）。
3. **headless（软件渲染）下 A/B/D P95 18.0-18.7ms**：超预算 1.4-2.1ms，但
   33ms+ 严重掉帧为 0、长任务为 0——与 R2 重测结论一致（headless layout/paint
   惩罚需 GPU 复测定论，`baseline-20260809-r2.json` §九.2）；GPU 复测证实
   结论归属渲染后端，非引擎流式路径本身。
4. **公式块是唯一间歇掉帧源**：场景 C 在 GPU 下仍有 13 次长任务（841ms）、
   232 帧 33ms+（P99 43.2ms）——KaTeX 渲染在公式 fence 闭合瞬间集中触发，
   headless 下放大到 P95 36.3ms。建议后续轮次专项（KaTeX 渲染节流/队列或
   公式样本缓存，01 文档问题 1 的 math 样本表思路）。
5. **数据层完全吸收 500 token/s**：单 chunk append 浏览器 P95 ≤0.7ms、node
   回放 ≤0.06ms（COW 尾段路径，01 文档 §4.3 预算 ≤0.6ms 达标）；8.5-9.3 万
   字符文档（fence/公式密集）下 chunk P95 仍 ≤0.7ms。

## 十五、复现

```bash
node tests/perf/stream-inject-500.mjs              # headless 60s × 4 场景
PERF_HEADED=1 node tests/perf/stream-inject-500.mjs # GPU 复测（对比渲染后端影响）
node tests/perf/stream-inject-500.mjs --node-only   # node 数据层回放（秒级）
# 环境变量：STREAM_DURATION_MS / STREAM_TPS / PERF_BASE_URL
```

数据落盘：`stream-inject-report.json`（`runs` 数组按轮累积，顶层为最新一轮）。

## 十六、文件清单

| 文件 | 说明 |
|---|---|
| `stream-inject-500.mjs` | R3-D 采集脚本（浏览器 + node 双模式，多轮 runs 累积） |
| `stream-inject-report.json` | R3-D 原始数据产物（headless + GPU 两轮全量样本汇总） |

---

# R6 终验复测（2026-08-10，R6-B 验证）

> 定位：R2 六项改造 + R3（R3-A stop-flush / R3-B1 访问器切换）+ R5 功能轮（R5-A 实例
> 工厂 / R5-B InlineRuler / R5-C 渲染注册表 / R5-D DecorationSet）全部落地后的终验复测，
> 与 R0（`baseline-20260809.json`）、R2（`baseline-20260809-r2.json`）、R3 GPU
> （`stream-inject-report.json` runs[1]）同机同口径对比。
> 原始数据：`final-verify-report.json`（采集脚本 `final-verify.mjs`，部分模式可合并）。

## 十七、终验方法（与既往轮次的差异点）

- **交互项口径完全复刻 R0/R2**：页面内 `performance.now()`、5 次采样中位数、rAF 帧间隔
  统计、R2 版渐进行导航（headless 行高漂移修复）、`flushStreamTail()` 击键前归一；
- **流式注入口径完全复刻 R3-D**（`stream-inject-500.mjs` 源码内嵌复用）：token 级 push
  （500 token/s 时间戳节拍）经内联 StreamBuffer rAF 合并 → 每帧 1 chunk →
  `store.appendText`；GPU 有头优先，headless 兜底参考；场景 D 附加文本一致性断言；
- **终验新增探针**：
  - 滚动场景 longtask 计数（PerformanceObserver，R0/R2 未采集）；
  - 内存稳态：沿用 R3 流式场景堆探针（1s 采样 + 起止快照），显式汇总 60s 注入堆增长；
- **引擎现状（实测时核实）**：R3-B1 访问器切换已落地（MarkdownEngine 不再订阅
  `state.lines`）；R2-G KNOWN-DEFECT 已修复（applyChange 前置 `mergeTailInto` +
  显式清空尾段键）；R5.5 宿主 streamAppend 接线**未落地**——流式注入仍走
  `store.appendText` 常规路径（streamAppend 回落等价路径），口径保守；
  `materializeViews` 仍在 set 热路径（EditorStore.ts:1003）——流式期间尾段非空时
  每次 setState 仍 O(全文) concat 物化。

## 十八、机器环境（与 R0/R2/R3 同机）

| 项 | 值 |
|---|---|
| 平台 | Windows 10/11（win32） |
| Node | v24.11.0 |
| 浏览器 | Chrome 151（Playwright chromium 1.62.1） |
| CPU / 内存 | 12 核 / 32 GB |
| dev server | http://localhost:5173（vite，运行中） |
| headless 轮 | 软件渲染，rAF 60Hz（交互项同 R0/R2 口径） |
| GPU 轮 | `--stream-only`（有头）硬件渲染，rAF ~100Hz（流式同 R3-D GPU 口径） |

## 十九、终验结果表

### 交互项（headless，同 R0/R2 口径）

| 指标 | R0 | R2 | 终验 | R0→终验 | R2→终验 |
|---|---|---|---|---|---|
| 百万行加载（setText 完成） | 18495 ms | 11441.8 ms | **12250.9 ms** | **-33.8%** | +7.1% |
| append@1M 端到端（中位） | 2.5 ms | 6.2 ms | **6.6 ms** | +164% | +6.5% |
| append@1M 数据层净值 | 无此口径 | 2.9 ms | **3.0 ms** | — | +3.4% |
| append@1M 主数组重建 | true（全量浅拷贝） | false | **false** | 尾段零拷贝成立 | 成立 |
| 击键 store 层（50 万行中部，中位） | 1.2 ms | 1.6 ms | **0.9 ms** | **-25%** | -43.8% |
| 击键全链路（input 事件→落定，中位） | 8.0 ms | 17.4 ms | **1.0 ms** | **-87.5%** | **-94.3%** |
| ArrowLeft 均值 | 13.8 ms/键 | 14.2 ms/键 | **14.5 ms/键** | +5.5% | +2.1% |
| ArrowLeft P95 | 17.0 ms | 15.7 ms | **17.4 ms** | +2.4% | +10.8% |
| 滚动帧 P50 / P95 / P99 | 16.8 / 20.9 / 26.4 ms | 16.8 / 21.8 / 35.4 ms | **17.0 / 21.8 / 39.2 ms** | +1.2% / +4.3% | +1.2% / 0% |
| 滚动 layoutThrash 增量 | +270 | +180 | **+179** | **-33.7%** | -0.6% |
| 滚动长任务（3s） | 未采集 | 未采集 | **1 次（99ms）** | 终验新增探针 | — |

### 流式四场景（GPU 有头，500 token/s × 60s，对比 R3 GPU）

| 场景 | R3 GPU P95 | 终验 P50 / P95 / P99 | >16.7ms | 长任务 | 文本一致 | 档位判定 |
|---|---|---|---|---|---|---|
| A 纯文本 | 13.4 ms | 9.9 / **13.6** / 17.7 | 80/5841 | 0 | true | **60fps PASS**（等效 101Hz，120fps 名义未达） |
| B 代码块 | 13.3 ms | 10.0 / **14.3** / 19.3 | 144/5755 | 0 | true | **60fps PASS**（等效 100Hz） |
| C 公式块 | 14.6 ms | 67.9 / **140.8** / 177.9 | 585/952 | **575（56861ms）** | true | **60fps FAIL（等效 15Hz）——严重回归** |
| D 编辑+流 | 10.2 ms | 10.0 / **11.5** / 13.5 | 37/5979 | 0 | true | **60fps PASS**（等效 100Hz，四场景最低） |

> 场景 C 三轮复测（首轮 P95 186.5 / 单场景重跑 167.2 / 完整轮 140.8），回归稳定复现。

### 内存稳态（60s 注入后 JS 堆，performance.memory）

| 场景 | 起→止 MB | 增长 | 峰值 MB |
|---|---|---|---|
| A 纯文本 | 22.1→65.2 | **+43.1** | 70.9 |
| B 代码块 | 65.2→106.8 | **+41.6** | 102.0 |
| C 公式块 | 106.8→28.5 | -78.3（GC 回收） | 163.9 |
| D 编辑+流 | 37.5→64.4 | **+26.9** | 93.5 |

> 60s 内无泄漏迹象（增长与文档规模/渲染产物滞留量级相符；C 场景峰值 163.9MB 与
> KaTeX 渲染产物滞留相关，长任务间隙 GC 后回落至 28.5MB）。

## 二十、终验结论（诚实记录）

1. **四项达成 / 保持**：击键全链路 **1.0ms（R0 -87.5% / R2 -94.3%）**——R3-B1 访问器
   切换（引擎不再订阅物化视图）后编辑落定的同步渲染成本大幅回落，R2 时 17.4ms 的
   headless 软件渲染惩罚被根治；流式 A/B/D 三场景 GPU 全 PASS（P95 11.5-14.3ms，
   vs R3 10.2-13.4ms 基本持平）；百万行加载 12251ms（R0 -33.8%）；滚动
   layoutThrash +179（R0 -33.7% 保持），滚动长任务 ~0。
2. **一项严重回归（重点上报）**：流式场景 C（公式块）GPU 下 P95 140.8-186.5ms、
   575 次长任务（总 56861ms）、等效 13-15Hz——R3 GPU 同口径 14.6ms/13 次长任务，
   **放大 36-44 倍**。三轮复测稳定复现。文本正确性仍通过（一致性无损坏），但帧率
   判定 FAIL。**疑似根因**（供主 Agent 裁决，需 R5 轮负责人验证）：R5-D
   DecorationSet 的 decorationVersion 全行刷新机制——appendText 每帧平移光标 →
   光标装饰变更 → 版本号递增 → 全窗口行 memo 失效 → 每帧全量重渲染 → 可见 math
   块每帧重跑 KaTeX `renderToString`（R3 时 LineItem 行级订阅光标，仅光标行
   重渲染，math 块不重跑）。旁证：A/B/D 场景（块渲染廉价）无长任务，仅 C（KaTeX
   重）爆表。
3. **两项持平 / 未解决（R2 遗留确认）**：ArrowLeft 14.5ms/键（R0 13.8 +5.5%，
   P95 17.4）——`getText()` 全量 join（O(全文)）仍是每键主成本，R5 功能轮未覆盖，
   R2 结论 3 预判成真；滚动帧 P95 21.8ms（R0 20.9 +4.3%，同口径强制 0↔maxTop
   跳变最坏情形，60fps 判定 FAIL——但长任务 ~0、layoutThrash 维持 -34%，
   与 R0/R2 同口径可比）。
4. **append@1M 端到端 6.6ms 未回落**：R2 结论 2 预测「R2-BD 切换访问器后物化成本
   移除」**未兑现**——`materializeViews` 仍在 set 热路径（EditorStore.ts:1003-1038），
   流式期间尾段非空时每次 append 仍 O(全文) concat（实测物化中位 3.6ms 主导端到端）。
   数据层净值 3.0ms（主数组不重建、clone 0ms 成立）。建议后续轮次真正移除
   materializeViews（R2-BD 收尾项）。
5. **内存稳态通过**：四场景 60s 注入堆增长 +26.9~+43.1MB（C 场景 GC 回收后回落），
   峰值 ≤163.9MB，无泄漏迹象；D 场景（编辑+流式）增长最低 +26.9MB。

## 二十一、复现

```bash
node tests/perf/final-verify.mjs                  # 完整终验（交互项 headless + 流式 GPU）
node tests/perf/final-verify.mjs --interactive-only  # 只跑交互项（~1 分钟）
node tests/perf/final-verify.mjs --stream-only       # 只跑流式四场景（GPU，~4.5 分钟）
STREAM_SCENARIO=C-math-fence node tests/perf/final-verify.mjs --stream-only  # 单场景复测
node tests/perf/final-verify.mjs --compare-only      # 复用产物重打对比表
```

数据落盘：`final-verify-report.json`（部分模式与既有产物合并，保留旧指标键）。
