# P6：TS 侧协同、降级路径对齐与测试基准

- 撰写日期：2026-08-03
- 文档性质：方案文档（只读 + 仅产出本文档，未修改任何源代码）
- 上游依据：
  - `docs/cache-optimization/02-comparison/comparison.md`（技术选型 3.3 节：TS 侧只保留定价展示、事件透传、UI 展示与降级路径对齐；3.1 节结论：核心缓存优化全部落 Rust，TS 只做协同）
  - `docs/cache-optimization/01-reference-research/opencode-cache-analysis.md`（tools 排序与 schema 规范化 opencode-cache-analysis.md:180-187；prompt_cache_key = sessionID opencode-cache-analysis.md:110-121；usage 恒等式 opencode-cache-analysis.md:193-205）
  - `docs/cache-optimization/01-reference-research/kimi-code-cache-analysis.md`（CLI debug 命中率行 `cache read N (xx%)` kimi-code-cache-analysis.md:262-264；会话亲和键 kimi-code-cache-analysis.md:95-107）
- 本方案性质声明：**P6 是"TS 侧协同契约"方案，不是实现清单**。P2（usage 字段补齐）、P3（prompt_cache_key Rust 侧注入）、P5（前端展示逻辑 + 会话级缓存统计事件 `CacheDomainEvent`）会以本方案定义的前端侧契约（3.3/3.4 节）为输入；【A1 审计修正：原稿"P2（usage 字段补齐与缓存事件）"归属错误——会话级缓存统计事件由 P5 S3 新增（P5 §3.1.3），P2 不产生新事件，P2 的事件面产出仅为 ProviderUsage 字段与 CacheBreakdown 派生】本方案自己落地的是：① 规范化规则单一文档化标准（3.1 节，TS/Rust 双侧共享的"规则真源"）、② 前端数据契约与组件骨架占位（3.3 节）、③ 测试与基准基建（3.5 节）。降级路径对齐（A）以规则标准 + TS 侧实现契约形式给出，**不要求本轮同步改 Rust 主路径**（P1 负责主路径实现，但必须逐条对照本文档 3.1 节的规则清单）。

---

## ① 目标与范围

### 1.1 目标

1. **降级路径对齐升级（A）**：`directFetchBridge.ts` 的 schema 规范化与排序规则，从"自成一体的 TS 私有实现"升级为"与 Rust 主路径（P1）共享同一套文档化规范标准"的 TS 侧实现。规则必须同一文档化标准，双侧实现一致；键推导（prompt_cache_key）规则与 P2/P3 一致（sessionId 钳制 64 字符）。
2. **前端缓存收益展示占位（B）**：定义前端缓存数据契约（TS 类型）、usage 解析纯函数与组件骨架位置；最终展示逻辑在 P5 完成，本方案只把"契约 + 骨架 + 默认态"钉死。
3. **会话亲和信息（C）**：明确前端 startRunTask 参数中 sessionId 的缓存域语义，以及是否需要扩展参数携带缓存键元数据。
4. **测试与基准基建（D）**：缓存相关 e2e（mock 引擎 cache fixture、命中率指标断言）、vitest 单测（usage 解析、cache key 计算）、基准（若需要）。
5. **兼容与迁移（E）**：老会话/老持久化数据无 cache 字段时的默认值处理；shared-types 类型契约升级步骤（含 generated 产物重生成纪律）。

### 1.2 范围边界

| 维度       | 本方案覆盖                                                       | 明确排除（交给对应计划）                                                                                             |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 规范化规则 | **定义规则清单 + TS 侧实现契约 + 交叉验证测试**                  | Rust 主路径落实现场（P1）；`registry.rs` 排序、`streaming.rs` 快照锁定（P1）                                         |
| 缓存键     | 键推导规则文档化、TS 侧 `derivePromptCacheKey`、降级路径键源切换 | Rust 请求体注入 prompt_cache_key（P3）；vendor 能力表（P3）                                                          |
| usage      | 前端解析契约（`parseUsageFromMetadata` 等纯函数）与展示默认态    | Rust `parse_usage` 字段补齐（P2）；会话级缓存统计事件（P5，`CacheDomainEvent`）【A1 审计修正：原稿"（P2）"归属错误】 |
| 展示       | 数据契约、组件骨架占位、testid 契约、默认态                      | 真实展示逻辑与视觉设计（P5）                                                                                         |
| 测试       | cache fixture、命中率断言、usage/cache-key 单测、基准            | 其余既有测试改造                                                                                                     |
| 迁移       | 默认值语义、shared-types 版本化步骤                              | 持久化模型加列（P5 关联的 sessionRustDb 改造）                                                                       |

### 1.3 设计原则（对齐 comparison.md 3.1 的选型结论）

- **TS 层不新增产品主路径的缓存能力**：`directFetchBridge.ts` 文件头（directFetchBridge.ts:4-11）已明令"DEGRADED ONLY, not product SoT"，Comparison 3.2 第 2 点进一步确认该文件的缓存增强应视为"参考实现"。本方案不扩大它的产品职责，只把它的**规则**收敛到共享标准。
- **规则单一真源在文档**：3.1 节规则清单即真源；TS 侧实现（shared-utils）与 Rust 侧实现（P1）都是它的"方言"，任何一侧行为与规则冲突即视为 bug。
- **契约先行、展示后置**：P6 产出类型与纯函数；P5 消费并渲染，不互相阻塞。

---

## ② 现状证据

### 2.1 降级路径现状（directFetchBridge.ts）

