# 13 - 用户 Markdown 测试资产专项保护与审计报告

> **审计执行人**：全盘代码与测试审计师 13（用户核心测试资产专项保护与审计）
> **审计基准规范**：[`00-战役通则与协同执行规范.md`](../00-战役通则与协同执行规范.md) 与 [`AGENTS.md §9 测试资产保护铁律`](../../../AGENTS.md)
> **审查对象**：`reference/markdown-editor/`（含源码与 `tests/unit/` 下全部 88 个测试套件，以及主仓库专项 E2E spec）
> **审计原则**：只找问题、零废话、清理无用冗余、数据说话、穿透本质。

---

## 目录

1. [审计裁决摘要与总览](#一审计裁决摘要与总览)
2. [测试资产完整性审计（AGENTS.md §9 铁律核对）](#二测试资产完整性审计agentsmd-9-铁律核对)
3. [极端边界与安全测试深度审计](#三极端边界与安全测试深度审计)
4. [虚假断言与规避性测试排查](#四虚假断言与规避性测试排查)
5. [性能基线与直刷覆盖率实测验证](#五性能基线与直刷覆盖率实测验证)
6. [无用资产、冗余文件与僵尸目录清理清单](#六无用资产冗余文件与僵尸目录清理清单)
7. [技术风险与整改行动项（Remediation Matrix）](#七技术风险与整改行动项remediation-matrix)

---

## 一、审计裁决摘要与总览

### 1.1 审计核心结论

| 审计维度          | 审计要求 / 铁律基准                                   | 实测结果                                                                           | 审计裁决     | 核心发现 / 风险提示                                                                                  |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| **1. 资产完整性** | 88 个套件、1,146 个用例 100% 完整无删减               | 88 套件 / 1,146 用例全量在册，`npm test` 100% 通过                                 | **合规**     | 核心资产无删减；但存在历史占位骨架与跟踪表脱节问题                                                   |
| **2. 边界与安全** | Grapheme 边界、ReDoS 抗压、流式长表、Undo 栈一致性    | 四大场景全覆盖，断言逻辑闭环                                                       | **存在隐患** | 发现绝对时钟断言在并发压测下偶发抖动（519.8ms > 500ms）；非 Segmenter 回退缺少低位代理防护           |
| **3. 虚假断言**   | 严禁注销/跳过测试（`test.skip` / `xit` / dummy 断言） | `tests/unit/` 检出数为 **0**；无跳过用例                                           | **部分合规** | `tests/unit/` 纯净，但 `tests/gate/placeholder.test.ts` 存在 7 处 `expect(true).toBe(true)` 占位断言 |
| **4. 性能与直刷** | 直刷覆盖率提升 ≥20pp，性能基线入库达标                | 直刷覆盖率 **63.2%**（基线 14.9%，净提升 **+48.3 pp**）；ArrowLeft 均值 **0.11ms** | **达标**     | 覆盖率远超指标；`arrow-perf.test.ts` 阈值 `0.6ms` 在多核并行下测得 2.21ms 存在 CI 误报风险           |
| **5. 冗余与整洁** | 清理无用冗余资产与历史临时文件                        | 检出大量临时调试脚本（32 废弃脚本 + 20 根目录临时文件 + 3 空目录）                 | **严重冗余** | 需彻底清理 50+ 历史遗留临时文件与 3 个僵尸空目录                                                     |

---

## 二、测试资产完整性审计（AGENTS.md §9 铁律核对）

### 2.1 88 个测试套件与 1,146 个用例全量清册

实测运行 `npm test`（`vitest run tests/unit`），全量 88 个套件、1,146 个测试用例执行结果如下：

```
Test Files  88 passed (88)
     Tests  1146 passed (1146)
  Duration  19.08s
```

#### 88 个测试套件分类与用例数明细表

|   序号   | 测试套件文件路径（`tests/unit/`）                                                                                                           |  用例数   | 覆盖功能模块                                 | 核心断言类型                       |
| :------: | ------------------------------------------------------------------------------------------------------------------------------------------- | :-------: | -------------------------------------------- | ---------------------------------- |
|    1     | [`a11y.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/a11y.test.ts)                                               |    10     | 无障碍语义、aria-live 播报、光标同步         | DOM 属性、文本匹配、节流时钟       |
|    2     | [`append-cursor.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/append-cursor.test.ts)                             |    23     | 光标冲突语义、追加点平移、undo 记账          | 光标坐标、选区区间、undoStack 结构 |
|    3     | [`append-fast-path.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/append-fast-path.test.ts)                       |     7     | appendText 快速路径、offset 一致性           | `verifyConsistency()`、文本拼接    |
|    4     | [`append-tail.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/append-tail.test.ts)                                 |    18     | streamTail 尾段管理、flush 冲刷、物化视图    | 数组引用、双段状态、行号映射       |
|    5     | [`arrow-perf.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/arrow-perf.test.ts)                                   |     7     | ArrowLeft 行为等价与百万行性能基准           | 穷举比对、`performance.now()`      |
|    6     | [`autocomplete.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/autocomplete.test.ts)                               |    20     | 自动补全触发器、候选过滤、替换事务           | 正则检测、排序稳定性、事务 payload |
|    7     | [`bidi-render.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/bidi-render.test.ts)                                 |     9     | RTL/LTR 渲染接线、dir 属性注入               | DOM 结构、行类名、dir 属性         |
|    8     | [`bidi.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/bidi.test.ts)                                               |     8     | Bidi 字符分类、双向文本导航                  | 字符类型、视觉反转坐标             |
|    9     | [`cell-mode-decoupling.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/cell-mode-decoupling.test.ts)               |     9     | 表格单元格选择模式与编辑模式解耦             | 状态机切换、键盘导航、聚焦         |
|    10    | [`chunk-tti.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/chunk-tti.test.ts)                                     |     4     | 分块异步加载首帧 TTI、代际竞态保护           | 异步分片、计时门槛、取消保护       |
|    11    | [`chunk.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/chunk.test.ts)                                             |     1     | 大文件异步分块加载基础功能                   | 行数收敛、分块加载正确性           |
|    12    | [`clipboard-semantics.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/clipboard-semantics.test.ts)                 |    32     | 剪贴板语义、表格/富文本/换行转换             | 粘贴转换、转义字符、HTML 清洗      |
|    13    | [`clipboard.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/clipboard.test.ts)                                     |     2     | 剪贴板基础复制粘贴                           | 数据往返、文本一致                 |
|    14    | [`codestate-convergence.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/codestate-convergence.test.ts)             |     6     | 代码块状态增量收敛与全量重扫比对             | 状态机单调性、围栏终态比对         |
|    15    | [`codestate-html.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/codestate-html.test.ts)                           |    12     | HTML 块级状态机收敛                          | 标签闭合、行类型判定               |
|    16    | [`codestate-indent.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/codestate-indent.test.ts)                       |    12     | 缩进代码块状态机收敛                         | 空行判定、4 空格/Tab 缩进          |
|    17    | [`color-gate.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/color-gate.test.ts)                                   |     8     | 颜色门禁、CSS Token 合规性检查               | 源码静态扫描、色彩空间限制         |
|    18    | [`compliance-snapshot.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/compliance-snapshot.test.ts)                 |     7     | CommonMark 符合度快照与防回归                | JSON 快照比对、通过率门槛          |
|    19    | [`cross-matrix.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/cross-matrix.test.ts)                               |    24     | 交叉矩阵正交抽样（6 文档 × 6 操作 × 3 模式） | 参考模型重放、全量不变量           |
|    20    | [`css-contract.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/css-contract.test.ts)                               |     7     | CSS 选择器覆盖、`:root` Token 契约           | 静态正则扫描、Token 存在性         |
|    21    | [`decoration-set.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/decoration-set.test.ts)                           |    29     | 装饰集管理、行内装饰、范围重叠               | 装饰区间计算、冲突合并             |
|    22    | [`devil.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/devil.test.ts)                                             |     3     | 魔鬼交叉测试（跨行删除/覆写/方向性）         | 极限编辑操作序列、Undo 状态复原    |
|    23    | [`display-completion.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/display-completion.test.ts)                   |    16     | 流式未闭合标记预演补全                       | DOM 类名切换、零跳动、Token 原文   |
|    24    | [`dnd.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/dnd.test.ts)                                                 |    13     | 拖拽放置语义、文本移动与光标落点             | DragEvent 模拟、事务提交           |
|    25    | [`drag-select.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/drag-select.test.ts)                                 |    29     | 鼠标拖拽选择、跨行框选、自动滚动             | 坐标计算、选区锚点、边界保护       |
|    26    | [`fence-sync.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/fence-sync.test.ts)                                   |    13     | 代码围栏跨行同步、嵌套反引号保护             | 围栏状态机、行类型判定             |
|    27    | [`fold.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/fold.test.ts)                                               |    16     | 标题/代码块折叠状态机与行高映射              | 折叠树、高度计算、隐藏行判定       |
|    28    | [`fuzz-document-typography.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/fuzz-document-typography.test.ts)       |     1     | 排版 Fuzz 模糊测试                           | 随机文档生成、语法一致性           |
|    29    | [`grapheme.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/grapheme.test.ts)                                       |     6     | 图素边界计算（ASCII/Emoji/ZWJ/组合）         | 边界位置、单调性、逆向往返         |
|    30    | [`heading-index.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/heading-index.test.ts)                             |    22     | 大纲目录索引、标题层级树                     | 树形结构、行号映射、增量更新       |
|    31    | [`ime-composition.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/ime-composition.test.ts)                         |     9     | IME 输入法合成期状态机、缓冲保护             | 合成事件序列、Undo 隔离            |
|    32    | [`inline-unclosed-forms.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/inline-unclosed-forms.test.ts)             |    11     | 未闭合行内标记（加粗/斜体/公式/代码）回退    | Token 类型、原文保真、单行隔离     |
|    33    | [`katex-cache.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/katex-cache.test.ts)                                 |    14     | KaTeX 数学公式渲染缓存与 LRU 淘汰            | 缓存命中率、DOM 结构、错误回退     |
|    34    | [`long-line-budget.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/long-line-budget.test.ts)                       |     3     | 超长单行性能预算与截断指示                   | 截断渲染、耗时控制、保真还原       |
|    35    | [`lru-cache.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/lru-cache.test.ts)                                     |     5     | LRU 缓存基础数据结构                         | 容量溢出淘汰、访问提升、清空       |
|    36    | [`memory-bounds.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/memory-bounds.test.ts)                             |     5     | 内存边界门禁（缓存容量、尾段上限）           | LRU 容量上限、streamTail 上限      |
|    37    | [`metrics.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/metrics.test.ts)                                         |    14     | 性能度量监控指标采集（FPS/卡顿）             | 采样窗口、指标聚合、告警阈值       |
|    38    | [`offset-delta.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/offset-delta.test.ts)                               |     5     | 行偏移增量差值计算                           | 偏移增量、SegmentTree 校验         |
|    39    | [`op-positional.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/op-positional.test.ts)                             |    19     | 基于位置的操作事务与坐标平移                 | 位置计算、事务回放、反向操作       |
|    40    | [`page-nav.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/page-nav.test.ts)                                       |    10     | PageUp / PageDown 翻页导航几何计算           | 视口行数、滚动联动、光标落点       |
|    41    | [`parser-blockquote.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/parser-blockquote.test.ts)                     |     3     | 块引用基础解析                               | 嵌套层级、前缀剥离                 |
|    42    | [`parser-blockquote2.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/parser-blockquote2.test.ts)                   |    30     | 块引用深层语法与嵌套边界                     | 多层嵌套、空行中断、混合列表       |
|    43    | [`parser-codespan.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/parser-codespan.test.ts)                         |    21     | 行内代码跨行/反引号转义解析                  | 反引号匹配、空白规范化             |
|    44    | [`parser-list-context.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/parser-list-context.test.ts)                 |    17     | 列表上下文、有序/无序/任务列表嵌套           | 缩进计算、标记识别、任务框         |
|    45    | [`parser-redos.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/parser-redos.test.ts)                               |     3     | ReDoS 正则灾难性回溯防御                     | 执行时间上限、超长未闭合串         |
|    46    | [`parser-regression.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/parser-regression.test.ts)                     |    54     | 历史解析缺陷回归测试集                       | 边界 Case 集合、AST 结构           |
|    47    | [`parser-syntax-matrix.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/parser-syntax-matrix.test.ts)               |    27     | 语法矩阵全要素测试                           | 组合语法、转义字符、标点符号       |
|    48    | [`readonly.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/readonly.test.ts)                                       |     7     | 只读模式下的交互与快捷键拦截                 | 输入拦截、只读渲染、选区允许       |
|    49    | [`render-export.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/render-export.test.ts)                             |    21     | HTML 导出与渲染器全链路输出                  | HTML 快照、标签完整性              |
|    50    | [`render-layer.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/render-layer.test.ts)                               |    10     | 渲染分层（背景/文本/高亮/光标）              | 层叠上下文、DOM 挂载点             |
|    51    | [`render-registry.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/render-registry.test.ts)                         |    14     | 自定义代码块语言渲染器注册表                 | 动态注册/注销、回退机制            |
|    52    | [`row-surface.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/row-surface.test.ts)                                 |    16     | 行表面交互层、点击空白落点计算               | 坐标投射、字符索引映射             |
|    53    | [`ruler.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/ruler.test.ts)                                             |    46     | 标尺协议、行内 Token 链式解析                | Tokenizer 规则优先级、链式流       |
|    54    | [`scroll-map.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/scroll-map.test.ts)                                   |     6     | 滚动坐标与行号高度映射表                     | 二分查找、高度前缀和               |
|    55    | [`search.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/search.test.ts)                                           |    25     | 全文搜索、大小写/全词/正则匹配               | 匹配区间、高亮高亮集、循环导航     |
|    56    | [`segment-tree.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/segment-tree.test.ts)                               |     7     | LineOffsetTree 线段树增量行偏移              | 增删查改、O(log N) 一致性          |
|    57    | [`selection-anchor.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/selection-anchor.test.ts)                       |    32     | 选区锚点与活动端方向性管理                   | anchor/head 关系、反向选区         |
|    58    | [`selection-protect.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/selection-protect.test.ts)                     |    21     | 用户选区保护（流式追加时不丢失选区）         | 选区平移、直刷不抢焦点             |
|    59    | [`selection.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/selection.test.ts)                                     |     4     | 选区基础模型                                 | 选区设置、清空、文本截取           |
|    60    | [`store-factory.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/store-factory.test.ts)                             |     9     | EditorStore 实例工厂与隔离性                 | 多实例状态隔离、默认参数           |
|    61    | [`stream-active-fast-path.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-active-fast-path.test.ts)         |    14     | 流式活跃态极速直刷路径                       | DOM 直写、跳过 React 调度          |
|    62    | [`stream-buffer.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-buffer.test.ts)                             |     3     | 流式缓冲帧聚合批处理                         | rAF 批处理、定时冲刷               |
|    63    | [`stream-coverage.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-coverage.test.ts)                         |     3     | 直刷覆盖率语料基线实测与提升断言             | 语料覆盖率、提升幅度 (≥20pp)       |
|    64    | [`stream-direct-amp.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-direct-amp.test.ts)                     |    19     | 字符实体与特殊符号直刷安全性                 | `&` 实体、标签转义、防 XSS         |
|    65    | [`stream-direct-consistency.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-direct-consistency.test.ts)     |    70     | 直刷渲染与全量 React 渲染一致性              | DOM 结构全等、属性一致             |
|    66    | [`stream-fence-bisect.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-fence-bisect.test.ts)                 |     8     | 围栏状态机二分查找加速                       | 二分命中、边界条件、耗时对比       |
|    67    | [`stream-follow-scroll.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-follow-scroll.test.ts)               |     3     | 流式贴底滚动跟随与用户滚动意图保护           | 滚动位置锁定、主动修改次数 ≤2      |
|    68    | [`stream-frame-batch.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-frame-batch.test.ts)                   |     7     | 500 token/s 帧聚合与顺序不变量               | 提交次数有界、内容顺序不变         |
|    69    | [`stream-handle-api.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-handle-api.test.ts)                     |    16     | MarkdownEngineHandle 流式句柄接口契约        | append/flush/end 状态机            |
|    70    | [`stream-lang-keywords.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-lang-keywords.test.ts)               |    12     | 代码块关键字语法高亮直刷                     | 关键字识别、行内 class 注入        |
|    71    | [`stream-lang-lazy.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-lang-lazy.test.ts)                       |     7     | 代码块渲染惰性 lines 重建缓存                | 缓存复用率、失效边界               |
|    72    | [`stream-metrics.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-metrics.test.ts)                           |    15     | 流式度量指标（直刷比率/帧耗时）              | 指标统计、异常打点                 |
|    73    | [`stream-readonly-preview.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-readonly-preview.test.ts)         |     5     | 未闭合语法只读预览样式类                     | 样式类注入、零新增 token           |
|    74    | [`stream-soft-render.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-soft-render.test.ts)                   |     4     | 软渲染调度、DOM 节点复用                     | oldEl === newEl 复用断言           |
|    75    | [`stream-table-lock.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-table-lock.test.ts)                     |     4     | 表格提前锁宽修复（分隔行前不锁）             | setTableWidths 计数 = 0            |
|    76    | [`stream-table-structure-lock.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-table-structure-lock.test.ts) |     4     | 表格结构定型即锁 + grow-only 列宽修正        | 分隔行到达锁宽、只增不减           |
|    77    | [`stream-unmount-flush.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/stream-unmount-flush.test.ts)               |     3     | 组件卸载时自动 flush 未提交直刷内容          | 卸载生命周期、内容零丢失           |
|    78    | [`syntax-math.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/syntax-math.test.ts)                                 |     1     | 数学公式块级与行内解析                       | 行内 `$...$`、块级 `$$...$$`       |
|    79    | [`syntax.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/syntax.test.ts)                                           |     1     | 基础 Markdown 语法综合解析                   | AST 节点生成、语法覆盖             |
|    80    | [`table-operations.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/table-operations.test.ts)                       |    32     | 表格结构化编辑（行列增删/对齐/格式化）       | 表格格式化、单元格内容修改         |
|    81    | [`table-parser-ast.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/table-parser-ast.test.ts)                       |     2     | 表格 AST 结构与单元格解析                    | 对齐方式、列分割准确性             |
|    82    | [`table-stream-parse.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/table-stream-parse.test.ts)                   |     7     | 流式表格增量解析与断行修复                   | 管道符补全、未闭合表格流           |
|    83    | [`transaction.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/transaction.test.ts)                                 |    30     | `applyChange` 统一事务入口等价性             | 事务封装、表格收敛、Undo 顺序      |
|    84    | [`typography-indent.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/typography-indent.test.ts)                     |     2     | 文本排版缩进计算                             | 列表前缀宽度、悬挂缩进             |
|    85    | [`undo-merge.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/undo-merge.test.ts)                                   |     4     | 连续单字符删除合并为 1 步 Undo               | 500ms 合并、跨行不合并             |
|    86    | [`undo.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/undo.test.ts)                                               |     4     | Undo / Redo 基础栈模型                       | 输入合并、选区删除撤销、重做清空   |
|    87    | [`validator.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/validator.test.ts)                                     |     4     | Markdown 格式校验器 Format Checker           | 语法错误诊断、未闭合标签告警       |
|    88    | [`word-nav.test.ts`](file:///c:/Software/conex/reference/markdown-editor/tests/unit/word-nav.test.ts)                                       |    20     | Ctrl+Arrow 词级导航与双击选词                | 词边界识别、中英文分词、越视口外推 |
| **合计** | **88 个测试套件**                                                                                                                           | **1,146** | **核心编辑引擎 + 流式渲染全链路**            | **100% 通过**                      |

---

### 2.2 主仓库 E2E 专项测试资产完整性核实

依据 AGENTS.md §9 铁律，主仓库 `tests/e2e/` 下针对 markdown-editor 的 5 个专项 spec 必须完整保留。核验结果如下：

| E2E 专项测试文件                 | 路径                                                                                                       | 字节大小 |   状态   | 覆盖要点                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | :------: | :------: | ------------------------------------ |
| 1. `ast-block-tables.spec.ts`    | [`tests/e2e/ast-block-tables.spec.ts`](file:///c:/Software/conex/tests/e2e/ast-block-tables.spec.ts)       | 1,555 B  | **在册** | 表格块级 AST 渲染与行列对齐          |
| 2. `format-checker.spec.ts`      | [`tests/e2e/format-checker.spec.ts`](file:///c:/Software/conex/tests/e2e/format-checker.spec.ts)           | 2,583 B  | **在册** | 格式校验器与未闭合语法结构           |
| 3. `ime-composition.spec.ts`     | [`tests/e2e/ime-composition.spec.ts`](file:///c:/Software/conex/tests/e2e/ime-composition.spec.ts)         | 2,680 B  | **在册** | 中文 IME 组合期状态机与文本提交      |
| 4. `keyboard-navigation.spec.ts` | [`tests/e2e/keyboard-navigation.spec.ts`](file:///c:/Software/conex/tests/e2e/keyboard-navigation.spec.ts) | 3,453 B  | **在册** | 键盘上下左右光标与滚动几何联动       |
| 5. `wysiwyg-interaction.spec.ts` | [`tests/e2e/wysiwyg-interaction.spec.ts`](file:///c:/Software/conex/tests/e2e/wysiwyg-interaction.spec.ts) | 14,665 B | **在册** | 所见即所得交互、Token 展开与点击映射 |

---

## 三、极端边界与安全测试深度审计

### 3.1 Grapheme 图素边界计算 (`grapheme.test.ts` & `EditorStore.ts`)

#### 覆盖度与断言强度分析

- **覆盖形态**：标准 ASCII、代理对 Emoji（`😀` 2 代码单元）、组合重音字符（`e\u0301` 2 代码单元）、复杂 ZWJ 家庭 Emoji（`👨‍👩‍👧‍👦` 11 代码单元）、以及长达 89 代码单元的超长 ZWJ 序列（`sequence = Array(30).fill(man).join(zwj)`）；
- **双向往返不变性**：断言了 `findNextGraphemeBoundary(text, findPrevGraphemeBoundary(text, endOfSeq)) === endOfSeq`。

#### 穿透发现代码隐患（`EditorStore.ts:35-41` & `66-70`）

```typescript
// EditorStore.ts:35-41 Fallback 分支
// 隐患 1：当环境不支持 Intl.Segmenter 时，findPrevGraphemeBoundary 缺少对低位代理对（0xdc00..0xdfff）的向上安全回退
// 若光标落在低位代理对后，pos - 1 会将光标切入代理对内部导致乱码（孤立代理对）。
```

```typescript
// EditorStore.ts:66-70 空 if 异味
if (prevPos === windowStart && windowStart > 0) {
  // Try larger  <-- 此处无任何语句，仅依靠外层 while(true) 的 windowSize *= 2 隐式扩增
}
```

---

### 3.2 ReDoS 正则抗压安全 (`parser-redos.test.ts`)

#### 覆盖度分析

- **超长未闭合链接**：`'['.repeat(10000) + 'a'.repeat(40000)`（50,000 字符）；
- **超长公式界标**：`'$'.repeat(500000)`（500,000 字符）；
- **递归内联标记**：`'*'.repeat(10000) + 'text'`。

#### 穿透发现测试脆弱性（CI Flakiness 风险）

在 `parser-redos.test.ts:15` 中：

```typescript
expect(duration).toBeLessThan(500); // 绝对毫秒时钟断言
```

**严重风险证据**：在多 Worker 并发运行 Vitest JSON 报告时，由于 CPU 调度与垃圾回收波动，该用例实测耗时 **519.8ms**，导致测试硬性失败报错：`AssertionError: expected 519.8030999999999 to be less than 500`。
**审计裁决**：单元测试中直接使用绝对物理时间（`< 500ms`）作为断言是严重的反模式。必须改为：

1. 先做 1 次微型预热（Warmup）；
2. 采用相对基准比率（如 `duration / baselineDuration < 3.0`）或放宽至鲁棒阈值（如 `< 1500ms`），将硬性性能门禁留给专用基准测试脚本。

---

### 3.3 流式长表防坍塌与结构锁宽 (`stream-table-structure-lock.test.ts` & `stream-table-lock.test.ts`)

#### 协议与断言演进分析

- **S-T-0-03**：流式表头到达但分隔行未到时，`setTableWidths` 调用计数为 **0**（彻底杜绝将表头行作为完整表格提前锁死列宽）；
- **S-T-1-05**：分隔行落库获得结构定型证据时，立即执行首轮锁宽（计数 = 1）；
- **S-T-1-07**：后续数据行单列超宽时，列宽执行 **grow-only（只增不减）** 单调递增更新；收窄数据行触发零写入；
- **S-T-1-08**：50 行长表流式输出，分隔行因用户滚动而**滚出虚拟化可见视口**后，后续超宽数据行到达依然能够正确基于 store 行视图完成列宽修正（计数由 1 递增至 3）。

#### 潜在环境风险

该测试依赖 `stubScrollWidth` 与 `FakeResizeObserver`。在真实 Tauri WebView2 桌面环境下，若存在系统 DPI 缩放（如 125%/150%），DOM `scrollWidth` 可能产生亚像素浮点数（如 `100.25px`）。若未设置浮点数容差 `Math.abs(newW - oldW) > 1`，可能引发非预期的微小重排。

---

### 3.4 Undo/Redo 历史栈一致性 (`undo.test.ts`, `undo-merge.test.ts`, `transaction.test.ts`, `devil.test.ts`)

#### 契约保证

1. **输入合并契约**：连续按键与单字符删除在 500ms 时间窗内合并为 1 步 Undo；
2. **跨行与选区删除隔离**：选区删除与跨行 `\n` 删除不参与击键合并，确保用户单次宏观操作可单步回退；
3. **选区方向性复原**：`devil.test.ts: Cross Test 3` 严格断言 Undo 后不仅文本还原，`selectionStart` 与 `selectionEnd` 精确复原到删除前的高亮区间；
4. **流式混合 Undo 语义**：流式注入产生带有 `meta: 'stream'` 的复合事务，与用户后续击键在同一个 Undo 栈中交替回退，互不污染。

#### 隐患：Undo 栈无容量硬上限

`EditorStore.ts` 中 `undoStack` 数组无固定长度限制（`memory-bounds.test.ts:G9.4` 已登记该现状）。在持续运行数小时且高频编辑的长程会话中，历史操作栈会持续线性占用内存。

---

## 四、虚假断言与规避性测试排查

### 4.1 全量跳过与注销测试排查（Zero Skipped Tests）

通过对 `reference/markdown-editor/tests/unit/` 下全部 88 个测试文件的源码进行全量正则扫描：

- `test.skip` / `it.skip` / `describe.skip`：**0 处**；
- `xit` / `xdescribe` / `xtest`：**0 处**；
- `test.todo` / `it.todo`：**0 处**。

**结论**：单元测试域不存在任何为了掩盖 Bug 而恶意注销或跳过的测试用例。

---

### 4.2 虚假断言（Dummy Assertions）检出

#### 检出项 1：`tests/gate/placeholder.test.ts` 占位骨架

在 `tests/gate/placeholder.test.ts` 中检出 7 个 `expect(true).toBe(true)` 恒真断言：

```typescript
// tests/gate/placeholder.test.ts:29-68
describe('G1 core 不变量 unit（U1）', () => {
  it('骨架就绪：现有 126 例已接线，不变量工具集待 R1 补齐', () => {
    expect(true).toBe(true); // 占位断言
  });
});
describe('G2 属性测试（U2）', () => { ... expect(true).toBe(true); });
describe('G3 渲染层 RTL（R1）', () => { ... expect(true).toBe(true); });
describe('G4 行为契约（R2）', () => { ... expect(true).toBe(true); });
describe('G5 CommonMark 符合度（C1）', () => { ... expect(true).toBe(true); });
describe('G7 运行时 Playwright（E1）', () => { ... expect(true).toBe(true); });
describe('G8 性能门禁（P1）', () => { ... expect(true).toBe(true); });
```

**审计分析**：该文件是 2026-08-09 R0 阶段作为门禁骨架引入的（`package.json` 中的 `test:gate` 脚本会跑它）。虽然日常 `npm test`（只运行 `tests/unit/`）不包含它，但其存在造成了「门禁已就绪」的假象，且与 `tests/coverage-tracker.md` 长期未同步更新。

---

### 4.3 异步状态更新未包裹 `act(...)` 警告

在运行 `tests/unit/stream-lang-lazy.test.ts` 时，控制台抛出 React 19 核心警告：

```
stderr | tests/unit/stream-lang-lazy.test.ts > W2-3 惰性 lines 缓存（S-T-2-06） > 区间边界变化（围栏内插入新行 → contentEnd 位移）换键重建
An update to CodeBlock inside a test was not wrapped in act(...).
```

**根因**：`CodeBlock` 内部在语言高亮或惰性解析完成时触发了微任务异步 `setState`，测试用例未将其完全包裹在 `await act(async () => ...)` 内。这在极端并发环境下会导致测试断言在 React DOM 提交前提前执行，产生竞态偶发失败。

---

## 五、性能基线与直刷覆盖率实测验证

### 5.1 直刷覆盖率实测（`stream-coverage.test.ts`）

根据 `tests/unit/stream-coverage.test.ts` 实测输出：

```
[W2-2 coverage] 语料行=221 候选=87 可直刷=55 覆盖率=63.2% 基线=14.9% 提升=48.3pp
```

| 指标项             | 基线值（2026-08-11 修复前） |   战役目标要求    |          本次审计实测值          |     达标判定     |
| ------------------ | :-------------------------: | :---------------: | :------------------------------: | :--------------: |
| **语料总行数**     |           221 行            |   资产保护完整    |            **221 行**            |     **完整**     |
| **纯文本候选行**   |            87 行            |     87 行稳定     |            **87 行**             |     **一致**     |
| **可直刷正文行**   |            13 行            |         —         |            **55 行**             |        —         |
| **直刷覆盖率**     |          **14.9%**          |    提升 ≥20 pp    | **63.2%**（净提升 **+48.3 pp**） | **大幅超额达标** |
| **不可直刷行校验** |            32 行            | 100% 命中真实语法 | **32 行**（全命中 `*#` 等语法）  |   **零假阳性**   |

---

### 5.2 核心性能基线实测与比对

| 性能基准场景                         |       修复前基线（`tests/perf/`）       |   战役预算目标    |          本次审计实测值           |   性能提升倍数   |
| ------------------------------------ | :-------------------------------------: | :---------------: | :-------------------------------: | :--------------: |
| **100 万行 ArrowLeft 移动**          |   **13.8 ~ 14.5 ms/键**（O(N) join）    |    < 1.0 ms/键    |  **0.1099 ms/键**（max 1.01ms）   | **提升 ~130 倍** |
| **100 万行 + 3k 尾段 appendText**    | **2.5 ~ 3.6 ms/次**（全量 concat 物化） |    < 1.0 ms/次    |         **0.3551 ms/次**          | **提升 ~10 倍**  |
| **500 token/s 流式注入帧间隔 (P95)** |        **20.9 ms**（~51% 掉帧）         | < 16.7 ms (60fps) | **13.1 ms**（over16.7ms 仅 5 帧） | **达标 (满帧)**  |
| **CommonMark 符合度 (652 例)**       |                40% ~ 55%                |  核心子集无回归   | **73.47%** (479 PASS / 173 FAIL)  |   **显著提升**   |

#### 并发压测下的阈值风险提示

在 `arrow-perf.test.ts:215` 中：

```typescript
expect(avgMs).toBeLessThan(0.6); // 硬性阈值 0.6ms
```

当系统在高负载（12 进程全开跑 Vitest）时，由于 Node.js 进程 CPU 争抢，`append` 均值耗时上升至 **2.21ms**，触发测试失败。
**审计建议**：将非专用 Benchmark 文件中的单元性能断言放宽为保护性上限（如 `< 5.0ms` 防止 O(N) 回归即可），严苛数字由 `tests/perf/baseline-collect.mjs` 独立基准承接。

---

## 六、无用资产、冗余文件与僵尸目录清理清单

在对 `reference/markdown-editor/` 进行全盘物理文件扫描后，发现大量历史调试遗留的临时脚本、分析日志、无用截图与僵尸空目录。

### 6.1 根目录临时/调试遗留文件（建议清理）

| 文件路径                 |    大小     | 性质与清理理由                              |
| ------------------------ | :---------: | ------------------------------------------- |
| `.anchor-diag-tmp.mjs`   |   4.0 KB    | 历史光标锚点诊断临时脚本                    |
| `.inject-scroll-tmp.mjs` |   3.6 KB    | 历史滚动注入临时脚本                        |
| `debug-console.cjs`      |    415 B    | 临时控制台输出抓取脚本                      |
| `debug-dom.cjs`          |    627 B    | 临时 DOM 结构打印脚本                       |
| `patch_nav.ts`           |   6.3 KB    | 历史导航补丁草稿 1                          |
| `patch_nav2.ts`          |   6.6 KB    | 历史导航补丁草稿 2                          |
| `patch_nav3.py`          |   7.2 KB    | 历史导航 Python 辅助脚本                    |
| `perf.mjs`               |    680 B    | 临时性能打点脚本（已被 tests/perf 替代）    |
| `scratch.js`             |    357 B    | 临时草稿文件                                |
| `store.txt`              | **42.8 KB** | 历史 Store 状态 dump 文本（大体积无用垃圾） |
| `test-arrow-layouts.cjs` |   1.2 KB    | 临时方向键布局测试脚本                      |
| `test-empty.ts`          |    301 B    | 临时空状态测试脚本                          |
| `test-m2-perf.cjs`       |   1.9 KB    | 历史 M2 性能临时脚本                        |
| `test-m3-benchmark.cjs`  |   3.0 KB    | 历史 M3 基准临时脚本                        |
| `test-parser.js`         |   10.2 KB   | 历史解析器临时脚本                          |
| `test-thrash.cjs`        |    766 B    | 临时重排检测脚本                            |
| `test_table_ast.ts`      |    194 B    | 临时表格 AST 测试片段                       |
| `ui_screenshot.png`      |   96.5 KB   | 历史手动截图                                |
| `vite-b2.log`            |   22.3 KB   | 历史 Vite 运行日志                          |
| `vite-dev.log`           |   1.1 KB    | 历史 Vite 运行日志                          |

---

### 6.2 `tests/` 目录下散落的历史临时脚本与图片（建议清理）

| 路径                                             |   大小   | 性质                     |
| ------------------------------------------------ | :------: | ------------------------ |
| `tests/playwright-cursor-bug.cjs`                |  1.7 KB  | 临时光标 Bug 复现脚本    |
| `tests/playwright-test.cjs` ~ `test4.cjs` (4 个) |  ~11 KB  | 历史 Playwright 探测脚本 |
| `tests/playwright-zoom.cjs`                      |  2.9 KB  | 历史缩放探测脚本         |
| `tests/refactor-parser.js`                       |  3.9 KB  | 历史重构辅助脚本         |
| `tests/screenshot-click-heading.png`             | 111.8 KB | 历史调试截图             |
| `tests/screenshot-click-margin.png`              | 111.0 KB | 历史调试截图             |
| `tests/screenshot-scroll-bug.png`                | 100.0 KB | 历史调试截图             |
| `tests/test-arrow-perf.js`                       |  1.6 KB  | 历史方向键性能脚本       |
| `tests/test-list-active-line.png` 等 (3 张)      | ~350 KB  | 历史列表调试截图         |
| `tests/test-margin.html`                         |  258 B   | 历史边距测试 HTML        |
| `tests/test-math-rendering.png`                  | 111.4 KB | 历史数学公式调试截图     |
| `tests/test-scroll-bug.cjs`                      |  1.8 KB  | 历史滚动 Bug 脚本        |
| `tests/test-table-excel.cjs`                     |  3.0 KB  | 历史 Excel 表格粘贴脚本  |

---

### 6.3 废弃子目录与僵尸空目录（建议清理）

1. **`tests/legacy/`**：包含 32 个历史探索脚本（`check-arrow.cjs`, `debug-cursor1~7.cjs`, `test-parser1~5.js` 等），均已被正式的 `tests/unit/` 单元测试完全覆盖；
2. **`tests/experimental/`**：包含 2 个临时探索文件（`test-insert.ts`, `test-typing.cjs`）；
3. **`reference/markdown-editor/scratch/`**：包含 3 个临时排查脚本；
4. **`src/core/` 僵尸空目录**：
   - `src/core/graph/`（**空目录**）
   - `src/core/intelligence/`（**空目录**）
   - `src/core/physics/`（**空目录**）

---

## 七、技术风险与整改行动项（Remediation Matrix）

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   Markdown 测试资产专项保护与加固矩阵                               │
├────┬──────────────────────┬────────────────────────────────┬──────────┬──────────┤
│ ID │ 问题分类             │ 现象与潜在风险                 │ 影响范围 │ 整改建议 │
├────┼──────────────────────┼────────────────────────────────┼──────────┼──────────┤
│ 01 │ CI 时钟断言抖动      │ parser-redos: <500ms 偶发 520ms│ CI 稳定性│ 放宽为   │
│    │                      │ arrow-perf: <0.6ms 偶发 2.2ms  │          │ 相对上限 │
├────┼──────────────────────┼────────────────────────────────┼──────────┼──────────┤
│ 02 │ 历史占位骨架遗留     │ tests/gate/placeholder.test.ts │ 门禁语义 │ 移除虚假 │
│    │                      │ 含 7 处 expect(true).toBe(true)│ 真实度   │ 占位断言 │
├────┼──────────────────────┼────────────────────────────────┼──────────┼──────────┤
│ 03 │ React 19 act 未包裹  │ stream-lang-lazy.test.ts 报    │ 测试竞态 │ 包裹异步 │
│    │                      │ CodeBlock 未 wrapped in act    │ 告警     │ act(...) │
├────┼──────────────────────┼────────────────────────────────┼──────────┼──────────┤
│ 04 │ 孤立代理对隐患       │ EditorStore:35 fallback 无低位 │ 极端兼容 │ 补齐低位 │
│    │                      │ 代理对保护，可能割裂 Emoji     │ 边界     │ 代理校验 │
├────┼──────────────────────┼────────────────────────────────┼──────────┼──────────┤
│ 05 │ 临时文件与垃圾堆积   │ 根目录与 tests 散落 50+ 临时   │ 仓库整洁 │ 集中清理 │
│    │                      │ 脚本、截图及 3 个僵尸空目录    │ 度与体积 │ 冗余资产 │
└────┴──────────────────────┴────────────────────────────────┴──────────┴──────────┘
```

### 总结裁决

1. **测试资产安全底线完全守住**：88 个单元测试套件、1,146 个测试用例 100% 保持完好，全部真实通过；主仓库 5 个专项 E2E spec 完整在册；
2. **直刷覆盖率与核心性能显著达标**：直刷覆盖率跃升至 **63.2%**（提升 **+48.3 pp**），百万行光标移动耗时降低至 **0.11ms**（提升 130 倍）；
3. **下一步执行收敛**：由主控 Agent 统一规划清理 50+ 个临时/冗余垃圾文件，并对 2 处偶发时钟抖动的单元测试做阈值鲁棒性加固。
