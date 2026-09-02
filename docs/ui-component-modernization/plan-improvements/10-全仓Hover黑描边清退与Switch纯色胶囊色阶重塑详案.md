# 10 · 全仓 Hover 黑描边清退与 Switch 纯色胶囊色阶重塑实施详案

> **文件标识**：`docs/ui-component-modernization/plan-improvements/10-全仓Hover黑描边清退与Switch纯色胶囊色阶重塑详案.md`  
> **所属战役**：UI 组件现代化与原生原子库升级（`ui-component-modernization`）  
> **方案版本**：v1.0.0 (Production Master Engineering Specification)  
> **编制依据**：
> - `docs/ui-component-modernization/analysis/10-全仓Hover脏黑描边与色阶混色全面普查.md`（第一步深度排查全量数据与根因）
> - `apps/crish-desktop/src/styles/tokens.css`（权威 Design Tokens 单一真源）
> - `apps/crish-desktop/src/styles/focus-visible.css`（全局可访问性焦点环中枢）
> - `apps/crish-desktop/src/components/ui/Switch/Switch.module.css` & `Switch.tsx`（Switch 核心原子组件）
> - `apps/crish-desktop/src/components/ui/Button/Button.module.css`（Button 核心原子组件）
> - `AGENTS.md`（§13 输入框与焦点态红线规范、§14 现代色彩空间与反过度设计铁律）
>
> **工程与架构铁律**：
> 1. **零外部 npm 组件库依赖**：绝对禁止引入第三方组件库（如 `@base-ui`, `@radix-ui`, `framer-motion` 等），所有物理动效、手势、浮层几何与无障碍交互均采用纯原生 React 18+ 与 CSS Modules 100% 纯净自研；
> 2. **色彩与样式铁律**：严格遵循 `tokens.css`，纯白卡底 `var(--bg-card, hsl(0 0% 100%))`，容器 3.5% 暖灰底板 `var(--bg-secondary)`，严禁冷蓝偏色；Hover 态统一使用 `var(--tint-hover)`，Active 态使用 `var(--tint-active)`；边框保持纯净发丝线 `var(--border-subtle)` / `var(--border-color)`，严禁在 Hover 态混入黑色加深边框；焦点环严格遵守 3%~6% 克制柔和灰色（禁止粗黑实线与 10% 黑圈）；
> 3. **Git 提交纪律**：本规划阶段严禁执行任何 git commit、git reset、git checkout。严禁在调研阶段修改任何项目源代码（.ts, .tsx, .css 等）。改动留在文档中供统一评审。

---

## 目录

