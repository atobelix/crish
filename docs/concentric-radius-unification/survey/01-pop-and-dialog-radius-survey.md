# 弹层与模态浮层同心圆角与边距现状统一调查报告

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **调查维度**：维度 01 — 全站弹层与模态浮层体系（Pop / Dialog / Modal / Flyout / Dropdown / Tooltip / Toast）  
> **勘察责任人**：架构自检团队 · Agent-01（弹层与模态浮层勘察员）  
> **报告基准日期**：2026-10-25  
> **基线对齐真理源**：[`SetupHintBanner.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SetupHintBanner.module.css#L2-L17)（`_chatSoftHint` 18px = 8px + 10px 同心标尺）  

---

## 一、 勘察背景与核心调查发现

### 1.1 调查背景与覆盖范围
在桌面端现代 UI 设计体系中，浮层（Floating Surfaces）、模态对话框（Modals / Dialogs）、弹出菜单（Dropdowns / Popovers）及气泡提示（Tooltips / Toasts）是层级最高、视觉焦点最集中的交互界面。根据战役调度指令，本报告针对 Conex / Crish 客户端内所有浮层及其内部嵌套容器的圆角（Border Radius）、内边距（Padding）以及几何嵌套关系进行全盘立体勘察。

勘察覆盖三大核心区域共计 **30+ 个模块文件**：
1. **通用模态基座体系**：[`Dialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css)、[`Dialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx)、[`ConfirmDialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ConfirmDialog/ConfirmDialog.tsx)；
2. **核心业务弹窗实现**：
   - 项目管理与新建：[`ProjectManageModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css)
   - MCP 扩展接入：[`McpConnectModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css)
   - 插件创建与分享：[`PluginCreateModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css)、[`PluginShareModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/PluginShareModal.module.css)
   - 插件设置导入：[`ImportPluginSettingsModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/ImportPluginSettingsModal.module.css)
   - 技能创建与详情：[`SkillCreateModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillCreateModal.module.css)、[`SkillDetailModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css)
   - 遥测对话框与初次向导：[`TelemetryDialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/TelemetryDialog.module.css)、[`FirstRunWizard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css)
   - 执行记录详情：[`RunDetailDialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/RunDetailDialog.module.css)
   - 会话导入与模型编辑：[`ExternalSessionImportModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css)、[`PriceConfigModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/PriceConfigModal.module.css)、[`ExtensionDetailModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/ExtensionDetailModal.module.css)、[`ScanResultsModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ScanResultsModal.module.css)、[`YamlConfigEditorModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css)、[`SkillEditorModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillEditorModal.module.css)
