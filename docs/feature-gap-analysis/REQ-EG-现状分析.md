# REQ-EG 现状分析：模块 E（代码编辑与文件操作工具增强）+ 模块 G（文档工作区与多 Agent 协作产出）

> 文档类型：需求现状分析（feature-gap analysis）
> 依据需求：`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md` 六、模块 E（REQ-E01~E03）与八、模块 G（REQ-G01~G03）
> 调查范围：`crates/agent-tools/`、`crates/conex-fs/`、`crates/conex-diff/`、`crates/session-loop/`、`crates/conex-db/`、`apps/crish-desktop/src/api/`、`apps/agent-workbench/src-tauri/`、`docs/multi-agent-repair/`、`packages/plugin-import-claude-codex/`、git 历史（legacy TS 时代）
> 分析方法：只读代码取证 + git 历史检索（`git log -S` / `git grep <commit>` 定位 deleted 文件）+ 现实产出目录模式对照
> 编写日期：2026-08-04

---

## 0. 结论速览

| 需求 | 优先级 | 现状判定 | 真 gap | 建议动作规模 |
| --- | :---: | --- | --- | --- |
| REQ-E01 multi_replace | P0 | **不存在**。legacy TS 时代仅有 e2e 测试占位（`multi_replace_file_content`），从未有正式实现；Rust 版 12 个工具中无任何 replace 类工具。前端 `applyFileDiff.ts` 的 search_replace 是唯一近似能力，但属 UI 落盘层、不在 agent 工具面 | 新工具 + 原子写 + 与备份/互斥/幂等接线 | 新增 1 个工具（中） |
| REQ-E02 文件创建 | P0 | write_file 具备"自动建父目录"，但**无 Overwrite 保护**——直接覆盖既有文件（fs.rs:199） | Overwrite=false 默认拒绝覆盖语义 | 扩展 write_file（小） |
| REQ-E03 保留注释 | P0 | 精确匹配替换机制天然满足；但该机制本身不存在（依赖 E01 落地）；提示词层无相关约束注入 | 依赖 E01 + 提示词层约束段 | 随 E01 + 注入段（小） |
| REQ-G01 对话级默认工作目录 | P1 | **完全缺失**。全仓库无 `.agent-outputs` / 会话输出目录逻辑；`session_meta` 全局 KV 可承载但无消费方 | 惰性目录生成 + 会话级路径持久化 + 通知 AI 机制 | 新模块（中） |
| REQ-G02 多 Agent 协作文档产出 | P1 | **半有半无**。配额机制（explore_quota）已实现但**未接线**；`docs/multi-agent-repair/` 的"00 总览 + 01~05 编号文档"是现实目标形态（纯提示词纪律）；I4-M3 写路径互斥已实现但主执行器未接线 | 接线 write_claims/配额 store + 产出目录机制 + 汇总索引约定 | 接线为主（中） |
| REQ-G03 路径隔离 | P2 | 用户显式路径不受限（符合需求）；默认输出根概念缺失，`.gitignore` 无 `.agent-outputs` 条目 | 默认根约定 + gitignore + 可配置项 | 配置 + 文档（小） |

一句话总结：**模块 E 的三个需求全部未实现（E01 是全新工具，E02 差一个 Overwrite 语义，E03 依赖 E01）；模块 G 的底层契约（session_meta、写路径互斥、探索配额、快照备份）多数已存在但主执行器未接线，缺的是"默认工作目录"这一核心机制与引擎侧装配**。

### 0.1 调查范围与证据可信度说明

- **代码面**：以 2026-08-04 工作区代码为准。核心调查文件：`crates/agent-tools/src/tools/fs.rs`（read/write/list/stat 四个工具）、`tools/diff.rs`、`tools/mod.rs`（注册表与路径校验）、`context.rs`（ToolContext 承载面）、`write_paths.rs`（写路径互斥）、`backup.rs`（写前备份中间件）、`idempotency.rs` + `executor.rs`（幂等与执行器）、`explore_quota.rs`（探索文档配额）、`readonly.rs`（只读裁剪）、`tools/wait_subagents.rs`（等待原语）；`crates/conex-fs/src/`（lib.rs 路径工具 / trash.rs 回收站 / impact.rs）；`crates/conex-db/src/schema.rs` + `sessions.rs`（session_meta）；`crates/session-loop/src/tool_exec.rs` + `loop/mod.rs`（装配面）；`apps/crish-desktop/src/api/applyFileDiff.ts` + `workspaceFsApi.ts`（前端落盘面）；`apps/agent-workbench/src-tauri/src/`（壳层装配面）。
- **历史面**：以 git 全历史（`--all`）检索为准，legacy TS 时代文件经 `git show 967e7846^:<path>` 读取被删代码。
- **文档面**：`docs/multi-agent-repair/`（00 总览 / 04 功能设计 / 05 约束手册 / README）、`docs/rust-rewrite/05-test-mapping.md`、`packages/plugin-import-claude-codex/README.md`。
- **证据分级**：本文档中"行号引用"为直接读码取证（一级证据）；"git 历史结论"为检索命令输出（二级证据，命令记录在第 8 章可复核）；"建议/判定"为分析推断（三级证据，明确标注）。未经过 cargo test 验证的行为结论均以代码静态语义为准，不臆造运行结果。

---

## 1. REQ-E01：多块非连续代码原子替换（multi_replace）

### 1.1 现状调查：历史实现搜索结论

#### 1.1.1 搜索方法

对全历史提交执行了四类检索：

1. `git log --all --oneline -S "multi_replace"`（字符串增删检索，覆盖所有分支）；
2. `git log --all --oneline -S "replacement_chunks"` / `-S "replace_file_content"`；
3. 对 legacy 删除提交 `967e7846`（refactor(runtime): remove legacy TS backend packages）的**父提交**执行 `git grep -n "multi_replace" 967e7846^ -- "*.ts"`（检索被删除代码树内的全部出现位置）；
4. `git log --all --oneline -- "*replace*"`（按文件路径检索 replace 相关源文件）。

#### 1.1.2 结论：multi_replace 从未有正式实现，只有 e2e 测试占位

检索结果如下：

| 检索项 | 命中 | 说明 |
| --- | --- | --- |
| `multi_replace` 全历史 | 仅 `packages/agent-daemon/src/__tests__/agent-real-workflow-e2e.test.ts`（legacy）与 `docs/rust-rewrite/05-test-mapping.md:235` | 唯一代码命中是一个 **e2e 测试**，不是工具实现 |
| `replacement_chunks` | 零命中 | 需求文档中的 Chunk 结构从未出现在任何版本代码中 |
| `replace_file_content`（单块替换） | 零命中（实现层） | legacy 工具面无正式 replace 工具 |
| 路径含 replace 的源文件 | 仅 `packages/agent-tools/src/git-versioning/git-patch-ops.ts`（legacy） | 该文件是 **git checkpoint 解析**（parseStatus/parseNameStatus/parseCheckpointMetadata），与文件内容替换无关 |

legacy e2e 测试的占位性质（证据；原文为 GBK 编码文件，git 导出时中文标题乱码，此处转写为可读形式，代码逻辑为逐字保留）：

```
967e7846^:packages/agent-daemon/src/__tests__/agent-real-workflow-e2e.test.ts:121
    it("路径 1.3: multi_replace_file_content 块替换与结构断言
        - 授权后精准多位置非连续替换并检查 Diff 表现", async () => {
    ...
    const approvalPromise = approvalQueue.waitForApproval(
        "call_multi_replace",
        "run_multi_replace",
        {
          toolName: "multi_replace_file_content",
          input: { path: targetFilePath, replacementsCount: 2 },
          summary: "更新 state 与 JSX 标签"
        }
    );
    // 用户授权
    approvalQueue.resolve("call_multi_replace", "approved");
    ...
    // 执行多块替换（注：实际直接 writeFile 模拟）
    const replacedCode = [...].join("\n");
    await writeFile(targetFilePath, replacedCode, "utf-8");
```

该测试的关键事实：

- 工具入参只有 `{ path, replacementsCount }`，**没有 replacement_chunks**——测试只是验证"审批 → 执行 → 落盘"的流程占位；
- 实际替换是测试代码直接 `writeFile` 模拟的，**从未经过任何 multi_replace 工具实现**；
- 也就是说：`multi_replace_file_content` 在 legacy 时代是"审批流程 e2e 的命名占位"，从未有正式工具定义、schema 或执行逻辑。

**因此，REQ-E01 备注"此功能曾存在于项目中，在 AI 重构时遗失"的表述不准确**。准确的说法是：该项目历史上**规划过**此工具（e2e 测试与测试映射文档 05-test-mapping.md:235 均以验收形态引用它），但**从未实现过**——它不属于"被 AI 重构误删的代码"，而是"从未进入实现阶段的规划项"。这对实施方式有直接含义：不是从 git 历史恢复代码，而是**全新设计**（但可复用当时规划过的语义：工具名、块替换思想、审批联动）。

#### 1.1.3 Rust 版现状：12 个工具注册表，无任何 replace 类工具

`crates/agent-tools/src/tools/mod.rs:461-490` 的注册断言给出了权威工具清单：

```
register_builtin_tools_registers_all：
    ["delete_dir", "delete_file", "diff_text", "file_stat", "fuzzy_find",
     "grep_search", "list_dir", "read_file", "run_subagent", "shell_command",
     "wait_subagents", "write_file"]
```

注册实现见 `tools/mod.rs:86-113`。**工具面没有任何 replace / edit / patch 类工具**：写文件只有 `write_file`（全量覆盖写），修改既有文件只能"read_file 全文 → write_file 全量重写"。这与 REQ-E01 的需求（单次调用完成 N 个非连续块的精准替换 + 任一失败整体回滚）存在根本差距。

### 1.2 现状调查：现有近似能力——前端 `applyFileDiff.ts`

`apps/crish-desktop/src/api/applyFileDiff.ts`（581 行）是**前端 UI 层**的"diff 落盘"纯函数层，把 AI 返回的 FileDiff 安全应用到本地文件系统。它不是 agent 工具，但其中 `search_replace` 模式与 REQ-E01 的单块替换语义高度同源，是项目内**唯一成熟的"精确原文替换"参考实现**：

- `classifyFileDiff`（applyFileDiff.ts:211-268）：把行级 diff 分类为 `full_write`（纯新增 → 全量写）或 `search_replace`（仅 del+add → old/new 字符串对）；复杂 hunk（有上下文行）、截断 diff、多匹配歧义 → 拒绝自动应用；
- `analyzeSearchReplace`（applyFileDiff.ts:316-376）：对磁盘内容做 `countOccurrences` 唯一性检查，返回六态：`apply` / `append` / `already_applied` / `ambiguous`（>1 处匹配）/ `conflict`（新旧并存）/ `missing_old`；
- `applyFileDiffToDisk`（applyFileDiff.ts:476-554）：读盘 → 分析 → 唯一匹配才替换 → 写盘；已应用则幂等跳过；
- `normalizeEol` / `preferEolStyle`（applyFileDiff.ts:287-297）：统一换行后比较，按原文件偏好还原 CRLF——**REQ-E01 的 target_content 精确匹配在 Windows 上必须处理同样的 EOL 归一化问题**，这是本项目（Windows 优先）落地 multi_replace 时不能忽视的细节。

该文件的定位边界：服务对象是"AI 输出 → UI 确认 → 落盘"闭环（`workspaceFsApi.ts:175-185` 的 `writeTextFile` 走 Tauri `write_file_content`，受 workspaceRoot 沙箱约束），调用方是前端 approval UI；它**不经过 agent-tools 工具注册表、没有 ToolContext、没有写路径互斥、没有备份中间件**。因此它既不能替代 E01 的 Rust 工具实现，也不构成需要迁移的存量代码——但它的六态判定逻辑与 EOL 处理是 E01 落地时**应移植/借鉴的判定语义**。

### 1.3 现状调查：conex-diff 的 streaming-diff-parser 与可复用基础设施

