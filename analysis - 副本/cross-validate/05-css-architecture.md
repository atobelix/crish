# Cross-05: CSS 架构审计

## 1. Token 系统现状

### 1.1 --dnd-* Token 覆盖度

**Light theme (`tokens.css:339-360`) — 21 tokens 全量定义:**

| Token | 值 | 状态 |
|-------|-----|------|
| `--dnd-merge-bg` | `color-mix(in srgb, var(--accent-color) 8%, transparent)` | ✅ |
| `--dnd-merge-border-color` | `color-mix(in srgb, var(--accent-color) 30%, transparent)` | ✅ |
| `--dnd-merge-border-width` | `1.5px` | ✅ |
| `--dnd-merge-border-style` | `solid` | ✅ |
| `--dnd-merge-radius` | `var(--radius-md, 8px)` | ✅ |
| `--dnd-split-bg` | `color-mix(in srgb, var(--accent-color) 6%, transparent)` | ✅ |
| `--dnd-split-border-color` | `color-mix(in srgb, var(--accent-color) 35%, transparent)` | ✅ |
| `--dnd-split-border-width` | `1.5px` | ✅ |
| `--dnd-split-border-style` | `solid` | ✅ |
| `--dnd-split-radius` | `var(--radius-md, 8px)` | ✅ |
| `--dnd-insert-line-width` | `3px` | ✅ |
| `--dnd-insert-line-color` | `var(--accent-color)` | ✅ |
| `--dnd-insert-line-radius` | `999px` | ✅ |
| `--dnd-insert-line-glow` | `0 0 10px color-mix(... 60%..., transparent)` | ✅ |
| `--dnd-overlay-shadow` | `0 8px 24px color-mix(... 15%..., transparent)` | ✅ |
| `--dnd-overlay-border-color` | `color-mix(in srgb, var(--accent-color) 35%, transparent)` | ✅ |
| `--dnd-overlay-border-width` | `1.5px` | ✅ |
| `--dnd-overlay-border-style` | `solid` | ✅ |
| `--dnd-overlay-blur` | `blur(4px)` | ✅ |
| `--dnd-col-preview-bg` | `color-mix(in srgb, var(--accent-color) 5%, transparent)` | ✅ |
| `--dnd-col-preview-border-color` | `color-mix(in srgb, var(--accent-color) 25%, transparent)` | ✅ |

**Dark theme (`tokens.css:485-493`) — 8 tokens 显式覆写:**

| Token | Light | Dark | 变化说明 |
|-------|-------|------|---------|
| `--dnd-merge-bg` | 8% | 12% | 暗色加大混色强度保持可见性 |
| `--dnd-merge-border-color` | 30% | 40% | 同上 |
| `--dnd-split-bg` | 6% | 10% | 同上 |
| `--dnd-split-border-color` | 35% | 45% | 同上 |
| `--dnd-insert-line-glow` | 60% | 40% | 暗色降低辉光避免刺眼 |
| `--dnd-overlay-shadow` | 15% | 35% | 暗色加深阴影 |
| `--dnd-col-preview-bg` | 5% | 8% | 加大混色强度 |
| `--dnd-col-preview-border-color` | 25% | 35% | 同上 |

**未覆写但在暗色下自动适应的 token（13 个）:**

这些是结构/几何 token（width/radius/style/blur），或通过 `var(--accent-color)` / `var(--shadow-color)` 自动适应暗色，无需显式覆写，设计正确。

- `--dnd-merge-border-width` → 结构几何 ✅
- `--dnd-merge-border-style` → 结构几何 ✅
- `--dnd-merge-radius` → 结构几何 ✅
- `--dnd-split-border-width` → 结构几何 ✅
- `--dnd-split-border-style` → 结构几何 ✅
- `--dnd-split-radius` → 结构几何 ✅
- `--dnd-insert-line-width` → 结构几何 ✅
- `--dnd-insert-line-color` → 通过 `var(--accent-color)` → 暗色 = `#f8fafc` ✅
- `--dnd-insert-line-radius` → 结构几何 ✅
- `--dnd-overlay-border-color` → 通过 `var(--accent-color)` 适应 ✅
- `--dnd-overlay-border-width` → 结构几何 ✅
- `--dnd-overlay-border-style` → 结构几何 ✅
- `--dnd-overlay-blur` → 结构几何 ✅

