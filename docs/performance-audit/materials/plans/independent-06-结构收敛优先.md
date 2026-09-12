# independent-06 · 结构收敛优先的系统性修复总计划

> **战役**：performance-audit → performance-fix  
> **创建**：2026-09-13  
> **性质**：独立完整修复总计划（主视角：**结构收敛优先**——先删后改、路径 N→M 为完成定义）  
> **上游**：`00-性能审查总纲.md`、`90-发现清单索引.md`（396 项 / 86 高 / 16 簇）、各 01–16 报告、`materials/plans/README.md`  
> **对照**：`91-系统性修复总方案.md`（主控草稿，非绑定；本方案在若干取舍上可推翻/反转，见 §8）  
> **明确不谈**：工期、人天、人员安排、业务优先级排序。问题与删除事项逻辑同权；**收敛在逻辑序上先于增强**。

---

## 0. 强制原则（结构收敛红线）

### 0.1 推进单位 = 领域概念，不是文件或批次

每个任务开工前必须能填下表（填不出 = 不立项）：

| 概念 | 现在几条路径 | 本任务删/并到几条 | 主路径标识（文件锚点） | 副路径处置 |
| ---- | ------------ | ------------------ | ---------------------- | ---------- |
| 例：SQLite 域写 | 2（`conn.lock` 主锁直写 / `writer.write` 组提交 Actor） | → 1 | `LocalDb::write` → `DbWriteHandle` | 旁路直写物理删除 |
| 例：会话索引 | 2（LS `crish_session_index_v1` / SQLite `list_sessions`） | → 1 | SQLite | LS 读/写面删除 + 一次性 migration |

### 0.2 三分类问题池（与 v3 一致）

- **缺陷** → 修复；
- **缺失** → 新增；
- **重复实现 / 死层 / 未接线 / 多路径 → 删除或收敛事项**（完成方式，不是砍范围）。

**禁止只加不删。** 每一轮执行必须携带至少一项**负产出**（删除死层 / 合并路径 N→N−1 / 移除未接线标记 / 物理切除孤岛），除非主控在任务书预注明豁免。

### 0.3 完成定义（结构收敛双验收）

功能验收 **且** 负产出验收：

1. 该概念路径数从 N 减到 M（M=1 为默认目标；例外须写明为何保留双路径及删除日期）；
2. 被删副路径在生产代码中 **0 调用点**（grep 负向 + 行为级）；
3. 无新增 TODO/FIXME/未接线标记；
4. 五端物证（触发/传输/介质/消费/负向）见 §6。

### 0.4 与 91 的根本差异（定位声明）

| 维度 | 91 草稿 | **本方案（结构收敛优先）** |
| ---- | ------- | -------------------------- |
| 主序 | Layer 0 预算 SSOT → L1 阻塞 → L2 事件 → … → L7 资产 → L8 契约 | **D0 枚举删除面 → D1 死层/已建未接线裁决 → D2 孤岛双轨切除 → D3 重复实现收敛 → D4 再做行为修复/增强** |
| 完成锚 | INV-1…INV-8 不变量 + 五端 | **每个概念的 N→M 表 + 删除面总表打勾**；不变量为派生验收 |
| 删除地位 | L0 有切除登记表，但主路径是「接线 + 优化」 | **删除是阶段 D1–D3 的主体**；接线仅在「有价值设施」上做，接线后立即删旁路 |
| 典型决策 | 「组提交接线」偏工程增量 | 「组提交接线 **+ 删除全部 `conn.lock` 生产写**」= 同一票完成 |

---

## 1. 全局效果与维度划分

### 1.1 全局效果（收敛后端到端不变量）

```text
【产生】provider SSE
  → session-loop：单一 AgentEvent 模型（Arc；收口 move；无三连克隆）
  → 单一写出口：Group Commit Actor（禁止 conn.lock 生产写扩散）
  → EventBridge：实时轨 / 收口轨 / 旁路——旁路只读 meta 或 Arc，禁止全量 from_value
  → 前端 transport：parse 恰 1 次；数据面单路由；废弃账本字段 0 残留
  → 热缓冲 → 展示层（memo 完整；Diff 走 worker 批通道或明确单一同步路径）
【存储】SQLite 唯一法定存储（组提交 + ReaderPool + 增量 save + 索引）
  - 会话索引 1 源（SQLite）；LS 键物理消失
  - sessionStore.persist 不再持有 sessions 全量
【预算】全链同一 budget 源（Rust + 前端 re-export）；散落 cap 常量删除
【门禁】已建设施全部接线或物理删除；check-startup-budget fail + CI
```

### 1.2 维度划分（结构收敛序）

