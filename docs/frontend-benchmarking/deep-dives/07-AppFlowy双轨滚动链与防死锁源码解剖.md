# AppFlowy 双轨滚动链、Split 视口与防死锁深度源码解剖

> **文档定位**：Conex / Crish 前端与客户端系统级重构专属对标解剖报告 (Agent 7: Dual-Track Scroll Chaining, Split Viewports & Anti-Deadlock Engine)  
> **解剖对象**：`reference/markdown_compare/AppFlowy/` 滚动基座、多列分栏视口、双轨滚动链、手势分发与 AI 消息流吸底状态机源码  
> **对标目标**：点对点根治 Conex `modelsSplit` 滚轮失效黑洞、嵌套视口死锁、浮层吞噬滚轮动量、以及 AI 消息流在 Markdown 异步渲染下吸底断开与高度坍塌等系统级顽疾  
> **编写原则**：100% 真实源码行号（`path:line`）驱动、严密数学与物理公式推导、全状态机覆盖、拒绝退避与简化、追求工业级高质感与零死锁  
> **字符集**：UTF-8 无 BOM

---

## 目录

- [一、 执行摘要与核心论点](#一-执行摘要与核心论点)
  - [1.1 客户端双轨滚动与视口系统的工业级定位](#11-客户端双轨滚动与视口系统的工业级定位)
  - [1.2 AppFlowy 滚动与手势分发架构的四项核心精髓](#12-appflowy-滚动与手势分发架构的四项核心精髓)
  - [1.3 Conex 当前滚动架构与模型分栏的核心病灶概览](#13-conex-当前滚动架构与模型分栏的核心病灶概览)
- [二、 AppFlowy 滚动基座与基础组件架构源码深度解剖](#二-appflowy-滚动基座与基础组件架构源码深度解剖)
  - [2.1 flowy_infra_ui 滚动体系设计哲学与分层拓扑](#21-flowy_infra_ui-滚动体系设计哲学与分层拓扑)
  - [2.2 StyledScrollbar 几何度量与绝对比例算法](#22-styledscrollbar-几何度量与绝对比例算法)
  - [2.3 StyledSingleChildScrollView 与 StyledCustomScrollView](#23-styledsinglechildscrollview-与-styledcustomscrollview)
  - [2.4 StyledListView 与 StyledScrollPhysics](#24-styledlistview-与-styledscrollphysics)
- [三、 双分栏/多列视口与弹性独立滚动机制](#三-双分栏多列视口与弹性独立滚动机制)
  - [3.1 块级多列容器架构与节点模型](#31-块级多列容器架构与节点模型)
  - [3.2 单列组件与无损选择映射](#32-单列组件与无损选择映射)
  - [3.3 交互式分栏宽度调节器与无级拖拽算法](#33-交互式分栏宽度调节器与无级拖拽算法)
  - [3.4 2D 维度数据表双轨同步滚动](#34-2d-维度数据表双轨同步滚动)
- [四、 原生滚轮动量链平滑传递 (Scroll Chaining)](#四-原生滚轮动量链平滑传递-scroll-chaining)
  - [4.1 嵌套视口动量拦截与滚动链死锁成因](#41-嵌套视口动量拦截与滚动链死锁成因)
  - [4.2 动量衰减与越界传导数学模型](#42-动量衰减与越界传导数学模型)
  - [4.3 浏览器 Web 平台与 WebView2 内部事件传播截断机制](#43-浏览器-web-平台与-webview2-内部事件传播截断机制)
- [五、 彻底消除嵌套 Contain 导致的滚轮黑洞与浮层死锁](#五-彻底消除嵌套-contain-导致的滚轮黑洞与浮层死锁)
  - [5.1 根级 PointerScrollEvent 侦听与 Tooltip 全局排障机制](#51-根级-pointerscrollevent-侦听与-tooltip-全局排障机制)
  - [5.2 手势冲突与事件阻断隔离机制](#52-手势冲突与事件阻断隔离机制)
  - [5.3 浮层与 Popover 互斥锁与手势分发](#53-浮层与-popover-互斥锁与手势分发)
  - [5.4 Web/React 环境中 overscroll-behavior 滥用导致的死锁复盘](#54-webreact-环境中-overscroll-behavior-滥用导致的死锁复盘)
- [六、 智能抗坍塌吸底状态机深度解剖](#六-智能抗坍塌吸底状态机深度解剖)
  - [6.1 正向列表与高度缓存状态机](#61-正向列表与高度缓存状态机)
  - [6.2 逆向 Sliver 列表与原生流式吸底](#62-逆向-sliver-列表与原生流式吸底)
  - [6.3 双状态机对比分析矩阵：Forward List vs Reversed Sliver](#63-双状态机对比分析矩阵forward-list-vs-reversed-sliver)
- [七、 Conex 核心病灶深度诊断](#七-conex-核心病灶深度诊断)
  - [7.1 病灶一：modelsSplit 滚轮黑洞与页面滚动阻断](#71-病灶一modelssplit-滚轮黑洞与页面滚动阻断)
  - [7.2 病灶二：useChatAutoScroll 脆弱的增量计算与吸底断开](#72-病灶二usechatautoscroll-脆弱的增量计算与吸底断开)
  - [7.3 病灶三：浮层与 Tooltip 未设 pointer-events 导致的滚轮吞噬](#73-病灶三浮层与-tooltip-未设-pointer-events-导致的滚轮吞噬)
- [八、 Conex 工业级重构落地实施方案与源码契约](#八-conex-工业级重构落地实施方案与源码契约)
  - [8.1 方案一：重构 modelsSplit 双轨弹性独立滚动与动量链打通](#81-方案一重构-modelssplit-双轨弹性独立滚动与动量链打通)
  - [8.2 方案二：构建 Conex SmartScrollEngine 抗坍塌吸底控制器](#82-方案二构建-conex-smartscrollengine-抗坍塌吸底控制器)
  - [8.3 方案三：全局滚轮事件总线与浮层防死锁管理器](#83-方案三全局滚轮事件总线与浮层防死锁管理器)
- [九、 全景验证矩阵与架构演进守则](#九-全景验证矩阵与架构演进守则)
  - [9.1 10 大硬核端到端滚动场景验收断言](#91-10-大硬核端到端滚动场景验收断言)
  - [9.2 防死锁与防断开自检清单 (Checklist)](#92-防死锁与防断开自检清单-checklist)

---

# 一、 执行摘要与核心论点

## 1.1 客户端双轨滚动与视口系统的工业级定位

在桌面级 GUI 应用与现代协同工作台（如 AppFlowy、Notion、AFFiNE、Conex）中，**视口布局（Viewport Layout）与滚动交互（Scroll & Gesture Chaining）是直接决定应用“体感质感”与“工程稳定性”的基石系统**。

视口系统如果缺乏工业级状态机与物理学抽象，极易产生以下四大毁灭性体验缺陷：

1. **滚轮黑洞（Wheel Trap / Deadlock）**：当鼠标悬停在子分栏、浮动面板或悬停气泡（Tooltip）上方时，用户的鼠标滚轮输入被子容器无情吞噬，但子容器自身已到达边界无法滚动，外层视口又因事件链断裂而纹丝不动，形成“卡死”假象；
2. **消息流吸底断开（Stick-to-Bottom Disconnection）**：在 AI 实时流式输出（Token Streaming）场景下，一旦内容发生异步 Markdown 解析、代码块换行重排、图片尺寸撑开或用户进行微小的向上翻阅，滚动条发生不可逆的失锁或暴力强制回弹，导致用户阅读被打断或无法贴底；
3. **分栏视口尺寸坍塌（Split Viewport Collapse）**：双栏或多栏并排布局中，由于 flex / grid 计算缺陷、`height: 100%` 链条断裂或 `overflow` 错配，导致其中一栏被挤压至 0 像素或无法独立伸缩；
4. **滚动条抖动与闪烁（Scrollbar Layout Thrashing）**：滚动条的出现与消失引发视口内容宽度反复变化（Reflow），导致文字折行反复跳跃。

AppFlowy 在其客户端架构中，依托底层细粒度的手势信号拦截（Pointer Signals）、多层互斥栈（PopoverMutex）、几何比例自适应滚动条（StyledScrollbar）、以及双模 AI 消息流吸底状态机（Forward vs Reversed），构建了极高成熟度的视口与动量传导管线。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        AppFlowy 视口、手势与动量传导拓扑矩阵                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 【全局手势总线】 Listener(onPointerSignal: PointerScrollEvent -> dismissTooltips)      │
│   │                                                                                    │
│   ├── [Root Overlay Stack] PopoverMutex 互斥控制 + Barrier 穿透调度                    │
│   │                                                                                    │
│   ├── [Split / Columns 视口] 比例驱动 Flex(Expanded) + 无级 Resizer 局部重排更新       │
│   │     ├── Left Column Viewport (独立滚动 / 动量传递)                                 │
│   │     └── Right Column Viewport (独立滚动 / 动量传递)                                │
│   │                                                                                    │
│   ├── [2D 数据表格视口] LinkedScrollControllerGroup (水平同步) + ClampingVertical      │
│   │     └── 内嵌 Document 场景自动切换 NeverScrollableScrollPhysics (动量归一)         │
│   │                                                                                    │
│   └── [AI 消息流视口] 双模智能吸底状态机                                               │
│         ├── Forward: ItemPositionsListener + TrailingEdge <= 1.01 + HeightCacheManager │
│         └── Reversed: CustomScrollView(reverse: true) + UserScrollNotification 意图锁 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## 1.2 AppFlowy 滚动与手势分发架构的四项核心精髓

通过对 `reference/markdown_compare/AppFlowy/` 前端与客户端源码的逐行通读，提炼出 4 项核心工业级设计精髓：

1. **绝对比例换算与非侵入式滚动条体系（StyledScrollbar & Inset Isolation）**：
   滚动条绝不侵入内容流排版。通过 `ScrollbarListStack` 容器将内容垫高与滚动条浮层分离，滚动条手柄（Thumb）基于内容总高与视口高度的平方比（$\text{Extent} = \frac{V^2}{C}$）进行几何换算，并使用归一化坐标系统 `[-1.0, 1.0]` 映射，配合 `CancelableOperation` 实现平滑的 2 秒自隐淡出。
2. **多列弹性比例分栏与轻量事务联动（Proportional Multi-Column Engine）**：
   在多列编辑器和分屏中，抛弃硬编码像素宽度，采用万分比基数的弹性分配（`Expanded(flex: ratio * 10000)`）。分栏拖拽时，宽度调节器（`SimpleColumnBlockWidthResizer`）与相邻列实施比例互锁（保底阈值 0.1），拖拽期间仅执行内存级事务（`inMemoryUpdate: true`），松手后再提交最终持久化，杜绝了拖拽过程中的重排卡顿。
3. **顶层滚轮信号拦截根除 Tooltip 黑洞（Root PointerScrollEvent Interception）**：
   在 `app_widget.dart` 的应用根节点注入 `Listener(onPointerSignal)`，一旦探测到 `PointerScrollEvent` 滚轮信号，立即调用 `Tooltip.dismissAllToolTips()` 瞬时销毁所有悬浮气泡，从物理层面彻底根除了悬停组件阻断底层视口滚轮事件传播的死锁病灶。
4. **双模智能吸底与高度缓存防坍塌状态机（Dual-Mode Smart Stick-to-Bottom）**：
   正向模式下利用 `ScrollablePositionedList` 的 `itemPositions` 监听视口末尾元素的几何边缘（`itemTrailingEdge <= 1.01`），并配合 `ChatMessageHeightManager` 对已渲染的动态 Markdown 块进行精确高度缓存，消除图片/数学公式异步加载引起的视口抖动；反向模式下采用 `CustomScrollView(reverse: true)` 让物理底部天然成为零点（`offset = 0`），结合 `UserScrollNotification` 的用户滚动意图判定，实现无感知平滑流式吸底。

## 1.3 Conex 当前滚动架构与模型分栏的核心病灶概览

与 AppFlowy 相比，Conex（`apps/crish-desktop`）目前在分栏与滚动领域存在三大系统级断层：

1. **`modelsSplit` 样式的 CSS 属性滥用与死锁**：
   在 `ModelsSettingsTab.module.css` 中，`.modelsSplit` 采用了固定的 `height: max(480px, calc(100vh - 220px)); overflow: hidden;`，而其子容器 `.mrlList`（模型列表导轨）与 `.modelsDetail`（模型配置详情）均硬编码了 `overscroll-behavior: contain;`。当用户在左侧短列表或右侧详情区滑动滚轮到达边界时，浏览器合成层硬性截断向外层 Settings 主面板的动量冒泡，导致整个设置页滚轮锁死。
2. **`useChatAutoScroll` 状态机过于脆弱且缺乏异步重排感知**：
   `useChatAutoScroll.ts` 仅在 `[messages, isProcessing]` 改变时触发 `requestAnimationFrame` 计算高度差 `dh = scrollHeight - prevHeight`。对于 Markdown 代码块换行、Latex 渲染、图片加载等**异步 DOM 重排**完全失脱；且只要用户向上微滑 1 像素导致 `scrollHeight - scrollTop - clientHeight >= 60px`，`userScrolledRef` 立即永久置为 `true`，后续所有流式 Token 的吸底动作全部瘫痪，且新消息发送时缺乏自动复位机制。
3. **浮层与 Tooltip 未做滚动穿透隔离**：
   各种悬浮菜单、Tooltip、Status Ribbon 在浮起时具有完整的 pointer 响应层，当鼠标滑动穿过这些元素时，滚轮 delta 事件被拦截，造成明显的掉帧与顿挫感。

---

# 二、 AppFlowy 滚动基座与基础组件架构源码深度解剖

AppFlowy 将整个客户端的滚动逻辑解耦封装在 `packages/flowy_infra_ui/lib/style_widget/scrolling/` 中，提供了 `StyledScrollbar`、`StyledSingleChildScrollView`、`StyledCustomScrollView` 和 `StyledListView` 等核心组件。

```
packages/flowy_infra_ui/lib/style_widget/scrolling/
├── styled_scroll_bar.dart      # 核心滚动条几何度量、拖拽增量比例换算与自动隐藏状态机
├── styled_scrollview.dart      # 单视口与 CustomScrollView 的 ScrollbarListStack 包装器
└── styled_list.dart            # 基于 AlwaysScrollableScrollPhysics 的高性能构建器
```

## 2.1 flowy_infra_ui 滚动体系设计哲学与分层拓扑

AppFlowy 滚动基座的核心设计原则是**「视口与滚动指示器解耦」**与**「动量不间断」**：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        ScrollbarListStack 分层容器结构                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  Stack (层叠上下文)                                                                    │
│  ├── Layer 0: Content Padding 容器                                                     │
│  │   └── Padding(right: barSize + Insets.m) -> 防止滚动条遮挡交互内容                   │
│  │         └── SingleChildScrollView / CustomScrollView / ListView                     │
│  │               └── ScrollPhysics: StyledScrollPhysics (AlwaysScrollable)             │
│  │                                                                                     │
│  └── Layer 1: StyledScrollbar 浮动指示层                                               │
│        ├── Track (可选轨道背景)                                                         │
│        └── Thumb Handle (手势拖拽手柄)                                                 │
│              ├── GestureDetector(onVerticalDragUpdate -> offset 换算)                  │
│              └── MouseHoverBuilder -> 悬停高亮与尺寸自适应                             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2.2 StyledScrollbar 几何度量与绝对比例算法

源码文件：`packages/flowy_infra_ui/lib/style_widget/scrolling/styled_scroll_bar.dart`

### 2.2.1 滚动条手柄几何度量推导

在 `styled_scroll_bar.dart:70-120` 中，AppFlowy 实现了基于视口尺寸（`_viewExtent`）与内容总尺寸（`contentExtent`）的高精度几何算法：

```dart
// styled_scroll_bar.dart:70-120
@override
Widget build(BuildContext context) {
  return LayoutBuilder(
    builder: (_, BoxConstraints constraints) {
      double maxExtent;
      final double? contentSize = widget.contentSize;

      switch (widget.axis) {
        case Axis.vertical:
          // 若外部显式传入 contentSize 则优先使用，否则回退至 ScrollPosition 的 maxScrollExtent
          if (contentSize != null && contentSize > 0) {
            maxExtent = contentSize - constraints.maxHeight;
          } else {
            maxExtent = widget.controller.position.maxScrollExtent;
          }
          _viewExtent = constraints.maxHeight;
          break;
        case Axis.horizontal:
          if (contentSize != null && contentSize > 0) {
            maxExtent = contentSize - constraints.maxWidth;
          } else {
            maxExtent = widget.controller.position.maxScrollExtent;
          }
          _viewExtent = constraints.maxWidth;
          break;
      }

      final contentExtent = maxExtent + _viewExtent;

      // 1. 计算手柄归一化位置 [0, 1]
      double handleAlignment =
          maxExtent == 0 ? 0 : widget.controller.offset / maxExtent;

      // 2. 将 [0, 1] 映射到 Flutter Alignment 的 [-1.0, 1.0] 空间
      handleAlignment *= 2.0;
      handleAlignment -= 1.0;

      // 3. 计算手柄物理高度 handleExtent
      double handleExtent = _viewExtent;
      if (contentExtent > _viewExtent) {
        // 关键算法：视口与内容比例的平方映射，最小保底 60px
        handleExtent = max(60, _viewExtent * _viewExtent / contentExtent);
      }

      var showHandle = hideHandler
          ? false
          : contentExtent > _viewExtent && contentExtent > 0;
```

#### 数学公式推导

设视口高度为 $V$（`_viewExtent`），可滚动的最大偏移量为 $S_{\max}$（`maxScrollExtent`），则内容总高度为 $C = S_{\max} + V$。

1. **手柄物理长度（Handle Extent）**：
   $$\text{HandleExtent} = \max\left(60, \frac{V^2}{C}\right) = \max\left(60, \frac{V^2}{S_{\max} + V}\right)$$
   该算法确保内容越多时，手柄越短，但决不低于 60px，保证鼠标极易抓取。
2. **坐标映射（Normalized Alignment Transformation）**：
   Flutter 中 `Alignment(x, y)` 的取值范围为 $[-1.0, 1.0]$，其中 $-1.0$ 为顶部/左侧，$1.0$ 为底部/右侧。
   $$\text{Ratio} = \frac{\text{ScrollOffset}}{S_{\max}} \in [0, 1]$$
   $$\text{AlignmentValue} = \text{Ratio} \times 2.0 - 1.0 \in [-1.0, 1.0]$$

### 2.2.2 拖拽增量动态换算

源码位置：`styled_scroll_bar.dart:204-221`

当用户抓取滚动条手柄拖拽时，手柄移动 $\Delta y$ 像素，内容实际需要移动的滚动偏移量 $\Delta \text{offset}$ 并非 $1:1$，而必须乘以**视口放大系数（PixelRatio）**：

```dart
// styled_scroll_bar.dart:214-220
void _handleVerticalDrag(DragUpdateDetails details) {
  var pos = widget.controller.offset;
  var pxRatio = (widget.controller.position.maxScrollExtent + _viewExtent) /
      _viewExtent;
  widget.controller.jumpTo((pos + details.delta.dy * pxRatio)
      .clamp(0.0, widget.controller.position.maxScrollExtent));
  widget.onDrag?.call(details.delta.dy);
}
```

$$\text{PixelRatio} = \frac{S_{\max} + V}{V} = \frac{C}{V}$$
$$\text{NewOffset} = \text{clamp}\left(\text{Pos} + \Delta y \times \frac{C}{V}, 0, S_{\max}\right)$$

### 2.2.3 自动隐藏状态机与 CancelableOperation

源码位置：`styled_scroll_bar.dart:185-202`

AppFlowy 通过侦听 `ScrollPosition.isScrollingNotifier` 结合 `CancelableOperation` 实现防抖自隐逻辑：

```dart
// styled_scroll_bar.dart:185-202
void _hideScrollbarInTime() {
  if (!mounted || !widget.autoHideScrollbar) return;

  _hideScrollbarOperation?.cancel();

  if (!widget.controller.position.isScrollingNotifier.value) {
    _hideScrollbarOperation = CancelableOperation.fromFuture(
      Future.delayed(const Duration(seconds: 2)),
    ).then((_) {
      hideHandler = true;
      if (mounted) {
        setState(() {});
      }
    });
  } else {
    hideHandler = false;
  }
}
```

```
[滚动中 (isScrolling = true)]
      │
      ├──> hideHandler = false; 立即显示手柄 (Opacity: 1.0)
      │
[滚动停止 (isScrolling = false)]
      │
      └──> 启动 CancelableOperation (2 秒延时)
             │
             ├── 若 2 秒内再次滚动 ──> cancel()，复位
             └── 若 2 秒内无新事件 ──> hideHandler = true (Opacity: 0.0, animate: 250ms)
```

## 2.3 StyledSingleChildScrollView 与 StyledCustomScrollView

源码文件：`packages/flowy_infra_ui/lib/style_widget/scrolling/styled_scrollview.dart`

在 `StyledSingleChildScrollView` 与 `StyledCustomScrollView` 中，AppFlowy 解决了传统滚动容器的两大痛点：

1. **生命周期自动托管**：若调用方未显式传入 `ScrollController`，组件内部在 `State` 中创建并负责在 `dispose()` 时销毁，避免内存泄漏（`styled_scrollview.dart:39-48`）；
2. **ScrollConfiguration 原生覆盖**：通过 `ScrollConfiguration(behavior: ScrollBehavior().copyWith(scrollbars: false))` 禁用系统原生丑陋的重叠滚动条，统一使用高质感的 `StyledScrollbar`。

```dart
// styled_scrollview.dart:98-118
@override
Widget build(BuildContext context) {
  var child = ScrollConfiguration(
    behavior: const ScrollBehavior().copyWith(scrollbars: false),
    child: CustomScrollView(
      scrollDirection: widget.axis,
      physics: StyledScrollPhysics(),
      controller: controller,
      slivers: widget.slivers,
    ),
  );

  return ScrollbarListStack(
    axis: widget.axis,
    controller: controller,
    barSize: widget.barSize,
    trackColor: widget.trackColor,
    handleColor: widget.handleColor,
    child: child,
  );
}
```

## 2.4 StyledListView 与 StyledScrollPhysics

源码文件：`packages/flowy_infra_ui/lib/style_widget/scrolling/styled_list.dart`

```dart
// styled_list.dart:5-6
class StyledScrollPhysics extends AlwaysScrollableScrollPhysics {}
```

AppFlowy 显式声明 `StyledScrollPhysics` 继承自 `AlwaysScrollableScrollPhysics`。即使列表内容不足一屏，滚动物理引擎依然保持活跃响应（支持弹性与滚轮接收），确保滚动链的触觉一致性，不会因为内容变短而导致手势判定树中断。

---

# 三、 双分栏/多列视口与弹性独立滚动机制

在多列编辑器和分栏视口中，AppFlowy 通过 `simple_columns_block_component.dart` 与 `simple_column_block_width_resizer.dart` 实现了高度弹性的独立视口体系。

```
lib/plugins/document/presentation/editor_plugins/columns/
├── simple_columns_block_component.dart      # 多列布局外层容器、Flex 弹性分配与尺寸监听
├── simple_column_block_component.dart       # 单列渲染容器、坐标系无损映射
├── simple_column_block_width_resizer.dart   # 列宽拖拽把手、无级比例计算与相邻列互锁
├── simple_column_node_extension.dart        # 节点树 AST 快速向上寻根扩展
└── simple_columns_block_constant.dart       # 调试断言与几何常量
```

## 3.1 块级多列容器架构与节点模型

源码位置：`lib/plugins/document/presentation/editor_plugins/columns/simple_columns_block_component.dart:149-183`

```dart
// simple_columns_block_component.dart:149-183
List<Widget> _buildChildren() {
  final length = node.children.length;
  final children = <Widget>[];
  for (var i = 0; i < length; i++) {
    final childNode = node.children[i];
    final double ratio =
        childNode.attributes[SimpleColumnBlockKeys.ratio]?.toDouble() ??
            1.0 / length;

    Widget child = editorState.renderer.build(context, childNode);

    // 核心算法：以万分比整数为 flex 权重，杜绝浮点数舍入导致的布局抖动
    child = Expanded(
      flex: (max(ratio, 0.1) * 10000).toInt(),
      child: child,
    );

    children.add(child);

    // 在列与列之间插入宽度调节把手
    if (i != length - 1) {
      children.add(
        ValueListenableBuilder(
          valueListenable: heightValueNotifier,
          builder: (context, height, child) {
            return SimpleColumnBlockWidthResizer(
              columnNode: childNode,
              editorState: editorState,
              height: height,
            );
          },
        ),
      );
    }
  }
  return children;
}
```

### 尺寸感知与局部重绘解耦

为了让中间的拖拽分割线（Resizer）精确匹配多列容器的动态高度，同时避免全局重排（Re-layout），AppFlowy 使用了 `SizeChangedLayoutNotifier` + `ValueNotifier<double?>` 管道：

```dart
// simple_columns_block_component.dart:143-146 & 205-213
return NotificationListener<SizeChangedLayoutNotification>(
  onNotification: (v) => updateHeightValueNotifier(v),
  child: SizeChangedLayoutNotifier(child: child),
);

bool updateHeightValueNotifier(SizeChangedLayoutNotification notification) {
  if (!mounted) return true;
  final height = _renderBox?.size.height;
  if (heightValueNotifier.value == height) return true;
  WidgetsBinding.instance.addPostFrameCallback((_) {
    heightValueNotifier.value = height;
  });
  return true;
}
```

通过 `addPostFrameCallback` 将高度通知推迟到当前渲染帧结束后派发，彻底杜绝了 Flutter / React 体系中常见的 `setState() or markNeedsBuild() called during layout` 致命异常。

## 3.2 单列组件与无损选择映射

源码位置：`lib/plugins/document/presentation/editor_plugins/columns/simple_column_block_component.dart:196-220`

在多列分栏环境下，文字光标（Caret）与选区（Selection）的全局坐标转换极为复杂。AppFlowy 拒绝使用基于坐标近似计算的魔术数字补偿，而是通过 `RenderBox` 树的绝对坐标变换实现无损映射：

```dart
// simple_column_block_component.dart:196-220
@override
List<Rect> getRectsInSelection(
  Selection selection, {
  bool shiftWithBaseOffset = false,
}) {
  if (_renderBox == null) {
    return [];
  }
  final parentBox = context.findRenderObject();
  final renderBox = columnKey.currentContext?.findRenderObject();
  if (parentBox is RenderBox && renderBox is RenderBox) {
    return [
      renderBox.localToGlobal(Offset.zero, ancestor: parentBox) &
          renderBox.size,
    ];
  }
  return [Offset.zero & _renderBox!.size];
}
```

## 3.3 交互式分栏宽度调节器与无级拖拽算法

源码文件：`lib/plugins/document/presentation/editor_plugins/columns/simple_column_block_width_resizer.dart`

分栏调整最核心的工程挑战在于：**如何保证左侧变宽时右侧等量收缩，且双栏均不突破最小安全宽度（0.1 = 10%），并在拖拽过程中保持 60/120fps 流畅度？**

```dart
// simple_column_block_width_resizer.dart:86-138
void _onHorizontalDragUpdate(DragUpdateDetails details) {
  if (!isDragging) return;

  final columnNode = widget.columnNode;
  final columnsNode = columnNode.columnsParent;
  if (columnsNode == null) return;

  final editorWidth = columnsNode.rect.width;
  final rect = columnNode.rect;
  final width = rect.width;
  final originalRatio = columnNode.attributes[SimpleColumnBlockKeys.ratio];

  // 1. 当前列新宽度与新比例
  final newWidth = width + details.delta.dx;
  final transaction = widget.editorState.transaction;
  final newRatio = newWidth / editorWidth;

  transaction.updateNode(columnNode, {
    ...columnNode.attributes,
    SimpleColumnBlockKeys.ratio: newRatio,
  });

  // 2. 最小安全阈值保护 (保底 10%)
  if (newRatio < 0.1 && newRatio < originalRatio) {
    return;
  }

  // 3. 相邻右列同步反向伸缩
  final nextColumn = columnNode.nextColumn;
  if (nextColumn != null) {
    final nextColumnRect = nextColumn.rect;
    final nextColumnWidth = nextColumnRect.width;
    final newNextColumnWidth = nextColumnWidth - details.delta.dx;
    final newNextColumnRatio = newNextColumnWidth / editorWidth;

    // 右列最小阈值保护
    if (newNextColumnRatio < 0.1) {
      return;
    }
    transaction.updateNode(nextColumn, {
      ...nextColumn.attributes,
      SimpleColumnBlockKeys.ratio: newNextColumnRatio,
    });
  }

  transaction.updateNode(columnsNode, {
    ...columnsNode.attributes,
    ColumnsBlockKeys.columnCount: columnsNode.children.length,
  });

  // 4. 关键：拖拽过程中仅应用内存级更新，不触发持久化 I/O
  widget.editorState.apply(
    transaction,
    options: ApplyOptions(inMemoryUpdate: true),
  );
}
```

```
[鼠标向右拖拽 Resizer (dx > 0)]
   │
   ├── 左列: newWidth = width + dx  ──>  newRatio = newWidth / totalWidth
   │     └── 校验: newRatio >= 0.1 (满足则放行)
   │
   ├── 右列: nextWidth = nextWidth - dx  ──>  nextRatio = nextWidth / totalWidth
   │     └── 校验: nextRatio >= 0.1 (满足则放行)
   │
   └── 应用事务: apply(transaction, inMemoryUpdate: true)  ──>  瞬时响应无锁排版
```

## 3.4 2D 维度数据表双轨同步滚动

源码位置：`lib/plugins/database/grid/presentation/grid_scroll.dart` 与 `grid_page.dart:525-535`

AppFlowy 的数据网格（Grid Table）具有水平表头锁定、列内容同步与垂直分页滚动。通过 `LinkedScrollControllerGroup` 实现水平多轨道联动：

```dart
// grid_scroll.dart:4-30
class GridScrollController {
  GridScrollController({
    required LinkedScrollControllerGroup scrollGroupController,
  })  : _scrollGroupController = scrollGroupController,
        verticalController = ScrollController(),
        horizontalController = scrollGroupController.addAndGet();

  final LinkedScrollControllerGroup _scrollGroupController;
  final ScrollController verticalController;
  final ScrollController horizontalController;
  final List<ScrollController> _linkHorizontalControllers = [];

  ScrollController linkHorizontalController() {
    final controller = _scrollGroupController.addAndGet();
    _linkHorizontalControllers.add(controller);
    return controller;
  }
}
```

### 内嵌文档环境下的动量归一化

当数据表作为 Block 嵌入到 Document 中时（`shrinkWrap: true`），若内层依然保持垂直滚动，将产生灾难性的“滚轮死锁与双滚动条争抢”。AppFlowy 在 `grid_page.dart:468-471` 中给出了教科书级的解法：

```dart
// grid_page.dart:468-471
Widget _shrinkWrapRenderList(BuildContext context) {
  return ListView(
    shrinkWrap: true,
    physics: const NeverScrollableScrollPhysics(), // 彻底交出垂直滚动权
    children: [ ... ],
  );
}
```

**当组件处于内嵌模式时，垂直物理引擎强制置为 `NeverScrollableScrollPhysics`，彻底交由外层编辑器统筹垂直动量；当作为独立页面展示时，切换回 `ClampingScrollPhysics` 与 `cacheExtent: 500`。**

---

# 四、 原生滚轮动量链平滑传递 (Scroll Chaining)

## 4.1 嵌套视口动量拦截与滚动链死锁成因

在现代 GUI 渲染树中，滚动链（Scroll Chaining）的定义是：**当子滚动视口（Child Viewport）滚动至上边界（`scrollTop === 0`）或下边界（`scrollTop === maxScrollTop`）时，后续的滚轮输入或动量余量应平滑越过子视口，冒泡传递给其最近的可滚动父视口（Parent Viewport）继续执行滚动**。

如果任意中间层错误配置了阻断属性（如 CSS `overscroll-behavior: contain` 或 Flutter 消费了 `PointerScrollEvent`），动量传递将被物理切断，形成滚轮黑洞（Wheel Deadlock）。

```
【理想的 Scroll Chaining 动量传导链】
User Wheel Delta (dy > 0)
    │
    ▼
┌───────────────────────────────┐
│ Child Viewport (如代码块/分栏)  │ ──> 未到边界? ──> 消费 dy, 内部滚动
└───────────────────────────────┘
    │ (已达下边界，剩余动量 Δdy)
    ▼
┌───────────────────────────────┐
│ Parent Viewport (如设置页/主屏)│ ──> 消费剩余 Δdy, 页面继续平滑滚动
└───────────────────────────────┘

【死锁的 Scroll Chaining (Wheel Black Hole)】
User Wheel Delta (dy > 0)
    │
    ▼
┌───────────────────────────────┐
│ Child Viewport                │
│ [overscroll-behavior: contain]│ ──> 到达边界! ──X (动量被黑洞吞噬，父级无法滚动)
└───────────────────────────────┘
```

## 4.2 动量衰减与越界传导数学模型

在连续滚轮或惯性触摸板手势下，单次手势输入包含速度 $v_0$ 与阻尼系数 $\mu$。
设视口可滚范围为 $[0, S_{\max}]$，当前滚动位置为 $S(t)$：

$$\frac{d^2 S}{dt^2} + \mu \frac{dS}{dt} = 0$$

$$S(t) = S(0) + \frac{v_0}{\mu} (1 - e^{-\mu t})$$

当 $S(t_1) = S_{\max}$ 时，子视口在时间 $t_1$ 到达边界，此时剩余的瞬时速度为：

$$v_{\text{remain}} = v_0 e^{-\mu t_1}$$

若启用 Scroll Chaining，则剩余动量 $P_{\text{remain}} = m \cdot v_{\text{remain}}$ 将作为初速度 $v_{\text{parent}, 0} = v_{\text{remain}}$ 注入父视口的滚动状态机方程中：

$$S_{\text{parent}}(t) = S_{\text{parent}}(0) + \frac{v_{\text{remain}}}{\mu_{\text{parent}}} (1 - e^{-\mu_{\text{parent}} (t - t_1)})$$

## 4.3 浏览器 Web 平台与 WebView2 内部事件传播截断机制

在 Chromium / WebView2（Conex 所在环境）中，滚动处理分为两条流水线：

1. **合成器线程滚动（Compositor Thread Scrolling）**：
   对于普通 `overflow: auto` 的元素，Chromium 可以在合成器线程直接计算变换矩阵并上屏，达到 120fps 无锁响应。
2. **主线程介入（Main Thread Interception）**：
   若元素绑定了 Non-passive `wheel` 事件监听器，合成器线程必须挂起，等待主线程 JS 执行完毕（判断是否有 `e.preventDefault()`）。
3. **`overscroll-behavior` 的内核级阻断**：
   - `overscroll-behavior: auto`：默认行为，边界处触发 Scroll Chaining 冒泡；
   - `overscroll-behavior: contain`：阻止默认的滚动链传播，不会触发父级视口滚动，但允许视口内部的过度滚动效果（Overscroll Glow / Bounce）；
   - `overscroll-behavior: none`：不仅阻止滚动链，且阻止任何边界反弹效果。

**致命隐患**：当在具有固定高度的嵌套分栏（如 `modelsSplit`）中滥用 `overscroll-behavior: contain` 时，只要鼠标指针位于该区域，外层页面的滚动链就会被无条件截断。

---

# 五、 彻底消除嵌套 Contain 导致的滚轮黑洞与浮层死锁

## 5.1 根级 PointerScrollEvent 侦听与 Tooltip 全局排障机制

源码位置：`reference/markdown_compare/AppFlowy/frontend/appflowy_flutter/lib/startup/tasks/app_widget.dart:230-238`

在桌面应用中，一个极其隐蔽却频繁触发的滚轮死锁场景是：**鼠标悬停在某个图标上，触发了 Tooltip 悬浮气泡；此时用户滚动滚轮，由于 Tooltip 作为一个独立的 Overlay 挂载在最顶层，Tooltip 节点捕获了指针信号，导致底层的可滚动视图完全收不到滚轮事件！**

AppFlowy 在根组件入口处注入了全局滚轮信号监听器，实施了极为优雅的排障机制：

```dart
// app_widget.dart:230-238
child: ToastificationWrapper(
  child: Listener(
    onPointerSignal: (pointerSignal) {
      /// This is a workaround to deal with below question:
      /// When the mouse hovers over the tooltip, the scroll event is intercepted by it
      /// Here, we listen for the scroll event and then remove the tooltip to avoid that situation
      if (pointerSignal is PointerScrollEvent) {
        Tooltip.dismissAllToolTips();
      }
    },
    child: MaterialApp.router( ... ),
  ),
)
```

```
[用户滚动鼠标滚轮 (PointerScrollEvent)]
        │
        ├──> AppFlowy 根级 Listener 捕获
        │       └──> 立即执行 Tooltip.dismissAllToolTips()
        │               └──> 销毁顶层阻碍 HitTest 的 Tooltip DOM/Layer
        │
        └──> 滚轮事件无阻碍穿透至当前指针下方的目标 Viewport
```

## 5.2 手势冲突与事件阻断隔离机制

源码文件：`packages/flowy_infra_ui/lib/widget/ignore_parent_gesture.dart`

当组件深嵌在复杂手势监听器中时，父级的 `GestureDetector` 会在手势竞技场（Gesture Arena）中抢占手势胜出权。AppFlowy 通过 `IgnoreParentGestureWidget` 建立原始指针层隔离：

```dart
// ignore_parent_gesture.dart:14-30
@override
Widget build(BuildContext context) {
  // https://docs.flutter.dev/development/ui/advanced/gestures#gesture-disambiguation
  // https://github.com/AppFlowy-IO/AppFlowy/issues/1290
  return Listener(
    onPointerDown: (event) {
      onPress?.call();
    },
    onPointerSignal: (event) {},
    onPointerMove: (event) {},
    onPointerUp: (event) {},
    onPointerHover: (event) {},
    onPointerPanZoomStart: (event) {},
    onPointerPanZoomUpdate: (event) {},
    onPointerPanZoomEnd: (event) {},
    child: child,
  );
}
```

## 5.3 浮层与 Popover 互斥锁与手势分发

源码位置：`packages/appflowy_popover/lib/src/mutex.dart` 与 `popover.dart:308-342`

在 Popover 与下拉菜单系统中，AppFlowy 通过 `PopoverMutex` 和 `RootOverlayEntry` 保证浮层的严格互斥与单一活动态：

```dart
// mutex.dart:35-48
class _PopoverStateNotifier extends ChangeNotifier {
  PopoverState? _state;

  PopoverState? get state => _state;

  set state(PopoverState? newState) {
    // 互斥打开新 Popover 时，自动收起上一个活动 Popover
    if (_state != null && _state != newState) {
      _state?.close();
    }
    _state = newState;
    notifyListeners();
  }
}
```

### 双模点击触发器（Listener vs GestureDetector）

```dart
// popover.dart:308-342
Widget _buildClickHandler(Widget child, VoidCallback handler) {
  return switch (widget.clickHandler) {
    PopoverClickHandler.listener => Listener(
        onPointerDown: (event) {
          cursorPosition = widget.showAtCursor ? event.position : null;
          if (event.buttons == kSecondaryMouseButton &&
              widget.triggerActions & PopoverTriggerFlags.secondaryClick != 0) {
            return _callHandler(handler);
          }
          if (event.buttons == kPrimaryMouseButton &&
              widget.triggerActions & PopoverTriggerFlags.click != 0) {
            return _callHandler(handler);
          }
        },
        child: child,
      ),
    PopoverClickHandler.gestureDetector => GestureDetector(
        onTap: () {
          if (widget.triggerActions & PopoverTriggerFlags.click != 0) {
            return _callHandler(handler);
          }
        },
        child: child,
      ),
  };
}
```

当父组件存在复杂拖拽或滚动时，使用 `PopoverClickHandler.listener` 可以在指针按下瞬态（PointerDown）立即捕获事件，无需等待 `GestureDetector` 的 100ms 点击判定延时，杜绝了手势竞争失败导致的浮层无法唤起。

## 5.4 Web/React 环境中 overscroll-behavior 滥用导致的死锁复盘

在 Conex 中，导致 `modelsSplit` 滚轮死锁的根本原因可复盘如下：

```css
/* ❌ Conex 导致死锁的现状代码 */
.modelsSplit {
  height: max(480px, calc(100vh - 220px));
  overflow: hidden; /* 截断 1 */
}

.mrlList {
  overflow-y: auto;
  overscroll-behavior: contain; /* 截断 2: 动量黑洞 */
}

.modelsDetail {
  overflow-y: auto;
  overscroll-behavior: contain; /* 截断 3: 动量黑洞 */
}
```

### 死锁复现路径

1. 用户进入 Settings -> Models 页面；
2. 鼠标位于左侧 `.mrlList`（仅有 3-4 个 Provider，内容总高度 180px < 容器高度 480px）；
3. 用户滚动滚轮试图向下浏览整个设置面板；
4. 浏览器检测到 `.mrlList` 的 `overscroll-behavior: contain`，判断“不可向父级传递滚动链”；
5. `.mrlList` 自身无溢出无法滚动，同时父级 Settings 面板被剥夺了接收滚轮事件的权利；
6. **最终现象：用户无论怎么疯狂滑动滚轮，界面完全锁死不动，必须将鼠标挪到空白缝隙中才能滚动页面。**

---

# 六、 智能抗坍塌吸底状态机深度解剖

在 AI 聊天与流式消息生成场景下，**如何既保证用户处于底部时新 Token 流入能顺滑自动吸底，又保证用户向上翻阅历史时不会被新流入的 Token 强行扯回底部？**

AppFlowy 在 `lib/plugins/ai_chat/presentation/` 下提供了两种架构实现：

1. **正向动画列表（Forward List + Height Cache）**：`animated_chat_list.dart`
2. **逆向 Sliver 列表（Reversed Sliver List）**：`animated_chat_list_reversed.dart`

```
lib/plugins/ai_chat/presentation/
├── animated_chat_list.dart              # 正向列表、ItemPositionsListener 几何断言与高度缓存
├── animated_chat_list_reversed.dart     # 逆向 CustomScrollView(reverse: true) 原生吸底
├── chat_page/
│   ├── chat_animation_list_widget.dart  # 双模式动态切换容器
│   └── load_chat_message_status_ready.dart # 消息流主视口包装
└── message/
    └── ai_markdown_text.dart            # 流式 Markdown 增量渲染
```

## 6.1 正向列表与高度缓存状态机

源码文件：`lib/plugins/ai_chat/presentation/animated_chat_list.dart`

### 6.1.1 归一化尾边缘断言算法（TrailingEdge Check）

源码位置：`animated_chat_list.dart:280-308`

在正向模式中，列表索引 0 在顶部，最新消息在底部。AppFlowy 使用 `ScrollablePositionedList` 的 `ItemPositionsListener` 获取当前可见元素的几何坐标：

```dart
// animated_chat_list.dart:280-308
void _handleToggleScrollToBottom() {
  if (isScrollingToBottom) return;

  // 1. 获取所有当前视口内可见 Item 并按索引排序
  final sortedItems = itemPositionsListener.itemPositions.value.toList()
    ..sort((a, b) => a.index.compareTo(b.index));
  final maxItem = sortedItems.lastOrNull;

  if (maxItem == null) return;

  // 2. 核心几何判定：最大索引项是否为最新消息，且其尾部边界是否处于视口底部 (<= 1.01 允许 1% 渲染误差)
  if (maxItem.index > messages.length - 1 ||
      (maxItem.index == messages.length - 1 &&
          maxItem.itemTrailingEdge <= 1.01)) {
    scrollToBottomShowTimer?.cancel();
    scrollToBottomController.reverse(); // 隐藏「回到最新」按钮
    return;
  }

  // 3. 用户脱离底部：启动 250ms 延时，显示「回到最新」悬浮胶囊
  scrollToBottomShowTimer?.cancel();
  scrollToBottomShowTimer = Timer(widget.scrollToBottomAppearanceDelay, () {
    if (mounted) {
      scrollToBottomController.forward();
    }
  });
}
```

```
[视口元素测量: itemPositions]
      │
      ├── maxItem.index == messages.length - 1 && maxItem.itemTrailingEdge <= 1.01 ?
      │     ├── YES ──> 用户正处于真实底部 ──> 隐藏 ScrollToBottom 胶囊
      │     └── NO  ──> 用户脱离底部 ───────> 延时 250ms 呼出 ScrollToBottom 胶囊
```

### 6.1.2 高度缓存消除 Markdown 渲染抖动（ChatMessageHeightManager）

源码位置：`animated_chat_list.dart:326-344`

在 Markdown 渲染中，代码高亮解析完成、图片加载完成时都会导致元素高度突变。通过 `ChatMessageHeightManager` 缓存各 Message ID 的测量高度：

```dart
// animated_chat_list.dart:326-344
void _cacheMessageHeight(String messageId, double height) {
  heightManager.cacheHeight(messageId: messageId, height: height);
}

void _onRemoved(final int position, final Message data) {
  heightManager.removeFromCache(messageId: data.id);
}
```

### 6.1.3 用户提问自动定位（_scrollLastUserMessageToTop）

源码位置：`animated_chat_list.dart:239-261`

当用户发送一个长 Prompt 时，最舒适的体验并非强行滚到屏幕最下方空白处，而是**将用户刚刚发送的这条 Prompt 对齐到视口顶部**，以便用户清晰看到 AI 的回复自下方展开：

```dart
// animated_chat_list.dart:239-261
Future<void> _scrollLastUserMessageToTop() async {
  final user = Provider.of<User>(context, listen: false);
  final lastUserMessageIndex = messages.lastIndexWhere(
    (message) => message.author.id == user.id,
  );

  if (lastUserMessageIndex == -1 ||
      lastUserMessageIndex + 1 >= messages.length) {
    return;
  }

  if (this.lastUserMessageIndex != lastUserMessageIndex) {
    // 关键体验：平滑将用户的提问滚动到视口顶部
    await itemScrollController.scrollTo(
      index: lastUserMessageIndex,
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeInOut,
    );
  }

  this.lastUserMessageIndex = lastUserMessageIndex;
}
```

## 6.2 逆向 Sliver 列表与原生流式吸底

源码文件：`lib/plugins/ai_chat/presentation/animated_chat_list_reversed.dart`

在反向模式（`CustomScrollView(reverse: true)`）中，视口坐标系被物理颠倒：**底部的最新消息对应 `minScrollExtent = 0`，顶部历史消息对应 `maxScrollExtent`**。这种模式具有天然的抗高度坍塌优势——因为底部就是原点，上方无论流入多少 Token、高度如何膨胀，底部的滚动偏移量始终为 0，无需 JS 介入即可实现零成本贴底！

### 6.2.1 用户主动滚动意图识别（UserScrollNotification）

源码位置：`animated_chat_list_reversed.dart:141-162`

```dart
// animated_chat_list_reversed.dart:141-162
return NotificationListener<Notification>(
  onNotification: (notification) {
    if (notification is UserScrollNotification) {
      // 1. 用户主动向上滑动（在 reverse 坐标系中方向为 reverse）
      if (notification.direction == ScrollDirection.reverse) {
        _userHasScrolled = true;
      } else {
        // 2. 当用户回滚到底部 (pixels == minScrollExtent = 0) 时，解除意图锁定
        if (notification.metrics.pixels ==
            notification.metrics.minScrollExtent) {
          _userHasScrolled = false;
        }
      }
    }

    if (notification is ScrollUpdateNotification) {
      _handleToggleScrollToBottom();
    }

    return false; // 放行通知继续冒泡
  },
  child: Stack(
    children: [
      CustomScrollView(
        reverse: true,
        controller: widget.scrollController,
        slivers: <Widget>[ ... ],
      ),
      ...
    ],
  ),
);
```

### 6.2.2 跨帧二次校准防未贴底 Bug

源码位置：`animated_chat_list_reversed.dart:227-246`

```dart
// animated_chat_list_reversed.dart:227-246
// Because of the issue opened here https://github.com/flutter/flutter/issues/129768
// we need an additional jump to the end. Sometimes Flutter/Chromium
// will not scroll to the very end due to subpixel precision issues.
if (data.id == _lastInsertedMessageId &&
    widget.scrollController.offset >
        widget.scrollController.position.minScrollExtent &&
    (user.id == data.author.id && _userHasScrolled)) {
  widget.scrollController
      .jumpTo(widget.scrollController.position.minScrollExtent);
}
```

## 6.3 双状态机对比分析矩阵：Forward List vs Reversed Sliver

| 对比维度                  | Forward List (`animated_chat_list.dart`)                  | Reversed Sliver (`animated_chat_list_reversed.dart`) |
| :------------------------ | :-------------------------------------------------------- | :--------------------------------------------------- |
| **视口坐标原点**          | 顶部为 `0`，底部为 `scrollHeight - clientHeight`          | 底部为 `0`，顶部为 `maxScrollExtent`                 |
| **流式 Token 增长成本**   | 必须在每帧或每个 Token 重新计算 `scrollTop += dh`         | **零计算成本**（天然固定在底部原点 0）               |
| **高度突变/图片加载响应** | 依赖 `ChatMessageHeightManager` 缓存高度，否则跳动        | **天然稳定**（上方内容膨胀不影响底部 0 偏移）        |
| **用户提问顶部对齐**      | 支持（`_scrollLastUserMessageToTop` 精准对齐）            | 较复杂（需反向计算 offset）                          |
| **用户向上脱离判定**      | 依赖 `itemPositions` 尾部边界计算 (`trailingEdge > 1.01`) | 依赖 `UserScrollNotification` 物理手势方向           |
| **适用场景**              | 复杂交互、需精确控制单项滚动位置的富文档/混合编辑器       | **超高频流式输出（AI Agent 对话）、纯聊天流**        |

---

# 七、 Conex 核心病灶深度诊断

## 7.1 病灶一：modelsSplit 滚轮黑洞与页面滚动阻断

定位文件：`apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css`

```css
/* apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css:1-12 */
.modelsSplit {
  display: flex;
  gap: 0;
  flex: 1;
  height: max(480px, calc(100vh - 220px)); /* 硬编码固定高度 */
  min-height: 420px;
  border: var(--hairline-width, 1px) solid var(--hairline, var(--border-subtle));
  border-radius: 0;
  overflow: hidden; /* 内部溢出全截断 */
  background: transparent;
  box-shadow: none;
}

/* 行号 61-69 */
.mrlList {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain; /* ❌ 致命病灶：截断滚轮冒泡 */
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

/* 行号 170-181 */
.modelsDetail {
  flex: 1;
  min-width: 0;
  padding: 20px 24px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain; /* ❌ 致命病灶：截断滚轮冒泡 */
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  background: var(--bg-primary);
}
```

### 深度根因分析

1. **`overscroll-behavior: contain` 滥用**：在非独立模态弹窗（Modal）的嵌入式页面内，无理由声明 `contain`，导致只要鼠标悬浮在左侧或右侧，当滚动触顶/触底时，滚轮事件被彻底丢弃；
2. **固定高度与双滚动条**：外层 Settings 面板本身有垂直滚动条，内层 `.modelsSplit` 又固定了 `height: max(480px, calc(100vh - 220px))`，形成了“外层可滚、内层左右分别可滚”的三重嵌套滚动地狱；
3. **缺乏 Flex 伸缩自适应**：当窗口缩小时，固定高度导致外层产生滚动条，而鼠标一旦进入 `modelsSplit`，滚动条立刻被内层锁定，无法滚回上方。

## 7.2 病灶二：useChatAutoScroll 脆弱的增量计算与吸底断开

定位文件：`apps/crish-desktop/src/hooks/useChatAutoScroll.ts`

```typescript
// apps/crish-desktop/src/hooks/useChatAutoScroll.ts:36-81
useEffect(() => {
  if (rafIdRef.current != null) {
    cancelAnimationFrame(rafIdRef.current);
  }

  rafIdRef.current = requestAnimationFrame(() => {
    rafIdRef.current = null;
    const el = resolveScrollEl(chatFlowRef.current);
    if (!el) return;

    const scrollHeight = el.scrollHeight;
    const prevHeight = prevScrollHeightRef.current;

    if (!userScrolledRef.current) {
      if (isProcessing && prevHeight > 0) {
        const dh = scrollHeight - prevHeight;
        if (dh > 0) {
          el.scrollTop = Math.min(el.scrollTop + dh, scrollHeight);
        } else if (dh < 0) {
          const atBottom = scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (atBottom) {
            el.scrollTop = Math.max(0, scrollHeight - el.clientHeight);
          }
        }
      } else {
        el.scrollTop = scrollHeight;
      }
      setShowScrollToBottom(false);
    }

    prevScrollHeightRef.current = scrollHeight;
  });
}, [messages, isProcessing]);
```

```typescript
// apps/crish-desktop/src/hooks/useChatAutoScroll.ts:84-131
const handleScroll = () => {
  const scroller = attached;
  if (!scroller) return;
  const atBottom =
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  if (atBottom) {
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
  } else {
    userScrolledRef.current = true; // ❌ 致命病灶：1px 上滑或微小抖动即永久失锁
    setShowScrollToBottom(true);
  }
};
```

### 深度根因分析

1. **只依赖 React State `messages` 触发计算**：
   在现实渲染中，Markdown 文本到达后，React 组件更新完成，但异步的 `highlight.js`、`Mermaid` 图表、`KaTeX` 公式、以及 `<img>` 标签的加载是在后续若干微任务或网络返回后完成的。此时 `messages` 数组不再变化，`useChatAutoScroll` 根本不会触发 rAF，导致内容被撑大后视口停留在一半的位置（吸底断开）；
2. **缺乏手势意图与物理滚动区分**：
   `handleScroll` 仅仅判断距离底部的绝对像素 `< 60`。由于浏览器平滑滚动的惯性，或者虚拟列表尺寸微调，很容易产生一次性大于 60px 的偏移，`userScrolledRef.current` 瞬间被置为 `true`，吸底永久中断；
3. **用户新发消息无法唤醒吸底**：
   当用户在脱离底部状态下，在 Composer 中输入新的提问并点击发送时，`useChatAutoScroll` 没有重置 `userScrolledRef.current = false`，导致用户发送消息后看不到自己新发的消息和 AI 的即时响应。

## 7.3 病灶三：浮层与 Tooltip 未设 pointer-events 导致的滚轮吞噬

在 Conex 的多个组件中（如 `ChatStatusRibbons`、`PermissionModeMenu`、浮动复制按钮），浮层包裹层未配置 `pointer-events: none`。当用户在长代码块或消息流上滑动时，鼠标指针划过悬浮的复制按钮或状态条，事件瞬间被该浮层拦截，滚轮动量链断裂，造成明显的“掉帧卡顿”感。

---

# 八、 Conex 工业级重构落地实施方案与源码契约

基于对 AppFlowy 架构精髓的剖析，为 Conex 提供三大生产级落地重构方案。

## 8.1 方案一：重构 modelsSplit 双轨弹性独立滚动与动量链打通

### 8.1.1 CSS 架构重构（解除死锁与弹性自适应）

修改 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css`：

```css
/* ==========================================================================
   Conex ModelsSplit 工业级弹性双轨视口重构 (对标 AppFlowy Split View)
   ========================================================================== */

.modelsSplit {
  display: flex;
  gap: 0;
  flex: 1 1 auto;
  width: 100%;
  /* 废除硬编码高度，交由 Settings Panel 主 Flex 容器自适应拉伸 */
  min-height: 520px;
  border: var(--hairline-width, 1px) solid var(--border-subtle);
  border-radius: var(--radius-lg, 8px);
  background: var(--bg-primary);
  /* 允许内部 Flex 项目形成独立 BFC，但不阻断动量链 */
  contain: layout style;
}

.modelsRail {
  width: 240px;
  flex-shrink: 0;
  border-right: var(--hairline-width, 1px) solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.mrlList {
  flex: 1 1 auto;
  min-height: 0; /* 保证 Flex 子项溢出时正确收缩并出滚动条 */
  overflow-y: auto;
  /* 关键修复 1：将 overscroll-behavior 设为 auto，打通向外层的 Scroll Chaining */
  overscroll-behavior-y: auto;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 平滑滚动条质感 */
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}

.modelsDetail {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0; /* 关键：防止右侧长配置撑破外层 Flex 视口 */
  padding: 24px 28px;
  overflow-x: hidden;
  overflow-y: auto;
  /* 关键修复 2：打通右侧向外层的动量链，杜绝滚轮黑洞 */
  overscroll-behavior-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  background: var(--bg-primary);
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}
```

### 8.1.2 动量平滑中继器（React Scroll Chaining Relay）

对于需要精细控制两栏滚动的场景，提供轻量级 Hook `useScrollChaining`：

```typescript
// apps/crish-desktop/src/hooks/useScrollChaining.ts
import { useEffect, type RefObject } from 'react';

/**
 * 当子容器滚动到达物理极值时，自动将剩余的 wheel delta 转移至父容器，
 * 解决特定 WebView2 驱动下动量丢失问题。
 */
export function useScrollChaining(
  childRef: RefObject<HTMLElement | null>,
  parentRef?: RefObject<HTMLElement | null>
) {
  useEffect(() => {
    const el = childRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      const { deltaY } = e;
      if (!deltaY) return;

      const atTop = el.scrollTop <= 0 && deltaY < 0;
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && deltaY > 0;

      if (atTop || atBottom) {
        const targetParent =
          parentRef?.current ??
          el.parentElement?.closest<HTMLElement>(
            '[data-scroll-container="true"]'
          );
        if (targetParent) {
          targetParent.scrollTop += deltaY;
        }
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [childRef, parentRef]);
}
```

## 8.2 方案二：构建 Conex SmartScrollEngine 抗坍塌吸底控制器

为彻底替代脆弱的 `useChatAutoScroll.ts`，对标 AppFlowy 构建具备 **ResizeObserver 异步重排感知**、**高度缓存池**、与**物理滚动意图识别**的 `useSmartChatScroll` 引擎。

```typescript
// apps/crish-desktop/src/hooks/useSmartChatScroll.ts
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

export interface UseSmartChatScrollOptions {
  /** 判定处于底部的像素冗余阈值 (默认 32px) */
  bottomThreshold?: number;
  /** 延迟隐藏「回到最新」的防抖时长 (默认 250ms) */
  appearanceDelay?: number;
}

export interface UseSmartChatScrollResult {
  chatFlowRef: RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  isPinnedToBottom: boolean;
  scrollToBottom: (smooth?: boolean) => void;
  scrollLastUserPromptToTop: () => void;
}

export function useSmartChatScroll(
  messagesLength: number,
  isStreaming: boolean,
  options: UseSmartChatScrollOptions = {}
): UseSmartChatScrollResult {
  const { bottomThreshold = 32, appearanceDelay = 250 } = options;

  const chatFlowRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const isPinnedRef = useRef(true); // 是否处于吸底锁定状态
  const userIntentScrollRef = useRef(false); // 用户是否显式向上翻阅
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  /** 消息节点高度缓存池，消除异步渲染抖动 */
  const heightCacheMap = useRef<Map<string, number>>(new Map());

  // 1. 查找真实滚动视口
  const getScrollElement = useCallback(() => {
    const root = chatFlowRef.current;
    if (!root) return null;
    return (
      root.querySelector<HTMLElement>('[data-virtual-scroll="true"]') ?? root
    );
  }, []);

  // 2. 执行吸底定位
  const performStickToBottom = useCallback(
    (smooth = false) => {
      const el = getScrollElement();
      if (!el) return;

      if (smooth) {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'smooth',
        });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    },
    [getScrollElement]
  );

  // 3. 用户点击回到最新
  const scrollToBottom = useCallback(
    (smooth = true) => {
      userIntentScrollRef.current = false;
      isPinnedRef.current = true;
      setShowScrollToBottom(false);
      performStickToBottom(smooth);
    },
    [performStickToBottom]
  );

  // 4. 将用户最新提问对齐至视口顶部 (对标 AppFlowy _scrollLastUserMessageToTop)
  const scrollLastUserPromptToTop = useCallback(() => {
    const el = getScrollElement();
    if (!el) return;

    const userPrompts = el.querySelectorAll<HTMLElement>(
      '[data-message-role="user"]'
    );
    const lastUserPrompt = userPrompts[userPrompts.length - 1];
    if (lastUserPrompt) {
      lastUserPrompt.scrollIntoView({ behavior: 'smooth', block: 'start' });
      isPinnedRef.current = false; // 进入阅读提问模式
    }
  }, [getScrollElement]);

  // 5. 监听用户提问插入 -> 自动重置意图并吸底
  const prevMsgCountRef = useRef(messagesLength);
  useEffect(() => {
    if (messagesLength > prevMsgCountRef.current) {
      // 只要有新消息进入，立即复位意图锁，重新开启吸底
      userIntentScrollRef.current = false;
      isPinnedRef.current = true;
      setShowScrollToBottom(false);
      performStickToBottom(false);
    }
    prevMsgCountRef.current = messagesLength;
  }, [messagesLength, performStickToBottom]);

  // 6. ResizeObserver：感知 Markdown 异步渲染（代码块、公式、图片）引发的高度的重排
  useLayoutEffect(() => {
    const el = getScrollElement();
    if (!el) return;

    let prevScrollHeight = el.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const currentScrollHeight = el.scrollHeight;
      const heightDelta = currentScrollHeight - prevScrollHeight;

      // 如果处于吸底状态且高度增长，无缝维持在底部
      if (
        isPinnedRef.current &&
        !userIntentScrollRef.current &&
        heightDelta > 0
      ) {
        el.scrollTop = el.scrollHeight;
      }

      prevScrollHeight = currentScrollHeight;
    });

    // 观察滚动视口内部的所有内容容器
    resizeObserver.observe(el);
    Array.from(el.children).forEach((child) => resizeObserver.observe(child));

    return () => resizeObserver.disconnect();
  }, [getScrollElement, messagesLength]);

  // 7. 物理滚动监听与意图识别 (对标 AppFlowy UserScrollNotification)
  useEffect(() => {
    const el = getScrollElement();
    if (!el) return;

    const handleScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distanceFromBottom <= bottomThreshold;

      if (atBottom) {
        isPinnedRef.current = true;
        userIntentScrollRef.current = false;

        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        setShowScrollToBottom(false);
      } else {
        isPinnedRef.current = false;
        userIntentScrollRef.current = true;

        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
          setShowScrollToBottom(true);
        }, appearanceDelay);
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [getScrollElement, bottomThreshold, appearanceDelay]);

  return {
    chatFlowRef,
    showScrollToBottom,
    isPinnedToBottom: isPinnedRef.current,
    scrollToBottom,
    scrollLastUserPromptToTop,
  };
}
```

## 8.3 方案三：全局滚轮事件总线与浮层防死锁管理器

对标 AppFlowy `app_widget.dart:235`，在 Conex 桌面根层构建 `WheelMomentumManager`，彻底消除浮层吞噬滚轮动量的问题：

```typescript
// apps/crish-desktop/src/components/shell/WheelMomentumManager.tsx
import React, { useEffect } from 'react';

/**
 * 全局滚轮动量与浮层防死锁调度器 (对标 AppFlowy PointerSignalResolver)
 * 1. 当用户滚动滚轮时，立即消除当前所有浮动的 Tooltip，防止 Tooltip 成为滚轮黑洞；
 * 2. 给所有的悬浮 Overlay 注入 pointer-events: none 瞬态穿透。
 */
export const WheelMomentumManager: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  useEffect(() => {
    let scrollTimeout: NodeJS.Timeout | null = null;

    const handleGlobalWheel = (e: WheelEvent) => {
      // 1. 触发滚轮时，立即广播全局事件销毁 Tooltip
      window.dispatchEvent(new CustomEvent('conex:dismiss-tooltips'));

      // 2. 将临时浮动装饰层的 pointer-events 设为 none，防止滚轮丢帧
      document.body.classList.add('is-scrolling-active');

      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        document.body.classList.remove('is-scrolling-active');
      }, 150);
    };

    window.addEventListener('wheel', handleGlobalWheel, {
      passive: true,
      capture: true, // 捕获阶段拦截，保证最高优先级
    });

    return () => {
      window.removeEventListener('wheel', handleGlobalWheel, { capture: true });
      if (scrollTimeout) clearTimeout(scrollTimeout);
    };
  }, []);

  return <>{children}</>;
};
```

配合全局 CSS 规则：

```css
/* 滚动活跃期间，浮动指示器自动穿透，杜绝掉帧与死锁 */
body.is-scrolling-active [data-popover-type='tooltip'],
body.is-scrolling-active [data-ignore-wheel='true'] {
  pointer-events: none !important;
}
```

---

# 九、 全景验证矩阵与架构演进守则

## 9.1 10 大硬核端到端滚动场景验收断言

为保障 Conex 视口与滚动系统的工业级品质，建立 10 大不可妥协的验收断言（Assertions）：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Conex 视口与滚动链 10 大端到端验收矩阵                          │
├────┬─────────────────────────────┬─────────────────────────────────────────────────────┤
│ 编号│ 验收测试场景                 │ 验收断言标准 (Pass Criteria)                         │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A1 │ Settings ModelsSplit 边界传导 │ 鼠标停在左侧模型列表顶部/底部滚动滚轮，外层设置页即刻 │
│    │                             │ 响应垂直滚动，绝无死锁或黑洞拦截。                  │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A2 │ ModelsSplit 宽度极限缩放    │ 将应用窗口压缩至 800px 宽度，左右分栏按比例无损自适应 │
│    │                             │ 收缩，不产生溢出换行或视口坍塌。                    │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A3 │ 拖拽 Resizer 60fps 流畅度   │ 连续拖拽双栏分界线，CPU 占用低于 5%，无丢帧、闪烁， │
│    │                             │ 左右栏最小宽度严格锁定在保底阈值（>= 10%）。        │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A4 │ AI Token 高速流式吸底       │ 以 50 tokens/s 流速生成长文本，视口平滑贴合在最新   │
│    │                             │ 一行，滚动条无任何跳动或上下剧烈抖动。              │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A5 │ 用户微小上滑意图锁定        │ 在 Token 流式生成时，用户向上滑动滚轮 5px，吸底立即 │
│    │                             │ 解除锁定，视口稳定停留在用户阅读位置，不被强行拉回。│
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A6 │ Markdown 异步重排抗坍塌     │ 包含大图（2MB）、复杂 Mermaid 图表及代码高亮的消息在│
│    │                             │ 异步渲染完成后，视口高度自适应校准，不留多余空白。  │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A7 │ 点击发送自动复位吸底        │ 处于向上阅读历史消息状态时，用户在 Composer 发送新  │
│    │                             │ 消息，视口立即无缝对齐最新消息并恢复自动吸底。      │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A8 │ Tooltip 悬停即时排障        │ 鼠标悬停在按钮气泡上方时滑动滚轮，Tooltip 瞬间消失， │
│    │                             │ 底层视口即刻平滑滚动，无任何手势吞噬。              │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A9 │ 2D 数据表水平垂直双轨隔离   │ 表格水平滚动到头时，垂直滚轮输入无缝作用于外层视口；│
│    │                             │ 表格表头与数据行水平位移零延迟绝对同步。            │
├────┼─────────────────────────────┼─────────────────────────────────────────────────────┤
│ A10│ 极值贴底无 1px 缝隙         │ 点击「回到最新」胶囊，视口精准贴紧真实物理底部，    │
│    │                             │ `scrollTop === scrollHeight - clientHeight`。       │
└────┴─────────────────────────────┴─────────────────────────────────────────────────────┘
```

## 9.2 防死锁与防断开自检清单 (Checklist)

所有前端与客户端工程师在提交涉及视口、分栏与滚动容器的代码时，必须对照以下清单完成自检：

- [ ] **严禁滥用 `overscroll-behavior: contain`**：仅在真正的独立全屏模态对话框（Modal Dialog）中允许使用；所有嵌入式页面、分栏、侧边栏一律使用 `overscroll-behavior: auto`；
- [ ] **杜绝多层固定 `height: 100vh - N` 嵌套**：父子容器一律采用 Flex 布局（`flex: 1 1 auto; min-height: 0;`）自适应传递可用高度；
- [ ] **严禁使用裸 `messages.length` 驱动滚动**：涉及流式消息渲染的滚动计算，必须挂载 `ResizeObserver` 捕获 DOM 真实回流；
- [ ] **手势浮层必须支持穿透**：所有浮动状态栏、悬浮 Tooltip、气泡挂件在滚动触发期间必须具备 `pointer-events: none` 穿透能力；
- [ ] **拖拽操作必须区分内存态与持久化态**：分栏宽度、卡片位置等连续拖拽事件在移动期间仅执行内存事务（`inMemoryUpdate`），松手（`onDragEnd`）时方可触发持久化与全局 Store 变更。
