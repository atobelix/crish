# 05 · 统一滚动条体系与上下三角箭头 ScrollArea 组件方案：极端边界与魔鬼审计报告

> **工作区**：`docs/unified-scrollbar-system/`  
> **归档落盘路径**：`docs/unified-scrollbar-system/audits/05-boundary-and-devil-audit.md`  
> **审计身份**：最高级别魔鬼测试与极端边界审计官（Cross-Platform Boundary & Devil Auditor）  
> **审计对象**：统一滚动条体系设计、上下三角箭头步进交互、`<ScrollArea>` React 组件架构、Windows WebView2 宿主兼容性  
> **基线准则**：遵守 `AGENTS.md` 铁律，不退避、不妥协、穿透根因、严禁胶水补丁与掩耳盗铃。

---

## 目录

- [一、审计背景与审查立场](#一审计背景与审查立场)
- [二、维度一：跨平台与 WebView2 渲染宿主陷阱](#二维度一跨平台与-webview2-渲染宿主陷阱)
  - [2.1 `scrollbar-width` 与 `::-webkit-scrollbar` 的样式互相毁灭规则](#21-scrollbar-width-与--webkit-scrollbar-的样式互相毁灭规则)
  - [2.2 `::-webkit-scrollbar-button` 的宿主怪癖、版本断层与历史债务](#22--webkit-scrollbar-button-的宿主怪癖版本断层与历史债务)
- [三、维度二：越界与像素对齐问题（几何与高 DPI 毒点）](#三维度二越界与像素对齐问题几何与高-dpi-毒点)
  - [3.1 容器 `border-radius`（8px / 12px）的圆角截断与破边穿帮](#31-容器-border-radius8px--12px的圆角截断与破边穿帮)
  - [3.2 Windows 125% / 150% / 175% 高 DPI 亚像素断裂、抖动与接缝模糊](#32-windows-125--150--175-高-dpi-亚像素断裂抖动与接缝模糊)
- [四、维度三：性能、事件穿透与虚拟滚动死锁](#四维度三性能事件穿透与虚拟滚动死锁)
  - [4.1 自定义 ScrollArea 对虚拟滚动（Virtualizer）的毁灭性破坏](#41-自定义-scrollarea-对虚拟滚动virtualizer的毁灭性破坏)
  - [4.2 大数据量渲染时的重绘风暴与图层提升（Layer Promotion）过载](#42-大数据量渲染时的重绘风暴与图层提升layer-promotion过载)
- [五、十大核心毒点与残酷挑刺清单](#五十大核心毒点与残酷挑刺清单)
- [六、架构级前瞻性规避方案（三层分级收敛架构）](#六架构级前瞻性规避方案三层分级收敛架构)
  - [6.1 Tier A / B / C 分级标准](#61-tier-a--b--c-分级标准)
  - [6.2 `<ScrollArea>` 弹性安全几何模型（Math-Driven Inset）](#62-scrollarea-弹性安全几何模型math-driven-inset)
  - [6.3 高 DPI 物理像素对齐算法与纯矢量图形规范](#63-高-dpi-物理像素对齐算法与纯矢量图形规范)
  - [6.4 连续步进生命周期与防御性事件契约](#64-连续步进生命周期与防御性事件契约)
- [七、CI 自动化门禁与魔鬼验收用例规范](#七ci-自动化门禁与魔鬼验收用例规范)

---

## 一、审计背景与审查立场

在历次桌面界面一致性战役与组件现代化推进中，滚动条问题曾经历多次惨痛震荡：
1. `d00fbaaf` 提交误删 `shell-scrollbar.css` 导致全仓 50+ 处滚动容器全面退化为 Windows Win32 原生灰色粗条（`docs/desktop-ui-repair/survey/09-滚动条退化.md`）；
2. 随后在 `Menu`、`SmartPanel` 等模块中，开发者试图通过局部声明 `scrollbar-width: thin` 修复宽度，却直接诱发了 Chromium 底层的 WebKit 伪元素注销逻辑，导致三角箭头生硬复活、毛玻璃菜单被粗暴切割（`docs/ui-component-modernization/analysis/07-菜单高度死锁与滚动条异常及双重幽灵菜单深度排查.md`）；
3. 现阶段提出的「统一滚动条体系与上下三角箭头 ScrollArea 组件方案」，意图通过规范化全局样式与引入封装的 React `<ScrollArea>` 组件，彻底终结滚动条乱象并提供可交互的步进三角按钮。

**本审计官的审查立场**：
绝不接受纸面上的理想主义。任何声称「既能用 CSS 简单控制，又能随意加好看三角，还能在所有场景无脑套用」的方案，在 Windows WebView2 恶劣的宿主环境与复杂的 IDE 级别多层虚拟滚动面前，都必然暴露出致命破绽。本次审计将用放大镜和解剖刀，逐项穿透其物理极限。

---

## 二、维度一：跨平台与 WebView2 渲染宿主陷阱

### 2.1 `scrollbar-width` 与 `::-webkit-scrollbar` 的样式互相毁灭规则

#### 【底层根因白盒解剖】
Chromium 引擎在 121 版本（2024 年初）正式实装了 W3C CSS Scrollbars Level 1 规范。根据 Blink 渲染引擎核心源码（`third_party/blink/renderer/core/paint/paint_layer_scrollbar.cc` 与 `ScrollbarThemeCSSCustom.cc`）的决策分支：

```text
               [元素计算样式 ComputedStyle]
                           │
             is scrollbar-width != auto?
            或 is scrollbar-color != auto?
                     /            \
                   YES             NO
                   /                \
        [激活 CSSScrollbarTheme]     [检查 ::-webkit-scrollbar 伪元素]
        - 彻底注销 WebKit 伪元素管道     - 若命中：进入 PaintLayerScrollbar
        - 交由操作系统原生控件渲染器       - 自定义 width / thumb / button 生效
        - Windows WebView2 绘制系统原生
          DWM 经典条（带上下步进三角）
```

**极其残酷的物理现实**：
1. **全或无（All-or-Nothing）互斥**：只要当前元素（或通过 CSS 变量/继承链）解析出 `scrollbar-width: thin` 或 `scrollbar-width: none`，Blink 的样式解析器将**直接将该元素上的 `::-webkit-scrollbar`、`::-webkit-scrollbar-thumb`、`::-webkit-scrollbar-track` 以及 `::-webkit-scrollbar-button` 全部标记为无效（Ignored）**！
2. **Windows WebView2 回退灾难**：在 macOS 上，系统原生条默认是悬浮半透明细条（Overlay）；但在 Windows 10/11 的 WebView2 环境下，系统的原生回退对象是**经典的 Win32/UWP 窗口非客户区滚动条**！
   - 宽度固定为 15px~17px；
   - 带有硬编码的 3D 浮雕灰/黑轨道；
   - 顶部和底部带有 Windows 经典的上下灰色步进三角（▲/▼）；
   - **此时你在 CSS 写的 `::-webkit-scrollbar-button { display: none !important; }` 会被 Chromium 彻底当成废纸！**

---

### 2.2 `::-webkit-scrollbar-button` 的宿主怪癖、版本断层与历史债务

若不采用 React 组件，仅试图用 CSS 的 `::-webkit-scrollbar-button` 来实现精致的上下小三角，将直接撞上下列宿主怪癖：

1. **重绘失效与状态死锁（Paint Invalidation Glitch）**：
   在 Chromium 116 至 126+ 中，`::-webkit-scrollbar-button:hover` 和 `:active` 伪类的重绘失效判定存在已知缺陷。当鼠标悬停或点击三角按钮时，GPU 合成器经常不会触发即时 Repaint，导致按钮状态视觉上毫无反馈；更严重的是，当鼠标松开或移出后，按钮经常处于「永久保持高亮悬停色」的假死状态，直到整个窗口失去焦点重绘。
2. **长按连续步进的定时器失控**：
   原生 WebKit 按钮的长按连续滚动由 Blink 底层主线程消息循环泵（MessageLoop）的定时器驱动（通常是 500ms 初始延迟 + 50ms 步进周期）。该定时器**不具备节流与帧率对齐机制**，更无法与显示器高刷新率（120Hz/144Hz）协同。一旦主线程因 AST 解析轻微卡顿 100ms，恢复瞬间会连续发射积压的 5 次步进，导致视口瞬间暴冲抽搐。
3. **SVG 矢量失真与栅格化模糊**：
   若通过 `background-image: url("data:image/svg+xml,...")` 为按钮绘制三角图标，Windows WebView2 会在初次布局时将其预栅格化为固定位图。当用户拉伸窗口或缩放视图时，Blink 经常直接对已栅格化的低分辨率位图进行双线性拉伸，三角箭头边缘呈现严重的白雾、虚焦或像素锯齿。
4. **视口极端收缩时的按钮吞噬现象（Button Collapse Chaos）**：
   当弹出菜单内容较多但屏幕可用高度被压缩至极限（例如 100px 高度）时，若每个按钮高度为 16px，两个按钮合计占据 32px。当 `容器高度 < (按钮高度 * 2 + Thumb 最小高度)` 时，Blink 会发生严重算术溢出：Thumb 长度计算为负数而彻底消失，上下两个箭头按钮甚至会直接在轨道中段交叉重叠！
5. **规范废弃断崖风险**：
   W3C CSS 工作组已明确将所有 `::-webkit-scrollbar*` 伪元素列为 Deprecated 历史遗留特性。Chromium 维护团队已声明不再接受针对 `PaintLayerScrollbar` 的复杂样式增强补丁。将核心交互逻辑（三角步进）深度押注在废弃伪元素上属于严重的架构技术负债。

---

## 三、维度二：越界与像素对齐问题（几何与高 DPI 毒点）

### 3.1 容器 `border-radius`（8px / 12px）的圆角截断与破边穿帮

在现代桌面端中，弹出菜单（`Menu`）、模型选择器（`ModelBadgePickerMenu`）和卡片普遍采用 `border-radius: 8px` 或 `12px`，并配以毛玻璃背景（`backdrop-filter: blur`）与微妙的描边（`border: 1px solid var(--border-color)`）。

#### 【几何碰撞的残酷真相】
1. **矩形轨道 vs 圆形外轮廓**：
   无论是原生滚动条还是绝对定位的普通滚动条，其物理轨道默认始终是一个贴紧容器边界的严格直角矩形（`Rect`）。
2. **两种毁灭性视觉穿帮**：
   - **穿帮 A：破边穿刺（No Clip）**：如果容器没有声明 `overflow: hidden`（例如为了让子菜单悬浮展开），滚动条顶部的直角尖角会直接刺破容器的 12px 圆角外壳，露出极其生硬的直角黑色/灰色底衬。
   - **穿帮 B：断头台切角（Hard Clip）**：如果容器设置了 `overflow: hidden`，容器的圆角剪裁路径（Border Radius Clip Path）将像断头台一样直接切过滚动条区域。
     - 滚动条右上角与右下角正好处于圆弧曲率最大的扇形区域内！
     - 位于最顶端的「向上三角按钮」的右上半边、以及最底端的「向下三角按钮」的右下半边，**会被硬生生削掉一个斜角**！
     - 三角箭头失去对称性，视觉上呈现为严重残缺破损的怪异多边形。

```text
容器右上角 12px 圆弧剪裁线
      ╭─────────────╮
    ╭─╯  . . . . . .│<--- 容器边界
   ╭╯   . ┌─────────┤
  │    .  │ ▲ 顶部三角│<--- 致命切角区！右上角被圆弧切断！
  │   .   └─────────┤
  │  .    │         │
```

#### 【数学防御断言】
设容器右上角圆角半径为 $R$，滚动条宽度为 $W$，滚动条右侧边距（Margin）为 $M$。
内切圆弧方程以圆角圆心为原点：
$$x^2 + y^2 = R^2 \quad (x \ge 0, y \ge 0)$$
滚动条最右侧在圆心坐标系下的横坐标为 $x = R - M$；滚动条最左侧横坐标为 $x = R - M - W$。
若滚动条从容器顶部顶点开始布局（$y = R$ 到 $y = 0$），要保证整个滚动条（包含三角形按钮）**绝对不被圆弧侵蚀**，其纵向安全内嵌偏移量（Top Inset $I_y$）必须严格满足：
$$I_y \ge R - \sqrt{\max\left(0, R^2 - (R - M)^2\right)}$$
- 若 $R = 12\text{px}, M = 0\text{px}$（紧贴右边缘）：
  $$I_y \ge 12 - \sqrt{144 - 144} = 12\text{px}$$
  **即：滚动条顶部和底部必须各自内缩至少 12px，三角按钮才能完整存活！**
- 若方案没有为 `<ScrollArea>` 设计严格的几何 Inset 机制，任何圆角弹出层上的三角按钮都必将惨遭断头台截断。

---

### 3.2 Windows 125% / 150% / 175% 高 DPI 亚像素断裂、抖动与接缝模糊

Windows 桌面环境下，高分辨率屏幕（1080P/2K/4K 笔记本与便携屏）的高频缩放比例是 **125%（DPR=1.25）**、**150%（DPR=1.5）** 与 **175%（DPR=1.75）**。

#### 【亚像素三大灾难】

#### 1. 0.5px / 0.33px 亮纹与接缝漏底（Seam Hairline Crack）
- 在 150% DPI 下，1 CSS px = 1.5 物理像素。
- 若上三角按钮高度设为 CSS `15px`，在物理像素中为 $15 \times 1.5 = 22.5$ 物理像素。
- 此时滚动条轨道紧接着从 `top: 15px` 开始渲染。
- GPU 光栅化管线（Direct3D / Skia）在将浮点边界映射到离散显示器晶格时：
  - 上按钮底边根据舍入策略可能落在物理行 22；
  - 轨道顶边可能落在物理行 23；
  - **在物理像素 22 与 23 之间瞬间裂开一条宽 0.5 物理像素的透明间隙！**
  - 当下方背景是浅色或高亮毛玻璃时，用户在滚动过程中会看到三角按钮下方有一条若隐若现、疯狂跳闪的白色亮线。

#### 2. 滚动微颤（Subpixel Shimmering / Jitter）
- 自定义 JS 滚动条在更新滑块位置时，公式通常为：
  $$\text{thumbTop} = \frac{\text{scrollTop}}{\text{scrollHeight} - \text{clientHeight}} \times \text{trackFreeSpace}$$
- 计算得出的 `thumbTop` 必然是极度连续的浮点数（例如 `37.28491...px`）。
- 若直接赋给 `transform: translateY(37.28491px)`，Blink GPU 栅格器会对滑块边缘执行双线性亚像素抗锯齿：
  - 随着用户鼠标微幅滚动，滑块边缘在「跨越 1 个物理像素」的过程中，其描边宽度会在 1px 与 2px 之间规律性波动，边缘 Alpha 透明度在 0.3 与 1.0 之间来回振荡；
  - 肉眼感知就是滑块上下边缘像液体一样剧烈抖动、模糊、虚化，极度廉价失真。

#### 3. CSS Border 三角形的畸变惨案
- 很多组件习惯用 CSS `border` 技巧画三角：
  ```css
  width: 0; height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-bottom: 5px solid var(--text-secondary);
  ```
- 在 125% DPI 下：
  - `4px * 1.25 = 5` 物理像素（奇数）；
  - 对称轴无法在整数物理像素上居中（只能取 2.5px）；
  - **渲染结果：三角形左侧斜边宽度 2 物理像素，右侧斜边宽度 3 物理像素，顶部直接凹陷或呈现歪斜平头！**
- **铁律结论**：在 Windows 高 DPI 环境下，严禁使用 CSS Border 绘制几何图标，必须采用规范的矢量 SVG 并强制绑定光栅化渲染策略。

---

## 四、维度三：性能、事件穿透与虚拟滚动死锁

### 4.1 自定义 ScrollArea 对虚拟滚动（Virtualizer）的毁灭性破坏

Crish 桌面端的核心支柱之一是基于高度动态预测量的虚拟滚动体系（`apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` 与 `apps/crish-desktop/src/hooks/useVirtualScroll.ts`）。

#### 【四重死锁陷阱】

```text
[方案误区：将 Virtualizer 外层包裹自定义 React <ScrollArea>]
┌──────────────────────────────────────────────────────────┐
│ <ScrollArea.Root>                                        │
│   ┌────────────────────────────────────────────────────┐ │
│   │ <ScrollArea.Viewport ref={scrollAreaViewportRef}>  │ │
│   │   ┌──────────────────────────────────────────────┐ │ │
│   │   │ <MessageVirtualizer>                         │ │ │
│   │   │   <div ref={vs.containerRef} class="list">   │ │ │
│   │   │   ...                                        │ │ │
```

1. **死锁 1：Ref 绑定劫持与双重视口（Double Viewport Trap）**：
   - `MessageVirtualizer` 的核心依赖是 `vs.containerRef`，它必须直接绑定在**真正发生物理溢出且产生 `scrollTop` 变化的 DOM 节点**上；
   - 若外层套上 `<ScrollArea>`，开发者若把 `overflow: hidden` 加在外层、把滚动交给 ScrollArea，则 `MessageVirtualizer` 内部容器的 `scrollTop` 永远是 `0`！
   - `computeVisibleRange(0, ...)` 永远只计算前 6 个元素，下游真实滚动由外层发生，内层却以为在原地，导致用户一滚就看到巨大的长白屏！
2. **死锁 2：`useUndoWithScrollAnchor` 锚定失效**：
   - `MessageVirtualizer.tsx:80` 使用了 `useUndoWithScrollAnchor(containerRef, manager)`；
   - 在用户撤销会话或修改节点时，它通过精确读取 `containerRef.current.scrollTop` 并在 DOM 变更后回写来防止视口跳跃；
   - 若滚动容器被 `<ScrollArea>` 抽象隔离，所有历史撤销锚定代码全部脱靶失效，视口会在消息收发时发生不可控的上下飞跃。
3. **死锁 3：`ResizeObserver` 循环递归震荡（RO Loop Limit Exceeded）**：
   - `MessageVirtualizer` 内部对带有 `[data-vindex]` 的每一行都有 ResizeObserver 监听，高度测量后通过 `setActual` 刷新总高度；
   - 如果 `<ScrollArea>` 自身也挂载 ResizeObserver 来动态更新自己的自定义 Thumb 高度；
   - 当行高变化 $\to$ Virtualizer 更新总高 $\to$ 视口产生/消除微小滚动槽 $\to$ 触发 ScrollArea 更新 $\to$ 触发容器内宽变化 $\to$ 触发消息正文文字折行 $\to$ 触发行高变化！
   - **形成死循环！瞬间触发控制台爆红：`ResizeObserver loop completed with undelivered notifications`，严重时直接导致浏览器主线程卡死 10 秒！**
4. **死锁 4：平滑定位与瞬时闪烁（ScrollTop De-sync Flickering）**：
   - 当点击侧栏搜索高亮跳转、或固定消息跳转（`jumpToPinned`）时，代码直接调用 `container.scrollTop = targetOffset`；
   - 原生滚动条会在**当前帧（Frame 0）**以 0 延迟同步完成绘制；
   - 而 React 自定义 `<ScrollArea>` 通常需要等待 `onScroll` 事件触发，再进入 React 状态调度（`setThumbTop`），在**下一帧或更晚（Frame 1~3）**才完成 Thumb 移动；
   - 视觉结果：内容已经瞬间闪现到第 500 条消息，但右侧的滚动滑块却在 50ms 之后才慢悠悠地弹射到位，产生极度明显的视差脱节。

---

## 五、十大核心毒点与残酷挑刺清单

| 编号 | 毒点名称 | 触发宿主/场景 | 故障现象与破坏等级 | 根治判定标准 |
| :--- | :--- | :--- | :--- | :--- |
| **P01** | **`scrollbar-width` 互斥自毁** | Windows WebView2 / CSS 同时声明两套规则 | Blink 彻底注销 WebKit 伪元素，Windows 原生 17px 灰粗条与丑陋三角复活。**[致命破坏]** | 全仓禁止在 WebKit 细条容器上出现任何 `scrollbar-width` 声明。 |
| **P02** | **圆角断头台切角** | 8px/12px 圆角容器 + 贴边矩形滚动条 | 顶部与底部三角按钮被容器圆角弧线生硬剪断右上角/右下角，残缺破损。**[严重视觉缺陷]** | 必须执行数学 Inset 安全收缩，内嵌量 $\ge$ 圆角半径 $R$。 |
| **P03** | **高 DPI 亚像素接缝漏底** | Windows 125%/150%/175% 缩放 | 按钮与 Track 之间在特定滚动位置裂开 0.5px 透明亮缝，高频闪烁。**[严重视觉缺陷]** | 必须采用物理像素对齐算法，坐标按 `1 / DPR` 进行离散对齐。 |
| **P04** | **CSS Border 三角畸变** | 分数 DPI（125%、175%） | 奇数物理像素导致三角形左右斜边宽度不一、顶点变秃或倾斜。**[中度视觉缺陷]** | 严禁 CSS Border，必须使用纯矢量 SVG + `shape-rendering="crispEdges"`。 |
| **P05** | **虚拟滚动 Ref 劫持死锁** | `MessageVirtualizer` 包裹自定义 Viewport | `scrollTop` 测量恒为 0，可视窗口计算瘫痪，列表向下滚动大面积白屏。**[致命功能瘫痪]** | 虚拟滚动列表绝对禁止包裹多层 DOM 结构的 ScrollArea，强制走原生细条。 |
| **P06** | **主线程卡顿引发步进暴冲** | Agent 流式吐字 + 用户长按三角按钮 | 主线程阻塞导致定时器延迟积压，恢复瞬间连续派发，视口剧烈抽搐。**[严重交互缺陷]** | 步进计时器必须基于真实时间戳差值（Delta-time）计算，超出阀值跳过。 |
| **P07** | **长按定时器孤儿泄漏** | 用户在三角按钮上按下并移出窗口/卸载 | 鼠标在窗口外释放未捕获 `pointerup`，定时器无法终止，列表狂滚到底。**[严重稳定性缺陷]** | 必须使用全局 PointerCapture 与 window `blur` / unmount 刚性清理保护。 |
| **P08** | **图层提升显存穿孔** | 多容器滥用 `will-change: transform` | 产生 80+ 个 GPU 合成图层，集显 VRAM 暴涨，导致 GPU 进程卡死。**[严重性能退化]** | 仅滑块允许受控硬件加速，轨道与按钮严禁脱离普通图层渲染。 |
| **P09** | **ResizeObserver 递归震荡** | 行高动态回写与滑块尺寸联动 | 触发 `ResizeObserver loop limit exceeded`，极端情况下主线程锁死。**[严重性能退化]** | 滑块位置更新脱离 React 渲染管线，直接在 rAF 中执行局部 DOM 突变。 |
| **P10** | **无障碍与键盘盲区** | 自定义三角按钮无可访问性考量 | 盲人读屏软件无法感知可滚动视口，Tab 键无法聚焦步进控制。**[规范违背]** | 按钮补全 `aria-label`，视口绑定标准 `role="region"` 与键盘步进响应。 |

---

## 六、架构级前瞻性规避方案（三层分级收敛架构）

为彻底根治上述毒点，同时恪守仓库根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md` 的反过度设计红线，提出**三层分级架构（Tiered Strategy）**：

### 6.1 Tier A / B / C 分级标准

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        统一滚动条体系分级落地方案                        │
├──────────────────┬───────────────────┬─────────────────────────────────┤
│ 级别与定位       │ 适用目标场景      │ 核心技术实现路径                │
├──────────────────┼───────────────────┼─────────────────────────────────┤
│ Tier A           │ 消息流虚拟列表    │ - 强制纯原生 overflow-y: auto   │
│ 【重型高速通道】 │ DiffCard 对比视口 │ - 严格走 overlay-scrollbar.css  │
│ 极致性能 / 0 开销│ 终端控制台 / 笔记 │ - 绝对禁止包装任何 DOM ScrollArea│
│                  │ 庞大代码文件树    │ - CI 拦截全仓 scrollbar-width   │
├──────────────────┼───────────────────┼─────────────────────────────────┤
│ Tier B           │ 模型下拉选择菜单  │ - 受控包装精简 <ScrollArea>     │
│ 【高质感弹出层】 │ 斜杠命令候选浮层  │ - 矢量 SVG 上下三角微型步进按钮 │
│ 像素级圆角与对齐 │ 设置分类快速面板  │ - 数学安全 Inset（免断头台截断）│
│                  │ 快捷操作小浮窗    │ - 物理像素对齐 + PointerCapture │
├──────────────────┼───────────────────┼─────────────────────────────────┤
│ Tier C           │ 顶栏标签页导航条  │ - 双重彻底隐藏方案              │
│ 【纯净无痕通道】 │ 水平附件操作条    │ - scrollbar-width: none +       │
│ 静默溢出滑移     │ 紧凑状态工具栏    │   ::-webkit-scrollbar { display:│
│                  │                   │     none; width: 0; height: 0 } │
└──────────────────┴───────────────────┴─────────────────────────────────┘
```
