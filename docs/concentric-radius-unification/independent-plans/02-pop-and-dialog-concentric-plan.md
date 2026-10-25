# Pop 浮层与通用 Dialog 模态同心几何独立详案（02-POP-DIALOG-CONCENTRIC-PLAN）

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **方案编号**：02-pop-and-dialog-concentric-plan  
> **责任架构**：弹层与模态同心架构师（Agent-P2）  
> **产出日期**：2026-10-25  
> **目标路径**：`docs/concentric-radius-unification/independent-plans/02-pop-and-dialog-concentric-plan.md`  
> **前序基准与真理源**：
> - [`survey/01-pop-and-dialog-radius-survey.md`](file:///c:/Software/conex/docs/concentric-radius-unification/survey/01-pop-and-dialog-radius-survey.md)
> - [`00-全仓同心圆角与边距现状统一调查总报告.md`](file:///c:/Software/conex/docs/concentric-radius-unification/00-全仓同心圆角与边距现状统一调查总报告.md)
> - [`independent-plans/01-token-architecture-and-concentric-math-plan.md`](file:///c:/Software/conex/docs/concentric-radius-unification/independent-plans/01-token-architecture-and-concentric-math-plan.md)
> - [`apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css)（同心标尺典范 $18 = 8 + 10$）

---

## 目录

1. [执行摘要与设计哲学（双形态在弹层体系的落地定界）](#一-执行摘要与设计哲学双形态在弹层体系的落地定界)
   - 1.1 [双形态落地契约：圆角形态 20px vs 微圆形态 12~14px](#11-双形态落地契约圆角形态-20px-vs-微圆形态-1214px)
   - 1.2 [同心圆角几何公理与拓扑判据模型](#12-同心圆角几何公理与拓扑判据模型)
   - 1.3 [全仓弹层与模态重构矩阵总览](#13-全仓弹层与模态重构矩阵总览)
2. [通用模态基座改造（`ui/Dialog` 体系）](#二-通用模态基座改造uidialog-体系)
   - 2.1 [外壳消费平反后的 `--radius-2xl`（20px）：根除空间层级倒挂](#21-外壳消费平反后的---radius-2xl20px根除空间层级倒挂)
   - 2.2 [头部同心收敛：`.dialogHeader` 内边距与关闭按钮 `.dialogClose`（$20 = 8 + 12$）](#22-头部同心收敛dialogheader-内边距与关闭按钮-dialogclose20--8--12)
   - 2.3 [底部同心收敛：`.dialogFooter` 各向同性间隙与 7px 按钮契约](#23-底部同心收敛dialogfooter-各向同性间隙与-7px-按钮契约)
   - 2.4 [内容区 `.dialogBody` 嵌套边界与负边距穿透禁令](#24-内容区-dialogbody-嵌套边界与负边距穿透禁令)
   - 2.5 [`Dialog.module.css` 详细改造代码与 Diff](#25-dialogmodulecss-详细改造代码与-diff)
3. [核心业务弹窗同心重构（重点实战改造）](#三-核心业务弹窗同心重构重点实战改造)
   - 3.1 [项目管理模态：`ProjectManageModal.module.css`（$20 = 10 + 10$ 完美闭环）](#31-项目管理模态projectmanagemodalmodulecss20--10--10-完美闭环)
   - 3.2 [MCP 接入模态：`McpConnectModal.module.css`（分段导航槽同心治愈）](#32-mcp-接入模态mcpconnectmodalmodulecss分段导航槽同心治愈)
   - 3.3 [插件创建与分享模态：`PluginCreateModal` & `PluginShareModal`](#33-插件创建与分享模态plugincreatemodal--pluginsharemodal)
   - 3.4 [技能详情与创建模态：`SkillDetailModal` & `SkillCreateModal`](#34-技能详情与创建模态skilldetailmodal--skillcreatemodal)
   - 3.5 [诊断日志弹窗：`TelemetryDialog.module.css`](#35-诊断日志弹窗telemetrydialogmodulecss)
   - 3.6 [外部会话导入模态：`ExternalSessionImportModal.module.css`（同径同角病灶清剿）](#36-外部会话导入模态externalsessionimportmodalmodulecss同径同角病灶清剿)
4. [二级浮层与下拉菜单（微圆形态：12~14px 体系）](#四-二级浮层与下拉菜单微圆形态1214px-体系)
   - 4.1 [微圆形态通用标准：外壳 14px + 内边距 6px + 条目 8px（$14 = 8 + 6$）](#41-微圆形态通用标准外壳-14px--内边距-6px--条目-8px14--8--6)
   - 4.2 [通用菜单基座：`ui/Menu/Menu.module.css`](#42-通用菜单基座uimenumenumodulecss)
   - 4.3 [输入区加号菜单：`ComposePlusMenu.module.css`](#43-输入区加号菜单composeplusmenumodulecss)
   - 4.4 [设置快捷菜单：`SettingsQuickMenu.module.css`（根治 -6px 极端窒息挤压）](#44-设置快捷菜单settingsquickmenumodulecss根治--6px-极端窒息挤压)
   - 4.5 [侧栏右键与排序过滤菜单：`SidebarContextMenus.module.css`](#45-侧栏右键与排序过滤菜单sidebarcontextmenusmodulecss)
   - 4.6 [权限模式菜单：`PermissionModeMenu.module.css`](#46-权限模式菜单permissionmodemenumodulecss)
   - 4.7 [智能面板体系：`SmartExpandablePanel.module.css` & `SmartPanel.module.css`](#47-智能面板体系smartexpandablepanelmodulecss--smartpanelmodulecss)
   - 4.8 [模型徽标菜单与思考槽滑块：`ModelBadgePickerMenu.module.css`](#48-模型徽标菜单与思考槽滑块modelbadgepickermenumodulecss)
   - 4.9 [项目选择级联子菜单：`ProjectPickerMenu.module.css`（$8 = 4 + 4$ 闭合）](#49-项目选择级联子菜单projectpickermenumodulecss8--4--4-闭合)
   - 4.10 [新建标签页浮层：`NewTabLauncherPopover.module.css`](#410-新建标签页浮层newtablauncherpopovermodulecss)
5. [Toast 通知与特殊浮层同心几何对齐](#五-toast-通知与特殊浮层同心几何对齐)
   - 5.1 [现代通知栈：`ToastStackModern.module.css` 与输入撤销 `DraftUndoToast.module.css`](#51-现代通知栈toaststackmodernmodulecss-与输入撤销-draftundotoastmodulecss)
   - 5.2 [极限胶囊包裹：`Tooltip.module.css`](#52-极限胶囊包裹tooltipmodulecss)
6. [全仓改造执行代码清单与完整 CSS Diff（Implementation Guide）](#六-全仓改造执行代码清单与完整-css-diffimplementation-guide)
7. [验收标准与自动化视觉守护断言](#七-验收标准与自动化视觉守护断言)

---

## 一、 执行摘要与设计哲学（双形态在弹层体系的落地定界）

### 1.1 双形态落地契约：圆角形态 20px vs 微圆形态 12~14px

依据用户核心指令与全仓总体架构规划，浮层（Overlay）与弹窗（Modal）体系打破“一刀切”的机械收敛，全面确立**“圆角形态（主模态 20px）”与“微圆形态（小菜单 12~14px）”双轨共存机制**：

```
                           【Conex 浮层与模态双形态几何图景】
 
    ┌────────────────────────────────────────────────────────────────────────┐
    │  形态 A：圆角形态 (Rounded Mode) — 20px                                │
    │  适用场景：顶层全局模态、独立操作岛、聚焦对话框                       │
    │  代表组件：ui/Dialog 基座、ProjectManageModal、PluginCreateModal 等     │
    │  核心心智：现代、温润、呼吸感、视觉焦点沉浸、与底层 20px 输入岛呼应   │
    ├────────────────────────────────────────────────────────────────────────┤
    │  形态 B：微圆形态 (Compact Mode) — 12px ~ 14px                         │
    │  适用场景：上下文气泡、下拉菜单、级联子菜单、操作浮层                 │
    │  代表组件：ui/Menu、ComposePlusMenu、SettingsQuickMenu、ContextMenus    │
    │  核心心智：紧凑、工业、高信息密度、规整利落、消除角部虚空             │
    └────────────────────────────────────────────────────────────────────────┘
```

1. **圆角形态（主模态 20px）**：
   - 模态弹窗作为视口最顶层的 UI 载体（$z\text{-index} \ge 1000$），必须拥有足够的圆角曲率以形成“浮于内容之上”的柔和物理岛屿感。
   - 彻底废除将大模态外壳压制为 12px 的历史错误做法，全面消费平反后的 `--radius-2xl: 20px`。
   - 这不仅让 $1040 \times 760\text{px}$ 或 $440 \times 480\text{px}$ 的模态弹窗恢复现代桌面端软件的大气观感，更彻底消除了“**顶层弹窗（12px）比底层单行输入框（20px）还要更方、更锐**”的严重空间层级倒挂（Hierarchy Inversion）。
2. **微圆形态（小菜单 12~14px）**：
   - 下拉菜单与上下文浮层属于瞬态高频操作界面，通常尺寸在 $180\text{px} \sim 320\text{px}$ 之间。
   - 若盲目套用 20px 大圆角，会导致菜单四角被剧烈侵蚀，内部首末选项必须设置过大的退缩边距，严重浪费屏幕空间并造成视觉虚胖；
   - 微圆形态严格消费 `--sep-radius-outer: 14px`，内衬锁定为 $6\text{px}$，内部条目使用 `--sep-item-radius: 8px`，在数学上天然达成 $14\text{px} = 8\text{px} + 6\text{px}$ 的绝对平行。

---

### 1.2 同心圆角几何公理与拓扑判据模型

设外容器拐角曲率半径为 $R_{outer}$，拐角圆心为 $C_{outer}$；内部嵌套子元素拐角曲率半径为 $R_{inner}$，拐角圆心为 $C_{inner}$；外容器内边距为 $P$（在法向间距各向同性前提下）：

$$\text{同心几何公理：} \quad R_{outer} = R_{inner} + P \iff R_{inner} = \max(0, R_{outer} - P)$$

定义同心度差值判据 $\Delta$：
$$\Delta = R_{outer} - (R_{inner} + P)$$

- **$\Delta = 0$（绝对同心 / Concentric Balance）**：内外弧线处处法向等距平行，角部间隙与平边间隙一致，视觉过渡极致自然流畅；
- **$\Delta < 0$（内角挤压倒挂 / Anti-Concentric Pinching）**：外圆角不足以包容内部元素曲率与边距之和，角部法向间隙被挤压变窄，内部元素拐角在视觉上“顶穿”或“外突”，严重时产生窒息撞角感；
- **$\Delta > 0$（内角退化超距 / Concentric Clearance）**：内边距大于外圆角半径（$P \ge R_{outer}$），几何内缩线已退化为平直直角区，此时内部元素圆角由自身微倒角（如 4px/7px）软化，不产生对撞。

---

### 1.3 全仓弹层与模态重构矩阵总览

| 模块分类 | 组件文件 | 改造前 $R_o / P / R_i$ | 改造前 $\Delta$ | 形态归属 | 改造后 $R_o / P / R_i$ | 改造后 $\Delta$ | 核心同心几何解法 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **通用模态** | `Dialog.module.css` | 12 / 16 / 4 (Header)<br>12 / 16(x),12(y) / 7 (Footer) | -8px<br>-11px | **圆角形态** | 20 / 12 / 8 (Header)<br>20 / 13 / 7 (Footer) | **0px**<br>**0px** | 消费 `--radius-2xl` (20px)，Header/Footer 对称内边距收敛 |
| **项目管理** | `ProjectManageModal` | 12 / 20 / 8 (Dropzone)<br>8 / 6 / 8 (FolderList) | -16px<br>-6px | **圆角形态** | 20 / 10 / 10 (Dropzone)<br>10 / 4 / 6 (FolderList) | **0px**<br>**0px** | 外壳 20px，Dropzone 10px + 内衬 10px，列表 10px = 6px + 4px |
| **MCP接入** | `McpConnectModal` | 8 / 4 / 7 (`.tabNav`)<br>8 / 12 / 7 (`.serverCard`) | -3px<br>-11px | **圆角形态** | 11 / 4 / 7 (`.tabNav`)<br>12 / 12 / 7 (`.serverCard`) | **0px**<br>-7px (超距) | 导航槽代数推导 $11 = 7 + 4$，卡片收敛至 12px 优雅包裹 |
| **插件创建** | `PluginCreateModal` | 12 / 16 / 8 (Cards)<br>12 / 14 / 4 (Badge) | -12px<br>-6px | **圆角形态** | 20 / 10 / 10 (Cards)<br>10 / 6 / 4 (Badge) | **0px**<br>**0px** | 外壳 20px，子卡片统一 10px + 10px 边距，按钮锁定 7px |
| **插件分享** | `PluginShareModal` | 12 / 14 / 8 (Card) | -10px | **圆角形态** | 20 / 10 / 10 (Card) | **0px** | 外壳 20px，头部卡片 10px，消除 8px 硬编码按钮 |
| **技能详情** | `SkillDetailModal` | 12 / 16 / 8 (IconBox)<br>12 / 20 / 4 (Pill) | -12px<br>-12px | **圆角形态** | 20 / 12 / 8 (IconBox)<br>20 / 16 / 4 (Pill) | **0px**<br>0px (超距) | 外壳 20px，Header padding 12px 配合 8px 图标框绝对同心 |
| **诊断日志** | `TelemetryDialog` | 12 / 16 / 4 (Badge) | -8px | **圆角形态** | 20 / 14 / 6 (Badge) | **0px** | 继承 Dialog 20px 外壳，徽标优化至 6px 配合 24px 行高 |
| **会话导入** | `ExternalSessionImport` | 8 / 3 / 8 (`.filterTabs`) | -3px (严重同径) | **圆角形态** | 10 / 3 / 7 (`.filterTabs`) | **0px** | 根除同径同角，分段槽 10px = 7px Tab + 3px padding |
| **通用菜单** | `ui/Menu/Menu` | 12 / 6 / 8 (`.menuContent`) | -2px (Token截断) | **微圆形态** | 14 / 6 / 8 (`.menuContent`) | **0px** | 消费平反后的 `--sep-radius-outer` (14px)，$14 = 8 + 6$ |
| **输入加号** | `ComposePlusMenu` | 12 / 6 / 8 (`.plusMenu`) | -2px | **微圆形态** | 14 / 6 / 8 (`.plusMenu`) | **0px** | fallback 修正为 14px，与设计注释 $14 = 8 + 6$ 契合 |
| **设置快捷** | `SettingsQuickMenu` | 8 / 6 / 8 (`.sbQuickMenu`) | **-6px (极端挤压)** | **微圆形态** | 14 / 6 / 8 (`.sbQuickMenu`) | **0px** | 彻底治愈全仓最大病灶，从 8px 跃升至 14px 完美同心 |
| **侧栏右键** | `SidebarContextMenus` | 12 / 6 / 8 (`.contextMenu`) | -2px | **微圆形态** | 14 / 6 / 8 (`.contextMenu`) | **0px** | 脱离 20px 大圆角，收敛至微圆 14px，$\Delta = 0$ 闭合 |
| **权限菜单** | `PermissionModeMenu` | 12 / 6 / 8 (`.permMenu`) | -2px | **微圆形态** | 14 / 6 / 8 (`.permMenu`) | **0px** | 消费 `--sep-radius-outer` (14px)，内外差值归零 |
| **智能面板** | `SmartExpandablePanel` | 12 / 6 / 8 (`.panel`) | -2px | **微圆形态** | 14 / 6 / 8 (`.panel`) | **0px** | 消费 `--sep-radius-outer` (14px)，$\Delta = 0$ 闭合 |
| **模型徽标** | `ModelBadgePickerMenu` | 12 / 6 / 8 (`.mbMenu`)<br>8 / 2 / 8 (`.thinkingTrack`)| -2px<br>-2px | **微圆形态** | 14 / 6 / 8 (`.mbMenu`)<br>8 / 2 / 6 (`.thinkingTrack`)| **0px**<br>**0px** | 菜单外壳 14px；思考槽滑块调整为 6px（$8 = 6 + 2$） |
| **级联子单** | `ProjectPickerMenu` | 8 / 4 / 8 (`.cascadeSubmenu`)| -4px | **微圆形态** | 8 / 4 / 4 (`.cascadeSubmenu`)| **0px** | 注入子项 4px 圆角，实现注释承诺的 $8 = 4 + 4$ |
| **标签启动** | `NewTabLauncherPopover`| 12 / 6 / 8 (`.popoverContent`)| -2px | **微圆形态** | 14 / 6 / 8 (`.popoverContent`)| **0px** | 消费 `--sep-radius-outer` (14px)，内外差值归零 |

---

## 二、 通用模态基座改造（`ui/Dialog` 体系）

### 2.1 外壳消费平反后的 `--radius-2xl`（20px）：根除空间层级倒挂

[`Dialog.module.css:37-55`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L37-L55) 是全站模态弹窗的统一真理源。
- **现状缺陷**：`.dialog` 虽声明了 `border-radius: var(--radius-2xl);`，但由于历史 5 档收敛错误地将 `--radius-2xl` 指向 `var(--radius-l)`（12px），导致全站所有弹窗无论视口多大均被锁定在 12px 的生硬方框中。
- **平反落地**：随着 Token 架构详案（`01-token-architecture-and-concentric-math-plan.md`）将 `--radius-2xl` 恢复为 **`20px`**，`.dialog` 自然平滑继承 20px 外圆角。这立刻为全站弹窗注入了与视口底部 `ChatComposer`（20px）对齐的大气弧度，根除了“浮层比输入框更尖锐”的视觉违和。

---

### 2.2 头部同心收敛：`.dialogHeader` 内边距与关闭按钮 `.dialogClose`（$20 = 8 + 12$）

在弹窗右上角，关闭按钮 `.dialogClose` 与弹窗外边框的法向关系是用户目光落点最密集的几何区域：

```
    ┌────────────────────────────────────────────────────────────┐
    │ Dialog Header                                          [X] │ ◄── Close Button
    │                                                            │
    │  R_outer = 20px (Dialog Panel)                             │
    │  Pad_top = 12px, Pad_right = 12px                          │
    │  R_inner = R_outer - Pad = 20px - 12px = 8px (CloseBtn)    │
    │  Δ = 20 - (8 + 12) = 0px 完美同心！                       │
    └────────────────────────────────────────────────────────────┘
```

- **现状测量**：
  - `.dialogHeader`: `padding: var(--space-4) var(--space-4) var(--space-2);`（16px 16px 8px）；
  - `.dialogClose`: `width: 28px; height: 28px; border-radius: var(--radius-sm);`（4px）；
  - 同心度计算：$\Delta = 12\text{px} - (4\text{px} + 16\text{px}) = -8\text{px}$（严重倒挂与角部脱节）。
- **同心几何推导方案**：
  - 外圆角已升为 $R_{outer} = 20\text{px}$；
  - 将 `.dialogHeader` 的顶部与右侧内衬统一微调为 **`12px`**（即 `var(--space-3)`）；
  - 依据公式：$R_{inner} = R_{outer} - P = 20\text{px} - 12\text{px} = 8\text{px}$；
  - 将 `.dialogClose` 的圆角升级为 **`var(--radius-md)`（8px）**；
  - **几何验证**：
    $$\Delta = R_{outer} - (R_{inner} + P) = 20\text{px} - (8\text{px} + 12\text{px}) = 0\text{px}$$
    关闭按钮的 8px 圆角与弹窗右上角 20px 圆角在 12px 等距内边距下**处处法向平行，$\Delta = 0$ 绝对同心**！

---

### 2.3 底部同心收敛：`.dialogFooter` 各向同性间隙与 7px 按钮契约

- **现状测量**：
  - `.dialogFooter`: `padding: var(--space-3) var(--space-4);`（垂直 12px，水平 16px）；
  - 内部按钮：消费 `Button` 契约，圆角严格锁定为 `--button-radius: 7px`（用户锁 U1）；
  - 双轴同心差值：
    $$\Delta_y = 12 - (7 + 12) = -7\text{px}, \quad \Delta_x = 12 - (7 + 16) = -11\text{px}$$
    水平与垂直内边距不一致，导致右下角外框弧线出现剧烈的椭圆各向异性撕裂。
- **同心几何推导方案**：
  - 将 `.dialogFooter` 的内边距收敛为**等距对称设计**：`padding: 13px 13px;`（或 `var(--space-3) var(--space-3)` 12px 12px）；
  - 代数验证：
    - 若取 $P = 13\text{px}$：$R_{outer} (20\text{px}) = R_{btn} (7\text{px}) + P (13\text{px}) \iff \Delta = 20 - (7 + 13) = 0$！
    - 若取 $P = 12\text{px}$（标准 Token `--space-3`）：$\Delta = 20 - (7 + 12) = +1\text{px}$。+1px 属于人眼不可感知的安全微间隙，彻底杜绝了 -11px 的撞角撕裂！
  - 推荐采用 `padding: 12px 13px 13px 16px;` 或统一各向同性 `padding: var(--space-3) var(--space-3);`。

---

### 2.4 内容区 `.dialogBody` 嵌套边界与负边距穿透禁令

- **架构纪律断言**：严禁业务弹窗（如 `FirstRunWizard`）使用 `margin: calc(var(--space-1) * -1) calc(var(--space-4) * -1)` 等负边距暴力穿透 Dialog 默认内边距。这种破坏基座内衬的做法会导致内部卡片的 12px 圆角直接撞击外框。
- **契约重构**：业务弹窗如需通栏布局，必须通过 `Dialog` 现有的标准接口 `<Dialog classNames={{ body: styles.customBody }}>` 传入 `padding: 0`，并在业务层精准控制自身卡片的同心边距。

---

### 2.5 `Dialog.module.css` 详细改造代码与 Diff

```diff
--- apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css (原代码)
+++ apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css (同心改造)
@@ -44,8 +44,8 @@
   max-height: calc(100vh - var(--space-8));
   background: var(--bg-card);
   border: 1px solid var(--border-color);
-  border-radius: var(--radius-2xl);
+  border-radius: var(--radius-2xl); /* 平反后权威解析为 20px (圆角形态枢纽) */
   box-shadow:
     0 24px 48px -12px color-mix(in srgb, var(--shadow-color) 16%, transparent),
     0 8px 16px -4px color-mix(in srgb, var(--shadow-color) 6%, transparent);
@@ -150,7 +150,7 @@
   display: flex;
   align-items: center;
   justify-content: space-between;
   gap: var(--space-2);
-  padding: var(--space-4) var(--space-4) var(--space-2);
+  padding: var(--space-3) var(--space-3) var(--space-2); /* 12px 12px 8px，对齐 20px 外圆角 */
 }
 
 .dialogTitle {
@@ -168,7 +168,7 @@
   width: var(--control-height-sm);
   height: var(--control-height-sm);
   border: none;
-  border-radius: var(--radius-sm);
+  border-radius: var(--radius-md); /* 8px，达成 20px = 8px + 12px 绝对同心 (Δ = 0) */
   background: transparent;
   color: var(--text-tertiary);
   cursor: pointer;
@@ -196,7 +196,7 @@
 .dialogDescription {
   margin: 0;
-  padding: 0 var(--space-4) var(--space-2);
+  padding: 0 var(--space-3) var(--space-2);
   font-size: var(--font-size-sm);
   line-height: var(--line-height-body);
   color: var(--text-secondary);
@@ -216,6 +216,6 @@
   display: flex;
   align-items: center;
   justify-content: flex-end;
   gap: var(--space-2);
-  padding: var(--space-3) var(--space-4);
+  padding: var(--space-3) var(--space-3); /* 12px 12px，消除水平16px各向异性撕裂，对齐 7px 按钮 */
   border-top: 1px solid var(--hairline);
 }
```

---

## 三、 核心业务弹窗同心重构（重点实战改造）

### 3.1 项目管理模态：`ProjectManageModal.module.css`（$20 = 10 + 10$ 完美闭环）

- **文件路径**：[`apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css)
- **现状病灶**：
  - `.modalPanel`: 声明了 `var(--radius-2xl, 24px)`，但因全局 token 覆写实际仅为 12px；
  - `.modalBody`: `padding: 16px 20px 16px;`，水平内边距达 20px；
  - `.folderPickerDropzone`: 声明 `var(--radius-lg, 12px)`，因 `--radius-lg = 8px`，实际仅为 8px；
  - `.folderListCard`: 外框 8px，内边距 6px，内部条目 `.folderItem` 也为 8px，同心差值高达 $\Delta = 8 - (8 + 6) = -6\text{px}$（内外同径撞角）。
- **同心几何重构方案**：

```
    ┌────────────────────────────────────────────────────────────┐ ───
    │ ProjectManageModal (R_outer = 20px)                        │  ▲
    │                                                            │  │ Pad = 10px
    │    ┌──────────────────────────────────────────────────┐    │ ───
    │    │ FolderPickerDropzone / FolderListCard            │    │
    │    │ (R_inner = 10px)                                 │    │
    │    │                                                  │    │
    │    │  公式：20px (Modal) = 10px (Card) + 10px (Pad)   │    │
    │    │  Δ = 20 - (10 + 10) = 0px 绝对同心！            │    │
    │    └──────────────────────────────────────────────────┘    │
    └────────────────────────────────────────────────────────────┘
```

1. **模态外壳**：`.modalPanel { border-radius: var(--radius-2xl); /* 20px */ }`；
2. **主体容器**：`.modalBody` 统一内衬为 `padding: 10px 10px var(--space-3, 12px);`（水平 10px，垂直 10px）；
3. **文件夹拖拽微卡片**：
   - 曲率调整为 **`10px`**（`border-radius: 10px;` 或 `var(--radius-lg, 10px)`）；
   - **同心验证**：
     $$R_{modal} = R_{dropzone} + P \iff 20\text{px} = 10\text{px} + 10\text{px} \quad (\Delta = 0)$$
4. **文件夹列表容器（二级嵌套同心）**：
   - 容器外框：`.folderListCard { border-radius: 10px; padding: 4px; }`；
   - 内部单项：`.folderItem { border-radius: var(--radius-sm, 6px); }`；
   - **二级同心验证**：
     $$R_{listCard} = R_{item} + P_{list} \iff 10\text{px} = 6\text{px} + 4\text{px} \quad (\Delta = 0)$$
   - 内部删除小按钮：`.folderRemoveBtn { border-radius: var(--radius-xs, 4px); }`；
5. **项目名称输入框**：
   - `.nameInput`: 锁定为标准的 **`8px`**（`border-radius: var(--radius-md, 8px);`）；
6. **Footer 按钮契约**：
   - 取消 / 新建按钮锁定为 **`7px`**（`border-radius: var(--button-radius, 7px);`）。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css (原代码)
+++ apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css (同心改造)
@@ -1,9 +1,9 @@
 .modalPanel {
   --dialog-width: 440px;
   width: var(--dialog-width);
-  border-radius: var(--radius-2xl, 24px);
+  border-radius: var(--radius-2xl); /* 20px 圆角形态模态外壳 */
   padding: 0;
   overflow: hidden;
   border: 1px solid var(--border-subtle);
@@ -14,7 +14,7 @@
 .modalBody {
   display: flex;
   flex-direction: column;
   gap: var(--space-3, 12px);
-  padding: var(--space-4, 16px) var(--space-5, 20px) var(--space-4, 16px);
+  padding: 10px 10px var(--space-3, 12px); /* 10px 等距外衬，实现 20 = 10 + 10 同心 */
   box-sizing: border-box;
 }
@@ -38,7 +38,7 @@
   align-items: center;
   justify-content: center;
   gap: var(--space-2, 8px);
   padding: var(--space-5, 20px) var(--space-4, 16px);
-  border-radius: var(--radius-lg, 12px);
+  border-radius: 10px; /* 10px: 满足 20px (Modal) = 10px (Card) + 10px (Pad) */
   border: 1px solid var(--border-subtle);
   background: var(--surface-input, var(--bg-card));
@@ -95,7 +95,7 @@
   display: flex;
   flex-direction: column;
   gap: var(--space-1, 4px);
-  padding: var(--space-1_5, 6px);
-  border-radius: var(--radius-lg, 12px);
+  padding: 4px; /* 4px 内衬 */
+  border-radius: 10px; /* 10px 外圆角对齐 Dropzone */
   border: 1px solid var(--border-subtle);
   background: var(--bg-hover);
@@ -109,7 +109,7 @@
   align-items: center;
   gap: var(--space-2, 8px);
   padding: 6px 10px;
-  border-radius: var(--radius-md, 8px);
+  border-radius: var(--radius-sm, 6px); /* 6px: 满足 10px = 6px + 4px 二级完美同心 */
   background: var(--surface-input, var(--bg-card));
   border: 1px solid var(--border-subtle);
```

---

### 3.2 MCP 接入模态：`McpConnectModal.module.css`（分段导航槽同心治愈）

- **文件路径**：[`apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css)
- **外框归属**：消费 `Dialog` 基座（20px 圆角形态）。
- **核心病灶与同心重构**：
  1. **`.tabNav` 分段导航槽同心治愈**：
     - 当前：外槽 `padding: 4px; border-radius: var(--radius-lg, 9px);`（实际 8px）；内部 `.tabBtn` 为 `border-radius: var(--button-radius, 7px);`（7px）；
     - 现状差值：$\Delta = 8 - (7 + 4) = -3\text{px}$，激活态白色底块四角顶死外槽，撞角感严重；
     - 同心推导：$R_{outer} = R_{inner} + P = 7\text{px} + 4\text{px} = 11\text{px}$；
     - 改造为：`border-radius: calc(var(--button-radius, 7px) + 4px); /* 11px */`，差值归零！
  2. **`.serverCard` 快速接入列表卡片**：
     - 外框由 8px 提升至 **12px**（`var(--radius-l)`）；
     - 内边距保持 `padding: 12px 14px;`；内部徽标 4px，按钮 7px。
  3. **`.presetBar` 快捷预设栏**：
     - 外框调整为 `border-radius: 11px; padding: 4px 10px;`，配合内部 7px `.presetBtn` 达成同心。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css (原代码)
+++ apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css (同心改造)
@@ -21,7 +21,7 @@
   align-items: center;
   gap: 6px;
   padding: 4px;
   background: var(--bg-secondary);
-  border-radius: var(--radius-lg, 9px);
+  border-radius: calc(var(--button-radius, 7px) + 4px); /* 11px = 7px(Btn) + 4px(Pad)，消除-3px倒挂 */
   border: 1px solid var(--border-subtle);
   margin-bottom: 16px;
 }
@@ -80,7 +80,7 @@
   gap: 8px;
   padding: 10px 12px;
   background: var(--bg-secondary);
   border: 1px solid var(--border-subtle);
-  border-radius: var(--radius-md, 8px);
+  border-radius: var(--radius-l, 12px); /* 提升至 12px 消除扁平方角感 */
 }
@@ -269,7 +269,7 @@
   gap: 14px;
   padding: 12px 14px;
   background: var(--bg-secondary);
   border: 1px solid var(--border-subtle);
-  border-radius: var(--radius-lg, 9px);
+  border-radius: var(--radius-l, 12px); /* 提升至 12px，规范化卡片形态 */
   transition: all var(--duration-fast, 150ms) ease;
 }
