# 架构审计报告 C：跨域隔离防线可行性与红队穿透审查

> **审计标的**：
> - `docs/dock-split-system/00-总方案.md` §3.4（四重跨域隔离防线）
> - `docs/dock-split-system/analysis/04-拖拽体系与域隔离防线.md`（完整方案）
>
> **审计角色**：红队安全与防线可行性审计师  
> **审计依据**：仓库代码实地白盒核查、通用协作纪律 `AGENTS.md`、反退避全文 `.agents/LOGIC_PLAN_NO_RETREAT.md`、W3C Pointer Events 标准规范。  
> **用户核心红线**：**对话内部在右侧功能区打开的工具面板，绝对不能被拖拽到顶栏 `class="_tabsContainer_1wzf4_71"`（即 PaneHeader 的 `tabsContainer`）中**。  
> **审计结论总览**：经红队渗透式代码白盒核查，方案提出的“四重跨域隔离防线”在真实运行期存在 **4 处架构冲突与逻辑死锁（必须阻断解决）** 与 **1 处触控/键盘覆盖警告（需明确防护口径）**。方案中所谓的“协议隔离”与“顶栏 DOM 门锁”在当前 W3C 事件捕获模型与 React 上下文体系下存在被完全旁路、成为无用死代码的重大缺陷，严禁直接照搬现有方案伪代码进入实施阶段。

---

## 维度 1：防线 1（协议隔离）的实际效力

### 审计结论：**[冲突：必须解决]**

### 1.1 “协议 URL”是纯概念幻觉，本质是单进程内存 JS 字段，无底层物理隔离能力

方案 00 §3.4（`00-总方案.md:174-177`）声称：
> “顶栏拖拽使用 `conex://drag-session-tab`；右坞拖拽使用 `conex://drag-dock-tool`；数据载荷完全不兼容，底层逻辑无法反序列化。”

但在方案 04 §3.1（`04-拖拽体系与域隔离防线.md:127-133`）中，口径又漂移成了 MIME 类型：
> `export const SESSION_TAB_DRAG_DOMAIN = 'application/x-conex-session-tab';`  
> `export const DOCK_TOOL_DRAG_DOMAIN = 'application/x-conex-dock-tool';`

**红队白盒核查现场证据**：
- 核查 `apps/crish-desktop/src/components/shell/SessionTabDragContext.tsx:87-140`：
  现有会话拖拽的整个生命周期完全运行在单一 Webview2 渲染进程、单一 React 组件树内。拖拽源数据、抓取点坐标与临时状态全部保存在 `startSessionDrag` 闭包变量与局部 state 中。系统**根本没有使用 HTML5 DataTransfer API**，更没有操作系统或浏览器底层的自定义协议注册表（Protocol Handler）。
- 所谓的 `conex://...` 协议或 `application/x-conex-...`，在运行时代码中**纯粹是一个 JavaScript 字符串字面量（String Literal）**。
- 这意味着：没有任何浏览器网络栈或操作系统内核为这两个所谓的“协议”提供物理边界。它们在同一个 JS 运行期主线程里共享相同的内存寻址空间，所谓“底层逻辑无法反序列化”纯属修辞概念，没有任何运行期刚性阻断保障。

### 1.2 缺乏 TypeScript 编译期不可伪造的类型收敛，粗心调用即造成越界穿透

如果仅依靠字符串字段来标记拖拽域，在工程实践中存在致命隐患：
1. **漏检风险（Omission Vulnerability）**：
   在 `apps/crish-desktop/src/components/shell/SessionTabDragContext.tsx:342-354` 中，`onPointerUp` 的现有实现为：
   ```typescript
   const onPointerUp = (me: PointerEvent) => {
     if (me.pointerId !== pointerId) return;
     const drop = target;
     const wasDrag = dragging;
     cleanup();
     if (wasDrag) swallowNextClick();
     if (!wasDrag || !drop) return;
     commitSessionTabDrop({
       sourceLeafId,
       tabId,
       target: drop,
     });
   };
   ```
   代码内部**完全没有**校验任何 `domain` 字段。如果右坞拖拽控制器或未来的开发者粗心地直接复用了落点检测或提交逻辑，或者在重构时把右坞工具的 `panelId` 赋值给 `tabId`，系统将直接把工具面板当作会话标签注入顶层 `moveTab`，导致顶层会话树严重受损。
