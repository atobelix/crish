# DEEPCHECK-08 安全面交叉检查（E4 重派）

- 检查人：E4（安全面检查子代理，重派）
- 检查日期：2026-08-09
- 检查对象：并行阵营交付的 sandbox / gatekeeper / 权限系列（I 系列 + F3 修复）与本阵营工具系统 S1 流式协议的交叉安全面
- 方法：逐项读代码 + 读测试断言（全部只读，未改任何文件，未做 git 操作）
- 结论汇总：9 项检查中 **6 项通过（无风险）、3 项存在缺口/提示（均非高危）**；最严重一项为 **第 7 项 SSRF 防护缺失**（当前暴露面为零，但引入 web 工具前无任何防护）。

---

## 逐项结论表

| # | 检查项 | 结论 | 证据 | 风险等级 |
|---|--------|------|------|----------|
| 1 | S1 流式与权限链顺序 | ✅ 通过（防线全部在工具内部，两路径共用） | executor.rs:151-247、shell.rs:198-333、tool_exec.rs:968-1014 | 无 |
| 2 | sandbox 与 shell 流式 | ✅ 通过（prepare 共用面，门禁/审批/删除形态/cd 形态在流式路径同样生效） | shell.rs:161-169、198、393-405；测试 shell.rs:3161-3181、3187-3209 | 无 |
| 3 | 写路径互斥 vs 流式写 | ✅ 通过（无锁贯穿 Progress；唯一真流式工具 shell 不声明写路径） | definition.rs:167-168、write_paths.rs:245-249、shell.rs:438-528 | 无（1 条设计边界记录） |
| 4 | 审批与后台任务 | ✅ 通过（审批在转后台之前完成，回落路径复用 prepare） | shell.rs:396-397、271-288、858-1015 | 无 |
| 5 | 权限持久化（persisted_grant） | ⚠️ 无等价物（每次越界命令都需重复审批；fail-closed 方向，可用性差异） | approval.rs:104-161、tool_exec.rs:810-817 | 低（能力差距） |
| 6 | secret/凭据安全 | ✅ 通过（DPAPI 落盘、last4 最小化、日志不记明文） | credentials.rs:236-341、354-398 | 无 |
| 7 | 沙箱网络策略（SSRF） | ⚠️ AI 工具面无 web 工具（暴露面为零）；唯一 HTTP 命令 workbench_http_request 无域名白名单/内网拦截 | commands.rs:20-75、command_manifest.rs:96 | 中（预留风险） |
| 8 | F3 修复抽查（#4 流内 error 帧、#6 cwd 前缀混淆） | ✅ 通过（两处修复均真实生效且有测试锁死） | consume/mod.rs:359-372、477-535；conex-sandbox lib.rs:146-158、254-285 | 无 |
| 9 | explore_quota / subagent_inject 越权面 | ✅ 基本通过（1 条残余提示：配额只覆盖文档写工具，implementation 全工具集含 shell 可绕过） | explore_quota.rs:285-411、fs.rs:332-336、replace.rs:103-107、readonly.rs:30-36 | 低-中 |

**统计：通过 6 项，风险/缺口 3 项。最严重：第 7 项（SSRF 防护缺失）。**

---

## 第 1 项：S1 流式与权限链顺序（✅ 通过）

### S1 流程环节核对表（execute_stream_with_output_policy，executor.rs:151-247）

| 环节 | 流式路径（S1） | 旧路径（execute_with_output_policy，77-138） | 一致性 |
|------|---------------|----------------------------------------------|--------|
| 幂等 check | 162-181：命中 → deduplicated 终值、零 Progress（D3） | 87-106：同 | ✅ |
| 审批/门禁 | 不在执行器层；在工具内部（shell prepare：门禁 → ctx.ask 审批 → 删除形态 → cd 形态） | 同（工具内部） | ✅ 两路径共用同一函数 |
| 写路径互斥/越权 | 不在执行器层；在写工具内部（check_write_allowance_for_ctx → claim_write_guard）与 shell 删除重定向（shell.rs:513-528） | 同 | ✅ |
| 执行 | 183：`tool.execute_stream`（未实现者经 definition.rs:167-168 默认包 execute） | 108：`tool.execute` | ✅ |
| 输出预算 | 220-230：Terminal 终值上 summarize 截断 | 110-120：同 | ✅ |
| abort | 187-189 + 203-217：流中途中止 → drop 流、返回 runtime.aborted、不记录幂等键 | N/A（一次性执行无 abort 帧） | ✅ 语义增强非降级 |
| 幂等 record | 232-238：Terminal 终值后记录（失败/中断不记录） | 122-129：同 | ✅ |

