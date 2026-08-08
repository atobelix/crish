# 用户可见错误提示触发链与重复播报根因分析

- 产物编号：error-notification-governance / 10-analysis / 01
- 日期：2026-08-09
- 性质：只读分析（不修改任何代码）
- 关联文件：`apps/crish-desktop/src/**`（前端）、`crates/session-loop/src/**`、`crates/orchestrator/src/run.rs`（Rust 侧）
- 前置文档：`docs/stability-closure/10-analysis/03-boot-noise-logging-governance.md`（35 处裸 console.warn 盘点）

---

## 1. 完整触发链（用户点发送 → 提示上屏）

### 1.1 路径 A：引擎未就绪 / 未连接（「秒弹」主场景）

```
用户点发送
└─ ChatComposer → useSlashSend.handleSendChat  apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts:73
   ├─ 前置校验（needs-key / needs-model）→ setPickerInlineError 输入框内联提示（:85-94）
   └─ addMessage(用户消息 processing)  useSlashSend.ts:352
      └─ runStreamingAssistant  useStreamCallbacks.ts:174
         ├─ addMessage(assistant 占位, processing)  useStreamCallbacks.ts:272-280
         ├─ streamAssistantResponseApi → streamViaEngine  ConnectionLifecycle.ts:507
         │  └─ createStreamSession（异步） ConnectionLifecycle.ts:311
         │     ├─ transport.waitUntilConnected(1_500)  ConnectionLifecycle.ts:325
         │     │    （250ms 轮询 core_get_status，最多 1.5s；未就绪 → ready=false）
         │     ├─ 未就绪 → callbacks.onRunError(networkUserMessage(), 'network')  ConnectionLifecycle.ts:336-337
         │     │    ★ 不经过 classifySoftFailure，恒报「服务暂时不可用，正在自动恢复，请稍后再试。」
         │     └─ finish()  ConnectionLifecycle.ts:341
         └─ onRunError（useStreamCallbacks.ts:578）
            ├─ pushRunNotice({text: 网络文案, kind:'network', detail}, 14000)  useStreamCallbacks.ts:598-605
            │    → RunNoticeBar（输入框上方 ribbon） ChatStatusRibbons.tsx:364 / ChatComposerWrapper.tsx:82-113
            ├─ onShowToast(网络文案)  useStreamCallbacks.ts:606
            │    → useToastQueue（同文案去重 + TTL 5s） useToastQueue.ts:466-495
            └─ withdrawMessage(撤掉占位气泡)  useStreamCallbacks.ts:611-613（hadText=false）
```

补充：`createStreamSession` 的 catch 兜底（ConnectionLifecycle.ts:494-500）——`startRunTask` invoke 抛错（命令未注册、参数错误、核心崩溃等）也**恒报同一 network 文案**。这是文案失真根因之一：非网络错误被包装成网络文案。

### 1.2 路径 B：连接建立但 provider 请求失败（Rust fatal 收场）

```
Rust 侧 session-loop streaming
└─ handleStreamError  crates/session-loop/src/loop/handlers/stream_error.rs:47
   ├─ 瞬态错误（RateLimit/ServerError/Timeout/Network）→ 重试阶梯（上限 3） stream_error.rs:64-67,81-95
   │    （重试期间只发 provider-diagnostic 事件 → 前端仅 console.warn，诊断 handler 不 surface） diagnosticHandlers.ts:12-17
   ├─ 阶梯用尽 → fatal_provider_error  stream_error.rs:237-269
   │    ├─ ① state.events.push(RuntimeError{ error: "Network: <msg>" })  stream_error.rs:257-262
   │    ├─ ② terminal_error = "provider 错误（network）：<msg>"  stream_error.rs:252
   │    └─ ③ dispatch(ProviderError) → turn-complete → converge  mod.rs:876-913
   │         └─ events.push(AgentEnd{ reason: Error, error: terminal_error })  mod.rs:880-885
   └─ orchestrator 收尾：agent-end → run-terminal(failed) 派生  crates/orchestrator/src/run.rs:613-620
        （drive.rs 测试确认 wire 上 agent-end 与 run-terminal 都存在：orchestrator/tests/drive.rs:136）

事件经 workbench-run-event 通道发射（apps/agent-workbench/src-tauri/src/core_event_bridge.rs:1-6）
└─ TauriTransport fanout（懒订阅 listen） tauriTransport.ts:305-341
   └─ EventRouter.onMsg → handleAgentEvent  EventRouter.ts:85-113,76-83
      ├─ runtime-error → onRuntimeError → surfaceStreamFailure #1  diagnosticHandlers.ts:19-25
      │    → onRunError → 横幅 + toast + 消息 error 状态（不 finish）
      ├─ agent-end(reason=error) → onAgentEnd → surfaceStreamFailure #2 → finish(true)  lifecycleHandlers.ts:31-39
      │    → onRunError → 横幅 + toast + error 状态
      └─ run-terminal(failed) → 被 state.finished 门闩丢弃（finish 已置位） EventRouter.ts:77,86
           → 三报被防住（此为既有收敛点）
```