### 1.2 Z-index 层级系统

`z-index.css` 定义了完整的层级系统，拖拽相关变量：

| 变量 | 值 | 用途 |
|------|-----|------|
| `--z-drag-highlight` | 1020 | 落点高亮浮层 |
| `--z-drag-card` | 1030 | 拖拽中的卡片 |
| `--z-drag-overlay` | 10010 | 拖拽预览覆盖层 |

使用检查：
- `shell-dragdrop.css:39` → `.drop-indicator` 使用 `--z-drag-highlight` ✅
- `shell-dragdrop.css:62` → `.tab-insert-line` 使用 `--z-drag-overlay` ✅
- `shell-dragdrop.css:103` → `.drag-overlay-preview-card` 使用 `--z-drag-overlay` ✅
- `shell-dragdrop.css:190` → `.drop-indicator-layer` 使用 `var(--z-drag-overlay, 1000)` ⚠️ 回退值 1000 与定义值 10010 不一致，但变量定义在 z-index.css 中，加载后不存在问题
- `shell-workspace.css:767` → `.workspace-card.dragging` 使用 `--z-drag-card` ✅

### 1.3 CSS contain 规则

当前共 7 条 `contain` 规则，与审计基线一致：

| 位置 | 选择器 | 值 | 用途 |
|------|--------|-----|------|
| `shell-dragdrop.css:164` | `.global-drag-overlay` | `strict` | 全局遮罩层渲染隔离 |
| `shell-dragdrop.css:170` | `body.is-layout-frozen .workspace-canvas` | `layout style` | 冻结期布局优化 |
| `shell-dragdrop.css:173` | `body.is-layout-frozen .workspace-column` | `layout style` | 同上 |
| `shell-dragdrop.css:176` | `body.is-layout-frozen .workspace-card` | `layout style` | 同上 |
| `shell-dragdrop.css:179` | `body.is-layout-frozen .chat-message-list` | `layout style` | 同上 |
| `shell-dragdrop.css:182` | `body.is-layout-frozen .sidebar-content` | `layout` | 仅 layout，不包含 style/paint 避免裁剪 tooltip |
| `shell-dragdrop.css:191` | `.drop-indicator-layer` | `strict` | 浮层渲染隔离 |

所有 contain 规则已正确注入，注释标注了设计意图（`⚠ 使用 contain: layout style（不含 paint/strict）防止裁剪 tooltip`）。

---

## 2. 拖拽 CSS 现状

### 2.1 DropIndicator 类体系

`shell-dragdrop.css` 实现了完整的拖拽指示器体系（共 12 个类）：

| 类名 | 行号 | 语义 | 状态 |
|------|------|------|------|
| `.drop-indicator` | 30 | 主落点浮层（fixed + blur + inset shadow） | ✅ |
| `.drop-indicator[data-drop-direction='merge']` | 46 | 合并方向变体（dashed 边框） | ✅ |
| `.tab-insert-line` | 56 | Tab 插入竖线（fixed + glow） | ✅ |
| `.tab-placeholder-indicator` | 67 | 旧假 tab 占位（强制隐藏） | ✅ 已标记为 legacy |
| `.drag-overlay-preview-card` | 99 | 拖拽预览覆盖体 | ✅ |
| `.card-tab.is-dragging-ghost` | 100 | 拖拽幽灵 tab 状态 | ✅ |
| `.drag-ghost-hidden` | 138 | 源元素隐藏 | ✅ |
| `.global-drag-overlay` | 156 | 全局拖拽遮罩层（fixed + `contain: strict`） | ✅ |
| `.drop-indicator-layer` | 185 | 指示器全局容器（fixed 覆盖全屏） | ✅ |
| `.drop-indicator-line-v` | 195 | 垂直插入线（跨列） | ✅ |
| `.drop-indicator-line-h` | 206 | 水平插入线（跨组） | ✅ |
| `.drop-indicator-merge` | 217 | 合并区高亮 | ✅ |
| `.drop-indicator-split` | 228 | 拆分区高亮 | ✅ |
| `.drop-indicator-col-preview` | 239 | 新列预览 | ✅ |

