# PE-01 配置与启动状态真源归一 方案

> 性质：方案设计（只读研究 + 方案文档，不改任何代码）。日期：2026-08-01。
> 范围：apps/crish-desktop/src（前端）+ apps/agent-workbench/src-tauri/src（Rust IPC 壳）
> + crates/conex-db + crates/orchestrator（会话持久化）。
> 输入事实：
> - docs/rust-rewrite/25-ipc-contract-audit.md（§一 提示恒真根因、§二 启动状态机、§四 改造要点）
> - docs/rust-rewrite/audits/AA-02-tauri-shell-review.md（W-3/W-4 打包路径、W-6 状态不诚实、S-6 daemon 残留）
> - docs/rust-rewrite/audits/AA-03-frontend-state-hooks-review.md（Q01 引擎就绪四份复制、Q02/Q03 sessions 竞态、Q05 providerStore 直连 fetch）
> - docs/rust-rewrite/audits/AA-07-data-persistence-review.md（P01 新会话不落库、P02 空 keepIds 级联删除、P05 同步 DB 调用阻塞、P09/P10 清理策略）
> 代码抽查：engineConfig.ts、ChatStatusRibbons.tsx、AppBootstrap.ts、useEngineBootstrap.ts、
> bootstrap-full.ts、tauriTransport.ts、daemonChatBridge/ConnectionLifecycle.ts、
> core_query_commands.rs、session_commands.rs、config/{mod,provider,persistence}.rs、
> host_paths.rs、main.rs、profileStore.ts、sessionRustDb.ts。

---

## 修订记录

| 版本 | 日期 | 修订依据 | 要点 |
|---|---|---|---|
| v1 | 2026-08-01 | — | 初版 |
| v2 | 2026-08-01 | **AU-04 接口冻结裁决** | ① T01.1 字段名 `provider` → `providerStatus`（F2 冻结 v1）；② T03.1/T03.2 命令名按 F5 终态表，commandMap `'update-config'` 映射移交 PE-03 T03.1（C19）；③ T03.3 删除、改引用 PE-07 T07.4-B（D12）；④ T03.4 用户主动路径改走 `config_profile_apply`（引用 PE-07，F5/C6）；⑤ T06 组（T06.1–T06.4）收编 PE-08（D2–D5），任务体删除、只保留引用与域内特有部分；⑥ T04.3/T04.4 按 C17/D7 补命名时序与 hydrationComplete 公共门闩声明；⑦ 行号漂移修正（core_query_commands.rs:330-342、profileStore.ts 明文写点 ~302-306、tauriTransport.ts OR 循环 36-49）；⑧ 主执行顺序声明（main.rs PE-01 首个、core_query_commands.rs 字段基线 PE-01 先行） |

---

## 一、问题矩阵（域内五类问题 → 根因 → 任务归属）

| # | 用户可见问题 | 根因链（审查证据） | 任务 |
|---|---|---|---|
| P1 | 「本地密钥待同步到引擎」提示恒真 | Rust `core_get_status` 无 provider 字段（core_query_commands.rs:49-62）+ 前端 `parseEngineStatusFromRaw` 字段缺失缺省 `hasApiKey=false`（engineConfig.ts:424-429）→「引擎通 + 引擎无 key + 本地有 key」三条件每次启动恒成立（25-audit §1.2） | T01.1、T02.1、T02.2 |
| P2 | 配置双轨、真源漂移 | localStorage `crish_provider_profiles_v1` 明文 apiKey（profileStore.ts:30,310-318）与 Rust `ApiConfigStore`（provider-config.json + *.dpapi，persistence.rs:11-14）双真源；前端从不调用 Rust 配置读命令（25-audit §1.3「全为死面」）；启动即 `syncActiveProfileToEngine` 推明文进 Rust（AppBootstrap.ts:300-304） | T03.1–T03.4 |
| P3 | 启动重复、状态不诚实 | AppBootstrap effect3/effect7 与 useEngineBootstrap 逐字重复三份（AA-03 Q01）；12s gateTimer 无条件强制 ready（AppBootstrap.ts:316-321）与 15s 超时离线回退互相矛盾（25-audit §2.4-2）；`isCoreReady` 用 engineReady/dbReady/searchIndexReady **任一 true 即就绪**（tauriTransport.ts:46-62）稀释语义；compaction_ready 硬编码 true、initialized 恒 true（AA-02 W-6） | T01.2、T02.3、T04.1–T04.4 |
| P4 | 打包后持久化失效 | host_paths.rs:7 `env!("CARGO_MANIFEST_DIR")` 编译机路径打包后不存在（AA-02 W-3）；config_dir 硬编码 `%APPDATA%\Crish\AgentWorkbench`（W-4），配置与 DB 分裂 | T05.1、T05.2 |
| P5 | 新会话不落库、空 keepIds 全删 | 无任何命令创建 sessions 行，save_session_body 受 FK 阻塞 → 静默回退 LS（AA-07 P01）；cleanup_orphan_sessions 空 active_ids 全表删除 + 清空 LS 索引（P02）；30 天清理与真相源冲突（P09）；懒壳正文被清理打中（P10）；LocalDbStore 同步阻塞 tokio 线程（P05） | 引用 PE-08（T08.1/T08.2/T08.5），本域 T06 组收编（AU-04 D2–D5） |

---

## 二、目标与边界

### 2.1 目标（可验收的终态）

1. **提示诚实**：`core_get_status` 回补 `providerStatus` 配置状态（hasApiKey/model/baseUrl/credentialMode）
   ——字段名冻结 v1，见 AU-04 F2（`provider` 名作废，仅前端解析层保留只读兼容路径）；
   前端 `hasApiKey` 三态化（`boolean | undefined`，undefined = 未知）；删除 sync-engine 提示分支
   与文案（进程内引擎不存在「同步到引擎」概念）。
2. **配置单真源**：Rust `ApiConfigStore`（provider-config.json + `secrets/{id}.dpapi` DPAPI）为唯一真源；
   localStorage 降级为草稿缓存且**不再存明文 key**；首次启动自动迁移旧明文并清除；
   删除启动时 `syncActiveProfileToEngine`（无 daemon 可同步）。
3. **启动单实现**：引擎就绪初始化收敛为单一实现；删除 12s gateTimer 无条件置位；
   `isCoreReady` 明确聚合为 `engineReady`（provider 齐备）单一主判据，dbReady 独立暴露给会话层。
4. **状态真实**：`compaction_ready` / `initialized` 反映真实初始化结果，不再恒 true / 硬编码。
5. **打包路径统一**：app_dir / config_dir 同根（app_data_dir），CARGO_MANIFEST_DIR 仅 dev fallback；
   旧 `%APPDATA%\Crish\AgentWorkbench` 配置首启迁移。
6. **会话落库（收编 PE-08）**：新会话 upsert 进 sessions 表、空 keepIds 拒绝全删、30 天清理按
   SQLite 核对、近期会话保护、LocalDbStore spawn_blocking 化——唯一执行方 = **PE-08**
   （T08.1/T08.2/T08.5/T08.10，AU-04 D2–D5），本任务书 T06 组只保留引用与回灌侧守卫。

### 2.2 明确不改什么（边界外）

