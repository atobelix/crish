# 性能与编辑提升执行方案（P2 轮·总方案 + 分维度）

> 依据：review-P1（P1 质量 A-，8 项回修不阻塞）+ status-P2（15 项现状盘点）+ status-P3（10 项新需求）+ R6 遗留。
> 流程：方案评审 → 分批次执行（文件域互斥，批次间可并行/串行按依赖）。

## 0. 目标

- 性能：剩余 3 项（分块首帧/增量 fence 镜像/键盘增强）+ CommonMark 持续
- 编辑：查找替换/词级跳选/自动补全/拖放/bidi 接线/表格菜单/协作 op 预留/指标扩展
- 质量：A1 回修 8 项 + 占位清理
- 新增（宿主对话流主线）：大纲/折叠/导出复制/工具产物渲染

## 1. 批次划分（分维度，文件域互斥）

### B1 数据与正确性（EditorStore.ts + HiddenInput.tsx）
- 增量 fence 镜像（KNOWN-DEFECT：**关闭判定抽为 parser 共享导出 isFenceClose 单源化**——根治两套状态机分歧，修后删 cross-matrix 登记分支）
- 分块加载参数化（1000/2000 常量 + TTI 基准测试）
- 键盘增强：PageUp/PageDown/Ctrl+Home/Ctrl+End（HeightMap.indexAt 定位）
- A1 回修 1-3：measure.ts:886-889 视口外导航读物化数组改访问器、双段合并语义 7 处去重、dispatchSet 死分支清理

### B2 查找替换 + 词级跳选（新 FindReplacePanel + HiddenInput + MarkdownEngine）
- 搜索本体：行级扫描分批（主线程不卡帧——05 RL-05 红线）+ 大小写/全词选项
- FindReplacePanel UI（DecorationSet search + addSearchRange/clearSearch + is-search-line 已有）+ 跳转（scrollToIndex）+ 替换（applyChange 事务）
- wordBoundary（Ctrl+Arrow/双击词选——moveHead/extendSelection 复用）

### B3 大纲 + 折叠（新 HeadingIndex + MarkdownEngine + HeightMap 接线）
- heading 增量索引（fenceLines 同款有序数组：行号+级别+文本）
- OutlinePanel（点击跳转 scrollToIndex）
- fold ranges API（fold/unfold + 折叠占位行高——HeightMap.insert/delete 接线——最大难点行高联动）

### B4 导出与复制 + 工具产物 + 只读复制（BlockRenderer + 新导出模块）
- renderToHTML 提取（astToHtml 投影器迁入 src 导出——**品质目标明确：CommonMark 近似投影 + KaTeX 支持，与 BlockRenderer 为双实现、各自单源**）
- 代码块复制按钮 + 公式复制（LaTeX 源在 token raw）
- fence lang 渲染器注册（json/diff/log——BlockRendererRegistry 复用 R5-C）
- readOnly 复制为 Markdown（N9：DOM 选区→源码偏移映射 + getText 切片）

### B5 bidi 接线 + 自动补全 + 表格菜单 + 拖放（BlockRenderer/InlineRenderer + ContextMenu + HiddenInput + 新组件）
- 渲染 dir="rtl" 接线（isRtlLine——blockquote 内/整行）
- 自动补全（ruler 注册 + ContextMenu handleAction 接线——当前是 stub）
- 表格菜单动作接线（行/列增删——TableOperations API 已有）
- 拖放文件（FileReader.readAsText + 源内移动——status-P2 项 8）

### B6 协作 op 预留 + 指标扩展（EditorStore + 新 metrics 模块）
- EditorOperation 位置级字段（from/to/insert/removedText——只增不改，undo/redo 兼容层验证）
- 变更日志 + 版本号（append-only）
- __CRISH_METRICS__ core 化（FPS/缓存命中/物化计数——修 getLineCount 触发物化问题）

### B7 收尾清理（tests/ + 回修）
- tests/gate/placeholder.test.ts 的 G6/G9/G10 占位删除（真实测试已落地）
- A1 回修 4-7：注释措辞、2b 测试补 codeState、Up/Down 全文 getText 优化登记、subscribe 窗口注释
- 范围声明：N1（消息级软→硬切换）与 N7（实例池化）**本轮不实施**（宿主对接相关，R5.5 登记）；N10（指标扩展）并入 B6

### B8 CommonMark 继续（parser.ts + astToHtml.ts）
- Block quotes（引用嵌套语义）/List items/Fenced/Code spans/Raw HTML/Hard breaks 六章节提升
- 目标：全量 63.65% → 70%+；核心子集量化

## 2. 依赖关系（逻辑顺序）

```
B1（数据基础）→ B2（搜索依赖 store 正确性）可并行 B3（索引独立）
B3 → B6（折叠占位行高与 op 日志交互验证）
B4/B5 独立并行
B7 最后（清理）
B8 独立长线（可与 B1-B7 并行，parser.ts 域）
```

## 3. 执行布局（≤12 Agent/轮）

- 轮 1：B1 + B8a（parser 引用语义）+ B7（并行——域互斥：EditorStore+HiddenInput / parser / tests）
- 轮 2：B2 + B4（并行——HiddenInput+MarkdownEngine / BlockRenderer+导出模块）
- 轮 3：B3 + B5 + B6 + B8b（并行——MarkdownEngine 轮 2 后 / BlockRenderer 轮 2 后 / EditorStore / 投影器）
- 收尾：全量验证 + 轮次报告
- 收尾：全量验证 + 轮次报告

## 4. 验收

- 每批：tsc 0 错误 + test:gate 全绿 + 编码干净
- B2：查找替换可用（搜索/跳转/替换/计数）
- B3：大纲跳转 + 折叠生效
- B8：CommonMark 通过率提升可量化
- 全量：性能复测（ArrowLeft <0.1ms 保持、分块首帧 TTI 基准）
