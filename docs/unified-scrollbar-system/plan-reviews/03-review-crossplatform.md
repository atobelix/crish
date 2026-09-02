# 03 · 统一滚动条体系战役方案独立评审报告
# （Plan Reviewer C：跨平台与魔鬼边界主审报告）

> **评审文档标识**：`docs/unified-scrollbar-system/plan-reviews/03-review-crossplatform.md`  
> **所属战役**：统一滚动条体系与 ScrollArea 高频组件战役（Unified Scrollbar System）  
> **评审主审官**：Plan Reviewer C · 跨平台与魔鬼边界主审（Cross-Platform Boundary & Devil Reviewer）  
> **评审对象**：`docs/unified-scrollbar-system/detailed-plans/` 下 6 份维度详案（01 至 06）及 `00-master-plan.md` 战役总纲  
> **遵循权威依据**：《主 Agent 全流程调度提示词 v3》§二.2、`AGENTS.md`（通用协作纪律、§7 严禁补丁与绕过、§7.1 立体验证纪律、§8 反过度设计红线）、`ANTI_OVERENGINEERING_GUARDRAILS.md`、`docs/unified-scrollbar-system/audits/05-boundary-and-devil-audit.md`。  
> **评审基准时间**：2026-09-02  
> **总体裁定结论**：**【有条件批准（Conditional Approval）】——核心架构收敛方向正确，但在跨平台渲染防御、极端几何 Inset 算法、虚拟列表双重溢出以及 CI 测试断言源码中存在 5 项致命缺陷与跨方案死锁，必须在执行前完成刚性修正！**

---

## 目录

