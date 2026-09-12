# detail-D4D5 · 前端持久化单轨 + 驱逐与 FE hardCap · 分维详案

> **战役**：performance-fix  
> **主控定稿依据**：`92-修复总方案.md` §4 D4/D5、§5 依赖序、§6 删除面、§8 PR-LS-BODY、§9 详案模板  
> **交叉输入（只读）**：`independent-03`（D4/D5/D10/D11）、`independent-01`（T-L3-A/B、T-L5-A、DEL-5/6/7/15）、`review-plans-01`（CFL-02/CFL-08）、`review-plans-03`（A3/B1/B2/S3）、`90-发现清单索引`（08-H1…H6、08-M1/M5/M6/M8、01-M9）、08 报告 §3.2–3.4 / §4.3 / §6–§7  
> **创建**：2026-09-13  
> **性质**：执行详案（非总案）；评审通过后进入实现轮  
> **原则**：仅逻辑依赖序；删除是完成方式；**禁兼容读 / 禁双写 / 禁 git commit**  
> **明确不谈**：工期、人天、人员、业务优先级  

---

## 0. 决策锚点（主控已核实代码事实 · 与 92 F1 对齐）

| # | 事实 | 锚点 |
| - | ---- | ---- |
| A1 | `sessionStore` persist 仍 partialize 全量 `sessions`（含 messages） | `sessionStore.ts:64-69` |
| A2 | 设计内正文落盘 = `initStorePersistence` → 350ms debounce → `persistAllSessionsRust`；与 A1 双出口并存互不知情 | `store-persistence.ts:139-166`、08-H1 |
| A3 | boot 水合：索引 **LS 优先**（`crish_session_index_v1`）→ SQLite `list_sessions` 回退；`lsSaveSessionIndex` 注释自认「过渡期真相源」 | `sessionRustDbHydrate.ts:158-161,314-323`、`sessionRustDbFallback.ts:37-50` |
| A4 | invoke 失败 → `persistAllSessionsLocalFallback` / `loadSessionBody`→`lsLoadSessionBody`：body 的 LS 回退轨真实存在 | `sessionRustDbHydrate.ts:325-338,394-444`、`sessionRustDbSql.ts:105-106`、`review-plans-03` B2 |
| A5 | `persistAllSessionsSyncViaLocalStorage`（beforeunload）仍 `lsSaveSessionBody` 全量 messages | `sessionRustDbHydrate.ts:457-524`、`beforeunloadFlush.ts:89` |
| A6 | 客户端批次版本 + CAS 骨架已在 `saveSessionBody`；**Rust 侧 `batch_version` 真消费归 D3** | `sessionRustDbSql.ts:115-148`、92 §8 T1 |
| A7 | 全量重发：每 350ms 对**全部**会话 `normalizeAssistantTimeline` + 进 `bodyJobs`，无 dirty 集 | `sessionRustDbHydrate.ts:347-360`（DEL-7/15） |
| A8 | `setActiveSessionId` 只增焦点、**零驱逐**；`needsEngineMessageHydrate` 在 `hydratedFromEngine===true` 时恒 false | `sessionCrudActions.ts:96-149`、`sessionSharedHelpers.ts:48-54` |
| A9 | tool-end 写入：`sanitizeToolDisplayOutput` 后无字节 hardCap 即 `queueToolCallPatch` | `streamCallbacksEvents.ts:185-214`（08-H3） |
| A10 | 展示层 cap `TOOL_OUTPUT_LINE_CAP=2000` / `BYTE_CAP=256KB` 本地定义于组件；store 侧无同源截断 | `ToolCallOutput.tsx:9-10` |
| A11 | `MessageSnapshots.estimateBytes` 只计 delta/inserted 子集，**不计全量 `messages` 副本 retained** | `MessageSnapshots.ts:117-140,175-206`（08-H5） |
| A12 | 压力 level3 只清 idle queue +（部分路径）snapshots；**不驱会话 messages** | `entry-core.tsx:116-121`（08-H6） |
| A13 | `check-store-islands` 脚本**尚不存在**；与 OVL-24 约定随 persist 切除票落地 | `review-plans-01` OVL-24 |

**路径收敛骨架（任务书必答 N→M）**：见 §6。

---

## 1. 两票拆分（CFL-02 · 强制，禁止合并宣称完成）

> 92 §5 / CFL-02：persist 出口切除与 dirty+CAS **拆票**；票 A 可先/并行 D3；票 B 必须后于 D3。  
> **禁止**把票 A 宣称为「持久化已优化完成」（01 禁止反例 + 03 禁双写/兼容读同时生效）。

| 票 | 名称 | 内容 | 相对 D3（SQLite 写单轨） | 可宣称完成度 |
| -- | ---- | ---- | ------------------------ | ------------ |
| **票 A** | persist 出口切除 | ① partialize 物理删除 `sessions`（DEL-5）② 旧键一次 migration + **删读代码**（零兼容读）③ beforeunload 含 messages 镜像收敛/删除④ `check-store-islands` 门禁 | **可与 D3 并行**（甚至前置）：切除的是 LS 出口税，不依赖增量/CAS 语义 | 仅可宣称「LS 正文出口 1→0」；**禁止**宣称写单轨/增量完成 |
| **票 B** | dirty + CAS 真消费 | ① 前端 dirty 引用比较，仅 dirty 进 `bodyJobs`（DEL-7）② 仅 dirty 会话 normalize（DEL-15）③ `batch_version` 消费端闭环（Rust 增量 UPSERT+CAS **已由 D3 交付**） | **必须后于 D3**：无 DB 增量+CAS 时前端 dirty 只能减 IPC 次数，Rust 仍全量 DELETE+INSERT，收益假完成 | 「会话 body 增量写」整链完成（票 A+票 B+D3 会合） |

**票内禁止串味**：

- 票 A PR **不得**顺带实现 dirty 检测（否则与 D3 依赖序纠缠，并行切片失效）。
- 票 B PR **不得**再改 partialize / 再开旧键读（票 A 已收口）。
- 票 A 的负向断言（§7）独立可测，不等票 B。

