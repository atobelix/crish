# P3 执行方案（方向一打磨·总方案 + 分维度）

> 依据：A1-A6 六份分析（scroll factor / 显示层补全 / 选区保护 / 表格流式 / 渲染分层 / 基准固化）。
> 要求：体验+性能并重、**避免跳动**（核心关切）、多方案对比已做（各分析文档）、CPU→GPU→Canvas 策略、不计成本做到极致。
> 流程：本方案 → 评审 → 执行（批次文件域互斥）。

## 0. 目标

- 超长文档（>120 万行）滚动不触顶、不跳动（scroll factor）
- 流式输出：inline 格式即时（显示层补全）、表格流式逐行 + 闭合定型、选区不打断
- 渲染分层：GPU 合成优化（本轮）+ Canvas 预留接口（本轮只留接缝）
- 基准体系固化（防回退、跳动指标 0 容忍）

## 1. 批次划分（分维度，文件域互斥）

### B1 Scroll factor（滚动域：MarkdownEngine.tsx + 新 scrollMap.ts）
- 新建 `src/core/scrollMap.ts`：分段线性映射 f（逻辑→物理）+ f⁻¹ + 锚点不变式（f(视口顶)=物理 scrollTop）
- 接线：读侧 el.scrollTop 13 处 + 写侧 3 处 + tanstack 3 接线点（observeElementOffset/scrollToFn/内容 div 高度）——**仅滚动容器层换算，HeightMap/光标/点击/折叠/大纲保持逻辑坐标零改动**
- 阈值：总高 > 30M px（~107 万行）启用，启用前恒等短路零开销；流式越过阈值的平滑切换（锚点不变式保证视口零位移）
- 红线：scroll/pointer 处理器内禁止写回 scrollTop 做"校正"（A1 登记）
- 测试：f/f⁻¹ 数学性质/端点对齐/锚点不变式/恒等模式单测 + e2e（120 万行拖到底=文末、视口 1:1 零偏差、阈值切换截图 diff 零跳动、200 万行帧率对照 R6 21.8ms、thumb 单调无回弹）

### B2 显示层乐观补全（渲染域：BlockRenderer/InlineRenderer/LineItem + 新 decorateIncompleteInline）
- 新纯函数 `decorateIncompleteInline(raw, isStreamingTail)`：检测未闭合 `**`/`*`/`_`/`` ` ``/`~~`（词边界 + flanking 防误判；code 行/代码块内不预演）→ 预演样式提示
- LineItem 流式末行渲染时消费：预演 class（is-preview-bold 等）——**零 DOM 节点变化、数据层零篡改、测量零影响**
- 闭合切换 = class 微调（preview → 真实 style）——A6 M4 指标（存量行重建 0）对齐
- 行内 `$` 预演为等宽样式（不调 KaTeX——保持 0 KaTeX 纪律）
- 测试：各形态/闭合切换 oldEl===newEl/测量 roundtrip/代码块不误判/undo 零影响/误判防护（foo*bar）

### B3 选区保护（直刷域：MarkdownEngine.tsx streamAppend + HiddenInput）
- `shouldDirectStream` 纯函数：选区与末行相交/光标在末行行中 → 降级走常规 append 路径（dirty 协议零改动）——选中/编辑处永不被打断
- 兜底：flush 后选区越界钳制 O(1) 修复（装饰版本原子链路，无闪烁）
- 顺带修复：FindReplace 替换 Enter 竞态的末行分支（A3 发现）
- 性能：判定每 chunk O(1)；无选区帧零开销
- 测试：直刷中拖选不打断/选中区域降级/恢复零跳动/无选区零开销

### B4 表格流式（表格域：parser 或渲染层候选判定 + TableStore + BlockRenderer）
- **候选态预分类**：流式中 pipe 行渲染为表格候选（cell 分割样式）——分隔行确认升级（表头高亮，class 级无跳变）/空行回退 body（样式回退）
- **列宽定型**：流式中估算（已到行最大宽度）→ 表格闭合（空行）时一次精确测量定型（单 reflow）——TableStore 计算时机从"每行更新"改"闭合一次"
- 测试：流式逐行候选/确认/回退/定型一次修正计数/零跳动（oldEl===newEl）/现有 table 测试回归/500tps 表格场景帧率

### B5 渲染分层 GPU 优化（渲染域：MarkdownEngine.tsx + index.css 微调）
- 组合：transform 绝对定位（tanstack directDomUpdates 已就绪——核对）+ 行级 contain: paint + 直刷 dirty 行 will-change 独立层（**非全员**——A5 激进档默认关）
- 一行回退（配置开关）
- 验收：滚动最坏 P95 < 16.6ms + 级联帧 Layout 归零
- **Canvas 预留**（本轮只留接缝）：renderMode: 'dom'|'canvas' 开关 + RowSurface 抽象（mount/update/unmount/locateRow）+ registerRowSurface 注册位（复用 BlockRendererRegistry 模式）——触发 = readOnly && 阈值 && 注册表存在；不实现

### B6 基准固化（perf 域：tests/perf/suite/ + metrics.ts 扩展）
- 新建 tests/perf/suite/（lib/stats + 场景矩阵 + runner + budgets.mjs）——**既有四脚本零删除零改动**
- 指标：M1 帧内 JS/layout/paint（P95 ≤4ms JS；layout+paint ci ≤20ms/nightly ≤12ms）、M2a 滚动跳动（0 容忍）、M2b 滚动条一致性（P95 ≤1 行）、M2c 直刷期间滚动（0）、M3 选区丢失率（0）、M4 补全闪烁（存量行重建 0）、M5 内存（增长 ≤60MB/峰值 ≤256MB/循环稳态 ≤5%）、M6 表格定型 reflow ≤2
- 三档：PERF_TIER=ci|nightly|local；防抖（环境指纹/中位数/3σ/GC 冷却）
- 顺带修复：playwright.config.ts:4-8 的合并冲突标记残留（A6 发现）

## 2. 依赖关系（逻辑顺序）

```
B1（scrollMap 独立）∥ B2（渲染域独立）∥ B3（直刷域——MarkdownEngine 与 B1 冲突！）
  → B1 与 B3 都动 MarkdownEngine.tsx → 串行或拆区
  → B2 动 LineItem/BlockRenderer（与 B5 同域——串行）
