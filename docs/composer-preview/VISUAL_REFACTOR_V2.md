# Conex Composer — 视觉重构方案 V2

> **日期**: 2026-08-05  
> **触发**: 用户截图标注 + 高级参考对照  
> **定位**: 以参考图的「留白、克制、简约」理念为指导，不照抄视觉，借鉴设计原则

---

## 一、截图标注的严重问题

### 问题 1: 视频嵌入块 — 完全没做好

**现状截图**: 视频块区域是一大块纯黑背景（iframe 空载状态），输入框嵌在黑色面板内部，蓝色描边「嵌入」按钮直接内嵌。整个视觉是「一坨黑色加一个丑输入框」。

**根因**:
- `VideoBlockView.tsx` 的空状态渲染了整个 panel 结构（icon + 提示文字 + 表单），但 CSS 中的 `.video-block__url-form` 缺少独立的视觉设计
- 空状态的背景 fallback 到了 iframe 默认的黑色
- 输入框是标准 `<input type="url">` + 蓝色按钮，没有任何质感处理

**重构方向**: 
空状态应该是一个**干净的灰色虚线框 + 居中的图标 + 一行提示**。输入框不应内嵌在面板里，而是用**跟随式输入**——用户点击空状态区域后，一个轻量的浮动输入条**从空状态区域正下方长出来**，类似 Notion 的链接粘贴交互：

```
┌─────────────────────────────────────┐
│          🎬  嵌入视频               │  ← 空状态（灰底虚线框）
│   粘贴链接或点击上传本地视频         │
└─────────────────────────────────────┘
         ┌──────────────────────┐
         │ 🔗 粘贴视频链接...    │         ← 点击后浮出的跟随式输入条
         └──────────────────────┘
```

关键设计约束：
- 空状态高度固定 120px，灰底 `var(--bg-secondary)` + `1px dashed var(--border-default)` + 圆角 12px
- 跟随式输入条：`position: absolute; bottom: -44px`，白底 + `box-shadow: var(--shadow-md)` + 圆角 8px
- 输入条内**不放按钮**——用户粘贴链接后**自动检测并嵌入**（回车确认 / 粘贴即插）
- 视频加载中用骨架屏 shimmer，不是黑色空白
- 加载完成后 iframe 使用 `aspect-ratio: 16/9` 约束，圆角裁切

---

### 问题 2: 蓝色激活边框 — 整个文档区域都有

**现状截图**: 编辑器获得焦点后，整个 `.editor-content` 或 `.ProseMirror` 出现了一圈蓝色 outline / box-shadow。

**根因**: 可能来自多个来源——
1. `prosemirror.css` 的 `.node-view-wrapper.is-editing` 设置了 `outline: 2px solid var(--border-focus)`
2. `motion.css:306` 的 `:where(button, a, input, textarea, select, [tabindex]):focus-visible` 设置了 `box-shadow: 0 0 0 4px var(--border-focus)`
3. 浏览器默认的 `<div contenteditable>` focus outline

**修复**: 
```css
/* ProseMirror 是 contenteditable div，它获得焦点是常态，不需要 focus ring */
.ProseMirror:focus,
.ProseMirror:focus-visible {
  outline: none;
  box-shadow: none;
}

/* 编辑区容器也不需要 */
.editor-content:focus,
.editor-content:focus-visible {
  outline: none;
  box-shadow: none;
}
```

**重要**: 这不违反 AGENTS.md 的 focus 规范——那些规范是针对**按钮、输入框**的。编辑器的 contenteditable 区域是用户长期注视的区域，加 focus ring 是噪音。

---

### 问题 3: 输入框蓝色激活边框 — 过度突兀

**现状**: `field__input:focus` 使用 `border-color: var(--accent-blue)` + `box-shadow: 0 0 0 3px var(--bg-selected)`，在暖灰编辑器中非常扎眼。

**参考 AGENTS.md 规则**: 
> "Maximum 10% Focus Contrast Limit": 焦点/激活状态的边框灰度/深色程度不得超过基线背景文字对比度混合的 10%

**修复**:
```css
.field__input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--border-default) 90%, var(--text-primary) 10%);
  box-shadow: none;
}
```

---

### 问题 4: 代码块语言选择器 — 太重