| 维 | 名称 | 核心问题 | 删除/收敛主锚 |
| -- | ---- | -------- | ------------- |
| **D0** | 删除面总表与路径地图 | 未系统枚举「同一概念多路径 / 死层 / 未接线」 | 产出本方案 §3 总表（执行时打勾） |
| **D1** | 已建未接线（接线 or 删） | §3.2 的 14 项 + 交叉验证 | 每项二选一：接线后删旁路，或承认死资产并删 |
| **D2** | 存储与会话双轨孤岛 | LS 索引双源 / persist 全量 sessions / 降级镜像残骸 | 孤岛 0 读 0 写；物理删键与读写代码 |
| **D3** | 重复实现收敛 | diff 双实现 / highlight 双通道 / Gatekeeper 双构造 / 账本四套 / estimate 双扫 | N→1 SSOT；陪葬测试列出后删 |
| **D4** | 阻塞 IO 与热路径行为修复 | spawn_blocking / 收口克隆 / 组提交吞吐 / memo | 依赖 D1 组提交与 D3 单路径 |
| **D5** | 传输与事件语义（含强契约） | 双发 / message-start / PE-02 / Progress | 强契约评审后实现；禁止静默砍功能 |
| **D6** | 资产、启动与门禁 | catalog 静态边 / 体积门禁 / 死依赖与冗余资产 | 断边 + 门禁 fail；无用资产删除 |
| **D7** | 观测闭环与防回潮 | 防御脚本 / V 回填 / 删除史登记 | 负向断言全绿；维护模式入口 |

**逻辑同权**：不以业务优先级砍项；但 **D1–D3 在拓扑上先于 D4–D6**（先删后改）。

---

## 2. 依赖与逻辑顺序

```text
D0 枚举（只读盘点，不改代码）
   │
   ▼
D1 已建未接线逐票裁决
   │  ├─ 有价值 → 接线（写路径改道）
   │  └─ 接线完成同票删除旁路/死实现
   │  （组提交、moka 预算、SharedGatekeeper、G8、cleanup_logs、
   │    send_pending_batch、highlight.worker、startup-budget、ReaderPool）
   ▼
D2 持久化孤岛物理切除
   │  （LS 索引单源收口、persist partialize 删 sessions、
   │    降级戳/镜像残骸、NoPersist 跳取号）
   │  依赖：D1 组提交与 save 增量可先接线主路径，再切孤岛
   ▼
D3 重复实现收敛（纯删除或合并，禁止新开第三条）
   │  （diff SSOT、highlight 单通道、StreamState 账本、
   │    estimate/tools 缓存、motion/字体/CSS 冗余）
   ▼
D4 行为修复（阻塞面 / 收口 clone / 前端 memo / 终端）
   │  依赖：D1 阻塞与 D3 单实现已就位，避免在双轨上修两遍
   ▼
D5 强契约事件语义（双发、message-start、PE-02、Progress）
   │  依赖：D2/D3 传输与存储单轨
   ▼
D6 资产与门禁终态
   ▼
D7 观测 + 防御脚本全接 CI + 删除史 + 维护模式评估
```

**禁止顺序反例（本方案明确禁止）：**

- 未删除 `conn.lock` 生产写之前，不得宣称「写路径已优化」；  
- 未物理切除 `crish_session_index_v1` 读写代码之前，不得加「更聪明的 LS 回退」；  
- 未选定 diff SSOT 之前，不得在第三处再写一份 unified parser；  
- 未接线或裁决删除之前，不得用 `#[allow(dead_code)]` / 空 handler 把未接线「锁成完成」；  
- 未完成 D1–D3 删除面打勾之前，不得以「新增监控/新增缓存」开新路径。

---

## 3. 删除面总表（专节 · 本方案核心）

> 执行时逐项打勾；「处置」仅允许：**接线后删旁路** / **物理删除** / **合并进 SSOT** / **主控裁决保留（附删除日期）**。  
> 「主控裁决保留」不得默认使用；无删除日期的降级路径不允许合入（v3 §8.4）。

### 3.1 已建未接线（90 §3.2 + 代码复核）

