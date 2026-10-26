# 展开面板与浮层菜单架构审查报告：调用方矩阵与职责碎片化分析

> **报告版本**：1.0.0  
> **审查对象**：全仓所有 `SmartExpandablePanel`、`SmartPanel`、`Menu`、`Select`、`Popover` 及其业务调用方  
> **核心议题**：展开面板是否存在多处负责、修改困难与职责混乱；分析 `ComposePlusMenu` 主菜单 2 项与子菜单 12 项“向上冲天、严重脱节”的根因与意图冲突。

---

## 目录

1. [执行摘要与核心结论](#一执行摘要与核心结论)
2. [全仓浮层与展开组件全景矩阵](#二全仓浮层与展开组件全景矩阵)
3. [核心疑问深度剖析：多头负责与职责碎片化](#三核心疑问深度剖析多头负责与职责碎片化)
   - 3.1 双轨 `SmartPanel` 历史分裂
   - 3.2 坐标定位与翻折引擎“多头执政”
   - 3.3 安全三角（Safe-Aim）算法的三重冗余
   - 3.4 消费方私有包装、黑盒劫持与样式层叠污染
   - 3.5 废弃未落地的适配器死代码（Adapter Ghost）
4. [ComposePlusMenu 场景专题：主 2 项与子 12 项的冲突根因](#四composeplusmenu-场景专题主-2-项与子-12-项的冲突根因)
   - 4.1 历史演进路径还原（Git 考古溯源）
   - 4.2 几何坐标引擎断层：为什么“向上直冲天际”
   - 4.3 设计层面的意图冲突与信息架构倒挂
5. [收敛与重构建议路线图](#五收敛与重构建议路线图)

---

## 一、执行摘要与核心结论

针对用户提出的核心疑问：
> **“现在这个展开面板是有很多地方都负责，导致了修改困难还是怎么样呢？”**

审查结论非常明确：**是的，当前代码仓中展开面板与菜单体系存在严重的“职责多头割裂、一人一把号各吹各的调”现象**。修改困难并非单点逻辑复杂，而是由以下四层架构断层共同导致的系统性阻抗：

1. **同名异构组件共存**：仓库内同时存在两个完全不同的 `SmartPanel`。一个是基于 Radix Popover 的 [`SmartExpandablePanel`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx)，另一个是基于 `createPortal` + 原生 DOM 定位的 [`ui/SmartPanel`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.tsx)。统一出口 `ui/index.ts` 别名导出了前者，但侧栏会话上下文菜单却私下直接深导入了后者。
2. **多套定位引擎割据**：全仓至少存在 **6 套相互独立的定位与翻转计算逻辑**（`PositionEngine.ts`、`usePanelPosition.ts`、`Menu/position.ts`、`useFloatingPosition.ts`、Radix Floating UI、以及各业务组件内手写的原生 `getBoundingClientRect` 偏移计算）。
3. **安全三角算法三重实现**：级联子菜单防误触安全三角引擎被分别用三种不同算法实现于 `SafeAimEngine.ts`、`SafeTriangle.ts` 和 `useSafeAim.ts`。
4. **业务层自造轮子与样式污染**：各业务调用方（如 `ModelsCascadeSelect`、`ContextMenuFlyout`、`ModelBadgePickerMenu`）因通用组件难以满足自身特殊需求，纷纷绕过规范，在内部手写私有 Flyout 状态机、覆盖 3 层甚至 4 层 CSS 属性，导致全局样式与层级修改牵一发动全身。

针对 `ComposePlusMenu` 主菜单仅 2 项、子菜单 12 项且“向上冲天脱节”的现象：
- **历史根因**：原先 `ComposePlusMenu` 拥有 6 个主功能项（文件、技能、插件、MCP、扩展、定时任务），后在重构中被裁减为仅剩 2 项，但技能项仍保留了二级级联结构；
- **几何缺陷**：底部输入框贴近视口底部，主面板向上展开（高约 72px），但子菜单容纳 12 项（高约 420px）。`PositionEngine.ts:357` 的越界约束公式强行将子菜单顶边 `top` 设为 `bounds.bottom - height`，将其整体向上推举 300px+，与 72px 的微型主菜单物理脱节；
- **意图冲突**：输入框底栏加号本是高频直接入口，却把次级技能列表组织为深层悬浮级联，造成了“主菜单贫血、子菜单爆仓”的信息架构倒置。

---

## 二、全仓浮层与展开组件全景矩阵

下表系统梳理全仓所有调用 `SmartExpandablePanel`、`Menu`、`SmartPanel`、`Select`、`Popover` 的业务组件与上层调用方：

| 序号 | 业务组件 / 调用文件 | 引入底层基元 | 触发模式 | 级联子菜单 (Cascade) | 条目数范围 | 核心功能特性 | 定位与对齐配置 | 私有包装 / 样式覆盖 / Hack 现象 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | [ComposePlusMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx#L145-L156) | `SmartExpandablePanel` | 受控 `open` (点击加号) | **是** (技能子菜单) | 主: 2 项<br>子: **12 项** | 禁用搜索，纯数据驱动，Microtask 聚焦还原 | `{ side: 'top', align: 'start', sideOffset: 6 }` | **严重样式堆叠**：同时叠加 `menuStyles.menuContent`、`styles.panel` 与 `styles.plusMenu` 三组容器属性；遗留旧 `renderItem` 残存样式 |
| **2** | [ChatHeaderMore.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatHeaderMore.tsx#L151-L157) | `SmartExpandablePanel` | `click` (默认) | **是** (移动到项目...) | 主: 3~5 项<br>子: 0~N 文件夹 | 固定、移动、导出、分享、清空记录等操作组 | `{ side: 'bottom', align: 'end', sideOffset: 6 }` | 传递空类名 `className="chat-header-more-panel"`（无对应 CSS），触发器二次包裹 Tooltip |
| **3** | [ProjectPickerMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.tsx#L228-L242) | `SmartExpandablePanel` | `click` / `hover` 可透传 | **是** (添加项目...) | 主: 3~15 项<br>子: 2 项 | **开启内嵌搜索**、单选打勾、悬停行内删除按钮（ConfirmGate 守卫） | `{ side: 'bottom', align: 'center', sideOffset: 6 }` | 私有类 `pickerPanel` 强制锁定 `width: 230px`；自定义行内删除微交互 |
| **4** | [SubagentHeaderPanel.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.tsx#L136-L142) | `SmartExpandablePanel` | `click` (默认) | 否 | 0~N 子代理 | 运行态脉冲绿点、状态徽标、行内终止按钮 | `{ side: 'bottom', align: 'start', sideOffset: 6 }` | 私有类 `subagentMenuPanel` 覆盖 `min-width: 240px; max-width: 320px; padding: 4px` |
| **5** | [ToolTabAddButton.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/binary-tree/ToolTabAddButton.tsx#L88-L99) | `SmartExpandablePanel` | `click` | 否 | 2~6 工具面板 | 动态过滤已打开视图，多开 ID 自动递增计算 | `{ side: 'bottom', align: 'end', sideOffset: 4 }` | 私有类 `leafToolAddPanel` 覆盖 `min-width: 140px` |
| **6** | [SessionContextMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx#L129-L145) | **`ui/SmartPanel` (非 Expandable)** | **鼠标右键坐标点 `point={{x,y}}`** | 否（组件支持） | 11 项操作 | 右键原地呼出、LayerStack 排他驱逐、分叉/置顶/删除 | 原生 DOM 绝对坐标计算 | **绕过标准统一出口**，直接深导入并绑定独立 DOM Portal 版 `SmartPanel`，自定 z-index |
| **7** | [PermissionModeMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx#L133-L199) | `ui/Menu` | `click` (独占切换) | 否 | 4 项权限模式 | 自定义 `renderItem`、模式解释 Tooltip 矩阵、翡翠绿打勾 | `{ side: 'top', align: 'start', sideOffset: 6 }` | **处于同一底栏却使用 Menu 而非 SmartExpandablePanel**；私有样式 `permMenu` 深度定制行高 |
| **8** | [ComposerFusedTrigger.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.tsx#L188-L225) | `ui/Menu` | `click` (独占切换) | 否 | 2~5 思考档位 | 自定义 `renderItem`、思考档位打勾 | `{ side: 'top', align: 'end', sideOffset: 6 }` | **处于同一底栏却使用 Menu**；私有 `contentClassName: styles.menu` |
| **9** | [ModelBadgePickerMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx#L332) | `ui/Menu` | 受控 `open` | 否（内嵌折叠） | 10~30+ 模型 | **传入 children 完全劫持内部**；内嵌搜索框、供应商分组、高级可折叠思考强度拖拽条 | `{ side: 'top/bottom', align: 'start', sideOffset: 6, maxHeight: 480 }` | **把 Menu 当纯外壳容器使用**，内部全部重写；私有滚动容器与折叠状态机 |
| **10** | [ModelsCascadeSelect.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsCascadeSelect.tsx#L300-L448) | `ui/Menu` + **自研子菜单** | `click` + `hover` | **是** (模型级联) | 5~15 供应商<br>子: 1~20 模型 | 独立安全三角 `SafeTriangleTracker`、子菜单 `createPortal` 逃逸、FocusTrap 白名单 | `calculateSubmenuPosition` (Menu/position.ts) | **严重架构混乱**：明明用了 Menu，却完全不走 Menu 的级联或 SmartPanel，自己在组件里手写一整套 Portal 级联浮层 |
| **11** | [ContextMenuFlyout.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx#L210-L480) | `ui/Menu` + **自研 Flyout** | `click` + `hover` | **是** (排序/分组) | 3 行，每行 2~3 项 | 自研 `FlyoutRow`、自研双向定时器宽限期状态机、单选 radio 模式 | 内联相对定位 + 手写 `flipLeft` 检测 | **完全手写二级展开**：直接在 `menuitem` 内部渲染内联 `div.sortFilterFlyout`，根据 `window.innerWidth` 暴力算翻折 |
| **12** | [ModelsYamlConfigMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsYamlConfigMenu.tsx#L180-L250) | `ui/Menu` | `click` | 否 | ~8 项 | 外部编辑器扫描、默认关联程序、复制路径 | `{ side: 'bottom', align: 'end', sideOffset: 4 }` | 声明了 `options={yamlMenuOptions}` 却又传入了 `children`，导致 `options` 被静默吞噬丢弃 |
| **13** | [FileActions.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/files/FileActions.tsx#L246-L322) | `ui/Menu` | `click` | 否 | 打开方式: 3~8<br>更多: 3 项 | 系统文件管理器图标嗅探、剪贴板交互 | `{ side: 'bottom', align: 'end', sideOffset: 4 }` | 标准规范使用 `Menu`，无多余侵入 |
| **14** | [FileViewerCard.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/files/FileViewerCard.tsx) | `ui/Menu` | `click` | 否 | 3 项 | 相对路径、绝对路径、资源管理器显示 | `{ side: 'bottom', align: 'end', sideOffset: 4 }` | 标准规范使用 `Menu` |
| **15** | [SkillsMoreMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsMoreMenu.tsx) | `ui/Menu` | `click` | 否 | 4~6 项 | 同步到引擎、发现新技能、刷新、批量切换 | `{ side: 'bottom', align: 'end', sideOffset: 4 }` | 自定义 `renderItem` 注入批量确认交互 |
| **16** | [ScheduledTasksPanel.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/settings/ScheduledTasksPanel.tsx) | `ui/Menu` | `click` | 否 | 2~3 项 | 计划任务新建模板 | 默认定位 | 标准规范使用 `Menu` |
| **17** | [SettingsQuickMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.tsx) | `ui/Menu` | `click` | 否 | 6~8 项 | 设置面板全局快捷跳转 | 默认定位 | 标准规范使用 `Menu` |
| **18** | [FontSelectField.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.tsx) | `ui/Menu` | `click` | 否 | 10~20 项 | 字体下拉选择 | 默认定位 | 用 `Menu` 充当 `Select` 下拉选择器 |
| **19** | [Select / Combobox](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.tsx#L32-L43) | `ui/Select` (复合组件) | `click` | 否 | 2~10 项 | 键盘高亮漫游、清空按钮、筛选高亮 | `useFloatingPosition.ts` 独立定位 | 设置页与表单系统广泛使用，完全独立于 Menu/SmartPanel |
| **20** | [NewTabLauncherPopover.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.tsx#L15) | 纯 `@radix-ui/react-popover` | `click` | 否 | 3 项操作 + 动态项目 | 顶栏加号 336px 快捷浮层、键盘快捷键 | Radix 自动定位 | 独立设计的 Popover 浮层，不复用 Menu 或 SmartPanel |
| **21** | [TiptapSlashMenu.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx#L19) | 纯 `@radix-ui/react-popover` | 输入 `/` 触发 | 否 | 10~25 项 | 虚拟光标锚定 `safeCursorAnchor`、熔断坐标防护 | 基于光标 clientRect | 编辑器原生指令浮层，独立架构 |
| **22** | [ComposerDirTree.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposerDirTree.tsx#L13) | 纯 `@radix-ui/react-popover` | 输入 `@@` 触发 | 否 | 目录树列表 | 异步加载目录树、面包屑跳转 | 基于光标 clientRect | 编辑器文件引用浮层，独立架构 |
| **23** | [PinActionWithPicker.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-message-row/PinActionWithPicker.tsx#L77-L100) | 原生 `createPortal` | `hover` + `click` | 否（展开色板） | 预置色 + HSV 色盘 | **手写坐标与翻折算法**、粘性状态机、防移出误关 | 原生 DOM 绝对坐标 | 完全手写浮层定位，不依赖任何 UI 基座 |
| **24** | [FileAnnotationPopover.tsx](file:///C:/Software/conex/apps/crish-desktop/src/components/files/FileAnnotationPopover.tsx#L28-L30) | 原生绝对定位 | 选中文本触发 | 否 | 行内批注输入框 | 文本选区锚定、CSS.highlights 高亮 | 选区坐标计算 | 原生 DOM 绝对定位 |

---

## 三、核心疑问深度剖析：多头负责与职责碎片化

用户的问题直指核心痛点：“是不是有很多地方都在负责展开面板？”
答案：**不仅是很多地方在负责，而且每一层都存在“另立门户”的现象。**

### 3.1 双轨 `SmartPanel` 历史分裂

在原子设计系统层，同时存在两个同名组件目录：

```
apps/crish-desktop/src/components/ui/
├── SmartExpandablePanel/     <-- 基于 Radix Popover 封装
│   ├── SmartExpandablePanel.tsx
│   ├── PositionEngine.ts     <-- 自身专用的级联几何引擎
│   ├── adapters/             <-- 试图兼容 Menu/Select 的空头适配器
│   └── index.ts              <-- export { SmartExpandablePanel, SmartExpandablePanel as SmartPanel }
└── SmartPanel/               <-- 基于 createPortal + 原生 DOM 封装
    ├── SmartPanel.tsx
    ├── hooks/usePanelPosition.ts <-- 另一套面板定位引擎
    └── index.ts              <-- export { SmartPanel }
```

- **统一 Barrel 伪装**：[`apps/crish-desktop/src/components/ui/index.ts:139-140`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/index.ts#L139-L140) 将 `SmartExpandablePanel` 作为 `SmartPanel` 导出，宣称是“全仓统一单真理基元”；
- **私自深导入分裂**：[`apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx:3`](file:///C:/Software/conex/apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx#L3) 却跳过统一出口，显式引入了 `../ui/SmartPanel`：
  ```tsx
  import { SmartPanel, type MenuItem } from '../ui/SmartPanel';
  ```
  这直接导致侧栏上下文菜单与工作区其他面板走的是两套完全隔离的代码通路、两套生命周期和两套样式系统。

### 3.2 坐标定位与翻折引擎“多头执政”

在浮层弹出与二级子菜单展开的位置计算上，全仓存在极其严重的重复造轮子：

1. **`PositionEngine.ts`**（[路径](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/PositionEngine.ts#L321-L368)）：供 `SmartExpandablePanel` 级联子菜单使用，采用 `placeCascadeSubmenu` 纯数学算法，计算 `left/top`；
2. **`usePanelPosition.ts`**（[路径](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/hooks/usePanelPosition.ts)）：供 `ui/SmartPanel` 使用，计算鼠标右键点或触发器的坐标；
3. **`Menu/position.ts`**（[路径](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/Menu/position.ts#L1-L9)）：声称是“坐标计算单源纯函数引擎”，包含 `calculateSubmenuPosition`、`calculateMenuPosition`，但仅被 `ModelsCascadeSelect` 和 `Menu` 部分引用；
4. **`useFloatingPosition.ts`**（[路径](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts)）：供 `Select` / `Combobox` 使用，通过 `requestAnimationFrame` 循环测量 DOM；
5. **Radix Popper 引擎**：`SmartExpandablePanel`、`Menu`、`TiptapSlashMenu` 底层依赖的 `@radix-ui/react-popover` 自身的 Floating UI 定位。
6. **业务手写定位**：
   - `PinActionWithPicker.tsx:94-100`：手写 `spaceAbove >= height + 8 ? 'top' : 'bottom'`；
   - `ContextMenuFlyout.tsx:73`：手写 `rowRect.right + flyoutWidth + 10 > window.innerWidth - 8` 判断是否向左翻转。

每一套引擎对边界留白（Padding）、最大高度限制、翻转滞后量（Hysteresis）的定义都不相同。修改了其中一套，其他业务组件的菜单体验依然如故。

### 3.3 安全三角（Safe-Aim）算法的三重冗余

当用户鼠标从主菜单行向二级子菜单斜向移动时，需要安全三角算法防止跨过其他条目时误切菜单。代码仓中居然维护了三套完全独立的数学实现：

1. **[`ui/internal/SafeAimEngine.ts`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts)**：单例类，基于光标历史采样点与子菜单矩形构建多边形凸包，供 `SmartExpandablePanel` 使用；
2. **[`ui/internal/SafeTriangle.ts`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/internal/SafeTriangle.ts)**：`SafeTriangleTracker` 类，基于二维向量叉积判断点是否在三角形内部，供 `ModelsCascadeSelect` 私有使用；
3. **[`ui/SmartPanel/hooks/useSafeAim.ts`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/hooks/useSafeAim.ts)**：Hook 封装，内部又写了一遍基于坐标夹角的三角判定，供 `ui/SmartPanel` 使用。

### 3.4 消费方私有包装、黑盒劫持与样式层叠污染

各业务组件在使用这些展开面板时，存在普遍的不信任和“强行覆写”：

- **DOM 结构强行顶包（Children Hijack）**：
  [`ModelBadgePickerMenu.tsx:332`](file:///C:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx#L332) 和 [`ModelsYamlConfigMenu.tsx:196`](file:///C:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsYamlConfigMenu.tsx#L196) 虽然调用了 `<Menu>`，但直接利用 `<Menu>` 的 `children` 插槽，将内部全部替换成自己手写的 JSX 树。这使得 `Menu` 原生提供的键盘漫游（`menuKeyNavigation.ts`）、无障碍属性、条目尺寸约束完全失效。
- **三层 CSS 叠加互踩**：
  在 [`SmartExpandablePanel.tsx:356`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx#L356)：
  ```tsx
  const panelClasses = [menuStyles.menuContent, styles.panel, className].filter(Boolean).join(' ');
  ```
  在 `ComposePlusMenu` 中，传递的 `className` 是 `styles.plusMenu`。这导致同一个 `<Popover.Content>` 节点上同时生效了：
  1. `Menu.module.css` 的 `.menuContent`（定义了 padding: 6px, border, background, max-height 640px, overflow-y: auto）；
  2. `SmartExpandablePanel.module.css` 的 `.panel`（定义了 padding: 6px, border, background, min-width 180px, max-width 360px）；
  3. `ComposePlusMenu.module.css` 的 `.plusMenu`（定义了 padding: 6px, border, background, min-width 188px）。
  三套 CSS 类对背景色、圆角、内边距、阴影展开了激烈的层叠特异性争夺，任何全局 token 微调都会导致不可预期的渲染漂移。

### 3.5 废弃未落地的适配器死代码（Adapter Ghost）

在 [`apps/crish-desktop/src/components/ui/SmartExpandablePanel/adapters/`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/adapters/) 中存在：
- `MenuAdapter.tsx`（392 行）
- `SelectAdapter.tsx`（216 行）
- `schemaBridge.ts`（123 行）

审查发现：
1. `MenuAdapter.tsx` 内部虽然调用了 `convertMenuOptionsToSmartItems(options)`，但转换后的 `_smartItems` **根本没有被任何 JSX 使用**，其内部直接复制了 `Menu.tsx` 的老逻辑；
2. 整个应用除了单元测试之外，**没有任何一个业务组件**导入使用 `MenuAdapter` 或 `SelectAdapter`；
3. 这些适配器本意是收敛两套体系，但中途搁浅，成为了徒增认知负担的幽灵资产。

---

## 四、ComposePlusMenu 场景专题：主 2 项与子 12 项的冲突根因

针对桌面端截图中呈现的诡异画面：**底部点击加号，主菜单仅「添加文件」和「使用 skill」两项，而展开的二级菜单却包含 12 项，向上直冲天际，与主菜单严重脱节。**

### 4.1 历史演进路径还原（Git 考古溯源）

通过对代码仓提交历史进行精准追溯，真相浮出水面：

1. **第一阶段：平铺 6 大操作（Commit `6ad623948`）**  
   原有的 `ComposePlusMenu` 采用 `Menu` 组件，平铺呈现 6 个并列的功能条目：
   - 📎 添加文件
   - ✨ 使用技能
   - 🧩 插件
   - 🔌 MCP 工具
   - 🧱 扩展中心
   - ⏰ 定时任务  
   此时主菜单高度约 220px，结构紧凑完整。

2. **第二阶段：迁移至 SmartExpandablePanel 引入级联（Commit `d81f144a0`）**  
   引入 `SmartExpandablePanel`，为了容纳日益增多的技能和插件，将“使用技能”和“插件”改造为级联子菜单（`type: 'submenu'`）。  
   此时主菜单依然有 6 个主要项目（文件、技能[子菜单]、插件[子菜单]、MCP、扩展、定时任务），主面板高度与右侧子菜单高度旗鼓相当，视觉重心平衡。

3. **第三阶段：激进收口导致信息架构倒挂（Commit `3cd2ba578`）**  
   提交 `3cd2ba578`（*feat(extensions): unify skills ssot, complete mcp 30 tools and granularity control, refactor import workbench*）中：
   开发者为了将入口收拢到全局扩展中心，直接将“插件”、“MCP 工具”、“扩展中心”、“定时任务” 4 项从加号菜单中彻底删除！  
   **修改后，主菜单只剩下了可怜的 2 项**：
   - 📎 `file`: 添加文件或附件
   - ✨ `skill`: 使用 skill（级联子菜单）
   与此同时，系统内置与用户自定义技能大幅增加，`skillChildren` 包含了：10 个具体技能 + 1 个分割线 + 1 个「管理技能...」= **共 12 项**！

### 4.2 几何坐标引擎断层：为什么“向上直冲天际”

为什么 12 项的子菜单会与 2 项的主菜单脱节并直冲天际？这是 [`PositionEngine.ts`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/PositionEngine.ts#L355-L368) 中的硬编码公式缺陷导致的物理必然：

```typescript
// PositionEngine.ts:355-360
let top = itemTop;
if (top + height > bounds.bottom) {
  top = Math.max(bounds.top, bounds.bottom - height);
} else {
  top = Math.max(bounds.top, top);
}
```

具体数值推导（现场物理模拟）：
1. 宿主环境为桌面窗口，高度设为 `800px`，输入框位于窗口底部，加号按钮位于 `y ≈ 750px`；
2. 主菜单配置为 `{ side: 'top', align: 'start', sideOffset: 6 }`，因此主菜单向上弹出；
3. 主菜单仅有 2 个条目，每个条目 32px，外加内边距与边框，**主菜单总高度仅约 72px**，其在屏幕中的垂直范围为 `[670px, 742px]`；
4. 第二个条目「使用 skill」的顶部坐标 `itemTop ≈ 704px`；
5. 当鼠标悬停在「使用 skill」上时，展开 12 项子菜单。每项 36px，加分割线和内边距，**子菜单总高度 `height ≈ 420px`**；
6. 定位引擎计算：`top + height = 704 + 420 = 1124px`，严重超过视口底部边界 `bounds.bottom = 800 - 12 = 788px`；
7. 触发翻折逻辑：
   $$\text{top} = \text{bounds.bottom} - \text{height} = 788 - 420 = 368\text{px}$$
8. **结果**：
   - 主菜单的范围是：`[670px, 742px]`（高 72px）；
   - 子菜单的范围是：`[368px, 788px]`（高 420px）；
   - **子菜单的顶部冲到了 `368px`，高出主菜单顶部整整 302px！**
   - 视觉上，主菜单只是贴在输入框上的一个微型胶囊，而旁边突然凭空升起一根高达视口中央的“巨型高塔”，二者在顶部完全不齐平，在基线也不对称，形成极其突兀的割裂感。

此外，[`PositionEngine.ts:257`](file:///C:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/PositionEngine.ts#L257) 声明了 `MAX_CASCADE_PANEL_HEIGHT = 760`。只要屏幕能塞下，子菜单永远不会出现滚动条限制，而是无限垂直撑开，彻底放大了这种冲天效应。

### 4.3 设计层面的意图冲突与信息架构倒挂

从交互设计的维度分析，这暴露出本质上的意图冲突：

```
【当前畸形架构】
输入框「+」点击
 └── 主菜单（仅 2 项，高度 72px）
      ├── 1. 添加文件
      └── 2. 使用 skill ──── [悬停跨越安全三角] ───> 巨型子菜单（12 项，高度 420px，冲天展开）
                                                    ├── 技能 1 (/goal)
                                                    ├── 技能 2 (/learn)
                                                    ├── ... (10 项技能)
                                                    ├── ───────────────
                                                    └── 管理技能...
```

1. **父轻子重，动线成本高昂**：加号菜单本意是轻量级的快捷工具箱。让用户点击加号后，面对只有 2 个选项的主菜单，必须小心翼翼地横向移入展开列表，路径过长；
2. **与编辑器内置 SlashMenu 功能严重重叠**：
   在输入框中只要键入 `/`，就会唤起专为技能和斜杠命令设计的 [`TiptapSlashMenu`](file:///C:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx)，其自带智能拼音/英文检索、键盘上下漫游、分类图标。用户在加号菜单里点选技能，最终也只是在输入框插入斜杠命令；
3. **加号入口定位模糊**：如果加号里只保留“文件”和“技能”，那么加号实际上被降级成了“文件上传与技能快捷方式”。由于把其他系统级功能（插件、MCP、工作流）一刀切移走，导致主菜单支撑不起一个级联层级。

---

## 五、收敛与重构建议路线图

基于上述审查证据，给出清晰的架构收敛与修复建议：

### 阶段一：治标修复（ComposePlusMenu 物理脱节与冲天紧急修复）

1. **限制级联面板最大高度与开启内滚动**：
   在 `SmartPanelCascadeSubmenu.tsx` 或其样式中，将二级子菜单的 `max-height` 限制为与当前视口及主菜单协同的合理尺寸（如 `min(320px, calc(100vh - 200px))`），并添加 `overflow-y: auto`。
2. **重构 PositionEngine 底部贴合规则**：
   当触发源位于向上展开（`side: 'top'`）的面板中时，子菜单的底边缘应当与主菜单底边缘对齐（Bottom-Aligned），而不是死板地将顶边设为 `bounds.bottom - height`。
3. **拍平 ComposePlusMenu 交互形态**：
   取消 2 项主菜单 + 12 项二级菜单的级联结构。推荐：
   - **方案 A（分类平铺分组）**：在一个弹层中分为两组，上部为「基础操作」（添加文件、管理扩展），下部为「常用技能」（展示最近使用的 3~5 个技能 + “更多技能...”）；
   - **方案 B（双列或搜索型 Command Palette）**：参考现代 AI 客户端（如 Raycast / Notion AI / Cursor），点击加号直接展开带内嵌搜索的统一能力面板（复用 `SmartExpandablePanel` 自带的 `enableSearch`）。

### 阶段二：治本收敛（全仓菜单与展开面板架构净治理）

1. **物理清退并轨 `ui/SmartPanel` 与 `SmartExpandablePanel`**：
   - 将 `apps/crish-desktop/src/components/sidebar/SessionContextMenu.tsx` 迁移至 `SmartExpandablePanel`（补充 `point` 右键坐标支持到 `PositionEngine`）；
   - 彻底删除孤立的 `apps/crish-desktop/src/components/ui/SmartPanel/` 目录，消除全仓“同名异构双子星”隐患。
2. **物理清理 Ghost 适配器死代码**：
   - 物理清理 `src/components/ui/SmartExpandablePanel/adapters/` 下未生效的 `MenuAdapter.tsx` 与 `SelectAdapter.tsx`，避免误导后续维护者。
3. **统一 Safe-Aim 几何引擎**：
   - 全局仅保留一份位于 `ui/internal/SafeAimEngine.ts` 的安全三角核心算法，废弃并移除 `SafeTriangle.ts`，重构 `ModelsCascadeSelect.tsx`，使其接入统一安全引擎。
4. **清理样式重叠污染**：
   - 明确 `SmartExpandablePanel` 容器的单一样式真理（SSOT），禁止在业务模块（如 `ComposePlusMenu.module.css`）中二次重复声明 `border`、`background`、`border-radius`、`box-shadow`。
