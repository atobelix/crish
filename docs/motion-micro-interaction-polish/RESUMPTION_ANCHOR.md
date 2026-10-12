# 动效与微交互战役：全批次（Batch 1 ~ Batch 5）全量落地与封存记录（Resumption Anchor）

> **战役代号**：`motion-micro-interaction-polish`  
> **工作区路径**：`c:\Software\conex`  
> **当前状态**：**Batch 1、Batch 2、Batch 3、Batch 4、Batch 5 全部 100% 落地并通过全量立体门禁！**  
> **更新时间戳**：`2026-10-12T09:29:00-04:00`  
> **核心指示恪守**：不做向下兼容、不做硬编码、不加任何 important、零测试作弊分支、深度 1 子 Agent 协作、工作区改动保留零提交。

---

## 一、全批次战果全景（Batch 1 ~ Batch 5 全部达成）

### 1. Batch 1：动效基础设施、Token SSOT 与全仓双缓动/过冲清退（100%）

- **`tokens.css` & `motionTokens.ts`**：注入 `--duration-snappy: 120ms`、`--ease-decelerate`、`--ease-accelerate`、`--transition-snappy`、`--transition-normal`、`--transition-chevron: 150ms var(--ease-emphasized)`、`--link-color`（科技蓝 Light: `#2563eb` / Dark: `#60a5fa`）及对应 TypeScript 常量与 eco/reduced-motion 0ms 安全重置。
- **`design-system.css`**：定义权威 `@keyframes crish-popover-enter`（含向下、向上变体与退出变体），彻底铲除 `cds-popover-*` 历史别名。
- **全仓 18 个 CSS 模块 58 处双重缓动与贝塞尔残缺清退**：覆盖 Button、Input、Badge、Slider、SmartPanel、PreviewCard、Sidebar、ChatMessageList、ChatMessageRow 等。
- **存量过冲果冻曲线与显存泄漏根治**：清退 $y_2=1.5$ 与 $y_1=1.25$ 曲线；剥离 `SidebarSessionList` 与 `BinaryTreeWorkspace` 中的常驻 `will-change`。

### 2. Batch 2：下拉菜单、选择器与小箭头 180° 翻转微交互（100%）

- **`Menu.module.css`**：注入 Radix 几何原点（`--radix-popover-content-transform-origin`），实现向上（`[data-side='top']` +4px 浮起）与向下（-4px 下落）方向感知（140ms），优雅离场（100ms 加速淡出）。
- **`SelectContent.tsx` / `ComboboxContent.tsx` / `Select.module.css`**：注入 `data-positioned` 属性守卫，仅在浮动坐标计算 settle 后激发动画，根除首帧跳跃（FOUPC）。
- **`ComposerProjectPicker.tsx` / `.module.css`**：`<AppIcon name="chevron-down" />` 赋予显式 `.chevron` 类名，实现 150ms `var(--ease-emphasized)` 顺滑 180° 翻转。
- **`PermissionModeMenu.module.css`**：精简私有动画声明，完全收敛至基座 Menu 动效。
- **`SmartExpandablePanel.module.css` & `ProjectPickerMenu.module.css`**：二级子菜单卡片 `.cascadeSubmenu` 补齐 120ms 级联滑入动效。

### 3. Batch 3：输入框提示防跳跃、Slash 菜单与气泡飞行（100%）

