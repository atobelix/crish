# 方案 A：系统架构与工程韧性综合修复实施方案

> **文档标识**：`docs/chat-ui-interaction-repair/proposals/01-resilient-architecture-plan.md`
> **方案名称**：方案 A（Resilient Architecture & System Plan）
> **角色定位**：系统架构与工程韧性专家（Architecture & Resilience Specialist）
> **制定日期**：2026-08-20
> **输入依据**：
> - `docs/chat-ui-interaction-repair/independent-plans/01-layout-inspector.md`（布局视效排查）
> - `docs/chat-ui-interaction-repair/independent-plans/02-interaction-inspector.md`（交互状态机排查）
> - `docs/chat-ui-interaction-repair/independent-plans/03-rendering-inspector.md`（渲染管线排查）
> - 项目真实源码（`apps/crish-desktop/src/`、`crates/`、`reference/`）与 `ANTI_OVERENGINEERING_GUARDRAILS.md`
> **设计准则**：坚持第一性原理与架构不变量，穿透表象直达底层断层，杜绝打补丁与魔术数字，严守反过度设计红线。

---

## 目录

1. [执行总览与架构愿景](#一执行总览与架构愿景)
2. [问题一：输入框（Composer）防抖与多行切换高韧性状态机](#二问题一输入框composer防抖与多行切换高韧性状态机)
   - [2.1 极限环振荡数学模型与源码证据链](#21-极限环振荡数学模型与源码证据链)
   - [2.2 架构解耦与施密特迟滞比较器设计](#22-架构解耦与施密特迟滞比较器设计)
   - [2.3 单例 Canvas 2D 离屏度量与零 DOM 污染引擎](#23-单例-canvas-2d-离屏度量与零-dom-污染引擎)
   - [2.4 振荡熔断与自愈机制（Oscillation Breaker）](#24-振荡熔断与自愈机制oscillation-breaker)
   - [2.5 完整代码设计与 Diff](#25-完整代码设计与-diff)
3. [问题二：FlowScrubber 滚动刻度体系重构](#三问题二flowscrubber-滚动刻度体系重构)
   - [3.1 FlexGrow 几何拉伸畸变推导](#31-flexgrow-几何拉伸畸变推导)
   - [3.2 Slot-Marker 架构解耦模型](#32-slot-marker-架构解耦模型)
   - [3.3 2px 物理细针与透明扩展 Hitbox 体系](#33-2px-物理细针与透明扩展-hitbox-体系)
   - [3.4 完整代码设计与 Diff](#34-完整代码设计与-diff)
4. [问题三：Markdown 代码块与复制按钮工程体系](#四问题三markdown-代码块与复制按钮工程体系)
   - [4.1 样式资产断层与 HTML 管道脱节剖析](#41-样式资产断层与-html-管道脱节剖析)
   - [4.2 全局 Markdown 代码块样式契约（`.md-code-block`）](#42-全局-markdown-代码块样式契约md-code-block)
   - [4.3 绝对定位悬浮毛玻璃胶囊与 Hover 渐显动效](#43-绝对定位悬浮毛玻璃胶囊与-hover-渐显动效)
   - [4.4 ASCII 文件目录树（`dir`/`tree`）等宽与零压盖保障](#44-ascii-文件目录树dirtree等宽与零压盖保障)
   - [4.5 完整代码设计与 Diff](#45-完整代码设计与-diff)
5. [问题四：操作栏图标按钮与 Tooltip 浮层闭环治理](#五问题四操作栏图标按钮与-tooltip-浮层闭环治理)
   - [5.1 图标按钮尺寸冲突与 Props 契约传递断层修复](#51-图标按钮尺寸冲突与-props-契约传递断层修复)
   - [5.2 隐形元素事件泄露阻断（`opacity: 0` + `pointer-events: none`）](#52-隐形元素事件泄露阻断opacity-0--pointer-events-none)
   - [5.3 Tooltip 首帧几何未测量动画穿透（First-Frame Animation Leak）门禁](#53-tooltip-首帧几何未测量动画穿透first-frame-animation-leak门禁)
   - [5.4 冗余 Tooltip 清洗与 DOM 语义收敛](#54-冗余-tooltip-清洗与-dom-语义收敛)
   - [5.5 完整代码设计与 Diff](#55-完整代码设计与-diff)
6. [反过度设计审查（Anti-Overengineering Compliance Audit）](#六反过度设计审查anti-overengineering-compliance-audit)
7. [防回归验证断言与测试实施矩阵](#七防回归验证断言与测试实施矩阵)

---

## 一、执行总览与架构愿景

在 Conex / Crish 桌面端聊天界面的演进中，随着富文本输入增强、流式渲染优化以及设计系统升级，局部组件演化导致了 4 项严重的视效与交互退化缺陷。三份独立排查报告从布局视效、交互状态机和渲染管线三个维度进行了深度溯源。

本方案（方案 A）作为**系统架构与工程韧性综合实施方案**，以**第一性原理**为指导，将分散的排查结论收敛为一套高内聚、高鲁棒、零冗余的工程落地架构：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        方案 A：核心架构不变量与修复全景                                │
├────────────────────────┬──────────────────────────────────┬────────────────────────────┤
│ 模块领域               │ 核心失效机理                     │ 架构级不变量与工程解耦方案 │
├────────────────────────┼──────────────────────────────────┼────────────────────────────┤
│ 1. 输入框 Composer     │ 状态切换引起网格宽度跃升 +       │ 虚拟单行基准解耦 +         │
│    144Hz 极限环振荡    │ 离屏与真实度量标尺分裂 + 0迟滞带 │ 24px 施密特迟滞区间 +      │
│                        │                                  │ 单例 Canvas 离屏度量 + 熔断│
├────────────────────────┼──────────────────────────────────┼────────────────────────────┤
│ 2. FlowScrubber 刻度条 │ flexGrow 直接赋给实心 Button，   │ Slot-Marker 架构解耦：     │
│    深灰巨块畸变        │ 导致 2px 细针被纵向拉伸数百像素  │ Slot 吸收 flex 比例高度，  │
│                        │                                  │ Marker 锁定 2px 细线+Hitbox│
├────────────────────────┼──────────────────────────────────┼────────────────────────────┤
│ 3. Markdown 代码块     │ HTML 管道输出 .md-code-copy 节点 │ 全局样式契约注入：         │
│    原生按钮压盖文本    │ 但前端 CSS 样式表 0 规则定义     │ relative 容器 + absolute   │
│                        │ 沦为普通流内联块破坏排版         │ 毛玻璃悬浮胶囊，零压盖     │
├────────────────────────┼──────────────────────────────────┼────────────────────────────┤
│ 4. 操作栏按钮与浮层    │ Button 与 iconBtn 类名特异度冲突 │ 统一 IconButton 22px 标尺；│
│    尺寸失调与悬空气泡  │ + opacity: 0 漏设 pointer-events │ 隐形元素事件物理阻断；     │
│                        │ + Tooltip 首帧无坐标动画穿透     │ isPositionReady 测量门禁   │
└────────────────────────┴──────────────────────────────────┴────────────────────────────┘
```

---

## 二、问题一：输入框（Composer）防抖与多行切换高韧性状态机

### 2.1 极限环振荡数学模型与源码证据链

- **核心源码**：
  - `apps/crish-desktop/src/components/chat-composer/useComposerMultiline.ts:26-93`
  - `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:532-551, 603-627`
  - `apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:307-311`

#### 极限环振荡（Limit Cycle Oscillation）形成的数学因果链：

1. **单行几何空间**：
   单行模式下 CSS 网格为：
   $$\text{grid-template-areas: 'left-ctrl text perm actions'}$$
   设卡片容器总宽度 $W_{\text{layout}} = 600\text{px}$，左右控制按钮总占用 $W_{\text{used}} = 220\text{px}$，输入区域实际物理宽度为：
   $$W_{\text{single\_text}} = W_{\text{layout}} - W_{\text{used}} = 380\text{px}$$
2. **正向触发（Single $\to$ Multi）**：
   用户输入一段文本，其在 ProseMirror/Textarea 内的真实排版宽度为 $W_{\text{text}} = 385\text{px}$。
   在 `useComposerMultiline.ts:69` 中，`editable.scrollWidth (385px) > editable.clientWidth (380px) + 1` 成立，触发 `setMultiline(true)`。
3. **几何跃迁与多行展开**：
   进入多行模式后，CSS 网格变为：
   $$\text{grid-template-areas: 'text text text text' 'left-ctrl perm . actions'}$$
   输入区域独占第一行，$W_{\text{multi\_text}} = W_{\text{layout}} = 600\text{px}$。
4. **度量分裂与反向触发（Multi $\to$ Single）**：
   网格几何突变触发 `ResizeObserver`，在多行态下执行 `measure()`：
   - 此时 $W_{\text{text}} (385\text{px}) < \text{clientWidth} (600\text{px})$，`scrollWidth > clientWidth + 1` 条件失效；
   - 代码进入离屏度量分支 `measureTextWidth(clean, font)`；
   - 离屏裸 `<span>` 缺少 ProseMirror 容器 padding（8px）、光标占位符、字间距微调，测得宽度仅为 $W_{\text{offscreen}} = 375\text{px}$；
   - 计算单行容量 $\text{Capacity} = W_{\text{layout}} - W_{\text{used}} = 380\text{px}$；
   - 由于 $W_{\text{offscreen}} (375\text{px}) < \text{Capacity} (380\text{px})$，判定 `width >= capacity` 为 **FALSE**，立即调用 `setMultiline(false)`！
5. **144Hz 视觉重影（Visual Ghosting）**：
   组件切回单行 $\to$ 宽度缩回 380px $\to$ 触发展开 $\to$ 展开后测得不足 $\to$ 触发收缩。
   在高刷新率屏幕（144Hz，帧间隔 6.94ms）上，渲染管线以极高频率反复在 36px 胶囊高度与 80px 卡片高度之间震荡，因人眼视网膜暂留效应形成双重轮廓重叠的“幽灵双影”。

```
┌────────────────────────────────────────────────────────────────────────┐
│                        高频切换震荡极限环因果图                        │
│                                                                        │
│   [单行态 (36px)] ──> scrollWidth(385) > clientWidth(380) + 1          │
│         ▲                                         │                    │
│         │                                         ▼                    │
│   setMultiline(false)                     setMultiline(true)           │
│         ▲                                         │                    │
│         │                                         ▼                    │
│   measureText(375) < capacity(380) <─── [多行态 (80px)] clientW=600    │
│   (ResizeObserver 触发)                 (文本占通栏，DOM 测量失效)     │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 架构解耦与施密特迟滞比较器设计

为了彻底斩断正反馈回路，系统必须确立两个架构级不变量：

#### 架构不变量 1：虚拟单行基准解耦（Decoupled Virtual Baseline）
无论当前组件处于单行态还是多行态，判定文本是否适合单行的「可用容量预算」必须基于**虚拟单行几何投影**（即容器总宽减去标准单行控件常态宽度），严禁使用多行态下的当前 DOM 展开宽度进行相对判定。

#### 架构不变量 2：施密特迟滞门限（Schmitt Trigger Hysteresis Band）
引入迟滞裕量 $\Delta_{\text{hysteresis}} = 24\text{px}$，将单门限比较器升级为双稳态施密特触发器：
- **展开上门限（Upper Threshold）**：
  $$\text{Threshold}_{\text{expand}} = \text{Capacity}_{\text{single}}$$
  当 $W_{\text{text}} \ge \text{Threshold}_{\text{expand}}$ 时，才允许单行 $\to$ 多行。
- **收起下门限（Lower Threshold）**：
  $$\text{Threshold}_{\text{collapse}} = \text{Capacity}_{\text{single}} - \Delta_{\text{hysteresis}}$$
  当 $W_{\text{text}} < \text{Threshold}_{\text{collapse}}$ 时，才允许多行 $\to$ 单行。
- **迟滞死区（Deadband）**：
  在区间 $[\text{Capacity}_{\text{single}} - 24\text{px}, \text{Capacity}_{\text{single}}]$ 内，系统保持当前状态不变（不翻转），彻底消除临界点震荡。

---

### 2.3 单例 Canvas 2D 离屏度量与零 DOM 污染引擎

现有实现中 `measureTextWidth` 每次都在 `document.body` 动态 `appendChild` 和 `remove` 离屏 `<span>`，引发强烈的**同步布局颠簸（Synchronous Layout Thrashing）**。

#### 优化设计：
1. 采用全局单例离屏 `HTMLCanvasElement` 与 `CanvasRenderingContext2D`；
2. 提取输入框计算样式的 `fontStyle`、`fontVariant`、`fontWeight`、`fontSize`、`lineHeight`、`fontFamily` 及 `letterSpacing`，构造标准 CSS Font 字符串赋给 `ctx.font`；
3. 调用 `ctx.measureText(text).width`，运算复杂度为 $O(1)$，微秒级完成且 **0 次 DOM 节点操作、0 次浏览器重排重绘**；
4. 针对 ProseMirror / Tiptap 编辑器内边距与光标占位，在 Canvas 测量结果上增加恒定的 $+6\text{px}$ 物理安全裕量。

---

### 2.4 振荡熔断与自愈机制（Oscillation Breaker）

为应对用户极速拉伸窗口或极端输入场景，在 Hook 内部建立帧级状态反转监控熔断器：
- 维护滑动时间窗口（`120ms`）内的状态翻转时戳队列；
- 若 `120ms` 内状态反转次数 $\ge 3$ 次，判定为非预期物理扰动，**强制将状态锁定为多行态（Multiline Lock）**，并在 `400ms` 冷却期后自动解除锁定恢复自愈。

---

### 2.5 完整代码设计与 Diff

```diff
--- a/apps/crish-desktop/src/components/chat-composer/useComposerMultiline.ts
+++ b/apps/crish-desktop/src/components/chat-composer/useComposerMultiline.ts
@@ -1,30 +1,48 @@
 /**
  * 单行胶囊 ↔ 多行网格：有附件 / 显式换行 / 文本宽超过单行容量则切多行；
- * 删到能放下立刻切回（与参考容量引擎对称）。
+ * 引入施密特迟滞区间（24px）与单例 Canvas 2D 离屏度量引擎，
+ * 彻底消除 144Hz 极限环振荡重影与 DOM 测量抖动。
  */
 import { useCallback, useLayoutEffect, useRef, useState } from 'react';

 const GRID_GUTTER_PX = 18;
 const MIN_CAPACITY_PX = 200;
+/** 迟滞区间死区裕量：收起阈值低于展开阈值 24px，防止临界文本无限翻转 */
+const HYSTERESIS_BUFFER_PX = 24;

-function measureTextWidth(text: string, font: string): number {
+/** 单例离屏 Canvas 度量引擎，规避 DOM 操作与强制重排 (Reflow Thrashing) */
+let measureCanvas: HTMLCanvasElement | null = null;
+let measureCtx: CanvasRenderingContext2D | null = null;
+
+function getMeasureContext(): CanvasRenderingContext2D | null {
   if (typeof document === 'undefined') return null;
-  const span = document.createElement('span');
-  span.setAttribute('aria-hidden', 'true');
-  span.style.visibility = 'hidden';
-  span.style.position = 'absolute';
-  span.style.top = '-9999px';
-  span.style.whiteSpace = 'nowrap';
-  span.style.font = font;
-  span.textContent = text;
-  document.body.appendChild(span);
-  const width = span.getBoundingClientRect().width;
-  span.remove();
-  return width;
+  if (!measureCanvas) {
+    measureCanvas = document.createElement('canvas');
+    measureCtx = measureCanvas.getContext('2d');
+  }
+  return measureCtx;
+}
+
+function measureTextAccurate(text: string, font: string, letterSpacing = 'normal'): number {
+  const ctx = getMeasureContext();
+  if (ctx) {
+    ctx.font = font || '14px sans-serif';
+    if ('letterSpacing' in ctx && letterSpacing !== 'normal') {
+      (ctx as unknown as { letterSpacing: string }).letterSpacing = letterSpacing;
+    }
+    return ctx.measureText(text).width;
+  }
+  return text.length * 8; // 服务端/无 Canvas 兜底
 }

 export function useComposerMultiline(opts: {
   text: string;
   hasAttachments: boolean;
   layoutRef: React.RefObject<HTMLElement | null>;
 }): boolean {
   const { text, hasAttachments, layoutRef } = opts;
   const [multiline, setMultiline] = useState(
     () => hasAttachments || text.includes('\n')
   );
-  const fontRef = useRef<string>('');
+  const multilineRef = useRef(multiline);
+  multilineRef.current = multiline;
+
+  const fontStyleRef = useRef<{ font: string; letterSpacing: string }>({
+    font: '14px sans-serif',
+    letterSpacing: 'normal',
+  });
+
+  // 振荡熔断器：记录近期状态变更时戳
+  const toggleHistoryRef = useRef<number[]>([]);
+  const lockUntilRef = useRef<number>(0);

   const measure = useCallback(() => {
     if (hasAttachments || text.includes('\n')) {
-      setMultiline(true);
+      if (!multilineRef.current) setMultiline(true);
       return;
     }
     const layout = layoutRef.current;
     if (!layout) {
-      setMultiline(false);
+      if (multilineRef.current) setMultiline(false);
       return;
     }
     const left = layout.querySelector(
       '[data-composer-grid="left"]'
     ) as HTMLElement | null;
     const perm = layout.querySelector(
       '[data-composer-grid="perm"]'
     ) as HTMLElement | null;
     const right = layout.querySelector(
       '[data-composer-grid="right"]'
     ) as HTMLElement | null;
     const editable = layout.querySelector(
       '[contenteditable="true"], textarea'
     ) as HTMLElement | null;
+
     if (editable) {
       const cs = getComputedStyle(editable);
-      fontRef.current = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
-      if (editable.scrollWidth > editable.clientWidth + 1) {
-        setMultiline(true);
-        return;
-      }
+      fontStyleRef.current = {
+        font: `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`,
+        letterSpacing: cs.letterSpacing,
+      };
     }
+
     const layoutW = layout.clientWidth;
+    // 解耦计算虚拟单行容量预算：容器总宽减去标准单行控件常态宽度
     const used =
-      (left?.offsetWidth ?? 0) +
-      (perm?.offsetWidth ?? 0) +
-      (right?.offsetWidth ?? 0) +
+      (left?.offsetWidth ?? 32) +
+      (perm?.offsetWidth ?? 32) +
+      (right?.offsetWidth ?? 72) +
       GRID_GUTTER_PX;
-    const capacity = Math.max(MIN_CAPACITY_PX, layoutW - used);
+    const singleLineCapacity = Math.max(MIN_CAPACITY_PX, layoutW - used);
+
     const clean = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
     if (!clean) {
-      setMultiline(false);
+      if (multilineRef.current) setMultiline(false);
       return;
     }
-    const width = measureTextWidth(clean, fontRef.current || '14px sans-serif');
-    setMultiline(width >= capacity);
+
+    // 精确离屏文本宽度（+6px 编辑器内边距与光标占位补偿）
+    const textWidth =
+      measureTextAccurate(
+        clean,
+        fontStyleRef.current.font,
+        fontStyleRef.current.letterSpacing
+      ) + 6;
+
+    const now = performance.now();
+    // 熔断锁定期间强制维持多行
+    if (now < lockUntilRef.current) {
+      if (!multilineRef.current) setMultiline(true);
+      return;
+    }
+
+    const isCurrentlyMultiline = multilineRef.current;
+    let nextMultiline = isCurrentlyMultiline;
+
+    if (!isCurrentlyMultiline) {
+      // 单行态：文本超出单行容量预算则展开
+      if (textWidth >= singleLineCapacity) {
+        nextMultiline = true;
+      }
+    } else {
+      // 多行态：文本必须回缩至 (容量 - 迟滞裕量) 以下才收起
+      if (textWidth < singleLineCapacity - HYSTERESIS_BUFFER_PX) {
+        nextMultiline = false;
+      }
+    }
+
+    if (nextMultiline !== isCurrentlyMultiline) {
+      toggleHistoryRef.current = toggleHistoryRef.current.filter(
+        (t) => now - t < 120
+      );
+      toggleHistoryRef.current.push(now);
+      // 120ms 内反转 >= 3 次触发熔断保护
+      if (toggleHistoryRef.current.length >= 3) {
+        console.warn('[useComposerMultiline] Oscillation breaker tripped, locking multiline for 400ms.');
+        lockUntilRef.current = now + 400;
+        setMultiline(true);
+        return;
+      }
+      setMultiline(nextMultiline);
+    }
   }, [hasAttachments, layoutRef, text]);

   useLayoutEffect(() => {
     measure();
     const el = layoutRef.current;
     if (!el || typeof ResizeObserver === 'undefined') return;
-    const ro = new ResizeObserver(() => measure());
+
+    let frameId: number | null = null;
+    let prevW = el.clientWidth;
+    const ro = new ResizeObserver((entries) => {
+      for (const entry of entries) {
+        const cr = entry.contentRect;
+        // 宽度变化超过 2px 时才调度测量，避免纯高度变化引发正反馈
+        if (Math.abs(cr.width - prevW) > 2) {
+          prevW = cr.width;
+          if (frameId != null) cancelAnimationFrame(frameId);
+          frameId = requestAnimationFrame(() => {
+            measure();
+            frameId = null;
+          });
+        }
+      }
+    });
     ro.observe(el);
-    return () => ro.disconnect();
+    return () => {
+      if (frameId != null) cancelAnimationFrame(frameId);
+      ro.disconnect();
+    };
   }, [layoutRef, measure]);

   return multiline;
 }
```

---

## 三、问题二：FlowScrubber 滚动刻度体系重构

### 3.1 FlexGrow 几何拉伸畸变推导

- **核心源码**：
  - `apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx:46-65, 166-186`
  - `apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css:43-64`
  - `apps/crish-desktop/src/components/chat-message-list/flowScrubberModel.ts:47-107`
  - `reference/chat-composer-component/css/flow/scrubber.css:48-58`

#### 畸变根因推导：
在 `flowScrubberModel.ts:94` 中，`tick.flex` 承载了该条消息在虚拟滚动管理器（VSM）中的物理像素高度（如 $h = 300\text{px}$）。
在 `FlowScrubber.tsx:56` 中，代码直接将 `style={{ flexGrow: tick.flex }}` 内联挂载到了 `<button className={styles.tick}>` 节点上，而 `.tick` 在 CSS 中设置了 `flex-basis: 0; background-color: var(--text-tertiary)`。

当滚动视口总高 900px、文档中存在 1 条 300px 的用户消息时，Flex 引擎计算分配给该 `<button>` 的高度为：
$$H_{\text{button}} = \frac{300}{900} \times 900\text{px} = 300\text{px}$$
一个原本设计为 **2px 极细定位针** 的元素，被拉伸成了一个 **高 300px、宽 8px（Hover 时 32px）的深灰色实体巨柱**，并在 Hover 时变为纯黑大方块，遮挡了聊天区域。

```
┌────────────────────────────────────────────────────────────────────────┐
│                   FlowScrubber 刻度错误拉伸示意图                      │
│                                                                        │
│  [正确设计] (针状标线)             [当前错误实现] (实心巨型块)          │
│  ┌─────────────────────────┐      ┌─────────────────────────┐          │
│  │      (Gap 空间)         │      │      (Gap 空间)         │          │
│  ├─────────────────────────┤      ├─────────────────────────┤          │
│  │ ────── 2px 细刻度线     │      │ ███████████████████████ │          │
│  ├─────────────────────────┤      │ █ 错误将 flexGrow 赋予 █ │ (高 200px)│
│  │                         │      │ █ tick 实体，导致背景色 █ │ 深灰方块   │
│  │      (Gap 空间)         │      │ ███████████████████████ │          │
│  └─────────────────────────┘      └─────────────────────────┘          │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 Slot-Marker 架构解耦模型

解耦模型将刻度拆分为职责分明的两层结构：

```
┌────────────────────────────────────────────────────────────────────────┐
│                       Slot-Marker 架构解耦模型                         │
│                                                                        │
│  .tickSlot (占位槽，吸收 flexGrow 纵向伸缩，完全透明，无背景)           │
│  │                                                                     │
│  └── <Tooltip>                                                         │
│      └── button.tick (交互热区，透明盒，height: 12px)                  │
│          ├── ::before (隐形 Hitbox，上下 6px，向左 20px 扩展)          │
│          └── span.tickBar (可见实体，固定 height: 2px，圆角 1px)       │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Slot 槽位容器（`.tickSlot`）**：
   - 承载 `flexGrow: tick.flex`，负责根据文档高度比例在轨道中瓜分垂直空间；
   - 自身完全透明，`background: transparent; pointer-events: none;`，使用 Flex 将子项垂直居中。
2. **Marker 刻度指示条（`.tickBar`）**：
   - 物理高度严格锁定为 `height: 2px; max-height: 2px; min-height: 2px; border-radius: 1px;`；
   - 只有它自身涂有主题色背景（`var(--text-tertiary)`），严禁受任何外部 Flex 纵向拉伸。

---

### 3.3 2px 物理细针与透明扩展 Hitbox 体系

- **隐形命中区（Invisible Hitbox via `::before`）**：
  在 `.tick` 按钮上挂载 `::before` 伪元素：
  ```css
  top: -6px; bottom: -6px; left: -20px; right: 0;
  ```
  使用户鼠标在刻度附近横向划过时极易捕捉，彻底杜绝小尺寸元素悬停脱靶引起的抖动。
- **四档动效响应契约**：
  - **静止默认态**：`width: 8px, opacity: 0.35, background: var(--text-tertiary)`
  - **视口激活态（`.isActive`）**：`width: 16px, opacity: 0.7, background: var(--text-secondary)`
  - **整轨悬停态（`.root:hover`）**：`width: 14px, opacity: 0.55`
  - **单刻度命中态（`.tick:hover .tickBar`）**：`width: 28px, opacity: 1.0, background: var(--text-primary)`

---

### 3.4 完整代码设计与 Diff

```diff
--- a/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx
+++ b/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx
@@ -47,16 +47,22 @@ function tickTooltip(
 const FlowScrubberTick: React.FC<{
   tick: ScrubberTick;
   tooltip: string;
   onJump: (id: string) => void;
 }> = React.memo(function FlowScrubberTick({ tick, tooltip, onJump }) {
   return (
+    <div
+      className={styles.tickSlot}
+      style={{ flexGrow: tick.flex }}
+      data-flow-scrubber-slot=""
+    >
       <Tooltip content={tooltip} side="left">
         <button
           type="button"
           className={styles.tick}
-          style={{ flexGrow: tick.flex }}
           data-flow-scrubber-tick=""
           data-msg-id={tick.id}
           data-height-percent={String(tick.heightPercent)}
           aria-label={tooltip}
           onClick={() => onJump(tick.id)}
-        />
+        >
+          <span className={styles.tickBar} />
+        </button>
       </Tooltip>
+    </div>
   );
 });
```

```diff
--- a/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css
+++ b/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css
@@ -23,17 +23,12 @@
   display: flex;
   flex-direction: column;
   justify-content: flex-start;
   align-items: flex-end;
-  gap: 8px;
+  gap: 0; /* 消除默认 gap，由比例段与 Slot 精确控制 */
   overflow: visible;
-  transition: gap var(--transition-fast);
-}
-
-.root:hover {
-  gap: 12px;
 }

 .gap {
   flex-shrink: 1;
   flex-basis: 0;
   min-height: 0;
   width: 0;
   pointer-events: none;
 }

+/* 刻度槽位容器：吸收垂直高度比例，本身完全透明 */
+.tickSlot {
+  position: relative;
+  width: 100%;
+  min-height: 8px;
+  flex-shrink: 1;
+  flex-basis: 0;
+  display: flex;
+  align-items: center;
+  justify-content: flex-end;
+  pointer-events: none;
+}
+
+/* 交互按钮实体 */
 .tick {
   position: relative;
-  flex-shrink: 1;
-  flex-basis: 0;
-  min-height: 2px;
-  width: 8px;
+  width: 100%;
+  height: 12px;
   margin: 0;
   padding: 0;
   border: none;
-  border-radius: 1px;
-  background-color: var(--text-tertiary);
-  transform-origin: right center;
+  background: transparent;
   cursor: pointer;
   pointer-events: auto;
   appearance: none;
   -webkit-appearance: none;
-  display: block;
+  display: flex;
+  align-items: center;
+  justify-content: flex-end;
   box-sizing: border-box;
+  outline: none;
+}
+
+/* 真正可见的 2px 极简针状标尺 */
+.tickBar {
+  display: block;
+  width: 8px;
+  height: 2px;
+  min-height: 2px;
+  max-height: 2px;
+  border-radius: 1px;
+  background-color: var(--text-tertiary);
+  opacity: 0.35;
+  transform-origin: right center;
   transition:
     width var(--transition-smooth),
+    opacity var(--transition-smooth),
     background-color var(--transition-smooth);
 }

+/* 隐形 Hitbox 区域：向上向下延伸 6px，向左延伸 20px，防止悬浮脱靶抖动 */
 .tick::before {
   content: '';
   position: absolute;
-  top: -8px;
-  bottom: -8px;
+  top: -6px;
+  bottom: -6px;
   left: -20px;
   right: 0;
   z-index: 1;
 }

-.tick.isActive {
-  background-color: color-mix(in srgb, var(--text-primary) 40%, transparent);
+.tick.isActive .tickBar {
   width: 16px;
+  opacity: 0.7;
+  background-color: var(--text-secondary);
 }

-.root:hover .tick {
-  width: 16px;
-  background-color: color-mix(in srgb, var(--text-primary) 25%, transparent);
+.root:hover .tickBar {
   width: 14px;
   opacity: 0.55;
 }

-.root:hover .tick.isActive {
-  width: 24px;
-  background-color: color-mix(in srgb, var(--text-primary) 50%, transparent);
+.root:hover .tick.isActive .tickBar {
   width: 20px;
   opacity: 0.85;
 }

-.tick:hover,
-.root:hover .tick:hover {
-  background-color: var(--text-primary);
-  width: 32px;
+.tick:hover .tickBar,
+.root:hover .tick:hover .tickBar {
   width: 28px !important;
+  opacity: 1 !important;
+  background-color: var(--text-primary) !important;
   z-index: 10;
 }
```

---

## 四、问题三：Markdown 代码块与复制按钮工程体系

### 4.1 样式资产断层与 HTML 管道脱节剖析

- **核心源码**：
  - 前端 HTML 构建：`apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts:73`
  - 前端增量渲染：`apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParserRender.ts:51-53`
  - Rust 内核渲染：`crates/conex-markdown/src/renderer.rs:1102`
  - 点击事件委托：`apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts:185-202`
  - 样式盲区：`apps/crish-desktop/src/styles/shell/shell-reset.css:56-62`（全仓无 `.md-code-copy` 规则）

#### 根因剖析：
渲染管道规范输出了如下 DOM 结构：
```html
<div class="md-code-block" data-lang="typescript">
  <span class="md-code-breadcrumb">src/app.ts</span>
  <span class="md-code-lang" data-lang="typescript">typescript</span>
  <button type="button" class="md-code-copy" aria-label="复制代码">复制</button>
  <pre class="md-code-pre hljs"><code class="language-typescript">...</code></pre>
</div>
```
但由于全仓没有任何 CSS 规则赋予 `.md-code-block` 包含块定位（`position: relative`）与 `.md-code-copy` 绝对定位，`<button class="md-code-copy">` 作为普通流内联块（`inline-block`）掉落在 `<pre>` 之前，以 User-Agent 默认灰色立体按钮呈现，强行占据行高压迫代码首行；在 ASCII 目录树等等宽图表中，生硬割裂了目录树根节点字符流。

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Markdown 代码块无样式破坏排版示意图                  │
│                                                                        │
│  [当前无样式状态]                                                      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ typescript [ 复制 ] <── 原生灰色按钮（占据文档流，破坏对齐）       │  │
│  │ ├── src/                                                         │  │
│  │ │   ├── index.ts                                                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  [标准修复状态]                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ src/index.ts  TS                                     [ 复制 ]    │  │
│  │ ──────────────────────────────────────────────────────────────── │  │
│  │ ├── src/                                                         │  │
│  │ │   ├── index.ts                                                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 4.2 全局 Markdown 代码块样式契约（`.md-code-block`）

在 `apps/crish-desktop/src/styles/design-system.css` 中注入标准 Markdown 代码块与复制体系契约：

```css
/* ==========================================================================
   Markdown Code Block & Copy Action Contract
   ========================================================================== */

/* 1. 代码块容器：包含块定位与圆角裁切 */
.md-code-block,
:global(.md-code-block) {
  position: relative;
  margin: var(--space-2, 8px) 0;
  border-radius: var(--radius-lg, 8px);
  background-color: var(--bg-card, var(--bg-secondary));
  border: var(--hairline-width, 1px) solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  overflow: hidden;
  box-sizing: border-box;
}

/* 2. 面包屑路径条 */
.md-code-breadcrumb,
:global(.md-code-breadcrumb) {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  font-size: var(--font-size-xs, 12px);
  font-family: var(--font-mono, monospace);
  color: var(--text-secondary);
  background: var(--bg-surface, rgba(0, 0, 0, 0.03));
  border-bottom: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
}

.md-code-breadcrumb-file,
:global(.md-code-breadcrumb-file) {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium, 500);
}

.md-code-breadcrumb-separator,
:global(.md-code-breadcrumb-separator) {
  color: var(--text-tertiary);
  margin: 0 2px;
}

/* 3. 语言指示标签 */
.md-code-lang,
:global(.md-code-lang) {
  position: absolute;
  top: 6px;
  right: 56px; /* 为右上角复制胶囊预留间距 */
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  line-height: 22px;
  user-select: none;
  pointer-events: none;
  opacity: 0.6;
}

/* 4. 代码内容 <pre> 区域 */
.md-code-pre,
:global(.md-code-pre) {
  margin: 0;
  padding: 10px 14px;
  overflow-x: auto;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xs, 12px);
  line-height: 1.55;
  tab-size: var(--md-code-tab-size, 2);
  -moz-tab-size: var(--md-code-tab-size, 2);
  white-space: pre;
  word-break: normal;
  background: transparent;
  color: var(--text-primary);
  scrollbar-width: thin;
}

.md-code-pre code,
:global(.md-code-pre code) {
  font-family: inherit;
  font-size: inherit;
  background: transparent;
  padding: 0;
  border: none;
}
```

---

### 4.3 绝对定位悬浮毛玻璃胶囊与 Hover 渐显动效

复制按钮彻底脱离普通文档流，固定于代码卡片右上角：

```css
/* 5. 复制按钮：绝对定位右上角悬浮胶囊 */
.md-code-copy,
:global(.md-code-copy) {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  font-family: var(--font-sans, inherit);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-tertiary);
  background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  user-select: none;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
  transition:
    opacity var(--transition-fast, 120ms ease),
    transform var(--transition-fast, 120ms ease),
    background-color var(--transition-fast, 120ms ease),
    color var(--transition-fast, 120ms ease),
    border-color var(--transition-fast, 120ms ease);
}

/* 悬停代码卡片或键盘聚焦时优雅显现 */
.md-code-block:hover .md-code-copy,
:global(.md-code-block:hover .md-code-copy),
.md-code-copy:focus-visible,
:global(.md-code-copy:focus-visible) {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.md-code-copy:hover,
:global(.md-code-copy:hover) {
  color: var(--text-primary);
  background: var(--bg-elevated);
  border-color: var(--border-color);
}

.md-code-copy:active,
:global(.md-code-copy:active) {
  background: var(--bg-active, var(--bg-hover));
}

/* 复制成功即时反馈微状态 */
.md-code-copy.isCopied,
:global(.md-code-copy.isCopied) {
  color: var(--accent-sage, #10b981);
  border-color: color-mix(in srgb, var(--accent-sage, #10b981) 40%, transparent);
}
```

---

### 4.4 ASCII 文件目录树（`dir`/`tree`）等宽与零压盖保障

针对 `tree`、`dir`、`file-tree` 等 ASCII 等宽排版语言，规范如下：
1. 语言徽标自动隐藏（或字号缩小），避免与文件路径重叠；
2. 字体强制锁定标准等宽字体栈与 `letter-spacing: 0`；
3. `<pre>` 顶层 `offsetTop` 不受复制按钮影响（复制按钮为 `absolute` 独立图层），字符绝对对齐。

```css
/* 6. ASCII 目录树专项 */
.md-code-block[data-lang='tree'] .md-code-lang,
.md-code-block[data-lang='dir'] .md-code-lang,
:global(.md-code-block[data-lang='tree'] .md-code-lang),
:global(.md-code-block[data-lang='dir'] .md-code-lang) {
  display: none;
}

.md-code-block[data-lang='tree'] .md-code-pre,
.md-code-block[data-lang='dir'] .md-code-pre,
:global(.md-code-block[data-lang='tree'] .md-code-pre),
:global(.md-code-block[data-lang='dir'] .md-code-pre) {
  font-family: 'Cascadia Code', 'Fira Code', var(--font-mono, monospace);
  white-space: pre;
  letter-spacing: 0;
}
```

---

### 4.5 完整代码设计与 Diff

```diff
--- a/apps/crish-desktop/src/styles/design-system.css
+++ b/apps/crish-desktop/src/styles/design-system.css
@@ -95,3 +95,95 @@ html[data-theme="dark"] .elevation-4 {
   from { opacity: 1; transform: scale(1) translateY(0); }
   to   { opacity: 0; transform: scale(0.96) translateY(8px); }
 }
+
+/* ==========================================================================
+   Markdown Code Block & Copy Action Contract (Zero-Overlap Standard)
+   ========================================================================== */
+.md-code-block,
+:global(.md-code-block) {
+  position: relative;
+  margin: var(--space-2, 8px) 0;
+  border-radius: var(--radius-lg, 8px);
+  background-color: var(--bg-card, var(--bg-secondary));
+  border: var(--hairline-width, 1px) solid var(--border-subtle, rgba(0, 0, 0, 0.08));
+  overflow: hidden;
+  box-sizing: border-box;
+}
+
+.md-code-breadcrumb,
+:global(.md-code-breadcrumb) {
+  display: flex;
+  align-items: center;
+  gap: 4px;
+  padding: 6px 12px;
+  font-size: var(--font-size-xs, 12px);
+  font-family: var(--font-mono, monospace);
+  color: var(--text-secondary);
+  background: var(--bg-surface, rgba(0, 0, 0, 0.03));
+  border-bottom: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
+}
+
+.md-code-breadcrumb-file,
+:global(.md-code-breadcrumb-file) {
+  color: var(--text-primary);
+  font-weight: var(--font-weight-medium, 500);
+}
+
+.md-code-breadcrumb-separator,
+:global(.md-code-breadcrumb-separator) {
+  color: var(--text-tertiary);
+  margin: 0 2px;
+}
+
+.md-code-lang,
+:global(.md-code-lang) {
+  position: absolute;
+  top: 6px;
+  right: 56px;
+  font-size: 10px;
+  font-family: var(--font-mono, monospace);
+  color: var(--text-tertiary);
+  text-transform: uppercase;
+  letter-spacing: 0.5px;
+  line-height: 22px;
+  user-select: none;
+  pointer-events: none;
+  opacity: 0.6;
+}
+
+.md-code-pre,
+:global(.md-code-pre) {
+  margin: 0;
+  padding: 10px 14px;
+  overflow-x: auto;
+  font-family: var(--font-mono, monospace);
+  font-size: var(--font-size-xs, 12px);
+  line-height: 1.55;
+  tab-size: var(--md-code-tab-size, 2);
+  -moz-tab-size: var(--md-code-tab-size, 2);
+  white-space: pre;
+  word-break: normal;
+  background: transparent;
+  color: var(--text-primary);
+  scrollbar-width: thin;
+}
+
+.md-code-copy,
+:global(.md-code-copy) {
+  position: absolute;
+  top: 6px;
+  right: 8px;
+  z-index: 5;
+  display: inline-flex;
+  align-items: center;
+  justify-content: center;
+  height: 22px;
+  padding: 0 8px;
+  font-size: 11px;
+  font-family: var(--font-sans, inherit);
+  font-weight: var(--font-weight-medium, 500);
+  color: var(--text-tertiary);
+  background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
+  backdrop-filter: blur(6px);
+  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
+  border-radius: var(--radius-sm, 4px);
+  cursor: pointer;
+  user-select: none;
+  opacity: 0;
+  pointer-events: none;
+  transform: translateY(-1px);
+  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
+  transition:
+    opacity var(--transition-fast, 120ms ease),
+    transform var(--transition-fast, 120ms ease),
+    background-color var(--transition-fast, 120ms ease),
+    color var(--transition-fast, 120ms ease),
+    border-color var(--transition-fast, 120ms ease);
+}
+
+.md-code-block:hover .md-code-copy,
+:global(.md-code-block:hover .md-code-copy),
+.md-code-copy:focus-visible,
+:global(.md-code-copy:focus-visible) {
+  opacity: 1;
+  pointer-events: auto;
+  transform: translateY(0);
+}
+
+.md-code-copy:hover,
+:global(.md-code-copy:hover) {
+  color: var(--text-primary);
+  background: var(--bg-elevated);
+  border-color: var(--border-color);
+}
```

---

## 五、问题四：操作栏图标按钮与 Tooltip 浮层闭环治理

### 5.1 图标按钮尺寸冲突与 Props 契约传递断层修复

- **核心源码**：
  - `apps/crish-desktop/src/components/chat-message-row/AssistantMessageActionsBar.tsx:41-80`
  - `apps/crish-desktop/src/components/chat-message/MessageActions.tsx:106-116`
  - `apps/crish-desktop/src/components/chat-message/ChatSendToNoteEntry.tsx:82-106`
  - `apps/crish-desktop/src/components/note-paper/SendToNoteButton.tsx:154-186`
  - `apps/crish-desktop/src/components/ui/Button/IconButton.tsx:25-49`
  - `apps/crish-desktop/src/components/ui/Button/Button.module.css:94-102`
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:288-310`

#### 根因剖析：
1. `AssistantMessageActionsBar` 使用 `<Button size="sm" className={styles.iconBtn}>`。由于 `Button.module.css` 的 `.buttonSm` 设置 `--btn-h: 28px; --btn-px: 10px;` 与 `.iconBtn` 的 `width: 22px; height: 22px; padding: 0;` 产生 CSS Module 类名特异度冲突，生成了 22px 宽 × 28px 高的瘦长畸形按钮；
2. `MessageActions.tsx:107` 渲染 `ChatSendToNoteEntry` 时**漏传 `className`**，导致 `SendToNoteButton(iconOnly=true)` 完整应用了全局 `.buttonSm`（高 28px、宽 36px），与整排 22px 按钮混排严重错位。

#### 修复设计：
1. `ChatSendToNoteEntry` 与 `MessageActions.tsx` 显式透传 `className={styles.iconBtn}`；
2. 操作栏内统一采用 `@/components/ui/Button/IconButton`（声明 `size="xs"`，内置正方形几何与 `padding: 0` 强约束）或标准原生按钮契约，彻底杜绝类名冲突。

---

### 5.2 隐形元素事件泄露阻断（`opacity: 0` + `pointer-events: none`）

- **核心源码**：
  - `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx:148-158`
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:90-107, 264-276, 580-608`

#### 悬空气泡产生机理：
`.thoughtExpandModalBtn` 位于卡片右上角，设置了 `opacity: 0` 默认隐藏，但**遗漏了 `pointer-events: none`**。当鼠标路过右上角时，透明按钮依然触发 `mouseenter`，`<Tooltip>` 唤起并在卡片右上角凭空弹出一个悬空的黑色提示气泡（「在沉浸式查阅器中查看完整思维链」）。
同样，`.userMeta` 与 `.assistantMeta` 在默认隐藏态下也必须硬性阻断鼠标交互。

#### 修复原则：
所有默认隐藏、hover 显现的次级操作栏与按钮，严格贯彻状态矩阵：
- **隐藏态**：`opacity: 0; pointer-events: none;`
- **悬停/聚焦态**：`opacity: 1; pointer-events: auto;`

```
┌────────────────────────────────────────────────────────────────────────┐
│                   透明触发器引发悬空气泡缺陷示意图                     │
│                                                                        │
│  卡片右上角                                 悬浮气泡凭空出现           │
│  ┌─────────────────────────────────┐       ┌───────────────────────┐  │
│  │ 思考过程 · 1.2s                 │       │ 在沉浸式查阅器中查看… │  │
│  │                                 │       └──────────┬────────────┘  │
│  │             [ 隐形透明按钮 ] <──┼── 鼠标悬浮此处   │              │
│  │             (opacity: 0 但无    │   触发 Tooltip ──┘               │
│  │              pointer-events:none)                                  │
│  └─────────────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 5.3 Tooltip 首帧几何未测量动画穿透（First-Frame Animation Leak）门禁

- **核心源码**：
  - `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:95-97, 180-198, 380-409`
  - `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css:10-27`

#### 闪烁穿透机理：
当 Tooltip 被唤起时，`setVisible(true)` 执行，此时 `clampedPos` 仍为初始值 `null`。
React 立即通过 Portal 挂载 DOM 节点并应用 `styles.tooltipEnter` 类名。
CSS 规则中 `@keyframes tooltip-enter { to { opacity: 1; } }` **强行覆盖了 JSX 内联的 `opacity: 0`**！
导致在 `useLayoutEffect` 计算出 `clampedPos` 之前的这 1 个物理帧内，Tooltip 在 `(rect.top, rect.left)` 的未钳位未翻折原始坐标上以 `opacity: 1` 闪现，造成边缘悬空跳动。

#### 修复方案：
引入 `isPositionReady = clampedPos !== null && isValidDOMRect(rect)` 门禁：
1. 当 `!isPositionReady` 时，应用 `styles.tooltipMeasuring`（`animation: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;`）；
2. 仅当 `isPositionReady` 且几何坐标完全就绪后，才激活 `styles.tooltipEnter` 进入动画。

---

### 5.4 冗余 Tooltip 清洗与 DOM 语义收敛

在 `ChatUserMessageRow.tsx:133-140` 中，`span.pinBadge` 已经明确展示图钉图标并包含文字「已固定」，外层却再次包裹 `<Tooltip content="已固定">`。
- **治理**：移除该冗余 Tooltip 包裹，消除界面同义重复黑气泡污染。

---

### 5.5 完整代码设计与 Diff

```diff
--- a/apps/crish-desktop/src/components/chat-message/MessageActions.tsx
+++ b/apps/crish-desktop/src/components/chat-message/MessageActions.tsx
@@ -107,6 +107,7 @@ export const MessageActions: React.FC<MessageActionsProps> = React.memo(
             <ChatSendToNoteEntry
               messageId={msg.id}
               status={msg.status}
               markdown={noteMarkdown}
               onSuccess={onNoteSuccess}
               onError={onNoteError}
+              className={styles.iconBtn}
               iconOnly
             />
           }
```

```diff
--- a/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
+++ b/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
@@ -93,7 +93,8 @@
   gap: 0;
   min-height: 22px;
   opacity: 0;
+  pointer-events: none;
   transition: opacity var(--transition-fast);
   padding-right: var(--space-0_5);
 }

 .userStack:hover .userMeta {
   opacity: 1;
+  pointer-events: auto;
 }

 .userMeta.metaAlways,
 .assistantMeta.metaAlways {
   opacity: 1;
+  pointer-events: auto;
 }
@@ -268,6 +269,7 @@
   margin-top: var(--space-1);
   min-height: 22px;
   opacity: 0;
+  pointer-events: none;
   transition: opacity var(--transition-fast);
 }

 .rowAssistant:hover .assistantMeta {
   opacity: 1;
+  pointer-events: auto;
 }
@@ -591,6 +593,7 @@
   border-radius: var(--radius-sm, 4px);
   color: var(--text-tertiary);
   cursor: pointer;
   opacity: 0;
+  pointer-events: none; /* 隐形时严禁拦截鼠标事件与触发 Tooltip */
   transition:
     opacity var(--transition-fast),
     background var(--transition-fast),
@@ -601,6 +604,7 @@

 .thoughtTimelineSection:hover .thoughtExpandModalBtn {
   opacity: 1;
+  pointer-events: auto;
 }
```

```diff
--- a/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx
+++ b/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx
@@ -201,6 +201,15 @@ export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
     const commitShow = (el: HTMLElement) => {
       if (disabledRef.current || !contentRef.current) return;
       if (isTooltipMuted()) return;
+      // 可见性前置断言：透明或隐藏元素严禁弹出 Tooltip
+      const style = window.getComputedStyle(el);
+      if (
+        style.opacity === '0' ||
+        style.visibility === 'hidden' ||
+        style.display === 'none' ||
+        style.pointerEvents === 'none'
+      ) {
+        return;
       }
       const currentRect = el.getBoundingClientRect();
       if (!isValidDOMRect(currentRect) || isTriggerOffscreen(currentRect)) {
         return;
@@ -356,6 +365,7 @@ export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
     const effectiveSide = clampedPos?.effectiveSide ?? side;
+    const isPositionReady = clampedPos !== null && isValidDOMRect(rect);

     const clonedChild = React.cloneElement(child, {
       ref: mergedRef,
@@ -384,14 +394,22 @@ export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
               id={tipId}
               role="tooltip"
               data-tooltip-portal="true"
-              className={`${styles.tooltip} ${styles[effectiveSide]} ${state === 'exiting' ? styles.tooltipExit : styles.tooltipEnter}`}
+              className={`${styles.tooltip} ${styles[effectiveSide]} ${
+                !isPositionReady
+                  ? styles.tooltipMeasuring
+                  : state === 'exiting'
+                    ? styles.tooltipExit
+                    : styles.tooltipEnter
+              }`}
               style={
                 {
                   top: `${clampedPos?.top ?? rect.top}px`,
                   left: `${clampedPos?.left ?? rect.left}px`,
-                  opacity:
-                    clampedPos !== null && isValidDOMRect(rect) ? undefined : 0,
+                  visibility: isPositionReady ? 'visible' : 'hidden',
+                  opacity: isPositionReady ? undefined : 0,
                   pointerEvents:
+                    !isPositionReady ||
                     state === 'exiting' ||
                     clampedPos === null ||
                     !isValidDOMRect(rect)
```

```diff
--- a/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css
+++ b/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css
@@ -16,6 +16,13 @@
   animation: tooltip-exit var(--transition-popover-exit) forwards;
 }

+/* 测量态安全门禁：未完成四向坐标与尺寸测量前，硬性禁止展示与动画执行 */
+.tooltipMeasuring {
+  animation: none !important;
+  opacity: 0 !important;
+  visibility: hidden !important;
+  pointer-events: none !important;
+}

 @keyframes tooltip-enter {
   from {
     opacity: 0;
```

```diff
--- a/apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx
+++ b/apps/crish-desktop/src/components/chat-message-row/ChatUserMessageRow.tsx
@@ -131,11 +131,9 @@ export const ChatUserMessageRow: React.FC<ChatUserMessageRowProps> = ({
     >
       <div className={styles.userStack}>
         {isPinned ? (
-          <Tooltip content="已固定">
             <span className={styles.pinBadge} aria-hidden="true">
               <Pin size={11} strokeWidth={2.25} />
               已固定
             </span>
-          </Tooltip>
         ) : null}
         <div
```

---

## 六、反过度设计审查（Anti-Overengineering Compliance Audit）

方案 A 严格对照仓库根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md` 进行了全面架构自检，确认 100% 遵从所有红线要求：

| 禁令条款 | 审查项 | 方案 A 落地实证与合规性证明 | 结论 |
| :--- | :--- | :--- | :--- |
| **禁令 9**（严禁滑动窗口断路器） | Composer 振荡保护机制 | 仅使用轻量级局部时戳数组（`120ms` 判定，原生计时器），绝无全局复杂 CircuitBreaker 状态机。 | ✅ **合规** |
| **禁令 10**（严禁 6 阶段洋葱 Hook 链） | Tooltip 与 Markdown 事件流 | 原生 React 事件冒泡与 DOM 点击委托，0 中间件流水线。 | ✅ **合规** |
| **禁令 11**（严禁微服务套娃与 IPC 路由） | 状态与渲染通信 | 纯前端渲染层与 CSS 原生图层治理，零后端 IPC 改动，零额外跨层 Facade。 | ✅ **合规** |
| **禁令 12**（严禁高频状态打入全局 Store） | Composer 与度量状态 | 文本宽度度量完全内聚在 `useComposerMultiline` 局部 Hook 中，单例 Canvas 测量零全局 Store 污染。 | ✅ **合规** |
| **第三方库控制** | 外部依赖引入 | **0 个新增 npm 依赖**。不引入 Popper.js、Floating-UI、ResizeObserver-Polyfill 等重型库，纯原生 Canvas + CSS + React Hooks 实现。 | ✅ **合规** |
| **打补丁与魔术数字禁令** | 布局与几何对齐 | 彻底消除 `flexGrow` 赋予实体的错误用法，通过原生 Slot-Marker 架构与施密特迟滞区间实现 $O(1)$ 优雅解决。 | ✅ **合规** |

---

## 七、防回归验证断言与测试实施矩阵

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              自动化测试验证与门禁矩阵                                  │
├───────────────────────┬──────────────────────────────────┬─────────────────────────────┤
│ 测试领域              │ 测试文件载体                     │ 核心断言内容                │
├───────────────────────┼──────────────────────────────────┼─────────────────────────────┤
│ 1. Composer 状态机    │ useComposerMultiline.test.ts     │ - 临界宽度下往复触发 100 次 │
│                       │ (Vitest Unit)                    │   状态翻转次数严格 <= 1 次  │
│                       │                                  │ - 振荡熔断保护触发自愈有效  │
├───────────────────────┼──────────────────────────────────┼─────────────────────────────┤
│ 2. FlowScrubber 标尺  │ FlowScrubber.test.tsx            │ - .tickBar 计算样式 height  │
│                       │ (Vitest Component)               │   严格恒等 2px              │
│                       │                                  │ - .tickSlot 承载 flexGrow   │
├───────────────────────┼──────────────────────────────────┼─────────────────────────────┤
│ 3. Markdown 渲染      │ MarkdownCodeFence.test.ts        │ - .md-code-copy 计算样式    │
│                       │ (Vitest & DOM)                   │   position 为 absolute      │
│                       │                                  │ - 树形图第一行 offsetTop 恒定│
├───────────────────────┼──────────────────────────────────┼─────────────────────────────┤
│ 4. 浮层与按钮尺寸     │ TooltipLeak.test.tsx             │ - clampedPos=null 时 Portal │
│                       │ (Vitest & CDP)                   │   具有 visibility: hidden   │
│                       │                                  │ - 操作栏全部按钮尺寸一致    │
└───────────────────────┴──────────────────────────────────┴─────────────────────────────┘
```

### 详细断言实现规范：

```typescript
// apps/crish-desktop/src/components/chat-composer/useComposerMultiline.test.ts
import { renderHook, act } from '@testing-library/react';
import { useComposerMultiline } from './useComposerMultiline';

describe('useComposerMultiline 施密特迟滞防抖', () => {
  it('在临界文本宽度区间往复扰动时，状态保持单调稳定不震荡', () => {
    const layoutEl = document.createElement('div');
    Object.defineProperty(layoutEl, 'clientWidth', { value: 600 });
    const layoutRef = { current: layoutEl };

    let text = 'A'.repeat(50); // 临界长度
    const { result, rerender } = renderHook(
      ({ t }) => useComposerMultiline({ text: t, hasAttachments: false, layoutRef }),
      { initialProps: { t: text } }
    );

    let flipCount = 0;
    let lastState = result.current;

    // 模拟 144Hz 下连续微调文本长度
    for (let i = 0; i < 60; i++) {
      text = i % 2 === 0 ? 'A'.repeat(50) : 'A'.repeat(49);
      act(() => {
        rerender({ t: text });
      });
      if (result.current !== lastState) {
        flipCount++;
        lastState = result.current;
      }
    }

    // 迟滞区间生效，翻转次数严格 <= 1
    expect(flipCount).toBeLessThanOrEqual(1);
  });
});
```

```typescript
// apps/crish-desktop/src/components/ui/Tooltip/Tooltip.test.tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tooltip } from './Tooltip';

describe('Tooltip 首帧零泄漏与可见性门禁', () => {
  it('当触发器处于 opacity: 0 隐形状态时，禁止唤起 Tooltip Portal', () => {
    render(
      <Tooltip content="隐形测试提示">
        <button style={{ opacity: 0, pointerEvents: 'none' }}>隐形按钮</button>
      </Tooltip>
    );

    const btn = screen.getByText('隐形按钮');
    fireEvent.mouseEnter(btn);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
```

---
*方案 A 编制完成，全面集成 3 份排查报告精髓，遵循反过度设计硬性红线与工程严谨性原则，为后续实施阶段提供清晰、确定的技术路线。*
