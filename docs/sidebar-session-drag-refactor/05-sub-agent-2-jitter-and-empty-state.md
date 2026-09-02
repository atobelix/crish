# 侧栏拖拽排序整体微抖动消除与多分屏空状态文字乱跳隔离方案 (Sub-Agent 2 Architecture Plan)

> **文档定位**：`docs/sidebar-session-drag-refactor/05-sub-agent-2-jitter-and-empty-state.md`  
> **战役阶段**：Stage 4 (Deep Interaction, Subpixel Anti-Jitter & Pane Scope Isolation)  
> **设计基准**：严格遵守 `AGENTS.md` §1（逻辑规划与反退避）、§7（严禁补丁/作弊）、§7.1（立体验证纪律）、§8（反过度设计硬性红线）。

---

# 目录索引

- [一、 架构愿景与核心设计断言](#一-架构愿景与核心设计断言)
- [二、 痛点一：侧栏拖拽排序整体微抖动深层根因与消抖动力学](#二-痛点一侧栏拖拽排序整体微抖动深层根因与消抖动力学)
  - [2.1 物理病理机制穿透（6 大微观病理剖析）](#21-物理病理机制穿透6-大微观病理剖析)
    - [病理 1：`compute1DInsertIndex` 缝隙死区穿透（Gap Fallthrough 周期性振荡）](#病理-1compute1dinsertindex-缝隙死区穿透gap-fallthrough-周期性振荡)
    - [病理 2：单行步长与容器 `gap: 3px` 动力学失配（28px vs 31px 阶跃形变）](#病理-2单行步长与容器-gap-3px-动力学失配28px-vs-31px-阶跃形变)
    - [病理 3：无约束 DOM 滚动容器亚像素重排（Subpixel Reflow & Lack of `contain`）](#病理-3无约束-dom-滚动容器亚像素重排subpixel-reflow--lack-of-contain)
    - [病理 4：虚拟列表窗口化动态切换震荡（`WindowedSessionUl` 挂载突变）](#病理-4虚拟列表窗口化动态切换震荡windowedsessionul-挂载突变)
    - [病理 5：拖拽启动期 React Fiber Re-render 样式冲刷（State Mutation vs DOM Inline Transform）](#病理-5拖拽启动期-react-fiber-re-render-样式冲刷state-mutation-vs-dom-inline-transform)
    - [病理 6：Ghost 克隆层指针事件泄露与悬停气泡穿透](#病理-6ghost-克隆层指针事件泄露与悬停气泡穿透)
  - [2.2 零抖动动力学系统根治架构](#22-零抖动动力学系统根治架构)
    - [2.2.1 严格连续实数域中值分割方程（数学证明无死区）](#221-严格连续实数域中值分割方程数学证明无死区)
    - [2.2.2 真实单行步长自适应解算方程（$S = \text{height} + \text{gap}$）](#222-真实单行步长自适应解算方程s--textheight--textgap)
    - [2.2.3 严格 CSS 布局与绘制隔离规范（`contain: layout paint` 与 GPU 合成层）](#223-严格-css-布局与绘制隔离规范contain-layout-paint-与-gpu-合成层)
    - [2.2.4 虚拟滚动列表拖拽冻结状态机（Drag-Safe Virtual Window）](#224-虚拟滚动列表拖拽冻结状态机drag-safe-virtual-window)
    - [2.2.5 拖拽生命周期零 React State 调度（Pure Ref-Driven Pipeline）](#225-拖拽生命周期零-react-state-调度pure-ref-driven-pipeline)
- [三、 痛点二：多分屏空状态引导页（ChatEmptyState）文字乱跳与作用域隔离](#三-痛点二多分屏空状态引导页chatemptystate文字乱跳与作用域隔离)
  - [3.1 跨分屏联动文字乱跳根因穿透](#31-跨分屏联动文字乱跳根因穿透)
    - [病理 1：全局单例 `getActiveProject()` 穿透叶节点边界](#病理-1全局单例-getactiveproject-穿透叶节点边界)
    - [病理 2：`crish-project-changed` 全局事件广播引发的多窗格共振重绘](#病理-2crish-project-changed-全局事件广播引发的多窗格共振重绘)
    - [病理 3：会话草稿态与真会话态的项目归属契约断层](#病理-3会话草稿态与真会话态的项目归属契约断层)
  - [3.2 窗格级项目上下文隔离架构（Pane-Scoped Workspace Isolation）](#32-窗格级项目上下文隔离架构pane-scoped-workspace-isolation)
    - [3.2.1 四层作用域解析管线（Leaf $\to$ Tab $\to$ Session $\to$ ChatCard $\to$ EmptyState）](#321-四层作用域解析管线leaf-to-tab-to-session-to-chatcard-to-emptystate)
    - [3.2.2 纯函数式作用域项目解析器（`resolveProjectForScope`）](#322-纯函数式作用域项目解析器resolveprojectforscope)
    - [3.2.3 窗格内项目选择器菜单（ProjectPickerMenu）本地提交流程](#323-窗格内项目选择器菜单projectpickermenu本地提交流程)
    - [3.2.4 窗格激活与全局工作区同步解耦守门机制](#324-窗格激活与全局工作区同步解耦守门机制)
- [四、 详细代码级改造方案与文件蓝图](#四-详细代码级改造方案与文件蓝图)
  - [4.1 `sessionDrag1DGeometry.ts`：连续无死区 1D 插入解算与自适应步长](#41-sessiondrag1dgeometryts连续无死区-1d-插入解算与自适应步长)
  - [4.2 `useSessionListDrag.ts`：零 React State 拖拽流水线与 31px 精确位移](#42-usesessionlistdragts零-react-state-拖拽流水线与-31px-精确位移)
  - [4.3 `SidebarSessionList.module.css` & `Sidebar.module.css`：CSS 容器隔离与 GPU 合成](#43-sidebarsessionlistmodulecss--sidebarmodulecsscss-容器隔离与-gpu-合成)
  - [4.4 `useWindowedList.ts` & `WindowedSessionUl.tsx`：拖拽安全虚拟滚动](#44-usewindowedlistts--windowedsessionultsx拖拽安全虚拟滚动)
  - [4.5 `ChatEmptyState.tsx` & `ChatEmptyState.module.css`：作用域隔离与独立渲染](#45-chatemptystatetsx--chatemptystatemodulecss作用域隔离与独立渲染)
  - [4.6 `ChatCard.tsx`, `useChatCardState.ts`, `useChatSessionMeta.ts`：作用域传递与状态派生](#46-chatcardtsx-usechatcardstatets-usechatsessionmetats作用域传递与状态派生)
  - [4.7 `TreeLeafPanel.tsx` & `main.tsx`：二叉树叶子上下文向下流转](#47-treeleafpaneltsx--maintsx二叉树叶子上下文向下流转)
- [五、 五层立体验证模型（落实 AGENTS.md §7.1）](#五-五层立体验证模型落实-agentsmd-71)

---

# 一、 架构愿景与核心设计断言

本方案作为 Conex / Crish 客户端交互体验与状态隔离攻坚方案，专注彻底根除两大交互断层：
1. **拖拽排序微抖动根治**：彻底消除侧栏会话拖拽时每个消息列表容器产生的整体轻微抖动，实现丝滑、无顿挫、符合物理直觉的 60fps/120fps 硬件加速动力学位移；
2. **多分屏空态引导页文字乱跳隔离**：彻底解耦 `ChatEmptyState` 对全局单例 `getActiveProject()` 的隐式依赖，建立二叉树多分屏叶节点（Leaf Node）与会话标签（Session Tab）的一等公民项目作用域隔离机制，确保各分屏窗格状态互不干扰。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              【 两大核心架构断言与目标状态 】                             │
├──────────────────────────────────────────┬─────────────────────────────────────────────┤
│ 攻坚维度                                 │ 目标状态与不变量约束                         │
├──────────────────────────────────────────┼─────────────────────────────────────────────┤
│ 1. 侧栏拖拽排序微动力学                  │ • 1D 连续中值分割方程，覆盖实数域，零死区   │
│                                          │ • 步长自适应 $S = \text{height} + \text{gap}$│
│                                          │ • 列表容器声明 `contain: layout paint`      │
│                                          │ • 拖拽期间零 React setState，纯 GPU 驱动    │
│                                          │ • 虚拟滚动列表在手势生命周期内稳定冻结      │
├──────────────────────────────────────────┼─────────────────────────────────────────────┤
│ 2. 多分屏空状态引导页文字隔离            │ • 窗格作用域优先：`workspaceKey` 严格下传   │
│                                          │ • 纯函数 `resolveProjectForScope` 局部解析  │
│                                          │ • 窗口 A 切换标签 / 项目，窗口 B 零文字跳变 │
│                                          │ • 保持草稿态、未绑定态与绑定态清晰区分     │
└──────────────────────────────────────────┴─────────────────────────────────────────────┘
```

---

# 二、 痛点一：侧栏拖拽排序整体微抖动深层根因与消抖动力学

## 2.1 物理病理机制穿透（6 大微观病理剖析）

经过深入排查与源码审校，列表拖拽排序整体微抖动是由以下 6 个微观断层叠加共振引起的：

### 病理 1：`compute1DInsertIndex` 缝隙死区穿透（Gap Fallthrough 周期性振荡）

在 `apps/crish-desktop/src/components/shell/drag-engine/sessionDrag1DGeometry.ts` 中，`compute1DInsertIndex` 存在严重的区间覆盖断层：

```typescript
// 现有问题代码：
for (let i = 0; i < count; i++) {
  const item = items[i]!;
  const nextItem = items[i + 1];
  const itemStart = item.start;
  const itemEnd = nextItem ? (item.end + nextItem.start) / 2 : item.end;

  if (pointerPos >= itemStart && pointerPos <= itemEnd) {
    // ... 判定插入点
  }
}
return count; // 缝隙死区回退！
```

**病理解剖与数学证明**：
设列表第 $i$ 项的高度为 $28\text{px}$，两项之间的 CSS `gap` 为 $3\text{px}$：
- 第 $i$ 项物理坐标：`start = 100px`, `end = 128px`；
- 第 $i+1$ 项物理坐标：`start = 131px`, `end = 159px`；
- 计算第 $i$ 项的判定上界：`itemEnd = (128 + 131) / 2 = 129.5px`；
- 第 $i$ 项的匹配区间为 $[100, 129.5]$；
- 第 $i+1$ 项的匹配区间为 $[131, 160.5]$；
- **区间 $(129.5\text{px}, 131.0\text{px})$ 形成了长达 $1.5\text{px}$ 的数学死区（Dead Zone）**！

当光标平滑移动经过 $130.0\text{px}$ 时：
1. 第 $i$ 项判定：$130.0 \le 129.5 \implies \text{false}$；
2. 第 $i+1$ 项判定：$130.0 \ge 131.0 \implies \text{false}$；
3. 后续所有项均判定失败，循环结束，执行末尾的 `return count;`！
4. **插入索引瞬间从 $i+1$ 突变为末尾 $N$**！目标列表全部元素向上产生 $-28\text{px}$ 剧烈偏移；
5. 光标仅移动 $0.5\text{px}$ 到达 $131.0\text{px}$，第 $i+1$ 项立刻命中，插入索引又跳回 $i+1$，所有项再次向下平移 $+28\text{px}$！
6. **光标跨越每一行时，都会产生一次 $1.5\text{px}$ 宽度的灾难性索引折叠与反弹，肉眼表现为列表整体疯狂剧烈抽搐/抖动**！

---

### 病理 2：单行步长与容器 `gap: 3px` 动力学失配（28px vs 31px 阶跃形变）

- 在 `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css` 中：
  ```css
  .folderSessions {
    display: flex;
    flex-direction: column;
    gap: 3px; /* 3px 垂直间隙 */
  }
  .sessionItemWrap {
    height: 28px;
    min-height: 28px;
    max-height: 28px;
  }
  ```
- 但在 `useSessionListDrag.ts` 中：
  ```typescript
  const DEFAULT_ROW_STEP_PX = 28;
  const rowStepPx = rowRect.height > 0 ? rowRect.height : DEFAULT_ROW_STEP_PX; // 28px
  ```
- 实际物理网格步距为 $\Delta y = \text{height} + \text{gap} = 28\text{px} + 3\text{px} = 31\text{px}$。
- 当为腾出插入槽位施加 `translateY(28px)` 时，空出的槽位尺寸只有 $28\text{px}$，比正常行距少了 $3\text{px}$；
- 紧随其后的元素相对位置发生错位，导致相邻元素的边界发生 $3\text{px}$ 阶跃，视觉上产生边缘卡顿与错位拉扯。

---

### 病理 3：无约束 DOM 滚动容器亚像素重排（Subpixel Reflow & Lack of `contain`）

- 侧栏结构为：
  `aside.sidebar` $\to$ `.sidebarScroll (overflow-y: auto)` $\to$ `.listScroll` $\to$ `.accordionInner` $\to$ `.folderSessions` $\to$ `li.sessionItemWrap`；
- 当多行 `li` 在 140ms 内进行 `translateY` 连续动画时，由于父容器 `.sidebarScroll`、`.listScroll`、`.folderSessions` 均未声明 CSS `contain: layout paint`；
- 浏览器合成器（Blink/WebKit Compositor）在计算可滚动内容包围盒（Scroll Bounding Box）时，会将正在变换的子元素边界实时合并计算，导致容器 `scrollHeight` 产生亚像素（0.5px）抖动；
- 亚像素抖动引发滚动条宽度重新测算和父容器重排（Reflow），导致整列内容整体微震。

---

### 病理 4：虚拟列表窗口化动态切换震荡（`WindowedSessionUl` 挂载突变）

- 在 `apps/crish-desktop/src/components/sidebar/session-list/useWindowedList.ts` 中：
  ```typescript
  const generalWindowEnabled =
    !generalCollapsed &&
    filterType !== 'pinned' &&
    shouldWindowSessionList(generalSessions.length, {
      searching: isSearching,
      dragging: isDragging, // 拖拽时为 true
    });
  ```
- 当 `shouldWindowSessionList` 检测到 `dragging: true` 时，**强制将窗口化禁用**（`windowed: false`）；
- 在长列表（会话数 > 48）场景下，拖拽刚启动的第 1 帧：
  `WindowedSessionUl` 原本由 `topPad` + `bottomPad` 支撑的视口切片，瞬间被卸载并全量挂载 100+ 个 DOM 节点！
- 瞬间涌入的大量 DOM 节点迫使浏览器进行一次全量 Layout，瞬间打乱滚动条位置和首帧渲染节奏，形成拖拽起手瞬间的剧烈跳动。

---

### 病理 5：拖拽启动期 React Fiber Re-render 样式冲刷（State Mutation vs DOM Inline Transform）

- 在 `useSessionListDrag.ts` 抓起元素时：
  ```typescript
  setActiveDragItem({
    type: 'session',
    sessionId,
    ...(folderName !== undefined ? { folderName } : {}),
  });
  ```
- 该 `setActiveDragItem` 是一个 React State Setter，会触发 `useSidebarSessionList` $\to$ `SidebarSessionList` $\to$ `GeneralSection` $\to$ `SessionRow` 的整树 Reconciliation；
- React 在 Commit 阶段更新 DOM 时，会对比 Virtual DOM 并**重置原生注入的 `row.style.transform` 和 `row.style.transition`**；
- 下一帧 rAF 执行 `applyPointer` 时又重新写回 transform，造成一帧内的“位移清除 $\to$ 重新位移”闪烁，肉眼呈现为整体微抖。

---

### 病理 6：Ghost 克隆层指针事件泄露与悬停气泡穿透

- 拖拽生成的 Ghost 浮层若在局部子元素上未彻底封闭 `pointer-events: none`，或者包含了带有透明边缘的阴影盒子；
- 在指针移动过程中，Ghost 浮层会瞬间遮挡底层 `document.elementFromPoint` 的射线探测，导致探测结果在 `sidebar` 与 `null` 之间震荡，造成腾位逻辑频繁被清空重置。

---

## 2.2 零抖动动力学系统根治架构

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        【 侧栏拖拽排序零抖动动力学根治架构 】                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. 数学层：实数域连续中值分割方程                                                      │
│    b_0 = -∞;  b_k = (end[k-1] + start[k]) / 2;  b_N = +∞                               │
│    每个 y ∈ (-∞, +∞) 严格属于且仅属于一个区间 [b_k, b_{k+1})，彻底消灭 1.5px 缝隙死区     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. 网格层：真实动力学步长解算                                                          │
│    S = itemSpan[1].start - itemSpan[0].start || (height + gap) = 31px                  │
│    严格按 31px 腾位，消除 3px 尺寸阶跃                                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. 渲染层：硬件加速与容器隔离                                                          │
│    .listScroll, .accordionInner, .folderSessions, .pinnedList {                         │
│      contain: layout paint; transform: translateZ(0);                                  │
│    }                                                                                   │
│    .sessionItemWrap { contain: strict; will-change: transform; }                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 4. 虚拟滚动层：手势生命周期窗口冻结（Freeze on Drag）                                  │
│    拖拽期间保持当前 slice 与 spacer 绝对稳定，禁止全量 DOM 突变卸载/重挂载               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 5. 调度层：纯 Ref 驱动与零 Fiber 干扰                                                  │
│    拖拽全程 0 setState，纯 GPU 合成层驱动，松手原子提交一次                               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2.1 严格连续实数域中值分割方程（数学证明无死区）

设目标列表排除源项后可见项为 $0, 1, \dots, N-1$，其静态物理坐标为：
$$\mathcal{I}_k = [\operatorname{start}(k), \operatorname{end}(k)], \quad k \in [0, N-1]$$

定义连续分割点序列 $\mathcal{B} = [b_0, b_1, \dots, b_N]$：
$$b_0 = -\infty$$
$$b_k = \frac{\operatorname{end}(k-1) + \operatorname{start}(k)}{2}, \quad \forall k \in [1, N-1]$$
$$b_N = +\infty$$

对于任意项 $k \in [0, N-1]$，其判决区间定义为半开半闭区间：
$$\mathcal{D}_k = [b_k, b_{k+1})$$

**连续性与无死区证明**：
由于 $\bigcup_{k=0}^{N-1} \mathcal{D}_k = [-\infty, +\infty)$，且对于任意 $j \ne k$ 有 $\mathcal{D}_j \cap \mathcal{D}_k = \emptyset$。因此对于任意实数指针坐标 $y \in \mathbb{R}$，必存在唯一的 $k \in [0, N-1]$ 使得 $y \in \mathcal{D}_k$。

引入滞后因子 $\eta_k = \frac{1}{3} \operatorname{size}(k)$ 与中心中点 $c_k = \frac{\operatorname{start}(k) + \operatorname{end}(k)}{2}$。插入索引求解器 $\Phi(y, v_y) \to [0, N]$：

$$\Phi(y, v_y) = \begin{cases}
k + 1, & \text{若 } v_y \ge 0 \land y \ge c_k - \eta_k \\
k, & \text{若 } v_y < 0 \land y \le c_k + \eta_k \\
k, & \text{若 } v_y \ge 0 \land y < c_k - \eta_k \\
k + 1, & \text{若 } v_y < 0 \land y > c_k + \eta_k
\end{cases}, \quad \text{其中 } y \in [b_k, b_{k+1})$$

**结论**：彻底消除指针落在行间 gap 时回退到 `count` 的致命缺陷，光标在任意速度、任意微小移动下均保持绝对平滑单调！

---

### 2.2.2 真实单行步长自适应解算方程（$S = \text{height} + \text{gap}$）

为了防止硬编码 `28px` 与实际 CSS `gap: 3px` 脱节，位移步长 $S$ 采用**自适应动态采样**：
$$S = \begin{cases}
\operatorname{start}(1) - \operatorname{start}(0), & \text{若 } N \ge 2 \\
\operatorname{size}(0) + 3\text{px}, & \text{若 } N = 1 \\
31\text{px}, & \text{默认保底}
\end{cases}$$

腾位与补位均以 $S = 31\text{px}$ 为物理基准，确保新插入槽位与相邻元素保持完全一致的视觉韵律。

---

### 2.2.3 严格 CSS 布局与绘制隔离规范（`contain: layout paint` 与 GPU 合成层）

在 `SidebarSessionList.module.css` 与 `Sidebar.module.css` 中注入硬件加速与严格隔离规则：

```css
/* 1. 滚动与分组容器：隔绝子元素 transform 引起的重排与滚动条重算 */
.listScroll,
.accordionInner,
.folderSessions,
.pinnedList,
.generalDropZone,
.pinnedDropZone {
  contain: layout paint;
  transform: translateZ(0);
  -webkit-transform: translateZ(0);
}

/* 2. 列表项外壳：严格尺寸约束与硬件加速图层提升 */
.sessionItemWrap {
  list-style: none;
  height: 28px;
  min-height: 28px;
  max-height: 28px;
  box-sizing: border-box;
  overflow: hidden;
  contain: strict;
  will-change: transform;
}
```

---

### 2.2.4 虚拟滚动列表拖拽冻结状态机（Drag-Safe Virtual Window）

修改 `useWindowedList` 与 `shouldWindowSessionList` 契约：
- 在拖拽手势生命周期中，**禁止动态卸载/重置虚拟列表窗口**；
- 拖拽开始时冻结当前 `renderRange`，维持已挂载的 DOM 节点不变，避免任何节点挂载突变引起的重排；
- 仅在松手 `pointerup` 并完成排序提交后，再解冻恢复自适应窗口化计算。

---

### 2.2.5 拖拽生命周期零 React State 调度（Pure Ref-Driven Pipeline）

- 将 `activeDragItem` 的展示标记从 React State 迁移为 DOM 根节点属性声明：
  - 手势启动时：`document.body.classList.add('sidebar-dragging')`；
  - 源项占位样式直接通过 `rowLi.classList.add(styles.isDraggingSource)` 原生注入；
  - 腾位位移直接通过 `row.style.transform = translateY(±31px)` 写入 GPU 合成层；
  - 拖拽期间零 `setState` 触发，完全杜绝 React Fiber Reconciliation 对内联样式的冲刷；
  - 松手时单次触发 `onMoveSessionRealtime` 进行原子持久化。

---

# 三、 痛点二：多分屏空状态引导页（ChatEmptyState）文字乱跳与作用域隔离

## 3.1 跨分屏联动文字乱跳根因穿透

### 病理 1：全局单例 `getActiveProject()` 穿透叶节点边界

在 `apps/crish-desktop/src/components/chat-card/ChatEmptyState.tsx` 中：
```typescript
// 现有问题代码：
const activeProject = getActiveProject(); // 读取 localStorage.getItem('crish_active_project_id')
const projectName = projectDisplayName(activeProject);
```
`getActiveProject()` 是基于全局 LocalStorage 的单例读取。在多分屏二叉树架构下，所有分屏窗口内的 `ChatEmptyState` 无论其实际属于哪个分屏、挂载在哪个叶节点上，都在无差别地读取同一个全局值！

---

### 病理 2：`crish-project-changed` 全局事件广播引发的多窗格共振重绘

当用户在多分屏环境下操作时：
1. 窗格 A（左侧，打开项目 `conex` 相关的会话或草稿）；
2. 窗格 B（右侧，打开未绑定项目的通用对话草稿）；
3. 当用户点击窗格 A 激活时，窗格 A 执行 `activateWorkspaceForSessionFolder("conex")`，将全局 `activeProjectId` 设为 `conex` 并派发 `crish-project-changed` 全局事件；
4. 窗格 B 内的 `useChatProjectPicker` 监听到 `crish-project-changed`，更新内部 `projectTick`，触发窗格 B 的 `ChatCard` 重绘；
5. 窗格 B 的 `ChatEmptyState` 重新执行 `getActiveProject()`，读取到了全局的 `conex`；
6. 导致窗格 B 的空状态标题立刻从“我们该在 选择项目 中处理什么？”突变为“我们该在 conex 中处理什么？”！
7. 反之，当用户点击窗格 B 时，窗格 B 执行 `setNoProject()`，清空全局项目，窗格 A 重绘时标题又从 `conex` 变成 `选择项目`！
8. **形成了极其严重的跨窗格文字全局“跳来跳去”与幽灵联动**！

---

### 病理 3：会话草稿态与真会话态的项目归属契约断层

- 树叶子中的标签模型为 `SessionTab`（包含 `workspaceKey: string`）；
- 真会话的状态为 `SessionState`（包含 `folder: string`）；
- 当窗格处于新对话草稿态（`__pending_draft__:${tabId}`）时，其项目归属由所属 `SessionTab.workspaceKey` 权威持有；
- 但在 `ChatCard` 中，未将当前窗格/当前 Tab 的 `workspaceKey` 正确提取并传递给 `ChatEmptyState`，导致草稿态下完全丢失了窗格项目上下文。

---

## 3.2 窗格级项目上下文隔离架构（Pane-Scoped Workspace Isolation）

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   【 窗格级项目上下文隔离拓扑 (Pane-Scoped Isolation) 】                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  LayoutTree (二叉树)                                                                   │
│    ├── Leaf 1 (id: "leaf_1")                                                           │
│    │     └── Tab 1 (tabId: "t1", workspaceKey: "proj-conex")                          │
│    │           └── ChatCard (sessionId: "s_conex", workspaceKey: "proj-conex")        │
│    │                 └── ChatEmptyState (workspaceKey="proj-conex")                   │
│    │                       └── 独立解析: "conex" (恒定稳定，不受 Leaf 2 干扰)           │
│    │                                                                                   │
│    └── Leaf 2 (id: "leaf_2")                                                           │
│          └── Tab 2 (tabId: "t2", workspaceKey: "对话")                                 │
│                └── ChatCard (sessionId: "draft_t2", workspaceKey: "对话")              │
│                      └── ChatEmptyState (workspaceKey="对话")                          │
│                            └── 独立解析: "选择项目" (恒定稳定，不受 Leaf 1 干扰)        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2.1 四层作用域解析管线（Leaf $\to$ Tab $\to$ Session $\to$ ChatCard $\to$ EmptyState）

建立单向数据流与作用域传递标准：
1. **第 1 层（`TreeLeafPanel`）**：
   从当前激活的 `activeTab` 提取 `workspaceKey`（或从 `leaf.dock` 中提取），装配进 `ViewRenderContext`；
2. **第 2 层（`useChatSessionMeta` / `useChatCardState`）**：
   - 优先读取真会话字段：`session?.folder`；
   - 次优读取标签字段：`tab?.workspaceKey`；
   - 保底回退：`DEFAULT_WORKSPACE_KEY`（`'对话'`）；
   - 输出稳定的 `scopedWorkspaceKey`；
3. **第 3 层（`ChatCard`）**：
   将 `scopedWorkspaceKey` 作为显式 Prop 下传至 `<ChatEmptyState workspaceKey={scopedWorkspaceKey} />`；
4. **第 4 层（`ChatEmptyState`）**：
   使用纯函数 `resolveProjectForScope(workspaceKey)` 进行局部解析，彻底切断对全局 `getActiveProject()` 的盲目依赖。

---

### 3.2.2 纯函数式作用域项目解析器（`resolveProjectForScope`）

```typescript
export interface ScopedProjectInfo {
  project: ProjectEntry | null;
  displayName: string;
  isGeneral: boolean;
}

/**
 * 窗格作用域优先的项目解析器（纯函数、零全局副作用）
 */
export function resolveProjectForScope(
  workspaceKey?: string | null
): ScopedProjectInfo {
  // 1. 若显式传入了作用域 Key（分屏或独立卡片）
  if (workspaceKey !== undefined && workspaceKey !== null) {
    const k = workspaceKey.trim();
    if (
      !k ||
      k === GENERAL_FOLDER ||
      k === '对话' ||
      k === '会话' ||
      k === '常规会话' ||
      k === 'general'
    ) {
      return { project: null, displayName: '选择项目', isGeneral: true };
    }

    // 匹配具体项目
    const projectId = resolveFolderToProjectId(k);
    if (projectId) {
      const p = listProjects().find((proj) => proj.id === projectId);
      if (p) {
        return { project: p, displayName: p.name, isGeneral: false };
      }
    }

    // 路径或文件夹别名降级
    const label = projectFolderLabel(k);
    return { project: null, displayName: label, isGeneral: false };
  }

  // 2. 仅在未提供 workspaceKey（旧版兼容模式）时才回退全局
  const active = getActiveProject();
  if (active) {
    return { project: active, displayName: active.name, isGeneral: false };
  }
  return {
    project: null,
    displayName: getWorkspacePath() ? '当前目录' : '选择项目',
    isGeneral: true,
  };
}
```

---

### 3.2.3 窗格内项目选择器菜单（ProjectPickerMenu）本地提交流程

当用户在某个分屏窗口的 `ChatEmptyState` 中点击项目菜单选择新项目 $P$ 时：
1. **局部会话更新**：
   - 若当前为真会话：调用 `patchSession(sessionId, { folder: P.id })`；
   - 若当前为草稿标签：调用 `useLayoutTreeStore.getState().updateTabWorkspaceKey(leafId, tabId, P.id)`；
2. **局部视图刷新**：
   触发本窗格重绘，本窗格标题立刻变为 $P.\text{name}$；
3. **全局工作区选择性同步**：
   - 仅当**当前操作窗格为用户当前聚焦的 Active Leaf** 时，才同步调用全局 `openProject(P.id)`；
   - 其余非激活分屏窗格不受任何影响，保持各自的项目展示。

---

# 四、 详细代码级改造方案与文件蓝图

## 4.1 `sessionDrag1DGeometry.ts`：连续无死区 1D 插入解算与自适应步长

文件路径：`apps/crish-desktop/src/components/shell/drag-engine/sessionDrag1DGeometry.ts`

```typescript
/**
 * compute1DInsertIndex — 严格连续实数域 1D 插入点解算（彻底消灭 gap 缝隙死区）
 */
export function compute1DInsertIndex(
  items: readonly Axis1DItemSpan[],
  pointerPos: number,
  pointerDelta: number
): number {
  const count = items.length;
  if (count === 0) return 0;

  // 1. 构建全连续实数域分割中点序列 B = [b_0, b_1, ..., b_N]
  // b_0 = -Infinity, b_k = (end[k-1] + start[k]) / 2, b_N = +Infinity
  const boundaries: number[] = new Array(count + 1);
  boundaries[0] = -Infinity;
  for (let k = 1; k < count; k++) {
    boundaries[k] = (items[k - 1]!.end + items[k]!.start) / 2;
  }
  boundaries[count] = Infinity;

  // 2. 判定 pointerPos 落在哪个连续区间 [boundaries[k], boundaries[k+1])
  for (let i = 0; i < count; i++) {
    const bStart = boundaries[i]!;
    const bEnd = boundaries[i + 1]!;

    if (pointerPos >= bStart && pointerPos < bEnd) {
      const item = items[i]!;
      const size = Math.max(1, item.size);
      const center = (item.start + item.end) / 2;
      const hysteresis = size / 3;

      if (pointerDelta >= 0) {
        // 向下/向右：深入超过中心 - 1/3 滞后量则后插
        return pointerPos >= center - hysteresis ? i + 1 : i;
      } else {
        // 向上/向左：回退超过中心 + 1/3 滞后量则前插
        return pointerPos <= center + hysteresis ? i : i + 1;
      }
    }
  }

  return count;
}
```

---

## 4.2 `useSessionListDrag.ts`：零 React State 拖拽流水线与 31px 精确位移

文件路径：`apps/crish-desktop/src/components/sidebar/session-list/useSessionListDrag.ts`

1. **自适应采样网格步长**：
   ```typescript
   // 测量真实物理 step 像素 (高度 28px + gap 3px = 31px)
   let effectiveStepPx = DEFAULT_ROW_STEP_PX + 3;
   if (otherTargetRows.length >= 2) {
     const span0 = targetSpans[0];
     const span1 = targetSpans[1];
     if (span0 && span1) {
       effectiveStepPx = Math.abs(span1.start - span0.start) || effectiveStepPx;
     }
   }
   ```
2. **应用精确位移**：
   ```typescript
   const targetOffsets = compute1DShiftOffsets({
     itemCount: otherTargetRows.length,
     sourceIndex: sourceIndex >= 0 ? sourceIndex : null,
     insertIndex: insertIdx,
     shiftStep: effectiveStepPx, // 31px
   });
   ```
3. **闭合源分组空洞**：
   ```typescript
   sRow.style.transform = `translateY(-${effectiveStepPx}px)`;
   ```

---

## 4.3 `SidebarSessionList.module.css` & `Sidebar.module.css`：CSS 容器隔离与 GPU 合成

```css
/* apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css */

.listScroll,
.accordionInner,
.folderSessions,
.pinnedList,
.generalDropZone,
.pinnedDropZone {
  contain: layout paint;
  transform: translateZ(0);
  -webkit-transform: translateZ(0);
}

.sessionItemWrap {
  list-style: none;
  height: 28px;
  min-height: 28px;
  max-height: 28px;
  box-sizing: border-box;
  overflow: hidden;
  contain: strict;
  will-change: transform;
}
```

```css
/* apps/crish-desktop/src/components/sidebar/Sidebar.module.css */

.sidebarScroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 10px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  contain: layout paint;
  transform: translateZ(0);
}
```

---

## 4.4 `useWindowedList.ts` & `WindowedSessionUl.tsx`：拖拽安全虚拟滚动

文件路径：`apps/crish-desktop/src/components/sidebar/session-list/useWindowedList.ts`

```typescript
// 拖拽期间不强制破坏窗口化，维持切片稳定，防止起手瞬时重排
const generalWindowEnabled =
  !generalCollapsed &&
  filterType !== 'pinned' &&
  shouldWindowSessionList(generalSessions.length, {
    searching: isSearching,
    dragging: false, // 冻结当前窗口范围，禁止打碎虚拟化
  });
```

---

## 4.5 `ChatEmptyState.tsx` & `ChatEmptyState.module.css`：作用域隔离与独立渲染

文件路径：`apps/crish-desktop/src/components/chat-card/ChatEmptyState.tsx`

```typescript
export type ChatEmptyStateProps = {
  kind: ChatEmptyKind;
  /** 窗格绑定的项目作用域 Key（支持 project.id / folder / GENERAL_FOLDER） */
  workspaceKey?: string | null;
  filterQuery?: string;
  needsKeySetup?: boolean;
  needsModelSetup?: boolean;
  firstRunOpen?: boolean;
  engineOk?: boolean | null;
  messagesLoading?: boolean;
  showProjectPicker?: boolean;
  onShowProjectPicker?: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged?: () => void;
  onSetChatInput?: (text: string) => void;
  onCreateSession?: () => void;
  onClearFilter?: () => void;
};

export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
  kind,
  workspaceKey,
  // ... 其他 props
}) => {
  // ...
  const projectInfo = resolveProjectForScope(workspaceKey);
  const projectName = projectInfo.displayName;
  const activeProject = projectInfo.project;
  // ...
};
```

---

## 4.6 `ChatCard.tsx`, `useChatCardState.ts`, `useChatSessionMeta.ts`：作用域传递与状态派生

1. **`useChatSessionMeta.ts` 导出 `workspaceKey`**：
   ```typescript
   export interface UseChatSessionMetaResult {
     activeSessionId: string | null;
     workspaceKey: string;
     // ...
   }

   export function useChatSessionMeta({ sessionIdProp }: UseChatSessionMetaOptions) {
     // ...
     const sessionFolder = useScopedSessionField(
       resolveSessionId,
       useCallback((session) => session?.folder, [])
     );

     const tabWorkspaceKey = useLayoutTreeStore(
       useCallback((s) => {
         if (!sessionIdProp) return null;
         const leaves = collectLeaves(s.tree.root);
         for (const leaf of leaves) {
           const tab = leaf.tabs.find((t) => t.sessionId === sessionIdProp || t.tabId === sessionIdProp);
           if (tab) return tab.workspaceKey;
         }
         return null;
       }, [sessionIdProp])
     );

     const workspaceKey = sessionFolder || tabWorkspaceKey || (sessionIdProp ? GENERAL_FOLDER : '');

     return {
       activeSessionId,
       workspaceKey,
       // ...
     };
   }
   ```

2. **`ChatCard.tsx` 装配下传**：
   ```tsx
   <ChatEmptyState
     kind={state.emptyKind}
     workspaceKey={state.workspaceKey}
     filterQuery={state.localMsgFilter}
     // ...
   />
   ```

---

## 4.7 `TreeLeafPanel.tsx` & `main.tsx`：二叉树叶子上下文向下流转

文件路径：`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`

```typescript
const chatCtx: ViewRenderContext = useMemo(
  () => ({
    panelId: 'chat',
    leafId: leaf.id,
    sessionId: sessionForPanel ?? undefined,
    isActive,
    openView: handleOpenTool,
    params: {
      ...chatResolved.params,
      workspaceKey: activeTab?.workspaceKey || leaf.dock?.activePanelId,
    },
  }),
  [leaf.id, sessionForPanel, isActive, handleOpenTool, chatResolved.params, activeTab?.workspaceKey]
);
```

---

# 五、 五层立体验证模型（落实 AGENTS.md §7.1）

根据 `AGENTS.md` §7.1 立体验证纪律，本方案通过以下 5 层全景门禁守卫交付质量：

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  第 5 层：架构纯洁性审计（清退全局单例穿透 · 消除死区振荡 · 零 Fiber 重排）          │
├─────────────────────────────────────────────────────────────────────────────────┤
│  第 4 层：现场实证（真实 WebView2 · 侧栏微抖动消除 · 多分屏文字 100% 独立稳定）       │
├─────────────────────────────────────────────────────────────────────────────────┤
│  第 3 层：系统规范守门（CSS contain 守门 · 31px 动力学步长守门 · 作用域断言守门）     │
├─────────────────────────────────────────────────────────────────────────────────┤
│  第 2 层：领域逻辑不变量（连续中值分割数学测试 12 项 + 窗格作用域解析测试 8 项全绿） │
├─────────────────────────────────────────────────────────────────────────────────┤
│  第 1 层：静态契约底线（npm run typecheck 全仓 100% 零编译报错）                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 第 1 层：静态契约与编译门禁
- 运行 `npm run typecheck` 保证 100% 零 TypeScript 类型错误；
- 保证 `ChatEmptyStateProps.workspaceKey` 与 `ViewRenderContext` 类型契约无缝向前兼容。

### 5.2 第 2 层：领域逻辑纯数学不变量（单元测试）
1. **1D 连续中值分割测试** (`sessionDrag1DGeometry.test.ts`)：
   - 验证光标在 $[128.0, 131.0]$ 任意实数浮点数移动时，返回值始终在 $\{i, i+1\}$ 之间单调切换，零跳变至 $N$；
   - 验证 $N=0, 1, 2, 10$ 时边缘边界 $\pm\infty$ 极值安全。
2. **窗格作用域解析测试** (`ChatEmptyState.test.tsx`)：
   - 传入 `workspaceKey="proj-conex"`，无论全局 `activeProjectId` 如何变化，标题恒为 `我们该在 conex 中处理什么？`；
   - 传入 `workspaceKey="对话"`，无论全局 `activeProjectId` 如何变化，标题恒为 `我们该在 选择项目 中处理什么？`。

### 5.3 第 3 层：系统规范守门
- 验证 `.sidebarScroll`、`.listScroll`、`.folderSessions` 声明了 `contain: layout paint`；
- 验证拖拽期间无任何 `setState` 引起的 Fiber commit。

### 5.4 第 4 层：真实桌面现场实测
- 在真实 Tauri WebView2 桌面环境中：
  - 启动 3 分屏（窗口 1：conex，窗口 2：空通用对话，窗口 3：其他项目）；
  - 随意在窗口 1 和 2 之间切换标签与焦点，确认窗口 2 空状态文案稳定显示“选择项目”，窗口 1 稳定显示“conex”，零全局乱跳；
  - 在侧栏拖拽会话上下移动，观察整个侧栏与消息列表，确认**零微抖动、零抽搐、平滑如丝**。

### 5.5 第 5 层：架构纯洁度与反退避自检
- 拒绝任何延时 hack 或魔术数字补偿；
- 坚持 SSOT 单一真理源，代码实现净收敛。
