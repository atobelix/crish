# Switch 与 Tabs / SegmentedControl 物理动效及同心几何严苛审查报告

> **审查日期**：2026-08-31  
> **审查基准**：
> - `docs/ui-component-modernization/00-总方案-自研现代化原子组件体系与Appica动效解构总览.md`
> - `docs/ui-component-modernization/independent-plans/01-Switch流体果冻动效与自研React实现方案.md`
> - `docs/ui-component-modernization/independent-plans/02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md`
> - `AGENTS.md`（§13 焦点环规范、§14 现代色彩空间、反过度设计红线）
> 
> **审查对象**：
> - `apps/crish-desktop/src/components/ui/Switch/`（`Switch.tsx`, `Switch.module.css`, `Switch.test.tsx`）
> - `apps/crish-desktop/src/components/ui/Tabs/`（`Tabs.tsx`, `Tabs.module.css`, `Tabs.test.tsx`, `types.ts`）
> - `apps/crish-desktop/src/components/ui/SegmentedControl/`（`SegmentedControl.tsx`, `SegmentedControl.module.css`, `SegmentedControl.test.tsx`）

---

## 缺陷统计矩阵

| 组件模块 | 致命 (Fatal) | 严重 (Critical) | 一般 (Major) | 微小 (Minor) | 合计 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Switch** | 1 | 2 | 2 | 1 | **6** |
| **Tabs** | 1 | 2 | 2 | 0 | **5** |
| **SegmentedControl** | 2 | 1 | 1 | 0 | **4** |
| **总计** | **4** | **5** | **5** | **1** | **15** |

---

## 一、Switch 组件严苛缺陷审查

### 1. [严重级别: 致命] 首屏已选中状态下 Checkmark 延迟绘制动画导致 Zero-FOUC 闪烁与跳帧
- **文件路径**：`apps/crish-desktop/src/components/ui/Switch/Switch.module.css:568-570` 与 `apps/crish-desktop/src/components/ui/Switch/Switch.tsx:238-243`
- **缺陷剖析**：
  在 `Switch.module.css` 中，`.track[data-state='checked'] .checkIcon` 无条件绑定了 `animation: checkmark-draw 220ms cubic-bezier(0.16, 1, 0.3, 1) 180ms forwards;`。
  当开关组件以 `<Switch defaultChecked={true} />` 或受控 `<Switch checked={true} />` 初次挂载时，`hasInteracted` 初始值为 `false`。此时滑块本体（Thumb）虽然通过 `:not(.hasInteracted)` 避开了位移动画并正确停留在右侧，但内部 Checkmark 图标的初始 CSS 为 `opacity: 0; stroke-dashoffset: 12;`，并在挂载后 $180\text{ms}$ 突然启动 $220\text{ms}$ 的绘制动画！
  用户在打开包含开关的设置面板时，会明显看到**滑块先是一片空白，延迟近 200ms 后对勾才慢吞吞地画出来**。这彻底击穿了设计详案 01 §3.2 中强调的“Zero-FOUC 首屏静态稳定”原则。
- **极致修复方案**：
  Checkmark 的入场绘制动画必须被严格约束在 `.hasInteracted[data-state='checked']` 作用域内；初次挂载为选中状态时，直接应用静态无延迟的完全展开态。
  ```css
  /* 静态初始挂载选中态：瞬时满血呈现，零延迟、零动画 */
  .track[data-state='checked'] .checkIcon {
    stroke-dashoffset: 0;
    opacity: 1;
  }

  /* 仅在用户交互触发切换后激活动态绘制动画 */
  .hasInteracted[data-state='checked'] .checkIcon {
    animation: checkmark-draw 220ms cubic-bezier(0.16, 1, 0.3, 1) 180ms forwards;
  }
  ```

---

