# review-plans-03 · 删除面核实（结构收敛向 · 抽样读码）

> **战役**：performance-audit → performance-fix  
> **角色**：方案评审 Agent（v3 §二.2 · 结构收敛向）  
> **创建**：2026-09-13  
> **性质**：只审计划；对关键删除锚点**亲自读码**核实删除面是否真实存在、是否过度/不足、是否被误写成兼容读/双写。  
> **禁止**：git commit；未读码下删除结论。

---

## 0. 范围与方法

### 0.1 必读计划（已通读）

| 文档 | 角色 |
| ---- | ---- |
| `independent-06-结构收敛优先.md` | 主审：删除面总表 U1–U20 / S1–S6 / P1–P17 / N1–N6 |
| `independent-01-数据面收敛.md` | 主审：DEL-1…DEL-15 + 副路径 |
| `independent-03-前端渲染与内存.md` | 主审：§4 删除面 18 项 |
| `independent-02-阻塞与执行面.md` | 扫读：DEL-1…DEL-12、CON-* |
| `independent-04-启动资产与门禁.md` | 扫读：DEL-1…DEL-8（motion/woff/门禁） |
| `independent-05-强契约与观测.md` | 扫读：双 parse / fanout clone / 轮询双源 / Progress |

### 0.2 读码锚点（本轮亲自核实 ≥8 条，实际 16 条）

组提交旁路、partialize sessions、LS 索引、highlight.batch、SharedGatekeeper、moka 预算、NoPersist 取号序、EventRouter 双 parse、fanout `from_value`、save_session_body 先删后插、G8 仅 emergency、send_pending_batch、cleanup_logs、take_night_summary、batch_version、双发收口轨、motion import、流式静态 split、will-change 契约。

---

## 1. 删除面核实表

> **判定**：属实 = 删除对象真实存在且计划表述与代码一致；夸大 = 对象存在但规模/性质被抬高或措辞误导；不足 = 对象存在但计划删除面漏了关键调用点/姊妹路径。

### 1.1 存储与写路径（U1 / U2 / S2 / S4 / DEL-1 / DEL-2 / DEL-5）

| # | 主张（出处） | 代码证据 | 判定 |
| - | ------------ | -------- | ---- |
| A1 | 组提交 Actor 已建但生产域写仍走主 Mutex（06 U1 / 01 DP-INV-3、DEL-1） | `conex-db/src/lib.rs:134` `DbWriteHandle::spawn`；`lib.rs:220` `self.writer.write` API 存在；**全仓域方法仍 `self.conn.lock()`**：`sessions.rs` / `events.rs` / `runs.rs` / `blocks.rs` / `messages.rs` / `cas_gc.rs` / `imported.rs` 等共 90+ 处（含写）；`group_commit.rs:187` 仅 Actor 内部 `self.write` | **属实**。双路径真实：Writer 已 spawn，域方法几乎 0 接入 |
| A2 | ReaderPool 已建但大量域读仍裸锁（06 U2） | `lib.rs:223-239` `read` 优先 ReaderPool；`events.rs:46/94/136/163` 等读仍 `conn.lock`；部分读已 `self.read`（`preferences.rs`/`agents.rs`/`messages.rs:11`） | **属实**（部分读已收口，旁路仍在） |
| A3 | zustand partialize 仍含全量 sessions（06 S2 / 01 DEL-5 / 03 D4） | `sessionStore.ts:64-69`：`partialize: (s) => ({ sessions: s.sessions, folderOrder…, activeSessionId…, composerDrafts… })` | **属实**。物理删除 sessions 字段必要 |
| A4 | save_session_body 先删后插（06 S4 / 01 DEL-2） | `messages.rs:48-101`：事务内 `DELETE FROM session_messages` + 逐条 INSERT 循环；注释自证「先删后插」 | **属实**。形态替换（非整文件删）表述正确 |
| A5 | batch_version Rust 侧静默丢弃（01 DEL-8） | 前端 `sessionRustDbSql.ts:142-146` invoke 传 `batchVersion`；`session_commands.rs:141-150` 签名仅 `session_id, messages`——无 batch_version 形参 | **属实**。前端 CAS 仅 client 侧 `writtenBodyVersion`；Rust 真 CAS 未接 |
| A6 | 前端全量重发 / 无 dirty（01 DEL-7/15） | `sessionRustDbHydrate.ts:347-360`：对 `list` 每会话 `normalizeAssistantTimeline` + `saveSessionBody`，无引用比较 dirty 集合 | **属实** |

