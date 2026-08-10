# 方案 A1：scroll factor（逻辑↔物理高度缩放）极致版分析

- 分析对象：`reference/markdown-editor` 滚动链路（HeightMap / tanstack virtual / 光标测量 / 输入层）
- 目标：消除浏览器滚动高度上限（≈3350 万 px）对百万行文档的截断，**体验与性能都要、避免任何跳动、多方案对比**
- 需求口径：100 万行 × 28px ≈ 2800 万 px 接近触顶；120 万行 × 28px ≈ 3360 万 px 必踩
- 本文产出：现状证据 / 多方案对比（含推荐）/ 映射边界清单 / 启用与切换机制 / 测试方案

---

## 零、结论先行

1. **现状**：滚动高度 = `HeightMap.totalHeight`（逻辑）经 tanstack `totalSize` 直写内容 div 的 `style.height`，1:1 无缩放；120 万行必触浏览器上限，触顶后「拖到底 ≠ 文末」、滚动条损坏。
2. **推荐方案 B（分段映射：视口 1:1 + 远端压缩）**：新增 O(1) 换算层 `scrollMap.ts`（逻辑↔物理双向），行渲染 top、光标测量、点击定位、HeightMap 全部保持逻辑坐标；仅滚动容器物理侧（scrollTop 读数、内容 div 高度、tanstack 两个接线点）走换算。
3. **跳动风险可归零的结构性理由**：换算层是**纯读**（scroll 事件内不写 scrollTop），不引入「写回校正」类回弹源；滚动中 f 不变（偏差常数 C 守恒）；H 变化（流式/回填）时重参数化保持**视口锚点**（f(视口顶)=物理 scrollTop），视口内容零位移，视口外重分布不可见。
4. **方案 A 致命伤**：全局线性缩放破坏滚动条比例与滚动速度手感，且「拖到底不可达」的校正必须写回 scrollTop → 与原生拖动/惯性回弹，跳动风险最高。
5. **方案 C 最干净但交互成本最高**：自绘滚动条 + 自绘惯性，放弃浏览器滚动条生态，作为 B 的远期替换登记。
6. **方案 D（行高压缩）不可行**：绝对定位行视觉重叠/文本溢出；若只压缩滚动坐标则等价于 B。

---

## 一、现状盘点

### 1.1 滚动高度产生链路（代码证据）

```
HeightMap.totalHeight（逻辑总高，行高和）
  └─ HeightMap.ts:274-277  get totalHeight()（读前 flush）
  └─ 行高来源：oracle 预测 + 实测回填（syncTo 追加 HeightMap.ts:392-415、
     批量测量回填 MarkdownEngine.tsx:956-1008，稳定点阈值 0.5px）
        ↓
tanstack useVirtualizer estimateSize（MarkdownEngine.tsx:578-614，HeightMap 存储值优先）
  └─ 内部累加为 totalSize（逻辑总高，1:1）
        ↓
react-virtual applyContainerSize：内容 div style.height = totalSize px
  └─ node_modules/@tanstack/react-virtual/dist/esm/index.js:26-35（directDomUpdates 写总高）
  └─ 挂载时 containerRef 同样直写（同文件 90-101）
        ↓
滚动容器 .editor-container.editor-scroll-container（overflow:auto，MarkdownEngine.tsx:1383-1418）
  └─ scrollHeight = 内容 div 高度 + padding（14×2）+ marginTop（14）≈ totalHeight + 28
```

关键事实：
- **内容 div 高度只影响滚动条显示范围**，不参与窗口计算（窗口计算 = `getScrollOffset()` 读 scrollTop + itemSizeCache 累加，见 virtual-core observeElementOffset）。这意味着**内容 div 高度可以与 tanstack 的 totalSize 解耦、由引擎接管**——这是方案 B 物理总高钳制的落地 hook。
- 行 top 是逻辑绝对坐标（directDomUpdates position 模式写 `el.style.top = virtualRow.start`，react-virtual esm index.js:36-57），滚动时行 top 不变、由浏览器滚动容器平移——**行渲染坐标天然在逻辑域**。

### 1.2 触顶行为