### 2. [严重级别: 严重] `useEffect` 中 `setHasInteracted(true)` 引发受控模式下的级联二次渲染与性能损耗
- **文件路径**：`apps/crish-desktop/src/components/ui/Switch/Switch.tsx:78-91`
- **缺陷剖析**：
  组件内部使用 `useState(false)` 维护 `hasInteracted`，并在 `useEffect` 中监听 `[checked]`：
  ```tsx
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (prevCheckedRef.current !== checked) {
      setHasInteracted(true);
      prevCheckedRef.current = checked;
    }
  }, [checked]);
  ```
  在受控模式下，父组件更新 `checked` 引起 Switch 首次 Render；Render 完成后触发 `useEffect`，再次调用 `setHasInteracted(true)`，进而触发 Switch 的**二次同步 Render**。这不仅导致了不必要的 VDOM Re-render 瀑布，还在快速并发切换或高频状态同步时引发帧率抖动。
- **极致修复方案**：
  废弃 `useState` 维护动画状态，改用 `useRef` 直接操作 DOM 类名，或在受控值比对时利用渲染期闭包直接计算动画标记，彻底根除二次渲染：
  ```tsx
  const isFirstRenderRef = useRef(true);
  const prevCheckedRef = useRef(checked);
  const [hasInteracted, setHasInteracted] = useState(false);

  // 渲染期间直接派生，无需 useEffect 异步滞后触发
  if (isFirstRenderRef.current) {
    isFirstRenderRef.current = false;
  } else if (prevCheckedRef.current !== checked && !hasInteracted) {
    setHasInteracted(true);
    prevCheckedRef.current = checked;
  }
  ```

---

### 3. [严重级别: 严重] 缺失 `[data-perf-tier='eco']` 性能降级体系支持
- **文件路径**：`apps/crish-desktop/src/components/ui/Switch/Switch.module.css:240-264`
- **缺陷剖析**：
  `Tabs.module.css` 与 `SegmentedControl.module.css` 均严格实现了 `html[data-perf-tier='eco']` 性能降级，当系统处于省电/低性能模式时动画时长归零。然而 `Switch.module.css` 仅声明了 `@media (prefers-reduced-motion: reduce)`，彻底遗漏了 `html[data-perf-tier='eco']` 规则。在工程统一的低性能降级档位下，Switch 仍然全速运行 GPU 关键帧动画，破坏了全局性能防御体系。
- **极致修复方案**：
  在 `Switch.module.css` 底部补全 Eco Tier 规则：
  ```css
  html[data-perf-tier='eco'] .track,
  html[data-perf-tier='eco'] .thumb,
  html[data-perf-tier='eco'] .checkIcon,
  html[data-perf-tier='eco'] .spinner,
  html[data-perf-tier='eco'] .label {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }
  ```

---

### 4. [严重级别: 一般] 高频快速点击下的 CSS Keyframes 瞬移撕裂与无阻尼跳变
- **文件路径**：`apps/crish-desktop/src/components/ui/Switch/Switch.module.css:517-555`
- **缺陷剖析**：
  `thumb-stretch-on` 与 `thumb-stretch-off` 使用了纯 `@keyframes` 实现形变与位移。由于 Keyframe 的 0% 硬编码了起点坐标（$0$ 与 $\text{thumb-travel}$），当用户在 $240\text{ms}$ 动画执行途中（例如 $70\text{ms}$ 处）再次点击反向切换时，浏览器会强行中断当前动画，将滑块坐标瞬间拽回 0% 关键帧原点重新拉伸。这会导致滑块在视觉上发生明显的“位置瞬间瞬移/跳帧”，缺乏真实物理惯性的速度连续性。
- **极致修复方案**：
  将滑块位移与形变解耦为 CSS 自定义属性驱动的连续 `transition`，或采用位移 `translateX` 与内部形变伪类独立分离架构，使反向触发时能在当前实时坐标点平滑反转。

---

### 5. [严重级别: 一般] 键盘事件未拦截中文输入法 IME 组合态打断
- **文件路径**：`apps/crish-desktop/src/components/ui/Switch/Switch.tsx:257-267`
- **缺陷剖析**：
  `handleKeyDown` 在检测 `Space` 与 `Enter` 按键时，未检查 `e.nativeEvent.isComposing`。在输入法焦点未完全移出或快速连续打字选词时，按下空格确认拼音可能穿透触发 Switch 翻转。
