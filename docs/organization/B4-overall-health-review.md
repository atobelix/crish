# B4 项目整体健康评审（cache 战役 R1-R6 + 治理轮 I0-I2）

> 评审性质：只读评审（未改动任何代码/文档；验证命令全部为只读执行）。
> 评审时点：2026-08-03 21:00（HEAD = `05458a54`，I3 轮提交在评审期间落地；R6 wave1/wave1b 已提交，I3 部分交付报告与 R6 T-48 前端文件仍在工作区未提交）。
> 评审范围：`git log -45` 窗口内全部提交（cache 战役 R1-R6 + 治理轮 I0-I2/I3 起步）+ 关键代码抽查 + 全量门禁实测。
> 证据约定：代码位置一律 `文件路径:行号`；门禁数字为本次实测值（与轮次报告交叉核对）。

---

## 一、提交全景（主题 | 提交数 | 代表 commit）

窗口：`846b1499`（docs 重组，Phase E 收尾）→ `2e1586ea`（R6 wave1b），评审期间追加 `05458a54`（I3）。共 46 个提交。

| 主题 | 提交数 | 代表 commit | 说明 |
|---|---|---|---|
| cache 战役代码（feat/chore(cache)） | 20 | `226fe69c`（R1 前缀稳定）、`ff544421`/`80b4fb11`（R2 注入框架/载体）、`656d67c6`（R3 行为矩阵）、`533f5d31`（R4 History/Compaction）、`7b2aa5a3`/`beae3f47`（R5 测量层/引擎接线）、`f5e959be`/`2e1586ea`（R6 前端 4D + 契约类型） | R1-R6 六轮全部落地，48 任务单元按方案执行 |
| cache 战役文档（方案/报告） | 8 | `d30fcf30`（方案系列）、`b49b3c1d`（方案定稿）、`7934c63a`（参考分析 4 份）、`6fd7c481`~`119e7ae7`（R1-R5 轮次报告） | 调研→方案→审计→轮次报告闭环；R6 报告尚未提交（在途） |
| 治理轮代码（I0-I3） | 6 | `f180a137`（I1 G1/G7/G5/S1）、`824db293`（I1 S2/S10a）、`be979a23`+`16618844`+`9f094bde`（I2 S3/S4/S5/S8）、`05458a54`（I3 S6/S7/S10b/S11/G13） | I3 提交在评审期间落地，报告未出 |
| 治理轮文档（I0-I2） | 3 | `326ad78f`（I0 基线）、`b3d01f9f`（I1 报告）、`5ce983a8`（I2 报告） | I0 含 4 份分片报告，质量高 |
| 修复（fix） | 2 | `5427149e`（EventRouter/审批链/插件测试）、`d82f7468`（send-chain 缺陷、eslint 251→0、legacy 测试 23→0） | 均为 Phase E 收尾修复 |
| Phase E 收尾/治理文档 | 7 | `846b1499`、`300f69cc`、`707f4f9f`、`e5a1dced`、`edbd8a39`、`84d80f16`、`9c5c075a` | docs 重组、R6 误删恢复、B1-B3 质量评审 |

结构特征：代码与报告严格成对提交（每轮 = 若干实现提交 + 1 份轮次报告），跨轮输入/输出可追溯（R2-D1..D6、R3-D1..D4 等裁决均有登记），是仓库历史上纪律最好的时期。

---

## 二、cache 战役评估（R1-R6）

### 2.1 设计评估 —— 优（证据驱动、真源纪律、保守默认）

**设计流程**是本战役最大亮点：10 份参考软件调研（`docs/cache-optimization/01-reference-research/`，pi/opencode/jcode/kimi/codex/claude-code/deepseek-reasonix/litellm 等）→ 16 维对比（`02-comparison/comparison.md`）→ P1-P6 六份方案 → A1/A2/A3 三份交叉审计（`04-audits/`，40 项证据抽查 36 项属实）→ 48 个任务单元（`90-final-multi-agent-repair-plan.md`）→ R0-R7 轮次编排。每个机制决策都能追溯到参考实现的 `文件:行号`（如断点 4 上限 → opencode anthropic-messages.ts:511-514；噪声地板 1024 → pi cache-stats.ts:11；断裂判定 >5% 且 >2000 → claude-code-cache-analysis.md:395-410）。

