//! 浏览器面板命令面（27 接线方案 S6 + P1-B1 帧流/输入命令 + J1b storage_state
//! + G-4 收尾书签/历史导入）
//! browser_start / browser_stop / browser_status / browser_start_frames /
//! browser_stop_frames / browser_frame_status / browser_input /
//! browser_export_storage_state / browser_import_storage_state /
//! browser_import_bookmarks / browser_import_history /
//! browser_list_bookmarks / browser_list_history
//!
//! ## 接口契约（契约定死，前端消费面）
//! - `browser_start` → `{ state: "running"|"starting"|"error", reason?: string }`；
//! - `browser_stop` → `{ state: "stopped" }`；`force?: boolean` 参数（评审 F3）：
//!   `true` = 急停——不等会话锁，直接走强制杀树路径（launching 中不被会话锁
//!   阻塞至首启超时）；缺省/`false` = 正常停止（Graceful）；
//! - `browser_status` → `{ state: "idle"|"launching"|"running"|"stopping"|
//!   "stopped"|"crashed"|"error", url?: string }`。
//!
//! ## J1b storage_state 命令（维度 16 §5 辅助通道 CDP 实读/注入接线）
//! - `browser_export_storage_state(authorized: bool)` → 标准 storage_state
//!   JSON（字符串，Playwright 兼容 `{ cookies, origins }`，§5.1；**内存传递
//!   不落盘**，§5.4 强制面——写盘仅走前端显式「另存为」路径）；
//! - `browser_import_storage_state(json: string)` → 脱敏统计载荷
//!   `{ cookies, origins, localStorageItems, injectedScripts, injectedItems,
//!   droppedDupes, skippedEmptyName }`
//!   （不含任何 cookie value，§5.4 脱敏纪律）。
//!
//! ## G-4 收尾书签/历史导入命令（03-方案 §4.2 U4，conex-db 目标表接线）
//! - `browser_import_bookmarks(json: string)` → 书签导入统计
//!   `{ inserted, skippedDupes, parsedItems, skippedInvalid, depthCutoff,
//!   droppedDupes, truncated }`——Chrome Bookmarks JSON 解析（§6.1）→
//!   落库 conex-db imported_bookmarks（(url, name) 主键幂等）；
//! - `browser_import_history(path: string)` → 历史导入统计
//!   `{ inserted, skippedDupes, readTotal, skippedInvalidUrl }`——Chrome
//!   History SQLite **只读**读取（§6.2，默认最近 90 天 / 上限 1000 条）→
//!   落库 conex-db imported_history（(url, visited_at) 主键幂等）；
//! - `browser_list_bookmarks()` → imported_bookmarks 全量行（导入时间倒序）；
//! - `browser_list_history(since?, limit?)` → imported_history 行
//!   （visited_at 倒序 + since 过滤 + limit 截断）。
//!
//! 落库编排经 [crate::browser_import_sinks] 适配（BookmarkSink/HistorySink
//! → LocalDb，03-方案 §4.1 壳层编排约束）；来源标识固定
//! `manual/bookmarks` / `manual/history`（信息列，不入主键）。
//!
//! 错误面（结构化码前缀，前端按码路由提示）：未连接/恢复期 →
//! `tool.browser.not_ready:<原因>`（storage 命令**不触发惰性启动**——辅助
//! 通道须先经 `browser_start` 显式启动）；解析失败/超限/domain/origin 守卫
//! 拒绝 → `tool.invalid_input:<原因>`；未授权/CDP 失败 → 文案透传。
//!
//! ## P1-B1 帧流/输入命令（U-13 主控裁决：帧下行 Tauri Channel / 输入上行 invoke）
//! - `browser_start_frames(onFrame: Channel)` → `{ state: "starting"|"active"|
//!   "stopped", reason? }`——前端注册帧通道（Uint8Array 二进制帧，12 §2.2 定长头 +
//!   JPEG），无订阅者时不启帧流（省资源）；帧状态迁移经
//!   `browser://frame-state-changed`（`{ state, reason? }`）独立事件发射；
//! - `browser_stop_frames` → `{ state: "stopped" }`——退订帧流（幂等）；
//! - `browser_frame_status` → `{ state }` 查询；
//! - `browser_input(event)` → `()`——输入上行（kind/坐标/键值/滚动 delta/IME
//!   文本），**no-wait 语义**（invoke 不等待 CDP 注入返回）；高频 mousemove/
//!   wheel 在 Rust 侧按帧间隔合并（权威节流，见 browser/panel_input.rs 模块头）。
//!
//! 状态迁移经 `browser://state-changed`（payload `{ state, url?, reason? }`）Tauri
//! 事件发射（事件来源 = BrowserManager 状态机；评审 F7：崩溃事件携带 reason 原因；
//! 发射接线见 [crate::browser::BrowserSlot::attach_emitter]）。
//!
//! 命令均代理到引擎持有的 [BrowserSlot]（进程级单例，经
//! [CoreRunState::engine] 访问器取用）——不持有独立状态，与工具面
//! LazySessionOps 同一会话槽（单实例双控制面，08 D-2/D-3）。
//!
//! 错误面：start 失败按契约返回 `state: "error"` + reason（不 reject）；
//! stop 失败返回 Err（Tauri reject，无契约错误态）；帧流/输入命令失败返回 Err。
//!
//! ## 登记面（已接线）
//! 本文件命令已全部登记：`main.rs` command_registry! + `command_manifest.rs`
//! （registered=true）+ 前端 commandManifest.ts 快照（全量 107 条镜像同步，
//! 见 command_manifest.rs 条数注释）。

use crate::browser::frame_stream::FrameStreamState;
use crate::browser::panel_input::BrowserInputEvent;
use crate::browser::{BrowserSlot, StartPayload, StatusPayload};
use crate::core_run_commands::CoreRunState;
use conex_browser::import::bookmarks::{
    parse_bookmarks, persist_bookmarks, BookmarksOptions,
};
use conex_browser::import::history::{read_history, persist_history, HistoryOptions};
use conex_browser::import::storage_state::{
    build_import_plan, export_storage_state, inject_origin_scripts, parse_storage_state,
    ExportAuthorization, StorageStateError,
};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;
use tauri::ipc::Channel;

/// 错误码前缀（J1b 结构化错误面）：未连接/恢复期。
const TOOL_BROWSER_NOT_READY: &str = "tool.browser.not_ready";
/// 错误码前缀（J1b 结构化错误面）：输入非法（解析失败/守卫拒绝）。
const TOOL_INVALID_INPUT: &str = "tool.invalid_input";

/// 会话不可用 → `tool.browser.not_ready` 前缀（storage 命令统一映射）。
fn not_ready(reason: impl Into<String>) -> String {
    format!("{TOOL_BROWSER_NOT_READY}: {}", reason.into())
}