- **`useComposerNotice.ts`**：实现两阶段 120ms 退场状态机（`isClosing`, `displayNotice`, `exitTimerRef`），支持退场打断与安全卸载。
- **`ChatComposer.module.css` & `ChatComposer.tsx`**：`.composerNoticeZone` 采用 CSS Grid `1fr -> 0fr` 及 `margin-bottom: 6px -> 0` 120ms 收拢，配合 `.composerNoticeZoneInner`（`min-height: 0; overflow: hidden;`）根除关闭时 **54px 剧烈顿挫跳跃**；`ChatComposer.tsx` 严格守住 470 行（预算 500 行）。
- **`TiptapSlashMenu.module.css`**：局部内容层 6px 浮现（向上 `translateY(6px)` / 向下 `translateY(-6px)`，150ms），保护 Floating UI 绝对坐标不被覆盖；条目 active 微缩放。
- **`ChatStatusRibbons.module.css` & `ComposerErrorBar.module.css`**：药丸入场缩放克制至 1.5%（`scale(0.985)`），绿点光晕呼吸；补齐 `@keyframes errorBarIn`。
- **`useUserBubbleEntrance.ts`**（新建独立 Hook）：双向时间窗口守卫（$-500\text{ms} \le \Delta < 2000\text{ms}$）、500 槽 FIFO Ring Set 确保虚拟滚动 Exactly-Once 动效，`animationend` 瞬间卸载 `will-change` 释放 GPU 图层。
- **`ChatUserMessageRow.tsx` & `ChatMessageRow.module.css`**：无损接入 `useUserBubbleEntrance`，14px Glide Up + 220ms 缓动升起；`ChatUserMessageRow.tsx` 严格守住 466 行（预算 500 行）。

### 4. Batch 4：超链接排版标识与全局微交互收口（100%）

- **`markdown-typography.css`**：超链接统一科技蓝（Light: `#2563eb`, Dark: `#60a5fa`），下划线升级为防缠绕虚线（`underline dashed`, 3px 偏移），悬停升级为实线；纯 CSS Unicode `\a0↗` 物理防孤行外链角标。
- **`DiffCard.module.css` / `OverviewCard.module.css` / `TiptapEditorField.module.css`**：非 Markdown 超链接全量统一绑定至 `var(--link-color)` 与虚线下划线。
- **`ThinkingBlock.tsx` & `markdownSanitizer.ts`**：思维链折叠与展开统一挂载 `md-rendered` 命名空间；收敛安全外链跳转 SSOT（`handleSafeExternalLinkClick`），杜绝 WebView2 白屏逃逸。
- **`ChatToolCallBlock.module.css` & `FoldableToolGroup.tsx`**：以现代 CSS Grid `grid-template-rows: 0fr -> 1fr` 彻底替代历史 `max-height: 2000px` 伪动画；解除 `hidden="until-found"` 阻断动画的竞态，折叠过渡完毕后延迟挂载。
- **`ReasoningRow.tsx` & `.module.css`**：模型思考结束时两阶段平滑收拢（160ms CSS Grid `1fr -> 0fr`），**严格 0 处 `NODE_ENV === 'test'` 旁路分支作弊**，单测 23/23 全绿。
- **`useSidebarResize.ts` & `Sidebar.module.css`**：侧栏拖拽松手时通过 `requestAnimationFrame` 延迟移除 `is-resizing`，彻底解耦 0 延迟连续拖拽与 200ms 离散折叠动画，消灭回弹抖动。

### 5. Batch 5：滚动锚定守卫锁、平铺死角与交互润色全量收口（100%）

- **滚动锚定与向下自然展开（核心用户要求）**：
  - `useScrollAnchoringOnToggle.ts` & `MessageVirtualizer.tsx`：注入 500ms 锚定守卫锁（`ANCHOR_GUARD_LOCK_WINDOW_MS = 500`，`isAnchorLocked()`）。无论用户当前是否处于最新区域，点击折叠/展开（思维链、工具组、代码卡片等）时，严格锁定当前点击位置自然向下展开，**彻底消灭被强制吸底/强制看到全部内容的跳跃**。新提问到来时安全解除锁定恢复吸底。`chat-message-list` 18 套件 121/121 测试全绿！
- **空态页面与非合成层 will-change 优化**：
  - `design-system.css` 声明正典 `@keyframes crish-fade-in` 与 `@keyframes crish-fade-out`；
  - `WorkspaceEmptyState.module.css` 彻底清退 `cds-fade-*` 幽灵引用；
  - `PaneHeader.module.css` 剥离 `will-change: flex-basis, width;`，消除非合成层栅格失效。