- **极致修复方案**：
  ```tsx
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || e.nativeEvent.isComposing) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleToggle();
      }
    },
    [handleToggle, onKeyDown]
  );
  ```

---

### 6. [严重级别: 微小] CSS 变量 Fallback 存在未定义变量级联失效风险
- **文件路径**：`apps/crish-desktop/src/components/ui/Switch/Switch.module.css:502`
- **缺陷剖析**：
  `box-shadow: var(--switch-thumb-shadow, 0 1px 2px color-mix(in srgb, var(--shadow-color) 14%, transparent));` 中，若全局未注入 `--shadow-color`，`color-mix` 解析失败会导致整个 `box-shadow` 属性失效回退为空。
- **极致修复方案**：
  ```css
  box-shadow: var(--switch-thumb-shadow, 0 1px 2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 14%, transparent));
  ```

---

## 二、Tabs 组件严苛缺陷审查

### 1. [严重级别: 致命] 挂载首屏指示器从 (0,0) 到目标位置产生全屏飞跃与微过冲（FLIP Zero-FOUC 溃败）
- **文件路径**：`apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:149-155` 与 `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:347-352`
- **缺陷剖析**：
  `TabsList` 中 `sliderRect` 初始状态为 `{ x: 0, y: 0, width: 0, height: 0, opacity: 0 }`。组件初次挂载后，`useLayoutEffect` 将其更新为目标项坐标（例如 `{ x: 180, y: 2, width: 90, height: 28, opacity: 1 }`）。
  然而在 `Tabs.module.css` 中，`.indicator` 始终开启了：
  ```css
  transition:
    transform var(--tab-duration) var(--tab-spring-bezier),
    width var(--tab-duration) var(--tab-spring-bezier),
    height var(--tab-duration) var(--tab-spring-bezier),
    opacity 120ms ease;
  ```
  由于**没有任何初次渲染动画阻断锁**，在页面加载、弹窗打开、路由跳转首次渲染 `Tabs` 时，纯白卡片指示器会**以 `cubic-bezier(0.175, 0.885, 0.32, 1.5)` 的弹性过冲曲线从容器左上角 (0,0) 带着拉伸全速横飞到目标 Tab 上**！首屏动画极其突兀，彻底击穿 Zero-FOUC 标准。
- **极致修复方案**：
  在 `TabsList` 内部引入 `isFirstLayoutRef` 锁，首屏渲染时向 Indicator 注入 `data-initial="true"` 并通过 CSS 强行关闭初次 `transition`，仅在后续交互位移时激活动画。
  ```tsx
  const isFirstLayoutRef = useRef(true);
  useLayoutEffect(() => {
    updateIndicator();
    if (isFirstLayoutRef.current) {
      // 首屏测量完成后在下一帧放行动画
      requestAnimationFrame(() => {
        isFirstLayoutRef.current = false;
      });
    }
  }, [updateIndicator]);
  ```
  ```css
  .indicator[data-initial='true'] {
    transition: none !important;
  }
  ```

---

### 2. [严重级别: 严重] ResizeObserverManager 订阅在每次 Tab 切换时发生无谓解绑与重绑
- **文件路径**：`apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:214-222`
- **缺陷剖析**：
  `updateIndicator` 依赖了 `[value, variant, orientation]`。每当用户点击切换 Tab，`value` 改变导致 `updateIndicator` 函数引用变化，直接触发 `useEffect` cleanup 执行 `ro.unobserve(el, oldCb)`，紧接着执行 `ro.observe(el, newCb)`。
  这意味着**用户每次点击 Tab，组件都在底层 DOM 上进行一次 ResizeObserver 的注销与重新注册**！不仅带来垃圾回收与事件循环调度开销，更违背了单例管理器长效监听的设计原则。
