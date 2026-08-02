# Crish Agent 核心 Rust 化 —— 多 Agent 协同修复主方案

> 状态：进行中（Phase A 知识采集）
> 本方案为总纲。各阶段细化为副文档（`docs/rust-rewrite/` 下），副文档由执行轮次前按需补全。
> 本方案只描述**逻辑执行顺序**，不含时间安排、人员分配与优先级——所有条目同等重要，按依赖关系串行/并行。

---

## 0. 文档管理规则（统一目录）

- 本方案及所有关联副文档**统一存放于 `docs/rust-rewrite/`**，命名：`NN-<topic>.md`（NN 为执行顺序号）。
- 每轮 Agent 产出的分析文档、计划文档、审查文档一律落盘到本目录，不散落其他位置。
- 历史参考：`docs/archive/redesign/rust-architecture-redesign/`（2026-07-21 愿景级规划，性能/C4 层面）仅作引用输入，不修改、不并入。
- 副文档状态在本文件第 4 节登记；每轮结束更新状态。

---

## 0A. 背景与问题识别（已确认，不重复调查）

### 0.1 现状事实（2026-07-31 调查结论）

1. **三份分叉拷贝**：`packages/agent-runtime`（原始单体，52k 行，deprecated shim + 本地全套旧拷贝）与 `packages/agent-core`（Round 5 拷贝）、`packages/agent-model`（Round 4 拷贝）存在 ~470 对同路径文件、~370 对语义分叉。工作区未提交改动正在让两份拷贝互斥演化（stop/aborted 语义、tool-promise steering、vendor 推理、endpoint 默认值已矛盾）。
2. **模型兼容层臃肿**：agent-model 22.4k 行；provider 层 openai 5 个文件 + 38 个 provider 声明 JSON + OAuth 全套 + CLI。与 agent-runtime 内的 provider 层再度分叉。
3. **链路过长**：前端 → WS → daemon sidecar（bundle.js）→ orchestrator → AgentRuntime → SessionLoop → provider。中间夹 StreamRecovery/协议校验/背压/zod 校验三层。
4. **运行时故障**：模型正常回复一句话后 run 以 `error` 收场的路径存在（stopReason=error 一票否决、empty-response 二次即 intervention-required、tool-promise regex steering 在同一 run 内注入）。
5. **Rust 基建已就位**：`crates/conex-*` 14 个 crate（db/net/stream/types/ipc/compaction/sandbox/search/fs/diff/markdown/telemetry），Tauri 壳 56 个 rs 文件；`packages/agent-provider-http` 为半成品 Rust crate。

### 0.2 目标形态

```
┌─ Tauri 进程 (Rust) ──────────────────────────────┐
│ agent-core (Rust): session-loop 状态机 + steering│
│   + orchestrator(会话/run) + tool-executor        │
│ agent-provider (Rust): openai-compat/anthropic/  │
│   gemini/ollama (reqwest + SSE)                  │
│ agent-tools (Rust): fs/shell/search + MCP        │
│ conex-db: 会话/事件持久化                        │
└──────────────┬───────────────────────────────────┘
               │ Tauri IPC (invoke + event emit)
┌──────────────▼───────────────────────────────────┐
│ crish-desktop (React/TS)：UI 与事件渲染保留      │
│ daemonClient.ts → Tauri IPC transport            │
└──────────────────────────────────────────────────┘
```

### 0.3 边界

- **删除**：WS daemon 链路（sidecar、WS 协议、背压、StreamRecovery、zod 协议层、directFetchBridge）。
- **删除**：TS 端 agent-runtime / agent-core / agent-model / agent-daemon / agent-orchestrator 及 workbench CLI runner。
- **保留复用**：crates/conex-*（db/net/stream/types 等）；前端 UI/渲染层（EventRouter 语义、StreamRenderBuffer、store）。
- **保持**：前端既有事件协议结构（AgentEvent 序列化结构尽量对齐，减少 UI 改动）。

---

## 1. 多 Agent 协同机制（可复用章程，每轮适用）

### 1.1 轮次结构

每轮 = `计划 → 分配 → 并行执行 → 汇总 → 验证 → 补全计划` 的闭环。每轮输出写入 `docs/rust-rewrite/`，作为下一轮输入。

- **每轮最多 12 个 Agent**，数量按实际任务决定，不强制占满。
- 角色：`分析员`（只读研究，产出文档）、`实现员`（写代码，产出代码+自测）、`评审员`（只读审查，产出审查报告）。
- 执行规则：子 Agent 先读本方案与相关副文档，但**只执行被分配的任务**，不越界修改。