| # | 设施 | 证据锚点 | 现状路径 | 目标 N→M | 处置 | 陪葬/同步删除 |
| - | ---- | -------- | -------- | -------- | ---- | ------------ |
| U1 | 组提交写 Actor | `conex-db/src/lib.rs:134` spawn；`sessions.rs`/`events.rs`/`runs.rs`/`blocks.rs` 等全部 `self.conn.lock()` | 2→1 | 接线后删旁路 | 全部域写改 `LocalDb::write`；**删除** `conn.lock` 写分支与「主锁可写」公开面；迁移/GC 短事务白名单显式登记 |
| U2 | ReaderPool 读 | `lib.rs:223-264` 优先池，失败回退主 Mutex；大量域读仍 `conn.lock` | 2→1 | 接线后删旁路 | 读全走 `read`/`read_async`；禁止生产路径裸锁读（测试白名单） |
| U3 | moka 32MiB 预算 | `conex-markdown/src/cache.rs:13` `CACHE_BUDGET_BYTES` 定义；`:31,:50` `max_capacity(CACHE_MAX_ENTRIES)`+weigher——预算常量未接入 builder | 2→1 | 接线后删死常量语义 | `max_capacity(CACHE_BUDGET_BYTES)`（weight 单位=字节）；删除「条目上限冒充字节预算」的错位配置；`CACHE_MAX_ENTRIES` 若无独立语义则删 |
| U4 | SharedGatekeeper | `core_commands.rs:70-82` 已 manage；`shell.rs:235`、`host_openers/execute.rs:97` 等 **每次** `CommandGatekeeper::new()` | 2→1 | 接线后删 per-call | 全路径注入 State/Arc；**删除** 生产 `CommandGatekeeper::new()` 热路径调用（单测可留构造） |
| U5 | G8 tool_output 截断 | `conex-compaction/src/tool_output.rs:178`；正常工具路径未调（仅 emergency `engine.rs:579`） | 2→1 | 接线正常路径后删「仅 emergency」旁路语义 | `truncate_tool_output` 挂到统一 `output_budget`；emergency 与 normal 同一函数 |
| U6 | send_pending_batch | `push/vendor/consumer.rs:192` 有实现+单测；生产 drain 未调 | 2→1（有/无消费） | 接线或删 | 装配周期调用；容量上限；未装配时明确丢弃策略。若产品放弃离线队列 → **物理删除** pending VecDeque 与 requeue（需主控确认功能面） |
| U7 | cleanup_logs | `conex-telemetry/src/file.rs:355`；壳从未调用 | 2→1 | 接线 | 启动一次 `cleanup_logs`；删除「只增不减」残留文档承诺与未调用标记 |
| U8 | take_night_summary | `push/engine.rs:335`；生产未调 | 2→1 | 接线或删 | 有产品价值则挂周期；否则删 NightSummary 聚合与 folded 无上限逻辑 |
| U9 | highlight.worker 批通道 | `render-worker.ts:27` `highlight.batch` case；**全仓无生产端 `postMessage` 发送该消息**（仅 worker case + `api-adapters.ts:7` 注释提及）；Diff 卡片仍同步 `highlightCode`（`DiffCardUnifiedView.tsx:35` 等） | 2→1 | 接线后删 Diff 同步路径 **或** 删空通道 | 二选一主控裁决：A=Diff 改批量 worker（补生产发送端，删主线程同步热点）；B=**物理删除** `highlight.batch` case + `StreamingCodeHighlighter` 及陪葬测试（生产零发送 → 批通道为死层） |
| U10 | check-startup-budget | 脚本存在；不 fail 静态图；不进 ci.yml | 1→1（已接线但弱） | 强化+CI | 静态图合计 fail；接入 `ci.yml` 与 `check:desktop`；删除「仅信息展示」行为 |
| U11 | PendingApprovalStore | push/pending 注册面；装配未注入 | 2→1 | 接线或删 | 与 U6 同票裁决 |
| U12 | worker 增量高亮器 | `streamingCodeHighlighter.ts` | 见 U9 | 二选一 | 死则删；活则保证唯一消费口 |
| U13 | perf/fs mmap read_chunk | `src-tauri/src/perf/fs.rs:48`；`bg_log.rs` 已消费部分；预览主路径未走 | 1.5→1 | 接预览或删 mmap 分支 | 若 06-S 预览分页采用同读实现 → 接线；否则 **删除** mmap 大块分支，保留简单 read_chunk |
| U14 | Progress 回调 | 工具事件链构造；执行侧恒 None；前端零消费 | 3→0 或 3→1 | **需用户裁决**（v3 禁止静默砍） | 裁决前不得静默删构造；裁决接线则消费端真实读；裁决停用则删构造链与 schema 字段（契约评审） |
| U15 | resolveEventType 多次 | 03-V1：每事件跑 3 次 | 3→1 | 合并 | 数据面预过滤与 parse 内共享同一 envelope 结果 |
| U16 | 事件双 parse（dataPlaneRouter + EventRouter） | 03-V1 / `EventRouter.ts:219-227` | 2→1 | 合并 | 数据面已 parse 则不得再 strict parse |
| U17 | 非增量事件双发 | 03-R2 | 2→1 | **D5 契约** | 实时轨已发则收口只补 DB/sequence |
| U18 | message-start 全文零消费 | 前端 `onMessageStart` 空实现 `messageHandlers.ts:72-76`；载荷仍全文 | 2→1（有效消费） | 契约瘦身或改用途 | 禁止「解析后丢弃」当修复；瘦身字段或改仅 id/meta |
| U19 | NoPersist 仍取号 | 03-R3 / events append 链 | 2→1 | 删除取号链 | NoPersist：0 次 reserve_sequence |
| U20 | flush 伪缓冲 | 03-R7 | 2→1 | 删伪 | 真窗口缓冲或明确立即 flush 语义并删「缓冲」叙事 |