**现状截图**: 语言选择器下拉宽 200px，有搜索框 + 滚动列表，但视觉上是一个「沉重的面板」悬浮在代码块上方。

**重构**: 
- 下拉面板去掉外边框，只保留 `box-shadow`
- 搜索框高度从 28px 减到 24px，内边距更紧凑
- 列表项高度从 28px 减到 26px
- 使用 `motion-rise-in` 动画进场
- 已选中的语言用 ✓ 勾号而非背景高亮

---

## 二、从参考截图中提炼的设计原则

参考截图展现了三个核心设计理念，我们需要内化而非照抄：

### 原则 A: 「留白即信息」

参考截图中大量使用负空间来区分信息层级：
- 标题上方留 40px+，但标题下方只留 4-8px → 建立「标题属于下方内容」的从属关系
- 引用块左边距用 3px 实色竖线 + 16px 内间距 → 简单克制，不用背景色
- 代码块内容区域 padding 充裕（上下 16px，左右 20px），不显得拥挤

**当前的差距**: 我们的 `margin-top: 0` 一刀切完全消灭了呼吸感。

**改造**:
```css
/* 块级节奏系统：不同元素之间的间距差异化 */
.ProseMirror > * + p { margin-top: 2px; }        /* 段落间：极微间距，靠行高呼吸 */
.ProseMirror > * + h1 { margin-top: 2.2em; }     /* H1 前大留白 */
.ProseMirror > * + h2 { margin-top: 1.6em; }
.ProseMirror > * + h3 { margin-top: 1.2em; }
.ProseMirror > h1 + * { margin-top: 6px; }       /* 标题后紧跟 */
.ProseMirror > h2 + * { margin-top: 4px; }
.ProseMirror > h3 + * { margin-top: 2px; }
.ProseMirror > * + pre { margin-top: 12px; }     /* 代码块前后留白 */
.ProseMirror > pre + * { margin-top: 12px; }
.ProseMirror > * + blockquote { margin-top: 8px; }
.ProseMirror > blockquote + * { margin-top: 8px; }
.ProseMirror > * + hr { margin-top: 16px; }
.ProseMirror > hr + * { margin-top: 16px; }
.ProseMirror > * + .block-shell { margin-top: 12px; }
.ProseMirror > .block-shell + * { margin-top: 12px; }
.ProseMirror > * + ul,
.ProseMirror > * + ol { margin-top: 4px; }
```

### 原则 B: 「交互跟随上下文」

参考截图中的交互控件不是固定在面板里的，而是**跟随内容出现在需要的地方**：
- 格式工具栏在**选中文字时**浮在选区上方
- 颜色/块类型切换在工具栏的**二级面板**中
- 链接编辑在**点击链接时**内联弹出
- Slash 菜单在**光标位置**弹出

**当前的差距**:
- 视频/图片/文件的 URL 输入嵌在 panel 内部，应该改为跟随式浮动输入
- AI 提示框嵌在 block 内部，应该改为底部固定的跟随式 composer

**改造方向**: 所有「输入型交互」统一使用一个**通用的跟随式输入组件** `InlineInput`：
```tsx
// 通用跟随式输入组件
interface InlineInputProps {
  anchor: DOMRect;          // 锚定位置（参考元素的 getBoundingClientRect）
  placeholder: string;
  icon: React.ReactNode;
  onSubmit: (value: string) => void;
  onClose: () => void;
  autoDetect?: boolean;     // 粘贴时自动检测 URL 类型
}
```

这个组件用 `position: fixed` + `transform` 定位（与 SlashMenu 一样走合成器线程），白底 + 细 shadow + 圆角，内部只有 icon + input，**没有按钮**（回车提交，Escape 取消）。

### 原则 C: 「视觉重量克制」

参考截图的一个核心特质是**控件存在感极低**——不到需要的时候，你感觉不到它们：
- 拖拽手柄只在 hover 时出现，而且是极淡的灰色点阵
- 块工具栏只有 hover 时才从透明浮现
- 分隔线是 1px 的极淡灰色
- 快捷键提示只在激活项上才出现

**当前做得好的**:
- `motion-affordance` 机制（opacity 0 → 1）已经定义了 ✅
- block-shell 的 `::after` 悬浮底色也有了 ✅