**契约真源纪律（C1-C9）落地扎实**，抽查确认：
- C2 唯一运行时入口：`build_cache_policy`（`crates/agent-provider/src/request/cache.rs:266`），engine.rs 只调此函数（`apps/agent-workbench/src-tauri/src/engine.rs:298`），R3 T-24.5 已用真实 ModelCatalog + `cache_behavior_for` 替换 PlaceholderCatalog，DeepSeek omit 由矩阵唯一驱动；
- C4 键实现唯一：`CacheKey::from_session_id` 码点钳 64（cache.rs:77），P3 `derive_prompt_cache_key` 只做等价委托（`models/cache_key.rs:24`，测试钉死逐字节一致）；
- C6 事件四件套：`RunCacheStats` + `CacheDomainEvent` 三变体登记，`events_schema_version.rs` 断言 28 事件 + v1 fixture 三件套（`crates/conex-types/tests/events_schema_version.rs:49-53`）；
- C9 恒等式 `inputTotal = miss + read + write` 贯穿 Rust 解析链（`parse/chat.rs` hit 链三别名）、`CacheBreakdownMath`（`crates/conex-telemetry/src/cache/math.rs`）、TS `runStatsToCacheMetrics`（`apps/crish-desktop/src/api/chat-bridge/handlers/cacheEventsStore.ts:72`）、shared-types 契约（`packages/shared-types/src/cache-metrics.ts:10`）。

**保守默认与反过度设计一致**：未识别厂商（Auto）不注入任何缓存字段；GLM 未实测 → 保守关（behavior.rs:20 注释）；TTL 1h 写价 2x 宁缺毋滥（`ttl_for_retention`，cache.rs:445）；DeepSeek 整个 cache 参数组不出现（cache.rs:263）。对照 `docs/archive/legacy/ANTI_OVERENGINEERING_GUARDRAILS.md` 十项禁令：无 OS 级沙盒、无模型自动切换、无熔断器、无 ring buffer —— 未违反任何禁令；语义分析层取代"正则 11 条红线"恰是禁令 1 允许范围（指令级拦截）的升级而非扩张。

**VendorId 覆盖矩阵合理**：11 厂商键（`models/behavior.rs:28-44`），kimi-k3/glm-4.7 等 R0.5 时代审计缺口显式收录；catalog.json 28 条 + 多级兜底 lookup（`models/catalog.rs`）+ `cache_behavior_for` 三级覆盖（catalog > 系列 > vendor 默认，behavior.rs:12-13）。

### 2.2 实现质量抽查 —— 良（纯函数化、测试密度高；两处未接线面）

- `request/cache.rs` 1637 行全部纯数据结构/纯函数（无 HTTP/IO），`allocate_breakpoints` 分层分配 + 超限丢尾不报错，`apply_cache_controls`/`text_to_parts_with_cc` wire 施加路径齐备，25+ 单测；
- `to_cache_aware_tool` 字节级验证（`request/tools.rs:261` 断言 None TTL 时与 `to_openai_tool` 逐字节一致 —— 满足"无缓存配置时请求字节与现状逐字节一致"的关键安全属性）；
- `CacheStatsTracker`（`crates/session-loop/src/cache_tracker.rs`）：FNV-1a 签名、TTL/模型切换/压缩作废基线语义、warm_until 锚定 completed_at_ms（R5-D2 主 Agent 修正过实现语义）、~28 单测；
- `MissDetector`/`classify` 8 类归因 + 阈值常量单一真源（`crates/conex-telemetry/src/cache/miss.rs:16-28`），is_break 除零保护；
- v5 迁移克制：仅 ADD COLUMN（runs.usage + session_messages.usage_json，`crates/conex-db/src/migrate.rs:350-369`），无 DROP 备份负担，v4 fixture 保数据测试；
- 前端 4D 数据流闭环：事件 → `cacheEventsStore`（zustand，跨 run 累计 + 预警 3 条去重 + 冷缓存每 run 一次）→ `SessionCacheStatsPanel`/`CacheMetricsBadge`，null 语义全链路（C15：无数据隐藏而非显示 0%）；
- 成本估算链真实存在：`estimateCostUsd4d`/`estimateSavingsUsd`（`apps/crish-desktop/src/api/pricingStore.ts:257,307`）+ useStreamCallbacks 挂载（含 savedCost 语义）。

