# D1 — 功能差距分析战役：功能全景总览

> **文档性质**：需求分析产物（只读调查，不涉及代码改动）
> **输入**：`docs/feature-gap-analysis/` 下 8 份文档（1 份需求规格母文档 + 4 份模块现状分析 + 3 份配套调研/专题）
> **产出日期**：2026-08-04
> **用途**：为功能落地排期、任务书拆解（`plans/PE-*.md`）与架构决策提供全景视图

---

## 一、文档地图：8 份输入的角色

| 文档 | 角色 | 结论要点 |
| :--- | :--- | :--- |
| `REQ-agent-engine-capabilities.md` | **需求规格母文档** | 8 模块（A~G）30 条需求，P0×17 / P1×13 / P2×2，7 条设计原则（反过度设计、以事实为依据、不误杀、保留注释、减少人工干预、非放弃既有功能、架构纯洁性优先） |
| `REQ-AB-现状分析.md` | 模块 A+B 现状分析 | A ≈ 25% 已实现（仅同步路径）、B ≈ 0%；8 项真 gap（G1~G8）；三阶段实施 |
| `REQ-CF-现状分析.md` | 模块 C+F 现状分析 | C01/C02 缺口、C03 死 UI、C04/C05 部分；F01 部分、F02 缺口、F03 基本满足；10 项 gap（G1~G10）；四阶段实施 |
| `REQ-D-现状分析.md` | 模块 D 现状分析 | 完成度 ≈ 60%；P0×3 / P1×3 / P2×4 十项 gap；5 处与需求文档冲突 |
| `REQ-EG-现状分析.md` | 模块 E+G 现状分析 | E 三需求全未实现；G 契约半有半无、核心机制缺失；9 步实施，约 8~12 人日 |
| `REQ-逃逸追踪分析.md` | 配套专题：脚本逃逸追踪 | 现状完全不可追踪；主方案 notify 实时监视 + 声明基准比对，P1~P5 五阶段 |
| `调研-权限传递层.md` | 配套调研：子代理权限 | 用户决策「默认权限集 + 申请传递层」；9 项参数收敛为 5 项；改动量 ≈ 3 处小改 + 默认集装配 |
| `调研-可视化与扩展点.md` | 配套调研：可视化/扩展点 | DAG 可视化做（0.5~1 任务卡）；多模型不做只留字段；输出目录命名带日期 |

**模块字母含义**：A=命令执行与进程生命周期、B=后台任务管理、C=定时调度与反应式唤醒、D=多 Agent 协同调度、E=代码编辑与文件操作工具增强、F=搜索/读取/防截断工具、G=文档工作区与多 Agent 协作产出。

---

## 二、功能域 A+B：命令执行与后台任务

**目标**：让 Agent 的命令执行从「同步等待 + 超时树杀」单一模式，进化为「同步 / 超时自动转后台 / 守护进程」三模式，并具备后台任务的全生命周期管理（列表、状态、日志、交互输入、终止）与进程健康感知（资源监控、防误杀）。

### 2.1 功能点清单（按需求编号，共 9 条 14 项）

**模块 A（REQ-A01~A05）**
- [ ] A01-1 同步等待模式：现有实现 ✅（无需改动）
- [ ] A01-2 超时自动转后台：等待窗口（`WaitMsBeforeAsync`）内完成返回结果；超时升级为后台任务、返回唯一 TaskID、释放 AI 执行线程
- [ ] A01-3 守护进程模式（`IsDaemon`）：常驻运行不被超时回收，stdout/stderr 持续写日志，仅显式 kill 或用户终止才停
- [ ] A02 禁止 `cd`：语义层新增 `CdShape`，识别 `cd` / `Set-Location` / `pushd` 及复合链，拦截并引导「请使用 Cwd 参数」
- [ ] A03 输出防溢出三件套：① `PAGER=cat` 环境注入（防 `git log` 挂起）；② 截断后完整日志落盘 + 结果返回 `logPath` + 文案告知；③ 高输出命令建议限制参数（可选增强）
- [ ] A04 资源监控与健康判定：CPU / RSS / I/O / 最近输出时间四指标采样（`ResourceSample`），「疑似卡死 / 异常退出」判定三态，通知 AI（默认不自动杀，仅通知）
- [ ] A05 命令日志持久化：会话日志目录约定、行数 checkpoint 索引、read_log 尾部/行号读取、摘要生成

