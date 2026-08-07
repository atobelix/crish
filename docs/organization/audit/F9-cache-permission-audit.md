# F9 · cache 战役 + 权限引擎 + 治理机制审计报告

- 审计日期：2026-08-07
- 审计模式：严格只读（不改代码）
- 审计范围：cache 域（session-loop/cache_tracker、conex-telemetry/cache、agent-provider/request/cache + build + models/cache_key、conex-db v5 迁移 + usage_json、shared-types cache-metrics、前端 cacheEventsStore/cacheMetricsCompute、engine T-40 接线）；权限引擎（tool_exec.rs ApprovalRequired 全链路、shell.rs 门禁语义、conex-sandbox gatekeeper/semantics redline-first、permission.rs 三态、approval_router 权限传递层、workbench ApprovalGateImpl）；治理（clippy.toml、check-clippy-baseline.mjs、check-ui-layer.mjs、knip.config.ts、CI 三层 workflows）
- 验证手段：源码逐行阅读 + 实测运行 `check-clippy-baseline.mjs`（基线 35 键/62 实例、新增 0）+ 实测 `npx knip`（unused files 1 → exit 1）+ 逐条正则/语义推演绕过链

## 结论（TL;DR）

1. **权限域存在 1 个 P0 红线绕过链**：命令替换 `$(...)` / 反引号 / `iex` / `Invoke-Expression` 包裹 + `--` 变体，可让 `rm -rf -- /` 在**任意权限模式（含 full-access）下无审批直接执行**（Unix 平台）。门禁的「红线先行」只对段首命令名生效，静态正则被 `--` 阻断。
2. **权限域整体设计扎实**：三态矩阵、红线不可豁免、approval-requested 先发后等、同 call_id pending 覆盖、子代理→主 agent 裁决路由、死锁转用户路由（纯函数层）均有完整测试；生产接线无发现审批旁路（full-access 自动放行是既定语义）。
3. **cache 域测量正确性良好**（C9 恒等式、噪声地板、归因 8 类、粘性 reportedCache 均有测试），但 **P5 文档声称的「跨 run 签名基线持久化」与「8 类归因进 cache-waste-alert 事件」两处未兑现**（engine 自述「不做假签名」「归因 Unknown 诚实兜底」），属文档/实现偏差。
4. **治理域**：clippy ratchet 在 CI 真实运行且当前新增=0（拦截有效），但**存量未清零**（35 键/62 实例，I3 完成态声明「190 清零」未兑现），且 ratchet 存在**同文件同消息盲区**（62 实例折叠成 35 键，已实质化：MutexGuard×9 同文件只占 1 键）；knip 完全未接线（配置在、依赖无、CI 无、实测 exit 1）；check:zindex 脚本已死但仍被 34 收尾清单引用为断言项。

---

## 一、发现清单（按域分组，编号 | 文件:行号 | 严重度 | 问题 | 触发场景 | 修复建议）

### A. 权限域

| #     | 文件:行号                                                                                                                                                 | 严重度 | 问题                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------- |
| F9-01 | `crates/conex-sandbox/src/semantics.rs:91-144, 563-634`；`crates/conex-sandbox/src/lib.rs:24-60, 72-113`；`crates/agent-tools/src/tools/shell.rs:210-253` | **P0** | **红线绕过：命令替换/脚本块包裹 + `--` 变体** |

