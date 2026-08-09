# 【前后端通信】修复方案（frontend-audit 20-proposals / 04）

- 提案日期：2026-08-09
- 依据：`docs/frontend-audit/10-analysis/04-frontend-backend-communication-audit.md`（3 断链 / 4 分裂 / 11 幽灵）+ `docs/frontend-audit/00-cross-analysis.md`（P0-2 断链命令为全前端最高优先级功能缺陷之一）+ `docs/error-notification-governance/00-cross-analysis.md`（错误传播面，仅浏览参考）
- 性质：只读 + 方案文档。所有决策均经实读代码复核，证据以 `文件:行号` 给出。
- 范围：命令 invoke 面（断链 / 分裂 / 幽灵）、错误码双向覆盖、事件归一器与生成类型漂移锁定。事件面五重锁定链本身健康（events.rs → engine-events.json → registry_drift → 生成器 → CI diff），不在本方案动结构，只补其缺口（归一器双轨）。

---

## ① 目标态（命令/事件契约单一真源）

| 维度 | 现状（审计证据） | 目标态 |
|------|------------------|--------|
| 命令契约真源 | 事实真源 = `command_registry!` 注册面（main.rs:79-88），但**生效 wire 键 = Tauri 宏按函数名或 rename 展开**，存在「函数名 = invoke 键」的隐规则（main.rs:112-118 注释自证，fs 4 条因此分裂）；manifest / 前端快照只是镜像 | **wire 键显式化**：每条注册命令的 invoke 键必须与 manifest 登记名逐字一致，不允许「函数名隐式 = wire 键」；三表（注册面 / manifest / 前端快照）一致性由双端测试 + 双向漂移门禁锁定 |
| 断链 / 分裂 / 幽灵 | 3 断链（md_render / highlight_code / perf_jsonl_append，功能自始未生效或永久静默失败）+ 4 分裂（fs workbench_*）+ 11 幽灵（注册面自洽、前端无消费） | **三清零**：前端调用名 = wire 键（零断链）；wire 键 = manifest 名（零分裂）；注册面命令全部有消费或已退役（零幽灵） |
| 错误码覆盖 | Rust provider kind 13 码（stream_error.rs:305-319）vs 前端 kebab 码表 8 码 + 域表 6 码（userFacingErrors.ts:65-75、121-128），5 码回落文本正则，`context-length-exceeded` 高频路径误判 | **13 码完整双向覆盖**：Rust kind_str × 前端码表双向漂移测试（对齐 codes-drift.test.ts:28-41 模式），每码有明确分类与文案，`context-length-exceeded` 专属分类 |
| 事件归一器 | 宽容归一器（eventParser.ts ENGINE_NORMALIZERS，40 键）手写双轨，不在五重锁定链内；输出形状与生成类型无对照测试；terminal/category 静默默认吞噬新枚举（eventParser.ts:224/264） | **双轨漂移锁定**：归一器输出样本 vs 生成类型有运行时 + 类型级对照测试（对齐 type-drift.test.ts 模式）；静默默认值显式化（安全向 fail-closed 保留、非安全向改显式 unknown 登记）；新增事件流程把归一器纳入检查清单 |
| 调用面 | 旧 `invokeCmd` 吞错残留 19 处（backgroundTasksApi / hostOpenersApi / skillsApi / rustCore / workflowRunner），missing/error 信息静默丢失（audit §2.5，P2-7） | **三态化收尾**：生产代码 invokeCmd 零残留，错误 kind/message 全程可观测 |
| 契约防回归 | 无「前端 invoke 字面量 × Rust 注册键」双向测试——本次断链/分裂正是靠人工 grep 才发现，此前无任何门禁能拦 | **漂移测试总门禁**：从前端生产代码抽取 invoke 字符串字面量，与 Rust 注册面双向对照，断链/幽灵回归即红（见步骤 6） |

**架构目标一句话**：命令面的「注册宏 → manifest → 前端快照 → 运行时对照」四重一致性机制保留并补全（它是好基建，断链发生在机制未覆盖的「函数名隐规则」与「前端调用名」两处），把双端手工同步的每一条缝都换成编译期/测试期强制——目标是「改任一侧不同步立即红」，而不是「靠人记得同步」。

---

## ② 断链命令决策与修复（P0-2）

### 2.1 md_render / highlight_code —— 决策：前端改调真实键，Rust 零改动

**结论先行：Rust wire 键与 manifest 已完全对齐（rename 生效），唯一错位在 `rustCore.ts` 的两个调用名字面量。前端改名即修复，Rust 侧加别名是负收益方案。**

决策依据（实读复核）：

