# A3：缓存优化方案系列可执行性审计报告

- 审计日期：2026-08-03
- 审计性质：可执行性审计（只读代码核实 + 直接修改方案文档，未修改任何源代码）
- 审计对象（全部实读）：
  - `docs/cache-optimization/03-plans/P1-prefix-stability.md`（584 行）
  - `docs/cache-optimization/03-plans/P2-wire-cache-params.md`（727 行）
  - `docs/cache-optimization/03-plans/P3-vendor-model-layer.md`（512 行）
  - `docs/cache-optimization/03-plans/P4-history-context-management.md`（664 行）
  - `docs/cache-optimization/03-plans/P5-cache-telemetry.md`（682 行）
  - `docs/cache-optimization/03-plans/P6-ts-shell-sync.md`（424 行）
- 验证手段：`cargo metadata --no-deps`（包名）、`cargo tree -i serde_json -e features`（preserve_order 双态）、`cargo test --workspace -- --list`（基线可执行）、逐文件 grep/read 核对 40+ 处代码行号与机制、vitest/playwright 配置实读。

---

## 一、结论摘要

| 级别 | 数量 | 主题 |
|---|---|---|
| **P0（阻断）** | 2 | ① P1×P3 reasoning_content 语义冲突；② P2×P3 能力判定入口/合并链互斥 |
| **P1（需改）** | 5 | ① P5 事件 schema 未登记 changelog；② P5 usage_json 落库无写入面；③ P3 新命令未登记 command_manifest；④⑤ 上述两项 P0 的修正动作 |
| **P2（建议）** | 10 | 行号/职责错配、串行标注缺失、spec 数量错误等 |
| **命令错误** | **0 处** | 全部验收命令真实存在、包名正确、路径可执行 |

**好消息（先讲）**：六份方案的验收命令**全部真实可执行**——`cargo test -p session-loop` 的包名就是 `session-loop`（crates/ 目录下无 conex- 前缀，任务猜测的 `conex-session-loop` 不存在）；`-p agent-provider` / `-p agent-tools` / `-p conex-compaction` / `-p conex-db` / `-p conex-telemetry` / `-p conex-types` / `-p orchestrator` 均与各 Cargo.toml 的 `name` 一致。`npx vitest run src`、`npx vitest run src/api/chat-bridge`、`npx vitest run packages/shared-utils/src/cache` 在 vitest workspace 模式下按路径子串过滤，均可命中既有 include 面。`npx playwright test tests/e2e/...` 与 `playwright.config.ts`（testDir=./tests/e2e）兼容。`npm run typecheck` / `npm run bench` 均存在。

---

## 二、命令可执行性验证明细（审计点 1）

### 2.1 crate 包名对照（cargo metadata 实测）

| 方案引用 | 实际包名 | 结论 |
|---|---|---|
| `cargo test -p session-loop` | `session-loop`（crates/session-loop/Cargo.toml `name = "session-loop"`） | ✅ |
| `cargo test -p agent-provider` | `agent-provider` | ✅ |
| `cargo test -p agent-tools` | `agent-tools` | ✅ |
| `cargo test -p conex-compaction` | `conex-compaction` | ✅ |
| `cargo test -p conex-db` | `conex-db` | ✅ |
| `cargo test -p conex-telemetry` | `conex-telemetry` | ✅ |
| `cargo test -p conex-types` | `conex-types` | ✅ |
| `cargo test -p orchestrator` | `orchestrator` | ✅ |
| `cargo test --workspace` | workspace 16 包（含 app crate `crish-agent-workbench`） | ✅ 可执行；"73 套件"与 AGENTS.md 口径一致（`-- --list` 实测输出 1392 条 `: test` 条目、59 个 Running 行，基线以 AGENTS.md 登记为准） |

### 2.2 前端命令（package.json / vitest.workspace.ts / playwright.config.ts 实读）