- [一、评审背景与主审审查立场](#一评审背景与主审审查立场)
- [二、使命一：跨平台与 Chromium/WebView2 渲染防御审查](#二使命一跨平台与-chromiumwebview2-渲染防御审查)
  - [2.1 18 处 `scrollbar-width: thin` 物理清除计划审定](#21-18-处-scrollbar-width-thin-物理清除计划审定)
  - [2.2 Blink 内核互斥自毁机理复核与“双属性齐禁”盲区](#22-blink-内核互斥自毁机理复核与双属性齐禁盲区)
  - [2.3 跨 Package 治理盲区（`packages/block-paper` 漏检风险）](#23-跨-package-治理盲区packagesblock-paper-漏检风险)
- [三、使命二：虚拟滚动禁区红线审查](#三使命二虚拟滚动禁区红线审查)
  - [3.1 `MessageVirtualizer` 零 DOM 增量与 Ref 直通核验](#31-messagevirtualizer-零-dom-增量与-ref-直通核验)
  - [3.2 同步微任务撤销锚定（`useUndoWithScrollAnchor`）防干扰审查](#32-同步微任务撤销锚定useundowithscrollanchor防干扰审查)
  - [3.3 【重大隐患发现】`WindowedSessionUl` 双重滚动与嵌套视口死锁](#33-重大隐患发现windowedsessionul-双重滚动与嵌套视口死锁)
- [四、使命三：极端几何与数学安全 Inset 审查](#四使命三极端几何与数学安全-inset-审查)
  - [4.1 【致命缺陷】14px 浮层圆角断头台切角数学方程与按钮防护脱节](#41-致命缺陷14px-浮层圆角断头台切角数学方程与按钮防护脱节)
  - [4.2 【致命缺陷】退化紧凑态算法（Degraded Compact Mode）在 Plan 04 中全量缺失](#42-致命缺陷退化紧凑态算法degraded-compact-mode在-plan-04-中全量缺失)
  - [4.3 【跨方案死锁】Plan 04 强制关闭 `xs` 按钮与 Plan 05 模型菜单 100% 还原之正面冲突](#43-跨方案死锁plan-04-强制关闭-xs-按钮与-plan-05-模型菜单-100-还原之正面冲突)
  - [4.4 高 DPI 亚像素 0.5px 接缝亮线与矢量 SVG 光栅化防御审查](#44-高-dpi-亚像素-05px-接缝亮线与矢量-svg-光栅化防御审查)
- [五、使命四：CI 负向刚性门禁审查](#五使命四ci-负向刚性门禁审查)
  - [5.1 `SCROLLBAR_WHITELIST` 彻底去白名单化审查](#51-scrollbar_whitelist-彻底去白名单化审查)
  - [5.2 【测试源码致命 Bug】Plan 06 中 `parseDarkness` 正则解析错误导致 CI 必炸](#52-测试源码致命-bugplan-06-中-parsedarkness-正则解析错误导致-ci-必炸)
  - [5.3 门禁扫描范围缺陷（`walkSrc` 单包局限性）](#53-门禁扫描范围缺陷walksrc-单包局限性)
- [六、五大致命缺陷修正指令矩阵（Mandatory Refinements）](#六五大致命缺陷修正指令矩阵mandatory-refinements)
- [七、主审最终结论与签发状态](#七主审最终结论与签发状态)

---

## 一、评审背景与主审审查立场

依据《主 Agent 全流程调度提示词 v3》§二.2“多 Agent 评审（找冲突、逻辑漏洞、工作量不均衡、违背约束，以及方案之间的路径重叠）”的刚性要求，本主审官（Plan Reviewer C）对 `docs/unified-scrollbar-system/detailed-plans/` 目录下的 6 份维度详案进行了全景深度解剖。

**主审审查立场**：
- 恪守反退避铁律与反过度设计红线；
- 拒绝任何浮于表面的“整体良好（Looks Good To Me）”空洞汇报；
- 紧盯 Windows 10/11 x64 环境下 Microsoft Edge WebView2 (Chromium Blink) 内核的物理渲染特性；
- 用最严苛的白盒解剖刀，穿透一切“纸面伪验证”，不放过任何会导致真机样式自毁、渲染撕裂、长白屏死锁或 CI 爆红的隐形地雷。

---

## 二、使命一：跨平台与 Chromium/WebView2 渲染防御审查

### 2.1 18 处 `scrollbar-width: thin` 物理清除计划审定

本主审亲自在工程根目录下执行静态正则扫描与代码树比对，确认全仓（含桌面客户端与共享包）存量 `scrollbar-width: thin` 声明点**共有且确切为 18 处**：

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│             全仓 18 处 scrollbar-width: thin 物理分布现场验证清单                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 桌面主项目 (apps/crish-desktop/src/): 共 16 处                                   │
│  1. components/sidebar/Sidebar.module.css:129                                    │
│  2. components/chat-composer/ChatComposer.module.css:1115                        │
│  3. components/chat-composer/PermissionModeMenu.module.css:141                   │
│  4. components/provider/ModelBadgePickerMenu.module.css:106                      │
│  5. components/ui/Select/Select.module.css:165                                   │
│  6. components/ui/Select/SelectContent.module.css:20                             │
│  7. components/chat-composer/ChatQueuePanel.module.css:12                        │
│  8. components/chat-composer/TiptapEditorField.module.css:42                     │
│  9. components/chat-composer/TiptapSlashMenu.module.css:34                       │
│ 10. components/chat-message-row/StreamingTableContainer.module.css:34            │
│ 11. components/chat-tool-call/ChatToolCallBlock.module.css:880                   │
│ 12. components/diff/DiffCard.module.css:185                                      │
│ 13. components/note-paper/NotePaperPanel.module.css:172                          │
│ 14. components/settings-models/ModelsSettingsTab.module.css:1110                 │
│ 15. components/settings/FontSelectField.module.css:210                           │
│ 16. components/ui/Input/Textarea.module.css:30                                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 共享包项目 (packages/block-paper/src/): 共 2 处                                  │
│ 17. packages/block-paper/src/chrome/blockChrome.css:279                          │
│ 18. packages/block-paper/src/list/paperList.css:58                               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**评审判定**：
1. **行数与位置 100% 吻合**：维度详案 `02-plan-purge-debts.md` 针对上述 18 处给出的预期 Diff 与行号定位准确无误，物理删除动作切实明确；
2. **伴随属性清理到位**：Plan 02 同步拔除了第 4 处的 `--border-subtle` 脏色与第 10 处的 `rgba(0,0,0,0.2)` 硬编码脏色，符合收敛规范。

---

### 2.2 Blink 内核互斥自毁机理复核与“双属性齐禁”盲区

#### 1. Blink 底层机制复核
根据 Chromium Blink 渲染引擎核心源码（`third_party/blink/renderer/core/paint/paint_layer_scrollable_area.cc`）：
只要元素计算样式中解析出 `scrollbar-width != auto` 或 `scrollbar-color != auto`，Blink 将强制激活 `CSSScrollbarTheme` 并将 `UsesCustomScrollbarStyle()` 内部标志位置为 `false`。
此时，WebKit 伪元素流水线被物理断路，Windows WebView2 会强行绘制 Win32/UWP 原生控件，露出 17px 的原生灰粗条与丑陋三角，且任何 CSS 的 `::-webkit-scrollbar-button { display: none }` 都将被 Blink 静默丢弃。

#### 2. 审查发现的重大盲区：**`scrollbar-color` 拦截缺失**
- Plan 02 虽然在清理 `scrollbar-width: thin` 时顺手删除了紧邻的 `scrollbar-color`；
- **但 Plan 06 的 CI 门禁（`style-contract.test.ts`）仅仅检测了 `scrollbar-width: thin`，完全没有设立针对 `scrollbar-color` 的负向拦截门禁！**
- **物理风险**：如果未来有开发者或自动化脚本为了“调整颜色”而写入了 `scrollbar-color: var(--scrollbar-thumb-bg) transparent;`（但没有写 `scrollbar-width: thin`），Blink 依然会判定 `scrollbar-color != auto`，从而**完全相同地一击必杀注销自定义 WebKit 滚动条！**
- **整改指令**：门禁必须升级为“**双属性齐禁（Dual Property Lockout）**”：全仓 CSS 既禁止 `scrollbar-width: thin`，也严禁任何非 auto 的 `scrollbar-color` 声明！

---

### 2.3 跨 Package 治理盲区（`packages/block-paper` 漏检风险）

- Plan 02 正确识别并计划删除了 `packages/block-paper` 下的 2 处地雷（`blockChrome.css:279` 与 `paperList.css:58`）；
- **但 Plan 06 的测试套件中，`walkSrc()` 函数直接被写死为遍历 `src/`（即 `apps/crish-desktop/src/`）！**
- 这意味着：`packages/block-paper` 在物理上完全逃脱了 `style-contract.test.ts` 的 CI 刚性监控！如果后续有人在 `block-paper` 中重新引入 `scrollbar-width: thin`，CI 将毫无感知，绿色放行！
- **整改指令**：`style-contract.test.ts` 中的扫描工具或独立脚本必须扩展为扫描根工作区下的 `apps/crish-desktop/src/` 与 `packages/`，消除包间盲区。

---

## 三、使命二：虚拟滚动禁区红线审查

### 3.1 `MessageVirtualizer` 零 DOM 增量与 Ref 直通核验

在 `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` 中，主审查核验结果如下：
1. **DOM 结构 100% 保持**：Plan 05（§4.1）明确拒绝了给 `MessageVirtualizer` 外层套用 `<ScrollArea>`，改动仅为：
   ```diff
   - className={styles.list}
   + className={`${styles.list} scrollArea scrollAreaMd`}
   ```
2. **DOM 深度增量严格为 0**，完全杜绝了由于父级 DOM 劫持导致 `containerRef.current.scrollTop` 恒为 0 而诱发的消息流大面积长白屏死锁。
3. **Compositor 硬件加速保障**：通过消费 Mode 2 实用类，滚动条绘制交由 Blink 排版引擎在 GPU Compositor 线程原生执行，杜绝了 React 重新渲染造成的掉帧。

---

### 3.2 同步微任务撤销锚定（`useUndoWithScrollAnchor`）防干扰审查

- 检查 `apps/crish-desktop/src/hooks/useUndoWithScrollAnchor.ts:32,65`：
  该 Hook 在 React 提交阶段同一个微任务中，同步执行 `containerRef.current.scrollTop = Math.max(0, newAnchorTop + anchorOffsetInView)`；
- 由于 Plan 05 坚持 Mode 2 纯类名方案，没有引入任何基于 React 状态调度的自定义 Thumb 或延迟 Proxy，微任务写操作直达 DOM 物理节点，**视口锚定逻辑 100% 保持确定性，零跳跃风险**。

---

### 3.3 【重大隐患发现】`WindowedSessionUl` 双重滚动与嵌套视口死锁

在审查 Plan 05（§4.2）针对侧边栏与虚拟列表的改造时，发现了一处**严重破坏单一真理源（SSOT）的架构设计失误**：

#### 1. 代码事实分析：
- 查看 `apps/crish-desktop/src/components/sidebar/Sidebar.tsx:305-310`：
  侧边栏真正的物理滚动容器是：
  `<div className={styles.sidebarScroll} data-sidebar-chrome="scroll">`。
  其对应的 `Sidebar.module.css:125-132` 声明了 `overflow-y: auto; flex: 1;`；
- 查看 `WindowedSessionUl.tsx:45-56`：
  `WindowedSessionUl` 仅仅是渲染在 `Sidebar.tsx` 内层的一个虚拟列表 `<ul>` 容器，其高度由 `safe.topPad` 垫片和列表行自然撑开，**其自身根本没有声明任何 `overflow-y`！**

#### 2. Plan 05 的错误提案：
Plan 05 在 §4.2 中提出：
- 在 `Sidebar.tsx` 的外层 `sidebarScroll` 上挂载 `scrollArea scrollAreaSm`；
- **同时在 `WindowedSessionUl.tsx` 的 `ul` 元素上也挂载 `scrollArea scrollAreaSm`！**

#### 3. 致命破坏后果：
查阅 Plan 03 中对 `.scrollArea` 的定义：
```css
.scrollArea {
  overflow-y: auto;  /* ❌ 强行赋予滚动能力！ */
  overflow-x: hidden;
  ...
}
```
- 一旦在 `WindowedSessionUl` 的 `ul` 上挂载 `.scrollArea`，`<ul>` 会立刻被浏览器识别为一个**独立的局部滚动容器**！
- **外层 `div.sidebarScroll` 和内层 `ul.sessionListWindowed` 同时具备 `overflow-y: auto`！**
- **灾难后果**：侧栏瞬间出现“双重滚动条（Double Scrollbars）”；当鼠标在内层滚动时，外层视口无法捕获滚动事件，导致虚拟滚动的高度计算与视口监听（`onScroll`）脱节，用户滚动侧栏直接卡死抽搐！
- **整改指令**：**立即撤销对 `WindowedSessionUl.tsx` 的 `.scrollArea` 类名挂载！** 侧边栏的滚动条必须且只能挂载在外层单一主宿主 `Sidebar.tsx`（`styles.sidebarScroll`）上，`WindowedSessionUl` 保持纯净的结构列表，绝对禁止注入任何 `overflow-y: auto` 样式！

---

## 四、使命三：极端几何与数学安全 Inset 审查

### 4.1 【致命缺陷】14px 浮层圆角断头台切角数学方程与按钮防护脱节

在审查 Plan 04（`04-plan-scroll-area.md`）与 Devil Audit 05 的几何模型对齐情况时，发现了**全战役最严重的几何数学盲区与纸面假推导**！

#### 1. Plan 04 Theorem 3 的推导偏离与漏洞
Plan 04 在 §4.4 中写出了“定理 3：外层容器圆角刺穿杜绝定理”，并声称只要 $\text{Margin}_{\text{track}} + H_{\text{btn}} + G_{\text{safe}} \ge R_{\text{corner}}$，就能彻底杜绝圆角截断。
**主审当场拆穿**：
- 该定理**仅仅证明了滑块（Thumb）在移动时不会触碰到圆角区**；
- **但定理完全忽略了位于最顶端的“向上微型三角按钮（Top Button）”自身！**

#### 2. 断头台残酷切角现场还原（Guillotine Clipping）：
- 查看 Plan 04 中的 `ScrollArea.module.css:1066-1070`：
  ```css
  .stepperTrackColumn {
    position: absolute;
    top: var(--scrollbar-track-margin, 2px);
    right: var(--scrollbar-track-margin, 2px);
    bottom: var(--scrollbar-track-margin, 2px);
    width: var(--scrollbar-width);
  }
  ```
- 侧柱的起始坐标为 `top: 2px, right: 2px`；
- 最顶部的向上按钮直接位于 $Y \in [2\text{px},\ 2 + H_{\text{btn}}]$ 区间内（例如对于 md 尺寸，$Y \in [2\text{px},\ 9\text{px}]$）；
- 容器设置了 `border-radius: 14px`（例如 `ModelBadgePickerMenu` 浮层卡片），且由于组件根节点声明了 `overflow: hidden`：
  - 容器右上角圆弧方程为：$(x - (W - 14))^2 + (y - 14)^2 = 14^2$；
  - 在按钮顶沿 $y = 2\text{px}$ 处，圆弧切线横坐标为：
    $$x_{\text{arc}} = W - 14 + \sqrt{14^2 - (2 - 14)^2} = W - 14 + \sqrt{196 - 144} = W - 14 + \sqrt{52} \approx W - 6.79\text{px}$$
  - 然而，按钮的物理占据区间为 $[W - 2 - 7\text{px},\ W - 2\text{px}] = [W - 9\text{px},\ W - 2\text{px}]$！
  - 在 $x \in [W - 6.79\text{px},\ W - 2\text{px}]$ 的区域内，**按钮的右上角完全处于容器圆弧之外！**
  - **惨烈结果**：容器的 `overflow: hidden` 像断头台铡刀一样，直接把向上三角按钮的右上半边削掉！三角图标呈现出极其难看的非对称破损残缺！

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   Plan 04 顶部三角按钮遭遇断头台切角真机复原                       │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 容器右上角 14px 圆弧剪裁线                                                       │
│       ╭───────────────────╮                                                      │
│     ╭─╯  . . . . . . . . .│<--- 容器实际边界                                     │
│    ╭╯   . ┌───────────────┤                                                      │
│   │    .  │ ◢◤ (▲ 顶部三角) │<--- 致命断头台切角！按钮右上部被圆弧生硬削平！     │
│   │   .   └───────────────┤                                                      │
│   │  .    │ Safe Gap (2px)│                                                      │
│   │ .     ├───────────────┤                                                      │
│   │.      │ █  Thumb 滑块 │<--- 滑块虽然处于平直段，但按钮已破损变形！           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### 3. 为什么 Plan 04 出现此漏洞？
- Plan 04 的作者在实现 `ScrollArea.tsx` 时，**完全没有引入 Devil Audit 05 明确要求的 `calculateSafeAreaInset` 动态推导函数！**
- Plan 04 的 Props 契约中甚至没有提供 `radius`、`insetTop`、`insetBottom` 这些几何防护属性！
- **整改指令**：
  1. 必须将 Devil Audit 05 的安全 Inset 公式落地为原子工具函数：
     $$I_y = \left\lceil R - \sqrt{\max\left(0, R^2 - (R - M)^2\right)} \right\rceil + 1$$
  2. 在 `<ScrollArea>` 组件中支持通过 CSS 变量 `--scrollbar-inset-top` 与 `--scrollbar-inset-bottom` 进行动态避让，或者根据外层传入的 `radius` 自动计算 `stepperTrackColumn` 的 `top` 与 `bottom`，绝不允许硬编码 `top: 2px`！

---

### 4.2 【致命缺陷】退化紧凑态算法（Degraded Compact Mode）在 Plan 04 中全量缺失

#### 1. 现象与白盒解剖
在 Devil Audit 05 第 6.2 节中明确规定了**算术下溢崩溃防御（Underflow Protection）**：
- 当容器高度被极限压缩（例如软键盘顶起、屏幕高度较小、或内容项仅有 1~2 项时），可用轨道空间：
  $$\text{AvailableTrackSpace} = H_{\text{container}} - 2 \times (H_{\text{btn}} + G_{\text{safe}}) - 2 \times \text{Margin}$$
- 当 $\text{AvailableTrackSpace} < 16\text{px}$ 时，空间连容纳一个最小滑块（18px）都不足；
- **规范要求**：此时必须自动进入**退化紧凑态（Degraded Compact Mode）**，自动隐藏两端三角按钮，将所有空间归还给原生滑块，绝对禁止出现上下按钮交叉重叠或轨道计算出现负数的算术溢出。

#### 2. Plan 04 的代码现实
查看 Plan 04 中的 `ScrollArea.tsx:692-693` 与 `936-940`：
- 组件只做了朴素的状态判断：
  `const effectiveShowButtons = size === 'xs' ? false : showButtons;`
- 在渲染 `stepperTrackColumn` 时，**完全没有任何针对 `metrics.clientHeight` 的下溢阈值检测！**
- 如果容器高度只有 24px，两个按钮（$2 \times 7 = 14\text{px}$）加上两个 Gap（$2 \times 2 = 4\text{px}$）加上 Margin（$4\text{px}$）直接等于 22px！中间的 `isolatedTrack` 高度仅剩 2px，而内部滑块又被夹持在最小 18px，**导致滑块直接暴冲出轨道，与上下两个按钮全部叠死在一起！**
- **整改指令**：在 `ScrollArea.tsx` 中必须加入对 `clientHeight` 的实时阈值判定。一旦计算出可用轨道空间小于 16px，强制自动退化关闭按钮（`effectiveShowButtons = false`）。

---

### 4.3 【跨方案死锁】Plan 04 强制关闭 `xs` 按钮与 Plan 05 模型菜单 100% 还原之正面冲突

这是本次评审挖掘出的**最荒谬的跨方案逻辑死锁（Plan Contradiction Deadlock）**：

1. **查看 Plan 04 中的硬编码声明**（`04-plan-scroll-area.md:84, 185, 692`）：
   - “`xs: 4px (--scrollbar-width-xs，用于极细浮层，强制无按钮)`”；
   - “`xs: 强制不渲染按钮（槽位 0px），防止在 4px 极细空间下误触；`”；
   - 代码中写死：
     `const effectiveShowButtons = size === 'xs' ? false : showButtons;`
2. **查看 Plan 05 中的业务改造契约**（`05-plan-migrate-views.md:234, 253`）：
   - “`ModelBadgePickerMenu` 改造详案：消费组件 `<ScrollArea size="xs" showButtons={true} ...>`”；
   - “`showButtons={true}` 激活顶部向上、底部向下圆角等腰三角微型步进箭头，100% 还原用户真机截图体验！”
3. **死锁爆发**：
   - Plan 05 期望通过 `size="xs" showButtons={true}` 在模型选择菜单中渲染精致的微型圆角三角；
   - 但 Plan 04 的底层代码却在组件内写死了 `size === 'xs' ? false : showButtons`！
   - **结果：按照这两个方案执行下去，模型选择菜单上的三角按钮将被组件直接吞掉，真机截图还原承诺彻底沦为一张空头支票！**
4. **主审裁决与整改要求**：
   - 彻底废除 Plan 04 中对 `size === 'xs'` 强制关闭按钮的霸王条款；
   - 在 `xs` 模式下，若显式声明了 `showButtons={true}`，必须允许渲染微型三角按钮（底宽 4px，高度 6px）；若未声明 `showButtons` 则默认继承不显示。

---

### 4.4 高 DPI 亚像素 0.5px 接缝亮线与矢量 SVG 光栅化防御审查

在 Windows 125%（DPR=1.25）、150%（DPR=1.5）与 175%（DPR=1.75）分数缩放比例下：
1. **Plan 04 矢量 SVG 图标退化审查**：
   - Plan 04 在 `ScrollArea.tsx:954-956` 与 `989-991` 中直接手写了：
     `<svg viewBox="0 0 10 10" className={styles.arrowIcon}><polygon points="5,2 8.5,7 1.5,7" /></svg>`；
   - **严重失范**：
     - 使用了最原始的尖锐 `<polygon>` 多边形，完全没有用户定案要求的微圆角（$R \approx 1.0\text{px} / 0.8\text{px}$）；
     - **完全丢失了 `shapeRendering="crispEdges"` 属性！**
     - 在 WebView2 分数 DPI 下，尖锐多边形由于缺乏整数物理像素对其，斜边将呈现严重的毛刺与发虚白雾。
2. **接缝亮线与浮点位移失误**：
   - Plan 04 滑块位移直接使用了百分比 `translateY(${thumbTranslateYPercent}%)`；
   - 在分数 DPI 下，百分比转换为浮点数物理像素，导致滑块边缘在物理晶格之间产生亚像素抖动（Shimmering）；
   - **整改指令**：
     - 必须将 Plan 04 的 SVG 图标替换为 Devil Audit 05 第 6.3 节规范的圆角 Path，并强制绑定 `shapeRendering="crispEdges"`；
     - 引入 `snapToDevicePixel` 对滑块位移与 Inset 进行离散取整。

---

## 五、使命四：CI 负向刚性门禁审查

### 5.1 `SCROLLBAR_WHITELIST` 彻底去白名单化审查

审查 Plan 06（`06-plan-gate-ratchet.md`）：
- Plan 06 明确将现存 `apps/crish-desktop/src/styles/style-contract.test.ts:304-317` 的 `SCROLLBAR_WHITELIST` 彻底物理删除；
- 将白名单豁免制彻底扭转为全仓零容忍负向门禁；
- 删除了第 284-295 行强迫 `Menu` 等浮层保留私有 `::-webkit-scrollbar-button` 的反向死断言；
- 删除了第 261-265 行将全局出口与业务类名绑定的脆弱模糊匹配断言。
- **评审判定**：去白名单化与反向断言清理方向完全正确，彻底铲除了保护技术死层的制度温床。

---

### 5.2 【测试源码致命 Bug】Plan 06 中 `parseDarkness` 正则解析错误导致 CI 必炸

在对 Plan 06 提供的“可直接落地测试代码”（Ready-to-Implement Code Spec，§4.1）进行白盒推演时，发现了**一处必将导致 CI 彻底爆红瘫痪的严重代码逻辑 Bug**！

#### 1. Plan 06 的测试代码段还原（`06-plan-gate-ratchet.md:359-371, 619-627`）：
```typescript
const parseDarkness = (tokenName: string): number => {
  const m = lightBlock.match(new RegExp(`${tokenName}:\\s*hsl\\([^)]*?(\\d+(?:\\.\\d+)?)%\\)`));
  if (m) {
    return +(100 - parseFloat(m[1])).toFixed(2);
  }
  // ❌ 灾难由此开始：
  const mixMatch = lightBlock.match(new RegExp(`${tokenName}:[\\s\\S]*?color-mix\\([^;]*?\\);`));
  expect(mixMatch, `无法解析 token ${tokenName} 的颜色定义`).toBeTruthy();
  // 解析 color-mix 中的百分比
  const pct = parseFloat(mixMatch![0].match(/(\d+(?:\.\d+)?)%/)?.[1] ?? '0');
  return pct;
};

const idleDarkness = parseDarkness('--scrollbar-thumb-bg');
const activeDarkness = parseDarkness('--scrollbar-thumb-active');

expect(idleDarkness).toBeGreaterThanOrEqual(7.9);
expect(idleDarkness).toBeLessThanOrEqual(8.5);

expect(activeDarkness).toBeGreaterThanOrEqual(19.9);
expect(activeDarkness).toBeLessThanOrEqual(20.5);
```

#### 2. 致命逻辑穿透：
1. 查看 Plan 01（`01-plan-token-system.md:277-288`）中真实的 Token 定义：
   ```css
   --scrollbar-thumb-bg: color-mix(
     in srgb,
     var(--accent-orange, hsl(38 92% 50%)) 8%,
     hsl(35 8% 91.8%)
   );
   --scrollbar-thumb-active: color-mix(
     in srgb,
     var(--accent-orange, hsl(38 92% 50%)) 16%,
     hsl(35 12% 79.5%)
   );
   ```
2. 当 `parseDarkness` 处理 `--scrollbar-thumb-bg` 时：
   - 目标不是以 `hsl(...)` 开头，进入 `if (!m)` 分支；
   - 正则 `mixMatch![0].match(/(\d+(?:\.\d+)?)%/)` 在整个 `color-mix` 字符串中从左往右扫描**碰到的第一个百分比**；
   - **它碰到的第一个百分比是 `hsl(38 92% 50%)` 里的 `92%`！**
   - 此时 `pct` 被赋值为 `92`！
   - 下游断言：`expect(92).toBeLessThanOrEqual(8.5)` $\implies$ **测试直接爆红断裂！**
3. 即使把 fallback 的 `hsl(38 92% 50%)` 去掉，它匹配到的第一个百分比也是混合比例 `8%` 或 `16%`：
   - 对于激活态 `--scrollbar-thumb-active`，匹配到的百分比是 `16%`；
   - 但下游断言要求：`expect(activeDarkness).toBeGreaterThanOrEqual(19.9)`；
   - **$16 < 19.9$，测试依然 100% 爆红断裂！**
4. **病根剖析**：
   - Plan 06 的作者根本没有理解 Plan 01 的色彩物理学公式！
   - 物理灰度（暗度 $D$）来源于基底色的明度反转（$100\% - 91.8\% = 8.2\%$ 与 $100\% - 79.5\% \approx 20.2\%$）；
   - `color-mix` 里的 `8%` 和 `16%` 只是暖橙的混入比例，绝不是最终灰度值！
   - Plan 06 盲目用一个单层正则 `(\d+)%` 去抓百分比，属于最典型的“不负责任的纸面臆想代码”。
- **整改指令**：重写 `parseDarkness` 算法，分别精确提取基底色明度与混合权重，或通过精确正规匹配基底 HSL 明度进行暗度验算。

---

### 5.3 门禁扫描范围缺陷（`walkSrc` 单包局限性）

如第 2.3 节所述，Plan 06 的门禁用例仅遍历了 `src/`，必须将扫描根路径扩展至同时覆盖 `apps/crish-desktop/src/` 与 `packages/`，确保共享包的死层无法卷土重来。

---

## 六、五大致命缺陷修正指令矩阵（Mandatory Refinements）

为确保战役方案从“纸面构想”平稳跃迁为“工业级可执行代码”，主控在正式签发执行前，必须指令各责任专家完成以下 5 项刚性修正：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           统一滚动条体系战役详案 5 大刚性修正指令矩阵                               │
├────┬────────────────────┬─────────────────────────────┬──────────────────────────────────────────┤
│编号│ 涉及方案与文件     │ 缺陷性质与严重等级          │ 刚性修正要求与落地代码标准               │
├────┼────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
│M01 │ 维度 6 门禁详案    │ 测试用例致命解析 Bug        │ 重写 parseDarkness 正则提取逻辑：        │
│    │ (06-plan-gate)     │ 【CI 必死断裂】             │ 精确匹配第二个参数中的基底 HSL 明度百分比│
│    │                    │                             │ (91.8% -> 8.2%, 79.5% -> 20.2%)，        │
│    │                    │                             │ 并增加对非 auto scrollbar-color 的全仓禁│
├────┼────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
│M02 │ 维度 4 组件详案    │ 几何 Inset 缺失与断头台切角 │ 在 <ScrollArea> 中实装 safeAreaInset     │
│    │ (04-plan-scroll)   │ 【严重视觉破损】            │ 计算逻辑，侧柱支持 dynamic insetTop/bot，│
│    │                    │                             │ 彻底消除 14px 浮层圆角对顶部按钮的削切   │
├────┼────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
│M03 │ 维度 4 组件详案    │ 下溢保护与退化态缺失        │ 在 ScrollArea.tsx 中实装 ClientHeight    │
│    │ (04-plan-scroll)   │ 【极端工况崩溃】            │ 阈值监控，当 AvailableTrackSpace < 16px  │
│    │                    │                             │ 时强制退化关闭按钮，防止滑块挤压越界     │
├────┼────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
│M04 │ 维度 4 vs 维度 5   │ xs 尺寸按钮策略逻辑死锁     │ 解除 Plan 04 对 size="xs" 强制无按钮限制 │
│    │ 跨方案互斥冲突     │ 【用户截图还原落空】        │ 允许 size="xs" 在 showButtons={true} 下  │
│    │                    │                             │ 渲染 4px 微型三角，与 Plan 05 契约对齐   │
├────┼────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
│M05 │ 维度 5 视口迁移    │ 虚拟列表内层注入 overflow   │ 撤销 WindowedSessionUl.tsx 上的          │
│    │ (05-plan-migrate)  │ 【双重滚动条与交互卡死】    │ .scrollArea 类名挂载，滚动由且仅由外层   │
│    │                    │                             │ sidebarScroll 单一视口承载               │
└────┴────────────────────┴─────────────────────────────┴──────────────────────────────────────────┘
```

---

## 七、主审最终结论与签发状态

本评审官（Plan Reviewer C：跨平台与魔鬼边界主审）谨代表工程质量与宿主防御底线，给出最终裁决：

1. **宏观架构高度认可**：
   - 坚持二元灰度绝对死锁（未激活 8.2% vs 激活 20.2%，差值 12.0%）；
   - 坚持四级 Token 宽度体系与全仓零裸写像素；
   - 坚持虚拟列表 DOM 增量严格为 0 与 Mode 2 纯类名隔离；
   - 坚持先删后改，全战役负产出净删除 $\ge 200$ 行代码。
   上述宏观方向完全符合 `AGENTS.md` 铁律与用户最高意志。
2. **微观落地必须纠偏**：
   详案中暴露出的 `parseDarkness` 脑补测试代码、14px 圆角对顶部按钮的真实断头台切角、`WindowedSessionUl` 双重滚动条隐患，以及 `xs` 按钮的跨方案互斥，均属于“未经真实宿主严密推演”产生的纸面破绽。
3. **放行前置条件**：
   必须将上述第 **六** 节中的 **M01 至 M05 五项整改要求** 固化至各详案终稿中。完成修正后，方案方可全面进入代码落地波次！

---
> **评审报告签发确认**：  
> **审查官**：Plan Reviewer C（跨平台与魔鬼边界主审）  
> **报告落盘归档**：`docs/unified-scrollbar-system/plan-reviews/03-review-crossplatform.md`  
> **状态**：**Conditional Approval（限期纠偏后放行）**