#### 1.3.1 streaming-diff-parser 不存在

`crates/conex-diff/` 全 crate 只有一个 `lib.rs`（源码文件仅 `C:\Software\conex\crates\conex-diff\src\lib.rs`），无 streaming-diff-parser。`diff_text` 工具（`crates/agent-tools/src/tools/diff.rs:87`）复用 `conex_diff::diff_engine::DiffEngine::diff(&old_text, &new_text)`，产出**行级 unified diff + hunk 结构**（`DiffResult.hunks`，含 `old_start/old_lines/new_start/new_lines` 与行级 `DiffLineKind`），并由 `render_unified`（diff.rs:121-142）渲染为 unified diff 文本。也就是说：

- 引擎只有"双文本 → diff"的正向能力，**没有"diff/patch → 应用"的反向能力**（apply/patch 方向）；
- 行号锚点（hunk 的 old_start）与行内容数据齐全，若未来做"diff 应用"可复用，但 E01 需求指定的接口形态（target_content 精确匹配 + 行号范围）与 diff 应用不冲突——**两种接口可并存，E01 不需要 streaming-diff-parser**。

#### 1.3.2 可复用基础设施盘点（E01 整合落点）

| 设施 | 位置 | 与 E01 的关系 |
| --- | --- | --- |
| 写路径互斥 `WritePathRegistry` | `crates/agent-tools/src/write_paths.rs:135-281` | `claim(holder, paths: &[S], mode)`（write_paths.rs:172-223）**天然支持一次声明多条路径**，且"多路径原子化：任一校验失败或冲突即整体拒绝，不产生部分声明"（write_paths.rs:162-166）——与 E01 的"全部 Chunk 校验通过才落盘"是同一原子性哲学 |
| 写前快照备份 `BackupMiddleware` | `crates/agent-tools/src/backup.rs:51-153` | before_execute 钩子对声明工具做 `TrashService::snapshot` 复制快照，失败即 Block（backup.rs:134-151）。当前默认备份名单只有 `["write_file"]`（backup.rs:42-44）——**新工具需加入名单**；且该中间件目前**未被任何运行时装配**（见 1.3.3） |
| 工具幂等守卫 | `crates/agent-tools/src/executor.rs:72-131` + `idempotency.rs:291-300` | 执行键 = `工具名@snapshotTag` 或 `工具名:参数规范hash`（idempotency.rs:291-300）——E01 工具天然受益：同参重试会被去重，**无需额外适配** |
| 路径安全 `resolve_workspace_path` | `crates/agent-tools/src/tools/mod.rs:171-226` | 越界/`..`/深度/控制字符校验 + Windows verbatim 前缀剥离，E01 的 target_file 直接复用 |
| 快照标记 `snapshot_tag` | `crates/agent-tools/src/tools/mod.rs:277-281` | 文件 SHA-256 前 12 位，E01 返回 `newSnapshotTag` 与 read_file 的输出对齐 |
| 删除接管 `conex_fs::trash` | `crates/conex-fs/src/trash.rs` | `TrashService::snapshot`（写前复制快照）与 `restore_force`（覆盖恢复），backup 中间件的存储面 |
| 父目录创建 `ensure_parent_dir` | `crates/conex-fs/src/lib.rs:84-95` | E01 若目标文件不存在（特殊边界）可复用 |

#### 1.3.3 关键事实：备份中间件、写路径互斥、探索配额在运行时均未接线

- `crates/session-loop/src/tool_exec.rs:683-686`：主执行器构造 `ToolContext` 时 `write_claims: None`、`write_claim_holder: None`、`explore_docs_quota: None`（注释明言"未接线（None = 写工具不强制互斥）"）；
- `crates/session-loop/src/loop/mod.rs:219`：`tool_middleware: Vec::new()`——中间件链默认空；
- `apps/agent-workbench/src-tauri/src/` 全目录检索 `tool_middleware|BackupMiddleware|middleware` **零命中**——壳层没有装配任何中间件（backup.rs:23-28 模块头注释声称"经 SessionLoopOptions.tool_middleware 注入（壳层装配）"，但当前壳层代码中未找到装配点）；
- 全仓库检索 `write_claims|WritePathRegistry` 的装配者：命中文件只有 agent-tools 自身（write_paths.rs / context.rs / middleware.rs / fs.rs）与 session-loop/tool_exec.rs——**没有任何代码把 `Some(Arc<WritePathRegistry>)` 放入 ctx**；explore_quota 同理（I6-M11 的 session_meta 后端 store 无实现者接线）。

这一事实对模块 E **和** 模块 G 都成立：契约层（agent-tools）已实现，装配层（session-loop / 壳层）未接线。REQ-E01 的"原子性 + 防并发竞争"若只靠工具自身而不接线互斥与备份，会退回"提示词纪律"水平。

### 1.4 判定

| 维度 | 结论 |
| --- | --- |
| 工具是否存在 | **不存在**（legacy 仅有 e2e 占位，Rust 12 工具清单无 replace 类） |
| 历史备注"重构遗失" | **不准确**：从未实现，只规划过（测试占位）——实施路径是全新设计而非恢复 |
| 原子性 | **无**：write_file 直接 `std::fs::write`（fs.rs:199），无临时文件/rename；多块替换无"内存完成→一次写盘"路径 |
| 单块替换前置 | **无**：`replace_file_content`（单块）也不存在，REQ-E01 1.3 节"单块用 replace、多块用 multi_replace"的配套前提落空 |
| 周边设施 | 写路径互斥（多路径声明）、快照备份、幂等守卫、路径校验**均已实现但未接线**；conex-diff 无 apply 方向能力但 E01 不依赖 |

### 1.5 差距清单（真 gap）

1. **G-E01-1：缺工具本体**。`multi_replace_file_content` 不存在：无 ToolDefinition / schema / execute 实现 / 注册。
2. **G-E01-2：缺原子写路径**。现有 write_file 是单次直接 `std::fs::write`；multi_replace 需要"内存完成全部 chunk 替换 → 一次写盘"，且任一 chunk 失败时文件保持原状。单进程内"读→内存改→一次写"本身即可满足需求语义（不存在其他写入者时）；但要防跨工具/跨子代理竞争，必须依赖写路径互斥接线（当前 None）。
3. **G-E01-3：备份中间件名单未覆盖新工具**。`default_backup_tools()` 只有 write_file（backup.rs:42-44），新工具若不加入，multi_replace 落盘前无快照，写坏不可恢复——违背项目"任何破坏性写操作执行前自动暂存备份"铁律（backup.rs:3-8）。
4. **G-E01-4：中间件链未装配**。即便名单扩展，`tool_middleware` 目前为空 Vec（loop/mod.rs:219），壳层需装配 `BackupMiddleware`。
5. **G-E01-5：EOL 归一化缺失**。Windows 上 CRLF 与 LF 混用会使 `target_content` 精确匹配失效——前端 applyFileDiff 已有 `normalizeEol`/`preferEolStyle`（applyFileDiff.ts:287-297）参考，Rust 侧无对应工具函数。
6. **G-E01-6：无单块替换工具**。REQ-E01 1.3 规定"单点修改仍用 replace_file_content"，此前提工具不存在（可考虑 multi_replace 的 n=1 特例或独立单块工具，见建议）。

### 1.6 建议（落地到现有架构）

#### 1.6.1 数据结构：replacement_chunks 如何映射现有工具

新建 `crates/agent-tools/src/tools/replace.rs`（或扩展 `tools/fs.rs`，推荐独立模块，与现有 fs.rs 的纯读写职责分离），实现 `MultiReplaceFileTool`：

```
工具名：multi_replace_file_content
入参 schema（对齐 REQ-E01 1.1）：
  target_file          string   必填，绝对路径（经 resolve_workspace_path 校验）
  replacement_chunks   array    必填，非空数组，元素：
    start_line         integer  搜索范围起始行号（1-indexed）
    end_line           integer  搜索范围结束行号（1-indexed）
    target_content     string   精确原文（含缩进；匹配失败即整体回滚）
    replacement_content string  替换后内容
    allow_multiple     boolean  默认 false；true 时范围内允许替换多个实例，否则 >1 处匹配报错
输出：
  path / chunksApplied / newSnapshotTag / text（"Replaced N chunks in <path>"）
```

执行流程（映射现有设施）：

1. **路径校验**：`resolve_workspace_path(&ctx.workspace_root, target_file)`（tools/mod.rs:171-226）；
2. **写路径互斥声明**：`claim_write_guard(ctx, target_file, ClaimMode::Write)`（write_paths.rs:303-318）——单文件场景 claim_one 即可；若未来支持多文件可走 `claim(holder, paths, mode)` 的多路径原子声明（write_paths.rs:172-223）。冲突 → `tool.write_path_conflict` 结构化错误（谁占用/何时），与 write_file 行为一致（fs.rs:187）；
3. **探索配额检查**：`guard_explore_docs_write(ctx)`（explore_quota.rs:262-276），与 write_file 对齐（fs.rs:189）——避免探索类子代理借 multi_replace 绕过 write_file 的配额检查；
4. **读入全文**：复用 `decode_text`（tools/mod.rs:295-334）判 BOM/二进制；二进制拒绝（与 diff.rs:111-116 同语义）；
5. **EOL 归一化**：按文件既有换行风格归一化为 `\n` 做匹配，写回时恢复原风格（移植 applyFileDiff.ts:287-297 的 normalizeEol/preferEolStyle 语义；目标文件是 UTF-8 无 BOM 项目惯例下可简化为仅 CRLF→LF 匹配 + 写回还原）；
6. **逐 chunk 匹配**：按 `start_line..=end_line` 圈定候选行区间 → 在该区间内 `matches` 统计 `target_content` 出现次数 → `allow_multiple=false` 且 >1 处 → 该 chunk 失败；0 处 → 失败；1 处 → 记录替换区间（行号区间 + 精确偏移）；
7. **内存整体应用**：**所有 chunk 先全部匹配成功，再一次性按行偏移重建全文**（chunk 间可能重叠 → 按"先匹配后应用 + 区间重叠检测"拒绝重叠 chunk，或按从后往前应用避免偏移漂移；推荐：校验期即检测区间重叠并报错，语义最清晰）；
8. **一次性落盘**：全部成功后单次写盘。原子写建议：同目录临时文件（`<name>.agent-tmp-<rand>`）+ `std::fs::rename`（Windows 上 rename 覆盖既有文件会失败，需先 `remove` 旧文件或使用 `ReplaceFile` 语义——在**已有写路径互斥 + 写前快照**前提下，跨进程竞争已由互斥消除，进程内崩溃由快照兜底，因此"先删后 rename"是足够且简单的一致方案）；
9. **配额消耗**：写盘成功后 `consume_explore_docs_quota(ctx)`（explore_quota.rs:280-287）；
10. **幂等**：无需改动——执行器按"工具名+参数规范hash"自动去重（idempotency.rs:291-300），同 chunk 集合重试返回 Deduplicated。

#### 1.6.2 原子性如何保证（分层）

- **层 1（需求语义）**：读 → 全部 chunk 校验 → 内存构建 → 一次写盘。任一 chunk 失败直接返回错误（附失败 chunk 序号与原因），**不触碰磁盘**——这是 REQ-E01 1.2 的核心验收（"文件不做任何修改"），单进程内天然满足；
- **层 2（跨工具竞争）**：写路径互斥接线——执行器装配 `Some(Arc<WritePathRegistry>)`（当前 None，tool_exec.rs:683），使并发 write_file / multi_replace / delete_file 对同一路径互斥。这是"禁止对同一文件并行发起多个单块替换调用"（REQ-E01 1.3）的引擎强制面；
- **层 3（崩溃/写坏恢复）**：BackupMiddleware 将 `multi_replace_file_content` 加入备份名单（backup.rs:42-44 扩展），写前快照进回收站域，`restore_force` 覆盖恢复（backup.rs:379-401 的 roundtrip 测试语义）；
- **层 4（文件系统级）**：临时文件 + rename 的原子写（见 1.6.1 第 8 步）。在层 2、3 就位后此层是锦上添花，但建议做——write_file 也应逐步升级为同一路径，统一"写类工具原子写"契约。