| 命令 | 机制 | 结论 |
|---|---|---|
| `npm run typecheck` | 根 scripts 存在（tsc --noEmit × 6 个 tsconfig） | ✅ |
| `npx vitest run src` | workspace 模式（vitest.workspace.ts unit include `packages/*/src`、`apps/crish-desktop/src`）；CLI 位置参数按路径子串过滤 | ✅（AGENTS.md 基线同款） |
| `npx vitest run src/api/chat-bridge`（P4） | 同上，子串命中 `apps/crish-desktop/src/api/chat-bridge` | ✅ |
| `npx vitest run packages/shared-utils/src/cache`（P6） | 同上 | ✅ |
| `npx vitest run apps/crish-desktop/src/__tests__/stressFuzzing.test.ts`（P6） | 完整路径子串 | ✅ |
| `npx vitest run --coverage apps/crish-desktop/src/api/chat-bridge`（P6） | 覆盖率门槛 70/60/65/70 在 workspace unit 配置中 | ✅ |
| `npx playwright test tests/e2e/cache-metrics.spec.ts` / `tests/e2e`（P5/P6） | playwright.config.ts `testDir: './tests/e2e'`，CLI 参数兼容相对路径 | ✅ |
| `npm run bench`（P6） | 根 scripts 存在（bench-definitions.ts 既有 10+ 项，P6 增 2 项模式一致） | ✅ |

### 2.3 P1 preserve_order 双态论断验证（影响 P1 全部字节断言设计）

- `cargo tree -i serde_json -e features` 实测：`serde_json preserve_order` 经 `tauri-utils(schemars) → schemars feature preserve_order → serde_json` 开启（app build 为 IndexMap 保插入序）✅
- `crates/session-loop/Cargo.toml` 与 `crates/agent-provider/Cargo.toml` 均**无 schemars/tauri 依赖** → crate 级测试构建 serde_json 为 BTreeMap（按键排序）✅
- 结论：P1 §2.4 的"preserve_order 双态"论断成立，其"测试断言走 canonical_json_string 或同进程两次构建对比"的测试设计（E1）**是正确且必要的**。

---

## 三、问题清单（位置 / 级别 / 描述 / 建议 / 状态）

### P0（阻断，2 项）

| # | 位置 | 描述 | 建议 | 状态 |
|---|---|---|---|---|
| P0-1 | P3 §3.4.1（规则 1/2）与 P1 §3.4 C3、§4 步骤 2.3/3.1 | **reasoning_content 语义互斥**：P1 C3 裁决"DeepSeek 工具轮次恒 Require（空串兜底）"，P3 §3.4.1 规则 2 裁决"thinking disabled 时按历史字节 Include（不发新键）"。两者落在同一代码点（`messages.rs::reasoning_content_object` + `engine.rs`/`build.rs` 接线），且 P1 明确论证恒 Require 是"消除 thinking 开→关会话前缀形态漂移"的必要条件——P3 的 effort-off → Include 会让"开关"漂移，与 P1 目标直接冲突。两文档均未互引、未标注从属。 | 统一以 P1 C3 为准（恒 Require，空串兜底）：P3 的 `deepseek_reasoning_content_mode` 不再作为第二套判定函数；P3 只提供 catalog 数据（`supports_reasoning` / effort 档位）作为 P1 判定函数的输入。P3 侧接线步骤删除"P2 或 D 实施步骤在 build.rs 接线"的歧义表述。 | **已修正 P1/P3** |
| P0-2 | P2 §3.1.2/§3.2、§6.3 与 P3 §3.2.3、§6.1 | **能力判定入口双真源、合并链缺失**：P2 交付 `infer_cache_capability` + `CACHE_CAPABILITY_TABLE`（request/cache.rs 内置默认表）+ `build_cache_policy(capability, session_id, overrides)`（overrides 读 `extra.cache` JSON），并称"CacheCapability 与 build_cache_policy 是 P3 的唯二替换点"；P3 交付 `cache_behavior_for(catalog, vendor, model)`（models/behavior.rs 静态矩阵 + catalog 模型级覆盖），并称"矩阵表是本方案对 P2 的唯一接口面"。两份文档都没有定义：运行时 `engine.rs::request_options` 到底调谁？P3 的 `CacheBehavior` 如何进入 P2 的 `build_cache_policy`？P2 的 overrides JSON 键名（`{"enabled","retention","breakpoints","cacheKey"}`）与 P3 的 CacheBehavior 结构字段完全不对应。实施者按任一文档编码都会与另一方案冲突。 | 裁决：**P3 的 `cache_behavior_for`（含 catalog 模型级覆盖）是唯一运行时判定入口**，P2 的 `infer_cache_capability` 降级为"无 catalog 时的内置保守默认"，P2 `build_cache_policy` 的签名改为消费 `CacheBehavior`（或 P3 的 `CacheBehavior` 序列化为 extra.cache 覆盖 JSON 供 P2 overrides 消费，二选一，在 P2 实施任务书定稿前冻结）。P2 的 `CACHE_CAPABILITY_TABLE` 数据值以 P3 矩阵为准转录。 | **已修正 P2/P3** |