| 项 | 说明 | 依据 |
|---|---|---|
| commandMap 幽灵清单（9 条已注销 workbench_* 映射） | 属独立命令面收束域，不在本方案任务内；`update-config` → `config_update` 映射随 commandMap 重构一并移交 **PE-03 T03.1**（本方案不再触碰 commandMap） | 25-audit §3.2；AU-04 F12-C19 |
| W-1 core_check_command 的 SharedGatekeeper 未注入 | 非配置/启动状态域 | AA-02 W-1 |
| W-2 tracing 全静默 | 可观测性域，独立任务；本方案仅要求测试中可观测（用返回结构断言代替日志） | AA-02 W-2 |
| S-1/S-2 perf_* 死面与 core_* 双注册 | 命令面收束域 | AA-02 S-1/S-2 |
| S-7 reqwest 复用、S-8 丢帧观测、S-13 host_openers 注入面 | 引擎/安全域 | AA-02 |
| P03 events 无 FK、P04 runs.cursor 死列、P06 恢复/快照生产未接线、P07 迁移非版本化 | 数据持久化域第二期；本方案只做「新会话落库 + 清理安全 + 阻塞消除」四条 | AA-07 P03/P04/P06/P07 |
| P11 时间戳三套、P12/P13/P14 schema 精简、P15 WAL、P16/P17/P18 | 建议级，不在本方案 | AA-07 |
| Q04 遥测三份死代码、Q05 直连 fetch（providerStore 是遥测/账户面）、Q06–Q25 其余 store 问题 | 前端状态域独立任务 | AA-03 |
| ConnectionManager 的 recovering/authenticating 中间态保留 | 本方案只收敛「就绪判定来源」，不重构连接状态机枚举（T04.3 仅收窄投影，若评审同意再简化） | 25-audit §4.3-4 |

**跨任务红线**：
- 所有新命令错误协议 = `CoreError { kind, detail }`（对齐 core_query_commands 现状，不引入 String 错误）。
- 所有配置/密钥路径改动保持旧路径**读取兼容**（迁移期），删除动作只在新真源确认后执行。
- 前端改动不引入新的「直连 fetch / 直写 localStorage 明文」模式（对齐 AA-03 Q05 教训）。

---

## 三、任务分解

### 3.0 任务总览表

| 任务 | 域 | 修复问题 | 输入审查编号 | 直接依赖 |
|---|---|---|---|---|
| T05.1 | 路径 | W-3 app_dir 编译机路径 | AA-02 W-3 | 无 |
| T05.2 | 路径 | W-4 配置/DB 路径分裂 | AA-02 W-4 | T05.1 |
| T01.1 | 状态 | P1 Rust 侧形状缺口 | 25-audit §4.1-1 | T05.1、T05.2 |
| T01.2 | 状态 | W-6 initialized/compaction 不诚实 | AA-02 W-6 | T01.1、T05.1 |
| T02.1 | 提示 | P1 前端缺省 false 掩盖未知 | 25-audit §4.1-2 | T01.1 |
| T02.2 | 提示 | P1 sync-engine 提示恒真 | 25-audit §1.1/§4.1-2 | T02.1、T03.2 |
| T02.3 | 状态 | OR 语义稀释 engineReady | 25-audit §2.3/§4.3-3 | T01.1 |
| T03.1 | 配置 | S-6 daemon 命名残留 | AA-02 S-6 | 无 |
| T03.2 | 配置 | P2 双真源、配置命令全死面 | 25-audit §1.3/§4.1-4 | T03.1、T01.1 |
| T03.3 | 配置 | P2 明文 key 清除与迁移（**已收编 PE-07 T07.4-B**，本任务改引用） | 25-audit §4.1-4 | 无（实现移交 PE-07） |
| T03.4 | 配置 | P2 启动推配置遗留 | 25-audit §4.1-3 | T03.2（迁移随 PE-07 T07.4-B） |
| T04.1 | 启动 | Q01 引擎就绪四份复制 | AA-03 Q01 | T03.4、T02.3 |
| T04.2 | 启动 | gateTimer 与离线兜底矛盾 | 25-audit §2.4-2 | T04.1、T02.3 |
| T04.3 | 启动 | Q13 连接状态三处投影 | AA-03 Q13 | T04.2 |
| T04.4 | 启动 | Q02/Q03/Q24 回灌竞态 | AA-03 Q02/Q03/Q24 | T03.4、T04.1 |
| T06.1 | 落库 | P01 新会话不落库（阻塞，**收编 PE-08 T08.1**） | AA-07 P01 | 无（实现移交 PE-08） |
| T06.2 | 落库 | P02 空 keepIds 级联全删（阻塞，**收编 PE-08 T08.2**） | AA-07 P02 | T04.4（hydrationComplete 门闩消费） |
| T06.3 | 落库 | P09/P10 清理策略冲突（**收编 PE-08 T08.2/T08.10**） | AA-07 P09/P10 | 无（实现移交 PE-08） |
| T06.4 | 落库 | P05 同步 DB 调用阻塞（**收编 PE-08 T08.5**） | AA-07 P05 | 无（实现移交 PE-08） |

### 领域 T05：打包路径体系修复（先行基础）

#### T05.1 host_paths 统一为 app_data_dir 真源

- 目标：修复 AA-02 W-3：`app_dir()` 不再依赖编译机路径 `env!("CARGO_MANIFEST_DIR")`；
  打包环境下 sessions.db / 工作区根解析到用户可写目录。
- 输入：AA-02 W-3（host_paths.rs:6-24、main.rs:145-177、engine.rs:189）；
  25-audit §一 1.1（main.rs:203 进程内引擎）。
- 产出：
  - `apps/agent-workbench/src-tauri/src/host_paths.rs`：新增
    `pub(crate) struct RuntimePaths { pub app_data_dir: PathBuf, pub dev_dir: Option<PathBuf> }`；
    `pub(crate) fn resolve_runtime_paths(app: &tauri::AppHandle) -> Result<RuntimePaths, String>`——
    优先 `app.path().app_data_dir()`（打包真源），dev 构建（debug_assertions）时回退
    现有 CARGO_MANIFEST_DIR 探测链（仅 fallback，不优先）。
  - `main.rs` setup：`app.manage(RuntimePaths)`（Tauri State 注入），DB 打开路径改为
    `state.app_data_dir.join("sessions.db")`；engine.rs 工具注册的 workspace_root 消费同一真源。
- 验收标准（可检查断言）：
  1. 新单元测试：`resolve_runtime_paths` 在 mock app_data_dir 下返回的根目录 == 传入目录
     （不出现 CARGO_MANIFEST_DIR 派生值）。
  2. 集成断言：main.rs setup 中 sessions.db 路径 == `app_data_dir()/sessions.db`
     （setup 内把解析结果写入 `RuntimePaths`，测试经 manage 读取断言）。
  3. dev 回归：`cargo test` 在无 `CRISH_WORKBENCH_CONFIG_DIR` 环境下仍通过
     （CARGO_MANIFEST_DIR fallback 仅剩 dev 用途）。
  4. grep 断言：`env!("CARGO_MANIFEST_DIR")` 在 host_paths.rs 中不再出现在非 fallback 分支。
- 依赖：无（域内最先行）。

#### T05.2 config_dir 与 app_dir 同根 + 旧路径首启迁移

- 目标：修复 AA-02 W-4：配置与 DB 不再分裂；旧 `%APPDATA%\Crish\AgentWorkbench` 文件首启迁移。
- 输入：AA-02 W-4（config/persistence.rs:35-47）。
- 产出：
  - `config/persistence.rs`：`config_dir()` 改为消费 `RuntimePaths.app_data_dir`（同根）；
    `CRISH_WORKBENCH_CONFIG_DIR` env 覆盖仅保留给测试（cfg(test) 或显式文档化）。
  - 新增 `fn migrate_legacy_config_dir() -> Result<(), String>`：检测旧路径
    `%APPDATA%\Crish\AgentWorkbench` 存在 provider-config.json / *.dpapi / secrets/ 且新根无对应文件时，
    复制到新根并写 `session_meta` 标记 `config_migrated_v1`；复制成功前不删除旧文件。
- 验收标准：
  1. 测试：预置旧路径文件 + 新根为空 → 调用 migrate 后新根文件存在、旧文件保留、标记写入。
  2. 测试：新根已有同 key 文件 → 跳过迁移（幂等）。
  3. grep 断言：`"AgentWorkbench"` 硬编码只出现在迁移读取路径，不再出现在常规 `config_dir()`。
  4. `CRISH_WORKBENCH_CONFIG_DIR` 测试覆盖下全量 Rust 测试仍绿（既有 config 测试不改语义）。