#### 1.6.3 与现有工具的整合矩阵

| 现有设施 | 整合方式 | 落点 |
| --- | --- | --- |
| write_file | 共享 resolve_write_encoding / encode_text（fs.rs:222-283）；Overwrite 语义见 REQ-E02 | tools/replace.rs 复用 fs.rs 内部函数（同模块可见性调整） |
| 备份中间件 | `default_backup_tools()` 增加 `"multi_replace_file_content"`；同时壳层装配 `BackupMiddleware::with_defaults`（backup.rs:70-72） | backup.rs:42-44 + 壳层 core_run_commands.rs options 装配 |
| 写路径互斥 | execute 内 `claim_write_guard`（fs.rs:187 同款接线） | tools/replace.rs 第 2 步 |
| 幂等守卫 | 零改动（执行器自动覆盖） | executor.rs:72-131 |
| diff_text | 可增加"应用 diff 到文件"反向工具（复用 DiffEngine hunk 结构），作为 E01 的互补形态；**非本需求必需**，列为后续增强 | conex-diff 新增 apply 方向 |
| run_subagent 工具集裁剪 | 新工具属**写类**，需加入 `WRITE_TOOL_NAMES`（readonly.rs:19-24），只读子代理自动剔除（fail-closed 白名单逻辑自动生效） | readonly.rs:19-24 |

#### 1.6.4 关于单块替换工具

REQ-E01 1.3 要求"单点修改仍使用 replace_file_content"。建议：multi_replace 的 `replacement_chunks` 长度为 1 时即等价于单块替换，**同一工具覆盖两种用法**，避免注册表膨胀与"何时用哪个"的提示词负担；若严格按需求命名，可在 registry 注册 `replace_file_content` 别名（内部委托同一个 execute）。推荐前者（一个工具 + schema 文档说明），验收按 REQ-E01 1.3 语义补一条"chunks=1 时行为与单块替换一致"的测试。

### 1.7 接口契约草案（供任务书引用）

以下为 `multi_replace_file_content` 的完整 JSON schema 草案（对齐现有工具的 schema 风格：`crates/agent-tools/src/tools/fs.rs:145-158` 的 write_file schema 形态）：

```json
{
  "name": "multi_replace_file_content",
  "description": "对同一文件的多个非连续代码块做精确原文替换：任一 Chunk 匹配失败则整体回滚，文件保持原状。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_file": {
        "type": "string",
        "description": "目标文件绝对路径（工作区内；经路径安全校验）"
      },
      "replacement_chunks": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "properties": {
            "start_line": { "type": "integer", "minimum": 1, "description": "搜索范围起始行号（1-indexed，闭区间）" },
            "end_line": { "type": "integer", "minimum": 1, "description": "搜索范围结束行号（1-indexed，闭区间）" },
            "target_content": { "type": "string", "description": "要被替换的精确原文（含缩进空白，必须与文件严格匹配）" },
            "replacement_content": { "type": "string", "description": "替换后的新内容（需完整承载目标区间内的注释行）" },
            "allow_multiple": { "type": "boolean", "default": false, "description": "范围内允许多实例替换；默认 false（多处匹配报错）" }
          },
          "required": ["start_line", "end_line", "target_content", "replacement_content"],
          "additionalProperties": false
        }
      }
    },
    "required": ["target_file", "replacement_chunks"],
    "additionalProperties": false
  },
  "dangerous": true,
  "fatalOnError": false
}
```

输出形状（对齐 write_file 输出，fs.rs:210-217）：

```json
{
  "path": "src/component.ts",
  "chunksApplied": 2,
  "newSnapshotTag": "3f9a2c1b7d4e",
  "text": "Replaced 2 chunks in src/component.ts (12 lines changed)\nSnapshot tag: 3f9a2c1b7d4e"
}
```

错误形状（任一 chunk 失败，文件不变）：

```
ToolError { code: "tool.execution_failed"（或专用域码），
            message: "multi_replace_file_content: chunk #2 匹配失败
                      （行 20-25 内未找到 target_content，允许范围 20..=25，文件共 120 行）；文件未做任何修改" }
```

### 1.8 执行流程伪代码（原子性骨架）

```
async fn execute(ctx, args):
    # 1. 入参解析与路径校验
    target = resolve_workspace_path(ctx.workspace_root, args.target_file)   # tools/mod.rs:171-226
    chunks  = parse_chunks(args.replacement_chunks)                          # 含行号范围校验（start<=end、1-indexed）

    # 2. 引擎级互斥声明（写路径互斥接线后生效；None 时不强制——现状未接线）
    _claim = claim_write_guard(ctx, args.target_file, ClaimMode::Write)      # write_paths.rs:303-318；冲突 → tool.write_path_conflict

    # 3. 探索类配额检查（与 write_file 同款，fs.rs:189）
    guard_explore_docs_write(ctx)?                                          # explore_quota.rs:262-276

    # 4. 读入 + 解码（BOM/二进制判定；二进制拒绝——对齐 diff.rs:111-116）
    bytes   = fs::read(target)
    decoded = decode_text(bytes)                                            # tools/mod.rs:295-334
    if decoded.is_binary: return Err("binary")

    # 5. EOL 归一化匹配（移植 applyFileDiff.ts:287-297；匹配用 \n，写回还原原风格）
    normalized = normalize_eol(decoded.text)

    # 6. 逐 chunk 匹配（全部通过才进入应用阶段——REQ-E01 1.2 回滚语义）
    matches = []
    for i, c in chunks:
        scope = lines(normalized)[c.start_line-1 .. c.end_line]             # 行号范围圈定候选区间
        hits  = count_occurrences(scope.join('\n'), normalize_eol(c.target_content))
        if hits == 0:                       return Err("chunk #{i} 匹配失败（target_content 未找到）")
        if hits > 1 and not c.allow_multiple: return Err("chunk #{i} 匹配失败（范围内出现 {hits} 处，allow_multiple=false）")
        matches.push(byte/行偏移)

    # 7. 区间重叠校验（chunk 间行区间不允许重叠——语义最清晰的拒绝方式）
    if any_overlap(matches): return Err("chunks 行区间重叠")

    # 8. 内存整体应用（一次重建全文；未触碰磁盘）
    new_text = apply_all(normalized, matches, chunks)

    # 9. 一次性落盘（原子写：同目录临时文件 + rename；Windows 上目标存在时先 remove 再 rename）
    tmp = target.with_extension("agent-tmp")                                # 或 <name>.agent-tmp-<rand>
    fs::write(tmp, encode_text(restore_eol_style(new_text), decoded.encoding))?
    fs::remove(target)?                                                      # Windows rename 覆盖语义
    fs::rename(tmp, target)?                                                 # 失败时清理 tmp

    # 10. 配额消耗 + 输出
    consume_explore_docs_quota(ctx)                                          # explore_quota.rs:280-287
    return { path, chunksApplied, newSnapshotTag: snapshot_tag(target), text }
```

注意第 6 步与第 9 步之间**没有其他工具可以介入**（单次工具调用内完成），这是"原子性"在本架构中的真实含义：单进程内，互斥声明（第 2 步）挡住了并发写者，快照（中间件）兜底了崩溃恢复，写盘本身（第 9 步）是一次 rename 交换。

### 1.9 测试策略与验收映射

对齐现有测试模式（fs.rs:480-673 的 `TempWorkspace` + mock 上下文模式；write_paths.rs:561-582 的并发测试模式）：

| 验收（REQ-E01） | 测试用例 | 落点 |
| --- | --- | --- |
| 单次调用完成 N 个非连续块替换 | 头 import + 中部字段 + 尾部导出三块同调用（对标 legacy e2e 的初始代码形态 967e7846^ e2e:125-132），断言三处全部生效、输出 chunksApplied=3 | tools/replace.rs 单元测试 |
| 任一 chunk 失败整体回滚 | chunk#2 target_content 不匹配（少一个空格），断言返回错误且**文件字节不变**（读回原内容比较） | 同左 |
| 与逐个手工修改效果一致 | 相同修改分别用 multi_replace（3 chunks）与 write_file 全量重写，断言两文件字节一致 | 同左 |
| allow_multiple=false 多处匹配报错 | target_content 为重复片段，范围内 2 处 → 报错、不写盘；allow_multiple=true 时两处都被替换 | 同左 |
| 行号范围圈定 | target_content 在范围内 1 处、范围外 1 处 → 只替换范围内（范围外不动） | 同左 |
| chunks=1 等价单块（REQ-E01 1.3） | 单 chunk 调用与"单块替换"语义一致 | 同左 |
| 注释保留（REQ-E03 验收共用） | 目标区间含 Rustdoc/行内注释，replacement_content 承载注释 → 断言注释行完整；未覆盖区间的注释原样 | 同左（E03 验收 1） |
| 并发防竞争（REQ-E01 1.3 后半） | 接线后：A 持有 write claim，B 调用 multi_replace 同路径 → `tool.write_path_conflict`（对齐 write_paths.rs:596-628 的 write_file 冲突测试） | session-loop 集成测试 |
| 备份覆盖（安全铁律） | 接线后：multi_replace 前快照登记；写坏后 restore_force 恢复（对齐 backup.rs:379-401 roundtrip） | session-loop 集成测试 |
| 幂等 | 同参二次调用 → deduplicated（对齐 executor.rs:277-299） | executor 集成测试 |
| 只读裁剪 | 只读子代理注册表不含 multi_replace_file_content（对齐 readonly.rs 测试模式） | readonly.rs 测试 |

### 1.10 与 legacy e2e 测试的对应关系（恢复参考）

legacy e2e（967e7846^:packages/agent-daemon/src/__tests__/agent-real-workflow-e2e.test.ts:121-160）虽然只是占位，但它的场景设计仍值得作为 E01 验收基准的"黄金用例"：

- **场景**：`src/component.ts` 初始 5 行（import React → 组件定义 → useState(0) → return div → 收尾分号），需要三处非连续修改——补全 import（`import React from 'react';` → `import React, { useState } from 'react';`）、改初始值（`useState(0)` → `useState(10)`）、改 JSX 标签（`<div>{count}</div>` → `<button>{count}</button>`）；
- **与 REQ-E01 的映射**：这就是"头部 import + 中部字段 + 尾部逻辑"三块非连续替换的标准形态（REQ-agent-engine-capabilities.md:638 的示例场景），三块互不连续、间距 3-4 行；
- **采用建议**：把该场景原样作为 E01 的集成测试输入（chunks=3），断言落盘结果等于 legacy 测试中 `replacedCode` 的期望形态——即"替换结果与逐个手工修改的效果一致"验收的直接物化。

---

## 2. REQ-E02：文件创建工具

### 2.1 现状证据（write_file 现状）

`crates/agent-tools/src/tools/fs.rs:132-219` 的 `WriteFileTool`：

- **父目录自动创建**：`conex_fs::path_utils::ensure_parent_dir(&file_path)`（fs.rs:197，实现见 conex-fs/src/lib.rs:84-95 `create_dir_all`）——REQ-E02"父目录不存在时自动创建"**已满足**，且测试覆盖（fs.rs:560-581 `write_then_read_roundtrip` 断言 `sub/dir` 被创建）；
- **无 Overwrite 保护**：`std::fs::write(&file_path, &bytes)`（fs.rs:199）直接覆盖写入，工具描述明言"覆盖写入"（fs.rs:144），schema 无 overwrite 参数（fs.rs:145-158）——REQ-E02"默认情况下文件已存在则报错，需显式 Overwrite=true 才覆盖"**完全不满足**；
- 已有能力：编码续写（BOM 探测续写原编码，fs.rs:222-252）、快照标记返回（fs.rs:205-216）、写路径互斥接线点（fs.rs:187）、探索配额接线点（fs.rs:189/203）。

