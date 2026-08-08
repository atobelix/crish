# 「服务始终在线」语义与连接/恢复机制：现状盘点与差异化文案方案（03）

> 深度分析子 Agent 产出（只读，未修改任何代码）。日期：2026-08-09。
> 触发背景：用户明确"除了服务商（model provider）那边，我们的软件服务应该要保证始终在线的"，且「服务暂时不可用，正在自动恢复」文案未说明是"什么服务"出了问题。
> 全部结论基于实读源码；不确定处标注「（未证实）」。
> 姊妹文档：`docs/stability-closure/10-analysis/02-runtime-health-observability.md`（H1-H9 健康探测设计）、`06-smoke-regression-e2e.md`（tauriTransport 连接语义）。

---

## 0. 结论先行

1. **"软件服务"目前是"进程内核心"，壳死服务死**。Tauri IPC 模式（`ConnectionLifecycle.ts:4-8`）下，引擎 run loop、事件桥、DB 全部与壳同进程；不存在 sidecar/daemon 常驻进程，也没有任何 supervisor 能在引擎挂死或崩溃后拉起它（`tauri.conf.json` 无 externalBin/sidecar，实读为空；`mcp-restart-daemon.mjs` 是 WS 时代历史遗留，对应命令 `workbench_restart_daemon` / `workbench_connection_status` 已不在命令注册面 `main.rs:90-209` 内）。
2. **「正在自动恢复」在多数场景下不成立**。代码里唯一真实的自动恢复是**引擎 run 内的 provider 错误重试阶梯**（瞬态重试 ×3 / length 升级 ×2 / 压缩重试 ×1，`stream_error.rs`）——重试用尽即 fatal，不是"恢复"。transport 层**无心跳、无重连**（`tauriTransport.ts:17` 白纸黑字），ConnectionManager 的 `recovering`/`reconnecting` 状态是一次性投影，**没有任何后台循环在 failed 后重试**（`bootstrap-services.ts:81` 只 `connect()` 一次；`reconnect()` 仅测试引用）。
3. **发送秒弹的根因是"两级丢弃"**：前端 `waitUntilConnected(1.5s)` 快查 + `transport.ready` latch 永不刷新（配置变更后引擎降级，latch 仍 true）→ invoke 被 Rust 门禁立即拒绝 → `createStreamSession` catch 分支调 `networkUserMessage()`——**真实错误被丢弃**（`ConnectionLifecycle.ts:497` 只传文案不传 detail，`networkUserMessage(_detail)` 忽略参数）。用户看到的是零信息量文案，真相只在 `console.warn`。
4. **「始终在线」需要"发现 + 恢复"闭环**：02 的 H1-H9 全部是"发现"（探针），没有"恢复"（拉起/重连/收场）。缺口集中在：transport ready 陈旧、run loop 挂死无超时、引擎级 watchdog 装配被 `try_current` 跳过、崩溃无自动拉起。

---

## ① 内部服务组件清单与失败模式表

软件内部可称为"服务/子系统"的组件（按失败影响面排序）：