| 事实 | 证据 | 对本决策的意义 |
|------|------|----------------|
| Rust 生效 wire 键 = `core_md_render` / `core_highlight_code`（rename 显式声明） | markdown_commands.rs:22、67 | 真实键就是这个，不存在「Rust 没实现」的问题 |
| manifest 已登记 `core_md_render` / `core_highlight_code`（registered=true） | command_manifest.rs:147、150 | manifest 与真实键一致，三表中只有前端调用名错位 |
| 前端内置快照已镜像 `core_md_render` / `core_highlight_code` | commandManifest.ts:132、135 | 快照也一致 |
| 前端唯一断链调用点：`'md_render'`（rustCore.ts:171）、`'highlight_code'`（rustCore.ts:186） | rustCore.ts:171、186 | 改动面 = 2 个字符串字面量（+ 测试面，见步骤 1） |
| md_render 有真实消费链：`markdownRenderAsync.ts:4` import renderMarkdown → `parseMarkdownToHtmlAsync` 优先 Rust 路径，missing 才回退 worker（markdownRenderAsync.ts:37-48） | markdownRenderAsync.ts:4、39-43 | **改名后能力真实生效**：长会话首屏 4-15s 卡顿的 Rust 加速（markdown_commands.rs:4 设计意图）第一次被接通 |
| 别名方案（Rust 再注册 `md_render` 别名）需：manifest 增 2 条目 + 快照增 2 条目 + 条数公式 92→94 双端同步 + 命令名唯一测试重写 + 幽灵排除测试重排 | command_manifest.rs:200-295、commandManifest.test.ts:44-45 | 别名方案改动面大于修复本身，且让「函数名=wire 键」隐规则继续存活一个反例——与目标态（wire 键显式化）背道而驰 |

**修复动作**：rustCore.ts:171 `'md_render'` → `'core_md_render'`；rustCore.ts:186 `'highlight_code'` → `'core_highlight_code'`；同步修 rustCore.ts:157 注释中的旧命令名清单（注释漂移，见⑤-5）。

**注意（新发现，见⑤-2）**：`highlightCode`（Rust 高亮通道 wrapper）改名后**仍无生产消费者**——全仓 grep 确认唯一消费 `renderMarkdown`，所有高亮消费走 `codeHighlight.ts`（JS highlight.js）与 `workers/markdown-render-standalone.ts`。所以 highlight 的「断链修复」只是解除断链状态，**是否激活能力（接线）或退役命令（含 Rust `core_highlight_code` + manifest/快照条目）交由步骤 3 幽灵裁决联动决定**。默认推荐：接线（streamingCodeHighlighter / IncrementalInlineRenderer 的异步高亮路径改走 Rust，收益 = 长代码块高亮不阻塞主线程；与 07 性能维度流式渲染恢复联动）。

### 2.2 perf_jsonl_append —— 决策：接线（前端改名 + 清硬编码），Rust 零改动

**结论先行：Rust 侧 `core_jsonl_append` 已存在且参数签名与 TelemetryMonitor 传入完全匹配，perf/jsonl.rs:5-7 注释自证迁移责任在前端域——前端改名即通，telemetry 落盘立即恢复。**

决策依据：

| 事实 | 证据 | 对本决策的意义 |
|------|------|----------------|
| Rust wire 键 `core_jsonl_append` 已注册且 registered=true | main.rs:190、command_manifest.rs:162 | 目标键存在，无需任何 Rust 改动 |
| 命令签名 `(path, lines, flush, workspace_root)` 与前端传参 `{path, lines, flush, workspaceRoot}` 逐项匹配（workspace_root 经 Tauri 自动 camelCase 映射） | core_commands.rs:546-551、TelemetryMonitor.ts:103-108 | 改名后一次通过，无参数适配 |
| G11a 删除 `perf_jsonl_*` 时注释明确「前端 TelemetryMonitor 旧名调用迁移至 core_jsonl_append 由前端域承接」 | perf/jsonl.rs:5-7 | 这是**已登记的历史迁移任务**，前端域从未执行——补执行即可 |
| 断链后果：每次 flush 都 missing，missing 分支不打印（TelemetryMonitor.ts:109-116 只对 error 打印），缓冲无限回退重试 | TelemetryMonitor.ts:103-126 | 接线后错误日志面（全局 error/unhandledrejection 采集）从永久失效恢复 |
| 硬编码实际两处：logFilePath `c:/Software/conex/apps/crish-desktop/logs/telemetry_runtime.jsonl`（:21）+ workspaceRoot `'c:/Software/conex'`（:107） | TelemetryMonitor.ts:21、107 | 审计只提 :107（P3-14）；两处都必须在接线同轮清掉（新发现，见⑤-4） |

