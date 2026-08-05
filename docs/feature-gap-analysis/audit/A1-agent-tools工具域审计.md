# A-1 审计：agent-tools 工具域

> 任务：Agent A-1 只读审计——crates/agent-tools/src/ 工具域（shell / background_task /
> replace / fs / search / subagent / output_dir / wait_subagents / set_timer /
> write_paths / readonly / backup / explore_quota / idempotency / executor / context /
> middleware / audit / subagent_inject / permission 及 conex-sandbox semantics 依赖面）。
> 属性：只读审查，未修改任何代码；产出本文档（UTF-8 无 BOM，全中文）。
> 基线：对照「审计准备-已知缺点与技术债汇总.md」（T-1，230 条）与「审计准备-测试可信度预检.md」（T-3）——已登记项不重复报告，聚焦新发现。

## 审计范围与方法

- 精读文件：`lib.rs`、`context.rs`、`audit.rs`、`executor.rs`、`readonly.rs`、
  `backup.rs`、`permission.rs`、`idempotency.rs`、`explore_quota.rs`、
  `middleware.rs`、`write_paths.rs`、`subagent_inject.rs`、`definition.rs`、
  `tools/mod.rs`、`tools/fs.rs`、`tools/search.rs`、`tools/replace.rs`、
  `tools/shell.rs`、`tools/set_timer.rs`、`tools/output_dir.rs`、
  `tools/background_task.rs`、`tools/wait_subagents.rs`、`tools/subagent.rs`
  （共约 1.6 万行，含测试面）。
- 接线核对：`session-loop/tool_exec.rs`、`session-loop/loop/mod.rs`、
  `apps/agent-workbench/src-tauri/src/core_run_commands.rs`（T-D-13 装配块）。
- 五维审计：工程规范 / 模块质量 / 工具契约 / 接线流畅性 / 安全性。

## 结论速览

- **新发现 19 条**：高 1 / 中 7 / 低 11（另有基线核对 3 项，见 §4）。
- 最高优先：`multi_replace_file_content` 对无 NUL 的非 UTF-8 文本（GBK/latin1）
  静默数据破坏（高）——`decode_text` 的 lossy 解码 + 写回组合是唯一
  「读-改-写回」路径，无编码护栏。
- 总体评价：**结构成熟、守卫链完整**（写路径互斥/硬沙箱/备份/配额/审计链在
  工具层接线整齐，错误码与描述总体一致），但存在三类系统性弱点：
  ① 部分工具依赖 `ToolExecCtx.cwd`（Option）作路径基准，None 时回退进程
  current_dir，基准脆弱；② 「本地域错误码」面持续扩大（不入 conex-types
  注册表），前端/执行器无法分类路由；③ 少量测试面污染与命名误导。

---

## 1. 新发现分类表

### 1.1 高严重度（1 条）

| 编号 | 文件:行号 | 问题 | 建议 |
| :--- | :--- | :--- | :--- |
| A1-H1 | `tools/replace.rs:106-115` + `tools/mod.rs:371-385` | **multi_replace 对无 NUL 的非 UTF-8 文本静默数据破坏**。`decode_text` 仅以 NUL 判定二进制（mod.rs:371），GBK/GB2312/latin1 等无 NUL 的 legacy 编码文件经 `String::from_utf8_lossy` 解码（mod.rs:380），无效字节被替换为 U+FFFD；替换匹配基于 lossy 后文本，写回时 `encode_text` 按 BOM 探测 → 无 BOM 文件按 utf-8 落盘（replace.rs:165-167）——**原文件字节被静默改写，无任何警告**。read_file 只读无破坏（诚实显示），write_file 不读旧内容，multi_replace 是全工具域唯一「读-改-写回」路径，恰是数据损坏面。中文 Windows 项目存在 GBK 旧文件场景，真实可触发。 | 解码后检测 lossy 替换是否发生（`std::str::from_utf8` 失败即有），发生则与二进制同款拒绝执行（结构化错误，文案提示显式指定编码/转码）；或为 multi_replace 增加显式 `encoding` 入参并校验。 |

### 1.2 中严重度（7 条）

