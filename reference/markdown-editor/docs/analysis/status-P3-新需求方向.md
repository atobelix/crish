# 新需求方向清单（宿主对话流主线视角）

> 产出：总调度派发的 A3 子 Agent（阶段 1 分析·新需求方向），纯分析任务——只读核验代码与文档，未改动任何源码，不 commit。
> 属性：UTF-8 无 BOM，全中文。
> 依据：
> - 引擎现状（只读核验）：`reference/markdown-editor/src/`（EditorStore.ts / MarkdownEngine.tsx / BlockRenderer.tsx / DecorationSet.ts / InlineRuler.ts / renderTheme.ts / HeightMap.ts / parser.ts / ContextMenu.tsx / main.tsx 等）与 `tests/unit/` 门禁套件
> - 必读分析：`docs/analysis/05-扩展功能-产品维度.md`、`docs/analysis/06-扩展功能-技术维度.md`
> - 宿主背景：`docs/rust-rewrite/23-architecture-hardening-plan.md`（E2 域：AsyncMarkdownBlock 流式改造）、`docs/rust-rewrite/24-markdown-streaming-audit.md`、`docs/schemes/MASTER_PLAN.md`、crish-desktop 前端组件实证（ChatAssistantMessageRow / MessageThinkingSection / InlineAgentPanel）
> 日期：2026-08-10（本地）
> 任务书提示的 `docs/schemes/CONVERSATION_FLOW_SPEC.md` 在仓库中不存在（glob 未命中）——对话流上下文（Thinking 折叠 / 消息流式态 / 完成态权威渲染 / 工具调用消息）以 23 方案、24 审计与 crish-desktop 组件实证为准，落地接线时需与宿主侧重新对齐。
> 定位：回答「引擎作为宿主对话流渲染核心，下一步做哪些需求」，每项给出 宿主场景 → 引擎侧实现方案 → 复用现状 → 工作量 → 价值评分；不排期，只给推荐优先级组合（依赖关系与对话流主线的综合判断）。

---

## 0. 结论先行

**一句话定位**：引擎已在 R5 轮把「单文档编辑实例」升级为「可实例化、可只读、可流式、可查询的渲染核心」底座（`createEditorStore` / `readOnly` / `streamAppend·streamEnd` / `DecorationSet` search / `InlineRuler` 全局注册表 / `BlockRendererRegistry` / `renderTheme` 注入 / `HeightMap` 折叠预留），任务书 10 项新需求**全部可在既有扩展点上增量落地**，无架构级前置改造。宿主对话流主线的首套需求 = 消息级渲染增强（N1）+ readOnly 选择复制增强（N9）+ 性能观察（N10），三者共同支撑 23 方案 E2 域把 AsyncMarkdownBlock 从「伪流式」切到引擎渲染。

### 0.1 清单表（10 项）