### 1.2 轮次间依赖规则

- 分析输出 → 计划补全 → 实现输入。
- 每轮结束：汇总 Agent 输出 → 更新副文档 → 下一轮计划基于更新后的文档。
- 任何发现的新问题，追加到对应阶段文档的"遗留问题"节，下轮消化。

### 1.3 质量门槛（每轮验证）

- 实现轮：`cargo test` / `cargo clippy` 通过；关键语义必须有单测（faux provider）。
- 文档轮：输出需含具体文件路径 + 行号引用；结论需可复核。
- 切换轮：端到端冒烟（live model 发消息 → 文字流 → 工具调用 → 正常收口）。

---

## 2. 主执行链（逻辑顺序）

### Phase A — 知识采集与规范固化（文档产出轮）

| 步骤 | 内容 | 输出副文档 |
|---|---|---|
| A1 | 解构 agent-core/agent-runtime 的 session-loop 语义：状态机、steering、control、provider-call、tool-execution、recovery 的**期望行为**（以两拷贝的并集为准，标注分歧点） | `01-session-loop-semantics.md` |
| A2 | 解构 agent-model provider 层：openai-compatible/anthropic/gemini 的请求构建、SSE 解析、错误分类、thinking 透传 | `02-provider-semantics.md` |
| A3 | 解构前端事件协议与 IPC 边界：AgentEvent 全量清单、前端消费端状态机（EventRouter）、Tauri 侧现有 command/event 桥 | `03-frontend-contract.md` |
| A4 | 盘点 crates/conex-* 与 Tauri 壳能力：可复用 API、缺口清单 | `04-crates-inventory.md` |
| A5 | 盘点 TS 测试资产：有价值测试语义 → 映射为 Rust 测试清单 | `05-test-mapping.md` |
| A6 | 汇总 A1-A5 → 补全 Phase B/C 任务分解（本方案下节细化） | `10-phase-b-tasks.md` |

### Phase B — Rust 核心实现（实现轮，逻辑依赖序）

| 步骤 | 内容 | 依赖 | 说明 |
|---|---|---|---|
| B1 | conex-types 扩展：AgentMessage/AgentEvent/ToolCall/会话状态机/错误类型 | A1,A2 | 单一类型源，所有 crate 共用 |
| B2 | agent-provider crate：reqwest + SSE 解析；openai-compatible 先行 | B1 | 含错误分类、重试 |
| B3 | session-loop crate：状态机 + steering + control + tool-execution + recovery | B1,B2 | 以 A1 语义文档为实现契约 |
| B4 | orchestrator crate：会话/run 管理、事件队列、持久化（conex-db） | B3 | 替代 TS orchestrator+daemon 的编排面 |
| B5 | agent-tools crate：fs/shell/search 工具注册（复用 conex-*）；MCP 桥（tauri-plugin-mcp） | B1 | |
| B6 | Tauri 集成：commands（run/abort/steer/approve）+ event emit 桥 | B3,B4,B5 | 与 A3 契约对齐 |
| B7 | 集成测试：faux provider 全流程（消息→流→工具→收口；error 路径） | B3-B6 | 覆盖 A1 记录的全部分歧点 |

### Phase C — 前端切换（实现轮，依赖 B）

| 步骤 | 内容 |
|---|---|
| C1 | daemonClient transport 抽象：WS transport 保留为旧实现，新增 Tauri IPC transport（invoke + emit） |
| C2 | EventRouter/事件结构对齐 Rust 事件（结构差异最小化，必要时 Rust 侧做序列化兼容） |
| C3 | 删除 WS daemon 相关前端代码：StreamRecovery、zod 协议层、directFetchBridge、背压逻辑 |
| C4 | 删除 Tauri 壳内 sidecar/WS 转发层（connection/lifecycle、run_stream、supervisor 的 daemon 部分） |

### Phase D — 验证与清场（验证轮 + 实现轮）

| 步骤 | 内容 |
|---|---|
| D1 | Rust 全量单测/集成测试 + clippy 通过 |
| D2 | 端到端冒烟：live model 全旅程（新建会话→发送→文字流→工具调用→正常收口→会话恢复） |
| D3 | 回归对照：按功能清单逐项验证（thinking、审批、MCP 工具、多会话、stop 语义） |
| D4 | 删除 TS 旧包与 CLI runner；更新工作区配置（turbo/package.json/tsconfig 清理） |

