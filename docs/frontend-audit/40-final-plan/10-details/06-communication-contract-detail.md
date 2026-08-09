# T-F 通信契约轨道 · 详细执行计划（06）

> 产出类型：详细计划（只读 + 本文档，无代码改动）。
> 输入：`40-final-plan/00-master-plan.md`（批次 6.2/6.3 + 9.2）+ `20-proposals/04-communication-proposal.md`（步骤②-⑦）+ `30-reviews/01~03` + `10-analysis/04-frontend-backend-communication-audit.md`。
> 复核基线：2026-08-09 工作区实读（与方案声明同日后的仓库演进已逐项重定位，行号以本文档为准）。
> 范围：**04 方案步骤 ② 分裂 rename、③ 幽灵裁决、④ 错误码双向、⑤ 归一器锁定、⑥ 契约总门禁、⑦ invokeCmd 吞错迁移**。步骤 ①（断链修复 md_render/highlight_code/perf_jsonl_append）归 T-A 轨道（00 批次 1.2），本轨道全部裁决建立在「断链清零」后的应然面之上，只做验证不复修。

---

## 0. 轨道定位、依赖与实读修正记录

### 0.1 轨道定位

| 项 | 值 |
|---|---|
| 轨道 | T-F 通信契约（00 主计划 §1） |
| 批次 | 6.2（分裂 rename）、6.3（幽灵裁决 + 错误码双向）；6.4 归一器锁定随 6.3 同批（文件面独立）；⑥ 契约总门禁测试随本轨编写、CI 校准收尾按 00 批次 9.2（详见 §5.4）；⑦ 吞错迁移随本轨收尾 |
| 并行域 | 与 T-A（rustCore.ts/TelemetryMonitor.ts）串行——T-A 批次 1 先落地步骤①，本轨 6.2/6.3 不得与其并行改同一文件 |
| 边界 | T-F 只补码表不碰展示面（00 §1 T-F↔T-E）；highlight 接线/退役与 07 维度交叉（30-02 ④ 已实证「方向相反」），接线路径必须等 07 步骤 1 定稿后评估（本计划按「默认退役 + 待用户裁决」双路径写任务） |

### 0.2 依赖链（本轨内部）

```
T-A 断链清零（批次 1，前置） → 6.2 分裂 rename（Rust 注册面 + 前端调用名，双端同轮）
   → 6.3 幽灵裁决（接线项依赖 6.2 后的四表一致基线；退役项依赖条数公式双端同步）
   → 6.4 错误码双向 + 归一器锁定（文件面与 6.2/6.3 完全独立，可与 6.2 并行）
   → ⑥ 契约总门禁（依赖 6.2/6.3 落地后的应然面基线；测试文件随 6.3 提交，校准在批次 9.2）
   → ⑦ 吞错迁移（文件面为 5 个 api 文件，与 6.2 的 workspaceFsApi 不重叠，可与 6.3 并行）
```

### 0.3 实读修正记录（与审计/方案的差异，派单时以本文档为准）

| # | 修正项 | 方案/审计口径 | 实读结果 |
|---|---|---|---|
| M1 | ENGINE_NORMALIZERS 键数 | 审计 §3.3 称「40 键」 | **实测 42 键**（eventParser.ts:399-859）：38 个 canonical 类型 + 4 个历史别名（text-delta、run-completed、run-failed、run-cancelled）；3 个 subagent-* 事件无归一器（走 legacy 信封，eventParser.ts:901-903）。与 ENGINE_EVENT_TYPES 41 键的差集 = 4 别名 + 3 subagent = 7 键 |
| M2 | 生产 invokeCmd 残留数 | 审计 §2.5 称 19 处（5+3+1+5+5） | **实测 13 处**：backgroundTasksApi.ts 4（:699/:712/:735/:807）、hostOpenersApi.ts 2（:64/:78）、rustCore.ts 4（:73/:78/:90/:119）、workflowRunner.ts 2（:82/:205）、skillsApi.ts 1（:417，tryInvokeTauri 别名 import 于 :13）。audit 数字过时 |
| M3 | markdownRenderAsync.test.ts mock 键面 | 方案 1c 只列 parity/test-setup | **实测 11 处**（markdownRenderAsync.test.ts:54/68/88/96/102/109/118/154/164/181/194 全部 `md_render`）——测试面同步面比方案清单大，但均已由 T-A 批次 1 的 1c 统一处理；本轨只做验收复核 |
| M4 | main.rs 注册宏位置 | 方案引用 main.rs:79-88 | 实测 :90 起（30-03 抽查已标注）；宏注释 :72-78 为铁律注入点 |
| M5 | 退役 changelog 载体 | 方案写 `docs/rust-rewrite/33-*` | 实测唯一 changelog 文件 = `docs/rust-rewrite/33-event-schema-changelog.md`（退役登记写此文件） |
| M6 | 快层 CI 接线动作 | 方案 6c「接 CI 快层」 | 实测 **无需改 ci.yml**：vitest-fast（ci.yml:64-81）跑 `npm run test:coverage -- --project=unit`，unit 项目 include 已含 `apps/crish-desktop/src/**/*.test.{ts,tsx}`（vitest.config.ts:73-78）——新漂移测试放 `src/api/` 下即自动进快层；批次 9.2 的「接线」只剩校准复核（§5.4） |
| M7 | core_rebuild_search_index 消费面 | 方案称「QuickOpen 空态/设置页」 | 实测 **QuickOpen 独立组件不存在**；搜索消费面仅 rustCoreStore.ts:66（该 store 自身 DEAD，rustCoreStore.ts:39-46 自证 0 调用点）。真实可行的诚实空态入口 = 设置页 StatusDiagnosticsPanel.tsx:209（searchIndexReady 已展示）→ 重建按钮落此处（§2.2-T2.5） |
| M8 | 快照/注释条数 | command_manifest.rs:7 注释过时（84/89 vs 88/92） | 实测 :200-215 断言为 92/88/4；:7 行注释确为过时残留（P3-13），随 6.3 条数同步一并修正 |