| 能力                     | 位置                              | 现状行为                                                                                                                                                                                 | 与主路径（P1 目标）的偏差                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalizeJsonSchema` | directFetchBridge.ts:37-61        | 只做**一层**：properties 键升序 + required 升序；其余字段（type 数组、布尔 schema、const、$defs 等）原样保留；**不递归**嵌套 properties 的子 schema                                      | 递归缺失 → 深层 schema 键序不稳定；未处理 opencode sanitize 类形态（布尔 schema/类型数组/const→enum，opencode-cache-analysis.md:185）                                                                                                                                                                                                                               |
| `formatStableTools`      | directFetchBridge.ts:64-76        | 按 `name.localeCompare(b.name)` 升序排序，输出固定 `{type:'function', function:{name,description,parameters}}` 形状                                                                      | `localeCompare` 依赖宿主 ICU，与 Rust `String::cmp`（UTF-8 码点序）**不保证一致**——跨侧字节一致性有风险                                                                                                                                                                                                                                                             |
| `buildStableCacheKey`    | directFetchBridge.ts:79-87        | FNV-1a 对 `{systemPrompt, tools}` JSON 序列化结果哈希 → `crish-prefix-<hex>`                                                                                                             | **前缀内容哈希**而非会话 ID；P2/P3 规则是 **sessionId 钳制 64 字符**（对齐 pi-cache-analysis.md:141-143 的码点钳制；opencode 全家 `promptCacheKey = sessionID`，opencode-cache-analysis.md:110-121；kimi sessionId→cacheKey，kimi-code-cache-analysis.md:95-107）。内容哈希的缺陷：tools 表一旦增删工具，键即变化，无法享受"同一会话前缀演进仍可命中"的服务端缓存域 |
| 键注入                   | directFetchBridge.ts:175-176、207 | `prompt_cache_key: cacheAffinityKey` 恒注入（对 DeepSeek 是静默忽略字段）                                                                                                                | 主路径由 vendor 能力表控制是否注入（P3）；降级路径可保持"恒注入"（语义无害），但键源必须改为会话 ID                                                                                                                                                                                                                                                                 |
| usage 捕获               | directFetchBridge.ts:269-282      | `hit = prompt_cache_hit_tokens ?? prompt_tokens_details.cached_tokens ?? 0`；`miss = prompt_cache_miss_tokens ?? max(0, prompt - hit)`；命中时 `onThought("[KV Cache: N hit / N miss]")` | 缺 Kimi 顶层 `cached_tokens` 一级；命中率计算（hit/inputTotal）没有显式函数；提示走 onThought 属于临时通道，非结构化数据（对齐 kimi-code-cache-analysis.md:262-264 的 debug 行语义，但 P6 不迁移这条提示）                                                                                                                                                          |

### 2.2 降级路径的使用状态

- `ConnectionLifecycle.ts:8-17` 明列已删项：WS daemon 与 directFetch HTTP SSE 降级分支（`ALLOW_AUTO_DIRECT_FETCH_FALLBACK` 已删）；`ConnectionLifecycle.ts:168-180` 核心未就绪 → **拒绝启动，无降级**。
- 因此 directFetchBridge 目前只剩：显式测试（stressFuzzing.test.ts Probe E，:121-165 直接 import 三个导出函数）与离线/dev 手工场景。**P6 的目标不是复活它，而是让它与主路径共享同一套规范，保证"如果未来需要降级，行为可预期"**（对齐 comparison.md:363-364 表格"降级路径对齐"行的职责描述）。

### 2.3 前端展示与定价现状

- `pricingStore.ts`：4D 定价已完备——`estimateCostUsd4d`（pricingStore.ts:99-121，nonCached = prompt - read - write，Pcr 0.1x / Pcw 1.25x）、`estimateSavingsUsd`（:126-136）、用户可编辑价格表（:22-51）。**缺的是消费端**：没有任何 UI 传入 cacheReadTokens/cacheWriteTokens。
- usage 数据流现状：Rust 侧 `build_assistant_message` 把 usage 塞进消息 `metadata.usage`（comparison.md:25 引 streaming.rs:291-332）；TS 侧 `AgentMessage.metadata` 是 `JsonObject`（message.ts:37），**没有结构化 usage 解析消费者**。
- 事件通道：`message-end`（事件解析入口 eventParser.ts:450-482 `parseBridgeEvent`）携带完整 message；前端 store 落消息时 `metadata` 原样保留。P5 展示的输入就从这个 metadata 来。

### 2.4 会话亲和现状（startRunTask 参数面）

- `ConnectionLifecycle.createStreamSession` 组装 run-task 参数（ConnectionLifecycle.ts:290-313）：runId / prompt / sessionId（经 `normalizeStreamSessionId`，eventUtils.ts:22-28）/ permissionMode / cwd / systemPrompt / clientMessageId 等。
- `startRunTask(transport, params)`（transport/index.ts:35-40）是 `Record<string, unknown>` 透传 → `core_run_task`。**sessionId 已经在传**——会话亲和所需的"最小信息"前端已具备。
- 现状问题：`systemPrompt` 经 ConnectionLifecycle.ts:307 下发但 Rust `core_run_task` 签名不接收（comparison.md:18、97），serde 静默丢弃——这是 comparison.md 2.3 已登记的既存问题，属于 P1/P4 范畴，P6 不重复设计。

### 2.5 测试与基准基建现状

- e2e：`tests/e2e/`（Playwright L2 mock 引擎，根 `playwright.config.ts`）。mock 引擎 `mock-engine.ts` 支持 `config.runStream.events` 事件编排（:241-265 `runTask`）、`installMockEngine`（:436-446）、`emitEngineEvent`（:449-459）、`engineState`（:462-469）；事件 fixture 真源模式见 `fullJourneyRunEvents`（:476-518）等。`full-journey.spec.ts:144-175` 已示范 `core_run_task` 参数断言（`lastRun.args`）。**缺：带 usage/cache 字段的 fixture、命中率展示断言。**
- vitest：`apps/crish-desktop/vitest.config.ts`（jsdom + test-setup.ts + 覆盖率门槛）；stressFuzzing.test.ts Probe E 已覆盖"规范化确定性 + 键计算等价"（:121-165），但断言的是**当前**内容哈希键。根 `vitest.config.ts` 排除 `__tests__/e2e`。
- 基准：`packages/shared-utils/src/bench/bench-definitions.ts`（BENCHMARKS 数组 + PerfBenchmark `{name, setup, run, iterations, warmupIterations, target}`，:36-232），入口 `run-benchmarks.ts`，CI 走 perf-test.yml。**缺：schema 规范化/键计算基准项。**

### 2.6 shared-types 契约现状

- `ProviderUsage`（tool.ts:283-290）：prompt/completion/total/cacheRead/cacheWrite/reasoning 六字段，全可选——**缓存字段早已在类型层存在**，缺的是消费。
- `AgentMessage.metadata?: JsonObject`（message.ts:37）——usage 挂载点。
- `generated/engine/`（types.ts / events.ts / parser.ts / index.ts）为**生成产物**，由 `scripts/generate-engine-bindings.mjs` 生成（根 package.json `gen:engine-bindings`）。新增引擎事件字段必须走生成器，不能手改生成文件。
- 事件类型 `AgentDomainEvent` 等（events.ts:5-41）目前无"会话缓存统计"事件——P5 若加（`CacheDomainEvent` 三变体，P5 §3.1.3），需在 Rust 侧事件定义 + 生成器 + 本方案 3.3 契约三处同步。【A1 审计修正：原稿"P2 若加"归属错误——事件新增归 P5 S3】

---

## ③ 设计

### 3.1 规范化规则单一标准（Canonical Rule Set）——主题 A 的规则真源

**本小节是 TS/Rust 双侧共享的规则真源。** P1 在 Rust 主路径实现时，必须逐条对照本清单；TS 侧实现（3.2 节）与 Rust 侧实现都不得自行增删规则。任何一侧行为与下列规则冲突即视为 bug（由交叉验证测试钉死，见 3.5.2）。

#### R1 工具排序（tools ordering）

- 规则：工具定义按 **name 升序**排列；排序比较**按 UTF-8 码点**（Rust `String::cmp` 语义），**禁止使用 localeCompare / locale 相关比较**（ICU 环境差异会破坏跨侧字节一致性，见 2.1 表）。
- 排序输入：完整工具集（每个 run 的最终发送集）；输出：稳定排序数组。
- 例外：无（排序不依赖注册序、时间戳、插件加载序）。
- 参考：jcode `sort_by(|a, b| a.name.cmp(&b.name))`（comparison.md:65）；opencode `toSorted` localeCompare 仅在单侧环境可用，crish 跨侧必须用码点序（本规则即对 opencode 的本地化修正）。

#### R2 schema 规范化（JSON Schema canonicalization）

对工具 inputSchema 执行**递归**规范化，规则如下（按优先级）：

| #    | 规则                                                                                             | 处理                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| R2.1 | 非对象/空                                                                                        | 归一为 `{type:'object', properties:{}}`                                                                |
| R2.2 | 布尔 schema                                                                                      | `true/false` → `{type:'string'}`（对齐 opencode sanitizeOpenAISchema，opencode-cache-analysis.md:185） |
| R2.3 | `type` 字段                                                                                      | 数组形态 → 过滤无效项；过滤后单元素 → 取单值；过滤后空 → 丢弃该键；非数组 → 保留                       |
| R2.4 | `properties`                                                                                     | 键按码点升序；**递归应用本表到每个子 schema**                                                          |
| R2.5 | `required`                                                                                       | 数组去重 + 码点升序；非数组 → 丢弃该键                                                                 |
| R2.6 | `const`                                                                                          | 转为 `{enum: [const值]}` 并删除 const 键（对齐 opencode 语义）                                         |
| R2.7 | `$defs` / `definitions`                                                                          | 存在则按码点排序其键，并对每个定义递归应用本表                                                         |
| R2.8 | 其余键（description / additionalProperties / items / enum / oneOf / anyOf / allOf / default 等） | **原值保留**；`items` / `oneOf` / `anyOf` / `allOf` 为数组/对象时递归应用本表                          |
| R2.9 | 输出键序                                                                                         | 固定序列化顺序：`type` → `properties` → `required` → `items` → `enum` → `$defs` → 其余键按码点升序     |

- 目的：两个语义等价的 schema（键序不同、required 顺序不同、深层结构不同）经规范化后 JSON 字节完全一致——这是工具循环内跨 turn 前缀命中的前提（对齐百炼"工具定义序列化完全一致"要求，comparison.md:68）。
- 与现行 `canonicalizeJsonSchema`（directFetchBridge.ts:37-61）的差异：补齐 R2.2/R2.3/R2.6/R2.7/R2.8 递归与 R2.9 固定键序。

#### R3 缓存键推导（prompt_cache_key derivation）

- 规则：**`prompt_cache_key = clamp64(sessionId)`**，其中 `clamp64` 定义为：
  1. 输入为空/非字符串 → 不产生键（undefined）；
  2. 按 **Unicode 码点**截取前 **64 个码点**（不得拆分代理对：截断点落在高位代理之后时必须回退到该代理对的起点）；
  3. 长度 ≤ 64 码点 → 原样使用（不做哈希、不做前缀剥离、不追加命名空间）；
  4. 输出不做进一步编码（会话 ID 本身即 ASCII 域，保持原串）。
- 语义：同一会话所有轮次共享同一缓存键，服务端按键隔离缓存域（对齐 opencode-cache-analysis.md:110-121、kimi-code-cache-analysis.md:95-107）。
- 明确废弃：directFetchBridge.ts:79-87 的"systemPrompt+tools 内容哈希"键（`crish-prefix-<hex>`）——内容哈希无法承载"会话前缀演进"（tools 增删即换域），且与 P2/P3 的会话 ID 语义冲突。
- 注：DeepSeek 不支持 prompt_cache_key（发出去静默忽略，comparison.md:158）；**规则是"键值如何推导"，是否注入由 vendor 能力表决定（P3）**。降级路径可保持恒注入（语义无害），但键值必须走 R3。

#### R4 usage 解析（usage accounting，前端方言）

- 规则（TS 侧解析链，与 Rust P2 补齐后的字段面一致）：
  - `cacheRead = prompt_cache_hit_tokens ?? prompt_tokens_details.cached_tokens ?? usage.cached_tokens(顶层/Kimi) ?? 0`（三级回退，对齐 directFetchBridge.ts:272-275 现有链 + 补 Kimi 顶层，kimi-code-cache-analysis.md:186）
  - `cacheWrite = cache_write_tokens ?? prompt_tokens_details.cache_write_tokens ?? usage.cache_creation_tokens ?? 0`（别名回退，对齐 comparison.md:190 第②项）
  - `cacheMiss = prompt_cache_miss_tokens ?? (accounting === 'excluded' ? promptTokens : max(0, promptTokens - cacheRead - cacheWrite))`（【A2 审计修正】原公式只对 Included 系成立；Excluded 系（Anthropic/Gemini）的 prompt 不含缓存，miss 即 prompt 本身。`accounting` 为解析函数的可选入参（默认 `'included'`，主路径 chat-completions；Anthropic/Gemini 路径由 Rust 侧 P2 `CacheAccounting`/P5 派生值下发或由调用方显式传入——见下方对齐注））
  - `hitRate = inputTotal > 0 ? cacheRead / inputTotal : 0`，其中 `inputTotal = cacheMiss + cacheRead + cacheWrite`（对齐 kimi-code-cache-analysis.md:262-264 的 `cacheRead / inputTotal` 与 P5 §1.3 口径）【A2 审计修正：原公式分母用 `promptTokens`，只对 Included 系等于 inputTotal；Excluded 系下分母应为 `prompt + read + write`，按恒等式 `miss + read + write` 计算对两侧同时成立】
- 恒等式：Included 系 `cacheMiss + cacheRead + cacheWrite = promptTokens`；Excluded 系 `cacheMiss + cacheRead + cacheWrite = promptTokens + cacheRead + cacheWrite`（即 input_total = prompt + read + write，对齐 P2 §3.3 D 统一不变量）。解析后若可校验且偏差 > 0，以 promptTokens 为准钳制（`cacheRead = min(cacheRead, promptTokens)`），**不抛错**。【A2 审计修正：原恒等式仅对 Included 成立；渲染口径统一以 `inputTotal = miss + read + write` 为分母，与 P5 `CacheBreakdownMath::derive` / `hitRatio = cacheRead / inputTotal` 同源，禁止前端另算一套（P5 §6.2 风险"命中率口径被前端各算各的"即此条）】

#### R5 消息结构稳定性（前端侧哨兵规则）

- 前端负责保证"下发给引擎的请求素材"本身不引入漂移：`systemPrompt` 文本在会话内不中途改写（append 风格指令只发生在新建 run 前，ConnectionLifecycle.ts:237-275 属一次性组装）；`options.messages` 历史按存储序原样透传，不做任何重排/改写。
- 此规则为**哨兵约定**（本方案只登记、不实现检测），P1 若做字节快照审计（对齐 Claude Code 两阶段断裂检测，comparison.md:248）时以此为输入之一。

### 3.2 降级路径对齐契约（主题 A 的 TS 侧实现）

**实施形态**：新增 `packages/shared-utils/src/cache/`（纯函数，无 DOM 依赖），作为 TS 侧规范实现真源；`directFetchBridge.ts` 改为委托/重导出，导出名保持兼容（`stressFuzzing.test.ts` Probe E 直接 import 这三个函数，见 :5）。

| 新模块导出                                                                     | 职责                                   | 替代的旧函数                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalizeJsonSchema(schema)`                                               | 完整实现 R2（递归）                    | directFetchBridge.ts:37-61（保留导出名，实现委托）                                                                                                                           |
| `formatStableTools(tools)`                                                     | 实现 R1 + 固定输出形状                 | directFetchBridge.ts:64-76                                                                                                                                                   |
| `derivePromptCacheKey(sessionId)`                                              | 实现 R3（clamp64）                     | `buildStableCacheKey`（directFetchBridge.ts:79-87）改造：签名改为 `(sessionId)`，旧内容哈希行为废弃；旧名保留为 `@deprecated` 包装（返回 `derivePromptCacheKey(sessionId)`） |
| `parseUsageFromProviderChunk(usage: unknown): ProviderUsage                    | null`                                  | 实现 R4 三级回退链（供降级路径 usage 捕获与未来任何 HTTP 直连场景复用）                                                                                                      | directFetchBridge.ts:269-282 内联逻辑                              |
| `computeCacheMetrics(usage: ProviderUsage                                      | null): CacheMetrics                    | null`                                                                                                                                                                        | 派生 cacheMiss/hitRate/displayTokens（3.3 节类型），命中率口径统一 | —   |
| `resolveCacheAffinity(params): { promptCacheKey?: string; sessionId: string }` | 组装 run-task 缓存域参数（3.4 节契约） | —                                                                                                                                                                            |

