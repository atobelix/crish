# MCP 与扩展工具契约

> 日期：2026-10-13
> 范围：`crates/agent-tools/src/mcp/`、`background.rs`、`subagent_inject.rs`、`explore_quota.rs`、`compression_store.rs`、`note_backend.rs`、`note_permission.rs`、`note_action_matrix.rs`，以及壳层把这些契约装进 `ToolContext` 的调用点。笔记落盘留给 12，这里只追 trait 是否被注入、工具是否把空结果当成可用。

## 能力结论

模型在生产回合里**调不到用户配置的 MCP 工具**。桥和「同一注册表」外壳都在库里，引擎也建了一个空的 `McpClientBridge`，但把远端工具并进 `ToolRegistry` 的入口在非测试构建上是死代码；界面列目录 / 启停直接返回不可用。注释写「已登记、不属未接线」，和调用点相反。

即便将来接上这条入口，列表和调用也不是同一份表：会话里的工具索引、返回给调用方的定义列表、模型实际执行用的 `ToolRegistry` 会分叉。stdio 进程已经退出时，`start` 仍可能 `Ok` 缓存定义，`is_running` 仍可能为真。

后台任务管理器**已经**由壳层实现并注入，auto-background / daemon 超时会收养而不是树杀。sync 超时树杀是模式语义，不是「trait 没人实现」。

`search_context` / `decompress_context` 已注册给模型，但工具执行器把 `compression_store` 写成 `None`，全仓库没有这个 trait 的生产实现，每次调用都是 `common.unsupported`。

探索文档配额的规范函数没有生产调用点。`allow_explore_docs` 不在 spawn 请求上。子代理 run 只给 `design` / `review` 硬塞一份 `granted: true` 的上下文；read-only / researcher 以及主代理都是 `None`，写路径看到 `None` 就放行。

笔记工具无论后端在不在，都进内置注册表。打开 `workspace.db` 成功时，run 会注入 `StoreNoteBackend`（真写对不对由 12 审）。打开失败或未安装时，读写工具返回 `Ok` 且 `ok: false` / 空 `md`，协议层当成功。trait 默认的 `apply_block_ops` 拒写；细粒度写默认都委托它。

## 问题清单

### BC11-1 生产 run 不启动 MCP，模型工具表里没有远端工具

- 现象：用户在设置里保存的 MCP server 不会被拉起，也不会出现在发给模型的工具列表里。界面列目录、启动、停止都不打到引擎。库内的桥只在测试里跑通。
- 证据：`apps/agent-workbench/src-tauri/src/engine_build.rs:703`（`#[cfg_attr(not(test), allow(dead_code))]`）、`engine_build.rs:694-708`（注释写生产装配点「本批不存在」，函数体才是 `register_plugin_server`）。全仓库对 `register_plugin_mcp_server` / `register_plugin_server` 的非测试调用只有这个死入口和测试。`apps/agent-workbench/src-tauri/src/command_manifest.rs:401-407` 把 `workbench_list_mcp_servers` / `start` / `stop` 标成幽灵命令，禁止登记。`apps/crish-desktop/src/api/mcpApi.ts:158-170`、`203-212` 列目录恒 `unavailable`、启停恒 `unsupported`，但同文件 `160` 行文案写「MCP 工具随任务运行时连接」。`McpRegistryShell` 只在 `crates/agent-tools/src/mcp/shell.rs` 的单元测试里构造。`McpServerStore` / `McpConfigPersistence` 没有生产实现（`servers.rs` 里只有测试用 `FakePersistence`）。
- 机制：`EngineHandle` 构造时确实 `McpClientBridge::new()`（`engine_build.rs:404-405`），桥对象在，会话表是空的。`mcp/mod.rs:53-56` 把 `EngineHandle::register_plugin_mcp_server` 写成「唯一生产装配入口、已登记、不属未接线」。该函数没有生产调用者，`allow(dead_code)` 是为了让这条注释在 release/dev 非测试构建里编译过去。反向外壳 `McpRegistryShell` 的模块头自己写明「≠ 生产 MCP 全网关」（`mcp/mod.rs:26-27`、`shell.rs:22-23`）：没有 stdio 服务端进程把本地注册表暴露成 `tools/list` / `tools/call`。
- 影响：设置里的 MCP、插件 `mcpServers`、浏览器 attach 配置（`browser/mcp_attach.rs` 只造 `McpServerConfig`，注释指向同一个未调用的注册函数）都到不了模型。模型侧既没有 `mcp_<server>__*` 工具，也没有一条对外的 MCP 服务在提供内置工具。