2. **两份核心方案口径严重割裂**：
   `00-总方案.md:174-177`（URI Scheme 风格）与 `04-拖拽体系与域隔离防线.md:128-129`（MIME 类型风格）对防线 1 的核心标识定义完全不一致。这不仅证明方案未形成代码级真实契约，还会诱导开发人员在不同模块写出 `source.domain === 'conex://...'` 与 `source.domain === 'application/...'` 互不匹配的低级 Bug。

### 1.3 修复与加固裁决
1. 废除具有误导性的“协议 URL 隔离”提法，明确其为**“基于 TypeScript 判别联合类型（Discriminated Union）的强类型域隔离”**；
2. 建立不可互换的强类型契约：
   ```typescript
   export interface SessionTabDragPayload {
     readonly __domain: 'DOMAIN_SESSION_TAB';
     sourceLeafId: string;
     tabId: string;
     title: string;
   }

   export interface DockToolDragPayload {
     readonly __domain: 'DOMAIN_DOCK_TOOL';
     sourceSessionId: string;
     sourceDockLeafId: string;
     panelId: string;
     title: string;
   }
   ```
3. 在类型签名层面将两者彻底隔离，禁止任何泛型隐式转换，并强制要求提交函数仅接受对应的 Brand Payload。

---

## 维度 2：防线 2（顶栏 DOM 门锁）的注册时机与竞态

### 审计结论：**[冲突：必须解决]**

### 2.1 致命物理硬伤：`setPointerCapture` 使顶栏 DOM 门锁 100% 沦为死代码

方案 00 §3.4 提出顶栏挂载 `data-reject-dock-tools="true"`，方案 04 §7.3（`04-拖拽体系与域隔离防线.md:666-688`）给出了具体门锁实现伪代码：
```tsx
// PaneHeader.tsx 针对 styles.tabsContainer (class="_tabsContainer_1wzf4_71")
<div
  ref={setContainerRef}
  className={styles.tabsContainer}
  onPointerEnter={(e) => {
    if (document.body.getAttribute('data-drag-domain') === 'dock-tool') {
      e.preventDefault();
      e.stopPropagation();
    }
  }}
  onPointerMove={(e) => {
    if (document.body.getAttribute('data-drag-domain') === 'dock-tool') {
      e.preventDefault();
      e.stopPropagation();
    }
  }}
>
```

**红队白盒核查与 W3C 规范硬碰撞**：
- 查阅方案 04 §7.2（`04-拖拽体系与域隔离防线.md:574-576`）右坞拖拽启动逻辑：
  ```typescript
  try {
    e.currentTarget.setPointerCapture(pointerId);
  } catch { /* 容错 */ }
  ```
- **W3C Pointer Events Level 2/3 标准铁律**：
  当一个 DOM 元素调用了 `setPointerCapture(pointerId)` 成功捕获指针后，在指针释放或显式释放捕获之前，**操作系统与浏览器会将后续所有的指针事件（包含 `pointermove`、`pointerenter`、`pointerover`、`pointerleave`、`pointerout`）全部、强制、唯一地派发给调用捕获的源元素自身！**
- 底下的任何其他 DOM 节点（包括顶栏的 `tabsContainer`）**在物理层面上根本不会收到任何 Pointer 事件**！
- **红队击穿结论**：
  方案 04 §7.3 设计的 `onPointerEnter` 和 `onPointerMove` 门锁，在正常启用了 `setPointerCapture` 的拖拽过程中，**调用次数恒等于 0**！它是一段永远不会被执行的、自我安慰式的“幽灵代码”！

### 2.2 即便没有 Capture，`stopPropagation()` 也无法阻断 Window 全局监听与 `elementFromPoint`

假设在某些异常情况下 `setPointerCapture` 失败，事件以传统冒泡机制派发：
1. **全局 Window 监听不受冒泡拦截影响**：
   查阅 `SessionTabDragContext.tsx:366` 与方案 04 §7.2（`04-拖拽体系与域隔离防线.md:646`），两套拖拽系统都是直接在全局注册监听：
   `window.addEventListener('pointermove', onPointerMove)`。
   即使 `tabsContainer` 的 React `onPointerMove` 触发了 `e.stopPropagation()`，它也**只能阻止事件向 React 容器祖先冒泡，根本拦截不了直接挂在 `window` / `document` 上的顶级捕获与全局原生监听器**！