- Chromium 最大可滚动/布局高度 ≈ 33,554,428px（2^25 − 4，约 3350 万）。Firefox 上限更高，Safari 同量级。
- 触顶表现：内容 div `style.height` 超过上限后被浏览器钳制 → `scrollHeight` 停在上限 → 滚动条 thumb 比例失真、**拖到底 = 物理上限位置而非逻辑文末**（尾部 60-100 万行的行无法滚入视口），滚动条损坏语义。
- 触发点：120 万行 × 28px = 33,600,000px > 33,554,428px（Heading/表格行高更高时触发更早；100 万行整 2800 万 px 已接近，流式追加/行高回填波动即可能越线）。

### 1.3 消费方清单

**读 scrollTop（物理读数，当逻辑坐标用）**：

| 位置 | 用途 |
|---|---|
| MarkdownEngine.tsx:649-650 | isRowInVisibleViewport：indexAt(el.scrollTop) 直刷行可见判定 |
| MarkdownEngine.tsx:772-774 | resolveScrollLine：indexAt(scrollTop, 28)，OutlinePanel 章节高亮 |
| MarkdownEngine.tsx:1157 | 点击 padding 映射：contentY = clientY − rect.top + scrollTop |
| HiddenInput.tsx:269-270 | collectMountedLines：行几何 → 内容坐标（拖选/翻页数据源） |
| HiddenInput.tsx:322 | indexFromClientPoint 几何回退：contentY 换算 |
| HiddenInput.tsx:732 | 光标越界滚动跟随：视口边界比较 |
| HiddenInput.tsx:1614 | pageNavigationTarget：翻页目标行计算 |
| measure.ts:467-470 / 475-482 | viewportToContent / contentToViewport（光标坐标缓存换算） |
| measure.ts:608 | posCache 键（index:scrollTop:scrollLeft） |
| measure.ts:657-661 | toContainerCoords（CursorLayer/HiddenInput 共享换算） |
| measure.ts:855 | scrollTargetLineIntoView：vTop 视口边界比较 |
| SelectionHighlight.tsx:143 | 选区矩形内容坐标换算 |
| OutlinePanel.tsx:163 | resolveScrollLine(el.scrollTop)——经 MarkdownEngine 换算后零改动 |

**写 scrollTop（物理写入）**：

| 位置 | 用途 |
|---|---|
| HiddenInput.tsx:248 | scrollLineIntoViewByGeometry：几何外推滚动跟随 |
| HiddenInput.tsx:742/744 | 光标越界滚动跟随（top ± 40） |
| HiddenInput.tsx:1005-1008 | 拖选边缘滚动（P += edgeStep，纯物理增量，自洽） |
| measure.ts:865 | scrollTargetLineIntoView：跨视口箭头滚动跟随 |
| tanstack scrollToFn（elementScroll） | scrollToIndex/scrollToOffset 命令式定位 |

**读 scrollHeight（物理钳制，与映射自洽，零改动）**：HiddenInput.tsx:216/245/1003、measure.ts:864 —— 语义均为「物理 maxScrollTop 钳制物理目标」，映射后仍成立（见 §3.4）。

**tanstack 接线点（3 处）**：`observeElementOffset`（scroll 事件读物理 scrollTop）、`scrollToFn`（写物理 scrollTop）、`containerRef/applyContainerSize`（内容 div 高度）。

---

## 二、多方案设计

### 方案 A：全局线性缩放（scrollTop × K）

**机制**：f(y) = y × K（K = MAX / H，H > MAX 时 K < 1）。行 top 保持逻辑；内容 div 高度 = f(H) = MAX；scroll 事件内物理 P → 逻辑 P/K 喂 tanstack；写 scrollTop 处逻辑目标 × K。

- 复杂度：低（一个常数 K，O(1)）。
- 滚动条：thumb 比例失真（物理总高被压缩，thumb 视觉偏大）；**位置两端对齐**（f(0)=0、f(H)=MAX），拖到底可到文末。
- 跳动风险：**高**。滚动速度失真 K 倍（滚轮 1 格内容走 1/K 格）；若为修正比例而做「拖动 thumb 时换算写回」→ 与原生拖动/惯性回弹（滚动事件内写 scrollTop 是回弹源，HiddenInput.tsx:735-739 已有同类教训注释）。
- 交互影响：光标/点击需全链路换算（视口内导数 K≠1，测量换算不能省）——改造成本与 B 相同，却没有 B 的「视口 1:1 恒等」红利；滚动手感全程失真。
- 结论：**不推荐**。除了数学最简单，其余维度均劣于 B。

