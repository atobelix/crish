# 33 — 事件 schema 版本化 changelog（PE-03 T03.10，归一 PE-12 T12.5/T12.6）

> 性质：事件域版本化文档（事件 schema 的演进真源，与命令契约同册）。
> 日期：2026-08-01。
> 关联：PE-03 T03.10（AU-04 F11）为主、PE-12 T12.5/T12.6 并入归一（原 T12.5/T12.6 作废）；
> 与 T03.9 契约文档 `docs/rust-rewrite/contracts/engine-ipc-contract.md`（E7 产出）同册——
> 本 changelog 是该契约文档的「事件载荷版本化」分册，契约文档「事件关联」节引用本文件；
> 边界：**命令变更走 T03.9 changelog，事件变更走本 changelog**（PE-12 T12.5 步骤 4）。
> 代码真源：`crates/conex-types/src/events.rs`（AgentEvent 28 变体 + AgentEventEnvelope；
> 2026-08-03 P5 缓存测量域兼容新增 3 变体，24 → 27；I2-S8 安全审计域兼容新增 1 变体，27 → 28）。

## 一、版本模型

| 面                               | 机制                                  | 说明                                                                                                                             |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 事件体（AgentEvent）             | 无版本字段                            | 域类型纯净，28 变体字段不带版本；演进靠 changelog + 兼容测试锚定（D3）                                                           |
| 信封（wire，AgentEventEnvelope） | 顶层 `schemaVersion`（u32，当前恒 1） | 序列化层注入（`EVENT_ENVELOPE_SCHEMA_VERSION`）；**旧帧无该字段缺省视为 1**，解析不报错（向后兼容）                              |
| 持久化 payload                   | **不引入版本列**（D3）                | 事件存储不写 schema 版本列；兼容由 serde 规则 + 本 changelog 测试锚定；未来按版本迁移 payload 的需求登记 v5 候选（PE-12 §六 L1） |

解析保证（serde 既有事实，文档固化）：

1. **未知字段忽略**：`AgentEvent` 反序列化对未知键默认忽略——新字段对旧代码天然向后兼容；
2. **缺省补位**：新增可选字段必须 `#[serde(default, skip_serializing_if = "Option::is_none")]`
   （缺失时补默认值，序列化时省略）；
3. **信封缺省**：`schemaVersion` 缺失 → 视为 1；旧帧重序列化自动补 `schemaVersion: 1`（升级读）。

版本号 semver：`schemaVersion` 为信封主版本（major 演进时递增，缺省 1 表示 v1）；
事件体字段变更按下方 minor/major 规则登记，不单独推进信封版本。

## 二、变更流程规则（硬约束）

| 变更类型              | 规则                                    | 要求                                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **兼容变更（minor）** | 新增事件类型；新增**可选**字段          | 新增可选字段必须 `#[serde(default, skip_serializing_if = "Option::is_none")]`（wire 缺省不输出）；新增事件类型必须同步：changelog 登记行 + `V1_EVENT_TYPES` 清单（`crates/conex-types/tests/events_schema_version.rs`）+ v1 同形 fixture；前端按字段白名单消费，未知键静默忽略 |
| **破坏变更（major）** | 字段删除 / 改名 / 类型变化 / 必填性提升 | 必须登记变更行（版本 \| 事件 \| 字段 \| 变更类型 \| 兼容策略 \| 前端消费方）；**双端同步发布**（Rust 产出与前端消费同轮次，PE-12 §六 L5）；配兼容测试（旧形态 fixture 可解析 + 降级读取断言）                                                                                  |

变更门禁（DoD 勾稽项，登记 30-verification-checklist 候选）：

1. 新增事件类型 ↔ changelog 登记 ↔ `V1_EVENT_TYPES` 清单 ↔ fixture 四者一一对应
   （`v1_baseline_has_exactly_28_event_types` 等一致性断言锁定，T12.6）；
2. 任何字段变更必须同步更新本 changelog 与 fixtures 目录，评审勾稽；
3. 信封序列化恒注入 `schemaVersion: 1`（`new_envelope_serializes_schema_version_one`）。

## 三、v1 基线（2026-08-01 冻结 24 事件；2026-08-03 兼容新增 cache-* 三事件 → 27；I2-S8 新增 security-audit → 当前 28 事件 + 信封）

> 事件体字段全部 camelCase；顶层 `type` 为 kebab-case tag；`runId`/`sequence`/`schemaVersion`
> 为信封注入字段（不在事件体内）。消费方引用见 30-verification-checklist.md §4 核对矩阵。

信封（wire 形状）：

```
{ type, runId?, sequence?, schemaVersion: 1, sessionId, ...事件字段 }
```