### 1.2 会话索引与 LS 孤岛（S1 / DEL-6）

| # | 主张 | 代码证据 | 判定 |
| - | ---- | -------- | ---- |
| B1 | 会话索引 LS 优先 SQLite 回退双源（06 S1 / 01 DEL-6 / 03 D4） | `sessionRustDbHydrate.ts:158-161` 注释「localStorage 优先（真相源），回退 SQLite」；`lsLoadSessionIndex` 空才 `listSessions()`；`sessionPersistenceTypes.ts:5` `SESSION_INDEX_KEY = 'crish_session_index_v1'`；`sessionRustDbFallback.ts:37-50` 读写实现 | **属实** |
| B2 | 命令缺失 → LS 回退（body/agents）双轨 | `sessionRustDbSql.ts:82-86` `listSessions` 失败→`lsLoadSessionIndex()`；`:92-106` `loadSessionBody` 失败→`lsLoadSessionBody`；`persistAllSessionsLocalFallback` 在 probe 失败时调用（`sessionRustDbHydrate.ts:337`） | **属实**。01 §7 将 fallback 产品语义标「待核实」合理——存在合法降级语义，删除需 migration+可观测，不宜无脑「一刀 0」 |
| B3 | LS-only 测试锚点密集，陪葬清单必须覆盖 | `sessionPersistence.test.ts` / `sessionRustDbWriteModel.test.ts` / `migrateFromLocalStorage.test.ts` / 大量 `SESSION_INDEX_KEY` 断言（数十处） | **属实**。06 §3.5 陪葬策略方向正确；量级偏大但必要 |

### 1.3 事件与传输（U16/U17/U19 / DEL-4/9/10/11）

| # | 主张 | 代码证据 | 判定 |
| - | ---- | -------- | ---- |
| C1 | NoPersist 先 reserve 后判定（06 U19 / 01 DEL-4） | `orchestrator/events.rs:246-256` 先 `self.reserve(session_id)`；`:257` 才 `if is_non_persistent(&event)` return | **属实**。控制流删除（非兼容读）目标正确 |
| C2 | EventRouter 数据面先 parse 后丢弃（06 U16 / 01 DEL-10 / 05） | `EventRouter.ts:217-227` `onMsg`：`resolveEventType` → `parseBridgeEvent(raw)`；`handleAgentEvent:152` `if (isDataPlaneEventType(envelope.type)) return`——strict parse 已发生；`dataPlaneRouter.ts:125-147` 另一次 `parseBridgeEvent` | **属实**。双 parse 结构坐实；01 U15「resolveEventType ×3」本轮未逐调用点数全，结构上至少 2 路独立 resolve+parse |
| C3 | 非 delta 收口轨二次全量 emit（06 U17 / 01 DEL-9 / DP-INV-1） | `run_idle.rs:1405-1421`：仅 `MessageDelta` 在 `delta_sink_active` 时 skip；**其余事件** `bridge.emit(&envelope)` 全量再发 | **属实**。双发面真实存在；删除动作归 D5 契约票合理 |
| C4 | fanout `from_value(value.clone())` 全量（01 DEL-11） | `fanout.rs:283` `serde_json::from_value(value.clone())` | **属实** |
| C5 | 实时轨伪缓冲（06 U20 / 01 CNV-4） | `engine_channels.rs:715-720` `push_live` 后立即 `self.bridge.flush()` | **属实**。「伪缓冲」定性准确 |
| C6 | message-start 空实现（06 U18） | `messageHandlers.ts:72` 存在 `onMessageStart`；06 称空实现——本轮未展开函数体逐行，与 90/03 一致；契约锁定风险由 N6 覆盖 | **基本属实**（实现细节可再核） |

