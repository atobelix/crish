//! 内置工具模块（任务书 B5.2：fs / shell / search / diff + I2-S3 删除接管）
//!
//! - `fs`：读/写/列目录/文件信息，路径安全复用 conex-fs 的 safe_canonicalize
//! - `search`：grep 文本搜索（目录递归 + glob 过滤）与模糊文件查找（复用 conex-search）
//! - `shell`：命令执行，先过 conex-sandbox 门禁，Windows 用 PowerShell EncodedCommand 包装
//! - `diff`：文本 diff（复用 conex-diff，输出 unified diff 文本）
//! - `delete`：删除接管（delete_file / delete_dir，I2-S3）——唯一删除接口，
//!   移入 conex-fs 回收站服务并登记，dangerous=true 走审批
//! - `subagent`：run_subagent（I4-M2）——spawn 独立子代理会话 + run，
//!   递归守卫 + 三方状态映射 + 伪造审批防护（注册面 10→11）
//! - `wait_subagents`：wait_subagents（I5-M8）——三模式调度等待
//!   （await-all/timer/parallel-work）+ 事件驱动等待原语 + dispatch_*
//!   持久化 + 运行中注入（注册面 11→12）
//! - `background_task`：background_task（T-AB-13）——后台任务管理命令面
//!   （list/status/read_log/send_input/kill），经 ToolContext.background
//!   访问 BackgroundTaskManager（注册面 12→13）
//! - `multi_replace`：multi_replace_file_content（T-EG-01/02）——对同一文件
//!   的多个非连续代码块做精确原文替换，任一 Chunk 匹配失败整体回滚
//!   （注册面 13→14）
//! - `set_timer`：set_timer / cancel_timer（T-CF-05）——一次性后台定时器
//!   注册与取消 + TimerChannel 契约（后台静默运行不阻塞、早退条件
//!   never/any/task-id、同 sender 单活跃定时器约束；注册面 14→16）
//! - `create_workflow`：create_workflow（维度五 / 05 详案 §2.4 路径 A）——
//!   定时任务注册 + WorkflowCreationChannel 契约（引擎侧复用既有
//!   create-workflow IPC 校验/注册逻辑适配；通道经 BuiltinToolConfig 注入，
//!   None = common.unsupported；注册面 33→34）
//! - `output_dir`：resolve_output_dir（T-EG-08 / REQ-G01）——会话文档产出
//!   目录解析（显式 folder 优先 / 默认 .agent-outputs/<YYYY-MM-DD>-<会话标识>/
//!   惰性与幂等 / 只读子代理不自选；注册面 16→17）
//! - `note_*`：W4-A/B/F + Round7 笔记域工具——读 `query_blocks` /
//!   `document_outline` / `document_get_md`；写 `document_apply_md` /
//!   `send_to_note` / **`block_batch`** / **`block_insert`** /
//!   **`block_update`** / **`block_delete`** / **`block_move`** /
//!   **`block_set_attr`**
//!   （经 `ToolContext.note_backend` dyn trait 注入；
//!   None → note_backend_unwired；注册面 32→33；读工具进只读集，
//!   写工具 dangerous=true 不进只读集）
//!   **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表关闭**
//!
//! 全部工具实现 `Tool` trait，经 `register_builtin_tools` 统一注册进 ToolRegistry。
//! 各工具的会话级数据（工作区根目录等）执行时从 `ToolContext` 读取
//! （R3 T9：BuiltinToolConfig 仅承载构造期默认配置，不再注入 workspace_root）。

pub mod background_task;
// 维度五（05 详案 §2.4 路径 A）：create_workflow 工具模块声明（引擎侧经
// BuiltinToolConfig.workflow_creation_channel 注入 WorkflowCreationChannel
// 契约，None = common.unsupported；注册面 33→34）
pub mod create_workflow;
// T-41：decompress_context 工具模块声明（注册面 18→20 由本文件下方
// register_builtin_tools_with_config 负责；压缩块原文服务经
// ctx.compression_store 注入，None = common.unsupported）
pub mod decompress_context;
pub mod delete;
pub mod diff;
pub mod fs;
// D4 §3.3：kill_subagent 工具模块声明（仅主 agent 工具集；终止通道经
// BuiltinToolConfig.subagent_kill_channel 注入，None = common.unsupported）
pub mod kill_subagent;
// W4-A/B/F/R + Round7：笔记域工具（读 outline/query/get_md + 写 apply_md/
// send_to_note / block_batch / block_insert / block_update / block_delete /
// block_move / block_set_attr）；注册面 32→33；后端经 ctx.note_backend 注入；
// ≠ EL-05 / ≠ W6-E
pub mod note_block_batch;
pub mod note_block_delete;
pub mod note_block_insert;
pub mod note_block_move;
pub mod note_block_set_attr;
pub mod note_block_update;
pub mod note_document_apply_md;
pub mod note_document_get_md;
pub mod note_document_outline;
pub mod note_query_blocks;
pub mod note_send_to_note;
// T-EG-08：resolve_output_dir 工具模块声明（注册面 16→17 由本文件下方
// register_builtin_tools_with_config 负责；会话数据经 ctx.output_dir 注入）
pub mod output_dir;
// T-38：project_tree 工具模块声明（注册面 17→18 由本文件下方
// register_builtin_tools_with_config 负责；懒构建缓存进程级共享）
pub mod project_tree;
// T-EG-01：multi_replace 工具模块声明（注册入注册表由 T-EG-02 负责，
// 本行仅使新文件进入编译与测试面）
pub mod replace;
pub mod search;
// T-40：search_context 工具模块声明（注册面 18→19；压缩块检索服务经
// ctx.compression_store 注入，None = common.unsupported）
pub mod search_context;
// D4 §3.10 / E3：send_message 工具模块声明（仅主 agent 工具集；子代理注入
// 通道经 BuiltinToolConfig.subagent_inject_channel、主 agent 消息通道经
// main_agent_message_channel 注入，None = common.unsupported）
pub mod send_message;
pub mod set_timer;
pub mod shell;
pub mod subagent;
pub mod wait_subagents;