**directFetchBridge.ts 的改动边界**：

1. `buildStableCacheKey(systemPrompt, tools)` → `derivePromptCacheKey(sessionId)`：`streamViaDirectFetch` 内 `cacheAffinityKey`（:176）改为由 sessionId 派生；`sessionId` 参数（:144、:148 现为 `void sessionId`）恢复使用。
2. 三个规范化函数改为委托 shared-utils 实现（保持导出名，Probe E 不破）。
3. usage 捕获（:269-282）改用 `parseUsageFromProviderChunk`；`onThought("[KV Cache: ...]")` 提示**保留原样**（降级路径终端体验，不属产品展示面）。
4. 文件头注释补充：规范规则引用 `docs/cache-optimization/03-plans/P6-ts-shell-sync.md` §3.1。

**对齐的边界声明**（防止过度解读）：

- 对齐的是**规则与键源**，不是"两侧行为完全一致"：主路径是否注入 `prompt_cache_key` 由 P3 的 vendor 能力表控制（DeepSeek 不注入）；降级路径恒注入但键值同源。两侧差异有文档依据，不算不一致。
- 本方案不要求 Rust 侧同步改代码；P1 落地时以 §3.1 为准，两侧行为由交叉验证测试（3.5.2）钉死。

### 3.3 前端缓存数据契约与组件骨架（主题 B）