- 依赖：T05.1。

### 领域 T01：core_get_status 回补与诚实化（Rust 侧根因）

#### T01.1 CoreStatus 回补 provider 字段

- 目标：落实 25-audit §4.1-1（21-phase-c-migration-log ①② 回补单）：
  `core_get_status` 返回 provider 配置状态，消灭「提示恒真」的 Rust 侧缺口。
- 输入：25-audit §1.2 关键事实 1（core_query_commands.rs:49-62 形状缺口）、§4.1-1；
  config/provider.rs `ApiConfigStore`（effective_model/effective_base_url/effective_credential_mode/effective_api_key）；
  config/mod.rs `workbench_profile_secret_has`（DPAPI has-key 探测）。
- 产出（**字段名冻结 v1，见 AU-04 F2**：输出侧只存在 `providerStatus`，`provider` 名作废）：
  - `core_query_commands.rs`：`CoreStatus` 增加字段
    `pub provider_status: ProviderStatus`（`rename_all = "camelCase"` → 序列化为 `providerStatus`），其中
    ```rust
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ProviderStatus {
        pub has_api_key: Option<bool>,  // 三态：null = store 未初始化/无法判定；false = 明确无 key
        #[serde(skip_serializing_if = "Option::is_none")] pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")] pub base_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")] pub credential_mode: Option<String>,
    }
    ```
  - `core_get_status` 注入 `State<ApiConfigStoreHandle>`（现有 `init_api_config_store` 的包装）：
    `has_api_key = store.effective_api_key().map(|k| !k.value.is_empty())`；
    model/base_url/credential_mode 取 effective_*。
  - `build_status` 签名扩展（provider_status 参数），保持与 Tauri 解耦（纯数据组装）。
    **F2 串行序**：本任务只定基线参数（initialized/compactionReady/providerStatus），
    PE-03（activeRuns/pendingApprovals/mcpStatus）→ PE-04（logLevel/logDir/diagnostics/lastError）→
    PE-08（restore/snapshot）各域以**追加参数**并入同一 `build_status`，严禁并行改同一函数。
- 验收标准：
  1. 单元测试 `build_status`：给定 mock ProviderStatus → 序列化 JSON 含
    `providerStatus.hasApiKey` / `providerStatus.model` / `providerStatus.baseUrl`，且 camelCase 正确。
  2. 集成测试（mock CRISH_WORKBENCH_CONFIG_DIR）：写 key → `core_get_status` 返回
    `providerStatus.hasApiKey == true`；清 key → `false`；store 未初始化 → `null`（None 序列化）。
  3. 既有 `CoreStatus` 消费者（tauriTransport/engineStatus/mcpApi/rustCoreStore）字段名兼容：
    `initialized/engineReady/searchIndexReady/dbReady/compactionReady` 保持不动（纯新增字段）。
  4. `cargo test`（core_query_commands + config）全绿。
- 依赖：T05.1（store 路径正确）；T05.2（迁移后配置可读）。

#### T01.2 initialized / compaction_ready 诚实化

- 目标：修复 AA-02 W-6：不再恒 true / 硬编码；状态字段反映真实初始化。
- 输入：AA-02 W-6（core_query_commands.rs:330-342 —— 行号已复核（AU-04 修订指令 9）：
  该区间 `compaction_ready` 已参数注入，本任务消除其恒 true 语义即可；`initialized` 恒 true、
  search_index_ready 非空推断）；AA-07 正文（db_ready 已真实）。
- 产出：
  - `main.rs`：新增 `SharedCompactionState`（AtomicBool，见 core_commands.rs 模式）manage；
    现有压缩能力（crates/conex-compaction 纯内存）接线时置 true，未接线则如实 false
    + 注释标注「压缩能力未接线」。
  - `core_query_commands.rs`：`core_get_status` 的 `compaction_ready` 读取该 State；
    `initialized` 改为注入值：setup 完成（RuntimePaths 解析成功 + 所有 State manage 完成）后置 true，
    app_dir 解析失败等 setup 失败路径置 false（main.rs 记录并保留 false，不假装成功）。
  - `build_status` 增加 `initialized: bool`、`compaction_ready: bool` 参数（去掉硬编码）。
- 验收标准：
  1. 单元测试：`build_status(false, ..., false)` → JSON `initialized:false, compactionReady:false`
     （反写现有「恒 true」断言）。
  2. 集成断言：未接线压缩 → `core_get_status.compactionReady == false`（此前为 true）。
  3. `initialized` 在 setup 失败路径的投影有显式测试（构造 RuntimePaths Err → initialized false）。
  4. tauriTransport 侧不回归：T02.3 已改为 engineReady 主判据，initialized 仅供诊断。
- 依赖：T01.1（同文件）；T05.1（initialized 依赖路径解析结果）。

### 领域 T02：前端解析与提示修复

#### T02.1 parseEngineStatusFromRaw 三态化（hasApiKey: boolean | undefined）

- 目标：修复 25-audit §1.2 关键事实 2：字段缺失时 `hasApiKey` 应为「未知」（undefined）
  而非「已知无」（false），与 `engineHint==null 不展示提示` 的既有 null 语义对齐。
- 输入：25-audit §4.1-2（engineConfig.ts:402-456 parseEngineStatusFromRaw:424-429 缺省 false）。
- 产出：
  - `apps/crish-desktop/src/api/engineConfig.ts`：
    - `EngineStatus.hasApiKey?: boolean` 类型不变（本就可选），但语义文档改为
      `undefined = 未知（provider 字段缺失）；false = 引擎明确无 key`。
    - `parseEngineStatusFromRaw`：`hasApiKey` 仅在
      `provider.apiKey.hasApiKey` / `src.hasApiKey` / `root.hasApiKey` 三者之一为
      **boolean** 时取值，否则 `undefined`；去掉 `Boolean(...)` 强转。
    - 主路径读取 `root.providerStatus.hasApiKey`（Rust 冻结字段名，AU-04 F2）；
      保留 `root.provider` / `root.config` 旧路径兼容读取（**方向只读**，F2 允许的前端解析层兼容路径）。
  - 消费方检查：`useChatCardState.ts:180-186 getProviderSetupStatus` 的
    `engineHasApiKey: engineHint.hasApiKey` 透传即可（`false`/`undefined` 语义变化由 T02.2 吸收）。
- 验收标准：
  1. 单元测试（engineConfig 相关测试文件）：
     `{providerStatus:{}}` → `hasApiKey === undefined`；`{providerStatus:{hasApiKey:false}}` → `false`；
     `{providerStatus:{hasApiKey:true}}` → `true`；`{provider:{apiKey:{hasApiKey:true}}}`（旧路径兼容）→ `true`；
     `{hasApiKey:true}`（root）→ `true`。
  2. 回归：`engineConfigReadiness` 对 undefined hasApiKey 的 ready 判定不误判为「无 key」
     （credentialMode 走 account-center/auto 时仍 ready，行为不变）。
  3. `npx tsc --noEmit`（crish-desktop）零错误。
- 依赖：T01.1（新字段生效才有真值可读）。

#### T02.2 删除 sync-engine 提示分支与文案