**当前做得不好的**:
- 很多组件还没有接入 `motion-affordance-host` + `motion-affordance` 的类名
- 代码块的行号区域 (`padding-left: 46px` 硬编码) 始终可见，应该也跟随 hover

---

## 三、重构执行计划

### Phase 1: 紧急修复（Tier 0 — 体验破损级别）

这些是**当前已实现但表现有问题**的功能，不修就不能看。

#### 1.1 全局焦点环修复
- 移除 ProseMirror contenteditable 的 focus outline
- 将所有 `field__input` 的 focus 边框降级到 AGENTS.md 规定的 10% 混合度
- **文件**: `prosemirror.css`, `block-shell.css`
- **行数**: ~15 行修改

#### 1.2 视频嵌入块重做
- 删除当前的 `VideoBlockView.tsx` 中的 `VideoUrlInput` 内嵌表单
- 新建 `InlineInput` 通用跟随式输入组件
- 视频空状态改为干净的灰色虚线框 + 居中图标
- 点击后弹出跟随式输入条
- 有视频时使用 `aspect-ratio: 16/9` + 圆角裁切
- **文件**: `VideoBlockView.tsx` 重写, 新建 `ui/InlineInput.tsx`, `media-data-blocks.css` 修改
- **行数**: ~250 行 TSX + ~100 行 CSS

#### 1.3 图片/音频/文件嵌入块同步改造
- 统一使用 `InlineInput` 组件替代所有内嵌的 URL 表单
- **文件**: `ImageBlockView.tsx`, `AudioBlockView.tsx`, `FileBlockView.tsx`
- **行数**: ~150 行 TSX + ~60 行 CSS

#### 1.4 块间距节奏系统
- 实现 Phase A 中定义的差异化块间距规则
- **文件**: `prosemirror.css`
- **行数**: ~40 行 CSS

---

### Phase 2: 字体与排版升级（Tier 1 — 最高 ROI）

#### 2.1 字体引入
- 引入 Inter（拉丁） + Noto Sans SC（中文） Web Font
- 更新 `--font-sans` 和 `--font-mono`（等宽改用 JetBrains Mono 或 Fira Code）
- **文件**: `tokens.css`, `index.html` 或 CSS `@import`
- **行数**: ~10 行

#### 2.2 排版微调
- H1 字号从 36px 微调到 40px，字重 800（Extra Bold），增强标题冲击力
- H2/H3 的 letter-spacing 从 -0.02em 微调到 -0.015em
- 正文行高从 1.6 微调到 1.625（黄金比例相关）
- 行内代码的背景色从 `rgba(135,131,120,0.15)` 调深到 `0.18`，增强识别度
- **文件**: `typography.css`, `prosemirror.css`, `live-preview.css`
- **行数**: ~30 行修改

---

### Phase 3: Shell 壳层重构（Tier 2 — 产品感）

#### 3.1 Header 毛玻璃 + 重新布局
- 背景改 `rgba(255,255,255,0.85)` + `backdrop-filter: blur(12px) saturate(1.8)`
- 增加 `position: sticky; top: 0`
- 右侧按钮组重新分组，增加图标间的 divider
- 字数统计移到底部状态栏（或右下角角标）
- **文件**: `shell.css`, `Editor.tsx`
- **行数**: ~80 行

#### 3.2 PageHeader 组件
- 封面图区域（可选，默认不显示，点击添加）
- 页面图标（Emoji picker，hover 显示更换按钮）
- 页面标题（H1 级别输入框，直接在编辑区顶部）
- **文件**: 新建 `shell/PageHeader.tsx`, 新建 `styles/blocks/page-header.css`
- **行数**: ~200 行 TSX + ~180 行 CSS

#### 3.3 底部状态栏
- 左侧：字数 · 字符数 · 阅读时长
- 右侧：光标位置 · 语言
- 高度 28px，`var(--bg-secondary)` 底色
- **文件**: 新建 `shell/StatusBar.tsx`, 在 `shell.css` 中追加
- **行数**: ~60 行 TSX + ~40 行 CSS

---

### Phase 4: 暗色主题（Tier 2 — 完整性）