**模块 B（REQ-B01~B04）**
- [ ] B01 后台任务列表：任务注册表、task_id、状态机（含 30 分钟终态归档），AI 工具 + Tauri 命令双查询面
- [ ] B02 任务状态与日志检查：status 组装（含资源快照、prompt 字段、logPath）+ 日志尾部/行号读取
- [ ] B03 交互式标准输入注入：stdin 管道托管、`send_input(task_id, text)`（默认追加换行）、`[Y/n]` 等提示模式检测（行尾正则）+ nudge 排队通知 AI（不引入 PTY）
- [ ] B04 任务终止：优雅（去 /F）→ 5s 等待 → 强制两阶段终止；`KillResult` 三态（Killed / AlreadyExited / Failed）；kill 后日志保留

### 2.2 规模估计（来自 REQ-AB §12.2/12.3）

- **新模块**：1 个——`apps/agent-workbench/src-tauri/src/background.rs`（BackgroundTaskRegistry / TaskHandle / BackgroundTaskManager）
- **新契约**：1 个——`crates/agent-tools/src/background.rs`（trait + 数据结构，`BuiltinToolConfig.background_manager` 注入，仿 subagent_spawner 先例）
- **新工具面**：1 个——`background_task` 工具（action: list/status/read_log/send_input/kill）
- **新 Tauri 命令**：3 条——恢复 `workbench_list_background_tasks` / `workbench_get_background_task_output` / `workbench_cancel_background_task`（新契约，不复活 sidecar WS 协议）
- **改造面**：`shell.rs`（流式读取 + 三模式入口）、`conex-sandbox/semantics.rs`（CdShape）、`process.rs`（优雅终止变体 + daemon Job 恢复）、`main.rs`（命令登记）
- **新数据结构**：`ResourceSample`、`KillResult`、`TaskHandle`、任务状态机
- **前端**：清理 `backgroundTasksApi.ts` 等死代码面 + 恢复 invoke 契约
- **前置技术债**：`wait_with_output` 收口式读取 → 流式读取（G2，阻塞 G4~G7 全部后台化改造）

---

## 三、功能域 C+F：定时调度与搜索读取工具

**目标**：给 Agent 引擎装上「时间维度」（定时器、早退条件、Cron、反应式唤醒、等待策略）与「信息获取维度」（全局检索、完整读取、目录列举），让 AI 具备自动化值守与可信感知能力。

### 3.1 功能点清单（模块 C 5 条 + 模块 F 3 条）

**模块 C（REQ-C01~C05）**
- [ ] C01 单次定时器：`set_timer` 工具 + TimerChannel + TimerRegistry（到期经 followUp 环注入，`timer_*` session_meta 持久化）
- [ ] C02 智能早退条件：TimerCondition（never / any / sender）+ 冲突检测 + 早退查表
- [ ] C03 周期性 Cron 调度：5 段式解析器（conex-types 纯函数）+ SchedulerRegistry + MaxIterations / IsDaemon + workflow 命令实装（消除前端幽灵命令）
- [ ] C04 反应式唤醒：run 级事件驱动已完备；补齐定时器/Cron 唤醒源 + 会话级 idle 待命（收口后查队列/定时器自动续 run）+ 唤醒摘要标准化（6 类事件模板）
- [ ] C05 AI 等待策略自动选择：三模式契约 + 持久化已齐；补 `SubagentWaitChannel` 引擎接线 + 兜底 watchdog（声明超 N 分钟未终态 → steering 唤醒）+ 策略辅助

**模块 F（REQ-F01~F03）**
- [ ] F01 全局检索增强：文件级模式（matchPerLine=false）、排除 glob（excludeGlobs）、截断引导文案（已有：双模式/大小写/glob/上限）
- [ ] F02 防截断读取（重点）：行号范围 + maxLines + 完整行边界截断 + ContentOffset 续读闭环 + 二进制文件引用
- [ ] F03 目录列举补齐：DirEntry 增加相对路径 `path` 字段 + 目录子项 `count` 字段（text 视图不变）

