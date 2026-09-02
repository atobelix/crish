# Switch 与 SegmentedControl 实施成果终态严苛审查报告

> **审查基准**：
> - `docs/ui-component-modernization/independent-plans/01-Switch流体果冻动效与自研React实现方案.md`
> - `docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md`
> - `docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md`
> - `AGENTS.md`（§13 焦点环规范、§14 现代色彩空间、反过度设计红线与单文件行数约束）
>
> **审查对象**：
> - `apps/crish-desktop/src/components/ui/Switch/`（[`Switch.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.tsx), [`Switch.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css), [`Switch.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.test.tsx)）
> - `apps/crish-desktop/src/components/ui/SegmentedControl/`（[`SegmentedControl.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx), [`SegmentedControl.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css), [`SegmentedControl.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.test.tsx)）
>
> **审查立场**：只挑刺，别的一概不说。直奔问题、缺陷、潜在 Bug 与漏洞！

---

## 缺陷统计矩阵

| 组件模块 | 致命 (Fatal) | 严重 (Critical) | 一般 (Major) | 微小 (Minor) | 合计 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Switch** | 2 | 2 | 1 | 0 | **5** |
| **SegmentedControl** | 2 | 2 | 2 | 1 | **7** |
| **总计** | **4** | **4** | **3** | **1** | **12** |

---

## 一、Switch 终态实施严苛缺陷审查

### 1. [严重级别: 致命] 盒模型与位移参数撕裂：全尺寸激活态右侧留白硬碰撞为 0px（左 2px ↔ 右 0px 严重不对称）
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Switch/Switch.module.css:56-97`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css#L56-L97)
- **缺陷剖析**：
  `.track` 声明了 `box-sizing: border-box; border: 1px solid var(--border-subtle);`。在 W3C 盒模型规范下，子元素 `.thumb`（`position: absolute; left: var(--thumb-pad)`）的绝对定位包含块是 `.track` 的内边距框（Padding Box）。
  以 `size-md` 为例：
  - 轨道外宽 $36\text{px}$，扣除左右边框后内径可用宽度为 $W_{\text{inner}} = 36 - 2 = 34\text{px}$；
  - 滑块直径 $D_{\text{thumb}} = 16\text{px}$，左侧内边距 `--thumb-pad: 2px`；
  - 未激活态（Unchecked）：滑块左边缘距离内壁为 $2\text{px}$（距离外边框 $3\text{px}$）；
  - 激活态（Checked）：位移声明为 `--thumb-travel: 16px`。位移后滑块右边缘在内边距框中的坐标为：
    $$X_{\text{right}} = 2\text{px} (\text{left}) + 16\text{px} (\text{travel}) + 16\text{px} (\text{width}) = 34\text{px}$$
  - 然而轨道内径总宽恰好就是 $34\text{px}$！因此滑块右边缘距离轨道内边框间隙为 $34\text{px} - 34\text{px} = \mathbf{0px}$（距离外边缘仅 $1\text{px}$）！
  - 同理在 `size-sm`（外宽 $28\text{px}$，内宽 $26\text{px}$，滑块 $12\text{px}$）：右边缘 $2 + 12 + 12 = 26\text{px} \implies$ **右侧留白恒等于 $0\text{px}$**！
  - 同理在 `size-lg`（外宽 $44\text{px}$，内宽 $42\text{px}$，滑块 $20\text{px}$）：右边缘 $2 + 20 + 20 = 42\text{px} \implies$ **右侧留白恒等于 $0\text{px}$**！
  - 同时，垂直方向上：轨道内高为 $20 - 2 = 18\text{px}$，滑块 $16\text{px}$，中轴居中后上下留白各为 $\frac{18-16}{2} = 1\text{px}$。
  - **全尺寸下开关开启时滑块直接硬生生撞在右边框内壁上（$0\text{px}$），与未开启时的左留白（$2\text{px}$）以及上下留白（$1\text{px}$）形成严重几何割裂**。
- **极致修复方案/代码片段**：
  必须基于 $W_{\text{inner}} = W_{\text{track}} - 2 \times 1\text{px}$ 重新计算并保持四向留白均为严格 $1\text{px}$ 或 $2\text{px}$ 恒等。若保持 1px 均匀微边距（使上下左右完全一致）：
  ```css
  /* 修复：基于 1px 均匀对称四向留白校准 */
  .size-sm {
    --track-w: 28px;
    --track-h: 16px;
    --thumb-d: 12px;
    --thumb-pad: 1px;
    --thumb-travel: 12px; /* 26px(内宽) - 12px - 1px - 1px = 12px */
    --thumb-stretch-w: 18px;
    --stretch-x-on: 4.5px;
    --stretch-x-off: 3.5px;
  }

  .size-md {
    --track-w: 36px;
    --track-h: 20px;
    --thumb-d: 16px;
    --thumb-pad: 1px;
    --thumb-travel: 16px; /* 34px(内宽) - 16px - 1px - 1px = 16px */
    --thumb-stretch-w: 24px;
    --stretch-x-on: 5.5px;
    --stretch-x-off: 4.5px;
  }

  .size-lg {
    --track-w: 44px;
    --track-h: 24px;
    --thumb-d: 20px;
    --thumb-pad: 1px;
    --thumb-travel: 20px; /* 42px(内宽) - 20px - 1px - 1px = 20px */
    --thumb-stretch-w: 30px;
    --stretch-x-on: 7.5px;
    --stretch-x-off: 6px;
  }
  ```

---

### 2. [严重级别: 致命] CSS Keyframes 快速连击双向打断瞬移穿帮（Keyframe Teleportation）
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Switch/Switch.module.css:163-202`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css#L163-L202)
- **缺陷剖析**：
  组件采用 `@keyframes thumb-stretch-on` 与 `@keyframes thumb-stretch-off` 驱动果冻拉伸动画：
  ```css
  .hasInteracted[data-state='checked'] .thumb {
    animation: thumb-stretch-on 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }
  .hasInteracted[data-state='unchecked'] .thumb {
    animation: thumb-stretch-off 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }
  ```
  当用户在 $240\text{ms}$ 动画执行途中快速二次点击（如在 $80\text{ms}$ 时快速双击翻转）：
  1. 当前正在播放 `thumb-stretch-on`，滑块位于轨道中间位置（如 $X=6\text{px}$）；
  2. 用户点击将状态翻转为 `unchecked`，类名瞬间切换；
  3. 浏览器立即强行终止 `thumb-stretch-on`，并从 `thumb-stretch-off` 的 `0%` 关键帧重新启动；
  4. 而 `thumb-stretch-off` 的 `0%` 硬编码为 `transform: translateY(-50%) translateX(var(--thumb-travel));`；
  5. **滑块在 1 帧内直接从 $X=6\text{px}$ 暴力瞬移到最右端 $X=16\text{px}$，然后再向左滑行！**
  动画发生极其刺眼的画面撕裂与瞬移闪烁。