- **极致修复方案**：
  采用 Ref-trampoline（引用跳板）模式，`ResizeObserver` 仅在 DOM 节点挂载时注册一次，内部通过 Ref 调用最新 `updateIndicator`：
  ```tsx
  const updateIndicatorRef = useRef(updateIndicator);
  updateIndicatorRef.current = updateIndicator;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = ResizeObserverManager.getInstance();
    const handleResize = () => updateIndicatorRef.current();
    ro.observe(el, handleResize);
    return () => {
      ro.unobserve(el, handleResize);
    };
  }, []); // 仅在挂载时订阅一次！
  ```

---

### 3. [严重级别: 严重] WAI-ARIA 语义缺失：TabsTrigger 与 TabsContent 缺少 `id` 与 `aria-controls` / `aria-labelledby` 交叉引用
- **文件路径**：`apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:360-389` 与 `394-432`
- **缺陷剖析**：
  在当前实现中，`TabsTrigger` 未分配唯一 `id`，未声明 `aria-controls`；`TabsContent` 虽然通过 `useId()` 生成了内部 `contentId`，但未能将其反馈给对应的 `TabsTrigger`，且自身缺少 `aria-labelledby`。
  根据 WAI-ARIA 1.2 §3.18 Tabpanel 规范，每一个 `role="tab"` 必须通过 `aria-controls` 指向面板 ID，每一个 `role="tabpanel"` 必须通过 `aria-labelledby` 指向 Tab ID。当前实现导致屏幕阅读器完全无法建立控制联动关系。
- **极致修复方案**：
  在 `TabsContext` 中统一生成基于命名空间的 `baseId`（例如 `conex-tabs-${autoId}`），Trigger 自动获得 `id={`${baseId}-tab-${value}`}` 与 `aria-controls={`${baseId}-panel-${value}`}`，Content 自动获得 `id={`${baseId}-panel-${value}`}` 与 `aria-labelledby={`${baseId}-tab-${value}`}`。

---

### 4. [严重级别: 一般] Line 变体 CSS 声明 `bottom: 0` 与 JS `translate3d(x, clientHeight - 2, 0)` 产生层叠约束竞争
- **文件路径**：`apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:369-373` 与 `apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:188`
- **缺陷剖析**：
  `.indicator` 基础类已指定 `top: 0; left: 0;`。但在 `.indicatorLine[data-orientation='horizontal']` 中又声明了 `bottom: 0;`。
  在 JS 中，`updateIndicator` 已经精确计算了从顶部向下的位移：`y = listEl.clientHeight - 2`，并施加了 `translate3d(x, y, 0)`。
  在 CSS 绝对定位规范中，同时声明 `top: 0` 与 `bottom: 0` 并设置 `height: 2px`，在不同内核渲染引擎下会产生 top/bottom 锚点竞争，与 GPU `transform` 叠加大时容易在亚像素缩放下产生 1px 缝隙或指示条沉底溢出。
- **极致修复方案**：
  彻底移除 `.indicatorLine` 中多余的 `bottom: 0` 与 `left: 0` 静态定位声明，所有位移完全由 GPU `translate3d` 统一绝对控制。

---

### 5. [严重级别: 一般] 当前选中项被动态禁用时导致整个 Tab 组键盘无法切入（Roving Tabindex 锁死）
- **文件路径**：`apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:368`
- **缺陷剖析**：
  `TabsTrigger` 中 `tabIndex={isSelected && !disabled ? 0 : -1}`。
  如果当前处于激活状态的 Tab 被外部动态设置为 `disabled={true}`，此时整个 `TabsList` 中所有 Trigger 的 `tabIndex` 将全部变为 `-1`。
  键盘用户使用 `Tab` 键在页面巡航时，将彻底跳过该 Tabs 组件，无法聚焦且无法通过方向键唤醒其他可用 Tab，形成严重的无障碍操作死锁。