**修复动作**（步骤 1b 细化）：
1. TelemetryMonitor.ts:103 `'perf_jsonl_append'` → `'core_jsonl_append'`；
2. `workspaceRoot` 改为运行时取值：复用 `workspaceFsApi.ts:94-97` 的 `getFsRoot()` 模式（同仓库导出或本地派生）；workspace 未打开时传 `undefined` → Rust 侧 `WorkspaceFsGuard::for_default_workspace()` 兜底（core_commands.rs:575-578），不传机器路径；
3. `logFilePath` 改为运行时派生（如 `<workspace 根>/logs/telemetry_runtime.jsonl` 或应用数据目录），随 workspace 切换；不得保留机器路径字面量；
4. missing 分支（TelemetryMonitor.ts:109-117）补一行可观测日志（`logInternalError`，userFacingErrors.ts:244-249 现成工具），消除「静默失败」；
5. 保留 1000 条 buffer 上限与 5s 定时 flush（:15/25/72-74）——接线后行为不变，只是从「永远落不了盘」变「真实落盘」。

### 2.3 fs 4 命令分裂（workbench_*）—— 决策：Rust 侧加 rename 统一到 workbench_*（见步骤 2 详案）

---

## ③ 分步方案（逻辑顺序，每步可独立提交，每步输出为下一步输入）

### 步骤 1：断链命令修复（对应 00 P0-2）

**任务内容**：
- 1a. `rustCore.ts:171` 改调 `core_md_render`、`:186` 改调 `core_highlight_code`；同步修正 :156-164 注释里的旧命令名清单。
- 1b. `TelemetryMonitor.ts` 按 ②2.2 五项动作执行（改名 + 双硬编码清除 + missing 可观测 + 保留缓冲语义）。
- 1c.（新发现强制项）**测试面同步改名**：`test-setup.ts:57-91` mock 文档注释、`test-setup.test.ts:45/50/116/118`、`markdownRender.parity.test.ts:109/132/166`、`markdownRenderAsync.test.ts` 全部 `mockTauriCommand('md_render')` → `'core_md_render'`。这些测试 mock 的键**从未存在于 Rust 注册面**——不改它们，修复后测试仍在假键上绿（假绿灯，见⑤-1）。
- 1d. 顺带清理 rustCore.ts 内 `highlightCode` wrapper 的悬空：若步骤 3 裁决「接线」则补消费点（可与 07 性能维度联动），若裁决「退役」则在步骤 3 删除 wrapper + Rust 命令。

**涉及文件面**：
- 前端：`apps/crish-desktop/src/api/rustCore.ts`、`apps/crish-desktop/src/services/TelemetryMonitor.ts`、`src/test-setup.ts`、`src/test-setup.test.ts`、`src/api/markdownRender.parity.test.ts`、`src/api/markdownRenderAsync.test.ts`（+ 如有 TelemetryMonitor 单测）
- Rust：零改动（仅读）

**验证方式**：
- `npm run typecheck`
- `npx vitest run src/api/markdownRender.parity.test.ts src/api/markdownRenderAsync.test.ts src/test-setup.test.ts`（mock 名与调用名同步后全绿，且 mock 键 = 真实键）
- grep 门禁：`rg "'md_render'|'highlight_code'|'perf_jsonl_append'" apps/crish-desktop/src` 生产代码零命中（测试面仅允许经统一 mock helper）

**完成判据**：
- 生产代码无旧断链名残留；markdown parity 测试走真实键 `core_md_render` mock 且全绿（Rust 输出与 JS 输出 byte 兼容断言通过）；
- TelemetryMonitor flush 后目标 JSONL 文件真实追加（本地冒烟）；`c:/Software/conex` 机器路径在生产代码零残留；
- **输出**：断链清零 + 调用名基线（步骤 6 漂移门禁的「应然面」初始样本）。

### 步骤 2：分裂标签统一（fs 4 命令，对应 P1-3）

**任务内容**：
- 2a. Rust：`fs_commands/mod.rs` 四个命令加 `#[tauri::command(rename = "workbench_*")]`：
  - `select_folder` → `workbench_select_folder`（mod.rs:18-23）
  - `list_directory` → `workbench_list_directory`（mod.rs:26-32）
  - `read_file_content` → `workbench_read_file_content`（mod.rs:35-42）
  - `write_file_content` → `workbench_write_file_content`（mod.rs:49-57）
