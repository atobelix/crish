# DeepSeek Harness 核心设计模型审计

> 战役：`input-stream-consolidation`（统一输入流收敛）
> 参考仓库：`reference/deepseek-harness`（deepseek-ai/deepseek-harness）
> 性质：**只读源码形状审计**，未运行真机验证（未 `pnpm run build` / `test` / 起 `dsh` 服务）。所有结论基于 `packages/` 源码静态阅读与官方 `docs/architecture.md`，标注为「源码形状」；涉及行为性断言尽量以文件内守卫逻辑、运行时不变量与架构文档为准。
> 目标：提炼 DSH 的核心设计模型（agent 循环 / 会话事件=唯一事实源 / 事件→持久化→投影链 / Cordis 装配 / 扩展机制 / 前端组件模型 / ACP 协议），与我们的「事件流唯一时间线 + 投影派生 + 扩展点」模型对比，产出可借鉴清单。
> 日期：2026-09

---

## 0. 一句话结论（TL;DR）

DSH 是**「会话事件日志 = 唯一事实源」的教科书式事件溯源架构**，且分三层落地：**持久化层写日志、投影层折叠派生、扩展层用 Cordis 事件/注册表挂接**。它有三个标志性设计：

1. **会话事件日志（`Session.log`）是唯一可重放事实**：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`、`request/*`、`todo/write`、`goal/change` 等全部追加进同一只追加日志；**「模型可见 ⟺ 已落日志」是硬不变量**，任何进入模型请求的内容都必须能从日志重建；
2. **写路径与读路径彻底分离**：`Session.append` 同步入内存日志并广播 `session/event`（热路径零 I/O），持久化是**插件**（订阅 `session/event` + 批量 write-behind 落盘 + `session/flush` 反压屏障）；派生模型历史由 `deriveMessages()` 从日志表面（surface）投影，读模型由 `session-projections` 的纯 `init/apply/view` 单位折叠；
3. **一切皆 Cordis 插件**：连 agent 循环本身、模型适配器、工具注册表、持久化后端都是可替换插件；装配 = `boot()` 建 Context → Loader 挂载 → 分层 patch 文件按行 id 覆盖（last-write-wins）。

DSH 与我们的模型**几乎同构**，差异集中在三处：DSH 的分层（核心←投影←扩展）更干净且经 217 包实证；DSH 的「进行中/终态」由**事件类型语义**区分（`assistant/chunk` 是原始 chunk、`assistant/message` 是组装终态，二者都在日志里），而我们把进行中用 `NoPersist` 增量事件表达；DSH 的前端用「事件折叠状态机 + keyed slot 单订阅」而非「单一投影 store」。

---

## 1. 包全景

根目录 49 个顶层包组目录（`packages/`），`@deepseek-ai/dsh-<name>` workspace，**每包即一个 Cordis 插件**，全部 `private` 配 `@deepseek-ai/cordis` 作 peerDependency。按任务重点列核心包：

| 组      | 包                                                          | 职责                                          | `ctx` 键                 |
| ------- | ----------------------------------------------------------- | --------------------------------------------- | ------------------------ |
| core    | `core/session`                                              | **append-only 会话事件日志 + 内存 store**     | `ctx.sessions`           |
| core    | `core/session/surface`                                      | 事件→LLM 消息的派生投影规则 + 表面（surface） | 库                       |
| core    | `core/agent`                                                | `Agent` 接口、生命周期、`agent/*` 事件        | `ctx.agents`             |
| core    | `core/agent-loop`                                           | 默认 Agent 循环驱动（ReactLoopAgent）         | `ctx.agentLoop`          |
| core    | `core/tools`                                                | 工具注册表 + 守卫执行管道                     | `ctx.tools`              |
| core    | `core/system-prompt`                                        | 提示词分段 / 工具 schema 装配                 | `ctx.systemPrompt`       |
| core    | `core/scope`                                                | 每 agent 的作用域注册原语                     | 库（无键）               |
| llm     | `llm/llm`                                                   | 消息/流词汇 + 适配器缝                        | `ctx.llm`                |
| session | `session/session-persistence*`                              | 持久化 Service + jsonl/sqlite 双后端          | `ctx.sessionPersistence` |
| session | `session/session-projection*`                               | 投影注册表 + 持久化缓存                       | `ctx.sessionProjections` |
| session | `session/session-title*`                                    | 标题生成服务（投影单位 + `onUserMessage`）    | `ctx.sessionTitle`       |
| boot    | `boot/app-boot`                                             | **装配引擎**：profile/loader/分层 patch       | 库                       |
| bundle  | `bundle/base` / `web-app` / `headless`                      | 可安装的 cordis.patch.yml 分层                | 库                       |
| hooks   | `hooks/hook-protocol` + `hooks-claude-code` / `hooks-codex` | 外部 hook（Claude Code/Codex）桥 + 线上协议   | 库                       |
| skill   | `skill/skill` / `skill-filesystem` / `tool-skill`           | skill 能力缝（SD/Provider/Consumer）          | `ctx.skills`             |
| goal    | `goal/goal` + `goal-round-driver` + `tool-goal`             | 目标域（投影单位 + 续轮驱动）                 | `ctx.goals`              |
| todo    | `todo/tool-todo`                                            | `todo_write` 工具 + `todo/write` 整表快照事件 | —                        |
| acp     | `acp/acp`                                                   | **自动化专用 ACP 服务器**（JSON-RPC stdio）   | 插件                     |
| sdk     | `sdk/*`                                                     | 另一套私有 JSON-RPC（同桥到 `ctx.agents`）    | 库                       |
| client  | `client/ui-primitives + ui-* + runtime + web-react + ...`   | 浏览器端 React 组件模型                       | client 插件              |

结构要点：**能力缝（capability seam）三分**——每个可替换能力拆「Service Definition（声明接口）/ Service Provider（实现）/ Consumer（消费，常为模型工具）」，如 `ctx.fs`/`ctx.shell`/`ctx.skills`/`ctx.subagents`。这与我们 `00-核心逻辑模型草案.md` §5「依赖方向：核心←投影←扩展←壳」、以及「接口两实现法则」（session-persistence 恰有 jsonl/sqlite 双实现）完全同构。

---

## 2. Agent 循环与事件出站

### 2.1 轮转结构：Step/Turn 双层、状态机 phase

`packages/core/agent-loop/src/agent.ts` 的 `ReactLoopAgent` 是默认驱动，**驱动着一个 phase 状态机**（`agent.ts:38-46`）：`idle → maintenance → running`。循环从 `session` 事件日志派生一切请求（注释 line 3：_Every request is derived from the session log_）。

**Turn = 0..n 个 Step**（`docs/architecture.md:63-66`）：step = 一次模型请求 + 其工具调用；turn = 从 open 到「无欠账」(nothing is owed) 关闭。turn 数从日志 `turn/start` 反推（`agent.ts:92`）。

**Step 内 `while(true)` 循环**（`agent.ts:339-400`）：`buildRequest`（组请求）→ `llm.stream` 流式收 `assistant/chunk` → `BlockAssembler` 组装 → `assistant/message` → 若含 `tool-call` 块 → `executeToolCalls` → 工具产出 `tool/result`+可能 `additionalContexts` 回 next-step → 有工具/有新输入则下一次。

**Turn 内 Step 循环**（`agent.ts:255-330`）：`preStep`（claim 输入 + 组 prompt + 跑 `agent/pre-step` waterfall）→ 决定 `enter`/`reject` → 逐 `append('user/message')` → 派 step → 直到 no pending 输入 → `agent/turn-stopping`（serial，可 steer 续跑）→ `turn/end`。

### 2.2 输入四通道（与我们的「统一输入流 + 插入时机」同构）

`agent.ts:113-132`：`send` 是唯一入口，经 `inbox.splice`，三类分类 + 唤醒语义：

- `followup(input)` → `target='next-turn'`，wakeup=true（**新轮次输入**）；
- `steer(input)` → `target='next-step'`，wakeup=true（**运行中插队**，不跳过当前 step 的工具）——对应我们扩展点 B「提交时机：force/steer/followUp」；
- `inject(input)` → `target='next-step'`，wakeup=false（**注入上下文**，挂到下一 admitted 请求，不含唤醒）——对应扩展点 A「注入时机」；
- 外加 `cancel`（AbortController 中断 + 可选 `keepInbox`）。

`Inbox`（`core/agent/src/inbox.ts`）把每次 splice 记为 `agent/inbox/spliced` **会话事件**（`inbox.ts:186`）——**输入插入本身也是日志事实**，天然支撑重放与审计。这与我们「一切皆带类型文本节点进时间线」的插入语义完全一致。

### 2.3 事件出站（session events 的发射点与 agent/* 生命周期事件）

两类出站，职责严格分开（`docs/architecture.md:53-61`）：

**(a) 会话事件（durable，追加进日志，广播 `session/event`）** 由 agent-loop 在各边界发射：`turn/start`（`agent.ts:255`）、`step/start`（:279）、`user/message`（:283）、`assistant/chunk`（:349）、`assistant/message`（:381）、`tool/call`/`tool/result`（`tool-calls.ts:263/281`）、`step/end`（:292）、`turn/end`（:319）、`request/header`/`request/context`（`agent.ts:466/482`）。**「模型可见 ⟺ 已落日志」**是运行时不变量断言的（architecture.md:94-96；`packages/AGENTS.md`）。

_*(b) agent/* 生命周期 + 扩展事件（live，非持久化，作用域隔离）_* 由 `core/agent/src/runtime-types.ts:146-291` 声明，经 `agentEvents` 融合分发器（`agent.ts:86`）发射，供插件观察/拦截在飞工作：

| 域名                 | 事件                                                                                                        | mode                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 生命周期             | `agent/created`、`agent/disposed`、`agent/status`（idle↔running）                                           | emit                                |
| inbox                | `agent/inbox/inserted`、`claimed`、`discarded`                                                              | emit                                |
| 会话                 | `agent/session-start`                                                                                       | emit                                |
| **扩展点（机器缝）** | `agent/pre-step`（改写/拒绝进 step 消息）、`agent/request`（改请求配置）、`agent/request-error`（重试裁决） | **waterfall**（必须 `next()` 委托） |
| 收场                 | `agent/turn-stopping`（关 turn 前，数据决定可 steer）                                                       | serial                              |
| 错误                 | `agent/error`                                                                                               | emit                                |

**与 session 事件模型的衔接**：`agent/*` 是「在飞工作」的 live 观察/拦截；会话事件是「已发生事实」的持久记录。两者分野是 DSH 的第一设计决策（architecture.md:55-57）——**与我们不变量 5「核心只暴露事件出 + 钩子/注册表入」、以及 08 审计「天然已可插拔的域」完全同构**。

---

## 3. 会话事件模型：事件 → 持久化 → 投影链

### 3.1 事件类型全集：`SessionEventMap` + `KNOWN_SESSION_EVENT_TYPES`

`core/session/src/types.ts:236-333` 声明 merge-extensible `SessionEventMap`；`known-event-types.ts:19-63` 给出本构建认识的 45 种事件类型（GENERATED，由 `scripts/gen-persistence-catalog.ts` 生成并受 `doc-sync` 保鲜）。事件信封（`types.ts:404-436`）：

```ts
type SessionEvent<T> = {
  type: T; // 判别式联合（switch(type) 自动收窄 data）
  seq: number; // 日志内单调连续，恒等于 log.length（seq=log.length 契约）
  time: number; // Unix 毫秒
  data: SessionEventMap[T]; // 无损 JSON（lossless JSON：禁 BigInt/Date/循环…）
  ignorable?: true; // 读者遇到不认识 type 时可否安全跳过（默认缺省=required）
} & (T extends SurfaceEventType ? { surfaceOp; sourceEventSeqs } : object);
```

**`ignorable` 是版本兜底的关键**：adding an ordinary event type 不 bump `SESSION_FORMAT_VERSION`；遇到 required 事件而 reader 不认识 → 必须拒重建（`KNOWN_SESSION_EVENT_TYPES` 注释，`known-event-types.ts:9-16`）。**这解决了我们「未来类型扩展 + 旧读者兼容」的问题——新事件默认 required，忘了打标记会 over-refuse 而非静默吞掉。**

**三类 surface 事件**（唯一能产生 LLM 消息、唯一能携带 `surfaceOp`/`sourceEventSeqs`）：`user/message`、`assistant/message`、`tool/result`（`types.ts:343-389`）。其余是 trace/replay/log-only（chunk、边界、usage、错误）。

### 3.2 事件 → 持久化：write-behind + 反压屏障 + 幂等续写

`Session` 是 **plain class 不是 Service**（`index.ts:425`）。`Session.append`（`index.ts:604-655`）是**同步热路径**：校验并深冻事件 → 推进增量 surface → 入内存 `log` → 同步广播 `session/event`（per-listener 容错，失败不阻止后续 observer）→ **零 I/O**。注释明言：_persistence plugins buffer asynchronously_。

**持久化是插件**（`index.ts:2-4`；`docs/architecture.md:94`）。`session-persistence`（Service Definition）定义 `abstract create/append/load/inspect/readFrom/list/listSnapshots/locate`（`index.ts:84-241`）；两个实现：

- `session-persistence-jsonl`（`format.ts`/`zstd.ts`）；
- `session-persistence-sqlite`（`schema.ts`）。

**write-behind 批量 + 显式 flush**：`coordinator.ts` 的 `SessionWriteBehind`（`session-persistence/src/write-behind.ts:22-158`）逐事件 `enqueue(structuredClone)` 入 pending，起一个固定 `maxDelayMs`（默认 ~5s，`index.ts:29-32` 注释）定时窗，到点后台批量写稳定有序前缀；`flush()` 是显式静默屏障（`write-behind.ts:63-72`，join 同一 barrier），背景写失败保留 pending 并重试。`session/flush` 事件（`index.ts:85`）作为 awaited parallel 持久化检查点，由 `checkpoint-policy` 的 per-request 屏障、idle 检查点、teardown drain 触发。**写后 `revision`（`revision.ts`）做轻量 change 令牌**，供 `listSnapshots`/`inspect`/restore 判断 stored log 是否已变。

**幂等与续写**：`append` 要求 `seq` 连续且从 `0` 起（`index.ts:525-527`）；后端 `append` 时断言「首个事件 seq == stored next-seq」；`load` 平衡持久中断的尾 turn（「只可删最后撕裂记录/补合成关闭，不改已提交事件」，`index.ts:37-42` 注释）。**这些是「单写者 + seq 连续」保证幂等不做 dedup 的根基**——与我们「seq 单调 + 逻辑截断取代物理删除」同源。

### 3.3 事件 → 投影：surface + deriveMessages 派生模型历史

`Session.deriveMessages()`（`index.ts:726-747`）从「表面（surface）」派生 LLM 历史。surface 由 `SurfaceManager` 增量维护（`index.ts:428`），只含三类 surface 事件，按 `surfaceOp` 排序：

- `'append'`：正常追加（user/assistant/tool 消息）；
- `{op:'replace',start,end}`：压缩替换一段（`surfaceOp`，`types.ts:372-389`）——**这是「逻辑截断/撤回」的落地**：不改日志，靠新增 replace 事件 shadow 掉旧 surface 节点。

每条 surface 事件折叠 `deriveEventMessage`（`surface.ts:83-114`）：`user/message`→verbatim user；`assistant/message`→assistant（空内容跳过分发——仅承载 usage）；`tool/result`→tool result message。**「模型看到的上下文 = 日志表面的确定性折叠」**，连 `assistant/chunk`（token 级重放保真）都在日志里但折叠时不进派生。

**关键辨识——模型可见表面 ≠ 人类转录**：`surface.ts:40-55` 明言「模型可见 surface 故意 shadow 被替换区间，因此它不是人类转录的正确来源；append-origin 事件才是用户已见对话的可持久化源头」——**压缩只影响模型输入，人类 UI 仍从 append-origin 事件呈现**。这是我们「唯一时间线 + 投影派生」需要仔细区分的：**UI 是真转录，模型上下文是可能被压缩/替换的折叠视图**。

### 3.4 事件 → 投影：`session-projections` 纯折叠单位（读模型）

`session-projection/src/index.ts`（`SessionProjectionRegistry`）：**读模型三函数单位**：

```ts
interface ProjectionDefinition<K,S> {
  key: K                    // 合并进 SessionProjectionMap 的键
  schema: ZodType<...>      // 出站前校验
  init(): S                 // 空日志初值
  apply(state, event): S    // 纯转移；不关心返回同一引用（Object.is 零下游工作）
  view(state): S            // state → 线上整值
  stateVersion: number      // 缓存失效版本（bump=废弃旧 checkpoint 行）
}
```

注册表**订阅 `session/event` 一次，对每个提交事件 eager 驱动所有注册单位的 `apply`**（`index.ts:181-183, 405-425`），state 引用变了才通知 `onChanged`。读面三档（都是「同一份折叠 + 整值」，读模型不重放）：

1. **`snapshot()`**：零 I/O 从 watermark 缓存取整值（缺失懒折叠内存日志）；
2. **checkpoint/restore/restoreFloor/viewCheckpoint**：支持**持久化投影缓存** `(sessionId,key,ver,seq,val)`，冷读 = 缓存状态 + `readFrom(floor)` 前向重放尾日志 + `view`（`index.ts:355-385`）；`ver` 不匹配/超日志尾 → 弃行重折叠。**这正是我们「投影派生 + 缓存」的成熟范本，且比 Pi 更完整（有 version 门禁）**。

**整值规则（load-bearing）**：`session-projection/index.ts:13-15`「状态型日志事件必须携带完整变更后状态，而非 delta」——这与我们 todo/goal 的「整表快照 last-write-wins」一致。

---

## 4. 装配模式（Cordis DI + 分层 patch）

### 4.1 三层装配层

- **一层 bundle（patch 文件）**：`bundle/base/cordis.patch.yml` 是每个 profile 的首层（模型适配器、工具、持久化、沙箱、审批、settings、credentials、telemetry、agent、jobs…）；`web-app` 加浏览器层；`headless` 加一次性 runner。
- **二层 profile（命名组合）**：`packages/boot/app-boot/src/profile.ts`，一个 profile 列出它堆叠的 bundles + 用户自己的 `cordis.patch.yml`（`docs/architecture.md:17-22`）。`web`/`headless` 随装模板。
- **三层 boot 引擎**：`app-boot/src/index.ts` 的 `boot()`（`index.ts:757-802`）——`new Context()` → 装 `Loader` → `prepare` host 钩子 → **挂根 `cordis:include`**（`mountRootInclude`，:486-529）→ 等待 loader settle → `assertEntriesActivated` 审计所有 entry fiber 为 ACTIVE → 返回。启动前 `installFailLoud`（:609）捕获晚到 init 拒绝、`loadLayeredEnv`（:177）做继承>项目>home 三层 `.env`、bootstrap-only 变量名审查（:92-163）。

### 4.2 patch 语义：按行 id 覆盖，last-write-wins

`schema`：**patch 以「行 id」寻址，替换该行整个 config，或 insert 新行**（`base/cordis.patch.yml` 头注释）。应用顺序：base → profile 各 bundle（按其序）→ profile `cordis.patch.yml` → home 层 → `--patch` overlay。同一行 id 后写覆盖前写。`assertEntriesActivated` 拒绝 pending/failed entry（`:692-725`），无 fiber 的非 disabled entry = 启动失败。

**「没有任何 privileged core」**：连 agent-loop、session、负载均衡、持久化本身都是配置 rows，`.env` 一层、patch 一层都能换掉（architecture.md:13）。**与「插件化边界：Rust 侧用 ToolRegistry + 统一门面」（草案 §5.3）一致**——但 DSH 更进一步：DSH 的装配单元是「配置行 + 它挂接的代码」，而我们计划「独立带不进 seq、感知注入进 seq」的 config 与事件区分在 DSH 也有对应（见 §9）。

### 4.3 依赖方向规则

`packages/AGENTS.md` 与各包 tsconfig 强制：**核心（core/）不 import 上层**；`capability seam` 的 Consumer 不 dict 契约（Service Definition 为唯一中间面）；host（node 半）与 client（浏览器半）分文件分签，client 聚合不得 import host 的 cordis 合并。`docs/architecture.md:98-102`「一个 seam 换掉整个产品」。这与我们「依赖方向：核心←投影←扩展←壳」、反过度设计「禁逆向依赖」**完全一致且被 217 包实证**。

---

## 5. 扩展机制

### 5.1 核心扩展面（core 认知的）：agent/* + tools/* + 注册表

- **`agent/*` 事件缝**（§2.3）是主扩展点；`agent/request`/`agent/pre-step`/`request-error`/`turn-stopping` 允许观察/拦截/改写（waterfall 必须 `next()`）。
- **工具注册**（`core/tools`）：`ctx.tools.register(definition)` 是 effect（`index.ts:1037-1060`）；执行管道 = `tools/pre-execute`(waterfall)→ guards(monotonic deny) → `tools/execute`(waterfall) → `tools/post-execute`(waterfall) → `tools/result`(emit) + `tools/change`(emit)（`index.ts:147-207`）。工具 schema 进 prompt 装配。**工具注册按 agent 作用域隔离**（可经 `agent.ctx` 注册，只对该 agent 生效）。
- **model / prompt / capability 装配**：`ctx.llm` 注册适配器、`ctx.systemPrompt.section()` 加提示词段、`ctx.fs/shell/subprocess/subagents` 挂后端。

### 5.2 skill / goal / todo：哪些核心、哪些扩展、如何挂接

**它们都是扩展**（在 core 之外），但**通过 merge-extensible 类型表把领域语义接进核心**：

- **todo**（`todo/tool-todo`）：唯一事件 `todo/write`（整表 `TodoItem[]` 快照，`types.ts:298`），纯 log-only UI 状态、从不进派生历史。工具 = Consumer；核心只认事件。
- **goal**（`goal/goal`）：`goal/domain.ts` 用 **declaration merging 同时扩展三类表**（这是 DSH 扩展的招牌手法）——
  - `SessionEventMap` + `'goal/change'`（整值快照或 clear tombstone，`domain.ts:61-68`）；
  - `SessionProjectionMap` + `goal` 键（`types.ts:102-111`）；
  - `MessageSourceMap` + `goal` 源（续轮 `user/message` 带 `goalId/revision/round`，`domain.ts:47-59`）。
  - 纯折叠在 `fold.ts`（`applyGoalEvent`，含严格 decode 拒腐 + revision +1 CAS 不变量）。
  - **`goal-round-driver` 是纯挂接扩展**：只 inject `['agents','goals','sessions']`，经 `agent/request`/`agent/pre-step` 扩展点构造续轮 `user/message`，零改核心循环。
- **skill**：`ctx.skills` Service Definition 合并各 provider catalogs（`ScopedLayers` 按作用域分层），`skill-filesystem` = Provider，`tool-skill` = Consumer（catalog/loader 工具）。skill 本体是 markdown+frontmatter 规范块（给模型的能力账本），可执行能力仍在 tools。

**与草案的对应**：goal/todo 正是 08 审计「日志可重放状态 + 展示投影」的现成成熟范例；`goal/change` 即「状态型事件携带整值」（草案不变量 3 投影派生）；goal-round-driver 即「扩展只挂扩展点」。

### 5.3 hooks（Claude Code/Codex 桥）：非 Cordis 事件的第二扩展面

`hooks/hook-protocol` + `hooks-claude-code`/`hooks-codex`：实现外部规范桥（`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`/`SessionStart` 等点），交互经 `hook/invoked`/`hook/result` **成对**写进会话日志（`hook-protocol/src/events.ts:70-104`，`invoked`/`result` 以 `handlerId` 关联）。**这证明 DSH 的「hooks」不是 Cordis 事件，而是外部子进程规范的桥接**；DSH 的 onUserMessage 类钩子由各服务订阅 `session/event` 承担（例：`session-title/index.ts:319-330` 对 `user/message` 触发标题生成，:462 `onUserMessage`）。

---

## 6. 前端组件模型

### 6.1 三层铁律：runtime（数据）→ web-react（渲染机械）→ ui-*（纯 props 展示）

`client/AGENTS.md` 分层红线 + `ui-slots/src/index.ts:211-221`（`PropsRuntime`）、:442-450（`ComposedProps`）：

1. **`runtime`** = 数据对象层（**React-free**），持有全部状态，产出 **bare observable**；store 引擎 zustand+immer+subscribeWithSelector，但**只做裸 source、不产 selector hook**；
2. **`web-react`** = 唯一渲染机械：`useSyncExternalStoreWithSelector`（**唯一 hook 构造器**，`web-react/src/bind.ts:18-23`），per source 缓存保订阅稳定；
3. **`ui-*`** = 纯 props 展示组件，**禁 store、禁手工订阅**，业务组件无镜像第二 store。

### 6.2 投影消费三路径（组件如何从 session 事件/投影取数）

`Session` 是单一 uSES 源（`runtime/.../session.ts:447-458`），`notifier.ts` 做三级批量（微任务/base/帧 `markFrameDirty`）。三条路径：

1. **会话快照**：`session.buildSnapshot`（`session.ts:731-768`，含 chat/queue/pending/running/composerPhase）→ **useSession**；
2. **会话列表 + provideInfo**：`SessionRuntime.list`（`service.ts:302-305`）+ `provide.ts` → **useSessions**；
3. **投影（sessionProjections）**：`ProjectionValueStore`（`projection-store.ts`，push 模型，唯一**「higher seq wins」**）经 **useProjection** 键寻址（`web-react/src/session-provider.tsx:96-114`）。**host 是唯一计算处，客户端零域折叠**，只持整值。（`projection-store.ts:1-10` 头注释）

### 6.3 ui-conversation / ui-layout 大包结构

- **ui-conversation**：`src/client/` 内分 contract（唯一公共 API：slots/chat-nodes/composer-submission/queue/views）、conversation-nodes（业务状态机）、chat（渲染器）、input（composer 状态机）、queue、settings、skeleton。`ChatView` 从快照渲染：`useSession(s=>s.chat.order/nodes/timeline)`（`chat/ChatView.tsx:150-160`）→ `order.map -> ChatNodeSeat`（:382-397）→ row 经 **keyed slot `conversation.chat.node`** 派发。
- **ui-layout**：仅 `AppFrame.tsx`（注册进内置 `'root'` slot）+ `columns.ts` + stores；`AppFrame.tsx:87-199` 用 `renderSlot('sidebar'|'conversation'|'details'|'shell.overlay')` 渲染三栏。
- **ChatNodeSeat**（`chat/ChatNodeSeat.tsx:19-59`）：每节点**只订阅自己的 key**（memo 包裹），`renderSlot('conversation.chat.node', routeOwner, { entryKey: kind, hookContext: nodeKey })`——**assistant 增量只替换自己的 row 不重挂**。

### 6.4 事件折叠状态机：`ConversationNodeAssembler`（重放安全）

这是 DSH **前端模型与我们「单一投影 store」最不同的地方**：它不用「把事件 fold 成一个全局 store」，而是用**确定性事件折叠状态机**：

- `ConversationNodeAssembler`（`runtime/.../conversation-assembler.ts`）把连续事件窗确定性折叠为 Contexts，`start/update` 按序重放，`flush()` 推进 view builder；`replaceWindow`/`append`/`prepend` 支持分页：
- 每个 `ConversationNodeDefinition`（`contract/conversation.ts:171-228`）声明 `kind/target/match/start/update/publication/buildViewNode`；assistant 节点 `match` 认 `step/start`/`assistant/chunk`/`assistant/message`/`llm/retry`，`update` 累积 block，`publication` 用 `animation-frame` 节流（`conversation-nodes/assistant.ts:244-309`）。
- 重放靠 **seq 幂等**：`append` 遇 `seq <= tailSeq` 丢弃重放重叠（`session.ts:670-676`）；resync 清窗 open + `liveBuffer` 缝补；`loadOlder` 走 `prepend` 增量。

### 6.5 装配：web-app ↔ client ↔ Cordis

`apps/web` 只建 Vite 壳并注入 `window.__DSH_BOOT__`（`vite.config.ts:7-19` 拒裸 serve）。`client/web/src/boot.tsx` `AppWebEntry.run()`：解 `__DSH_BOOT__` → 建 `ClientModuleSystem` → 挂 vendored **cordis Loader** → `loader.create` 每个 ui-* 包插件行 → `assertEntriesActive`。_*每个 ui-* 包 = 一个 Cordis 插件 entry_*（`bundle/web-app/cordis.patch.yml` 的 `dsh.client` 行罗列全部 UI 插件）。`app.tsx:38-43`：唯一 ctx 级 `renderSlot('root')`；ui-layout 把 `AppFrame` 注册进 `'root'`。

**web-app 的 host-plane / agent-plane 分界**（`web-app/cordis.patch.yml:276-424`）：模型面向工具（`tool-goal`/`tool-todo`/`tool-skill`/`tool-fs`…）在 web 被 `disabled` 并移到**每会话 agent preset**；而注册表/服务（`goals`/`skills`/`subagents`/jobs registry）**留在 host plane**——判定规则是「Service 跨 realm 被读取的属 host」。**这是「同一会话多能力集」在 Cordis 侧的落地，正是我们「per-session agent 能力装配」可借鉴的**。

---

## 7. 协议（ACP 与 sdk）

### 7.1 ACP：自动化专用、实现外部标准、桥接 ctx.agents

`packages/acp/acp/src/index.ts` 是 Cordis 函数插件（`name='acp'`, `inject=['agents']`），**实现 Agent Client Protocol（agentclientprotocol.com）**，经外部依赖 **`@agentclientprotocol/sdk@0.25.1`**（`PROTOCOL_VERSION`，无 auth/无 image/无 embeddedContext）。传输 = JSON-RPC over stdio（`ndJsonStream(stdout, stdin)`）。头注释（`index.ts:1-10`）：_"automation-only … carries prompt text, committed assistant text, cancellation, and one-shot permission decisions; presentation and human-interaction features stay with the harness's UI modules"_。

- **方法集（无 list-sessions/send-call/handle-message）**：`initialize`/`authenticate`/`session/new`/`session/prompt`/`session/cancel`。映射：`session/new`→`agents.create`；`session/prompt`→组装 user message→`agent.followup`→**等 `agent.whenIdle()` 整 agent 空闲才 settle**（正常→`end_turn`，无 turn→`cancelled`，经 `agent/error` 以 `turn failed` 拒绝）；`session/cancel`→cancel 寻址 agent。`ownedRecord` 守卫（`index.ts:114-118`）防同 id 冒名。
- **「human 会话不可控」的历史**：ACP 曾是一套完整交互式编辑 UI，被 Agent Note `2026-07-23-acp-automation-only-protocol.md` 判定为重复 TUI/Web 的「第二产品 UI」而收缩成纯自动化 transport——刻意不提供 load/list/resume/delete/fork、commands/modes/plan review、human elicitation，reasoning/raw chunks/tool 活动/titles 一律不上线（`index.ts:152-154` 注释：这些是 presentation/trace 数据）。审批仅 `approval/request` 一次性 allow/reject-once，绝不转持久 grant。**设计教训：「单一协议既要标准互通又要 UI/人环」会拆成同 TUI/Web 平行的第二产品；收缩边界到自动化 baseline 是刻意取舍**。
- **流式仅推已提交文本**：监听 `session/event` 的 `assistant/message`，逐 text-block 发 `session/update(agent_message_chunk)`；**非 token 级**，reasoning/工具活动/原始 chunk 不上线。
- **无 sync/snapshot**：连接断开即 dispose；仓内「snapshot」另指持久化 JSONL 回放与 `test-support/acp-snapshot`（无密钥测试夹具，非运行时协议）。

### 7.2 sdk：另一套私有 JSON-RPC（全事件直通）

`packages/sdk/`（protocol/server/client 三子包）是**与 ACP 并列**的私有协议：请求 `initialize`/`session/prompt`/`shutdown`，通知 `session.event`/`session.status`/`subagent.*`，推送**完整 `SessionEvent` 信封**；与 ACP 同桥到 `ctx.agents`/事件流，但 **SDK 全事件直通、ACP 只折现已提交文本**。另有 `subagent-dsh-sdk` 后端。

**对我们的启示**：DSH 用「ACP（外部标准、薄、只文本）+ 私有 SDK（全事件直通）」**双协议面**，而非一个协议又要标准又要内部保真。我们的 `device-protocol`（mobile↔daemon）若要「既有标准协议又保事件流保真」，可借鉴这种**切面分离**。区分「源码形状」：`@agentclientprotocol/sdk` 具体帧格式因 node_modules 未安装未能展开。

---

## 8. 与「统一输入流模型」的异同

对照我们 `00-核心逻辑模型草案.md` 的模型不变量：

| 维度                          | DSH                                                                                                                    | 我们的「唯一事件流时间线 + 投影」                         | 异同                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **单一事实源**                | 会话事件日志（`Session.log`）是 **唯一可重放事实**，`deriveMessages` 派生模型历史、持久化/标题/遥测/压缩/fork 全从日志 | 唯一带类型文本节点时间线                                  | ✓ **本质同构**——DSH 正是我们目标的成熟实证（217 包仍保持单一日志）                                                                                                                                         |
| **模型可见 ⟺ 已落日志**       | 硬性运行时不变量，新模型可见输入 = 新 session 事件 + 从日志渲染                                                        | 「一切皆带类型标记输入」对应                              | ✓ 同构，且 DSH 给了我们这条铁律的 enforcement 形态                                                                                                                                                         |
| **只追加 + 逻辑截断**         | 只追加；压缩用 surface `replace` 事件 shadow 旧节点，**不改日志**                                                      | 逻辑截断（新事件）取代物理删除                            | ✓ 同构；DSH 的 `surfaceOp replace` 即「非破坏删除」范本                                                                                                                                                    |
| **投影派生**                  | surface+`deriveMessages`（模型历史）+ `session-projections` 纯折叠单位（读模型）两套投影共存                           | 消息表/前端视图都是时间线投影                             | △ DSH 区分「模型表面（可被 replace）」与「人类转录（append-only）」——这是我们要补的辨识：**UI 是真转录，模型上下文是可能折叠的视图**                                                                       |
| **进行中/终态（不变量 6）**   | `assistant/chunk`（原始 chunk）与 `assistant/message`（组装终态）**都在日志**；进行中靠 chunk 序列、终态靠 message     | ongoing=增量事件(NoPersist 可丢) / settled=必达事件(落库) | ✗ **DSH 不区分持久级**：chunk 也是 Critical 落库；我们把进行中做成 `NoPersist` 增量、终态落库——这是比 DSH「全量落库」更省吞吐的变体，但要保证 chunk 丢后 message 兜底（DSH 从不丢掉 message 也因此更简单） |
| **核心←投影←扩展←壳**         | 三层（core/ / session-* / bundle 壳层）经 Cordis DI 强制，217 包无纠缠                                                 | 分层目标 + 三层上限 + 禁逆向依赖                          | ✓ 同构且被实证                                                                                                                                                                                             |
| **扩展点：事件出 + 注册表入** | `agent/*` live 事件 + `tools/*`/`ctx.skills`/`goals`/`ctx.fs`… 注册表；扩展用 **declare-merge 扩展核心类型表**         | 核心只暴露事件出 + 钩子/注册表入                          | ✓ 同构；DSH 手法更成熟（merge `SessionEventMap`/`SessionProjectionMap`/`MessageSourceMap`）                                                                                                                |
| **前端取数**                  | 事件折叠状态机（`ConversationNodeAssembler`）+ 单投影 `useProjection` + keyed slot 单订阅                              | 单一时间线投影 store + view model                         | △ DSH 用「两轨」：实时流式走事件折叠状态机、跨会话读取走 host-pushed projection（higher-seq-wins）；我们计划单一投影 store——DSH 证明「折叠状态机 + 整值投影」而非「把 store 折叠成全部 UI」更利于增量/重放 |
| **跨会话/读取面**             | projection 持久化缓存（checkpoint/restore/restoreFloor + `stateVersion`）+ revision 令牌                               | 投影缓存/派生 store                                       | ✓ 同构，且 DSH 的 `stateVersion` 门禁与 revision 是我们要加的防护                                                                                                                                          |
| **多能力装配**                | agent preset（per-session 工具/提示词组合）+ host/agent-plane 分界                                                     | per-session 能力装配                                      | △ DSH 把「同一会话不同能力集」做成配置（cordis.yml preset），而非代码                                                                                                                                      |

**本质差异（一句话）**：DSH 是「**全量日志 + 事件语义区分进行中/终态**」，我们是「**更省吞的 NoPersist 增量 + 必达终态落库**」；我们的模型在「投影前验证」「表面 replace 与转录分离」「进行中事件持久级」上应吸收 DSH/Pi 的防护。DSH 不存在我们「进行中增量可丢」的最坏丢帧复杂度，这是一条务实 trade-off：**我们为流式吞吐省持久化，须以 `message-end` 全文兜底 + 更强的重放幂等补偿**（草案 13 审计 G1–G7 双轨撕裂即由此来）。

---

## 9. 可借鉴清单（3–5 项）

1. **`SessionEvent` 的 `ignorable` 标记 + `KNOWN_SESSION_EVENT_TYPES` 版本兜底**（`core/session/src/types.ts:422`，`known-event-types.ts:9-16`）
   新事件类型默认 required；reader 遇到不认识的非 ignorable required 事件必须拒重建，而不是静默跳过。理由：我们「唯一时间线」重放/加载时最大的风险是**旧 reader 遇到新事件静默误读**——这个「默认过拒、忘了标记宁可错杀」的取向，比「静默跳过」安全得多，且几乎零成本。

2. **`declare-merge` 三方扩展 + 整值事件 + 纯折叠**（`goal/domain.ts:55-68` 扩展 `SessionEventMap`+`SessionProjectionMap`+`MessageSourceMap`；`fold.ts` 纯折叠；`goal-round-driver` 只挂扩展点）
   一个领域扩展同时 merge 事件表/投影表/消息源表，写纯 `init/apply/view` 折叠，驱动全在扩展包内，**核心循环零改动**。理由：这正是我们「核心循环不认知扩展 + 事件出 + 注册表入」的**完整实证**，goal 续轮消息直接走 `user/message`+来源标记（等于我们的「带类型文本节点 + 感知注入」）。

3. **投影持久化缓存的 `stateVersion` + `restoreFloor` 冷读门禁**（`session-projection/index.ts:300-385`，`restore()` 对版本不符/超日志尾的行 refold-throw）
   读模型缓存 `(key,ver,seq,val)`，冷读 = 缓存 + `readFrom(floor)` 尾重放 + `view`；version 门禁保证缓存形状升级时自动废弃，日志缩水（崩溃截断）时拒 serve 陈旧只读。理由：我们「投影派生 + 缓存」必须有**版本 + 边界门禁**，这正是我们 12 审计「展示投影双实现」与 Pi 审计强调的「先验证再派生」的成熟解法。

4. **写路径：同步热路径 + write-behind 批量 + 显式 flush 反压屏障**（`core/session/index.ts:604-655` append 零 I/O；`session-persistence/src/write-behind.ts`）
   事件同步入内存日志并广播，持久化以插件形式订阅 `session/event`、按固定窗批量落盘、`session/flush` 作 awaited 检查点屏障。理由：我们 `events.rs` 的落库策略可吸收「同步入流 + 批量写 + 反压屏障 + revision 令牌」四件套，**把「进行中增量可丢」与「终态必达落库」统一到一个控制器**，减少双轨撕裂。

5. **前端「事件折叠状态机 + keyed slot 单订阅」而非单一上帝 store**（`conversation-assembler.ts` + `ChatNodeSeat.tsx:19-59` + `ChatView.tsx:382-397`）
   每一 ConversationNode 确定性折叠事件窗、整节点原子替换、只订阅自己的 key（增量不重挂）；重放靠 seq 幂等 + resync 清窗 + liveBuffer 缝补。同时保留 `useProjection`（host push 整值，higher-seq-wins）作跨会话读取面。理由：我们 12 审计主战场是「streamingStore ∥ layoutStore 消息双份」，DSH 用「折叠状态机 + 整值投影两轨」而非「把 store 折叠成全部 UI」——这正是收敛我们上帝 store / 双 store / 双轨撕裂的**更干净替代**。

---

## 附：真跑验证声明

本次为**只读源码审计**，未执行 `pnpm install` / `pnpm run build` / `pnpm test` / `pnpm dsh --profile headless` / `demo:acp`。agent-loop、session、persistence/projection、app-boot、client、acp 的全部「行为」描述源自源码守卫逻辑、运行时不变量（`invariant.ts`）、注释与官方 `docs/architecture.md` / `packages/AGENTS.md`，并以 grep 佐证。外部 `@agentclientprotocol/sdk` 具体帧格式与行为未真跑展开。若需真值验证，建议：跑 `session-persistence*` 与 `session-projection*` 单测验证写后幂等与 restore 门禁；跑 `apps/web`/`demo:acp` 验证装配与协议桥。
