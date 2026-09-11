# UI 原子组件库与样式门禁契约调研报告

> **战役工作区**：`docs/layout-token-system/survey/`
> **调研岗位**：UI 原子组件库与样式门禁契约调研员
> **归属任务**：系统性 Token 体系建设战役（第一阶段 · 调研维度 08）
> **调研对象**：Conex / Crish 桌面端 `components/ui/` 原子层组件尺寸与内边距规范、既有样式契约测试体系（`style-contract.test.ts`、`motion-concentric-contract.test.ts`、`a11y-optical-contract.test.ts`）、依赖门禁（`check-ui-layer.mjs`）以及全仓间距 Token（`--space-*`）消费现状与自动化防御机制。

---

## 一、调研背景与输入文件契约

在 Conex / Crish 的前端工程体系中，`apps/crish-desktop/src/components/ui/` 承担着前端分层架构的第一层——「ui 原子层」的核心职责（依据 [`docs/rust-rewrite/plans/PE-05-frontend-componentization-plan.md`](file:///c:/Software/conex/docs/rust-rewrite/plans/PE-05-frontend-componentization-plan.md) 与 [`docs/rust-rewrite/audits/AA-04-frontend-components-styles-review.md`](file:///c:/Software/conex/docs/rust-rewrite/audits/AA-04-frontend-components-styles-review.md) 建设）。

```
components/
├── ui/            ← 第一层：ui 原子层（唯一允许「通用」的基础组件库，全仓交互基元桥）
├── (域目录 28 个)  ← 第二层：业务组件层（通过 ui/index.ts barrel 消费基元，禁止反向依赖）
└── App*/TopBar…    ← 第三层：页面与画布编排层
```

依据 [`apps/crish-desktop/src/components/ui/README.md:16-25`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/README.md#L16-L25)，ui 原子层具有极严格的单向依赖契约：
- **允许依赖**：`react`、`react-dom`、`@radix-ui/*`、`src/styles/tokens.css`、`src/styles/z-index.css` 以及 `ui/` 内部模块相互引用。
- **严禁依赖**：一切业务组件（`components/` 下除 `ui/` 外的一切）、一切 store（zustand）、`hooks/`、`api/`、`services/`。该规则由门禁脚本 [`scripts/check-ui-layer.mjs:22-88`](file:///c:/Software/conex/scripts/check-ui-layer.mjs#L22-L88) 刚性拦截。

然而，本次全景调研深入排查发现：**原子组件库在内边距与尺寸阶梯上存在显著的局部离散化；全仓间距 Token 存在严重的 Fallback 混乱与多源漂移；既有的样式契约测试（`style-contract.test.ts`）因缺乏 CI 快层阻断出现 5 项断言失败回潮；而在布局排版领域，裸像素间距、非法负外边距（Negative Margin）与跨层穿透选择器（`:global(...)`）缺乏自动化守门机制**。

### 1.1 核心输入证据源

本报告严格基于以下物理源码与契约门禁文件展开深入核查与证据链提取：
1. `apps/crish-desktop/src/components/ui/README.md`（ui 原子层分层契约与规范定义）
2. `apps/crish-desktop/src/components/ui/Button/Button.module.css` / `Button.tsx`（4 级尺寸矩阵、伪元素微光、光学补偿）
3. `apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css` / `Dialog.tsx`（3 段式内边距、弹窗基座骨架）
4. `apps/crish-desktop/src/components/ui/Input/Input.module.css` / `Input.tsx`（4 档输入框高度、内边距、清除按钮绝对定位）
5. `apps/crish-desktop/src/components/ui/Menu/Menu.module.css` / `Menu.tsx`（菜单浮层排版、条目内边距、裸像素微距）
6. `apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css`（分段控制器同心圆角几何体系、滑块 padding）
7. `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css`（标签页卡片与线条双模尺寸几何）
8. `apps/crish-desktop/src/components/ui/Select/SelectTrigger.module.css`（下拉触发器尺寸矩阵与圆角）
9. `apps/crish-desktop/src/components/ui/Switch/Switch.module.css`（开关轨道中轴绝对对称留白）
10. `apps/crish-desktop/src/components/ui/Badge/Badge.module.css`（徽标 3 档尺寸与负边距清退钮）
11. `apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css`（提示胶囊内边距与三角负偏移）
12. `apps/crish-desktop/src/styles/tokens.css`（全局 Design Tokens 定义、`:root` 间距刻度与 `data-ui-size` 密度覆盖）
13. `apps/crish-desktop/src/styles/style-contract.test.ts`（既有样式契约测试：z-index、!important、裸混色、button-radius 8px 等）
14. `apps/crish-desktop/src/styles/motion-concentric-contract.test.ts`（同心几何与 Apple 物理动效防回潮契约）
15. `apps/crish-desktop/src/styles/a11y-optical-contract.test.ts`（色彩语义、排版防抖与焦点无障碍护栏契约）
16. `scripts/check-ui-layer.mjs`（ui 原子层单向依赖门禁脚本）
17. `scripts/check-token-consistency.mjs`（设计 Token 一致性与悬空引用门禁脚本）
18. `scripts/check-ui-negative-churn.mjs`（UI 统一重塑死代码清剿刚性验收门禁）

---

## 二、原子组件标准尺寸与内边距阶梯全景

在原子组件库设计中，各组件的高度、横向/纵向内边距（padding）、内部间距（gap）与圆角（border-radius）必须具备高度自洽的数学递进逻辑。下文逐一对各核心基元进行深度解构。

### 2.1 Button：4 级标准化尺寸矩阵与光学微距解构

在 [`apps/crish-desktop/src/components/ui/Button/Button.module.css:7-132`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L7-L132) 中，Button 规范了 4 个标准尺寸档位（`xs` / `sm` / `md` / `lg`），严格通过 CSS 变量在基座 `.button` 上声明并由尺寸类覆盖：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Button 4 级尺寸矩阵解构                          │
├─────────┬────────┬────────────┬─────────────┬─────────────┬────────────┤
│ 尺寸档位 │ 高度(h) │ 横向Padding │ 内部Gap     │ 字体(fs)    │ 圆角(radius)│
├─────────┼────────┼────────────┼─────────────┼─────────────┼────────────┤
│ xs      │ 24px   │ 6px        │ 4px (space1)│ 12px (fs-xs)│ 4px (rd-sm)│
│ sm      │ 28px   │ 10px       │ 6px (sp1_5) │ 13px (fs-sm)│ 7px (btn-rd)│
│ md(默认)│ 32px   │ 12px       │ 6px (sp1_5) │ 14px (fs-bs)│ 7px (btn-rd)│
│ lg      │ 40px   │ 16px       │ 8px (space2)│ 15px (fs-md)│ 8px (rd-lg)│
└─────────┴────────┴────────────┴─────────────┴─────────────┴────────────┘
```

#### 关键实现细节与源码事实：
1. **基座声明（默认 md 档位）**：
   [`Button.module.css:7-14`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L7-L14)：
   ```css
   .button {
     --btn-h: 32px;
     --btn-px: 12px;
     --btn-fs: var(--font-size-base, 14px);
     --btn-radius: var(--button-radius, 7px);
     --btn-icon-size: 16px;
     --btn-gap: var(--space-1_5, 6px);
     ...
     box-sizing: border-box;
     height: var(--btn-h);
     padding: 0 var(--btn-px);
     gap: var(--btn-gap);
   }
   ```
2. **4 档尺寸定义覆盖**：
   - `xs`（[`Button.module.css:93-101`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L93-L101)）：`--btn-h: 24px; --btn-px: 6px; --btn-gap: var(--space-1, 4px); --btn-radius: var(--radius-sm, 4px); --btn-icon-size: 14px;`
   - `sm`（[`Button.module.css:103-111`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L103-L111)）：`--btn-h: 28px; --btn-px: 10px; --btn-gap: var(--space-1_5, 6px); --btn-radius: var(--button-radius, 7px); --btn-icon-size: 14px;`
   - `md`（[`Button.module.css:113-121`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L113-L121)）：`--btn-h: 32px; --btn-px: 12px; --btn-gap: var(--space-1_5, 6px); --btn-radius: var(--button-radius, 7px); --btn-icon-size: 16px;`
   - `lg`（[`Button.module.css:123-131`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L123-L131)）：`--btn-h: 40px; --btn-px: 16px; --btn-gap: var(--space-2, 8px); --btn-radius: var(--radius-lg, 8px); --btn-icon-size: 18px;`
3. **首尾图符 2px 光学内缩补偿（纯 CSS `:has`）**：
   在 [`Button.module.css:270-276`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L270-L276) 中，利用现代 CSS `:has` 实现了无侵入的首尾图符光学对齐，消除图符外边缘留白过大的视觉偏心：
   ```css
   .button:has(> :is(.buttonIcon, .spinner):first-child):has(> .buttonLabel) {
     padding-inline-start: max(0px, calc(var(--btn-px) - 2px));
   }
   .button:has(> .buttonLabel):has(> :is(.buttonIcon, .spinner):last-child) {
     padding-inline-end: max(0px, calc(var(--btn-px) - 2px));
   }
   ```
4. **触控与点击安全热区外延**：
   - 常规紧凑按钮（`xs` / `sm`）（[`Button.module.css:287-293`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L287-L293)）：采用 `inset: -2px 0` 垂直外延 2px，水平不外延，防止行内左右按钮热区冲突重叠。
   - 孤立图标按钮 `touchExpand`（[`Button.module.css:296-314`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L296-L314)）：通过绝对定位居中放大，强制保障 `min-width: 40px; min-height: 40px;` 的 WCAG 触控安全规范。

---

### 2.2 Dialog：3 段式内边距与弹窗骨架网格

在 [`apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css) 中，弹窗面板构建了严格的三段式纵向排版模型：

```
┌────────────────────────────────────────────────────────┐
│ .dialogHeader                                          │
│ padding: var(--space-4) var(--space-4) var(--space-2)  │ (16px 16px 8px)
│ gap: var(--space-2) (8px)                              │
├────────────────────────────────────────────────────────┤
│ .dialogDescription (可选)                               │
│ padding: 0 var(--space-4) var(--space-2)               │ (0 16px 8px)
├────────────────────────────────────────────────────────┤
│ .dialogBody (flex: 1 1 auto, overflow-y: auto)         │
│ padding: var(--space-1) var(--space-4)                 │ (4px 16px)
├────────────────────────────────────────────────────────┤
│ .dialogFooter (border-top: 1px solid var(--hairline))  │
│ padding: var(--space-3) var(--space-4)                 │ (12px 16px)
│ gap: var(--space-2) (8px), justify-content: flex-end   │
└────────────────────────────────────────────────────────┘
```

#### 关键实现细节与源码事实：
1. **Header 内边距与对齐**（[`Dialog.module.css:144-150`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L144-L150)）：
   ```css
   .dialogHeader {
     display: flex;
     align-items: center;
     justify-content: space-between;
     gap: var(--space-2);
     padding: var(--space-4) var(--space-4) var(--space-2);
   }
   ```
   顶部 16px、左右 16px、底部 8px。底部 8px 紧凑收紧，使得标题与 Description/Body 形成视觉亲密性（Proximity）。
2. **Body 内边距**（[`Dialog.module.css:195-200`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L195-L200)）：
   ```css
   .dialogBody {
     padding: var(--space-1) var(--space-4);
     overflow-y: auto;
     color: var(--text-primary);
     flex: 1 1 auto;
   }
   ```
   上下 4px（`--space-1`）、左右 16px（`--space-4`）。垂直方向仅留 4px，把实际间距控制权交给具体业务内容卡片，避免弹窗双重内边距空隙过大。
3. **Footer 内边距与动作栏**（[`Dialog.module.css:202-209`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L202-L209)）：
   ```css
   .dialogFooter {
     display: flex;
     align-items: center;
     justify-content: flex-end;
     gap: var(--space-2);
     padding: var(--space-3) var(--space-4);
     border-top: 1px solid var(--hairline);
   }
   ```
   上下 12px（`--space-3`）、左右 16px（`--space-4`），按钮之间 `gap: var(--space-2)`（8px）。12px 上下衬托出操作按钮的实体卡片感。
4. **视口边界防护与尺寸档位**（[`Dialog.module.css:36-60`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L36-L60)）：
   - 最大边界：`max-width: calc(100vw - var(--space-8)); max-height: calc(100vh - var(--space-8));`（两边各留 16px，总留白 32px 避让视口边缘）。
   - 宽度档位：`sm: 320px`、`md: 480px`、`lg: 640px`，均支持 `--dialog-width` 动态覆盖。
5. **ConfirmDialog 承继契约**（[`ConfirmDialog.tsx:98-118`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ConfirmDialog/ConfirmDialog.tsx#L98-L118)）：
   ConfirmDialog 完全基于 `Dialog` 封装，直接将 `<Button>` 片段注入 `footer` 插槽，100% 继承 Dialog 的 12px 16px 内边距与 8px 按钮间距。

---

### 2.3 Input：内边距阶梯与图符/动作位微米级排版

在 [`apps/crish-desktop/src/components/ui/Input/Input.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.module.css) 中，文本输入框与 Button 保持了高度对齐的 4 档高度矩阵，但在内边距与绝对定位图标上呈现出复杂的微米级微调：

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Input 4 档尺寸规格表                           │
├─────────┬────────┬────────────┬─────────────┬─────────────┬────────────┤
│ 尺寸档位 │ 高度(h) │ 横向Padding │ 清除按钮尺寸 │ 清除按钮Right│ 圆角(radius)│
├─────────┼────────┼────────────┼─────────────┼─────────────┼────────────┤
│ xs      │ 24px   │ 8px (space2)│ 18px × 18px │ 3px (硬编码)│ 4px (rd-sm)│
│ sm      │ 28px   │ 10px(sp2_5) │ 20px × 20px │ 4px (硬编码)│ 6px (rd-md)│
│ md(默认)│ 32px   │ 12px(space3)│ 24px × 24px │ 4px (硬编码)│ 6px (rd-md)│
│ lg      │ 40px   │ 16px(space4)│ 32px × 32px │ 4px (硬编码)│ 8px (rd-lg)│
└─────────┴────────┴────────────┴─────────────┴─────────────┴────────────┘
```

#### 关键实现细节与源码事实：
1. **尺寸与内边距定义**（[`Input.module.css:70-101`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.module.css#L70-L101)）：
   - `xs`: `height: 24px; padding: 0 var(--space-2, 8px); font-size: 12px;`
   - `sm`: `height: 28px; padding: 0 var(--space-2_5, 10px); font-size: 13px;`
   - `md`: `height: 32px; padding: 0 var(--space-3, 12px); font-size: 14px;`
   - `lg`: `height: 40px; padding: 0 var(--space-4, 16px); font-size: 15px;`
   注意横向内边距：Button 的 `xs/sm/md/lg` 是 `6/10/12/16px`，而 Input 的 `xs` 档位横向内边距是 `8px`（比 Button 多 2px，因为文字输入光标需要更充裕的内聚边界）。
2. **前缀图符（Prefix）绝对定位与 Search 变体内避让**：
   - 前缀图符绝对定位（[`Input.module.css:128-135`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.module.css#L128-L135)）：`position: absolute; left: var(--space-2, 8px);`。
   - Search 变体内避让（[`Input.module.css:111-113`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.module.css#L111-L113)）：
     ```css
     .inputShell:has(.inputPrefix) .inputSearch {
       padding-left: var(--space-6, 24px);
     }
     ```
     通过 `24px` 避开 `8px left + 14/16px icon`，提供精准的光学文本起点。
3. **清除动作按钮（Clear Action Button）的裸像素硬编码**：
   在 [`Input.module.css:164-194`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.module.css#L164-L194) 中：
   - `xs` 档位：`width: 18px; height: 18px; right: 3px;`（出现了裸 `3px`！）
   - `sm` 档位：`width: 20px; height: 20px; right: 4px;`（出现了裸 `4px`！）
   - `md` 档位：`width: 24px; height: 24px; right: 4px;`（基底默认 `right: var(--space-1, 4px)`，但覆写类中写了裸 `4px`）
   - `lg` 档位：`width: 32px; height: 32px; right: 4px;`
   这里的 `right: 3px` 与 `right: 4px` 属于未经 Token 化的边缘补偿数值。

---

### 2.4 Menu：弹性浮层与条目内边距

在 [`apps/crish-desktop/src/components/ui/Menu/Menu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css) 中，Menu 作为全仓右键菜单、下拉菜单与选择面板的核心基座，其排版高度依赖局部内边距约束：

```
┌────────────────────────────────────────────────────────┐
│ .menuContent (min-width: 180px, max-width: 340px)      │
│ padding: 6px; (裸像素！)                                │
│ border-radius: var(--sep-radius-outer, 14px);          │
│ gap: 2px; (裸像素！)                                    │
├────────────────────────────────────────────────────────┤
│ .menuTitle                                             │
│ padding: 4px 10px; margin-bottom: 2px; (裸像素！)        │
├────────────────────────────────────────────────────────┤
│ .menuItem (min-height: 32px, height: auto)             │
│ padding: 8px 10px; (裸像素！)                           │
│ gap: var(--space-2, 8px); border-radius: 8px;          │
│   ├─ .menuItemIcon (16px × 16px)                       │
│   ├─ .menuItemContent (gap: 1px)                       │
│   │   ├─ .menuItemLabel (13px)                         │
│   │   └─ .menuItemDescription (11px)                   │
│   └─ .menuItemShortcut (padding: 1px 4px)              │
├────────────────────────────────────────────────────────┤
│ .separator                                             │
│ margin: 3px 6px; (裸像素！)                             │
└────────────────────────────────────────────────────────┘
```

#### 关键实现细节与源码事实：
- **容器浮层内边距**（[`Menu.module.css:25`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L25)）：`padding: 6px;`。未引用 `--space-1_5`，直接写死裸 `6px`。
- **列表间距**（[`Menu.module.css:32`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L32)、[`Line 58`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L58)）：`gap: 2px;`。未引用 `--space-0_5`，写死裸 `2px`。
- **菜单条目内边距**（[`Menu.module.css:69`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L69)）：`padding: 8px 10px; min-height: 32px;`。其中 `8px` 是纵向内边距，`10px` 是横向内边距（对应 `--space-2_5`），但均采用裸像素写死。
- **分割线边距**（[`Menu.module.css:202`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L202)）：`margin: 3px 6px;`。上下 3px 避让，左右 6px 内缩。

---

### 2.5 SegmentedControl 与 Tabs：同心圆角几何体系与卡片滑块

在 [`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css) 与 [`apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css) 中，二者均实现了极高精度的「外壳轨道 + 实体卡片滑块」同心几何圆角设计：

#### 1. SegmentedControl 5 档几何矩阵（[`SegmentedControl.module.css:48-106`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L48-L106)）：
- `xs`：高度 `24px`，轨道内边距 `--seg-pad: 2px;`，外圆角 `6px`，滑块内圆角 `calc(6px - 2px) = 4px`，条目横向 padding `--seg-item-px: var(--space-2, 8px);`。
- `sm`：高度 `28px`，轨道内边距 `--seg-pad: 2px;`，外圆角 `var(--button-radius, 7px)`，滑块内圆角 `5px`，条目横向 padding `--seg-item-px: var(--space-2_5, 10px);`。
- `md`：高度 `32px`，轨道内边距 `--seg-pad: 3px;`，外圆角 `var(--radius-lg, 8px)`，滑块内圆角 `5px`，条目横向 padding `--seg-item-px: var(--space-3, 12px);`。
- `lg`：高度 `38px`（**非 40px**），轨道内边距 `--seg-pad: 3px;`，外圆角 `10px`，滑块内圆角 `7px`，条目横向 padding `--seg-item-px: var(--space-4, 16px);`。
- `panel`（设置面板专属）：高度 `36px`，轨道内边距 `--seg-pad: 3px;`，外圆角 `14px`，滑块内圆角 `11px`（同心大圆角），条目横向 padding `--seg-item-px: 14px;`（裸像素！）。

#### 2. 同心圆角数学契约与滑块定位：
在 [`SegmentedControl.module.css:110-124`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L110-L124) 中，滑块不是通过 flex 撑开，而是通过绝对定位 `top: var(--seg-pad); bottom: var(--seg-pad);` 紧密贴合外轨道的内部边界：
```css
.activeSlider {
  position: absolute;
  top: var(--seg-pad);
  bottom: var(--seg-pad);
  left: 0;
  border-radius: var(--seg-inner-radius);
  background-color: var(--seg-slider-bg, var(--bg-card));
  border: none;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--shadow-color) 6%, transparent);
}
```
这种设计确保了无论外框尺寸如何变化，滑块与轨道四周始终保持严格对称的等距留白（`2px` 或 `3px`），彻底消除了因边框描边累加造成的亚像素偏心。

---

### 2.6 全原子组件尺寸与内边距一致性矩阵对比

对 `ui/` 目录下全部原子组件的尺寸阶梯与内边距定义进行横向对比，可以清晰揭示出整个组件库在标准化进程中的断层与局部不一致：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Conex UI 全原子组件尺寸与内边距全景矩阵                          │
├───────────────────┬──────────────┬──────────────┬──────────────┬──────────────┬────────┤
│ 组件名             │ xs 档位      │ sm 档位      │ md 档位(默认) │ lg 档位      │ 专用档 │
├───────────────────┼──────────────┼──────────────┼──────────────┼──────────────┼────────┤
│ Button            │ 24px / pad 6 │ 28px / pad 10│ 32px / pad 12│ 40px / pad 16│ -      │
│ Input             │ 24px / pad 8 │ 28px / pad 10│ 32px / pad 12│ 40px / pad 16│ -      │
│ Select (Trigger)  │ -            │ 28px / pad 8*│ 32px / pad 10│ 38px* / pad 12│ -      │
│ SegmentedControl  │ 24px / pad 8 │ 28px / pad 10│ 32px / pad 12│ 38px* / pad 16│36px/14*│
│ Tabs              │ 24px / pad 8 │ 28px / pad 10│ 32px / pad 12│ 38px* / pad 16│ -      │
│ Switch (Track)    │ -            │ 18px×30px    │ 22px×38px    │ 26px×46px    │ -      │
│ Badge             │ 18px / pad 5*│ 20px / pad 6 │ 24px / pad 8 │ -            │ -      │
│ Tooltip           │ -            │ -            │ pad 4px 10px │ -            │ -      │
│ Dialog            │ -            │ 320px 宽     │ 480px 宽     │ 640px 宽     │全屏100%│
└───────────────────┴──────────────┴──────────────┴──────────────┴──────────────┴────────┘
（注：带 * 者表示与基础阶梯发生离散偏差或使用了裸像素）
```

#### 🚨 核心断层与偏差发现：
1. **`lg` 档位高度的三轨分裂（40px vs 38px vs 36px）**：
   - `Button` 与 `Input` 将 `lg` 档位定义为 **40px**（内边距 16px）；
   - `SegmentedControl`、`SelectTrigger` 与 `Tabs` 将 `lg` 档位定义为 **38px**；
   - 而全局 Design Tokens [`tokens.css:639`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L639) 中定义的 `--control-height-lg` 却是 **36px**！
   - 这意味着当页面中将 Button 与 SegmentedControl 或 Select 同时设置为 `lg` 并在 Flex 容器中横向并排时，会出现 `40px` 与 `38px` 的 2px 物理错位，破坏中轴对齐！
2. **`sm` 档位 Select 与 Button 的内边距错位（8px vs 10px）**：
   - `Button` 与 `Input` 的 `sm` 档位横向 padding 为 `10px`（`var(--space-2_5)`）；
   - 但 `SelectTrigger.module.css:48` 中 `sm` 档位横向 padding 却硬编码为 `padding: 0 8px;`，导致两者混排时视觉重心不一致。
3. **Badge 档位高度的自成一体（18/20/24px）**：
   - Badge 的 `md` 档位高度为 24px，恰好等于 Button/Input 的 `xs` 档位高度，但在命名上容易引起消费者混淆。

---

## 三、Fallback 混乱与多源漂移根因剖析

在全仓 CSS 与 TSX 样式中，间距变量的使用存在大面积的 Fallback 不一致现象。最典型的证据就是针对同一 `--space-2` 变量，存在以下截然不同的写法：
- `var(--space-2, 8px)`
- `var(--space-2, 6px)`
- `var(--space-2, 5px)`
- `var(--space-2)`（无 fallback）

### 3.1 真实代码证据链（全仓典型事实）

#### 证据 1：`var(--space-2, 6px)` 错误认知
- [`apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css:500`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css#L500)：
  ```css
  .inlineAgentComposerWrap {
    padding: var(--space-2, 6px);
    width: 100%;
  }
  ```
- [`apps/crish-desktop/src/components/sidebar/SidebarNav.module.css:125`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css#L125)：
  ```css
  .sidebarNavGroup {
    gap: var(--space-2, 6px);
  }
  ```
- [`apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.module.css:84`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.module.css#L84)：
  ```css
  .drawerHeader {
    gap: var(--space-2, 6px);
  }
  ```

#### 证据 2：`var(--space-2, 5px)` 密度档位残留
- [`apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css:508`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css#L508)：
  ```css
  .inlineAgentComposerWrapDense {
    padding: var(--space-1, 4px) var(--space-2, 5px) var(--space-2, 5px);
  }
  ```

#### 证据 3：`var(--space-2, 8px)` 标准定义
- [`apps/crish-desktop/src/components/chat-message/MessageContent.module.css:78`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message/MessageContent.module.css#L78)：
  ```css
  .messageActions {
    gap: var(--space-2, 8px);
  }
  ```
- [`apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css:215-216`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L215-L216)：
  ```css
  .toolCallHeader {
    gap: var(--space-2, 8px);
    padding: var(--space-2, 8px) var(--space-3, 12px);
  }
  ```

#### 证据 4：无 Fallback 裸引用
- [`apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css:148`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L148)：
  ```css
  .dialogHeader {
    gap: var(--space-2);
  }
  ```
- [`apps/crish-desktop/src/components/diff/DiffCard.module.css:147`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L147)：
  ```css
  .diffHeader {
    gap: var(--space-2);
  }
  ```

---

### 3.2 深度归因：为何会有大量不一致的 Fallback？

通过对仓库历史架构与 Token 定义演进的穿透分析，归纳出以下 4 大底层根因：

#### 根因 1：`tokens.css` 中「密度齿轮（Density Gears）」对 `--space-*` 的覆写机制
在 [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中，存在全局基础档与尺寸齿轮档的两套定义：
- **默认 `:root` 基础档**（[`tokens.css:645-656`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L645-L656)）：
  ```css
  --space-0_5: 2px;
  --space-1: 4px;
  --space-1_5: 6px;
  --space-2: 8px;
  --space-2_5: 10px;
  --space-3: 12px;
  --space-3_5: 14px;
  --space-4: 16px;
  ```
- **`[data-ui-size='small']` 紧凑齿轮**（[`tokens.css:1244-1254`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1244-L1254)）：
  ```css
  [data-ui-size='small'] {
    --space-0_5: 2px;
    --space-1: 3px;
    --space-1_5: 4px;
    --space-2: 5px;   /* <--- 注意这里！--space-2 被重定义为 5px！ */
    --space-2_5: 6px;
    --space-3: 6px;
    --space-4: 10px;
  }
  ```
**机制冲突**：当开发者在编写某个紧凑视图（如 `InlineAgentPanel` 的 dense 模式）时，通过浏览器审查元素，查看到在 `small` 齿轮下计算样式为 `5px`，于是就误将 `5px` 作为 fallback 写入了代码中（`var(--space-2, 5px)`）。这从源头上破坏了 fallback 作为「静态默认基线」的意义。

#### 根因 2：开发者心智模型的离散与代际混淆
- **心智 A（4px 线性乘数）**：将 `--space-N` 理解为 $N \times 4\text{px}$（1=4px, 2=8px, 3=12px, 4=16px）。这是系统的主流预期。
- **心智 B（混淆小数半档）**：系统引入了 `--space-1_5: 6px;`。很多开发者误以为 `--space-2` 对应 6px，或者误以为 2 是第 3 个递增档位（2px -> 4px -> 6px），从而凭直觉写下了 `var(--space-2, 6px)`。
- **心智 C（随意兜底）**：部分开发者将 fallback 视作「当前组件在特定视觉走查下的特调值」，认为写 `var(--space-2, 6px)` 就能让它表现为 6px，而忽略了在正常运行时 CSS 变量会强行覆盖 fallback。

#### 根因 3：CSS 层叠假象与「代偿性负外边距」恶性循环
这是最严重的工程毒点：
1. 开发者写下了 `padding: var(--space-2, 6px);`，心理预期是希望得到 6px 内边距；
2. 但在真实浏览器运行时，`:root` 中已经定义了 `--space-2: 8px;`，因此 **fallback `6px` 根本不会生效，浏览器实际渲染的是 `8px`**！
3. 开发者在屏幕上观察发现间距偏大（多了 2px），但由于不清楚为什么明明写了 6px 却呈现 8px，便开始使用代偿补丁：在子元素上增加 `margin-top: -2px;` 或者添加内联微调！
4. 这种「假 fallback -> 实际过大 -> 产生负 margin 补偿」的链路是全仓负外边距泛滥的直接诱因。

#### 根因 4：缺乏静态 AST 契约门禁拦截
在现有的 CI 检查脚本中，`scripts/check-token-consistency.mjs` 仅检查了 `var()` 引用的 token 是否在 CSS/JS 中定义（防 undefined_refs），但**完全没有检查 fallback 的值是否与 `:root` 静态真源匹配**！这导致随意乱填 fallback 的代码能够顺畅通过 CI。

---

## 四、现有样式契约测试体系经验借鉴与现状核查

为了防止样式退化，Conex / Crish 在历史战役中建立了 3 套核心契约测试：
- [`apps/crish-desktop/src/styles/style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts)
- [`apps/crish-desktop/src/styles/motion-concentric-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/motion-concentric-contract.test.ts)
- [`apps/crish-desktop/src/styles/a11y-optical-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/a11y-optical-contract.test.ts)

### 4.1 现有契约测试的防御策略与技术特征

现有契约测试不依赖庞大笨重的浏览器渲染，而是采用了 **基于文件系统（fs）遍历 + 正则/AST 静态断言 + 棘轮基线（Ratchet Baseline）** 的轻量高效机制：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        现有样式契约测试技术架构                        │
├───────────────────┬────────────────────────────────────────────────────┤
│ 契约维度          │ 核心断言与防御策略                                 │
├───────────────────┼────────────────────────────────────────────────────┤
│ z-index 治理      │ 正则扫描特定文件禁裸数字；必须使用 var(--z-*) 档位；│
│ (F7-F14)          │ 彻底切除废弃手写浮层（.filesOpenMenu 等）           │
├───────────────────┼────────────────────────────────────────────────────┤
│ 暗色模式覆盖      │ dark 块内必须重新定义所有 --ui-text-* 与色彩前缀   │
│ (F7-F27)          │ 变量，禁止暗色模式无声明导致对比度坍塌              │
├───────────────────┼────────────────────────────────────────────────────┤
│ 裸混色棘轮        │ 扫描全仓 color-mix(in srgb, var(--text-primary) %) │
│ (Ratchet Guard)   │ 限制消费点总量 <= 基线（原基线 25），只降不增      │
├───────────────────┼────────────────────────────────────────────────────┤
│ 极端圆角限制      │ 封禁 border-radius: 999px（<= 62 处）与 99999      │
│ (Surface Tokens)  │ （仅白名单 ChatComposer autofill 放行）            │
├───────────────────┼────────────────────────────────────────────────────┤
│ 滚动条规范        │ 禁名 shell-scrollbar.css；强制走 overlay-scrollbar;│
│ (Overlay Scroll)  │ 浮层组件与 Menu 严禁声明 scrollbar-width (禁三角)  │
├───────────────────┼────────────────────────────────────────────────────┤
│ !important 递减锁 │ 统计全仓 !important 总量 <= 626（reduced-motion豁免│
├───────────────────┼────────────────────────────────────────────────────┤
│ 双层同源协议      │ JS themeStore 注入的每个 token 必须在 CSS 中有静态 │
│ (Dual-Layer SSOT) │ 定义；固定值双源百分比一致性（4%/4%/8% vs 5%/6.5%）│
├───────────────────┼────────────────────────────────────────────────────┤
│ 奇数/亚像素圆角   │ 封杀 3px/5px/7px/9px/11px/3.5px 裸圆角（棘轮 19 处）│
├───────────────────┼────────────────────────────────────────────────────┤
│ 物理动效防过冲    │ 拦截 cubic-bezier y2 > 1.05（彻底封杀 1.5 弹性晃荡）│
├───────────────────┼────────────────────────────────────────────────────┤
│ A11y 焦点与数字   │ IconButton 强制 aria-label；16 处注入 tabular-nums;│
│ (A11y Optical)    │ :focus-visible 严禁 outline:none 无替代与粗黑硬线  │
└───────────────────┴────────────────────────────────────────────────────┘
```

---

### 4.2 现场真实运行核查：5 项契约断言失败现场深度解剖

在本次调研中，我们通过实机运行了 `style-contract.test.ts`（`npx vitest run src/styles/style-contract.test.ts`），**令人震惊地发现了 5 项断言失败（5 failed | 23 passed）**！

这为本次战役提供了极高价值的现场警示：**如果契约测试没有接入 CI 快层门禁作为阻塞性门锁，代码库在多 Agent 与日常开发迭代中会以极快的速度发生契约退化与回潮！**

#### 失败 1：暗色主题块缺少 `--ui-text-danger` 重新定义
- **断言报错**：
  `AssertionError: dark 块应定义 --ui-text-danger: expected 'html[data-theme=\'dark\'] {\r\n...' to contain '--ui-text-danger:'`
- **现场分析**：
  在 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 的 `html[data-theme='dark']` 块中，重新定义了 `--ui-text-success`、`--ui-text-muted` 等，但在近期的样式重构中，`--ui-text-danger:` 被意外遗漏或更名，导致暗色模式下危险文字降级引用亮色值，对比度不足。

#### 失败 2：全仓裸混色消费点发生严重通胀（从 25 处恶化至 53 处）
- **断言报错**：
  `AssertionError: 裸混色消费点 53 处超过基线 25: expected 53 to be less than or equal to 25`
- **现场分析**：
  `BARE_MIX_BASELINE = 25` 是之前战役锁定的棘轮上限。然而，在后续的业务开发与局部 UI 修复中，由于缺乏预提交拦截，各模块又随意添加了 28 处类似 `color-mix(in srgb, var(--text-primary) 6%, transparent)` 的裸混色，导致违规总量翻倍（53 处）！

#### 失败 3：themeStore 动态注入了 4 个静态未声明的幽灵 Token
- **断言报错**：
  `AssertionError: 注入但无静态定义：--accent-green-light-adaptive, --accent-red-light-adaptive, --bg-paper, --shell-inset-bg: expected [ …(4) ] to deeply equal []`
- **现场分析**：
  前端在 [`themeStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themeStore.ts) 或 [`themePersonalization.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePersonalization.ts) 中通过 `setProperty()` 动态注入了 `--accent-green-light-adaptive`、`--accent-red-light-adaptive`、`--bg-paper` 和 `--shell-inset-bg`，然而这 4 个变量在 [`styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中**根本没有静态声明**，直接撕裂了「双层同源协议」的第一约束（注入名 ∈ 静态名）！

#### 失败 4 & 失败 5：按钮圆角 8px 契约在原子层全面失守
- **断言报错 4**：
  `AssertionError: expected ':root,...' to match /--button-radius:\s*8px/`
- **断言报错 5**：
  `AssertionError: expected 'Button.module.css...' to contain '--btn-radius: var(--button-radius, 8px)'`
- **现场分析**：
  契约原本要求全站按钮圆角默认档锁定为 `8px`。然而核查源码发现：
  1. [`Button.module.css:11`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L11)、[`Line 108`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L108)、[`Line 118`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L118) 中被改成了：`--btn-radius: var(--button-radius, 7px);`（回退为 7px）；
  2. [`tokens.css:378`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L378) 中定义被改写成了：`--button-radius: var(--radius-btn);`；
  3. 这导致按钮默认圆角在 7px 与 8px 之间摇摆漂移。

---

## 五、布局/间距 Token 守护门禁规划

基于前述对原子组件尺寸阶梯、Fallback 漂移以及现有契约测试漏洞的深度调研，新布局 Token 体系必须建设更加刚性、立体的自动化守护门禁，彻底终结「边修边退化」的恶性循环。

### 5.1 门禁分层防御体系设计

新门禁系统应采取「CI 静态脚本拦截（快层） + Vitest 契约测试（中层）」的双层守门体系：
1. **快层（Git Hook / CI Lint）**：执行 `node scripts/check-layout-tokens.mjs`，执行时间 < 500ms，在提交与 PR 时进行刚性阻断；
2. **中层（Vitest Integration Suite）**：执行 `src/styles/layout-contract.test.ts`，纳入 `npm run test` 与 CI 每日全量构建。

```
┌────────────────────────────────────────────────────────┐
│               新布局 Token 体系守门流水线                │
├────────────────────────────────────────────────────────┤
│ 1. 裸像素间距拦截器 (Bare Pixel Spacing Interceptor)    │
│    - 扫描 margin / padding / gap 中的裸数字            │
│    - 封杀 6px, 10px, 14px, 18px 等未 Token 化数值      │
├────────────────────────────────────────────────────────┤
│ 2. 非法负外边距防护网 (Illegal Negative Margin Guard)   │
│    - 拦截所有 > 4px 的负 margin (如 -46px, -38px, -10px)│
│    - 仅放行 -1px 发丝缝隙与 -2px 触控/光学微调白名单   │
├────────────────────────────────────────────────────────┤
│ 3. 跨层穿透选择器守卫 (Anti-Penetration Guard)          │
│    - 拦截 module.css 中对子组件的 :global(button) 穿透 │
│    - 强制推行 Component Slots 或 CSS Props 架构         │
├────────────────────────────────────────────────────────┤
│ 4. Fallback 单源校验器 (Fallback SSOT Validator)        │
│    - 扫描全部 var(--space-N, fallback)                  │
│    - 强制校验 fallback 必须与 :root 定义严格等价       │
└────────────────────────────────────────────────────────┘
```

---

### 5.2 拦截规则 1：裸像素间距刚性拦截（Bare Pixel Guard）

#### 治理目标：
禁止在组件样式中随意书写裸像素间距，强制将离散数值收敛到标准 Token 标尺。

#### 规则定义与 AST 扫描逻辑：
- **监控属性**：`margin`, `margin-top`, `margin-bottom`, `margin-left`, `margin-right`, `padding`, `padding-top`, `padding-bottom`, `padding-left`, `padding-right`, `gap`, `row-gap`, `column-gap`。
- **违规判定**：
  属性值中包含裸像素数字（如 `6px`, `10px`, `14px`, `18px`, `22px` 等非 0/1px/2px 的裸数值），且未被 `var(--space-*)` 或 `var(--control-*)` 包裹。
- **安全放行白名单（Whitelisted Primitives）**：
  1. `0` / `0px`：清除外边距；
  2. `1px` / `2px`：边框发丝贴合与亚像素对齐；
  3. `tokens.css`：Token 本身的定义行（匹配 `/^\s*--[\w-]+:/`）；
  4. 绝对定位偏移（`top`, `left`, `right`, `bottom` 专有属性不归属于间距门禁，但需归入定位门禁）。

---

### 5.3 拦截规则 2：非法负外边距禁绝机制（Negative Margin Defense）

#### 治理目标：
根除通过负 margin 向上/向下暴力拉扯布局的「脏补丁」，恢复正常的文档流与 Flexbox/Grid 几何计算。

#### 全仓典型负 Margin 负面案例清单：
1. [`apps/crish-desktop/src/components/chat-message-list/ChatScrollFloorSlot.module.css:30`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatScrollFloorSlot.module.css#L30)：
   `margin-top: -46px;`（为了让浮钮不占高度，强行反向抽离 46px）；
2. [`apps/crish-desktop/src/components/chat-card/UnitChromeActions.module.css:10`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.module.css#L10)：
   `margin-bottom: -38px;`（顶栏吸顶覆盖，强行负边距拉起下方内容 38px）；
3. [`apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css:27`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css#L27)：
   `margin-bottom: -10px;`；
4. [`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:331`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L331)：
   `margin-bottom: -10px;`；
5. [`apps/crish-desktop/src/components/ui/Slider/Slider.module.css:60-61`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Slider/Slider.module.css#L60-L61)：
   `margin-top: -6px; margin-left: -6px;`。

#### 拦截断言规范：
- **核心断言**：在全部 `.module.css` 与 TSX 内联样式中，任何负外边距（`margin*: -Npx`）其绝对值不得 $> 2\text{px}$。
- **合法例外白名单（Strict Minimal Whitelist）**：
  1. `margin-left: -1px;`：中间分割线不占位无缝贴合（如 `ComposerFusedTrigger.module.css:142`）；
  2. `margin-right: -2px;`：Badge 清除按钮外缘对齐补偿（如 `Badge.module.css:133`）；
  3. `inset: -2px 0;`：按钮垂直触控热区轻量外延（如 `Button.module.css:291`）。
- **重构引导方案**：
  所有大尺寸负 margin 必须改为采用原生布局手段：
  - 吸顶覆盖层（如 `UnitChromeActions` 38px）：改为绝对定位 `position: absolute; top: 0; pointer-events: none;`，下方内容设置正常的 `padding-top: 38px;`；
  - 零高度吸底卡槽（如 `ChatScrollFloorSlot` -46px）：外层容器设 `height: 0; overflow: visible;`，子元素通过 `transform: translateY(-100%);` 物理位移，不再篡改文档流盒模型。

---

### 5.4 拦截规则 3：跨层穿透选择器阻断（Anti-Penetration Guard）

#### 治理目标：
彻底消灭外部父组件通过 `:global(...)` 深度穿透子组件内部 DOM 并粗暴重写边距的恶劣现象，捍卫组件独立封装性。

#### 全仓典型穿透案例事实：
1. [`apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css:27-132`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css#L27-L132)：
   包含多达 24 处深度穿透规则，如 `.prefix :global(button)`、`.left :global(button.model-badge-btn)`、`.capsule :global(button[data-testid='...'])`，跨越 3 层容器强行修改内部按钮的 padding 与 border；
2. [`apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.module.css:13-147`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.module.css#L13-L147)：
   `.toolbar .segment :global(button)`、`.actions :global(button)`，从上层强行改写分段项与操作按钮内部样式；
3. [`apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css:517-535`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css#L517-L535)：
   `.inlineAgentComposerWrap :global(.input-container)`、`.inlineAgent :global(.approval-card-btn)`，从外层穿透破坏审批卡片与输入容器。

#### 拦截断言规范：
- **静态扫描**：在任何非全局样式文件（即除 `index.css`, `tokens.css`, `design-system.css`, `reduced-motion.css` 之外的全部 `*.module.css`）中，**严禁使用含有子元素类型或类名穿透的选择器**，如 `:global(button)`、`:global(.input-container)`。
- **架构替代方案**：
  父组件若需定制子组件间距或排版，仅允许以下两种 O(1) 原生方式：
  1. **通过原子组件声明的 API 插槽（Props）**：如 `Button` 的 `size="xs"`、`bare={true}`、`className={styles.myOverride}`；
  2. **通过 CSS 局部上下文变量（CSS Properties）**：如父容器定义 `--btn-h: 28px; --btn-px: 8px;`，子组件原生消费。

---

### 5.5 拦截规则 4：Fallback 单源校验与清洗（Fallback SSOT Guard）

#### 治理目标：
消除 `var(--space-2, 6px)` 与 `var(--space-2, 5px)` 等离散漂移，确立 `:root` 静态真源的绝对权威。

#### 静态校验与自动修复逻辑：
1. **建立 Token 静态默认值字典（SSOT Table）**：
   从 `tokens.css` `:root` 中自动提取所有 `--space-*` 的基础定义值：
   ```json
   {
     "--space-0_5": "2px",
     "--space-1": "4px",
     "--space-1_5": "6px",
     "--space-2": "8px",
     "--space-2_5": "10px",
     "--space-3": "12px",
     "--space-3_5": "14px",
     "--space-4": "16px",
     "--space-5": "20px",
     "--space-6": "24px",
     "--space-8": "32px",
     "--space-10": "40px"
   }
   ```
2. **扫描与校验断言**：
   正则解析代码中全部 `var\((--space-[\w_]+)\s*,\s*([^)]+)\)`：
   - 提取参数 1（变量名）与参数 2（fallback 值）；
   - 若参数 2 存在，且 `clean(参数2) !== SSOT_Table[变量名]`：
     **立即报错拦截**！例：`var(--space-2, 6px) FAIL: --space-2 的法定默认值为 8px，禁止传入 6px！`
3. **终极收敛目标（无 Fallback 纯净化）**：
   在第二阶段方案中，全面推进去 fallback 化：由于 Conex 桌面端为本地独立打包的 Tauri 应用，`tokens.css` 必然由 `index.css` 全局导入，不存在跨网络 CDN 丢失 CSS 的场景。全局统一精简为 `var(--space-2)`，彻底消除代码体积冗余与心智负担。

---

### 5.6 渐进式实施策略（Ratchet 演进时序）

遵循 Conex 架构治理惯例（如 `check-token-consistency.mjs` 与 `check-ui-negative-churn.mjs`），不能一刀切导致全仓构建瘫痪，必须采用**渐进式棘轮基线机制（Ratchet Guard）**：

```
【Phase 0: 存量基线快照（BATCH-00）】
  ├── 扫描全仓当前存量违规（如 53 处裸混色、存量裸像素间距处数、存量负 margin 处数）
  ├── 冻结写入 docs/layout-token-system/基线记录/layout-token-baseline.md
  └── CI 开启 Ratchet 模式：实测违规数 <= 基线放行，新增违规硬阻断！
        │
        ▼
【Phase 1: 原子层 ui/ 纯净化（BATCH-01）】
  ├── 统一 Button/Input/Select/Tabs/SegmentedControl 的 lg 高度为 40px
  ├── 清理 Menu.module.css、SelectTrigger.module.css 中的裸像素
  └── 解开 ui/ 目录的零容忍硬阻断（ui/ 内违规数必须为 0）
        │
        ▼
【Phase 2: 负 Margin 拔除与穿透选择器重构（BATCH-02）】
  ├── 改造 ChatScrollFloorSlot(-46px) 与 UnitChromeActions(-38px)
  ├── 拔除 ComposerFusedTrigger 与 SettingsExtensionsTab 的 :global 穿透
  └── 基线大幅下调（Net Negative Churn）
        │
        ▼
【Phase 3: 全仓 Fallback 清洗与 Token 替换（BATCH-03）】
  ├── 执行自动化 AST 脚本，将 var(--space-2, 6px) 等错位修正或去除 fallback
  └── 收敛剩余业务卡片的裸像素间距
        │
        ▼
【Phase 4: 全量零容忍硬阻断（BATCH-04）】
  └── 基线清零，全面开启 Zero-Tolerance 门禁守门！
```

---

## 六、调研结论与第二阶段方案输入清单

通过对 Conex / Crish 桌面端原子组件库与样式契约体系的全景解剖，本调研形成了以下确凿结论与方案建议，正式移交给第二阶段「系统性方案生成团队」：

### 6.1 核心问题沉淀清单

1. **原子层尺寸阶梯存在局部撕裂**：
   Button 与 Input 的 `lg` 为 40px，而 SegmentedControl、Tabs、Select 的 `lg` 为 38px，`tokens.css` 的 `--control-height-lg` 却为 36px，亟待在原子层建立单一真源标尺。
2. **间距 Fallback 存在严重的多源漂移与心理模型割裂**：
   全仓存在大量的 `var(--space-2, 6px)` 与 `var(--space-2, 5px)`，混淆了小数档位与紧凑齿轮覆写，并引发代偿性负外边距。
3. **样式契约测试缺乏 CI 快层阻断导致现场 5 项回潮**：
   `style-contract.test.ts` 存在 dark 块漏定义 `--ui-text-danger`、裸混色从 25 暴增至 53 处、themeStore 注入未定义 Token 等真实劣化，证明契约必须与构建门禁刚性绑定。
4. **负外边距与跨层穿透选择器缺乏自动化守门规则**：
   `-46px` 与 `-38px` 等极端破坏盒模型的负 margin 以及 `.prefix :global(button)` 等深度破坏组件封装的选择器在业务层蔓延。

### 6.2 对第二阶段方案团队的 6 项硬核输入建议

1. **【输入 1 · 控件高度统一】**：
   在第二阶段方案中，将全仓所有交互控件的标准尺寸矩阵刚性锁定为 4 档：
   `xs: 24px` / `sm: 28px` / `md: 32px` / `lg: 40px`。废弃 `38px` 离散档位，并将 `tokens.css` 中的 `--control-height-lg` 纠偏为 `40px`。
2. **【输入 2 · 间距 Token 纯净化方案】**：
   废除组件层业务样式中的离散 fallback，统一通过脚本收敛为 `var(--space-N)` 纯净引用。若保留 fallback，必须与 `:root` 静态定义完全等价。
3. **【输入 3 · 修复既有契约测试的 5 项失败】**：
   在实施第一波方案时，优先修复 `style-contract.test.ts` 中当前失败的 5 个断言（补齐 `--ui-text-danger`、收敛 53 处裸混色、补齐 themeStore 静态声明、对齐 `--button-radius: 8px`）。
4. **【输入 4 · 新增 `check-layout-tokens.mjs` 门禁脚本】**：
   基于 `check-token-consistency.mjs` 的成熟 AST 遍历经验，新增 `scripts/check-layout-tokens.mjs`，专职校验裸像素间距、非法负 margin 与跨层穿透选择器。
5. **【输入 5 · 建立 `layout-contract.test.ts` 自动化契约】**：
   在 `src/styles/` 下新建契约测试套件，建立 Phase 0 到 Phase 4 的渐进式棘轮基线字典。
6. **【输入 6 · 接入 CI 快层与 pre-commit】**：
   将新门禁与既有 `check:ui-layer`、`check:token-consistency` 并列纳入 `npm run check:desktop` 与 `.husky/pre-commit`，确保多 Agent 协作时无法跳过阻断。
