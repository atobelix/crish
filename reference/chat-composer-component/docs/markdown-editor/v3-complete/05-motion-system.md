# 05 — 动效系统（Motion System）

> **分册**：v3-complete / 05  
> **读者**：UI/CSS 实现 agent、产品验收、无障碍审查  
> **依赖**：[07-visual-system.md](../07-visual-system.md)、`css/flow/motion.css`、`css/design-tokens.css`、`css/markdown-editor/*`  
> **产品约束**：U5 — 表格与全局功能从「能点」到「能用」，**动效与微交互完整**；冷静、克制、完整弧线，禁止花哨。

---

## 0. 目标与非目标

### 0.1 目标

| ID | 目标 |
|----|------|
| M-1 | 统一 **时长 + 曲线 token**，与 flow / file-preview 家族对齐 |
| M-2 | 块进入/离开、slash 面板、表格「+」、合并预览、选区工具条等 **有完整可感知反馈** |
| M-3 | 属性动画优先 **`transform` / `opacity`**；不触发 layout thrash |
| M-4 | **禁止阴影呼吸 / hover 抬升阴影**（对话流硬禁令延续） |
| M-5 | 完整尊重 `prefers-reduced-motion: reduce` |
| M-6 | CSS 与 JS **职责清晰**：CSS 管过渡与关键帧；JS 管状态类、FLIP、存在性 |

### 0.2 非目标

- 页面级视差、滚动驱动叙事动画  
- Lottie / 复杂 SVG 路径动画作为默认依赖  
- 弹簧物理引擎（仅用 cubic-bezier 近似 soft spring）  
- 为动效单独引入 GSAP 等重库  

### 0.3 设计原则（人因）

1. **短而完整**：160–280ms 主程；有头有尾，不中途截断无 settle。  
2. **略快不弹**：ease-out-expo / soft spring；**避免** overshoot 导致正文抖动。  
3. **静态阴影**：浮层可有 *static* `box-shadow`，但 **禁止** 对 shadow 做 transition/animation。  
4. **可关**：系统 reduce 时瞬时切换，无「残影」。  
5. **服务可读**：动效强化空间关系（菜单从哪来、块插到哪），不装饰噪音。

---

## 1. Token：时长与曲线

### 1.1 继承 flow tokens

编辑器 **不发明第二套时间哲学**。优先：

| Token | 默认值 | 语义 | 来源 |
|-------|--------|------|------|
| `--flow-spring` | `cubic-bezier(0.22, 1, 0.36, 1)` | 主弹性（软 settle） | `css/flow/motion.css` |
| `--flow-spring-soft` | `cubic-bezier(0.16, 1, 0.3, 1)` | 更柔（大面板） | flow |
| `--flow-entrance-ms` | `160ms` | 通用入场 | flow |
| `--flow-hover-ms` | `90ms` | hover 显隐 | flow（≈ design `--dur-fast`） |
| `--flow-accordion-ms` | `180ms` | 折叠 | flow |
| `--flow-roller-ms` / `--flow-slot-ms` | `240–260ms` | 滚轮/slot（编辑器少用） | flow |
| `--dur-fast` | `0.12s` | 设计系统快 | `design-tokens.css` |
| `--dur-normal` | `0.15s` | 常 | design |
| `--dur-smooth` | `0.35s` | 仅模态级；**编辑器慎用** | design |
| `--ease-spring` | `cubic-bezier(0.16, 1, 0.3, 1)` | 与 spring-soft 对齐 | design |
| `--ease-default` | `ease` | 非强调过渡 | design |

### 1.2 编辑器私有映射（挂在 `.mdx-root`）