surfaceStreamFailure 统一入口：`BridgeErrorPolicy.ts:14-41` —— classify → softFailureMessage → onRunError。

### 1.3 各环节用户可见产物清单

| 环节 | 产物 | 展示位置 | 生命周期 |
|---|---|---|---|
| onRunError → pushRunNotice | 运行提示横幅（「运行提示」kicker） | 输入框上方 ribbon（ChatStatusRibbons） | TTL 14s（错误）/ 6s（空回复）/ 8s 默认，可手动关闭，单槽覆盖式 |
| onRunError → onShowToast | toast | 右下/全局 toast 栈 | TTL 5s，自动消失，同文案刷新 TTL，可手动 dismiss |
| onRunError → setSessionMessageStatus('error', errorDetail) | 气泡内错误框（AlertCircle + 文案） | assistant 气泡（MessageContent.tsx:71-93） | 持久（随消息存续，无自动消失；hadText 为真时出现） |
| ConnectionLifecycle 未就绪/异常 | 同 onRunError 三通道（横幅+toast），气泡被 withdraw | 同上 | 同上 |
| engine-down soft-hint | 「引擎连接恢复中，请稍候」 | SetupHintBanner（输入框上方，与 RunNoticeBar 同区） | 常驻，随 engineHint 状态消失 |
| setPickerInlineError | 输入框内联错误 | 输入框内 | 常驻，下次发送清除 |

---

## 2. 重复播报根因清单