#### 4.1 Dark Token 定义
- 新建 `tokens-dark.css`，覆盖所有语义色变量
- 暗色方案对标 Notion Dark: 背景 `#191919` / `#202020` / `#2f2f2f`
- 暗色文字 `rgba(255,255,255,0.86)` / `0.6` / `0.38`
- **文件**: 新建 `styles/tokens-dark.css`
- **行数**: ~200 行

#### 4.2 切换机制
- `[data-theme="dark"]` 选择器
- 切换按钮在 Header 右侧
- `localStorage` 持久化 + 系统偏好检测 (`prefers-color-scheme`)
- **文件**: `tokens-dark.css`, `Editor.tsx`, 新建 `hooks/useTheme.ts`
- **行数**: ~60 行 TSX + ~30 行 TS

---

### Phase 5: 菜单系统打磨（Tier 2 — 交互质量）

#### 5.1 SlashMenu 重做
- 搜索框从无到有：面板顶部固定一个极简搜索栏
- 菜单项图标从方形线框改为**彩色圆角矩形底色 + 白色图标**
- 分组标题字号从 `--text-xs` 微缩到 10px，加大分组间距
- 键盘导航时使用 `motion-rise-in` 交错动画
- 快捷键提示使用 `motion-affordance` 只在 active 时显示 ✅（已有）
- **文件**: `SlashMenu.tsx`, `menus/index.css`
- **行数**: ~120 行 TSX + ~100 行 CSS

#### 5.2 BubbleMenu 增强
- 增加块类型图标
- 颜色面板增加色板悬浮缩放动画（已有 `.color-swatch:hover { transform: scale(1.14) }`）
- 链接编辑面板增加「移除链接」「新标签打开」按钮
- **文件**: `BubbleMenu.tsx`, `menus/index.css`
- **行数**: ~80 行 TSX + ~50 行 CSS

#### 5.3 BlockMenu 完善
- 右键上下文菜单的实际功能对接（复制/粘贴/删除/转换类型/颜色/注释）
- 子菜单的滑入动画
- **文件**: `BlockMenu.tsx`, `menus/index.css`
- **行数**: ~100 行 TSX + ~60 行 CSS

---

### Phase 6: 区块 NodeView 精细化（Tier 3 — 内容体验）

#### 6.1 代码块打磨
- 圆角从 `--radius-xl` (8px) 增到 `--radius-2xl` (12px)
- header 背景对比度拉开（header 用 `#edecec`，代码区保持 `#f7f6f3`）
- 语言名称渲染态（非编辑态）用不同字重
- 行号区域 hover 时淡入
- 增加 **代码差异高亮** 样式（`+ 绿 / - 红` 行底色）
- **文件**: `code-block-view.css`, `CodeBlockView.tsx`
- **行数**: ~80 行 CSS + ~40 行 TSX

#### 6.2 Callout 块增强
- 圆角从 `--radius-sm` (3px) 增到 `--radius-lg` (6px)
- 增加**图标选择弹出面板**（点击当前图标 → Emoji Picker 弹出）
- 增加**折叠功能**（小箭头 + 内容区折叠动画）
- **文件**: `CalloutView.tsx` 扩展, `fenced.css` 修改
- **行数**: ~120 行 TSX + ~60 行 CSS

#### 6.3 公式块增强
- Notion 风格：点击公式 → **底部弹出编辑面板**（不是内嵌 textarea）
- 面板包含: LaTeX 输入框 + 实时预览 + 常用符号面板（分 tab：希腊字母 / 运算符 / 关系 / 箭头）
- 空状态：灰色虚线框 + `Σ` 图标 + "点击输入公式"
- **文件**: `MathBlockView.tsx` 重写, `fenced.css` 扩展
- **行数**: ~300 行 TSX + ~150 行 CSS

#### 6.4 图片块增强
- 拖拽调整大小（四角手柄 + 8方向光标）
- 对齐工具栏（左 / 居中 / 右 / 宽幅 / 全宽）
- 图片说明文字输入（caption）
- 空状态统一使用 `InlineInput`
- **文件**: `ImageBlockView.tsx` 重写, `media-layout.css` 扩展
- **行数**: ~250 行 TSX + ~150 行 CSS

