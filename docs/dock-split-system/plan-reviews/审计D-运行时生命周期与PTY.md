# 架构审计报告 D：多分屏运行时生命周期、PTY 并发管理与资源自愈深度审查

> **审计标的**：
> - `docs/dock-split-system/00-总方案.md` §3.5（复合实例定址与运行时生命周期自愈）
> - `docs/dock-split-system/analysis/05-多窗格运行时与资源生命周期.md`（完整分析方案）
>
> **审计角色**：运行时正确性与资源生命周期审计师  
> **审计依据**：仓库源码白盒实地核查、通用协作纪律 `AGENTS.md`、反退避全文 `.agents/LOGIC_PLAN_NO_RETREAT.md`、反过度设计红线 `ANTI_OVERENGINEERING_GUARDRAILS.md`。  
> **审计结论总览**：审查发现 **3 处严重架构冲突与致命代码缺陷（必须阻断解决）** 与 **2 处概念漂移与调和代价警告（需补充澄清与优化）**。特别指出：**分析方案 05 通篇建立在浏览器为 `<iframe>` 的错误假设之上，而代码实地已全面升级为 Tauri 2 原生子 Webview（`NativeBrowserSurface`）**；同时现行 `killDockTerminalPty` 与 `PreviewCard.tsx` 存在硬编码单例 Key 缺陷，在分屏场景下将导致 **100% 误杀兄弟终端 PTY** 以及 **双浏览器抢夺同一个原生视口** 的灾难性运行时故障。严禁在修复这些缺陷前直接进入编码实施。

---

## 维度 1：复合 Key 方案与现有 SlotOutlet 的集成

### 审计结论：【警告：可接受但需澄清】

### 1.1 现状源码实地审查：SlotOutlet 与 ViewRegistry 的 Key 机制

方案 05 §2.2 提出使用五维复合坐标铸造 React Key：
$$\mathbf{CompositeKey} = \texttt{\$\{sessionId\}:dock:\$\{dockLeafId\}:\$\{panelId\}:\$\{instanceId\}}$$
并声称：“React 调和层以此复合 Key 注入 SlotOutlet，彻底根除双终端/双浏览器时的 Key 碰撞。”

经深入核查现有插槽与视图注册代码，真实机制如下：

1. **`ViewRegistry.ts` 注册层**（`apps/crish-desktop/src/services/view-registry/ViewRegistry.ts:117-121`）：
   ```typescript
   // 自动向 slotCore 注册 'workspace.leaf.panel' keyed 插槽
   const unregisterSlot = slotCore.registerKeyed('workspace.leaf.panel', {
     id: view.id,
     key: view.id,
     component: view.component,
   });
   ```
   插槽核心登记的条目 `id` 和 `key` 均为视图静态标识符（例如 `'terminal'`、`'preview'`、`'diff'`）。

2. **`SlotOutlet.tsx` 调和层**（`apps/crish-desktop/src/services/view-registry/SlotOutlet.tsx:105-121`）：
   ```tsx
   if (entryKey) {
     const entry = slotCore.getKeyed(slotKey, entryKey);
     if (entry) {
       const Comp = entry.component;
       return (
         <SlotErrorBoundary
           key={entry.id}                     // ⚠️ 行号 111：硬编码使用 entry.id
           slotKey={slotKey}
           entryId={entry.id}
           mode="keyed"
           resetKeys={[slotKey, entryKey, context]}
           fallback={fallback}
         >
           <Comp {...context} />
         </SlotErrorBoundary>
       );
     }
     return null;
   }
   ```
   在 Keyed 模式下，第 111 行固定使用 `key={entry.id}`（即 `'terminal'`）。

3. **`TreeLeafPanel.tsx` 现有右坞渲染层**（`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:463-482`）：
   ```tsx
   {dock.openPanelIds.map((pid) => {
     const isPanelActive = pid === toolPanelId;
     return (
       <div
         key={pid}                            // ⚠️ 外层 div 使用 pid 作为 Key
         className={styles.dockPanelPane}
         style={{ display: isPanelActive ? 'flex' : 'none' }}
       >
         {renderToolOutlet(pid)}
       </div>
     );
   })}
   ```
   而在 `renderToolOutlet(pid)`（第 337-345 行）中，`<SlotOutlet slotKey="workspace.leaf.panel" context={ctx} entryKey={resolved.definition.id} />` 并没有向 `<SlotOutlet>` 显式传递外层 `key`。