### P1（需改，5 项）

| # | 位置 | 描述 | 建议 | 状态 |
|---|---|---|---|---|
| P1-1 | P5 §3.1.3、S3 | **事件 schema 变更未登记 changelog**：P5 向 `conex-types::events::AgentEvent` 新增 CacheDomainEvent 三变体，但项目硬约束（`docs/rust-rewrite/33-event-schema-changelog.md` §二：新增事件类型必须同步 changelog 登记行 + `V1_EVENT_TYPES` 清单（`crates/conex-types/tests/events_schema_version.rs`）+ v1 同形 fixture，四者一一对应，且有 `v1_baseline_has_exactly_24_event_types` 一致性断言锁定）。跳过登记 → 既有测试直接失败、评审门禁不过。 | S3 增加"登记 33-event-schema-changelog.md 变更行 + 更新 events_schema_version.rs 清单与 fixture"子步骤；事件字段遵循 changelog 既有纪律（可选字段 `#[serde(default, skip_serializing_if = "Option::is_none")]`）。 | **已修正 P5** |
| P1-2 | P5 §3.1.4、S4、§6.3 文件域总表 | **session_messages.usage_json 无写入面**：v5 迁移给 `session_messages` 加 `usage_json` 列（设计目的"消息级 usage 快照、徽标回放"），但 P5 全部实施步骤与文件域总表均无 `apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`——该文件的 `RustSessionMessage`（:69-81，无 metadata/usage）、`toRustSessionMessage`（:162）、`fromRustSessionMessage`（:245）、`saveSessionBody`（:511-532，先删后插全量写）才是 usage_json 的唯一写入点。列加了没人写 = 数据流断在持久化面。 | S4 增补子步骤：`RustSessionMessage` 增可选 `usage` 字段（camelCase 镜像 `metadata.usage`）+ `toRustSessionMessage`/`fromRustSessionMessage` 透传；文件域总表补该文件。 | **已修正 P5** |
| P1-3 | P3 §④ 步骤 5 | **新 IPC 命令未登记**：`catalog_get` / `catalog_refresh` 为新增 Tauri 命令，但 P3 未提及：① `command_manifest.rs` 登记（既有模式 `entry("core_compact_messages", "core", "engine", true)`，:104）；② `main.rs` invoke_handler 注册（:108-117 模式）；③ `tests/e2e/mock-engine.ts` 的 `BUILTIN_COMMAND_MANIFEST` 快照同步（mock-engine.ts:30、98——P6 §6.2 自己都提醒了同类问题："若 P3 采纳 promptCacheKey 参数，需同步 BUILTIN_COMMAND_MANIFEST"）。不登记 → mock 引擎对未知命令抛 missing、命令面审计门禁不过。 | 步骤 5 补三处登记子步骤。 | **已修正 P3** |
| P1-4 | P0-1 的修正动作 | 见 P0-1 建议 | 已落实 | **已修正 P1/P3** |
| P1-5 | P0-2 的修正动作 | 见 P0-2 建议 | 已落实 | **已修正 P2/P3** |

### P2（建议，10 项）