### 方案 B：分段映射（视口 1:1 + 远端压缩）★ 推荐

**机制**：f（逻辑→物理）为分段线性：视口附近 1:1（导数 1），视口下方压缩段（导数 s < 1），文首到视口上方恒等（f(0)=0 与 f(1:1 区起点)=恒等强制，见 §3.1 数学推导）；f(H) = MAX 端点对齐；滚动中 f 不变（偏差常数 C = P − v 守恒）；H 变化时重参数化保持视口锚点。

- 复杂度：中。换算层 O(1) 闭式；消费方改动面 = §1.3 表（读 scrollTop 处换 helper）+ tanstack 3 接线点 + 内容 div 高度接管。
- 跳动风险：**低**。换算层纯读不写回 → 无回弹源；位置连续单调 → 无跳变；重参数化锚点保持 → 视口零位移。残余风险：压缩段内滚动「速度快」（导数 s<1 时内容快速翻页）——是速度变化而非位置跳变（登记，可选动态增强消除）。
- 交互影响：视口内滚动手感 1:1 原样（最常见路径）；压缩段（深处）快翻；滚动条 thumb 在压缩段比例略失真（位置仍正确）。光标/点击/拖选在视口附近零偏差，压缩段经换算层精确。
- 性能：滚动帧增加 O(1) 数学（f⁻¹ 一次），窗口计算/渲染路径零改动。
- 结论：**推荐**。覆盖需求（120 万行，H ≤ 2×MAX 即约 214 万行内安全），正确性由换算层保证，体验只在深处压缩段有登记权衡。

### 方案 C：物理容器固定安全高度 + 逻辑滚动位置独立（自绘滚动条）

**机制**：滚动容器不再承载真实内容高度（固定 clientHeight 或安全上限），逻辑滚动位置 v 为引擎自持变量，滚动输入（滚轮/触控板/自绘 thumb 拖动/键盘）全自绘，行 top 相对逻辑起点位移。

- 复杂度：**高**。新增自绘滚动条组件 + 惯性模拟 + 触控板动量手感对齐 + wheel/pointer 输入接管；丢弃浏览器滚动条生态（Shift+滚轮横向、滚动锚定、宿主外层滚动联动等）。
- 跳动风险：低（v 纯逻辑，无物理钳制，写回冲突消失），但**自绘惯性若质量差，体验跳变风险转移为「手感不自然」**。
- 交互影响：最大。滚动条外观/行为与宿主不一致，鼠标中键/触控板辅助功能需逐一补。
- 结论：**远期替换登记**，不在本轮实施。

### 方案 D：行高动态压缩（超限时远端行视觉高度压缩）

**机制**：超限时把远端行的「行高」按比例压缩。

- 不可行性论证：行是绝对定位（top 逻辑绝对），若行高（DOM 高度）压缩而 top 间距不压缩 → 文本溢出重叠；若 top 间距也压缩 → 行间距 28×s 且行视觉高度 28 → 行间重叠（两行文本叠在一起）。若改为整容器 transform: scaleY 压缩 → 字体变形/渲染模糊/点击命中区漂移，且压缩段不可控。**结论：D 在绝对定位虚拟滚动架构下不可行**；其可行变体（只压缩滚动坐标、不压缩渲染）就是方案 B，故 D 合并入 B。

### 2.5 方案对比表

| 维度 | A 全局线性 | B 分段映射（推荐） | C 物理容器固定+自绘 | D 行高压缩 |
|---|---|---|---|---|
| 机制 | scrollTop × K | 视口 1:1 + 远端压缩分段 | 逻辑位置独立 + 自绘滚动条 | 远端行高压缩 |
| 实现复杂度 | 低 | 中 | 高 | 不可行（渲染破坏） |
| 跳动风险 | 高（写回校正回弹/比例失真） | 低（纯读换算 + 锚点保持） | 低（无写回冲突）但手感风险转自绘惯性 | — |
| 拖到底=文末 | ✅ 两端对齐 | ✅ 两端对齐 | ✅ 逻辑直达 | — |
| 滚动条比例 | ❌ 失真 | ⚠️ 压缩段略失真（位置正确） | ✅ 自绘可控 | — |
| 视口滚动手感 | ❌ K 倍失真 | ✅ 1:1 原样 | ⚠️ 取决于自绘质量 | — |
| 光标/点击精度 | 需全链路换算 | 视口内零偏差，压缩段换算精确 | 全逻辑零偏差 | — |
| 性能 | O(1) | O(1) | 自绘惯性每帧模拟 | — |
| 适用规模 | ≤2×MAX | ≤2×MAX（B1）；B2 增强可扩展 | 无上限 | — |
| 结论 | ✗ | **✓ 本轮实施** | 远期登记 | ✗ 否 |