| # | 需求项 | 宿主场景 | 引擎侧实现方案（摘要） | 复用现状 | 工作量（人日） | 价值评分 |
|---|---|---|---|---|---|---|
| N1 | 消息级渲染增强（软→硬切换/消息分隔与元信息/跨消息 fence 重置） | 每条 AI 消息必经的流式渲染与完成态收敛 | streamEnd 完成态信号 + 软渲染视觉稳定化 + 消息元信息 slot 契约 + 跨消息 fence 隔离门禁测试 | readOnly/streamAppend/streamEnd/软渲染已就绪；实例工厂天然隔离 fence 状态 | 2-3 | 5 |
| N2 | 大纲/标题索引 | 百万 token 会话回看的导航入口 | heading 增量索引（fenceLines 同款有序数组，挂 updateLinesIncremental delta）+ OutlinePanel + scrollToIndex | headingLevel 已入 AST；HeightMap.posOf / virtualizer 现成 | 3-4 | 4.5 |
| N3 | 折叠区间 API | 历史消息折叠 / 长代码块折叠 | fold ranges 数据 + 折叠感知行高（HeightMap.insert/delete 预留）+ 折叠占位行 | HeightMap.insert/delete 已实现未接线（HeightMap.ts:417-449）；estimateSize 现成 | 4-6 | 4 |
| N4 | 工具产物渲染（fence lang 分发） | 每次工具调用的 JSON/diff/log 输出可读化 | fence lang 分发渲染器注册表（lang 键，区别于 LineType 键的 BlockRendererRegistry）+ json/diff/log 渲染器 | lang 已在 fence_start 提取（BlockRenderer.tsx:218）；fenceLines 块定位现成；registry 机制有先例 | 3-5 | 4.5 |
| N5 | 导出与复制（renderToHTML/代码块复制/公式复制） | 会话归档出口 + 高频复制微操作 | renderToHTML 纯函数（复用 BlockRenderer 语义）+ 代码块复制按钮（fenceLines 定位）+ 公式复制（LaTeX 源在 token raw） | getText 天然导出 md；KaTeX/表格渲染现成；复制先例（onCopy / linewiseCopy） | 3-4 | 3.5 |
| N6 | 搜索增强（替换/跳转/计数） | 长会话回看定位 + 就地替换 | search API（行级扫描 + requestIdleCallback 分批）+ 命中高亮（DecorationSet search 现成）+ 替换走 applyChange + 跳转 scrollToIndex + 命中计数 | DecorationSet.addSearchRange/clearSearch、applyChange、HeightMap.indexAt 全部现成 | 3-4 | 4 |
| N7 | 多文档/工作区（实例池化） | .agent-outputs 工作区多文档切换 | 实例池化（LRU keep-alive + 切换 API） | createEditorStore 工厂现成（EditorStore.ts:2496） | 2-3 | 3 |
| N8 | 协作预留落地（位置级 op + 变更日志 + 版本号） | ZenNav sync 服务端消费端 | EditorOperation 补 from/to/insert/removedText 位置级字段 + append-only 变更日志（seq/op）+ 文档版本号 | applyChange 事务入口现成（EditorStore.ts:1713）；EditorOperation 仍为行级 splice | 3-5 | 3.5 |
| N9 | readOnly 选择复制增强（复制为 Markdown） | 消息历史选中内容按源码复制 | 原生 DOM 选区 → 源码偏移映射（data-token-start/data-sub-offset）→ getText 切片 + readOnly 上下文菜单项 | readOnly 已保留原生选区；token↔源码无损映射现成 | 2-3 | 4 |
| N10 | 性能观察（__CRISH_METRICS__ 扩展） | 宿主调试流式/渲染性能（E2.4 验证支撑） | metrics 迁入引擎 core 模块单例（renderTheme 同款形态）：FPS/缓存命中/物化计数/HeightMap 统计/DecorationSet bucket 数 | main.tsx:26-30 已有雏形；HeightMap.stats / parser 缓存统计现成 | 1-2 | 3.5 |

### 0.2 推荐优先级组合（考虑宿主对话流主线）

| 批次 | 需求项 | 定位 | 依据 |
|---|---|---|---|
| 第一批 P0：对话流即时底座 | N1 + N9 + N10 | 承接 23 方案 E2 域 AsyncMarkdownBlock 接线（流式期引擎 readOnly 渲染 + 完成态软→硬收敛）；N10 成本最低、是 E2.4 性能验证的可观测性前置 | 每条 AI 消息必经流式路径，宿主高频第一触点 |
| 第二批 P1：阅读与定位 | N2 + N6 + N3 | 百万 token 会话的「回看」刚需：大纲是结构化入口（05 高排序），搜索是定位刚需，折叠改变浏览效率 | 三者共享虚拟滚动定位设施，可同轮并行 |
| 第三批 P2：工具产物与出口 | N4 + N5 | 每次工具调用都受益的结构化渲染；导出是归档出口 | N4 的 lang 分发渲染器与 N5 的复制按钮共享块定位设施 |
| 第四批 P3：工作区与协作 | N7 + N8 | 实例池化是文档工作区的结构性前置；协作 op 按宿主 sync 节奏落地 | N7 依赖 createEditorStore（已就绪），N8 触碰 undo/redo 兼容层需谨慎 |

---

## 1. 现状盘点：任务书 10 项对应的引擎已有能力（只读核验）