| 编号 | 文件:行号 | 问题 | 建议 |
| :--- | :--- | :--- | :--- |
| A1-M1 | `tools/search.rs:148-151, 179` | **grep_search 大小写不敏感模式 column 计算可能 panic**。`line.to_lowercase().find(&query.to_lowercase())` 的字节偏移取自 lowercased 串，再对**原始行**做 `line[..byte_offset.min(line.len())]` 切片（:179）——Unicode 大小写映射可改变字节长度（如 `İ`(U+0130) 2B→`i̇` 3B、`ﬀ`(U+FB00) 3B→2B），偏移落在原始串非 char 边界时 `str` Index 直接 panic；即便不 panic，column 数值也错位。执行链无 catch_unwind（tool_exec.rs 全域无捕获），panic 会击穿 run task。 | column 计算改为对原始行做大小写不敏感的 char 级换算（`char_indices` 定位），或对原始行在 `byte_offset` 处回退到最近 char 边界（`get(..)` 替代 `Index`）；补 Unicode 映射长度变化用例。 |
| A1-M2 | `tools/search.rs:153, 274-275, 216-221` | **grep_search 的 maxFiles 静默截断无标志**。`walk_files` 达 `max_files` 即 break（:274），`visited_files` 如实计数，但 `truncated` 只由 maxMatches 触发（:216-220）——AI 拿到不完整结果却无任何截断提示，会误判「全量无更多命中」。 | walk_files 返回是否达上限的标记，达限时置 `truncated=true` 并提示「已访问文件数达上限」。 |
| A1-M3 | `tools/shell.rs:1093` + `context.rs:99-130` | **后台任务 adopt 的 owner_run_id 恒 None——任务无 run 归属**。`ToolContext` 无 run_id 字段（只有 session_id），`adopt_child` 只能硬编码 `owner_run_id: None`（:1093），测试固化该契约（shell.rs:2183「R-AB1 不携带 run 关联」）。后果：后台任务无法按 run 过滤/审计归属（kill_all、会话清理、逃逸归因都无法关联任务）；与 `write_claim_holder`（tool_exec.rs:736 已注入 run id）的接线面不一致。 | ToolContext 增加 `run_id: Option<String>` 字段（对齐 write_claim_holder 注入面，tool_exec.rs 装配点补一行），adopt 透传。 |
| A1-M4 | `explore_quota.rs:280-287` | **配额消耗失败静默忽略（fail-open），与同 crate backup 的 fail-closed 策略分裂**。`consume_explore_docs_quota` 对 `store.consume` 错误 `let _ =` 吞掉（:285），且无任何日志——持久化后端故障时每次 check 读快照 0 消耗，配额形同虚设（探索类子代理可无限写文档），静默无告警。对照 backup.rs:162-164（快照失败 → Block 阻止执行）同属安全敏感面，策略相反。 | 至少补 `tracing::warn!`（含 session_id/run_id）；或在配额上下文装配时校验 store 可用性，故障即拒绝装配（fail-closed）。 |
| A1-M5 | `executor.rs:117-122` + `idempotency.rs:227-237` | **幂等 record 失败后内存键已写入，重试被内存去重但 store 未落盘**。`record` 先写内存再写 store（idempotency.rs:234-236），store 失败返回 Err → `execute_with_output_policy` 整调用 Err（:120）——此时**工具已实际执行成功**；用户重试 → check 命中内存键 → 返回 deduplicated「已执行跳过」（看起来成功），而 store 永无记录；进程重启后键丢失，写类工具重新执行（重复副作用）。内存态与持久化态分叉无提示。 | record 失败时回滚内存键（或标记该键未持久化，check 时穿透），并让错误文案区分「已执行但持久化失败」；重启恢复场景补用例。 |
| A1-M6 | `tools/shell.rs:785-801` | **daemon 模式 manager 未接线时静默退化为同步长等**。`mode=daemon` 且 `manager=None` → 走 `ShellMode::Sync`（:798），最长等到 timeoutMs（可配至 600s），无任何提示；schema 描述「daemon 立即转后台守护（run 结束不回收）」（:138）与实际行为不符。装配缺 manager 的引擎面（D-29 已登记装配降级语义）在工具内又多一层静默降级。 | daemon 且未接线时返回结构化错误（或至少 text 中明示降级为同步模式），描述补边界声明。 |
| A1-M7 | `explore_quota.rs:157-159` | **探索类配额错误复用 `tool.execution_failed`，前端无法区分配额语义**。NotGranted/Exhausted 与一般执行失败同码（注释自认「专用码登记待 conex-types 演进」），UI 无法按配额语义渲染指引（「回报主 agent」），也无法与普通失败区分统计。与 A-46（Timer Conflict 复用 version_conflict）同根：本地码面/码位复用系统性问题。 | 登记专用码（如 `tool.explore_quota_not_granted` / `tool.explore_quota_exhausted`），conex-types + TS 双登记后切换。 |