- **极致修复方案**：
  在 `TabsList` 层面计算键盘切入点（Focus Target）：若当前选中的 Tab 处于禁用状态，自动将 `tabIndex={0}` 委派给列表中第一个非禁用的 Tab。

---

## 三、SegmentedControl 组件严苛缺陷审查

### 1. [严重级别: 致命] 同心圆角几何公式破损：硬编码 7px 导致内圆角与外框发生月牙形几何畸变（Corner Pinching）
- **文件路径**：`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:6-12` 与 `45-75`
- **缺陷剖析**：
  设计方案 `02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md` §4 确立了严格的同心圆角几何公式：
  $$R_{\text{inner}} = \max(0, R_{\text{outer}} - \text{Padding})$$
  在 `sm` 尺寸下：$R_{\text{outer}} = 7\text{px}, P = 2\text{px} \implies R_{\text{inner}} = 5\text{px}$。
  但在 `SegmentedControl.module.css` 中：
  ```css
  --seg-outer-radius: var(--button-radius, 7px);
  --seg-inner-radius: var(--button-radius, 7px); /* 错误！硬编码 7px */
  ```
  内部纯白滑块 `--seg-inner-radius` 直接被写死为 `7px`！
  当 7px 圆角的内层白卡片放入 2px padding、7px 圆角的外层灰底槽时，四个圆弧转角处的实际间距从 $2\text{px}$ 锐减至不足 $1\text{px}$（视觉产生明显的 Corner Pinching 月牙形挤压畸变）。
  此外，在 `xs`（应为 6px/4px）、`md`（应为 8px/5px）、`lg`（应为 10px/6.5px）三档尺寸中，`SegmentedControl.module.css` 彻底未配置尺寸对应的内外圆角矩阵，全部违规停留在 7px！
- **极致修复方案**：
  全面废除硬编码，引入严格同心圆角计算公式与全尺寸矩阵：
  ```css
  .container {
    --seg-outer-radius: var(--button-radius, 7px);
    --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 严格同心 5px */
  }

  .containerXs {
    --seg-outer-radius: var(--radius-md, 6px);
    --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 4px */
  }

  .containerMd {
    --seg-outer-radius: var(--radius-lg, 8px);
    --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 5px */
  }

  .containerLg {
    --seg-outer-radius: var(--radius-xl, 10px);
    --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 6.5px */
  }
  ```

---

### 2. [严重级别: 致命] 架构倒退：全盘复制代码制造“双头怪”，违背基于 Tabs 的轻量包装契约
- **文件路径**：`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:1-261`
- **缺陷剖析**：
  设计详案 `02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md` §8.2 明确裁定：`SegmentedControl` 应作为 `Tabs` 体系的数据驱动桥接封装（约 40 行胶水代码），全量复用 `TabsList` 与 `TabsTrigger` 经过严密调优的物理动效、RO 观察者与 ARIA 规范。
  然而现实实现中，`SegmentedControl.tsx` 独立复制了 261 行代码与独立 CSS，导致：
  1. `SegmentedControl` 缺少 `orientation="vertical"` 与 `variant="line"` 支持；
  2. `SegmentedControl` 无法共享 `Tabs` 的 Bug 修复（例如首屏 FLIP 飞跃与 RO 重复解绑 Bug 在两处同时存在）；
  3. 双倍的 CSS 与 TSX 体积，严重违反代码整洁与 DRY 纪律。