use crate::audit::{NoopAuditSink, SecurityAuditSink};
use crate::definition::ToolError;
use crate::registry::ToolRegistry;
use conex_types::error::codes;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 内置工具统一定制配置（由工具执行器注入，模型入参不可覆盖）
///
/// R3 T9：`workspace_root` 移至执行期 `ToolContext`（会话级），
/// 本配置仅保留构造期默认值（shell 超时 / 输出上限 / 回收站根 /
/// 审计 sink）。
#[derive(Debug, Clone)]
pub struct BuiltinToolConfig {
    /// shell 工具默认超时（毫秒），任务书要求默认 30 秒
    pub default_shell_timeout_ms: u64,
    /// shell 工具默认输出保留上限（字节）
    pub default_shell_max_output_bytes: usize,
    /// 删除工具回收站根目录（I2-S3：None 时执行期回退工作区 `.crish-trash`）
    pub trash_root: Option<PathBuf>,
    /// 安全审计 sink（I2-S8：删除/重定向/拦截发射 security-audit 事件；
    /// None = 不接线，工具回退 no-op，审计仅走结构化 tracing 日志）
    pub audit_sink: Option<Arc<dyn SecurityAuditSink>>,
    /// run_subagent spawn 通道（I4-M2：None = 未接线，run_subagent 返回
    /// 结构化不可用错误；引擎侧接线后经此通道发起独立 run——落库与
    /// run 启动在引擎侧实现，agent-tools 只定义契约）
    pub subagent_spawner: Option<Arc<dyn subagent::SubagentSpawner>>,
    /// wait_subagents 等待通道（I5-M8：None = 未接线，wait_subagents 返回
    /// 结构化不可用错误；引擎侧接线后经此通道做事件驱动等待、dispatch_*
    /// 落库与 L1 注入——agent-tools 只定义契约）
    pub subagent_wait_channel: Option<Arc<dyn wait_subagents::SubagentWaitChannel>>,
    /// 后台任务管理器（T-AB-02：None = 未接线，shell 超时保持「树杀」现状；
    /// 引擎侧实现 BackgroundTaskManager 并注入——A3 注册表经本字段透传，
    /// 执行期会话级覆盖走 ToolContext.background）
    pub background_manager: Option<Arc<dyn crate::background::BackgroundTaskManager>>,
    /// 定时器通道（T-CF-05：None = 未接线，set_timer / cancel_timer 返回
    /// 结构化不可用错误；引擎侧实现 TimerRegistry 适配后经此通道注入——
    /// agent-tools 只定义契约，早退/冲突判定与到期注入在引擎侧）
    pub timer_channel: Option<Arc<dyn set_timer::TimerChannel>>,
    /// kill_subagent 终止通道（D4 §3.3：None = 未接线，kill_subagent 返回
    /// 结构化不可用错误；引擎侧经 SubagentLifecycleService + spawn_blocking
    /// 实现后注入——agent-tools 只定义契约）
    pub subagent_kill_channel: Option<Arc<dyn kill_subagent::SubagentKillChannel>>,
    /// send_message 子代理注入通道（D4 §3.10 / E3 §1.2：None = 未接线，
    /// target=subagent 返回结构化不可用错误；引擎侧复用 L1 steer 注入
    /// 通道实现后注入——agent-tools 只定义契约）
    pub subagent_inject_channel: Option<Arc<dyn send_message::SubagentInjectChannel>>,
    /// send_message 主 agent 消息通道（D4 §3.10 / E3 §1.2：None = 未接线，
    /// target=self 返回结构化不可用错误；引擎侧实现会话留档 + followUp 环
    /// 入队后注入——agent-tools 只定义契约）
    pub main_agent_message_channel: Option<Arc<dyn send_message::MainAgentMessageChannel>>,
    /// 工作流创建通道（维度五 / 05 详案 §2.4：None = 未接线，create_workflow
    /// 返回结构化不可用错误；引擎侧复用既有 create-workflow IPC 校验/注册
    /// 逻辑适配后注入——agent-tools 只定义契约，禁止平行第二套注册链路）
    pub workflow_creation_channel: Option<Arc<dyn create_workflow::WorkflowCreationChannel>>,
}

impl Default for BuiltinToolConfig {
    fn default() -> Self {
        Self {
            default_shell_timeout_ms: 30_000,
            // D0/U-BUDGET：预算定义收敛至 conex-shared::perf_budget（数值不变）
            default_shell_max_output_bytes:
                conex_shared::perf_budget::SHELL_MAX_OUTPUT_BYTES_DEFAULT,
            trash_root: None,
            audit_sink: None,
            subagent_spawner: None,
            subagent_wait_channel: None,
            background_manager: None,
            timer_channel: None,
            subagent_kill_channel: None,
            subagent_inject_channel: None,
            main_agent_message_channel: None,
            workflow_creation_channel: None,
        }
    }
}