```css
.mdx-root {
  /* 时长 */
  --mdx-motion-instant: 0ms;
  --mdx-motion-xs: 90ms;      /* = hover 显隐；对齐 --flow-hover-ms */
  --mdx-motion-sm: 120ms;     /* 工具条 / 落点线 / + 按钮 */
  --mdx-motion-md: 160ms;     /* 块入场 / 通用 enter */
  --mdx-motion-lg: 200ms;     /* 块离场 / 表格结构变化 */
  --mdx-motion-xl: 240ms;     /* slash / 上下文菜单入场 */
  --mdx-motion-panel: 280ms;  /* 大面板；上限，罕见 */

  /* 曲线 */
  --mdx-ease-out: var(--flow-spring, cubic-bezier(0.22, 1, 0.36, 1));
  --mdx-ease-soft: var(--flow-spring-soft, cubic-bezier(0.16, 1, 0.3, 1));
  --mdx-ease-linear: linear;  /* 仅 progress 指示，默认不用 */

  /* 位移幅度（保持「似有非有」） */
  --mdx-rise-xs: 2px;
  --mdx-rise-sm: 3px;
  --mdx-rise-md: 4px;
  --mdx-scale-press: 0.98;    /* 拖拽幽灵 */
}
```

### 1.3 与 file-preview 对齐

| 场景 | file-preview | mdx |
|------|--------------|-----|
| 淡入 | `--fp-enter-ms` + spring | `--mdx-motion-md` + `--mdx-ease-out` |
| 行交错 | 20ms delay 阶梯，max 5 行 | 多块同时插入时 **最多 stagger 5**，同 20ms |
| reduce | animation none | 同 |

实现时可在注释中写 `# align: fp-fade-in / flow-enter`，避免数值漂移。

### 1.4 禁止的 token 用法

- 用 `--dur-smooth`（350ms）做 **每块 hover**  
- 自造 `cubic-bezier(0.68, -0.55, …)` 回弹  
- 动画 `box-shadow`、`margin`、`top/left`（位置用 transform；布局位置变更用 FLIP 或即时）

---

## 2. 动效清单总表

> **属性列**：允许过渡的 CSS 属性。  
> **JS**：是否需要类切换 / rAF / 测量。  
> **Reduce**：reduce 下的行为。