- 2b. Rust：删除 main.rs:112-118 的分裂自认注释（分裂消失后注释即死）。
- 2c. 前端调用点改名：`workspaceFsApi.ts:104/156/190`、`importFsHost.ts:117/142` → workbench_* 名；`desktopNativeFeatures.test.ts:245/258/334/341` 同步。
- 2d. 制度项：在 `command_registry!` 宏注释（main.rs:72-78）补写铁律「wire 键 = manifest 登记名；函数名与 wire 键不一致必须显式 rename；禁止函数名隐式成为 wire 键」——步骤 6 的漂移门禁落地前，注释先行。

**决策理由（Option B 而非 manifest 改登记真实键）**：
- family=workbench / surface=gui 是这 4 条的真实归属（GUI 专属文件面），wire 键带 workbench_* 前缀语义自洽；
- 改动面最小：Rust 4 行 attr + 前端 5 调用点 + 1 测试文件；Option A（manifest 登记 select_folder 等）需改 manifest 4 条目 + 注册宏 4 元组名 + 快照 4 条目，且这些键归不进现有任何 family（core/session/config/workbench 都不贴切），还让「函数名=wire 键」隐规则继续存活——与目标态冲突；
- 唯一代价：旧键 `select_folder` 等不再可 invoke。全仓 grep 已确认调用面仅上述 5 处，无外部消费者，风险可控（见⑥-6）。

**涉及文件面**：
- Rust：`src-tauri/src/fs_commands/mod.rs`、`src-tauri/src/main.rs`（注释）
- 前端：`src/api/workspaceFsApi.ts`、`src/api/import/importFsHost.ts`、`src/api/desktopNativeFeatures.test.ts`

**验证方式**：
- `cargo test`（`registration_surface_matches_manifest` main.rs:486-499 与 manifest 测试天然继续通过——注册宏名本来就用 workbench_* 标签，rename 后 wire 键首次与宏名一致）
- `npm run typecheck` + 相关单测（workspaceFsApi / desktopNativeFeatures / importFsHost 相关 suite）
- grep 门禁：`rg "'select_folder'|'list_directory'|'read_file_content'|'write_file_content'"` 生产代码零命中（命令定义面除外）

**完成判据**：
- wire 键 = 注册宏名 = manifest 名 = 前端调用名，四者逐字一致；前端无旧裸键 invoke 残留；
- **输出**：三表一致基线（步骤 6 门禁的对照样本之一）。

### 步骤 3：幽灵命令裁决与落地（11 条，对应 P1-14）

**判定标准（先立规矩）**：
- **接线**：满足任一条 → 接线。① 有前端真实消费意图（存在调用链、设计文档、或状态面已暴露只差触发入口）；② 命令能力有明确收益场景且前端缺入口；③ 接线成本显著低于能力损失。
- **退役**：满足任一条 → 退役并登记 changelog。① 无任何消费意图（功能已被其他路径替代）；② 仅测试隔离/调试用途（Rust 侧可保留函数不占命令面）；③ 与已定架构方向冲突（如流式主路径已定为 JS 零 IPC）。
- 退役落地动作（每条一致）：Rust `command_registry!` 删注册 + `command_manifest.rs` 删条目 + 前端快照删条目 + `manifest_count_matches_registered_surface`（command_manifest.rs:200-215）与 `commandManifest.test.ts:44-45` 条数公式同步 + changelog 登记（`docs/rust-rewrite/33-*` 事件流）。

**裁决表**（完整依据见 ④）：