### 3.2 存储与会话双轨

| # | 孤岛/双路径 | 证据锚点 | 目标 | 处置 |
| - | ----------- | -------- | ---- | ---- |
| S1 | 会话索引 LS 优先 SQLite 回退 | `sessionRustDbHydrate.ts:159-326`；`SESSION_INDEX_KEY = crish_session_index_v1`（`sessionPersistenceTypes.ts:5`）；`sessionRustDbFallback.ts:37-47` | 1 源 | **SQLite 单源**；LS 索引键删除；migration：LS→SQLite→删键→**删读写代码** |
| S2 | zustand persist 全量 sessions | `sessionStore.ts:63-69` partialize 含 `sessions` | 1 写口 | partialize **删除** sessions（仅保留真正 LS 域：activeSessionId/folderOrder/drafts 等若产品需要）；旧 `crish_session_store` 中 sessions 字段启动清理 |
| S3 | 正文多路径（SQLite / 历史 LS body / 降级戳） | T2-1 已删正文镜像写；`migrateFromLocalStorage`、`sessionRustDbLegacyCleanup` 仍处理 LS body | 1 落点 | 保留 **一次性** migration 后，删除运行期 LS body 读逻辑与 30 天窗口特殊分支（migration 失败可观测） |
| S4 | save_session_body 全量 DELETE+INSERT | `messages.rs:50-101` | 1 增量语义 | dirty 检测 + 增量 upsert；删除「先删后插」实现；batch_version 真实消费 |
| S5 | 会话 HashMap 四件套无 delete | 09-H1 | 1 生命周期 | delete_session 清理钩子；删除「只增不减」路径 |
| S6 | composerDrafts 删除悬挂 | 08-M5 | 1 | 与会话删除级联或改独立 LS；删除悬挂 |

### 3.3 重复实现与多路径（概念 N→M）

| # | 概念 | 现在 N 条路径 | 目标 M | 证据 | 删除/合并动作 |
| - | ---- | ------------- | ----- | ---- | ------------- |
| P1 | unified diff 解析 | ≥3：`toolFeedbackDiff.ts` `parseUnifiedDiffs`、`perf::diff::parse_unified_diff`、`streaming-diff-parser.ts`、Rust `conex-diff` | 1 | 16-P5；三处 API 同名异义 | 主控定 SSOT：**结构化消费用 Rust `conex-diff` 或统一 TS 解析器之一**；删除另一份业务调用；perf 域若仅 bench 可降级为 bench-only 并标注 |
| P2 | 代码高亮 | 同步 hljs 主线程 / worker batch / StreamingCodeHighlighter | 1 主 + 可选 async | 12-D1；U9 | 见 U9；**禁止**再开第三通道 |
| P3 | Gatekeeper 构造 | Shared 单例 / per-call new | 1 | U4 | 删 per-call |
| P4 | Stream 文本账本 | `assistantText`+`turnStreamedTexts`+`turnAuthoritativeTexts`+`messageEndTurnSegments` 等 | 1 权威 + 1 增量 | `streamState.ts:29-68` @deprecated 已标 | **删除** @deprecated 字段与写路径；测试改单轨 |
| P5 | estimate_context / tools JSON | 每请求重建 tools_schema×2 + tools_prefix；≤3 次/turn | 1 run 级缓存 | 04-S3、13-H2；`compaction_dispatch.rs:92-104` | run 预计算一次；删重复 to_vec/序列化 |
| P6 | 轮询双源 | background_tasks 双通道语义 | 1 | 03-V2 | 单 API；删空转源 |
| P7 | 会话水合双轨 | 双 fetch active session | 1 | 07-D3 | 合并水合入口 |
| P8 | estimate 与 compact 双扫 | prepare_turn hold→compact→record 与边界双扫 | 1 扫 | 04-S6、13-M1 | 合并扫描 |
| P9 | 摘要 LLM 调用 | 正常 compact / overflow 二次 / preflight 二次 | 1 | 13-M4/M5 | 删二次 compact 路径 |
| P10 | 工具输出表示 | text / output 双表示多级 clone | 1 Arc | 10-T4、04-T1 | Arc 贯穿；删非 Arc 变体重复 |
| P11 | 事件旁路全量解析 | webview + fanout + push ≥3 次 | 各 1 次 meta | 15-XOV01 | meta-only；删 from_value 全量克隆 |
| P12 | motion 依赖 | package.json `motion` + 4 个 animated-icons | 1 或 0 | 11-B6「死依赖」与代码 import 并存 | **复核**：`PinIcon` 等确 import `motion/react` 则 11-B6 不完全成立——改为「验证 tree-shaking / 替换为 CSS 动画后删依赖」；若产品动画废弃则删 4 文件+依赖 |
| P13 | 字体双格式 | woff+woff2 | 1 | 11-B9 | 构建删 woff |
| P14 | theme/layout 同步 rehydrate | 多 store 模块加载期同步 JSON.parse | 1 有序 hydration | 07-D4/F1 | 收敛 boot 解析；删重复键 |
| P15 | 审计通道 + EventBuffer 双驻留 | Unbounded + Critical 超限接受 | 1 有界 | 04-O1、09-A1/B1 | 有界化；删超限接受 |
| P16 | 搜索索引每调用全量 walk | fuzzy_find 重建 | 1 缓存索引 | 06-SR03 | 复用 SharedSearchState；删 per-call 全量 |
| P17 | 读文件整读再切 / 窗口读双实现 | agent-tools 与壳 fs | 1 共享 `conex-fs` | 06-SR02、FS02 | 共享实现；删重复整读 |

