# 23 — 架构强化与规范化方案（Phase E：硬编码清理 · 流式渲染 · 三端适配 · 可观测性）

> 状态：已建立（Round 21 规划）
> 前置事实：00-master-plan.md（Rust 化主方案，Phase A-D 已完成：引擎进程内、IPC 单路径、TS 旧包已删）
> 审计输入：24-markdown-streaming-audit.md（流式渲染）、25-ipc-contract-audit.md（IPC 契约）、26-frontend-observability-audit.md（组件与可观测性）
> 本方案只描述**逻辑执行顺序**；每轮 ≤12 Agent；输出闭环迭代，规则同 00 主方案 §1。

---

## 0. 目标与原则

**总体目标**：在已完成的 Rust 化基础上，完成"规范化统一"——消除全部硬编码与兼容层，抽象先行，功能归类去重，全面增强可观测性，并把后端收敛为可同时服务 Web / GUI / TUI 三种界面的引擎契约面。

**六条原则**（对应需求，规范化表述）：

| # | 原则 | 含义 |
|---|---|---|
| R1 | 单一真源 | 每个事实（配置、状态、命令名、错误码、渲染结果）只有一个权威来源；其他位置一律引用或投影，禁止复制 |
| R2 | 接口契约化 | 跨层边界（前后端 IPC、引擎内部模块、渲染与数据）全部以显式契约（schema/注册表）定义，消灭隐式约定 |
| R3 | 分层清晰 | 引擎层 / 契约层 / 传输层 / 界面适配层严格分离；界面（web/gui/tui）只依赖契约层 |
| R4 | 零兼容 | 兼容别名、双路径、legacy 分支、死面命令一律删除；改坏面即改契约，不保过渡 |
| R5 | 可观测 | 一切运行路径可追踪：结构化日志（会话/运行上下文注入）、错误全链路类型化、启动与运行状态可查询 |
| R6 | 增量渲染 | 流式输出以 markdown 直接增量渲染，杜绝"先原文后整篇"的伪流式 |

---

## 1. 现状诊断（审计结论摘要）

### 1.1 流式渲染（24 号审计）
- **伪流式成因**：`AsyncMarkdownBlock.tsx:51-59` 流式态渲染纯文本 div；`renderTarget = isStreaming ? '' : text`（:34）流式期间渲染短路；markdown 只在消息结束后经 Rust `md_render` 整篇渲染替换。
- **能力已就绪但零消费**：JS 增量解析器（IncrementalMarkdownParser/InlineRenderer/DomRenderer，40+ 测试）、`useStreamRenderThrottle`、`markdownPreload`、Rust `md_render_stream`（stream_mode 跳过 syntect、未闭合 fence 软闭合）全部存在，仅缺接线。

### 1.2 启动状态与配置（25 号审计）
- **"本地密钥待同步到引擎"恒真**：Rust `CoreStatus` 不返回 provider/apiKey 字段（:49-62），前端缺省 `hasApiKey=false`（engineConfig.ts:424-429）；引擎已进程内，双配置概念已死，但 `syncActiveProfileToEngine` 仍在跑；提示永不消失。
- **配置真源双轨**：localStorage profiles 真源 + Rust ApiConfigStore（DPAPI）死面（7 个配置命令前端零调用）。
- **启动状态机重复**：AppBootstrap 与 useEngineBootstrap 逐字重复；12s gateTimer 与 15s 离线兜底互相矛盾。

### 1.3 IPC 接口面（25 号审计）
- 79 个已注册命令；调用方式四类不统一（commandMap 22 条 / 直接 invokeResult 25+ 处 / 插件直调 / transport 内直调）。
- commandMap 含 9 个"已注销但未清理"的幽灵条目；22 条调用点 Tauri 下必抛"命令不可用"。
- 错误协议不统一：CoreError 只覆盖部分命令，其余返回 String/自定义 struct。

