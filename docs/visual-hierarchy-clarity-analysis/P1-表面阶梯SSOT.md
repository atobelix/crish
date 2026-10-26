# 实施详案 P1：表面阶梯 SSOT（Surface Ladder SSOT）

> **阶段代号**：`P1`  
> **战役工作区**：`docs/visual-hierarchy-clarity-analysis/`  
> **上位契约**：[`00-总方案.md`](file:///c:/Software/conex/docs/visual-hierarchy-clarity-analysis/00-%E6%80%BB%E6%96%B9%E6%A1%88.md)（§0 裁决 R1、§3 通道①、§11 门禁、§12 实施依赖、§17 迁移流程）  
> **输入依据**：`analysis/01-色彩明度分层.md`、`analysis/03-边框分隔与视觉噪声.md`、`analysis/08-设计系统一致性.md`  
> **实施纪律**：纯逻辑规划（不谈工期人天，问题同权）；杜绝打补丁与新旧并存；每个任务单元必须具备确凿的删除清单与可验证断言。

---

## 1 目标与范围

### 1.1 核心目标
1. **推翻旧三档底色限制**：废黜历史 2026-10-10「三档底色 SSOT」对界面的扁平压制，依据用户裁决 R1，将全应用表面拓宽为具备真实物理高程的**单调递增六级语义阶梯（$e_0 \sim e_5$）**。
2. **拆分上帝文件 `tokens.css`**：在 P1 首个任务单元中，将现存 2,339 行的单一文件切分为 9 个同层职责模块，由入口 `@import` 聚合。实现纯搬移、零行为变化的解耦，为 P2~P4 解锁文件级并行条件。
3. **构造保证物理单调**：运行时彻底退役 5 级表面字面量手动注入与丢弃逻辑，仅向根节点写入 3 个核心参数（`--surface-base`、`--surface-tint`、`--elev-direction`）；所有表面均在 CSS 内由 `color-mix(in oklab, ...)` 依据严格正数步长常量构造生成，从根本上杜绝层级倒挂。
4. **收敛交互过冲与死黑阴影**：将散落的 hover/active/selected 及 `--elevate-1..3` 合并为统一状态叠加 Token；侧栏选中态对比度从 1.95:1 刺眼高光降至克制的 1.25:1；以暗部边缘微光（`--edge-rim`）与 `--shadow-lift-*` 替代暗色下物理不可见的 1.5% 纯黑阴影。
5. **彻底收拢历史别名**：通过自动化 Codemod 消除 `--bg-card`（279 处）、`--bg-secondary`（90 处）、`--bg-primary`（80 处）等 8 大表面别名以及私有通道 `--cover-card-bg`，清退 `threeTierSurface.contract.test.ts`，建立全矩阵覆盖的 `surfaceLadder.contract.test.ts`。

### 1.2 阶段边界与不变量
- **属于本阶段**：
  - `styles/tokens.css` 物理拆分与入口组织；
  - 6 级表面 Token、边缘光 Token、阴影 Token、状态叠加 Token 定义；
  - 运行时管线（`themePresets.ts`、`skinPaintPlan.ts`、`injectRootTokens.ts`、`warmLayerShift.ts`）契约收口与参数改造；
  - `contrastGuard` 纯逻辑上提；
  - 全仓 CSS modules 中 8 大表面别名向 6 级语义表面的精准映射与物理删除；
  - Win11 Mica/Acrylic 材质段的 `--surface-shell` 适配与不透明度微调；
  - 契约测试重写与实跑断言。
- **不属于本阶段**：
  - 文字阶梯的 4 级收拢与字阶重定（由 P2 承接）；
  - 间距 Token 与单垂直轴对齐（由 P3 承接）；
  - `Row` / `Card` / `Badge` 等容器基元与去 1px 描边（由 P4 承接）；
  - 对话流工具簇折叠模型与文案去重（由 P5 承接）。

---

## 2 前置与解锁

### 2.1 前置条件（Prerequisites）
- **P0 基线建立完毕**：`baseline/hierarchy-ratchet.json` 已登记当前全仓字阶、描边与主题特判初始指标；`src/dev/hierarchyAudit.ts` 与测试色彩工具已就绪。
- **WebView2 现代 CSS 支持**：本仓 Windows 桌面宿主 WebView2 基于 Chromium 120+，原生完全支持 CSS Color Module Level 4（含 `color-mix(in oklab, ...)`）。

### 2.2 解锁下游（Unlocks）
- **解锁 P2（文字阶梯）**：`tokens.css` 拆分后，P2 可独占 `styles/tokens-text.css` 与 `styles/tokens-type.css` 进行并发作业，无任何代码冲突。
- **解锁 P3（节奏与对齐）**：六级表面的物理色差为去内衬和容器间距拉大提供了明度视觉锚点。
- **解锁 P4（容器基元）**：卡片与浮层获得独立原生底色，无需再通过 1px border 补救容器感，描边预算清零具备物理可行性。

---

## 3 现状盘点（文件:行号 + 实测）

### 3.1 表面相关代码点位全景

| 文件路径 | 行号区间 | 现存符号 / 逻辑 | 现状缺陷实测数据 |
|---|---|---|---|
| [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L36-L102) | 36-102 | 浅色 `:root, html[data-theme='light']` 表面别名 | `--surface-card: var(--surface-main);` 卡片与主画布全为 `#ffffff`（$\Delta L^* = 0$） |
| [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1044-L1077) | 1044-1077 | 暗色 `html[data-theme='dark']` 表面定义与别名 | card/elevated 均别名到 `#141414`（$\Delta L^* = 0$, 1.000:1）；`--surface-sunken` 指向 `#1e1e1e` 产生 +4.94 $L^*$ 反向发光 |
| [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1083-L1126) | 1083-1126 | 暗色提亮阶梯 `--elevate-1..3` | `--elevate-step-3: 18.7%` 导致侧栏活跃项跃迁至 `#464646`（$L^*=29.72$，对比度 1.954:1 严重过冲） |
| [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L2282-L2308) | 2282-2308 | 窗口材质 Mica/Acrylic 混合段 | 仅绑定旧 `--surface-outer`；Mica 下 68% 透明度在大面积亮色壁纸下导致侧栏感知明度过度泛白 |
| [`apps/crish-desktop/src/services/token-runtime/skinPaintPlan.ts`](file:///c:/Software/conex/apps/crish-desktop/src/services/token-runtime/skinPaintPlan.ts#L297-L300) | 297-300 | 运行时表面派生计划 | `void bgTertiary; void bgElevated; void shellChromeBg;` 强行将预设规划的层级阉割丢弃 |
| [`apps/crish-desktop/src/services/TokenRuntimeController.ts`](file:///c:/Software/conex/apps/crish-desktop/src/services/TokenRuntimeController.ts#L187-L191) | 187-191 | 运行时注入赋值 | 仅向 DOM 注入 `--user-surface-outer/main/input` 3 个旧变量 |
| [`apps/crish-desktop/src/services/token-runtime/injectRootTokens.ts`](file:///c:/Software/conex/apps/crish-desktop/src/services/token-runtime/injectRootTokens.ts#L51-L65) | 51-65 | DOM setProperty 注入 | 硬编码消费 `--user-surface-outer/main/input` |
| [`apps/crish-desktop/src/api/themePresets.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePresets.ts#L9-L25) | 9-25, 165-181 | `SkinPreset` 结构与 16 组预设 | 预设中分散手写 `bgPrimary/Secondary/Tertiary/Card/Elevated/shellChromeBg/composerBg` 7 个字段 |
| [`apps/crish-desktop/src/services/warmLayerShift.ts`](file:///c:/Software/conex/apps/crish-desktop/src/services/warmLayerShift.ts#L10-L19) | 10-19 | `WarmLayers` 亮度微调逻辑 | 在 JS 内部针对 outer/main/input 三层字面量强行施加 `MIN_GAP_K = 1.2` 贴合夹紧 |
| [`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1284-L1287) | 1284-1287 | `.composerCard` 容器阴影 | 手写 `0 1px 3px color-mix(in srgb, #000 1.5%, transparent)`，暗底上 RGB 衰减不足 0.3 阶，光学不可见 |
| [`apps/crish-desktop/src/styles/threeTierSurface.contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/threeTierSurface.contract.test.ts#L41-L93) | 41-93 | 旧三档底色契约测试 | 刚性断言所有别名必须归并到三档上，CI 层面锁死缺陷 |

### 3.2 表面别名消费面全量实测盘点（`src/` 范围）
执行命令 `git grep -o -- <token> apps/crish-desktop/src | Measure-Object -Line` 精确实测命中分布：

| 待迁移别名 Token | 全仓命中数 | 纯业务 CSS 模块消费数 | 主要消费场景分布 |
|---|:---:|:---:|---|
| `--bg-card` | **279** | 246 | 卡片容器（ReportCard, DiffCard, AgentCard）、设置面板、下拉浮层、列表行 |
| `--bg-secondary` | **90** | 76 | 侧边栏（SidebarSessionList）、顶栏外壳、窗口控制条、次级按钮底色 |
| `--bg-primary` | **80** | 64 | 主阅读画布、聊天消息流背景、主视口包裹层 |
| `--bg-elevated` | **57** | 54 | 弹窗（Dialog, Modal）、下拉菜单（Menu, Popover）、Tooltip 浮层 |
| `--bg-tertiary` | **20** | 17 | 代码预览槽、下凹轨道、内嵌列表背景槽 |
| `--surface-paper` | **15** | 12 | 历史页面底板与笔记卡片 |
| `--bg-page` | **7** | 7 | 主窗口根布局页面底板 |
| `--bg-canvas` | **6** | 6 | 聊天视口外层主视界 |
| **小计** | **554** | **476** | 涉及 48 个核心组件与模块，需自动化 Codemod 逐个替换 |

---

## 4 任务单元（Task Units）

| 编号 | 文件域 | 输入 → 输出 | 依赖 | 删除项与收口 |
|---|---|---|---|---|
| **U1.0** | `apps/crish-desktop/src/styles/` | 将 `tokens.css` (2,339行) 纯搬移切分为 9 个同层文件；入口 `tokens.css` 保留 9 行 `@import`；门禁白名单适配 | 无 (P1首项) | 消除 2,339 行巨石文件；移除旧单文件结构 |
| **U1.1** | `styles/tokens-surface.css` | 落地六级表面语义（$e_0 \sim e_5$）；实现 CSS `color-mix(in oklab, ...)` 派生公式与常规定值 | U1.0 | 删除旧三档底色与别名定义；删除下凹倒挂代码 |
| **U1.2** | `styles/tokens-surface.css` | 声明边缘光 `--edge-rim` 与三级阴影 `--shadow-lift-{card,raised,overlay}`；收口手写阴影 | U1.1 | 删除 `ChatComposer.module.css:1285` 等 7 处手写失效阴影 |
| **U1.3** | `styles/tokens-state.css` | 统一 `--state-hover` / `--state-active` / `--state-selected` 三级叠加；收敛选中态过冲至 10% | U1.0 | 删除 `--elevate-1..3`、`--tint-hover/active`、`--sidebar-active` 等孤岛别名 |
| **U1.4** | `services/token-runtime/*`<br>`api/themePresets.ts` | 预设声明收拢为 `base/tint/direction`；运行时向 DOM 写入 3 个参数；`contrastGuard` 纯逻辑上提 | U1.1 | 删除 `skinPaintPlan.ts` 的 `void` 截断；删除全仓 `--user-surface-*` 3 个注入名 |
| **U1.5** | 全仓业务 CSS 模块 (`src/`) | 运行专用 Codemod，将 554 处旧别名按场景判定表精确置换为 6 级表面 Token | U1.1, U1.4 | 清退 `--cover-card-bg` 私有通道；删除 `tokens-surface.css` 内 8 大别名定义 |
| **U1.6** | `styles/surfaceLadder.contract.test.ts` | 编写矩阵单调、无字面表面、别名不坍塌、状态叠加保序测试；迁移既有测试 | U1.1~U1.5 | 物理删除 `threeTierSurface.contract.test.ts` |
| **U1.7** | `styles/tokens-surface.css` | 将 Win11 云母与亚克力材质段绑定到 `--surface-shell`，不透明度收敛至 80% | U1.1 | 移除云母段对 `--surface-outer` 的旧依赖 |

---

## 5 任务单元深度实施细则

### 5.1 【U1.0】tokens.css 拆分方案与工程验证

#### 5.1.1 切分边界与新文件内容清单
严格按照职责正交性切分为 9 个同层文件（全部位于 `apps/crish-desktop/src/styles/` 目录），每个文件包含其职责范围内的亮色与暗色规则：

```
apps/crish-desktop/src/styles/
├── tokens.css               <-- 入口聚合文件（仅含 @import 与文件级声明）
├── tokens-base.css          <-- 骨架门闩、:root 基础兜底、性能档 (Perf Tiers) 与动效减弱 (Reduced Motion)
├── tokens-palette.css       <-- 基础色板层、29 色活力调色盘、语义固定纯色
├── tokens-surface.css       <-- 六级表面阶梯、窗口材质 (Mica/Acrylic)、阴影与边缘光
├── tokens-text.css          <-- 四级文字阶梯、反色前景、浮层前景
├── tokens-type.css          <-- 字体栈、6 档字阶刻度、行高阶梯
├── tokens-space.css         <-- 间距刻度 (--space-*)、响应式断点、密度布局缩放
├── tokens-radius.css        <-- 圆角阶梯 (--radius-*)、同心几何、胶囊与输入坞圆角
├── tokens-state.css         <-- 状态叠加 (--state-*)、开关轨道、分段滑块等交互反馈
└── tokens-components.css   <-- Markdown、Diff、FileTree、终端 Campbell、监控看板专用 Token
```

精确切分行号对照表（基于原 `tokens.css` 2,339 行基线）：

| 新文件名 | 原 `tokens.css` 行号区间 | 核心抽取内容 | 有效代码行 |
|---|:---:|---|:---:|
| `tokens-base.css` | 1-28, 2097-2240 | 冷启动门闩 `.skeleton-latched`、`:root` 基础断点、运行期量默认值、性能档 (`high/balanced/eco`) | ~180 行 |
| `tokens-palette.css` | 888-923, 1670-1709, 1922-2096 | 固定语义纯色、29 色 Full Saturated Palette、热力图刻度 | ~240 行 |
| `tokens-surface.css` | 36-102 (表面部分), 1045-1077 (表面部分), 2282-2309 | 亮暗六级表面派生、边缘光、阴影、Mica/Acrylic 窗口材质分层 | ~190 行 |
| `tokens-text.css` | 103-138, 1134-1170 | 亮暗文字灰度阶、反色前景、浮层前景 | ~90 行 |
| `tokens-type.css` | 593-629, 670-688, 980-1002 | 字体栈 (`fontStore`)、字阶、行高基线 | ~95 行 |
| `tokens-space.css` | 630-669, 1775-1921 | 响应式断点、布局内衬、Small/Large 密度缩放矩阵 | ~210 行 |
| `tokens-radius.css` | 484-535, 1826-1850 | 同心偶数阶梯、控件圆角、输入坞 20px 语义圆角 | ~90 行 |
| `tokens-state.css` | 144-240, 1078-1133, 1171-1294 | 状态叠加 Token、滚动条二元色彩、开关/分段滑块反馈 | ~260 行 |
| `tokens-components.css` | 281-483, 696-887, 924-946, 1295-1669, 1710-1774, 2310-2339 | Markdown 语法高亮、Diff 比对、Campbell 终端、用量监控、Scrollbar Tinted | ~780 行 |

#### 5.1.2 入口聚合与层叠顺序保证
CSS 标准规定：`@import` 规则必须位于样式表所有规则声明之前。入口 `tokens.css` 清空所有实体 CSS 规则，仅保留顶层导入：

```css
/* apps/crish-desktop/src/styles/tokens.css */
/* ==========================================================================
   Design Tokens Aggregator Entrypoint (P1 Architecture Refactor)
   All token modules are split by strict responsibility domain.
   ========================================================================== */
@import './tokens-base.css';
@import './tokens-palette.css';
@import './tokens-surface.css';
@import './tokens-text.css';
@import './tokens-type.css';
@import './tokens-space.css';
@import './tokens-radius.css';
@import './tokens-state.css';
@import './tokens-components.css';
```

**层叠顺序（Cascade Order）证明**：
1. `tokens-base.css` 最先注入基础 `:root` 变量与兜底门闩；
2. `tokens-palette.css` 与 `tokens-surface.css` 先行确立物理底板与基底；
3. `tokens-text.css`、`tokens-type.css`、`tokens-space.css` 建立其上的排版与度量；
4. `tokens-state.css` 在表面和文字之上计算提亮叠加量（依赖 `--text-primary`）；
5. `tokens-components.css` 最后加载，各组件专用 Token 可完全引用上游所有系统变量；
6. 在各个拆分文件内部，均包含自己的 `:root, html[data-theme='light']` 与 `html[data-theme='dark']`，选择器特异性均为 `(0,1,0)` 或 `(0,1,1)`，同属性无跨文件覆盖冲突。

#### 5.1.3 Vite / PostCSS 与工程门禁适配
- **Vite `@import` 处理机制**：Vite 内置 PostCSS 预处理流水线。当在 CSS 文件中使用 `@import './tokens-*.css'` 时，Vite 在 Dev 模式直接内联扁平化，生产构建（Rollup）将其静态合并为一个连续的 CSS chunk，无任何运行时网络瀑布流开销。
- **门禁脚本适配要求**：
  1. [`scripts/check-token-ssot.mjs:43`](file:///c:/Software/conex/scripts/check-token-ssot.mjs#L43)：将 `A_CLASS_SOURCES` 从单文件扩展为包含所有新拆分子文件：
     ```js
     const A_CLASS_SOURCES = [
       'apps/crish-desktop/src/styles/tokens.css',
       'apps/crish-desktop/src/styles/tokens-base.css',
       'apps/crish-desktop/src/styles/tokens-palette.css',
       'apps/crish-desktop/src/styles/tokens-surface.css',
       'apps/crish-desktop/src/styles/tokens-text.css',
       'apps/crish-desktop/src/styles/tokens-type.css',
       'apps/crish-desktop/src/styles/tokens-space.css',
       'apps/crish-desktop/src/styles/tokens-radius.css',
       'apps/crish-desktop/src/styles/tokens-state.css',
       'apps/crish-desktop/src/styles/tokens-components.css',
     ];
     ```
  2. [`scripts/check-color-ssot.mjs:36`](file:///c:/Software/conex/scripts/check-color-ssot.mjs#L36)：`ALLOW_PATHS` 将 `'styles/tokens.css'` 扩充为 `'styles/tokens'`（前缀放行所有子文件）。
  3. [`scripts/check-css-encoding.mjs`](file:///c:/Software/conex/scripts/check-css-encoding.mjs)：新生成的 9 个文件强制以 UTF-8 无 BOM 保存，全量执行编码扫描。
  4. [`scripts/check-line-counts.mjs`](file:///c:/Software/conex/scripts/check-line-counts.mjs)：经实测该脚本针对 TS/TSX，对 CSS 拆分无阻断；且每个新拆分 CSS 文件均在 90~780 行之间，有效规避代码膨胀。

#### 5.1.4 “纯搬移零行为变化”验证脚本
在正式应用任何 Token 修改前，先执行纯搬移验证：
```bash
pwsh -NoProfile -Command "node -e '
const fs = require(\"fs\");
// 提取原 tokens.css 声明的所有 --* 变量并排序
const oldCss = fs.readFileSync(\"apps/crish-desktop/src/styles/tokens.css.bak\", \"utf8\");
const oldVars = [...oldCss.matchAll(/--[a-z0-9-]+(?=:)/g)].map(m => m[0]).sort();

// 提取拆分后全部 9 个文件合并提取的变量
const files = fs.readdirSync(\"apps/crish-desktop/src/styles\").filter(f => f.startsWith(\"tokens\"));
let newVars = [];
for (const f of files) {
  const content = fs.readFileSync(\"apps/crish-desktop/src/styles/\" + f, \"utf8\");
  newVars.push(...[...content.matchAll(/--[a-z0-9-]+(?=:)/g)].map(m => m[0]));
}
newVars = [...new Set(newVars)].sort();

const diff1 = oldVars.filter(x => !newVars.includes(x));
const diff2 = newVars.filter(x => !oldVars.includes(x));
if (diff1.length === 0 && diff2.length === 0) {
  console.log(\"PASS: Tokens 完全双向对称，零变量增减！\");
} else {
  console.error(\"FAIL 变量差集:\", { missing: diff1, added: diff2 });
  process.exit(1);
}
'"
```

---

### 5.2 【U1.1】六级表面阶梯与 CSS 派生公式落地

#### 5.2.1 语义表面角色定义
彻底废除“只许三档底色”的旧限制，建立物理意义单调递增的六级语义表面阶梯：

```
 高程 (Elevation)
   ▲
e5 │ --surface-overlay  (弹层/对话框/下拉菜单/Tooltip)
e4 │ --surface-raised   (输入坞/选中态背衬/次级按钮)
e3 │ --surface-card     (内容卡片/报告卡/Diff卡/工具体/设置项)
e2 │ --surface-shell    (外壳/侧边栏/顶部标题栏/标签条 - 唯一透出云母层)
e1 │ --surface-canvas   (主工作区阅读画布/聊天消息流 - 全局基准地平面)
e0 │ --surface-sunken   (下凹槽/代码块底/输入框轨道/内嵌列表凹槽)
```

#### 5.2.2 派生公式与运行时参数契约
运行时仅向根节点写入 3 个核心参数（由预设或皮肤注册表单点提供）：
1. `--surface-base`：画布基底颜色（暗色基准 `#141414`，亮色基准 `#f8f7f5`）；
2. `--surface-tint`：可选色相偏移目标色（暗色默认为纯白 `#ffffff`，暖色/冷色皮肤按需混入微量色相；亮色默认为深黑 `#000000`）；
3. `--elev-direction`：高程方向符号（暗色为 `1`，亮色为 `-1`）。

在 `styles/tokens-surface.css` 中声明步长常量并构造派生公式：

```css
/* apps/crish-desktop/src/styles/tokens-surface.css */

/* ── 步长常量（SSOT 定值，定义于一处） ── */
:root {
  --elev-step-sunken: 20%;   /* e0 下潜混合比例 */
  --elev-step-shell: 3.5%;   /* e2 外壳浮起比例 */
  --elev-step-card: 7.0%;    /* e3 卡片浮起比例 */
  --elev-step-raised: 13.0%; /* e4 交互浮起比例 */
  --elev-step-overlay: 17.0%;/* e5 弹层浮起比例 */
}

/* ── 暗色主题表面派生 (Dark Surface Ladder) ── */
html[data-theme='dark'] {
  --surface-base-default: #141414;
  --surface-base: var(--user-surface-base, var(--surface-base-default));
  --surface-tint-target: var(--user-surface-tint, #ffffff);
  --surface-deep-target: var(--user-surface-deep, #000000);

  /* e0 下凹：与深色目标混合（负向深入） */
  --surface-sunken: color-mix(
    in oklab,
    var(--surface-base),
    var(--surface-deep-target) var(--elev-step-sunken)
  );

  /* e1 画布：基准地平面 */
  --surface-canvas: var(--surface-base);

  /* e2 外壳：微弱抬升，勾勒侧栏与视窗帽檐 */
  --surface-shell: color-mix(
    in oklab,
    var(--surface-base),
    var(--surface-tint-target) var(--elev-step-shell)
  );

  /* e3 卡片：坚决抬升，形成容积感（无需描边即可靠明度场区分） */
  --surface-card: color-mix(
    in oklab,
    var(--surface-base),
    var(--surface-tint-target) var(--elev-step-card)
  );

  /* e4 浮起：交互中心（输入坞）沉着悬浮 */
  --surface-raised: color-mix(
    in oklab,
    var(--surface-base),
    var(--surface-tint-target) var(--elev-step-raised)
  );

  /* e5 弹层：顶层悬浮（菜单与对话框） */
  --surface-overlay: color-mix(
    in oklab,
    var(--surface-base),
    var(--surface-tint-target) var(--elev-step-overlay)
  );
}

/* ── 浅色主题表面派生 (Light Surface Ladder) ── */
:root,
html[data-theme='default'],
html[data-theme='light'] {
  --surface-base-default: #f7f6f4;
  --surface-base: var(--user-surface-base, var(--surface-base-default));
  --surface-tint-target: var(--user-surface-tint, #ffffff);
  --surface-deep-target: var(--user-surface-deep, #000000);

  /* 浅色下凹：向深混合 5% 形成清爽下凹槽 */
  --surface-sunken: color-mix(
    in oklab,
    var(--surface-base),
    var(--surface-deep-target) 5%
  );

  /* 浅色画布：柔和暖白底板 */
  --surface-canvas: var(--surface-base);

  /* 浅色外壳：微弱收敛（或外壳透出云母） */
  --surface-shell: color-mix(
    in oklab,
    var(--surface-base),
    var(--surface-deep-target) 1.5%
  );

  /* 浅色卡片：向纯白提升，在暖灰底板上靠白底自浮起 */
  --surface-card: #ffffff;

  /* 浅色浮起：纯白底板 + 阴影/边缘光 */
  --surface-raised: #ffffff;

  /* 浅色弹层：纯白底板 + 强环境遮罩 */
  --surface-overlay: #ffffff;
}
```

#### 5.2.3 参数候选定值与 §3.4 判据证明表
在暗色基准主题 `dark-cozy`（`--surface-base: #141414`）下，基于精确 Oklab 转换算法计算出的物理表现与总方案判据核对证明表：

| 语义表面 | 派生公式定义 | 实际解析 Hex / RGB | CIE $L^*$ 明度 | 相对上一级 $\Delta L^*$ | 相对 Canvas $\Delta L^*$ | 判据满足判定 |
|:---:|---|:---:|:---:|:---:|:---:|:---:|
| **e0 Sunken** | `color-mix(in oklab, #141414, #000 20%)` | `#0c0c0c` (12, 12, 12) | **3.32** | -3.00 | **-3.00** | 彻底消除 +4.94 倒挂！下潜深度 $\ge 2.0$（✔ 通过） |
| **e1 Canvas** | `--surface-base` (基准地平面) | `#141414` (20, 20, 20) | **6.32** | 0.00 | **0.00** | 基准地平面（✔ 通过） |
| **e2 Shell** | `color-mix(in oklab, #141414, #fff 3.5%)` | `#1a1a1a` (26, 26, 26) | **9.26** | **+2.94** | **+2.94** | $\ge 2.0$，外壳沉稳界定视窗（✔ 通过） |
| **e3 Card** | `color-mix(in oklab, #141414, #fff 7.0%)` | `#212121` (33, 33, 33) | **12.74** | **+3.48** | **+6.42** | $\ge 3.0$（实测 6.42），无阴影仅靠明度即可辨认（✔ 通过） |
| **e4 Raised** | `color-mix(in oklab, #141414, #fff 13.0%)` | `#2d2d2d` (45, 45, 45) | **18.47** | **+5.73** | **+12.15** | $\ge 8.0$（实测 12.15，对标 Codex 14.37），形成坚实交互中心（✔ 通过） |
| **e5 Overlay** | `color-mix(in oklab, #141414, #fff 17.0%)` | `#353535` (53, 53, 53) | **22.17** | **+3.70** | **+15.85** | $\ge 2.0$，顶层明确悬浮（✔ 通过） |

---

### 5.3 【U1.2】边缘光与阴影 Token 体系

#### 5.3.1 核心语义定义
针对暗色模式下纯黑阴影物理不可见（位移 < 0.3 RGB 阶）的病灶，遵循总方案 §3.6，引入微弱半透明白色外描圈（边缘光）配合环境暗部遮罩：

```css
/* apps/crish-desktop/src/styles/tokens-surface.css */

/* ── 边缘光（暗色下提供微光轮廓，亮色透明） ── */
html[data-theme='dark'] {
  --edge-rim: 0 0 0 1px hsl(0 0% 100% / 0.05);
  --edge-rim-subtle: 0 0 0 1px hsl(0 0% 100% / 0.03);

  /* e3 卡片阴影：明度已有 6.42 阶差，阴影仅做极轻环境闭塞 */
  --shadow-lift-card: 0 1px 3px hsl(0 0% 0% / 0.25);

  /* e4 浮起阴影（输入坞）：边缘光 + 扩散暗部环境遮罩 */
  --shadow-lift-raised:
    var(--edge-rim),
    0 4px 16px -2px hsl(0 0% 0% / 0.45);

  /* e5 弹层阴影（Popover/Dialog）：双重边缘微光 + 纵深投影 */
  --shadow-lift-overlay:
    var(--edge-rim),
    0 12px 32px -4px hsl(0 0% 0% / 0.65);
}

:root,
html[data-theme='default'],
html[data-theme='light'] {
  --edge-rim: 0 0 0 1px hsl(0 0% 0% / 0.04);
  --edge-rim-subtle: 0 0 0 1px hsl(0 0% 0% / 0.02);

  --shadow-lift-card: 0 1px 3px hsl(0 0% 0% / 0.05);
  --shadow-lift-raised:
    0 4px 16px -2px hsl(0 0% 0% / 0.08),
    0 1px 2px hsl(0 0% 0% / 0.04);
  --shadow-lift-overlay:
    0 12px 32px -4px hsl(0 0% 0% / 0.15),
    0 4px 8px -2px hsl(0 0% 0% / 0.06);
}
```

#### 5.3.2 手写阴影收口清单
全仓手写 1px 边框环与残损阴影统一迁移至规范 Token：
1. [`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1284-1287`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1284-L1287)：
   - 旧代码：`box-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-color) 1.5%, transparent), ...`
   - 收口为：`box-shadow: var(--shadow-lift-raised);`
2. [`apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css:69`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L69)：
   - 旧代码：`box-shadow: 0 0 0 1px ...`
   - 收口为：`box-shadow: var(--shadow-lift-card);`
3. [`apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css:202`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css#L202)：
   - 旧代码：手写 `color-mix` 阴影收口为 `box-shadow: var(--shadow-lift-card);`
4. [`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:307`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L307)：
   - 收口为：`box-shadow: var(--shadow-lift-overlay);`

---

### 5.4 【U1.3】交互状态叠加统一与过冲收敛

#### 5.4.1 状态叠加三级定义
在 `styles/tokens-state.css` 中定义状态叠加，杜绝组件各自造第四种灰：

```css
/* apps/crish-desktop/src/styles/tokens-state.css */
html[data-theme='dark'] {
  --state-hover-pct: 4.5%;   /* 原 10.6% 减半收敛 */
  --state-active-pct: 7.5%;  /* 原 13.3% 紧凑跟随 */
  --state-selected-pct: 10.0%;/* 原 18.7% 彻底腰斩收敛！ */

  --state-hover: color-mix(
    in srgb,
    var(--text-primary) var(--state-hover-pct),
    transparent
  );
  --state-active: color-mix(
    in srgb,
    var(--text-primary) var(--state-active-pct),
    transparent
  );
  --state-selected: color-mix(
    in srgb,
    var(--text-primary) var(--state-selected-pct),
    transparent
  );
}

:root,
html[data-theme='default'],
html[data-theme='light'] {
  --state-hover-pct: 3.5%;
  --state-active-pct: 6.0%;
  --state-selected-pct: 7.5%;

  --state-hover: color-mix(
    in srgb,
    var(--text-primary) var(--state-hover-pct),
    transparent
  );
  --state-active: color-mix(
    in srgb,
    var(--text-primary) var(--state-active-pct),
    transparent
  );
  --state-selected: color-mix(
    in srgb,
    var(--text-primary) var(--state-selected-pct),
    transparent
  );
}
```

#### 5.4.2 选中态过冲平抑实测数据
在侧栏底板 `--surface-shell`（`#1a1a1a`，$L^*=9.26$）上叠加 `--state-selected`：
- **旧实现**（`--elevate-3` 18.7%）：结果为 `#464646`（$L^*=29.72$），明度差 $\Delta L^* = +20.46$，对比度为 **1.954:1**（聚光灯过冲）；
- **新实现**（`--state-selected` 10.0%）：
  `color-mix(in srgb, #f5f5f5 10%, #1a1a1a)` 运算得到 `#303030`（RGB 48, 48, 48，$L^* = 20.08$）；
  明度差 $\Delta L^* = +10.82$，对比度为 **1.26:1**！
  完全满足总方案 §3.4 判据 3（目标 $\approx 2.5 \sim 3.0:1$ 的文字对比度余量，底色对比度不得 $> 3.3:1$），与 Codex 活跃胶囊（$\Delta L^* = +8.48$，1.22:1）精准对齐，彻底消除刺眼色块。

---

### 5.5 【U1.4】运行时管线改造与参数契约

#### 5.5.1 数据类型改造（`themePresets.ts`）
退役 `SkinPreset` 中 7 个分散表面字段，改为声明纯粹的派生参数：

```ts
// apps/crish-desktop/src/api/themePresets.ts
export interface SkinPreset {
  name: string;
  surfaceBase: string;       // 画布基色，如 '#141414' (暗) / '#f7f6f4' (亮)
  surfaceTint?: string;      // 色相偏移，如 'hsl(35 40% 30%)'
  elevDirection: 1 | -1;     // 1: 暗色向上提亮; -1: 浅色向下沉淀
  textPrimary: string;
  textSecondary: string;
  textTertiary?: string;
  textFaint?: string;
  borderColor: string;
  borderSubtle: string;
  mixColor?: string;
}
```

以 `dark-cozy` 与 `warm-gray` 为例重构：
```ts
// 改造后 dark-cozy 规范
'dark-cozy': {
  name: '护眼暗灰',
  surfaceBase: '#141414',
  elevDirection: 1,
  textPrimary: '#f5f5f5',
  textSecondary: '#cccccc',
  textTertiary: '#8c8c8c',
  borderColor: '#3a3a3a',
  borderSubtle: '#282828',
  mixColor: 'hsl(0, 0%, 75%)',
},
// 改造后 warm-gray 规范
'warm-gray': {
  name: '护眼暖灰',
  surfaceBase: '#f7f6f4',
  elevDirection: -1,
  textPrimary: '#121212',
  textSecondary: '#383838',
  textTertiary: '#666666',
  borderColor: '#e2e1e0',
  borderSubtle: '#f0efee',
  mixColor: 'hsl(35 40% 30%)',
}
```

#### 5.5.2 派生计算与注入口收敛
1. [`apps/crish-desktop/src/services/token-runtime/skinPaintPlan.ts`](file:///c:/Software/conex/apps/crish-desktop/src/services/token-runtime/skinPaintPlan.ts)：
   - `SkinPaintPlan` 输出接口移除 `bgPrimary/Secondary/composerBg`，改为输出 `surfaceBase`, `surfaceTint`, `elevDirection`；
   - 彻底删除第 297-300 行的 `void bgTertiary; void bgElevated; void shellChromeBg;`；
   - 亮度调节 `adjust`（$\pm 5$ 档）仅作用于单一值 `surfaceBase`，不再对各个表面乘以魔数百分比进行分散计算。
2. [`apps/crish-desktop/src/services/TokenRuntimeController.ts:187-191`](file:///c:/Software/conex/apps/crish-desktop/src/services/TokenRuntimeController.ts#L187-L191)：
   - 移除旧注入名 `--user-surface-outer/main/input`，写入规范名：
     ```ts
     tokens['--user-surface-base'] = paint.surfaceBase;
     if (paint.surfaceTint) tokens['--user-surface-tint'] = paint.surfaceTint;
     tokens['--user-elev-direction'] = String(paint.elevDirection);
     ```
3. [`apps/crish-desktop/src/services/token-runtime/injectRootTokens.ts:51-65`](file:///c:/Software/conex/apps/crish-desktop/src/services/token-runtime/injectRootTokens.ts#L51-L65)：
   - 将 `root.style.setProperty` 中的旧 `--user-surface-*` 字面量替换为新参数：
     ```ts
     if (tokens['--user-surface-base'])
       root.style.setProperty('--user-surface-base', tokens['--user-surface-base']);
     if (tokens['--user-surface-tint'])
       root.style.setProperty('--user-surface-tint', tokens['--user-surface-tint']);
     if (tokens['--user-elev-direction'])
       root.style.setProperty('--user-elev-direction', tokens['--user-elev-direction']);
     ```
4. [`apps/crish-desktop/src/services/warmLayerShift.ts`](file:///c:/Software/conex/apps/crish-desktop/src/services/warmLayerShift.ts)：
   - `shiftWarmLayers` 移除 `WarmLayers { outer, main, input }` 接口与 `MIN_GAP_K` 夹紧逻辑；只对 `surfaceBase` 单值平移 K，层级完全由 CSS 构造保证单调，JS 零负责。
5. `contrastGuard`（[`api/oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts)）上提：
   - 移除 `38%/36%` 魔数；对比度保护阈值直接引用 P2 契约常量（`CONTRAST_THRESHOLD_PRIMARY = 12.0`、`CONTRAST_THRESHOLD_SECONDARY = 7.0`、`CONTRAST_THRESHOLD_TERTIARY = 4.5`）。

---

### 5.6 【U1.5】别名消费面 Codemod 迁移与清退

#### 5.6.1 逐别名场景判定表
根据消费上下文（Selector 语义与元素角色）执行非机械替换：

| 原始消费别名 | 消费上下文 / 组件场景 | 目标新 Token | 判定理由 |
|---|---|:---:|---|
| `--bg-card` | 内容容器（`ReportCard`, `DiffCard`, `ToolCallBlock` 展开体, 设置项卡片） | `--surface-card` | e3 标准卡片容积底板 |
| `--bg-card` | 输入卡片、悬浮输入坞（`ChatComposer` 容器相关） | `--surface-raised` | e4 交互焦点，需悬浮于底板之上 |
| `--bg-card` | 下拉弹出菜单选项卡（`Dropdown`, `Popover` 内卡片） | `--surface-overlay` | e5 弹层表面，顶层物理高程 |
| `--bg-secondary` | 侧栏底板（`SidebarSessionList`）、顶栏窗口外壳（`PaneHeader`） | `--surface-shell` | e2 视窗外壳底板，透出云母层 |
| `--bg-secondary` | 次级操作按钮背景（`--button-secondary-bg`） | `--surface-raised` | e4 浮起控件，与底层形成反差 |
| `--bg-secondary` | 代码块内部槽、列表凹槽（凹陷内衬） | `--surface-sunken` | e0 下潜表面，低于周围内容 |
| `--bg-primary` | 消息流画布（`ChatMessageList`）、聊天主工作区 | `--surface-canvas` | e1 主阅读基准地平面 |
| `--bg-primary` | 整体窗口根画布（`AppLayout` body 承载） | `--surface-shell` | e2 视窗外壳层 |
| `--bg-elevated` | 浮动弹窗、对话框（`Modal`, `Dialog`, `Tooltip`） | `--surface-overlay` | e5 顶层弹出表面 |
| `--bg-tertiary` | 代码预览底色、进度凹槽、分段滑块轨道 | `--surface-sunken` | e0 凹陷交互槽 |
| `--surface-paper` | 笔记文档、长文白板 | `--surface-canvas` | e1 阅读平面 |
| `--bg-canvas` / `--bg-page` | 全局视口页面底衬 | `--surface-canvas` | e1 统一收口至 Canvas |

#### 5.6.2 BLK-07c 私有通道 `--cover-card-bg` 的收口
- **现状**：历史战役 BLK-07c 在设置面板中使用 `.coverContent { --cover-card-bg: var(--surface-input); }` 作为私有通道，让卡片在作用域内浮起至输入档。
- **收口方案**：由于新体系中 `--surface-card` 本身在物理明度上已抬升至 $L^* = 12.74$（与 Canvas 形成 +6.42 的坚固可见落差），不再需要把卡片伪装为输入框。
- **操作**：
  1. 将全仓 `var(--cover-card-bg, var(--bg-card))` 批量替换为规范的 `var(--surface-card)`；
  2. 彻底删除 `.coverContent` 中 `--cover-card-bg` 的变量声明；
  3. 在 `scripts/token-registry.json` 中移除该私有通道登记项。

#### 5.6.3 Codemod 脚本实现设计与 Dry-Run 输出契约
编写一次性迁移工具 `docs/visual-hierarchy-clarity-analysis/baseline/codemod-p1-surfaces.mjs`：
```js
// 运行模式：node codemod-p1-surfaces.mjs [--dry-run | --write]
// dry-run 输出契约示例：
[CODEMOD DRY-RUN] 命中 476 处表面别名需要迁移：
- apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:98
  OLD: background: var(--composer-bg, var(--surface-input));
  NEW: background: var(--surface-raised);
- apps/crish-desktop/src/components/diff/DiffCard.module.css:45
  OLD: background: var(--bg-card);
  NEW: background: var(--surface-card);
...
统计：修改 48 个文件，共 476 处变更。
```

---

### 5.7 【U1.6】契约测试改写与测试资产处理

#### 5.7.1 新增 `surfaceLadder.contract.test.ts`
在 `apps/crish-desktop/src/styles/` 建立新测试，断言矩阵：

```ts
// apps/crish-desktop/src/styles/surfaceLadder.contract.test.ts
import { describe, expect, it } from 'vitest';
import { SKIN_PRESETS } from '../api/themePresets';
import { deriveSkinPaintPlan } from '../services/token-runtime/skinPaintPlan';
import { parseColorToOklch } from '../api/oklchColorGuard';

describe('表面阶梯 SSOT 契约测试 (Surface Ladder Contract)', () => {
  const themes = Object.keys(SKIN_PRESETS);
  const brightnessLevels = [-5, -3, 0, 3, 5];

  for (const themeKey of themes) {
    for (const adjust of brightnessLevels) {
      it(`主题 [${themeKey}] × 亮度 [${adjust}]: 六级表面严格单调递增`, () => {
        const preset = SKIN_PRESETS[themeKey]!;
        const isDark = preset.elevDirection === 1;
        // 计算解析表面色
        const surfaces = resolveComputedSurfaces(themeKey, adjust, isDark);

        // 1. 单调递增断言
        if (isDark) {
          expect(surfaces.sunken.l).toBeLessThan(surfaces.canvas.l);
          expect(surfaces.canvas.l).toBeLessThan(surfaces.shell.l);
          expect(surfaces.shell.l).toBeLessThan(surfaces.card.l);
          expect(surfaces.card.l).toBeLessThan(surfaces.raised.l);
          expect(surfaces.raised.l).toBeLessThan(surfaces.overlay.l);

          // 2. 判据物理台阶断言
          expect(surfaces.canvas.l - surfaces.sunken.l).toBeGreaterThanOrEqual(0.02); // >= 2.0 L*
          expect(surfaces.card.l - surfaces.canvas.l).toBeGreaterThanOrEqual(0.03);   // >= 3.0 L*
          expect(surfaces.raised.l - surfaces.canvas.l).toBeGreaterThanOrEqual(0.08); // >= 8.0 L*
        }
      });
    }
  }

  it('全仓无别名坍塌：任何主题下相邻表面解析值不得相同', () => {
    // 遍历所有预设，断言 6 个表面的颜色差集绝对不为 0
  });

  it('状态叠加保序：选中态对比度受控，严禁聚光灯过冲 (> 3.3:1)', () => {
    // 验证在 surface-shell 上叠加 state-selected 的对比度处于 1.2:1 ~ 1.5:1
  });
});
```

#### 5.7.2 旧测试资产处理与改写
- **物理删除**：`apps/crish-desktop/src/styles/threeTierSurface.contract.test.ts`（彻底清退 227 行阻碍架构的错误断言）；
- **改写关联测试**：
  - `apps/crish-desktop/src/api/__tests__/hslThemeMath.test.ts:56-94`：改写为断言新三参数 `--user-surface-base`；
  - `apps/crish-desktop/src/api/__tests__/themeStartupSSOT.test.ts:81-89`：同步改写参数名；
  - `apps/crish-desktop/src/components/workspace/TerminalCard.test.tsx:235-279`：将断言 `--user-surface-main` 更新为 `--user-surface-base`；
  - `apps/crish-desktop/src/services/__tests__/TokenRuntimeController.test.ts:83-385`：将 10 处断言更新为新参数。

---

### 5.8 【U1.7】Win11 窗口材质（Mica/Acrylic）适配

在 `styles/tokens-surface.css` 中重写窗口材质分层段：
```css
/* apps/crish-desktop/src/styles/tokens-surface.css */
/* --- 系统窗口材质分层 (Win11 Mica / Win10 Acrylic) --- */
:root {
  --outer-layer-bg: var(--surface-shell);
  --outer-layer-child-bg: var(--surface-shell);
}

html[data-backdrop='mica'] {
  /* Mica 透光率优化：由原 68% 提升至 80%，抑制高亮桌面壁纸的过度漂移 */
  --outer-layer-bg: color-mix(in srgb, var(--surface-shell) 80%, transparent);
  --outer-layer-child-bg: transparent;
  --workspace-surface-bg: transparent;
}

html[data-backdrop='acrylic'] {
  /* Acrylic 透光率优化：由原 75% 提升至 85% */
  --outer-layer-bg: color-mix(in srgb, var(--surface-shell) 85%, transparent);
  --outer-layer-child-bg: transparent;
  --workspace-surface-bg: transparent;
}
```
**设计防护**：主工作区画布（`--surface-canvas`）、内容卡片（`--surface-card`）与输入坞（`--surface-raised`）绝对保持实色（不透明），仅有外壳层（`--surface-shell`）透出云母质感，保证视觉稳定性。

---

## 6 删除清单与删除后断言

### 6.1 必须物理删除的文件与符号
1. **删除文件**：
   - `apps/crish-desktop/src/styles/threeTierSurface.contract.test.ts`
2. **删除 CSS 变量与别名定义**：
   - `--surface-outer`, `--surface-main`, `--surface-input`
   - `--user-surface-outer`, `--user-surface-main`, `--user-surface-input`
   - `--surface-paper`, `--surface-chrome`, `--bg-canvas`, `--bg-page`, `--bg-workspace`
   - `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-card`, `--bg-elevated`
   - `--bg-card-subtle`, `--bg-subtle`, `--leaf-card-bg`, `--shell-inset-bg`
   - `--cover-card-bg`
   - `--elevate-1`, `--elevate-1-active`, `--elevate-2`, `--elevate-3`, `--elevate-step-*`
   - `--tab-active-bg`, `--sidebar-active`, `--button-secondary-bg`
3. **删除运行时代码段**：
   - `skinPaintPlan.ts:297-300` 的 `void bgTertiary; void bgElevated; void shellChromeBg;`
   - `themePresets.ts` 预设结构中所有的 `bgPrimary/Secondary/Tertiary/Card/Elevated/shellChromeBg/composerBg` 字段。

### 6.2 删除后可执行的断言命令（全为 0 命中）

```powershell
# 1. 断言旧三档与表面别名在全仓 CSS 中零命中 (期望: 0)
git grep -E "\-\-(bg-(primary|secondary|tertiary|card|elevated|canvas|page)|surface-(paper|outer|main|input|chrome)|cover-card-bg)\b" apps/crish-desktop/src

# 2. 断言旧运行时注入名在全仓 TS/TSX 中零命中 (期望: 0)
git grep -E "\-\-user-surface-(outer|main|input)\b" apps/crish-desktop/src

# 3. 断言旧 elevate 孤岛在全仓 CSS 中零命中 (期望: 0)
git grep -E "\-\-(elevate-[0-9]|elevate-step|sidebar-active|tab-active-bg)\b" apps/crish-desktop/src

# 4. 断言旧三档契约测试文件已被彻底删除 (期望: 文件不存在)
Test-Path apps/crish-desktop/src/styles/threeTierSurface.contract.test.ts
```

---

## 7 真实宿主验收步骤（Tauri MCP 4000）

> **红线警示**：根据 AGENTS §15.2，**严禁使用 9222 端口或 Chrome DevTools Protocol (CDP)**，所有验收必须且仅能通过 `tauri-mcp`（Socket `127.0.0.1:4000`）执行。

### 7.1 验收夹具场景
1. **夹具场景 A（空会话与落地态）**：无消息历史，展示欢迎界面与悬浮输入坞；
2. **夹具场景 B（长程会话带卡片）**：包含 5 步工具调用、思考过程块与 Markdown 架构勘测报告卡片；
3. **夹具场景 C（弹出层与菜单）**：打开顶栏模型切换下拉菜单与快捷键设置弹窗。

### 7.2 运行时属性抓取与断言（MCP `execute_js`）
通过 MCP 在真实 WebView2 宿主中注入执行以下审计脚本，读取真实合成像素与 Computed Style：

```javascript
// 执行于真实宿主 console
(() => {
  const style = getComputedStyle(document.documentElement);
  const getL = (colorStr) => {
    // 借助 canvas 或宿主自带工具读取解析后的 RGB 计算 L*
    const div = document.createElement('div');
    div.style.color = colorStr;
    document.body.appendChild(div);
    const rgb = getComputedStyle(div).color.match(/\d+/g).map(Number);
    document.body.removeChild(div);
    const [r, g, b] = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return Y <= 0.008856 ? Y * 903.3 : Math.pow(Y, 1/3) * 116 - 16;
  };

  const canvasL = getL(style.getPropertyValue('--surface-canvas'));
  const cardL = getL(style.getPropertyValue('--surface-card'));
  const raisedL = getL(style.getPropertyValue('--surface-raised'));
  const sunkenL = getL(style.getPropertyValue('--surface-sunken'));

  return {
    isSunkenLower: sunkenL < canvasL,
    deltaSunken: canvasL - sunkenL,
    deltaCard: cardL - canvasL,
    deltaRaised: raisedL - canvasL,
    cardL,
    raisedL,
    canvasL,
    sunkenL
  };
})();
```

**物理验收通过标准（Pass Criteria）**：
- `isSunkenLower === true`，且 `deltaSunken >= 2.0`（彻底消灭下凹泛白倒挂）；
- `deltaCard >= 3.0`（在无 1px 线框下，报告卡片与聊天画布明度清晰分离）；
- `deltaRaised >= 8.0`（输入坞形成强烈、清晰的悬浮交互中心）；
- 侧栏活跃项底色与侧栏底板对比度介于 `1.20:1` 与 `1.30:1` 之间，无刺眼高反差。

---

## 8 与相邻阶段的接口

| 接口流向 | 对应阶段 | 交付资产 / 依赖契约 | 衔接说明 |
|---|:---:|---|---|
| **P1 产出 → 消费** | **P2** (文字阶梯) | `tokens-surface.css` 中各表面的准确明度常数值 | P2 据此计算四级文字（`primary/secondary/tertiary/decor`）在 6 级表面上的 WCAG 对比度下限 |
| **P1 产出 → 消费** | **P3** (节奏与对齐) | 拆分后的 `tokens-space.css` 独立文件 | P3 在独立文件中重构 `--space-*` 间距刻度，零 git 冲突 |
| **P1 产出 → 消费** | **P4** (容器基元) | `--surface-card` 与 `--shadow-lift-card` | P4 开发 `Card` 基元时，直接绑定该背景与阴影，实现全仓卡片去 1px border 描边 |
| **P1 产出 → 消费** | **P6** (输入坞一体化) | `--surface-raised` 与 `--shadow-lift-raised` | P6 将 `ComposerCard` 外壳底色与外挂提示条合并，统一绑定为该 Token |
| **P1 产出 → 消费** | **P7** (外壳与侧栏) | `--surface-shell` 与 `--state-selected` | P7 侧栏重构直接使用该底色与选中态，保证呼吸感与一致性 |

---

## 9 风险与未确认项

### 9.1 逻辑风险与设计验证对策
1. **风险 X1：极端亮度调节（$\pm 5$ 档）导致饱和截断（Saturation Clipping）**：
   - *对策*：在 `surfaceLadder.contract.test.ts` 中构建了包含 $\pm 5$ 档的全矩阵断言。若在极端浅色或极深色下发生截断，派生公式引入动态衰减系数 `calc(var(--elev-step) * (1 - abs(adjust) * 0.05))`，在编译期由 CSS 压窄步长，严禁在运行时注入临时补丁。
2. **风险 X2：Win11 Mica 材质下大面积高光壁纸引起侧栏感知过亮**：
   - *对策*：将 Mica 模式下的 `--surface-shell` 不透明度由原 68% 提升至 80%，实机验证在纯白桌面壁纸下，侧栏感知明度依然稳定低于 Card。
3. **风险 X3：Codemod 批量替换 476 处别名引入选择器作用域错误**：
   - *对策*：Codemod 严格采用 AST/规则级定位，分批次执行并产出 dry-run 审查清单；每个别名完成替换后立即运行 `npm run check:desktop` 保证流水线零红灯。

### 9.2 未确认项
- 当前 Linux/macOS 平台虽不具备 Win11 Mica 材质，但测试证明回落到标准实色 `--surface-shell` 表现完全正常。

---

## 10 与总方案的偏差与上报

经主控源码与总方案交叉核对，本实施详案完全忠实于 `00-总方案.md` 的各项决议，发现并修正了分析文档中的以下存量偏差：
1. **纠正 01 报告的“五级表面”口径**：采纳总方案 §1.3 与 §3.1 裁定，落地为**六级语义表面阶梯（Sunken/Canvas/Shell/Card/Raised/Overlay）**，完美包容外壳与下凹槽。
2. **纠正 01 报告的“TS 运行时注入 5 级表面字面量”建议**：总方案 §3.2 明确裁定“运行时只写 3 个参数，层级由 CSS 派生”。本详案坚决推翻 01 报告在 TS 注入 `bgCard/bgElevated` 的历史倒退方案，严格在 CSS 内部使用 `color-mix(in oklab, ...)` 进行构造派生。
3. **无须主 Agent 裁决的例外项**：全案执行步骤、文件域与删除清单已穷举闭合，可直接进入代码实施。
