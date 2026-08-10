# P2 现状盘点：性能与编辑提升项（A2 阶段 1 分析）

> 输入：round-R6-report.md（遗留登记）+ 引擎源码 + 测试资产。目的：为下一轮方案生成提供逐项代码级证据的现状盘点（完成度 / 待做 / 工作量）。

## 一、盘点总表

| # | 项 | 现状证据（文件:行号） | 完成度 | 待做内容 | 工作量 |
|---|---|---|---|---|---|
| 1 | 分块加载首帧优化 | `EditorStore.ts:1491-1581`（setText：≤1000 行同步整载；大文件首块 1000 行同步 + 每块 2000 + requestIdleCallback 续载 + currentLoadGeneration 代际竞态保护）；`chunk.test.ts:5-21`（setText 后立即 1000 行、异步后 5000 行全载） | 90% | 首帧可交互时间（TTI）尚无量化基准；分块参数（1000/2000）硬编码不可调；大文件加载期间用户击键打断语义无专项测试 | 0.5d |
| 2 | 增量 fence 镜像 | KNOWN-DEFECT 已登记：`cross-matrix.test.ts:160-243`（assertFenceKnownDefect：fence_end 行尾插入使行变 ` ```INS` 后，增量按 `trimmed.startsWith('```')` 布尔翻转仍判 fence_end，重扫按完整关闭条件判 code——两套状态机分歧）；增量判定 `EditorStore.ts:793` vs parser 完整关闭条件 `parser.ts:701-720`（同字符 + run 长度 ≥ 开栏 + 无 info 串）；R6 报告遗留 6 | 80%（常规 fence 路径已收敛，缺陷在案未修） | 增量状态机携带 fenceState{marker,length} 镜像 parser 关闭条件；修复后删除 assertFenceKnownDefect 分支恢复全量收敛断言 | 0.5-1d |
| 3 | CommonMark 剩余 | 全量 415/652（63.65%，`compliance-report.json`）。相关章节：Block quotes 14/25、List items 23/48、Lists 15/27、Fenced code 15/29、Code spans 11/22、Raw HTML 7/20、Hard line breaks 4/15；引擎已支持块引用前缀剥离/列表上下文 listCtx/HTML 块（42/44）/围栏基本形态（`EditorStore.ts:198-285` 镜像块形态、`parser.ts:613-923` 列表上下文） | 全量 63.65%；六章节各自：Block quotes 56% / List items 48% / Lists 56% / Fenced 52% / Code spans 50% / Raw HTML 35% / Hard breaks 27% | 六章节剩余 spec 例逐例攻坚（含增量状态机同步）；每章节完成需同时更新 compliance-report.json 快照与投影器（零语义修复契约） | 每章节 0.5-1.5d（合计约 4-7d） |
| 4 | 编辑器键盘增强 | R6-P1 已根治：Home/End 经 LineOffsetTree O(log n)（`HiddenInput.tsx:1156-1184`）；Ctrl+A 用 textLength O(1)（`HiddenInput.tsx:1047-1050`）；另有 Ctrl+Z/Y、Ctrl+C 整行复制（939-949）、Tab 缩进（1051-1113）、Enter 列表续写（994-1046） | 85% | PageUp/PageDown 无处理（浏览器默认在 textarea 上无效）；Ctrl+Arrow 词移动缺失（与项 6 共用 wordBoundary）；Home/End 无 Ctrl 变体（文档首尾） | 0.5d（不含词移动） |
| 5 | 查找/替换 | 数据通路已就绪：DecorationSet search 种类 + addSearchRange/clearSearch（`DecorationSet.ts:36,222-229`）；引擎 handle 暴露 addSearchRange/clearSearch（`MarkdownEngine.tsx:104-106,489-494`）；命中行打 is-search-line class（`MarkdownEngine.tsx:237`，css-contract.test.ts:101 收录）；**无搜索算法、无 UI、无替换**（src 全量无 find/findNext 实现） | 30%（数据通路 100%；搜索算法 0%；UI 0%） | 搜索算法（findAll + 区间收集，命中统计）；F3/Shift+F3 导航与光标落点；替换事务（applyChange 收敛，可单步 undo）；搜索 UI 面板（宿主侧或引擎侧）；goto 定位 | 2-3d |
| 6 | 词级跳选 | 无 wordBoundary 实现（src 全量 0 命中）；Ctrl+Arrow 无键盘分支（`HiddenInput.tsx:910-1185` 全键位清单）；双击/三击依赖浏览器原生选区路径（`HiddenInput.tsx:657-661` 注释：已有 DOM 文本选区不干预）；04 §2.3 S3 登记缺失 | 0% | word.ts（Unicode 分类或 Intl.Segmenter word 粒度）；Ctrl+Left/Right 移动 + Shift 扩展（moveHead 现成）；双击取词区间、三击取行 | 1-1.5d |
| 7 | 自动补全 | ContextMenu 仅表格右键菜单：InlineRenderer 派发 open-table-context-menu（`InlineRenderer.tsx:311-323`）、ContextMenu 渲染菜单项但 handleAction 为 stub「只 log/focus，真实实现待接 TableOperations」（`ContextMenu.tsx:41-47`）；ruler 注册机制已就绪（InlineRuler.add/register 全局注册 + @mention 示例 `InlineRuler.ts:83-188`、ruler.test.ts） | 10%（ruler 机制 100%；补全 UI 0%） | 触发上下文判定（token 前缀 + 代码块/行首场景）；候选数据源接入（复用全局规则注册）；悬浮层 + 键盘导航（上下/Enter/Tab/Escape）；提交事务（applyChange） | 2-3d |
| 8 | 拖放文件 | 无任何 drop/dragover/dragenter 处理（src 全量 0 命中）；04 §8.1 方案登记（CM6 input.ts:664-693 参考） | 0% | drop 事件：dataTransfer.files → FileReader.readAsText + 控制字符过滤（/[\x00-\x08\x0e-\x1f]{2}/）+ insertText 事务；文本拖放（dragMovesSelection 移动语义，需 draggedContent 标记引擎内拖拽源） | 1d |
| 9 | 表格编辑深化 | TableOperations 能力面：insertRow/deleteRow/insertColumn/deleteColumn/setColumnAlign/formatTable/navigateTable/clearCell/setCellContent（`TableOperations.ts:182-648`）；TableStore 列宽存储 setColumnWidth/setTableWidths（`TableStore.ts:13-50`），InlineRenderer 消费 cellWidth 渲染（`InlineRenderer.tsx:217`）；**右键菜单动作未接线**（项 7 的 stub）；列宽无任何 UI 调用 setColumnWidth（无拖拽）；无合并/拆分单元格 | 60%（增删行列 API 100%；列宽存储 100% 但零交互；菜单动作 0%；合并 0%） | 菜单动作接线 TableOperations（部分操作已可走 setState({lines}) diff 事务 / applyTableChange）；列宽拖拽交互（mousedown 边界 + 视觉宽度写回）；单元格合并/拆分；表操作单测补接线断言 | 2-3d |
| 10 | bidi 接线 | isRtlLine 已导出（`Bidi.ts:99`，lineBidiInfo 完整实现 65-96，bidi.test.ts 有单测）；**渲染层零接线**（src 组件无 dir= 使用、无 rtl 消费）；光标 assoc 方向层已就绪（`EditorStore.ts:142-152,566-568`） | 40%（模块 100%；渲染接线 0%） | BlockRenderer/InlineRenderer 行级 dir="rtl"（isRtlLine 驱动）；CursorLayer/measure 对 RTL 行的视觉坐标（assoc + 段级视觉位置）；方向键已按逻辑方向工作，需验证视觉方向（Bidi.ts:1-7 设计目标） | 1-2d |
| 11 | 协作 CRDT 预留 | EditorOperation 位置级字段完整（`EditorStore.ts:475-498`：startLineIdx/removedLines/insertedLineCount/cursor*/selection*/timestamp/meta:'stream'）——行级 splice op 天然可序列化（05:215-216 乐观评估）；**无位置身份/siteId/Lamport/变更日志**；04 §7 登记 O1 位置身份缺失、O3 op 非位置级 diff（04:311-320） | 25%（op 结构可序列化 100%；CRDT 预留 0%） | 近期：位置级 op 补「位置身份 + 版本号 + 变更日志」（OT 可映射形状）；远期：双结构——CRDT 管正确性、LineOffsetTree 退化为渲染索引（04:319-320） | 近期 2-3d；远期架构级（另行立项） |
| 12 | 大纲/标题索引 | 解析层 heading 已支持（LineType 'heading'、Setext level、`parser.ts:1048-1055`）；行高模型识别 heading（`HeightMap.ts:83`）；validator.headingsCount 仅校验用途（`validator.ts:18,49`）；**无 heading 索引/大纲 UI/点击跳转** | 10%（解析层 100%；索引 0%） | heading 索引（行号/级别/文本，增量维护——可基于 fenceLines 同款增量模式）；大纲面板（readOnly 模式 + 点击跳转 setCursorPos）；当前章节高亮（DecorationSet 复用） | 1-2d |
| 13 | 折叠区间 | 无 fold ranges 数据/渲染（src 0 命中）；BlockRenderer 长行截断「⋯ 已折叠 N 字符」是行内截断非块折叠（`BlockRenderer.tsx:569`）；05 §4 规划 fold ranges + 行高感知 + 占位行（05:128） | 0% | fold ranges {startLine,endLine} 数据 + 增量维护；虚拟滚动行高感知（estimateSize 折叠感知/固定行高模式）；折叠占位行 UI（摘要 + 展开按钮）；折叠状态宿主侧持久化（session_meta） | 2-3d |
| 14 | 导出 HTML | astToHtml 投影器已存在且独立：`tests/commonmark/astToHtml.ts:627`（astToHtml(doc)，792 行，仅依赖 src/core/ast 类型；escapeText/splitLinkTarget/normalizeHtml 导出）；零语义修复契约（tests/commonmark 目录 README）；当前在 tests/ 下不产出引擎导出 | 80%（投影器功能完整；未入 src） | 移入 src/core/astToHtml.ts（或 src/core 薄封装导出）；确认无测试专用依赖（无 katex）；测试导入路径更新；导出类型声明 + 单测 | 0.5d |
| 15 | 占位清理 | `placeholder.test.ts:49-77` G6/G9/G10 三个占位 it 仍在（「待 R6/R9/R10 落地」）；对应真实测试已落地：G6=css-contract.test.ts（269 行，R6-A）、G9=memory-bounds.test.ts（168 行）、X1(G10)=cross-matrix.test.ts（243 行）；coverage-tracker 13/71 | 0%（清理未做；真实测试 100% 已就绪） | 删除 G6/G9/G10 三个占位 it（按文件头约定：替换占位后同步删除、不得留空壳）；coverage-tracker 勾选；G1-G5/G7/G8 占位另行评估（G7 已有 18+ e2e spec 但无门禁接线文件） | 0.5d（含 G7 评估 1d） |

## 二、逐项建议

1. **分块加载**：补一个「大文件首帧 TTI」基准测试（setText 1000 行同步帧 → 可视交互），把 1000/2000 参数提为常量配置即可收尾。
2. **增量 fence 镜像**：下轮优先修复——一行改动量级的语义分歧（`cross-matrix.test.ts:160-243` 已给出精确复现与修复路径），修完可直接删登记分支。
3. **CommonMark 剩余**：按「Fenced code → Hard breaks → Code spans → Block quotes → Raw HTML → List items/Lists」顺序攻坚（后两者依赖投影器 list 容器语义，工作量最大，建议与项 2 联动）。
4. **键盘增强**：Home/End/Ctrl+A 已达标，补 PageUp/PageDown 与 Ctrl+Home/End 文档首尾即可；Ctrl+Arrow 并入项 6 统一实现。
5. **查找/替换**：数据通路已铺好（DecorationSet + is-search-line + 引擎 handle），下一轮只需补「搜索算法 + 导航 + 替换事务 + UI」，是投入产出比最高的编辑项。
6. **词级跳选**：全新实现，但 moveHead/extendSelectionByDirection 已就绪，实现面仅为 wordBoundary 纯函数 + 键位分支，可与项 5 的搜索导航共用落点机制。
7. **自动补全**：先做「右键菜单动作接线」把表格菜单修活（stub 现状），再做通用补全 UI；InlineRuler 全局注册机制是现成的候选数据源扩展点。
8. **拖放文件**：实现面小（drop 事件 + FileReader + 控制字符过滤 + insertText），建议与宿主（Conex）文件打开流程一起排期。
9. **表格编辑深化**：菜单动作接线是明确的半成品缺口（UI 菜单与操作库之间只差调用），列宽拖拽次之，合并单元格涉及解析/渲染两层改动、建议单独立项。
10. **bidi 接线**：Bidi.ts 与 assoc 均已就绪，仅剩渲染层 dir 属性与视觉坐标两处接线，属于「数据全在、差接线」的低风险项。
11. **CRDT 预留**：本轮不动架构，只补「位置级 op 变更日志 + 版本号」即可满足 05:215 的可序列化承诺；双结构方案留远期。
12. **大纲/标题索引**：heading 解析已齐，索引可复用 fenceLines 的增量维护模式（二分 + 扫描区），建议与宿主 readOnly 大纲面板一起做。
13. **折叠区间**：依赖虚拟滚动行高感知（与 05:128 的 estimateSize 难点绑定），建议作为宿主长会话回看的第二阶段功能，勿与引擎性能项抢排期。
14. **导出 HTML**：纯搬运 + 导出封装（0.5d），可顺手把「引擎导出 HTML」作为宿主归档导出的数据源，消除测试工具与产品能力之间的隔阂。
15. **占位清理**：机械清理（G6/G9/G10 占位删除 + 追踪表勾选），建议与任一代码轮次捆绑执行，避免占位与真实断言长期并存误导门禁口径。

## 三、总结

- **已基本完成**：1（分块加载）、4（键盘增强 Home/End/Ctrl+A）、11 的 op 可序列化面、14 的投影器本体、9 的表格增删行列 API。
- **数据通路已铺、差最后一公里**：5（搜索：算法 + UI）、10（bidi：渲染接线）、15（占位清理：真实测试已就绪）。
- **明确半成品缺口**：7/9 的 ContextMenu 菜单动作 stub（UI 与操作库之间只差一行调用）。
- **全新待做**：6（词级跳选）、8（拖放文件）、12（大纲索引）、13（折叠区间）。
- **已知缺陷待修**：2（fence_end 行尾插入，复现与修复路径已登记在 cross-matrix 测试内）。
