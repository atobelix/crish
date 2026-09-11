# 07-方案收敛审计与 SSOT 裁决

> **战役工作区**：`docs/assistant-process-folding/`
> **文档性质**：本战役**唯一裁决总表**（SSOT Registry）+ 收敛审计记录
> **生效日期**：2026-09-11
> **权威性**：本文件与 01–06 冲突时，**以本文件为准**；本文件与真实代码冲突时，**以代码事实为准并立即修订本文件**。

---

## 一、审计背景与裁决方法

### 1.1 审计触发

2026-09-11 对 `docs/assistant-process-folding/` 全 6 份分维详案（00–06）执行端到端审计，**逐条对照真实源码**核验。审计范围：

- 契约类型定义（字段名、类型、枚举值）
- 文件路径与模块归属
- 图标体系（图标库、图标名、用法）
- Design Tokens 与裸 Hex
- React Hooks 规则遵守
- 跨层调用链真实性（是否功能伪连通）
- 门禁命令完整性
- 负向断言覆盖度

### 1.2 裁决原则（用户给定红线）

| 编号 | 红线 | 本战役落地方式 |
| --- | --- | --- |
| R1 | 严禁功能伪连通 | 所有新增样式类/函数必须在真实宿主调用链中生效；零引用即删除 |
| R2 | 严禁多轨并存、给旧岛续命 | 单一概念收敛至唯一 SSOT；物理切除旧轨；**禁止兼容 Shim 与 `@deprecated` 转发壳** |
| R3 | 严禁幽灵契约与截肢式降级 | 跨层契约与主注册表 1:1；禁止破坏性容错回退；禁止 catch 静默吞咽 |
| R4 | 严禁虚构 Token 与样式欺骗 | 100% 遵从 Design Tokens；禁止裸 Hex 与 `var(--x, #hex)` 伪默认值；穿透检查盒模型与 Stacking Context |
| — | 交付判据 | 五端物证齐备（触发/传输/介质/消费/负向断言）+ 四层门禁全绿 |

---

## 二、SSOT 裁决总表（唯一权威源登记）

### 2.1 契约类型

| 概念 | **唯一权威路径** | 权威定义位置 | 已废除的别名/重复源 |
| --- | --- | --- | --- |
| `ProcessSegmentMetrics` | `apps/crish-desktop/src/api/tool-presentation/toolPresentationTypes.ts` | **01 详案 §1** | `ProcessSectionMetrics`（04 原稿）、4 份文档内的 8 处重复定义 |
| `TimelineSegment` | 同上 | **01 详案 §1** | 04 原稿 §4.1 的本地定义 |
| `ProcessLeadAction` | 同上 | **01 详案 §1** | `dominantCategory`（02 原稿）、`DominantIconSpec` |
| `DOMINANT_ICON_MAP` | 同上 | **02 详案 §7** | 02 原稿的两份重复 map、`dominantIcon: string` 字段 |
| `FoldableProcessSectionProps` | `apps/crish-desktop/src/components/chat-message/FoldableProcessSection.tsx` | **04 详案 §2.2.3 = 06 详案 §5.1**（两处须字面一致） | 06 原稿的 `sectionKey` / `summaryText` / `leadingIcon` / `children` 变体 |

### 2.2 纯逻辑函数

| 函数 | **唯一权威路径** | 权威实现位置 | 已废除的重复源 |
| --- | --- | --- | --- |
| `partitionTimelineSegments` | `apps/crish-desktop/src/api/tool-presentation/timelineSegmenter.ts` | **01 详案 §3.2** | 04 原稿 §4.2 内联实现（**已物理删除**）、`components/chat-message/` 路径变体 |
| `aggregateProcessMetrics` | `apps/crish-desktop/src/api/tool-presentation/processMetricsEngine.ts` | **01 详案 §2** | 04 原稿的 `aggregateSectionMetrics`、`turnProcessState.countProcessMetrics`（保留但降级为兼容映射） |
| `classifyToolAction` | `apps/crish-desktop/src/api/tool-presentation/toolActionClassifier.ts` | **01 详案 §2.3** | 原稿的子串正则分类器（误分类风险） |
| `formatSegmentSummary` | `apps/crish-desktop/src/api/tool-presentation/processMetricsEngine.ts` | **02 详案 §5** | `formatAggregatedSummaryText`、`formatSummaryLabel`（04 原稿） |
| `arbitrateLeadAction` | 同上 | **02 详案 §6** | `arbitrateDominantCategory` |
| `canonicalizeFsPath` | `apps/crish-desktop/src/api/tool-presentation/processMetricsEngine.ts` | **01 详案 §2** | **新增函数**（全仓原本无实现，非重构） |

