# 20 — Phase C 任务分解：前端切换

> 状态：已建立（Round 2 / A6 计划补全）
> 依据：00-master-plan.md §2 Phase C 表（:104-111）
> 输入文档：03-frontend-contract.md（03）、04-crates-inventory.md（04）、05-test-mapping.md（05）、10-phase-b-tasks.md（10）
> 前置条件：Phase B 的 B6.1/B6.3（run 命令桥 + 事件 emit 桥）上线并通过 B7.1 冒烟
> 粒度：任务 = 一个前端模块/服务边界或一个 Tauri 壳模块；"依赖"字段表达逻辑顺序，允许并行。
> 引用格式：`03 §3.2 A` = 03 文档第 3.2 节 A 组；`10 B6.3` = 10 文档任务 B6.3；`04 G8` = 04 文档缺口 G8。

---

## 一、执行顺序总览（依赖列表）

```
前置门槛：10 B6.1（run 命令桥）+ 10 B6.3（事件 emit 桥）完成，B7.1 冒烟通过

主线（关键路径）：
C1.1（transport 抽象）→ C1.2（run-task 通道）→ C2.1（事件差异核对）→ C2.2（EventRouter 调整）
→ C3.2（删 zod 层）→ C3.6（前端测试清理）→ C4.1（删 sidecar/connection）→ C4.5 → C4.6（回归冒烟）

并行支线：
① C1.3（控制通道）、C1.4（查询通道）、C1.5（杂项 RPC）在 C1.1 后并行
② C2.3（审批对齐）、C2.4（错误收口）、C2.5（hydrate 对齐）在 C2.1 后并行
③ C3.3（StreamRecovery）、C3.4（directFetch）在对应通道替换后即可执行，独立于主线
④ C4.2/C4.3（sidecar 内部模块）在 C4.1 后并行

各任务依赖明细：
【C1】起点：C1.1（依赖 10 B6.1/B6.3）
     C1.1 → C1.2、C1.3、C1.4、C1.5（四项并行）
【C2】C1.2 + 10 B6.3 → C2.1 → C2.2、C2.3、C2.4 并行；C2.1 + C1.4 → C2.5
【C3】C1.2~C1.5 全部完成 → C3.1；C2.2~C2.4 完成 → C3.2
     C1.4 → C3.3；C1.2 → C3.4；C3.1 → C3.5；C3.1~C3.5 → C3.6
【C4】10 B6 全部 + C3 全部 → C4.1 → C4.2、C4.3 并行 → C4.4 → C4.5 → C4.6
```

---

## 二、C1 — 前端 transport（daemonClient → Tauri IPC）

### C1.1 transport 抽象层
- 目标：daemonClient 职责 transport 接口化：WS transport 保留为旧实现，新增 Tauri IPC transport（invoke + listen）。
- 输入：03 §3.1（事件 emit 通道）、§3.3（daemonClient 职责替换表）；10 B6.1/B6.3
- 产出：`apps/crish-desktop/src/api/transport/types.ts`（Transport 接口：request/send/onMessage/onStatus/stop）、`tauriTransport.ts`（invokeTyped + listen('workbench-run-event') + core_get_status 初始化探测）、`daemonWsTransport.ts`（现状 daemonClient 能力抽取，保留旧路径）
- 验收：Transport 接口覆盖 03 §3.3 职责表全 10 行（request 配对→invoke、fire-and-forget send→invoke 命令、广播→listen、waitUntilConnected→core_get_status）；两实现可切换且 WS 路径行为不变；tauriTransport 事件回调形状与 onMsg 兼容（03 §3.1 前端替换点：listen('workbench-run-event', (e) => router.onMsg(e.payload))）
- 依赖：10 B6.1、10 B6.3
- 复用：03 §3.2 的 tauriInvoke.ts（invokeTyped/invokeCmdStrict 沿用，tauriInvoke.ts:160-216）；语义来源：03 §3.1、§3.3
- 分歧约束：无