2. **`elementFromPoint` 物理穿透**：
   在 `SessionTabDragContext.tsx:252` 中，命中测试是通过调用：
   `const hit = document.elementFromPoint(p.x, p.y);`
   `elementFromPoint` 是由渲染引擎基于绝对几何坐标直接探测视口 DOM 树的，它**完全无视任何 DOM 节点上的事件监听器、`preventDefault()` 或 `stopPropagation()`**！
   只要指针物理移动到顶栏上方，`elementFromPoint` 依然会稳定精准地抓到 `styles.tabsContainer`（即 `class="_tabsContainer_1wzf4_71"`），导致落点判定直接穿透所谓门锁！

### 2.3 状态共享倒退：使用 DOM 属性（`data-drag-domain`）极易引发死锁与状态串味

方案 04 规划将 `DockToolDragProvider` 挂载在 `leafDockDrawer` 外层；但 `PaneHeader.tsx` 位于 `TreeLeafPanel.tsx:438` 顶部，与 `leafDockDrawer` 处于兄弟层级，**根本不在 `DockToolDragContext` 的 Provider 作用域内**。

为了跨 Context 传递状态，方案 04（`04-拖拽体系与域隔离防线.md:587`）采取了最原始的做法：
在 `document.body` 上直接 `setAttribute('data-drag-domain', 'dock-tool')`，再由顶栏去读取。
**架构风险剖析**：
- 违背 React 单向数据流范式，引入非受控的全局 DOM 共享状态；
- **异常死锁风险**：拖拽期间若遇到外部弹窗、Alt+Tab 切换、Webview 失去焦点、或者由于 JS 报错导致 `cleanup()` 未被执行，`document.body` 上的 `data-drag-domain="dock-tool"` 将被**永久残留**。这将导致顶栏所有会话 Tab 的正常交互和点击被全局死锁，应用陷入完全瘫痪。

### 2.4 修复与加固裁决
1. 立即删除 `PaneHeader.tsx` 中无意义的 `onPointerEnter` / `onPointerMove` 伪门锁代码；
2. 门锁逻辑必须收敛到**落点探测器（Hit Detection Engine）内部**，实行单一真理来源（SSOT）：
   - 在 `detectDockDropZone` 算法中，第一行前置守卫：直接以所属右坞的 `dockDrawerEl.getBoundingClientRect()` 作为物理硬围栏。超出该矩形直接 `return null`，绝不调用全局 `elementFromPoint` 去扫描顶栏；
   - 在 `SessionTabDragContext` 的 `applyStrip` 与 `flush` 中增加主动防御，一旦检测到指针位于右坞边界内立即短路。

---

## 维度 3：防线 3（事务断言）的提交路径覆盖

### 审计结论：**[冲突：必须解决]**

### 3.1 提交网关分叉严重，断言仅仅卡在最外层包装函数

方案 00 §3.4 宣称：
> “防线 3（Store 事务提交硬断言）：`sessionTabDropCommit.ts` 增加前置断言，若源并非真正的顶层 `SessionTab`，抛弃事务并触发 Spring Snapback 弹簧动效无损回弹至原窗格。”

**实地代码核查现状证据**：
- 查阅 `apps/crish-desktop/src/components/shell/sessionTabDropCommit.ts:23-51`：
  现有 `commitSessionTabDrop` 入参仅为 `{ sourceLeafId: string; tabId: string; target: SessionTabDropTarget }`，无任何领域鉴权断言。
- 进一步审查整个仓库中的树操作提交路径，发现存在**多条并行的提交分叉链路**：
  1. **链路 A**：`SessionTabDragContext.tsx:349` $\rightarrow$ `commitSessionTabDrop` $\rightarrow$ `tree.moveTab` / `tree.splitTab`；
  2. **链路 B**：`apps/crish-desktop/src/store/layout-tree/layoutTreeStore.ts:387-404` 中暴露的全局 `commitDrop()`：
     ```typescript
     commitDrop: () =>
       set((state) => {
         const { draggedSource, activeDropZone, tree } = state;
         if (!draggedSource || !activeDropZone) return ...;
         const resultTree = applyDrop(tree, draggedSource, activeDropZone);
         // ...
       })
     ```
     `applyDrop`（`layoutTreeTransform.ts:292-317`）直接调用 `moveTab` / `splitTab`；
  3. **链路 C**：`useLayoutTreeStore.getState().moveTab(...)` 与 `splitTab(...)` 是直接挂在 Zustand store 上的公开方法，任何组件、快捷键处理函数或遗留模块均可不经任何断言直接调用；
  4. **链路 D**：遗留的双轨 fallback 模块 `apps/crish-desktop/src/hooks/tab-drag/useTabDragEvents.ts:31` $\rightarrow$ `useTabDragReorder().commitTabDrop`。