### 2.2 判定

REQ-E02 的一半（父目录自动创建 + 绝对路径校验 + 返回路径确认）现状已具备；**另一半（默认拒绝覆盖）缺失**。write_file 当前是"无条件覆盖写"，与需求"防意外覆盖"的语义相反。另外注意：REQ-E02 描述的是"文件创建工具"，而现状 write_file 是"写文件工具"——两者在需求语境的差别仅在于防覆盖语义，不建议另立 `create_file` 工具（会让"新建 vs 覆盖"决策回到提示词层，且与现有 12 工具注册表及前端 FileDiff 落盘语义割裂）。

### 2.3 差距清单

1. **G-E02-1：无默认拒绝覆盖**。已存在文件时直接覆盖（fs.rs:199），无报错路径；
2. **G-E02-2：schema 无 overwrite 字段**（fs.rs:145-158）；
3. **G-E02-3：行为变更的兼容面**。若把 write_file 默认改为拒绝覆盖，现有依赖"写文件即覆盖"的调用方（前端 applyFileDiff 的 full_write 落盘、diff 工具无关）与既有测试（fs.rs 多个测试直接覆盖写入）需同步；前端 `workspaceFsApi.writeTextFile`（workspaceFsApi.ts:175-185）走的是 Tauri `write_file_content` 命令（壳层命令，非 agent-tools 工具），不受影响，但需确认壳层命令与工具语义是否要统一。

### 2.4 建议

在 **write_file 上扩展 `overwrite: boolean`（默认 false）**，而非新增工具：

1. schema 增加 `"overwrite": { "type": "boolean", "description": "文件已存在时是否允许覆盖，默认 false（已存在则报错）" }`（fs.rs:145-158）；
2. execute 内、`claim_write_guard` 之后（fs.rs:187 之后）加存在性检查：`file_path.exists()` 且 `overwrite != true` → 返回结构化错误（错误码建议沿用 `tool.execution_failed` 或新增 `tool.file_exists` 域码，对齐 write_paths 的域码先例 write_paths.rs:37）；
3. 写入成功后返回（fs.rs:210-217 现有形状即可，含 path 确认——满足"创建成功后返回文件路径确认"）；
4. 兼容策略：默认值取 **false（拒绝覆盖）** 以完全对齐 REQ-E02，同时把调用面中"意图覆盖"的既有调用显式传 `overwrite: true`；测试同步（现有 `write_file_supports_encodings`（fs.rs:584-598）第二次写入需加 overwrite: true）；
5. 备份中间件名单无需变更（write_file 已在名单 backup.rs:42-44），但注意：**新建文件场景**（原文件不存在）备份中间件登记 nil-content 快照（backup.rs:20-21、242-266），覆盖场景登记原内容快照——Overwrite 语义与此天然协同；
6. 幂等注意：同一参数（path+content+overwrite=false）对"已存在文件"与"不存在文件"的结果不同，参数 hash 键（idempotency.rs:291-300）会把二者视为同一键——建议在键素材上显式包含 overwrite 与文件存在性（或依赖 snapshotTag 更强键），作为接线期细化项。

### 2.5 行为兼容矩阵（Overwrite 语义变更影响面）

| 调用方 | 现状行为 | 变更后（默认拒绝覆盖） | 处理 |
| --- | --- | --- | --- |
| AI 工具调用（write_file 新建文件） | 成功 | 成功（文件不存在 → 放行） | 无感 |
| AI 工具调用（write_file 覆盖旧文件） | 成功 | **报错**，需显式 overwrite: true | 提示词层引导 + 错误文案明确指引 |
| 前端 applyFileDiff full_write 落盘 | 走 Tauri `write_file_content` 命令（workspaceFsApi.ts:175-185） | 不受影响（壳层命令与工具是两条路径） | 无 |
| 前端 applyFileDiff search_replace 落盘 | 同上 | 同上 | 无 |
| 壳层命令 `write_file_content`（Tauri 侧实现） | 无条件写 | **建议同步加 overwrite 语义**（否则工具与命令口径分裂，AI 通过工具写、UI 通过命令写行为不一致） | 壳层命令 + 前端 workspaceFsApi 同步 |
| G01 的惰性目录创建（write_file 首次写 `.agent-outputs/<id>/x.md`） | 自动建目录 | 仍自动建目录（文件不存在 → 放行） | 无感 |
| G02 多子代理并发写不同文件 | 无保护 | 仍无保护（文件级存在性检查不解决并发；并发由 write_claims 接线解决，见 5.4） | 与 E02 正交 |
| 既有测试（fs.rs:584-598 等覆盖写入用例） | 成功 | 失败 | 测试显式传 overwrite: true |
| 备份中间件 | 写前快照（backup.rs:93-152） | 拒绝场景不触发快照（存在性检查在 claim 之后、写盘之前） | 顺序确认：存在性检查应在备份中间件 before 钩子之后？——否，中间件在 execute 之前运行，快照必然先于存在性检查发生；拒绝覆盖场景会留下一条无意义的快照条目（后续可清理或接受） |

变更点小结：**涉及 3 个文件（fs.rs schema/execute + 壳层 Tauri 命令 + 前端 workspaceFsApi 类型）+ 2 处测试组（fs.rs 覆盖用例、可能的前端应用层测试）**；对 G01/G02 的目录自动创建无副作用（新建路径不受影响）。

---

## 3. REQ-E03：保留文档与注释（编辑规范约束）

### 3.1 现状证据

需求本身承认：**"工具本身的替换机制基于精确内容匹配，天然不会修改未被指定的内容"**（REQ-agent-engine-capabilities.md:697）。因此本需求没有独立的"功能实现"，只有两个依附面：

1. **工具机制面**：精确匹配替换工具是否存在（现状：不存在，见 1.1.3）——本需求的前提是 E01 落地后的替换工具行为约束；
2. **提示词约束面**：系统 Prompt / Agent 指令中是否强调"保留与修改无关的注释/文档字符串"（REQ-agent-engine-capabilities.md:698）。

现状调查（提示词面）：

- `crates/agent-tools/src/subagent_inject.rs` 存在成熟的"注入段"先例（C2 创建时间注入 `started_at_section`、git 回退指引 `git_revert_caution_section`，lib.rs:91-99 导出）——说明"在系统提示词中挂固定约束段"是既有架构模式；
- 探索配额凭证段 `explore_docs_credential_section`（explore_quota.rs:213-221）是"提示词协议层约束"的另一个同型先例（固定文案 + 参数化 + 快照断言测试 explore_quota.rs:587-606）；
- 但**未发现任何与"保留注释/文档字符串"相关的注入段或系统提示词约束**（检索 `注释|保留|comment` 于 subagent_inject / session-loop 提示词构建面，无命中）。

### 3.2 判定

REQ-E03 的**机制面**依赖 E01（精确匹配替换工具），当前无从谈起——但一旦 E01 落地，其"target_content 精确匹配 + 未被指定的内容不动"的机制**天然满足**验收标准（"未被 target_content 覆盖的注释行完整保留"）；**提示词面**目前完全空白，需要新增一段注入约束。

### 3.3 差距清单

1. **G-E03-1（依附）**：替换工具不存在（同 G-E01-1），机制面验收无法执行；
2. **G-E03-2**：系统 Prompt / 子代理注入段无"保留注释"约束（注入段模式存在但未用）；
3. **G-E03-3（弱）**：前端 applyFileDiff 的 search_replace 已有"精确替换"语义，但 UI 落盘面同样无注释保留提示——非引擎需求范围，可忽略。

### 3.4 建议

1. **机制面**：不新增代码——E01 落地时把"精确匹配、未指定内容不动"写入工具 schema description（fs.rs 风格的中文 description），并把 REQ-E03 验收作为 E01 的测试用例（替换中部字段 + 断言头部注释/尾部 doc 注释原样保留）；
2. **提示词面**：新增固定注入段（对齐 subagent_inject.rs 模式）：
   - 位置：`crates/agent-tools/src/subagent_inject.rs` 新增 `comment_preservation_section()`，导出（lib.rs:94-99 同款导出）；
   - 文案核心：替换时 `replacement_content` 必须完整承载原注释行；不得删除、修改、移位与本次修改无关的注释与文档字符串（Rustdoc/JSDoc/行内注释）；生成 `replacement_content` 时如无必要不得改写注释内容；
   - 挂载：主 agent 系统提示词与子代理注入段（与 C2 注入同构；注入面见 04-Agent功能需求设计.md:329 的 build_context 先例）；
   - 测试：快照断言固定结构（对齐 explore_quota.rs:587-606 的 credential_section 快照测试模式）。

---

## 4. REQ-G01：对话级默认工作目录自动生成

### 4.1 现状证据

#### 4.1.1 全仓库检索：`.agent-outputs` / 会话输出目录逻辑**完全不存在**

对 `crates/`、`apps/`、`packages/` 全量检索 `agent-outputs|agent_outputs|outputs_dir|session_dir|output_dir`：

- 命中仅一处：**需求文档自身**（`docs/feature-gap-analysis/REQ-agent-engine-capabilities.md`）；
- 代码侧零命中：agent-tools 无输出目录概念；session-loop 无；tauri 壳层（`apps/agent-workbench/src-tauri/src/`，含 main.rs / core_run_commands.rs / workspace.rs / session_commands.rs）无会话目录/输出目录生成逻辑；
- `docs/multi-agent-repair/`、`docs/feature-gap-analysis/` 等实际文档目录都是**用户显式指定**的落位（符合 REQ-G01"用户指定文件夹时直接用"分支），不存在系统自动生成的 `.agent-outputs/<conversation-id>/` 形态。

即：**REQ-G01 的"系统自动生成"分支是零实现**。

#### 4.1.2 可承载持久化的基础设施：session_meta（已存在、未消费）

- 表结构：`crates/conex-db/src/schema.rs:87` —— `CREATE TABLE IF NOT EXISTS session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;`（**全局 KV，无会话列**）；
- 读写接口：`crates/conex-db/src/sessions.rs:140-171` —— `get_session_meta(key)` / `set_session_meta(key, value)`（幂等 upsert，`ON CONFLICT(key) DO UPDATE`）；
- 会话隔离键编码先例：`explore_quota.rs:43-49` `session_meta_key_of(session_id, key)` → `"{session_id}:{key}"`（对齐 revert_guard.rs 的 S7 接线模式）——**G01 的输出目录路径可直接复用同一键编码**，存 `"{session_id}:output_dir"`；
- 消费方现状：session_meta 的现有消费方只有回退护栏（revert_guard）与探索配额（explore_quota，未接线）——G01 加入不引入新表。

#### 4.1.3 惰性创建的实现载体：现有写链路天然支持"首次写入才建目录"

`write_file` 已通过 `ensure_parent_dir`（fs.rs:197）在首次写入时自动创建任意深度父目录——**"目录为惰性创建（首次写入时创建）"这一验收，在文件系统层面已由 write_file 天然满足**。缺的是"把输出目录确定下来并通知 AI"的会话级机制（见 4.4）。

### 4.2 判定

REQ-G01（P1）在引擎侧**整体缺失**：无默认工作目录概念、无生成规则、无会话绑定持久化、无通知 AI 通道。可复用的只有：session_meta KV（存路径）、ensure_parent_dir（建目录）、注入段模式（通知 AI）。"用户指定路径直接用"分支现状天然成立（write_file 接受任意工作区内路径）。

### 4.3 差距清单