### 3.4 未接线标记 / 死代码 / 波次命名残留

| # | 项 | 动作 |
| - | -- | ---- |
| N1 | `01-L1` 增量高亮死代码判定 | 与 U9/P2 合并裁决；死则删文件与测试 |
| N2 | `#[allow(dead_code)]` 生产遮羞（telemetry/file、doc-collab、watch 等） | 逐个：真死→删；测试-only→`#[cfg(test)]`；假活→去 attribute |
| N3 | `revert.rs` 等 TODO 接线标记 | 完成接线或删除空壳路径；**禁止**保留无删除日期的 TODO 兼容层 |
| N4 | 浏览器 import `verify.rs` CDP TODO | 标注独立特性或删半成品 |
| N5 | 存量波次命名文件 | 本仓 crates 扫描未见 `w6_a_s.rs` 类；若后续出现列入删除/重命名 |
| N6 | `allow(dead_code)` + 空 handler 锁完成 | `onMessageStart` 空实现属显式契约锁定——与 U18 契约瘦身联动，不得当「已修复」 |

### 3.5 陪葬测试（删除前主控确认清单）

| 对象 | 陪葬测试策略 |
| ---- | ------------ |
| 组提交旁路删除 | 保留 group_commit 单测；删除断言「直写主锁」的旧测试或改写为 writer 路径 |
| LS 索引删除 | `sessionPersistence.test.ts` 中 LS-only 用例改为「migration 后键不存在」断言 |
| persist sessions 删除 | `sessionStore` 持久化快照测试改 partialize 契约 |
| diff 收敛 | 保留 SSOT 侧 golden；删除另一侧重复用例（列表报主控） |
| highlight 收敛 | DiffHighlighting 测试改最终通道 |

**测试资产保护**：`reference/markdown-editor/` 与 e2e 专项 spec 不得随本计划删除（AGENTS §9）。

### 3.6 删除面规模统计（基线）

| 类别 | 条目数（本表） | 备注 |
| ---- | -------------- | ---- |
| 已建未接线 U1–U20 | 20 | 含 2 项需用户裁决（U6/U14） |
| 存储双轨 S1–S6 | 6 | S1/S2 为最高结构收益 |
| 概念多路径 P1–P17 | 17 | 每条强制 N→M |
| 标记/死代码 N1–N6 | 6 | 动态增长，执行中追加 |
| **合计** | **≥49 个删除/收敛锚点** | 执行时可增不可默认减 |

---

## 4. 分维度执行详案（逻辑依赖序）

### 4.1 D0 · 删除面总表落地（只读 + 登记）

**做什么**：不改生产代码；主控/审计位按 §3 逐项在代码复核打勾；任务书预分配 U/S/P 编号给后续 Agent。  
**删什么**：无（本维）；产出物 = 更新后的删除面总表。  
**文件域**：`docs/performance-audit/materials/plans/`（本文件及追踪表）。  
**验收**：每条 U/S/P 有「主路径文件:行号 + 副路径调用点列表」。

### 4.2 D1 · 已建未接线（接线 then 删旁路）

#### U1 组提交写路径收口（05-S1）

