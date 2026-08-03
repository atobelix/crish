# 参考项目对比分析：DeepSeek-Reasonix 与 oh-my-pi —— 安全与多 Agent 调度维度

> 本报告是 `docs/multi-agent-repair/ref-analysis/` 系列第 01 篇，服务于后续 `improvement/` 方案系列。
> 对比对象：**Crish（现状）** × **DeepSeek-Reasonix（Go 桌面 Agent，以下简称 Reasonix）** × **oh-my-pi（Rust + TypeScript 终端 Agent，以下简称 pi）**。
> 分析范围：维度 A（安全与高危操作防护）、维度 B（多 Agent 调度）；并专节评估 Crish 三个独有想法的设计合理性。
> 证据格式：`文件路径:行号`；参考项目路径均为 `reference/` 下相对路径。

---

## 0. 两个参考项目定位速览

| 项目 | 形态 | 与本课题最相关的既有资产 |
| --- | --- | --- |
| DeepSeek-Reasonix | Go 桌面/CLI Agent，权限与安全体系极深 | `internal/permission/`（规则引擎 + bash 语义分析）、`internal/sandbox/`（OS 级沙箱）、`internal/checkpoint/`（快照回滚）、`internal/recovery/`（Auto Guard 失败恢复）、`internal/agent/`（scheduler + 写路径声明）、`internal/guardian/`（LLM 安全评审）、`internal/tool/builtin/session_guard.go`（会话数据守卫） |
| oh-my-pi | Rust 内核 + TS CLI Agent，隔离与子代理执行极深 | `packages/coding-agent/src/task/worktree.ts`（全平台隔离 PAL）、`task/executor.ts`（进程内子代理）、`tools/approval.ts`（三档 tier 审批）、`tools/bash.ts`（CRITICAL_BASH_PATTERNS）、`tools/checkpoint.ts`、`src/prompts/system/subagent-system-prompt.md`（子代理提示词模板） |

**一句话结论先行**：Reasonix 在「命令审批语义化」「失败恢复预算」「写路径互斥」上远超 Crish 现状，是 Crish 权限引擎（C3/C4）与调度（C6）升级的最直接参照；pi 在「worktree/文件系统隔离」「子代理提示词协议」「git 基线捕获与分支合并」上是 Crish P0.1 隔离边界演进的最直接参照。Crish 的「删除接管 + 自动备份 + 极端危险拦截」三想法在两个参考项目中**均无完整等价物**（各有部分要素），设计方向成立，但需按第 4 节规避具体坑。

---

## 1. 维度 A：安全与高危操作防护

### A1 删除/文件操作防护

**参考项目做法**

- **Reasonix**：没有「回收站语义」的统一删除接口，但对删除类操作做了两件事：
  - 删除以**工具化**而非裸命令的形式暴露：`delete_range`（文本区间删除）、`delete_symbol`（符号删除）、`move_file`（移动），全部纳入 `IsFileMutationTool` 统一归类（`internal/permission/permission.go:862-869`），权限规则可用一个 `Edit` 通配规则覆盖全部文件变更工具（`permission.go:796-800`）；
  - 写工具在改动前记录文件快照，为「删除即恢复」提供底层数据（见 A5，`internal/checkpoint/checkpoint.go:28-33`——`FileSnap.Content == nil` 表示该文件在编辑前不存在，恢复时执行**删除**；反过来，被删除的文件因快照留存其编辑前内容，可被 `RestoreCode` 还原）。
- **pi**：删除没有独立工具，靠 bash `rm` 走权限审批面；其安全面放在「危险命令拦截」而不是「删除接口」上（见 A3）。
- **共同点**：两个参考项目都没有「先移入回收站再删」的产品语义。Reasonix 的 `repair/` 包有 `rename_noreplace_*` 平台实现（防止覆盖式重命名），是「文件操作不可逆性」的最小护栏，但不是删除保护。

**Crish 现状**

- 05 手册 §0「删除铁律」：**纯提示词层纪律**——禁止物理删除，必须 send2trash / `FileSystem.DeleteFile(SendToRecycleBin)`，批量删除逐个送回收站并登记清单（`05-协同操作约束与安全.md:9-19`）。引擎层无任何强制：`conex-sandbox` 的 CommandGatekeeper 只拦极端正则（`rm -rf /` 等），普通 `Remove-Item`/`del` 放行（`crates/conex-sandbox/src/lib.rs:20-35`）。
- 05 手册 §12.5「删除保护」：删除前确认「误删可恢复路径 = 回收站 + git 跟踪」，两者皆无的一律不做（`05:268`）——同样是提示词纪律。
- agent-tools 当前 8 个内置工具中**无删除/移动类工具**（04 文档 §1.1，`04-Agent功能需求设计.md:16`）。

**差距 / 可借鉴点**

1. **删除必须工具化**：提示词纪律无法在引擎层被审计和强制。Reasonix 把写类操作全部收拢到工具（`file_mutation` 统一归类）的做法可直接移植：Crish 增加统一的删除/移动工具，权限判定按工具名而非命令文本。
2. **「删除可恢复」的前提是「删除前有快照」**：Reasonix checkpoint 用 `Content == nil` 表示「编辑前不存在 → 恢复即删除」，这个反向语义（快照既保护编辑也保护删除）是 Crish「删除接管接口」可以直接复用的数据结构。
3. **删除登记**：05 §0.4 要求「报告中登记回收站条目清单」，应落为事件（events 表），这与 Crish 审批事件落库（C3 第 5 条）是同一机制。

### A2 git 操作护栏

**参考项目做法**

- **Reasonix**：git 命令没有专门护栏模块，但通过**权限规则系统**天然覆盖：
  - 用户/系统可配置 `Deny` 规则拦截任意命令（如 `Bash(git reset --hard)`），deny 优先级最高且不可被 allow/ask 覆盖（`internal/permission/permission.go:192-270`）；
  - bash 复合命令**逐段判定**：`git add . && git commit && git push` 会被 `DecomposeBashCommand` 拆段，每段独立过规则表，任一段 deny 则整体 deny（`permission.go:285-300`）；
  - 「始终允许」记忆规则优先落安全前缀（`BashCommandPrefix` 产出 `git push:*` 这类边界前缀，`permission.go:830-850`），拒绝合成宽泛规则。
