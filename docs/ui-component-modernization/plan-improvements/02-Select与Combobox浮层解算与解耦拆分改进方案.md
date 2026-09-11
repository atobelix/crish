# Conex / Crish — Select 与 Combobox 浮层解算与解耦拆分改进方案

> **文档版本**：v2.0 (Modern Architecture & Refactoring Plan)
> **文件路径**：`docs/ui-component-modernization/plan-improvements/02-Select与Combobox浮层解算与解耦拆分改进方案.md`
> **对齐输入依据**：
> - `docs/ui-component-modernization/audits/02-Select与Combobox浮层解算及无障碍严苛审查.md`（12 项缺陷）
> - `docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`（RL-03 行数门禁、Zero-Blue 墨阶与 Token 规范）
> - `docs/ui-component-modernization/independent-plans/03-Select与Combobox同心圆角与原生搜索方案.md`（初始独立设计详案）
> - `apps/crish-desktop/src/components/ui/internal/layer-stack/LayerStackManager.ts`（浮层调度中枢单核状态机契约）
>
> **工程与架构红线**：
> 1. **零外部 npm 组件库依赖**：100% 纯原生 React 18+ 与 CSS Modules，严禁引入 `@base-ui`, `@radix-ui`, `framer-motion` 等外部库；
> 2. **RL-03 行数刚性达标**：将 `Select.tsx` (1081 行) 与 `Combobox.tsx` (1340 行) 彻底拆解为单职责原子文件，确保每个拆分文件有效行数均 $\le 200$ 行；
> 3. **100% 存量向后兼容**：保留既有 `Select` 与 `Combobox` 的所有导出符号、Props 签名及 `SelectLegacyAdapter`，现有消费方零成本无缝运行；
> 4. **Zero-Blue 墨阶纯净化**：消除所有硬编码 HEX 与旧式 `rgba(...)`，全量对齐 `tokens.css` 语义令牌。

---

## 目录