### C1.2 run-task 通道替换
- 目标：streamViaDaemon 改走 core_run_task + listen 事件流。
- 输入：03 §2.2（事件驱动流程）、§3.1（前端替换点）、§3.2 A（run-task 参数契约）
- 产出：ConnectionLifecycle.ts 修改（client.onMessage → listen('workbench-run-event')，回调原样进 router.onMsg；createStreamSession 参数组装保留，03 :378-403）
- 验收：消息→流→工具→收口全流程走 IPC 与 10 B7.1 语义一致；messageBelongsToRun 过滤仍生效（runId 注入验证，eventUtils.ts:17-26）
- 依赖：C1.1
- 复用：无；语义来源：03 §2.2、§3.1
- 分歧约束：无

### C1.3 控制通道替换
- 目标：run-control/cancel/approve/deny 改走 core_run_control 等命令；双线取消 flag 关闭。
- 输入：03 §3.2 A（命令契约）、03 §2.5（取消路径）、03 §4.2（双线删除）
- 产出：runControlClient.ts 修改（TRANSITIONAL_DUAL_CANCEL_RUN_WIRE=false、buildCancelRunWireMessage 删除、dispatch 走 core_run_control/core_cancel_run）、ApprovalHandler.ts（core_approve_tool/core_deny_tool）
- 验收：L2/L3 取消经 core_run_control 单线可达（03 §4.2，IPC 模式只走 core_run_control）；approve/deny 返回 {ok, toolCallId, decision} 与 10 B6.1 一致
- 依赖：C1.1
- 复用：无；语义来源：03 §2.5、§3.2 A、§4.2
- 分歧约束：00 D1（前端对 cooperative stop 的 reason 消费与 Rust 侧裁决一致，定稿见 C2.4）

### C1.4 查询通道替换
- 目标：read-session-events/get-run-snapshot/read-run-events 换 invoke。
- 输入：03 §3.2 B（查询命令）、§1.8（会话水合消费）、§5.2-7（重放协议取舍）
- 产出：sessionEventHydrate.ts 的 fetchSessionEvents 换 core_read_session_events（函数签名与返回结构不变，03 §4.2 模块级）；usage 拉取改直查（sessionEventHydrate.ts:459-463）；get-run-snapshot/read-run-events 调用点按 C3.3 决策处理
- 验收：水合投影 projectEventsToMessages 语义不变（03 §1.8）；read-session-events 返回结构 {events, nextAfterSequence, hasMore} 兼容（03 §5.2-7）
- 依赖：C1.1
- 复用：无；语义来源：03 §1.8、§3.2 B、§5.2-7
- 分歧约束：无

### C1.5 杂项 RPC 迁移
- 目标：clientApi 等 95 处 daemonClient 调用点迁移到 invoke。
- 输入：03 §3.2 C（调用点清单：clientApi.ts:846-959、engineStatus.ts:43、engineConfig.ts:498/554、gitApi.ts:454/524、mcpApi.ts:180-468、modelCatalog.ts:703/840、rulesApi.ts:35/46、skillsApi.ts:540、subagentApi.ts:26/51、sessionDaemonSync.ts:252、conversationRewindApi.ts:39/72、schedule.ts:24-62、SessionSyncService.ts:175/649、workflowRunner.ts:26）
- 产出：各 api 文件 request 调用改 invokeTyped/invokeCmdStrict（tauriInvoke.ts:160-216）；无 Rust 侧等价命令的盘点清单（回补 10 B6.2 或走 Tauri 壳保留本地命令，04 §3.2）
- 验收：全部调用点 grep 无 daemonClient.request 残留；错误协议 CoreError {kind, detail} 兼容（03 §3.2 末）
- 依赖：C1.1
- 复用：tauriInvoke.ts；语义来源：03 §3.2 C
- 分歧约束：无

---

## 三、C2 — 事件对齐（Rust 输出 vs 前端消费）