- 目标：修复 25-audit §1.1/§4.1-2：进程内引擎不存在「同步」概念，删除整个提示面。
- 输入：25-audit §1.1 文案表（ChatStatusRibbons.tsx:290-291、149-155、310-311）。
- 产出：
  - `apps/crish-desktop/src/components/ChatStatusRibbons.tsx`：
    - `SetupHintKind` 去掉 `'sync-engine'`；`resolveSetupHintKind` 删除 sync-engine 分支
      （149-155 三条件逻辑整体删除）。
    - 删除 `resolveSyncEngineSoftHintText`（287-292）；`resolveSetupHintAction` 删除
      `case 'sync-engine'`（310-311）；渲染处（747-751 数据属性与图标分支）删除。
  - `ChatStatusRibbons.module.css`：删除 `.chatSoftHint[data-setup-hint='sync-engine']` 两组规则（83-92）。
  - 测试更新：
    - `ChatStatusRibbons.setupHint.test.ts:174-184`（sync-engine 三条件用例）改为断言
      「engineOk=true + engineHasApiKey=undefined + localHasKey=true → null」；
      `:279` 的 kinds 集合断言去掉 sync-engine。
    - `ChatStatusRibbons.ribbon.test.ts:192-215`（紧凑文案用例）删除或改断言。
  - `useChatCardState.ts`：若 `getProviderSetupStatus` 仅剩 needs-key/needs-model 用途，
    移除 `hasEngineKey`/`hasLocalKey` 不再被消费的中间计算（grep 确认后删）。
- 验收标准：
  1. grep 断言（apps/crish-desktop/src，排除删除后的测试）：`sync-engine`、`本地密钥待同步`、
    `resolveSyncEngineSoftHintText` 零命中。
  2. 新单测：`resolveSetupHintKind` 对「引擎通 + 未知 key + 本地有 key」返回 null；
    needs-key（engineOk=true + hasApiKey=false + local 无 key）仍返回 'needs-key' 不回归。
  3. 全部既有 setupHint/ribbon 测试绿（更新后）。
- 依赖：T02.1（undefined 语义是本用例的输入）。

#### T02.3 isCoreReady 明确聚合（engineReady 主判据）

- 目标：修复 25-audit §2.3 注意 / §4.3-3：OR 语义稀释 engineReady；改为
  engineReady 为「引擎可用」主判据，dbReady/searchIndexReady 不再参与就绪判定。
- 输入：25-audit §2.3（tauriTransport.ts:46-62）、§4.3-3。
- 产出：
  - `apps/crish-desktop/src/api/transport/tauriTransport.ts`：
    - `isCoreReady(status)` 改为仅判断 `engineReady`（兼容 `engine_ready` snake 别名），
      删除 dbReady / searchIndexReady 分支。
    - `waitUntilConnected` 文档与注释同步（「就绪 = engineReady（provider 齐备）」）。
  - `tauriTransport.test.ts` 更新：`dbReady:true` 不再判就绪（原 207-209 用例反转断言）；
    engineReady=false + dbReady=true → false；engineReady=true → true。
- 验收标准：
  1. 单测断言：`{engineReady:false, dbReady:true}` → `waitUntilConnected` 超时 false
     （此前为 true）；`{engineReady:true}` → true。
  2. 单测断言：`{}`（字段缺失）→ false（不误判就绪）。
  3. 注释/grep：`searchIndexReady` 不再出现在 isCoreReady 判据列表。
- 依赖：T01.1（engineReady 语义已真实，见 AA-02 正面 B6.4）。

### 领域 T03：配置真源迁移（localStorage → Rust ApiConfigStore DPAPI）

#### T03.1 Rust 配置命令面收束（命令名按 F5 终态表 + 删除 sentToDaemon）

- 目标：落实 25-audit §4.1-3 后半 / §4.2-3、AA-02 S-6；**命名终态按 AU-04 F5 冻结表（v1）**：
  `update_daemon_config` → `config_update`、`get_api_config` → `config_get`、
  `save_api_config` **删除**（写路径并入 config_update）、`workbench_profile_secret_*` → `config_secret_*`。
- 输入：AA-02 S-6（config/provider.rs:372-383、409-499）；25-audit §3.1-F（7 个命令全为死面）；
  AU-04 F5（配置命令命名终态表）。
- 产出：
  - `config/provider.rs`：`update_daemon_config` → `config_update`（同签名，**Rust 改名本任务执行**）；
    快照对象删除 `sentToDaemon` 字段（483、496 行），`has_fields` 空分支返回不含该字段。
  - `config_get` / `config_secret_*` 的更名接线主体归 **PE-03 T03.4/T03.5**（本任务不保留现名、
    不定义第二命名）；`save_api_config` 删除由 PE-03 T03.5 执行。
  - `main.rs` make_handlers! 注册名同步（宏按函数名注册，改名即生效；config_get/config_secret_*
    命名终态登记随 PE-03 落地）。
  - 前端 commandMap `'update-config'` → `config_update` 映射变更**并入 PE-03 T03.1 重构**
    （AU-04 C19：commandMap 重构先行，本任务不再触碰 commandMap）。
  - `engineConfig.ts` `buildUpdateConfigPayload` 无变化（type 字段是 WS 遗留，仅 Tauri 路径
    走 commandMap，不改 payload）。
- 验收标准：
  1. grep（src-tauri + crish-desktop/src）：`update_daemon_config`、`sentToDaemon` 零命中
    （除迁移注释/文档）。
  2. Rust 测试：`config_update(apiKey, baseUrl, model)` → `config_get` 读回一致（终态名，冻结 v1 见
    AU-04 F5；与 PE-03 T03.4 更名串行合入后执行）；快照不含 `sentToDaemon` 键。
  3. commandMap 映射变更验收以 PE-03 T03.1 为准（`'update-config'` 解析到 `config_update`）。
  4. 全量 `cargo test` + 前端相关单测绿。
- 依赖：无（命令面独立）；与 PE-03 T03.1（commandMap）/T03.4（更名接线）同文件串行声明见 AU-04 附录。

#### T03.2 前端配置读写命令面（profileStore 接入 Rust 真源）

- 目标：落实 25-audit §4.1-4：前端读写走 Rust `ApiConfigStore`；
  消除「前端从不调用 Rust 配置读命令」的死面局面（25-audit §1.3）。
- 输入：25-audit §1.3（grep 零命中结论）、§4.1-4；profileStore.ts:310-318（setProfileKey 明文）；
  AA-03 Q05（store 不得直连网络——本任务为 IPC 调用，符合分层）。
- 产出：
  - 新增 `apps/crish-desktop/src/api/provider-profiles/rustProfileStore.ts`（**唯一薄封装，方法名对应
    F5 终态表，冻结 v1**，invokeTyped 直调）：`configGet()` → `config_get`、`configUpdate(update)` →
    `config_update`、`configSecretSet(profileId, key)` → `config_secret_set`、
    `configSecretHas(profileId)` → `config_secret_has`、`configSecretClear(profileId)` → `config_secret_clear`。
  - `profileStore.ts` 改造：
    - `setProfileKey` → 写 Rust（`configSecretSet` + `configUpdate` 带 baseUrl/model），
      localStorage 侧**只写 hasKey 标记与元数据，不再写 apiKey 明文**（F5 前端读写面约定）；
    - `loadProfiles` 启动时以 `getApiConfig` + `profileSecretHas(各 profileId)` 回填 hasKey；
    - `saveProfileKey`/`saveProfileBaseUrl`/`activateProfileModel` 的同步路径保留
      （invoke 缺失时降级 localStorage 草稿，25-audit 允许「降级为本地草稿」）。
  - `profileValidation.ts`：`profileHasKey` 语义改为「LS 草稿 hasKey 标记或 Rust hasKey」
    （由调用方注入，避免同步读取）。
- 验收标准：
  1. 单测（mock invokeTyped）：`setProfileKey` 调用 `config_secret_set` + `config_update`
    （终态名断言，AU-04 F5）；
    `localStorage.crish_provider_profiles_v1` 中对应 profile 无 `apiKey` 字段。
  2. 单测：`configGet` 返回 hasKey=true → `loadProfiles` 回填 hasKey；Rust 不可用时
    降级草稿路径仍工作（原行为）。
  3. 集成断言（dev 运行）：设置页保存 key → 重启 → 提示不再恒真（T02.2 已删提示面）
    + `secrets/{id}.dpapi` 文件存在、provider-config.json 无明文 key。
  4. `npx tsc --noEmit` 零错误；既有 profileStore 测试更新后全绿。
