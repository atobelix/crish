# Conex / Crish — 对话流与输入区交互重构落地方案

> **文档标识**：`docs/smart-panel-migration/independent-plans/02-composer-chat-plan.md`
> **战役工作区**：`docs/smart-panel-migration/`
> **架构角色**：对话流与输入区重构专家（Composer & Chat Area Specialist）
> **遵循基准**：`AGENTS.md`（通用协作纪律、反退避铁律、严禁打补丁）、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`docs/smart-panel-migration/00-total-migration-plan.md`
> **资产参考**：`reference/smart-expandable-panel/`（Zero-Blue 墨阶、同心圆角、Safe-Aim 重心坐标、PositionEngine 120Hz 视口解算）

---

## 目录索引

1. [架构愿景与重构目标](#1-架构愿景与重构目标)
2. [核心痛点诊断与针对性治理矩阵](#2-核心痛点诊断与针对性治理矩阵)
3. [模型与思考档位胶囊（ComposerFusedTrigger）重构方案](#3-模型与思考档位胶囊composerfusedtrigger重构方案)
4. [输入区操作按钮统一方案（24×24px 极简微圆角）](#4-输入区操作按钮统一方案2424px-极简微圆角)
5. [权限模式面板（PermissionModeMenu）3 处违规彻底根除方案](#5-权限模式面板permissionmodemenu-3-处违规彻底根除方案)
6. [核心组件数据驱动 Schema 与代码 Diff 规划](#6-核心组件数据驱动-schema-与代码-diff-规划)
   - 6.1 `ComposerFusedTrigger`（胶囊分段悬停与物理发丝分割）
   - 6.2 `PermissionModeMenu`（专属语义图标、11px次级描述与同心卡片）
   - 6.3 `ComposePlusMenu`（24×24 图标槽、双行图文与 SmartPanel 数据驱动）
   - 6.4 `ModelBadgePickerMenu`（双级级联、Safe-Aim 轨迹保护与独立滚动区）
   - 6.5 `TiptapSlashMenu`（光标物理包围盒安全锚定与指令 Schema）
   - 6.6 `ComposerDirTree`（工作区物理目录树递归与 Mention 注入）
   - 6.7 `MessageActionsBar`（User / Assistant 消息操作工具栏统一）
   - 6.8 `ChatComposer`（四层空间垂直堆叠装配）
7. [状态流转、WAI-ARIA 键盘无障碍与 IME 防误触机制](#7-状态流转wai-aria-键盘无障碍与-ime-防误触机制)
8. [单元测试与魔鬼用例（Devil Test Cases）验证矩阵](#8-单元测试与魔鬼用例devil-test-cases验证矩阵)
9. [四步走实施路线图与验收断言](#9-四步走实施路线图与验收断言)

---

## 1. 架构愿景与重构目标

在 Crish 桌面端的人机对话交互体系中，主输入区（ChatComposer）与消息流操作栏（MessageActionsBar）是用户操作频率最高的视觉核心。本方案旨在对照 `reference/smart-expandable-panel/` 的工业级标准，彻底消灭当前输入区存在的**悬停直角硬切**、**彩色皮肤下青灰底色叠加**、**权限盾牌深色实心块**、**权限面板缺乏语义图标与次级描述**等视觉与交互断层。

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                               ChatComposer 4-Layer Spatial Architecture                 │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 1: 浮动审批条 [ 🛡️ 需确认 · 改文件前需批准 ] ────── [ 允许 ] [ 拒绝 ] [ 始终允许 ]      │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: 目标/计划进度条 [ 🎯 计划模式 | 步骤 2/5 ] ───────────────────── [ 查看 ] [ 暂停 ]   │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 3: 引用与文件卡片区 [ 📎 App.tsx ✕ ] [ 🖼️ screenshot.png ✕ ]                        │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 4: 主输入网格 (Card with 1px Hairline Border, R=22px)                              │
│ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ [ ＋ ]  [ 🛡️ ]  │ 输入消息，或键入 / 打开命令…             │ [ deepseek-v4 ▾ ⏐ 最深 ] [ ⬆ ] │ │
│ │ 24x24   24x24   │ (Tiptap RichText / Fallback Textarea)  │ (Fused Capsule, R=14px) (32x32)│ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 核心交付目标
1. **视觉纯净度（Zero-Blue & Concentric Geometry）**：
   - 彻底消灭在白底浮层中直接消费 `--sidebar-hover` 引起的深青灰泥色块；
   - 严格遵循 $R_{\text{inner}} = R_{\text{outer}} - P = 14\text{px} - 6\text{px} = 8\text{px}$ 的同心几何曲率；
2. **微交互无缝平滑（Segmented Independent Hover）**：
   - 融合胶囊整体为 1px 中性发丝边框 + 单层透明底，左右两段独立 4px/6px 槽位悬停与 `rgba(29, 28, 26, 0.045)` 极浅暖灰，彻底消灭直角撕裂；
3. **按钮标准统一（Micro Icon Button Primitive）**：
   - 输入区左侧 `[ ＋ ]` 加号与 `[ 🛡️ ]` 盾牌统一为 24×24px 极简微圆角图标按钮，透明底色，悬停柔和淡入；
4. **权限模式信息密度提升（Permission Matrix Redesign）**：
   - `PermissionModeMenu` 补齐专属语义图标（`[ 🛡️ ]` `[ 🔍 ]` `[ 🎯 ]` `[ ⚡ ]`）与 11px 次级描述，条目圆角 6px，选中态 6.5% 微灰 + `#059669`（翡翠绿）细线对勾；
5. **全链路 Schema 化与零回归保障**：
   - 全面覆盖 `ComposePlusMenu`、`ModelBadgePickerMenu`、`TiptapSlashMenu`、`ComposerDirTree`、`MessageActionsBar` 的 Schema 与 Diff 规划，确保快层中层 800+ 单元测试 100% 绿灯。

---

## 2. 核心痛点诊断与针对性治理矩阵

| 序号 | 模块与位置 | 现状缺陷诊断 | 工业级重构方案 |
| :--- | :--- | :--- | :--- |
| **P1** | `ComposerFusedTrigger` (融合模型胶囊) | 1. 鼠标悬停在模型或思考档位上时，子元素产生直角背景硬切，与外层 14px 半圆形成视觉撕裂；<br>2. 彩色主题下 `var(--tint-active)` 或外层 `.capsule:hover` 与内层 hover 发生青底叠色。 | 1. 外层 `.capsule` 锁定单层透明底 + 1px 中性发丝边框（`--sep-border-color: #e2dfd9`），高度 28px，圆角 14px；<br>2. 左右两槽（模型选择器、思考档位按钮）各自提供独立的 4px/6px 槽位圆角，悬停仅使用 `rgba(29, 28, 26, 0.045)` 极浅暖灰；<br>3. 中间以 1px 宽、10px 高的中性发丝线物理隔离。 |
| **P2** | 输入区左侧工具按钮 (`plusBtn`, `permPill`) | 1. `PermissionModeMenu` 的 `[ 🛡️ ]` 盾牌按钮在 `iconOnly` 模式下为 28x28 且带有深色实心底/边框；<br>2. `[ ＋ ]` 加号为 32x32 且为正圆，两者在输入框左侧尺寸与形状不协调。 | 1. 彻底消灭盾牌按钮实心深色底，统一为透明底色；<br>2. 加号 `[ ＋ ]` 与盾牌 `[ 🛡️ ]` 统一规范为 **24×24px 极简微圆角图标按钮**（圆角 6px，图标 14px），悬停时柔和淡入 `var(--sidebar-hover)`，间距 4px。 |
| **P3** | `PermissionModeMenu` (权限模式下拉面板) | **用户截图标注 3 处违规**：<br>1. 缺少专属语义图标，文案单薄缺少次级说明；<br>2. 条目圆角不规范，选中态使用大黑勾与深灰色块；<br>3. 浮层边框重叠、圆角不同心。 | **3 处违规根除**：<br>1. 补齐专属语义图标（`[ 🛡️ ]` `[ 🔍 ]` `[ 🎯 ]` `[ ⚡ ]`）与 11px 次级描述（`每次执行需手动批准`、`只读分析与代码检索` 等）；<br>2. 条目圆角锁定 6px，悬停 4.5% 微灰，选中 6.5% 微灰 + `#059669`（翡翠绿）品牌对勾，消灭黑勾与深色块；<br>3. 外层遵循 14px 外角 / 6px 内衬 / 8px 内层同心发丝卡片。 |
| **P4** | `ComposePlusMenu` (加号扩展菜单) | 菜单项仅为单行文字或缺少专属描述，部分主题下悬停色过深。 | 基于 `SmartExpandablePanel` 数据结构重构为 `MenuItem[]`，支持 24×24 图标槽位、标题+副文案双行布局，统一 6px 条目圆角与微灰悬停。 |
| **P5** | `ModelBadgePickerMenu` (模型级联选择) | 原级联浮层采用手动定位与延迟计时器，斜向移动易误关闭，列表过长缺乏内嵌滚动。 | 接入 `SafeAimEngine` 重心坐标碰撞算法与 `PositionEngine` 120Hz 视口防抖；一级服务商列表，二级模型列表支持 160px 独立内嵌滚动区与快速搜索过滤。 |
| **P6** | `TiptapSlashMenu` & `ComposerDirTree` | 光标锚点有时在滚动时产生位置偏移，目录树缺少层级图标与路径面包屑。 | 采用 `calculateSafeCursorAnchor` 四级几何备援 + 终极熔断防线；目录树支持 `@` / `@@` 唤起、工作区递归、上级目录跳转及 Mention 节点插入。 |
| **P7** | `MessageActionsBar` (消息元操作栏) | 用户消息与助手消息操作按钮尺寸未对齐（有的 22px 有的 24px），复制成功反馈不明显。 | 统一提取为 22×22px 微圆角图标按钮，复制成功触发翡翠绿 `<Check size={13} />` 并保持 1.5s 状态自愈，撤回与重试操作视觉轻量化。 |

---

## 3. 模型与思考档位胶囊（ComposerFusedTrigger）重构方案

### 3.1 物理结构与视觉几何解耦

当前 `ComposerFusedTrigger` 的问题在于外层 `.capsule` 设置了 `:hover`，同时内层 `ModelBadgePicker`（`.modelBadge`）与 `thinkBtn` 又各自带有 `:hover` 与 `:active`，导致样式叠加、边框被直角破坏。

```
旧方案（层叠污染与直角硬切）：
┌─────────────────────────────────────────────────────────────┐
│ .capsule:hover (产生全局青底)                                │
│  ┌───────────────────────┐ ⏐ ┌───────────────────────────┐  │
│  │ .modelBadge:hover     │ ⏐ │ .thinkBtn.isOpen          │  │
│  │ (直角硬切 / 颜色冲突)  │ ⏐ │ (青色/深色底二次叠加)     │  │
│  └───────────────────────┘ ⏐ └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

新方案（单层发丝容器 + 独立分段微圆角悬停）：
┌─────────────────────────────────────────────────────────────┐
│ .capsule: 1px 发丝边框 #e2dfd9, 高度 28px, 半圆 R=14px, 透明底 │
│  ┌───────────────────────┐ ⏐ ┌───────────────────────────┐  │
│  │ 左段：模型槽 (R=4px/6px)│ 1px│ 右段：思考档位 (R=4px/6px)  │  │
│  │ 独立悬停 4.5% 极浅暖灰  │发丝│ 独立悬停 4.5% 极浅暖灰    │  │
│  │ 无青底 / 无直角硬切    │线  │ 选中态 6.5% 微灰          │  │
│  └───────────────────────┘ ⏐ └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 样式规范（CSS Rules）

```css
/* apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css */

.capsule {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  height: 28px;
  padding: 0 2px;
  border: 1px solid var(--sep-border-color, #e2dfd9);
  border-radius: var(--sep-pill-radius, 9999px);
  background: transparent;
  box-shadow: none;
  min-width: 0;
  box-sizing: border-box;
  user-select: none;
  transition: border-color var(--transition-fast, 120ms ease);
}

.capsule:hover {
  /* 严禁外层整块加背景，仅微调边框颜色 */
  border-color: var(--sep-border-hover, #c9c5bc);
  background: transparent;
}

.capsule:focus-within {
  border-color: color-mix(
    in srgb,
    var(--sep-border-color, #e2dfd9) 94%,
    var(--text-primary) 6%
  );
}

.left {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  padding: 0 1px;
}

/* 穿透控制内嵌 ModelBadgePicker 按钮 */
.left :global(button.model-badge-btn),
.left :global(button[data-testid='model-selector-button']) {
  height: 24px;
  min-height: 24px;
  min-width: 0;
  max-width: 160px;
  padding: 0 6px;
  border: none;
  border-radius: var(--sep-btn-radius, 6px);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
}

.left :global(button.model-badge-btn:hover),
.left :global(button[data-testid='model-selector-button']:hover) {
  background: var(--sep-bg-item-hover, rgba(29, 28, 26, 0.045));
  color: var(--text-primary);
}

.left :global(button.model-badge-btn.active),
.left :global(button[data-testid='model-selector-button'][aria-expanded='true']) {
  background: var(--sep-bg-item-selected, rgba(29, 28, 26, 0.065));
  color: var(--text-primary);
}

.divider {
  width: 1px;
  height: 12px;
  margin: 0 2px;
  background: var(--sep-divider-color, rgba(29, 28, 26, 0.08));
  flex-shrink: 0;
}

.right {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 1px;
}

.thinkBtn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 6px;
  border: none;
  border-radius: var(--sep-btn-radius, 6px);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--font-size-xs, 12px);
  font-weight: 400;
  cursor: pointer;
  box-shadow: none;
  white-space: nowrap;
  box-sizing: border-box;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
}

.thinkBtn:hover {
  background: var(--sep-bg-item-hover, rgba(29, 28, 26, 0.045));
  color: var(--text-primary);
}

.thinkBtn.isOpen {
  background: var(--sep-bg-item-selected, rgba(29, 28, 26, 0.065));
  color: var(--text-primary);
  font-weight: 500;
}
```

---

## 4. 输入区操作按钮统一方案（24×24px 极简微圆角）

### 4.1 尺寸与对齐标准
将 `[ ＋ ]` 加号与 `[ 🛡️ ]` 权限盾牌按钮彻底统一为 **24×24px 极简微圆角图标按钮**：
- **物理包围盒**：`width: 24px; height: 24px; min-width: 24px;`
- **圆角规范**：`border-radius: var(--radius-md, 6px);`（与 SmartPanel 内部微按钮统一）
- **图标尺寸**：`14×14px`（`strokeWidth: 1.8`），完美居中；
- **底色规范**：默认完全透明（`background: transparent`），彻底消灭实心深灰或黑色底块；
- **悬停微动效**：悬停时淡入 `var(--sidebar-hover)` / `var(--sep-bg-item-hover)`，按压时为 `var(--sidebar-active)`。

```
┌─────────────────────────────────────────────────────────────┐
│  .actionLeft (gap: 4px; height: 28px; align-items: center)  │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │   [  ＋  ]   │  │   [  🛡️  ]   │   (24x24px, R=6px)      │
│  │  24 x 24 px  │  │  24 x 24 px  │   透明底，悬停 4.5% 柔和微灰│
│  └──────────────┘  └──────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 统一 CSS 规则

```css
/* apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css */

.actionLeft {
  grid-area: left-ctrl;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  position: relative;
  height: 28px;
}

/* ---- Unified 24x24 Plus Button ---- */
.plusBtn {
  background: transparent;
  border: none;
  cursor: pointer;
  width: 24px;
  height: 24px;
  min-width: 24px;
  max-width: 24px;
  padding: 0;
  border-radius: var(--radius-md, 6px);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-sizing: border-box;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
}

.plusBtn:hover {
  background: var(--sidebar-hover);
  color: var(--text-primary);
}

.plusBtn.isOpen,
.plusBtn.isOn {
  background: var(--sidebar-active);
  color: var(--text-primary);
}

.plusBtn svg {
  width: 14px;
  height: 14px;
  stroke-width: 1.8;
}

/* ---- Unified 24x24 Shield Button (.permPill.iconOnly) ---- */
.permSlot {
  grid-area: perm;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  height: 28px;
}
```

```css
/* apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css */

.permPill.iconOnly {
  width: 24px;
  height: 24px;
  min-width: 24px;
  max-width: 24px;
  padding: 0;
  border-radius: var(--radius-md, 6px);
  border: none;
  background: transparent; /* CRITICAL: 彻底消灭实心深色底 */
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
}

.permPill.iconOnly:hover {
  background: var(--sidebar-hover);
  color: var(--text-primary);
}

.permPill.iconOnly.isOpen,
.permPill.iconOnly:active {
  background: var(--sidebar-active);
  color: var(--text-primary);
}

.permPill.iconOnly svg {
  width: 14px;
  height: 14px;
  stroke-width: 1.8;
}
```

---

## 5. 权限模式面板（PermissionModeMenu）3 处违规彻底根除方案

### 5.1 违规根因与重构规范

```
违规 1：缺少专属语义图标与 11px 次级描述
  → 治理：为 ask / deep / plan / full 分配专属 Lucide 图标，并采用主标题 (13px) + 次级描述 (11px) 双行布局。

违规 2：条目圆角不规范、选中态黑勾与大灰块
  → 治理：条目圆角锁定为 6px（--radius-md），悬停 4.5% 微灰，选中 6.5% 微灰 + #059669 翡翠绿品牌对勾。

违规 3：浮层边框粗重、圆角不同心
  → 治理：外层 14px 外角 / 6px 内衬 / 8px 内层同心发丝卡片，1px #e2dfd9 实体边框 + 28px 毛玻璃。
```

### 5.2 四大权限模式语义与文案契约

```typescript
export interface PermissionModeOption {
  id: PermissionMode;
  label: string;
  sublabel: string;
  icon: React.ReactNode;
  hint: string;
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    id: 'ask',
    label: '需确认',
    sublabel: '改文件、执行前需手动批准',
    icon: <Lucide.ShieldCheck size={14} strokeWidth={1.8} />,
    hint: '常用安全默认',
  },
  {
    id: 'deep',
    label: '深入分析',
    sublabel: '只读分析与代码深入检索',
    icon: <Lucide.Search size={14} strokeWidth={1.8} />,
    hint: '偏沟通与代码检索',
  },
  {
    id: 'plan',
    label: '计划模式',
    sublabel: '生成执行方案，不修改项目',
    icon: <Lucide.Target size={14} strokeWidth={1.8} />,
    hint: '只出规划方案',
  },
  {
    id: 'full',
    label: '完全访问',
    sublabel: '读写自动执行，极危操作确认',
    icon: <Lucide.Zap size={14} strokeWidth={1.8} />,
    hint: '少打扰，高自主权',
  },
];
```

### 5.3 菜单浮层 DOM 结构与样式 Diff

```html
<!-- PermissionModeMenu 渲染 DOM 结构 -->
<div role="menu" class="permMenu" aria-label="权限模式切换">
  <button type="button" role="menuitem" class="permMenuItem isSelected">
    <span class="iconWrapper" aria-hidden="true">
      <svg class="lucide-shield-check" ... />
    </span>
    <div class="textCol">
      <span class="title">需确认</span>
      <span class="desc">改文件、执行前需手动批准</span>
    </div>
    <svg class="checkIcon" ... /> <!-- #059669 翡翠绿对勾 -->
  </button>
  ...
</div>
```

```css
/* apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css */

.permMenu {
  z-index: var(--z-dropdown-menu, 300);
  background: var(--sep-bg-panel, rgba(255, 254, 252, 0.96));
  backdrop-filter: blur(var(--sep-backdrop-blur, 28px)) saturate(160%);
  -webkit-backdrop-filter: blur(var(--sep-backdrop-blur, 28px)) saturate(160%);
  border: 1px solid var(--sep-border-color, #e2dfd9);
  border-radius: var(--sep-radius-outer, 14px);
  box-shadow: var(--sep-shadow);
  padding: var(--sep-padding, 6px);
  display: flex;
  flex-direction: column;
  gap: var(--sep-item-gap, 2px);
  min-width: 230px;
  max-width: 280px;
  box-sizing: border-box;
  color: var(--sep-text-primary, #1d1c1a);
  font-family: var(--sep-font-sans, var(--font-sans));
}

.permMenuItem {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-md, 6px); /* 锁定 6px 圆角 */
  border: none;
  background: transparent;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
  text-align: left;
}

.permMenuItem:hover {
  background: var(--sep-bg-item-hover, rgba(29, 28, 26, 0.045));
}

.permMenuItem.isSelected {
  background: var(--sep-bg-item-selected, rgba(29, 28, 26, 0.065));
}

.permMenuItem .iconWrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.permMenuItem.isSelected .iconWrapper {
  color: var(--brand-deep, #059669);
}

.permMenuItem .textCol {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.permMenuItem .title {
  font-size: var(--font-size-sm, 13px);
  font-weight: 500;
  line-height: 1.25;
  color: var(--text-primary);
}

.permMenuItem .desc {
  font-size: var(--font-size-xs, 11px);
  color: var(--sep-text-muted, #8b8780);
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.permMenuItem .checkIcon {
  color: var(--brand-deep, #059669); /* 翡翠绿品牌对勾 */
  flex-shrink: 0;
  margin-left: auto;
}
```

---

## 6. 核心组件数据驱动 Schema 与代码 Diff 规划

### 6.1 `ComposerFusedTrigger` 详细 Diff 规划

```diff
--- a/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.tsx
+++ b/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.tsx
@@ -87,7 +87,6 @@ export const ComposerFusedTrigger: React.FC<ComposerFusedTriggerProps> = ({
       className={styles.capsule}
       data-testid="composer-fused-trigger"
       data-catalog-tick={tick}
     >
       {children ? <div className={styles.left}>{children}</div> : null}
       {children ? <span className={styles.divider} aria-hidden /> : null}
@@ -102,7 +101,7 @@ export const ComposerFusedTrigger: React.FC<ComposerFusedTriggerProps> = ({
             ref={btnRef}
             type="button"
             className={`${styles.thinkBtn} ${open ? styles.isOpen : ''}`}
             aria-haspopup="menu"
             aria-expanded={open}
             aria-label={`思考档位：${currentLabel}`}
             data-testid="composer-thinking-trigger"
             onClick={() => toggleExclusiveMenu(open, setOpen, btnRef.current)}
           >
             <span>{currentLabel}</span>
           </button>
         </Tooltip>
```

### 6.2 `PermissionModeMenu` 详细 Diff 规划

```diff
--- a/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx
+++ b/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx
@@ -2,12 +2,12 @@ import React, { useCallback, useRef, useState } from 'react';
 import * as Lucide from 'lucide-react';
 import styles from './PermissionModeMenu.module.css';
 import { Menu, Tooltip } from '../ui';
 import { toggleExclusiveMenu } from '../ui/Menu';
 import {
   DESKTOP_PERMISSION_MODE_IDS,
   coercePermissionMode,
   permissionModeMeta,
   transitionPermissionMode,
   type PermissionMode,
 } from '../../api/permissionModes';

+const MODE_ICON_MAP: Record<PermissionMode, React.ReactNode> = {
+  ask: <Lucide.ShieldCheck size={14} strokeWidth={1.8} />,
+  deep: <Lucide.Search size={14} strokeWidth={1.8} />,
+  plan: <Lucide.Target size={14} strokeWidth={1.8} />,
+  full: <Lucide.Zap size={14} strokeWidth={1.8} />,
+};
+
+const MODE_SUBLABEL_MAP: Record<PermissionMode, string> = {
+  ask: '改文件、执行前需手动批准',
+  deep: '只读分析与代码深入检索',
+  plan: '生成执行方案，不修改项目',
+  full: '读写自动执行，极危操作确认',
+};

@@ -113,27 +132,32 @@ export const PermissionModeMenu: React.FC<Props> = ({
           renderItem={(opt) => {
             const itemMeta = permissionModeMeta(opt.id);
             const isSelected = opt.id === mode;
+            const icon = MODE_ICON_MAP[opt.id as PermissionMode] ?? <Lucide.Shield size={14} />;
+            const sublabel = MODE_SUBLABEL_MAP[opt.id as PermissionMode] ?? itemMeta.description;
             return (
               <Tooltip key={opt.id} content={itemMeta.matrixHint}>
                 <button
                   type="button"
                   className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
                   role="menuitem"
                   onClick={(e) => {
                     e.stopPropagation();
                     opt.onClick?.();
                   }}
                 >
+                  <span className={styles.iconWrapper} aria-hidden="true">
+                    {icon}
+                  </span>
+                  <div className={styles.textCol}>
+                    <span className={styles.title}>{itemMeta.label}</span>
+                    <span className={styles.desc}>{sublabel}</span>
+                  </div>
                   {isSelected ? (
                     <Lucide.Check
-                      size={12}
-                      style={{ marginLeft: 'auto', opacity: 0.8 }}
+                      size={13}
+                      className={styles.checkIcon}
                       aria-hidden="true"
                     />
                   ) : null}
                 </button>
               </Tooltip>
```

### 6.3 `ComposePlusMenu` 数据驱动 Schema 规划

```typescript
// apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx

import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './ComposePlusMenu.module.css';
import { openSettings } from '../../api/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';
import { Menu, Tooltip, type SelectOptionItem } from '../ui';

export interface ComposePlusMenuProps {
  open: boolean;
  onClose: () => void;
  onAddFiles: () => void;
  onInsertSkillSlash?: () => void;
  id?: string;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

export const ComposePlusMenu: React.FC<ComposePlusMenuProps> = ({
  open,
  onClose,
  onAddFiles,
  onInsertSkillSlash,
  restoreFocusRef,
}) => {
  const items: SelectOptionItem[] = [
    {
      id: 'file',
      label: '添加文件',
      hint: '图片、代码或文档',
      icon: <Lucide.Paperclip size={14} strokeWidth={1.8} />,
      onClick: () => {
        onAddFiles();
        onClose();
      },
    },
    {
      id: 'skill',
      label: '使用技能',
      hint: '键入 / 快速唤起技能',
      icon: <Lucide.Sparkles size={14} strokeWidth={1.8} />,
      onClick: () => {
        onInsertSkillSlash?.();
        onClose();
        queueMicrotask(() => restoreFocusRef?.current?.focus?.());
      },
    },
    {
      id: 'plugin',
      label: '插件扩展',
      hint: '管理已安装插件',
      icon: <Lucide.Puzzle size={14} strokeWidth={1.8} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'mcp',
      label: 'MCP 工具',
      hint: '服务与协议连接',
      icon: <Lucide.Cable size={14} strokeWidth={1.8} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'extensions',
      label: '扩展中心',
      hint: '发现与安装新工具',
      icon: <Lucide.Blocks size={14} strokeWidth={1.8} />,
      onClick: () => {
        onClose();
        openSettings('plugins');
      },
    },
    {
      id: 'schedule',
      label: '定时任务',
      hint: '计划执行与循环任务',
      icon: <Lucide.Clock size={14} strokeWidth={1.8} />,
      onClick: () => {
        onClose();
        emitUiEvent('open-scheduled');
      },
    },
  ];

  if (!open) return null;

  return (
    <Menu
      openState={{
        open,
        onOpenChange: (nextOpen) => {
          if (!nextOpen) onClose();
        },
      }}
      anchor={restoreFocusRef}
      options={items}
      position={{ align: 'start', side: 'top', sideOffset: 6 }}
      panel={{ contentClassName: `${styles.plusMenu} no-drag` }}
      renderItem={(item) => (
        <Tooltip key={item.id} content={item.hint || item.label}>
          <button
            type="button"
            className={styles.item}
            role="menuitem"
            aria-label={item.hint ? `${item.label}，${item.hint}` : item.label}
            onClick={(e) => {
              e.stopPropagation();
              item.onClick?.();
            }}
          >
            <span className={styles.icon} aria-hidden="true">
              {item.icon}
            </span>
            <div className={styles.textCol}>
              <span className={styles.title}>{item.label}</span>
              {item.hint && <span className={styles.desc}>{item.hint}</span>}
            </div>
          </button>
        </Tooltip>
      )}
    />
  );
};
```

### 6.4 `ModelBadgePickerMenu` 双级级联与 Safe-Aim 重构

```typescript
// apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx 核心架构

/**
 * 级联架构与 SafeAim 保护：
 * 1. 一级服务商列表：渲染 Provider 列表，右侧带 Chevron 图标；
 * 2. 二级模型列表：通过 calculateSubmenuPosition 自动判定 left/right 展开，挂载 Portal；
 * 3. SafeTriangleTracker: 捕获鼠标快速斜切进入子菜单轨迹，防止划过相邻 Provider 引起意外切换；
 * 4. 内嵌独立滚动区：针对模型数 > 6 的服务商，启用 160px-240px 独立弹性滚动区。
 */
```

### 6.5 `TiptapSlashMenu` 光标安全锚点与指令 Schema

```typescript
// apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.tsx 核心数据驱动

export interface SlashCommandItem {
  id?: string;
  title: string;
  description?: string;
  iconName?: string;
  category?: 'system' | 'skill' | 'action';
  action?: () => void;
}

/**
 * 物理包围盒安全探测（safeCursorAnchor）：
 * 1. 检测 rawRect 是否为物理可见有效矩形（isPhysicallyVisibleNonZeroRect）；
 * 2. 若光标处于视口外部或隐藏，自动计算编辑器 fallback 锚点；
 * 3. 终极熔断防线：全零 (0,0) 或负坐标绝不挂载 Popover.Portal，杜绝浮层闪烁到屏幕左上角。
 */
```

### 6.6 `ComposerDirTree` 工作区目录树导航

```typescript
// apps/crish-desktop/src/components/chat-composer/ComposerDirTree.tsx

/**
 * 核心交互：
 * 1. 响应 @@ 或 /file 唤起；
 * 2. 基于 workspaceFsApi.listDirectory(dir) 加载真实文件树；
 * 3. 支持 Backspace 返回上一级、Enter 钻取文件夹或插入文件 Mention；
 * 4. 样式继承 SmartPanel 14px/8px/6px 同心圆角与微灰悬停。
 */
```

### 6.7 `MessageActionsBar` 消息操作栏统一规范

```typescript
// apps/crish-desktop/src/components/chat-message-row/MessageActionsBar.tsx

/**
 * 助手消息与用户消息操作条：
 * - 统一 22x22px 按钮（.iconBtn），border-radius: 6px；
 * - 复制成功时：<Check size={13} /> 翡翠绿高亮，1.5s 后平滑恢复 <Copy size={13} />；
 * - 重新生成：<RefreshCw size={13} />；
 * - 撤回：<CornerUpLeft size={13} />，点击后清空/回退最新轮次；
 * - 钉选：<PinOff size={13} />，状态激活时 .isPinnedActive。
 */
```

### 6.8 `ChatComposer` 四层空间垂直堆叠装配

```typescript
// apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx 核心装配

<div className={styles.composerWrapper}>
  {/* Layer 1 + Layer 2: 浮动层 */}
  {hasFloatLayer && (
    <div className={styles.composerFloatZone}>
      {permissionBarNode || (permissionBarProps && <ComposerPermissionBar {...permissionBarProps} />)}
      {planProgressNode || (planProgressProps && <ComposerPlanProgressBar {...planProgressProps} />)}
    </div>
  )}

  {/* Layer 3 + Layer 4: 主卡片 */}
  <div className={styles.composerCard} data-multiline={isMultiline ? '1' : '0'}>
    <ComposerAttachmentBar attachments={attachments} onRemoveAttachment={handleRemoveAttachment} />

    <div className={styles.inputMainLayout}>
      {/* 左侧控制区：24x24 [ ＋ ] + 24x24 [ 🛡️ ] */}
      <div className={styles.actionLeft}>
        <Tooltip content="添加文件、技能、扩展…" disabled={showPlusMenu}>
          <Button
            ref={plusBtnRef}
            type="button"
            variant="ghost"
            className={`${styles.plusBtn} ${showPlusMenu ? styles.isOpen : ''}`}
            onClick={togglePlusMenu}
            icon={<Lucide.Plus size={14} />}
          />
        </Tooltip>
        <ComposePlusMenu ... />
      </div>

      {/* 中间输入区 */}
      <div className={styles.fieldSlot}>
        {renderInputField()}
      </div>

      {/* 权限盾牌 */}
      <div className={styles.permSlot}>
        <PermissionModeMenu iconOnly mode={permissionMode} onChange={onPermissionChange} />
      </div>

      {/* 右侧操作区：[ deepseek-v4 ▾ ⏐ 最深 ] + [ ⬆ ] */}
      <div className={styles.actionRight}>
        <ComposerFusedTrigger>{rightActions}</ComposerFusedTrigger>
        <ComposerSendControls appearance="circle" ... />
      </div>
    </div>
  </div>
</div>
```

---

## 7. 状态流转、WAI-ARIA 键盘无障碍与 IME 防误触机制

### 7.1 互斥浮层管理机制（Exclusive Popover Management）
所有输入区弹层（`ComposePlusMenu`、`PermissionModeMenu`、`ModelBadgePickerMenu`、`TiptapSlashMenu`）接入统一的 `toggleExclusiveMenu`：
1. 打开任何一个浮层时，自动通知并关闭相邻兄弟浮层；
2. 宿主点击物理触发器时，采用绝对状态置写，禁止 `setOpen(prev => !prev)` 与外部点击关闭事件竞态对打；
3. `LayerStack` 拓扑注册，外层点击事件穿透防护。

### 7.2 WAI-ARIA 键盘漫游全链
- `role="menu"` 与 `role="menuitem"` 严格匹配；
- `ArrowDown` / `ArrowUp` 循环漫游；`Home` / `End` 快速跳至首尾；
- `ArrowRight` 展开二级子菜单并自动聚焦首项；`ArrowLeft` / `Escape` 收起子菜单并恢复父级焦点；
- `aria-expanded` 与 `aria-haspopup` 状态随打开态同步注入 DOM。

### 7.3 CJK IME 组合输入态绝对放行守卫
在 `TiptapSlashMenu` 与 `ComposerDirTree` 的键盘拦截中，增加标准输入法守卫：
```typescript
if (
  event.isComposing ||
  (event as any).nativeEvent?.isComposing ||
  event.keyCode === 229 ||
  event.key === 'Process'
) {
  return false; // 放行中文拼音组合键，严禁截断输入法 Enter 确认
}
```

---

## 8. 单元测试与魔鬼用例（Devil Test Cases）验证矩阵

为确保重构后既有 800+ 单元测试零回归，制定以下专项测试与魔鬼用例矩阵：

| 编号 | 测试分类 | 验证断言与测试场景 | 覆盖文件 |
| :--- | :--- | :--- | :--- |
| **DEVIL-01** | 胶囊独立悬停与直角修复 | 模拟 hover 左侧模型槽与右侧思考档位，断言各自触发独立 class 与透明背景，外层容器不产生直角撕裂与青底叠色。 | `ComposerFusedTrigger.test.tsx` |
| **DEVIL-02** | 24×24 按钮统一尺寸 | 断言 `plusBtn` 与 `permPill.iconOnly` 渲染后的 `offsetWidth` 与 `offsetHeight` 严格为 24px，无实心深色背景。 | `ChatComposer.layout.test.tsx` |
| **DEVIL-03** | 权限模式 4 项语义与图标 | 渲染 `PermissionModeMenu`，断言 4 个选项均包含专属语义图标（Shield/Search/Target/Zap）、11px 次级描述与翡翠绿对勾。 | `PermissionModeMenu.test.tsx` |
| **DEVIL-04** | 浮层互斥与四击防抖 | 连续快速点击加号与权限盾牌，断言浮层状态始终单一互斥，无幽灵残留与控制台报错。 | `permAndModelExclusive.test.tsx` |
| **DEVIL-05** | 级联 Safe-Aim 轨迹保护 | 模拟鼠标从服务商条目斜向快速移动到二级子菜单，断言二级菜单保持开启，不被相邻项误关闭。 | `ModelBadgePickerMenu.test.tsx` |
| **DEVIL-06** | 光标零坐标熔断保护 | 传入 `(0,0,0,0)` 虚假 Rect，断言 `TiptapSlashMenu` 拒绝挂载 Portal，不闪烁到屏幕左上角。 | `TiptapSlashMenu.test.tsx` |

---

## 9. 四步走实施路线图与验收断言

### Step 1: 视觉基元与样式 Token 深度对齐
- 更新 `ComposerFusedTrigger.module.css`：单层发丝容器 + 独立 4px/6px 槽位圆角悬停；
- 更新 `ChatComposer.module.css`：统一 `plusBtn` 为 24×24px 极简微圆角；
- 更新 `PermissionModeMenu.module.css`：彻底消灭盾牌实心深色底，规范为 24×24px，重构 14px/6px/8px 浮层同心卡片。

### Step 2: 权限模式菜单（PermissionModeMenu）全量重构
- 补齐 `MODE_ICON_MAP`（`[ 🛡️ ]` `[ 🔍 ]` `[ 🎯 ]` `[ ⚡ ]`）与 `MODE_SUBLABEL_MAP`；
- 实施主标题 (13px) + 次级描述 (11px) 双行布局；
- 绑定 `#059669` 翡翠绿品牌细线对勾与 6.5% 微灰选中态。

### Step 3: 加号菜单、级联模型与目录树强化
- `ComposePlusMenu` 统一为双行图文 24×24 图标槽位；
- `ModelBadgePickerMenu` 接入 Safe-Aim 与 PositionEngine 120Hz 视口防抖；
- `TiptapSlashMenu` 与 `ComposerDirTree` 强化光标熔断与 IME 守卫。

### Step 4: 全量回归与类型检查
- 运行 `npm run typecheck` 验证全量类型通过；
- 运行 `npm run test` 与快层门禁验证 100% 绿灯；
- DevTools / CDP 9222 真实桌面环境核验视觉对齐。