---

## ① 分裂标签 rename（04-②，4 条 fs 命令）

### 1.1 决策复述（为什么改 Rust rename 而非前端改键 / manifest 改登记）

**结论：改 Rust rename 统一到 workbench_*，不动 manifest 登记名。** 依据（20-proposals/04 §②2.3）：

1. `family=workbench / surface=gui` 是这 4 条的真实归属（GUI 专属文件面，main.rs:91-127 的 workbench 组与 commandManifest.ts:57-83 镜像组均以 workbench_* 为名），wire 键带 workbench_* 前缀语义自洽；
2. 改动面最小：Rust 4 行 attr + 前端 5 调用点 + 1 测试文件 4 处；反向方案（manifest 改登记 select_folder 等）需改 manifest 4 条目 + 注册宏 4 元组名 + 快照 4 条目，且这些裸键归不进现有任何 family；
3. 消除「函数名 = wire 键」隐规则的最后一个反例（fs 4 条是唯一无 rename 的注册组，main.rs:112-118 自认），与目标态「wire 键显式化」一致（04 §①）。

### 1.2 任务表（7 任务）

| 任务 | 文件 | 位置（实测） | 动作 |
|---|---|---|---|
| T1.1 | `apps/agent-workbench/src-tauri/src/fs_commands/mod.rs` | :18-23 / :26-32 / :35-42 / :49-57 | 四个命令补 `#[tauri::command(rename = "workbench_*")]`：`select_folder`→`workbench_select_folder`、`list_directory`→`workbench_list_directory`、`read_file_content`→`workbench_read_file_content`、`write_file_content`→`workbench_write_file_content`。函数名不变（内部调用点/测试引用函数名，零连锁） |
| T1.2 | `apps/agent-workbench/src-tauri/src/main.rs` | :112-118 | 删除「Tauri rename 语义核对（F7 遗留 4）」分裂自认注释块（分裂消失后注释即死）；注册宏条目本身**不动**（元组名 workbench_* 与 wire 键首次逐字一致） |
| T1.3 | `apps/agent-workbench/src-tauri/src/main.rs` | :72-78（宏头注释） | 补写铁律：「wire 键 = manifest 登记名；函数名与 wire 键不一致必须显式 `#[tauri::command(rename=...)]`；禁止函数名隐式成为 wire 键」。先于 ⑥ 门禁落地的纸面约束 |
| T1.4 | `apps/crish-desktop/src/api/workspaceFsApi.ts` | :104 / :156 / :190 | 三个 invoke 字面量改 `workbench_list_directory` / `workbench_read_file_content` / `workbench_write_file_content`；参数形状不变（workspaceRoot 参数 Rust 侧本就忽略，继续传无害，不顺手改） |
| T1.5 | `apps/crish-desktop/src/api/import/importFsHost.ts` | :117 / :142 | `'list_directory'`→`'workbench_list_directory'`、`'read_file_content'`→`'workbench_read_file_content'` |
| T1.6 | `apps/crish-desktop/src/api/desktopNativeFeatures.test.ts` | :245 / :258 / :334 / :341 | 测试面同步：`'select_folder'`×2、`'read_file_content'`×2 → workbench_* 名（与 1c 同纪律：mock 键必须 = 真实键） |
| T1.7 | grep 门禁 + Rust 测试验证 | 全仓 | `rg "'select_folder'|'list_directory'|'read_file_content'|'write_file_content'" apps/crish-desktop/src` 生产代码零命中（命令定义面除外）；`cargo test` 壳测试 `registration_surface_matches_manifest`（main.rs:486-499）与 `manifest_names_are_unique`（command_manifest.rs:219-225）天然继续绿（注册宏名本就是 workbench_*，rename 后 wire 键首次与宏名一致——「首次一致」断言可考虑在 T1.7 顺带补一条：注册宏名 == wire 键 的漂移测试，见 §5 T5.1 前期样本） |

**完成判据**：wire 键 = 注册宏名 = manifest 名 = 前端调用名四者逐字一致；旧裸键生产代码零残留；cargo 壳测试 + typecheck + 相关 vitest（workspaceFsApi / importFsHost / desktopNativeFeatures suites）全绿。

**验证命令**：`cargo test`（src-tauri 壳测试）、`npm run typecheck`、`npx vitest run src/api/desktopNativeFeatures.test.ts src/api/workspaceFsApi.test.ts src/api/import/importFsHost.test.ts`（如有对应文件，按 grep 实测补全）。

---

## ② 幽灵命令裁决与落地（04-③，11 条逐条）

### 2.1 判定标准（04 方案 §步骤3，原样执行）

- **接线**（满足任一）：① 有前端真实消费意图（调用链 / 设计文档 / 状态面已暴露只差触发入口）；② 命令能力有明确收益场景且前端缺入口；③ 接线成本显著低于能力损失。
- **退役**（满足任一）：① 无任何消费意图（功能已被其他路径替代）；② 仅测试隔离/调试用途（Rust 侧可保留函数不占命令面）；③ 与已定架构方向冲突（如流式主路径已定为 JS 零 IPC）。
- 退役落地动作（每条一致）：Rust `command_registry!` 删注册 → `command_manifest.rs` 删条目 → 前端快照 `commandManifest.ts` 删条目 → 条数公式双端同步 → changelog 登记 `docs/rust-rewrite/33-event-schema-changelog.md`。

### 2.2 裁决表（11 条逐条 + 任务归属）

