# B2. TypeScript 前端/共享层代码质量抽查评审

> 范围：`apps/crish-desktop/src/` + `packages/shared-types/`（抽查，只读）
> 抽查日期：2026-08-02　|　基线：git 84d80f16
> 抽查方式：每路径读关键文件 100-200 行（部分整读），对照评估维度逐条给出 `文件:行号 + 片段 + 评价`。

---

## 0. 总体结论

**质量等级：良好（B+）。** 六个抽查路径中，IPC 契约层、生成契约代码、store 读面属于"可作范本"级；事件分发与错误处理是"经过治理的复杂度"；会话持久化存在一处真实的并发写竞争风险与一处"测试资产悬空"问题（详见路径 5）。

突出优点：

1. **类型纪律极强**：`store/` 全目录实际代码 `as any` 出现 0 次（5 处命中均为注释/README 中的禁令条款，见 store/README.md:193）；`dispatch.ts` 用 mapped type 实现**编译期穷举的分派表**（TS 侧少有的 enum-match 等价物）。
2. **三态结果贯穿**：`InvokeTypedResult`（ok/missing/error）在 transport 层统一，missing 显式、error 暂态重试一次，无静默吞错。
3. **文档密度高**：几乎每个模块头部注释都写清设计依据（引用 03 §3.x、PE-03/PE-07/AA-02 等内部文档编号）、取舍理由与残留债务（如 sessionStore.ts:6-8 显式声明 god-object 残留）。
4. **生成代码质量**：parser.ts 的 `ParseResult` 判别联合、逐字段错误信息（含数组索引）、可选字段精确 spread 构造，均规范。

主要弱点（按严重度）：

- **A. 会话持久化写模型未落地**（路径 5）：`sessionRustDb.ts` 仍是"全量并发写"旧设计，`persistAllSessionsRust` 用 `Promise.allSettled` 并发、无批次版本戳——快速连续两次 commit 可能旧数据覆盖新数据；而测试（sessionRustDbWriteModel.test.ts）已按目标写模型（串行队列+批次戳+脏增量）编写并全部失败（16/16），13 个"基线失败"实为**测试引用不存在 API**（`resetSessionWriteModelForTests is not a function`）。既是测试问题（引用悬空），也是实现滞后（写模型重构未落地）。
- **B. 静默降级掩盖协议错误**：toolUtils.ts:71 解析失败伪造 `tc-<timestamp>` 假 id；sessionRustDb 全部 invoke 失败静默回退 localStorage 且**无任何日志**；EventRouter 未知事件仅 `logInternalError`。Rust 侧这些都以 Result 显式传播。
- **C. 宽容层与严格层双轨漂移**：eventParser.ts 的 31 个手写归一器（`Record<string, Normalizer>`，无类型约束）与生成解析器并存——新增事件类型不会触发任何编译错误；归一器里多处 `as unknown as T` 裸断言（L246/267/293…）。
- **D. 字符串嗅探分支**：BridgeErrorPolicy.ts:27 用 `/checkpoint/i` 正则改判错误文案；toolUtils.ts:82 用伪造哨兵 `name === 'tool'` 判断失败——脆弱、不可维护。
- **E. 双源手工同步无结构性门禁**：命令清单 73 条、错误显示表 33 条、事件 24 型均为 Rust 真源的手工镜像，仅有条数锁测试，无逐条校验。

与 Rust 侧差异劣势清单见第 7 节。

---

## 1. IPC 契约层（apps/crish-desktop/src/api/transport/）

### 抽查表

