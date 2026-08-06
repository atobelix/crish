# D2 — 功能补齐阶段执行方案分析（分轮次结构与工作量评估）

- 分析对象：`docs/feature-gap-analysis/plans/` 下 00 总方案、01~04 分案、reports/F1 轮次报告
- 分析方式：只读；任务单元数按文档任务编号（T-AB / T-CF / T-D / T-EG / T-ESC）实计
- 结论先行：**总任务 63 张任务卡，编排为 F1~F12 共 13 个执行单位（含 F11b 小轮），F1 已完成、当前处于 F2 起点；规模约为 Phase E 的七成（63 卡 vs 93 任务编号），但跨链依赖与新机制密度更高**

---

## 一、分轮次结构总表

口径：任务单元数 = 各分案任务卡编号数（合并分配的任务包仍按卡计，与 00 总方案附录 A 的 63 张统计一致）；Agent 数取自 00 总方案 §3.3 总览表。

| F 轮 | 对应分案轮次（并包） | 目标 | 任务单元数 | Agent 数 | 技术面 | 事件基线 |
| :--- | :--- | :--- | :---: | :---: | :--- | :---: |
| **F1** ✅ | R-AB1 + ESC T-ESC-01/02 | 命令执行三模式 + 输出防溢 + 禁 cd + 注册表底座；逃逸监视数据面/判定面 | 10（T-AB-01~08 + T-ESC-01/02） | 4 | 工具层（shell.rs 流式化/CdShape）、壳层（进程原语/命令恢复）、**新 crate conex-fs watch.rs**、事件注册表 operation 新增 | 31（不变） |
| **F2** ▶ | R-AB2 + ESC T-ESC-03 | 后台任务管理器核心（日志/stdin/终止/归档/工具面/前端）；逃逸监视装配面 | 7（T-AB-09~14 + T-ESC-03） | 4 | 壳层 background.rs 全量、AI 工具面 background_task、前端 API 接线、session-loop 装配 + core_run_commands 钩子 | 31（不变） |
| F3 | R-AB3 + R-CF1 | 资源监控 + 任务域七事件 + 生命周期整合；read_file 防截断 + grep 补缺 | 9（T-AB-15~20 + T-CF-01~03） | 6 | 壳层 resource.rs（新建）、事件注册表 31→38、orchestrator 唤醒、前端任务 UI、工具层 fs.rs/search.rs | **38** |
| F4 | R-D1 + ESC T-ESC-04 | 嵌套裁决三层落地（maxDepth=1）+ REQ-D06 修订；逃逸展示面 | 5（T-D-01~04 + T-ESC-04；T-D-01/02 合并） | 4 | agent-tools/shared-types 双侧守卫、引擎提示词注入、纯文档修订、前端审计展示 | 38（不变） |
| F5 | R-EG1 | multi_replace 工具本体 + 注册/名单 + 注释保留注入段 | 3（T-EG-01~03） | 3 | 工具层 replace.rs（新建）、readonly/backup 名单、subagent_inject | 38（不变） |
| F6 | R-CF2 | 定时器原语 + TimerCondition 早退 | 4（T-CF-04~07） | 3 | conex-types timer.rs（新建）、set_timer 工具 + TimerChannel trait、壳层 timers.rs/engine.rs | **40** |
| F7 | R-EG2 | write_file Overwrite 保护 + 引擎总接线 | 4（T-EG-04~07） | 4 | 工具层 fs.rs 行为变更、壳层语义对齐、**session-loop 总接线点 tool_exec.rs**、conex-db quota store、集成测试 | 40（不变） |
| F8 | R-D2 | 自定义 Agent 类型（五项参数）+ 硬沙箱 + display_label + **权限传递层 T-D-14** | 4（T-D-05/07/08/14；05/07 合并） | 3 | shared-types/agent-tools 契约、conex-db schema 迁移、硬沙箱 WritePathPolicy、审批路由（events.rs 载荷扩展）、前端 AgentTeamBoard | 40（不变） |
| F9 | R-CF3 | Cron 调度 + 等待策略 + 引擎接线 | 7（T-CF-08~14） | 7 | conex-types cron.rs（新建）、壳层 sched.rs/wait_channel.rs/watchdog.rs/wakeup_summary.rs（新建）、idle 续 run、workflow 六命令实装 + 前端去幽灵化 | **41** |
| F10 | R-EG3 | 文档工作区 G01~G03 + 协作产出流程 | 6（T-EG-08~13） | 6 | 工具层 output_dir.rs（新建）/wait_subagents 扩展、docs 约定、.gitignore/配置、G02 端到端测试 | 41（不变） |
| F11 | R-D3 | 批量派发 + 生命周期补缺 + 引擎 spawner 接线 | 3（T-D-06/09/13） | 3 | agent-tools/shared-types 批量原子语义、orchestrator kill_all/resume、壳层生产 SubagentSpawner | 41（不变） |
| F11b | R-D3 后 DAG 小轮 | DAG 只读可视化（纯 CSS/SVG + 开关默认关） | 1（T-D-12，双 Agent 包） | 2 | 壳层查询命令 get_flow_snapshot + 前端 FlowDagView/flowDagStore | 41（不变） |
| F12 | 终验门禁 | 全量验证收敛 + 完成态可机检核验（§8 清单） | 0（无新任务） | 1 | 全仓库门禁串行 | 41（终态） |