#### 6.5 书签块增强
- OG 卡片渲染（缩略图 + 标题 + 描述 + 域名 + favicon）
- 加载中使用骨架屏
- hover 时整体微抬升 (`motion-lift`)
- **文件**: `BookmarkBlockView.tsx`, `media-data-blocks.css`
- **行数**: ~150 行 TSX + ~80 行 CSS

#### 6.6 嵌入块改造
- iframe 加载指示器（旋转 logo + 进度条）
- 圆角裁切 + shadow
- **文件**: `EmbedBlockView.tsx`, `media-data-blocks.css`
- **行数**: ~80 行 TSX + ~40 行 CSS

---

### Phase 7: 折叠 / 布局块实现（Tier 3 — 结构化内容）

#### 7.1 ToggleHeading 折叠标题
- 三角箭头 (▶) hover 时显示，点击旋转 90° 并展开内容
- 内容区域用 `max-height` + `opacity` 动画（已在 `animations.css` 定义）
- 折叠后显示内容预览（第一行灰色文本）
- **文件**: `ToggleHeadingView.tsx` 完善, `layout-blocks.css`
- **行数**: ~80 行 TSX + ~60 行 CSS

#### 7.2 ToggleList 折叠列表
- 同上，但用于非标题的普通文本折叠
- **文件**: `ToggleListView.tsx` 完善, `layout-blocks.css`
- **行数**: ~60 行 TSX + ~40 行 CSS

#### 7.3 ColumnLayout 多列布局
- 列间分隔线（可拖拽调整列宽比例）
- 拖拽时显示宽度百分比指示
- hover 时显示「添加列」按钮（+ 在右侧）
- **文件**: `ColumnLayoutView.tsx`, `layout-blocks.css`
- **行数**: ~200 行 TSX + ~120 行 CSS

#### 7.4 Tabs 选项卡块
- Tab 栏：下划线指示器 + 切换动画
- 添加/删除/重命名 Tab
- 切换时内容区淡入
- **文件**: `TabsBlockView.tsx`, `layout-blocks.css`
- **行数**: ~180 行 TSX + ~100 行 CSS

---

### Phase 8: 数据库视图精细化（Tier 4 — 高级功能）

#### 8.1 Table 视图打磨
- 列头排序箭头动画
- 行选中高亮
- 行 hover 微抬升
- 新行添加动画（已有 `row-highlight`）
- 列宽拖拽视觉反馈

#### 8.2 Kanban 视图
- 卡片 `motion-lift` 悬浮效果
- 拖拽时的占位线 (`motion-indicator-in`)
- 列头颜色条
- 空列的虚线框空状态

#### 8.3 Gallery 视图
- 卡片封面图 `aspect-ratio: 4/3`
- 悬浮遮罩（半透明渐变 + 快捷操作按钮）
- 瀑布流 / 网格布局切换

#### 8.4 Calendar 视图
- 日历网格 + 事件卡片
- 月/周/日 视图切换
- 今天高亮

**总行数**: ~800 行 TSX + ~600 行 CSS

---

### Phase 9: AI 块 + 高级块（Tier 4 — 差异化功能）

#### 9.1 AI 块
- 底部固定式 Prompt 输入栏（参考截图中的底部 AI 栏）
- 输入栏上方显示快捷操作 pill（"续写这段内容" / "总结要点" / "翻译成英文" 等）
- 流式输出时打字机光标动画
- 渐变紫色装饰边框
- **行数**: ~300 行 TSX + ~200 行 CSS

#### 9.2 TOC 目录块
- 自动扫描文档标题生成缩进列表
- 点击跳转（`scrollIntoView` + 平滑滚动）
- 当前阅读位置高亮
- **行数**: ~150 行 TSX + ~80 行 CSS

#### 9.3 Button 块
- 多种变体（Primary / Secondary / Ghost / Outline）
- 尺寸（SM / MD / LG）
- 图标 + 文字组合
- 链接操作配置面板
- **行数**: ~100 行 TSX + ~60 行 CSS

---

## 四、通用设计语言规范（所有 Phase 共用）

### 4.1 空状态模式