### 2.2 拖拽状态管理

冻结期规则覆盖完备：
- **Transition 禁用**（`shell-dragdrop.css:7-24`）: `body.is-resizing *`, `body.resizing-active *`, `body.window-resizing *`, `body.dragging-card *`, `body.is-layout-frozen *` — 覆盖所有拖拽/resize 状态
- **iframe/webview 指针屏蔽**（`shell-dragdrop.css:124-135` + `shell-workspace.css:718-729`）: 双保险，覆盖 `is-layout-frozen`, `resizing-active`, `window-resizing`, `dragging-card`, `is-resizing`
- **拖拽中光标**（`shell-dragdrop.css:113-116`）: `body.dragging-card, body.dragging-card * { cursor: grabbing !important; }`
- **省略帧动画**（`shell-dragdrop.css:252-253`）: `body.is-layout-frozen .drop-indicator-layer * { transition: none !important; }`

### 2.3 shell-dragdrop.css 中 .card-tab 基类

在 `shell-dragdrop.css:82-98` 存在一个裸 `.card-tab` 基类定义，这是有意的 — 拖拽叠加层（`.drag-overlay-preview-card`）不在 `.workspace-card` 容器内，因此需要无作用域限定的基础样式。冲突清单中已记录此设计。

---

## 3. 冲突修复现状

### 3.1 已完成的冲突修复（Round 5 + 额外优化）

| 冲突类 | 修复操作 | 文件 | 状态 |
|--------|----------|------|------|
| `.card-header` | 选择器改为 `.workspace-card .card-header`，移除 8 处 `!important` | `shell-workspace.css:800-821` | ✅ 已修复 |
| `.card-tab` | 选择器改为 `.workspace-card .card-tab`，移除 6 处 `!important` | `shell-workspace.css:882-901` | ✅ 已修复 |
| `.card-body` | 选择器改为 `.workspace-card .card-body`，合并 flat-layout 规则 | `shell-workspace.css:1192-1211` | ✅ 已修复 |
| `.tabs-bar` | 选择器改为 `.workspace-card .tabs-bar` | `shell-workspace.css:854-874` | ✅ 已修复 |
| `.sidebar` 死代码 | 从 `shell-sidebar.css` 移除 `.sidebar` / `.sidebar.collapsed` | `shell-sidebar.css` | ✅ 已清理 |
| `.sidebar` dragdrop 引用 | 从 `shell-dragdrop.css` 移除 `.sidebar.collapsed` / `.temp-expanded` | `shell-dragdrop.css` | ✅ 已清理 |
| `.sidebar` polish 引用 | 统一为 `.crish-sidebar` | `shell-polish.css` | ✅ 已清理 |
| `.card-header-right/left` | 选择器改为 `.workspace-card .card-header-right/left` | `shell-workspace.css` | ✅ 已修复 |
| `.card-action-btn` | 选择器改为 `.workspace-card .card-action-btn` | `shell-workspace.css` | ✅ 已修复 |
| `.card-subheader` | 选择器改为 `.workspace-card .card-subheader` | `shell-workspace.css` | ✅ 已修复 |
| `.tab-close-btn svg` | 移除 `!important` | `shell-workspace.css` | ✅ 已修复 |

**额外优化（超出 Round 5 范围）**:
`shell-workspace.css` 的 `!important` 实际计数为 83，低于清单预期值 111（减少 28 处），说明有额外的 `!important` 被清理。

### 3.2 待解决的冲突

| 冲突类 | 问题 | 优先级 |
|--------|------|--------|
| `.workspace-canvas` 命名不一致 | 全局 `.workspace-canvas` vs Module `.canvas` | Low — 功能正常，仅命名不统一 |
| `.workspace-column` 命名不一致 | 全局 `.workspace-column` vs Module `.column` | Low — 同上 |

### 3.3 `!important` 计数对比