### C2.1 事件结构差异核对
- 目标：Rust 实际输出事件 JSON 与 03 §5.1 硬依赖表逐项比对。
- 输入：03 §5.1（16 项硬依赖）、10 B6.3 产物
- 产出：核对清单（录入 30-verification-checklist.md）；差异项记录为 Rust 侧修复单（回 B6.3/B1.x）
- 验收：16 项硬依赖逐项实测通过（录制 Rust 事件 JSON 与 03 §5.1 表对照）；runId 缺失事件为零
- 依赖：C1.2、10 B6.3
- 复用：无；语义来源：03 §5.1、§5.3
- 分歧约束：无

### C2.2 EventRouter 消费端调整
- 目标：删除 event 信封分支与终态别名分支；onMsg 直进 handleAgentEvent。
- 输入：03 §5.2-1/2、§1.7（信封级事件）
- 产出：EventRouter.ts 修改（删 613-624 的 event 信封分支、删 626-645 的 run-ended 别名分支；保留 445-486 run-terminal 主路径；onMsg 简化 535-655）
- 验收：run-terminal 唯一终态下 finish 行为与 03 §2.4 表一致；无别名事件时前端功能回归通过；run_terminal_seen/clear_all 状态机无回归（approvalFlowMachine）
- 依赖：C2.1
- 复用：无；语义来源：03 §2.3-2.4、§5.2-1/2
- 分歧约束：无

### C2.3 审批通道对齐
- 目标：approval-resolved 统一 toolCallId（shared-types 声明改可选 requestId）+ zod 兼容层移除。
- 输入：03 §5.2-3、§1.5（审批域消费）
- 产出：packages/shared-types/src/events.ts 修改（requestId 改可选，对齐 03 §5.2-3）；approvalFlowMachine.ts 键控核对（toolCallId 为审批流键，daemonEventZod.ts:210-212）
- 验收：前端审批流 toolCallId 键控无回归（白名单直发/approval_pending/denied 且 deferred 终态路径）；zod 兼容分支删除后行为等价
- 依赖：C2.1
- 复用：无；语义来源：03 §5.2-3、§1.5
- 分歧约束：无

### C2.4 错误与收口对齐
- 目标：四源失败判定收敛 + agent-end 结构扩展（reason/stopReason，D1/D9 联调）+ aborted 静默语义。
- 输入：03 §2.4（四源失败表）、01 遗留问题 1/2（agent-end 结构扩展）；05 §2.10（error-translation 语义）
- 产出：EventRouter.ts 失败分支核对（agent-end reason=error→finish(true) 503-511、error 信封 601-611）；error-translation.test.ts 对齐测试（aborted 静默，05 §2.10 :71）
- 验收：四源失败（03 §2.4 表）全部收敛到 surfaceStreamFailure + finish；agent-end 携带扩展字段（若 D1 采纳 'stopped' 独立 reason）前端消费不报错；runtime-error 后 Rust 必发 terminal 事件（03 §2.4 源 2，前端 8s endTimer 兜底仅作最后防线）
- 依赖：C2.1
- 复用：无；语义来源：03 §2.4、§5.3-5；01 遗留 1/2
- 分歧约束：00 D1/01 D1（reason 命名与前端对齐定稿）、01 D9（stop + 附加 reason 字段联调）

### C2.5 hydrate 与稳定 id 对齐
- 目标：clientMessageId rekey 验证 + hydrate 换 invoke 后结构一致。
- 输入：03 §1.8（水合消费）、§5.3-4（稳定消息 id）
- 产出：sessionEventHydrate.ts 核对（pickStableMessageId 三字段兼容，sessionEventHydrate.ts:93-101）、upsert/rekey 测试补全（:107-119）
- 验收：message-end 的 clientMessageId 与 run-task 下发 id 一致（03 §5.3-4）；hydrate 投影结果与广播路径一致（maxSequence/lastRunId 取法不变，03 §1.8）
- 依赖：C2.1、C1.4
- 复用：无；语义来源：03 §1.8、§5.3-4
- 分歧约束：无

---

## 四、C3 — 删除 WS 前端层