### BC11-2 工具列表和调用不是同一份注册表，同名静默跳过还返回成功

- 现象：远端 `tools/list` 的结果记在会话自己的 `tool_index` 里；模型执行走 `ToolRegistry` 里第一次塞进去的 `McpToolAdapter`。名字已经存在时不替换，函数仍 `Ok` 整份定义。重启拉起新进程后，注册表里的适配器继续指向旧会话。
- 证据：`crates/agent-tools/src/mcp/mod.rs:65-66` 写「已并入的同名工具跳过，重启重建安全」。跳过在 `mod.rs:77-80`，函数末尾 `mod.rs:102` 返回的是 `bridge.start` 的完整 `defs`，不是实际 `register_runtime` 成功的子集。`bridge_registry.rs:109-113` 在 Degraded/Exited 时 `insert` 换掉桥会话表里的 `Arc`。适配器在构造时克隆的是当时的会话（`bridge_registry.rs:29-31`、`224-228`），注册表不会更新这只 `Arc`。`get_adapter`（`bridge_registry.rs:211-218`）读的是桥表里的**当前**会话。`registry.rs:69-73` 同名是 `tool.version_conflict`，不是覆盖。`bridge_protocol.rs:55-66` 只保留 ASCII 字母数字、`_` 和 `-`，其余收成 `_`。`my.server` 与 `my_server` 前缀相同，第二个 server 的 `mcp_my_server__*` 会撞上第一个并被跳过。
- 机制：三份名字各看各的。会话 `tools()` / `tool_index` 是刚枚举的远端表；`register_plugin_server` 的返回值把跳过的名字也算成功；模型 `list_definitions` + `Tool::execute` 用的是注册表里先占坑的那个对象（内置工具，或上一轮已经退出的会话适配器）。注释里的「同一 registry」只对 `McpRegistryShell` 成立，而那个外壳没有生产挂载点（见 BC11-1）。内置工具不会被 MCP 盖掉：前缀加上「有则跳过」，结果是 MCP 工具从可调用集消失，调用方还拿到 `Ok(defs)`。
- 影响：调用方按返回的定义列表去调，会打到另一个实现，或打到已经 `Exited` 的 stdio 会话。两个 server id 只差一个被净化掉的字符时，后启动的工具整组不可调用，且没有错误。

### BC11-3 stdio 会话已经断了，start 和 is_running 仍报可用

- 现象：进程退出或握手失败之后，桥仍可能返回缓存工具定义，或把状态留在 `Degraded` 且 `is_running()==true`。崩溃监测在子进程句柄已经被取走、状态又不是 `Exited` 时不会再把会话标死。
- 证据：`bridge_registry.rs:94-95`：状态已是 `Ready` 时直接 `Ok(session.tools())`，不探活。`bridge_registry.rs:144-147`：`start` 的握手/枚举失败收尾**无条件** `set_state(Degraded)`。读者线程在 stdout EOF 时已经 `mark_exited`（`bridge_session.rs:511`），崩溃监测在 `try_wait` 看到退出时也会 `mark_exited`（`bridge_session.rs:617-618`）。这两处把状态打成 `Exited` 之后，失败收尾再写成 `Degraded`。`bridge_session.rs:124-131` 把 `Degraded` 算进 `is_running`。`request`（`bridge_session.rs:264-266`）只看 `is_running`，于是死会话仍会去写 stdin。`bridge_session.rs:601-615`：`child` 已是 `None` 时监测循环既不标退出也不结束，除非状态已经是 `Exited`。监测若已在 `mark_exited` 后 return，随后被盖成 `Degraded`，就没有人再改回来。
- 机制：`Exited` 不是终态。`start` 用一个失败后的 `Degraded` 覆盖它，健康检查又把 `Degraded` 当成「还能收发」。`Ready` 短路把「上次枚举成功」当成「进程还在」。注释 `mod.rs:64-65` 说失败时「进程保留（Degraded）供 restart」，没有处理「失败原因就是进程已经没了」。
- 影响：再次 `start` 在状态还停在 `Ready` 时不会重建，调用方拿到成功和一份过期工具表。按 `is_running` 判断的一方认为 server 活着。真正的 `tools/call` 多半会在写管道时失败或一直等到超时，但这一步已经晚于「启动成功 / 仍在运行」的报告。测试 `crash_detection_marks_exited_and_fails_calls` 只覆盖「状态保持 Exited 之后调用失败」，盖不住这条覆盖。

### BC11-4 压缩块只读契约没有实现，也没有注入，search_context 每次都是未接线