| 位置 | 代码片段 | 评价 |
|---|---|---|
| tauriTransport.ts:158-167 `call` | `const resolved = resolveTauriCommand(cmd); if (!resolved) return { status: 'missing' };` | ✅ **类型安全/清晰度**：唯一 invoke 通道、三态结果、清单校验前置。命令缺失显式返回 `missing`，无静默兜底。 |
| tauriTransport.ts:49-65 `isCoreReady` | `for (const key of ['engineReady','engine_ready','dbReady','db_ready','searchIndexReady','search_index_ready'] as const) { if (s[key]===true) return true; }` | ⚠️ **与 Rust wire 契约一致性**：对 6 个别名键做字段嗅探。Rust 侧 `GetStatus` 是编译期结构体，TS 侧只能容忍别名——说明 wire 契约未定或前端兼容旧壳。宽容层痕迹，可接受但有别于 Rust。 |
| tauriTransport.ts:281-303 `callWithTimeout` | 超时 `reject` 后 `this.call` 仍继续执行（注释："超时即整体拒绝，不等待重试结果"） | ⚠️ **正确性（副作用）**：invoke 已在途，超时后副作用不可撤销；内部暂态重试可能在超时后才发出第二次调用。Rust 侧可用 join/cancel 语义。属文档化的权衡，但值得记录为已知缺陷。 |
| tauriTransport.ts:306-341 `ensureEventSubscription` | `this.listenStarting = (async () => { ... this.unlistenEvents = await listen(...) ... })()` | ⚠️ **并发竞态**：`stop()` 时若 listen 仍在途（`listenStarting` 非空、`unlistenEvents` 仍为 null），teardown 为空操作；随后异步完成把 `unlistenEvents` 赋值，但退订函数已丢失 → 事件通道泄漏。stop 仅退出时调用、进程级单例，影响小，但属真实缺陷。 |
| tauriTransport.ts:101-112 `fromInvokeTyped` | `logger.error('invoke failed', {...}); throw new Error(...)` | ✅ **正确性**：invoke 失败统一落日志再上抛（PE-04 关键路径接线）。 |
| commandManifest.ts:53-142 `BUILTIN_COMMAND_MANIFEST` | 73 条手工镜像 + 注释"双端手工同步，条数由本模块测试锁定" | ✅ **可维护性（有门禁）**：双源漂移用"条数/登记断言"测试拦截，是 TS 侧少有的结构校验。但门禁是测试时，Rust 新增命令到前端可用之间无编译期保障。 |
| commandManifest.ts:178-192 `initCommandManifest` | `if (manifestInitStarted) return manifestInitStarted;`（失败不重试） | ✅ **正确性**：幂等防并发；失败回退内置快照不崩（注释明示"不重试"是有意为之）。 |
| commandMap.ts:29-41 `COMMAND_NAME_ALLOWLIST` | 仅 9 条（core_get_status / core_approve_tool / config_update / list_sessions…） | ⚠️ **门禁覆盖不全**：清单 73 条，幽灵回归门禁只覆盖 transport 直接依赖的 9 条——`core_run_task` 等核心命令的"幽灵化"不会被启动期检查捕获（它们仅依赖每调用时 `resolveTauriCommand` 的运行时 missing）。门禁语义是 `logger.warn` 不阻断，见 L58-67。 |
| commandMap.ts:77-82 `PAYLOAD_SHAPERS` | `config_update: (p) => { const { type: _type, apiKey: _apiKey, ...rest } = p; return rest; }` | ✅ **正确性（安全）**：明文 apiKey 禁止走 config_update 通道（PE-07 T07.4 K-05），destructure 剥离模式清晰。 |

**小结**：路径 1 是六个路径中工程化最完整的：唯一通道 + 三态 + 清单前置校验 + 测试钩子（`resetCommandManifestForTests`）齐备。缺陷集中在两处并发（超时副作用、stop/listen 竞态）与门禁覆盖范围。

---

## 2. 事件分发（api/chat-bridge/）

### 抽查表