### Phase E — 循环收口（每轮必做）

- 汇总当轮输出 → 更新副文档 → 未完成/新发现问题进入下一轮计划。

---

## 3. 分歧点记录（实现时必须逐项决策）

| # | 分歧 | 两拷贝现状 | 决策原则 |
|---|---|---|---|
| D1 | cooperative_stop 的 endReason | runtime: aborted / core: stop | 以用户语义为准：协作式停止 ≠ 错误，但也不应触发续轮 |
| D2 | tool-promise steering | 仅 core 有（regex nudge，本 run 内注入） | 对照 grok 设计：不自动续跑为默认，nudge 注入下一条用户消息 |
| D3 | provider endpoint 选择 | model: 有工具→Responses API；runtime: 恒 chat-completions | chat-completions 已完整支持工具；default=chat-completions |
| D4 | vendor 推理/reasoning-effort 头 | model 有 / runtime 无 | 保留 vendor 检测但独立于请求路径 |
| D5 | stopReason=error 一票否决 | 两拷贝一致（过宽） | 对齐 grok/pi：模型输出与传输错误分离；错误分类+预算内重试 |
| D6 | empty-response 二次即 intervention | 两拷贝一致（过紧） | 参照 pi：纯文字/空响应不导致 run 失败；重试层分类处理 |

---

## 4. 副文档清单

| 文档 | 状态 | 产生轮 |
|---|---|---|
| 00-master-plan.md（本文件） | ✅ 已建立 | — |
| 01-session-loop-semantics.md | ✅ | A1 |
| 02-provider-semantics.md | ✅ | A2 |
| 03-frontend-contract.md | ✅ | A3 |
| 04-crates-inventory.md | ✅ | A4 |
| 05-test-mapping.md | ✅ | A5 |
| 10-phase-b-tasks.md | ✅ | A6 |
| 20-phase-c-tasks.md | ✅ | A6 |
| 30-verification-checklist.md | ⬜ | D 轮前 |

---

## 5. 当前轮次状态（每轮结束时更新）

### Round 1（Phase A 知识采集）— ✅ 完成

| Agent | 角色 | 任务 | 输出 | 状态 |
|---|---|---|---|---|
| A1 | 分析员 | session-loop 语义解构（core vs runtime 并集+分歧） | 01-session-loop-semantics.md | ✅ |
| A2 | 分析员 | provider 层语义解构（model vs runtime） | 02-provider-semantics.md | ✅ |
| A3 | 分析员 | 前端事件协议与 IPC 边界 | 03-frontend-contract.md | ✅ |
| A4 | 分析员 | crates 能力盘点与缺口 | 04-crates-inventory.md | ✅ |

### Round 2（A5 测试映射 + A6 计划补全）— ✅ 完成

| Agent | 角色 | 任务 | 输出 | 状态 |
|---|---|---|---|---|
| A5 | 分析员 | TS 测试资产 → Rust 测试映射 | 05-test-mapping.md | ✅ |
| A6 | 计划评审 | Phase B/C 任务分解补全 | 10-phase-b-tasks.md / 20-phase-c-tasks.md | ✅ |

### Round 3（Phase B 第一批：类型与基建）— ✅ 完成

| Agent | 任务 | 产出 | 验证 | 状态 |
|---|---|---|---|---|
| B1 | conex-types 类型域（事件/消息/状态机/错误/输出分类）+ 序列化测试 | events.rs/message.rs/tool.rs/session.rs/transition.rs/response.rs/error.rs 扩展 + 2 个集成测试 | cargo test -p conex-types 69 绿；clippy 0 告警 | ✅ |
| B1.4 | conex-db schema v3→v4（run/checkpoint/pending_inputs/provider_configs + 11 API） | lib.rs 扩展 + 8 新测试（含迁移测试） | cargo test -p conex-db 33 绿 | ✅ |
| B2.1 | agent-provider crate 骨架 + workspace 调整（删 packages/agent-provider-http、补 conex-telemetry、reqwest stream feature） | crates/agent-provider/ + 根 Cargo.toml | cargo check --workspace 全绿 | ✅ |

### Round 4（Phase B 第二批：provider 传输层 + 工具注册）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| P1 | B2.3 SSE 分帧/传输 + B2.4 流事件类型 | cargo test -p agent-provider 61 新测试全绿 | ✅ |
| P2 | B2.2 配置与凭据模块（DPAPI 抽取） | 31 测试全绿 | ✅ |
| P3 | B5.1 agent-tools 工具注册表 | 17 测试全绿 | ✅ |

