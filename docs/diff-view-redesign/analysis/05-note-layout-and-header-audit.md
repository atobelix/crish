# 笔记面板整体布局重塑与 32px 紧凑顶栏标准化审计报告 (AUDIT-05)

> **战役名称**：差异面板与笔记面板系统性重构
> **阶段与编号**：阶段一：前置代码现场深度审计 / AUDIT-05
> **审计主题**：笔记面板整体布局重塑与 32px 紧凑顶栏标准化深度审计
> **落盘路径**：[`docs/diff-view-redesign/analysis/05-note-layout-and-header-audit.md`](file:///c:/Software/conex/docs/diff-view-redesign/analysis/05-note-layout-and-header-audit.md)
> **核心勘察对象**：
> - [`NotePaperStrictPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx)（严格笔记面板装配容器与根布局）
> - [`NotePaperStrictHeader.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx)（现存笔记顶栏实现与内部徽章堆砌处）
> - [`NotePaperStrictBody.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictBody.tsx)（笔记主编辑视口与内容挂载槽）
> - [`NotePaperStrictChromeSlot.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictChromeSlot.tsx)（分槽挂载与浮层编排）
> - [`NotePaperPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css)（笔记面板样式体系与非标几何尺寸）
> - 对标参考标准：[`DiffHeaderControls.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx)、[`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)、[`FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css)

---

## 摘要与用户诉求还原（严禁打折）

在对真实运行界面的比对中，用户针对笔记面板提出了严肃而切中要害的批评：

> “笔记界面一起哈。笔记的顶部功能栏我看也没有。这个界面的整体布局我看和其他的标签界面也不一样，需要你系统性来分析一下才行。当然不只是布局了，这个界面现在基本上没有好用的功能呢还。先优化界面吧，这个笔记界面还是有些问题...了解清楚了，这个也一起加进去。”

通过对源码的逐行精读，现场暴露出三大不可容忍的严重结构性缺陷：

1. **容器布局严重割裂（格格不入的“孤岛悬浮卡片”）**：
   与系统内标准标签面板（如 `DiffCard`、`FilesCard`、`TerminalCard`）完全贯通视口、无外边框、无多余阴影的现代 IDE 风格不同，`NotePaperStrictPanel` 竟然自带 `border-radius: 8px`、`box-shadow: var(--shadow-sm)` 以及独立的 `1px` 边框，在分屏窗格（`TreeLeafPanel`）内呈现为一个内缩悬浮的脱节小卡片；同时底栏强制附着了一条占位的脱水调试 Footer（`surface=note-paper · W5-B/strict`），白白侵占垂直空间。
2. **顶栏沦为研发调试垃圾场（侮辱最终用户产品体验）**：
   现存顶栏充斥着 `@crish/block-paper/w5b-strict`、`rev=4`、`139 块`、`slash=writable` 等纯属底层引擎开发者用来排查 CRDT 投影的脱水标记，所有操作按钮（“刷新”、“/”、“关闭”）均用灰色胶囊药丸（`pill chip`）样式粗糙实现，完全背离了系统统一的 32px 紧凑工具栏标准。
3. **真实用户级生产力功能彻底缺失**：
   缺乏笔记标题的行内编辑/重命名、缺乏真实字数与排版字符统计、缺乏持久化保存状态指示（“已保存”/“同步中”）、缺乏全文 Markdown 复制、缺乏文件导出以及标准二次确认清空等现代笔记应有的原子级生产力功能。

---

## 零、四段式审计规范矩阵

严格执行通用协作纪律与战役执行标准：

### 1. 【做什么（To-Do）】
- **全面解构布局树**：深度梳理 `TreeLeafPanel` -> `NoteLeafHost` -> `NotePaperStrictPanel` -> `NotePaperStrictBody` 的整个高度传递与 overflow 伸缩体系，根除导致卡片悬浮与视口截断的样式缺陷。
- **重塑 32px 紧凑标准顶栏（Compact 32px Header）**：
  - **几何规范**：严格锁定 `height: 32px; min-height: 32px; max-height: 32px; padding: 0 8px; box-sizing: border-box; flex-shrink: 0;`。
  - **左侧功能区**：标准笔记图标（`<FileText size={14} />`）+ 行内可编辑标题（`EditableTitle` / `<Input size="sm" variant="ghost" />`）+ 柔和保存状态徽标（已保存 / 同步中）。
  - **右侧功能区**：数字等宽字体字数统计（`tabular-nums`）+ 复制全文 Markdown + 导出 `.md` 文件 + 刷新投影 + 危险清空（带 `ConfirmDialog`）+ 关闭面板（基于标准 `@/components/ui/IconButton`）。
- **建立 100% 弹性视口主编辑区**：确保主视口在任何分屏与小窗下均贴合容器边缘，统一滚动权属，彻底杜绝双滚动条。

### 2. 【不做什么（Not-To-Do）】
- **严禁 Git 破坏性指令**：严禁执行 `git commit`、`git reset`、`git checkout` 或 `git restore`；改动留在工作区供主控统一验收。
- **严禁残留任何调试标记**：顶栏严禁遗留任何 `W5-B`、`strict`、`rev=`、`slash=` 等内部排查标签；此类信息如确需观测，只能受控收纳于内部开发者设置或控制台输出。
- **严禁硬编码色值与非标尺寸**：禁止使用 `#ffffff`、裸写十六进制颜色及魔术数字；所有色值、字号、间距、圆角 100% 接入 Design Token 体系。

### 3. 【旧路径清单（Legacy Path Inventory）】
- [`NotePaperStrictHeader.tsx:51-56`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx#L51-L56)：`W5B_STRICT_PACKAGE_ID/W5B_STRICT_TRACK` 调试徽章节点。
- [`NotePaperStrictHeader.tsx:57-59`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx#L57-L59)：`rev={resolvedRev}` 内部版本号徽章节点。
- [`NotePaperStrictHeader.tsx:60-62`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx#L60-L62)：`{blockCount} 块` 原始块计数节点。
- [`NotePaperStrictHeader.tsx:63-71`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx#L63-L71)：`slash={slashWriteMode}` 模式提示徽章节点。
- [`NotePaperStrictHeader.tsx:72-116`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx#L72-L116)：胶囊药丸样式的伪按钮组件组。
- [`NotePaperStrictPanel.tsx:83`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx#L83)：硬编码开发标题 `'笔记纸面（W5-B Strict · hydrate 投影）'`。
- [`NotePaperStrictPanel.tsx:263-266`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx#L263-L266)：占位调试 Footer `<footer className={styles.footer}>`。
- [`NotePaperPanel.module.css:23-27`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L23-L27)：外层 `.panel` 的 `border-radius: 8px`、`border: 1px` 及 `box-shadow`。
- [`NotePaperPanel.module.css:53`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L53)：`.header` 非标高度 `min-height: 36px`。
- [`NotePaperPanel.module.css:84-155`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L84-L155)：私有徽章类名 `.badge`、`button.badge`、`.badgeSilent`。

### 4. 【自检删除面（Self-Inspection Deletion Surface）】
- 物理拔除 `NotePaperStrictHeader.tsx` 内 4 个技术调试标签节点与 3 个 pill 按钮节点（净消减约 65 行 JSX）。
- 物理删除 `NotePaperStrictPanel.tsx` 内调试 Footer 节点（删除第 263-266 行）。
- 物理清理 `NotePaperPanel.module.css` 中相关的死样式选择器（如 `.badgeSilent`、`button.badge:hover`、`.footer` 等，预计净消减约 80 行 CSS）。
- 保持 `data-testid` 契约平滑迁移，确保上层单测安全无崩塌。

---

## 1. 笔记面板现有布局失范与调试信息膨胀现状（文件:行号）

### 1.1 容器布局失范：格格不入的孤岛卡片与空间浪费

通过勘察 [`NotePaperPanel.module.css:15-38`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L15-L38)，`.panel` 容器的样式定义完全背离了现代分屏 IDE 的平铺沉浸式理念：

```css
/* NotePaperPanel.module.css:15-27 */
.panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 200px;
  min-width: 0;
  background: var(--bg-card, #ffffff);
  color: var(--text-primary, #111111);
  border: var(--hairline-width, 1px) solid var(--border-subtle); /* [缺陷 1] 冗余外框 */
  border-radius: var(--radius-lg, 8px);                        /* [缺陷 2] 孤岛圆角 */
  overflow: hidden;
  font-family: var(--font-sans, system-ui, sans-serif);
  box-shadow: var(--shadow-sm);                                  /* [缺陷 3] 悬浮阴影 */
  ...
}
```

对比参考标准组件 [`DiffCard.module.css:5-18`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L5-L18) 与 [`FilesCard.module.css:1-14`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L1-L14)：
- 标准面板定义均为：`height: 100%; min-height: 0; min-width: 0; width: 100%; overflow: hidden; background: var(--bg-card, #ffffff); box-sizing: border-box;`。
- **现场危害**：当用户在分屏窗格（`TreeLeafPanel`）中打开笔记时，窗格本身已经具备边界与分割体系，而笔记面板却自带 8px 圆角与浮动阴影，四角与窗格边缘留有不自然的底色缝隙，呈现为一个缩在分屏内部的“孤岛悬浮卡片”，严重破坏了视觉整体性。

### 1.2 顶栏几何规格与元素膨胀

查看现存顶栏容器定义 [`NotePaperPanel.module.css:48-80`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L48-L80)：

```css
/* NotePaperPanel.module.css:48-58 */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--card-header-gap, var(--space-1_5, 6px));
  min-height: var(--card-header-min-height, 36px); /* [缺陷 4] 非标 36px 高度 */
  padding: var(--card-header-pad-y, 0px) var(--panel-pad-x, 12px);
  border-bottom: var(--hairline-width, 1px) solid var(--border-subtle);
  background: var(--bg-secondary);                 /* [缺陷 5] 与整体卡片底色不一 */
  flex-shrink: 0;
}

.meta {
  display: flex;
  flex-wrap: wrap;                                 /* [缺陷 6] 允许折行，极易破坏紧凑布局 */
  align-items: center;
  gap: var(--space-1_5, 6px);
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary, #555555);
  flex-shrink: 0;
}
```

- **高度割裂**：标准紧凑工具栏（`DiffHeaderControls`、`FilesCard.filesBar`）均为物理硬锁定的 **32px**。而笔记顶栏设定为 `36px`，导致左右分屏或标签切换时顶栏高度上下跳动，造成强烈的视觉突兀感。
- **允许折行**：`.meta` 声明了 `flex-wrap: wrap;`，在分屏窄窗（如宽度小于 380px）时，由于调试徽章过多，顶栏瞬间被撑成两行甚至三行，直接侵占编辑视口高度！

### 1.3 调试信息对产品体验的严重侵占

查看 [`NotePaperStrictHeader.tsx:48-118`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx#L48-L118)：

```tsx
/* NotePaperStrictHeader.tsx:48-117 */
<header className={styles.header}>
  <h2 className={styles.title}>{title}</h2>
  <div className={styles.meta}>
    {/* [垃圾信息 1] 包 ID 与内部轨标记 */}
    <span className={styles.badgeSilent} data-testid="note-paper-strict-track">
      {W5B_STRICT_PACKAGE_ID}/{W5B_STRICT_TRACK}
    </span>
    {/* [垃圾信息 2] CRDT 内部版本号 */}
    <span className={styles.badge} data-testid="note-paper-strict-rev">
      rev={resolvedRev}
    </span>
    {/* [无价值信息 3] 粗糙的块数量 */}
    <span className={styles.badge} data-testid="note-paper-strict-count">
      {blockCount} 块
    </span>
    {/* [垃圾信息 4] 引擎写模式探针 */}
    <Tooltip content={slashModeHint}>
      <span className={styles.badge} data-testid="note-paper-strict-slash-mode" data-slash-write-mode={slashWriteMode}>
        slash={slashWriteMode}
      </span>
    </Tooltip>
    {/* [非标按钮 1] 药丸状刷新按钮 */}
    <Button type="button" variant="ghost" size="sm" className={styles.badge} onClick={() => { void onReload(); }} aria-label="重新 hydrate 投影" data-testid="note-paper-strict-refresh">
      刷新
    </Button>
    {/* [非标按钮 2] 药丸状斜杠按钮 */}
    {showOpenSlashButton ? (
      <Button type="button" variant="ghost" size="sm" className={styles.badge} onClick={onOpenSlash} aria-label="..." data-testid="note-paper-strict-open-slash" data-slash-open-trigger="1" data-slash-write-mode={slashWriteMode}>
        /
      </Button>
    ) : null}
    {/* [非标按钮 3] 药丸状文字关闭按钮 */}
    {onClose ? (
      <Button type="button" variant="ghost" size="sm" className={styles.badge} onClick={onClose} aria-label="关闭 Strict 笔记纸面" data-testid="note-paper-strict-close">
        关闭
      </Button>
    ) : null}
  </div>
</header>
```

- **现场表现**：打开笔记后，用户最显眼的位置看到的是：`W5-B/strict`、`rev=4`、`139 块`、`slash=writable`。用户根本不知道 `W5-B` 是什么，更不需要知道当前底层 CRDT 迭代了多少个 revision！
- **按钮样式反常**：系统已具备完善的 `IconButton` 原子基元，但笔记顶栏却给 `Button` 强行套用 `.badge`（胶囊药丸形状、`border-radius: 9999px`），文字关闭按钮与全仓通用的右侧 `X` 关闭图标格格不入。

### 1.4 底栏调试垃圾与标题写死

1. **脱水 Footer 强占空间**：
   [`NotePaperStrictPanel.tsx:263-266`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx#L263-L266) 与 [`NotePaperPanel.module.css:530-538`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L530-L538)：
   ```tsx
   <footer className={styles.footer} data-testid="note-paper-strict-footer">
     surface={EDITOR_SURFACE_NOTE_PAPER} · {W5B_STRICT_BOUNDARY}
     {projection ? ` · source=${projection.source}` : ''}
   </footer>
   ```
   在编辑界面底部常驻渲染 `surface=note-paper · W5-B/strict · source=fixture`，这纯粹是早期打桩验收留下的脚手架代码，至今未清理！
2. **硬编码开发标题**：
   [`NotePaperStrictPanel.tsx:83`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx#L83)：
   `title = '笔记纸面（W5-B Strict · hydrate 投影）'`
   普通用户使用该功能时，赫然看到“W5-B Strict · hydrate 投影”，严重损害产品品质。

---

## 2. 系统统一 32px 紧凑顶栏（Compact Header）规格与布局重塑

为了彻底消除割裂，对齐全仓现代紧凑工具栏标准，必须重构顶栏为三段式、32px 物理锁定的产品级 Header。

### 2.1 紧凑顶栏核心几何标准与 CSS 规格

```css
/* 标准 32px 紧凑顶栏容器定义（对标 DiffHeaderControls / FilesCard） */
.compactHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 8px;
  background: var(--bg-card, #ffffff);
  border-bottom: 1px solid var(--border-subtle);
  box-sizing: border-box;
  user-select: none;
  flex-shrink: 0;
  gap: 6px;
  overflow: hidden;
}

/* 左侧：文档图标 + 可编辑标题 + 保存状态 */
.headerLeftGroup {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

.noteIcon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* 行内可编辑标题容器 */
.titleContainer {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: 320px;
  flex: 1 1 auto;
}

/* 标题只读展示态（鼠标悬停出轻微虚线或背景暗示可编辑） */
.titleDisplay {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 6px;
  border-radius: var(--radius-sm, 4px);
  cursor: text;
  transition: background var(--transition-micro, 100ms ease-out);
}

.titleDisplay:hover {
  background: var(--bg-hover);
}

/* 标题编辑输入框（无原生黑边框，柔和高亮） */
.titleInput {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 4px);
  padding: 1px 6px;
  height: 24px;
  min-height: 24px;
  width: 100%;
  outline: none;
  box-sizing: border-box;
}

.titleInput:focus {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
}

/* 保存与协同状态指示器 */
.saveStatus {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.saveStatusSaved {
  color: var(--color-success, #10b981);
}

.saveStatusSyncing {
  color: var(--color-info, #3b82f6);
}

/* 右侧：功能按钮组与统计数据 */
.headerRightGroup {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 字数统计指示器（等宽排版） */
.wordCountBadge {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  padding: 2px 6px;
  border-radius: var(--radius-sm, 4px);
  background: var(--bg-secondary);
  user-select: none;
  flex-shrink: 0;
}

.divider {
  width: 1px;
  height: 14px;
  background: var(--border-subtle);
  margin: 0 2px;
  flex-shrink: 0;
}
```

### 2.2 重构后的 DOM 节点结构模型

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  32px 紧凑顶栏 (.compactHeader)                                                         │
│                                                                                        │
│  [左侧组 .headerLeftGroup]                                                              │
│  ├─ <FileText size={14} /> (笔记图标)                                                  │
│  ├─ [行内编辑标题 .titleContainer] "架构设计与重构备忘录"                              │
│  └─ [保存状态 .saveStatus] <Check size={12} /> "已保存"                                │
│                                                                                        │
│  [右侧组 .headerRightGroup]                                                             │
│  ├─ [字数徽标 .wordCountBadge] "1,420 字 · 18 段" (悬停出字符详情)                      │
│  ├─ <IconButton icon={<Copy />} tooltip="复制全文 (Markdown)" />                       │
│  ├─ <IconButton icon={<Download />} tooltip="导出 Markdown 文件" />                     │
│  ├─ <IconButton icon={<RotateCw />} tooltip="重新加载" />                               │
│  ├─ <IconButton icon={<Trash2 />} variant="danger" tooltip="清空笔记" />               │
│  ├─ [分割线 .divider]                                                                  │
│  └─ <IconButton icon={<X />} tooltip="关闭面板" />                                      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 产品级功能矩阵设计（标题编辑、字数统计、导出、操作组）

从玩具级技术展示彻底升格为生产力工具，必须补全以下 6 大产品级核心功能：

| 功能模块 | 交互契约与触发形态 | 底层数据通路与状态机 | 异常边界与防护 |
| :--- | :--- | :--- | :--- |
| **1. 标题行内编辑 (Editable Title)** | 单击展示态切换为输入框；按 `Enter` 或失焦提交重命名；按 `Escape` 放弃修改并还原。 | 触发 `onRenameTitle(newTitle)` -> 经 `doc_meta` 写入持久化 SQLite；同时更新窗口 Tab 标题。 | 空白标题自动回退为默认“无标题笔记”；限制最长 120 字符。 |
| **2. 精准字数与段落统计 (Content Stats)** | 默认以 `tabular-nums` 展示“`X 字 · Y 段`”；悬停 Tooltip 展示多维明细。 | 监听块投影序列变化，实时统计汉字数、英文词数、字符总数以及非空段落块数。 | 字符突变时防抖计算，避免大文档打字造成频繁重渲染。 |
| **3. 保存状态指示 (Sync Status)** | 状态分三态：<br>① `saved`（已保存，绿色/弱灰小勾）；<br>② `syncing`（同步中，平滑旋转）；<br>③ `unsaved`（有未落盘改动）。 | 订阅 `bridges/note-doc-written` 与内部 `dirty` 状态，对齐 CRDT/SQLite 事务周期。 | 绝不阻塞用户当前击键与编辑，仅作只读视觉反馈。 |
| **4. 一键复制全文 (Copy Full Markdown)** | 点击原子按钮 `<IconButton icon={<Copy size={14} />} />`，将笔记解析为纯净 Markdown 复制至剪贴板。 | 遍历当前块投影的 `text`、`flavour` 与 `props.level`，拼接为符合 CommonMark 标准的文本流。 | 异步剪贴板权限被拦截时回退到隐藏 textarea 选中复制机制，弹出 Toast 提示。 |
| **5. 导出 Markdown 文件 (Export as .md)** | 点击 `<IconButton icon={<Download size={14} />} />` 触发下载/落盘流程。 | 在 Tauri 环境下调用系统原生保存对话框；在 Web 环境下创建 `blob:` URL 并自动下载。 | 过滤文件名非法字符（如 `\ / : * ? " < > \|`），安全保存。 |
| **6. 安全清空重置 (Clear with Confirm)** | 点击危险图标 `<IconButton icon={<Trash2 size={14} />} variant="danger" />`。 | 弹出系统统一标准 `@/components/ui/ConfirmDialog`，用户确认后发出清空指令。 | 二次确认弹窗防误触，清空动作进入撤销历史（Undo Stack）。 |

### 3.1 字数统计纯逻辑算法设计（纯函数）

为保证极致渲染性能，字符统计必须与 UI 解耦为可单独测试的纯计算函数：

```typescript
export interface NoteContentMetrics {
  totalChars: number;      // 总字符数（含空白）
  visibleChars: number;    // 可见字符数（不含换行与空格）
  chineseChars: number;    // 中文字符数
  englishWords: number;    // 英文单词数
  paragraphCount: number;  // 段落/块总数
}

export function computeNoteMetrics(
  blocks: readonly { text?: string; flavour?: string }[]
): NoteContentMetrics {
  let totalChars = 0;
  let visibleChars = 0;
  let chineseChars = 0;
  let englishWords = 0;
  let paragraphCount = 0;

  for (const block of blocks) {
    const text = block.text || '';
    if (!text.trim()) continue;
    paragraphCount++;
    totalChars += text.length;

    // 匹配汉字及全角标点
    const cjk = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g);
    const cjkCount = cjk ? cjk.length : 0;
    chineseChars += cjkCount;

    // 匹配英文单词
    const enWords = text
      .replace(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    englishWords += enWords.length;

    visibleChars += text.replace(/\s/g, '').length;
  }

  return {
    totalChars,
    visibleChars,
    chineseChars,
    englishWords,
    paragraphCount,
  };
}
```

---

## 4. 调试信息与死层彻底清除面（逐项标明待删除节点）

以下为本次重构中拟从源码中连根拔除的技术调试节点与死代码清单：

### 4.1 拟物理拔除的 JSX 节点与代码段

| 所在文件 | 行号范围 | 拟彻底删除的脏代码段 | 拔除理由与替代方案 |
| :--- | :--- | :--- | :--- |
| **`NotePaperStrictHeader.tsx`** | L51–L56 | `<span className={styles.badgeSilent} data-testid="note-paper-strict-track">{W5B_STRICT_PACKAGE_ID}/{W5B_STRICT_TRACK}</span>` | **纯底层包轨标记**。用户完全不需要知晓 W5-B 或 strict 轨，彻底删除。 |
| **`NotePaperStrictHeader.tsx`** | L57–L59 | `<span className={styles.badge} data-testid="note-paper-strict-rev">rev={resolvedRev}</span>` | **CRDT 内部版本号**。属于脱水排查字段，彻底删除。 |
| **`NotePaperStrictHeader.tsx`** | L60–L62 | `<span className={styles.badge} data-testid="note-paper-strict-count">{blockCount} 块</span>` | **粗暴块数显示**。升级为产品级的等宽字数统计组件，保留 `data-testid="note-paper-strict-count"` 挂载在新徽标上。 |
| **`NotePaperStrictHeader.tsx`** | L63–L71 | `<Tooltip content={slashModeHint}><span className={styles.badge}...>slash={slashWriteMode}</span></Tooltip>` | **引擎写模式探针**。普通用户无需被科普“未接 apply ≠ 假写”，彻底删除。 |
| **`NotePaperStrictHeader.tsx`** | L72–L84 | `<Button ... className={styles.badge}>刷新</Button>` | **药丸状刷新按钮**。换装为标准 `<IconButton icon={<RotateCw size={14} />} tooltip="重新加载" />`。 |
| **`NotePaperStrictHeader.tsx`** | L85–L103 | `<Button ... className={styles.badge}>/</Button>` | **胶囊状斜杠快捷键按钮**。改换为直观的标准原子图标或合并入格式化菜单。 |
| **`NotePaperStrictHeader.tsx`** | L104–L116 | `<Button ... className={styles.badge}>关闭</Button>` | **纯文字胶囊关闭钮**。换装为全系统通用的 `<IconButton icon={<X size={14} />} tooltip="关闭面板" />`。 |
| **`NotePaperStrictPanel.tsx`** | L263–L266 | `<footer className={styles.footer} data-testid="note-paper-strict-footer">surface=... · W5-B ...</footer>` | **占位调试底栏**。长期无用且浪费纵向高度，连根拔除整个 `<footer>` 节点。 |

### 4.2 拟物理清理的私有 CSS 类名

在 [`NotePaperPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css) 中，以下规则将被彻底废除与清理：
1. **`.badge`、`button.badge`、`button.badge:hover`、`button.badge:active`、`button.badge:focus-visible`（L84–L123）**：废除将徽章用作交互按钮的违规写法，由 `@/components/ui` 标准组件原生样式接管。
2. **`.badgeSilent`（L144–L155）**：彻底删除，不再支持渲染底层轨标记。
3. **`.footer`（L530–L538）**：彻底删除底栏容器样式。
4. **`.flavour`（L385–L400）**：清理在正文中展示 `PARAGRAPH`、`HEADING h1` 的调试标签样式。
5. **`.panel > .footer` 绝缘选择器（L710）**：因 footer 已拔除，同步精简该防御性样式。

---

## 5. 编辑器主区域 100% 弹性高度与视口贴合架构

### 5.1 弹性高度传递链（Flexbox Stretch Pipeline）

解决“孤岛卡片”与“高度失控”的关键，是理顺从顶层窗格至底层编辑器的 Flex 弹性伸缩链：

```
[窗格宿主 TreeLeafPanel] (.leafBody: flex: 1 1 0%; min-height: 0; width: 100%;)
  │
  ▼
[叶适配器 NoteLeafHost] ([data-note-leaf-host]: flex: 1 1 0%; min-height: 0; width: 100%;)
  │
  ▼
[笔记面板 NotePaperStrictPanel] (.panel: flex: 1 1 auto; height: 100%; min-height: 0; display: flex; flex-direction: column;)
  │
  ├─► [32px 紧凑顶栏 NotePaperHeader] (flex: 0 0 32px; height: 32px; max-height: 32px;)
  │
  └─► [主编辑区 NotePaperStrictBody] (.body: flex: 1 1 0%; min-height: 0; height: 100%; overflow: auto;)
        │
        └─► [正文排版容器 .readingColumn] (flex: 1 1 auto; max-width: 720px; margin-inline: auto;)
              │
              └─► [PaperList 虚拟挂载 / React 块行] (flex: 1 1 auto; width: 100%;)
```

### 5.2 视口与滚动条权属治理（单滚动条法则）

当前代码中，`.body`（[`NotePaperPanel.module.css:160`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L160)）设置了 `overflow: auto;`，同时 `@crish/block-paper/paper-list.css:47` 中的 `.bp-paper-list[data-scroll-host='1']` 也具备 `overflow: auto;`，极易发生双重滚动条或滚轮事件拦截：

- **单一滚动容器契约**：
  1. 在 `presentationMode = 'react-rows'` 模式下：`.body` 作为唯一的滚动容器，接管纵向滚轮，`.readingColumn` 自然拉伸。
  2. 在 `presentationMode = 'paper-list'`（虚拟化长列表模式）下：
     - 若 `paperListHost` 开启虚拟滚动宿主（`data-scroll-host='1'`），则 `.body` 必须声明 `overflow: hidden;`，由 `PaperList` 的内部虚拟滚动条全权负责；
     - 严禁父子两级同时出现纵向滚动条。

### 5.3 容器查询与小屏自适应弹性布局

为确保在分屏窄窗（如分屏至 300px 宽度）或超宽屏下均保持极佳观感：
- 启用 CSS Container Queries：
  在 `.panel` 声明 `container-type: inline-size; container-name: note-panel;`。
- 动态响应断点：
  - 当 `note-panel (max-width: 480px)` 时：字数统计自动精简为只显示纯数字（如 `1.4k 字`），标题最大宽度缩减至 `140px`，非核心按钮（如格式化入口）收纳折叠。
  - 当 `note-panel (max-width: 320px)` 时：隐藏保存文字仅留状态点图标，确保标题与关闭按钮绝对可见，永不溢出换行。

---

## 6. 测试资产防护与重构兼容性保障

根据本仓《测试资产保护铁律》与既有单测分析，本次重构需严格保护既有测试断言，采取“语义升级，TestId 平滑映射”策略：

1. **`NotePaperStrictPanel.line-budget.test.ts` 行数门禁**：
   - 严格保证 `NotePaperStrictPanel.tsx` 物理全量代码行数保持在 **< 400 行**（目前 272 行，重构中外置标题组件与功能组，预计降至约 240 行）。
2. **`NotePaperStrictPanel.test.tsx` 核心 TestId 继承**：
   - `note-paper-strict-panel`：保持挂载于根 `<section>`。
   - `note-paper-strict-refresh`：迁移至新 32px 顶栏中的刷新 `IconButton`。
   - `note-paper-strict-close`：迁移至新 32px 顶栏中的关闭 `IconButton`。
   - `note-paper-strict-count`：迁移至新字数与段落统计徽章容器。
   - `note-paper-strict-open-slash`：若保留快捷触发，挂载于新图标触发器上。
3. **废弃测试的平滑重构**：
   - 对于只测 `W5-B/strict` 徽章文本的脱水断言（如 `NotePaperStrictHeader.test.tsx` 中关于 `slash 只读（未接 apply；≠假写）` 的文本匹配测试），升级为测试产品级组件的交互与 Tooltip 行为，严禁直接暴力删除测试文件。

---

## 结论与后续落地步骤建议

本报告完成对笔记面板布局与顶栏的现场深度勘察与产品级标准化设计。总结要点如下：
1. **容器净收敛**：剥离 `.panel` 孤岛圆角与外框阴影，拔除底栏脱水 Footer，让笔记面板与 `DiffCard` / `FilesCard` 达成 100% 同心同质的现代化无缝平铺。
2. **顶栏标准化**：建立 32px 紧凑工具栏，彻底清退底层技术垃圾标签，引入行内可编辑标题、保存状态感知与等宽字数统计。
3. **原子组件化**：全量换装 `@/components/ui/IconButton`，引入复制、导出、清空等真正具备生产力的功能矩阵。
4. **单轨弹性视口**：理顺 Flexbox 伸缩链，统一滚动容器权属，根治双滚动条与内容截断顽疾。

待本战役所有专项审计（AUDIT-01 至 AUDIT-08）汇总结案并经用户裁决批准后，即可进入方案编写与代码落地阶段。
