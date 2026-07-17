# 可观测性与会话加载设计

日期：2026-06-09

范围：对话流诊断、命令/工具性能、daemon/sidecar 错误日志、会话列表首屏、消息详情懒加载、后台预加载。

## 目标

Crish 需要让长程 agent 工作可解释、可恢复、可调优。用户不应该看到空白列表却不知道是“没有数据”“还在加载”“daemon 断了”还是“协议错误”。开发者和主 agent 也应该能按 session/run/request/tool 查询每条对话流的错误、耗时、重连、吞吐和缓存命中情况。

## 现有基础

- runtime 已有 `RuntimeMetricsCollector`，覆盖工具调用数、错误率、timeout/cancel、p50/p95/p99、provider token、cache tokens、streaming 指标、trace/span/error summary。
- daemon 已有 `FileMetricsStore`，能以 JSONL 方式恢复并查询 run/session/global metrics。
- orchestrator event store 已有 event log identity、generation、cursor、session summaries 和按 session/run 的分页事件读取。
- sidecar 已有 disconnect/reconnect/pending query 诊断和 bounded recent diagnostics。

这些能力应继续收敛，不要再添加一套 Workbench-only metrics 或本地推断日志。

## 观测对象

| 对象 | 主键 | 内容 | 持久策略 |
| --- | --- | --- | --- |
| session index | sessionId | 标题、预览、置顶、归档、活跃 run、错误/降级标记、lastSequence | daemon materialized index |
| run metrics | runId/sessionId | 生命周期、provider、tool、cache、streaming、trace/error | daemon metrics JSONL |
| sidecar diagnostics | requestId/runId/sessionId | query/stream send、重连、pending rejection、payload bytes、duration | bounded recent + optional export |
| provider stream | runId/requestId/routeId | endpoint、first byte、first token、idle timeout、invalid-stream、fallback | runtime event + metrics |
| tool command | toolCallId/runId | toolName、duration、bytes、exit/cancel/timeout、risk/checkpoint facts | runtime event + metrics |
| event replay | sessionId/runId/cursor | requested cursor、log identity、fetched/applied/deduped、queryMs | response diagnostics |

## 用户体验状态

会话列表和消息详情必须区分以下状态：

- `loading`：正在加载，显示骨架或轻量占位。
- `empty`：后端明确返回无数据。
- `stale`：已有缓存，正在后台刷新。
- `degraded`：daemon/metrics/event store 有降级诊断。
- `disconnected`：sidecar 或 daemon WebSocket 断开，显示可恢复状态。
- `protocol-error`：schema/cursor 不匹配，需要重放或刷新。
- `backend-not-wired` / `unsupported`：能力未接线或不支持。

不要用空数组同时表示这些状态。

## 会话加载分层

首屏加载：

1. Workbench 本地配置和当前 workspace。
2. daemon status/capabilities/provider readiness。
3. session summaries：轻量列表、pinned/archived/deleted metadata、preview、lastUpdated、activeRunCount、degraded flags。
4. 当前选中 session 的 message window。
5. 当前 run snapshot、approval queue、最近 diagnostics。

后台预加载优先级：

1. 活跃 run。
2. 当前选中 session。
3. pinned session。
4. 最近更新 session。
5. 当前 workspace 下的 session。
6. failed/degraded session。
7. 搜索命中的 session。

预加载必须有预算：最大并发、最大事件数、最大内存、idle deadline。超过预算时只保留 summary，不拉详情。

## 消息详情窗口

消息详情不应一次性读取整段历史：

- 默认读取可见窗口和最近上下文。
- 向上滚动时用 cursor 拉更早事件。
- 活跃 run 用 live stream + replay cursor 合并。
- replay 和 live 共享同一个 projector/reducer。
- cursor key 必须包含 eventLogId/generation/schemaVersion，日志重建后强制重放。

## 诊断查询入口

后端应该提供统一查询语义：

- `get-metrics`：按 run/session/global 查询 metrics summary。
- `read-run-events` / `read-session-events`：携带 replay diagnostics。
- sidecar status：最近查询、stream、disconnect、reconnect、pending rejection。
- provider status：endpoint、stream、credentialMode、route health、cache tokens。

Workbench 诊断面板按“用户能处理什么”排序：

1. daemon 连接和 provider 配置。
2. 当前 run 的错误/卡顿原因。
3. 工具和命令耗时。
4. event replay/cursor 状态。
5. 低层 sidecar/transport 原始信息。

## 性能指标

核心指标：

- daemon ready time。
- WebSocket connect time。
- `get-status` RTT。
- session list first paint。
- selected session first message paint。
- first provider byte / first text delta。
- stream events per second。
- tool p50/p95/p99。
- provider request p50/p95/p99。
- cache read/write tokens。
- reconnect recovery time。
- event replay queryMs / fetched / returned / deduped。

这些指标要按 providerId、routeId、model label、sessionId、runId、stablePrefixHash 聚合，但不要把模型名当能力真相。

## 隐私和体积

- metrics 只保存摘要、hash、bytes、key list 和 redacted error，不保存完整 prompt、API key、工具大输出。
- 大输出进入 artifact/blob store，metrics 只记录 URI/hash/size。
- sidecar payload 只记录 byte size 和 command/message type，不记录敏感内容。
- error message 做长度上限，stack 仅开发模式或显式导出。

## 落地顺序

P0：

- Workbench session list 消费 daemon summaries，先渲染列表再拉详情。
- 详情加载响应必须返回 typed status，不再吞错为空数组。
- 当前 run 诊断面板显示 run metrics、streaming、recent errors。
- sidecar status 暴露最近 query/stream/reconnect 诊断。

P1：

- daemon 维护 materialized session index，合并 session metadata、active run、last preview、degraded flags。
- Workbench 预加载调度器按优先级和预算拉详情。
- metrics query 增加 event replay/session list first paint 指标。
- 慢加载和 cursor mismatch 写入 diagnostics。

P2：

- 导出某个 run/session 的诊断包，方便主 agent 或用户发给开发者。
- 增加 fake-provider streaming benchmark 的 UI 入口。
- 加入跨 provider/cache 策略的趋势面板。

## 验收标准

- 启动后会话列表先于历史消息详情显示。
- daemon 断连时列表不假装为空。
- 选中长会话不会一次性读取全部事件。
- 每个 run 能看到工具耗时、provider streaming、cache token 和最近错误摘要。
- replay cursor mismatch 会触发明确的重放/刷新状态。
- 慢客户端或断流不会导致 daemon-owned run 丢失。