| 位置 | 代码片段 | 评价 |
|---|---|---|
| handlers/dispatch.ts:52-79 `engineDispatchTable` | `export const engineDispatchTable: { [ET in EngineEventType]: EngineHandler<ET> } = { 'agent-start': onAgentStart, ... }`（24 键） | ✅ **编译期穷举**：mapped type 保证 24 键完备——TS 侧最接近 Rust `match` 的形态。新增事件类型若缺 handler 会编译失败。这是本路径最大的亮点。 |
| handlers/dispatch.ts:99 | `const handler = engineDispatchTable[envelope.type] as EngineHandler<EngineEventType>;` | ⚠️ **必要的类型断言**：索引 union 后需断言才能以具体信封调用。运行时键必存在（表完备），断言是安全的，但若未来有人误删表键，此处静默变 `undefined` 调用崩溃——可加一行防御（`if (!handler) return`）更稳。 |
| EventRouter.ts:87-112 `onMsg` | `const seq = extractEventSequence(raw) ?? extractEventSequence(raw.event) ?? ...`；`if (seq != null && seq > this.lastAppliedSequence) this.lastAppliedSequence = seq;` | ⚠️ **游标形同虚设（清晰度/正确性）**：`lastAppliedSequence` 只记 max，不用于乱序重排、去重或断流重放（StreamRecovery 已删）。若 Tauri 事件乱序到达，事件按到达顺序应用，游标不提供任何保护。要么实现重排/去重，要么删掉字段——当前是"半死代码"。 |
| EventRouter.ts:93 + eventUtils.ts:30-39 `messageBelongsToRun` | `if (msgRunId == null) return true;` | ✅/⚠️ **语义**：无 runId 事件放行（容忍 subagent 等跨 run 事件），是刻意的宽容设计；但 runId 为空串也放行，若 Rust 端偶尔发空 runId 会误收他 run 事件——低风险。 |
| handlers/eventParser.ts:461-493 `parseBridgeEvent` | 优先级：生成解析器 → 手写归一器 → legacy → `parseErr` 登记 | ✅ **模块边界清晰**：单一解析入口、失败显式登记（`registerUnknownEvent` 不静默吞）。四源失败统一收敛 `surfaceStreamFailure`（03 §2.4 表）。 |
| handlers/eventParser.ts:212-454 `ENGINE_NORMALIZERS` | 31 个键；`'message-start': (raw) => ({ ..., message: isRecord(raw.message) ? raw.message as unknown as AgentMessage : emptyAgentMessage() })` | ⚠️ **类型安全**：`as unknown as T` 裸断言 10+ 处（L246/267/293/309/364/379/409/439/447…），且归一器表是 `Record<string, Normalizer>`——**新增事件类型不会引起任何编译错误**（与 dispatch 表形成鲜明对比）。宽容层与生成层存在语义漂移风险：生成解析器严格、归一器"填默认值"（`num(...) ?? 0`、`calls: []` 硬编码 L322/329），Rust 缺字段被静默补零而非 fail-fast。 |
| eventParser.ts:311 `tool-end` | `isError: r.isError === true || (r.error != null && r.error !== false)` | ⚠️ **正确性（边界）**：`error: ""`（空字符串）也会判为 `isError: true`（`"" != null` 恒真）。toolUtils.ts:36 同病。应加 `r.error !== ''` 或改为 `typeof r.error === 'string' ? r.error !== '' : r.error != null`。 |
| eventParser.ts:181-204 `normalizeRunTerminal` | 拼写变体容忍 `cancelled/canceled`、`failed/error` | ✅ **宽容层设计有注释、有意图**：历史别名（text-delta/run-*）收敛到单一入口，避免双 zod 时代的交叉 fallback 混乱。 |
| handlers/toolUtils.ts:61-72 `toolCallFields` | `if (parsed.ok === true) return parsed.data; logInternalError(...); return { id: \`tc-${Date.now()}\`, name: 'tool', args: '', explanation: '' };` | ⚠️ **静默降级伪造数据**：解析失败生成假 toolCallId（`tc-<timestamp>`），UI 会继续以假 id 渲染工具状态；同文件 L82 又用 `name !== 'tool'` 哨兵判断该失败态——**用伪造值当失败信号**，若真实工具名恰为 "tool" 则误判。建议改返回 `null`/`{ ok: false }`，由 handler 决定降级策略。 |
| handlers/eventType.ts:1-8 | `export { resolveEventType } from './eventParser';` | ✅ 8 行 re-export 兼容位，注释说明历史（"原双 zod 模块交叉 fallback 已删"）。 |

**小结**：分派表是编译期安全的范本；EventRouter 职责单一。主要债务在宽容归一器（裸断言 + 无类型约束的表 + 伪造降级值）与未使用的 sequence 游标。`error === ""` 的边界 bug 值得立即修复。

---

## 3. 生成契约代码（packages/shared-types/src/generated/engine/）

### 抽查表