### Progress 推送是否可能绕过防线

**不能。** 依据：

1. **防线前置**：门禁/审批/删除形态/写路径互斥全部在工具内部于「产生副作用之前」完成（shell prepare 在 spawn 子进程前，write_file 在写盘前）。Progress 帧只在 spawn 之后产生（shell.rs:1238-1254 读管道逐块推送），此时审批与门禁已全部通过。
2. **Progress 是纯展示事件**：tool_exec.rs:968-973 注释明确「ToolUpdate 为展示面不进消息历史，终值仍由 ToolEnd 承载」；tool_progress_update（tool_exec.rs:1431-1436）只映射文本到 `ToolEvent::ToolProgress`，不触发任何审批/权限判定。
3. **Content 块被丢弃**（阶段 1）：tool_progress_update 对 `ToolProgress::Content` 返回 None 直接丢弃（tool_exec.rs:1776 测试断言）。
4. **幂等去重路径零 Progress**（executor.rs:172-179 早退，测试 streaming_idempotent_second_call_deduplicates_with_zero_progress，1083-1126）。

### 轻微观察（非风险）

- Progress 内容 = 子进程 stdout/stderr 原文，会进入 UI 事件流；与 execute 结果文本（同样会被模型消费）风险等级相同，非新增面。
- 流式路径的预算截断是「实时截断」（shell.rs:1260-1294 停止推送），结果仍标记 truncated，与旧路径一致。

---

## 第 2 项：sandbox 与 shell 流式（✅ 通过）

- **prepare 共用面确认**：shell.rs:161-169 定义 `Prepared`（Run/Done），198 注释「S1 验收（§3.1.6）：流式路径与旧 execute 路径的错误面/重定向面逐字节一致——两路径必须共用本函数，不得各自复制逻辑」。
- execute_stream（393-405）与 execute（346-373）都先走 `self.prepare(ctx, &args)`；门禁（244-264 Blocked + 红线）、审批（265-289 RequiresApproval → ctx.ask）、删除形态重定向（291-306）、cd 形态（308-314）在流式路径同样生效。
- 测试锁死：
  - `stream_blocked_command_error_terminal_matches_execute`（shell.rs:3161-3181）：`rm -rf /` 经 execute_stream → Terminal(Err) 且 `e.to_string()` 与 execute 逐字节一致，零 Progress。
  - `stream_delete_redirect_matches_execute`（3187-3209）：删除形态经流式路径重定向结构一致（redirected/kind/reason/impact）。
  - `stream_non_sync_mode_falls_back_to_execute`（3214-3231）：auto-background 回落 execute 逐字段一致。

---

## 第 3 项：写路径互斥 vs 流式写（✅ 通过，1 条设计边界）

### 锁释放时机分析

| 场景 | 守卫持有期 | 分析 |
|------|-----------|------|
| 写类工具（write_file / multi_replace 等） | execute 作用域内（write_paths.rs:245-249 Drop 释放；fs.rs:319） | **无独立 execute_stream 实现**——definition.rs:167-168 默认实现 `terminal_only(self.execute(...))`，守卫随 execute 返回（Terminal 单帧）立即释放。不存在「Progress 期间持锁」。 |
| shell 删除重定向 | prepare 内同步声明+执行+释放（shell.rs:521-528，函数级守卫） | 重定向在 spawn 前完成，与流式执行无关。 |
| shell 长命令流式 | **不声明写路径** | shell 副作用无法静态预知（readonly.rs:23-24 明确此判断），S1 未改变该语义。 |

### 设计边界（记录非回归）

**长命令流式执行期间，其他工具可以写同一文件**（如 `npm install` 流式期间另一工具写 package.json）。这是 shell 副作用不可静态声明的固有边界，S1 与旧路径行为一致；删除形态已被重定向接管，残余面为 shell 内部非删除写形态（`echo x > f`）。建议后续考虑 shell 写形态语义检测（与删除形态同层）作为增强。

---

## 第 4 项：审批与后台任务（✅ 通过）

- **审批先于转后台**：execute_stream 对非 sync 模式（auto-background / daemon）回落 `terminal_only(self.execute(...))`（shell.rs:396-397）；execute → prepare（271-288：RequiresApproval 经 ctx.ask 真实审批，拒绝 → TOOL_USER_DENIED 返回）→ 只有审批通过才进入 `run_command_maybe_background`（858-1015）→ adopt 转后台（894-909、965-977）。**后台化只发生在审批通过之后**，不存在「后台任务绕过审批」路径。
- 未接线（ask: None）→ `tool.requires_approval` 结构化错误，不执行（282-287），同样适用于后台模式。
- 后台任务语义提示（设计决策，非缺陷）：转后台任务默认无限运行（T-AB-02 描述），审批是一次性的；后续进程生命周期不受审批约束，终止依赖 kill 工具/健康判定。与 sync 模式审批口径一致。