**未接线面（诚实登记，但确实未闭）**：
1. **T-40 core_run_commands merge 仍推迟**：`core_run_commands.rs:853` 的 `run_usage` 仍是 `_run_id` 返回 None 的 stub；conex-db `save_run_usage` 写入面无生产调用者。R5-D3 声明"待 I2 阵营收敛后一次合并"，R6 wave1/wave1b 未执行。当前 4D 数据流靠事件通道（CacheStatsUpdated）闭合，落库链路未闭。
2. **会话亲和 header 双实现未合一**：P2 侧 `affinity_header` 恒返回 None（`request/cache.rs:469-474`，build_cache_policy 消费它），P3 侧 `session_affinity_headers` 有真实数据表（Grok/Dashscope，`models/cache_key.rs:41-67`）但无消费点。A1 审计已注明"取一实现"，至今未裁决执行。能力表声称的 `supports_conv_header` 在运行时实际从不发送。

### 2.3 测试覆盖 —— 优（Rust 侧）/ 良（TS 侧）

- **实测**：`cargo test --workspace` 75 套件 0 失败；agent-provider 474 用例；telemetry 70；conex-db 52；session-loop 217+；sandbox 40。与 R2 报告"75 套件"一致，与 R3 报告"474 agent-provider"一致。
- DeepSeek 不变量测试钉死（`request/deepseek_invariants.rs`）：无 cache_control 键 / reasoning_content 必带 / 矩阵联动，git grep 越界审计通过（257 行全在框架/矩阵/测试）。
- TS 侧 rust-parity：`packages/shared-utils/src/cache/cache-rules.test.ts` 554 行对照样例 + cargo 侧 34 样例，双侧字节一致性有钉死手段；前端 cache 组件/事件 store 测试 21/21（本次实测）。
- 事件 schema 双护栏（registry 断言 + fixture roundtrip）防漂移。

**测试问题（详见第五节）**：R6 新增 `messageHandlers.cache.test.ts` 在全量下 flaky（隔离 16/16、全量 1 失败），属测试隔离性缺陷。

### 2.4 过度工程风险评估 —— 总体克制，3 项需盯防

| 风险点 | 判定 | 建议 |
|---|---|---|
| 会话亲和 header 双实现（P2 stub + P3 有数据无消费） | **中**：能力表与数据存在但运行时恒不注入，若长期不接线将沦为死代码 | R7 收尾时二选一：接线 `session_affinity_headers` 到 build_request 头合并，或删除 P2 stub 并登记"本期不注入" |
| `EngineProviderConfig.extra` 恒空表 overrides 通道（R2-D5 已声明预留） | 低：已声明、有入口判定（enabled/retention overrides 有测试） | 保持声明状态，I4 轮前若不接线则注释加"过期时间点" |
| CacheStatsTracker 签名哈希体系复杂度 | 低：被归因 8 类测试钉死，且是诊断价值核心 | 接受 |
| catalog 28 条 + 多级兜底 + upsert_from_scan | 低：有真实消费链（build_cache_policy/context_window/supports_responses_for） | 接受 |

对照反过度设计红线：**未违反**；战役内多处主动收敛（run 级兜底归因、Unknown 诚实兜底、merge 推迟）反而是反过度设计的好样板。

---

## 三、治理轮评估（I0/I1/I2，逐项）

### 3.1 I0（基线复核）—— 优