### 1.2 方案断层与调和代价评估（Migration Cost & Re-mount Hazard）

1. **SlotOutlet 的全仓共享性决定了严禁修改其内部默认 Key**：
   - 搜索全仓发现，`SlotOutlet` 不仅服务于 `workspace.leaf.panel`，还被 `workspace.chat.stream`（`ChatCard.tsx`）、`composer-above`（`ChatComposerWrapper.tsx`）、`conversation-flow`（`extensions/conversation-flow/host.tsx`）等广泛使用。
   - 若直接在 `SlotOutlet.tsx:111` 内部篡改默认 `key` 逻辑，强行绑定复合 Key 解析，会破坏通用插槽协议。
   - **正确接入方式**：复合 Key 必须作为外层包装组件的 React Key（例如 `<SlotOutlet key={compositeKey} ... />`），由分屏容器在调用时传入。

2. **将物理位置 `dockLeafId` 编入 React Key 会引发严重的全量重挂载灾难**：
   - React Reconciliation 原则规定：**组件的 `key` 一旦变化，React 将立即 Unmount 旧组件实例并从零 Mount 新实例**。
   - 方案 05 将 `dockLeafId`（窗格槽位 ID）硬编码进复合 Key。当用户在右坞中进行以下分屏操作时：
     - 用户将终端 Tab 从分屏 A 拖入分屏 B；
     - 用户调整分屏拓扑（例如关闭左侧分屏，触发右侧分屏向上合并或重命名）；
     - `dockLeafId` 必然发生变化，导致该工具的 React Key 改变，瞬间触发 **强制 Unmount $\to$ Remount**！
   - **重型工具受损表现**：
     - **终端（`TerminalCard`）**：Unmount 触发 `useXtermTerminal.ts:401` 的 `term.dispose()`，销毁 WebGL 渲染管线、注销 DOM 选区。尽管 Rust 进程存活，Remount 时仍需重建 `Terminal` 实例，重新向后端发起 `getPtyOutputHistory` 并全量重刷上屏，造成终端画面严重闪烁，选区丢失，正在进行的全屏交互（如 `vim`、`htop`、日志监控）会因终端尺寸重置和历史重放而出现画面撕裂与选区丢弃。
     - **原生浏览器（`PreviewCard`）**：Unmount 触发原生 Webview 隐藏与视口解绑，用户填写了一半的表单、单页应用的内存路由、调试工具面板状态均会丢失。
   - **方案盲区**：方案 05 简单断言复合 Key 是“根治调和碰撞的灵丹妙药”，完全未评估将物理位置（`dockLeafId`）作为 React Key 带来的迁移副作用。

### 1.3 改进建议

复合 Key 的物理寻址用途（进程绑定、事件过滤）与 React 调和层 Key 必须解耦：
- **React Reconciliation Key** 应当保持与**逻辑实例身份（TabId / InstanceId）**绑定（例如 `tabId` 或 `instanceId` 保持全局唯一），保证分屏移动（In-Place Move）时 React 节点复用，不触发 Unmount；
- **Composite Key** 作为属性透传（`ViewRenderContext.instanceKey`），专门用于 PTY 绑定、原生 Webview 命名与精确事件路由。

---

## 维度 2：`killDockTerminalPty` 的精准度

### 审计结论：【冲突：必须解决】

### 2.1 源码实地核查：`killDockTerminalPty` 实现分析

在 `apps/crish-desktop/src/components/binary-tree/treeLeafPanelModel.ts:171-185` 中，查找并关闭 PTY 的实现为：

```typescript
export function killDockTerminalPty(
  panelId: string,
  sessionForPanel: string
): void {
  if (panelId === 'terminal' || panelId.startsWith('terminal:')) {
    void import('../../api/ptyRegistry').then((m) => {
      const panelKey =
        panelId === 'terminal'
          ? sessionForPanel
          : `${sessionForPanel}:${panelId}`;
      void m.killPtyForSession(panelKey);
      void m.killPtyForSession(`${panelKey}:split-2`);
    });
  }
}
```