**合计**：执行轮 12 + 终验轮 1 = 13 个执行单位；任务卡 **63 张**（T-AB 20 + T-CF 14 + T-D 12 + T-EG 13 + T-ESC 4；T-D-10 不做、T-D-11 暂缓不排入）；Agent 人次合计约 50。

---

## 二、各分案要点

### 01-AB（命令执行与后台任务）—— 20 卡 / 三轮 R-AB1~3

- **任务单元**：R-AB1（T-AB-01~08，命令执行三模式 + 输出防溢 + 禁 cd）、R-AB2（T-AB-09~14，后台任务管理器核心）、R-AB3（T-AB-15~20，资源监控 + 事件 + 生命周期整合）
- **技术面**：agent-tools 工具层（shell.rs 流式化、background_task 五 action）、conex-sandbox 语义层（CdShape 七类）、壳层（process.rs 优雅终止/daemon Job、background.rs 注册表、core_run_commands.rs 生命周期）、conex-types 事件（任务域七事件，31→38）、orchestrator 唤醒、前端 API/UI
- **关键设计决策**：不复活 sidecar WS、不引入 PTY（终端面板与任务系统解耦）；转后台替代超时即杀、资源监控只通知不自动杀；`BackgroundTaskManager` trait 契约先行（仿 subagent_spawner 注入）；落盘 best-effort 降级不失败；kill 两阶段（优雅→强制）与 30 分钟归档保留策略；日志目录三目录约定（tasks/sessions/samples）

### 02-CF（定时唤醒与工具）—— 14 卡 / 三轮 R-CF1~3

- **任务单元**：R-CF1（T-CF-01~03，read_file 防截断 + grep 补缺 + 目录字段）、R-CF2（T-CF-04~07，定时器原语 + 早退）、R-CF3（T-CF-08~14，Cron + 等待策略 + 引擎接线）
- **技术面**：agent-tools 工具层（fs.rs/search.rs/set_timer.rs）、conex-types 时间域（timer.rs/cron.rs + timer-fired/cron-fired 事件登记）、壳层引擎侧（timers.rs/sched.rs/wait_channel.rs/watchdog.rs/wakeup_summary.rs 五个新建模块）、command_manifest 幽灵命令清理、前端 workflow-api
- **关键设计决策**：定时器/Cron 长在既有事件流与控制总线上（不新建第三套消息机制、无独立守护线程）；timer-fired/cron-fired 定级 Critical 必达、timer-cancelled Soft；到期注入走 steering 面而非事件面；contentOffset 以行粒度、二进制走"文件引用"形态（均显式标注为设计决策）；intervalMinutes 转 cron 近似语义；engine.rs 装配收口单点（A3 唯一写者）

### 03-D（多 Agent 调度）—— 14 卡（12 排入）/ 三轮 R-D1~3 + 独立小轮

- **任务单元**：R-D1（T-D-01~04，嵌套禁止 + 提示词结构化 + REQ-D06 修订）、R-D2（T-D-05/07/08 + T-D-14，自定义类型 + 硬沙箱 + 权限传递层）、R-D3（T-D-06/09/13，批量 + 生命周期 + spawner 接线）、独立小轮 T-D-12（DAG 可视化）；T-D-10 已决策不做、T-D-11 已决策暂缓
- **技术面**：agent-tools/shared-types 双侧（maxDepth、批量原子语义、SubagentDefinition）、conex-db schema 迁移（task_type/display_label/allowed_write_paths_json）、硬沙箱 WritePathPolicy、conex-types 事件载荷扩展（PermissionRequest）、session-loop ApprovalGate 路由、壳层生产 SubagentSpawner、前端 AgentTeamBoard/FlowDagView
- **关键设计决策**：嵌套禁止落地为守卫/工具面/提示词三层（maxDepth=1，仅主 Agent 可派发）；REQ-D06 从"纯内存"修订为分层持久化 + Critical 落库可重放；D04 九参数收敛为五项；**权限传递层（T-D-14，用户定夺核心新设计）**：子代理审批默认路由给主 Agent 裁决（复用 ApprovalGate 只改"谁裁决"，约 3 处小改）；DAG 可视化纯 CSS/SVG + `flow_dag_visible` 开关默认关（关闭零挂载可随时下线）；多模型仅预留 `model_override` 扩展点

