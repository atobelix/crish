# B3 TS 与 Rust 实现对比评审（边界划分 · 占比解读 · 决策原则）

- 评审方式：只读交叉对比——TS 与 Rust 侧各抽同功能实现，逐维比对「现状 → 谁更优 → 结论」
- 统计口径：全仓 `.ts/.tsx/.rs` 行数（`Measure-Object -Line`，排除 node_modules/target/generated）
- 基准 commit：`58ebaa93`（工作区）
- 评审日期：2026-08-02

---

## 0. 总体结论

**当前边界是合理的：逻辑层（agent 内核、状态机、存储、事件）在 Rust，展示层（React UI、渲染管线、前端投影状态）在 TS。TS 行数占比大（74.5%）主要来自 UI 组件与测试（占 TS 总量 46%），而非核心逻辑。** 具体缺口有三个：

1. **契约层半生成**：事件契约已走「Rust enum → 注册表 → 生成 TS」管道，但 IPC 命令清单（`commandManifest.ts`/`commandMap.ts`）与会话形状投影仍是手写双份，存在漂移风险（当前靠运行时一致性检查兜底）。
2. **会话写模型的并发一致性逻辑悬空**：批次版本戳 CAS 写模型（T08.10）只有测试文件先行（`sessionRustDbWriteModel.test.ts`），生产实现未导出，且该逻辑属于一致性领域，按边界原则应下沉到 `conex-db`（Rust 事务内），而非在 TS 端重造。
3. **TS 侧存在契约外残留**：`legacyDispatchTable` 4 个事件（subagent-*/error）不在 Rust 24 事件真源内，是双端契约的历史缝隙。

---

## 1. 同类功能实现对比

### 1.1 事件分发

**TS 现状**：`apps/crish-desktop/src/api/chat-bridge/handlers/dispatch.ts`

- 双表分派：`engineDispatchTable`（dispatch.ts:52-79，24 项）+ `legacyDispatchTable`（dispatch.ts:83-88，4 项）。
- `engineDispatchTable` 的类型是映射类型 `{ [ET in EngineEventType]: EngineHandler<ET> }`——`EngineEventType` 由生成器从 Rust enum 产出，**编译期保证 24 个键全部有 handler、无多余键**（穷举性来自生成代码，不是手写）。

```ts
// dispatch.ts:52-54
export const engineDispatchTable: {
  [ET in EngineEventType]: EngineHandler<ET>;
} = { 'agent-start': onAgentStart, /* ... 24 项 */ };
```

**RS 现状**：`crates/conex-types/src/events.rs`

- `AgentEvent` tagged enum 24 变体（events.rs:121-331），`#[serde(tag = "type")]`，顶层 `type` 为 wire 名。
- `engine_event_type_names!` 宏（events.rs:338-357）从同一份「变体 → wire 名」清单展开出 `type_name()` 与 `ALL_TYPE_NAMES`，新增变体编译期强制补 arm（events.rs:359-384）。
- 注册表一致性由 `tests/registry_drift.rs` 锁定；TS 侧生成产物由 `scripts/generate-engine-bindings.mjs` 产出。

**对比结论**：

| 维度 | TS | RS | 更优方 |
|---|---|---|---|
| 穷举性 | 靠生成类型编译期保证（24 项）；legacy 表 4 项手写、契约外 | enum 穷举 + 宏保证 type_name 与清单不漂移 | 平手（TS 已达同等级，前提是保持生成） |
| 类型安全 | 具体事件类型经 `EngineEnvelope<具体类型>` 分发 | 变体载荷内嵌类型，无字符串路由 | 平手 |
| 契约外残留 | legacy 表 4 事件（subagent-*/error）不在 Rust 真源 | 无 | RS |

**结论**：事件分发双方质量都高，TS 的穷举性完全依赖生成管道。风险点在 TS 的 legacy 表——应把 subagent-*/error 并入注册表（或显式登记为废弃），让 4 个手写入口消失。

### 1.2 状态机

**TS 现状**：前端已无域状态机。`streamingStore.ts`（store/streamingStore.ts:1-11）是「per-token 渲染缓冲」（文本/思考/tool 进度，避免每 token 触发 immer 消息数组重建），`useStreamCallbacks.ts`（hooks/chat-stream/useStreamCallbacks.ts:64-87）是事件→前端投影的编排层，不是状态转移裁决。旧 `createAgentSessionMachine` 已不存在（全仓 grep 无结果）。

**RS 现状**：`crates/conex-types/src/session.rs` + `transition.rs`