---

## 三、推荐方案 B 的映射边界清单（落地架构）

### 3.1 换算层核心设计（新模块 `src/core/scrollMap.ts`）

**数学约束（决定形态的关键推导）**：f 单调、f(0)=0（文首可达）、f(H)=MAX（文末可达）、视口区导数 1。上段 [0, a] 单段线性 f(y)=s·y 与 f(a)=a 联立 → s=1（恒等）——**f(0)=0 与「1:1 区起点锚定」强制视口上方单段线性只能恒等**。故 B1 形态为：

```
f（逻辑 y → 物理 p），参数 (H, v, C, MAX, m, s)：
  1:1 区（逻辑 [v−m, v+vh+m]）：f(y) = y + C          // 视口 ± m 余量，导数 1
  上方（逻辑 [0, v−m]）：      f(y) = y               // 恒等（数学强制）
  下方（逻辑 [v+vh+m, H]）：   f(y) = b + s·(y − b)   // b = v+vh+m+C（物理），
                                                      // s = (MAX − b)/(H − b)（自适应压缩因子）
  MAX = 物理总高常数（30,000,000px）；C = P − v（偏差常数，初始 0）
```

- 锚点不变式：f(v) = v + C = P（物理视口顶）——**滚动中 C 守恒**（视口内 ΔP = Δv，f 完全不变）；**H 变化（流式/回填/折叠）时保持 v、C 不变，只重算 s** → 视口内容零位移，视口外重分布不可见。
- 端点对齐：f(H) = MAX，f(0) = 0 → 拖到底 = 文末、拖到顶 = 文首。
- f⁻¹ 同结构反解，O(1) 闭式（≤3 个分支，无二分、无循环）。
- 压缩因子 s 自适应：s = (MAX − b)/(H − b)，H 越大 s 越小；s < 1/8 时登记手感警告（此时约支持 2 亿行以上逻辑规模）。
- 上方恒等的物理代价：上方逻辑高占用等量物理空间，**H ≤ 2×MAX（约 214 万行）内安全**；更大规模登记 B2 增强（上段两段折线 s1+s2=2 对称压缩，O(1) 仍成立）。

**helper API（消费方唯一入口，内部短路恒等）**：

```ts
logicalScrollTop(el): number      // 物理读 → 逻辑（内部先读 el.scrollTop 再 f⁻¹）
logicalToPhysical(l: number): number  // 逻辑目标 → 物理写入值（含 maxScrollTop 钳制）
physicalTotalHeight(): number    // f(H)，内容 div 高度写入用
enabled: boolean                 // H > 阈值才激活（见 §4）
```

### 3.2 tanstack 接线点（共 3 处，其余零改动）

| 接线点 | 现状 | 改造 |
|---|---|---|
| `observeElementOffset`（virtual-core 滚动观察） | scroll 事件 → el.scrollTop 物理直读 | 自定义 observer：物理 P → `f⁻¹(P)` 逻辑回调喂 virtualizer（useVirtualizer options 透传覆盖） |
| `scrollToFn`（elementScroll 写） | 逻辑 offset 直写 el.scrollTop | 包一层 `el.scrollTop = logicalToPhysical(offset)` |
| `containerRef` / `applyContainerSize`（react-virtual esm index.js:26-35, 90-101） | 内容 div style.height = totalSize（逻辑） | **引擎接管**：MarkdownEngine 自持内容 div ref，在批量测量 effect（MarkdownEngine.tsx:956-1008 同帧）写 `style.height = f(totalHeight)`；不再传 virtualizer.containerRef（内容 div 高度不参与窗口计算，解耦安全，见 §1.1） |

窗口计算、range 计算、行 top 写入（applyDirectStyles）、resizeItem、overscan 全部保持逻辑域，**零改动**。

### 3.3 保持逻辑坐标的消费方（零改动清单）