/// 以默认配置注册全部内置工具（供无配置环境的直连使用）
pub fn register_builtin_tools(registry: &mut ToolRegistry) -> Result<(), ToolError> {
    register_builtin_tools_with_config(registry, BuiltinToolConfig::default())
}

/// 以显式配置注册全部内置工具（构造期默认值由配置注入，会话数据走 ctx）
pub fn register_builtin_tools_with_config(
    registry: &mut ToolRegistry,
    config: BuiltinToolConfig,
) -> Result<(), ToolError> {
    let audit_sink = config
        .audit_sink
        .unwrap_or_else(|| Arc::new(NoopAuditSink) as Arc<dyn SecurityAuditSink>);
    // background_task：manager 执行期经 ToolContext.background 读取
    // （会话级装配由执行器负责），注册面构造零依赖
    registry.register(Arc::new(background_task::BackgroundTaskTool::new()))?;
    registry.register(Arc::new(fs::ReadFileTool::new(None)))?;
    registry.register(Arc::new(fs::WriteFileTool::new()))?;
    // multi_replace_file_content（T-EG-01/02）：多块精确原文替换，schema
    // 按方案 04 §4.1 冻结（target_file + replacement_chunks），写类工具，
    // 与 write_file 同列注册面
    registry.register(Arc::new(replace::MultiReplaceFileTool::new()))?;
    registry.register(Arc::new(fs::ListDirTool::new()))?;
    registry.register(Arc::new(fs::FileStatTool::new()))?;
    registry.register(Arc::new(search::GrepSearchTool::new()))?;
    registry.register(Arc::new(search::FuzzyFindTool::new()))?;
    registry.register(Arc::new(shell::ShellCommandTool::with_background_manager(
        config.default_shell_timeout_ms,
        config.default_shell_max_output_bytes,
        config.trash_root.clone(),
        Arc::clone(&audit_sink),
        config.background_manager.clone(),
    )))?;
    registry.register(Arc::new(diff::DiffTextTool::new()))?;
    registry.register(Arc::new(delete::DeleteFileTool::with_audit_sink(
        config.trash_root.clone(),
        Arc::clone(&audit_sink),
    )))?;
    registry.register(Arc::new(delete::DeleteDirTool::with_audit_sink(
        config.trash_root.clone(),
        audit_sink,
    )))?;
    registry.register(Arc::new(subagent::RunSubagentTool::with_spawner(
        config.subagent_spawner.clone(),
    )))?;
    registry.register(Arc::new(wait_subagents::WaitSubagentsTool::with_channel(
        config.subagent_wait_channel.clone(),
    )))?;
    // kill_subagent（D4 §3.3）：主 agent 单目标关闭子代理（仅主 agent 工具
    // 集——子代理注册表剔除面扩展，剔除决策权威位在引擎装配点）
    registry.register(Arc::new(kill_subagent::KillSubagentTool::with_channel(
        config.subagent_kill_channel.clone(),
    )))?;
    // send_message（D4 §3.10 / E3 §1.2）：主 agent 主动消息注入（仅主 agent
    // 工具集，同剔除面；两通道独立注入，None = common.unsupported）
    registry.register(Arc::new(send_message::SendMessageTool::with_channels(
        config.subagent_inject_channel.clone(),
        config.main_agent_message_channel.clone(),
    )))?;
    // set_timer / cancel_timer（T-CF-05）：一次性后台定时器注册与取消，
    // timer_channel 字段透传（None = 未接线，工具返回 common.unsupported）
    registry.register(Arc::new(set_timer::SetTimerTool::with_channel(
        config.timer_channel.clone(),
    )))?;
    registry.register(Arc::new(set_timer::CancelTimerTool::with_channel(
        config.timer_channel.clone(),
    )))?;
    // create_workflow（维度五 / 05 详案 §2.4 路径 A）：定时任务注册，
    // workflow_creation_channel 字段透传（None = 未接线，工具返回
    // common.unsupported；引擎侧复用 create-workflow IPC 校验/注册逻辑适配）
    registry.register(Arc::new(create_workflow::CreateWorkflowTool::with_channel(
        config.workflow_creation_channel.clone(),
    )))?;
    // resolve_output_dir（T-EG-08 / REQ-G01）：查询类工具——解析会话文档
    // 产出目录（显式 folder 优先 / 默认日期目录 / 惰性幂等）；服务经
    // ToolContext.output_dir 注入（None = 未接线，工具返回 common.unsupported）；
    // 只读类不写盘，按任务书定稿不加入 WRITE_TOOL_NAMES
    registry.register(Arc::new(output_dir::ResolveOutputDirTool::new()))?;
    // project_tree（T-38/39）：目录树工具（懒构建 + mtime 指纹缓存），
    // 只读（dangerous=false）进子 agent 只读集；注册面 17→18
    registry.register(Arc::new(project_tree::ProjectTreeTool::new()))?;
    // search_context（T-40）：已压缩块检索（只搜 compression_blocks），
    // 只读进子 agent 只读集；服务经 ToolContext.compression_store 注入
    // （None = 未接线，工具返回 common.unsupported——引擎侧轮次 6 注入）
    registry.register(Arc::new(search_context::SearchContextTool::new()))?;
    // decompress_context（T-41）：压缩块原文取回（读操作，原始字节），
    // 只读进子 agent 只读集；落文件仅主 agent + output_dir 注入面
    registry.register(Arc::new(decompress_context::DecompressContextTool::new()))?;
    // query_blocks / document_outline / document_get_md（W4-A + Round7）：
    // 笔记读工具，schema 与契约对齐；execute 无 note_backend 时返回
    // note_backend_unwired 稳定占位。读 md 禁止默认 mirror；只读不入 WRITE_TOOL_NAMES
    registry.register(Arc::new(note_query_blocks::QueryBlocksTool::new()))?;
    registry.register(Arc::new(note_document_outline::DocumentOutlineTool::new()))?;
    registry.register(Arc::new(note_document_get_md::DocumentGetMdTool::new()))?;
    // document_apply_md / send_to_note（W4-B）：笔记写工具，dangerous=true；
    // 经同一 apply_md_fragment 后端路径；禁止 fs.write 当权威；不进只读集
    registry.register(Arc::new(note_document_apply_md::DocumentApplyMdTool::new()))?;
    registry.register(Arc::new(note_send_to_note::SendToNoteTool::new()))?;
    // block_batch / block_insert / block_update / block_delete / block_move（W4-F）
    // + block_set_attr（W4-R）：批 ops+dryRun + 细粒度 mutate；
    // dangerous=true；plan Deny；≠ EL-05 / ≠ W6-E
    registry.register(Arc::new(note_block_batch::BlockBatchTool::new()))?;
    registry.register(Arc::new(note_block_insert::BlockInsertTool::new()))?;
    registry.register(Arc::new(note_block_update::BlockUpdateTool::new()))?;
    registry.register(Arc::new(note_block_delete::BlockDeleteTool::new()))?;
    registry.register(Arc::new(note_block_move::BlockMoveTool::new()))?;
    registry.register(Arc::new(note_block_set_attr::BlockSetAttrTool::new()))?;
    Ok(())
}

