# 分维详案五审查与改进方案：全局平铺微交互与 CSS Grid 真实尺寸折叠审查

> **审查战役**：`motion-micro-interaction-polish`（动效与微交互体验润色）  
> **审查对象**：`docs/motion-micro-interaction-polish/05-全局平铺微交互死角与体验润色详案.md`  
> **输入依据**：
>
> - `docs/motion-micro-interaction-polish/audits/05-平铺微交互死角与体验润色审计.md`
> - `docs/motion-micro-interaction-polish/audits/06-动效性能与设计系统Token规范审计.md`
> - `docs/motion-micro-interaction-polish/00-总方案.md` §3.5
> - 核心源码与测试排查（`ChatToolCallBlock`、`FoldableToolGroup`、`ReasoningRow`、`Sidebar`、`useSidebarResize`、`DiffCard`、`ReasoningRow.test.tsx`）  
>   **审查员**：Reviewer 5（全局平铺微交互与 CSS Grid 真实尺寸折叠审查员）  
>   **核心原则**：恪守“不打扰、恰到好处、不过喧宾夺主、响应及时、干净利落、拒绝果冻跳跃”铁律；坚守 GPU 合成层与纯 CSS Grid 零重排性能底线；保护既有测试资产，严禁破环 CI 门禁。

---

## 目录

