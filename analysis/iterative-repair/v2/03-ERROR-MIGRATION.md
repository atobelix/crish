# 错误码迁移映射表（权威文档）

> **本文件是 Crish 错误处理体系迁移的唯一权威文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Round 设计文档（`ROUND-01` ~ `ROUND-12`）引用错误码、迁移映射、`CrishResult` 工具函数、`CrishErrorPayload` 序列化格式时，**必须指向本文档**。
>
> **生成依据**：本文档基于对实际代码的逐文件扫描，扫描范围覆盖 `packages/` 全部 9 个 TS 包与 `crates/conex-types` Rust crate。所有"现有错误码"均来自代码实证，不含臆测。

---

## 0. 文档定位与扫描基线

### 0.1 与其他文档的关系

| 文档                                                         | 角色                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 25                 | 规定错误码迁移必须遵循"共存→迁移→删除"三阶段，禁止一次性全局替换 250 处 `throw new Error` |
| `v2/01-OVERVIEW.md` §2.1 S-03/S-08/S-10、§2.2 F-07/F-08/F-09 | 列出错误体系的结构性问题与本文件需解决的方案                                              |
| **本文档**                                                   | 错误码、迁移映射、`CrishResult`、`CrishErrorPayload` 的**唯一权威定义**                   |
| `v2/ROUND-01-type-foundation.md`                             | Round 1 实现细节，引用本文档的码表与接口签名                                              |

### 0.2 扫描基线（实证数据）

> **基线一致性说明**：本表为全文档唯一的 throw 计数权威来源。§4.1/4.2/4.3 的统计均以本表为准，禁止在其他章节出现矛盾的数字。

#### TS 端 throw 计数

| 指标                             | 实测值               | 备注                                                                                                                                                                                                                                             |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `throw new Error`（源码）        | 177 处 / 61 文件     | 已剔除 `*.test.ts`/`*.adversarial.test.ts`，迁移优先级表基于此值                                                                                                                                                                                 |
| `throw new Error`（测试）        | 73 处 / 35 文件      | 不计入迁移优先级，由各包测试迁移时顺带处理                                                                                                                                                                                                       |
| `throw new Error` 总计           | 250 处 / 96 文件     | 源码+测试合计                                                                                                                                                                                                                                    |
| `throw new CrishError` 总数      | 82 处 / 11 文件      | 含 checkpoint-manifest.ts、conversation-boundary-manifest.ts、artifact-store.ts、lsp-tools.ts、rich-read.ts、git-patch-ops.ts、git-service.ts、local-tools/shared.ts、background-command.ts、daemon-product-adapters.ts、scoped-context-store.ts |
| `throw new ProviderError` 总数   | 25 处 / 4 文件       | 全部在 provider-openai-* 系列文件，使用 `CONFIG_ERROR`/`NETWORK_ERROR`/`DAEMON_DEAD` 及动态 `kind`                                                                                                                                               |
| `throw new SessionError` 总数    | 31 处 / 5 文件       | 使用 `SessionErrorCode` 联合类型 5 个码值                                                                                                                                                                                                        |
| `throw new ProtocolError` 总数   | 3 处 / 3 文件        | `INVALID_RUN_STATE`、`NOT_A_GOAL_RUN`、`LEAF_MISMATCH`（前版基线漏算 LEAF_MISMATCH 1 处）                                                                                                                                                        |
| `throw new PermissionError` 总数 | 0 处                 | 类已定义但无 throw 调用点                                                                                                                                                                                                                        |
| **Crish\* 子类合计**             | **141 处 / 22 文件** | CrishError+ProviderError+SessionError+ProtocolError 四类合计                                                                                                                                                                                     |

#### Rust 端错误类型计数

| 指标                                         | 实测值      | 备注                                                                                     |
| -------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `CoreError` variant 数（conex-types）        | 6           | `InvalidInput`/`Encoding`/`Io`/`NotFound`/`Cancelled`/`Internal`                         |
| `IpcError` variant 数（conex-ipc）           | 4           | `EmptyLine`/`ParseError`/`Timeout`/`NotFound`                                            |
| `MarkdownError` variant 数（conex-markdown） | 2           | `InvalidInput`/`Internal`                                                                |
| `StreamError` variant 数（conex-stream）     | 1           | `NotOpen`                                                                                |
| `NetError` variant 数（conex-net）           | 2           | `ConnectionFailed`/`Timeout`                                                             |
| `conex-fs`                                   | 0（anyhow） | 无结构化错误类型，迁移阶段保持 anyhow，仅在 Tauri command 边界转换为 `CrishErrorPayload` |
| `ErrorDomain` 枚举值数（TS）                 | 11          | `error-classifier.ts`                                                                    |
| `ProviderErrorKind` 联合类型数（TS）         | 12          | `shared-types/src/tool.ts`                                                               |

---

## 1. 现有错误码清单

### 1.1 SessionErrorCode（`shared-types/src/errors.ts` L65-70）

```ts
export type SessionErrorCode =
  | 'not_found'
  | 'invalid_session'
  | 'invalid_entry'
  | 'invalid_state'
  | 'storage';
```

| 旧码              | 用途                                       | 实测 throw 点                                                                                |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `not_found`       | 会话/会话树条目/待处理输入未找到           | 8 处（session-tree.ts、task-queue.ts、agent-loop.ts、session-storage.ts、session-replay.ts） |
| `invalid_session` | 会话文件头非法、会话条目父循环             | 5 处（session-storage.ts、session-replay.ts）                                                |
| `invalid_entry`   | 会话条目重复、待处理输入为空               | 3 处（session-tree.ts、task-queue.ts）                                                       |
| `invalid_state`   | 会话树循环、会话状态非法、待处理输入归属错 | 8 处（session-tree.ts、task-queue.ts、session-storage.ts、session-replay.ts）                |
| `storage`         | 会话文件写入/替换失败                      | 3 处（session-storage.ts）                                                                   |

**特征**：无域前缀，依赖 `SessionError` 子类固定 `category="permanent"`、`retryable=false`。

### 1.2 ErrorDomain 枚举（`agent-runtime/src/error-classifier.ts` L3-15）

| ErrorDomain            | legacyKind           | retryable | uiSeverity | 触发条件                                                                  |
| ---------------------- | -------------------- | --------- | ---------- | ------------------------------------------------------------------------- |
| `USER_ABORT`           | cancelled            | false     | silent     | `signal.aborted` 或 abort 类错误                                          |
| `TRANSIENT_NETWORK`    | network              | true      | warning    | `ConnectionError`、timeout、econnreset 等                                 |
| `TRANSIENT_SERVER`     | server               | true      | warning    | HTTP 500/502/503/504/520/522/523/524                                      |
| `RATE_LIMIT`           | rate-limit           | true      | info       | HTTP 429                                                                  |
| `CLIENT_AUTH`          | auth                 | false     | error      | HTTP 401/403 或 unauthorized 关键词                                       |
| `CLIENT_INVALID_INPUT` | schema               | false     | warning    | HTTP 400/422/413，含 `context_length_exceeded`/`payload_too_large` 子类型 |
| `QUOTA_EXHAUSTED`      | quota                | false     | error      | HTTP 402 或 quota 关键词                                                  |
| `STREAM_INTERRUPT`     | invalid-stream       | true      | info       | `StreamInterruptedError`                                                  |
| `ENDPOINT_UNAVAILABLE` | endpoint-unavailable | false     | error      | HTTP 404/405/415                                                          |
| `GATEWAY_CHALLENGE`    | gateway-challenge    | false     | warning    | Cloudflare 质询                                                           |
| `UNKNOWN`              | unknown              | false     | error      | 兜底                                                                      |

**特征**：`ErrorClassifier.classify()` 是纯函数分类器，输出 `ClassifiedError`（含 `domain`/`retryable`/`uiSeverity`/`legacyKind`/`subType`/`httpStatus`/`providerId`/`recoveryHint`/`retryAfterMs`/`originalError`）。`recovery-pipeline.ts` 的 `PipelineResult` ADT 直接消费 `ClassifiedError`。

### 1.3 ProviderErrorKind 联合类型（`shared-types/src/tool.ts` L66-78）

```ts
export type ProviderErrorKind =
  | 'network'
  | 'gateway-challenge'
  | 'rate-limit'
  | 'auth'
  | 'quota'
  | 'endpoint-unavailable'
  | 'schema'
  | 'server'
  | 'timeout'
  | 'cancelled'
  | 'invalid-stream'
  | 'unknown';
```

`ProviderErrorKind` 与 `ErrorDomain.legacyKind` 同源（`classifyHttpProviderError`/`classifyStreamProviderError` 把 `ClassifiedError.legacyKind` 断言为 `ProviderErrorKind`）。`throw new ProviderError(msg, kind, retryable)` 把 `kind` 直接作为 `code` 字段使用，因此这 12 个 `kind` 字符串实际上已是 provider 域的自由字符串错误码。

### 1.4 自由字符串错误码（`throw new CrishError|ProviderError|ProtocolError`）

| 旧码                            | 子类          | 实测出现次数 | 出现文件                                                                                                    | 含义                                                                                                           |
| ------------------------------- | ------------- | ------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `TOOL_ERROR`                    | CrishError    | 49 处        | background-command.ts、git-patch-ops.ts、git-service.ts、lsp-tools.ts、local-tools/shared.ts、rich-read.ts  | 工具执行/路径校验/入参校验失败（**严重混用**：既含 transient 可重试的 hardline 拦截，又含 permanent 路径越界） |
| `CONFIG_ERROR`                  | ProviderError | 14 处        | provider-openai-config.ts、provider-openai-base.ts、provider-openai-class.ts、provider-openai-compatible.ts | Provider 配置项非法                                                                                            |
| `CHECKPOINT_ERROR`              | CrishError    | 8 处         | checkpoint-manifest.ts                                                                                      | Checkpoint manifest 校验失败                                                                                   |
| `BOUNDARY_ERROR`                | CrishError    | 8 处         | conversation-boundary-manifest.ts                                                                           | 会话边界 manifest 校验失败                                                                                     |
| `ARTIFACT_ERROR`                | CrishError    | 3 处         | artifact-store.ts                                                                                           | Blob artifact 未找到/URI 非法/sha256 非法                                                                      |
| `ADAPTER_ERROR`                 | CrishError    | 4 处         | daemon-product-adapters.ts                                                                                  | Daemon 产物适配器查找失败                                                                                      |
| `SCOPED_CONTEXT_ERROR`          | CrishError    | 4 处         | scoped-context-store.ts                                                                                     | Scoped context 存储校验失败                                                                                    |
| `DAEMON_DEAD`                   | ProviderError | 2 处         | provider-openai-base.ts                                                                                     | Rust reqwest daemon 已死                                                                                       |
| `NETWORK_ERROR`                 | ProviderError | 1 处         | provider-openai-class.ts                                                                                    | Fetch 传输失败（fetch + rust reqwest 双双失败）                                                                |
| `INVALID_RUN_STATE`             | ProtocolError | 1 处         | task-executor.ts                                                                                            | Run 以非终态结束                                                                                               |
| `NOT_A_GOAL_RUN`                | ProtocolError | 1 处         | goal-executor.ts                                                                                            | 非 goal 类型的 run 被当作 goal run 处理                                                                        |
| `LEAF_MISMATCH`                 | ProtocolError | 1 处         | session-tree.ts                                                                                             | 会话树叶节点不匹配（v1.0 基线漏算此 1 处）                                                                     |
| Provider `kind` 动态码（12 个） | ProviderError | 2 处         | provider-openai-compatible.ts、provider-openai-class.ts                                                     | `formatProviderError(err, kind)` 把 `network`/`auth`/`quota` 等 12 个 `kind` 直接作为 `code`                   |

**关键问题**：

1. `TOOL_ERROR` 是个"垃圾箱"码，49 处 throw 中混合了 transient/permanent、retryable/non-retryable、路径校验/执行失败/入参校验三种本质不同的故障。
2. 自由字符串码无域前缀，无法在序列化层做域路由。
3. `ProviderErrorKind` 的 12 个 `kind` 既是分类标签又是错误码，职责重叠。

### 1.5 Rust CoreError variant（`crates/conex-types/src/lib.rs` L207-222）

```rust
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum CoreError {
    InvalidInput(String),
    Encoding(String),
    Io(String),
    NotFound(String),
    Cancelled,
    Internal(String),
}
```

| variant                | 序列化形态                               | 含义                            |
| ---------------------- | ---------------------------------------- | ------------------------------- |
| `InvalidInput(String)` | `{"kind":"InvalidInput","detail":"..."}` | 输入非法                        |
| `Encoding(String)`     | `{"kind":"Encoding","detail":"..."}`     | 编解码失败                      |
| `Io(String)`           | `{"kind":"Io","detail":"..."}`           | IO 错误                         |
| `NotFound(String)`     | `{"kind":"NotFound","detail":"..."}`     | 资源未找到                      |
| `Cancelled`            | `{"kind":"Cancelled"}`                   | 取消（unit variant，无 detail） |
| `Internal(String)`     | `{"kind":"Internal","detail":"..."}`     | 内部错误                        |

**序列化形态**：`#[serde(tag="kind", content="detail")]` 标签枚举，`IpcResponse.error: Option<String>` 当前是裸字符串（L85），未承载 `CoreError` 结构。

---