### 1.4 高亮 / Diff（U9 / U12 / P2）

| # | 主张 | 代码证据 | 判定 |
| - | ---- | -------- | ---- |
| D1 | `highlight.batch` 生产零发送（06 U9） | `render-worker.ts:27` `case 'highlight.batch'` 存在；全仓除 worker case 与 `api-adapters.ts:7` 注释外**无** `type: 'highlight.batch'` 的生产 `postMessage` 发送端 | **属实**。批通道为死层；A/B 裁决（接线 vs 删空通道）必要 |
| D2 | Diff 主路径仍同步 highlightCode | `DiffCardUnifiedView.tsx:35/89/255`、`DiffCardSplitView.tsx`、`WidgetDiff.tsx`、`ToolCallDiffPreview.tsx` 均同步 `highlightCode` / `highlightCodeSafe` | **属实** |
| D3 | StreamingCodeHighlighter 仅服务 batch 通道 | `streamingCodeHighlighter.ts` 被 `render-worker.ts:2` 引用；生产 UI 无直接 import | **属实**。与 U9 同票：B 路径应陪葬删除；A 路径则保留为唯一消费口 |

### 1.5 未接线设施（U4 / U5 / U6 / U7 / U8 / U3）

| # | 主张 | 代码证据 | 判定 |
| - | ---- | -------- | ---- |
| E1 | SharedGatekeeper 已 manage，热路径仍 per-call `new()`（06 U4 / 02 DEL-4） | `core_commands.rs:69-79` `SharedGatekeeper`；生产 `CommandGatekeeper::new()`：`shell.rs:235`、`process.rs:77`、`host_openers/execute.rs:97/180/304`、`cli_bridge.rs:101`、`readonly.rs:182`；`core_commands.rs:77` 仅 State 构造一次 | **属实**。02 站点清单与代码一致（含 02 §9 自称补漏的 readonly.rs:182） |
| E2 | G8 `truncate_tool_output` 仅 emergency（06 U5 / 02 DEL-10） | `tool_output.rs:178` 定义；生产唯一调用 `conex-compaction/engine.rs:579`；壳层 `src-tauri` 零调用 | **属实**。接正常路径后 emergency 保留——02 CON-6「1→2 同一算法」正确，非双实现 |
| E3 | send_pending_batch 有实现+单测、生产未调（06 U6） | `push/vendor/consumer.rs:192` `send_pending_batch`；`pusher.rs` 文档自证「周期 drain 挂点待装配」；`requeue_pending` 仅测试 | **属实**。「接线或物理删」二选一合理（功能面主控确认） |
| E4 | cleanup_logs 从未被壳调用（06 U7） | `conex-telemetry/file.rs:355` 定义 + 单测；`apps/agent-workbench` 零调用 | **属实**。注释「启动时执行一次」是承诺非事实 |
| E5 | take_night_summary 生产未调（06 U8） | `push/engine.rs:335` 定义；仅 `engine.rs` 内单测调用 | **属实** |
| E6 | moka 32MiB 预算常量未接入 builder（06 U3） | `cache.rs:13` `CACHE_BUDGET_BYTES = 32MiB`；`:31/:50` `max_capacity(CACHE_MAX_ENTRIES)` + `weigher(estimate_size≈字节)` | **属实且比计划更糟**：weigher 存在时 `max_capacity` 单位=权重和，`2048` ≈ **2KB 级权重预算**而非 2048 条；计划「条目上限冒充字节预算」方向对，实际是「极小字节权重误当条目上限」——修复应 `max_capacity(CACHE_BUDGET_BYTES)`，判定 **属实（严重度不低于计划）** |
| E7 | output_budget_bytes 默认 None | `tool_events.rs:343` Default → None；`executor_types.rs:31` Default → None；壳 `src-tauri` 无 `Some(...)` 装配 | **属实**（02 DEL-8 / 01 T-L1-B） |