| # | 组件 | 代码位置 | 失败模式 | 用户可见影响 | 现有恢复机制 |
|---|---|---|---|---|---|
| 1 | **Tauri IPC 命令面**（88 命令注册面） | `main.rs:90-209`、`command_manifest.rs` | 命令未注册（manifest 漂移）→ 前端 `missing` → 抛「Tauri command not available」（`tauriTransport.ts:103-104/187-189`）；命令内部错误 → `CoreError`；超时 → 「Tauri request timeout」（`:290`） | 命令失败/超时提示；run 路径被 catch 成「服务暂时不可用」 | `call` 对 error 态**重试一次**（`:158-167`）；无持续重连 |
| 2 | **引擎 run loop**（session-loop / `drive_run_loop`） | `core_run_commands.rs:2120+`（每次 run spawn）；`crates/session-loop` | provider 流错误（`stream_error.rs` 阶梯）；run loop 挂死（produce 永不返回，02 #4）；panic → crash 文件（`main.rs:270`） | run 失败横幅；挂死 = 永远 running；崩溃 = 应用退出 | provider 瞬态重试 ×3、length 阶梯 ×2、压缩重试 ×1（引擎内自动，`stream_error.rs:81-205`）；**挂死/panic 无自动恢复** |
| 3 | **EventBridge 事件通道**（workbench-run-event） | `core_event_bridge.rs:68-81` | `app.emit` 失败（webview 未就绪等）→ 仅 `tracing::warn`「尽力而为」（`:72-79`） | 事件静默丢失 → 前端 run 无响应/永远转圈（无 message-end） | **无重发**；缓冲层丢帧策略在 `buffer.rs`（Delta 可丢、message-end 必达，03 §5.3-6） |
| 4 | **引擎内周期任务**（TimerRegistry / SchedulerRegistry / 会话级 Watchdog） | `engine.rs:831-843/874-881`、`watchdog.rs:307-319` | `tokio::runtime::Handle::try_current()` 在 GUI 主线程装配点失败 → **装配整体跳过**，仅 DEBUG（02 #5 实证：引擎级 watchdog 实际从未运行）；watchdog 只兜"子代理等待失联 ≥10 分钟"的 steering 提醒（`watchdog.rs:41`） | 定时器重启恢复不生效；子代理失联兜底缺失 | 会话级 watchdog 在 `idle_resume` 路径 spawn（`core_run_commands.rs:2309`）；无健康探针 |
| 5 | **后台任务 daemon Job**（孤儿保护） | `process.rs:489-529` | 子进程崩溃 → task-failed 事件（数据面路由消费）；应用退出 → Job object 全杀 | 任务失败通知 | 无进程重启（任务即终止） |
| 6 | **PTY 会话** | `pty/mod.rs` | 会话挂死/幽灵残留（02 #7：无列表/健康命令面）；退出钩子 `kill_all_sessions`（`main.rs:468`） | 终端卡死 | 仅 Exit 钩子清理 |
| 7 | **会话 DB（sessions.db）** | `main.rs:224-254`、`session_commands.rs:55-58` | 打开失败 → 降级内存库 + `db_ready=false`（`:239-246`）；运行期损坏/锁定**无读探针**（02 #2） | `dbReady=false` → `waitUntilConnected` 判定未就绪 → 发送被拒 | 无运行期恢复；下次启动重试 |
| 8 | **MCP socket（TCP 4000，dev only）** | `dev_mcp.rs`、插件 `socket_server.rs` | listener `JoinHandle` 从不 poll → accept 循环崩溃后端口关闭但无日志无状态（02 #1 机制根因） | 仅 dev 工具链失效 | 无（02 建议 H3 端口探测） |
| 9 | **provider 出站连接**（reqwest 直连，无本地代理端口） | `engine.rs:726/806`（`reqwest::Client` 连接池） | 网络/超时/5xx/限流 → `ClassifiedStreamError`（`stream_error.rs`） | run 中失败 → runtime-error 事件 → 前端「服务暂时不可用」（此场景文案部分成立） | 引擎内重试阶梯（见 #2） |
| 10 | **前端 Transport/ConnectionManager 投影** | `tauriTransport.ts`、`ConnectionManager.ts` | `ready` latch 置 true 后**永不刷新**（`:125/239/271-273`）；`failed` 后无重试循环 | 状态与真实引擎脱节（配置变更后仍显示就绪） | 无（见 ③） |

**关于"本地 provider 代理端口 8765"**：实读未在 `apps/agent-workbench/src-tauri` 与前端 API 面找到 8765 端口监听（MCP 是 4000 且 dev-only；provider 为出站直连）。该端口概念可能来自旧 daemon 架构或任务书背景，**当前架构中不存在**（未证实）。

**哪些失败会让用户看到「服务暂时不可用」**（最终文案出口全在 `networkUserMessage()`）：
- (a) 启动期核心未就绪：`waitUntilConnected` 超时（engineReady/dbReady 均 false——provider 配置缺失、DB 打开失败降级、或 `mark_initialized` 前窗口）；
- (b) 发送时引擎未就绪：Rust 门禁 `engine.ready()`=false（`core_run_commands.rs:2860-2865`，**provider 配置三件套缺失**——即"没配好服务商"也会被说成"服务不可用"）；
- (c) restore 进行中：`restore_ready=false`（`:2856-2857`，启动后短暂窗口）；
- (d) run 中 provider 失败：runtime-error 事件（`diagnosticHandlers.ts:19-25`）→ 分类 `network`；
- (e) 命令 missing/内部错误（manifest 漂移、串行守卫 `:2868-2874` 等）——被 catch 兜底成同一文案。