| # | 命令 | 裁决 | 处置动作 |
|---|------|------|----------|
| 1 | `core_md_render` | 接线（随步骤 1 自动消解） | 步骤 1 改名即通 |
| 2 | `core_highlight_code` | **接线或退役（用户裁决）** | 接线：streamingCodeHighlighter 异步路径改走 Rust；退役：删 wrapper + Rust 命令 + 双端清单条目 |
| 3 | `core_jsonl_append` | 接线（随步骤 1 自动消解） | 步骤 1 改名即通 |
| 4 | `core_md_render_batch` | 接线 | 补 `rustCore.renderMarkdownBatch` + 首屏批量预热（长会话首屏 4-15s 卡顿，markdown_commands.rs:4 设计意图的批量面；Rust 实现完整含缓存，markdown_commands.rs:34-40） |
| 5 | `core_md_render_stream` | **退役（默认）或与 07 维度联动裁决** | 主路径已定 JS IncrementalMarkdownParser 零 IPC（markdown_commands.rs:44-45 自证）；STREAMING_RENDER_PLAN.md:357 的 fallback 接线计划未落地且 07 恢复方案为 JS 帧级增量——Rust 流式命令无消费意图 → 退役 |
| 6 | `core_md_clear_cache` | 退役 | moka 自动 LRU 淘汰（markdown_commands.rs:79-80 自证「正常运行时无需调用」），仅测试隔离用途——Rust 侧测试直接调 `conex_markdown::clear_cache` 函数，不占命令面 |
| 7 | `core_rebuild_search_index` | 接线 | QuickOpen 空态/设置页加「重建索引」入口（`core_search_files` 有真实消费、`searchIndexReady` 状态已暴露诚实面 rustCore.ts:126-152——只差触发入口，是「有意图缺接线」的典型） |
| 8 | `config_get` | 接线 | 配置页/启动补读面（P2-8 配置族只写不读；engineConfig.ts 只调 config_update——补 `config_get` 消费即闭合读面，低风险高价值） |
| 9 | `core_read_run_events` | 退役 | 前端唯一事件读取面消费 `core_read_session_events`（sessionEventHydrate.ts:423）；历史 API 无消费 → 退役 + 同步删 commandMap.ts:33 白名单条目（该条目自身也是幽灵，见⑤-3） |
| 10 | `touch_session` | 退役（默认） | 无消费意图；会话活跃时间戳面无前端依赖证据；如需「会话列表按活跃排序」再恢复（登记 changelog 注明） |
| 11 | `delete_session` | **退役并登记（待存储架构裁决）** | 前端删除走 IndexedDB 本地面（sessionCrudActions.ts:410-420）；Rust `delete_session` 是 LocalDb 面——两者存储关系未明（双存储架构问题超出本维度）。退役命令面并登记 changelog，待存储裁决后决定是否恢复 |

**涉及文件面**：
- Rust：`main.rs`（注册宏）、`command_manifest.rs`（条目 + 条数测试）
- 前端：`commandManifest.ts`（快照）、`commandManifest.test.ts`（条数断言）、`commandMap.ts`（白名单）、接线目标文件（rustCore / QuickOpen / engineConfig / 设置页）
- 文档：changelog 登记（退役 5-6 条）

**验证方式**：`cargo test`（manifest 测试族）+ `npm run typecheck` + `npx vitest run`（commandManifest / commandMap 相关）+ 步骤 6 漂移门禁（落地后）。

**完成判据**：11 条幽灵全部进入「接线生效」或「已退役登记」终态，无第三条路；接线条有真实调用点与测试；退役条双端清单同步、条数公式双端一致、changelog 可查；
**输出**：幽灵清零后的 manifest / 快照 / 条数基线（步骤 6 门禁基线）。

### 步骤 4：kebab 错误码双向覆盖（对应 P2-5）

**任务内容**：
- 4a. 建双向漂移测试 `kebab-codes-drift.test.ts`（放 `apps/crish-desktop/src/api/` 旁 userFacingErrors 测试）：从 `crates/session-loop/src/loop/handlers/stream_error.rs` 的 `kind_str` 匹配抽取 13 码（对齐 codes-drift.test.ts:28-41 的 readFileSync + 正则抽取模式），与前端码表做双向相等断言：
  - `KEBAB_KIND_TO_SOFT` 键集 ∪ `KEBAB_TO_DOMAIN` 键集 == Rust 13 码（除显式豁免码外，豁免需注释说明理由——建议唯一豁免 `unknown`：兜底码无需登记，但测试断言其**确被前端兜底路径处理**）；
- 4b. 补齐 5 码映射（建议表，用户裁决文案）：

| Rust 码 | KEBAB_KIND_TO_SOFT | KEBAB_TO_DOMAIN | 文案建议 |
|---|---|---|---|
| `context-length-exceeded` | 专属分类（新增 `context` 或并入 `provider_fault`） | S5 | 「上下文已超限：本轮对话过长，系统已自动压缩或需新建会话」（高频路径，现回落误判 `ended`/`provider_fault`） |
| `aborted` | `'ended'`（用户取消/中断语义） | S6 | 沿用 ended 文案即可 |
| `payload-too-large` | `provider_fault` | S5 | 沿用 S5 |
| `invalid-request` | `provider_fault` | S5 | 沿用 S5 |
| `unknown` | 不登记（测试断言前端兜底路径命中文本正则或 null 分类） | 不登记 | 兜底 S6 |

- 4c. Rust 侧零改动（kind_str 是权威源）。

**涉及文件面**：
- 前端：新增 `userFacingErrors` 侧漂移测试 + `userFacingErrors.ts` 码表/文案
- Rust：零改动（读 `stream_error.rs`）