### 1.6 渲染 / 资产（03 / 04）

| # | 主张 | 代码证据 | 判定 |
| - | ---- | -------- | ---- |
| F1 | 流式热路径静态 `split(fullText)`（03 D1） | `useStreamingBlocks.ts:67` `IncrementalBlockSplitter.split(fullText)` 每 useMemo 执行；实例 API 存在但未作热路径 | **属实** |
| F2 | 每帧全文 hash16 | `useStreamingBlocks.ts:83-85` 封口判定前对 blockText 算 `hash16`（每帧对全部封口块） | **属实**（「封口瞬间一次」目标正确） |
| F3 | will-change 常驻 + 契约测试锁定错误行为（03 D8） | `streaming-animation.css:31` `will-change: opacity, transform`；`streamingAnimationContract.test.ts:80-81` 断言「必须声明」 | **属实**。契约测试**必须反转**，否则删除被门禁回潮——03 §8 分歧 #6 正确 |
| F4 | motion 死依赖 vs animated-icons 仍 import（04 DEL-1 / 06 P12） | `package.json` 有 `motion`；`animated-icons/{Pin,PinOff,Copy,Pencil}Icon.tsx` 均 `import … from 'motion/react'`；**生产 iconMap 走 hugeicons `PinIcon`**，animated-icons 仅 `__tests__` + `index.ts` 自引用 | **04 部分夸大**：「应用代码零引用」不成立——源码 import 真实存在；更准确是「**生产入口图零引用**（仅测试可达）」。**06 P12 复核立场正确**（不可按纯死依赖盲删而不处置 4 个组件+测试） |
| F5 | 隐藏终端仍 term.write / 高亮双通道同 03 | 本轮未逐行核 ptyLifecycle；与 02-X1 报告一致，列为**未抽样** | 待实现前再核（不影响本表核心） |

### 1.7 扫读计划交叉（02 / 04 / 05）

| # | 主张 | 代码证据 | 判定 |
| - | ---- | -------- | ---- |
| G1 | 02 DEL-1 壳 fs 三命令同步 fn | 本轮未逐行核 `fs_commands/mod.rs` 签名；与 06-FS01 一致 | 待核实（计划互证充分） |
| G2 | 05「无纯新增、全含删除」总断言 | 05 §D5 列 diff SSOT / perf 资产；与 16-P5 等一致 | **基本属实**；实施时仍须防「只接线不删旁路」 |
| G3 | 04 DEL-8 startup-budget 静态图仅信息打印 | 本轮未打开脚本；06 U10 与 16 报告一致 | 待核实（低风险） |

---

## 2. 「删除」是否被误写成「兼容读 / 双写」总评

| 检查点 | 结论 |
| -------- | ---- |
| S1 / DEL-6 LS 索引 | **合格**：一次性 migration → 删键 → **删读写代码**；明确禁止「LS 优先兼容读」与双写（06 §4.3、01 Layer-3） |
| S2 / DEL-5 partialize | **合格**：字段物理删除 + 旧键 sessions 字段清理；03 禁「双写一段时间」 |
| S3 LS body | **合格但留缝**：保留一次性 migration；`sessionRustDbSql` invoke-fail LS fallback / `persistAllSessionsLocalFallback` 被 01 §7 标「待核实产品语义」——**正确**，避免把可能合法的降级轨写成静默删除；须在任务书显式裁决「删或降为元数据-only+删除日期」 |
| U1 组提交 | **合格**：接线+删旁路同票；migrate/GC 短事务白名单显式登记，避免误删合法主锁路径 |
| U9 highlight | **合格**：A/B 二选一，禁止长期空通道 |
| U14 Progress | **合格**：用户裁决前禁止静默删构造——与 05 一致，非「假装删除」 |
| DEL-2 形态替换 | **合格**：标注 `1→1（形态替换）` 而非假称文件级删除 |
| 风险点 | 02 DEL-8「装配默认 None 删除」与 UOUT 改默认是**改语义**不是删路径——计划用「物理删除清单」收录略宽，执行时应用「默认值切换+旧 Default 路径删除」双动作描述，避免评审误解为删文件 |