- **pi**：git 命令走 bash 面，无专项；`CRITICAL_BASH_PATTERNS` 只覆盖磁盘/系统级毁灭命令，git 回退类不在此列（`packages/coding-agent/src/tools/bash.ts:47-90`），回退安全靠计划模式与人工确认。
- **共同点**：两个参考项目都没有「按回退面积/时间窗触发审批」的 git 专项门禁——**C3/C4 在参考项目中无等价物**。

**Crish 现状**

- C3 规划：大面积 git 回退（≥10 文件 / ≥300 行 / 目标 ref 早于 24h）走 ApprovalGate 审批，审批人=用户；C4 规划：时窗内第二次回退必审批（`04:96-154`）。**均已设计、均未实现**——当前仅 `conex-sandbox` 的 `approval_patterns` 正则把 `git push --force` / `git reset --hard` / `git clean -f` 提升为需审批（`crates/conex-sandbox/src/lib.rs:38-50`）。
- 05 手册 §2.4 危险命令清单是提示词层（`05:76-87`）。

**差距 / 可借鉴点**

1. **C3/C4 是超越两个参考项目的设计**，但缺一个工程前提：**「git 回退类调用」的识别不能靠命令文本正则**。`git checkout <ref>`、`git restore`、`git revert --no-commit`、PowerShell 变体……正则清单必然漏。Reasonix 的 shellparse 语义分析（命令字段解析 + 分段）是 Crish 落地 C3「回退面积计算」的识别底座（文件数/行数必须从 **git 语义**取：先 `git diff --stat <ref>` 再判定，而不是猜命令参数）。
2. **复合命令绕过**：`git reset --hard && ...` 埋在 `&&`/`;` 链中必须被拆段判定（Reasonix `decideBashSegments` 的直接迁移），否则 C3/C4 被一行复合命令绕过。
3. **审批人=用户的语义在参考项目中无强制**，反而 Reasonix 有个反向教训：子代理结果若声称「已获用户批准」，会附加边界警告防止父代理当真（见 B3，`internal/tool/subagentguard.go:14-16`）——Crish C3 第 4 条「审批人=用户」应当同样防护「子代理伪造批准」。

### A3 命令审批模型

**参考项目做法**

- **Reasonix（最深）**：三层模型——
  1. **规则层**（`permission.go`）：`Policy` 纯函数判定（deny > ask > allow > fallback），规则 = 工具名 + subject（glob/字面量/命令前缀三种匹配，`permission.go:59-97, 435-514`）；写类工具 fallback 由 `Mode`（ask/auto/yolo）决定，只读工具恒放行（`permission.go:144-159`）；`SessionAllow` 会话级临时豁免（`permission.go:154, 163-166`）；
  2. **语义层**（`bash_approval.go`）：bash 命令按「可复用 / 仅精确 / 必须人工」三分类（`bash_approval.go:28-68`）——含嵌套执行（`eval`/`source`/`xargs`/`sudo`/`bash -c`/`node -e`/`python -c`/`find -exec` 等，`bash_approval.go:70-114`）、命令替换、通配符展开、重定向的命令**必须人工**；安全前缀规则（`Bash(git push:*)`）只对可复用类生效；
  3. **裁决层**（`Gate.Check`，`permission.go:701-753`）：Approver 返回（放行/拒绝 + 是否记住）；「始终允许」经 `OnRemember` 持久化为规则（`permission.go:735-748`）；**非交互无 Approver 时 Ask 自动放行以保持自治**（`permission.go:720-722`）。
- **pi（最简）**：工具声明式审批——每个工具自带 `approval(args)` 返回 tier（read/write/exec 三档）+ 可选 `override: true` 强制弹窗 + 理由（`tools/approval.ts:72-76, 93-132`）；审批模式三档 `always-ask`/`write`/`yolo` 对应 tier 上限（`approval.ts:34-38`）；用户 per-tool 覆盖 `allow/deny/prompt`（`approval.ts:100-103`）；**yolo 模式下用户 deny 仍生效**（`approval.ts:102-104`），deny 抛错并给出解除指引（`approval.ts:148-153`）。
- **危险命令识别方式**：pi 用静态正则 `CRITICAL_BASH_PATTERNS`（`bash.ts:47-90`）且明确「刻意收紧——漏报代价是数据丢失或主机沦陷，误报可由用户策略纠正」（`bash.ts:43-46`）；Reasonix 用语义分析替代正则。

**Crish 现状**

- 已有：三态权限模式 ask/full-access/plan（`crates/agent-tools/src/permission.rs:14-22, 70-79`）；`ApprovalGate` trait 与 ApprovalChannel（`crates/session-loop/src/tool_events.rs:69`、`tool_exec.rs:43`）；审批事件先发后等防死锁（`tool_exec.rs:493-500`）；审批优先于中间件的语义（`tool_exec.rs:26-33`）；`conex-sandbox` 正则双清单（blocked/approval）+ 工作区越界提升审批（`crates/conex-sandbox/src/lib.rs:87-109`）。
- 缺失：**危险命令识别只有静态正则，无语义分析**；**无「记住」持久化**（每次审批都弹）；**无复合命令分段**；**无工具级 tier/override 声明**（Crish 是引擎按 dangerous 标记判定，工具自己无法声明「这次调用必须弹窗」）。

**差距 / 可借鉴点**

1. **语义分析升级正则是最高价值借鉴**（详见第 5 节 Top 1）：Reasonix `shellparse` 的复合命令拆段 + 间接执行分类 + 前缀规则，可直接在 conex-sandbox 上扩展。
2. **「记住本次选择」的持久化**：Crish 审批只有一次性裁决（`ApprovalDecision` approved/denied/expired，`tool_events.rs`），无「始终允许该命令前缀」的记忆。Reasonix `OnRemember` + `BashCommandPrefix` 的保守前缀策略（拒绝 `go *` 宽规则，落 `go test:*` 窄规则）值得引入，缓解高频审批打扰。
3. **非交互行为的取舍**：Reasonix 无 Approver 时 Ask→放行（自治优先）；Crish 现在是「无审批门时危险项透传需审批状态」（`tool_exec.rs:529-536`）。二者哲学不同：Crish 的 C3 要求「无审批通道注入时阈值检查仍生效（CommandPolicy 兜底）」，说明 Crish 选择**安全优先**——这与 Reasonix 非交互放行相反但更契合 C3 需求，保持即可，但要注意 headless 场景（CI）会被审批卡死，需要像 Reasonix `Headless` 模式（`internal/recovery/gate.go:37-39`）那样提供「结构化阻断」而非无限等待。
4. **pi 的 deny 抛错文案**值得抄：拒绝时给出解除路径（`remove tools.approval.X: deny from config`），避免模型原地打转。

