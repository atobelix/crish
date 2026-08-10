# Review：P2 执行方案评审（阶段 4·批次方案）

- 审查对象：`docs/analysis/plan-P2-执行方案.md`（主审，77 行）
- 支撑文档：`review-P1-质量审查.md`（P1 回修 8 项）、`status-P2-现状盘点.md`（15 项）、`status-P3-新需求方向.md`（10 项 + 推荐组合）
- 引擎代码抽查（白箱核验批次任务与真实代码的匹配度）：
  - `src/core/EditorStore.ts`（fence 镜像判定 :793、分块参数 :1496-1560、applyChange :1713、EditorOperation :475-498）
  - `src/core/HeightMap.ts`（insert/delete :417-449、syncTo :392、rebuildIndexes 链）
  - `src/components/MarkdownEngine.tsx`（is-search-line :237、addSearchRange/clearSearch :489-494、virtualizer :345）
  - `src/components/ContextMenu.tsx`（handleAction stub :41-47）
  - `src/core/measure.ts`（:886-889 仍读 `store.lines`）
  - `src/core/parser.ts`（fence 完整关闭条件 :631-712）
  - `tests/commonmark/astToHtml.ts`（近似投影器，仅依赖 src/core/ast 类型）
  - `tests/unit/cross-matrix.test.ts`（KNOWN-DEFECT 登记分支 :160-243）
  - `tests/gate/placeholder.test.ts`（G6/G9/G10 占位仍在 :49-77）
- 审查方式：纯只读静态审查，未改动任何源码，不 commit
- 审查日期：2026-08-10
- 审查人：总调度派发的评审 Agent（阶段 4）

---

## 总体结论：**需修订**（1 阻断 + 3 一般 + 5 轻微；均为编排/声明层问题，无架构级否决项）

批次划分整体扎实：覆盖度高、依赖方向正确、绝大多数文件域冲突已被轮次消解，技术可行性经白箱抽查成立。需修订集中于四点：

1. **【阻断】轮 2 的 B2 与 B3 同轮并发修改 `MarkdownEngine.tsx`**——文件域冲突未消解（见维度 2）。
2. **【一般】批次覆盖有 4 个显式缺口未声明**：status-P2 项 8（拖放文件）、status-P3 的 N1（消息级渲染增强）、N7（实例池化）、N9（readOnly 复制为 Markdown）未进任何批次，且 plan 无「范围声明」说明取舍（见维度 1）。
3. **【一般】B4 的「与 N1 权威渲染语义单源」声明失准**：astToHtml 是 CommonMark 近似投影器（有登记偏差点 + 扩展语法占位标签 + 无 KaTeX），与 BlockRenderer 交互渲染语义本就是两个实现；「单源」表述会掩盖有意设计的语义差（见维度 4）。
4. **【一般】B1 的 fence 镜像修复与 B8 的 parser 章节提升存在语义漂移风险**：镜像判定的「完整关闭条件」若只是按 parser 现状复制一份，B8 后续改 parser 时两套状态机将再次分歧——KNOWN-DEFECT 的架构根源未根治（见维度 4）。

---

## 维度 1：批次完整性

### 1.1 review-P1 回修 8 项覆盖核对

| review-P1 回修项 | 计划落点 | 覆盖 | 备注 |
|---|---|---|---|
| 1. measure.ts:886-889 视口外导航读物化数组 | B1 | ✓ | 白箱确认 :886-889 仍读 `store.lines.length` / `store.lines[targetIdx]`，未修复状态与计划一致 |
| 2. 双段合并语义 7 处去重 | B1（「7 处去重」） | ✓ | |
| 3. dispatchSet 死分支（:2463-2467） | B1 | ✓ | |
| 4. :1374 注释措辞（Object.create vs setPrototypeOf） | B7「A1 回修剩余（注释/测试增强）」 | △ | 仅隐含，建议 B7 任务书明确列全 |
| 5. 1a/1b 同源对照补 CRLF 手工用例 | B7（隐含） | △ | 同上 |
| 6. 2b 测试构造补 streamTailCodeState | B7（隐含） | △ | 同上 |
| 7. 订阅同步窗口注释登记 | B7（隐含） | △ | 同上 |
| 8. Up/Down 垂直导航全文 getText 登记 | 未提 | △ | 回修 8 原文即「列入后续优化方向」，不强制；建议在 plan 范围声明中登记一句 |

