# 战役总方案：主界面流式渲染 Design Tokens 体系系统化重构

> **战役定位**：全面根治主界面流式 Markdown 排版扁平化、表格与代码块 Token 真空、自定义富交互组件（`<widget-diff>`, `<file-tree>`, `<ai-card>`）46 处裸写 HSL/Hex、浅色模式 1.34:1 对比度击穿、12 个幽灵变量及 `ChatMessageRow.module.css` 1086 行超标巨石样式表问题，构建一套 100% 达标 WCAG AA、遵循 AGENTS.md §13/§14 与 Zero-Blue 铁律的现代化 Design Tokens 体系。
> **调度标准**：严格遵循 [`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md)。
> **核心原则**：先删后改，一个领域概念唯一主路径；禁止新增波次命名文件；严格负产出验收（净清除 88 处硬编码、12 个幽灵变量，样式表巨石瘦身 45%）。

---

## 一、五大核心 Token 领域概念收敛矩阵

经过 6 份独立方案与 3 轮严苛交叉评审，正式确立 Conex 主界面流式渲染 Design Tokens 的 5 大领域概念与唯一 SSOT 主路径：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   Conex 主界面流式渲染 Design Tokens 体系收敛全景                      │
├─────────────────┬───────────────────────────────┬──────────────────────────────────────┤
│ 领域概念 (Domain)│ 历史旧有缺陷与硬编码 (Before) │ 收敛后的唯一主路径 (After)           │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 1. Markdown 排版│ • H1~H6 14px 正文字号扁平化   │ • Typography Scale 阶梯字号 (1.5~0.9)│
│    与语法高亮   │ • .md-path-link 原生灰按钮裸奔│ • .md-inline-code / .md-path-link 胶囊│
│                 │ • 20 组 --syntax-* Token 荒废 │ • 20 组语法高亮 Token 双引擎 100% 接线│
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 2. 流式表格与   │ • hsl(215 90% 52%) 电光蓝污染 │ • --md-table-* (Sticky毛玻璃/斑马纹) │
│    视口动效     │ • td[data-streaming] 死选择器 │ • --stream-table-active-* (翡翠绿外框)│
│                 │ • 表格样式双源漂移            │ • 统一委托 StreamingTableContainer   │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 3. 自定义 HTML  │ • 46 处裸写 HSL/Hex 与暗色偏置│ • --artifact-* / --diff-* / --filetree│
│    组件与沙箱   │ • Light 模式对比度仅 1.34:1   │ • WCAG AA 达标对比度 (≥5.24:1~7.01:1)│
│                 │ • 非法属性 divide-x / 悬浮超标│ • 标准分栏 / 边框混入 ≤8% (符合 §13) │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 4. 思考链折叠与 │ • 8 处内联 style 魔法数字     │ • 拆分独立 TimelineThoughtSection.css│
│    状态横幅     │ • --bg-error-subtle 等幽灵变量│ • --thought-* / --banner-error-* 矩阵 │
│                 │ • 暗色下对比度 1.76:1 / 白雾遮罩│ • tabular-nums 防抖 / 动态无脏灰遮罩 │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 5. 流式动效与   │ • 双轨光标实现与频率冲突      │ • .conex-streaming-caret (翡翠绿SSOT)│
│    性能分档     │ • #94a3b8 蓝灰裸色光标        │ • GPU Compositor 硬件加速淡入        │
│                 │ • 节能模式依然耗电            │ • data-perf-tier="eco" 0ms 纯折叠    │
└─────────────────┴───────────────────────────────┴──────────────────────────────────────┘
```

---

## 二、【强制专节】全战役死层、硬编码与幽灵变量清剿清单

本战役在进入实质业务组件样式改造前，必须由阶段 0 严格执行“物理清算”，彻底清剿以下死层与反模式：

### 1. 物理清剿 88 处硬编码色值与暗黑偏置 Fallback
- `custom-tags.module.css` 中的 41 处裸写 HSL/Hex（`hsl(220 18% 13%)`、`hsl(215 14% 34%)`、`hsl(158 75% 70%)`、`hsl(354 70% 40%)` 等）；
- `ChatMessageRow.module.css` 中的 24 处硬编码色值（暗黑下对比度仅 1.09:1 的黑字回退 `#1c1b18`、暗色白雾 `#ffffff` 遮罩、散落 Hex）；
- `streaming-animation.css` 中的 4 处裸色（蓝灰 `#94a3b8` 等）；
- `MessageContent.tsx` 中的 8 处内联 `style={{...}}` 魔法数字（`padding: '10px 14px'`、`background: '...'` 等）。

### 2. 物理拔除 12 个未声明幽灵变量
1. `--bg-error-subtle` $\to$ 转正为 `--banner-error-bg` / `--banner-error-border`
2. `--status-success` $\to$ 转正为 `var(--color-success, var(--brand))`
3. `--flow-summary-indent` $\to$ 废除负偏置，改用左侧 2px Rail 对齐
4. `--flow-font-meta` $\to$ 转正为 `--thought-header-font-size`
5. `--flow-meta` $\to$ 转正为 `--thought-header-fg`
6. `--flow-meta-hover` $\to$ 转正为 `--thought-header-hover-fg`
7. `--flow-meta-soft` $\to$ 转正为 `--thought-body-fg`
8. `--flow-chevron-color` $\to$ 转正为 `--thought-chevron-fg`
9. `--flow-chevron-hover` $\to$ 转正为 `--thought-chevron-hover-fg`
10. `--flow-thinking-max-h` $\to$ 转正为 `--thought-scroll-max-h`
11. `--flow-font-plan-title` $\to$ 转正为 `--thought-plan-title-font`
12. `--conex-duration` $\to$ 统一为 `--duration-normal`

### 3. 语法错误、死代码与双源漂移清剿
- 物理删除 `custom-tags.module.css` 中的非法 CSS 属性 `divide-x: 1px solid ...`；
- 修复 `FileTree.tsx` 中引用的未定义类名 `styles.fileTreeItem` 与 `styles.fileTreeChildren`（运行时为 `undefined`）；
- 物理删除 `custom-tags.module.css` 中从未消费的孤立类 `.portalOverlay`、`.portalContent` 与 `.statusPulse`；
- 物理删除 `ChatMessageRow.module.css` 中的双源表格定义，统一收敛至 `StreamingTableContainer.module.css`；
- 物理删除 `ChatMessageRow.module.css` 中的旧版伪元素打字光标（`.assistantText.isStreaming::after`）及 `@keyframes caret`。

---

## 三、先删后改实施阶段顺序（DAG 实施图）

```
【阶段 0：死层、硬编码与幽灵变量物理清剿】(强串行门禁)
  ├── 1. 物理删除 custom-tags.module.css 46 处裸色、非法 divide-x 与 undefined 类
  ├── 2. 拔除 12 个幽灵变量，根除 MessageContent.tsx 8 处内联样式
  ├── 3. 剥离创建独立 TimelineThoughtSection.module.css，ChatMessageRow 瘦身 230+ 行
  └── 4. 消除表格与光标双源定义漂移，修复死选择器
        │
        ▼ (阶段 0 门禁全绿：npm run typecheck + check:line-counts 通过)
【阶段 1：全局 Design Tokens 体系注入 (tokens.css)】(单源基座)
  ├── 1. 注入 --md-* (正文/H1~H6阶梯/行内代码/路径链接)
  ├── 2. 注入 --syntax-* (20 组双主题语法高亮调色盘)
  ├── 3. 注入 --md-table-* & --stream-table-* (表格排版与翡翠绿脉冲)
  ├── 4. 注入 --artifact-*, --diff-*, --filetree-*, --aicard-* (WCAG AA 达标对比度)
  └── 5. 注入 --thought-*, --banner-*, --stream-caret-*, data-perf-tier 性能分档
        │
        ▼
【阶段 2：组件与渲染层全量 Token 接线】(四模块解耦接线)
  ├── 1. custom-tags.module.css & 组件全量接入 Token (WCAG 对比度 ≥5.24:1)
  ├── 2. StreamingTableContainer.module.css 接入翡翠绿脉冲与吸顶表头
  ├── 3. ChatMessageRow.module.css 接入 Typography Scale 与 20 组语法高亮
  └── 4. streaming-animation.css 接入 GPU 硬件加速与 Eco 档 0ms 折叠
        │
        ▼
【阶段 3：全链路门禁、视觉核验与 WCAG 对比度验收】(交付总验收)
  ├── 1. npm run typecheck (0 错误) + npm run check:line-counts (1052 文件 0 违规)
  ├── 2. npx vitest run (全量样式与组件单测 100% PASS)
  └── 3. WCAG 2.1 AA 对比度自动化断言通过 (Light 模式 Diff 与 Badge ≥4.85:1)
```

---

## 四、核心架构契约与设计决策记录（ADRs）

- **ADR-006：全局 Design Tokens 唯一真相源（SSOT）**
  所有流式 Markdown、表格、富交互组件、思考链与动效样式必须 100% 引用 `tokens.css` 中声明的 CSS 变量，严禁在业务 CSS Module 中裸写 HSL/Hex 或私设暗黑偏置 Fallback。
- **ADR-007：Light Theme WCAG 2.1 AA 刚性对比度红线**
  浅色模式下的 Diff 新增行文字（`--diff-add-fg: hsl(142 65% 25%)` 对比度 6.75:1）、删除行文字（`--diff-del-fg: hsl(0 68% 38%)` 对比度 7.01:1）、修改徽标（`--filetree-badge-mod-fg: hsl(32 95% 30%)` 对比度 5.38:1）必须 100% 达标 $\ge 4.85:1$。
- **ADR-008：AGENTS.md §13 克制边框与焦点态铁律**
  所有卡片、按钮在 hover / active 态下的边框加深混入比例严格约束在 $5\% \sim 8\% \le 10\%$，彻底杜绝浅色模式下的生硬深黑粗环与 50% 重阴影。
- **ADR-009：Zero-Blue 铁律穿透与翡翠绿品牌签名**
  彻底拔除所有 `hsl(215 90% 52%)` 与 `#94a3b8` 蓝灰裸色，将品牌翡翠绿（`hsl(160 84% 39%)` / Light `--brand-deep` `hsl(160 84% 31%)`）独占于打字呼吸光标与流式活态光晕。
- **ADR-010：动效性能三档分级（`data-perf-tier`）**
  在 `eco` 节能档与 `prefers-reduced-motion` 下，所有动画时长自动折叠为 `0ms`（纯静态），消除额外的 GPU 与 Compositor 算力损耗。