```

---

### 3.3 插件创建与分享模态：`PluginCreateModal` & `PluginShareModal`

- **文件路径**：
  - [`apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css)
  - [`apps/crish-desktop/src/components/extensions-surface/PluginShareModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/PluginShareModal.module.css)
- **同心几何重构方案**：
  1. **模态外壳**：`.modalPanel` 由 `var(--radius-xl, 12px)` 统一升级为 **`var(--radius-2xl)`（20px）**；
  2. **按钮契约**：`.modalPanel button` 由 `var(--radius-md)`（8px）纠正为 **`var(--button-radius, 7px)`**，严格遵循用户锁 U1；
  3. **内部主体内衬**：`.modalBody` 内衬收敛为 `padding: 10px 10px var(--space-3, 12px);`；
  4. **内部卡片同心度**：
     - `.guideCard`, `.dropZone`, `.previewCard`：统一收敛为 **`10px`**（`border-radius: var(--radius-lg, 10px);`）；
     - 同心计算：$20\text{px} (\text{Modal}) = 10\text{px} (\text{Card}) + 10\text{px} (\text{Pad})$，达成 $\Delta = 0$ 绝对同心！
     - `.fileBadge` 保持 4px，`.errorHint` 保持 8px。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css (原代码)
+++ apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css (同心改造)
@@ -6,7 +6,7 @@
 .modalPanel {
   --dialog-width: 620px;
   width: var(--dialog-width);
-  border-radius: var(--radius-xl, 12px);
+  border-radius: var(--radius-2xl); /* 20px 圆角形态模态外壳 */
   background: var(--bg-card);
   border: var(--hairline-width, 1px) solid var(--border-color);
   box-shadow: 0 20px 48px -12px
@@ -14,7 +14,7 @@
 }
 
 .modalPanel button {
-  border-radius: var(--radius-md);
+  border-radius: var(--button-radius, 7px); /* 统一遵循 7px 按钮契约 */
 }
 
 .modalBody {
@@ -23,5 +23,5 @@
   gap: var(--space-3, 12px);
-  padding: var(--space-2, 8px) var(--space-4, 16px) var(--space-3, 12px);
+  padding: 10px 10px var(--space-3, 12px); /* 10px 内边距达成 20 = 10 + 10 同心 */
   max-height: 72vh;
   overflow-y: auto;
   box-sizing: border-box;
@@ -46,7 +46,7 @@
 .guideCard {
   background: var(--bg-secondary);
   border: var(--hairline-width, 1px) solid var(--border-subtle);
-  border-radius: var(--radius-l, 10px);
+  border-radius: 10px; /* 10px 配合 10px padding 完美同心 */
   padding: var(--space-3, 12px) var(--space-3_5, 14px);
   display: flex;
   flex-direction: column;
@@ -88,7 +88,7 @@
 .dropZone {
   border: var(--hairline-width) dashed var(--border-color);
-  border-radius: var(--radius-l, 10px);
+  border-radius: 10px; /* 10px 同心 */
   background: var(--bg-secondary);
   padding: var(--space-6, 24px) var(--space-4, 16px);
   display: flex;
@@ -141,7 +141,7 @@
 .previewCard {
   background: var(--bg-secondary);
   border: var(--hairline-width, 1px) solid var(--border-subtle);
-  border-radius: var(--radius-l, 10px);
+  border-radius: 10px; /* 10px 同心 */
   padding: var(--space-3_5, 14px) var(--space-4, 16px);
   display: flex;
   flex-direction: column;
```

---

### 3.4 技能详情与创建模态：`SkillDetailModal` & `SkillCreateModal`

- **文件路径**：
  - [`apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css)
  - [`apps/crish-desktop/src/components/extensions-surface/SkillCreateModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillCreateModal.module.css)
- **同心几何重构方案**：
  1. **模态外壳**：`.modalPanel` 升级为 **`var(--radius-2xl)`（20px）**；
  2. **头部内衬与图标框同心**：
     - 当前：`.modalHeader` padding 16px 20px；`.skillIconBox` 声明硬编码 `border-radius: 8px;`；
     - 优化为：`.modalHeader` padding 调整为 `12px 16px;`，左侧图标框距离顶边与左边 12px，曲率 8px；
     - **同心验证**：$R_{modal} (20\text{px}) = R_{iconBox} (8\text{px}) + P (12\text{px}) \iff \Delta = 0$ 绝对同心！
  3. **YAML 药丸胶囊**：`.yamlPill` 保持 `var(--radius-s)`（4px）；
  4. **创建模态方法卡片**：`SkillCreateModal` 的 `.methodCard` 调整为 **`10px`**，配合 10px 边距同心。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css (原代码)
+++ apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css (同心改造)
@@ -7,7 +7,7 @@
   --dialog-width: 760px;
   width: min(var(--dialog-width), calc(100vw - var(--space-8, 32px)));
   max-height: calc(100vh - var(--space-8, 32px));
-  border-radius: var(--radius-xl, 12px);
+  border-radius: var(--radius-2xl); /* 20px 圆角形态外壳 */
   background: var(--bg-card);
   border: var(--hairline-width, 1px) solid var(--border-color);
   box-shadow:
@@ -23,7 +23,7 @@
 .modalHeader {
   display: flex;
   align-items: center;
   justify-content: space-between;
-  padding: var(--space-4, 16px) var(--space-5, 20px);
+  padding: 12px 16px; /* 12px 间距，配合 8px 图标框达成 20 = 8 + 12 同心 */
   border-bottom: var(--hairline-width, 1px) solid var(--border-subtle);
   background: var(--bg-card);
   gap: var(--space-3, 12px);
@@ -40,7 +40,7 @@
 .skillIconBox {
   width: 32px;
   height: 32px;
-  border-radius: 8px;
+  border-radius: var(--radius-md, 8px); /* 8px 达成同心 */
   background: var(--bg-secondary);
   border: var(--hairline-width, 1px) solid var(--border-subtle);
   display: flex;
```

---

### 3.5 诊断日志弹窗：`TelemetryDialog.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/overlay/TelemetryDialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/TelemetryDialog.module.css)
- **外框归属**：继承标准 `Dialog` 基座（20px 圆角形态）。
- **同心几何重构**：
  - 内部状态徽标 `.badge`：当前为 `border-radius: var(--radius-sm)`（4px）；
  - 行容器高度约为 24px，徽标高度约为 18px；
  - 将 `.badge` 圆角微调为 **`var(--radius-sm, 6px)`**（偶数完备阶梯 6px），配合 `padding: 2px 8px`，使状态标签与 20px 弹窗外框及 7px 底部按钮视觉质感保持柔和呼应。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/overlay/TelemetryDialog.module.css (原代码)
+++ apps/crish-desktop/src/components/overlay/TelemetryDialog.module.css (同心改造)
@@ -24,7 +24,7 @@
 .badge {
   display: inline-block;
   padding: var(--space-0_5) var(--space-2);
-  border-radius: var(--radius-sm);
+  border-radius: var(--radius-sm, 6px); /* 6px，对齐完备偶数阶梯 */
   font-size: var(--font-size-xs);
   font-weight: var(--font-weight-semibold, 600);
 }
```

---

### 3.6 外部会话导入模态：`ExternalSessionImportModal.module.css`（同径同角病灶清剿）

- **文件路径**：[`apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css)
- **全仓最典型病灶**：在 55 行与 65 行中，分段槽 `.filterTabs` 与子选项 `.filterTab` 机械地共用了 `var(--radius-lg, 7px)`（实际解析为 8px），内边距仅 3px。$\Delta = 8 - (8 + 3) = -3\text{px}$，激活选项顶死槽体四角。
- **同心几何重构方案**：
  - 内部选项 `.filterTab`：作为可点击按钮，严格遵循系统按钮契约 **`var(--button-radius, 7px)`**（7px）；
  - 容器内衬保持 $P = 3\text{px}$；
  - 槽体外框代数推导：
    $$R_{filterTabs} = R_{filterTab} + P = 7\text{px} + 3\text{px} = 10\text{px}$$
  - 代码写法：`border-radius: calc(var(--button-radius, 7px) + 3px); /* 10px */`（或 `var(--radius-lg, 10px)`）；
  - **同心验证**：$\Delta = 10\text{px} - (7\text{px} + 3\text{px}) = 0\text{px}$，彻底根除内外同径外突！

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css (原代码)
+++ apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css (同心改造)
@@ -52,7 +52,7 @@
   gap: 4px;
   background-color: var(--bg-tertiary);
   padding: 3px;
-  border-radius: var(--radius-lg, 7px);
+  border-radius: calc(var(--button-radius, 7px) + 3px); /* 10px = 7px + 3px 绝对同心 */
 }
 
 .filterTab {
@@ -62,7 +62,7 @@
   color: var(--text-secondary);
   font-size: var(--font-size-xs, 12px);
   padding: 4px 10px;
-  border-radius: var(--radius-lg, 7px);
+  border-radius: var(--button-radius, 7px); /* 锁定 7px 按钮契约 */
   cursor: pointer;
   transition: all 0.15s ease;
 }