| 引擎能力 | 位置 | 与任务书 10 项的关系 |
|---|---|---|
| 实例工厂 `createEditorStore()` / `buildEditorStore()`（R5） | EditorStore.ts:1380、2496 | N1（跨消息隔离）/ N7（多文档）底座 |
| `readOnly` 只读模式（隐藏输入层、保留原生选区、点击不移动光标） | MarkdownEngine.tsx:260-263、644-646、888-1019 | N1 / N9 底座 |
| 命令式流式接口 `streamAppend`/`streamEnd`/`flushStream`（C3 直刷 DOM + R3-A stop-flush 单 undo 步） | MarkdownEngine.tsx:92-107、397-507 | N1 的完成态切换信号（streamEnd 已 flush） |
| 流式软渲染（math 未闭合跳过 KaTeX；行内未闭合天然退化纯文本；fence 未闭合检测） | BlockRenderer.tsx:57-98、310-325；parser.ts:1030-1033 | N1 软渲染分支已部分落地，缺「fence 内容 + lang pill」的软渲染稳定化与一致性验证 |
| fenceLines 有序数组（主数组/尾段双段 + 惰性物化 + 零拷贝快速路径） | EditorStore.ts:538-539、924-965 | N2 增量索引的现成范式；N4/N5 的块区间定位 |
| `DecorationSet` 统一装饰层（active/selection/search/custom + 行级版本 + addSearchRange/clearSearch） | DecorationSet.ts:36-239、221-229；MarkdownEngine.tsx:104-106、489-494 | N6 搜索高亮已就绪，缺搜索本体/替换/跳转/计数 |
| `InlineRuler` 全局注册表（register/unregister + 版本失效） | InlineRuler.ts:75-188 | 引擎自定义语法扩展面（宿主 @mention/Purpose 块预留） |
| `BlockRendererRegistry`（LineType 键注册表 + register/unregister 出厂恢复） | BlockRenderer.tsx:124-167、581-598 | N4 的机制先例——但按 LineType 键，fence lang 分发需另建 lang 键注册表 |
| `renderTheme` 主题注入 + `setMathRenderer` 数学引擎注入 + KaTeX LRU 缓存 | renderTheme.ts:98-179 | N5（renderToHTML 复用渲染语义）/ N10（缓存命中统计）底子 |
| 行高模型 HeightMap（insert/delete/posOf/indexAt + oracle 校准 + 稳定点护栏） | HeightMap.ts:229-551（insert/delete 预留于 :417-449） | N3 折叠的行高感知接缝——insert/delete 已实现但引擎当前只走 syncTo 尾部对齐 |
| `applyChange(from, to, insert, opts)` 位置级事务统一入口 | EditorStore.ts:1713-1844 | N6 替换 / N8 位置级 op 的事务地基 |
| `EditorOperation`（行级 splice：startLineIdx/removedLines/insertedLineCount + meta:'stream'） | EditorStore.ts:475-498 | N8 需补位置级字段（06 §4 近期项），undo/redo 兼容层（336 门禁）是约束 |
| `__CRISH_METRICS__` 调试全局（缓存统计/行数/layout 节流哨兵） | main.tsx:26-58 | N10 雏形——挂在 demo 壳，且 getLineCount 经 `lines.length` 读取会触发惰性物化（R6-P1 口径下应改访问器） |
| 表格渲染 + TableStore/TableOperations（表格操作已收敛 applyTableChange） | core/TableStore.ts、TableOperations.ts | N4（```table 产物）/ N5（导出表格语义）现成 |
| Bidi 方向性（assoc 模型） | EditorStore.ts:142-171；core/Bidi.ts | 引擎渲染正确性底子（非本次 10 项范围） |
| ContextMenu（复制文字/粘贴/表格操作） | ContextMenu.tsx:41-103 | N9 readOnly 菜单扩展的现成组件 |

---

## 2. 逐项分析

### N1 消息级渲染增强（流式完成态软→硬切换 / 消息分隔与元信息 / 跨消息 fence 重置验证）

**宿主场景**：23 方案 §1.1 审计定性当前 AsyncMarkdownBlock 流式态为「伪流式」（`renderTarget = isStreaming ? '' : text`，消息结束才经 Rust `md_render` 整篇渲染）。引擎接线后：流式期引擎 readOnly 软渲染逐帧呈现，消息结束（streamEnd）完成态收敛，且每条 AI 消息是独立渲染单元（时间戳/模型元信息、与用户消息/工具消息并列）；fence/公式状态不得跨消息传播。

**引擎侧实现方案**：
1. **完成态软→硬切换**：streamEnd 已实现 flush + stop-flush（MarkdownEngine.tsx:480-484），软→硬切换本质是「同一 AST 软/硬渲染开关」——数据侧状态收敛后 BlockRenderer 自动切换（math 软渲染已实证该机制，BlockRenderer.tsx:310-325）。剩余工作：fence 未闭合期间的视觉稳定化（未闭合代码块跳过 lang pill 高亮/启发式着色，防「半块突然变色」跳变）+ 软/硬输出一致性验证（对齐 23 方案 E2.4 视觉对比口径）。E2.2 的「md_render 权威 vs 引擎权威」二选一属宿主接线裁决，引擎侧需保证两种选择都成立（完成态纯渲染函数可直接内联替换）。
2. **消息分隔/元信息渲染**：方案 A（低成本）——宿主在 readOnly MarkdownEngine 外层自行包装消息头（ChatAssistantMessageRow 已渲染 Thinking 折叠/消息主体，实证存在）；方案 B——引擎提供 `<MessageShell meta footer>` 容器契约（时间戳/模型/状态槽位），复用 readOnly 实例。建议先 A 后 B（A 零引擎改动）。
3. **跨消息 fence 重置验证**：实例工厂已天然隔离（每消息一个 `createEditorStore()` 实例，state/订阅全链隔离）；需要的是**门禁测试锁定**：消息 A 以未闭合 fence 结束 → 消息 B 新实例的 codeBlockState 从 'none' 起步（fence_start 正确开启）。若宿主复用单实例（滚动虚拟化需要共享容器时），`setText` 已整文档重置（EditorStore.ts:1491-1581），需补复位语义验证。

**复用现状**：readOnly / streamAppend / streamEnd / 软渲染（R3-C）/ 实例工厂全部就绪；缺软渲染视觉稳定化、一致性验证与 fence 隔离门禁测试。

**工作量**：2-3 人日（以验证与测试为主，渲染分支改动小）。

**价值评分**：5（每条 AI 消息必经，宿主体感第一触点）。

---

### N2 大纲/标题索引

**宿主场景**：百万 token 会话回看，「找某个结论在哪」是回看的第一动作；当前宿主会话列表只有消息级滚动，无大纲。大纲面板 = 结构化导航入口（05 §2.2）。

**引擎侧实现方案**：
1. **heading 增量索引**：head 解析已产出 `headingLevel`（parser.ts:1692-1699、ast.ts:72）。索引结构与 fenceLines 同款：有序数组 `headingLines: {lineIdx, level, text, offset}[]` + 双段（main/streamTail）+ 惰性物化，挂在 updateLinesIncremental 的 delta 回调（与 fenceLines 组装同构，EditorStore.ts:924-965）或独立增量维护器；追加/编辑时 O(delta) 更新。
2. **OutlinePanel**：消费索引渲染嵌套树（level 缩进）+ 当前视口章节高亮（HeightMap.indexAt 定位视口首行 → 二分查所属 heading）。
3. **跳转**：`virtualizer.scrollToIndex` 或 `HeightMap.posOf(lineIdx)` 命令式滚动（两者现成）。

**复用现状**：headingLevel 已在 AST；fenceLines 增量范式可镜像；HeightMap.posOf / virtualizer 现成；只读态点击跳转无光标副作用（readOnly 已短路光标定位）。

**工作量**：3-4 人日（索引维护器 + OutlinePanel + 门禁测试）。

**价值评分**：4.5（宿主高排序项，百万 token 会话的结构化回看入口）。

---

### N3 折叠区间 API

**宿主场景**：长会话中旧消息折叠为单行摘要、超长代码块折叠；折叠状态按消息边界天然切分（存 host session_meta / 前端 store，05 §2.2 第 3 点）。

**引擎侧实现方案**：
1. **fold ranges 数据**：`{startLine, endLine, summary?}[]`（可嵌套），引擎只消费不持久化（宿主注入）。
2. **折叠感知行高**：HeightMap 已实现 `insert/delete`（HeightMap.ts:417-449，注释明示「滚动管线批在编辑定位信息接入后使用」——这就是预留的折叠接缝）：折叠区间内行从渲染视图中剔除、占位行插入；estimateSize 对折叠行返回固定占位高。难点在折叠/展开触发 HeightMap 结构变更 + virtualizer count 变化的联动（现链路 syncTo 尾部对齐为主，中间变更需走 insert/delete + rebuildIndexes）。
3. **折叠占位行渲染**：BlockRenderer 注册折叠占位渲染器（BlockRendererRegistry 机制现成）+ 展开按钮回调。

**复用现状**：HeightMap.insert/delete 已实现未接线（最关键的预留）；虚拟滚动、registry 现成。折叠与行高耦合是本项主要风险（05 项 6 同判）。

**工作量**：4-6 人日（行高联动是本引擎「疑难杂症」级改动，需穷举测试）。

**价值评分**：4（历史折叠直接改变长会话浏览效率；长代码块折叠覆盖工具产物场景）。

---

### N4 工具产物渲染（fence lang 分发）

**宿主场景**：每次工具调用都产生结构化输出（JSON 树 / diff / log 流 / 表格型结果），当前宿主多为纯文本一行到底；diff 无红绿、日志无级别着色。

**引擎侧实现方案**：
1. **lang 分发注册表**：`BlockRendererRegistry` 是 LineType 键（BlockRenderer.tsx:124-167），fence lang 分发需在其上叠加 lang 键注册表：`registerFenceLangRenderer(lang, (contentLines, meta) => ReactNode)`；lang 已在 fence_start 行提取（BlockRenderer.tsx:218）。
2. **json 渲染器**：折叠 JSON 树（键值/数组长度/行内值/展开复制）——树内折叠与 N3 行级折叠正交，独立实现成本低。
3. **diff 渲染器**：fence 内逐行 `+`/`-` 前缀判定（parseCodeLine 已逐行 token 化）+ 红绿着色。
4. **log 渲染器**：ERROR/WARN/INFO 级别着色 + 时间戳弱化。
5. **块边界**：fenceLines 有序数组 O(log n) 定位代码块区间（复制整块/行号/上下文）。

**复用现状**：lang 提取、fenceLines、registry 机制（BlockRendererRegistry + InlineRuler.register 双先例）、表格能力（```table 产物直接复用 TableOperations）。