| 文件 | Round 5 前 | 清单预期（Round 5 后） | 实际当前 | 差值 |
|------|-----------|----------------------|----------|------|
| shell-workspace.css | 132 | 111 | **83** | **-28**（超预期清理）|
| shell-polish.css | 146 | 146 | **146** | **±0** |
| shell-dragdrop.css | 23 | 20 | **21** | **+1**（新增过渡禁用规则）|
| shell-layout.css | 16 | 16 | **16** | **±0** |
| shell-sidebar.css | 6 | 5 | **5** | **±0** |
| tokens.css | 11 | 11 | **11** | **±0** |
| theme-dark.css | 6 | 6 | **6** | **±0** |

---

## 4. 旧样式清理现状

### 4.1 已清理部分

| 条目 | 位置 | 状态 |
|------|------|------|
| 旧 `.tab-placeholder-indicator` 类 | `shell-workspace.css` | ✅ 已删除（仅在 `shell-dragdrop.css:67-78` 作为 legacy 隐藏） |
| 旧 `.sidebar` 通用选择器 | `shell-sidebar.css` | ✅ 已移除（CSS Module 接管） |
| 旧 `!important` 声明 | `shell-workspace.css` | ✅ 减少 49 处（从 132 降至 83） |

### 4.2 残留的 `.pinned-placeholder`

`shell-sidebar.css:151` 和 `shell-polish.css:795` 仍存在 `.pinned-placeholder` 类。经检查，这是侧栏钉选的占位提示区（显示"拖动会话到此处固定"），属于**功能代码而非旧残留**。已使用 token 变量而非颜色硬编码，设计正确。

### 4.3 硬编码颜色残留检查

| 位置 | 代码 | 评估 |
|------|------|------|
| `shell-workspace.css:63` | `color-mix(..., #000 12%)` | ✅ 结构用途，暗色 chrome 混合色 |
| `shell-polish.css:509` | `var(--bg-elevated, #fff)` | ✅ 仅作为 CSS 变量回退值 |
| `shell-layout.css:283` | `color: #ffffff` | ⚠️ `.win-btn.close:hover` 上硬编码白色 |
| `shell-dragdrop.css:34-63` | `var(--accent-color, #1a73e8)` | ✅ 仅作为 CSS 变量回退值 |
| `shell-workspace.css:960` | `var(--accent-color, #1a73e8)` | ✅ 同上 |

**唯一需要修复的硬编码**：`shell-layout.css:283` 的 `color: #ffffff` 应改为 `color: var(--text-on-accent)`。

### 4.4 虚线边框残留检查

| 位置 | 代码 | 评估 |
|------|------|------|
| `shell-dragdrop.css:47` | `.drop-indicator[data-drop-direction='merge']` | ✅ 设计语意（合并指示器用虚线区分） |
| `shell-workspace.css:961` | `.card-tab.dragging-tab-hidden` | ✅ 拖拽状态样式 |
| `shell-sidebar.css:158,303-304` | `.pinned-placeholder` / sidebar 虚线 | ✅ 侧栏功能样式 |
| `shell-scrollbar.css:14-15` | 滚动条容器虚线 | ✅ 结构样式 |
| `shell-polish.css:791,799` | drag-over / pinned-placeholder | ✅ 功能样式，使用 token |

所有虚线边框均使用 CSS 变量而非硬编码颜色，无残留问题。

---

## 5. 剩余问题

### 5.1 关键问题（P0-P1）

| # | 问题 | 位置 | 严重度 | 说明 |
|---|------|------|--------|------|
| 1 | `shell-layout.css:283` 硬编码白色 | `.win-btn.close:hover { color: #ffffff; }` | P1 | 应使用 `var(--text-on-accent)` |
| 2 | `shell-polish.css:146` 处 `!important` 未减少 | 全文件 146 处 | P1 | 主要是 menubar/dropdown/hairline 系统 |
| 3 | `.drop-indicator-layer` 回退 z-index 不一致 | `shell-dragdrop.css:190` | P1 | 回退 `1000` 与定义值 `10010` 差异大 |