其调用链位于 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:230-238`：

```typescript
const handleCloseToolTab = useCallback(
  (panelId: string) => {
    killDockTerminalPty(panelId, sessionForPanel);
    const next = computeNextDockAfterClose(
      dock.openPanelIds,
      dock.activePanelId,
      panelId
    );
    updateLeafDock(leaf.id, next);
  },
  [dock.activePanelId, dock.openPanelIds, leaf.id, sessionForPanel]
);
```

而在 `TerminalCard.tsx:43-48` 中，终端创建时计算 sessionKey 的逻辑为：

```typescript
const boundSessionId = (scopedSessionId || '').trim() || null;
const baseKey = boundSessionId || '_global';
const sessionKey =
  panelIdProp && panelIdProp !== 'terminal'
    ? `${baseKey}:${panelIdProp}`
    : baseKey;
```

### 2.2 分屏场景下的致命缺陷：100% 误杀兄弟分屏终端

假设在右坞分屏场景下，用户在同一个会话中开启了 2 个终端分屏（左窗格 `dockLeaf_1` 打开 `terminal`，右窗格 `dockLeaf_2` 也打开 `terminal`）：

1. **创建阶段即已串味（Process Contention）**：
   - 两个分屏的 `panelIdProp` 均为 `'terminal'`，`scopedSessionId` 均为当前会话 ID（如 `sess-1`）。
   - 两者计算得到的 `sessionKey` 均为 `sess-1`。
   - `useXtermTerminal` 调用 `ensurePtyForSession('sess-1')` 时，由于键名完全相同，**两个分屏直接连接到了同一个 ConPTY 进程**！用户在左边分屏敲命令，右边分屏同时乱码回显，两个分屏互相触发 `resize` 抖动。

2. **关闭阶段致命连带误杀（Collateral Kill）**：
   - 用户决定关闭左侧分屏 `dockLeaf_1` 中的终端标签，触发 `handleCloseToolTab('terminal')`。
   - `handleCloseToolTab` 带着 `('terminal', 'sess-1')` 调用 `killDockTerminalPty`。
   - `killDockTerminalPty` 判定 `panelId === 'terminal'`，得出 `panelKey = 'sess-1'`。
   - 执行 `m.killPtyForSession('sess-1')`！
   - `api/ptyRegistry.ts:243` 从全局注册表中把 `'sess-1'` 强行 `take` 移除，并调用 Rust 后端 `workbench_pty_kill` 杀掉该 ConPTY 进程！
   - **后果**：右侧窗格 `dockLeaf_2` 的底层 ConPTY 进程被直接斩首，终端瞬间崩溃报错 `Process terminated`！

### 2.3 裁决要求

`killDockTerminalPty` 函数的签名与实现必须立即废弃！
- 必须重写为 `killDockInstancePty(instanceKey: string)` 或传入 `(sessionId, dockLeafId, panelId, instanceId)`；
- 只有严格携带唯一复合 Key 的解绑与 Kill 才能入库，根绝跨分屏误杀。

---

## 维度 3：`LeafScopeContext` 的扩展可行性

### 审计结论：【警告：可接受但需澄清】

### 3.1 源码实地核查：`LeafScopeContext.tsx` 现有接口与拓扑

查看 `apps/crish-desktop/src/contexts/LeafScopeContext.tsx:15-32`：

```typescript
export interface LeafScopeValue {
  readonly inLeafScope: boolean;
  readonly leafId: string | null;
  readonly sessionId: string | null;
  readonly isActive: boolean;
  readonly leafRootRef: React.RefObject<HTMLElement | null>;
  /** 在当前分屏的右侧工具抽屉中打开指定面板 */
  readonly openTool: ((panelId: string) => void) | null; // ⚠️ 行号 27：存在 openTool 回调
  readonly queryWithinLeaf: <T extends Element = HTMLElement>(selector: string) => T | null;
}
```

在 `TreeLeafPanel.tsx:370-376` 中挂载了顶层提供者：

```tsx
<LeafScopeProvider
  leafId={leaf.id}
  sessionId={effectiveSessionId}
  isActive={isActive}
  leafRootRef={leafElRef}
  openTool={handleOpenTool} // 即 openToolInLeaf(leaf.id, panelId)