1. **G-G01-1**：无输出目录解析/生成模块（"用户指定 vs 默认生成"的决策逻辑不存在）；
2. **G-G01-2**：会话级输出目录不持久化（重启后 AI 不知道上次的产出目录；session_meta 有承载能力但无消费方）；
3. **G-G01-3**：无"创建后通知 AI"通道（subagent_inject 注入段模式可复用，主 agent 侧无对应注入点）；
4. **G-G01-4**：无惰性创建策略代码（文件系统层面已天然满足，但"确定目录路径"发生在首次写之前——需要一次解析动作，不应创建空目录）；
5. **G-G01-5**：会话标题/日期派生（REQ-G01 建议 `<日期>-<简短标题>` 形态）——会话标题机制在 `apps/crish-desktop/src/api/sessionTitle.ts` 前端存在，但 Rust 引擎侧无标题溯源到输出目录的链路。

### 4.4 建议（与 session_meta 整合 / 惰性创建）

新增 `crates/agent-tools/src/tools/output_dir.rs`（或归入 fs 域）工具 `resolve_output_dir` + 引擎侧装配：

1. **工具语义**：AI 在需要产出文档时调用一次 `resolve_output_dir`（可带可选 `folder` 参数）：
   - 显式 `folder` → 校验（resolve_workspace_path，tools/mod.rs:171-226）并返回该路径（不创建）；
   - 无 `folder` → 生成 `<workspace_root>/.agent-outputs/<conversation-id>/`，**惰性**：仅把路径记录进 session_meta（`"{session_id}:output_dir"`，复用 explore_quota.rs:43-49 的键编码）并返回，**不创建目录**；目录在 AI 首次 write_file 时由 ensure_parent_dir（fs.rs:197）自动创建——首次写入即目录诞生，满足"惰性创建"验收；
   - 返回值同时携带 `dirCreated: false` 与"首次写入时自动创建"说明，避免 AI 误判目录不存在；
2. **幂等**：同一会话重复调用返回同一路径（读 session_meta 命中即返回，不重复生成）；
3. **通知 AI**：工具输出 text 中给出完整路径（对齐 read_file 的 text 头格式先例 fs.rs:98-113）；同时在子代理注入段（subagent_inject.rs）提供 `output_dir_section(path)` 固定段，spawn 时若主 agent 已确定产出目录则注入，AI 后续文档产出默认写入该目录（REQ-G01"工作目录路径在创建后通知 AI"）；
4. **清理策略（后续增强）**：`.agent-outputs/` 随会话删除策略走 trash（conex-fs/trash.rs 删除接管，I2-S3），不留孤儿目录——列为 P2 细化；
5. **边界**：read-only 子代理默认不允许产出文档（配额语义见 REQ-G02），resolve_output_dir 对探索类子代理可返回拒绝或仅返回主 agent 指定目录（接线期按 C5 语义决策）。

### 4.5 与 session-loop run 生命周期的整合细节

`resolve_output_dir` 作为**工具**落地时，需要明确它在会话生命周期中的行为定位：

| 时机 | 行为 | 依据 |
| --- | --- | --- |
| run 开始（每次 run） | 不预创建目录、不预读路径（惰性——REQ-G01 验收"首次写入时创建"） | 需求 REQ-agent-engine-capabilities.md:805 |
| 首次调用 resolve_output_dir | 生成路径 + 写入 session_meta `"{session_id}:output_dir"` | sessions.rs:159-171 set_session_meta（幂等 upsert） |
| 同会话再次调用 | 读 session_meta 命中即返回同一路径（幂等） | sessions.rs:140-158 get_session_meta |
| 跨 run 重启 | session_meta 持久化在 conex-db（schema.rs:87），重启后同一会话路径不变——**AI 重启后续写同一产出目录**，不产生新目录 | 对齐 explore_quota 的持久化验收（04-Agent功能需求设计.md:179 "重启后配额恢复"） |
| 用户显式指定 folder | 直接返回，且**同时**写入 session_meta（用户指定优先级高，后续默认沿用） | 需求 REQ-agent-engine-capabilities.md:802 |
| 会话删除 | 目录不自动清理（P2：随会话删除走 trash） | 见 4.4 第 4 条 |

装配位置建议：引擎侧实现一个轻量 `OutputWorkspace` 服务（读/写 session_meta + 路径生成规则），注入 ToolContext（新增字段 `output_dir: Option<Arc<dyn OutputDirResolver>>`，None = 未接线，工具返回"未装配"结构化错误——对齐 subagent_spawner 的接线模式，tools/mod.rs:50-53）。路径生成规则为纯函数（session_id → `.agent-outputs/<id>/`），可单测。

### 4.6 故障与边界场景

| 场景 | 行为设计 | 说明 |
| --- | --- | --- |
| workspace 只读 | 首次 write_file 失败（ensure_parent_dir 或写盘错误）→ 结构化错误透传 | 与现状 write_file 行为一致（fs.rs:197-201） |
| session_id 含非法文件名字符 | 路径生成需净化（session_id 一般是 UUID，但兜底剥离 `\/:*?"<>|` 与控制字符，对齐前端 normalizeApplyPath 的净化思路 applyFileDiff.ts:55-61） | 防注入路径 |
| 多 run 并发首次调用 resolve_output_dir | session_meta 写入是单连接串行（sessions.rs:141-170 的 `self.conn.lock()`），并发下先写者胜，后写者读回同一值 | 无需额外锁 |
| 用户显式 folder 之后又想换目录 | 显式 folder 每次调用都生效（不覆盖 session_meta 默认键），AI 换目录 = 换 folder 参数 | 语义简单 |
| `.agent-outputs/` 本身在 git 仓库内被跟踪 | `.gitignore` 加条目（G03 联动）；已跟踪文件需 git rm 提示（文档层面） | 见 6.4 |
| read-only 子代理调用 | 拒绝或只允许主 agent 指定目录（见 4.4 第 5 条）——**配额凭证语义复用**（explore_quota.rs:213-221 的凭证注入段可扩展为"产出目录凭证"） | C5 联动 |

---

## 5. REQ-G02：多 Agent 协作文档产出

### 5.1 现状证据

#### 5.1.1 配额机制（C5）已实现但未接线

`crates/agent-tools/src/explore_quota.rs` 完整实现了 04-Agent功能需求设计.md C5（docs/multi-agent-repair/04-Agent功能需求设计.md:156-181）的配额语义：

- 判定：`is_explore_class`（explore_quota.rs:182-184，read-only 能力模式即探索类，researcher 角色兼容）；
- 检查：`check_explore_docs_write`（explore_quota.rs:192-207，凭证 + 配额上限双重判定）；
- 凭证注入段：`explore_docs_credential_section`（explore_quota.rs:213-221，"你已获主 agent 分配探索类文档配额"固定段）；
- 装配辅助：`quota_context_for_spawn`（explore_quota.rs:232-255）；
- 工具接线：write_file 内 `guard_explore_docs_write` / `consume_explore_docs_quota`（fs.rs:189/203）；
- 持久化契约：`ExploreDocsQuotaStore` trait（explore_quota.rs:96-106）+ session_meta 键（explore_quota.rs:34-49）。

但装配面（`ToolContext.explore_docs_quota`）在主执行器为 **None**（tool_exec.rs:686），且无任何代码构造 `Some(ExploreDocsQuotaContext)`（全仓库检索命中仅 agent-tools 内部与 tool_exec.rs 的 None 赋值）。**配额机制处于"实现完毕、等待引擎接线"状态**——这正是 REQ-G02 需要的"控制文档产出数量"机制。

#### 5.1.2 写路径互斥（I4-M3）同样实现未接线

`WritePathRegistry`（write_paths.rs:135-281）：会话级、TTL 60s 防悬挂（write_paths.rs:40）、路径前缀语义 Overlaps（write_paths.rs:333-341）、同持有者豁免（write_paths.rs:484-498 测试）、并发冲突拒绝（write_paths.rs:561-582 测试）、子代理长期声明语义（write_paths.rs:5-8 模块头）。`ToolContext.write_claims` 在主执行器为 **None**（tool_exec.rs:683）。

对 REQ-G02 的意义：**"多个子 Agent 向同一文档目录写入不同文件、不冲突"的引擎强制面**——不同文件互不重叠（write_paths.rs:459-469 兄弟文件不冲突测试），同一文件的并发写会被拒绝（write_paths.rs:561-582）——机制现成，只差装配。

#### 5.1.3 现实产出模式：docs/multi-agent-repair/ 是 REQ-G02 的目标形态

`docs/multi-agent-repair/` 是项目内**真实发生的多 Agent 协作文档产出案例**（由多轮修复方案驱动），其目录结构即 REQ-G02 的"共享目录 + 独立文件 + 汇总索引"形态：

```
docs/multi-agent-repair/
├── README.md                      # 汇总索引（清单表：文档/用途/对应轮次）
├── 00-方案总览.md                 # 汇总索引/入口（00 前缀 = 总览）
├── 01-轮次1-2-迁移收尾与引用修复.md  # 子文档（编号前缀 + 简短标题）
├── 02-轮次3-4-契约层与引擎内核.md
├── 03-轮次5-6-架构决策与终验门禁.md
├── 04-Agent功能需求设计.md
├── 05-协同操作约束与安全.md
└── 06-tool-middleware-hook-接线决策.md
```

证据（docs/multi-agent-repair/README.md:7-14）：

```
| 文档 | 用途 | 对应轮次 |
| --- | --- | --- |
| `00-方案总览.md` | 必读入口：方案定位、五条主线、闭环迭代模型… |
| `01-轮次1-2-…` | R1/R2 执行手册… |
```

配套的协作纪律（docs/multi-agent-repair/00-方案总览.md:48-61）：文件域互斥（"同一文件在轮内只允许被一个 Agent 写入"）、共享元文件唯一所有者（package.json/Cargo.toml）、"文件所有权"纪律。**这套纪律当前完全靠提示词（执行手册 + 05 号文档）约束**，引擎强制只有 I4-M3 写路径互斥（未接线）——这精确对应 REQ-G02 验收"不出现文件写入冲突"的两级实现路径（提示词级已有，引擎级待接线）。

文件名分配的现实形态：`NN-<简短标题>.md` 编号前缀（01/02/03…），与 REQ-G02 示例（`01-kernel-analysis.md`）完全一致——项目已有自己的命名惯例，建议沿用而非引入新规则。

#### 5.1.4 子 Agent 完成通知机制：wait_subagents 已实现

`crates/agent-tools/src/tools/wait_subagents.rs`（I5-M8）：三模式调度等待（await-all/timer/parallel-work）+ 事件驱动等待原语 + dispatch_* 持久化 + 运行中注入（tools/mod.rs:11-13 模块头）。REQ-G02"子 Agent 写入完成后通过事件总线或消息通知主控 Agent，附带文件路径与内容摘要"——wait_subagents 的 await 模式 + dispatch 持久化是现有承接面（D6 全局事件总线属另一模块 REQ-D06，不在本次范围）。

#### 5.1.5 导入插件（产出形态对照）

`packages/plugin-import-claude-codex/`（官方导入插件试点）不产出文档：其产物是 `SessionImportPayload` 中立载荷（README.md:9-13），经宿主写库。它对本需求的参考意义仅两点：(1) 项目"纯函数抽包 + manifest 声明 + 宿主接线"的插件形态可作为"文档汇总工具"的载体参考；(2) 证明包级产出与文件系统产出是两条线——文档产出走工具层，与插件机制正交。

#### 5.1.6 只读子代理工具集裁剪

`crates/agent-tools/src/readonly.rs:19-34`：`WRITE_TOOL_NAMES = ["write_file","delete_file","delete_dir","shell_command"]`，只读子代理白名单 `READONLY_TOOL_NAMES`（6 个只读工具），fail-closed 裁剪（readonly.rs:36-48）。**REQ-G02 落地后新写的文档产出工具必须同步登记进 WRITE_TOOL_NAMES**，否则只读子代理可绕过裁剪（当前 12 工具清单下 write_file 是唯一文档写入口，裁剪有效）。

### 5.2 判定