### A4 沙箱/隔离

**参考项目做法**

- **Reasonix**：OS 级沙箱，分层清晰——权限规则是**策略层**，沙箱是**强制层**（「被许可的命令也逃不出盒子」，`internal/sandbox/sandbox.go:1-6`）：
  - 后端：macOS Seatbelt / Linux bubblewrap / Windows AppContainer（低完整性进程）；`WriteRoots`（工作区+配置的额外写根）、`ReadRoots`、`ForbidReadRoots`（不可读，防窃取/防读敏感文件）、`Network`（默认开，可关）四类边界（`sandbox.go:23-60`）；
  - **enforce 请求但后端不可用时 fail-closed 拒绝运行**（`sandbox.go:10-12, 67-69`）；
  - 内置写工具同样受 `WriteRoots` 约束，工作区外写默认拒绝；`ManagedConfigPaths` 是唯一逃生舱——写根外需每次人工审批（`internal/tool/builtin/workspace.go:21-40`）；
  - 有专门的沙箱逃逸测试（`internal/tool/builtin/bash_sandbox_escape_test.go`）。
- **pi**：**文件系统级隔离（worktree 概念落地最完整）**——`task/worktree.ts` 的 PAL（Platform Abstraction Layer）把隔离后端抽象为 apfs/btrfs/zfs/reflink/overlayfs/projfs/block-clone/rcopy 多实现，`ensureIsolation` 按后端可用性自动降级（`worktree.ts:238-252, 309-343`）；每个子任务在隔离视图中执行，完成后 `captureDeltaPatch` 生成差分补丁（含未跟踪文件补丁、嵌套仓库补丁），`commitToBranch` 把任务改动提交到 `omp/task/{id}` 分支，再 `mergeTaskBranches` 逐个 cherry-pick 回主分支（冲突即停并保留恢复分支，`worktree.ts:168-184, 378-499`）；子代理提示词明确「NEVER modify files outside this tree」（`subagent-system-prompt.md`）。
- **共同点**：两个项目都把「策略（该不该做）」与「强制（能不能做到）」分开；Crish 当前只有策略面。

**Crish 现状**

- `conex-sandbox` 只有 `CommandGatekeeper`（正则判定 + 工作区越界提升审批），**无 OS 级沙箱、无 worktree 隔离**（`crates/conex-sandbox/src/lib.rs` 全文）。
- 04 文档 P0.1 明确：第一版 isolationMode 仅 none——进程内隔离 + 会话树隔离，不承诺 worktree/process 隔离（`04:27`）。

**差距 / 可借鉴点**

1. **写根强制（workspace_root 越界拦截）**：Crish 的 `ToolContext.workspace_root` 已有（`crates/agent-tools/src/context.rs:93-102`），但只是路径解析基准，没有在写工具执行时做**强制**越界拒绝（gatekeeper 只在命令层提示，且只提升审批不拒绝）。Reasonix `WriteRoots` 的「写工具永远不能离开工作区（除非每次人工审批）」应成为 Crish 写工具的执行期硬约束。
2. **worktree 隔离是 pi 对 Crish P0.1 的最大启发**：`isolationMode: none → worktree` 的演进路线可以直接照搬 pi 的「baseline 捕获（HEAD/staged/unstaged/untracked 补丁）→ 隔离执行 → 差分合并 → 冲突停止保留分支」流水线（`worktree.ts:97-184, 437-499`）。Crish 是 Windows 目标（Tauri），pi 的 `block-clone`（Windows 块克隆）后端与 `rcopy` 降级链正好覆盖 Windows。
3. **fail-closed 原则**：enforce 后端不可用时应拒绝执行而不是裸奔（Reasonix `sandbox.go:67-69`）——Crish 在引入沙箱/删除接管等强制机制时都应遵循「强制机制不可用 → 该操作不可执行」。

### A5 崩溃/误操作恢复

**参考项目做法**

- **Reasonix checkpoint**（`internal/checkpoint/checkpoint.go`）：**git-free 快照**——与 Claude Code rewind 同思路，快照放在会话旁目录，绝不触碰用户 git（`checkpoint.go:7-10`）；每次用户轮次一个 `Checkpoint`（Turn/Time/Prompt/MsgIndex/Files），`MsgIndex` 是对话回滚边界（可连对话一起回滚并 fork，`checkpoint.go:43-53`）；每个 turn 一个 JSON 文件持久化（廉价删除 + 损坏隔离，`checkpoint.go:63-65, 177-192`）；`Snapshot` 只在文件**首次**被写工具触及时记录编辑前内容（`checkpoint.go:137-162`）；`RestoreCode(fromTurn)` 恢复工作区（`checkpoint.go:307-359`），`safePath` 防路径逃逸（`checkpoint.go:373-387`）；**只跟踪可 Preview 的写工具，bash 副作用不跟踪**——因为 shell 命令的目标无法预知（`checkpoint.go:8-10`）。
- **Reasonix Auto Guard**（`internal/recovery/gate.go`）：失败恢复不是无限重试，而是**预算制**——
  - 相同操作（工具+subject+args 指纹）失败达 `MaxOperationFailures` → 停止该操作并给出「不要重试同一操作，用只读工具诊断」的引导（`gate.go:604-607, 1334-1340`）；
  - 整个 Episode（用户轮次/模式切换）失败预算耗尽 → StopTurn（「不要再调用工具，总结已完成与阻塞」）（`gate.go:608-612, 691-695, 1342-1361`）；
  - 任务级授权记忆（TaskGrant）：用户在某任务范围确认过的高危操作可复用（`gate.go:493-502, 889-891`）；
  - **重启只恢复历史证据，不恢复活跃授权/预算锁**（`gate.go:409-442`）。