/// 输入非法 → `tool.invalid_input` 前缀（parse 失败/domain/origin 守卫拒绝）。
fn invalid_input(reason: impl Into<String>) -> String {
    format!("{TOOL_INVALID_INPUT}: {}", reason.into())
}

/// 取引擎持有的浏览器会话槽（命令面与工具面共享同一进程级单例）。
fn slot(core: &Arc<CoreRunState>) -> Arc<BrowserSlot> {
    core.engine().browser_slot()
}

/// 启动结果 → 契约载荷（Ok = running/starting；Err = error + reason）。
fn start_payload(result: Result<&'static str, String>) -> StartPayload {
    match result {
        Ok(state) => StartPayload {
            state,
            reason: None,
        },
        Err(reason) => StartPayload {
            state: "error",
            reason: Some(reason),
        },
    }
}

#[tauri::command]
pub(crate) async fn browser_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StartPayload, String> {
    let slot = slot(core.inner());
    slot.attach_emitter(Arc::new(crate::browser::TauriStateEmitter::new(app)));
    Ok(start_payload(slot.start().await))
}

#[tauri::command]
pub(crate) async fn browser_stop(
    force: Option<bool>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StatusPayload, String> {
    // 评审 F3：force=true（急停）→ 强制杀树路径（不等会话锁，launching 中
    // 不被阻塞至首启超时）；缺省 = 正常停止（Graceful）
    slot(core.inner()).stop(force.unwrap_or(false)).await?;
    Ok(StatusPayload {
        state: "stopped",
        url: None,
        reason: None,
    })
}

#[tauri::command]
pub(crate) fn browser_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StatusPayload, String> {
    let slot = slot(core.inner());
    // 幂等挂接：命令面先行时也能收到后续状态迁移
    slot.attach_emitter(Arc::new(crate::browser::TauriStateEmitter::new(app)));
    Ok(slot.status())
}

/// 启动帧流（P1-B1）：注册前端帧通道（Uint8Array 二进制）→ 浏览器就绪 →
/// 帧泵启动（startScreencast + ack pacing，8fps Base 档）→ 帧状态
/// `browser://frame-state-changed` 事件发射。无订阅者不启帧流（省资源）。
///
/// `on_frame` 通道须由命令持有（控制器存于 ActiveStream），通道释放
/// （退订/替换）时前端收到 end 事件。
#[tauri::command]
pub(crate) async fn browser_start_frames<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    on_frame: Channel<tauri::ipc::Response>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<FrameStreamState, String> {
    let slot = slot(core.inner());
    slot.attach_emitter(Arc::new(crate::browser::TauriStateEmitter::new(app)));
    slot.start_frames(on_frame).await
}

/// 退订帧流（P1-B1；幂等）：停止帧泵 + stopScreencast + 状态 stopped。
#[tauri::command]
pub(crate) async fn browser_stop_frames(
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<FrameStreamState, String> {
    Ok(slot(core.inner()).stop_frames().await)
}

/// 帧流状态查询（P1-B1）：starting/active/stopped。
#[tauri::command]
pub(crate) fn browser_frame_status(
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<FrameStreamState, String> {
    Ok(slot(core.inner()).frames().state())
}

/// 输入上行（P1-B1；U-13 裁决：输入走 Tauri invoke 而非 WS）。
///
/// - **no-wait 语义**：仅路由/合并后返回，派发由 P1-A 注入管线后台进行
///   （12 §4.1：不等待 CDP 响应，invoke 立即返回）；
/// - **高频节流**：mousemove/wheel 在 Rust 侧按帧间隔合并（权威节流，
///   见 browser/panel_input.rs 模块头注释——任务书二选一取 Rust 侧）；
/// - 离散事件（down/up/key/text）直通；事件序保真（press 先于积压 move）；
/// - 版本推进（R-1/U-1 注入即时 +1）由管线内部承担。
#[tauri::command]
pub(crate) async fn browser_input(
    event: BrowserInputEvent,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<(), String> {
    slot(core.inner()).forward_input(&event);
    Ok(())
}

/// 导入统计载荷（J1b，维度 16 §5.3/§5.4：数量脱敏，**不含任何 cookie value**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageImportPayload {
    /// 注入计划最终 cookie 数（同 (domain, name, path) 去重 + 空名过滤后）。
    pub cookies: usize,
    /// 含 localStorage 的 origin 数。
    pub origins: usize,
    /// localStorage 条目总数（注入计划面）。
    pub local_storage_items: usize,
    /// 已注册 origin 守卫恢复脚本数（§5.3 注入执行实际值）。
    pub injected_scripts: usize,
    /// 已直写 localStorage 条目数（§5.3 注入执行实际值）。
    pub injected_items: usize,
    /// 同键去重丢弃数（覆盖语义：最后一次出现者胜）。
    pub dropped_dupes: usize,
    /// 空 name 非法 cookie 跳过数（CDP setCookies 拒绝空 name）。
    pub skipped_empty_name: usize,
}

/// 导出 storage_state（J1b 接线，维度 16 §5.2 实读面）。
///
/// ## 契约
/// - 入参 `authorized: bool`：**导出需显式授权**（§5.2）——前端必须先展示
///   授权对话框（含将导出的 cookie 数量与域名清单预览），用户确认后才传
///   `true`；`false` → 命令拒绝（未授权，**不执行实读**，零副作用）；
/// - 返回：标准 storage_state JSON（Playwright 兼容 `{ cookies, origins }`，
///   §5.1），**内存传递不落盘**（§5.4 强制面；写盘仅走前端显式「另存为」）；
///   返回 JSON 含 cookie value 明文——前端须防日志/审计泄露（§5.4 脱敏纪律：
///   日志/事件负载一律不输出 value）；
/// - 错误：未连接/恢复期 → `tool.browser.not_ready:<原因>`（不触发惰性启动，
///   须先 `browser_start`）；未授权 → 拒绝文案；CDP 实读失败 → 透传原因。
///
/// ## 接线遗留（登记）
/// - `origins[].localStorage` 采集未接线（DOMStorage 域按 origin 聚合为
///   接线点，导出结果 origins 恒空——见 import/storage_state.rs
///   `from_cdp_cookies` 注记）；本命令只实读 cookie 面。
#[tauri::command]
pub(crate) async fn browser_export_storage_state(
    authorized: bool,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<String, String> {
    // 授权先行：未授权直接拒绝，不执行实读（§5.2 显式授权，零副作用）
    if !authorized {
        return Err(
            "storage_state 导出未获显式授权（须授权对话框确认后 authorized=true）".to_string(),
        );
    }
    let ops = slot(core.inner()).storage_ops();
    let cookies = ops.get_all_cookies().await.map_err(not_ready)?;
    let state = export_storage_state(&cookies, ExportAuthorization::Confirmed)
        .map_err(|e| invalid_input(e.to_string()))?;
    Ok(state.to_json())
}

/// 导入 storage_state（J1b 接线，维度 16 §5.3 注入面）。
///
/// ## 契约
/// - 入参 `json`：标准 storage_state JSON（§5.1；大小 ≤10MB、cookie ≤5000，
///   超限/非法 → `tool.invalid_input`）；
/// - 返回：脱敏统计载荷 `{ cookies, origins, localStorageItems, injectedScripts,
///   injectedItems, droppedDupes, skippedEmptyName }`（§5.4：不含任何
///   cookie value）；
/// - 错误：未连接/恢复期 → `tool.browser.not_ready:<原因>`；解析失败/超限/
///   domain/origin 守卫拒绝 → `tool.invalid_input:<原因>`；CDP 注入失败 → 透传。
///
/// ## 注入面（cookie + localStorage 两机制合并执行）
/// ① cookie 走 browser 级 `Storage.setCookies`（`to_cdp_params` 类型化参数：
/// 会话 cookie 移除 expires 字段、sameSite 归一化、同键幂等去重覆盖语义）；
/// ② localStorage 经 [inject_origin_scripts]（§5.3 注入执行）：每 origin
/// `Page.addScriptToEvaluateOnNewDocument` 注册**origin 守卫恢复脚本**
/// （脚本内先校验 `window.location.origin` 再 `setItem`，防跨站污染——守卫
/// 由解析层生成，K3 接线面）→ `DOMStorage.setDOMStorageItem` 直写当前页。
///
/// ## 执行序与回滚
/// cookie 先于 localStorage 注入；localStorage 注入失败 → 返回错误（cookie
/// 已注入不回滚——回验回滚面（注入后 `Storage.getCookies` 回读比对 + 还原）
/// 为可选遗留，见 K3 任务注记；重导覆盖语义下幂等，无错误累积）。
#[tauri::command]
pub(crate) async fn browser_import_storage_state(
    json: String,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StorageImportPayload, String> {
    let state = parse_storage_state(&json).map_err(|e| invalid_input(e.to_string()))?;
    let plan = build_import_plan(&state);
    let params = plan.to_cdp_params();
    slot(core.inner())
        .storage_ops()
        .set_cookies(params)
        .await
        .map_err(not_ready)?;
    // localStorage 注入（§5.3）：origin 守卫脚本注册 + DOMStorage 直写，
    // 经会话通道（BrowserSlot::local_storage_channel，未连接 → not_ready）
    let mut injected_scripts = 0usize;
    let mut injected_items = 0usize;
    if !plan.origin_scripts.is_empty() {
        let channel = slot(core.inner()).local_storage_channel().map_err(not_ready)?;
        let stats = inject_origin_scripts(channel.as_ref(), &plan).await.map_err(|e| {
            match e {
                // 防御性再检失败（非法 origin）：输入面错误
                StorageStateError::InvalidOrigin { .. } => invalid_input(e.to_string()),
                other => format!("localStorage 注入失败：{other}"),
            }
        })?;
        injected_scripts = stats.scripts;
        injected_items = stats.items;
    }
    Ok(StorageImportPayload {
        cookies: plan.stats.cookies,
        origins: plan.stats.origins,
        local_storage_items: plan.stats.local_storage_items,
        injected_scripts,
        injected_items,
        dropped_dupes: plan.stats.dropped_dupes,
        skipped_empty_name: plan.stats.skipped_empty_name,
    })
}

// ---------------------------------------------------------------------------
// G-4 收尾：书签/历史导入命令（03-方案 §4.2 U4；落库编排见
// crate::browser_import_sinks——BookmarkSink/HistorySink → LocalDb 适配）
// ---------------------------------------------------------------------------

/// 来源标识：手工导入的书签（信息列不入主键，跨来源同键合并）。
const BOOKMARK_SOURCE: &str = "manual/bookmarks";
/// 来源标识：手工导入的历史（信息列不入主键）。
const HISTORY_SOURCE: &str = "manual/history";

/// 书签导入统计载荷（03-方案 §2.5：落库统计 + 解析侧报告原样透传）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookmarksImportPayload {
    /// 新增落库条数（INSERT OR IGNORE 影响行数）。
    pub inserted: u64,
    /// 同 (url, name) 去重跳过条数（重复导入）。
    pub skipped_dupes: u64,
    /// 解析层扁平化条数（落库前，§6.1）。
    pub parsed_items: usize,
    /// 无效节点跳过数（缺 name/url、type 异常）。
    pub skipped_invalid: usize,
    /// 深度超限跳过的子树数（> BOOKMARKS_MAX_DEPTH）。
    pub depth_cutoff: usize,
    /// 解析层 (url, name) 去重丢弃数。
    pub dropped_dupes: usize,
    /// 数量上限截断数（items 达 limit 后未纳入节点数）。
    pub truncated: usize,
}

/// 历史导入统计载荷（03-方案 §2.5：落库统计 + 读取侧报告原样透传）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryImportPayload {
    /// 新增落库条数（INSERT OR IGNORE 影响行数）。
    pub inserted: u64,
    /// 同 (url, visited_at) 去重跳过条数（重复导入）。
    pub skipped_dupes: u64,
    /// 来源库查询读取行数（含被 URL 过滤丢弃前的行）。
    pub read_total: usize,
    /// 无效 URL 丢弃数（§6.2：非 http/https 或不可解析）。
    pub skipped_invalid_url: usize,
}

/// 当前 unix 秒（导入时刻注入面；时钟异常回退 0）。
fn unix_now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 导入书签（G-4 收尾，03-方案 §4.2 U4）：Chrome Bookmarks JSON（§6.1
/// 四树解析，幂等去重 + 数量上限 + 深度守卫）→ 落库 conex-db
/// imported_bookmarks（(url, name) 主键 INSERT OR IGNORE 幂等）。
///
/// ## 契约
/// - 入参 `json`：Chrome Bookmarks 文件内容（`{"roots": {...}}`）；
/// - 返回：[BookmarksImportPayload]（新增/跳过 + 解析侧报告透传）；
/// - 错误：非法 JSON → `tool.invalid_input:<原因>`；落库失败 → 透传
///   （conex-db 缺表降级返回 Ok(空统计)，不报错——R12/P2-1 纪律）。
#[tauri::command]
pub(crate) async fn browser_import_bookmarks(
    json: String,
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<BookmarksImportPayload, String> {
    let report = parse_bookmarks(&json, &BookmarksOptions::default())
        .map_err(|e| invalid_input(e.to_string()))?;
    let db = db_state.inner().local_db();
    let now = unix_now_secs();
    let parsed_items = report.items.len();
    let persist_stats = tokio::task::spawn_blocking(move || {
        let mut sink = crate::browser_import_sinks::LocalDbBookmarkSink::new(db);
        persist_bookmarks(&report.items, &mut sink, BOOKMARK_SOURCE, now)
            .map_err(|e| format!("书签落库失败：{e}"))
    })
    .await
    .map_err(|e| format!("书签落库任务异常：{e}"))??;
    Ok(BookmarksImportPayload {
        inserted: persist_stats.inserted,
        skipped_dupes: persist_stats.skipped_dupes,
        parsed_items,
        skipped_invalid: report.skipped_invalid,
        depth_cutoff: report.depth_cutoff,
        dropped_dupes: report.dropped_dupes,
        truncated: report.truncated,
    })
}

/// 导入历史（G-4 收尾，03-方案 §4.2 U4）：Chrome History SQLite **只读**
/// 读取（§6.2：WebKit 时间换算、默认最近 90 天 / 上限 1000 条）→ 落库
/// conex-db imported_history（(url, visited_at) 主键幂等——同 URL 不同秒
/// 访问各保留一条）。
///
/// ## 契约
/// - 入参 `path`：Chrome History 库路径（来源浏览器须已关闭，锁检测由
///   上层向导承担，§3.2 复用）；
/// - 返回：[HistoryImportPayload]（新增/跳过 + 读取侧报告透传）；
/// - 错误：库缺失/不可只读读取 → `tool.invalid_input:<原因>`；落库失败 →
///   透传。
#[tauri::command]
pub(crate) async fn browser_import_history(
    path: String,
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<HistoryImportPayload, String> {
    let db = db_state.inner().local_db();
    let now = unix_now_secs();
    let (report, persist_stats) = tokio::task::spawn_blocking(move || {
        let report = read_history(Path::new(&path), &HistoryOptions::default())
            .map_err(|e| invalid_input(e.to_string()))?;
        let mut sink = crate::browser_import_sinks::LocalDbHistorySink::new(db);
        let stats = persist_history(&report.items, &mut sink, HISTORY_SOURCE, now)
            .map_err(|e| format!("历史落库失败：{e}"))?;
        Ok::<_, String>((report, stats))
    })
    .await
    .map_err(|e| format!("历史导入任务异常：{e}"))??;
    Ok(HistoryImportPayload {
        inserted: persist_stats.inserted,
        skipped_dupes: persist_stats.skipped_dupes,
        read_total: report.total,
        skipped_invalid_url: report.skipped_invalid_url,
    })
}

/// 书签列表（G-4 收尾查询面）：imported_bookmarks 全量行（导入时间倒序，
/// 面板书签侧栏展示面）。缺表降级返回空集（R12/P2-1）。
///
/// 返回行字段为 conex-db [conex_db::ImportedBookmarkRow] 原样序列化
/// （snake_case：url/name/folder_path/guid/source/imported_at）。
#[tauri::command]
pub(crate) async fn browser_list_bookmarks(
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<Vec<conex_db::ImportedBookmarkRow>, String> {
    let db = db_state.inner().local_db();
    tokio::task::spawn_blocking(move || db.list_bookmarks())
        .await
        .map_err(|e| format!("书签列表任务异常：{e}"))?
        .map_err(|e| format!("书签列表失败：{}: {}", e.kind, e.message))
}

/// 历史列表（G-4 收尾查询面）：imported_history 行（visited_at 倒序 +
/// `since` 严格大于过滤 + `limit` 截断；limit 缺省 = 全量——表为导入数据，
/// 规模受导入上限约束）。
///
/// 返回行字段为 conex-db [conex_db::ImportedHistoryRow] 原样序列化
/// （snake_case：url/visited_at/title/source/imported_at）。
#[tauri::command]
pub(crate) async fn browser_list_history(
    since: Option<i64>,
    limit: Option<usize>,
    db_state: tauri::State<'_, crate::session_commands::SharedDb>,
) -> Result<Vec<conex_db::ImportedHistoryRow>, String> {
    let db = db_state.inner().local_db();
    let limit = limit.unwrap_or(usize::MAX);
    tokio::task::spawn_blocking(move || db.list_history(since, limit))
        .await
        .map_err(|e| format!("历史列表任务异常：{e}"))?
        .map_err(|e| format!("历史列表失败：{}: {}", e.kind, e.message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::StorageStateOps;
    use crate::core_event_bridge::{Emitter, EventBridge};
    use crate::status_diagnostics::StatusDiagnostics;
    use async_trait::async_trait;
    use conex_browser::cdp::domains::{Cookie as CdpCookie, SetCookieParam};
    use orchestrator::persist::InMemoryStore;
    use orchestrator::restore::SnapshotFileStore;
    use serde_json::json;

    /// 测试发射器（EventBridge 构造面；命令面断言不消费事件内容）。
    struct TestEmitter(Arc<std::sync::Mutex<Vec<String>>>);

    impl Emitter for TestEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("{channel}:{payload}"));
        }
    }

    /// 构造 mock 引擎状态（CoreRunState 可独立构造；浏览器槽随引擎
    /// 装配为真实惰性槽——单元测试不触发启动，仅查询/停止安全面）。
    fn mock_core_state(temp: &tempfile::TempDir) -> Arc<CoreRunState> {
        let bridge = EventBridge::new("test", Arc::new(TestEmitter(Arc::new(Default::default()))));
        Arc::new(CoreRunState::new(
            Arc::new(InMemoryStore::new()),
            Arc::new(SnapshotFileStore::new(
                temp.path().join("snapshot.json"),
            )),
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ))
    }

    /// J1b mock storage 发送面：预设实读结果 + 记录注入参数（命令层
    /// 断言 CDP wire 面透传，不依赖真实浏览器）。
    struct MockStorageOps {
        cookies: Arc<std::sync::Mutex<Vec<CdpCookie>>>,
        injected: Arc<std::sync::Mutex<Vec<SetCookieParam>>>,
        /// 实读调用计数（授权先行断言：未授权时零实读，§5.2 零副作用）。
        get_calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl MockStorageOps {
        fn new(cookies: Vec<CdpCookie>) -> Self {
            MockStorageOps {
                cookies: Arc::new(std::sync::Mutex::new(cookies)),
                injected: Arc::new(std::sync::Mutex::new(Vec::new())),
                get_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }

        fn get_calls(&self) -> usize {
            self.get_calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl StorageStateOps for MockStorageOps {
        async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String> {
            self.get_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self
                .cookies
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone())
        }
        async fn set_cookies(&self, cookies: Vec<SetCookieParam>) -> Result<(), String> {
            self.injected
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .extend(cookies);
            Ok(())
        }
    }

    /// CDP cookie 构造辅助（对齐 import/storage_state.rs 测试面）。
    fn cdp_cookie(overrides: impl Fn(&mut CdpCookie)) -> CdpCookie {
        let mut c = CdpCookie {
            name: "sid".to_string(),
            value: "abc123".to_string(),
            domain: ".example.com".to_string(),
            path: "/".to_string(),
            expires: 1_750_000_000.0,
            size: 10,
            http_only: true,
            secure: true,
            session: false,
            same_site: Some("Lax".to_string()),
            priority: Some("Medium".to_string()),
        };
        overrides(&mut c);
        c
    }

    /// 注入 mock storage 发送面（命令层断言面；未注入时槽为未连接面）。
    fn inject_mock(state: &Arc<CoreRunState>, mock: MockStorageOps) {
        state.engine().browser_slot().inject_storage_ops(Arc::new(mock));
    }

    /// localStorage 注入通道调用记录（§5.3 注入执行面断言：调用序与参数）。
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum ChannelCall {
        InitScript(String),
        SetItem {
            origin: String,
            key: String,
            value: String,
        },
        GetItems(String),
    }

    /// J1b 扩展面 mock 通道：记录调用（命令层断言 wire 参数透传，
    /// 不依赖真实浏览器会话；对齐 import/storage_state.rs 测试面）。
    #[derive(Default)]
    struct MockLocalStorageChannel {
        calls: Arc<std::sync::Mutex<Vec<ChannelCall>>>,
    }

    #[async_trait]
    impl conex_browser::import::storage_state::LocalStorageChannel
        for MockLocalStorageChannel
    {
        async fn add_init_script(
            &self,
            source: &str,
        ) -> Result<(), conex_browser::import::storage_state::StorageStateError> {
            self.calls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(ChannelCall::InitScript(source.to_string()));
            Ok(())
        }

        async fn set_dom_storage_item(
            &self,
            security_origin: &str,
            key: &str,
            value: &str,
        ) -> Result<(), conex_browser::import::storage_state::StorageStateError> {
            self.calls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(ChannelCall::SetItem {
                    origin: security_origin.to_string(),
                    key: key.to_string(),
                    value: value.to_string(),
                });
            Ok(())
        }

        async fn get_dom_storage_items(
            &self,
            security_origin: &str,
        ) -> Result<Vec<(String, String)>, conex_browser::import::storage_state::StorageStateError>
        {
            self.calls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(ChannelCall::GetItems(security_origin.to_string()));
            Ok(Vec::new())
        }
    }

    /// 注入 mock localStorage 通道（命令层断言面；未注入时访问器走
    /// 未连接路径 → not_ready）。
    fn inject_local_storage_mock(state: &Arc<CoreRunState>, mock: MockLocalStorageChannel) {
        state
            .engine()
            .browser_slot()
            .inject_local_storage_channel(Arc::new(mock));
    }

    /// J1b：导出返回形状——授权 + mock 实读 → 标准 storage_state JSON
    /// （`{ cookies, origins }`，§5.1 字段面：会话 cookie expires=-1、
    /// 持久 cookie 原值、sameSite/标志位透传）；内存传递不落盘。
    #[tokio::test]
    async fn export_returns_standard_json_with_authorization() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let cookies = vec![
            cdp_cookie(|c| {
                c.name = "sessionid".to_string();
                c.expires = -1.0; // 会话 cookie
            }),
            cdp_cookie(|c| {
                c.name = "persist".to_string();
                c.value = "p".to_string();
                c.domain = "example.com".to_string();
                c.http_only = false;
                c.secure = false;
                c.same_site = None;
            }),
        ];
        inject_mock(&state, MockStorageOps::new(cookies));

        let out = browser_export_storage_state(true, state_ref.clone())
            .await
            .expect("导出不应失败");
        let v: serde_json::Value = serde_json::from_str(&out).expect("标准 JSON");
        assert_eq!(v["cookies"].as_array().map(Vec::len), Some(2));
        assert_eq!(v["origins"].as_array().map(Vec::len), Some(0), "localStorage 采集未接线（origins 恒空）");
        assert_eq!(v["cookies"][0]["name"], "sessionid");
        assert_eq!(v["cookies"][0]["value"], "abc123");
        assert_eq!(v["cookies"][0]["domain"], ".example.com");
        assert_eq!(v["cookies"][0]["path"], "/");
        assert_eq!(v["cookies"][0]["expires"], -1, "会话 cookie → expires=-1");
        assert_eq!(v["cookies"][0]["httpOnly"], true);
        assert_eq!(v["cookies"][0]["secure"], true);
        assert_eq!(v["cookies"][0]["sameSite"], "Lax");
        assert_eq!(v["cookies"][1]["expires"], 1_750_000_000, "持久 cookie 原值");
        assert!(v["cookies"][1].get("sameSite").is_none(), "非法/缺失 sameSite 省略");
    }

    /// J1b：导出需显式授权——authorized=false 直接拒绝（**不执行实读**，
    /// 零副作用，§5.2 显式授权语义）。
    #[tokio::test]
    async fn export_requires_authorization_no_cdp_read() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let mock = MockStorageOps::new(vec![cdp_cookie(|_| {})]);
        let get_calls = Arc::clone(&mock.get_calls);
        inject_mock(&state, mock);

        let err = browser_export_storage_state(false, state_ref)
            .await
            .expect_err("未授权必须拒绝");
        assert!(err.contains("未获显式授权"), "拒绝文案：{err}");
        assert_eq!(
            get_calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "未授权不得执行实读（零副作用）"
        );
    }

    /// J1b：未连接路径——未注入 mock（默认 Unwired 发送面）→
    /// `tool.browser.not_ready` 结构化错误（storage 命令不触发惰性启动）。
    #[tokio::test]
    async fn export_not_ready_without_session() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let err = browser_export_storage_state(true, state_ref)
            .await
            .expect_err("未连接必须失败");
        assert!(
            err.starts_with("tool.browser.not_ready:"),
            "not_ready 结构化码前缀：{err}"
        );
    }

    /// J1b：导入注入参数断言——返回脱敏统计载荷（§5.3/§5.4：不含 value）；
    /// wire 参数形状由 [import_wire_params_reach_sender] 断言 mock 记录面。
    /// localStorage 注入已接线（K3 面）：注入 mock 通道 → injectedScripts/
    /// injectedItems 反映实际执行。
    #[tokio::test]
    async fn import_injects_cdp_params_and_stats() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        inject_mock(&state, MockStorageOps::new(Vec::new()));
        // localStorage 注入通道 mock（§5.3 注入执行面）
        inject_local_storage_mock(&state, MockLocalStorageChannel::default());

        let json = r#"{
            "cookies": [
                {
                    "name": "sessionid", "value": "abc123", "domain": ".example.com",
                    "path": "/", "expires": -1, "httpOnly": true, "secure": true,
                    "sameSite": "lax"
                },
                {
                    "name": "persist", "value": "p", "domain": "example.com",
                    "path": "/", "expires": 1750000000, "httpOnly": false,
                    "secure": false, "sameSite": "None"
                },
                {
                    "name": "dup", "value": "first", "domain": "example.com", "path": "/"
                },
                {
                    "name": "dup", "value": "last", "domain": "example.com", "path": "/"
                },
                {
                    "name": "", "value": "no-name", "domain": "example.com", "path": "/"
                }
            ],
            "origins": [
                { "origin": "https://example.com", "localStorage": [
                    { "name": "theme", "value": "dark" },
                    { "name": "k2", "value": "v2" }
                ] }
            ]
        }"#;
        let payload = browser_import_storage_state(json.to_string(), state_ref)
            .await
            .expect("导入不应失败");
        // 脱敏统计载荷（§5.3/§5.4：不含 value）
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({
                "cookies": 3,
                "origins": 1,
                "localStorageItems": 2,
                "injectedScripts": 1,
                "injectedItems": 2,
                "droppedDupes": 1,
                "skippedEmptyName": 1
            }),
            "统计：同键去重 + 空名过滤后 3 条；localStorage 注入执行 1 脚本 + 2 直写"
        );
    }

    /// J1b：导入注入参数 wire 断言（mock 记录面版本）——验证命令确实把
    /// `to_cdp_params` 结果传到了发送面（会话 cookie expires=None）。
    #[tokio::test]
    async fn import_wire_params_reach_sender() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let mock = MockStorageOps::new(Vec::new());
        // 保持句柄以读取注入记录
        let injected = Arc::clone(&mock.injected);
        inject_mock(&state, mock);

        let json = r#"{
            "cookies": [
                {
                    "name": "sessionid", "value": "abc123", "domain": ".example.com",
                    "path": "/", "expires": -1, "httpOnly": true, "secure": true,
                    "sameSite": "lax"
                },
                {
                    "name": "persist", "value": "p", "domain": "example.com",
                    "path": "/", "expires": 1750000000, "httpOnly": false,
                    "secure": false, "sameSite": "None"
                }
            ]
        }"#;
        browser_import_storage_state(json.to_string(), state_ref)
            .await
            .expect("导入不应失败");
        {
            // 持锁断言注入记录（SetCookieParam 无 Clone，锁内读取字段）
            let params = injected.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(params.len(), 2);
            // 会话 cookie：expires=None（§5.1 归一化移除 expires 字段）
            assert_eq!(params[0].name, "sessionid");
            assert_eq!(params[0].domain.as_deref(), Some(".example.com"));
            assert_eq!(params[0].path.as_deref(), Some("/"));
            assert!(params[0].expires.is_none(), "会话 cookie expires=None");
            assert_eq!(params[0].same_site.as_deref(), Some("Lax"), "小写归一化");
            // 持久 cookie：expires 保留
            assert_eq!(params[1].name, "persist");
            assert_eq!(params[1].expires, Some(1_750_000_000.0));
            assert_eq!(params[1].same_site.as_deref(), Some("None"));
        }
    }

    /// J1b：导入解析失败路径——非法 JSON → `tool.invalid_input` 结构化错误。
    #[tokio::test]
    async fn import_rejects_bad_json() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let err = browser_import_storage_state("{ not json !!".to_string(), state_ref)
            .await
            .expect_err("非法 JSON 必须失败");
        assert!(
            err.starts_with("tool.invalid_input:"),
            "invalid_input 结构化码前缀：{err}"
        );
    }

    /// J1b：domain 守卫拒绝路径——非法 domain → `tool.invalid_input`
    /// （§5.3 domain 守卫，注入前拦截）。
    #[tokio::test]
    async fn import_rejects_invalid_domain() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let json = r#"{"cookies":[{"name":"n","value":"v","domain":"javascript:"}]}"#;
        let err = browser_import_storage_state(json.to_string(), state_ref)
            .await
            .expect_err("domain 守卫必须拒绝");
        assert!(
            err.starts_with("tool.invalid_input:"),
            "invalid_input 结构化码前缀：{err}"
        );
    }

    /// J1b：导入未连接路径——未注入 mock → `tool.browser.not_ready`
    /// （解析通过但注入面未连接，§5.3 注入前置）。
    #[tokio::test]
    async fn import_not_ready_without_session() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let err = browser_import_storage_state(
            r#"{"cookies":[{"name":"n","value":"v","domain":"example.com"}]}"#.to_string(),
            state_ref,
        )
        .await
        .expect_err("未连接必须失败");
        assert!(
            err.starts_with("tool.browser.not_ready:"),
            "not_ready 结构化码前缀：{err}"
        );
    }

    /// G-5 补强：SensitiveCapabilities 剪贴板位默认关闭（红线语义，
    /// 17 §2.3——未开启时任何权限模式直接 Deny，含 full-access）。
    /// 口径注记（M-7 + U-8 裁决，17 §3.1/§3.3）：
    /// - **纯文本粘贴不受影响**：文本经 `Input.insertText` 注入页面，
    ///   不经 evaluate——`insertText` 不需要 clipboard 能力位；
    /// - **evaluate 兜底暂缓**：富文本/图片粘贴放 evaluate 路径，一期
    ///   不支持（工具返回「暂不支持，请手动粘贴」）；仅「文件路径粘贴」
    ///   场景保留受控 evaluate 兜底（需审批 + §3 三层校验），暂缓接线。
    #[test]
    fn g5_sensitive_capabilities_defaults_off() {
        let caps = conex_browser_tools::SensitiveCapabilities::default();
        assert!(!caps.evaluate, "evaluate 能力位默认关闭（红线语义）");
        assert!(!caps.upload, "upload 能力位默认关闭（红线语义）");
        assert!(!caps.clipboard, "clipboard 能力位默认关闭（G-5）");
    }

    /// 启动失败 → 契约载荷（state=error + reason；命令面代理语义）。
    #[test]
    fn start_payload_maps_error_and_ok() {
        let ok = start_payload(Ok("running"));
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({ "state": "running" })
        );
        let starting = start_payload(Ok("starting"));
        assert_eq!(
            serde_json::to_value(&starting).unwrap(),
            json!({ "state": "starting" })
        );
        let err = start_payload(Err("浏览器崩溃恢复中".to_string()));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "state": "error", "reason": "浏览器崩溃恢复中" })
        );
    }

    /// browser_status 契约：从未启动 → `{ state: "idle" }`（无 url 键）；
    /// 未启动的 browser_stop 幂等返回 `{ state: "stopped" }`（manager.stop
    /// 无驱动路径直接收敛，安全面）；force 参数缺省/显式均收敛。
    #[tokio::test]
    async fn status_and_stop_contract_on_idle_state() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let status = browser_status(app.handle().clone(), state_ref.clone()).expect("status 不应失败");
        assert_eq!(status.state, "idle", "从未启动 = idle");
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "idle" }),
            "url 缺省不落键（契约形状）"
        );

        let stopped = browser_stop(None, state_ref.clone()).await.expect("未启动 stop 应幂等");
        assert_eq!(
            serde_json::to_value(&stopped).unwrap(),
            json!({ "state": "stopped" })
        );

        // 评审 F3：force 急停参数显式传递亦收敛（未启动幂等安全面）
        let stopped = browser_stop(Some(true), state_ref).await.expect("force stop 应幂等");
        assert_eq!(
            serde_json::to_value(&stopped).unwrap(),
            json!({ "state": "stopped" })
        );
    }

    /// P1-B1：browser_input no-wait 语义——无会话/管线（P1-A 未接线）时
    /// 返回 Ok（事件进入路由即返回，不等待 CDP）；payload 反序列化契约。
    #[tokio::test]
    async fn browser_input_returns_ok_without_session() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let evt = serde_json::from_value(json!({
            "kind": "mouse",
            "action": "move",
            "x": 10.0,
            "y": 20.0,
            "buttons": 1,
            "modifiers": 0
        }))
        .expect("载荷反序列化");
        let result = browser_input(evt, state_ref.clone()).await;
        assert!(result.is_ok(), "no-wait：路由后立即返回 Ok，不得因会话缺失失败");

        let key_evt = serde_json::from_value(json!({
            "kind": "key",
            "action": "down",
            "key": "a",
            "code": "KeyA",
            "text": "a",
            "windowsVirtualKeyCode": 65,
            "nativeVirtualKeyCode": 65,
            "autoRepeat": false,
            "modifiers": 2
        }))
        .expect("键盘载荷反序列化");
        assert!(browser_input(key_evt, state_ref).await.is_ok());
    }

    /// P1-B1：browser_input 载荷非法 kind → 反序列化失败（防御非法前端）。
    #[test]
    fn browser_input_rejects_unknown_kind() {
        let parsed: Result<BrowserInputEvent, _> =
            serde_json::from_value(json!({ "kind": "joystick" }));
        assert!(parsed.is_err(), "未知 kind 必须反序列化失败");
    }

    /// P1-B1：帧状态契约——未启动槽 stop_frames / frame_status 幂等收敛
    /// （stopped，不触发启动链）。
    #[tokio::test]
    async fn frame_commands_idle_contract() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let status = browser_frame_status(state_ref.clone()).expect("状态查询不应失败");
        assert_eq!(serde_json::to_value(&status).unwrap(), json!("stopped"));

        let stopped = browser_stop_frames(state_ref).await.expect("退订不应失败");
        assert_eq!(serde_json::to_value(&stopped).unwrap(), json!("stopped"));
    }

    /// J1b 扩展面：localStorage 注入执行（§5.3）——mock 通道断言调用序
    /// （每 origin 先注册守卫脚本，再逐条直写）+ 载荷 injectedScripts/
    /// injectedItems 反映实际执行。
    #[tokio::test]
    async fn import_storage_state_injects_local_storage_channel() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        inject_mock(&state, MockStorageOps::new(Vec::new()));
        let channel = MockLocalStorageChannel::default();
        let calls = Arc::clone(&channel.calls);
        inject_local_storage_mock(&state, channel);

        let json = r#"{
            "cookies": [],
            "origins": [
                { "origin": "https://example.com", "localStorage": [
                    { "name": "theme", "value": "dark" },
                    { "name": "token", "value": "abc" }
                ] },
                { "origin": "https://sub.example.org", "localStorage": [
                    { "name": "k", "value": "v" }
                ] }
            ]
        }"#;
        let payload = browser_import_storage_state(json.to_string(), state_ref)
            .await
            .expect("导入不应失败");
        assert_eq!(payload.origins, 2);
        assert_eq!(payload.local_storage_items, 3);
        assert_eq!(payload.injected_scripts, 2, "每 origin 一条守卫脚本");
        assert_eq!(payload.injected_items, 3, "直写条目总数");
        // 调用序：每 origin 先注册守卫脚本，再逐条直写（§5.3 两机制互补）
        let calls = calls.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(calls.len(), 5);
        assert!(
            matches!(&calls[0], ChannelCall::InitScript(s)
                if s.contains(r#"window.location.origin !== "https://example.com""#)),
            "脚本须含 origin 守卫（防跨站污染）且指向目标 origin"
        );
        assert!(
            matches!(&calls[1], ChannelCall::SetItem { origin, key, value }
                if origin == "https://example.com" && key == "theme" && value == "dark")
        );
        assert!(
            matches!(&calls[2], ChannelCall::SetItem { origin, key, .. }
                if origin == "https://example.com" && key == "token")
        );
        assert!(
            matches!(&calls[3], ChannelCall::InitScript(s) if s.contains("sub.example.org"))
        );
        assert!(
            matches!(&calls[4], ChannelCall::SetItem { origin, key, value }
                if origin == "https://sub.example.org" && key == "k" && value == "v")
        );
    }

    /// J1b 扩展面：localStorage 注入前置——cookie 注入通过但未注入通道
    /// （无会话）→ `tool.browser.not_ready`（辅助通道须先 browser_start）。
    #[tokio::test]
    async fn import_storage_state_local_storage_not_ready_without_channel() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        // cookie 面注入 mock（通过），localStorage 通道未注入（未连接面）
        inject_mock(&state, MockStorageOps::new(Vec::new()));

        let json = r#"{
            "cookies": [],
            "origins": [
                { "origin": "https://example.com", "localStorage": [
                    { "name": "theme", "value": "dark" }
                ] }
            ]
        }"#;
        let err = browser_import_storage_state(json.to_string(), state_ref)
            .await
            .expect_err("无通道必须失败");
        assert!(
            err.starts_with("tool.browser.not_ready:"),
            "not_ready 结构化码前缀：{err}"
        );
    }

    /// G-4：书签导入落库（03-方案 §4.2 U4）——解析 → 落库统计聚合；
    /// 重导幂等（(url, name) 主键跳过全量）；list_bookmarks 回读行数一致。
    #[tokio::test]
    async fn import_bookmarks_persists_idempotent_and_lists() {
        use tauri::Manager as _;
        let db = conex_db::LocalDb::open_in_memory().expect("内存库");
        let shared = crate::session_commands::SharedDb::new(db);
        let app = tauri::test::mock_builder()
            .manage(shared)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let db_state = app.state::<crate::session_commands::SharedDb>();

        let json = r#"{
            "roots": {
                "bookmark_bar": {
                    "type": "folder", "name": "书签栏",
                    "children": [
                        { "type": "url", "name": "A", "url": "https://a.example.com" },
                        { "type": "url", "name": "A", "url": "https://a.example.com" },
                        { "type": "url", "name": "B", "url": "https://b.example.com" }
                    ]
                },
                "other": {
                    "type": "folder", "name": "其他书签",
                    "children": [
                        { "type": "url", "name": "C", "url": "https://c.example.com" }
                    ]
                }
            }
        }"#;
        let payload = browser_import_bookmarks(json.to_string(), db_state.clone())
            .await
            .expect("导入不应失败");
        assert_eq!(payload.parsed_items, 3, "解析层 (url, name) 去重后 3 条");
        assert_eq!(payload.dropped_dupes, 1, "解析层同键去重 1 条");
        assert_eq!(payload.inserted, 3, "落库新增 3 条");
        assert_eq!(payload.skipped_dupes, 0);
        assert_eq!(payload.skipped_invalid, 0);
        assert_eq!(payload.depth_cutoff, 0);
        assert_eq!(payload.truncated, 0);

        // 重导幂等（03-方案 §2.4：INSERT OR IGNORE 主键跳过）
        let payload = browser_import_bookmarks(json.to_string(), db_state.clone())
            .await
            .expect("重导不应失败");
        assert_eq!(payload.inserted, 0, "同键全部跳过");
        assert_eq!(payload.skipped_dupes, 3);

        // 查询面：3 行 + 字段完整（folder_path 反序列化逐元素）
        let rows = browser_list_bookmarks(db_state.clone())
            .await
            .expect("列表不应失败");
        assert_eq!(rows.len(), 3);
        let a = rows
            .iter()
            .find(|r| r.url == "https://a.example.com")
            .expect("A 行存在");
        assert_eq!(a.name, "A");
        assert_eq!(a.folder_path, vec!["书签栏"], "路径链逐元素保留");
        assert_eq!(a.source, "manual/bookmarks", "来源标识固定");
        assert_eq!(a.guid, None, "guid 首版恒 None");
        assert!(a.imported_at > 0, "导入时刻注入");
    }

    /// G-4：书签导入非法 JSON → `tool.invalid_input` 结构化错误。
    #[tokio::test]
    async fn import_bookmarks_rejects_bad_json() {
        use tauri::Manager as _;
        let db = conex_db::LocalDb::open_in_memory().expect("内存库");
        let shared = crate::session_commands::SharedDb::new(db);
        let app = tauri::test::mock_builder()
            .manage(shared)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let db_state = app.state::<crate::session_commands::SharedDb>();

        let err = browser_import_bookmarks("{ not json !!".to_string(), db_state)
            .await
            .expect_err("非法 JSON 必须失败");
        assert!(
            err.starts_with("tool.invalid_input:"),
            "invalid_input 结构化码前缀：{err}"
        );
    }

    /// G-4：历史导入落库（03-方案 §4.2 U4）——真实 Chrome History 形态
    /// fixture 只读读取 → 落库统计聚合；list_history 回读（visited_at
    /// 倒序 + since/limit 过滤面）。
    #[tokio::test]
    async fn import_history_persists_and_lists() {
        use tauri::Manager as _;
        let dir = tempfile::tempdir().expect("临时目录");
        let db = conex_db::LocalDb::open_in_memory().expect("内存库");
        let shared = crate::session_commands::SharedDb::new(db);
        let app = tauri::test::mock_builder()
            .manage(shared)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let db_state = app.state::<crate::session_commands::SharedDb>();

        // 构造真实 History 库 fixture（urls + visits，WebKit 微秒时间戳）
        let hist = dir.path().join("History");
        {
            let conn = rusqlite::Connection::open(&hist).expect("建库");
            conn.execute_batch(
                "CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT);
                 CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL);",
            )
            .expect("建表");
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("时钟")
                .as_secs() as i64;
            for (i, days_ago) in [1i64, 2, 3].iter().enumerate() {
                conn.execute(
                    "INSERT INTO urls (url, title) VALUES (?1, ?2)",
                    rusqlite::params![format!("https://h{i}.example.com"), format!("H{i}")],
                )
                .expect("插 urls 行");
                let id = conn.last_insert_rowid();
                conn.execute(
                    "INSERT INTO visits (url, visit_time) VALUES (?1, ?2)",
                    rusqlite::params![
                        id,
                        (now_secs - days_ago * 86_400 + 11_644_473_600) * 1_000_000
                    ],
                )
                .expect("插 visits 行");
            }
        }
        let payload = browser_import_history(hist.display().to_string(), db_state.clone())
            .await
            .expect("导入不应失败");
        assert_eq!(payload.read_total, 3);
        assert_eq!(payload.skipped_invalid_url, 0);
        assert_eq!(payload.inserted, 3);
        assert_eq!(payload.skipped_dupes, 0);

        // 重导幂等：(url, visited_at) 主键跳过全量
        let payload = browser_import_history(hist.display().to_string(), db_state.clone())
            .await
            .expect("重导不应失败");
        assert_eq!(payload.inserted, 0);
        assert_eq!(payload.skipped_dupes, 3);

        // 查询面：3 行倒序 + 字段完整（title Some/visited_at Unix 秒）
        let rows = browser_list_history(None, None, db_state.clone())
            .await
            .expect("列表不应失败");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].url, "https://h0.example.com", "visited_at 倒序（最近在前）");
        assert_eq!(rows[0].title.as_deref(), Some("H0"));
        assert_eq!(rows[0].source, "manual/history", "来源标识固定");
        // since 过滤（严格大于）+ limit 截断
        let since = rows[2].visited_at;
        let filtered = browser_list_history(Some(since), None, db_state.clone())
            .await
            .expect("列表不应失败");
        assert_eq!(filtered.len(), 2, "since 严格大于");
        let limited = browser_list_history(None, Some(1), db_state.clone())
            .await
            .expect("列表不应失败");
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].url, "https://h0.example.com");
    }

    /// G-4：历史导入库缺失 → `tool.invalid_input`（输入路径不可用）。
    #[tokio::test]
    async fn import_history_rejects_missing_file() {
        use tauri::Manager as _;
        let dir = tempfile::tempdir().expect("临时目录");
        let db = conex_db::LocalDb::open_in_memory().expect("内存库");
        let shared = crate::session_commands::SharedDb::new(db);
        let app = tauri::test::mock_builder()
            .manage(shared)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let db_state = app.state::<crate::session_commands::SharedDb>();

        let err = browser_import_history(
            dir.path().join("Missing-History").display().to_string(),
            db_state,
        )
        .await
        .expect_err("库缺失必须失败");
        assert!(
            err.starts_with("tool.invalid_input:"),
            "invalid_input 结构化码前缀：{err}"
        );
    }
}