- **极致修复方案/代码片段**：
  放弃硬编码首尾关键帧的 CSS `@keyframes`，改用状态连续的 CSS `transition` 模型（`transition: transform 200ms cubic-bezier(0.2, 0, 0, 1), width ...`），使得打断时浏览器能直接继承当前运行时矩阵无缝反向过渡：
  ```css
  .thumb {
    position: absolute;
    top: 50%;
    left: var(--thumb-pad);
    width: var(--thumb-d);
    height: var(--thumb-d);
    transform: translateY(-50%) translateX(0);
    will-change: transform, width;
    transition:
      transform 200ms cubic-bezier(0.2, 0, 0, 1),
      width 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  .track[data-state='checked'] .thumb {
    transform: translateY(-50%) translateX(var(--thumb-travel));
  }

  /* 按压期间自然拉伸形变，释放时平滑归位，彻底消除 keyframe 打断瞬移 */
  .track:active:not(:disabled) .thumb {
    width: var(--thumb-stretch-w);
  }
  ```

---

### 3. [严重级别: 严重] 受控模式下 `useEffect` 状态滞后导致首帧闪现跳跃（1-Frame Jump Flash）
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Switch/Switch.tsx:85-94`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.tsx#L85-L94) 与 [`Switch.module.css:159-170`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css#L159-L170)
- **缺陷剖析**：
  在 `Switch.tsx` 中：
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
  在受控模式下，当父组件传入新的 `checked=true` 时：
  1. **Frame 0（初始 Render 与 Paint）**：`hasInteracted` 状态仍为 `false`。DOM 树渲染的 class 只有 `.track`（无 `.hasInteracted`）。此时命中静态规则：
     ```css
     .track[data-state='checked'] .thumb {
       transform: translateY(-50%) translateX(var(--thumb-travel));
     }
     ```
     浏览器在第 0 帧直接将滑块绘制在最右侧（$16\text{px}$ 处）；
  2. **Frame 1**：浏览器绘制完毕后执行 `useEffect`，调用 `setHasInteracted(true)`，触发组件第 2 次 Render；
  3. **Frame 2**：类名变更为 `.track.hasInteracted`，激活动画 `thumb-stretch-on`；
  4. 该动画的关键帧 `0%` 为 `translateX(0)`！**滑块在第 0 帧出现在右侧，第 2 帧瞬间闪退回左侧重新开始播放向右动画！**
- **极致修复方案/代码片段**：
  动画应当由 CSS 状态连续的 `transition` 直接承载，首屏挂载通过属性选择器关闭初始 transition，避免在 React 内部依赖 `useEffect` 滞后打标：
  ```tsx
  // 移除 useEffect setHasInteracted 级联渲染
  // 仅在首次渲染时标记挂载完成
  const isMountedRef = useRef(false);
  useLayoutEffect(() => {
    isMountedRef.current = true;
  }, []);
  ```

---

### 4. [严重级别: 严重] CSS `color-mix` 百分比语法错误导致未激活态 Hover 背景色变化完全失效（0% 混入）
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Switch/Switch.module.css:100-103`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css#L100-L103)
- **缺陷剖析**：
  CSS 第 102 行代码：
  ```css
  .track:hover:not(:disabled) {
    border-color: var(--border-color);
    background: color-mix(in srgb, var(--switch-track-bg, var(--bg-tertiary)) 100%, var(--tint-hover));
  }
  ```
  在 W3C CSS Color Module Level 4 规范中，`color-mix(in srgb, ColorA P%, ColorB)` 若第一项显式声明了 `100%` 且第二项省略百分比，第二项的混入比例自动计算为 $100\% - 100\% = 0\%$。
  因此该表达式恒等计算为：`100% var(--switch-track-bg) + 0% var(--tint-hover)`。
  **`--tint-hover` 的混入率为 0%，鼠标悬停在关闭状态的 Switch 轨道上时背景色没有任何 Hover 视觉响应**。