### C3.1 删除 daemonClient.ts
- 目标：整文件删除（心跳/重连/配对/广播/URL/stream-pause-resume）。
- 输入：03 §3.3（职责替换表）、§4.1（文件级删除表）
- 产出：daemonClient.ts 删除（或仅留 getCoreStatus 薄适配）；SettingsProfileTab.tsx:190 isConnected()、useDaemonState.ts:124 改"核心已初始化"布尔
- 验收：grep 无 daemonClient 引用（03 §4.1）；前端类型检查与构建通过
- 依赖：C1.2、C1.3、C1.4、C1.5 全部完成
- 复用：无；语义来源：03 §3.3、§4.1
- 分歧约束：无

### C3.2 删除 zod 协议层
- 目标：daemonEventZod.ts + daemonEventSchema.ts 整文件删除；eventType.ts 简化。
- 输入：03 §4.1（文件级删除表）、§5.3-3（规范值归一）
- 产出：daemonEventZod.ts/daemonEventSchema.ts 删除；eventType.ts 简化为读顶层 type 字符串（eventType.ts:23-27 兜底）；extractApprovalCommandArgs 的"参数包→command 行"逻辑已移 Rust 侧归一为 parameters.command（03 §4.1 注）
- 验收：grep 无 daemonEventZod/daemonEventSchema 引用；decision/terminal 拼写兼容分支删除后行为等价（03 §5.3-3：Rust 只发规范值）
- 依赖：C2.2、C2.3、C2.4
- 复用：无；语义来源：03 §4.1、§5.3-3
- 分歧约束：无

### C3.3 删除 StreamRecovery.ts
- 目标：恢复逻辑删除（执行前先决策：保留 reload/HMR 最小切片 or 整文件删）。
- 输入：03 §4.1（删除内容 vs 保留部分）、§5.2-7（重放协议取舍）
- 产出：决策记录 + StreamRecovery.ts 处理——保留切片时仅留 extractEventSequence（108-115）/ReplayPayload（85-92）/suffixDelta（229-235）+ read-run-events invoke 化；否则整文件删；连带删除 bootstrap-services.ts:84-89（daemon ready → recoverAllStreams）、useStreamCallbacks.ts:181/428（noteRenderBuffer 背压调用）
- 验收：按 03 §4.1 删除内容清单（recoverStream/recoverAllStreams、背压 noteRenderBuffer/pause/resume、stall 扫描、registerStream 系列）逐项无引用；保留切片时 read-run-events 返回结构保持 ReplayPayload 兼容
- 依赖：C1.4（read-run-events 已 invoke 化）
- 复用：无；语义来源：03 §4.1、§5.2-7
- 分歧约束：无

### C3.4 删除 directFetchBridge.ts
- 目标：降级 HTTP SSE 层整文件删除。
- 输入：03 §4.1（directFetchBridge 行）
- 产出：directFetchBridge.ts 删除；ConnectionLifecycle.ts 的 ALLOW_AUTO_DIRECT_FETCH_FALLBACK（:61）、createStreamSession 降级分支（:238-266）、state.transportAbort（streamState.ts:23）、recordTransportDegradedDirectFetch（:255）删除
- 验收：grep 无 directFetchBridge/transportAbort/ALLOW_AUTO_DIRECT_FETCH_FALLBACK 引用
- 依赖：C1.2
- 复用：无；语义来源：03 §4.1
- 分歧约束：无

### C3.5 ConnectionManager 与启动钩子清理
- 目标：心跳 metrics 镜像删除；启动链路换"核心已初始化"。
- 输入：03 §4.1（ConnectionManager 行）、§4.2（模块级：AppBootstrap.ts:149、useEngineBootstrap.ts:11、bootstrap-services.ts:80-89）
- 产出：ConnectionManager.ts 简化（phase 由"核心已初始化"驱动，心跳 metrics 镜像 128-151/220 起删除）；bootstrap-services.ts:80-89 流恢复钩子删除；AppBootstrap/useEngineBootstrap daemon 启动钩子调整
- 验收：pong/心跳订阅零引用；UI isConnected 语义正确（SettingsProfileTab.tsx:190）
- 依赖：C3.1
- 复用：无；语义来源：03 §4.1、§4.2
- 分歧约束：无

