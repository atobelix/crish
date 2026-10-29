#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// 非 Windows 平台：WebView2 / Win32 / COM 专属路径不参与运行，平台门控下的
// 死代码与未使用项放行；Windows（主发布面）仍保持 -D warnings 全量。
#![cfg_attr(
    not(windows),
    allow(dead_code, unused_imports, unused_variables, unused_mut)
)]

//! Tauri 壳集成接线（B6.4 重建版）
//!
//! 本文件是进程内核心（IPC 模式）的装配层，职责：
//! - **注册面**：[command_registry!] 宏以 (命令名, 实现路径) 二元组为编译期
//!   真源，同源生成 [COMMAND_REGISTRY_NAMES]（注册面清单）与
//!   [build_invoke_handler]（`generate_handler!` 分发）；注册面必须与
//!   `command_manifest.rs` 的 `registered=true` 集合逐项一致（壳测试锁定）；
//! - **setup 序列**（依 PE-01/PE-04/PE-08 接线契约）：
//!   ① conex-telemetry 初始化（级别：`CRISH_LOG_LEVEL` 优先，dev debug /
//!   release info；文件层 `app_dir()/logs` 双通道）+ 崩溃文件 panic hook；
//!   ② LocalDb 打开（`app_dir()/sessions.db`，失败降级内存 + `db_ready=false`）；
//!   ③ 模型配置单一存储初始化与文件变更监听；
//!   ④ [WorkspaceRegistry::init] manage（工作区沙箱真源）；
//!   ⑤ [SharedGatekeeper] / [SharedSearchState] / [SharedCompactionState] manage；
//!   ⑥ [StatusDiagnostics] manage（与 CoreRunState 共享同一实例）；
//!   ⑦ restore：`run_restore` 经 run_in_runtime 在 `manage(CoreRunState)` 之前
//!   执行（成功 seed_sequences + 立即快照；失败降级不阻断启动）；
//!   ⑧ [CoreRunState] manage + [EventBridge] manage + [SharedDb] manage；
//!   ⑨ 模型目录由核心已提交配置快照派生；
//!   ⑩ MCP 插件：debug 下 `dev_mcp::register_if_enabled(builder)`（默认开启，
//!   `CRISH_MCP_SOCKET=0` 显式关闭；2026-08-21 用户裁决）；
//!   ⑪ 多端本地服务生产装配（R1-11 G-1）：CoreStateBackend（真实
//!   `*_impl` 直调面）+ FanOutEmitter（挂 EventBridge 汇聚点，注入
//!   ServerState.event_stream）+ PairingCoordinator（set_port / rebind
//!   钩子接 restart_server）+ 服务开关（D5 D-01 红线 1：默认关闭 =
//!   不 bind 任何端口；multi_device_set_enabled 命令启停）；
//! - **退出钩子**：`RunEvent::Exit` 时 PTY 清理 + 多端服务优雅关停
//!   （ServerLifecycle 槽）+ [CoreRunState::save_snapshot_blocking]（独立线程）。

mod asset_scope;
mod auth;
mod auth_commands;
mod background;
mod browser;
mod browser_commands;
// 浏览器书签/历史落库适配（3 方案 U4：browser_import_sinks.rs 由浏览器
// 阵营交付，main.rs mod 声明缺失导致 crate 编译中断——R1-11 装配面顺手补齐）
mod browser_import_sinks;
mod command_manifest;
// 统一配置单轨测试夹具（壳层域；probe / engine_tests 共用——cfg(test) only）
#[cfg(test)]
mod config_test_support;
// 电脑操作会话槽（06 遗留⑨：ComputerSlot 命令面托管 + 工具装配接线面，
// 接线点登记见 computer/mod.rs 模块头）
mod computer;
mod config;
mod core_commands;
mod core_query_commands;
// R1 撤回命令（统一输入流收敛战役；命令面独立于 run/ 目录——I1-β 并行
// 位在改 run_idle/run_launch/engine_build，避免争写）
mod dev_mcp;
mod engine;
mod fs_commands;
mod git;
mod host_openers;
mod host_paths;
mod logging;
mod markdown_commands;
mod mcp_commands;
mod models_yaml;
mod retraction_commands;
// 多端互通模块族（R1-06：TLS + 自签证书 + 指纹固定，multi_device/tls.rs；
// R1-07：配对命令面，multi_device_commands.rs；R1-09：单实例锁，
// single_instance.rs——G-2 桌面多实例端口竞争）
mod multi_device;
mod multi_device_commands;
mod multi_device_service;
pub(crate) use multi_device_service::{restart_server, MultiDeviceService, ServerLifecycle};
// R1-09 G-4：网络环境检测（multi_device_network.rs：注册表网络配置文件
// 类别 + 可直连 IP 枚举 + 防火墙/AP 隔离引导文案）
mod multi_device_network;
mod note_commands;
mod note_runtime;
mod perf;
mod preferences_commands;
mod probe;
mod process;
mod pty;
mod resource;
// 账户远程接入（设备心跳 / loopback 网关 / relay host 桥）
pub(crate) mod remote;
// R3-02 推送装配适配层（bin 侧：lib push 契约 ↔ bin server/WsRegistry 桥接
// ——DevicePresenceSource 适配 + PushChannel WS 实现；
// 见 push_wiring.rs 模块头注记）
mod push_wiring;