---

## 第 5 项：权限持久化（persisted_grant 等价物）（⚠️ 无）

**结论：我们没有 grok-build 的 persisted_grant 等价物。**

- ApprovalChannel（approval.rs:104-161）每次 `ask` 都走 `gate.request_approval`，无任何「本会话记住批准」记忆；裁决按次返回（Approved/Denied/Expired）。
- 唯一「免审批」路径是 full-access 权限模式 → NoopAskChannel 自动放行（tool_exec.rs:815，PermissionMode::FullAccess），这是全局开关而非按命令记忆。
- 子代理权限申请（T-D-14）同样按次审批，无缓存（approval.rs:279-316 requester 透传测试确认按次）。

**影响**：安全方向偏保守（每次越界命令都要用户确认，fail-closed），无泄露风险；但可用性差距明显——高频重复越界命令（如反复 `git push --force` 工作流）每次都要人工审批。若后续要补 persisted_grant，建议按「会话级 + 命令模式级」粒度并带 TTL 与撤销面，对齐写路径互斥的 TTL 过期模式（write_paths.rs:54、404-414）。

---

## 第 6 项：secret/凭据安全（✅ 通过）

- **存储**：Windows DPAPI（CryptProtectData/UnprotectData，CRYPTPROTECT_UI_FORBIDDEN）加密后 hex 落盘 `config_dir()/secrets/{profileId}.dpapi`（credentials.rs:354-362、401-448）；非 Windows 纯内存降级（unavailable=true）；进程内缓存仅存内存（39、101-109）。
- **回读最小化（K-02）**：`config_secret_get` 只回 `{hasKey, apiKeyLast4}`；`config_secret_has` 连 last4 都不回；只有 `config_secret_reveal(ui_confirm=true)` 回明文（319-341）。
- **日志（K-05）**：config_secret_set 成功日志只记 `api_key_last4`（256-263），不记明文；清除日志无敏感字段（307-311）。
- **无通用 redact.rs**：仓库中的 `redacted` 是 thought 块展示标记（agent-provider events.rs:220 等），与凭据无关；凭据脱敏靠「只记 last4」的结构性最小化实现，链路各面（安全审计 sink、tracing 日志）均未见明文泄漏点。
- 观察（低风险）：`config_secret_reveal` 的 `ui_confirm` 是前端传入参数而非后端一次性票据——本地桌面壳内若 webview 被 XSS 可直接调 reveal(true) 取明文；属本地可信边界内常规约束，非新增风险。

---

## 第 7 项：沙箱网络策略 / SSRF（⚠️ 中，预留风险）

**现状**：

1. **crates/agent-tools 无任何 web 工具**——`web_fetch`/`web_search` 未实现（tools/ 下 15 个文件全部本地工具：shell/fs/delete/search/diff/subagent 等）。AI 工具面当前**没有出网能力**（除 shell 命令门禁放行后的命令自身网络行为，如 curl——但 `curl | sh` 形态已是红线，lib.rs:38）。
2. **唯一 HTTP 命令**：Tauri 壳 GUI 命令 `workbench_http_request`（commands.rs:20-75，main.rs:124 注册，command_manifest.rs:96 标 gui）：
   - ✅ scheme 校验（仅 http(s)，33）；✅ 禁 Host/Content-Length 头覆盖（50-53）；✅ 仅 GET/POST/HEAD（27-31）；✅ 30s 超时。
   - ❌ **无 SSRF 防护**：无域名白名单、无私网地址拦截（127.0.0.1 / localhost / 169.254.169.254 云元数据 / 10.x / 192.168.x / 172.16-31.x / IPv6 内网）、无 DNS rebinding 防护、无重定向跟随限制（reqwest 默认跟随）。
   - 它仅供前端 UI 用（供应商 /models 与连通测试），不在 AI 工具面，**当前暴露面为零**。

**风险定性**：当前无 AI 可达的 HTTP 工具，SSRF 实际风险为零；但防护能力为零是既定事实。一旦后续把 web_fetch 类工具接入 AI 工具面（对齐 grok-build 的 web_fetch SSRF 防护 + 域策略，见 C2-grokbuild-benchmark.md:104、128）或 workbench_http_request 被 MCP 化，将直接暴露。**建议在引入 web 工具前落地：域名白名单 + 私网/链路本地地址解析后拦截 + 重定向限制**。

---

## 第 8 项：F3 修复抽查（✅ 两处均真实生效）

### F3 #4：流内 error 帧分类

