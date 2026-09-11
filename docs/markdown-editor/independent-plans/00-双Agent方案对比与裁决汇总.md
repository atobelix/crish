# 双 Agent 独立方案对比与最终架构裁决汇总

**文档代号**：`ARCH-SYNTHESIS-20260905`
**归属目录**：`docs/markdown-editor/independent-plans/`
**对比对象**：
1. [01-架构师A-排版渲染与代码缩进独立方案.md](./01-架构师A-排版渲染与代码缩进独立方案.md)（侧重底层渲染几何、CSS包含块与 CommonMark 规范）
2. [02-架构师B-交互体系与色彩层级独立方案.md](./02-架构师B-交互体系与色彩层级独立方案.md)（侧重状态机、交互模型、3% 灰度设计系统与组件工程化）

---

## 一、方案对比与共识分析矩阵

针对用户提出的 7 大核心痛点，两位独立架构师在未阅读历史计划文档的情况下，直接从源码展开审查，其分析结论与技术路线高度契合，形成了强有力的架构共识。

| 问题序号 | 核心问题 | 架构师 A 方案重点 | 架构师 B 方案重点 | 统一架构裁决（选优与综合） |
| :--- | :--- | :--- | :--- | :--- |
| **问题 1** | **对号左边缘裁切（“]”形）与移除边缘判定** | 剖析 `1ch` (8.4px) 居中 14px SVG 产生 $-2.8\text{px}$ 负溢出，触碰 `.virtual-row-gpu contain: paint` 裁剪线。建议重构为 16px 盒并加 `margin-left: 3px`。彻底删除 `isEdgeClick`。 | 同样精确定位负坐标溢出与 GPU 裁切冲突；建议 14px 固定盒加 `margin-left: 2px; margin-right: 6px;`。彻底删除 `isEdgeClick`，100% 区域点击翻转。 | **采纳综合方案**：`.task-checkbox-wrapper` 设为 `16px × 16px`（内含 14px SVG），并配置 `margin-left: 2px; margin-right: 6px;`，左边缘永远处于 $X \ge 2\text{px} > 0$，彻底根除硬件裁切；`InlineRenderer.tsx` 彻底移除 `isEdgeClick`，点击 100% 切换状态。 |
| **问题 2** | **3% 灰度交互与 0.4%M 0.8%Y 纸张基底色** | 数学推导 CMYK (0, 0.4%, 0.8%, 0) 为 `hsl(30 2.5% 95.5%)`；定义按钮 hover 为 `color-mix(in srgb, hsl(0 0% 0%) 3%, var(--white))`，按压态 6%；清退 raw hex。 | 同样推导 $H=30^\circ$ 暖米橙基底；规范 `--interactive-hover` 纯灰 3% 阶梯，清理所有按钮的旧式 `--warm-sand` 浑浊底色。 | **完全采纳共识**：统一 `--parchment: hsl(30 2.5% 95.5%)`，统一 `--interactive-hover: color-mix(in srgb, hsl(0 0% 0%) 3%, var(--white))`，只使用 HSL 与 OKLCH 现代语法。 |
| **问题 3** | **纵向导线极细化与跨行 0 缝隙垂直连贯** | 发现 `syntax-indent` 仅 18px 字形高，相对 28px 行高产生 10px 垂直断裂；引用线 2.5px 且带圆角断茬。建议导线 0.5px，容器 `height: 100%; top: 0; bottom: 0;`。 | 同样揭示 18px vs 28px 盒模型断层；导线精度设为 0.5px 发丝线，`display: inline-flex; height: 100%;`，消除引用线与列表线粗细不一。 | **完全采纳共识**：全部导线统一为 `0.5px`（`--list-guide-line: hsl(30 2.5% 80%)`），容器全高 `height: 100%; top: 0; bottom: 0;`，上下圆角抹平为 0，跨行像素级垂直贯通无缝。 |
| **问题 4** | **文字选区品牌微绿微光** | 设为 `oklch(0.6959 0.149 162.48 / 0.12)`，结合 `mixBlendMode: 'multiply'`，柔和通透不遮挡字形。 | 设为 `oklch(0.6959 0.149 162.48 / 0.10)`，兼顾边界可见性与文字极高可读性。 | **采纳 0.10 ~ 0.12 浓度微光**：`--selection-bg` 与 `--blue-selection` 升级为 `oklch(0.6959 0.149 162.48 / 0.10)`，温润通透，绝不遮挡文字与黄色高亮。 |
| **问题 5** | **顶栏统一 28px 网格与交互功能补齐** | 顶栏按钮高度统一 28px，统一 3% hover；优化状态显示为现代胶囊，补齐 TPS 模拟输出控制与字符统计切换。 | 顶栏对齐 28px 基线网格，揭示 TPS 闭包捕获导致流式运行时调速失效的缺陷，重构为 Ref 响应机制。 | **采纳 B 的 Ref 调速状态机 + A 的 28px 视觉对齐**：顶栏按钮严格 28px 高度网格，统一 3% 灰度悬停，修复 TPS 实时调速响应与字符统计切换。 |
| **问题 6** | **高亮语法（`==高亮==`）视觉复兴** | 发现 `--yellow-tint-2` 仅 0.08 透明度在米纸上低于人眼阈值；改造为 `hsl(45 96% 54% / 0.30)` 琥珀微光与深色文字。 | 同样指出 0.08 透明度缺陷，建议提升至 0.28-0.30 浓度并补充 `padding: 1px 4px; border-radius: 3px;`。 | **完全采纳共识**：`--yellow-tint-2` 设为 `hsl(45 100% 50% / 0.28)`，文字为深褐色 `hsl(38 75% 22%)`，配合圆角内边距，呈现经典荧光笔琥珀温润感。 |
| **问题 7** | **列表内嵌套代码块 CommonMark §4.5 缩进剥除** | 发现 `useFenceContext` 缓存键缺少 `indent` 订阅维度；`stripCodeFenceIndent` 忽略引用前缀且纯空格时 `indexOf` 产生倒错。 | 剖析单趟状态机与 `getFenceBlockLines` 复制链路，要求渲染层、复制层与专用语言渲染器同步剥除开围栏缩进。 | **全链路采纳**：在 `useFenceContext` 缓存键中补全 `ctx.indent`；重构 `stripCodeFenceIndent` 确保精准剔除开围栏前导空格；同步剥除代码复制文本与专用语言渲染器前缀。 |