## 2. 新 CrishErrorCode 体系（64 正式码 + 10 reserved 码 / 19 域）

### 2.1 设计原则

1. **`domain.reason` 格式**：全小写、点分隔、`^[a-z_]+\.[a-z_]+$`。`domain` 是故障域，`reason` 是该域内的具体原因。
2. **保留现有 `category` 字段**：`'transient' | 'permanent' | 'security' | 'protocol'` 四类不变（§设计约束 1）。`category` 描述故障性质，`code` 描述故障位置。
3. **`retryable` 与 `category` 解耦**：`transient` 默认 `retryable=true`，但允许覆盖（如 `provider.endpoint_unavailable` 是 transient 但通常不重试）。
4. **`public` 字段**：标记是否对终端用户可见。内部诊断码（如 `telemetry.trace_lost`）`public=false`。
5. **`action` 字段**：用户可执行的操作建议，国际化键名（前端按键查翻译，未命中则回退到英文原文）。
6. **穷尽覆盖**：19 个域覆盖现有全部错误来源 + 新增域（subagent/plugin/approval/event_store/artifact/run/network/security）。
7. **reserved 码机制**：真实代码中无直接 throw 场景的码标注 `[reserved]`，不进入 `CrishErrorCode` 联合类型的必选集，仅作为字符串常量保留（`CrishReservedErrorCode`）。未来出现真实场景时升级为正式码。详见 §2.4。

### 2.2 完整错误码表

> 表头说明：`retryable` 默认随 `category`（transient=true，permanent/security/protocol=false），下表仅在覆盖默认值时标注实际值。

#### config 域（配置）— 3 码

| 码值                  | title        | category  | retryable | public | action                        |
| --------------------- | ------------ | --------- | --------- | ------ | ----------------------------- |
| `config.invalid`      | 配置项非法   | permanent | false     | true   | `action.config.check_field`   |
| `config.missing`      | 配置缺失     | permanent | false     | true   | `action.config.provide_value` |
| `config.parse_failed` | 配置解析失败 | permanent | false     | true   | `action.config.verify_syntax` |

#### session 域（会话）— 6 码

| 码值                      | title        | category  | retryable | public | action                               |
| ------------------------- | ------------ | --------- | --------- | ------ | ------------------------------------ |
| `session.not_found`       | 会话未找到   | permanent | false     | true   | `action.session.select_existing`     |
| `session.invalid_session` | 会话数据非法 | permanent | false     | true   | `action.session.restart`             |
| `session.invalid_entry`   | 会话条目非法 | permanent | false     | true   | `action.session.check_entry`         |
| `session.invalid_state`   | 会话状态非法 | permanent | false     | true   | `action.session.refresh`             |
| `session.storage_failed`  | 会话存储失败 | transient | true      | true   | `action.session.retry_save`          |
| `session.rewind_failed`   | 会话回滚失败 | permanent | false     | true   | `action.session.check_rewind_target` |

#### agent 域（Agent）— 3 码 [全部 reserved]

| 码值                                       | title        | category  | retryable | public | action                            |
| ------------------------------------------ | ------------ | --------- | --------- | ------ | --------------------------------- |
| `agent.max_turns_reached` `[reserved]`     | 达到最大轮次 | permanent | false     | true   | `action.agent.increase_max_turns` |
| `agent.no_progress` `[reserved]`           | Agent 无进展 | permanent | false     | true   | `action.agent.intervene`          |
| `agent.intervention_required` `[reserved]` | 需用户介入   | permanent | false     | true   | `action.agent.review`             |

#### runtime 域（运行时）— 4 码

| 码值                        | title          | category  | retryable | public | action                           |
| --------------------------- | -------------- | --------- | --------- | ------ | -------------------------------- |
| `runtime.unexpected_state`  | 运行时状态异常 | permanent | false     | true   | `action.runtime.restart_session` |
| `runtime.transition_failed` | 状态转移失败   | permanent | false     | true   | `action.runtime.report_bug`      |
| `runtime.aborted`           | 用户中止       | permanent | false     | true   | `action.runtime.none`            |
| `runtime.timeout`           | 运行时超时     | transient | true      | true   | `action.runtime.retry`           |

#### provider 域（Provider）— 17 码

| 码值                            | title                 | category  | retryable | public | action                             |
| ------------------------------- | --------------------- | --------- | --------- | ------ | ---------------------------------- |
| `provider.network`              | 网络故障              | transient | true      | true   | `action.provider.check_network`    |
| `provider.gateway_challenge`    | 网关质询拦截          | protocol  | false     | true   | `action.provider.disable_proxy`    |
| `provider.rate_limit`           | 限流                  | transient | true      | true   | `action.provider.wait_retry`       |
| `provider.auth`                 | 鉴权失败              | security  | false     | true   | `action.provider.check_api_key`    |
| `provider.quota`                | 配额耗尽              | permanent | false     | true   | `action.provider.top_up`           |
| `provider.endpoint_unavailable` | 端点不可用            | permanent | false     | true   | `action.provider.check_endpoint`   |
| `provider.schema`               | 请求 schema 非法      | protocol  | false     | true   | `action.provider.fix_request`      |
| `provider.server`               | 服务端错误            | transient | true      | true   | `action.provider.wait_retry`       |
| `provider.timeout`              | 请求超时              | transient | true      | true   | `action.provider.retry`            |
| `provider.cancelled`            | 请求取消              | permanent | false     | false  | `action.runtime.none`              |
| `provider.stream_interrupted`   | 流中断                | transient | true      | true   | `action.provider.retry`            |
| `provider.unknown`              | 未知 Provider 错误    | permanent | false     | true   | `action.provider.report_bug`       |
| `provider.connection_error`     | Provider 连接错误     | transient | true      | true   | `action.provider.check_connection` |
| `provider.no_token`             | OAuth 令牌缺失        | security  | false     | true   | `action.provider.reauth`           |
| `provider.reauth_required`      | 需重新鉴权            | security  | false     | true   | `action.provider.reauth`           |
| `provider.fatal`                | Provider 不可恢复错误 | permanent | false     | true   | `action.provider.report_bug`       |
| `provider.refresh_failed`       | 令牌刷新失败          | security  | false     | true   | `action.provider.reauth`           |

#### context 域（上下文）— 2 正式码 + 1 reserved

| 码值                               | title          | category  | retryable | public | action                         |
| ---------------------------------- | -------------- | --------- | --------- | ------ | ------------------------------ |
| `context.length_exceeded`          | 上下文超长     | protocol  | true      | true   | `action.context.compact`       |
| `context.compaction_failed`        | 上下文压缩失败 | transient | true      | true   | `action.context.retry_compact` |
| `context.heal_failed` `[reserved]` | 上下文修复失败 | permanent | false     | true   | `action.context.manual_trim`   |

#### tool 域（工具执行）— 5 码

| 码值                    | title        | category  | retryable | public | action                          |
| ----------------------- | ------------ | --------- | --------- | ------ | ------------------------------- |
| `tool.not_found`        | 工具未找到   | permanent | false     | true   | `action.tool.check_name`        |
| `tool.invalid_input`    | 工具入参非法 | protocol  | false     | true   | `action.tool.fix_input`         |
| `tool.execution_failed` | 工具执行失败 | transient | true      | true   | `action.tool.retry`             |
| `tool.path_escape`      | 路径越界     | security  | false     | true   | `action.tool.check_path`        |
| `tool.version_conflict` | 文档版本冲突 | protocol  | false     | true   | `action.tool.refresh_and_retry` |

#### mcp 域（MCP）— 3 码

| 码值                     | title            | category  | retryable | public | action                    |
| ------------------------ | ---------------- | --------- | --------- | ------ | ------------------------- |
| `mcp.connection_failed`  | MCP 连接失败     | transient | true      | true   | `action.mcp.check_server` |
| `mcp.protocol_violation` | MCP 协议违规     | protocol  | false     | true   | `action.mcp.report_bug`   |
| `mcp.server_not_found`   | MCP 服务器未找到 | permanent | false     | true   | `action.mcp.check_config` |

#### store 域（存储）— 4 码

| 码值                      | title        | category  | retryable | public | action                           |
| ------------------------- | ------------ | --------- | --------- | ------ | -------------------------------- |
| `store.write_failed`      | 存储写入失败 | transient | true      | true   | `action.store.retry_write`       |
| `store.read_failed`       | 存储读取失败 | transient | true      | true   | `action.store.retry_read`        |
| `store.corrupted`         | 存储数据损坏 | permanent | false     | true   | `action.store.restore_backup`    |
| `store.capacity_exceeded` | 存储容量超限 | permanent | false     | true   | `action.store.cleanup_or_expand` |

> **Windows 文件锁**：`store.write_failed` 与 `log.write_failed`（见 telemetry 域）专门承载 Windows 平台 `EBUSY`/`EACCES` 文件锁错误。`action.store.retry_write` 在 Windows 上建议带退避重试。

#### subagent 域（子代理）— 2 正式码 + 1 reserved

| 码值                            | title              | category  | retryable | public | action                         |
| ------------------------------- | ------------------ | --------- | --------- | ------ | ------------------------------ |
| `subagent.depth_exceeded`       | 子代理递归深度超限 | permanent | false     | true   | `action.subagent.reduce_depth` |
| `subagent.deadlock_detected`    | 子代理死锁         | permanent | false     | true   | `action.subagent.break_cycle`  |
| `subagent.timeout` `[reserved]` | 子代理超时         | transient | true      | true   | `action.subagent.retry`        |

#### plugin 域（插件）— 3 码

| 码值                       | title        | category  | retryable | public | action                           |
| -------------------------- | ------------ | --------- | --------- | ------ | -------------------------------- |
| `plugin.not_found`         | 插件未找到   | permanent | false     | true   | `action.plugin.check_install`    |
| `plugin.activation_failed` | 插件激活失败 | permanent | false     | true   | `action.plugin.check_manifest`   |
| `plugin.permission_denied` | 插件权限不足 | security  | false     | true   | `action.plugin.grant_permission` |

#### approval 域（审批）— 2 码 [全部 reserved]

| 码值                             | title    | category  | retryable | public | action                           |
| -------------------------------- | -------- | --------- | --------- | ------ | -------------------------------- |
| `approval.timeout` `[reserved]`  | 审批超时 | transient | true      | true   | `action.approval.resubmit`       |
| `approval.rejected` `[reserved]` | 审批被拒 | permanent | false     | true   | `action.approval.modify_request` |

#### event_store 域（事件存储）— 4 码

| 码值                                | title          | category  | retryable | public | action                             |
| ----------------------------------- | -------------- | --------- | --------- | ------ | ---------------------------------- |
| `event_store.append_failed`         | 事件追加失败   | transient | true      | false  | `action.event_store.retry_append`  |
| `event_store.consistency_violation` | 事件一致性违规 | permanent | false     | false  | `action.event_store.rebuild_index` |
| `event_store.read_failed`           | 事件读取失败   | transient | true      | false  | `action.event_store.retry_read`    |
| `event_store.degraded`              | 事件存储降级   | permanent | false     | false  | `action.event_store.check_disk`    |

#### artifact 域（Artifact）— 2 码

| 码值                   | title             | category  | retryable | public | action                      |
| ---------------------- | ----------------- | --------- | --------- | ------ | --------------------------- |
| `artifact.not_found`   | Artifact 未找到   | permanent | false     | true   | `action.artifact.check_uri` |
| `artifact.invalid_uri` | Artifact URI 非法 | protocol  | false     | true   | `action.artifact.fix_uri`   |

#### run 域（运行状态）— 3 码

| 码值                | title        | category  | retryable | public | action                       |
| ------------------- | ------------ | --------- | --------- | ------ | ---------------------------- |
| `run.not_found`     | Run 未找到   | permanent | false     | true   | `action.run.select_existing` |
| `run.invalid_state` | Run 状态非法 | protocol  | false     | true   | `action.run.refresh`         |
| `run.not_goal_run`  | 非 Goal Run  | protocol  | false     | true   | `action.run.use_goal_run`    |

#### network 域（网络）— 1 正式码 + 1 reserved

| 码值                               | title            | category  | retryable | public | action                            |
| ---------------------------------- | ---------------- | --------- | --------- | ------ | --------------------------------- |
| `network.unreachable` `[reserved]` | 网络不可达       | transient | true      | true   | `action.network.check_connection` |
| `network.daemon_dead`              | 后台 Daemon 已死 | permanent | false     | true   | `action.network.restart_daemon`   |

> `network.unreachable` 降级为 reserved：与 `provider.connection_error` 职责重叠，非 Provider 网络故障统一走 `provider.connection_error`。

#### telemetry 域（观测）— 1 正式码 + 2 reserved

| 码值                                   | title            | category  | retryable | public | action                          |
| -------------------------------------- | ---------------- | --------- | --------- | ------ | ------------------------------- |
| `telemetry.export_failed` `[reserved]` | 观测数据导出失败 | transient | true      | false  | `action.telemetry.retry_export` |
| `telemetry.trace_lost` `[reserved]`    | Trace 丢失       | transient | true      | false  | `action.telemetry.none`         |
| `log.write_failed`                     | 日志写入失败     | transient | true      | false  | `action.log.retry_write`        |

> `log.write_failed` 归入 telemetry 域是因为 `@crish/logger` 是 telemetry 基础设施的一部分（见 `01-OVERVIEW.md` 依赖图 Layer 1）。Windows 文件锁场景由本码承载。