| 位置 | 代码片段 | 评价 |
|---|---|---|
| parser.ts:1-7 | `// GENERATED FILE - DO NOT EDIT BY HAND. Source of truth: crates/conex-types/src/events.rs ... Generator: scripts/generate-engine-bindings.mjs` | ✅ **可维护性**：真源/生成器/再生成命令三要素齐全，可复现。 |
| parser.ts:14-36 `ParseResult<T>` | `{ readonly ok: true; readonly data: T } \| { readonly ok: false; readonly error: string }` + `isParseOk` 类型守卫 | ✅ **类型安全**：判别联合等价 Rust `Result<T, String>`；`readonly` 贯穿。 |
| parser.ts:96-113 `reqField`/`optField` | `if (!(key in obj)) return parseErr("missing required field '" + key + "'");` | ✅ **错误信息质量**：含字段名；`parseArrayOf` 报 `"array item 3: ..."` 带索引（L90）——可诊断性优于多数手写解析。 |
| parser.ts:115-225 字符串枚举解析 | `if (typeof v === "string" && (AGENT_MESSAGE_ROLE_VALUES as readonly string[]).includes(v))` | ⚠️ 微小噪音：双断言（`as readonly string[]` + `v as AgentMessageRole`）+ O(n) 线性扫描。可改用 `satisfies` 数组的 `includes` 签名或 `Set`，但 24 个枚举均同模板——属生成器模板可优化项，非错误。 |
| parser.ts:56-80 `checkJsonValue` | 递归无深度限制 | ⚠️ **正确性（边界）**：深层嵌套（>1e4 层）可致栈溢出；Rust serde_json 默认 128 层递归限制。异常载荷/恶意事件可触发。生成器应加深度上限。 |
| parser.ts:1284-1315 `parseEngineEvent` | `switch (t) { case "agent-start": ... default: return parseErr(...) }` | ✅ 机械工整，24 型全对。 |
| events.ts:199-202 | `EngineEvent = 24 型联合` + `ENGINE_EVENT_TYPES as const` + `EngineEventType` | ✅ **编译期链**：dispatch.ts 的 mapped type 直接依赖此联合——**事件类型是"一改全报错"的强链接**，这是 TS 侧最值得保留的资产。 |
| parser.ts 逐事件解析（如 227-252 `parseAgentMessage`） | 每字段 `reqField` + `parseOk({ ...(metadata.data !== undefined ? { metadata } : {}) })` | ✅ 可选字段精确 spread，不落 undefined 键；1316 行无一处 `any`。 |

**小结**：生成代码机械、一致、无手写痕迹，与 Rust serde 输出同构（camelCase）。三个可改进点：递归深度限制、枚举 `includes` 噪音、单文件 1316 行的冗长（可生成更紧凑的表驱动解析）。**最大隐患不在生成代码本身，而在下游宽容层（eventParser.ts）证明了"严格 schema 与实际 wire 输出不一致"**——即 Rust 端实际 emit 的事件常缺字段，前端不得不用手写归一器兜底，而手写层不随生成器同步。建议：让生成器基于 Rust **真实序列化输出**（而非理想 schema）生成，缩小宽容层必要性。

---

## 4. 状态管理（apps/crish-desktop/src/store/）

### 抽查表

| 位置 | 代码片段 | 评价 |
|---|---|---|
| store 全目录 | `as any` 实际代码 **0 处**（rg 命中 5 处均为注释/README 禁令） | ✅ **类型纪律**：README.md:193 明令禁止 `as any`/`: any`/`as unknown as any`；抽查 layoutStore/sessionActions/workspaceActions 中提到的 "as any" 均为注释里的设计说明。 |
| storeAccess.ts:42-127 selectors | `export const selectTerminalLines = (s: Pick<TerminalStore, 'terminalLines'>) => s.terminalLines;` | ✅ **类型安全/可维护性**：`Pick<Store, key>` 精确收窄，selector 可组合、可测试，杜绝散落直连 `useXStore()` 的组件读面（T14 依赖规则据此守门）。 |
| storeAccess.ts:8-14 | 双 storeAccess 说明（store/ 读面 vs api/ 编排门面） | ✅ **清晰度**：模块边界文档化，避免"两个同名模块"的混乱。 |
| sessionStore.ts:42 | `export const useSessionStore = useLayoutStore;` | ✅/⚠️ **god-object 残留显式声明**（L6-8 "intentional residual"）：Sessions 仍住在 layoutStore 上。诚实标注 + 给出新代码路径指引（compositionRoot.session）。渐进治理而非粉饰。 |
| sessionStore.ts:212-213 | `return useSessionStore.getState() as unknown as SessionFacade;` | ⚠️ **投影断言**：`as unknown as` 是命名门禁要求的窄化（注释 L210）。运行时若 LayoutStore 缺 Facade 字段，返回 undefined 到消费方才炸——Rust 侧无此问题（结构体天然带字段）。TS 侧可用一条 `assertFacadeShape()` 启动校验补强。 |
| sessionStore.ts:109-134 `useSidebarSessions` | `useSyncExternalStore` + `snapshotRef` + `sidebarSessionsEqual` 等值拦截 | ✅ **正确性（性能）**：流式 message-delta 改正文时 sessions 引用变化但侧栏壳字段不变 → 不重渲染（AA-03 Q19 模式）。实现正确但复杂度高，需维护者理解 useSyncExternalStore 快照语义。 |
| layout-helpers/store-types.ts:17-21 | `export const UI_SIZE_IDS = ['small','medium','large'] as const satisfies readonly UiSize[];` | ✅ **现代 TS 用法**：`satisfies` + `as const` 双保险（类型收窄且字面量派生态枚举），同一文件集中 storage key 常量防字面量漂移。 |
| sessionStore.ts:274-276 | `sessionRuntimeRegistry.registerActiveIdResolver(() => useSessionStore.getState().activeSessionId)` | ✅ 模块加载期注册解析器，模式一致。 |