### 2.3 图标体系

| 项 | **SSOT** | 说明 |
| --- | --- | --- |
| 图标库 | **`@hugeicons/core-free-icons`** | 唯一来源（用户明确指定） |
| 渲染组件 | `AppIcon`（`components/ui/icons/AppIcon.tsx`） | 唯一渲染入口 |
| 图标名收口 | `components/ui/icons/iconMap.ts` 的 `ICON_NAMES` + `IconName` 联合类型 | 唯一类型源 |
| 线宽契约 | `ICON_STROKE`（同上） | 唯一线宽源 |
| 尺寸吸附 | `snapIconSize` | 24px 网格对齐 |
| 工具 kind → 图标 | `api/tool-presentation/toolCommandIcon.ts` 的 `TOOL_COMMAND_ICONS`（15 轴） | 已存在，复用 |
| 主导动作 → 图标 | `toolPresentationTypes.ts` 的 `DOMINANT_ICON_MAP` | 02 详案 §7 定义 |

**已废除**：
- **全部 emoji 图标**（✏️ / ⚡ / 🔍 / 📄 / 🧠 / 🤖 / 🛠️ / ✅ / 🔄）—— 无法通过 `check:icon-ssot`、跨平台字形不一致、与 `ICON_STROKE` 不兼容；
- **Lucide 图标引用**（03/04 原稿）—— 与 `@hugeicons/core-free-icons` 双轨冲突；
- **`.tsx` 内硬编码图标名字面量**（如 `name="alert-circle"`）—— 必须经 `toolCommandIcon(kind)` 或 `DOMINANT_ICON_MAP[leadAction]` 派生。

### 2.4 Design Tokens

| 项 | **SSOT** | 禁止项 |
| --- | --- | --- |
| 增删差异色 | `--diff-add-fg` / `--diff-del-fg` | **禁止** `var(--color-success, #10b981)` / `var(--color-error, #ef4444)` / 任何裸 Hex |
| 发丝线宽 | `--hairline-width` | **禁止** 字面量 `0.5px` 散落 |
| 焦点环 | 全局 `:focus-visible` 契约（`color-mix` 90/10 上限） | **禁止** 组件级另起 `box-shadow` 软环（双轨） |
| 品牌/强调色 | `--accent-*` 系列 | **禁止** `var(--brand, #hex)` 伪默认值 |

### 2.5 Slot DOM ID

**唯一生成规则**：

```
sectionId = `${msgId}-proc-${index}`           // 由 01 详案的 timelineSegmenter 产出
slotId    = `process-slot-${sectionId}`         // = process-slot-msg-42-proc-0
```

**已废除**：`process-slot-${msgId}-sec-${sectionKey}`（06 原稿）、`process-slot-${msgId}-${sectionId}`（04 原稿）。

### 2.6 门禁命令

**唯一合法门禁集**：

```bash
npm --workspace @crish/crish-desktop run typecheck   # 编译层
npm run check:desktop                                 # 门禁层（15 门）
```

其中本战役刚性守门项：`check:color-ssot` / `check:line-width-ssot` / `check:token-consistency` / `check:icon-ssot` / `check:line-counts`。

**已废除**：`npm run typecheck`（裸命令，未指定 workspace）、`npm test`（未指定项目）、`npm run check:line-counts` 单独执行（遗漏其余 14 门）。

---

## 三、P0/P1/P2 问题清单与处置状态

### 3.1 P0（架构级缺陷，必须修复）

