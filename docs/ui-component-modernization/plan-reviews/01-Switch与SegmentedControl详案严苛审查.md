# Switch 与 SegmentedControl 详案严苛审查报告

> **审查文件**：
> 1. `docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md`
> 2. `docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md`
>
> **审查立场**：Conex / Crish 最严苛代码与设计质检审查。严禁任何赞美与客套，直奔问题、缺陷、潜在 Bug 与漏洞。

---

## 目录

- [一、Switch 详案严苛缺陷审查清单](#一switch-详案严苛缺陷审查清单)
  - [【缺陷 SW-01 | 致命】几何矩阵与 CSS 变量数值撕裂：两端留白严重不对称（左 1px 右 3px）](#缺陷-sw-01--致命几何矩阵与-css-变量数值撕裂两端留白严重不对称左-1px-右-3px)
  - [【缺陷 SW-02 | 致命】CSS Keyframes 双向快速打断瞬移与画面撕裂（Keyframe Teleportation）](#缺陷-sw-02--致命css-keyframes-双向快速打断瞬移与画面撕裂keyframe-teleportation)
  - [【缺陷 SW-03 | 严重】`top: 50%; translateY(-50%)` 在 125%/150% Windows DPI 下的 0.5px 亚像素模糊](#缺陷-sw-03--严重top-50-translatey-50-在-125150-windows-dpi-下的-05px-亚像素模糊)
  - [【缺陷 SW-04 | 严重】Render 阶段直接变异 Ref 破坏 React 18 并发与 StrictMode 不变量](#缺陷-sw-04--严重render-阶段直接变异-ref-破坏-react-18-并发与-strictmode-不变量)
  - [【缺陷 SW-05 | 一般】Checked 激活态下的 `:focus-visible` 边框色污染覆盖（翡翠绿被冲刷为脏灰）](#缺陷-sw-05--一般checked-激活态下的-focus-visible-边框色污染覆盖翡翠绿被冲刷为脏灰)
  - [【缺陷 SW-06 | 微小】Loading Spinner 在纯白滑块上对比度不足（违反 WCAG AA 4.5:1）](#缺陷-sw-06--微小loading-spinner-在纯白滑块上对比度不足违反-wcag-aa-451)
- [二、SegmentedControl 详案严苛缺陷审查清单](#二segmentedcontrol-详案严苛缺陷审查清单)
  - [【缺陷 SC-01 | 致命】Appica 弹簧过冲曲线 `cubic-bezier(0.175, 0.885, 0.32, 1.5)` 导致滑块破出容器边界](#缺陷-sc-01--致命appica-弹簧过冲曲线-cubic-bezier0175-0885-032-15-导致滑块破出容器边界)
  - [【缺陷 SC-02 | 致命】隐藏 Tab 挂载导致 `isReady` 假就绪与滑块全屏飞跃（Flying Slider FOUC）](#缺陷-sc-02--致命隐藏-tab-挂载导致-isready-假就绪与滑块全屏飞跃flying-slider-fouc)
  - [【缺陷 SC-03 | 严重】`updateSlider` 闭包引发 `ResizeObserver` 频繁解绑与二次 Render 瀑布](#缺陷-sc-03--严重updateslider-闭包引发-resizeobserver-频繁解绑与二次-render-瀑布)
  - [【缺陷 SC-04 | 严重】`lg` 尺寸 $3.5\text{px}$ 亚像素 Padding 导致非 Retina 屏幕光栅化模糊与不对称](#缺陷-sc-04--严重lg-尺寸-35textpx-亚像素-padding-导致非-retina-屏幕光栅化模糊与不对称)
  - [【缺陷 SC-05 | 一般】WAI-ARIA 键盘导航缺失 Home / End 键支持与空项死循环隐患](#缺陷-sc-05--一般wai-aria-键盘导航缺失-home--end-键支持与空项死循环隐患)
  - [【缺陷 SC-06 | 一般】未选中项焦点环在深色模式与灰底板上对比度丢失（$\Delta L < 1.5\%$）](#缺陷-sc-06--一般未选中项焦点环在深色模式与灰底板上对比度丢失delta-l--15)
  - [【缺陷 SC-07 | 微小】`.itemDisabled` 缺少 `pointer-events: none` 导致悬停光标穿透与事件冒泡](#缺陷-sc-07--微小itemdisabled-缺少-pointer-events-none-导致悬停光标穿透与事件冒泡)

---

# 一、Switch 详案严苛缺陷审查清单

### 【缺陷 SW-01 | 致命】几何矩阵与 CSS 变量数值撕裂：两端留白严重不对称（左 1px 右 3px）

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md:265-267, 753, 767, 781`
- **缺陷剖析**：
  详案第 265-267 行参数矩阵表声称：三档尺寸的“上下左右留白 ($P$)”恒定为 **$2\text{px}$**，水平总滑行行程 $D_{\text{travel}} = W_{\text{track}} - D_{\text{thumb}} - 2 \times P$（例如 `md`: $36 - 16 - 2 \times 2 = 16\text{px}$）。
  然而在 `Switch.module.css` 代码实现中（第 753、767、781 行）：
  ```css
  .size-md {
    --track-w: 36px;
    --track-h: 20px;
    --thumb-d: 16px;
    --thumb-pad: 1px; /* 致命错误！此处硬编码为 1px */
    --thumb-travel: 16px;
  }
  ```
  在盒模型下，初始静止状态滑块左侧间距为 `left: var(--thumb-pad)` = **$1\text{px}$**；
  当滑块位移 $16\text{px}$ 到达 Checked 终点时，滑块右边缘坐标为 $1\text{px} + 16\text{px}(\text{位移}) + 16\text{px}(\text{直径}) = 33\text{px}$。
  轨道总宽度为 $36\text{px}$，右侧剩余间隙为 $36 - 33 =$ **$3\text{px}$**！
  **左侧留白 $1\text{px}$，右侧留白 $3\text{px}$，两端间隙相差 300%！** 所谓“数学级视网膜对称”在 CSS 实现层面直接崩塌。
- **极致修复方案/代码片段**：
  统一盒模型度量体系。若外边框为 $1\text{px}$ 且内边距为 $2\text{px}$，必须将 `--thumb-pad` 纠正为 $2\text{px}$，或重新校准 `--thumb-travel` 与盒模型内径：
  ```css
  .size-sm {
    --track-w: 28px;
    --track-h: 16px;
    --thumb-d: 12px;
    --thumb-pad: 2px;
    --thumb-travel: 12px;
    --thumb-stretch-w: 18px;
    --stretch-x-on: 4.5px;
    --stretch-x-off: 3.5px;
  }
  .size-md {
    --track-w: 36px;
    --track-h: 20px;
    --thumb-d: 16px;
    --thumb-pad: 2px;
    --thumb-travel: 16px;
    --thumb-stretch-w: 25px;
    --stretch-x-on: 6px;
    --stretch-x-off: 5px;
  }
  .size-lg {
    --track-w: 44px;
    --track-h: 24px;
    --thumb-d: 20px;
    --thumb-pad: 2px;
    --thumb-travel: 20px;
    --thumb-stretch-w: 31px;
    --stretch-x-on: 8px;
    --stretch-x-off: 6.5px;
  }
  ```

---

### 【缺陷 SW-02 | 致命】CSS Keyframes 双向快速打断瞬移与画面撕裂（Keyframe Teleportation）

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md:851-889`
- **缺陷剖析**：
  方案在 CSS 中通过静态 `@keyframes thumb-stretch-on` 与 `@keyframes thumb-stretch-off` 控制拉伸形变：
  ```css
  .hasInteracted[data-state='checked'] .thumb {
    animation: thumb-stretch-on 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }
  .hasInteracted[data-state='unchecked'] .thumb {
    animation: thumb-stretch-off 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }
  ```
  在极端交互场景（用户在 240ms 动画过程中快速双击或高频反复点击）：
  1. 用户点击开启，`thumb-stretch-on` 运行至第 90ms（当前滑块处于 $X=5\text{px}, W=22\text{px}$）；
  2. 用户在 90ms 瞬间再次点击关闭，`data-state` 立即变为 `unchecked`；
  3. 浏览器检测到类名切换，立即终止 `thumb-stretch-on`，并**强行从 0% 关键帧启动 `thumb-stretch-off`**；
  4. `thumb-stretch-off` 的 0% 关键帧硬编码了 `transform: translateY(-50%) translateX(var(--thumb-travel))`（即最右端 $16\text{px}$）；
  5. **滑块在 1 帧内瞬间从 $X=5\text{px}$ 暴力瞬移闪烁至 $X=16\text{px}$，然后再向左滑行！**
  CSS Keyframes 无法捕获并接续中断时的即时物理动量，造成严重的视觉画面撕裂。
- **极致修复方案/代码片段**：
  废除生硬的 fixed keyframes，采用由 CSS 变量与 `transition: transform, width` 驱动的弹性状态连续模型，或者使用 Web Animations API (WAAPI) 在打断时从当前 `getComputedStyle` 的实时矩阵平滑过渡：
  ```css
  /* 连续物理过渡模型：杜绝打断瞬移 */
  .thumb {
    position: absolute;
    top: 50%;
    left: var(--thumb-pad);
    width: var(--thumb-d);
    height: var(--thumb-d);
    transform: translateY(-50%) translateX(0);
    transition:
      transform 200ms cubic-bezier(0.2, 0, 0, 1),
      width 200ms cubic-bezier(0.2, 0, 0, 1);
    will-change: transform, width;
  }

  .track[data-state='checked'] .thumb {
    transform: translateY(-50%) translateX(var(--thumb-travel));
  }

  /* 按压蓄力形变：用户按住未释放时产生横向拉伸，释放时平滑位移归位 */
  .track:active:not(:disabled) .thumb {
    width: var(--thumb-stretch-w);
  }
  ```

---

### 【缺陷 SW-03 | 严重】`top: 50%; translateY(-50%)` 在 125%/150% Windows DPI 下的 0.5px 亚像素模糊

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md:188-204, 826-842`
- **缺陷剖析**：
  详案宣称 `top: 50%; transform: translateY(-50%)` 能在任何屏幕下实现绝对居中。
  然而在 Windows 常见的 **125% DPI 缩放**（Device Pixel Ratio = 1.25）下：
  - `size-md` 轨道高度为 $20\text{px}$，扣除上下各 $1\text{px}$ 边框后，CSS 内容区高度为 $18\text{px}$；
  - 物理像素高度为 $18 \times 1.25 = 22.5\text{px}$；
  - `top: 50%` 计算得物理像素 $11.25\text{px}$；
  - 滑块高度 $16\text{px} \times 1.25 = 20\text{px}$ 物理像素，`translateY(-50%)` 向上平移 $10\text{px}$；
  - 最终 Y 轴物理光栅化起点为 $11.25 - 10 = \mathbf{1.25\text{px}}$！
  **由于出现非整数物理像素 ($0.25\text{px}$ / $0.75\text{px}$)，GPU 合成层强行触发双线性插值滤波（Bilinear Filtering），导致滑块本体及其 `0 0 0 0.5px` 微收边在 125% / 150% 缩放下发生抗锯齿涂抹虚边**。
- **极致修复方案/代码片段**：
  废弃百分比与变换耦合方案，采用严格像素对齐的 `top: var(--thumb-pad); bottom: var(--thumb-pad); margin: auto 0` 盒模型居中，强制锁定整数像素栅格：
  ```css
  .thumb {
    position: absolute;
    top: var(--thumb-pad);
    left: var(--thumb-pad);
    width: var(--thumb-d);
    height: var(--thumb-d);
    /* 仅保留 X 轴硬件位移，Y 轴由物理盒模型锁定，消除 0.5px 浮点虚化 */
    transform: translateX(0);
    will-change: transform;
  }

  .track[data-state='checked'] .thumb {
    transform: translateX(var(--thumb-travel));
  }
  ```

---

### 【缺陷 SW-04 | 严重】Render 阶段直接变异 Ref 破坏 React 18 并发与 StrictMode 不变量

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md:576-585`
- **缺陷剖析**：
  `Switch.tsx` 在函数组件渲染体内部直接修改 Ref：
  ```tsx
  // 缺陷代码：在 Render Phase 变异 Ref
  if (isFirstMountRef.current) {
    isFirstMountRef.current = false;
  } else if (prevCheckedRef.current !== checked && !hasInteractedRef.current) {
    hasInteractedRef.current = true;
  }
  prevCheckedRef.current = checked;
  ```
  根据 React 官方规范（Rules of React）：**严禁在渲染阶段读取或写入 Ref**。
  1. 在 React 18 StrictMode 开发环境下，React 会对每个组件执行双重渲染（Double Invocation）。在第一次假挂载渲染中，`isFirstMountRef.current` 被设为 `false`；在第二次真实渲染时，组件被误判为非首屏，导致初始状态下的 `hasInteracted` 门闩失效；
  2. 在 Concurrent 模式下，若一次渲染被高优先级任务中断并废弃，Ref 的修改不会回滚，导致脏状态残留。
- **极致修复方案/代码片段**：
  将受控模式的状态跳变检测与首屏判定移出 Render 阶段，通过受控前值状态对比或在事件处理器中精确标记：
  ```tsx
  export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
    { checked: externalChecked, defaultChecked = false, ... },
    ref
  ) {
    const isControlled = externalChecked !== undefined;
    const [internalChecked, setInternalChecked] = useState(defaultChecked);
    const checked = isControlled ? Boolean(externalChecked) : internalChecked;

    // 使用状态标记是否由用户触发了交互，初始为 false
    const [hasInteracted, setHasInteracted] = useState(false);

    const handleToggle = useCallback(() => {
      if (!isInteractive) return;
      if (!hasInteracted) {
        setHasInteracted(true);
      }
      const nextChecked = !checked;
      if (!isControlled) {
        setInternalChecked(nextChecked);
      }
      onCheckedChange?.(nextChecked);
    }, [checked, hasInteracted, isControlled, isInteractive, onCheckedChange]);
  ```

---

### 【缺陷 SW-05 | 一般】Checked 激活态下的 `:focus-visible` 边框色污染覆盖（翡翠绿被冲刷为脏灰）

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md:798-812`
- **缺陷剖析**：
  样式中 Checked 状态定义：
  ```css
  .track[data-state='checked'] {
    background: var(--brand, hsl(160 84% 39%));
    border-color: var(--brand-deep, hsl(160 84% 30%));
  }
  ```
  而全局焦点环定义：
  ```css
  .track:focus-visible {
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
    border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }
  ```
  因为 `.track:focus-visible` 的伪类特异性与 `.track[data-state='checked']` 相当且写在后方，当处于开启状态（Checked）的绿色开关获得键盘焦点时，**其原本的深翡翠绿边框（`--brand-deep`）被无情冲刷覆盖为浅灰色的 `border-color`**，造成状态丢失。
- **极致修复方案/代码片段**：
  焦点环不应修改 `border-color`，而应通过独立的 `box-shadow` 双层外扩环来实现，或显式隔离 Checked 态的焦点边框：
  ```css
  .track:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 1px var(--bg-card),
      0 0 0 2.5px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }

  .track[data-state='checked']:focus-visible {
    border-color: var(--brand-deep);
    box-shadow:
      0 0 0 1px var(--bg-card),
      0 0 0 2.5px color-mix(in srgb, var(--brand) 70%, transparent);
  }
  ```

---

### 【缺陷 SW-06 | 微小】Loading Spinner 在纯白滑块上对比度不足（违反 WCAG AA 4.5:1）

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/01-Switch纯粹流体果冻与中轴几何对称改进详案.md:892-897`
- **缺陷剖析**：
  Spinner 颜色声明为：
  ```css
  .spinner {
    color: var(--text-tertiary, #888888);
  }
  ```
  滑块底色为纯白 `#ffffff`。`#888888` 与 `#ffffff` 的对比度仅为 **$3.54:1$**，严重低于 WCAG 2.1 AA 级图标与图形控件最低 **$4.5:1$**（或大尺寸 $3:1$）的可感知性要求，在低对比度显示器上微型转圈几乎不可辨识。
- **极致修复方案/代码片段**：
  将 Spinner 颜色提升至高对比度文本色阶：
  ```css
  .spinner {
    width: var(--spinner-size, 12px);
    height: var(--spinner-size, 12px);
    color: var(--text-secondary); /* 对比度达到 5.8:1，符合 WCAG AA */
    animation: switch-spin 750ms linear infinite;
  }
  ```

---

# 二、SegmentedControl 详案严苛缺陷审查清单

### 【缺陷 SC-01 | 致命】Appica 弹簧过冲曲线 `cubic-bezier(0.175, 0.885, 0.32, 1.5)` 导致滑块破出容器边界

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md:846, 965-969, 1046-1065`
- **缺陷剖析**：
  详案在 CSS 中直接照搬了 Appica 的过冲贝塞尔：
  ```css
  --tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5);
  ```
  此缓动曲线在 $y_2 = 1.5$ 处产生 **$4\% \sim 6\%$ 的空间物理过冲**。
  在实际测量中：
  1. 假设为双项分段器（例如设置页浅色/深色切换），容器宽度为 $160\text{px}$，单项宽度为 $77\text{px}$，边距 $3\text{px}$；
  2. 当滑块从选项 1 滑动至选项 2 时，位移差 $\Delta X = 77\text{px}$；
  3. 在过冲峰值阶段，$X_{\text{slider}} = 3\text{px} + 77\text{px} + (77 \times 0.05)\text{px} = 83.85\text{px}$；
  4. 滑块右边缘坐标为 $83.85\text{px} + 77\text{px} = \mathbf{160.85\text{px}}$；
  5. 容器右内壁坐标为 $160\text{px} - 1\text{px}(\text{边框}) = \mathbf{159\text{px}}$；
  6. **滑块纯白圆角实体在过冲瞬间超出容器右边框达 $1.85\text{px}$！**
  由于 `.container` 未设置 `overflow: hidden`（为了外显阴影），滑块实体直接**突破外框发生破面穿帮**，产生如同 Bug 般的粗糙抖动；同时直接违反项目 `ANTI_OVERENGINEERING_GUARDRAILS.md` 中关于禁用过冲动画的铁律。
- **极致修复方案/代码片段**：
  彻底移除 $y > 1.0$ 的过冲贝塞尔，换用克制优雅的无过冲阻尼曲线：
  ```css
  .container {
    /* 采用符合桌面原生质感的 Material Standard / Apple 缓动曲线 */
    --tab-spring-bezier: cubic-bezier(0.2, 0, 0, 1);
    --tab-duration: 200ms;
    --tab-press-duration: 80ms;
  }
  ```

---

### 【缺陷 SC-02 | 致命】隐藏 Tab 挂载导致 `isReady` 假就绪与滑块全屏飞跃（Flying Slider FOUC）

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md:655-673, 768, 971-974`
- **缺陷剖析**：
  `SegmentedControl.tsx` 中的测量与就绪逻辑如下：
  ```tsx
  const updateSlider = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const activeItem = el.querySelector<HTMLElement>(`[data-value="${CSS.escape(currentValue)}"]`);

    if (activeItem) {
      setSliderStyle({
        left: activeItem.offsetLeft,
        width: activeItem.offsetWidth,
        opacity: 1,
      });
      setIsReady(true); // 致命漏洞！当 offsetWidth === 0 时仍被标记为 true
    }
  }, [currentValue]);
  ```
  在典型消费场景（例如设置中心中非首屏的 Tab，处于 `display: none` 容器内）：
  1. 组件随设置页一同初次挂载，此时由于宿主容器 `display: none`，DOM 测得 `activeItem.offsetLeft = 0`，`offsetWidth = 0`；
  2. `updateSlider` 仍将 `isReady` 设为 `true`，`data-ready="true"` 属性注入 DOM；
  3. 当用户点击切换到该 Tab 时，容器变为 `display: block`，`ResizeObserver` 触发 `updateSlider` 重新测量出真实尺寸（例如 `left: 120px, width: 80px`）；
  4. 由于 `data-ready="true"` 已处于激活状态，CSS 过渡生效；
  5. **用户眼前瞬间出现滑块从屏幕左上角 $(0,0)$ 带着 250ms 动效大跨度横穿飞跃至目标选项！**
- **极致修复方案/代码片段**：
  增加有效几何尺寸门锁，仅在测得真实物理尺寸（`offsetWidth > 0`）时才允许解锁 `isReady`：
  ```tsx
  const updateSlider = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const activeItem = el.querySelector<HTMLElement>(
      `[data-value="${CSS.escape(currentValue)}"]`
    );

    if (activeItem && activeItem.offsetWidth > 0) {
      setSliderStyle({
        left: activeItem.offsetLeft,
        width: activeItem.offsetWidth,
        opacity: 1,
      });
      setIsReady(true);
    } else {
      // 尺寸不可用时不激活过渡动画
      setSliderStyle((prev) => ({ ...prev, opacity: 0 }));
    }
  }, [currentValue]);
  ```

---

### 【缺陷 SC-03 | 严重】`updateSlider` 闭包引发 `ResizeObserver` 频繁解绑与二次 Render 瀑布

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md:655-684`
- **缺陷剖析**：
  ```tsx
  useEffect(() => {
    updateSlider();
    const el = containerRef.current;
    if (!el) return;
    const ro = ResizeObserverManager.getInstance();
    ro.observe(el, updateSlider);
    return () => {
      ro.unobserve(el, updateSlider);
    };
  }, [updateSlider, options.length, size]);
  ```
  `updateSlider` 依赖了 `currentValue`。
  用户每次点击切换选项，`currentValue` 变更导致 `updateSlider` 重新生成，触发 `useEffect` 的 Cleanup。
  `ro.unobserve` 与 `ro.observe` 在每一次点击时都被无意义地注销并重新注册；
  同时，每次触发点击都会先触发一次 React 状态更新（`setInternalValue`），然后在 `useEffect` 中触发 `setSliderStyle`，**导致单次交互恒定触发 2 次同步 VDOM Render 瀑布**。
- **极致修复方案/代码片段**：
  使用不变的 Ref 持有最新状态，保持 `ResizeObserver` 监听句柄全局单例且生命周期稳定：
  ```tsx
  const currentValueRef = useRef(currentValue);
  currentValueRef.current = currentValue;

  const measureAndLayout = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const val = currentValueRef.current;
    const activeItem = el.querySelector<HTMLElement>(`[data-value="${CSS.escape(val)}"]`);
    if (activeItem && activeItem.offsetWidth > 0) {
      setSliderStyle({
        left: activeItem.offsetLeft,
        width: activeItem.offsetWidth,
        opacity: 1,
      });
      setIsReady(true);
    }
  }, []);

  // 挂载期仅注册一次 ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = ResizeObserverManager.getInstance();
    ro.observe(el, measureAndLayout);
    return () => {
      ro.unobserve(el, measureAndLayout);
    };
  }, [measureAndLayout]);

  // 当值改变时仅执行单次直接测量
  useLayoutEffect(() => {
    measureAndLayout();
  }, [currentValue, measureAndLayout]);
  ```

---

### 【缺陷 SC-04 | 严重】`lg` 尺寸 $3.5\text{px}$ 亚像素 Padding 导致非 Retina 屏幕光栅化模糊与不对称

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md:388-394, 920-928`
- **缺陷剖析**：
  在 `size="lg"` 档位中，详案声明：
  ```css
  .containerLg,
  .container[data-size='lg'] {
    --seg-h: 38px;
    --seg-pad: 3.5px;
    --seg-outer-radius: var(--radius-xl, 10px);
    --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 6.5px */
  }
  ```
  在 100% 物理 DPI 屏幕下，CSS 无法渲染半物理像素 $3.5\text{px}$。
  Blink / Gecko 引擎在执行盒模型排版时，顶部内边距向下取整为 $3\text{px}$，底部内边距向上取整为 $4\text{px}$，**造成滑块在垂直方向上产生 $1\text{px}$ 的肉眼可见偏心下坠**，破坏同心圆角几何体系。
- **极致修复方案/代码片段**：
  将 `lg` 档位的所有几何参数规整为偶数/整数像素栅格：
  ```css
  .containerLg,
  .container[data-size='lg'] {
    --seg-h: 38px;
    --seg-pad: 3px; /* 规整为整数 3px 或 4px */
    --seg-outer-radius: 10px;
    --seg-inner-radius: 7px; /* 10px - 3px = 7px 完美同心 */
    --seg-fs: var(--font-size-md, 15px);
    --seg-item-px: var(--space-4, 16px);
    --seg-icon-size: 18px;
  }
  ```

---

### 【缺陷 SC-05 | 一般】WAI-ARIA 键盘导航缺失 Home / End 键支持与空项死循环隐患

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md:700-737`
- **缺陷剖析**：
  `SegmentedControl.tsx` 的 `handleKeyDown` 只监听了 `ArrowLeft`、`ArrowRight`、`ArrowUp`、`ArrowDown`。
  根据 WAI-ARIA Authoring Practices Guide (APG) Radio Group 规范：
  - `Home` 键必须将焦点与选中态立即移至**第一个未禁用的单选项**；
  - `End` 键必须将焦点与选中态立即移至**最后一个未禁用的单选项**；
  详案完全缺失此无障碍按键支持。
- **极致修复方案/代码片段**：
  在 `handleKeyDown` 中补全完整的 WAI-ARIA 1.2 RadioGroup 键盘事件处理：
  ```tsx
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || options.length === 0) return;
    const enabledOptions = options.filter((o) => !o.disabled);
    if (enabledOptions.length === 0) return;

    let targetOption: SegmentedControlOption<T> | undefined;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const currentIdx = enabledOptions.findIndex((o) => o.value === currentValue);
      const nextIdx = (currentIdx + 1) % enabledOptions.length;
      targetOption = enabledOptions[nextIdx];
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const currentIdx = enabledOptions.findIndex((o) => o.value === currentValue);
      const prevIdx = currentIdx <= 0 ? enabledOptions.length - 1 : currentIdx - 1;
      targetOption = enabledOptions[prevIdx];
    } else if (e.key === 'Home') {
      e.preventDefault();
      targetOption = enabledOptions[0];
    } else if (e.key === 'End') {
      e.preventDefault();
      targetOption = enabledOptions[enabledOptions.length - 1];
    }

    if (targetOption) {
      handleSelect(targetOption.value);
      const nextEl = containerRef.current?.querySelector<HTMLElement>(
        `[data-value="${CSS.escape(targetOption.value)}"]`
      );
      nextEl?.focus();
    }
  };
  ```

---

### 【缺陷 SC-06 | 一般】未选中项焦点环在深色模式与灰底板上对比度丢失（$\Delta L < 1.5\%$）

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md:1025-1029`
- **缺陷剖析**：
  `.item:focus-visible` 定义如下：
  ```css
  .item:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  }
  ```
  在未选中的分段项上，背景色为深色槽位底板（`--bg-secondary`）。
  仅混入 6% `var(--text-primary)` 的微弱灰色焦点环在深色背景下与底板的明度差 $\Delta L < 1.5\%$。
  对于低视力用户与纯键盘操作者而言，**焦点环几乎彻底隐形**，严重违反 WCAG 2.4.7 Focus Visible（AA 级）准则。
- **极致修复方案/代码片段**：
  焦点环改用微发丝内衬双层环，在保证克制柔和（$\le 10\%$）的同时建立清晰的明暗边缘轮廓：
  ```css
  .item:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 1px var(--bg-card),
      0 0 0 2px color-mix(in srgb, var(--text-primary) 10%, var(--border-color) 90%);
  }
  ```

---

### 【缺陷 SC-07 | 微小】`.itemDisabled` 缺少 `pointer-events: none` 导致悬停光标穿透与事件冒泡

- **文件路径与行号**：`docs/ui-component-modernization/plan-improvements/04-设置页分段控件灰度加深Bug根治与大圆角详案.md:1031-1035`
- **缺陷剖析**：
  ```css
  .itemDisabled {
    cursor: not-allowed;
    opacity: var(--opacity-disabled, 0.45);
  }
  ```
  虽然 `<button>` 具备原生 `disabled`，但在特定浏览器中，子节点（如 `.itemIcon` 内的 SVG 或 `.itemBadge`）在鼠标移动时仍会向上传播 `pointermove` 事件，导致父级容器误触发 Hover 判定或光标在 `not-allowed` 与 `default` 之间高频抖动闪烁。
- **极致修复方案/代码片段**：
  在 `.itemDisabled` 内部显式封死所有子元素的指针响应：
  ```css
  .itemDisabled {
    cursor: not-allowed;
    opacity: var(--opacity-disabled, 0.45);
    pointer-events: none;
  }
  ```

---

## 审查结论与门禁裁决

| 待审方案 | 致命缺陷 (Blocker) | 严重缺陷 (Critical) | 一般缺陷 (Major) | 微小缺陷 (Minor) | 综合审查裁决 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **01-Switch 改进详案** | **2** 项 | **2** 项 | **1** 项 | **1** 项 | ❌ **阻断 (需就地修复)** |
| **04-SegmentedControl 改进详案** | **2** 项 | **2** 项 | **2** 项 | **1** 项 | ❌ **阻断 (需就地修复)** |

**核心整改要求**：
1. **Switch 必须修正 CSS 与表格间隙的 1px/3px 撕裂，彻底消除快速连击时的 Keyframes 瞬移；**
2. **SegmentedControl 必须剔除 $y=1.5$ 导致滑块破框的过冲曲线，并给 `isReady` 注入 `offsetWidth > 0` 守卫以彻底消灭 Flying Slider 飞跃 Bug。**