---

## ② 发送秒弹错误完整路径（文件:行号证据链）

### 路径 A：发送前连接检查（1.5s 内失败 → 秒弹）

```
用户发送
  → useChatStream → streamViaEngine（ConnectionLifecycle.ts:507-588）
  → createStreamSession（:311）
  → transport.waitUntilConnected(1_500)（:325）
     ├─ transport.ready latch 已 true → 立即返回 true（tauriTransport.ts:226）
     │   └─ 注意：ready 置位后永不刷新（:125/239/271-273）——
     │      启动时 engineReady=true，用户清空密钥后引擎 reload 降级，
     │      latch 仍 true → 检查形同虚设
     └─ 轮询 core_get_status，超时 → setStatus('failed') + return false（:243-255）
  ├─ !ready → onRunError(networkUserMessage(), 'network')（:336-340）
  └─ ready → startRunTask（:467）→ transport.request('core_run_task')
       → call（tauriTransport.ts:158-167：error 态重试一次）
       → invokeTyped（tauriInvoke.ts:167-182）
       → Rust core_run_task 门禁（core_run_commands.rs:2851-2874）：
            restore 未完成 → Err internal("restore in progress…")（:2856-2857）
            引擎未就绪   → Err internal(ready_reason)（:2860-2865）
            会话串行守卫 → Err invalid_input（:2868-2874）
       → invokeTyped 返回 error → fromInvokeTyped 抛 `${kind}: ${message}`
         （tauriTransport.ts:111）
       → createStreamSession catch（ConnectionLifecycle.ts:494-500）
         → onRunError(networkUserMessage(), 'network')
```

### 路径 B：run 中 provider 失败（发完数秒后才弹）

```
引擎 fatal_provider_error（stream_error.rs:237-269）
  → terminal_error = "provider 错误（{kind}）：{message}"（:252）
  → AgentEvent::RuntimeError{ error: "{Kind}: {message}" }（:257-262）
  → E::ProviderError 收场（:264）
  → 事件经 EventBridge（core_event_bridge.rs:137-144）发射
  → 前端 onRuntimeError（diagnosticHandlers.ts:19-25）
  → surfaceStreamFailure（BridgeErrorPolicy.ts:14-40）
  → classifySoftFailure（userFacingErrors.ts:73-87）：
       kebab 码优先（:67-71：network→'network'）→ 正则兜底（NETWORK_RE，:8-9）
  → softFailureMessage('network') = networkUserMessage()（:97-101）
  → onRunError(msg, 'network', detail)（BridgeErrorPolicy.ts:38-40）
```

### 「秒弹」的两个原因（实读结论）

1. **发送前就绪检查是"快查 + 陈旧 latch"**：`waitUntilConnected` 只有 1.5s 预算（`:325`），且 `transport.ready` 一旦 true 永远 true——真正的引擎状态变更（配置清空、reload 降级、DB 失效）不反映到 latch。引擎侧真实门禁（`core_run_commands.rs:2856-2874`）在 invoke 时**立即**返回错误 → 前端 catch 秒弹。
2. **两级丢弃错误详情**：
   - `networkUserMessage(_detail)` 签名接受参数但**忽略**（`userFacingErrors.ts:89-90`）——文案与原因完全解耦；
   - 路径 A 的 catch 连 detail 都不传（`ConnectionLifecycle.ts:496-498` 只传 message），真实原因只进 `logInternalError` 的 `console.warn`（`userFacingErrors.ts:128-134`），用户侧零信息。
   - 路径 B 相对好：`surfaceStreamFailure` 保留了 detail（`BridgeErrorPolicy.ts:30`），气泡 `errorDetail.technical` 可查（`useStreamCallbacks.ts:621-630`），但展示文案同样被 `softFailureMessage` 替换成一刀切。