| # | 场景 | 证据（文件:行号） | 重复次数/路径 |
|---|---|---|---|
| R1 | **Rust 对同一失败发 2 个携带错误的事件**：fatal 时先推 RuntimeError（stream_error.rs:257-262），收口时再推 AgentEnd{error}（mod.rs:880-885），orchestrator 再派生 run-terminal（run.rs:613-620） | 前端四源中 runtime-error 与 agent-end 都 surface（diagnosticHandlers.ts:24；lifecycleHandlers.ts:32）；EventRouter.test.ts:272 明示「Rust 必发 terminal」 | 同一 run 失败 → surfaceStreamFailure ×2（run-terminal 被 finish 门闩挡掉第 3 次）→ onRunError ×2 → 横幅重置 2 次 + toast 去重刷新 2 次 + 消息 error 状态写 2 次 |
| R2 | **onRunError 内多通道同时播报同文案**：横幅（14s）+ toast（5s）+ 气泡 error 框（持久） | useStreamCallbacks.ts:598-633；MessageContent.tsx:71-93（errorDetail.message 与横幅/toast 同文案） | 一次失败 → 最多 3 个通道同屏同文案；气泡为持久通道，横幅/toast 为瞬时通道 |
| R3 | **引擎未就绪时每次发送 = 一次失败播报**：waitUntilConnected(1.5s) 超时 → onRunError(network 文案)；连发 N 次 → 每次重置 banner TTL 14s、刷新 toast TTL 5s | ConnectionLifecycle.ts:325-343；useToastQueue.ts:477-485（dedupe 刷新 TTL 而非抑制） | N 次发送 → toast 持续悬挂 + banner 持续重置，感知为「一直报/重复报」 |
| R4 | **follow_up 队列 drain 自动重发放大**：失败期间发的消息 status=queued（useSlashSend.ts:380-390），失败后 drainQueuedAfterComplete 自动重开 stream（useStreamCallbacks.ts:909-911）→ 再次失败 → 再次播报 | useSlashSend.ts:327-333,380-390；useStreamCallbacks.ts:637-912 | 一条 queued 消息 = 一轮新失败播报（R1+R2 全量重放） |
| R5 | **surfaceStreamFailure 无 per-run/按消息去重**：四源只收敛到一个函数（03 §2.4），但函数内无「同 run 同错误只报一次」门闩 | BridgeErrorPolicy.ts:14-41 | 同 run 内 2 次调用照报（R1） |
| R6 | **横幅层（RunNoticeBar）无任何去重**：pushRunNotice 直接 setRunNotice + 重置 timer，同文案重复 push 仅刷新 TTL，不抑制、不合并 | useChatStream/index.ts:35-47 | 同文案横幅理论上每失败一次重置一次显示周期 |
| R7 | **文案失真放大感知**：startRunTask catch 兜底与未就绪路径恒报 network 文案（含非网络错误），用户对「假网络错误」无解 → 反复尝试发送 → 反复播报 | ConnectionLifecycle.ts:330-343,494-500 | 与 R3/R4 叠加 |
| R8 | **ErrorStore 通道未接入网络错误**：ErrorStore 的 code 级批量去重（ErrorStore.ts:107-126）只有 AppErrorBoundary（REACT_RENDER_ERROR）一个消费方；网络错误不经此路 → 该去重机制形同虚设 | ErrorStore.ts:107-160；AppErrorBoundary.tsx:138-145 | 无叠加（不是重复源，但说明去重设施闲置） |
| R9 | **React StrictMode 双挂载**：dev 下组件双 mount（main.tsx:75-86）——事件驱动路径（发送、事件回调）不受影响；transport.onMessage 懒订阅有 refcount 防护（dataPlaneRouter.ts:141-153、useEngineState.ts:88-107 同模式）；per-run EventRouter 每次发送新建，不双报 | main.tsx:75-86；dataPlaneRouter.ts:141-153 | **排除**：非根因（已核验防护） |
| R10 | **transport 事件重放**：无。IPC 进程内不中断、不做事件重放（tauriTransport.ts:179）；前端无 read-run-events 回放接线（commandManifest 登记了 core_read_run_events 但无消费面） | tauriTransport.ts:17,177-179；commandMap.ts:33 | **排除**：不存在重放路径 |
| R11 | **ToastBus 第二套 toast 队列无同文案去重**：toastBus.show 仅 group 去重（ToastBus.ts:70-80），无文本去重；但当前网络错误不经 toastBus（走 useToastQueue），仅 ErrorStore 渲染错误与 3 处零星调用 | ToastBus.ts:54-95,196-211,223-227 | 当前不叠加；若未来错误改走 toastBus 则无保护 |

**重复根因数量：6 个有效根因（R1–R6 中 R5/R6 为机制缺口，R3/R4 为触发放大器，R7 为失真放大；R8 为闲置设施；R9/R10 排除）。**

一句话摘要：同一 run 失败在 Rust 侧以 runtime-error + agent-end 双事件回传（R1），前端 surfaceStreamFailure 无 run 级去重（R5）导致 onRunError 双触发，每次触发又横幅+toast+气泡三通道同文案齐报（R2），横幅无去重（R6）；引擎未就绪时每次发送独立触发一次失败播报且 catch 兜底恒报网络文案（R3/R7），follow_up 队列 drain 自动重发进一步放大（R4）——这就是「秒弹 + 重复多报 + 挡使用」的完整成因链。

---

## 3. 「服务暂时不可用，正在自动恢复」触发条件与秒弹场景

### 3.1 classify 成 network 的条件

