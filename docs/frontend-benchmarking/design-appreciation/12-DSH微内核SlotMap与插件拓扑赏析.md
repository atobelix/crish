# DeepSeek-Harness 微内核 SlotMap 声明式插槽与插件化纯粹拓扑深度赏析

> **核心判定**：DeepSeek-Harness（下称 DSH）在客户端架构上展现出一种近乎偏执的纯粹与克制。其微内核设计彻底抛弃了传统前端框架中「组件树即应用树」的紧耦合模式，将整个 UI 宇宙抽象为**由先验 `'root'` 衍生而出的声明式插槽拓扑（SlotMap Topology）**。通过**四大正交插槽形态（Single / List / Keyed / Chain）**、**编译期代数级推导的四份额复合属性（ComposedProps）**、**对 CSS 盒模型零布局污染的 `display: contents` 挂载机制**，以及**与 Cordis 插件生命周期完美谐振的单轴级联销毁系统**，DSH 构筑了当代前端工程中极为罕见的极简微内核典范。

---

## 目录

- [一、 极简微内核哲学：壳层只渲染先验的 'root' 插槽](#一-极简微内核哲学壳层只渲染先验的-root-插槽)
  - [1.1 「一切皆插槽」的范式跃迁](#11-一切皆插槽的范式跃迁)
  - [1.2 先验根节点与自举装配链](#12-先验根节点与自举装配链)
  - [1.3 React 的纯投影角色与零框架依赖边界](#13-react-的纯投影角色与零框架依赖边界)
- [二、 四大插槽形态（SlotKind）的数学抽象与拓扑正交美学](#二-四大插槽形态slotkind的数学抽象与拓扑正交美学)
  - [2.1 维度正交化：基数轴（Cardinality）与作用域轴（Scope）](#21-维度正交化基数轴cardinality与作用域轴scope)
  - [2.2 Single 形态：排他性占位与优先级遮蔽（Shadowing）](#22-single-形态排他性占位与优先级遮蔽shadowing)
  - [2.3 List 形态：加法式容器与声明式排序流](#23-list-形态加法式容器与声明式排序流)
  - [2.4 Keyed 形态：开放键域的高性能运行时多态分发](#24-keyed-形态开放键域的高性能运行时多态分发)
  - [2.5 Chain 形态：自荐链与纯选择器路由（Pure Selector Routing）](#25-chain-形态自荐链与纯选择器路由pure-selector-routing)
  - [2.6 Overlay Chain：基于 CSS 的非卸载式状态保活与接管](#26-overlay-chain基于-css-的非卸载式状态保活与接管)
- [三、 TypeScript 声明合并与 ComposedProps 编译期代数之美](#三-typescript-声明合并与-composedprops-编译期代数之美)
  - [3.1 模块声明合并（Declaration Merging）的权威账本](#31-模块声明合并declaration-merging的权威账本)
  - [3.2 四份额正交交集（Four-Share Intersection）类型系统](#32-四份额正交交集four-share-intersection类型系统)
    - [3.2.1 运行时环境份额：`PropsRuntime<K>` 与上下文穿透](#321-运行时环境份额propsruntimek-与上下文穿透)
    - [3.2.2 子插槽渲染授权份额：`PropsRenderSlots<S>` 与幽灵型变锚点](#322-子插槽渲染授权份额propsrenderslotss-与幽灵型变锚点)
    - [3.2.3 状态隔离份额：`PropsStore<H>` 与 Draft 剥离](#323-状态隔离份额propsstoreh-与-draft-剥离)
    - [3.2.4 业务注入门面份额：`InjectFace<I>` 与响应式 Hooks 映射](#324-业务注入门面份额injectfacei-与响应式-hooks-映射)
    - [3.2.5 附属份额：`MatchedShare` 与类型化国际化 `PropsLocale`](#325-附属份额matchedshare-与类型化国际化-propslocale)
  - [3.3 类型推断防线与硬化裁定（Hardened Type Invariants）](#33-类型推断防线与硬化裁定hardened-type-invariants)
    - [3.3.1 裸函数签名 `SlotComponent<P>` 对抗 `React.FC<P>` 协变噪音](#331-裸函数签名-slotcomponentp-对抗-reactfcp-协变噪音)
    - [3.3.2 `NoInfer<T>` 钉死推断方向，阻绝下游漂移](#332-noinfert-钉死推断方向阻绝下游漂移)
    - [3.3.3 `RendersCheck<C, D>`：声明即认领的静态铁律](#333-renderscheckc-d声明即认领的静态铁律)
- [四、 DOM 盒模型与 CSS 零布局污染挂载（`display: contents` 与数据锚点）](#四-dom-盒模型与-css-零布局污染挂载display-contents-与数据锚点)
  - [4.1 传统组件抽象的「包装地狱（Wrapper Hell）」之痛](#41-传统组件抽象的包装地狱wrapper-hell之痛)
  - [4.2 `<div data-slot={slotKey} style={{ display: 'contents' }}>` 的工程神韵](#42-div-data-slotslotkey-style-display-contents--的工程神韵)
  - [4.3 盒模型解除与 CSS Grid / Flex 轨道的原生穿透](#43-盒模型解除与-css-grid--flex-轨道的原生穿透)
  - [4.4 恒定数据锚点与拓扑自省能力](#44-恒定数据锚点与拓扑自省能力)
  - [4.5 模块级常量 `ANCHOR_STYLE` 的引用稳定性优化](#45-模块级常量-anchor_style-的引用稳定性优化)
- [五、 微内核三层架构解耦：SlotCore、SlotRegistry 与 Web-React](#五-微内核三层架构解耦slotcoreslotregistry-与-web-react)
  - [5.1 纯数据内核：`SlotCore` 的无状态账本与单调版本管理](#51-纯数据内核slotcore-的无状态账本与单调版本管理)
  - [5.2 Cordis 运行时绑定：`SlotRegistry` 与 Fiber 上下文路由](#52-cordis-运行时绑定slotregistry-与-fiber-上下文路由)
  - [5.3 单轴级联注销（Unload Cascade）与权威失效机制](#53-单轴级联注销unload-cascade与权威失效机制)
  - [5.4 声明依赖注入（`slots.inject`）与声明纪元（Declaration Epoch）](#54-声明依赖注入slotsinject与声明纪元declaration-epoch)
  - [5.5 单格崩溃隔离与容错遮蔽降级（Abdication）](#55-单格崩溃隔离与容错遮蔽降级abdication)
- [六、 会话作用域状态机与 SessionMaybe 领养（Adoption）哲学](#六-会话作用域状态机与-sessionmaybe-领养adoption哲学)
  - [6.1 作用域三态：`root`、`session-maybe` 与 `session`](#61-作用域三态rootsession-maybe-与-session)
  - [6.2 `SessionMaybeEntry` 纪元状态机与无损领养机制](#62-sessionmaybeentry-纪元状态机与无损领养机制)
  - [6.3 严格会话边界与跨会话状态泄漏的物理阻隔](#63-严格会话边界与跨会话状态泄漏的物理阻隔)
- [七、 框架级 Store 席位与不可变快照管线](#七-框架级-store-席位与不可变快照管线)
  - [7.1 闭包工厂哲学：消灭跨重载幽灵单例](#71-闭包工厂哲学消灭跨重载幽灵单例)
  - [7.2 严格读写分离：快照订阅（uSES）与 Immer Draft 写入面](#72-严格读写分离快照订阅uses与-immer-draft-写入面)
  - [7.3 作用域自动绑定与持久化存储生命周期联动](#73-作用域自动绑定与持久化存储生命周期联动)
- [八、 真实源码证据链全景剖析](#八-真实源码证据链全景剖析)
  - [8.1 `ui-layout`：AppFrame 自举与四插槽矩阵声明](#81-ui-layoutappframe-自举与四插槽矩阵声明)
  - [8.2 `ui-conversation`：会话主干、动态多态 Chat 节点与接管链](#82-ui-conversation会话主干动态多态-chat-节点与接管链)
  - [8.3 编译期类型防御与单元测试验证链](#83-编译期类型防御与单元测试验证链)
- [九、 总结与工程启示录](#九-总结与工程启示录)

---

## 一、 极简微内核哲学：壳层只渲染先验的 'root' 插槽

### 1.1 「一切皆插槽」的范式跃迁

在传统单体前端应用及常见微前端架构中，应用壳层（Shell）通常扮演着「全知全能的装配管理者」：壳层组件直接感知侧边栏、对话流、工具抽屉、状态栏等业务组件的具体实现，并通过层层嵌套的 JSX、大量的 Context Provider 和手工穿透的 Props 属性完成装配。这种设计存在严重的架构缺陷：

1. **硬编码依赖倒置断裂**：壳层必须显式静态导入具体业务包，任何新增功能或定制化修改都必须重新打包整个应用；
2. **状态蔓延与重渲染风暴**：顶层 Context 包含海量混合状态，导致底层无关子树在状态微小变动时频繁无效 Diff；
3. **扩展边界模糊**：第三方插件无法以确定、安全的方式在特定 UI 区域注入能力，往往只能通过脆弱的全局 DOM 注入或非类型化的事件总线。

DSH（DeepSeek-Harness）通过**极简微内核哲学**对这一困境给出了颠覆性的解法：**应用壳层在语义上完全退化，不再拥有任何具体的业务 UI 概念，其在 React 树顶层所执行的唯一操作，仅仅是渲染一个先验的 `'root'` 插槽**。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DSH Web Client 运行时                            │
│                                                                             │
│  ┌─────────────────────────┐                                                │
│  │   App Shell (薄装配壳)   │ ── 执行 ctx.slots.renderSlot('root', {})      │
│  └────────────┬────────────┘                                                │
│               │ (仅此一处入口，其余全走拓扑衍生)                            │
│               ▼                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 先验插槽: 'root' (Single / Root Scope)                                │  │
│  │ 由 ui-layout 插件的 AppFrame 独占注册                                 │  │
│  │                                                                       │  │
│  │ 声明并授权子插槽:                                                      │  │
│  │ ├── 'sidebar'       (Single / Root Scope)       ──► ui-sidebar 填充   │  │
│  │ ├── 'conversation'  (Single / Session-Maybe)    ──► ui-conversation   │  │
│  │ ├── 'details'        (Single / Session Scope)    ──► ui-details 填充   │  │
│  │ └── 'shell.overlay' (List / Root Scope)         ──► 浮层/通知等插件   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

在 DSH 的世界观中：**不存在「页面」或「布局」的特权实体，一切皆为插槽（Everything is a Slot）**。插槽是渲染树上的一个「拓扑空洞」，插件通过占用插槽来挂载自身，并在同一次注册中**递归声明与授权更深层级的子插槽**。整棵复杂的桌面应用 UI 树，完全由各自独立编译、动态装载的 Cordis 插件通过点对点的插槽接力自然生长而成。

### 1.2 先验根节点与自举装配链

在系统启动阶段，`SlotCore` 在初始化时仅内置播种唯一的先验根节点 `'root'`。阅读 [`packages/client/ui-slots/src/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L698-L705)：

```ts
// packages/client/ui-slots/src/index.ts:698-705
export class SlotCore {
  // ...
  constructor() {
    // The a-priori root hole. No markDirty: nothing can observe construction.
    const root = this.record('root');
    root.spec = { kind: 'single', scope: 'root' };
    root.declaredBy = '(built-in)';
    root.declarationEpoch = 1;
  }
  // ...
}
```

在运行时服务层 [`packages/client/runtime/src/client/slots.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/runtime/src/client/slots.ts#L248-L262)，对外暴露的顶层渲染入口具有极度严格的守卫纪律：

```ts
// packages/client/runtime/src/client/slots.ts:248-262
renderSlot<K extends keyof SlotMap & string>(key: K, owner: OwnerOf<K>): ReturnType<SlotRenderer['renderRoot']> {
  if ((key as string) !== 'root') {
    throw new Error(`ctx-level renderSlot only renders 'root' (got "${key}"); child slots render through the component props face`)
  }
  if (this._renderer === undefined) {
    throw new Error("slot renderer not installed — boot must call ctx.slots.install(createSlotRenderer()) before rendering 'root'")
  }
  if (this._core.entries('root').length === 0) {
    throw new Error("'root' has no registration — a layout entry must register into 'root' before the shell renders it")
  }
  return this._renderer.renderRoot(this.hostFace(), owner)
}
```

这一段代码展现了微内核哲学的「大声失败（Fail-Loud）」原则：

1. `ctx.slots.renderSlot` **只允许渲染 `'root'`**。任何试图在 Context 级别越权渲染子插槽的调用直接抛出异常；
2. 子插槽的渲染权威**只能通过组件 Props 中的 `renderSlot` 函数递归下发**；
3. 杜绝任何「降级回退（Fallback）」带来的静默故障——若未注册根布局插件即尝试渲染，系统立即以致命错误阻断，确保架构边界绝不妥协。

### 1.3 React 的纯投影角色与零框架依赖边界

在 DSH 的插件代码中，存在一条极为严格的代码洁癖纪律：**业务组件是 100% 纯粹的无状态/受控纯函数，组件内部禁止对框架运行时（如 Cordis Context、全局事件总线或服务实例）进行任何 `import`**。

所有业务数据、子插槽渲染能力、状态管理 Hook 以及国际化翻译函数，**全部且只能通过组件 Props 传入**。React 在这套体系中彻底退回为其最初的纯粹定位：**自变量到因变量的纯幂等投影引擎**。

```ts
// 典型 DSH 业务组件签名：零框架 import，纯 Props 驱动
export function AppFrame({
  useStore, // 框架注入的类型化状态选择器
  useSessions, // 框架注入的会话列表选择器
  actions, // 框架注入的写操作面
  renderSlot, // 框架注入并严格收窄的子插槽渲染器
}: AppFrameProps) {
  // 组件只负责响应式渲染与交互触发，绝无外部服务直接调用
  // ...
}
```

这种设计使得 UI 组件与底层平台及插件系统彻底解耦：

- 组件可以毫无障碍地在无 Cordis 容器的纯测试环境（Storybook、Vitest）中进行毫秒级独立单测；
- 换用任何其他渲染层或进行重大重构时，业务组件层资产保持绝对稳固。

---

## 二、 四大插槽形态（SlotKind）的数学抽象与拓扑正交美学

在 DSH 插槽拓扑中，插件间的组合关系被高度提炼为**四种纯粹且正交的代数形态（SlotKind）**：`'single'`、`'list'`、`'keyed'`、`'chain'`。每一种形态都精准映射了前端 UI 组合中的一种经典数学结构。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        DSH 四大插槽形态 (SlotKind) 矩阵                      │
├─────────────┬─────────────────┬────────────────────┬─────────────────────────┤
│ 形态 (Kind) │ 数学模型        │ 路由/决议权归属    │ 经典应用场景            │
├─────────────┼─────────────────┼────────────────────┼─────────────────────────┤
│ single      │ Option<T>       │ 声明排他 / 优先级  │ AppFrame、主侧边栏      │
├─────────────┼─────────────────┼────────────────────┼─────────────────────────┤
│ list        │ Array<T>        │ 累加聚合 / order   │ 底部操作栏、Overlay浮层 │
├─────────────┼─────────────────┼────────────────────┼─────────────────────────┤
│ keyed       │ Map<Key, T>     │ 调用方显式 key 指定│ Chat 节点、动态 Tool    │
├─────────────┼─────────────────┼────────────────────┼─────────────────────────┤
│ chain       │ NonEmptyList<F> │ 注册项纯函数自荐   │ 输入框接管、TurnTail    │
└─────────────┴─────────────────┴────────────────────┴─────────────────────────┘
```

### 2.1 维度正交化：基数轴（Cardinality）与作用域轴（Scope）

DSH 将插槽的元数据属性严格分解为两条相互正交的维度轴：

1. **基数轴（`kind: SlotKind`）**：定义插槽在几何与数量上的容纳规则（`single` / `list` / `keyed` / `chain`）；
2. **作用域轴（`scope: SlotScope`）**：定义插槽在生命周期与数据上下文上的绑定边界（`root` / `session-maybe` / `session`）。

阅读 [`packages/client/ui-slots/src/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L87-L92)：

```ts
// packages/client/ui-slots/src/index.ts:87-92
/** Slot cardinality: single occupant, ordered list, key-dispatched, or selector-routed chain. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain';

/** Slot data context: global, current-session-optional, or strict session-bound. */
export type SlotScope = 'root' | 'session-maybe' | 'session';
```

两个正交轴的乘积构建了一个 $4 \times 3 = 12$ 维的纯粹空间，清晰地覆盖了桌面端从全局单例面板、会话级动态卡片到多会话自适应输入框的全部 UI 拓扑需求。

### 2.2 Single 形态：排他性占位与优先级遮蔽（Shadowing）

`single` 形态表示该插槽在任意时刻**至多只有一个胜出项（Winner）被挂载渲染**。

当多个插件注册到同一个 `single` 插槽时，DSH 并不简单地报错崩溃，而是引入了精致的**优先级遮蔽机制（Shadowing Mechanism）**：

- 每个注册项可指定 `priority?: number`（升序，数值越小优先级越高，默认 `0`）；
- 若同优先级发生冲突，装载期立即抛出硬异常；
- 若优先级不同，系统按优先级排序保留注册账本，渲染时选择**首个存活（未发生崩溃降级）的胜出者**呈现；
- 当高优先级插件崩溃或被卸载时，低优先级插件能无缝自动浮现（Fallback Survivor）。

阅读 [`packages/client/ui-slots/src/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L936-L952)：

```ts
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
    // Single-kind entries all share the one undefined cell.
    const cell = kind === 'keyed' ? entry.options.key : kind === 'list' ? entry.options.id : undefined
    if (seenCells.has(cell)) continue
    seenCells.add(cell)
    heads.push(entry)
  }
  return heads
}
```

### 2.3 List 形态：加法式容器与声明式排序流

`list` 形态是**累加式（Additive）**插槽，用于存放工具栏按钮、设置页扩展选项卡、全局 Toast 浮层等可无限追加的 UI 集合。

- 每个注册项必须携带唯一的 `id: string`；
- 通过 `order?: number` 显式定义排序权重（支持负数，负数预留给前置系统固定项）；
- 在渲染调用端，支持通过 `opts.only` 实现精确的单项抽取渲染（例如标签页切换时只渲染活动 View）。

### 2.4 Keyed 形态：开放键域的高性能运行时多态分发

`keyed` 形态是对传统前端中「巨大 `switch-case` 渲染分支」的优雅降维打击。

在 Chat 对话流中，存在数十种不同的消息节点（文本、代码块、工具调用、思考过程、文件提及等）。传统做法往往是在主包中维护一个庞大的联合类型和分支渲染器；而在 DSH 中，`'conversation.chat.node'` 被声明为 `keyed` 插槽：

- 调用方在 `renderSlot('conversation.chat.node', { node }, { entryKey: node.kind })` 时动态传入 `entryKey`；
- 插件各自独立注册自己关心的 `entryKey`（如 `ui-tool` 注册 `tool-call` 节点）；
- 若没有插件匹配该 `entryKey`，则优雅回落至调用方提供的 `fallback` 通用卡片组件。

键空间在运行时完全开放（Open World Assumption），核心对话流无需硬编码任何具体工具或节点的实现细节。

### 2.5 Chain 形态：自荐链与纯选择器路由（Pure Selector Routing）

`chain` 是 DSH 中最具工程美学的发明之一。它将**路由决议权（Routing Decision Authority）进行了彻底的控制反转**。

在传统架构中，若要实现类似「根据当前用户输入草稿内容动态接管输入框（例如正在进行多轮提问、执行 Slash Command 或处于 Plan 审批模式）」的功能，外层父组件必须感知所有可能的接管模式并编写复杂的判断逻辑；
而在 `chain` 插槽中，**父组件只负责分发无差别的通用 Owner Props，所有子插件通过纯函数选择器（`select: (owner) => matched | null`）进行自荐**：

```ts
// packages/client/ui-slots/src/index.ts:247-257
export type ChainSelect<O extends object, M> = (owner: O) => M | null;
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Chain 形态渲染期纯函数自荐流程                         │
│                                                                             │
│  renderSlotChain('conversation.composer', ownerProps, { fallback, overlay })│
│                                                                             │
│  Ledger 注册链 (按 priority 升序):                                          │
│  ┌─────────────────────────┐                                                │
│  │ Entry 1: PlanMode       │ ── select(ownerProps) ──► 返回 null (放弃接管) │
│  └────────────┬────────────┘                                                │
│               │ (继续传递)                                                  │
│               ▼                                                             │
│  ┌─────────────────────────┐                                                │
│  │ Entry 2: UserQuestion   │ ── select(ownerProps) ──► 返回 { questionId }  │
│  └────────────┬────────────┘                                                │
│               │ (命中! 停止遍历，当选渲染)                                  │
│               ▼                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 渲染 Entry 2 组件，并将 { questionId } 作为 `matched` Prop 强类型注入 │  │
│  │ Entry 1 及后续未命中 Entry 绝不执行 React Mount (零挂载副作用)        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 纯选择器的美学法则

1. **零挂载副作用**：未选中的组件**连一次 React 挂载都不会发生**，其内部的 `useEffect`、数据订阅和 DOM 节点完全不会被创建，彻底消除了传统「挂载后在渲染内部判断 `if (!active) return null`」带来的组件抖动与 Memo 失效；
2. **纯粹性要求**：选择器必须是只依赖 `owner` 参数的纯函数，严禁读取外部可变状态，确保路由过程具有严格的确定性与可测试性；
3. **推导注入**：选择器非空返回值的类型，将直接作为 `matched` 属性精准注入到当选组件的 Props 中。

### 2.6 Overlay Chain：基于 CSS 的非卸载式状态保活与接管

在输入框接管场景中，存在一个极其苛刻的交互体验要求：**当用户在默认输入框中输入了一半草稿，此时触发了外部接管（如弹出了确认问答框），默认输入框虽然不可见，但用户之前输入的草稿、光标位置与正在上传的附件绝对不能丢失**。

DSH 在 `web-react` 的 `SlotOutlet` 中通过 `ChainRenderOpts.overlay` 巧妙地解决了这个问题。阅读 [`packages/client/web-react/src/scoped-slots.tsx`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/web-react/src/scoped-slots.tsx#L802-L819)：

```tsx
// packages/client/web-react/src/scoped-slots.tsx:802-819
if (opts?.overlay) {
  // Overlay chain (ChainRenderOpts.overlay): the fallback stays mounted
  // through elections — hidden via inline display:none (decisive over any
  // author CSS), shown via display:contents so the wrapper never affects
  // the owner's layout. The wrapper's tree position is constant, so React
  // reconciles instead of remounting and fallback state survives takeover.
  return (
    <>
      <div
        data-chain-overlay-fallback={slotKey}
        style={{ display: elected === null ? 'contents' : 'none' }}
      >
        {opts.fallback ?? null}
      </div>
      {elected}
    </>
  );
}
```

- 当有插件当选时，Fallback 包装节点被赋予 `display: 'none'`，在视觉和无障碍树上被隐藏，但 **React 虚拟 DOM 节点保持恒定挂载**，内部状态完好无损；
- 当接管结束（所有选择器返回 `null`）时，包装节点瞬间切换回 `display: 'contents'`，草稿内容毫秒级无损重现；
- 包装节点自身在展示时使用 `display: 'contents'`，保证即使处于激活态也绝对不会对父级布局产生任何额外的盒模型包裹。

---

## 三、 TypeScript 声明合并与 ComposedProps 编译期代数之美

DSH 的类型系统是现代 TypeScript 类型编程的教科书级杰作。它实现了**零手写复合类型、全自动编译期交集推导与严格的双向类型约束**。

```
                   ┌───────────────────────────────────────┐
                   │        SlotMap 声明合并 (权威账本)    │
                   └───────────────────┬───────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │                                             │
                ▼                                             ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│       PropsRuntime<K>        │              │     PropsRenderSlots<S>      │
│  (OwnerProps + Session Kit)  │              │  (renderSlot / Chain 授权)   │
└───────────────┬──────────────┘              └──────────────┬───────────────┘
                │                                             │
                │        ┌────────────────────────────┐       │
                ├───────►│  ComposedProps<K, ..., I>  │◄──────┤
                │        │  (五大份额编译期严格交集)  │       │
                │        └─────────────▲──────────────┘       │
                │                      │                      │
┌───────────────┴──────────────┐       │      ┌───────────────┴──────────────┐
│        PropsStore<H>         │───────┼──────┤        InjectFace<I>         │
│  (useStore + BakedActions)   │       │      │   (私有业务面 + use<Name>)   │
└──────────────────────────────┘       │      └──────────────────────────────┘
                                       │
                         ┌─────────────┴─────────────┐
                         │   MatchedShare & Locale   │
                         │   (matched / t 翻译函数)  │
                         └───────────────────────────┘
```

### 3.1 模块声明合并（Declaration Merging）的权威账本

在 DSH 中，插件通过 TypeScript 的 `declare module` 机制向 `@deepseek-ai/dsh-client-ui-slots` 的 `interface SlotMap` 扩展插槽契约。

阅读 [`packages/client/ui-slots/src/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L23-L24)：

```ts
// packages/client/ui-slots/src/index.ts:23-24
/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}
```

各插件在自己的定义模块中合并专属插槽定义（例如 [`packages/client/ui-layout/src/client/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-layout/src/client/index.ts#L33-L85)）：

```ts
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

这里确立了一条核心设计铁律：**SlotMap 仅声明插槽的结构轴（Kind / Scope）以及父级必须提供的 Owner 属性；插件自身注入的内部业务数据绝不污染全局 SlotMap**。「谁注入的，类型归谁」，保证了全局契约表的极度纯净。

### 3.2 四份额正交交集（Four-Share Intersection）类型系统

一个组件在注册到插槽时，其最终获得的 Props 类型完全由以下五个正交份额的交集构成。阅读 [`packages/client/ui-slots/src/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L442-L451)：

```ts
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

#### 3.2.1 运行时环境份额：`PropsRuntime<K>` 与上下文穿透

`PropsRuntime<K>` 聚合了该插槽所在层级的全部上下文环境：

- 父级在 `renderSlot` 调用处传入的 `OwnerOf<K>`；
- 若插槽为 `session` 作用域，自动合并会话标配套件 `SessionStandardProps`（包含 `sessionId` 以及绑定的 `useSession` 快照 Hook）；
- 若为 `session-maybe` 作用域，自动合并 `SessionMaybeStandardProps`；
- 全局标配套件 `GlobalStandardProps`（如 `useSessions`、`useWorkspaces`）。

#### 3.2.2 子插槽渲染授权份额：`PropsRenderSlots<S>` 与幽灵型变锚点

当组件在其注册选项中声明了 `children` 时，框架会为其合成专属的 `renderSlot` 函数，且该函数的第一个参数 `key` **被静态严格收窄为当前声明的子插槽集合 `S`**。

阅读 [`packages/client/ui-slots/src/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L336-L364)：

```ts
export type PropsRenderSlots<S extends keyof SlotMap & string> = {
  renderSlot: RenderSlotFn<Exclude<S, ChainKeysOf<S>>>;
  readonly __renders?: ((key: S) => void) | undefined;
} & ([ChainKeysOf<S>] extends [never]
  ? object
  : {
      renderSlotChain: <K extends ChainKeysOf<S>>(
        key: K,
        owner: OwnerOf<K>,
        opts?: ChainRenderOpts
      ) => ReactNode;
    }) &
  ('session' extends ScopeOf<S>
    ? { SessionProvider: SessionProviderComponent }
    : object);
```

注意其中的 `readonly __renders?: ((key: S) => void)` 字段。这是一个极其精妙的**幽灵型变锚点（Phantom Variance Anchor）**：

- 在 TypeScript 中，对象方法签名在比较时会发生双向协变宽松匹配；
- 引入一个形如 `(key: S) => void` 的逆变属性位置，能强制 TypeScript 编译器在注册点执行严格的子集包含校验，确保「组件消费的插槽集合必须严格 $\subseteq$ 声明的 `children` 集合」，从根本上封堵了未授权渲染的漏洞。

#### 3.2.3 状态隔离份额：`PropsStore<H>` 与 Draft 剥离

如果注册项关联了一个 Store 工厂，`PropsStore<H>` 会自动推导并注入：

1. `useStore: SnapshotSelectorHook<T>`：类型化的不可变快照读取 Hook；
2. `actions: BakedActions<T, A>`：剥离了 Immer `draft` 参数的纯净调用动作集合。

组件永远看不到底层的状态机实例或 `setState` 原语，只能通过严格受控的 `actions` 变更状态。

#### 3.2.4 业务注入门面份额：`InjectFace<I>` 与响应式 Hooks 映射

插件在注册时可通过 `inject` 工厂返回私有业务门面。若该门面中包含保留字 `hooks: { [name]: HostObservable<T> }`，类型系统与渲染器会在编译期与运行时将其**自动提升并重命名为 `use<Name>` 格式的选择器 Hook**：

```ts
// packages/client/ui-slots/src/index.ts:421-425
export type PropsHooks<HS extends HooksSources> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]: SnapshotSelectorHook<
    HS[N] extends HostObservable<infer T> ? T : never
  >;
};
```

这一元编程映射消除了所有手动编写绑定 Hook 的样板代码。

#### 3.2.5 附属份额：`MatchedShare` 与类型化国际化 `PropsLocale`

- **`MatchedShare`**：仅在 `chain` 形态下生效，将 `select` 纯选择器的非空返回值以 `matched: M` 强类型注入组件；
- **`PropsLocale<N>`**：当注册声明了 `locale: 'sidebar'` 时，自动注入强类型绑定的 `t: TranslateNS<'sidebar'>` 翻译函数，若组件尝试翻译未在字典中声明的键，编译器将直接报错。

### 3.3 类型推断防线与硬化裁定（Hardened Type Invariants）

在 DSH 的类型实现中，包含了多处经过深思熟虑的防卫性设计。

#### 3.3.1 裸函数签名 `SlotComponent<P>` 对抗 `React.FC<P>` 协变噪音

在 [`packages/client/ui-slots/src/index.ts:370`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L370)，组件类型被定义为裸函数签名：

```ts
export type SlotComponent<P> = (props: P) => ReactNode;
```

**裁定原因**：`React.FC<P>` 内部携带了 `defaultProps`、`propTypes` 等历史遗留的静态属性，这些静态属性在 TypeScript 中处于协变（Covariant）位置。在复杂的泛型交集推导中，协变噪音会导致编译器错误地拒绝完全合法的组件实现。采用纯粹的参数逆变（Contravariant）裸函数签名，保证了类型判定的绝对严谨。

#### 3.3.2 `NoInfer<T>` 钉死推断方向，阻绝下游漂移

在 `register` 方法的泛型重载中（[`packages/client/ui-slots/src/index.ts:752-755`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L752-L755)）：

```ts
component: C &
  SlotComponent<
    ComposedProps<
      K,
      NoInfer<EntryKey>,
      keyof NoInfer<D> & keyof SlotMap & string,
      HandleOf<NoInfer<H>>,
      object,
      NoInfer<M>,
      NoInfer<N>
    >
  > &
  RendersCheck<C, D>;
```

**裁定原因**：大量使用 `NoInfer<...>` 将所有推断锚点完全锁定在 `options` 配置对象上。如果不加 `NoInfer`，TypeScript 会试图从传入的 `component` 函数形参反向推导泛型参数，导致一个写错了 Props 的错误组件反向拓宽了系统的泛型推断，使得类型检查失效。

#### 3.3.3 `RendersCheck<C, D>`：声明即认领的静态铁律

```ts
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

如果一个插件在 `children` 选项中声明了子插槽（认领了渲染权），但传入的组件甚至没有在 Props 中声明接收 `renderSlot`，`RendersCheck` 将构造成一个包含显式错误提示信息的非法类型，直接在 VSCode 和 `tsc` 中标红。**声明即认领，认领必渲染**。

---

## 四、 DOM 盒模型与 CSS 零布局污染挂载（`display: contents` 与数据锚点）

### 4.1 传统组件抽象的「包装地狱（Wrapper Hell）」之痛

在复杂的富交互桌面 Web 应用中，微前端或插件化插槽往往会带来一个极其棘手的 CSS 布局灾难：**无休止的包装 `<div>` 容器**。

为了实现错误边界包裹、插槽元数据标记以及事件监听，系统不得不为每一个插槽渲染节点插入一层或多层真实的 HTML 容器。这些额外的 DOM 容器破坏了父级的 CSS Flexbox / CSS Grid 弹性轨道计算，导致：

- 经典的 Flex `gap` 计算错乱；
- Grid 网格项无法直接对齐父级网格轨道（Subgrid 复杂度飙升）；
- 滚动容器判定与 `100%` 高度继承链条频繁断裂。

### 4.2 `<div data-slot={slotKey} style={{ display: 'contents' }}>` 的工程神韵

DSH 在表现层 `web-react` 中给出了一种兼顾**架构自省能力**与**零 CSS 盒模型污染**的极致解法：**全系统统一采用带有 `display: contents` 的数据锚点包装器**。

阅读 [`packages/client/web-react/src/scoped-slots.tsx`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/web-react/src/scoped-slots.tsx#L646-L680)：

```tsx
// packages/client/web-react/src/scoped-slots.tsx:646-680
/**
 * Anchor style shared by every outlet wrapper: `display:contents` keeps the
 * wrapper out of layout (grid/flex parents see the slot's own children), so
 * the anchor is purely addressable surface. Module-level constant — a stable
 * reference so the wrapper never diffs its style prop.
 */
const ANCHOR_STYLE = { display: 'contents' } as const;

function SlotOutlet({
  slotKey,
  ownerProps,
  opts,
}: {
  slotKey: string;
  ownerProps: object;
  opts?: (RenderOpts & ChainRenderOpts) | undefined;
}) {
  const host = useHost();
  useSyncExternalStore(
    (fn) => host.subscribe(slotKey, fn),
    () => host.getVersion(slotKey)
  );
  useLocaleRevision(host.locale);
  const sessionInfo = useSessionMaybeProvideInfo();

  return (
    <div data-slot={slotKey} style={ANCHOR_STYLE}>
      {renderOutletContent(host, slotKey, ownerProps, opts, sessionInfo)}
    </div>
  );
}
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 CSS display: contents 盒模型解除原理示意                    │
│                                                                             │
│  DOM 树层级:                                                                │
│  <div class="app-frame" style="display: grid; grid-template-columns: ...">  │
│    │                                                                        │
│    ├── <div data-slot="sidebar" style="display: contents"> ──┐               │
│    │     └── <aside class="sidebar-root"> ... </aside>       │ 盒模型被解除  │
│    │                                                         ├─────────────►│
│    ├── <div data-slot="conversation" style="display: contents">             │
│    │     └── <main class="conv-root"> ... </main>            │ 内部真实元素  │
│    │                                                         │ 直接参与父级 │
│    └── <div data-slot="details" style="display: contents">   │ Grid 轨道计算│
│          └── <section class="details-pane"> ... </section> ──┘              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 盒模型解除与 CSS Grid / Flex 轨道的原生穿透

根据 W3C CSS Display 规范，设置了 `display: contents` 的元素自身**不会产生任何 CSS 盒模型（Box Model）**，其自身的外边距（margin）、内边距（padding）、边框（border）以及背景均不被绘制，**其所有子元素直接提升为父级布局容器（如 Grid、Flex）的直接子项（Direct Child）**。

在 [`packages/client/ui-layout/src/client/AppFrame.tsx`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-layout/src/client/AppFrame.tsx#L164-L195) 中，整个三栏布局直接依托 CSS Grid：

```tsx
<div
  ref={frameRef}
  className={css.frame}
  style={{
    gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px`,
  }}
>
  <div className={css.sidebarCol}>
    {renderSlot('sidebar', {
      collapsed: sidebarCollapsed,
      width: cols.sidebar,
    })}
  </div>
  <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
  <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
</div>
```

插槽外层的 `<div data-slot="...">` 完全隐形，插槽内部渲染的侧边栏、对话区直接无损贴合到外层网格轨道中，彻底消除了深层嵌套导致的布局错位。

### 4.4 恒定数据锚点与拓扑自省能力

`display: contents` 并没有让 DOM 节点消失。生成的 `<div data-slot="conversation">` 在 DOM 树中依然是一个完全可查询的实体节点：

1. **开发者工具与架构审查**：DevTools Elements 面板可以清晰直观地观察整棵插槽拓扑树的嵌套脉络；
2. **E2E 自动化测试**：Playwright 或 Puppeteer 测试用例无需依赖脆弱的 ClassName，可以直接通过 `page.locator('[data-slot="conversation"]')` 稳定定位业务区域；
3. **动态全局样式穿透**：宿主可以通过属性选择器 `[data-slot="sidebar"] > *` 针对特定插槽区域统一注入上下文样式。

更令人惊叹的是：**这个 `data-slot` 锚点包裹层是在 Outlet 级别常驻渲染的**。无论插槽当前处于「正常渲染」、「回落 Fallback」、「组件崩溃错误页」还是「未声明空白态」，该 DOM 锚点始终稳定存在，绝不会因为插槽内部状态的变动而发生闪烁或 DOM 卸载重建。

### 4.5 模块级常量 `ANCHOR_STYLE` 的引用稳定性优化

注意代码第 652 行的定义：

```ts
const ANCHOR_STYLE = { display: 'contents' } as const;
```

DSH 拒绝在 JSX 中编写内联对象字面量 `style={{ display: 'contents' }}`，而是提取为模块级顶级常量。在 React 的每次 Render 周期中，该 Style 属性的对象引用完全恒定，虚拟 DOM Diff 算法在比较该属性时直接通过 `Object.is` 命中相等跳过，消除了微观上的 GC 压力与属性比对开销。

---

## 五、 微内核三层架构解耦：SlotCore、SlotRegistry 与 Web-React

DSH 的插槽微内核在分层设计上实现了高度的职责隔离，清晰划分为三层架构：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Slot 系统三层解耦架构                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. 表现层 (web-react / scoped-slots.tsx)                                     │
│    - 提供 React 插槽出口组件 (SlotOutlet, RootOutlet)                      │
│    - 基于 uSES (useSyncExternalStore) 订阅不可变版本流                      │
│    - 管理 per-entry 错误边界与 display: contents 锚点                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. 服务层 (runtime / SlotRegistry)                                          │
│    - 继承 Cordis Service，挂载为 ctx.slots                                  │
│    - 绑定调用方 Context Fiber，控制生命周期级联                             │
│    - 桥接 slots/changed 事件总线与声明纪元注入 (slots.inject)                │
│    - 管理 Store 句柄生命周期与多会话实例表                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. 核心层 (ui-slots / SlotCore)                                             │
│    - 纯 TypeScript 数据结构，零 React / Cordis 依赖                         │
│    - 维护全局 SlotRecord 状态账本与单调递增 Version                         │
│    - 执行装载期契约校验与单轴级联注销 (releaseEntry Cascade)                 │
│    - 维护胜者遮蔽算法与崩溃降级 WeakSet (abdicated)                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 纯数据内核：`SlotCore` 的无状态账本与单调版本管理

`SlotCore`（位于 `packages/client/ui-slots`）是一个没有任何外部运行时依赖的纯算法内核。

它内部维护了一个以插槽名为 Key 的 `SlotRecord` 字典（[`packages/client/ui-slots/src/index.ts:614-626`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L614-L626)）：

```ts
interface SlotRecord {
  spec: SlotSpec<SlotEntryDef> | undefined;
  declaredBy: string | undefined;
  parent: string | undefined;
  declarationEpoch: number;
  entries: readonly StoredEntry[];
  version: number;
  listeners: Set<() => void>;
  declarationListeners: Set<() => void>;
}
```

- **单调版本号（Version）**：每次插槽发生注册、注销或崩溃降级时，`rec.version` 同步单调递增，供下游 React `useSyncExternalStore` 进行精准且一致的快照读取；
- **微任务合批（Microtask Batching）**：对于高频的变更订阅者，`SlotCore` 采用 `queueMicrotask` 进行事件合批（`flush()`），确保同一事件循环内的多次连续变更仅触发一次 React 重渲染。

### 5.2 Cordis 运行时绑定：`SlotRegistry` 与 Fiber 上下文路由

`SlotRegistry`（位于 `packages/client/runtime`）作为 Cordis 服务层，负责将纯粹的 `SlotCore` 与 Cordis 插件系统进行深度粘合。

阅读 [`packages/client/runtime/src/client/slots.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/runtime/src/client/slots.ts#L125-L126)：

```ts
// packages/client/runtime/src/client/slots.ts:125-126
declare readonly register: SlotCore['register']
```

以及原型链赋值实现（[`packages/client/runtime/src/client/slots.ts:464-471`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/runtime/src/client/slots.ts#L464-L471)）：

```ts
(
  SlotRegistry.prototype as {
    register: (options: object, component: unknown) => () => void;
  }
).register = function register(
  this: SlotRegistry,
  rawOptions: object,
  component: unknown
): () => void {
  const options = rawOptions as ErasedRegisterOptions;
  return this.ctx.effect(
    () => this['_register'](options, component),
    'slots.register()'
  );
};
```

**工程亮点**：`register` 方法**必须作为原型方法存在，严禁使用实例箭头函数**！
这是因为 Cordis Service 的 Proxy 会在方法调用时，将 `this.ctx` 动态重绑定为**当前调用方插件的特定 Fiber Context**。通过将注销逻辑包裹在 `this.ctx.effect(...)` 中，插件在自身被热重载或卸载时，其注册的所有插槽贡献与声明能够被 Cordis 垃圾回收器自动回收，无需开发者编写任何手动的清理代码。

### 5.3 单轴级联注销（Unload Cascade）与权威失效机制

当一个父级插件被卸载时，其所声明的全部子插槽会触发惊心动魄的**单轴级联销毁（Unload Cascade）**。

阅读 [`packages/client/ui-slots/src/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/index.ts#L1129-L1149)：

```ts
// packages/client/ui-slots/src/index.ts:1129-1149
private releaseEntry(entry: StoredEntry): void {
  if (entry.store !== undefined && typeof entry.store !== 'function') {
    const pinned = this.handleScopes.get(entry.store)
    if (pinned && --pinned.count === 0) this.handleScopes.delete(entry.store)
  }
  if (!entry.children) return
  for (const childKey of Object.keys(entry.children)) {
    const childRec = this.records.get(childKey)
    if (!childRec) continue
    const doomed = childRec.entries
    childRec.spec = undefined
    childRec.declaredBy = undefined
    childRec.parent = undefined
    childRec.declarationEpoch += 1
    childRec.entries = NO_ENTRIES
    this.markDirty(childKey, childRec)
    this.notifyDeclaration(childRec)
    for (const dead of doomed) this.releaseEntry(dead)
  }
}
```

整个级联过程保证了：

1. **无幽灵残留（No Dangling State）**：父 Entry 销毁 $\rightarrow$ 子 Slot 规范清空 $\rightarrow$ 挂载在子 Slot 中的所有子 Entry 递归销毁 $\rightarrow$ 释放对应 Store 引用；
2. **权威失效检测**：若某个外部闭包持有了旧的 `renderSlot` 函数并尝试在卸载后调用，`boundRenderSlot` 中的 `if (!host.isLive(entry))` 会立即触发并抛出 `StaleAuthorizationError`，坚决拒绝对已死亡插槽的渲染。

### 5.4 声明依赖注入（`slots.inject`）与声明纪元（Declaration Epoch）

在动态插件加载架构中，贡献方插件与声明方插件的加载顺序往往是不确定的（可能由于网络延迟或热重载）。

DSH 引入了 `ctx.slots.inject(slotKey, callback)` 与**声明纪元（Declaration Epoch）**机制（[`packages/client/runtime/src/client/slots.ts:143-205`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/runtime/src/client/slots.ts#L143-L205)）：

- 贡献方声明对特定 `slotKey` 的依赖；
- 若该插槽尚未被任何插件声明，回调挂起等待；
- 一旦声明方插件加载并声明了该插槽，`declarationEpoch` 递增，贡献方回调立即同步执行；
- 当声明方热重载（插槽折叠并重新声明）时，纪元再次变化，旧贡献被清理并重新注册；
- 回调支持 Generator Iterable 形式，实现事务性逆序安全拆卸。

### 5.5 单格崩溃隔离与容错遮蔽降级（Abdication）

微内核架构必须具备抵御第三方插件崩溃的强韧性。DSH 设计了细致入微的**单格错误边界与遮蔽退位（Abdication）机制**。

在 [`packages/client/web-react/src/scoped-slots.tsx:317-333`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/web-react/src/scoped-slots.tsx#L317-L333)，每个插槽条目都被独立的 `SlotErrorBoundary` 所包裹：

- 当某个条目在渲染或 `inject` 执行期间抛出异常时，错误被捕获并通过 `host.reportEntryError` 上报；
- **退位降级**：对于 `single`、`keyed`、`list` 等遮蔽形态，崩溃的条目被加入 `SlotCore` 的 `abdicated: WeakSet<StoredEntry>` 中，失去当前格子的胜出资格；
- 插槽版本递增，触发 React 重新计算 `entriesOfSlot`，同格子中次高优先级的存活插件立即接管渲染；
- 若所有注册项均已退位（格子已枯竭），则呈现局部错误占位 `<div data-slot-error={slotKey} />`，**绝不波及整个应用树**。

---

## 六、 会话作用域状态机与 SessionMaybe 领养（Adoption）哲学

### 6.1 作用域三态：`root`、`session-maybe` 与 `session`

DSH 将所有插槽严格划分为三种数据作用域：

1. **`root`**：全局作用域，生命周期跨越整个应用运行期（如侧边栏、全局弹窗）；
2. **`session`**：严格会话作用域，必须在明确存在当前活动会话时才可挂载，组件 Props 强类型获得绝对非空的 `sessionId` 和绑定状态；
3. **`session-maybe`**：会话自适应作用域，同时覆盖「无会话空白欢迎页」与「活动会话对话页」。

### 6.2 `SessionMaybeEntry` 纪元状态机与无损领养机制

`session-maybe` 作用域面临一个经典的前端难题：当用户打开应用时，处于无会话状态；当用户点击新建会话后，首个会话产生。如果简单地通过会话 ID 作为 React Key，会导致整个中间主区域被强制卸载重建，产生明显的 DOM 闪烁。

DSH 在 [`packages/client/web-react/src/scoped-slots.tsx:547-600`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/web-react/src/scoped-slots.tsx#L547-L600) 中设计了极具智慧的**纪元状态机（Adoption State Machine）**：

```tsx
// packages/client/web-react/src/scoped-slots.tsx:555-589
function SessionMaybeEntry({ entry, ownerProps, slotKey, slotInjected, hookContext, hasHookContext }: ...) {
  const info = useSessionMaybeProvideInfo()
  const [state, setState] = useState<MaybeIncarnation>(FIRST_INCARNATION)
  let { adopted, epoch } = state

  if (info.sessionId !== undefined && adopted === undefined) {
    // 状态迁移 1: 领养 (Adoption) — 纪元 epoch 保持不变，不触发 React Remount！
    adopted = info.sessionId
    setState({ adopted, epoch })
  } else if (adopted !== undefined && info.sessionId !== undefined && info.sessionId !== adopted) {
    // 状态迁移 2: 切换到不同会话 — 纪元 epoch + 1，触发重挂载以防数据泄漏
    adopted = info.sessionId
    epoch += 1
    setState({ adopted, epoch })
  } else if (adopted !== undefined && info.sessionId === undefined) {
    // 状态迁移 3: 回落到无会话 — 纪元 epoch + 1，重置为新生状态
    adopted = undefined
    epoch += 1
    setState({ adopted, epoch })
  }

  return (
    <SessionMaybeEntryBody
      key={epoch}
      entry={entry}
      ownerProps={ownerProps}
      info={info}
      slotKey={slotKey}
      slotInjected={slotInjected}
      hookContext={hookContext}
      hasHookContext={hasHookContext}
    />
  )
}
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 SessionMaybeEntry 纪元状态机转换流                          │
│                                                                             │
│                    ┌────────────────────────────────┐                       │
│                    │   初始状态 (First Incarnation) │                       │
│                    │   epoch: 0, adopted: undefined │                       │
│                    └───────────────┬────────────────┘                       │
│                                    │                                        │
│          首个会话产生 (info.sessionId = 's1')                               │
│          执行「领养」: epoch 保持 0 (DOM 实例无损保留)                      │
│                                    ▼                                        │
│                    ┌────────────────────────────────┐                       │
│                    │   已领养状态 (Adopted 's1')    │                       │
│                    │   epoch: 0, adopted: 's1'      │                       │
│                    └───────┬────────────────┬───────┘                       │
│                            │                │                               │
│   切换至新会话 ('s2')       │                │ 关闭会话 (undefined)          │
│   epoch + 1 (强制重挂载)   │                │ epoch + 1 (强制重挂载)        │
│                            ▼                ▼                               │
│       ┌────────────────────────┐        ┌────────────────────────┐          │
│       │  新生纪元 (Adopted 's2')│        │  新生纪元 (Blank State)│          │
│       │  epoch: 1, adopted: 's2│        │  epoch: 1, adopted: un│          │
│       └────────────────────────┘        └────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 领养状态机的三大守恒

1. **初生无缝领养**：从 `undefined` 迁移到首个 `sessionId` 时，`epoch` 保持不变，外层 React Key 不变，DOM 实例与输入焦点平滑保留；
2. **跨会话物理隔离**：从会话 A 切换到会话 B 时，`epoch` 强制递增，触发组件树重挂载，杜绝任何组件内部私有状态跨会话污染；
3. **闭环回落**：从有会话注销至无会话时，`epoch` 再次递增，彻底清理前序会话痕迹。

### 6.3 严格会话边界与跨会话状态泄漏的物理阻隔

对于声明为 `scope: 'session'` 的严格插槽（如右侧详情面板 `details`），若当前没有选中任何会话，系统在 Outlet 层直接短路返回 `null`，根本不会实例化内部组件，在框架层构筑了坚不可摧的安全性物理防线。

---

## 七、 框架级 Store 席位与不可变快照管线

### 7.1 闭包工厂哲学：消灭跨重载幽灵单例

在前端架构中，状态管理最容易犯的错误就是定义模块顶级全局变量（如 `export const useChatStore = create(...)`）。在具备热重载与多会话能力的桌面应用中，模块级单例会在插件重载或单元测试间产生幽灵状态污染。

DSH 在规范中强制确立了**闭包工厂哲学**：**所有插件的 Store 必须声明为工厂函数**（[`packages/client/ui-slots/src/store.ts:98-103`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/src/store.ts#L98-L103)）：

```ts
export type StoreFactory = () => StoreHandle<any, any>;
```

在插件注册时：

- 若为专属 Store，直接传递工厂函数 `store: createLayoutStore`；
- 框架在装载时根据当前插槽的 Scope 为每个会话或每个 Entry 动态调用工厂实例化；
- 严禁任何模块级直接实例导出。

### 7.2 严格读写分离：快照订阅（uSES）与 Immer Draft 写入面

DSH 的状态更新遵循绝对的命令查询分离（CQRS）原则：

1. **只读端（Query）**：组件通过 `useStore(selector)` 订阅状态，底层接入 React 官方的 `useSyncExternalStore`，支持结构共享与相等性短路优化；
2. **写入端（Command）**：组件只能调用 `actions` 中的具名动作，所有动作在底层通过 Immer 进行草稿（Draft）变更，组件代码中没有任何原生的 `setState` 或 `store.update` 逃生舱。

### 7.3 作用域自动绑定与持久化存储生命周期联动

在 [`packages/client/runtime/src/client/slots.ts:423-436`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/runtime/src/client/slots.ts#L423-L436)，`SlotRegistry` 自动管理 Store 实例在生命周期轴上的存亡：

- 对于 `session` 级 Store，持久化 LocalStorage Key 自动按 `sessionId` 分片隔离；
- 当用户删除某个会话时，`pruneStoreScope(sessionId)` 自动被调用，精准清理该会话所占用的全部内存 Store 实例与底层持久化键值，不留任何存储垃圾。

---

## 八、 真实源码证据链全景剖析

### 8.1 `ui-layout`：AppFrame 自举与四插槽矩阵声明

阅读 [`packages/client/ui-layout/src/client/index.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-layout/src/client/index.ts#L120-L137)，查看系统根布局是如何一次性完成子插槽声明、独占 Store 挂载与业务门面注入的：

```ts
// packages/client/ui-layout/src/client/index.ts:120-137
const disposeRegistration = ctx.slots.register(
  {
    name: 'root',
    children: {
      sidebar: { kind: 'single', scope: 'root' },
      conversation: { kind: 'single', scope: 'session-maybe' },
      details: { kind: 'single', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
    // Exclusive store: the factory itself — the framework instantiates per
    // entry and delivers useStore/actions to AppFrame as standard props.
    store: createLayoutStore,
    // The hook's only side effect connects the root store to ctx.layout;
    // conversation business actions belong to their registrants.
    inject: (actions: PanelActions) => {
      layout.attachPanels(actions);
      return {};
    },
  },
  AppFrame
);
```

在这一次简洁优雅的调用中：

1. 认领了先验的 `'root'` 插槽；
2. 声明并独占了 `'sidebar'`、`'conversation'`、`'details'`、`'shell.overlay'` 四大子插槽的渲染权；
3. 将面板尺寸状态机 `createLayoutStore` 注入为标准 Store 席位；
4. 通过 `inject` 将 Store 的 `actions` 绑定到全局 `ctx.layout` 协调服务上。

### 8.2 `ui-conversation`：会话主干、动态多态 Chat 节点与接管链

阅读 [`packages/client/ui-conversation/src/client/contract/slots.ts`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-conversation/src/client/contract/slots.ts#L78-L133)，可以看到对话域中插槽形态的登峰造极运用：

```ts
// 1. Keyed 形态的 Chat 节点：支持任意第三方插件扩展新节点类型
'conversation.chat.node': {
  kind: 'keyed'
  scope: 'session'
  owner: ChatNodeOwnerProps
  keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
  hookContext: string
  inject: ChatNodeTurnDataInjected
}

// 2. Chain 形态的尾部扩展链：纯函数自荐，零挂载开销
'conversation.chat.turnTail': {
  kind: 'chain'
  scope: 'session'
  owner: TurnTailOwnerProps
}

// 3. Chain 形态的输入框接管链：支持非卸载式草稿保活
'conversation.composer': {
  kind: 'chain'
  scope: 'session'
  owner: ComposerChainProps
}
```

### 8.3 编译期类型防御与单元测试验证链

阅读 [`packages/client/ui-slots/tests/type-chain.client.spec.tsx`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-slots/tests/type-chain.client.spec.tsx#L190-L248)，可以观察到 DSH 是如何通过编译期负样本（Negative Compile-Time Tests）牢牢守住架构红线的：

```tsx
// 负样本 1: 声明子插槽的 Scope 与全局 SlotMap 契约不一致
core.register(
  {
    name: 'chain.frame',
    // @ts-expect-error chain.conv is session-scoped in SlotMap
    children: { 'chain.conv': { kind: 'single', scope: 'root' } },
  },
  (() => null) as SlotComponent<never>
);

// 负样本 2: 组件试图消费未在 children 中声明的插槽
// @ts-expect-error component renderSlot keys exceed the declaration
core.register(
  {
    name: 'chain.frame',
    children: { 'chain.side': { kind: 'single', scope: 'root' } },
  },
  Over
);

// 负样本 3: 组件声明了 children 但内部未消费 renderSlot (认领不渲染)
// @ts-expect-error children declared, component consumes no renderSlot
core.register(
  {
    name: 'chain.frame',
    children: { 'chain.side': { kind: 'single', scope: 'root' } },
  },
  Blind
);

// 负样本 4: Chain 注册缺少 mandatory 的 select 纯选择器
// @ts-expect-error chain registration requires options.select
core.register({ name: 'chain.takeover' }, Takeover);
```

这些测试不依赖任何运行时断言，全部在 TypeScript 编译阶段通过 `@ts-expect-error` 锁定，确保未来的任何代码修改都无法破坏这套坚固的类型契约。

---

## 九、 总结与工程启示录

DeepSeek-Harness 的 SlotMap 微内核插槽体系为现代复杂桌面端 Web 应用的设计树立了崭新的工程标杆。它所展现的美学特质可以凝练为以下四点深刻启示：

1. **绝对的极简与收敛**：
   通过确立「先验 `'root'`」与「单一 `register`」，消灭了传统前端架构中混乱的概念膨胀。声明、授权、运行时规范、状态席位与业务注入在单一调用点完成闭环，让整座系统的拓扑流向变得一目了然、极易审计。
2. **纯粹的数学与类型代数**：
   将 UI 拓扑归纳为四大正交插槽形态（Single、List、Keyed、Chain），并利用 TypeScript 声明合并与五大正交份额（ComposedProps）在编译期实现了无缝的类型交集推导。配合 `NoInfer` 与幽灵型变检查，构筑了固若金汤的编译期安全网。
3. **对底层平台的极致尊重**：
   拒绝滥用 DOM 包装层，全系统贯穿 `<div data-slot style={{ display: 'contents' }}>`。在赋予应用极致的拓扑自省能力的同时，对 CSS 盒模型与原生 Flex/Grid 布局引擎保持了零侵入、零污染的敬畏。
4. **生命周期与容错的工业级闭环**：
   借助单轴级联注销（Unload Cascade）、声明纪元（Declaration Epoch）、单格错误退位（Abdication）以及会话领养状态机（Session Adoption），使动态插件系统具备了坚如磐石的容灾能力与毫秒级热替换体验。

这套设计不仅是一套高性能的插槽注册引擎，更是一篇写给现代前端工程的声明式架构宣言。
