# Conex (Crish) vs DeepSeek Harness (dsh) 内核架构与插件扩展体系代码级深度审计对比报告

> **审计性质**：纯源码级技术架构与扩展机制深度审计（零引用非代码文档，纯透视代码实现）。  
> **对比双方**：
> - **Conex (Crish)**：基于 Rust 内核状态机 + 异步执行器 + 强类型契约的工业级 Agent 系统。
> - **DeepSeek Harness (dsh)**：基于 TypeScript + Cordis 微内核 + 响应式 Scope/Fiber 体系的微内核 Agent 平台。  
> **审计日期**：2026-09-12  
> **文件编码**：UTF-8 无 BOM

---

## 目录
1. [审计基准与源码对标路径](#一审计基准与源码对标路径)
2. [对象模型与架构哲学对比](#二对象模型与架构哲学对比)
3. [生命周期与状态驱动对比](#三生命周期与状态驱动对比)
4. [服务注入与控制反转对比](#四服务注入与控制反转对比)
5. [扩展机制与插件生态对比](#五扩展机制与插件生态对比)
6. [副作用撤销与资源析构对比](#六副作用撤销与资源析构对比)
7. [编译期守卫 vs 运行时防御对比](#七编译期守卫-vs-运行时防御对比)
8. [内存模型、分配开销与性能对比](#八内存模型分配开销与性能对比)
9. [优劣终审与高下裁决](#九优劣终审与高下裁决)
10. [双方代码级破绽与技术债务深度检视](#十双方代码级破绽与技术债务深度检视)
11. [吸收借鉴方案与架构演进蓝图](#十一吸收借鉴方案与架构演进蓝图)

---

## 一、审计基准与源码对标路径

本次审计严格限定于底层源码实现，不采信任何概念宣传或外围说明文档。所有论断均建立在以下对标源码的具体行号与数据流分析之上：

### 1. Conex 侧代码基准
- **内核循环装配面**：`crates/session-loop/src/loop/loop_runner.rs`
- **内核循环执行面**：`crates/session-loop/src/loop/loop_exec.rs`
- **会话状态机内核**：`crates/session-loop/src/state.rs`
- **核心类型与协议真源**：`crates/conex-types/src/lib.rs`、`session.rs`、`transition.rs`、`events.rs`
- **工具批执行与调度**：`crates/session-loop/src/tool_exec.rs`、`crates/session-loop/src/loop/handlers/executing_tools.rs`
- **插件钩子分派运行时**：`crates/session-loop/src/hooks.rs`
- **工具注册表与运行时门面**：`crates/agent-tools/src/registry.rs`
- **插件跨端契约与事件全集**：`packages/shared-types/src/plugin.ts`、`packages/shared-types/src/hooks.ts`
- **插件系统演进断层记录**：Git 提交 `25762dc10b`（`packages/plugin-sdk/` 历史实现全景）

### 2. DSH 侧代码基准
- **Agent 循环核心服务**：`reference/deepseek-harness/packages/core/agent-loop/src/index.ts`
- **Agent 执行驱动器**：`reference/deepseek-harness/packages/core/agent-loop/src/agent.ts`
- **工具调度与并发栅栏**：`reference/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts`
- **分层作用域与生命周期核心**：`reference/deepseek-harness/packages/core/scope/src/index.ts`、`store.ts`
- **基础微内核 Bundle 装配**：`reference/deepseek-harness/packages/bundle/base/cordis.patch.yml`、`src/index.ts`
- **系统提示词动态装配与分层**：`reference/deepseek-harness/packages/core/system-prompt/src/index.ts`
- **分层配置管理与动态观察服务**：`reference/deepseek-harness/packages/settings/settings/src/index.ts`
- **Agent 事件作用域派发桥**：`reference/deepseek-harness/packages/core/agent/src/dispatch.ts`

---

## 二、对象模型与架构哲学对比

```
Conex (Data-Oriented & Pure FSM):
[AgentMessage] ──> [AgentSessionLoop] ──> [AgentSessionMachine]
                           │                     │
                    (LoopState)           (apply_transition)
                           │                     │
                ┌──────────┴──────────┐          ▼
           [ToolExecutor]      [HookRegistry]  8-State Exhaustive Table

DSH (Actor-Fiber & Microkernel IOC):
[Context (Root)] ──> [createScope(Key)] ──> [ScopedLayers]
       │                    │                     │
(Cordis Service)     [ReactLoopAgent]       (WeakMap Ancestry)
       │                    │                     │
[AgentLoop Service] ─> Phase State (3)    generator yield* (Effect Undo)
```

### 1. Conex：数据驱动（DOD）与纯函数式状态机
Conex 将「状态与计算完全解耦」贯穿于整个内核：
- **纯状态机引擎**：`crates/session-loop/src/state.rs:24-27` 定义了 `AgentSessionMachine`，它仅包含两个字段：`state: AgentSessionState` 和 `context: AgentSessionContext`。
- **纯函数转移律**：状态推进完全委托给 `crates/conex-types/src/transition.rs:89-92` 的 `apply_transition(state, event)` 纯函数。转移表中没有隐式指针跳转或异步回调，仅输出一个纯值对象 `AgentTransition`（包含目标状态 `to`、收场原因 `end_reason`、上下文计数变化 `effect`）。
- **对象装配聚合**：`crates/session-loop/src/loop/loop_runner.rs:28-47` 定义的 `AgentSessionLoop` 结构体是一个扁平显式的主管结构，持有 `state: LoopState`、`provider: Box<dyn ProviderCall>`、`tool_executor: ToolExecutor`、`approval: Option<Arc<dyn ApprovalGate>>` 等。所有运行时实体均通过 `Arc` 显式共享。

### 2. DSH：微内核面向对象与 Actor/Fiber 架构
DSH 建立在 Cordis 微内核生态之上，推崇「服务即上下文，实体即 Actor」：
- **微内核插件服务**：`packages/core/agent-loop/src/index.ts:359` 定义 `export class AgentLoop extends Service implements AgentFactory`，通过继承 Cordis `Service` 直接注入到全局 `Context` 中。
- **Agent 作为独立 Scope Actor**：在 `packages/core/agent-loop/src/agent.ts:72-105` 中，`ReactLoopAgent` 是一个富状态对象，并在构造器中通过 `this.scope = createScope(loopCtx, this)`（第 104 行）为自身 mint 一个绑定的 Cordis 上下文 `this.ctx = this.scope.ctx`。
- **极简 Phase 状态**：与 Conex 严格的 8 态相比，DSH 在 `packages/core/agent-loop/src/agent.ts:41-50` 仅定义了一个极其粗粒度的联合类型 `Phase`：
  ```ts
  type Phase =
    | { kind: 'idle'; lastTurn: number }
    | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
    | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
  ```
  其内部状态仅有 `idle`、`maintenance`、`running` 三种，状态转移仅通过私有方法 `setPhase`（第 119-126 行）直接赋值并触发 `agent/status` 事件。

### 3. 代码架构哲学对比总结
- **Conex**：典型 Rust 工业级系统架构——状态机强健、内存紧凑、零隐式依赖、编译期严密排错。
- **DSH**：典型现代 TypeScript 微内核框架——高度模块化、元编程能力极强、上下文感知依赖注入，但对象内部隐藏了复杂的闭包、Fiber 与动态弱引用。

---

## 三、生命周期与状态驱动对比

### 1. Conex：形式化状态机与确定性转移
Conex 的执行循环完全受控于严谨的有限状态自动机（FSM）：
- **8 态与 20 事件穷举**：`crates/conex-types/src/session.rs:17-34` 定义了 8 个状态（`Idle`、`AwaitingInput`、`PreparingTurn`、`Streaming`、`SteeringEvaluation`、`ExecutingTools`、`TurnComplete`、`Done`）；第 41-82 行定义了 20 个强类型事件。
- **未定义转移显式拒绝**：`crates/conex-types/src/transition.rs:77-82` 规定任何未明确在表中声明的 `(state, event)` 转移均直接抛出 `TransitionError::Undefined`，绝不发生静默退避或降级：
  ```rust
  // crates/conex-types/src/transition.rs:77-78
  #[error("未定义转移：{state:?} + {event:?}")]
  Undefined { state: AgentSessionState, event: AgentSessionEvent },
  ```
- **原子分派与收场收敛**：`crates/session-loop/src/loop/loop_exec.rs:136-152` 的 `while !self.state.machine.is_done()` 循环中，每次通过 `dispatch_once()`（第 165-198 行）根据当前状态分派到具体的子 handler（如 `handlers::streaming::handle`、`handlers::executing_tools::handle`）。
- **孤儿 Turn 防御闭合**：在 `crates/session-loop/src/loop/loop_exec.rs:309` 的 `converge()` 收口函数中，强制调用 `handlers::emit_missing_turn_end(&mut self.state)`，确保无论何种异常收尾，生命周期事件流必须绝对对称闭合。

### 2. DSH：异步迭代协程与微任务调度驱动
DSH 摒弃了刚性状态转移表，转而使用典型的 async/await 生成式协程循环：
- **Turn/Step 双重异步循环**：`packages/core/agent-loop/src/agent.ts:225-238` 中的 `kick()` 方法启动核心驱动器：
  ```ts
  // packages/core/agent-loop/src/agent.ts:227
  while (await this.turn()) {}
  ```
  而在 `turn()` 方法内部（第 286-321 行），通过一个无限 `while (true)` 循环驱动每一个 `step`：
  ```ts
  // packages/core/agent-loop/src/agent.ts:307
  const stepEnd = await this.step(decision)
  ```
- **多主信号熔断器**：DSH 在生命周期管理中极为注重优雅停机。在 `packages/core/agent-loop/src/index.ts:558-567` 中，通过 `AbortController` 将三个不同维度的控制源进行熔断熔接：
  1. 调用方的取消信号 `callerSignal`；
  2. 宿主 Fiber 的卸载信号 `ownerCtx.fiber`；
  3. 工厂本身的停机信号 `this.ownership.signal`。
- **双轨输入消费**：通过 `ReactLoopInbox`（`packages/core/agent-loop/src/inbox.ts`）区分 `next-turn` 与 `next-step`，配合 `preStep`（`agent.ts:240-259`）在 step 边界动态消费 context 与 claimed messages。

### 3. 生命周期裁决
- **状态转移安全性**：**Conex 压倒性胜出**。Conex 的 8 态 20 事件穷举表使得任何逻辑漂移在开发和测试期即可被形式化截获；DSH 仅依靠一个布尔循环与 `Phase` 变量，状态边界模糊，非法状态流转只能依靠代码分支防御。
- **取消与停机协同度**：**DSH 更为细腻**。DSH 的 `FactoryOwnership`（`agent-loop/src/index.ts:97-147`）结合 `raceAbortCall`，能够完美跟踪每个 live agent 的析构状态并等待其写入流安全落盘，避免了硬性终止导致的持久化破损。

---

## 四、服务注入与控制反转对比

### 1. Conex：编译期显式 Builder 注入
Conex 严格遵循 Rust 的零成本抽象与编译期显式装配原则：
- **显式装配流水线**：在 `crates/session-loop/src/loop/loop_runner.rs:54-112` 中，`AgentSessionLoop::new` 强制要求传入核心依赖：
  ```rust
  // crates/session-loop/src/loop/loop_runner.rs:54-60
  pub fn new(
      session_id: impl Into<String>,
      run_id: impl Into<String>,
      max_turns: u32,
      provider: Box<dyn ProviderCall>,
      tool_registry: Arc<ToolRegistry>,
  ) -> Self
  ```
- **链式配置同步**：通过 `with_options`（第 127-217 行）完成四线装配（写路径互斥表 `WritePathRegistry`、探索配额 `ExploreDocsQuotaContext`、中间件链 `tool_middleware`、逃逸判定器）。
- **静态类型抹除边界**：依赖接口完全限定为 `Arc<dyn ApprovalGate>`、`Box<dyn ProviderCall>`、`Arc<dyn DeltaSink>`。依赖关系在编译期确立，不存在运行时类型查找失败的风险。

### 2. DSH：Cordis 响应式服务容器与依赖图
DSH 展现了极高水平的 IOC 容器设计：
- **服务声明与静态注入**：在 `packages/core/agent-loop/src/index.ts:360` 中，服务通过静态属性显式声明依赖契约：
  ```ts
  // packages/core/agent-loop/src/index.ts:360
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']
  ```
- **服务总线动态绑定**：当容器启动时，Cordis 会自动拓扑排序并注入服务。在运行期，任何组件均可通过 `ctx.systemPrompt`、`ctx.llm`、`ctx.tools` 访问已就绪的服务。
- **生命周期挂载 Generator**：如 `packages/settings/settings/src/index.ts:359-369`：
  ```ts
  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.stopped = true
      await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails])
    }
    this.publish(await this.load())
  }
  ```
  服务初始化是一个异步生成器，通过 `yield` 返回的闭包即为其析构器。

### 3. 服务注入裁决
- **可维护性与确定性**：**Conex 占优**。Conex 没有全局服务定位器（Service Locator）的反模式，所有依赖顺着调用栈传递，易于进行单元测试和局部推理。
- **模块解耦与灵活性**：**DSH 明显占优**。DSH 的 Cordis 服务体系实现了真正的插件化插拔。任何一个模块（例如换用不同的 LLM 驱动器或会话持久化后端）只需在 `cordis.patch.yml` 中替换对应插件行，而无需重新改写组装代码。

---

## 五、扩展机制与插件生态对比

### 1. Conex：双轨演进收敛后的 Hook + Middleware 体系
Conex 经历了重大的插件架构调整（Git `25762dc10b` 删除 `packages/plugin-sdk/` 原有 51 个文件），其扩展性架构目前由以下核心构成：
- **14 种冻结 Hook 事件**：在 `crates/session-loop/src/hooks.rs:104-119` 与 `packages/shared-types/src/hooks.ts:40-55` 中双向硬锁定了 14 个事件名：
  `turn.start`、`turn.end`、`tool.pre`、`tool.post`、`context.compact.start`、`context.compact.end`、`session.start`、`session.end`、`model.beforeRequest`、`model.afterResponse`、`subagent.start`、`subagent.end`、`error.occurred`、`tool.error`。
- **双模式分派与正则过滤**：
  - `HookMode::Observe`：广播模式，失败按策略吞掉，不影响主干执行（`crates/session-loop/src/hooks.rs:307-308`）。
  - `HookMode::On`：串行模式，允许 handler 返回 `HookAction::Block { reason }` 实施拦截（第 309-311 行）。
  - 支持 `matcher: Option<Regex>`（第 499-505 行），仅针对匹配特定工具名称的调用触发 Hook。
- **中间件执行管线优先级裁决**：
  在 `crates/session-loop/src/tool_exec.rs:32-37` 中严格规定了执行管线顺序：
  $$\text{权限判定} \longrightarrow \text{审批门} \longrightarrow \text{Middleware before 链} \longrightarrow \text{Hook tool.pre} \longrightarrow \text{工具执行} \longrightarrow \text{Hook tool.post} \longrightarrow \text{Middleware on\_result 链}$$
  此顺序确保中间件无法绕过安全审批，架构边界极其分明。

### 2. DSH：微内核分层 Scope、Waterfall 流水线与三层配置体系
DSH 的可扩展性是其整个系统的精髓所在：
- **`ScopedLayers` 作用域覆盖模型**：
  在 `packages/core/scope/src/store.ts:159-267` 中实现。支持全局层（`global`）与按 `ScopeKey`（Agent 实例）隔离的分层覆盖：
  ```ts
  // packages/core/scope/src/store.ts:192-199
  chainLayers(scope: ScopeKey | undefined): L[] {
    const layers: L[] = []
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }
  ```
  子 Agent 可以沿着 `scopeChainOf` 继承父级的动态上下文，最近作用域的配置与 Hook 具有最高优先权。
- **事件分派的多态模型（Emit / Serial / Waterfall）**：
  在 `packages/core/agent/src/dispatch.ts:54-82` 中，支持三种完全不同的扩展机制：
  - `emit`：fire-and-forget 广播通知；
  - `serial`：顺序执行，遇第一个返回值熔断；
  - `waterfall`：同 Koa/Express 的洋葱圈洋葱中间件流水线，参数中带 `next`，插件可篡改上下文并控制是否放行。
- **动态 System Prompt 装配器**：
  在 `packages/core/system-prompt/src/index.ts:448-540` 中，提示词由多个 `PromptSection`（按 `order` 排序）、`PromptContext`、`ToolProvider` 和 `VariableProvider` 动态汇聚而成。支持 `{{variable}}` 强变量插值，支持 `complete: true` 独占覆盖。
- **三层配置合并体系（Schema -> Base -> User）**：
  在 `packages/settings/settings/src/index.ts:287-295` 中，配置项由「Schema 默认值」、「模块声明的 Base 组合配置」与「用户持久化 Document」进行深度对象合并，并提供细粒度的 `watch()` 管道监听。

### 3. 扩展体系裁决
- **扩展性深度与架构美感**：**DSH 完胜**。DSH 的 Scope 分层与 Waterfall 洋葱模型允许插件在完全不修改核心代码的情况下，精细拦截从 Prompt 拼装、模型选路到工具并发度的每一个决策点。Conex 目前缺少 TS 侧插件宿主，主要扩展点集中在 Rust 侧硬编码的 Hook 与中间件上。

---

## 六、副作用撤销与资源析构对比

### 1. Conex：静态防御与撤销缺失
Conex 在防止单次破坏性操作上做了极强的物理防御，但在扩展机制的动态撤销上存在架构断层：
- **写前自动备份**：`crates/agent-tools/src/backup.rs` 实现了删除或覆盖文件前强制将快照写入 `.crish-trash` 回收站。
- **路径排他锁**：`crates/agent-tools/src/write_paths.rs:459-469` 在多 Agent 并行时提供文件写锁互斥。
- **【严重缺陷】注册表无撤销 API**：
  查阅 `crates/agent-tools/src/registry.rs:37-85`，`ToolRegistry` 仅有 `register` 和 `register_runtime`，**根本没有 `unregister` 或 `remove` 方法**！
  查阅 `crates/session-loop/src/hooks.rs:435-522`，`HookRegistry` 仅有 `register` 和 `register_with`，内部通过 `RwLock<Vec<HandlerEntry>>` 存储，**同样没有任何注销特定 Hook 的机制**！
  这意味着在 Conex 中，一旦注册了某个工具或 Hook，除非彻底析构整个进程或 Loop，否则无法单体撤销！

### 2. DSH：数学般严格的生成器可逆副作用撤销
DSH 的副作用撤销机制是其最惊艳的设计：
- **Generator Yield Undo 模式**：
  在 `packages/core/scope/src/store.ts:226-267` 的 `ScopedLayers.effect` 中：
  ```ts
  // packages/core/scope/src/store.ts:233-263
  const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
    let layer: L
    // ... 获取或创建对应 Scope 的 Layer
    let undo: () => void
    try {
      undo = action(layer) // 执行变更并返回精准撤销闭包
    } catch (error) {
      if (scope !== undefined && created && layer.isEmpty()) this.scoped.delete(scope)
      throw error
    }

    yield () => {
      undo() // 卸载时精准撤销该变更
      if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
      if (notify) this.onChange()
    }
    if (notify) this.onChange()
  }.bind(this), options.label)
  ```
  在 DSH 中，每一次向注册表（无论是 `NamedEntries` 还是 `AnonymousEntries`）插入条目，都必须返回一个幂等的 `undo` 函数（见 `store.ts:48-53`）。当所属的 Fiber、插件或 Agent 析构时，Cordis 会自动回卷生成器并执行 `yield` 后面的函数，完成内存的自动擦除与反向通知。
- **静默 Quiescence 等待**：
  在 `packages/core/scope/src/index.ts:115-118` 的 `quiesceFiber` 中：
  ```ts
  async function quiesceFiber(fiber: Fiber): Promise<void> {
    await Promise.resolve(fiber.dispose())
    while (fiber.inertia !== undefined) await fiber.inertia
  }
  ```
  严格等待所有异步任务惯性消除，杜绝幽灵任务继续运行。

### 3. 副作用撤销裁决
- **裁决**：**DSH 完胜**。DSH 将副作用注册与撤销绑定在单一生成器生命周期内，实现了真正的无损热插拔与内存无泄漏；Conex 在运行时注册表层面缺乏注销能力，属于典型的单向累加型设计。

---

## 七、编译期守卫 vs 运行时防御对比

### 1. Conex：编译期铁律与静态排错
Conex 贯彻了 Rust 社区将运行时隐患前移至编译期的至高准则：
- **状态转移穷举匹配**：`apply_transition` 中的 `match (state, event)` 覆盖全部枚举分支。新增任何状态或事件，编译器都会强制要求补齐所有转移分支。
- **多线程无数据竞争保证**：`crates/session-loop/src/hooks.rs:376` 要求 `pub trait HookHandler: Send + Sync`。Rust 静态借用检查器（Borrow Checker）杜绝了任何跨线程并发写冲突。
- **跨层双向契约锁定**：
  在 `crates/conex-types/tests/event_hook_mapping.rs` 中，编写了双向断言测试，强制保证 Rust 端 14 个 `HookEventKind` 与前端 TS 端 `packages/shared-types/src/hooks.ts` 的 `HOOK_EVENT_NAMES` 字符值逐字对齐。任一方改动未同步，编译/构建门禁立即阻断。

### 2. DSH：运行时 Schema 动态防御
DSH 运行在 JavaScript 这一动态弱类型环境中，所有安全边界完全靠运行时代码构筑：
- **Schemastery & Zod 运行时多重校验**：在 `packages/core/agent-loop/src/index.ts:45-53`、`363-375` 中大量使用 Schema 校验传入数据。
- **对象深冻结防御**：
  在 `packages/core/agent-loop/src/agent.ts:520` 中，必须显式调用 `deepFreeze(structuredClone(...))` 来防止下游插件篡改请求配置。
- **动态字符串正则检查**：在 `packages/settings/settings/src/index.ts:38-43` 中，每个命名空间必须在运行时使用正则表达式 `NAMESPACE_PATTERN.test(value)` 校验是否合规。

### 3. 防御模式裁决
- **裁决**：**Conex 完胜**。Conex 的安全性由 Rust 编译器和类型系统在编译期直接担保，零运行时性能损耗；DSH 必须在每个关键路径上执行大量的 `deepFreeze`、`structuredClone`、正则验证与 Schema 校验，既增加了运行时开销，又无法杜绝类型擦除后引发的隐式异常。

---

## 八、内存模型、分配开销与性能对比

### 1. Conex：零拷贝、紧凑内存布局与极致吞吐
- **$O(1)$ 零拷贝数据移交**：
  在 `crates/session-loop/src/loop/loop_exec.rs:334-350` 的 `converge` 函数中：
  ```rust
  // crates/session-loop/src/loop/loop_exec.rs:334-335
  messages: std::mem::take(&mut self.state.conversation),
  events: std::mem::take(&mut self.state.events),
  ```
  Conex 利用 Rust 的 `std::mem::take` 原语，将几十甚至上百兆的历史会话消息与事件序列以指针交换的代价瞬时移交，彻底消除了深拷贝开销。
- **Arc 共享不可变状态**：整个会话历史记录存储为 `Vec<Arc<AgentMessage>>`（`crates/session-loop/src/loop/loop_runner.rs:268`），在多处派发和持久化中仅增加原子引用计数（8 字节），内存足迹极小。
- **高并发原子计数器**：在 `crates/session-loop/src/tool_exec.rs:138-158` 中，使用 `AtomicUsize`（`active` 与 `peak`）实现纳秒级的并发监控，无锁开销。

### 2. DSH：V8 托管堆、GC 抖动与频繁深克隆
- **昂贵的内存深克隆**：
  为了保证配置不变性，DSH 频繁调用 `structuredClone(this.requestHeaderLogged ? ...)` 与 `deepFreeze`（`packages/core/agent-loop/src/agent.ts:520`），在长会话中产生大量临时堆对象。
- **WeakMap 内存链查找开销**：
  DSH 的 Scope 体系高度依赖全局 `WeakMap<ScopeKey, ScopeKey>`（`packages/core/scope/src/index.ts:39`）。每次事件分派或层级查找时，必须在堆上反复遍历 WeakMap 原型链（`scopeChainOf`，第 98-102 行）。
- **Promise 包装与微任务队列压力**：
  在 `packages/core/agent-loop/src/tool-calls.ts:163-231` 中，使用 `Map<number, Promise<number>>` 维护在途工具调用，并发调度交织着大量的 `Promise.race` 和闭包实例化，会给 V8 引擎的垃圾回收器（Scavenge / Mark-Sweep）带来沉重的处理负荷。

### 3. 性能与内存裁决
- **裁决**：**Conex 压倒性完胜**。在处理超长上下文、密集工具并发及长时间稳定运行场景下，Conex 的原生无 GC 内存架构展现出无可比拟的性能优势；DSH 在极端高并发与大数据量吞吐下存在显而易见的 GC 停顿与内存膨胀风险。

---

## 九、优劣终审与高下裁决

| 比较维度 | Conex (Crish) 得分 | DeepSeek Harness 得分 | 胜出方 | 核心裁决依据 |
| :--- | :---: | :---: | :---: | :--- |
| **1. 状态机与确定性** | **9.8** / 10 | 6.5 / 10 | **Conex** | Conex 具备严格的 8 态 20 事件穷举有限状态自动机，非法转移绝对拒绝；DSH 仅为 3 态松散布尔驱动。 |
| **2. 并发性能与内存开销** | **9.5** / 10 | 6.0 / 10 | **Conex** | Conex 原生 Rust 零拷贝（`mem::take`）、`Arc` 不可变共享、无 GC；DSH 依赖大量深克隆与 V8 微任务。 |
| **3. 编译期安全性** | **9.9** / 10 | 5.5 / 10 | **Conex** | Conex 在编译期由借用检查与跨语言测试双向闭环；DSH 依赖动态运行时 Schema 拦截与类型断言。 |
| **4. 插件解耦与微内核体系** | 6.0 / 10 | **9.8** / 10 | **DSH** | DSH 的 Cordis 服务容器、声明式 Bundle (`cordis.patch.yml`) 实现了真正极致的插件可插拔性。 |
| **5. 作用域分层与上下文继承**| 6.5 / 10 | **9.5** / 10 | **DSH** | DSH 的 `ScopedLayers` 和 `scopeChainOf` 实现了近乎完美的多 Agent 上下文分层覆盖与继承。 |
| **6. 副作用撤销与优雅停机** | 5.5 / 10 | **9.2** / 10 | **DSH** | DSH 采用生成器 `yield undo` 实现对偶式逆向注销；Conex 的 `ToolRegistry` 和 `HookRegistry` 缺乏注销机制。 |
| **7. 工具拦截流水线** | 8.0 / 10 | **9.0** / 10 | **DSH** | DSH 具备原生的洋葱圈 `waterfall` 流水线；Conex 虽有明确优先级，但主要为静态固定点位。 |
| **8. 容错恢复与错误重入护栏**| **9.0** / 10 | 8.0 / 10 | **Conex** | Conex 的恢复阶梯（D1/D2/D7/D9）、错误事件化防止级联循环（`error_eventing`）设计严密。 |

### 综合架构终审裁决
- **底层引擎与可靠性基石**：**Conex (Crish) 明显优于 DSH**。在作为一个严肃的本地/桌面工业级 Agent 宿主时，Conex 的 Rust 内核提供了无可挑剔的崩溃免疫力、确定性行为和极致性能。
- **可扩展性与插件生态架构**：**DeepSeek Harness (dsh) 明显优于 Conex**。DSH 的 Cordis 插件体系、动态 Scope 分层及生成器反向注销机制，代表了目前应用级 TypeScript 平台架构设计的最高水准。

---

## 十、双方代码级破绽与技术债务深度检视

### 1. DeepSeek Harness (dsh) 侧具体代码破绽与技术债务

#### ① 原型污染风险（Prototype Pollution）
- **精确位置**：`reference/deepseek-harness/packages/settings/settings/src/index.ts:265-266`
- **代码现场证据**：
  ```ts
  // packages/settings/settings/src/index.ts:265-267
  // TODO(settings-json-properties): Use property-safe construction here and
  // in mergeLayers so valid JSON keys such as "__proto__" remain own data.
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
  ```
- **破绽实质**：代码注释中白纸黑字承认未采用属性安全的字典构造（如 `Object.create(null)`）。当合并恶意外部传入的 JSON 补丁时，`__proto__` 键值会污染对象的原型链，构成潜在的安全漏洞。

#### ② 注册观察者逃逸与内存泄漏（Registration Quiescence Leak）
- **精确位置**：`reference/deepseek-harness/packages/settings/settings/src/index.ts:442-445`
- **代码现场证据**：
  ```ts
  // packages/settings/settings/src/index.ts:442-445
  this.ctx.effect(() => {
    this.registrations.set(parsedNs, registration)
    // TODO(settings-registration-quiescence): Deactivate every watcher and await
    // its tail on disposal so callbacks cannot outlive the registrant fiber.
    return () => this.registrations.delete(parsedNs)
  }, `settings.register(${JSON.stringify(String(parsedNs))})`)
  ```
- **破绽实质**：当某个插件的 Fiber 被卸载时，析构器只删除了命名空间映射，**没有去注销其持有的各个 watcher，更没有 await 异步执行尾部（tail）**！导致已卸载插件的回调函数在内存中发生逃逸并继续被执行。

#### ③ Scope 依赖内存 WeakMap 导致无法持久化与断网恢复
- **精确位置**：`reference/deepseek-harness/packages/core/scope/src/index.ts:39-40`
- **代码现场证据**：
  ```ts
  // packages/core/scope/src/index.ts:39-40
  const scopeParents = new WeakMap<ScopeKey, ScopeKey>()
  ```
- **破绽实质**：Scope 之间的父子继承树完全存储在 V8 进程内存的 `WeakMap` 中，且 `ScopeKey` 为无名称的 `object` 引用。这意味着这套精妙的 Scope 结构是完全不可序列化的！如果应用崩溃或重启，已持久化的 Session 恢复后无法复原当时的作用域链条。

#### ④ 工具并发调度器逻辑脆弱且易死锁
- **精确位置**：`reference/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:220-236`
- **破绽实质**：`runGroup` 在一个复杂的 `while (inFlight.size > 0)` 循环中，将 `fillPool()`、`Promise.race(inFlight.values())`、`commitReady()` 和 `throwSchedulerFailure()` 高度耦合。一旦任何一个内部微任务未正确 reject 或 abort 信号竞争异常，整个工具执行流会直接卡死在循环内部。

---

### 2. Conex (Crish) 侧具体代码破绽与技术债务

#### ① 插件生态宿主断代与 TS 包物理删除遗留
- **代码历史证据**：Git 提交 `25762dc10b2619fb4787a5880f3542d205017739`
- **代码现场证据**：
  `packages/plugin-sdk/` 目录下的 51 个文件被全量物理删除（包括 `PluginLoader`、`PluginRegistry`、`manifest.ts` 等），只保留了 `packages/shared-types/src/plugin.ts` 的类型接口。
- **破绽实质**：虽然在 Rust 内核侧保留了 `HookRegistry`，但前端与 Node 侧目前失去了官方标准的沙箱插件加载宿主。第三方插件无法通过标准机制动态接入，扩展体系退化为仅依靠内置工具与 MCP 外部进程，失去了类似 VS Code 插件生态的轻量级前端扩展能力。

#### ② 工具并发类别硬编码与伪分类（Hardcoded Tool Concurrency）
- **精确位置**：`crates/session-loop/src/loop/handlers/executing_tools.rs:78-80`
- **代码现场证据**：
  ```rust
  // crates/session-loop/src/loop/handlers/executing_tools.rs:78-80
  category: ToolCategory::Internal,
  concurrency: ToolConcurrency::Parallel,
  ```
- **破绽实质**：在将 Assistant 的工具调用打包成 `ToolBatchCall` 时，代码中将 `concurrency` 硬编码为 `ToolConcurrency::Parallel`，`category` 硬编码为 `ToolCategory::Internal`。源码注释中明确承认：“此处恒 Internal 为投影标签登记，不接线真类别”。这意味着内核尚未真正根据注册表中工具的真实定义来动态划分串行/排他执行栅栏，目前的并发保护主要依靠单工具内部的写互斥锁，而不是批调度层的天然隔离。

#### ③ 运行时注册表缺乏注销机制（No Dynamic Unregistration）
- **精确位置**：
  - `crates/agent-tools/src/registry.rs:36-85` (`ToolRegistry`)
  - `crates/session-loop/src/hooks.rs:435-485` (`HookRegistry`)
- **代码现场证据**：
  `ToolRegistry` 只有 `register(&mut self)` 与 `register_runtime(&self)`；`HookRegistry` 只有 `register` 与 `register_with`。
- **破绽实质**：两者均没有提供 `unregister(name)` 或根据会话/插件 Token 进行清理的机制。在长寿命桌面宿主中，如果允许动态加载插件或会话级工具，已注册的 Tool 和 Hook 将永久驻留在全局内存中，导致内存泄漏与行为污染。

#### ④ fatalOnError 判定的硬编码排除侵入性
- **精确位置**：`crates/session-loop/src/tool_exec.rs:9-10`
- **破绽实质**：致命错误判定逻辑中硬编码排除了 `softDeny`、`timedOut`、`cancelled`、`approval_expired`、`user_denied` 等多种特定错误代码。业务层策略侵入了批执行器的底层基础设施，导致未来扩展新的非致命错误类型时，必须直接修改内核调度代码。

---

## 十一、吸收借鉴方案与架构演进蓝图

为推动 Conex 与 DSH 各取所长，实现工业级高可靠与极致扩展性的统一，提出以下双向演进方案：

### 1. Conex 吸收 DSH 优势的落地路线图

#### 方案 A：引入 RAII 驱动的 `RegistrationGuard` 实现可逆注销
借鉴 DSH `ScopedLayers.effect` 的撤销哲学，改造 Conex 的 `ToolRegistry` 与 `HookRegistry`：
```rust
// 建议架构：crates/agent-tools/src/registry.rs
pub struct RegistrationGuard {
    registry: Arc<ToolRegistry>,
    registered_name: String,
}

impl Drop for RegistrationGuard {
    fn drop(&mut self) {
        self.registry.unregister(&self.registered_name);
    }
}
```
- **收益**：在插件或会话初始化时注入工具/Hook，由其生命周期句柄持有 `RegistrationGuard`。当会话结束或插件关闭时，Rust 的 `Drop` 机制将自动、无损地撤销注册，彻底根除长期驻留的内存隐患。

#### 方案 B：重构 `ScopedRegistry` 分层作用域
借鉴 DSH 的 `scopeChainOf`，在 Conex 中实现多级作用域解析：
- **全局内置层**（只读共享） $\longrightarrow$ **会话隔离层**（会话内可见） $\longrightarrow$ **子 Agent 临时层**（子 Agent 独立持有）。
- 子 Agent 派生时继承父级的作用域只读视图，子 Agent 声明的专属工具/Hook 随子会话销毁而物理释放，避免向主 Agent 污染。

#### 方案 C：规范化三层配置系统
借鉴 DSH `SettingsProvider`，将 Conex 散落在各配置结构体中的参数收敛为：
1. **Schema 静态默认层**；
2. **项目级工作区 `.conex/settings.json` 覆盖层**；
3. **用户全局动态覆盖层**。
并在 Rust 侧实现强类型的局部更新监听器（`watch` 机制）。

---

### 2. DSH 吸收 Conex 优势的落地路线图

#### 方案 A：引入形式化有限状态机（FSM）
- 弃用目前在 `agent.ts` 中过于简陋的 3 态 `Phase` 变量。
- 将状态提升为独立的穷举类型，建立严格的 `applyTransition(phase, event)` 纯函数转移表，对非法时序转移执行抛错断言，提升整个调度核心的可观测性与抗异常击穿能力。

#### 方案 B：消除深克隆，采用不可变结构或分代移动
- 消除 `agent.ts` 中每次循环对巨大历史配置对象的 `structuredClone` 与 `deepFreeze` 调用。
- 引入类似于 Rust 零拷贝语义的不可变数据共享方案（如使用 `Object.freeze` 浅层隔离或纯不可变持久化数据结构），减轻 V8 GC 压力。

#### 方案 C：消除原型污染风险与 WeakMap 易失性
- 立即修复 `packages/settings/settings/src/index.ts:265` 的技术债，在配置深合并中使用安全的 `Object.create(null)` 字典。
- 将 Scope 树的结构关系转变为可由 Session 唯一标识符序列化还原的强类型数据，使得 Scope 上下文具备跨进程冷启动与离线恢复能力。

---

## 结论

本次代码级深度审计表明：
- **Conex (Crish)** 代表了系统级、工业级 Agent 开发的标杆：以数据驱动、严格有限自动机、零拷贝内存管理和强类型编译期约束，铸就了极其稳健的运行时内核；其不足在于 TS 插件生态宿主断代以及部分运行时注册表缺乏动态撤销机制。
- **DeepSeek Harness (dsh)** 代表了应用层微内核框架设计的典范：以 Cordis 服务总线、作用域分层继承、生成器可逆副作用撤销及洋葱圈流水线，构建了极富弹性与美感的扩展体系；其破绽在于内部代码留下多处关于原型污染和观察者泄漏的未决技术债务，且过度依赖 JavaScript 动态特性导致性能与确定性偏弱。

两者在架构哲学上互为镜鉴，Conex 若能融合 DSH 的分层作用域与 RAII 撤销机制，必将成为坚不可摧且生态极其繁荣的下一代 Agent 底座。
