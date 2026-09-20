# DIM-04: 几何标尺、Z-Index 与编码治理详案 (G-04, G-05, G-13 收敛与测试矩阵)

> **归属战役**：`FRONTEND-CONVERGENCE-OVERHAUL`  
> **权威目录**：`docs/frontend-convergence-systemic-repair/`  
> **核心目标**：彻底消除 G-04（几何圆角 8 处）、G-05（Z-Index 标尺 5 处）、G-13（GBK 误报与注释损坏 1 处）收敛违规，并针对全仓 146 个受影响文件建立 4 层立体化测试与防回归验证矩阵。

---

## 1. G-04: 同心几何标尺收敛（8 处）

### 1.1 几何数学标尺
桌面端 UI 严禁使用毫无节制的 `9999px` 恶性胶囊通胀。根据同心圆角标尺公式：
$$R_{inner} = \max(0, R_{outer} - Padding)$$
各级标准 Token 如下：
- `--radius-xs`: `2px`（发丝线、极小指示器）
- `--radius-sm`: `4px`（IconButton, Badge, Kbd）
- `--radius-md`: `6px`（Tab, Select, Input）
- `--radius-lg`: `8px`（Card, Dropdown Content, Markdown Codeblock）
- `--radius-xl`: `12px`（Dialog, Large Panel）
- `--radius-btn`: `7px`（Button 用户锁统一权威单一真源）

### 1.2 8 处现场代码定点收敛表

| 序号 | 违规文件与行号 | 现有违规代码 | 重构收敛方案 | 几何依据 |
| :---: | :--- | :--- | :--- | :--- |
| 1 | `components/overlay/FirstRunWizard.module.css:65` | `border-radius: 9999px;` | `border-radius: var(--radius-sm);` | 向导步骤指示器胶囊微调为 4px 柔和微胶囊 |
| 2 | `components/ui/ScrollArea/ScrollArea.module.css:167` | `var(--scrollbar-thumb-radius, var(--radius-full))` | `var(--scrollbar-thumb-radius)` | 剥离非法 fallback，恢复 `--scrollbar-thumb-radius` 单真源 |
| 3 | `components/ui/ScrollArea/ScrollArea.module.css:218` | `var(--scrollbar-thumb-radius, var(--radius-full))` | `var(--scrollbar-thumb-radius)` | 同上，剥离 fallback |
| 4 | `components/ui/SegmentedControl/SegmentedControl.module.css:258` | `border-radius: var(--radius-full);` | `border-radius: var(--radius-sm);` | 分段控制器数量徽章采用 4px 微圆角 |
| 5 | `components/ui/SmartModelBadge.module.css:20` | `border-radius: 9999px;` | `border-radius: var(--radius-sm);` | 模型徽章与 Tab 徽章保持 4px 同心对齐 |
| 6 | `components/ui/Tabs/Tabs.module.css:142` | `border-radius: var(--radius-full);` | `border-radius: var(--radius-xs);` | 2px 底部活动指示线端点微圆角（2px） |
| 7 | `components/ui/Tabs/Tabs.module.css:264` | `border-radius: var(--radius-full);` | `border-radius: var(--radius-sm);` | Tab 数字徽章收敛至 4px |
| 8 | `components/ui/Tooltip/Tooltip.module.css:48` | `border-radius: var(--radius-full);` | `border-radius: var(--radius-sm);` | 统一为桌面端 4px 现代微圆角，并同步调整 `antiDarkeningGuard.test.ts` 断言 |

---

## 2. G-05: 7 级标准 Z-Index 标尺收敛（5 处）

### 2.1 项目 7 级 Z-Index 标尺标准
全仓单一真源：`apps/crish-desktop/src/styles/z-index.css`（封顶 9000，拦截一切通胀魔数）：
- **Level 0 (0)**: `--z-base: 0`
- **Level 1 (10)**: `--z-dock: 10` / `--z-sticky: 10`
- **Level 2 (100)**: `--z-chrome: 100` / `--z-sidebar: 100`
- **Level 3 (300)**: `--z-dropdown: 300`
- **Level 4 (500)**: `--z-popover: 500`
- **Level 5 (1000)**: `--z-modal: 1000` / `--z-toast: 1000`
- **Level 6 (9000)**: `--z-tooltip: 9000` / `--z-drag-overlay: 9000`