**小结**：store 层是六个路径中类型纪律最好的一层——0 处 as any、selector 收窄成体系、域拆分（layout-helpers/、workspace-shell/、layout-tree/）边界清楚、god-object 残留被显式治理（facade + 文档 + 门禁）。主要短板是 facade 投影缺乏运行时形状校验，以及 useSyncExternalStore 手写订阅的维护成本。

---

## 5. 会话持久化（api/session-persistence/）——含 13 个基线失败归因

### 5.1 测试失败归因（先回答任务书问题）

**结论：测试问题（引用悬空），根源是实现滞后于测试规划。不是 sessionRustDb.ts 的实现 bug。**

实测（`npx vitest run sessionRustDbWriteModel.test.ts`）：16/16 失败，全部同一错误：

```
TypeError: resetSessionWriteModelForTests is not a function
  于 sessionRustDbWriteModel.test.ts:205:3（beforeEach）
```

- 测试文件 L41-46 从 `./sessionRustDb` import `resetSessionWriteModelForTests`、`setLegacyLocalStorageCleaned`——**sessionRustDb.ts 全文件无这两个导出**（grep 仅命中测试文件自身）。
- 测试断言的目标架构（文件头注释 + 用例名）：P08 串行写队列+批次版本戳、P09 SQLite 优先真相源切换、P10 hydrationComplete 门闩、F7 脏会话增量写、写后读回校验、P17 LS 镜像移除——**均未在 sessionRustDb.ts 实现**。该文件是旧写模型：`persistAllSessionsRust` 全量 per-session invoke + `Promise.allSettled`（L819-831）、LS 索引为真相源（L796）、LS 镜像保留（L525-527）。
- `cleanupLegacyLocalStorageSessions`/`runMigrationCleanupIfNeeded` 存在，但在 migrateFromLocalStorage.ts:187-212，与写模型无关。

即：这批测试是为 PE-08（T08.10）目标写模型提前编写的，**目标态未落地**，测试处于"悬空"状态——既测不到真实实现，也无保护作用。13 个"基线失败"是这个漂移的表现，不是随机红。

### 5.2 实现质量抽查表