| 编号 | 问题 | 位置 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| P0-1 | **React Hooks 顺序违规**：`:239` 早返回，`:310` 才 `useState`，`:311` 才 `useMemo` | `MessageContent.tsx` / 04 §5.5 | 消灭全部早返回，Hooks 上提至无条件区，早返回改为条件渲染分支 α/β | ✅ 已修订 |
| P0-2 | **原稿静默删除 5 项既有逻辑**（`streamingTextIndex` / `streamTextOffset` 切片 / `inFlowRetry` / `workingSlot` / `streamPhaseRef`） | 04 §5.5 | 逐项保留并平移进分段模型 | ✅ 已修订 |
| P0-3 | **`timelineSegmenter.ts` 路径三源冲突** | 00/01/04 三处 | 收敛至 `api/tool-presentation/timelineSegmenter.ts` | ✅ 已修订 |
| P0-4 | **两个 `partitionTimelineSegments` 实现** | 01 §3.2 vs 04 §4.2 | 04 §4.2 改为 SSOT 重定向，删除本地实现 | ✅ 已修订 |
| P0-5 | **两套 `ProcessSegmentMetrics` 字段命名** | 01 vs 04 vs 02 | 以 01 为权威，04/02 全量对齐 + 旧名对照表 | ✅ 已修订 |

### 3.2 P1（契约冲突与逻辑错误）

| 编号 | 问题 | 位置 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| P1-1 | 两套互斥摘要格式（02 的 `formatSegmentSummary` vs 04 的 `formatSummaryLabel`） | 02 / 04 | 收敛至 02 的 `formatSegmentSummary`，04 改为调用 | ✅ 已修订 |
| P1-2 | 两套互斥主导图标优先级（command 位置相反） | 02 vs 04 | 收敛至 `subagent > edit > search > read > command > thought > mixed` | ✅ 已修订 |
| P1-3 | **`isFoldable={!isLiveTurn}` 杀死铁律二** | 04 §5.5 | 改为透传 `seg.foldable` | ✅ 已修订 |
| P1-4 | 朴素子串分类器误分类（`delete_file` 被 `view` 命中） | 01 §2.3 | 改为两阶段注册表分类器（`EXACT_ACTION_TABLE` + `FALLBACK_RULES`） | ✅ 已修订 |
| P1-5 | **三套不兼容的 `FoldableProcessSectionProps`**（`sectionKey`/`sectionId`；`summaryText`/派生；`children`/`renderItem`） | 04 §2.2.3 / 06 §5.1 | 收敛至 `sectionId` + 容器内派生 + `renderItem` | ✅ 已修订 |
| P1-6 | 三套 `slotId` 规则 | 04 / 06 | 收敛至 `process-slot-${sectionId}` | ✅ 已修订 |
| P1-7 | 兼容映射数学错误（`toolCount = editFilesCount + searchCount + readFilesCount + commandCount`） | 02 §9.1 | 改为 `toolCount: m.toolCount`，注明 `subagentCount ⊆ toolCount` | ✅ 已修订 |
| P1-8 | 门禁命令不完整（遗漏 4 项 SSOT 门禁） | 00 §五 / 01 / 03 | 全量补 `npm run check:desktop`（15 门） | ✅ 已修订 |

### 3.3 P2（事实性错误与表述问题）

| 编号 | 问题 | 位置 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| P2-1 | 虚假「完全缺失」断言：`.diffStatsAdd` / `.diffStatsDel` / `.toolPathLink` 实际已存在 | 03 §1.1 / §2.2 / §2.4 | 全部改为「已存在」+ 指出真实差距 | ✅ 已修订 |
| P2-2 | 虚假「默认点击框阴影、外边框」缺陷描述 | 03 §2.4 | 撤销（`.toolPathLink` 已正确重置原生按钮） | ✅ 已修订 |
| P2-3 | 伪样式 `.toolPulseRing` / `.toolKindIconRunning` / `@keyframes tool-ring-pulse` / `@keyframes tool-icon-breath`（全仓零引用） | 03 §2.3 / §5.1 / §5.2 / 00 §三-3 | 整案撤销，保持三元互斥 | ✅ 已修订 |
| P2-4 | 裸 Hex `var(--color-success, #10b981)` / `var(--color-error, #ef4444)` / `var(--brand, #10b981)` | 03 §5.2 / 04 §5.2 | 撤销，保留 token 机制 | ✅ 已修订 |
| P2-5 | 测试路径不一致（旧 `components/chat-message/__tests__/`） | 00 §四 / 01 / 03 | 收敛至 SSOT 同目录 | ✅ 已修订 |
| P2-6 | 「兼容转发」提法（`TurnProcessNodeView` 降级为转发壳） | 00 §四 / 03 §3.1 / 04 §8 | 改为**物理删除** | ✅ 已修订 |
| P2-7 | emoji 图标（✏️ / ⚡ / 🔍 / 🧠 / ⚙️） | 04 §5.3 / 00 §三-2 | 改为 `AppIcon` + `DOMINANT_ICON_MAP` | ✅ 已修订 |
| P2-8 | Lucide 图标引用 | 03 / 04 | 改为 `@hugeicons/core-free-icons`（经 `AppIcon`） | ✅ 已修订 |
| P2-9 | `processMetricsEngine` 被 01 引用但全仓无实现 | 01 | 登记为**待新建函数**（非重构） | ✅ 已登记 |
| P2-10 | `canonicalizeFsPath` 被 01 引用但全仓无实现 | 01 | 登记为**待新建函数**（非重构） | ✅ 已登记 |