| # | 命令 | 归类（审计 §2.3） | 裁决 | 一句话依据（实读证据） | 落地任务 |
|---|---|---|---|---|---|
| 1 | `core_md_render` | 接线缺口（下游） | **接线**（随 T-A 步骤①自动消解） | 消费链真实：markdownRenderAsync.ts:4 import renderMarkdown → :37-48 Rust 优先、missing 回退 worker；改名后能力首次生效 | T2.1（验收性，非新任务） |
| 2 | `core_highlight_code` | 接线缺口（下游） | **接线或退役（用户裁决）** | wrapper rustCore.highlightCode（:180-189）改名后仍无生产消费者（grep 实测唯一消费 renderMarkdown）；接线有「长代码块不阻塞主线程」收益但与 07 流式期零 IPC 方向相反（30-02 ④）；退役成本小 | T2.2 双路径（接线 A / 退役 B） |
| 3 | `core_jsonl_append` | 接线缺口（下游） | **接线**（随 T-A 步骤①自动消解） | perf/jsonl.rs:5-7 注释自证迁移责任在前端域；TelemetryMonitor.ts:103 改名即通；workspace 未开时 core_commands.rs:575-578 `for_default_workspace()` 兜底 | T2.3（验收性） |
| 4 | `core_md_render_batch` | 接线缺口 | **接线** | Rust 实现完整含 moka 缓存（markdown_commands.rs:34-40）；批量面是「长会话首屏 4-15s 卡顿」（:4 设计意图）的批量解；缺 wrapper + 消费点 | T2.4 |
| 5 | `core_md_render_stream` | 接线缺口 | **退役** | markdown_commands.rs:44-45 自证「流式期主路径是 JS IncrementalMarkdownParser（零 IPC）」；STREAMING_RENDER_PLAN.md 的 fallback 接线计划未落地且 07 恢复方案为 JS 帧级增量；无消费意图 | T2.7 |
| 6 | `core_md_clear_cache` | 接线缺口 | **退役** | markdown_commands.rs:78-80 自证「正常运行时无需调用（moka 自动 LRU 淘汰）」，仅测试隔离用途——Rust 测试直接调 `conex_markdown::clear_cache` 函数不占命令面 | T2.8 |
| 7 | `core_rebuild_search_index` | 能力缺口 | **接线** | `core_search_files` 有消费 API（rustCore.ts:45）；searchIndexReady 诚实状态已暴露（rustCore.ts:136-152 + StatusDiagnosticsPanel.tsx:209）；只差触发入口 = 「有意图缺接线」典型（M7 修正：入口落设置页） | T2.5 |
| 8 | `config_get` | 能力缺口 | **接线** | engineConfig.ts 只调 config_update（:632），配置族只写不读（P2-8）；补读面低风险高价值 | T2.6 |
| 9 | `core_read_run_events` | 能力缺口 | **退役** | 前端唯一事件读取面消费 `core_read_session_events`（sessionEventHydrate.ts:423）；历史 API 无消费；**连带**：commandMap.ts:33 白名单条目删除（该条目自身也是幽灵，05-3） | T2.9 |
| 10 | `touch_session` | 能力缺口 | **退役（默认）** | 全仓无消费意图；会话活跃时间戳面无前端依赖证据；如需「会话列表按活跃排序」再恢复（changelog 注明） | T2.10 |
| 11 | `delete_session` | 能力缺口 | **退役并登记（待存储架构裁决）** | 前端删除走 IndexedDB 本地面（sessionCrudActions.ts:410-420）；Rust `delete_session` 是 LocalDb 面——双存储关系未明（超出本维度）；退役命令面并 changelog 登记，待存储裁决后决定是否恢复 | T2.11 |

**汇总**：接线 6 条（1/3/4/7/8 + 2 待用户裁决）、退役 5 条（5/6/9/10/11）。若 #2 裁决退役 → 退役 6 条。

### 2.3 任务明细

#### 接线类

**T2.1（验收）core_md_render / T2.3（验收）core_jsonl_append** —— 由 T-A 批次 1 完成，本轨只验证：`rg "'md_render'|'perf_jsonl_append'" apps/crish-desktop/src` 生产代码零命中；`npx vitest run src/api/markdownRender.parity.test.ts src/api/markdownRenderAsync.test.ts src/test-setup.test.ts` 全绿（mock 键 = core_* 真实键）。**无代码任务**。

**T2.2（待用户裁决）core_highlight_code 双路径**：
- **路径 A（接线）**：消费点 = `streamingCodeHighlighter.ts` 异步高亮路径改走 Rust（每代码块 invoke `core_highlight_code`，missing/error 回退 highlight.js）；**前置约束**：必须等 07 维度步骤 1（流式增量渲染）定稿后评估——若 07 定稿流式期每帧零 IPC，则接线只允许在「非流式完成态代码块」路径生效，避免每帧 IPC 风险；同时补单元测试（Rust 高亮 HTML 与 highlight.js 输出共存断言）。文件面：rustCore.ts（复用 :180-189 wrapper 改名后即通）+ streamingCodeHighlighter.ts。
- **路径 B（退役）**：删除 rustCore.highlightCode wrapper（:176-189）+ `highlight_code` 注册（main.rs:178）+ markdown_commands.rs:60-74 命令函数删除 + manifest/快照条目删除 + changelog 登记。改动面最小。
- **建议**（不替用户裁决）：默认**退役（路径 B）**——无真实消费链、接线收益与 07 冲突面大（30-02 ④ 已实证方向相反）、退役成本小；后续若出现「长代码块高亮卡顿」实测证据再按路径 A 恢复（changelog 可查）。

