# 数据/迁移层运行时稳定性分析（01）

> 深度分析子 Agent 产出（只读 + 本文档；未修改任何代码）。
> 分析日期：2026-08-09。实证方式：实读代码 + 临时探针工程（`%TEMP%/opencode/probe-migrate`，验证 5 种真实/潜在库形态的打开与读写行为，探针结论已在正文标注「探针实测」）。
> 范围：`crates/conex-db` 迁移链（v1→v7）、`apps/agent-workbench/src-tauri/src/main.rs` 降级路径、`StatusDiagnostics` 可观测面、`crates/conex-db/tests/*` fixture 矩阵。
> 姊妹文档：`03-boot-noise-logging-governance.md`（同一事故的另一视角：日志噪音治理；其中记录 06/07/08 三天 21/25 次启动 DB 打开失败）。

---

## ① 现状盘点

### 1.1 迁移链（crates/conex-db/src/migrate.rs）

| 机制 | 位置 | 现状 |
|---|---|---|
| 版本权威源 | `migrate.rs:110-112` | `PRAGMA user_version` 单源；`LATEST_VERSION=7`（lib.rs:56） |
| 已是目标版本 | `migrate.rs:114-120` | 幂等兜底：ensure v5 结构 + 登记 schema_version |
| 全新库 | `migrate.rs:132-137` | 建 v1 形态（schema.rs:6-107）+ 置 user_version=1 |
| 逐版本事务 | `migrate.rs:172-200` | 每版本独立事务；user_version 移入事务内（T3.1 D1，`migrate.rs:197`），消除「结构已变、版本未变」的死态 |
| v1→v2 | `migrate.rs:229-251` | sessions 补 9 列，**col-check 幂等**（对 `PRAGMA table_info` 判定） |
| v2→v3 | `migrate.rs:254-283` | session_agent_messages 重建补 CHECK，**无条件 RENAME/INSERT/SELECT** |
| v3→v4 | `migrate.rs:288-442` | events 重建（组合主键+FK）、metadata 删除、runs/pending 加 FK（孤儿过滤）、updated_at col-check（397-405）、session_sequence 按源列名判定重建（406-440） |
| v4→v5 | `migrate.rs:461-483` | runs 补 9 usage 列 + session_messages.usage_json，col-check 幂等 |
| v5→v6 | `migrate.rs:499-522` | session_agents 补 3 列，col-check；**表缺失守卫**（500-507：缺表跳过） |
| v6→v7 | `migrate.rs:535-563` | compression_blocks 新建，`IF NOT EXISTS` 天然幂等 |
| 迁移后 ensure | `migrate.rs:203-206` | create_v5_schema 全量 IF NOT EXISTS 补触发器/索引 |
| 备份时序 | `migrate.rs:148-171` | 每版本事务 commit 前「checkpoint(TRUNCATE) → 整库拷贝 .bak-v{n}」；v5..v7（纯加列/建表）**硬编码跳过**（`migrate.rs:157`） |
| 备份轮转 | `migrate.rs:49-67` | 只保留最近 BACKUP_KEEP=2 份（lib.rs:64） |
| 备份失败 | `migrate.rs:75-90` | 告警不阻断迁移（2026-08-06 裁定案），落 session_meta `migration_backup_failed` |

### 1.2 事故修复现状（2026-08-08 runs 缺表）

- 修复点：`migrate.rs:289-326`——v3→v4 前先探测 `runs`/`pending_inputs` 缺失则按 v3 老 DDL 补建（无 FK 形态），再走重建逻辑。
- 回归测试：`migrations.rs:704-735`（`legacy_v3_without_runs_tables_upgrades_and_preserves_data`，fixture 于 `migrations.rs:475-573`）。
- 未提交状态：git status 显示 `crates/conex-db/src/migrate.rs`、`tests/migrations.rs` 为工作区修改（与 03 文档「已修未提交」一致）。

### 1.3 降级路径（apps/agent-workbench/src-tauri/src/main.rs:224-254）

