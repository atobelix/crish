# 交接汇报：自研 Markdown 引擎（reference/markdown-editor）完整状态

> 本文由上一轮主 Agent 交接、新主 Agent 于 2026-08-10 补录入库（原交接文本未落盘，此处按原始内容归档）。

## 一、项目全景

**产品方向**（用户定的两个）：
1. **方向一**：Markdown 流式渲染引擎（当前主力）——AI 对话流场景，目标 500 token/s 注入 + 百万行文档 + 60fps，已基本完成
2. **方向二**（未启动）：富文本多人协作渲染引擎——复杂排版文档沉淀、多人实时打字、表格/图文混排——**建议 ProseMirror + Yjs 路线**（分析已做，见 docs/analysis/ 相关文档）

**代码位置**：`C:\Software\conex\reference\markdown-editor\`（独立 npm 项目，已入库；根 .gitignore 有白名单放行）
**文档位置**：`reference/markdown-editor/docs/analysis/`（01-09 分析 + round-R0~R6/P1/P2 报告 + plan-A1~A6 + review-* + 本 handoff）
**基准对比库**：`C:\Software\conex\reference\markdown_compare\`（streamdown/incremark/appemd/markstream-vue——已分析）
**宿主**：Conex/Crish 主项目（crates/ + apps/crish-desktop）——引擎将作为对话流渲染核心（宿主接线 = R5.5 未做）

## 二、引擎能力与指标（已完成，全部有实证）

| 维度 | 状态 | 关键数据 |
|---|---|---|
| CommonMark 符合度 | ✅ | **479/652（73.5%）**——R0 起点 27.3%，+46pt；Block quotes 25/25 全通、Fenced 28/29 |
| 门禁测试 | ✅ | **890 全绿**（编译 0 错误、编码干净） |
| 流式性能 | ✅ | 500 token/s 四场景 GPU P95 10-15ms（60fps 保底达成）；击键全链路 1.0ms；ArrowLeft 48µs；append 尾段零拷贝 |
| 架构 | ✅ | 行级虚拟化（DOM 恒定）+ 增量解析（fence O(1)/收敛判定）+ 命令式滚动（位置帧零 React 提交）+ 末行直刷 DOM + 软渲染（未闭合 0 KaTeX） |

**功能清单**（R0-R6 + P1 + P2 全部落地）：解析器（表格/math/任务/HTML 块/fence 边界/实体/自动链接/引用链接/Setext/缩进代码/~~~）+ 增量数据层（分段树 COW/尾段/changeLog/版本）+ 渲染（行高模型/测量缓存/装饰层/渲染注册表/主题）+ 编辑（事务 applyChange/选区 anchor-head/IME 状态机/剪贴板/bidi/拖选/a11y/查找替换/大纲/折叠/自动补全/拖放）+ 扩展（InlineRuler 插件/实例工厂/readOnly/metrics）

## 三、轮次历史（做过的）

| 轮 | 内容 | 结果 |
|---|---|---|
| R0 | 基线（CommonMark 652 用例入库 + 投影器 + 性能基线 + 门禁骨架） | 27.3%/136 |
| R1 | 正确性（2^n 修复/10 项缺语法/缓存/守恒/fence/HTML 块/列表上下文） | 53.2%/248 |
| R2 | 性能地基（COW/行高模型/测量缓存/滚动管线/fence O(1)/跨视口箭头） | 1M 加载 -38% |
| R3 | 流式（append 平移/尾段/直刷 DOM/软渲染/500tps 验证） | 四场景 60fps |
| R4 | 编辑（事务/选区/IME/剪贴板/bidi/拖选/a11y） | 439 |
| R5 | 集成引擎侧（实例工厂/readOnly/规则插件/渲染注册/装饰层） | 561 |
| R6 | 终验（测试补全 + 全链路复测 + 公式回归修复 P95 140→13ms） | 611/479 |
| P1 | ArrowLeft 根治 48µs + 物化惰性化 | 618 |
| P2 | 查找替换/大纲/折叠/导出复制/工具产物/bidi 接线/补全/拖放/协作 op/metrics/CommonMark 冲 73.5% | 872 |
| **P3** | **方向一打磨（进行中——见下）** | 890 |

## 四、P3 当前进度（**未完成，新主 agent 继续**）

**流程已完成**：分析（6 份：A1 scroll factor/A2 显示层补全/A3 选区保护/A4 表格流式/A5 渲染分层/A6 基准固化）→ 方案（plan-P3，B1-B6 四波）→ 评审（review-P3，1 阻断已修订）

**执行进度**：
| 批 | 状态 | 说明 |
|---|---|---|
| B1 scroll factor | ⚠️ **半完成** | `src/core/scrollMap.ts` 已写并提交（分段映射/文末钳制/恒等短路）——**MarkdownEngine 接线未做**（观察者喂逻辑值/scrollToFn 写物理/内容高度 f(H)/scrollTop 读侧 inverse——接线点已定位：observeElementOffset/scrollToFn/内容 div 高度/scrollTop 读 4 处） |
| B2 显示层补全 | ⬜ 未做 | 方案在 plan-A2（样式预演——零 DOM 变化、class 微调无跳动、数据层零篡改） |
| B3 选区保护 | ⬜ 未做 | 方案在 plan-A3（shouldDirectStream 降级 + flush 后钳制兜底）——**B6 首跑已用 M3 证实真实缺陷：直刷写后相邻行用户选区被折叠** |
| B4 表格流式 | ⬜ 未做 | 方案在 plan-A4（候选态预分类 + 列宽闭合定型一次）——B6 的 M6 探针已留未接线 |
| B5 渲染分层 | ⬜ 未做 | 方案在 plan-A5（transform/contain + Canvas RowSurface 接缝） |
| B6 基准套件 | ✅ **完成** | tests/perf/suite/（13 文件：runner/budgets/lib/scenarios，M1-M6 指标 + 三档 PERF_TIER + 防抖）；**发现 M3 真实缺陷信号 + playwright.config 冲突已修复（5174）** |

**执行编排**（评审修订后）：波 1 = B1+B4+B6（B6 完成）；波 2 = B3；波 3 = B5→B2（显式串行）；波 4 = 全量验证 + 报告

## 五、技术要点与坑（新主 agent 必读）

1. **文件域纪律**：MarkdownEngine.tsx 是高频冲突点（B1 滚动/B3 直刷/B5 渲染/B2 LineItem）——同文件必须显式串行
2. **git 定时线程缺口**：有外部定时 git 提交线程（会漏掉新文件——曾有 5 个文件未跟踪差点丢失）——**每批完成立即 git add 提交**；提交后核对 git status
3. **Agent 空输出模式**：部分任务 agent 反复空输出（网络问题）——重派 1-2 次后仍空则由总调度直接实现（已有先例：R4-F bidi/B8 批次/scrollMap）
4. **编码铁律**：UTF-8 无 BOM；中文内容用 edit/write 工具（禁 PowerShell 写中文）；写完回读校验（check_chinese_text.py 或 node 检查 replacement char）
5. **测试资产铁律**：新增测试/脚本立即入库；node_modules/dist 除外
6. **不 commit 纪律**：执行 agent 默认不 commit（总调度统一提交）；**例外：定时线程会抢提交——内容无冲突则无妨**
7. **常见 flaky**：parser-regression 2^n 性能门槛（50→100ms 已放宽，并行负载偶发）；arrow-perf 计时测试
8. **关键文件地图**：
   - parser.ts（~1100 行：行级+内联扫描+CodeState 状态机+isFenceClose 共享导出）
   - EditorStore.ts（~2500 行：applyChange 事务/双段存储/changeLog/fenceLines）
   - SegmentTree.ts（LineOffsetTree 块数组）、HeightMap.ts（行高预测+indexAt）、DecorationSet.ts（行版本）、InlineRuler.ts（插件）、Bidi.ts、renderTheme.ts、renderToHtml.ts、search.ts、metrics.ts、scrollMap.ts
   - MarkdownEngine.tsx（~1500 行：虚拟化/命令式位置/直刷/滚动）、BlockRenderer.tsx（注册表/软渲染/表格候选）、HiddenInput.tsx（键盘/IME/拖选/a11y）

## 六、未来待办（方向）

1. **P3 剩余**（立即）：B1 接线 → B3 → B5→B2 → 验证（基准套件首跑定档）
2. **宿主接线 R5.5**：streamAppend/streamEnd 接对话流消息渲染（readOnly 实例）；外层消息虚拟化 + 历史折叠（双重虚拟化，1000 万 token 历史）；跨消息 fence 重置（实例工厂已支持）；安全双路径评审（前端 parser 取代 Rust md_render 的 XSS 防线——html_element 白名单审计）；AsyncMarkdownBlock 退役
3. **方向二**（未启动）：富文本多人协作——选型分析已建议 ProseMirror+Yjs（A 路线）；composer-preview（ProseMirror 块级编辑器，未协作）是现有基础；方向一引擎做只读渲染/导出层
4. **引擎遗留登记**：appendText 段落打断保护偏差、跨行 code span/HTML（行级模型限制）、列表相对缩进围栏、CoreMarkdown 核心子集 0.99 未单列、undo 栈无硬上限（显式契约）、120/140fps 名义（渲染器 ~100Hz 上限，Canvas 只读层是唯一路径——已设计 RowSurface 接缝未实现）

## 七、关键决策记录（避免重复争论）

- **React 保留**（不全面拆掉——帧内 JS <4ms 实证，绕开收益边际，失去生态不值）；Canvas 只做只读层预留
- **不借鉴**：Streamdown remend 的数据层补全（篡改源文本）；全局虚拟闭合标签（块级硬化更优）
- **借鉴**：scroll factor（唯一核心借鉴——浏览器高度上限真实约束）；显示层乐观补全（渲染层不碰数据）
- **流程**：分析→方案→评审→执行（用户要求，每轮文档入库）
- **分层策略**：CPU（现状已优）→ GPU 合成（P3 B5）→ Canvas（预留）