**T2.4（接线）core_md_render_batch 首屏批量预热**：
1. `apps/crish-desktop/src/api/rustCore.ts` 新增 `renderMarkdownBatch(texts: string[]): Promise<(string | null)[]>`：`invokeResult` 调 `'core_md_render_batch'`（参数 `{ texts }`，对齐 markdown_commands.rs:36 签名），missing/error 返回 null 数组（调用方逐条回退 worker）；
2. 新增消费点 `apps/crish-desktop/src/api/markdown-render/markdownBatchPrewarm.ts`（新文件，规避与 07/02-C1 的 MessageContent.tsx 同文件冲突）：会话消息列表首屏加载完成时，对**可见消息文本**（去重、非空）批量调 `renderMarkdownBatch`，命中结果写入 markdownCache（`setMarkdownHtmlCache`，复用 markdownRenderAsync.ts:2/30 既有缓存面）；失败静默回退（后续逐条走既有异步路径）；
3. 挂接点：会话 hydrate/首屏渲染侧调 `prewarmMarkdownBatch(texts)`（文件面选择与 07 批次错开的会话加载模块；若与 07 重叠文件，则登记同文件串行，本轨先写能力、07 批次后挂接）；
4. 测试：rustCore.renderMarkdownBatch 单测（mock `core_md_render_batch` 键）+ prewarm 纯函数测试（输入消息列表 → 去重 → 缓存写入）。
- 与 07 联动：批量预热只覆盖**完成态消息**，与流式增量渲染不冲突；若 07 批次未就绪，本任务只提交能力与挂接点空实现（默认不调用），由主控协调 07 批次接线。

**T2.5（接线）core_rebuild_search_index 重建索引入口**：
1. `apps/crish-desktop/src/api/rustCore.ts` 新增 `rebuildSearchIndex(): Promise<boolean>`：`invokeResult('core_rebuild_search_index', {})`，ok=true、missing/error=false + `logInternalError`；
2. 入口 UI：`apps/crish-desktop/src/components/settings/StatusDiagnosticsPanel.tsx`（:209 搜索索引行）：`searchIndexReady=false` 时展示「重建索引」按钮，点击调 `rebuildSearchIndex()` 并刷新 `refreshStatus`（rustCoreStore.ts:52-63 既有刷新动作；注意 rustCoreStore 自身 DEAD——入口实现直接调 rustCore API + 组件本地状态，不新增对 DEAD store 的依赖）；
3. 测试：组件测试（空态渲染按钮 + 点击调用断言）+ rustCore 单测。

**T2.6（接线）config_get 读面**：
1. `apps/crish-desktop/src/api/engineConfig.ts` 新增 `loadEngineConfig(): Promise<EngineConfigWire | null>`：`transport.request('config_get')`（与 :632 config_update 同 transport 通道），missing/error → logInternalError + null（不抛）；
2. 消费点（低风险面）：设置页模型区加载时读一次配置填充当前值（与 updateEngineConfig :616-641 对称）；只补「读」不重建状态流；
3. 测试：engineConfig 单测（mock config_get 三态）。

#### 退役类（每条 = 5 面同步 + changelog）

**T2.7 退役 core_md_render_stream**：main.rs:177 删注册；command_manifest.rs 删条目；commandManifest.ts:134 删快照条目；changelog 登记「流式主路径 JS 零 IPC 定稿，Rust 流式命令无消费意图，退役；如需恢复先接前端消费」。

**T2.8 退役 core_md_clear_cache**：main.rs:179 删注册；command_manifest.rs 删条目；commandManifest.ts:136 删快照；changelog 登记「moka 自动 LRU，仅测试隔离用途；Rust 侧 `conex_markdown::clear_cache` 函数保留供测试直调」。

**T2.9 退役 core_read_run_events**：main.rs:148 删注册；command_manifest.rs 删条目；commandManifest.ts:107 删快照；**commandMap.ts:33 同步删白名单条目**（该条目无生产消费，仅 commandMap.test.ts:47 自证——同步删除并修对应测试断言）；changelog 登记「被 core_read_session_events 取代」。

**T2.10 退役 touch_session**：main.rs:166 删注册；command_manifest.rs 删条目；commandManifest.ts:129 删快照；changelog 登记「无消费意图；如需会话列表按活跃排序再恢复」。

**T2.11 退役 delete_session**：main.rs:159 删注册；command_manifest.rs 删条目；commandManifest.ts:118 删快照；changelog 登记「前端删除走 IndexedDB 本地面（sessionCrudActions.ts:410-420），Rust LocalDb 面待存储架构裁决后决定恢复」。

**T2.12 条数公式双端同步 + 注释卫生**：
- Rust：`command_manifest.rs:200-215` `manifest_count_matches_registered_surface` 断言同步（5 退役：92/88/4 → **87/83/4**；6 退役含 highlight：→ **86/82/4**）；:7 行过时注释（84/89）一并修正；
- 前端：`commandManifest.test.ts:44-45` 断言同步（88/92 → 83/87 或 82/86）；:48-49 快照头注释同步；commandManifest.ts:38-45 entry 注释与 `:47-52` 维护规则注释同步；
- 验证：`cargo test` + `npx vitest run src/api/transport/commandManifest.test.ts src/api/transport/commandMap.test.ts` 双端同步绿。

**涉及文件面汇总（退役 5 条 + 接线）**：
- Rust：main.rs（注册宏 5-6 行删除 + T1.2/T1.3 注释）、command_manifest.rs（条目 + :200-215 测试 + :7 注释）
- 前端：commandManifest.ts（快照条目 + 头注释）、commandManifest.test.ts（:44-45）、commandMap.ts（:33 白名单 + commandMap.test.ts 断言）、rustCore.ts（T2.2-B 删 wrapper / T2.4/T2.5 新增）、markdownBatchPrewarm.ts（新文件）、engineConfig.ts、StatusDiagnosticsPanel.tsx
- 文档：docs/rust-rewrite/33-event-schema-changelog.md（退役登记 5-6 条）

**完成判据**：11 条幽灵全部进入「接线生效」或「已退役登记」终态，无第三条路；接线项有真实调用点 + 测试；退役项双端清单同步、条数公式双端一致（87/83/4 或 86/82/4）、changelog 可查；`commandMap.checkCommandMapConsistency` 运行时对照无幽灵告警。

---

## ③ 错误码双向覆盖（04-④，kebab 码表 13→8 缺口）