- **极致修复方案**：
  彻底重构 `SegmentedControl.tsx`，将其还原为消费 `Tabs` 的纯净高阶封装：
  ```tsx
  import React, { forwardRef } from 'react';
  import { Tabs, TabsList, TabsTrigger } from '../Tabs/Tabs';
  import { SegmentedControlOption, SegmentedControlProps } from '../Tabs/types';

  function normalizeOption<T extends string>(raw: SegmentedControlOption<T> | T): SegmentedControlOption<T> {
    return typeof raw === 'string' ? { value: raw as T, label: raw } : raw;
  }

  export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
    function SegmentedControl({
      options: rawOptions,
      value,
      defaultValue,
      onChange,
      variant = 'pill',
      size = 'sm',
      orientation = 'horizontal',
      block = false,
      disabled = false,
      className,
      style,
      'aria-label': ariaLabel,
      ...restProps
    }, ref) {
      const options = rawOptions.map(normalizeOption);
      const initialDefault = defaultValue ?? options[0]?.value;

      return (
        <div ref={ref} style={style} {...restProps}>
          <Tabs
            value={value}
            defaultValue={initialDefault}
            onValueChange={onChange}
            variant={variant}
            size={size}
            orientation={orientation}
            block={block}
            className={className}
          >
            <TabsList aria-label={ariaLabel} role="radiogroup">
              {options.map((opt) => (
                <TabsTrigger
                  key={opt.value}
                  value={opt.value}
                  icon={opt.icon}
                  badge={opt.badge}
                  role="radio"
                  disabled={disabled || opt.disabled}
                  aria-label={opt['aria-label']}
                >
                  {opt.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      );
    }
  );
  SegmentedControl.displayName = 'SegmentedControl';
  ```

---

### 3. [严重级别: 严重] FLIP 弹性微过冲曲线导致首末项滑块冲出容器边界（Border Bleed & Clipping）
- **文件路径**：`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:13` 与 `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css:7`
- **缺陷剖析**：
  过冲曲线 `--tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5)` 的 $y_2 = 1.5$ 带来了约 $6\% \sim 8\%$ 的瞬时弹性外冲量。
  当滑块向最左侧（Index 0）或最右侧（Index N-1）滑动时，滑块会在中途冲出底板发丝边框约 $2\sim 3\text{px}$。
  如果宿主容器（例如卡片组件、设置组）设置了 `overflow: hidden`，滑块在过冲瞬间会被生硬切角（Clipping）；若未设置，滑块会突兀刺穿灰底边框（Bleeding）。
- **极致修复方案**：
  将过冲曲线调整为端点受控的微过冲阻尼曲线（如 `cubic-bezier(0.2, 0.9, 0.3, 1.15)`），既保留 Appica UI 极富生命力的弹性微回弹，又严格将过冲幅度锁定在 $<1.5\text{px}$ 的容器内边距安全裕量内。

---

### 4. [严重级别: 一般] `useEffect` 依赖项闭包缺陷导致 options 内容变更时滑块脱靶
- **文件路径**：`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:122`
- **缺陷剖析**：
  在独立实现的 `SegmentedControl.tsx` 中，`useEffect` 依赖项为 `[updateSlider, options.length, size]`。
  当父组件动态替换 `options` 数组内容但元素数量保持一致时（例如根据状态切换不同的分类标签集），`options.length` 未发生改变，`useEffect` 不会重新测量滑块位置，导致当前滑块依然停留在旧选项宽度的错误坐标上。
- **极致修复方案**：
  通过架构重构直接并入 `Tabs`，基于 `ResizeObserver` 与 DOM 子节点 Mutation 统一自适应测量，从根源消灭依赖项陷阱。

---

## 四、审查结论与整改指令

1. **同心圆角红线**：`SegmentedControl.module.css` 必须立即废除硬编码 `7px`，全面修正为 $R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$ 并在所有四档尺寸（`xs/sm/md/lg`）下落地对应几何矩阵。
2. **Zero-FOUC 铁律**：`Switch` 的 Checkmark 与 `Tabs` / `SegmentedControl` 的 Indicator 必须全面加装首屏静态锁，彻底杜绝挂载瞬间的飞跃与延迟绘制闪烁。
3. **架构整洁与消灭重复**：`SegmentedControl` 必须全量收束重构为 `Tabs` 体系的高阶轻量封装，清除 260 行冗余实现代码。
4. **性能与 A11y 闭环**：补齐 `html[data-perf-tier='eco']` 规则，重构 `ResizeObserver` 订阅生命周期为单次常驻监听，补全 WAI-ARIA 交叉引用与 IME 守卫。