#### 3.3.1 类型契约（新增于 shared-types，全可选，向后兼容）

```ts
// packages/shared-types/src/cache-metrics.ts（新建，index.ts 导出）

/** 缓存计量原始面（与 ProviderUsage 对齐；P2 在 Rust 侧补齐字段后双向一致） */
export interface CacheUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 派生指标（P6 纯函数产出；P5 渲染消费） */
export interface CacheMetrics {
  /** cacheRead + cacheWrite + cacheMiss 恒等式校验后值 */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** max(0, promptTokens - cacheReadTokens - cacheWriteTokens) */
  cacheMissTokens: number;
  /** inputTotal > 0 ? cacheRead / inputTotal : 0（inputTotal = miss + read + write，R4 口径；【A2 审计修正】原分母 promptTokens 仅对 Included 系成立）；渲染层在 hitRate 无意义时隐藏 */
  hitRate: number;
  /** 会话累计（多轮累加后的展示用快照，P5 的 `cache-stats-updated` 事件就绪后填充；P6 阶段恒为 null）【A1 审计修正：原稿"P2 会话级统计事件"归属错误，事件归 P5 §3.1.3】 */
  session?: {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    inputTokens: number;
    hitRate: number;
  } | null;
  /** 省钱估算（消费 pricingStore.estimateSavingsUsd） */
  savingsUsd?: number | null;
}

/** AgentMessage.metadata 下的 usage 挂载点（Rust 侧 build_assistant_message 已产出 metadata.usage） */
export interface UsageMetadataShape {
  usage?: CacheUsage;
}

/** 消息级缓存状态（UI store 消息上挂载，P6 只定义类型，不强制写 store） */
export interface MessageCacheState {
  metrics: CacheMetrics | null; // null = 老数据/无 cache 字段 → 不渲染
  source: 'engine-message-end' | 'degraded-direct' | null;
}
```

- 关键默认语义（主题 E）：**`metrics: null` 表示"无可展示数据"**（老会话、无 cache 字段、解析失败），渲染层**必须隐藏**而不是显示 `0%`——0% 会误导（可能只是厂商未上报，对齐 pi 的"不报告缓存厂商不计"语义，comparison.md:268）。