**验证方式**：`npm run typecheck` + `npx vitest run`（新漂移测试）；故意改一侧码表确认即红（测试有效性自证，对齐 codes-drift.test.ts 的做法）。

**完成判据**：13 码全覆盖双向断言绿；`context-length-exceeded` 有专属分类与文案；改任一侧码表立即红；
**输出**：kebab 码表双端一致基线（后续 Rust 新增 kind 的同步流程卡点）。

### 步骤 5：归一器与生成类型漂移锁定（对应 P2-6）

**任务内容**：
- 5a. 新增「归一器输出 vs 生成类型」对照测试（`eventParser.normalizer-drift.test.ts`）：为 ENGINE_NORMALIZERS（eventParser.ts:399-859）每条归一器选代表性样本输入，断言：
  - 输出对象经生成 parser 类型（`packages/shared-types/src/generated/engine`）可 zod 解析通过（运行时校验）；
  - 输出形状与生成类型 `expectTypeOf` 双向相等（对齐 `packages/shared-types/src/type-drift.test.ts` 模式）；
- 5b. 归一器键集与生成事件类型键集双向断言（归一器 40 键 vs `ENGINE_EVENT_TYPES` 41 键 + 6 历史别名 text-delta/run-*）：历史别名显式标注，新增事件类型若缺归一器 → 测试红（把「新增事件流程」从人肉检查变测试强制）；
- 5c. 静默默认值显式化：
  - `normalizeRunTerminal` 未知 terminal 兜底 `completed`（eventParser.ts:224）→ 改为保留原始值并在顶层登记 unknown（或至少 `logInternalError`），禁止静默降级为 `completed`；
  - `isToolCategory` 兜底 `terminal`（:264）→ 同上处理（失败路径显式化）；
  - `isAuditOperation` 兜底 `command-exec` / `isAuditDecision` 兜底 `denied`（:848/851）为**安全向 fail-closed**，保留兜底但补注释 + 测试锁定「未知值进兜底时有日志」；
- 5d. 宽容路径深度守卫：`normalizeDeltaBlock` / `normalizeBatchCalls` 对深层载荷补深度上限检查（复用生成 parser 的 256 层守卫常量，parser.ts:65-100），不依赖 EventRouter 顶层 try/catch 兜底（EventRouter.ts:109-115）。

**涉及文件面**：前端 `src/api/chat-bridge/handlers/eventParser.ts` + 新增测试；Rust 零改动。

**验证方式**：`npm run typecheck` + `npx vitest run`（新增对照测试 + 既有事件解析 suite 回归）。

**完成判据**：归一器样本全部通过生成 parser 校验；新增事件类型无归一器即红；Rust 新枚举值不再被静默降级（显式登记可观测）；深度守卫不依赖顶层 catch；
**输出**：归一器样本集（可复用为事件面回归基线）。

### 步骤 6：命令契约漂移测试总门禁（目标态收敛锁）

**任务内容**：
- 6a. 新增 `command-contract-drift.test.ts`（前端，vitest）：仿 codes-drift.test.ts 的双向抽取模式：
  - 从 Rust 真源（`main.rs` 注册宏 + `command_manifest.rs`）抽取注册键集合（readFileSync + 正则，对齐 commandManifest.test.ts 的 `extractRustManifestNames` 先例）；
  - 从前端生产代码抽取 invoke 字面量：扫描 `apps/crish-desktop/src` 生产文件（排除 `*.test.ts`、`test-setup*`、`generated/`），正则匹配 `invoke('X'` / `invokeTyped('X'` / `invokeResult('X'` / `invokeCmd('X'` 的字符串字面量；
  - 断言一（零断链）：每个前端 invoke 字面量 ∈ Rust 注册键集；
  - 断言二（零幽灵）：注册键集 ⊆ 前端 invoke 字面量 ∪ 显式豁免集（豁免集 = 退役中命令 + 登记先行 + 测试/工具专用，注释说明理由）；
- 6b. 豁免集维护规则写入测试注释：退役命令必须在豁免集 + changelog 双登记，幽灵清零后豁免集应趋空；
- 6c. 接 CI 快层（对齐 ci.yml 快层 vitest 口径）。

**涉及文件面**：前端新增测试 + CI 配置（读 ci.yml:99-113 的 engine-bindings-drift job 模式）；Rust 零改动。

**验证方式**：`npm run typecheck` + 快层 vitest；模拟回归（临时改一个调用名/加一条注册）确认即红。

**完成判据**：步骤 1-3 的成果被测试固化——断链/分裂/幽灵任何一项回归（前端调用名漂移、Rust 删改注册、manifest 条目漂移）立即红，不再依赖人工 grep 审计；
**输出**：契约漂移门禁基线（此后每轮迭代自动守护）。