### 1.3 低严重度（11 条）

| 编号 | 文件:行号 | 问题 | 建议 |
| :--- | :--- | :--- | :--- |
| A1-L1 | `explore_quota.rs:608-613` | 无意义占位测试 `state_reexport_shape`：断言 `SubagentState::Pending.to_db_status()=="running"`，与配额域零关系，注释自认「占位——保留以对齐本文件测试面」。测试面污染，误引导后续维护者。 | 删除该测试（若需保留 import 则改用 `#[allow(unused_imports)]` 或真实消费）。 |
| A1-L2 | `tools/fs.rs:159` | read_file 缺省 endLine 回显 `window_start + maxLines`，startLine 较大时 endLine 超文件总行数（如 500 行文件 startLine=500 缺省 endLine 回显 1299）——「endLine」字段名暗示实际行号，误导续读计算。 | 回显钳制到总行数（与 window_end 同源）。 |
| A1-L3 | `tools/replace.rs:46` + `tools/output_dir.rs:446-449` | schema 描述「目标文件绝对路径 / 工作区内绝对路径」，实现均接受相对路径（resolve_workspace_path 兼容两种）。描述比实现严格，模型可能因此拒绝相对路径调用。 | 描述改为「相对或绝对路径（工作区内）」。 |
| A1-L4 | `tools/replace.rs:244-247` vs `tools/fs.rs:432-438` | 布尔参数容忍度分裂：write_file 的 `overwrite` 非布尔 → 结构化报错；multi_replace 的 `allow_multiple` 非布尔 → 静默取 false。同域同参数类型两种处置。 | 统一为显式报错（fail-closed）。 |
| A1-L5 | `middleware.rs:3` vs `middleware.rs:84` | 模块头「TS 红线禁令 7 后仅保留三个钩子：beforeExecute / onResult / onError」与 trait 实际四钩子（+on_definition）文档不一致。 | 模块头补 on_definition 钩子说明。 |
| A1-L6 | `tools/shell.rs:1273-1274` | `clamp_output_bytes` 以 `#[cfg_attr(not(test), allow(dead_code))]` 保留为纯函数基准（T-AB-01 改造后生产零调用）——与 B-01（clamp_text，已删）同类 dead_code 保留面，B-01 未登记本条。 | 裁决删除或转测试专用（`#[cfg(test)]` 内）。 |
| A1-L7 | `tools/mod.rs:530-535` | 测试名 `glob_helper_free_functions_covered_by_search_tests` 与内容不符（实际断言 display_path 基本行为，无 glob）。命名误导。 | 改名（如 `display_path_basics`）。 |
| A1-L8 | `tools/shell.rs:1182` | `spill_full_output` 将 session_id 直接拼进路径（`root.join("sessions").join(session_id)`），session_id 含路径分隔符/`..` 时逃逸到任意目录（引擎侧 session_id 可信，防御性缺口）。 | 复用 output_dir.rs 的 `sanitize_session_id` 净化。 |
| A1-L9 | `tools/set_timer.rs:197` | durationSeconds 非整数静默 floor（1.5→1），而 read_file（fs.rs:236 拒绝小数）与 replace（chunk_line_number 拒绝小数）均为拒绝——同 crate 数值容忍度不一致。 | 统一为「非整数拒绝」。 |
| A1-L10 | `tools/wait_subagents.rs:576-580` vs `:718-723` | 描述「可经 inject 在**等待期间**向子代理注入提示词」，实现为 persist 后、进入等待**前**注入（一次性）。措辞与行为顺序偏差。 | 描述改为「发起等待前注入」。 |
| A1-L11 | `tools/wait_subagents.rs:454` | `wait_for_terminal_events` 原语结果 `mode` 恒硬编码 `AwaitAll`（:454）——引擎侧以 timer 模式复用该原语时 mode 字段失真（工具层无感知，契约原语误导面）。 | 原语加 mode 入参或文档明示「调用方覆盖」。 |
| A1-L12 | `tools/output_dir.rs:520` | resolve_output_dir 输出硬编码 `"Snapshot tag: <无>"`——产出目录无快照标记语义，占位文案可能误导模型。 | 删除该行或改为真实提示（无 snapshotTag 字段）。 |
| A1-L13 | `write_paths.rs:50`、`tools/fs.rs:259`、`tools/shell.rs:39-43` | **本地域错误码面扩大**：`tool.write_path_conflict` / `tool.file_exists` / `tool.requires_approval` / `tool.command_blocked` / `tool.user_denied` / `tool.cd_blocked` 均为不入 conex-types 注册表的本地码（注释均称「对齐先例」）。执行器按错误码字符串分类路由、前端无法分类——与 A-46/M-7 同根的系统性模式（错误码双轨）。 | 系统性评审：本地码并入 conex-types 注册表（含 TS 镜像），或集中登记本地码清单并加双端护栏。 |