### 3.1 Rust kind 全集 × 前端码表对照表（实读）

Rust 权威源：`crates/session-loop/src/loop/handlers/stream_error.rs:305-319` `kind_str` 13 分支（与 `crates/conex-types/src/error.rs:794-821` ProviderErrorKind 13 变体 serde kebab-case 一一对应）。前端码表：`userFacingErrors.ts:65-75` KEBAB_KIND_TO_SOFT（8 键）、`:121-128` KEBAB_TO_DOMAIN（6 键）。

| # | Rust kind | KEBAB_KIND_TO_SOFT | KEBAB_TO_DOMAIN | 现状处置 | 缺口处置（建议，文案待用户裁决） |
|---|---|---|---|---|---|
| 1 | `auth` | ✅ auth | — | 已登记 | 维持 |
| 2 | `endpoint-unavailable` | ✅ network | ✅ S4 | 已登记 | 维持 |
| 3 | `network` | ✅ network | ✅ S4 | 已登记 | 维持 |
| 4 | `timeout` | ✅ network | ✅ S4 | 已登记 | 维持 |
| 5 | `quota` | ✅ blocked | — | 已登记 | 维持 |
| 6 | `server-error` | ✅ provider_fault | ✅ S5 | 已登记 | 维持 |
| 7 | `rate-limit` | ✅ provider_fault | ✅ S5 | 已登记 | 维持 |
| 8 | `gateway-challenge` | ✅ provider_fault | ✅ S5 | 已登记 | 维持 |
| 9 | `context-length-exceeded` | ❌ 缺失 | ❌ 缺失 | 回落文本正则 → 误判 ended/provider_fault（高频路径） | **专属分类**：KEBAB_KIND_TO_SOFT 新增 `'context-length-exceeded': 'context'`（SoftFailureKind 联合扩展）或并入 `provider_fault`；KEBAB_TO_DOMAIN → S5；文案建议「上下文已超限：本轮对话过长，系统已自动压缩或需新建会话」 |
| 10 | `aborted` | ❌ 缺失 | ❌ 缺失 | 回落文本正则 | 映射 `'ended'`（用户取消/中断语义，S6 域） |
| 11 | `payload-too-large` | ❌ 缺失 | ❌ 缺失 | 回落文本正则 | 映射 `provider_fault`（S5，沿用文案） |
| 12 | `invalid-request` | ❌ 缺失 | ❌ 缺失 | 回落文本正则 | 映射 `provider_fault`（S5，沿用文案） |
| 13 | `unknown` | ❌ 缺失 | ❌ 缺失 | 兜底 S6 | **不登记**（兜底码），漂移测试断言其确被前端兜底路径处理（豁免需注释理由） |

**CoreError kind 说明（不在本缺口内）**：命令面错误走 `CoreError {kind, detail}`（conex-types 权威定义，6 类枚举），前端经 `classifyErrorDomain` 文本正则 + `extractErrorKind`（tauriInvoke.ts:72-102）处理，不属于 provider kebab 码表；**漂移测试范围明确排除 CoreError kind，注释声明理由**（两套协议并行设计，04 §4.1 已确认不混流）。

### 3.2 任务表（3 任务）

| 任务 | 文件 | 动作 |
|---|---|---|
| T3.1 | 新增 `apps/crish-desktop/src/api/kebab-codes-drift.test.ts` | 仿 `packages/shared-types/src/errors/codes-drift.test.ts:28-41` 抽取模式：`readFileSync` 读 `crates/session-loop/src/loop/handlers/stream_error.rs`，正则从 `kind_str` 匹配抽取 13 码（`ProviderErrorKind::\w+ => "([a-z-]+)"`，对齐 :305-319 形态；用 locateRepoRoot 上溯模式，参照 commandManifest.test.ts:184-194）；双向断言：`KEBAB_KIND_TO_SOFT` 键集 ∪ `KEBAB_TO_DOMAIN` 键集 == Rust 13 码 - 豁免（`unknown`，注释豁免理由 + 断言 `classifySoftFailure` 兜底路径命中 S6/文本正则）；**有效性自证**：注释写明「故意改一侧立即红」的验证方法 |
| T3.2 | `apps/crish-desktop/src/api/userFacingErrors.ts` | 码表扩展（建议表，用户裁决后执行）：KEBAB_KIND_TO_SOFT 补 `context-length-exceeded`（专属 `context` 分类，SoftFailureKind 联合扩展）/ `aborted`（`'ended'`）/ `payload-too-large` / `invalid-request`（`provider_fault`）；KEBAB_TO_DOMAIN 补 4 键（context-length-exceeded→S5、aborted→S6、payload-too-large→S5、invalid-request→S5）；`classifySoftFailure`/`classifyErrorDomain` 的 kebab 分支无需改（码表驱动） |
| T3.3 | 文案表 | `context-length-exceeded` 专属文案 + S5/S6 复用文案经用户裁决后落入 DOMAIN_MESSAGES/分类文案（本轨只补码表映射，不重写六域文案表——30-01 边界：文案表归 error-notification-governance 轮次 T-2，避免双轮冲突） |

**完成判据**：13 码全覆盖双向断言绿（unknown 豁免 + 兜底断言）；`context-length-exceeded` 有专属分类与文案；改任一侧码表立即红（测试有效性自证）；Rust 侧零改动（kind_str 是权威源）。

---

## ④ 归一器与生成类型漂移锁定（04-⑤）

### 4.1 现状事实（实读）