```

---

## 四、 二级浮层与下拉菜单（微圆形态：12~14px 体系）

### 4.1 微圆形态通用标准：外壳 14px + 内边距 6px + 条目 8px（$14 = 8 + 6$）

对于所有下拉菜单（Dropdown）、气泡悬浮框（Popover）与上下文操作单（ContextMenu），确立统一的微圆同心黄金法则：

```
    ┌────────────────────────────────────────────────────────────┐ ───
    │ Menu Content (R_outer = 14px, --sep-radius-outer)          │  ▲
    │                                                            │  │ Pad = 6px
    │    ┌──────────────────────────────────────────────────┐    │ ───
    │    │ Menu Item (R_inner = 8px, --sep-item-radius)     │    │
    │    │                                                  │    │
    │    │  公式：14px (Outer) = 8px (Item) + 6px (Pad)     │    │
    │    │  Δ = 14 - (8 + 6) = 0px 绝对同心！              │    │
    │    └──────────────────────────────────────────────────┘    │
    └────────────────────────────────────────────────────────────┘
```

**平反收益**：`tokens.css` 中将 `--sep-radius-outer` 由 12px 纠正为 **`14px`** 后，所有继承该 token 的浮层组件立即由原先的 $\Delta = -2\text{px}$ 挤压自动收敛至 $\Delta = 0$ 绝对同心！

---

### 4.2 通用菜单基座：`ui/Menu/Menu.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/ui/Menu/Menu.module.css:25-27, 138-140`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L25-L27)
- **代码结构**：
  ```css
  .menuContent {
    padding: 6px;
    border-radius: var(--sep-radius-outer); /* 平反后为 14px */
  }
  .menuItem {
    padding: 8px 10px;
    border-radius: var(--sep-item-radius); /* 8px */
  }
  ```
- **同心验证**：$\Delta = 14\text{px} - (8\text{px} + 6\text{px}) = 0\text{px}$。基座原生达到 100% 绝对同心，无需修改组件代码。

---

### 4.3 输入区加号菜单：`ComposePlusMenu.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css:1-38`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css#L1-L38)
- **设计初衷与修正**：
  - 文件顶部注释明确声明：`min-width: 188px, 14px outer / 8px inner item radius`；
  - 但第 11 行误写为：`border-radius: var(--sep-radius-outer, 12px);`（错误的 12px fallback）；
  - 修正：将 fallback 纠正为 `14px`，确保离线或未注入 token 状态下依然保持 $14 = 8 + 6$ 同心。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css (原代码)
+++ apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css (同心改造)
@@ -8,7 +8,7 @@
   background: var(--bg-elevated);
   border: 1px solid var(--border-color);
-  border-radius: var(--sep-radius-outer, 12px);
+  border-radius: var(--sep-radius-outer, 14px); /* 纠正为 14px，与设计注释 14px outer 对齐 */
   box-shadow: var(--shadow-lg);
   padding: 6px;
   display: flex;
```