`userFacingErrors.ts` 分类优先级（classifySoftFailure，:73-87）：
1. **kebab 错误码**（Rust 包装格式 `provider 错误（{kind}）：{message}`，stream_error.rs:252 的 kind_str）：`endpoint-unavailable` / `network` / `timeout` → network（userFacingErrors.ts:57-65）
2. **文本正则 NETWORK_RE**（:8-9）：`network|timeout|offline|econn|enotfound|econnrefused|not connected|failed to connect|connect failed/refused/reset/closed|disconnected|unable to connect|proxy|dns|net::|fetch failed|socket`
3. NO_KEY_RE / AUTH_RE / NO_PROJECT_RE / BLOCKED_RE 在前，network 在其后

Rust 侧 fatal 文案（stream_error.rs:252）：
- `provider 错误（network）：<message>` → kebab 码 `network` → network
- `provider 错误（timeout）：<message>` → kebab 码 `timeout` → network
- `provider 错误（endpoint-unavailable）：<message>` → network

### 3.2 秒弹场景定位：引擎未就绪/未连接时发送

- `createStreamSession` 对**每次发送**都执行 `waitUntilConnected(1_500)`（ConnectionLifecycle.ts:325）——1.5s 超时窗口，250ms 轮询。
- 未就绪 → `callbacks.onRunError(networkUserMessage(), 'network')`（ConnectionLifecycle.ts:336-337）——**不经过 classify，直接给 network 文案**。
- catch 兜底（ConnectionLifecycle.ts:494-500）同样恒报 network 文案——`startRunTask` invoke 的任何异常（含非网络类）都被包装成「服务暂时不可用，正在自动恢复」。
- 结论：**秒弹 = waitUntilConnected 短超时 + 未就绪/异常路径恒报 network 文案**。前端 `data-engine-ready`（App.tsx:184）与 useEngineBootstrap 就绪门闩存在，但发送路径未做就绪前置拦截（useSlashSend.ts 无 engineReady 检查，仅 needs-key/needs-model 检查 :85-94）。

### 3.3 「正在自动恢复」的真实性

| 机制 | 是否真实存在 | 证据 |
|---|---|---|
| transport 自动重连 | **否**。进程内 IPC，「无心跳、无重连，断连即应用退出」 | tauriTransport.ts:17 |
| transport 暂态重试 | 是，仅 invoke 层一次（error 三态结果重试一次） | tauriTransport.ts:119-121,158-167 |
| 引擎侧 provider 重试阶梯 | 是：瞬态 3 次（RateLimit/ServerError/Timeout/Network）+ length 阶梯 + 压缩阶梯 | stream_error.rs:64-77,81-95 |
| 事件重放/断流恢复 | 否（「IPC 进程内不中断，不做事件重放」） | tauriTransport.ts:177-179 |

**结论**：「正在自动恢复」文案与事实不符——用户看到该提示时，引擎重试阶梯已**耗尽并 fatal**（stream_error.rs:237 fatal_provider_error 是唯一产生此文案的上游），transport 也没有任何重连机制。「自动恢复」只在重试阶梯内成功时成立，而那时用户**看不到**任何提示（provider-diagnostic 仅 console，diagnosticHandlers.ts:12-17）。即：文案承诺的恢复在提示出现时已不可能发生；该文案唯一真实对应的能力是「引擎内部瞬态重试」（用户无感）与「下次发送再试」（用户自助）。

### 3.4 文案失真面（建议治理锚点）

- 未就绪/异常路径恒报 network 文案（ConnectionLifecycle.ts:336-337,496-497）——无论真实错误是命令缺失、参数错误还是核心崩溃。
- `formatRunFailureForUi`（streamDiag.ts:82-116）是真正的技术分类兜底（timeout/network/cancel/context/rate-limit 分句），但只在 classify 返回 null 时才用（BridgeErrorPolicy.ts:23-26），network 命中时被 softFailureMessage 覆盖。
- MessageContent.tsx:89 与 useStreamCallbacks.ts:622 各有一份「服务暂时不可用，请检查网络或后端配置」兜底文案（与 userFacingErrors.ts:90 的「正在自动恢复」版本不一致）——**同一产品 3 处 2 种文案**。