| ID | 场景 | 触发 | 时长 | 曲线 | 属性 | 表现摘要 | CSS | JS | Reduce |
|----|------|------|------|------|------|----------|-----|----|--------|
| A01 | 块插入入场 | insertBlock / Enter 新块 | 160ms | ease-out | opacity, transform | 0→1 + translateY(3px)→0 | `.mdx-block--enter` | 加类，`animationend` 移除 | 无动画，直接出现 |
| A02 | 块删除离场 | Backspace 合删 / 菜单删 | 160–200ms | ease-out | opacity, transform | 1→0 + translateY(-2px) | `.mdx-block--leave` | 等 end 再卸 DOM | 立即卸 DOM |
| A03 | 块类型转换 | slash 转 heading 等 | 120ms | ease-out | opacity（轻） | 内容 cross-fade 可选 | `.mdx-block--morph` | 替换内容前闪类 | 即时替换 |
| A04 | 块拖拽幽灵 | DnD start | — | — | — | opacity 0.85 + scale 0.98 **静态** | `.mdx-drag-ghost` | 创建幽灵节点 | 无 scale，仅半透明 |
| A05 | 落点指示线 | DnD over | ≤120ms | ease | opacity | 线淡入；**无**宽度扫描光 | `.mdx-drop-indicator` | 更新 top | 直接显隐 |
| A06 | 拖源占位 | dragging | 90ms | ease | opacity | 源块 → 0.45 | `.is-dragging` | 状态类 | 即时 |
| A07 | 把手显隐 | 块 hover / focus | 90–120ms | ease | opacity | 0→0.42→0.78 | `.mdx-handle` | 无（CSS :hover） | 可保持更高静态 opacity 或即时 |
| A08 | Slash 面板开 | `/` 或 `、` | 240–280ms | spring | opacity, transform | 0→1 + Y(3px) | `.mdx-slash.is-open` | 挂载 + 定位 | 瞬开 |
| A09 | Slash 面板关 | Esc / 选中 / 失焦 | 120ms | ease | opacity, transform | 淡出略快于入 | 同上 | 可先类后卸 | 瞬关 |
| A10 | Slash 项 active | 上下键 | 90ms | ease | background-color | bg-hover；**无** shadow | `.is-active` | 索引状态 | 即时 |
| A11 | 选区工具条显 | 非空选区 | 120ms | spring | opacity, transform | 淡入 + 微升 | `.mdx-sel-bar.is-visible` | selectionchange + rAF 定位 | 瞬显，仍定位 |
| A12 | 选区工具条隐 | 折叠选区 | 90ms | ease | opacity | 快隐 | 同上 | sync | 瞬隐 |
| A13 | 工具条按钮 press | pointer | 90ms | ease | background, color | active 反馈 | `.mdx-sel-btn` | 无 | 即时 |
| A14 | 表格 + 列/行显 | wrap hover / chrome | 120ms | ease | opacity | 0→1；**禁止** shadow 呼吸 | `.mdx-table-add-*` | 可选 is-visible | 即时 |
| A15 | 表格 + 点击反馈 | click | 90ms | ease | background, border-color | 轻按压色 | :active | 插入行列 | 即时 |
| A16 | 表格新行/列入场 | add row/col | 160ms | spring | opacity, transform | 行：Y(2px)；列：X(2px) | `.mdx-tr--enter` / `td--enter` | 类 + 清 | 即时 |
| A17 | 表格删行/列离场 | delete | 140ms | ease | opacity | 淡出后卸 | `--leave` | 等 end | 即时卸 |
| A18 | 单元格选中 | 点击/框选 | 90ms | ease | background-color | selection-bg | `.is-selected` | 选区模型 | 即时 |
| A19 | 合并预览轮廓 | 合并模式拖选 | 120ms | ease | opacity, border-color | 虚线/描边预览框 **静态 shadow 无** | `.mdx-merge-preview` | 更新矩形 | 瞬显 |
| A20 | 合并确认闪白 | 执行 merge | 160ms | ease-out | opacity | 预览框收束淡出 | keyframes 一次 | 触发类 | 跳过 |
| A21 | 上下文菜单 | 右键表/块 | 100–200ms | spring | opacity, transform | 与现 table.css 100ms 对齐升到 160–200 | `.mdx-ctx-menu` | portal 定位 | 瞬开 |
| A22 | Callout 折叠 | 若启用 accordion | 180ms | spring | grid-template-rows, opacity | 复用 flow-acc 模式 | `.flow-acc` 或 mdx 包装 | data-open | 即时高度 |
| A23 | 代码块模式切换 | read→edit | 120ms | ease | opacity | 轻 cross-fade；**禁止**双壳滑动假预览 | `.mdx-code.is-editing` | 模式状态 | 即时 |
| A24 | 焦点环 | focus-visible | 90ms | ease | box-shadow（**环**非 elevation） | 仅控件；块行禁止大环动画 | focus-visible | 无 | 可保留静态环 |
| A25 | 多块插入 stagger | 粘贴多块 | 160ms + delay | spring | 同 A01 | delay i*20ms，i≤5 | nth 或 style | 批 insert | 无 stagger |
| A26 | 菜单项 hover | pointer | 90ms | ease | background | bg-hover only | CSS | 无 | 即时 |
| A27 | 滚动锚定 | 插入块出视口 | — | — | — | `scrollIntoView({block:'nearest'})` **无** smooth 强制 | — | 调用；reduce 时 auto | behavior auto |

---

## 3. 场景详述

### 3.1 块进入 / 离开

#### 进入（A01）

```css
@keyframes mdx-block-enter {
  from {
    opacity: 0;
    transform: translateY(var(--mdx-rise-sm, 3px));
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.mdx-block.mdx-block--enter {
  animation: mdx-block-enter var(--mdx-motion-md) var(--mdx-ease-out) both;
}
```

**JS 职责：**

1. DOM 插入后加 `mdx-block--enter`。  
2. `animationend`（或 timeout fallback = 时长 + 50ms）移除类。  
3. **初次 fullRender 整篇** 不打入场（避免打开文档「雨落」）；仅用户操作导致的 insert。  
4. 标志：`opts.animate === false`（setMarkdown/setDoc）跳过。