- 双轨机制：strict 生成 parser 优先（parseBridgeEvent :876-885），宽容归一器兜底（:887-899），legacy 信封（:901-903），未知 parseErr 显式登记（:905，EventRouter.ts:144-154 消费）。
- ENGINE_NORMALIZERS **42 键**（eventParser.ts:399-859，修正 M1）：38 canonical + 4 历史别名（text-delta / run-completed / run-failed / run-cancelled）。
- ENGINE_EVENT_TYPES **41 键**（packages/shared-types/src/generated/engine/events.ts:360-361）。
- 静默默认值 4 处：`normalizeRunTerminal` 兜底 `completed`（:224，**非安全向**）；`isToolCategory` 兜底 `'terminal'`（:264，**非安全向**）；`isAuditOperation` 兜底 `'command-exec'`（:848）、`isAuditDecision` 兜底 `'denied'`（:851，**安全向 fail-closed**）。
- 深度守卫：生成 parser 256 层（parser.ts:65-100）；宽容路径 `normalizeDeltaBlock`（:178）/`normalizeBatchCalls`（:255）无守卫，仅靠 EventRouter 顶层 try/catch（EventRouter.ts:109-115）兜底。

### 4.2 任务表（4 任务）

| 任务 | 文件 | 动作 |
|---|---|---|
| T4.1 | 新增 `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser.normalizer-drift.test.ts` | ① 键集双向断言：ENGINE_NORMALIZERS 键集 ∖ 4 历史别名 == ENGINE_EVENT_TYPES ∖ {subagent-started, subagent-event, subagent-ended}（3 个 subagent 走 legacy 信封、注释声明不要求归一器）；历史别名显式标注（text-delta / run-*）；新增事件类型若缺归一器 → 红（把「新增事件流程」从人肉检查变测试强制）；② 每条归一器选代表性样本输入（含边界样本），断言输出对象经生成 parser 类型可 zod 解析通过（运行时校验，引用 `packages/shared-types/src/generated/engine/parser.ts` 的 parseEngineEvent 或等价解析函数）；③ 输出形状与生成类型 `expectTypeOf` 双向相等（对齐 `packages/shared-types/src/type-drift.test.ts:51-55` 模式）；样本集注释为「事件面回归基线」，后续 Rust 新枚举/新字段变更必须同步补样本 |
| T4.2 | 同 T4.1（并入同文件） | 静默默认值测试：4 处兜底各补测试——未知值进兜底时有日志（vi.spyOn logInternalError）或保留原始值显式登记；断言「非安全向不再静默降级」 |
| T4.3 | `eventParser.ts` | 静默默认值显式化：① `normalizeRunTerminal`（:224）：未知 terminal 不再静默降级 `completed`——改为保留原始值并在返回对象顶层带 unknown 标记（或至少 `logInternalError` 登记后回退 completed，二选一由执行 Agent 按消费方宽容度定，默认前者）；② `isToolCategory`（:264）：同上处理（失败路径显式化）；③ `isAuditOperation`/`isAuditDecision`（:848/:851）：**安全向 fail-closed 保留兜底**，补注释 + 测试锁定「未知值进兜底时有日志」（不改变行为，只补可观测） |
| T4.4 | `eventParser.ts` + 测试 | 宽容路径深度守卫：`normalizeDeltaBlock`/`normalizeBatchCalls` 补深度上限检查（复用生成 parser 的 256 层常量语义，parser.ts:65-100），超限返回可识别失败（normalizeBatchCalls 已返回 null 语义可直接复用）；测试补深层载荷用例（257 层拒绝、256 层放行）——不依赖 EventRouter 顶层 try/catch 兜底 |

**完成判据**：归一器样本全部通过生成 parser 校验；新增事件类型无归一器即红；Rust 新枚举值不再被静默降级（显式登记可观测）；安全向兜底有日志锁定；深度守卫不依赖顶层 catch；既有事件解析 suite（eventParser 相关）回归全绿。

---

## ⑤ 契约漂移总门禁设计（04-⑥）

### 5.1 抽取式契约测试（T5.1）

新增 `apps/crish-desktop/src/api/transport/command-contract-drift.test.ts`（vitest，unit 项目自动覆盖，无需 CI 改动——M6）：

- **Rust 真源抽取**：`main.rs` 注册宏（:90-209）正则抽取注册键集合 + `command_manifest.rs` registered=true 集合（对齐 commandManifest.test.ts:184-194 的 locateRepoRoot + `extractRustManifestNames` 先例；读失败 fail 不 skip + 哨兵计数防摆设化——commandManifest.test.ts:6-7 教训）；
- **前端 invoke 字面量抽取**：扫描 `apps/crish-desktop/src` 生产文件（排除 `*.test.ts`、`test-setup*`、`generated/`），正则匹配 `invoke('X'` / `invokeTyped('X'` / `invokeResult('X'` / `invokeCmd('X'` / `transport.request('X'` 的字符串字面量（含 tauriTransport 层 request 通道——审计 §2.4 已确认 transport 面是命令消费主通道）；
- **断言一（零断链）**：每个前端 invoke 字面量 ∈ Rust 注册键集（∪ manifest registered 集，两者应以 rename 后一致）；
- **断言二（零幽灵）**：注册键集 ⊆ 前端 invoke 字面量 ∪ 显式豁免集（豁免集 = 退役中命令 + 登记先行 + 测试/工具专用，每条注释理由；幽灵清零后豁免集应趋空）；
- **动态拼接处理**（04 ⑥风险 7）：抽取正则覆盖静态字面量；动态拼接面单独维护白名单（启动时如无动态拼接则声明「全静态」并断言 0 个 `invoke(\`` 模板串）；
- **测试有效性自证**：注释写明校准流程 + 「临时改一个调用名/加一条注册即红」的验证方法（对齐 codes-drift.test.ts 做法）。

### 5.2 校准流程（T5.2，批次 9.2 收尾）

1. 本轨（批次 6）落地 6.2/6.3 后，跑 T5.1 得首版结果：断链/幽灵应清零、豁免集 = 退役清单 + 登记先行 4；
2. 误报清零（抽取正则误配，如注释里的字面量）→ 修正则不修数据；
3. 批次 9.2 复核豁免集是否趋空（接线项完成后续可缩小豁免）；
4. 快层 CI 已自动覆盖（unit project include，M6）——批次 9.2 的「接线」动作 = 校准复核 + 注释同步，无 yml 改动。

