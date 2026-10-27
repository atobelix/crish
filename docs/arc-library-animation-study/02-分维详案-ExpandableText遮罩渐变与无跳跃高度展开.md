# 分维详案：ExpandableText 遮罩渐变与无跳跃高度展开动效分析

> **战役工作区**：`docs/arc-library-animation-study/`  
> **专题维度**：ExpandableText 动态渐变遮罩、物理自适应时长、探针测高与无障碍体验  
> **权威对标参考**：`reference/arc-library/registry/components/expandable-text/`  
> **项目对齐标的**：`apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx`、`apps/crish-desktop/src/components/chat-message/FoldableProcessSection.tsx`、`apps/crish-desktop/src/components/chat-message-row/ReasoningRow.tsx`

---

## 一、设计哲学：“动态归动效接管，静止归纯 CSS 控制”

在 Web 高度折叠展开动效中，经典难题往往在于：
1. **纯 CSS 方案（如 `grid-template-rows: 0fr/1fr`）**：缺乏对真实展开高度的像素级感知，无论 20px 还是 2000px 只能使用固定时长；展开边缘常为生硬的 `overflow: hidden` 刀切截断；
2. **纯 JS 方案（如直接 `animate({ height })`）**：动效结束后若行内样式保留具体像素高度（如 `height: 120px`），当用户拖动改变窗口宽度引发文本重排（Reflow）或缩放系统字号时，定死的高度必然导致文字截断破损或底部大块空白。

arc-library 的 `ExpandableText` 确立了工业级设计准则：
> **“Height is owned by motion while it moves; at rest the clamp is plain CSS, so it follows every width and font change for free.”**（展开运动中高度由 Motion 接管，落定静止时高度交还给原生 CSS，零成本自适应所有宽度与字体变动）。

---

## 二、ExpandableText 六大核心动效机制剖析