**工作量**：3-5 人日（registry 骨架 1 日 + 三个渲染器各 1-1.5 日）。

**价值评分**：4.5（每次工具调用都受益，工具流是宿主区别于普通聊天的核心交互）。

---

### N5 导出与复制（renderToHTML / 代码块复制 / 公式复制）

**宿主场景**：会话归档导出（沉淀的终点是带走）+ 高频复制微操作（工具产物查看后必然复制，成本最低见效最快，05 §2.7）。

**引擎侧实现方案**：
1. **renderToHTML 纯函数**：AST → HTML 投影器，复用 BlockRenderer 渲染语义（KaTeX/表格/代码高亮）但无交互层；样式内联 + 打印 CSS（表格/代码块不跨页）。纯函数可测，输出即「完成态权威渲染」的最小验证面（与 N1 的 E2.2 裁决复用同一投影）。
2. **代码块复制按钮**：fence 区间 = fenceLines 二分定位（EditorStore.ts:924-965 同款范式），hover 复制拼接原文行（复用 Clipboard 先例：MarkdownEngine onCopy / HiddenInput linewiseCopy，HiddenInput.tsx:313-314、935-942）。
3. **公式复制**：LaTeX 源在 math token raw / math-source span（InlineRenderer.tsx:196-197 已渲染 `data-sub-offset=0` 的 math-source），取 raw 即复制。