- **问题**：`classify` 只对「段首命令名」判定红线；`split_segments`（semantics.rs:147-198）不拆 `$(` / 反引号 / `{ }` scriptblock；静态正则 `-rf\s+(/|/\*|\*)`（lib.rs:27）被 `--` 阻断。三处合谋形成绕过链：`echo "$(rm -rf -- /)"` → 单段、命令名 `echo` → Normal；正则因 `-rf` 后跟 `--` 不匹配 → `check_command` 返回 Allowed → shell.rs:285 直接执行（bash 下 `rm -rf -- /` 递归删根）。`iex` / `Invoke-Expression` / `Start-Process` / `powershell -EncodedCommand <base64>`（整链对静态层不可见）同属缺口——`INDIRECT_COMMANDS`（semantics.rs:61-64）不含 `iex`/`Invoke-Expression`/`Start-Process`。
- **触发场景**：模型被 prompt 注入后构造 `echo "$(rm -rf -- /)"` 形态；任意权限模式（红线本应 100% 拦截、full-access 不豁免，lib.rs:75-85 + permission.rs:96-106 的承诺在此链上不成立）。Windows 平台因 `rm` 别名语义与 `--` 非 PowerShell 停解析符，杀伤降级（P1），Unix/bash 平台为 P0。
- **修复建议**：① `classify` 前对段文本做命令替换/反引号/scriptblock 包裹的递归下沉（对齐 `analyze_indirect` 的 `-c` 提取先例，semantics.rs:439-546），或把 `$(`/反引号/`{` 包裹内容整体提取后递归 `analyze`；② `INDIRECT_COMMANDS` 增补 `iex`/`invoke-expression`/`start-process`/`powershell -encodedcommand`（base64 无法静态解，至少降级为 RequiresApproval）；③ 补测试：`echo "$(rm -rf -- /)"`、`` echo `rm -rf -- /` ``、`iex 'rm -rf -- /'`、`powershell -EncodedCommand ...` 必须 Blocked。

| #     | 文件:行号                                                                                                                    | 严重度 | 问题                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| F9-02 | `crates/session-loop/src/tool_exec.rs:578-622, 1101-1173`；`apps/agent-workbench/src-tauri/src/core_run_commands.rs:320-328` | P2     | **同一 call_id 二次审批（批级 dangerous 审批 + 工具内门禁审批叠加）** |

- **问题**：ask 模式下 shell（dangerous=true，shell.rs:147）在批级 `call_verdict → NeedsApproval → request_approval`（第 1 次）→ Approved → `execute_single_with_retry` → 工具内 gatekeeper `RequiresApproval`（如 `sudo x`）→ `ctx.ask = ApprovalChannel` → **同一 call_id 再次 request_approval**（第 2 次）。gate 侧对同 id 覆盖 pending（core_run_commands.rs:323-327）。用户对一条 `sudo` 命令要批两次；两卡片同 id，第一条 resolve 后第二条窗口变 stale（再点 resolve 报 NotFound）。**非绕过**（更严），但 UX 缺陷 + 双窗口语义与「防死锁先发后等」契约叠加易误操作。
- **触发场景**：ask 模式下任何同时命中「工具 dangerous 标记」与「工具内门禁 RequiresApproval」的命令。
- **修复建议**：批级审批通过后，执行阶段把该 call_id 标记为「已批核」，`ApprovalChannel.ask` 对同 call_id 直接放行（或 gate 内按 call_id 记录最近决策、重复请求复用）；补双审批语义测试。

| #     | 文件:行号                                                                  | 严重度 | 问题                                                 |
| ----- | -------------------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| F9-03 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:222-249, 300-335` | P2/P3  | **resolve() 注册窗口 TOCTOU：广播先于 pending 注册** |

- **问题**：`request_approval` 顺序为 ①广播 approval-requested（:300）→ ②状态机转移（:308）→ ③pending 注册 oneshot（:320）。若裁决（resolve）在 ③ 之前到达 → `pending.remove(tool_call_id)` 返回 NotFound（:232-237），合法裁决被拒（窗口微秒级，人类点击时序难命中，但自动裁决器/测试竞速可触发）。
- **修复建议**：注册改为先于广播（先建通道再广播，保持先发后等契约）；或 resolve 对 NotFound 做幂等宽容（日志告警不报错）。

| #     | 文件:行号                                                                                             | 严重度 | 问题                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| F9-04 | `crates/agent-tools/src/revert.rs:183-207, 226-228`；`crates/session-loop/src/tool_exec.rs:1186-1204` | P2     | **C3 大面积回退护栏对「面积未知」降级为零打扰，full-access 承诺只在面积可估时成立** |

- **问题**：`SemanticRevertAssessor` 只按 pathspec 数量等命令文本线索估面积（revert.rs:183-207），未知维度默认 false = 零打扰（revert.rs:226-228）。`git checkout abc1234`（无 pathspec）→ 面积全 None → `gate_verdict` 返回 None → full-access 下直接放行——「full-access 不豁免大面积回退」（permission.rs:459-485 测试）仅在面积可评估时成立。设计取舍已文档化，但**风险暴露面是真实 git 查询能力缺失**（大面积回退可能绕过审批）。
- **修复建议**：未知面积按「保守需审批」或接入真实 git 查询（`git rev-list --count` / `git diff --stat`）后再判；至少把「未知面积降级」写进 31-security-baseline 的已知风险表。

| #     | 文件:行号                                                                                                                          | 严重度 | 问题                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| F9-05 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:210-216, 3760-3795`；`crates/session-loop/src/approval_router.rs:107-118` | P2     | **死锁防护 detector 未在生产接线（仅测试 helper 使用）** |