- 依赖：T03.1（config_update 命名）；T01.1（config_get 读面与 status 面一致）。

#### T03.3 旧明文迁移流程与清除 —— 已收编 PE-07 T07.4-B（引用）

- 状态：**按 AU-04 D12/F5 收编删除**：明文 key 迁移的单一实现（`migrateLegacyProfiles.ts` 文件结构
  + 幂等标记 `crish_profiles_secrets_migrated_v1` + 全 LS 键扫描断言 + 失败重试一次）
  唯一负责方 = **PE-07 T07.4-B**；本任务不再保留任务体。
- 原任务体（migrateLegacyProfiles.ts 编排、AppBootstrap 启动调用、迁移三用例验收）全部随实现移交
  PE-07；其验收并入 PE-07 T07.4-B 用例 1-2。
- 本域残留：无（T03.2 的 setProfileKey 明文去除由 T03.2 独立完成，与本任务解耦）。
- 依赖：删除（原依赖 T03.2/T05.2 随实现移交 PE-07）。

#### T03.4 删除启动同步 syncActiveProfileToEngine（用户主动路径改走 config_profile_apply）

- 目标：落实 25-audit §4.1-3 + AU-04 F5/C6：进程内引擎无「推送」动作，删除启动时向引擎推配置；
  `syncActiveProfileToEngine`（函数 + 启动调用）**整体删除**（grep 零命中验收，F5 裁决）。
- 输入：25-audit §2.1 时序（AppBootstrap.ts:300-304 / useEngineBootstrap.ts:38-40
  syncActiveProfileToEngine 调用）；AU-04 F5（`config_profile_apply` 终态名）。
- 产出：
  - `AppBootstrap.ts` effect7：删除 `syncActiveProfileToEngine` 调用块（300-304）；
    `syncSessionsFromDaemon` 的调用保留到 T04.4 处理（本任务不动会话面）。
  - `useEngineBootstrap.ts` 内的调用随 T04.1 文件删除一并消失。
  - `providerProfiles.ts`（api 层聚合导出）：`syncActiveProfileToEngine` 导出删除；
    `profileStore.ts:565-602` 函数体删除。
  - **用户主动路径（`activateProfileModel`/`saveProfileKey`/`saveProfileBaseUrl`）改走
    `config_profile_apply`**（终态命令由 **PE-07 T07.4** 实现并登记契约；本任务只改调用点引用，
    **不自行实现该命令**，AU-04 F5）。
  - `bootstrap-full.ts`：删除「同步引擎配置」注释引用的旧语义（实际未调用
    syncActiveProfileToEngine，仅确认无调用）。
- 验收标准：
  1. grep（crish-desktop/src）：`syncActiveProfileToEngine` 零命中。
  2. 单测：AppBootstrap 渲染后不触发任何 `updateEngineConfig`（mock transport 断言零调用）。
  3. 用户主动路径回归：`saveProfileKey`/`activateProfileModel` 的 mock 断言改为调用
    `config_profile_apply`（终态名，冻结 v1 见 AU-04 F5；依赖 PE-07 T07.4 先落地或同批会签）。
- 依赖：T03.2（写命令面已接入）；明文迁移由 PE-07 T07.4-B 负责，本任务不再依赖（原 T03.3 依赖删除）。

### 领域 T04：启动状态机合并

#### T04.1 引擎就绪初始化单实现

- 目标：修复 AA-03 Q01：四份复制收敛为一份；删除死 hook；StrictMode 双跑安全。
- 输入：AA-03 Q01（AppBootstrap.ts:147-154 + 279-331、useEngineBootstrap.ts:5-61、
  bootstrap-full.ts:7-9）；25-audit §2.1/§2.4-1。
- 产出：
  - `apps/crish-desktop/src/app/AppBootstrap.ts`：
    - 删除 section 3（147-154 早置快照探测）；effect7 保留为唯一 initEngine；
    - effect7 改造：cleanup 幂等（StrictMode mount→unmount→mount 双跑时
      `onStatus` 退订、轮询停止、不再重复触发同步回调）；
    - 同步回调（T04.4 的会话 merge）加去重锁（模块级 promise 或状态位）。
  - 删除 `apps/crish-desktop/src/app/useEngineBootstrap.ts`（死代码，AA-03 确认仅测试引用）；
    若测试引用则迁移到 AppBootstrap 的测试。
  - `bootstrap-full.ts`：删除 `ensureDaemonConnected` 第 4 份探测（7-9 行），
    保留 workers scaleUp 与设置/主题加载。
- 验收标准：
  1. grep：`useEngineBootstrap` 在 src 零 import。
  2. React 测试（StrictMode 包装）：mount → unmount → mount 后，
     `transport.onStatus` 注册数 == 1（每次 mount 清理旧订阅）。
  3. bootstrap-full 测试：不再调用 ensureDaemonConnected（mock 断言）。
  4. 双跑安全回归：E12 的会话 merge 回调在双跑下只执行一次完整流程（去重锁单测）。
- 依赖：T03.4（同步调用已删，合并时无残留）；T02.3（就绪语义单一）。

#### T04.2 删除 gateTimer 与兜底矛盾

- 目标：修复 25-audit §2.4-2：12s gateTimer 强制 ready 与「超时回退离线」互相矛盾；
  引擎就绪 = `core_get_status.engineReady` 单一来源（T02.3 后 connected 语义即此）。
- 输入：25-audit §2.4-2（AppBootstrap.ts:316-321 gateTimer）、§4.3-2。
- 产出：
  - `AppBootstrap.ts` effect7：删除 gateTimer 块（316-321）与 `productShell ? 12_000 : 0` 参数；
    `setEngineReady` 仅由 `onStatus('connected')`（语义=T02.3 engineReady）驱动；
    `ensureDaemonConnected` 失败路径投影 not-ready（不再 console.warn 后继续假装）。
  - `useAppBootstrap` 的 `productShell` 参数若不再被消费，从接口移除并同步 App.tsx 调用处
    （grep 确认后删）。
- 验收标准：
  1. grep：`gateTimer`、`setTimeout` 强制 ready 逻辑在 AppBootstrap 零命中。
  2. 单测：core_get_status 持续 engineReady=false → 12s 后 engineReady 仍为 false
    （mock 时钟推进断言，此前为 true）。
  3. 单测：engineReady=true → setEngineReady(true) 正常触发。
- 依赖：T04.1（在单实现上删）；T02.3（connected 语义收窄）。

#### T04.3 ConnectionManager 投影收敛

- 目标：修复 AA-03 Q13 + 25-audit §4.3-4 边界：就绪状态单一投影源；
  恢复/认证中间态在 IPC 下不参与 UI 判定。
- 输入：AA-03 Q13（ConnectionManager.ts:75-81、useDaemonState.ts:123-148、
  AppBootstrap.ts:283-290 三处订阅）；25-audit §2.2 表（ConnectionManager 行）。
- 产出：
  - `services/ConnectionManager.ts`：新增 `onStateChange(listener)` 与
    `getSnapshot()`（ready/not-ready 二元投影：`phase==='ready' && transport.isReady()`）；
    现有 phase 枚举保留（内部），但对外暴露 `isReady(): boolean` 单一判定。
  - `hooks/useDaemonState.ts`：改消费 `ConnectionManager.onStateChange`（useSyncExternalStore 模板），
    删除自身对 transport.onStatus 的订阅。
  - **命名时序（AU-04 C17）**：本任务沿用旧名 `useDaemonState.ts` 开发；统一重命名
    （→ `useEngineState.ts`、事件名 `'engine:connection:change'`）由 **PE-05 T05.7.2** 末轮执行，
    本任务不自行改名（发布/订阅一致性单测归 PE-05）。
  - `AppBootstrap.ts` E12：删除独立 `transport.onStatus` 订阅（283-290），改从
    ConnectionManager 投影读就绪（或保留 onStatus 但注明是唯一订阅源——二选一，验收要求单源）。