| 项 | 内容 |
| -- | ---- |
| 发现 | 05-S1、03-R4、05-W1 部分 |
| 路径 | 2（Actor / 主 Mutex）→ **1（Actor）** |
| 逻辑步骤 | ① 域方法 `upsert_session_entry`、`save_session_body`、`append_event`、`insert_run` 等改为 `self.write(...)` 或 `writer().write`；② `reserve_sequence` 单事务；③ NoPersist 短路；④ 删除生产 `self.conn.lock()` **写**调用（migrate/GC 短临界区白名单表）；⑤ 读侧逐步 U2 |
| 物理切除 | 与 Actor 并行的「主连接可写」路径；文档中「写走主锁」表述 |
| 负向断言 | grep：域模块无 `self.conn.lock` + `execute` 组合（白名单除外）；SQL 计数 NoPersist=0 取号 |
| 防御 | `check-db-write-paths` 或扩展测试 |

#### U3 moka 预算真生效（09-M1）

| 项 | 内容 |
| -- | ---- |
| 发现 | 09-M1 |
| 路径 | 2（错位 max_capacity / 死 CACHE_BUDGET_BYTES）→ 1 |
| 逻辑步骤 | builder `max_capacity(CACHE_BUDGET_BYTES)` + 既有 weigher；entry 级 `CACHE_ENTRY_MAX_BYTES` 预检保留；**删除**「字节常量永不接入」的死状态 |
| 负向断言 | `CACHE_BUDGET_BYTES` 出现在 builder；超预算权重缓存 miss 可观测 |

#### U4 SharedGatekeeper 唯一构造（14-SB1）

| 项 | 内容 |
| -- | ---- |
| 发现 | 14-SB1、14-SB2、14-OK1 交叉 |
| 路径 | 2→1 |
| 逻辑步骤 | shell/opener/cli/process 注入共享实例；`prepare` 单次 analyze；DNS/UIA 移出 async（可与 D4 合并同票） |
| 物理切除 | 热路径 `CommandGatekeeper::new()` |
| 负向断言 | 生产路径 `new()` 调用数=0（AST/正则） |

#### U5/U10/U7 及其余接线项

| 单元 | 发现 | 动作摘要 | N→M |
| ---- | ---- | -------- | --- |
| U5 | 13-H3 | G8 挂正常工具输出 | 2→1 |
| U7 | 15-TEL01 | 启动调用 cleanup_logs | 2→1 |
| U10 | 16-P1/P2、07-A2 | budget fail + CI | 1→1 强 |
| U6/U8/U11 | 15-PSHP* | **并行功能裁决**：接线或删 | 2→1 或删空 |
| U16/U15 | 03-V1 | 单 parse | 2→1 / 3→1 |
| U19 | 03-R3 | NoPersist 0 取号 | 2→1 |
| U13 | 06-PF01、16-P7 | 预览接 mmap 或删 | 1.5→1 |

### 4.3 D2 · 持久化孤岛切除

#### S1 索引单源

| 项 | 内容 |
| -- | ---- |
| 发现 | 07-D2、05 会话索引、S1 |
| 步骤 | ① 启动：LS 有而 SQLite 无 → 写入 SQLite；② 删 `lsLoadSessionIndex`/`lsSaveSessionIndex` 生产调用与键常量导出；③ `crish_session_index_v1` 启动删除；④ hydrate 只 `list_sessions` |
| 禁止 | 「LS 优先」兼容读；双写 |
| 负向 | 启动后键不存在；grep 键名业务引用 0 |

#### S2 persist 收窄

| 项 | 内容 |
| -- | ---- |
| 发现 | 08-H1、01-M9 |
| 步骤 | partialize 去 sessions；set 单会话不再 stringify 全量；旧 key 清理 |
| 负向 | set 后 localStorage 无 sessions 大 JSON |

#### S3–S6 与 U1/S4 联动

LS body 运行期路径删除；save 增量；会话删除钩子；drafts 级联。

### 4.4 D3 · 重复实现收敛

按 §3.3 P1–P17：**每条任务书必填旧路径清单与保留侧**。原则：

- 保留 **生产主消费** 一侧；  
- 跨层共享优先放 `conex-diff` / `conex-fs` / `perf_budget` 等底层包，禁止上层私有第二份；  
- 收敛任务 **串行**（v3：收敛类不得与并行 Agent 撞文件域）。

### 4.5 D4 · 行为修复（在单路径上做）

| 域 | 发现 | 前提删除项 |
| -- | ---- | ---------- |
| spawn_blocking 全面 | 06-FS01、06-SR*、10-T1、14-BR1、14-CP1 | U4 部分 |
| 收口 move/Arc、thought 块合并 | 04-S1/S2、09-L1/L2 | 无双路径；禁 token 合并 |
| 前端增量切分、卡片 memo | 01-H1–H3、02-T* | 无 |
| 隐藏终端、PTY 合批 | 02-X1/X2 | 无 PE-02 |
| 同步 LLM 摘要移出 loop | 13-H1 | U5 相关 |