### 3.2 规模估计（来自 REQ-CF §6.2/6.5，10 项 gap → 9 张任务卡）

| 梯队 | 内容 | 落点 | 量级 |
| :--- | :--- | :--- | :--- |
| 独立先行（F） | F02 防截断核心改造 | `fs.rs` ReadFileTool | 中 |
| 独立先行（F） | F01 grep 增强 | `search.rs` | 小 |
| 独立先行（F） | F03 字段补齐 | `fs.rs` DirEntry | 小 |
| C 公共底座 | `SubagentWaitChannel` 引擎侧实现 | workbench/orchestrator + BuiltinToolConfig 注入 | 中 |
| C 公共底座 | set_timer 工具 + TimerChannel + TimerRegistry | 新工具 + session-loop 注入 | 中 |
| C 公共底座 | TimerCondition + 冲突检测 | 并入 TimerRegistry | 小-中 |
| 唤醒收口 | 会话级 idle 自动续 run | `core_run_commands.rs` + steering_queue | 中 |
| 唤醒收口 | 唤醒摘要标准化 | conex-types 新类型 + 模板映射 | 小-中 |
| 唤醒收口 | 兜底 watchdog | 引擎侧 tokio 任务 | 小 |
| Cron | Cron 引擎 + workflow 命令实装 | conex-types 解析器 + workbench 调度器 + 前端桥 | 大 |

- **新组件**：TimerRegistry / TimerChannel、Cron 解析器 + SchedulerRegistry、唤醒摘要映射模块、watchdog 任务
- **新工具**：`set_timer`（1 个）
- **开放裁决项 4 个**：contentOffset 粒度（字节 vs 行）、二进制读取形态（base64 vs 文件引用）、Cron IsDaemon 会话归属（与模块 B 联动）、idle 续 run 边界（硬条件：队列空 + 定时器表空不续）

---

## 四、功能域 D：多 Agent 协同调度框架

**目标**：把已经远超规格的调度内核（DAG、事件驱动等待、恢复阶梯、事件基础设施）补上「外围控制面」——派发、权限、隔离、生命周期管理——并执行两处用户裁决（嵌套深度、事件持久化）。

### 4.1 功能点清单（REQ-D01~D08，按 gap 列表）

- [ ] P0-1 引擎侧 `SubagentSpawner` 接线（D01 落地前提）：守卫快照 → 落库 → 独立 run 启动 → 终态回传（D01 从工具层到引擎层的打通）
- [ ] P0-2 嵌套深度裁决执行：maxDepth 3→1（Rust + TS 双端 + 测试 + 工具面剔除 run_subagent + 文档，共 8 个改造点）
- [ ] P0-3 并发上限对齐：maxConcurrent 6→12（会话级硬上限，兄弟并发维持 5，需用户裁决）
- [ ] P1-1 REQ-D04 字段扩展 + 路径硬沙箱：task_type 六枚举 + `default_permissions` + `WritePathPolicy` / `check_write_allowance` 前置越权拦截（9 项参数映射）
- [ ] P1-2 REQ-D06 topic 扩展：`AgentEvent::CustomTopic` 注册式 Pub/Sub + 需求文档修订（纯内存 → 分层持久化，Critical 落库 / Delta 不落库）
- [ ] P1-3 declare_flow 工具化：主 Agent 声明 DAG 的入口（编排能力交还主 Agent）
- [ ] P2-1 批量派发参数（N 个并行子 Agent，单次调用）
- [ ] P2-2 worktree share/branch 隔离（登记暂缓；中间态 = 写路径互斥 + 只读裁剪）
- [ ] P2-3 DAG 前端可视化（见第七节，独立调研已定稿）
- [ ] P2-4 Role 展示标签（display_label 自由文本）+ report_to_orchestrator 上报工具
- [ ] D08 补充：kill_all 批量终止入口（按 session_agents 过滤 + L3 force_cancel）；resume 落为 `resume_subagent` 命令（走 fork_and_reassign）