#### 3.3.2 usage 解析纯函数（放 shared-utils/src/cache/）

```ts
// 输入：message-end 事件 message.metadata 或任意 JsonObject
parseUsageFromMetadata(metadata: unknown): CacheUsage | null
// 输入：解析出的 usage（或 null）
computeCacheMetrics(usage: CacheUsage | null): CacheMetrics | null
// 消费点：pricingStore 已有 4D 估算（pricingStore.ts:99-136），本函数只负责把
// metrics 转成 pricingStore 可接收的参数，不重复实现费率逻辑
metricsToCostInputs(metrics: CacheMetrics | null):
  { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null
```

#### 3.3.3 组件骨架位置（占位，P5 填充逻辑）

| 骨架                     | 建议位置                                                                                                                                              | 职责（P6 占位）                                                                    | P5 最终职责                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CacheMetricsBadge`      | `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.tsx`（新文件，与 MessageThinkingSection / MessageActionsBar 同级）              | 空壳组件 + testid；从 store 消息读 `MessageCacheState.metrics`，`null` 时渲染 null | 消息级徽标：`缓存命中 62% · 读 1.2k · 写 0.3k · 省 $0.012`；无数据时隐藏                                                             |
| `SessionCacheStatsPanel` | `apps/crish-desktop/src/components/workspace/RuntimePanel.tsx` 内新增小节（RuntimeSection 同级），或独立 `components/workspace/SessionCacheStats.tsx` | 空壳 + testid；读会话级统计（P6 阶段无数据源 → 渲染空态文案）                      | 会话统计面板：hitRate 指标、cache read/write 累计、冷缓存/压缩后命中率跳水提示（对齐 kimi vis 面板，kimi-code-cache-analysis.md:19） |
| 接入点                   | `ChatAssistantMessageRow.tsx`（消息元数据区）与 `RuntimePanel.tsx`（统计区）                                                                          | 只挂占位，不接数据                                                                 | P5 接线                                                                                                                              |

- testid 契约（登记，沿用 tests/e2e/README.md §5 模式）：`cache-metrics-badge` / `session-cache-stats`；CSS 稳定类 `.cache-metrics`。

#### 3.3.4 数据流（P6 阶段只定义，不接线）

```
message-end 事件 → eventParser.parseBridgeEvent（现有）→ EventRouter → store 落消息
  （AgentMessage.metadata.usage 原样保留）
  ↓ 消费点（新增纯函数，P6 实现 + 单测）
parseUsageFromMetadata → computeCacheMetrics → MessageCacheState
  ↓ 渲染（P5）
CacheMetricsBadge / SessionCacheStatsPanel（消费 pricingStore.estimateSavingsUsd）
```

### 3.4 会话亲和与 startRunTask 参数扩展（主题 C）

**结论先行：前端不新增必传参数。** sessionId 本身就是缓存域标识（R3），`createStreamSession` 已在传（ConnectionLifecycle.ts:293）；P2/P3 在 Rust 侧以 `core_run_task.sessionId` 推导 prompt_cache_key 即可，无需前端重复计算。

**可选扩展（本方案登记，供 P3 裁决是否采纳）**：

```ts
// startRunTask 参数面新增（全部可选，缺省行为 = Rust 用 sessionId 推导）：
export interface RunTaskCacheAffinityParams {
  /** 覆盖默认缓存键（R3 推导结果）。适用场景：会话迁移/克隆后继承原会话缓存域；
   *  压缩/摘要请求强制新域（对齐 pi compaction 新 sessionId，comparison.md:216-217） */
  promptCacheKey?: string;
  /** 显式声明"本 run 应使用与 sessionId 相同缓存域"（默认 true；压缩等场景传 false） */
  cacheAffinity?: boolean;
}
```

- 前端实现位置：`ConnectionLifecycle.createStreamSession` 的 startRunTask 组装块（ConnectionLifecycle.ts:290-313）新增上述可选字段透传；`streamViaEngine`/`streamViaDirectFetch` 签名**不变**（避免破坏 chatApi.StreamRequestOptions 的调用面；需要时经 `options` 新增可选字段）。
- 约束：`promptCacheKey` 在 TS 侧只做透传，**不负责推导**（推导真源在 Rust P3 + 本方案 R3）；降级路径例外——它没有 Rust 主路径，必须自己算，所以 `derivePromptCacheKey` 放在 shared-utils 供其使用（3.2 节）。
- 配套：`resolveCacheAffinity(params)`（3.2 表）供 ConnectionLifecycle 与 mock 断言共用，保证"前端组装结果可被 e2e 断言"。

### 3.5 测试与基准基建（主题 D）

#### 3.5.1 e2e（tests/e2e/，Playwright L2 mock 引擎）

**mock-engine.ts 扩展（fixture 真源模式，对齐 fullJourneyRunEvents）**：

```ts
/** 带缓存 usage 的完整旅程：message-end 携带 metadata.usage.cacheReadTokens 等 */
export function cacheUsageRunEvents(): MockEvent[];

/** 无 cache 字段的老形态消息（兼容性场景：断言不渲染、不显示 0%） */
export function legacyNoUsageRunEvents(): MockEvent[];