**复用现状**：getText() 天然导出 md（零成本）；KaTeX/表格/registry 现成；复制先例三处。

**工作量**：3-4 人日（renderToHTML 投影器为主）。

**价值评分**：3.5（导出中频、复制高频微操作；但复制按钮与导出均可被宿主先以轻量方案替代，故价值低于 N1/N4）。

---

### N6 搜索增强（替换 / 跳转 / 命中计数）

**宿主场景**：长会话回看定位刚需（05 §2.5）——「找那个结论在哪」；工具产物文档（00-summary 索引）本身就是搜索入口的形态。引擎当前零搜索本体（只有高亮接入点）。

**引擎侧实现方案**：
1. **search API**：行级全文扫描（数据模型是 lines + offset 树，行级扫描天然匹配）；大文档走主线程 requestIdleCallback 分批（EditorStore.ts:1546-1560 先例）——**不走 worker**（RL-05 #10 禁令）。命中结果 `[{lineIdx, from, to}]`，跨行命中（fence 内）合并。
2. **高亮**：DecorationSet.addSearchRange/clearSearch 已就绪（DecorationSet.ts:221-229），命中区间直接注入；token 级高亮渲染已预留（行级 is-search-line class 已接线，MarkdownEngine.tsx:194、237）。
3. **替换**：`applyChange(from, to, insert)` 事务入口现成（EditorStore.ts:1713），命中区间 → 替换事务 → 单步 undo，零新语义。
4. **跳转**：`HeightMap.indexAt` + scrollToIndex + 当前页命中优先（01 性能模型已具备）。
5. **命中计数**：search 装饰 getKind('search').length（DecorationSet.ts:217-219 O(1) 现成）。