- **问题**：`with_deadlock_detector` 标 `#[cfg_attr(not(test), allow(dead_code))]`，生产构造点（:2753-2762）不注入；`route_approval_guarded` 的「主 agent wait 子代理时转用户」分支在生产恒走纯超时兜底（120s Expired）。approval_router.rs:41-45 自述「F11 T-D-13 引擎接线落地」——**未落地**（engine.rs 无追踪器信号源）。
- **触发场景**：主 agent `wait_subagents` 阻塞期间子代理发起权限申请 → 空等 120s → Expired（run 不中断，非致命）。
- **修复建议**：按 T-D-13 接线（orchestrator 子代理跟踪器 await 态标记 → detector）；若本轮明确不做，需在 34 收尾清单/31 安全基线的「未接线面」中登记（当前仅 approval_router 头注声明）。

| #     | 文件:行号                                                     | 严重度 | 问题                                                |
| ----- | ------------------------------------------------------------- | ------ | --------------------------------------------------- |
| F9-06 | `crates/session-loop/src/approval_router.rs:147-154, 150-154` | P3     | **approval_reason 无来源校验（显示/审计面 spoof）** |

- **问题**：`approval_reason_from_args` 从工具入参保留键 `approval_reason`（:147）原样透传广播与落库——子代理可注入任意理由文本；裁决路由不受影响（仲裁者由 gate 的 parent_run_id 决定，与 requester 无关，:265-270），仅展示/审计面可伪造。
- **修复建议**：可选——长度/字符集钳制 + 明确标注「模型自述理由，未经核实」。

### B. cache 域

| #     | 文件:行号                                                                                                              | 严重度 | 问题                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| F9-07 | `apps/agent-workbench/src-tauri/src/engine.rs:1480-1505`；`crates/session-loop/src/loop/handlers/streaming.rs:371-379` | P1     | **cache-waste-alert 归因恒 Unknown：P5 §3.4.2 声称的 8 类归因进事件未兑现** |

- **问题**：streaming.rs:371-379 的 in-loop `CacheMiss`（含 `classify_miss` 8 类归因、idle_ms、model_changed）**只打日志**，注释「发射归 T-40」；T-40 侧 `waste_alert_event`（engine.rs:1488-1505）用 run 级聚合重造事件——`attribution: Unknown` 硬编码（:1499）、`idle_ms: 0`（:1501）、`missed_cost_usd: None`（:1503），engine.rs:1485-1487 自述「诚实兜底」。前端 alerts 恒显示 unknown，prefix-changed/model-switch/zero-read 等归因数据在 UI 面全部丢失。
- **触发场景**：任何触发 cache-waste-alert 的 run（missed ≥ 20k，WARN_MISSED_TOKENS）。
- **修复建议**：把 in-loop 归因经事件桥透出（tracker 累计归因桶，run 收口按桶出事件），或明确降级文档（P5 §3.4.2 与前端 attribution 字段说明改为「当前恒 unknown」）。

| #     | 文件:行号                                                                                                           | 严重度 | 问题                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| F9-08 | `crates/session-loop/src/cache_tracker.rs:11-14, 277-279`；`apps/agent-workbench/src-tauri/src/engine.rs:1400-1410` | P2     | **跨 run 签名基线未持久化：P5 §3.4.5「跨会话重建」与 cache_tracker 头注声称的「engine 层跨 run 持久化（T-40）」未兑现** |