REQ-G02 的**机制骨架（配额、互斥、等待）已在 agent-tools 实现**，但**全部处于未接线状态**（主执行器 None、壳层未装配中间件、无 session_meta 后端 store 实现）；**流程纪律（共享目录、文件名分配、汇总索引）已有项目级成熟实践**（docs/multi-agent-repair/ 全目录），但纯提示词约束；**缺一个文档产出目录机制**（REQ-G01 的输出目录解析——G02 依赖 G01 的"共享产出目录"语义）。总体判定：**半实现（契约层）+ 未装配（引擎层）+ 有实践（流程层）**。

### 5.3 差距清单

1. **G-G02-1**：`explore_docs_quota` / `write_claims` 未装配——写路径互斥与配额在真实会话中不生效，并发写冲突与配额超限只能靠提示词；
2. **G-G02-2**：无 `ExploreDocsQuotaStore` 的 session_meta 实现（契约定义了 trait（explore_quota.rs:96-106），无实现者；引擎侧需按 explore_quota.rs:90-95 的契约说明实现 get/set 接线）；
3. **G-G02-3**：无"共享产出目录"机制（依赖 REQ-G01；主 agent 在 spawn prompt 中指定目录目前无工具/注入面支撑，只能靠自由文本）；
4. **G-G02-4**：无汇总索引工具/约定——"主控生成 README.md 或 00-summary.md"依赖主控自行 write_file（现实中 docs/multi-agent-repair/README.md 就是手工维护的清单表）；是否要工具化（如 `summarize_outputs` 列出目录内文档并生成索引骨架）是产品决策，需求未硬性要求工具，但建议评估；
5. **G-G02-5**：子代理产出通知的"文件路径 + 内容摘要"结构化承载——wait_subagents dispatch 持久化（tools/mod.rs:12）可承载，未确认摘要字段语义（接线期细化）；
6. **G-G02-6**：新工具（E01 的 multi_replace 等）需同步登记 readonly 裁剪名单（readonly.rs:19-34）与备份名单（backup.rs:42-44），防只读绕过与无快照写。

### 5.4 建议

1. **接线（本轮 P1 核心动作）**：
   - 在 session-loop 装配面（tool_exec.rs:670-687 的 ToolContext 构造处或壳层 SessionLoopOptions）注入 `Some(Arc<WritePathRegistry>)`（会话级，workspace_root 同源）与 `Some(ExploreDocsQuotaContext)`（由 run_subagent spawn 处理侧经 `quota_context_for_spawn`（explore_quota.rs:232-255）生成）；
   - 新增 `ExploreDocsQuotaStore` 的 session_meta 实现（crates/conex-db 或 session-loop 侧，读写 `get/set_session_meta`（sessions.rs:140-171），键编码复用 `session_meta_key_of`（explore_quota.rs:43-49）），实现重启后配额恢复（C5 验收 3，04-Agent功能需求设计.md:179）；
   - 壳层装配 `BackupMiddleware::with_defaults` 进 `tool_middleware`（loop/mod.rs:219 字段 + core_run_commands.rs 的 options 构建处），备份名单按需扩展（backup.rs:42-44）。
2. **产出目录**：主 agent 在 spawn run_subagent 的 prompt/注入段中携带产出目录（resolve_output_dir 的返回值），子代理 write_file 落到共享目录的不同文件（`NN-<标题>.md`，沿用 docs/multi-agent-repair 惯例）——目录级写路径声明（子代理 spawn 时声明产出目录为长期写路径，write_paths.rs:5-8 模块头的 M2 语义）天然实现"同目录不同文件不冲突、同文件互斥"；
3. **汇总索引（可选工具化）**：新增只读工具 `list_outputs`（列目录 + 按 `NN-` 前缀排序 + 每文件行数/字节），或复用 list_dir（fs.rs:299-402 已返回 items 数组）——主控 write_file 生成 README.md 即可；**最小方案：不新增工具，用 list_dir + write_file 组合**（需求验收"主控能汇总各子 Agent 产出路径"由 prompt 层 + wait_subagents 返回覆盖）；
4. **通知**：子代理完成时经 wait_subagents dispatch（已有持久化）携带产出文件路径，主控侧汇总——不引入新事件；
5. **配额语义与 G02 的关系**：C5 的"探索类每会话 1 份文档"与 REQ-G02 的"多个子 Agent 并行产出多份文档"是**两类子代理**（read-only 探索 vs 读写执行），不冲突；G02 场景的子代理若为非探索类则不受配额约束（explore_quota.rs:245-247 语义），配额仅约束探索类汇报场景——保持现状语义即可，不需要为 G02 调整配额。

### 5.5 wait_subagents 承载细节（子代理完成通知的现状证据）

`crates/agent-tools/src/tools/wait_subagents.rs`（I5-M8 / 04 C8 三模式等待）为"子 Agent 写入完成后通知主控"提供了现有承载面：

- **三模式**（wait_subagents.rs 模块头 + `WaitMode` 枚举）：`await-all`（等全部终态再规划）/ `timer`（固定窗后唤醒）/ `parallel-work`（立即返回并行工作）——G02 的"等所有子文档写完再汇总"对应 await-all；
- **事件驱动等待**：`wait_for_terminal_events` 原语（模块头注释），消费子代理终态事件（subagent-ended），**优先事件而非轮询**——G02"写入完成后通知主控"在 await-all 模式下由终态事件承载；
- **dispatch_* 持久化**：session_meta 键 `dispatch_mode` / `dispatch_wait_ms` / `dispatch_agents` / `dispatch_dispatched_at`（wait_subagents.rs 键常量区），重启后恢复"在等什么"；
- **timeout 硬上限 10 分钟**（`MAX_WAIT_TIMEOUT_MS = 600_000`）；
- **缺口**：终态事件/返回中**无"产出文件路径 + 内容摘要"的约定字段**（REQ-G02 要求"附带文件路径与内容摘要"）——子代理产出信息目前靠子代理最终消息（L1 注入带回，模块头注释）承载，未结构化。接线期需在子代理完成载荷或 dispatch 记录上明确产物字段（`outputFiles: [{path, summary}]`），这是 G02 验收"主控能汇总各子 Agent 文档产出路径"的引擎面落点。

### 5.6 提示词层纪律的现状证据（05 号文档）

`docs/multi-agent-repair/05-协同操作约束与安全.md` 第 7 节（195-200 行）把探索类文档配额固化为**协同执行红线**：

- "探索类 Agent（调研、分析、勘察类）**最多写一份文档**，且**必须由主 Agent 分配写作任务**才允许写"（05:197）；
- "未获分配的探索类 Agent **不得主动写第二份文档**"（05:198）；
- "探索结果默认以'汇报/汇总物'形式返回，只有主 Agent 明确指派时才落盘为文档"（05:199）；
- "文档落盘后受文件所有权纪律约束"（05:200，第 3 节）。

这说明：**提示词层的 G02 纪律已经完整成文并经过实战（多轮修复）检验**，缺的只是引擎强制（配额接线 + 写路径互斥接线）。落地时提示词层文案无需重写，只需在引擎接线后把"纪律被强制执行"的说明并入注入段（对齐 explore_quota.rs:213-221 的凭证段形态）。

### 5.7 验收映射（REQ-G02）

| 验收（REQ-agent-engine-capabilities.md:833-835） | 现状 | 落地后判定 |
| --- | --- | --- |
| 多个子 Agent 可并行向同一目录写入不同文件 | 目录写入无引擎限制（写路径互斥未接线）；提示词纪律存在（00-方案总览.md:48-61） | write_claims 接线 + 子代理目录级声明：同目录不同文件放行（write_paths.rs:459-469 兄弟文件测试语义）、同文件并发拒绝 |
| 不出现文件写入冲突 | 依赖提示词纪律；写路径互斥实现未接线（tool_exec.rs:683） | 接线后由 `tool.write_path_conflict` 结构化错误兜底（write_paths.rs:92-101 冲突文案含"谁占用/何时"） |
| 主控 Agent 能汇总各子 Agent 的文档产出路径 | 靠 wait_subagents 终态消息人工收集 | await-all 终态 + 产出文件字段结构化（5.5 缺口）+ 主控 list_dir/write_file 生成 README.md |

### 5.8 协作流程时序示例（落地后的目标形态）

以下时序图描述 G01+G02 接线完成后一次"多子代理协作文档产出"的完整流程（含工具调用与事件流）：

```
主控 Agent                                  引擎（session-loop）              子 Agent A / B
    │                                            │                              │
    │ 1. resolve_output_dir()                    │                              │
    │ ────────────────────────────────────────►  │ 读 session_meta 未命中        │
    │                                            │ 生成 .agent-outputs/<id>/     │
    │                                            │ 写 session_meta（惰性，不建目录）│
    │ ◄─────────────── 返回路径 + 注入段 ───────── │                              │
    │ 2. run_subagent(产出目录=…/A, prompt 含     │  spawn A（声明写路径 A）      │
    │    "01-kernel-analysis.md"，凭证含配额)     │ ──────────────────────────────►│
    │ 3. run_subagent(…/B, "02-frontend.md")     │  spawn B（声明写路径 B）      │
    │                                            │                               │
    │                                            │                               │ A: write_file(01-….md)
    │                                            │          write_claims 同目录不同文件不冲突 │
    │                                            │                               │ B: write_file(02-….md)
    │                                            │  A 完成 → 终态事件（含 outputFiles）│
    │ 4. wait_subagents(await-all)               │  B 完成 → 终态事件            │
    │ ◄──────── 全部终态 + 产出路径汇总 ────────── │                              │
    │ 5. list_dir(产出目录) → list_dir 返回清单   │                              │
    │ 6. write_file(README.md 汇总索引,          │                              │
    │    overwrite=true)                         │                              │
    │ 7. 向用户呈现：各子文档 + README.md         │                              │
```

关键点：第 2/3 步的目录级写路径声明（spawn 时声明，write_paths.rs 模块头 M2 语义）使 A/B 对同一目录的**不同**文件互不冲突（write_paths.rs:459-469 兄弟文件测试语义），若某子代理误写对方文件则收到 `tool.write_path_conflict`（write_paths.rs:92-101）——冲突从"事后发现"变为"事前拒绝"。配额场景（探索类子代理）在第 2/3 步经 `quota_context_for_spawn`（explore_quota.rs:232-255）装配，写第 2 份文档时被 `guard_explore_docs_write`（fs.rs:189）拒绝。

---

## 6. REQ-G03：文档工作区与代码工作区的路径隔离

### 6.1 现状证据

1. **用户显式路径不受限**：现状即"直接用"——`docs/feature-gap-analysis/`、`docs/multi-agent-repair/`、`docs/rust-rewrite/` 等文档目录都是用户/主控显式指定路径，write_file 接受任意工作区内绝对/相对路径（fs.rs:181-184），无文档目录白名单/黑名单概念——REQ-G03"用户显式指定直接用，不做限制"分支**天然满足**；
2. **系统默认自动工作目录不存在**：`.agent-outputs/` 零实现（见 4.1.1）——REQ-G03 的主体（"默认工作目录统一放 .agent-outputs/ 便于 gitignore 管理"）因 G01 缺失而整体缺失；
3. **`.gitignore` 无 `.agent-outputs` 条目**：现状 .gitignore（根目录）覆盖 node_modules/dist/target/logs/env/IDE/OS/临时脚本等，**无 agent 输出目录条目**；
4. **路径沙箱（安全面）**：Rust 工具侧 `resolve_workspace_path`（tools/mod.rs:171-226）强制工作区内（越界/`..`/symlink 解析后越界拒绝）；前端侧 `writeTextFile` 走 Tauri `workspaceRoot` 沙箱（workspaceFsApi.ts:175-185）——**路径隔离的安全约束已存在且强于需求要求**（需求只要求"默认目录不污染源码"，现状连用户显式路径也锁在工作区内）；
5. **可配置项**：无"默认文档产出根目录"配置概念——全局配置在壳层（settings/engine 配置，`apps/agent-workbench/src-tauri/src/` 的 engine.rs 等），未发现 outputRoot 类键。

### 6.2 判定