#[path = "server/core_backend/mod.rs"]
pub(crate) mod core_backend;
mod server;
mod session_commands;
// b6：首条助手回复后的短标题。命令面独立于 run/，避免和运行生命周期争写。
mod session_title_commands;
mod single_instance;
// ACT-101 / CON-01：原生窗口隐式创建 + 首绘握手唤醒（Stage 1）
mod tauri_emitter;
mod window_backdrop;
mod window_handshake;
// Win11 贴靠布局（Snap Layouts）：最大化按钮上的原生 HTMAXBUTTON 热区
mod window_snap_overlay;
// ACT-102：双 SQLite 并发装配（spawn_blocking + async 汇聚）
mod db_setup;
// sched / subagent_spawner / timers 已下沉 `conex-run` crate
// （conex_run::{sched, subagent_spawner, timers}；壳层无独立 mod 声明）。
mod system_power;
// 自动更新命令面（RUN-03/SEC-02/GAP-01：检查/下载/安装/重启四段命令 +
// workbench_apply_update 一次编排；模块头登记链路与用户裁决 §3.4-3 出处）
mod updater;
mod usage_commands;
// workflow 业务后端已下沉 `conex-run`（conex_run::workflow）；壳层只留
// Tauri IPC 薄壳（workflow_ipc.rs：六条命令 + AppHandle 事件发射 +
// create_workflow 工具通道延迟绑定）。
mod workflow_ipc;
// run IPC 薄壳（十条命令 + 回收站根解析 + 设置域直调体；业务实现 =
// conex_run::run 契约体）
mod run_ipc;

mod watchdog;
// D6-②：无人值守唤醒 watcher（任务连续性维度 D6；本体已下沉 conex-run，
// 壳层只做装配注入）。装配点（壳层面批次接线）：
// - 每会话 spawn：run_restore 成功路径 / run_task_impl 会话首次出现处
//   惰性 spawn（CoreRunState 新增 wake_watchers 幂等持有表，与
//   watchdog 每会话任务同生命周期语义——run 收口不销毁）；
// - 注入件：queue = engine.timer_steering_queue() 同实例；
//   has_active_run = active_runs 锁内同会话扫描；empty_streak =
//   resume_empty_streak 只读；launcher = spawn_idle_resume_run 包装；
// - user_stopped：run_control L2/L3 路径 set、用户新 run 装配 clear。
#[cfg_attr(not(test), allow(dead_code))]
mod outputs_config;
mod workspace;
// C3 交付物(任务连续性测试基建):可脚本化 mock SSE/HTTP server——
// 响应序列(429+Retry-After / 5xx / 发数据后断流 / 正常流)按请求序号
// 消费,记录请求供断言;供 D1/D2/D3/D5 壳层测试共用(cfg(test) 仅测试面,
// 不参与生产构建)
#[cfg(test)]
mod scripted_mock_server;

use std::sync::Arc;

use conex_run::core_event_bridge::{Emitter, EventBridge};
use tauri::Manager;
use tauri_emitter::TauriEmitter;

mod command_registry;

use command_registry::{build_invoke_handler, COMMAND_REGISTRY_NAMES};

pub(crate) mod lifecycle_commands;

/// 退出快照线程的等待上限。
///
/// 正常快照在百毫秒级完成；上限只用于兜底磁盘挂死等异常场景，避免退出无限挂起。
const SNAPSHOT_JOIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 等待退出快照线程完成（最多 [SNAPSHOT_JOIN_TIMEOUT]）。
///
/// 不用裸 `join()`：磁盘异常时会让应用永远退不出去。超时只记日志——此时
/// 快照可能不完整，但下次启动的 restore 有「半水合快照」门禁兜底，不会用
/// 残缺内容覆盖主快照。
fn wait_snapshot_thread(handle: std::thread::JoinHandle<()>) {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = handle.join();
        let _ = done_tx.send(());
    });
    if done_rx.recv_timeout(SNAPSHOT_JOIN_TIMEOUT).is_err() {
        tracing::error!(
            target: "shutdown",
            timeout_ms = SNAPSHOT_JOIN_TIMEOUT.as_millis(),
            "退出快照写入超时，可能不完整（下次启动 restore 门禁会拒绝半水合快照）"
        );
    }
}