---

## 四、铁律四（子代理可见性特权）落地裁决

**用户明确要求**：「开启子代理的时候，最好也保留一下，不要被折叠，因为子代理的重要性还是比较高的。」

### 4.1 数学契约

$$\text{subagentCount} \ge 1 \implies \text{foldable} = \text{true} \land \text{defaultExpanded} = \text{true} \land \text{forceExpanded} = \text{true}$$

### 4.2 裁决优先级（短路顺序）

```
1. 铁律四：subagentCount >= 1      → foldable=true, defaultExpanded=true, forceExpanded=true
2. 铁律一：hasNextText ≡ true      → foldable=true, defaultExpanded=false
3. 铁律二：isTurnLive              → foldable=true, defaultExpanded=true, isLive=true
4. 铁律三：toolCount >= 2          → foldable=true, defaultExpanded=false
           否则                     → foldable=false, defaultExpanded=true
```

### 4.3 四处落地面（缺一即失效）

| # | 落地位置 | 具体行为 |
| --- | --- | --- |
| 1 | `timelineSegmenter.partitionTimelineSegments` | 输出 `forceExpanded: true` |
| 2 | `MessageContent` 终态收敛 `useEffect` | `if (seg.forceExpanded) continue;` —— 跳过强制收起 |
| 3 | `MessageContent` 的 `isAllExpanded` | `.every((s) => expandedSections[s.id] === true \|\| s.forceExpanded)` |
| 4 | `MessageContent` 的 `handleToggleAll` | 在「全部收起」（`nextTarget === false`）方向 `if (seg.forceExpanded && !nextTarget) continue;` |
| 5 | `FoldableProcessSection` 的 `isExpanded` | `seg.forceExpanded ? true : expandedSections[seg.id] ?? false` |
| 6 | `FoldableProcessSection` 的收起按钮 | `disabled` + `aria-disabled="true"`（不隐藏，保留视觉解释） |
| 7 | `useUntilFoundSlot` 的 `isHidden` | `isFoldable && !isExpanded && !forceExpanded` —— 强制展开段**不加** `hidden="until-found"` |

### 4.4 负向断言

```typescript
it('负向断言：subagent 段在终态不得被自动收起', () => {
  const segments = partitionTimelineSegments('msg-1', itemsWithSubagent, false, false);
  const subagentSeg = segments.find((s) => s.kind === 'process_section' && s.metrics.subagentCount >= 1);
  expect(subagentSeg?.forceExpanded).toBe(true);
  expect(subagentSeg?.defaultExpanded).toBe(true);
  expect(subagentSeg?.foldable).toBe(true);
});

it('负向断言：无 subagent 的段不得获得 forceExpanded 特权', () => {
  const segments = partitionTimelineSegments('msg-2', itemsWithoutSubagent, false, false);
  for (const seg of segments) {
    if (seg.kind === 'process_section' && seg.metrics.subagentCount === 0) {
      expect(seg.forceExpanded).toBe(false);
    }
  }
});
```

---

## 五、文件域互斥表（多 Agent 并行调度依据）

**规则**：同一文件在同一时刻只允许一个 Agent 写入（引擎 I4-M3 写路径互斥）。下表列出本战役的**必然串行点**：

| 文件 | 涉及详案 | 串行原因 |
| --- | --- | --- |
| `api/tool-presentation/toolPresentationTypes.ts` | 01 §1、02 §7、04 §4.1、06 §5.1 | 契约类型唯一落点，被全部下游依赖，**必须首先完成** |
| `components/chat-message/MessageContent.tsx` | 03 §7 节点 C、04 §5.5、05、06 §6.4 | 四个详案同时改造此文件，**必须串行** |
| `components/chat-message/ProcessItemRenderer.tsx` | 03 §5.3、04、05 | 两详案同时改造，**必须串行** |
| `components/chat-tool-call/ChatToolCallBlock.module.css` | 03 §2、§5.2 | 单详案内多处改同一文件 |
| `components/chat-message/turnProcessState.ts` | 01 §2、04 §8.2 | 保留 `isSubagentToolName`，删除其余 |