| #   | 事件类型（type）              | 必填字段                                                              | 可选字段      | 消费备注                                                              |
| --- | ----------------------------- | --------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| 1   | agent-start                   | sessionId, timestamp                                                  | —             | 前端静默忽略                                                          |
| 2   | agent-end                     | sessionId, timestamp, reason                                          | error         | 前端硬依赖（03 §5.1-12；reason 含 stopped 扩展，01 D1）               |
| 3   | turn-start                    | sessionId, turnIndex, timestamp                                       | —             | 前端未消费                                                            |
| 4   | turn-end                      | sessionId, turnIndex, timestamp, toolCallCount                        | —             | 前端未消费（观测用）                                                  |
| 5   | message-start                 | sessionId, message                                                    | —             | 水合以 message-end 为准                                               |
| 6   | message-delta                 | sessionId, timestamp, messageId, block                                | —             | 前端硬依赖（03 §5.1-4/5：block.text + messageId）                     |
| 7   | message-end                   | sessionId, message                                                    | —             | 前端硬依赖（03 §5.1-6：role/content/blocks + clientMessageId）        |
| 8   | tool-start                    | sessionId, batchId, call, timestamp                                   | —             | 前端硬依赖（03 §5.1-7：call.id/toolName）                             |
| 9   | tool-update                   | sessionId, batchId, toolCallId, update, timestamp                     | —             | 预留（partialToolArgs）                                               |
| 10  | tool-end                      | sessionId, batchId, result, timestamp                                 | —             | 前端硬依赖（03 §5.1-8：result.id/output/isError）                     |
| 11  | tool-batch-start              | sessionId, batchId, timestamp, summary, calls                         | —             | 前端显式忽略                                                          |
| 12  | tool-batch-end                | sessionId, batchId, timestamp, calls                                  | —             | 前端显式忽略                                                          |
| 13  | tool-input-repaired           | sessionId, timestamp, toolCallId, toolName, notes                     | —             | 前端未消费                                                            |
| 14  | context-compression-start     | sessionId, timestamp, reason, tokensBefore                            | —             | 前端未消费                                                            |
| 15  | context-compression-end       | sessionId, timestamp, aborted                                         | result, error | 前端未消费                                                            |
| 16  | provider-diagnostic           | sessionId, timestamp, diagnostic                                      | —             | 前端 logInternalError                                                 |
| 17  | runtime-error                 | sessionId, timestamp, error                                           | retryable     | 前端硬依赖（surfaceStreamFailure；**首个 major 候选，见 §四**）       |
| 18  | runtime-steering              | sessionId, timestamp, reason, message                                 | —             | 前端未消费                                                            |
| 19  | runtime-intervention-required | sessionId, timestamp, reason, choices, message                        | —             | 前端未消费（01 D9）                                                   |
| 20  | approval-requested            | sessionId, request, timestamp                                         | —             | 前端硬依赖（03 §5.1-9：request.toolCallId/toolName/parameters）       |
| 21  | approval-resolved             | sessionId, toolCallId, decision, timestamp                            | requestId     | 前端硬依赖（03 §5.1-10：toolCallId 主键 + decision 规范值）           |
| 22  | checkpoint-created            | sessionId, timestamp, checkpoint                                      | —             | 前端未消费                                                            |
| 23  | checkpoint-restored           | sessionId, timestamp, restore                                         | —             | 前端未消费                                                            |
| 24  | run-terminal                  | sessionId, runId, timestamp, terminal                                 | error         | 前端硬依赖（03 §5.1-11/16：terminal + runId 必须存在）                |
| 25  | cache-stats-updated           | sessionId, timestamp, stats                                           | —             | 前端会话统计面板（P5 S3；仅测量展示，不干预循环；runId 由信封注入）   |
| 26  | cache-waste-alert             | sessionId, timestamp, attribution, missedTokens, idleMs, modelChanged | missedCostUsd | 前端预警提示条（阈值驱动；attribution kebab-case）                    |
| 27  | cold-cache-warning            | sessionId, timestamp, ttlSeconds, idleMs, resendEstimateTokens        | —             | 前端冷缓存提示（Rust 仅 run 启动发一次；空闲提示走 warmUntilMs tick） |
| 28  | security-audit                | sessionId, timestamp, operation, targets, impact, decision            | permissionMode, toolCallId | 安全审计面板 / S9 审批弹窗影响面数据源（I2-S8：删除接管/重定向/恢复/红线拦截；runId 由信封注入） |

## 四、变更登记表