#### 离开（A02）

```css
@keyframes mdx-block-leave {
  from { opacity: 1; transform: none; }
  to {
    opacity: 0;
    transform: translateY(calc(var(--mdx-rise-xs, 2px) * -1));
  }
}
.mdx-block.mdx-block--leave {
  animation: mdx-block-leave var(--mdx-motion-lg) var(--mdx-ease-out) both;
  pointer-events: none;
}
```

**JS：** 先加 leave → 等 end → `removeChild` + model 已提交。若用户快速连续删，取消排队用 generation 计数。

### 3.2 Slash 面板（A08–A10）

对齐 visual-system §8.2：

| 项 | 值 |
|----|-----|
| 入场 | opacity 0→1 + translateY(3px)，**240–280ms** spring |
| 出场 | **120ms** 仅 opacity（或反向 2px） |
| 阴影 | `--shadow-popover` **static**；`:hover` 项 **不**改 shadow |
| 定位 | caret 下 4px；撞边 flip；z-index ≥ 90 |

```css
.mdx-slash {
  opacity: 0;
  transform: translateY(var(--mdx-rise-sm));
  visibility: hidden;
  transition:
    opacity var(--mdx-motion-xl) var(--mdx-ease-out),
    transform var(--mdx-motion-xl) var(--mdx-ease-out),
    visibility 0s linear var(--mdx-motion-xl);
  box-shadow: var(--shadow-popover); /* 无 transition */
}

.mdx-slash.is-open {
  opacity: 1;
  transform: none;
  visibility: visible;
  transition:
    opacity var(--mdx-motion-xl) var(--mdx-ease-out),
    transform var(--mdx-motion-xl) var(--mdx-ease-out),
    visibility 0s;
}
```

**JS：** 过滤列表变化 **不**重播入场动画（只更新列表 DOM）；仅 open 边沿播一次。

### 3.3 表格「+」与行列出现（A14–A17）

现状 `table.css`：add 按钮 `transition: opacity 120ms ease, background…`；hover 显隐。

v3 补强：

1. **+ 按钮**：保持 120ms opacity；hover 背景色变，**永不** `box-shadow` 动画。  
2. **新行**：`tr` 加 `--enter`，translateY(2px)+fade。  
3. **新列**：每个新 `td` 可用 translateX(2px)+fade；列多时 **只动画表头 + 首行** 或整体 wrap 不 per-cell（性能）。  
4. **决策**：列数 ≤ 8 时 per-cell stagger 最多 4；否则仅 opacity 整表 chrome 反馈。

### 3.4 合并预览（A19–A20）

依赖表格合并能力（03-table-advanced）：

| 阶段 | 视觉 |
|------|------|
| 选多格 | 选区 bg `--mdx-selection-bg`（A18） |
| 进入合并模式 | 出现 `.mdx-merge-preview` 覆盖 bounding box：2px dashed `doc-ink` 40%，背景 4% 填，**radius 2** |
| 非法合并 | 预览框改 error 描边（`--accent-red` 55%），**不抖动**（禁止 shake 动画） |
| 确认 | 预览 160ms 淡出；单元格 DOM 结构更新可无动画或轻 fade |

**禁止**：合并时整表 flash、脉冲阴影、成功 confetti。

### 3.5 选区工具条（A11–A13）

现状：`.mdx-sel-bar` 绝对定位；`is-visible` / `hidden`。

```css
.mdx-sel-bar {
  /* 定位由 JS left/top；动画只用 opacity/transform */
  opacity: 0;
  transform: translateY(var(--mdx-rise-xs)) scale(0.98);
  transition:
    opacity var(--mdx-motion-sm) var(--mdx-ease-out),
    transform var(--mdx-motion-sm) var(--mdx-ease-out);
  box-shadow: var(--shadow-popover); /* static */
  pointer-events: none;
}

.mdx-sel-bar.is-visible {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
```

**JS 注意：**