| 位置 | 代码片段 | 评价 |
|---|---|---|
| sessionRustDb.ts:69-128 `RustSessionMessage` 等 interface | 手工镜像 Rust serde 形状 + 头部注释表列明 JS↔Rust 字段差异（toolCallsJson/stream_text_offset…） | ✅ **类型安全**：接口级对齐文档化；`toRustSessionMessage`（L162-180）精确省略 null 字段，不污染 wire。 |
| sessionRustDb.ts:245-267 `fromRustSessionMessage` | 先拼 `normalized: unknown` 再过 `parseSessionMessage` 形状守卫 | ✅ 复用 sessionHydration 守卫，双保险。 |
| sessionRustDb.ts:489-532 `listSessions`/`saveSessionBody` | `if (res.status === 'ok') return ...; return lsLoad...();` | ⚠️ **静默回退（可运维性）**：`error` 状态（非 missing）也一律回退 localStorage，且**全文件无一处 `logger.error` 记录失败原因**——SQLite 写失败在运维上不可见，用户数据实际只落在 LS。文件头注释（L22-24）承认该设计（"错误细节仅日志记录"），但实现里没有日志调用，注释与实现不符。 |
| sessionRustDb.ts:780-845 `persistAllSessionsRust` | `bodyJobs.push(saveSessionBody(...)); await Promise.allSettled(bodyJobs);` | ⚠️ **并发写竞争（正确性，最严重）**：无串行队列、无批次版本戳。两次快速连续 commit：第一次保存慢、第二次保存快 → 后写的旧批次覆盖新批次。测试 T08.10 第一条用例（"快速连续 commit：并发两批次不交错、不丢数据"）正是为此设计——**测试暴露的真实风险因测试悬空而未被保护**。Rust 侧 SQLite 事务 + updated_at CAS 哨兵可防，前端层无对应。 |
| sessionRustDb.ts:815-817 | 注释："空 messages 不调用 save_session_body：Rust 侧是先删后插，空数组会擦掉已落盘正文" | ✅ **正确性细节**：显式规避空数组擦库风险，含懒壳窗口意识（与 P10 目标态呼应，实现中仅以注释和空数组守卫体现）。 |
| sessionRustDb.ts:727-753 `hydrateSessionsFromRust` | `Promise.all(ordered.map(async (e) => { const [messages, agents] = await Promise.all([...]) }))` | ⚠️ 全量并行加载 N 会话 × 2 命令——大会话列表下 IPC 洪水；无并发上限（目标态应有懒加载/分页，测试 P10 亦暗示）。 |
| sessionRustDb.ts:808-813 | probe：每次 persist 前先 `list_sessions` 探测 invoke 可用性 | ✅/⚠️ 探针设计务实；但每批 persist 多一次 IPC。 |
| sessionRustDb.ts:899-957 `persistAllSessionsSyncViaLocalStorage` | beforeunload 同步路径，注释明示"禁止 await" | ✅ 场景约束文档化，与异步路径行为对齐（剔除 PENDING_DRAFT、空 body 不覆盖）。 |

**小结**：实现自身逻辑自洽、形状转换严谨、边界注释详尽（I-DRAFT 哨兵、懒壳、先删后插防擦库）。三大债务：(1) 测试与实现漂移（5.1）；(2) 并发写竞争无保护；(3) invoke 失败静默且无日志。

---

## 6. 错误处理（utils/error-translation.ts + api/chat-bridge/BridgeErrorPolicy.ts）

### 抽查表

| 位置 | 代码片段 | 评价 |
|---|---|---|
| error-translation.ts:227-244 `mapSeverity` | 显式 switch（transient→warning / permanent→error / security→error / protocol→warning / 未知→error）+ 特例 `runtime.aborted`/`provider.cancelled`→silent | ✅ **清晰度/正确性**：取消类错误不打扰用户的特例先行，语义完备。 |
| error-translation.ts:60-203 `BUILTIN_ERROR_DISPLAY` | 33 条码 → title/action 英文回退表 | ⚠️ **双源漂移**：注释称"与 77 码注册表一致"（Rust T06.5.8），但**无自动化校验**（无测试断言 33 条 ⊆ Rust 注册表）。新增 Rust 错误码不会让任何 TS 测试失败——查表未命中仅回退通用文案，静默。 |
| error-translation.ts:324-342 `normalizeCrishError` | 优先级：null → CrishError 实例 → 鸭子类型（含 code+category 字符串字段）→ 字符串 → Error | ✅ **类型安全**：5 级兜底阶梯清晰，`instanceof CrishError` 优先于鸭子类型（注释解释原因）。⚠️ 鸭子类型仅查 2 字段即认定 payload——缺 retryable/public 等字段的截断载荷会被放行，消费方读到 undefined 字段。可接受（防御性）但与 Rust 完整反序列化有差距。 |
| error-translation.ts:357-379 `fromErrorPayload` | cause 链递归还原，`depth < CRISH_ERROR_CAUSE_MAX_DEPTH`(8) 截断 | ✅ 与 toErrorPayload 截断对称，防无限递归。 |
| BridgeErrorPolicy.ts:14-41 `surfaceStreamFailure` | 集中四源失败：classify → format → softFailure 优先级 → recordStreamDiag → onRunError | ✅ **模块边界**：41 行单职责，与 EventRouter 的四源收敛（03 §2.4）对应。 |
| BridgeErrorPolicy.ts:27-29 | `if (/checkpoint/i.test(String(raw || '')) || /checkpoint/i.test(scope)) { msg = formatted.message; }` | ⚠️ **字符串嗅探分支（可维护性）**：用正则匹配错误串/scope 判断"checkpoint 类错误走原始消息"。错误码体系存在（CrishErrorPayload.code）却不用码判断——码改名即失效。建议改为 `kind === 'checkpoint-*'` 或 code 断言。 |