### 04-EG（编辑工具与文档工作区）—— 13 卡 / 三轮 R-EG1~3

- **任务单元**：R-EG1（T-EG-01~03，multi_replace 本体 + 注册 + 注释保留）、R-EG2（T-EG-04~07，Overwrite 保护 + 引擎总接线）、R-EG3（T-EG-08~13，文档工作区 G01~G03）
- **技术面**：agent-tools（replace.rs/output_dir.rs 新建、fs.rs 行为变更、wait_subagents 载荷扩展）、session-loop 总接线点（tool_exec.rs:670-687，write_claims/中间件链/配额从全 None 变接线）、conex-db quota store、壳层语义对齐、前端 workspaceFsApi、根 .gitignore、docs 约定文档
- **关键设计决策**：multi_replace 是全新设计而非恢复（现状已证伪"重构遗失"）；统一编辑面模型（write_file/multi_replace/delete_file 同走 路径校验→互斥声明→配额检查→内容操作→原子落盘 链路）；注释保留双保险（工具级精确匹配 + 提示词注入段）；write_file 默认拒绝覆盖是**全模块唯一改变既有调用行为**的需求（先行落地全量回归）；输出目录 `.agent-outputs/<YYYY-MM-DD>-<session_id>/` 带日期、惰性创建、删除会话走 trash 回收站、只读子代理不自选目录

### 逃逸监视链（T-ESC，跨 F1/F2/F4）

- T-ESC-01 数据面（conex-fs WorkspaceWatcher，notify 封装 + 排除清单 + Rename 聚合 + flush 线程）→ T-ESC-02 判定面（RegistryBackedDetector，session-loop 新建模块 + SecurityAuditOperation::UndeclaredWrite 登记）→ T-ESC-03 装配面（run 起停钩子 + SessionLoopOptions）→ T-ESC-04 展示面（前端 SecurityAuditSection 文案与着色）；T-ESC-05 二期指纹复核已决策暂缓
- 关键交接点：F2 时 write_claims 未接线，判定器以"工具审计覆盖"兜底；**F7 总接线点装配 Arc\<WritePathRegistry> 时必须同时注入判定器**（00 总方案 §3.10，已写入 F7 轮次报告核对项）

---

## 三、F1 轮次报告进度（reports/F1-轮次报告.md）

| 项 | 结果 |
| :--- | :--- |
| 轮次 | F1 = R-AB1（T-AB-01~08）+ ESC T-ESC-01/02；4 Agent / 4 任务包（A1 agent-tools / A2 conex-sandbox / A3 壳层 / A4 逃逸域） |
| 完成度 | **4 任务包全部完成，未完成 = 无**；门禁通过；事件基线 31 不变（仅新增 operation 值，注册表/生成物已同步） |
| 验证 | 全仓 workspace 73 套件全绿不回归；agent-tools 340+14、sandbox 58+11、workbench 243、conex-fs 43、session-loop 等全绿；前端 manifest 8 测试通过 |
| 已知污染 | `npm run typecheck` 失败来自并行域（tiptap 依赖未 install、ChatComposer/SlashExtension），非 F1 产物 |
| 新发现（摘） | PowerShell stderr CLIXML 噪音；adopt 失败孤儿风险（F2 T-AB-11 补 reap）；BufReader 缓冲丢失规避；Unix 树杀仍单进程；notify Windows 事件语义（Rename=两事件）；`Sender::close` 是 Receiver 方法（stop 改 unwatch+flush）；engine-events.json 长期被 .gitignore 忽略（已 force-add，L6 待仓库级评审） |
| 遗留（摘） | L1/L2：background.rs 落盘/行号/终止/归档占位 → F2 T-AB-09~12；L4：判定器第二基准 write_claims 接线点 → F7 T-EG-06；L8：status.tail 口径核对 → F2 |
| 下一轮输入 | F2 = T-AB-09~14 + T-ESC-03（B1 接管 background.rs、B2 工具面、B3 前端、B4 装配面）；事件 changelog 与入库策略随 F2 登记 |