| 版本                                     | 事件                                                         | 字段                                                                                                                                                | 变更类型                                           | 兼容策略                                                                                                                                                                                                                                                                                                                                                        | 前端消费方                                                                                                          | 依据                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1.1（候选）                              | runtime-error                                                | error: `String` → `CrishError`                                                                                                                      | **major**（字段类型变化）                          | 载荷 `code` 优先、回退 `message`（旧持久化事件无 code 时降级读取；IPC 载荷保持 message 字段名 + 新增 code）                                                                                                                                                                                                                                                     | EventRouter.ts onRuntimeError → surfaceStreamFailure（解析层兼容 code/message 双读）                                | PE-04 R4 / T04.3-3（错误类型升级归 PE-06 T06.5.x 落地，任务书另以 T04.5 引述）；PE-12 T12.5 步骤 5 |
| 1.1（minor 兼容新增，已落地 2026-08-03） | cache-stats-updated / cache-waste-alert / cold-cache-warning | 新增 3 个事件类型（缓存测量域，P5 S3）；新增可选字段：`missedCostUsd`（cache-waste-alert）、`RunCacheStats.hitRatio` / `writeRatio` / `warmUntilMs` | **minor**（兼容新增：新增事件类型 + 新增可选字段） | 信封 `schemaVersion` 不变（恒 1，无该字段旧帧照常解析）；新增可选字段一律 `#[serde(default, skip_serializing_if = "Option::is_none")]`（缺失补默认、序列化省略）；旧解析器对未知 `type` 静默忽略（前端宽容归一器兜底，T-38 落地）；`V1_EVENT_TYPES` 清单 24 → 27（`v1_baseline_has_exactly_27_event_types`，原 24 基线断言同步更新）；v1 同形 fixture 追加 3 条 | 前端 CacheDomainEvent 归一器（T-38）；会话缓存统计面板 / 预警提示条；仅测量展示，不干预循环（不破坏既有 24 帧解析） | P5 S3 §3.1.3；A3 P1-1；90-final T-37/T-38                                                          |
| 1.2（minor 兼容新增，已落地 2026-08-03） | security-audit | 新增 1 个事件类型（安全审计域，I2-S8）；新增载荷类型 `ImpactAssessment`（fileCount/totalSizeBytes/directoryCount/crossDirectory/flagged）；新增枚举 `SecurityAuditOperation`（delete/trash-restore/trash-purge/git-revert/command-exec）与 `SecurityAuditDecision`（blocked/approved/denied/redirected/restored/purged） | **minor**（兼容新增：新增事件类型） | 信封 `schemaVersion` 不变（恒 1）；可选字段 `permissionMode`/`toolCallId` 一律 `#[serde(default, skip_serializing_if = "Option::is_none")]`；`runId` 由 emit 层信封注入不占事件体（03 §5.3-2）；旧解析器对未知 `type` 静默忽略；`V1_EVENT_TYPES` 清单 27 → 28（`v1_baseline_has_exactly_28_event_types`）；v1 同形 fixture 追加 1 条；`ImpactAssessment` 定义自 conex-fs 上移至 conex-types（wire 契约归属），conex-fs 重导出保持既有 API | 前端 dispatch 表注册宽容空实现（对齐 cache 域 T-38 模式）；审计面板 / S9 审批弹窗影响面数据源（I3 接线） | I2-S8（01-安全监控与删除接管方案 §2 S8）                          |

> 首个 major 候选登记说明：PE-04 域（T04.3-3/R4，前端解析 T04.4-3）的
> `RuntimeError.error: String → CrishError` 是当前已知的第一个破坏性演进（若适用——即
> PE-06 错误类型升级落地后）；届时同步更新 v1 fixture `event-runtime-error.json` 并新增
> 旧形态（error:String）降级读取断言（`old_runtime_error_string_form_parses` 已锚定 v1 形态）。

## 五、兼容测试与双端 golden 锚点

| 锚点                                | 位置                                                                                                                                                            | 断言                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| v1 fixture 解析（28 事件全量）      | `crates/conex-types/tests/fixtures/events-v1/` + `tests/events_schema_version.rs`                                                                               | 无 schemaVersion 旧帧全部解析成功、缺省补 1、type_name 与文件一一对应（28 == changelog 登记数） |
| 旧 RuntimeError String 形态         | `event-runtime-error.json`                                                                                                                                      | error 为字符串可解析（major 演进锚点）                                                          |
| 完整信封帧                          | `frame-with-runid-sequence.json`                                                                                                                                | runId/sequence 保真 + schemaVersion 缺省 1                                                      |
| 信封序列化                          | `new_envelope_serializes_schema_version_one` / events_roundtrip.rs                                                                                              | 序列化恒含 `schemaVersion: 1`；runId/sequence 缺省时仍注入                                      |
| 双端 golden（Rust 产出 ↔ 前端消费） | `apps/agent-workbench/src-tauri/tests/event_bridge.rs`（16 项硬依赖 + schemaVersion 断言）、`apps/crish-desktop/src/api/daemon-chat-bridge/EventRouter.test.ts` | 每条载荷含 schemaVersion: 1；前端未知键 schemaVersion 静默忽略（白名单消费）                    |
| 变体数一致性                        | `v1_baseline_has_exactly_28_event_types`                                                                                                                        | 28 == changelog 表登记数（新增事件漏登记即红）                                                  |

## 六、执行注记

- 信封 `schemaVersion` 覆盖两条 emit 路径（`core_event_bridge.rs` emit_event 与
  enqueue_envelope）：注入点在 `AgentEventEnvelope` 序列化层，一处改动全覆盖；
- **不改变现有事件字段**（约束）；旧事件 wire 形状仅缺省无 `schemaVersion`，可被新代码无损解析；
- 协作：PE-08 提供历史库旧事件样本（反代 fixture）；PE-09 roundtrip 测试作 wire 不变守门；
- 持久化版本列（schema_version 列）明确不引入（PE-12 D3），未来诉求登记 v5 迁移候选。