### 1.4 组件与可观测性（26 号审计）
- 前端 180 组件无基础库分层：弹窗 7 套、菜单 10 套重复；99 个文件残留 daemon/WS 命名；`LoggerService` 0 调用；裸 console 137 处。
- **Rust 可观测性最严重**：conex-telemetry（tracing/panic hook）**从未接线**（main.rs 零调用），全 Rust 运行期实际零日志；18 个 crate 仅 3 个依赖 tracing；错误体系双轨（CrishError 建成但 orchestrator/session-loop/conex-db 各自为政）。

---

## 2. 目标架构（三端适配）

```
┌──────────────────────────────────────────────────────────────┐
│ 引擎契约面（后端，Rust 进程内）—— web/gui/tui 三端共用        │
│   core_* 命令（run/control/approve/session/event/status/config）│
│   workbench-run-event 事件通道（sequence + runId 注入）        │
│   CoreError 统一错误协议                                        │
│   conex-telemetry 全链路可观测（sessionId/runId span 注入）     │
└──────────────┬───────────────────────────┬────────────────────┘
        ┌──────▼───────┐           ┌────────▼────────┐
        │ GUI (React)  │           │ TUI (规划)      │
        │ 渲染适配层    │           │ 渲染适配层      │
        │ workbench_*   │           │ 仅依赖契约面    │
        │ 仅 GUI 能力   │           │                 │
        └──────────────┘           └─────────────────┘
```

- **引擎契约面** = core_* + config_* + session_* + workbench-run-event + CoreError（三端共用）。
- **GUI 专属** = workbench_*（fs/pty/process/power/host 等桌面能力）。
- **Web 形态** = 同一契约面的 HTTP/WS 适配（可后续由网关暴露，本轮只保证契约纯净）。
- **TUI 形态** = 直接消费契约面（命令 + 事件通道），渲染层独立。

---

## 3. 执行计划（逻辑执行顺序）

### E1 — 配置与启动状态真源归一（消除"待同步到密钥"）
| 任务 | 内容 |
|---|---|
| E1.1 | `core_get_status` 回补 provider 字段（providerId/model/baseUrl/hasApiKey: Option<bool>，缺失=未知非 false）；新增 `core_get_config_status` 或并入 status |
| E1.2 | 前端：`parseEngineStatusFromRaw` 按 Option 语义解析；删除 `syncEngine` 提示分支（ChatStatusRibbons.tsx:290 文案）与 `syncActiveProfileToEngine` 启动调用 |
| E1.3 | 配置真源迁移：localStorage profiles → Rust ApiConfigStore（DPAPI）单真源；前端设置读写走 core 配置命令；迁移后删除 localStorage 明文 key 路径 |
| E1.4 | 启动状态机合并：AppBootstrap/useEngineBootstrap 双副本合一；isCoreReady 明确聚合（engineReady ∧ dbReady）；删除互相矛盾的 gateTimer 与 15s 兜底 |
| E1.5 | 测试：设置保存→重启→状态一致；无 key 时提示"未配置"而非"待同步" |

### E2 — 流式 markdown 直接渲染（增量渲染接线）
| 任务 | 内容 |
|---|---|
| E2.1 | 接线 JS 增量解析器：AsyncMarkdownBlock 流式态改用 IncrementalMarkdownParser 增量渲染（代码块未闭合时软渲染：fence 行原样+语法高亮跳过） |
| E2.2 | 完成态权威渲染：消息结束 → Rust `md_render` 权威整篇渲染替换（增量态与完成态差异最小化：同一渲染器语义） |
| E2.3 | 渲染节流：useStreamRenderThrottle 接入（增量渲染按帧节流，避免每 delta 重渲染）；StreamRenderBuffer 的 frame.html 通道启用或删除死通道 |
| E2.4 | 性能验证：长文本（≥10k 字符）流式期间渲染帧率与完成态一致性测试；增量态与完成态视觉对比（fence/表格/列表边界） |
| E2.5 | Rust `md_render_stream` 若不被使用则删除；或统一为"完成态唯一入口"（二选一，删除死面为默认） |