- **问题**：engine.rs:1404-1407 明确「本层不做假签名，跨 run 签名续接属 session-loop 侧待接线项」——`SessionCacheState` 只存 warm_until_ms/input_total/model。后果：每 run 首 turn 无基线 → `MissDetector::detect` 返回 None（miss.rs:158-160），**跨 run 的 miss 检测（min(prev,cur) 语义）缺失**；冷缓存预警降级为 warm_until_ms 过期判定（engine.rs:1449-1478），损失 resend 语义精度。跨 run TTL 超时/前缀变化归因在首轮全部丢失。
- **修复建议**：T-40 二期把 `CacheBaseline`（含签名哈希）落 runs 表/会话状态，跨 run 重建 tracker 基线；或更新文档明确「跨 run 检测不做」。

| #     | 文件:行号                                                                                                                      | 严重度 | 问题                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------ |
| F9-09 | `crates/conex-telemetry/src/cache/math.rs:66-103`；`apps/crish-desktop/src/api/chat-bridge/handlers/cacheEventsStore.ts:72-97` | P2     | **Included 系 read > prompt 异常时 hitRatio > 1 且前后端口径分叉** |

- **问题**：Rust 侧 `derive`（math.rs:74）read+write > prompt 时 miss 钳 0、input_total = prompt → `hit_ratio = read/prompt > 1`（math.rs:93 无钳制）；C9 恒等式 `input_total = miss + read + write` 在此异常数据下断裂。前端 `runStatsToCacheMetrics`（cacheEventsStore.ts:76）**不消费引擎 inputTotal（RunCacheStats 无该字段），自行 read+write+miss 重算** → 同一 run 前后端 hitRatio 显示不一致（前端 ≤ 1，引擎 > 1）。
- **触发场景**：厂商上报 read+write > prompt（DeepSeek 顶层 prompt_cache_miss_tokens 直报异常、多分片合并错误等）。
- **修复建议**：Rust 侧 `hit_ratio` 计算加 `min(1.0)` 钳制；RunCacheStats 增加 `input_total` 字段供前端直接消费（消除双算）。

| #     | 文件:行号                                  | 严重度 | 问题                                 |
| ----- | ------------------------------------------ | ------ | ------------------------------------ |
| F9-10 | `crates/conex-db/src/runs.rs:212-220, 283` | P3     | **warm_until_ms u64→i64 无符号回绕** |

- **问题**：`stats.warm_until_ms.map(|v| v as i64)`（:220）——u64 超 i64::MAX 时回绕为负，读回 `v.max(0)` 钳 0（:283）。理论边界（纪元 292 亿年），但 `warm_until`（cold.rs:23-26）已饱和到 i64::MAX 而非钳 u64——两层口径不齐。
- **修复建议**：落库前 `u64::try_from` 或与 cold.rs 同用 saturating 语义。

| #     | 文件:行号                                                     | 严重度 | 问题                                                       |
| ----- | ------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| F9-11 | `crates/agent-provider/src/request/cache.rs:447-463, 325-333` | P3     | **overrides 非法值静默忽略；Auto 机制忽略 retention 覆盖** |

- **问题**：`extra.cache.enabled` 非 bool / `retention` 非字符串 → 静默取默认（:447-452, 455-463）；Auto 分支（:325-333）硬编码 `retention: Short`，用户配置 `retention: "long"` 被静默丢弃（Auto 无 wire 参数、语义无害，但无声）。
- **修复建议**：非法值记 warn 日志；Auto 分支至少保留解析结果用于日志。

| #     | 文件:行号                                            | 严重度 | 问题                                              |
| ----- | ---------------------------------------------------- | ------ | ------------------------------------------------- |
| F9-12 | `crates/agent-provider/src/request/cache.rs:781-843` | P3     | **apply_cache_controls 锚点重合时早退，记账缺失** |

- **问题**：user-prefix 单消息场景，system 锚点落在首条 user 消息后，messages 锚点与 system_index 重合 → `return report`（:815-817）——该消息的 messages 级断点既不 placed 也不 dropped 记账（报告不完整；行为本身正确：不重复放置）。
- **修复建议**：早退前把该场景计为「messages 断点由 system 锚点兼得」（report.messages_shared 或计入 placed 注释）。