- 选区移动时 **更新 left/top 不插值**（避免工具条拖尾眩晕）；仅显隐 opacity。  
- `selectionchange` → rAF 合并。  
- composing 时强制隐。

### 3.6 DnD 落点与幽灵（A04–A06）

- 落点线：2px 高，opacity 过渡 ≤120ms；左右与 content 齐。  
- 幽灵：创建时即可最终视觉，**不必** scale 动画；拖动跟指针无 spring 延迟。  
- **禁止** 拖拽过程每帧改 box-shadow。

---

## 4. 禁止清单（硬）

| 禁止项 | 原因 |
|--------|------|
| `transition: box-shadow …` / `@keyframes` 改 shadow | 「阴影呼吸」「抬升卡片」违设计禁令 |
| 块行 hover 大面积阴影 / 背景脉冲 | 阅读态瓷砖墙 |
| 弹性 overshoot 导致文字晃 | 阅读疲劳 |
| 输入时全页 fade re-render | 性能 + 眩晕 |
| 无限 loop 装饰动画（除极弱 running 点且不在编辑正文） | 分心 |
| `scroll-behavior: smooth` 强制全局 | 与键盘导航抢控；reduce 难 |
| 非法操作 shake 整表 | 粗暴；改描边色足够 |
| 阴影 + 位移同时强调浮起 | 像 Material 误用 elevation |

焦点环（`--mdx-focus-ring`）是 **1.5–2px 描边式 shadow**，允许作为静态样式；**不要** animate 其扩散。

---

## 5. `prefers-reduced-motion`

### 5.1 全局开关

```css
@media (prefers-reduced-motion: reduce) {
  .mdx-root *,
  .mdx-root *::before,
  .mdx-root *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

更细粒度（推荐，避免误伤 SVG 等）：

```css
@media (prefers-reduced-motion: reduce) {
  .mdx-block--enter,
  .mdx-block--leave,
  .mdx-slash,
  .mdx-sel-bar,
  .mdx-drop-indicator,
  .mdx-table-add-col,
  .mdx-table-add-row,
  .mdx-ctx-menu,
  .mdx-merge-preview,
  .mdx-handle,
  .mdx-drag-ghost {
    transition: none !important;
    animation: none !important;
  }
}
```

### 5.2 JS 侧

```ts
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 插入块
if (!prefersReducedMotion() && opts.animate !== false) {
  el.classList.add('mdx-block--enter');
}
```

- leave 动画：reduce 时 **同步** remove。  
- 订阅 `change` 事件可选（运行时切换系统设置）。

### 5.3 无障碍补充

- 动效不是唯一状态通道：选中、错误、合并非法须有 **颜色 + 文本/ARIA**。  
- `aria-live` 区域不因动画延迟播报；先更新语义再播动画。

---

## 6. CSS / JS 职责划分

| 职责 | CSS | JS |
|------|-----|-----|
| 时长曲线 token | ✅ 定义 | 读取 computed 仅当测量需要 |
| hover/focus 微反馈 | ✅ | ❌ |
| enter/leave keyframes | ✅ | 状态类增删、监听 end |
| 浮层坐标 | ❌（left/top 可设但无 transition） | ✅ getBoundingClientRect + 夹紧 |
| 是否播放 | 提供类 | ✅ 业务：首次渲染、setDoc、reduce |
| FLIP 列表重排（可选 P1） | transform 终点 | ✅ 读 first/last、invert、play |
| 存在性（挂载卸载） | — | ✅ |
| 取消进行中动画 | animation: none 类 | ✅ generation / Abort |
| DnD 指针跟踪 | — | ✅ |
| 阴影样式 | ✅ static only | ❌ 不 animate |

### 6.1 推荐文件拆分

```
css/markdown-editor/
  motion.css          # 本册 token 映射 + keyframes + reduce
  index.css           # @import motion.css
  # slash / table / sel-bar 的 transition 可留在组件文件，但数值引用 var(--mdx-motion-*)