**可安全并行的文件域**（无交集）：
- `api/tool-presentation/{timelineSegmenter,processMetricsEngine,toolActionClassifier}.ts` （纯逻辑层）
- `components/chat-message/{TurnStatusCapsule,FoldableProcessSection}.tsx`
- `components/chat-tool-call/ToolCallHeader.tsx`
- `store/sessionMessageActionsCore.ts` / `api/tool-presentation/timelineReconciler.ts`

---

## 六、负向断言清单（交付必备物证）

以下负向断言**必须**在自动化测试中落地，作为「旧轨物理根除」的客观物证：

```typescript
// apps/crish-desktop/src/api/tool-presentation/__tests__/ssotConvergence.test.ts

describe('SSOT 收敛负向断言', () => {
  it('① 旧契约类型名零残留', async () => {
    const files = await glob('apps/crish-desktop/src/**/*.{ts,tsx}');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      expect(src).not.toMatch(/ProcessSectionMetrics\b/);
      expect(src).not.toMatch(/interface\s+DominantIconSpec\b/);
    }
  });

  it('② 旧字段名零残留', async () => {
    const files = await glob('apps/crish-desktop/src/api/tool-presentation/**/*.ts');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      expect(src).not.toMatch(/\b(shellCommandCount|dominantCategory|editedFilePaths|readFilePaths)\b/);
      expect(src).not.toMatch(/\breadCount\s*:/);
      expect(src).not.toMatch(/\beditCount\s*:/);
    }
  });

  it('③ 旧函数名零残留', async () => {
    const files = await glob('apps/crish-desktop/src/**/*.{ts,tsx}');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      expect(src).not.toMatch(/\b(formatAggregatedSummaryText|arbitrateDominantCategory|aggregateSectionMetrics|formatSummaryLabel)\b/);
    }
  });

  it('④ 伪样式类零残留', async () => {
    const css = await readFile('apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css', 'utf8');
    expect(css).not.toMatch(/toolPulseRing/);
    expect(css).not.toMatch(/toolKindIconRunning/);
    expect(css).not.toMatch(/tool-ring-pulse/);
    expect(css).not.toMatch(/tool-icon-breath/);
  });

  it('⑤ 裸 Hex 与伪默认值零残留', async () => {
    const files = await glob('apps/crish-desktop/src/**/*.module.css');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      expect(src).not.toMatch(/var\([^)]*,\s*#[0-9a-fA-F]{3,8}\s*\)/);
    }
  });

  it('⑥ emoji 图标零残留', async () => {
    const files = await glob('apps/crish-desktop/src/**/*.{tsx,ts}');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      expect(src).not.toMatch(/[✏️⚡🔍📄🧠🤖🛠️]/u);
    }
  });

  it('⑦ 旧文件已物理删除', async () => {
    await expect(stat('apps/crish-desktop/src/components/chat-message/TurnProcessNodeView.tsx')).rejects.toThrow();
    await expect(stat('apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx')).rejects.toThrow();
  });

  it('⑧ SSOT 唯一实现（无重复文件）', async () => {
    const segFiles = await glob('apps/crish-desktop/src/**/timelineSegmenter.ts');
    expect(segFiles).toEqual(['apps/crish-desktop/src/api/tool-presentation/timelineSegmenter.ts']);
    const metricsFiles = await glob('apps/crish-desktop/src/**/processMetricsEngine.ts');
    expect(metricsFiles).toEqual(['apps/crish-desktop/src/api/tool-presentation/processMetricsEngine.ts']);
  });

  it('⑨ 调用方不得本地重推导 foldable/forceExpanded', async () => {
    const src = await readFile('apps/crish-desktop/src/components/chat-message/MessageContent.tsx', 'utf8');
    expect(src).not.toMatch(/isFoldable=\{!isLiveTurn\}/);
    expect(src).not.toMatch(/forceExpanded=\{subagentCount/);
    expect(src).not.toMatch(/toolCount\s*\+=\s*1/);
  });

  it('⑩ IconName 字面量不得硬编码在 .tsx', async () => {
    const files = await glob('apps/crish-desktop/src/components/chat-message/**/*.tsx');
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      expect(src).not.toMatch(/name=\{?['"](alert-circle|terminal|file-edit|search|bot)['"]/);
    }
  });
});
```