### 4.2 规模估计（来自 REQ-D §9.2）

| Gap | 工作量 |
| :--- | :--- |
| P0-1 引擎 spawner 接线 | 1 任务卡 |
| P0-2 maxDepth 3→1 | 0.5 任务卡 |
| P0-3 并发上限对齐 | 0.5 任务卡 |
| P1-1 D04 字段 + 硬沙箱 | 1.5 任务卡 |
| P1-2 D06 topic 扩展 | 1 任务卡 |
| P1-3 declare_flow 工具 | 1 任务卡 |
| P2 各项 | 0.5 ~ 2 任务卡/项 |

- **新组件**：引擎侧 SubagentSpawner 实现、CustomTopic 事件扩展、declare_flow 工具、kill_all 入口、resume_subagent 命令
- **架构裁决点 5 个**：嵌套深度（裁决已定：改 1）、事件持久化（裁决已定：保留分层持久化）、调度上限（6 vs 12，待用户）、Role 语义（保留枚举 + display_label）、隔离模式（P2 暂缓）

---

## 五、功能域 E+G：编辑工具与文档工作区

**目标**：补齐 Agent 的「写能力」与「产出能力」——多块原子替换、覆盖保护、注释保留；以及「对话级默认工作目录 + 多 Agent 协作文档产出」的机制化。

### 5.1 功能点清单

**模块 E（REQ-E01~E03）**
- [ ] E01 multi_replace 多块非连续代码原子替换：全新工具（chunks 数组 + 重叠拒绝 + 单进程原子写：内存完成 → 临时文件 + rename）+ 备份名单登记 + 中间件链装配 + EOL 归一化 + 幂等（历史纠正：legacy 从未实现，仅 e2e 测试占位）
- [ ] E02 文件创建覆盖保护：write_file 默认拒绝覆盖（Overwrite=false 语义），显式 overwrite: true 才覆盖；壳层命令语义对齐防口径分裂
- [ ] E03 保留文档与注释：提示词层约束注入段（精确匹配替换天然满足，依赖 E01）

**模块 G（REQ-G01~G03）**
- [ ] G01 对话级默认工作目录：`resolve_output_dir` 工具 + OutputWorkspace 服务 + session_meta 持久化 + 惰性创建（`dirCreated: false`）+ 目录命名带日期 `<YYYY-MM-DD>-<session_id>`（调研定稿）+ 通知 AI 机制
- [ ] G02 多 Agent 协作文档产出：write_claims / ExploreDocsQuotaStore 接线（tool_exec.rs 装配）+ 共享产出目录 + 汇总索引约定（list_dir + write_file 最小方案）+ 子代理完成通知产出字段（outputFiles 结构化）+ 流程固化文档
- [ ] G03 路径隔离：默认根约定 + .gitignore 增加 `.agent-outputs` + 可配置项 + 清理走 trash

### 5.2 规模估计（来自 REQ-EG §7.2/9.2，合计约 8~12 人日）

- **新工具**：`multi_replace_file_content`（1 个，中 2~3 人日）、`resolve_output_dir`（1 个，中 2 人日）
- **新服务**：OutputWorkspace（输出目录服务，惰性 + 幂等）
- **新模块文件**：`tools/replace.rs`、`tools/output_dir.rs`、`subagent_inject.rs` 注入段（权限/注释/产出目录段）
- **接线面**：session-loop `tool_exec.rs` 装配（write_claims + quota store + BackupMiddleware 一次接线服务 E01/G02 两个需求）、`loop/mod.rs` 中间件链
- **行为变更**：write_file 覆盖语义是唯一影响既有调用面的改动，排 Phase 1 首位全量回归
- **结构改进项**：WRITE_TOOL_NAMES 静态名单 → 工具定义标记 write_class 自动派生（本次范围外）

---

## 六、配套专题一：脚本逃逸追踪（安全基线补充）

**目标**：把「AI 经 shell 绕过工具链直接写文件」从完全不可追踪，提升为「写文件有感知、归属到 run、工具外写入显式标记」。

