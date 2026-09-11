# DeepSeek-Harness 声明式 SlotMap、ComposedProps 与微内核扩展深度源码解剖

> **文档定位**：前端架构深度对标解剖系列（Agent 8）
> **源码基准**：`reference/deepseek-harness/packages/client/`（`ui-slots`、`runtime`、`web-react`、`ui-layout`、`ui-conversation`、`ui-settings`）
> **对标目标**：解构 DeepSeek-Harness（下文简称 DSH）基于 SlotMap 的声明式插槽拓扑、ComposedProps 四份额强类型推导、`display: contents` 零布局污染挂载、纯内核几何求解器与 ViewRegistry 装配引擎；点对点映射 Conex 二叉树工作区解耦与微内核插件化收敛方案。

---

## 目录

1. [执行摘要与微内核架构哲学](#1-执行摘要与微内核架构哲学)
2. [Slot 拓扑基础设施：SlotCore 与声明账本（Declaration Ledger）](#2-slot-拓扑基础设施slotcore-与声明账本declaration-ledger)
3. [四大插槽形态全景解剖：Single / List / Keyed / Chain](#3-四大插槽形态全景解剖single--list--keyed--chain)
4. [TypeScript 声明合并与 ComposedProps 四份额强类型推导](#4-typescript-声明合并与-composedprops-四份额强类型推导)
5. [运行时生命周期、状态隔离与响应式数据平面](#5-运行时生命周期状态隔离与响应式数据平面)
6. [渲染引擎与 DOM 架构：display: contents 与零污染挂载](#6-渲染引擎与-dom-架构display-contents-与零污染挂载)
7. [纯几何让步链调度器：AppFrame 与 computeColumns 解密](#7-纯几何让步链调度器appframe-与-computecolumns-解密)
8. [平行注册表的溶解：ToolView、CommandView 与 ViewRegistry](#8-平行注册表的溶解toolviewcommandview-与-viewregistry)
9. [Conex 点对点映射与二叉树工作区插件化落地蓝图](#9-conex-点对点映射与二叉树工作区插件化落地蓝图)
10. [架构不变量（Invariants）与防退避自检清单](#10-架构不变量invariants与防退避自检清单)

---

## 1. 执行摘要与微内核架构哲学

### 1.1 前端 GUI 扩展性的核心困境

在现代高交互复杂桌面/Web 应用（如 AI IDE、工作流工作区）的演进过程中，界面拼装通常会面临以下四项根本性架构冲突：

1. **渲染权威（Rendering Authority）的模糊性**：谁有权向哪一块视口区域渲染内容？在基于配置文件的传统方案中，插槽往往是全局开放的字符串字典，任何模块均可在任意时刻注入，导致渲染顺序不可控、层叠冲突无从审计。
2. **组件与框架上下文的强耦合（Context Leakage）**：业务视图组件为了获取会话 ID、国际化翻译、状态管理器或子插槽渲染能力，不得不直接引入全局 Store、Cordis Context 或 React Context，破坏了组件作为「纯函数（Pure Component）」的可测试性与无状态性。
3. **平行注册表（Parallel Registries）的代码膨胀**：随着业务扩展，系统内常分化出 `ToolViewRegistry`、`PanelRegistry`、`CommandRegistry`、`TabRegistry` 等多套平行的注册机制。每套机制重复实现一套生命周期、订阅更新、错误隔离与缓存，导致架构碎片化。
4. **静态硬编码 `switch-case` 阻碍动态插件化**：如 Conex 现有的 `TreeLeafPanel.tsx`，通过静态 `switch (panelId)` 分发 `ChatCard`、`TerminalCard`、`FilesCard` 等内建面板，新增任何第三方扩展或实验性视图均需直接侵入修改核心壳层代码。

### 1.2 DSH 微内核的核心破局法则

DSH 确立了极度严谨的微内核扩展设计准则，其核心哲学可概括为一句话：

> **壳只渲染 `'root'`；插件通过单独一次 `register` 调用组合 UI——该调用同时占用宿主插槽、声明并授权子插槽、声明 Store 席位、注入业务面；组件保持纯函数，Props 按四份额通过唯一真源由编译期自动推导。**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DSH 微内核插槽与渲染流水线                           │
└─────────────────────────────────────────────────────────────────────────────┘

   Cordis Context / Plugin Apply
        │
        ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │ ctx.slots.register({                                                  │
   │   name: 'root',                       ◄── 占用父插槽 (Target Slot)      │
   │   children: {                         ◄── 声明子插槽 + 独占渲染授权      │
   │     'sidebar': { kind: 'single', scope: 'root' },                     │
   │     'conversation': { kind: 'single', scope: 'session-maybe' },       │
   │   },                                                                  │
   │   store: createLayoutStore,           ◄── 声明 Store 引擎工厂 (Store Seat)│
   │   inject: (actions) => ({ ... }),     ◄── 注入业务门面 (Inject Face)    │
   │ }, AppFrame)                          ◄── 纯组件 (SlotComponent<Props>)  │
   └───────────────────────────────────────────────────────────────────────┘
        │
        ├───────────────────────────────┬────────────────────────────────┐
        ▼                               ▼                                ▼
 ┌──────────────┐              ┌─────────────────┐             ┌───────────────────┐
 │   SlotCore   │              │   SlotRegistry  │             │   web-react Outlet│
 │ (纯拓扑账本) │              │  (Cordis生命周期)│             │ (display:contents)│
 └──────────────┘              └─────────────────┘             └───────────────────┘
```

### 1.3 核心架构对比矩阵

| 架构维度            | 传统插件化方案 (如 VSCode / Eclipse)               | Conex 现状 (二叉树工作区)                       | DSH 声明式 SlotMap 方案                                         |
| ------------------- | -------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| **插槽声明与授权**  | 字符串键字典，全局开放，时序依赖                   | 静态枚举 `PanelId`，硬编码在组件内部            | `children` 表一次性声明，**声明即独占授权**，未声明调用即时抛错 |
| **组件 Props 来源** | `useContext(ExtensionContext)` 运行时自取          | 散落的 Zustand `useLayoutTreeStore` 等全局 Hook | **四份额 ComposedProps** 自动推导，组件为零 Context 纯函数      |
| **数据订阅模型**    | 插件自建 Event Emitter 或 Store 订阅               | 多 Store 相互订阅，依赖 selector 浅比较         | 框架快照引擎统一绑定，`uSES` 单通道微任务批处理更新             |
| **视图分发机制**    | 独立 `ViewContainer` 平行注册表                    | `TreeLeafPanel.tsx` 静态 `switch(panelId)`      | 全局单注册模型，面板即 `keyed` / `chain` 插槽                   |
| **DOM 布局侵入**    | 额外嵌套多层 `div.slot-wrapper` 破坏 CSS Grid/Flex | 绝对定位百分比计算 (`el.style.top/left`)        | `<div data-slot style={{ display: 'contents' }}>` 零布局污染    |
| **类型安全等级**    | 动态 `any` 或弱类型字典查表                        | `interface LayoutLeaf` 静态联合类型             | **TypeScript 声明合并（Declaration Merging）+ NoInfer 双向锁**  |

---

## 2. Slot 拓扑基础设施：SlotCore 与声明账本（Declaration Ledger）

### 2.1 模块分层与职责边界

DSH 将插槽系统严格解耦为三层：

1. **`@deepseek-ai/dsh-client-ui-slots` (`SlotCore`)**：纯 TypeScript 核心，零运行时依赖（仅依赖 React 类型声明）。负责插槽声明账本、加载时校验（Load-time Validation）、版本号自增与级联卸载（Cascade Teardown）。
2. **`@deepseek-ai/dsh-client-runtime/client` (`SlotRegistry`)**：Cordis 服务层包装。负责通过 `ctx.effect` 绑定插件 Fiber 生命周期、提供 `slots/changed` 跨插件事件桥接、Store 实例轴生命周期管理、以及 `ctx.slots.inject()` 依赖等待控制。
3. **`@deepseek-ai/dsh-client-web-react` (`createSlotRenderer`)**：React 宿主适配器。负责将无 React 依赖的底层账本与宿主 Observable 绑定为带缓存的 `uSES` Hook，驱动 React 组件树安全渲染。

### 2.2 账本内部数据结构（Declaration Ledger）

在 `packages/client/ui-slots/src/index.ts` 中，`SlotCore` 通过扁平化 Map 维护整个应用的动态插槽树：

```typescript
// packages/client/ui-slots/src/index.ts:614-626
interface SlotRecord {
  spec: SlotSpec<SlotEntryDef> | undefined;
  /** 诊断跟踪：记录由哪个插槽的 entry 声明了该子插槽 ('(built-in)' 代表 root) */
  declaredBy: string | undefined;
  /** 父插槽名称，root 插槽为 undefined */
  parent: string | undefined;
  /** 单调递增的声明代次（Declaration Epoch），独立于普通 entry 增删 */
  declarationEpoch: number;
  /** 当前插槽上已注册的所有条目（按优先级及注册序排序） */
  entries: readonly StoredEntry[];
  /** 单调递增版本号，用于驱动 uSES 同步比对 */
  version: number;
  /** 微任务批处理订阅者列表 */
  listeners: Set<() => void>;
  /** 声明生命周期变更的同步监听器 */
  declarationListeners: Set<() => void>;
}
```

#### 先验的 `'root'` 插槽与自举流程

`SlotCore` 在构造函数中唯一硬编码初始化的插槽是 `'root'`，它是整棵渲染树的根节点：

```typescript
// packages/client/ui-slots/src/index.ts:698-705
constructor() {
  const root = this.record('root')
  root.spec = { kind: 'single', scope: 'root' }
  root.declaredBy = '(built-in)'
  root.declarationEpoch = 1
}
```

壳层在启动时只调用 `ctx.slots.renderSlot('root', {})`。任何尝试直接调用 `renderSlot` 渲染非 `'root'` 键的行为都会在运行时被强制拦截抛错（`packages/client/runtime/src/client/slots.ts:252`）。所有子插槽必须由其父组件在其 `register` 的 `children` 表中声明后，通过组件自身的 `props.renderSlot` 局部渲染。

### 2.3 声明代次（Declaration Epoch）与声明注入（Declaration Injection）

在动态插件化系统中，插件激活顺序是不确定的。模块 B 可能试图向模块 A 声明的插槽贡献内容，但模块 A 尚未加载。DSH 拒绝使用隐式延迟等待或伪造 Cordis 服务，而是通过 `SlotRegistry.inject(key, callback)` 实现声明依赖追踪：

```typescript
// packages/client/runtime/src/client/slots.ts:143-205 核心逻辑解析
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void {
  const ctx = this.ctx
  const disposeController = ctx.effect(() => {
    let active: (() => void) | undefined
    let activeEpoch: number | undefined
    let stopped = false

    const reconcile = (): void => {
      if (stopped) return
      const spec = this._core.specDynamic(key)
      const epoch = this._core.declarationEpoch(key)
      // 如果当前代次已经挂载，则无需重复执行
      if (active !== undefined && activeEpoch === epoch) return

      // 旧代次清理
      const dispose = active
      active = undefined
      activeEpoch = undefined
      dispose?.()
      if (spec === undefined) return

      // 嵌套在调用方插件的 ctx.effect 中执行，确保卸载事务性
      const disposeEffect = ctx.effect(callback, `slots.inject("${key}"): declaration`)
      active = () => { void disposeEffect() }
      activeEpoch = epoch
    }

    const unsubscribe = this._core.subscribeDeclaration(key, () => {
      try { reconcile() }
      catch (error) { stop(); queueMicrotask(() => { throw error }) }
    })

    reconcile()
    return stop
  }, `slots.inject("${key}")`)
  return () => { void disposeController() }
}
```

#### Declaration Epoch 机制的关键价值：

1. **区分普通变更与代次重组**：普通插件的挂载/卸载只会增加 `version` 并触发局部 re-render，不会改变 `declarationEpoch`。
2. **生命周期原子联动**：当声明插槽的父条目被卸载时，`declarationEpoch` 递增，所有贡献方的注入回调被立即逆序 Dispose；当父条目重新注册时，贡献方回调使用新代次重新挂载。

### 2.4 级联卸载与资源回收（Cascade Teardown）

当一个注册条目被 Dispose 时，`SlotCore.releaseEntry` 会触发确定性的树状级联销毁：

```typescript
// packages/client/ui-slots/src/index.ts:1129-1149
private releaseEntry(entry: StoredEntry): void {
  // 1. 释放该条目持有的 Store 句柄计数
  if (entry.store !== undefined && typeof entry.store !== 'function') {
    const pinned = this.handleScopes.get(entry.store)
    if (pinned && --pinned.count === 0) this.handleScopes.delete(entry.store)
  }
  if (!entry.children) return
  // 2. 递归遍历该条目声明的所有子插槽
  for (const childKey of Object.keys(entry.children)) {
    const childRec = this.records.get(childKey)
    if (!childRec) continue
    const doomed = childRec.entries
    // 销毁子插槽 Spec
    childRec.spec = undefined
    childRec.declaredBy = undefined
    childRec.parent = undefined
    childRec.declarationEpoch += 1
    childRec.entries = NO_ENTRIES
    this.markDirty(childKey, childRec)
    this.notifyDeclaration(childRec)
    // 3. 递归级联销毁子插槽内的所有注册条目
    for (const dead of doomed) this.releaseEntry(dead)
  }
}
```

**架构断言**：不存在孤立存活的子插槽。只要父节点注销，其下所有子插槽的 Spec、注册条目、Store 实例及 DOM 挂载点在单次同步 Tick 内全部结清，陈旧的 `renderSlot` 闭包再次调用立即抛出 `StaleAuthorizationError`。

---

## 3. 四大插槽形态全景解剖：Single / List / Keyed / Chain

DSH 在 `SlotKind` 中定义了四种数学完备的插槽形态（`single`、`list`、`keyed`、`chain`），分别满足互斥、列表、字典矩阵与自荐链式路由。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            四大插槽形态分发矩阵                              │
└─────────────────────────────────────────────────────────────────────────────┘

    1. Single (独占/遮蔽)              2. List (有序列表)
    ┌─────────────────────────┐        ┌─────────────────────────┐
    │ Slot: 'conversation'    │        │ Slot: 'shell.overlay'   │
    │ ┌─────────────────────┐ │        │ ┌─────────────────────┐ │
    │ │ Priority 0 (Winner) │ │        │ │ Item 1 (order: 10)  │ │
    │ ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤ │        │ ├─────────────────────┤ │
    │ │ Priority 10 (Shadow)│ │        │ │ Item 2 (order: 20)  │ │
    │ └─────────────────────┘ │        │ └─────────────────────┘ │
    └─────────────────────────┘        └─────────────────────────┘

    3. Keyed (键控矩阵分发)            4. Chain (自荐链式路由)
    ┌─────────────────────────┐        ┌─────────────────────────┐
    │ Slot: 'chat.commandview'│        │ Slot: 'chat.turnTail'   │
    │ Key: 'terminal'         │        │ Entry A: select() -> null│
    │ ┌─────────────────────┐ │        │ Entry B: select() -> ✔  │
    │ │ TerminalCommandCard │ │        │ ┌─────────────────────┐ │
    │ └─────────────────────┘ │        │ │ Render B(matched)   │ │
    │ Key: 'git'              │        │ └─────────────────────┘ │
    │ ┌─────────────────────┐ │        │ Entry C: (Skipped)      │
    │ │ GitCommandCard      │ │        │ Fallback: (If all null) │
    │ └─────────────────────┘ │        └─────────────────────────┘
    └─────────────────────────┘
```

### 3.1 Single 插槽：单细胞排他与优先级遮蔽（Shadowing）

- **定义**：插槽内同一时刻只允许一个活动渲染条目。
- **规则**：
  - 默认 `priority = 0`。若两个条目以相同优先级注册，在装载期直接抛错（Fail-Loud）。
  - 若以不同优先级注册，优先级数值更小（升序）者成为赢家（Winner），高优先级条目被安全遮蔽（Shadowed）。
  - **崩溃退让协议（Abdication Protocol）**：当 Winner 在渲染期触发 Error Boundary 崩溃时，`reportEntryError` 会将该 Entry 加入 `abdicated` WeakSet 并自增版本号，Outlet 立即自动 Fallback 切换至次优条目，实现自愈。

```typescript
// packages/client/ui-slots/src/index.ts:936-952
entriesOfSlot(key: string): readonly StoredEntry[] {
  const rec = this.records.get(key)
  if (!rec?.spec) return NO_ENTRIES
  const kind = rec.spec.kind
  if (kind === 'chain') return rec.entries
  const heads: StoredEntry[] = []
  const seenCells = new Set<string | undefined>()
  for (const entry of rec.entries) {
    if (this.abdicated.has(entry)) continue
    // single 插槽所有条目共享 cell = undefined
    const cell = kind === 'keyed' ? entry.options.key : kind === 'list' ? entry.options.id : undefined
    if (seenCells.has(cell)) continue
    seenCells.add(cell)
    heads.push(entry)
  }
  return heads
}
```

### 3.2 List 插槽：动态有序集合与多维排序

- **定义**：插槽支持多个条目同时挂载，渲染为一个列表（或按 `only: id` 进行单项过滤）。
- **注册参数**：`{ id: string; order?: number; label?: SlotLabel; priority?: number }`。
- **多维排序规则**：
  1. 首先按条目所属的 Cell（以 `id` 区分）进行优先级遮蔽，每个 `id` 仅选出最低 `priority` 的赢家。
  2. 选出各 Cell 赢家后，按 `order` 升序排列；若 `order` 相同，则保持注册序（Registration Order）。
  3. `label` 支持国际化 Thunk（`() => string`），在语言切换时动态重求值。

### 3.3 Keyed 插槽：运行时开放键空间的类型化分发

- **定义**：插槽作为键值映射矩阵。插槽自身在 `SlotMap` 中封闭声明，但其键空间（Key Domain）在运行时开放。
- **关键类型声明**：

```typescript
// packages/client/ui-slots/src/index.ts:105-109
export interface SlotEntryDef {
  kind: SlotKind;
  scope: SlotScope;
  owner?: object;
  /** Keyed 条目的特定 Prop 映射表 */
  keyProps?: Record<string, object>;
}
```

- **分发与调用示例**：
  在 `ui-conversation` 中，聊天节点通过 `conversation.chat.node` 插槽进行 Keyed 分发：

```typescript
// packages/client/ui-conversation/src/client/contract/slots.ts:77-85
'conversation.chat.node': {
  kind: 'keyed'
  scope: 'session'
  owner: ChatNodeOwnerProps
  keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
  hookContext: string
  inject: ChatNodeTurnDataInjected
}
```

父组件渲染时调用：

```typescript
renderSlot(
  'conversation.chat.node',
  { node: myAssistantNode },
  { entryKey: 'assistant' }
);
```

TypeScript 编译器通过 `KeyPropsOf<K, EntryKey>` 自动强制校验：当 `entryKey` 为 `'assistant'` 时，传入的 `node` 必须严格收窄为 `ChatNode<'assistant'>`！

### 3.4 Chain 插槽：自荐式选择器（ChainSelect）与零挂载纯路由

- **定义**：将路由决策权从父组件完全反转给子组件。父组件只派发统一标准的上下文（`OwnerProps`），多个候选插件通过纯选择器自荐。
- **痛点根除**：传统方案中，如果组件为了判断「我不接管该数据」而先 Mount 再在内部 `return null`，会导致 React Hook、Effect、DOM 节点白跑，破坏 `React.memo` 并产生严重的挂载/卸载抖动。
- **DSH 纯选择器（ChainSelect）契约**：

```typescript
// packages/client/ui-slots/src/index.ts:257
export type ChainSelect<O extends object, M> = (owner: O) => M | null;
```

- **执行流程与选举算法**：
  1. 链条条目在注册时按 `priority` 升序排列（同优先级保持装配序）。
  2. 渲染时，`SlotOutlet` 遍历条目并执行 `entry.select(ownerProps)`。
  3. **首个返回非 `null` 的条目立即当选（Elected）**，其返回值作为 `matched` 属性直接注入组件 Props；
  4. 选出的组件挂载，**未当选的条目完全不触发 React 渲染流程，零挂载副作用**！
  5. 若所有条目均返回 `null`，则渲染父组件传入的 `fallback`。

```typescript
// packages/client/web-react/src/scoped-slots.tsx:774-800
if (spec.kind === 'chain') {
  let elected: ReactNode = null
  for (const entry of entries) {
    let matched: unknown
    try {
      matched = (entry.select as (owner: object) => unknown)(ownerProps)
    } catch (error) {
      // 容错机制：异常的选择器降级为 decline，绝不拖垮整条链
      console.error(`chain selector crashed in '${slotKey}':`, error)
      continue
    }
    if (matched !== null) {
      elected = guarded(entry, entryKeyOf(entry), { ...ownerProps, matched })
      break
    }
  }
  if (opts?.overlay) {
    // 覆盖链模式：Fallback 常驻挂载（display: none / contents），DOM 状态（如草稿）在选举接管时得以保留
    return (
      <>
        <div data-chain-overlay-fallback={slotKey} style={{ display: elected === null ? 'contents' : 'none' }}>
          {opts.fallback ?? null}
        </div>
        {elected}
      </>
    )
  }
  return elected ?? <>{opts?.fallback ?? null}</>
}
```

---

## 4. TypeScript 声明合并与 ComposedProps 四份额强类型推导

### 4.1 声明合并（Declaration Merging）拓扑

DSH 的 `SlotMap` 在核心包 `ui-slots` 中被声明为一个空接口：

```typescript
// packages/client/ui-slots/src/index.ts:24
export interface SlotMap {}
```

各个业务包通过 TypeScript 的 `declare module` 语法在各自的模块中向 `SlotMap` 扩充行定义：

```typescript
// packages/client/ui-layout/src/client/index.ts:33-85
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    sidebar: { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps };
    conversation: {
      kind: 'single';
      scope: 'session-maybe';
      owner: ConvOwnerProps;
    };
    details: { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps };
    'shell.overlay': { kind: 'list'; scope: 'root' };
  }
}
```

### 4.2 ComposedProps 四份额推导全景

组件接收的 Props 绝不包含任何全局 Context，而是由四个相互独立的纯净来源在编译期求交集运算而成：

$$\text{ComposedProps} = \text{PropsRuntime} \cap \text{PropsRenderSlots} \cap \text{PropsStore} \cap \text{InjectFace} \cap \text{PropsLocale} \cap \text{MatchedShare}$$

```typescript
// packages/client/ui-slots/src/index.ts:442-451
export type ComposedProps<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  S extends keyof SlotMap & string,
  H,
  I extends object,
  M = never,
  N = undefined,
> = PropsRuntime<K, EntryKey> &
  PropsRenderSlots<S> &
  PropsStore<H> &
  InjectFace<I> &
  MatchedShare<SlotMap[K], M> &
  PropsLocale<N>;
```

#### 份额拆解表：

| 份额名称              | 类型生成器                    | 权威真源                        | 注入内容与职责                                                                                                                                                |
| --------------------- | ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 运行时份额**     | `PropsRuntime<K, EntryKey>`   | `SlotMap[K]`                    | `OwnerOf<K>`（父级传入参）+ `KeyPropsOf<K, EntryKey>` + 会话标准套件（`useSession`, `sessionId`）+ 全局套件（`useSessions`, `useWorkspaces`）                 |
| **2. 子插槽渲染份额** | `PropsRenderSlots<S>`         | `register` 中的 `children` 键集 | `renderSlot(key, owner)`，键集 $S$ 被编译期静态收窄至 `children` 声明范围；若含 chain 槽则额外注入 `renderSlotChain`；若含 session 槽则注入 `SessionProvider` |
| **3. Store 份额**     | `PropsStore<H>`               | `store` 工厂返回类型            | `useStore` 快照选择器 Hook + `actions.*`（已自动剥除 Immer `draft` 参数的纯回调函数）                                                                         |
| **4. 业务注入份额**   | `InjectFace<I>`               | `inject` 工厂返回类型           | 注册方私有业务数据与回调；`hooks` 字段内的 Observable 裸源被框架自动合成绑定为 `use<Name>` 选择器 Hook                                                        |
| **5. 国际化份额**     | `PropsLocale<N>`              | `locale: N` 声明                | 框架绑定的强类型 `t: TranslateNS<N>` 翻译函数，键域受 `LocaleNamespaceMap[N]` 严格约束                                                                        |
| **6. 链式匹配份额**   | `MatchedShare<SlotMap[K], M>` | `select` 纯选择器返回值         | 仅限 `chain` 插槽，注入选择器产出的 `matched: M` 属性                                                                                                         |

### 4.3 两大类型系统加固裁定（Rulings）

在 `ui-slots` 的实现中，包含了两条极其深刻的 TypeScript 类型加固设计：

#### 裁定 1：裸函数签名 `SlotComponent<P>` 代替 `React.FC<P>`

```typescript
// packages/client/ui-slots/src/index.ts:370
export type SlotComponent<P> = (props: P) => ReactNode;
```

- **原因剖析**：`React.FC` 携带了 `defaultProps`、`propTypes` 等静态属性，这些静态属性在 TypeScript 的类型协变检查中会引入额外的类型干扰，导致子类型可赋值性检查（Assignability Check）失败。采用裸调用签名 `(props: P) => ReactNode` 只走纯粹的形参逆变（Contravariance）检查，确保组件作为纯函数干净传递。

#### 裁定 2：`NoInfer<I>` 钉住业务注入份额推导

```typescript
// packages/client/ui-slots/src/index.ts:778-785
register<
  K extends keyof SlotMap & string,
  I extends object,
  // ...
>(
  options: BaseOptions<K, EntryKey, D, H, M, N> & { inject: (...args: InjectParams<K, H>) => I },
  component: C
    & SlotComponent<ComposedProps<
      K, NoInfer<EntryKey>, keyof NoInfer<D> & keyof SlotMap & string,
      HandleOf<NoInfer<H>>, I, NoInfer<M>, NoInfer<N>
    >>
    & RendersCheck<C, D>,
): () => void
```

- **原因剖析**：如果不对 `component` 处的类型参数使用 `NoInfer`，TypeScript 编译器在推断泛型 `I` 时会同时从 `inject` 返回值和 `component` 的参数两个候选位收集类型。当组件错误地消费了一个 `inject` 工厂根本没有提供的属性时，TS 会错误地将 `I` 自动「拓宽（Widen）」使调用通过，从而完全掩盖组件属性漂移的 Bug。`NoInfer<I>` 将 `I` 的唯一真源强制钉在 `inject` 工厂上！

#### 裁定 3：`RendersCheck<C, D>` 编译期反向约束

```typescript
// packages/client/ui-slots/src/index.ts:518-524
type RendersCheck<C, D> = [keyof D & keyof SlotMap & string] extends [never]
  ? unknown
  : C extends (props: infer P) => ReactNode
    ? 'renderSlot' extends keyof P
      ? unknown
      : 'renderSlotChain' extends keyof P
        ? unknown
        : {
            'children declared but the component consumes no renderSlot': keyof D &
              keyof SlotMap &
              string;
          }
    : unknown;
```

- **原因剖析**：**声明即认领**。如果组件在 `options.children` 中声明了子插槽（锁定了该子插槽的渲染权），但组件自身的 Props 中却没有接收并消费 `renderSlot`，编译器会通过构造一个不可满足的交集类型直接在注册点报红，杜绝占槽不渲染的死锁隐患。

---

## 5. 运行时生命周期、状态隔离与响应式数据平面

### 5.1 数据隔离的三大作用域（SlotScope）

DSH 在 Slot 级别定义了三种数据生存期：

1. `'root'`：全局单例作用域（如全屏浮层 `shell.overlay`、侧边栏 `sidebar`）。
2. `'session'`：严格会话绑定作用域（如对话消息体 `conversation.session`、详情面板 `details`）。必须依赖当前活跃 SessionId，Session 销毁时其实例被级联清理。
3. `'session-maybe'`：会话可选/自适应作用域（如主对话区域 `conversation`、输入框 `InputBar`）。

### 5.2 `session-maybe` 的「领养模型（Adoption Model）」

在 Web 客户端中，应用启动时可能处于「无会话（No Session）/ 空白欢迎页」状态。传统方案往往在此处分叉渲染不同的组件树，导致后续创建 Session 时整个 DOM 树被完全销毁重挂。

DSH 提出了精妙的 **领养机制（Session Adoption）**：

```typescript
// packages/client/web-react/src/scoped-slots.tsx:555-578
const [state, setState] = useState<MaybeIncarnation>(FIRST_INCARNATION);
let { adopted, epoch } = state;
if (info.sessionId !== undefined && adopted === undefined) {
  // 领养阶段：从无会话进入首个会话，保持 epoch 不变 -> 零重挂（Zero Remount）！
  adopted = info.sessionId;
  setState({ adopted, epoch });
} else if (
  adopted !== undefined &&
  info.sessionId !== undefined &&
  info.sessionId !== adopted
) {
  // 会话切换：切换到不同会话，epoch 递增 -> 安全重挂以隔离局部状态
  adopted = info.sessionId;
  epoch += 1;
  setState({ adopted, epoch });
} else if (adopted !== undefined && info.sessionId === undefined) {
  // 回到无会话状态：epoch 递增 -> 重挂回空白宿主
  adopted = undefined;
  epoch += 1;
  setState({ adopted, epoch });
}
```

**领养优势**：

- 当用户在空白欢迎页的输入框中输入文本并点击创建会话时，输入框所在的 DOM、焦点及输入法组合状态（IME Composition）完全不发生重挂，无缝过渡为正式会话！
- 会话间切换时严格通过 `key={epoch}` 重置，彻底隔绝会话间组件局部状态泄漏。

### 5.3 框架快照 Store 引擎（Snapshot Store Engine）

DSH 严禁插件在模块作用域导出全局单例 Store 句柄（避免跨重载单例污染与测试隔离失败），而是通过工厂函数结合 Immer 规范写入集合：

```typescript
// packages/client/ui-layout/src/client/stores.ts 示例
export function createLayoutStore() {
  return defineStore({
    init: () => ({ sidebar: 280, details: 0, narrowExpanded: false }),
    persist: 'dsh.layout.panels',
    actions: {
      setSidebar: (d, width: number) => {
        d.sidebar = width;
      },
      setDetails: (d, width: number) => {
        d.details = width;
      },
      closeDetails: (d) => {
        d.details = 0;
      },
    },
  });
}
```

- **状态读写分离**：
  - 组件内部只能通过 `props.useStore(selector)` 读取快照切片（底层为 `uSES` 订阅）；
  - 写入操作只能通过 `props.actions.*` 进行，底层裸 Store 的 `set/update` 方法永远对业务组件不可见，实现 100% 可审计的写通道。

---

## 6. 渲染引擎与 DOM 架构：display: contents 与零污染挂载

### 6.1 `display: contents` 的零布局污染哲学

在传统的插件化组件系统（如多层嵌套 Card、动态 Dock）中，每一个插槽挂载点通常需要一个包装 `div` 容器。这在现代 CSS Grid 或 Flexbox 布局中是灾难性的，因为中间插入的 `div` 会直接破坏父容器的 `grid-template-columns` 或 `flex` 轴向布局。

DSH 在 `SlotOutlet` 和 `RootOutlet` 中统一采用 `display: contents` 锚点：

```typescript
// packages/client/web-react/src/scoped-slots.tsx:652-679
const ANCHOR_STYLE = { display: 'contents' } as const

function SlotOutlet({ slotKey, ownerProps, opts }: { ... }) {
  // ...
  return (
    <div data-slot={slotKey} style={ANCHOR_STYLE}>
      {renderOutletContent(host, slotKey, ownerProps, opts, sessionInfo)}
    </div>
  )
}
```

#### `display: contents` 带来的决定性优势：

1. **零几何干涉**：该 `div` 在渲染树中生成子节点，但其自身不产生任何 CSS 盒模型（Box Model）。Grid 父容器直接与其内部真正注册的组件交互，网格对齐完好无损。
2. **稳定的 DevTools 与自动化测试锚点**：外层保留 `data-slot="<key>"` 属性，使 CDP、Playwright 测试和开发者工具能瞬时定位插槽边界，且该属性在插槽内容替换/重试期间永不闪烁。

### 6.2 响应式订阅通道（uSES）与微任务批处理

在 `SlotOutlet` 内部，通过 React 18 原生 `useSyncExternalStore` 监听插槽变更与国际化代次刷新：

```typescript
// packages/client/web-react/src/scoped-slots.tsx:660-667
useSyncExternalStore(
  (fn) => host.subscribe(slotKey, fn),
  () => host.getVersion(slotKey)
);
useLocaleRevision(host.locale);
```

当多个插件在同一个事件循环或同一异步批次中连续调用 `register` / `dispose` 时，`SlotCore.markDirty` 会将所有受影响的 Record 放入 `dirty` Set 中，并通过 `queueMicrotask` 进行批处理刷新（`flush()`）。这保证了在一轮宏任务中发生的 N 次插槽变动，在 React 侧只触发一次协调渲染，消除界面撕裂。

### 6.3 细粒度 WeakMap 缓存拓扑

为了确保在频繁的 React Re-render 中不产生无意义的垃圾回收（GC）开销与引用抖动，`scoped-slots.tsx` 建立了五级 WeakMap 缓存矩阵：

```typescript
// WeakMap 缓存体系 (packages/client/web-react/src/scoped-slots.tsx)
const renderSlotCache = new WeakMap<StoredEntry, RenderSlotBinding>();
const renderSlotChainCache = new WeakMap<StoredEntry, RenderSlotChainBinding>();
const rootInjectCache = new WeakMap<StoredEntry, InjectedProps>();
const sessionInjectCache = new WeakMap<
  StoredEntry,
  WeakMap<SessionProvideInfo, InjectedProps>
>();
const localeSeatCache = new WeakMap<
  LocaleFace,
  Map<string, { revision: number; t: Translate }>
>();
const standardPropsCache = new WeakMap<SlotRendererHost, StandardPropsCache>();
```

所有缓存键均绑定在条目或宿主对象的生命周期轴上，随着条目注销，对应闭包与属性对象被 JS 引擎自动垃圾回收，彻底杜绝内存泄漏。

---

## 7. 纯几何让步链调度器：AppFrame 与 computeColumns 解密

在桌面 IDE 壳层布局中，侧边栏（Sidebar）、主工作区（Center）与详情面板（Details）的三栏宽度分配往往充满各种状态机冲突。DSH 在 `ui-layout` 中实现了一套极其纯粹的让步链求解器（Concession-Chain Column Solver）。

### 7.1 让步链公理定理（Concession Axioms）

在 `packages/client/ui-layout/src/client/columns.ts` 中，DSH 锁定了以下几何不变式：

1. **第一优先级（Sidebar 不让步）**：侧边栏始终保持用户的偏好宽度（或折叠状态下的固定 `SIDEBAR_COLLAPSED = 56px` 导轨），绝对不向任何压缩让步。
2. **第二优先级（Center 保护底线）**：中间主工作区必须尽可能维持在 `CENTER_MIN = 640px` 以上。
3. **第三优先级（Details 逐级让步）**：当视口宽度不足时，首先将详情面板从用户偏好宽度压缩至 `DETAILS_MIN = 300px`；若依然不足，则**自动派生关闭详情面板（`details: 0`）**。
4. **最终兜底（Center 最终吸收）**：当详情面板已完全关闭且视口依然小于 `SIDEBAR_MIN + CENTER_MIN` 时，中间区域吸收剩余的所有赤字（允许低于 640px）。

### 7.2 无滞后（Hysteresis-Free）纯函数求解算法

```typescript
// packages/client/ui-layout/src/client/columns.ts:62-77
export function computeColumns(
  viewport: number,
  sidebar: number,
  details: number
): Columns {
  const s =
    sidebar === 0
      ? SIDEBAR_COLLAPSED
      : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX);

  // Step 1: 完美容纳所有偏好宽度
  if (s + d0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - d0, details: d0 };
  }

  // Step 2: 压缩 details 逼近最小值
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN);
  if (s + d1 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: CENTER_MIN, details: d1 };
  }

  // Step 3: 自动关闭 details (仅为派生计算，不覆写用户的偏好 Store); center 吸收剩余赤字
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 };
}
```

**关键设计亮点**：

- **不修改用户偏好（Non-Destructive）**：当窗口缩小时，Details 虽然在视觉上被隐藏（`details = 0`），但 Store 中保存的用户偏好宽度（如 360px）完好无损。一旦用户拉大窗口，Details 瞬间自动恢复，无需复杂的「恢复状态机」。
- **组件树不卸载**：当 `details === 0` 时，`<DetailsColumn>` 依然保持在 DOM 树中（宽 0 隐藏），其内部的 Slot 状态、网络连接与滚动位置完全不丢失。

### 7.3 拖拽调宽（Resize Dragging）的高性能实现

在 `AppFrame.tsx` 中，拖拽采用了现代标准的 Pointer Capture 与 rAF 节流方案：

1. **指针捕获（Pointer Capture）**：在 `onPointerDown` 时调用 `e.currentTarget.setPointerCapture(e.pointerId)`，确保鼠标移出视口或遮挡在 iframe 上方时仍能精准接收移动事件。
2. **动画帧节流（rAF Throttle）**：使用 `requestAnimationFrame` 保证每帧最多触发一次 Store 状态写入，避免拖拽引发的高频 Re-render。
3. **冻结基准（Frozen Base）**：在拖拽开始时将当前渲染宽度锁定为基准点（`sidebarBase.current = cols.sidebar`），后续位移均计算相对于起点的绝对 `dx`，彻底杜绝浮点数累积漂移。

---

## 8. 平行注册表的溶解：ToolView、CommandView 与 ViewRegistry

### 8.1 独立工具环（ToolViewRegistry）的退役与溶解

在 DSH 的早期架构中，曾存在独立的 `ctx.toolviews`（`ToolViewRegistry`）。该注册表拥有自己的一套 `register` 语法、自己的作用域谓词分发、自己的订阅机制与私有错误边界。

在 2026-07-23 的架构决策中，DSH 将工具环**彻底溶解进 Slot 体系**：

- 工具行被统一收敛为各视图声明的 **`keyed` 子插槽**（如 `conversation.chat.commandview` 和 `tool.call.toolview`）。
- 工具名称作为运行时开放集，与 `keyed` 插槽的 `entryKey` 完美契合。
- 溶解后，所有工具视图天然免费获得了 Slot 框架级的主动错误隔离、`uSES` 批处理订阅、Store 席位以及国际化注入能力，消除了第二套平行注册系统的维护负担。

### 8.2 目标中立的会话节点组装（Target-Neutral Conversation Node Assembly）

在会话流展示中，DSH 将业务事件（Event）的解释与具体视图（View）彻底解耦，建立了目标中立的组装流水线：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   DSH 目标中立 Conversation 组装流水线                       │
└─────────────────────────────────────────────────────────────────────────────┘

  Session Events (流式/反扫窗口)
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ Definition Registry (按 kind 注册的 ConversationNodeDefinition)           │
  │   - ToolDefinition, AssistantDefinition, CompactionDefinition           │
  │   - match(event): { id, role: 'start' | 'update' }                      │
  │   - start() / update() -> State (纯状态演进，隔离于具体视图)             │
  └─────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ Assembler (维持依赖拓扑、LocationIndex 及脏集标记)                         │
  │   - publication: 'immediate' | 'animation-frame' | 'none'               │
  │   - buildLocationData(): 将业务数据挂载至 Step / Turn 事实                │
  │   - buildViewNode(): 产出目标中立的 ConversationViewNode                 │
  └─────────────────────────────────────────────────────────────────────────┘
        │
        ├───────────────────────────────────┬───────────────────────────────┐
        ▼                                   ▼                               ▼
  ┌───────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────────┐
  │ Chat ViewBuilder          │ │ Trajectory ViewBuilder    │ │ (Future) Graph ViewBuilder│
  │ 整理为 Chat keyed snapshot │ │ 整理为 Waterfall timeline │ │ 整理为 DAG 执行流图        │
  └───────────────────────────┘ └───────────────────────────┘ └───────────────────────────┘
```

### 8.3 声明式 `ViewRegistry` 替代静态 `switch`

在 `packages/client/runtime/src/client/conversation/view-registry.ts` 中：

```typescript
export class ConversationViewRegistry extends ConversationDefinitionRegistry<ConversationViewDefinition> {
  constructor(ctx: Context) {
    super(ctx, 'conversationViews');
  }

  register(definition: ConversationViewDefinition): () => void {
    return this.registerDefinition(
      definition.target,
      definition,
      `conversation view target "${definition.target}" is already registered`,
      `conversationViews.register(${JSON.stringify(definition.target)})`
    );
  }
}
```

- **目标中立性**：`ConversationNodeDefinition` 只负责将 SessionEvent 转换为业务 State，不感知任何具体 UI。
- **按需投影**：`Chat` 插件和 `Trajectory` 插件分别向 `conversationViews` 注册自己的 `ViewBuilder`。Session 只负责推送连续事件窗口并发布 Snapshot，彻底终结了在 Session 内部通过巨型 `switch` 维护不同视图分支的历史。

---

## 9. Conex 点对点映射与二叉树工作区插件化落地蓝图

### 9.1 Conex 现状痛点诊断：`TreeLeafPanel.tsx` 的静态断层

当前 Conex 的工作区二叉树（`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`）在分发面板内容时，采用了典型的硬编码静态 `switch(panelId)`：

```typescript
// 现状代码：apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx:265-294
switch (panelId) {
  case 'chat':
    return <ChatCard ... />;
  case 'terminal':
    return <TerminalCard ... />;
  case 'preview':
    return <PreviewCard ... />;
  case 'overview':
    return <OverviewCard ... />;
  case 'files':
    return <FilesCard ... />;
  case 'diff':
    return <DiffCard ... />;
  case 'runtime':
    return <RuntimePanel ... />;
  case 'agent':
    return <AgentCard />;
  default:
    return <div className={styles.emptyState}>未知面板类型：{panelId}</div>;
}
```

#### 架构弊端分析：

1. **开闭原则（OCP）破缺**：新增任意一个独立工具卡片（如 Markdown 预览、Git Graph、数据库终端），必须直接修改 `TreeLeafPanel.tsx`、`layoutTreeStore.ts` 以及 `types.ts`。
2. **上下文深度污染**：每个卡片需要手工穿透 `wsId`、`handleGlobalTabClick`、`onShowToast`、`sessionId` 等大量参数，组件无法作为纯函数独立装配。
3. **缺乏故障隔离**：某一个面板渲染崩溃时，虽然有外层 `AppErrorBoundary`，但无法实现类似 DSH 的优先级降级与自愈退让。

### 9.2 Conex 微内核改造演进蓝图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Conex 二叉树工作区 Slot 化改造目标架构                     │
└─────────────────────────────────────────────────────────────────────────────┘

                                Conex App Shell
                                       │
                                       ▼ (renderSlot('root'))
                              ┌──────────────────┐
                              │  WorkspaceFrame  │
                              └──────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼ (renderSlot('workspace.sidebar'))           ▼ (renderSlot('workspace.tree'))
        ┌───────────────┐                             ┌───────────────────────────────┐
        │  LeftSidebar  │                             │      BinaryTreeWorkspace      │
        └───────────────┘                             └───────────────────────────────┘
                                                                      │
                                                ┌─────────────────────┴─────────────────────┐
                                                ▼                                           ▼
                                      ┌───────────────────┐                       ┌───────────────────┐
                                      │ TreeSplitContainer│                       │   TreeLeafPanel   │
                                      └───────────────────┘                       └───────────────────┘
                                                                                            │
                                                                                            ▼
                                                              ┌───────────────────────────────────────────┐
                                                              │ renderSlot('workspace.leaf.panel',        │
                                                              │   { leafId, sessionId, isActive },        │
                                                              │   { entryKey: leaf.activeTab }            │
                                                              │ ) ◄── Keyed 插槽动态分发                   │
                                                              └───────────────────────────────────────────┘
                                                                    │
                                    ┌───────────────────────────────┼───────────────────────────────┐
                                    ▼                               ▼                               ▼
                          ┌──────────────────┐            ┌──────────────────┐            ┌──────────────────┐
                          │     ChatCard     │            │   TerminalCard   │            │  (Plugin) Diff   │
                          │ (Self-Registered)│            │ (Self-Registered)│            │ (Self-Registered)│
                          └──────────────────┘            └──────────────────┘            └──────────────────┘
```

### 9.3 落地步骤详解（Step-by-Step Implementation）

#### 第一阶段：在 Conex 中引入轻量级 `SlotCore` 与类型合并接口

在 `apps/crish-desktop/src/core/slots/` 中引入基于 DSH 架构的纯 TypeScript `SlotCore` 与 `SlotMap` 契约定义：

```typescript
// apps/crish-desktop/src/core/slots/types.ts
export interface SlotMap {}

declare module '@/core/slots/types' {
  interface SlotMap {
    root: { kind: 'single'; scope: 'root'; owner: {} };
    'workspace.tree': { kind: 'single'; scope: 'root'; owner: {} };
    /** 二叉树叶子面板：keyed 插槽，以 PanelId 进行动态分发 */
    'workspace.leaf.panel': {
      kind: 'keyed';
      scope: 'root';
      owner: LeafPanelOwnerProps;
      keyProps: Record<string, object>;
    };
    /** 叶子面板顶部工具栏扩展区 */
    'workspace.leaf.tab.actions': {
      kind: 'list';
      scope: 'root';
      owner: { leafId: string; sessionId?: string };
    };
  }
}

export interface LeafPanelOwnerProps {
  leafId: string;
  sessionId?: string;
  isActiveLeaf: boolean;
  onShowToast: (msg: string) => void;
}
```

#### 第二阶段：改造 `TreeLeafPanel.tsx` 为声明式 Keyed 插槽出口

将 `TreeLeafPanel.tsx` 中生硬的 `switch(panelId)` 替换为纯净的 `renderSlot` 调用：

```tsx
// 改造后：apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx
export const TreeLeafPanel: React.FC<TreeLeafPanelProps> = React.memo(
  ({
    leaf,
    rect,
    isActive,
    isDragSource,
    onShowToast,
    isMultiChat = false,
    renderSlot, // 由父级或者标准 kit 注入
  }) => {
    // ... 几何更新与拖拽激活逻辑保持不变 ...

    return (
      <div
        ref={leafElRef}
        className={styles.leaf}
        data-leaf-id={leaf.id}
        data-panel-id={leaf.panelId}
        data-active={isActive ? 'true' : 'false'}
      >
        {/* 保持 per-unit 或 tool tab strip */}
        {isChat && isMultiChat ? (
          <UnitSessionTabStrip
            leafId={leaf.id}
            leafSessionId={leaf.sessionId}
          />
        ) : null}
        {!isChat ? <LeafToolTabStrip leaf={leaf} /> : null}

        <div className={styles.leafBody}>
          {/* 通过 Keyed Slot 动态派发，彻底消除 switch-case */}
          {renderSlot(
            'workspace.leaf.panel',
            {
              leafId: leaf.id,
              sessionId: sessionForPanel ?? undefined,
              isActiveLeaf: isActive,
              onShowToast,
            },
            {
              entryKey: leaf.activeTab,
              fallback: (
                <div className={styles.emptyState}>
                  未知面板或面板未加载：{leaf.activeTab}
                </div>
              ),
            }
          )}
        </div>
      </div>
    );
  }
);
```

#### 第三阶段：各业务卡片自注册（Self-Registration）

各面板组件不再需要集中暴露给 `TreeLeafPanel`，而是各自在其插件模块的 `apply` 函数中自注册：

```typescript
// 示例：Chat 插件自注册
// apps/crish-desktop/src/plugins/chat/index.ts
export function apply(ctx: ClientContext) {
  ctx.slots.register(
    {
      name: 'workspace.leaf.panel',
      key: 'chat',
      store: createChatStore,
      inject: (actions) => ({
        // 封装业务动作
      }),
    },
    ChatCard
  );
}

// 示例：Terminal 插件自注册
// apps/crish-desktop/src/plugins/terminal/index.ts
export function apply(ctx: ClientContext) {
  ctx.slots.register(
    {
      name: 'workspace.leaf.panel',
      key: 'terminal',
    },
    TerminalCard
  );
}
```

### 9.4 Conex 与 DSH 核心符号对标映射表

| 功能域                 | Conex 现状实现位置                          | DSH 标准解法位置                                                     | 迁移目标与收敛建议                                          |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| **插槽声明与拓扑**     | 无（硬编码在 JSX 树中）                     | `packages/client/ui-slots/src/index.ts` (`SlotCore`)                 | 建立全局唯一的 `SlotMap` 声明合并中心                       |
| **插槽生命周期与绑定** | 散落的 React Context / Prop Drilling        | `packages/client/runtime/src/client/slots.ts` (`SlotRegistry`)       | 接入 Cordis Fiber 生命周期，支持 `ctx.slots.inject()`       |
| **宿主 Outlet 渲染**   | 手写 `<div>` 容器                           | `packages/client/web-react/src/scoped-slots.tsx` (`SlotOutlet`)      | 采用 `<div data-slot style={{ display: 'contents' }}>` 包装 |
| **面板内容路由**       | `TreeLeafPanel.tsx:265` `switch(panelId)`   | `SlotCore.register` (`kind: 'keyed'`)                                | 溶解静态 switch，改为 Keyed 插槽动态分发                    |
| **工具行扩展**         | `LeafToolTabStrip.tsx` 固定读取 `leaf.tabs` | `conversation.chat.commandview` (`keyed`)                            | 允许外部插件向活动叶子注册动态 Tab 扩展项                   |
| **状态快照与动作**     | `useLayoutTreeStore` (Zustand 裸实例)       | `packages/client/ui-slots/src/store.ts` (`defineStore`)              | 引入 Immer 动作规范，剥除组件直接执行 `set()` 的权力        |
| **三栏几何求解器**     | 散落的 CSS Grid / 拖拽 Sash 计算            | `packages/client/ui-layout/src/client/columns.ts` (`computeColumns`) | 提取无滞后的纯函数让步链求解器                              |
| **多视图切换**         | 静态 Tab 数组映射                           | `packages/client/runtime/src/client/conversation/view-registry.ts`   | 引入 `ViewRegistry`，视图作为 `ViewBuilder` 插件独立插入    |

---

## 10. 架构不变量（Invariants）与防退避自检清单

为确保重构或后续扩展过程中严格保持架构纯洁性，所有参与协同的 Agent 必须严格恪守以下七条铁律：

### 10.1 核心架构不变量（Architectural Invariants）

1. **唯一 ctx 级渲染入口铁律**：`ctx.slots.renderSlot` **只能且必须只能渲染 `'root'`**。任何尝试在 ctx 级别渲染子插槽的调用必须在装载期直接抛出异常。
2. **声明即独占授权铁律**：插槽必须且只能由占用父插槽的条目在其 `children` 表中声明；未声明的子插槽严禁在组件中调用 `props.renderSlot`，否则编译期通过 `RendersCheck` 报红，运行时抛出 `SlotOwnershipError`。
3. **零全局 Store 句柄铁律**：严禁在模块顶级导出可变的 Store 实例或句柄。Store 必须定义为工厂函数（`createXxxStore`），其实例化与生命周期完全由框架依据 SlotScope 进行托管。
4. **组件纯函数铁律**：业务组件严禁直接 `import` 全局 Context、Cordis Context 或未收窄的服务实例。所有数据、Hooks、Store 和子插槽渲染能力必须通过四份额 `ComposedProps` 进入。
5. **NoInfer 推导锁定铁律**：在所有的 `register` 泛型签名中，组件的业务注入份额必须被 `NoInfer<I>` 锁定，严禁从组件参数反向推导并拓宽业务接口。
6. **零布局污染铁律**：所有插槽的 Outlet 容器必须统一应用 `display: contents`，严禁产生破坏 CSS Grid / Flex 几何的中间盒模型。
7. **纯选择器链式路由铁律**：`chain` 插槽的路由必须由纯函数 `select(owner)` 决定。严禁组件先 Mount 再在内部探测 Props 返回 `null`。

### 10.2 源码对标自检清单（Self-Audit Checklist）

- [x] 通读 `packages/client/ui-slots/src/index.ts`，彻底掌握 `SlotCore`、`SlotMap` 与四形态分发逻辑。
- [x] 通读 `packages/client/ui-slots/src/store.ts`，掌握 `defineStore` 与 `BakedActions` 剥除 Immer Draft 的类型推导。
- [x] 通读 `packages/client/ui-slots/src/renderer.ts`，掌握 `SlotRendererHost` 宿主接口契约。
- [x] 通读 `packages/client/runtime/src/client/slots.ts`，掌握 `SlotRegistry` 与 Cordis `ctx.effect` 的绑定机制。
- [x] 通读 `packages/client/web-react/src/scoped-slots.tsx`，掌握 `uSES` 批处理、`display: contents` 与 WeakMap 缓存设计。
- [x] 通读 `packages/client/ui-layout/src/client/AppFrame.tsx` 与 `columns.ts`，掌握让步链几何调度。
- [x] 通读 `packages/client/runtime/src/client/conversation/view-registry.ts`，掌握目标中立的视图注册模型。
- [x] 验证 Conex `TreeLeafPanel.tsx` 现有缺陷，并产出详尽的向后兼容迁移落地蓝图。