- 现象：`search_context` 和 `decompress_context` 在内置工具表里，模型可以点名。生产执行路径上 `compression_store` 恒为 `None`，工具返回 `common.unsupported`，不会查 `compression_blocks`。
- 证据：`crates/session-loop/src/exec_single.rs:424` 构造 `ToolContext` 时写死 `compression_store: None`，同一结构里 `note_backend` 和 `background` 是从上下文克隆的（`422`、`425` 行）。`crates/agent-tools/src/tools/search_context.rs:92-96`、`decompress_context.rs:100-103`：`None` 即 `common.unsupported`。`tools/mod.rs:255-261` 仍 `register` 这两个工具，注释写「引擎侧轮次 6 注入」。`compression_store.rs:49-54` 只定义 trait。全仓库 `impl CompressionContextStore` 只出现在这两个工具文件的测试替身里，没有 conex-db / orchestrator / 壳层实现，也没有第二处把 `Some(store)` 装进 `ToolContext`。
- 机制：契约注释要求引擎实现 trait 再注入（`compression_store.rs:1-7`）。执行器在唯一的生产组包点把字段钉死，壳层 `run_launch` 的 `SessionLoopOptions` 上也没有对应字段可传。工具不是返回空命中列表，而是每调必错；模型侧看起来像「有这个工具，但它不工作」。
- 影响：压缩之后的块不能被 `search_context` 找回，也不能被 `decompress_context` 按 block id 取原文。下一回合只能看见摘要管线自己留下的可见文本。空转发生在工具层，不是存储层暂时没有行。

### BC11-5 探索文档配额的规范入口没有接上，限制对探索类子代理不生效

- 现象：模块写明探索类（`capabilityMode=read-only` 或 researcher）必须由主代理在 spawn 时发给 `allow_explore_docs` 凭证，否则拒写、超配额也拒写。生产 spawn 既没有这个字段，也不调用 `quota_context_for_spawn`。没装上上下文时，写文件直接放行。
- 证据：`explore_quota.rs:292-314` 的 `quota_context_for_spawn` 只被本文件测试调用。`SubagentSpawnRequest`（`tools/subagent/contract.rs:56-95`）没有 `allow_explore_docs`。`apps/agent-workbench/src-tauri/src/subagent_spawner.rs:728-740` 装进子 run 的配置只有 `task_type` / 写路径 / `output_dir: None` / `started_at_ms`，没有能力模式。`run/run_launch.rs:782` 先把配额设成 `None`；`813-826` 仅当 `task_type` 是 `design` 或 `review` 且 `local_db()` 有值时，塞 `granted: true, quota: 1`。`920` 行把这份值放进 loop。`explore_quota.rs:322-324` 与 `357-361`：上下文是 `None` 就 `Ok` / `Ok(None)`，不占用。`tools/fs.rs:390-395`、`tools/replace.rs:102-107` 都走这个守卫。`tools/output_dir.rs:494` 用 `explore_docs_quota.is_some()` 当作「只读调用方」：真正拿到上下文的 design/review 不能自选产出目录；read-only / researcher / analysis 因为是 `None`，反而不被当成只读，写配额也不查。
- 机制：壳层用任务类型硬编码替代了契约函数，并且恒 `granted: true`，不看主代理有没有发凭证。`local_db()` 为 `None` 时（非 `LocalDb` 的 store）连 design/review 也退回 `None`，守卫同样放行（`run_core.rs:674-675` 说明非 LocalDb 就是 `None`）。主代理 `None` = 不消耗，这是模块自己的口径（`loop_runner.rs:146-148`），不是这条问题；问题是探索类子代理也被同一条 `None` 放行。
- 影响：read-only / researcher 子代理只要工具表里还有 `write_file` / `replace`，就可以连续写文档，不会得到「配额已用尽，请回报主代理」。design/review 在有 LocalDb 时被限成 1 份，但这条限制不是 `allow_explore_docs` 凭证，主代理无法拒绝，也盖不住其他任务类型。

### BC11-6 笔记工具始终注册给模型；未注入或 trait 默认实现时，拒写和空读以成功形态返回