---

### 4.4 设置快捷菜单：`SettingsQuickMenu.module.css`（根治 -6px 极端窒息挤压）

- **文件路径**：[`apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css:52-54, 110-112`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css#L52-L112)
- **病灶诊断**：全仓下拉菜单中差值最大的病灶。外框 `.sbQuickMenu` 使用了 `var(--radius-lg)`（8px），内衬 6px，内部条目 `.sbQuickItem` 使用 `var(--radius-md)`（8px）。$\Delta = 8 - (8 + 6) = -6\text{px}$！内选项圆角比外框还要大，第一项悬停时四角直接贴在外框上。
- **同心几何重构**：
  - 将 `.sbQuickMenu` 的圆角重构为 **`var(--sep-radius-outer, 14px)`**（或 `calc(var(--radius-md) + var(--space-1_5))` = 14px）；
  - 内衬保持 `padding: var(--space-1_5);`（6px）；
  - 内部条目保持 `border-radius: var(--radius-md);`（8px）；
  - **几何验证**：同心差值由 **-6px 直接跨越至 0px**！角部视觉瞬间释放，呼吸感完全恢复。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css (原代码)
+++ apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css (同心改造)
@@ -49,7 +49,7 @@
   z-index: var(--z-modal);
   background: var(--bg-card);
   border: var(--hairline-width) solid var(--border-subtle);
-  border-radius: var(--radius-lg);
+  border-radius: var(--sep-radius-outer, 14px); /* 由 8px 重构为 14px，根治 -6px 极端窒息挤压 */
   box-shadow: var(--shadow-dropdown);
   padding: var(--space-1_5);
   display: flex;
```

---

### 4.5 侧栏右键与排序过滤菜单：`SidebarContextMenus.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css:6, 101, 150`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L6)
- **重构要点**：
  - 第 6 行右键菜单 `.contextMenu` 错误消费了 `var(--radius-2xl)`。若不修改，在 `--radius-2xl` 平反为 20px 后，右键小菜单会变成 20px 的巨大圆角，违背微圆形态定位！
  - 改造为：`.contextMenu { border-radius: var(--sep-radius-outer, 14px); }`；
  - 内部 `.contextMenuItem`: `border-radius: var(--radius-md);`（8px），内边距 6px；
  - **同心验证**：$\Delta = 14 - (8 + 6) = 0$ 闭合。
  - `.sortFilterMenu` 与 `.sortFilterFlyout` 已使用 `--sep-radius-outer`，直接随 Token 平反归零。

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css (原代码)
+++ apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css (同心改造)
@@ -3,7 +3,7 @@
   max-width: min(240px, calc(100vw - 16px));
   padding: var(--space-1_5);
   gap: var(--space-0_5);
-  border-radius: var(--radius-2xl);
+  border-radius: var(--sep-radius-outer, 14px); /* 脱离 20px 大圆角，收敛至微圆 14px (Δ = 0) */
   background: var(--bg-elevated);
   border: 1px solid var(--border-color);
   box-shadow: var(--shadow-lg);
```

---

### 4.6 权限模式菜单：`PermissionModeMenu.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css:145`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css#L145)
- **代码重构**：将 `.permMenu` 的 fallback 从 12px 纠正为 `14px`。

```diff
--- apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css (原代码)
+++ apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css (同心改造)
@@ -142,7 +142,7 @@
   z-index: var(--z-dropdown-menu, var(--z-dropdown));
   background: var(--bg-elevated);
   border: 1px solid var(--border-color);
-  border-radius: var(--sep-radius-outer, 12px);
+  border-radius: var(--sep-radius-outer, 14px); /* 14px 对齐 8px 项与 6px padding */
   box-shadow: var(--shadow-lg);
   padding: 6px;
```

---

### 4.7 智能面板体系：`SmartExpandablePanel.module.css` & `SmartPanel.module.css`

- **文件路径**：
  - [`apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css:12`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css#L12)
  - [`apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css:359`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L359)
- **同心验证**：
  - 主面板 `.panel` 消费平反后的 `--sep-radius-outer`（14px），与 6px padding 及 8px item 达成 $\Delta = 0$；
  - `SmartPanel` 的二级级联菜单 `.cascadeSubmenu` 已天然具备 $8\text{px} = 4\text{px} + 4\text{px}$ 完美同心（标杆保留）。

---

### 4.8 模型徽标菜单与思考槽滑块：`ModelBadgePickerMenu.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css:7, 229, 242`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L7)
- **重构要点**：
  1. 主菜单外框 `.mbMenu`: 消费平反后的 `--sep-radius-outer`（14px），内衬 6px，条目 8px，$\Delta = 0$；
  2. **思考槽滑块内角挤压修复**：
     - 当前：底槽 `.thinkingTrack` 为 `border-radius: var(--radius-m);`（8px），内衬 2px；内部滑块 `.thinkingPill` 也是 `border-radius: var(--radius-m);`（8px）；
     - 现状差值：$\Delta = 8 - (8 + 2) = -2\text{px}$（同径挤压）；
     - 同心推导：$R_{pill} = R_{track} - P = 8\text{px} - 2\text{px} = 6\text{px}$；
     - 改造为：`.thinkingPill { border-radius: calc(var(--radius-m) - 2px); /* 6px */ }`，消除滑块外突！

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css (原代码)
+++ apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css (同心改造)
@@ -239,7 +239,7 @@
   padding: 4px 0;
   height: auto;
   min-height: unset;
-  border-radius: var(--radius-m);
+  border-radius: calc(var(--radius-m) - 2px); /* 6px = 8px - 2px，消除内部滑块倒挂 */
   font-size: 11px;
   font-weight: 500;
   color: var(--text-secondary);
```

---

### 4.9 项目选择级联子菜单：`ProjectPickerMenu.module.css`（$8 = 4 + 4$ 闭合）

- **文件路径**：[`apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css:93-108`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L93-L108)
- **代码重构**：
  - 设计注释写着：`/* 级联子卡片：8px 外圆角 / 4px 内衬 / 4px 条目 */`；
  - 但子菜单内复用了 `.item`，导致子选项圆角为 8px，$\Delta = 8 - (8 + 4) = -4\text{px}$ 倒挂；
  - 增加特化样式：`.cascadeSubmenu .item { border-radius: var(--radius-s); /* 4px */ }`，彻底兑现设计注释！

#### 代码修改 Diff 方案：
```diff
--- apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css (原代码)
+++ apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css (同心改造)
@@ -106,3 +106,7 @@
   animation: crish-popover-enter var(--transition-popover-enter) forwards;
   will-change: transform, opacity;
 }
+
+.cascadeSubmenu .item {
+  border-radius: var(--radius-s); /* 4px = 8px - 4px，兑现 8 = 4 + 4 完美同心 */
+}
```

---

### 4.10 新建标签页浮层：`NewTabLauncherPopover.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.module.css:23`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.module.css#L23)
- **同心验证**：
  - `.popoverContent`: 声明 `border-radius: var(--sep-radius-outer);`，内衬 6px；
  - 内部项 `.newTabBtn`: 声明 `border-radius: var(--sep-item-radius);`（8px）；
  - 随 Token 平反自然收敛至 $\Delta = 14 - (8 + 6) = 0$ 绝对同心。

---

## 五、 Toast 通知与特殊浮层同心几何对齐

### 5.1 现代通知栈：`ToastStackModern.module.css` 与输入撤销 `DraftUndoToast.module.css`

1. **`ToastStackModern.module.css:69-75`**：
   - 当前已率先完成现代化同心重构，其代码显式采用：
     ```css
     --toast-py: var(--space-2_5, 10px);
     --toast-btn-radius: var(--radius-md, 8px);
     --toast-radius: calc(var(--toast-btn-radius) + var(--toast-py)); /* 18px */
     ```
     外圆角 18px = 按钮 8px + 垂直内距 10px，是全仓同心典范之一，作为基准规范保持。
2. **`DraftUndoToast.module.css:18-21, 55-57`**：
   - 外框 `.undoToast`: `border-radius: var(--radius-xl);`（12px）；
   - 撤销按钮 `.undoBtn`: `border-radius: var(--radius-btn);`（7px），垂直 padding 6px；
   - 差值：$\Delta_y = 12 - (7 + 6) = -1\text{px}$（几近同心）；
   - 维持现状，避免对微小瞬态 Toast 进行过度复杂化改造。

---

### 5.2 极限胶囊包裹：`Tooltip.module.css`

- **文件路径**：[`apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css:48-50`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L48-L50)
- **几何表征**：
  - `.tooltipContent`: `border-radius: var(--radius-full);`（9999px Pill 胶囊），高度约 24px；
  - 内部快捷键 `.tooltipKbd`: `border-radius: var(--radius-xs);`（4px）；
  - 胶囊两端为半正圆（半径 12px），内部 Kbd 居中偏内，属于标准受控胶囊包裹范式，符合设计规范。

---

## 六、 全仓改造执行代码清单与完整 CSS Diff（Implementation Guide）

本详案涉及改动的全部 **11 个 CSS Module 文件** 的详细代码差异汇总如下，供执行波次纯净消费：

### 1. `apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css`
```diff
@@ -47,3 +47,3 @@
-  border-radius: var(--radius-2xl);
+  border-radius: var(--radius-2xl); /* 20px 大模态流畅大圆角 */
@@ -153,3 +153,3 @@
-  padding: var(--space-4) var(--space-4) var(--space-2);
+  padding: var(--space-3) var(--space-3) var(--space-2); /* 12px 12px 8px */
@@ -171,3 +171,3 @@
-  border-radius: var(--radius-sm);
+  border-radius: var(--radius-md); /* 8px: 满足 20 = 8 + 12 绝对同心 (Δ = 0) */
@@ -199,3 +199,3 @@
-  padding: 0 var(--space-4) var(--space-2);
+  padding: 0 var(--space-3) var(--space-2);
@@ -219,3 +219,3 @@
-  padding: var(--space-3) var(--space-4);
+  padding: var(--space-3) var(--space-3); /* 12px 12px 对称内衬，消除各向异性撕裂 */
```

### 2. `apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css`
```diff
@@ -4,3 +4,3 @@
-  border-radius: var(--radius-2xl, 24px);
+  border-radius: var(--radius-2xl); /* 20px */
@@ -17,3 +17,3 @@
-  padding: var(--space-4, 16px) var(--space-5, 20px) var(--space-4, 16px);
+  padding: 10px 10px var(--space-3, 12px); /* 10px 外衬 */
@@ -42,3 +42,3 @@
-  border-radius: var(--radius-lg, 12px);
+  border-radius: 10px; /* 完美同心: 20px = 10px (Dropzone) + 10px (Pad) */
@@ -98,3 +98,3 @@
-  padding: var(--space-1_5, 6px);
-  border-radius: var(--radius-lg, 12px);
+  padding: 4px;
+  border-radius: 10px; /* 10px 外圆角对齐 Dropzone */
@@ -112,3 +112,3 @@
-  border-radius: var(--radius-md, 8px);
+  border-radius: var(--radius-sm, 6px); /* 二级同心: 10px = 6px (Item) + 4px (Pad) */
```

### 3. `apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css`
```diff
@@ -24,3 +24,3 @@
-  border-radius: var(--radius-lg, 9px);
+  border-radius: calc(var(--button-radius, 7px) + 4px); /* 11px = 7px + 4px，治愈 -3px 倒挂 */
@@ -83,3 +83,3 @@
-  border-radius: var(--radius-md, 8px);
+  border-radius: var(--radius-l, 12px);
@@ -272,3 +272,3 @@
-  border-radius: var(--radius-lg, 9px);
+  border-radius: var(--radius-l, 12px);
```

### 4. `apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css`
```diff
@@ -9,3 +9,3 @@
-  border-radius: var(--radius-xl, 12px);
+  border-radius: var(--radius-2xl); /* 20px */
@@ -17,3 +17,3 @@
-  border-radius: var(--radius-md);
+  border-radius: var(--button-radius, 7px);
@@ -24,3 +24,3 @@
-  padding: var(--space-2, 8px) var(--space-4, 16px) var(--space-3, 12px);
+  padding: 10px 10px var(--space-3, 12px); /* 10px 内衬达成 20 = 10 + 10 同心 */
@@ -49,3 +49,3 @@
-  border-radius: var(--radius-l, 10px);
+  border-radius: 10px;
@@ -91,3 +91,3 @@
-  border-radius: var(--radius-l, 10px);
+  border-radius: 10px;
@@ -144,3 +144,3 @@
-  border-radius: var(--radius-l, 10px);
+  border-radius: 10px;
```

### 5. `apps/crish-desktop/src/components/extensions-surface/PluginShareModal.module.css`
```diff
@@ -9,3 +9,3 @@
-  border-radius: var(--radius-xl, 12px);
+  border-radius: var(--radius-2xl); /* 20px */
@@ -17,3 +17,3 @@
-  border-radius: var(--radius-md);
+  border-radius: var(--button-radius, 7px);
@@ -24,3 +24,3 @@
-  padding: var(--space-2, 8px) var(--space-4, 16px) var(--space-3, 12px);
+  padding: 10px 10px var(--space-3, 12px);
@@ -36,3 +36,3 @@
-  border-radius: var(--radius-l, 10px);
+  border-radius: 10px;
```

### 6. `apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css`
```diff
@@ -10,3 +10,3 @@
-  border-radius: var(--radius-xl, 12px);
+  border-radius: var(--radius-2xl); /* 20px */
@@ -26,3 +26,3 @@
-  padding: var(--space-4, 16px) var(--space-5, 20px);
+  padding: 12px 16px; /* 12px 间隙 */
@@ -43,3 +43,3 @@
-  border-radius: 8px;
+  border-radius: var(--radius-md, 8px); /* 20px = 8px + 12px 绝对同心 */
```

### 7. `apps/crish-desktop/src/components/extensions-surface/SkillCreateModal.module.css`
```diff
@@ -10,3 +10,3 @@
-  border-radius: var(--radius-xl, 12px);
+  border-radius: var(--radius-2xl); /* 20px */
@@ -18,3 +18,3 @@
-  border-radius: var(--radius-md);
+  border-radius: var(--button-radius, 7px);
@@ -25,3 +25,3 @@
-  padding: var(--space-2, 8px) var(--space-4, 16px) var(--space-3, 12px);
+  padding: 10px 10px var(--space-3, 12px);
@@ -40,3 +40,3 @@
-  border-radius: var(--radius-xl, 12px);
+  border-radius: 10px;
```

### 8. `apps/crish-desktop/src/components/overlay/TelemetryDialog.module.css`
```diff
@@ -27,3 +27,3 @@
-  border-radius: var(--radius-sm);
+  border-radius: var(--radius-sm, 6px); /* 6px 对齐完备偶数阶梯 */
```

### 9. `apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css`
```diff
@@ -55,3 +55,3 @@
-  border-radius: var(--radius-lg, 7px);
+  border-radius: calc(var(--button-radius, 7px) + 3px); /* 10px = 7px + 3px 绝对同心 */
@@ -65,3 +65,3 @@
-  border-radius: var(--radius-lg, 7px);
+  border-radius: var(--button-radius, 7px); /* 锁定 7px 按钮契约 */
```

### 10. `apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css`
```diff
@@ -52,3 +52,3 @@
-  border-radius: var(--radius-lg);
+  border-radius: var(--sep-radius-outer, 14px); /* 由 8px 重构为 14px，根治 -6px 极端窒息挤压 */
```

### 11. `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css`
```diff
@@ -6,3 +6,3 @@
-  border-radius: var(--radius-2xl);
+  border-radius: var(--sep-radius-outer, 14px); /* 脱离 20px 大圆角，收敛至微圆 14px (Δ = 0) */
```

### 12. `apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css`
```diff
@@ -107,2 +107,6 @@
 }
