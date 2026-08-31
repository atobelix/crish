# Conex / Crish — 运行时界面背景偏色、右侧面板点击先灰后白闪烁与容器层级地毯式审计报告

> **报告版本**：v1.0.0  
> **审计日期**：2026-08-30  
> **审计责任域**：前端视觉工程、工作区容器层级架构、Suspense 时序、FOUC 消除、背景底色统一  
> **核心审计范围**：
> - [`apps/crish-desktop/src/components/workspace/RuntimePanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.tsx) & [`RuntimePanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.module.css)
> - [`apps/crish-desktop/src/components/diff/DiffCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx) & [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)
> - [`apps/crish-desktop/src/components/files/FilesCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx) & [`FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css)
> - [`apps/crish-desktop/src/components/overview/OverviewCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx) & [`OverviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css)
> - [`apps/crish-desktop/src/components/workspace/PreviewCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.tsx) & [`PreviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css)
> - [`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx) & [`BinaryTreeWorkspace.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css)
> - [`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx) & [`LeafToolTabStrip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css)
> - [`apps/crish-desktop/src/components/agent-card/AgentCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentCard.module.css)
> - [`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx)（`builtinViewFactories` 懒加载与注入面）
> - [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)（基准色彩契约）

---

## 目录

1. [执行摘要与问题定性](#一执行摘要与问题定性)
2. [运行时界面背景偏色根因深度排查](#二运行时界面背景偏色根因深度排查)
   - 2.1 [根因 1：容器底色语义错配（`--bg-primary` 外壳灰 vs `--bg-card` 卡片白）](#21-根因-1容器底色语义错配--bg-primary-外壳灰-vs---bg-card-卡片白)
   - 2.2 [根因 2：列表项 `.row` 叠加大面积深灰（`--bg-secondary`）制造脏灰感](#22-根因-2列表项-row-叠加大面积深灰--bg-secondary制造脏灰感)
   - 2.3 [根因 3：同类面板（AgentCard）历史样式的同源偏色连带传染](#23-根因-3同类面板agentcard历史样式的同源偏色连带传染)
3. [右侧面板“先变灰再变白”割裂闪烁（FOUC on Switch）地毯式排查](#三右侧面板先变灰再变白割裂闪烁fouc-on-switch地毯式排查)
   - 3.1 [根因 1：`TreeLeafPanel` 的 `Suspense fallback` 硬编码深灰底色（`#eaecee`）](#31-根因-1treeleafpanel-的-suspense-fallback-硬编码深灰底色eaecee)
   - 3.2 [根因 2：`main.tsx` 动态 import 懒加载引发渲染断层（Lazy Exotic Suspension）](#32-根因-2maintosx-动态-import-懒加载引发渲染断层lazy-exotic-suspension)
   - 3.3 [根因 3：两类切换跳闪链路的全过程视觉穿透（A→B 白跳灰再跳白 vs 灰跳深灰再跳白）](#33-根因-3两类切换跳闪链路的全过程视觉穿透)
4. [全量工作区面板与容器层级色彩对照矩阵](#四全量工作区面板与容器层级色彩对照矩阵)
5. [面板次级容器脏灰杂色排查（FilesCard / PreviewCard / LeafToolTabStrip）](#五面板次级容器脏灰杂色排查)
6. [彻底统一背景底板与消除切换跳灰的整改清单](#六彻底统一背景底板与消除切换跳灰的整改清单)
   - 6.1 [整改项 1：统一工作区所有面板基座为卡片白（`var(--bg-card, #ffffff)`）](#61-整改项-1统一工作区所有面板基座为卡片白var--bg-card-ffffff)
   - 6.2 [整改项 2：根除 `TreeLeafPanel` Suspense Fallback 灰底闪烁](#62-整改项-2根除-treeleafpanel-suspense-fallback-灰底闪烁)
   - 6.3 [整改项 3：常用内置视图闲时预热（Prewarming / Zero-Latency Switch）](#63-整改项-3常用内置视图闲时预热prewarming--zero-latency-switch)
   - 6.4 [整改项 4：次级容器发丝边框与微透明背景归一](#64-整改项-4次级容器发丝边框与微透明背景归一)
7. [重构实施清单与验收标准](#七重构实施清单与验收标准)

---

## 一、执行摘要与问题定性

在 Conex / Crish 桌面端工作区交互中，用户明确反馈了两类严重的视觉体验问题：
1. **运行时界面（RuntimePanel）背景与其他工作区面板不统一**：呈现一种发灰、发暗的偏色状态，与右侧其他面板（差异、文件、总览、预览）的纯白卡片感严重割裂；
2. **右侧面板在点击切换时存在肉眼可见的“先变灰、然后再变白”跳闪现象（FOUC on Switch）**：用户反馈“*点击差异也是先变灰，然后再变白，这很割裂啊。我看右侧界面好像都有先变灰再变白的问题。*”

经过对 `RuntimePanel`、`DiffCard`、`FilesCard`、`OverviewCard`、`PreviewCard`、`TreeLeafPanel`、`BinaryTreeWorkspace` 以及 `main.tsx` 视图注册全链路的代码级地毯式审计，确认这两大问题存在**确凿的工程代码根因与容器样式级联错配**。

### 核心审计结论总览：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              问题根因与视觉断层链路全景图                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 【问题 1：运行时偏色】                                                                  │
│  DiffCard / FilesCard / OverviewCard / PreviewCard ──> background: var(--bg-card) (#fff) │
│  RuntimePanel ────────────────────────────────────────> background: var(--bg-primary)  │
│                                                        (#f4f5f7 外壳灰 🚨 语义错配)     │
│                                                                                        │
│ 【问题 2：点击切换先变灰再变白跳闪（FOUC on Switch）】                                  │
│  用户点击标签 (如"差异") ──> React 挂载 Lazy 视图 ──> 触发 TreeLeafPanel Suspense        │
│                                                            │                           │
│                                                            ▼                           │
│                     渲染 fallback: <div className={styles.emptyState}>加载中…</div>     │
│                     CSS 定义: background: var(--bg-secondary) (#eaecee 深灰底 🚨)       │
│                                                            │                           │
│                                                            ▼ (10ms ~ 200ms 后 Chunk 加载)│
│                     DiffCard 挂载完成 ──> 渲染纯白卡片底: var(--bg-card) (#ffffff)        │
│                                                            │                           │
│                                                            ▼                           │
│                     【视觉感知】：纯白(或灰) ──> 突发大面积深灰块(#eaecee) ──> 骤变为纯白   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、运行时界面背景偏色根因深度排查

### 2.1 根因 1：容器底色语义错配（`--bg-primary` 外壳灰 vs `--bg-card` 卡片白）

在 Conex 的色彩 Token 体系规范（[`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L46-L53)）中，各色彩变量有明确的容器语义：
- `--bg-primary: #f4f5f7`：整个应用的最外层外壳背景（Shell / 画板灰）；
- `--bg-card: #ffffff`：工作区内浮起的叶子面板卡片纯白底色（Paper / Card）；
- `--bg-secondary: #eaecee`：侧边栏与辅助层次背景；
- `--bg-elevated: #ffffff`：二叉树 Canvas 与浮动容器卡片纯白底色。

#### 代码实证对照：

1. **[`apps/crish-desktop/src/components/workspace/RuntimePanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.module.css#L1-L15)**：
   ```css
   .panel {
     height: 100%;
     min-height: 0;
     min-width: 0;
     overflow-x: hidden;
     overflow-y: auto;
     overscroll-behavior: contain;
     padding: 10px 12px 14px;
     display: flex;
     flex-direction: column;
     gap: var(--space-3);
     background: var(--bg-primary); /* 🚨 致命错误：直接把外壳灰 #f4f5f7 涂满了卡片内部 */
     box-sizing: border-box;
     -webkit-overflow-scrolling: touch;
   }
   ```

2. **其他所有标准工作区面板的底色定义**：
   - [`DiffCard.module.css:L14`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L14)：`background: var(--bg-card, #ffffff);`
   - [`FilesCard.module.css:L8`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L8)：`background: var(--bg-card, #ffffff);`
   - [`OverviewCard.module.css:L14`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css#L14)：`background: var(--bg-card, #ffffff);`
   - [`PreviewCard.module.css:L8`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L8)：`background: var(--bg-card, #ffffff);`

#### 根因剖析：
`RuntimePanel` 最初开发时，开发者混淆了“工作区外壳背景”与“卡片内部背景”的语义，误将外壳级变量 `--bg-primary`（`#f4f5f7`）赋给了 `.panel`。而上方标签栏 [`LeafToolTabStrip`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L16) 是纯白底色（`background: var(--bg-card, #ffffff)`），导致用户在切换到运行时面板时，上方标签是白底，下方突然切断成一块暗灰底板，产生强烈的视觉断层与偏色感。

---

### 2.2 根因 2：列表项 `.row` 叠加大面积深灰（`--bg-secondary`）制造脏灰感

在 [`apps/crish-desktop/src/components/workspace/RuntimePanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.module.css#L162-L178) 中：
```css
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-secondary); /* 🚨 在 #f4f5f7 底色上再叠 #eaecee 深灰 */
  transition: background var(--transition-micro);
  min-width: 0;
  box-sizing: border-box;
}

.row:hover {
  background: var(--bg-hover);
}
```

#### 对比总览面板（OverviewCard）的高质量排版：
在功能定位高度相似的 [`OverviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css#L72-L86) 中：
- 区段容器 `.sec` 采用 `background: transparent;`；
- 列表项 `.itemBtn`、`.liveRow` 默认采用 `background: transparent;`；
- 仅在用户悬停时使用 `background: var(--bg-hover);`（`color-mix(in srgb, var(--text-primary) 4%, transparent)`）进行轻量反馈。

`RuntimePanel` 采用实体实心深灰底块（`--bg-secondary: #eaecee`）堆叠排布，使得整个界面在暗灰底板（`#f4f5f7`）之上堆砌了密密麻麻的深灰矩形，视觉重心严重下坠，造成整体发黑发脏的观感。

---

### 2.3 根因 3：同类面板（AgentCard）历史样式的同源偏色连带传染

排查发现，不仅 `RuntimePanel`，同样作为工具面板的 [`apps/crish-desktop/src/components/agent-card/AgentCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentCard.module.css#L1-L8) 也存在完全一致的偏色硬伤：
```css
.agentCard {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--shell-inset-bg, var(--bg-primary)); /* 🚨 同样回退至外壳灰 #f4f5f7 */
  color: var(--text-primary);
}

.agentCardLaunch {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--shell-inset-bg, var(--bg-primary)); /* 🚨 同样回退至外壳灰 #f4f5f7 */
}
```
这证明在早期的工具面板开发中，存在将 `--bg-primary` 当作卡片底色的不良范式，必须予以系统性清剿。

---

## 三、右侧面板“先变灰再变白”割裂闪烁（FOUC on Switch）地毯式排查

### 3.1 根因 1：`TreeLeafPanel` 的 `Suspense fallback` 硬编码深灰底色（`#eaecee`）

这是导致用户反馈“*点击差异也是先变灰，然后再变白，这很割裂啊。我看右侧界面好像都有先变灰再变白的问题*”的最直接元凶。

#### 代码证据追踪：

1. **[`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx#L218-L244)**：
   ```tsx
   <AppErrorBoundary compact title={`面板 [${leaf.activeTab}] 渲染异常`}>
     <Suspense
       fallback={<div className={styles.emptyState}>加载中…</div>} {/* 🚨 Suspense 挂载点 */}
     >
       {hasDefinition ? (
         <SlotOutlet
           slotKey="workspace.leaf.panel"
           context={renderCtx}
           entryKey={resolved.definition?.id ?? leaf.activeTab}
           fallback={
             <div className={styles.emptyState}>
               未知面板类型：{leaf.activeTab}
             </div>
           }
         />
       ) : (
         <div className={styles.emptyState}>
           未知面板类型：{leaf.activeTab}
           {isNoteTab ? '（笔记扩展未激活）' : null}
         </div>
       )}
     </Suspense>
   </AppErrorBoundary>
   ```

2. **[`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L400-L417)**：
   ```css
   .emptyState {
     display: flex;
     align-items: center;
     justify-content: center;
     flex: 1 1 0%;
     width: 100%;
     height: 100%;
     min-height: 0;
     color: var(--text-tertiary);
     font-size: var(--font-size-sm);
     background: var(--bg-secondary); /* 🚨 罪魁祸首！--bg-secondary 为 #eaecee (重度深灰) */
     box-sizing: border-box;
     padding: var(--space-4);
     text-align: center;
     user-select: none;
     overflow: hidden;
     -webkit-app-region: no-drag;
   }
   ```

---

### 3.2 根因 2：`main.tsx` 动态 import 懒加载引发渲染断层（Lazy Exotic Suspension）

在 [`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx#L30-L109) 中，所有的内置视图均采用 `React.lazy(() => import(...))` 注入：
```tsx
const builtinViewFactories: ViewFactoryMap = {
  chat: () => lazy(() => import('./components/chat-card/ChatCard').then(...)),
  terminal: () => lazy(() => import('./components/workspace/TerminalCard').then(...)),
  preview: () => lazy(() => import('./components/workspace/PreviewCard').then(...)),
  overview: () => lazy(() => import('./components/overview/OverviewCard').then(...)),
  files: () => lazy(() => import('./components/files/FilesCard').then(...)),
  diff: () => lazy(() => import('./components/diff/DiffCard').then(...)),
  runtime: () => lazy(() => import('./components/workspace/RuntimePanel').then(...)),
  ...
};
```

#### 时序断层机制：
1. 当用户首次点击右侧标签栏中的“差异（Diff）”或其他工具面板时，`activeTab` 变更为 `'diff'`；
2. `SlotOutlet` 挂载 `DiffCard` 的 `LazyExoticComponent`；
3. 由于该 Chunk 尚未完成网络或本地磁盘的加载与执行，React 立即挂起（Suspend）；
4. `TreeLeafPanel` 的 `<Suspense fallback={...}>` 被迫激活，渲染 `.emptyState`；
5. 由于 `.emptyState` 设置了 `background: var(--bg-secondary)`（`#eaecee`），整块区域立即绘制为一个大面积的**实体深灰矩形**；
6. 约 50ms ~ 200ms 后，`DiffCard` Chunk 下载并执行完毕，React 提交新帧并卸载 fallback；
7. `DiffCard` 挂载，渲染出自身的纯白卡片底色（`background: var(--bg-card, #ffffff)`）；
8. **肉眼捕获全过程**：屏幕以极高对比度瞬间从灰跳白，产生极其强烈的“闪瞎感”与卡顿割裂感。

---

### 3.3 根因 3：两类切换跳闪链路的全过程视觉穿透

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        场景 A：白底面板 ──> 白底面板 (例如 Files -> Diff)               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ T0 (0ms)   │ 用户处于 FilesCard 面板，背景为纯白卡片底 (--bg-card: #ffffff)             │
│ T1 (10ms)  │ 用户点击 "差异" 标签，触发 React.lazy 动态加载                              │
│ T2 (20ms)  │ Suspense 激活，瞬间将整块面板涂满 #eaecee 深灰底 (显示"加载中…")           │
│            │ 🚨 界面瞬间变黑/变灰，白底被打断！                                         │
│ T3 (120ms) │ DiffCard 加载完成并渲染，背景瞬间跳回 #ffffff 纯白                         │
│            │ 🚨 界面瞬间泛白，形成【白 -> 灰 -> 白】的极高反差闪烁！                     │
└────────────┴───────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        场景 B：偏色面板 ──> 白底面板 (例如 Runtime -> Diff)             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ T0 (0ms)   │ 用户处于 RuntimePanel，背景为错误的外壳灰 (--bg-primary: #f4f5f7)           │
│ T1 (10ms)  │ 用户点击 "差异" 标签，触发 React.lazy 动态加载                              │
│ T2 (20ms)  │ Suspense 激活，背景变为更深的 #eaecee 灰底 (空态 fallback)                  │
│ T3 (120ms) │ DiffCard 渲染，背景骤变为 #ffffff 纯白                                     │
│            │ 🚨 用户直观感受：面板本来就是灰的，点完继续灰一下，然后啪地一下变成白的！     │
└────────────┴───────────────────────────────────────────────────────────────────────────┘
```

---

## 四、全量工作区面板与容器层级色彩对照矩阵

为了彻底掌握全量面板在底色使用上的混乱现状，以下汇总了右侧工作区所有核心组件的背景色、边框及子元素色值矩阵：

| 组件 / 容器 | 源码文件位置 | 根容器背景色 | 顶部工具栏背景色 | 列表/内容区背景色 | 审计定性与问题标记 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **工作区外壳** | [`BinaryTreeWorkspace.module.css:L28`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L28) | `var(--bg-workspace, var(--bg-primary))` (`#f4f5f7`) | 无 | 无 | ✅ 符合外壳画板语义 |
| **画布大卡片** | [`BinaryTreeWorkspace.module.css:L51`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L51) | `var(--bg-elevated, var(--bg-card))` (`#ffffff`) | 无 | 无 | ✅ 符合大矩形纯白容器语义 |
| **叶子 Suspense Fallback** | [`BinaryTreeWorkspace.module.css:L410`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L410) | `var(--bg-secondary)` (`#eaecee`) | 无 | `color: var(--text-tertiary)` | ❌ **严重违规**：导致切换跳灰闪烁 |
| **工具标签栏 (TabStrip)** | [`LeafToolTabStrip.module.css:L16`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L16) | `var(--bg-card, #ffffff)` | `var(--bg-card, #ffffff)` | 激活标签 `var(--bg-card)` | ✅ 符合卡片顶部纯白统一规范 |
| **差异面板 (DiffCard)** | [`DiffCard.module.css:L14`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L14) | `var(--bg-card, #ffffff)` | `var(--bg-card, #ffffff)` | `var(--bg-card)` | ✅ 标准纯白卡片规范 |
| **文件面板 (FilesCard)** | [`FilesCard.module.css:L8`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L8) | `var(--bg-card, #ffffff)` | `var(--bg-card, #ffffff)` | `var(--bg-card)` | ⚠️ 根容器正确，但内部 contextBar 混用灰底 |
| **总览面板 (OverviewCard)** | [`OverviewCard.module.css:L14`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css#L14) | `var(--bg-card, #ffffff)` | 无 | `transparent` + hover tint | ✅ 标准纯白卡片规范 |
| **预览浏览器 (PreviewCard)** | [`PreviewCard.module.css:L8`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L8) | `var(--bg-card, #ffffff)` | `var(--bg-card, #ffffff)` | `var(--bg-card)` | ✅ 标准纯白卡片规范 |
| **运行时面板 (RuntimePanel)** | [`RuntimePanel.module.css:L12`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.module.css#L12) | `var(--bg-primary)` (`#f4f5f7`) | 无 | `.row` 为 `var(--bg-secondary)` (`#eaecee`) | ❌ **严重违规**：背景整体偏色、发灰发暗 |
| **智能体面板 (AgentCard)** | [`AgentCard.module.css:L6`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentCard.module.css#L6) | `var(--shell-inset-bg, var(--bg-primary))` (`#f4f5f7`) | `var(--bg-card, #ffffff)` | `transparent` | ❌ **严重违规**：容器底板偏色 |
| **终端面板 (TerminalCard)** | [`TerminalCard.module.css:L9`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TerminalCard.module.css#L9) | `var(--terminal-bg)` (`#eaecee`) | `var(--terminal-bar-fill)` | `var(--terminal-bg)` | ℹ️ 终端控制台特定暗调设计（受控） |

---

## 五、面板次级容器脏灰杂色排查

除了主容器与 Suspense fallback 外，各面板内部还潜藏了若干处次级容器的 `--bg-primary`（`#f4f5f7`）污染，必须一并治理：

### 5.1 [`FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css) 内部灰底
- **文件预览上下文栏**（Line 506）：
  ```css
  .filesContextBar {
    ...
    background: var(--bg-primary); /* 🚨 在纯白卡片中间切出一道 #f4f5f7 灰带 */
    border-bottom: 1px solid var(--hairline, var(--border-subtle));
  }
  ```
- **PDF 预览背景**（Line 245）：`.filesPreviewPdf { background: var(--bg-primary); }`
- **面包屑下拉搜索框**（Line 356）：`.filesBcFlyoutSearch { background: var(--bg-primary); }`

### 5.2 [`PreviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css) 内部灰底
- **历史记录面板**（Line 480）：`.histPanel { background: var(--bg-primary); }`
- **快捷本地地址胶囊**（Line 454）：`.quickChip { background: var(--bg-primary); }`

### 5.3 [`LeafToolTabStrip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css) 内部灰底
- **二级导航条**（Line 357）：`.toolbar { background: var(--bg-primary); }`
- **空态启动台容器**（Line 418）：`.launcherHubWrapper { background: var(--bg-primary); }`
- **启动台卡片**（Line 458）：`.launcherCard { background: var(--bg-primary); }`

---

## 六、彻底统一背景底板与消除切换跳灰的整改清单

为了彻底根治“运行时界面发灰偏色”与“右侧面板切换时先灰后白跳闪”，提出以下 4 项系统性整改措施：

### 6.1 整改项 1：统一工作区所有面板基座为卡片白（`var(--bg-card, #ffffff)`）

#### 1. 改造 `RuntimePanel.module.css`：
- 将 `.panel` 的 `background` 由 `var(--bg-primary)` 纠正为 `var(--bg-card, #ffffff)`；
- 改造 `.row` 列表项，取消实心深灰底 `var(--bg-secondary)`，改为标准透明底板：
  ```css
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 6px 8px;
    border-radius: var(--radius-md);
    background: transparent; /* 改为透明底 */
    transition: background var(--transition-micro);
    min-width: 0;
    box-sizing: border-box;
  }

  .row:hover {
    background: var(--bg-hover); /* 柔和悬停微色 */
  }
  ```
- 将分界线由 `border-bottom: 1px solid var(--tint-active)` 统一为 `border-bottom: 1px solid var(--border-subtle)`。

#### 2. 改造 `AgentCard.module.css`：
- 将 `.agentCard` 与 `.agentCardLaunch` 的 `background` 由 `var(--shell-inset-bg, var(--bg-primary))` 纠正为 `var(--bg-card, #ffffff)`。

---

### 6.2 整改项 2：根除 `TreeLeafPanel` Suspense Fallback 灰底闪烁

#### 1. 改造 `BinaryTreeWorkspace.module.css` 中的 `.emptyState`：
- 拔除 `background: var(--bg-secondary);`（`#eaecee` 脏灰）；
- 统一设为 `background: var(--bg-card, #ffffff);`（或 `transparent`），与卡片纯白底色完全融合：
  ```css
  .emptyState {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 0%;
    width: 100%;
    height: 100%;
    min-height: 0;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
    background: var(--bg-card, #ffffff); /* 🌟 纯白卡片底，彻底告别深灰跳变 */
    box-sizing: border-box;
    padding: var(--space-4);
    text-align: center;
    user-select: none;
    overflow: hidden;
    -webkit-app-region: no-drag;
  }
  ```

#### 2. 改造 `TreeLeafPanel.tsx` 的 Suspense Fallback 结构：
提供无文本干扰、纯净无缝的轻量占位容器（`LeafPanelLoadingFallback`），在加载期间保持与目标卡片一致的视觉底板：
```tsx
const LeafPanelFallback: React.FC = () => (
  <div className={styles.emptyState} aria-busy="true" aria-label="加载中">
    {/* 仅呈现极淡的微弱微光或极简转圈，零深灰背景，零突兀大字 */}
    <div className={`loading-spinner ${styles.spinner}`} aria-hidden />
  </div>
);
```

---

### 6.3 整改项 3：常用内置视图闲时预热（Prewarming / Zero-Latency Switch）

为了将切换面板时的 Suspense 概率降为 0%，在应用启动后的 `idleTask`（[`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx#L285-L301)）中，添加对核心工具视图 Chunk 的**空闲预加载（Prewarm）**：

```ts
// main.tsx -> startup() -> idleTask
const idleTask = () => {
  // 1. 预加载核心后台服务
  import('./bootstrap-full')
    .then((m) => m.bootstrapFull())
    .catch((e) => { ... });

  // 2. 🌟 预热常用右侧工具视图 Chunk，彻底消除用户首次点击时的 Suspense 停顿
  const prewarmViews = () => {
    void import('./components/diff/DiffCard');
    void import('./components/files/FilesCard');
    void import('./components/overview/OverviewCard');
    void import('./components/workspace/PreviewCard');
    void import('./components/workspace/RuntimePanel');
  };

  if ('requestIdleCallback' in window) {
    requestIdleCallback(prewarmViews, { timeout: 3000 });
  } else {
    setTimeout(prewarmViews, 1500);
  }
};
```

---

### 6.4 整改项 4：次级容器发丝边框与微透明背景归一

对各面板内部偶发使用的 `--bg-primary` 次级容器进行统一清洗：
- [`FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L506)：将 `.filesContextBar` 的 `background: var(--bg-primary);` 替换为 `background: var(--bg-card);`，与文件树和编辑区融为一体；
- [`LeafToolTabStrip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L357)：将 `.toolbar`、`.launcherHubWrapper` 的 `background: var(--bg-primary);` 替换为 `background: var(--bg-card);`；
- [`PreviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L480)：将 `.histPanel` 的 `background: var(--bg-primary);` 替换为 `background: var(--bg-card);`。

---

## 七、重构实施清单与验收标准

### 7.1 涉及修改的文件清单

1. [`apps/crish-desktop/src/components/workspace/RuntimePanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.module.css)：
   - 修改 `.panel` 的 `background` 为 `var(--bg-card, #ffffff)`；
   - 修改 `.row` 的 `background` 为 `transparent`，`:hover` 为 `var(--bg-hover)`；
   - 统一边框为 `var(--border-subtle)`。
2. [`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css)：
   - 修改 `.emptyState` 的 `background` 为 `var(--bg-card, #ffffff)`。
3. [`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx)：
   - 优化 `Suspense` 的 fallback 结构与呈现样式。
4. [`apps/crish-desktop/src/components/agent-card/AgentCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentCard.module.css)：
   - 修改 `.agentCard` 与 `.agentCardLaunch` 的 `background` 为 `var(--bg-card, #ffffff)`。
5. [`apps/crish-desktop/src/components/files/FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css)：
   - 修改 `.filesContextBar`、`.filesBcFlyoutSearch` 等次级背景为纯白/卡片标准色。
6. [`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css)：
   - 修改 `.toolbar`、`.launcherHubWrapper` 背景为卡片白。
7. [`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx)：
   - 在 `idleTask` 中加入核心内置视图 Chunk 的空闲预加载。

### 7.2 验收标准（Checklist）

- [ ] **运行时底色统一**：切换到“运行时（RuntimePanel）”时，面板背景底色为纯白（`#ffffff`），与总览（OverviewCard）、文件（FilesCard）、差异（DiffCard）完全一致，无任何发灰、发暗或偏色；
- [ ] **切换零跳灰（Zero Gray-Flash）**：在右侧标签栏快速来回点击“差异”、“代码产物”、“总览”、“运行时”、“应用预览”，无论网络快慢或首次加载，中间**绝不出现哪怕一帧**的深灰矩形色块（`#eaecee`）闪烁；
- [ ] **容器发丝线和谐**：各面板内部的次级横条（如 FilesCard 上下文栏、TabStrip 工具条）均平滑融入纯白底板，仅依靠发丝线（`var(--border-subtle)`）做克制分割；
- [ ] **暗色模式（Dark Mode）自适应**：在暗色模式下，`--bg-card` 正确映射为暗色卡片底（`#131316`），Fallback 与面板内容色阶完全吻合，无反向闪白。