REQ-G03（P2）的"显式路径直接用"与"路径安全"现状已满足甚至超出；**缺失部分全部由 G01 缺失派生**（默认输出根 + gitignore 条目 + 可配置项）。单独看 G03，需要做的是"约定 + 配置 + gitignore"，工程量小。

### 6.3 差距清单

1. **G-G03-1**：默认产出根 `.agent-outputs/` 概念缺失（依赖 G01）；
2. **G-G03-2**：`.gitignore` 无 `.agent-outputs/` 条目；
3. **G-G03-3**：无"自定义默认文档产出根"配置项（REQ-G03 验收"用户可自定义"）；
4. **G-G03-4（文档）**：无目录约定文档（docs/ 或 AGENTS.md 无 .agent-outputs 说明）。

### 6.4 建议

1. **约定**：G01 落地时默认根取 `<workspace_root>/.agent-outputs/`（REQ-G01 建议形态），会话子目录 `<conversation-id>/`；`.gitignore` 增加一行 `.agent-outputs/`（与现有 `.crish-trash` 等运行期目录并列）；
2. **配置**：在会话级（session_meta `"{session_id}:output_root"`，可配覆盖）与壳层全局设置（engine 配置新增 `agentOutputsRoot` 键）两级提供——会话级满足"对话内改产出根"，全局级满足 REQ-G03"用户可自定义默认根"；
3. **校验**：产出根必须仍在 workspace_root 内（复用 resolve_workspace_path 的包含性检查，tools/mod.rs:352-360 `path_within_root`），防止配置把产出目录指到工作区外；
4. **清理**：会话删除时 `.agent-outputs/<id>` 走 trash 删除接管（conex-fs/trash.rs，I2-S3），不直接 remove——符合项目删除铁律（trash.rs:26-29）；
5. **文档**：AGENTS.md 或 docs/ 补充"AI 文档产出目录约定"一节（显式指定 vs 默认 .agent-outputs/ 的决策规则），使提示词层与引擎层口径一致。

### 6.5 配置项设计草案（G03 验收"用户可自定义"的落点）

| 配置项 | 层级 | 键/形态 | 默认值 | 生效时机 |
| --- | --- | --- | --- | --- |
| 默认产出根目录 | 会话级 | session_meta `"{session_id}:output_root"` | `.agent-outputs`（相对 workspace_root） | resolve_output_dir 下次调用时 |
| 默认产出根目录 | 全局 | 壳层设置 `agentOutputsRoot`（对齐现有 engine 配置键形态，`apps/agent-workbench/src-tauri/src/engine.rs` 类配置面） | `.agent-outputs` | 会话创建时注入默认 |
| 产出根是否允许工作区外 | 全局 | `allowOutputsOutsideWorkspace` | `false` | resolve_output_dir 校验时（安全红线，不放开） |
| 产出目录命名 | 会话级 | 固定 `<conversation-id>/`（G01 建议形态）或 `<日期>-<标题>`（需标题溯源链路，见 4.3 G-G01-5） | `<conversation-id>/` | 首次 resolve_output_dir |

优先级设计：会话级 > 全局级 > 默认值。校验规则统一为"产出根必须在 workspace_root 内"（复用 `path_within_root`，tools/mod.rs:352-360），`allowOutputsOutsideWorkspace=false` 为不可覆盖的安全默认。

---

## 7. 模块总结

### 7.1 EG 模块整体判定表

| 需求 | 优先级 | 现状 | 判定 | 真 gap 数 | 依赖 |
| --- | :---: | --- | --- | :---: | --- |
| REQ-E01 | P0 | 无工具（legacy 仅测试占位）；写路径互斥/备份/幂等设施在 agent-tools 已实现但未接线 | **全新实现** | 6 | 依赖 E01-接线面（互斥/备份/中间件装配） |
| REQ-E02 | P0 | write_file 自动建父目录 ✓；无条件覆盖 ✗ | **小改造** | 3 | 无 |
| REQ-E03 | P0 | 机制面依赖 E01；提示词面空白 | **依附实现** | 3 | 依赖 E01 + 注入段 |
| REQ-G01 | P1 | 零实现；session_meta/ensure_parent_dir/注入段可复用 | **全新实现** | 5 | 无 |
| REQ-G02 | P1 | 配额/互斥/等待机制已实现未接线；docs/multi-agent-repair 是成熟实践 | **接线 + 流程固化** | 6 | 依赖 G01（产出目录） |
| REQ-G03 | P2 | 显式路径直接用 ✓；安全沙箱 ✓；默认根/配置/gitignore 缺失 | **小改造** | 4 | 依赖 G01 |

### 7.2 真 gap 清单（按模块汇总）

**模块 E（P0，建议与 Phase 1 合并落地）**：
1. G-E01-1 工具本体缺失（multi_replace_file_content 全新设计，非恢复）；
2. G-E01-2 原子写路径缺失（内存完成 → 一次写盘；临时文件 + rename）；
3. G-E01-3 备份名单未覆盖新工具（backup.rs:42-44 扩展）；
4. G-E01-4 中间件链未装配（loop/mod.rs:219 空 Vec；壳层装配 BackupMiddleware）；
5. G-E01-5 EOL 归一化缺失（移植 applyFileDiff.ts:287-297）；
6. G-E01-6 无单块替换工具（chunks=1 复用同一工具，规避）；
7. G-E02-1/2/3 write_file 无 Overwrite 默认拒绝覆盖语义（schema + 存在性检查 + 调用面兼容）；
8. G-E03-1/2/3 注释保留机制依附 E01 + 注入段约束缺失。

**模块 G（P1/P2，建议 Phase 2 落地）**：
9. G-G01-1/2/3/4 默认工作目录机制整体缺失（解析/持久化/通知/惰性策略）；
10. G-G02-1/2 write_claims 与 explore_docs_quota 未装配（tool_exec.rs:683-686 全 None）+ 无 session_meta store 实现；
11. G-G02-3 共享产出目录无工具/注入面（依赖 G01）；
12. G-G02-4 汇总索引靠手工（最小方案 list_dir + write_file，可不新增工具）；
13. G-G02-5 子代理完成通知的摘要字段语义未定（wait_subagents 承载，接线期细化）；
14. G-G02-6 新工具需同步登记 readonly/backup 名单；
15. G-G03-1/2/3/4 默认根约定 + gitignore + 可配置项 + 文档。

### 7.3 优先级建议

1. **P0 第一梯队（Phase 1 内）**：
   - E02（write_file Overwrite 语义）——独立小改造，不依赖其他项，先行落地可立即消除"意外覆盖"风险；
   - E01（multi_replace 工具本体 + 原子写 + 备份名单）——注意：**E01 的原子性验收在单进程内即可满足**，写路径互斥/中间件装配可作为同批或次批接线；建议先落工具 + 单元测试（对齐 write_paths.rs 的并发测试模式 write_paths.rs:561-582），再接线互斥；
   - E03 注入段——随 E01 的 schema/测试落地，成本近零。
2. **P1 第二梯队（Phase 2 内）**：
   - G01（resolve_output_dir + session_meta 持久化 + 注入段）——G02/G03 的共同前置；
   - G02 接线（write_claims / quota store / BackupMiddleware 装配）——与 G01 并行：装配动作在 session-loop 同一处（tool_exec.rs:670-687 附近），一次接线服务多个需求；
   - 流程固化（文件名分配/汇总索引约定写进 AGENTS.md 或 docs 手册）。
3. **P2 第三梯队**：G03 配置项 + gitignore + 清理策略（随 G01 顺带完成，不单独排期）。

### 7.4 交叉依赖与风险提示

- **E01 与 G02 共用接线面**：写路径互斥（tool_exec.rs:683）与中间件链（loop/mod.rs:219）是 E01 原子性、G02 并发防冲突的共同前提——建议统一在 session-loop 装配层一次完成，避免两轮改动同一处；
- **只读裁剪的维护性风险**：readonly.rs:19-34 的白名单是静态数组，未来每新增一个写类工具（E01）都必须手动登记，否则只读子代理可绕过——建议把 WRITE_TOOL_NAMES 的登记与工具注册（tools/mod.rs:86-113）做成同一处声明（工具定义上标记 write_class），列为结构改进项；
- **E02 行为变更的兼容面**：write_file 默认拒绝覆盖会改变现有调用语义（前端 applyFileDiff full_write、现有测试），需显式传 overwrite: true；建议与壳层 Tauri `write_file_content` 命令（workspaceFsApi.ts:175-185 对应命令）对齐语义，避免"工具拒绝、命令允许"的口径分裂；
- **历史备注纠偏**：REQ-E01"曾存在、重构遗失"不成立（1.1.2 证据），任务书中相关表述应以本文档为准。

### 7.5 与相邻模块（F / D）的边界说明

为便于后续分模块任务书编写，明确 EG 与相邻模块的边界：

| 相邻模块 | 边界 | 说明 |
| --- | --- | --- |
| F01（grep 搜索）/ F03（目录列举） | 已实现，不在 EG 范围 | `grep_search` / `fuzzy_find` / `list_dir` / `file_stat` 已在 12 工具注册表（tools/mod.rs:86-113）；EG 落地不得重复实现 |
| F02（防截断读取） | 部分相关，不在 EG 范围 | read_file 现状是**字符级**截断（fs.rs:93-127），无行号范围参数、无 ContentOffset 续读——这是 F02 的差距，与 E01 无耦合；但 E01 的"行号范围"参数语义与 F02 的 StartLine/EndLine 建议保持一致（同为 1-indexed 闭区间） |
| D01/D02（子 Agent 派发/工作区隔离） | G02 的依赖面 | 产出目录经 run_subagent prompt 下发（D01 通道）；目录级写路径声明（write_paths.rs 模块头 M2 语义）是 D02 与 G02 的接口点 |
| D06（全局事件总线） | G02 的可选承载 | REQ-G02 的"事件总线或消息通知"——现状用 wait_subagents 终态事件 + L1 注入（wait_subagents.rs 模块头）即可满足，**不阻塞于 D06** |
| D05（DAG 调度引擎） | 不相关 | 文档协作不需要依赖图调度 |
| E01 与 F02 的参数一致性 | 设计约束 | 两者都用"行号 + 内容"寻址，schema 注释建议互相引用，避免 AI 混淆 |

### 7.6 本文档的使用方式（对下游任务书的指引）

- **E01 任务书**：以 1.7（schema 草案）+ 1.8（伪代码）+ 1.9（测试映射）为验收骨架；接线动作（互斥/备份/中间件装配）单列子任务；
- **E02 任务书**：以 2.4 + 2.5（兼容矩阵）为骨架，**先做**（无依赖，且行为变更需尽早暴露测试影响）；
- **G01/G02 任务书**：以 4.4-4.6 + 5.4-5.7 为骨架；两章共用"session-loop 装配面"（tool_exec.rs:670-687 一处接线），建议合并为一个 Agent 执行或明确文件域互斥；
- **G03 任务书**：随 G01 顺带完成（默认根 + gitignore + 配置），不建议独立成任务。

---

## 8. 调查过程记录（可复核检索命令与结论）

本节记录本次调查执行过的检索命令与其结论，便于复核与后续增量调查（若代码已演进，以本节命令重新执行即可校验本文档结论是否过期）。

### 8.1 git 历史检索（multi_replace 是否存在过）

| 命令 | 结论 |
| --- | --- |
| `git log --all --oneline -S "multi_replace"` | 命中提交：b665f51a（docs 提及）/ 967e7846（legacy 删除）/ c973f53d、d9e5b61e、6d4e64e8、111c984a、d2973385（多为删除或文档提交的连带命中） |
| `git log --all --oneline -S "replacement_chunks"` | **零命中** |
| `git log --all --oneline -S "replace_file_content"` | **零命中** |
| `git show 967e7846 -G "multi_replace" --name-only` | 命中唯一文件：`packages/agent-daemon/src/__tests__/agent-real-workflow-e2e.test.ts`（测试） |
| `git grep -n "multi_replace" 967e7846^ -- "*.ts"` | **仅 e2e 测试 1 处**（:125/:140/:141/:143/:150）——无任何实现文件 |
| `git ls-tree -r 967e7846^ --name-only | rg -i "replace\|patch"` | 仅 `packages/agent-tools/src/git-versioning/git-patch-ops.ts`（git checkpoint 解析，非内容替换） |
| `git log --all --oneline -- "*replace*"` | 无历史提交按文件名命中 replace 工具源文件 |