// ==================== 共享助手（工具内部使用） ====================

/// 路径最大组件深度（safe_canonicalize 的深度上限）
pub(crate) const MAX_PATH_DEPTH: usize = 32;

/// 必填字符串入参：非空 + 非法控制字符拒绝（对齐 TS requireString）
pub(crate) fn require_string(args: &serde_json::Value, key: &str) -> Result<String, ToolError> {
    let value = args
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ToolError::invalid_input(format!("{key} must be a non-empty string")))?;
    if value.trim().is_empty() {
        return Err(ToolError::invalid_input(format!(
            "{key} must be a non-empty string"
        )));
    }
    if value.chars().any(|c| {
        matches!(
            c,
            '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'
        )
    }) {
        return Err(ToolError::invalid_input(format!(
            "{key} contains invalid control characters"
        )));
    }
    Ok(value.to_string())
}

/// 可选字符串入参
pub(crate) fn optional_string(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(String::from)
}

/// 可选布尔入参
pub(crate) fn optional_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    args.get(key).and_then(serde_json::Value::as_bool)
}

/// 可选正数入参（非正数/非有限数视为缺省，由调用方套用默认值）
pub(crate) fn optional_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    let v = args.get(key)?;
    let f = v.as_f64()?;
    if f.is_finite() && f >= 1.0 {
        Some(f.floor() as u64)
    } else {
        None
    }
}

/// 解析工作区路径（对齐 TS resolveWorkspacePath 语义）
///
/// 校验顺序：非空 → 控制字符 → 组件级扫描（`..` 越界报 tool.path_escape）→
/// safe_canonicalize（深度上限）→ 工作区包含性（符号链接解析后仍须在根内）。
/// Windows 上 canonicalize 返回 `\\?\` 前缀路径，统一剥离为可读路径。
pub(crate) fn resolve_workspace_path(
    workspace_root: &Path,
    input: &str,
) -> Result<PathBuf, ToolError> {
    if input.trim().is_empty() {
        return Err(ToolError::invalid_input("path must be a non-empty string"));
    }
    if input.chars().any(|c| c.is_control()) {
        return Err(ToolError::invalid_input(format!(
            "invalid path (control character): {input:?}"
        )));
    }
    let raw = Path::new(input);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workspace_root.join(raw)
    };
    // 组件级扫描：`..` 与超深路径按越界处理（对齐 TS "Path escapes workspace"）
    let mut depth = 0usize;
    for comp in candidate.components() {
        match comp {
            std::path::Component::ParentDir => {
                return Err(ToolError::new(
                    codes::TOOL_PATH_ESCAPE,
                    format!("Path escapes workspace: {input}"),
                ));
            }
            std::path::Component::Normal(_) => {
                depth += 1;
                if depth > MAX_PATH_DEPTH {
                    return Err(ToolError::new(
                        codes::TOOL_PATH_ESCAPE,
                        format!("Path escapes workspace: {input}"),
                    ));
                }
            }
            _ => {}
        }
    }
    let canonical = conex_fs::path_utils::safe_canonicalize(&candidate, MAX_PATH_DEPTH)
        .map_err(|e| ToolError::invalid_input(format!("invalid path: {e}")))?;
    let canonical = conex_fs::ConexPathNormalizer::normalize(&canonical);
    let canonical_root = conex_fs::path_utils::safe_canonicalize(workspace_root, MAX_PATH_DEPTH)
        .map(|p| conex_fs::ConexPathNormalizer::normalize(&p))
        .unwrap_or_else(|_| conex_fs::ConexPathNormalizer::normalize(workspace_root));
    if !path_within_root(&canonical, &canonical_root) {
        return Err(ToolError::new(
            codes::TOOL_PATH_ESCAPE,
            format!("Path escapes workspace: {input}"),
        ));
    }
    // 双保险（审计 P1-S1，F3-02/F5-01）：safe_canonicalize 的「最深已存在祖先」
    // 方案能解析非 dangling symlink，但 dangling symlink 目标不存在无法
    // canonicalize，词法尾部仍可能残留 symlink 组件——对 canonical 相对根
    // 的每一级做 symlink_metadata 检查。
    // 若为工作区内部合法符号链接/Junction（如 pnpm 依赖），放行；逃逸或 dangling 则拒绝。
    if has_escaping_symlink_below_root(&canonical, &canonical_root) {
        return Err(ToolError::new(
            codes::TOOL_PATH_ESCAPE,
            format!("Path escapes workspace: {input}"),
        ));
    }
    Ok(canonical)
}