### 6.1 功能点清单（五阶段，来自 REQ-逃逸追踪 §5.2）

- [ ] P1 数据面：`conex-fs` 新增 `watch.rs`——ChangeKind / FileChangeEvent / UndeclaredWrite / WorkspaceWatcher（notify 8 封装 + 排除清单 + Rename 聚合 + 事件通道）
- [ ] P2 判定面：`UndeclaredWriteDetector` trait + `RegistryBackedDetector`（复用 paths_overlap 语义）+ `SecurityAuditOperation::UndeclaredWrite` 事件 + engine-events 注册表 + registry_drift
- [ ] P3 装配面：SessionLoopOptions watcher 配置 + run 起停钩子（core_run_commands.rs 装配处）+ 消费循环（聚合 → 审计事件 → 主 agent 注入，限流：同路径一次、>50 文件风暴降级单条汇总）
- [ ] P4 展示面：前端 operation 文案映射 + has_destructive 着色（SecurityAuditSection 现成消费）
- [ ] P5 兜底面（二期）：run 结束指纹复核（复用 compute_file_hash / git status --porcelain）

### 6.2 边界与规模

- **依赖**：声明基准 = write_claims 装配（与 E/G 域共用同一接线点）；notify 依赖已存在（Cargo.toml）
- **新组件**：WorkspaceWatcher（conex-fs）+ Detector 判定器（session-loop 装配层）+ 1 个新审计事件类
- **显式不做**：声明后写（否决：静态特征必被绕过）、命令级归因（诚实边界：归因到 run+文件）、工作区外监视、扩展现有阻断能力

---

## 七、配套专题二：权限传递层（子代理权限设计）

**目标**（用户决策）：「主 agent 逐项配置太细、考虑不全子代理就挂」→ 改为**系统默认权限集（安全、够用、由系统给）+ 权限申请传递层（子代理申请 → 主 agent 审批 → 放行）**。

### 7.1 功能点清单

- [ ] 四层权限模型：安全基线（红线不可豁免 / C3 大面积回退审批）> 系统默认集（task_type 六枚举自动装配）> 主 agent 显式覆盖（仅 allowed_write_paths）> 运行时申请（一次申请一次放行）
- [ ] 六种 task_type 默认集：analysis（只读）/ design（只读+产出 1 篇）/ review（只读+评审报告 1 篇）/ implementation（全工具 + 工作区根沙箱 + 构建测试命令白名单）/ organization（只读+指定目录写，不配退化为只读）/ commit（仅 git 前缀过滤命令）
- [ ] 裁决者路由：`ApprovalSource`（MainAgent / Subagent）+ `route_approval` 纯函数——子代理请求默认路由主 agent 裁决（放行 / 拒绝 / EscalateToUser 转用户），主 agent 请求保持现状直发 UI
- [ ] 载荷扩展：`PermissionRequest` 增加 `requester_run_id` + `reason`（Option 字段，兼容既有事件）
- [ ] `ApprovalGate` trait 签名扩展：携带 `ApprovalRequester`（run_id / task_type / reason），不新增 trait（方案 A 推荐）
- [ ] 参数收敛：REQ-D04 9 项 → 5 项（name / description / system_prompt / task_type / allowed_write_paths），删除 enable_write_tools / enable_command_tools / enable_mcp_tools / allowed_read_paths
- [ ] 提示词注入：`permission_relay_section`（默认权限边界一句话 + 申请协议），对齐 explore_quota 凭证段先例
- [ ] 拒绝路径指引：结构化错误文案「权限申请被主 agent 拒绝：… 请回报主 agent」+ 子代理提示词申请声明段
- [ ] 接线：spawn 时装配（filter_registry 工具裁剪 + WritePathPolicy + 命令策略 + 审批上下文），对齐 `quota_context_for_spawn` 四件套

### 7.2 规模与开放问题