- 现象：十一个笔记工具进内置表，不看后端在不在。后端缺失时工具 `Ok` 一份 `ok: false` / 空字符串，不走 `Err`。trait 默认不实现块写入；`get_md` 约定文档不存在时 `Ok("")`。
- 证据：注册在 `tools/mod.rs:262-275`，注释写明未注入返回 `note_backend_unwired`。`note_block_insert.rs:125-131`（其余 `block_*`、`document_apply_md`、`send_to_note`、`query_blocks`、`document_outline` 同形）在 `note_backend` 为 `None` 时 `return Ok`。`note_document_get_md.rs:71-76` 未注入时 `Ok` 且 `md: ""`；`85-90` 把除 `Invalid` 以外的后端错误也收成 `Ok`、`md: ""`。`mcp/shell.rs:344-347` 的测试把这记成「业务成功、`isError` 为 false」。`note_backend.rs:143-149` 默认 `apply_block_ops` 返回 `Invalid("apply_block_ops not supported")`；`155-176`、`187-211`、`217-241`、`247-271`、`277-301` 的 insert/update/delete/move/set_attr 默认都调用它，于是整组拒写。`note_backend.rs:117` 约定空树或缺文档是 `Ok("")`，不是 `NotFound`。`validate_batch_token` 默认见到非空 `batch_id` 就 `BatchTokenInvalid`（`122-131`）。`undo_text` / `redo_text` 默认 `Invalid`（`70-90`）。
- 机制：生产注入点是有的，而且不是 `None` 常量。`db_setup.rs:74-93` 调用 `note_runtime::init_default`；失败只打日志，槽位保持空，文案写「笔记工具/命令保持 unwired」。`note_runtime.rs:135-137` 的 `try_backend()` 在未安装时返回 `None`。`run/run_launch.rs:925` 和 `engine_build.rs:1553-1556` 把这个 `Option` 放进 `SessionLoopOptions`，`loop_runner.rs:163` 和 `exec_single.rs:425` 再抄进 `ToolContext`。打开成功时句柄是 `StoreNoteBackend`（`conex-note-runtime` 的 `impl NoteBackend` 覆写了 `apply_block_ops`，`store_backend.rs:338`）；覆写之后写不写得进库是 12 的范围，本条不把 Store 内部当成默认拒写。权限矩阵（`note_permission.rs:40-49`、`note_action_matrix.rs:64` 起）只决定 plan/ask 放不放行，不代替后端。
- 影响：数据库没打开时，模型仍看到 `block_insert`、`document_apply_md` 等可调用工具；返回值是普通 JSON 成功，`ok: false` 容易被当成「写过了但没变化」或「读到了一份空文档」。`document_get_md` 在后端报错时同样给出空 `md` 且 `Ok`。谁要是只实现了 trait 的必填方法、沿用默认 `apply_block_ops`，细粒度写会拒，工具描述却仍是可写。

### BC11-7 子代理注入有三段没进生产提示词，git 年代没有算出来

- 现象：`started_at` 文案和权限申请指引会进子代理系统提示。产出目录段、注释保留段不会。续跑沿用首次 `started_at` 的解析函数没有生产调用。git 回退阈值只是写进句子里的数字，没有人查询目标 ref 的提交时间。
- 证据：`run/run_launch.rs:833-866` 只 push `subagent_session_injections`（`835` 行传入 `DEFAULT_REF_AGE_THRESHOLD_HOURS`）和 `permission_relay_injection`；`859-864` 的 `output_dir_injection` 包在 `config.output_dir` 为 `Some` 时。生产构造 `subagent_spawner.rs:739` 把 `output_dir` 写成 `None`，`740` 行 `started_at_ms: now`。`comment_preservation_section` 的调用只有 `subagent_inject.rs:160` 定义和同文件测试。`resolve_started_at`（`subagent_inject.rs:121-126`）只有测试和 `orchestrator` 测试调用。模块头 `subagent_inject.rs:7-8` 写「真实 git 年代查询由引擎侧接线」；壳层唯一相关调用就是把小时数填进固定段落（`run_launch.rs:833-835`）。
- 机制：注入函数是纯文本。壳层对子代理 run 挂了其中两段，另外两段的挂载条件在生产构造里不成立，或根本没有调用。`started_at` 用的是本次 spawn 的当前时间，不是 `resolve_started_at` 从已有行读出的首次时间。回退谨慎指引要求模型自己判断 ref 是否早于 `started_at` 超过阈值，引擎不提供那个时间。
- 影响：子代理不知道主控定下的产出目录（而且 BC11-5 里探索类的目录信号也是反的）。注释保留只靠替换工具的匹配，没有提示词约束。续跑如果再次走过这条 spawn 构造，隔离边界时间会被刷新成「现在」。超龄 ref 没有机器判定，只有一段让模型自行遵守的文字。

## 已核对闭合或不是问题