- `open_session_db`：文件库 `LocalDb::open` 失败 → `tracing::error!`（241-245）+ `diagnostics.record("db", false, Some(...))`（246）→ `open_in_memory`（247-248）→ `set_ready(false)`（250）。
- 可观测链：`SharedDb::db_ready()`（session_commands.rs:55-58）= ready 原子位 && failure latch 为空；`core_get_status` 组装 `db_ready`（core_query_commands.rs:295）；诊断条目（环形 20 条）经 `diagnostics` 字段透传（status_diagnostics.rs:111-124、core_query_commands.rs:303）。
- 前端：`StatusDiagnosticsPanel.tsx:208` 渲染「会话数据库」就绪徽标（data-testid `diag-dbReady`），测试覆盖（StatusDiagnosticsPanel.test.tsx:46）。**但该组件在整个前端无任何挂载点**（全仓 grep 无 import）——是死组件（同列 Settings 目录下其余面板均被 SettingsPanel 挂载，唯独它没有）。
- 传输层：`tauriTransport.ts:222`——engineReady/dbReady **任一为 true** 即判定 connected，db_ready=false 不阻断启动与命令调用。
- 命令层：`db_ready` 仅被 `core_get_status` 消费；session 族 14 条命令、engine run 路径均**无 db_ready 门禁**（grep 全 src-tauri 确认）。
- machine-readable 诊断文件：**不存在**（全仓 grep `db-failure.json` / `db_failure` 无果）；现有落盘物 = workbench*.log（telemetry 文件层）+ panic 崩溃文件（main.rs:269-270），均非结构化 JSON。

### 1.4 测试现状（crates/conex-db/tests/）

| 文件 | 覆盖 |
|---|---|
| migrations.rs | v1/v2/v3/v5 fixture 升级、legacy_v3 无 runs（事故回归）、v0=全 v3 形状+uv0、v4 崩溃中间态自愈（1191-1241）、二次 open 幂等、备份黄金字节（918-944）、备份含未 checkpoint WAL 数据（952-987）、备份 user_version=N-1（991-1017）、备份失败告警不阻断（1022-1043） |
| upgrade_e2e.rs | v3→v4 公开 API 全链路（302/349）、二次 open（423）、备份内容（449）、迁移后 import（474） |
| blocks.rs | 缺表降级（520-536，`missing_table_degrades_to_empty_ok_without_latch`） |
| orphan_grace_contract.rs / stress_write.rs | 孤儿宽限期契约 / 并发写压力 |

### 1.5 探针实测结论（本次分析临时构建验证，非仓库代码）

| 探针 | 形态 | 结果 |
|---|---|---|
| FRESH 文件库 | 空库 | open OK，user_version=7，sessions 含 folder（v1→v2 实际执行——loop 起点 `start_version+1=2` 含 v2 步，此前「v1→v2 被跳过」的推断错误） |
| V0-EARLY | **uv=0 + 早期 v1 形态**（sessions 无 folder、无 runs/pending_inputs/session_sequence、无 metadata） | **open OK**，list_sessions OK，upsert OK（v2 col-check + v3→v4 缺表补建覆盖） |
| V6-NO-TABLE | uv=6 + 空库 | open OK，user_version 收敛 7，list OK（v7 步 + ensure 兜底） |
| V3-NO-EVENTS | uv=3 + **缺 events 表**（其余 v3 全形态） | **open FAIL**：`kind=Migration`，`migrate_v4 failed: no such table: events` ← 与 runs 事故同 class 的活雷 |
| PROBE4 | 全新 v7 库 | reserve_sequence OK；append_event 对不存在会话失败（FK 正常语义） |

---

## ② 脆弱点清单（潜在雷）

「无条件引用某表/列」扫描结果：v3→v4 的 `runs`/`pending_inputs`/`session_sequence` 已守卫（事故后修复），`session_agents` 在 v5→v6 已守卫（500-507），`compression_blocks` 运行时已降级守卫（blocks.rs:104-137）。**其余步骤仍存在无条件引用**：