4 个只读分片全部完成：10 项门禁快照（7 全绿 + depcruise 存量 18 + knip/cargo 两失败并**正确定位为并行缓存域在途**，`I0-01` 报告 2.2 有 E0063 三处逐行证据）；L1 前端 4 文件 23 用例核销（当时 16/16 全绿）；行号校正 14 处（`I0-03` 报告 B.3 表）；40 条借鉴点映射确认（35 直接 + 2 部分 + 3 缺口，`I0-04`）。**亮点**：跨域归属判定全部带时间线证据（12:32-12:35 采样 + 提交号），不把并行域失败误判为本域。**存疑**：`I0-01` 声称 sessionRustDbWriteModel 16/16 全绿，本次实测 app-dir 模式下该文件 1 项确定性失败（见第五节）——说明该测试对运行环境敏感，I0 时点在 root 模式（node env）下为绿，两种模式结果分叉自那时起就存在，只是当时未暴露为门禁口径问题。

### 3.2 I1（治理 ratchet + 安全语义底座）—— 优，1 项模式风险

- **G1 clippy ratchet**：`scripts/check-clippy-baseline.mjs` 实测存在，读取 T13 BASELINE_LIST 标记区、新增告警 exit 1、--update 刷新；清理 daemon_discovery 30 条僵尸条目（190→165）。**有效机制**：它把"告警只降不升"变成了 CI 硬门禁。
- **G7/G5**：clippy `--all-targets` 唯一调用点、machete 0.9.2 接入删 13 处未用依赖。**教训登记诚实**：G5 删 anyhow 时 S3 trash 尚未创建，I2-S5 接线时发现误删并恢复（I2 报告 N1）——并行轮次交接的典型反例，已登记为"依赖恢复"案例。
- **S1 命令语义分析层**（`crates/conex-sandbox/src/semantics.rs`，804 行，抽查确认）：复合拆段（&&/;/||/| 引号保护）、间接执行递归 13 类、字段级规范化（引号剥离/大小写折叠/-- 处理）、六类分类。30 测试含 `echo&&rm -rf /` 拆段、`sudo bash -c` 递归、`Remove-Item` DeleteShape、`rd /s /q C:\` 红线等对抗样例。
- **S2 redline-first gatekeeper**：`lib.rs:73-79` 先语义层 Redline 判定再正则，命中直接 Blocked（100% 拦截层），"任一段 Redline 整链 Blocked"。**S10a 红线不可豁免**：`permission.rs:96-121` `decide_with_redline` 在 FullAccess 下同样 Deny（测试 `redline_denied_in_full_access` 钉死）。
- **模式风险**：S1 子 Agent 三次空返回后由主 Agent 直接实现（I1 N1 登记）——"大任务先收窄范围"是正确修正，但主 Agent 亲自实现导致审计独立性下降，后续轮次宜保留评审分片。

### 3.3 I2（删除接管闭环 + clippy 清零第一波）—— 优

- **S3 TrashService**（`crates/conex-fs/src/trash.rs`，37KB）：app-trash 双模式、checksum 快照、restore/list/purge、原子移动、防穿越/防递归；delete_file/delete_dir 注册（8→10 工具，dangerous=true、backup 默认、.crish-trash 兜底）。I3 又扩展 289 行（EntryMode Trash/Snapshot），方向正确。
- **S4 delete-shape 重定向**：shell 工具拦截 DeleteShape → 重定向到 trash（entryId/impact/audit 输出）、glob/特殊路径拒绝、间接执行复合链识别（`has_indirect_delete` 防 `bash -c 'rm x'` 包裹绕过）；修 delete.rs tracing %display 冲突、TrashEntry id 序列化字段。
- **S5 trash 恢复入口**：trash_list/restore/purge tauri 命令 + 纯函数核心（trash_list_at 供测试）+ MockRuntime 类型不匹配修复。**I2 N3**：发现 core_run_commands.rs 既有 U+FFFD 注释损坏（历史遗留）——本次字节级复核该文件 FFFD 计数为 0（`[regex]::Matches` 实测），说明已清理或报告描述状态已变化，当前无编码问题。
- **S8 security-audit 事件**：第 28 种域事件（operation/targets/impact/decision/permissionMode/toolCallId）、`SecurityAuditSink` trait + Noop/Recording、发射点（delete redirected / shell redirected+blocked / 红线 blocked / trash restored+purged，`agent-tools/src/tools/delete.rs:445`、`shell.rs:1211`）+ 16 测试；registry_drift/schema_version/roundtrip 护栏同步更新（实测 28 事件断言存在）。
- **G11a**：78 条真死代码删除 + 17 allow+理由 + 24 cfg_attr + 4 跳过（core_run_commands 交接未成），165→63 raw。
- **遗留（诚实登记）**：引擎侧 audit sink 真接线（I3 承接）、trash 事件落库（I3 承接）、缓存域 4 条 clippy 漂移待 --update。

### 3.4 I3（评审期间落地，报告未出）

`05458a54` 已提交：S6 revert-approval 引擎级（RevertAssessor + gate_verdict 入 call_verdict）、S7 streak 窗口 600s、S10b BackupMiddleware、S11+G2 clippy.toml 5 项 disallowed-methods、**G13 depcruise 18→0**（0 规则放宽）。与 cache 域的交叉冲突已在测试层显现（见 5.2）。

### 3.5 轮次报告质量 —— 优

R1-R5（cache）+ I0-I2（治理）共 8 份轮次报告结构统一（元信息/已完成表/门禁结果/裁决表/下轮输入），裁决全部带证据与时间线（R3-D3 的"14:22 提交 → 13:30 门禁绿"归因是报告质量标杆）；问题分类清晰（域内/外部/并行域/环境）。**缺口**：cache R6 报告未提交（在途）。

---

## 四、当前项目健康度结论

| 维度 | 评级 | 得分 | 理由 |
|---|---|---|---|
| 架构 | **A-** | 8.5/10 | 缓存六层（wire/model/history/measurement/TS 同步/引擎）分层清晰，C1-C9 真源纪律全链落地，保守默认与反过度设计一致；扣分：亲和 header 双实现未合一、T-40 接线推迟造成两处"声明未接线"面 |
| 代码质量 | **B+** | 8.0/10 | clippy ratchet 硬门禁生效（165→63）、dead_code 清零推进、Rust 侧纯函数化与注释规范高；扣分：前端测试基建问题（3 处）、消息级 flaky、`CacheMetricsBadge` 面板 UI 含 emoji（`SessionCacheStatsPanel.tsx:62`，违反本项目不用 emoji 约定，属轻微） |
| 测试 | **B** | 7.5/10 | Rust 75 套件 0 失败、474+217+70+52 高密度且事件 registry 双护栏；前端门禁**双口径不一致**（root 模式 3159/3159 全绿 vs app-dir 全量 4165/4170，5 失败 3 文件全部是测试基建问题而非产品缺陷），门禁可信度受损 |
| 文档 | **A** | 9.0/10 | 全项目最强维度：10 调研 + 6 方案 + 3 审计 + 48 任务单元 + 8 轮次报告，证据链完整可复核；扣分：R6 cache 报告在途 |

**总评：A-/B+（≈8.2/10）**。项目处于健康上行期：两层战役（功能与治理）并行且纪律性显著强于历史（提交成对、裁决登记、门禁归因）；主要风险集中在"测试门禁口径"与"未接线面"两类问题上，均非架构级问题。

**与 Phase E 遗留的关系**：前端基线失败集已清零（I0 核销 23 用例，`I0-01` 报告第三节有逐文件证据）；T09.4/T09.5（PE-09 性能项：DB append 命令接线、分页下推）**仍未闭合**（`30-phase-e-master-execution.md:329-330` 登记，34 收尾清单无核销），本轮战役未触碰。

---

## 五、风险与遗留（按优先级）

### 5.1 前端测试门禁双口径不一致（高优先）

**实测数据**：
- root 模式 `npm run test:desktop-helpers`：162 文件 / 3159 用例全绿；
- app-dir 模式 `npx vitest run src`：265 文件 / 4170 用例，**5 失败 × 3 文件**，全部为测试基建问题：
  1. `Menu.lowViewport.test.tsx` ×2：`readCssText` 用相对路径 `apps/crish-desktop/src/...` 拼 CWD（`Menu.lowViewport.test.tsx:41`），app-dir 下产生 `apps/crish-desktop\apps\crish-desktop\...` 双前缀 ENOENT —— **CWD 敏感测试 bug**（I1 G15a 交付，当时从 root 跑通过）；
  2. `sessionRustDbWriteModel.test.ts` ×1（"快速连续 commit"）：app-dir（jsdom）下 `save_session_body` 只记录 1 次调用（期望 2），root（node + retry 2）下 2 次 —— **环境敏感**，确定性失败，非 flaky；
  3. `messageHandlers.cache.test.ts` ×1（T-48 Excluded 形态）：**全量下 flaky**，隔离/配对跑 16/16 通过，I3 改动 messageHandlers.ts 后出现。
- 附带发现：app-dir 模式 `coverage.enabled=true`（70/60/65/70 阈值）使任何 scoped 运行必失败于覆盖率（本次实测），轮次报告实际采用 root 模式规避 —— 门禁脚本与报告口径需要统一。

**建议**：I3/I4 轮把"唯一门禁口径"定为可执行检查项（明确以 root `npx vitest run` 为 CI 口径或修复 app-dir 3 文件），并修复 CWD 拼接与 mock 隔离。

### 5.2 跨阵营文件域冲突已两次实证（中优先）

R3-D3（I1 redline 语义变更打破 workbench 2 项测试，当时正确归因修复）→ 本次 I3 改 messageHandlers.ts 又触发 cache 域 T-48 测试全量 flaky。**文件域互斥表需要更细粒度**（组件级而非文件级），且 flaky 测试需在 I3 报告登记归因。

### 5.3 cache 战役收尾事项（中优先）

1. **R6 报告未提交**；R6 wave1b 后工作区仍有 R6 未提交文件（CacheMetricsBadge.test/SessionCacheStatsPanel.test/cacheEventsStore 等，未跟踪）；
2. **T-40 core_run_commands 合并**（run_usage 真实现 + save_run_usage 落库）——R5-D3 声明的精确接线清单仍未执行，run_usage 命令面仍是 stub（`core_run_commands.rs:853`）；
3. 会话亲和 header 双实现合一（P2 stub vs P3 数据表）；
4. 缓存域 4 条 clippy 漂移需 `--update`（I2 N2 登记）；
5. R5-D4/R5-D5 演进项（跨 run 签名基线流出、streaming.rs 逐 miss 归因）——可选。

### 5.4 治理遗留（登记在案）

- I2 L1/L2（audit sink 引擎侧接线、trash 事件落库）→ I3 承接，状态待核销；
- I1 N3 12 套菜单测试环境头 → I3；
- I3 起步已见 S6/S7/S10b/S11 落地，depcruise 18→0（0 放宽）值得在 I3 报告中单独核销；
- clippy 63 raw 基线 → G11b/G11c 第二波清零；knip 637/435 → I3 收紧 error 级。

### 5.5 过程风险（低优先）

- 工作区长期存在大量并行在途改动（本次采样 84 项），曾发生误删事件（`edbd8a39` 从 stash 恢复）——提交纪律（`84d80f16` 的备份保护规则）需持续执行；
- R6 wave1/wave1b 提交规模偏大（wave1 单提交 17 文件 +2317 行），后续宜拆波；
- 编码方面：本轮字节级抽查 `migrate.rs`/`core_run_commands.rs` FFFD 计数为 0，未发现现行编码问题（R5-D1 事故已修复并被 chinese-encoding-guard 技能覆盖）。

---

## 六、附：本次评审实测门禁

| 门禁 | 实测结果 | 与报告一致性 |
|---|---|---|
| `cargo test --workspace` | 75 套件 0 失败 | 与 R2/R3 报告一致 |
| `npx tsc -b`（app-dir） | exit 0 | 一致 |
| `npm run test:desktop-helpers`（root） | 162 文件 / 3159 通过 | 与 I0 的 160/3075 相比略增（新增测试文件） |
| `npx vitest run src`（app-dir 全量） | 4165/4170，5 失败 ×3 文件 | **与轮次报告口径不一致（报告未跑此口径或未报此失败）** |
| cache 前端测试（隔离） | CacheMetricsBadge/SessionCacheStatsPanel/cacheEventsStore 21/21 | 一致 |
| 事件 registry | 28 事件断言 + fixture | 与 I2 S8 一致 |
| clippy ratchet 脚本 / clippy.toml | 存在 | 与 I1/I3 一致 |
