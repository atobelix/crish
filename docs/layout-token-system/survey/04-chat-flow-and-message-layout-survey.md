# 会话消息流与消息卡片内外边距调研报告

> **战役工作区**：`docs/layout-token-system/survey/`
> **报告编号**：04
> **调研主题**：桌面端会话消息流单一滚动容器、消息行内部盒模型、DEF-13 垂直节奏、气泡与元数据内外边距全景调研
> **调研日期**：2026-09-11
> **调研员**：系统性 Token 体系建设战役 · 会话消息流与消息卡片内外边距调研员
> **状态**：已完成（基于真实代码事实与行号取证）

---

## 目录

- [一、调研背景与核心问题综述](#一调研背景与核心问题综述)
- [二、单一滚动容器契约与列宽控制体系](#二单一滚动容器契约与列宽控制体系)
  - [2.1 滚动容器与包含块层级关系（DIM-02 §1.1）](#21-滚动容器与包含块层级关系dim-02-11)
  - [2.2 列宽约束与多重防御性重复声明](#22-列宽约束与多重防御性重复声明)
  - [2.3 容器内边距双轨定义与门禁测试断裂事实](#23-容器内边距双轨定义与门禁测试断裂事实)
- [三、DEF-13 纯净垂直节奏落地情况与几何稳定性](#三def-13-纯净垂直节奏落地情况与几何稳定性)
  - [3.1 历史缺陷根因：1600px 累积高度蒸发黑洞](#31-历史缺陷根因1600px-累积高度蒸发黑洞)
  - [3.2 DEF-13 内部盒模型解决方案与几何等式](#32-def-13-内部盒模型解决方案与几何等式)
  - [3.3 现状代码审计：盒模型垂直间距硬编码暴露](#33-现状代码审计盒模型垂直间距硬编码暴露)
- [四、边距例外与负 Margin 补丁全景审查](#四边距例外与负-margin-补丁全景审查)
  - [4.1 搜索高亮行 `.row.searchHit` 的负 Margin 与高度突变补丁](#41-搜索高亮行-rowsearchhit-的负-margin-与高度突变补丁)
  - [4.2 零高度贴底卡槽与浮钮 `.chatScrollFab` 的负 Margin 抽离](#42-零高度贴底卡槽与浮钮-chatscrollfab-的负-margin-抽离)
  - [4.3 散落在消息行子元素中的裸 Margin 与 Gap](#43-散落在消息行子元素中的裸-margin-与-gap)
- [五、消息行内部组件的边距与圆角契约漂移](#五消息行内部组件的边距与圆角契约漂移)
  - [5.1 用户气泡 `.userBubble`：内边距硬编码与 16px/12px 圆角契约严重背离](#51-用户气泡-userbubble内边距硬编码与-16px12px-圆角契约严重背离)
  - [5.2 助手消息体 `.assistantBody`：纯净画纸流与相对 em 排版机制](#52-助手消息体-assistantbody纯净画纸流与相对-em-排版机制)
  - [5.3 元数据操作栏失衡：用户 28px vs 助手 22px 高度撕裂](#53-元数据操作栏失衡用户-28px-vs-助手-22px-高度撕裂)
  - [5.4 推理卡片 `.reasoningRow`：24px 硬件级尺寸隔离与展开态补偿间距](#54-推理卡片-reasoningrow24px-硬件级尺寸隔离与展开态补偿间距)
  - [5.5 僵尸 CSS 产物：已移除的 `.pinnedBar` 残留百行无用样式](#55-僵尸-css-产物已移除的-pinnedbar-残留百行无用样式)
- [六、Token 体系建设分层重构建议与门禁演进](#六token-体系建设分层重构建议与门禁演进)
  - [6.1 消息流与卡片 3 层 Token 架构设计](#61-消息流与卡片-3-层-token-架构设计)
  - [6.2 几何 SSOT 统一与 CSS/TS 双轨消除方案](#62-几何-ssot-统一与-cssts-双轨消除方案)
  - [6.3 刚性样式门禁扩展建议](#63-刚性样式门禁扩展建议)

---

## 一、调研背景与核心问题综述

在 Conex / Crish 桌面端应用中，会话消息流（Chat Stream）是人机交互的最高频核心主视口。随着多次架构演进（从早期简单卡片流，到 DIM-01/02 纯净画纸架构，再到 DEF-13/14 虚拟滚动盒模型重构），会话流在排版、边距、列宽与性能隔离上取得了显著进步。

然而，在深入源码审查中发现，当前消息流体系仍存在四大深层隐患：
1. **几何 SSOT 断层**：虚拟滚动切片逻辑通过 TypeScript 常量（`chatScrollGeometry.ts`）维护滚动容器的几何内边距，而 CSS 文件（`ChatMessageList.module.css`）仍硬编码写死 `padding: 48px 20px 16px`，导致现有门禁测试 `VirtualScrollGeometryContract.test.ts` 处于持续红灯失败状态；
2. **负 Margin 视觉补偿补丁**：搜索高亮行 `.row.searchHit` 采用 `margin-left: -6px; margin-right: -6px; width: calc(100% + 12px)` 的负 margin 补丁实现视觉外扩，不仅引入了横向溢出风险，更在行状态切换时突增 `padding-top: 4px` 破坏了虚拟滚动的物理高度恒定性；
3. **圆角与尺寸契约严重漂移**：用户气泡写着 `border-radius: var(--radius-xl, 16px)`，但 `:root` 的 `--radius-xl` 实质为 `12px`，导致 fallback 16px 永远无法生效，开发者心理预期与真实物理渲染产生 4px 严重断裂；
4. **内部微元素魔术数字泛滥**：从 2px、4px、5px 到 7px，大量非 Token 裸数值散落在时间戳、操作栏、推理卡片与钉选浮层中，缺乏统一的数学基底。

本报告对上述问题展开全景取证与机理透视，为后续系统性 Token 体系建设提供精确的事实基石。

---

## 二、单一滚动容器契约与列宽控制体系

### 2.1 滚动容器与包含块层级关系（DIM-02 §1.1）

在 Conex 的桌面端主视图中，滚动容器的归属与层次必须严格收敛，严禁出现多重内嵌 `overflow: auto` 导致的双滚动条与手势死锁。

```
ChatCard (.chatBody, overflow: hidden)
  └── .chatDocFlow (overflow: hidden, flex: 1)
        └── .streamHost (ChatMessageList.module.css:2-11, position: relative, flex: 1)
              ├── [data-chat-scroll-container] (ChatMessageList.module.css:14-28, overflow-y: auto)
              │     ├── .listInner (ChatMessageList.module.css:31-40, max-width: min(var(--chat-col-max, 760px), 100%))
              │     │     └── [data-chat-slice-container] (position: absolute, top: 48px, left: 20px, right: 20px)
              │     │           └── 消息行切片流 (.row)
              │     └── .floorSlot (ChatScrollFloorSlot.module.css:4-20, position: sticky, bottom: 0, height: 0)
              └── FlowScrubber (.wrapper, FlowScrubber.module.css:3-13, position: absolute, right: 14px)
```

#### 代码事实取证

1. **宿主定位包含块**：
   [`ChatMessageList.module.css:2-11`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css#L2-L11)：
   ```css
   .streamHost {
     position: relative;
     flex: 1;
     min-height: 0;
     width: 100%;
     align-self: stretch;
     display: flex;
     flex-direction: column;
     min-width: 0;
   }
   ```
   `.streamHost` 承载叶 scroller（滚动列表）以及右侧刻度条 `FlowScrubber`。其自身 `overflow` 保持默认可见，不承担滚动职责。

2. **唯一合法滚动容器**：
   [`ChatMessageList.module.css:14-28`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css#L14-L28)：
   ```css
   .list,
   :global([data-chat-scroll-container]) {
     width: 100%;
     max-width: none;
     min-width: 0;
     margin: 0;
     align-self: stretch;
     box-sizing: border-box;
     flex: 1;
     min-height: 0;
     overflow-y: auto;
     overflow-x: hidden;
     overflow-anchor: none;
     position: relative;
   }
   ```
   该容器通过 `:global([data-chat-scroll-container])` 属性选择器向整个会话视口广播 DIM-02 §1.1 规范：**它是当前会话树内唯一的 `overflow-y: auto` 滚动视口**。容器通过 `overflow-anchor: none` 刚性阻断 Chromium 默认的滚动锚定跳动。

---

### 2.2 列宽约束与多重防御性重复声明

为了确保在不同视口宽度下文本的可读性（避免一行文字过长导致视觉扫视疲劳），系统设计了居中最大列宽机制：

```css
/* apps/crish-desktop/src/styles/tokens.css:691-692 */
--chat-col-max: 760px;
--chat-col-max-wide: 840px;
```

#### 列宽控制实现位置与冗余度审查

| 文件路径与行号 | 选择器 | 宽度约束声明 | 媒体查询响应 (<=720px / >=1200px) |
| :--- | :--- | :--- | :--- |
| `ChatMessageList.module.css:33` | `.listInner` | `max-width: min(var(--chat-col-max, 760px), 100%); margin: 0 auto;` | 720px: `100%`; 1200px: `min(var(--chat-col-max-wide, 840px), 100%)` |
| `ChatMessageRow.module.css:12` | `.row` | `max-width: min(var(--chat-col-max, 760px), 100%); margin: 0 auto;` | 720px: `100%`; 1200px: `min(var(--chat-col-max-wide, 840px), 100%)` |
| `ChatMessageRow.module.css:50` | `.rowAssistant` | `max-width: min(var(--chat-col-max, 760px), 100%);` | 1200px: `min(var(--chat-col-max-wide, 840px), 100%)` |
| `ChatCard.module.css:45` | `.chatCol` | `max-width: min(var(--chat-col-max, 760px), 100%); margin: 0 auto;` | 无媒体查询覆盖 |
| `ChatScrollFloorSlot.module.css:16` | `.floorSlot` | `max-width: min(var(--chat-col-max, 760px), 100%); margin: 0 auto;` | 无媒体查询覆盖 |
| `narrative.module.css:36` | `.plan` | `max-width: min(var(--chat-col-max, 760px), 100%); margin: 0 auto;` | 无媒体查询覆盖 |

#### 架构问题诊断

1. **多重防御性嵌套声明**：
   `.listInner` 作为所有消息行的直接父级栅格容器，已经通过 `max-width: min(var(--chat-col-max, 760px), 100%)` 与 `margin: 0 auto` 锁死了内部可用列宽。然而，其子组件 `.row`、`.rowAssistant` 以及 `.plan` 依然机械式地重复声明了完全相同的 `max-width` 与 `margin`。
2. **媒体查询断层**：
   `.listInner` 与 `.row` 在 1200px 时会切换到 `--chat-col-max-wide: 840px`，但位于同一流中的 `.floorSlot`（底部回底卡槽）和 `.chatCol`（空态列）却没有响应该媒体查询，当大屏展开至 1200px 以上时，回底卡槽与消息列表右边缘会出现 `(840 - 760) / 2 = 40px` 的视觉脱节！

---

### 2.3 容器内边距双轨定义与门禁测试断裂事实

#### 真实代码矛盾事实

在 `ChatMessageList.module.css:36` 中：
```css
.listInner {
  width: 100%;
  max-width: min(var(--chat-col-max, 760px), 100%);
  margin-left: auto;
  margin-right: auto;
  padding: 48px 20px 16px; /* 顶部 48px，左右 20px，底部 16px */
  box-sizing: border-box;
  min-width: 0;
  overflow-anchor: none;
}
```

而在几何统一源文件 [`chatScrollGeometry.ts:5-8`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/chatScrollGeometry.ts#L5-L8) 中：
```typescript
export const CHAT_SCROLL_PAD_TOP = 48;
export const CHAT_SCROLL_PAD_BOTTOM = 16;
export const CHAT_SCROLL_PAD_X = 20;

export function chatSpacerHeight(contentHeight: number): number {
  const h = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  return CHAT_SCROLL_PAD_TOP + h + CHAT_SCROLL_PAD_BOTTOM;
}
```

并在 [`MessageVirtualizer.tsx:422-432`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx#L422-L432) 中消费：
```tsx
<div
  data-chat-slice-container=""
  style={{
    position: 'absolute',
    top: CHAT_SCROLL_PAD_TOP,
    left: CHAT_SCROLL_PAD_X,
    right: CHAT_SCROLL_PAD_X,
    transform: `translateY(${startOffset}px)`,
    overflowAnchor: 'none',
  }}
>
```

#### 现存门禁测试断裂实测

运行测试命令：
```powershell
npx vitest run apps/crish-desktop/src/components/chat-message-list/__tests__/VirtualScrollGeometryContract.test.ts
```

测试执行结果：
```
FAIL apps/crish-desktop/src/components/chat-message-list/__tests__/VirtualScrollGeometryContract.test.ts
  × 1. ChatMessageList.module.css 契约：消除相邻兄弟外边距黑洞 (DEF-13) > .listInner 禁止纵向 padding（几何 SSOT 归 chatScrollGeometry）
    → expected listCss not to match /\.listInner\s*\{[^}]*padding:\s*48px/
```

#### 深度原理解析

1. **测试断言的初衷**：
   在虚拟滚动架构中，消息切片容器 `[data-chat-slice-container]` 是 `position: absolute` 绝对定位的。绝对定位的元素脱离了普通文档流，**根本不会受到父容器普通 CSS padding 的挤压推移**。
   因此，虚拟滚动计算模型（`VirtualScrollManager`）要求将顶部 48px 与底部 16px 纳入总虚拟高度（`chatSpacerHeight = 48 + h + 16`），并直接将切片容器设为 `top: 48px`。
   为了保证几何单一真理（SSOT），测试契约刚性规定：**`.listInner` 的 CSS 中绝不允许出现纵向 padding（`padding: 48px ...` 或 `padding-top: 48px`），否则会导致双重内边距计算模型混乱！**
2. **实际现状**：
   由于历史遗留，`ChatMessageList.module.css:36` 的 `padding: 48px 20px 16px;` 依然残留在生产代码中。
   - 这不仅使得自动化门禁持续报错拦截；
   - 且三个尺寸值 `48px`、`20px`、`16px` 全是纯裸写魔术数字，未关联系统 Token（如 `--space-12`、`--space-5`、`--space-4`）；
   - 一旦未来样式人员在 CSS 中修改了 `padding: 40px`，而未同步修改 TS 常量 `CHAT_SCROLL_PAD_TOP`，整个虚拟滚动的定位与回底锚点就会全面漂移脱节。

---

## 三、DEF-13 纯净垂直节奏落地情况与几何稳定性

### 3.1 历史缺陷根因：1600px 累积高度蒸发黑洞

在早期 DIM-01 版本中，消息行垂直间距是依靠相邻兄弟选择器实现的：
```css
/* 历史代码（已废弃） */
[data-chat-list-inner] > :not([hidden]) + :not([hidden]) {
  margin-top: 16px;
}
```

#### 致命的黑洞产生机制

1. **浏览器测量 API 的盲区**：
   在 DOM 盒模型中：
   - `Element.offsetHeight` = `contentHeight + paddingTop + paddingBottom + borderTop + borderBottom`；
   - `ResizeObserver.contentRect.height` = `contentHeight`；
   - **两者 100% 排除外部 `margin`！**
2. **累积蒸发灾难**：
   当会话列表中有 100 条消息时，每一行之间在真实屏幕上存在 16px 的 `margin-top`，总高度包含 `100 × 16px = 1600px` 的外部边距。
   然而，`VirtualScrollManager`（VSM）通过 `ResizeObserver` 或 `el.offsetHeight` 度量每行高度并存入树状数组时，得到的度量值完全没有包含这 16px。
   当用户滚动视口导致前 100 条消息被卸载并替换为虚拟占位 Spacer（`[data-vsm-spacer]`）时，Spacer 的高度等于 VSM 实测累积高度，导致 **整整 1600px 的物理高度瞬间在页面中凭空消失！** 视口产生不可逆的剧烈跳动、触底震荡与滚动条抽搐。

---

### 3.2 DEF-13 内部盒模型解决方案与几何等式

为了彻底根除上述黑洞，工程团队推行了 **DEF-13（纯净垂直节奏体系）**。

#### 核心治理原则

1. **彻底消除外部 Margin**：所有消息行根节点外部 `margin-top: 0; margin-bottom: 0;`；
2. **下沉为内部盒模型**：行与行之间的呼吸间距，全部收敛为行容器内部底边距 `padding-bottom`；
3. **统一度量入口**：`ResizeObserver` 使用 `el.offsetHeight` 作为单一物理高度源。

```
旧模型（兄弟 Margin 黑洞）：
┌──────────────────────────────────────┐
│ 行 1 (offsetHeight: 80px)            │
└──────────────────────────────────────┘
   ▲ 外部 margin-top: 16px (VSM 度量不到！)
┌──────────────────────────────────────┐
│ 行 2 (offsetHeight: 80px)            │
└──────────────────────────────────────┘

新模型（DEF-13 内部盒模型恒等）：
┌──────────────────────────────────────┐
│ 行 1 内容 (80px)                     │
│ 内部 padding-bottom: 16px            │ ──► offsetHeight ≡ 96px (VSM 精确度量 96px)
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ 行 2 内容 (80px)                     │
│ 内部 padding-bottom: 16px            │ ──► offsetHeight ≡ 96px (VSM 精确度量 96px)
└──────────────────────────────────────┘
```

#### 几何恒等式推导

$$\text{DOM Physical Height} = \text{contentHeight} + \text{paddingBottom}$$
$$\text{VSM Measured Height (el.offsetHeight)} = \text{contentHeight} + \text{paddingBottom}$$
$$\Delta \text{Height (Black Hole)} = \text{DOM Physical Height} - \text{VSM Measured Height} \equiv 0\text{px}$$

---

### 3.3 现状代码审计：盒模型垂直间距硬编码暴露

在 [`ChatMessageRow.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css) 中，DEF-13 的落地代码如下：

#### 1. 普通消息行（用户消息 `.rowUser` / 助手消息 `.rowAssistant`）
[`ChatMessageRow.module.css:6-8`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L6-L8)：
```css
.row {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin-top: 0;
  margin-bottom: 0;
  padding-bottom: 16px; /* 内部盒模型接管垂直节奏 */
  contain: layout paint;
  /* ... */
}
```
**问题**：`padding-bottom: 16px;` 直接写死数值 `16px`，未引用 `var(--space-4, 16px)` 或语义 Token `--chat-row-gap: 16px`。

#### 2. 纯状态微提示载体消息（`.rowCarrier`）
[`ChatMessageRow.module.css:61-71`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L61-L71)：
```css
.rowCarrier {
  align-items: center;
  justify-content: center;
  width: 100%;
  margin: 0;
  padding: 0 0 4px; /* 紧凑 4px 发丝节奏 */
  background: transparent;
  border: none;
  box-shadow: none;
}
```
**问题**：`padding: 0 0 4px;` 写死数值 `4px`，未引用 `var(--space-1, 4px)` 或语义 Token `--chat-row-gap-compact: 4px`。

#### 3. 滚动边界外边距
[`ChatMessageRow.module.css:17-18`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L17-L18)：
```css
scroll-margin-top: 56px;
scroll-margin-bottom: var(--space-4);
```
**问题**：同一代码块内出现严重的规范分裂——`scroll-margin-bottom` 使用了 Token `var(--space-4)`，而 `scroll-margin-top` 却裸写 `56px`（56px 为顶部导航条与呼吸区的经验值叠加）。

---

## 四、边距例外与负 Margin 补丁全景审查

在整个消息卡片和流布局中，代码审查发现了数处使用负 margin（Negative Margin）进行视觉位置补偿的「飞线补丁」，以及零散裸写的外边距数值。

### 4.1 搜索高亮行 `.row.searchHit` 的负 Margin 与高度突变补丁

#### 代码事实
[`ChatMessageRow.module.css:25-37`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L25-L37)：
```css
.row.searchHit {
  background: color-mix(in srgb, var(--accent-color) 8%, transparent);
  border-radius: var(--radius-xl);
  padding-top: 4px;
  padding-bottom: 16px;
  padding-left: 6px;
  padding-right: 6px;
  margin-left: -6px;
  margin-right: -6px;
  width: calc(100% + 12px);
  max-width: calc(min(var(--chat-col-max, 760px), 100%) + 12px);
  box-sizing: border-box;
}
```

#### 深度危害诊断

1. **负 Margin 弥补内边距的「补丁式设计」**：
   开发者为了让命中的搜索高亮背景在左右两侧向外延伸 6px（避免文字紧贴有色背景边缘），采用了 `margin-left: -6px; margin-right: -6px; width: calc(100% + 12px);`。
   - 这违反了反过度设计与反补丁纪律；
   - 在移动端或极端窄屏（视口宽度 100%）时，左右扩展 6px 会导致该行直接冲破父容器 `.listInner` 设定的栅格边界，引发潜在的水平滚动晃动；
2. **破坏物理高度恒定性（重大缺陷）**：
   观察普通 `.row` 与 `.row.searchHit` 的纵向 padding 对比：
   - 普通 `.row`：`padding-top: 0; padding-bottom: 16px;`
   - 高亮 `.row.searchHit`：`padding-top: 4px; padding-bottom: 16px;`

   这意味着：**当用户在搜索框输入关键词并命中某行消息时，该行物理 `offsetHeight` 瞬间人为增加了 4px！**
   虽然 `MessageVirtualizer` 的 `ResizeObserver` 最终能捕获到该 4px 的突变，但在搜索结果高亮切换的高频交互中，连续的高亮行会导致虚拟滚动树状数组发生密集失效（`invalidateActual`）和重测回写，产生轻微的视觉颠簸。

---

### 4.2 零高度贴底卡槽与浮钮 `.chatScrollFab` 的负 Margin 抽离

#### 代码事实
[`ChatScrollFloorSlot.module.css:4-32`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatScrollFloorSlot.module.css#L4-L32)：
```css
.floorSlot {
  position: sticky;
  bottom: 0;
  height: 0;
  max-height: 0;
  width: 100%;
  pointer-events: none;
  z-index: 8;
  display: flex;
  justify-content: flex-end;
  box-sizing: border-box;
  overflow: visible;
  max-width: min(var(--chat-col-max, 760px), 100%);
  margin-left: auto;
  margin-right: auto;
  padding-right: 18px; /* 注意：这里是 18px，而非 20px */
}

.chatScrollFab {
  margin-top: -46px; /* 使用负 margin 向上反向抽离自身可视高度 */
  width: 34px;
  height: 34px;
  border-radius: 50%;
  /* ... */
}
```

#### 审查发现

1. **负 Margin 抽离高度原理**：
   `.floorSlot` 声明为 `height: 0; max-height: 0;`，其技术目的是为了保证卡槽在文档流中完全不占空间（$\Delta\text{scrollHeight} \equiv 0$）。回底按钮（FAB）本身有 34px 高度，通过 `margin-top: -46px` 将自身向上提拉，使其浮在距离容器底部约 $46 - 34 = 12\text{px}$ 的位置。
2. **与栅格列边距的 2px 错位**：
   前文已知主列容器 `.listInner` 的水平内边距是 `20px`（`CHAT_SCROLL_PAD_X = 20`）。
   但 `.floorSlot` 的右内边距却写成了 `padding-right: 18px;`！
   这导致回底浮钮的右侧基准线与消息流右边缘出现了 **2px 的微小几何偏移**，没有实现严格的垂直对齐闭环。

---

### 4.3 散落在消息行子元素中的裸 Margin 与 Gap

在组件树的内部，散落着未经 Token 化治理的硬编码间距。以下为全量抽查事实汇总：

| 文件路径与行号 | 元素/类名 | 属性与代码 | 问题诊断 |
| :--- | :--- | :--- | :--- |
| `ChatMessageRow.module.css:192` | `.userMeta` | `gap: 2px;` | 裸数字 2px，应为 `var(--space-0_5)` |
| `ChatMessageRow.module.css:194` | `.userMeta` | `margin-top: var(--space-1, 4px);` | 声明了 fallback 4px，但同组其他属性未 token 化 |
| `ChatMessageRow.module.css:213` | `.time` | `margin-right: 4px;` | 裸数字 4px，应为 `var(--space-1)` |
| `ChatMessageRow.module.css:233` | `.planApproveRow` | `margin: var(--space-2, 8px) 0 var(--space-0_5, 2px);` | 混合型 fallback，缺乏语义定义 |
| `ChatMessageRow.module.css:803` | `.timelineTools` | `margin: 2px 0;` | 裸外边距 2px，工具调用嵌入流时直接破坏纯净内部盒模型 |
| `ChatMessageRow.module.css:106` | `.userAttachmentStrip` | `gap: 8px; padding: 2px 0;` | 裸数字 8px 与 2px，未引用 `--space-2` / `--space-0_5` |
| `ChatMessageRow.module.css:912` | `.pinPickerPopover` | `gap: 6px; padding: 5px;` | 奇数/偶数魔术数字混杂，非标准 4px 栅格基底 |
| `ChatMessageRow.module.css:1011` | `.pinCustomPanel` | `gap: 7px;` | 出现 7px 奇数间距，完全脱轨于设计系统 |
| `ChatMessageRow.module.css:1120` | `.pinCustomValueRow`| `gap: 5px; padding: 2px 7px 2px 4px;` | 散落 5px、7px、2px、4px，典型的魔术数字补丁拼凑 |
| `ReasoningRow.module.css:82` | `.statusDot` | `margin-right: 5px;` | 5px 裸数值，偏离标准 4px 栅格 |
| `ReasoningRow.module.css:115` | `.dotSeparator` | `margin: 0 4px;` | 4px 裸数值，应为 `var(--space-1)` |
| `ReasoningRow.module.css:253` | `.reasoningActions` | `margin-bottom: 4px;` | 4px 裸数值 |

---

## 五、消息行内部组件的边距与圆角契约漂移

### 5.1 用户气泡 `.userBubble`：内边距硬编码与 16px/12px 圆角契约严重背离

用户消息气泡作为对话流中最典型的实体卡片，存在最突出的设计契约漂移。

#### 代码事实
[`ChatMessageRow.module.css:118-144`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L118-L144)：
```css
.userBubble {
  background: color-mix(in srgb, var(--text-primary) 3.9%, var(--bg-card));
  color: var(--text-primary);
  border: none;
  border-radius: var(--radius-xl, 16px); /* 致命契约冲突点 */
  padding: 10px 14px;                     /* 硬编码内边距 */
  font-size: var(--font-size-base, 14px);
  font-weight: var(--font-weight-normal);
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: break-word;
  box-shadow: none;
  width: fit-content;
  max-width: min(85%, 720px);
  min-width: min-content;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  user-select: text;
  /* ... */
}
```

#### 核心契约漂移事实（重大问题）

1. **`border-radius: var(--radius-xl, 16px);` 的欺骗性假象**：
   - 开发者在此处的意图明显是为气泡赋予 **16px** 的大圆角，因此在 fallback 中明确写上了 `16px`；
   - 但是，我们查阅系统全局 Token 权威文件 [`tokens.css:311`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L311)：
     ```css
     --radius-xl: 12px;
     ```
   - 并且在紧凑档与宽松档中（`tokens.css:1263, 1320`）：
     ```css
     /* ui-size compact: */ --radius-xl: 10px;
     /* ui-size comfortable: */ --radius-xl: 14px;
     ```
   - **结论**：因为 `:root` 已经全局定义了 `--radius-xl: 12px`，CSS 变量解析器匹配到了有效值，**fallback 的 `16px` 在任何情况下都绝对不可能生效！** 用户气泡在实际渲染中呈现的是 **12px** 圆角。这种「代码写着 16px 但实际跑着 12px」的背离，严重污染了设计契约的透明度。
2. **内边距 `padding: 10px 14px;` 缺乏 Token 化**：
   - 上下 10px 对应 `--space-2_5`，左右 14px 对应 `--space-3_5`；
   - 此处既未使用 Token，也未遵循常规 4px/8px 栅格（如常见的 8px/12px 或 12px/16px 组合）；
3. **宽度与对齐约束的双重冗余**：
   - 在外层父级 `.userStack` 中定义了：`max-width: min(85%, 720px);`（ChatMessageRow.module.css:90）；
   - 在气泡自身 `.userBubble` 又重复定义了：`max-width: min(85%, 720px);`（ChatMessageRow.module.css:132）；
   - 在媒体查询 720px 下又篡改定义：`.userStack, .userBubble { max-width: min(82%, 100%); }`（ChatMessageRow.module.css:858）。
   这种在多层 DOM 上并列约束百分比的做法，造成了高度耦合与样式维护的脆弱性。

---

### 5.2 助手消息体 `.assistantBody`：纯净画纸流与相对 em 排版机制

与用户气泡的独立「实体卡片」盒模型截然相反，助手消息体采用了「纯净画纸流（Flat Paper Flow）」。

#### 代码事实
[`ChatMessageRow.module.css:218-227`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L218-L227)：
```css
.assistantBody {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
```

#### 助手内部 Markdown 排版节奏分析

助手正文完全不设置内边距（`padding: 0; gap: 0;`），其垂直节奏由内部流式 Markdown 块接管：
- 段落底边距：`margin: 0 0 var(--md-text-paragraph-gap, 0.85em) 0;`（行 300）；
- 文本块底边距：`margin-bottom: 0.65em;`（行 263）；
- 尾随标题时的收紧间距：`margin-bottom: 0.28em;`（行 272，通过 `:has` 选择器精准收紧，杜绝标题与下文空行脱节）；
- 代码块间距：`margin: 0.85em 0;`（行 512）；
- 引用块间距：`margin: var(--md-quote-margin, 0.6em 0);`（行 489）。

**技术总结**：助手消息体大量使用基于 `font-size` 的相对单位 `em`（0.85em, 0.65em, 0.28em）。这种做法在文本排版领域是优雅且自适应的，但与外层容器使用的绝对像素（px）体系缺乏数学桥接，导致从外层容器（16px）向内层文本流（0.85em ≈ 11.9px）过渡时没有统一的层级节律。

---

### 5.3 元数据操作栏失衡：用户 28px vs 助手 22px 高度撕裂

在消息卡片的底部，均附带了时间戳、复制、编辑/重试、钉选等交互按钮（`MessageActionsBar`）。

#### 代码事实对比

| 对比维度 | 用户操作栏 `.userMeta` | 助手操作栏 `.assistantMeta` |
| :--- | :--- | :--- |
| **源码位置** | `ChatMessageRow.module.css:189-199` | `ChatMessageRow.module.css:696-708` |
| **最小高度** | `min-height: 28px;` | `min-height: 22px;` |
| **外顶间距** | `margin-top: var(--space-1, 4px);` | `margin-top: var(--space-1);` |
| **内部 Gap** | `gap: 2px;` | `gap: var(--space-0_5);` |
| **按钮尺寸** | `.iconBtn`: `width: 28px; height: 28px;` | `.iconBtn`: `width: 28px; height: 28px;` |
| **按钮圆角** | `border-radius: var(--button-radius, 7px);` | `border-radius: var(--button-radius, 7px);` |

#### 深度架构缺陷

1. **视觉高度不对称（28px vs 22px）**：
   用户消息元数据栏高度设为 `min-height: 28px`，以便与 28×28 的操作按钮等高；
   而助手消息元数据栏却写成了 `min-height: 22px`！
   然而，助手栏内部使用的按钮也是 `.iconBtn`（28px 高度）。当悬浮激活显示按钮时，助手栏实际会被撑大到 28px，在无按钮与有按钮之间产生 **6px 的高度突变抖动**！
2. **按钮圆角契约再次漂移（8px vs 7px）**：
   `.iconBtn` 声明为 `border-radius: var(--button-radius, 7px);`。
   但在全局 `tokens.css:22` 中：
   ```css
   --button-radius: 8px;
   ```
   而在 `tokens.css:306` 中又定义了：`--radius-btn: 7px;`。
   这里的 fallback 7px 与全局 `--button-radius: 8px` 再次产生冲突，导致按钮圆角在不同上下文下可能在 7px 与 8px 之间跳动。

---

### 5.4 推理卡片 `.reasoningRow`：24px 硬件级尺寸隔离与展开态补偿间距

推理思维链行（DIM-03 §1.1）是消息流中极为关键的流式交互节点。

#### 代码事实
[`ReasoningRow.module.css:14-48, 233-244`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css)：

1. **未展开态（24px 严格尺寸隔离）**：
   ```css
   .reasoningContainer:not([data-expanded='true']) {
     contain: size layout;
     height: 24px;
     min-height: 24px;
     max-height: 24px;
     box-sizing: border-box;
     overflow: hidden;
   }
   .reasoningRow {
     height: 24px;
     padding: 0 var(--space-1, 4px);
     /* ... */
   }
   ```
   这一设计极为优雅：在流式生成期间，未展开的思考行被严格死锁在 24px，完全切断流式文字产生的高频回流，保护虚拟滚动的绝对稳定。

2. **展开态的补偿内边距补丁**：
   ```css
   .reasoningBody {
     width: 100%;
     max-width: 100%;
     box-sizing: border-box;
     padding: 4px 0 8px calc(var(--space-1, 4px) + 2px);
     overflow: visible;
   }
   ```
   **审查发现**：
   左内边距声明为了 `calc(var(--space-1, 4px) + 2px)`（即 6px）。
   这是因为未展开态按钮有 `4px` 内边距，展开后的正文为了与按钮文本视觉垂直对齐，人工加了 `2px` 的魔术数字微调补偿。这种 `calc(var(...) + 2px)` 是典型的由于缺少基准对其 Token 而产生的微观几何补丁。

---

### 5.5 僵尸 CSS 产物：已移除的 `.pinnedBar` 残留百行无用样式

在审查 `ChatMessageList.module.css` 时，发现了一个重大的工程死代码（Dead CSS）事实：

#### 事实取证

1. 在 [`ChatMessageList.module.css:52-167`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css#L52-L167) 中，定义了大量关于已固定消息栏（Pinned Bar）的样式：
   - `.pinnedBar`
   - `.pinnedBarToggle`
   - `.pinnedChevron`
   - `.pinnedList`
   - `.pinnedItem`
   - `.pinnedJump`
   - `.pinnedRole`
   - `.pinnedSnippet`
   - `.pinnedUnpin`
   - 以及行 181 的 `:global([data-perf-tier='eco']) .pinnedBar`。
   **整整占据了 116 行 CSS 代码！**
2. 检索整个 `apps/crish-desktop/src` 代码库：
   在 `MessageVirtualizer.tsx` 或任何其他 TSX 文件中，**完全没有任何 JSX 节点在使用这些类名！**
   通过 Git 历史溯源发现，早在多轮重构中，固定消息交互已经全面迁移为滚动条右侧的无轨刻度组件 [`FlowScrubber.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx)，顶部的吸顶 `pinnedBar` 已经被彻底拔除。
3. **结论**：这 116 行样式属于未清理干净的僵尸代码，其内部定义的 `padding: 7px 10px`、`border-radius: 7px` 等老旧魔术数字继续污染着 CSS 命名空间。

---

## 六、Token 体系建设分层重构建议与门禁演进

基于上述深度事实调研，针对会话消息流与消息卡片内外边距，提出以下系统性治理重构建议：

### 6.1 消息流与卡片 3 层 Token 架构设计

建立严格的三层 Token 映射体系，杜绝组件层裸写魔术数字与私自加法补偿：

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Primitive Tokens (基础数学标尺，4px 栅格倍数)                 │
│ --space-0_5: 2px;  --space-1: 4px;   --space-1_5: 6px;  --space-2: 8px;│
│ --space-2_5: 10px; --space-3: 12px;  --space-3_5: 14px; --space-4: 16px│
│ --space-5: 20px;   --space-12: 48px;                                   │
│ --radius-sm: 4px;  --radius-md: 6px; --radius-lg: 8px;  --radius-xl:16px│
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ 语义化绑定
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Layer 2: Semantic Flow Layout Tokens (会话流与栅格语义)                 │
│ --chat-col-max: 760px;                                                 │
│ --chat-col-max-wide: 840px;                                            │
│ --chat-stream-pad-top: var(--space-12, 48px);                          │
│ --chat-stream-pad-bottom: var(--space-4, 16px);                        │
│ --chat-stream-pad-x: var(--space-5, 20px);                             │
│ --chat-row-gap-normal: var(--space-4, 16px);    /* DEF-13 核心节拍 */  │
│ --chat-row-gap-compact: var(--space-1, 4px);   /* 微提示核心节拍 */  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ 组件层绑定
┌──────────────────────────────────▼─────────────────────────────────────┐
│ Layer 3: Component Surface Tokens (气泡与卡片表面契约)                 │
│ --chat-bubble-pad-y: var(--space-2_5, 10px);                           │
│ --chat-bubble-pad-x: var(--space-3_5, 14px);                           │
│ --chat-bubble-radius: var(--radius-xl, 16px);   /* 修复 12px 漂移 */   │
│ --chat-meta-min-height: 28px;                   /* 统一定格 28px */    │
│ --chat-reasoning-height: 24px;                  /* 统一定格 24px */    │
│ --chat-search-hit-inset: var(--space-1_5, 6px);                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 6.2 几何 SSOT 统一与 CSS/TS 双轨消除方案

1. **消除双轨断裂**：
   - 彻底修复 `VirtualScrollGeometryContract.test.ts` 拦截失败的问题；
   - 方案 A（推荐）：将 `.listInner` 的纵向 `padding: 48px 20px 16px` 正式剥离为 `padding: 0 20px;`，纵向 padding 100% 移交 `chatScrollGeometry.ts` 与切片绝对定位容器接管，实现样式与测试契约的绝对统一；
   - 方案 B：若保留 CSS 纵向 padding，则切片容器不再使用 `top: 48px`，并同步更新测试断言与 VSM 坐标映射。
2. **清除僵尸代码**：
   - 全面清退 `ChatMessageList.module.css` 中 116 行未消费的 `.pinnedBar` 系列样式，实现样式表的净收敛。
3. **消除搜索高亮行的负 Margin 与 4px 突变**：
   - 废除 `.row.searchHit` 的 `margin-left: -6px; margin-right: -6px; width: calc(100% + 12px);`；
   - 改为通过 `outline` / 柔和 `box-shadow` 或在 `.listInner` 预留全局安全内衬，杜绝高亮行向外侵入；
   - 严禁在 `.searchHit` 态增加 `padding-top: 4px`，确保高亮与非高亮态的盒模型物理高度 $\Delta H \equiv 0$。
4. **统一操作栏元数据高度**：
   - 将助手消息栏 `.assistantMeta` 的 `min-height: 22px` 纠正统一为 `min-height: 28px`，与 `.userMeta` 及按钮物理高度 28px 对齐，杜绝 hover 时的视口跳跃。

---

### 6.3 刚性样式门禁扩展建议

在后续门禁建设中，建议将以下规则作为自动化 Lint / AST 校验规则：

1. **负 Margin 拦截红线**：
   禁止在消息流行元素（`.row*`）及其子组件中定义负数值的 `margin`（`margin: -*`），特殊基础设施（如回底浮钮）必须加注豁免标识；
2. **行内盒模型完整性校验**：
   持续维护 `VirtualScrollGeometryContract.test.ts`，确保所有进入虚拟滚动的行容器必须声明 `margin: 0` 且行间距必须通过 `padding-bottom` 承载；
3. **圆角 Token 漂移静态拦截**：
   扫描所有 CSS 模块，严禁出现 `var(--radius-xl, 16px)` 这类 fallback 数值与 `:root` 定义矛盾的代码模式；
4. **统一魔术数字阈值拦截**：
   在 CSS 模块中禁止裸写 `padding` / `margin` 为 `2px`、`5px`、`7px`、`10px`、`14px` 等数值，强制走 `var(--space-*)` 标尺。

---

## 结论

本调研报告彻底摸清了 Conex / Crish 桌面端消息流与卡片排版中的结构现状：
- DEF-13 内部盒模型架构方向完全正确，成功解决了 1600px 累积高度蒸发黑洞，具有坚实的几何稳定基础；
- 但由于历史重构节奏不一致，产生了 **`.listInner` 纵向 padding 残留导致门禁断裂**、**搜索高亮行负 margin 与 4px 突发高度**、**用户气泡 16px 与 12px 圆角契约严重背离** 以及 **116 行僵尸 pinnedBar CSS** 等关键债务；
- 建议在第二阶段方案制定中，依托三层 Token 体系彻底收口几何 SSOT，拔除负 margin 补丁，实现会话流布局的工业级整洁度与严密性。