### 4.6 D5 · 强契约（评审后）

03-R2 双发、03-C1 message-start、10-T3 Progress（U14 裁决）、03-R1 PE-02、03-R8 可见性——**评审通过前禁止实现**；禁止静默砍 Progress。

### 4.7 D6 · 资产与启动

断 catalog 静态边（07-A1/11-B1/B3）、modulepreload 摘除、zod 挪设置面、woff 删除（P13）、motion 裁决（P12）、字体/CSS 预算、setup 分级、索引单源与 S1 同票。

### 4.8 D7 · 观测与维护模式

压测进 CI、diff SSOT 后删 bench 死资产、V 项 4000 MCP 回填、防御脚本接入、**删除史**写入规范文档；连续两轮无新死层 → 维护模式。

---

## 5. 文件域与并行边界

| 单元 | 主文件域 | 并行约束 |
| ---- | -------- | -------- |
| U-DB-WRITE | `crates/conex-db/src/{lib,sessions,events,runs,blocks,messages,...}.rs` | **串行**收敛票；与前端 persist 不重叠 |
| U-LS-CUT | `apps/crish-desktop/src/api/session-persistence/*`、`sessionStore.ts`、`storageKeys.ts` | 与 U-DB-WRITE 可并行（不同端） |
| U-GATE | `conex-sandbox`、`shell.rs`、`host_openers`、`cli_bridge`、`process.rs`、`core_commands.rs` | 独立 |
| U-HIGHLIGHT | `codeHighlight.ts`、`DiffCard*`、`render-worker.ts`、`streamingCodeHighlighter.ts`、`api-adapters.ts` | 与 U-DIFF 协调同票 |
| U-DIFF | `toolFeedbackDiff.ts`、`perf/diff.rs`、`conex-diff`、`streaming-diff-parser.ts` | 与 U-HIGHLIGHT 串行若交叠 |
| U-XPORT | `EventRouter.ts`、`dataPlaneRouter`、`eventParser*`、`streamState.ts` | 账本删除与 parse 收敛同票 |
| U-BUDGET | `conex-shared`/`conex-types` 预算、`perfBudgets.ts`、`check-perf-budgets.mjs` | 可早并行；数字 SSOT |
| U-RENDER | streaming 切分、卡片链、virtualizer | 独立 |
| U-TERM | pty、xterm 生命周期 | 独立 |
| U-BUNDLE | vite、catalog import、`check-startup-budget`、`ci.yml` | 独立 |
| U-COMPACT | `conex-compaction`、`compaction_dispatch` | 与 U-EVENT 协调 tools 缓存 |
| U-PUSH | `push/*`、telemetry cleanup | 依赖功能裁决 |
| U-GUARD | 全部 `scripts/check-*`、守护单测 | 每层收口 |

**跨单元**：只读依赖或主控串行合并；文件重叠时 **收敛任务优先，功能任务让路**。

---

## 6. 验收标准

### 6.1 功能

- 各方向行为回归（流式、保存、恢复、工具、Diff、启动）；  
- 强契约项以 schema/registry 测试锁定。

### 6.2 负产出（每轮至少其一）

- 删除 ≥1 死层或副路径（记录有效删除行数与路径 N→M）；  
- 或合并 ≥1 组重复实现；  
- 或移除 ≥1 组未接线标记且新增同类=0；  
- 纯新增域须预豁免。

### 6.3 五端物证

| 端 | 物证 |
| -- | ---- |
| 触发端 | 真实 UI/工具可发起（非仅 mock） |
| 传输端 | manifest/registry/parser 一致 |
| 介质端 | 仅法定存储；旧孤岛 0 写；键/字段物理删除 |
| 消费端 | 真实调用点读取单一路径 |
| 负向断言 | grep 级行为级：旧类名/键/方法 0 命中；路径计数断言 |

### 6.4 立体验证（AGENTS §7.1）

编译/类型 **不得**单独作为交付；删除类必须有调用点消失的静态证明 + 关键行为测试；真实宿主经 **4000 Tauri MCP**（禁 9222/独立 5174）。

---

## 7. 与 90 发现 ID 映射（摘要）