- **pi**：git 基线恢复——worktree baseline 捕获 HEAD/staged/unstaged/untracked（`worktree.ts:97-104`），合并冲突时保留分支且 stash 不 pop（`worktree.ts:477-499`）；`checkpoint` 工具是**顶层会话专属**，子代理不可用（`tools/checkpoint.ts:44-47, 76-78`）——设计上把「回滚」当成主代理治理动作而非子代理工具。

**Crish 现状**

- 已有：SessionTree 完整（append/fork/move_leaf/restore_leaf/read_branch_path，`crates/orchestrator/src/session.rs:231/239/255/315/331`）；`RewindPlan`（`session.rs:537, 670`）；安全点 `safe_point.rs`（AbortSignal）；retry.rs 指数退避。
- 规划中：C1 checkpoint 优先恢复（`04:40-66`）——但 C1 的 checkpoint 是「子代理周期性输出结构化检查点 + 引擎采集」，与 Reasonix 的「写前快照」是**两种不同机制**（C1 是任务进度检查点，Reasonix 是文件内容快照）。
- 05 手册 §1 的 checkpoint 查找三级（`.agent-runtime/` → orchestrator 快照 → git，`05:31-34`）仍是提示词纪律。

**差距 / 可借鉴点**

1. **文件级写前快照与任务级进度检查点是互补的两层**：Reasonix 证明「写前快照」（低成本、确定性、git-free）是回滚的最可靠底座，且与删除保护（A1）共用同一数据结构。Crish C1 可增补这一层，作为 C3 审批、删除接管的公共前置（「任何破坏性操作前，目标文件已有快照」）。
2. **恢复预算制**：Crish C7 阶梯只定义了「怎么逐级试」，没有定义「同一次失败最多试几次就停」。Reasonix 的 operation 指纹 + Episode 预算 + StopTurn 直接补上这个缺口，且与 05 手册第 11 节「状态混乱时停止操作」语义一致。
3. **重启不重放授权**：Crish C3 审批记录落 events 表，但**审批结果不应在重启后变成自动放行**——Reasonix 「Restore 只恢复证据不恢复授权」是现成原则。
4. **bash 副作用无法预知目标**（Reasonix `checkpoint.go:8-10`）是 Crish C1/C3 的共同边界：git 回退面积计算必须依赖**执行前的 git 语义查询**，不能依赖事后快照。

---

## 2. 维度 B：多 Agent 调度

### B1 子代理调用机制与上下文隔离

**参考项目做法**

- **Reasonix**：工具式 + 进程内。`task` 工具让子代理在前台 goroutine 跑，发出嵌套事件（ToolDispatch/ToolResult，前端渲染独立卡片，`internal/agent/parallel_tasks.go:153-238`）；`parallel_tasks` 复用同一基础设施，输入封顶 64（防单次模型调用无界分配，`parallel_tasks.go:82`）；**只读子代理使用按深度裁剪的只读工具注册表**（`ReadOnlySubagentToolRegistryForDepthWithRuntime`，`parallel_tasks.go:194`）——子代理的工具集随嵌套深度收紧，这是上下文隔离的硬边界。
- **pi**：进程内执行器（「Runs each subagent on the main thread」，`task/executor.ts:2-4`）；子代理设置从父会话派生（`createSubagentSettings`，`executor.ts:622`）；`taskDepth` 跟踪嵌套深度（`executor.ts:168, 625`）；**worktree 隔离**（`executor.ts:145, 562`）+ 提示词注入「你在隔离树中工作，永不修改树外」（`subagent-system-prompt.md`）。
- **共同点**：两者都是**进程内（同进程）子代理**，与 Crish P0.1「进程内隔离 + 会话树隔离」一致；真正的隔离差异在于**文件系统视图**（pi）与**工具集裁剪**（Reasonix）。

**Crish 现状**

- 04 文档 P0.1：进程内 + 会话树隔离，isolationMode 仅 none（`04:27`）；C6 规划 run_subagent 工具注册（`04:377`）；RecursionGuardConfig maxDepth=3/maxSiblings=5/maxConcurrent=6 已存在（`04:14`）。**运行资产为零**：无 run_subagent 工具、无 subagent 事件产出（`04:16`）。

**差距 / 可借鉴点**

1. **只读子代理的工具集裁剪**（Reasonix）与**按深度收紧**：Crish 的 SubagentRole（5 角色）目前只有类型无执行语义——`researcher` 角色的子代理应当默认拿到只读/受限工具集，这同时是 C5 文档配额、C6 并发的执行前提。比「提示词里写请只读」可靠得多。
2. **嵌套事件信封**：Reasonix 子代理事件带 `ParentID` 与独立 ID（`parallel_tasks.go:153-161`），Crish EventRouter 已消费 subagent 三事件（`04:18`），Rust 侧产出时应对齐 ParentID 语义，前端 AgentTeamBoard 才能正确绘制归属。

### B2 编排流（依赖/并发/写互斥）

**参考项目做法**

- **Reasonix SubagentScheduler**（`internal/agent/scheduler.go` + `write_claims.go`）：这是参考项目中**最接近 Crish C6 且有超越**的实现——
  - 会话级并发双上限：总并发 `maxTotal`（默认 6）与写代理并发 `maxWriters`（默认 3）分开计数（`write_claims.go:13-17, 41-59`）；只读子代理不占写配额（`scheduler.go:214-216`）；
  - **写路径声明（WritePathSet）**：写代理必须声明 `write_paths`（绝对路径、symlink 解析、拒绝 glob、拒绝工作区外、大小写折叠，`write_claims.go:64-97, 268-270`）；未声明则视为全工作区声明（写代理之间串行，`write_claims.go:99-107`）；`Overlaps` 检测父子路径冲突（`write_claims.go:111-132`）；
  - **fleet preflight 预检**：任务启动前 `ValidateNonOverlappingWriteClaims` 校验路径划分无冲突（`write_claims.go:136-151`）；
  - **父代理写预留**：主代理执行写工具期间 `ReserveParentWrite` 持有路径声明，阻断重叠子代理声明（不占子代理槽位，`scheduler.go:139-166`）；
  - 嵌套子代理快速失败（`Nested: true` 无容量即报错，防父/子槽位死锁，`scheduler.go:96-99`）；FIFO 等待队列（`scheduler.go:257-271`）。