- **极致修复方案/代码片段**：
  纠正 `color-mix` 百分比权重，按设计规范混入微量 Hover 增亮：
  ```css
  .track:hover:not(:disabled) {
    border-color: var(--border-color);
    background: color-mix(in srgb, var(--switch-track-bg, var(--bg-tertiary)) 88%, var(--tint-hover));
  }
  ```

---

### 5. [严重级别: 一般] Loading 态下 `<button>` 未同步 `aria-disabled="true"` 破坏无障碍语义
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/Switch/Switch.tsx:137-140`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.tsx#L137-L140)
- **缺陷剖析**：
  当 `loading={true}` 且 `disabled={false}` 时，组件内部锁死了交互（`isInteractive = false`），但 DOM 渲染节点为：
  ```tsx
  aria-disabled={disabled || undefined}
  aria-busy={loading || undefined}
  disabled={disabled}
  ```
  此时 `<button>` 原生 `disabled` 为 `false` 且 `aria-disabled` 为 `undefined`。屏幕阅读器向视障用户读报为“可点击的普通开关”，但在用户尝试点击或按空格/回车时却被静默拦截，缺乏不可操作的语义反馈。
- **极致修复方案/代码片段**：
  在 `aria-disabled` 中同步纳入 `loading` 状态：
  ```tsx
  aria-disabled={disabled || loading || undefined}
  ```

---

## 二、SegmentedControl 终态实施严苛缺陷审查

### 1. [严重级别: 致命] 无选中项/空值时全部 TabIndex 坍缩为 -1，导致 Radiogroup 彻底丧失键盘可聚焦性
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:256`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx#L256)
- **缺陷剖析**：
  代码在渲染子单选按钮时：
  ```tsx
  tabIndex={isSelected ? 0 : -1}
  ```
  在以下场景中：
  1. `value` 初始未匹配任何 option（例如异步加载选项或外部受控值为空 `""`）；
  2. 或所有选项的 `value !== currentValue`；
  所有子 `<button>` 的 `isSelected` 均为 `false`，导致所有按钮的 `tabIndex` 均被赋值为 `-1`！
  同时，外层容器 `<div role="radiogroup">` 没有设置 `tabIndex`。
  **整个组件在页面中完全无法被 Tab 键聚焦，键盘用户直接跳过该控件，组件对无障碍键盘操作者彻底消失！**
  根据 WAI-ARIA 1.2 RadioGroup 规范：若群组内无任何选中项，首个未禁用的单选项必须被赋予 `tabIndex="0"` 以作为焦点入口。