- **HeightMap 全部 API**：totalHeight / posOf / indexAt / getOffset / setHeight / syncTo / insert / delete（HeightMap.ts）——内部纯逻辑域，物理泄漏仅来自调用方传参（调用方在 §3.4 处理）。
- HeightOracle / classifyLine / estimateSize（MarkdownEngine.tsx:578-614）。
- 批量测量协议（offsetHeight = 逻辑行高）、稳定点回填、resizeItem。
- 折叠（FoldState）/ 大纲（HeadingIndex）/ 行号与字符偏移（LineOffsetTree / EditorStore）。
- 行渲染 top（directDomUpdates 写逻辑 start）——**行视觉高度 28px 原样，无缩放、无重叠**。
- 光标测量命中与缓存（measure.ts 的 token 索引、Range 测量本体）——仅坐标换算函数用物理读数（§3.4）。

### 3.4 需要物理换算的消费方（改动清单，文件:行号）

**读侧：裸 `el.scrollTop` 当逻辑用 → 统一替换为 `logicalScrollTop(el)`**（全部 O(1)）：

| 位置 | 说明 |
|---|---|
| MarkdownEngine.tsx:649-650 | isRowInVisibleViewport |
| MarkdownEngine.tsx:772-774 | resolveScrollLine（OutlinePanel 经此间接覆盖） |
| MarkdownEngine.tsx:1157 | 点击 padding contentY |
| HiddenInput.tsx:269-270 | collectMountedLines（拖选/翻页几何快照） |
| HiddenInput.tsx:322 | indexFromClientPoint 几何回退 |
| HiddenInput.tsx:732 | 光标越界跟随边界比较 |
| HiddenInput.tsx:1614 | pageNavigationTarget 入参 |
| measure.ts:467-470, 475-482 | viewportToContent / contentToViewport |
| measure.ts:608 | posCache 键 |
| measure.ts:657-661 | toContainerCoords |
| measure.ts:855 | scrollTargetLineIntoView vTop |
| SelectionHighlight.tsx:143 | 选区矩形换算 |

**写侧：逻辑目标 → `logicalToPhysical()`**：

| 位置 | 说明 |
|---|---|
| HiddenInput.tsx:248 | scrollLineIntoViewByGeometry（几何外推目标，远端场景） |
| HiddenInput.tsx:742/744 | 光标越界跟随（top ± 40，视口附近自动落 1:1 区恒等） |
| measure.ts:865 | scrollTargetLineIntoView（跨视口箭头） |
| HiddenInput.tsx:1005-1008 | 拖选边缘滚动——**零改动**：P += edgeStep 是纯物理增量，maxTop 读 scrollHeight 物理自洽 |

**读 scrollHeight 的钳制点（HiddenInput.tsx:216/245/1003、measure.ts:864）零改动**：语义 = 物理 maxScrollTop 钳制物理目标，映射后仍自洽（内容 div 高度 = f(H) ≤ MAX，scrollHeight 读数即物理上限）。

### 3.5 R2-D 命令式位置帧（scrollToIndex）在映射下的行为

- 调用链：scrollToMatch（MarkdownEngine.tsx:747）/ jumpToLine（MarkdownEngine.tsx:764）→ `virtualizer.scrollToIndex(lineIdx, align)` → 内部计算逻辑 offset → **自写 scrollToFn** 做 `logicalToPhysical` → 写容器 scrollTop → 浏览器滚动 → observeElementOffset 换算回读 → 窗口收敛。
- 行为保持现状语义：直接跳转、无动画、无写回冲突（一次性写，非滚动事件内校正）；跳转后视口锚定目标行。落点在 1:1 区时换算恒等，在压缩段（深处）时物理写正确。
- 滚动跟随链条（Ctrl+End / PageDown 的 HiddenInput 越界滚动、measure 的 scrollTargetLineIntoView）同理走写侧 helper，落点正确、无回弹。

### 3.6 视口内 1:1 的设计红利

- 视口内 f 导数 = 1 → 物理读数与逻辑读数相等 → 光标测量 / 点击定位 / 拖选 / 翻页 / 越界跟随的换算**退化为恒等**，正确性不依赖 1:1 假设（helper 统一走 f⁻¹，防御性精确）。
- 行 top 是逻辑绝对 → 视觉行位置 = 逻辑 top − 物理 P，与滚动输入 1:1 联动 → 滚轮/触摸板手感原生。

