//! 浏览器面板命令面（27 接线方案 S6 + P1-B1 帧流/输入命令 + J1b storage_state
//! + G-4 收尾书签/历史导入）
//!   browser_start / browser_stop / browser_status / browser_start_frames /
//!   browser_stop_frames / browser_frame_status / browser_input /
//!   browser_export_storage_state / browser_import_storage_state /
//!   browser_import_bookmarks / browser_import_history /
//!   browser_list_bookmarks / browser_list_history
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
//!   JSON（字符串，Playwright 兼容 `{ cookies, origins }`，§5.1；origins 面
//!   经 DOMStorage 逐 origin 实读聚合（P1-3 接线，origin 清单由 cookie
//!   domain 推导）；**内存传递不落盘**，§5.4 强制面——写盘仅走前端显式
//!   「另存为」路径）；
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

pub(crate) mod bookmarks_history;
pub(crate) mod common;
pub(crate) mod frames;
pub(crate) mod lifecycle;
pub(crate) mod storage;

#[cfg(test)]
mod tests;

pub(crate) use bookmarks_history::{
    __cmd__browser_import_bookmarks, __cmd__browser_import_history,
    __cmd__browser_list_bookmarks, __cmd__browser_list_history,
    __tauri_command_name_browser_import_bookmarks,
    __tauri_command_name_browser_import_history,
    __tauri_command_name_browser_list_bookmarks,
    __tauri_command_name_browser_list_history,
    browser_import_bookmarks, browser_import_history,
    browser_list_bookmarks, browser_list_history,
};
pub(crate) use frames::{
    __cmd__browser_frame_status, __cmd__browser_input,
    __cmd__browser_start_frames, __cmd__browser_stop_frames,
    __tauri_command_name_browser_frame_status,
    __tauri_command_name_browser_input,
    __tauri_command_name_browser_start_frames,
    __tauri_command_name_browser_stop_frames,
    browser_frame_status, browser_input,
    browser_start_frames, browser_stop_frames,
};
pub(crate) use lifecycle::{
    __cmd__browser_start, __cmd__browser_status, __cmd__browser_stop,
    __tauri_command_name_browser_start,
    __tauri_command_name_browser_status,
    __tauri_command_name_browser_stop,
    browser_start, browser_status, browser_stop,
};
pub(crate) use storage::{
    __cmd__browser_export_storage_state, __cmd__browser_import_storage_state,
    __tauri_command_name_browser_export_storage_state,
    __tauri_command_name_browser_import_storage_state,
    browser_export_storage_state, browser_import_storage_state,
};

#[cfg(test)]
pub(crate) use common::start_payload;
#[cfg(test)]
pub(crate) use storage::verify_cookie_injection;