| # | 位置 | 场景（形态） | 后果 | 等级 |
|---|---|---|---|---|
| W1 | migrate.rs:328-361（v3→v4：孤儿计数 328-342 + events 重建 347-361） | v3/v2 形态**缺 events 表**（探针 V3-NO-EVENTS 实测崩溃） | `no such table: events` → 迁移失败 → LocalDb::open Err → main.rs 降级内存库 → **会话不可见**（runs 事故同 class，P0 事故复现条件仍在） | **P1** |
| W2 | migrate.rs:402-405（v3→v4：session_messages 加 updated_at） | v3 形态缺 session_messages 表（PRAGMA table_info 对缺表返回空 → col-check 通过 → ALTER 崩溃） | `no such table: session_messages` → 同 W1 | P2 |
| W3 | migrate.rs:254-283（v2→v3：session_agent_messages 无条件 RENAME/INSERT/SELECT） | v2/uv0 形态缺该表 | `no such table: session_agent_messages` → 同 W1 | P2 |
| W4 | migrate.rs:229-251（v1→v2：只对 sessions **列**做 col-check，无**表**存在守卫） | uv=1 但 sessions 表缺失（异常/手工库） | `no such table: sessions` | P3 |
| W5 | migrate.rs:461-483（v4→v5：runs/session_messages 同理只守卫列不守卫表） | v4 形态缺 runs/session_messages | ALTER 崩溃 → 同 W1 | P2 |
| W6 | main.rs:247-251（降级语义） | 任何迁移/打开失败 | 内存库 + db_ready=false；**前端无展示**（StatusDiagnosticsPanel 死组件）、命令无门禁、写命令静默写入内存 → 用户无感 → 退出即丢；runs 事故「2 天不可见」正是靠此路径沉默存在 | **P1** |
| W7 | main.rs:236-253 + 无单实例插件 | 两个应用实例同时打开同一 sessions.db | 第二个实例迁移/写竞争（busy_timeout 5s 后 latch）→ 静默降级 | P2 |
| W8 | migrate.rs:49-67（备份轮转 lexicographic sort） | 版本号达到 10+ 后 | `PathBuf::sort()` 按字符串序：`.bak-v10` 排在 `.bak-v2` 之前 → 轮转删除错误的最旧文件 | P3 |
| W9 | migrate.rs:45-47（fs::copy 部分写入） | 磁盘满/中断，拷贝中途失败 | 残留**半份** `.bak-v{n}`，内容为迁移中间态，与合法备份无法区分；用户手工恢复时踩坑 | P3 |
| W10 | migrate.rs:157（备份跳过区间硬编码 `!(5..=7)`） | 新增 v8/v9 版本时 | 若 v8 含 DROP 而忘记扩区间 → 无备份直接 DROP → 数据不可恢复 | P3 |
| W11 | lib.rs:56-58（LATEST_VERSION 与 SCHEMA_VERSION_STRING 双常量手工同步） | 升级版本只改一个常量 | session_meta.schema_version 与 user_version 漂移；现有测试只断言等于 SCHEMA_VERSION_STRING 自身（migrations.rs:588-592），**无两者一致性断言** | P3 |
| W12 | events.rs:72-99（reserve_sequence 陈旧计数） | session_sequence 行存在但值 ≤ 库内 max(sequence)（v3→v4 重建只拷贝不校准，406-440；`INSERT OR IGNORE` 种子不覆盖既有行） | 取号碰撞 → append_event PK 冲突（events.rs:20-24）→ latch | P3 |
| W13 | sessions.rs:47-64 / 92-99（upsert/list 无条件引用 folder 等 12 列） | 若某路径产出「迁移成功但 sessions 缺 v2 列」的库（当前无此路径，列为防御性） | `no such column: folder` → 命令失败 | P3 |
| W14 | 开发库入库 | `apps/agent-workbench/sessions.db` 被 git 跟踪（当前 git status 显示 M） | 开发/真实会话数据随仓库流转；迁移噪音污染提交面 | P2 |

**等级统计：P0=0（无进行中事故）；P1=3（W1/W6/W7 中 W7 语义上归 P2，实际 P1 为 W1、W6 两项 + 降级数据静默丢失）；P2=5；P3=6。**