### E3 — IPC 接口面收束（契约化 + 三端边界）
| 任务 | 内容 |
|---|---|
| E3.1 | 命令注册表单一化：新增 Rust 侧命令清单导出（register 的完整 core_* 清单），前端 commandMap 由清单驱动（启动时拉取或编译期生成），消灭幽灵条目 |
| E3.2 | 调用方式统一：25+ 处直接 invokeResult 全部收敛到 transport（或 commandMap 单通道）；rustCore/sessionRustDb/pty 直调层归位 |
| E3.3 | 错误协议统一：全部命令返回 CoreError {kind, detail}；删除 String 错误返回（perf_*/pty/config/fs 等）；错误码与 conex-types 77 码对齐 |
| E3.4 | 命名规范：命令统一 core_*（引擎契约）与 workbench_*（GUI 专属）前缀；daemon 残留命名清理 |
| E3.5 | 死面清理：零调用的 7 个配置命令、9 个幽灵命令映射、22 条不可用调用点的降级分支——逐一判定（回补实现或删除调用与降级） |
| E3.6 | TUI 边界固化：文档化引擎契约面清单（命令+事件+错误）；契约面变更走版本化 changelog |

### E4 — 可观测性全面增强
| 任务 | 内容 |
|---|---|
| E4.1 | **接线 conex-telemetry**：main.rs 初始化 tracing subscriber（init_default/install_panic_hook/panic→崩溃文件）；确认全 Rust 运行期日志落盘（文件 + stdout 双通道） |
| E4.2 | 日志约定：span 注入 sessionId/runId（session-loop/orchestrator 关键路径 instrument）；事件发射点 trace 级；决策点（steering/retry/recovery）info 级 |
| E4.3 | 错误体系单一下沉：orchestrator StoreError / session-loop LoopError / conex-db DbFailure 全部并入 CrishError 体系（保留各自 thiserror 变体但实现 From 与统一 payload {kind, detail}） |
| E4.4 | 前端日志统一：LoggerService 接线或删除；裸 console 收敛到 streamDiag 模式（结构化前缀 + 级别）；删除 99 处 daemon/WS 命名残留中的日志相关 |
| E4.5 | 启动/状态可观测：core_get_status 扩展 diagnostics 段（引擎各子系统就绪状态、最近错误）；前端设置页"状态诊断"面板展示 |

### E5 — 前端组件化与债务清理
| 任务 | 内容 |
|---|---|
| E5.1 | 基础组件库分层：新建 ui 原子层（Button/Input/Dialog/Menu/Tooltip/Select 单实现）；7 套弹窗/10 套菜单收敛为原子层单实现（按使用频次优先收敛） |
| E5.2 | 目录化收尾：60 个顶层扁平组件归入 28 个域子目录；删除 FilesCard/OverviewCard 等 shim 层 |
| E5.3 | 大组件拆分：ChatStatusRibbons(864)/10 个 600+ 行组件按域拆分（状态提示/操作区/渲染区） |
| E5.4 | 样式规范化：硬编码 hex 收敛到 tokens.css 设计令牌（themeStore 225 处集中迁移）；全局 28 文件与 CSS Modules 双轨合并 |
| E5.5 | 命名债务：daemon/WS 命名的 99 个文件与目录重命名（api/daemon-chat-bridge → api/chat-bridge 等），纯机械重命名+引用更新 |
| E5.6 | 死代码清理：LoggerService、未消费的 StreamRenderBuffer 死通道、未引用组件（grep 零引用即删） |

### E6 — 抽象完善与功能去重
| 任务 | 内容 |
|---|---|
| E6.1 | 重复实现合并：启动状态机（E1.4）、AsyncMarkdownBlock 渲染路径（E2）、模型选择/服务商管理（ModelPicker 与设置面板模型 tab 合并或分层） |
| E6.2 | 函数与构造体打磨：Rust 侧核心构造体（AgentSessionLoop 选项、ToolBatchOptions、RunOutcome）字段评审——删未用字段、补缺省语义、构造器默认值规范化 |
| E6.3 | 前端 store 分层评审：13 个 zustand 实例的职责边界、facade 门面完整性（SessionFacade/WorkspaceFacade/SettingsUiFacade 对齐） |
| E6.4 | 功能归类：重复工具能力（前端 git 本机实现 vs 命令面）收敛到单一实现 |