#### common 域（通用）— 3 码

| 码值                 | title          | category  | retryable | public | action                         |
| -------------------- | -------------- | --------- | --------- | ------ | ------------------------------ |
| `common.unknown`     | 未知错误       | permanent | false     | true   | `action.common.report_bug`     |
| `common.unsupported` | 不支持的操作   | permanent | false     | true   | `action.common.check_version`  |
| `common.not_found`   | 通用资源未找到 | permanent | false     | true   | `action.common.check_resource` |

#### security 域（安全）— 1 码 [新增域]

| 码值                     | title     | category | retryable | public | action                         |
| ------------------------ | --------- | -------- | --------- | ------ | ------------------------------ |
| `security.ssrf_rejected` | SSRF 拦截 | security | false     | false  | `action.security.check_target` |

> `security` 域为新增域，专门承载安全策略拦截类错误（如 SSRF 防护、路径越界已在 `tool.path_escape` 中承载）。`public=false` 因为安全拦截细节不应直接暴露给终端用户。

**码数汇总**：

| 域          | 正式码 | reserved | 小计   |
| ----------- | ------ | -------- | ------ |
| config      | 3      | 0        | 3      |
| session     | 6      | 0        | 6      |
| agent       | 0      | 3        | 3      |
| runtime     | 4      | 0        | 4      |
| provider    | 17     | 0        | 17     |
| context     | 2      | 1        | 3      |
| tool        | 5      | 0        | 5      |
| mcp         | 3      | 0        | 3      |
| store       | 4      | 0        | 4      |
| subagent    | 2      | 1        | 3      |
| plugin      | 3      | 0        | 3      |
| approval    | 0      | 2        | 2      |
| event_store | 4      | 0        | 4      |
| artifact    | 2      | 0        | 2      |
| run         | 3      | 0        | 3      |
| network     | 1      | 1        | 2      |
| telemetry   | 1      | 2        | 3      |
| common      | 3      | 0        | 3      |
| security    | 1      | 0        | 1      |
| **合计**    | **64** | **10**   | **74** |

> 从 v1.0 的 60 码扩展到 64 正式码 + 10 reserved 码。新增 13 个正式码用于覆盖 31 个之前未映射的 Error 子类（见 §3.5）与 4 个 Rust 错误枚举（见 §3.7-§3.10）。10 个无场景码降级为 reserved，待真实场景出现后升级。

### 2.3 CrishErrorInfo 注册表

`CrishErrorInfo` 是每个码的元信息描述，由 `CRISH_ERROR_REGISTRY: Readonly<Record<CrishErrorCode, CrishErrorInfo>>` 静态注册表承载。Round 1 在 `shared-types/src/error-codes.ts` 实现。

```ts
// shared-types/src/error-codes.ts （Round 1 实现）

/** 正式错误码（64 码）：有真实 throw 场景或被映射的码，进入 CrishErrorCode 联合类型必选集 */
export type CrishErrorCode =
  // config 域（3）
  | 'config.invalid'
  | 'config.missing'
  | 'config.parse_failed'
  // session 域（6）
  | 'session.not_found'
  | 'session.invalid_session'
  | 'session.invalid_entry'
  | 'session.invalid_state'
  | 'session.storage_failed'
  | 'session.rewind_failed'
  // runtime 域（4）
  | 'runtime.unexpected_state'
  | 'runtime.transition_failed'
  | 'runtime.aborted'
  | 'runtime.timeout'
  // provider 域（17）
  | 'provider.network'
  | 'provider.gateway_challenge'
  | 'provider.rate_limit'
  | 'provider.auth'
  | 'provider.quota'
  | 'provider.endpoint_unavailable'
  | 'provider.schema'
  | 'provider.server'
  | 'provider.timeout'
  | 'provider.cancelled'
  | 'provider.stream_interrupted'
  | 'provider.unknown'
  | 'provider.connection_error'
  | 'provider.no_token'
  | 'provider.reauth_required'
  | 'provider.fatal'
  | 'provider.refresh_failed'
  // context 域（2 正式）
  | 'context.length_exceeded'
  | 'context.compaction_failed'
  // tool 域（5）
  | 'tool.not_found'
  | 'tool.invalid_input'
  | 'tool.execution_failed'
  | 'tool.path_escape'
  | 'tool.version_conflict'
  // mcp 域（3）
  | 'mcp.connection_failed'
  | 'mcp.protocol_violation'
  | 'mcp.server_not_found'
  // store 域（4）
  | 'store.write_failed'
  | 'store.read_failed'
  | 'store.corrupted'
  | 'store.capacity_exceeded'
  // subagent 域（2 正式）
  | 'subagent.depth_exceeded'
  | 'subagent.deadlock_detected'
  // plugin 域（3）
  | 'plugin.not_found'
  | 'plugin.activation_failed'
  | 'plugin.permission_denied'
  // event_store 域（4）
  | 'event_store.append_failed'
  | 'event_store.consistency_violation'
  | 'event_store.read_failed'
  | 'event_store.degraded'
  // artifact 域（2）
  | 'artifact.not_found'
  | 'artifact.invalid_uri'
  // run 域（3）
  | 'run.not_found'
  | 'run.invalid_state'
  | 'run.not_goal_run'
  // network 域（1 正式）
  | 'network.daemon_dead'
  // telemetry 域（1 正式）
  | 'log.write_failed'
  // common 域（3）
  | 'common.unknown'
  | 'common.unsupported'
  | 'common.not_found'
  // security 域（1）
  | 'security.ssrf_rejected';

/** Reserved 错误码（10 码）：真实代码中无直接 throw 场景，仅作为字符串常量保留。
 *  不进入 CrishErrorCode 联合类型必选集。未来出现真实场景时升级为正式码。 */
export type CrishReservedErrorCode =
  // agent 域（3 reserved）
  | 'agent.max_turns_reached'
  | 'agent.no_progress'
  | 'agent.intervention_required'
  // context 域（1 reserved）
  | 'context.heal_failed'
  // subagent 域（1 reserved）
  | 'subagent.timeout'
  // approval 域（2 reserved）
  | 'approval.timeout'
  | 'approval.rejected'
  // network 域（1 reserved）
  | 'network.unreachable'
  // telemetry 域（2 reserved）
  | 'telemetry.export_failed'
  | 'telemetry.trace_lost';

/** 全部错误码（正式 + reserved），用于迁移映射表的字符串校验 */
export type CrishAnyErrorCode = CrishErrorCode | CrishReservedErrorCode;

export type CrishErrorCategory =
  'transient' | 'permanent' | 'security' | 'protocol';

export interface CrishErrorInfo {
  readonly code: CrishAnyErrorCode;
  readonly title: string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly reserved?: boolean; // true 表示此码当前无真实 throw 场景
}

/** 正式码 + reserved 码的合并注册表（74 条） */
export const CRISH_ERROR_REGISTRY: Readonly<
  Record<CrishAnyErrorCode, CrishErrorInfo>
> = {
  // ... 64 条正式码 + 10 条 reserved 码（内容见 §2.2 表，reserved 条目带 reserved: true）
};

export function getErrorInfo(code: CrishAnyErrorCode | string): CrishErrorInfo {
  return (
    CRISH_ERROR_REGISTRY[code as CrishAnyErrorCode] ??
    CRISH_ERROR_REGISTRY['common.unknown']
  );
}
```

### 2.4 Reserved 码管理策略

reserved 码遵循以下规则：

1. **降级条件**：真实代码扫描确认无直接 `throw` 调用点，且无 Error 子类映射到该码。
2. **保留方式**：留在 `CRISH_ERROR_REGISTRY` 中并标注 `reserved: true`，但不在 `CrishErrorCode` 联合类型中导出。
3. **升级条件**：当出现真实 throw 场景或新 Error 子类映射到该码时，从 `CrishReservedErrorCode` 移入 `CrishErrorCode`。本次升级的 2 个码：
   - `runtime.transition_failed`：现有 DaemonRunPreflightError（2 处 throw）与 WorkspaceMutationLeaseError（1 处 throw）可映射，已为正式码。
   - `subagent.deadlock_detected`：现有 OAuthDeadlockError（1 处 throw）可映射，已为正式码。
4. **本次降级的 1 个码**：
   - `network.unreachable`：与 `provider.connection_error` 职责重叠，降级为 reserved。原 IpcError.Timeout 映射改为 `runtime.timeout`。

---

## 3. 旧码→新码迁移映射

### 3.1 SessionErrorCode → CrishErrorCode

| 旧码              | 新码                      | category 变化           | 迁移说明                                                                                     |
| ----------------- | ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `not_found`       | `session.not_found`       | permanent→permanent     | 直接映射，`SessionError` 子类废弃后改用 `CrishError`                                         |
| `invalid_session` | `session.invalid_session` | permanent→permanent     | 直接映射                                                                                     |
| `invalid_entry`   | `session.invalid_entry`   | permanent→permanent     | 直接映射                                                                                     |
| `invalid_state`   | `session.invalid_state`   | permanent→permanent     | 直接映射                                                                                     |
| `storage`         | `session.storage_failed`  | permanent→**transient** | **语义修正**：会话存储失败多为 IO/锁问题，应可重试；旧码错误地标记为 permanent+non-retryable |

### 3.2 ErrorDomain → CrishErrorCode

| 旧 ErrorDomain         | 新码范围                                         | legacyKind → 新码                                                                                               | 迁移说明                                                                                                                                |
| ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `USER_ABORT`           | `runtime.aborted` / `provider.cancelled`         | cancelled → `runtime.aborted`（运行时层）/ `provider.cancelled`（Provider 层）                                  | `ErrorClassifier` 输出保留，但 `ClassifiedError.domain` 增加 `toCrishErrorCode()` 方法                                                  |
| `TRANSIENT_NETWORK`    | `provider.network` / `provider.connection_error` | network → `provider.network`                                                                                    | Provider 网络故障用 `provider.network`；非 Provider 的网络故障用 `provider.connection_error`（`network.unreachable` 已降级为 reserved） |
| `TRANSIENT_SERVER`     | `provider.server`                                | server → `provider.server`                                                                                      | 直接映射                                                                                                                                |
| `RATE_LIMIT`           | `provider.rate_limit`                            | rate-limit → `provider.rate_limit`                                                                              | 直接映射                                                                                                                                |
| `CLIENT_AUTH`          | `provider.auth`                                  | auth → `provider.auth`                                                                                          | 直接映射                                                                                                                                |
| `CLIENT_INVALID_INPUT` | `provider.schema` / `context.length_exceeded`    | schema → `provider.schema`；context-overflow → `context.length_exceeded`；payload-too-large → `provider.schema` | 按 `subType` 拆分：`context_length_exceeded` 走 context 域，其余走 `provider.schema`                                                    |
| `QUOTA_EXHAUSTED`      | `provider.quota`                                 | quota → `provider.quota`                                                                                        | 直接映射                                                                                                                                |
| `STREAM_INTERRUPT`     | `provider.stream_interrupted`                    | invalid-stream → `provider.stream_interrupted`                                                                  | 重命名以更准确表达"流中断"语义                                                                                                          |
| `ENDPOINT_UNAVAILABLE` | `provider.endpoint_unavailable`                  | endpoint-unavailable → `provider.endpoint_unavailable`                                                          | 直接映射                                                                                                                                |
| `GATEWAY_CHALLENGE`    | `provider.gateway_challenge`                     | gateway-challenge → `provider.gateway_challenge`                                                                | 直接映射                                                                                                                                |
| `UNKNOWN`              | `common.unknown` / `provider.unknown`            | unknown → `common.unknown`（非 Provider）/ `provider.unknown`（Provider 上下文）                                | 按 `providerId` 是否存在分流                                                                                                            |

**`ErrorClassifier` 迁移策略**：保留 `ErrorClassifier.classify()` 签名不变（共存阶段），新增 `ClassifiedError.toCrishErrorCode(): CrishErrorCode` 方法。`recovery-pipeline.ts` 的 `PipelineResult` 在迁移阶段增加 `error: CrishError` 字段与原 `error: ClassifiedError` 并存，删除阶段移除旧字段。

### 3.3 ProviderErrorKind → CrishErrorCode

| 旧 kind                | 新码                            | 迁移说明                                  |
| ---------------------- | ------------------------------- | ----------------------------------------- |
| `network`              | `provider.network`              | 直接映射                                  |
| `gateway-challenge`    | `provider.gateway_challenge`    | 连字符改下划线以符合 `domain.reason` 规范 |
| `rate-limit`           | `provider.rate_limit`           | 同上                                      |
| `auth`                 | `provider.auth`                 | 直接映射                                  |
| `quota`                | `provider.quota`                | 直接映射                                  |
| `endpoint-unavailable` | `provider.endpoint_unavailable` | 同上                                      |
| `schema`               | `provider.schema`               | 直接映射                                  |
| `server`               | `provider.server`               | 直接映射                                  |
| `timeout`              | `provider.timeout`              | 直接映射                                  |
| `cancelled`            | `provider.cancelled`            | 直接映射                                  |
| `invalid-stream`       | `provider.stream_interrupted`   | 重命名                                    |
| `unknown`              | `provider.unknown`              | 直接映射                                  |