**结论**：`multi_replace_file_content` 在 legacy 时代只有 e2e 测试占位（审批流 mock，实际 writeFile 模拟），**从未有正式实现**；需求备注"AI 重构时遗失"不成立，实为"规划未实现"。

### 8.2 现状代码检索

| 检索项 | 结果 |
| --- | --- |
| `rg "agent-outputs\|agent_outputs\|outputs_dir\|session_dir\|output_dir" crates apps packages` | **零命中**（需求文档外）——G01 零实现 |
| `rg "write_claims\|WritePathRegistry" crates apps --glob "*.rs"` | 命中仅 agent-tools 内部 + tool_exec.rs 的 None 赋值——**无装配者** |
| `rg "explore_docs_quota\|ExploreDocsQuotaStore" crates apps --glob "*.rs"` | 同上——**无装配者** |
| `rg "tool_middleware\|BackupMiddleware\|middleware" apps/agent-workbench/src-tauri/src` | **零命中**——壳层未装配中间件链 |
| `rg "session_meta" crates/conex-db/src/schema.rs` | schema.rs:87 全局 KV 表（无会话列，键编码隔离） |
| 工具注册断言（tests） | tools/mod.rs:461-490：12 个工具，无 replace 类 |

### 8.3 关键事实复核清单（本文档结论的证伪条件）

| 结论 | 若代码演进，证伪信号 |
| --- | --- |
| E01 无工具 | 注册断言（tools/mod.rs:461-490）出现 replace 类工具名 |
| write_file 无 Overwrite | fs.rs:145-158 schema 出现 overwrite 字段 |
| write_claims 未接线 | tool_exec.rs:683 出现 `Some(Arc<WritePathRegistry>)` |
| 中间件未装配 | loop/mod.rs:219 或壳层 options 出现 BackupMiddleware |
| G01 零实现 | 出现 `.agent-outputs` 相关代码或 resolve_output_dir 工具 |
| 配额未接线 | 出现 ExploreDocsQuotaStore 的 session_meta 实现者 |

---

## 9. 实施顺序细化与工作量评估

### 9.1 建议落地顺序（与需求路线图对齐）

```
Phase 1（P0，模块 E 全部）：
  Step 1: REQ-E02 write_file Overwrite 语义（独立、无依赖，先行）
          ├── fs.rs schema + execute 存在性检查
          ├── 既有测试补 overwrite: true；新增"默认拒绝覆盖"用例
          └── 壳层 write_file_content 命令语义对齐（可选，防口径分裂）
  Step 2: REQ-E01 multi_replace 工具本体（单元测试闭环，暂不依赖接线）
          ├── tools/replace.rs（schema + 匹配 + 回滚 + 原子写）
          ├── readonly.rs:19-24 登记 WRITE_TOOL_NAMES
          └── 测试：回滚/多块/重叠/allow_multiple/EOL（1.9 表）
  Step 3: REQ-E03 注入段（subagent_inject.rs 新增固定段 + 快照测试）
          └── 与 E01 验收共用测试用例（注释保留断言）
  Step 4: E 模块接线（写路径互斥 + 备份中间件 + 幂等验证）
          ├── session-loop 装配 WritePathRegistry（tool_exec.rs:683 处）
          ├── 壳层装配 BackupMiddleware（backup.rs:70-72）
          └── 集成测试：并发冲突 / 快照恢复 / 幂等去重

Phase 2（P1，模块 G）：
  Step 5: REQ-G01 resolve_output_dir 工具 + OutputWorkspace 服务
          ├── tools/output_dir.rs + ToolContext 新字段（None=未接线）
          ├── session_meta 持久化（键编码复用 explore_quota.rs:43-49）
          └── subagent_inject.rs 产出目录注入段
  Step 6: REQ-G02 接线与流程固化
          ├── ExploreDocsQuotaStore session_meta 实现 + quota_context_for_spawn 装配
          ├── wait_subagents 终态产出字段（outputFiles）结构化
          ├── AGENTS.md / docs 手册补充"产出目录 + 文件名分配"约定
          └── 验收：两子代理并行写共享目录不同文件 + 冲突用例

Phase 3（P2）：
  Step 7: REQ-G03 默认根配置 + .gitignore 条目 + 会话清理走 trash
```

### 9.2 工作量粗估（相对值，以现有同类模块为基准）

| 步骤 | 规模 | 基准参照 |
| --- | --- | --- |
| E02 Overwrite 语义 | 小（~0.5 人日） | write_file 现有实现 fs.rs:132-219 + 测试面 20 用例 |
| E01 工具本体 | 中（~2-3 人日） | 参考 write_file + write_paths 的既有模式；匹配/回滚逻辑是核心新代码 |
| E01 接线 | 中（~1-2 人日） | 装配点集中在 tool_exec.rs:670-687 + 壳层 options |
| E03 注入段 | 小（~0.5 人日） | 对齐 explore_quota.rs:213-221 的凭证段先例 |
| G01 输出目录 | 中（~2 人日） | 新服务 + 工具 + 注入段 + session_meta 接线 |
| G02 接线与流程 | 中（~2-3 人日） | 配额 store 实现 + 装配 + wait_subagents 字段扩展 + 文档 |
| G03 配置与清理 | 小（~0.5-1 人日） | gitignore/配置键/清理钩子 |

合计约 **8-12 人日**（不含测试基建），与需求路线图"Phase 1 模块 E 约 2-3 周、Phase 2 模块 G 约 3-4 周"的窗口匹配（并行子 Agent 可压缩日历时间）。

### 9.3 风险与开放问题

1. **write_file 默认拒绝覆盖的行为变更**是唯一影响现有调用面的改动（2.5 矩阵），建议排在 Phase 1 首位并全量跑测试后再动 E01；
2. **E01 的 chunk 区间重叠语义**（拒绝 vs 从后往前应用）需在任务书中定稿——推荐"校验期拒绝"，语义最直观、测试最稳定；
3. **wait_subagents 产出字段的向后兼容**：dispatch_* 持久化 JSON 增加字段需旧数据兼容（对齐 explore_quota 的 parse 容错模式 explore_quota.rs:70-88）；
4. **readonly 名单维护模式**（7.4 已述）：建议结构改进——工具定义上声明 write_class，让裁剪名单随注册自动派生，避免每次新增写工具手动登记（本次范围外，列改进项）；
5. **G01 与配额语义的交汇**：read-only 子代理调用 resolve_output_dir 的决策（拒绝/仅主控指定）需在 C5 语境统一，避免探索类代理借输出目录工具绕过配额检查（guard 需覆盖新工具，同 E01 第 3 步）。

### 9.4 验收命令清单（供门禁复用）

| 阶段 | 命令 | 断言 |
| --- | --- | --- |
| E 模块单元 | `cargo test -p agent-tools` | replace 回滚/多块/重叠/allow_multiple/EOL 用例 + write_file Overwrite 用例全绿（现有 73 套件基线不回归） |
| E 模块集成 | `cargo test -p session-loop` | 并发冲突（write_paths.rs:561-582 模式）、快照恢复（backup.rs:379-401 模式）、幂等去重（executor.rs:277-299 模式） |
| 前端回归 | `npm run typecheck` + `npx vitest run src` | 基线失败集不变（oklchColorGuard / userFacingErrors / sessionRustDbWriteModel / DiffCard.perf），不新增失败 |
| G 模块 | `cargo test -p session-loop -p conex-db` | 配额持久化（重启恢复）、输出目录 session_meta 往返、并发双子代理写不同文件放行/同文件拒绝 |
| 全量 | `cargo test --workspace` | 73 套件基线（E/G 新增套件为增量） |

---

## 附录 A — 关键证据索引（文件:行号）

| 证据点 | 位置 |
| --- | --- |
| write_file 无条件覆盖写（无 Overwrite 语义） | crates/agent-tools/src/tools/fs.rs:199 |
| write_file 自动建父目录 | crates/agent-tools/src/tools/fs.rs:197；crates/conex-fs/src/lib.rs:84-95 |
| write_file schema（无 overwrite 字段） | crates/agent-tools/src/tools/fs.rs:145-158 |
| read_file 字节预算（256000）与截断标记（F02 现状） | crates/agent-tools/src/tools/fs.rs:17-18, 93-127 |
| 12 工具注册清单（无 replace 类） | crates/agent-tools/src/tools/mod.rs:86-113, 461-490 |
| diff_text 复用 DiffEngine（无 apply 方向） | crates/agent-tools/src/tools/diff.rs:87, 121-142 |
| 写路径互斥：多路径原子声明 | crates/agent-tools/src/write_paths.rs:172-223 |
| 写路径互斥：工具接线助手（未接线则 None） | crates/agent-tools/src/write_paths.rs:303-318 |
| 备份中间件默认名单仅 write_file | crates/agent-tools/src/backup.rs:42-44 |
| 备份快照/恢复闭环 | crates/agent-tools/src/backup.rs:134-151, 379-401 |
| 幂等执行键（工具名@tag / 参数hash） | crates/agent-tools/src/idempotency.rs:291-300；executor.rs:72-131 |
| 探索配额：检查/凭证/装配 | crates/agent-tools/src/explore_quota.rs:192-221, 232-255 |
| 探索配额：工具接线 | crates/agent-tools/src/tools/fs.rs:189, 203 |
| 只读工具裁剪名单 | crates/agent-tools/src/readonly.rs:19-34 |
| 主执行器未接线（write_claims/explore_docs_quota = None） | crates/session-loop/src/tool_exec.rs:670-687 |
| 中间件链默认空 | crates/session-loop/src/loop/mod.rs:219 |
| session_meta 全局 KV 表 | crates/conex-db/src/schema.rs:87 |
| session_meta 读写接口 | crates/conex-db/src/sessions.rs:140-171 |
| 会话键编码先例 | crates/agent-tools/src/explore_quota.rs:43-49 |
| 前端 search_replace 参考实现（六态判定） | apps/crish-desktop/src/api/applyFileDiff.ts:316-376 |
| 前端 EOL 归一化参考 | apps/crish-desktop/src/api/applyFileDiff.ts:287-297 |
| 前端写文件沙箱 | apps/crish-desktop/src/api/workspaceFsApi.ts:175-185 |
| legacy multi_replace e2e 占位 | 967e7846^:packages/agent-daemon/src/__tests__/agent-real-workflow-e2e.test.ts:121-160 |
| 测试映射文档提及 multi_replace | docs/rust-rewrite/05-test-mapping.md:235（b665f51a 快照） |
| 现实协作产出模式（00 总览 + NN 编号文档） | docs/multi-agent-repair/README.md:7-14 |
| 文件域互斥纪律（提示词层） | docs/multi-agent-repair/00-方案总览.md:48-61 |
| C5 配额设计 | docs/multi-agent-repair/04-Agent功能需求设计.md:156-181 |
| 导入插件产出形态（SessionImportPayload，非文档） | packages/plugin-import-claude-codex/README.md:9-13 |
| 路径安全校验 | crates/agent-tools/src/tools/mod.rs:171-226, 352-360 |
| wait_subagents 三模式与 dispatch_* 持久化 | crates/agent-tools/src/tools/wait_subagents.rs（WaitMode / 键常量区） |
| 探索配额红线（提示词层） | docs/multi-agent-repair/05-协同操作约束与安全.md:195-200 |

---

*本文档基于只读代码取证与 git 历史检索撰写；所有「未接线/未装配」结论以检索时刻（2026-08-04）的代码状态为准。*