/** run-task 断言用配置：记录 cacheAffinity 参数（engineState().lastRun.args 可查） */
```

- fixture 中 `message-end.message.metadata.usage` 形状：
  `{ promptTokens: 12000, completionTokens: 400, cacheReadTokens: 9000, cacheWriteTokens: 500, reasoningTokens: 60 }`
- 断言口径（对齐 Kimi `cache read N (xx%)`，kimi-code-cache-analysis.md:263）：`hitRate = cacheReadTokens / inputTotal`（inputTotal = miss + read + write；本 fixture 为 Included 形态，inputTotal = promptTokens，断言值不变）【A2 审计修正：原"cacheReadTokens / promptTokens"仅在 Included 系成立，已按 R4 统一口径表述】

**新 spec：`tests/e2e/cache-metrics.spec.ts`**（登记进 tests/e2e/README.md 必覆盖表）：

| 用例                                | 断言                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ① 带 cache fixture 全流程           | 消息终态后 `cache-metrics-badge` 可见；文本含命中率（`75%`：9000/12000）；含 read/write 数值                       |
| ② 无 cache 字段（legacy fixture）   | badge **不出现**；页面无 `0%` 字样                                                                                 |
| ③ run-task 缓存域参数               | `engineState().lastRun.args`：sessionId 存在；`promptCacheKey`/`cacheAffinity` 未传时缺省（或按 3.4 裁决后的形状） |
| ④ 命中率边界（hitRate=0 或 read=0） | 渲染层显示"未命中"态而非 0% 误导（P6 只钉 badge 行为；文案细节归 P5）                                              |

#### 3.5.2 vitest 单测（apps/crish-desktop 与 packages/shared-utils）

| 文件                                                                               | 覆盖                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-utils/src/cache/cache-rules.test.ts`（新）                        | R1：码点排序确定性（含非 ASCII name）；R2：递归规范化（嵌套 properties / 布尔 schema / type 数组 / const→enum / $defs）、乱序输入 → 字节等价；R3：`derivePromptCacheKey` 64 码点钳制、代理对不拆、空输入 undefined、<64 原样            |
| `packages/shared-utils/src/cache/usage-parse.test.ts`（新）                        | R4 三级回退链：DeepSeek 顶层 hit/miss、`prompt_tokens_details.cached_tokens`、Kimi 顶层 `cached_tokens`、cache_write 别名、异常输入（null/字符串/负数）→ null 或钳制；恒等式校验                                                        |
| `apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`（Probe E 升级，:121-165） | 断言目标从 `buildStableCacheKey` 内容哈希改为 `derivePromptCacheKey` 会话 ID 语义；补"同一 sessionId 不同 tools → 键相同"（缓存域不随工具集漂移）                                                                                       |
| **跨侧交叉验证测试**（新，`packages/shared-utils/src/cache/rust-parity.test.ts`）  | 以 §3.1 规则清单为枚举源，构造"规则级样例表"（输入 schema/工具集/键 → 期望输出），双侧实现都跑同一张表：TS 侧直接断言；Rust 侧（P1 落地后）由 cargo 侧同名样例表测试消费。**本测试先把 TS 侧与规则表钉死，Rust 侧表格在 P1 实现时复制** |
| `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts`（扩展）      | `message-end` 带 metadata.usage 时解析成功、usage 落在 message.metadata 结构化读取路径                                                                                                                                                  |

- 注：`parseUsageFromMetadata` 放 shared-utils 而非 crish-desktop，是因为 mock-engine/纯函数断言与前端 store 都要用，且避免测试间路径纠缠。

#### 3.5.3 基准（packages/shared-utils/src/bench/bench-definitions.ts）

- 新增 2 项（对齐现有 `{name, setup, run, iterations, warmupIterations, target}` 模式，:36-52）：

| name                                 | 内容                                                                                   | target                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `cache.schema.canonicalize.100tools` | 构造 100 个含嵌套 schema 的工具定义，跑 `canonicalizeJsonSchema` + `formatStableTools` | `{ maxMs: 5, minOps: 200 }`（预热 5、迭代 50） |
| `cache.key.derive.1000`              | 1000 次 `derivePromptCacheKey`（含 100+ 码点长 sessionId 的钳制路径）                  | `{ maxMs: 2, minOps: 500 }`                    |

- 依据：规范化/键计算在每次 run-task 组装时执行一次，规模与上述量级相当；基准用于防止未来实现（P1 的 TS 侧镜像或重构）引入回归。若 P6 阶段评估 jsdom 环境对基准无影响，可直接入 BENCHMARKS（bench-definitions.ts 均为纯 Node 侧，符合）。

### 3.6 兼容与迁移（主题 E）

#### 3.6.1 老会话/老持久化数据无 cache 字段

- 默认值语义（全链路统一）：
  - `parseUsageFromMetadata(metadata)`：`metadata.usage` 不存在或非对象 → 返回 `null`（不是全零对象）；
  - `computeCacheMetrics(null)` → `null`；
  - 渲染层：`MessageCacheState.metrics === null` → **隐藏**组件（不渲染、不占位、不显示 0%）；只有"本厂商上报过 usage 但确为 0"（`usage` 存在且 `cacheReadTokens === 0`）才显示"未命中"态——两种状态必须可区分（对齐 pi reportedCache 粘性语义的简化版，comparison.md:268）。
  - 老 store 消息（已持久化、无 metadata.usage）：读取路径返回 null，无需数据迁移。
- 定价侧：`resolveModelPrice` 未匹配模型返回 null（pricingStore.ts:67-75），`estimateSavingsUsd` 返回 0——展示层在 savingsUsd 为 null 时隐藏金额，0 与 null 区分（同上原则）。

#### 3.6.2 shared-types 版本化升级步骤（契约升级三步走）

1. **类型先行（本方案/后续实现任务）**：`cache-metrics.ts` 全可选字段新增；`ProviderUsage` 不动（六字段已够）；`AgentMessage.metadata` 不动（JsonObject 已是宽容挂载点）。
2. **生成产物纪律**：若 P2/P5 需要新增引擎事件/字段（如会话级缓存统计事件，实归 P5 S3 新增），必须：改 Rust 侧事件定义 → `npm run gen:engine-bindings` 重生成 `generated/engine/*` → 提交生成产物；**禁止手改 generated**；eventParser 的宽容归一器（ENGINE_NORMALIZERS，eventParser.ts:201-443）在生成解析器覆盖不了时兜底新增形态（对齐既有模式，eventParser.ts:458-474）。
3. **兼容窗口**：新增字段全部可选 + 前端解析全 null 兜底 → 老引擎/新前端、新引擎/老前端（升级过渡期）双向不炸；mock-engine 的 BUILTIN_COMMAND_MANIFEST 快照（mock-engine.ts:30、98）随命令面变更同步（本方案无命令面变更，登记备忘）。

#### 3.6.3 降级路径兼容

- `buildStableCacheKey` 导出名保留但语义改为 R3（sessionId 派生）→ Probe E（stressFuzzing.test.ts:121-165）断言同步升级（3.5.2 表）；`crish-prefix-` 前缀不再产生，不维护旧键兼容（降级路径无持久化依赖，键只服务单次请求的服务端缓存域）。

---

## ④ 实施步骤

按依赖序排布，每步标注文件域。**实施时禁止改本方案已声明"P1/P2/P3/P5 负责"的范围。**