所有可嵌入内容的区块（图片/视频/音频/文件/书签/嵌入/AI）共用同一套空状态视觉：

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
│                                             │
│              [图标 24px]                     │
│           一行主标题 (14px 500)              │
│         一行副标题 (12px 400 灰色)           │
│                                             │
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

- 背景: `var(--bg-secondary)`
- 边框: `1px dashed var(--border-default)`
- 圆角: `var(--radius-2xl)` (12px)
- 高度: 固定 120px（不被内容撑开）
- hover: 边框加深 `var(--border-medium)` + 背景微深 `var(--bg-tertiary)`
- 整体 cursor: pointer
- 点击触发 `InlineInput` 或文件选择器

### 4.2 跟随式输入模式

所有 URL 输入交互统一使用 `InlineInput` 组件：

```
[🔗] 粘贴链接或输入关键词搜索...
```

- 宽度: 380px（固定，不随内容变化）
- 高度: 36px
- 背景: `var(--bg-primary)`
- 边框: `1px solid var(--border-default)`
- 圆角: `var(--radius-xl)` (8px)
- 阴影: `var(--shadow-md)`
- icon: 左侧 14px 图标（灰色）
- 文字: `var(--text-sm)` (13px)
- 进场动画: `motion-rise-in`
- 退场: `motion-rise-out`（120ms）
- **无按钮**——Enter 提交，Escape 取消
- 粘贴检测: 当用户粘贴内容时自动检测是否为 URL 并立即处理

### 4.3 悬浮工具栏模式

所有区块的操作工具栏共用 `block-shell__toolbar` 样式，严格使用 `motion-affordance` 控制显隐。

### 4.4 motion 类挂载清单

以下组件必须在 TSX 中正确使用 motion 工具类：

| 组件 | 需要的 motion 类 |
|:-----|:---------------|
| SlashMenu 列表 | `.motion-stagger` |
| BubbleMenu | `.motion-rise-in` |
| DB Kanban 卡片 | `.motion-lift` |
| DB Gallery 卡片 | `.motion-lift` |
| 书签卡片 | `.motion-lift` |
| 文件卡片 | `.motion-lift` |
| 所有按钮 | `.motion-tap` |
| 拖拽手柄 | `.motion-affordance` |
| 块工具栏 | `.motion-affordance` |
| 下拉菜单 | `.motion-rise-in` |
| Tooltip | 已接入 ✅ |
| Popover | `.motion-pop-in` |

---

## 五、行数预估汇总

| Phase | TSX | CSS | TS | 总计 |
|:------|----:|----:|---:|----:|
| Phase 1: 紧急修复 | 400 | 200 | 0 | 600 |
| Phase 2: 字体排版 | 0 | 40 | 0 | 40 |
| Phase 3: Shell 壳层 | 340 | 300 | 0 | 640 |
| Phase 4: 暗色主题 | 60 | 200 | 30 | 290 |
| Phase 5: 菜单打磨 | 300 | 210 | 0 | 510 |
| Phase 6: 区块精细化 | 950 | 480 | 0 | 1,430 |
| Phase 7: 折叠/布局块 | 520 | 320 | 0 | 840 |
| Phase 8: 数据库视图 | 800 | 600 | 0 | 1,400 |
| Phase 9: AI+高级块 | 550 | 340 | 0 | 890 |
| **合计** | **3,920** | **2,690** | **30** | **6,640** |

加上现有 16,627 行 → 约 **23,267 行**。

> **注意**: 这只是本轮「视觉重构」的增量。完整达到 50,000+ 行还需要后续的功能逻辑补全（Extension 的 Command 系统、拖拽排序、键盘快捷键、撤销/重做、导入导出增强、单元测试等），那些属于另一个 Phase。

---

## 六、执行顺序

```
Phase 1 (紧急修复) → Phase 2 (字体) → Phase 4 (暗色主题)
                           ↓
                    Phase 3 (Shell)
                           ↓
                    Phase 5 (菜单) → Phase 6 (区块) → Phase 7 (布局)
                                                          ↓
                                                   Phase 8 (数据库) → Phase 9 (AI)
```

Phase 1 和 2 是串行的（先修 bug 再提升基线），之后 3-9 可以按优先级逐步推进。每完成一个 Phase 都是一个可交付的视觉里程碑。

---

**文档结束**