**结论**：8 项无遗漏，其中 4 项靠 B7 的「剩余」表述兜底。B7 任务书应显式列举 4/5/6/7 四项，否则存在被「剩余」二字吞掉的风险。

### 1.2 status-P2 待做 15 项覆盖核对

| # | 项 | 计划落点 | 覆盖 |
|---|---|---|---|
| 1 | 分块 TTI 基准 + 参数化 | B1 | ✓ |
| 2 | 增量 fence 镜像 | B1 | ✓ |
| 3 | CommonMark 六章节 | B8 | ✓ |
| 4 | PageUp/PageDown/Ctrl+Home/End | B1 | ✓ |
| 5 | 查找/替换 | B2 | ✓ |
| 6 | 词级跳选 | B2 | ✓ |
| 7 | 自动补全 | B5 | ✓ |
| 8 | **拖放文件** | **无** | **✗ 缺失** |
| 9 | 表格菜单接线 | B5 | ✓ |
| 10 | bidi 接线 | B5 | ✓ |
| 11 | CRDT 位置级 op | B6 | ✓ |
| 12 | 大纲索引 | B3 | ✓ |
| 13 | 折叠区间 | B3 | ✓ |
| 14 | 导出 HTML | B4 | ✓ |
| 15 | 占位清理 | B7 | ✓ |

- **项 8（拖放文件）缺失**：status-P2 建议「与宿主文件打开流程一起排期」，0.5-1d 工作量不大；若本轮有意排除（留给宿主侧接线），必须在 plan 增加范围声明，否则盘点→方案的追踪链断裂。
- 项 3 的「与项 2 联动」建议（fence 章节攻坚与镜像修复联动）在 plan 中未体现，见维度 4 的修订建议。

### 1.3 status-P3 推荐组合覆盖核对

| P3 组合 | 项 | 计划落点 | 覆盖 |
|---|---|---|---|
| P0 对话流即时底座 | N1 消息级渲染增强 | **无** | **✗ 未覆盖** |
| P0 | N9 readOnly 复制为 Markdown | **无** | **✗ 未覆盖** |
| P0 | N10 metrics 扩展 | B6（__CRISH_METRICS__ core 化 + 修 getLineCount 物化） | ✓ |
| P1 阅读与定位 | N2 大纲 / N6 搜索 / N3 折叠 | B3 / B2 / B3 | ✓ |
| P2 工具产物与出口 | N4 lang 分发 / N5 导出复制 | B4 | ✓ |
| P3 工作区与协作 | N7 实例池化 | **无** | **✗ 未覆盖** |
| P3 | N8 协作 op | B6 | ✓ |

- plan 目标节第 11 行「新增（宿主对话流主线）：大纲/折叠/导出复制/工具产物渲染」明确只选了 P1+P2 批 + N8/N10 的引擎侧部分，**未选 P0 的 N1/N9 与 P3 的 N7**。
- 这个取舍本身可接受（N1/N9 是宿主接线面、N7 是宿主工作区形态的结构性前置，均非纯引擎能力项），但 **plan 没有任何文字声明此取舍及理由**。P3 明确推荐 P0 为「第一批、宿主体感第一触点」，跳过 N1/N9 意味着宿主侧 AsyncMarkdownBlock 接线（23 方案 E2 域）本轮没有引擎配合面——建议至少登记「N1/N9/N7 不进入本轮，宿主接线时另行派单」。
- **重复/重叠检查**：B6 与 status-P3 N8 同源、B4 与 N4/N5 同源、B3 与 N2/N3 同源——均为同一需求在盘点与方案间的映射，无批次内重复实施。批次间无重复项。

**维度 1 结论**：B1-B8 覆盖 review-P1 全 8 项（4 项隐含）、status-P2 14/15（缺拖放）、status-P3 7/10（缺 N1/N7/N9，N10 部分覆盖）。**无重复**；**4 个缺口均为有意取舍但未声明**——建议在 plan 增加「范围声明」节。

---

## 维度 2：文件域冲突（轮次编排核验）

### 2.1 【阻断】轮 2：B2 与 B3 同轮并发修改 `MarkdownEngine.tsx`

