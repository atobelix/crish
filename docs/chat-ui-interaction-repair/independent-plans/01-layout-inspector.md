# 前端布局与视效架构独立排查与修复方案

> **文件路径**：`docs/chat-ui-interaction-repair/independent-plans/01-layout-inspector.md`  
> **角色**：前端布局与视效架构专家（Frontend Layout Specialist）  
> **排查范围**：`apps/crish-desktop/src/`、`reference/`、`crates/` 等核心源码  
> **执行原则**：坚持源码证据第一，彻底穿透表象至底层布局几何与事件驱动断层，杜绝打补丁与魔术数字。

---

## 目录

1. [执行总览与架构背景](#一执行总览与架构背景)
2. [问题一：输入框（Composer）高频抖动与 144Hz 视觉重影深度分析与修复方案](#二问题一输入框composer高频抖动与-144hz-视觉重影)
3. [问题二：聊天区域 FlowScrubber 刻度条呈现粗大实心深灰方块深度分析与修复方案](#三问题二聊天区域-flowscrubber-刻度条呈现粗大实心深灰方块)
4. [问题三：Markdown 代码块与目录树原生无样式「复制」按钮压盖文本深度分析与修复方案](#四问题三markdown-代码块与目录树原生无样式复制按钮压盖文本)
5. [问题四：消息卡片操作按钮尺寸样式冲突与右上角悬空提示气泡深度分析与修复方案](#五问题四消息卡片操作按钮尺寸样式冲突与右上角悬空提示气泡)
6. [设计系统规范契约与防回归断言](#六设计系统规范契约与防回归断言)

---

## 一、执行总览与架构背景

本排查针对桌面端聊天界面与交互中出现的四项严重视效与交互退化缺陷展开。通过直接对 `apps/crish-desktop/src/` 下的布局测量机制、CSS Modules 特异度、虚拟滚动刻度模型、Markdown HTML 渲染管线及 Tooltip 浮层控制器进行全面源码审计，精准锁定了导致异常的底层代码与因果链路。

```
┌──────────────────────────────────────────────────────────────────────────┐
│                             问题与架构根因全景                            │
├───────────────────────┬─────────────────────────┬────────────────────────┤
│ 现象                  │ 核心受影响文件          │ 深层架构根因           │
├───────────────────────┼─────────────────────────┼────────────────────────┤
│ 1. Composer 高频震荡  │ useComposerMultiline.ts │ 测量指标不对称 +       │
│    144Hz 视觉双影     │ ChatComposer.module.css │ 零滞后区间触发极限环   │
├───────────────────────┼─────────────────────────┼────────────────────────┤
│ 2. FlowScrubber 刻度  │ FlowScrubber.tsx        │ flexGrow 作用于刻度实体│
│    粗大深灰实心方块   │ flowScrubberModel.ts    │ 导致 2px 针状标尺畸变  │
├───────────────────────┼─────────────────────────┼────────────────────────┤
│ 3. 代码块/目录树原生  │ markdownCodeFence.ts    │ HTML 管道输出 button   │
│    复制按钮压盖排版   │ shell-reset.css         │ 但全仓零 CSS 样式定义  │
├───────────────────────┼─────────────────────────┼────────────────────────┤
│ 4. 按钮尺寸矩形扭曲   │ AssistantMessageActions │ Button 尺寸与 iconBtn  │
│    右上角悬空突兀气泡 │ TimelineThoughtSection  │ 特异度冲突 + 透明触发器│
└───────────────────────┴─────────────────────────┴────────────────────────┘
```

---

## 二、问题一：输入框（Composer）高频抖动与 144Hz 视觉重影

### 2.1 源码定位与证据链

- **测量与切换调度**：[`apps/crish-desktop/src/components/chat-composer/useComposerMultiline.ts:26-93`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/useComposerMultiline.ts#L26-L93)
- **网格布局与高度约束**：[`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:532-551`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L532-L551) 及 [`ChatComposer.module.css:603-626`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L603-L626)
- **主输入装配**：[`apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx:307-311`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx#L307-L311)

### 2.2 深度根因推导：极限环震荡与视网膜暂留（Limit Cycle Oscillation）

1. **单行态到多行态的触发判定（Expansion Trigger）**：
   - 当 Composer 处于单行态（`multiline === false`）时，CSS 网格为单行流：
     ```css
     /* ChatComposer.module.css:540 */
     .composerCard:not(.isMultiline) .inputMainLayout {
       grid-template-areas: 'left-ctrl text perm actions';
       grid-template-columns: auto 1fr auto auto;
     }
     ```
   - 此时输入区域 `text` 仅占容器剩余宽度（假设总宽 600px，左右控件占用 220px，则输入框 `clientWidth` 约为 380px）。
   - 在 `useComposerMultiline.ts:69-72`：
     ```typescript
     if (editable.scrollWidth > editable.clientWidth + 1) {
       setMultiline(true);
       return;
     }
     ```
   - 当用户输入字符略微超出 380px 时（如实际排版占 385px），`editable.scrollWidth`（385px）> `clientWidth + 1`（381px），立即触发 `setMultiline(true)`。

2. **多行态到单行态的判定断层（Collapse Fallback）**：
   - 状态变为 `multiline === true` 后，React 触发重渲染，CSS 切换至多行网格：
     ```css
     /* ChatComposer.module.css:545 */
     .composerCard.isMultiline .inputMainLayout {
       grid-template-areas:
         'text text text text'
         'left-ctrl perm . actions';
       grid-template-columns: auto auto 1fr auto;
     }
     ```
   - 输入框 `text` 独占第一整行，其 `clientWidth` 瞬间由 380px 膨胀至 600px。
   - 网格几何改变立即被 `ResizeObserver` 捕获（`useComposerMultiline.ts:87`），在下一个微任务周期触发 `measure()`。
   - 此时在多行态下执行 `measure()`：
     - `editable.scrollWidth > editable.clientWidth + 1` 条件判断为 `385px > 601px` → **FALSE**。
     - 代码继续执行离屏测量兜底：
       ```typescript
       // useComposerMultiline.ts:60-65
       const used = (left?.offsetWidth ?? 0) + (perm?.offsetWidth ?? 0) + (right?.offsetWidth ?? 0) + GRID_GUTTER_PX;
       const capacity = Math.max(MIN_CAPACITY_PX, layoutW - used);
       // useComposerMultiline.ts:79-80
       const width = measureTextWidth(clean, fontRef.current || '14px sans-serif');
       setMultiline(width >= capacity);
       ```
   - **致命测量不对称**：
     - `editable.scrollWidth` 是 DOM 中带 ProseMirror 内部 padding、光标零宽字符 `\u200B`、字间距的真实排版宽度（385px）。
     - `measureTextWidth` 却是一个脱离 DOM 的离屏裸 `<span>` 纯文本测量（`useComposerMultiline.ts:10-24`），没有计算 ProseMirror 容器内边距、换行预留和光标占位，测出的宽度往往偏小（例如 375px）。
     - 此时计算出的 `capacity` 为 `600 - 220 = 380px`。
     - 由于 `width (375px) < capacity (380px)`，`setMultiline(width >= capacity)` 判定为 **FALSE**，调用 `setMultiline(false)`！

3. **无限极限环震荡与 144Hz 视觉重影**：
   - `setMultiline(false)` 导致组件切回单行；
   - 切回单行导致 `clientWidth` 缩回 380px；
   - `ResizeObserver` 再次被触发，`scrollWidth > clientWidth + 1` 再次成立（385 > 381），又触发 `setMultiline(true)`；
   - 整个流程在每一帧（每 6.94ms 在 144Hz 屏幕上，或 16.6ms 在 60Hz 屏幕上）周而复始。
   - **视觉表象**：输入框每秒在 36px 胶囊高度与 80px 两行高度之间交替重绘 144 次，在人眼视网膜上形成强烈的双重轮廓重影（「一个大一个小同时存在」的鬼影现象）。同时 `measureTextWidth` 在每一帧不断 `document.body.appendChild` 和 `remove`，引发极高的主线程 Forced Synchronous Layout / Reflow 消耗。

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

### 2.3 架构级修复方案设计

1. **引入施密特触发器滞后区间（Hysteresis Deadband）**：
   - 展开阈值（Expand Threshold）：当文本计算宽度超过单行容量时展开（`width >= capacity`）。
   - 收起阈值（Collapse Threshold）：只有当文本计算宽度小于单行容量扣除安全缓冲区（`capacity - HYSTERESIS_PX`，建议 24px）时，才允许切回单行。
2. **统一测量基准（Unified Metrics Engine）**：
   - 彻底废除基于 DOM `scrollWidth` 与离屏 `span` 双重分叉的判断逻辑。
   - 统一采用 Canvas 2D `ctx.measureText` 缓存引擎（或同一稳定的测量容器），包含准确的 `fontSize`、`fontFamily`、`letterSpacing` 以及 DOM 内边距偏移补偿，消除 DOM 插入/删除抖动与测量误差。
3. **ResizeObserver 状态变化守卫**：
   - 仅在计算出的 `nextMultiline !== currentMultiline` 时才触发 `setState`，并在 `ResizeObserver` 回调中对尺寸变化加入防抖/阈值过滤。

### 2.4 代码设计

```typescript
// apps/crish-desktop/src/components/chat-composer/useComposerMultiline.ts

const GRID_GUTTER_PX = 18;
const MIN_CAPACITY_PX = 200;
/** 滞后缓冲区：收起时必须比展开阈值少 24px，防止临界值无限震荡 */
const HYSTERESIS_BUFFER_PX = 24;

// 使用单例 Canvas 替代频繁 DOM append/remove
let measureCanvasCtx: CanvasRenderingContext2D | null = null;
function getMeasureContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!measureCanvasCtx) {
    const canvas = document.createElement('canvas');
    measureCanvasCtx = canvas.getContext('2d');
  }
  return measureCanvasCtx;
}

function measureTextAccurate(text: string, font: string): number {
  const ctx = getMeasureContext();
  if (ctx) {
    ctx.font = font;
    return ctx.measureText(text).width;
  }
  return text.length * 8; // 安全兜底
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
  const multilineRef = useRef(multiline);
  multilineRef.current = multiline;

  const fontRef = useRef<string>('');

  const measure = useCallback(() => {
    // 1. 显式多行因素直接判定
    if (hasAttachments || text.includes('\n')) {
      if (!multilineRef.current) setMultiline(true);
      return;
    }

    const layout = layoutRef.current;
    if (!layout) {
      if (multilineRef.current) setMultiline(false);
      return;
    }

    const left = layout.querySelector('[data-composer-grid="left"]') as HTMLElement | null;
    const perm = layout.querySelector('[data-composer-grid="perm"]') as HTMLElement | null;
    const right = layout.querySelector('[data-composer-grid="right"]') as HTMLElement | null;
    const editable = layout.querySelector('[contenteditable="true"], textarea') as HTMLElement | null;

    if (editable) {
      const cs = getComputedStyle(editable);
      fontRef.current = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    }

    const layoutW = layout.clientWidth;
    const used = (left?.offsetWidth ?? 0) + (perm?.offsetWidth ?? 0) + (right?.offsetWidth ?? 0) + GRID_GUTTER_PX;
    const capacity = Math.max(MIN_CAPACITY_PX, layoutW - used);

    const clean = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!clean) {
      if (multilineRef.current) setMultiline(false);
      return;
    }

    // 2. 高精度离屏宽度测量（加入 8px 编辑器内边距安全余量）
    const textWidth = measureTextAccurate(clean, fontRef.current || '14px sans-serif') + 8;

    // 3. 滞后比较逻辑（Hysteresis Gate）
    if (!multilineRef.current) {
      // 当前为单行：必须 >= capacity 才能展开
      if (textWidth >= capacity) {
        setMultiline(true);
      }
    } else {
      // 当前为多行：必须 < (capacity - HYSTERESIS_BUFFER_PX) 才能收起
      if (textWidth < capacity - HYSTERESIS_BUFFER_PX) {
        setMultiline(false);
      }
    }
  }, [hasAttachments, layoutRef, text]);

  useLayoutEffect(() => {
    measure();
    const el = layoutRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let prevW = el.clientWidth;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        // 宽度未发生实质变化（例如仅由高度切换触发）时忽略，切断反馈回路
        if (Math.abs(cr.width - prevW) > 2) {
          prevW = cr.width;
          measure();
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layoutRef, measure]);

  return multiline;
}
```

---

## 三、问题二：聊天区域 FlowScrubber 刻度条呈现粗大实心深灰方块

### 3.1 源码定位与证据链

- **刻度组件与 Track 渲染**：[`apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx:46-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx#L46-L65) 及 [`FlowScrubber.tsx:166-184`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx#L166-L184)
- **刻度模型高度映射**：[`apps/crish-desktop/src/components/chat-message-list/flowScrubberModel.ts:76-107`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/flowScrubberModel.ts#L76-L107)
- **CSS 尺寸与伪类样式**：[`apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css:43-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css#L43-L65)
- **参考设计原型对照**：[`reference/chat-composer-component/css/flow/scrubber.css:47-59`](file:///c:/Software/conex/reference/chat-composer-component/css/flow/scrubber.css#L47-L59)

### 3.2 深度根因推导：FlexGrow 滥用导致针状标尺发生几何拉伸畸变

1. **参考原型的初衷**：
   在 `reference/chat-composer-component/css/flow/scrubber.css:48-58` 中，FlowScrubber 刻度被设计为类似于专业视频剪辑/文档大纲的**极细定位针（Needle Tick）**：
   ```css
   /* reference/chat-composer-component/css/flow/scrubber.css:50 */
   .flow-scrubber__tick {
     position: relative;
     width: 8px;
     height: 2px; /* 固定的 2px 极细微标线 */
     border-radius: 1px;
     background-color: var(--text-tertiary, rgba(0, 0, 0, 0.22));
     /* flex: none; 不参与高度拉伸 */
   }
   ```
2. **实现层的语义混淆与几何畸变**：
   - 在 `flowScrubberModel.ts:94` 中，将用户消息的高度 `h`（例如 200px、500px 甚至更大）赋值给了 `tick.flex`：
     ```typescript
     // flowScrubberModel.ts:94
     segs.push({
       type: 'tick',
       tick: {
         id: msg.id,
         flex: h, // 此处直接传入整个用户消息块的 VSM 绝对像素高
         heightPercent: h / total,
         ...
       }
     });
     ```
   - 随后在 `FlowScrubber.tsx:56` 中，直接将 `style={{ flexGrow: tick.flex }}` 挂载到了 `<button className={styles.tick}>` 上：
     ```tsx
     // FlowScrubber.tsx:56
     <button
       type="button"
       className={styles.tick}
       style={{ flexGrow: tick.flex }}
       ...
     />
     ```
   - 而在 `FlowScrubber.module.css:43-53` 中：
     ```css
     .tick {
       position: relative;
       flex-shrink: 1;
       flex-basis: 0; /* 基础高度为 0，由 flexGrow 瓜分整个轨道高度 */
       min-height: 2px;
       width: 8px;
       background-color: var(--text-tertiary); /* 实心深灰色背景 */
     }
     ```
3. **视觉灾难形成的力学过程**：
   - 刻度容器 `.root` 拥有视口 100% 的高度（例如 900px）；
   - 当文档中有一条 400px 高的用户消息，总文档高度 1200px 时，该 `<button className={styles.tick}>` 在 flex 布局下分配到的实际物理高度为：`(400 / 1200) * 900px = 300px`！
   - 一个原本应该只有 **2px 高** 的水平细线，被垂直拉伸成了一个 **300px 高、8px 宽的深灰实心柱**；
   - 当用户悬浮其上时，`.tick:hover` 触发 `width: 32px; background-color: var(--text-primary);`，瞬间变成一个 **300px 高、32px 宽的巨大纯黑方块**，完全遮挡了聊天区域，视觉效果极度突兀与异常。

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

### 3.3 架构级修复方案设计

1. **剥离高度权重与实体刻度**：
   - `flexGrow` 只能应用于不可见的空白定位占位容器（Gap / Spacer）或刻度包装槽（Slot），**严禁直接赋给带背景色的 `<button class="tick">`**。
2. **固定刻度实体物理尺寸**：
   - 刻度实体按钮固定为 `height: 2px`、`border-radius: 1px`，垂直方向使用 `flex: none` 或绝对居中定位，仅在水平方向上随 hover/active 展开（8px → 16px → 24px → 32px）。
3. **保持大面积命中区（Invisible Hitbox）**：
   - 保持 `tick::before` 的隐形命中区（`top: -8px; bottom: -8px; left: -20px; right: 0;`），确保即使刻度线只有 2px 高，用户的鼠标依然可以流畅无障碍地划过触发 Tooltip 和点击跳转，杜绝悬浮脱靶抖动。

### 3.4 代码设计

```css
/* apps/crish-desktop/src/components/chat-message-list/FlowScrubber.module.css */

.wrapper {
  position: absolute;
  top: 0;
  bottom: 0;
  right: calc(var(--scrollbar-thumb-width, 7px) + 2px);
  width: 20px;
  z-index: var(--z-dock, 10);
  pointer-events: none;
  overflow: visible;
}

.root {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 100%;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: flex-end;
  gap: 0; /* 消除默认 gap，完全由比例段精确控制 */
  overflow: visible;
}

/* 刻度包装槽：负责吸收垂直高度比例，本身完全透明无背景 */
.tickSlot {
  width: 100%;
  min-height: 6px;
  flex-shrink: 1;
  flex-basis: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: flex-end;
  pointer-events: none;
}

.gap {
  flex-shrink: 1;
  flex-basis: 0;
  min-height: 0;
  width: 0;
  pointer-events: none;
}

/* 刻度物理实体：始终保持 2px 极简细线，严禁受 flex 纵向拉伸 */
.tick {
  position: relative;
  flex: 0 0 2px;
  height: 2px;
  min-height: 2px;
  max-height: 2px;
  width: 8px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 1px;
  background-color: var(--text-tertiary, rgba(0, 0, 0, 0.25));
  transform-origin: right center;
  cursor: pointer;
  pointer-events: auto;
  appearance: none;
  -webkit-appearance: none;
  display: block;
  box-sizing: border-box;
  transition:
    width var(--transition-smooth),
    background-color var(--transition-smooth);
}

/* 隐形命中区，保证 2px 细线的交互友好 */
.tick::before {
  content: '';
  position: absolute;
  top: -8px;
  bottom: -8px;
  left: -24px;
  right: 0;
  z-index: 1;
}

.tick.isActive {
  background-color: color-mix(in srgb, var(--text-primary) 40%, transparent);
  width: 16px;
}

.root:hover .tick {
  width: 16px;
  background-color: color-mix(in srgb, var(--text-primary) 25%, transparent);
}

.root:hover .tick.isActive {
  width: 24px;
  background-color: color-mix(in srgb, var(--text-primary) 50%, transparent);
}

.tick:hover,
.root:hover .tick:hover {
  background-color: var(--text-primary);
  width: 32px;
  z-index: 10;
}
```

```tsx
// apps/crish-desktop/src/components/chat-message-list/FlowScrubber.tsx 改造

const FlowScrubberTick: React.FC<{
  tick: ScrubberTick;
  tooltip: string;
  onJump: (id: string) => void;
}> = React.memo(function FlowScrubberTick({ tick, tooltip, onJump }) {
  return (
    <div
      className={styles.tickSlot}
      style={{ flexGrow: tick.flex }}
      data-flow-scrubber-slot=""
    >
      <Tooltip content={tooltip} side="left">
        <button
          type="button"
          className={styles.tick}
          data-flow-scrubber-tick=""
          data-msg-id={tick.id}
          data-height-percent={String(tick.heightPercent)}
          aria-label={tooltip}
          onClick={() => onJump(tick.id)}
        />
      </Tooltip>
    </div>
  );
});
```

---

## 四、问题三：Markdown 代码块与目录树原生无样式「复制」按钮压盖文本

### 4.1 源码定位与证据链

- **代码块 HTML 构造**：[`apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts:73`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts#L73)
- **增量解析 HTML 构造**：[`apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParserRender.ts:51-53`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown-render/IncrementalMarkdownParserRender.ts#L51-L53)
- **Rust 内核 Markdown 渲染**：[`crates/conex-markdown/src/renderer.rs:1102`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L1102)
- **事件委托代理**：[`apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts:189-198`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts#L189-L198)
- **样式文件审查**：[`apps/crish-desktop/src/styles/shell/shell-reset.css:56-62`](file:///c:/Software/conex/apps/crish-desktop/src/styles/shell/shell-reset.css#L56-L62)

### 4.2 深度根因推导：HTML 管道输出语义类名但样式层完全缺失

1. **HTML 生成层的完备构造**：
   在 `markdownCodeFence.ts:73` 及 Rust 渲染器 `crates/conex-markdown/src/renderer.rs:1102` 中，渲染器产出的 DOM 结构为：
   ```html
   <div class="md-code-block" data-lang="typescript">
     <span class="md-code-breadcrumb">src/foo.ts</span>
     <span class="md-code-lang" data-lang="typescript" aria-label="typescript">typescript</span>
     <button type="button" class="md-code-copy" aria-label="复制代码">复制</button>
     <pre class="md-code-pre hljs"><code class="language-typescript">...</code></pre>
   </div>
   ```
2. **样式层断裂与 UA 样式逃逸**：
   - 经全面检索，在全仓所有 CSS 文件中，针对 `.md-code-copy`、`.md-code-block`、`.md-code-lang`、`.md-code-breadcrumb` **没有任何有效的定位与视效 CSS 规则**（仅在 `shell-reset.css:56` 处声明了 `font-weight: 400; tab-size: 2;`）。
   - 浏览器直接以原生 User Agent 样式渲染 `<button class="md-code-copy">`（带有凹凸白灰立体边框、系统字体、内边距）。
   - 并且由于父容器 `.md-code-block` 未声明 `position: relative` 与正确的 flex/grid 容器属性，`<button class="md-code-copy">` 作为常规行内块元素直接掉落在文档流中，排在 `<pre>` 之前或强行压在 `<pre>` 文本内容第一行上。
   - 当渲染目录树（如 ````filetree` 或 ascii 格式的代码块）时，原生灰底「复制」按钮直接覆盖在目录树顶部首行文件名上，彻底破坏了等宽字符排版。

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

### 4.3 架构级修复方案设计

1. **建立全局 Markdown 视效样式体系（`styles/markdown.css`）**：
   - 规范 `.md-code-block` 容器为 `position: relative; border-radius: var(--radius-lg); overflow: hidden;`。
   - 规范 `.md-code-pre` 容器为 `margin: 0; padding: 12px 14px; overflow-x: auto; font-family: var(--font-mono);`。
2. **右上角悬浮复制胶囊（Floating Copy Action）**：
   - `.md-code-copy` 设置绝对定位 `position: absolute; top: 8px; right: 8px; z-index: 2;`。
   - 样式对齐设计规范：透明背景、轻量悬浮遮罩、柔和圆角（`border-radius: var(--radius-sm)`）、字号 11px，默认半透明或 hover 时渐显，点击时与 `useChatMessageState.ts` 复制事件联动，彻底脱离文本流，绝不挤占任何代码与目录树空间。
3. **语言 Badge 与路径面包屑规范**：
   - `.md-code-breadcrumb` 与 `.md-code-lang` 统合在顶部 Header 条或左上角，与右上角复制按钮形成对称美观的工程级代码卡片。

### 4.4 代码设计

在 `apps/crish-desktop/src/styles/` 新增或并在 `design-system.css` / `index.css` 载入标准 Markdown 样式契约：

```css
/* apps/crish-desktop/src/styles/markdown.css (或合并入 index.css) */

.md-rendered {
  line-height: var(--line-height-body, 1.6);
  color: var(--text-primary);
}

/* 代码块容器：相对定位包含块 */
.md-code-block {
  position: relative;
  margin: var(--space-3, 12px) 0;
  border-radius: var(--radius-lg, 8px);
  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  background: var(--bg-secondary, rgba(0, 0, 0, 0.02));
  overflow: hidden;
  box-sizing: border-box;
}

/* 顶部信息栏（如有路径面包屑或语言徽标） */
.md-code-breadcrumb {
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

.md-code-breadcrumb-separator {
  color: var(--text-tertiary);
  margin: 0 2px;
}

.md-code-breadcrumb-file {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium, 500);
}

.md-code-lang {
  position: absolute;
  top: 8px;
  right: 64px;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
  pointer-events: none;
  user-select: none;
  opacity: 0.7;
}

/* 复制按钮：绝对定位悬浮于右上角，彻底脱离文本排版流 */
.md-code-copy {
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
  color: var(--text-tertiary);
  background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
  backdrop-filter: blur(4px);
  border: 1px solid var(--hairline, var(--border-subtle));
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  opacity: 0;
  transform: translateY(-1px);
  transition:
    opacity var(--transition-fast, 120ms ease),
    background var(--transition-fast, 120ms ease),
    color var(--transition-fast, 120ms ease),
    border-color var(--transition-fast, 120ms ease);
  user-select: none;
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.04));
}

/* 悬浮代码块时渐现复制按钮，保持界面极简 */
.md-code-block:hover .md-code-copy,
.md-code-copy:focus-visible {
  opacity: 1;
}

.md-code-copy:hover {
  color: var(--text-primary);
  background: var(--bg-elevated);
  border-color: var(--border-color);
}

.md-code-copy:active {
  transform: translateY(0);
}

/* 代码正文 pre */
.md-code-pre {
  margin: 0;
  padding: 10px 14px;
  overflow-x: auto;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xs, 12px);
  line-height: 1.55;
  tab-size: 2;
  -moz-tab-size: 2;
  white-space: pre;
  word-break: normal;
  scrollbar-width: thin;
}

.md-code-pre code {
  font-family: inherit;
  font-size: inherit;
  background: transparent;
  padding: 0;
  border: none;
}
```

---

## 五、问题四：消息卡片操作按钮尺寸样式冲突与右上角悬空提示气泡

### 5.1 源码定位与证据链

- **助理消息操作栏**：[`apps/crish-desktop/src/components/chat-message-row/AssistantMessageActionsBar.tsx:41-80`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/AssistantMessageActionsBar.tsx#L41-L80)
- **用户消息操作栏**：[`apps/crish-desktop/src/components/chat-message-row/UserMessageActionsBar.tsx:37-62`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/UserMessageActionsBar.tsx#L37-L62)
- **思维链操作栏与悬浮按钮**：[`apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx:148-158`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.tsx#L148-L158)
- **消息行样式模块**：[`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:288-310`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L288-L310) 及 [`ChatMessageRow.module.css:580-605`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L580-L605)
- **Button 原子组件**：[`apps/crish-desktop/src/components/ui/Button/Button.tsx:53-100`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx#L53-L100) 及 [`Button.module.css:8-48, 94-102`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L8-L48)
- **Tooltip 提示组件**：[`apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx:202-234, 380-409`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx#L202-L234)

### 5.2 深度根因推导：CSS Modules 特异度冲突与透明不可见触发器事件泄露

1. **按钮尺寸矩形畸变（Specificty & Metric Clash）**：
   - 在 `AssistantMessageActionsBar.tsx:42` 与 `UserMessageActionsBar.tsx:38` 中，开发者错误地将常规文字按钮 `<Button>` 混用为图标按钮：
     ```tsx
     <Button
       type="button"
       variant="ghost"
       size="sm"
       className={`${styles.iconBtn}${copied ? ` ${styles.isCopied}` : ''}`}
       icon={copied ? <Check size={14} /> : <Copy size={14} />}
     />
     ```
   - 渲染出的 DOM class 包含：`Button_button__... Button_buttonGhost__... Button_buttonSm__... ChatMessageRow_iconBtn__...`。
   - `Button.module.css` 的 `.buttonSm` 强制设置：
     ```css
     --btn-h: 28px;
     --btn-px: 10px; /* 左右内边距各 10px，共 20px */
     ```
   - 而 `ChatMessageRow.module.css` 的 `.iconBtn` 设置：
     ```css
     width: 22px;
     height: 22px;
     padding: 0;
     ```
   - 由于两个 CSS Module 生成的类名具有相同的选择器特异度 `(0, 1, 0)`，打包顺序导致属性互相覆盖：
     - `width: 22px` 生效，但 `height: 28px` 生效，导致按钮变成 **22px 宽 × 28px 高的瘦高怪异矩形**；
     - 若 `padding: 0 10px` 覆盖了 `padding: 0`，则 22px 的按钮被左右各 10px 内边距夹击，**中间只剩 2px 物理空间**，导致 14px 的 SVG 图标被严重挤压变形或发生溢出。
   - 而同一操作栏中的其它按钮（如原生 `<button className={styles.iconBtn}>` 或 20px 的 `thoughtExpandModalBtn`）尺寸为 22px/20px，导致整排图标高低不平、错位明显。

2. **右上角悬空突兀提示气泡（Ghost Tooltip Triggering）**：
   - 在 `TimelineThoughtSection.tsx:148-157` 中：
     ```tsx
     <Tooltip content="在沉浸式查阅器中查看完整思维链">
       <button
         type="button"
         className={styles.thoughtExpandModalBtn}
         onClick={handleOpenInspector}
         aria-label="查看完整思考链"
       >
         <Maximize2 size={12} />
       </button>
     </Tooltip>
     ```
   - 在 `ChatMessageRow.module.css:580-604` 中：
     ```css
     .thoughtExpandModalBtn {
       position: relative;
       margin-left: auto; /* 靠在消息卡片/思维链的最右上角 */
       opacity: 0; /* 默认完全透明隐藏 */
       /* 遗漏了 pointer-events: none; ! */
     }
     .thoughtTimelineSection:hover .thoughtExpandModalBtn {
       opacity: 1;
     }
     ```
   - **致命事件穿透**：
     - 当用户在思维链折叠栏上方移动鼠标（甚至只是鼠标路过卡片右上角）时，鼠标移动到了这个 `opacity: 0` 的隐形元素上方；
     - 此时由于没有设置 `pointer-events: none`，该元素正常响应 `mouseenter` 事件；
     - `<Tooltip>` 捕获到 `onMouseEnter`，在 `Tooltip.tsx:202-234` 中唤醒定时器并在 DOM 根节点通过 Portal 挂载了提示气泡；
     - 此时由于触发器按钮本身是透明不可见的（`opacity: 0`），用户看到的是**在卡片右上角的虚无空白处凭空悬浮出了一个提示气泡**（「在沉浸式查阅器中查看完整思维链」），视觉感受极度突兀和破损。

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

### 5.3 架构级修复方案设计

1. **全面接入标准 `IconButton` 原子组件**：
   - 彻底废除 `<Button className={styles.iconBtn}>` 拼装写法；
   - 统一采用项目中已规范实现的 `@/components/ui/Button/IconButton`，声明 `size="xs"`（24px × 24px）或 `size="sm"`（28px × 28px），确保 `width === height === var(--btn-h)` 且 `padding: 0` 严格恒等，图标居中尺寸为精确的 14px/16px。
2. **状态驱动的触发器事件拦截（Event Gating）**：
   - 对于所有默认透明、hover 显现的次级操作按钮（如 `.thoughtExpandModalBtn`、`.userMeta`、`.assistantMeta` 等），必须严格遵循：
     - 默认态：`opacity: 0; pointer-events: none;`
     - 激活/悬浮态：`opacity: 1; pointer-events: auto;`
   - 彻底切断不可见元素向 Tooltip 控制器发送 `mouseenter` 事件的通道。
3. **Tooltip 挂载保护（Visibility Guard）**：
   - 在 `Tooltip.tsx` 的 `commitShow` 中加入可见性前置断言：当触发器元素的计算样式 `opacity === '0'` 或 `visibility === 'hidden'` 或 `display === 'none'` 时，拒绝唤起 Portal。

### 5.4 代码设计

```tsx
// apps/crish-desktop/src/components/chat-message-row/AssistantMessageActionsBar.tsx

import React from 'react';
import { Check, Copy, PinOff, RefreshCw } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { IconButton } from '../ui/Button/IconButton';
import { formatMsgTime, pinToggleLabels } from './chatMessageRowUtils';
import { RetractActionButton } from './RetractActionButton';

export const AssistantMessageActionsBar: React.FC<AssistantMessageActionsBarProps> = ({
  timestamp,
  copied,
  isLastAssistant,
  isPinned,
  onCopy,
  onRegenerate,
  onTogglePin,
  sendToNoteNode,
  metricsNode,
  onRetract,
}) => {
  const pinLabels = pinToggleLabels(isPinned);
  return (
    <div className={styles.assistantMeta}>
      <span className={styles.time}>{formatMsgTime(timestamp)}</span>
      
      {/* 统一采用 IconButton xs 档 (24x24px)，自带 Tooltip 包裹与 a11y 契约 */}
      <IconButton
        variant="ghost"
        size="xs"
        tooltip={copied ? '已复制' : '复制正文'}
        aria-label={copied ? '已复制' : '复制正文'}
        className={copied ? styles.isCopied : undefined}
        onClick={onCopy}
        icon={copied ? <Check size={14} /> : <Copy size={14} />}
      />

      {isLastAssistant ? (
        <IconButton
          variant="ghost"
          size="xs"
          tooltip="重新生成"
          aria-label="重新生成"
          onClick={onRegenerate}
          icon={<RefreshCw size={14} />}
        />
      ) : null}

      {onRetract ? <RetractActionButton onRetract={onRetract} /> : null}
      {sendToNoteNode}

      {isPinned ? (
        <IconButton
          variant="ghost"
          size="xs"
          tooltip={pinLabels.title}
          aria-label={pinLabels.ariaLabel}
          className={styles.isPinnedActive}
          aria-pressed
          onClick={onTogglePin}
          icon={<PinOff size={14} />}
        />
      ) : null}

      {metricsNode ? (
        <span className={styles.cacheMetricsInline}>{metricsNode}</span>
      ) : null}
    </div>
  );
};
```

```css
/* apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css 修正 */

.userMeta,
.assistantMeta {
  display: flex;
  align-items: center;
  gap: var(--space-0_5, 2px);
  min-height: 24px;
  opacity: 0;
  pointer-events: none; /* 默认隐藏时不响应鼠标事件 */
  transition: opacity var(--transition-fast);
}

.userStack:hover .userMeta,
.rowAssistant:hover .assistantMeta,
.userMeta:focus-within,
.assistantMeta:focus-within {
  opacity: 1;
  pointer-events: auto; /* 悬浮或子项获得键盘焦点时才允许交互 */
}

.thoughtExpandModalBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm, 4px);
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  pointer-events: none; /* 修复：透明状态下严禁接收事件触发 Tooltip */
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
  flex-shrink: 0;
  margin-left: auto;
}

.thoughtTimelineSection:hover .thoughtExpandModalBtn,
.thoughtExpandModalBtn:focus-visible {
  opacity: 1;
  pointer-events: auto; /* 悬浮容器或键盘 Tab 导航时激活 */
}
```

```typescript
// apps/crish-desktop/src/components/ui/Tooltip/Tooltip.tsx 增加可见性护栏

const commitShow = (el: HTMLElement) => {
  if (disabledRef.current || !contentRef.current) return;
  if (isTooltipMuted()) return;

  // 增加物理可见性守卫：透明或隐藏元素严禁弹出 Tooltip
  const style = window.getComputedStyle(el);
  if (
    style.opacity === '0' ||
    style.visibility === 'hidden' ||
    style.display === 'none' ||
    style.pointerEvents === 'none'
  ) {
    return;
  }

  const currentRect = el.getBoundingClientRect();
  if (!isValidDOMRect(currentRect) || isTriggerOffscreen(currentRect)) {
    return;
  }
  if (!claimTooltipSlot(tipId)) return;
  childElRef.current = el;
  setRect(currentRect);
  setVisible(true);
};
```

---

## 六、设计系统规范契约与防回归断言

### 6.1 按钮尺寸与几何规范契约

| 档位 | 尺寸规格 (正方形) | 图标尺寸 (Icon Size) | 适用场景 | 契约组件 |
| :--- | :--- | :--- | :--- | :--- |
| **xs** | `24px × 24px` | `14px × 14px` | 消息行操作栏、思维链操作按钮、紧凑表格行内动作 | `<IconButton size="xs" />` |
| **sm** | `28px × 28px` | `16px × 16px` | 侧栏动作按钮、次级工具栏、Composer 辅助按钮 | `<IconButton size="sm" />` |
| **md** | `32px × 32px` | `18px × 18px` | 窗口控制区、全局 Tab 栏主要操作 | `<IconButton size="md" />` |
| **lg** | `40px × 40px` | `20px × 20px` | 独立大型浮动操作栏、强调主操作 | `<IconButton size="lg" />` |

- **铁律 1**：任何图标按钮禁止使用 `<Button className="...">` 覆盖宽高，必须使用 `<IconButton size="..." />`。
- **铁律 2**：普通按钮与图标按钮禁止 `border-radius: 9999px` 椭圆药丸化（除特殊胶囊芯片外），统一遵循 `--button-radius: 7px`。

### 6.2 浮层与 Tooltip 安全铁律

1. **零幽灵触发（No Ghost Triggers）**：所有 `opacity: 0` 的视觉隐藏元素必须同步附带 `pointer-events: none`。
2. **Portal 几何先行（Geometry-First Mounting）**：Tooltip Portal 必须在 `clampedPos` 经 `useLayoutEffect` 计算有效后方可展示，严禁在 `(0,0)` 瞬态渲染导致跳变。
3. **单实例互斥（Single Slot Claim）**：跨组件 Tooltip 必须通过 `tooltipController` 单槽抢占，菜单打开或视口滚动时立即全量消退。

### 6.3 动态布局与响应式测量铁律

1. **施密特滞后阈值（Hysteresis Gap >= 24px）**：任何基于内容尺寸在单行/多行、折叠/展开之间动态切换的组件，其反向收起阈值必须低于正向展开阈值至少 24px，严禁零死区等值切换。
2. **零 DOM 污染测量（Zero-DOM-Mutation Measuring）**：文字宽度计算统一走全局单例 Canvas `measureText` 引擎，严禁在 `ResizeObserver` 或渲染周期内动态 `appendChild`/`removeChild`。

### 6.4 自动化验证与防回归测试清单

```typescript
// 建议新增的防回归单元测试断言

describe('Layout & Visual Regression Guardrails', () => {
  it('useComposerMultiline: 临界值文本不会发生连续震荡', () => {
    // 模拟临界容量边界
    // 断言多次 ResizeObserver 触发后 multiline 状态保持单调稳定
  });

  it('FlowScrubber: 刻度高度始终为 2px 且不带有非零 flex-basis', () => {
    // 渲染包含 1000px 大消息的列表
    // 断言 .tick 计算样式 height === '2px'，flexGrow === 0
  });

  it('Markdown: 代码块包含规范的 .md-code-copy 且位于绝对定位右上角', () => {
    // 渲染包含目录树的代码块
    // 断言 .md-code-copy 具有 position: absolute 且 top/right 属性有效
  });

  it('IconButton: 消息操作栏按钮长宽严格等比例为 24px', () => {
    // 渲染 AssistantMessageActionsBar
    // 断言所有按钮 boundingClientRect width === height === 24
  });
});
```