/// 符号链接组件与 Junction 检测（递归多级链式解析与防环）：
/// - 对输入路径在工作区下的每一级组件执行 `resolve_symlink_chain`；
/// - 若解析过程中遭遇循环引用、死循环或 I/O 错误，采用 Fail-Closed 策略返回 true 拦截；
/// - 校验解析后的终态物理路径是否落入 `norm_root` 工作区边界内；
/// - 若逃逸出工作区，返回 true 拦截；仅当全程物理封闭时返回 false 放行。
pub(crate) fn has_escaping_symlink_below_root(path: &Path, root: &Path) -> bool {
    let norm_path = conex_fs::ConexPathNormalizer::normalize(path);
    let norm_root = conex_fs::ConexPathNormalizer::normalize(root);

    let rel = match norm_path.strip_prefix(&norm_root) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let mut cur = norm_root.clone();
    for comp in rel.components() {
        if let std::path::Component::Normal(name) = comp {
            cur.push(name);
            if let Ok(meta) = std::fs::symlink_metadata(&cur) {
                if meta.file_type().is_symlink() {
                    match conex_fs::resolve_symlink_chain(&cur, 32) {
                        Ok(resolved_target) => {
                            if !conex_fs::ConexPathNormalizer::is_subpath(
                                &resolved_target,
                                &norm_root,
                            ) {
                                return true; // 终态物理路径逃逸，拦截
                            }
                        }
                        Err(_) => {
                            // 发生循环引用、深度超限或无法读取，Fail-Closed 拦截
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// 工作区显示路径（对齐 TS displayPath：优先相对路径，根目录自身回退文件名）
///
/// 先按原始根匹配，失败再按规范化（符号链接解析后）根匹配，最后回退文件名。
/// 输出统一使用 `/` 分隔（对齐 TS 语义，避免 Windows 反斜杠干扰模型解析）。
pub(crate) fn display_path(root: &Path, path: &Path) -> String {
    let rel = display_path_native(root, path);
    #[cfg(windows)]
    let rel = rel.replace('\\', "/");
    rel
}

/// 原生分隔符版显示路径（内部实现）
fn display_path_native(root: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(root) {
        if !rel.as_os_str().is_empty() {
            return rel.to_string_lossy().into_owned();
        }
    }
    if let Ok(canon_root) = conex_fs::path_utils::safe_canonicalize(root, MAX_PATH_DEPTH) {
        let canon_root = strip_verbatim_prefix(&canon_root);
        if let Ok(rel) = path.strip_prefix(&canon_root) {
            if !rel.as_os_str().is_empty() {
                return rel.to_string_lossy().into_owned();
            }
        }
    }
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// 剥离 Windows canonicalize 的 `\\?\` / `\\?\UNC\` 前缀（统一由 conex-fs 提供）
pub(crate) fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    PathBuf::from(conex_fs::ConexPathNormalizer::strip_verbatim_prefix(
        &path.to_string_lossy(),
    ))
}

/// 快照标记：文件 SHA-256 前 12 个 hex 字符（对齐 TS computeSnapshotTag）
pub(crate) fn snapshot_tag(path: &Path) -> Option<String> {
    conex_fs::path_utils::compute_file_hash(path)
        .ok()
        .map(|h| h[..12].to_string())
}

/// 文本解码结果（简化版 decodeTextBuffer）
pub(crate) struct DecodedText {
    pub text: String,
    /// U-READ 后 read_file 改走 windowed_read；本字段仍由 replace/tests 消费
    #[cfg_attr(not(test), allow(dead_code))]
    pub encoding: String,
    /// 同上：read_file 路径已迁出；replace/tests 仍可读
    #[cfg_attr(not(test), allow(dead_code))]
    pub has_bom: bool,
    /// 二进制标记：内容含 NUL 字节无法按文本读取
    pub is_binary: bool,
    /// lossy 标记（编码护栏 A1-H1，裁决 D4 fail-closed）：解码过程是否
    /// 注入过 U+FFFD 替换字符——非 UTF-8 文本（GBK/latin1 等 legacy 编码）
    /// 或 UTF-16 孤立代理项。写回类工具据此拒绝，避免原编码字节被静默改写；
    /// 只读路径（read_file）保持 lossy 诚实显示，不拒不报错。
    pub lossy_replaced: bool,
}

/// 解码文本：BOM 探测 utf-8 / utf-16le / utf-16be，NUL 判定二进制
///
/// 注意顺序：BOM 探测必须先于 NUL 检查——UTF-16 文本天然含 `\x00` 字节。
///
/// 编码护栏（A1-H1）：仅判定「是否有效 UTF-8」，不做 GBK/latin1 具体编码
/// 识别（fail-closed 只需知道「不是 UTF-8」；GBK 双字节 0x81~0xFE 引导 vs
/// latin1 单字节 0x80~0xFF 的差异不构成判定输入，避免编码猜测误判合法 UTF-8）。
pub(crate) fn decode_text(bytes: &[u8]) -> DecodedText {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, lossy_replaced) = decode_utf16(&bytes[2..], true);
        return DecodedText {
            text,
            encoding: "utf-16le".to_string(),
            has_bom: true,
            is_binary: false,
            lossy_replaced,
        };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, lossy_replaced) = decode_utf16(&bytes[2..], false);
        return DecodedText {
            text,
            encoding: "utf-16be".to_string(),
            has_bom: true,
            is_binary: false,
            lossy_replaced,
        };
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        // BOM 剥离逻辑不变；严格解码失败（BOM 后含非 UTF-8 字节）→ lossy + 标记
        let (text, lossy_replaced) = match std::str::from_utf8(&bytes[3..]) {
            Ok(s) => (s.to_string(), false),
            Err(_) => (String::from_utf8_lossy(&bytes[3..]).into_owned(), true),
        };
        return DecodedText {
            text,
            encoding: "utf-8".to_string(),
            has_bom: true,
            is_binary: false,
            lossy_replaced,
        };
    }
    if bytes.contains(&0u8) {
        return DecodedText {
            text: String::new(),
            encoding: "binary".to_string(),
            has_bom: false,
            is_binary: true,
            lossy_replaced: false,
        };
    }
    // 无 BOM 分支严格化：先严格解码，失败才 lossy 并置标记
    // （该路径本身即拒绝，标记恒 false）
    let (text, lossy_replaced) = match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), true),
    };
    DecodedText {
        text,
        encoding: "utf-8".to_string(),
        has_bom: false,
        is_binary: false,
        lossy_replaced,
    }
}

/// 按 UTF-16 字节序解码（BOM 已剥除）；返回 (文本, 是否发生 lossy 替换)
fn decode_utf16(bytes: &[u8], little_endian: bool) -> (String, bool) {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| {
            if little_endian {
                u16::from_le_bytes(c)
            } else {
                u16::from_be_bytes(c)
            }
        })
        .collect();
    // 严格尝试：含孤立代理项（UTF-16 非法序列）→ 回退 lossy 并置标记
    match String::from_utf16(&units) {
        Ok(s) => (s, false),
        Err(_) => (String::from_utf16_lossy(&units), true),
    }
}