### 2.1 单一归一化标量 `progress` 驱动全系统
- **核心代码**：`expandable-text.tsx:62-77`
  ```tsx
  /** 0 is clamped, 1 is fully open. Height, the fade, and the chevron all follow this one value, so they always move in step. */
  const progress = useMotionValue(expanded ? 1 : 0);
  const height = useMotionValue<number | "auto">("auto");
  const rotate = useTransform(progress, [0, 1], [0, 180]);

  const maskImage = useTransform(progress, value => {
    const fade = Math.pow(1 - Math.min(Math.max(value, 0), 1), 1.35);
    return fade <= 0.002 ? "none" : `linear-gradient(to bottom, #000 calc(100% - 1.6lh), rgb(0 0 0 / ${(1 - fade * 0.96).toFixed(3)}) 100%)`;
  });

  useEffect(() => progress.on("change", value => {
    if (!running.current) return;
    const { from, to } = range.current;
    height.set(from + (to - from) * value);
  }), [progress, height]);
  ```
- **架构优势**：
  - **SSOT（单一真理源）**：所有物理动画插值仅对 `progress`（0 到 1）执行一次。高度映射、箭头旋转（0° 到 180°）和遮罩透明度均严格派生自 `progress`，彻底消除了由于多个并发计时器不同步导致的相位漂移（Phase Drift）。
  - **中途打断连续无损折返（Mid-flight Hand-off）**：若在展开运动行进至 60% 时用户再次点击折叠，系统直接读取瞬时物理高度 `current`，通过 `(current - clamp) / span` 逆向计算当前的精确 `progress`，直接以此为初态进行反向减速动画，**零跳帧、零瞬移**。

### 2.2 动态遮罩渐变：现代 CSS 1.6lh 与非线性幂函数
```tsx
// expandable-text.tsx:68-71
const maskImage = useTransform(progress, value => {
  const fade = Math.pow(1 - Math.min(Math.max(value, 0), 1), 1.35);
  return fade <= 0.002 ? "none" : `linear-gradient(to bottom, #000 calc(100% - 1.6lh), rgb(0 0 0 / ${(1 - fade * 0.96).toFixed(3)}) 100%)`;
});
```
1. **现代 CSS `1.6lh`（Line-Height）单位**：
   `calc(100% - 1.6lh)` 保证无论当前字号是 12px 还是 24px，渐变遮罩起始点**永远稳定锚定在容器底部往上 1.6 行的位置**，从根本上摒弃了脆弱的固定像素（如 `32px`）。
2. **非线性幂函数 $\text{fade} = (1 - \text{value})^{1.35}$**：
   在展开初段（`value` 从 0 开始），1.35 次方使遮罩透明度迅速从深雾中拉升，文字立刻可读；随着高度继续展开，新行始终以半透明边缘升起（“rise through the soft edge”），视觉质感极其温润。
3. **保留 4% 墨迹基底 `(1 - fade * 0.96)`**：
   折叠时底部保留 4% 微弱透明度，给予视觉潜意识“下方仍有未完文本”的心理暗示。
4. **性能截断 `fade <= 0.002 ? "none"`**：
   当接近完全展开时，遮罩立刻定格为 `"none"`，卸载 GPU 离屏蒙版合成图层，恢复原生亚像素字体抗锯齿。

### 2.3 物理自适应时长模型（openDuration / closeDuration）
```tsx
// expandable-text.tsx:31-35
const ease = [0.32, 0.5, 0.2, 1] as const;
const openDuration = (distance: number) => 0.5 + Math.min(distance / 1600, 0.1);
const closeDuration = (distance: number) => 0.4 + Math.min(distance / 2000, 0.05);
```
- **基于实际物理位移距离 `distance`**：若动画中途折返，`distance` 随剩余距离自动缩短，绝不产生“仅剩 10px 却依然走完 600ms”的滞重迟钝；
- **非对称时序设计**：
  - **展开（0.5s ~ 0.6s）**：用户准备阅读新信息，充裕的时长配合缓出曲线让视线平稳跟随；
  - **折叠（0.4s ~ 0.45s）**：用户阅读完毕收纳内容，动作更加干脆利落；
- **缓出曲线 `[0.32, 0.5, 0.2, 1]`**：起步切线斜率极高（点击瞬间即刻响应），中后段具备极长的舒缓刹车区，像空气活塞一样自然滑行到站。

### 2.4 隐形探针（Probe）测高与 CSS 原生接管
```css
/* expandable-text.module.css:3-6 */
.content { position: relative; width: 100%; min-width: 0; overflow: hidden; overflow-wrap: anywhere; }
.content[data-clamped] {
  max-height: calc(var(--expandable-text-lines) * 1.4em);
  max-height: calc(var(--expandable-text-lines) * 1lh);
}
.probe {
  position: absolute; top: 0; left: 0; width: 0;
  height: calc(var(--expandable-text-lines) * 1.4em);
  height: calc(var(--expandable-text-lines) * 1lh);
  visibility: hidden; pointer-events: none;
}
```
- **静止态释放**：动画结束瞬间，`height.set("auto")`。若展开，高度归 `auto`，随窗口拉伸自由回流；若折叠，加挂 `data-clamped`，由 CSS 原生 `calc(lines * 1lh)` 强制截断，排版缩放零 JS 介入。
- **探针测高（Probe）**：无需用复杂的 JS Canvas 计算字体包围盒，直接利用一个零宽度的隐形 `<span ref={probe} className={styles.probe} />`，测量其 `getBoundingClientRect().height`，由浏览器原生排版引擎做裁判，零误差判断是否真正溢出。

### 2.5 单 CSS Grid 单元格（`grid-area: 1 / 1`）重叠交叉渐隐
```css
/* expandable-text.module.css:13-17 */
.labels { display: inline-grid; justify-items: start; }
.label {
  grid-area: 1 / 1;
  opacity: 0; filter: blur(2px); transform: translateY(-4px);
  transition: opacity var(--duration-standard) var(--ease-standard),
              transform var(--duration-considered) var(--ease-standard),
              filter var(--duration-standard) var(--ease-standard);
  pointer-events: none;
}
.label[data-active] { opacity: 1; filter: blur(0); transform: none; }
.label + .label:not([data-active]) { transform: translateY(4px); }
```
- **痛点解决**：“Read more” 与 “Show less” 字符串长度不同，普通方案切换时会导致按钮宽度跳动，旁边的 ChevronDown 图标跟着左右乱晃；
- **机制**：两个 Label 共享同一个 Grid 单元格（`grid-area: 1 / 1`），容器自动撑大到两者中的**最大宽度**，按钮物理尺寸恒定，旋转箭头纹丝不动，文案在原地带有微小升降与 `blur(2px)` 交叉消融。

### 2.6 无障碍视口保护与焦点唤醒（A11y & Scroll Recovery）
1. **视口回滚保护（`scrollIntoView`）**（`expandable-text.tsx:128-129`）：
   当长文本展开后，用户在页面深处点击“Show less”收起时，若顶部已滚出屏幕（`node.getBoundingClientRect().top < 0`），组件在折叠时自动触发平滑回滚（`node.scrollIntoView({ block: "start", behavior: "smooth" })`），防止用户瞬间迷失在下方空白区域中。
2. **键盘焦点穿透唤醒（`onFocusCapture`）**（`expandable-text.tsx:135-140`）：
   当键盘 Tab 键聚焦到截断区下方的隐藏链接或按钮时，父级捕获到焦点且判定目标越界，**自动触发展开**，根除 WCAG 中“聚焦不可见元素”的黑洞缺陷。

---

## 三、对比 Conex 项目现状与升级路线

### 3.1 现状与差距对比

| 评估维度 | arc-library 方案 | Conex 当前实现 (`FoldableToolGroup` / `ReasoningRow`) | 差距诊断 |
| :--- | :--- | :--- | :--- |
| **高度驱动方式** | 单一 `progress` 驱动像素高度 + 动态遮罩 | CSS `grid-template-rows: 0fr/1fr` + 固定 220ms 贝塞尔 | Conex 在几千像素的长工具组展开时，220ms 会产生剧烈视觉频闪；展开边缘为硬性截断 |
| **折叠视口恢复** | 检测 `top < 0` 自动平滑滚动回顶部锚点 | **无视口恢复机制** | 用户折叠长思维链或工具日志后，屏幕瞬间发生剧烈位移，常被甩出上下文 |
| **按钮文案切换** | `grid-area: 1 / 1` 重叠布局，尺寸取最大，箭头零晃动 | 单一文本替换或独立图标 | 文案长短变化容易诱发微小像素级布局抖动 |
| **键盘焦点穿透** | `onFocusCapture` 自动展开被遮挡的聚焦子项 | 依赖 Chromium 原生 `hidden="until-found"` | 原生方案支持页面 Ctrl+F 搜索，但键盘 Tab 导航时缺乏智能展开联动 |

### 3.2 Conex 升级落地规划
1. **保留核心护城河**：
   - 必须保留 Conex 在 `FoldableToolGroup` 中的原生 `hidden="until-found"` 与 `beforematch` 支持（保证桌面端 Ctrl+F 搜索穿透）；
   - 必须保留 `ReasoningRow` 在流式接收 token 阶段的 `contain: size layout; height: 24px;` 硬件级布局隔离，杜绝高频 token 吐出时的页面全局回流。
2. **引入视口恢复保护**：
   在 `FoldableToolGroup.tsx` 与 `ReasoningRow.tsx` 的折叠收起回调中增加 `scrollIntoView` 顶部越界保护，彻底解决长日志折叠后的迷失痛点。
3. **按钮采用同格重叠布局**：
   重构展开/折叠状态指示文案，采用 `grid-area: 1 / 1` 消除宽度跳动。
4. **长文本引入动态渐变遮罩**：
   对代码块展开、长引用折叠引入 `maskImage: linear-gradient(to bottom, #000 calc(100% - 1.6lh), ...)`，赋予 Conex 极客而柔和的视觉品质。