**结论**：三份主案（01/03/06）未发现把「兼容读/双写」偷写成「物理删除」的系统性误导；唯一需警惕的是 LS body/command-missing fallback——计划已用诚实边界覆盖。

---

## 3. 死层陪葬测试清单合理性

| 对象 | 计划策略 | 核实 | 建议 |
| ---- | -------- | ---- | ---- |
| 组提交旁路 | 保留 group_commit 单测；删/改写「直写主锁」断言 | 合理 | 白名单（migrate/GC）测试保留 |
| LS 索引 | LS-only 用例改「migration 后键不存在」 | 合理 | 量大：`sessionPersistence*` / `WriteModel` / `migrateFromLocalStorage` 须一次性过表 |
| persist sessions | partialize 契约测试改写 | 合理 | 补「set 后 LS 无 sessions 大 JSON」负向 |
| highlight 收敛 | DiffHighlighting 改最终通道 | 合理 | B 路径须陪葬 batch 侧单测 + StreamingCodeHighlighter 测试 |
| streamingAnimationContract | **必须反转**断言 | 03 明确；06 未强调——**补进 06/N 维** | 否则 will-change 删除被 CI 打回 |
| animated-icons | 04：迁测试 fixture 或删 | 合理 | 与 motion 依赖同票；iconMap hugeicons 不动 |
| moka | 改 builder 后「超预算 miss 可观测」 | 合理 | 现有 cache 测试若断言条目上限语义须同步改权重语义 |
| reference/markdown-editor / e2e 专项 | 禁止随删 | 06 §3.5 已写；符合 AGENTS §9 | **必须保留** |

**判定**：陪葬清单总体合理；缺口是 **will-change 契约测试反转**须在 06 总表显式登记，避免 D3/D6 与 03 并行时漏改。

---

## 4. 必须改清单（给主控合并 92 时强制采纳）

| # | 优先级 | 改什么 | 依据 |
| - | ------ | ------ | ---- |
| M1 | 高 | **moka U3 任务书补一句**：修复目标是 `max_capacity(CACHE_BUDGET_BYTES)`；现状因 weigher 而 `max_capacity(2048)` ≈ 2KB 权重，比「预算未接线」更严重；禁止只把常量改名不改 builder | cache.rs:13/31/50 |
| M2 | 高 | **06 P12 / 04 DEL-1 对齐措辞**：motion 为「生产入口图零引用、animated-icons 源码仍 import、仅测试可达」；删除票必须同票处置 4 组件+测试+lock，禁止只删 package.json | animated-icons import + iconMap 走 hugeicons |
| M3 | 高 | **06 §3.5 与 03 D8 联票**：`streamingAnimationContract.test.ts` 必须在 will-change 删除**同 PR** 反转为「非常驻 will-change」负向断言 | contract.test.ts:80-81 锁定错误行为 |
| M4 | 高 | **LS command-missing fallback（listSessions/loadSessionBody/persistAllSessionsLocalFallback）** 在 92 定稿中显式裁决：删除 / 或「元数据-only + 删除日期」；禁止无限期无日期双轨 | 01 §7.2；sessionRustDbSql.ts:85/106 |
| M5 | 中 | **U17 双发删除面**保持 D5 契约评审前置；任务书禁止在契约前用「前端忽略重复」冒充收敛 | run_idle.rs:1405-1421 仅 skip delta |
| M6 | 中 | **U9 默认票倾向**：若主控未明确功能价值，倾向 **B（物理删 batch + StreamingCodeHighlighter）**——生产零发送已核实；A 路径须另开接线票+Diff 改造，避免空转 | render-worker 无发送端 |
| M7 | 中 | **U6/U8 功能裁决**保持「接线或物理删」；禁止保留「有实现+单测+生产零调用」的第三态 | consumer.rs / engine.rs 测试-only |
| M8 | 中 | **U1 负向断言**采用「域模块无 `conn.lock`+写」脚本，白名单表入库；`cas_gc` / `import` / `migrate` 是否白名单由任务书点名，防止漏删或误删 | 90+ 处 lock 分布 |
| M9 | 低 | **U15 resolveEventType ×3** 执行前由实现 Agent 数调用点；01 已标结构风险，勿写死「恰 3」 | 本轮未穷举 |
| M10 | 低 | 04 DEL-8 / 06 U10 启动预算脚本读码待主控或实现轮补一次，避免门禁票基于旧静态图语义 | 本轮未开脚本 |