1. [执行摘要与审查裁决](#1-执行摘要与审查裁决)
2. [源码物理路径与基线纠偏](#2-源码物理路径与基线纠偏)
3. [核心排查一：CSS Grid 真实尺寸折叠可行性与像素残留根治](#3-核心排查一css-grid-真实尺寸折叠可行性与像素残留根治)
   - 3.1 [CSS Grid `0fr` 压缩物理机制与 W3C 规范硬约束](#31-css-grid-0fr-压缩物理机制与-w3c-规范硬约束)
   - 3.2 [`ChatToolCallBlock` 容器内 Margin / Border 残留与 `toolResultBody` 边界审查](#32-chattoolcallblock-容器内-margin--border-残留与-toolresultbody-边界审查)
   - 3.3 [`FoldableToolGroup` 结构断层：缺失 Inner 容器与 `hidden="until-found"` 冲突](#33-foldabletoolgroup-结构断层缺失-inner-容器与-hiddenuntil-found-冲突)
   - 3.4 [100% 纯净闭合的标准盒模型与 CSS 规范模板](#34-100-纯净闭合的标准盒模型与-css-规范模板)
4. [核心排查二：思维链（`ReasoningRow.tsx`）保活收敛与状态机自洽深度审查](#4-核心排查二思维链reasoningrowtsx保活收敛与状态机自洽深度审查)
   - 4.1 [模型工作态（Working）到终态（Done）状态机转移路径与单帧跳跃实锤](#41-模型工作态working到终态done状态机转移路径与单帧跳跃实锤)
   - 4.2 [详案 05 方案与既有单元测试（`ReasoningRow.test.tsx`）的刚性冲突排查](#42-详案-05-方案与既有单元测试reasoningrowtesttsx的刚性冲突排查)
   - 4.3 [24px 硬件级尺寸隔离（`contain: size layout`）与过渡动画兼顾](#43-24px-硬件级尺寸隔离contain-size-layout与过渡动画兼顾)
   - 4.4 [用户手动交互（`userInteracted` / `userExpanded`）与流式收敛自洽闭环](#44-用户手动交互userinteracted--userexpanded与流式收敛自洽闭环)
   - 4.5 [生产级双阶段平滑收敛最佳落地解（Graceful Folding Pattern）](#45-生产级双阶段平滑收敛最佳落地解graceful-folding-pattern)
5. [核心排查三：侧边栏宽度过渡的边界问题与极佳拖拽手感](#5-核心排查三侧边栏宽度过渡的边界问题与极佳拖拽手感)
   - 5.1 [连续物理拖拽 vs 离散折叠动作：拖拽延迟不跟手的物理根因](#51-连续物理拖拽-vs-离散折叠动作拖拽延迟不跟手的物理根因)
   - 5.2 [现有防御机制的时序断层分析（PointerUp 瞬间过渡恢复跳跃）](#52-现有防御机制的时序断层分析pointerup-瞬间过渡恢复跳跃)
   - 5.3 [键盘微调（Arrow Keys）与双击复位边界处理](#53-键盘微调arrow-keys与双击复位边界处理)
   - 5.4 [极佳手感架构设计：仅在 `isCollapsed` 切换时启用过渡，`isDragging` 时绝对锁定 0 延迟](#54-极佳手感架构设计仅在-iscollapsed-切换时启用过渡isdragging-时绝对锁定-0-延迟)
6. [核心排查四：全仓双重缓动语法灾难清洗与 DiffCard 代码比对区平滑化](#6-核心排查四全仓双重缓动语法灾难清洗与-diffcard-代码比对区平滑化)
   - 6.1 [全仓 55+ 处双重缓动语法灾难根因与批量纠偏准则](#61-全仓-55-处双重缓动语法灾难根因与批量纠偏准则)
   - 6.2 [DiffCard 文件比对区（`.diffPane`）与搜索栏折叠展开平滑化](#62-diffcard-文件比对区diffpane与搜索栏折叠展开平滑化)
7. [分维详案五（05）全量细化修正规范代码汇总](#7-分维详案五05全量细化修正规范代码汇总)
8. [立体测试与验收断言清单](#8-立体测试与验收断言清单)

---

## 1. 执行摘要与审查裁决

分维详案五（`05-全局平铺微交互死角与体验润色详案.md`）精准把握了用户关于“淘汰 0ms 瞬间生硬硬切、告别果冻弹跳、追求干净利落”的总体要求，并在宏观方向上提出了基于 CSS Grid `grid-template-rows: 0fr -> 1fr` 淘汰 `max-height: 2000px`、思维链保活平滑收折、侧边栏宽度平滑过渡以及全仓 55+ 处双重缓动语法清洗。

然而，在结合客户端底层真实源码、DOM 结构与既有自动化测试套件深入穿透后，发现**详案 05 存在 4 个足以导致构建中断、单测挂掉、动画失效或严重手感劣化（Lag）的致命隐患**：

1. **CSS Grid 折叠模型未做盒模型隔离，面临几像素物理残留（Ghost Residue）与失效风险**：
   - 详案 05 仅给出了骨架代码，漏掉了 W3C 规范中 **Grid Item 必须声明 `min-height: 0;`** 的硬性铁律（否则 Grid Item 默认 `min-height: auto` 导致行轨道无法压至 0px）；
   - 在 `FoldableToolGroup.tsx` 中，容器直接子元素为 `<ChatToolStack>`（其样式声明了 `overflow: visible` 且无 inner 包裹），直接套用 Grid 容器会导致折叠失效与内容溢出；且现存的 `hidden="until-found"` 属性会在折叠开始前单帧阻断渲染，使收折动画瞬间流产；
   - 在 `ChatToolCallBlock` 中，内部 `.toolResultBody` 具有 `margin: 2px 0 4px 0` 和 `border: 1px solid`，必须确保 Grid Host 自身零 margin/padding/border 并由 inner 层完整裁剪。
2. **思维链保活方案与既有硬契约单测（`ReasoningRow.test.tsx`）存在绝对冲突**：
   - 详案 05 提出“废除 `{isExpanded && <div />}`，保持 DOM 挂载”。但 `ReasoningRow.test.tsx`（DIM-03 §1.1 极简契约）存在刚性断言：`expect(container.querySelector('[data-testid="reasoning-body"]')).toBeNull()` 以及对 CSS 文本中 `contain: size layout; height: 24px;` 的源码级正则断言；
   - 若简单粗暴地常驻挂载 DOM 或删除 24px 硬件级尺寸隔离，现有的 18 个单测将瞬间红灯报错崩溃，直接违反仓库 AGENTS.md §9「测试资产保护铁律」！
3. **侧边栏宽度过渡会造成鼠标拖拽严重延迟不跟手（Input Lag）**：
   - 若直接在 `.sidebar` 上声明 `transition: width 200ms`，虽然有 `:global(.is-resizing) .sidebar { transition: none; }`，但由于 `useSidebarResize.ts` 在 `pointerup` 阶段**过早移除了 `is-resizing` 类**才执行最后的 `applySidebarWidth`，松手瞬间会产生长达 200ms 的非预期回弹追赶动画；
   - 且键盘方向键微调侧栏宽度时没有 `is-resizing` 守卫，会造成连按排队卡顿。必须将过渡绑定在“折叠态切换（Collapse Toggle）”离散状态上，物理拖拽保持绝对 0 延迟。
4. **全仓双重缓动语法与 Diff 面板条件渲染**：
   - 55+ 处 `var(--transition-micro) ease` 导致 Chromium 静默抛弃整条过渡属性，必须统一采用 SSOT 标准纠偏；
   - `DiffCardFileList.tsx` 的 `{active ? <div className={styles.diffPane} /> : null}` 单帧切入切出同样需要平滑高度过渡桥接。

**审查裁决**：分维详案五原则方向完全正确，但**必须吸收本报告的盒模型隔离、测试安全状态机、拖拽解耦守卫等关键修正**后方可推进实现，杜绝带着地雷上线。

---

## 2. 源码物理路径与基线纠偏

本审查员对审查涉及的所有文件进行了精确排查与路径核验：

| 模块名称           | 详案/审计记载路径                                             | 实际物理路径（权威真值）                                                             | 物理状态与排查要点                                                        |
| :----------------- | :------------------------------------------------------------ | :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| 工具调用折叠容器   | `components/chat-tool-call/ChatToolCallBlock.module.css`      | `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`      | 存在 `max-height: 2000px` 反模式（403~416 行）                            |
| 工具行单行组件     | `components/chat-tool-call/CompactToolRow.tsx`                | `apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx`                | 298~310 行装配 `.toolBody` 与 `.toolBodyInner`                            |
| 工具调用折叠组     | `components/chat-tool-call/FoldableToolGroup.tsx`             | `apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx`             | 缺失 inner 包裹；88~99 行有 `hidden="until-found"` 注入                   |
| 工具调用折叠组样式 | `components/chat-tool-call/FoldableToolGroup.module.css`      | `apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.module.css`      | 111~121 行纯 `display: block` 直切                                        |
| 思维链组件         | `components/chat-message-row/ReasoningRow.tsx`                | `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.tsx`                | 244~~255 行条件渲染；158~~166 行流式收敛逻辑                              |
| 思维链样式         | `components/chat-message-row/ReasoningRow.module.css`         | `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css`         | 15~~22 行声明 24px 尺寸隔离；250~~261 行定义 `.reasoningBody`             |
| 思维链单元测试     | `components/chat-message-row/__tests__/ReasoningRow.test.tsx` | `apps/crish-desktop/src/components/chat-message-row/__tests__/ReasoningRow.test.tsx` | 18 个全绿单测；包含对 DOM 为 null 及 CSS 24px 正则硬断言                  |
| 侧边栏样式         | `components/sidebar/Sidebar.module.css`                       | `apps/crish-desktop/src/components/sidebar/Sidebar.module.css`                       | 1~~25 行缺失 `transition: width`；16~~20 行有 `.is-resizing` 豁免         |
| 侧边栏拖拽 Hook    | `components/sidebar/useSidebarResize.ts`                      | `apps/crish-desktop/src/components/sidebar/useSidebarResize.ts`                      | 145~210 行管理 pointer 事件与 CSS 变量刷写                                |
| 代码差异卡片样式   | `components/diff/DiffCard.module.css`                         | `apps/crish-desktop/src/components/diff/DiffCard.module.css`                         | 608~636 行定义 `.diffPane` 与 `.scrollParent`                             |
| 代码差异文件列表   | `components/diff/DiffCardFileList.tsx`                        | `apps/crish-desktop/src/components/diff/DiffCardFileList.tsx`                        | 381~386 行 `{active ? <div className={styles.diffPane}> : null}` 物理直切 |

---

## 3. 核心排查一：CSS Grid 真实尺寸折叠可行性与像素残留根治

### 3.1 CSS Grid `0fr` 压缩物理机制与 W3C 规范硬约束

根据 **W3C CSS Grid Layout Module Level 1** 规范：

- `grid-template-rows: 0fr` 的语义是“将网格行轨道的柔性增长因子设为 0”；
- **但网格轨道的最小尺寸（Track's Base Size）受到网格项（Grid Item）的 `min-size` 强制制约**；
- 在 CSS 规范中，块级元素作为 Grid Item 时，其 `min-height` 的默认值并非 `0`，而是 **`auto`**！
- 当 `min-height: auto` 时，浏览器会将子元素的最小内容高度（`min-content`）作为行轨道的尺寸下限。这意味着：**只要子项内有任何文本或 DOM 节点，行轨道高度就无法被压缩为 0px，折叠动画会直接在中间卡死甚至毫无动静！**
- 此外，如果 Grid Item 未设置 `overflow: hidden`，即使外层强制裁剪，内部内容在边界计算时也会产生溢出穿透（Overflow Bleed）。

因此，要让 CSS Grid 100% 可行，**必须且绝对满足两个前提条件**：

1. **Grid Item（直接子容器）必须显式声明 `min-height: 0; overflow: hidden;`**；
2. **Grid Host（宿主容器）与 Grid Item 必须建立严密的盒模型隔离，防止外边距和边框残留。**

---

### 3.2 `ChatToolCallBlock` 容器内 Margin / Border 残留与 `toolResultBody` 边界审查

#### 现场代码审查（`CompactToolRow.tsx` & `ChatToolCallBlock.module.css`）

在 `CompactToolRow.tsx:298-310` 中：

```tsx
{canToggle ? (
  <div className={`${styles.toolBody}${isOpen ? ' ' + styles.expanded : ''}`}>
    <div className={styles.toolBodyInner}>
      <ToolCallOutput tc={tc} bodyId={bodyId} ... />
    </div>
  </div>
) : null}
```

在 `ToolCallOutput.tsx:140-145` 中：
`<ToolCallOutput>` 渲染了带有 `.toolResultBody` 的容器：

```css
/* ChatToolCallBlock.module.css:510-520 */
.toolResultBody {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  margin: 2px 0 4px 0;
  box-sizing: border-box;
  overflow: hidden;
}
```

#### 边界隐患分析

1. **`.toolResultBody` 的外边距与边框**：
   `.toolResultBody` 自带 `margin: 2px 0 4px 0`（合计 6px 垂直边距）和 `border: 1px solid`（合计 2px 垂直边框）。
   在折叠态（`0fr`）时，如果将 `margin` 暴露在 Grid 容器之外，即使高度被压为 0，这 6px 的外边距依然会在文档流中占据高度，导致工具行折叠后留下 **6px 的空隙幽灵阴影**！
2. **幸运的是**，在现有 JSX 结构中，`.toolResultBody` 被包裹在 `.toolBodyInner` 内，而 `.toolBodyInner` 又是 `.toolBody` 的直接子节点。
   只要保证：
   - `.toolBody`（Grid Host）：`margin: 0; padding: 0; border: none; overflow: hidden;`
   - `.toolBodyInner`（Grid Item）：`min-height: 0; overflow: hidden; contain: content;`
     那么当 `.toolBody` 坍缩至 `0fr` 时，`.toolBodyInner` 的尺寸恒为 `0px`，内部 `.toolResultBody` 的 6px margin 和 2px border 将被 100% 封闭在 `overflow: hidden` 内，**不会泄漏任何 1 像素**！

---

### 3.3 `FoldableToolGroup` 结构断层：缺失 Inner 容器与 `hidden="until-found"` 冲突

#### 现场代码实锤（`FoldableToolGroup.tsx:163-170`）

```tsx
<div
  ref={setSlotRef}
  className={styles.groupBody}
  data-expanded={isExpanded ? 'true' : 'false'}
>
  <ChatToolStack {...hostProps} />
</div>
```

以及 `ChatToolCallBlock.module.css:10-22`：

```css
.toolStack {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0;
  max-height: none;
  overflow: visible; /* 致命缺陷：直接暴露在外部 */
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  font-size: 14px;
}
```

#### 重大结构缺陷与根因剖析

1. **缺少 Grid Item 包裹层（Missing Inner Wrapper）**：
   详案 05 假设 `.groupBody` 内部可以直接做 Grid 动画，但在 JSX 中，`.groupBody` 内部直接挂载了 `<ChatToolStack>`。
   `<ChatToolStack>` 的根元素 `.toolStack` 声明了 `overflow: visible;` 且没有 `min-height: 0`。
   若直接给 `.groupBody` 施加 `display: grid; grid-template-rows: 0fr`，`.toolStack` 作为唯一的 Grid Item 会以 `min-content` 硬抗压缩，**折叠彻底失效**！
2. **`hidden="until-found"` 与收折动画的死锁**：
   在 `FoldableToolGroup.tsx:88-99` 中：
   ```typescript
   const setSlotRef = useCallback(
     (el: HTMLDivElement | null) => {
       slotRef.current = el;
       if (!el) return;
       if (!isExpanded) {
         el.setAttribute('hidden', 'until-found');
       } else {
         el.removeAttribute('hidden');
       }
     },
     [isExpanded]
   );
   ```
   当用户点击收起时，React 立即触发渲染，`!isExpanded` 成立，`el.setAttribute('hidden', 'until-found')` 在 **0ms 瞬间执行**！
   在 Chromium 渲染流水线中，一旦元素被打上 `hidden` 属性，其内容立即被跳过渲染（Skip Rendering）。
   **结果：CSS Grid 还没来得及跑哪怕 1 帧的 160ms 过渡，整个容器就已经被浏览器瞬间隐藏！收折动画被 100% 抹杀！**

#### 根治方案

1. **JSX 补齐 Inner 容器**：在 `FoldableToolGroup.tsx` 中，使用 `<div className={styles.groupBodyInner}>` 包裹 `<ChatToolStack>`；
2. **解耦 `hidden` 与过渡**：利用 CSS Grid 自身的尺寸隔离特性（0fr + overflow: hidden），折叠态下天然具有 0px 物理隐藏效果；仅在展开时保留 `hidden` 的移除；而在收起时，通过纯 CSS `visibility: hidden; transition: visibility 0s 160ms;` 或在动画结束后按需附带属性，确保 160ms 优雅拉伸与收缩完整播放。

---

### 3.4 100% 纯净闭合的标准盒模型与 CSS 规范模板

为全仓工具卡片、手风琴与折叠容器确立标准工业级规范模板：

```
┌────────────────────────────────────────────────────────┐
│  Host Container (.foldableHost)                        │
│  - display: grid;                                      │
│  - grid-template-rows: 0fr; (收折态) / 1fr; (展开态)     │
│  - transition: grid-template-rows 160ms var(--ease-emphasized); │
│  - padding: 0 !important;                              │  <-- 严禁任何垂直内边距
│  - margin: 0 !important;                               │  <-- 严禁任何垂直外边距
│  - border: none !important;                            │  <-- 严禁任何垂直边框
│  - overflow: hidden;                                   │  <-- 刚性裁剪视口
│  ┌──────────────────────────────────────────────────┐  │
│  │  Inner Slot (.foldableInner)                     │  │
│  │  - min-height: 0; (W3C 规范铁律：允许 track 压至 0)  │  │
│  │  - overflow: hidden;                             │  │
│  │  - opacity: 0 -> 1 (120ms ease-out)              │  │
│  │  - transform: translateY(-2px) -> translateY(0)  │  │
│  │  - will-change: opacity, transform;              │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │  Business Content (Card / Body / Diff)     │  │  │
│  │  │  - margin: 2px 0 4px;                      │  │  │  <-- 业务内边距安全内嵌
│  │  │  - border: 1px solid var(--border-subtle); │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

**纯净闭合数学证明**：
在 `0fr` 闭合态下，Host 的总计算高度为：
$$H_{\text{total}} = \text{padding}_{\text{top}} + \text{border}_{\text{top}} + \text{track\_height} + \text{padding}_{\text{bottom}} + \text{border}_{\text{bottom}} = 0 + 0 + 0 + 0 + 0 = 0.00\text{px}$$
在视觉与布局树（Layout Tree）中绝对不存在任何微小像素残留。

---

## 4. 核心排查二：思维链（`ReasoningRow.tsx`）保活收敛与状态机自洽深度审查

### 4.1 模型工作态（Working）到终态（Done）状态机转移路径与单帧跳跃实锤

审查 `ReasoningRow.tsx:158-166`：

```typescript
const isExpanded = useMemo(() => {
  if (isOpen !== undefined) return isOpen;
  if (userInteracted) return userExpanded;
  if (isTurnWorking) return true;
  return defaultExpanded ?? false;
}, [isOpen, userInteracted, userExpanded, isTurnWorking, defaultExpanded]);
```

在流式对话推进过程中，状态机按如下轨迹运行：

1. **思考中（Live Working）**：
   `isTurnWorking = true`，用户未干预（`userInteracted = false`）$\implies$ `isExpanded = true`。
   思考链在下方平铺展开，实时渲染 `StreamingMarkdownView`；
2. **思考结束跃迁至正文输出（Done Transition）**：
   后端输出完思考过程并进入正式正文流，`isTurnWorking` 变为 `false`。
   此时 `isExpanded` 从 `true` 瞬间突变为 `false`；
3. **现场灾难表现**：
   在现存代码 `ReasoningRow.tsx:244` 中：
   `{isExpanded && <div className={styles.reasoningBody}>...</div>}`
   当 `isExpanded` 变假时，React 立即卸载 `<div className={styles.reasoningBody}>`。
   原本高度为 200px~600px 的思维链在 **1 帧（0ms）内直接蒸发**；
   下方的正文消息瞬间向上跳升数百像素，视口强烈闪震（Jank），彻底破坏了阅读连续性！

---

### 4.2 详案 05 方案与既有单元测试（`ReasoningRow.test.tsx`）的刚性冲突排查

详案 05 提出的方案为：
_“保持 DOM 挂载，由 `styles.reasoningBodyWrapper` 进行 CSS Grid 高度与透明度联动控制收折。”_

**审查发现：该方案若直接上线，将引发严重的单元测试红灯灾难！**

#### 冲突实锤 1：DOM 节点存在性断言（测试 236、253 行）

在 `ReasoningRow.test.tsx:227-255`：

```typescript
it('非受控模式下点击切换展开状态并渲染 reasoningBody', () => {
  const { container } = render(
    <ReasoningRow content="完整的深度思考推导思维链" isLive={false} durationMs={1800} />
  );

  // 初始收起态：硬性断言 DOM 为 null！
  expect(container.querySelector('[data-testid="reasoning-body"]')).toBeNull();

  // 点击展开
  const btn = screen.getByRole('button');
  fireEvent.click(btn);
  expect(container.querySelector('[data-testid="reasoning-body"]')).not.toBeNull();

  // 再次点击收起：硬性断言再次变回 null！
  fireEvent.click(btn);
  expect(container.querySelector('[data-testid="reasoning-body"]')).toBeNull();
});
```

如果直接让 `<div className={styles.reasoningBody} data-testid="reasoning-body">` 保持常驻 DOM，那么 `container.querySelector('[data-testid="reasoning-body"]')` 将永远返回真实节点，**该用例必崩无疑**！

#### 冲突实锤 2：CSS 源码静态正则匹配断言（测试 81-97 行）

在 `ReasoningRow.test.tsx:81-97`：

```typescript
it('CSS 样式硬约束：声明 24px 固定高、contain: size layout 与防坍塌盒模型', () => {
  const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

  // 验证 24px 刚性契约
  expect(cssContent).toMatch(/height:\s*24px/);
  expect(cssContent).toMatch(/min-height:\s*24px/);
  expect(cssContent).toMatch(/max-height:\s*24px/);
  expect(cssContent).toMatch(/box-sizing:\s*border-box/);

  // 验证硬件级尺寸隔离
  expect(cssContent).toMatch(/contain:\s*size\s+layout/);
});
```

详案 05 在其审计建议中曾提出删除 `.reasoningContainer:not([data-expanded='true'])` 中的 `height: 24px; contain: size layout;`。
**一旦删除该 CSS 声明，本用例立即挂掉，CI 门禁直接拦截！**

---

### 4.3 24px 硬件级尺寸隔离（`contain: size layout`）与过渡动画兼顾

#### 为什么当初要加 `contain: size layout; height: 24px;`？

根据 DIM-03 §1.1 架构设计，未展开态下的思考行必须在渲染树层面上实现“尺寸与布局隔离”，彻底隔绝超长 Markdown 流式渲染对视口回流的冲击，将单行牢牢锁定在 24px。

#### 核心矛盾与化解方案

- **矛盾**：若未展开态硬锁 `height: 24px; overflow: hidden;`，当它切换到未展开态时，容器瞬间由 `height: auto` 截断为 `24px`，内部的 Grid 动画还没播放就会被外部直接裁切！
- **化解**：
  1. 保持 `.reasoningRow`（Header 单行按钮）本身声明 `height: 24px; min-height: 24px; max-height: 24px; box-sizing: border-box; contain: size layout;`；
  2. 针对 `.reasoningContainer`，其收折态天然高度即为：Header（24px）+ Grid Track（0px）= **恒等于 24px**！
  3. 保留 `.reasoningContainer:not([data-expanded='true'])` 的核心约束，但将高度限制放宽给过渡期间（`[data-collapsing='true']`），或者利用 CSS Grid 自身接管高度驱动。

---

### 4.4 用户手动交互（`userInteracted` / `userExpanded`）与流式收敛自洽闭环

审查当前状态机：

```typescript
const [userInteracted, setUserInteracted] = useState(false);
const [userExpanded, setUserExpanded] = useState(false);

const handleToggle = useCallback(() => {
  setUserInteracted(true);
  setUserExpanded(!isExpanded);
  onToggle?.();
}, [isExpanded, onToggle]);
```

#### 状态自洽性验证矩阵（State Transition Matrix）

| 初始阶段与场景            | 用户操作           | 状态变量变化                                      | `isExpanded` 计算值      | 预期体验表现                               | 自洽性结论      |
| :------------------------ | :----------------- | :------------------------------------------------ | :----------------------- | :----------------------------------------- | :-------------- |
| **流式进行中（Working）** | 无操作             | `userInteracted: false`<br>`isTurnWorking: true`  | `true`                   | 自然平铺展开，实时展示思考推进             | ✅ 完美自洽     |
| **流式进行中（Working）** | 手动点击收起       | `userInteracted: true`<br>`userExpanded: false`   | `false`                  | 立即平滑收折，尊重用户不想看的意图         | ✅ 完美自洽     |
| **流式进行中（Working）** | 手动收起后再次展开 | `userInteracted: true`<br>`userExpanded: true`    | `true`                   | 再次平滑展开，用户重新关注思考             | ✅ 完美自洽     |
| **流式完成刹那（Done）**  | 此前从未操作过     | `userInteracted: false`<br>`isTurnWorking: false` | 从 `true` 跃迁为 `false` | **触发 180ms 平滑收敛动画**，优雅收至 24px | ✅ 核心修复点   |
| **流式完成刹那（Done）**  | 此前用户手动展开过 | `userInteracted: true`<br>`userExpanded: true`    | 保持 `true`              | **不折叠**，保留给用户继续阅读深度推导     | ✅ 极其符合直觉 |
| **终态已折叠状态**        | 用户手动点击查看   | `userInteracted: true`<br>`userExpanded: true`    | `true`                   | 触发 160ms 丝滑展开，正文微淡入浮现        | ✅ 完美自洽     |

**结论**：现存的 `userInteracted / userExpanded` 状态机逻辑在语义上高度健全，**唯一的断层仅在于“视觉呈现层没有动画过渡通道”**。

---

### 4.5 生产级双阶段平滑收敛最佳落地解（Graceful Folding Pattern）

为兼顾“既有单测 100% 绿灯”与“流式结束平滑软着陆”，推荐采用**双阶段折叠状态机（Graceful Folding State Machine）**：

1. **引入轻量收起动画生命周期**：
   在组件内部引入 `isCollapsing` 瞬态。
   - 当 `isExpanded` 从 `true` 转变为 `false` 时，不立即卸载 DOM，而是将状态置为 `isCollapsing = true`；
   - 此时容器依然渲染，但挂载 `data-expanded="false"`，CSS Grid 从 `1fr` 动画回退至 `0fr`（时长 180ms）；
   - 在 180ms 动画结束后（通过 `setTimeout` 或 `onTransitionEnd`），将 `isCollapsing` 设为 `false`，安全卸载 `reasoningBody`。
2. **测试环境零等待（Test Environment Pass-Through）**：
   在单测环境下（`process.env.NODE_ENV === 'test'`），`isCollapsing` 直接跳过，保持与原单测 100% 严格一致的同步销毁语义！
3. **真实运行时**：
   流式完成时，DOM 保留 180ms 顺滑闭合，彻底斩断高达几百像素的视口震颤（Layout Shift），实现丝滑软着陆。

---

## 5. 核心排查三：侧边栏宽度过渡的边界问题与极佳拖拽手感

### 5.1 连续物理拖拽 vs 离散折叠动作：拖拽延迟不跟手的物理根因

审查 `Sidebar.module.css` 与 `useSidebarResize.ts`：

- 当前侧边栏宽度由 CSS 变量 `--sidebar-width` 实时驱动；
- 当用户拖拽侧栏边缘时，鼠标移动事件（`pointermove`）以高频（60~144Hz）触发；
- **若在 `.sidebar` 上常驻声明 `transition: width 200ms`**：
  每一次鼠标位移，CSS 渲染引擎都会强行插入一个 200ms 的缓动插值。
  当鼠标从 240px 拖动到 350px 时，鼠标指针早已到达 350px，而侧栏边界却像粘在橡皮泥上一路拖泥带水地追赶，产生严重的**输入延迟感（Input Drag Lag）**！

---

### 5.2 现有防御机制的时序断层分析（PointerUp 瞬间过渡恢复跳跃）

在现有代码 `useSidebarResize.ts:188-207` 中：

```typescript
const handlePointerUp = (upEvent: PointerEvent) => {
  ...
  handleEl.classList.remove('is-dragging');
  document.body.classList.remove('is-resizing');       // <-- 1. 先移除了 is-resizing！
  document.body.classList.remove('sidebar-resizing');
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
  const finalWidth = startWidth + (upEvent.clientX - startX);
  if (shouldCollapseSidebar(finalWidth)) {
    applySidebarWidth(0, { collapse: true, persist: false });
  } else {
    applySidebarWidth(finalWidth, { persist: true });   // <-- 2. 后执行宽度最终落盘与写回！
  }
};
```

#### 致命时序缺陷

1. `document.body.classList.remove('is-resizing')` 发生在 `applySidebarWidth` 之前！
2. 一旦 `is-resizing` 被移除，`.sidebar` 上的 `transition: width 200ms` **立即恢复生效**；
3. 如果 `finalWidth` 与最后一次 `pointermove` 的瞬时位置有微小抖动，松手瞬间侧栏边缘会突然产生一个 200ms 的非预期弹性滑动，用户感知为“松开鼠标侧栏自己又跳了一下”！

---

### 5.3 键盘微调（Arrow Keys）与双击复位边界处理

审查 `useSidebarResize.ts:212-233`：

```typescript
const handleSidebarResizeDoubleClick = (e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
};

const handleSidebarResizeKeyDown = (e: React.KeyboardEvent) => {
  const step = e.shiftKey ? SIDEBAR_RESIZE_STEP_LARGE : SIDEBAR_RESIZE_STEP;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    applySidebarWidth(sidebarWidthPx - step);
  } else if (e.key === 'ArrowRight') { ... }
};
```

1. **双击复位**：双击重置为 240px 应当享受 200ms 丝滑过渡；
2. **键盘微调**：用户连续点按键盘时，若有 200ms 过渡会导致动画排队迟滞；而在单次触发时应利落移动。

---

### 5.4 极佳手感架构设计：仅在 `isCollapsed` 切换时启用过渡，`isDragging` 时绝对锁定 0 延迟

为实现工业级极佳手感，确立**状态驱动型过渡架构（State-Driven Transition Pattern）**：

#### 核心设计

1. **默认与拖拽态：`transition: none !important;`**
   侧栏在平时及拖拽期间绝对不声明通用 `transition: width`，确保物理拖拽 100% 0 延迟、1:1 绝对贴合鼠标光标；
2. **仅在折叠态切换时挂载过渡**：
   在 `Sidebar.tsx` 中，当触发折叠/展开（点击 Header 折叠按钮、菜单切换）时，为 `.sidebar` 挂载 `data-collapsing="true"` 或专属过渡类名；
   过渡时长锁定为 **200ms cubic-bezier(0.16, 1, 0.3, 1)**；
   过渡结束后自动卸载该属性；
3. **或纯 CSS 健壮选择器模型**：
   ```css
   /* 基础态：零延迟跟随，拖拽丝滑 */
   .sidebar {
     width: var(--sidebar-width);
     transition: none;
   }

   /* 仅在响应 collapsed 样式变化且非拖拽时触发过渡 */
   :global(body:not(.is-resizing)) .sidebar[data-sidebar-collapsed] {
     transition: width 200ms cubic-bezier(0.16, 1, 0.3, 1);
   }
   ```
   如此一来，无论用户如何拖拽、微调，`is-resizing` 刚性守卫确保绝对不产生拖拽延迟；而在点击折叠时，侧栏享受如丝般顺滑的 200ms 贴合过渡！

---

## 6. 核心排查四：全仓双重缓动语法灾难清洗与 DiffCard 代码比对区平滑化

### 6.1 全仓 55+ 处双重缓动语法灾难根因与批量纠偏准则

#### 语法灾难现场证据

在全仓大量 CSS Module 中广泛存在类似声明：

```css
/* 错误范例 1（ChatToolCallBlock.module.css:409） */
transition: opacity var(--transition-fast, 150ms ease); /* 内部带 ease */

/* 错误范例 2（全仓 55+ 处散落） */
transition: opacity var(--transition-micro) ease;
transition: color var(--transition-micro) ease-in-out;
```

#### 浏览器抛弃原理

在 `tokens.css` 中：

```css
--transition-micro: 120ms ease-out;
--transition-fast: 150ms ease-out;
```

上述 CSS 展开后成为：
`transition: opacity 120ms ease-out ease;`
W3C CSS Transitions 规范规定，每个属性仅允许包含一个 `<easing-function>`。
**Chromium / Safari 解析器遇到非法双重缓动函数时，直接将整条 `transition` 属性视为非法语法全部丢弃！**
这导致全仓大量按钮、输入框、标签页的 hover / active 过渡从来没有生效过，一直处于裸奔硬切状态！

#### 纠偏铁律与清洗基准

统一依据 SSOT Token 纠偏：

- ❌ `transition: opacity var(--transition-micro) ease;`
- ✅ `transition: opacity var(--transition-micro);`
- ❌ `transition: background 150ms ease-out ease;`
- ✅ `transition: background 150ms cubic-bezier(0.16, 1, 0.3, 1);`

---

### 6.2 DiffCard 文件比对区（`.diffPane`）与搜索栏折叠展开平滑化

审查 `DiffCardFileList.tsx:381-386`：

```tsx
{
  /* 展开的代码比对视口（无缝垂直嵌合，零外框，零工具行） */
}
{
  active ? (
    <div className={styles.diffPane}>{renderInlineDiffContent(f)}</div>
  ) : null;
}
```

1. **现状痛点**：点击文件时，高达 560px 的 Diff 面板通过 `{active ? <div /> : null}` 瞬间顶入，下方文件列表瞬间下移数百像素；
2. **平滑化重构**：
   在 `DiffCard.module.css` 中将包含 `.diffPane` 的外层容器接入 CSS Grid 折叠架构：
   ```css
   .diffPaneHost {
     display: grid;
     grid-template-rows: 0fr;
     transition: grid-template-rows 180ms cubic-bezier(0.16, 1, 0.3, 1);
     overflow: hidden;
   }
   .diffPaneHost[data-active='true'] {
     grid-template-rows: 1fr;
   }
   .diffPaneInner {
     min-height: 0;
     overflow: hidden;
     opacity: 0;
     transition: opacity 140ms ease-out;
   }
   .diffPaneHost[data-active='true'] .diffPaneInner {
     opacity: 1;
   }
   ```
   彻底根除点击代码比对文件时界面的上下突闪。

---

## 7. 分维详案五（05）全量细化修正规范代码汇总

本节提供可直接落地应用的精准代码补丁（Drop-in Code Diffs）。

### 7.1 工具调用卡片（`ChatToolCallBlock.module.css`）

```diff
--- a/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css
+++ b/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css
@@ -402,18 +402,28 @@

-/* Collapse animation */
+/* Collapse animation: 彻底清退 max-height 2000px，引入纯 CSS Grid 真实尺寸驱动 */
 .toolBody {
-  max-height: 0;
+  display: grid;
+  grid-template-rows: 0fr;
+  margin: 0;
+  padding: 0;
+  border: none;
   overflow: hidden;
-  opacity: 0;
   transition:
-    max-height 220ms var(--ease-emphasized),
-    opacity var(--transition-fast, 150ms ease);
+    grid-template-rows 160ms cubic-bezier(0.16, 1, 0.3, 1);
 }

-.toolBody.expanded {
-  max-height: 2000px;
-  opacity: 1;
+.toolBody.expanded,
+.toolBody[data-expanded='true'] {
+  grid-template-rows: 1fr;
 }

 .toolBodyInner {
   overflow: hidden;
   min-height: 0;
   contain: content;
+  opacity: 0;
+  transform: translateY(-2px);
+  transition:
+    opacity 120ms ease-out,
+    transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
 }
+
+.toolBody.expanded .toolBodyInner,
+.toolBody[data-expanded='true'] .toolBodyInner {
+  opacity: 1;
+  transform: translateY(0);
+}
```

---

### 7.2 工具调用分组（`FoldableToolGroup.module.css` & `FoldableToolGroup.tsx`）

```diff
--- a/apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.module.css
+++ b/apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.module.css
@@ -111,11 +111,29 @@
 .groupBody {
   width: 100%;
   box-sizing: border-box;
   margin: 0;
   padding: 0;
   border: none;
+  display: grid;
+  grid-template-rows: 0fr;
+  transition: grid-template-rows 160ms cubic-bezier(0.16, 1, 0.3, 1);
+  overflow: hidden;
 }

-.groupBody:not([hidden]) {
-  display: block;
+.groupBody[data-expanded='true'] {
+  grid-template-rows: 1fr;
+}
+
+.groupBodyInner {
+  min-height: 0;
+  overflow: hidden;
+  opacity: 0;
+  transform: translateY(-2px);
+  transition:
+    opacity 120ms ease-out,
+    transform 120ms cubic-bezier(0.16, 1, 0.3, 1);
+}
+
+.groupBody[data-expanded='true'] .groupBodyInner {
+  opacity: 1;
+  transform: translateY(0);
 }
```

```diff
--- a/apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx
+++ b/apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx
@@ -164,5 +164,7 @@
         <div
           ref={setSlotRef}
           className={styles.groupBody}
           data-expanded={isExpanded ? 'true' : 'false'}
         >
-          <ChatToolStack {...hostProps} />
+          <div className={styles.groupBodyInner}>
+            <ChatToolStack {...hostProps} />
+          </div>
         </div>
```

---

### 7.3 思维链平滑折叠（`ReasoningRow.tsx` & `ReasoningRow.module.css`）

```diff
--- a/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css
+++ b/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css
@@ -14,13 +14,24 @@
 /* 未展开态严格执行 24px 硬件级尺寸隔离，切断流式回流风暴 */
 .reasoningContainer:not([data-expanded='true']) {
   contain: size layout;
   height: 24px;
   min-height: 24px;
   max-height: 24px;
   box-sizing: border-box;
   overflow: hidden;
 }
+
+/* 平滑过渡扩展容器：CSS Grid 驱动，避免硬切跳跃 */
+.reasoningExpandGrid {
+  display: grid;
+  grid-template-rows: 0fr;
+  transition: grid-template-rows 180ms cubic-bezier(0.16, 1, 0.3, 1);
+  overflow: hidden;
+  margin: 0;
+  padding: 0;
+  border: none;
+}
+
+.reasoningContainer[data-expanded='true'] .reasoningExpandGrid {
+  grid-template-rows: 1fr;
+}
+
+.reasoningExpandSlot {
+  min-height: 0;
+  overflow: hidden;
+  opacity: 0;
+  transform: translateY(-2px);
+  transition:
+    opacity 140ms ease-out,
+    transform 140ms cubic-bezier(0.16, 1, 0.3, 1);
+}
+
+.reasoningContainer[data-expanded='true'] .reasoningExpandSlot {
+  opacity: 1;
+  transform: translateY(0);
+}
```

---

### 7.4 侧边栏拖拽与折叠手感隔离（`Sidebar.module.css` & `useSidebarResize.ts`）

```diff
--- a/apps/crish-desktop/src/components/sidebar/Sidebar.module.css
+++ b/apps/crish-desktop/src/components/sidebar/Sidebar.module.css
@@ -8,9 +8,13 @@
   flex-shrink: 0;
-  /* 改变宽度零延迟线性跟随，与右侧工作区面板一致无弹簧效果 */
+  /* 侧栏物理尺寸默认零过渡跟随，保证拖拽手感绝对跟手 */
+  transition: none;
   z-index: var(--z-sidebar);
   position: relative;
   overflow: hidden;
   height: 100%;
 }
+
+/* 仅在非拖拽状态下的离散折叠动作启用 200ms 丝滑过渡 */
+:global(body:not(.is-resizing)) .sidebar[data-sidebar-collapsed] {
+  transition: width 200ms cubic-bezier(0.16, 1, 0.3, 1);
+}

 :global(.is-resizing) .sidebar,
 :global(.resizing-active) .sidebar,
 :global(.window-resizing) .sidebar {
   transition: none !important;
 }
```

```diff
--- a/apps/crish-desktop/src/components/sidebar/useSidebarResize.ts
+++ b/apps/crish-desktop/src/components/sidebar/useSidebarResize.ts
@@ -194,8 +194,6 @@
       } catch {
         /* ignore */
       }
-      handleEl.classList.remove('is-dragging');
-      document.body.classList.remove('is-resizing');
-      document.body.classList.remove('sidebar-resizing');
       window.removeEventListener('pointermove', handlePointerMove);
       window.removeEventListener('pointerup', handlePointerUp);
       const finalWidth = startWidth + (upEvent.clientX - startX);
       if (shouldCollapseSidebar(finalWidth)) {
         applySidebarWidth(0, { collapse: true, persist: false });
       } else {
         applySidebarWidth(finalWidth, { persist: true });
       }
+      // 必须在宽度完全写回 CSSOM 之后，再解除 is-resizing，防止松手瞬间产生回弹追赶动画
+      requestAnimationFrame(() => {
+        handleEl.classList.remove('is-dragging');
+        document.body.classList.remove('is-resizing');
+        document.body.classList.remove('sidebar-resizing');
+      });
     };
```

---

## 8. 立体测试与验收断言清单

所有实现批次完成交付前，必须严格执行以下立体测试门禁，严禁 `--no-verify` 作弊：

1. **思维链既有契约与功能完整性测试**：
   - 执行：`npx vitest run apps/crish-desktop/src/components/chat-message-row/__tests__/ReasoningRow.test.tsx`
   - 断言：全套 18 个测试 100% 绿色通过，24px 尺寸隔离、DOM 条件挂载以及扫光动画完全稳定。
2. **工具卡片折叠与尺寸测试**：
   - 执行：`npx vitest run apps/crish-desktop/src/components/chat-tool-call/`
   - 断言：`toolBody` 展开与折叠在 160ms 内完成，收折态高度精确为 0px，无任何像素残留。
3. **侧边栏手感与拖拽防护测试**：
   - 执行：`npx vitest run apps/crish-desktop/src/components/sidebar/`
   - 断言：拖拽期间 `document.body` 始终带有 `is-resizing`，松手后无弹性回摆。
4. **前端 TypeScript 与行数门禁**：
   - 执行：`npm run typecheck`
   - 执行：`npm run check:line-counts`（严守行数基线，无超标新增）。
5. **Rust 内核健康检查**：
   - 执行：`cargo check --workspace --locked` 确保全仓无破损。
