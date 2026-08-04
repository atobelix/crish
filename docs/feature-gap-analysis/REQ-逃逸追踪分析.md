# REQ-逃逸追踪分析：脚本逃逸工具链的追踪能力现状与防护方案

> 范围：AI 通过 shell 执行脚本（JS/Python/Rust 等）绕过自建工具链（write_file / delete_file /
> 备份中间件 / 写路径互斥 / 审计事件），直接读写工作区文件。本文调查现有体系能否追踪此类
> 逃逸，并给出落地现有架构的防护方案。
>
> 结论先行：**现有体系对"脚本逃逸写文件"几乎完全不可追踪**（除命令原文经 tool-end 事件落库
> 可事后人工溯源外，文件变更本身无任何记录）；推荐方案为 **run 期间 notify 文件监视 +
> write_paths 声明基准比对 + 未声明变更审计事件**，可把"完全不可追踪"提升到"变更可发现、
> 归属可到 run、不可精确到命令"。
>
> 证据规则：全部结论给出 `文件路径:行号`；方案内化为现有架构，不另起炉灶。

## 目录

1. [现有追踪面调查（逐机制评级 + 证据）](#1-现有追踪面调查)
2. [绕过形态枚举表](#2-绕过形态枚举表)
3. [监视方案设计（主方案）](#3-监视方案设计)
4. [备选方案对比](#4-备选方案对比)
5. [推荐方案定稿 + 实施要点 + 测试锚点](#5-推荐方案定稿)
6. [结论：追踪能力总结与方案预期覆盖](#6-结论)

---

## 1. 现有追踪面调查

### 1.0 调查范围界定

"脚本逃逸"指代以下事实形态：AI 不调用工具注册表中的写类工具（write_file / delete_file /
delete_dir / apply_file_diff），而是通过 `shell_command` 执行任意解释器/外壳命令，由
解释器直接对工作区文件做写入、删除、改名、移动。追踪面由五层组成，逐层评级：

| 层级 | 机制 | 文件 | 覆盖对象 |
|---|---|---|---|
| L1 | 写路径互斥（write_paths） | crates/agent-tools/src/write_paths.rs | 工具声明路径的并发互斥 |
| L2 | 安全审计（audit + SecurityAuditSink） | crates/agent-tools/src/audit.rs | 删除/重定向/红线拦截等高危处置 |
| L3 | 命令语义分析（semantics） | crates/conex-sandbox/src/semantics.rs | 命令分类与删除形态识别 |
| L4 | 命令门禁（gatekeeper） | crates/conex-sandbox/src/lib.rs | 红线拦截 / 审批升级 |
| L5 | 备份中间件（backup） | crates/agent-tools/src/backup.rs | 写前快照（默认仅 write_file） |

### 1.1 L1 写路径互斥（write_paths.rs）——评级：声明制，shell 普通命令零覆盖

**机制**：写类工具执行前经 `claim_write_guard` 向会话级 `WritePathRegistry` 声明写路径，
冲突则拒绝（`tool.write_path_conflict`）；声明带 TTL 与 RAII 守卫，Drop 自动释放
（write_paths.rs:111-127、172-223）。

**接线面（全量枚举）**：

| 接线点 | 位置 | 说明 |
|---|---|---|
| write_file | crates/agent-tools/src/tools/fs.rs:187 | `claim_write_guard(ctx, &path_str, ClaimMode::Write)` |
| delete_file / delete_dir | crates/agent-tools/src/tools/delete.rs:194 | Delete 模式 |
| shell 删除重定向 | crates/agent-tools/src/tools/shell.rs:328-335 | 仅当语义层判定 DeleteShape 时，对解析出的目标声明 |

**关键事实**：

1. **shell 普通命令不声明任何写路径**。`ShellCommandTool::execute` 中唯一的 claim 调用点在
   删除重定向分支（shell.rs:328-335）；命中 `run_command`（shell.rs:215）的普通命令——
   包括 `node -e "fs.writeFileSync(...)"`、`python -c "open(...)"`、`echo > file`、
   `tee file`、`sed -i`、`git apply`——**零声明**。注册表对这些写入既无互斥也无记账。
2. **注册表只记账不比对文件系统**。`WritePathRegistry` 内部是 `Mutex<Vec<WritePathClaim>>`
   （write_paths.rs:135-140），只有声明/冲突/释放操作，没有任何"实际落盘路径 vs 声明路径"
   的核对能力——它天然是"声明基准"数据源，但当前没有任何消费者做反向比对。
3. 声明校验拒绝 glob（write_paths.rs:290-293），路径规范化复用 `resolve_workspace_path`
   （symlink 解析、拒绝 `..`、工作区外拒绝、Windows 大小写折叠，write_paths.rs:16-16、
   289-296）——这为监视方案提供现成的路径归一化/包含性判断基建。
4. 未接线（`ToolContext.write_claims = None`）时互斥整体不生效（write_paths.rs:18-20、
   303-309），会话装配由执行器决定。

**评级：L1 对脚本逃逸的追踪能力 = 不可追踪（0/5）**。互斥语义上"写类工具"与"shell 写文件"
是两套独立面；shell 只认删除形态，不认识任何写入形态。

### 1.2 L2 安全审计（audit.rs + SecurityAuditSink）——评级：记录处置决策，不记录文件变更

**机制**：`SecurityAuditSink::emit(AgentEvent)` 是审计事件出口（audit.rs:23-26）；未接线回退
`NoopAuditSink`（audit.rs:29-34）；`security_audit_event` 构造事件（audit.rs:109-127）；
引擎侧经 `BuiltinToolConfig.audit_sink` 注入（audit.rs:8-12，tools/mod.rs:49）。

**事件载荷**（crates/conex-types/src/events.rs:537-554）：

```rust
AgentEvent::SecurityAudit {
    session_id, timestamp,
    operation: SecurityAuditOperation,   // Delete / TrashRestore / TrashPurge / GitRevert / CommandExec
    targets: Vec<String>,                // 目标路径列表
    impact: ImpactAssessment,            // 文件数/总大小/跨目录/谨慎标记
    decision: SecurityAuditDecision,     // blocked/approved/denied/redirected/restored/purged
    permission_mode: Option<String>,
    tool_call_id: Option<String>,
}
```

**当前发射点全量枚举**：

| 发射点 | 位置 | 时机 |
|---|---|---|
| shell 红线拦截 | shell.rs:159-164 | Blocked + CommandExec |
| 删除重定向：间接包裹拦截 | shell.rs:262-267 | Blocked + Delete |
| 删除重定向：复合链拦截 | shell.rs:281-286 | Blocked + Delete |
| 删除重定向：目标解析失败 | shell.rs:296-301、315-321 | Blocked + Delete |
| 删除重定向：工作区根拒绝 | shell.rs:345-350 | Blocked + Delete |
| 删除重定向：成功移入回收站 | shell.rs:382-389 | Redirected + Delete（带 impact） |
| delete 工具（内置发射） | crates/agent-tools/src/tools/delete.rs（经 BuiltinToolConfig.audit_sink） | 删除处置 |

**关键事实**：

1. **审计记录的是"处置决策"，不是"文件变更事实"**。审计事件在"拦截/重定向"时刻发射，
   描述引擎做了什么（blocked/redirected），从不描述"某个文件在某个 run 期间被改了"。
2. **write_file 不发射任何审计事件**（fs.rs:176-218 全函数无 audit_sink 调用）；
   **shell 普通命令成功执行也不发射审计事件**（run_command 路径 shell.rs:215 之后无 emit）。
   即"工具链内正常写文件"与"shell 正常执行"都不进审计流。
3. `SecurityAuditOperation` 只有五类（events.rs:66-77），没有"未声明写入"或"文件变更"类别；
   新增类别需同步 contracts/engine-events.json 事件注册表，由 tests/registry_drift.rs 锁定
   （events.rs:1-12、606-611 的登记机制说明）。
4. 前端消费已就绪：`onSecurityAudit`（apps/crish-desktop/src/api/chat-bridge/handlers/
   securityAuditHandlers.ts:16-29）把事件推入 securityAuditStore，`SecurityAuditSection`
   （apps/crish-desktop/src/components/workspace/SecurityAuditSection.tsx）在 RuntimePanel
   展示——**审计事件是现成的通知/展示载体，新增"未声明变更"类别可直接复用这条链路**。

**评级：L2 对脚本逃逸的追踪能力 = 不可追踪（0/5）**。逃逸写入既不拦截也不重定向，
没有任何发射点被触发。

### 1.3 L3 命令语义分析（semantics.rs）——评级：识别间接执行，不识别内层文件写入

**机制**：`analyze` 拆段 + 逐段分类（semantics.rs:79-132），六类分类
`Normal / Redline / Dangerous / DeleteShape / GitRevertShape / Indirect`
（semantics.rs:10-23）；`INDIRECT_COMMANDS` 含 `node / python / python3 / eval / bash / sh /
pwsh / xargs / find` 等（semantics.rs:55-58）；`analyze_indirect` 递归分析内层
（semantics.rs:373-454）。

**关键事实**：

1. **`node -e "fs.writeFileSync('src/x.ts', ...)"` 的分类结果**：
   - 拆段得 `node` 段，args 为 `["-e", "fs.writeFileSync('src/x.ts', ...)"]`；
   - `analyze_indirect` 命中 `-e` 分支，把内层源码 `join(" ")` 后递归 `analyze`
     （semantics.rs:378-399、444-445）；
   - 内层 `fs.writeFileSync('src/x.ts', ...)` 拆段得命令名 `fs.writeFileSync('src/x.ts',` 之类
     的残缺 token，分类为 `Normal`（不命中任何形态清单）——**递归分析只能识别删除/红线/危险
     形态，没有任何"写入形态"概念**；
   - 整体分类 = `Indirect`（有内层内容即升 Indirect，semantics.rs:470-472）。
   - **结论：`node -e` 被识别为 Indirect（有可见性标记），但内层 `fs.writeFileSync` 的写
     入目标完全不可识别**。分析器是"形态白名单"式的——只找删除/红线/回退，不找写入。
2. **临时脚本形态完全不可追踪**：`node tmp.js` / `python gen.py` 无 `-e`/`-c` 参数，
   `analyze_indirect` 找不到内层内容（semantics.rs:381-398 只提取 `-c/-e` 后的内容），
   该段按自身判定为 `Normal`（semantics.rs:470-474 无内层不升级）——**连 Indirect 标记
   都没有**，完全不可见。
3. `perl -e` 不在 `INDIRECT_COMMANDS`（semantics.rs:55-58 无 perl）→ 直接 `Normal`。
4. 唯一可识别的逃逸形态是**间接包裹删除**（`has_indirect_delete`，semantics.rs:98-102、
   373-454），由 shell.rs:203-213 整链拦截——这是对"脚本逃逸"唯一的主动拦截，但只覆盖
   删除形态，且拦截粒度是"整链拒绝"而非追踪。

**评级：L3 对脚本逃逸的追踪能力 = 形态级部分（1.5/5）**。间接执行本身可被标记为
Indirect（`node -e` 可见），但这是"命令危险度"标记而非"写文件"识别；对写入目标、
写入内容零识别；临时脚本与 perl 连标记都没有。

### 1.4 L4 命令门禁（conex-sandbox/src/lib.rs）——评级：静态清单，写文件形态全部放行

**机制**：`CommandGatekeeper::check_command` 三层：语义红线段优先 Blocked
（lib.rs:75-82）→ 静态红线正则 Blocked（lib.rs:21-42、85-90）→ 语义 Dangerous 与审批
正则 RequiresApproval（lib.rs:44-57、93-107）；`check_command_with_context` 另做工作区外
cwd 升级审批（lib.rs:114-136）。

**关键事实**：

1. 红线正则只对准确定性毁灭目标（mkfs/dd/rm -rf //盘符格式化/关机，lib.rs:22-41），
   审批正则只对准 git 危险操作/发布/提权（lib.rs:45-56）——**没有任何针对
   `writeFileSync / open(...,'w') / Set-Content / echo >` 等写入形态的规则**。
2. `node -e "fs.writeFileSync(...)"`、`python -c "open(...)"`、`git apply` 全部返回
   `Allowed`（普通命令语义 + 无正则命中）。
3. 注意门禁语义：Approval 是"同意后放行执行"（shell.rs:178-196），即便把写逃逸形态
   挂上审批正则，也只是多一道人工确认，**不产生任何文件变更追踪**——门禁对"追踪"问题
   天然无贡献，只能作为拦截手段。

**评级：L4 对脚本逃逸的追踪能力 = 不可追踪（0/5）**（拦截能力也仅覆盖既有清单形态）。

### 1.5 L5 备份中间件（backup.rs）——评级：默认只覆盖 write_file

**机制**：`BackupMiddleware::before_execute` 在审批通过后、执行前对"声明需备份工具"的
入参 path 做复制快照（backup.rs:81-152）；默认名单 `default_backup_tools()` 只有
`["write_file"]`（backup.rs:42-44）；删除类内置备份工具跳过（backup.rs:38-39、105-110）。

**关键事实**：

1. **shell 工具不在备份名单**，且中间件按"工具名 + 入参 path"驱动（backup.rs:99-111）——
   shell 入参是 command 字符串，没有 path 字段，即便加入名单也无从快照。
2. 快照面 = `TrashService::snapshot`（crates/conex-fs/src/trash.rs:213-249）：复制原文件 +
   checksum（compute_file_hash）+ mtime + size 登记——**这是全仓现成的"单文件指纹+副本"
   能力**，快照对比方案可复用其指纹侧（见 §4.2）。
3. 逃逸写入既无备份也无快照：`node -e` 覆盖文件前无任何暂存，原内容不可恢复。

**评级：L5 对脚本逃逸的追踪能力 = 不可追踪（0/5）**（且无恢复兜底）。

### 1.6 文件系统监视能力（notify 依赖现状）

**事实**：

1. `notify = "8"` 声明于工作区根 Cargo.toml:67 与 workbench Cargo.toml:35——**存在但无任何
   Rust 代码 `use notify`**（全仓搜索零命中）。依赖"备而未用"。
2. 曾有目录监听机制：`perf/fs.rs` 注释记载 `perf_fs_watch_start / perf_fs_watch_stop` 与
   WATCHERS / FsWatchEvent 系列，但 G11a 已整段删除（apps/agent-workbench/src-tauri/src/
   perf/fs.rs:4-9），现存文件仅保留 read_chunk / file_info 供测试（perf/fs.rs:47-64）——
   **没有可复用的历史实现，但说明"命令面暴露文件监视"曾进入过架构**。
3. `conex-fs` 仅含 impact / trash / path_utils（crates/conex-fs/src 目录），无监视模块。

**结论：监视基建 = 零；依赖已就位（notify 8），实现从零开始但依赖无需新增。**

### 1.7 变更追踪与快照机制现状

| 机制 | 位置 | 性质 | 能否复用为"run 前后 diff" |
|---|---|---|---|
| orchestrator 状态快照 | crates/orchestrator/src/restore.rs:44-45（顶层 type `orchestrator-state-snapshot`） | 会话/run 状态快照（含 run 状态、session 记录、sequence），**不是文件系统快照** | 不能直接复用；仅提供"快照文件读写+校验"的落盘模式参考（restore.rs:412-474） |
| 回收站快照 | crates/conex-fs/src/trash.rs:213-249 | 单文件复制快照 + checksum + mtime + size | 可复用其指纹语义（compute_file_hash / mtime 采样）做轻量指纹对比 |
| git 命令面 | apps/agent-workbench/src-tauri/src/git.rs（workbench_git_run，参数白名单：子命令 + flag 白名单 + `:(literal)` pathspec，git.rs:1-28） | 壳层 git 执行（status/diff 等可经此查询） | git 工作区场景可经 `git status --porcelain` 做 run 前后 diff；非 git 工作区无此能力 |

**关键事实**：`workbench_git_run` 的白名单是壳层命令面（git.rs 头部注释），agent-tools 的
`shell_command` 里的 `git` 不经过该白名单（shell.rs:215 直接 run_command）——这本身是另一
个逃逸面：AI 可在 shell 里跑任意 git 子命令（含 `git apply` 写文件、`git checkout` 改工作区），
语义层只拦回退形态（semantics.rs:523-584），`git apply` 属 Normal。

### 1.8 工具链外写入的现成路径（非脚本形态，但同属"绕过"）

除 shell 脚本外，前端命令面还有一条**不受 agent-tools 工具链约束的写入路径**：

- 前端 `writeTextFile`（apps/crish-desktop/src/api/workspaceFsApi.ts:175-184）调用 Tauri
  命令 `write_file_content`（apps/agent-workbench/src-tauri/src/fs_commands/write.rs:7-13）；
- 该命令面**不经 write_paths 声明、不经 BackupMiddleware、不发射审计事件**（write.rs 无
  audit/tracing 引用）；
- 消费方含 `applyFileDiff`（apps/crish-desktop/src/api/applyFileDiff.ts，full_write /
  search_replace 两种模式落盘）。

这条路径是"引擎声明的写类工具（write_file）与前端直写（write_file_content）并存"的架构
事实——监视方案天然覆盖它：run 期间前端直写也会落入"未声明变更"比对逻辑（除非声明注册表
补充登记命令面写入，见 §3.5.4）。

### 1.9 现有追踪面小结（逐机制评级表）

| 机制 | 覆盖形态 | 对脚本逃逸的追踪能力 | 关键证据 |
|---|---|---|---|
| write_paths 互斥 | 写类工具 + shell 删除重定向 | 不可追踪（0/5） | shell.rs:215 普通命令零声明；注册表只记账不比对 |
| 审计事件 | 拦截/重定向/删除处置 | 不可追踪（0/5） | shell.rs:159-164、382-389 发射点清单；write_file 无发射 |
| 命令语义分析 | 删除/红线/回退形态 | 形态级部分（1.5/5） | semantics.rs:55-58、373-454：node -e 仅 Indirect，内层写入不可识别 |
| 命令门禁 | 静态红线/审批正则 | 不可追踪（0/5） | lib.rs:21-57：无写入形态规则 |
| 备份中间件 | write_file 写前快照 | 不可追踪（0/5） | backup.rs:42-44：默认名单仅 write_file |
| tool-end 事件落库 | 全部工具调用的入参与结果 | **命令原文可事后溯源**（2/5） | 事件流 append_event 落库（crates/conex-db/src/events.rs:8-27）；shell 结果含 command 原文（shell.rs:670-681） |
| 前端命令面 | write_file_content 直写 | 不可追踪（0/5） | workspaceFsApi.ts:175-184；write.rs:7-13 |

**唯一可用的追踪线索**：shell_command 的 command 原文随工具结果进入事件流落库（tool-end
事件，conex-db/src/events.rs:8-27 append_event）——事后人工翻事件流能找到"当时执行过
`node -e ...writeFileSync...`"的命令，但这是**纯人工、非结构化、无文件级关联**的溯源，
run 结束后无人比对文件系统实际状态。

---

## 2. 绕过形态枚举表

以下按逃逸形态逐一给出：现有体系能否识别、识别层级、风险评级（对工作区完整性的影响）。
"可识别"分三档：门禁拦截（可阻止）、语义标记（可见但放行）、无感知（完全不可见）。

| # | 形态 | 示例 | 现有识别 | 现有追踪 | 风险 |
|---|---|---|---|---|---|
| E1 | node -e 内联写 | `node -e "require('fs').writeFileSync('src/x.ts', '...')"` | 语义层 Indirect 标记（semantics.rs:55-58、378-399） | 命令原文落库，文件变更无记录 | 高 |
| E2 | python -c 内联写 | `python -c "open('a.py','w').write('...')"` | 同 E1（python 在 INDIRECT_COMMANDS） | 同 E1 | 高 |
| E3 | 写临时脚本再执行 | `node tmp_gen.js` / `python gen.py` | 无（无 -e/-c 参数 → 无内层分析，semantics.rs:381-398；分类 Normal，:470-474） | 无（命令原文仍落库） | 高 |
| E4 | 重定向写 | `echo "..." > src/x.ts` / `Write-Output "..." > x.ts` / `"..." | Set-Content x.ts` | 无（Normal） | 无 | 中 |
| E5 | tee 写 | `tee src/x.ts <<< "..."` | 无（Normal） | 无 | 中 |
| E6 | sed -i 原地改 | `sed -i 's/old/new/' src/x.ts` | 无（Normal） | 无 | 中 |
| E7 | perl -e 内联写 | `perl -e 'open(F,">x"); print F "..."'` | 无（perl 不在 INDIRECT_COMMANDS，semantics.rs:55-58） | 无 | 中 |
| E8 | git apply 打补丁 | `git apply patch.diff`（patch 文件先经 E3/E4 落盘） | 无（git 非 rm/回退形态 → Normal，semantics.rs:494-502；classify_git_revert 不覆盖 apply，:523-584） | 无（壳层 workbench_git_run 白名单不约束 agent-tools shell，§1.7） | 高 |
| E9 | git 工作区操作 | `git checkout <file>` / `git stash` / `git merge` 改工作区 | checkout 旧 ref 属 GitRevertShape（semantics.rs:564-581），普通 checkout 文件为 Normal | 回退形态有拦截，普通形态无 | 中 |
| E10 | 解释器链式组合 | `node -e "..." && echo done` / `echo x \| node -e "..."` | 拆段后各段按自身判定；管道段 stdin 内容不分析 | 命令原文落库 | 高 |
| E11 | 前端命令面直写 | applyFileDiff / writeTextFile → `write_file_content` | 无（不经 agent-tools 链，§1.8） | 无 | 中（前端可信面，但引擎无感知） |
| E12 | 删除/改名类逃逸 | `node -e "fs.rmSync('src/x.ts')"` / `mv` / `Rename-Item` / `git rm` | 间接包裹删除有整链拦截（semantics.rs:98-102、shell.rs:203-213）；裸 `mv`/`Rename-Item` 不在 DELETE_COMMANDS（semantics.rs:61-63）→ Normal | 拦截形态有审计；裸改名无 | 高 |
| E13 | 编译/测试副产写 | `cargo build` 写 target、`npm run test` 写快照、codegen 写 src | 无（Normal，正常开发活动） | 无（**本应无**——需白名单） | 低（误报源） |
| E14 | 写工作区外的逃逸 | `node -e "fs.writeFileSync('C:/Users/.../f', ...)"` | 门禁仅查 cwd 在工作区外（lib.rs:114-136），**不查写目标** | 无 | 高（工作区外污染） |

**要点解读**：

- 现有体系对 E1-E11 的**阻止**与**追踪**几乎全空；对 E12 的"间接包裹删除"有唯一拦截
  （shell.rs:203-213 整链拦截 + Blocked 审计），但裸 `mv`/`Rename-Item` 改名逃逸语义层
  不识别（改名 = 删除+新建，E12 行）。
- E13 是方案误报控制的关键输入：编译产物、依赖目录、测试快照、代码生成器是合法高频写入，
  监视方案必须与它们区分（§3.4）。
- E14 揭示：现有门禁把"工作区"概念用于 cwd（lib.rs:127-133），从未用于"写目标"——
  脚本写工作区外的能力没有任何防线，监视方案的监视范围也须限定工作区（工作区外本就
  不受管，需在方案边界里写明）。

---

## 3. 监视方案设计（主方案）

### 3.0 方案一句话

**run 执行期间用 notify 监视工作区文件变更；每个变更对照"本 run 内 write_paths 声明 +
工具审计覆盖集合"，未被覆盖的变更产生"未声明写入"归因报告，经 security-audit 事件流通知
前端审计面板与主 agent。**

设计原则（内化现有架构，不另起炉灶）：

1. **声明基准已存在**：write_paths 注册表（write_paths.rs:135-140）就是"引擎知道要写哪"
   的权威记录——监视器只是它的反向消费者。
2. **通知载体已存在**：security-audit 事件（events.rs:537-554）+ 前端 handler
   （securityAuditHandlers.ts:16-29）链路现成，新增一个 operation 类别即接入。
3. **记录面已存在**：事件落库 append_event（conex-db/src/events.rs:8-27）+ 会话事件流
   （AuditSink 注入路径，audit.rs:8-12）无需新库。
4. **依赖已存在**：notify = "8" 已在 Cargo.toml:67（工作区）与 :35（workbench）——零新增
   依赖，只需开始使用。
5. **实现位置自洽**：监视服务属"run 生命周期 + 文件系统"交汇面，放 session-loop（装配）
   + 新建 conex-fs 监视模块（watcher 本身）是依赖方向最顺的切法：conex-fs 不依赖
   agent-tools，agent-tools/session-loop 都可消费它；watcher 产生的判定（声明比对）在
   session-loop 装配层完成，比对基准 write_paths registry 由 agent-tools 提供，方向为
   session-loop → agent-tools（与 audit.rs:11-12 记载的依赖方向一致）。

### 3.1 数据流

```
run 开始（SessionLoopProducer::produce / core_run_commands 装配）
   │
   ▼
WorkspaceWatcher::start(workspace_root, 排除清单)         [session-loop 装配层]
   │  notify::recommended_watcher → DebouncedWatcher/直连事件
   ▼
raw 事件流（Modify / Create / Remove / Rename，路径，kind）
   │
   ▼
归一化（resolve_workspace_path 语义：symlink 解析、拒绝 ..、Windows 折叠
        ——复用 crates/agent-tools/src/tools 的 resolve 能力或 conex-fs path_utils）
   │
   ▼
过滤（排除清单：.crish-trash / node_modules / target / .git / 白名单目录 §3.4）
   │
   ▼
未声明判定
   ├── 命中当前 run 的 WritePathRegistry.active_claims()（write_paths.rs:260-262）
   │      或本 run 工具审计已覆盖（write_file/delete 的目标）→ 标记 declared，静默
   └── 未命中 → UndeclaredWrite 事件
   │
   ▼
归因报告（FileChangeEvent 聚合：按 run + 路径去重/聚合，附带时间窗）
   │
   ▼
SecurityAuditSink.emit(AgentEvent::SecurityAudit{ operation: UndeclaredWrite, ... })
   │
   ▼
事件流落库（append_event，conex-db/src/events.rs:8-27）
   + 前端 SecurityAuditSection 展示（securityAuditHandlers.ts:16-29）
   + 主 agent 注入（经会话注入通道，与 L1 注入同构，见 §3.5.3）
```

**关键决策点**：

- **比对基准的双重来源**：`declared = 路径命中注册表声明 ∪ 路径命中本 run 工具审计记录`。
  理由：write_paths 声明只在"接线了 write_claims"的会话生效（write_paths.rs:18-20、
  303-309），未接线会话里 write_file 照常工作但无声明——此时要拿"工具审计覆盖"兜底。
  最简单的兜底实现：审计 sink 包装器（CountingAuditSink 同型，audit.rs:80-105）记录
  write_file/delete 的目标集合，交给判定器；或直接要求监视方案依赖 write_claims 接线
  （推荐，接线已存在于壳层装配，见 §3.5.1）。
- **无法精确归因到命令**：notify 事件只有路径与时间，没有进程来源。归因粒度是
  "哪个 run 期间、哪个文件、工具外写入"，不承诺"哪条命令"（诚实边界，写入方案文档）。
  若需要命令级归因，只能靠命令原文 + 时间窗启发式（run 内 shell 事件流与变更时间窗对齐，
  标记"候选命令"），作为增强项而非主承诺。

### 3.2 数据结构设计

新增于 conex-fs（建议 `crates/conex-fs/src/watch.rs`，与 trash.rs 平级）：

```rust
/// 变更类型（wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    /// 内容修改（Modify）
    Modified,
    /// 新建（Create）
    Created,
    /// 删除（Remove）
    Removed,
    /// 改名（Rename：from → to，删除+新建聚合）
    Renamed,
}

/// 单条工作区文件变更（watcher 产出，判定前）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    /// 规范化绝对路径（symlink 已解析、工作区内、Windows 大小写折叠）
    pub path: PathBuf,
    /// 变更类型
    pub kind: ChangeKind,
    /// 改名场景的源路径（kind == Renamed 时 Some）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<PathBuf>,
    /// 事件发生时刻（纪元毫秒，对齐全仓 epoch ms 惯例）
    pub occurred_at_ms: i64,
}

/// 未声明写入归因报告（判定后、审计前）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndeclaredWrite {
    /// 会话标识
    pub session_id: String,
    /// run 标识（信封注入，事件体可留空由 emit 层填）
    pub run_id: String,
    /// 聚合后的变更清单（同 run 同路径去重、按时间排序）
    pub changes: Vec<FileChangeEvent>,
    /// 时间窗起点（第一个变更时刻）
    pub first_occurred_at_ms: i64,
    /// 时间窗终点（最后一个变更时刻，事件发射时刻）
    pub last_occurred_at_ms: i64,
    /// 变更文件数（聚合后）
    pub file_count: usize,
    /// 是否含删除/改名类（高风险标记，供 UI 着色）
    pub has_destructive: bool,
}
```

审计事件侧的扩展（crates/conex-types/src/events.rs）：

```rust
// SecurityAuditOperation 增加变体（events.rs:66-77 同级）：
#[serde(rename = "undeclared-write", rename_all = "kebab-case")]
UndeclaredWrite,

// SecurityAudit 事件体（events.rs:537-554）targets 字段直接承载变更路径，
// impact.file_count 承载聚合数——**事件体结构零改动**，只新增 operation 值。
// 新增 operation 必须同步：
//   1) contracts/engine-events.json 事件注册表（events.rs:1-12 注册表机制）；
//   2) tests/registry_drift.rs 锁定的注册表 ↔ enum 一致性；
//   3) 前端生成产物（scripts/generate-engine-bindings.mjs 再生成）。
```

判定器接口（建议放 session-loop 装配层或 agent-tools 的新模块，依赖方向
session-loop → agent-tools）：

```rust
/// 未声明写入判定器：watcher 事件 × 声明基准 → 归因报告
pub trait UndeclaredWriteDetector: Send + Sync {
    /// 判定单条变更是否被声明覆盖；None = 未覆盖（需上报）
    fn is_declared(&self, event: &FileChangeEvent) -> bool;
}

/// 注册表适配实现：比对 WritePathRegistry.active_claims()
/// （write_paths.rs:260-262；Overlaps 复用 write_paths.rs:333-341 的
/// paths_overlap_normalized 语义——前缀组件边界一致）
pub struct RegistryBackedDetector {
    registry: Arc<WritePathRegistry>,
}

impl UndeclaredWriteDetector for RegistryBackedDetector {
    fn is_declared(&self, event: &FileChangeEvent) -> bool {
        self.registry.active_claims().iter().any(|c| {
            paths_overlap_normalized(&c.path, &event.path)
        })
    }
}
```

watcher 服务（conex-fs）：

```rust
/// 工作区文件监视服务（notify 8 封装）
pub struct WorkspaceWatcher {
    root: PathBuf,
    exclude: Vec<PathBuf>,        // 排除根（相对工作区）
    excludes_glob: Vec<String>,   // 排除 glob（如 "**/*.snap"）
    tx: tokio::sync::mpsc::Sender<FileChangeEvent>,
    _watcher: notify::RecommendedWatcher,  // 持有句柄防 Drop 停监视
}

impl WorkspaceWatcher {
    /// 启动监视（run 开始调用）；返回事件接收端
    pub fn start(
        root: impl Into<PathBuf>,
        exclude: Vec<PathBuf>,
    ) -> anyhow::Result<(Self, mpsc::Receiver<FileChangeEvent>)>;

    /// 停止监视（run 结束调用；Drop 兜底）
    pub fn stop(&mut self);
}
```

### 3.3 事件发射与 UI 接线

1. **发射点**：监视消费循环（session-loop 装配层 spawn 的任务）在 run 期间把聚合后的
   `UndeclaredWrite` 转成审计事件：

   ```rust
   audit_sink.emit(&security_audit_event(
       &session_id,
       SecurityAuditOperation::UndeclaredWrite,     // 新增变体
       change_paths,                                 // targets = 变更路径
       impact,                                       // file_count / 总大小
       SecurityAuditDecision::Denied,                // 语义：引擎未批准的操作发生（"未授权"标记）
       None,                                         // tool_call_id：无工具调用（工具外）
   ));
   ```

   `decision` 建议取 `Denied`（"非引擎批准路径的操作"）而非新增 decision 值——保持
   decision 枚举不动，前端对 Denied 已有展示语义（securityAuditHandlers.ts:16-29 透传
   decision，SecurityAuditSection 渲染）。如需"警告而非拒绝"的语义区分，可在 targets
   或 permission_mode 侧带标识，或后续评审再扩展 decision（扩展 decision 需同步注册表与
   生成物，成本同上）。
2. **前端展示**：零新接线——operation 新值随事件流到达
   `onSecurityAudit`（securityAuditHandlers.ts:16-29），store 原样 push；UI 需补充的只是
   operation 文案映射（UndeclaredWrite → "未声明写入"）与高风险着色（has_destructive）。
3. **主 agent 通知**：与 L1 注入同构——把归因报告作为注入消息塞进会话（session-loop
   注入通道，参考 safe_point.rs:162-194 的 write_inject_messages 机制），主 agent 下一轮
   即可看到"检测到工具外写入：src/x.ts（run r12 期间）"。注入频率需限流：同 run 同路径
   聚合为一条，同 run 多条路径聚合为一条摘要（防刷屏）。

### 3.4 误报控制（白名单/排除清单）

notify 会捕获工作区内一切文件活动，其中合法活动占比高，误报控制是方案成败关键。

**排除清单（静态，按路径/前缀）**：

| 排除项 | 理由 | 位置 |
|---|---|---|
| `.crish-trash` | 删除接管/备份的回收站域自身（backup.rs:130-132 默认根） | 工作区根相对 |
| `.git` | git 内部对象/索引高频写 | 工作区根相对 |
| `node_modules` / `target` / `dist` / `build` / `coverage` / `.next` / `__pycache__` / `.venv` | 依赖与构建产物（E13 主体） | 任意层级 |
| 回收站根（若配置在别处） | TrashService::root 同步排除 | 配置值 |

**需要白名单（"声明后写"或显式豁免）的场景清单**——这些是"编译/工具链合法写源文件"
的高频真实场景，若全部当未声明写入会上报，必须显式处理：

| 场景 | 示例 | 处理建议 |
|---|---|---|
| 代码生成器写 src | `cargo run --bin gen` 产出 `src/generated/*.rs`；TS 生成 `generated/` 目录 | 目录级白名单（`**/generated/`）或要求 run 前声明 |
| 格式化/lint --fix 写源文件 | `cargo fmt` / `eslint --fix` / `prettier --write` 改动源文件 | 默认放行白名单命令？**不可行**（命令名不可靠）；建议：把这些命令划为"已知写源工具"，run 结束后其写入经快照 diff 汇总展示而非实时告警（降低噪声层级） |
| 测试快照写 | vitest/jest `*.snap`、`snapshots/` | 路径 glob 白名单 |
| 前端构建产物 | 同上构建目录 | 静态排除 |
| 用户/IDE 手改 | 用户自己在 run 期间编辑文件 | 无法程序化区分；如实上报（用户侧噪声，可接受）或加"用户编辑标记"（编辑器外写无法可靠识别，放弃） |
| git 操作改写工作区 | `git checkout <file>`、`git stash`、`git merge`（非回退形态，semantics 不拦） | run 内 git 命令侧登记"预期写工作区"，命中后降级为"已说明"（§3.5.4 的"声明后写"扩展点） |
| 编译器中间写（cargo build 写 target 已排除） | rustc 增量产物在 target 内 | 已覆盖 |

**编译器写 src 的边界结论**：`cargo build` 只写 target（排除即可）；真正写 src 的只有
代码生成器/格式化器/测试工具——统一按"**目录/glob 白名单 + 剩余如实上报**"处理，不引入
"命令名 → 写路径"的猜测逻辑（猜测必然被绕）。上报降噪用两级：**白名单路径（静默）→
已知写源工具输出（run 末聚合摘要，非实时告警）→ 其余（实时告警 + 主 agent 注入）**。

**误报兜底**：监视只做"报告"，**不做阻断**——误报成本是噪声，不破坏合法工作流；阻断
交给现有门禁（门禁不可靠的写形态本就不阻断，方案不扩大阻断面）。

### 3.5 接线点清单（落地现有架构）

#### 3.5.1 装配（run 启动/停止）

- run 启动：`core_run_commands.rs` 的 `SessionLoopOptions` 装配处（core_run_commands.rs:
  1496-1502）附近，经 SessionLoopOptions 新增 `workspace_watcher` 字段（或会话级注入
  相同配置）传入 watcher 配置；watcher 启动 + 消费任务 spawn 在 run 驱动内。
- run 停止：run 终态（completed/cancelled/failed）收口处（orchestrator run.rs:137-142
  生命周期状态机 or session-loop 收口）调用 `WorkspaceWatcher::stop()`，随后 flush
  剩余未上报事件（聚合补发最后一条报告）。
- 声明基准的接线前提：`write_claims` 在会话装配（write_paths.rs:18-20 未接线语义）——
  监视方案要求装配层把 `WritePathRegistry` 同时传给工具上下文（既有）与判定器（新增，
  同 Arc）。

#### 3.5.2 依赖方向

`conex-fs`（watcher + 事件类型，无新依赖，仅用 notify + serde）→ 消费者：`session-loop`
装配层（watcher 管理 + 判定 + 发射）→ `agent-tools`（注册表查询/审计事件构造）。
conex-fs 被 agent-tools 依赖（backup.rs:33 已依赖 conex-fs::trash），watcher 放 conex-fs
不引入循环（agent-tools 不反向依赖 session-loop，与 audit.rs:11-12 记载一致）。

#### 3.5.3 主 agent 注入通道

复用会话注入机制（session-loop safe_point.rs:162-194 `write_inject_messages` 同型），
以"系统注入消息"携带归因摘要。限流：run 内同路径只注入一次、变更风暴（>50 文件）降级为
单条汇总。

#### 3.5.4 扩展点：git 操作与前端直写的声明登记

- **git 操作**：语义层已识别 `git` 段（semantics.rs:494-502）。在 shell 执行前对
  `git checkout/merge/stash/apply` 等写工作区形态登记"预期写工作区"标记（写入判定器
  的第二来源），命中后不视为未声明。**注意**：这不能替代监视（git 子命令变体多），只是
  降噪；漏登记的仍被监视兜底。
- **前端直写**（E11）：`write_file_content` 命令面在 run 期间执行时，命令实现侧登记
  写路径到判定器（或直接要求命令面走工具注册表路径，架构收敛）；未登记前由监视如实
  上报为"未声明写入"（行为正确：引擎确实不知道）。

### 3.6 方案边界与诚实声明

1. **归因粒度是 run + 文件，不是命令**：notify 事件无进程归属（Windows 上可尝试
   ETW/句柄查询，成本高，不在本方案范围）。时间窗启发式"候选命令"列为增强项。
2. **监视范围 = 工作区**：工作区外的写入（E14）不监视（需 OS 级钩子，越界）；工作区外
   写入的防护依赖门禁审批升级（cwd 检查）与将来的写目标检查，另立课题。
3. **不阻断**：监视是追踪面，不扩展现有门禁的阻断能力。
4. **性能**：notify 事件风暴（`cargo build` 万级文件写 target——已排除目录内不监视；
   其余路径风暴罕见）。消费循环需聚合 + 背压（复用事件背压概念：审计事件为 Critical
   必达，events.rs:169-182；监视内部聚合先行，聚合后才落审计，天然限流）。
5. **tmp 文件噪音**：编辑器原子写（`foo.ts.tmp` → rename）会产生成对事件；归一化时
   聚合 Rename 对（from/to），只报最终路径。

---

## 4. 备选方案对比

### 4.1 方案 A：声明后写（shell 输出扫描写操作特征）——评估：不可行

**设想**：shell 执行前/后扫描命令文本或输出中的写操作特征（`writeFileSync`、`Set-Content`、
`> file`），据此声明写路径或拦截。

**否决理由**：

1. **静态特征必被绕过**：`fs['writeFileSync']`、`eval("write"+ "FileSync")`、间接调用
   （函数别名、`process.mainModule.require('fs').writeFileSync`）、shell 变量拼接路径
   （`$f = 'src/x'; "echo y > $f.ts"`）——语义层自己都承认"静态正则必然被等价变形绕过"
   （semantics.rs:3-4），声明后写等于在不可靠层上加责任。
2. **与现有架构语义冲突**：write_paths 的核心价值是**确定性路径互斥**（validate 拒绝
   glob，write_paths.rs:290-293）；"扫描猜测"产生的声明是不确定的，会污染互斥语义
   （误声明路径阻塞真实工具）。
3. **产出是伪精确**：扫描命中 ≠ 实际写（`echo "writeFileSync"` 只是打印）；扫描未命中
   ≠ 没写。作为"拦截"不可靠，作为"追踪"不如监视完整。

**结论：否决为独立防线；可作为监视方案的辅助降噪（仅用于给"候选命令"提示，不做声明）。**

### 4.2 方案 B：快照对比（run 前指纹 vs run 后 diff）——备选，按需触发

**设想**：run 开始时记录工作区文件指纹（mtime + size + hash），run 结束时全量对比，
差异 = 变更清单（含内容级 diff）。

**评估**：

| 维度 | 评估 |
|---|---|
| 成本 | 全工作区扫描 + hash：万级文件仓库一次扫描数百毫秒到数秒（hash 全读）。run 内实时不可行；run 结束做可接受但延迟暴露 |
| 信息 | 内容级 diff（比 notify 的"路径+时间"多一层内容变化） |
| 误报 | 与 notify 相同的排除/白名单问题 + 变更时序不可知（无法按 run 内时刻对齐事件流） |
| 复用 | 指纹能力可复用 trash.rs:213-249 的 compute_file_hash / mtime 采样模式；但需新增"指纹清单"存储面 |
| 覆盖 | git 工作区可用 `git status --porcelain` 替代自建指纹（git.rs 壳层已有命令面），非 git 工作区需自建 |

**定位**：与监视方案**互补而非互斥**——监视是"实时发现"，快照对比是"run 结束兜底复核"
（监视事件流丢失/遗漏时的最终对账）。建议作为二期增强：run 结束对"本 run 声明未覆盖
且监视未报告的变更"做一次指纹复核（按需触发，成本受控），把"监视遗漏"的尾部风险关掉。

### 4.3 方案 C：run 期间实时监视（主方案，§3）——综合对比

| 维度 | A 声明后写 | B 快照对比 | C 实时监视（推荐） |
|---|---|---|---|
| 追踪时效 | 执行时刻（伪） | run 结束后 | run 期间实时 |
| 覆盖完整性 | 特征扫描，必漏 | 全量，兜底完整 | 全量（监视窗口内），尾部靠 B 补 |
| 精确归因 | 伪精确（扫描 ≠ 实际写） | run 级 | run 级（无命令级） |
| 误报 | 低（扫不到就报不了——伪低） | 高（白名单问题相同） | 高（同 B，需白名单工程） |
| 成本 | 低 | 高（全扫） | 中（notify 事件流） |
| 与现有架构契合 | 污染 write_paths 语义 | 无冲突 | 复用声明基准/审计流/依赖，最顺 |
| 阻断能力 | 理论可拦 | 无 | 无（追踪面） |

**结论：C 为主，B 为二期兜底复核，A 仅作 C 的降噪辅助。**

---

## 5. 推荐方案定稿

### 5.1 方案组成

- **主方案**：run 期间 notify 实时监视（§3 全量设计）——依赖零新增、审计链路复用、
  声明基准复用。
- **备选兜底**：run 结束指纹复核（§4.2，二期）——关掉监视遗漏的尾部风险。
- **显式不做**：声明后写（§4.1 否决）、命令级归因承诺（§3.6 边界）、工作区外监视
  （§3.6 边界）。

### 5.2 实施要点（分阶段）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| P1 数据面 | conex-fs 新增 watch.rs：`ChangeKind` / `FileChangeEvent` / `UndeclaredWrite` / `WorkspaceWatcher`（notify 8 封装 + 排除清单 + Rename 聚合 + 事件通道） | 单测覆盖：Modify/Create/Remove/Rename 事件产出、排除清单生效、Rename 聚合、停止后无事件 |
| P2 判定面 | `UndeclaredWriteDetector` trait + `RegistryBackedDetector`（复用 paths_overlap_normalized 语义）；conex-types `SecurityAuditOperation::UndeclaredWrite` + contracts/engine-events.json 注册表 + 生成物再生成 | registry_drift 测试通过；detector 单测：声明命中/未命中/前缀边界/大小写折叠 |
| P3 装配面 | SessionLoopOptions 增 watcher 配置；run 起停钩子接线（core_run_commands.rs:1496 装配处 + run 收口）；消费循环（聚合 → 审计事件发射 → 主 agent 注入，限流） | 集成测试：run 内 node -e 写文件 → 产生一条 security-audit（undeclared-write，targets 含路径）；write_file 写声明路径 → 无事件；白名单目录写 → 无事件 |
| P4 展示面 | 前端 operation 文案映射 + has_destructive 着色；SecurityAuditSection 已现成消费 | 前端测试：新 operation 渲染 |
| P5 兜底面（二期） | run 结束指纹复核（复用 compute_file_hash 模式 / git status --porcelain） | 对比测试：监视未覆盖的变更被复核捕获 |

### 5.3 测试锚点（对齐现有测试模式）

| 锚点 | 模式参考 | 内容 |
|---|---|---|
| watcher 单测 | write_paths.rs:391-410（TempWorkspace 模式）；trash.rs 测试 | 临时工作区 + notify 实际监视：写/删/改/改名 → 事件断言；排除目录不产事件 |
| detector 单测 | write_paths.rs:430-480（Overlaps 语义测试） | RegistryBackedDetector：声明目录 vs 子文件命中、同路径命中、兄弟不命中、Windows 大小写 |
| 审计集成 | shell.rs:1225-1267（RecordingAuditSink 断言 security-audit 载荷） | 逃逸写入 → sink 收到 operation=undeclared-write、targets 正确、decision=denied |
| 注册表漂移 | tests/registry_drift.rs | 新 operation 值同步注册表后不漂移 |
| 前端 | securityAuditHandlers.test.ts / SecurityAuditSection.test.tsx | 新 operation 的 handler 透传与文案渲染 |
| 端到端（手动/脚本） | e2e 缓存类验证模式 | 真实 run：node -e 写 src → 审计面板出现"未声明写入" + 主 agent 收到注入通知 |

### 5.4 风险与缓解

| 风险 | 缓解 |
|---|---|
| 误报噪声毁体验 | 两级降噪（§3.4 白名单 + run 末聚合摘要）；监视不阻断 |
| 事件风暴（大构建） | 排除目录先行；消费循环聚合限流；审计发射前按 run 聚合 |
| 注册表/事件契约变更成本 | P2 阶段一次性完成注册表 + 生成物 + registry_drift（events.rs:1-12 机制） |
| Windows notify 平台差异 | notify 8 在 Windows 用 ReadDirectoryChangesW，rename/写入事件语义需在 Windows 上实测（测试锚点必须含 Windows 平台用例） |
| 声明基准未接线会话 | P2 判定器第二来源（工具审计覆盖兜底，§3.1）或要求装配接线（推荐） |
| run 中崩溃导致监视泄漏 | 监视任务绑定 run 收口 + Drop 兜底停止；遗留事件按 run 收口 flush |

---

## 6. 结论

### 6.1 现有体系追踪能力总结

**总体评级：脚本逃逸写文件 = 完全不可追踪**（唯一可溯源线索是 shell 命令原文经
tool-end 事件落库，纯人工、无文件级关联）。分项：

| 追踪面 | 评级 | 一句话 |
|---|---|---|
| write_paths 互斥 | 0/5 | 只认工具声明，shell 普通命令零声明（shell.rs:215） |
| 审计事件 | 0/5 | 只记处置决策，不记文件变更（events.rs:537-554） |
| 语义分析 | 1.5/5 | node -e 仅标 Indirect，内层写入不可识别（semantics.rs:373-454） |
| 命令门禁 | 0/5 | 无写入形态规则（lib.rs:21-57） |
| 备份中间件 | 0/5 | 默认只覆盖 write_file（backup.rs:42-44） |
| 事件流落库 | 2/5 | 命令原文可事后人工溯源（conex-db/src/events.rs:8-27） |

**根因**：整条安全链是"形态白名单"思维——删除形态被接管、红线被拦截，但**"写文件"
从未被作为第一类追踪对象**；工具链假设所有写入都走 write_file（声明、备份、审计闭环），
而 shell 是任意代码执行面，两者之间存在结构性空隙。

### 6.2 方案预期覆盖

| 绕过形态 | 现状 | 方案后 |
|---|---|---|
| E1/E2 内联写（node -e / python -c） | 不可追踪 | run 期间实时发现 + 审计事件 + 主 agent 通知 |
| E3 临时脚本 | 不可追踪 | 同上（命令可见性无关，监视直接看文件） |
| E4-E7 重定向/tee/sed/perl | 不可追踪 | 同上 |
| E8 git apply | 不可追踪 | 同上（git 操作登记降噪后仍被兜底） |
| E9 git 工作区操作 | 部分拦截（回退形态） | 监视兜底 |
| E10 链式组合 | 不可追踪 | 监视兜底（命令原文仍可辅助归因） |
| E11 前端直写 | 不可追踪 | 监视如实上报（或命令面登记后豁免） |
| E12 删除/改名逃逸 | 间接包裹删除拦截 | 监视捕获 Removed/Renamed（has_destructive 高亮） |
| E13 编译/测试副产 | 无需追踪 | 白名单静默（误报控制） |
| E14 工作区外写入 | 不可追踪 | 仍不可追踪（范围边界，另立课题） |

**最终定位**：本方案把"写文件无感知"升级为"**写文件有感知、归属到 run、工具外写入
显式标记**"；不承诺命令级归因（诚实边界），不扩大阻断面。配合二期 run 末指纹复核，
监视遗漏尾部风险亦被覆盖。

---

### 附录 A：关键证据索引

| 证据 | 位置 |
|---|---|
| shell 普通命令无写路径声明 | crates/agent-tools/src/tools/shell.rs:215 |
| shell 删除重定向声明点 | crates/agent-tools/src/tools/shell.rs:328-335 |
| write_file 声明点 | crates/agent-tools/src/tools/fs.rs:187 |
| delete 工具声明点 | crates/agent-tools/src/tools/delete.rs:194 |
| 写路径注册表结构 | crates/agent-tools/src/write_paths.rs:135-140 |
| 注册表活跃声明快照 | crates/agent-tools/src/write_paths.rs:260-262 |
| Overlaps 语义 | crates/agent-tools/src/write_paths.rs:333-341 |
| 审计 sink trait | crates/agent-tools/src/audit.rs:23-26 |
| 审计事件构造 | crates/agent-tools/src/audit.rs:109-127 |
| SecurityAudit 事件体 | crates/conex-types/src/events.rs:537-554 |
| SecurityAuditOperation 枚举 | crates/conex-types/src/events.rs:66-77 |
| 事件注册表机制 | crates/conex-types/src/events.rs:1-12 |
| 间接执行命令名单（node/python） | crates/conex-sandbox/src/semantics.rs:55-58 |
| 间接执行内层分析 | crates/conex-sandbox/src/semantics.rs:373-454 |
| 删除形态名单 | crates/conex-sandbox/src/semantics.rs:61-63 |
| 门禁正则清单 | crates/conex-sandbox/src/lib.rs:21-57 |
| 备份默认名单 | crates/agent-tools/src/backup.rs:42-44 |
| 备份快照存储面 | crates/conex-fs/src/trash.rs:213-249 |
| notify 依赖（工作区） | Cargo.toml:67 |
| notify 依赖（workbench） | apps/agent-workbench/src-tauri/Cargo.toml:35 |
| 历史监视机制已删除 | apps/agent-workbench/src-tauri/src/perf/fs.rs:4-9 |
| 事件落库 | crates/conex-db/src/events.rs:8-27 |
| orchestrator 状态快照（非文件系统） | crates/orchestrator/src/restore.rs:44-45 |
| 前端直写命令面 | apps/crish-desktop/src/api/workspaceFsApi.ts:175-184 |
| 前端直写后端实现 | apps/agent-workbench/src-tauri/src/fs_commands/write.rs:7-13 |
| applyFileDiff 落盘 | apps/crish-desktop/src/api/applyFileDiff.ts |
| 审计事件前端消费 | apps/crish-desktop/src/api/chat-bridge/handlers/securityAuditHandlers.ts:16-29 |
| 审计面板展示 | apps/crish-desktop/src/components/workspace/SecurityAuditSection.tsx |
| run 装配点（watcher 接线位） | apps/agent-workbench/src-tauri/src/core_run_commands.rs:1496-1502 |
| 会话注入通道（主 agent 通知） | crates/session-loop/src/safe_point.rs:162-194 |
| git 壳层命令面 | apps/agent-workbench/src-tauri/src/git.rs:1-28 |
| 事件背压分级（审计 Critical） | crates/conex-types/src/events.rs:169-182 |