3. **非模态浮层 / 下拉 / 气泡 / Toast**：
   - 通用菜单基座：[`ui/Menu/Menu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css)
   - 选择器与下拉菜单：[`ui/Select/Select.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css)、[`SelectContent.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.module.css)、[`Combobox.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Combobox.module.css)
   - 工具气泡：[`ui/Tooltip/Tooltip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css)
   - 侧边栏与活动菜单：[`SidebarContextMenus.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css)
   - 智能面板体系：[`SmartExpandablePanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css)、[`SmartPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css)
   - 输入与项目选择菜单：[`ComposePlusMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css)、[`PermissionModeMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css)、[`TiptapSlashMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css)、[`ProjectPickerMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css)、[`ModelBadgePickerMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css)、[`SettingsQuickMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css)、[`FontSelectField.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.module.css)
   - 独立浮层：[`NewTabLauncherPopover.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.module.css)、[`FileAnnotationPopover.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileAnnotationPopover.module.css)
   - 消息提示 Toast：[`ToastStackModern.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStackModern.module.css)、[`DraftUndoToast.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/DraftUndoToast.module.css)

---

### 1.2 核心调查发现（Executive Summary）

通过全盘测量和数学公式校验，浮层体系在同心几何呈现出明显的“**局部极度精细、全局断层严重、Token 锁死割裂**”的现状：

#### 1. 积极发现（Positive Paradigms — 完美同心标杆）
全仓共有 **5 处典范设计**自发或显式遵循了同心几何数学标准 $R_{outer} = R_{inner} + Padding$：
- **`ui/Select`（尺寸档同心公式）**：在 [`Select.module.css:203-215`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L203-L215) 与 [`SelectContent.module.css:40-59`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.module.css#L40-L59) 中，显式标注了注释 `/* 尺寸档位（同心曲率：外圆角 = 内圆角 + 内边距） */`，并分别定义：
  - `size-sm`: 外圆角 $\text{calc}(8\text{px} + 4\text{px}) = 12\text{px}$，内距 $4\text{px}$，内选项 $8\text{px}$。$\Delta = 12 - (8 + 4) = 0$！
  - `size-md`: 外圆角 $\text{calc}(8\text{px} + 6\text{px}) = 14\text{px}$，内距 $6\text{px}$，内选项 $8\text{px}$。$\Delta = 14 - (8 + 6) = 0$！
  - `size-lg`: 外圆角 $\text{calc}(8\text{px} + 8\text{px}) = 16\text{px}$，内距 $8\text{px}$，内选项 $8\text{px}$。$\Delta = 16 - (8 + 8) = 0$！
- **`TiptapSlashMenu`（反向内圆角推导）**：在 [`TiptapSlashMenu.module.css:9-11`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L9-L11) 中，显式使用 CSS 变量代数推导：
  ```css
  --slash-pad: 6px;
  --slash-radius-outer: var(--radius-input); /* 20px */
  --slash-radius-inner: calc(var(--slash-radius-outer) - var(--slash-pad)); /* 14px */
  ```
  内元素严格继承 `--slash-radius-inner`，内外差值 $\Delta = 20 - (14 + 6) = 0$！
- **`FontSelectField`（字体下拉菜单）**：在 [`FontSelectField.module.css:83-85, 244`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.module.css#L83-L85)，外框 `--radius-xl`（12px），内距 `--space-1`（4px），内条目 `--radius-md`（8px）。$12\text{px} = 8\text{px} + 4\text{px}$，$\Delta = 0$ 完美闭合。
- **`SmartPanel`（级联二级子菜单）**：在 [`SmartPanel.module.css:352-382`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L352-L382)，代码注释显式标注 `/* Safe-Aim 级联二级子菜单 (Outer 8px -> Padding 4px -> Item 4px) */`，外框 $8\text{px}$，内距 $4\text{px}$，内条目 $4\text{px}$，$\Delta = 8 - (4 + 4) = 0$！
- **`ModelsSettingsTab`（自动补全建议菜单）**：在 [`ModelsSettingsTab.module.css:445-457`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L445-L457)，`.mrdAddSuggestMenu` 外框 $8\text{px}$，内距 $4\text{px}$，条目 $4\text{px}$，$\Delta = 0$。

#### 2. 全局系统性断层：Token 覆写与 Fallback 欺骗（Critical Systemic Defect）
在大量下拉浮层组件中，开发者在代码中写下了期望的同心圆角与回退值，例如：
```css
/* SmartExpandablePanel.module.css:12 */
border-radius: var(--sep-radius-outer, 14px);
/* ModelBadgePickerMenu.module.css:7 */
border-radius: var(--sep-radius-outer, 14px);
/* SmartPanel.module.css:195 注释 */
/* 槽位化菜单条目 (Outer 14px - Padding 6px = Item 8px) */
```
**设计意图**：外框 14px，内边距 6px，内选项 8px（$14 = 8 + 6$，完美同心）。  
**物理现实**：在全局基座 [`tokens.css:282, 1296`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L282)，统一锁定了：
```css
--sep-radius-outer: var(--radius-l); /* 12px */
--sep-item-radius: var(--radius-m);  /* 8px */
```
**致命断层**：因为 `:root` 中已明确定义了 `--sep-radius-outer` 为 12px，**CSS 引擎永远不会读取 fallback 14px**！这导致全站所有消费该 token 的下拉菜单（`ui/Menu`, `SidebarContextMenus`, `ComposePlusMenu`, `PermissionModeMenu`, `SmartExpandablePanel`, `ModelBadgePickerMenu`）的实际物理外圆角均被强制截断为 12px！  
其同心度计算恒为：
$$\Delta = R_{outer} - (R_{inner} + P) = 12\text{px} - (8\text{px} + 6\text{px}) = -2\text{px}$$
全仓下拉浮层体系存在系统性的 **-2px 几何外轮廓角部挤压（Visual Pinching / Crowding）**。

#### 3. 严重几何倒挂与同径同角病灶（Severe Anti-Patterns）
- **`ExternalSessionImportModal`（同径同角病灶）**：在 [`ExternalSessionImportModal.module.css:55, 65`](file:///c:/Software/conex/apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css#L55-L65)，容器 `.filterTabs` 与子选项 `.filterTab` **两者均声明为 `var(--radius-lg, 7px)`（实际解析为 8px）**，内边距仅 3px。内外圆角完全相同，内层拐角半径本应收缩至 $8 - 3 = 5\text{px}$，却依然为 8px，导致内选项角部在几何上强行“顶穿”外轮廓，$\Delta = -3\text{px}$。
- **`SettingsQuickMenu`（严重挤压倒挂）**：在 [`SettingsQuickMenu.module.css:52, 111`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css#L52-L111)，外菜单 `.sbQuickMenu` 为 `--radius-lg`（8px），内边距 6px，内部条目 `.sbQuickItem` 为 `--radius-md`（8px）。内外同为 8px，内距 6px，同心差值高达 **$\Delta = 8 - (8 + 6) = -6\text{px}$**！角部出现严重的窒息感。
- **`ProjectPickerMenu`（级联子菜单外突）**：在 [`ProjectPickerMenu.module.css:100, 11`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L100)，二级子菜单 `.cascadeSubmenu` 外框为 `--radius-lg`（8px），内距 4px，内部条目直接复用 `.item`（8px）。$\Delta = 8 - (8 + 4) = -4\text{px}$。
- **`ProjectManageModal`（列表容器内部嵌套失调）**：在 [`ProjectManageModal.module.css:104, 118`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L104-L118)，`.folderListCard` 外框 `--radius-lg`（8px），内距 6px，内部卡片 `.folderItem` 声明 `--radius-md`（8px），$\Delta = -6\text{px}$（若按 fallback 12px 算亦为 $\Delta = -2\text{px}$）。
- **`ToastStackModern`（各向异性内边距椭圆撕裂）**：在 [`ToastStackModern.module.css:89, 410`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStackModern.module.css#L89-L410)，Toast 外卡圆角 12px，内边距为各向异性的 `8px 14px`，内部按钮圆角 8px。垂直方向 $\Delta_y = 12 - (8 + 8) = -4\text{px}$，水平方向 $\Delta_x = 12 - (8 + 14) = -10\text{px}$！两轴同心严重失真。

---

## 二、 同心几何数学标尺与判定模型

### 2.1 同心圆角代数模型与判别准则

设外层容器外边界在拐角处的几何曲率半径为 $R_{outer}$，其拐角圆心为 $C_{outer}$；内层嵌套子元素的外边界拐角曲率半径为 $R_{inner}$，拐角圆心为 $C_{inner}$。  
设内外两层边框在法向方向（X轴水平与Y轴垂直）的几何间隙（即容器内边距 Padding + 边框宽度 Border）分别为 $P_x$ 和 $P_y$。

```
        ┌──────────────────────────────────────────────┐ ───
        │                                              │  ▲
        │    ┌────────────────────────────────────┐    │  │ Py (Vertical Pad)
        │    │                                    │    │  ▼
        │    │         Nested Inner Element       │    │ ───
        │    │         (Radius: R_inner)          │    │
        │    │                                    │    │
        │    └────────────────────────────────────┘    │
        │ ◄──►                                         │
        │   Px (Horizontal Pad)                        │
        └──────────────────────────────────────────────┘
        Outer Container (Radius: R_outer)
```

#### 1. 各向同性同心标尺（Isotropic Scale, $P_x = P_y = P$）
当容器四周为等距内边距时，内外圆弧要实现几何上处处法向等距平行，必须满足两圆心重合（$C_{outer} \equiv C_{inner}$），此时严格数学关系为：
$$R_{outer} = R_{inner} + P \iff R_{inner} = \max(0, R_{outer} - P)$$

定义**同心几何差值 $\Delta$**：
$$\Delta = R_{outer} - (R_{inner} + P)$$

- **$\Delta = 0$（完美同心 Balance）**：内外弧线曲率完全匹配，视觉过渡极其自然高级；
- **$\Delta > 0$（内角锐化 / 空隙膨胀）**：外圆内方或内角偏尖，内角法向间距大于平边间隙；若 $P \ge R_{outer}$，则内角曲率在几何上收敛为 0（直角直边）；
- **$\Delta < 0$（几何倒挂 / 边缘挤压 Pinching）**：外圆角不足以包容内角曲率加间距，角部法向间隙小于平边间隙，在角部形成肉眼可见的挤压感、甚至外突畸变。

#### 2. 各向异性同心标尺（Anisotropic Scale, $P_x \neq P_y$）
当容器设置了非均匀内衬（如 $P_y = 6\text{px}, P_x = 10\text{px}$）时，正圆圆角无法在两个正交轴上同时保持同心，同心差值分解为两个分量：
$$\Delta_x = R_{outer} - (R_{inner} + P_x)$$
$$\Delta_y = R_{outer} - (R_{inner} + P_y)$$
此时，若 $\Delta_x \neq \Delta_y$，圆角弧线会出现各向异性撕裂（Elliptical Tearing）。

---

### 2.2 全仓圆角 Token SSOT 映射与实测值对照表

在调查过程中，必须严格依赖 [`tokens.css:486-509`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L486-L509) 的权威定义，澄清历史别名与实际物理像素值的映射：

| Token 名称 | SSOT 源定义 | 物理像素值 | 契约场景与历史混淆说明 |
| :--- | :--- | :---: | :--- |
| `--radius-s` | 基座定义 | **4px** | 标签、徽标、微型按钮、行内代码 |
| `--radius-m` | 基座定义 | **8px** | 图标按钮、下拉菜单项、输入框、Tooltip |
| `--radius-l` | 基座定义 | **12px** | 卡片、面板、模态弹层、下拉面板 |
| `--radius-input` | 基座定义 | **20px** | 底部主输入框、用户气泡 |
| `--radius-pill` | 基座定义 | **9999px** | 胶囊按钮、Tooltip外壳、滚动滑块 |
| `--radius-btn` | 用户锁 U1 | **7px** | 文字按钮、分段控件（唯一 7px 特例） |
| `--radius-xs` | `var(--radius-s)` | **4px** | 4px 别名 |
| `--radius-sm` | `var(--radius-s)` | **4px** | 4px 别名 |
| `--radius-md` | `var(--radius-m)` | **8px** | 8px 别名 |
| **`--radius-lg`** | **`var(--radius-m)`** | **8px** | **【严重易错点】虽然名为 lg，但映射的是 m（8px）而非 12px！** 导致大量写了 `var(--radius-lg, 12px)` 的组件 fallback 被失效，实际只有 8px！ |
| `--radius-xl` | `var(--radius-l)` | **12px** | 12px 别名 |
| `--radius-2xl` | `var(--radius-l)` | **12px** | **【严重易错点】映射的是 l（12px）**，大量弹窗写 `var(--radius-2xl, 24px)` 时 fallback 24px 完全失效，实为 12px！ |
| `--sep-radius-outer` | `var(--radius-l)` | **12px** | 下拉菜单外框权威值（12px），导致组件内 `, 14px` fallback 彻底失效 |
| `--sep-item-radius` | `var(--radius-m)` | **8px** | 下拉菜单内项权威值（8px） |
| `--button-radius` | `var(--radius-btn)` | **7px** | 全局按钮权威值（7px） |

---

## 三、 通用模态与确认对话框基座体系勘察

### 3.1 通用模态基座（`ui/Dialog`）几何解析
- **文件位置**：[`Dialog.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css)、[`Dialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx)

```css
/* apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css */
.dialog {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-2xl); /* 12px */
}
.dialogHeader {
  padding: var(--space-4) var(--space-4) var(--space-2); /* 16px 16px 8px */
}
.dialogClose {
  width: var(--control-height-sm); /* 28px */
  height: var(--control-height-sm); /* 28px */
  border-radius: var(--radius-sm); /* 4px */
}
.dialogBody {
  padding: var(--space-1) var(--space-4); /* 4px 16px */
}
.dialogFooter {
  padding: var(--space-3) var(--space-4); /* 12px 16px */
}
```

#### 几何同心度推导：
1. **外框曲率**：$R_{outer} = \text{var(--radius-2xl)} = 12\text{px}$。
2. **右上角关闭按钮（.dialogClose）**：
   - 到弹窗顶边与右边的距离均为 $P = 16\text{px}$（`--space-4`）。
   - 关闭按钮圆角 $R_{inner} = \text{var(--radius-sm)} = 4\text{px}$。
   - 理论上，当外圆角 $R_{outer} = 12\text{px}$ 且内边距 $P = 16\text{px}$ 时：
     $$R_{concentric} = \max(0, R_{outer} - P) = \max(0, 12 - 16) = 0\text{px}$$
     由于内边距（16px）已经大于外圆角半径（12px），在几何同心意义上，内缩 16px 处的等距曲线已经是一条**完全平直的直角直边**。
   - 按钮本身使用 4px 微圆角作为可点击控件视觉软化是合理的，但在物理上并不属于“外壳弧度平行包络”的同心范畴。
3. **右下角操作按钮区（.dialogFooter）**：
   - 底部距离 $P_y = 12\text{px}$（`--space-3`），右侧距离 $P_x = 16\text{px}$（`--space-4`）。
   - 内部使用 `ui/Button`，圆角 $R_{inner} = \text{var(--button-radius)} = 7\text{px}$。
   - 垂直同心差值：$\Delta_y = 12 - (7 + 12) = -7\text{px}$。
   - 水平同心差值：$\Delta_x = 12 - (7 + 16) = -11\text{px}$。
   - 若要实现右下角按钮与弹窗外框同心，外框圆角需高达 $7 + 12 = 19\text{px}$（或 $7 + 16 = 23\text{px}$）；当前 12px 的外圆角在视觉上显得外框较为克制收敛。

---

### 3.2 确认对话框（`ui/ConfirmDialog`）与 Button 契约
- **文件位置**：[`ConfirmDialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/ConfirmDialog/ConfirmDialog.tsx)
- **结构分析**：`ConfirmDialog` 是 `Dialog` 的纯语义装配层，外层容器即为 `Dialog` 面板（$R_{outer} = 12\text{px}$），无独立的覆盖 CSS 样式。
- **内部元素**：
  - Footer 内渲染两个 `Button`（取消 / 确认），圆角严格锁定为 `--radius-btn`（7px，用户锁 U1）。
  - 内衬同样继承 `Dialog.module.css` 的 `padding: 12px 16px`。
  - 其几何特性与 `Dialog` 基座完全一致。