fn main() {
    // setup 序列 ①（前置）：tracing 初始化在 Builder 装配之前，保证后续
    // 日志可用（PE-04 T04.1-1 双通道：文件层 + stderr）。
    let logging = crate::logging::init();
    let app_dir = logging.app_dir;
    let log_dir = logging.log_dir;
    let level = logging.level;

    // RUN-05：release 形态旧数据一次性迁移（exe 目录 → app data dir；dev no-op）。
    // 复制语义：旧目录（可能为只读安装位）原数据永不动 = 失败可回滚不丢数据；
    // 迁移标记 + 目标已有 sessions.db 双短路保证重复启动不重复迁移。
    let legacy_migration = crate::host_paths::migrate_legacy_release_data(&app_dir);

    // RUN-05 验收证据：启动日志打印三处真实路径（应用数据根 / DB / 日志）
    // + 工作区根，与迁移结果一并落日志（排障时可直接核对实际落盘位置）。
    tracing::info!(
        target: "host_paths",
        app_dir = %app_dir.display(),
        db_path = %app_dir.join("sessions.db").display(),
        log_dir = %log_dir.display(),
        workspace_root = %crate::host_paths::workspace_root(&app_dir).display(),
        legacy_migration = ?legacy_migration,
        "宿主路径与旧数据迁移结果"
    );
    if let crate::host_paths::LegacyMigration::Failed { reason } = &legacy_migration {
        tracing::warn!(
            target: "host_paths",
            reason = %reason,
            "旧数据迁移失败：原数据完好保留在旧目录，本次以空库自愈启动（下次启动自动重试）"
        );
    }

    // 共享诊断（PE-04 T04.5）：CoreRunState 与 core_get_status 共用同一实例，
    // main.rs 先构造再注入，避免「写入侧与读取侧实例漂移」。
    let diagnostics = Arc::new(conex_run::status_diagnostics::StatusDiagnostics::new());
    // setup 闭包为 'static：预克隆需要跨闭包持有的所有权
    let setup_diagnostics = Arc::clone(&diagnostics);
    let setup_log_dir = log_dir.clone();
    let setup_level = level.clone();
    let setup_app_dir = app_dir.clone();

    // G-1（R1-09）：本地服务生命周期槽（句柄 + serve task 单一真源）。
    // rebind 钩子与退出钩子共用同一实例——重建后句柄自动更新，退出关停
    // 无需再依赖 Tauri state 注入；setup 与退出闭包各自预克隆。
    let server_lifecycle: Arc<std::sync::Mutex<ServerLifecycle>> =
        Arc::new(std::sync::Mutex::new(ServerLifecycle::default()));
    let setup_lifecycle = Arc::clone(&server_lifecycle);
    let exit_lifecycle = Arc::clone(&server_lifecycle);

    // G-2 单实例锁（R1-09）：官方插件必须**最先**注册——插件 setup 在
    // build() 阶段执行，第二实例在此即 cleanup + exit(0)，不会走到 run()
    // （不初始化窗口/本地服务 8765-8775/数据库），端口竞争由此消除；
    // 首实例在插件回调里执行窗口前置提示（single_instance.rs）
    let builder = tauri::Builder::default()
        .plugin(single_instance::register())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_persisted_scope::init())
        // 自动更新（RUN-03/SEC-02/GAP-01）：官方 updater 插件；通道配置读
        // tauri.conf.json `plugins.updater`（endpoints/pubkey），Minisign 验签
        // 在插件内完成；命令面接线见 src/updater.rs
        .plugin(tauri_plugin_updater::Builder::new().build());

    // setup 序列 ⑩：MCP 调试插件（debug 默认开启，CRISH_MCP_SOCKET=0 显式关闭；
    // release 由插件自身拒绝兜底，注册点本身亦被 cfg 隔离。2026-08-21 用户裁决）。
    #[cfg(debug_assertions)]
    let builder = dev_mcp::register_if_enabled(builder);

    builder
        .invoke_handler(build_invoke_handler())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let diagnostics = &setup_diagnostics;
            let log_dir = &setup_log_dir;
            let level = &setup_level;

            // ① 已完成（main 入口）；日志目录记录进诊断
            diagnostics.record("telemetry", true, Some(log_dir.display().to_string()));

            // ①b ACT-101：窗口握手状态 + 1000ms 原生看门狗（RISK-MED-02）
            // —— 必须在双库装配前托管：握手命令 / second-launch / 看门狗
            // 三路共用 WindowHandshakeState.shown CAS 门闩。
            // StatusDiagnostics 同步前置 manage：workbench_window_ready / 看门狗
            // 均依赖 State<Arc<StatusDiagnostics>>，若拖到 ⑥ 才注入会 Command 错误。
            let handshake = Arc::new(window_handshake::WindowHandshakeState::new());
            app.manage(Arc::clone(&handshake));
            app.manage(Arc::clone(diagnostics));
            // 自动更新三段式会话槽（check→download→install 交接面，updater.rs）
            app.manage(updater::UpdaterSession::default());
            window_handshake::spawn_window_guard_dog(
                app_handle.clone(),
                window_handshake::DEFAULT_WATCHDOG_TIMEOUT,
            );

            // ①c 原生窗口系统材质（Win11 Mica 云母 / Solid 阶梯回退）
            if let Some(main_window) = app.get_webview_window(window_handshake::MAIN_WINDOW_LABEL) {
                window_backdrop::setup_window_backdrop(app, &main_window, diagnostics);
            }

            // ② 双 SQLite 并发装配（ACT-102 / INV-02 Phase-1）：
            // spawn_blocking 并发 open sessions.db + workspace.db；
            // setup 为同步闭包且 SharedDb / NoteRuntime 必须在返回前
            // manage —— 经 block_on 汇聚（内部仍并发，非串行 I/O）。
            // 禁止回潮为同步串行 open_session_db + init_default。
            let db_init = tauri::async_runtime::block_on(
                db_setup::setup_databases_concurrently(
                    setup_app_dir.clone(),
                    Arc::clone(diagnostics),
                ),
            )
            .map_err(|e| {
                tracing::error!(target: "db", error = %e, "双库并发装配任务 join 失败");
                e
            })?;
            let shared_db = db_init.session_db;
            let store: Arc<dyn orchestrator::persist::Store> =
                Arc::new(orchestrator::persist::LocalDbStore::new(shared_db.local_db()));

            // ②b NoteRuntime（并发路径已打开；失败保持 unwired）
            match db_init.note_runtime {
                Some(shared) => {
                    let path_display = shared.path().display().to_string();
                    diagnostics.record("note_runtime", true, Some(path_display));
                    app.manage(shared);
                }
                None => {
                    // 失败已在 db_setup 内记诊断（note_runtime error 分支）
                }
            }

            // ②c 双库装配完成 → 置位 db_ready 并通知握手等待者
            // （含降级路径：完成即置位，窗口不因 db 失败而死锁）
            handshake.mark_db_ready();

            // ③ 初始化唯一配置存储及已提交变更事件
            if let Err(error) = config::init_models_store(&app.handle().clone()) {
                diagnostics.record("models-config", false, Some(error.to_string()));
                tracing::error!(error = %error, "模型配置初始化或监听失败");
            }

            // ④ 工作区注册表（沙箱根真源；加载 recent 列表 + 默认应用根）
            match workspace::WorkspaceRegistry::init() {
                Ok(registry) => {
                    match asset_scope::allow_registered_workspace_roots(
                        app.handle(),
                        registry.roots(),
                    ) {
                        Ok(()) => diagnostics.record("workspace", true, None),
                        Err(error) => {
                            tracing::error!(
                                target: "workspace",
                                error = %error,
                                "无法将已授权工作区接入 asset 协议"
                            );
                            diagnostics.record("workspace", false, Some(error));
                        }
                    }
                    app.manage(registry);
                }
                Err(error) => {
                    tracing::error!(
                        target: "workspace",
                        error = %error,
                        "WorkspaceRegistry 初始化失败（文件命令按 outside_workspace 拒绝）"
                    );
                    diagnostics.record("workspace", false, Some(error.to_string()));
                }
            }

            // ④b 回收站根注入（I2-S5：None = 未注入 → 命令侧回退活动
            // 工作区 `.crish-trash`，与删除工具兜底一致；对齐
            // BuiltinToolConfig.trash_root 语义）
            app.manage(conex_run::run::TrashRootConfig::default());

            // ⑤ 共享状态：命令闸门 / 搜索索引 / 压缩能力标记
            app.manage(core_commands::SharedGatekeeper::new());
            // 只读面就绪事实快照（CoreStateBackend 注入消费；启动时索引
            // 为空 → false 诚实降级，重建后由命令面更新——核心状态查询
            // 与命令面共享同一事实源）
            // C21 接线：托管类型为 Arc<SharedSearchState>（对齐
            // Arc<CoreRunState> 先例）——命令面（core_search_files /
            // core_rebuild_search_index / core_get_status）与本地服务后端
            // （with_search_state 注入，见 ⑪a）经 Arc clone 共享同一实例，
            // 索引重建立即可见；tauri State 只暴露 &T 引用无法回取 Arc，
            // 故托管面本身必须是 Arc（未接线命令面为历史直管形态）。
            let search_state = Arc::new(core_commands::SharedSearchState::new());
            let search_index_ready = !search_state
                .files
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty();
            app.manage(Arc::clone(&search_state));
            let compaction = core_commands::SharedCompactionState::new();
            // 压缩为纯内存能力（conex-compaction），core_compact_messages 已接线）
            compaction.set_ready(true);
            let compaction_ready = compaction.is_ready();
            app.manage(compaction);

            // ⑤b 多端互通配对协调器（R1-07：令牌库 + WS 注册表；重绑钩子与
            // 端口由服务装配面（R1-11 G-1）注入；命令面先独立可用）。
            // Arc 形态托管：命令面（State<Arc<PairingCoordinator>>）与服务
            // 装配（restart_server 注入 set_port / rebind 钩子）共用同一实例。
            let pairing_tokens = crate::server::auth::TokenStore::load(
                &app.path()
                    .app_config_dir()
                    .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default())
                    .join("pairing.json"),
            );
            // G-1：WS 注册表保留 Arc 副本（唤醒恢复「已有 WS 踢重连」消费；
            // 与协调器内部持有的是同一实例；P2-5 裁决后同时注入
            // MultiDeviceService.ws_registry——路由层 / push presence /
            // 直投 / 撤销踢链全链共享同一实例）
            let ws_registry = Arc::new(crate::server::ws::WsRegistry::new());
            let pairing = Arc::new(crate::server::pairing::PairingCoordinator::new(
                std::sync::Arc::new(std::sync::Mutex::new(pairing_tokens)),
                Arc::clone(&ws_registry),
            ));
            app.manage(Arc::clone(&pairing));

            // 用户账号中心管理与系统级凭据安全存储（DPAPI）。
            // Base URL 配置化（audit-repair-202609 T16）：缺省生产地址
            // auth.flowbit.me，可经 CRISH_AUTH_BASE_URL 环境变量覆盖。
            let auth_base_url = std::env::var("CRISH_AUTH_BASE_URL")
                .ok()
                .filter(|v| !v.trim().is_empty());
            let auth_manager =
                crate::auth::AuthManager::new(setup_app_dir.clone(), auth_base_url);
            let remote_auth = Arc::clone(&auth_manager);
            app.manage(auth_manager);

            // ⑥ 状态诊断已在 ①b 前置 manage（与 CoreRunState 共享同一实例）；
            //    此处不再重复 manage（Tauri manage 同类型重复注入会 panic）。

            // 事件桥（B6.3：workbench-run-event 通道；Tauri 发射器）——R3-02
            // 推送装配（D7 §9.2 方案 a）：PushAwareEmitter 装饰内层发射器
            // （转发原通道不变 + 旁路 push-core 决策与双轨分发——在线 WS
            // 直推 / 离线 pending 内存队列，R3-03 厂商发送器消费）。在线
            // 判定与直投数据源 = 共享 WsRegistry（与配对协调器同一实例，
            // 见 ⑤b；P2-5 裁决后路由层 ServerState 亦注入该共享实例——
            // 连接面全链统一，presence/直投/撤销观察真实连接）；适配层在
            // push_wiring.rs（Emitter 双向桥 + WsRegistry 适配 + 直投）
            let browser_emitter_handle = app_handle.clone();
            let push_dispatcher = Arc::new(crish_agent_workbench::push::PushDispatcher::new(
                Arc::clone(&ws_registry) as Arc<dyn crish_agent_workbench::push::DevicePresenceSource>,
                Arc::new(push_wiring::WsPushChannel::new(Arc::clone(&ws_registry)))
                    as Arc<dyn crish_agent_workbench::push::PushChannel>,
            ));
            let push_aware = Arc::new(crish_agent_workbench::push::PushAwareEmitter::new(
                // PushAwareEmitter 直接实现 conex_run::core_event_bridge::Emitter
                // （push/pusher.rs；双 trait 桥随 core_event_bridge 下沉合一删除）
                Arc::new(TauriEmitter::new(app_handle.clone()))
                    as Arc<dyn conex_run::core_event_bridge::Emitter>,
                push_dispatcher,
            ));
            let bridge = EventBridge::new(
                "workbench-run-event",
                // 桥上行（bin Emitter for lib PushAwareEmitter）在 push_wiring.rs
                Arc::clone(&push_aware) as Arc<dyn Emitter>,
            );

            // 快照存储（B4.3：主文件 + .prev 备份双文件模型）
            let snapshot_path = setup_app_dir.join("orchestrator-snapshot.json");
            let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> =
                Arc::new(orchestrator::restore::SnapshotFileStore::new(&snapshot_path));

            // ⑧b 后台任务注册表（T-AB-07：G1 最小底座）独立托管（不并入
            // CoreRunState，职责单一）。回收语义：run 结束不回收任务（会话级
            // 存活）；应用退出 → process.rs daemon Job 兜底全杀（孤儿保护与
            // PTY Job 同族且相互隔离）。工具执行器装配 ToolContext.background
            // 经 BuiltinToolConfig 透传（冻结接口 #1）：引擎侧接线点在
            // engine.rs:617（F1 轮末已装配 register_builtin_tools_with_config）。
            let background_tasks = Arc::new(background::BackgroundTaskRegistry::new());

            // ⑥' 引擎宿主（browser/computer 槽 + workflow 创建通道绑定 +
            // 全局注入：配置源 / runtime 句柄 / 应用数据目录 / 笔记后端）。
            // **必须先于 CoreRunState::new**——引擎装配经 EngineHostHooks
            // 消费宿主（browser 工具注册）；db 注入 timer/sched/wait/computer
            // 四 store 真适配。
            let engine_host = engine::EngineHost::new(Some(shared_db.local_db()));

            // 核心运行状态（store / 快照 / 事件桥 / 诊断 / 后台任务管理器注入）
            let core_state = Arc::new(conex_run::run::CoreRunState::new(
                Arc::clone(&store),
                Arc::clone(&snapshots),
                bridge.clone(),
                Arc::clone(diagnostics),
                Some(Arc::clone(&background_tasks)
                    as Arc<dyn agent_tools::background::BackgroundTaskManager>),
            ));
            // T-D-13：子代理 spawner 注入面装配（launcher / db / wait 广播 /
            // steering 队列——Arc 构造完成后注入，spawner 在 engine 内）
            core_state.finalize_subagent_spawner();
            // 全局运行策略读入（用户裁决：重试预算/上限可配置，进
            // settings.json 不绑供应商；文件缺失/解析失败 → 缺省）
            core_state.set_run_policy(
                config::persistence::config_dir()
                    .ok()
                    .and_then(|dir| conex_run::run_policy::read_run_policy_from(&dir)),
            );
            // 审计 01 W1（任务连续性推进轮）：kill_subagent / send_message
            // 三通道 + WaitChannel 控制总线解析器生产装配（与 spawner 同批
            // ——Arc 构造完成后经板卡绑定真实现，工具从 unsupported 升级为
            // 生产可用）
            core_state.finalize_continuity_channels();
            // 引擎句柄绑定宿主（browser/computer/workflow 通道访问面）+
            // MCP 自动拉起（auto_start 配置）
            engine_host.bind_engine(core_state.engine());
            engine_host.spawn_mcp_autostart();

            // ⑦ restore：run_in_runtime 在 manage(CoreRunState) 之前执行
            //（成功 seed_sequences + 立即快照；失败降级不阻断，门禁经
            // restore_ready 放行——conex_run::run::run_snapshot 语义）
            {
                let restore_state = Arc::clone(&core_state);
                tauri::async_runtime::spawn(async move {
                    let _ = restore_state.run_restore().await;
                });
            }

            // ⑧ CoreRunState / EventBridge / SharedDb / 后台任务注册表 manage
            // （bridge 以 clone 入管：原值继续供任务事件接线与 drain 任务使用）
            app.manage(Arc::clone(&core_state));
            app.manage(bridge.clone());
            app.manage(shared_db.clone());
            app.manage(Arc::clone(&background_tasks));

            // ⑧d 27 方案 S6：浏览器会话槽事件发射器接线——`browser://state-changed`
            // 状态迁移 → 前端面板（挂接幂等：命令面后续 attach 无副作用；
            // 启动前即挂订阅，首启 Launching→Running 迁移不丢事件）
            engine_host
                .browser_slot()
                .attach_emitter(Arc::new(TauriEmitter::new(browser_emitter_handle)));

            // ⑧e 06 遗留⑨：电脑操作会话槽装配——进程级单例托管
            // （ComputerSlot：session_meta `computer_use_enabled` 惰性恢复 +
            // 互斥门；命令面 computer_session_* 消费）。
            // 事件发射器接线：`computer://state-changed` 状态迁移 → 前端面板
            // （挂接幂等；启动前即挂订阅，enable/disable/on_run_stopped 不丢事件）。
            // 宿主持有同一实例；main.rs 取用托管给 Tauri State，命令访问面不变。
            {
                let computer_slot = engine_host.computer_slot();
                app.manage(Arc::clone(&computer_slot));
                computer_slot.attach_emitter(Arc::new(TauriEmitter::new(app_handle.clone())));
            }

            // 浏览器槽托管给 Tauri State（browser_commands 命令访问面）
            app.manage(engine_host.browser_slot());
            let native_browser_manager =
                crate::browser::NativeWebviewManager::new(setup_app_dir.clone());
            app.manage(native_browser_manager);

            // ⑧b+ 30 方案 P2/P3 装配：后台任务事件面接线（生产发射链）——
            // ① 任务事件消费器注入（先于 set_event_bridge：EventBridgeSink
            // 构造时读取消费器快照，顺序契约见 task_event_consumer.rs 模块
            // 头）；② 事件桥并入通知投递器（替换默认 LogEventSink 留痕，
            // 七事件经 workbench-run-event 发射 + security-audit 直发）
            background_tasks.set_task_event_consumer(core_state.task_events());
            background_tasks.set_event_bridge(bridge.clone(), String::new());

            // ⑧c workflow 命令后端（T-CF-14：六条命令的托管状态；30 方案
            // P6 装配收口：steering 队列注入引擎共享队列（消除 A5-H01a
            // 队列双实例——trigger 注入真实落引擎队列，idle 续 run 消费
            // 唤醒）；SchedulerRegistry 委托经 set_registry 注入共享注册
            // 表（create 即真实注册调度，A5-H01b 生产转正））
            let workflow_state = workflow_ipc::WorkflowCommandState::new(
                shared_db.local_db(),
                core_state.steering_queue(),
            );
            let workflow_backend = workflow_state.backend_handle();
            workflow_backend.set_app_context(
                setup_app_dir.clone(),
                Some(Arc::new(workflow_ipc::TauriWorkflowEventSink::new(
                    app_handle.clone(),
                ))),
            );
            let scheduled_launcher: Arc<dyn conex_run::sched::ScheduledTaskLauncher> =
                Arc::new(conex_run::workflow::ProductionScheduledLauncher::new(
                    Arc::new(workflow_ipc::TauriWorkflowEventSink::new(
                        app_handle.clone(),
                    )),
                    Arc::clone(&core_state),
                    Arc::clone(&workflow_backend),
                    setup_app_dir.clone(),
                ));
            workflow_backend.set_launcher(Arc::clone(&scheduled_launcher));
            if let Some(reg) = core_state.scheduler_registry() {
                workflow_state.set_registry(Arc::clone(&reg));
                reg.set_launcher(Arc::clone(&scheduled_launcher));
                let reg_restore = Arc::clone(&reg);
                tauri::async_runtime::spawn(async move {
                    reg_restore.restore().await;
                    tracing::info!(target: "setup", "SchedulerRegistry 异步启动恢复完成");
                });
            } else {
                tracing::warn!(
                    target: "setup",
                    "SchedulerRegistry 装配降级（workflow 走命令层独立退化路径，Cron 不参与续 run 判定）"
                );
            }

            let orphan_reaper = Arc::clone(&workflow_backend);
            tauri::async_runtime::spawn(async move {
                orphan_reaper.reap_orphan_running_runs();
                tracing::info!(target: "setup", "历史孤儿运行记录自愈收割完成");
            });
            // 维度五（05 详案 §2.4 路径 A）：create_workflow 工具通道生产
            // 转正——backend + AppHandle 注入延迟绑定面（绑定前工具
            // 返回 common.unsupported；注册链路复用 create-workflow 同一
            // 校验/注册后端，无第二套实现）
            engine_host
                .workflow_creation_channel()
                .bind(workflow_state.backend_handle(), app_handle.clone());
            app.manage(workflow_state);


            // 30 方案 P4 + Stage 6 ACT-602：timer/cron 事件 drain 改为
            // tokio::sync::Notify 事件驱动——sink.emit 即 notify_one，
            // 无事件时协程挂起于 notified().await（待机 0 Hz），取代旧
            // 500ms 盲 sleep 循环。drain 仍为 Vec::take 语义，空缓冲零开销；
            // 双 sink 各自持 Notify，select 任一唤醒后两路都 drain（防漏）
            {
                let timer_sink = core_state.timer_event_sink();
                let sched_sink = core_state.scheduler_event_sink();
                let drain_bridge = bridge.clone();
                let timer_notify = timer_sink.wake_notify();
                let sched_notify = sched_sink.wake_notify();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::select! {
                            _ = timer_notify.notified() => {}
                            _ = sched_notify.notified() => {}
                        }
                        conex_run::engine_channels::forward_drained_timer_events(&timer_sink, &drain_bridge);
                        conex_run::engine_channels::forward_drained_scheduler_events(&sched_sink, &drain_bridge);
                    }
                });
            }

            // R3-02：推送决策合并桶 drain —— Notify + next_expiry_ms 事件驱动
            // （取代旧 500ms 固定 sleep；无桶时最长 60s 挂起，入桶即唤醒）
            {
                let push_emitter = Arc::clone(&push_aware);
                tauri::async_runtime::spawn(async move {
                    let wake = push_emitter.wake_notify();
                    loop {
                        let now = server::now_ms();
                        let wait_ms = push_emitter
                            .next_expiry_ms(now)
                            .map(|exp| exp.saturating_sub(now))
                            .unwrap_or(60_000)
                            .clamp(10, 60_000);
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_millis(wait_ms)) => {}
                            _ = wake.notified() => {}
                        }
                        push_emitter.flush(server::now_ms());
                    }
                });
            }

            // 周期快照（T08.6 触发点 B：默认 60s，仅活动 run 存在时保存；
            // 幂等，restore 完成与否均可启动）
            core_state.spawn_snapshot_loop();

            // T5-2：孤儿 run 收割周期任务（默认 60s，复用 spawn_snapshot_loop
            // 骨架；驱动任务 is_finished 且连续 ORPHAN_REAP_DEBOUNCE_ROUNDS
            // 轮仍停留 activeRuns → finalize_failed 补写终态——run panic
            // 无终态事件导致的卡死/孤儿条目消除。幂等，可随时启动）
            core_state.spawn_run_reaper_loop();

            // P3：子代理心跳落库周期任务（默认检查 5s；实际节奏由会话级
            // AgentPolicy.recovery.heartbeatIntervalMs 决定，SQL 条件写去重）。
            // 幂等，可随时启动；无 DB 的测试路径自动跳过。
            core_state.spawn_subagent_heartbeat_loop();

            // PTY GC：Stage 6 ACT-605——setup 不再盲启 30s 周期协程；
            // 首次 workbench_pty_create 成功后经 notify_pty_activity 惰性
            // CAS 拉起，注册表连续两拍为空时主动自销毁（待机 0 Hz）。

            // setup 完成标记（PE-01 T01.2：initialized 如实反映）
            core_state.mark_initialized();

            // ⑪ 本地服务生产装配（R1-11 G-1：真实后端 + 事件扇出 + 配对
            // 协调器端口/钩子 + D5 红线 1 服务开关；G-1（R1-09）重绑钩子
            // 与电源监视同址装配）。启动失败 = 仅关多端服务，不阻断应用
            // （D1 §3.4 铁律；诊断经 StatusDiagnostics 环形缓冲如实上报，
            // core_get_status 可见）
            {
                // ⑪a 核心装配依赖（仅构造一次，重启/重绑复用同一实例）：
                // - CoreStateBackend：直调既有 *_impl 契约体（R1-04），
                //   注入 ServerState.backend（router 非 None 路径）；
                // - FanOutEmitter：挂 EventBridge 汇聚点（attach_fanout）
                //   ——引擎全事件流自动双通道（webview + 跨端广播）；
                //   并注入 ServerState.event_stream（WS drain task 消费，
                //   L4-4/6/7 实时推送与续传数据源）
                // ⑪a-C21：搜索索引注入（与命令面 SharedSearchState 同一
                // 实例——with_search_state 取 ⑤ 的 Arc clone，索引重建后
                // search_files / get_search_index 立即生效，不再
                // engine_not_ready）+ 工作区根注入（注册表活动根 canonical
                // 路径，relPath 剥离依据；注册表未托管 / 根不可达 → 不注入
                // 根，relPath 回退原路径，search_files 本身不受影响）
                let mut backend =
                    core_backend::CoreStateBackend::new(Arc::clone(&core_state))
                        .with_search_index_ready(search_index_ready)
                        .with_compaction_ready(compaction_ready)
                        .with_search_state(Arc::clone(&search_state))
                        .with_workspace_ops(core_backend::workspace_ops::AppWorkspaceOps::new(
                            app_handle.clone(),
                        ));
                if let Ok(guard) = crate::workspace::resolve_guard(&app_handle, "") {
                    backend = backend.with_search_root(guard.root().to_string_lossy().into_owned());
                }
                let backend: Option<Arc<dyn server::backend::ApiBackend>> = Some(Arc::new(backend));
                let fanout = Arc::new(server::fanout::FanOutEmitter::new(vec![]));
                bridge.attach_fanout(Arc::clone(&fanout) as Arc<dyn conex_run::core_event_bridge::Emitter>);

                // ⑪b 多端服务装配状态（单一真源：重启 / 开关命令 / 退出
                // 钩子共用同一生命周期槽与依赖实例——重建后句柄自动更新）
                let md_service = Arc::new(MultiDeviceService {
                    lifecycle: Arc::clone(&setup_lifecycle),
                    diagnostics: Arc::clone(diagnostics),
                    backend,
                    fanout: Some(fanout),
                    audit_bridge: Some(bridge),
                    pairing: Arc::clone(&pairing),
                    // P2-5 连接面共享接线：同一共享注册表注入路由层（与
                    // push presence / 直投 / 配对协调器 / 唤醒踢链同实例）
                    ws_registry: Arc::clone(&ws_registry),
                    base: server::config::ServerConfig::default(),
                    // D5 D-01：服务默认关闭（enabled=false 时 restart_server
                    // 不 bind 任何端口——红线 1「无任何端口监听」可验证）
                    enabled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    remote_lifecycle: Arc::new(std::sync::Mutex::new(
                        crate::multi_device_service::ServerLifecycle::default(),
                    )),
                });
                app.manage(Arc::clone(&md_service));
                crate::remote::start_remote_service(remote_auth, Arc::clone(&md_service));

                // rebind 防抖：重建进行中忽略重复触发（低频事件：配对
                // 切换 / 睡眠唤醒，重建通常 1s 内完成）
                let rebinding = Arc::new(std::sync::atomic::AtomicBool::new(false));

                // 重绑钩子（R1-07 配对模式切换 fire_rebind 与 G-1 唤醒
                // 恢复共用）：目标模式（Lan/Loopback）→ 关停旧实例 → 等
                // 端口释放 → 重建；真实重建经 tauri::async_runtime 派发。
                // 服务开关关闭（enabled=false）时 restart_server 直接停服
                // 不 bind（红线 1）——配对切换与唤醒重绑均受开关门控。
                let rebind_hook: crate::server::pairing::RebindHook = {
                    let rebinding = Arc::clone(&rebinding);
                    let md_service = Arc::clone(&md_service);
                    Arc::new(move |lan: bool| {
                        if rebinding.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            tracing::info!(target: "server", lan, "重绑进行中，跳过重复触发");
                            return;
                        }
                        let mut config = md_service.base.clone();
                        config.bind_mode = if lan {
                            server::config::BindMode::Lan
                        } else {
                            server::config::BindMode::Loopback
                        };
                        config.pairing_enabled = lan;
                        config.multi_device_enabled = md_service.enabled();
                        // Fn 闭包可被多次调用：每次调用内 clone 一份所有权
                        // 供 async 任务消费（捕获变量不可整体 move）
                        let rebinding = Arc::clone(&rebinding);
                        let md_service = Arc::clone(&md_service);
                        tauri::async_runtime::spawn(async move {
                            restart_server(config, &md_service).await;
                            rebinding.store(false, std::sync::atomic::Ordering::SeqCst);
                        });
                    })
                };
                // 装配进配对协调器（配对切换与唤醒恢复共用同一钩子）
                pairing.set_rebind_hook(Arc::clone(&rebind_hook));

                // G-1 电源监视：唤醒事件 → lan 态判定 → rebind(true) +
                // WS 全量踢重连（Windows 注册 Suspend/Resume 回调；
                // 非 Windows no-op）
                crate::system_power::start({
                    let wake_app = app.handle().clone();
                    let rebind_hook = Arc::clone(&rebind_hook);
                    let ws_registry = Arc::clone(&ws_registry);
                    Arc::new(move || {
                        let pairing =
                            wake_app.state::<Arc<crate::server::pairing::PairingCoordinator>>();
                        let recovered = crate::system_power::run_resume_recovery(
                            pairing.pairing_enabled(),
                            &*rebind_hook,
                            &|| crate::system_power::kick_all_ws(&ws_registry),
                        );
                        if !recovered {
                            tracing::debug!(target: "system-power", "唤醒但处于 loopback 态，无需重绑");
                        }
                    })
                });

                // 初始启动（服务开关默认关闭 → 记录诊断不监听；与重绑
                // 共用同一重建路径——红线 1 语义由 restart_server 门控）
                {
                    let md_service = Arc::clone(&md_service);
                    tauri::async_runtime::spawn(async move {
                        restart_server(md_service.current_config(), &md_service).await;
                    });
                }
            }

            // 启动期后台搜索索引自动预热（RUN-04/GAP-09 收口）：多根全量、
            // 失败可见（根级/条目级 warn 记录，不静默）、边界受 WarmupLimits
            // 约束（默认 100_000 文件 / 30s 全根合计，超限如实标记）。
            {
                let search_state = Arc::clone(&search_state);
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(reg) = app_handle.try_state::<crate::workspace::WorkspaceRegistry>() {
                        let roots: Vec<String> = reg
                            .roots()
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect();
                        if roots.is_empty() {
                            tracing::debug!(target: "search", "无已授权工作区根，跳过索引预热");
                            return;
                        }
                        let built = tokio::task::spawn_blocking(move || {
                            conex_search::warmup::warm_index(
                                &roots,
                                &conex_search::warmup::WarmupLimits::default(),
                            )
                        })
                        .await;
                        match built {
                            Ok(report) => {
                                if !report.is_clean() {
                                    tracing::warn!(
                                        target: "search",
                                        root_count = report.root_count,
                                        root_errors = report.root_errors.len(),
                                        entry_errors = report.entry_error_count,
                                        truncated = report.truncated,
                                        timed_out = report.timed_out,
                                        "搜索索引预热不干净（存在失败或被边界截断，详见预热日志）"
                                    );
                                }
                                let count = report.files.len();
                                if let Ok(mut lock) = search_state.files.write() {
                                    *lock = Arc::new(report.files);
                                    tracing::info!(
                                        target: "search",
                                        file_count = count,
                                        root_count = report.root_count,
                                        "启动期后台搜索索引自动预热构建完成"
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    target: "search",
                                    error = %e,
                                    "搜索索引预热任务失败（spawn_blocking join error）"
                                );
                            }
                        }
                    }
                });
            }

            tracing::info!(
                target: "setup",
                level = %level,
                commands = COMMAND_REGISTRY_NAMES.len(),
                "setup 完成（IPC 模式）"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            // 退出钩子：PTY 清理（优雅路径）+ 退出前快照保存（阻塞写完后才放行
            // 退出，见 wait_snapshot_thread）。
            // PERSIST-02 P1-2：restore 未完成或失败时保存被
            // build_and_save_snapshot 门禁拒绝（restore_ready 未置位 /
            // restore_failed 已置位）——防「0 会话半水合快照」覆盖主快照
            // 导致会话树分支历史永久丢失；跳过时 snapshot_last_error 可观测。
            if let tauri::RunEvent::Exit = event {
                // 本地服务优雅关停（D2 §5.3：先停服务再存快照；客户端收到
                // 服务端关闭信号，避免误判断线重试风暴）。句柄经生命周期
                // 槽取得——rebind 重建后句柄已更新，同样覆盖
                if let Some(server) = exit_lifecycle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .handle
                    .take()
                {
                    server.shutdown();
                }
                pty::kill_all_sessions();
                // 原生子 Webview 关闭：RunEvent::Exit 在 cleanup_before_exit 之前触发，
                // 回调已回到主线程——Tauri 的 with_webview 在主线程走同步内联快路径，
                // 因此 block_on 不会与事件循环互锁。close_all 同时注销 COM Token 并
                // 删除 Ephemeral UDF 目录（强杀遗留由下次启动 GC 兜底）。
                if let Some(native_browser) =
                    app_handle.try_state::<crate::browser::NativeWebviewManager>()
                {
                    tauri::async_runtime::block_on(native_browser.close_all());
                }
                if let Some(core) = app_handle.try_state::<Arc<conex_run::run::CoreRunState>>() {
                    let core = Arc::clone(core.inner());
                    // 快照必须在进程真正退出前写完：detach 的线程会随主线程退出
                    // 被操作系统强杀，可能留下半截文件。这里 join 并设上限，
                    // 避免磁盘异常时无限拖住退出。
                    let handle = std::thread::spawn(move || core.save_snapshot_blocking());
                    wait_snapshot_thread(handle);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 注册面与 manifest 一致（PE-03 T03.1）：COMMAND_REGISTRY_NAMES 必须
    /// 逐项等于 `command_manifest.rs` 的 `registered=true` 命令集合——任何
    /// 不一致（漏注册 / 多注册 / 拼写漂移）都是接线 bug。
    #[test]
    fn registration_surface_matches_manifest() {
        let manifest_registered: HashSet<&str> = command_manifest::COMMAND_MANIFEST
            .commands
            .iter()
            .filter(|entry| entry.registered)
            .map(|entry| entry.name)
            .collect();
        let actual: HashSet<&str> = COMMAND_REGISTRY_NAMES.iter().copied().collect();
        assert_eq!(
            actual, manifest_registered,
            "注册面必须与 manifest registered=true 一致"
        );
    }

    /// 注册面命令名唯一（重复名会破坏 Tauri invoke 路由）。
    #[test]
    fn registration_names_are_unique() {
        let mut names = COMMAND_REGISTRY_NAMES.to_vec();
        names.sort_unstable();
        let original = names.len();
        names.dedup();
        assert_eq!(names.len(), original, "注册面命令名必须唯一");
    }
}