>
```

### 3.2 级联嵌套分析与命名冲突风险

方案 05 §3.2 设计在 `LeafScopeContext` 内部级联 `DockLeafScopeProvider`：

```typescript
export const DockLeafScopeProvider: React.FC<DockLeafScopeProviderProps> = ({
  dockLeafId,
  isDockActive,
  dockRootRef,
  children,
}) => {
  const parentScope = useLeafScope();
  ...
  const scopeValue = useMemo<LeafScopeValue>(
    () => ({
      ...parentScope,
      inDockScope: true,
      dockLeafId,
      isDockActive,
      dockRootRef,
      queryWithinDockLeaf,
    }),
    [parentScope, dockLeafId, isDockActive, dockRootRef, queryWithinDockLeaf]
  );
  return <LeafScopeContext.Provider value={scopeValue}>{children}</LeafScopeContext.Provider>;
};
```

此设计潜伏着 **API 语义迷失与命名冲突**：

1. **`openTool` 语义迷失（Context Blindness）**：
   - 现有的 `openTool` 是会话级的（由 `TreeLeafPanel` 提供），签名仅为 `(panelId: string) => void`。
   - 其底层实现 `openToolInLeaf(leaf.id, panelId)`（`openTool.ts:149-174`）只懂得将 `panelId` 追加到会话大窗口的扁平列表 `dock.openPanelIds` 中，**完全不知道调用者处于哪个 `dockLeafId`**。
   - 当嵌套在右坞分屏内部的工具组件（如 `FilesCard` 点击“在终端打开”，或扩展面板调用 `scope.openTool('terminal')`）调用 `openTool` 时：
     - 如果直接透传 `parentScope.openTool`，工具会被打开在外层旧模型中，导致分屏树被破坏；
     - 如果在 `DockLeafScopeProvider` 中覆盖 `openTool`，则会出现覆盖歧义：调用方到底是希望“在当前分屏窗格内增加一个 Tab”，还是“在右坞开辟一个新分屏”？

2. **Hook 认知漂移**：
   - 总方案 00 §3.5 宣称提供 `useDockLeafScope()` 专职 Hook；
   - 而分析方案 05 却选择直接复用 `useLeafScope()` 并向其塞入 `dockLeafId`；
   - 两套文档在 API 形态上发生漂移。如果工具组件继续使用 `useLeafScope()`，开发人员极易误将顶层 `leafId`（会话大窗口）当作子分屏 `dockLeafId` 使用，导致作用域穿透。

### 3.3 规范化澄清建议

1. **明确两级分离 API**：
   - 保留 `useLeafScope()` 仅用于获取会话大窗口级信息（`sessionId`, `sessionLeafId`）；
   - 正式确立 `DockLeafScopeContext` 与 `useDockLeafScope()`，暴露专属窗格操作：
     ```typescript
     export interface DockLeafScopeValue {
       readonly dockLeafId: string;
       readonly isDockActive: boolean;
       readonly dockRootRef: React.RefObject<HTMLElement | null>;
       /** 在当前子分屏内打开/激活工具 Tab */
       readonly openTabInCurrentDockLeaf: (panelId: string) => void;
       /** 在右坞创建新分屏并打开工具 */
       readonly splitAndOpenTool: (panelId: string, direction: 'horizontal' | 'vertical') => void;
       readonly queryWithinDockLeaf: <T extends Element = HTMLElement>(selector: string) => T | null;
     }
     ```
2. 彻底避免在 `LeafScopeValue` 上做同名覆盖，防止隐式遮蔽（Shadowing）。

---

## 维度 4：会话切换的"两级混合生命周期"实现路径

### 审计结论：【冲突：必须解决】

### 4.1 方案主张审查

方案 05 §4.2 提出所谓“两级混合生命周期”：
- **进程层**：Rust ConPTY 后台保活（RingBuffer 保留 10000 行增量）；
- **表现层**：“动态智能休眠（Smart Eviction），最近使用的 2 个会话（MRU = 2）采用 CSS 离屏隐藏保留 DOM，其余冷会话卸载 React DOM 树”。

### 4.2 代码实地核查：现状机制与技术碰撞

经核查当前工作区布局代码（`apps/crish-desktop/src/components/binary-tree/` 与 `store/workspace-shell/openTool.ts`）：

1. **当前会话切换完全没有 DOM 驻留机制**：
   - `BinaryTreeWorkspace.tsx:246-250` 中，大二叉树画布仅渲染各会话叶子的 `TreeLeafPanel`；
   - 在单个 `TreeLeafPanel.tsx` 内，当用户在顶栏切换 Tab（会话 A $\to$ 会话 B）时，`TreeLeafPanel` 实例保持存活，仅重新计算 `activeTab` 与 `dock`：
     - 若会话 A 与会话 B 的右坞具有相同的激活面板（如均为 `terminal`），React 会在就地复用组件实例的同时触发 Props 变化；
     - 若会话 A 与会话 B 打开了不同面板（A 是 `terminal`，B 是 `files`），React 直接正常 Unmount 旧面板并 Mount 新面板。
   - **全仓搜索没有任何类似 `<KeepAlive>` 或 MRU DOM 池的实现**。

2. **"MRU 保留 2 个 DOM" 违背反过度设计红线，且与桌面原生视口直接冲突**：
   - **违反 `ANTI_OVERENGINEERING_GUARDRAILS.md`**：在 React 中自研一套跨会话的 MRU DOM 节点缓存池属于典型的重型过度设计。脱离 React 树挂载的离屏 DOM 节点，其虚拟滚动、IntersectionObserver、焦点捕获与键盘快捷键极难维护，极易产生内存泄漏与幽灵事件。
   - **与原生子 Webview 架构发生严重排斥**：如维度 5 所述，桌面端的浏览器预览组件实质是 **Tauri 2 原生子 Webview（HWND 视口）**。原生窗口无法通过 CSS `display: none` 随意常驻；若保留 2 个后台会话，意味着内存中要长久挂起 4~6 个 WebView2 原生渲染进程，显存开销将暴增 1~2 GB，直接打崩低配置设备。

3. **内核级 PTY 重水化链路已天然完备，DOM 缓存纯属画蛇添足**：
   - 深入查看 `apps/crish-desktop/src/components/workspace/ptyLifecycle.ts:59-62` 与 `api/ptyRegistry.ts:213`：
     ```typescript
     const existing = ptyRegistry.get(sid);
     if (existing) return existing;
     ```
     当前端 `TerminalCard` 重新挂载时，`ensurePtyForSession` 发现已有 PTY 句柄，直接复用 `ptyId`；
   - 随后 `getPtyOutputHistory(ptyId)` 自动向 Rust 端获取离线期间 RingBuffer 积累的输出，并在毫秒内重放上屏。
   - **结论**：底层进程与输出历史本就具备完善的后台保活与切回自愈机制，React DOM 随会话切换自然 Unmount/Mount 表现极度流畅，**根本没有任何建立 MRU DOM 缓存池的必要**！

### 4.3 裁决要求

彻底从总方案和分析方案中**删除“MRU 保留 2 个会话 DOM 缓存池”的设计**，回归轻量、标准的 React 生命周期：
- 会话切换时，非激活会话的右坞 React DOM 树正常卸载；
- ConPTY 进程在 Rust 端与 `ptyRegistry` 中 100% 后台保活；
- 切回会话时，React 树自然重建，TerminalCard 挂载秒级重水化（Re-hydration），保持架构净收敛。

---

## 维度 5：Webview 浏览器多实例的隔离

### 审计结论：【冲突：必须解决】

### 5.1 方案重大失实：方案 05 通篇误判浏览器渲染机制为 `<iframe>`

在 `docs/dock-split-system/analysis/05-多窗格运行时与资源生命周期.md` 中，方案通篇将浏览器预览组件描述为 `<iframe>`：
- 第 12 行：“同时运行 1 个终端 + 1 个特定本地端口的预览浏览器 ... 独立 iframe”；
- 第 542 行：“Preview iframe：移除 iframe 节点，向代理发关闭断开通道；递归销毁所有 iframe”；
- 第 557 行：“内存中将驻留 30 个 iframe”；
- 第 763 行：“iframe 响应并导航至 /dash”；
- 第 3.2 节更设计了所谓的 `disableIframePointerEvents` 来防御鼠标穿透。

### 5.2 源码实地核查：真实实现是 Tauri 2 原生子 Webview（Native Child Webview）

经严密排查前端与 Rust 源码，真实代码机制如下：

1. **前端实际渲染载体**（`apps/crish-desktop/src/components/workspace/PreviewCard.tsx:415-419`）：
   ```tsx
   <NativeBrowserSurface
     tabId={effectiveTabId}
     initialUrl={activeUrl}
     isActive={true}
   />
   ```
2. **`NativeBrowserSurface.tsx` 的架构契约**（`apps/crish-desktop/src/components/workspace/NativeBrowserSurface.tsx:1-12`）：
   > “原生子 Webview 挖洞占位组件 (Native Browser Surface Placeholder)”  
   > “核心规范：1. 绝对纯净的镂空 DOM 占位容器，**零 `<iframe>`**，零重绘负载；”  
   > “2. 联动 LayerStackManager ... 自动触发底层 `set_visible(false)` ... 彻底消除 Airspace 穿透遮挡；”  
   > “3. 接入 `useNativeBrowserGeometry` 双相几何同步引擎；”  
   > “4. 接入 `useHitTestGuard` 鼠标穿透看门狗。”

3. **Rust 内核实现**（`apps/agent-workbench/src-tauri/src/browser/native_manager.rs:215-218`）：
   ```rust
   // 挂载原生 OS 级子 Webview (Windows WebView2 HWND)
   let webview = main_window
       .add_child(builder, pos, size)
       .map_err(|e| format!("Window::add_child failed: {e}"))?;
   ```
   后端使用 Tauri 2 的 `Window::add_child` 将真正的独立原生 Webview2 视口物理钉在主窗口之上。方案 05 的所有分析与防御手段针对的是 `<iframe>`，与真实工程实现**严重脱节**！

### 5.3 多原生 Webview 并发的技术可行性与三大阻断性障碍

Tauri 2 的 `Window::add_child` 在 Rust 层使用 `HashMap<String, ManagedWebview>`（`native_manager.rs:66`）进行管理，理论上支持在一个窗口内创建多个子 Webview。但在多分屏场景下，存在以下 **三大阻断性技术障碍**：

#### 障碍 1：前端 TabId 硬编码导致双浏览器视口互相抢夺（Fatal Collision）

查看 `apps/crish-desktop/src/components/workspace/PreviewCard.tsx:60-63`：
```typescript
const effectiveLeafId = leafId ?? scope.leafId;
const effectiveTabId = effectiveLeafId
  ? `${effectiveLeafId}-browser`
  : 'default-browser';