### 2.2 5 处违规点现场归位表

| 序号 | 违规文件与行号 | 违规代码 | 归位 Token | 架构原理解析 |
| :---: | :--- | :--- | :--- | :--- |
| 1 | `components/binary-tree/BinaryTreeWorkspace.module.css:119` | `z-index: 160;` | `z-index: var(--z-dropdown);` (300) | 分屏叶子内自带 `isolation: isolate;` 局部层叠上下文，映射为局部 Level 3 绝不污染全局 |
| 2 | `components/binary-tree/BinaryTreeWorkspace.module.css:430` | `z-index: 150;` | `z-index: var(--z-chrome);` (100) | 局部窗格底栏背景层映射为 Level 2 |
| 3 | `components/note-paper/NoteSidebarDrawer.module.css:417` | `z-index: 1000;` (裸写数字) | `z-index: var(--z-modal);` | 替换裸数字为标准 Token 变量，满足 AST 静态检查 |
| 4 | `components/shell/sessionTabDrag.module.css:68` | `z-index: 100000;` (恶性通胀) | `z-index: var(--z-drag-overlay);` (9000) | 拖拽幽灵卡片直接归降至封顶 Level 6，消除十万级魔数 |
| 5 | `components/ui/SmartExpandablePanel/SafeAimEngine.ts:47` | `z-index:2005;` (内联魔数) | `z-index:var(--z-popover);` (500) | 安全三角鼠标避让感应浮层归入 Level 4 |

---

## 3. G-13: 编码完整性与 GBK 误报根除（1 处）

### 3.1 根因穿透（字典误报分析）
经 Unicode 逐字符码点扫描，`BinaryTreeWorkspace.module.css:98` 的原代码如下：
```css
/* 严禁把 top 算在第一行内...否则会漂到窗口右上角遮挡窗口叉号窗控 */
```
该行全部为正规 UTF-8 中文字符，没有任何 mojibake 乱码。门禁 `scripts/check-frontend-convergence.mjs` 之所以报错，是因为其内置的乱码字典数组中错误地包含了常用字 **「窗」 (U+7A97)**，而该行恰好包含 3 个“窗”字，导致判定命中计数超标。

### 3.2 根治方案
1. **门禁字典修正**：在 `scripts/check-frontend-convergence.mjs` 中将常用字「窗」从乱码特征字符数组中剔除；
2. **还原受损历史注释**：在该文件第 55~59 行与 138 行，还原此前被误操作清空的历史原始注释，确保文件语义无损。

---

## 4. 全仓立体化防回归测试矩阵（4-Tier Matrix）

为保证 146 个受影响文件的平稳交割，建立四层防护网：

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier 1: 静态 AST 刚性守门 (npm run check:convergence)                  │
│ • 13 大规则 0 违规拦截，退出码严格为 0                                 │
├────────────────────────────────────────────────────────────────────────┤
│ Tier 2: 样式与光学契约测试 (Vitest Optical Tests)                       │
│ • motion-concentric-contract.test.ts (同心圆角几何断言)               │
│ • a11y-optical-contract.test.ts (7 级 Z-Index 与焦点环 3%~10% 断言)    │
├────────────────────────────────────────────────────────────────────────┤
│ Tier 3: 单元与组件集成回归测试 (Vitest Unit Suite)                     │
│ • 38 套 UI 专项单测 (ChatComposer, NotePaper, Diff, Settings 等)      │
│ • 保证 getByRole('button')、getByTestId、fireEvent 无一处断裂          │
├────────────────────────────────────────────────────────────────────────┤
│ Tier 4: 桌面真实物理宿主验收 (Tauri MCP Socket @ 4000)                │
│ • 坚决弃用 9222 CDP 违规通道，走 Tauri MCP 读取真实视口与 DOM          │
│ • 验收无横向溢出、无图层穿透、无按钮重排与无控制台报错                │
└────────────────────────────────────────────────────────────────────────┘
```