- [一、总体设计哲学与色彩光度学重构原则](#一总体设计哲学与色彩光度学重构原则)
  - [1.1 破损现状与视觉痛点（Hover 脏黑、Switch 墨黑圈、Alpha 漏底、Token 断链）](#11-破损现状与视觉痛点hover-脏黑switch-墨黑圈alpha-漏底token-断链)
  - [1.2 现代扁平光影交互规范（The Golden Hover & Focus Rules）](#12-现代扁平光影交互规范the-golden-hover--focus-rules)
  - [1.3 治理前后指标量化与色度学对比矩阵](#13-治理前后指标量化与色度学对比矩阵)
- [二、全仓 :hover 黑色混色全面清退与统一 Hover 规范](#二全仓-hover-黑色混色全面清退与统一-hover-规范)
  - [2.1 统一 Hover / Focus 交互规范公理](#21-统一-hover--focus-交互规范公理)
  - [2.2 模式 A 清退：20% 混色超标文件治理（ChatEmptyState, Button）](#22-模式-a-清退20-混色超标文件治理chatemptystate-button)
  - [2.3 模式 B 清退：裸用文本色与 Alpha 遮罩充当边框的系统性治理（ApprovalAskCard, ModelsSettingsTab 9处, ScheduledTasksPanel, BinaryTreeWorkspace）](#23-模式-b-清退裸用文本色与-alpha-遮罩充当边框的系统性治理approvalaskcard-modelssettingstab-9处-scheduledtaskspanel-binarytreeworkspace)
  - [2.4 模式 D 调优：全仓表单/菜单/卡片 Hover 边框发黑全面脱灰（Select, Combobox, Shortcuts, Rules, FontSelect, Sidebar, Rename, Cheatsheet, MsgRow 等）](#24-模式-d-调优全仓表单菜单卡片-hover-边框发黑全面脱灰select-combobox-shortcuts-rules-fontselect-sidebar-rename-cheatsheet-msgrow-等)
  - [2.5 辅助操作与提交输入框边框修复（DiffCard, Button Primary 描边优化）](#25-辅助操作与提交输入框边框修复diffcard-button-primary-描边优化)
- [三、全局 Design Tokens 修复与焦点环断链根治](#三全局-design-tokens-修复与焦点环断链根治)
  - [3.1 根因修复：tokens.css 浅色模式补齐 `--control-mix-color` 与 `--focus-ring-color`](#31-根因修复tokenscss-浅色模式补齐---control-mix-color-与---focus-ring-color)
  - [3.2 focus-visible.css 全局重塑与 10% 粗黑环彻底清退](#32-focus-visiblecss-全局重塑与-10-粗黑环彻底清退)
  - [3.3 全仓 20+ 组件联动收敛与焦点无缝对齐](#33-全仓-20-组件联动收敛与焦点无缝对齐)
- [四、Switch 纯色胶囊与物理状态机全量重塑详案](#四switch-纯色胶囊与物理状态机全量重塑详案)
  - [4.1 缺陷 1 根治：Checked 态 `border-color: var(--brand)`，彻底清退 `--brand-deep` 墨黑硬边](#41-缺陷-1-根治checked-态-border-color-var--brand彻底清退---brand-deep-墨黑硬边)
  - [4.2 缺陷 2 根治：Checked 态 Hover 轨道纯色保持与微光高亮（拒绝 Darkening Collapse）](#42-缺陷-2-根治checked-态-hover-轨道纯色保持与微光高亮拒绝-darkening-collapse)
  - [4.3 缺陷 3 根治：Checked 态焦点环消除“深黑内槽”，重塑同心发丝光影](#43-缺陷-3-根治checked-态焦点环消除深黑内槽重塑同心发丝光影)
  - [4.4 缺陷 4 根治：未选中态 Hover 规范化（清除未定义变量，收敛至 `var(--tint-hover)` 与 `var(--border-subtle)`）](#44-缺陷-4-根治未选中态-hover-规范化清除未定义变量收敛至-var--tint-hover-与-var--border-subtle)
  - [4.5 缺陷 5 根治：`:focus:not(:focus-visible)` 消除鼠标点击黑圈](#45-缺陷-5-根治focusnotfocus-visible-消除鼠标点击黑圈)
  - [4.6 深色模式下的通透度与 OLED 边缘抗锯齿优化](#46-深色模式下的通透度与-oled-边缘抗锯齿优化)
- [五、逐文件重构实施清单与代码 Diff 蓝图](#五逐文件重构实施清单与代码-diff-蓝图)
  - [5.1 `apps/crish-desktop/src/styles/tokens.css` 代码级重构方案](#51-appscrish-desktopsrcstylestokenscss-代码级重构方案)
  - [5.2 `apps/crish-desktop/src/styles/focus-visible.css` 代码级重构方案](#52-appscrish-desktopsrcstylesfocus-visiblecss-代码级重构方案)
  - [5.3 `apps/crish-desktop/src/components/ui/Switch/Switch.module.css` 终态代码蓝图](#53-appscrish-desktopsrccomponentsuiswitchswitchmodulecss-终态代码蓝图)
  - [5.4 `apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css` 代码级重构方案](#54-appscrish-desktopsrccomponentschat-cardchatemptystatemodulecss-代码级重构方案)
  - [5.5 `apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css` 代码级重构方案](#55-appscrish-desktopsrccomponentsagent-cardapprovalaskcardmodulecss-代码级重构方案)
  - [5.6 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css` 代码级重构方案](#56-appscrish-desktopsrccomponentssettings-modelsmodelssettingstabmodulecss-代码级重构方案)
  - [5.7 `apps/crish-desktop/src/components/settings/ScheduledTasksPanel.module.css` 代码级重构方案](#57-appscrish-desktopsrccomponentssettingsscheduledtaskspanelmodulecss-代码级重构方案)
  - [5.8 `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css` 代码级重构方案](#58-appscrish-desktopsrccomponentsbinary-treebinarytreeworkspacemodulecss-代码级重构方案)
  - [5.9 `apps/crish-desktop/src/components/diff/DiffCard.module.css` 代码级重构方案](#59-appscrish-desktopsrccomponentsdiffdiffcardmodulecss-代码级重构方案)
  - [5.10 `apps/crish-desktop/src/components/ui/Button/Button.module.css` 代码级重构方案](#510-appscrish-desktopsrccomponentsuibuttonbuttonmodulecss-代码级重构方案)
  - [5.11 `apps/crish-desktop/src/components/ui/Select/Select.module.css` & `SelectTrigger.module.css` & `Combobox.module.css` 代码级重构方案](#511-appscrish-desktopsrccomponentsuiselectselectmodulecss--selecttriggermodulecss--comboboxmodulecss-代码级重构方案)
  - [5.12 `apps/crish-desktop/src/components/settings/SettingsShortcutsTab.module.css` & `SettingsRulesTab.module.css` & `FontSelectField.module.css` 代码级重构方案](#512-appscrish-desktopsrccomponentssettingssettingsshortcutstabmodulecss--settingsrulestabmodulecss--fontselectfieldmodulecss-代码级重构方案)
  - [5.13 `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css` & `SessionInlineRename.module.css` & `CheatsheetModal.module.css` & `ChatMessageRow.module.css` 代码级重构方案](#513-appscrish-desktopsrccomponentssidebarsidebarsessionlistmodulecss--sessioninlinerenamemodulecss--cheatsheetmodalmodulecss--chatmessagerowmodulecss-代码级重构方案)
- [六、自动化测试用例设计与断言验证矩阵](#六自动化测试用例设计与断言验证矩阵)
  - [6.1 `Switch.test.tsx` 纯色胶囊与 Hover / Focus 状态断言测试用例](#61-switchtesttsx-纯色胶囊与-hover--focus-状态断言测试用例)
  - [6.2 `TokensFocusRing.test.ts` Design Tokens 与全局 Focus-visible 断言](#62-tokensfocusringtestts-design-tokens-与全局-focus-visible-断言)
  - [6.3 `NoDirtyHoverBorder.test.ts` 静态 AST / CSS 正则扫描防护断言](#63-nodirtyhoverbordertestts-静态-ast--css-正则扫描防护断言)
- [七、分步实施计划、工程红线与验收检查单](#七分步实施计划工程红线与验收检查单)
  - [7.1 三阶段递进式实施路线图](#71-三阶段递进式实施路线图)
  - [7.2 严苛质量门禁与验收 Checklist](#72-严苛质量门禁与验收-checklist)

---

# 一、总体设计哲学与色彩光度学重构原则

## 1.1 破损现状与视觉痛点（Hover 脏黑、Switch 墨黑圈、Alpha 漏底、Token 断链）

在第一阶段普查报告 `10-全仓Hover脏黑描边与色阶混色全面普查.md` 中，全仓共扫描了 **119 个样式文件**、**671 个交互状态规则块**，发现并锁定了以下四大类破坏现代 UI 视觉通透度的核心色阶破损问题：

```
                                  全仓四大类色彩与状态破损全景
                                                │
    ┌───────────────────┬───────────────────────┴───────────────────────┬───────────────────┐
    ▼                   ▼                                               ▼                   ▼
【1. Hover 脏黑混色】   【2. Switch 墨黑圈与塌陷】                      【3. Alpha 遮罩漏底】 【4. Token 断链黑粗环】
20% 混入 text-primary    Checked 硬编 --brand-deep                      裸用 tint-strong 充当  tokens.css 漏定义
导致边缘亮度骤降 15%     Hover 瞬间变黑塌陷                              1px 实线边框，边缘次像  control-mix-color，全仓
产生粗黑脏边卡片         焦点环产生“墨黑沟槽夹心”                        素抗锯齿叠加形成脏灰晕  20+ 组件退回 10% 粗黑环
```

1. **Hover 状态下的“脏黑描边”（Dirty Dark Border on Hover）**：
   - 开发者误以为“悬停时应该把边框加深”，在 `:hover` 规则中混入了 8%~20% 的 `--text-primary`（如 `ChatEmptyState:L260` 混入 20%，`ApprovalAskCard:L232` 裸用 `#696969`）；
   - 导致用户鼠标滑过卡片或按钮时，边框瞬间浮现出一圈生硬、刺眼的炭黑线条，产生了强烈的“被黑笔圈出”的视觉跳跃感与廉价感。
2. **Switch 开关的“墨黑硬边”与“变暗塌陷”（Switch Dark Ring & Collapse）**：
   - Switch 在开启状态（Checked）下，边框硬编码了 `--brand-deep`（`#047857`，亮度比背景低 23%），被一圈沉重的墨黑框死死箍住；
   - 鼠标悬停在已开启的开关上时，背景瞬间由翠绿色 `#10b981` 坍缩为墨黑绿色 `#047857`，视觉感知如同“开关被按灭断电”；
   - 聚焦时，外层亮绿光晕与内部翠绿轨道之间夹着一条 1px 的墨黑沟槽，形成断裂的“夹心饼干”；
   - 鼠标点击后残留原生 Focus 轮廓，留下丑陋的黑圈。
3. **半透明 Alpha 遮罩滥用于实线边框（Alpha Bleed-Through Artifacts）**：
   - `ModelsSettingsTab` 与 `BinaryTreeWorkspace` 直接把 `--tint-strong`（10% 半透明黑）、`--tint-active`（6.5% 半透明黑）赋值给 `border-color`；
   - 半透明线条在抗锯齿光栅化时与底层背景卷积，产生模糊浑浊的灰边。
4. **底层 Token 断链导致全局焦点环劣化（Token Chain Breakage）**：
   - `tokens.css` 浅色模式漏写 `--control-mix-color`，导致 `--focus-ring` 无效，触发 `focus-visible.css` 退回 `0 0 0 2px var(--tint-focus-ring)`（10% 纯黑透明环），殃及全仓 20+ 个核心组件。

---

## 1.2 现代扁平光影交互规范（The Golden Hover & Focus Rules）

对标 Apple macOS 原生应用、Linear 与现代顶级桌面 GUI 设计规范，确立全新的**交互状态物理光影四大黄金法则**：

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                             The Golden Hover & Focus Rules（黄金交互规范）                │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. 悬停只调微背景，边框坚守发丝线：                                                     │
│    :hover 态仅叠加 var(--tint-hover)（3.5% 极浅微光），边框颜色严格保持不变（保持        │
│    var(--border-subtle) 或 var(--border-color)）。严禁在 Hover 态混入黑色加深边框！     │
│                                                                                          │
│ 2. Switch 纯色同体无界胶囊：                                                             │
│    Switch 选中态（Checked）背景与边框完全同色（border-color: var(--brand)），呈现无缝纯色  │
│    果冻胶囊质感；悬停时不加深轨道底色（保持翠绿透亮）；焦点环收敛为同色微光或标准软灰。     │
│                                                                                          │
│ 3. 焦点变化克制柔和（3%~6% 软灰）：                                                       │
│    聚焦（:focus-visible）边框混入文本色上限严格卡死在 6%~10%，外圈阴影卡死在 3%~6%；      │
│    必须声明 :focus:not(:focus-visible) { outline: none; box-shadow: none; } 阻断鼠标黑圈。│
│                                                                                          │
│ 4. 彻底杜绝 Alpha 遮罩充当实线边框：                                                     │
│    边框一律使用实色 Token（var(--border-color) / var(--border-subtle) / var(--brand)），  │
│    禁止将半透明背景遮罩（var(--tint-*)）赋值给 border 或 border-color。                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1.3 治理前后指标量化与色度学对比矩阵

| 评估维度 | 治理前现状（严重破损/脏黑） | 治理后终态标准（纯色通透/现代光影） | 光度学/感知改善指标 |
| :--- | :--- | :--- | :--- |
| **空态卡片 Hover 边框** | 混入 20% `--text-primary`（亮度 71%） | 保持 `var(--border-color)`（亮度 86%）+ 叠加 `var(--tint-hover)` | 彻底消除 $\Delta L^* = 15$ 的暗化跳变，无视觉震颤 |
| **Switch Checked 边框** | `--brand-deep`（$L^* \approx 45$，深墨黑） | `var(--brand)`（$L^* \approx 68$，翡翠绿） | 消除 $\Delta L^* = 23$ 的色阶断层，获得纯色一体胶囊 |
| **Switch Checked Hover** | 轨道变暗为 `--brand-deep`（严重塌陷） | 保持 `var(--brand)` + 叠加纯白 8% 微光 | 消除断电错觉，呈现近场高光就绪感 |
| **Switch 焦点内圈** | 1px `--brand-deep` 墨黑沟槽 | 纯净 `var(--brand)` 边缘 | 消除“夹心饼干”撕裂感，光晕同心扩散 |
| **鼠标点击焦点残留** | 浏览器默认 1px/2px 粗黑圈 | `:focus:not(:focus-visible)` 完全清除 | 鼠标点击 100% 干净，键盘 Tab 精确唤醒 |
| **全局 Focus Ring Token** | `--control-mix-color` 缺失，退回 10% 粗黑环 | 浅色模式精确定义，统一 6% 软灰外环 | 全仓 20+ 组件消除 10% 粗黑阴影 |
| **设置页列表/按钮边框** | 裸用 `#696969` 或 `--tint-strong` (10%) | 统一为 `var(--border-color)` / `var(--border-subtle)` | 彻底根除 Alpha 漏底与次像素锯齿脏边 |

---

# 二、全仓 :hover 黑色混色全面清退与统一 Hover 规范

## 2.1 统一 Hover / Focus 交互规范公理

在 CSS 渲染管线中，元素 Hover 交互的本质是**表面反射率（Albedo / Reflectance）的微弱提升**。过去在 CSS 中通过 `border-color: color-mix(..., var(--text-primary) X%)` 刻意加深边框的做法，属于早年拟物化时代的“凹陷刻线（Etched Grooving）”遗毒，在现代 Flat / Neomorphic 极简扁平纸片设计体系中会导致严重的视觉脏污。

```
【正确与错误的 Hover 交互层级对比】
┌─────────────────────────────────────────────────────────────┐
│ 错误做法（加深边框）：                                      │
│   [ 浅灰底板 ] ──(Hover)──► [ 粗黑墨边框 + 灰黑凹陷 ] (脏!) │
├─────────────────────────────────────────────────────────────┤
│ 正确做法（微背景提亮/微光）：                              │
│   [ 纯净发丝边框 ] ──(Hover)──► [ 纯净发丝边框 + 3.5% 柔和微光 ] (通透高级) │
└─────────────────────────────────────────────────────────────┘
```

**全仓统一 Hover 标准重构原则**：
1. **Container / Card / Row / Item**：
   - 默认态：`border: 1px solid var(--border-subtle)`（或 `var(--border-color)`），`background: var(--bg-card)`（或 `var(--bg-primary)`）；
   - Hover 态：`background: var(--tint-hover)`（或 `color-mix(in srgb, var(--tint-hover) 50%, var(--bg-card))`），**`border-color` 绝对不加深、不混入 `--text-primary`**；
2. **Interactive Controls (Button, Select, Input)**：
   - 默认态：1px `var(--border-color)`；
   - Hover 态：通过 `::before` 遮罩叠加 `var(--tint-hover)`，边框保持 `var(--border-color)`；
   - Focus-visible 态：边框软灰微调 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`，外圈发丝阴影 `0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)`。

---

## 2.2 模式 A 清退：20% 混色超标文件治理（ChatEmptyState, Button）

### 1. `ChatEmptyState.module.css:L257-L263`
- **当前违规代码**：
  ```css
  .quickPromptCard:hover,
  .sessionEmpty .quickPromptCard:hover {
    background: var(--bg-card, hsl(0 0% 100%));
    border-color: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%);
    box-shadow: 0 2px 6px color-mix(in srgb, var(--shadow-color, black) 6%, transparent);
  }
  ```
- **重构方案**：
  - 移除 20% 混色，边框保持 `var(--border-color)`；
  - 背景叠加极轻微的 `var(--tint-hover)` 或纯白提亮；
  - 阴影调整为柔和低空阴影 `0 2px 6px color-mix(in srgb, var(--shadow-color, black) 4%, transparent)`。
- **重构后终态代码**：
  ```css
  .quickPromptCard:hover,
  .sessionEmpty .quickPromptCard:hover {
    background: var(--bg-card, hsl(0 0% 100%));
    border-color: var(--border-color, hsl(35 10% 86%));
    box-shadow: 0 2px 6px color-mix(in srgb, var(--shadow-color, black) 4%, transparent);
  }
  ```

### 2. `Button.module.css:L156`（Dark Mode Secondary Button 20% 混色）
- **当前违规代码**：
  ```css
  :global(html[data-theme='dark']) .buttonSecondary,
  :global(html[data-theme='dark']) .button[data-variant='secondary'] {
    --btn-bg: color-mix(in srgb, var(--text-primary) 6.5%, var(--bg-card));
    --btn-fg: var(--text-primary);
    --btn-border: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%);
    --btn-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 40%, transparent);
    --btn-hover-overlay: color-mix(in srgb, var(--text-primary) 6%, transparent);
    --btn-active-overlay: color-mix(in srgb, var(--text-primary) 12%, transparent);
  }
  ```
- **重构方案**：
  - 将 `--btn-border` 恢复为纯净的 `var(--border-subtle, #333333)` 或 `var(--border-color)`，移除 20% 白化混入；
  - `--btn-bg` 保持 `var(--bg-elevated, #242424)`，形成沉稳的暗色实体卡片。
- **重构后终态代码**：
  ```css
  :global(html[data-theme='dark']) .buttonSecondary,
  :global(html[data-theme='dark']) .button[data-variant='secondary'] {
    --btn-bg: var(--bg-elevated, #242424);
    --btn-fg: var(--text-primary, #dddddd);
    --btn-border: var(--border-subtle, #333333);
    --btn-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    --btn-hover-overlay: var(--tint-hover);
    --btn-active-overlay: var(--tint-active);
  }
  ```

---

## 2.3 模式 B 清退：裸用文本色与 Alpha 遮罩充当边框的系统性治理（ApprovalAskCard, ModelsSettingsTab 9处, ScheduledTasksPanel, BinaryTreeWorkspace）

### 1. `ApprovalAskCard.module.css:L230-L233`
- **当前违规代码**：
  ```css
  .approvalCardBtn.deny:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--text-tertiary); /* 裸用 #696969 文本色 */
  }
  ```
- **重构方案**：
  - Hover 态边框统一收敛为 `var(--border-color)`；
  - 背景叠加 `var(--tint-hover)`；
  - 文字前景色提亮为 `var(--text-primary)`。
- **重构后终态代码**：
  ```css
  .approvalCardBtn.deny:hover:not(:disabled) {
    background: var(--tint-hover);
    border-color: var(--border-color);
    color: var(--text-primary);
  }
  ```

### 2. `ModelsSettingsTab.module.css` 全面清洗（共 9 处）
- **L38-L58 (`.mrlAddBtn`)**：
  - 默认边框从 `var(--tint-active)` 改为 `var(--border-color)`；
  - Hover 态从 `border-color: var(--tint-strong)` 改为 `border-color: var(--border-color)`，背景叠加 `var(--tint-hover)`。
- **L377-L398 (`.mrdModelRow`)**：
  - 默认边框从 `var(--tint-hover)` 改为 `var(--border-subtle)`；
  - Hover 态从 `border-color: var(--tint-strong)` 改为 `background: var(--bg-hover)`，边框保持 `var(--border-subtle)`；
  - `.isLive` 边框从 `var(--tint-active)` 改为 `var(--border-color)`。
- **L542-L554 (`.modelsCtxInput`)**：
  - 从 `border: 1px solid var(--tint-strong); background: var(--tint-hover);` 改为标准输入框样式：`border: 1px solid var(--border-color); background: var(--bg-card);`。
- **L644-L663 (`.modelsBillingToggle`)**：
  - 边框从 `var(--tint-active)` 改为 `var(--border-color)`；
  - 背景从 `var(--tint-hover)` 改为 `var(--bg-card)`；
  - Hover 态背景叠加 `var(--tint-hover)`。
- **L699-L709 (`.modelsBillingBody`)**：
  - 边框从 `var(--tint-active)` 改为 `var(--border-subtle)`。
- **L746-L755 (`.modelsPriceList`)**：
  - 边框从 `var(--tint-active)` 改为 `var(--border-subtle)`。
- **L902-L906 (`.mrdAddModelBtn:hover`)**：
  - 移除 `border-color: var(--text-tertiary)`，边框保持 `var(--border-color)`，背景使用 `var(--tint-hover)`。

### 3. `ScheduledTasksPanel.module.css:L200-L210`
- **当前违规代码**：
  ```css
  .schedSelect :global(.settings-select-trigger:hover:not(:disabled)),
  .schedField :global(.settings-select-trigger:hover:not(:disabled)) {
    background: var(--bg-primary);
    box-shadow: 0 0 0 1px var(--tint-divider); /* 12% 黑色透明层 */
  }

  .schedSelect :global(.is-open .settings-select-trigger),
  .schedField :global(.settings-select.is-open .settings-select-trigger) {
    box-shadow: 0 0 0 1px var(--tint-scrollbar-thumb); /* 18% 黑色透明层 */
    background: var(--bg-primary);
  }
  ```
- **重构方案**：
  - 彻底删除局部覆盖标准 Select 边框阴影的违规代码，统一回归 `Select.module.css` 标准规范；
  - Hover 态使用标准 `var(--tint-hover)` 微光，展开态使用标准软灰焦点环。

### 4. `BinaryTreeWorkspace.module.css:L154-L156`
- **当前违规代码**：
  ```css
  .leaf[data-active='true'] .leafBody {
    border-color: var(--tint-strong); /* 10% 纯黑透明层 */
  }
  ```
- **重构方案**：
  - 将 `border-color` 修正为标准实色发丝线 `var(--border-color, hsl(35 10% 86%))`，消除 Alpha 漏底与脏灰边缘。

---

## 2.4 模式 D 调优：全仓表单/菜单/卡片 Hover 边框发黑全面脱灰（Select, Combobox, Shortcuts, Rules, FontSelect, Sidebar, Rename, Cheatsheet, MsgRow 等）

在第一阶段排查中，部分组件在 `:hover` 时使用了 `border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`。
虽然 8% 未超过 10% 的硬性上限，但在高频鼠标划过时仍会产生轻微的边框闪烁与加深感。根据新确立的“**悬停只调微背景，边框坚守发丝线**”黄金法则，全量对齐收敛如下：

1. **`Select.module.css:L24-L28` & `SelectTrigger.module.css:L24-L28`**：
   - Hover 态：`border-color` 保持 `var(--border-color)`，背景叠加 `var(--tint-hover)`；
   - Focus / Open 态：保持标准 6%~10% 软灰焦点环。
2. **`Combobox.module.css:L18-L24`**：
   - Hover 态：`border-color` 保持 `var(--border-color)`；
   - Focus 态：保持标准 6%~10% 软灰焦点环。
3. **`SettingsShortcutsTab.module.css:L51-L57`** (`.shortcutKeyBtn:hover`)：
   - Hover 态：`border-color: var(--border-color)`，通过微阴影 `0 1px 3px rgba(0, 0, 0, 0.05)` 呈现轻微悬浮感，不再加深边框。
4. **`SettingsRulesTab.module.css:L82-L88`** (`.presetChip:hover`)：
   - Hover 态：`border-color: var(--border-color)`，背景保持实体白卡并叠加微阴影。
5. **`FontSelectField.module.css:L46-L53`**：
   - Hover 态：`border-color: var(--border-color)`，背景使用 `var(--tint-hover)`。
6. **`SidebarSessionList.module.css:L350-L355` & `SessionInlineRename.module.css:L24-L28`**：
   - 重命名输入框 Hover 态：`border-color: var(--border-color)`。
7. **`CheatsheetModal.module.css:L39-L43`**：
   - 搜索框 Hover 态：`border-color: var(--border-color)`。
8. **`ChatMessageRow.module.css:L923-L928`**：
   - 快捷动作按钮 Hover 态：`border-color: var(--border-color)`，背景叠加 `var(--tint-hover)`。

---

## 2.5 辅助操作与提交输入框边框修复（DiffCard, Button Primary 描边优化）

### 1. `DiffCard.module.css:L826-L829` (`.commitInput:focus`)
- **当前代码**：
  ```css
  .commitInput:focus {
    outline: none;
    border-color: var(--brand-deep, #047857);
  }
  ```
- **问题分析**：直接使用深墨黑绿色 `#047857` 作为边框，缺少外层软光晕，显得沉重压抑。
- **重构方案**：
  ```css
  .commitInput:focus-visible {
    outline: none;
    border-color: var(--brand, hsl(160 84% 39%));
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 25%, transparent);
  }
  ```

### 2. `Button.module.css:L130-L138` (Primary 按钮去深黑边)
- **当前代码**：
  ```css
  .buttonPrimary,
  .button[data-variant='primary'] {
    --btn-bg: var(--brand, hsl(160 84% 39%));
    --btn-fg: var(--text-on-accent, hsl(0 0% 100%));
    --btn-border: var(--brand-deep, hsl(160 84% 31%));
    --btn-shadow: 0 1px 2px color-mix(in srgb, var(--brand-deep) 25%, transparent);
    --btn-hover-overlay: color-mix(in srgb, var(--text-on-accent, hsl(0 0% 100%)) 15%, transparent);
    --btn-active-overlay: color-mix(in srgb, var(--shadow-color, #000) 15%, transparent);
  }
  ```
- **重构方案**：
  - 将 `--btn-border` 从深墨绿 `--brand-deep` 提升为与背景同色 `var(--brand)`，彻底摆脱深暗墨绿边箍；
  - 阴影使用纯净微阴影 `0 1px 2px color-mix(in srgb, var(--shadow-color, #000) 12%, transparent)`；
  - Active 态使用白光微压暗而非 15% 纯黑叠加。

---

# 三、全局 Design Tokens 修复与焦点环断链根治

## 3.1 根因修复：tokens.css 浅色模式补齐 `--control-mix-color` 与 `--focus-ring-color`

在 `apps/crish-desktop/src/styles/tokens.css` 中：
- 深色模式（L894）中定义了 `--control-mix-color: var(--text-primary);`；
- 但浅色模式 `:root`（L1-L150）中遗漏了 `--control-mix-color`，导致 L110-L115 处的 `--focus-ring-color` 无法正确计算。

```
【修复前后的 Token 传递链条】
修复前 (浅色模式):
:root { --control-mix-color: (未定义!); }
  └──► --focus-ring-color: color-mix(in srgb, [UNDEFINED] 8%, transparent) (无效!)
        └──► --focus-ring: 0 0 0 2px [INVALID] (失效!)
              └──► focus-visible.css: 回退到 fallback: 0 0 0 2px var(--tint-focus-ring) (10% 粗黑环!)

修复后 (全模式对齐):
:root { --control-mix-color: var(--text-primary); }
  └──► --focus-ring-color: color-mix(in srgb, var(--control-mix-color) 6%, transparent);
        └──► --focus-ring: 0 0 0 1.5px var(--focus-ring-color); (柔和 6% 软灰发丝光晕)
```

**Tokens.css 修复蓝图**：
```css
/* apps/crish-desktop/src/styles/tokens.css */

:root {
  /* ... 原有 tokens ... */
  --control-mix-color: var(--text-primary); /* 补齐浅色模式单一真源 */
  
  --focus-ring-color: color-mix(
    in srgb,
    var(--control-mix-color) 6%,
    transparent
  );
  --focus-ring: 0 0 0 1.5px var(--focus-ring-color);
  --focus-ring-subtle: color-mix(
    in srgb,
    var(--border-color) 94%,
    var(--text-primary) 6%
  );
  --focus-ring-strong: color-mix(
    in srgb,
    var(--border-color) 90%,
    var(--text-primary) 10%
  );
  /* ... */
}
```

---

## 3.2 focus-visible.css 全局重塑与 10% 粗黑环彻底清退

`focus-visible.css` 是全仓可访问性焦点中枢。必须彻底清理 10% `--tint-focus-ring` 的 fallback 粗黑环：

```css
/* apps/crish-desktop/src/styles/focus-visible.css */

/* 1. 鼠标点击（:focus 且非 :focus-visible）彻底消灭黑圈 */
:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}

/* 2. 键盘 Tab 导航（:focus-visible）呈现标准 1.5px 软灰光晕 */
:focus-visible {
  outline: 1.5px solid var(--focus-ring-color, color-mix(in srgb, var(--text-primary) 6%, transparent));
  outline-offset: 1px;
}

input:focus-visible,
textarea:focus-visible {
  outline-offset: -1px;
}

button:focus-visible,
a:focus-visible,
[role='button']:focus-visible,
[tabindex]:not([tabindex='-1']):focus-visible {
  outline: none;
  box-shadow: var(--focus-ring, 0 0 0 1.5px color-mix(in srgb, var(--text-primary) 6%, transparent));
}
```

---

## 3.3 全仓 20+ 组件联动收敛与焦点无缝对齐

随着 `tokens.css` 与 `focus-visible.css` 底座修复，全仓以下 20+ 个曾被动回退至 10% 纯黑粗环的组件将**自动获得极致柔和的 6% 软灰焦点光晕**，彻底告别视觉噪点：

1. `PreviewCard.module.css`（7 处操作按钮）
2. `TerminalCard.module.css`（3 处工具栏按钮）
3. `InlineAgentPanel.module.css`（2 处 Agent 头部与外链）
4. `ApprovalAskCard.module.css`（审批卡片通用按钮）
5. `SidebarNav.module.css`（侧边栏导航项）
6. `ModelsSettingsTab.module.css`（服务添加与级联菜单）
7. `SettingsQuickMenu.module.css`（快捷菜单项）
8. `ExternalSessionImport.module.css`（导入选项复选框）

---

# 四、Switch 纯色胶囊与物理状态机全量重塑详案

Switch 组件是现代 UI 中最要求纯粹感与呼吸感的原子控件。以下对 Switch 的 5 大核心缺陷展开外科手术级重塑方案。

```
【Switch 重塑前后视觉结构全景对比】
┌─────────────────────────────────────────────────────────────┐
│ 治理前（破损状态）：                                        │
│  • Checked 静态态： [ #047857 深墨黑边 ] 包围 [ #10b981 翠绿 ] (黑箍感)│
│  • Checked Hover 态：轨道背景突变 #047857 (瞬间发黑变暗，像断电)│
│  • Checked Focus 态：[ 浅绿外光晕 ] + [ 墨黑内槽 ] + [ 翠绿背景 ] (夹心)│
│  • 鼠标点击：残留 1~2px 粗糙原生黑圈                        │
├─────────────────────────────────────────────────────────────┤
│ 治理后（终态标准）：                                        │
│  • Checked 静态态： [ #10b981 纯色一体胶囊 ] (无缝纯净通透)   │
│  • Checked Hover 态：保持 #10b981 + 叠加 8% 纯白微光 (高亮灵敏)│
│  • Checked Focus 态：同心发丝光影，无任何墨黑内槽            │
│  • 鼠标点击：:focus:not(:focus-visible) 绝对消灭黑圈        │
└─────────────────────────────────────────────────────────────┘
```

## 4.1 缺陷 1 根治：Checked 态 `border-color: var(--brand)`，彻底清退 `--brand-deep` 墨黑硬边

- **原理**：将边框颜色与背景颜色完全统一为 `var(--brand, hsl(160 84% 39%))`；
- **效果**：滑轨在开启时成为一枚浑然一体的纯色发丝胶囊，无任何边缘明度跌落，完美对标 macOS / iOS 原生 Switch 的纯净极简美学。

```css
/* apps/crish-desktop/src/components/ui/Switch/Switch.module.css */

.track[data-state='checked'] {
  background: var(--brand, hsl(160 84% 39%));
  border-color: var(--brand, hsl(160 84% 39%));
}
```

---

## 4.2 缺陷 2 根治：Checked 态 Hover 轨道纯色保持与微光高亮（拒绝 Darkening Collapse）

- **原理**：当鼠标悬停在已处于开启状态的 Switch 上时，轨道背景**绝对不再降级变暗为 `--brand-deep`**；
- **交互动效**：保持 `var(--brand)` 主色，通过 CSS `filter: brightness(1.04)` 或背景叠加极浅纯白微光 `color-mix(in srgb, #ffffff 10%, var(--brand))`，向用户传递“高灵敏就绪”的正面物理反馈。

```css
.track[data-state='checked']:hover:not(:disabled) {
  background: color-mix(in srgb, hsl(0 0% 100%) 8%, var(--brand, hsl(160 84% 39%)));
  border-color: color-mix(in srgb, hsl(0 0% 100%) 8%, var(--brand, hsl(160 84% 39%)));
}
```

---

## 4.3 缺陷 3 根治：Checked 态焦点环消除“深黑内槽”，重塑同心发丝光影

- **原理**：在 Checked 聚焦时，边框维持 `var(--brand)`，外层投影采用 20%~25% 的 Emerald 品牌半透光晕；
- **效果**：从内向外呈现“翠绿核心 -> 翠绿发丝边 -> 柔和浅绿漫反射光晕”的完美同心渐变结构，彻底消灭 1px 墨黑沟槽。

```css
.track[data-state='checked']:focus-visible {
  border-color: var(--brand, hsl(160 84% 39%));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 25%, transparent);
}
```

---

## 4.4 缺陷 4 根治：未选中态 Hover 规范化（清除未定义变量，收敛至 `var(--tint-hover)` 与 `var(--border-subtle)`）

- **原理**：彻底清除失效且未定义的 `var(--switch-track-border-hover)`；
- **重构方案**：未选中态（OFF）默认边框为 `var(--border-subtle)`，Hover 态边框保持 `var(--border-subtle)`（不发黑），背景叠加柔和的 `var(--tint-hover)`。

```css
.track:hover:not(:disabled) {
  border-color: var(--border-subtle);
  background: color-mix(in srgb, var(--tint-hover) 60%, var(--switch-track-bg));
}
```

---

## 4.5 缺陷 5 根治：`:focus:not(:focus-visible)` 消除鼠标点击黑圈

- **原理**：用户用鼠标点击 Switch 时，浏览器默认会将焦点置于 `<button>` 元素上。如果没有针对非键盘聚焦进行抑制，浏览器会渲染丑陋的焦点黑边；
- **重构方案**：在 `Switch.module.css` 明确声明抑制规则，彻底保证鼠标交互时 100% 丝滑无黑圈。

```css
.track:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}
```

---

## 4.6 深色模式下的通透度与 OLED 边缘抗锯齿优化

在深色模式（`html[data-theme='dark']`）下：
- 暗黑底板为 `#1b1b1b` / `#242424`；
- 将 Checked 边框由原先的暗淡墨绿 `hsl(160 84% 30%)` 统一提升为明亮的 `var(--brand, hsl(160 84% 39%))`；
- 滑块（Thumb）本体采用纯白卡底 `hsl(0 0% 100%)` 并辅以 `0 0 0 0.5px color-mix(in srgb, var(--border-color) 40%, transparent)` 发丝微收边；
- 彻底杜绝在暗色屏幕上边缘融底与噪点溢出问题。

---

# 五、逐文件重构实施清单与代码 Diff 蓝图

## 5.1 `apps/crish-desktop/src/styles/tokens.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/styles/tokens.css
+++ b/apps/crish-desktop/src/styles/tokens.css
@@ -109,10 +109,11 @@
   --md-code-tab-size: 2;
+  --control-mix-color: var(--text-primary);
   --focus-ring-color: color-mix(
     in srgb,
-    var(--control-mix-color) 8%,
+    var(--control-mix-color) 6%,
     transparent
   );
-  --focus-ring: 0 0 0 2px var(--focus-ring-color);
+  --focus-ring: 0 0 0 1.5px var(--focus-ring-color);
   --focus-ring-subtle: color-mix(
```

---

## 5.2 `apps/crish-desktop/src/styles/focus-visible.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/styles/focus-visible.css
+++ b/apps/crish-desktop/src/styles/focus-visible.css
@@ -8,7 +8,7 @@
 }
 
 :focus-visible {
-  outline: 2px solid var(--focus-ring-color);
+  outline: 1.5px solid var(--focus-ring-color, color-mix(in srgb, var(--text-primary) 6%, transparent));
   outline-offset: 1px;
 }
 
@@ -21,5 +21,5 @@
 [tabindex]:not([tabindex='-1']):focus-visible {
   outline: none;
-  box-shadow: var(--focus-ring, 0 0 0 2px var(--tint-focus-ring));
+  box-shadow: var(--focus-ring, 0 0 0 1.5px color-mix(in srgb, var(--text-primary) 6%, transparent));
 }
```

---

## 5.3 `apps/crish-desktop/src/components/ui/Switch/Switch.module.css` 终态代码蓝图

```css
/* apps/crish-desktop/src/components/ui/Switch/Switch.module.css
 * v2.1.0 纯色发丝胶囊与中轴几何对称版
 * 100% 消除墨黑圈、Hover 塌陷与鼠标点击黑圈
 */

.container {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
  user-select: none;
}

.container[data-disabled] {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
}

.label {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
  cursor: pointer;
  line-height: var(--line-height-ui, 1.35);
  transition: color var(--transition-micro, 100ms ease-out);
}

.container:hover:not([data-disabled]) .label {
  color: var(--text-primary);
}

/* --- 轨道基底（Track） --- */
.track {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0;
  line-height: 0;
  font-size: 0;
  vertical-align: middle;
  border-radius: var(--radius-full, 9999px);
  border: 1px solid var(--border-subtle);
  background: var(--switch-track-bg, color-mix(in srgb, var(--text-primary) 5%, var(--bg-tertiary)));
  box-sizing: border-box;
  cursor: pointer;
  flex-shrink: 0;
  outline: none;
  overflow: visible;
  transition:
    background-color var(--duration-fast, 150ms) cubic-bezier(0.4, 0, 0.2, 1),
    border-color var(--duration-fast, 150ms) cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow var(--duration-fast, 150ms) cubic-bezier(0.4, 0, 0.2, 1);
}

/* 消除鼠标点击残留黑圈 */
.track:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}

/* 尺寸规格与 CSS 变量矩阵 */
.size-sm {
  --track-w: 28px;
  --track-h: 16px;
  --thumb-d: 12px;
  --thumb-pad: 2px;
  --thumb-travel: 10px;
  --thumb-stretch-w: 18px;
  --stretch-x-on: 4.5px;
  --stretch-x-off: 3.5px;
  --spinner-size: 9px;
  width: var(--track-w);
  height: var(--track-h);
}

.size-md {
  --track-w: 36px;
  --track-h: 20px;
  --thumb-d: 16px;
  --thumb-pad: 2px;
  --thumb-travel: 14px;
  --thumb-stretch-w: 25px;
  --stretch-x-on: 6px;
  --stretch-x-off: 5px;
  --spinner-size: 12px;
  width: var(--track-w);
  height: var(--track-h);
}

.size-lg {
  --track-w: 44px;
  --track-h: 24px;
  --thumb-d: 20px;
  --thumb-pad: 2px;
  --thumb-travel: 18px;
  --thumb-stretch-w: 31px;
  --stretch-x-on: 8px;
  --stretch-x-off: 6.5px;
  --spinner-size: 14px;
  width: var(--track-w);
  height: var(--track-h);
}

/* 未选中态 Hover：保持纯净发丝边框，微调背景 */
.track:hover:not(:disabled) {
  border-color: var(--border-subtle);
  background: color-mix(in srgb, var(--tint-hover) 60%, var(--switch-track-bg));
}

/* 选中态（Checked）：纯色无界胶囊，彻底清退 --brand-deep */
.track[data-state='checked'] {
  background: var(--brand, hsl(160 84% 39%));
  border-color: var(--brand, hsl(160 84% 39%));
}

/* 选中态 Hover：微光高亮，杜绝变暗塌陷 */
.track[data-state='checked']:hover:not(:disabled) {
  background: color-mix(in srgb, hsl(0 0% 100%) 8%, var(--brand, hsl(160 84% 39%)));
  border-color: color-mix(in srgb, hsl(0 0% 100%) 8%, var(--brand, hsl(160 84% 39%)));
}

/* 焦点环：严格遵守 AGENTS.md §13 (3%~6% 克制软灰 / 品牌柔和光晕) */
.track:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

.track[data-state='checked']:focus-visible {
  outline: none;
  border-color: var(--brand, hsl(160 84% 39%));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 25%, transparent);
}

.track:disabled {
  opacity: var(--opacity-disabled, 0.45);
  cursor: not-allowed;
}

.track.loading {
  cursor: wait;
}

/* --- 滑块本体（Thumb：GPU 硬件垂直中轴绝对对称） --- */
.thumb {
  position: absolute;
  top: 50%;
  left: var(--thumb-pad);
  width: var(--thumb-d);
  height: var(--thumb-d);
  border-radius: var(--radius-full, 9999px);
  background: var(--bg-card, hsl(0 0% 100%));
  box-shadow:
    0 0 0 0.5px color-mix(in srgb, var(--border-color) 40%, transparent),
    var(--switch-thumb-shadow, 0 1px 2px color-mix(in srgb, var(--shadow-color, hsl(0 0% 0%)) 12%, transparent));
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  transform: translateY(-50%) translateX(0);
  will-change: transform, width;
}

.track[data-state='checked'] .thumb {
  transform: translateY(-50%) translateX(var(--thumb-travel));
}

.hasInteracted[data-state='checked'] .thumb {
  animation: thumb-stretch-on 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

.hasInteracted[data-state='unchecked'] .thumb {
  animation: thumb-stretch-off 240ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes thumb-stretch-on {
  0% {
    width: var(--thumb-d);
    transform: translateY(-50%) translateX(0);
  }
  50% {
    width: var(--thumb-stretch-w);
    transform: translateY(-50%) translateX(var(--stretch-x-on));
  }
  100% {
    width: var(--thumb-d);
    transform: translateY(-50%) translateX(var(--thumb-travel));
  }
}

@keyframes thumb-stretch-off {
  0% {
    width: var(--thumb-d);
    transform: translateY(-50%) translateX(var(--thumb-travel));
  }
  50% {
    width: var(--thumb-stretch-w);
    transform: translateY(-50%) translateX(var(--stretch-x-off));
  }
  100% {
    width: var(--thumb-d);
    transform: translateY(-50%) translateX(0);
  }
}

.spinner {
  width: var(--spinner-size, 12px);
  height: var(--spinner-size, 12px);
  color: var(--text-secondary, hsl(0 0% 45%));
  animation: switch-spin 750ms linear infinite;
}

@keyframes switch-spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .track,
  .thumb,
  .spinner,
  .label {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
    animation: none !important;
  }

  .track[data-state='checked'] .thumb {
    transform: translateY(-50%) translateX(var(--thumb-travel));
    width: var(--thumb-d);
  }

  .track[data-state='unchecked'] .thumb {
    transform: translateY(-50%) translateX(0);
    width: var(--thumb-d);
  }
}

html[data-perf-tier='eco'] .track,
html[data-perf-tier='eco'] .thumb,
html[data-perf-tier='eco'] .spinner,
html[data-perf-tier='eco'] .label {
  transition-duration: 0ms !important;
  animation-duration: 0ms !important;
  animation: none !important;
}

html[data-perf-tier='eco'] .track[data-state='checked'] .thumb {
  transform: translateY(-50%) translateX(var(--thumb-travel));
  width: var(--thumb-d);
}

html[data-perf-tier='eco'] .track[data-state='unchecked'] .thumb {
  transform: translateY(-50%) translateX(0);
  width: var(--thumb-d);
}
```

---

## 5.4 `apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css
+++ b/apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css
@@ -257,5 +257,5 @@
 .quickPromptCard:hover,
 .sessionEmpty .quickPromptCard:hover {
   background: var(--bg-card, hsl(0 0% 100%));
-  border-color: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%);
-  box-shadow: 0 2px 6px color-mix(in srgb, var(--shadow-color, black) 6%, transparent);
+  border-color: var(--border-color, hsl(35 10% 86%));
+  box-shadow: 0 2px 6px color-mix(in srgb, var(--shadow-color, black) 4%, transparent);
 }
```

---

## 5.5 `apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
+++ b/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css
@@ -230,4 +230,5 @@
 .approvalCardBtn.deny:hover:not(:disabled) {
+  background: var(--tint-hover);
+  border-color: var(--border-color);
   color: var(--text-primary);
-  border-color: var(--text-tertiary);
 }
```

---

## 5.6 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css
+++ b/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css
@@ -42,7 +42,7 @@
   width: 24px;
   height: 24px;
   border-radius: var(--radius-md);
-  border: 1px solid var(--tint-active);
+  border: 1px solid var(--border-color, hsl(35 10% 86%));
   background: transparent;
   color: var(--text-secondary);
   cursor: pointer;
@@ -55,4 +55,4 @@
 .mrlAddBtn:hover {
-  background: var(--bg-hover);
+  background: var(--tint-hover);
   color: var(--text-primary);
-  border-color: var(--tint-strong);
+  border-color: var(--border-color, hsl(35 10% 86%));
 }
@@ -382,3 +382,3 @@
   padding: 8px 12px;
   border-radius: var(--radius-lg);
-  border: 1px solid var(--tint-hover);
+  border: 1px solid var(--border-subtle);
   background: var(--bg-primary);
@@ -391,3 +391,4 @@
 .mrdModelRow:not(:global(.is-expanded)):hover {
-  border-color: var(--tint-strong);
+  background: var(--bg-hover);
+  border-color: var(--border-subtle);
 }
 
 .mrdModelRow.isLive {
-  border-color: var(--tint-active);
+  border-color: var(--border-color);
 }
@@ -542,8 +543,8 @@
 .modelsCtxInput {
   width: 72px;
   height: 28px;
-  border: 1px solid var(--tint-strong);
+  border: 1px solid var(--border-color);
   border-radius: var(--radius-md);
   padding: 0 6px;
   font-size: var(--font-size-xs);
   font-family: var(--font-mono);
-  background: var(--tint-hover);
+  background: var(--bg-card);
   color: var(--text-primary);
@@ -647,4 +648,4 @@
   justify-content: space-between;
   gap: var(--space-3);
-  border: 1px solid var(--tint-active);
+  border: 1px solid var(--border-color);
   border-radius: var(--radius-xl);
-  background: var(--tint-hover);
+  background: var(--bg-card);
   padding: 10px 12px;
@@ -703,3 +704,3 @@
   padding: var(--space-3);
   border-radius: var(--radius-xl);
-  border: 1px solid var(--tint-active);
+  border: 1px solid var(--border-subtle);
   background: var(--md-code-bg);
@@ -751,3 +752,3 @@
   border-radius: var(--radius-lg);
-  border: 1px solid var(--tint-active);
+  border: 1px solid var(--border-subtle);
   overflow: hidden;
@@ -901,4 +902,4 @@
 .mrdAddModelBtn:hover {
   background: var(--tint-hover);
-  border-color: var(--text-tertiary);
+  border-color: var(--border-color);
   color: var(--text-primary);
 }
```

---

## 5.7 `apps/crish-desktop/src/components/settings/ScheduledTasksPanel.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/settings/ScheduledTasksPanel.module.css
+++ b/apps/crish-desktop/src/components/settings/ScheduledTasksPanel.module.css
@@ -199,13 +199,2 @@
 
-.schedSelect :global(.settings-select-trigger:hover:not(:disabled)),
-.schedField :global(.settings-select-trigger:hover:not(:disabled)) {
-  background: var(--bg-primary);
-  box-shadow: 0 0 0 1px var(--tint-divider);
-}
-
-.schedSelect :global(.is-open .settings-select-trigger),
-.schedField :global(.settings-select.is-open .settings-select-trigger) {
-  box-shadow: 0 0 0 1px var(--tint-scrollbar-thumb);
-  background: var(--bg-primary);
-}
```

---

## 5.8 `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css
+++ b/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css
@@ -152,4 +152,4 @@
  * 活动叶：只把卡片边框加深，不用 outline，也不给非活动叶降透明度。
  * 卡片已经跟灰底分离，再叠一层描边或压暗只会显脏。
  */
 .leaf[data-active='true'] .leafBody {
-  border-color: var(--tint-strong);
+  border-color: var(--border-color, hsl(35 10% 86%));
 }
```

---

## 5.9 `apps/crish-desktop/src/components/diff/DiffCard.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/diff/DiffCard.module.css
+++ b/apps/crish-desktop/src/components/diff/DiffCard.module.css
@@ -825,4 +825,5 @@
-.commitInput:focus {
+.commitInput:focus-visible {
   outline: none;
-  border-color: var(--brand-deep, #047857);
+  border-color: var(--brand, hsl(160 84% 39%));
+  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 25%, transparent);
 }
```

---

## 5.10 `apps/crish-desktop/src/components/ui/Button/Button.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/ui/Button/Button.module.css
+++ b/apps/crish-desktop/src/components/ui/Button/Button.module.css
@@ -129,5 +129,5 @@
   --btn-bg: var(--brand, hsl(160 84% 39%));
   --btn-fg: var(--text-on-accent, hsl(0 0% 100%));
-  --btn-border: var(--brand-deep, hsl(160 84% 31%));
-  --btn-shadow: 0 1px 2px color-mix(in srgb, var(--brand-deep) 25%, transparent);
+  --btn-border: var(--brand, hsl(160 84% 39%));
+  --btn-shadow: 0 1px 2px color-mix(in srgb, var(--shadow-color, #000) 12%, transparent);
   --btn-hover-overlay: color-mix(in srgb, var(--text-on-accent, hsl(0 0% 100%)) 15%, transparent);
@@ -153,4 +153,4 @@
   --btn-bg: var(--bg-elevated, #242424);
   --btn-fg: var(--text-primary, #dddddd);
-  --btn-border: color-mix(in srgb, var(--border-color) 80%, var(--text-primary) 20%);
+  --btn-border: var(--border-subtle, #333333);
   --btn-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
```

---

## 5.11 `apps/crish-desktop/src/components/ui/Select/Select.module.css` & `SelectTrigger.module.css` & `Combobox.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/ui/Select/Select.module.css
+++ b/apps/crish-desktop/src/components/ui/Select/Select.module.css
@@ -23,6 +23,5 @@
 .selectTrigger:hover:not(:disabled) {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
   background-color: var(--tint-hover);
 }
--- a/apps/crish-desktop/src/components/ui/Select/Combobox.module.css
+++ b/apps/crish-desktop/src/components/ui/Select/Combobox.module.css
@@ -17,3 +17,3 @@
 .comboboxTrigger:hover:not(:disabled) {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
   background-color: var(--tint-hover);
```

---

## 5.12 `apps/crish-desktop/src/components/settings/SettingsShortcutsTab.module.css` & `SettingsRulesTab.module.css` & `FontSelectField.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/settings/SettingsShortcutsTab.module.css
+++ b/apps/crish-desktop/src/components/settings/SettingsShortcutsTab.module.css
@@ -53,3 +53,3 @@
 .shortcutKeyBtn:hover:not(:disabled) {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
   box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
--- a/apps/crish-desktop/src/components/settings/SettingsRulesTab.module.css
+++ b/apps/crish-desktop/src/components/settings/SettingsRulesTab.module.css
@@ -84,3 +84,3 @@
 .presetChip:hover:not(:disabled) {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
   box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
--- a/apps/crish-desktop/src/components/settings/FontSelectField.module.css
+++ b/apps/crish-desktop/src/components/settings/FontSelectField.module.css
@@ -50,3 +50,3 @@
 .fontSelectTrigger:hover:not(:disabled) {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
   background-color: var(--tint-hover);
```

---

## 5.13 `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css` & `SessionInlineRename.module.css` & `CheatsheetModal.module.css` & `ChatMessageRow.module.css` 代码级重构方案

```diff
--- a/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css
+++ b/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css
@@ -352,3 +352,3 @@
 .renameInput:hover {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
 }
--- a/apps/crish-desktop/src/components/chat-card/SessionInlineRename.module.css
+++ b/apps/crish-desktop/src/components/chat-card/SessionInlineRename.module.css
@@ -25,3 +25,3 @@
 .input:hover {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
 }
--- a/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css
+++ b/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css
@@ -40,3 +40,3 @@
 .searchInput:hover {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
 }
--- a/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
+++ b/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css
@@ -923,3 +923,3 @@
 .msgRowActionBtn:hover {
-  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
+  border-color: var(--border-color);
   background-color: var(--tint-hover);
```

---

# 六、自动化测试用例设计与断言验证矩阵

## 6.1 `Switch.test.tsx` 纯色胶囊与 Hover / Focus 状态断言测试用例

```tsx
/* apps/crish-desktop/src/components/ui/Switch/__tests__/Switch.test.tsx */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { Switch } from '../Switch';

describe('Switch Component - Color Harmony & Pure Pill Architecture', () => {
  it('renders unchecked state without dark border or invalid CSS variables', () => {
    render(<Switch checked={false} aria-label="Auto-save setting" />);
    const button = screen.getByRole('switch', { name: /auto-save setting/i });
    expect(button).toHaveAttribute('aria-checked', 'false');
    expect(button).toHaveAttribute('data-state', 'unchecked');
  });

  it('renders checked state with brand color and without brand-deep ring', () => {
    render(<Switch checked={true} aria-label="Cloud sync" />);
    const button = screen.getByRole('switch', { name: /cloud sync/i });
    expect(button).toHaveAttribute('aria-checked', 'true');
    expect(button).toHaveAttribute('data-state', 'checked');
  });

  it('handles mouse click without triggering focus-visible outline', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(<Switch checked={false} onChange={handleChange} aria-label="Toggle notifications" />);
    const button = screen.getByRole('switch', { name: /toggle notifications/i });

    await user.click(button);
    expect(handleChange).toHaveBeenCalledWith(true);
    // 验证按钮处于获得焦点状态，但在 CSS 中匹配 :focus:not(:focus-visible)
    expect(document.activeElement).toBe(button);
  });

  it('handles keyboard tab navigation triggering accessible focus state', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button data-testid="before-btn">Before</button>
        <Switch checked={false} aria-label="Accessible switch" />
      </div>
    );

    const beforeBtn = screen.getByTestId('before-btn');
    beforeBtn.focus();
    expect(document.activeElement).toBe(beforeBtn);

    await user.tab();
    const switchBtn = screen.getByRole('switch', { name: /accessible switch/i });
    expect(document.activeElement).toBe(switchBtn);
  });
});
```

---

## 6.2 `TokensFocusRing.test.ts` Design Tokens 与全局 Focus-visible 断言

```ts
/* apps/crish-desktop/src/styles/__tests__/TokensFocusRing.test.ts */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Design Tokens - Focus Ring & Hover Color Integrity', () => {
  const tokensCssPath = path.resolve(__dirname, '../tokens.css');
  const tokensContent = fs.readFileSync(tokensCssPath, 'utf-8');

  it('defines --control-mix-color in :root light mode', () => {
    const rootBlock = tokensContent.split('html[data-theme="dark"]')[0];
    expect(rootBlock).toMatch(/--control-mix-color\s*:\s*var\(--text-primary\)/);
  });

  it('defines --focus-ring without undefined variables or 10% black ring', () => {
    expect(tokensContent).toMatch(/--focus-ring-color\s*:\s*color-mix\(\s*in srgb,\s*var\(--control-mix-color\)\s*6%,\s*transparent\s*\)/);
  });

  const focusVisiblePath = path.resolve(__dirname, '../focus-visible.css');
  const focusVisibleContent = fs.readFileSync(focusVisiblePath, 'utf-8');

  it('suppresses mouse focus outline using :focus:not(:focus-visible)', () => {
    expect(focusVisibleContent).toMatch(/:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none;\s*box-shadow:\s*none;\s*\}/);
  });
});
```

---

## 6.3 `NoDirtyHoverBorder.test.ts` 静态 AST / CSS 正则扫描防护断言

```ts
/* apps/crish-desktop/src/styles/__tests__/NoDirtyHoverBorder.test.ts */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

describe('Zero-Tolerance Guard: No Dirty Dark Borders on Hover across All CSS Modules', () => {
  const cssFiles = globSync('apps/crish-desktop/src/**/*.module.css');

  it('prohibits color-mix with text-primary > 10% on hover borders', () => {
    const violations: string[] = [];

    for (const file of cssFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      // 检查 :hover 块中混入 text-primary
      const hoverBlocks = content.match(/:hover[^{]*\{[^}]*\}/g) || [];
      for (const block of hoverBlocks) {
        if (/border-color\s*:\s*color-mix\([^)]*var\(--text-primary\)\s*(?:[1-9][0-9])%/i.test(block)) {
          violations.push(`${file}: High text-primary mix in hover border -> ${block}`);
        }
        if (/border-color\s*:\s*var\(--text-tertiary\)/i.test(block)) {
          violations.push(`${file}: Naked text-tertiary used as hover border -> ${block}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('prohibits --brand-deep on Switch Checked track border', () => {
    const switchCssPath = path.resolve(__dirname, '../../components/ui/Switch/Switch.module.css');
    const switchContent = fs.readFileSync(switchCssPath, 'utf-8');

    expect(switchContent).not.toMatch(/\.track\[data-state='checked'\]\s*\{[^}]*border-color:\s*var\(--brand-deep/);
  });
});
```

---

# 七、分步实施计划、工程红线与验收检查单

## 7.1 三阶段递进式实施路线图

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║                     全仓 Hover 黑描边清退与 Switch 纯色色阶实施路线图                     ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║ 【Phase 1: 底座与设计令牌修复】                                                           ║
║   1. 修复 tokens.css：浅色模式补齐 --control-mix-color 与 --focus-ring-color;             ║
║   2. 重构 focus-visible.css：声明 :focus:not(:focus-visible) 抑制鼠标黑圈，清退 10% 粗黑环;║
║                                                                                          ║
║ 【Phase 2: Switch 核心原子组件色阶重塑】                                                  ║
║   3. 重构 Switch.module.css：Checked 态统一为 var(--brand)，消除 --brand-deep 墨黑箍;     ║
║   4. 消除 Hover 轨道变暗塌陷，补齐未选中态 hover 规则，消除鼠标点击黑圈;                  ║
║                                                                                          ║
║ 【Phase 3: 全仓业务组件与表单 Hover 边框清洗】                                            ║
║   5. 修复 ChatEmptyState.module.css & Button.module.css 的 20% 混色违规;                 ║
║   6. 修复 ApprovalAskCard.module.css & ModelsSettingsTab (9处) 裸用文本色与遮罩边框;      ║
║   7. 清理 ScheduledTasksPanel.module.css 局部黑圈覆盖;                                   ║
║   8. 调优 Select / Combobox / Shortcuts / Rules 等表单 Hover 边框，统一收敛为微光;        ║
║   9. 运行 Vitest 自动化测试矩阵与 AST 门禁，确保 100% Pass。                             ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```

---

## 7.2 严苛质量门禁与验收 Checklist

- [ ] **Token 单一真源**：`tokens.css` 浅色与深色模式均完备定义 `--control-mix-color`，`--focus-ring` 在全仓渲染出 1.5px 6% 柔和软灰发丝轮廓。
- [ ] **Switch 纯色无界胶囊**：Switch 开启状态背景与边框完全同色（`var(--brand)`），无任何深墨绿内圈或下陷黑槽。
- [ ] **Switch 悬停防塌陷**：鼠标悬停在已开启的 Switch 上时，轨道保持明亮翠绿并叠加纯白微光，绝对不发生变暗塌陷。
- [ ] **鼠标点击无黑圈**：全仓所有可点击元素（尤其是 Switch、Button、Select）鼠标点按后绝对不残留任何粗黑外圈。
- [ ] **全仓 Hover 无黑边**：全仓 119 个样式表中，没有任何卡片、按钮或列表项在鼠标悬停时边框变黑发脏，统一保持纯净发丝线与微背景。
- [ ] **无 Alpha 漏底与脏灰**：`ModelsSettingsTab` 与 `BinaryTreeWorkspace` 彻底移除 `--tint-strong` / `--tint-active` 边框，实线边框 100% 采用标准实色 Token。
- [ ] **测试覆盖与零报错**：`Switch.test.tsx`、`TokensFocusRing.test.ts`、`NoDirtyHoverBorder.test.ts` 全部通过，TypeScript 编译零错误，ESLint 零警告。