- 验收标准：
  1. grep：`transport.onStatus` 消费点收敛到 ≤1（其余改经 ConnectionManager）。
  2. 单测：ConnectionManager 状态变化 → useDaemonState 重新渲染（mock 断言订阅注销/重注册正确）。
  3. 单测：transport 断开 → ConnectionManager isReady false；重连 → true（无中间态泄漏）。
- 依赖：T04.2（就绪判定单一后投影才稳定）。

#### T04.4 会话回灌编排与竞态消除（Q02/Q03）

- 目标：修复 AA-03 Q02/Q03：E3（SQLite 回灌）与 E12（merge）串行化；
  hydrateWorkspaceShell 等待 layoutStore hydration。
- 输入：AA-03 Q02（store-persistence.ts:134-283、AppBootstrap.ts:305-313、
  sessionIndexLoader.ts:11-26）、Q03（AppBootstrap.ts:92-111、store-persistence.ts:71-86）、
  Q24（回灌双实现）。
- 产出：
  - `app/hydrateWorkspaceShell.ts`：在 `waitLayoutTreeHydration()` 之外并行
    `await waitForHydration()`（store-persistence.ts:71-86 已导出，从未被调用——接线它）。
  - `AppBootstrap.ts` E12：`syncSessionsFromDaemon` 的 merge 回调加
    `hydrationComplete` 门闩（E3 完成前不 merge）；
    E3 的 `initLayoutStorePersistence` 完成置位后释放。
  - **`hydrationComplete` 声明为公共门闩变量（模块级导出）**：供 PE-08 T08.2 持久化守卫
    （persist 前置 `hydrationComplete && list.length > 0`、`lsSaveSessionIndex([])` 同守卫）消费，
    本任务为其唯一产出方（AU-04 F4/D7）。
  - 删除 `store/sessionIndexLoader.ts` 独立路径（Q24）：`loadSessionIndexOnly`
    并入 E3 回灌（bootstrap-full 中的调用随之移除）。
- 验收标准：
  1. 时序单测（fake timers + 可注入 promise）：E3 未完成时调用 merge → 被排队不执行；
     E3 完成后执行一次。
  2. 单测：hydrateWorkspaceShell 在 layoutStore hydration 完成前不读 sessions
     （`waitForHydration` 被调用断言）。
  3. grep：`sessionIndexLoader` import 零命中（文件删除）。
  4. 回归：350ms debounce persist 用空数组擦 SQLite 的历史事故不再复现
     （persist 守卫 `hydrationComplete` 在 T06.2 也有，此处是回灌侧守卫）。
- 依赖：T03.4（删同步后 merge 路径变纯）；T04.1（单实现上改）。

### 领域 T06：sessions.db 落库修复（全部收编 PE-08，本域仅保留引用）

> 按 AU-04 D2–D5/F3/F4 裁决：本组任务体全部移交 **PE-08**（会话持久化域唯一 owner），
> 本任务书删除重复任务体，只保留引用与本域特有的回灌侧守卫。PE-08 对应任务：
> T08.1（P01 落库）、T08.2（P02 清理安全 + 宽限期 + 前端守卫）、T08.5（P05 spawn_blocking）、
> T08.10（前端写模型 / persistAllSessionsRust 终态顺序）。

#### T06.1 新会话落库（P01）—— 已收编 PE-08 T08.1（引用）

- 状态：按 AU-04 D2/F3 收编，唯一执行方 = **PE-08 T08.1**；本任务不再保留任务体。
- 冻结签名（v1，见 AU-04 F3）：`upsert_session_entry(entry: SessionIndexEntry) -> Result<(), CoreError>`
  （**对象签名**，与 conex-db 底层一致；PE-01 原平铺参数方案作废；语义 = ON CONFLICT(id) DO UPDATE，
  不级联删消息）。
- 本域特有部分：无新增实现；`persistAllSessionsRust` 的前端消费在 PE-08 T08.1/T08.10 定稿
  （终态顺序 C16：upsert 全部索引 → body/agents → meta → 清理孤儿 → LS 索引）。
- 验收：以 PE-08 T08.1 验收为准；本任务书不再设独立验收。
- 依赖：删除（原 T05.1/T04.4 依赖随实现移交 PE-08）。

#### T06.2 空 keepIds 拒绝全删（P02）—— 已收编 PE-08 T08.2（引用）

- 状态：按 AU-04 D3/F4 收编，唯一执行方 = **PE-08 T08.2**；本任务不再保留任务体。
- 冻结语义（v1，见 AU-04 F4）：`cleanup_orphan_sessions(active_ids: Vec<String>, confirm_empty: bool)`
  → 空集且 confirm_empty=false：**不执行任何 DELETE**，返回
  `Err(CoreError { kind: "InvalidInput", detail: "cleanup_orphan_empty_keep" })`；
  空集且 confirm_empty=true：显式清空（仅测试/显式用户清空入口）；
  **宽限期 = 5 分钟**（`ORPHAN_GRACE_MS = 300_000`，session_meta 键 `orphan_grace_ms` 可配；
  PE-01 原 24h 常量作废）。
- 本域特有部分（保留）：`store-persistence.ts` debounce persist 入口的 `hydrationComplete` 守卫
  属本域回灌面（消费 T04.4 门闩），由 T04.4 接线；清理命令守卫（`hydrationComplete && list.length > 0`、
  `lsSaveSessionIndex([])` 同守卫）以 PE-08 T08.2 定稿为准。
- 验收：以 PE-08 T08.2 验收为准；本任务书不设独立 Rust 验收。
- 依赖：T04.4（hydrationComplete 门闩变量先就位）。

#### T06.3 清理策略一致性（P09/P10）—— 已收编 PE-08 T08.2/T08.10（引用）

- 状态：按 AU-04 D5 收编；SQLite 真相源核对（P09）与近期会话保护（P10）唯一执行方 =
  **PE-08 T08.2**（宽限期语义）+ **T08.10**（懒壳正文保护）。
- 本域特有部分：无独立实现；`migrateFromLocalStorage.ts` 30 天清理核对在 PE-08 定稿联调。
- 依赖：无（实现移交 PE-08）。

#### T06.4 LocalDbStore 同步调用 spawn_blocking 化（P05）—— 已收编 PE-08 T08.5（引用）

- 状态：按 AU-04 D4 收编，唯一执行方 = **PE-08 T08.5**（逐方法清单一致，单执行者防重复）；
  本任务不再保留任务体。
- 本域特有部分：无。
- 依赖：无（实现移交 PE-08）。

---

## 四、风险与验证

### 4.1 每任务验证方式汇总