---

## 四、 核心业务模态弹窗全盘立体勘察

### 4.1 新建与项目管理模态：`ProjectManageModal`
- **代码位置**：[`ProjectManageModal.module.css:4-118`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L4-L118)、[`ProjectManageModal.tsx:180-184`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.tsx#L180-L184)
- **嵌套结构**：`.modalPanel`（弹窗外框） > `.modalBody` > `.folderPickerDropzone` / `.folderListCard` > `.folderItem` > `.folderRemoveBtn`

```css
/* apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css */
.modalPanel {
  border-radius: var(--radius-2xl, 24px); /* 实际解析为 12px，fallback 24px 失效 */
  padding: 0;
}
.modalBody {
  padding: var(--space-4, 16px) var(--space-5, 20px) var(--space-4, 16px);
}
.folderPickerDropzone {
  padding: var(--space-5, 20px) var(--space-4, 16px);
  border-radius: var(--radius-lg, 12px); /* 实际解析为 8px，fallback 12px 失效 */
}
.folderListCard {
  padding: var(--space-1_5, 6px);
  border-radius: var(--radius-lg, 12px); /* 实际解析为 8px */
}
.folderItem {
  padding: 6px 10px;
  border-radius: var(--radius-md, 8px); /* 8px */
}
.folderRemoveBtn {
  width: 22px; height: 22px;
  border-radius: var(--radius-xs, 4px); /* 4px */
}
```

#### 几何计算与病灶分析：
1. **外框与 Fallback 欺骗**：`.modalPanel` 声明 `var(--radius-2xl, 24px)`，开发者预期可能是 24px，但运行时因 `--radius-2xl = 12px`，外圆角实际仅为 12px。
2. **Dropzone 与外框**：外框 12px，`.modalBody` 水平内边距 20px。由于 $20\text{px} > 12\text{px}$，同心内圆角为 0。但 Dropzone 声明了 `--radius-lg, 12px`（实际为 8px）。
3. **列表卡片与条目严重倒挂（Critical Anti-Pattern）**：
   - 外层容器 `.folderListCard`：$R_{outer} = \text{var(--radius-lg)} = 8\text{px}$；
   - 内部边距：$P = \text{var(--space-1_5)} = 6\text{px}$；
   - 内层条目 `.folderItem`：$R_{inner} = \text{var(--radius-md)} = 8\text{px}$；
   - **同心度计算**：
     $$\Delta = R_{outer} - (R_{inner} + P) = 8 - (8 + 6) = -6\text{px}$$
   - **病灶表征**：外卡片圆角是 8px，内条目圆角也是 8px，内衬仅 6px。内部条目的圆角曲率在角部距离外边框仅剩下 $8 + 6 - 8 = 6\text{px}$ 的几何间隙，产生强烈的“内外同径外突感”（外框包不住内条目）。即使按照开发者预期的 fallback 12px 计算，$\Delta = 12 - (8 + 6) = -2\text{px}$，依然处于欠同心状态。

---

### 4.2 MCP 扩展接入模态：`McpConnectModal`
- **代码位置**：[`McpConnectModal.module.css:24-376`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css#L24-L376)、[`McpConnectModal.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/McpConnectModal.tsx)
- **嵌套结构**：`Dialog`（12px） > `.modalContainer`（pad 0 4px） > `.tabNav` > `.tabBtn`；以及 `.serverCard` > `.sourceBadge` / `.actionBtn`

```css
/* apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css */
.tabNav {
  padding: 4px;
  border-radius: var(--radius-lg, 9px); /* 实际解析为 8px，fallback 9px 失效 */
}
.tabBtn {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--button-radius, 7px); /* 7px */
}
.presetBar {
  padding: 10px 12px;
  border-radius: var(--radius-md, 8px); /* 8px */
}
.presetBtn {
  height: 26px;
  border-radius: var(--button-radius, 7px); /* 7px */
}
.serverCard {
  padding: 12px 14px;
  border-radius: var(--radius-lg, 9px); /* 实际 8px */
}
.sourceBadge {
  padding: 1px 6px;
  border-radius: 4px; /* 硬编码 4px */
}
```

#### 几何计算与病灶分析：
1. **`.tabNav` 分段导航与 `.tabBtn` 的同心挤压**：
   - 导航槽外圆角：$R_{outer} = \text{var(--radius-lg)} = 8\text{px}$（开发者写的 fallback 为 9px）；
   - 槽体内边距：$P = 4\text{px}$；
   - 按钮圆角：$R_{inner} = 7\text{px}$；
   - **同心度计算**：
     $$\Delta = 8 - (7 + 4) = -3\text{px} \quad (\text{按 9px 算则为 } 9 - 11 = -2\text{px})$$
   - 理论同心外圆角应为 $R_{outer} = 7 + 4 = 11\text{px}$。当前 8px 外圆角导致激活态的 Tab 按钮白色底色在拐角处出现明显的“挤压撞角”现象。
2. **`.serverCard` 与内部徽标/操作按钮**：
   - 卡片外框：8px，内边距：$12\text{px} \times 14\text{px}$；
   - 内部按钮：7px；垂直 $\Delta_y = 8 - (7 + 12) = -11\text{px}$。由于内边距大，外框圆角偏小，卡片外观偏硬。

---

### 4.3 插件创建与分享模态：`PluginCreateModal` & `PluginShareModal`
- **代码位置**：[`PluginCreateModal.module.css:9-226`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css#L9-L226)、[`PluginShareModal.module.css:9-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/PluginShareModal.module.css#L9-L65)

```css
/* apps/crish-desktop/src/components/extensions-surface/PluginCreateModal.module.css */
.modalPanel {
  border-radius: var(--radius-xl, 12px); /* 12px */
}
.modalPanel button {
  border-radius: var(--radius-md); /* 8px */
}
.modalBody {
  padding: var(--space-2, 8px) var(--space-4, 16px) var(--space-3, 12px);
}
.guideCard {
  border-radius: var(--radius-l, 10px); /* 实际解析为 12px，fallback 10px 失效 */
  padding: var(--space-3, 12px) var(--space-3_5, 14px);
}
.dropZone {
  border-radius: var(--radius-l, 10px); /* 12px */
  padding: var(--space-6, 24px) var(--space-4, 16px);
}
.previewCard {
  border-radius: var(--radius-l, 10px); /* 12px */
  padding: var(--space-3_5, 14px) var(--space-4, 16px);
}
.fileBadge {
  padding: 2px 8px;
  border-radius: var(--radius-sm, 4px); /* 4px */
}
.errorHint {
  border-radius: var(--radius-m, 6px); /* 实际 8px，fallback 6px 失效 */
  padding: var(--space-2, 8px) var(--space-3, 12px);
}
```

#### 几何计算与病灶分析：
1. **Fallback 污染与 Token 断层**：代码中多处出现 `var(--radius-l, 10px)` 与 `var(--radius-m, 6px)`。在 Design Token SSOT 中，`--radius-l` 恒等于 12px，`--radius-m` 恒等于 8px。开发者试图通过 fallback 改小圆角，但该 fallback 在运行时毫无作用。
2. **预览卡片 `.previewCard` 内部同心度**：
   - 外框：$R_{outer} = 12\text{px}$；
   - 内部边距：$P_y = 14\text{px}, P_x = 16\text{px}$；
   - 内部徽标 `.fileBadge`：$R_{inner} = 4\text{px}$；
   - 差值 $\Delta_y = 12 - (4 + 14) = -6\text{px}$。由于内边距大于 12px，徽标处于直边平视区。

---

### 4.4 插件导入设置模态：`ImportPluginSettingsModal`
- **代码位置**：[`ImportPluginSettingsModal.module.css:9-117`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/ImportPluginSettingsModal.module.css#L9-L117)

```css
.modalPanel { border-radius: var(--radius-xl, 12px); } /* 12px */
.modalBody { padding: var(--space-2, 8px) var(--space-4, 16px) var(--space-4, 16px); }
.settingCard {
  border-radius: var(--radius-l, 12px); /* 12px */
  padding: var(--space-3_5, 14px);
}
.cleanConfirmBox {
  padding: var(--space-2, 8px) var(--space-2_5, 10px);
  border-radius: var(--radius-m, 8px); /* 8px */
}
```
- **分析**：`.settingCard` 卡片圆角直接使用 12px（与弹窗外框同值），在具有 16px 水平边距的弹窗内部，形成了典型的“内外等圆角”视觉平行，但并非严格数学同心。内部确认框 `cleanConfirmBox`（8px）嵌套在 14px 内距中，$\Delta = 12 - (8 + 14) = -10\text{px}$。

---

### 4.5 技能创建与详情模态：`SkillCreateModal` & `SkillDetailModal`
- **代码位置**：[`SkillCreateModal.module.css:10-40`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillCreateModal.module.css#L10-L40)、[`SkillDetailModal.module.css:10-166`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/SkillDetailModal.module.css#L10-L166)

```css
/* SkillDetailModal.module.css */
.modalPanel { border-radius: var(--radius-xl, 12px); }
.metaHeader { padding: var(--space-4, 16px) var(--space-5, 20px); }
.iconBadge { border-radius: 8px; } /* 硬编码 8px */
.metaBadge { padding: 1px 6px; border-radius: var(--radius-s, 4px); }
.yamlMetaBar { padding: var(--space-2, 8px) var(--space-5, 20px); }
.yamlPill { padding: 2px 7px; border-radius: var(--radius-s, 4px); }
.markdownContainer { padding: var(--space-4, 16px) var(--space-5, 20px); }
.modalFooter { padding: var(--space-3, 12px) var(--space-5, 20px); }
```
- **分析**：模态外壳 12px，内部主要为通栏分段与卡片，内衬为大内边距（$16\text{px} \times 20\text{px}$）。内部徽标与药丸胶囊均为 4px/8px。

---

### 4.6 遥测对话框：`TelemetryDialog`
- **代码位置**：[`TelemetryDialog.module.css:6-27`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/TelemetryDialog.module.css#L6-L27)
- **分析**：基于标准 `Dialog`（12px）。每行数据 `.row` 为通栏上下 6px padding，右侧渲染状态徽标 `.badge`（圆角 `--radius-sm` = 4px，padding 2px 8px）。由于徽标位于行容器内部，且行容器为无边框直角矩形，不存在曲率对撞。

---

### 4.7 首次启动向导：`FirstRunWizard`
- **代码位置**：[`FirstRunWizard.module.css:6-213`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css#L6-L213)

```css
/* apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css */
.firstRunDialog {
  border-radius: var(--radius-xl); /* 12px */
}
.firstRunCard {
  /* 负边距击穿 Dialog 默认内边距 */
  margin: calc(var(--space-1) * -1) calc(var(--space-4) * -1); /* -4px -16px */
  padding: 16px 20px 14px;
}
.firstRunStepBadge {
  padding: 2px 8px;
  border-radius: var(--radius-md); /* 8px */
}
.firstRunChip {
  padding: 4px 10px;
  border-radius: var(--radius-md); /* 8px */
}
.firstRunSelect :global(.settings-select-trigger) {
  border-radius: var(--radius-xl); /* 12px */
}
.firstRunInput {
  border-radius: var(--radius-xl); /* 12px */
  padding: 9px 12px;
}
.firstRunError {
  border-radius: var(--radius-lg); /* 8px */
  padding: 8px 10px;
}
.firstRunProjectOk {
  padding: var(--space-3); /* 12px */
  border-radius: var(--radius-xl); /* 12px */
}
```

#### 几何计算与病灶分析：
1. **负边距击穿（Negative Margin Breakthrough）**：`.firstRunCard` 使用 `margin: -4px -16px` 抵消了 `Dialog.module.css` 中的 `padding: 4px 16px`，强行贴合弹窗外框。
2. **输入框与选择器大圆角挤压**：
   - 弹窗外框：$R_{outer} = 12\text{px}$；
   - 卡片内边距：水平 20px；
   - 内部输入框 `.firstRunInput` 与 `.firstRunSelect` 却使用了高达 **`--radius-xl`（12px）** 的圆角！
   - 内外同为 12px，造成弹窗内部表单控件比弹窗外框本身“还要更圆”的视觉错觉。

---

### 4.8 运行详情对话框：`RunDetailDialog`
- **代码位置**：[`RunDetailDialog.module.css:24-184`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/RunDetailDialog.module.css#L24-L184)

```css
/* apps/crish-desktop/src/components/settings/RunDetailDialog.module.css */
.metricCell {
  padding: var(--space-2_5) var(--space-3); /* 10px 12px */
  border-radius: var(--radius-lg); /* 8px */
}
.idCode {
  padding: 1px 4px;
  border-radius: var(--radius-xs); /* 4px */
}
.cardSection {
  padding: var(--space-3); /* 12px */
  border-radius: var(--radius-lg); /* 8px */
}
.errorCodeBlock {
  padding: var(--space-2_5) var(--space-3); /* 10px 12px */
  border-radius: var(--radius-md); /* 8px */
}
```

#### 几何计算与病灶分析：
1. **指标格子 `.metricCell` 嵌套 `.idCode`**：
   - 外格子：$R_{outer} = 8\text{px}$；
   - 内边距：$P_y = 10\text{px}, P_x = 12\text{px}$；
   - 内部代码块：$R_{inner} = 4\text{px}$；
   - $\Delta_y = 8 - (4 + 10) = -6\text{px}$。
2. **卡片段落 `.cardSection` 嵌套错误代码块 `.errorCodeBlock`（内外同角病灶）**：
   - 外层 `.cardSection`：$R_{outer} = \text{var(--radius-lg)} = 8\text{px}$；
   - 内边距：$P = 12\text{px}$；
   - 内部代码块 `.errorCodeBlock`：$R_{inner} = \text{var(--radius-md)} = 8\text{px}$；
   - **同心度计算**：
     $$\Delta = 8 - (8 + 12) = -12\text{px}$$
   - **病灶表征**：外卡片圆角 8px，内代码块圆角也是 8px，内外曲率相同，角部内外距离仅 $12\text{px}$，在视觉上内代码块四角显得极为肥大钝化，外卡片轮廓被反衬得十分僵硬。

---

### 4.9 外部会话导入模态：`ExternalSessionImportModal`
- **代码位置**：[`ExternalSessionImportModal.module.css:39-285`](file:///c:/Software/conex/apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css#L39-L285)

```css
/* apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css */
.filterTabs {
  padding: 3px;
  border-radius: var(--radius-lg, 7px); /* 实际解析为 8px，fallback 7px 失效 */
}
.filterTab {
  padding: 4px 10px;
  border-radius: var(--radius-lg, 7px); /* 实际解析为 8px */
}
.sessionCard {
  padding: var(--space-3, 12px);
  border-radius: var(--radius-lg, 7px); /* 8px */
}
.sourceBadge {
  padding: 1px 6px;
  border-radius: var(--radius-sm, 4px); /* 4px */
}
.settingsCard {
  border-radius: var(--radius-lg, 7px); /* 8px */
  padding: var(--space-3, 12px) var(--space-4, 16px);
}
```

#### 几何计算与病灶分析（全仓最典型的同径同角病灶）：
1. **`.filterTabs` 与 `.filterTab`（极端 Anti-Concentric Pinching）**：
   - 外部槽体：$R_{outer} = \text{var(--radius-lg)} = 8\text{px}$；
   - 内部内衬：$P = 3\text{px}$；
   - 内部活动 Tab：$R_{inner} = \text{var(--radius-lg)} = 8\text{px}$；
   - **同心度计算**：
     $$\Delta = R_{outer} - (R_{inner} + P) = 8 - (8 + 3) = -3\text{px}$$
   - **病灶表征**：内部激活的 Tab 按钮与外部槽体使用了**一模一样的圆角 Token**！由于槽体内衬仅有 3px，内部选项激活时的白色底块四角几乎贴到外框角上，内圆弧不仅没有向内收缩收紧，反而以同样的曲率扩张，角部视觉出现极其明显的“挤压外突”与“几何撕裂”。理论上，若外槽保持 8px，内边距 3px，则内 Tab 必须精确设为：
     $$R_{inner} = R_{outer} - P = 8 - 3 = 5\text{px}$$
     或外槽增大为 $8 + 3 = 11\text{px}$，才能消除此病灶。

---

### 4.10 扩展/模型/编辑器其他弹窗集锦
1. **`PriceConfigModal`**（[`PriceConfigModal.module.css:95, 136`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/PriceConfigModal.module.css#L95-L136)）：
   - 外基座 12px，表单输入框 8px（`padding: 0 10px`），标签 4px（`padding: 0 6px`）。
2. **`ExtensionDetailModal`**（[`ExtensionDetailModal.module.css:24, 78, 111, 146, 168`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/ExtensionDetailModal.module.css#L24-L168)）：
   - 头部卡片 8px；操作按钮 7px；`.featureCard` 12px（padding 12px）；`.detailMdCoverContent` 8px（padding 10px 12px）；`.infoItem` 8px（padding 8px 10px）。
3. **`ScanResultsModal`**（[`ScanResultsModal.module.css:32, 74`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ScanResultsModal.module.css#L32-L74)）：
   - 列表容器 8px（无边框），行条目 padding 8px 12px，复选框 4px。
4. **`YamlConfigEditorModal`**（[`YamlConfigEditorModal.module.css:40, 59, 418, 444`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css#L40-L444)）：
   - 下拉菜单 `.yamlDropdownMenu` 8px（padding 6px），菜单项 8px（$\Delta = -6\text{px}$ 同径病灶！）。
   - 底部报错栏 `.errorBanner` 8px（padding 4px 10px），报错标签 4px。
5. **`SkillEditorModal`**（[`SkillEditorModal.module.css:24, 59, 95`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillEditorModal.module.css#L24-L95)）：
   - 发现项与创建框特意声明为 `border-radius: 0`（平铺通栏），路径创建钮 7px。

---

## 五、 非模态浮层、下拉菜单与气泡立体勘察

### 5.1 通用菜单基座：`ui/Menu/Menu.module.css`
- **代码位置**：[`Menu.module.css:25-27, 138-139`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L25-L27)
- **样式声明**：
  ```css
  .menuContent {
    padding: 6px;
    border-radius: var(--sep-radius-outer); /* 12px */
    border: 1px solid var(--border-color);
  }
  .menuItem {
    padding: 8px 10px;
    border-radius: var(--sep-item-radius); /* 8px */
  }
  ```
- **几何同心度推导**：
  - 外框：$R_{outer} = \text{var(--sep-radius-outer)} = 12\text{px}$；
  - 内距：$P = 6\text{px}$；
  - 内选项：$R_{inner} = \text{var(--sep-item-radius)} = 8\text{px}$；
  - **同心差值计算**：
    $$\Delta = R_{outer} - (R_{inner} + P) = 12 - (8 + 6) = -2\text{px}$$
  - **系统级定性**：全仓所有基于通用 `Menu` 组件封装的浮层，外圆角均比严格同心（14px）小 2px。当鼠标悬停在首项或末项时，高亮背景的 8px 圆角与外边框之间呈现出轻微的视觉挤压（角部间距为 $12 - 8 = 4\text{px}$，小于平边的 6px 间隙）。

---

### 5.2 动态计算同心标杆：`ui/Select`（Select & SelectContent）
- **代码位置**：[`Select.module.css:203-215`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L203-L215)、[`SelectContent.module.css:40-59`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.module.css#L40-L59)

```css
/* apps/crish-desktop/src/components/ui/Select/Select.module.css */
.contentSm {
  border-radius: calc(var(--radius-m) + 4px); /* 8 + 4 = 12px */
  padding: 4px;
}
.contentMd {
  border-radius: calc(var(--radius-m) + 6px); /* 8 + 6 = 14px */
  padding: 6px;
}
.contentLg {
  border-radius: calc(var(--radius-m) + 8px); /* 8 + 8 = 16px */
  padding: 8px;
}
.item {
  border-radius: var(--sep-item-radius); /* 8px */
}
```

#### 几何同心度推导（全仓最具前瞻性的同心实现）：
- **小档（sm）**：$R_{outer} = 8 + 4 = 12\text{px}, P = 4\text{px}, R_{inner} = 8\text{px} \implies \Delta = 12 - (8 + 4) = 0$！
- **中档（md）**：$R_{outer} = 8 + 6 = 14\text{px}, P = 6\text{px}, R_{inner} = 8\text{px} \implies \Delta = 14 - (8 + 6) = 0$！
- **大档（lg）**：$R_{outer} = 8 + 8 = 16\text{px}, P = 8\text{px}, R_{inner} = 8\text{px} \implies \Delta = 16 - (8 + 8) = 0$！
- **结论**：`ui/Select` 是全仓首个采用 `calc(var(--radius-m) + Padding)` 代数公式动态生成外轮廓圆角的组件，**在三大尺寸档位下全部实现了 100% 绝对同心（$\Delta = 0$）**。

---

### 5.3 智能面板体系：`SmartExpandablePanel` & `SmartPanel`
- **代码位置**：[`SmartExpandablePanel.module.css:11-353`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css#L11-L353)、[`SmartPanel.module.css:39-382`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L39-L382)

```css
/* SmartPanel.module.css */
.panel {
  padding: 6px;
  border-radius: var(--sep-radius-outer, 14px); /* 实际解析为 12px */
}
/* 槽位化菜单条目 (Outer 14px - Padding 6px = Item 8px) */
.item {
  padding: 4px 8px;
  border-radius: var(--radius-m); /* 8px */
}
/* Safe-Aim 级联二级子菜单 (Outer 8px -> Padding 4px -> Item 4px) */
.cascadeSubmenu {
  border-radius: var(--radius-m); /* 8px */
  padding: 4px;
}
.cascadeSubmenu .item {
  border-radius: var(--radius-s); /* 4px */
  padding: 3px 6px;
}
```

#### 几何计算与断层对比：
1. **主面板的 Token 锁死悲剧**：
   - 开发者在注释中明确写明推导过程：`(Outer 14px - Padding 6px = Item 8px)`，并在 CSS 中设置了 fallback 14px。
   - 但因 `:root` 中 `--sep-radius-outer` 锁死为 12px，实际 $\Delta = 12 - (8 + 6) = -2\text{px}$。
2. **级联二级子菜单的完美闭合**：
   - 在 `SmartPanel` 的 `.cascadeSubmenu` 中，开发者未引用受污染的 token，而是直接声明 `var(--radius-m)`（8px），内边距 4px，内部项声明 `var(--radius-s)`（4px）。
   - **推导计算**：
     $$\Delta = 8\text{px} - (4\text{px} + 4\text{px}) = 0$$
   - 级联二级子菜单在此处达成了**完美同心（$\Delta = 0$）**！
   - 反观 `SmartExpandablePanel.module.css:332`，其二级子菜单依然写为 `var(--sep-radius-outer, 14px)` + 6px padding + 8px item，再次退化为 $\Delta = -2\text{px}$。

---

### 5.4 侧边栏上下文菜单与排序过滤浮层：`SidebarContextMenus`
- **代码位置**：[`SidebarContextMenus.module.css:4-236`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L4-L236)

```css
/* apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css */
.contextMenu {
  padding: var(--space-1_5); /* 6px */
  border-radius: var(--radius-2xl); /* 12px */
}
.contextMenuItem {
  padding: 6px 10px;
  border-radius: var(--radius-md); /* 8px */
}
.sortFilterMenu {
  padding: 6px;
  border-radius: var(--sep-radius-outer); /* 12px */
}
.sortFilterRow {
  padding: 4px 8px;
  border-radius: var(--radius-m); /* 8px */
}
.sortFilterFlyout {
  padding: 6px;
  border-radius: var(--sep-radius-outer); /* 12px */
}
.sortFilterOption {
  padding: 4px 8px;
  border-radius: var(--radius-m); /* 8px */
}
```
- **分析**：右键菜单（`.contextMenu`）、排序过滤一级菜单（`.sortFilterMenu`）与二级悬浮窗（`.sortFilterFlyout`），**三者无一例外全部为 $R_{outer} = 12\text{px}$、Padding = 6px、内部选项 = 8px**。全体系均为 $\Delta = -2\text{px}$ 的统一挤压状态。

---

### 5.5 反向减法同心标杆：`TiptapSlashMenu`
- **代码位置**：[`TiptapSlashMenu.module.css:9-115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L9-L115)

```css
/* apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css */
.popoverContent {
  --slash-pad: 6px;
  --slash-radius-outer: var(--radius-input); /* 20px */
  --slash-radius-inner: calc(var(--slash-radius-outer) - var(--slash-pad)); /* 14px */

  border-radius: var(--slash-radius-outer); /* 20px */
  padding: var(--slash-pad); /* 6px */
}
.item {
  border-radius: var(--slash-radius-inner); /* 14px */
}
```
- **推导计算**：
  $$R_{outer} = 20\text{px}, \quad P = 6\text{px}, \quad R_{inner} = 20 - 6 = 14\text{px}$$
  $$\Delta = 20 - (14 + 6) = 0$$
- **结论**：斜杠指令菜单采用了从外轮廓（对齐主输入框 20px 圆角）反向减去内边距计算内圆角的数学方法，形成了与主输入框呼应的优雅大圆角同心流线，**$\Delta = 0$ 完美闭合**。

---

### 5.6 快捷与操作浮层全景勘察

#### 1. `NewTabLauncherPopover`（新建标签页下拉）
- **位置**：[`NewTabLauncherPopover.module.css:20-125`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.module.css#L20-L125)
- **外框**：$R_{outer} = \text{var(--sep-radius-outer)} = 12\text{px}$，Padding = 6px；
- **内项**：`.newTabBtn`, `.actionItem`, `.projectItem` 均为 $\text{var(--sep-item-radius)} = 8\text{px}$；
- **同心度**：$\Delta = 12 - (8 + 6) = -2\text{px}$。

#### 2. `FileAnnotationPopover`（文件批注浮层）
- **位置**：[`FileAnnotationPopover.module.css:19-109`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileAnnotationPopover.module.css#L19-L109)
- **外框**：$R_{outer} = \text{var(--radius-l)} = 12\text{px}$；
- **内衬**：非对称 padding `6px 6px 6px 12px`；
- **内项**：操作按钮为正圆（`border-radius: 50%`）。左侧内衬偏大（12px），导致左端弧度与输入文本产生倾斜拉伸。

#### 3. `ProjectPickerMenu`（项目选择与级联二级菜单）
- **位置**：[`ProjectPickerMenu.module.css:11, 100-104`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L11-L104)
- **二级子菜单**：`.cascadeSubmenu` 外框为 `--radius-lg`（8px），内距 4px；
- **内项**：复用主项目的 `.item`，圆角为 `--radius-md`（8px）；
- **同心度**：$\Delta = 8 - (8 + 4) = -4\text{px}$（外角 8px，内角 8px，内距 4px，严重的角部外凸病灶）。

#### 4. `ComposePlusMenu` & `PermissionModeMenu`（输入区加号与权限菜单）
- **位置**：[`ComposePlusMenu.module.css:11-37`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css#L11-L37)、[`PermissionModeMenu.module.css:145-178`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css#L145-L178)
- **分析**：两者均声明为 `border-radius: var(--sep-radius-outer, 12px)`，内距 6px，内部条目 8px。同心差值均为 $\Delta = -2\text{px}$。

#### 5. `ModelBadgePickerMenu`（模型徽标切换菜单）
- **位置**：[`ModelBadgePickerMenu.module.css:7-242`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L7-L242)
- **外框**：`var(--sep-radius-outer, 14px)`（实际 12px），内距 6px，条目 8px（$\Delta = -2\text{px}$）；
- **思考滑动槽（.thinkingTrack vs .thinkingPill）**：
  - 滑动底槽 `.thinkingTrack`：`border-radius: var(--radius-m)`（8px），padding 2px；
  - 滑动胶囊 `.thinkingPill`：`border-radius: var(--radius-m)`（8px）；
  - **同心差值**：$\Delta = 8 - (8 + 2) = -2\text{px}$。底槽与滑块使用同一圆角，滑块在两端时圆角微凸。

---

### 5.7 极端同径挤压病灶：`SettingsQuickMenu`
- **代码位置**：[`SettingsQuickMenu.module.css:52-54, 110-111`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css#L52-L111)

```css
/* apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css */
.sbQuickMenu {
  border-radius: var(--radius-lg); /* 实际解析为 8px */
  padding: var(--space-1_5); /* 6px */
}
.sbQuickItem {
  padding: var(--space-1_5) var(--space-2_5); /* 6px 10px */
  border-radius: var(--radius-md); /* 8px */
}
```

#### 几何计算与病灶分析：
- **外框**：$R_{outer} = \text{var(--radius-lg)} = 8\text{px}$；
- **内边距**：$P = \text{var(--space-1_5)} = 6\text{px}$；
- **内项**：$R_{inner} = \text{var(--radius-md)} = 8\text{px}$；
- **同心度计算**：
  $$\Delta = R_{outer} - (R_{inner} + P) = 8 - (8 + 6) = -6\text{px}$$
- **严重性评估**：这是全仓下拉菜单中**差值最大、挤压感最强烈**的病灶。外框圆角仅仅 8px，内选项圆角也是 8px，且由于 6px 内边距的存在，外框角部半径甚至小于内选项加边距（$8 < 14$）。当悬停在第一项（“设置首页”）时，高亮背景的拐角直接顶在菜单外框上，产生极度突兀的视觉断裂感。

---

### 5.8 完美等距同心标杆：`FontSelectField`
- **代码位置**：[`FontSelectField.module.css:83-85, 243-244`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.module.css#L83-L244)

```css
/* apps/crish-desktop/src/components/settings/FontSelectField.module.css */
.settingsSelectMenu {
  border-radius: var(--radius-xl); /* 12px */
  padding: var(--space-1); /* 4px */
}
.settingsSelectItem {
  padding: 0 var(--space-2); /* 0 8px */
  border-radius: var(--radius-md); /* 8px */
}
```

#### 几何同心度推导：
- 外框曲率：$R_{outer} = \text{var(--radius-xl)} = 12\text{px}$；
- 容器内衬：$P = \text{var(--space-1)} = 4\text{px}$；
- 内部选项：$R_{inner} = \text{var(--radius-md)} = 8\text{px}$；
- **同心差值计算**：
  $$\Delta = R_{outer} - (R_{inner} + P) = 12 - (8 + 4) = 0$$
- **结论**：完全依靠标准 Design Token 变量的巧妙搭配（12px = 8px + 4px），**天然达成了 100% 绝对同心（$\Delta = 0$）**，弧线平行度极度舒适。

---

### 5.9 极值胶囊：`ui/Tooltip`
- **代码位置**：[`Tooltip.module.css:48-50, 64-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L48-L65)

```css
/* apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css */
.tooltipContent {
  border-radius: var(--radius-full); /* 9999px (Pill 胶囊) */
  padding: var(--space-1) var(--space-2_5); /* 4px 10px */
}
.tooltipKbd {
  padding: 0 var(--space-1); /* 0 4px */
  border-radius: var(--radius-xs); /* 4px */
}
```
- **几何表征**：外层采用极限胶囊圆角（9999px），高度约为 24px，其左右两端呈现半正圆曲率（半径约 12px）。内部若存在快捷键 `<kbd>` 元素，其圆角为 4px。由于 Tooltip 垂直内衬仅 4px，水平距离 10px，内部 Kbd 处于偏内侧，与外层两端的半圆弧线保持着良好的呼吸感，属于胶囊包裹小矩形的常规受控范式。

---

## 六、 Toast 浮层体系勘察

### 6.1 全局现代 Toast 栈：`ToastStackModern.module.css`
- **代码位置**：[`ToastStackModern.module.css:89-90, 403-451`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStackModern.module.css#L89-L451)

```css
/* apps/crish-desktop/src/components/overlay/ToastStackModern.module.css */
.toastCard {
  border-radius: var(--radius-xl); /* 12px */
  padding: 8px 14px;
}
.undoButton,
.actionButton {
  padding: 3px 10px;
  border-radius: var(--radius-md); /* 8px */
}
.closeButton {
  border-radius: 50%; /* 22x22px 正圆 */
}
```

#### 几何计算与各向异性撕裂：
- **外框曲率**：$R_{outer} = 12\text{px}$；
- **内边距**：垂直 $P_y = 8\text{px}$，水平 $P_x = 14\text{px}$；
- **内部按钮**：$R_{inner} = 8\text{px}$；
- **正交双轴差值计算**：
  $$\Delta_y = R_{outer} - (R_{inner} + P_y) = 12 - (8 + 8) = -4\text{px}$$
  $$\Delta_x = R_{outer} - (R_{inner} + P_x) = 12 - (8 + 14) = -10\text{px}$$
- **病灶表征**：
  1. 垂直轴向存在 -4px 的角部挤压；
  2. 水平内衬达到 14px，使得按钮距离右边缘较远，而外卡片 12px 的圆角在右侧弧度收得过急，与内部 8px 按钮的圆角曲率在法向上呈现出明显的各向异性椭圆撕裂。

---

### 6.2 输入框撤销浮层：`DraftUndoToast.module.css`
- **代码位置**：[`DraftUndoToast.module.css:18-21, 55-57, 86-88`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/DraftUndoToast.module.css#L18-L88)

```css
/* apps/crish-desktop/src/components/chat-composer/DraftUndoToast.module.css */
.undoToast {
  padding: 6px 8px 6px 12px;
  border-radius: var(--radius-xl); /* 12px */
}
.undoBtn {
  padding: 3px 8px;
  border-radius: var(--radius-btn); /* 7px */
}
.closeBtn {
  border-radius: var(--radius-md); /* 8px */
}
```

#### 几何同心度推导：
- **外框曲率**：$R_{outer} = 12\text{px}$；
- **垂直轴**：$P_y = 6\text{px}$。对于撤销按钮（7px）：$\Delta_y = 12 - (7 + 6) = -1\text{px}$；对于关闭按钮（8px）：$\Delta_y = 12 - (8 + 6) = -2\text{px}$；
- **水平轴右端（关闭按钮）**：右侧内衬 $P_x = 8\text{px}$，关闭按钮 $R_{inner} = 8\text{px}$：
  $$\Delta_x = 12 - (8 + 8) = -4\text{px}$$
- **病灶分析**：右端关闭按钮贴角紧促，8px 的圆角在 8px 边距下需要 16px 的外框才能平行包络，当前 12px 外框在右端呈现轻度挤压。

---

## 七、 全仓浮层同心几何现状全景总表（Master Matrix Table）

下表完整收录本次勘察覆盖的 **30+ 个典型浮层与子元素几何关系**，按 $\Delta$ 排序：

| 模块 / 组件分类 | 容器类名与代码位置 | 外圆角 $R_o$ | 内边距 $P$ (px) | 内层子元素与代码位置 | 内圆角 $R_i$ | 同心差值 $\Delta$ | 状态评级 | 几何物理表征 |
| :--- | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| **ui/Select (sm)** | `.contentSm` [`Select.module.css:204`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L204) | 12px | 4 | `.item` [`Select.module.css:225`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L225) | 8px | **0px** | 🟢 完美同心 | 显式公式 $12 = 8 + 4$，处处平行 |
| **ui/Select (md)** | `.contentMd` [`Select.module.css:209`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L209) | 14px | 6 | `.item` [`Select.module.css:225`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L225) | 8px | **0px** | 🟢 完美同心 | 显式公式 $14 = 8 + 6$，处处平行 |
| **ui/Select (lg)** | `.contentLg` [`Select.module.css:214`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L214) | 16px | 8 | `.item` [`Select.module.css:225`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L225) | 8px | **0px** | 🟢 完美同心 | 显式公式 $16 = 8 + 8$，处处平行 |
| **TiptapSlashMenu** | `.popoverContent` [`TiptapSlashMenu.module.css:25`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L25) | 20px | 6 | `.item` [`TiptapSlashMenu.module.css:115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L115) | 14px | **0px** | 🟢 完美同心 | 反向减法 $20 - 6 = 14$，大圆角流线 |
| **FontSelectField** | `.settingsSelectMenu` [`FontSelectField.module.css:83`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.module.css#L83) | 12px | 4 | `.settingsSelectItem` [`FontSelectField.module.css:244`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.module.css#L244) | 8px | **0px** | 🟢 完美同心 | Token巧搭 $12 = 8 + 4$，自然闭合 |
| **SmartPanel (子级)** | `.cascadeSubmenu` [`SmartPanel.module.css:359`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L359) | 8px | 4 | `.item` [`SmartPanel.module.css:380`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L380) | 4px | **0px** | 🟢 完美同心 | 显式注释 $8 = 4 + 4$，微型同心 |
| **ModelsTab 建议单** | `.mrdAddSuggestMenu` [`ModelsSettingsTab.module.css:445`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L445) | 8px | 4 | `.mrdAddSuggestItem` [`ModelsSettingsTab.module.css:457`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L457) | 4px | **0px** | 🟢 完美同心 | Token搭配 $8 = 4 + 4$ |
| **DraftUndoToast (撤销)** | `.undoToast` [`DraftUndoToast.module.css:21`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/DraftUndoToast.module.css#L21) | 12px | 6(y) | `.undoBtn` [`DraftUndoToast.module.css:57`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/DraftUndoToast.module.css#L57) | 7px | **-1px** | 🟡 轻微挤压 | $12 - (7 + 6) = -1$，几近同心 |
| **ModelsTab 级联选区** | `.cascadeFlyoutPortal` [`ModelsSettingsTab.module.css:605`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L605) | 12px | 6 | `.cascadeOption` [`ModelsSettingsTab.module.css:639`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L639) | 7px | **-1px** | 🟡 轻微挤压 | $12 - (7 + 6) = -1$ |
| **ui/Menu 通用菜单** | `.menuContent` [`Menu.module.css:26`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L26) | 12px | 6 | `.menuItem` [`Menu.module.css:139`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L139) | 8px | **-2px** | 🟠 普遍挤压 | Token锁定12px断层，期望14px |
| **SidebarContextMenus** | `.contextMenu` [`SidebarContextMenus.module.css:6`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L6) | 12px | 6 | `.contextMenuItem` [`SidebarContextMenus.module.css:59`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L59) | 8px | **-2px** | 🟠 普遍挤压 | $12 - (8 + 6) = -2$ |
| **Sidebar 过滤菜单** | `.sortFilterMenu` [`SidebarContextMenus.module.css:101`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L101) | 12px | 6 | `.sortFilterRow` [`SidebarContextMenus.module.css:137`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L137) | 8px | **-2px** | 🟠 普遍挤压 | $12 - (8 + 6) = -2$ |
| **NewTabLauncher** | `.popoverContent` [`NewTabLauncherPopover.module.css:23`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.module.css#L23) | 12px | 6 | `.newTabBtn` [`NewTabLauncherPopover.module.css:59`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/NewTabLauncherPopover.module.css#L59) | 8px | **-2px** | 🟠 普遍挤压 | $12 - (8 + 6) = -2$ |
| **ComposePlusMenu** | `.plusMenu` [`ComposePlusMenu.module.css:11`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css#L11) | 12px | 6 | `.item` [`ComposePlusMenu.module.css:37`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css#L37) | 8px | **-2px** | 🟠 普遍挤压 | $12 - (8 + 6) = -2$ |
| **PermissionModeMenu** | `.permMenu` [`PermissionModeMenu.module.css:145`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css#L145) | 12px | 6 | `.permMenuItem` [`PermissionModeMenu.module.css:178`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css#L178) | 8px | **-2px** | 🟠 普遍挤压 | $12 - (8 + 6) = -2$ |
| **SmartExpandablePanel** | `.panel` [`SmartExpandablePanel.module.css:12`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css#L12) | 12px | 6 | `.item` [`SmartExpandablePanel.module.css:193`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css#L193) | 8px | **-2px** | 🟠 普遍挤压 | fallback 14px 被 token 覆写失效 |
| **ModelBadgePicker** | `.mbMenu` [`ModelBadgePickerMenu.module.css:7`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L7) | 12px | 6 | `.modelItem` [`ModelBadgePickerMenu.module.css:136`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L136) | 8px | **-2px** | 🟠 普遍挤压 | fallback 14px 被 token 覆写失效 |
| **ModelBadge (思考槽)** | `.thinkingTrack` [`ModelBadgePickerMenu.module.css:229`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L229) | 8px | 2 | `.thinkingPill` [`ModelBadgePickerMenu.module.css:242`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L242) | 8px | **-2px** | 🟠 同角挤压 | 底槽 8px 嵌 滑块 8px，距 2px |
| **McpConnectModal** | `.tabNav` [`McpConnectModal.module.css:24`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css#L24) | 8px | 4 | `.tabBtn` [`McpConnectModal.module.css:42`](file:///c:/Software/conex/apps/crish-desktop/src/components/extensions-surface/McpConnectModal.module.css#L42) | 7px | **-3px** | 🔴 倒挂外突 | $8 - (7 + 4) = -3$，角部凸出 |
| **ExternalSessionImport** | `.filterTabs` [`ExternalSessionImportModal.module.css:55`](file:///c:/Software/conex/apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css#L55) | 8px | 3 | `.filterTab` [`ExternalSessionImportModal.module.css:65`](file:///c:/Software/conex/apps/crish-desktop/src/components/plugins/ExternalSessionImportModal.module.css#L65) | 8px | **-3px** | 🔴 严重同径 | 槽 8px 嵌 项 8px，距仅 3px |
| **ProjectPickerMenu(子)** | `.cascadeSubmenu` [`ProjectPickerMenu.module.css:100`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L100) | 8px | 4 | `.item` [`ProjectPickerMenu.module.css:11`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L11) | 8px | **-4px** | 🔴 严重同径 | 外 8px 嵌 项 8px，$\Delta = -4$ |
| **ToastStackModern** | `.toastCard` [`ToastStackModern.module.css:89`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStackModern.module.css#L89) | 12px | 8(y) 14(x) | `.undoButton` [`ToastStackModern.module.css:410`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStackModern.module.css#L410) | 8px | **-4px(y) / -10px(x)** | 🔴 椭圆撕裂 | 各向异性双轴内边距失衡 |
| **ProjectManageModal** | `.folderListCard` [`ProjectManageModal.module.css:104`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L104) | 8px | 6 | `.folderItem` [`ProjectManageModal.module.css:118`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L118) | 8px | **-6px** | 🔴 严重倒挂 | 外 8px 嵌 项 8px，$\Delta = -6$ |
| **SettingsQuickMenu** | `.sbQuickMenu` [`SettingsQuickMenu.module.css:52`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css#L52) | 8px | 6 | `.sbQuickItem` [`SettingsQuickMenu.module.css:111`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css#L111) | 8px | **-6px** | 🔴 极端挤压 | 差值高达 -6px，视觉严重窒息 |
| **RunDetailDialog** | `.cardSection` [`RunDetailDialog.module.css:129`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/RunDetailDialog.module.css#L129) | 8px | 12 | `.errorCodeBlock` [`RunDetailDialog.module.css:184`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/RunDetailDialog.module.css#L184) | 8px | **-12px** | 🔴 尺度钝化 | 外 8px 嵌 代码块 8px，内距 12px |
| **ui/Tooltip** | `.tooltipContent` [`Tooltip.module.css:49`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L49) | 9999px | 4(y) 10(x) | `.tooltipKbd` [`Tooltip.module.css:74`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L74) | 4px | 特殊受控 | 🟢 胶囊包裹 | 9999px 胶囊包络 4px 小矩形 |

---

## 八、 病灶分类学与全仓统一治理方案建议

### 8.1 浮层同心病灶分类学（Taxonomy of Anti-Patterns）

勘察表明，全仓浮层的几何断裂并非偶发，而是由于以下 **4 种结构性根因** 造成的：

```
                             浮层几何病灶根因分类
                                      │
         ┌───────────────────┬────────┴──────────┬───────────────────┐
         ▼                   ▼                   ▼                   ▼
   1. 同径同角外突     2. Token 覆写欺骗   3. 各向异性撕裂      4. 负边距击穿
  (Isomorphic Pinch) (Token Truncation)  (Anisotropic Tear)   (Margin Breach)
     R_o = R_i          fallback 失效       P_x ≠ P_y           破坏基座契约
```

1. **同径同角外突（Isomorphic Pinching, $R_{outer} = R_{inner}$）**：
   - **典型代表**：`ExternalSessionImportModal`（`.filterTabs` 8px vs `.filterTab` 8px）、`ProjectManageModal`（`.folderListCard` 8px vs `.folderItem` 8px）、`SettingsQuickMenu`（`.sbQuickMenu` 8px vs `.sbQuickItem` 8px）。
   - **成因**：开发者机械地为父容器和子元素应用了同一个 Token（如 `var(--radius-lg)` 或 `var(--radius-md)`），忽略了内边距的存在，导致内外半径一致，内角在视觉上外突。
2. **Token 覆写与 Fallback 欺骗（Token Truncation Overwrite）**：
   - **典型代表**：`SmartExpandablePanel`、`ModelBadgePickerMenu`、`ComposePlusMenu`。
   - **成因**：业务组件写下 `var(--sep-radius-outer, 14px)` 期望获得 14px 圆角（与 6px padding、8px item 形成完美同心 $14 = 8 + 6$）。但 `:root` 中已将 `--sep-radius-outer` 静态指向 `var(--radius-l)`（12px）。浏览器读取到全局变量后立即放弃 fallback，外轮廓被硬性削减 2px，造成全仓菜单系统性 $\Delta = -2\text{px}$。
3. **垫片各向异性椭圆撕裂（Anisotropic Padding Tearing, $P_x \neq P_y$）**：
   - **典型代表**：`ToastStackModern`（$P_y = 8\text{px}, P_x = 14\text{px}$）、`FileAnnotationPopover`（左 12px，其余 6px）。
   - **成因**：正圆圆角（Isotropic Circle Radius）无法适应扁平长条形卡片的水平宽垫片与垂直窄垫片，导致角部间隙在 X 轴与 Y 轴发生剧烈扭曲。
4. **负边距击穿基座契约（Negative Margin Breach）**：
   - **典型代表**：`FirstRunWizard`（`margin: -4px -16px`）。
   - **成因**：业务弹窗为了让自己的分段卡片通栏到边缘，使用负边距强行抵消基座 `Dialog.module.css` 的内衬，破坏了基座的 padding 隔离，导致内容元素的大圆角（12px）直接与弹窗外框（12px）贴身撞击。

---

### 8.2 全仓弹层同心化重构与架构治理建议

为彻底根除上述断层，建议后续治理波次采取以下 **三层收敛策略**：

#### 策略 1：解耦与修正 `:root` 浮层 Token（消除 Token 覆写欺骗）
针对全站通用的下拉菜单与浮层，在 `tokens.css` 中明确确立**同心专属 Token 阶梯**，彻底修复 12px 截断病灶：
```css
/* 建议新增或修正 tokens.css */
--menu-radius-inner: var(--radius-m); /* 8px 菜单项选项圆角 */
--menu-pad: 6px;                      /* 6px 菜单标准内边距 */
/* 核心数学真理：8px + 6px = 14px，废止 12px 截断 */
--menu-radius-outer: calc(var(--menu-radius-inner) + var(--menu-pad)); /* 14px */
--sep-radius-outer: var(--menu-radius-outer); /* 重定向为 14px，实现全仓 10+ 菜单瞬时同心！ */
```
**预期收益**：无需逐个修改业务文件，只需在 `tokens.css` 中将 `--sep-radius-outer` 由 12px 改为 14px，即可**一次性无损修复**全仓 `ui/Menu`, `SidebarContextMenus`, `ComposePlusMenu`, `PermissionModeMenu`, `SmartExpandablePanel`, `ModelBadgePickerMenu` 等 10 余个浮层组件的 $\Delta = -2\text{px}$ 挤压病灶！

#### 策略 2：推广 `calc()` 原生同心标尺（对齐 `ui/Select` 与 `SetupHintBanner`）
在所有自定义分段槽体（Tabs / Toggle Bars）与卡片容器中，杜绝父子直接复用同一 Token 的偷懒写法。强制推行代数关系：
- **容器驱动子元素**：$R_{inner} = \text{calc}(R_{outer} - P)$（如 `TiptapSlashMenu` 范式）；
- **子元素驱动容器**：$R_{outer} = \text{calc}(R_{inner} + P)$（如 `SetupHintBanner` 与 `ui/Select` 范式）。
- 立即修复 `ExternalSessionImportModal`：
  ```css
  /* 修复方案 */
  .filterTabs {
    padding: 3px;
    border-radius: calc(var(--button-radius, 7px) + 3px); /* 10px */
  }
  .filterTab {
    border-radius: var(--button-radius, 7px); /* 7px */
  }
  ```
- 立即修复 `SettingsQuickMenu`：
  ```css
  /* 修复方案 */
  .sbQuickMenu {
    padding: var(--space-1_5); /* 6px */
    border-radius: calc(var(--radius-md) + var(--space-1_5)); /* 8 + 6 = 14px */
  }
  .sbQuickItem {
    border-radius: var(--radius-md); /* 8px */
  }
  ```

#### 策略 3：Dialog 模态基座的分层隔离与尺寸档扩展
- 对需要自身承担内部通栏卡片的业务弹窗，允许在 `Dialog` 的 `classNames.body` 中注入 `padding: 0`，并在业务层声明独立的 padding 契约，避免使用脆弱的 `margin: -4px -16px` 暴力击穿；
- 弹窗外框圆角当前锁定为 `--radius-2xl`（12px）。对于大号弹窗（如 `dialogXl` 800px、`dialog2xl` 1040px），12px 外圆角在大视窗下稍显僵硬，可评估引入 `var(--dialog-radius, 16px)`，使大弹窗内的大内距（20px/24px）与按钮（7px）能够获得更充足的法向缓冲空间。