**复用现状**：高亮层/事务层/定位层全部现成——缺的只是「搜索本体」与 UI 壳（宿主搜索框 → search/gotoMatch API）。

**工作量**：3-4 人日。

**价值评分**：4（定位刚需；替换为加分项，readOnly 场景下替换可禁用）。

---

### N7 多文档/工作区（实例池化）

**宿主场景**：04-EG 已把 .agent-outputs/ 多 Agent 产出目录落地为引擎强制面，多文档消费是产出形态的必然结果；文档切换保活（切走再切回不重建解析状态）。

**引擎侧实现方案**：
1. **实例池化**：`createEditorStore()` 工厂现成（EditorStore.ts:2496），补一个轻量池 `createStorePool(max)`：LRU keep-alive——不活跃实例的 store 保留（状态/undo/滚动位置保活），超上限按 LRU 释放；切换 = 取池 → `setText`（或保活实例直接复用）。
2. **切换 API**：`pool.switch(id, text?)` + 文档标题/活动文档状态（host 快速切换面板消费）。

**复用现状**：工厂就绪；保活的核心难点（undo 栈/光标/滚动位置随实例保留）已被实例化设计天然覆盖；池化只是 LRU 容器。

**工作量**：2-3 人日。

**价值评分**：3（宿主中频、工作区形态的结构性前置；单文档会话历史渲染主线下不紧迫）。

---

### N8 协作预留落地（位置级 op + 变更日志 + 版本号）

**宿主场景**：任务书声明宿主 ZenNav sync 服务端已就绪，引擎作为渲染核心需产出可同步的位置级操作。注：仓库内仅检索到 navigation-site（跃览导航）相关引用，未见 sync 服务端文档——「已就绪」以任务书为准，落地前需宿主确认消费端契约（op 序列化格式/版本协商）。

**引擎侧实现方案**（对齐 06 §4 近期项）：
1. **EditorOperation 补位置级字段**：现状是行级 splice（EditorStore.ts:475-498），补 `from/to/insert/removedText`（字符级）——applyChange 已收敛全部写路径（EditorStore.ts:1713），可在事务点记录位置级信息而不改变 undo/redo 行级语义；undo/redo 兼容层（336 门禁）是硬约束。
2. **append-only 变更日志**：每事务追加 `{seq, op}` + `docVersion` 单调版本号（与 R3-A 流式合并记账联动：meta:'stream' op 也在日志中）。
3. **同步导出**：`serializeOps(sinceSeq)` 快照接口，供 sync 客户端消费。

**复用现状**：applyChange 单入口就绪；op 已有行级 OT 友好形状（05 §2.6）；gap = 位置级字段 + 日志 + 版本号。

**工作量**：3-5 人日（触碰 undo/redo/流式合并三处兼容面，回归风险集中）。