### 步骤 7：invokeCmd 吞错迁移收尾（对应 P2-7）

**任务内容**：
- 7a. 迁移清单（生产 12 处 + skills 别名面）：`backgroundTasksApi.ts:699/712/735/807`、`hostOpenersApi.ts:64/78`、`rustCore.ts:73/78/90/119`（worker 回退路径保留三态分支：missing → 回退 worker、error → 记日志再回退）、`workflowRunner.ts:82/205`、`skillsApi.ts`（tryInvokeTauri 别名）→ 全部迁 `invokeTyped`，错误信息进 `logInternalError` 或透传；
- 7b. workflowRunner.ts:149 注释自认的「成功 null 与失败 null 混为一谈」问题随迁移消除（见⑤-6）；
- 7c. `invokeCmd` 定义保留（兼容测试面），生产代码零引用。

**涉及文件面**：前端 5 文件 + 相关单测（backgroundTasksApi.test / hostOpenersApi.test / workflowRunner.test / test-setup.test）。

**验证方式**：`npm run typecheck` + 相关单测全绿 + grep 门禁 `rg "invokeCmd" apps/crish-desktop/src --glob '!*.test.ts'` 零命中。

**完成判据**：生产代码 invokeCmd 零残留；错误 kind/message 全程可观测（错误传播面 04 审计 §4.1 的路径补全最后一段）；
**输出**：三态化调用面（error-notification-governance 轮次的 T-1/T-2 可直接消费的干净错误流）。

---

## ④ 幽灵 / 分裂裁决表（汇总）

### 4.1 分裂 4 条（步骤 2）

| manifest 登记名 | 当前真实键 | 裁决 | 依据 |
|---|---|---|---|
| `workbench_select_folder` | `select_folder` | rename 对齐 workbench_* | fs_commands/mod.rs:18-23；GUI 专属面语义；改动面最小（②决策） |
| `workbench_list_directory` | `list_directory` | rename 对齐 | fs_commands/mod.rs:26-32 |
| `workbench_read_file_content` | `read_file_content` | rename 对齐 | fs_commands/mod.rs:35-42 |
| `workbench_write_file_content` | `write_file_content` | rename 对齐 | fs_commands/mod.rs:49-57 |

### 4.2 幽灵 11 条（步骤 3）

| 命令 | 归类（审计） | 裁决 | 一句话依据 |
|---|---|---|---|
| `core_md_render` | 接线缺口（下游） | 接线 | 步骤 1 改名即通，有真实消费链 |
| `core_highlight_code` | 接线缺口（下游） | 接线或退役（用户裁决） | wrapper 无消费（⑤-2）；接线有性能收益、退役成本小 |
| `core_jsonl_append` | 接线缺口（下游） | 接线 | 步骤 1 改名即通，历史迁移任务补执行 |
| `core_md_render_batch` | 接线缺口 | 接线 | 首屏批量渲染性能意图明确（markdown_commands.rs:34-40），缺 wrapper |
| `core_md_render_stream` | 接线缺口 | 退役（或与 07 联动） | 流式主路径 = JS 零 IPC（markdown_commands.rs:44-45 自证） |
| `core_md_clear_cache` | 接线缺口 | 退役 | moka 自动 LRU（markdown_commands.rs:79-80），仅测试隔离用途 |
| `core_rebuild_search_index` | 能力缺口 | 接线 | 有真实消费（core_search_files）+ 诚实状态面，只差触发入口 |
| `config_get` | 能力缺口 | 接线 | 配置族只写不读（P2-8），读面是真实缺口 |
| `core_read_run_events` | 能力缺口 | 退役 | 被 core_read_session_events 取代（sessionEventHydrate.ts:423）；白名单条目同步删（⑤-3） |
| `touch_session` | 能力缺口 | 退役（默认） | 无消费意图、无前端依赖 |
| `delete_session` | 能力缺口 | 退役并登记（待存储架构裁决） | 前端走 IndexedDB 本地面，双存储关系未明 |

接线 6 条（1/3/4/7/8 + 2 待裁决）、退役 5 条（5/6/9/10/11）。

---

## ⑤ 新发现补充（实读代码，审计未覆盖或需修正处）