- 8 态（session.rs:17-34）× 20 事件（session.rs:41-84）作为一等类型；`Done` 为终态。
- 转移表 `apply_transition`（transition.rs:89-201）按 01 §1.4 逐行穷举 33 条已定义转移；未定义组合落入 `TransitionError::Undefined { state, event }` / `Terminal` **显式失败**（transition.rs:71-82），不静默忽略。
- 穷举测试锚定：8×20 全对要么转移要么显式错误（transition.rs:429-445，断言 defined=33）；error 收场仅由 §1.6 四事件产生（transition.rs:449-473）。

```rust
// transition.rs:199
S::Done => Err(TransitionError::Terminal),   // 终态拒绝一切事件
```

**对比结论**：

| 维度 | TS | RS | 更优方 |
|---|---|---|---|
| 不可达状态 | 无域状态机（前端只做投影，不裁决） | 8 态×20 事件类型化，未定义组合类型+测试双保险 | RS（唯一实现方） |
| 非法转移 | 无对应物 | 显式 `Undefined`/`Terminal` 错误 + 160 对穷举测试 | RS |
| 渲染状态 | zustand 无 immer 缓冲（合理留在 TS） | 无（引擎不关心渲染） | TS（展示侧） |

**结论**：状态机「唯一事实源在 Rust」已是事实，且这是正确归属——前端不再重复实现域转移。前端保留的只是「投影 + 渲染缓冲」，与 Rust 状态机无功能重叠。

### 1.3 数据层

**TS 现状**：`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`

- 14 个 API 走 `invokeResult` → Rust（sessionRustDb.ts:489-682），invoke 缺失/失败时回退 localStorage 同步路径（sessionRustDb.ts:22-24 三态协议）。
- JS↔Rust 形状转换手写：数组字段 ↔ JSON 字符串（`toolCallsJson`/`blocksJson`/`toolCallResultsJson`，sessionRustDb.ts:11-17 注释列差异、132-159 转换函数），字段命名差异靠手写投影接口 `RustSessionMessage` 等（sessionRustDb.ts:69-122）对齐。
- **批次版本戳写模型（T08.10）只有测试先行**：`sessionRustDbWriteModel.test.ts` 断言「串行队列 + 批次戳 CAS，旧批次晚执行不覆盖新批次」（:212-267），且从 `./sessionRustDb` 导入 `resetSessionWriteModelForTests`/`setLegacyLocalStorageCleaned`——但生产文件并未导出这两个符号（grep 确认），写模型实现悬空。

**RS 现状**：`crates/conex-db`

- 版本化迁移链 v1→v4（migrate.rs:60-141）：`PRAGMA user_version` 驱动、每版本独立事务、DROP 前整库备份（migrate.rs:21-53）、幂等可重试。
- 一致性由数据库原生保证：events 组合主键 `UNIQUE(session_id, sequence)`（schema.rs:20-27）、`session_sequence` 原子取号 `reserve_sequence`（events.rs:72-98，INSERT OR IGNORE 预热 + UPDATE 自增）、先删后插与多行写入均包事务（sessions.rs:184、messages.rs:62/120、agents.rs:100、import.rs:42）。

**对比结论**：

| 维度 | TS | RS | 更优方 |
|---|---|---|---|
| 一致性保证 | 依赖 invoke 三态 + 回退；写模型 CAS 是「计划中、未落地」 | 事务 + UNIQUE 约束 + 原子取号，数据库层保证 | RS |
| 并发写序 | 批次戳 CAS 语义已用测试定义但无生产实现 | 单连接串行 + 事务（WAL + busy_timeout 5000ms，migrate.rs:69） | RS（实现存在） |
| 形状转换 | 手写投影 + 守卫（sessionHydration） | serde camelCase 自动 | TS 现状偏弱 |

**结论**：数据层一致性归 Rust 正确且已到位；TS 端遗留两件事——（a）写模型批次戳若实现，应在 Rust 事务内做（Rust 侧已有 sessions.rs 的 CAS 模式，`expected` 条件更新），TS 只留薄 invoke 客户端；（b）形状投影应走生成（见 §2）。

### 1.4 错误处理

**TS 现状**：`packages/shared-types/src/errors/*`

- 77 码跨 20 域（codes.ts）、注册表元信息（info.ts）、IPC 序列化（serialize.ts）、cause 链深度上限 8。
- `normalize.ts` 是历史迁移层：`migrateErrorCode` 把旧 SessionErrorCode/ProviderErrorKind/自由字符串码/TOOL_ERROR 四类拆并到新码（normalize.ts:14-133），`normalizeCrishError` 兜底归一（normalize.ts:146-152）。

**RS 现状**：`crates/conex-types/src/error.rs`