### C3.6 前端测试清理
- 目标：WS 层对应测试删除；保留层测试回归。
- 输入：05 §6.4（保留/删除/迁移清单）、03 §4.1
- 产出：删除 daemonClient/zod/StreamRecovery/directFetch 相关测试；保留 StreamRenderBuffer.framing（05 §2.10 分帧/背压语义）、error-translation（错误显示映射，05 §2.10）
- 验收：前端测试套件通过；保留层测试零改动通过；05 §6.4 删除清单无残留
- 依赖：C3.1、C3.2、C3.3、C3.4、C3.5
- 复用：无；语义来源：05 §6.4、§2.10
- 分歧约束：无

---

## 五、C4 — Tauri 壳 sidecar 清理

### C4.1 删除 sidecar/connection
- 目标：WS 连接层（lifecycle/query/disconnect/process_mgmt/helpers）整模块删除。
- 输入：04 §3.3（删除清单）、03 §4.3（Rust 侧连带删除）
- 产出：apps/agent-workbench/src-tauri/src/sidecar/connection/ 整目录删除（含 30s ping lifecycle.rs:238-250、重连循环 lifecycle.rs:27-169、send_sidecar_query 配对 query.rs:62-355）
- 验收：cargo check 通过；grep 无 connection:: 引用；workbench 心跳/重连能力不再被前端引用（C3.5 已完成）
- 依赖：10 B6 全部完成 + C3 全部完成（前端已无 WS 依赖）
- 复用：无；语义来源：04 §3.3、03 §4.3
- 分歧约束：无

### C4.2 删除 supervisor / pending / run_stream
- 目标：sidecar 状态机、请求配对表、断线重放层删除。
- 输入：04 §3.3（supervisor.rs/pending.rs/run_stream.rs 行）、03 §4.3
- 产出：sidecar/supervisor.rs、sidecar/pending.rs、sidecar/run_stream.rs 删除（run_stream 的断线重放语义已由 10 B4.3 恢复逻辑覆盖）
- 验收：cargo check 通过；无 daemon 状态机快照引用（supervisor types.rs:95-103）；重启恢复语义由 10 B4.3 测试背书
- 依赖：C4.1
- 复用：无；语义来源：04 §3.3、03 §4.3
- 分歧约束：无

### C4.3 删除 sidecar/commands
- 目标：WS 命令组装层（status/session/run/config/plan/action）删除。
- 输入：04 §3.3（sidecar/commands 行，含 tests.rs 25KB）、03 §4.3；04 §3.3 注（语义面已由 10 B6 重实现）
- 产出：sidecar/commands/ 整目录删除（组装 run-task 等 WS JSON 协议的全部命令，commands/mod.rs:124-178）
- 验收：grep 无 sidecar::commands 引用；main.rs:27-80 的 60 个 sidecar 转发命令注册删除（C4.4 联动）
- 依赖：C4.1
- 复用：无；语义来源：04 §3.3
- 分歧约束：无

### C4.4 删除 daemon_discovery 与 main.rs sidecar 注册
- 目标：daemon 启动解析与自启循环删除；main.rs 只留本地命令注册。
- 输入：04 §3.1（main.rs 现状：sidecar::init_state :194、自启循环 :238-277）、§3.3、03 §4.3
- 产出：daemon_discovery.rs 删除（daemon_discovery.rs:26-37 四种启动模式）；main.rs 删除 sidecar 命令注册（:27-80）与自启循环（:238-277）、workbench_daemon_endpoint/workbench_restart_daemon/workbench_stop_daemon（main.rs:28-31）；cli_bridge.rs 可选删除（04 §3.3）
- 验收：cargo check/clippy 通过；进程启动不拉起任何 daemon；退出钩子保留（PTY kill，04 §3.1:289-291）；workbench_* 前缀注册模式保留但实现为进程内直调（03 §4.3 保留原则）
- 依赖：C4.1、C4.2、C4.3
- 复用：04 §3.2 保留清单（session_commands/core_commands/config/markdown/fs/perf/process/pty/power/host_*）；语义来源：04 §3.1、§3.3
- 分歧约束：无

