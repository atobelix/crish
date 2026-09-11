# 01-DIM-01 独立详细实施方案：重复、死层与 Token 碎片收敛

> **战役代号**：`UI-UNIFICATION-REDESIGN`
> **文档性质**：阶段二 独立详细实施方案（DIM-01：基础设施层 SSOT、死变量清剿与字阶规范化）
> **执行依据**：
> - `c:/Software/conex/docs/ui-unification-redesign/00-战役调度总纲与工作区规范.md`（战役调度总纲）
> - `c:/Software/conex/docs/ui-unification-redesign/01-四维度定案与删除面矩阵.md`（四维度定案与基准矩阵）
> - `c:/Software/conex/docs/ui-unification-redesign/analysis/01-dim01-dead-code-and-tokens-analysis.md`（DIM-01 专项深度审计）
> - `c:/Software/conex/docs/ui-unification-redesign/analysis/06-cross-dimension-strategy-b.md`（工程稳健性与双桥过渡协议）
> - `AGENTS.md`（§1 反退避铁律、§3 提交纪律、§7 严禁补丁、§7.1 立体验证、§8 反过度设计硬性红线、§11 CI 治理、§13 输入与焦点态、§14 色彩空间）
> - `.agents/LOGIC_PLAN_NO_RETREAT.md`（纯逻辑规划与效果锁）

---

## 一、方案核心定位与架构原则

### 1.1 DIM-01 在全战役中的战略基石定位
在 `UI-UNIFICATION-REDESIGN` 战役的执行拓扑中，DIM-01（重复、死层与 Token 碎片收敛）处于全生命周期依赖拓扑的最底层：**基础设施单一真源层（Infrastructure SSOT Layer）**。

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               DIM-01 在全战役六阶段拓扑中的奠基定位                                    │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│   [Phase 5: 全量门禁立体收口]  FULL_CHECK_COMMANDS / git diff --stat (Net-Negative ≥ 650) / 契约锁定   │
│               ▲                                                                                        │
│   [Phase 4: 色彩排版与焦点]   DIM-04: 一屏一主色降级 / 16 处 tabular-nums / 柔和焦点环                  │
│               ▲                                                                                        │
│   [Phase 3: 业务裸写换装]     DIM-03: 拔除 8 Button + 4 Input 裸写 / 净删 360+ 行私有 CSS              │
│               ▲                                                                                        │
│   [Phase 2: 原子基座重塑]     DIM-02 + DIM-03: Button scale(0.96) / -2px 光学补正 / Tabs 临界阻尼      │
│               ▲                                                                                        │
│   [Phase 1: Token 设施收敛]   DIM-01 (本方案): 清除 186 死变量 / 7 档字阶 / tokens.css 净删 ≥ 250 行    │
│               ▲                                                                                        │
│   [Phase 0: 契约测试准备]     style-contract.test.ts 棘轮固化 / 待删 AST 扫描 / 双层同源基线检查        │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

若基础设施层的 Token 定义混乱、死层丛生、字阶存在亚像素发虚与缩放断层，上层 DIM-02 的同心几何、DIM-03 的原子组件换装以及 DIM-04 的色彩收敛将如同建立在流沙之上。因此，**DIM-01 的首要使命是彻底洗净样式底板，建立绝对纯粹、严密受护的单一真源（SSOT）**。

### 1.2 四大工程实施原则
1. **单一真理路径（Single Source of Truth, SSOT）**：
   桌面端核心样式变量必须且只能在 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 静态发布，严禁业务组件手写私有别名或脱轨定义。
2. **双层渐进收敛（Two-Phase Token Bridge）**：
   吸纳方案架构 B 的工程防御理念，拒绝单边激进爆破。通过“Phase 1 别名透明重定向 $\to$ 全仓消费点精确替换 $\to$ Phase 2 彻底清除”双桥机制，保障重构期间 CI 快层与样式契约测试全程绿灯。
3. **刚性代码净负产出（Net-Negative LOC）**：
   坚决遵从《反退避铁律》与删除面矩阵，`tokens.css` 必须达成**净消减 ≥ 250 行有效代码**（从 1758 行下沉至 $\le 1508$ 行），全工程拔除 186 个死变量。
4. **契约锁步演进（Lockstep Contract Guard）**：
   变量的清除与规整必须与 [`style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) 同批原子提交，同步维护暗色覆盖集与动态注入白名单，杜绝孤立断言飘红。

---

## 二、“删什么与收敛什么”专章：186 个死变量物理清除代码详单

经对桌面端全量 320+ 个 CSS/TS/TSX 文件展开穷尽式静态语法扫描，`tokens.css`（1758 行，612 个变量）中存在 **171 个外部零引用死变量**（160 个完全孤立，11 个仅内部空转）以及 **15 个多源分裂与已废弃别名**，总计 **186 个死变量**。

以下为按功能领域的完整物理清除方案与精确代码行号对照清单。

```
┌────────────────────────────────────────────────────────────────────────┐
│                     186 个死变量清剿分类统计表                          │
├──────────────────────────────────────┬──────────────────┬──────────────┤
│ 模块类别                             │ 清剿变量数量     │ 物理清除代码 │
├──────────────────────────────────────┼──────────────────┼──────────────┤
│ 1. 极简思考链与横幅死层 (Thought/Banner)    │ 38 个 (30+8)     │ -79 行       │
│ 2. Legacy Diff 兼容别名与残存变量          │ 21 个            │ -48 行       │
│ 3. SmartExpandablePanel (SEP) 脚手架遗留  │ 12 个            │ -26 行       │
│ 4. AI 步骤卡片与 Artifacts 占位死层        │ 21 个            │ -46 行       │
│ 5. 废弃滚动条端点按钮与死尺寸变量          │ 8 个             │ -30 行       │
│ 6. 碎步半像素与死字阶变量 (nano/micro 等)  │ 6 个             │ -14 行       │
│ 7. 废弃用量监控、图表与遮罩死变量          │ 18 个            │ -24 行       │
│ 8. 孤立间距、圆角与动效死变量              │ 14 个            │ -18 行       │
│ 9. 危险色与错误状态分裂别名                │ 15 个            │ -28 行       │
│ 10. 内部自闭合与孤立冗余变量               │ 33 个            │ -38 行       │
├──────────────────────────────────────┼──────────────────┼──────────────┤
│ **全量清剿总计**                      │ **186 个变量**   │ **-351 行**  │
└──────────────────────────────────────┴──────────────────┴──────────────┘
```

---

### 2.1 极简思考链与状态横幅死层（38 个变量 · 净消减 79 行）

#### 现场证据与死因溯源
早期思考链设计采用私有 `--thought-*` Token，状态横幅采用 `--banner-error-*`。当前真实渲染思考链的 [`TimelineThoughtSection.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css) 早已重构为全面消费 `--font-size-sm`、`--text-secondary`、`--brand` 等通用原子 Token；状态横幅也已全面接入统一 Alert/Banner 原子结构。`tokens.css` 中的 38 个定义在全工程中 **0 次调用**，纯属化石残余。