- B2 落点含 MarkdownEngine（is-search-line 已存在 :237、addSearchRange/clearSearch :489-494 已存在——B2 需在组件内加搜索 UI 接线、跳转封装、命中计数刷新 effect）；
- B3 落点含 MarkdownEngine（大纲跳转接线、fold 渲染、折叠占位行注册）。
- 两批在**同一文件**上叠加：组件 props 扩展、effect 链、virtualizer 消费（:345、:541-636）都会交叉。子 Agent 粒度下无法按文件内区域安全划界（搜索 effect 与 fold 渲染都动同一装饰/渲染管线）。
- **轮 2 编排（B2+B3+B4 并行）未消解此冲突**——这是本轮方案唯一的文件域硬伤。

**修订建议（采纳）**：将 B3 移入轮 3（轮 3 = B3+B5+B6+B8b）。核验移轮后的域互斥：
- B3（MarkdownEngine + HeightMap + 新 HeadingIndex）vs B5（BlockRenderer/InlineRenderer + ContextMenu + HiddenInput）——无交集 ✓；
- B3 vs B6（EditorStore + 新 metrics 模块）——无交集 ✓；B3 vs B8b（astToHtml）——无交集 ✓；轮 3 共 4 Agent ≤ 12 ✓。
- 依赖约束「B3 → B6（折叠占位行高与 op 日志交互验证）」在轮 3 内保持 B3 先于 B6 或轮间验证 ✓（依赖节已声明）。

### 2.2 其余同文件风险均已由轮次消解（核验通过）

| 文件对 | 批次 | 编排 | 状态 |
|---|---|---|---|
| BlockRenderer.tsx | B4（轮 2）vs B5（轮 3） | 分轮串行 | ✓ 已消解 |
| EditorStore.ts | B1（轮 1）vs B6（轮 3） | 分轮串行 | ✓ 已消解 |
| HiddenInput.tsx | B1（轮 1，键盘）vs B2（轮 2，wordBoundary） | 分轮串行 | ✓ 已消解 |
| astToHtml.ts（移动后 src/core/astToHtml.ts） | B4（轮 2，移动）vs B8b（轮 3，投影器章节） | 分轮串行 | ✓ 已消解，但见维度 4 的「移动后契约」提示 |
| parser.ts | B8a（轮 1）vs B8b（轮 3） | 同批不同章，轮 3 与轮 1 分轮 | ✓（B8a/B8b 均为 B8 内分工，轮 1/轮 3 分轮无并发） |
| tests/ | B7（轮 1）与其余各批新增测试 | B7 只删不写新断言之外的东西；新增单测随各自批次入库 | ✓ 轻微注意：B7 删除占位后各批新增测试不受影响 |

**维度 2 结论**：唯一未消解冲突 = 轮 2 B2 vs B3（MarkdownEngine.tsx）。B4/B5 的 BlockRenderer 共享已被轮次串行化（plan §1 中「B4/B5 独立并行」的表述与 §3 执行布局一致，实际分轮，无冲突）。

---

## 维度 3：技术可行性（白箱核验）

### 3.1 B3 折叠的行高联动（HeightMap 现状）

**证据**：`HeightMap.ts:417-449` insert/delete 已完整实现（块内 splice + 块满 splitBlock + rebuildIndexes），注释明示「滚动管线批在编辑定位信息接入后使用」——与 status-P2 项 13 的「已实现未接线」判断一致。**支撑成立**。

**但存在两个方案缺口**：

1. **折叠后行号语义的架构决策缺失**（plan 未写）：
   - 方案 A：占位行进入 HeightMap 成为独立槽位（折叠区间行从 HeightMap 删除）——virtualizer count 语义自然，但 HeightMap 行号 ≠ 文档行号，HeadingIndex/搜索/DecorationSet 等一切按原行号工作的设施需要「原行号 ↔ 渲染行号」映射层。
   - 方案 B：折叠行保留在 HeightMap（高度置 0 或占位高），渲染层跳过 virtualItems——对既有设施零破坏，但 virtualizer 的 item 遍历与 estimateSize 需过滤逻辑，且展开时无结构变更（更稳）。
   - **plan 未选型**。这是 B3 任务书必须先裁决的设计点，建议默认方案 B（保留行 + 渲染跳过）起步，理由：与现有 syncTo 尾部对齐链路兼容、零行号漂移、折叠/展开不触发 HeightMap 结构变更。