### Round 5（Phase B 第三批：解析器/状态机/内置工具）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| Q1 | B2.5 chat-completions 解析器（RU-06/08/09）+ B2.6 请求构建/vendor/thinking | agent-provider 191 测试全绿 | ✅ |
| Q2 | B3.1 状态机内核 + B3.2 输入队列/控制总线（新 crates/session-loop） | 43 测试全绿 | ✅ |
| Q3 | B5.2 fs/shell/search/diff 内置工具（门禁/Windows 包装/路径安全） | agent-tools 62 测试全绿 | ✅ |

全量验证：cargo check --workspace 通过；核心 5 crate 共 398 测试全绿。

### Round 6（Phase B 第四批）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| R1 | B2.7 错误分类与重试器 | agent-provider 311 测试 | ✅ |
| R2 | B2.9 Responses/Anthropic/Gemini 解析器 | agent-provider 85 新测试 | ✅ |
| R3 | B3.3 steering 子系统（D2/D3/D7/D8/D9/D10 全裁决） | session-loop 83 测试 | ✅ |
| R4 | B5.3 输出结构化/幂等守卫 + 最小 executor | agent-tools 102 测试 | ✅ |

### Round 7（Phase B 第五批：B2.8 消费契约 + B3.5 工具执行器）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| S1 | B2.8 消费契约层（D5/D6 裁决：error 不否决、abort 保留、空响应 Empty） | agent-provider 327 测试 | ✅ |
| S2 | B3.5 工具执行器（并行/顺序/超时/失败策略/审批门/fatalOnError 排除清单） | session-loop 93 测试（两次 agent 失败后由调度者直接实现） | ✅ |

### Round 8（Phase B 第六批：B3.4 主循环汇聚点 + B2.10 测试套件）— 部分完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| T1 | B3.4 run 主循环 + 8 handler + 收口决策（D1/D2/D3/D7/D9 全裁决；纯文字 stop 收场锚点测试通过） | session-loop 116 测试全绿 | ✅ |
| T2 | B2.10 provider 测试套件 | 未产出（两次 agent 失败）；后置到验证轮 | ⬜ 后置 |

### Round 9（Phase B 第七批：orchestrator）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| U1 | B4.1 run 生命周期（L2/L3/回落三路径）+ B4.2 事件序列与持久化（run-terminal 唯一终态） | orchestrator 27 测试 | ✅ |
| U2 | B4.4 跨 run 注入（transferTo/steering 优先级）+ 事件归一（runId 注入/终态收敛） | orchestrator 30 测试（lib.rs 被 U1 覆盖后已修复合并） | ✅ |

### Round 10（Phase B 第八批：恢复/测试套件）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| V1 | B4.3 会话树（追加/分叉/叶子移动/rewind 计划）+ 重启恢复（in-flight→interrupted/快照损坏回退） | orchestrator 121 测试 | ✅ |
| V2 | B4.5 orchestrator 集成测试（drive/cancel/approval/store_pending/normalize） | +34 集成测试 | ✅ |
| V3 | B2.10 provider 测试套件（mock server 全链路：四家解析/分类/重试/abort/system_role 重写） | agent-provider 352 测试 | ✅ |

### Round 11（Phase B 第九批：Tauri 集成 + MCP 桥）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| W1 | B6.1 run 命令桥（core_run_task/control/cancel/approve/deny）+ B6.2 查询命令桥（status/snapshot/read-events 分页） | 壳 17 新测试，全量 147 | ✅ |
| W2 | B6.3 事件 emit 桥（workbench-run-event + 背压缓冲：丢 delta 保 terminal，16 项硬依赖锚定） | 壳 18 新测试，130 全绿 | ✅ |
| W3 | B5.4 MCP 桥（stdio JSON-RPC 客户端、mcp_<server>__<tool> 前缀、崩溃检测、30s 超时） | agent-tools 134 测试 | ✅ |

### Round 12（Phase B 收尾：B6.4 启动接线）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| X1 | B6.4 main.rs setup 重写：db→config→engine→restore 初始化、事件桥接线、EngineHandle（HttpProviderCall/SessionLoopProducer）、catch_unwind 降级、sidecar 保留并存 | workspace 全绿（壳 150 测试） | ✅ |