- 后台任务 trait **有**壳层实现，生产 run **有**注入。`bg_task.rs:38` `impl BackgroundTaskManager for BackgroundTaskRegistry`；`main.rs:914-923` 把注册表交给 `CoreRunState`；`run_launch.rs:928-929` 放进 `options.hooks.background`；`loop_runner.rs:165` 抄到 `tool_ctx`；`exec_single.rs:422` 再抄到单次 `ToolContext`。`shell_exec.rs:159-177`：auto-background 超时在 manager 为 `Some` 时 `adopt`，不树杀。sync 模式超时树杀（`shell_exec.rs:195-204`）是该模式的定义，不是未接线。manager 为 `None` 时退回树杀（`178-193`）只发生在没注入的调用方；生产主路径不是这条。
- MCP 桥在状态**保持** `Exited` 时，随后的 `tools/call` 走 `unavailable_error`，集成测试 `crates/agent-tools/tests/mcp_bridge.rs` 的 `crash_detection_marks_exited_and_fails_calls` 锁了这条。问题是 BC11-3 的状态被盖掉和 Ready 短路，不是「一旦 Exited 调用仍返回 Ok」。
- `McpRegistryShell` 自己的 `list_tools` 与 `call_tool` 共用同一个 `Arc<ToolRegistry>`（`shell.rs:93-133`）。分叉不在这个外壳内部，而在它没被挂上，以及桥会话表和 `ToolRegistry` 各记一份（BC11-1、BC11-2）。
- 笔记后端在 `init_default` 成功时会注入，工具不是永远打在 trait 默认实现上。默认拒写只对未覆写 `apply_block_ops` 的实现成立。Store 是否把块写进 `workspace.db` 不在本文。
- 主代理 `explore_docs_quota = None` 表示不受配额约束，与 `explore_quota.rs` 模块说明一致，不单列成问题。问题是探索类子代理被同一语义放行（BC11-5）。
- `note_permission` / `note_action_matrix` 的 plan 拒绝写、只读 Allow，是权限三态，不是空实现。它们不决定后端有没有接上。

## 覆盖与未覆盖

- 已读：`mcp/` 下桥、协议、会话、注册、外壳、server 配置；`background.rs` 契约与壳层 `BackgroundTaskRegistry` / `RunAwareBackgroundManager` 的注入链；`shell_exec` 里超时收养与树杀的分叉；`explore_quota` 的守卫和 `run_launch` / `subagent_spawner` 的装配；`compression_store` 与 `exec_single` 组包；`note_backend` 的 trait 签名和默认方法；笔记工具在 `None` 时的返回；`note_permission` 与 `note_action_matrix` 的表；`subagent_inject` 的生产 `push` 点。
- 未读：`conex-note-runtime`、`conex-workspace-store` 的写入与 hydrate（12）。`StoreNoteBackend` 只确认了 `impl NoteBackend` 覆写了 `apply_block_ops` 等入口，没有审落盘对不对。
- 未追：浏览器 / 电脑 MCP attach 的 CDP 会话本身（不在本轮边界）；子代理工具表面裁剪是否另有一条只读白名单（那是权限与 spawn 工具域，本文只记录配额上下文没有按能力模式装上）。

## 给主控的摘要

1. 生产不启动 MCP。`register_plugin_mcp_server` 非测试构建是死代码，界面列目录/启停恒不可用，注释里的「已接线」没有调用点。
2. 反向外壳 `McpRegistryShell` 没有生产挂载，本地工具不会以 MCP `tools/list` 对外。
3. 桥会话工具表和 `ToolRegistry` 是两份。同名跳过仍 `Ok` 全量定义；重启后适配器指向旧进程。净化后的 server id 会撞名。
4. stdio 已退出时，`start` 的 Ready 短路仍返回缓存定义；失败收尾把 `Exited` 盖成 `Degraded`，`is_running` 仍为真。
5. 后台任务管理器已实现并注入。auto-background 会收养；sync 超时树杀是模式语义，不是缺实现。
6. `search_context` / `decompress_context` 已注册，执行器把 `compression_store` 钉成 `None`，仓库里没有该 trait 的生产实现，调用恒 `common.unsupported`。
7. `quota_context_for_spawn` 与 `allow_explore_docs` 没有生产入口。只有 design/review 且有 LocalDb 时硬给配额 1；其余 `None` 放行写。
8. `output_dir` 把「有配额上下文」当成只读，和探索类判定是反的。
9. 笔记工具始终在模型工具表里。db 打开失败时返回 `Ok` + `note_backend_unwired` 或空 `md`。打开成功才注入 Store；默认 `apply_block_ops` 拒写。落盘归 12。
10. 子代理提示词只挂了 started_at 和权限申请。产出目录段因 `output_dir: None` 不挂，注释保留段无调用，git ref 年代没有计算。