2. **批量展开性能**：insert/delete 每调用一次 `rebuildIndexes()`（O(块数)，:437、:448），单行级 API 面向离散编辑。折叠一批 1000 行展开 = 1000 次 insert × O(块数)，1M 行文档下约几十万级块累计操作，一次性展开尚可接受（毫秒级），但建议 B3 提供批量路径（如 `applyHeightBatch(ops)` 或展开走重建式），避免测量回环中反复触发。

**结论**：行高联动**可行**（insert/delete 齐备），但 plan 缺「折叠行号架构选型」与「批量路径」两个实施决策——需补进 B3 任务书，否则执行 Agent 会现场自行裁决。

### 3.2 B2 搜索分批的帧预算

**证据**：requestIdleCallback 分批先例成立（`EditorStore.ts:1546-1560` setText 分块加载，含代际竞态保护 currentLoadGeneration）；RL-05 #10 禁 worker 与 status-P3 N6 一致；DecorationSet search 种类 + addSearchRange/clearSearch 已就绪（MarkdownEngine.tsx:489-494）；替换走 applyChange 事务入口（EditorStore.ts:1713）成立。

**缺口**：帧预算**未量化**。计划只有「主线程不卡帧」的定性红线，无参数（每批行数 / 空闲预算 ms / 超时兜底）。行级扫描成本低（1M 行约百万字符级 substring + 前缀比较），分批粒度拍脑袋即可，但**验收无法量化**（见维度 5）。建议参考 arrow-perf 的阈值护栏模式：断言「1M 行搜索首帧不阻塞（无 >50ms 长任务）」或「总耗时 < X ms」+ 分批参数常量命名。

### 3.3 B6 op 位置级字段对 undo/redo 的兼容性

**证据**：EditorOperation 现有行级字段（:475-498）；applyChange 为唯一写事务入口（:1713-1844，planChange 统一规划），undo 栈记录事务快照。**「只增不改」（新增 from/to/insert/removedText 位置级字段、保留旧字段）对 undo/redo 兼容成立**——旧分支不读新字段，undo 语义零变化；风险面集中在流式合并记账（R3-A meta:'stream'）与 336 门禁，plan 已声明「undo/redo 兼容层验证」✓。

**结论**：可行，风险集中在 plan 已识别的两处；建议补充「变更日志 append-only 与流式 op 记账联动」的专项测试用例到 B6 验收（现有 336 门禁覆盖 undo/redo，但变更日志本身无既有测试基座）。

**维度 3 结论**：三项技术判断全部成立，且 plan 已正确标注 B3 为最大难点。需补：B3 行号架构选型、B2 帧预算参数、B6 变更日志专项测试。

---

## 维度 4：风险（B8 vs B1、B4 投影器关系）

### 4.1 B8 与 B1 的 parser/投影器改动冲突

**文件域**：B1 改 EditorStore.ts（增量判定），B8 改 parser.ts + astToHtml.ts——文件不冲突，轮 1 并行安全（B8a 是 Block quotes 章节，不动 fence 判定）。**✓ 编排无冲突**。

**但语义域存在漂移风险（一般项）**：
- B1 的修复路径是「增量判定携带 fenceState{marker,length} 镜像 parser 完整关闭条件」（status-P2 项 2：parser.ts:701-720 同字符 + run 长度 ≥ 开栏 + 无 info 串）。
- B8 的 Fenced code 章节（52% → 提升）必然改动 parser 的关闭条件或周边语义。若 B1 只是「把 parser 现状复制进 EditorStore 判定」，B8 后续改 parser 时**两套状态机再次分歧**——KNOWN-DEFECT 的架构根源（两处独立实现）并未根治，只是本轮对齐。
- **修订建议**：B1 修复时把「fence 关闭判定」抽为 parser 共享导出（如 `parser.ts` 导出 `isFenceClose(line, fenceState)`），EditorStore 增量镜像与 parser 均调用同一函数——**单源化**根治架构断层（符合 AGENTS.md「严禁补丁」原则，这正是该缺陷的架构级解法而非一行对齐）。B8 任务书同步声明「改 fence 语义必须复用该导出，禁止另写条件」。