- **pi**：无依赖图，主代理用 `yield` 协议串起任务（子代理完成时单次返回，`subagent-system-prompt.md`）；并发控制是通用 `mapWithConcurrencyLimit` + `Semaphore`（`task/parallel.ts:26-115`）；**依赖关系由主代理的提示词编排，引擎不建模依赖图**。

**Crish 现状**

- C6 规划：依赖图（after/parallel 声明、环检测、on_failed 三策略、并发预算、重启恢复）——**设计上超过两个参考项目**（两者都没有显式依赖图引擎）；调度状态机未实现。
- 05 手册 §3 文件域互斥表是**提示词纪律**（主代理每轮发一张表，子代理自查），引擎无强制。

**差距 / 可借鉴点**

1. **写路径互斥是 Crish 文件域互斥表的引擎化路径**（Top 2）：Reasonix WritePathSet 的整套校验（symlink 解析、glob 拒绝、大小写折叠、全工作区兜底、preflight 预检）就是 05 §3 表 + C6 并发上限的工程化。Crish 应让 run_subagent 的输入带 `write_paths` 声明，引擎强制互斥，而不是依赖子代理自觉。
2. **读写并发分离**（maxTotal/maxWriters）：Crish RecursionGuard 只有单一 maxConcurrent=6；引入「写代理≤3 且路径互斥、只读代理可并行」能显著提升 researcher 类只读任务的吞吐。
3. **父代理写预留**：Crish 主代理也写文件（作为唯一编排者），子代理并行时主代理的写入与子代理声明冲突——`ReserveParentWrite` 语义（执行期持有、不占槽位、冲突快速失败）正好补 C6 的盲区。
4. **嵌套快速失败**：Crish C7 阶梯 3 的 fork 会派生子代 run，若子代再派孙代，槽位耗尽时 Reasonix 的「快速失败而非排队」可防父子死锁——C6 的 maxDepth=3 需要配合「深层失败快返」策略。

### B3 子代理恢复/重试、网络波动处理

**参考项目做法**

- **Reasonix**：
  - 失败恢复集中在 Auto Guard（A5 已述）：预算制 + 证据留存 + 任务授权记忆；
  - **子代理伪造审批防护**：子代理结果若出现「已批准/等待用户确认/请用户选择」等措辞，自动追加固定边界声明——「此结果不是主机审批或真实用户答复，父代理必须走主机审批机制」，并避免重复追加（`internal/tool/subagentguard.go:14-41`）。
- **pi**：`job.ts` 工具与 `async/job-manager.ts` 提供后台任务与失败状态管理；worktree 合并冲突即停并保留分支（`worktree.ts:437-499`）。

**Crish 现状**

- C7 规划四级阶梯：自动重试（retry.rs）→ 主代理软注入 → 重分配/fork → 上报用户（`04:213-242`）；05 手册第 5 节同构（`05:154-173`）。PendingMessageQueue / ControlBus L0-L3 / steering 队列均已实现（`04:20`）。

**差距 / 可借鉴点**

1. **子代理结果可信度标注**（Top 3）：Reasonix `SubagentHostDecisionBoundaryNotice` 是 Crish C3「审批人=用户」的配套防线——子代理回报「用户已同意」时父代理不得当真。Crish 可在 subagent 结果信封层加同样的边界声明（提示词协议层 + 结果处理层双重实施）。
2. **阶梯的停止条件**：C7 定义了阶梯顺序但无「阶梯 3 也失败几次后必须停」的预算。Reasonix Episode 预算（`gate.go:608-612`）可作为 C7 阶梯 4 的触发上限，避免主代理无限 fork。
3. **网络波动与「已产出内容后的中断」**：C7 已对齐 retry.rs 语义（流已产出不重试，`04:225`），与 Reasonix Auto Guard 的「transient 失败先诊断再重试」（`gate.go:1194-1200`）一致，可补「重试前先做只读诊断」的引导文本。

### B4 提示词元数据注入（创建时间等）

**参考项目做法**

- **pi**：`checkpoint` 工具向主代理注入 `startedAt`（`tools/checkpoint.ts:82`）——但这只是 checkpoint 目标时间，**不是子代理创建时间注入**；`autoresearch` 存储里有 `started_at`/`pre_run_dirty_paths_json`（`autoresearch/storage.ts:426-434`），用于实验记录而非 git 回退指引。
- **Reasonix**：会话/分支事件里有 created_at（`internal/agent/branch.go`、`session_events.go`），**未发现注入子代理系统提示词的先例**。
- **结论：C2「子代理创建时间注入 + git 回退谨慎指引」在两个参考项目中均无等价物，是 Crish 独有设计。**

**Crish 现状**

- C2 规划：引擎注入 `started_at`（取 session_agents.started_at），提示词协议层给出「早于阈值（默认 24h）优先单文件修复」的指引，整体回退走 C3 门禁（`04:68-94`）；注入点是 engine.rs:220（现 `system_prompt: None`）。

**差距 / 可借鉴点**

1. C2 与 C3 的联动是自洽的（软约束 + 硬门禁），参考项目无先例不等于不可行——但**注入元数据必须有可验证性**：C10 的系统段字节级一致断言（`04:317`）要求动态字段显式标记 `@dynamic`，`started_at` 应照此标记，否则每次构建 system 段都变化，快照断言失败。
2. pi 的 `pre_run_dirty_paths_json`（运行前脏路径清单）是 C2 的有力补充：子代理启动时若工作区已脏（他人/主代理未提交改动），git 回退风险等级更高——Crish 可在注入 started_at 的同时注入「启动时脏文件清单」，让子代理回退决策更保守。

---

## 3. 维度 A+B 差距总览表