### 5.3 现有测试的扩展点（不改动面，注明复用）

| 现有资产 | 复用点 |
|---|---|
| `commandManifest.test.ts:184-194` locateRepoRoot / extractRustManifestNames | T5.1 的 Rust 真源抽取骨架（直接复制改造） |
| `commandManifest.test.ts:6-7` 读失败 fail 不 skip + 哨兵计数 | T5.1 防摆设化纪律 |
| `codes-drift.test.ts:28-41` readFileSync + 正则抽取 | T3.1 kebab 码表抽取模式 |
| `type-drift.test.ts` satisfies + expectTypeOf | T4.1 归一器输出形状对照模式 |
| ci.yml vitest-fast（:64-81）| 新测试零配置进快层（unit include） |
| `manifest_count_matches_registered_surface`（command_manifest.rs:200-215）+ `registration_surface_matches_manifest`（main.rs:486-499） | Rust 侧条数/注册面守门（T2.12 同步更新） |

### 5.4 完成判据

断链/分裂/幽灵任何一项回归（前端调用名漂移、Rust 删改注册、manifest 条目漂移）立即红；T1.2/T1.3 的纸面铁律被测试固化；此后每轮迭代自动守护，不再依赖人工 grep 审计。

---

## ⑥ invokeCmd 吞错迁移收尾（04-⑦）

### 6.1 迁移清单（生产 13 处，实测修正 M2）

| # | 文件:行号 | 命令 | 迁移策略（invokeTyped 三态 → 既有行为等价） |
|---|---|---|---|
| 1 | backgroundTasksApi.ts:699 | workbench_list_background_tasks | ok→parse；missing→[]；error→logInternalError + [] |
| 2 | backgroundTasksApi.ts:712 | workbench_get_background_task_output | ok→parse；missing→''；error→logInternalError + ''（保留外层 try/catch 语义） |
| 3 | backgroundTasksApi.ts:735 | workbench_cancel_background_task | ok→parse；missing/error→null + logInternalError |
| 4 | backgroundTasksApi.ts:807 | workbench_cancel_background_task（第二调用点） | 同上 |
| 5 | hostOpenersApi.ts:64 | workbench_list_host_openers | ok→parse；missing→[]；error→logInternalError + [] |
| 6 | hostOpenersApi.ts:78 | workbench_list_file_openers | 同上 |
| 7 | rustCore.ts:73 | core_compact_messages | 保留 fallback 语义：missing/error → 返回现有兜底值（{messages, tokensConsumed:0,...}）+ logInternalError |
| 8 | rustCore.ts:78 | core_count_tokens | missing/error → text.length 兜底 + logInternalError |
| 9 | rustCore.ts:90 | core_check_command | missing/error → 'Allowed' 兜底 + logInternalError |
| 10 | rustCore.ts:119 | core_compute_diff | missing/error → 空 hunks 兜底 + logInternalError |
| 11 | workflowRunner.ts:82 | list-workflows | ok→parse；missing/error→[] + logInternalError |
| 12 | workflowRunner.ts:205 | list-workflow-runs | 同上 |
| 13 | skillsApi.ts:417（tryInvokeTauri 别名，import :13） | workbench_discover_skills | ok→data；missing→null/[] + logInternalError |

**T6.1 迁移规则**：
- rustCore 4 处（7-10）为「worker 回退路径」——迁移后保留三态分支：missing → 回退 worker/兜底、error → logInternalError 再回退（04 方案明确此纪律）；测试面同步 mock 键（rustCore 相关单测）；
- workflowRunner.ts:149 注释自证的「invokeCmd 会把成功 null 与失败 null 混为一谈」缺陷随迁移消除（deleteWorkflow :150-159 已是 invokeResult 先例，list* 两处照搬该模式）；
- `invokeCmd` 定义保留（tauriInvoke.ts:191，兼容测试面：test-setup.test.ts:57-124 的 invokeCmd 行为测试继续存在）；生产代码零引用。

**T6.2 门禁**：`rg "invokeCmd" apps/crish-desktop/src --glob '!*.test.ts' --glob '!api/tauriInvoke.ts'` 零命中。

**完成判据**：生产代码 invokeCmd 零残留；错误 kind/message 全程可观测（error-notification-governance 轮次 T-1/T-2 可消费的干净错误流）；相关单测（backgroundTasksApi.test / hostOpenersApi.test / workflowRunner.test / rustCore 相关）全绿。

---

## ⑦ 验证与提交

### 7.1 每步验证矩阵

| 任务组 | Rust 侧 | 前端侧 | 专项门禁 |
|---|---|---|---|
| 6.2 分裂 rename | `cargo test`（壳测试 registration_surface_matches_manifest 等） | `npm run typecheck` + workspaceFsApi/importFsHost/desktopNativeFeatures suites | grep 裸键生产零命中 |
| 6.3 幽灵裁决 | `cargo test`（manifest 测试族 :203-215 + main.rs:486-499） | `npx vitest run src/api/transport/commandManifest.test.ts src/api/transport/commandMap.test.ts` | 条数公式双端一致（87/83/4 或 86/82/4）；changelog 登记可查 |
| 6.4 错误码 + 归一器 | 零改动（只读） | `npx vitest run src/api/kebab-codes-drift.test.ts src/api/chat-bridge/handlers/eventParser.normalizer-drift.test.ts` + typecheck | 故意改一侧码表/键集即红（有效性自证） |
| ⑥ 契约门禁 | 零改动 | `npx vitest run src/api/transport/command-contract-drift.test.ts` | 误报清零后进快层 |
| ⑦ 吞错迁移 | 零改动 | `npx vitest run`（5 文件相关 suites）+ typecheck | grep invokeCmd 生产零命中 |

### 7.2 批次 6 提交清单（按子任务分组，精确 add 本域文件，提交信息带批次号）

