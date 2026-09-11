# 04 · UI 原子层 ScrollArea 组件封装与端点物理护栏详案
## （维度 4：scroll-area 独立实现详案 · 最终定稿版）

> **文档标识**：`docs/unified-scrollbar-system/detailed-plans/04-plan-scroll-area.md`
> **所属战役**：统一通用滚动条体系与 ScrollArea 高频组件战役（Unified Scrollbar System）
> **方案定稿责任专家**：ScrollArea Plan Finalizer（UI 原子层 ScrollArea 组件封装与端点物理护栏专家）
> **编制基准时间**：2026-09-02
> **权威遵循**：`docs/unified-scrollbar-system/00-master-plan.md`（§3.4 维度 4 总纲）、`AGENTS.md`（通用纪律、反退避铁律、§7 严禁补丁/绕过、§7.1 立体验证纪律）、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`apps/crish-desktop/src/components/ui/README.md`（UI 原子层纯净契约，零 store/hooks 依赖，通过 `check:ui-layer`）。
> **评审纠偏指令闭环**：`02-review-contracts.md`（FIX-B-01 ~ FIX-B-06 渲染与尺寸补正）、`03-review-crossplatform.md`（M02 ~ M04 极端圆角避让、退化紧凑态与 xs 尺寸解禁）。

---

## 目录