| 子项 | Reasonix | pi | Crish 现状 | 差距等级 |
| --- | --- | --- | --- | --- |
| A1 删除防护 | 工具化 + 快照反向删除语义 | 无专门 | 纯提示词纪律 | 高 |
| A2 git 护栏 | 规则系统覆盖 + 复合命令分段 | 无专门 | C3/C4 已设计未实现 | 高（C3 依赖语义识别） |
| A3 审批模型 | 规则+语义+裁决三层、记住机制 | tier+override+用户覆盖 | 三态模式+正则+审批门 | 高 |
| A4 沙箱/隔离 | OS 沙箱 fail-closed | worktree PAL 多后端 | 仅正则 gatekeeper | 高 |
| A5 崩溃恢复 | 写前快照 + Auto Guard 预算 | git 基线 + 分支恢复 | RewindPlan/safe_point 已有，检查点规划中 | 中 |
| B1 子代理机制 | task/parallel_tasks 工具 + 事件 | 进程内 + taskDepth | 运行资产为零 | 高 |
| B2 编排/并发 | scheduler 双上限 + 写路径互斥 | 并发池 + yield 协议 | C6 已设计未实现 | 高 |
| B3 恢复/重试 | Auto Guard 预算 + 伪造审批防护 | job 管理 + 合并即停 | C7 已设计未实现 | 中 |
| B4 元数据注入 | 无 | 无（仅 checkpoint startedAt） | C2 独有设计 | 低（独有） |

---

## 4. 「Crish 独有想法」评估专节

> 05 手册 §13 预留了三项产品能力：**删除接管接口**（统一删除接口 + 回收站语义 + 接口层自动暂存备份）、**自动 stash 备份**（无论用户是否同意，高危命令执行前自动创建恢复点）、**极端危险操作 100% 拦截**（`05:277-280`）。逐一核对参考项目等价物并评估。

### 4.1 删除接管接口（统一删除接口 + 回收站语义）

**参考项目等价物**：**无完整等价物。** 最近的碎片：
- Reasonix：写类操作全部工具化（`permission.go:862-869`）→ 「操作走工具」的结构前提成立；checkpoint 快照的 `Content == nil` 反向删除语义（`checkpoint.go:28-33`）→ 「恢复删除」的数据底座成立；但**没有回收站语义**，删除仍是物理的（`os.Remove`）。
- pi：无删除工具，删除靠 bash rm（危险面最大，与 Crish 相反）。
- 结论：参考项目都未把「回收站」当作产品语义实现，**此想法在参考圈内无对标，是 Crish 差异化项**。

**设计合理性**：方向正确。删除是 05 §0 铁律的核心（R1-R5 误删事故背景，`05:260-270`），提示词纪律已证明不可靠（一次事故毁掉 375 文件）。把「送回收站 + 登记 + 可审计」固化进引擎接口是删除铁律的工程化。

**潜在坑与对策**：

| 坑 | 说明 | 对策 |
| --- | --- | --- |
| 坑 1：AI 绕过 | 模型可改用 bash `rm` / `Remove-Item` 绕开删除接口，接口形同虚设 | 删除接口必须与命令面联动：bash 命令命中删除形态（`rm`/`Remove-Item`/`del`/`git rm` 且目标在工作区内）时**拦截并重定向**到删除接口（参考 pi bash-interceptor 的「拦截 + 引导专用工具」模式，`bash-interceptor.ts:42-67`）；拦截逻辑需语义分析（复合命令拆段），否则 `&&` 链绕过 |
| 坑 2：跨平台回收站 | Windows 有官方回收站 API（SHFileOperation/IFileOperation），macOS/Linux 无标准回收站（xdg-trash 未统一） | 接口内部做平台适配：Windows 原生 API / PowerShell `FileSystem.DeleteFile(SendToRecycleBin)`；非 Windows 平台退化到「备份目录 + 登记」（见 4.2 建议），并明示降级状态 |
| 坑 3：恢复成本与前提 | 回收站条目 ≠ 可恢复保证（文件可能已被 git 忽略、回收站被清空、跨盘移动失败） | 执行删除前必须**断言可恢复路径**：git 跟踪（`git ls-files`）或备份快照（4.2）或回收站三选一成立才执行（05 §12.5 已有此纪律，`05:268`，引擎化）；删除事件落 events 表含「可恢复路径」字段 |
| 坑 4：删除的「意图」与「物理」分离 | 删除 git 跟踪文件时，回收站删除与 `git add -u` 暂存是两步，中途崩溃会不一致 | 接口原子化：先登记（事件+清单）→ 回收站删除 → 再决定是否 `git add -u`（05 §0.3，`05:17`）；任一步失败返回结构化错误并给出恢复指引 |

**实现建议（最小可行）**：新增 `trash_delete` 内置工具（输入：路径列表；输出：每项结果 + 可恢复路径类型 + 回收站条目），挂 permission 判定为**写类**（dangerous 标记，与 `IsFileMutationTool` 同思路），中间件链上挂「删除前备份登记」钩子（复用 ToolMiddleware 的 before_execute，`middleware.rs:61-71`）。bash 侧对删除形态命令做重定向拦截（识别为第一优先级静态清单 + 语义分析兜底）。

### 4.2 自动 stash 备份（高危命令执行前自动创建恢复点）

**参考项目等价物**：**无通用等价物**（「高危命令前自动 stash」）。最近碎片：
- pi `mergeTaskBranches` 在 cherry-pick 前 `git stash push`、冲突时保留 stash 不 pop（`worktree.ts:446, 477-499`）——这是**合并操作自身的保护**，不是通用自动备份。
- Reasonix checkpoint 走 git-free 快照（「deliberately git-free」），刻意**不触碰用户 git**（`checkpoint.go:7-10`）。
- 05 §12.3 的现有纪律是「大面积变更前创建保护点（`git stash push` 或确认可回退提交）」（`05:266`）。

**设计合理性**：**方向对，但「自动 stash」这个载体有隐患，建议换成「自动快照」。** 理由：