| 步  | 内容                                                                                                                                                                       | 文件域                                                                                                             | 产出/验证                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| S1  | 新建 `packages/shared-utils/src/cache/`：`cache-rules.ts`（R1/R2/R3 实现）、`usage-parse.ts`（R4）、`index.ts` 导出；同步 `packages/shared-utils/src/index.ts` 导出        | packages/shared-utils                                                                                              | 纯函数实现 §3.1 全部规则                                                          |
| S2  | 新增 `packages/shared-types/src/cache-metrics.ts`（3.3.1 类型）+ index.ts 导出                                                                                             | packages/shared-types                                                                                              | typecheck 通过                                                                    |
| S3  | directFetchBridge 改造：三函数委托 shared-utils、`buildStableCacheKey`→`derivePromptCacheKey`（sessionId）、usage 捕获改用 `parseUsageFromProviderChunk`、文件头补规则引用 | apps/crish-desktop/src/api/directFetchBridge.ts                                                                    | Probe E 更新后通过；无其他调用方破坏（先 grep 调用方）                            |
| S4  | 单测：`cache-rules.test.ts`、`usage-parse.test.ts`、`rust-parity.test.ts`（规则样例表）；Probe E 升级；eventParser.test.ts 扩展                                            | packages/shared-utils/src/cache、apps/crish-desktop/src/**tests**、apps/crish-desktop/src/api/chat-bridge/handlers | vitest 绿                                                                         |
| S5  | mock-engine.ts 扩展：`cacheUsageRunEvents` / `legacyNoUsageRunEvents`；新 spec `tests/e2e/cache-metrics.spec.ts`；README 必覆盖表登记                                      | tests/e2e                                                                                                          | playwright 绿                                                                     |
| S6  | 基准 2 项入 BENCHMARKS                                                                                                                                                     | packages/shared-utils/src/bench/bench-definitions.ts                                                               | `npm run bench` 绿                                                                |
| S7  | 组件骨架占位：`CacheMetricsBadge.tsx`、`SessionCacheStatsPanel.tsx`（空壳 + testid + 挂载点引用）                                                                          | apps/crish-desktop/src/components/chat-message-row、apps/crish-desktop/src/components/workspace                    | typecheck + e2e 用例①② 绿（badge 渲染由 fixture 驱动，P6 即验证骨架数据读取路径） |
| S8  | 文档收口：tests/e2e/README.md §5 testid 登记、`docs/cache-optimization/03-plans/P6-ts-shell-sync.md` 规则表同步为最终版                                                    | tests/e2e/README.md                                                                                                | 文档一致                                                                          |

> 说明：S7 的"骨架数据读取路径"指 badge 从 store 消息读取 `MessageCacheState.metrics` 并渲染的**最小实现**（null 隐藏 + 非 null 显示数值文本）；视觉设计与交互细节留给 P5，P6 只保证契约可被 e2e 断言。

---

## ⑤ 验收标准（测试命令）

```bash
# 1. 类型与静态检查（全仓）
npm run typecheck

# 2. 缓存规则/usage 解析/键推导单测（新增 + 升级）
npx vitest run packages/shared-utils/src/cache
npx vitest run apps/crish-desktop/src/__tests__/stressFuzzing.test.ts
npx vitest run apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts

# 3. e2e（L2 mock 引擎，新增 spec + 全量回归防破）
npx playwright test tests/e2e/cache-metrics.spec.ts
npx playwright test tests/e2e            # 全量：确认既有 7 spec 未回归（error-path/full-journey/probe2/session-restore/settings-persist/streaming-render/ui-store-invariants；tauri-native-smoke 归 vitest 面）【A3 审计修正：原稿"5 spec"与实际不符，A3-executability.md P2-3】

# 4. 基准（新增 2 项）
npm run bench                            # cache.schema.canonicalize.100tools / cache.key.derive.1000 两项 pass

# 5. 覆盖率门槛（crish-desktop 包内既有 70/60/65/70 门槛不破）
npx vitest run --coverage apps/crish-desktop/src/api/chat-bridge  # 抽查
```

**验收清单（对应目标 A–E）**：

- [ ] A：§3.1 规则清单已文档化；TS 侧实现（shared-utils/cache）逐条对应；rust-parity 样例表已建立（TS 侧先钉死，P1 落地后 Rust 侧同表通过）
- [ ] A：`derivePromptCacheKey` 与 P2/P3 规则一致（sessionId 钳制 64 码点）；降级路径键源已切换，`crish-prefix-` 内容哈希废弃
- [ ] B：类型契约（3.3.1）进入 shared-types；两个骨架组件存在且 testid 生效；e2e 用例①②③④ 通过
- [ ] C：startRunTask 参数扩展契约已登记；e2e 用例③ 断言缺省行为
- [ ] D：mock 引擎 cache fixture、命中率断言、usage/cache-key 单测、基准 2 项全部就位
- [ ] E：null 默认语义全链路一致（解析 null → 隐藏，非 0% 误导）；无 generated 产物手改（本次无事件面变更，S8 核查 `git status packages/shared-types/src/generated` 无改动）

---

## ⑥ 风险与依赖

### 6.1 依赖（上游契约）

| 计划 | 依赖内容                                                                                      | 本方案的对接点                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | Rust 侧 tools 排序 + schema 规范化实现（registry.rs / streaming.rs）                          | 本方案 §3.1 规则清单是 P1 的实现输入；`rust-parity.test.ts` 样例表是双向验收机制                                                                            |
| P2   | usage 字段补齐（DeepSeek/Kimi 顶层）                                                          | R4 三级回退链与之同口径（会话级缓存统计事件归 P5，见下行）【A1 审计修正：原稿"+ 会话级缓存统计事件"归属错误】                                               |
| P3   | Rust 侧 `prompt_cache_key` 注入（vendor 能力表）                                              | R3 键推导规则与 P3 一致；3.4 的 `promptCacheKey` 透传字段由 P3 裁决是否采纳                                                                                 |
| P5   | 前端展示逻辑（徽标/面板真实实现）+ 会话级缓存统计事件（`CacheDomainEvent` 三变体，P5 §3.1.3） | 3.3 的类型 + 骨架 + 默认态是其输入；`CacheMetrics.session` 字段等待 P5 事件；P5 不得改 `CacheMetrics` 的 null 语义【A1 审计修正：事件归属自 P2 行移入本行】 |

**反向依赖（下游对本方案的阻塞面）**：P2/P5 若在 P6 落地前改动 `metadata.usage` 形状，须与本方案 3.3.1 的 `UsageMetadataShape` 对齐；否则 `parseUsageFromMetadata` 兜底 null 不炸但展示会长期隐藏（可观测，不静默错误）。

### 6.2 风险

| 风险                                                                                                                     | 等级 | 缓解                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `localeCompare` 与 Rust 码点序不一致导致跨侧字节漂移（2.1 表）                                                           | 高   | R1 强制码点比较；rust-parity 样例表含非 ASCII 工具名样例                                                                           |
| 规则文档与两侧实现漂移（文档沦为摆设）                                                                                   | 中   | §3.1 声明"规则即真源"；样例表测试把规则转成可执行断言；P1 评审时逐条对照（可引用本方案行号）                                       |
| shared-utils 新增包内模块影响既有 coverage 门槛（crish-desktop 的 vitest.config.ts 门槛是包级配置，shared-utils 无门槛） | 低   | 新代码集中在 shared-utils；crish-desktop 侧只加骨架组件，均会被单测/e2e 覆盖                                                       |
| mock-engine 快照 manifest 与命令面漂移（若 3.4 参数扩展影响 commandManifest）                                            | 低   | 本方案无命令面变更；若 P3 采纳 `promptCacheKey` 参数，需同步 `BUILTIN_COMMAND_MANIFEST`（mock-engine.ts:30 引 commandManifest.ts） |
| e2e 新增 spec 增加 CI 中层时长                                                                                           | 低   | 4 用例共享 1 个 `openApp` 启动（对齐 full-journey 模式），delayMs 用最小值 30                                                      |
| 降级路径被误用于产品特性（directFetchBridge 复活风险）                                                                   | 低   | 文件头 + 本方案 3.2"对齐边界声明"双保险；不新增其产品职责                                                                          |

### 6.3 文件域总表

- **本方案实施涉及**：`packages/shared-utils/src/cache/`（新）、`packages/shared-types/src/cache-metrics.ts`（新）、`apps/crish-desktop/src/api/directFetchBridge.ts`、`apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`、`apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.test.ts`、`apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.tsx`（新）、`apps/crish-desktop/src/components/workspace/`（骨架挂载）、`tests/e2e/mock-engine.ts`、`tests/e2e/cache-metrics.spec.ts`（新）、`tests/e2e/README.md`、`packages/shared-utils/src/bench/bench-definitions.ts`
- **明确不动**（留给对应计划）：Rust crates（P1/P2/P3）、`pricingStore.ts` 费率逻辑（P5 消费侧）、`ConnectionLifecycle.ts` 的 systemPrompt 透传缺陷（P1/P4）、`generated/engine/*`（P2 事件面变更时经生成器）。

---

## ⑦ 实施核销（R6 完成，2026-08-03）

> 核销范围：R6 轮 T-46（骨架组件 + 挂载 + 本文档收口）。逐节核对 ④ 实施步骤 S7 与本方案
> §3.3.3 组件骨架契约、§3.6.1 默认值语义在 `apps/crish-desktop/src/components/` 的实际落地情况，
> 以及实施中与任务书/方案正文的差异裁决。全部结论基于 2026-08-03 实读代码。
> 本方案 §3.1 规则表为双侧真源，本次无规则内容改动，无需回写（维持最终版）。

### 7.1 步骤 7（S7）骨架占位完成状态

| 交付物                                                    | 状态 | 说明                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/chat-message-row/CacheMetricsBadge.tsx`（新） | 完成 | 空壳 + testid `cache-metrics-badge` + CSS 稳定类 `.cache-metrics`；props `metrics: CacheMetrics \| null`，null → 渲染 null；非 null 最小数值文本（命中率/读/写，hitRatio 优先、hitRate 兼容别名回退），命中率 0 或未上报 → "未命中"态（e2e 用例④口径） |
| `components/workspace/SessionCacheStatsPanel.tsx`（新）   | 完成 | 空壳 + testid `session-cache-stats`；props `stats: CacheMetrics \| null`，null → 空态占位文案；非 null 渲染命中率/读写 token/未命中提示占位                                                                                                            |
| 挂载点（ChatAssistantMessageRow.tsx / RuntimePanel.tsx）  | 完成 | 最小引用：传 null 占位，不接数据（数据接线归 T-48）                                                                                                                                                                                                    |
| 组件测试（两文件）                                        | 完成 | `CacheMetricsBadge.test.tsx` / `SessionCacheStatsPanel.test.tsx`：null 隐藏、testid 存在、未命中态                                                                                                                                                     |

### 7.2 与任务书/方案正文的差异裁决

1. **面板 testid 差异**：任务派单对面板写 `cache-stats-panel`，但本方案 §3.3.3 与 90-final T-45
   登记的 testid 契约为 `session-cache-stats` → 按**登记契约**实现（e2e 断言与 README §5 登记以
   登记契约为准），差异已在轮末汇总物声明，请主 Agent 裁决是否全局统一。
2. **类型占位 → 已切换共享类型**：T-42（shared-types cache-metrics 契约）同波并行在本任务
   实施中途落盘（`cache-metrics.ts` / `index.ts` 导出实读确认）→ 两个组件直接消费
   `@crish/shared-types` 的 `CacheMetrics`（字段全可选；`hitRatio` 正式名 + `hitRate` 兼容别名），
   未保留本地占位接口（无占位债留给 T-48）。
3. **骨架数据读取路径**：任务派单将"从 store 消息读 `MessageCacheState.metrics`"归 T-48 接线；
   T-46 交付 props 驱动的纯骨架（挂载恒传 null），e2e 用例①②的数据读取路径断言由 T-48
   接线后的全流程覆盖。
4. **跨 Agent 阻塞上报（T-42 域）**：`packages/shared-types/src/cache-metrics.test.ts`（T-42 域）
   存在 GBK 乱码写入（实读字节确认，`it(...)` 字符串被错误字节截断，tsc 报
   `Unterminated string literal` / `Invalid character`），导致全仓 `npm run typecheck` 门禁失败。
   该文件不在 T-46 文件域内，未代改；请主 Agent 协调 T-42 修复（按 chinese-encoding-guard
   安全写入方式重写该文件）。

### 7.3 交接对声明（A6 → A8，轮内串行）

- components 域（`CacheMetricsBadge.tsx` / `SessionCacheStatsPanel.tsx` / `ChatAssistantMessageRow.tsx` /
  `RuntimePanel.tsx`）骨架与挂载已完成并通过 P6 门禁（typecheck + 组件单测），所有权移交主 Agent，
  由主 Agent 在轮末报告后转移给 T-48（A8）接线真实数据。
- 接线接口（T-48 消费面）：
  - `CacheMetricsBadge.props.metrics: CacheMetrics | null`（null 隐藏；类型已消费
    `@crish/shared-types` 共享契约，T-48 无需替换类型来源）
  - `SessionCacheStatsPanel.props.stats: CacheMetrics | null`（null 空态占位）
  - testid：`cache-metrics-badge` / `session-cache-stats`
- 验收"无 generated 产物手改"：本次未触碰 `packages/shared-types/src/generated/`（无事件面变更，
  对齐 §3.6.2 第 2 条纪律）。