> 说明：W1 的「缺 events 表」虽非自然演化可达（v1 schema 自始含 events，见 schema.rs:17-25），但 runs 事故证明「与代码假设不同的历史形态」真实存在且代价高昂；守卫成本极低（与 303-326 同一模式），应顺手补齐。W2/W3/W5 同 class 一并建议。

---

## ③ fixture 矩阵建议（黄金库矩阵）

### 3.1 现有覆盖（migrations.rs）

- ✅ v1 全形态（**含** runs/pending，106-211）——注意：这与 schema.rs create_v1_schema 的 v1 定义（含 runs/pending，schema.rs:89-105）一致，但**不含**「更早的、无 runs 的 v1」；后者只在 v3 版本号下被覆盖（legacy fixture）
- ✅ v2（214-320）、v3 生产形态+孤儿（326-467）、v5（816-854）
- ✅ legacy v3 无 runs/pending/session_sequence（475-573，事故回归）
- ✅ v0 = 全 v3 形状 + uv0（577-581）
- ✅ v4 崩溃中间态 = 结构 v4 + uv3（1052-1183）
- ✅ 备份：内容黄金字节 / WAL 数据 / 版本绑定 / 失败告警 / 轮转上限
- ✅ blocks 缺表降级（blocks.rs 单测 520-536）

### 3.2 缺口与建议矩阵

| # | 建议形态 | 现实依据 | 断言要点 |
|---|---|---|---|
| G1 | legacy v1：早期形态无 runs/pending/session_sequence + **uv=1** | v1→v3 迁移不建这几张表（同 2026-08-08 机理，只是版本更旧） | open OK → v7；runs/pending 补建带 FK；sessions 全 v2 列；数据保留 |
| G2 | legacy v2：同上 + **uv=2** | 同上 | open OK → v7；agent_messages 重建保留 |
| G3 | v3 缺 events 表（探针 V3-NO-EVENTS，**当前崩溃**） | W1 的守卫落地前的红测试；落地后转绿 | open OK → v7；events 补建 v4 形态（组合主键+FK）；孤儿计数不崩 |
| G4 | v3 缺 session_messages 表 | W2 红测试 | open OK；session_messages 由 ensure 补建（v5 全列含 updated_at/usage_json） |
| G5 | v0 + 早期 v1 形态（无 folder 等） | 探针 V0-EARLY 已实测 OK，固化防回归 | open OK → v7；list/upsert OK；folder 由 v2 col-check 补上 |
| G6 | v5 崩溃中间态 = 结构 v5 + uv4 | 对齐 G8 的 T3.1 D1 逻辑 | 重跑自愈：v5/v6/v7 列在场、无 latch、二次 open 幂等 |
| G7 | v6 崩溃中间态 = 结构 v6 + uv5（含 compression_blocks 已在场） | 同上 | v7 步幂等跳过；块数据保留 |
| G8 | uv > LATEST（如 uv=8，未来版本库被旧代码读） | 代码分析：loop 空 → ensure v5 → OK（探针 V6-NO-TABLE 佐证空库路径） | open OK；结构不被破坏；schema_version 登记为旧串 |
| G9 | v7 库缺 compression_blocks（迁移级） | blocks.rs 单测已覆盖（520-536），建议升为迁移矩阵一员 | 读写降级 Ok 不 latch；缺表告警 |
| G10 | session_sequence 陈旧（next_sequence < max(events)+1） | W12 场景 | 首个 reserve_sequence 应返回 max+1（当前代码只对**缺行**自愈，陈旧行不校准——列出为已知边界，断言现状行为并决定是否修） |
| G11 | 只读目录 / 磁盘满注入 | W6/W9 场景 | LocalDb::open 返回 Err（而非半成功）；main.rs 降级路径 e2e：db_ready=false、diagnostics 含原因、前端可见（挂载后） |
| G12 | 备份目标同名目录/只读占用 | 已有 backup_failure_warns（1022-1043）覆盖告警路径 | 补充：轮转 `remove_file` 失败（防 449 行 `let _` 静默吞）的断言 |

---

## ④ 降级路径改进建议