| 提交 | 内容 | 备注 |
|---|---|---|
| 6.2-a | T1.1-T1.3（Rust rename + 注释铁律） | 单独提交（Rust 面） |
| 6.2-b | T1.4-T1.7（前端调用点 + 测试 + grep 门禁） | 与 6.2-a 同轮但可分提交（双端同轮推进） |
| 6.3-a | T2.7-T2.11 退役 5 条（main.rs + command_manifest.rs + commandManifest.ts + commandMap.ts + 对应测试） | **条数公式双端同步必须同一提交**（T2.12 随行） |
| 6.3-b | T2.2（裁决后接线或退役）、T2.4、T2.5、T2.6 接线项 | 每项独立小提交 |
| 6.3-c | changelog 登记（33-event-schema-changelog.md） | 与退役提交同批或紧随 |
| 6.4-a | T3.1-T3.2（kebab 漂移测试 + 码表） | 文案 T3.3 待用户裁决后并入 |
| 6.4-b | T4.1-T4.4（归一器对照测试 + 显式化 + 深度守卫） | 行为改动（T4.3）独立于测试提交 |
| 6.5-a | T5.1 契约门禁测试（首版 + 校准） | 随 6.3 后落地；批次 9.2 只做校准复核 |
| 6.6-a | T6.1-T6.2 吞错迁移（5 文件 + 测试 + grep 门禁） | 文件面与 6.2/6.3 错开，可与 6.4 并行 |

### 7.3 全量验证收尾（批次 9.3 复跑口径）

`cargo test --workspace` + `npm run typecheck` + 快层 `npm run test:coverage -- --project=unit`（45/70/65/45 阈值）+ 中层 vitest 全量；5 个 markdown-editor e2e 专项（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）回归保留；`reference/markdown-editor` 门禁不受本轨影响（引擎代码零改动）。

---

## ⑧ 风险

| # | 风险 | 影响面 | 缓解 |
|---|---|---|---|
| R1 | **rename 断链面**：旧键 select_folder 等从「可 invoke」变「不存在」，任何未 grep 到的调用方（旧 dist 产物、第三方脚本）断链 | 6.2 | 发布前全仓 + dist 产物 grep 复核（04 ⑥-6）；本仓 5 调用点已全量实证（§1.2），本地应用无外部消费面 |
| R2 | **条数公式连锁**：92/88/4 被双端测试锁定（command_manifest.rs:203-215 + commandManifest.test.ts:44-45），退役 5-6 条必须同轮双端同步，否则 cargo/vitest 双红 | 6.3 | T2.12 强制同提交；提交清单已显式分组 |
| R3 | **md_render 真实生效后的输出差异**：Rust 渲染首次进入主路径，个别 case 与 JS 渲染不一致 → 用户可见变化 | T-A 遗留 | 已由 T-A 批次 1 的 parity byte 兼容断言承接；fallback 保留；本轨 T2.1 只验收不复修 |
| R4 | **telemetry 接线后的真实落盘**：errorStack 含路径/上下文落盘（敏感面） | T-A 遗留 | WorkspaceFsGuard 越界拦截（core_commands.rs:580-585）；logs 目录轮转策略为工程卫生项（非阻断，登记） |
| R5 | **归一器显式化回归**：未知 terminal 从静默降级变显式登记，run-terminal/message-end 高频路径可能新增错误播报 | 6.4 | EventRouter 对 unknown 已有显式登记（:144-154 不静默吞）；回归 message-end/run-terminal 高频路径；与 error-notification-governance 展示面收敛衔接 |
| R6 | **kebab 码表红线化**：Rust 新增 ProviderErrorKind 后前端码表必须同轮提交（跨仓库双提交成本） | 6.4 后续 | 77 码 codes-drift 先例已证明流程可承受；unknown 豁免注释理由防滥用 |
| R7 | **⑥ 门禁正则误报/漏报**：invoke 字面量动态拼接漏检、注释误配 | 6.5 | 静态字面量全覆盖 + 动态拼接白名单 + 以当前基线校准（误报清零才进快层）；防摆设化（fail 不 skip + 哨兵计数） |
| R8 | **与并行维度边界**：highlight 接线与 07 方向相反；core_md_render_batch 预热与 07 渲染恢复交叉；错误码文案与 error-notification-governance T-2 交叉 | 6.3/6.4 | 接线跟随 07 定稿；批量预热只覆盖完成态消息；本轨只补码表映射不重写文案表 |
| R9 | **commandMap 白名单删除连带**：core_read_run_events 白名单条目删除后 commandMap.test.ts:47 断言需同步，漏改则快层红 | 6.3 | T2.9 显式包含 commandMap.test.ts 同步 |
| R10 | **T2.6 config_get 接线面**：补读面可能暴露 Rust 配置与前端状态漂移（P2-8 衍生） | 6.3 | 只补读、不重建状态流；missing/error 静默 null；与 T-E 轨道（状态治理）边界明确 |

---

## 附：任务数统计与验收物清单

- **任务总数**：T1.1-T1.7（7）+ T2.1-T2.12（12）+ T3.1-T3.3（3）+ T4.1-T4.4（4）+ T5.1-T5.2（2）+ T6.1-T6.2（2）= **30 任务**（其中 T2.1/T2.3 为验收性零代码任务）。
- **验收物**：① 四表一致基线（wire 键 = 宏名 = manifest = 前端调用名）；② 幽灵清零后的 manifest/快照/条数基线 + changelog；③ kebab 13 码双端一致基线；④ 归一器样本集（事件面回归基线）；⑤ 契约漂移门禁基线（此后每轮迭代自动守护）；⑥ 三态化调用面（error-notification-governance 轮次可消费的干净错误流）。

（本文档完——实读复核 2026-08-09 工作区；行号如仓库继续演进，以语义定位优先，30-03 抽查教训复用。）