`ProviderErrorKind` 类型在共存阶段保留，迁移阶段标记 `@deprecated`，删除阶段移除。`formatProviderError(error, kind)` 改为 `formatProviderError(error, code: CrishErrorCode)`。

### 3.4 自由字符串码 → CrishErrorCode

| 旧码                                                 | 新码                                     | 出现文件                                                                                                                                         | 迁移说明                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `TOOL_ERROR`（transient+retryable，hardline 拦截类） | `tool.execution_failed`                  | background-command.ts L131                                                                                                                       | 按故障性质拆分（见下方 TOOL_ERROR 拆分表）                                                                                  |
| `TOOL_ERROR`（permanent，路径越界类）                | `tool.path_escape`                       | background-command.ts L722、git-patch-ops.ts L166、local-tools/shared.ts L69、rich-read.ts L578、lsp-tools.ts L586                               | 路径越界是安全约束，归 security 域                                                                                          |
| `TOOL_ERROR`（permanent，入参校验类）                | `tool.invalid_input`                     | lsp-tools.ts（14 处校验）、local-tools/shared.ts（8 处校验）、rich-read.ts（7 处校验）、git-patch-ops.ts（4 处校验）、background-command.ts L738 | 入参校验失败归 protocol 域                                                                                                  |
| `TOOL_ERROR`（permanent，资源未找到类）              | `tool.not_found`                         | background-command.ts L434/L602、rich-read.ts L168/L264                                                                                          | 资源未找到归 permanent                                                                                                      |
| `TOOL_ERROR`（permanent，git 元数据类）              | `tool.execution_failed`                  | git-patch-ops.ts L84/L92/L96、git-service.ts L218/L295                                                                                           | Git 元数据缺失归执行失败                                                                                                    |
| `CONFIG_ERROR`                                       | `config.invalid`                         | provider-openai-config.ts（11 处）、provider-openai-base.ts（7 处）、provider-openai-class.ts L57、provider-openai-compatible.ts L89             | Provider 配置项非法统一归 `config.invalid`                                                                                  |
| `CHECKPOINT_ERROR`                                   | `store.corrupted`                        | checkpoint-manifest.ts（8 处）                                                                                                                   | Checkpoint manifest 校验失败本质是数据损坏                                                                                  |
| `BOUNDARY_ERROR`                                     | `store.corrupted`                        | conversation-boundary-manifest.ts（8 处）                                                                                                        | 会话边界 manifest 校验失败同上                                                                                              |
| `ARTIFACT_ERROR`（未找到）                           | `artifact.not_found`                     | artifact-store.ts L132                                                                                                                           | 按 subcase 拆分                                                                                                             |
| `ARTIFACT_ERROR`（URI/sha256 非法）                  | `artifact.invalid_uri`                   | artifact-store.ts L169/L344                                                                                                                      | URI/digest 非法归 protocol                                                                                                  |
| `ADAPTER_ERROR`                                      | `artifact.not_found` / `store.corrupted` | daemon-product-adapters.ts（4 处）                                                                                                               | 前 3 处（artifact/checkpoint/memory not found）→ `artifact.not_found`；最后 1 处（invalid memory scope）→ `store.corrupted` |
| `SCOPED_CONTEXT_ERROR`                               | `store.corrupted`                        | scoped-context-store.ts（4 处）                                                                                                                  | Scoped context 校验失败归数据损坏                                                                                           |
| `DAEMON_DEAD`                                        | `network.daemon_dead`                    | provider-openai-base.ts L259/L261                                                                                                                | Rust reqwest daemon 已死归 network 域                                                                                       |
| `NETWORK_ERROR`                                      | `provider.network`                       | provider-openai-class.ts L254                                                                                                                    | Fetch 传输失败归 provider.network（已有 provider.network 码）                                                               |
| `INVALID_RUN_STATE`                                  | `run.invalid_state`                      | task-executor.ts L323                                                                                                                            | 直接映射到 run 域                                                                                                           |
| `NOT_A_GOAL_RUN`                                     | `run.not_goal_run`                       | goal-executor.ts L379                                                                                                                            | 直接映射到 run 域                                                                                                           |
| `LEAF_MISMATCH`                                      | `session.invalid_state`                  | session-tree.ts                                                                                                                                  | 会话树叶节点不匹配归会话状态非法                                                                                            |
| 动态 `kind`（12 个 ProviderErrorKind）               | 对应 `provider.*` 码                     | provider-openai-compatible.ts L109、provider-openai-class.ts L141                                                                                | 见 §3.3                                                                                                                     |

**`TOOL_ERROR` 拆分汇总**（49 处 → 4 个新码）：

| 新码                    | 占比   | 出现文件                                                                                   |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `tool.invalid_input`    | ~33 处 | lsp-tools.ts、local-tools/shared.ts、rich-read.ts、git-patch-ops.ts、background-command.ts |
| `tool.path_escape`      | ~7 处  | background-command.ts、git-patch-ops.ts、local-tools/shared.ts、rich-read.ts、lsp-tools.ts |
| `tool.execution_failed` | ~7 处  | background-command.ts、git-patch-ops.ts、git-service.ts                                    |
| `tool.not_found`        | ~4 处  | background-command.ts、rich-read.ts                                                        |

### 3.5 自定义 Error 子类 → CrishErrorCode（31 类）

> 以下 31 个自定义 Error 子类在代码中真实存在且有 throw 调用，但 v1.0 文档完全未提及。本节补全其映射规则。每条映射均标注来源文件与实测 throw 数。

#### agent-daemon 域子类（11 类）

| #   | 子类                                    | 来源文件                                                              | throw 数 | 新码                                                    | 迁移说明                                                              |
| --- | --------------------------------------- | --------------------------------------------------------------------- | -------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | `DaemonBackgroundTaskError`             | agent-daemon/src/background-task-manager.ts                           | 3        | `tool.not_found` / `tool.execution_failed`              | 后台任务未找到 → `tool.not_found`；执行失败 → `tool.execution_failed` |
| 2   | `OrchestratorEventStoreError`           | agent-orchestrator/src/event-store/event-types.ts                     | 待查     | `event_store.append_failed` / `event_store.read_failed` | 按 append/read 操作方向拆分                                           |
| 3   | `BlobIntegrityError`                    | agent-orchestrator/src/artifact-store.ts                              | 1        | `artifact.invalid_uri`                                  | Blob URI/sha256 校验失败                                              |
| 4   | `DaemonWorkflowNotFoundError`           | agent-daemon/src/handlers/workflow-handlers.ts                        | 1        | `run.not_found`                                         | 工作流未找到归 run 域                                                 |
| 5   | `DaemonConversationRewindError`         | agent-daemon/src/handlers/session-handlers.ts                         | 13       | `session.rewind_failed`                                 | 会话回滚失败，新增 `session.rewind_failed` 码                         |
| 6   | `PlanDocumentStoreError`                | agent-daemon/src/plan-document-store.ts                               | 待查     | `store.write_failed`                                    | Plan 文档存储失败                                                     |
| 7   | `DaemonUnsupportedCapabilityError`      | agent-daemon/src/server-runtime-factory/types.ts                      | 4        | `common.unsupported`                                    | 不支持的能力                                                          |
| 8   | `DegradedError`（EVENT_STORE_DEGRADED） | agent-daemon/src/server/index.ts                                      | 1        | `event_store.degraded`                                  | 事件存储降级，新增 `event_store.degraded` 码                          |
| 9   | `SessionMetadataStoreError`             | agent-daemon/src/session-metadata-store.ts                            | 1        | `store.write_failed`                                    | 会话元数据存储失败                                                    |
| 10  | `DaemonRunPreflightError`               | agent-daemon/src/handlers/run-handlers/lifecycle/admission-control.ts | 2        | `runtime.transition_failed`                             | Run 预检失败归状态转移失败                                            |
| 11  | `WorkflowStoreError`                    | agent-daemon/src/workflow-store/types.ts                              | 待查     | `store.write_failed`                                    | 工作流存储失败                                                        |

#### agent-runtime 域子类（18 类）

| #   | 子类                          | 来源文件                                                   | throw 数 | 新码                                           | 迁移说明                                                                   |
| --- | ----------------------------- | ---------------------------------------------------------- | -------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| 12  | `GitCommandError`             | agent-runtime/src/git-versioning/git-commit-ops.ts         | 待查     | `tool.execution_failed`                        | Git 命令执行失败                                                           |
| 13  | `MalformedSseFrameError`      | agent-runtime/src/openai-stream-parse.ts                   | 1        | `provider.stream_interrupted`                  | SSE 帧解析失败归流中断                                                     |
| 14  | `McpLifecycleError`           | agent-runtime/src/mcp-lifecycle/types.ts                   | 3        | `mcp.connection_failed`                        | MCP 生命周期错误归连接失败                                                 |
| 15  | `PlanDocumentValidationError` | agent-runtime/src/plan-document/types.ts                   | 1        | `tool.invalid_input`                           | Plan 文档校验失败                                                          |
| 16  | `PlanDocumentPatchError`      | agent-runtime/src/plan-document/types.ts                   | 5        | `tool.invalid_input` / `tool.version_conflict` | 版本不匹配场景 → 新增 `tool.version_conflict`；其余 → `tool.invalid_input` |
| 17  | `ConexPathError`              | agent-runtime/src/path-handling/conex-path.ts              | 1        | `tool.path_escape`                             | 路径越界归安全约束                                                         |
| 18  | `ProviderGatewayError`        | agent-runtime/src/provider-gateway/types.ts                | 6        | 见下方子码表                                   | 按 subCode 拆分（见下方）                                                  |
| 19  | `ResourceUriParseError`       | agent-runtime/src/resource-uri.ts                          | 8        | `artifact.invalid_uri`                         | Resource URI 解析失败                                                      |
| 20  | `ResourceUnsupportedError`    | agent-runtime/src/resource-uri.ts                          | 5        | `common.unsupported`                           | 不支持的 resource 类型                                                     |
| 21  | `ResourceNotFoundError`       | agent-runtime/src/resource-uri.ts                          | 1        | `artifact.not_found`                           | Resource 未找到                                                            |
| 22  | `ResourceIntegrityError`      | agent-runtime/src/resource-uri.ts                          | 2        | `artifact.invalid_uri`                         | Resource 完整性校验失败                                                    |
| 23  | `OAuthStateError`             | agent-runtime/src/provider/auth/oauth/state-machine.ts     | 5        | 见下方子码表                                   | 按 state 拆分（见下方）                                                    |
| 24  | `OAuthDeadlockError`          | agent-runtime/src/provider/auth/oauth/state-machine.ts     | 1        | `subagent.deadlock_detected`                   | OAuth 死锁，语义复用 subagent 死锁码                                       |
| 25  | `StreamRecoveryError`         | agent-runtime/src/provider-transport/stream-recovery.ts    | 8        | `provider.stream_interrupted`                  | 流恢复失败归流中断                                                         |
| 26  | `ConnectionError`             | agent-runtime/src/provider-transport/connection-manager.ts | 1        | `provider.connection_error`                    | Provider 连接错误，新增 `provider.connection_error` 码                     |
| 27  | `StreamInterruptedError`      | agent-runtime/src/provider-transport/connection-manager.ts | 2        | `provider.stream_interrupted`                  | 流中断                                                                     |
| 28  | `StoreCapacityError`          | agent-runtime/src/session-store/types.ts                   | 4        | `store.capacity_exceeded`                      | 存储容量超限，新增 `store.capacity_exceeded` 码                            |
| 29  | `WorkspaceMutationLeaseError` | agent-runtime/src/workspace-mutation-coordinator.ts        | 1        | `runtime.transition_failed`                    | 工作区变更租约失败归状态转移失败                                           |

#### 测试桩子类（2 类，不迁移）

| #   | 子类                                   | 来源文件                                       | throw 数 | 处理                 |
| --- | -------------------------------------- | ---------------------------------------------- | -------- | -------------------- |
| 30  | `ProviderGatewayPlanNotFoundError`     | agent-runtime/src/testing/faux-call-gateway.ts | 0        | 不迁移（测试桩代码） |
| 31  | `ProviderGatewayProviderNotFoundError` | agent-runtime/src/testing/faux-call-gateway.ts | 0        | 不迁移（测试桩代码） |

#### ProviderGatewayError 子码拆分（#18）

| subCode                       | 新码                            | category  | 说明                        |
| ----------------------------- | ------------------------------- | --------- | --------------------------- |
| `route_not_found`             | `provider.endpoint_unavailable` | permanent | 路由未找到归端点不可用      |
| `ssrf_rejected`               | `security.ssrf_rejected`        | security  | SSRF 拦截归新增 security 域 |
| `provider_credential_missing` | `config.missing`                | permanent | 凭证缺失归配置缺失          |

#### OAuthStateError 子码拆分（#23）

| state             | 新码                       | category  | 说明           |
| ----------------- | -------------------------- | --------- | -------------- |
| `NO_TOKEN`        | `provider.no_token`        | security  | 令牌缺失       |
| `REAUTH_REQUIRED` | `provider.reauth_required` | security  | 需重新鉴权     |
| `FATAL_ERROR`     | `provider.fatal`           | permanent | 不可恢复错误   |
| `REFRESH_FAILED`  | `provider.refresh_failed`  | security  | 令牌刷新失败   |
| 其他              | `provider.auth`            | security  | 兜底归鉴权失败 |