**价值评分**：3.5（协作场景宿主低频，但 sync 是已立项近期项；引擎侧先行把 op 形状立好可避免后续返工）。

---

### N9 readOnly 选择复制增强（复制为 Markdown）

**宿主场景**：消息历史是 readOnly 渲染，用户选中一段内容后希望「复制为 Markdown 源码」（贴到别处/喂给模型）；当前 readOnly 复制走浏览器默认通道复制的是**渲染文本**（MarkdownEngine.tsx:891-893 显式不拦截）。

**引擎侧实现方案**：
1. **DOM 选区 → 源码偏移映射**：readOnly 下原生选区保留；复制事件拦截后遍历选区（range.startContainer/endContainer），经 `data-token-start`/`data-sub-offset` 无损映射（MarkdownEngine.tsx:71-73、244-253 同一映射）解析源码字符区间 → `getText().substring(from, to)`。
2. **入口**：readOnly 上下文菜单「复制为 Markdown」项（ContextMenu 现成组件，ContextMenu.tsx:84）+ Ctrl+C 智能分支（readOnly 下默认复制渲染文本，带菜单项/按钮时切源码）。
3. 边界：选区跨 KaTeX 渲染（math-source span 有 data-sub-offset=0）、表格单元格、fence 内行——token 映射已覆盖，需门禁测试锁定。

**复用现状**：readOnly 原生选区保留；token↔源码无损映射现成；ContextMenu 现成。

**工作量**：2-3 人日。

**价值评分**：4（宿主高频微操作，消息历史「复制结论」是最常见动作；实现纯引擎内、零宿主接线）。

---

### N10 性能观察（__CRISH_METRICS__ 扩展）

**宿主场景**：宿主调试流式/渲染性能（23 方案 E2.4 性能验证、首 token/帧率基线）；引擎接入宿主后需要可观测性而不引入宿主调试面板。

**引擎侧实现方案**：
1. **迁移进引擎 core**：当前 `__CRISH_METRICS__` 挂在 demo 壳 main.tsx:26-58——迁入引擎 core 模块单例（renderTheme.ts 同款形态，挂载即自动启用），宿主无需引 demo 壳。
2. **扩展指标**：FPS/渲染帧耗时（rAF 计数）、parser 缓存命中（getCacheStats 已有）、**物化计数**（materializeViews 调用计数——R6-P1 惰性化后物化是性能信号，EditorStore.ts:1009-1029）、HeightMap 统计（oracle.stats/HeightMap.stats 已有，HeightMap.ts:131、271）、DecorationSet bucketCount（DecorationSet.ts:82）、layoutThrashCount（main.tsx:45-58 哨兵迁移）。
3. **顺手修正**：现有 `getLineCount` 经 `lines.length` 读取会**触发惰性物化**（main.tsx:28）——改访问器 `getLineCount()`（R6-P1 口径）。

**复用现状**：雏形与统计字段全部现成，主要是迁移 + 接线。

**工作量**：1-2 人日（本轮 10 项中最便宜）。

**价值评分**：3.5（开发者价值而非用户价值，但它是 E2.4 性能验证与后续优化的事实基础，性价比最高）。

---

## 3. 推荐优先级组合（结合对话流主线的详细说明）

### 第一批 P0（对话流即时底座）：N1 + N9 + N10

- **N1 是主线**：AsyncMarkdownBlock 接线（23 方案 E2.1-E2.4）的核心承接面——引擎 readOnly 软渲染替代伪流式纯文本，streamEnd 完成态收敛。其中「跨消息 fence 重置验证」是上线的正确性前提（门禁测试），「软渲染视觉稳定化」决定用户体感。
- **N9 紧随**：readOnly 上线即暴露复制语义问题（渲染文本 vs Markdown 源码），同一组件内顺路做掉成本最低。
- **N10 先行**：1-2 人日拿到 FPS/缓存/物化基线，E2.4 性能验证（≥10k 字符流式帧率）才有测量口径；且 N10 的物化计数能立即暴露宿主每消息实例化场景的物化成本。
- 依赖关系：N1 依赖 readOnly（已就绪）与 E2.2 裁决（引擎权威 vs md_render 权威二选一，宿主侧决策，引擎需保持两可）。