| 本方案 | 90 |
| ------ | -- |
| D1 U1/U2 | 05-S1、05-R1、03-R4 |
| D1 U3 | 09-M1 |
| D1 U4 | 14-SB1/SB2 |
| D1 U5 | 13-H3、10-T4 |
| D1 U6–U8/U11 | 15-PSHP01/02/05、TEL01 |
| D1 U9/P2 | 12-D1、11-B7、01-L1 |
| D1 U10 | 16-P1/P2、07-A2 |
| D1 U15–U20 | 03-V1、R2、C1、R3、R7 |
| D2 S1/S2 | 07-D2、08-H1、01-M9 |
| D2 S4 | 05-W1、03-I1 |
| D3 P1 | 16-P5 |
| D3 P4 | 03-C4 |
| D3 P5 | 04-K1/S3、13-H2 |
| D3 P11 | 15-FAN01、PSHP03、XOV01 |
| D4 | 01-H*、02-X*、04-S*、06-FS01、10-T1、13-H1 |
| D5 | 03-R1/R2/C1/R8、10-T3 |
| D6 | 07-A1、11-B* |
| 簇 | C1–C16 全覆盖（本方案以删除面重排执行序，不减少簇） |

---

## 8. 与 91 的分歧（明确可推翻点）

| # | 91 取舍 | 本方案 | 理由 |
| - | ------- | ------ | ---- |
| 1 | 以 Layer 0 预算 SSOT **开局**，删除面登记表附在 L0 | **D0–D1 枚举+未接线/死层先裁决**；预算 SSOT 可与 D1 并行但不挡删除 | 多条病灶是「已建未接线」，先不删旁路则预算/优化打在双轨上 |
| 2 | 组提交「接线」偏增量改道 | 接线+**删除主锁写路径**同票完成 | 只接线不删旁路会永远残留双路径（05-S1 本质） |
| 3 | L0-D 列 6 孤岛 | 扩展为 **§3 总表 ≥49 锚点**（账本/双 parse/Gatekeeper/diff/highlight/mmap…） | 结构收敛需要全量删除面可见 |
| 4 | U9 highlight：12-D 走 worker | 维持接线优先，但 **同时准备删空通道** 裁决票 | 禁止长期「worker 空转+主线程双轨」 |
| 5 | 11-B6 motion 死依赖 | **代码显示 animated-icons 仍 import motion**——不完全按死依赖删 | 先验证 bundle 面；真死再删，避免误删资产 |
| 6 | Progress 在 L8 契约统一处理 | 提前 **U14 用户裁决票**（可与 D1 并行开评审） | 构造+None+零消费是三方死锁，裁决越早删除面越清晰 |
| 7 | 里程碑 M0–M8 偏「功能完成」 | 里程碑改为 **D0–D7 删除面打勾率** | 完成定义以 N→M 为中心 |
| 8 | 首轮 8 单元并行含较多增强 | 首轮优先 **串行收敛票**（DB 写、LS 切除、diff/highlight）+ 少量独立增强 | 收敛类并行易冲突；先删后改 |

**不推翻的部分**：INV 不变量、五端物证、PE-02 禁止未评审合并、测试资产保护、4000 MCP 通道纪律、预算单一源方向——全部保留为派生验收与实现约束。

---

## 9. 立即执行指令（启动时逻辑序）

1. **D0**：主控按 §3 亲自抽读 ≥3 文件/维复核（v3 §0.4），发布任务书编号。  
2. **并行（文件域不交）**：  
   - U-DB-WRITE：组提交接线+删旁路（串行核心）；  
   - U-LS-CUT：S1+S2 孤岛切除；  
   - U-GATE：SharedGatekeeper；  
   - U-BUDGET：预算源骨架（不挡删除）；  
   - U-PUSH 功能裁决准备（只读结论）。  
3. **随后串行**：P1 diff SSOT、P2/U9 highlight、P4 账本删除。  
4. D4 行为修复在对应单路径就绪后开。  
5. D5 契约开评审票，不在首轮实现。  

---

## 10. 主控轮末自检（结构收敛加强版）

1. 本轮每个改动概念的 N→M 是否写明？  
2. 是否出现「只加不删」？若豁免，依据？  
3. §3 总表打勾进度？新发现删除项是否登记？  
4. 是否有新 fallback 无删除日期？  
5. 波次命名/幽灵契约/双写是否为零？  
6. 未接线标记总数增减？  
7. 收敛任务是否误与并行 Agent 撞域？  

---

## 11. 维护模式

- **进入**：连续两轮固定审计无新死层/重复路径，未接线标记不增。  
- **退出**：发现新多路径或删除回潮 → 恢复强制负产出。  
- **删除史**：规范文档固定节记录「删了什么、为何、替代路径」，防借尸还魂。

---

*本方案为结构收敛优先独立总案。实现波仅认主控定稿 92 + 分维详案；本文件提供删除面总表与 N→M 完成定义作为 92 的交叉验证输入。未执行 git commit。*