---

## 4. 提示通道全景表

| 通道 | 触发点 | 去重现状 | 显示时长 | 关闭方式 | 可收敛性 |
|---|---|---|---|---|---|
| **RunNoticeBar**（输入框上方 ribbon，「运行提示」） | pushRunNotice（useStreamCallbacks:598/697/972；useChatStream/index.ts:35-47） | 无（单槽覆盖，同文案重复 push 仅刷新 TTL） | 调用方 TTL（错误 14s / 空回复 6s / 停止 5s / 默认 8s） | 手动 X 按钮；onChunk 或 onComplete 有正文时 dismiss | 高：可加同文案抑制 + 与 toast 互斥 |
| **Toast**（useToastQueue，App.tsx:100） | onShowToast（onRunError:606 及各业务点） | 同文案去重 + 刷新 TTL（useToastQueue.ts:387-406,477-485）；成功类文案策略丢弃（:183-201） | TTL 5s（TOAST_TTL_MS:35） | 自动消失；手动 dismiss | 已较好；缺口：仅文本级去重，无「同一错误源」级去重 |
| **ToastBus**（第二套 toast，独立队列） | toastBus.show（3 处业务 + ErrorStore toast:show 事件，ToastBus.ts:223-227） | 仅 group 去重（ToastBus.ts:70-80），**无文本去重** | 3-10s（按 type） | 自动消失 | 建议并入 useToastQueue 或补文本去重 |
| **assistant 气泡错误框** | setSessionMessageStatus('error', errorDetail)（useStreamCallbacks.ts:615-633）→ MessageContent.tsx:71-93 渲染 | 无（持久随消息） | **持久**（会话内一直显示） | 无（不可关闭） | 可：仅保留技术 detail，或改为可折叠 |
| **引擎离线 soft-hint**（SetupHintBanner） | resolveSetupHintKind → 'engine-down'（chatStatusRibbonsLib.ts:30-71；文案「引擎连接恢复中，请稍候」:190-195） | 互斥一条（kind 优先级） | 常驻（engineHint 状态驱动） | 随状态消失 | 已收敛良好 |
| **输入框内联错误** | setPickerInlineError（useSlashSend.ts:86-94 等） | 单槽 | 常驻至下次发送 | 下次发送清除 | 已收敛 |
| **AppErrorBoundary**（错误页/面板） | componentDidCatch（渲染崩溃） | circuit breaker（30s 内 3 次熔断，AppErrorBoundary.tsx:43-45,119-134） | 持久 | 重试/重新加载按钮 | 已收敛 |
| **console.warn 面** | logInternalError / recordStreamDiag / 35 处裸 warn（03 文档） | 无 dedupe（03 文档已盘点） | — | — | 开发面，另案治理 |

---

## 5. 去重机制现状与缺口

### 5.1 已有机制

| 机制 | 位置 | 覆盖路径 | 状态 |
|---|---|---|---|
| toast 同文案去重 + TTL 刷新 | useToastQueue.ts:387-406（findDuplicateToastIndex 按归一文案+undo 键）、:477-485 | onRunError 的 onShowToast 双触发（R1）→ 收敛为单 toast | 有效（同 run 双 surface 不会叠 toast） |
| toast 成功类文案策略丢弃 | useToastQueue.ts:55-124（FORBIDDEN_SUCCESS_TOAST_PATTERNS）、:183-201 | 业务成功 toast 回流 | 有效 |
| EventRouter 四源收敛单函数 | dispatch 表 → surfaceStreamFailure（EventRouter.ts:12；BridgeErrorPolicy.ts:14） | run-failed/runtime-error/agent-end/error 信封 | 有效（入口唯一）但无 run 级去重（R5） |
| finish 门闩防 run-terminal 三报 | EventRouter.ts:77,86（finished 后丢弃）；onAgentEnd/onRunTerminal 调 finish | run-terminal 与 agent-end 双终态 | 有效（把 3 报压到 2 报） |
| ErrorStore code 批量合并 | ErrorStore.ts:107-126（同 code+severity 刷新 timestamp）、:172-183（resolveByCode） | 仅 REACT_RENDER_ERROR | **闲置**（网络错误未接入） |
| 引擎离线 soft-hint 互斥 | chatStatusRibbonsLib.ts:22-29,40-41 | engine-down/needs-key/needs-model 互斥一条 | 有效 |
| silent-complete warn 按 messageId 去重 | silentComplete.ts:185 | dev console | dev only |