**注意分类盲区**：`classifySoftFailure` 把 `no_key`（密钥缺失）单独分出去了（`NO_KEY_RE`，`:12`），但 **Rust 门禁返回的 `engine not ready（provider 配置缺失）` 文案不含 "no provider/missing key" 字样**——会被正则漏过（`:85` 的 `failed/error` 兜底 → `ended`）或直接命中 network 文案。也就是说"没配密钥"这类**配置问题**在发送路径上被说成"服务暂时不可用"。

---

## ③ 恢复机制真相（自动 vs 手动）

| 层 | 声明/表象 | 实读真相 | 自动 or 手动 |
|---|---|---|---|
| TauriTransport | 头注释「无心跳、无重连（进程内核心，断连即应用退出）」（`tauriTransport.ts:17`） | 无任何重连代码；`waitUntilConnected` 一次性轮询；`call` 对 error 态重试**一次**（`:165-166`） | 手动（应用重启） |
| ConnectionManager | `recovering`/`reconnecting` 投影态、`reconnect()` 方法（`ConnectionManager.ts:138-141`、`bootstrap-services.ts:98-99`） | 状态纯投影；`connect()` 只在 bootstrap 跑一次（`bootstrap-services.ts:81`）；**无后台重试循环**；`reconnect()` 生产侧零调用（grep 实证仅 `ConnectionManager.test.ts:127`） | 手动（不存在的自动） |
| dataPlaneRouter | 注释「transport 重连后 fanout 自动恢复（懒订阅机制现成）」（`dataPlaneRouter.ts:16`） | 懒订阅是"首个订阅者时建立 Tauri listen"，单次建立后事件通道持续存在——**不存在"重连"事件**；注释描述的是订阅惰性，不是恢复机制 | 不适用 |
| 引擎 provider 错误 | 「正在自动恢复」的文案依据 | **唯一真实的自动恢复**：瞬态重试 ×3（`stream_error.rs:81-95`）、length 阶梯 ×2（`:100-120`）、压缩阶梯 ×1（`:142-205`）；但重试间隔即时、上限封死，**用尽即 fatal**——语义是"自动重试 N 次后失败"，不是"自动恢复" | 自动（仅 run 内 provider 错误） |
| 引擎 run loop 挂死 | 无 | produce 永不返回 → run 永远 running，无超时无告警（02 #4） | 无（挂死即卡死） |
| 引擎 panic/崩溃 | panic hook 落 crash 文件（`main.rs:270`） | 进程退出，无 supervisor 拉起；前端随之失联（WebView 关闭） | 手动（用户重启） |
| 启动恢复 | `run_restore` 异步执行（`main.rs:379-384`） | 这是"**重启后**恢复快照/会话"，restore 完成前 run 被拒（`core_run_commands.rs:2856-2857`） | 重启时自动 |
| 引擎级 watchdog / TimerRegistry 恢复 | 装配注释声称"启动恢复" | `try_current()` 失败 → **装配跳过**，仅 DEBUG（`engine.rs:831-843/874-881`；02 #5 实证 8/8 日志 13 次启动 × 3 行跳过） | 实际未运行 |
| daemon 边车重启 | `mcp-restart-daemon.mjs` | WS 链路已删（`ConnectionLifecycle.ts:10-13`）；对应命令不在注册面；脚本是历史遗留（06 文档 :119） | 不存在 |

**一句话**：当前唯一"自动恢复"= 引擎 run 内 provider 错误重试阶梯；其余（未就绪、配置缺失、IPC 断、挂死、崩溃）均需**重启应用或修改配置**。「正在自动恢复」文案对 80% 场景不真实。

---

## ④ 差异化文案建议表（选项形式，最终由用户裁决）

### 4.1 需要区分的失败域

| 域 | 本质 | 判定信号（现状可得的） |
|---|---|---|
| S1 软件服务（本地 IPC/核心未就绪） | 我们自己的服务有问题 | `waitUntilConnected` 超时；`transport.ready=false`；`core_get_status.initialized=false`/`dbReady=false` |
| S2 引擎未就绪（配置缺失） | 没配好服务商，不是故障 | Rust 门禁 `engine not ready（provider 配置缺失）`（`core_run_commands.rs:2860-2865`）；`core_get_status.engineReady=false` 且 `providerStatus` 缺失 |
| S3 restore 进行中 | 启动期短暂窗口，等一等就好 | `core_get_status.restore.state=pending`（`:1504-1511`）；门禁 `restore in progress`（`:2857`） |
| S4 provider 网络问题 | 服务商不可达/超时 | kebab 码 network/timeout/endpoint-unavailable（`userFacingErrors.ts:59-65`）；NETWORK_RE（`:8-9`） |
| S5 provider 侧故障（服务商的问题） | 服务商 5xx/限流/网关 | kebab 码 server-error/rate-limit/gateway-challenge（`:59-65`） |
| S6 内部错误（manifest 漂移/串行守卫等） | 我们的 bug | CoreError kind 非上述任何域；`missing`（`tauriTransport.ts:103-104`） |