### 3.6 Rust CoreError → CrishError

| 旧 variant             | 新 CrishErrorCode                                              | 迁移说明                                                                                                                  |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `InvalidInput(String)` | `common.unsupported` / `tool.invalid_input` / `config.invalid` | 按调用上下文拆分：Tauri command 入参校验 → `tool.invalid_input`；配置校验 → `config.invalid`；其余 → `common.unsupported` |
| `Encoding(String)`     | `store.corrupted`                                              | 编解码失败本质是数据损坏                                                                                                  |
| `Io(String)`           | `store.write_failed` / `store.read_failed`                     | 按操作方向拆分；Windows 文件锁场景走 `store.write_failed`                                                                 |
| `NotFound(String)`     | `session.not_found` / `artifact.not_found` / `run.not_found`   | 按资源类型拆分                                                                                                            |
| `Cancelled`            | `runtime.aborted`                                              | 直接映射                                                                                                                  |
| `Internal(String)`     | `common.unknown`                                               | 兜底映射，保留 detail 字符串作为 `metadata.detail`                                                                        |

**Rust 端迁移策略**：`CoreError` 序列化形态从 `{"kind":"...","detail":"..."}` 迁移为 `CrishErrorPayload`（见 §6.2）。`IpcResponse.error` 从 `Option<String>` 迁移为 `Option<CrishErrorPayload>`（见 §6.3）。`CoreError` 在共存阶段保留 `impl From<CoreError> for CrishErrorPayload`，删除阶段移除。

### 3.7 Rust IpcError → CrishErrorCode（conex-ipc）

> `IpcError` 位于 `crates/conex-ipc`，共 4 个 variant。

| 旧 variant   | 新 CrishErrorCode    | 迁移说明                                                        |
| ------------ | -------------------- | --------------------------------------------------------------- |
| `EmptyLine`  | `common.unknown`     | 空行解析失败，兜底归未知错误                                    |
| `ParseError` | `common.unsupported` | IPC 协议解析失败归不支持的操作                                  |
| `Timeout`    | `runtime.timeout`    | IPC 超时归运行时超时（`network.unreachable` 已降级为 reserved） |
| `NotFound`   | `common.not_found`   | IPC 资源未找到归通用未找到                                      |

**迁移策略**：`IpcError` 在共存阶段保留 `impl From<IpcError> for CrishErrorPayload`，删除阶段移除。IPC 层错误通过 `IpcResponse.error` 传播（见 §6.3）。

### 3.8 Rust MarkdownError → CrishErrorCode（conex-markdown）

> `MarkdownError` 位于 `crates/conex-markdown`，共 2 个 variant。

| 旧 variant     | 新 CrishErrorCode    | 迁移说明                        |
| -------------- | -------------------- | ------------------------------- |
| `InvalidInput` | `common.unsupported` | Markdown 输入非法归不支持的操作 |
| `Internal`     | `common.unknown`     | Markdown 内部错误兜底归未知     |

**迁移策略**：`MarkdownError` 在共存阶段保留 `impl From<MarkdownError> for CrishErrorPayload`，删除阶段移除。

### 3.9 Rust StreamError → CrishErrorCode（conex-stream）

> `StreamError` 位于 `crates/conex-stream`，共 1 个 variant。

| 旧 variant | 新 CrishErrorCode             | 迁移说明         |
| ---------- | ----------------------------- | ---------------- |
| `NotOpen`  | `provider.stream_interrupted` | 流未打开归流中断 |

**迁移策略**：`StreamError` 在共存阶段保留 `impl From<StreamError> for CrishErrorPayload`，删除阶段移除。

### 3.10 Rust NetError → CrishErrorCode（conex-net）

> `NetError` 位于 `crates/conex-net`，共 2 个 variant。

| 旧 variant         | 新 CrishErrorCode           | 迁移说明                     |
| ------------------ | --------------------------- | ---------------------------- |
| `ConnectionFailed` | `provider.connection_error` | 连接失败归 Provider 连接错误 |
| `Timeout`          | `runtime.timeout`           | 网络超时归运行时超时         |

**迁移策略**：`NetError` 在共存阶段保留 `impl From<NetError> for CrishErrorPayload`，删除阶段移除。

### 3.11 Rust conex-fs 迁移策略（anyhow）

> `conex-fs` 无结构化错误类型，全部使用 `anyhow::Result`。

**策略**：迁移阶段保持 `anyhow`，不引入新的错误枚举。仅在 Tauri command 边界将 `anyhow::Error` 转换为 `CrishErrorPayload`：

```rust
// Tauri command 边界转换（共存阶段）
impl From<anyhow::Error> for CrishErrorPayload {
    fn from(err: anyhow::Error) -> Self {
        Self {
            code: "common.unknown".into(),
            message: err.to_string(),
            category: "permanent".into(),
            retryable: false,
            is_public: true,
            action: "action.common.report_bug".into(),
            metadata: None,
            cause: None,
            stack: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
        }
    }
}
```

> 若未来 `conex-fs` 出现需要细分的错误场景（如权限不足、磁盘满），可按需新增 `fs.*` 域码并升级 `anyhow` 为结构化枚举。当前不过度设计。

---

## 4. throw 迁移追踪

### 4.1 `throw new Error` 热点文件清单（源码文件，按 throw 数降序）

> 已剔除 `*.test.ts`/`*.adversarial.test.ts` 测试文件。源码文件共 61 个、throw 共 177 处（测试文件 73 处 / 35 文件不在迁移优先级内，由各包测试迁移时顺带处理）。

| 文件                                                              | throw 数 | 迁移目标码域              | 优先级     |
| ----------------------------------------------------------------- | -------- | ------------------------- | ---------- |
| `agent-runtime/src/local-tools/fs-edit-tools/edit-tool.ts`        | 14       | tool.*                    | P0         |
| `agent-runtime/src/local-tools/fs-edit-tools/apply-edits-tool.ts` | 11       | tool.*                    | P0         |
| `agent-runtime/src/local-tools/fs-edit-tools/utils.ts`            | 11       | tool.*                    | P0         |
| `agent-runtime/src/snapshots.ts`                                  | 8        | store.* / tool.*          | P1         |
| `agent-runtime/src/session-store/index.ts`                        | 8        | store.* / session.*       | P1         |
| `agent-runtime/src/workspace-mutation-coordinator.ts`             | 7        | tool.*                    | P1         |
| `agent-runtime/src/preview-queue.ts`                              | 7        | tool.*                    | P1         |
| `agent-runtime/src/plugin-registry.ts`                            | 7        | plugin.*                  | P2         |
| `agent-runtime/src/provider/auth/secret-store.ts`                 | 6        | config.* / provider.auth  | P2         |
| `agent-runtime/src/media/provider-media-adapter.ts`               | 6        | provider.*                | P2         |
| `agent-runtime/src/conversation-rewind-target.ts`                 | 5        | session.*                 | P2         |
| `agent-runtime/src/provider-anthropic.ts`                         | 4        | provider.*                | P2         |
| `agent-runtime/src/provider-gemini.ts`                            | 4        | provider.*                | P2         |
| `agent-runtime/src/provider/engines/openai-compatible-engine.ts`  | 1        | provider.*                | P3         |
| `agent-runtime/src/provider/registry-v2.ts`                       | 3        | provider.* / config.*     | P3         |
| `agent-runtime/src/provider/auth/oauth/oauth-flow.ts`             | 3        | provider.auth             | P3         |
| `agent-runtime/src/mcp-stdio-adapter.ts`（agent-daemon）          | 3        | mcp.*                     | P3         |
| `agent-runtime/src/local-tools/fs-read-tools.ts`                  | 3        | tool.*                    | P3         |
| `agent-runtime/src/local-tools/shell-tools.ts`                    | 3        | tool.*                    | P3         |
| `agent-runtime/src/state-machine/core.ts`                         | 3        | runtime.*                 | P3         |
| `agent-runtime/src/checkpoints.ts`                                | 3        | store.*                   | P3         |
| `agent-runtime/src/checkpoint/checkpoint-manager.ts`              | 2        | store.*                   | P3         |
| `agent-runtime/src/memory.ts`                                     | 2        | store.*                   | P3         |
| `agent-runtime/src/media/media-preprocessor.ts`                   | 2        | provider.*                | P3         |
| `agent-runtime/src/provider/declarative-schema.ts`                | 2        | config.*                  | P3         |
| `agent-runtime/src/provider/cli/provider-utils.ts`                | 2        | provider.*                | P3         |
| `agent-runtime/src/provider-gateway/route-selector.ts`            | 2        | provider.*                | P3         |
| `agent-runtime/src/provider/faux-provider.ts`                     | 2        | provider.*                | P3         |
| `agent-runtime/src/provider-stream-contract.ts`                   | 2        | provider.*                | P3         |
| `agent-runtime/src/testing.ts`                                    | 2        | common.*                  | P3         |
| `agent-runtime/src/tool-discovery.ts`                             | 2        | tool.*                    | P3         |
| `agent-runtime/src/tools/tool-definition.ts`                      | 2        | tool.*                    | P3         |
| `agent-orchestrator/src/conversation-rewind.ts`                   | 2        | session.*                 | P3         |
| `agent-daemon/src/daemon-provider-gateway/index.ts`               | 2        | provider.*                | P3         |
| `agent-daemon/scripts/benchmark-daemon-streaming-harness.ts`      | 4        | common.*                  | P4（脚本） |
| `agent-runtime/src/canonical-schema.ts`                           | 1        | config.*                  | P4         |
| `agent-runtime/src/context-state.ts`                              | 1        | context.*                 | P4         |
| `agent-runtime/src/event-protocol/core-event-projector.ts`        | 1        | event_store.*             | P4         |
| `agent-runtime/src/event-queue/index.ts`                          | 1        | event_store.*             | P4         |
| `agent-runtime/src/hooks/compact-lifecycle.ts`                    | 1        | context.*                 | P4         |
| `agent-runtime/src/local-tools/pre-mutation.ts`                   | 1        | tool.*                    | P4         |
| `agent-runtime/src/path-handling/conex-path.ts`                   | 1        | tool.path_escape          | P4         |
| `agent-runtime/src/plan-document/operations.ts`                   | 1        | store.*                   | P4         |
| `agent-runtime/src/project-progress-ledger.ts`                    | 1        | store.*                   | P4         |
| `agent-runtime/src/runtime-components/provider-call-gateway.ts`   | 1        | provider.*                | P4         |
| `agent-runtime/src/scoped-context.ts`                             | 1        | context.*                 | P4         |
| `agent-runtime/src/session-loop/index.ts`                         | 1        | runtime.*                 | P4         |
| `agent-runtime/src/structured-summary.ts`                         | 1        | common.*                  | P4         |
| `agent-runtime/src/subagents.ts`                                  | 1        | subagent.*                | P4         |
| `agent-runtime/src/tools.ts`                                      | 1        | tool.*                    | P4         |
| `agent-orchestrator/src/orchestrator/agent-loop.ts`               | 1        | session.*                 | P4         |
| `agent-orchestrator/src/state-machine.ts`                         | 1        | runtime.*                 | P4         |
| `agent-daemon/src/binary-frame.ts`                                | 1        | common.*                  | P4         |
| `agent-daemon/src/capabilities.ts`                                | 1        | common.*                  | P4         |
| `agent-daemon/src/env-whitelist.ts`                               | 1        | config.*                  | P4         |
| `agent-daemon/src/handlers/session-handlers.ts`                   | 1        | session.*                 | P4         |
| `agent-daemon/src/mcp-config.ts`                                  | 1        | mcp.*                     | P4         |
| `agent-daemon/src/server-runtime-factory/index.ts`                | 1        | runtime.*                 | P4         |
| `agent-daemon/src/subagent-runtime.ts`                            | 2        | subagent.*                | P4         |
| `agent-daemon/src/daemon-provider-gateway/types.ts`               | 1        | provider.*                | P4         |
| `shared-utils/src/async-mutex.ts`                                 | 2        | runtime.*                 | P4         |
| `shared-utils/src/file/streaming-file-reader.ts`                  | 1        | store.read_failed         | P4         |
| `shared-utils/src/jsonl-append-batcher.ts`                        | 1        | event_store.append_failed | P4         |
| `shared-utils/src/wal.ts`                                         | 1        | store.write_failed        | P4         |
| `shared-types/src/validators/typed-invoke.ts`                     | 1        | common.*                  | P4         |
| `decision-engine/src/config-merger.ts`                            | 1        | config.*                  | P4         |
| `agent-daemon/src/daemon-client-registry.ts`                      | 1        | network.*                 | P4         |

**优先级定义**：

- **P0**：高频工具执行路径，throw 数 ≥ 10，Round 4（agent-tools）迁移
- **P1**：核心运行时路径，throw 数 5-9，Round 5（agent-core）迁移
- **P2**：Provider/插件系统，throw 数 3-6，Round 4/8 迁移
- **P3**：中等频率模块，throw 数 1-3，随所属包迁移
- **P4**：低频/脚本/单点，throw 数 1-2，随所属包迁移

### 4.2 `throw new CrishError|ProviderError|ProtocolError|SessionError` 清单（141 处 / 22 文件）

> 本表为 Crish* 子类 throw 的完整清单，数字与 §0.2 基线表一致。原 v1.0 文档的"89 处 / 14 文件"统计遗漏了 31 个自定义 Error 子类的 throw 调用点。

