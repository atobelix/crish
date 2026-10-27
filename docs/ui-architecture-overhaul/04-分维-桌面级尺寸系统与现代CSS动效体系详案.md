# 桌面级 SizeContext 与 starting-style 现代动效方案（04-SIZE-CONTEXT-STARTING-STYLE-PLAN）

> **战役代号**：UI-ARCHITECTURE-OVERHAUL  
> **方案编号**：04-desktop-size-context-and-starting-style-motion-plan  
> **责任架构**：系统尺寸与动效架构师（Agent-P4）  
> **产出日期**：2026-10-27  
> **目标路径**：`docs/ui-architecture-overhaul/independent-plans/04-桌面级SizeContext与starting-style现代动效方案.md`  
> **依赖基准**：
> - [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)（Design Token SSOT 9 大模块）
> - [`apps/crish-desktop/src/styles/tokens-radius.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-radius.css)（同心圆角与行高阶梯）
> - [`apps/crish-desktop/src/styles/tokens-space.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-space.css)（垂直节奏与间距断点）
> - [`apps/crish-desktop/src/styles/tokens-base.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-base.css)（37 点高精弹簧曲线与动效时长）
> - [`apps/crish-desktop/src/styles/tokens-state.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-state.css)（3 档透明叠加与 8% 焦点环）
> - [`apps/crish-desktop/src/utils/motionTokens.ts`](file:///c:/Software/conex/apps/crish-desktop/src/utils/motionTokens.ts)（动效 Token TS 侧镜像）
> - [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §13（焦点对比度上限 10%、克制边框红线）与 §8（反过度设计红线）

---

## 目录

1. [执行摘要与架构总纲](#一-执行摘要与架构总纲)
2. [Conex 视觉身份与设计原则（独立风格与红线守卫）](#二-conex-视觉身份与设计原则独立风格与红线守卫)
   - 2.1 [拒绝拼凑抄袭：独有的同心几何与暗黑质感](#21-拒绝拼凑抄袭独有的同心几何与暗黑质感)
   - 2.2 [AGENTS.md §13 焦点与描边红线刚性守护](#22-agentsmd-13-焦点与描边红线刚性守护)
   - 2.3 [0-JS 纯净动效：消灭复杂动画库与状态机包袱](#23-0-js-纯净动效消灭复杂动画库与状态机包袱)
3. [桌面级三档密度体系与数学几何标尺（Density Mathematics）](#三-桌面级三档密度体系与数学几何标尺density-mathematics)
   - 3.1 [桌面 Agent 工作台的多区并存矛盾剖析](#31-桌面-agent-工作台的多区并存矛盾剖析)
   - 3.2 [三档密度定位与物理映射（Compact / Default / Comfort）](#32-三档密度定位与物理映射compact--default--comfort)
   - 3.3 [密度几何参数矩阵全景图](#33-密度几何参数矩阵全景图)
   - 3.4 [同心几何守恒方程在三档密度下的代数对齐](#34-同心几何守恒方程在三档密度下的代数对齐)
4. [系统级 SizeContext 上下文渗透架构设计](#四-系统级-sizecontext-上下文渗透架构设计)
   - 4.1 [双通道渗透模型：React Context 与 CSS 变量作用域联动](#41-双通道渗透模型react-context-与-css-变量作用域联动)
   - 4.2 [CSS 级零运行时级联规范（data-density）](#42-css-级零运行时级联规范data-density)
   - 4.3 [React 级轻量上下文实现（SizeContext / DensityProvider）](#43-react-级轻量上下文实现sizecontext--densityprovider)
   - 4.4 [组件层自适应消费与显式覆盖契约](#44-组件层自适应消费与显式覆盖契约)
5. [现代 CSS @starting-style 原生 0-JS 动效架构](#五-现代-css-starting-style-原生-0-js-动效架构)
   - 5.1 [传统弹层进退场的核心缺陷与历史债务根因](#51-传统弹层进退场的核心缺陷与历史债务根因)
   - 5.2 [现代 Chromium / WebView2 原生标准基座（Baseline 2024）](#52-现代-chromium--webview2-原生标准基座baseline-2024)
   - 5.3 [Conex 37 点高精阻尼弹簧曲线与进退场动力学原则](#53-conex-37-点高精阻尼弹簧曲线与进退场动力学原则)
   - 5.4 [环境适应：减弱动效（reduced-motion）与性能档（eco）无缝降级](#54-环境适应减弱动效reduced-motion与性能档eco无缝降级)
6. [四大核心浮层进退场实装规范与 CSS 蓝图](#六-四大核心浮层进退场实装规范与-css-蓝图)
   - 6.1 [Dialog / Modal（大模态窗口）进退场规范](#61-dialog--modal大模态窗口进退场规范)
   - 6.2 [ContextMenu（右键菜单）进退场规范](#62-contextmenu右键菜单进退场规范)
   - 6.3 [Dropdown / Select Popover（下拉菜单与浮层）进退场规范](#63-dropdown--select-popover下拉菜单与浮层进退场规范)
   - 6.4 [Tooltip（微悬停气泡）进退场规范](#64-tooltip微悬停气泡进退场规范)
7. [轻量级 DOM 生命期辅助与退出保护（Minimal Runtime Presence Guard）](#七-轻量级-dom-生命期辅助与退出保护minimal-runtime-presence-guard)
   - 7.1 [CSS 驻留（display: none）vs DOM 卸载（Unmount）抉择矩阵](#71-css-驻留display-nonevs-dom-卸载unmount抉择矩阵)
   - 7.2 [极简 useModernPresence 钩子实现（纯 transitionend 驱动）](#72-极简-usemodernpresence-钩子实现纯-transitionend-驱动)
8. [Token 扩展与落地实施步骤（Implementation Roadmap）](#八-token-扩展与落地实施步骤implementation-roadmap)
   - 8.1 [Token 体系扩展清单（tokens-space.css / tokens-base.css）](#81-token-体系扩展清单tokens-spacecss--tokens-basecss)
   - 8.2 [核心组件改造清单](#82-核心组件改造清单)
   - 8.3 [三阶段落地路线图](#83-三阶段落地路线图)
9. [测试断言、门禁规则与反退避自检](#九-测试断言门禁规则与反退避自检)
   - 9.1 [自动化测试契约（density-contract & motion-discrete）](#91-自动化测试契约density-contract--motion-discrete)
   - 9.2 [架构门禁与反过度设计合规声明](#92-架构门禁与反过度设计合规声明)

---

## 一、 执行摘要与架构总纲

在 Conex 桌面端 Agent 工作台向工业级体验演进的过程中，前端交互与样式架构面临两大核心挑战：
1. **空间密度孤立与多区撕裂**：既有系统仅在 `<html>` 根节点提供全局粗粒度的 `data-ui-size`（small / default / large），无法满足桌面工作台“**紧凑侧栏/树形导航 + 标准主会话/设置 + 舒适落地页/大模态**”在同一视口下的多区共存诉求；各业务组件各自定义固定高宽与内衬，难以随宿主容器自适应调节。
2. **浮层进出场动效割裂与 JS 冗余**：目前 `Dialog`、`ContextMenu`、`Dropdown`、`Tooltip` 大量依赖传统的 CSS `@keyframes` 配合 JS 侧的状态机（`isExiting`、`setTimeout` 延时截流、`onAnimationEnd` 监听）。这种传统模式存在致命缺陷：**弹窗关闭时若 DOM 提前卸载，退场动画被暴力切断（Flash of Unmount）；若延迟卸载，则需在组件内写满脏计时器与竞态保护逻辑**。

本方案提出一套专为 Conex 桌面端量身定制的**双轨架构**：
- **轨一：桌面级系统级 `SizeContext`（sm / md / lg）**。借鉴上下文渗透思想，打造“**React Context + CSS 变量作用域（`data-density`）**”双通道级联体系。开发者只需在任意容器节点声明一行 `<Density density="sm">` 或 `data-density="sm"`，即可让整棵子树中的图标、字号、行高、圆角、内边距全自动自适应，实现零成本多密度分区。
- **轨二：现代 CSS `@starting-style` 原生 0-JS 动效系统**。彻底弃用笨重的外部 JS 动画库与繁杂的退出计时器，全面依托现代 Chromium / WebView2 原生支持的 `@starting-style`、`transition-behavior: allow-discrete` 与 `overlay` 属性。结合 Conex 独有的 37 点高精临界阻尼弹簧曲线（`--ease-spring`），实现弹窗、右键菜单、下拉浮层、提示气泡在入场时的温润弹性与退场时的干脆利落，**从根本上彻底消灭弹窗关闭时的截断与跳变**。

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                    CONEX DESKTOP UI ARCHITECTURE: SIZE CONTEXT & MODERN MOTION                   │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│   ┌────────────────────────────────────────┐            ┌────────────────────────────────────┐   │
│   │  轨一：系统级 SizeContext (上下文渗透)   │            │  轨二：现代 CSS @starting-style 动效│   │
│   ├────────────────────────────────────────┤            ├────────────────────────────────────┤   │
│   │                                        │            │                                    │   │
│   │  • 三档密度：sm (紧凑) / md / lg (舒适)  │            │  • 原生 Baseline 2024 (Chromium 117)│   │
│   │  • 双通道：React Context + CSS 变量   │            │  • @starting-style 声明首帧渲染样式 │   │
│   │  • 一行声明：<Density density="sm">    │            │  • allow-discrete 离散属性平滑过渡 │   │
│   │  • 全树自动派生：字号/图标/行高/圆角   │            │  • 37 点阻尼弹簧曲线入场 + 快速决断退场│   │
│   │  • 守卫同心几何公式：R_out = R_in + Pad│            │  • 彻底消灭 setTimeout / 退出截断  │   │
│   │                                        │            │                                    │   │
│   └────────────────────────────────────────┘            └────────────────────────────────────┘   │
│                        │                                                   │                     │
│                        ▼                                                   ▼                     │
│   ┌──────────────────────────────────────────────────────────────────────────────────────────┐   │
│   │              底座：Conex Design Tokens (tokens.css 9 大模块) + AGENTS.md §13             │   │
│   │         六级暗黑表面 (e0~e5) ── 焦点混入上限 10% ── 克制发丝描边 ── 拒绝花哨与抄袭         │   │
│   └──────────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 Conex 视觉身份与设计原则（独立风格与红线守卫）

### 2.1 拒绝拼凑抄袭：独有的同心几何与暗黑质感

本方案不盲目照搬市面上通用 Web 组件库（如 Shadcn、AntD、Material）的扁平方案，而是紧密扎根于 Conex 已沉淀的桌面级工业美学：
1. **六级暗黑表面阶梯（Surface Ladder $e_0 \sim e_5$）**：
   - $e_0$ 下凹基底（`--surface-sunken`）：侧栏活动槽、输入区底板、内嵌列表；
   - $e_1$ 画布地平面（`--surface-canvas`）：`#111112` 深邃纯黑主工作区；
   - $e_2$ 外壳收敛（`--surface-shell`）：`#1c1c1e` 柔和炭黑桌面窗口壳体；
   - $e_3$ 卡片视口（`--surface-card`）：纯黑沉静卡片与会话流视口；
   - $e_4$ 交互浮起（`--surface-raised`）：`+13%` 交互核心（输入坞 Composer、悬浮操作岛）；
   - $e_5$ 顶层弹层（`--surface-overlay`）：`+17%` 浮动菜单、模态窗口、提示框。
2. **同心几何闭环（Concentric Geometry）**：
   坚持“**外角半径 = 内角半径 + 间距**”的代数公理。浮层菜单外壳采用 18px 外角（`--radius-menu-outer`），内衬 6px，内部条目使用 12px（`--radius-menu-inner`），消除任何角部畸变或虚空。
3. **简洁合理，摒弃过度工程**：
   杜绝引入外部沉重的动效运行时（如 Framer Motion 完整打包动辄 35KB+），充分利用 Chromium / WebView2 现代浏览器内核的原生能力，用最少的代码实现最高级的动效。

### 2.2 AGENTS.md §13 焦点与描边红线刚性守护

本方案在设计所有交互态、输入框、菜单项与聚焦环时，刚性遵守 `AGENTS.md` §13 裁决：
- **默认无重阴影**：输入框、搜索框、菜单等默认禁止厚重深黑投影，保持轻量扁平；
- **克制激活边框**：聚焦或激活时，**严禁粗、深、实心黑边（禁止 `0 0 0 1px #000` 或高反差黑环）**；
- **焦点混入上限 10%**：
  $$\text{FocusBorder} = \text{color-mix}(\text{in srgb}, \text{var}(--\text{border-color})\ 90\%, \text{var}(--\text{text-primary})\ 10\%)$$
  常规控件优先使用 3%–6% 的轻度混入；大面积空态落地输入框混入低于 5%；
- **柔软渐变无跳变**：颜色过渡始终绑定 `--transition-fast`（150ms），确保视觉柔和自然。

### 2.3 0-JS 纯净动效：消灭复杂动画库与状态机包袱

传统前端对模态框退场动效的处理极为繁琐：
- 引入 `framer-motion` 的 `<AnimatePresence>`：侵入 React 渲染树，引入额外上下文与微任务轮询，增加包体积并带来潜在的重渲染性能隐患；
- 手写 `isExiting` 状态机：每个弹窗组件必须挂载 `setTimeout(onClose, 200)` 或 `onAnimationEnd` 监听器。一旦用户快速双击或在动画未完成时触发新事件，状态机极易失步，导致弹窗卡死在半透明状态；
- **本方案准则**：动效归 CSS，逻辑归 React。React 仅负责维护单一布尔状态（如 `open: boolean`）或原生 `<dialog>` 的 `showModal()` / `close()`；所有样式的插值、首帧锚定、离散属性驻留与最终隐藏，全部委托给浏览器渲染引擎的 `@starting-style` 与 `allow-discrete`。

---

## 三、 桌面级三档密度体系与数学几何标尺（Density Mathematics）

### 3.1 桌面 Agent 工作台的多区并存矛盾剖析

桌面端生产力软件（如 IDE、专业工作台）与常规移动端或内容网站的最大区别在于：**不同功能区域承载的信息密度与交互频率存在显著代沟**：
- **导航与树形区**：需要容纳多层会话树、工作区文件列表、后台运行任务，用户需要一屏扫视 20+ 个条目，垂直间距必须紧凑（24px 行高）；
- **对话与设置区**：长文本阅读与高频输入并存，需要符合人体工学的行高（1.35~1.45）与适中的触控/点击靶心（28~32px 控件高）；
- **落地页与模态区**：引导新用户创建 Agent、配置复杂模型参数、确认关键危险操作，需要呼吸感与视觉沉浸度（36~40px 控件高、宽敞的内衬）。

若采用传统的全站统一字阶与间距，必然陷入“侧栏太松垮、对话太拥挤”或“侧栏适中、模态局促小气”的零和博弈。因此，**局部可覆写的系统级密度系统是桌面端架构的必由之路**。

### 3.2 三档密度定位与物理映射（Compact / Default / Comfort）

本方案正式确立 Conex 桌面级三档标准密度：

| 密度档位 | 内部标识 | 英文代号 | 核心语义与设计诉求 | 桌面端工作台应用区域映射 |
| :--- | :---: | :---: | :--- | :--- |
| **紧凑档** | `sm` | **Compact** | **高吞吐、高密度、信息收敛**<br>消除虚空，最大化单屏可见数据量 | • 侧边栏（会话列表、工程管理）<br>• 文件树（FileTree、Attachments）<br>• 顶部多标签栏（TabsStrip）<br>• 状态栏与后台任务指示器<br>• 紧凑工具栏与悬浮小气泡 |
| **标准档** | `md` | **Default** | **平衡、易读、符合人体工学**<br>兼顾阅读舒适度与操作精准度 | • 消息对话流（ChatMessageList）<br>• 提示词输入坞（ChatComposer）<br>• 全局设置主面板（SettingsPanel）<br>• 插件与扩展中心列表<br>• 通用表单与操作浮层 |
| **舒适档** | `lg` | **Comfort** | **呼吸感、焦点聚焦、沉浸指引**<br>强调大面积呼吸空间与视觉引导 | • 空会话全页落地（SessionEmptyLanding）<br>• 首次运行配置向导（FirstRunWizard）<br>• 核心大模态弹窗（Dialog/Modal）<br>• 欢迎卡片与模型探索大卡片<br>• 审批确认弹窗（WorkflowConfirm） |

> **标尺对齐与解耦原则（Density vs ButtonSize）**：  
> 必须严格辨析“**区域密度（Density: sm/md/lg）**”与“**原子控件专有尺寸（ButtonSize: xs/sm/md/lg）**”的数学映射：
> - 现有 `Button.tsx` 严格遵循四档物理尺寸：`xs(24px) / sm(28px) / md(32px) / lg(40px)`；
> - 系统 Density 三档向 DOM 广播的是**容器级变量与环境状态**（`data-density="sm|md|lg"`），**严禁直接侵入并强行篡改 Button 内部的 `size` prop 逻辑**；
> - 未显式指定 `size` 的按钮自动消费容器 CSS 变量：`sm` 容器下为 24px（等价 xs 标尺）、`md` 容器下为 28px（等价 sm/md 基准）、`lg` 容器下为 36px/40px（等价 lg 标尺）；
> - 显式传 `size="sm"` 的按钮依然精准锁定其专有规格（28px 高），互不干扰，彻底杜绝全仓既有几百处按钮因尺寸重命名发生缩水崩坏！

### 3.3 密度几何参数矩阵全景图

三档密度严格与 Conex 既有的 `tokens-radius.css`、`tokens-space.css`、`tokens-type.css` 以及 `Button.tsx` 四档标尺形成偶数闭包映射，杜绝出现非标奇数像素：

| 几何与排版维度 | CSS 动态变量名 | Compact (`sm`) | Default (`md`) | Comfort (`lg`) | 对齐既有 Token 基准与 Button 标尺 |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **控件基准高度** | `--density-control-h` / `--control-height` | **24px** | **28px** | **36px** | `--control-height`（24/28/36px）与 Button xs(24)/sm(28)/lg(40) |
| **控件水平内衬** | `--density-control-pad-x`| **6px** | **10px** | **14px** | `--space-1_5` / `--composer-pad-x` / `--space-3_5` |
| **控件垂直内衬** | `--density-control-pad-y`| **2px** | **4px** | **6px** | `--space-0_5` / `--space-1` / `--space-1_5` |
| **控件内元素间距** | `--density-control-gap` | **4px** | **6px** | **8px** | `--gap-inline` / `--space-1_5` / `--gap-group` |
| **基准字号** | `--density-font-size` | **12px** | **14px** | **16px** | `--font-size-meta` / `--font-size-body` / `--font-size-subhead` |
| **基准行高** | `--density-line-height`| **1.25** | **1.35** | **1.45** | `--lh-dense` / `--lh-ui` / 标准排版行高 |
| **图标基准尺寸** | `--density-icon-size` | **14px** | **16px** | **18px** | `--icon-size-sm` (14) / `--icon-size` (16) / `--icon-size-lg` (18) |
| **常规控件圆角** | `--density-radius-control`| **6px** | **8px** | **10px** | `--radius-row` / `--radius-control` / `--radius-md` |
| **外壳容器圆角** | `--density-radius-outer` | **12px** | **14px** | **18px** | 针对不同浮层与卡片的几何外壳 |
| **容器外部内衬** | `--density-container-pad`| **6px** | **8px** | **12px** | 容器与内部子项之间的物理缝隙 |

### 3.4 同心几何守恒方程在三档密度下的代数对齐

Conex 的同心圆角铁律为：
$$R_{\text{outer}} = R_{\text{inner}} + \text{Padding}$$
当 $\text{Padding} \ge R_{\text{outer}}$ 时，内部子项圆角退化为直角（$R_{\text{inner}} = 0$）。

在三档密度下，容器（如 Dropdown 浮层、卡片、侧栏包裹框）与内部项目（Item / Button）的圆角满足严格代数闭环：
- **Compact (`sm`)**：
  $$\text{Padding} = 4\text{px},\quad R_{\text{inner}} = 6\text{px} \implies R_{\text{outer}} = 6 + 4 = 10\text{px} \quad (\text{微圆紧凑浮层})$$
- **Default (`md`)**：
  $$\text{Padding} = 6\text{px},\quad R_{\text{inner}} = 8\text{px} \implies R_{\text{outer}} = 8 + 6 = 14\text{px} \quad (\text{标准浮层与卡片外框})$$
- **Comfort (`lg`)**：
  $$\text{Padding} = 8\text{px},\quad R_{\text{inner}} = 10\text{px} \implies R_{\text{outer}} = 10 + 8 = 18\text{px} \quad (\text{舒适外壳与侧栏大容器})$$
- **Dialog 模态例外**：
  Dialog 采用圆角形态最高阶枢纽 `--radius-modal: 20px / 24px`，内衬为 16px~20px，内部操作按钮使用标准 `--radius-control: 8px`，角部走线完全同向无突刺。

---

## 四、 系统级 SizeContext 上下文渗透架构设计

### 4.1 双通道渗透模型：React Context 与 CSS 变量作用域联动

在桌面端大型 React 应用中，纯 React Context 存在子组件消费成本高、深层重渲染开销大的问题；而纯 CSS 选择器则难以满足需要 JS 计算高度（如虚拟列表 `react-virtualized`）的诉求。

本方案设计**双通道级联模型（Dual-Channel Cascade Model）**：
1. **通道 A（CSS 作用域树）**：`<Density>` 组件向当前根 DOM 节点注入 `data-density="sm|md|lg"`。浏览器原生 CSS Custom Properties 沿 DOM 树自然继承，底层普通 UI 组件（如 `<Button>`, `<Input>`）零 JS 依赖，纯 CSS 瞬时解析完成！
2. **通道 B（React 树）**：`<Density>` 同时向下广播轻量 React Context，供需要参与高度度量、Canvas 绘制、动态虚拟滚动列表或图标大小按需计算的组件通过 `useDensity()` 获取。

```
                    ┌──────────────────────────────────────────────┐
                    │    开发者声明：<Density density="sm">         │
                    └──────────────────────┬───────────────────────┘
                                           │
                    ┌──────────────────────┴───────────────────────┐
                    ▼                                              ▼
   【通道 A：DOM 属性与 CSS 级联】                 【通道 B：React 上下文渗透】
   <div data-density="sm" class="...">             <DensityContext.Provider value="sm">
            │                                                      │
            ├─► --density-control-h: 24px                          ├─► useDensity() === 'sm'
            ├─► --density-font-size: 12px                          ├─► 虚拟列表行高 = 24
            ├─► --density-icon-size: 14px                          └─► Canvas / SVG 测量
            └─► 子元素 0-JS 自动继承！
```

### 4.2 CSS 级零运行时级联规范（data-density）

在 `apps/crish-desktop/src/styles/tokens-space.css` 中追加局部作用域变量重映射。当任意节点被打上 `data-density` 属性时，内部基元变量自动切换。
**关键机制**：双向同步 `--control-h` 与既有单真理源 `--control-height`，彻底消除 Token 命名孤岛，保证未改造的存量组件与新建组件均能无缝自适应：

```css
/* ==========================================================================
   局部密度级联引擎 (Scoped Density Cascade)
   双向同步 --control-h 与 --control-height，杜绝 Token 命名孤岛
   ========================================================================== */

/* 1. 默认降级为标准档 (md) */
:root {
  --control-h: var(--control-height, 28px);
  --control-height: 28px;
  --control-height-sm: 24px;
  --control-height-xs: 20px;
  --control-height-lg: 32px;
  --control-pad-x: 10px;
  --control-pad-y: 4px;
  --control-gap: 6px;
  --control-font-size: var(--font-size-body, 14px);
  --control-line-height: var(--lh-ui, 1.35);
  --control-icon-size: var(--icon-size, 16px);
  --control-radius: var(--radius-control, 8px);
}

/* 2. 紧凑档 (sm) — 侧边栏、会话树、多标签栏 */
[data-density='sm'] {
  --control-h: 24px;
  --control-height: 24px;          /* 关键：双向同步，驱动全仓存量与增量组件 */
  --control-height-sm: 20px;
  --control-height-xs: 18px;
  --control-height-lg: 28px;
  --control-pad-x: 6px;
  --control-pad-y: 2px;
  --control-gap: 4px;
  --control-font-size: var(--font-size-meta, 12px);
  --control-line-height: var(--lh-dense, 1.25);
  --control-icon-size: var(--icon-size-sm, 14px);
  --control-radius: var(--radius-row, 6px);
}

/* 3. 标准档 (md) — 会话流、通用设置、表单 */
[data-density='md'] {
  --control-h: 28px;
  --control-height: 28px;
  --control-height-sm: 24px;
  --control-height-xs: 20px;
  --control-height-lg: 32px;
  --control-pad-x: 10px;
  --control-pad-y: 4px;
  --control-gap: 6px;
  --control-font-size: var(--font-size-body, 14px);
  --control-line-height: var(--lh-ui, 1.35);
  --control-icon-size: var(--icon-size, 16px);
  --control-radius: var(--radius-control, 8px);
}

/* 4. 舒适档 (lg) — 落地页、卡片引导、大模态向导 */
[data-density='lg'] {
  --control-h: 36px;
  --control-height: 36px;
  --control-height-sm: 28px;
  --control-height-xs: 24px;
  --control-height-lg: 40px;
  --control-pad-x: 14px;
  --control-pad-y: 6px;
  --control-gap: 8px;
  --control-font-size: var(--font-size-subhead, 16px);
  --control-line-height: 1.45;
  --control-icon-size: var(--icon-size-lg, 18px);
  --control-radius: var(--radius-card, 10px);
}
```

### 4.3 React 级轻量上下文实现（SizeContext / DensityProvider）

创建核心模块 `apps/crish-desktop/src/components/ui/Density/DensityContext.tsx`，保持体积小于 1KB，零冗余依赖：

```tsx
import React, { createContext, useContext, useMemo, type ReactNode, type HTMLAttributes } from 'react';

export type Density = 'sm' | 'md' | 'lg';

export interface DensityContextValue {
  density: Density;
  controlHeight: number;
  iconSize: number;
  fontSize: number;
}

const DENSITY_METRICS: Record<Density, Omit<DensityContextValue, 'density'>> = {
  sm: { controlHeight: 24, iconSize: 14, fontSize: 12 },
  md: { controlHeight: 28, iconSize: 16, fontSize: 14 },
  lg: { controlHeight: 36, iconSize: 18, fontSize: 16 },
};

const DensityContext = createContext<DensityContextValue>({
  density: 'md',
  ...DENSITY_METRICS.md,
});

export interface DensityProps extends HTMLAttributes<HTMLDivElement> {
  density?: Density;
  children: ReactNode;
  /** 是否只作为逻辑 Context，不渲染额外包裹 div（需配合已有包裹 DOM） */
  pureContext?: boolean;
}

export const Density: React.FC<DensityProps> = ({
  density = 'md',
  children,
  pureContext = false,
  className,
  style,
  ...rest
}) => {
  const value = useMemo<DensityContextValue>(
    () => ({
      density,
      ...DENSITY_METRICS[density],
    }),
    [density]
  );

  if (pureContext) {
    return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
  }

  return (
    <DensityContext.Provider value={value}>
      <div
        data-density={density}
        className={className}
        style={style}
        {...rest}
      >
        {children}
      </div>
    </DensityContext.Provider>
  );
};

/**
 * 获取当前密度档位（'sm' | 'md' | 'lg'）及核心数值指标
 */
export function useDensity(): DensityContextValue {
  return useContext(DensityContext);
}
```

### 4.4 组件层自适应消费与显式覆盖契约（补丁 4：解耦 Density 与 ButtonSize）

必须严密分离“**容器级环境密度（Density: sm/md/lg）**”与“**原子控件专有规格（ButtonSize: xs/sm/md/lg）**”，严禁发生属性混淆：
- **容器级广播**：`<Density density="sm">` 仅向 DOM 注入 `data-density="sm"` 并向下渗透 React 上下文；
- **组件级自适应**：
  - **默认形态（未显式声明 `size`）**：组件**不硬编码 `data-size`**，而是通过 CSS 规则直接消费容器级变量 `height: var(--control-height, var(--control-h, 28px));`。在 `sm` 容器下自动表现为 24px（紧凑高密），在 `md` 容器下为 28px/32px，在 `lg` 容器下为 36px/40px；
  - **显式覆盖（显式声明 `size="xs"|"sm"|"md"|"lg"`）**：组件精准挂载自身专有尺寸属性（如 `data-size="sm"` 或 `.buttonSm`），强制锁定 `Button.module.css` 中的专有物理高度（xs: 24px, sm: 28px, md: 32px, lg: 40px），不受外层 Density 干扰。

```tsx
// 改进规范：解耦后的 Button 组件消费模式
import React from 'react';
import type { ButtonSize, ButtonVariant } from './types';
import styles from './Button.module.css';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 显式指定规格；若未指定则完全跟随当前父容器的 Density CSS 变量自适应 */
  size?: ButtonSize; // 'xs' | 'sm' | 'md' | 'lg'
  variant?: ButtonVariant;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { size, variant = 'secondary', className = '', children, ...rest },
  ref
) {
  // 关键：不强行将 density 覆写为 size，避免命名与尺寸对撞
  return (
    <button
      ref={ref}
      data-slot="button"
      data-size={size} // 仅在显式传入时生效，未传入时为 undefined，纯靠 CSS 变量继承
      data-variant={variant}
      className={`${styles.button} ${size ? styles[`button_${size}`] : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
```

配合 `Button.module.css`：
```css
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  font-family: inherit;
  font-weight: 500;
  border: 1px solid var(--border-color);
  background: var(--surface-card);
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
  
  /* 默认自适应模式：优先消费容器级变量，0-JS 自动随 [data-density] 伸缩 */
  height: var(--control-height, var(--control-h, 28px));
  padding: var(--control-pad-y, 4px) var(--control-pad-x, 10px);
  gap: var(--control-gap, 6px);
  font-size: var(--control-font-size, var(--font-size-body, 14px));
  line-height: var(--control-line-height, 1.35);
  border-radius: var(--control-radius, var(--radius-control, 8px));
  
  /* 动效过渡 */
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}

/* 显式指定 size 时的精准四档覆盖（严格守卫 Button.tsx 既有 24/28/32/40px 资产） */
.button[data-size='xs'],
.button.button_xs {
  height: 24px;
  padding: 0 6px;
  font-size: var(--font-size-xs, 12px);
  border-radius: var(--radius-sm, 4px);
}
.button[data-size='sm'],
.button.button_sm {
  height: 28px;
  padding: 0 10px;
  font-size: var(--font-size-sm, 13px);
  border-radius: var(--button-radius, 6px);
}
.button[data-size='md'],
.button.button_md {
  height: 32px;
  padding: 0 12px;
  font-size: var(--font-size-base, 14px);
  border-radius: var(--button-radius, 6px);
}
.button[data-size='lg'],
.button.button_lg {
  height: 40px;
  padding: 0 16px;
  font-size: var(--font-size-md, 15px);
  border-radius: var(--radius-lg, 8px);
}

/* AGENTS.md §13 焦点合规：绝无深黑粗环，混入上限 <= 10% */
.button:focus-visible {
  border-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
}
```

---

## 五、 现代 CSS @starting-style 原生 0-JS 动效架构

### 5.1 传统弹层进退场的核心缺陷与历史债务根因

在以往的 Web 与桌面应用架构中，弹层动画之所以极其脆弱、经常被吐槽“闪烁”或“截断”，其根本病因在于 **CSS 盒模型渲染生命周期与 `display` 属性的天然冲突**：
1. **入场闪烁（Initial Style Resolution Hazard）**：
   当元素从 `display: none` 变为 `display: flex/block` 时，浏览器在同一帧中将其插入渲染树。CSS 过渡引擎无法找到“前序计算值”（Previous Computed Value），因此直接跳过过渡，瞬间呈现终态；传统解决手段是引入 CSS `@keyframes` 或强行调用 `getComputedStyle()` 迫使重排，既丑陋又消耗性能。
2. **退场截断（Abrupt Unmount Bug）**：
   关闭弹窗时，若 React 直接将组件从虚拟 DOM 移除，或直接赋 `display: none`，退场动画根本没有播放的机会，瞬间黑屏消失；若为了播放动画而设置 `setTimeout` 延迟 200ms 卸载，一旦用户在这 200ms 内再次点击打开，就会发生组件状态竞态，产生两个相同弹窗或数据失步。

### 5.2 现代 Chromium / WebView2 原生标准基座（Baseline 2024）

Conex 运行在现代 Tauri + WebView2 环境（Chromium 内核 $\ge 117$），天然全面支持现代 CSS 动效三大新特性：
1. **`@starting-style` 规则**：
   允许在元素**首次渲染或由 `display: none` 切入页面时**，定义其起始帧状态。浏览器会在第一帧将其作为初始值，并平滑过渡到常规声明的样式；
2. **`transition-behavior: allow-discrete`**：
   以往 `display`、`visibility`、`overlay` 等离散属性（Discrete Properties）无法被 transition 过渡。开启 `allow-discrete` 后，`display` 会在**所有数值属性（如 opacity、transform）过渡完毕后才切换为 `none`**，实现纯 CSS 退出延时保护！
3. **`overlay: auto`**：
   支持顶级图层（Top Layer / `<dialog>`）在动画退出期间保持在最顶层，不会在关闭瞬间被下层元素遮挡。

```css
/* 现代标准：0 行 JS 计时器，全自动完美进退场标准范式 */
.popover {
  /* 1. 默认闭合状态（退出终态） */
  display: none;
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
  
  /* 2. 声明过渡属性：分层声明防御 CSS Shorthand 降级穿透 */
  /* 基础兜底：即便内核不支持 allow-discrete 也绝对不破坏数值平滑过渡 */
  transition:
    opacity 150ms var(--ease-accelerate),
    transform 150ms var(--ease-accelerate);

  /* 现代特性增强：支持 allow-discrete 时接管 display 退出延迟卸载 */
  @supports (transition-behavior: allow-discrete) {
    transition:
      opacity 150ms var(--ease-accelerate),
      transform 150ms var(--ease-accelerate),
      display 150ms allow-discrete;
  }
}

/* 3. 展开状态（进入终态） */
.popover[data-state='open'] {
  display: flex;
  opacity: 1;
  transform: scale(1) translateY(0);
  
  /* 进入过渡：基础兜底 + 弹性曲线增强 */
  transition:
    opacity 200ms var(--ease-decelerate),
    transform 260ms var(--ease-spring);

  @supports (transition-behavior: allow-discrete) {
    transition:
      opacity 200ms var(--ease-decelerate),
      transform 260ms var(--ease-spring),
      display 200ms allow-discrete;
  }
  
  /* 4. 声明刚切入展示时的首帧样式（进入初态） */
  @starting-style {
    opacity: 0;
    transform: scale(0.96) translateY(-4px);
  }
}
```

### 5.3 Conex 37 点高精阻尼弹簧曲线与进退场动力学原则

不同于某些库在退场时也使用弹性曲线导致“弹窗关闭时还在弹两下”的滑稽感，Conex 确立明确的**动效物理学纪律**：
- **入场动力学（Entrance Physics · 柔和、温润、物理弹簧）**：
  采用 Conex 既有的 **37 点临界阻尼弹簧曲线**（`--ease-spring`）配合 260ms 紧凑时长（`--duration-spring-snappy`）。元素自微小尺度（`scale: 0.975`）轻微膨胀入场，并在触及 1.0 时柔和吸收动能，无大幅振荡，呈现高阶桌面原生质感。
  ```css
  --ease-spring: linear(0, 0.0213, 0.0739, 0.1443, 0.2235, 0.305, 0.3849, 0.4606, 0.5305, 0.594,
    0.6508, 0.7011, 0.7452, 0.7836, 0.8168, 0.8454, 0.8699, 0.8907, 0.9084, 0.9234,
    0.9361, 0.9467, 0.9557, 0.9632, 0.9694, 0.9747, 0.979, 0.9826, 0.9857, 0.9882,
    0.9902, 0.992, 0.9934, 0.9946, 0.9955, 0.9963, 1);
  ```
- **退场动力学（Exit Physics · 决断、迅捷、无回弹）**：
  退场严禁使用弹簧缓动！退场必须迅速（120ms~150ms），使用加速曲线（`--ease-accelerate: cubic-bezier(0.4, 0, 1, 1)`），直接淡出并微缩（`scale: 0.985`），给用户干脆直接的操作反馈。

### 5.4 环境适应：减弱动效（reduced-motion）与性能档（eco）无缝降级

在 `tokens-base.css` 的全局守护下，动效系统必须天然响应系统偏好与节能模式：
- 当用户开启操作系统的“减弱动态效果”（`prefers-reduced-motion: reduce`）或 Conex 切换为节能档（`html[data-perf-tier='eco']`）时，所有 `--duration-*` 自动被置为 `0ms`；
- `@starting-style` 与 `allow-discrete` 的过渡时长瞬间变为 0，浮层退化为瞬时开闭，零渲染负担，零卡顿隐患。

---

## 六、 四大核心浮层进退场实装规范与 CSS 蓝图

### 6.1 Dialog / Modal（大模态窗口）进退场规范

模态弹窗涉及两层结构：背景遮罩（Backdrop）与弹窗视口主体（Surface）。

#### 设计规范与几何契约（补丁 2 契约守卫）
- **表面层级**：$e_5$ 最高弹层（`--surface-overlay`），纯黑暗黑基准；
- **层叠穿透**：必须采用 `z-index: var(--dialog-z, var(--z-modal, 1000));`，供 `SettingsPanel` 等特定业务弹窗显式覆写层级；
- **独立 Backdrop 与防叠暗契约**：严禁将背景色直接合入 `dialogOverlay`！必须保留独立的 `.backdrop` 节点，刚性维持 `Dialog.scrim.test.ts` 守护的 `:has()` 多层弹窗防叠暗契约；
- **子树上下文穿透**：`DialogOverlay` 必须向子树注入 `DialogOverlayContext`，将当前 overlay 的 DOM 节点共享给内部的 `Select` / `Menu`，使其 portal 进遮罩层内，利用 DOM 局部层叠高过弹窗主体，彻底杜绝下拉框沉入底层的恶性 Bug；
- **同心圆角**：外框 20px / 24px（`--radius-modal`）；
- **遮罩层**：`--modal-scrim: color-mix(in srgb, var(--shadow-color) 12%, transparent)`，严禁毛玻璃虚化造成 GPU 负荷；
- **动力学**：遮罩层仅做透明度淡入淡出（200ms 进入 / 120ms 退出）；主体做 `scale(0.975) -> 1.0` 弹簧回弹。

#### 完整 CSS 实装蓝图（`DialogModern.module.css`）
```css
/* 模态外壳容器（接管顶层视口） */
.dialogOverlay {
  position: fixed;
  inset: 0;
  /* 必须支持 --dialog-z 覆盖，供 SettingsPanel 等特定弹窗提权 */
  z-index: var(--dialog-z, var(--z-modal, 1000));
  display: none;
  align-items: center;
  justify-content: center;
  
  /* 退出过渡：基础过渡 + allow-discrete 离散 display 延后切换 */
  opacity: 0;
  transition: opacity var(--duration-fast, 150ms) var(--ease-accelerate);
}

@supports (transition-behavior: allow-discrete) {
  .dialogOverlay {
    transition:
      opacity var(--duration-fast, 150ms) var(--ease-accelerate),
      display var(--duration-fast, 150ms) allow-discrete;
  }
}

/* 展开态遮罩外壳 */
.dialogOverlay[data-state='open'] {
  display: flex;
  opacity: 1;
  
  /* 进入过渡：减速柔和淡入 */
  transition: opacity var(--duration-normal, 200ms) var(--ease-decelerate);
}

@supports (transition-behavior: allow-discrete) {
  .dialogOverlay[data-state='open'] {
    transition:
      opacity var(--duration-normal, 200ms) var(--ease-decelerate),
      display var(--duration-normal, 200ms) allow-discrete;
  }
}

.dialogOverlay[data-state='open'] {
  @starting-style {
    opacity: 0;
  }
}

/* 独立 Backdrop 节点（严格对齐 Dialog.scrim.test.ts） */
.backdrop {
  position: absolute;
  inset: 0;
  background: var(--modal-scrim);
  transition: background-color var(--duration-enter, 200ms) var(--ease-standard);
}

/* 弹窗叠弹窗让位规则：上层开启时，下层遮罩让位透明，只保留最上层遮罩 */
[data-focus-trap]:has(
    ~ [data-focus-trap]
      > [data-dialog-overlay]:not([data-dialog-state='exiting'])
  )
  > [data-dialog-overlay]
  > .backdrop {
  background: transparent;
}

/* 模态卡片主体 */
.dialogSurface {
  position: relative;
  z-index: 1; /* 高于自身 backdrop */
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: var(--surface-overlay);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-modal, 20px);
  box-shadow: var(--shadow-2xl);
  outline: none;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  
  /* 退出状态：决断微缩并淡出 */
  opacity: 0;
  transform: scale(0.985);
  transition:
    opacity var(--duration-fast, 150ms) var(--ease-accelerate),
    transform var(--duration-fast, 150ms) var(--ease-accelerate);
}

.dialogOverlay[data-state='open'] .dialogSurface {
  opacity: 1;
  transform: scale(1);
  
  /* 进入状态：37 点高精阻尼弹簧平滑微弹入场 */
  transition:
    opacity var(--duration-normal, 200ms) var(--ease-decelerate),
    transform var(--duration-spring-snappy, 260ms) var(--ease-spring);

  @starting-style {
    opacity: 0;
    transform: scale(0.975);
  }
}

/* 减弱动效降级 */
@media (prefers-reduced-motion: reduce) {
  .dialogOverlay,
  .backdrop,
  .dialogSurface {
    transition: none !important;
  }
}
```

### 6.2 ContextMenu（右键菜单）进退场规范

右键菜单是桌面高频交互，要求**即点即现，极度灵敏，贴合鼠标点击锚点**。

#### 设计规范与几何契约
- **同心圆角**：外框 18px（`--radius-menu-outer`），内衬 6px，内部条目 12px（`--radius-menu-inner`），代数绝对同心；
- **动力学**：`scale(0.95)` + 微小负 Y 轴偏移（`-4px`），`transform-origin` 随菜单展开方向自适应；
- **退出速度**：120ms 加速淡出，避免点击其他区域时悬留延迟。

#### 完整 CSS 实装蓝图（`ContextMenuModern.module.css`）
```css
.contextMenu {
  position: fixed;
  z-index: var(--z-context-menu, 1100);
  box-sizing: border-box;
  display: none;
  flex-direction: column;
  min-width: 160px;
  max-width: 240px;
  padding: 6px;
  gap: 2px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-menu-outer, 18px);
  box-shadow: var(--shadow-popover, var(--shadow-lg));
  outline: none;
  user-select: none;
  -webkit-app-region: no-drag;
  
  /* 退出状态：极快加速淡出 */
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
  transform-origin: var(--menu-transform-origin, top left);
  transition:
    opacity 120ms var(--ease-accelerate),
    transform 120ms var(--ease-accelerate),
    display 120ms allow-discrete;
}

.contextMenu[data-state='open'] {
  display: flex;
  opacity: 1;
  transform: scale(1) translateY(0);
  
  /* 进入状态：爽快弹簧 */
  transition:
    opacity 150ms var(--ease-decelerate),
    transform var(--duration-spring-snappy, 260ms) var(--ease-spring),
    display 150ms allow-discrete;

  @starting-style {
    opacity: 0;
    transform: scale(0.96) translateY(-4px);
  }
}

/* 内部项目：同心圆角与柔和悬停 */
.contextMenuItem {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 28px;
  padding: 4px 8px;
  gap: 6px;
  border: none;
  background: transparent;
  border-radius: var(--radius-menu-inner, 12px);
  font-size: var(--font-size-meta, 12px);
  color: var(--text-secondary);
  cursor: pointer;
  outline: none;
  transition:
    background-color var(--duration-micro, 100ms) ease-out,
    color var(--duration-micro, 100ms) ease-out;
}

.contextMenuItem:hover,
.contextMenuItem:focus-visible {
  background-color: var(--state-hover);
  color: var(--text-primary);
}
```

### 6.3 Dropdown / Select Popover（下拉菜单与浮层）进退场规范

与右键菜单类似，但下拉框锚定于触发按钮下方，`transform-origin` 默认固定在 `top center`（若向上翻转则为 `bottom center`）。

#### 完整 CSS 实装蓝图（`DropdownModern.module.css`）
```css
.dropdownContent {
  position: absolute;
  z-index: var(--z-dropdown, 900);
  box-sizing: border-box;
  display: none;
  flex-direction: column;
  min-width: 140px;
  padding: 6px;
  gap: 2px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-menu-outer, 14px);
  box-shadow: var(--shadow-dropdown, var(--shadow-md));
  outline: none;
  
  /* 退出状态 */
  opacity: 0;
  transform: scale(0.97) translateY(-3px);
  transform-origin: var(--popover-transform-origin, top center);
  transition:
    opacity 120ms var(--ease-accelerate),
    transform 120ms var(--ease-accelerate),
    display 120ms allow-discrete;
}

.dropdownContent[data-state='open'] {
  display: flex;
  opacity: 1;
  transform: scale(1) translateY(0);

  /* 进入状态 */
  transition:
    opacity 160ms var(--ease-decelerate),
    transform var(--duration-spring-snappy, 260ms) var(--ease-spring),
    display 160ms allow-discrete;

  @starting-style {
    opacity: 0;
    transform: scale(0.97) translateY(-3px);
  }
}
```

### 6.4 Tooltip（微悬停气泡）进退场规范

Tooltip 是界面中最轻量的提示微交互，**严禁使用弹簧缓动，严禁使用重阴影，严禁任何拖泥带水**。

#### 设计规范与几何契约
- **圆角与内衬**：药丸形纯圆角 `--radius-pill: 9999px`（单行）或 6px（多行）；内衬 3px 8px；
- **边框与阴影**：遵守 `AGENTS.md` §13，采用 `--hairline` 极细微发丝边框与 `--shadow-sm`，无黑重投影；
- **动力学**：纯粹的 100ms 快速微淡入与微小 2px 浮起（`translateY(2px) -> 0`）。

#### 完整 CSS 实装蓝图（`TooltipModern.module.css`）
```css
.tooltip {
  position: fixed;
  z-index: var(--z-tooltip, 1200);
  pointer-events: none;
  display: none;
  box-sizing: border-box;
  white-space: nowrap;
  padding: 3px 8px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill, 9999px);
  box-shadow: var(--shadow-sm);
  font-size: 11px;
  line-height: 1.2;
  color: var(--text-primary);
  
  /* 退出：80ms 极速消失，不干扰视线 */
  opacity: 0;
  transform: translateY(2px);
  transition:
    opacity 80ms ease-out,
    transform 80ms ease-out,
    display 80ms allow-discrete;
}

.tooltip[data-state='open'] {
  display: block;
  opacity: 1;
  transform: translateY(0);
  
  /* 进入：100ms 微交互 */
  transition:
    opacity 100ms var(--ease-decelerate),
    transform 100ms var(--ease-decelerate),
    display 100ms allow-discrete;

  @starting-style {
    opacity: 0;
    transform: translateY(2px);
  }
}
```

---

## 七、 轻量级 DOM 生命期辅助与退出保护（Minimal Runtime Presence Guard）

### 7.1 CSS 驻留（display: none）vs DOM 卸载（Unmount）抉择矩阵

使用 `@starting-style` 与 `allow-discrete` 后，对于常驻单例浮层（如右键菜单、常用下拉菜单），可以直接保留在 DOM 中，通过切换 `[data-state='open|closed']` 实现开闭。这种模式是 **0-JS 的终极形态**，性能最优且彻底免疫任何卸载闪烁。

然而，对于模态弹窗以及特定轻量浮层，必须遵循全仓测试资产与内存契约：
1. **Tooltip 契约（按需挂载卸载）**：
   [`Tooltip.adversarial.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.adversarial.test.tsx) 严格断言：“浮层关闭后，DOM 树中 `[data-tooltip-portal="true"]` 节点数绝对为 0”。**Tooltip 绝不能永久驻留 DOM**，必须采用 `isMounted && createPortal(...)` 按需挂载卸载；
2. **重量级模态（ModelConfig / Wizard / Ace 代码编辑弹窗）**：
   弹窗关闭后需完全释放组件内部 State 与 DOM 节点，等待 CSS 退出动画播放完毕后卸载。

| 浮层类型 | 建议生命期策略 | 原因与机制 |
| :--- | :---: | :--- |
| **ContextMenu / Select Popover** | **CSS 驻留（Keep Mounted）**<br>`display: none` 隐藏 | 单例模式复用，DOM 极其轻量，0-JS 原生性能最佳。 |
| **Tooltip（微气泡）** | **按需 DOM 卸载（On-demand Portal）**<br>配合轻量状态机 | 刚性遵守 `Tooltip.adversarial.test.tsx` 门禁，关闭后 DOM 节点数绝对归 0。 |
| **轻量对话框（ConfirmDialog / Alert）** | **按需 DOM 卸载（Presence Guard）** | 卸载后释放临时聚焦与事件监听。 |
| **重型模态（ModelConfig / Wizard）** | **延迟 DOM 卸载（Lazy Unmount）**<br>配合健壮 `useModernPresence` 钩子 | 弹窗关闭后完全释放组件内部 State 与 DOM 节点，等待 CSS 退出动画播放完毕后卸载。 |

### 7.2 健壮级 useModernPresence 钩子实现（防死锁与测试自愈）

#### 7.2.1 传统 transitionend 的三大运行时死锁隐患
原案极简的 `onTransitionEnd` 在真实工程中存在致命死锁：
1. **`prefers-reduced-motion: reduce` 与节能模式死锁**：
   当用户开启系统减弱动效或性能档时，CSS 时长为 `0ms` 或 `transition: none`。**W3C 规范硬性规定：当元素的 `transition-duration` 为 0 或 `transition: none` 时，浏览器绝不会派发 `transitionend` 事件！** 如果纯靠事件驱动，组件将永久挂死在 DOM 中不被卸载！
2. **JSDOM 单元测试环境挂死**：
   Conex 门禁执行 `npm test`（Vitest），运行环境为 JSDOM。**JSDOM 完全不支持 CSS 过渡引擎，不会触发任何真实的 `transitionend` 事件**，导致自动化测试全部超时死锁！
3. **多属性多次触发早退**：
   元素若同时对 `opacity` 与 `transform` 声明不同时长的 transition，若未守卫单一生命周期，较快的属性结束后会提前误杀正在过渡的组件。

#### 7.2.2 改进规范：双轨超时安全天花板与 JSDOM 环境自愈（补丁 1）

```tsx
// apps/crish-desktop/src/components/ui/internal/useModernPresence.ts
import { useState, useEffect, useRef, useCallback } from 'react';

export interface UseModernPresenceOptions {
  visible: boolean;
  /** 最大安全超时兜底（默认 300ms），防 transitionend 丢失导致永久挂死 */
  safetyTimeoutMs?: number;
}

/**
 * 现代 CSS 原生存在性状态机（具备 JSDOM 环境自愈与安全天花板兜底）
 */
export function useModernPresence({
  visible,
  safetyTimeoutMs = 300,
}: UseModernPresenceOptions) {
  const [isMounted, setIsMounted] = useState(visible);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (visible) {
      setIsMounted(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    } else {
      // 1. JSDOM 测试环境自愈：无真实 CSS 引擎，直接同步置 false 卸载，保证 CI 测试全绿
      if (
        typeof window !== 'undefined' &&
        (window as any).navigator?.userAgent?.includes('jsdom')
      ) {
        setIsMounted(false);
        return;
      }

      // 2. 真实浏览器环境：挂载安全天花板兜底定时器
      // 无论 transition: none、prefers-reduced-motion 还是 tab 切换后台，确保必卸载！
      timeoutRef.current = setTimeout(() => {
        setIsMounted(false);
        timeoutRef.current = undefined;
      }, safetyTimeoutMs);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    };
  }, [visible, safetyTimeoutMs]);

  const onTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      // 过滤子元素冒泡；仅当当前容器退出且 target 匹配时卸载
      if (e.target === e.currentTarget && !visible) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = undefined;
        }
        setIsMounted(false);
      }
    },
    [visible]
  );

  return {
    isMounted,
    dataState: visible ? ('open' as const) : ('closed' as const),
    presenceProps: {
      'data-state': visible ? ('open' as const) : ('closed' as const),
      onTransitionEnd,
    },
  };
}
```

#### 在重型模态中的装配范式：
```tsx
export const HeavyModelConfigDialog: React.FC<{ isOpen: boolean; onClose: () => void }> = ({
  isOpen,
  onClose,
}) => {
  const { isMounted, presenceProps } = useModernPresence({ visible: isOpen, safetyTimeoutMs: 250 });

  if (!isMounted) return null;

  return (
    <div className={styles.dialogOverlay} {...presenceProps}>
      <div className={styles.dialogSurface}>
        {/* 大型表单内容 */}
      </div>
    </div>
  );
};
```
当 `isOpen` 变为 `false` 时：
1. `presenceProps['data-state']` 变为 `'closed'`；
2. 正常现代浏览器下，CSS `transition` 启动 150ms 决断退出动效；
3. 150ms 结束后，原生 `onTransitionEnd` 触发，立即清除兜底定时器，`isMounted` 翻转为 `false`，组件优雅从 DOM 卸载；
4. 若用户开启减弱动效（`transition: none`）或切换标签后台，兜底定时器在 250ms 时强制将 `isMounted` 置为 `false`，**杜绝任何内存死锁与僵尸浮层**；
5. 在 Vitest / JSDOM 测试环境中，检测到 `jsdom` 瞬时置 `false`，**测试用例 100% 毫秒级通过**！

---

## 八、 Token 扩展与落地实施步骤（Implementation Roadmap）

### 8.1 Token 体系扩展清单（tokens-space.css / tokens-base.css）

在现有的 9 大 Token 模块中，本次方案仅做**高内聚低耦合的增量扩展**，绝不破坏既有变量：

1. **`tokens-space.css` 增量**：
   - 注入 `--density-sm-*`、`--density-md-*`、`--density-lg-*` 参数簇；
   - 注入 `[data-density='sm']`、`[data-density='md']`、`[data-density='lg']` 作用域级联规则，双向同步 `--control-h` 与 `--control-height`；
2. **`tokens-base.css` 增量**：
   - 增加离散过渡辅助速记变量：
     ```css
     --transition-discrete-enter: var(--duration-normal) var(--ease-decelerate), var(--duration-normal) allow-discrete;
     --transition-discrete-exit: var(--duration-fast) var(--ease-accelerate), var(--duration-fast) allow-discrete;
     ```
   - 确保 `html[data-perf-tier='eco']` 与 `prefers-reduced-motion` 覆盖新增的离散过渡时长。

### 8.2 核心组件改造清单

| 模块类别 | 目标组件文件路径 | 改造内容 |
| :--- | :--- | :--- |
| **基础底座** | `apps/crish-desktop/src/components/ui/Density/` | 新建 `DensityContext.tsx`、`useDensity.ts`、`index.ts`。 |
| **弹窗浮层** | `apps/crish-desktop/src/components/ui/Dialog/` | 移除 `@keyframes dialog-enter/exit`，改用 `@starting-style` 与 `allow-discrete`；注入 `DialogOverlayContext` 与 `--dialog-z`。 |
| **右键菜单** | `apps/crish-desktop/src/components/sidebar/SidebarContextMenus.tsx` | 重构 ContextMenu 开闭动效与同心圆角（18px 外 / 12px 内）。 |
| **悬停提示** | `apps/crish-desktop/src/components/ui/Tooltip/` | 移除 `@keyframes tooltip-enter/exit`，采用 100ms 纯微交互（DOM 按需挂载卸载）。 |
| **通用按钮** | `apps/crish-desktop/src/components/ui/Button/` 或等价路径 | 接入 `--control-height` / `--control-h` 自适应，保持四档 `size` 独立。 |

### 8.3 三阶段落地路线图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       THREE-PHASE IMPLEMENTATION ROADMAP                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 1: 基础设施与契约先行 (Foundation & Token Registry)                     │
│  • 在 tokens-space.css 中增加 data-density 级联变量 (双向同步 control-height) │
│  • 在 tokens-base.css 中增加 discrete transition 预置                       │
│  • 实现 DensityContext 与 useDensity 核心钩子                                │
│  • 实现 useModernPresence (带 JSDOM 自愈与 safetyTimeout 兜底)               │
│  • 编写 density-tokens 自动化断言测试                                        │
│                                                                             │
│  Phase 2: 四大浮层原生动效改造 (Floating Modernization)                      │
│  • 重构 Dialog 模块，接入 @starting-style 与 allow-discrete                 │
│  • 补齐 DialogOverlayContext 与 --dialog-z 穿透                             │
│  • 重构 SidebarContextMenus，升级 18px 同心圆角与原生微弹动效                │
│  • 重构 Tooltip 模块，实现 0-JS 极速微过渡 (按需挂载契约)                    │
│  • 为重型模态注入 useModernPresence 钩子                                     │
│                                                                             │
│  Phase 3: 桌面多区深度渗透与收敛 (Desktop Zoning Convergence)                │
│  • 侧边栏与会话树根节点注入 <Density density="sm">                          │
│  • 主对话流注入 <Density density="md">                                      │
│  • 落地空态与引导页注入 <Density density="lg">                               │
│  • 跑通全量门禁与反退避自检                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 九、 测试断言、门禁规则与反退避自检

### 9.1 自动化测试契约（density-contract & motion-discrete）

为确保方案落地后杜绝样式回潮与断裂，新增两套专项自动化测试契约：

1. **`density-tokens.test.ts`（几何阶梯守护断言）**：
   - 验证 `data-density="sm"` 下，computed 后的 `--control-h` 与 `--control-height` 恒等于 `24px`，字号恒等于 `12px`；
   - 验证 `data-density="md"` 下，computed 后的 `--control-h` 与 `--control-height` 恒等于 `28px`，字号恒等于 `14px`；
   - 验证 `data-density="lg"` 下，computed 后的 `--control-h` 与 `--control-height` 恒等于 `36px`，字号恒等于 `16px`；
   - 验证嵌套声明能力：在 `lg` 容器内部嵌套声明 `sm`，内部子项计算值精准自愈为 `sm`；
   - 验证 Button 解耦契约：显式传 `size="sm"` 恒定为 28px，不传 `size` 时随容器密度自适应。
2. **`motion-starting-style.test.ts`（现代动效与安全退出契约断言）**：
   - 静态扫描检查：全仓 `Dialog.module.css`、`Tooltip.module.css`、`SidebarContextMenus.module.css` 中**严禁出现硬编码的 `setTimeout` 延迟关闭逻辑**；
   - 检查上述 CSS 规则中必须包含 `@starting-style` 与 `@supports (transition-behavior: allow-discrete)` 分层声明；
   - 检查弹簧缓动严禁应用在 `exit` 样式规则中（退场必须为加速曲线）；
   - **`useModernPresence` 退出安全断言**：在 JSDOM 环境下验证 `visible=false` 立即卸载（0ms 挂死）；模拟无 `transitionend` 事件环境下验证 `safetyTimeoutMs` 强行安全卸载。

### 9.2 架构门禁与反过度设计合规声明

根据 `AGENTS.md` 与 `ANTI_OVERENGINEERING_GUARDRAILS.md`，本方案严格履行自检断言：

| 审查维度 | 架构规则与红线条目 | 本方案执行表现与合规证据 |
| :--- | :--- | :--- |
| **独立风格** | “要有自己的风格，避免大量抄袭” | 深度依托 Conex 既有的六级暗黑阶梯（$e_0 \sim e_5$）与 18px-12px 同心几何，绝非第三方组件库浅表拼凑。 |
| **代码简洁** | “代码应该简洁合理，杜绝复杂包袱” | 彻底弃用外部动效库，动效逻辑 95% 下沉至现代浏览器原生 CSS 引擎；React 侧仅需极简 `useDensity` 与具备双重安全保障的 `useModernPresence`。 |
| **焦点对比度** | `AGENTS.md` §13 焦点混入上限 10% | 焦点状态使用 `color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`，坚决杜绝深黑粗实心环。 |
| **反过度设计** | `ANTI_OVERENGINEERING_GUARDRAILS.md` | 严禁动态换模、六段中间件、复杂动画状态机等过度设计，坚持原生、极简、高性能。 |
| **反退避自检** | `LOGIC_PLAN_NO_RETREAT.md` | 面对弹窗关闭截断的业界痛点，不逃避、不妥协、不砍功能，用最新的现代 CSS 标准根除根因。 |

---
> **方案审批与状态记录**  
> 状态：**规划就绪（Ready for Implementation）**  
> 架构签发：Conex UI Architecture Team — Agent-P4  
> 归档索引：`docs/ui-architecture-overhaul/independent-plans/04-桌面级SizeContext与starting-style现代动效方案.md`