| # | 位置 | 描述 | 建议 | 状态 |
|---|---|---|---|---|
| P2-1 | P4 §2.2 表"usage 已解析但无消费" | `ProviderUsage 六字段` 引用写为 `crates/conex-types/src/events.rs:31-52`，实际在 `crates/agent-provider/src/events.rs:33-52`（conex-types/src/events.rs:31-52 是 AgentEvent 早期变体，无 usage）。session-loop 侧另有自己的镜像类型（stream.rs:41）。 | 改为 `agent-provider/src/events.rs:33-52`（P2 补齐面）＋注明 session-loop stream.rs 镜像。 | **已修正 P4** |
| P2-2 | P2 §4 步骤 4 文件域 | `session-loop/src/provider.rs` 与 P1 步骤 2.2 同文件（P1 加 `system_prompt`、P2 加 `session_id`），P2 只标注了 engine.rs 与 P1 串行，未标注 provider.rs。 | 文件域补"provider.rs 与 P1 串行（P1 先行）"。 | **已修正 P2** |
| P2-3 | P6 §5 验收命令注释 | "全量：确认既有 5 spec 未回归"——`tests/e2e/` 现有 Playwright spec 实为 **7 个**（error-path / full-journey / probe2 / session-restore / settings-persist / streaming-render / ui-store-invariants；tauri-native-smoke.spec.ts 被 playwright testIgnore 排除归 vitest）。 | 改为"既有 7 spec"。 | **已修正 P6** |
| P2-4 | P5 §3.1.2 | `LoopState` 引用写为 `crates/session-loop/src/loop/mod.rs:194 附近`——**复核确认：A1 审计已修正**（P5 文档 :325 现有标注"原稿 loop/mod.rs:194 附近位置错误——LoopState 定义于 loop/handlers/mod.rs:55-85"，与本次实读（handlers/mod.rs:68 conversation 字段、:89-112 构造器）一致 | 无需动作 | 复核确认（A1 已修） |
| P2-5 | P6 §1.2 范围表、§6.1 依赖表 | 两处把"会话级缓存统计事件"归给 P2——**复核确认：A1 审计已修正**（P6 §1.2/:9 行、§6.1 :404-406 已有 A1 标注改归 P5）；本次另发现 §3.6.2 :337"若 P2 需要新增引擎事件"遗留引用，已顺手修正 | 仅剩 :337 一处，已修 | **已修正 P6（:337）** |
| P2-6 | P6 §5 第 2 条 | `npx vitest run packages/shared-utils/src/cache` 在文件创建前执行会"no test files found"——应排在 S1/S4（先实现后验收）之后，建议验收清单注明"顺序 = S4 后"。 | 备注顺序依赖。 | 报告登记 |
| P2-7 | P1 步骤 2.4 / P4 §3.7 | `core_run_task` 参数扩展（P1 加 `system_prompt`、P4 加 `history`/`context_window`）属命令契约变更，`docs/rust-rewrite/33-event-schema-changelog.md` 明令"命令变更走 T03.9 changelog"（`docs/rust-rewrite/contracts/` 同册）。当前 contracts/ 目录仅有 contract-test-coverage-matrix.md，命令契约文档状态未确认；P1/P4 均未提登记。 | 实施时确认命令契约文档落点并登记参数变更；若契约文档未落盘，在实施任务书中补记。 | 报告登记 |
| P2-8 | P4 §6.2 串行冲突表 | 未列出 `core_run_commands.rs`（core_run_task 签名）与 P1 步骤 2.4 的串行（P1 加 system_prompt 参数、P4 加 history 参数，同函数签名）。 | 串行表补一行。 | **已修正 P4** |
| P2-9 | P6 §3.5.1/S5 | mock 引擎 fixture 的 `message-end.message.metadata.usage` 形状（`{promptTokens,...}`）需与 Rust 侧 `build_message_metadata`（agent-provider consume/mod.rs:269-308 序列化 metadata.usage）的 camelCase 一致——P6 形状（promptTokens/completionTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens）与既有 ProviderUsage 六字段一致，✅ 可执行。另注意 `metadata.usage` 的 camelCase 键序在 mock fixture 里手动构造即可，无冲突。 | 无动作（验证通过）。 | 报告登记 |
| P2-10 | P3 §3.1.2 `ModelCatalogEntry` 含 `serde(rename_all="camelCase")` + 大量 Option | 与 `#[serde(default)]` 并用时，`mode`/`currency`/`unit`/`cache_type`/`cache_mechanism`/`source_url`/`data_verified_at` 等**必填非 Option 字段**会让老数据/缺字段 JSON 反序列化失败，与"旧数据兼容"目标冲突。 | 全部改为 `Option<...>` 或提供 Default；内置 catalog.json 由 serde 全量解析测试钉死（步骤 1 已有，建议加"缺字段条目可解析"用例）。 | 报告登记 |