- **极致修复方案/代码片段**：
  在 Roving Tabindex 逻辑中增加回退机制，确保至少有一个可用项具备 `tabIndex={0}`：
  ```tsx
  const hasSelection = options.some((o) => o.value === currentValue);
  const firstEnabledIndex = options.findIndex((o) => !o.disabled && !disabled);

  // 在 map 中：
  const isFocusable = isSelected || (!hasSelection && idx === firstEnabledIndex);
  tabIndex={isFocusable ? 0 : -1}
  ```

---

### 2. [严重级别: 致命] RestProps 后置展开直接覆写抹杀内部 `onKeyDown` 键盘漫游处理器
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:225-227`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx#L225-L227)
- **缺陷剖析**：
  组件根元素渲染代码如下：
  ```tsx
  <div
    ...
    onKeyDown={handleKeyDown}
    style={style}
    {...restProps}
  >
  ```
  `{...restProps}` 放置在 `onKeyDown={handleKeyDown}` 之后。当外部调用者传递了自定义的 `onKeyDown` 时：
  - `restProps.onKeyDown` 将直接**无条件覆盖抹除**组件内置的 `handleKeyDown`；
  - 且内置 `handleKeyDown` 从未转发外部的 `onKeyDown`；
  - **任何传入 `onKeyDown` 的消费场景都会导致 Arrow/Home/End 键盘漫游机制彻底瘫痪**。
- **极致修复方案/代码片段**：
  显式解构 `onKeyDown`，并在内部处理器中优先调用外部回调：
  ```tsx
  const {
    onKeyDown: externalOnKeyDown,
    ...otherRestProps
  } = restProps;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    externalOnKeyDown?.(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    // ... 执行 Arrow/Home/End 漫游
  };
  ```

---

### 3. [严重级别: 严重] 键盘事件监听缺失 IME 输入法组合态判定（`isComposing`），摧毁中文输入法选词
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:156-193`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx#L156-L193)
- **缺陷剖析**：
  `handleKeyDown` 在检测到 `ArrowRight / ArrowLeft / Home / End` 按键时直接无条件执行 `e.preventDefault()` 并切换当前分段项。
  未检查 `e.nativeEvent.isComposing`。
  当分段控件内嵌有可输入节点，或在嵌套表单区域触发输入法焦点时，用户按下左右方向键移动拼音光标或按 Home/End 跳跃拼音串，事件被分段控件暴力拦截，导致**输入法候选框异常关闭，中文打字流程被打断**。
- **极致修复方案/代码片段**：
  在 `handleKeyDown` 入口处添加 IME 守卫：
  ```tsx
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (disabled || options.length === 0) return;
    // ...
  };
  ```

---

### 4. [严重级别: 严重] `useEffect` 异步测量导致首屏挂载与选项切换时的 1 帧布局跳跃（Layout Shift Flash）
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:127-140`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx#L127-L140)
- **缺陷剖析**：
  滑块的 `updateSlider` 在 `useEffect` 中触发：
  ```tsx
  useEffect(() => {
    updateSlider();
  }, [currentValue, options.length, size, updateSlider]);
  ```
  `useEffect` 是在浏览器完成 Paint（绘制）后才异步执行的。
  在组件挂载或选项值变更时：
  1. 浏览器先完成第 1 帧绘制（此时滑块停留在旧坐标或 `opacity: 0`）；
  2. 随后执行 `useEffect` 测量 `offsetLeft` 并调用 `setSliderStyle`；
  3. 触发二次 Render 与第二次 Paint。
  **不仅造成了双重同步渲染瀑布，还在首屏或快速切换时产生肉眼可见的 1 帧布局闪烁与滞后跳跃**。
- **极致修复方案/代码片段**：
  DOM 几何测量应在 DOM 突变后、浏览器 Paint 前同步完成，使用 `useLayoutEffect` 替换 `useEffect`：
  ```tsx
  useLayoutEffect(() => {
    updateSlider();
  }, [currentValue, options.length, size, updateSlider]);
  ```

---

### 5. [严重级别: 一般] 未选中项焦点环内层硬编码 `var(--bg-card)` 导致在深色底板上产生刺眼亮白边
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:190-195`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L190-L195)
- **缺陷剖析**：
  代码中焦点环定义如下：
  ```css
  .item:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 1px var(--bg-card),
      0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }
  ```
  分段控件容器底板颜色为 `--bg-secondary`（灰度/深色背景）。
  当键盘焦点移动到**未选中的分段项**时，该选项下方并没有白色的 `.activeSlider`，直接裸露容器的 `--bg-secondary` 底色。
  此时 `box-shadow` 内层强制绘制 $1\text{px}$ 的 `var(--bg-card)`（纯白底色），导致未选中的深灰选项周围突兀地浮现一圈白色的刺眼缝隙光晕，违反 AGENTS.md §13 焦点环克制规范。