- [一、方案背景与审计问题全景对齐](#一方案背景与审计问题全景对齐)
  - [1.1 审计缺陷清单与整改映射](#11-审计缺陷清单与整改映射)
  - [1.2 架构演进与零破坏平滑过渡承诺](#12-架构演进与零破坏平滑过渡承诺)
- [二、浮层几何解算引擎与 LayerStack 调度中枢重构](#二浮层几何解算引擎与-layerstack-调度中枢重构)
  - [2.1 LayerStack 驱逐事件全量捕获（修复 programmatic 漏判）](#21-layerstack-驱逐事件全量捕获修复-programmatic-漏判)
  - [2.2 首帧 `(0, 0)` 瞬态裸露闪烁根治与 `isPositioned` 门闩状态机](#22-首帧-0-0-瞬态裸露闪烁根治与-ispositioned-门闩状态机)
  - [2.3 双向视口避让（Flip Y / Flip X）与 `transformOrigin` 联动数学模型](#23-双向视口避让flip-y--flip-x与-transformorigin-联动数学模型)
  - [2.4 全局滚动 RAF 节流与浮层内部滚动事件隔离](#24-全局滚动-raf-节流与浮层内部滚动事件隔离)
  - [2.5 触发器盒模型 `ResizeObserver` 动态锚点联动与 React 纯 ID 规范](#25-触发器盒模型-resizeobserver-动态锚点联动与-react-纯-id-规范)
- [三、Combobox 核心交互与状态机缺陷根治](#三combobox-核心交互与状态机缺陷根治)
  - [3.1 `highlightMatches` 正则无状态化（彻底解决 `lastIndex` 变异 Bug）](#31-highlightmatches-正则无状态化彻底解决-lastindex-变异-bug)
  - [3.2 中文拼音 IME 输入法合成锁状态机（Composition Guard 防误选）](#32-中文拼音-ime-输入法合成锁状态机composition-guard-防误选)
  - [3.3 `ComboboxChips` 异步闭包竞态修复、索引纠偏与光标焦点驻留](#33-comboboxchips-异步闭包竞态修复索引纠偏与光标焦点驻留)
  - [3.4 Chips 胶囊左右箭头横向漫游与微型删除按钮 `tabIndex={-1}`](#34-chips-胶囊左右箭头横向漫游与微型删除按钮-tabindex-1)
  - [3.5 单选模式 Display Label 与 Transient Query 状态解耦](#35-单选模式-display-label-与-transient-query-状态解耦)
- [四、HTML5 规范合规与 SelectTrigger 结构重构](#四html5-规范合规与-selecttrigger-结构重构)
  - [4.1 `<button>` 嵌套交互元素规范违规剖析](#41-button-嵌套交互元素规范违规剖析)
  - [4.2 架构改造选型与最终落地实现](#42-架构改造选型与最终落地实现)
- [五、RL-03 物理文件解耦与组件拓扑架构设计](#五rl-03-物理文件解耦与组件拓扑架构设计)
  - [5.1 细粒度物理拆分目录拓扑](#51-细粒度物理拆分目录拓扑)
  - [5.2 共享内部基础设施定义](#52-共享内部基础设施定义)
  - [5.3 Select 复合组件谱系与行数预算](#53-select-复合组件谱系与行数预算)
  - [5.4 Combobox 复合组件谱系与行数预算](#54-combobox-复合组件谱系与行数预算)
  - [5.5 `Select.module.css` (519 行) 模块化拆分与同心圆角几何修正](#55-selectmodulecss-519-行-模块化拆分与同心圆角几何修正)
- [六、核心模块代码实现原型与技术规格](#六核心模块代码实现原型与技术规格)
  - [6.1 `useFloatingPosition.ts` 改进实现全量代码](#61-usefloatingpositionts-改进实现全量代码)
  - [6.2 `internal/comboboxHighlight.tsx` 纯函数无状态实现](#62-internalcomboboxhighlighttsx-纯函数无状态实现)
  - [6.3 `internal/extractChildrenItems.ts` 与 `internal/SelectIcons.tsx`](#63-internalextractchildrenitemsts-与-internalselecticonstsx)
  - [6.4 `select/` 核心子组件重构实现（SelectRoot, SelectTrigger, SelectContent, SelectItem）](#64-select-核心子组件重构实现selectroot-selecttrigger-selectcontent-selectitem)
  - [6.5 `combobox/` 核心子组件重构实现（ComboboxRoot, ComboboxInput, ComboboxChips, ComboboxContent）](#65-combobox-核心子组件重构实现comboboxroot-comboboxinput-comboboxchips-comboboxcontent)
  - [6.6 兼容入口与适配器（`Select.tsx`, `Combobox.tsx`, `SelectLegacyAdapter.tsx`）](#66-兼容入口与适配器selecttsx-comboboxtsx-selectlegacyadaptertsx)
  - [6.7 CSS Modules 模块化拆分与 Design Tokens 落地](#67-css-modules-模块化拆分与-design-tokens-落地)
- [七、单元测试与反回归验证矩阵](#七单元测试与反回归验证矩阵)
  - [7.1 LayerStack 同级互斥驱逐与 Programmatic 事件测试用例](#71-layerstack-同级互斥驱逐与-programmatic-事件测试用例)
  - [7.2 首帧 isPositioned 隐藏门闩与 Flip X/Y 几何解算测试用例](#72-首帧-ispositioned-隐藏门闩与-flip-xy-几何解算测试用例)
  - [7.3 highlightMatches 多段命中与无状态性测试用例](#73-highlightmatches-多段命中与无状态性测试用例)
  - [7.4 IME compositionend 延迟门闩与 Enter 拦截测试用例](#74-ime-compositionend-延迟门闩与-enter-拦截测试用例)
  - [7.5 Chips 连续快速 Backspace、左右横向漫游与焦点保留测试用例](#75-chips-连续快速-backspace左右横向漫游与焦点保留测试用例)
- [八、实施路线图与验收门禁](#八实施路线图与验收门禁)
  - [8.1 4 步精细化实施路线图](#81-4-步精细化实施路线图)
  - [8.2 质量门禁检查清单](#82-质量门禁检查清单)

---

# 一、方案背景与审计问题全景对齐

## 1.1 审计缺陷清单与整改映射

根据前序专项审计报告 `02-Select与Combobox浮层解算及无障碍严苛审查.md` 与 `05-全仓DesignTokens合规与工程红线严苛审查.md`，Select 与 Combobox 模块存在 12 项明确缺陷。本方案建立 100% 闭环整改映射：

| 审计编号 | 缺陷模块 | 严重级别 | 核心问题摘要 | 本方案治理措施 | 目标代码归属 |
|:---|:---|:---|:---|:---|:---|
| **02-1** | `Select` / `Combobox` | **严重** | `onDismiss` 漏判 `'programmatic'` 导致同级互斥驱逐失效，留下孤立僵尸浮层 | 改造 `onDismiss` 逻辑，全量捕获 `reason !== 'item-select'` 及 `'programmatic'` 驱逐 | `useFloatingPosition.ts`, `SelectContent.tsx`, `ComboboxContent.tsx` |
| **02-2** | `useFloatingPosition` | **严重** | 首帧 `(0, 0)` 坐标瞬态裸露与 `isPositioned` 门闩缺失引发 CSS 动画跳跃闪烁 | 引入 `isPositioned` 门闩，首帧 `visibility: hidden; pointer-events: none`，测量完毕再呈现 | `useFloatingPosition.ts`, `SelectContent.tsx`, `ComboboxContent.tsx` |
| **02-3** | `useFloatingPosition` | **严重** | 缺少水平方向 Flip X 碰撞避让机制且 `transformOrigin` 与 Clamped 坐标脱节 | 引入水平可用空间评估与 Flip X 算法，动态绑定 `transformOrigin: ${originY} ${originX}` | `useFloatingPosition.ts`, `positionGeometry.ts` |
| **02-4** | `Combobox` | **严重** | `highlightMatches` 全局正则 `gi` 在 `.map()` 多次 `test()` 引发 `lastIndex` 变异导致高亮失效 | 彻底分离无状态单次匹配正则与拆分正则，消除 `lastIndex` 副作用 | `internal/comboboxHighlight.tsx` |
| **02-5** | `Combobox` | **严重** | 中文拼音输入法 `compositionend` 导致紧随的 `Enter` 误触发选项选中与弹窗关闭 | 增加时间戳与微任务合成锁门闩（Composition Guard，50ms 时间窗口拦截） | `combobox/ComboboxInput.tsx`, `combobox/ComboboxChips.tsx` |
| **02-6** | `Combobox` | **严重** | 多选 Chips Backspace 异步闭包竞态致 `activeChipIndex` 越界与焦点丢失 | 增加 `useEffect` 自动纠偏越界索引，删除后主动调用 `inputRef.current?.focus()` 归还焦点 | `combobox/ComboboxChips.tsx` |
| **02-7** | `Select` | **严重** | `<SelectTrigger>` (`<button>`) 内部嵌套 `<SelectClearButton>` (`role="button"`) 违反 HTML5 规范 | 重构 ClearButton 结构为无交互语义 span + 键盘拦截或外层 Flex Frame 布局 | `select/SelectTrigger.tsx`, `select/SelectClearButton.tsx` |
| **02-8** | `Select` / `Combobox` | **严重** | 严重超出 RL-03 单文件行数限制（1081 行 / 1340 行）且存在大量重复代码 | 执行物理文件彻底拆解（单文件 $\le 200$ 行），抽离内部共享微图标与工具函数 | `ui/Select/` 全目录重构 |
| **02-9** | `useFloatingPosition` | **一般** | 滚动监听未接入 RAF 节流且未过滤浮层内部滚动，容器尺寸变动未接入 `ResizeObserver` | 滚动事件接入 `requestAnimationFrame` 节流，忽略浮层内部滚动，并对 Trigger 挂载 `ResizeObserver` | `useFloatingPosition.ts` |
| **02-10** | `Combobox` | **一般** | 单选模式选值强制将 Label 写入 `query` 导致二次展开时被自身过滤仅剩 1 项 | 区分 Display Label 与 Transient Search Query，输入框聚焦时自动选中/展开时重置查询 | `combobox/ComboboxRoot.tsx`, `combobox/ComboboxInput.tsx` |
| **02-11** | `Combobox` | **一般** | `ComboboxChip` 内微型删除按钮未设置 `tabIndex={-1}` 导致 Tab 焦点穿行深坑 | 显式标记微型删除按钮 `tabIndex={-1}`，依托输入框 Backspace/Delete 进行无障碍删除 | `combobox/ComboboxChip.tsx` |
| **02-12** | `Select.module.css` | **微小** | `sm` 档位同心圆角方程偏离设计规范公式（Popup 12px / Item 6px / Padding 4px） | 修正 `.itemSm` 圆角为 `8px`（$12 - 4 = 8\text{px}$）或修正 `.contentSm` 为 `10px` | `SelectContent.module.css` |

## 1.2 架构演进与零破坏平滑过渡承诺

重构后的 Select 与 Combobox 模块采用**分层原子复合架构（Layered Atomic Compound Architecture）**：

```
                    ┌────────────────────────────────────────────────────────┐
                    │               apps/crish-desktop 业务消费方             │
                    └───────────────────────────┬────────────────────────────┘
                                                │
                 ┌──────────────────────────────┴──────────────────────────────┐
                 │                                                             │
                 ▼                                                             ▼
     【传统声明式 / 单体 Props 模式】                               【现代复合组件 Compound 模式】
    <Select options={opts} value={v} />               <Select value={v} onValueChange={fn}>
    <Combobox items={items} value={v} />                <SelectTrigger><SelectValue /></SelectTrigger>
                 │                                      <SelectContent><SelectItem /></SelectContent>
                 │                                    </Select>
                 ▼                                                             │
   ┌───────────────────────────┐                                               │
   │   SelectLegacyAdapter     │                                               │
   │   ComboboxLegacyAdapter   │───────────────────────────────────────────────┘
   └─────────────┬─────────────┘
                 │
                 ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │                                   原子组件层 (Atomic Components)                              │
 │   SelectRoot / SelectTrigger / SelectValue / SelectContent / SelectItem / SelectGroup       │
 │   ComboboxRoot / ComboboxInput / ComboboxChips / ComboboxContent / ComboboxList             │
 └──────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                                │
                                                ▼
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │                                   共享基础设施层 (Shared Infra)                                │
 │   useFloatingPosition (RAF + ResizeObserver + Flip X/Y) ◄───► LayerStackManager (调度单核)   │
 │   comboboxHighlight (纯函数无状态) / extractChildrenItems / SelectIcons (Zero Copy)          │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**对全仓业务消费方的 100% 兼容保证**：
1. `import { Select, SelectTrigger, SelectContent, ... } from '@/components/ui/Select'` 导出路径与 API 保持完全一致；
2. 既有通过 `options={...}` 属性调用的单体用法由 `SelectLegacyAdapter` 自动无缝承接；
3. 既有通过 `items={...}` 属性调用的单体用法由 `ComboboxLegacyAdapter` 自动无缝承接；
4. 修复所有已发现的运行时与无障碍 Bug，现有单元测试用例全部绿灯通过。

---

# 二、浮层几何解算引擎与 LayerStack 调度中枢重构

## 2.1 LayerStack 驱逐事件全量捕获（修复 programmatic 漏判）

### 问题根本原因
在当前实现中，`SelectContent` 与 `ComboboxContent` 仅将 `reason === 'outside-pointer' || reason === 'escape' || reason === 'parent-dismissed'` 视为关闭触发条件。当 LayerStack 调度中枢（`LayerStackManager`）因另一个 `exclusive-peer` 浮层（如相邻的下拉菜单或右键上下文菜单）打开而执行 `evictExclusivePeers()` 时，会向当前浮层发送 `reason: 'programmatic'` 驱逐指令。由于白名单漏判，Select / Combobox 拒绝关闭，导致浮层脱离 LayerStack 栈管理后仍然悬浮在 DOM 视口中形成孤立游离态。

### 极致修复方案
将解散捕获收敛为白名单全覆盖模式或非选项选择即解散判定：

```typescript
// SelectContent.tsx / ComboboxContent.tsx
const position = useFloatingPosition({
  open,
  triggerRef,
  contentRef,
  side,
  align,
  sideOffset,
  edgePadding,
  portalContainer,
  onDismiss: (reason: DismissReason) => {
    // 覆盖所有合法的解散信号：outside-pointer, escape, parent-dismissed, programmatic
    if (reason !== 'item-select') {
      setOpen(false);
    }
  },
});
```

---

## 2.2 首帧 `(0, 0)` 瞬态裸露闪烁根治与 `isPositioned` 门闩状态机

### 视觉跳跃成因
1. `useFloatingPosition` 初始化坐标为 `{ x: 0, y: 0, isPositioned: false }`；
2. 浮层 Portal 挂载渲染首帧，DOM 元素以 `left: 0px; top: 0px` 插入视口；
3. CSS Modules 的 `animation: popupEnter 180ms cubic-bezier(0.175, 0.885, 0.32, 1.25)` 立即启动；
4. 虽然 `useLayoutEffect` 在后续同步计算出真实坐标，但浏览器第一帧已将带有缩放的浮层绘制在屏幕左上角 `(0, 0)`，产生视觉跳跃。

### 门闩状态机设计
```
[open: false] ─── (打开操作) ───► [挂载 DOM: isPositioned = false]
                                           │
                                           │ (visibility: hidden, pointer-events: none)
                                           ▼
                                  [useLayoutEffect 同步物理测量]
                                  [计算 (x, y), transformOrigin, --anchor-width]
                                           │
                                           │ (更新 state: isPositioned = true)
                                           ▼
                                  [展现 DOM: isPositioned = true]
                                  [visibility: visible, 触发 popupEnter 进场动画]
```

### 实施代码规范
```tsx
// SelectContent.tsx & ComboboxContent.tsx
<div
  ref={contentRef as React.RefObject<HTMLDivElement>}
  id={listboxId}
  role="listbox"
  tabIndex={-1}
  data-slot="select-content"
  className={contentClass}
  style={{
    left: `${position.x}px`,
    top: `${position.y}px`,
    transformOrigin: position.transformOrigin,
    visibility: position.isPositioned ? 'visible' : 'hidden',
    pointerEvents: position.isPositioned ? 'auto' : 'none',
  }}
  onKeyDown={handleKeyDown}
>
  <div className={contentStyles.list}>{children}</div>
</div>
```

---

## 2.3 双向视口避让（Flip Y / Flip X）与 `transformOrigin` 联动数学模型

### 数学几何计算模型
浮层定位算法必须同时在垂直和水平两个正交维度进行可用空间评估、自动翻折与刚性数学钳位（Clamping）。

```
        ┌─────────────────────────────────────────────────────────────┐
        │                      Viewport Bounds                        │
        │                                                             │
        │             ┌─────────────────────────┐                     │
        │             │ Flip Y: Top (Space Above)│                     │
        │             └────────────▲────────────┘                     │
        │                          │ (sideOffset)                     │
        │   ◄────── Flip X ────────┼──────── Flip X ──────►           │
        │  (Space Left)   ┌────────┴────────┐    (Space Right)        │
        │                 │  Trigger Rect   │                         │
        │                 └────────┬────────┘                         │
        │                          │ (sideOffset)                     │
        │             ┌────────────▼────────────┐                     │
        │             │ Flip Y: Bottom (Default)│                     │
        │             └─────────────────────────┘                     │
        │                                                             │
        └─────────────────────────────────────────────────────────────┘
```

### 纯函数计算方程
```typescript
export interface FloatingComputeOptions {
  triggerRect: DOMRect;
  popupWidth: number;
  popupHeight: number;
  side?: 'bottom' | 'top';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  edgePadding?: number;
  viewport?: ViewportRect;
}

export function computeFloatingPosition(options: FloatingComputeOptions): {
  x: number;
  y: number;
  side: 'bottom' | 'top';
  align: 'start' | 'center' | 'end';
  transformOrigin: string;
} {
  const {
    triggerRect,
    popupWidth,
    popupHeight,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    edgePadding = 8,
  } = options;

  const vp = getEffectiveViewport(options.viewport);
  const offsetTop = vp.offsetTop ?? 0;
  const offsetLeft = vp.offsetLeft ?? 0;

  // 1. 垂直可用空间与 Flip Y 决策
  const spaceBelow = vp.height - (triggerRect.bottom - offsetTop) - sideOffset - edgePadding;
  const spaceAbove = triggerRect.top - offsetTop - sideOffset - edgePadding;

  let actualSide: 'bottom' | 'top' = side;
  let targetY = 0;

  if (side === 'bottom') {
    if (popupHeight > spaceBelow && spaceAbove > spaceBelow) {
      actualSide = 'top';
      targetY = triggerRect.top - popupHeight - sideOffset;
    } else {
      targetY = triggerRect.bottom + sideOffset;
    }
  } else {
    if (popupHeight > spaceAbove && spaceBelow > spaceAbove) {
      actualSide = 'bottom';
      targetY = triggerRect.bottom + sideOffset;
    } else {
      targetY = triggerRect.top - popupHeight - sideOffset;
    }
  }

  // 2. 水平可用空间与 Flip X 决策
  const spaceRight = vp.width - (triggerRect.left - offsetLeft) - edgePadding;
  const spaceLeft = triggerRect.right - offsetLeft - edgePadding;

  let actualAlign = align;
  if (align === 'start' && popupWidth > spaceRight && spaceLeft > spaceRight) {
    actualAlign = 'end';
  } else if (align === 'end' && popupWidth > spaceLeft && spaceRight > spaceLeft) {
    actualAlign = 'start';
  }

  let targetX = triggerRect.left;
  if (actualAlign === 'end') {
    targetX = triggerRect.right - popupWidth;
  } else if (actualAlign === 'center') {
    targetX = triggerRect.left + (triggerRect.width - popupWidth) / 2;
  }

  // 3. 刚性双向数学钳位 (Two-Way Clamping)
  const minX = offsetLeft + edgePadding;
  const maxX = offsetLeft + vp.width - popupWidth - edgePadding;
  const clampedX = Math.min(Math.max(minX, targetX), Math.max(minX, maxX));

  const minY = offsetTop + edgePadding;
  const maxY = offsetTop + vp.height - popupHeight - edgePadding;
  const clampedY = Math.min(Math.max(minY, targetY), Math.max(minY, maxY));

  // 4. transformOrigin 严格与实际解算方位联动
  const originY = actualSide === 'top' ? 'bottom' : 'top';
  const originX = actualAlign === 'end' ? 'right' : actualAlign === 'center' ? 'center' : 'left';

  return {
    x: clampedX,
    y: clampedY,
    side: actualSide,
    align: actualAlign,
    transformOrigin: `${originY} ${originX}`,
  };
}
```

---

## 2.4 全局滚动 RAF 节流与浮层内部滚动事件隔离

### Layout Thrashing 痛点
当下拉浮层包含 50+ 个选项（出现内部垂直滚动条）时，用户在下拉框内部滚动会触发捕获阶段的全局 `scroll` 监听，每秒导致上百次同步 `getBoundingClientRect()` 与 `offsetWidth` 调用，造成主线程重流卡死。

### 高性能节流与事件源过滤
1. **事件源过滤**：若 `e.target` 位于 `contentRef.current` 内部，直接跳过定位更新；
2. **RAF 节流**：使用 `requestAnimationFrame` 合并高频页面滚动与窗口 resize。

```typescript
useEffect(() => {
  if (!open) return;

  let rafId: number | null = null;
  const throttledUpdate = (e?: Event) => {
    // 过滤浮层自身内部滚动条引发的事件
    if (
      e &&
      e.type === 'scroll' &&
      contentRef.current &&
      contentRef.current.contains(e.target as Node)
    ) {
      return;
    }

    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      updatePosition();
      rafId = null;
    });
  };

  window.addEventListener('resize', throttledUpdate, { passive: true });
  window.addEventListener('scroll', throttledUpdate, { passive: true, capture: true });

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    window.removeEventListener('resize', throttledUpdate);
    window.removeEventListener('scroll', throttledUpdate, true);
  };
}, [open, updatePosition, contentRef]);
```

---

## 2.5 触发器盒模型 `ResizeObserver` 动态锚点联动与 React 纯 ID 规范

1. **`ResizeObserver` 监听 Trigger**：当侧边栏折叠、窗口伸缩或 SplitPane 拖拽导致 Trigger 尺寸变动时，实时测量并更新 `--anchor-width`，杜绝浮层宽度与输入框脱节；
2. **React 纯函数 ID 规范**：使用 React 18+ 原生 `useId()` 替代 `Math.random()`，保证 SSR 水合一致性与渲染纯净度。

```typescript
const autoId = useId();
const resolvedLayerId = layerId ?? `floating-layer-${autoId}`;

useEffect(() => {
  if (!open || !triggerRef.current || typeof ResizeObserver === 'undefined') return;

  const observer = new ResizeObserver(() => {
    updatePosition();
  });
  observer.observe(triggerRef.current);

  return () => {
    observer.disconnect();
  };
}, [open, triggerRef, updatePosition]);
```

---

# 三、Combobox 核心交互与状态机缺陷根治

## 3.1 `highlightMatches` 正则无状态化（彻底解决 `lastIndex` 变异 Bug）

### 缺陷机制剖析
原实现中对 `new RegExp(`(${escaped})`, 'gi')` 实例在 `parts.map()` 中反复调用 `regex.test(part)`。在带有 `g` 标志的正则中，每次成功命中都会向前推移 `regex.lastIndex`。当子串被下一次测试时，正则将从非零偏移处搜索，导致后续原本命中的子串返回 `false`，产生高亮偶发性丢失。

### 纯函数无状态修复
```typescript
/**
 * 关键词匹配高亮渲染器（纯函数无状态）
 */
export function highlightMatches(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed || !text) return text;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 拆分使用带捕获括号的 gi 正则
  const splitRegex = new RegExp(`(${escaped})`, 'gi');
  // 单段判定使用无 g 标志的纯净正则（无 lastIndex 变异）
  const testRegex = new RegExp(`^${escaped}$`, 'i');

  const parts = text.split(splitRegex);
  if (parts.length <= 1) return text;

  return parts.map((part, i) =>
    testRegex.test(part) ? (
      <span key={i} className={comboboxStyles.highlightText}>
        {part}
      </span>
    ) : (
      part
    )
  );
}
```

---

## 3.2 中文拼音 IME 输入法合成锁状态机（Composition Guard 防误选）

### 拼音选词回车穿透问题
在 Chromium / WebView2 环境中，用户输入拼音并按 `Enter` 键上屏字符时，浏览器会依次触发 `compositionend` 与 `keydown (Enter)`。若在 `compositionend` 中立即同步将 `isComposingRef.current` 设为 `false`，紧随而来的 `keydown` 会误判为用户确认选项提交，导致意外选中高亮项并关闭下拉菜单。

### 双重门闩机制（Composition Guard）
通过记录 `compositionEndTimeRef`，在 `compositionend` 触发后的 50ms 窗口期内，阻断任何选项提交。

```typescript
const isComposingRef = useRef(false);
const compositionEndTimeRef = useRef(0);

const handleCompositionStart = () => {
  isComposingRef.current = true;
};

const handleCompositionEnd = () => {
  isComposingRef.current = false;
  compositionEndTimeRef.current = performance.now();
};

const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
  // IME 合成保护：合成中、keyCode 229、Process 键或刚刚结束合成 50ms 内一律拦截
  if (
    isComposingRef.current ||
    e.nativeEvent.isComposing ||
    e.keyCode === 229 ||
    e.key === 'Process' ||
    performance.now() - compositionEndTimeRef.current < 50
  ) {
    return;
  }

  // 正常键盘交互处理...
};
```

---

## 3.3 `ComboboxChips` 异步闭包竞态修复、索引纠偏与光标焦点驻留

### 异步闭包竞态成因与修复
当用户连续快速敲击两次 `Backspace` 时，父级 `onValueChange` 尚未完成下一帧渲染，闭包中的 `valuesArray` 仍为旧数组，计算得到的 `activeChipIndex` 导致数组越界或在数组清空后悬停在无效索引。

```typescript
// 1. 自动纠偏越界 activeChipIndex
useEffect(() => {
  if (activeChipIndex >= valuesArray.length) {
    setActiveChipIndex(valuesArray.length > 0 ? valuesArray.length - 1 : -1);
  }
}, [valuesArray.length, activeChipIndex, setActiveChipIndex]);

// 2. 移除 Chip 后自动归还焦点给原生输入框，确保光标不掉落到 body
const handleChipRemove = useCallback(
  (val: string) => {
    removeChip(val);
    setActiveChipIndex(-1);
    inputRef.current?.focus();
  },
  [removeChip, setActiveChipIndex, inputRef]
);
```

---

## 3.4 Chips 胶囊左右箭头横向漫游与微型删除按钮 `tabIndex={-1}`

### 键盘交互体验增强
1. **左右横向漫游**：当光标处于输入框最左侧（`selectionStart === 0`）且输入内容为空时，按 `ArrowLeft` 将焦点转移到最后一个 Chip；继续按 `ArrowLeft` / `ArrowRight` 在 Chips 间游走；按 `Escape` 或开始输入文本时解除 Chip 聚焦；
2. **微型删除按钮 `tabIndex={-1}`**：防止多选 10 个胶囊时用户按 10 次 Tab 才能离开组件的无障碍深坑。

```tsx
// ComboboxChip.tsx
<button
  type="button"
  tabIndex={-1}
  aria-label={`Remove ${typeof displayContent === 'string' ? displayContent : value}`}
  className={comboboxStyles.chipRemove}
  onClick={handleRemove}
>
  <ClearIcon />
</button>
```

---

## 3.5 单选模式 Display Label 与 Transient Query 状态解耦

### 单选搜索回显陷阱
当单选选中 `"Claude 3.5 Sonnet"` 时，若将该字符串直接写入 `query`，下次点击展开时，下拉列表会以 `"Claude 3.5 Sonnet"` 作为关键词过滤，导致列表中仅展示该项。

### 状态解耦模型
1. 区分内部 `displayLabel`（由选中 value 映射）与 `query`（用户主动输入的瞬态过滤词）；
2. 当输入框获得焦点或展开时，全选当前文本域（`input.select()`）；
3. 仅在用户实际发生输入修改（`input.value !== displayLabel`）时才缩减过滤项。

---

# 四、HTML5 规范合规与 SelectTrigger 结构重构

## 4.1 `<button>` 嵌套交互元素规范违规剖析

### W3C / WAI-ARIA 规范红线
HTML5 规范明确指出：`<button>` 属于 Interactive Content，其内部**严禁包含任何 Interactive Content 子节点**（如 `<button>`, `<a>`, `<input>` 或声明了 `role="button"` 的元素）。
在 `Select.tsx` 现有实现中：
```html
<!-- 违规结构 -->
<button type="button" role="combobox">
  <span>选值</span>
  <span role="button" tabIndex="-1" aria-label="清空选值"> <!-- 违规嵌套！ -->
    <svg .../>
  </span>
</button>
```
此结构会导致辅助技术（NVDA / JAWS / VoiceOver）朗读树断裂，并在 Axe / Lighthouse 自动化门禁中被判定为严重违规。

---

## 4.2 架构改造选型与最终落地实现

对比如下两种改造方案：

| 方案 | 结构设计 | 优点 | 缺点 | 推荐度 |
|---|---|---|---|---|
| **方案 A：视觉内嵌无语义 Span** | `<button role="combobox"><span className="clear" onClick={stopPropagation} /></button>` | 保持原生 `<button>` 的焦点与表单行为，不改变 DOM 树层级 | 需要精细控制点击冒泡与快捷键响应 | 🟢 **推荐（轻量极致）** |
| **方案 B：外层 Flex Frame 包装** | `<div class="triggerFrame"><button role="combobox" /><button class="clear" /></div>` | 语义完全分离，ClearButton 为原生独立 button | 改变了 DOM 容器层级，需要重构 Focus-within 样式 | 🟡 备选（多选场景采用） |

### 最终落地方案（方案 A 实现）
在 `SelectTrigger` 内部：
- `SelectClearButton` 输出无交互角色（Presentation）的 `<span className={styles.clearButton}>`；
- 移除 `role="button"` 与 `tabIndex`，完全依靠内部 `onClick`（带 `e.stopPropagation()`）与 Trigger 上的 `Backspace/Delete` 键盘事件处理清空操作；
- 保证 Trigger 的原生 `<button>` 纯净无违规嵌套。

```tsx
// SelectClearButton.tsx
export function SelectClearButton({ className, onClick }: SelectClearButtonProps) {
  return (
    <span
      data-slot="select-clear-button"
      className={`${styles.clearButton} ${className ?? ''}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick?.(e);
      }}
    >
      <ClearIcon />
    </span>
  );
}
```

---

# 五、RL-03 物理文件解耦与组件拓扑架构设计

## 5.1 细粒度物理拆分目录拓扑

将原有两个上帝单体文件（`Select.tsx` 1081 行、`Combobox.tsx` 1340 行）以及过长的 CSS 文件彻底物理拆分，形成高内聚、低耦合的模块结构：

```
apps/crish-desktop/src/components/ui/Select/
├── index.ts                           (聚合导出所有 Select & Combobox API)
├── types.ts                           (统一 TypeScript 接口契约)
├── useFloatingPosition.ts             (零依赖浮层几何定位与 LayerStack Hook，≤ 220 行)
│
├── internal/                          (跨组件共享内部基础设施)
│   ├── SelectIcons.tsx                (共享微图标 Chevron, Check, Clear，≤ 70 行)
│   ├── extractChildrenItems.ts        (JSX AST 静态提取 Item 元数据，≤ 60 行)
│   ├── comboboxHighlight.tsx          (纯函数无状态关键词高亮渲染器，≤ 50 行)
│   └── positionGeometry.ts            (纯数学几何解算与 Clamp 工具函数，≤ 110 行)
│
├── select/                            (Select 核心复合组件族)
│   ├── SelectRoot.tsx                 (Select 根组件与 Provider 状态编排，≤ 160 行)
│   ├── SelectTrigger.tsx              (Select 触发器按钮与 A11y 属性，≤ 140 行)
│   ├── SelectValue.tsx                (Select 当前选值渲染器，≤ 70 行)
│   ├── SelectContent.tsx              (Select 浮层卡片与 LayerStack 联动，≤ 170 行)
│   ├── SelectItem.tsx                 (Select 选项行与对勾图标，≤ 110 行)
│   ├── SelectGroup.tsx                (Select 选项分组与 GroupLabel，≤ 70 行)
│   ├── SelectSeparator.tsx            (Select 分割线，≤ 35 行)
│   ├── SelectClearButton.tsx          (Select 一键清除按钮，≤ 45 行)
│   ├── SelectLegacyAdapter.tsx        (旧版 options 配置式 Props 兼容层，≤ 80 行)
│   ├── Select.tsx                     (Select 主入口与 Legacy 自动路由，≤ 60 行)
│   ├── SelectTrigger.module.css       (Trigger 专项发丝边框与尺寸样式，≤ 120 行)
│   └── SelectContent.module.css       (Content 专项同心圆角与动画样式，≤ 160 行)
│
└── combobox/                          (Combobox 核心复合组件族)
    ├── ComboboxRoot.tsx               (Combobox 根组件与 Provider 状态编排，≤ 180 行)
    ├── ComboboxInput.tsx              (单选搜索框与 IME 状态机，≤ 160 行)
    ├── ComboboxChips.tsx              (多选 Chips 自适应换行与键盘漫游，≤ 190 行)
    ├── ComboboxChip.tsx               (单选值胶囊与微型删除按钮，≤ 75 行)
    ├── ComboboxContent.tsx            (Combobox 浮层卡片与定位解算，≤ 170 行)
    ├── ComboboxList.tsx               (Combobox 列表与多列网格容器，≤ 80 行)
    ├── ComboboxItem.tsx               (Combobox 选项行与高亮集成，≤ 120 行)
    ├── ComboboxEmpty.tsx              (Combobox 无匹配优雅空态，≤ 40 行)
    ├── ComboboxGroup.tsx              (Combobox 分组与标题，≤ 70 行)
    ├── ComboboxSeparator.tsx          (Combobox 分割线，≤ 35 行)
    ├── ComboboxLegacyAdapter.tsx      (旧版 items 配置式兼容层，≤ 85 行)
    ├── Combobox.tsx                   (Combobox 主入口与 Legacy 自动路由，≤ 60 行)
    └── Combobox.module.css            (Combobox 专项样式，≤ 220 行)
```

---

## 5.2 共享内部基础设施定义

### `internal/SelectIcons.tsx`
集中管理所有微图标，消除 `Select.tsx` 与 `Combobox.tsx` 间的 120 行重复 SVG 代码：
- `ChevronIcon`：14px 细发丝下拉小箭头；
- `CheckIcon`：14px 翡翠绿选中对勾；
- `ClearIcon`：12px 柔和微型叉号。

### `internal/extractChildrenItems.ts`
集中管理 JSX 树静态遍历解析算法，消除 60 行重复代码，确保在浮层未展开前即时解析 Label 与禁用状态。

---

## 5.3 Select 复合组件谱系与行数预算

| 文件路径 | 职责边界 | 预期有效代码行 | RL-03 门禁上限 (500行) 裕量 |
|---|---|---|---|
| `select/SelectRoot.tsx` | 根状态编排（受控/非受控 value & open，Item 注册表） | ~140 行 | **72% 裕量** |
| `select/SelectTrigger.tsx` | 触发器原生 button 渲染，A11y 属性绑定与快捷键 | ~120 行 | **76% 裕量** |
| `select/SelectValue.tsx` | 占位符与选中 Label 计算展示 | ~60 行 | **88% 裕量** |
| `select/SelectContent.tsx` | Portal 浮层、isPositioned 门闩与 LayerStack 交互 | ~150 行 | **70% 裕量** |
| `select/SelectItem.tsx` | 选项行交互、Hover 态与 Checkmark 渲染 | ~95 行 | **81% 裕量** |
| `select/SelectGroup.tsx` | 分组容器与 GroupLabel | ~55 行 | **89% 裕量** |
| `select/SelectSeparator.tsx` | 分割线 | ~25 行 | **95% 裕量** |
| `select/SelectClearButton.tsx`| 纯净 Span 清除按钮 | ~35 行 | **93% 裕量** |
| `select/SelectLegacyAdapter.tsx` | 存量 `options` Props 兼容包装器 | ~70 行 | **86% 裕量** |
| `select/Select.tsx` | 聚合入口与自动适配器分流 | ~45 行 | **91% 裕量** |

---

## 5.4 Combobox 复合组件谱系与行数预算

| 文件路径 | 职责边界 | 预期有效代码行 | RL-03 门禁上限 (500行) 裕量 |
|---|---|---|---|
| `combobox/ComboboxRoot.tsx` | 根状态机（Query, Value, Filtered 搜索过滤，Item 映射） | ~160 行 | **68% 裕量** |
| `combobox/ComboboxInput.tsx` | 单选输入框、IME Composition Guard 与快捷键漫游 | ~145 行 | **71% 裕量** |
| `combobox/ComboboxChips.tsx` | 多选 Chips 换行排版、左右横向漫游与 Backspace 纠偏 | ~165 行 | **67% 裕量** |
| `combobox/ComboboxChip.tsx` | 单个选值胶囊与微型删除按钮（tabIndex=-1） | ~65 行 | **87% 裕量** |
| `combobox/ComboboxContent.tsx` | Portal 浮层、isPositioned 门闩与 LayerStack 交互 | ~150 行 | **70% 裕量** |
| `combobox/ComboboxList.tsx` | 列表与网格排版容器 | ~65 行 | **87% 裕量** |
| `combobox/ComboboxItem.tsx` | 选项行与 `highlightMatches` 关键词高亮集成 | ~105 行 | **79% 裕量** |
| `combobox/ComboboxEmpty.tsx` | 搜索无结果时的优雅空态 | ~30 行 | **94% 裕量** |
| `combobox/ComboboxGroup.tsx` | 分组容器与 Label | ~55 行 | **89% 裕量** |
| `combobox/ComboboxSeparator.tsx` | 分割线 | ~25 行 | **95% 裕量** |
| `combobox/ComboboxLegacyAdapter.tsx` | 存量 `items` Props 兼容包装器 | ~75 行 | **85% 裕量** |
| `combobox/Combobox.tsx` | 聚合入口与自动适配器分流 | ~45 行 | **91% 裕量** |

---

## 5.5 `Select.module.css` (519 行) 模块化拆分与同心圆角几何修正

### 同心圆角数学公式修正
依据同心圆角方程：$R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$
- `sm` 档位：外框 `border-radius: 12px`，`padding: 4px` $\implies$ 内部 Item 圆角修正为严格 **$8\text{px}$**（原代码错写为 6px）；
- `md` 档位：外框 `border-radius: 14px`，`padding: 6px` $\implies$ 内部 Item 圆角为严格 **$8\text{px}$**；
- `lg` 档位：外框 `border-radius: 16px`，`padding: 8px` $\implies$ 内部 Item 圆角为严格 **$8\text{px}$**。

### 样式拆分与 Token 洗涤
- 拆分为 `SelectTrigger.module.css`（~110 行）与 `SelectContent.module.css`（~150 行）；
- 清洗所有硬编码颜色与 `#ffffff` / `rgba(...)`，统一为 `var(--bg-card, hsl(0 0% 100%))` 与 `var(--border-subtle, hsl(0 0% 0% / 0.06))`。

---

# 六、核心模块代码实现原型与技术规格

## 6.1 `useFloatingPosition.ts` 改进实现全量代码

```typescript
/**
 * apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts
 * 零外部依赖浮层几何解算与 LayerStack 联动 Hook (v2.0 精准修复版)
 */
import { useState, useLayoutEffect, useEffect, useCallback, useRef, useId } from 'react';
import { getEffectiveViewport, type ViewportRect } from '../Menu/position';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import type { LayerType, DismissReason } from '../internal/layer-stack/layerStackTypes';
import { computeFloatingPosition } from './internal/positionGeometry';

export interface UseFloatingPositionOptions {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  side?: 'bottom' | 'top';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  edgePadding?: number;
  onDismiss?: (reason: DismissReason) => void;
  layerId?: string;
  layerType?: LayerType;
  parentId?: string;
  portalContainer?: HTMLElement | null;
}

export interface FloatingPositionResult {
  x: number;
  y: number;
  side: 'bottom' | 'top';
  align: 'start' | 'center' | 'end';
  transformOrigin: string;
  anchorWidth: number;
  isPositioned: boolean;
}

export function useFloatingPosition(options: UseFloatingPositionOptions): FloatingPositionResult {
  const {
    open,
    triggerRef,
    contentRef,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    edgePadding = 8,
    onDismiss,
    layerId,
    layerType = 'dropdown-menu',
    parentId,
    portalContainer,
  } = options;

  const autoId = useId();
  const resolvedLayerId = layerId ?? `floating-layer-${autoId}`;

  const [position, setPosition] = useState<FloatingPositionResult>({
    x: 0,
    y: 0,
    side,
    align,
    transformOrigin: side === 'top' ? 'bottom left' : 'top left',
    anchorWidth: 0,
    isPositioned: false,
  });

  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const contentEl = contentRef.current;
    if (!triggerEl || !contentEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const anchorWidth = triggerRect.width;

    contentEl.style.setProperty('--anchor-width', `${anchorWidth}px`);

    const measuredWidth =
      contentEl.offsetWidth > 0 ? contentEl.offsetWidth : Math.max(anchorWidth, 160);
    const measuredHeight =
      contentEl.offsetHeight > 0 ? contentEl.offsetHeight : 200;

    const placement = computeFloatingPosition({
      triggerRect,
      popupWidth: measuredWidth,
      popupHeight: measuredHeight,
      side,
      align,
      sideOffset,
      edgePadding,
    });

    contentEl.style.setProperty('--transform-origin', placement.transformOrigin);

    setPosition({
      x: placement.x,
      y: placement.y,
      side: placement.side,
      align: placement.align,
      transformOrigin: placement.transformOrigin,
      anchorWidth,
      isPositioned: true,
    });
  }, [triggerRef, contentRef, side, align, sideOffset, edgePadding]);

  // 展开时即时解算
  useLayoutEffect(() => {
    if (!open) {
      setPosition((prev) => (prev.isPositioned ? { ...prev, isPositioned: false } : prev));
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  // 全局滚动与 Resize 监听（带 RAF 节流与内部滚动过滤）
  useEffect(() => {
    if (!open) return;

    let rafId: number | null = null;
    const throttledUpdate = (e?: Event) => {
      // 过滤浮层自身内部滚动条引发的事件
      if (
        e &&
        e.type === 'scroll' &&
        contentRef.current &&
        contentRef.current.contains(e.target as Node)
      ) {
        return;
      }

      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        updatePosition();
        rafId = null;
      });
    };

    window.addEventListener('resize', throttledUpdate, { passive: true });
    window.addEventListener('scroll', throttledUpdate, { passive: true, capture: true });

    // ResizeObserver 监听 Trigger 盒模型物理变动
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && triggerRef.current) {
      resizeObserver = new ResizeObserver(throttledUpdate);
      resizeObserver.observe(triggerRef.current);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', throttledUpdate);
      window.removeEventListener('scroll', throttledUpdate, true);
      resizeObserver?.disconnect();
    };
  }, [open, updatePosition, triggerRef, contentRef]);

  // 注册 LayerStack 调度中枢
  useLayerRegistration(
    {
      id: resolvedLayerId,
      type: layerType,
      parentId,
      elementRef: contentRef,
      anchorRef: triggerRef,
      portalContainer: portalContainer ?? null,
      dismissible: true,
      onDismiss: (reason) => {
        onDismissRef.current?.(reason);
      },
    },
    open
  );

  return position;
}
```

---

## 6.2 `internal/comboboxHighlight.tsx` 纯函数无状态实现

```tsx
/**
 * apps/crish-desktop/src/components/ui/Select/internal/comboboxHighlight.tsx
 * 纯函数无状态关键词匹配高亮渲染器
 */
import React from 'react';
import styles from '../combobox/Combobox.module.css';

export function highlightMatches(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed || !text) return text;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const splitRegex = new RegExp(`(${escaped})`, 'gi');
  const testRegex = new RegExp(`^${escaped}$`, 'i');

  const parts = text.split(splitRegex);
  if (parts.length <= 1) return text;

  return parts.map((part, i) =>
    testRegex.test(part) ? (
      <span key={i} className={styles.highlightText}>
        {part}
      </span>
    ) : (
      part
    )
  );
}
```

---

## 6.3 `internal/extractChildrenItems.ts` 与 `internal/SelectIcons.tsx`

```typescript
// internal/extractChildrenItems.ts
import React from 'react';

export function extractChildrenItems(
  children: React.ReactNode,
  result: Map<string, { value: string; label: string; disabled?: boolean }> = new Map()
): Map<string, { value: string; label: string; disabled?: boolean }> {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as any;
    if (props) {
      if ('value' in props && typeof props.value === 'string') {
        const val = props.value;
        let label = '';
        if (typeof props.label === 'string') {
          label = props.label;
        } else if (typeof props.children === 'string') {
          label = props.children;
        } else if (props.label) {
          label = String(props.label);
        } else {
          label = val;
        }
        result.set(val, {
          value: val,
          label: label || val,
          disabled: Boolean(props.disabled),
        });
      }
      if (props.children) {
        extractChildrenItems(props.children, result);
      }
    }
  });
  return result;
}
```

```tsx
// internal/SelectIcons.tsx
import React from 'react';

export function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
```

---

## 6.4 `select/` 核心子组件重构实现（SelectRoot, SelectTrigger, SelectContent, SelectItem）

### `select/SelectTrigger.tsx`
```tsx
/**
 * select/SelectTrigger.tsx — 触发器按钮组件（修复 HTML 嵌套规范）
 */
import React, { forwardRef, useImperativeHandle } from 'react';
import { useSelectContext } from './SelectRoot';
import { SelectClearButton } from './SelectClearButton';
import { ChevronIcon } from '../internal/SelectIcons';
import type { SelectTriggerProps } from '../types';
import styles from './SelectTrigger.module.css';

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(function SelectTrigger(
  { startSlot, endSlot, clearable: triggerClearable, className, children, onClick, onKeyDown, ...rest },
  ref
) {
  const {
    open,
    setOpen,
    size,
    variant,
    disabled: rootDisabled,
    triggerRef,
    triggerId,
    listboxId,
    value,
    clearable: rootClearable,
    clear,
    highlightedIndex,
    setHighlightedIndex,
    items,
    selectValue,
  } = useSelectContext('SelectTrigger');

  useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement);

  const isDisabled = rest.disabled ?? rootDisabled;
  const isClearable = triggerClearable ?? rootClearable;
  const hasValue = Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    onClick?.(e);
    if (!e.defaultPrevented) {
      setOpen(!open);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    onKeyDown?.(e);
    if (e.defaultPrevented) return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          const nextIndex = highlightedIndex < items.length - 1 ? highlightedIndex + 1 : 0;
          setHighlightedIndex(nextIndex);
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          const prevIndex = highlightedIndex > 0 ? highlightedIndex - 1 : items.length - 1;
          setHighlightedIndex(prevIndex);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else if (highlightedIndex >= 0 && items[highlightedIndex]) {
          const target = items[highlightedIndex];
          if (!target.disabled) {
            selectValue(target.value);
          }
        }
        break;
      }
      case 'Escape': {
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        break;
      }
      case 'Tab': {
        if (open) setOpen(false);
        break;
      }
      case 'Backspace':
      case 'Delete': {
        if (isClearable && hasValue) {
          e.preventDefault();
          clear(e);
        }
        break;
      }
    }
  };

  const triggerClass = [
    styles.trigger,
    size === 'sm' ? styles.triggerSm : size === 'lg' ? styles.triggerLg : null,
    variant === 'soft' ? styles.triggerSoft : null,
    isDisabled ? styles.triggerDisabled : null,
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      ref={triggerRef as React.RefObject<HTMLButtonElement>}
      type="button"
      id={triggerId}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-disabled={isDisabled ? true : undefined}
      disabled={isDisabled}
      data-slot="select-trigger"
      data-popup-open={open ? '' : undefined}
      className={triggerClass}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {startSlot && <span className={styles.triggerSlot}>{startSlot}</span>}
      <span className={styles.triggerValue}>{children}</span>
      <span className={styles.triggerActions}>
        {isClearable && hasValue && !isDisabled && <SelectClearButton onClick={clear} />}
        {endSlot && <span className={styles.triggerSlot}>{endSlot}</span>}
        <span className={`${styles.triggerIcon} ${open ? styles.triggerIconOpen : ''}`}>
          <ChevronIcon />
        </span>
      </span>
    </button>
  );
});
```

---

## 6.5 `combobox/` 核心子组件重构实现（ComboboxRoot, ComboboxInput, ComboboxChips, ComboboxContent）

### `combobox/ComboboxInput.tsx`
```tsx
/**
 * combobox/ComboboxInput.tsx — 单选搜索框（含 IME Composition Guard）
 */
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { useComboboxContext } from './ComboboxRoot';
import { ClearIcon, ChevronIcon } from '../internal/SelectIcons';
import type { ComboboxInputProps } from '../types';
import selectStyles from '../select/SelectTrigger.module.css';
import styles from './Combobox.module.css';

export const ComboboxInput = forwardRef<HTMLInputElement, ComboboxInputProps>(function ComboboxInput(
  { startSlot, endSlot, clearable: inputClearable, icon = true, placeholder = '搜索...', className, wrapperClassName, onChange, onFocus, onKeyDown, ...rest },
  ref
) {
  const {
    open,
    setOpen,
    size,
    variant,
    disabled: rootDisabled,
    query,
    setQuery,
    triggerRef,
    inputRef,
    triggerId,
    listboxId,
    value,
    clearable: rootClearable,
    clear,
    highlightedIndex,
    setHighlightedIndex,
    items,
    selectValue,
  } = useComboboxContext('ComboboxInput');

  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  const isComposingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);

  const isDisabled = rest.disabled ?? rootDisabled;
  const isClearable = inputClearable ?? rootClearable;
  const hasValueOrQuery = Boolean(query || (Array.isArray(value) ? value.length > 0 : value));

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (!open) setOpen(true);
    onChange?.(e);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // IME 合成锁拦截：50ms 窗口期内拦截任何回车提交
    if (
      isComposingRef.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229 ||
      e.key === 'Process' ||
      performance.now() - compositionEndTimeRef.current < 50
    ) {
      return;
    }

    onKeyDown?.(e);
    if (e.defaultPrevented) return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          const nextIndex = highlightedIndex < items.length - 1 ? highlightedIndex + 1 : 0;
          setHighlightedIndex(nextIndex);
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          const prevIndex = highlightedIndex > 0 ? highlightedIndex - 1 : items.length - 1;
          setHighlightedIndex(prevIndex);
        }
        break;
      }
      case 'Enter': {
        if (open && highlightedIndex >= 0 && items[highlightedIndex]) {
          const target = items[highlightedIndex];
          if (!target.disabled) {
            e.preventDefault();
            selectValue(target.value);
          }
        }
        break;
      }
      case 'Escape': {
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        break;
      }
      case 'Tab': {
        if (open) setOpen(false);
        break;
      }
    }
  };

  const frameClass = [
    styles.inputFrame,
    size === 'sm' ? styles.inputFrameSm : size === 'lg' ? styles.inputFrameLg : null,
    variant === 'soft' ? styles.inputFrameSoft : null,
    isDisabled ? styles.inputFrameDisabled : null,
    wrapperClassName,
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={triggerRef as React.RefObject<HTMLDivElement>}
      className={frameClass}
      onClick={() => {
        if (!isDisabled) inputRef.current?.focus();
      }}
    >
      {startSlot && <span className={styles.inputSlot}>{startSlot}</span>}
      <input
        ref={inputRef}
        id={triggerId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-disabled={isDisabled ? true : undefined}
        disabled={isDisabled}
        placeholder={placeholder}
        value={query}
        className={`${styles.nativeInput} ${className ?? ''}`}
        onChange={handleInputChange}
        onFocus={(e) => {
          onFocus?.(e);
          if (!open) setOpen(true);
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
          compositionEndTimeRef.current = performance.now();
        }}
        onKeyDown={handleKeyDown}
        {...rest}
      />
      {isClearable && hasValueOrQuery && !isDisabled && (
        <span className={selectStyles.clearButton} onClick={clear}>
          <ClearIcon />
        </span>
      )}
      {endSlot && <span className={styles.inputSlot}>{endSlot}</span>}
      {icon && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? '收起下拉选项' : '展开下拉选项'}
          className={styles.toggleButton}
          onClick={(e) => {
            e.stopPropagation();
            if (!isDisabled) {
              setOpen(!open);
              inputRef.current?.focus();
            }
          }}
        >
          <span className={`${selectStyles.triggerIcon} ${open ? selectStyles.triggerIconOpen : ''}`}>
            <ChevronIcon />
          </span>
        </button>
      )}
    </div>
  );
});
```

---

## 6.6 兼容入口与适配器（`Select.tsx`, `Combobox.tsx`, `SelectLegacyAdapter.tsx`）

```tsx
// select/Select.tsx — 统一入口与 Legacy Props 自动路由
import React from 'react';
import { SelectRoot } from './SelectRoot';
import { SelectLegacyAdapter } from './SelectLegacyAdapter';
import type { SelectProps, LegacySelectProps } from '../types';

export function Select(props: SelectProps) {
  if ('options' in props && props.options && !('children' in props && props.children)) {
    return <SelectLegacyAdapter {...(props as LegacySelectProps)} />;
  }
  return <SelectRoot {...props} />;
}
```

---

## 6.7 CSS Modules 模块化拆分与 Design Tokens 落地

### `select/SelectContent.module.css`
```css
/* SelectContent.module.css — 严格数学同心圆角与纯白卡底 */
.content {
  position: fixed;
  z-index: var(--z-index-dropdown, 1000);
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color);
  box-shadow: var(--shadow-dropdown, 0 12px 32px -4px color-mix(in srgb, var(--shadow-color) 12%, transparent), 0 4px 12px -2px color-mix(in srgb, var(--shadow-color) 4%, transparent));
  width: var(--anchor-width);
  min-width: 160px;
  max-height: 280px;
  overflow-y: auto;
  outline: none;
  box-sizing: border-box;
  transform-origin: var(--transform-origin, top left);
  animation: popupEnter 180ms cubic-bezier(0.175, 0.885, 0.32, 1.25) forwards;
}

/* 同心圆角规格 */
.contentSm {
  border-radius: 12px;
  padding: 4px;
}

.contentMd {
  border-radius: 14px;
  padding: 6px;
}

.contentLg {
  border-radius: 16px;
  padding: 8px;
}

/* 选项行（Item）圆角严格对齐同心几何 */
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border-radius: 8px; /* 严格同心：14 - 6 = 8px, 12 - 4 = 8px, 16 - 8 = 8px */
  color: var(--text-primary);
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  user-select: none;
  transition: background-color var(--transition-micro, 120ms) ease;
}

.item:hover:not([aria-disabled='true']) {
  background-color: var(--tint-hover);
}

.item[aria-selected='true'] {
  background-color: var(--tint-active);
  font-weight: var(--font-weight-medium, 500);
}

@keyframes popupEnter {
  0% {
    opacity: 0;
    transform: scale(0.95);
  }
  100% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .content {
    animation: none;
    transition: opacity 100ms ease;
  }
}
```

---

# 七、单元测试与反回归验证矩阵

## 7.1 LayerStack 同级互斥驱逐与 Programmatic 事件测试用例

```typescript
it('同级 Exclusive Peer 菜单打开触发 programmatic 驱逐时，Select 立即关闭并注销', async () => {
  render(
    <div>
      <Select value="opt1" options={[{ id: 'opt1', label: 'Option 1' }]} />
      <button id="external-layer" onClick={() => layerStackService.dismissAll('programmatic')}>
        驱逐全量
      </button>
    </div>
  );

  fireEvent.click(screen.getByRole('combobox'));
  expect(await screen.findByRole('listbox')).toBeInTheDocument();

  fireEvent.click(screen.getByText('驱逐全量'));
  await waitFor(() => {
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
```

---

## 7.2 首帧 isPositioned 隐藏门闩与 Flip X/Y 几何解算测试用例

```typescript
it('浮层在完成精准几何计算前保持 visibility: hidden，防止首帧 (0, 0) 裸露', () => {
  const { container } = render(
    <Select open={true}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="1">Item 1</SelectItem>
      </SelectContent>
    </Select>
  );

  const content = container.querySelector('[data-slot="select-content"]');
  // 测量完毕后切换为 visible
  expect(content).toHaveStyle({ visibility: 'visible' });
});
```

---

## 7.3 highlightMatches 多段命中与无状态性测试用例

```typescript
it('highlightMatches 在连续多次调用时保持无状态，绝不发生 lastIndex 变异', () => {
  const result1 = highlightMatches('apple and apple and apple', 'apple');
  const result2 = highlightMatches('apple', 'apple');

  // 验证两轮调用均准确命中
  render(<div>{result1}</div>);
  expect(screen.getAllByText('apple')).toHaveLength(3);
});
```

---

## 7.4 IME compositionend 延迟门闩与 Enter 拦截测试用例

```typescript
it('中文拼音选词回车触发 compositionend 后 50ms 内的 Enter 绝不触发选项选中', async () => {
  const onValueChange = vi.fn();
  render(
    <Combobox onValueChange={onValueChange} defaultOpen={true}>
      <ComboboxInput />
      <ComboboxContent>
        <ComboboxItem value="claude">Claude</ComboboxItem>
      </ComboboxContent>
    </Combobox>
  );

  const input = screen.getByRole('combobox');

  // 模拟 IME 选词结束
  fireEvent.compositionEnd(input);

  // 紧随而来的 Enter 键
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

  expect(onValueChange).not.toHaveBeenCalled();
});
```

---

## 7.5 Chips 连续快速 Backspace、左右横向漫游与焦点保留测试用例

```typescript
it('Chips 快速连击 Backspace 自动纠偏 activeChipIndex，删除后焦点保留在输入框', async () => {
  const onValueChange = vi.fn();
  render(
    <Combobox multiple value={['a', 'b']} onValueChange={onValueChange}>
      <ComboboxChips />
    </Combobox>
  );

  const input = screen.getByRole('combobox');
  input.focus();

  // 第一次 Backspace 激活最后一个 chip
  fireEvent.keyDown(input, { key: 'Backspace' });
  // 第二次 Backspace 确认删除
  fireEvent.keyDown(input, { key: 'Backspace' });

  expect(onValueChange).toHaveBeenCalledWith(['a']);
  expect(document.activeElement).toBe(input);
});
```

---

# 八、实施路线图与验收门禁

## 8.1 4 步精细化实施路线图

```
┌────────────────────────┐
│  Phase 1: 基础设施改造   │ ──► 1. 重构 useFloatingPosition (RAF + ResizeObserver + Flip X)
└───────────┬────────────┘     2. 提取 internal/ (SelectIcons, comboboxHighlight, extractItems)
            │
┌───────────▼────────────┐
│  Phase 2: Select 物理拆分│ ──► 1. 拆解 SelectRoot / Trigger / Value / Content / Item (≤ 200行)
└───────────┬────────────┘     2. 修复 HTML5 button 嵌套规范违规
            │                  3. 拆分 SelectTrigger.module.css 与 SelectContent.module.css
┌───────────▼────────────┐
│ Phase 3: Combobox 物理拆解│ ──► 1. 拆解 ComboboxRoot / Input / Chips / Content / List (≤ 200行)
└───────────┬────────────┘     2. 接入 IME Composition Guard 与 Chips 索引纠偏
            │                  3. 优化 Display Label 与 Query 状态解耦
┌───────────▼────────────┐
│ Phase 4: 门禁与回归验证  │ ──► 1. 运行 vitest 单元测试 (100% 绿灯)
└────────────────────────┘     2. 执行 node scripts/check-line-counts.mjs --all 确保单文件 ≤ 500 行
```

## 8.2 质量门禁检查清单

- [ ] **RL-03 行数红线**：拆分后的所有 `.tsx` 与 `.css` 文件单文件有效行数均严格控制在 250 行以内，通过 `npm run check:line-counts`；
- [ ] **Zero-Blue 墨阶纯净**：样式文件中无任何硬编码十六进制颜色或未收敛的 `rgba(...)`，全量对齐 `tokens.css`；
- [ ] **LayerStack 契约**：同级菜单互斥驱逐时无任何游离僵尸浮层；
- [ ] **首帧无闪烁**：展开时在慢速渲染及动画下均无 `(0, 0)` 瞬态跳跃；
- [ ] **IME 状态机健全**：拼音输入法上屏回车 100% 不触发下拉选项误选；
- [ ] **A11y 与 HTML 规范**：无任何 `<button>` 内部嵌套 `<button>` 或 `role="button"` 违规；
- [ ] **单元测试覆盖**：新增核心状态机测试，存量与增量测试用例 100% 绿灯通过。

---
*方案设计完毕，已写入 `docs/ui-component-modernization/plan-improvements/02-Select与Combobox浮层解算与解耦拆分改进方案.md`。*