/// 路径包含性检查（Windows 大小写不敏感，统一大写盘符与斜杠比较）
fn path_within_root(candidate: &Path, root: &Path) -> bool {
    conex_fs::ConexPathNormalizer::is_subpath(candidate, root)
}

/// 系统时间 → 纪元毫秒（对齐全仓 epoch ms 惯例；不可用时 0）
pub(crate) fn epoch_millis(t: Option<std::time::SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 行级截断助手（T-CF-01）：先按行数上限钳制，再按字符预算钳制；
/// 字符超限时从预算位置向前回退到最近完整行边界（不切行中间）。
/// 返回 (被保留文本, 保留的完整行数, 是否发生钳制)。
///
/// 历史 `clamp_text`（字符边界截断，read_file 改造前的旧助手）已删除——
/// F3 登记的 dead_code 裁决（全仓无调用方）；本助手保证返回文本以完整行结尾，
/// 供 read_file 行粒度续读使用。
pub(crate) fn clamp_text_by_lines(
    text: &str,
    limit_chars: usize,
    limit_lines: usize,
) -> (String, usize, bool) {
    // 快速路径：未超过任何上限，原样返回
    if text.chars().count() <= limit_chars && text.lines().count() <= limit_lines {
        return (text.to_string(), text.lines().count(), false);
    }
    // 行数钳制在前：只保留前 limit_lines 行
    let kept: Vec<&str> = text.lines().take(limit_lines).collect();
    let line_truncated = kept.len() < text.lines().count();
    // 字符钳制：逐行累计（含行间换行符），超限即停在当前完整行边界
    let mut used_chars = 0usize;
    let mut take = 0usize;
    for line in &kept {
        let need = line.chars().count() + usize::from(take > 0);
        if used_chars + need > limit_chars {
            break;
        }
        used_chars += need;
        take += 1;
    }
    let char_truncated = take < kept.len();
    let shown = kept[..take].join("\n");
    (shown, take, line_truncated || char_truncated)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;

    #[test]
    fn path_escape_rejected() {
        let root = std::env::temp_dir().join("agent_tools_escape_test");
        std::fs::create_dir_all(&root).unwrap();
        let err = resolve_workspace_path(&root, "../escape.txt").unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_path_resolved_within_root() {
        let root = std::env::temp_dir().join("agent_tools_resolve_test");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let p = resolve_workspace_path(&root, "sub/file.txt").unwrap();
        assert_eq!(p, root.join("sub/file.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absolute_path_within_root_allowed() {
        let root = std::env::temp_dir().join("agent_tools_abs_test");
        std::fs::create_dir_all(&root).unwrap();
        let p = resolve_workspace_path(&root, &root.join("a.txt").display().to_string()).unwrap();
        assert_eq!(p, root.join("a.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_and_control_path_rejected() {
        let root = std::env::temp_dir();
        assert!(resolve_workspace_path(&root, "").is_err());
        assert!(resolve_workspace_path(&root, "a\0b.txt").is_err());
        assert!(resolve_workspace_path(&root, "a\r\nb.txt").is_err());
    }

    /// 目录符号链接（Unix symlink；Windows 优先真 symlink（开发者模式），
    /// 无权限时回退 junction（mklink /J，普通用户可建）——junction 在 std
    /// 语义下与 symlink 等效（is_symlink=true / canonicalize 跟随 / 写入跟随），
    /// 保证无管理员环境也能复现 symlink 逃逸缺陷；失败返回 Err 由调用方跳过）
    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => Ok(()),
            Err(_) => {
                let status = std::process::Command::new("cmd")
                    .args(["/c", "mklink", "/J"])
                    .arg(link)
                    .arg(target)
                    .status()?;
                if status.success() {
                    Ok(())
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "failed to create directory symlink",
                    ))
                }
            }
        }
    }

    /// 红测试（审计 P1-S1，F3-02）：工作区内 symlink 指向根外已存在目录时，
    /// `link/new.txt`（目标不存在）必须被拒绝——修复前 safe_canonicalize
    /// 词法归一不解析父级 symlink，文本包含性校验通过 → 返回 Ok → 红。
    #[test]
    fn resolve_workspace_path_rejects_symlink_parent_escaping() {
        let temp = std::env::temp_dir().join("agent_tools_symlink_escape_test");
        let root = temp.join("workspace");
        let outside = temp.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");
        if create_dir_symlink(&outside, &link).is_err() {
            return; // 无符号链接权限环境跳过（Windows 开发者模式）
        }
        let err = resolve_workspace_path(&root, "link/new.txt").unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 红测试（审计 P1-S1，F3-02 双保险）：dangling symlink 父目录
    /// （链接目标不存在，canonicalize 无法解析）也必须被拒绝——修复前
    /// 词法归一 + 文本包含性校验双通过 → 返回 Ok → 红。
    #[test]
    fn resolve_workspace_path_rejects_dangling_symlink_parent() {
        let temp = std::env::temp_dir().join("agent_tools_symlink_dangling_test");
        let root = temp.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        let link = root.join("link");
        if create_dir_symlink(&temp.join("outside-ghost"), &link).is_err() {
            return; // 无符号链接权限环境跳过（Windows 开发者模式）
        }
        let err = resolve_workspace_path(&root, "link/new.txt").unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn decode_text_detects_bom_and_binary() {
        let bom_utf8 = b"\xEF\xBB\xBFhello".to_vec();
        let d = decode_text(&bom_utf8);
        assert_eq!(d.text, "hello");
        assert!(d.has_bom);
        assert!(!d.is_binary);
        assert!(!d.lossy_replaced, "合法 BOM UTF-8 不标记 lossy");

        let utf16le = b"\xFF\xFEh\x00e\x00l\x00l\x00o\x00".to_vec();
        let d = decode_text(&utf16le);
        assert_eq!(d.text, "hello");
        assert_eq!(d.encoding, "utf-16le");
        assert!(!d.lossy_replaced, "合法 UTF-16LE 不标记 lossy");

        let binary = vec![0u8, 1u8, 2u8, 3u8];
        let d = decode_text(&binary);
        assert!(d.is_binary);
        assert!(!d.lossy_replaced, "二进制分支标记恒 false");
    }

    #[test]
    fn decode_text_marks_lossy_for_invalid_utf8() {
        // GBK「中文」字节（D6 D0 CE C4）：无 NUL 的 legacy 编码文本，
        // 严格 UTF-8 解码失败 → lossy_replaced = true（fail-closed 判定面，
        // 不做 GBK/latin1 具体编码识别）
        let gbk = vec![0xD6u8, 0xD0, 0xCE, 0xC4];
        let d = decode_text(&gbk);
        assert!(!d.is_binary, "GBK 无 NUL 字节，不得被二进制分支捕获");
        assert!(d.lossy_replaced, "非 UTF-8 必须标记 lossy_replaced");
        assert!(d.text.contains('\u{FFFD}'), "lossy 解码应注入 U+FFFD");

        // UTF-16LE 孤立代理项（FF FE 00 D8 = 0xD800）：严格 from_utf16 失败
        let orphan = vec![0xFF, 0xFE, 0x00, 0xD8];
        let d = decode_text(&orphan);
        assert_eq!(d.encoding, "utf-16le");
        assert!(d.lossy_replaced, "UTF-16 孤立代理项必须标记 lossy_replaced");

        // 合法 UTF-8（含中文，无 BOM）→ 不标记
        let ok = "你好，世界".as_bytes().to_vec();
        let d = decode_text(&ok);
        assert_eq!(d.encoding, "utf-8");
        assert!(!d.lossy_replaced, "合法 UTF-8 不标记 lossy");
    }

    #[test]
    fn glob_helper_free_functions_covered_by_search_tests() {
        // display_path 基本行为
        let root = PathBuf::from("C:/work");
        assert_eq!(display_path(&root, &root.join("src/a.rs")), "src/a.rs");
        assert_eq!(display_path(&root, &root), "work");
    }

    #[test]
    fn register_builtin_tools_registers_all() {
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry).unwrap();
        // 注册面 17→18（project_tree）→20（search_context/decompress_context）
        // →22（W4-A query_blocks / document_outline）
        // →24（W4-B document_apply_md / send_to_note）
        // →25（Round7 document_get_md）
        // →27（W4-F block_batch / block_insert）
        // →29（W4-F 余量 block_update / block_delete）
        // →31（D4：kill_subagent / send_message 两工具并入）
        // →32（W4-F 余量 block_move）
        // →33（W4-R block_set_attr）
        // →34（维度五：create_workflow 并入）
        assert_eq!(registry.len(), 34);
        let names: Vec<String> = registry
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert_eq!(
            names,
            [
                "background_task",
                "block_batch",
                "block_delete",
                "block_insert",
                "block_move",
                "block_set_attr",
                "block_update",
                "cancel_timer",
                "create_workflow",
                "decompress_context",
                "delete_dir",
                "delete_file",
                "diff_text",
                "document_apply_md",
                "document_get_md",
                "document_outline",
                "file_stat",
                "fuzzy_find",
                "grep_search",
                "kill_subagent",
                "list_dir",
                "multi_replace_file_content",
                "project_tree",
                "query_blocks",
                "read_file",
                "resolve_output_dir",
                "run_subagent",
                "search_context",
                "send_message",
                "send_to_note",
                "set_timer",
                "shell_command",
                "wait_subagents",
                "write_file",
            ]
        );
        // 重复注册报版本冲突
        let err = register_builtin_tools(&mut registry).unwrap_err();
        assert_eq!(err.code(), "tool.version_conflict");
    }

    #[tokio::test]
    async fn note_tools_registered_and_stub_execute() {
        // W4-A/B/F：registry 能找到笔记工具；无 backend 时 stub 不炸
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry).unwrap();
        assert!(registry.has("query_blocks"));
        assert!(registry.has("document_outline"));
        assert!(registry.has("document_get_md"));
        assert!(registry.has("document_apply_md"));
        assert!(registry.has("send_to_note"));
        assert!(registry.has("block_batch"));
        assert!(registry.has("block_insert"));
        assert!(registry.has("block_update"));
        assert!(registry.has("block_delete"));
        assert!(registry.has("block_move"));
        assert!(registry.has("block_set_attr"));
        let ctx = crate::context::create_mock_tool_context();
        for name in ["query_blocks", "document_outline", "document_get_md"] {
            let tool = registry.get(name).unwrap();
            let out = tool
                .execute(&ctx, serde_json::json!({ "doc_id": "doc-stub" }))
                .await
                .unwrap_or_else(|e| panic!("{name} stub 不得失败：{e}"));
            assert_eq!(out["ok"], false, "{name}");
            assert_eq!(out["reason"], "note_backend_unwired", "{name}");
        }
        // 写工具：unwired 占位（需完整入参）
        let apply = registry.get("document_apply_md").unwrap();
        let out = apply
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "doc-stub", "markdown": "x" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
        let send = registry.get("send_to_note").unwrap();
        let out = send
            .execute(
                &ctx,
                serde_json::json!({
                    "intent_id": "i",
                    "doc_id": "doc-stub",
                    "markdown": "x",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
        let batch = registry.get("block_batch").unwrap();
        let out = batch
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-stub",
                    "ops": [{ "op": "insert", "content": "x" }],
                    "dryRun": true,
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
        let ins = registry.get("block_insert").unwrap();
        let out = ins
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "doc-stub", "content": "x" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
        let upd = registry.get("block_update").unwrap();
        let out = upd
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "doc-stub", "id": "b1", "content": "x" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
        let del = registry.get("block_delete").unwrap();
        let out = del
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "doc-stub", "id": "b1" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
        let mv = registry.get("block_move").unwrap();
        let out = mv
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "doc-stub", "id": "b1", "previous_id": "b0" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
        let sa = registry.get("block_set_attr").unwrap();
        let out = sa
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-stub",
                    "id": "b1",
                    "attrs": { "checked": true }
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], "note_backend_unwired");
    }

    /// W4-R：`block_set_attr` 已注册且 dangerous=true
    #[test]
    fn w4r_block_set_attr_registered() {
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry).unwrap();
        assert!(registry.has("block_set_attr"));
        let tool = registry.get("block_set_attr").unwrap();
        assert_eq!(tool.name(), "block_set_attr");
        assert!(tool.definition().dangerous);
        let required = tool.definition().input_schema["required"]
            .as_array()
            .unwrap();
        for key in ["doc_id", "id", "attrs"] {
            assert!(
                required.iter().any(|v| v.as_str() == Some(key)),
                "schema missing required {key}"
            );
        }
    }

    #[test]
    fn builtin_config_has_timer_channel() {
        // 回归基线（T-CF-05）：timer_channel 缺省 None——
        // 未接线环境工具返回 common.unsupported，不 panic
        let config = BuiltinToolConfig::default();
        assert!(config.timer_channel.is_none());
    }

    #[test]
    fn builtin_config_has_workflow_creation_channel() {
        // 回归基线（维度五）：workflow_creation_channel 缺省 None——
        // 未接线环境 create_workflow 返回 common.unsupported，不 panic
        let config = BuiltinToolConfig::default();
        assert!(config.workflow_creation_channel.is_none());
    }

    #[tokio::test]
    async fn register_with_config_executes_read_file_via_ctx() {
        use crate::context::{create_mock_tool_context, ToolContext};

        let ws = conex_test_utils::TempWorkspace::new("reg_integ");
        ws.write_file("note.txt", "hello from registry");
        let mut registry = ToolRegistry::new();
        register_builtin_tools(&mut registry).unwrap();
        assert!(registry.has("read_file"));
        let tool = registry.get("read_file").unwrap();
        // R3 T9：workspace_root 从会话上下文读取（不再由注册配置注入）
        let ctx = ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        };
        let out = tool
            .execute(&ctx, serde_json::json!({ "path": "note.txt" }))
            .await
            .unwrap();
        assert!(out["text"]
            .as_str()
            .unwrap()
            .contains("hello from registry"));
    }
}