#### 物理清除代码清单
1. **Light 主题块清除范围**：[`tokens.css:703-742`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L703-L742)
2. **Dark 主题块清除范围**：[`tokens.css:1364-1404`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1364-L1404)

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -702,41 +702,0 @@
-  /* --- 4. 极简思考链与状态横幅体系 (Light) --- */
-  --thought-header-bg: color-mix(in srgb, var(--text-primary) 2%, var(--bg-primary));
-  --thought-header-hover-bg: color-mix(in srgb, var(--text-primary) 4%, var(--bg-primary));
-  --thought-header-fg: var(--text-secondary, #555555);
-  --thought-header-hover-fg: var(--text-primary, #111111);
-  --thought-header-font-size: var(--font-size-sm, 13px);
-  --thought-header-line-height: 1.5;
-  --thought-border-color: var(--border-subtle);
-  --thought-indicator-bar: color-mix(in srgb, var(--text-primary) 15%, transparent);
-  --thought-live-title-fg: var(--brand-deep, #059669);
-  --thought-live-dot: var(--brand, #10b981);
-  --thought-live-glow: 0 0 0 2.5px color-mix(in srgb, var(--brand, #10b981) 20%, transparent);
-  --thought-chevron-fg: var(--text-tertiary, #696969);
-  --thought-chevron-hover-fg: var(--text-secondary, #555555);
-  --thought-chevron-color: var(--text-tertiary);
-  --thought-chevron-hover: var(--text-secondary);
-  --thought-rail-color: color-mix(in srgb, var(--text-primary) 10%, transparent);
-  --thought-rail-width: 2px;
-  --thought-body-bg: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-primary));
-  --thought-body-fg: var(--text-secondary, #555555);
-  --thought-body-font-size: var(--font-size-sm, 13px);
-  --thought-body-line-height: 1.65;
-  --thought-time-bg: color-mix(in srgb, var(--text-primary) 5%, transparent);
-  --thought-time-fg: var(--text-tertiary, #696969);
-  --thought-badge-bg: color-mix(in srgb, var(--text-primary) 5%, transparent);
-  --thought-badge-fg: var(--text-tertiary, #696969);
-  --thought-summary-indent: 0.35em;
-  --thought-font-size-meta: 12.5px;
-  --thought-scroll-max-h: 180px;
-  --thought-max-height: 240px;
-  --thought-mask-bg: var(--bg-card, #ffffff);
-
-  --banner-error-bg: color-mix(in srgb, var(--accent-red) 6%, var(--bg-card));
-  --banner-error-border: color-mix(in srgb, var(--accent-red) 22%, transparent);
-  --banner-error-fg: var(--text-primary, #111111);
-  --banner-error-icon: var(--color-error, #ef4444);
-  --banner-error-radius: var(--radius-md, 6px);
-  --banner-error-padding: var(--space-2, 8px) var(--space-3, 12px);
-  --banner-error-gap: var(--space-2, 8px);
-  --banner-error-font-size: var(--font-size-sm, 13px);
@@ -1364,41 +1323,0 @@
-  /* --- 4. 极简思考链与状态横幅体系 (Dark) --- */
-  --thought-header-bg: hsl(0 0% 10%);
-  --thought-header-hover-bg: hsl(0 0% 13%);
-  --thought-header-fg: var(--text-secondary, #a3a3a3);
-  --thought-header-hover-fg: var(--text-primary, #f0f0f0);
-  --thought-header-font-size: var(--font-size-sm, 13px);
-  --thought-header-line-height: 1.5;
-  --thought-border-color: hsl(0 0% 15%);
-  --thought-indicator-bar: hsl(0 0% 25%);
-  --thought-live-title-fg: var(--brand, #10b981);
-  --thought-live-dot: var(--brand, #10b981);
-  --thought-live-glow: 0 0 0 2.5px color-mix(in srgb, var(--brand, #10b981) 25%, transparent);
-  --thought-chevron-fg: var(--text-tertiary, #8f8f8f);
-  --thought-chevron-hover-fg: var(--text-secondary, #a3a3a3);
-  --thought-chevron-color: var(--text-tertiary);
-  --thought-chevron-hover: var(--text-secondary);
-  --thought-rail-color: color-mix(in srgb, var(--text-primary) 14%, transparent);
-  --thought-rail-width: 2px;
-  --thought-body-bg: hsl(0 0% 8%);
-  --thought-body-fg: var(--text-secondary, #a3a3a3);
-  --thought-body-font-size: var(--font-size-sm, 13px);
-  --thought-body-line-height: 1.65;
-  --thought-time-bg: color-mix(in srgb, var(--text-primary) 8%, transparent);
-  --thought-time-fg: var(--text-tertiary, #8f8f8f);
-  --thought-badge-bg: color-mix(in srgb, var(--text-primary) 7%, transparent);
-  --thought-badge-fg: var(--text-tertiary);
-  --thought-summary-indent: 0.35em;
-  --thought-font-size-meta: 12.5px;
-  --thought-scroll-max-h: 180px;
-  --thought-max-height: 240px;
-  --thought-mask-bg: var(--bg-card, hsl(0 0% 11%));
-
-  --banner-error-bg: color-mix(in srgb, var(--accent-red) 12%, var(--bg-card));
-  --banner-error-border: color-mix(in srgb, var(--accent-red) 32%, transparent);
-  --banner-error-fg: var(--text-primary, #f0f0f0);
-  --banner-error-icon: hsl(0 60% 65%);
-  --banner-error-radius: var(--radius-md, 6px);
-  --banner-error-padding: var(--space-2, 8px) var(--space-3, 12px);
-  --banner-error-gap: var(--space-2, 8px);
-  --banner-error-font-size: var(--font-size-sm, 13px);
```

---

### 2.2 Legacy Diff 兼容别名与残存变量（21 个变量 · 净消减 48 行）

#### 现场证据与死因溯源
在 [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css) 中，核心 Diff 渲染已统一收敛为：`--diff-add-bg`, `--diff-del-bg`, `--diff-add-fg`, `--diff-del-fg`, `--diff-add-word-bg`, `--diff-del-word-bg` 等规范变量。`tokens.css:654-666` 标注的 `/* Legacy Diff 兼容映射 */`（包含带有 `-line-`、`-gutter-add-`、`-delete-` 等 21 个别名）在全仓已 **0 处消费**。

#### 物理清除代码清单
1. **Light 主题块清除**：
   - 兼容映射段：[`tokens.css:654-666`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L654-L666)
   - 冗余别名段：[`tokens.css:629, 636, 643, 645`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L629)
   - 废弃尺寸段：[`tokens.css:839-842`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L839-L842)
2. **Dark 主题块清除**：
   - 兼容映射段：[`tokens.css:1316-1329`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1316-L1329)
   - 冗余别名段：[`tokens.css:1291, 1298, 1305, 1307`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1291)

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -629,1 +629,0 @@
-  --diff-add-border: hsl(142 71% 45% / 0.35);
@@ -636,1 +635,0 @@
-  --diff-del-border: hsl(0 84% 60% / 0.35);
@@ -643,1 +641,0 @@
-  --diff-context-fg: var(--text-secondary);
@@ -645,2 +642,0 @@
-  --diff-gutter-text: var(--text-tertiary);
-  --diff-header-height: 34px;
@@ -654,14 +649,0 @@
-  /* Legacy Diff 兼容映射 */
-  --diff-line-add-bg: var(--diff-add-bg);
-  --diff-line-add-border: var(--diff-add-border);
-  --diff-gutter-add-bg: var(--diff-add-gutter-bg);
-  --diff-gutter-add-fg: var(--diff-add-gutter-fg);
-  --diff-word-add-bg: var(--diff-add-word-bg);
-  --diff-line-del-bg: var(--diff-del-bg);
-  --diff-line-del-border: var(--diff-del-border);
-  --diff-gutter-del-bg: var(--diff-del-gutter-bg);
-  --diff-gutter-del-fg: var(--diff-del-gutter-fg);
-  --diff-word-del-bg: var(--diff-del-word-bg);
-  --diff-line-delete-bg: var(--diff-del-bg);
-  --diff-line-delete-border: var(--diff-del-border);
@@ -839,4 +820,0 @@
-  --diff-sidebar-width: 148px;
-  --diff-sidebar-width-md: 120px;
-  --diff-file-chip-min: 96px;
-  --diff-file-chip-min-xs: 80px;
@@ -1291,1 +1268,0 @@
-  --diff-add-border: hsl(142 71% 45% / 0.45);
@@ -1298,1 +1274,0 @@
-  --diff-del-border: hsl(0 84% 60% / 0.45);
@@ -1305,1 +1280,0 @@
-  --diff-context-fg: var(--text-secondary);
@@ -1307,2 +1281,0 @@
-  --diff-gutter-text: var(--text-tertiary);
-  --diff-header-height: 34px;
@@ -1316,14 +1288,0 @@
-  /* Legacy Diff 兼容映射 */
-  --diff-line-add-bg: var(--diff-add-bg);
-  --diff-line-add-border: var(--diff-add-border);
-  --diff-gutter-add-bg: var(--diff-add-gutter-bg);
-  --diff-gutter-add-fg: var(--diff-add-gutter-fg);
-  --diff-word-add-bg: var(--diff-add-word-bg);
-  --diff-line-del-bg: var(--diff-del-bg);
-  --diff-line-del-border: var(--diff-del-border);
-  --diff-gutter-del-bg: var(--diff-del-gutter-bg);
-  --diff-gutter-del-fg: var(--diff-del-gutter-fg);
-  --diff-word-del-bg: var(--diff-del-word-bg);
-  --diff-line-delete-bg: var(--diff-del-bg);
-  --diff-line-delete-border: var(--diff-del-border);
```

---

### 2.3 SmartExpandablePanel (SEP) 脚手架遗留死变量（12 个变量 · 净消减 26 行）

#### 现场证据与死因溯源
组件 [`SmartExpandablePanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css) 与 [`SmartPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css) 实际消费的变量为 `--sep-radius-*`, `--sep-item-*`, `--sep-bg-panel`, `--sep-text-*`。而脚手架阶段预设的 `--sep-font-size-base`, `--sep-font-size-sm`, `--sep-bg-canvas`, `--sep-ease-spring`, `--sep-duration-open` 等 12 个变量从未被组件或业务层引用。

#### 物理清除代码清单
1. **Light 主题块清除**：[`tokens.css:203-205, 207, 209, 211, 215, 223, 225, 234-237`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L203-L237)
2. **Dark 主题块清除**：[`tokens.css:1022, 1024, 1026, 1030, 1038, 1040, 1048-1052`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1022)

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -203,4 +203,0 @@
-  --sep-font-size-base: 13px;
-  --sep-font-size-sm: 11px;
-  --sep-font-size-header: 10.5px;
@@ -207,1 +203,0 @@
-  --sep-bg-canvas: hsl(30 2% 96%);
@@ -209,1 +204,0 @@
-  --sep-bg-panel-solid: #ffffff;
@@ -211,1 +205,0 @@
-  --sep-bg-item-selected: var(--tint-hover);
@@ -215,1 +208,0 @@
-  --sep-border-hover: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%);
@@ -223,1 +215,0 @@
-  --sep-accent-color: hsl(160 84% 39%);
@@ -225,1 +216,0 @@
-  --sep-accent-light: hsl(160 84% 39% / 0.12);
@@ -234,4 +224,0 @@
-  --sep-ease-spring: cubic-bezier(0.22, 1.25, 0.36, 1);
-  --sep-ease-shrink: cubic-bezier(0.4, 0, 1, 1);
-  --sep-duration-open: 0.22s;
-  --sep-duration-close: 0.15s;
@@ -1022,1 +1009,0 @@
-  --sep-bg-canvas: #0c0c0b;
@@ -1024,1 +1010,0 @@
-  --sep-bg-panel-solid: #181715;
@@ -1026,1 +1011,0 @@
-  --sep-bg-item-selected: var(--tint-active);
@@ -1030,1 +1014,0 @@
-  --sep-border-hover: #3d3a35;
@@ -1038,1 +1021,0 @@
-  --sep-accent-color: hsl(160 84% 45%);
@@ -1040,1 +1022,0 @@
-  --sep-accent-light: hsl(160 84% 45% / 0.16);
```

---

### 2.4 AI 步骤卡片、Artifacts 占位与废弃表格变量（21 个变量 · 净消减 46 行）

#### 现场证据与死因溯源
- `--aicard-bg`, `--aicard-border`, `--aicard-header-bg`, `--aicard-title-font-size`, `--aicard-status-pulse-live`：卡片容器已全面收敛至统一原子 Card 容器，上述 5 个变量全工程 0 次引用；
- `--artifact-card-shadow`, `--artifact-header-fg`, `--artifact-header-height`, `--artifact-action-btn-bg`, `--artifact-action-btn-hover`, `--artifact-action-btn-border`, `--artifact-portal-overlay-bg`, `--artifact-portal-blur`, `--artifact-output-max-h`：均属于早期手写 Artifacts 浮层时的未消费占位；
- `--md-table-border-color`, `--md-table-border-subtle`, `--md-table-header-z`, `--md-table-row-bg`, `--md-table-row-zebra-bg`, `--md-table-cell-pad-x`, `--md-table-cell-pad-y`, `--stream-table-active-outline`, `--stream-table-pulse-border`, `--stream-chunk-gap`：流式表格已由标准 Markdown 渲染器统一使用 `--border-subtle` 与原子间距接管。

#### 物理清除代码清单
1. **Light 主题块清除**：[`tokens.css:530, 532, 564-565, 569-570, 579-580, 587, 588, 590, 592-593, 600, 602, 610, 613-617, 623-625, 669, 690-694, 759`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L610-L625)
2. **Dark 主题块清除**：[`tokens.css:1190-1287, 1330, 1352-1356, 1420`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1272-L1287)

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -530,1 +530,0 @@
-  --md-code-inline-bg: color-mix(in srgb, var(--text-primary) 3.5%, var(--bg-card));
@@ -532,1 +531,0 @@
-  --md-code-inline-border: color-mix(in srgb, var(--border-color) 75%, transparent);
@@ -564,2 +562,0 @@
-  --md-list-marker-color: var(--text-tertiary, #696969);
-  --md-list-marker-fade-duration: 120ms;
@@ -569,2 +566,0 @@
-  --md-hr-color: var(--border-subtle);
-  --md-hr-height: 1px;
@@ -579,2 +575,0 @@
-  --md-table-border-color: var(--border-color);
-  --md-table-border-subtle: var(--border-subtle);
@@ -587,2 +582,0 @@
-  --md-table-header-z: 2;
-  --md-table-row-bg: var(--bg-card, #ffffff);
@@ -590,1 +583,0 @@
-  --md-table-row-zebra-bg: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card));
@@ -592,2 +584,0 @@
-  --md-table-cell-pad-x: 12px;
-  --md-table-cell-pad-y: 8px;
@@ -600,1 +591,0 @@
-  --stream-table-active-outline: 1px dashed var(--brand, hsl(160 84% 39%));
@@ -602,1 +592,0 @@
-  --stream-table-pulse-border: color-mix(in srgb, var(--brand) 30%, transparent);
@@ -610,1 +599,0 @@
-  --artifact-card-shadow: var(--shadow-sm);
@@ -613,5 +601,0 @@
-  --artifact-header-fg: var(--text-primary);
-  --artifact-header-height: 34px;
-  --artifact-action-btn-bg: color-mix(in srgb, var(--text-primary) 4%, var(--bg-card));
-  --artifact-action-btn-hover: color-mix(in srgb, var(--text-primary) 8%, var(--bg-card));
-  --artifact-action-btn-border: var(--border-subtle);
@@ -623,3 +606,0 @@
-  --artifact-portal-overlay-bg: hsl(0 0% 0% / 0.45);
-  --artifact-portal-blur: 0px;
-  --artifact-output-max-h: 600px;
@@ -669,1 +649,0 @@
-  --filetree-bg: var(--bg-card, #ffffff);
@@ -690,5 +669,0 @@
-  --aicard-bg: var(--bg-card, #ffffff);
-  --aicard-border: var(--border-color);
-  --aicard-header-bg: color-mix(in srgb, var(--text-primary) 2.5%, var(--bg-card));
-  --aicard-title-font-size: 13.5px;
-  --aicard-status-pulse-live: var(--brand, hsl(160 84% 39%));
@@ -759,1 +733,0 @@
-  --stream-chunk-gap: 0.85em;
```
*(Dark 主题对应行同步清除，净减 23 行代码)*

---

### 2.5 危险色与错误状态分裂别名收敛（彻底消除多源割裂）

#### 现场证据与死因溯源
全仓存在 `--danger-color`、`--accent-danger`、`--text-danger` 与 `--color-error` 四源混用乱象：
- `--danger-color` 在 6 个业务组件中残留 10 处引用；
- `--accent-danger` 在 `ApprovalAskCard.module.css` 中残留 6 处引用；
- 按照 `jakub-skills/better-colors`（*Name primitives by hue, semantics by role*）规范，必须确立：
  - **背景、边框与容器强调色**：统一使用 `--color-error` / `--color-error-bg` / `--color-error-border`；
  - **前景色与文字呈现色**：统一使用 `--text-danger`；
  - 彻底拔除 `--danger-color` 与 `--accent-danger` 2 个历史别名。

#### 业务消费点收敛代码清单
1. **`ApprovalAskCard.module.css` 换装（6 处）**：
   ```diff
   --- a/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
   +++ b/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
   @@ -43,1 +43,1 @@
   -  border-left-color: var(--accent-danger);
   +  border-left-color: var(--color-error);
   @@ -48,1 +48,1 @@
   -  border-left-color: var(--accent-danger);
   +  border-left-color: var(--color-error);
   @@ -52,1 +52,1 @@
   -  border-left-color: var(--accent-danger);
   +  border-left-color: var(--color-error);
   @@ -115,2 +115,2 @@
   -  color: var(--accent-danger);
   -  border-color: color-mix(in srgb, var(--accent-danger) 35%, var(--hairline, var(--border-subtle)));
   +  color: var(--text-danger);
   +  border-color: color-mix(in srgb, var(--color-error) 35%, var(--hairline, var(--border-subtle)));
   @@ -302,1 +302,1 @@
   -  background: var(--accent-danger);
   +  background: var(--color-error);
   ```
2. **`InlineAgentPanel.module.css` 换装（2 处）**：
   ```diff
   @@ -274,1 +274,1 @@
   -  color: var(--danger-color);
   +  color: var(--text-danger);
   @@ -278,1 +278,1 @@
   -  color: var(--danger-color);
   +  color: var(--text-danger);
   ```
3. **`SetupHintBanner.module.css` 换装（2 处）**：
   ```diff
   @@ -74,1 +74,1 @@
   -    var(--danger-color) 22%,
   +    var(--color-error) 22%,
   @@ -80,1 +80,1 @@
   -  color: color-mix(in srgb, var(--danger-color) 70%, var(--text-tertiary));
   +  color: color-mix(in srgb, var(--text-danger) 70%, var(--text-tertiary));
   ```
4. **`PlanGoalRibbons.module.css` 换装（3 处）**：
   ```diff
   @@ -91,1 +91,1 @@
   -  color: var(--danger-color);
   +  color: var(--text-danger);
   @@ -95,2 +95,2 @@
   -  background: color-mix(in srgb, var(--danger-color) 12%, transparent);
   -  color: var(--danger-color);
   +  background: color-mix(in srgb, var(--color-error) 12%, transparent);
   +  color: var(--text-danger);
   ```
5. **`YamlConfigEditorModal.module.css` 换装（2 处）**：
   ```diff
   @@ -185,1 +185,1 @@
   -  color: var(--danger-color, #ef4444);
   +  color: var(--text-danger, #ef4444);
   @@ -269,1 +269,1 @@
   -  color: var(--danger-color, #ef4444);
   +  color: var(--text-danger, #ef4444);
   ```
6. **`SettingsProfileTab.module.css` 换装（1 处）**：
   ```diff
   @@ -8,1 +8,1 @@
   -  color: var(--danger-color);
   +  color: var(--text-danger);
   ```

#### `tokens.css` 别名清除代码
```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -290,2 +290,0 @@
-  --danger-color: var(--color-error);
-  --accent-danger: var(--color-error);
@@ -1088,1 +1086,0 @@
-  --accent-danger: var(--color-error);
```

---

## 三、字阶碎片彻底收敛：13 档碎步到标准 7 档字阶与 19 处迁移详案

### 3.1 碎步半像素缺陷与架构断层分析

#### 次像素抗锯齿灾难（Subpixel Blur）
在 [`tokens.css:472-486`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L472-L486) 中，声明了多达 14 档字阶，充斥着大量的半像素（11.5px, 12.5px, 13.5px）与 1px 碎步（10px, 15px, 17px, 19px）。在 100% 缩放标准显示器（96 DPI）上，物理像素无法被分割，渲染引擎必须通过灰度模糊来模拟半像素宽度，导致文本边缘毛糙发虚。

#### 响应式 UI 缩放断裂（致命证据）
在 `[data-ui-size='small']`（[`tokens.css:1460-1540`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1460-L1540)）与 `[data-ui-size='large']`（[`tokens.css:1542-1610`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1542-L1610)）中：
```css
/* tokens.css:1471-1477 */
[data-ui-size='small'] {
  --font-size-xxs: calc(10px + var(--font-size-adjust, 0px));
  --font-size-xs: calc(11px + var(--font-size-adjust, 0px));
  --font-size-sm: calc(12px + var(--font-size-adjust, 0px));
  --font-size-base: calc(13px + var(--font-size-adjust, 0px));
  --font-size-md: calc(14px + var(--font-size-adjust, 0px));
  --font-size-lg: calc(16px + var(--font-size-adjust, 0px));
  --font-size-xl: calc(18px + var(--font-size-adjust, 0px));
  /* 严重断层：完全遗漏了 nano, micro, xs-plus, sm-plus 等字阶！ */
}
```
这意味着：**当用户在设置中将界面切换为“紧凑”或“宽敞”时，全仓 19 处消费半像素字阶的组件完全无法响应缩放，导致局部排版锁死、比例失调**。

---

### 3.2 标准 7 档字阶设计模型与多尺寸响应式矩阵

依据 `jakub-skills/better-typography`（*A small set of sizes used across a product, deviated from as little as possible*），确立标准 7 档字阶模型：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               标准 7 档字阶与响应式尺寸矩阵 (Typography Matrix)                           │
├──────┬──────────────────┬──────────────┬──────────────┬──────────────┬──────────────────────────────────┤
│ 阶梯 │ Token 变量名     │ Small (紧凑) │ Default (标) │ Large (宽敞) │ 语义角色与典型场景               │
├──────┼──────────────────┼──────────────┼──────────────┼──────────────┼──────────────────────────────────┤
│ **T1**│ `--font-size-xxs`│ **10px**     │ **11px**     │ **12px**     │ 时间戳、最小微标、快捷键 Kbd      │
│ **T2**│ `--font-size-xs` │ **11px**     │ **12px**     │ **13px**     │ 表单辅助说明、状态徽章、Tab 标签 │
│ **T3**│ `--font-size-sm` │ **12px**     │ **13px**     │ **14px**     │ 侧边栏列表项、紧凑按钮、面板次标 │
│ **T4**│ `--font-size-base`│ **13px**    │ **14px**     │ **16px**     │ 标准正文、Markdown 正文、主输入框│
│ **T5**│ `--font-size-md` │ **14px**     │ **16px**     │ **17px**     │ 弹窗副标题、突出卡片标题、大按钮 │
│ **T6**│ `--font-size-lg` │ **16px**     │ **18px**     │ **19px**     │ 弹窗主标题、设置大分类标题       │
│ **T7**│ `--font-size-xl` │ **18px**     │ **22px**     │ **24px**     │ 页面总标题、空状态问候语、大数字 │
└──────┴──────────────────┴──────────────┴──────────────┴──────────────┴──────────────────────────────────┘
```

#### 碎步尺寸与别名归纳规则
- `nano` (10px) $\to$ **`xxs` (11px)**
- `micro` (11.5px) $\to$ **`xxs` (11px)**（其 CSS 回退值原本即多为 11px）
- `xs-plus` (12.5px) $\to$ **`xs` (12px)**（其 CSS 回退值原本即多为 12px）
- `sm-plus` (13.5px) $\to$ **`sm` (13px)**
- `md` (15px) $\to$ **规整为 16px 标准阶**
- `lg` (17px) $\to$ **规整为 18px 标准阶**
- `xl` (19px) / `2xl` (22px) $\to$ **归一为 22px 标准阶**（`--font-size-2xl: var(--font-size-xl)`）
- `chat` (13.5px) $\to$ **0 引用死变量，直接拔除**
- `xxl` (18px) $\to$ **0 引用死变量，直接拔除**

---

### 3.3 19 处存量非标消费点精确迁移代码详案

全仓共有 19 处业务 CSS 消费了待清剿的碎步字阶。以下为 100% 精确的单向替换代码方案：

#### 组 1：`--font-size-nano` (10px) $\to$ `--font-size-xxs` (11px)（共 4 处）

1. **[`ContextInjectionBlock.module.css:95`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L95)**
   ```diff
   --- a/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
   +++ b/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
   @@ -95,1 +95,1 @@
   -  font-size: var(--font-size-nano, 10px);
   +  font-size: var(--font-size-xxs, 11px);
   ```
2. **[`ContextInjectionBlock.module.css:131`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L131)**
   ```diff
   @@ -131,1 +131,1 @@
   -  font-size: var(--font-size-nano, 10px);
   +  font-size: var(--font-size-xxs, 11px);
   ```
3. **[`FilesCard.module.css:739`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L739)**
   ```diff
   --- a/apps/crish-desktop/src/components/files/FilesCard.module.css
   +++ b/apps/crish-desktop/src/components/files/FilesCard.module.css
   @@ -739,1 +739,1 @@
   -  font-size: var(--font-size-nano);
   +  font-size: var(--font-size-xxs);
   ```
4. **[`AppErrorBoundary.module.css:98`](file:///c:/Software/conex/apps/crish-desktop/src/components/AppErrorBoundary.module.css#L98)**
   ```diff
   --- a/apps/crish-desktop/src/components/AppErrorBoundary.module.css
   +++ b/apps/crish-desktop/src/components/AppErrorBoundary.module.css
   @@ -98,1 +98,1 @@
   -  font-size: var(--font-size-nano);
   +  font-size: var(--font-size-xxs);
   ```

---

#### 组 2：`--font-size-micro` (11.5px) $\to$ `--font-size-xxs` (11px)（共 7 处）

5. **[`TiptapSlashMenu.module.css:97`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L97)**
   ```diff
   --- a/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css
   +++ b/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css
   @@ -97,1 +97,1 @@
   -  font-size: var(--font-size-micro);
   +  font-size: var(--font-size-xxs);
   ```
6. **[`TiptapSlashMenu.module.css:107`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L107)**
   ```diff
   @@ -107,1 +107,1 @@
   -  font-size: var(--font-size-micro);
   +  font-size: var(--font-size-xxs);
   ```
7. **[`ContextInjectionBlock.module.css:115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L115)**
   ```diff
   --- a/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
   +++ b/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css
   @@ -115,1 +115,1 @@
   -  font-size: var(--font-size-micro, 11px);
   +  font-size: var(--font-size-xxs, 11px);
   ```
8. **[`ContextInjectionBlock.module.css:233`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L233)**
   ```diff
   @@ -233,1 +233,1 @@
   -  font-size: var(--font-size-micro, 11px);
   +  font-size: var(--font-size-xxs, 11px);
   ```
9. **[`ContextInjectionBlock.module.css:249`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L249)**
   ```diff
   @@ -249,1 +249,1 @@
   -  font-size: var(--font-size-micro, 11px);
   +  font-size: var(--font-size-xxs, 11px);
   ```
10. **[`ContextInjectionBlock.module.css:268`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L268)**
    ```diff
    @@ -268,1 +268,1 @@
    -  font-size: var(--font-size-micro, 11px);
    +  font-size: var(--font-size-xxs, 11px);
    ```
11. **[`SkillsSettingsTab.module.css:639`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L639)**
    ```diff
    --- a/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css
    +++ b/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css
    @@ -639,1 +639,1 @@
    -  font-size: var(--font-size-micro);
    +  font-size: var(--font-size-xxs);
    ```

---

#### 组 3：`--font-size-xs-plus` (12.5px) $\to$ `--font-size-xs` (12px)（共 4 处）

12. **[`LeafToolTabStrip.module.css:88`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L88)**
    ```diff
    --- a/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css
    +++ b/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css
    @@ -88,1 +88,1 @@
    -  font-size: var(--font-size-xs-plus, 12px);
    +  font-size: var(--font-size-xs, 12px);
    ```
13. **[`PaneHeader.module.css:88`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css#L88)**
    ```diff
    --- a/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css
    +++ b/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css
    @@ -88,1 +88,1 @@
    -  font-size: var(--font-size-xs-plus, 12.5px);
    +  font-size: var(--font-size-xs, 12px);
    ```
14. **[`SkillsSettingsTab.module.css:254`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L254)**
    ```diff
    --- a/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css
    +++ b/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css
    @@ -254,1 +254,1 @@
    -  font-size: var(--font-size-xs-plus);
    +  font-size: var(--font-size-xs);
    ```
15. **[`SkillsSettingsTab.module.css:398`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L398)**
    ```diff
    @@ -398,1 +398,1 @@
    -  font-size: var(--font-size-xs-plus);
    +  font-size: var(--font-size-xs);
    ```

---

#### 组 4：`--font-size-sm-plus` (13.5px) $\to$ `--font-size-sm` (13px)（共 4 处）

16. **[`SkillsSettingsTab.module.css:66`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L66)**
    ```diff
    --- a/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css
    +++ b/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css
    @@ -66,1 +66,1 @@
    -  font-size: var(--font-size-sm-plus);
    +  font-size: var(--font-size-sm);
    ```
17. **[`SkillsSettingsTab.module.css:309`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L309)**
    ```diff
    @@ -309,1 +309,1 @@
    -  font-size: var(--font-size-sm-plus);
    +  font-size: var(--font-size-sm);
    ```
18. **[`SkillsSettingsTab.module.css:445`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L445)**
    ```diff
    @@ -445,1 +445,1 @@
    -  font-size: var(--font-size-sm-plus);
    +  font-size: var(--font-size-sm);
    ```
19. **[`SkillsSettingsTab.module.css:656`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L656)**
    ```diff
    @@ -656,1 +656,1 @@
    -  font-size: var(--font-size-sm-plus);
    +  font-size: var(--font-size-sm);
    ```

---

### 3.4 `tokens.css` 字阶重构代码方案

在完成全仓 19 处消费点规整后，`tokens.css` 的字阶体系从 14 档半像素碎片彻底收敛为规范的 7 档标准字阶：

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -468,20 +468,10 @@
-  /*
-   *       ?14
-   * xxs/xs
-   */
+  /* --- 标准 7 档字阶体系 (Jakub Krehel Rational Hierarchy) --- */
   --font-size-adjust: 0px;
   --font-size-xxs: calc(11px + var(--font-size-adjust));
   --font-size-xs: calc(12px + var(--font-size-adjust));
   --font-size-sm: calc(13px + var(--font-size-adjust));
   --font-size-base: calc(14px + var(--font-size-adjust));
-  --font-size-md: calc(15px + var(--font-size-adjust));
-  --font-size-lg: calc(17px + var(--font-size-adjust));
-  --font-size-xl: calc(19px + var(--font-size-adjust));
-  --font-size-nano: calc(10px + var(--font-size-adjust));
-  --font-size-micro: calc(11.5px + var(--font-size-adjust));
-  --font-size-xs-plus: calc(12.5px + var(--font-size-adjust));
-  --font-size-sm-plus: calc(13.5px + var(--font-size-adjust));
-  --font-size-xxl: calc(18px + var(--font-size-adjust));
-  --font-size-2xl: calc(22px + var(--font-size-adjust));
-  --font-size-chat: calc(13.5px + var(--font-size-adjust, 0px));
+  --font-size-md: calc(16px + var(--font-size-adjust));
+  --font-size-lg: calc(18px + var(--font-size-adjust));
+  --font-size-xl: calc(22px + var(--font-size-adjust));
+  --font-size-2xl: var(--font-size-xl);
```

---

## 四、双层渐进收敛协议（Two-Phase Token Bridge）操作准则

为坚决杜绝“重构引发大面积红灯”与“破坏性更新阻断其他 Agent 并行工作”，DIM-01 严格落地方案架构 B 确立的**双层渐进收敛协议（Two-Phase Token Bridge）**。

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              双层渐进收敛协议 (Two-Phase Token Bridge) 工作机制                         │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│   [开始]                                                                                               │
│     │                                                                                                  │
│     ▼                                                                                                  │
│   【Phase 1: 别名桥接与透明重定向】                                                                    │
│     • 在 tokens.css 中将待淘汰的 6 档字阶与危险色别名挂载为 var(--font-size-*) 标准映射                │
│     • 外部零引用死变量（Thought 38个, SEP 12个, Diff 21个）直接物理清除                                │
│     • 效果：存量消费组件维持 100% 运行时可用，CI 持续全绿                                              │
│     │                                                                                                  │
│     ▼                                                                                                  │
│   【中间迁移态: 全仓消费点单向收口】                                                                  │
│     • 执行全仓 19 处碎步字阶单向替换（nano/micro -> xxs, xs-plus -> xs, sm-plus -> sm）                │
│     • 执行全仓 16 处危险色单向替换（danger-color / accent-danger -> color-error / text-danger）        │
│     • 运行自动化扫描脚本：确保旧别名的外部引用计数严格降为 0                                           │
│     │                                                                                                  │
│     ▼                                                                                                  │
│   【Phase 2: 桥接彻底拔除与契约锁定】                                                                  │
│     • 拔除 tokens.css 中全部临时桥接别名                                                               │
│     • 同步更新 style-contract.test.ts 与 a11y-contrast.test.ts 契约断言                                │
│     • 运行全量门禁 FULL_CHECK_COMMANDS，达成净消减 ≥ 250 行有效代码                                    │
│     │                                                                                                  │
│   [完成]                                                                                               │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Phase 1：别名透明重定向映射清单
在 Phase 1 启动时，对于存在外部引用的别名，在 `tokens.css` 中注入别名桥接，严禁直接物理删除：

```css
/* ==========================================================================
   DIM-01 Phase 1 别名桥接层 (Temporary Bridge - 仅在 Phase 1 存活)
   ========================================================================== */
--font-size-nano: var(--font-size-xxs);      /* 10px -> 11px */
--font-size-micro: var(--font-size-xxs);     /* 11.5px -> 11px */
--font-size-xs-plus: var(--font-size-xs);    /* 12.5px -> 12px */
--font-size-sm-plus: var(--font-size-sm);    /* 13.5px -> 13px */
--font-size-chat: var(--font-size-base);     /* 13.5px -> 14px */
--font-size-xxl: var(--font-size-lg);       /* 18px -> 18px */
--danger-color: var(--color-error);          /* 危险色收敛 */
--accent-danger: var(--color-error);         /* 危险色收敛 */
```

### 4.2 Phase 2：彻底拔除时机与操作准则
1. **触发时机硬性判定条件**：
   - 静态扫描指令 `grep -rn "font-size-nano\|font-size-micro\|font-size-xs-plus\|font-size-sm-plus\|danger-color\|accent-danger" src/` 返回结果**仅包含 `tokens.css` 自身的桥接声明行**；
   - 外部业务组件消费计数严格为 0。
2. **原子拔除准则**：
   - 彻底删除 Phase 1 注入的桥接声明行；
   - **严禁跨提交留存**：拔除别名与更新 `style-contract.test.ts` 必须在同一个原子 Git 提交中完成，避免 CI 出现半衰期故障；
   - 杜绝“临时桥接永久化”：在执行流水线中设置拦截脚本，若 Phase 2 结束时仍存在 `--font-size-nano` 等桥接代码，直接阻断构建。

---

## 五、`style-contract.test.ts` 契约同源守护与断言演进

样式契约测试 [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts) 是全仓样式系统质量护栏的核心。在实施 DIM-01 的死代码清除与字阶规整时，必须严格遵守以下契约约束。

### 5.1 色系前缀暗色覆盖断言（Dark Branch Coverage）
- **契约位置**：`style-contract.test.ts:163-180`
- **断言机制**：
  ```ts
  const tokenRe = /--(?:bg|text|border|accent|color|tint|sidebar|control)-[\w-]+\s*:/g;
  const names = [...new Set(lightBlock.match(tokenRe) ?? [])].map(s => s.replace(/:\s*$/, ''));
  const missing = names.filter(name => !DARK_EXCLUDE.has(name) && !darkBlock.includes(`${name}:`));
  expect(missing).toEqual([]);
  ```
- **DIM-01 守护守则**：
  - 若在 Light 主题块删除了任何匹配 `(?:bg|text|border|accent|color|tint|sidebar|control)-` 前缀的变量（如 `--accent-danger`、`--color-text-dim`、`--accent-green-*` 等），**必须在 Dark 主题块中 100% 同步删除**；
  - 严禁单边删除 Light 或单边删除 Dark，否则 `missing` 列表将直接抛出异常断言失败。

### 5.2 动态 `setProperty` 变量静态存在断言（双层同源约束 1）
- **契约位置**：`style-contract.test.ts:352-368`
- **断言机制**：
  扫描 `src/api/themeStore.ts` 与 `src/api/themePersonalization.ts` 中全部 `setProperty('(--[\\w-]+)'` 调用的变量，断言其**必须在 `tokens.css` 静态定义存在**。
- **DIM-01 绝对受保护白名单（严禁误删）**：
  经静态审计，以下由 TypeScript 运行时动态注入的 21 个 Token 享有**绝对免删豁免权**，死代码清理脚本与手工审查必须将其列入安全白名单：
  1. `--font-size-adjust`（字阶缩放基底）
  2. `--accent-green-light-adaptive`
  3. `--accent-red-light-adaptive`
  4. `--bg-primary`
  5. `--bg-secondary`
  6. `--bg-tertiary`
  7. `--bg-card`
  8. `--bg-elevated`
  9. `--shell-chrome-bg`
  10. `--text-primary`
  11. `--text-secondary`
  12. `--text-tertiary`
  13. `--border-color`
  14. `--border-subtle`
  15. `--bg-workspace`
  16. `--shell-inset-bg`
  17. `--control-mix-color`
  18. `--control-soft-bg`
  19. `--control-soft-bg-hover`
  20. `--control-soft-bg-active`
  21. `--composer-bg`

### 5.3 `--ui-text-*` 五连 Token 与对比度契约演进
- **契约位置**：
  - `style-contract.test.ts:133-148`（`--ui-text-* dark 覆盖契约`）
  - `a11y-contrast.test.ts:225-247`（`对比度验收 TEXT_TOKENS / UI_TOKENS`）
- **演进策略**：
  - 在全仓排查中，`--ui-text-*`（`--ui-text-success`, `--ui-text-danger`, `--ui-text-muted`, `--ui-text-info`, `--ui-text-warning`）除了在 `tokens.css:272` 被 `--color-success` 引用外，全仓业务组件 0 处直接消费；
  - 为保持与既有 CI 门禁零冲突，**DIM-01 阶段对 `--ui-text-*` 维持其在 Light 与 Dark 块中的静态定义，严格满足 `style-contract.test.ts:133` 的覆盖断言**；
  - 严禁在未同步修改测试文件的情况下单边拔除 `--ui-text-*`。

### 5.4 棘轮基线保护（Ratchet Baselines）
- **裸混色基线**：`BARE_MIX_BASELINE = 25`（`style-contract.test.ts:189`）
- **`!important` 基线**：`IMPORTANT_BASELINE = 626`（`style-contract.test.ts:335`）
- **守则**：DIM-01 实施期间全仓裸混色与 `!important` 数量只能单调递减或持平，任何新增裸混色直接阻断 CI。

---

## 六、代码净负产出（Net-Negative LOC）刚性量化表

遵循战役定案矩阵，DIM-01 设定了严格的负产出硬指标：**`tokens.css` 净消减有效代码 $\ge 250$ 行**。

### 6.1 `tokens.css` 逐项删除与新增精确测算表

| 代码区块 / 治理项目 | 原始位置 (行号) | 治理动作 | 纯删除行数 | 新增/重构行数 | **净负产出 (Net-LOC)** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **极简思考链与状态横幅** | `703-741`, `1364-1403` | 彻底拔除 Light/Dark 38 个死变量 | **-79 行** | 0 行 | **-79 行** |
| **Legacy Diff 兼容别名** | `629, 636, 654-666, 839-842, 1316-1328` | 彻底拔除 21 个带 `-line-` / `-sidebar-` 别名 | **-48 行** | 0 行 | **-48 行** |
| **SEP 脚手架遗留死层** | `203-237`, `1022-1052` | 拔除未投产动画与尺寸等 12 个死变量 | **-26 行** | 0 行 | **-26 行** |
| **AI 卡片与未消费排版** | `530, 564, 579, 610-625, 690-700, 1272-1362` | 清理 21 个 AICard/Artifacts/Table 占位 | **-46 行** | 0 行 | **-46 行** |
| **废弃滚动条端点按钮** | `415-445`, `1150-1180` | 清理已被 overlay-scrollbar 替代的 webkit 按钮 | **-30 行** | 0 行 | **-30 行** |
| **碎步字阶收敛与规整** | `472-486`, `1471-1477`, `1553-1559` | 删除 6 个碎步与死字阶，规整 7 档标准阶 | **-18 行** | +8 行 | **-10 行** |
| **危险色多源分裂拔除** | `290-291`, `1088` | 彻底清除 `--danger-color` 与 `--accent-danger` | **-5 行** | 0 行 | **-5 行** |
| **孤立自闭合与废弃变量** | `250-265`, `870-890`, `1100-1130` | 清除无外部引用的孤立尺寸、遮罩与间距变量 | **-38 行** | 0 行 | **-38 行** |
| **冗余空行与废弃注释** | 全文多处 | 压缩各死代码块遗留的孤立注释与多余换行 | **-24 行** | 0 行 | **-24 行** |
| **合计** | - | - | **-314 行** | **+8 行** | **-306 行 (净消减)** |

> **验收判定**：`tokens.css` 当前为 1,758 行，实施完成后行数将精确控制在 **$\le 1,452$ 行**，超额达成净消减 $\ge 250$ 行的硬性指标！

---

### 6.2 业务消费点迁移净改动统计表

| 业务文件路径 | 原始消费代码 | 迁移目标代码 | 改动行数 |
| :--- | :--- | :--- | :--- |
| `components/chat-injection/ContextInjectionBlock.module.css` | 6 处 nano / micro | 6 处 xxs (11px) | 6 行规整 |
| `components/files/FilesCard.module.css` | 1 处 nano | 1 处 xxs (11px) | 1 行规整 |
| `components/AppErrorBoundary.module.css` | 1 处 nano | 1 处 xxs (11px) | 1 行规整 |
| `components/chat-composer/TiptapSlashMenu.module.css` | 2 处 micro | 2 处 xxs (11px) | 2 行规整 |
| `components/settings-skills/SkillsSettingsTab.module.css` | 1 处 micro, 2 处 xs-plus, 4 处 sm-plus | 1 处 xxs, 2 处 xs, 4 处 sm | 7 行规整 |
| `components/binary-tree/LeafToolTabStrip.module.css` | 1 处 xs-plus | 1 处 xs (12px) | 1 行规整 |
| `components/binary-tree/PaneHeader.module.css` | 1 处 xs-plus | 1 处 xs (12px) | 1 行规整 |
| `components/agent-card/ApprovalAskCard.module.css` | 6 处 `--accent-danger` | `--color-error` / `--text-danger` | 6 行收敛 |
| `components/agent-card/InlineAgentPanel.module.css` | 2 处 `--danger-color` | `--text-danger` | 2 行收敛 |
| `components/chat-card/SetupHintBanner.module.css` | 2 处 `--danger-color` | `--color-error` / `--text-danger` | 2 行收敛 |
| `components/chat-card/PlanGoalRibbons.module.css` | 3 处 `--danger-color` | `--color-error` / `--text-danger` | 3 行收敛 |
| `components/settings-models/YamlConfigEditorModal.module.css` | 2 处 `--danger-color` | `--text-danger` | 2 行收敛 |
| `components/settings/SettingsProfileTab.module.css` | 1 处 `--danger-color` | `--text-danger` | 1 行收敛 |
| **业务小计** | **19 处字阶 + 16 处危险色** | **100% 收敛至标准 Token** | **35 行规整** |

---

## 七、实施任务分解与执行原子流水线

为了保障修改的严格有序、杜绝 Git 冲突与 CI 瞬态断裂，DIM-01 划分为 5 个原子任务单元（Task Units），构成严格的单向执行流水线：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                DIM-01 原子任务分解流水线 (Task Pipeline)                               │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│   [Task 1: Phase 1 别名桥接与纯死变量拔除]                                                             │
│     ├── 在 tokens.css 注入 Phase 1 字阶与危险色别名桥接                                                 │
│     ├── 物理清除 38 个 Thought/Banner、21 个 Legacy Diff、12 个 SEP 脚手架死变量                       │
│     └── 验证：npx vitest run src/styles/style-contract.test.ts (必须 100% 绿灯)                         │
│               │                                                                                        │
│               ▼                                                                                        │
│   [Task 2: 全仓 19 处碎步字阶消费点规整]                                                               │
│     ├── 执行 ContextInjectionBlock, FilesCard, AppErrorBoundary 等 19 处消费点单向迁移                 │
│     └── 验证：npm run typecheck (确保 CSS Module 类名无断裂)                                           │
│               │                                                                                        │
│               ▼                                                                                        │
│   [Task 3: 全仓 16 处危险色消费点收敛]                                                                 │
│     ├── 执行 ApprovalAskCard, InlineAgentPanel, SetupHintBanner 等 16 处危险色单向收敛                 │
│     └── 验证：全仓检索确认 danger-color 与 accent-danger 外部引用降为 0                                 │
│               │                                                                                        │
│               ▼                                                                                        │
│   [Task 4: Phase 2 桥接拔除与 tokens.css 深度收敛]                                                     │
│     ├── 拔除 tokens.css 全部 Phase 1 临时桥接别名                                                       │
│     ├── 落地 7 档标准字阶定义（md=16px, lg=18px, xl=22px）                                             │
│     ├── 消除冗余空行与废弃注释，实现净消减 ≥ 250 行                                                     │
│     └── 验证：git diff --stat apps/crish-desktop/src/styles/tokens.css                                 │
│               │                                                                                        │
│               ▼                                                                                        │
│   [Task 5: 全量立体门禁验证与收口审计]                                                                 │
│     ├── 执行 style-contract.test.ts 与 a11y-contrast.test.ts                                            │
│     ├── 执行 npm run test:coverage -- --project=unit                                                   │
│     └── 汇总交付改动面，提交主 Agent 统一收口                                                           │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.1 Task 1：Phase 1 别名桥接与纯死变量安全清除
- **目标**：在保障向后兼容的前提下，率先剔除 71 个完全零引用的纯死变量。
- **操作**：
  1. 在 `tokens.css:487` 注入 Phase 1 别名重定向（`--font-size-nano: var(--font-size-xxs)` 等）；
  2. 彻底删除 Light 与 Dark 块中的 38 个 `--thought-*` / `--banner-error-*` 变量；
  3. 彻底删除 21 个 Legacy Diff 兼容别名与 12 个 SEP 脚手架死变量；
  4. 运行 `npx vitest run src/styles/style-contract.test.ts`，确保暗色覆盖断言全绿。

### 7.2 Task 2：全仓 19 处碎步字阶消费点代码规整
- **目标**：彻底消除业务组件中对 `nano`, `micro`, `xs-plus`, `sm-plus` 的依赖。
- **操作**：
  1. 按 §3.3 清单逐一修改 7 个业务 CSS 文件中的 19 处样式定义；
  2. 运行 `npm run check:css-encoding` 确保文件保持 UTF-8 无 BOM 编码；
  3. 运行 `npm run typecheck`。

### 7.3 Task 3：全仓 16 处危险色分裂单向收敛
- **目标**：将 `--danger-color` 与 `--accent-danger` 彻底迁移至 `--color-error` 与 `--text-danger`。
- **操作**：
  1. 按 §2.5 清单修改 6 个业务组件样式文件；
  2. 执行 `git grep "var(--danger-color)"` 与 `git grep "var(--accent-danger)"`，确认全工程业务引用计数严格为 0。

### 7.4 Task 4：Phase 2 别名拔除与 `tokens.css` 终态收敛
- **目标**：彻底拔除临时桥接，完成 7 档标准字阶落地与 `tokens.css` 净负产出验收。
- **操作**：
  1. 从 `tokens.css` 中拔除 Phase 1 注入的全部桥接别名；
  2. 将 `--font-size-md` 改为 16px、`--font-size-lg` 改为 18px、`--font-size-xl` 改为 22px；
  3. 拔除 `--danger-color` 与 `--accent-danger` 定义；
  4. 执行行数统计命令，确认净消减行数 $\ge 250$ 行。

### 7.5 Task 5：全量立体门禁验证与交付
- **目标**：完成全套质量与契约校验，确认零回归。
- **操作**：
  运行本方案第八章规定的全量立体门禁命令集，所有测试 100% 通过后，将工作区改动保留供主 Agent 统一提交。

---

## 八、立体化验证与防回归门禁命令集

依据 `AGENTS.md` §7（严禁补丁、绕过与作弊）与 §7.1（立体验证纪律），在宣布 DIM-01 任务完成前，必须严格依次执行以下立体化验证流程：

### 8.1 第一道防线：快层静态语法与类型验证
```bash
# 1. TypeScript 全仓类型检查（严格 0 错误）
npm run typecheck

# 2. CSS 文件编码检查（严格 UTF-8 无 BOM）
npm run check:css-encoding

# 3. Git 冲突标记扫描（严格 0 冲突残留）
npm run check:conflict-markers
```

### 8.2 第二道防线：样式系统核心契约测试
```bash
# 4. 执行样式契约测试（暗色覆盖、双层同源、圆角、z-index）
npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts

# 5. 执行 WCAG 对比度与语义状态文字测试
npx vitest run apps/crish-desktop/src/styles/a11y-contrast.test.ts

# 6. 执行反变暗防线与悬空 Token 扫描
npx vitest run apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts
```

### 8.3 第三道防线：单元测试回归与覆盖率防线
```bash
# 7. 运行前端快层单元测试与覆盖率门禁
npm run test:coverage -- --project=unit
```

### 8.4 第四道防线：代码净负产出量化核验
```bash
# 8. 统计 tokens.css 的物理行数改动（必须显示 insertions < deletions 且净删 ≥ 250 行）
git diff --stat apps/crish-desktop/src/styles/tokens.css

# 9. 确认全仓无残留碎步字阶引用（必须输出 0 行）
git grep -E "font-size-(nano|micro|xs-plus|sm-plus|chat|xxl)" apps/crish-desktop/src/
```

> **主控交付誓约**：以上 9 条命令必须在真实终端环境中 100% 绿灯跑通。任何报错必须正面穿透根因修复，绝对禁止使用 `--no-verify` 绕过校验！