**红队击穿结论**：
如果断言仅仅加在 `sessionTabDropCommit.ts` 这一处外围工具函数中，任何通过链路 B、C、D 触发的代码都可以**完全绕过防线 3**！这就如同在一个房子的后门安装了最高等级的安全门禁，但正门与侧窗全部完全敞开。

### 3.2 底层 Store 核心算子对 `tabId` 缺乏领域感知（Domain-Agnostic）

查阅底层核心算子 `layoutTreeMoveRemove.ts:200-268`（`moveTab`）与 `layoutTreeInsert.ts:253-310`（`splitTab`）：
```typescript
export function moveTab(tree: LayoutTree, srcLeafId: string, tabId: string, dstLeafId: string, insertIdx: number): LayoutTree {
  // ...
  const src = requireChatLeaf(tree.root, srcLeafId);
  const fromIdx = src.tabs.findIndex((t) => t.tabId === tabId);
  if (fromIdx < 0) return tree;
  // ...
}
```
底层树算子仅仅检查 `tabId` 是否存在于 `src.tabs` 数组中。
由于 `LayoutLeaf.tabs` 被定义为 `SessionTab[]`，如果未来右坞的数据结构通过兼容层向老模型同步（例如方案 00 §3.1 中提到的 `ensureDockLayoutTree` 与 `syncDockStateWithTree` 反向投影），一旦同步逻辑将右坞工具 ID 写入了 `tabs`，底层的 `moveTab` 将毫不犹豫地将右坞工具作为会话标签在顶栏移动或切分！

### 3.3 严重误伤风险：防线 3 极易误杀合法的 Standalone Terminal

- 方案 00 §3.3 明确制定了用户意志：**顶栏大窗口必须支持不绑定项目的全局独立常规终端（Standalone Terminal）**：
  ```typescript
  export interface StandaloneTerminalTab extends BaseTab {
    kind: 'terminal';
    isStandalone: true;
    terminalKey: string;
    cwd: string;
  }
  ```
- 如果防线 3 的断言简单粗暴地判定“凡是 `kind === 'terminal'` 的一律判定为右坞工具并拒绝提交”，就会直接导致顶栏正常的全局终端被当成入侵者误杀，造成顶栏全局终端无法在顶栏内部拖拽重排或拆分！
- 方案 00 与方案 04 对断言的具体规则完全没有给出区分 `StandaloneTerminalTab` 与 `DockToolTab` 的精确断言谓词。

### 3.4 修复与加固裁决
1. **断言必须下沉到唯一真理出口（SSOT）**：
   在 `layoutTreeMoveRemove.ts` 的 `moveTab` 与 `layoutTreeInsert.ts` 的 `splitTab` 入口处，统一增加核心领域契约断言：
   ```typescript
   export function assertIsSessionLevelTab(tab: unknown): asserts tab is LeafSessionTab {
     if (!tab || typeof tab !== 'object') throw new Error('ERR_INVALID_TAB');
     const t = tab as LeafSessionTab;
     // 顶层合法标签：真会话标签 或 显式标记为 Standalone 的全局终端/全局浏览器
     const isAllowed = isChatTab(t) || (t.kind === 'terminal' && t.isStandalone === true);
     if (!isAllowed) {
       throw new Error(`[SECURITY_VIOLATION] 非顶层会话标签严禁进入大窗口布局树: ${JSON.stringify(t)}`);
     }
   }
   ```
2. 无论调用方走哪条链路（A、B、C 或 D），只要试图将右坞工具塞入顶层二叉树，均在状态机落盘的最后一微秒被底层刚性拦截并记录错误，实现绝对不依赖前端调用方自觉的内核级防护。