**首轮并行切片映射（92 §10 U-PERSIST-CUT）**：U-PERSIST-CUT = **票 A 全集**（不含票 B、不含索引单源的 SQLite-only 翻转——后者见 §3.3，可紧随票 A 但不进 U-PERSIST-CUT 的 PR）。

---

## 2. D4 · 前端持久化单轨（做什么 / 删什么）

### 2.1 票 A · partialize 切除 + 旧键删除 + 无兼容读

#### 做什么

1. **`partialize` 物理收窄**（`sessionStore.ts:64-69`）  
   - 收窄为仅：`activeSessionId`、`folderOrder`、`composerDrafts`。  
   - **`sessions`、`sessionsById` 字段从 partialize 返回对象中物理删除**（非 `skipHydration`、非「写空数组」技巧）。  
   - `hydrationComplete` 不进 persist（会话内运行时标志，重启语义由 boot 水合链自建）。  
   - 键名 `crish_session_store` 可保留（壳体积骤减后是合法的轻量键），**或**改名为 `crish_session_meta_v1` 以利门禁识别——二选一在实现票内定，定后写进键注册表；**禁止**出现第二 persist 键。

2. **一次迁移（启动窗口，非兼容读）**——仅票 A 落地时执行一次，随后**删除迁移读代码**：  
   ```
   若 localStorage['crish_session_store'] 可解析且含 sessions[]：
     既有链路 ensureMigrated → hydrateSessionsFromRust（SQLite）已在同 boot 窗口接管正文；
     迁移职责 = localStorage.removeItem('crish_session_store')
                （或 rewrite 为仅 {activeSessionId,folderOrder,composerDrafts} 的壳后 removeItem 旧内容）；
     之后生产路径对该键 sessions 字段 **0 读 0 写**。
   ```  
   - **禁止**：`onRehydrateStorage` 从旧 sessions 重建消息；**禁止**「双写一段时间」；**禁止**保留 `getItem(键).sessions` 分支。  
   - 迁移完成判据：同 boot 内 SQLite hydrate 已 applied 或 fallback 空表合法；迁移失败（JSON 损坏）→ 直接 removeItem + `logInternalError`，不阻塞 boot。

3. **composerDrafts 清理对称**（08-M5 / independent-03 D4.3）：  
   - `deleteSession` 成功路径必须 `delete composerDrafts[id]`（`sessionCrudActions.ts` 删除分支）。  
   - drafts 继续可 persist（体量小、语义属「未发送草稿」而非会话正文）。

4. **beforeunload 同步镜像重审**（A5 / independent-03 删除面 #3）：  
   - `persistAllSessionsSyncViaLocalStorage` 若仍对非懒壳写 `SESSION_BODY_PREFIX` 全量 messages → **与票 A 冲突**。  
   - 裁决默认（无须 PR-LS-BODY，因这不是「命令缺失回退」而是主动同步镜像）：  
     - **首选**：beforeunload 同步路径**只写索引壳 / active_session_id / folder_order**，**删除** `lsSaveSessionBody` 调用与 body 孤儿清理分支；正文丢帧窗口由 350ms debounce + 异步 persist 承担（既有语义）。  
     - **否决选项**（须书面）：保留 body 同步镜像 = 恢复 LS body 第二写口，须主控明示并回写 92 附录 C 式留痕——默认不采纳。  
   - `installBeforeunloadFlush`（`beforeunloadFlush.ts`）调用点同步改为不传全量 sessions 的 meta-only 入口，或删除该调用（若 meta 已由 debounce 覆盖）。

5. **门禁随票 A 落地**：新建 `scripts/check-store-islands.mjs`（OVL-24 同票）：  
   - 静态：`sessionStore.ts` partialize AST 不得含 `sessions`/`sessionsById` 键；`src/` 业务代码不得 `setItem('crish_session_store'` 且 payload 含 sessions；不得存在对已删 sessions 字段的 `getItem` 读取模式。  
   - 接入 `npm run check:desktop`（或既有 check 聚合脚本）；先 fail（非 warn）——与 92 §6「门禁假路径」禁止项一致。  
   - 维护模式若担心并行文件噪声，实现 PR 内必须至少 fail-于本维文件。

#### 删什么（票 A）

| # | 删除/收敛项 | 位置（现锚） | 替代 | 类型 |
| - | ----------- | ------------ | ---- | ---- |
| A-1 | partialize 中的 `sessions` 字段 | `sessionStore.ts:65` | SQLite hydrate + 轻量 meta 壳 | 物理切除 |
| A-2 | 旧键 sessions 字段的启动 rehydrate / 兼容读分支 | zustand rehydrate 与任何 boot 旁路 | 一次 removeItem + 删读代码 | 物理切除 |
| A-3 | beforeunload 同步路径的 `lsSaveSessionBody` 全量 messages 镜像 | `sessionRustDbHydrate.ts:484-498`、`beforeunloadFlush.ts:89` | meta-only 或删除该写 | 收敛→壳或删 |
| A-4 | body 孤儿清理中「以 LS body 键为真相」的语义（beforeunload 分支） | 同文件孤儿清理循环 | 不再触碰 `SESSION_BODY_PREFIX`（同步路径） | 删除路径 |
| A-5 | `deleteSession` 不清 `composerDrafts` 的残留路径 | `sessionCrudActions.ts` 删除分支 | 成功路径必删 draft | 补对称后删残留语义 |

> 注：`SESSION_BODY_PREFIX` 系列 LS 键的**全部**物理清空与 `lsLoadSessionBody` 轨的存废 **不在票 A 默认范围**，归 §2.3 PR-LS-BODY 会签裁决（见下）。票 A 只保证：① zustand persist 出口不再写 sessions；② beforeunload 主动镜像不再写 messages；③ 无新兼容读。

#### 票 A 负向断言（必须进单测 + 门禁）