```

### 6.2 JS 工具模块

```
src/motion/
  prefers-reduced-motion.ts
  run-enter.ts          # add class + cleanup
  run-leave.ts          # Promise 化离场
  stagger.ts            # 限制 max 5
```

---

## 7. 与 flow tokens 对齐检查表

| Flow 用途 | MDX 对应 | 数值一致？ |
|-----------|----------|------------|
| `--flow-entrance-ms` 160 | `--mdx-motion-md` | ✅ 应对齐 |
| `--flow-hover-ms` 90 | `--mdx-motion-xs` | ✅ |
| `--flow-accordion-ms` 180 | Callout 折叠 | ✅ 复用 |
| `--flow-spring` | `--mdx-ease-out` | ✅ |
| `--flow-spring-soft` | 大面板 / slash | ✅ soft 或 out |
| `flow-enter` keyframes Y(3px) | 块/菜单入场 | ✅ 同幅度 |
| 无 shadow anim（flow 注释） | 全 mdx 浮层 | ✅ |

回归时打开对话流 + 编辑器同页：菜单入场「一家亲」，不出现一套 120ms linear、另一套 400ms bounce。

---

## 8. 实现优先级

| 优先级 | 项 | 说明 |
|--------|----|------|
| P0 | Token + reduce 全局 | 基础 |
| P0 | Slash 开闭、工具条显隐、把手、+ 按钮 | 高频 |
| P0 | 禁 shadow 动画审计 | grep `transition:.*shadow` |
| P1 | 块 enter/leave | 体验完整 |
| P1 | 表格行列 enter、合并预览 | U4/U5 |
| P2 | 多块 stagger、FLIP 重排 | 锦上添花 |
| P2 | 代码块模式 cross-fade | 注意 U2 单壳 |

---

## 9. 测试与验收

### 9.1 自动化

| 测试 | 方法 |
|------|------|
| reduce 媒体查询 | 组件测：mock matchMedia → 无 enter 类或 duration 0 |
| 无 shadow transition | 风格 lint / grep CI |
| leave Promise | 单元：假 animationend |

### 9.2 手工

- [ ] 系统「减少动态效果」开：所有面板瞬开关，功能全在  
- [ ] Slash 打开：轻上移淡入，无弹跳  
- [ ] 拖块：落点线淡入，无蓝罩  
- [ ] 表 hover：+ 显；点 + 行出现有微入场  
- [ ] 合并预览：框清晰；非法变红不抖  
- [ ] 选区工具条：显隐顺滑；移动选区时条 **跟随无拖尾插值**  
- [ ] 连续输入：无块级闪烁动画  
- [ ] 与 Flow 消息入场并排观感一致  

### 9.3 性能

- 动画元素避免 `filter`/`blur`  
- `will-change` 仅在进行中短暂加，end 移除  
- 60Hz 下入场不掉帧（中档机 Notebook 内）

---

## 10. 参考锚点

| 路径 | 内容 |
|------|------|
| `css/flow/motion.css` | spring、entrance、accordion、reduce 范例 |
| `css/file-preview/motion.css` | fade-in、row-stagger |
| `css/design-tokens.css` | `--dur-*` / `--ease-*` |
| `css/markdown-editor/table.css` | + 按钮、ctx-menu transition |
| `css/markdown-editor/index.css` | sel-bar、块壳（块禁止 box-shadow） |
| `docs/markdown-editor/07-visual-system.md` §9 | 旧动效规则摘要 |

---

## 11. 摘要决策冻结

1. **时长阶梯**：90 / 120 / 160 / 200 / 240–280ms。  
2. **曲线**：flow-spring 系；无硬 bounce。  
3. **属性**：opacity + transform 为主；bg-color 可。  
4. **阴影**：可有 static；**不可**动画。  
5. **reduce**：功能完整、动画无。  
6. **JS**：状态与定位；**CSS**：观感与曲线。  
7. **打开文档 fullRender**：不动效；用户手势才动效。

---

**文档结束（05）** · 与 [04-inline-marks-live.md](./04-inline-marks-live.md) 无直接耦合；工具条动效服从本册，marks 逻辑服从 04。