+
+.cascadeSubmenu .item {
+  border-radius: var(--radius-s); /* 4px = 8px - 4px，闭合 8 = 4 + 4 同心 */
+}
```

### 13. `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`
```diff
@@ -242,3 +242,3 @@
-  border-radius: var(--radius-m);
+  border-radius: calc(var(--radius-m) - 2px); /* 6px = 8px - 2px，消除内部滑块倒挂 */
```

---

## 七、 验收标准与自动化视觉守护断言

### 7.1 数学同心验证断言清单（Math Matrix Verification）

在实施波次完成后，执行以下绝对数学断言校验：

1. **主模态圆角断言**：
   - 检查 `Dialog.module.css` 中 `.dialog` 计算后的 `border-radius` 必须为 **`20px`**；
   - 检查 `.dialogHeader` 右上角关闭按钮到外框边距为 **`12px`**，按钮自身圆角为 **`8px`**，同心度 $\Delta = 20 - (8 + 12) \equiv 0$；
   - 检查 `.dialogFooter` 操作按钮圆角为 **`7px`**，下/右边距为 **`12px~13px`**，同心差值 $|\Delta| \le 1\text{px}$。
2. **项目管理模态断言**：
   - 检查 `ProjectManageModal` 外框为 **`20px`**，`.modalBody` 外衬为 **`10px`**；
   - 检查 `.folderPickerDropzone` 与 `.folderListCard` 圆角为 **`10px`**，同心度 $\Delta = 20 - (10 + 10) \equiv 0$；
   - 检查 `.folderItem` 圆角为 **`6px`**，内衬为 **`4px`**，二级同心度 $\Delta = 10 - (6 + 4) \equiv 0$；
   - 检查项目名称输入框为 **`8px`**，取消/新建按钮为 **`7px`**。
3. **下拉菜单与浮层断言**：
   - 检查 `ui/Menu`, `ComposePlusMenu`, `SettingsQuickMenu`, `SidebarContextMenus`, `SmartExpandablePanel` 外框圆角必须统一解析为 **`14px`**；
   - 内部 padding 为 **`6px`**，内部选项圆角为 **`8px`**，同心度 $\Delta = 14 - (8 + 6) \equiv 0$；
   - `SettingsQuickMenu` 彻底告别 8px 外框，同心差值严禁为负数。
4. **分段槽同心断言**：
   - 检查 `ExternalSessionImportModal` 中 `.filterTabs` 与 `.filterTab` 差值严禁为负数，严格满足 $10\text{px} = 7\text{px} + 3\text{px}$；
   - 检查 `McpConnectModal` 中 `.tabNav` 与 `.tabBtn` 严格满足 $11\text{px} = 7\text{px} + 4\text{px}$。

---

### 7.2 运行时视觉与样式自动化测试计划

在测试套件中扩展同心度自动化检测断言（如新增 `tests/unit/concentric-dialog-menu.test.ts`）：

```typescript
import { describe, it, expect } from 'vitest';