---

## 二、最终落地执行规范

### 1. 样式系统改动 (`src/index.css`)
- **色彩 Token 升级**：
  ```css
  --parchment: hsl(30 2.5% 95.5%);
  --selection-bg: oklch(0.6959 0.149 162.48 / 0.10);
  --blue-selection: oklch(0.6959 0.149 162.48 / 0.10);
  --yellow-tint-2: hsl(45 100% 50% / 0.28);
  --yellow-text: hsl(38 75% 22%);
  --interactive-hover: color-mix(in srgb, hsl(0 0% 0%) 3%, var(--white));
  --interactive-active: color-mix(in srgb, hsl(0 0% 0%) 6%, var(--white));
  --list-guide-line: hsl(30 2.5% 80%);
  ```
- **复选框防裁剪与布局**：
  ```css
  .task-checkbox-wrapper {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-left: 2px;
    margin-right: 6px;
    cursor: pointer;
    user-select: none;
    vertical-align: middle;
    transform: translateY(-1px);
  }
  ```
- **导线垂直贯通无缝（0px 缝隙）**：
  ```css
  .token-blockquote-prefix {
    display: inline-flex;
    position: relative;
    white-space: pre;
    height: 100%;
    align-items: stretch;
  }
  .token-blockquote-prefix .blockquote-bar {
    position: absolute;
    left: calc(0.5ch - 0.25px);
    top: 0;
    bottom: 0;
    width: 0.5px;
    background-color: var(--list-guide-line);
    border-radius: 0;
    pointer-events: none;
  }
  .syntax-indent {
    white-space: pre;
    position: relative;
    display: inline-flex;
    height: 100%;
    align-items: stretch;
  }
  .syntax-indent-guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0.5px;
    background-color: var(--list-guide-line);
    pointer-events: none;
    user-select: none;
  }
  ```
- **高亮语法样式**：
  ```css
  .style-mark {
    font-weight: 500;
    color: var(--yellow-text);
    background-color: var(--yellow-tint-2);
    padding: 1px 4px;
    border-radius: 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }
  ```

### 2. 行内渲染器优化 (`src/components/InlineRenderer.tsx`)
- 彻底移除 `isEdgeClick` 边缘检测，点击 `task-checkbox-wrapper` 100% 触发状态翻转：
  ```tsx
  const handleTaskClick = (e: React.MouseEvent) => {
    if (start !== undefined) {
      e.stopPropagation();
      e.preventDefault();
      const state = useEditorStore.getState();
      const markerOffset = token.raw.indexOf(token.isChecked ? '[x]' : '[ ]');
      const newMarker = token.isChecked ? '[ ]' : '[x]';
      if (markerOffset >= 0) {
        const from = start + markerOffset;
        const to = from + 3;
        const cur = state.cursorPos;
        state.applyChange(from, to, newMarker, { cursorAfter: cur });
      }
    }
  };
  ```

### 3. 代码块围栏缩进剥除 (`src/components/BlockRenderer.tsx`)
- 完善 `useFenceContext` 订阅键包含 `ctx.indent`：
  ```tsx
  const key = editorStore((state) => {
    const ctx = computeFenceContext(state, index);
    return ctx === null
      ? ''
      : `${ctx.lang}|${ctx.contentStart}|${ctx.contentEnd}|${ctx.indent || 0}|${ctx.isFirstContentLine ? 1 : 0}`;
  });
  ```
- 优化 `stripCodeFenceIndent`，确保首个文本 Token 正确剔除前导缩进空格，并在代码复制与通用渲染器中保持一致。

### 4. 顶部栏交互与基线网格对齐 (`src/App.tsx`)
- 所有控制按钮统一为 28px 高度，统一 3% 纯灰 hover。
- TPS 下拉选框与字符统计卡片具备完整的动态交互能力。

---

## 三、下一步操作建议

方案已由两名独立架构师完成深入分析并达成完全共识。请用户审阅汇总方案，待批准后即行落地实施与自动化门禁验证。