- **改动量**：约 3 处小改（请求载荷字段 + 路由函数 + 广播目标分支）+ 默认集装配 + 注入段 ≈ **0.5 任务卡新增**（原 T-D-07/08 资产继承，非从零）
- **复用点**：ApprovalGate / ApprovalChannel / ApprovalGateImpl / resolve / approval-resolved / 待审批集合校验全部不变
- **开放问题 4 个**：申请持久化（首版不做，超时兜底，记 P2）、子代理审批超时可配（120s 可能不够）、放行是否追加会话级规则（首版仅本次）、主 agent wait 子代理时的死锁风险（路由检测 + 超时兜底）
- **安全基线不破坏**：「审批人 = 用户」防线扩展为「主 agent 裁决、用户兜底」，主 agent 批准本身是显式裁决动作

---

## 八、配套专题三：可视化与扩展点（三个用户决策）

### 8.1 功能点清单

- [ ] DAG 可视化（做）：`get_flow_snapshot` 只读查询命令（session_commands.rs 域）+ `FlowDagView` 组件 + `flowDagLayout` 纯函数层（拓扑分层/边生成/状态色映射/空态/计数）+ `flowDagStore` + `useFlowDagVisible` 开关（`crish_flow_dag_visible`，localStorage 直读，默认关，关 = 零挂载零请求零订阅）+ 纯 CSS/SVG 渲染（零图形库依赖）；事件信封扩展 flowNodeId（二期，首版降级为快照 + 轮询）
- [ ] 多模型扩展点（不做，留字段）：`SubagentSpawnRequest.model_override: Option<String>`（默认 None = 继承），引擎零逻辑、UI 零暴露、schema 不加参数；纯类型变更，编译器强制全构造点补 None
- [ ] 输出目录命名带日期：`.agent-outputs/<YYYY-MM-DD>-<session_id>/`，本地时区零填充，首次 resolve 固化（幂等不漂移），惰性创建语义不变；标题溯源明确不做

### 8.2 规模

- DAG 可视化 ≈ 0.5~1 任务卡（前端 6 个新文件 + 1 条只读命令 + 测试）
- 多模型字段 ≈ 0.1 任务卡（并入 T-D-07/T-D-13 契约面）
- 输出目录命名 ≈ 0（并入 T-EG-08 任务书）

---

## 九、功能域关系图（文字版）

```
                    ┌─────────────────────────────────────────────────┐
                    │          需求母文档 REQ-agent-engine-capabilities │
                    │        （8 模块 30 条需求 + 7 设计原则）            │
                    └───────────────┬─────────────────┬───────────────┘
                                    │                 │
          ┌─────────────────────────┘                 └─────────────────────┐
          │                                                               │
   ┌──────▼───────┐          ┌──────────────┐                    ┌─────────▼───────┐
   │ 域 D 多Agent  │◄────────►│ 域 C 定时/唤醒 │                    │ 域 A+B 命令/后台│
   │ 协同调度       │          │ (C04 唤醒源)  │                    │ 任务            │
   │ · spawner接线 │  D07 等待 │ · 定时器/Cron │                    │ · 三模式执行     │
   │ · 权限/隔离    │◄───────►│ · idle 续 run │  A04 健康通知       │ · 任务管理器    │
   │ · DAG(已实现) │  wait通道 │ · watchdog    │◄───────────────────│ · 资源监控      │
   └──────┬────────┘          └──────────────┘  （唤醒通道）         └───────┬───────┘
          │  ①                                                        │
          │  子代理身份（run_id/task_type）                            │ daemon 语义
          │                              ┌──────────────────────────┐ │ (C03 IsDaemon)
          ▼                              ▼                          ▼
   ┌────────────────┐            ┌───────────────┐          ┌───────────────┐
   │ 专题：权限传递层 │            │ 域 E+G 编辑与   │          │ 域 C+F 工具域  │
   │ · 默认集(task_  │            │ 文档工作区      │          │ · F01/02/03   │
   │   type 六枚举)  │            │ · E01 原子替换  │◄────────►│   (E01 与 F02  │
   │ · 申请→主agent  │            │ · G01 输出目录  │  E01 行号  │   行号寻址一致)│
   │   裁决路由       │            │ · G02 协作产出  │  与 F02 参数 │               │
   └────────┬───────┘            └──────┬──────────┘          └───────────────┘
            │ ②                          │ ③
            │ task_type/WritePathPolicy  │ write_claims 装配（声明基准）
            ▼                            ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │            专题：脚本逃逸追踪（notify 监视 + 声明基准比对）               │
   │       依赖 ③ 的 write_claims 装配；审计事件复用既有链路                    │
   └──────────────────────────────────────────────────────────────────────┘
            │ ④
            ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │            专题：可视化与扩展点（DAG 视图依赖 D 的 flow_graph 数据）        │
   └──────────────────────────────────────────────────────────────────────┘
```