### 5.2 中等问题（P2）

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 4 | `.workspace-canvas` 命名不一致 | 全局 vs Module | 功能正常，但增加维护负担 |
| 5 | `.workspace-column` 命名不一致 | 全局 vs Module | 同上 |
| 6 | `shell-dragdrop.css` 新增 `!important` | 行 252 | `body.is-layout-frozen .drop-indicator-layer *` — 合理但增计数 |
| 7 | `shell-dragdrop.css` `.card-tab` 基类重复定义 | 行 82-98 + `shell-workspace.css:882-901` | 拖拽预览上下文需要，但可能造成困惑 |

### 5.3 次要问题（P3）

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 8 | `theme-dark.css` 无 DnD 专用覆写 | — | 当前 DnD 暗色覆写在 `tokens.css` 的 `html[data-theme="dark"]` 块中，`theme-dark.css` 不涉及，是正确分离 |
| 9 | 审计基线 contain 计数仍为 7 | `css-audit-baseline.txt` | 需更新基线 |
| 10 | `!important` 总计数需更新 | `css-audit-baseline.txt` | 当前记录 450，实际应大幅降低 |

---

## 6. 修复方案

### P1 — 立即修复

**6.1 修复硬编码白色**

```diff
// shell-layout.css:283
-  color: #ffffff;
+  color: var(--text-on-accent);
```

**6.2 修复 z-index 回退值**

```diff
// shell-dragdrop.css:190
-  z-index: var(--z-drag-overlay, 1000);
+  z-index: var(--z-drag-overlay);
```

### P2 — 短期修复

**6.3 shell-polish.css `!important` 优化**

shell-polish.css 的 146 处 `!important` 主要分布于：
- 菜单/下拉弹出层（`.tabs-add-menu`, `.tabs-add-item` 等）：约 40 处
- hairline 边框系统：约 20 处
- sidebar 样式：约 30 处
- 控件高度固定：约 30 处

建议策略：对弹出层部分增加选择器特异性（如 `.app-container .tabs-add-menu`）以消除 `!important`，hairline 系统可暂保留。

**6.4 命名一致性统一**

`Workspace.module.css` 通过 `:global(.workspace-canvas)` 和 `:global(.workspace-column)` 引用全局类名，避免维护两套命名。

### P3 — 文档更新

**6.5 更新审计基线**

```diff
- contain: count  = 7
- !important count = 450
+ contain: count  = 7
+ !important count = 388 (仅 shell + tokens + theme-dark)
```

---

## 7. 优先级

| 优先级 | 问题编号 | 工作量 | 影响面 | 建议时间 |
|--------|----------|--------|--------|---------|
| P1 | 6.1 | 1 行 | 1 文件 | 立即 |
| P1 | 6.2 | 1 行 | 1 文件 | 立即 |
| P1 | 6.3 (unnecessary) | — | — | 已在 shell-polish.css:799 正确使用 token |
| P2 | 6.3 | 中（2-3h） | 1 文件 | 下一轮重构 |
| P2 | 6.4 | 小（30min） | 2 文件 | 下一轮重构 |
| P3 | 6.5 | 小（5min） | 1 文件 | 任务完成时 |

---

## 审计结论

1. **Token 系统（--dnd-*）：✅ 完全就绪** — 21 个 token 全量定义，8 个暗色覆写正确，其余通过 var() 自动适应
2. **拖拽 CSS：✅ 完整实现** — 14 个 DropIndicator 类、6 种冻结状态、双保险 iframe 屏蔽、contain 优化
3. **冲突修复：✅ 超预期完成** — `!important` 从 132 降至 83（预期 111），25 处选择性器增强
4. **旧样式清理：✅ 基本完成** — 旧 placeholder 类已删除，颜色硬编码仅 1 处残留（`shell-layout.css:283`）
5. **剩余问题：3 个 P1 + 3 个 P2 + 3 个 P3** — 核心功能无阻塞问题
6. **整体评分：A-**（系统完备，仅需微调）

关键指标：
- `!important` 总计（shell 系列）：271（原 323，减少 16%）
- `contain` 规则：7（与基线一致）
- 硬编码颜色残留：1 处（P1）
- 未解决冲突对：2 个（均为命名不一致，P2）