B4（表格域独立）
B5（渲染域——B2 后）
B6（perf 域独立，最后——指标依赖 B1-B5 行为）
```

## 3. 执行布局（4 波，评审修订后显式串行）

- 波 1：B1（MarkdownEngine 滚动域——**修订：保留 containerRef（tanstack applyDirectStyles 在 container null 时 return——行定位会禁用）；批量测量 effect 同帧覆盖 style.height=f(H)）+ **scrollMap 文末分支**（视口在文末时 1:1 区上界钳制 min(v+vh+m, H−m)——压缩段为空 s 分母≤0 问题）+ B4（表格域独立）+ B6 基建（perf 域独立）
- 波 2：B3（shouldDirectStream——MarkdownEngine 直刷域，B1 完成后）
- 波 3：B5（渲染域——transform/contain + Canvas 接缝——B3 完成后）+ B2（LineItem 渲染域——**与 B5 显式串行**：B5 先（rowStyle/virtualizer 配置），B2 后（LineItem 预演消费））
- 波 4：全量验证（基准套件首跑定档 + 跳动指标全绿——M2a 用相对脱节口径）+ 轮次报告
- 附加：B6 顺带项（playwright.config 冲突标记）随波 1；`tests/unit/_scratch-a2.test.ts`、`_scratch-table-stream.test.ts`、`vitest.probe.config.ts` 未跟踪文件随实现提交（评审附报）

## 4. 验收（每批）

- 编译 0 错误 + test:gate 全绿 + 编码干净
- B1：120 万行滚动全场景无跳动（M2a 0）
- B2：M4（存量行重建 0）+ 各形态预演
- B3：M3（选区丢失 0）
- B4：M6（定型 ≤2 次）+ 流式表格 500tps P95 < 16.6ms
- B5：滚动最坏 P95 < 16.6ms + Layout 归零 + Canvas 接缝存在性
- B6：基准套件可跑 + 首跑定档

## 5. 变更登记

- 所有分析（A1-A6）+ 本方案 + 评审文档 + 执行报告入库（docs/analysis/）
- 既有 4 个 perf 脚本零改动（保历史口径）
- Canvas 只留接缝不实现（登记触发条件）
- **评审登记 8 条**：A1 三项（压缩段滚动快翻登记 B2 动态视口锚定增强/滚动条 thumb 压缩段比例失真/重参数化破坏锚点列入单测）+ A2 方案 C（复杂嵌套形态局部视觉补全——登记）+ A3 两项遗留（替换竞态非末行分支/readOnly pending 复制漏字——登记）+ A5 两项 CPU 遗留（行渲染开销核对结论/测量路径核对结论——登记）
- B4 升级信号载体钉死：行版本 bump（DecorationSet rowVersion 复用）
- B5 验收分档：P95<16.6ms 需 nightly GPU 档