### C4.5 清理依赖与目录
- 目标：死依赖与混居目录清理。
- 输入：04 §〇（r2d2/r2d2_sqlite 死依赖 :46-47）、§5.3（删除项）、04 遗留问题 #3
- 产出：根 Cargo.toml 删除 r2d2/r2d2_sqlite（04 §5.3）；tokio-tungstenite 移除（若仅 WS 链路使用，04 §5.1）；packages/agent-provider-http 残留目录删除（10 B2.1 迁移后）
- 验收：cargo tree 确认无死依赖；packages/ 下无 Rust crate 混居；`cargo build --workspace` 通过
- 依赖：C4.4
- 复用：无；语义来源：04 §〇、§5.3
- 分歧约束：无

### C4.6 壳回归验证与测试清理
- 目标：Tauri 壳全量回归 + sidecar 测试删除 + 切换轮冒烟。
- 输入：05 §6.4、00 §1.3（切换轮质量门槛：live model 端到端冒烟）
- 产出：cargo test（全 workspace）通过；sidecar 相关测试删除；端到端冒烟记录（live model 发消息→文字流→工具调用→正常收口，00 §1.3）
- 验收：切换轮冒烟清单通过（00 §1.3）；Phase D 的 D2 端到端冒烟（00 §2）可执行；00 §4 副文档状态表更新
- 依赖：C4.5
- 复用：无；语义来源：00 §1.3、05 §6.4
- 分歧约束：无

---

## 六、决策锚点表（Phase C 涉及的结构决策 → 任务）

| # | 决策 | 依据 | 落点 |
|---|---|---|---|
| 1 | runId 由前端本地生成并下发，Rust 以请求携带 runId 回发事件 | 03 §3.1（前端 runId 自管零改动） | C1.2、10 B6.1 |
| 2 | 终态别名收敛：只发 run-terminal，不再发 run-completed/failed/cancelled/ended | 03 §5.2-2 | C2.2、10 B4.2 |
| 3 | 去掉 orchestrator 外层包装（event 信封分支删除），onMsg 直进 handleAgentEvent | 03 §5.2-1 | C2.2 |
| 4 | approval-resolved 统一 toolCallId（requestId 改可选） | 03 §5.2-3 | C2.3 |
| 5 | 重放协议取舍：StreamRecovery 保留最小切片（reload/HMR）还是整文件删 | 03 §5.2-7 | C3.3 |
| 6 | zod 层删除前提：Rust 侧输出规范序列化（03 §5.1 16 项硬依赖） | 03 §4.1 | C3.2、10 B6.3 |
| 7 | 双线取消 flag 关闭，IPC 只走 core_run_control | 03 §4.2 | C1.3 |
| 8 | D1 reason 命名（'stopped' vs 'stop'）与前端对齐定稿 | 01 遗留问题 1 | C2.4 |
| 9 | agent-end 附加 stopReason 字段（D9 扩展）与前端联调 | 01 遗留问题 2 | C2.4 |
| 10 | 背压内移到 Rust 侧事件通道（按 runId 缓冲/丢弃 delta） | 03 §5.3-6、§4.1 | 10 B6.3、C3.3 |

---

## 七、遗留问题（下轮消化）

1. **C1.5 覆盖缺口**：95 处杂项调用点中 git/engineStatus/modelCatalog 等可能有 Tauri 壳本地命令（04 §3.2 保留清单）或 Rust 侧尚无等价实现——执行时盘点，超范围项回补 10 B6.2。
2. **C4.6 冒烟依赖 live model 凭证**（环境变量或 DPAPI）——执行轮需预置，否则以 faux provider 冒烟替代并在记录中注明。
3. **30-verification-checklist.md**（00 §4 预留）：由 10 B7.3 与 C2.1 共同填充，Phase D 轮前定稿。