```
- `effectiveLeafId` 取的是外层会话大窗口的 `leaf.id`。
- 若用户在右坞分屏中并排打开 2 个浏览器窗格（Pane A 与 Pane B），两者由于同属于一个会话，计算出的 `effectiveTabId` **完全相同**（均为 `${leaf.id}-browser`）！
- 当 Pane B 挂载并向 Rust 发送 `browser_webview_create` 时，Rust 内核（`native_manager.rs:127-141`）检测到 `tab_id` 已存在，直接执行幂等复用，将 Pane A 原本的子 Webview 物理尺寸和位置重新设置为 Pane B 的位置！
- **后果**：Pane A 的视口瞬间被 Pane B 抢走，Pane A 变成纯镂空的灰色背景，两边拖拽调整尺寸时在同一个原生视口上打架拉扯！

#### 障碍 2：空域问题（Airspace Defect）与分屏分割线（Sash）拖拽死锁

- 原生 Webview 是操作系统级顶层窗口，**在渲染层级上永久凌驾于所有 HTML DOM 之上（无视 CSS `z-index`）**。
- 方案 05 提出的 `disableIframePointerEvents`（CSS 样式注入）对原生子 Webview 完全无效！
- 当分屏中存在两个原生浏览器，且用户在它们之间拖拽 `DockResizeSash` 时：
  - 一旦鼠标指针略微偏离 1px 进入左侧或右侧的子 Webview 区域，Windows 会立即将鼠标捕获转移给子 HWND；
  - 主窗口的 React 拖拽引擎瞬间丢失 `pointermove` 与 `pointerup` 事件，导致拖拽死锁、严重粘手。
- **解决方案**：在拖拽调整右坞分屏尺寸期间，必须调用 Tauri 命令 `browser_webview_set_hit_test(false)`，对右坞内**所有**打开的原生子 Webview 广播禁用 Hit-Test，释放鼠标后再统一开启。

#### 障碍 3：几何同步 IPC 吞吐成倍增加

- 两个原生子 Webview 左右分屏时，拖动中间 Sash 会导致两个窗格的像素坐标同时发生连续变化。
- 必须严格遵循 `nativeBrowserGeometry.ts:58-88` 中的“外边界独立四舍五入算法”和 `0.5px` 差分脏矩形拦截，否则两个原生视口在拖拽期间会因 IPC 延迟出现明显的边框重叠或白色裂缝。

### 5.4 裁决要求

1. 立即修正方案 05 中所有关于 `iframe` 的错误表述，将分析基线对齐到 `NativeBrowserSurface` + Tauri 2 原生子 Webview 架构；
2. 修复 `PreviewCard.tsx:61`，将传给 `NativeBrowserSurface` 的 `tabId` 升级为结合 `dockLeafId` 的复合唯一标识（如 `${sessionId}:${dockLeafId}:browser`）；
3. 在 `DockResizeSash` 拖拽生命周期中，必须接入全局原生 Webview 的 Hit-Test 禁用看门狗，彻底根绝空域捕获导致的拖拽断裂。

---

## 总结与行动项（Action Items）

| 维度 | 审查结论 | 核心问题 | 阻断级别 | 修复落地责任项 |
| :--- | :--- | :--- | :--- | :--- |
| **维度 1**：复合 Key 与 SlotOutlet | **[警告：需澄清]** | `SlotOutlet.tsx:111` 硬编码使用 `entry.id`；若将包含 `dockLeafId` 的 Key 注入调和层，会导致分屏重排时终端与浏览器强制 Unmount/Remount。 | 中 | 解耦调和 Key（绑定 TabId）与物理寻址 Key（属性透传）。 |
| **维度 2**：`killDockTerminalPty` 精度 | **[冲突：必须解决]** | `treeLeafPanelModel.ts:178` 仅支持单终端 `sessionForPanel`，多分屏场景下关闭一个终端将 100% 误杀同会话兄弟终端。 | **高 (阻断)** | 重写析构签名，强制传入复合实例 Key 进行精准解绑与终止。 |
| **维度 3**：`LeafScopeContext` 扩展 | **[警告：需澄清]** | 现有 `LeafScopeValue` 已有 `openTool`，两级嵌套会产生透传遮蔽；外层无 `dockLeafId` 感知。 | 中 | 确立专职 `DockLeafScopeContext`，提供区分明确的窗格内/跨窗格开 Tab API。 |
| **维度 4**：会话切换混合生命周期 | **[冲突：必须解决]** | 方案主张的 "MRU 保留 2 个 DOM 缓存池" 系过度设计，全仓零先例，且与原生子 Webview 冲突。 | **高 (阻断)** | 删除 MRU DOM 缓存池设计；回归自然 Unmount +秒级重水化轻量路径。 |
| **维度 5**：Webview 多实例隔离 | **[冲突：必须解决]** | 方案 05 误将浏览器当作 `iframe`；代码实地为 Tauri 原生子 Webview，且 `PreviewCard.tsx:61` 的 `effectiveTabId` 存在单例碰撞。 | **高 (阻断)** | 将分析基线修正为原生 Webview；将 `tabId` 升级为分屏专属唯一 Key；为 Sash 增加 Hit-Test 拦截管线。 |