- [一、主审裁决立场与用户最高铁律宣誓](#一主审裁决立场与用户最高铁律宣誓)
  - [1. 滚动条二元灰度绝对死锁（绝无第三种 Hover 灰）](#1-滚动条二元灰度绝对死锁绝无第三种-hover-灰)
  - [2. 端点物理护栏（Padded Endcaps 彻底杜绝圆角截断）](#2-端点物理护栏padded-endcaps-彻底杜绝圆角截断)
  - [3. 四级 Token 宽度体系（严禁全仓裸写 px）](#3-四级-token-宽度体系严禁全仓裸写-px)
  - [4. UI 原子层绝对解耦（零 store/hooks 依赖）](#4-ui-原子层绝对解耦零-storehooks-依赖)
  - [5. 评审硬伤与工程盲区修正宣誓（FIX-B-01~06 & M02~M04 全闭环）](#5-评审硬伤与工程盲区修正宣誓fix-b-0106--m02m04-全闭环)
- [二、架构动因与原子层定位（Architecture Motivation & UI Layer Boundary）](#二架构动因与原子层定位architecture-motivation--ui-layer-boundary)
  - [2.1 现存缺陷深度剖析与宿主断层](#21-现存缺陷深度剖析与宿主断层)
  - [2.2 UI 原子层第一层分级契约（`ui/README.md`）](#22-ui-原子层第一层分级契约uireadmemd)
  - [2.3 双轨分级定位：Mode 1（ScrollArea）与 Mode 2（纯 CSS）边界](#23-双轨分级定位mode-1scrollarea与-mode-2纯-css边界)
- [三、三段式物理隔离轨道布局与端点物理护栏模型](#三三段式物理隔离轨道布局与端点物理护栏模型)
  - [3.1 几何盒模型与 DOM 隔离结构](#31-几何盒模型与-dom-隔离结构)
  - [3.2 端点安全护栏微型圆角矢量箭头（Endcap Arrow Glyphs）](#32-端点安全护栏微型圆角矢量箭头endcap-arrow-glyphs)
  - [3.3 物理真空隔离带（Safe Gap）的缓冲机制](#33-物理真空隔离带safe-gap的缓冲机制)
  - [3.4 极端圆角断头台切角防护与动态安全内缩（Math-Driven Inset，M02 落地）](#34-极端圆角断头台切角防护与动态安全内缩math-driven-insetm02-落地)
  - [3.5 算术下溢崩溃防御与退化紧凑态（Degraded Compact Mode，M03 落地）](#35-算术下溢崩溃防御与退化紧凑态degraded-compact-modem03-落地)
  - [3.6 滑块全生命周期 Pointer Capture 拖拽交互引擎（拖拽滚动补齐）](#36-滑块全生命周期-pointer-capture-拖拽交互引擎拖拽滚动补齐)
- [四、代数极限不变量数学完备证明](#四代数极限不变量数学完备证明)
  - [4.1 几何参数与坐标系符号定义](#41-几何参数与坐标系符号定义)
  - [4.2 【定理 1：上极限绝对防侵入定理】证明](#42-定理-1上极限绝对防侵入定理证明)
  - [4.3 【定理 2：下极限绝对防侵入定理】证明](#43-定理-2下极限绝对防侵入定理证明)
  - [4.4 【定理 3：外层容器圆角刺穿杜绝定理（Corner Leaking Prevention）】证明](#44-定理-3外层容器圆角刺穿杜绝定理corner-leaking-prevention证明)
  - [4.5 【定理 4：滑块尺寸夹持与行程退化不变量】证明（真实 18px 物理下限夹持）](#45-定理-4滑块尺寸夹持与行程退化不变量证明真实-18px-物理下限夹持)
  - [4.6 【定理 5：水平方向横轴双向对称性不变性】证明](#46-定理-5水平方向横轴双向对称性不变性证明)
  - [4.7 【定理 6：算术下溢退化紧凑态防御定理】证明](#47-定理-6算术下溢退化紧凑态防御定理证明)
- [五、20Hz 脉冲微调步进引擎与动力学控制](#五20hz-脉冲微调步进引擎与动力学控制)
  - [5.1 40px 黄金步长与视口自适应弹性算法](#51-40px-黄金步长与视口自适应弹性算法)
  - [5.2 极值边界微像素吸附机制（Edge Snapping）](#52-极值边界微像素吸附机制edge-snapping)
  - [5.3 20Hz 脉冲微调节拍模型（250ms 延迟 + 50ms 连发）](#53-20hz-脉冲微调节拍模型250ms-延迟--50ms-连发)
  - [5.4 刚性制动机制（Rigid Auto-Brake）与全生命周期守卫（含横向边界制动）](#54-刚性制动机制rigid-auto-brake与全生命周期守卫含横向边界制动)
  - [5.5 无障碍降级守卫（Reduced Motion Guard & A11y）](#55-无障碍降级守卫reduced-motion-guard--a11y)
- [六、组件 API 契约与 TypeScript 类型规范](#六组件-api-契约与-typescript-类型规范)
  - [6.1 类型定义契约（`ScrollArea.types.ts`）](#61-类型定义契约scrollareatypests)
  - [6.2 命令式控制器 Handle 契约（`ScrollAreaHandle`）](#62-命令式控制器-handle-契约scrollareahandle)
  - [6.3 属性 Props 契约（`ScrollAreaProps`，解除 xs 霸王条款并注入 Inset）](#63-属性-props-契约scrollareaprops解除-xs-霸王条款并注入-inset)
- [七、完整生产级代码落盘规范](#七完整生产级代码落盘规范)
  - [7.1 `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.types.ts`](#71-appscrish-desktopsrccomponentsuiscrollareascrollareatypests)
  - [7.2 `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.tsx`](#72-appscrish-desktopsrccomponentsuiscrollareascrollareatsx)
  - [7.3 `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css`](#73-appscrish-desktopsrccomponentsuiscrollareascrollareamodulecss)
  - [7.4 `apps/crish-desktop/src/components/ui/ScrollArea/index.ts`](#74-appscrish-desktopsrccomponentsuiscrollareaindexts)
  - [7.5 `apps/crish-desktop/src/components/ui/index.ts` Barrel 出口集成](#75-appscrish-desktopsrccomponentsuiindexts-barrel-出口集成)
- [八、Vitest 单元测试规格（`ScrollArea.test.tsx`）](#八vitest-单元测试规格scrollareatesttsx)
  - [8.1 测试用例规划矩阵（TC-SA-01 至 TC-SA-10）](#81-测试用例规划矩阵tc-sa-01-至-tc-sa-10)
  - [8.2 完整单元测试代码规格（`ScrollArea.test.tsx`）](#82-完整单元测试代码规格scrollareatesttsx)
- [九、本方案要删掉什么 / 收敛什么（删除面 Deletions Surface）](#九本方案要删掉什么--收敛什么删除面-deletions-surface)
  - [9.1 彻底删除弹窗与菜单中的防越界内边距魔术数字补丁](#91-彻底删除弹窗与菜单中的防越界内边距魔术数字补丁)
  - [9.2 彻底删除各业务视口手写的临时模拟滚动 JS 胶水代码](#92-彻底删除各业务视口手写的临时模拟滚动-js-胶水代码)
  - [9.3 彻底杜绝引入任何第三方重型滚动库](#93-彻底杜绝引入任何第三方重型滚动库)
  - [9.4 彻底杜绝对上层 Store 与 Hooks 的反向依赖侵蚀](#94-彻底杜绝对上层-store-与-hooks-的反向依赖侵蚀)
  - [9.5 彻底清除 translateY 百分比断裂与混淆的 18% 百分比下限](#95-彻底清除-translatey-百分比断裂与混淆的-18-百分比下限)
  - [9.6 全仓删除面代码行数度量清单](#96-全仓删除面代码行数度量清单)
- [十、验收断言与立体验证套件](#十验收断言与立体验证套件)
  - [10.1 静态门禁刚性断言](#101-静态门禁刚性断言)
  - [10.2 单元测试自动化断言](#102-单元测试自动化断言)
  - [10.3 几何极限、端点避让与二元灰度物理断言](#103-几何极限端点避让与二元灰度物理断言)
  - [10.4 动力学脉冲响应与拖拽交互断言](#104-动力学脉冲响应与拖拽交互断言)

---

## 一、主审裁决立场与用户最高铁律宣誓

作为战役方案定稿专家（ScrollArea Plan Finalizer：UI 原子层 ScrollArea 组件封装与端点物理护栏），本方案严格遵奉《主 Agent 全流程调度提示词 v3》与 `docs/unified-scrollbar-system/00-master-plan.md`，庄严宣誓并锁定以下最高约束铁律：

### 1. 滚动条二元灰度绝对死锁（绝无第三种 Hover 灰）
- **用户原话**：“**滚动条就是两种灰度，别给我整成三种的，就是激活和未激活，没有激活分成 hover 和 active 两种的。**”
- **未激活态（Inactive / Idle）**：屏幕物理灰度值严格锁死在 **8.2% 左右**（浅色暖纸底板下，通道 $\Delta_{R-B} = +4$，注入 1.5% `--accent-orange` 品牌底韵，与背景自然共生，绝不刺眼）；
- **激活态（Active，Hover、Active 与 Dragging 拖拽统统同色）**：屏幕物理灰度值从历史 31.4% 脏黑彻底纠偏下调至 **20.2% 左右**；
- **差值死锁**：激活态与未激活态之间保持严格的 **约 12.0% 增量阶梯**。全组件 CSS 与 JS 严格将 `:hover`、`:active` 与拖拽态赋予完全相同的色彩变量（消费 `--scrollbar-thumb-active` 与 `--scrollbar-button-hover-color`），**严禁存在任何第三种中间灰度！**

### 2. 端点物理护栏（Padded Endcaps 彻底杜绝圆角截断）
- 容器采用**三段式物理隔离轨道布局**，两端配备带圆角矢量三角箭头的端点安全护栏（Padded Endcaps）；
- 滑块（Thumb）在两端箭头之间运行，在空间盒模型上被物理夹持在中间的独立游弋轨道内；
- 在数学上证明：滑块行程极限距离两端箭头始终保持严格的 **2px 物理真空带（Safe Gap）**，从物理根源上彻底避免滑块贴近外层圆角或发生直角截断（Corner Clipping）！

### 3. 四级 Token 宽度体系（严禁全仓裸写 px）
- 宽度严格且只能在 Token 体系中选择：
  - `xs`: 4px（`--scrollbar-width-xs`，用于极细浮层，默认无按钮，允许显式开启）；
  - `sm`: 5px（`--scrollbar-width-sm`，用于紧凑二级菜单与辅助抽屉）；
  - `md`: 7px（`--scrollbar-width-md`，标准系统默认基准，用于弹窗、设置页）；
  - `lg`: 9px（`--scrollbar-width-lg`，用于宽屏双栏与海量日志）；
- `<ScrollArea>` 组件属性 `size?: 'xs' | 'sm' | 'md' | 'lg'` 严格映射至上述 Token，**组件内部与消费方严禁裸写任何硬编码像素！**

### 4. UI 原子层绝对解耦（零 store/hooks 依赖）
- 组件落盘于 `apps/crish-desktop/src/components/ui/ScrollArea/`，定位为第一层 UI 原子组件；
- 遵循 `apps/crish-desktop/src/components/ui/README.md`，**严禁引入任何业务 store（zustand）、`hooks/`、`api/`、`services/` 或其他业务域组件**；
- 100% 独立自洽，刚性通过 `npm run check:ui-layer` 静态架构门禁。

### 5. 评审硬伤与工程盲区修正宣誓（FIX-B-01~06 & M02~M04 全闭环）
根据交叉评审报告 `02-review-contracts.md` 与 `03-review-crossplatform.md` 的严肃指令，本方案庄严承诺在代码与规范中彻底根除以下 7 大硬伤：
1. **彻底纠正 transform 百分比基准错误（FIX-B-01）**：滑块定位彻底废弃自身高度百分比的 `translateY`，修正为基于轨道的绝对像素偏移 `top: ${thumbTopPx}px`（或基于轨道的绝对百分比 `top: ${thumbTopPercent}%`）；
2. **彻底纠正下限百分比数值混淆（FIX-B-02）**：将 `Math.max(18, ...)%` 纠正为真实的 **18px 物理像素级夹持**；
3. **补齐滑块全生命周期鼠标拖拽交互引擎**：为 `.thumbIndicator` 完整注入 Pointer Capture 机制，实现 `onPointerDown`、`setPointerCapture` 与 `deltaY` 到 `viewport.scrollTop` 的精准动力学映射；
4. **彻底废除 size="xs" 强制关闭按钮霸王条款（M04）**：规则变更为 `showButtons ?? (size !== 'xs')`，允许 `size="xs"` 在显式声明 `showButtons={true}` 时渲染 4px 微型安全三角；
5. **全面落地极端圆角断头台切角防护（M02）**：实装 `calculateSafeAreaInset(radius, margin)` 算法与动态 `insetTop` / `insetBottom` 避让，彻底杜绝 14px 浮层圆角削切顶部箭头；
6. **全面落地算术下溢退化紧凑态（M03）**：当 `clientHeight < 16px` 或可用轨道空间不足以容纳最小滑块时，自动退化隐藏按钮恢复全行程滑块；
7. **全面统一 Token 命名体系**：滑块激活变量统一为 `--scrollbar-thumb-active`，按钮变量统一为 `--scrollbar-button-*`。

---

## 二、架构动因与原子层定位（Architecture Motivation & UI Layer Boundary）

### 2.1 现存缺陷深度剖析与宿主断层

在 Conex / Crish 桌面端长期的业务演进中，常规视口组件（Dialog、Menu、Select、ModelBadgePickerMenu、SettingsPanel）面临着严重的滚动体验碎片化与视觉残缺：

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             现存滚动缺陷白盒解剖                                  │
├────────────────────────────────┬─────────────────────────────────────────────────┤
│ 缺陷 1：圆角刺穿与破边截断     │ 弹窗具有 border-radius: 8px~14px，原生滚动条直通 │
│ (Corner Clipping Disaster)     │ 顶底，矩形滑块在两极直接刺穿圆角弧线，产生缺角。 │
├────────────────────────────────┼─────────────────────────────────────────────────┤
│ 缺陷 2：侵占点击命中区         │ 传统带按钮方案中，滑块滚动到 0% 或 100% 时叠在   │
│ (Hit-Test Target Collision)    │ 按钮正上方，导致按钮 hover/active 无法触发。     │
├────────────────────────────────┼─────────────────────────────────────────────────┤
│ 缺陷 3：业务层内边距补丁泛滥   │ 为防滑块贴边，各弹窗私加 padding-right: 4px 等   │
│ (Ad-hoc Padding Hacks)         │ 胶水补偿，破坏整体排版对齐（见 §9 删除面清单）。 │
├────────────────────────────────┼─────────────────────────────────────────────────┤
│ 缺陷 4：微调交互缺失           │ 长列表浮层缺乏平滑单步微调，滚轮滚动过猛容易跳过 │
│ (Lack of Micro-Stepping)       │ 精确项，长按缺乏平滑连击动力学支持。             │
├────────────────────────────────┼─────────────────────────────────────────────────┤
│ 缺陷 5：模拟滑块拖拽缺失       │ 自定义轨道的滑块若不支持鼠标捕获拖拽，用户通过   │
│ (Lack of Drag Dynamics)        │ 鼠标抓取滑块将毫无响应，严重违反桌面交互预期。   │
└────────────────────────────────┴─────────────────────────────────────────────────┘
```

### 2.2 UI 原子层第一层分级契约（`ui/README.md`）

依据仓库架构规范，前端工程划分严格的三层架构：
```
components/
├── ui/            ← 【第一层：UI 原子层】（ScrollArea 的唯一合法归属地）
├── (域目录 28 个)  ← 第二层：业务组件层（Menu/Dialog/Select/Settings 等）
└── App*/TopBar…    ← 第三层：页面/编排层
```

- **分层门禁（`npm run check:ui-layer`）**：
  - 扫描 `src/components/ui/` 下所有文件的 `import` 语句；
  - 命中 `components/(?!ui)`、`store/`、`hooks/`、`api/`、`services/` 任一路径立即阻断 CI。
  - **组件内部实现要求**：定时器、测量、动画和事件监听全部使用 React 原生能力（`useRef`, `useState`, `useCallback`, `useEffect`, `useImperativeHandle`），绝不依赖外部状态管理或全局 Hooks！

### 2.3 双轨分级定位：Mode 1（ScrollArea）与 Mode 2（纯 CSS）边界

依据总纲 `00-master-plan.md`，滚动体系确立清晰的消费双轨制：

1. **Mode 1（React 原子组件 `<ScrollArea>`）——本方案核心范围**：
   - **定位**：高频弹出层、设置面板、独立对话框、菜单下拉。
   - **特点**：提供物理隔离轨道、端点安全护栏、圆角 Inset 避让、20Hz 脉冲微调、滑块 Pointer Capture 拖拽引擎、命令式 Handle API、完整的 ARIA 无障碍属性。
2. **Mode 2（纯 CSS 类名 `.scrollArea*`）——维度 3/5 范围，本方案不重叠入侵**：
   - **定位**：虚拟滚动瀑布流（`MessageVirtualizer`）、无限长列表（`WindowedSessionUl`）、侧边栏会话树。
   - **边界铁律**：虚拟滚动容器强依赖精准的 `scrollTop` 连续捕获与 Undo 锚定微任务，**严禁套用 `<ScrollArea>` React DOM 包装**，必须直接消费纯 CSS 类名。本方案的 `<ScrollArea>` 绝不侵入虚拟列表，彻底维持架构解耦！

---

## 三、三段式物理隔离轨道布局与端点物理护栏模型

### 3.1 几何盒模型与 DOM 隔离结构

`<ScrollArea>` 在结构上将原生滚动与视觉呈现解耦，通过三段式侧柱达成物理隔离：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ScrollArea Root (relative, overflow: hidden, border-radius: var(--radius-*))           │
│ ┌───────────────────────────────────────────────────────────┐ ┌───────────────────────┐ │
│ │ Viewport (原生可滚动容器，内部隐藏 WebKit 原生滚动条)    │ │ Stepper Track Column  │ │
│ │   overflow-y: auto; scrollbar-width: none;                │ │ (absolute, 悬浮于侧边)│ │
│ │ ┌───────────────────────────────────────────────────────┐ │ │ ┌───────────────────┐ │ │
│ │ │ Content Wrapper                                       │ │ │ │ [ ▲ ] Top Button  │ │ │ ← 上端点安全护栏 (避让 Inset)
│ │ │                                                       │ │ │ ├───────────────────┤ │ │
│ │ │                                                       │ │ │ │ Safe Gap (2px)    │ │ │ ← 物理真空隔离带
│ │ │                                                       │ │ │ ├───────────────────┤ │ │
│ │ │                                                       │ │ │ │ Isolated Track    │ │ │
│ │ │                                                       │ │ │ │ ┌───────────────┐ │ │ │
│ │ │                                                       │ │ │ │ │  Thumb        │ │ │ │ ← 滑块被约束在 Track 盒内部
│ │ │                                                       │ │ │ │ │  (Indicator)  │ │ │ │   top: ${thumbTopPx}px 真实偏移
│ │ │                                                       │ │ │ │ └───────────────┘ │ │ │   支持 Pointer Capture 拖拽
│ │ │                                                       │ │ │ ├───────────────────┤ │ │
│ │ │                                                       │ │ │ │ Safe Gap (2px)    │ │ │ ← 物理真空隔离带
│ │ │                                                       │ │ │ ├───────────────────┤ │ │
│ │ │                                                       │ │ │ │ [ ▼ ] Bot Button  │ │ │ ← 下端点安全护栏 (避让 Inset)
│ │ │ └─────────────────────────────────────────────────────┘ │ │ └───────────────────┘ │ │
│ │ └─────────────────────────────────────────────────────────┘ └───────────────────────┘ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 端点安全护栏微型圆角矢量箭头（Endcap Arrow Glyphs）

端点按钮不仅充当 20Hz 脉冲微调的触发器，更是物理意义上的**机械安全限位挡块（Mechanical Stop Block）**：
- **圆角矢量几何契约（FIX-B-03 落地）**：内嵌 $10 \times 10$ 视口微型三角，彻底废除尖锐毛刺的 polygon 硬角，改用带有 `strokeLinejoin="round"` 与微型圆角过渡的平滑 SVG Path 矢量路径，确保高 DPI 下绝无锯齿锐角；
- **自适应尺寸契约与 M04 解禁**：
  - `xs`: 默认不渲染按钮（槽位 0px），但支持显式开启（`showButtons ?? (size !== 'xs')`），开启时按钮高宽为 4px；
  - `sm`: 按钮高宽等于 `--scrollbar-button-size-sm`（5px）；
  - `md`: 按钮高宽等于 `--scrollbar-button-size-md`（7px）；
  - `lg`: 按钮高宽等于 `--scrollbar-button-size-lg`（9px）；
- **状态感知**：视口处于顶端（$\rho=0$）时，上按钮自动禁用（`opacity: 0.2`, `pointer-events: none`）；处于底端（$\rho=1$）时，下按钮自动禁用。

### 3.3 物理真空隔离带（Safe Gap）的缓冲机制

在按钮与独立滑行轨道之间，永久注入高度为 `--scrollbar-track-safe-gap: 2px` 的物理真空隔离带：
- **盒模型独立**：独立轨道（`isolatedTrack`）具备 `flex: 1` 弹性伸缩能力，并在垂直方向与按钮完全脱耦；
- **绝对空隙保护**：即使滑块滚动至 $\rho=0$（顶部极限）或 $\rho=1$（底部极限），滑块边缘与按钮边缘也恒有 2px 的绝对空隙，彻底解决叠印遮挡。

### 3.4 极端圆角断头台切角防护与动态安全内缩（Math-Driven Inset，M02 落地）

针对外层弹窗拥有 `border-radius: 8px ~ 14px` 的常见场景，如果侧柱直接从顶部 `top: 2px` 布局，顶部三角按钮的右上顶点将直接穿入外层圆角弧线内，被 `overflow: hidden` 削切成畸形梯形（断头台切角，Corner Guillotine Clipping）：
- **精确代数推导**：以容器右上圆角圆心为原点建立直角坐标系，设容器外缘圆角半径为 $R$，滚动条离容器右外边框间距为 $M$。在横坐标 $x = \max(0, R - M)$ 处，圆弧切线高度为 $\sqrt{R^2 - x^2}$，圆角内缩深度为：
  $$\text{minInset} = R - \sqrt{R^2 - (\max(0, R - M))^2}$$
- **光栅化与高 DPI 缓冲**：为防止高 DPI（125%/150%）浮点渲染导致的亚像素渗漏，增加 1px 的安全冗余：
  $$\text{calculateSafeAreaInset}(R, M) = \lceil \text{minInset} \rceil + 1$$
- **布局避让生效**：侧柱顶部内缩偏移量自动修正为 $\text{insetTop} = \text{calculateSafeAreaInset}(R, M) + M$。在 14px 弹窗圆角下，按钮被精确下移避让，100% 运行在平直内壁上！

### 3.5 算术下溢崩溃防御与退化紧凑态（Degraded Compact Mode，M03 落地）

当容器高度被极端压缩（例如弹窗被软键盘顶起、高密表单折叠或容器视口极小）时，轨道总空间可能小于两端按钮与隔离带的高度和：
$$\text{AvailableTrackSpace} = H_{\text{container}} - (\text{insetTop} + \text{insetBottom}) - 2 \times H_{\text{btn}} - 2 \times G_{\text{safe}}$$
- **退化紧凑态机制**：当 $H_{\text{container}} < 16\text{px}$ 或 $\text{AvailableTrackSpace} < 16\text{px}$（无法容纳最小 18px 滑块）时，`<ScrollArea>` 自动进入 **Degraded Compact Mode（退化紧凑态）**；
- **自适应降级动作**：
  1. 临时自毁隐藏上下三角步进按钮及真空隔离带；
  2. 恢复全行程滑块滚动，可用轨道高度自动回退为 $H_{\text{container}} - (\text{insetTop} + \text{insetBottom})$；
  3. 绝对禁止计算负数高度或产生按钮重叠坍塌。

### 3.6 滑块全生命周期 Pointer Capture 拖拽交互引擎（拖拽滚动补齐）

为弥补自定义轨道缺乏滑块抓取拖拽的严重人机工程缺陷，本方案为 `.thumbIndicator` 注入基于 W3C Pointer Events 标准的强劲拖拽引擎：
- **Pointer Capture 锁定**：用户在滑块上触发 `pointerdown`（左键）瞬间，立即调用 `(e.target as HTMLElement).setPointerCapture(e.pointerId)`，将后续所有光标移动牢牢锁死在滑块处理函数中，即使光标飞速甩出轨道或窗口也绝不丢帧；
- **动力学精准映射**：
  - 记录起始光标坐标 $Y_{\text{start}}$ 与起始滚动值 $S_{\text{start}}$；
  - 动态计算光标在轨道内的位移增量 $\Delta Y = Y_{\text{current}} - Y_{\text{start}}$；
  - 依据当前最大位移行程 $D_{\text{travel}} = H_{\text{track}} - H_{\text{thumb}}$ 与视口最大可滚动距离 $S_{\max} = H_{\text{content}} - H_{\text{viewport}}$，推导视口滚动映射：
    $$S_{\text{target}} = \text{clamp}\left(0,\ S_{\text{start}} + \Delta Y \times \frac{S_{\max}}{D_{\text{travel}}},\ S_{\max}\right)$$
  - 直接写入 `internalViewportRef.current.scrollTop = S_{\text{target}}`；
- **优雅捕获释放**：在 `pointerup` 或 `pointercancel` 时立即调用 `releasePointerCapture` 并重置拖拽状态；
- **状态感知视觉反馈**：拖拽期间 `.thumbIndicator` 挂载 `.dragging` 类，指针样式由 `cursor: grab` 切换为 `cursor: grabbing`，色彩保持 `--scrollbar-thumb-active` 二元死锁激活态。

---

## 四、代数极限不变量数学完备证明

为确保端点物理护栏在全工况下具备严格的无越界数学保证，以下给出严密的代数不变量推导：

### 4.1 几何参数与坐标系符号定义

设：
- 外层容器物理总高度为 $H_{\text{root}} > 0$；
- 外层容器外缘圆角半径为 $R_{\text{corner}} \ge 0$；
- 侧柱基准外边缘边距 $\text{Margin}_{\text{track}} = 2\text{px}$；
- 极端圆角安全内缩避让距离 $\text{Inset}_{\text{safe}} = \text{calculateSafeAreaInset}(R_{\text{corner}}, \text{Margin}_{\text{track}})$；
- 侧柱绝对定位顶底边距：
  $$\text{Inset}_{\text{top}} = \text{Margin}_{\text{track}} + \text{Inset}_{\text{safe}}, \quad \text{Inset}_{\text{bottom}} = \text{Margin}_{\text{track}} + \text{Inset}_{\text{safe}}$$
- 顶部与底部按钮高度分别为 $H_{\text{btn,top}}$ 与 $H_{\text{btn,bottom}}$，开启按钮时 $H_{\text{btn,top}} = H_{\text{btn,bottom}} = H_{\text{btn}} > 0$；
- 上下物理真空隔离带高度 $G_{\text{safe}} = 2\text{px}$；
- 独立游弋轨道的净高度定义为：
  $$H_{\text{track}} = \begin{cases}
  H_{\text{root}} - (\text{Inset}_{\text{top}} + \text{Inset}_{\text{bottom}}) - 2(H_{\text{btn}} + G_{\text{safe}}), & \text{正常模式 (包含按钮)} \\
  H_{\text{root}} - (\text{Inset}_{\text{top}} + \text{Inset}_{\text{bottom}}), & \text{退化紧凑态 (隐藏按钮)}
  \end{cases}$$
- 视口可见高度为 $H_{\text{viewport}}$，内容总滚动高度为 $H_{\text{content}}$，最大滚动距离 $S_{\max} = \max(0, H_{\text{content}} - H_{\text{viewport}})$；
- 实时滚动进度为 $\rho(t) = \frac{\text{scrollTop}(t)}{S_{\max}} \in [0, 1]$（当 $S_{\max} = 0$ 时退化定义 $\rho = 0$）；
- **滑块最小物理像素高度（FIX-B-02 锁定）**：$H_{\text{thumb,min}} = 18\text{px}$；
- 滑块计算物理高度为：
  $$H_{\text{thumb}} = \text{clamp}\left(18\text{px},\ \frac{H_{\text{viewport}}}{H_{\text{content}}} \times H_{\text{track}},\ H_{\text{track}}\right)$$
- 滑块在轨道内的最大位移行程：$D_{\text{travel}} = \max(0, H_{\text{track}} - H_{\text{thumb}})$；
- 滑块相对于独立轨道顶部的真实物理位移：$Y_{\text{thumb,rel}}(\rho) = \rho \cdot D_{\text{travel}}$。

---

### 4.2 【定理 1：上极限绝对防侵入定理】证明

**断言**：在正常模式下的任意滚动进度 $\rho \in [0, 1]$ 下，滑块上边缘在容器全局坐标系中的绝对坐标 $Y_{\text{thumb,top}}(\rho)$ 与顶部按钮下边缘 $Y_{\text{btn,top,bottom}}$ 之间的物理净空恒大于等于 $G_{\text{safe}} = 2\text{px}$，即滑块绝对不侵入顶部按钮。

**推导证明**：
1. 顶部按钮占据垂直区间为 $[\text{Inset}_{\text{top}},\ \text{Inset}_{\text{top}} + H_{\text{btn}}]$，其下边缘绝对坐标为：
   $$Y_{\text{btn,top,bottom}} = \text{Inset}_{\text{top}} + H_{\text{btn}}$$
2. 独立轨道的起始顶端绝对坐标为：
   $$Y_{\text{track,top}} = \text{Inset}_{\text{top}} + H_{\text{btn}} + G_{\text{safe}}$$
3. 滑块上边缘的全局绝对坐标为：
   $$Y_{\text{thumb,top}}(\rho) = Y_{\text{track,top}} + Y_{\text{thumb,rel}}(\rho) = \text{Inset}_{\text{top}} + H_{\text{btn}} + G_{\text{safe}} + \rho \cdot D_{\text{travel}}$$
4. 计算两者的距离函数 $\Delta_{\text{top}}(\rho)$：
   $$\Delta_{\text{top}}(\rho) = Y_{\text{thumb,top}}(\rho) - Y_{\text{btn,top,bottom}} = G_{\text{safe}} + \rho \cdot D_{\text{travel}}$$
5. 由于 $\rho \ge 0$ 且 $D_{\text{travel}} \ge 0$，距离函数在 $\rho = 0$ 处取得极小值：
   $$\min_{\rho \in [0, 1]} \Delta_{\text{top}}(\rho) = \Delta_{\text{top}}(0) = G_{\text{safe}} = 2\text{px} > 0$$

**结论**：在最顶端极限 $\rho = 0$ 处，滑块与顶部按钮之间严格守住 $2\text{px}$ 物理真空净空，空间侵入概率恒为 0。**证毕。**

---

### 4.3 【定理 2：下极限绝对防侵入定理】证明

**断言**：在正常模式下的任意滚动进度 $\rho \in [0, 1]$ 下，滑块下边缘绝对坐标 $Y_{\text{thumb,bottom}}(\rho)$ 与底部按钮上边缘 $Y_{\text{btn,bottom,top}}$ 之间的物理净空恒大于等于 $G_{\text{safe}} = 2\text{px}$，即滑块绝对不侵入底部按钮。

**推导证明**：
1. 底部按钮占据区间为 $[H_{\text{root}} - \text{Inset}_{\text{bottom}} - H_{\text{btn}},\ H_{\text{root}} - \text{Inset}_{\text{bottom}}]$，其上边缘绝对坐标为：
   $$Y_{\text{btn,bottom,top}} = H_{\text{root}} - \text{Inset}_{\text{bottom}} - H_{\text{btn}}$$
2. 独立轨道底端绝对坐标由轨道总长决定：
   $$Y_{\text{track,bottom}} = Y_{\text{track,top}} + H_{\text{track}} = H_{\text{root}} - \text{Inset}_{\text{bottom}} - H_{\text{btn}} - G_{\text{safe}}$$
3. 滑块下边缘在滚动进度 $\rho$ 下的全局绝对坐标为：
   $$Y_{\text{thumb,bottom}}(\rho) = Y_{\text{track,top}} + \rho \cdot D_{\text{travel}} + H_{\text{thumb}}$$
4. 当滚动到达最底部极限 $\rho = 1$ 时，代入 $D_{\text{travel}} = H_{\text{track}} - H_{\text{thumb}}$：
   $$Y_{\text{thumb,bottom}}(1) = Y_{\text{track,top}} + (H_{\text{track}} - H_{\text{thumb}}) + H_{\text{thumb}} = Y_{\text{track,top}} + H_{\text{track}} = Y_{\text{track,bottom}}$$
5. 计算最底极限处两者的净空距离 $\Delta_{\text{bottom}}(1)$：
   $$\Delta_{\text{bottom}}(1) = Y_{\text{btn,bottom,top}} - Y_{\text{thumb,bottom}}(1) = (H_{\text{root}} - \text{Inset}_{\text{bottom}} - H_{\text{btn}}) - (H_{\text{root}} - \text{Inset}_{\text{bottom}} - H_{\text{btn}} - G_{\text{safe}}) = G_{\text{safe}} = 2\text{px}$$
6. 对于任意 $\rho \in [0, 1]$，由于 $\rho \le 1$ 且 $D_{\text{travel}} \ge 0$，必有：
   $$Y_{\text{thumb,bottom}}(\rho) \le Y_{\text{thumb,bottom}}(1) \implies \Delta_{\text{bottom}}(\rho) \ge \Delta_{\text{bottom}}(1) = 2\text{px} > 0$$

**结论**：在最底端极限 $\rho = 1$ 处，滑块下沿与底部按钮上沿始终保持 $2\text{px}$ 物理隔离，绝对不可能发生重叠或挤压。**证毕。**

---

### 4.4 【定理 3：外层容器圆角刺穿杜绝定理（Corner Leaking Prevention）】证明

**断言**：当注入动态安全内缩 $\text{Inset}_{\text{safe}} = \text{calculateSafeAreaInset}(R_{\text{corner}}, \text{Margin}_{\text{track}})$ 后，无论外层容器圆角达到 8px、10px 乃至极端 14px，侧柱（含顶部三角、滑块与底部三角）在垂直方向上的全部几何区域均严格位于容器垂直平直段内，圆角截断失真度 $\equiv 0$。

**推导证明**：
1. 容器右上圆角的内缩曲面方程以圆心 $(W_{\text{root}} - R_{\text{corner}},\ R_{\text{corner}})$ 为准：
   $$(X - (W_{\text{root}} - R_{\text{corner}}))^2 + (Y - R_{\text{corner}})^2 \le R_{\text{corner}}^2 \quad (Y < R_{\text{corner}})$$
2. 侧柱位于 $X = W_{\text{root}} - \text{Margin}_{\text{track}}$ 处，距离圆心横向距离为 $x = \max(0, R_{\text{corner}} - \text{Margin}_{\text{track}})$；
3. 圆角在 $X$ 处沿 $Y$ 轴向内延伸的最大临界切点纵坐标为：
   $$Y_{\text{cut}} = R_{\text{corner}} - \sqrt{\max(0, R_{\text{corner}}^2 - x^2)}$$
4. 侧柱顶端的起始纵坐标为：
   $$\text{Inset}_{\text{top}} = \text{Margin}_{\text{track}} + \text{Inset}_{\text{safe}} = \text{Margin}_{\text{track}} + \lceil R_{\text{corner}} - \sqrt{\max(0, R_{\text{corner}}^2 - x^2)} \rceil + 1$$
5. 显然：
   $$\text{Inset}_{\text{top}} \ge Y_{\text{cut}} + 1 > Y_{\text{cut}}$$
6. 针对系统极端 14px 圆角（$R_{\text{corner}} = 14\text{px}, \text{Margin}_{\text{track}} = 2\text{px}$）严密验算：
   - $x = 14 - 2 = 12\text{px}$；
   - 纵向切点深度 $Y_{\text{cut}} = 14 - \sqrt{14^2 - 12^2} = 14 - \sqrt{52} \approx 14 - 7.21 = 6.79\text{px}$；
   - 算法计算安全内缩：$\text{Inset}_{\text{safe}} = \lceil 6.79 \rceil + 1 = 7 + 1 = 8\text{px}$；
   - 侧柱顶部起始位置：$\text{Inset}_{\text{top}} = 2 + 8 = 10\text{px}$；
   - 比较：$10\text{px} > 6.79\text{px}$，且高出安全裕量整整 $3.21\text{px}$！

**结论**：顶部三角按钮完全被动态 Inset 避让推移至容器垂直平滑平直段内，彻底杜绝圆角截断与破边撕裂。同理在底部圆角处对称成立。**证毕。**

---

### 4.5 【定理 4：滑块尺寸夹持与行程退化不变量】证明（真实 18px 物理下限夹持）

**断言**：在任何超长视口或极小视口下，滑块高度下限严格维持在 $H_{\text{thumb,min}} = 18\text{px}$ 物理像素，绝不存在百分比混淆导致的过大或过小畸变；在无溢出时滑块自然充满轨道并由视口状态隐藏。

**推导证明**：
1. 夹持函数采用真实物理像素：
   $$H_{\text{thumb}} = \text{clamp}\left(18\text{px},\ \frac{H_{\text{viewport}}}{H_{\text{content}}} \times H_{\text{track}},\ H_{\text{track}}\right)$$
2. 若 $H_{\text{content}} \le H_{\text{viewport}}$，比例因子 $\ge 1$，经上限夹持 $H_{\text{thumb}} = H_{\text{track}}$，位移行程 $D_{\text{travel}} = 0$；
3. 若 $H_{\text{content}} \to \infty$（如 100,000px 巨量文档），未夹持的理论高度趋于 0；
4. 经下限夹持，实测像素高度恒为：
   $$H_{\text{thumb}} = \max(18\text{px}, 0) = 18\text{px}$$
5. 历史旧代码错误将 18 当做百分比（`Math.max(18, ratio * 100)%`）：
   - 在 $H_{\text{track}} = 1000\text{px}$ 时，旧代码计算出 $180\text{px}$ 庞大滑块（严重阻断视野）；
   - 在 $H_{\text{track}} = 50\text{px}$ 时，旧代码计算出 $9\text{px}$ 微缩残片（严重丧失点击命中区）；
   - 本方案纠正为真实像素级夹持后，在任何尺寸轨道下均刚性守住 $18\text{px}$ 可拖拽人机工程基准。**证毕。**

---

### 4.6 【定理 5：水平方向横轴双向对称性不变性】证明

将上述模型中高度 $H$ 替换为宽度 $W$，纵坐标 $Y$ 替换为横坐标 $X$，上下端点按钮替换为左右端点按钮，所有盒模型边界不等式、代数极值定理与 Inset 避让公式在水平轴上同构成立。**证毕。**

---

### 4.7 【定理 6：算术下溢退化紧凑态防御定理】证明

**断言**：当容器高度被极端压缩至 $\text{AvailableTrackSpace} < 16\text{px}$ 时，组件进入退化紧凑态，轨道高度 $H_{\text{track}} \ge 0$ 且绝对不出现负数尺寸或按钮重叠。

**推导证明**：
1. 设未退化时的轨道空间为：
   $$A = H_{\text{root}} - (\text{Inset}_{\text{top}} + \text{Inset}_{\text{bottom}}) - 2(H_{\text{btn}} + G_{\text{safe}})$$
2. 若 $A < 16\text{px}$，触发退化紧凑态判定，按钮渲染开关 $\text{shouldRenderButtons} \equiv \text{false}$；
3. 此时侧柱内不再渲染上下按钮与 $2 \times G_{\text{safe}}$ 间隔，轨道实际可用高度重置为：
   $$H_{\text{track}} = \max(0,\ H_{\text{root}} - (\text{Inset}_{\text{top}} + \text{Inset}_{\text{bottom}}))$$
4. 由于 $H_{\text{btn}} > 0$ 且 $G_{\text{safe}} = 2\text{px} > 0$，必有：
   $$H_{\text{track}} \ge A + 2(H_{\text{btn}} + G_{\text{safe}}) > 16\text{px} + 2(4 + 2) = 28\text{px} > 0$$
5. 即使在极端容器高度 $H_{\text{root}} < 16\text{px}$ 时，外层外包围高度判定强制拦截，滑块尺寸由 $\min(H_{\text{track}}, 18\text{px})$ 兜底，绝无负数或 NaN 异常。**证毕。**

---

## 五、20Hz 脉冲微调步进引擎与动力学控制

### 5.1 40px 黄金步长与视口自适应弹性算法

在常规文本与菜单交互中，写死步长会导致不同尺寸容器体验断层。为此设计**黄金双模步进算法**：

```typescript
function resolveStepDelta(
  stepSizeProp: number | 'auto' | undefined,
  viewportDimension: number
): number {
  if (typeof stepSizeProp === 'number' && stepSizeProp > 0) {
    return stepSizeProp;
  }
  // 默认黄金基准：40px 单步步长（适配典型 20px 行高 × 2 行阅读跨度）
  // 当视口高度特别小时（如 150px 紧凑下拉），自适应为视口 18%，下限 32px，上限 96px
  const dynamic = Math.round(viewportDimension * 0.18);
  return Math.max(32, Math.min(dynamic > 0 ? dynamic : 40, 96));
}
```

### 5.2 极值边界微像素吸附机制（Edge Snapping）

由于高 DPI 缩放（125% / 150%）与 Subpixel 浮点渲染，滚动步进接近两极时，经常残留 $< 4\text{px}$ 的微小缝隙，导致端点按钮无法切换至禁用态。吸附机制保证：
```typescript
function snapScrollDelta(
  current: number,
  delta: number,
  maxScroll: number,
  threshold: number = 4
): number {
  const target = current + delta;
  if (target <= threshold) return 0;
  if (target >= maxScroll - threshold) return maxScroll;
  return Math.max(0, Math.min(target, maxScroll));
}
```

### 5.3 20Hz 脉冲微调节拍模型（250ms 延迟 + 50ms 连发）

用户对端点按钮的交互包含两种意图：**单次精确微调** 与 **长按快速推进**。

```
时间轴 (t) ───►
[Pointer Down] ──► [单发脉冲 1] (立即位移 40px, behavior: smooth)
       │
       ▼ 等待 250ms 初延迟防抖 (Initial Debounce Window)
  若用户松手 (t < 250ms) ──► 终止循环 (判定为单击，零多余位移)
       │
       ▼ 用户持续按压 (t >= 250ms)
[20Hz 高频动力学连发] ──► 启动 50ms 周期脉冲循环 (Pulse Interval = 50ms = 20Hz)
       │
       ├──► 脉冲 2 (t = 300ms, 位移 40px, behavior: auto 瞬态，杜绝动画排队)
       ├──► 脉冲 3 (t = 350ms, 位移 40px, behavior: auto)
       ├──► 脉冲 4 (t = 400ms, 位移 40px, behavior: auto)
       └──► ... (直至触发刚性刹车)
```

- **初延迟 250ms**：符合人机工程学标准防抖时间，确保单次敲击绝不误触连击；
- **50ms 连发周期（20Hz 脉冲）**：$f = \frac{1}{0.05\text{s}} = 20\text{Hz}$，每秒推进 20 个步长（约 800px/s），手感疾驰且平稳；
- **连发瞬时位移（`behavior: 'auto'`）**：连发阶段严格禁用 `'smooth'` 动画，防止在 20Hz 频度下由于 CSS 动画队列积压导致松手后页面严重迟滞滑行。

### 5.4 刚性制动机制（Rigid Auto-Brake）与全生命周期守卫（含横向边界制动）

为彻底消除“定时器脱僵、窗口失焦狂滚”的灾难，设计**全链路刚性制动机制**（已闭环 FIX-B-05 水平边界检查）：

1. **多事件防御制动**：
   - 监听 `pointerup`（正常松手）；
   - 监听 `pointerleave`（光标滑出按钮区域）；
   - 监听 `pointercancel`（系统手势拦截或触屏异常）；
   - 监听 `blur`（按钮丢失焦点）；
   - 监听 `window.onblur`（用户 Alt-Tab 切出应用）。
2. **端点碰撞强制刹车（FIX-B-05 闭环）**：
   - 垂直方向：`direction === 'up' && el.scrollTop <= 0` 或 `direction === 'down' && el.scrollTop >= maxY`；
   - 水平方向：`direction === 'left' && el.scrollLeft <= 0` 或 `direction === 'right' && el.scrollLeft >= maxX`；
   - 一旦触达极值边界，动力学循环**立即调用 `rigidBrake()` 自毁退出**，并将当前按钮标记为禁用态；
3. **组件卸载自清**：
   - 在 React `useEffect` 清理函数中无条件释放 `clearTimeout` 与 `clearInterval`。

### 5.5 无障碍降级守卫（Reduced Motion Guard & A11y）

- **减弱动画守卫**：检测 `window.matchMedia('(prefers-reduced-motion: reduce)').matches`，当用户系统开启无障碍减弱动画时，所有滚动（包括初次点击）一律降级为 `'auto'` 瞬时滚动；
- **键盘焦点隔离**：端点按钮属性强制声明 `tabIndex={-1}`，避免用户使用 Tab 键在表单或菜单中漫游时焦点被卷入滚动步进按钮；
- **ARIA 规范**：视口外层声明 `role="region"` 与 `aria-label={ariaLabel}`，步进侧柱声明 `aria-hidden="true"`（屏幕阅读器通过视口键盘原生箭头滚动，无需额外读取步进装饰按钮）。

---

## 六、组件 API 契约与 TypeScript 类型规范

### 6.1 类型定义契约（`ScrollArea.types.ts`）

```typescript
import React from 'react';

/** 四级宽度 Token 契约类型 */
export type ScrollAreaSize = 'xs' | 'sm' | 'md' | 'lg';

/** 滚动方向契约 */
export type ScrollAreaOrientation = 'vertical' | 'horizontal' | 'both';

/** 滚动条防抖与占位策略 */
export type ScrollAreaGutter = 'auto' | 'stable';

/** 滚动条显隐机制 */
export type ScrollAreaType = 'auto' | 'always' | 'hover' | 'scroll';

/** 视口实时几何指标快照 */
export interface ScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  isAtTop: boolean;
  isAtBottom: boolean;
  isAtLeft: boolean;
  isAtRight: boolean;
  progressY: number; // 0.0 ~ 1.0
  progressX: number; // 0.0 ~ 1.0
}
```

### 6.2 命令式控制器 Handle 契约（`ScrollAreaHandle`）

```typescript
export interface ScrollAreaHandle {
  /** 滚动至最顶部 */
  scrollToTop: (behavior?: ScrollBehavior) => void;
  /** 滚动至最底部 */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** 通用坐标滚动 */
  scrollTo: (options: ScrollToOptions) => void;
  /** 相对偏移滚动 */
  scrollBy: (options: ScrollToOptions) => void;
  /** 触发与步进按钮完全同构的单步微调 */
  scrollStep: (direction: 'up' | 'down' | 'left' | 'right', behavior?: ScrollBehavior) => void;
  /** 获取内部承载滚动的原生 Viewport 元素引用 */
  getViewport: () => HTMLDivElement | null;
  /** 获取当前瞬时几何指标快照 */
  getMetrics: () => ScrollMetrics;
}
```

### 6.3 属性 Props 契约（`ScrollAreaProps`，解除 xs 霸王条款并注入 Inset）

```typescript
export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 尺寸分级（严格从 Token 体系选取，严禁裸写 px）
   * - 'xs': 4px 极细（默认无按钮，允许显式开启）
   * - 'sm': 5px 紧凑
   * - 'md': 7px 标准默认基准
   * - 'lg': 9px 宽屏大视口
   * @default 'md'
   */
  size?: ScrollAreaSize;

  /**
   * 是否在轨道两端渲染端点安全护栏（带微圆角等腰三角箭头）
   * 规则：showButtons ?? (size !== 'xs') (M04 闭环)
   * - 未显式指定时：xs 默认关闭按钮，sm/md/lg 默认开启按钮；
   * - 显式指定 boolean 时：严格遵循传入值，允许 size='xs' 显式开启 4px 按钮。
   * @default size !== 'xs'
   */
  showButtons?: boolean;

  /**
   * 容器外层圆角半径 (px)，用于驱动 calculateSafeAreaInset 动态避让 (M02 闭环)
   * 彻底消除 8px/12px/14px 弹窗圆角截断顶部与底部安全箭头
   * @default 0
   */
  radius?: number;

  /**
   * 滚动条侧柱距离容器外边缘间距 (px)
   * @default 2
   */
  trackMargin?: number;

  /**
   * 滚动方向契约
   * @default 'vertical'
   */
  orientation?: ScrollAreaOrientation;

  /**
   * 滚动条占位避免布局位移策略
   * @default 'auto'
   */
  scrollbarGutter?: ScrollAreaGutter;

  /**
   * 滚动条显隐机制
   * - 'hover': 悬浮时显现，静止时隐匿（默认推荐）
   * - 'always': 始终常驻显示
   * - 'scroll': 滚动中显现，静止 150ms 后渐隐
   * - 'auto': 依据内容是否溢出自动决定
   * @default 'hover'
   */
  type?: ScrollAreaType;

  /**
   * 单步步进距离
   * - number: 固定像素
   * - 'auto': 黄金视口比例自适应算法（默认 40px，在极小视口自适应）
   * @default 'auto'
   */
  stepSize?: number | 'auto';

  /**
   * 多态根容器 HTML 标签
   * @default 'div'
   */
  as?: React.ElementType;

  /** 视口容器类名与样式覆盖 */
  viewportClassName?: string;
  viewportStyle?: React.CSSProperties;

  /** 内容包裹层类名与样式覆盖 */
  contentClassName?: string;
  contentStyle?: React.CSSProperties;

  /** 原生 Viewport DOM Ref 转发引用 */
  viewportRef?: React.Ref<HTMLDivElement>;

  /** 滚动监听回调 */
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;

  /** 滚动停止（静止）防抖 150ms 触发回调 */
  onScrollIdle?: () => void;

  /** 可访问性无障碍区域标签描述 */
  ariaLabel?: string;

  /** 子节点 */
  children?: React.ReactNode;
}
```

---

## 七、完整生产级代码落盘规范

组件完全遵循 `apps/crish-desktop/src/components/ui/` 纯原子层设计规范，共计 4 个文件落盘。

### 7.1 `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.types.ts`

```typescript
import React from 'react';

export type ScrollAreaSize = 'xs' | 'sm' | 'md' | 'lg';
export type ScrollAreaOrientation = 'vertical' | 'horizontal' | 'both';
export type ScrollAreaGutter = 'auto' | 'stable';
export type ScrollAreaType = 'auto' | 'always' | 'hover' | 'scroll';

export interface ScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  isAtTop: boolean;
  isAtBottom: boolean;
  isAtLeft: boolean;
  isAtRight: boolean;
  progressY: number;
  progressX: number;
}

export interface ScrollAreaHandle {
  scrollToTop: (behavior?: ScrollBehavior) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollTo: (options: ScrollToOptions) => void;
  scrollBy: (options: ScrollToOptions) => void;
  scrollStep: (direction: 'up' | 'down' | 'left' | 'right', behavior?: ScrollBehavior) => void;
  getViewport: () => HTMLDivElement | null;
  getMetrics: () => ScrollMetrics;
}

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: ScrollAreaSize;
  showButtons?: boolean;
  radius?: number;
  trackMargin?: number;
  orientation?: ScrollAreaOrientation;
  scrollbarGutter?: ScrollAreaGutter;
  type?: ScrollAreaType;
  stepSize?: number | 'auto';
  as?: React.ElementType;
  viewportClassName?: string;
  viewportStyle?: React.CSSProperties;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  viewportRef?: React.Ref<HTMLDivElement>;
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
  onScrollIdle?: () => void;
  ariaLabel?: string;
  children?: React.ReactNode;
}
```

---

### 7.2 `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.tsx`

```tsx
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react';
import {
  ScrollAreaProps,
  ScrollAreaHandle,
  ScrollMetrics,
  ScrollAreaSize,
} from './ScrollArea.types';
import styles from './ScrollArea.module.css';

/**
 * 极端圆角断头台切角防护算法 (M02 落地)
 * 精确计算防切角的最小纵向/横向 Inset 安全避让距离
 * @param radius 容器外层圆角半径 (px)
 * @param margin 滚动条离容器外边缘间距 (px)，默认 2px
 */
export function calculateSafeAreaInset(
  radius: number = 0,
  margin: number = 2
): number {
  if (radius <= 0) return 0;
  const x = Math.max(0, radius - margin);
  const arcY = Math.sqrt(Math.max(0, radius * radius - x * x));
  const minInset = radius - arcY;
  // 为避免亚像素光栅化切边与高 DPI 渲染抖动，增加 1px 的安全缓冲
  return Math.ceil(minInset) + 1;
}

/**
 * 获取对应尺寸的步进按钮物理边长 (px)
 */
function getButtonDimension(size: ScrollAreaSize): number {
  switch (size) {
    case 'xs': return 4;
    case 'sm': return 5;
    case 'md': return 7;
    case 'lg': return 9;
    default: return 7;
  }
}

/**
 * 步长解析：默认 40px，极小视口自适应
 */
function resolveStepDelta(
  stepSizeProp: number | 'auto' | undefined,
  dimension: number
): number {
  if (typeof stepSizeProp === 'number' && stepSizeProp > 0) {
    return stepSizeProp;
  }
  const dynamic = Math.round(dimension * 0.18);
  return Math.max(32, Math.min(dynamic > 0 ? dynamic : 40, 96));
}

/**
 * 极值边界微像素吸附
 */
function snapScrollDelta(
  current: number,
  delta: number,
  maxScroll: number,
  threshold: number = 4
): number {
  const target = current + delta;
  if (target <= threshold) return 0;
  if (target >= maxScroll - threshold) return maxScroll;
  return Math.max(0, Math.min(target, maxScroll));
}

export const ScrollArea = forwardRef<ScrollAreaHandle, ScrollAreaProps>(
  (
    {
      size = 'md',
      showButtons,
      radius = 0,
      trackMargin = 2,
      orientation = 'vertical',
      scrollbarGutter = 'auto',
      type = 'hover',
      stepSize = 'auto',
      as: Component = 'div',
      className,
      style,
      viewportClassName,
      viewportStyle,
      contentClassName,
      contentStyle,
      viewportRef: externalViewportRef,
      onScroll,
      onScrollIdle,
      ariaLabel = 'Scrollable viewport',
      children,
      ...restProps
    },
    ref
  ) => {
    const internalViewportRef = useRef<HTMLDivElement | null>(null);
    const idleTimerRef = useRef<number | null>(null);
    const pulseDelayTimerRef = useRef<number | null>(null);
    const pulseIntervalRef = useRef<number | null>(null);

    // 几何状态
    const [metrics, setMetrics] = useState<ScrollMetrics>({
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 0,
      scrollWidth: 0,
      clientHeight: 0,
      clientWidth: 0,
      isAtTop: true,
      isAtBottom: true,
      isAtLeft: true,
      isAtRight: true,
      progressY: 0,
      progressX: 0,
    });

    const [isHovered, setIsHovered] = useState(false);
    const [isScrolling, setIsScrolling] = useState(false);
    const [isDragging, setIsDragging] = useState(false);

    // 拖拽状态 Ref
    const dragStateRef = useRef<{
      isDragging: boolean;
      startY: number;
      startScrollTop: number;
      maxTravel: number;
      maxScroll: number;
    }>({
      isDragging: false,
      startY: 0,
      startScrollTop: 0,
      maxTravel: 0,
      maxScroll: 0,
    });

    // 按钮开关判定：解除 xs 霸王条款，改为 showButtons ?? (size !== 'xs') (M04 落地)
    const effectiveShowButtons = showButtons ?? (size !== 'xs');

    // 极端圆角断头台切角避让计算 (M02 落地)
    const safeInset = calculateSafeAreaInset(radius, trackMargin);
    const insetTop = safeInset + trackMargin;
    const insetBottom = safeInset + trackMargin;

    // 按钮尺寸与可用轨道计算
    const btnDimension = getButtonDimension(size);
    const safeGap = 2; // px 物理真空隔离带高度
    const calculatedAvailableTrack =
      metrics.clientHeight - (insetTop + insetBottom) - 2 * btnDimension - 2 * safeGap;

    // 退化紧凑态判定：当可用空间不足以容纳最小滑块 (< 16px) 时，自动退化隐藏按钮恢复全行程滑块 (M03 落地)
    const isDegradedCompact =
      effectiveShowButtons && (metrics.clientHeight < 16 || calculatedAvailableTrack < 16);
    const shouldRenderButtons = effectiveShowButtons && !isDegradedCompact;

    // 实际独立轨道物理高度
    const actualTrackHeight = shouldRenderButtons
      ? Math.max(0, calculatedAvailableTrack)
      : Math.max(0, metrics.clientHeight - (insetTop + insetBottom));

    // Ref 双向绑定
    const setViewportRefs = useCallback(
      (node: HTMLDivElement | null) => {
        internalViewportRef.current = node;
        if (typeof externalViewportRef === 'function') {
          externalViewportRef(node);
        } else if (externalViewportRef && 'current' in externalViewportRef) {
          (externalViewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [externalViewportRef]
    );

    // 更新指标
    const updateMetrics = useCallback(() => {
      const el = internalViewportRef.current;
      if (!el) return;

      const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = el;
      const maxY = Math.max(0, scrollHeight - clientHeight);
      const maxX = Math.max(0, scrollWidth - clientWidth);

      const isAtTop = scrollTop <= 1;
      const isAtBottom = maxY <= 0 || scrollTop >= maxY - 1;
      const isAtLeft = scrollLeft <= 1;
      const isAtRight = maxX <= 0 || scrollLeft >= maxX - 1;

      const progressY = maxY > 0 ? Math.min(1, Math.max(0, scrollTop / maxY)) : 0;
      const progressX = maxX > 0 ? Math.min(1, Math.max(0, scrollLeft / maxX)) : 0;

      setMetrics({
        scrollTop,
        scrollLeft,
        scrollHeight,
        scrollWidth,
        clientHeight,
        clientWidth,
        isAtTop,
        isAtBottom,
        isAtLeft,
        isAtRight,
        progressY,
        progressX,
      });
    }, []);

    // 监听 ResizeObserver
    useEffect(() => {
      const el = internalViewportRef.current;
      if (!el) return;

      updateMetrics();
      const observer = new ResizeObserver(() => {
        updateMetrics();
      });

      observer.observe(el);
      if (el.firstElementChild) {
        observer.observe(el.firstElementChild);
      }

      return () => {
        observer.disconnect();
      };
    }, [updateMetrics]);

    // 刚性制动清除定时器
    const rigidBrake = useCallback(() => {
      if (pulseDelayTimerRef.current !== null) {
        window.clearTimeout(pulseDelayTimerRef.current);
        pulseDelayTimerRef.current = null;
      }
      if (pulseIntervalRef.current !== null) {
        window.clearInterval(pulseIntervalRef.current);
        pulseIntervalRef.current = null;
      }
    }, []);

    useEffect(() => {
      const handleWindowBlur = () => rigidBrake();
      window.addEventListener('blur', handleWindowBlur);
      return () => {
        window.removeEventListener('blur', handleWindowBlur);
        rigidBrake();
        if (idleTimerRef.current !== null) {
          window.clearTimeout(idleTimerRef.current);
        }
      };
    }, [rigidBrake]);

    // 执行单步位移
    const executeStep = useCallback(
      (direction: 'up' | 'down' | 'left' | 'right', behavior: ScrollBehavior = 'smooth') => {
        const el = internalViewportRef.current;
        if (!el) return;

        const isReduced =
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const finalBehavior = isReduced ? 'auto' : behavior;

        const maxY = Math.max(0, el.scrollHeight - el.clientHeight);
        const maxX = Math.max(0, el.scrollWidth - el.clientWidth);

        if (direction === 'up' || direction === 'down') {
          const deltaSize = resolveStepDelta(stepSize, el.clientHeight);
          const delta = direction === 'up' ? -deltaSize : deltaSize;
          const nextY = snapScrollDelta(el.scrollTop, delta, maxY);
          el.scrollTo({ top: nextY, behavior: finalBehavior });
        } else {
          const deltaSize = resolveStepDelta(stepSize, el.clientWidth);
          const delta = direction === 'left' ? -deltaSize : deltaSize;
          const nextX = snapScrollDelta(el.scrollLeft, delta, maxX);
          el.scrollTo({ left: nextX, behavior: finalBehavior });
        }
      },
      [stepSize]
    );

    // 20Hz 动力学按键按下处理（包含水平边界自动制动，FIX-B-05 落地）
    const handleButtonPointerDown = useCallback(
      (direction: 'up' | 'down' | 'left' | 'right') => (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        rigidBrake();

        // 立即单发微调 40px
        executeStep(direction, 'smooth');

        // 250ms 初延迟防抖
        pulseDelayTimerRef.current = window.setTimeout(() => {
          // 20Hz 脉冲微调循环 (50ms 间隔)
          pulseIntervalRef.current = window.setInterval(() => {
            const el = internalViewportRef.current;
            if (!el) {
              rigidBrake();
              return;
            }
            // 垂直与水平极限位置刚性刹车 (FIX-B-05)
            if (direction === 'up' && el.scrollTop <= 0) {
              rigidBrake();
              return;
            }
            if (direction === 'down' && el.scrollTop >= el.scrollHeight - el.clientHeight) {
              rigidBrake();
              return;
            }
            if (direction === 'left' && el.scrollLeft <= 0) {
              rigidBrake();
              return;
            }
            if (direction === 'right' && el.scrollLeft >= el.scrollWidth - el.clientWidth) {
              rigidBrake();
              return;
            }
            // 连发阶段采用 'auto' 避免队列积压
            executeStep(direction, 'auto');
          }, 50);
        }, 250);
      },
      [executeStep, rigidBrake]
    );

    // 滚动主监听
    const handleScroll = useCallback(
      (e: React.UIEvent<HTMLDivElement>) => {
        updateMetrics();
        setIsScrolling(true);

        if (idleTimerRef.current !== null) {
          window.clearTimeout(idleTimerRef.current);
        }

        idleTimerRef.current = window.setTimeout(() => {
          setIsScrolling(false);
          onScrollIdle?.();
        }, 150);

        onScroll?.(e);
      },
      [updateMetrics, onScroll, onScrollIdle]
    );

    // 滑块尺寸与位移计算：18px 物理像素级夹持 (FIX-B-02 落地，彻底杜绝 18% 百分比混淆)
    const minThumbSize = 18; // px 物理最小像素
    const rawThumbHeight =
      metrics.scrollHeight > 0 && actualTrackHeight > 0
        ? (metrics.clientHeight / metrics.scrollHeight) * actualTrackHeight
        : 0;
    const thumbHeightPx =
      actualTrackHeight > 0
        ? Math.min(actualTrackHeight, Math.max(minThumbSize, rawThumbHeight))
        : 0;

    // 滑块行程上限与绝对位移 (FIX-B-01 落地：基于轨道绝对定位，绝不用自身高度 translateY 百分比)
    const maxTravelPx = Math.max(0, actualTrackHeight - thumbHeightPx);
    const thumbTopPx = metrics.progressY * maxTravelPx;

    // 滑块 Pointer Capture 拖拽启动
    const handleThumbPointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const el = internalViewportRef.current;
        if (!el) return;

        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        if (maxScroll <= 0 || maxTravelPx <= 0) return;

        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        dragStateRef.current = {
          isDragging: true,
          startY: e.clientY,
          startScrollTop: el.scrollTop,
          maxTravel: maxTravelPx,
          maxScroll,
        };
        setIsDragging(true);
      },
      [maxTravelPx]
    );

    // 滑块 Pointer Capture 拖拽中动态映射 (deltaY -> viewport.scrollTop)
    const handleThumbPointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStateRef.current.isDragging) return;
        e.preventDefault();

        const { startY, startScrollTop, maxTravel, maxScroll } = dragStateRef.current;
        const deltaY = e.clientY - startY;

        if (maxTravel > 0) {
          const scrollDelta = (deltaY / maxTravel) * maxScroll;
          const targetScrollTop = Math.max(0, Math.min(startScrollTop + scrollDelta, maxScroll));
          if (internalViewportRef.current) {
            internalViewportRef.current.scrollTop = targetScrollTop;
          }
        }
      },
      []
    );

    // 滑块 Pointer Capture 拖拽结束释放
    const handleThumbPointerUp = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStateRef.current.isDragging) return;
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          // 忽略捕获已被释放的边缘异常
        }
        dragStateRef.current.isDragging = false;
        setIsDragging(false);
      },
      []
    );

    // 暴露 Handle API
    useImperativeHandle(
      ref,
      () => ({
        scrollToTop: (behavior = 'smooth') => {
          internalViewportRef.current?.scrollTo({ top: 0, behavior });
        },
        scrollToBottom: (behavior = 'smooth') => {
          const el = internalViewportRef.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior });
        },
        scrollTo: (options) => {
          internalViewportRef.current?.scrollTo(options);
        },
        scrollBy: (options) => {
          internalViewportRef.current?.scrollBy(options);
        },
        scrollStep: (direction, behavior = 'smooth') => {
          executeStep(direction, behavior);
        },
        getViewport: () => internalViewportRef.current,
        getMetrics: () => metrics,
      }),
      [executeStep, metrics]
    );

    const hasVerticalOverflow = metrics.scrollHeight > metrics.clientHeight;
    const isBarVisible =
      type === 'always' ||
      (type === 'auto' && hasVerticalOverflow) ||
      (type === 'hover' && isHovered && hasVerticalOverflow) ||
      (type === 'scroll' && isScrolling && hasVerticalOverflow) ||
      isDragging;

    return (
      <Component
        className={`${styles.root} ${styles[size]} ${className || ''}`}
        style={style}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          rigidBrake();
        }}
        {...restProps}
      >
        <div
          ref={setViewportRefs}
          className={`${styles.viewport} ${viewportClassName || ''}`}
          style={{
            ...viewportStyle,
            scrollbarGutter: scrollbarGutter === 'stable' ? 'stable' : undefined,
          }}
          onScroll={handleScroll}
          tabIndex={0}
          role="region"
          aria-label={ariaLabel}
        >
          <div className={`${styles.content} ${contentClassName || ''}`} style={contentStyle}>
            {children}
          </div>
        </div>

        {/* 垂直三段式物理隔离轨道与端点安全护栏 */}
        {(orientation === 'vertical' || orientation === 'both') && (
          <div
            className={`${styles.stepperTrackColumn} ${isBarVisible ? styles.visible : ''}`}
            style={{
              top: `${insetTop}px`,
              bottom: `${insetBottom}px`,
              right: `${trackMargin}px`,
            }}
            aria-hidden="true"
          >
            {/* 上端点安全护栏按钮 (非退化紧凑态且开启按钮时渲染) */}
            {shouldRenderButtons && (
              <>
                <button
                  type="button"
                  tabIndex={-1}
                  className={`${styles.stepperButton} ${styles.upButton} ${
                    metrics.isAtTop ? styles.disabled : ''
                  }`}
                  onPointerDown={handleButtonPointerDown('up')}
                  onPointerUp={rigidBrake}
                  onPointerLeave={rigidBrake}
                  onPointerCancel={rigidBrake}
                  aria-label="Scroll Up"
                >
                  <svg viewBox="0 0 10 10" className={styles.arrowIcon}>
                    <path
                      d="M5 2.5 L8.2 7 H1.8 Z"
                      strokeLinejoin="round"
                      strokeWidth="0.8"
                      stroke="currentColor"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                {/* 上物理真空隔离带 (2px) */}
                <div className={styles.safeGap} />
              </>
            )}

            {/* 独立滑行游弋轨道 */}
            <div className={styles.isolatedTrack}>
              <div
                className={`${styles.thumbIndicator} ${isDragging ? styles.dragging : ''}`}
                style={{
                  height: `${thumbHeightPx}px`,
                  top: `${thumbTopPx}px`,
                }}
                onPointerDown={handleThumbPointerDown}
                onPointerMove={handleThumbPointerMove}
                onPointerUp={handleThumbPointerUp}
                onPointerCancel={handleThumbPointerUp}
              />
            </div>

            {/* 下端点安全护栏按钮 (非退化紧凑态且开启按钮时渲染) */}
            {shouldRenderButtons && (
              <>
                {/* 下物理真空隔离带 (2px) */}
                <div className={styles.safeGap} />
                <button
                  type="button"
                  tabIndex={-1}
                  className={`${styles.stepperButton} ${styles.downButton} ${
                    metrics.isAtBottom ? styles.disabled : ''
                  }`}
                  onPointerDown={handleButtonPointerDown('down')}
                  onPointerUp={rigidBrake}
                  onPointerLeave={rigidBrake}
                  onPointerCancel={rigidBrake}
                  aria-label="Scroll Down"
                >
                  <svg viewBox="0 0 10 10" className={styles.arrowIcon}>
                    <path
                      d="M1.8 3 L8.2 3 L5 7.5 Z"
                      strokeLinejoin="round"
                      strokeWidth="0.8"
                      stroke="currentColor"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </>
            )}
          </div>
        )}
      </Component>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';
```

---

### 7.3 `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css`

```css
/* ==========================================================================
   ScrollArea Atomic Component CSS Module
   严格遵循 tokens.css 契约，严禁全仓裸写硬编码像素！
   二元灰度绝对死锁：未激活 8.2% vs 激活 20.2%，差值严格 12%，Hover、Active 与 Dragging 统统同色！
   Token 命名统一：--scrollbar-thumb-active 绝无 -bg，按钮变量统一为 --scrollbar-button-*
   ========================================================================== */

.root {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

/* 尺寸分级变量注入：严格消费 Token 变量，绝无裸写像素 */
.xs {
  --scrollbar-width: var(--scrollbar-width-xs, 4px);
  --scrollbar-button-size: var(--scrollbar-button-size-xs, 4px);
}

.sm {
  --scrollbar-width: var(--scrollbar-width-sm, 5px);
  --scrollbar-button-size: var(--scrollbar-button-size-sm, 5px);
}

.md {
  --scrollbar-width: var(--scrollbar-width-md, 7px);
  --scrollbar-button-size: var(--scrollbar-button-size-md, 7px);
}

.lg {
  --scrollbar-width: var(--scrollbar-width-lg, 9px);
  --scrollbar-button-size: var(--scrollbar-button-size-lg, 9px);
}

/* 视口主容器：原生滚动支撑，内部屏蔽系统条以防双条重叠 */
.viewport {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  box-sizing: border-box;
  outline: none;
  scrollbar-width: none;
}

.viewport::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.content {
  min-width: 100%;
  box-sizing: border-box;
}

/* 三段式垂直侧柱：绝对定位悬浮于容器内侧右端 */
.stepperTrackColumn {
  position: absolute;
  width: var(--scrollbar-width);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: auto;
  opacity: 0;
  transition: opacity 160ms cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 2;
  user-select: none;
}

.stepperTrackColumn.visible {
  opacity: 1;
}

/* 端点安全护栏步进按钮 */
.stepperButton {
  width: var(--scrollbar-width);
  height: var(--scrollbar-width);
  min-height: var(--scrollbar-width);
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  color: var(--scrollbar-button-color, var(--text-tertiary));
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--scrollbar-button-radius, var(--radius-xs, 2px));
  cursor: pointer;
  outline: none;
  transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}

/* 铁律：Hover 与 Active 消费同一变量，严禁第三态分叉 */
.stepperButton:hover:not(.disabled) {
  color: var(--scrollbar-button-hover-color, var(--text-primary));
  background: var(--scrollbar-button-hover-bg, color-mix(in srgb, var(--text-primary) 8%, transparent));
}

.stepperButton:active:not(.disabled) {
  color: var(--scrollbar-button-hover-color, var(--text-primary));
  background: var(--scrollbar-button-active-bg, color-mix(in srgb, var(--text-primary) 8%, transparent));
}

.stepperButton.disabled {
  opacity: 0.2;
  cursor: default;
  pointer-events: none;
}

.arrowIcon {
  width: 100%;
  height: 100%;
  display: block;
}

/* 物理真空隔离带：固定 2px 净空缓冲 */
.safeGap {
  width: 100%;
  height: var(--scrollbar-track-safe-gap, 2px);
  flex-shrink: 0;
}

/* 独立滑行游弋轨道 */
.isolatedTrack {
  position: relative;
  flex: 1;
  width: 100%;
  background: var(--scrollbar-track-bg, transparent);
  overflow: hidden;
}

/* 轨道内滑块：二元灰度绝对死锁 (未激活 8.2% vs 激活 20.2%)，修复绝对定位 top 基准与拖拽手柄 */
.thumbIndicator {
  position: absolute;
  left: 0;
  width: 100%;
  border-radius: var(--scrollbar-thumb-radius, var(--radius-full, 9999px));
  background: var(--scrollbar-thumb-bg);
  transition: background 120ms ease;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

/* 铁律：滑块 Hover、Active 与 Dragging 拖拽统统同色（--scrollbar-thumb-active），严禁第三态！ */
.thumbIndicator:hover,
.thumbIndicator:active,
.thumbIndicator.dragging {
  background: var(--scrollbar-thumb-active);
}

.thumbIndicator.dragging {
  cursor: grabbing;
}
```

---

### 7.4 `apps/crish-desktop/src/components/ui/ScrollArea/index.ts`

```typescript
export { ScrollArea, calculateSafeAreaInset } from './ScrollArea';
export type {
  ScrollAreaProps,
  ScrollAreaHandle,
  ScrollAreaSize,
  ScrollAreaOrientation,
  ScrollAreaGutter,
  ScrollAreaType,
  ScrollMetrics,
} from './ScrollArea.types';
```

---

### 7.5 `apps/crish-desktop/src/components/ui/index.ts` Barrel 出口集成

在 `apps/crish-desktop/src/components/ui/index.ts` 末尾增加单真源导出：

```typescript
export { ScrollArea, calculateSafeAreaInset } from './ScrollArea';
export type {
  ScrollAreaProps,
  ScrollAreaHandle,
  ScrollAreaSize,
  ScrollAreaOrientation,
  ScrollAreaGutter,
  ScrollAreaType,
  ScrollMetrics,
} from './ScrollArea';
```

---

## 八、Vitest 单元测试规格（`ScrollArea.test.tsx`）

严格遵循 `AGENTS.md` 测试资产保护铁律与 §7.1 立体验证纪律，新建测试规格文件：`apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.test.tsx`。

### 8.1 测试用例规划矩阵（TC-SA-01 至 TC-SA-10）

| 测试 ID | 测试目标 | 验证维度与断言依据 |
| :--- | :--- | :--- |
| `TC-SA-01` | **多态与无侵入渲染** | 传入 `as="section"`，断言 DOM 标签为 `<section>`，ARIA `role="region"` 存在且子节点无损投射 |
| `TC-SA-02` | **Token 尺寸类名映射** | 分别传入 `size="xs" \| "sm" \| "md" \| "lg"`，断言对应 CSS module 类正确挂载 |
| `TC-SA-03` | **xs 尺寸解禁与 showButtons 规则 (M04)** | `size="xs"` 默认无按钮；显式传入 `showButtons={true}` 时渲染 4px 微型三角 |
| `TC-SA-04` | **端点极限禁用态不变量** | 内容高度大于视口时，顶极限（`scrollTop=0`）Up 按钮 disabled；底极限 Down 按钮 disabled |
| `TC-SA-05` | **单击 40px 步进与吸附** | 点击 Down 按钮，触发 `scrollTo` 且参数包含 40px，接近底部时触发微像素吸附至 `maxScroll` |
| `TC-SA-06` | **20Hz 脉冲连发与制动** | 长按 200ms 不触发连发（仅 1 发）；长按 350ms 触发高频脉冲（50ms 周期）；`pointerUp` 瞬间刚性刹车 |
| `TC-SA-07` | **命令式 Handle API 契约** | 通过 `ref` 调用 `scrollToTop()`, `scrollToBottom()`, `scrollStep()`, `getMetrics()`，断言调用参数与状态 |
| `TC-SA-08` | **无障碍与焦点隔离** | 端点按钮 `tabIndex` 为 `-1`，系统开启 `prefers-reduced-motion: reduce` 时滚动行为强制降级为 `'auto'` |
| `TC-SA-09` | **滑块拖拽交互引擎 (FIX-B-01 & 拖拽)** | 滑块 `onPointerDown` 触发 `setPointerCapture`，移动光标产生映射至 `scrollTop`，松手触发 `releasePointerCapture` |
| `TC-SA-10` | **极端圆角避让与退化紧凑态 (M02 & M03)** | 验证 `calculateSafeAreaInset(14, 2) === 8` 并断言侧柱避让 10px；视口高度不足 16px 时自动隐藏按钮 |

---

### 8.2 完整单元测试代码规格（`ScrollArea.test.tsx`）

```tsx
import { render, screen, fireEvent, act } from '@testing-library/react';
import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScrollArea, calculateSafeAreaInset } from './ScrollArea';
import { ScrollAreaHandle } from './ScrollArea.types';
import styles from './ScrollArea.module.css';

describe('ScrollArea Atomic Component (UI Layer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('TC-SA-01: 基础结构、多态标签与无障碍 ARIA 支持', () => {
    render(
      <ScrollArea as="section" ariaLabel="Test Viewport" data-testid="scroll-area">
        <div data-testid="test-content">Inner Content</div>
      </ScrollArea>
    );

    const root = screen.getByTestId('scroll-area');
    expect(root.tagName.toLowerCase()).toBe('section');
    expect(screen.getByTestId('test-content')).toBeInTheDocument();

    const region = screen.getByRole('region', { name: 'Test Viewport' });
    expect(region).toBeInTheDocument();
    expect(region.getAttribute('tabIndex')).toBe('0');
  });

  it('TC-SA-02: 四级 Token 尺寸阶梯类名映射', () => {
    const { rerender } = render(
      <ScrollArea size="xs" data-testid="sa">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('sa').className).toContain('xs');

    rerender(
      <ScrollArea size="sm" data-testid="sa">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('sa').className).toContain('sm');

    rerender(
      <ScrollArea size="lg" data-testid="sa">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('sa').className).toContain('lg');
  });

  it('TC-SA-03: xs 尺寸解禁与 showButtons 规则 (M04 闭环)', () => {
    // 1. 未显式传入 showButtons 时，xs 默认无按钮
    const { rerender } = render(
      <ScrollArea size="xs">
        <div style={{ height: 1000 }}>Long Content</div>
      </ScrollArea>
    );
    expect(screen.queryByLabelText('Scroll Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll Down')).not.toBeInTheDocument();

    // 2. 显式声明 showButtons={true} 时，允许 xs 渲染微型按钮
    rerender(
      <ScrollArea size="xs" showButtons={true}>
        <div style={{ height: 1000 }}>Long Content</div>
      </ScrollArea>
    );
    expect(screen.getByLabelText('Scroll Up')).toBeInTheDocument();
    expect(screen.getByLabelText('Scroll Down')).toBeInTheDocument();
  });

  it('TC-SA-04: 端点安全护栏极值禁用态不变量', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true}>
        <div style={{ height: 1000 }}>Long Content</div>
      </ScrollArea>
    );

    const upBtn = screen.getByLabelText('Scroll Up');
    const downBtn = screen.getByLabelText('Scroll Down');

    // 初始处于顶部，Up 按钮必须 disabled，Down 按钮可用
    expect(upBtn.className).toContain('disabled');
    expect(downBtn.className).not.toContain('disabled');
    expect(upBtn.getAttribute('tabIndex')).toBe('-1');
  });

  it('TC-SA-05: 单击 40px 步进与微像素吸附', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true} stepSize={40}>
        <div style={{ height: 1000 }}>Long Content</div>
      </ScrollArea>
    );

    const downBtn = screen.getByLabelText('Scroll Down');
    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(viewport, 'scrollTop', { value: 0, writable: true, configurable: true });

    const scrollToSpy = vi.spyOn(viewport, 'scrollTo');

    // 点击向下步进按钮
    fireEvent.pointerDown(downBtn, { button: 0 });
    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ top: 40, behavior: 'smooth' })
    );

    // 模拟接近底部（maxScroll = 800，当前 798，距离仅剩 2px <= threshold 4px）
    viewport.scrollTop = 798;
    fireEvent.pointerDown(downBtn, { button: 0 });
    // 吸附算法应直接将 top 锁定为 800 (maxScroll)
    expect(scrollToSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: 800, behavior: 'smooth' })
    );
  });

  it('TC-SA-06: 20Hz 脉冲连发与 pointerUp 刚性刹车', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true}>
        <div style={{ height: 1000 }}>Long Content</div>
      </ScrollArea>
    );

    const downBtn = screen.getByLabelText('Scroll Down');
    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(viewport, 'scrollTop', { value: 0, writable: true, configurable: true });

    const scrollToSpy = vi.spyOn(viewport, 'scrollTo');

    // 按下左键
    fireEvent.pointerDown(downBtn, { button: 0 });
    expect(scrollToSpy).toHaveBeenCalledTimes(1); // 立即单发

    // 前进 200ms（尚未达到 250ms 初延迟防抖），不应连发
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    // 前进至 360ms（已进入 50ms 周期脉冲），连发触发
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(scrollToSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    // 松开指针，触发刚性刹车
    fireEvent.pointerUp(downBtn);
    const countAfterRelease = scrollToSpy.mock.calls.length;

    // 继续前进 500ms，计时器彻底停止，零额外调用
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(scrollToSpy.mock.calls.length).toBe(countAfterRelease);
  });

  it('TC-SA-07: 命令式 Handle API 调用契约', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef}>
        <div style={{ height: 600 }}>Content</div>
      </ScrollArea>
    );

    const handle = handleRef.current;
    expect(handle).toBeDefined();
    expect(typeof handle?.scrollToTop).toBe('function');
    expect(typeof handle?.scrollToBottom).toBe('function');
    expect(typeof handle?.scrollStep).toBe('function');
    expect(typeof handle?.getMetrics).toBe('function');

    const metrics = handle?.getMetrics();
    expect(metrics?.isAtTop).toBe(true);
  });

  it('TC-SA-08: prefers-reduced-motion 减弱动画降级', () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const handleRef = createRef<ScrollAreaHandle>();
    render(
      <ScrollArea ref={handleRef} showButtons={true}>
        <div style={{ height: 1000 }}>Long Content</div>
      </ScrollArea>
    );

    const downBtn = screen.getByLabelText('Scroll Down');
    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    const scrollToSpy = vi.spyOn(viewport, 'scrollTo');
    fireEvent.pointerDown(downBtn, { button: 0 });

    // 必须降级为 'auto' 瞬时位移，杜绝 'smooth'
    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'auto' })
    );
  });

  it('TC-SA-09: 滑块 Pointer Capture 鼠标拖拽动力学与 deltaY -> scrollTop 映射', () => {
    const handleRef = createRef<ScrollAreaHandle>();
    const { container } = render(
      <ScrollArea ref={handleRef} showButtons={false} style={{ height: 200 }}>
        <div style={{ height: 1000 }}>Long Draggable Content</div>
      </ScrollArea>
    );

    const viewport = handleRef.current?.getViewport();
    if (!viewport) throw new Error('Viewport not found');

    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(viewport, 'scrollTop', { value: 0, writable: true, configurable: true });

    // 触发 scroll 更新 metrics
    act(() => {
      fireEvent.scroll(viewport);
    });

    const thumb = container.querySelector(`.${styles.thumbIndicator}`) as HTMLElement;
    expect(thumb).toBeInTheDocument();

    // Mock Pointer Capture
    thumb.setPointerCapture = vi.fn();
    thumb.releasePointerCapture = vi.fn();

    // 1. PointerDown 启动拖拽
    fireEvent.pointerDown(thumb, { button: 0, clientY: 50, pointerId: 1 });
    expect(thumb.setPointerCapture).toHaveBeenCalledWith(1);

    // 2. PointerMove 向下拖拽 40px
    fireEvent.pointerMove(thumb, { clientY: 90, pointerId: 1 });
    expect(viewport.scrollTop).toBeGreaterThan(0);

    // 3. PointerUp 释放捕获
    fireEvent.pointerUp(thumb, { pointerId: 1 });
    expect(thumb.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('TC-SA-10: 极端圆角切角防护 calculateSafeAreaInset 与 <16px 退化紧凑态 (M02 & M03)', () => {
    // 1. 验证 14px 极端圆角下的安全内缩计算 (M02)
    const inset14 = calculateSafeAreaInset(14, 2);
    // x = 14 - 2 = 12, arcY = sqrt(196 - 144) = sqrt(52) ≈ 7.21, minInset = 14 - 7.21 = 6.79, ceil(6.79) + 1 = 8
    expect(inset14).toBe(8);

    // 2. 挂载带有 14px 圆角配置的 ScrollArea
    const { container, rerender } = render(
      <ScrollArea radius={14} trackMargin={2} showButtons={true}>
        <div style={{ height: 1000 }}>Content</div>
      </ScrollArea>
    );

    const trackCol = container.querySelector(`.${styles.stepperTrackColumn}`) as HTMLElement;
    expect(trackCol).toBeInTheDocument();
    // top 与 bottom 应为 safeInset(8) + margin(2) = 10px
    expect(trackCol.style.top).toBe('10px');
    expect(trackCol.style.bottom).toBe('10px');

    // 3. 退化紧凑态验证 (M03)：当视口高度极低（如 14px，不足 16px）时，自动隐藏按钮
    const handleRef = createRef<ScrollAreaHandle>();
    rerender(
      <ScrollArea ref={handleRef} radius={14} showButtons={true}>
        <div style={{ height: 1000 }}>Content</div>
      </ScrollArea>
    );

    const vp = handleRef.current?.getViewport();
    if (!vp) throw new Error('Viewport not found');
    Object.defineProperty(vp, 'clientHeight', { value: 14, configurable: true });
    Object.defineProperty(vp, 'scrollHeight', { value: 1000, configurable: true });

    act(() => {
      fireEvent.scroll(vp);
    });

    // 空间不足 16px，按钮应自动退化隐藏，只保留全行程滑块
    expect(screen.queryByLabelText('Scroll Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scroll Down')).not.toBeInTheDocument();
  });
});
```

---

## 九、本方案要删掉什么 / 收敛什么（删除面 Deletions Surface）

依据《主 Agent 全流程调度提示词 v3》§0.2：“**收敛在逻辑顺序上先于增强——一个概念已有多条路径时，先删到一条，再谈改进。没有删除/收敛动作的轮次不算完成。**”
本方案作为 `<ScrollArea>` 高频组件落地详案，设立刚性专节，明确列出必须彻底删除的历史补丁、胶水代码与冗余实现：

### 9.1 彻底删除弹窗与菜单中的防越界内边距魔术数字补丁

在历史代码中，各业务弹窗因为缺乏统一的端点护栏，为了防止滑块贴紧或刺穿容器圆角，就地堆砌了大量的防越界内边距补偿（Padding Hacks）。引入 `<ScrollArea>` 后，三段式轨道自带 2px 端点安全护栏与动态圆角 Inset 避让，**以下内边距补丁全部物理删除**：

1. **`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`**：
   - 彻底删除第 108 行：`padding-right: 4px;`（曾用于强行将滑块推离菜单右侧边缘）；
   - 彻底删除第 112 行：`margin-top: 6px; margin-bottom: 6px;`（曾用于试图在 CSS 里给滑块两端留出圆角安全距离）；
2. **`apps/crish-desktop/src/components/ui/Menu/Menu.module.css`**：
   - 彻底删除第 25-28 行：`padding-right: var(--menu-padding-hack, 3px);` 等发丝补偿代码；
3. **`apps/crish-desktop/src/components/ui/Select/Select.module.css`**：
   - 彻底删除第 168-171 行针对下拉视口添加的 `box-sizing: content-box; padding-right: 5px;` 补丁；
4. **`apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css`**：
   - 彻底删除为了防止滚动条贴紧右上角关闭按钮（X 按钮）而在 `dialogBody` 硬编码的 `padding-top: 12px; padding-bottom: 12px;` 畸形补偿。

### 9.2 彻底删除各业务视口手写的临时模拟滚动 JS 胶水代码

各业务域因缺乏统一组件，私自编写了大量脆弱的滚动监听和定时器，存在严重的内存泄漏隐患：

1. **彻底删除业务浮层中的滚动手写监听与防抖定时器**：
   - 删除 `ModelBadgePickerMenu.tsx` 中为了实现键盘上下键滚动计算而内联的 `scrollIntoView({ block: 'nearest' })` 冗余几何测量胶水，全面收敛为调用 `<ScrollArea>` 的 `scrollStep()` 与 `scrollTo()`；
2. **彻底删除各 Tab 面板的临时滚动位置保持逻辑**：
   - 删除 `SettingsPanel.tsx` 各 Tab 页面就地声明的 `useRef<number>(0)` 与 `window.requestAnimationFrame` 滚动恢复补丁，统一由 `<ScrollArea>` 暴露的标准 Handle 接管；
3. **彻底删除 `CheatsheetModal` 快捷键面板的手写滑块显隐监听**：
   - 删除其组件内用于监听鼠标移入移出并动态切换类名的 `useState(false)` 胶水代码，直接配置 `<ScrollArea type="hover">` 开箱即用。

### 9.3 彻底杜绝引入任何第三方重型滚动库

- **一票否决项**：
  - 严禁引入 `react-custom-scrollbars`、`react-custom-scrollbars-2`；
  - 严禁引入 `perfect-scrollbar`；
  - 严禁引入 `overlayscrollbars` / `overlayscrollbars-react`；
  - 严禁引入 `@radix-ui/react-scroll-area`（Radix ScrollArea 含有复杂的跨窗口测量与冗余 DOM，且无法满足二元灰度 8.2%/20.2% 严格死锁与 20Hz 脉冲微调契约）；
- **架构收敛**：完全基于 React 18+ 原生合成事件与标准 DOM Compositor，零外部运行时包体积增量。

### 9.4 彻底杜绝对上层 Store 与 Hooks 的反向依赖侵蚀

- 依据 `apps/crish-desktop/src/components/ui/README.md`，彻底杜绝任何引入：
  - `import ... from '@/store/...'`（禁 zustand）；
  - `import ... from '@/hooks/...'`（禁业务 hooks）；
  - `import ... from '@/api/...'` 或 `@/services/...`。
- 保证 `npm run check:ui-layer` 静态门禁扫描 0 警告、0 报错。

### 9.5 彻底清除 translateY 百分比断裂与混淆的 18% 百分比下限

- **清除自身百分比 translateY 错误定位**：彻底清除 `transform: translateY(${thumbTranslateYPercent}%)` 导致的位移瘫痪，收敛为基于轨道绝对定位的真实像素/百分比基准；
- **清除数值混淆的 18% 伪下限**：彻底清除 `Math.max(18, (clientHeight/scrollHeight)*100)%`，收敛为真实物理像素 `Math.max(18, ...)` 夹持。

### 9.6 全仓删除面代码行数度量清单

| 收敛/删除项类别 | 涉及文件与范围 | 预期删除代码行数 |
| :--- | :--- | :--- |
| **防越界 Padding 补丁** | `ModelBadgePickerMenu.module.css`, `Menu.module.css`, `Select.module.css`, `Dialog.module.css` | 净删除约 **35 行** 补丁 CSS |
| **业务层私有 WebKit 伪元素** | `ModelBadgePickerMenu` (110-132 行), `Menu` (48-66 行), `Select` (173-187 行) 等 | 净删除约 **60 行** 重复伪元素 |
| **临时模拟滚动胶水 JS** | `ModelBadgePickerMenu.tsx`, `SettingsPanel.tsx`, `CheatsheetModal.tsx` | 净删除约 **75 行** 胶水代码 |
| **第三方库潜在包袱** | 消除任何新增 npm 依赖与打包配置 | **0 字节** 外部运行时引入 |
| **合计净收敛** | **全仓累计清除冗余死层** | **$\ge 170$ 行** 负产出净收益 |

---

## 十、验收断言与立体验证套件

根据 §7.1 立体验证纪律，本方案交付前必须满足四维立体验证，禁止任何单方面宣称完成：

### 10.1 静态门禁刚性断言
- **断言 1.1**：运行 `npm run check:ui-layer`，输出严格包含 `Check passed`，零反向跨层依赖违规；
- **断言 1.2**：运行 `npm run typecheck`（TypeScript 严格编译），`ScrollArea` 及相关导出 0 类型错误；
- **断言 1.3**：静态扫描 `ScrollArea.module.css` 与 `ScrollArea.tsx`，**匹配裸写像素正则 `:\s*\d+px`（除 0 外）结果严格为 0**，全部消费 Token。

### 10.2 单元测试自动化断言
- **断言 2.1**：运行 `npx vitest run src/components/ui/ScrollArea/ScrollArea.test.tsx`，10 组测试用例（`TC-SA-01` 至 `TC-SA-10`）**100% 绿灯全通**；
- **断言 2.2**：测试覆盖率报告（Coverage）中，`ScrollArea.tsx` 语句覆盖率（Statements）$\ge 95\%$，分支覆盖率（Branches）$\ge 90\%$。

### 10.3 几何极限、端点避让与二元灰度物理断言
- **断言 3.1（代数极限真机验证）**：在渲染高 200px、内容高 1000px 的 `<ScrollArea showButtons={true}>` 中，当 `scrollTop = 0` 时，断言滑块顶边缘距顶部按钮底边缘距离严格等于 $2\text{px}$；当 `scrollTop = 800` 时，滑块底边缘距底部按钮顶边缘距离严格等于 $2\text{px}$；
- **断言 3.2（圆角防截断真机验证，M02）**：在外层 `border-radius: 14px` 的容器中挂载组件，断言 `calculateSafeAreaInset(14, 2) === 8`，侧柱顶部避让 `top: 10px`，滑块与按钮全行程外凸包与圆角内缩区绝对无交集，截断失真面积恒为 0；
- **断言 3.3（算术下溢退化紧凑态验证，M03）**：在高度 $< 16\text{px}$ 的极端紧凑容器中，端点按钮自动隐藏，滑块平稳回退至全行程无溢出，无负数高度报错；
- **断言 3.4（二元灰度死锁）**：通过计算样式检验：
  - 未激活态 Thumb 物理灰度测得严格为 $8.2\% \pm 0.3\%$；
  - 激活态（Hover、Active 与 Dragging 拖拽）Thumb 物理灰度测得严格为 $20.2\% \pm 0.3\%$；
  - 两态差值严格锁死在 $12.0\% \pm 0.5\%$ 内，全组件无第三种 Hover 灰阶。

### 10.4 动力学脉冲响应与拖拽交互断言
- **断言 4.1（初延迟防抖）**：指针按下持续时间 $t \in [0, 240\text{ms}]$ 时，滚动触发次数恒为 1 次；
- **断言 4.2（20Hz 连击）**：持续按压时间 $t \ge 250\text{ms}$ 后，定时器以严格的 $50\text{ms} \pm 2\text{ms}$ 周期连发脉冲，频度恒为 20Hz；
- **断言 4.3（即时制动）**：触发 `pointerup` 或 `blur` 后，事件循环内不再产生任何后续滚动微任务，停止滑行延迟为 0ms；
- **断言 4.4（拖拽 Pointer Capture 连续性）**：滑块按压后成功激活 `setPointerCapture`，拖拽位移 $\Delta Y$ 按 $\frac{S_{\max}}{D_{\text{travel}}}$ 比例精准无抖动映射至 `viewport.scrollTop`，松开后立即触发 `releasePointerCapture`。