---

## 七、待新建函数登记（非重构，全仓原本无实现）

| 函数 | 目标路径 | 用途 | 依据 |
| --- | --- | --- | --- |
| `canonicalizeFsPath` | `api/tool-presentation/processMetricsEngine.ts` | 跨平台路径归一（正反斜杠、Windows 盘符大小写），支撑 `readPaths` / `editPaths` Set 去重 | 01 详案 §2 |
| `aggregateProcessMetrics` | 同上 | 从 `AssistantTimelineItem[]` 聚合 14 项 `ProcessSegmentMetrics` | 01 详案 §2 |
| `classifyToolAction` | `api/tool-presentation/toolActionClassifier.ts` | 两阶段注册表分类（`EXACT_ACTION_TABLE` + `FALLBACK_RULES`） | 01 详案 §2.3 |
| `partitionTimelineSegments` | `api/tool-presentation/timelineSegmenter.ts` | 按四铁律切割 `AssistantTimelineItem[]` → `TimelineSegment[]` | 01 详案 §3.2 |
| `formatSegmentSummary` | `api/tool-presentation/processMetricsEngine.ts` | 生成图五风格中圆点拼接摘要（需按优先序裁剪） | 02 详案 §5 |
| `arbitrateLeadAction` | 同上 | 依 `subagent > edit > search > read > command > thought > mixed` 仲裁 | 02 详案 §6 |
| `buildSlotId` | `api/tool-presentation/toolPresentationTypes.ts` | `process-slot-${sectionId}` 唯一生成 | 06 详案 §5.1.1 |

---

## 八、审计结论

### 8.1 收敛完成度

| 详案 | P0 | P1 | P2 | 收敛状态 |
| --- | --- | --- | --- | --- |
| 00 总方案 | 2 | 3 | 3 | ✅ 完成 |
| 01 分段状态机 | 2 | 2 | 2 | ✅ 完成 |
| 02 聚合文案与度量 | 1 | 3 | 2 | ✅ 完成 |
| 03 展开态 UI | 0 | 2 | 4 | ✅ 完成 |
| 04 组件容器 | 3 | 2 | 2 | ✅ 完成 |
| 05 用户插入节点 | 0 | 0 | 0 | ✅ 原稿健全 |
| 06 测高与检索 | 0 | 2 | 1 | ✅ 完成 |

### 8.2 关键论断

1. **全部 P0 缺陷已消除**：Hooks 违规、逻辑截肢、三源路径冲突、双实现、双契约命名均已收敛。
2. **铁律四已完整落地**：7 处落地面全数接线，并配套双向负向断言（有 subagent 必展开 / 无 subagent 不得获特权）。
3. **零兼容 Shim**：所有旧轨均为**物理删除**，无障碍期、无 `@deprecated` 转发壳。
4. **门禁完整**：验收命令补齐至 15 门，并新增 `ssotConvergence.test.ts` 覆盖 10 条负向断言。
5. **代码事实优先**：审计过程中发现 3 处原稿与代码事实不符（`.diffStatsAdd` / `.diffStatsDel` / `.toolPathLink` 并非缺失），已按事实修订并撤销虚假缺陷描述。

### 8.3 遗留风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| `--diff-add-fg` / `--diff-del-fg` 明度不足 | 图二基准为亮绿/亮红，当前 token 取值可能偏灰 | 视觉回归时若判定不足，**只调 token 取值**，禁止组件层换 token 名 |
| `.diffStatsInline` 的 `translateY(0.5px)` 光学微调 | 属光学对齐而非魔术数字，但仍有偏差风险 | 视觉回归断言显式覆盖；若偏离 > 0.5px 则**删除而非叠加补偿** |
| `subagentCount ⊆ toolCount` 的因果 | 子代理调用同时计入 `toolCount` | 02 §9.1 兼容映射已显式注明，测试须覆盖 |

---

*本文档为 `docs/assistant-process-folding/` 战役的唯一裁决总表。任何契约变更须先修订本文档，再同步 00–06。*