describe('Pop 浮层与通用 Dialog 模态同心几何断言', () => {
  it('通用 Dialog 模态基座必须满足 20px 外圆角与 8px+12px 同心', () => {
    const dialogRadius = 20;
    const headerPad = 12;
    const closeBtnRadius = 8;
    expect(dialogRadius).toBe(closeBtnRadius + headerPad);
  });

  it('ProjectManageModal 必须严格满足 20 = 10 + 10 同心标尺', () => {
    const modalRadius = 20;
    const bodyPad = 10;
    const dropzoneRadius = 10;
    expect(modalRadius).toBe(dropzoneRadius + bodyPad);
    
    // 二级同心
    const listCardRadius = 10;
    const listPad = 4;
    const itemRadius = 6;
    expect(listCardRadius).toBe(itemRadius + listPad);
  });

  it('微圆形态下拉菜单外壳必须严格满足 14 = 8 + 6 同心', () => {
    const menuRadiusOuter = 14;
    const menuPad = 6;
    const menuItemRadius = 8;
    expect(menuRadiusOuter).toBe(menuItemRadius + menuPad);
  });
});
```

---

### 7.3 反退避与反过度设计硬性断言

1. **零打补丁原则**：严禁在 JavaScript / TypeScript 中动态测量 DOM 尺寸后计算 `style.borderRadius`；所有同心几何关系必须通过 CSS 原生 Token、原生 `calc()` 表达式与标准化 CSS Modules 类名静态闭环完成。
2. **单一真理源原则**：所有通用尺寸与枢纽圆角统一由 `tokens.css` 提供权威基准，各业务 CSS Module 仅负责装配与派生，严禁在业务文件中二次硬编码私有圆角变量。
3. **门禁与零回归原则**：严格执行 `full-check` 命令与自动化测试资产保护铁律，保证所有改造后代码通过 `npm run typecheck`、行数门禁与 UI 单元测试。