- 修复：consume/mod.rs:359-372 `classify_stream_error` 接入统一分类管线 `classify_provider_error(None, Some(message), None, None)`——上游以 HTTP 200 + SSE error 帧返回瞬时 429/5xx 文案时，「未产出内容」可按分类重试（修复前恒 Unknown/retryable=false）。
- 测试锁死：
  - `in_stream_rate_limit_message_is_retryable`（477-494）：`Rate limit exceeded: please retry after 5 seconds` → RateLimit + retryable=true。
  - `in_stream_server_error_message_is_retryable`（499-516）：`overloaded_error: ...` → ServerError + retryable=true。
  - `in_stream_auth_message_stays_not_retryable`（521-535）：认证失败 → Auth + retryable=false（分类管线全量生效，不只放行重试类）。

### F3 #6：cwd 前缀混淆

- 修复：conex-sandbox/src/lib.rs:146-158 `path_within_workspace` 从字符串 `starts_with` 改为**路径成分级比较 + 大小写归一**（`C:/project` vs `C:/project_evil` 在成分级下不成立）。
- 测试锁死：`context_prefix_sibling_root_is_escalated`（254-285）：`C:/project_evil` / `/home/user/project_extra` → RequiresApproval（修复前 Allowed）；`C:/project` 与深层子目录 → Allowed；大小写混写 `c:/Project/src` → Allowed。
- 交叉确认：shell.rs:246-249 先经 resolve_workspace_path（有组件边界）解析 cwd，工作区外已被 tool.path_escape 拒绝（测试 shell_cwd_must_be_valid，1997-2007），本层为防御纵深，口径已统一。

---

## 第 9 项：explore_quota / subagent_inject 越权面（✅ 基本通过，1 条残余提示）

### explore_quota（配额越权/绕过面）

防护链确认：
- **凭证不可自授**：granted 只能由主 agent 在 spawn 时经 `allow_explore_docs` 注入（explore_quota.rs:9-10、285-308 quota_context_for_spawn；`is_explore_class` = read-only capabilityMode 或 researcher role）。
- **原子占用**（F3 #9）：写盘前 `reserve_explore_docs_quota`（352-381）经 store 原子 try_consume 占用，写盘失败 Drop 自动 release（405-411）；测试 `parallel_writes_respect_quota_atomically`（681-735，并发双写恰好一份成功）、`failed_write_after_reserve_releases_quota`（740-770）。
- **工具面全覆盖**：write_file（fs.rs:332-336 guard + reserve）与 multi_replace_file_content（replace.rs:103-107）都接线；非探索类/主 agent 不检查（guard 无配额上下文直接放行）。
- **持久化**：session_meta 键 `{session_id}:explore_docs_consumed`（43-49），重启恢复（解析容错 70-88）。

**残余绕过提示（低-中，记录待引擎侧确认）**：配额只约束文档写工具（write_file / multi_replace）。若探索类子代理以 `implementation` task_type 派发，工具集 = 全工具集（readonly.rs:121），其 shell_command 可经 `echo x > doc.md` 等形态写文件**绕过配额**。当前 read-only 白名单（READONLY_TOOL_NAMES，readonly.rs:45-55）与 analysis/organization/design/review 映射均剔除 shell_command，残余面仅存在于「探索类 + implementation」组合；建议引擎侧 spawn 时对 capability（read-only）与 task_type（implementation）的组合做显式互斥校验或让配额覆盖 shell 写形态。

### subagent_inject（越权面）

- 本模块是纯提示词注入段工厂（started_at / git 回退指引 / 权限申请指引 / 产出目录 / 注释保留），无任何权限授予能力；内容参数化且结构固定（快照断言测试齐全），无注入风险。
- 越权面在引擎侧装配正确性（C10 build_context 挂载点，本模块只提供片段）：permission_relay / output_dir 段若被装配到错误作用域（如主 agent 或非子代理 run）只会产生误导性提示，非安全越权。
- started_at 注入「隔离边界」是提示词协议层（04 C2），真实隔离靠工具面（read-only 裁剪 + 写路径沙箱 + 配额），不依赖提示词。

---

## 附：最严重一项说明（第 7 项 SSRF）

- 当前事实：AI 工具面无 web 工具（暴露面为零）；workbench_http_request 是 GUI-only 命令且无 SSRF 防护。
- 为什么最严重：它是唯一「出网能力 + 零防护」的组合；一旦未来 web 工具入 AI 工具面（路线图上 grok-build 对标物已具 SSRF 防护 + 域策略），当前代码无法承接。修复成本低（解析 URL → DNS 解析后私网段拦截 + 域名白名单 + 禁重定向到私网），建议在引入 web 工具之前落地。