| #     | 文件:行号                                                                                                            | 严重度 | 问题                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------ |
| F9-13 | `crates/agent-provider/src/request/cache.rs:282-300, 413-444`；`crates/agent-provider/src/models/cache_key.rs:41-67` | P3     | **亲和 header 门用硬编码头名，矩阵新增头名静默不注入** |

- **问题**：request/cache.rs:506 用 `name == "x-grok-conv-id"` 硬编码白名单（Chat 轨），矩阵（cache_key.rs:55-66）新增 Chat 轨头名（非 dashscope 类）会静默丢弃——保守方向正确（防未知头注入），但「数据表驱动」与「硬编码门」双源并存，未来扩展易踩坑；C4 等价委托（cache_key.rs:20-26）测试已钉死键推导单实现，**确认无双实现漂移**。
- **修复建议**：头名白名单移到 behavior 矩阵（加 Chat/Responses 轨标记字段），消除硬编码。

### C. 治理域

| #     | 文件:行号                                                                                                              | 严重度 | 问题                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| F9-14 | `scripts/check-clippy-baseline.mjs:33-35, 100-124`；`docs/multi-agent-repair/基线记录/clippy-workspace-T13.md:165-228` | P1     | **clippy ratchet 同文件同消息盲区（已实质化：62 实例折叠为 35 键）** |

- **问题**：ratchet 归一键 = `消息文本 + 文件`（:33-35），忽略行号——**同文件新增同类告警不可见**。基线实测：62 条实例 → 35 个键；`MutexGuard held across await` 在 core_run_commands.rs 有 9 处（:182-189）只占 1 键、cache_tracker.rs 的 `map_or` 4 处只占 1 键、`from_ref` 4 处只占 1 键——新增第 10/5/5 处同类告警 CI 不拦截。
- **修复建议**：按「消息+文件+行」精确计数（新增实例也拦截），或按告警实例数（count）做 ratchet（当前实例 62 → 上限 62，只降不升）；基线同步改为实例粒度。

| #     | 文件:行号                                                                                                                                                                      | 严重度 | 问题                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------- |
| F9-15 | `scripts/check-clippy-baseline.mjs`（实测：基线 35 键/62 实例、当前 35 键、新增 0）；`docs/multi-agent-repair/improvement/04-治理收尾方案.md:393`；`clippy.toml`（豁免面注释） | P1     | **存量 clippy 告警未清零，I3 完成态声明不符；disallowed-methods 豁免面声明与实际不符** |

- **问题**：实测 ratchet 通过（CI 中有效运行，**新增拦截是真实有效的**），但存量 62 实例（35 键）仍在基线内——04 方案 I3 完成态「clippy 190 清零、基线收缩到空/最小态」未兑现（仅 190→62）。且基线含 **disallowed-methods 告警 9 条**（executor.rs:483/518 为**产品代码** remove_dir_all、conex-telemetry/tests 4 条、conex-test-utils 2 条）——clippy.toml 声称豁免面为「测试代码临时目录清理」「conex-test-utils 纯测试 crate」，但 **agent-tools/src/executor.rs 是产品执行器**，不在豁免面说明内（要么补豁免注释，要么修代码）。
- **修复建议**：清零轮将 62 实例按 G11 口径处置（executor.rs 2 条改 trash 接管或函数级 allow+理由）；基线文件更新 I3 状态声明。

| #     | 文件:行号                                              | 严重度 | 问题                                                                                       |
| ----- | ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------ |
| F9-16 | `knip.config.ts:1-90`（rules: 70-80）；实测 `npx knip` | P2     | **knip 完全未接线：无依赖、无脚本、无 CI；实测 exit 1（unused files 1）+ 导出面 warn 594** |

- **问题**：knip.config.ts 存在但 package.json 无 knip 依赖与脚本（`npx knip` 现场从 npm 下载 knip@6.32.0）；CI 三层无 knip job。实测：Unused files 1（error 级 → exit 1，AgentToolRowRenderer.tsx）、Unused exports 594（warn 级）。04 方案:160 自述「knip 未进 CI（G14 后接入）」、:393 I3 完成态声称「knip → error → exit 0」——**均未兑现**；rules 仍 5 项 warn（:73-77）。
- **修复建议**：G14 收口（处理 1 个 unused file + 导出面审计）后接入 CI（error 级）；或把「knip 未接线」登记到 34 收尾清单遗留节。