---

## 维度 4：触摸设备与键盘拖拽的防线覆盖

### 审计结论：**[警告：可接受但需澄清]**

### 4.1 移动触控设备下由于缺少 `touch-action: none` 导致的 `pointercancel` 崩溃

方案 04 全篇所有的防线与状态机时序设计均建立在桌面环境的**鼠标心智**之上（`pointerdown`, `pointermove`, `pointerup`）。

**红队白盒核查现场证据**：
- 在 Windows 触摸屏笔记本（如 Surface 系列）或触控板上，用户的输入类型为 `e.pointerType === 'touch'`。
- 依据浏览器事件标准：当用户的手指按在屏幕上并发生位移时，浏览器的默认行为是启动视口或容器的**平移滚动（Panning/Scrolling）**。
- 方案 04 §7.2（`04-拖拽体系与域隔离防线.md:535-650`）在右坞 Tab 元素、TabStrip 容器或整个抽屉容器上，**完全没有声明 CSS `touch-action: none`**！
- **故障演进路径**：
  1. 用户在触屏上按住右坞工具 Tab 试图拖拽；
  2. 手指移动超过几个像素；
  3. 浏览器手势识别引擎判定为页面滚动，**立即向源元素派发 `pointercancel` 事件**；
  4. 查阅方案 04 §7.2 第 623 行：`window.addEventListener('pointercancel', cleanup)`；
  5. 拖拽控制器立刻执行 `cleanup()` 强制清空状态并卸载 Ghost 元素；
  6. **结果**：触屏设备上的右坞分屏拖拽**完全不可用**，用户一碰即碎，根本无法完成拖动。

### 4.2 键盘分屏与无障碍重排完全处于方案 Pointer 防线的盲区

1. **现有键盘体系**：
   `apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx:454` 接入了 `useTablistKeyboard`（`apps/crish-desktop/src/hooks/useTablistKeyboard.ts:22`），目前仅用于焦点左右巡回与激活。
2. **方案规划的键盘动作集群**：
   方案 00 §3.6 规划了全键盘交互动作集群：
   - 向右分屏：`Ctrl+Shift+\`
   - 向下分屏：`Ctrl+Shift+-`
   - 切换最大化：`Alt+M`
   - 关闭窗格：`Alt+W`
3. **红队盲区指认**：
   方案 04 所构建的“防线 2（顶栏 DOM 门锁）”与“防线 1（Pointer 上的事件标识）”，**100% 依赖 Pointer/Mouse 事件流**。
   如果未来引入键盘拖拽重排（如无障碍 Accessible Tab Reorder 快捷键 `Ctrl+Shift+PageUp/PageDown`），或者用户通过键盘快捷键发起跨窗格移动，所有基于 Pointer 的防线将**瞬间形同虚设，全部被物理绕过**！
   此时系统的唯一依靠是防线 3（事务断言）。如果防线 3 如前面维度 3 所揭示的存在提交网关漏洞，整个系统的跨域防护将在键盘操作面前彻底崩塌。

### 4.3 修复与加固裁决
1. 明确在右坞 Tab 元素与微型 Tab 栏的 CSS 中强制注入 `touch-action: none` 与 `user-select: none`，并在触屏输入时设置适当的防抖死区（Touch Slop >= 8px）；
2. 架构设计中必须明确确立：**键盘与非指针交互是一等公民**，严禁过度迷信 DOM Pointer 层的防御，所有业务规则的终极防御必须坚决收敛至底层的纯逻辑事务断言。

---

## 维度 5：Spring Snapback 回弹在当前架构中是否可实现

### 审计结论：**[冲突：必须解决]**

### 5.1 方案伪代码存在致命逻辑断裂：`cleanup()` 同步销毁使 Snapback 根本无法执行

方案 04 §4.2 与 §6.3 浓墨重彩地描绘了高品质的弹性回弹手感：
> “若用户强行在顶栏 `class="_tabsContainer_1wzf4_71"` 上松开鼠标（`pointerup`）：目标判定位空，触发 CSS 弹簧动画（Ghost Pill 沿原轨迹平滑飞回原 Tab 初始位置，耗时 180ms），随后从 DOM 卸载，一切恢复如初。”

**红队白盒代码逻辑死锁穿透**：
让我们直接审查方案 04 §7.2（`04-拖拽体系与域隔离防线.md:619-640`）白纸黑字写出的伪代码：
```typescript
const cleanup = () => {
  if (rafId) cancelAnimationFrame(rafId);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', cleanup);
  window.removeEventListener('blur', cleanup);
  document.body.classList.remove('is-dock-dragging');
  document.body.removeAttribute('data-drag-domain');
  removeDockElements(ghostEl, indicatorEl); // ⚠️ 注意这一行：ghostEl 在这里被直接从 DOM 中 remove() 移除了！
  setIsDragging(false);
  activeDragRef.current = null;
};

