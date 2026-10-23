//! 后台任务注册表（T-AB-07 底座 + R-AB2 T-AB-09/10 日志生命周期与 stdin 注入
//! + R-AB3 T-AB-15/16 资源采样与健康判定）
//!
//! 职责：
//! - [BackgroundTaskRegistry]：任务注册表（`task-<seq>` 命名空间独立于 pty id）、
//!   日志根（`host_paths::app_dir()/logs/tasks`）、保留时长（默认 30 分钟，可注入）、
//!   资源采样配置与通知投递器（T-AB-15/16）；
//! - [TaskHandle]：任务句柄（info + child + writer + sampler + stdin 槽位 +
//!   notifier）；
//! - writer 转发循环：stdout/stderr → 落盘 `<task_id>.log`（带 `[out]`/`[err]` 行前缀）
//!   + 内存预览 + 行计数 + 每 512 行 `.meta.json` checkpoint + 行尾提示检测 +
//!     Crashed 通知（T-AB-16 3：resourceMonitor 任务非零退出 → 通知附最后 20 行）；
//! - read_log：行号范围读取（尾部读取 / checkpoint 二分定位）；send_input：stdin 注入；
//! - 采样循环（T-AB-15 3）：resourceMonitor 任务挂 [TaskHandle::sampler]——
//!   周期 2s 采集 CPU/RSS → 更新 `info.resource` + 落盘 `.samples.jsonl` +
//!   健康三态判定（T-AB-16 1）+ Suspicious 通知（防抖，同任务保持期间仅一次）。
//!
//! 关键口径（实现文档，诚实边界）：
//! - 日志编码：`decode_console_bytes`（先按 UTF-8，失败 lossy，与 agent-tools
//!   shell.rs:1286-1291 同一口径）；
//! - 行前缀：日志物理行 = `[out]`/`[err]` 前缀 + 内容 + `\n`（1 条输出 = 1 个文件行，
//!   行号与 line_count 一一对应）；stdout/stderr 为两条独立管道，文件内「顺序」为
//!   到达序近似（select 调度序，非严格交错序）；
//! - read_log / status.tail 返回「去前缀」的用户可见内容（.log 保留前缀作审计面）；
//! - 终态即收尾屏障：状态机翻转为终态发生在 writer 任务内、全部落盘与 meta 收尾
//!   之后——status()/list() 读到终态即保证 tail/line_count 与文件自洽（T-AB-09 6）。
//!   注意：T-AB-11 若在 writer 之外翻转 Killed，须先 await writer 或保持本顺序；
//! - 轮转护栏：单文件超 100MB 保尾截头（保留末 64MB，行对齐），meta 记轮转标记；
//! - stdin：`child.stdin.take()` 托管于 `Arc<TokioMutex<Option<ChildStdin>>>`；终态
//!   由收尾清空槽位（确定性 stdin_closed）。登记说明：agent-tools shell.rs:753 目前
//!   以 `Stdio::null()` spawn，模式 2/3 真实路径暂不带 stdin（B2/T-AB-13 需改为
//!   `Stdio::piped()` 才能接通）；本侧对「未接管道」按 stdin_closed 分类处理；
//! - 提示检测：行尾字面后缀匹配（常量模式，等价轻量正则），命中仅「候选提示」就位
//!   （info.prompt + meta 落盘），由 AI 判断是否发送输入；通知接线
//!   （orchestrator 独立 nudge 通道已随 I1 决策 9 删除，正文经 steering 消息
//!   承载）已由 T-AB-16 经 [crate::resource::TaskNotifier] 抽象落地
//!   （生产未接线 → 留痕，测试注入队列）。
//!
//! 资源段接线状态（T-AB-15/16，登记偏差）：
//! - 通知通道一（nudge）：orchestrator 独立 nudge 通道已随 I1 决策 9 删除
//!   （正文经 steering 消息承载）；workbench 生产默认 None（通知文本经
//!   tracing 留痕），测试注入内存队列断言；
//! - 通知通道二（事件）：task-suspicious（Soft）/ task-failed（Critical）经
//!   [crate::resource::EventSink] 槽发射（默认 [crate::resource::LogEventSink]
//!   结构化留痕）——C2（T-AB-17）在 conex-types 落地 AgentEvent 七事件变体后，
//!   以信封构造替换实现（payload 按冻结契约 §4.5 组装，零改动迁移）；
//! - Windows 采样：`QueryInformationJobObject` 需要 daemon Job 句柄——句柄封装在
//!   `process.rs` 私有 static（OnceLock）内，为落地采样在 process.rs 追加一行
//!   只读 getter（`daemon_job_handle`，纯暴露不改行为，报主 Agent 裁决）。
//!
//! 回收语义：run 结束不回收任务（会话级存活）；应用退出 → daemon Job 兜底全杀
//! （process.rs DAEMON_JOB_OBJECT，adopt 时接线，best-effort）。孤儿句柄：
//! adopt 转移时 `kill_on_drop(false)` 由 T-AB-02 保证，drop 不杀子进程。
//! 任务终止（completed/failed/killed）不删 `.log`（保留语义，T-AB-12 归档只清
//! 内存条目与 `.meta.json`）。
//!
//! 命令面（T-AB-08）：workbench_list_background_tasks / workbench_get_background_task_output /
//! workbench_cancel_background_task 三条 Tauri 命令，薄包装本注册表；契约测试
//! 直调 [build_list_response] / [build_output_response]（构造注册表即构造 State，
//! 不依赖 Tauri runtime）。