### 5.2 缺口清单（按收敛优先级）

1. **surfaceStreamFailure 无 run 级/消息级去重**（BridgeErrorPolicy.ts:14-41）——同 run 内第 2 次调用照报。收敛点：按 (runId + 归一文案) 或 (runId + error 指纹) 抑制重复 surface。
2. **RunNoticeBar 无去重**（useChatStream/index.ts:35-47）——同文案重复 push 仅重置 TTL。收敛点：同文案忽略或并入 toast 去重键。
3. **横幅 + toast + 气泡三通道同文案互不抑制**（useStreamCallbacks.ts:598-633）——同一次失败三处齐报，且气泡是持久通道。收敛点：通道职责分层（瞬时 = toast 或 banner 二选一；持久 = 气泡仅技术 detail）。
4. **发送路径无就绪前置拦截**（useSlashSend.ts:85-94 仅校验密钥/模型，未校验 engineReady）——秒弹直接成因。收敛点：发送前查 transport.isReady()/engineReady，未就绪时仅提示一次且不产生失败 run。
5. **ConnectionLifecycle catch 兜底文案失真**（ConnectionLifecycle.ts:494-500）——所有异常恒报 network 文案。收敛点：catch 内区分错误类型，仅真实网络/未就绪用 network 文案。
6. **ToastBus 无文本去重**（ToastBus.ts:54-95）——第二套 toast 队列与 useToastQueue 并存且规则不一致。收敛点：并入单一 toast 通道。
7. **文案三处不一致**（userFacingErrors.ts:90「正在自动恢复」 vs useStreamCallbacks.ts:622 / MessageContent.tsx:89「请检查网络或后端配置」）。收敛点：单一文案真源 + 与事实对齐（见 §3.3「自动恢复」不真实）。
8. **Rust 侧双事件承载同一错误**（stream_error.rs:252,257 + mod.rs:880）——前端无法从事件流判断二者同源（runtime-error 无 runId 关联去重键）。收敛点（跨栈）：runtime-error 携带 runId + 错误指纹，或前端按时间窗+文案归一抑制。

### 5.3 已在抑制的（不会重复）

- 同 run 失败：run-terminal 三报被 finish 门闩挡掉（EventRouter.ts:86）——目前实测 2 报而非 3 报。
- 同文案 toast：R1 双 surface 的 toast 合并为单条（TTL 刷新）。
- 引擎离线 ribbon 互斥一条。
- StrictMode 双挂载、事件重放：已排除（R9/R10）。

---

## 6. 结论

- **重复播报根因（有效 6 个）**：R1（Rust 双事件）→ R5（surface 无 run 级去重）→ R2（三通道齐报）→ R6（横幅无去重）为机制层；R3（未就绪每次发送一次播报）、R4（follow_up drain 放大）、R7（文案失真）为触发层。
- **秒弹** = `waitUntilConnected(1.5s)` 短超时 + 发送路径无就绪前置拦截 + 未就绪/异常恒报 network 文案（ConnectionLifecycle.ts:325-343,494-500）。
- **「正在自动恢复」不真实**：提示出现时引擎重试已耗尽 fatal，transport 无重连；该文案唯一对应的真实能力（引擎内瞬态重试）恰恰发生在用户无感阶段。
- 既有收敛设施（toast 文本去重、四源单入口、finish 门闩）已挡住一部分；剩余缺口集中在「run 级去重」「通道互斥」「发送前置拦截」「文案真源」四点。