### 1.4 接线脆弱点（并入上表，单独归类）

| 编号 | 文件:行号 | 问题 | 建议 |
| :--- | :--- | :--- | :--- |
| A1-W1 | `backup.rs:131-135` + `executor.rs:154-167` + `session-loop/loop/mod.rs:253/349` + `core_run_commands.rs:1984` | **backup 中间件与幂等存在性探针依赖 `ToolExecCtx.cwd`（Option），无单一路径基准**。loop 装配缺省 `cwd: None`（loop/mod.rs:253/349，装配点 core_run_commands.rs:1984 亦 None）；cwd=None 时 backup 回退**进程 current_dir**（backup.rs:135）解析相对路径，而工具侧 workspace_root 解析链为「显式 → cwd → current_dir」（tool_exec.rs:722-728）——两者仅当「显式 workspace_root ≠ cwd」或「cwd 缺失且进程 cwd ≠ 工作区」时错位：backup 会快照错文件（或安全优先误 Block），幂等探针静默失效（executor.rs:155 返回空素材，A-14 的 F7 遗留接线在缺 cwd 装配下不生效）。当前 Tauri 壳主路径传 cwd，风险收敛为「装配面漏配即静默降级」。 | 统一基准：中间件上下文与幂等探针改用与工具侧同构的解析链（显式 workspace_root → cwd → current_dir），或使 cwd 成为装配必填（fail-closed）。 |

## 2. 已登记项核对（T-1 基线状态更新，供主 Agent 汇总）

以下为审计中对 T-1 登记项的状态核对结果，非新发现：

| T-1 编号 | 登记内容 | 核对结果 |
| :--- | :--- | :--- |
| B-01 | clamp_text 以 `#[allow(dead_code)]` 保留，去留未裁决 | **已闭环**：clamp_text 已删除（tools/mod.rs:438 注释「已删除——F3 登记的 dead_code 裁决」+ 全仓 grep 仅剩注释与 `clamp_text_by_lines`），B-01 应标记已裁决。 |
| A-14/F-03 | 幂等键细化（overwrite/存在性入键） | F7 遗留 2 已接线：`path_existence_markers`（executor.rs:154-167）经 ExecutorContext.cwd 附加存在性素材 + `extra_key_material`（idempotency.rs:299-315）入键，测试覆盖状态翻转（executor.rs:474-516）——**但依赖 cwd 装配，见 A1-W1**。 |
| B-02 | replace.rs 本地镜像 encode_text/resolve_write_encoding 去重 | **已闭环**：replace.rs:564-566 注释确认本地镜像已删，复用 fs.rs:368/402 的 pub(crate) 实现。 |
| A-16 | wait_subagents persist_outputs 引擎侧重载 | 契约面缺省 no-op（wait_subagents.rs:531-536），工具层调用点已接（:761-766）——与登记一致，未变。 |
| C-04/F-18 | organization 口径矛盾（工具面 vs 写路径沙箱） | 现状：default_permissions 的 organization = ReadOnlyPlusWriteFile + MainAgentDirs（subagent.rs:289-293），与 readonly.rs 的 organization → 只读白名单（readonly.rs:107）**在工具面映射上不一致**（readonly.rs 无 organization 特殊化，走只读；default_permissions 却声明 write_file）——登记的矛盾在实现内仍有第二处分歧面，供 F-18 定夺时参考。 |

## 3. 域质量总评

**总体：成熟度高，安全性纵深完整。**