| ID | 断言 | 手段 |
| -- | ---- | ---- |
| NA-A1 | partialize 结果 `Object.keys` ∩ {`sessions`,`sessionsById`} = ∅ | 单测直接调 partialize（或导出测试钩子）+ AST 门禁 |
| NA-A2 | 生产代码对 `crish_session_store` 的读路径不访问 `.sessions` | `check-store-islands` |
| NA-A3 | 构造含 2MB 级 messages 的旧键 → boot 一次后键被移除/降为壳；**再次 set 任意非 sessions 字段不出现 >1MB `JSON.stringify` 热点** | 集成测试 +（实现轮）4000 MCP Performance 抽查 |
| NA-A4 | beforeunload 分支调用计数：`lsSaveSessionBody` = 0 | mock 计数单测 |
| NA-A5 | `deleteSession` 后 `composerDrafts` 无该 id | 单测 |
| NA-A6 | **无**任何新增 `localStorage.getItem` 返回值中的 sessions 回灌 `store.setState` | 代码评审项 + 门禁 grep 模式 |

#### 票 A 验收（功能 + 负出 + 五端摘要）

- **功能**：冷启动/刷新后侧栏列表与活跃会话正文完整（来源 = SQLite hydrate）；composer 草稿不丢；删除会话后草稿清除。  
- **负出**：NA-A1…A6 全绿；删除面表 A-1…A-5 勾选。  
- **五端**：触发 = 任意会话 set + 刷新；传输 = 无 LS 大键写 IPC 需求（本票不改 IPC）；介质 = LS 无 sessions/messages 正文；消费 = UI 全量来自 hydrate；负向 = check-store-islands + 单测。

---

### 2.2 票 B · dirty 集合 + batch_version 真消费闭环（后于 D3）

#### 前置（硬闸）

- **D3 已交付**：`save_session_body` 增量 UPSERT + Rust 侧 `batch_version` CAS 真消费（92 §8 T1「save 增量参数/batch_version 真消费」）。  
- 票 A 已合入（partialize 无 sessions），避免同一 `sessionRustDbHydrate.ts` 双票对改。  
- **禁止**：在 D3 未绿时合并票 B 并宣称「增量写完成」——前端只减 IPC 频度、Rust 仍全量重写 = 假完成（review-plans-01 CFL-02）。

#### 做什么

1. **dirty 引用比较**（`store-persistence.ts` 订阅回调或 `persistAllSessionsRust` 入口前）：  
   - 维护上一批 `Map<sessionId, messages | agents | 索引指纹>` 快照（引用级：`Object.is(messages)` 即可，因 immer 更新产生新引用；agents 同理）。  
   - 仅 `messages` 引用变更（或首写）的会话进入 `bodyJobs` 的 `saveSessionBody`；仅 `agents` 变更的只进 `saveSessionAgents`。  
   - `activeSessionId` / `folderOrder` 变更仍走 `setSessionMeta`（已有，不受 dirty 过滤影响）。  
   - **空列表护栏保留**：boot 窗口 / 全删场景继续遵守既有 P0-2 空 keep 守卫（`store-persistence.ts:150-152`、Rust `guard_cleanup_keep`），dirty 不得把「空列表」误判为「无需清理」而放开 orphan cleanup。  
2. **normalize 仅 dirty**（DEL-15）：`normalizeAssistantTimeline` 从「每批全量 map」改为「仅 dirty 会话 map」。  
3. **CAS 真消费对账**（与 D3 交界，前端侧义务）：  
   - 前端已有的 `writtenBodyVersion` 陈旧丢弃（`sessionRustDbSql.ts:129-140`）保留；  
   - 增加单测：乱序批次 v2→v1 到达时 v1 不覆盖；与 Rust 侧 CAS 联调用例（若 D3 已提供探针则引用，不重复实现）。  
4. **dirty 失败重试语义**：`saveSessionBody` invoke 失败时（票 B 语境下 LS body 回退若已被 PR-LS-BODY 删除）必须 `errorStore` 可感知（已有 `persist-degraded-ls` 数据面路径），**禁止**静默回写 LS；失败会话在下一批强制 dirty（清除已记「已落库版本」乐观标记或重置 dirty 基线），防丢写。

#### 删什么（票 B）

| # | 删除/收敛项 | 位置 | 类型 |
| - | ----------- | ---- | ---- |
| B-1 | 每批对全部会话的 `saveSessionBody` 循环体 | `sessionRustDbHydrate.ts:347-357` | dirty 2 号路径 |
| B-2 | 每批全量 `normalizeAssistantTimeline` | 同文件 map 表达式 | 仅 dirty |
| B-3 | （若 D3 交付后仍残留）Rust 侧 `batch_version` 忽略参数路径 | `conex-db` / `session_commands`（**文件域归 D3，本票只验不改**） | 验证性删除 |

#### 票 B 负向断言

| ID | 断言 | 手段 |
| -- | ---- | ---- |
| NB-B1 | 仅改会话 A 的 messages → 本批 `saveSessionBody` 调用次数 = 1（仅 A） | mock 计数单测 |
| NB-B2 | 仅改 `activeSessionId` → `saveSessionBody` 调用 = 0；`setSessionMeta` 调用 ≥1 | 单测 |
| NB-B3 | v1/v2 乱序：v1 不覆盖 v2 已写内容 | CAS 单测（与 D3 联调引用） |
| NB-B4 | dirty 失败后下一批该会话强制重发 | 单测 |
| NB-B5 | **全量重发路径 0 调用**（禁止保留「debug 全量开关」生产可达） | grep + 调用点审计 |

---

### 2.3 索引单源（CFL-08 · 归 D4，不归 D9/04 Layer7）

#### 现状

- 读序：`lsLoadSessionIndex()` 非空则用；空才 `listSessions()`（`sessionRustDbHydrate.ts:158-161`）。  
- 写：每次 `persistAllSessionsRust` 都 `lsSaveSessionIndex`（「过渡期真相源」自述）。  
- 01 T-L3-B / 06 S1：目标 = SQLite `list_sessions` 唯一；04 只防回潮；**文件域 `sessionRustDbHydrate` 不得被 D9 双开**。