**依赖要点**（编号对应上图）：

1. **域 D ↔ 权限传递层**：spawn 时的 `task_type` / 默认权限集装配、子代理 run 的审批路由是 D 域「外围控制面」的核心部分；D 的 T-D-07/T-D-08 计划资产被权限专题继承并收敛。
2. **域 D ↔ 域 C**：wait_subagents 三模式等待（D07）与 `SubagentWaitChannel` 引擎接线（C05/G4）是同一链路的两端；C04 反应式唤醒的注入通道（followUp 环 / L1）服务子代理完成通知与定时器到期。
3. **域 E+G ↔ 逃逸追踪**：write_claims / WritePathRegistry 装配是 E01 原子性、G02 并发防冲突与逃逸监视「声明基准」的共同前提——三处共用 session-loop `tool_exec.rs` 装配点，建议一次接线。
4. **域 A+B ↔ 域 C**：A04 健康判定的「立即唤醒」语义随 C04 接线；C03 Cron 的 IsDaemon 常驻会话归属需与 B 域守护进程语义联动裁决。
5. **域 A+B 内部**：G1 后台任务管理器是底座，G2 流式化是全部后台化的共同前置（阻塞 G4~G7）。
6. **域 E+G 内部**：G01（输出目录）是 G02/G03 共同前置；E01 与 G02 共用接线面。
7. **域 F ↔ 域 E**：E01 与 F02 的行号参数语义需一致（1-indexed 闭区间），避免 AI 混淆。

---

## 十、整体功能全景：落实后的产品能力清单

功能差距战役全部落地后，Conex/Crish 将具备以下产品能力（按用户可见价值分组）：

### A. Agent 执行与值守能力
1. 命令执行三模式：短命令同步返回；长命令超时自动转后台不阻塞 AI 思维链；开发服务器等以守护进程常驻运行
2. 后台任务全生命周期：列表 / 状态（含资源快照）/ 日志按行号续读 / 交互式 stdin 注入（自动检测 `[Y/n]` 提示并通知 AI）/ 优雅-强制两阶段终止
3. 进程健康感知：CPU/内存/I/O 采样，疑似卡死与异常退出通知 AI，不误杀正常进程
4. 输出防溢闭环：截断保尾 + 完整日志落盘可续读 + 分页器防挂起 + 高输出命令建议
5. 全链路禁 `cd`：Cwd 显式指定，路径状态无歧义

### B. 自动化值守能力
6. 单次定时器与智能早退条件（指定子代理终态即提前返回，避免无效唤醒）
7. Cron 周期调度（5 段式表达式，MaxIterations / 守护会话语义），前端调度面板从死 UI 变活
8. 会话级 idle 待命：AI 无事可做进入待命，定时器/子代理事件/外部消息驱动自动恢复（无轮询）
9. 兜底 watchdog：声明等待超时未终态自动唤醒处理
10. 唤醒摘要标准化：6 类事件各有 AI 可消费的摘要模板

### C. 多 Agent 协同能力
11. 引擎级子代理派发：单发/批量（上限 12），全局唯一会话标识，父子链与深度落库
12. 自定义 Agent 类型：task_type 六枚举 + 系统默认权限集自动装配（配置负担从 8 项权限面降到 1 处可选路径）
13. 权限申请传递层：子代理越界操作带理由申请 → 主 agent 裁决（放行/拒绝/转用户），全程留痕，红线不可豁免
14. 子代理嵌套禁止（深度 1，仅主 Agent 可派发）
15. DAG 依赖图调度（已有）+ 可视化视图（功能开关可下线）+ 主 Agent 声明入口
16. 生命周期管理：list / kill（单杀 / kill_all）/ resume（fork 三态上下文继承）/ 四级恢复阶梯
17. 全局事件总线扩展：自定义 topic Pub/Sub + 分层持久化（Critical 落库）