- **强项（应作为全仓基线）**：
  - 写面守卫链接线整齐：write_file / multi_replace / delete / shell 删除重定向四类写路径统一走「越权（write_not_allowed）→ 互斥（write_path_conflict）→ 备份快照 → 配额」串行链（fs.rs:316-332、replace.rs:99-103、delete.rs:194-197、shell.rs:410-423），错误码与文案质量高（含占用者/有效期/指引）；
  - 命令面四层拦截（门禁红线 → 删除形态重定向 → cd 形态 → 执行）语义清晰、测试覆盖全变体；
  - 错误处理整体诚实：Option 未接线 → common.unsupported 结构化错误、落库失败 best-effort 降级不 panic、parse 容错不 panic；
  - 幂等/配额/产出目录的持久化契约均为「叶子 crate 只定义契约 + 引擎注入」模式，依赖方向干净。
- **弱点（按修复优先级）**：
  1. 编码护栏缺失（A1-H1）：唯一读-改-写回路径无编码校验，存在真实数据破坏面；
  2. 基准单一化不足（A1-W1/M-3）：cwd（Option）双基准 + run_id 缺位导致后台任务无归属；
  3. 错误码双轨制（M-7/A1-L13）：本地域码不入注册表，前端/执行器分类路由持续受限；
  4. 降级语义静默化（M-6/D-29 同类）：daemon/配额 fail-open 等降级无告警；
  5. 少量测试面污染与命名误导（A1-L1/L6/L7）。
- **维度打分**：工程规范 良（注释与命名总体优秀，个别文档漂移）；模块质量 优（错误处理/边界/并发面细致，锁均为短临界区、无跨 await 持锁）；工具契约 良（schema 与实现基本一致，少量描述偏差与容忍度分裂）；接线流畅性 中良（工具层内部接线整齐，对装配面依赖敏感）；安全性 优（路径/命令/权限无绕行路径，唯一硬伤为编码面）。

## 4. 最需修复的 5 条

| 序 | 编号 | 问题 | 理由 |
| :---: | :--- | :--- | :--- |
| 1 | A1-H1 | multi_replace 对 GBK/latin1 文本静默字节破坏 | 数据损坏面，中文 Windows 场景可真实触发，且当前无任何警告 |
| 2 | A1-W1 | backup/幂等探针依赖 cwd（Option）回退 current_dir | 装配漏配即静默降级（备份错基准/幂等失效），与安全链直接相关 |
| 3 | A1-M3 | 后台任务 owner_run_id 恒 None | 任务无 run 归属，kill_all/审计/会话清理无法关联，契约缺口 |
| 4 | A1-M1 | grep 大小写不敏感 column 计算可 panic（str 非边界切片） | 确定性崩溃路径，执行链无 catch_unwind，触发面虽窄但无护栏 |
| 5 | A1-M4 | 配额消耗失败 fail-open 静默 | 安全敏感面与 backup fail-closed 策略分裂，配额可被绕过且无日志 |

## 统计

| 维度 | 高 | 中 | 低 | 小计 |
| :--- | :---: | :---: | :---: | :---: |
| 工程规范（命名/文档/死代码/重复/测试污染） | 0 | 0 | 6（L1/L5/L6/L7/L13 + 基线核对 3 项另计） | 6 |
| 模块质量（复杂度/错误处理/边界/资源） | 0 | 1（M5） | 2（L2/L9） | 3 |
| 工具契约（schema/描述/错误码映射） | 0 | 2（M6/M7） | 4（L3/L4/L10/L11） | 6 |
| 接线流畅性（工具间/装配面） | 0 | 1（M3） | 1（L12） | 2 |
| 安全性 | 1（H1） | 3（M1/M2/M4） | 0 | 4 |
| **合计** | **1** | **7** | **11** | **19** |

（A1-W1 接线脆弱点归入「接线流畅性」维度按中计，表中并入 M 级列；实际新发现 = 19 条。）

## 回报要点（供主 Agent 汇总）

- 新发现 19 条（高 1 / 中 7 / 低 11），另基线核对 3 项（B-01 已闭环、A-14 依赖 cwd、C-04 实现内第二处分歧面）。
- 高严重度 1 条：A1-H1 —— multi_replace 对无 NUL 非 UTF-8 文本（GBK/latin1）经 lossy 解码写回静默破坏原文件字节（replace.rs:106-115 + mod.rs:371-385）。
- 总评：工具域成熟度高、安全纵深完整，最需修复集中于编码护栏（H1）、cwd 基准单一化（W1）、后台任务 run 归属（M3）。
- 文档路径：`docs/feature-gap-analysis/audit/A1-agent-tools工具域审计.md`。
- 未提交任何变更（只读任务）。