**小结**：错误处理整体是高分的——结构化错误载荷（CrishErrorPayload）贯穿 IPC、分类映射显式、cause 链双向截断一致、兜底阶梯完整。两处可维护性债务：错误码双源无门禁、checkpoint 正则嗅探。

---

## 7. 与 Rust 侧同类的差异劣势清单

| # | 差异点 | TS 侧表现 | Rust 侧对应 | 影响 |
|---|---|---|---|---|
| 1 | 编译期穷举 | 仅 dispatch.ts 分派表（mapped type）与事件联合有穷举保障；归一器表 `Record<string, Normalizer>`、错误码表、命令清单均无 | `match` 表达式、`#[derive(Serialize/Deserialize)]` 枚举反序列化失败即编译/运行时错误 | 新增事件/错误码在 TS 侧零告警，漂移只能靠运行时日志 |
| 2 | wire 契约漂移发现时机 | 运行时：命令 missing 抛错、事件未知登记、宽容层补默认值 | 编译期：invoke_handler 注册、serde 严格字段 | "宽松补零"掩盖 Rust 端缺陷，线上以坏数据呈现 |
| 3 | 错误传播 | 多处静默降级：invoke 失败→LS 回退（无日志）、toolCallFields 失败→伪造假 id、未知事件→logInternalError 后丢弃 | `Result<T, CoreError>` 显式传播，`?` 向上抛 | 运维盲区：SQLite 写失败、协议损坏不可见 |
| 4 | 边界校验 | 无深度限制的 `checkJsonValue` 递归（栈溢出风险）、`error: ""` 判真值、无数字范围校验 | serde_json 128 层递归上限、类型系统强约束 | 异常载荷可致崩溃/误判 |
| 5 | 数据竞争防护 | persist 并发批次无串行队列/版本戳，全量写 + Promise.allSettled | SQLite 事务 + updated_at CAS + spawn_blocking 串行化 | 旧批次覆盖新批次（数据丢失窗口） |
| 6 | 单一真源 | 命令清单/错误码表/事件 schema 三处手工镜像 Rust（有测试锁条数） | 单一定义源 + 注册宏 | 手工同步遗漏即幽灵回归 |
| 7 | 门禁强度 | `logger.warn` 不阻断（checkCommandMapConsistency、未知事件登记、门禁覆盖仅 9/73 命令） | 编译错误强制处理 | 回归仅告警，不阻止发布 |
| 8 | 运行时形状保证 | facade 投影 `as unknown as SessionFacade`、鸭子类型认 payload，无启动校验 | 结构体静态类型 | 字段缺失在消费时才炸 |

---

## 8. 改进建议（按优先级，仅建议不实施）

1. **P0**：修复 eventParser.ts:311 / toolUtils.ts:36 的 `error: ""` 误判 isError。
2. **P0**：落地产出写模型（PE-08 T08.10：串行队列 + 批次版本戳 + 脏会话增量），或删除悬空测试并在测试头标注"目标态未实现"；恢复测试保护前先让 `resetSessionWriteModelForTests` 有真实对偶。
3. **P1**：sessionRustDb invoke 失败路径补 `logger.error`（注释承诺的"仅日志记录"未兑现）。
4. **P1**：toolCallFields 失败改返回显式失败标记，去掉 `tc-<timestamp>` 假 id 与 `name === 'tool'` 哨兵。
5. **P1**：`checkJsonValue` 加深度上限（与 serde 128 层对齐）。
6. **P2**：dispatch.ts:99 加 `if (!handler) return` 防御；tauriTransport stop/listen 竞态补退订兜底。
7. **P2**：BridgeErrorPolicy checkpoint 分支改用错误码断言；`isCoreReady` 别名键收敛到单一契约。
8. **P2**：错误码表（33 条）与命令清单（73 条）加"⊆ Rust 注册表"的生成校验（可复用 generate-engine-bindings.mjs 管线）。

---

*评审方式说明：本次为抽样审查（每路径读关键函数/文件 100-200 行，部分整读），未运行全量 lint/typecheck；"0 处 as any"等统计基于 rg 全目录扫描。测试失败归因基于实际运行 vitest 复现。*