| 任务 | 验证层 | 手段 |
|---|---|---|
| T05.1 | Rust 单测 + 集成 | mock AppHandle 路径断言；dev 运行 `cargo test` 回归 |
| T05.2 | Rust 单测 | 预置旧路径文件迁移用例；幂等用例 |
| T01.1 | Rust 单测 + 集成 | build_status 序列化断言；mock config dir 读写 key 断言 hasApiKey 三态 |
| T01.2 | Rust 单测 | build_status 参数注入断言；未接线压缩 → compactionReady=false |
| T02.1 | 前端单测 | parseEngineStatusFromRaw 三态用例表；tsc |
| T02.2 | 前端单测 + grep | 用例反转；零命中断言；全量 setupHint/ribbon 测试 |
| T02.3 | 前端单测 | waitUntilConnected 反 OR 断言；tsc |
| T03.1 | Rust 单测 + 前端单测 | config_update↔config_get 往返（终态名）；commandMap 解析随 PE-03 T03.1 |
| T03.2 | 前端单测 + 手工 | invoke mock 断言；dev 运行检查 DPAPI 文件与 LS 无明文 |
| T03.3 | 引用（PE-07） | 本任务删除；验收并入 PE-07 T07.4-B 用例 1-2 |
| T03.4 | grep + 前端单测 | 零命中；AppBootstrap 零 updateEngineConfig 断言；用户主动路径 mock 断言调 config_profile_apply |
| T04.1 | React 单测 + grep | StrictMode 双跑订阅数断言；死文件删除 |
| T04.2 | 前端单测 | fake timers 12s 后 engineReady 仍 false |
| T04.3 | 前端单测 + grep | 单订阅源断言；投影二元性用例 |
| T04.4 | 前端单测 | 门闩排队断言；waitForHydration 接线断言 |
| T06.1 | 引用（PE-08 T08.1） | 验收随 PE-08；本域无独立断言 |
| T06.2 | 引用（PE-08 T08.2）+ 前端单测 | Rust 语义随 PE-08；本域仅回灌侧守卫（store-persistence 入口 hydrationComplete 检查）单测 |
| T06.3 | 引用（PE-08 T08.2/T08.10） | 验收随 PE-08 |
| T06.4 | 引用（PE-08 T08.5） | 验收随 PE-08 |

### 4.2 跨任务依赖风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| T01.1 与 T02.1 双端契约漂移 | Rust 字段名 `providerStatus`（冻结 v1，AU-04 F2）必须与前端解析器一致 | T01.1 验收 2 用 mock 集成锁死 JSON 形状；T02.1 解析器主路径读 `providerStatus`、保留 `provider`/`config` 只读兼容（F2） |
| T02.2 删除提示与 T03.2 真源回填的时序 | 若 T03.2 未完成，删提示后用户看不到任何 key 引导（needs-key 仍依赖 localHasKey=anyProfileHasKey 的 LS 读取） | 执行顺序强制 T03.2 在 T02.2 之前落地（见 §五）；needs-key 分支保留 localHasKey 兜底 |
| T04.4 依赖 hydrationComplete 变量 | T06.2 也依赖同一门闩，若 T04.4 未接线则 T06.2 守卫无对象 | 先做 T04.4（或把门闩变量提升到公共模块先行），T06.2 再消费 |
| T05 与落库链耦合 | 落库链（PE-08 T08.1 等）验收在旧路径体系下无意义（DB 不持久） | T05.1/T05.2 排最前；T06 组（引用）随 PE-08 批次后置 |
| T03.4 删除同步调用暴露既有依赖 | 若有其他调用方消费 `syncActiveProfileToEngine` 返回值（grep 未发现，但 T04.1 合并时会再查） | T03.4 验收 1 的 grep 与 T04.1 的合并一起做双保险；删除前再次 grep 全仓（含测试） |
| gateTimer 删除后启动体验变化 | 慢启动环境（冷启动 app_data_dir 首次创建）engineReady 可能晚到 | 依赖 T02.3 的「engineReady 主判据」本就真实反映 provider 配置；UI 层 engine-down/needs-key 提示已具备（T02.2 后仍保留），无新风险面 |
| P05 spawn_blocking 改变并发时序 | 事件落库与查询并行度提升，可能暴露既有事件顺序假设 | T06.4 验收 1 显式并行断言；若时序测试翻车，回退为专用阻塞线程池（P05 建议的备选） |
| F2/F5 同文件串行 | core_query_commands.rs 多域增量并入（PE-01 → PE-03 → PE-04 → PE-08）、config/provider.rs 多书更名（PE-01 → PE-03 → PE-07）并行改同一文件冲突 | 主执行顺序声明：main.rs 排 PE-01 首个，其后 PE-03 → PE-04 → PE-08 → PE-09 → PE-07（AU-04 附录）；build_status 追加参数并入、config 终态名以 PE-03/PE-07 为落地方 |

---

## 五、执行顺序（依赖图）

```
Phase A  T05.1 ──▶ T05.2            （打包路径真源，域内基础）
              │        │
Phase B  T01.1 ────────┼──▶ T01.2   （core_get_status 字段回补 + 诚实化）
              │        │
Phase C  T03.1 ──▶ T03.2 ────▶ T03.4   （配置命令面 → 读写面 → 删同步；T03.3 已收编 PE-07 T07.4-B）
              │                    │
Phase D  T02.1 ──▶ T02.2           （提示修复；T02.2 依赖 T03.2 先落地）
         T02.3                     （isCoreReady 聚合，依赖 T01.1）
              │                    │
Phase E  T04.1 ──▶ T04.2 ──▶ T04.3 （启动状态机合并；依赖 T03.4/T02.3）
         T04.4                     （回灌编排；依赖 T03.4/T04.1；产出 hydrationComplete 门闩）
              │
Phase F  T06 组全部为引用（PE-08 T08.1/T08.2/T08.5/T08.10），本域不实现；
         仅 T06.2 回灌侧守卫消费 T04.4 产出的 hydrationComplete 门闩
```

关键顺序约束（不可打破）：
1. T05.1/T05.2 最先（路径是 DB 持久与配置真源的地基）。
2. T03.1 → T03.2 → T03.4 严格串行（命令面 → 读写面 → 删同步）；明文迁移（原 T03.3）随 PE-07 T07.4-B 执行。
3. T02.2 必须在 T03.2 之后（needs-key 提示的 localHasKey 依赖真源回填后的语义）。
4. T06.2（引用 PE-08 T08.2 的前端守卫部分）必须在 T04.4 之后（hydrationComplete 门闩变量）。
5. T04.2 必须在 T04.1 之后（gateTimer 在合并后的单实现上删除）。
6. **跨域主执行顺序（AU-04 附录冻结）**：main.rs 排 PE-01 首个，其后 PE-03 → PE-04 → PE-08 → PE-09 → PE-07；
   core_query_commands.rs 字段基线 PE-01 先行（F2 串行序），PE-03/PE-04/PE-08 按序追加并入。

可选并行流：T01.2 与 T03 链并行；T02.3 与 T03 链并行；落库链（PE-08）与前端域并行。

### 5.1 里程碑（按发布节奏切分，每里程碑可独立合入）

| 里程碑 | 包含任务 | 合入判据（该阶段即可验证） |
|---|---|---|
| M0 路径地基 | T05.1、T05.2 | 打包环境 sessions.db 持久化；config 迁移读旧路径成功 |
| M1 状态诚实 | T01.1、T01.2、T02.3 | core_get_status 含 provider 字段；isCoreReady 单判据；compactionReady 真实 |
| M2 提示修复 | T02.1、T02.2、T03.1、T03.2、T03.4（T03.3 移交 PE-07 T07.4-B） | 「待同步」提示消失；配置命令终态名接入（config_get/config_update/config_secret_*）；启动无推配置（LS 无明文由 PE-07 迁移验收） |
| M3 启动收敛 | T04.1、T04.2、T04.3、T04.4 | 引擎就绪单实现；无 gateTimer；回灌无竞态 |
| M4 落库稳定 | T06 组 = 引用 PE-08（T08.1/T08.2/T08.5/T08.10） | 与 PE-08 对应任务联合验收：新会话落库；空 keepIds 不删；清理安全；无阻塞调用 |

里程碑判据与域级总断言（§六）的关系：M0–M4 依次完成后 §六 1–6 逐条可验。

---

## 六、域级验收总断言（全部完成后）

1. grep `sync-engine|本地密钥待同步|syncActiveProfileToEngine|update_daemon_config|sentToDaemon`
   在 apps/crish-desktop/src + src-tauri/src 全零命中（文档除外）。