const onPointerUp = (me: PointerEvent) => {
  if (me.pointerId !== pointerId) return;
  const current = activeDragRef.current;
  cleanup(); // ⚠️ 致命断裂点：第一行同步调用 cleanup()！

  if (!dragging || !current?.dropTarget) {
    // ⚠️ 伪代码注释写着：无效落点 / 落在顶栏：触发 Spring 回弹，不执行任何 commit
    return;
  }
  // ...
};
```

**红队逻辑断裂实锤**：
1. 当用户在顶栏松手时，`current.dropTarget` 为 `null`；
2. 代码进入 `onPointerUp`，**第一句就是无条件同步调用 `cleanup()`**；
3. `cleanup()` 内部的 `removeDockElements(ghostEl, indicatorEl)` 立即执行 `ghostEl.remove()`，将随身浮层瞬间物理销毁；
4. 随后代码才走到 `if (!current?.dropTarget) return;`；
5. **荒谬结论**：在执行回弹动效之前，宿主 DOM 节点已经被亲手掐死！方案 §6.3 所写的 `card.style.transition = 'transform 180ms...'` 到底对谁执行？对一个早已经不存在于 DOM 树中的孤儿节点执行动画？
方案作者在此处写下了自相矛盾的逻辑断层，所谓的 180ms Spring Snapback 在该伪代码下**根本一次都无法播放**，用户看到的仍然是瞬间突兀消失！

### 5.2 原始几何位置采集断层（Where to Snap Back?）

要实现 Spring Snapback，必须精准知晓源 Tab 在视口中的原始几何包围盒：
1. **坐标采集遗漏**：
   查看方案 04 §7.2 第 567-568 行，`startDockDrag` 仅记录了：
   `const startX = e.clientX; const startY = e.clientY;`
   这是指针被抓取瞬间的鼠标坐标，根本不是源 Tab 元素的左上角 `(left, top)`！
   如果抓取点在 Tab 的右侧边缘，回弹时如果使用 `startX, startY`，Ghost 会飞到一个偏移的错误空地上！
2. **动态几何位移漂移**：
   现有系统（`apps/crish-desktop/src/components/shell/SessionTabDragContext.tsx:306` 与 `sessionTabDragDom.ts:165-211`）完全没有常驻的 Ghost Portal，全部是原生 DOM `document.body.appendChild` 直写。
   如果在拖拽过程中，右坞由于其他分屏调整发生了宽度微变或滚动，源 Tab 的当前实际位置已经发生改变。方案完全没有设计在松手瞬间重新测量源 Tab 当前几何位置的机制。

### 5.3 动画过渡期的交互死锁与并发重入灾难

在 180ms 的回弹动效执行期间，系统状态面临严重的三难困境：
- **困境 A（状态过早释放）**：若在回弹一开始就把 `isDragging` 置为 false，源 Tab 立即解除隐藏恢复显示（`opacity: 1`）。此时回弹中的半透明 Ghost 会与原 Tab 产生重叠与视觉闪烁；
- **困境 B（状态迟滞锁死）**：若在回弹期间保持 `isDragging: true`，由于整个右坞被防劫持遮罩（`DockDragShield`）覆盖，用户在这 180ms 内无法进行任何点击，产生明显的卡顿与迟滞感；
- **困境 C（并发重入与孤儿节点残留）**：如果在 180ms 动画飞行期间，用户快速按下了 Esc 键、或者窗口发生了卸载、或者用户快速再次发起拖拽，由于缺少对飞行中动画的取消句柄（Cancellation Token），极易导致多个 Ghost 节点堆积在 `document.body` 成为永久内存泄漏。

### 5.4 修复与加固裁决
1. 彻底重构拖拽生命周期状态机，显式引入 `SnapbackAnimating` 终态：
   - 状态迁移流：`Idle` $\rightarrow$ `Dragging` $\rightarrow$ `SnapbackAnimating` $\rightarrow$ `Idle`；
2. 剥离 `cleanup` 的职责：
   - **立即清理阶段（Immediate Cleanup）**：解绑全局 `pointermove` / `pointerup` 监听、释放 `PointerCapture`、移除 `data-drag-domain`；
   - **延迟归巢阶段（Deferred Snapback）**：Ghost 读取源 Tab 最新的 `getBoundingClientRect()`，应用 `cubic-bezier(0.175, 0.885, 0.32, 1.15)` 飞向目标；
3. 必须通过 `transitionend` 事件回调配合 **250ms 保险丝定时器（Fuse Timer）** 兜底移除 DOM 节点，杜绝任何节点遗留与内存泄漏。

---

## 六、红队综合整改与防御加固总方略

针对上述五大维度的攻破场景，为确保用户**“对话内窗口绝对不能拖拽到顶栏 `class="_tabsContainer_1wzf4_71"`”**的核心红线在工程实施中 100% 兑现，必须对现有方案做如下刚性加固：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               顶层会话大窗口空间 (Session Tree)                         │
│                                                                                        │
│   顶栏 _tabsContainer_1wzf4_71                                                         │
│   ▲                                                                                    │
│   │ 【加固 1：落点探测硬短路】detectDockDropZone 绝对不调全局 elementFromPoint 扫描顶栏   │
│   │                                                                                    │
│   ┼────────────────────── 物理真空隔离带 (Out-of-Bounds Deadzone) ────────────────────┼
│   │                                                                                    │
│   ▼ 【加固 2：底层内核事务硬断言】moveTab / splitTab 入口强制 assertIsSessionLevelTab    │
├──────────────────────────────────────────┬─────────────────────────────────────────────┤
│                                          │                                             │
│       主对话流交互区                      │        右侧功能区分屏系统 (Right Tool Dock) │
│       (Chat Leaf Column)                 │        (leafDockDrawer)                     │
│                                          │                                             │
│                                          │   【加固 3：TypeScript 强判别联合类型】      │
│                                          │   DockToolDragPayload 不可伪造              │
│                                          │                                             │
│                                          │   【加固 4：双阶段受控 Snapback 状态机】     │
│                                          │   解绑监听即时执行，DOM 销毁经保险丝延迟    │
│                                          │                                             │
│                                          │   【加固 5：移动触控 touch-action 封禁】    │
│                                          │   阻断浏览器原生滚动劫持                    │
└──────────────────────────────────────────┴─────────────────────────────────────────────┘
```