| 文件                                                                    | 子类                             | throw 数 | 旧码                       | 新码域                                                                            | 优先级 |
| ----------------------------------------------------------------------- | -------------------------------- | -------- | -------------------------- | --------------------------------------------------------------------------------- | ------ |
| `agent-runtime/src/lsp-tools.ts`                                        | CrishError                       | 16       | TOOL_ERROR                 | tool.*                                                                            | P0     |
| `agent-runtime/src/rich-read.ts`                                        | CrishError                       | 14       | TOOL_ERROR                 | tool.*                                                                            | P0     |
| `agent-runtime/src/provider-openai-config.ts`                           | ProviderError                    | 11       | CONFIG_ERROR               | config.invalid                                                                    | P2     |
| `agent-runtime/src/checkpoint-manifest.ts`                              | CrishError                       | 8        | CHECKPOINT_ERROR           | store.corrupted                                                                   | P1     |
| `agent-runtime/src/conversation-boundary-manifest.ts`                   | CrishError                       | 8        | BOUNDARY_ERROR             | store.corrupted                                                                   | P1     |
| `agent-runtime/src/provider-openai-base.ts`                             | ProviderError                    | 9        | CONFIG_ERROR/DAEMON_DEAD   | config.*/network.daemon_dead                                                      | P2     |
| `agent-runtime/src/git-versioning/git-patch-ops.ts`                     | CrishError                       | 7        | TOOL_ERROR                 | tool.*                                                                            | P1     |
| `agent-runtime/src/local-tools/shared.ts`                               | CrishError                       | 10       | TOOL_ERROR                 | tool.*                                                                            | P0     |
| `agent-runtime/src/background-command.ts`                               | CrishError                       | 5        | TOOL_ERROR                 | tool.*                                                                            | P0     |
| `agent-runtime/src/provider-openai-class.ts`                            | ProviderError                    | 3        | CONFIG_ERROR/NETWORK_ERROR | config.*/provider.network                                                         | P2     |
| `agent-runtime/src/git-versioning/git-service.ts`                       | CrishError                       | 2        | TOOL_ERROR                 | tool.*                                                                            | P1     |
| `agent-daemon/src/daemon-product-adapters.ts`                           | CrishError                       | 4        | ADAPTER_ERROR              | artifact.*/store.corrupted                                                        | P3     |
| `agent-daemon/src/scoped-context-store.ts`                              | CrishError                       | 4        | SCOPED_CONTEXT_ERROR       | store.corrupted                                                                   | P3     |
| `agent-orchestrator/src/artifact-store.ts`                              | CrishError                       | 3        | ARTIFACT_ERROR             | artifact.*                                                                        | P3     |
| `agent-runtime/src/provider-openai-compatible.ts`                       | ProviderError                    | 2        | CONFIG_ERROR/动态kind      | config._/provider._                                                               | P2     |
| `agent-runtime/src/session/session-storage.ts`                          | SessionError                     | 9        | SessionErrorCode 5 码      | session.*                                                                         | P1     |
| `agent-runtime/src/session/session-replay.ts`                           | SessionError                     | 6        | SessionErrorCode 5 码      | session.*                                                                         | P1     |
| `agent-orchestrator/src/session-tree.ts`                                | SessionError                     | 7        | SessionErrorCode 5 码      | session.*                                                                         | P3     |
| `agent-orchestrator/src/orchestrator/dispatcher/task-queue.ts`          | SessionError                     | 6        | SessionErrorCode 5 码      | session.*                                                                         | P3     |
| `agent-orchestrator/src/orchestrator/agent-loop.ts`                     | SessionError                     | 2        | not_found                  | session.not_found                                                                 | P3     |
| `agent-orchestrator/src/orchestrator/dispatcher/task-executor.ts`       | ProtocolError                    | 1        | INVALID_RUN_STATE          | run.invalid_state                                                                 | P3     |
| `agent-orchestrator/src/orchestrator/dispatcher/goal-executor.ts`       | ProtocolError                    | 1        | NOT_A_GOAL_RUN             | run.not_goal_run                                                                  | P3     |
| `agent-daemon/src/background-task-manager.ts`                           | DaemonBackgroundTaskError        | 3        | —                          | tool.not_found/tool.execution_failed                                              | P3     |
| `agent-daemon/src/handlers/workflow-handlers.ts`                        | DaemonWorkflowNotFoundError      | 1        | —                          | run.not_found                                                                     | P3     |
| `agent-daemon/src/handlers/session-handlers.ts`                         | DaemonConversationRewindError    | 13       | —                          | session.rewind_failed                                                             | P3     |
| `agent-daemon/src/server-runtime-factory/types.ts`                      | DaemonUnsupportedCapabilityError | 4        | —                          | common.unsupported                                                                | P3     |
| `agent-daemon/src/server/index.ts`                                      | DegradedError                    | 1        | —                          | event_store.degraded                                                              | P3     |
| `agent-daemon/src/session-metadata-store.ts`                            | SessionMetadataStoreError        | 1        | —                          | store.write_failed                                                                | P3     |
| `agent-daemon/src/handlers/run-handlers/lifecycle/admission-control.ts` | DaemonRunPreflightError          | 2        | —                          | runtime.transition_failed                                                         | P3     |
| `agent-runtime/src/openai-stream-parse.ts`                              | MalformedSseFrameError           | 1        | —                          | provider.stream_interrupted                                                       | P3     |
| `agent-runtime/src/mcp-lifecycle/types.ts`                              | McpLifecycleError                | 3        | —                          | mcp.connection_failed                                                             | P3     |
| `agent-runtime/src/plan-document/types.ts`                              | PlanDocumentValidationError      | 1        | —                          | tool.invalid_input                                                                | P3     |
| `agent-runtime/src/plan-document/types.ts`                              | PlanDocumentPatchError           | 5        | —                          | tool.invalid_input/tool.version_conflict                                          | P3     |
| `agent-runtime/src/path-handling/conex-path.ts`                         | ConexPathError                   | 1        | —                          | tool.path_escape                                                                  | P3     |
| `agent-runtime/src/provider-gateway/types.ts`                           | ProviderGatewayError             | 6        | —                          | provider.endpoint_unavailable/security.ssrf_rejected/config.missing               | P3     |
| `agent-runtime/src/resource-uri.ts`                                     | ResourceUriParseError            | 8        | —                          | artifact.invalid_uri                                                              | P3     |
| `agent-runtime/src/resource-uri.ts`                                     | ResourceUnsupportedError         | 5        | —                          | common.unsupported                                                                | P3     |
| `agent-runtime/src/resource-uri.ts`                                     | ResourceNotFoundError            | 1        | —                          | artifact.not_found                                                                | P3     |
| `agent-runtime/src/resource-uri.ts`                                     | ResourceIntegrityError           | 2        | —                          | artifact.invalid_uri                                                              | P3     |
| `agent-runtime/src/provider/auth/oauth/state-machine.ts`                | OAuthStateError                  | 5        | —                          | provider.no_token/provider.reauth_required/provider.fatal/provider.refresh_failed | P3     |
| `agent-runtime/src/provider/auth/oauth/state-machine.ts`                | OAuthDeadlockError               | 1        | —                          | subagent.deadlock_detected                                                        | P3     |
| `agent-runtime/src/provider-transport/stream-recovery.ts`               | StreamRecoveryError              | 8        | —                          | provider.stream_interrupted                                                       | P3     |
| `agent-runtime/src/provider-transport/connection-manager.ts`            | ConnectionError                  | 1        | —                          | provider.connection_error                                                         | P3     |
| `agent-runtime/src/provider-transport/connection-manager.ts`            | StreamInterruptedError           | 2        | —                          | provider.stream_interrupted                                                       | P3     |
| `agent-runtime/src/session-store/types.ts`                              | StoreCapacityError               | 4        | —                          | store.capacity_exceeded                                                           | P3     |
| `agent-runtime/src/workspace-mutation-coordinator.ts`                   | WorkspaceMutationLeaseError      | 1        | —                          | runtime.transition_failed                                                         | P3     |

### 4.3 迁移优先级排序（按包）

| 包                   | throw new Error | throw Crish* | 合计    | 迁移 Round | 说明                                                                                            |
| -------------------- | --------------- | ------------ | ------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `agent-runtime`      | 140             | 105          | 245     | R3-R5      | 拆分到 agent-tools/model/core/context/mcp 后逐子包迁移；含 18 个新增 Error 子类（§3.5 #12-#29） |
| `agent-orchestrator` | 8               | 20           | 28      | R6         | 随编排层重构迁移；含 BlobIntegrityError、OrchestratorEventStoreError（§3.5 #2-#3）              |
| `agent-daemon`       | 23              | 16           | 39      | R7         | 随 Daemon 重构迁移；含 11 个新增 Error 子类（§3.5 #1, #4-#11）                                  |
| `shared-utils`       | 4               | 0            | 4       | R2         | 随 @crish/logger 创建迁移                                                                       |
| `shared-types`       | 1               | 0            | 1       | R1         | typed-invoke.ts 单点迁移                                                                        |
| `decision-engine`    | 1               | 0            | 1       | R3         | config-merger 单点迁移                                                                          |
| **合计**             | **177**         | **141**      | **318** | R1-R11     | 三阶段策略，每包迁移后通过测试验证。数字与 §0.2 基线一致                                        |

> 测试文件 throw（73 处 `throw new Error` / 35 文件 + 若干 `throw Crish*`）不计入迁移追踪，由各包测试迁移时顺带处理。

---

## 5. CrishResult 使用策略

### 5.1 何时用 CrishResult vs throw

| 场景                                                        | 模式                                                        | 理由                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| **公共 API 边界**（包导出函数、Tauri command、IPC handler） | `CrishResult<T>` 返回                                       | 调用方需显式处理失败，避免未捕获异常；跨包/跨进程边界必须可序列化 |
| **Provider 流式接口**（`AgentProvider.stream()`）           | `AsyncIterable<ProviderStreamEvent>` + `CrishResult` 首事件 | 流式数据不能用 Result 包裹，但首事件（成功/失败）用 Result        |
| **状态机转移**（`ConexStateMachine.send()`）                | `CrishResult<StateMachineSnapshot>`                         | 转移失败是预期分支，非异常                                        |
| **工具执行**（`Tool.execute()`）                            | `CrishResult<ToolResult>`                                   | 工具失败是预期分支，调用方需按码决定重试/降级                     |
| **审批决策**（`ApprovalPipeline.evaluate()`）               | `CrishResult<Decision>`                                     | 决策失败（超时/拒绝）是预期分支                                   |
| **内部辅助函数**（私有校验、纯函数转换）                    | `throw new CrishError(...)`                                 | 内部函数用异常更简洁，由公共 API 边界 catch 并转 Result           |
| **入参校验**（`assertXxx` 系列）                            | `throw new CrishError(...)`                                 | 校验失败是编程错误，异常更符合直觉                                |
| **不可恢复错误**（不变量违反、内存溢出）                    | `throw new Error(...)`                                      | 这类错误不应被捕获，进程应崩溃                                    |

**判定规则**：函数是否是**包的公共导出 API**？是 → 返回 `CrishResult`；否 → 用 `throw`。例外：流式接口用事件流 + 首事件 Result。

### 5.2 CrishResult 工具函数签名

> 在 `shared-types/src/result.ts` 实现（Round 1）。`recovery-pipeline.ts` 的 `PipelineResult` ADT 将在迁移阶段统一为 `CrishResult`。

```ts
// shared-types/src/result.ts （Round 1 实现）
export type CrishResult<T, E extends CrishError = CrishError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ── 构造 ──
export function ok<T>(value: T): CrishResult<T, never>;
export function err<E extends CrishError>(error: E): CrishResult<never, E>;

// ── 提取 ──
export function getOrThrow<T, E extends CrishError>(
  result: CrishResult<T, E>
): T;
export function unwrapOr<T, E extends CrishError>(
  result: CrishResult<T, E>,
  fallback: T
): T;

// ── 转换 ──
export function mapResult<T, U, E extends CrishError>(
  result: CrishResult<T, E>,
  fn: (value: T) => U
): CrishResult<U, E>;
export function flatMapResult<
  T,
  U,
  E extends CrishError,
  E2 extends CrishError,
>(
  result: CrishResult<T, E>,
  fn: (value: T) => CrishResult<U, E2>
): CrishResult<U, E | E2>;

// ── 模式匹配 ──
export function match<T, U, E extends CrishError>(
  result: CrishResult<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U }
): U;

// ── 守卫 ──
export function isOk<T, E extends CrishError>(
  result: CrishResult<T, E>
): result is { ok: true; value: T };
export function isErr<T, E extends CrishError>(
  result: CrishResult<T, E>
): result is { ok: false; error: E };

// ── Promise 互转 ──
export function fromPromise<T>(
  promise: Promise<T>
): Promise<CrishResult<T, CrishError>>;
export function promiseResult<T, E extends CrishError>(
  result: CrishResult<T, E>
): Promise<T>;
```

**设计约束**：

- `CrishResult` 是**不可变判别联合**（`readonly` 字段），避免误改。
- `ok`/`err` 构造函数对 `never` 类型参数友好，支持 `ok(42)` 推断为 `CrishResult<number, never>`。
- `fromPromise` 捕获所有 rejected promise 并包装为 `CrishError`（未知错误用 `common.unknown`）。
- `promiseResult` 反向操作：`ok` 解包为 resolved，`err` 转为 rejected（用于必须 throw 的边界，如 React 事件处理器）。