---

## 四、启用阈值与动态切换

### 4.1 阈值选择

- 启用阈值：**H > 30,000,000px**（约 107 万行 × 28px；按总高判定，标题/表格/回填波动自动覆盖）。留 3.5M px 余量低于 Chromium 33.55M 上限，跨浏览器安全（Firefox/Safari 上限差异吸收）。
- MAX（物理总高常数）= 30,000,000px，与阈值一致 → 启用瞬间 f(H) = MAX = 阈值物理高，内容 div 高度只收缩「超出部分」。

### 4.2 恒等模式（低文档零开销）

- H ≤ 阈值：`enabled = false`，f ≡ 恒等。helper 内部提前短路（logicalScrollTop 直接返回 el.scrollTop，logicalToPhysical 直接返回入参）——**代码路径单一**（消费方无分支），运行成本 = 一次函数调用 + 一次分支判断，可忽略。
- tanstack 接线点恒等短路：observeElementOffset 直接回读物理值，scrollToFn 直写，内容 div 高度 = totalHeight（引擎接管后写原值，行为与现状一致）。

### 4.3 切换机制（流式增长越过阈值 → 平滑，不跳动）

- 触发时机：批量测量 effect（MarkdownEngine.tsx:956-1008）内，H 变化帧与 f 重参数化同帧完成（useLayoutEffect，提交前）。
- 切换动作：`v`、`C` 不变（视口锚定）→ 只重算 s 与内容 div 高度 → 一次性写 `style.height = f(H)`。
- **零跳动论证**：行 top 是逻辑绝对坐标，重参数化不触碰任何行元素；视口内内容位置 = 逻辑 − P，锚点保持 → 视口内容零位移；视口外内容在物理容器中的占位收缩（滚动条范围缩小、thumb 变大）——视口外移动不可见。切换不写 scrollTop → 不打断进行中的滚动/惯性（流式追加与用户惯性滚动并发时零冲突）。
- 用户常驻尾部看流输出时：视口在文末 → 追加后视口仍 1:1（尾部在 1:1 区），新行继续 1:1 显示，仅滚动条范围收缩，视觉零变化。

### 4.4 反向回退（删除/撤销回到阈值下）

- 同帧重参数化：锚点保持、f 恢复恒等、内容 div 高度写回 H（= 逻辑总高）。视口零位移，零跳动。用户无感。

---

## 五、GPU 合成路径核对

- 滚动平移 = 浏览器合成层 blit（overflow:auto 容器内容滚动），行 top 为逻辑绝对坐标、滚动帧不变；directDomUpdates 仅在窗口变化帧写行 top（react-virtual esm index.js:36-57）→ **滚动帧零 layout 触发**（与 R6 实测一致：滚动 P95 21.8ms、长任务 ~0，round-R6-report.md:18）。
- 映射层为纯数学（f⁻¹ 每滚动帧一次 O(1)）+ 内容 div 高度写入（仅 H 变化帧）→ **不触发任何样式重算/布局，合成路径零破坏**。
- will-change 现状：滚动容器与内容 div 均未声明 will-change/transform（index.css 核对：virtual-row 无 transform/will-change）。**无需新增**：Chromium 对可滚动容器的内容滚动自动走合成器；若后续实测发现滚动容器未提升合成层，可登记可选增强（滚动容器 `will-change: scroll-position`），本轮不动。
- 注意保持：压缩段滚动时视口快速翻过大量行（导数 s < 1），每帧窗口变化挂载 ≤ overscan 缓冲行数与正常滚动同量级（窗口计算只看逻辑 offset 变化，与斜率无关），无额外渲染放大。

---

## 六、测试方案

### 6.1 单元测试（vitest，纯函数）

- scrollMap 数学性质（新测试文件 `tests/unit/scroll-map.test.ts`）：
  - 单调性与连续性：全域采样 f / f⁻¹，f(y1) ≤ f(y2)（y1<y2）、无断点；
  - 端点对齐：f(0)=0、f(H)=MAX；f⁻¹(f(y)) = y 与 f(f⁻¹(p)) = p 全域（含边界 0/MAX/1:1 区边界/压缩段）；
  - 1:1 区导数 1、压缩段导数 s（±1e-9）；
  - 锚点不变式：H 变化前后 f(v) 不变（重参数化零位移）；
  - 恒等模式：H ≤ 阈值时 f ≡ id；
  - 视口滚动 C 守恒：ΔP = Δv 模拟滚动后 f 不变。