1. **测试面 mock 名断链（影响步骤 1 正确性）**：`test-setup.ts:57-91` mock 文档、`test-setup.test.ts:45/50/116/118`、`markdownRender.parity.test.ts:109/132/166`、`markdownRenderAsync.test.ts` 全部以 `md_render` 作为 mock 键——该键**从未存在于 Rust 注册面**。只改 rustCore.ts 不改测试，会得到「调用名已修、测试在假键上绿」的假绿灯。步骤 1c 强制同步。
2. **highlight 断链实为双层问题**：`rustCore.highlightCode`（Rust 高亮 wrapper）全仓无生产消费者（grep 验证唯一消费 `renderMarkdown`；高亮消费全部走 `codeHighlight.ts` JS 版 / `workers/markdown-render-standalone.ts`）。审计按「前端只调断链名」归类，但改名后能力仍不生效——接线或退役必须显式二选一（步骤 3 联动）。
3. **commandMap 白名单自身含幽灵条目**：`commandMap.ts:33` 白名单含 `core_read_run_events`，但无生产消费（仅 `commandMap.test.ts:47` 自证），`checkCommandMapConsistency` 对它是永不触发的空转条目。退役 `core_read_run_events` 时必须同步删白名单。
4. **TelemetryMonitor 硬编码两处而非一处**：`:107` workspaceRoot（审计 P3-14 已提）+ `:21` logFilePath `c:/Software/conex/apps/crish-desktop/logs/telemetry_runtime.jsonl`。两处同为机器路径泄漏，接线同轮清除。
5. **rustCore.ts:157 注释命令名清单过时**：注释列 `md_render / md_render_batch / md_render_stream / highlight_code / md_clear_cache` 与实际 wire 键（core_* 前缀）不符——注释漂移，步骤 1 同步修。
6. **workflowRunner.ts:149 注释自证缺陷未修**：注释明言「invokeCmd 会把成功 null 与失败 null 混为一谈」，但 :82/:205 仍用 `invokeCmd`——步骤 7 迁移对象，注释自证「已识别未修」型残留。

---

## ⑥ 风险

1. **md_render 真实生效后的输出差异**：Rust 渲染首次真正进入主路径，若 `conex_markdown` 输出与 JS 渲染在个别 case 上不一致，用户可见变化。缓解：markdownRender.parity.test.ts 的 byte 兼容断言先于上线红；fallback（worker pool）保留，差异只在 Rust 侧修。
2. **幽灵退役的条数公式连锁**：92/88/4 公式被 Rust `manifest_count_matches_registered_surface`（command_manifest.rs:200-215）与前端 `commandManifest.test.ts:44-45` 双端锁定，退役 5-6 条必须同轮双端同步，否则 cargo/vitest 双红；任何未 grep 到的外部调用面（旧 dist 产物、第三方脚本）会断链——发布前全仓 + 产物 grep 复核。
3. **telemetry 接线后的真实落盘**：从「永远失败」变「真实写入」，errorStack 含路径/上下文信息落盘（敏感面）；5000ms 周期 + 1000 条上限保留可收敛；路径经 WorkspaceFsGuard 校验（越界 → InvalidInput，core_commands.rs:580-585），不会静默写盘。需确认 logs 目录轮转策略（工程卫生，非阻断）。
4. **归一器静默默认值显式化**：未知枚举值的 run 事件从「静默降级」变「显式 unknown 登记」——EventRouter 对 unknown 已有显式登记（EventRouter.ts:144-154，不静默吞），UI 流不破坏；但需回归 message-end / run-terminal 高频路径确认无新错误播报（与 error-notification-governance 轮次的展示面收敛衔接）。
5. **kebab 码表红线化**：Rust 新增 ProviderErrorKind 后前端码表必须同轮提交（跨仓库双提交成本）——77 码 codes-drift 先例已证明流程可承受；`unknown` 豁免需注释理由，防豁免滥用。
6. **fs rename 化断链面**：旧键 `select_folder` 等从「可 invoke」变「不存在」。已 grep 确认全部 5 个调用点在本仓内，但需确认旧版本 dist 产物/用户端缓存不直接调裸键（本地应用无此面，风险低）。
7. **步骤 6 抽取正则的误报/漏报**：invoke 字面量动态拼接（如 `invoke(\`core_\${x}\`)`）会漏检。对策：抽取正则覆盖静态字面量 + 动态拼接面单独维护白名单；门禁先以当前 88 键基线校准（误报清零才接 CI），避免「摆设化」（commandManifest.test.ts:6-7 的教训：读失败 fail 不 skip + 哨兵计数）。
8. **与并行维度方案的边界**：步骤 1 的 highlight 接线与 07 性能维度（流式渲染恢复）交叉；步骤 4 的文案与 error-notification-governance 轮次（T-2 差异化六域文案）交叉——高亮接线跟随 07 的流式渲染裁定，文案只补码表映射不重写文案表，避免双轮冲突。