| 隐患 | 说明 |
| --- | --- |
| 隐患 1：工作区可见性丢失 | `git stash push` 清空工作区未提交变更，AI 执行中的后续 `git status`/`diff` 看不到自己与他人刚写的改动，反而制造「改动消失了」的误判（R1-R5 事故正是 stash 链路误操作引发，`05:262`） |
| 隐患 2：全局命名空间污染 | stash 列表跨会话共享，自动 stash 若不带命名空间与过期清理，会膨胀并互相误 pop（pi 冲突时「保留 stash 不 pop」正是怕丢） |
| 隐患 3：git 历史副作用 | 自动 stash 会改写 reflog/stash 栈，属于对用户仓库的侵入式操作，与 Reasonix「绝不触碰用户 git」的产品哲学冲突 |
| 隐患 4：未跟踪文件覆盖不了 | stash 默认不含未跟踪文件，而误删事故重灾区恰恰是未跟踪产物 |

**对策与建议**：
1. **用「文件级快照备份」替代 stash 作为自动恢复点的默认机制**：高危操作（删除/大面积重写/回退）执行前，把目标文件复制到会话级备份区（如 `<session-dir>/backups/<ts>/`，git-free），结构与 Reasonix checkpoint 的 `FileSnap` 一致（路径 + 内容 + 编码，`checkpoint.go:28-33`）；恢复成本低、不触碰用户 git、不污染工作区可见性。
2. **stash 降级为「用户明确同意的恢复操作」才用的工具**（05 §12.3 现有语义保持），且必须命名（`crish:autobackup-<session>`）+ 使用后立即 pop 并校验（pi `mergeTaskBranches` 的 pop 失败处理可抄：pop 冲突 → 保留 stash + 结构化报错，`worktree.ts:477-499`）。
3. **「无论用户是否同意都备份」的精神保留**：自动备份不需要审批（它是只读的、低成本的），执行于破坏性工具调用之前，经中间件 before_execute 钩子接入（`tool_exec.rs:642-661` 中间件链已存在，直接挂载）。

### 4.3 极端危险操作 100% 拦截

**参考项目等价物**：**有部分要素，无「100% 拦截」完整形态**：
- Crish 自身已有雏形：`CommandGatekeeper.blocked_patterns` 静态正则（`rm -rf /`、`mkfs`、`Format-Volume`、`Clear-Disk` 等，`conex-sandbox/src/lib.rs:20-36`），Blocked 优先于一切（`lib.rs:66-72`）；
- pi：`CRITICAL_BASH_PATTERNS` 把危险模式提升到**审批**而非硬拦（`bash.ts:47-90`），且 yolo 模式下用户 deny 仍生效（`approval.ts:102-104`）——「不可被权限模式豁免」的语义与 100% 拦截最接近；
- Reasonix：OS 沙箱 fail-closed（后端不可用 → 拒绝运行，`sandbox.go:67-69`）与 guardian 失败关闭（非 JSON 输出 → deny，`policy.go`）是两个「强制层」样例；`session_guard.go` 对安全边界文件（settings.json，可执行全局 hook）**无条件拒绝**（`session_guard.go:50-69`）——这是参考项目中真正的「100% 拦截」实例，且解释了为什么它能 100%：**对象极小、判定确定、无业务歧义**。

**设计合理性**：成立，但「100%」的范围界定是关键成功因素。Reasonix 只对「安全边界文件」做无条件拒绝，对 rm -rf / 走的是沙箱强制而非规则。建议按三明治分层：

```
第一层 静态红线（100% 拦截，不可被任何模式豁免）
  对象：确定性毁灭操作——rm -rf /、格式化磁盘、清盘、关机、写 /etc/passwd、
        curl|bash 远程执行、fork bomb（直接抄 pi CRITICAL_BASH_PATTERNS + conex-sandbox
        既有 blocked_patterns 合并）
  原则：对象极小（几十条）、判定基于规范化后的命令词法、full-access/yolo 不豁免

第二层 语义升级（拦截的兜底，防绕过）
  复合命令拆段（&& / ; / | 链内任一段命中第一层 → 整体拦）+ 间接执行识别
  （eval/sudo bash -c/python -c 包裹的危险内容，Reasonix bash_approval.go:70-114 直接移植）

第三层 审批面（非拦截，走 C3/C4）
  其余危险但合法操作（git reset --hard 等）→ 现有审批通道
```

**潜在坑与对策**：

| 坑 | 说明 | 对策 |
| --- | --- | --- |
| 坑 A：误拦截 | 静态正则 false positive 破坏合法自动化（如 `rm -rf /` 被写成 `rm -r -f /` 变体就漏，而 `rm -rf <合法目录>` 不该拦） | 第一层模式只对准**确定性毁灭目标**（根目录/设备/系统文件），目录删除一律走删除接管接口（4.1）而非命令拦截；正则写法抄 pi 的「刻意收紧 + 注释说明」（`bash.ts:43-46`） |
| 坑 B：绕过 | 大小写、引号、转义、PowerShell 变体、`cd / && rm -rf *`、`rm --recursive --force /` | 第二层语义分析兜底（字段解析 + 规范化）；被拦后返回**结构化失败（原因 + 建议替代路径）**，事件落库可审计，模型不得静默重试（参照 Reasonix deny 文案「不要重试，换方法或停下来解释」，`permission.go:714-717`） |
| 坑 C：用户信任 | 用户显式要求执行被拦操作（如「格式化这个测试盘」）时 100% 拦截会激怒用户 | 第一层永不豁免，但错误文案必须给「人工通道」（「此操作被产品安全红线拦截，请手动执行或在设置中关闭该红线」）；红线开关本身是配置面显式项，默认开 |
| 坑 D：拦截面漂移 | 清单维护成本，新危险模式出现后漏网 | 清单作为内置配置集中管理（沿用 BuiltinToolConfig 配置面，04 文档 Q1 的裁决域），版本更新可追加 |

**总体结论**：三想法中「删除接管」最有差异化价值（参考项目均无回收站语义）但工程成本最高（跨平台回收站 + 命令重定向联动）；「自动备份」应改用文件快照形态而非 stash；「极端危险拦截」方向正确且 Crish 已有雏形，重点是窄化「100% 拦截」对象集 + 补语义分析防绕过。

---

## 5. 维度 A+B Top 10 借鉴点（按价值排序）