- **动画时序早夭与 Switch 果冻形变重构**：
  - `tabDragGhost.ts`：将 200ms `setTimeout` 纠正为 `280ms`，精准对齐 0.28s CSS 过渡，消灭拖拽松手早夭跳变；
  - `Switch.module.css`：将通过直接改变 `width` 导致的果冻重排形变，重构为纯 GPU 合成层的 `transform: scaleX(1.08) scaleY(0.95)`（160ms `var(--ease-emphasized)`），消除 Reflow 并保护既有测试断言。
- **弹窗与提示微缩放**：
  - `Dialog.module.css` & `Tooltip.module.css`：将 4%~5% 生硬弹跳收敛至 1.5% 精密微缩放（`scale(0.985)`），绑定 `--ease-decelerate` 与 `--ease-accelerate` 设计系统 Token。
- **侧栏手风琴与按压微反馈**：
  - `SidebarSessionList.module.css` & `PinnedSection.tsx` / `ProjectsSection.tsx` / `GeneralSection.tsx`：升级为 W3C CSS Grid `0fr -> 1fr` 160ms 平滑收展，解耦 `hidden` 属性阻断；
  - `SidebarNav.module.css`：新会话按钮注入 60ms `scale(0.985)` 按压触觉微反馈。
- **代码比对区与工作区切屏动效**：
  - `DiffCard.module.css`：注入 150ms `.diffPane` 淡入滑入与 140ms 搜索栏滑下；
  - `BinaryTreeWorkspace.module.css`：为活动叶子面板注入 120ms 无感交叉淡入（`panelCrossFadeIn`），彻底消除白屏闪烁。
- **问题登记册（DISCOVERED_ISSUES.md）全量审计与闭环**：
  - 12 项登记问题全部完成针对性修复、核验并归档留痕。

---

## 二、全仓立体门禁验证汇总（全绿）

1. **类型检查**：
   - `npm run typecheck` 👉 **Exit code 0（0 错误，全工作区包全通）**
2. **行数预算门禁（RL-03）**：
   - `npm run check:line-counts` 👉 **Scanned: 1379 files, Violations: 0, Hard blocks: 0（100% 达标）**
   - `ChatComposer.tsx`: 470/500 行
   - `ChatUserMessageRow.tsx`: 466/500 行
   - `MessageVirtualizer.tsx`: 476/476 行
3. **Rust 内核门禁**：
   - `cargo check --workspace --locked` 👉 **Exit code 0（0 错误）**
4. **单测套件验证（全绿）**：
   - `styles/` 套件：11 个文件，162/162 测试 100% 通过（含双向阻尼契约、裸色混清零等）
   - `chat-message-list/` 套件：18 个测试文件，121/121 测试全绿（含滚动锚定 500ms 守卫锁契约）
   - `sidebar/` 套件：14 个测试文件，97/97 测试全绿（含手风琴 Grid 与按压触觉反馈）
   - `diff/` & `binary-tree/` 套件：30 个测试文件，207/207 测试全绿
   - `ui/` 组件套件：Menu (72/72), Select (40/40), SmartExpandablePanel (44/44), Switch (40/40), Dialog & Tooltip (84/84) 全绿
   - `workspace/` 套件：60 个测试文件，566/566 测试全绿
5. **安全与红线检查**：
   - `reference/` 测试资产：`git status --porcelain reference/` 严格为空（0 变更）
   - 零向下兼容别名（彻底清退 `cds-*`）
   - 零硬编码（全部绑定 CSS Tokens）
   - 零 `!important`（组件样式表内 0 处新增）
   - 零测试环境作弊分支（0 处 `NODE_ENV === 'test'`）
   - **零 Git Commit**：所有改动完好保存在本地工作区，等待用户检阅后授权统一提交！