#### 做什么（逻辑序：票 A 之后；可与票 B 并行若文件域由主控切开——默认同 `sessionRustDbHydrate.ts` 则**串行**）

1. 索引读序翻转：**删除 LS 优先分支**；boot 一律 `list_sessions`。  
2. 删除 `lsSaveSessionIndex` 生产调用（或降为 `__DEV__` 调试导出，不进 boot/persist 热路径）；`SESSION_INDEX_KEY` 注册表登记为「已废弃」，由 `sessionRustDbLegacyCleanup` 一次性清理（复用既有 legacy cleanup 机制，不发明第二清理器）。  
3. `importMeta` 仅存 LS 索引的字段（`sessionRustDbHydrate.ts:235-236`）——索引单源后须迁入 SQLite 列或 session_meta 映射（**T1 弱契约扩字段**，与 D3 list 分页扩字段同票窗口）；未迁完前禁止「删 LS 索引却丢 importMeta」的静默降级。  
4. 空壳剪枝兼容（keepIds 方案 A）行为保持；回归 03-I2/ACT-502 已修路径。

#### 删什么

| # | 删除项 | 位置 |
| - | ------ | ---- |
| I-1 | 「LS 索引优先、SQLite 回退」读序 | `sessionRustDbHydrate.ts:158-161` |
| I-2 | persist 热路径 `lsSaveSessionIndex` | 同文件 `:316-322`、beforeunload 分支 `:476-480` |
| I-3 | `listSessions` invoke 失败回退 `lsLoadSessionIndex`（`sessionRustDbSql.ts:85`）——改 errorStore 可感知失败 + 空列表，**不**再读 LS（若 PR-LS-BODY 将「索引元数据降级」划入保留面，则本项改写为「仅保留元数据-only 且有删除日期」——以会签纪要为准） | 同左 |

#### 负向断言（索引）

| ID | 断言 |
| -- | ---- |
| NI-1 | boot 路径 `lsLoadSessionIndex` 调用次数 = 0 |
| NI-2 | `check-store-islands` 扩展：`crish_session_index_v1` 无生产写路径（除非会签保留元数据-only） |
| NI-3 | 冷启动空 DB：侧栏空态正确；有 DB：排序/文件夹序与修复前一致 |

---

### 2.4 PR-LS-BODY 会签（LS 命令缺失 body 回退 · 产品语义）

> 92 §8 强制会签票 #4；评审 03 S3/B2：删除需 migration + 可观测，不宜无脑一刀 0。  
> **完成定义 = 有通过/否决纪要**（不是「实现完了」）。

#### 问题面（只列裁决所需，不预写实现）

当前 body/agents 在 **invoke 缺失或失败** 时的行为：

| 位置 | 现状 |
| ---- | ---- |
| `loadSessionBody` | 失败 → `lsLoadSessionBody`（静默 LS 正文读） |
| `loadSessionAgents` | 同构 LS 回退 |
| `listSessions` | 失败 → `lsLoadSessionIndex` |
| `persistAllSessionsRust` probe 失败 | → `persistAllSessionsLocalFallback`（LS 写 body/agents/meta + 清理） |
| `persistAllSessionsSyncViaLocalStorage` | 始终 LS（beforeunload；票 A 将砍 messages 写） |

#### 会签选项集（纪要必须三选一或带日期的变体）

| 选项 | 语义 | 对 D4 义务 |
| ---- | ---- | ---------- |
| **P1 · 删除** | 所有 body/agents/index 的 invoke-fail LS 回退删除；失败一律 errorStore + 空/错误态 | 票 A/B 后执行删轨 PR；`SESSION_BODY_PREFIX` 读写生产清零；legacy cleanup 清残留键 |
| **P2 · 元数据-only 保留** | 仅 index/meta 的 LS 降级保留（无 body 正文回退），**写明删除日期**进 92 | body 回退仍删；索引 §2.3 可暂留元数据降级；日期后门禁收紧 |
| **P3 · 全保留（否决切除）** | 维持双轨 | **须书面降级效果锁**（INV-4「废弃 LS 岛生产 0 读 0 写」破产）+ 附录 C 式留痕；主控默认不接受 |

**默认推荐（供评审，非终裁）**：P2——尊重「壳环境 invoke 不可用」的可感知降级（errorStore 已有），但 **body 正文回退必删**（与 independent-03「禁 LS 正文回退」、01「无日期 fallback 禁止」一致）；索引元数据降级若保留则设日期常量（进 D0 预算/期限表，非散落魔数）。

#### 会签时点

- **启动即开**（92 §8：完成定义=纪要）；**实现依赖纪要**。  
- 票 A **不**被会签阻塞（票 A 砍的是主动双写，不是 invoke-fail 回退）。  
- 索引单源 §2.3 的 I-3 与 body 删轨 **被会签阻塞**。

#### 会签负向断言（纪要落地后）

| ID | 断言 |
| -- | ---- |
| NL-1 | 若 P1/P2：`lsLoadSessionBody` 生产调用 = 0 |
| NL-2 | 若 P1/P2：`persistAllSessionsLocalFallback` 不存在或不含 body 写 |
| NL-3 | 若 P2：保留的元数据降级有删除日期常量；`check-store-islands` 认识该例外 |

---

## 3. D5 · 消息软驱逐 + Snapshots 记账 + FE hardCap

> 与 D4 **串行**（共享 `sessionStore` 写路径；先切除再驱逐，避免迁移窗口驱逐干扰——independent-03 §5）。  
> D5 不新建第二套水合协议：**驱逐 = 恢复既有 ACT-502 懒壳形状**，切回走既有懒水合。

### 3.1 消息软驱逐（08-H2 / 08-H4）

#### 做什么