---

## 四、测试设计可执行性验证（审计点 3）

| 方案设计的测试 | 与现有基建对照 | 结论 |
|---|---|---|
| P1：TestProvider.requests() 请求快照 | `crates/session-loop/src/testing/mod.rs:31` TestProvider、:45 requests 存储、:111 `requests()`、:244-262 `RequestSnapshot{messages/tools/max_tokens}` ——全部实测存在 | ✅ 可复用 |
| P1：`list_preserves_registration_order`（registry.rs:126-133）、`list_definitions_in_order_with_schema`（:157-171）不受排序影响 | 实测存在，`list_definitions`（:63-68）排序只影响输出面、`list()`（:55）不动 → 论断成立 | ✅ |
| P1：既有 arguments 断言 `{"path":"/a"}`（messages.rs:630 附近）在 canonical 化后不破 | 单键对象 + 无 preserve_order 测试构建（BTreeMap 本就排序）→ 不破 | ✅ |
| P2：DeepSeek 省略测试、`CacheKey::from_session_id` 码点钳制、`merge_usage_shards` max 语义 | 纯函数单测，无外部依赖 | ✅ |
| P3：`deepseek-v4-flash-0731` 去版本兜底、TTL 表逐 vendor 断言、`git grep cache_control` 越界审计 | 纯函数单测 + grep 门禁，可执行 | ✅（测试本身无冲突；但见 P0-1 语义冲突） |
| P4：水合规则/钳制/预检触发/压缩阶梯/I1-I6 不变量 | session-loop 集成测试基建（TestProvider + with_initial_conversation_arc 既有）| ✅ |
| P4：`ContextCompressionStart/End` 事件广播 | 类型已存在（conex-types/src/events.rs:236/244）；前端 eventParser 已有归一器（eventParser.ts:328-341）+ dispatch.ts:68-69 已分发（compressionHandlers 空实现）——链路骨架现成 | ✅ |
| P5：`migrate_v4_to_v5` 测试放 `conex-db/src/tests.rs` | tests.rs 存在；`fresh_db_full_chain` 锚定在 migrate.rs:84 注释；迁移链 v1→v4 模式（migrate.rs:161/186/220）与 v5 同构 | ✅ |
| P5：`cargo test -p conex-telemetry` 叶子约束 | conex-telemetry Cargo.toml 实测仅依赖 tracing/tracing-subscriber/serde/serde_json/**conex-types** | ✅ |
| P5：CacheStatsTracker 放 session-loop | session-loop 当前**不依赖** conex-telemetry（Cargo.toml 实测），P5 已标注"新增依赖，实施时裁决，倾向后者" | ✅（裁决项已在文档中） |
| P6：rust-parity.test.ts（规则样例表，TS 先钉死） | packages/shared-utils 在 vitest workspace unit include 面内；双侧样例表机制可执行 | ✅ |
| P6：mock-engine fixture（cacheUsageRunEvents / legacyNoUsageRunEvents） | mock-engine.ts 事件编排机制实测存在（runTask :241、installMockEngine :436、emitEngineEvent :449、engineState :462、fullJourneyRunEvents :476、lastRun.args :243）| ✅ |
| P6：Probe E 升级（stressFuzzing.test.ts:121-165 import 三函数） | 实测 :5 行直接 import canonicalizeJsonSchema/formatStableTools/buildStableCacheKey，:143-160 断言 | ✅ |
| P6：基准 2 项 | bench-definitions.ts 结构（name/iterations/warmupIterations/target）实测匹配 | ✅ |
| P6 覆盖率门槛"70/60/65/70" | vitest.workspace.ts unit 配置实测一致 | ✅ |

**边界情况覆盖核查（审计点 6）**：空会话（P4 水合规则空输入、P5 detect 无基线→Cold、P6 null 语义 ✅）；无 usage 上报（P2 miss 推导兜底、P5 reportedCache 粘性 + 噪声地板、P6 legacy fixture ✅）；流式中断（P4 aborted 回合 usage 仍计入 ✅）；模型切换（P5 归因 ModelSwitch + 基线重置 ✅）；超长单消息（P4 压缩后仍超 → fatal 带诊断 ✅）；未知名厂商网关（P2/P3 Auto 保守默认 + P3 显式 vendor 字段 ✅）。**未发现未覆盖项**。

## 五、迁移与兼容验证（审计点 4）

| 迁移面 | 策略 | 结论 |
|---|---|---|
| P5 conex-db v5 | ADD COLUMN + `NOT NULL DEFAULT 0`（旧行自动补 0）+ `usage_json TEXT`（NULL 兼容）+ col-check 幂等模式（对齐 v1→v2/v2→v3 既有实现，migrate.rs:161-291）+ `LATEST_VERSION=5`（lib.rs:44 实测当前 4）+ 前端 RustSessionMessage 全可选字段 | ✅ 策略完整（除 P1-2 的写入面缺失） |
| P6 类型契约升级 | 全可选字段 + null 兜底语义 + 生成产物走 `gen:engine-bindings`（禁止手改 generated）+ eventParser 宽容归一器兜底 | ✅ 三步走完整 |
| P4 `core_run_task` 新参数 | 全部 Option 缺省 = 现状行为（单消息 run）| ✅ |
| P2 `ProviderRequest.session_id` | 契约扩展（None 缺省兼容），标注走 PE-02/PE-09 登记 | ✅ |
| P6 `buildStableCacheKey` 语义替换 | 导出名保留、旧内容哈希废弃、无持久化依赖 | ✅ |

## 六、对方案文档的修改记录（均加【A3 审计修正】标注）

| 文档 | 修改点 |
|---|---|
| P1-prefix-stability.md | §3.4 C3 后补充与 P3 的从属声明（本方案为唯一实现，P3 数据输入） |
| P2-wire-cache-params.md | §4 步骤 4 文件域补 provider.rs 与 P1 串行标注；§3.1.2 补与 P3 的合并链裁决（cache_behavior_for 为唯一运行时入口） |
| P3-vendor-model-layer.md | §3.4.1 语义统一（以 P1 C3 恒 Require 为准）；§3.2.3/§6.1 判定入口合并链；步骤 4 接线归属；步骤 5 补 command_manifest/main.rs/mock-engine 登记 |
| P4-history-context-management.md | §2.2 ProviderUsage 位置修正；§6.2 串行表补 core_run_commands.rs |
| P5-cache-telemetry.md | S3 补事件 changelog 登记；S4 补 sessionRustDb.ts 写入面；§3.1.2 LoopState 行号修正；§6.3 文件域补 sessionRustDb.ts |
| P6-ts-shell-sync.md | §1.2/§6.1 会话级事件归属改 P5；"5 spec"改"7 spec" |

## 七、遗留事项（未修改文档，建议实施任务书消化）

1. P2-6：P6 验收命令与实施步骤的顺序依赖（先实现后验收）。
2. P2-7：core_run_task 参数变更的命令契约 changelog 登记（contracts/ 目录现状）。
3. P2-10：P3 ModelCatalogEntry 必填字段与 serde(default) 兼容性（建议全 Option）。
4. `cargo test --workspace` 实测 --list 输出 1392 条 `: test` 条目，"73 套件"口径与 AGENTS.md 一致，未发现文档引用错误。