### 4.2 文案表（现文案 → 建议选项）

| 域 | 现文案（一刀切） | 选项 A（保守：只分层，不动恢复承诺） | 选项 B（进取：诚实 + 动作指引） |
|---|---|---|---|
| S1 本地核心未就绪 | 服务暂时不可用，正在自动恢复，请稍后再试。 | 软件服务正在启动，请稍候片刻。 | 软件服务尚未就绪，正在启动中；若长时间无响应请重启应用。 |
| S2 配置缺失（没配服务商） | 同上 | 模型服务尚未配置，请打开 设置 → 模型 完成配置后再发送。 | 未检测到可用的模型服务（密钥/地址未配置），请到设置 → 模型 检查；这不影响软件本身的运行。 |
| S3 restore 进行中 | 同上 | 正在恢复上次的会话数据，稍后即可发送。 | 正在恢复会话数据（通常只需几秒），恢复完成后即可继续发送。 |
| S4 provider 网络 | 同上 | 模型服务暂时无法连接（网络问题），已自动重试，稍后请重发。 | 模型服务商暂时无法访问：网络不可达或超时。我们已自动重试 3 次未成功，请检查网络后重发。 |
| S5 provider 侧故障 | 同上 | 模型服务商暂时不可用（对方服务异常），请稍后再试。 | 模型服务商侧出现故障（服务器错误/限流），请稍后重试或切换模型。我们的软件服务正常运行。 |
| S6 内部错误 | 同上 | 软件内部错误，请稍后重试；若反复出现请重启应用。 | 软件内部错误（建议重启应用）；如果仍出现，请把日志反馈给我们。 |

### 4.3 判定信号改造（让选项 A/B 可落地的最小面）

- **必须改的**：`networkUserMessage(_detail)` 改为消费 detail 的分类分发（`userFacingErrors.ts:89-91` 现为纯常量）；`createStreamSession` catch 分支把 `e` 传下去（`ConnectionLifecycle.ts:496-498` 现在丢弃）。
- **可选**：Rust 门禁错误**降级为结构化错误码**而非纯文案（`core_run_commands.rs:2856-2865` 返回 `CoreError::internal(reason)`，前端只能正则猜；可加 kind 如 `engine_not_ready`/`restore_pending`，前端 `classifySoftFailure` 已有 kebab 码优先机制，`:67-71` 可直接扩表）。
- **注意**：现有 `softFailureMessage` 的 `no_key`/`auth`/`no_project`/`blocked`/`ended` 分类（`:97-113`）保留，本文只建议把 network 一刀切拆成 S1-S6。
- **诚实原则**：S1/S2/S3/S6 下说"正在自动恢复"不成立（见 ③），要么改文案，要么先实现真正的自动恢复（见 ⑤）。

---

## ⑤ 「软件服务始终在线」保障缺口与建议

### 5.1 现状缺口（谁挂了没人拉起）

| 组件 | 失败后 | 谁拉起 | 02 H1-H9 覆盖 |
|---|---|---|---|
| 引擎 run loop 挂死 | run 永远 running，无超时无告警 | 无人（02 #4） | H5 仅"判定"设计，未落地 |
| 引擎 panic | 进程退出（crash 文件有） | 无人——**无 supervisor**（无 sidecar daemon，壳死服务死） | H6 仅"扫描告警"设计 |
| IPC/事件通道断（webview 失联） | emit 失败仅 warn（`core_event_bridge.rs:72-79`），事件静默丢 | 无人 | 无 |
| transport ready 陈旧 | latch 永 true，状态与真实脱节 | 无人（`tauriTransport.ts:125/239`） | H8 前端心跳未落地 |
| `failed`/`recovering` 后 | 投影态，无重试循环 | 无人（`bootstrap-services.ts:81` 只跑一次） | 无 |
| 引擎级 watchdog/TimerRegistry 恢复 | 装配被 `try_current` 跳过（`engine.rs:831-843`） | 无人（DEBUG 一行） | H7 仅"告警升级"设计 |
| DB 运行期损坏 | db_ready 仍 true（打开期判定） | 无人 | H2 未落地 |
| restore 完成前 | run 被拒（`:2856-2857`）——这是**设计内**的门禁，有恢复动作（restore 自行完成） | 自动 | — |