### 4.2 B4 renderToHTML 提取与 tests/commonmark/astToHtml 的关系

**证据**：
- `tests/commonmark/astToHtml.ts`（792 行）是 **CommonMark 近似投影器**：头部契约（:4-19）明确「零语义修复——不补语法、不改语义」；扩展语法（math/mark/spoiler）投影为占位标签（计 FAIL）；无 KaTeX 依赖（import 仅 src/core/ast 类型 :20-24，白箱确认无测试专用依赖）→ **移入 src 无依赖障碍，0.5d 量级成立** ✓。
- BlockRenderer 是交互式 React 渲染（KaTeX/表格/软渲染分支），与 astToHtml **本就是两个实现**，语义差是有意设计（CommonMark 符合度口径）。

**问题**：
1. **「与 N1 权威渲染语义单源」表述失准**：N1 的权威渲染 = BlockRenderer（完成态软→硬收敛），astToHtml ≠ BlockRenderer。若按 plan 字面理解「单源」，执行 Agent 可能去改 BlockRenderer 以对齐 astToHtml，反而破坏交互渲染。**应修正表述**为：astToHtml 是「导出/序列化」的单一源头（其语义已被 652 例 CommonMark 测试锁定），与交互渲染的语义差异为有意设计，二者不追求合并。
2. **导出品质目标未定义**：astToHtml 无 KaTeX/表格样式内联，直接作为「会话归档导出」的 HTML 输出，math/表格呈现会退化（占位 span vs 渲染态）。status-P3 N5 声称 renderToHTML「复用 KaTeX/表格渲染语义」——与 astToHtml 现状矛盾。**需 B4 明确**：导出 HTML 是（a）CommonMark 近似投影（无 KaTeX，接受降级）还是（b）补 KaTeX/表格内联样式（扩 astToHtml 或新写导出投影）。建议（a）先落地、把（b）列为后续，避免一轮同时动投影器两个语义面。

**维度 4 结论**：无文件域冲突；需修订两处声明/决策——fence 关闭条件单源化（B1 任务书）、B4「单源」表述修正 + 导出品质目标选型。

---

## 维度 5：验收可测性

| 批次 | plan 验收 | 可测性评估 |
|---|---|---|
| B1 | tsc 0 + test:gate 全绿 + TTI 基准测试 | ✓ 可量化（TTI 基准要落地为门禁测试而非口头指标——计划写「TTI 基准测试」✓）；键盘增强建议补键位行为断言（模拟 keydown） |
| B2 | 搜索/跳转/替换/计数「可用」 | △ **偏软**：建议补「1M 行搜索分批不卡帧」性能护栏（arrow-perf 同款阈值模式）+ 命中/计数/跳转单测 |
| B3 | 大纲跳转 + 折叠「生效」 | △ **偏软**：建议补「折叠/展开后行高一致性与滚动位置断言」（verifyConsistency 同款收敛断言，即 HeightMap insert/delete 接线的白箱验证）、占位行渲染金样 |
| B4 | （未单列） | △ 建议补：renderToHTML 输出与 tests/commonmark 语义锁定对照（防移动后漂移）、复制按钮/公式复制单测 |
| B5 | （未单列） | △ bidi：dir="rtl" 渲染断言（bidi.test.ts 已有基础）；菜单接线：TableOperations 调用断言（status-P2 项 9 已提示补接线断言） |
| B6 | undo/redo 兼容层验证（336 门禁） | ✓ 可量化；建议补变更日志 append-only 专项 |
| B7 | test:gate 全绿 | ✓ 可量化（占位 10 → 7，coverage-tracker 勾选）；注意删除后 gate 数量断言若存在需同步 |
| B8 | 63.65% → 70%+，核心子集量化 | ✓ 可量化；建议把六章节目标拆为每章节通过率增量（章节级验收，防「总量达标、单章半途」） |

**结论**：B8/B1/B7 可量化；**B2/B3/B5 的验收停留在功能语（可用/生效），缺性能与一致性护栏**——建议每批验收模板统一为「tsc 0 + test:gate 全绿 + 本批新增断言清单 + 性能护栏（如有）+ 白箱一致性断言」。

---

## 维度 6：补充建议（有价值的增补项）