1. **挂载 StatusDiagnosticsPanel（或最小替代）**：该组件已实现且有测试（StatusDiagnosticsPanel.test.tsx:37-114）但从未被任何页面 import——要么挂进 SettingsPanel（对齐其他 settings 面板），要么在侧栏/主界面加一个 db_ready=false 的常驻红色横幅。runs 事故的「2 天不可见」直接原因是**降级对用户零提示**。
2. **启动期醒目警告**：`waitUntilConnected`（tauriTransport.ts:222）用「任一 ready 即 connected」——应区分：engineReady=true 但 dbReady=false 时，连接后立即弹一次性警告（模态/横幅），文案带 diagnostics 中记录的失败原因（main.rs:246 已带完整 error 串）。
3. **写路径门禁**：降级内存库时，`save_session_body`/`upsert_session_entry`/`set_session_meta` 等写命令要么返回明确错误（`db_degraded_memory`），要么至少在前端提示「当前会话数据不会持久化」；现状是静默成功 → 用户以为已保存。
4. **machine-readable 诊断文件**：建议落 `app_dir/db-failure.json`（{ts, kind, message, path, schemaVersion, backups}），与 panic 崩溃文件（main.rs:269-270）并列；支持工具/工单可直接读取，替代翻日志。可复用 status_diagnostics 的 lastError 载荷形状（CrishErrorPayload）。
5. **修复自愈入口**：降级发生时，将文件库原样保留（现状即保留，未破坏）；建议提供「重试打开/重新迁移」命令（重新 LocalDb::open 文件路径），让用户在外部修复（如删除坏表/恢复备份）后一键重连，不必重启。
6. **记录降级次数与首次时间**：诊断条目会环形淘汰（20 条），建议 core_get_status 增加 `dbDegradedSince` 持久字段（AtomicSlot，main.rs 降级时 set）。

---

## ⑤ 数据完整性风险

1. **WAL 与备份时序**：备份前 `wal_checkpoint(TRUNCATE)`（migrate.rs:160）确保主文件=完整旧库；黄金字节测试（migrations.rs:918-944）与 WAL 数据测试（952-987）已锁定。风险点：checkpoint 失败按「备份失败告警不阻断」处理（160-166）——此时迁移继续且**无备份**。对含 DROP 的版本（v4），建议考虑升级为「告警 + 继续」但把 `migration_backup_failed` 键升级为前台可见（现状仅 session_meta + eprintln，用户不可见）。
2. **崩溃中间态幂等**：v3→v4 的 updated_at（397-405）与 session_sequence（406-440）已按 T3.1 D1 幂等化；user_version 移入事务（197）后崩溃只可能整体回滚。**剩余非幂等窗口**：W1/W2/W3/W5（缺表崩溃不可重跑——但重跑依然崩溃，性质为「不可开」而非「半迁移」，修复方向是补建守卫）。
3. **备份轮转**：BACKUP_KEEP=2。全链迁移产生 v2/v3/v4 三份 → 保留 v3/v4。评估：2 份够用（备份含敏感数据，不宜多留）；**但** v10+ 的字符串排序 bug（W8）需先修。建议 fs::copy 改「临时名 + rename」原子化（W9）。
4. **目录权限/磁盘满**：sessions.db 只读 → migrate 首个写步骤失败 → open Err → 降级（有诊断记录）；磁盘满 → 写失败 latch。两者均无数据损坏（SQLite 原子性），但会触发 W6 的静默降级——依赖 ④ 的改进落地。
5. **多实例**：无单实例插件；WAL 模式下第二实例会先成功打开再在迁移/写时冲突（busy_timeout 5000 后 latch）。建议加 tauri single-instance 插件或对 sessions.db 做进程级锁。
6. **sessions.db 入 git**：`apps/agent-workbench/sessions.db`（含 WAL/SHM/备份文件）被跟踪——开发态真实数据入库，既有隐私风险也造成迁移噪音；建议 .gitignore 排除（需确认产品路径下 app_dir 解析，host_paths.rs:6-12 开发时解析到仓库内 apps/agent-workbench/）。