**与 `PipelineResult` 的统一**：`recovery-pipeline.ts` 现有的 `PipelineResult`（L30-32）迁移为：

```ts
// 迁移后
type StreamResult = CrishResult<
  AsyncIterable<ProviderStreamEvent>,
  CrishError
> & { tierUsed?: 1 | 2 | 3 };
```

`tierUsed` 作为扩展字段保留，不破坏 Result ADT 主结构。

---

## 6. CrishErrorPayload 跨进程序列化

### 6.1 TypeScript 端 CrishErrorPayload 接口

> 在 `shared-types/src/error-payload.ts` 实现（Round 1）。递归 `cause` 最多 8 层，防止无限递归。

```ts
// shared-types/src/error-payload.ts （Round 1 实现）
import type { CrishErrorCode, CrishErrorCategory } from './error-codes';
import type { JsonObject } from './primitive-types';

/** 跨进程序列化的错误负载（TS ↔ Rust ↔ 前端） */
export interface CrishErrorPayload {
  /** 错误码，domain.reason 格式 */
  readonly code: CrishErrorCode;
  /** 人类可读消息（已本地化） */
  readonly message: string;
  /** 故障类别 */
  readonly category: CrishErrorCategory;
  /** 是否可重试 */
  readonly retryable: boolean;
  /** 是否用户可见 */
  readonly public: boolean;
  /** 用户操作建议（i18n 键） */
  readonly action: string;
  /** 结构化元数据 */
  readonly metadata?: JsonObject;
  /** 递归因果链，最多 8 层 */
  readonly cause?: CrishErrorPayload;
  /** 调用栈（仅开发环境，生产环境置空） */
  readonly stack?: string;
  /** 时间戳（epoch ms） */
  readonly timestamp: number;
}

/** 递归深度上限 */
export const CRISH_ERROR_CAUSE_MAX_DEPTH = 8;

/** 从 CrishError 构造 Payload，自动截断 cause 链到 8 层 */
export function toErrorPayload(
  error: CrishError,
  depth = 0
): CrishErrorPayload {
  if (depth >= CRISH_ERROR_CAUSE_MAX_DEPTH) {
    return truncatedPayload(error);
  }
  return {
    code: error.code as CrishErrorCode,
    message: error.message,
    category: error.category,
    retryable: error.retryable,
    public: getErrorInfo(error.code as CrishErrorCode).public,
    action: getErrorInfo(error.code as CrishErrorCode).action,
    ...(error.metadata !== undefined ? { metadata: error.metadata } : {}),
    ...(error.cause instanceof CrishError
      ? { cause: toErrorPayload(error.cause, depth + 1) }
      : {}),
    ...(process.env.NODE_ENV !== 'production' ? { stack: error.stack } : {}),
    timestamp: Date.now(),
  };
}

/** 从未知错误构造 Payload（兜底） */
export function fromUnknownError(error: unknown): CrishErrorPayload {
  if (error instanceof CrishError) return toErrorPayload(error);
  return {
    code: 'common.unknown',
    message: error instanceof Error ? error.message : String(error),
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.common.report_bug',
    ...(error instanceof Error ? { stack: error.stack } : {}),
    timestamp: Date.now(),
  };
}
```

**设计要点**：

1. **CrishError 扩展 `cause` 字段**：现有 `CrishError` 构造函数未保留 `cause`，需在 Round 1 扩展（向后兼容，新增可选参数）。Error.cause（ES2022）原生支持，但显式存为 `CrishError` 类型以便递归序列化。
2. **递归截断**：`depth >= 8` 时返回 `truncatedPayload`（code=`common.unknown`，message=`"cause chain truncated at depth N"`）。
3. **生产环境安全**：`stack` 仅在非 production 环境序列化，避免泄漏路径。
4. **`CrishRestError` 死代码修正**：扫描确认 `CrishRestError` 类在当前代码库中**不存在**（仅出现在 `analysis/plan-01-error-handling-observability.md` 规划文档中）。规划文档描述的 `toErrorPayloadFromStatus` 死代码（最后两个 if 分支相同）不会带入新设计——HTTP 状态码到 `CrishErrorCode` 的映射使用**单一静态映射表**（`HTTP_STATUS_TO_CODE: Record<number, CrishErrorCode>`），无 if-else 分支链，从结构上消除死代码可能。

```ts
// 静态映射表替代 if-else 分支（避免 CrishRestError 死代码模式）
const HTTP_STATUS_TO_CODE: Readonly<Record<number, CrishErrorCode>> = {
  400: 'provider.schema',
  401: 'provider.auth',
  402: 'provider.quota',
  403: 'provider.auth',
  404: 'provider.endpoint_unavailable',
  405: 'provider.endpoint_unavailable',
  413: 'provider.schema',
  415: 'provider.endpoint_unavailable',
  422: 'provider.schema',
  429: 'provider.rate_limit',
  500: 'provider.server',
  502: 'provider.server',
  503: 'provider.server',
  504: 'provider.server',
  520: 'provider.server',
  522: 'provider.server',
  523: 'provider.server',
  524: 'provider.server',
};

export function codeFromHttpStatus(status: number): CrishErrorCode {
  return HTTP_STATUS_TO_CODE[status] ?? 'common.unknown';
}
```

### 6.2 Rust 端 CrishError 对齐

> 在 `crates/conex-types/src/lib.rs` 实现（Round 10）。与 TS 端 `CrishErrorPayload` 字段一一对应。

```rust
// crates/conex-types/src/lib.rs （Round 10 实现）
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrishErrorPayload {
    pub code: String,           // CrishErrorCode as string
    pub message: String,
    pub category: String,       // "transient" | "permanent" | "security" | "protocol"
    pub retryable: bool,
    #[serde(rename = "public")]
    pub is_public: bool,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<CrishErrorPayload>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    pub timestamp: i64,
}

impl CrishErrorPayload {
    pub fn from_core_error(err: &CoreError) -> Self {
        // CoreError → CrishErrorPayload 映射（见 §3.6）
        match err {
            CoreError::InvalidInput(msg) => Self {
                code: "common.unsupported".into(),
                message: msg.clone(),
                category: "permanent".into(),
                retryable: false,
                is_public: true,
                action: "action.common.check_version".into(),
                metadata: None, cause: None, stack: None,
                timestamp: chrono::Utc::now().timestamp_millis(),
            },
            CoreError::Cancelled => Self {
                code: "runtime.aborted".into(),
                message: "cancelled".into(),
                // ... 其余字段
                ..Default::default()
            },
            // ... 其余 variant
        }
    }
}

// 保留旧 CoreError 的兼容转换（共存阶段）
impl From<CoreError> for CrishErrorPayload {
    fn from(err: CoreError) -> Self { Self::from_core_error(&err) }
}
```

**递归深度约束**：Rust 端在 `from_core_error` 递归构造 `cause` 时同样限制 8 层，超出则 `cause: None` + `metadata.truncated = true`。

### 6.3 IpcResponse.error 字段迁移

| 阶段                   | IpcResponse.error 类型      | 说明                                                                                                                                                 |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **现状**               | `Option<String>`            | 裸字符串，丢失结构化信息                                                                                                                             |
| **共存阶段**（R10）    | `Option<serde_json::Value>` | 同时接受旧 `String` 与新 `CrishErrorPayload` 对象。反序列化时先尝试 `CrishErrorPayload`，失败则回退为 `{"code":"common.unknown","message":<string>}` |
| **删除阶段**（R12 后） | `Option<CrishErrorPayload>` | 强类型，前端按 `code` 分域处理                                                                                                                       |

```rust
// 共存阶段（R10）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IpcResponse {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,  // String 或 CrishErrorPayload
}
```

**Tauri command 错误传播**：Tauri command 返回 `Result<T, CrishErrorPayload>`，Tauri 自动序列化为 `IpcResponse.error`。前端 `invoke()` catch 后用 `fromErrorPayload()` 还原为 `CrishError` 实例。

---

## 7. 迁移三阶段计划

> 严格遵循 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 23 三阶段策略与禁令 25 错误码迁移约束。

### 7.1 共存阶段（Round 1）

**目标**：新类型与旧类型并存，零破坏。

| 交付物                                                         | 文件                                    | 说明                                                                           |
| -------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `CrishErrorCode` 联合类型 + 注册表                             | `shared-types/src/error-codes.ts`       | §2.3                                                                           |
| `CrishError` 扩展（新增 `cause`/`public`/`action`）            | `shared-types/src/errors.ts`            | 保留旧 `code: string` 字段，新增 `CrishErrorCode` 类型别名；旧构造函数签名不变 |
| `CrishResult` ADT + 9 工具函数                                 | `shared-types/src/result.ts`            | §5.2                                                                           |
| `CrishErrorPayload` 接口 + `toErrorPayload`/`fromUnknownError` | `shared-types/src/error-payload.ts`     | §6.1                                                                           |
| `migrateErrorCode()` 函数                                      | `shared-types/src/error-migration.ts`   | 旧码→新码映射（§3.1/3.3/3.4/3.5）                                              |
| `codeFromHttpStatus()` 静态映射                                | `shared-types/src/error-payload.ts`     | §6.1，替代 if-else 分支                                                        |
| `ClassifiedError.toCrishErrorCode()`                           | `agent-runtime/src/error-classifier.ts` | 新增方法，不破坏现有 `classify()`                                              |
| 旧类型标记 `@deprecated`                                       | `shared-types/src/errors.ts`            | `SessionErrorCode`/`ProviderErrorKind` 加 JSDoc `@deprecated`，但不删除        |

**约束**：

- 旧 `throw new CrishError(msg, "TOOL_ERROR", ...)` 继续工作（`code` 字段仍接受任意 string）。
- 新 `throw new CrishError(msg, "tool.path_escape", ...)` 也工作（`code` 字段接受 `CrishErrorCode`）。
- `migrateErrorCode("TOOL_ERROR")` 返回 `tool.execution_failed`（默认映射，调用方可按上下文覆盖为 `tool.path_escape` 等）。

### 7.2 迁移阶段（Round 3-11，按包）

**每个包的迁移流程**（严格遵守 禁令 25"禁止一次性全局替换"）：

```
包 X 迁移开始
  ├── 1. 识别该包所有 throw 点（参考 §4.1/4.2）
  ├── 2. 逐文件替换 throw new Error → throw new CrishError(code, ...)
  ├── 3. 逐文件替换 throw new CrishError(旧码) → throw new CrishError(新码)
  ├── 4. 公共 API 边界函数改为返回 CrishResult
  ├── 5. 运行该包单元测试，确保通过
  ├── 6. 运行 TSC，确保错误数 ≤ 基线
  └── 7. 提交验证门禁（8 项检查）
```

| Round | 包                                                | 迁移 throw 数 | 关键迁移项                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3    | agent-context, agent-permissions, agent-mcp[骨架] | ~15           | 路径校验 throw → `tool.path_escape`；权限 throw → `plugin.permission_denied`                                                                                                                                                                                                                       |
| R4    | agent-tools, agent-model, agent-mcp[完整]         | ~120          | **P0 热点**：fs-edit-tools（35 throw）、Provider 系统（~40 throw）；`TOOL_ERROR` 拆分为 4 码；`CONFIG_ERROR`→`config.invalid`                                                                                                                                                                      |
| R5    | agent-core, agent-subagent[骨架]                  | ~50           | 状态机 throw → `runtime.*`；session-storage/session-replay throw → `session.*`；`PipelineResult`→`CrishResult`                                                                                                                                                                                     |
| R6    | agent-orchestrator                                | ~28           | `SessionError` 5 码→`session.*`；`INVALID_RUN_STATE`→`run.invalid_state`；`NOT_A_GOAL_RUN`→`run.not_goal_run`；`ARTIFACT_ERROR`→`artifact.*`；`BlobIntegrityError`→`artifact.invalid_uri`；`OrchestratorEventStoreError`→`event_store.*`                                                           |
| R7    | agent-daemon                                      | ~39           | `ADAPTER_ERROR`→`artifact.*/store.corrupted`；`SCOPED_CONTEXT_ERROR`→`store.corrupted`；`DAEMON_ERROR`→`network.*`；§3.5 #1,#4-#11 子类：`DaemonConversationRewindError`→`session.rewind_failed`、`DaemonRunPreflightError`→`runtime.transition_failed`、`DegradedError`→`event_store.degraded` 等 |
| R8    | plugin-sdk                                        | ~5            | 插件 throw → `plugin.*`                                                                                                                                                                                                                                                                            |
| R9    | agent-subagent[完整]                              | ~3            | 子代理 throw → `subagent.*`                                                                                                                                                                                                                                                                        |
| R10   | Rust crates                                       | —             | `CoreError`→`CrishErrorPayload`（§3.6）；`IpcError`→`CrishErrorCode`（§3.7）；`MarkdownError`→`CrishErrorCode`（§3.8）；`StreamError`→`CrishErrorCode`（§3.9）；`NetError`→`CrishErrorCode`（§3.10）；`conex-fs` anyhow 边界转换（§3.11）；`IpcResponse.error: Option<String>`→`Option<Value>`     |
| R11   | crish-desktop                                     | —             | 前端错误翻译层；TSC < 50                                                                                                                                                                                                                                                                           |