| # | 借鉴点 | 来源（文件:行号） | 价值 | 实现提示（对接 Crish 位置） |
| --- | --- | --- | --- | --- |
| 1 | **Bash 语义分析**：复合命令拆段逐段判定 + 间接执行分类（eval/sudo/xargs/bash -c 等必须人工）+ 安全前缀规则（`git push:*` 而非 `git *`） | Reasonix `permission/bash_approval.go:28-114`、`permission.go:285-300, 830-850` | 解决 C3/C4 的命令识别底座，防复合命令绕过，同时解决「审批记住」的粒度问题 | 扩展 `crates/conex-sandbox/src/lib.rs`：正则清单之上加 shellparse 等价层（Rust 侧无现成解析器，先做保守的字段切分 + 前缀匹配）；C3 回退面积判定挂在此层 |
| 2 | **写路径声明与引擎级互斥**：write_paths 校验（symlink 解析/glob 拒绝/大小写折叠/全工作区兜底）+ 并发重叠检测 + preflight 预检 | Reasonix `agent/write_claims.go:64-151`、`scheduler.go:127-231` | 把 05 §3 文件域互斥表从提示词纪律升级为引擎强制，是 C6 并发调度的安全前提 | run_subagent 工具输入增加 `write_paths` 字段；调度器（C6 实现时）持有声明并做 Overlaps 检测；`session_agents` 表增列（经 C6 唯一写面落库） |
| 3 | **子代理结果「伪造审批」防护**：结果含「已批准/等待用户确认」等措辞时追加边界声明，父代理不得当真 | Reasonix `tool/subagentguard.go:14-41` | 保护 C3「审批人=用户」不被子代理文本伪造绕过；也是主代理编排时的信任边界 | 提示词协议层 + 子代理结果信封处理层双重实施（Rust 侧 subagent 结果处理点） |
| 4 | **写前快照（git-free）**：文件首次被写工具触碰前记录内容，`Content==nil` 表示编辑前不存在（恢复即删除），每轮一个 JSON 文件（损坏隔离） | Reasonix `checkpoint/checkpoint.go:28-33, 63-65, 137-192, 307-359` | 同时服务删除保护（A1）、崩溃回滚（A5）、自动备份（4.2）；是 Crish C1 之外的第二层检查点 | 新增会话级快照存储（Rust），挂 ToolMiddleware before_execute（`middleware.rs:61-71`）；备份区放会话目录下，不触碰用户 git |
| 5 | **恢复预算制**：相同操作指纹失败 N 次停该操作、Episode 总失败预算耗尽 StopTurn、重启只恢复证据不重放授权 | Reasonix `recovery/gate.go:604-612, 691-695, 409-442, 1334-1360` | 补 C7 阶梯的停止条件，防无限重试/fork；对齐 05 §11 状态混乱即停 | C7 实现时引入操作指纹（工具+subject+args 哈希）与会话级失败计数（session_meta 持久化，与 C4 计数同机制） |
| 6 | **父代理写预留 + 嵌套快速失败**：父代理写工具执行期间持有路径声明阻断重叠子代理；嵌套子代理无容量立即失败防死锁 | Reasonix `scheduler.go:96-99, 139-166` | 堵 C6 两个并发盲区：主代理写文件与子代理冲突、深层嵌套死锁 | 调度器实现时区分 parentClaims 与子代理声明；maxDepth 超限时快速失败而非排队 |
| 7 | **只读子代理工具集裁剪 + 深度收紧** | Reasonix `parallel_tasks.go:194` | researcher 类角色的执行隔离；C5 配额与 C6 编排的执行前提 | run_subagent 按 SubagentRole 装配工具注册表（agent-tools 注册表已有能力）；`packages/shared-types/src/subagent.ts` 角色定义接执行语义 |
| 8 | **worktree 隔离 PAL + git 基线差分流水线**：baseline（HEAD/staged/unstaged/untracked 补丁）→ 隔离执行 → 差分补丁 → 分支提交 → 冲突即停保留分支；多后端自动降级（Windows 走 block-clone/rcopy） | pi `task/worktree.ts:97-184, 309-343, 378-499` | Crish P0.1 isolationMode:none 的下一步演进路线图；Windows 平台有现成后端方案 | 作为 C6 之后的增强立项（P0.1 之外），先做「差分补丁 + 分支合并」的引擎接口，隔离后端可后接 |
| 9 | **危险模式不可被权限模式豁免**：yolo/full-access 下用户 deny 与红线仍生效 | pi `tools/approval.ts:102-104`、Crish 既有 `blocked_patterns`（`conex-sandbox/src/lib.rs:66-72`） | 界定 C3 审批与 full-access 模式的关系：红线永不豁免、审批项可被 full-access 豁免的边界要显式化 | 权限引擎（permission.rs `decide`）增加「红线先行」分支：命中 blocked 清单直接 Deny，不经三态矩阵 |
| 10 | **审批拒绝的可执行文案**：拒绝/拦截时给出解除路径或替代方案，模型不得静默重试 | pi `approval.ts:148-153`、Reasonix `permission.go:714-717, 1334-1340` | 防模型「原地打转重试同一被拒操作」，降低 token 浪费与用户烦躁 | C3 拒绝文案模板 + 事件落库；`ToolErrorKind::UserDenied` 文案扩展 |

---

## 6. 后续引用建议（衔接 improvement/ 系列）

- 方案轮引用本报告时，重点章节：**第 1 节 A3（审批模型）与第 5 节 Top 1** 对应 C3/C4 的权限引擎升级；**第 2 节 B2 与 Top 2/6** 对应 C6 调度器设计；**第 4 节** 对应 05 §13 三个预留能力的裁决输入。
- 与 `04-Agent功能需求设计.md` 的开放问题联动：Q1（阈值归属）建议按 Top 9 分层裁决（红线清单进配置面、审批阈值进 session_meta）；Q4（fork 粒度）建议结合 Top 5 预算制限制 fork 次数；Q5（摘要调用方）不受本报告影响。
- 安全基线引用：`docs/rust-rewrite/31-security-baseline.md` 与本报告 A4 fail-closed 原则一致，方案实现时须双对齐。

---

本报告由 **安全与多Agent架构分析师** 生成于 2026-08-03，供 improvement/ 方案系列引用。