### 5.2 建议设计（选项，最终由用户裁决）

**与 02 H1-H9 的关系**：H1-H9 是"发现面"（健康循环 + 探针 → diagnostics），本文建议补"**恢复面**"（发现失败后的动作），两者闭环才是"始终在线"。

| # | 建议 | 层级 | 性质 | 依赖 |
|---|---|---|---|---|
| R1 | **transport ready 刷新 + 周期重连**：`core_get_status` 运行期周期轮询（复用 02 H8 的 10s 心跳设计），latch 随真实状态刷新；`failed`/`recovering` 后由 ConnectionManager 周期性重跑 `waitUntilConnected`（把一次性投影改成带重试循环——现状 `ConnectionManager.doConnect` 失败即停，`ConnectionManager.ts:164-177`） | 前端 | 恢复 | H8 |
| R2 | **run loop 挂死收场**：按 02 H5 判定（`LastWakeupTracker` 新鲜度，`watchdog.rs:82-107` 已有数据源）→ 超时 L3 强制收场（`runControlClient` 通道现成）→ run 结束，用户可重发，**无需重启应用** | 壳层 | 恢复 | H5 |
| R3 | **崩溃自愈（架构级，大决策）**：进程内核心架构下"壳死服务死"是必然。两条路：① 接受现状——承诺降级为"应用存活期间核心可用"，崩溃由用户重启（crash 文件 + H6 扫描 + 前端提示给足）；② 恢复 sidecar/daemon supervisor（引擎独立进程 + 心跳拉起）——这是回退到 WS 时代架构的大改动，需用户裁决 | 架构 | 恢复 | 用户裁决 |
| R4 | **装配脱节修复**：`try_current` 失败分支从 DEBUG 升级 + 记录 diagnostics（02 H7 的 P0 项）；引擎级 watchdog 恢复装配改用 `tauri::async_runtime::spawn`（`main.rs:434-440` 已有同款先例——drain 任务就是显式 runtime spawn） | 壳层 | 恢复 | H7 |
| R5 | **事件通道丢失补偿**：事件桥 emit 失败（webview 未就绪窗口）时前端下次 invoke 前补一次 `core_get_run_snapshot` 拉齐状态（`core_read_run_events` 命令面现成，`main.rs:148`），替代已删的 StreamRecovery | 前端 | 恢复 | — |
| R6 | **DB 读探针**（02 H2）：`SELECT 1` 周期探活，失败 → `db_ready=false` 如实反映 → 前端给 S1 域差异化文案 | 壳层 | 发现 | H2 |
| R7 | **发送前真实就绪检查**：`createStreamSession` 发送前补一次 `core_get_status` 实时查询（而非信 latch），命中 S2/S3 域给出对应文案（④ 表），而不是秒弹一刀切 | 前端 | 发现 | ④ 的判定改造 |

### 5.3 实施顺序建议

- **P0（文案诚实 + 判据落地，纯前端小改）**：④ 的 4.3 必改项 + 文案表选项 A——立刻消除"服务不可用"信息缺失与"自动恢复"虚假承诺。
- **P1（恢复面）**：R1（transport 周期刷新 + 重连循环）+ R2（挂死收场）+ R4（装配修复）。
- **P2（架构决策）**：R3 由用户裁决；R5/R6 随 02 的 H 项排期。

### 已知不确定项（诚实标注）