### E7 — 三端适配验证（TUI 前置）
| 任务 | 内容 |
|---|---|
| E7.1 | 契约面清单成文（core_* 命令签名 + 事件 schema + CoreError），作为 TUI 开发输入 |
| E7.2 | 契约面独立可测：契约测试（命令请求/响应/错误 golden）与界面解耦 |
| E7.3 | 冒烟回归：GUI 全旅程 + 契约面直连测试（模拟 TUI 客户端：直接调 core_run_task + 消费事件通道，验证无 GUI 依赖） |

---

## 4. 执行规则

- 沿用 00 主方案 §1 多 Agent 章程：每轮计划→分配→并行执行→汇总→验证→补全；每轮 ≤12 Agent。
- 每轮验证门槛：Rust `cargo test --workspace` + 前端 vitest 相关套件 + typecheck；涉及删除的必须有 grep 零残留确认。
- 硬编码清理原则：删除前必须确认无行为依赖（grep 消费方）；无法判定的记为"待确认"不擅自删。
- 本方案完成后，更新 00 主方案 §4 副文档状态表与 §5 轮次表。

---

## 5. 副文档状态

| 文档 | 状态 |
|---|---|
| 23-architecture-hardening-plan.md（本文件，总纲） | ✅ 已建立 |
| 24/25/26-markdown-streaming/ipc-contract/frontend-observability-audit.md | ✅ 审计完成 |
| audits/AA-01 至 AA-08（八份代码审查，217 问题） | ✅ 审查完成（问题已全部落任务或登记） |
| audits/AU-01 至 AU-03（交叉/覆盖/可执行性审计） | ✅ 审计完成 |
| audits/AU-04-interface-freeze-decisions.md（接口冻结与去重裁决） | ✅ 裁决完成；契约测试覆盖矩阵已落盘 contracts/ |
| plans/PE-01 至 PE-12（十二份执行任务书，v2） | ✅ 全部执行完毕（PE-12 归一后仅 T12.8 生效） |
| 30-phase-e-master-execution.md（主执行方案 E0-E8） | ✅ E0-E8 全部完成（2026-08-01） |
| 31-security-baseline.md（安全基线） | ✅ 已发布（T07.7） |
| 32-upgrading-migration.md（升级迁移文档） | ✅ 已产出（UPGRADING.md） |
| 33-event-schema-changelog.md（事件 schema 版本化） | ✅ 已产出（T03.10） |
| 34-cleanup-closure.md（清理收尾清单） | ✅ 已产出（T06.13/T05.8） |

## 6. Phase E 执行总结（2026-08-01）

- **审查**：8 份代码审查（217 问题）+ 3 份方案审计 + 1 份接口冻结裁决
- **执行**：12 份任务书、约 60+ 子任务、E0-E8 八轮（每轮 4-8 个并行 Agent）
- **成果**：阻塞 5（门禁绕过/沙箱根/会话落库/级联删除/cancel-siblings）全修复；锁中毒 37 处、命令门禁三层管线、沙箱真源化、密钥 DPAPI 迁移、MCP socket 加固；流式 markdown 增量渲染（首 token 2.44s→817ms）、审批并行 -80%、克隆 O(n²)→O(1)；命令契约面 69 条与 manifest 零漂移、全命令 CoreError、事件 schemaVersion；Rust 日志落地 + span 注入；ui 原子层 7 组件 + 弹窗/菜单收敛 + 10 大组件拆分 + 136 文件目录化 + 命名归零；测试体系（契约测试 33+、压力 11、基准 5、e2e 7 spec、三层 CI）
- **遗留**：T09.4/T09.5 性能项、前端 4 个基线失败、2 个快照待更新（均已文档化登记）