1. **驱逐入口**：`setActiveSessionId` 在 id 真正变更时（既有 `!same` 分支扩展）：  
   - 计算 **previousActive** 与 LRU 尾：常驻已水合集合大小上限 `SESSION_HYDRATE_KEEP_K`（默认 3，**常量来自 D0 `perfBudgets.ts`**；D0 未合入前引用处集中一个本地 re-export，D0 合入后删除本地定义）。  
   - 对超出 K 的已水合会话执行**软驱逐**：  
     ```
     messages: []
     messagesHydrated: false
     delete hydratedFromEngine   // 或置 false——见 A8：不重置则 needsEngineMessageHydrate 恒 false
     // 保留：messageCount、engineCursor、engineLastRunId、pin、title、folder、importMeta、agents?
     ```  
   - **agents**：体积小且面板/身份可能引用——默认**保留 agents**；若实现中确认 agents 可安全清且懒拉对称存在，再单列验收，禁止静默一起清。  
2. **流式守卫**：会话在 streaming 活跃 key 集合内（streamingStore / 既有活跃流查询）→ **跳过驱逐**；`hydrateTruncated` 会话驱逐前不得把截断态当完整正文回写（与 `isLazySessionShell` / truncation guard 语义一致）。  
3. **切回**：`setActiveSessionId` 既有链路 + `triggerSessionMessageHydrateIfNeeded` / `needsEngineMessageHydrate`；软驱逐后的壳必须使 `needsEngineMessageHydrate === true`（**硬验收**）。Generation Token（`bumpHydrateGeneration`）继续防竞态。  
4. **与 persist 的互动（票 A/B 语境）**：  
   - 软驱逐产生的 `messages: []` 会进入 persist 快照——**必须**被 `isLazySessionShell` / `isHydrateTruncated` 守卫挡住，**禁止** `saveSessionBody(id, [])` 擦库（既有注释已警告「清空后刷新僵尸复活」对称风险；驱逐空数组 = 非用户清空）。  
   - 验收强制：驱逐后触发的 persist 批次对被驱逐 id 的 `saveSessionBody` 调用 = 0。  
5. **压力钩子（08-H6 / M10）**：`entry-core.tsx` `memoryManager.onPressure` level ≥3：在既有 `staggeredIdleQueue.clear()`（及 snapshots 清理若已挂）之外，**调用与切换路径同一 evict 实现**（禁止双逻辑），驱逐非活跃且非流式的已水合会话（active 保留）。

#### 删什么

| # | 删除/收敛项 | 位置 | 类型 |
| - | ----------- | ---- | ---- |
| E-1 | 「只增不减」的 activate 合并语义（无 evict 对称分支） | `sessionCrudActions.setActiveSessionId` + `sessionActivateHydrate` 叙事 | 补 evict 后删除「永不驱逐」路径语义 |
| E-2 | 双套驱逐（切换一处、压力一处） | `entry-core` vs crud | 单实现 |
| E-3 | 驱逐时误触发 `saveSessionBody(id, [])` 的路径 | persist 守卫缺口 | 路径删除（0 次调用） |

### 3.2 MessageSnapshots 记账（08-H5）

#### 做什么

1. **`estimateBytes` 修正**：预算必须覆盖 **retained 的全量 `messages` 副本** + delta 侧插入：  
   - `SnapshotEntry` 已存 `messages`（完整原始列表）——`save` 时对 `entry.messages` 做与 delta 同级的字节估算并累加，或改为「只留 delta、取消全量副本」（二选一，验证 undo 消费方后再定；**默认保守：计入全量副本**，不先砍 undo 功能）。  
2. **预算常量**：`MAX_MEMORY_BYTES` / `MAX_STACK_DEPTH` 迁入 D0 `perfBudgets.ts`（`SNAPSHOT_MAX_MEMORY_BYTES` 等），本地定义删除并 re-export。  
3. **验收**：`getTotalMemoryBytes() ≥ estimateBytes(全量 messages) + estimateDeltaBytes(delta)`（同 entry）；连续 withdraw ×10 后总账不超预算上限 + 单 entry 最大估。

#### 删什么

| # | 删除项 |
| - | ------ |
| S-1 | 「只按 delta 记账」的错误 estimate 路径（修正后删除单侧记账） |
| S-2 | 本地散落的 5MB/20 魔数（迁 budget 后删） |

### 3.3 FE hardCap · 工具输出 store 写入截断（08-H3 / 08-M1 / M8 · CFL-06 U-OUT-FE）

#### 做什么

1. **常量**：`TOOL_OUTPUT_STORE_HARD_CAP` 定义于 **D0** `apps/crish-desktop/src/api/perfBudgets.ts`（默认 256KB，与展示层现值同源语义；以 D0 定稿为准）。展示层 `TOOL_OUTPUT_LINE_CAP` / `TOOL_OUTPUT_BYTE_CAP` 改为从 budget re-export，**删除组件本地定义**（`ToolCallOutput.tsx:9-10`）。  
2. **写入点**（`streamCallbacksEvents.ts`）：  
   - `handleToolSuccess`（`:209` 一带）：`sanitizeToolDisplayOutput` 之后、`queueToolCallPatch` 之前，对 `output` 截断至 `TOOL_OUTPUT_STORE_HARD_CAP`；截断时设 `truncated: true`（若 `StreamToolCallPatch` 契约尚无该字段：**T0 内前端可选扩展字段**；若需改 engine-events 则登记 PR-SCHEMA 缺口，**禁止**在本票伪造 Rust 字段——前端已截断的展示义务不依赖 Rust 字段）。  
   - `handleToolError` 及其它把外部长文本写入 `output` 的 patch 路径：同一 helper（`hardCapToolOutput(s): {output, truncated}`），**单一入口**。  
3. **展示层**：store 已截断后，展示不再制造第二份全文拷贝（08-M1：引用 store 字符串 + 仅渲染窗口切片）；行/字节门限保留为**显示切片**语义，不再是「store 无界、UI 才裁」。  
4. **与 U-OUT-RS 对齐**：Rust 侧 `output_budget_bytes` 默认 Some + 执行器截断归 **02-D5 U-OUT-RS**；本票只保证 FE 写入 hardCap + 同源常量。数值漂移由 D0 常量表 + 门禁约束（FE-INV-10）。

#### 删什么