- 「本地 provider 代理端口 8765」在实读代码中不存在（MCP=4000 dev-only、provider 出站直连）——任务书背景与现状可能来自不同版本，标注待用户确认。
- `useEngineBootstrap` 的 12s 门闩（`useEngineBootstrap.ts:56-61`，productShell 下强制放行）与「始终在线」目标的关系未深挖（放行后引擎未就绪会在发送路径暴露）。
- 引擎级 watchdog 被 `try_current` 跳过对生产功能的确切影响（会话级 watchdog 是否同受此影响）未逐行核实（02 文档同样标注）。
- `workbench_restart_daemon` / `workbench_connection_status` 确认不在 `main.rs:90-209` 注册面内（grep 实证），但未检查打包产物/旧版本残留。

---

## 附：引用索引（文件:行号）

- `apps/crish-desktop/src/api/userFacingErrors.ts:8-9, 54-71, 73-91, 97-114, 128-134` 分类正则 / kebab 码表 / networkUserMessage 忽略参数 / softFailureMessage
- `apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts:311-343, 467-500` createStreamSession 未就绪分支与 catch 丢弃 detail；`:10-13` WS 删除项
- `apps/crish-desktop/src/api/chat-bridge/BridgeErrorPolicy.ts:14-40` surfaceStreamFailure 保留 detail
- `apps/crish-desktop/src/api/chat-bridge/handlers/diagnosticHandlers.ts:19-25` runtime-error → surfaceStreamFailure
- `apps/crish-desktop/src/api/chat-bridge/handlers/lifecycleHandlers.ts:31-39, 76-107` agent-end/run-terminal 失败面
- `apps/crish-desktop/src/api/transport/tauriTransport.ts:17, 101-112, 119-121, 158-167, 224-256, 259-273` 无重连声明 / 重试一次 / waitUntilConnected / ready latch
- `apps/crish-desktop/src/api/tauriInvoke.ts:167-182` invokeTyped 三态
- `apps/crish-desktop/src/services/ConnectionManager.ts:6, 116-177, 193-215` 无心跳声明 / 一次性 doConnect / 状态投影
- `apps/crish-desktop/src/bootstrap-services.ts:81, 90-110` connect 仅一次 / recovering→reconnecting 投影
- `apps/crish-desktop/src/api/engineConfig.ts:576-614` fetchEngineStatus 无 keep-alive
- `apps/crish-desktop/src/api/engineStatus.ts:42-49` not_connected 路径
- `apps/crish-desktop/src/api/chat-bridge/dataPlaneRouter.ts:16, 141-153` 懒订阅注释与 refcount
- `apps/crish-desktop/src/app/useEngineBootstrap.ts:56-61` 12s 门闩
- `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:578-635` onRunError → 横幅/气泡 errorDetail
- `apps/crish-desktop/src/components/chat-message/MessageContent.tsx:71-91` 气泡兜底文案
- `apps/crish-desktop/src/components/chat-card/chatStatusRibbonsLib.ts:186-195`「引擎连接恢复中」soft-hint（另一套文案，未与 networkUserMessage 统一）
- `apps/agent-workbench/src-tauri/src/main.rs:90-209` 88 命令注册面；`:224-254` DB 降级；`:379-384` restore 异步；`:434-440` drain 任务（tauri runtime spawn 先例）；`:467-473` 退出钩子
- `apps/agent-workbench/src-tauri/src/core_run_commands.rs:2851-2874` run_task 三门禁；`:1492-1494` engine_ready=provider 配置；`:2360-2428` drive_run_loop 无超时（02 #4）
- `apps/agent-workbench/src-tauri/src/core_event_bridge.rs:68-81` emit 失败仅 warn
- `apps/agent-workbench/src-tauri/src/engine.rs:831-843, 874-881` try_current 跳过装配
- `apps/agent-workbench/src-tauri/src/watchdog.rs:41-44, 173-319` 兜底 watchdog 语义
- `crates/session-loop/src/loop/handlers/stream_error.rs:62-78, 81-95, 100-120, 142-205, 237-269, 305-321` 重试阶梯与 fatal 文案
- `docs/stability-closure/10-analysis/02-runtime-health-observability.md` H1-H9 全表；`:89` 装配跳过实证
- `docs/stability-closure/10-analysis/06-smoke-regression-e2e.md:119` daemon 脚本历史遗留
- `scripts/mcp-restart-daemon.mjs:60-78` 遗留命令引用（不在注册面）