| #     | 文件:行号                                                                                                                                                       | 严重度 | 问题                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------- |
| F9-17 | `scripts/check-ui-layer.mjs`；`package.json:42`；`.github/workflows/ci.yml / ci-mid.yml / ci-slow.yml`（无引用）；`docs/rust-rewrite/34-cleanup-closure.md:199` | P2     | **check:ui-layer 门禁未进 CI（仅本地脚本）** |

- **问题**：`check-ui-layer.mjs` 只挂 `package.json check:ui-layer`（check:desktop 本地链），CI 三层 workflow 均不运行 → ui 原子层依赖违规不拦截 PR；34-cleanup-closure.md:199 将其列为断言项但正文未确认 CI 接线。
- **修复建议**：接入 ci.yml（lint job 追加 `npm run check:ui-layer`，秒级成本）。

| #     | 文件:行号                                                                        | 严重度 | 问题                                                    |
| ----- | -------------------------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| F9-18 | `docs/rust-rewrite/34-cleanup-closure.md:200`；实测 scripts/ 无 check-zindex.mjs | P2     | **check:zindex 门禁已死（zindex.ts 已删）仍被文档引用** |

- **问题**：34 收尾清单断言 `check:zindex`（scripts/check-zindex.mjs）——脚本不存在；z-index 双源校验（PE-05 T05.5.3 的 `npm run check:n`）随 zindex.ts 删除而消失（终验报告 L6「n 死脚本删除」已确认），z-index.css 现为单源**无任何校验**。文档声称与实现偏差。
- **修复建议**：34 收尾清单该行改为「已删除（单源化，无校验）」或补简单 CSS 变量存在性校验。

| #     | 文件:行号                                                                                                 | 严重度 | 问题                                     |
| ----- | --------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| F9-19 | `.github/workflows/ci.yml:33-142`；`.github/workflows/ci-mid.yml:36-117`；`.github/workflows/ci-slow.yml` | P3     | **三层 CI 结构整体与文档一致，细节偏差** |

- **问题**：快层 9 job / 中层 6 job（rust-test/clippy/test/test:integration/machete/governance-baselines）/ 慢层 4 job（rust-stress/stress-ts/e2e/bench，schedule+dispatch+tag）——04 方案:160 的中层盘点（4 job、73 行）已过时（多出 machete + governance-baselines，文件 118 行）；ci-mid clippy job 中 clippy 被跑两次（步骤 :57 + 脚本内 spawnSync :77，口径一致仅耗时翻倍）；快层 `paths-ignore: docs/**` 与中层一致，docs-only 提交全层跳过（可接受）。
- **修复建议**：文档盘点行更新；clippy 步骤去掉重复（脚本内跑即可）。

### D. 未接线面 / 文档声称与实现偏差汇总

| #     | 文件:行号                                                                                                                               | 严重度 | 问题                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F9-20 | `apps/agent-workbench/src-tauri/src/core_run_commands.rs:1500-1525, 2210-2215, 2414-2467, 3081-3086`                                    | P2     | **T-40 core_run 合并已真实接线（run_usage/write_back_cache_stats/装配均在），但「任务书中声明的合并点」与「in-loop 归因发射」偏差**：engine.rs:1485-1487 自述逐 miss 归因的 in-loop 发射未实现（归因 Unknown，见 F9-07）；core_run_commands.rs:853 处为 T-29 保真水合（`cached_history_to_conversation`），非缓存 stub——任务所指「T-40 stub」已在 R5-D3 轮末合并兑现，无残留 stub。 |
| F9-21 | `crates/session-loop/src/loop/end.rs:121`（finish 收口）；`crates/conex-db/src/migrate.rs:399-421`（v5 纯 ADD COLUMN + col-check 幂等） | P3     | **v5 迁移兼容性良好**（幂等、旧行补 0、usage_json 可空、表缺失守卫 v6），唯一边界见 F9-10（warm_until 回绕）；`hit_ratio/write_ratio 不落库、读回 None 由前端重算`（runs.rs:279-281）与 F9-09 前端重算口径叠加为已知分叉源。                                                                                                                                                        |