**当前状态**：F1 已收口，F2 为下一执行轮（4 Agent，文件所有权已交接：background.rs → B1，agent-tools/background.rs 契约冻结 B2 只读）。

---

## 四、总体规模评估（相对 Phase E）

参照系：`docs/rust-rewrite/30-phase-e-master-execution.md`（Phase E 主执行方案，E0~E8 九轮，2026-07 底至 08-01 完成）。

| 维度 | Phase E（rust-rewrite） | 功能补齐阶段（本方案） | 对比 |
| :--- | :--- | :--- | :--- |
| 任务书/分案 | 12 份（PE-01~12） | 4 分案 + 逃逸链（00 总方案编排） | 分散度更高，跨 4 条链（AB/ESC、CF、D、EG） |
| 任务单元数 | 约 93 个任务编号（PE-01~09 合计 93，部分合并/作废） | **63 张任务卡**（含 T-ESC 4） | **约 0.68×**，规模约为 Phase E 七成 |
| 执行轮次 | 9（E0~E8，含终验轮 E8） | 13（F1~F12 + F11b 小轮） | 轮次数多 44%，因多链并行编排与热点文件所有权转移更细 |
| 单轮 Agent 峰值 | ≤12 | F9 峰值 7 | 单轮并发低，但轮间依赖串行更长 |
| 事件/契约面 | schemaVersion=1 一次定稿，25 golden fixtures | 事件基线 31→38→40→41 累计演进 3 次 | 注册表漂移护栏 + changelog 每轮登记，契约面更重 |
| 新增机制 | 真增量流、命令注册表单一化、错误协议统一（主要是既有面收束） | 逃逸监视（新 crate conex-fs）、定时器/Cron（conex-types 新域）、权限传递层、文档工作区（全新机制） | **新机制密度更高**，Phase E 以收束/打磨为主，本方案以新增能力为主 |
| 行为变更面 | 少量（沙箱根、门禁重设计） | write_file 默认拒绝覆盖（唯一跨面行为变更）+ overwrite 语义、嵌套禁止 maxDepth=1 | 需全量回归的破坏性改动少但集中 |
| 前端面 | 组件化大轮（E6）等 | 每轮分散前端接线（B3/C4/D4/AgentTeamBoard/workflow-api/FlowDagView） | 前端总量相当，分布更均匀 |
| 验证模式 | 每轮门禁 + E8 终验 | 每轮门禁 + F12 终验（§8 可机检清单 30 项，自动化/静态断言/行为锚点三层） | 终验清单化程度更高 |

**工作量判断**：

1. 任务数量约为 Phase E 的七成，但**跨链依赖（§3.2 依赖总图）与文件所有权转移（§3.17，20 余个热点文件跨轮串行）是本方案的主要复杂度来源**——轮次数量反超 Phase E，单轮验证门禁成本高（73 套件基线 + 注册表漂移护栏 + 前端基线失败集对照）。
2. F1 实测参考：4 Agent 并行完成 10 卡，新增约 42 个 Rust 测试 + 13 条新发现，workspace 基线不回归——单轮吞吐与 Phase E 的 E0/E1 相当，可推估 F2~F4 同量级，F9（7 Agent、六命令实装 + 装配收口）与 F10（端到端协作）为工作量峰值轮。
3. 预估总投入约 50 Agent 人次；按 F1 的节奏（1 轮约 1 个工作日含门禁），乐观路径 F1~F12 约 10~14 个工作日，其中 F9 与 F12 门禁串行不可压缩。
4. 风险点：① F2 与并行域的 core_run_commands.rs 冲突已登记（F1 新发现 12/13）；② F7 总接线点跨 ESC/EG/D 三方契约，为全阶段耦合最重的一轮；③ 前端 typecheck 基线污染需在 F2 前与并行域协调清账；④ 事件注册表累计演进（3 次改写断言）要求每轮断言一次到位，漂移护栏纪律是本阶段最大的纪律约束。

---

## 五、文档索引

- 总方案与轮次编排：`docs/feature-gap-analysis/plans/00-总方案与轮次编排.md`（§3.3 总览表 / §3.16 事件基线 / §3.17 所有权表 / §八 完成态判定）
- 分案：01-AB（T-AB-01~20）、02-CF（T-CF-01~14）、03-D（T-D-01~14）、04-EG（T-EG-01~13）
- 进度：`docs/feature-gap-analysis/plans/reports/F1-轮次报告.md`
- 参照：`docs/rust-rewrite/30-phase-e-master-execution.md`、`docs/rust-rewrite/23-architecture-hardening-plan.md`