### 7.3 删除阶段（Round 12）

**前置条件**：所有包完成迁移，`throw new Error` 在源码文件中归零（测试文件允许残留，作为后续独立任务），旧码无引用。

| 删除项                              | 文件                                    | 验证                                                   |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------ |
| `SessionErrorCode` 类型             | `shared-types/src/errors.ts`            | grep 无引用                                            |
| `ProviderErrorKind` 类型            | `shared-types/src/tool.ts`              | grep 无引用                                            |
| `ErrorDomain` 枚举                  | `agent-runtime/src/error-classifier.ts` | `ErrorClassifier` 改为直接输出 `CrishErrorCode`        |
| `legacyKind` 字段                   | `error-classifier.ts` `ClassifiedError` | 字段移除                                               |
| `PipelineResult` 旧 ADT             | `recovery-pipeline.ts`                  | 统一为 `CrishResult`                                   |
| `CoreError` 枚举                    | `crates/conex-types/src/lib.rs`         | 改为 `CrishErrorPayload`                               |
| `IpcError` 枚举                     | `crates/conex-ipc`                      | 改为 `CrishErrorPayload`（§3.7）                       |
| `MarkdownError` 枚举                | `crates/conex-markdown`                 | 改为 `CrishErrorPayload`（§3.8）                       |
| `StreamError` 枚举                  | `crates/conex-stream`                   | 改为 `CrishErrorPayload`（§3.9）                       |
| `NetError` 枚举                     | `crates/conex-net`                      | 改为 `CrishErrorPayload`（§3.10）                      |
| `IpcResponse.error: Option<String>` | `crates/conex-types/src/lib.rs`         | 改为 `Option<CrishErrorPayload>`                       |
| `formatProviderError(error, kind)`  | `provider-openai-base.ts`               | 改为 `formatProviderError(error, code)`                |
| 31 个自定义 Error 子类（§3.5）      | 各来源文件                              | grep 无 `throw new DaemonBackgroundTaskError` 等子类名 |
| `migrateErrorCode()` 函数           | `shared-types/src/error-migration.ts`   | 迁移完成后无调用方即可删除                             |
| `@deprecated` 标记                  | 各文件                                  | 随类型删除一并清理                                     |

**CI 门禁**（Round 12 新增）：

- `npm run lint:depcruise` 规则：禁止 import `SessionErrorCode`/`ProviderErrorKind`/`ErrorDomain`/`CoreError`/`IpcError`/`MarkdownError`/`StreamError`/`NetError`
- grep 检查：源码中 `throw new Error(` 数量 ≤ 10（仅保留不可恢复错误）
- grep 检查：源码中无旧码字符串（`TOOL_ERROR`/`CONFIG_ERROR`/`CHECKPOINT_ERROR` 等）
- grep 检查：源码中无 31 个自定义 Error 子类的 throw（`throw new DaemonConversationRewindError` 等）

---

## 附录 A：CrishError 扩展后的完整构造函数

```ts
// shared-types/src/errors.ts （Round 1 共存阶段）
export class CrishError extends Error {
  readonly code: CrishErrorCode | string; // 共存：接受新码或旧 string
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly metadata?: JsonObject | undefined;
  readonly cause?: CrishError | undefined;

  constructor(
    message: string,
    code: CrishErrorCode | string,
    category: CrishErrorCategory,
    retryable: boolean,
    metadata?: JsonObject,
    options?: { cause?: CrishError; public?: boolean; action?: string }
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.metadata = metadata;
    this.cause = options?.cause;
    const info =
      typeof code === 'string' && CRISH_ERROR_REGISTRY.hasOwnProperty(code)
        ? CRISH_ERROR_REGISTRY[code as CrishErrorCode]
        : CRISH_ERROR_REGISTRY['common.unknown'];
    this.public = options?.public ?? info.public;
    this.action = options?.action ?? info.action;
    this.name = 'CrishError';
  }
}
```

**向后兼容**：旧调用 `new CrishError(msg, "TOOL_ERROR", "permanent", false)` 继续工作（`options` 缺省，`public`/`action` 从注册表回退到 `common.unknown`）。

## 附录 B：migrateErrorCode() 函数签名

```ts
// shared-types/src/error-migration.ts （Round 1 实现）
export function migrateErrorCode(
  legacyCode: string,
  context?: {
    kind?: 'path' | 'input' | 'not_found' | 'execution';
    subType?: string;
  }
): CrishErrorCode {
  // SessionErrorCode
  switch (legacyCode) {
    case 'not_found':
      return 'session.not_found';
    case 'invalid_session':
      return 'session.invalid_session';
    case 'invalid_entry':
      return 'session.invalid_entry';
    case 'invalid_state':
      return 'session.invalid_state';
    case 'storage':
      return 'session.storage_failed';
  }
  // ProviderErrorKind
  switch (legacyCode) {
    case 'network':
      return 'provider.network';
    case 'gateway-challenge':
      return 'provider.gateway_challenge';
    case 'rate-limit':
      return 'provider.rate_limit';
    case 'auth':
      return 'provider.auth';
    case 'quota':
      return 'provider.quota';
    case 'endpoint-unavailable':
      return 'provider.endpoint_unavailable';
    case 'schema':
      return 'provider.schema';
    case 'server':
      return 'provider.server';
    case 'timeout':
      return 'provider.timeout';
    case 'cancelled':
      return 'provider.cancelled';
    case 'invalid-stream':
      return 'provider.stream_interrupted';
    case 'unknown':
      return 'provider.unknown';
  }
  // 自由字符串码
  switch (legacyCode) {
    case 'CONFIG_ERROR':
      return 'config.invalid';
    case 'CHECKPOINT_ERROR':
      return 'store.corrupted';
    case 'BOUNDARY_ERROR':
      return 'store.corrupted';
    case 'ARTIFACT_ERROR':
      return context?.kind === 'not_found'
        ? 'artifact.not_found'
        : 'artifact.invalid_uri';
    case 'ADAPTER_ERROR':
      return context?.kind === 'not_found'
        ? 'artifact.not_found'
        : 'store.corrupted';
    case 'SCOPED_CONTEXT_ERROR':
      return 'store.corrupted';
    case 'DAEMON_DEAD':
      return 'network.daemon_dead';
    case 'NETWORK_ERROR':
      return 'provider.network';
    case 'INVALID_RUN_STATE':
      return 'run.invalid_state';
    case 'NOT_A_GOAL_RUN':
      return 'run.not_goal_run';
    case 'LEAF_MISMATCH':
      return 'session.invalid_state';
    case 'DAEMON_ERROR':
      return 'network.daemon_dead';
  }
  // 31 个自定义 Error 子类名 → CrishErrorCode（§3.5）
  switch (legacyCode) {
    case 'DaemonBackgroundTaskError':
      return context?.kind === 'not_found'
        ? 'tool.not_found'
        : 'tool.execution_failed';
    case 'OrchestratorEventStoreError':
      return context?.kind === 'read'
        ? 'event_store.read_failed'
        : 'event_store.append_failed';
    case 'BlobIntegrityError':
      return 'artifact.invalid_uri';
    case 'DaemonWorkflowNotFoundError':
      return 'run.not_found';
    case 'DaemonConversationRewindError':
      return 'session.rewind_failed';
    case 'PlanDocumentStoreError':
      return 'store.write_failed';
    case 'DaemonUnsupportedCapabilityError':
      return 'common.unsupported';
    case 'DegradedError':
      return 'event_store.degraded';
    case 'SessionMetadataStoreError':
      return 'store.write_failed';
    case 'DaemonRunPreflightError':
      return 'runtime.transition_failed';
    case 'WorkflowStoreError':
      return 'store.write_failed';
    case 'GitCommandError':
      return 'tool.execution_failed';
    case 'MalformedSseFrameError':
      return 'provider.stream_interrupted';
    case 'McpLifecycleError':
      return 'mcp.connection_failed';
    case 'PlanDocumentValidationError':
      return 'tool.invalid_input';
    case 'PlanDocumentPatchError':
      return context?.subType === 'version_mismatch'
        ? 'tool.version_conflict'
        : 'tool.invalid_input';
    case 'ConexPathError':
      return 'tool.path_escape';
    case 'ResourceUriParseError':
      return 'artifact.invalid_uri';
    case 'ResourceUnsupportedError':
      return 'common.unsupported';
    case 'ResourceNotFoundError':
      return 'artifact.not_found';
    case 'ResourceIntegrityError':
      return 'artifact.invalid_uri';
    case 'OAuthDeadlockError':
      return 'subagent.deadlock_detected';
    case 'StreamRecoveryError':
      return 'provider.stream_interrupted';
    case 'ConnectionError':
      return 'provider.connection_error';
    case 'StreamInterruptedError':
      return 'provider.stream_interrupted';
    case 'StoreCapacityError':
      return 'store.capacity_exceeded';
    case 'WorkspaceMutationLeaseError':
      return 'runtime.transition_failed';
    // ProviderGatewayError subCode（通过 context.subType 传入）
    case 'ProviderGatewayError':
      switch (context?.subType) {
        case 'route_not_found':
          return 'provider.endpoint_unavailable';
        case 'ssrf_rejected':
          return 'security.ssrf_rejected';
        case 'provider_credential_missing':
          return 'config.missing';
        default:
          return 'provider.unknown';
      }
    // OAuthStateError state（通过 context.subType 传入）
    case 'OAuthStateError':
      switch (context?.subType) {
        case 'NO_TOKEN':
          return 'provider.no_token';
        case 'REAUTH_REQUIRED':
          return 'provider.reauth_required';
        case 'FATAL_ERROR':
          return 'provider.fatal';
        case 'REFRESH_FAILED':
          return 'provider.refresh_failed';
        default:
          return 'provider.auth';
      }
  }
  // TOOL_ERROR 按 context 拆分
  if (legacyCode === 'TOOL_ERROR') {
    switch (context?.kind) {
      case 'path':
        return 'tool.path_escape';
      case 'input':
        return 'tool.invalid_input';
      case 'not_found':
        return 'tool.not_found';
      case 'execution':
        return 'tool.execution_failed';
      default:
        return 'tool.execution_failed'; // 默认
    }
  }
  // ErrorDomain（直接传入枚举值）
  switch (legacyCode) {
    case 'USER_ABORT':
      return 'runtime.aborted';
    case 'TRANSIENT_NETWORK':
      return 'provider.network';
    case 'TRANSIENT_SERVER':
      return 'provider.server';
    case 'RATE_LIMIT':
      return 'provider.rate_limit';
    case 'CLIENT_AUTH':
      return 'provider.auth';
    case 'CLIENT_INVALID_INPUT':
      return context?.subType === 'context_length_exceeded'
        ? 'context.length_exceeded'
        : 'provider.schema';
    case 'QUOTA_EXHAUSTED':
      return 'provider.quota';
    case 'STREAM_INTERRUPT':
      return 'provider.stream_interrupted';
    case 'ENDPOINT_UNAVAILABLE':
      return 'provider.endpoint_unavailable';
    case 'GATEWAY_CHALLENGE':
      return 'provider.gateway_challenge';
    case 'UNKNOWN':
      return 'common.unknown';
  }
  return 'common.unknown';
}
```

## 附录 C：CrishError 子类迁移

| 旧子类                         | 迁移后                            | 说明                                                                                |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------- |
| `ProviderError`                | 保留，`category` 固定 `transient` | 构造函数改为接受 `CrishErrorCode`（provider.* 域）                                  |
| `PermissionError`              | 保留，`category` 固定 `security`  | 用于 `plugin.permission_denied`/`tool.path_escape`                                  |
| `SessionError`                 | **删除阶段移除**                  | 共存阶段保留，迁移阶段用 `CrishError(code="session.*")` 替代                        |
| `ProtocolError`                | **删除阶段移除**                  | 共存阶段保留，迁移阶段用 `CrishError(code="*.invalid_*", category="protocol")` 替代 |
| 31 个自定义 Error 子类（§3.5） | **删除阶段移除**                  | 共存阶段保留，迁移阶段用 `CrishError(code=<对应新码>)` 替代。完整映射见 §3.5        |

---

## 变更记录

| 版本 | 日期       | 变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-07-30 | 初版，基于代码扫描生成 60 码体系与完整迁移映射                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| v2.0 | 2026-07-30 | 系统化修复：(1) 修正 §0.2/§4.2/§4.3 三处矛盾的基线数据（throw new CrishError 31→82 处/3→11 文件，throw new Error 168→177 处/67→61 文件，Crish* 合计 114→141 处）；(2) 补全 31 个未覆盖 Error 子类的映射（§3.5，含 ProviderGatewayError 3 子码 + OAuthStateError 4 子码）；(3) 新增 13 个正式码（security 域 1 码、provider 域 +5 码、session/store/event_store/tool/common/runtime 各 +1 码）；(4) 补全 Rust 端映射（§3.7-§3.11，IpcError/MarkdownError/StreamError/NetError/conex-fs）；(5) 12 个无场景码降级为 reserved（10 个保留 reserved，2 个升级为正式码：runtime.transition_failed、subagent.deadlock_detected）；(6) 码数从 60 扩展到 64 正式码 + 10 reserved 码 / 19 域 |