- 消费方换算等价性：mock el（scrollTop 可设），断言 logicalScrollTop / logicalToPhysical 在 1:1 区与压缩段的取值；maxScrollTop 钳制。

### 6.2 端到端测试（playwright，真实 Chromium，120 万行 = 3360 万逻辑 px 必踩场景）

| 编号 | 用例 | 断言 |
|---|---|---|
| E1 | 触顶防护 | 容器 scrollHeight ≤ 30M + padding；无截断 |
| E2 | 拖到底 = 逻辑末尾 | scrollTop = maxScrollTop 时视口首行 = 末行（可见） |
| E3 | 视口内 1:1 零偏差 | 程序化滚动 100px → 视口首行逻辑位移 100px ±1px；点击行中点 → 光标 top = 行逻辑 top ±1px |
| E4 | 阈值切换无跳动 | 流式注入越过 30M 阈值：视口首行行号不变 + 内容区截图 diff 为空 |
| E5 | 200 万行滚动帧率 | 程序化滚动 + rAF 帧间隔 P95（对照 R6 基线 21.8ms，预算 ≤ 25ms 不劣化） |
| E6 | 滚动条拖动平滑 | page.mouse 拖动 thumb 采样 scrollTop 单调、无反向跳变、无回弹 |
| E7 | 命令式远端定位 | 大纲跳转 / 查找跳转 / Ctrl+End → 落点行号正确、视口锚定 |
| E8 | 惯性滚动 | 触摸板/滚轮惯性滚动无回弹、无跳变（视口 1:1 区） |

### 6.3 回归门禁

- `npm test`（611 门禁，含 grapheme/undo/parser-redos/chunk）全绿；
- 主仓库 tests/e2e 的 5 个 markdown-editor 专项 spec（ast-block-tables / format-checker / ime-composition / keyboard-navigation / wysiwyg-interaction）回归保留（keyboard-navigation 覆盖写侧换算，wysiwyg-interaction 覆盖点击/光标）。

---

## 七、跳动风险清单

| 风险 | 方案 A | 方案 B | 方案 C | 处置 |
|---|---|---|---|---|
| 滚动事件内写 scrollTop（回弹源） | 高（比例校正必写回） | **零**（换算层纯读，不写回） | 零（无物理写） | B 红线：任何实现禁止在 scroll/pointer 事件处理器内写回 scrollTop 做「校正」 |
| 拖到底不可达 / 内容错位 | 高（拖不到文末） | 零（f(H)=MAX 端点对齐） | 零 | — |
| 滚动速度失真 / 比例失真 | 高（K 倍全局） | 中（仅压缩段快翻 + thumb 略失真，登记） | 零（自绘可控） | B：压缩段体验登记 B2 动态增强（滚动帧将 1:1 区滑向视口，需同时引入上段对称压缩防总高超限） |
| 阈值切换跳变 | — | **零**（锚点保持 + 不写 scrollTop + 视口外重分布不可见） | — | 切换只在窗口变化帧（useLayoutEffect）执行 |
| 重参数化破坏锚点 | — | 低（实现缺陷风险，锚点不变式列入单测） | — | f(v) = v + C 不变式进 scroll-map.test |
| 流式追加与惯性滚动并发 | — | 零（重参数化不触碰滚动位置） | — | — |
| 自绘惯性手感跳变 | — | — | 中（惯性模拟质量风险） | C 为远期登记，不评估本轮 |

---

## 八、实施建议（分阶段）

1. **P0 换算层**：新建 `src/core/scrollMap.ts`（f / f⁻¹ / helper / 恒等短路）+ 单测；
2. **P1 接线**：tanstack 3 处（observeElementOffset / scrollToFn / 内容 div 高度接管）+ 读侧/写侧消费方替换（§3.4 清单，纯机械替换，每处 1-2 行）；
3. **P2 阈值与切换**：批量测量 effect 内启用判定 + 重参数化 + 内容 div 高度写入；
4. **P3 验证**：6.1/6.2/6.3 全套；E6 拖动手感专项；
5. **登记**：B2 动态视口锚定增强（消除压缩段快翻）、C 自绘滚动条远期替换、压缩因子 s < 1/8 手感警告。