---

## 5. 误报 / 漏报摘要

### 5.1 误报（主张过强或措辞不准）

| 条目 | 说明 |
| ---- | ---- |
| 04 DEL-1「应用代码零引用 motion」 | 源码 animated-icons 仍 import；应改为「生产入口图零引用」；06 P12 已部分纠正，04 定稿须同步 |
| 01 DP-INV-3 表述「全仓 db.write / writer().write 生产命中 0」 | `group_commit.rs:187` Actor 内部使用 `self.write`——**Writer 路径存在且被组提交使用**；准确说法是「**域方法旁路未改道到 Writer**」，不是「Writer 零命中」。属表述夸大，不影响删除面方向 |

### 5.2 漏报 / 不足（删除面应补）

| 条目 | 说明 |
| ---- | ---- |
| moka 权重单位错配严重度 | 计划按「预算未接线」；实态可能是 2KB 级——须升级任务书（M1） |
| will-change 契约测试 | 03 有、06 总表未强制登记——并行时易漏（M3） |
| `sessionRustDbSql` 对 **body** 的 LS 回退 | 与索引双源同等重要；01 T-L3-A 有覆盖但 06 S 清单偏索引——合并 92 时显式入 S1/S3 | 
| StreamingCodeHighlighter 陪葬 | 06 U12 有；B 路径删除时测试与文件同票 |
| batch_version | 属实；01 DEL-8 正确——06 未单列可接受（S4 联动） |

### 5.3 未发现的问题

- 未发现把「活功能」整体当死层欲删的关键误报（U14 Progress 已强制用户裁决；U6 已要求功能确认）。
- 未发现系统性「假删除真双写」话术。

---

## 6. 一句话结论

**核实 16+ 条关键删除锚点：组提交/LS 双源/partialize/双 parse/先删后插/NoPersist 取号序/SharedGatekeeper per-call/highlight.batch 死通道/G8 仅 emergency/push·telemetry 未接线等删除面全部真实；计划方向正确，须修 moka 严重度表述、motion「零引用」措辞、契约测试反转联票与 LS body fallback 显式裁决。**

---

## 7. 汇报元数据

| 项 | 值 |
| -- | -- |
| 核实条数 | **16**（A1–A6, B1–B3, C1–C6, D1–D3, E1–E7, F1–F4 为主；G 项标注待核） |
| 明确误报 | **2**（motion 措辞；writer「生产命中 0」表述） |
| 明确漏报/不足 | **4**（moka 严重度、契约测试联票、body LS fallback 入 06 总表、高亮陪葬） |
| 一句话结论 | 删除面总体属实且未误写成兼容读；按 §4 必须改清单修订后可并入 92。 |

---

_评审 Agent · 只读评审批次 · 未 git commit · 未修改生产代码。_