### E. 测试盲区

| #     | 缺失测试                                                                                                                                                                                            | 对应缺陷 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F9-T1 | 命令替换/反引号/`iex`/`Invoke-Expression`/`Start-Process`/`powershell -EncodedCommand` 包裹形态的红线拦截测试（现仅覆盖 eval/bash -c/&& 链/大小写/路径前缀/`--`，conex-sandbox/src/lib.rs:234-317） | F9-01    |
| F9-T2 | resolve() 在 pending 注册前到达的 TOCTOU 测试（MockGate + 即时裁决）                                                                                                                                | F9-03    |
| F9-T3 | 同 call_id 二次审批（批级 + 工具内）语义测试（现有 `requires_approval_approved_then_retries_execution` 为单次审批+重试路径，tool_exec.rs:2497）                                                     | F9-02    |
| F9-T4 | Included 系 read > prompt 的 hitRatio>1 与前后端口径分叉测试（math.rs 有钳 0 测试但无比率断言；cacheMetricsCompute 无异常输入用例）                                                                 | F9-09    |
| F9-T5 | 跨 run 基线续接/冷缓存跨 run 归因测试（现仅 run 内，cache_tracker.rs:745-765）                                                                                                                      | F9-08    |
| F9-T6 | cache-waste-alert 归因到达事件的契约测试（engine.rs 有事件形状测试，但未断言「8 类归因应透出」——当前实现恒 Unknown，测试应钉住诚实兜底或推动实现）                                                  | F9-07    |

已确认无盲区的部分：v5 迁移链（conex-db tests.rs + fresh_db_full_chain）；usage_json 写入/回读/徽标回放（sessionRustDbCacheReplay.test.tsx 全链）；断点预算四象限与超限丢尾（cache.rs:978-1014）；缓存键 64 码点钳制中文/emoji 边界（cache.rs:917-933）；审批并行组事件顺序/拒绝跳过/abort 中断（tool_exec.rs:2303-2469）；权限三态全组合与红线先行（permission.rs:276-367）；C3 大面积回退三模式（permission.rs:459-517）。

---

## 二、严重度分布

| 级别 | 数量 | 编号                                                                                  |
| ---- | ---- | ------------------------------------------------------------------------------------- |
| P0   | 1    | F9-01（红线包裹绕过）                                                                 |
| P1   | 3    | F9-07（归因 Unknown 事件降级）、F9-14（ratchet 盲区）、F9-15（存量未清零+豁免面不符） |
| P2   | 8    | F9-02/03/04/05/08/09/16/17/18/20（其中 P2 9 项）                                      |
| P3   | 6    | F9-06/10/11/12/13/19                                                                  |

## 三、整改优先级建议

1. **立即（P0）**：F9-01 命令替换/脚本块包裹红线绕过——补 `$()`/反引号/iex 递归下沉 + 测试，改动集中在 conex-sandbox（纯函数层，风险低）。
2. **本轮（P1）**：F9-14 ratchet 实例级化 + F9-15 存量清零/豁免面修正（executor.rs 2 条 remove_dir_all）；F9-07 归因事件透出或文档降级。
3. **下轮（P2）**：F9-02 双审批去重、F9-03 注册顺序、F9-04 未知面积保守化、F9-05 死锁检测器接线（T-D-13）、F9-08 跨 run 基线（T-40 二期）、F9-09 hitRatio 钳制 + inputTotal 字段、F9-16/17/18 治理门禁接线与文档修正。

## 四、诚实边界声明

- F9-01 绕过链基于代码路径推演（normalize_command 不剥 `$(`、split_segments 不拆命令替换、正则被 `--` 阻断），未在真实 shell 执行验证（审计只读约束）；建议用新增单测落地验证。
- clippy/knip 实测为本机工具链（rustc/clippy 1.94.0、knip 6.32.0），CI（ubuntu-latest）数值可能微差，结论方向不受影响。
- 权限域其余路径（ApprovalGateImpl 同 id 覆盖、resolve 校验、子代理路由）均发现为防御性正确设计，未计入缺陷。