| # | 删除项 | 位置 |
| - | ------ | ---- |
| C-1 | store 无 cap 的全量 `output` 赋值路径 | `streamCallbacksEvents.ts` 各 patch 构造点 |
| C-2 | 组件本地 `TOOL_OUTPUT_*_CAP` 定义 | `ToolCallOutput.tsx:9-10` → budget re-export |
| C-3 | 「先全文进 store 再 UI 裁」作为默认策略的语义 | 写入路径 | 

### 3.4 D5 负向断言

| ID | 断言 | 手段 |
| -- | ---- | ---- |
| NE-1 | A→B→C 切换后 `sessions.filter(s => (s.messages?.length ?? 0) > 0).length ≤ SESSION_HYDRATE_KEEP_K` | 集成单测 |
| NE-2 | 切回 A：`needsEngineMessageHydrate` 先 true，水合后 messages 完整、`hydratedFromEngine` 恢复 | 单测 |
| NE-3 | 流式中会话不被驱逐；流不中断 | streaming key 守卫单测 |
| NE-4 | 驱逐触发的 persist 批次对被驱逐 id 的 `saveSessionBody` = 0 | mock 计数 |
| NE-5 | `tc.output.length ≤ TOOL_OUTPUT_STORE_HARD_CAP`；截断时 UI 可读 truncated 语义 | 单测 + 组件测 |
| NE-6 | `getTotalMemoryBytes()` 记账 ≥ 全量副本估算 + delta 估算 | MessageSnapshots 单测 |
| NE-7 | pressure level3 后：非活跃已水合 messages 空；active 保留 | 单测 / 集成 |
| NE-8 | hardCap helper 唯一：grep 生产路径无第二处裸 `queueToolCallPatch({output: raw})` 长文本入口 | 门禁/评审 |

---

## 4. 依赖与逻辑序（先删后改 · 禁止反例）

```text
D0 预算 SSOT（perfBudgets.ts + SESSION_HYDRATE_KEEP_K + TOOL_OUTPUT_STORE_HARD_CAP + SNAPSHOT_*）
    │
    ├─► 票 A · persist 出口切除（partialize+旧键+beforeunload 收敛+check-store-islands）
    │       │                    ═══ 可与 D3 并行（CFL-02 / 92 §10 U-PERSIST-CUT）
    │       ├─► 索引单源（LS 优先删除）           ── 部分项被 PR-LS-BODY 纪要门控
    │       └─► D5 软驱逐 / Snapshots / 压力接线   ── 与票 A 串行（同 sessionStore 写域）
    │               │
    │               └─► FE hardCap（streamCallbacks 写入；可与驱逐并行——不同文件域）
    │
D3 · SQLite 写单轨（组提交+增量 UPSERT+CAS 真消费）
    │
    └─► 票 B · dirty + normalize 收窄 + CAS 对账     ── 必须后于 D3；建议后于票 A
              （与索引单源若同开 sessionRustDbHydrate → 主控串行）

PR-LS-BODY 纪要 ──► 门控：body/agents/index 的 invoke-fail 删轨（不阻塞票 A / FE hardCap）
```

**禁止顺序反例（本维专属）**：

1. 未删 partialize `sessions` → 不得宣称「持久化优化完成」（92 §5 反例 2；票 A 完成前票 B 与 D5 的内存收益不得提前记功）。  
2. 未 D3 增量+CAS 绿 → 不得合票 B 并宣称写单轨完成（CFL-02）。  
3. 保留「读旧 LS 键 sessions 回灌」兼容读 → 物理切除失败（票 A 一票否决）。  
4. 双写过渡（partialize 空 sessions 同时仍写 LS body 键作为「保险」）→ 禁止。  
5. 未与 PR-LS-BODY 纪要对齐就静默删除或静默永续 body 回退 → 违反 92 §8。  
6. D5 驱逐在票 A 之前合入且迁移窗口未关 → 禁止（先关 LS 正文出口，再做内存驻留预算）。  
7. 压力驱逐与切换驱逐两套实现 → 禁止。  
8. FE hardCap 只改展示层 / 只改文案 → 不得冒充 08-H3（必须写入路径截断）。  
9. 未清 `hydratedFromEngine` 的「假软驱逐」（messages 清了但 `needsEngineMessageHydrate` 仍 false）→ 视为未完成。

---

## 5. 唯一文件域（与并行维互斥表）

| 单元 | 主责维/票 | 文件域（写） | 互斥说明 |
| ---- | --------- | ------------ | -------- |
| U-PERSIST-CUT（票 A） | D4 | `store/sessionStore.ts`、`store/middleware/withPersist.ts`（仅当需默认 options 说明；不承载 sessions 逻辑）、`store/layout-helpers/store-persistence.ts`（仅 boot 守卫相关最小改）、`api/beforeunloadFlush.ts`、`sessionRustDbHydrate.ts` 的 sync 镜像段、`store/sessionCrudActions.ts`（draft 清理）、`scripts/check-store-islands.mjs`（新） | **不与 D3 同 PR**（92 §10）；不与票 B 同 PR |
| 票 B | D4 | `store-persistence.ts` dirty 快照、`sessionRustDbHydrate.ts` bodyJobs/normalize 段、`sessionRustDbSql.ts`（仅前端 CAS 测试钩子，Rust 命令面归 D3） | 后于 D3；与索引单源同文件则串行 |
| 索引单源 | D4 | `sessionRustDbHydrate.ts` 索引段、`sessionRustDbSql.ts listSessions`、`sessionRustDbLegacyCleanup.ts`、`sessionPersistenceTypes.ts` 键登记 | 不得被 D9 双开（CFL-08） |
| PR-LS-BODY 删轨 | D4（会签后） | `sessionRustDbSql.ts` load 回退、`sessionRustDbFallback.ts` body 写、`sessionRustDbHydrate.ts` localFallback | 纪要门控 |
| D5-EVICT | D5 | `sessionCrudActions.ts`、`sessionActivateHydrate.ts`、`sessionSharedHelpers.ts`（若需扩展 needs 判定——优先驱逐侧满足既有判定）、`entry-core.tsx` | 与票 A 串行同 store；与 hardCap 可并行 |
| D5-SNAP | D5 | `api/MessageSnapshots.ts`、`store/messageSnapshotsBridge.ts` | 独立 |
| D5-HARD CAP | D5 | `hooks/chat-stream/streamCallbacksEvents.ts`、（helpers 若拆）、`components/chat-tool-call/ToolCallOutput*.tsx`（只读改为 re-export budget） | 与 U-OUT-RS 不同仓文件；与 evict 可并行 |
| D0 预算 | D0 | `api/perfBudgets.ts`（新建）、`scripts/check-perf-budgets.mjs` | **先于** D5 常量引用；D5 只消费 |