//!
//! SR-05 · 拆分门面 · ≠ EL（2026-08-13-wave 结构拆分轮）：本文件仅剩模块
//! 文档 + re-export 门面；实现已拆 bg_log / bg_registry / bg_task / bg_kill /
//! bg_writer / bg_events / bg_commands，测试外置 background_tests.rs（#[path]
//! 旁挂）。公开 API 不 break（main.rs 调用路径零改动，仅搬移不改语义）。

// ============================================================================
// 契约来源说明（跨 Agent 冻结接口，只读消费）
// ----------------------------------------------------------------------------
// trait `BackgroundTaskManager` 与全部数据结构（TaskState / BackgroundTaskInfo /
// BackgroundTaskStatus / BackgroundAdoptRequest / BackgroundTaskRef / KillResult /
// LogSlice / ResourceSample）由 A1 在 `crates/agent-tools/src/background.rs` 落地
// （T-AB-02，形状与方案 §4.1 / §4.2 / §4.4 逐字一致），经 `agent_tools` crate
// 根导出。本文件只消费不修改——壳层实现（impl BackgroundTaskManager for
// BackgroundTaskRegistry）即契约的实现面。
// ============================================================================

#[path = "bg_commands.rs"]
mod bg_commands;
#[path = "bg_events.rs"]
mod bg_events;
#[path = "bg_kill.rs"]
mod bg_kill;
#[path = "bg_log.rs"]
mod bg_log;
#[path = "bg_registry.rs"]
mod bg_registry;
#[path = "bg_task.rs"]
mod bg_task;
#[path = "bg_writer.rs"]
mod bg_writer;

pub(crate) use bg_commands::{
    // Tauri 宏生成的 __cmd__ / __tauri_command_name_ 符号随命令函数同模块
    // （bg_commands），main.rs invoke_handler 经 background:: 路径引用需要
    // 一并 re-export（SR-05 拆分断链修复 · 2026-08-14）。
    __cmd__workbench_cancel_background_task,
    __cmd__workbench_get_background_task_output,
    __cmd__workbench_list_background_tasks,
    __cmd__workbench_send_input,
    __tauri_command_name_workbench_cancel_background_task,
    __tauri_command_name_workbench_get_background_task_output,
    __tauri_command_name_workbench_list_background_tasks,
    __tauri_command_name_workbench_send_input,
    workbench_cancel_background_task,
    workbench_get_background_task_output,
    workbench_list_background_tasks,
    workbench_send_input,
};
pub(crate) use bg_registry::BackgroundTaskRegistry;

#[cfg(test)]
#[path = "background_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "background_tests_log.rs"]
mod tests_log;

#[cfg(test)]
#[path = "background_tests_kill.rs"]
mod tests_kill;

#[cfg(test)]
#[path = "background_tests_resource.rs"]
mod tests_resource;

#[cfg(test)]
#[path = "background_tests_events.rs"]
mod tests_events;