- 同构实现：`codes` 模块 77 常量（error.rs:54-156）、`CRISH_ERROR_REGISTRY` 静态注册表（error.rs:159+，码 → category/retryable/is_public/action）、`CrishError` struct + cause 链深度 8（error.rs:21-22）。
- 错误码在 loop（`LoopError::with_code`，loop/mod.rs:59-70）、orchestrator、db、provider 各层一致传播；恢复钩子按码分类裁决（F6/T06.5.3），不做文本匹配。

**对比结论**：

| 维度 | TS | RS | 更优方 |
|---|---|---|---|
| 码体系 | 77 码同构投影 | 77 码注册表，生产来源 | 平手（双端一致） |
| 传播 | 收错误 → 归一 → 路由展示 | 结构化携带码/category/retryable 跨层传播 | RS |
| 历史迁移 | migrateErrorCode 映射层（TS 独有，合理） | 无对应物 | TS（历史包袱，不该回 Rust） |

**结论**：错误体系是「Rust 为源、TS 投影 + 历史迁移」的理想形态。新增错误码改 Rust 注册表即可；建议用测试或生成方式锁定双端码表一致（现状靠人工同构，是全仓最值得加防漂移机制的位置）。

---

## 2. 边界划分评估

| 层 | 现属 | 评估 | 说明 |
|---|---|---|---|
| UI（React 组件） | TS（components 44,628 行） | ✅ 必须留 TS | React 生态、热更、开发者产出效率 |
| 前端状态（store/streamingStore） | TS（12,350 行） | ✅ 留 TS 合理 | 渲染缓冲/投影是 React 渲染域；成本在于与 Rust 契约一致性——已由 generated/engine + sessionHydration 守卫部分覆盖，但会话形状仍手写 |
| 事件契约层 | TS generated + RS enum | ✅ 已是最优形态 | Rust 单真源 → 注册表 → 生成 TS（scripts/generate-engine-bindings.mjs），tests/registry_drift.rs 锁一致 |
| IPC 命令契约层（transport/commandMap/commandManifest，717 行） | TS 手写 + Rust invoke_handler 手写 | ⚠️ 建议迁向生成 | 命令清单双份维护，靠 `checkCommandMapConsistency` 运行时校验兜底——应与事件契约同模式：Rust 侧注册表生成 TS 类型 |
| 会话形状投影（sessionRustDb 的 RustSessionMessage 等） | TS 手写 | ⚠️ 建议生成或双向锁定 | 字段命名差异（toolCalls↔toolCallsJson 等）靠注释人工对齐（sessionRustDb.ts:11-17），是漂移高危点 |
| 会话写模型（批次戳 CAS） | TS 测试先行、实现悬空 | ⚠️ 应落 Rust | 一致性逻辑属 Rust 域（conex-db 事务内 CAS），TS 只留薄客户端 |
| Rust 中是否有可回 TS 的实现 | — | ✅ 验证通过，几乎无 | agent-workbench/src-tauri 只有命令注册/事件桥（commands.rs、core_event_bridge.rs、status_diagnostics.rs），无 UI 逻辑；全部 crates 均为内核逻辑 |

**边界总体评估**：`UI/展示 → TS，内核/一致性/域裁决 → Rust` 的主分界正确。当前真正需要治理的不是「把更多 TS 搬去 Rust」，而是 **把手写契约改成生成契约**——这比迁移语言更便宜、收益更高。

---

## 3. 「TS 占 73%」的解读

### 3.1 实测口径（本评审，行数）

| 口径 | TS | RS | TS 占比 |
|---|---|---|---|
| 全量（含测试） | 205,381 | 70,384 | 74.5%（≈用户口径 73%） |
| 其中测试 | 94,098（占 TS 46%） | 内联 mod tests（估算约 1.3 万） | — |
| 非测试 | 111,283 | 42,510（crates 非测试） | 72.4% |

TS 非测试 111,283 行的构成（apps/crish-desktop/src）：

| 目录 | 行数 | 归类 |
|---|---|---|
| components | 44,628 | 纯 UI（40%） |
| api | 40,302 | 混合：展示管线（markdown-render 1,434、tool-presentation 1,111、StreamRenderBuffer、streamTextBatcher、streamingCodeHighlighter）+ 契约（transport 717、session-persistence 1,920、generated 投影）+ 编排（chat-bridge 1,965、import 2,161、provider-profiles 1,451 等） |
| store | 12,350 | 前端状态/投影（11%） |
| hooks | 7,025 | React 绑定层（6%） |
| 其余（services/utils/workers/app/constants） | 约 5,700 | 工具与引导 |

### 3.2 结论