**跨维只读**：D6/D7/D8/D9 文件域与上表不相交；D3 写 `conex-db/**`、`session_commands` save——D4 票 B **只读验证** Rust CAS，不改 D3 文件。

---

## 6. 路径 N→M（概念收敛表）

| 概念 | 现路径 | 目标 | 主责 |
| ---- | ------ | ---- | ---- |
| 会话正文持久化出口 | **2**（zustand persist 全量 LS + initStorePersistence→SQLite） | **1**（SQLite 唯一正文出口） | D4 票 A |
| LS 大键 `crish_session_store` 中 sessions | 每 set 全量 stringify | **字段不存在**；键=轻量 meta 或新名 meta 键 | D4 票 A |
| 会话索引 | **2**（LS 优先 + SQLite 回退） | **1**（SQLite `list_sessions`） | D4 索引单源 |
| body invoke 失败回退 | LS 正文静默读/写（+ beforeunload 主动镜像） | 会签 P1/P2：**正文回退 0**；镜像 messages=0 | PR-LS-BODY + 票 A |
| 350ms persist bodyJobs | 全量会话 normalize+save | **仅 dirty** | D4 票 B（后于 D3） |
| batch_version | 前端 CAS 有、Rust 消费弱/待 D3 | 前后端 CAS 闭环 | D3+票 B |
| 非活跃已水合 messages | 只增不减 | K 预算软驱逐 + 懒水合对称 | D5 |
| 压力 level3 | 只清 idle | + 非活跃 messages 驱逐（同实现） | D5 |
| 工具输出 store | 无 cap 全文 | `≤ TOOL_OUTPUT_STORE_HARD_CAP` + truncated | D5 |
| Snapshots 预算 | 只计 delta 单侧 | 全量副本 + delta 双计（或砍副本） | D5 |

---

## 7. 验收总表（功能 + 负产出 + 五端物证）

### 7.1 功能回归清单

| 场景 | 期望 |
| ---- | ---- |
| 冷启动（空 LS meta + 有 SQLite） | 侧栏完整；活跃正文来自 SQLite |
| 冷启动（残留旧大键） | 一次迁移后键移除/降壳；正文来自 SQLite；无白屏 |
| 刷新 / 强杀后重开 | 列表与正文完整；drafts 保留 |
| 切会话 × N > K | 常驻已水合 ≤ K；切回自动水合；流式会话不丢 |
| 工具长输出 | store 内截断；UI 显示截断提示；无第二全文 |
| 删除会话 | body/agents/drafts/snapshots 级联既有四件套不回退 |
| invoke 全不可用（按会签） | 可感知降级；无静默空库；无正文 LS 镜像复活 |

### 7.2 负产出汇总（勾选制）

- [ ] partialize 无 `sessions`/`sessionsById`  
- [ ] 旧键 sessions 读代码不存在  
- [ ] beforeunload messages 镜像删除或 meta-only  
- [ ] `composerDrafts` 删除会话清理  
- [ ] `check-store-islands` 进 CI（fail）  
- [ ] 索引 LS 优先分支删除（或会签例外登记）  
- [ ] body invoke-fail LS 回退按纪要删除  
- [ ] dirty：非变更会话 `saveSessionBody` 0 调用  
- [ ] 全量 normalize 删除  
- [ ] 软驱逐 + 压力单实现  
- [ ] Snapshots 记账修正  
- [ ] `TOOL_OUTPUT_STORE_HARD_CAP` 写入路径接线；组件本地 cap 定义删除  
- [ ] 本维新增 TODO/FIXME = 0  

### 7.3 五端物证

| 端 | 物证 |
| -- | ---- |
| 触发端 | UI：切会话、发工具、beforeunload、压力模拟（memoryManager 注入 level3）、删除会话 |
| 传输端 | 仅 dirty `save_session_body` IPC（票 B 后）；无 LS body 回退静默路径（会签后）；`truncated` 前端字段（若 PR-SCHEMA 未收，登记「仅前端截断」边界） |
| 介质端 | LS：无 sessions 正文；索引按纪要；SQLite：增量行 + CAS 版本 |
| 消费端 | 驱逐后 UI 懒壳 + 水合完整；hardCap 后 store 字符串长度断言 |
| 负向断言 | NA-*/NB-*/NI-*/NL-*/NE-* 单测全绿 + check-store-islands + check-perf-budgets |

**运行时探针（4000 Tauri MCP，禁 9222/5174 冒充）**：  
- FE-INV-2：`JSON.parse(localStorage['crish_session_store'] ?? '{}')` 无 sessions.messages；  
- FE-INV-3：切换后已水合计数 ≤ K；  
- FE-INV-4：抽查 tool call `output.length ≤ CAP`；  
- Performance：大输出收口无 >1MB stringify 热点（票 A 后）。

---

## 8. 防御脚本 / 守护测试增量