### D. 编辑与产出能力
18. multi_replace 多块非连续原子替换（含重叠拒绝、单次写盘、写前备份、EOL 归一化、幂等）
19. 文件覆盖保护：write_file 默认拒绝覆盖，杜绝意外毁损
20. 注释保留机制：编辑规范注入子代理提示词
21. 对话级默认工作目录：`.agent-outputs/<日期>-<会话id>/` 惰性生成、幂等稳定、不污染源码、gitignore 排除
22. 多 Agent 协作文档产出：写路径互斥 + 探索配额 + 共享产出目录 + 汇总索引 + 完成通知带产出清单
23. 文档工作区与代码工作区路径隔离（可配置）

### E. 安全与可信能力
24. 脚本逃逸追踪：run 期间实时监视工作区变更，与 write_paths 声明比对，未声明写入产生审计事件并通知主 agent（归属到 run + 文件）；二期 run 末指纹复核兜底
25. 完整读取能力：read_file 行号窗口 + 完整行边界 + 续读闭环，AI 不再因截断误判
26. 全局检索增强：文件级模式 + 排除 glob，检索结果可信完整
27. 目录列举：相对路径 + 子项计数，结构感知更精确

### F. 架构与扩展性
28. 多模型扩展点预留（model_override 字段，未来大小模型分工零成本接入）
29. 零兼容包袱：后台任务以新契约实现，不复活 sidecar 协议；事件分层持久化替代纯内存设计
30. 前端死代码清理：backgroundTasksApi / workflowRunner 幽灵命令面恢复或删除，UI 与实际能力对齐

---

## 十一、实施顺序汇总（跨域整合）

| 阶段 | 内容 | 牵头文档 |
| :--- | :--- | :--- |
| **Phase 0（底座）** | A+B：流式读取改造 + 后台任务管理器底座 + 禁 cd；C+F：F01/F02/F03 工具级改造（可并行，文件错开） | REQ-AB §12.3、REQ-CF §6.3 |
| **Phase 1（P0 基础）** | A+B：三模式 + B01/B02/B04；C：wait 通道接线 + 定时器；D：spawner 接线 + maxDepth 改 1 + 上限对齐；E：E02 Overwrite（先行）+ E01 工具本体 + E03 | 三份现状分析 + 需求路线图 Phase 1 |
| **Phase 2（P1 核心体验）** | A+B：A03/A05/B03/B04 收尾；C：idle 续 run + 唤醒摘要 + watchdog + Cron；D：D04 字段 + D06 topic + declare_flow；E/G：G01/G02 接线与流程固化；逃逸追踪 P1~P4 | REQ-AB、REQ-CF、REQ-D、REQ-EG §9.1 |
| **Phase 3（P2 增强，按需）** | C05 策略辅助；D：批量派发 / DAG 可视化 / worktree / Role 标签；G03 配置；逃逸追踪 P5 指纹复核；权限专题开放问题 | 各文档 P2 清单 |

**跨域共性前置**（先于一切落地）：
1. `wait_with_output` → 流式读取（AB 域技术债，阻塞全部后台化）
2. write_claims / 中间件链 / 配额 store 的 session-loop 装配（E/G 域与逃逸追踪共用）
3. D 域引擎侧 SubagentSpawner 接线（D 域全部外围控制的载体）
4. 架构裁决清单：调度上限 6 vs 12、Cron 会话归属、contentOffset 粒度、二进制读取形态、权限申请持久化

---

> **文档结束**
> 本总览为只读分析产物，全部结论以 `docs/feature-gap-analysis/` 8 份源文档为准；任务书拆解与排期请以 `plans/` 下各模块方案（01-AB / 02-CF / 03-D / 04-EG）与 PE 任务书为准。