1. **plan 增加「范围声明」节**（采纳，与维度 1 呼应）：显式列出本轮排除项——拖放文件（status-P2 项 8，留宿主排期）、N1/N9（宿主对话流接线面）、N7（实例池化）；review-P1 回修 8（Up/Down 优化方向登记）。防止盘点→方案→执行追踪链断裂。
2. **fence 关闭条件单源化**（采纳，维度 4.1）：B1 任务书强制「关闭判定抽 parser 共享导出」，B8 任务书强制「改 fence 语义必须复用该导出」——根治 KNOWN-DEFECT 架构根源，也是本轮投入产出比最高的架构收口。
3. **B3 任务书补充两个实施决策**（采纳，维度 3.1）：折叠行号架构选型（建议方案 B：保留行 + 渲染层跳过，零行号漂移）+ 批量折叠/展开路径。
4. **B7 任务书显式列全回修 4/5/6/7 项**（采纳，维度 1.1）：注释措辞、CRLF 对照用例、2b 测试构造、订阅窗口登记——不依赖「剩余」二字兜底。
5. **导出 HTML 品质目标选型**（采纳，维度 4.2）：B4 明确先落地 CommonMark 近似投影导出（含降级说明），KaTeX/表格内联样式列为后续。
6. **B8 章节级验收拆分**（采纳，维度 5）：六章节各自量化增量目标，与 70% 总量并行验收；Fenced code 章节排期与 B1 的 fence 单源化联动（status-P2 项 3 已提示，plan 未体现）。
7. **可拒绝项**：B2 增加 worker 路线（RL-05 #10 禁令，status-P3 已确认不走 worker）——plan 未提，无需增补。

---

## 修订建议清单（供调度裁决）

| # | 项 | 类型 | 内容 | 影响面 |
|---|---|---|---|---|
| R1 | 轮 2 B2/B3 同文件冲突 | **阻断** | B3 移入轮 3（轮 3 = B3+B5+B6+B8b，4 Agent，域互斥核验通过）；或轮 2 内 B2→B3 串行声明 | 执行布局 §3 |
| R2 | 覆盖缺口声明 | 一般 | plan 增「范围声明」节：拖放/N1/N9/N7 排除理由 + 回修 8 登记 | plan §0/§1 |
| R3 | fence 关闭条件单源化 | 一般 | B1 抽 parser 共享导出（isFenceClose），B8 复用；删除 cross-matrix 登记分支的验收条件同步 | B1/B8 任务书 |
| R4 | B4「单源」表述修正 | 一般 | astToHtml = 导出/序列化单一源头，与交互渲染语义差为有意设计；导出品质目标选型（先近似投影） | B4 任务书 |
| R5 | B3 任务书补架构决策 | 修改 | 折叠行号选型（建议保留行+渲染跳过）+ 批量路径；可测性补行高一致性断言 | B3 任务书 |
| R6 | B2 帧预算量化 | 修改 | 分批参数命名 + 「1M 行搜索无 >50ms 长任务」性能护栏 | B2 任务书 |
| R7 | B7 回修项显式列全 | 修改 | 4/5/6/7 项逐一进任务书 | B7 任务书 |
| R8 | B8 章节级验收拆分 | 修改 | 六章节各自增量目标 + 与 B1 fence 单源化联动声明 | B8 任务书 |
| R9 | 验收模板统一 | 采纳 | 每批 = tsc + gate + 新增断言清单 + 性能护栏 + 一致性断言 | plan §4 |
| R10 | 工作区/会话描述细节 | 采纳 | scrollToIndex 表述修正为「tanstack virtualizer 自带、当前未封装命令式调用点」 | plan §1 B2/B3 |

---

## 结论

**需修订**。方案主体（批次划分、依赖方向、技术可行性、风险识别）质量良好：B1-B8 覆盖盘点 14/15 与 P3 组合 7/10 且无重复，HeightMap.insert/delete 白箱确认支撑 B3 折叠、applyChange 单入口支撑 B6 op 扩展、requestIdleCallback 分批先例支撑 B2 搜索。修订点均为**编排与声明层**（1 阻断：轮 2 同文件并发；3 一般：范围声明缺失、B4 单源表述、fence 单源化；5 轻微：验收量化与任务书细节），无架构级否决项。**修订后即可按批次派发执行**。