### Round 13（C1.1 transport 抽象 + B7.3 分歧核对）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| Y1 | C1.1 transport 抽象层（Transport 接口 + tauriTransport + daemonWsTransport + 开关） | 31 测试 + typecheck | ✅ |
| Y2 | B7.3 分歧点 D1-D10 正/反向断言 + 30-verification-checklist.md | session-loop 126 / provider 353 全绿 | ✅ |

### Round 14（C1 通道替换四并行）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| Y3 | C1.2 run-task 通道（startRunTask 分派 + 平铺事件兜底 + runId 过滤） | 77 测试 | ✅ |
| Y4 | C1.3 控制通道（core_run_control/core_cancel_run/approve/deny，双线 flag 关闭） | 47 测试 | ✅ |
| Y5 | C1.4 查询通道（core_read_session_events/run_snapshot/read_run_events + WS 分派表） | 73 测试 | ✅ |
| Y6 | C1.5 杂项 RPC（38 处调用点迁移 + commandMap + 22 处未覆盖记录） | 87+2384 测试 | ✅ |

### Round 15（C2 事件对齐三并行）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| Z1 | C2.1 事件结构核对（16 项：12 一致 4 差异，差异项回补单） | 30-verification-checklist.md §4 | ✅ |
| Z2 | C2.2+C2.4 EventRouter 调整（删信封/别名分支、四源失败收敛、stopped reason、error-translation） | 73 测试 | ✅ |
| Z3 | C2.3 审批对齐（shared-types requestId 可选 + toolCallId 键控 + 引用方修复） | 187 测试 | ✅ |

### Round 16（C3 删除层 + C2.5）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| W1 | C3.2 zod 层删除（daemonEventZod/Schema + 5 文件，消费点内联手工解析） | 73 测试 | ✅ |
| W2 | C3.3+C3.4 StreamRecovery/directFetch/背压删除（4 文件 + 16 文件引用清理） | 248 测试 | ✅ |
| W3 | C2.5 hydrate 对齐（clientMessageId 链路核对：发现 Rust 缺口已记录回补单 + 前端兜底） | 32 测试 | ✅ |

### Round 17（Rust 回补 + C3.1 默认翻转）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| X1 | Rust 回补 clientMessageId/assistantClientMessageId 透传 message-end + 基线接线修复 | 壳 163 测试全绿 | ✅ |
| X2 | C3.1 前端默认翻转 Tauri transport + C3.5/C3.6 清理 | 44+ 测试 | ✅ |

### Round 18（C4 sidecar 删除 + 前端 WS 层整删）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| V1 | C4.1-4.3 sidecar/ 整树删除（connection/supervisor/pending/run_stream/commands，17 文件 3863 行） | 壳 139 测试 | ✅ |
| V2 | 前端 WS 层整删（daemonClient.ts/daemonWsTransport.ts + 引用清理，IPC 唯一路径） | 2912 测试 | ✅ |
| V3 | C4.4+C4.5 daemon_discovery/sidecar 剩余/packages/agent-provider-http 删除 + r2d2/tokio-tungstenite 依赖清理（子 agent 中途遇磁盘满，已由调度者清理 target/incremental 42GB 后全量验证） | cargo test --workspace 全绿 | ✅ |

### Round 19（Phase D 清场盘点 + 前端验证）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| A1 | 前端全量验证（vitest 3639/3679，40 失败全基线；修 4 个 flaky；vite build 成功） | 21-phase-c-migration-log.md §6 | ✅ |
| A2 | TS 旧包清场盘点（11 包删除候选 + CLI runner 方案） | 22-phase-d-cleanup-plan.md | ✅ |

### Round 20（前端修复 + Phase D 执行 + 壳构建）— ✅ 完成

| Agent | 任务 | 验证 | 状态 |
|---|---|---|---|
| C1 | 前端 6 个 typecheck 基线错误修复（perfBenchmark/FileViewerCard/useSidebarContextMenu） | npm run typecheck + build 全绿 | ✅ |
| C2 | Phase D 执行：11 个 TS 旧包（1178 文件）+ CLI runner + 配置清理 + package-lock 重建 | turbo typecheck 9 任务全过、depcruise 有效、grep 零引用 | ✅ |
| — | cargo build 壳二进制（live 用） | 构建成功 | ✅ |

### 待办（切换轮冒烟）

| 项 | 说明 |
|---|---|
| S1 | live 冒烟：重启 app（新 Rust 壳 + IPC 前端）→ tauri-mcp 发消息验证"消息→文字流→工具调用→正常收口"（00 §1.3 质量门槛） |
| S2 | 冒烟通过后更新 30-verification-checklist.md 与本文件状态表，收尾 Round |