**TS 高占比 ≈ UI（4.5 万）+ 测试（9.4 万）+ 前端状态/绑定（1.9 万），三者合计约 15.8 万，占 TS 总量 77%**。核心逻辑（agent 内核、状态机、存储、事件、错误体系）全部在 Rust（crates 非测试 4.3 万行）。

### 3.3 核心逻辑占比的估算方法（可复算）

1. 排除 `*.test.*` / `*.spec.*` / `__tests__`。
2. 按目录打标四类：
   - **展示层**：components、api/markdown-render、api/tool-presentation、StreamRenderBuffer、streamTextBatcher、streamingCodeHighlighter、流式 UI 辅助；
   - **状态/投影层**：store、hooks、api/session-persistence 的投影部分；
   - **契约层**：transport、generated（生成器产出不计入「手写逻辑」）；
   - **逻辑层**：chat-bridge 编排、stream 生命周期（sessionStreamManager/streamStop）、水合（sessionHydration/eventHydrate）、错误系统、utils。
3. 粗估结果：TS 逻辑层约 2.5–3.5 万行，RS 核心逻辑（crates 非测试）42,510 行 → **核心逻辑层面 RS 占比约 55%–65%**，与「TS 占 73%」的表象相反。若把测试也计入各自语言核心逻辑，RS 测试密度（108 个测试文件、约 1175 用例）显著高于 TS 同规模逻辑的测试比例。

---

## 4. 结论与建议

### 4.1 分维度结论表

| 维度 | 更优方 | 理由（证据） | 迁移建议 |
|---|---|---|---|
| 事件分发 | 平手（RS 为源） | TS 穷举性靠生成类型实现；TS legacy 表 4 事件在契约外（dispatch.ts:83-88） | 把 subagent-*/error 并入注册表或显式废弃；保持生成管道 |
| 状态机 | RS | 8×20 穷举 + 160 对测试 + 未定义显式失败（transition.rs:89-201、429-445） | 前端不再实现域状态机（现状已无，保持） |
| 数据层 | RS | 事务 + UNIQUE(session_id,sequence) + 原子取号（migrate.rs:60-141、events.rs:72-98） | 写模型批次戳 CAS 落 conex-db；TS 只留薄 invoke 客户端 |
| 错误处理 | 平手（RS 为源） | 77 码双端同构；TS 是投影 + 历史迁移层（normalize.ts:14-133） | 新增码改 Rust 注册表；用生成或测试锁双端码表一致 |
| IPC 契约层 | 待生成 | TS commandManifest/commandMap 手写 + 运行时一致性检查（tauriTransport.ts:1-18） | 与事件同模式：Rust 注册表生成 TS 命令类型 |
| 会话形状投影 | 待生成 | RustSessionMessage 手写对齐命名差异（sessionRustDb.ts:11-17、69-122） | 从 serde 结构生成 TS 投影类型，消除人工对齐 |
| UI/展示/渲染 | TS | React 生态与迭代效率 | 不回迁 |

### 4.2 新功能默认归属的决策原则

1. **逻辑层 → Rust**：状态机、转移裁决、存储一致性、事件生产、agent 内核、错误码产生、并发控制（批次戳/CAS 之类）一律进 crates。
2. **展示层 → TS**：React 组件、markdown 渲染、流式缓冲（streamingStore）、diff 展示、格式化。
3. **契约边界 → generated**：新增事件/命令/形状，改 Rust 侧定义（enum/struct/注册表），由生成脚本产出 TS 类型，不手写双份；generated 产物只读不手工改。
4. **前端「会话投影状态」→ TS 但只做投影**：store/hooks 允许持有渲染所需镜像（如 streamingStore），但域裁决（该不该转移、终态语义）不得在 TS 实现。
5. **一致性相关的新需求 → 先问 Rust 侧能否承载**：凡是「乱序/并发/原子」语义，默认放 conex-db 或 session-loop；TS 侧若出现类似实现，视为过渡态并登记迁回。
6. **历史残留 → 显式登记**：legacy 表、localStorage 回退、手写投影属于过渡债务，保留但标注过期路径，新代码不再扩充。

### 4.3 一句话回答「TS 和 RS 哪个效果好」

**不是二选一，而是按职责分**：核心逻辑（约 5–6 成行数）在 Rust 已获得穷举状态机、事务一致性与结构化错误；TS 的 7 成行数主要是 UI 与测试，这是 Tauri 桌面应用的正常形态。真正要做的不是「把 TS 搬进 Rust」，而是把目前仍手写的契约（IPC 命令、会话形状）升级为生成式——这是下一步性价比最高的改动。