---

## ⑥ 长期升级策略建议

1. **每版本成本盘点**（v8 起步）：新增 `migrate_v7_to_v8` 函数 + `migrate.rs:175-183` match 臂 + fixture + **备份跳过区间扩到 `!(5..=8)`（157 行硬编码，W10）**。建议把「该版本是否含 DROP 需备份」改为函数内声明（如 `fn requires_backup(version) -> bool` 查版本常量表），消除硬编码区间。
2. **双轨一致性**：`LATEST_VERSION`（u32）与 `SCHEMA_VERSION_STRING`（&str）手工同步（lib.rs:56-58）。建议：`SCHEMA_VERSION_STRING` 改为从 LATEST_VERSION 派生（const fn），或在测试中加断言 `LATEST_VERSION.to_string() == SCHEMA_VERSION_STRING`（现在没有任何测试绑定两者）。
3. **降级回滚（旧代码读新库/新代码读旧库）**：
   - 新代码读旧库：v6 缺 compression_blocks 已按「缺表降级」处理（blocks.rs:104-137），是本仓最优范例；建议抽为通用 `try_table` 辅助并推广到 W1-W5 的补建守卫（CREATE IF NOT EXISTS 优于降级，两者结合：守卫补建 + 运行时降级兜底）。
   - 旧代码读新库：uv > LATEST → loop 空 + ensure → 无害（探针佐证）；运行时查询全部显式列名，不会因新列崩溃——当前设计对回滚友好。
   - **其余缺表会崩吗**：运行时面（sessions/messages/agents/runs/events 的 30+ 处查询）全部依赖迁移收尾 ensure（migrate.rs:203-206）建齐的表——只要 open 成功，运行时无缺表风险；缺表崩溃全部集中在**迁移步骤内部**（W1-W5），这是唯一需要持续守卫的面。
4. **演进风格**：v4 的 events/metadata DROP 是迄今唯一破坏性迁移；后续演进建议「只加不删」（ADD COLUMN / CREATE TABLE IF NOT EXISTS，v5-v7 已验证该模式零备份零风险）。若必须 DROP：沿用 v4 模式（备份+事务+守卫+孤儿可观测键 `migration_v4_dropped_orphans`，migrate.rs:343-346）。
5. **矩阵化测试**：建议把 ③ 的 G1-G12 组织为「黄金库矩阵」单测套件（表驱动：fixture 构造器 × 断言函数），每加一版本跑全矩阵；新版本至少保证：fresh 链、uv=N-1 升级、uv=N 幂等、uv=N+1 降级四态。
6. **开发库隔离**：配合 ⑤-6，将开发期 app_dir 与真实用户数据分离（host_paths.rs 在 debug 构建下解析到仓库目录，属开发便利；建议 debug 构建默认启用，但明确 sessions.db 不进 git）。

---

## 附：证据索引（文件:行号）

- 迁移编排：crates/conex-db/src/migrate.rs:99-209；v3→v4 守卫：289-326；events 无条件引用：328-361；备份：36-90、148-171；ensure：203-206
- 版本常量：crates/conex-db/src/lib.rs:52-64；打开路径：69-98
- 目标 schema：crates/conex-db/src/schema.rs:121-266（compression_blocks 不在 v5 schema 内——由 v7 步骤建）
- 运行时查询面：sessions.rs:47-64,92-99；events.rs:20-24,72-99；blocks 缺表降级：blocks.rs:104-137
- 降级：apps/agent-workbench/src-tauri/src/main.rs:224-254；SharedDb：session_commands.rs:40-75；core_get_status：core_query_commands.rs:295
- 诊断：status_diagnostics.rs:21-151；前端面板（死组件）：StatusDiagnosticsPanel.tsx:110-294；传输层：tauriTransport.ts:222-256
- 测试：migrations.rs（fixture 106-581、断言 584-620、事故回归 704-735、崩溃中间态 1052-1241、备份 918-1043）；blocks.rs:520-536
- 探针工程（临时，不入库）：`%TEMP%/opencode/probe-migrate`（5 探针结论见 §1.5）
