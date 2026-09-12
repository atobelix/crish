# 12 · CSS 合成与动画热点扫描素材

> 日期：2026-09-12  
> 范围：`apps/crish-desktop/src/**/*.css`（151 个 CSS 文件，合计约 955 KiB）  
> 方法：静态扫描 + 重点走读；未做 DevTools Layers 面板实测（单列运行时验证）。

## 1. 属性计数总览

| 属性 | 命中行数（约） | 备注 |
| ---- | -------------- | ---- |
| `box-shadow:` | 389 | 分布极广；多数为静态装饰，少数在动画中 |
| `animation:` | 120 | 含 keyframes 引用与无害静态 |
| `@keyframes` | 78 | |
| `will-change` | 19 | 部分常驻（非仅动画期） |
| `contain:` | 20 | 聊天行 / 侧栏行 / 工具块等隔离，偏正面 |
| `backdrop-filter` | 17（含 -webkit-） | 10 个物理规则站点；Dialog blur 最重 |
| `content-visibility` | 极少 | 明确策略：聊天行禁止 cv-auto（DEF-14） |

## 2. will-change 全量清单（19 处）

| 文件:行 | 声明 | 评估 |
| ------- | ---- | ---- |
| `streaming-animation.css:31` | `[data-conex-animate], [data-sd-animate] { will-change: opacity, transform }` | **热路径**：每个动画词 span 常驻将提升合成层；流式高 TPS 时层膨胀风险 |
| `streaming-animation.css:65` | TURBO 容器 `will-change: transform` | 可接受（容器级） |
| `StreamingTableContainer.module.css:107` | 活跃单元格 `will-change: outline-color, box-shadow, background-color` | **反模式**：paint-only 属性 will-change 不能上合成层，只提示浏览器持续脏化 |
| `ChatToolCallBlock.module.css:151` | `transform, opacity` | 展开动画期合理；需确认是否仅 .isAnimating |
| `SidebarSessionList.module.css:302` | `.sessionItemWrap { will-change: transform }` | **常驻**：每行一个持久层；会话数百条时 GPU 内存/层数压力 |
| `SidebarSessionList.module.css:625` | `.sidebarDragGhost` | 单元素拖拽幽灵，可接受 |
| `ToastStackModern.module.css:95` | `transform, opacity, height` | height 进 will-change 无益；布局动画应避免 |
| `Tabs.module.css:120` | indicator `transform, width, height, opacity` | width/height 为布局属性，will-change 不促进合成 |
| `Switch.module.css:164` | `transform, width` | 同上 width |
| `PreviewCard.module.css:9` (ui) | `transform, opacity` | 轻量，可接受 |
| `PaneHeader.module.css:107` | `flex-basis, width` | **反模式**：布局属性 will-change |
| `BinaryTreeWorkspace.module.css:134` | `left, width, top, height` | **反模式**：四布局属性；拖拽浮层短期，需确认生命周期 |
| `sessionTabDrag.module.css:86` | `transform, opacity` | 拖拽期，可接受 |
| `SegmentedControl.module.css:127` | `transform, width, opacity` | 含 width |
| `ScrollArea.module.css:173/224` | `transform` | 滚动条 thumb，可接受 |

## 3. backdrop-filter 热点

| 站点 | 强度 | 场景 |
| ---- | ---- | ---- |
| `Dialog.module.css:18-26` | blur(16–20px)+saturate | 模态遮罩，全屏级 GPU 采样；短暂可接受 |
| `ChatComposer.module.css:823/860/890` | blur(4–8px) | **常驻底栏**（composer 始终可见）——与消息滚动同屏时持续合成 |
| `ChatCard.module.css:208` | blur(8px) | 顶栏粘性区域，常驻 |
| `AttachmentCard.module.css:241/271` | blur(4px) | 附件卡局部 |
| `FileAnnotationPopover.module.css:28` | blur(16px) | 浮层短暂 |

## 4. 布局属性动画（非合成友好）

| 文件:行 | 属性 | 影响 |
| ------- | ---- | ---- |
| `ToastStackModern.module.css:90-95` | height 0.18s | 每条 toast 展开触发 layout |
| `DiffCard.module.css:681` | max-height | 展开折叠强制 layout |
| `Sidebar.module.css:9` | width spring | 侧栏 resize 期整树 reflow |
| `NoteSidebarDrawer.module.css:13` | width | 抽屉展开 |
| `PlanGoalRibbons / AgentCard / ApprovalAskCard / Slider / ModelDistribution` | width | 进度条类可接受但应 scaleX 替代 |
| `FlowScrubber.module.css:170` | top 100ms | 滚动 scrubber 与消息列表滚动同步时双重布局 |
| `SidebarSessionList.module.css:600` | height | drop indicator |
| `ChatComposer.module.css:367` | padding 200ms | composer 形态切换 |

## 5. 内容可见性与 contain（正面为主）

- `ChatMessageRow.module.css:9-10`：注释明确剔除 `content-visibility` / `contain-intrinsic-size`，行级 `contain: layout paint`——与 JS 虚拟化单轨一致，**禁止回潮 cv-auto**（`streaming-animation.css:127-128` 有假高坍塌事故注释）。
- `SidebarSessionList.module.css:301`：行 `contain: strict`（含 size）——固定 28px 行高前提下正确。
- `SettingsUI.module.css:59`：设置区 `content-visibility: auto`——低频面板合理。
- `ChatToolCallBlock.module.css:405`：`contain: content` 于工具输出体。
- 聊天滚动容器 `ChatMessageList.module.css:13-28`：唯一 `overflow-y: auto`（DIM-02 契约），`overflow-anchor: none` 防浏览器锚定干扰虚拟化——正面。

## 6. 流式动画细节

`streaming-animation.css`：
- 单词级 fade-in 使用 opacity+transform（合成友好），但 `will-change` 挂在**每一个** animate span（28-37 行）。
- 打字机光标 opacity 无限循环动画（80-90 行）；eco/reduced-motion 已静止（100-121）。
- 封口块 `contain: layout style paint` + `content-visibility: visible`（131-135）——与 DEF-14 一致。

`StreamingTableContainer.module.css:83-123`：
- 表格流式「呼吸脉冲」`md-table-pulse` 1.6s **infinite**，同时动 outline-color / box-shadow / background-color——主线程 paint 热点；eco 已关闭。

## 7. box-shadow 面量

389 处声明；聊天热路径常见多层阴影（如 ToastStackModern 86-87 双层）。静态阴影本身可接受（一次 paint），但与 hover transition 叠加时每帧重绘阴影区域。Diff / ModernToolCall 等卡片阴影密集。

## 8. 修复方向速记

1. 流式 animate span：动画结束后移除 will-change，或改用 `animation` 一次性 + 不设 will-change（Chromium 对 animation 自动提升）。
2. 全部布局属性 will-change 清单逐条改为 transform/opacity 或删除。
3. 表格脉冲改 opacity/transform 伪元素，或仅边框色 transition 无 infinite。
4. Toast/Tabs 用 transform 占位高度（scaleY 或 content wrapper）替代 height/will-change。
5. Composer 常驻 blur 可考虑 `data-perf-tier=eco` 降级为半透明纯色。