2. 全新装机：配置 key → 重启 → 无「待同步」提示；`provider-config.json` 无明文；
   `secrets/{id}.dpapi` 存在；`core_get_status` 返回 `providerStatus.hasApiKey: true`（冻结字段名 v1）。
3. 启动 12s+：未配 provider 时 UI 恒显示 needs-key（无就绪假象）；配置后立即就绪。
4. 新建 3 个会话 → 重启 → 侧栏完整回灌（list_sessions 返回 3 行）。
5. 冷启动空 store：不触发任何 `DELETE FROM sessions`（DB 行数只增不删，除非显式删除会话；
   实现随 PE-08 T08.2 交付，本域联调确认）。
6. `cargo test`（src-tauri + conex-db + orchestrator）与 crish-desktop 全量单测全绿。

---

## 七、附录 A：文件改动清单（按文件聚合，执行时可作核对表）

| 文件（相对仓库根） | 改动点 | 归属任务 |
|---|---|---|
| apps/agent-workbench/src-tauri/src/host_paths.rs | `RuntimePaths` 结构 + `resolve_runtime_paths`；`app_dir()` 改消费注入 State，CARGO_MANIFEST_DIR 仅 dev fallback | T05.1 |
| apps/agent-workbench/src-tauri/src/main.rs | setup：manage RuntimePaths；sessions.db 路径改 app_data_dir；SharedCompactionState manage；initialized 真实置位；make_handlers! 同步（config_update；upsert_session_entry 注册归 PE-08 T08.1） | T05.1、T01.2、T03.1 |
| apps/agent-workbench/src-tauri/src/config/persistence.rs | `config_dir()` 消费 RuntimePaths；`migrate_legacy_config_dir` 新函数；旧路径仅迁移读取 | T05.2 |
| apps/agent-workbench/src-tauri/src/config/provider.rs | `update_daemon_config` → `config_update`（F5 终态表）；快照删 sentToDaemon；config_get/config_secret_* 更名归 PE-03 T03.4 | T03.1 |
| apps/agent-workbench/src-tauri/src/core_query_commands.rs | `CoreStatus` 加 `provider: ProviderStatus`；`build_status` 注入 initialized/compaction/provider；core_get_status 读 ApiConfigStore | T01.1、T01.2 |
| apps/agent-workbench/src-tauri/src/session_commands.rs | **移交 PE-08**（T08.1 upsert_session_entry(entry: SessionIndexEntry) 对象签名；T08.2 cleanup confirm_empty + 空集 Err，F3/F4 冻结 v1） | 引用 |
| crates/orchestrator/src/persist.rs | LocalDbStore 方法 spawn_blocking 化（签名不变）——**移交 PE-08 T08.5** | 引用 |
| apps/crish-desktop/src/api/transport/tauriTransport.ts | isCoreReady 仅判 engineReady；waitUntilConnected 语义文档 | T02.3 |
| apps/crish-desktop/src/api/transport/commandMap.ts | `update-config` → `config_update`（**移交 PE-03 T03.1** 重构，本任务改引用，AU-04 C19） | 引用 |
| apps/crish-desktop/src/api/engineConfig.ts | parseEngineStatusFromRaw hasApiKey 三态化；providerStatus 主路径 + provider/config 旧路径兼容读取 | T02.1 |
| apps/crish-desktop/src/components/ChatStatusRibbons.tsx | 删 SetupHintKind 'sync-engine' 分支、resolveSyncEngineSoftHintText、action 分支、渲染 | T02.2 |
| apps/crish-desktop/src/components/ChatStatusRibbons.module.css | 删 sync-engine 样式规则 | T02.2 |
| apps/crish-desktop/src/api/provider-profiles/rustProfileStore.ts | 新建：5 方法薄封装（方法名对应 F5 终态表：config_get/config_update/config_secret_*） | T03.2 |
| apps/crish-desktop/src/api/provider-profiles/profileStore.ts | setProfileKey/loadProfiles 改走 Rust；明文去除；syncActiveProfileToEngine 删除；用户主动路径改走 config_profile_apply（引用 PE-07 T07.4） | T03.2、T03.4 |
| apps/crish-desktop/src/api/provider-profiles/migrateLegacyProfiles.ts | **移交 PE-07 T07.4-B**（单实现 + 幂等标记 crish_profiles_secrets_migrated_v1，AU-04 D12） | 引用 |
| apps/crish-desktop/src/api/providerProfiles.ts | 聚合导出更新（删 syncActiveProfileToEngine） | T03.4 |
| apps/crish-desktop/src/app/AppBootstrap.ts | 删 section 3/effect7 gateTimer/同步调用；effect7 幂等 cleanup；onStatus 单源；E12 merge 门闩 | T04.1、T04.2、T04.3、T04.4 |
| apps/crish-desktop/src/app/useEngineBootstrap.ts | 删除文件 | T04.1 |
| apps/crish-desktop/src/bootstrap-full.ts | 删 ensureDaemonConnected 第 4 份探测；loadSessionIndexOnly 移除 | T04.1、T04.4 |
| apps/crish-desktop/src/services/ConnectionManager.ts | onStateChange/getSnapshot 单一投影 | T04.3 |
| apps/crish-desktop/src/hooks/useDaemonState.ts | 消费 ConnectionManager 投影 | T04.3 |
| apps/crish-desktop/src/app/hydrateWorkspaceShell.ts | 接线 waitForHydration | T04.4 |
| apps/crish-desktop/src/store/sessionIndexLoader.ts | 删除文件（并入 E3 回灌） | T04.4 |
| apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts | **写模型与清理归 PE-08**（T08.1/T08.2/T08.10；宽限期 5 分钟 = ORPHAN_GRACE_MS 300_000，AU-04 F4） | 引用 |
| apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts | 30 天清理核对（**PE-08 T08.1/T08.2 联调**，本任务书不实现） | 引用 |
| apps/crish-desktop/src/store/layout-helpers/store-persistence.ts | debounce persist 入口 hydrationComplete 守卫 | T06.2、T04.4 |
| 测试文件 | ChatStatusRibbons.setupHint.test.ts / ribbon.test.ts、tauriTransport.test.ts、profileStore 相关测试、AppBootstrap 相关测试、sessionRustDb 相关测试 | T02.2、T02.3、T03.x、T04.x、T06.x |

## 八、附录 B：验证命令清单

| 阶段 | 命令 | 用途 |
|---|---|---|
| Rust 全量 | `cargo test`（apps/agent-workbench/src-tauri 工作区） | T01/T05/T06 全部 Rust 验收 |
| Rust 单组 | `cargo test -p conex-db -p orchestrator` | FK/清理/spawn_blocking 相关断言（实现随 PE-08 T08.1/T08.2/T08.5） |
| 路径测试 | `CRISH_WORKBENCH_CONFIG_DIR=<临时目录> cargo test config::` | T05.2 迁移用例（env 覆盖仍在） |
| 前端类型 | `npm run typecheck` 或 `npx tsc --noEmit`（crish-desktop） | 全任务类型安全 |
| 前端单测 | `npm test`（crish-desktop，vitest） | T02/T03/T04/T06 前端断言 |
| 定向单测 | `npx vitest run src/components/ChatStatusRibbons.setupHint.test.ts` 等 | 单任务快速回归 |
| 静态断言 | grep：`sync-engine`、`syncActiveProfileToEngine`、`update_daemon_config`、`sentToDaemon`、`useEngineBootstrap`、`sessionIndexLoader` | 删除类任务零命中验收 |
| 手工集成（dev） | 启动应用：配置 key → 重启 → 检查无提示、DPAPI 文件存在、LS 无明文 | T03.2/T03.3/T02.2 端到端 |
| 打包冒烟 | `npm run tauri build` + 安装运行 → 新建会话 → 重启 → 回灌 | T05.1/T06.1 打包环境验证 |
| 门禁 | 仓库既有 check 脚本（store 类型门禁等） | 全任务不回归 |