### 第二批 P1（阅读与定位）：N2 + N6 + N3

- **N2（大纲）**：05 方案阶段建议中第一批项（场景 2 宿主主线），百万 token 会话的结构化回看入口，价值最高。
- **N6（搜索）**：与大纲同属「定位」主题，共享 scrollToIndex/DecorationSet 设施；替换能力在 readOnly 消息历史场景可禁用（只留高亮/跳转/计数），工作内容缩减。
- **N3（折叠）**：与 N6 并行（行高模型改动独立），历史折叠按消息边界切分天然对接宿主会话结构；与 N2 共享 HeightMap 定位设施。
- 三者共用「滚动定位」设施，同轮实现能分摊 virtualizer/HeightMap 联动调试成本。

### 第三批 P2（工具产物与出口）：N4 + N5

- **N4**：工具流是宿主差异化核心交互，每次工具调用都受益；lang 分发注册表同时服务「宿主自定义产物类型」（注册面开放）。
- **N5**：导出是归档出口（会话导出 md 已有 getText 零成本，renderToHTML 是 HTML 形态的出口）；复制按钮与 N4 的块定位设施共享。
- 依赖：N4/N5 均依赖 fenceLines 块定位（已就绪），N5 的 renderToHTML 投影器与 N1 的完成态权威渲染语义共用（一次实现两处受益）。

### 第四批 P3（工作区与协作）：N7 + N8

- **N7**：文档工作区（04-EG 形态）的结构性前置，但会话历史渲染主线不依赖它，可后置。
- **N8**：按宿主 sync 节奏落地——引擎侧先立 op 形状与版本号（避免宿主 sync 消费端先行定型后返工），但触碰 undo/redo/流式合并三处兼容面，回归风险集中，建议独立轮次并跑满门禁。

---

## 4. 风险与边界

| 风险/边界 | 说明 | 对策 |
|---|---|---|
| 软→硬渲染视觉跳变 | 流式软渲染与完成态不一致（高亮/表格/数学边界） | N1 视觉稳定化 + E2.4 视觉对比测试（23 方案已有口径）；renderToHTML（N5）复用同一投影器保证语义单源 |
| 折叠与行高耦合 | HeightMap.insert/delete 预留但未接线，中间行变更联动（虚拟窗口/测量回环）是引擎内最难改动之一 | N3 独立轮次 + 穷举门禁测试；折叠后固定行高模式兜底 |
| 搜索/大纲增量一致性 | 索引在编辑后失效 | 快照重扫兜底（行级模型成本可控）；增量维护挂 updateLinesIncremental delta（fenceLines 同构，N2 起步即增量） |
| 跨消息 fence 状态 | 流式时 fence 不得跨消息传播 | 实例工厂隔离（已天然满足）+ 门禁测试锁定（N1）；复用单实例时 setText 复位验证 |
| EditorOperation 扩展回归 | N8 触碰 undo/redo 兼容层（336 门禁）与流式合并（R3-A 记账） | 独立轮次、逐分支兼容测试；位置级字段只增不改（旧字段保留） |
| 宿主侧上下文未对齐 | 任务书引用的 CONVERSATION_FLOW_SPEC.md 不存在；ZenNav sync 服务端文档未检索到 | 本分析已标注；接线前（N1 宿主侧、N8 消费端契约）需与主 Agent/宿主侧重新对齐 |
| 门禁红线（跨批次共享） | 引擎改动后必须跑通 `npm test`（vitest run tests/unit，含 grapheme/undo/parser-redos/chunk）；新增功能自带单测并入库；不新增 worker 渲染路线（RL-05 #10） | 每项落地即提交（测试是资产）；大文档搜索走 requestIdleCallback 分批（EditorStore.ts:1546-1560 先例） |
| 引擎组件库化形态 | 引擎仍是 Vite 应用 + demo 壳（App.tsx 硬编码），宿主消费需组件化契约 | N10 把 metrics 迁出 demo 壳即第一步组件化；N1/N9 依赖的只读组件契约已成形（store prop + readOnly prop） |

---

*End of status-P3 新需求方向（A3 子 Agent 分析产出，2026-08-10）*