| 资产 | 断言 | 归属 |
| ---- | ---- | ---- |
| `scripts/check-store-islands.mjs`（新） | partialize 无 sessions；无旧键 sessions 读写；索引键按纪要 | 票 A + 索引单源 |
| `check-perf-budgets.mjs`（D0） | KEEP_K / HARD_CAP / SNAPSHOT_* 无散落魔数 | D0 + D5 |
| `sessionStore partialize` 单测 | NA-A1 | 票 A |
| boot 迁移单测 | 旧键一次删除 + 无回灌 | 票 A |
| beforeunload mock 计数 | lsSaveSessionBody=0 | 票 A |
| dirty 计数单测 | NB-B1/B2 | 票 B |
| CAS 乱序单测 | NB-B3 | 票 B/D3 |
| 驱逐/水合对称单测 | NE-1..4 | D5 |
| streaming 守卫单测 | NE-3 | D5 |
| Snapshots 记账单测 | NE-6 | D5 |
| hardCap 单测 + 组件 truncated | NE-5 | D5 |
| 压力接线集成 | NE-7 | D5 |
| 既有 `sessionRustDbWriteModel.test` / `sessionRustDbHydrateLazy.test` / boot 水合 | 回归保持绿；按删轨更新预期（**不删测试文件**——测试资产保护） | 全票 |

---

## 9. 与 90 ID 映射

| 本详案 | 90 / 报告 ID |
| ------ | ------------ |
| D4 票 A | 08-H1、08-H4（序列化放大面）、01-M9、01 DEL-5、03 D4 / 06 S2 |
| D4 索引单源 | 01 DEL-6、T-L3-B、06 S1、CFL-08、08 交叉 |
| D4 票 B | 01 DEL-7、DEL-15、T-L3-A 后半、05-W1、03-I1（batch_version 消费） |
| PR-LS-BODY | 01 §7 待核实、03-S3/B2、92 §8#4 |
| D5 驱逐 | 08-H2、08-H4、T-L5-A 前端半 |
| D5 压力 | 08-H6、08-M10 |
| D5 Snapshots | 08-H5、08-X1 |
| D5 hardCap | 08-H3、08-M1、08-M8、10-T4 交叉、CFL-06 U-OUT-FE |

---

## 10. 汇报要点（给主控 · 本任务书指定格式）

### 10.1 两票拆分

| 票 | 范围一句话 | 依赖闸 | 首轮并行资格 |
| -- | ---------- | ------ | ------------ |
| **票 A** | partialize 切 sessions + 旧键一次删除 + 无兼容读 + beforeunload messages 镜像收敛 + check-store-islands | 不依赖 D3；**建议** D0 已提供常量（本票可不等） | **有**（U-PERSIST-CUT） |
| **票 B** | dirty bodyJobs + 仅 dirty normalize + batch_version 前后端 CAS 对账闭环 | **硬依赖 D3 增量+CAS 绿**；建议票 A 已合 | 无（第二波） |

拆分依据：CFL-02 / 92 §5–§6 / 01 T-L3-A 与 03 D4 的「最小完成集」分歧已吸收——票 A=LS 出口税，票 B=写单轨后半。

### 10.2 会签依赖

| 会签 | 门控对象 | 不门控对象 | 纪要选项 |
| ---- | -------- | ---------- | -------- |
| **PR-LS-BODY** | body/agents/index 的 invoke-fail LS 回退删或留；`persistAllSessionsLocalFallback` 存废 | 票 A（主动双写切除）；FE hardCap；软驱逐；Snapshots | P1 全删 / P2 元数据-only+日期 / P3 全保留（默认不接受） |
| （关联）PR-SCHEMA | 仅当 `truncated` 必须成为跨端字段时 | FE 写入截断本身 | 前端可选字段 T0，不强制升 T2 |
| （关联）D0 预算 | KEEP_K / HARD_CAP / SNAPSHOT_* 常量落点 | 票 A 结构切除 | 与 CFL-01 一致 |

**启动时点**：PR-LS-BODY 纪要**立即开票**；实现删轨等纪要。票 A **不**等纪要。

### 10.3 负向断言（汇总最小集 · 详表 §2–§3）

1. partialize ∩ {sessions, sessionsById} = ∅（AST+单测）。  
2. 旧键 sessions 生产 0 读 0 写；迁移读代码删除后无回灌。  
3. beforeunload：`lsSaveSessionBody` 调用 = 0。  
4. 票 B：非 dirty 会话 `saveSessionBody` = 0；全量重发路径不存在。  
5. 索引：boot `lsLoadSessionIndex` = 0（或纪要例外）。  
6. 软驱逐：常驻已水合 ≤ K；切回自动水合；流式不驱逐；驱逐不触发擦库 save。  
7. hardCap：`output.length ≤ TOOL_OUTPUT_STORE_HARD_CAP`；写入路径唯一。  
8. Snapshots：总账 ≥ 全量副本 + delta。  
9. `check-store-islands` + `check-perf-budgets` CI fail 绿。  
10. 本维生产代码无新增 TODO/FIXME；无第二持久化出口。

---

## 11. 实现轮任务书预留骨架（四段 · 执行时填）

> 遵循 92 §13：做什么 / 不做什么 / 旧路径清单 / 完成自检。

| 单元 | 做什么 | 不做什么 | 旧路径（删） | 自检 |
| ---- | ------ | -------- | ------------ | ---- |
| U-PERSIST-CUT | 票 A 全集 | dirty；Rust 文件；D5 驱逐 | partialize sessions；旧键读；beforeunload body 写 | NA-* 绿；islands 门禁绿 |
| U-INDEX-1SRC | 索引 SQLite 唯一 | body 回退删轨（待纪要） | LS 优先读序；lsSave 热路径 | NI-* 绿 |
| U-DIRTY-CAS | 票 B | partialize；D3 Rust 实现 | 全量 bodyJobs/normalize | NB-* 绿；D3 联调引用绿 |
| U-EVICT | 软驱逐+压力单实现 | hardCap；Snapshots | 只增不减；双驱逐 | NE-1..4、7 绿 |
| U-OUT-FE | hardCap+truncated | U-OUT-RS 执行器 | 无 cap 写入；组件本地 cap | NE-5、8 绿 |
| U-SNAP-BOOK | estimate 修正 | 改 undo 架构 | 单侧记账 | NE-6 绿 |

---

_本分维详案 UTF-8 无 BOM；未执行 git commit；未修改生产代码。评审意见请落 `review-detail-*`，修订以追加/主控授权方式进行。_