- **极致修复方案/代码片段**：
  区分激活项与未激活项的焦点环垫底色：
  ```css
  .item:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 1px var(--bg-secondary),
      0 0 0 2.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }

  .item[data-active='true']:focus-visible {
    box-shadow:
      0 0 0 1px var(--bg-card),
      0 0 0 2.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }
  ```

---

### 6. [严重级别: 一般] `SegmentedControlProps` 接口未继承 `HTMLAttributes<HTMLDivElement>` 破坏原生属性透传
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:35-56`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx#L35-L56)
- **缺陷剖析**：
  `SegmentedControlProps` 声明为独立接口：
  ```tsx
  export interface SegmentedControlProps<T extends string = string> {
    options: (SegmentedControlOption<T> | T)[];
    value?: T;
    defaultValue?: T;
    onChange?: (value: T) => void;
    size?: SegmentedControlSize;
    disabled?: boolean;
    block?: boolean;
    className?: string;
    style?: React.CSSProperties;
    'aria-label'?: string;
  }
  ```
  未 `extends React.HTMLAttributes<HTMLDivElement>`。
  但组件内部直接将 `...restProps` 铺设到根 `<div {...restProps}>` 上。
  导致消费方无法合法传递 `id`, `data-testid`, `title`, `aria-describedby` 等合法 HTML / ARIA 属性，TypeScript 编译阶段会直接拦截报错。
- **极致修复方案/代码片段**：
  扩展原生 div 属性接口：
  ```tsx
  export interface SegmentedControlProps<T extends string = string>
    extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
    options: (SegmentedControlOption<T> | T)[];
    value?: T;
    defaultValue?: T;
    onChange?: (value: T) => void;
    size?: SegmentedControlSize;
    disabled?: boolean;
    block?: boolean;
  }
  ```

---

### 7. [严重级别: 微小] `rawOptions.map(normalizeOption)` 在每次渲染重复分配数组内存
- **文件路径与行号**：[`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx:87`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.tsx#L87)
- **缺陷剖析**：
  组件在函数体顶层直接执行：
  ```tsx
  const options = rawOptions.map(normalizeOption);
  ```
  每次父组件 Re-render 都会创建全新的 `options` 数组引用，增加了垃圾回收（GC）开销，且在多次依赖比对中失去引用稳定性。
- **极致修复方案/代码片段**：
  使用 `useMemo` 稳定 options 引用：
  ```tsx
  const options = React.useMemo(
    () => rawOptions.map(normalizeOption),
    [rawOptions]
  );
  ```

---

## 审查结论与整改裁决

| 审查模块 | 致命缺陷 (Blocker) | 严重缺陷 (Critical) | 一般缺陷 (Major) | 微小缺陷 (Minor) | 终态审查裁决 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **ui/Switch** | **2** 项 | **2** 项 | **1** 项 | 0 项 | ❌ **未达终态，需就地整改** |
| **ui/SegmentedControl** | **2** 项 | **2** 项 | **2** 项 | **1** 项 | ❌ **未达终态，需就地整改** |

**核心整改底线**：
1. **Switch 必须修正 CSS 变量盒模型内宽计算，彻底解决激活态右侧留白硬碰撞为 0px 的严重几何撕裂，并消除 Keyframe Teleportation 瞬移与 `useEffect` 首帧闪跳；**
2. **SegmentedControl 必须修正空选中态下 `tabIndex` 全员 -1 导致的键盘不可访问性漏洞，修复 `restProps` 覆盖 `onKeyDown` 与 IME 打断问题，并将测量逻辑提升至 `useLayoutEffect`。**