### 核心整改清单（Action Items）

1. **废黜死代码，净化顶栏**：
   全面移除方案 04 §7.3 中试图在 `PaneHeader.tsx` 的 `tabsContainer` 上挂载 `onPointerEnter` / `onPointerMove` 伪门锁的设计，不在顶栏增加任何无效事件监听。
2. **收敛落点算法边界（Local Bounding Box Restriction）**：
   `detectDockDropZone` 的命中算法只能在传入的 `dockDrawerEl` 几何矩形内运行。一旦指针超出右坞边界，立即返回 `null`，绝不向全局 `document` 扩散，从源头杜绝顶栏被识别为有效落点。
3. **断言下沉至 Store 内核**：
   在 `layoutTreeMoveRemove.ts` 与 `layoutTreeInsert.ts` 中植入对 `isSessionLevelTab` 的刚性前置断言，阻断任何通过非标准链路对大窗口树的非法写入；同时确保 `isStandalone === true` 的顶栏常规终端不受误杀。
4. **重构 Snapback 动效控制器**：
   修复 `onPointerUp` 中过早调用 `cleanup()` 导致 DOM 节点被提前拔除的致命 Bug，引入双阶段延迟清理与 250ms 保险丝机制，确保弹性回弹的确定性与优雅呈现。
5. **移动触控与全键盘防御闭环**：
   在右坞 Tab 元素上注入 `touch-action: none`；将全键盘分屏与重排操作统一收拢至防线 3 事务断言守卫下，确保非鼠标交互模式下的绝对安全。
