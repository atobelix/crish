//! 文档产出目录解析（T-EG-08 / REQ-G01：resolve_output_dir 工具与
//! OutputWorkspace 服务）
//!
//! 定位（方案 04 §4.4 + 调研-可视化与扩展点.md §4）：
//! - 工具：`resolve_output_dir`（注册面 16→17）——显式 folder 优先（直接
//!   使用，不创建目录）；无 folder 生成
//!   `<workspace_root>/.agent-outputs/<YYYY-MM-DD>-<会话标识>/`
//!   （**本地时区、零填充日期前缀**；会话标识经净化：剥离 `\/:*?"<>|`
//!   与控制字符，对齐 applyFileDiff.ts:55-61 净化思路）；**惰性**——仅写
//!   session_meta `"{session_id}:output_dir"` 不建目录，返回
//!   `dirCreated: false` 与「首次写入时自动创建」说明；
//! - 幂等：读 session_meta 命中即返回同一路径（目录名会话**首次** resolve
//!   冻结，同会话不因跨日再调用而漂移）；
//! - 用户显式 folder 同时写入 session_meta（用户指定优先，后续默认沿用）；
//! - 只读子代理不允许自选输出目录：folder 参数忽略，仅返回主 agent 规划
//!   的产出目录（只读信号 = ctx.explore_docs_quota 装配——探索类子代理
//!   = capabilityMode read-only，见 explore_quota.rs 模块头契约；本层为
//!   工具面兜底，注册表级裁剪由 readonly.rs 白名单另行承担）。
//!
//! 接线契约（对齐 explore_quota / revert_guard 模式）：agent-tools 是叶子
//! crate，生产代码不依赖 conex-db——session_meta 读写由引擎侧实现
//! [OutputDirStore]（get/set_session_meta 后端）注入服务；本模块只定义
//! 契约、纯逻辑与工具本身。测试域以 conex-db（dev-dependency）验证
//! session_meta 往返与键编码。
//!
//! 本地时区约束：项目无 chrono 依赖（Cargo.toml 冻结），std 无本地时区
//! 换算面——Windows 上以 kernel32 极小 FFI（GetLocalTime / GetSystemTime）
//! 同刻采集本地/UTC 时钟，差值即本地时区偏移（含夏令时，OS 语义保证；
//! 采集抖动经 15 分钟取整消除——真实时区偏移均为 15 分钟整数倍）；其余
//! 平台回退 UTC（偏移 0），文档明示。日期段为纯函数
//! （[format_date_prefix]：固定时间 + 固定偏移可确定性单测）。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// 产出目录持久化键（session_meta `"{session_id}:output_dir"`，键编码复用
/// explore_quota.rs 的 [crate::explore_quota::session_meta_key_of]）
pub const SESSION_META_KEY_OUTPUT_DIR: &str = "output_dir";
/// 默认产出根目录名（G03 路径隔离：`<workspace_root>/.agent-outputs`）
pub const DEFAULT_OUTPUTS_ROOT_NAME: &str = ".agent-outputs";

// ==================== 纯函数：会话标识净化与日期前缀 ====================

/// 会话标识净化：剥离 `\/:*?"<>|` 与控制字符（C0 + DEL），对齐
/// applyFileDiff.ts:55-61 的 PATH_CONTROL_OR_BAD 净化思路——会话标识将
/// 直接进入目录名，路径分隔符与控制字符必须剔除；其余字符（含中文、
/// 连字符等）保留。
pub fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|c| {
            !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .collect()
}

/// 日期前缀纯函数：epoch 时刻 + 本地时区偏移（分钟，本地 = UTC + 偏移）
/// → 零填充 `YYYY-MM-DD`（Howard Hinnant civil-from-days 换算，无 chrono
/// 依赖；负 epoch / 负偏移经 div_euclid / rem_euclid 容错不 panic）。
///
/// 固定时间注入：单测传固定 epoch + 固定偏移即可确定性断言（含跨日边界）。
pub fn format_date_prefix(now: SystemTime, utc_offset_minutes: i32) -> String {
    let epoch_secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let shifted = epoch_secs + i64::from(utc_offset_minutes) * 60;
    let (year, month, day) = civil_from_days(shifted.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法，与 subagent_inject.rs:86-97
/// 同源；负天数经负商/余数语义容错）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 公历年月日 → Unix 天数（Howard Hinnant days_from_civil，civil_from_days
/// 的逆运算；供 Windows 本地时钟换算 epoch 秒——非 Windows 平台无消费
/// 方，豁免 dead_code 保持跨平台干净）
#[cfg_attr(not(windows), allow(dead_code))]
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 本地时区偏移（分钟；本地 = UTC + 偏移，正东负西）
///
/// Windows：GetLocalTime / GetSystemTime 同刻差值（含夏令时，OS 语义
/// 保证）；秒级截断至多 ±1 分钟采集误差——真实时区偏移均为 15 分钟
/// 整数倍，舍入到最近 15 分钟抗抖动。其余平台 std 无本地时区面，回退
/// 0（UTC），文档明示（项目以 win32 为主目标，非 Windows 平台日期为
/// UTC 口径，可接受并在接线文档声明）。
pub fn local_utc_offset_minutes() -> i32 {
    #[cfg(windows)]
    {
        let (local_secs, utc_secs) = win_time::local_and_utc_epoch_secs();
        let raw_minutes = (local_secs - utc_secs) / 60;
        // 最近 15 分钟取整（负偏移经 div_euclid 保证舍入方向一致）；
        // 真实偏移范围 ±14 小时，i64 → i32 无溢出风险
        ((raw_minutes + 7).div_euclid(15) * 15) as i32
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Windows 本地时间 FFI（项目唯一 FFI 面）
///
/// 项目约束：无 chrono 依赖（Cargo.toml 冻结）、std 无本地时区换算——
/// 此处以 kernel32 两个极小函数取本地/UTC 时钟瞬间。unsafe_code 基线为
/// warn，本模块以 #[allow(unsafe_code)] 显式豁免并登记理由：Windows 平台
/// 本地时间的唯一可行 std 面，函数语义固定（无缓冲/无资源），布局为
/// 纯 POD 结构。
#[cfg(windows)]
mod win_time {
    /// SYSTEMTIME（kernel32）：8 个 WORD 按序，repr(C) 与 Windows 定义
    /// 一一对应（wYear/wMonth/wDayOfWeek/wDay/wHour/wMinute/wSecond/
    /// wMilliseconds）
    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    impl SystemTime {
        /// 字段 → epoch 秒（忽略毫秒；仅供偏移差值计算，秒级精度足够）
        fn epoch_secs(&self) -> i64 {
            let days = super::days_from_civil(
                i64::from(self.year),
                u32::from(self.month),
                u32::from(self.day),
            );
            days * 86_400
                + i64::from(self.hour) * 3_600
                + i64::from(self.minute) * 60
                + i64::from(self.second)
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        /// 本地时间（OS 语义：系统时区与夏令时规则直接生效）
        fn GetLocalTime(lp_system_time: *mut SystemTime);
        /// UTC 时间（与 GetLocalTime 同刻采集）
        fn GetSystemTime(lp_system_time: *mut SystemTime);
    }

    /// 同刻采集（本地, UTC）epoch 秒
    #[allow(unsafe_code)] // 理由见模块头注：Windows 本地时间的唯一 std 面
    pub(super) fn local_and_utc_epoch_secs() -> (i64, i64) {
        let mut local = SystemTime::default();
        let mut utc = SystemTime::default();
        // SAFETY: GetLocalTime/GetSystemTime 恒成功（kernel32 文档无失败返回值），
        // 仅写入栈上 SystemTime POD（repr(C) 布局与 Win32 SYSTEMTIME 一一对应，
        // 见结构体注释）；无指针逃逸，调用后立即逐字段拷贝；结构体生命周期限于本函数
        unsafe {
            GetLocalTime(&mut local);
            GetSystemTime(&mut utc);
        }
        (local.epoch_secs(), utc.epoch_secs())
    }
}

// ==================== 数据结构与解析契约（方案 04 §4.4） ====================

/// 会话级文档产出目录（REQ-G01）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOutputDir {
    /// 会话标识（路径子目录名，经净化：剥离 `\/:*?"<>|` 与控制字符）
    pub session_id: String,
    /// 产出根目录（默认 `<workspace_root>/.agent-outputs`，可配置覆盖）
    pub root: PathBuf,
    /// 本次会话的产出目录 = `root/<YYYY-MM-DD>-<会话标识>/`
    /// （本地时区日期前缀；用户显式指定时为该指定路径）
    pub dir: PathBuf,
    /// 是否为用户显式指定（false = 系统默认生成）
    pub user_specified: bool,
}

/// 产出目录解析结果（T-EG-08 生命周期表）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveOutputDirResult {
    /// 本次解析出的产出目录
    pub dir: AgentOutputDir,
    /// 是否首次解析（首次会写入 session_meta `"{session_id}:output_dir"`；
    /// 后续幂等命中为 false）
    pub first_resolve: bool,
    /// 目录尚未创建，首次写入时自动创建（惰性——避免 AI 误判目录不存在）
    pub dir_created: bool,
}

/// 产出目录解析服务契约（注入 ToolContext，None = 未接线，工具返回
/// common.unsupported 结构化错误）
///
/// 注：§4.4 草案仅要求 `Send + Sync`，ToolContext 派生 Debug 需要 trait
/// 对象可打印——追加 `std::fmt::Debug` 上界（对齐
/// [crate::explore_quota::ExploreDocsQuotaStore] 同款做法）。
pub trait OutputDirResolver: Send + Sync + std::fmt::Debug {
    /// 解析会话产出目录；显式 folder 优先，否则读 session_meta 或生成
    /// 默认路径。惰性：只记录路径不创建目录，首次 write_file 时由
    /// ensure_parent_dir 自动创建。
    ///
    /// `folder` 为调用方已校验的工作区内路径（工具侧经 resolve_workspace_path
    /// 规范化）；服务自身按 `session_meta` 幂等命中优先。
    fn resolve(&self, session_id: &str, folder: Option<&str>) -> ResolveOutputDirResult;
}

/// 产出目录持久化契约（引擎侧以 conex-db 的 get/set_session_meta 实现；
/// 键编码 `{session_id}:output_dir` 复用
/// [crate::explore_quota::session_meta_key_of]）
pub trait OutputDirStore: Send + Sync + std::fmt::Debug {
    /// 读取会话产出目录持久化值（None = 尚未首次解析）
    fn load(&self, session_id: &str) -> Option<String>;
    /// 写入会话产出目录持久化值（首次解析 / 用户显式指定时冻结）
    fn save(&self, session_id: &str, value: &str) -> Result<(), String>;
}

/// 产出目录持久化值（session_meta 格式）：JSON `{"path", "userSpecified"}`
pub fn output_dir_meta_value(dir: &Path, user_specified: bool) -> String {
    serde_json::json!({
        "path": dir.to_string_lossy(),
        "userSpecified": user_specified,
    })
    .to_string()
}

/// 持久化值解析（容错：缺失 / 损坏 / 空路径 → None 按首次处理，不 panic，
/// 对齐 explore_quota.rs:70-88 的 parse 容错模式）
pub fn parse_output_dir_meta(value: Option<&str>) -> Option<(PathBuf, bool)> {
    let value = value?;
    let parsed = serde_json::from_str::<serde_json::Value>(value).ok()?;
    let path = parsed.get("path").and_then(serde_json::Value::as_str)?;
    if path.is_empty() {
        return None;
    }
    let user_specified = parsed
        .get("userSpecified")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    Some((PathBuf::from(path), user_specified))
}

/// 内存版存储（测试与未接线兜底：进程内计数，跨进程重启不恢复——
/// 持久化语义由引擎侧 session_meta 后端承担）
#[derive(Debug, Default)]
pub struct InMemoryOutputDirStore {
    inner: Mutex<HashMap<String, String>>,
}

impl InMemoryOutputDirStore {
    /// 新建空存储
    pub fn new() -> Self {
        Self::default()
    }
}

impl OutputDirStore for InMemoryOutputDirStore {
    fn load(&self, session_id: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
    }

    fn save(&self, session_id: &str, value: &str) -> Result<(), String> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), value.to_string());
        Ok(())
    }
}

// ==================== OutputWorkspace 服务（OutputDirResolver 通用实现） ====================

/// 产出目录解析服务（T-EG-08 REQ-G01：OutputDirResolver 的通用实现）
///
/// 职责（方案 04 §4.4 生命周期表）：
/// - 幂等：读 session_meta 命中即返回同一路径（目录名会话**首次** resolve
///   冻结，同会话不因跨日再调用而漂移；user_specified 随持久化值恢复）；
/// - 首次解析：显式 folder 优先，否则生成
///   `<root>/.agent-outputs/<YYYY-MM-DD>-<净化会话标识>/`（本地时区零填充
///   日期前缀），写入 session_meta 后返回；
/// - 惰性：仅落 meta 不建目录（dir_created 恒 false，首次写入时自动创建）；
/// - 落库失败：tracing 告警不中断——路径本 run 可用，幂等由确定性路径名
///   兜底（下次调用重新生成同一路径）。
///
/// 时间注入：默认时钟 SystemTime::now + 本地时区偏移（平台 API）；测试经
/// [Self::with_time] 注入固定时钟与固定偏移（确定性断言）。
pub struct OutputWorkspace {
    /// 工作区根（默认产出根 = `root/.agent-outputs` 的基准）
    workspace_root: PathBuf,
    /// 会话元数据后端（引擎侧以 conex-db session_meta 实现）
    store: Arc<dyn OutputDirStore>,
    /// 时钟（固定时间注入点）
    clock: Box<dyn Fn() -> SystemTime + Send + Sync>,
    /// 本地时区偏移分钟（固定偏移注入点）
    offset_minutes: Box<dyn Fn() -> i32 + Send + Sync>,
}

impl std::fmt::Debug for OutputWorkspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 闭包字段不可打印，仅输出类型名与工作区根（对齐
        // SessionMetaExploreDocsQuotaStore 的 Debug 参考写法）
        f.debug_struct("OutputWorkspace")
            .field("workspace_root", &self.workspace_root)
            .finish_non_exhaustive()
    }
}

impl OutputWorkspace {
    /// 新建服务（默认时钟与本地时区偏移）
    pub fn new(workspace_root: PathBuf, store: Arc<dyn OutputDirStore>) -> Self {
        Self::with_time(
            workspace_root,
            store,
            SystemTime::now,
            local_utc_offset_minutes,
        )
    }

    /// 新建服务并注入固定时钟与固定偏移（单测确定性用）
    pub fn with_time<C, O>(
        workspace_root: PathBuf,
        store: Arc<dyn OutputDirStore>,
        clock: C,
        offset_minutes: O,
    ) -> Self
    where
        C: Fn() -> SystemTime + Send + Sync + 'static,
        O: Fn() -> i32 + Send + Sync + 'static,
    {
        Self {
            workspace_root,
            store,
            clock: Box::new(clock),
            offset_minutes: Box::new(offset_minutes),
        }
    }
}

impl OutputDirResolver for OutputWorkspace {
    fn resolve(&self, session_id: &str, folder: Option<&str>) -> ResolveOutputDirResult {
        // 幂等：session_meta 命中即返回同一路径（目录名会话首次 resolve
        // 冻结；user_specified 随持久化值恢复）
        if let Some((dir, user_specified)) =
            parse_output_dir_meta(self.store.load(session_id).as_deref())
        {
            return ResolveOutputDirResult {
                dir: AgentOutputDir {
                    session_id: sanitize_session_id(session_id),
                    root: self.workspace_root.join(DEFAULT_OUTPUTS_ROOT_NAME),
                    dir,
                    user_specified,
                },
                first_resolve: false,
                dir_created: false,
            };
        }
        // 首次解析：显式 folder 优先（工具侧已做工作区校验），否则生成默认路径
        let (dir, user_specified) = match folder {
            Some(explicit) => (PathBuf::from(explicit), true),
            None => {
                let name = format!(
                    "{}-{}",
                    format_date_prefix((self.clock)(), (self.offset_minutes)()),
                    sanitize_session_id(session_id)
                );
                (
                    self.workspace_root
                        .join(DEFAULT_OUTPUTS_ROOT_NAME)
                        .join(name),
                    false,
                )
            }
        };
        // 惰性：仅写 session_meta 不建目录（首次写入时由 write_file 的
        // ensure_parent_dir 自动创建）
        if let Err(e) = self
            .store
            .save(session_id, &output_dir_meta_value(&dir, user_specified))
        {
            tracing::warn!(session_id, error = %e, "产出目录持久化失败（本 run 内仍可用，幂等由确定性路径名兜底）");
        }
        ResolveOutputDirResult {
            dir: AgentOutputDir {
                session_id: sanitize_session_id(session_id),
                root: self.workspace_root.join(DEFAULT_OUTPUTS_ROOT_NAME),
                dir,
                user_specified,
            },
            first_resolve: true,
            dir_created: false,
        }
    }
}

// ==================== resolve_output_dir 工具 ====================

/// resolve_output_dir 工具：解析本次会话的文档产出目录（T-EG-08 / REQ-G01）
///
/// schema 按方案 04 §4.4 冻结：可选 folder（工作区内绝对路径）；输出
/// path / userSpecified / dirCreated / text。查询类工具（不写盘、不建目录），
/// 按任务书定稿不加入 readonly.rs 的 WRITE_TOOL_NAMES。
pub(crate) struct ResolveOutputDirTool {
    def: ToolDefinition,
}

impl ResolveOutputDirTool {
    /// 新建工具（产出目录服务经 ToolContext.output_dir 注入，构造零依赖）
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "resolve_output_dir".to_string(),
                description: "解析本次会话的文档产出目录：显式 folder 优先（直接使用，\
                              不创建）；否则返回 .agent-outputs/<YYYY-MM-DD>-<会话标识>/\
                              （惰性——首次写入时自动创建）。同会话重复调用返回同一路径。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "folder": {
                            "type": "string",
                            "description": "用户显式指定的产出目录（工作区内绝对路径），\
                                            优先于默认生成；只读子代理不允许自选（仅按主 \
                                            agent 规划的目录返回）"
                        }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for ResolveOutputDirTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        // 产出目录服务未接线 → 结构化不可用错误（对齐 set_timer /
        // wait_subagents 未接线模式，引擎集成前零副作用）
        let Some(resolver) = &ctx.output_dir else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "resolve_output_dir 未接线：产出目录服务未装配（引擎侧注入 OutputDirResolver 后可用）",
            ));
        };

        // 只读子代理不允许自选输出目录（已决策）：folder 参数忽略——
        // 不做路径校验也不透传，仅返回主 agent 规划的产出目录
        let is_readonly_caller = ctx.explore_docs_quota.is_some();
        let raw_folder = super::optional_string(&args, "folder");
        let folder_ignored = is_readonly_caller && raw_folder.is_some();
        let mut folder = if is_readonly_caller { None } else { raw_folder };

        // 显式 folder → 工作区路径校验（越界 / 非法字符 / glob 形态拒绝，
        // 对齐 write_file 目标路径的 resolve_workspace_path 语义；目标目录
        // 尚不存在时 safe_canonicalize 走「最近存在前缀 + 词法尾部」归一化）
        if let Some(raw) = folder {
            if raw.trim().is_empty() {
                return Err(ToolError::invalid_input(
                    "folder must be a non-empty string",
                ));
            }
            let canonical = super::resolve_workspace_path(&ctx.workspace_root, &raw)?;
            folder = Some(canonical.to_string_lossy().into_owned());
        }

        let result = resolver.resolve(&ctx.session_id, folder.as_deref());

        // 输出形状按方案 04 §4.4 冻结：path（工作区相对展示路径 + 尾斜杠）/
        // userSpecified / dirCreated / text
        let display = super::display_path(&ctx.workspace_root, &result.dir.dir);
        let mut notes: Vec<&str> = Vec::new();
        if result.first_resolve && result.dir.user_specified {
            notes.push("用户指定路径已生效并作为本会话默认产出目录");
        }
        if folder_ignored {
            notes.push("只读子代理不允许自选输出目录，folder 参数已忽略");
        }
        let mut text = format!(
            "会话产出目录：{}（首次写入时自动创建；后续文档产出默认写入该目录）",
            result.dir.dir.display()
        );
        if !notes.is_empty() {
            text.push_str(&format!("；{}", notes.join("；")));
        }
        text.push_str("\nSnapshot tag: <无>");

        Ok(serde_json::json!({
            "path": format!("{display}/"),
            "userSpecified": result.dir.user_specified,
            "dirCreated": result.dir_created,
            "text": text,
        }))
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录/临时库清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use crate::context::{create_mock_tool_context, ExploreDocsQuotaContext};
    use conex_test_utils::TempWorkspace;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::time::Duration;

    /// 2026-08-05T00:00:00Z 的 epoch 秒（20670 天 × 86400）
    const FIXED_EPOCH_2026_08_05: i64 = 1_785_888_000;

    /// 测试用 session_meta 后端（conex-db dev-dependency；对齐
    /// revert_guard.rs:268-309 的测试内参考实现模式——生产实现归引擎侧）
    #[derive(Clone)]
    struct SessionMetaOutputDirStore {
        db: conex_db::LocalDb,
    }

    impl std::fmt::Debug for SessionMetaOutputDirStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("SessionMetaOutputDirStore")
        }
    }

    impl OutputDirStore for SessionMetaOutputDirStore {
        fn load(&self, session_id: &str) -> Option<String> {
            self.db
                .get_session_meta(&crate::explore_quota::session_meta_key_of(
                    session_id,
                    SESSION_META_KEY_OUTPUT_DIR,
                ))
                .ok()
                .flatten()
        }

        fn save(&self, session_id: &str, value: &str) -> Result<(), String> {
            self.db
                .set_session_meta(
                    &crate::explore_quota::session_meta_key_of(
                        session_id,
                        SESSION_META_KEY_OUTPUT_DIR,
                    ),
                    value,
                )
                .map_err(|e| format!("session_meta 落库失败：{e}"))
        }
    }

    /// 固定时间环境：固定时钟（2026-08-05T00:00:00Z）+ 固定偏移（本地 +8 时区）
    fn fixed_workspace(root: PathBuf, store: Arc<dyn OutputDirStore>) -> OutputWorkspace {
        OutputWorkspace::with_time(
            root,
            store,
            || SystemTime::UNIX_EPOCH + Duration::from_secs(FIXED_EPOCH_2026_08_05 as u64),
            || 480,
        )
    }

    /// 工具执行上下文（已注入产出目录服务）
    fn tool_ctx(ws: &TempWorkspace, resolver: Arc<dyn OutputDirResolver>) -> ToolContext {
        ToolContext {
            session_id: "sess-1".to_string(),
            workspace_root: ws.path().clone(),
            output_dir: Some(resolver),
            ..create_mock_tool_context()
        }
    }

    // ===== 纯函数：日期前缀 =====

    /// 日期前缀：零填充 + 本地偏移（固定时间注入的确定性断言）
    #[test]
    fn format_date_prefix_zero_padded_with_offset() {
        let fixed = SystemTime::UNIX_EPOCH + Duration::from_secs(FIXED_EPOCH_2026_08_05 as u64);
        // 偏移 0（UTC）：2026-08-05
        assert_eq!(format_date_prefix(fixed, 0), "2026-08-05");
        // 偏移 +8 小时：同日不变
        assert_eq!(format_date_prefix(fixed, 480), "2026-08-05");
        // 月/日零填充：2026-01-03
        let jan3 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_767_398_400);
        assert_eq!(format_date_prefix(jan3, 0), "2026-01-03");
        // epoch 起点
        assert_eq!(format_date_prefix(SystemTime::UNIX_EPOCH, 0), "1970-01-01");
    }

    /// 日期前缀：跨日边界（本地时区下零点偏移导致日期漂移的确定性断言）
    #[test]
    fn format_date_prefix_crosses_midnight() {
        let late =
            SystemTime::UNIX_EPOCH + Duration::from_secs((FIXED_EPOCH_2026_08_05 + 84_600) as u64);
        assert_eq!(format_date_prefix(late, 0), "2026-08-05");
        // 23:30 UTC + 1 小时偏移 → 本地次日
        assert_eq!(format_date_prefix(late, 60), "2026-08-06");
        // 00:30 UTC - 1 小时偏移 → 本地前一日
        let early =
            SystemTime::UNIX_EPOCH + Duration::from_secs((FIXED_EPOCH_2026_08_05 + 1_800) as u64);
        assert_eq!(format_date_prefix(early, -60), "2026-08-04");
    }

    // ===== 纯函数：会话标识净化 =====

    /// 净化：剥离 `\/:*?"<>|` 与控制字符（C0 + DEL），其余字符保留
    #[test]
    fn sanitize_session_id_strips_bad_chars() {
        let dirty = "a/b\\c:d*e?f\"g<h>i|j";
        assert_eq!(sanitize_session_id(dirty), "abcdefghij");
        let controls = "a\x00b\x01c\x1fd\x7fe";
        assert_eq!(sanitize_session_id(controls), "abcde");
        // 合法字符（含中文与连字符）保留
        assert_eq!(
            sanitize_session_id("会话-2026-08-04-9f2a"),
            "会话-2026-08-04-9f2a"
        );
        // 空串保持空（退化场景由调用方处理）
        assert_eq!(sanitize_session_id(""), "");
    }

    // ===== 目录名格式与默认路径生成 =====

    /// 默认路径：`.agent-outputs/<YYYY-MM-DD>-<净化会话标识>/`，
    /// 目录名格式正则断言（本地时区 + 净化）
    #[test]
    fn default_dir_name_matches_format_regex() {
        let ws = TempWorkspace::new("out_dir_default");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        let svc = fixed_workspace(ws.path().clone(), store);

        let result = svc.resolve("sess-1/with:bad\\chars", None);
        assert!(result.first_resolve, "首次解析标记必须为 true");
        let name = result
            .dir
            .dir
            .file_name()
            .expect("目录名应存在")
            .to_string_lossy()
            .into_owned();
        // 目录名格式：YYYY-MM-DD 前缀（零填充）+ 净化后的会话标识
        let re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}-").expect("格式正则应合法");
        assert!(re.is_match(&name), "目录名 {name:?} 应含日期前缀");
        assert_eq!(name, "2026-08-05-sess-1withbadchars");
        assert_eq!(
            result.dir.dir,
            ws.path()
                .join(".agent-outputs")
                .join("2026-08-05-sess-1withbadchars")
        );
        // 产出根 = <workspace_root>/.agent-outputs
        assert_eq!(result.dir.root, ws.path().join(".agent-outputs"));
        // 惰性：不建目录
        assert!(!result.dir_created);
        assert!(!result.dir.dir.exists(), "惰性：resolve 后目录不得存在");
        assert!(
            !ws.path().join(".agent-outputs").exists(),
            "惰性：产出根不得被创建"
        );
    }

    // ===== session_meta 往返（conex-db dev-dependency） =====

    /// session_meta 往返：resolve 落库 → 键命中返回同一路径；键编码
    /// `{session_id}:output_dir`；空 session_id 退化字面键
    #[test]
    fn session_meta_roundtrip_and_key_encoding() {
        let db = conex_db::LocalDb::open_in_memory().expect("打开内存库");
        let store = Arc::new(SessionMetaOutputDirStore { db: db.clone() });
        let svc = fixed_workspace(PathBuf::from("C:/work"), store);

        let first = svc.resolve("sess-1", None);
        assert!(first.first_resolve);
        // 键编码对齐 explore_quota.rs:43-49 的 session_meta_key_of
        let key = crate::explore_quota::session_meta_key_of("sess-1", SESSION_META_KEY_OUTPUT_DIR);
        assert_eq!(key, "sess-1:output_dir");
        let raw = db
            .get_session_meta(&key)
            .expect("读取 meta")
            .expect("首次解析必须落库");
        // 值格式：JSON {"path","userSpecified"}
        let (path, user_specified) = parse_output_dir_meta(Some(&raw)).expect("解析持久化值");
        assert_eq!(path, first.dir.dir);
        assert!(!user_specified);

        // 空 session_id 退化字面键（单会话引擎形态）
        svc.resolve("", None);
        assert!(
            db.get_session_meta(SESSION_META_KEY_OUTPUT_DIR)
                .expect("读取字面键")
                .is_some(),
            "空 session_id 必须退化字面键落库"
        );
    }

    // ===== 幂等：目录名会话首次 resolve 冻结 =====

    /// 幂等：跨日再调用不漂移（时钟推进后仍返回首次冻结的路径）
    #[test]
    fn idempotent_same_path_across_days() {
        let ws = TempWorkspace::new("out_dir_idem");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        // 可推进时钟：2026-08-05 → 次日
        let now_secs = Arc::new(AtomicI64::new(FIXED_EPOCH_2026_08_05));
        let clock_secs = Arc::clone(&now_secs);
        let svc = OutputWorkspace::with_time(
            ws.path().clone(),
            store,
            move || {
                SystemTime::UNIX_EPOCH
                    + Duration::from_secs(clock_secs.load(Ordering::Relaxed) as u64)
            },
            || 480,
        );

        let first = svc.resolve("sess-1", None);
        assert!(first.first_resolve);
        // 跨日推进后二次解析：meta 命中，路径不变
        now_secs.store(FIXED_EPOCH_2026_08_05 + 86_400, Ordering::Relaxed);
        let second = svc.resolve("sess-1", None);
        assert!(!second.first_resolve, "二次解析必须为 meta 命中");
        assert_eq!(second.dir.dir, first.dir.dir, "跨日调用路径不得漂移");
        assert_eq!(
            second.dir.dir.file_name().unwrap().to_string_lossy(),
            "2026-08-05-sess-1",
            "目录名冻结在首次解析日期"
        );
    }

    // ===== 显式 folder 优先 =====

    /// 显式 folder：直接使用（不创建）+ 写 session_meta，后续默认沿用
    #[test]
    fn explicit_folder_priority_and_persisted() {
        let ws = TempWorkspace::new("out_dir_explicit");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        let svc = fixed_workspace(ws.path().clone(), Arc::clone(&store));

        let explicit = ws.path().join("docs/reports/规划");
        let result = svc.resolve("sess-1", Some(&explicit.to_string_lossy()));
        assert!(result.first_resolve);
        assert_eq!(result.dir.dir, explicit);
        assert!(result.dir.user_specified);
        assert!(!result.dir_created);

        // 后续默认沿用用户指定路径（无 folder 调用命中 meta）
        let again = svc.resolve("sess-1", None);
        assert!(!again.first_resolve);
        assert_eq!(again.dir.dir, explicit, "用户指定路径必须默认沿用");
        assert!(
            again.dir.user_specified,
            "user_specified 必须随持久化值恢复"
        );

        // 未指定会话（sess-2）不受影响：走默认生成
        let other = svc.resolve("sess-2", None);
        assert!(other.first_resolve);
        assert_eq!(
            other.dir.dir,
            ws.path().join(".agent-outputs").join("2026-08-05-sess-2")
        );
    }

    // ===== 损坏值容错 =====

    /// 持久化值损坏：按首次处理重新生成（不 panic）
    #[test]
    fn corrupt_meta_tolerated() {
        let ws = TempWorkspace::new("out_dir_corrupt");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        store.save("sess-1", "not-json{{{").expect("写入损坏值");
        let svc = fixed_workspace(ws.path().clone(), store);
        let result = svc.resolve("sess-1", None);
        assert!(result.first_resolve, "损坏值按首次处理重新生成");
        assert_eq!(
            result.dir.dir,
            ws.path().join(".agent-outputs").join("2026-08-05-sess-1")
        );
    }

    // ===== 并发首次调用：先写者胜 =====

    /// 多 run 并发首次 resolve：同会话返回同一路径（确定性路径名 +
    /// 存储互斥保证先写者胜）
    #[test]
    fn concurrent_first_resolve_same_path() {
        let ws = TempWorkspace::new("out_dir_conc");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        let svc = Arc::new(fixed_workspace(ws.path().clone(), store));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let svc = Arc::clone(&svc);
                std::thread::spawn(move || svc.resolve("sess-1", None).dir.dir)
            })
            .collect();
        let paths: Vec<PathBuf> = handles
            .into_iter()
            .map(|h| h.join().expect("线程应正常结束"))
            .collect();
        for p in &paths {
            assert_eq!(*p, paths[0], "并发首次解析必须收敛到同一路径");
        }
        assert_eq!(
            paths[0],
            ws.path().join(".agent-outputs").join("2026-08-05-sess-1")
        );
    }

    // ===== 工具面 =====

    /// 未接线：ctx.output_dir = None → common.unsupported（不 panic）
    #[tokio::test]
    async fn tool_unplugged_returns_unsupported() {
        let ws = TempWorkspace::new("out_dir_tool_none");
        let tool = ResolveOutputDirTool::new();
        let ctx = ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        };
        let err = tool
            .execute(&ctx, serde_json::json!({}))
            .await
            .expect_err("未接线必须报错");
        assert_eq!(err.code(), "common.unsupported");
        assert!(err.to_string().contains("未接线"), "错误必须明示未接线");
    }

    /// 默认解析：输出形状 path / userSpecified / dirCreated / text，
    /// path 为工作区相对展示路径（尾斜杠）
    #[tokio::test]
    async fn tool_default_resolve_output_shape() {
        let ws = TempWorkspace::new("out_dir_tool_def");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
        let tool = ResolveOutputDirTool::new();
        let ctx = tool_ctx(&ws, svc);

        let out = tool
            .execute(&ctx, serde_json::json!({}))
            .await
            .expect("默认解析应成功");
        assert_eq!(out["path"], ".agent-outputs/2026-08-05-sess-1/");
        assert_eq!(out["userSpecified"], false);
        assert_eq!(out["dirCreated"], false);
        let text = out["text"].as_str().expect("text 必须存在");
        assert!(text.contains("首次写入时自动创建"), "必须说明惰性创建语义");
        assert!(
            !ws.path().join(".agent-outputs").exists(),
            "工具调用不得创建目录"
        );
    }

    /// 显式 folder：解析返回指定路径且落 meta（后续默认沿用）；
    /// 工作区外 folder 拒绝（tool.path_escape）
    #[tokio::test]
    async fn tool_explicit_folder_and_outside_rejected() {
        let ws = TempWorkspace::new("out_dir_tool_ex");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
        let tool = ResolveOutputDirTool::new();
        let ctx = tool_ctx(&ws, svc);

        // 工作区内（尚不存在）的目录：直接返回（惰性不创建）
        let folder = ws.path().join("docs/reports");
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "folder": folder.to_string_lossy() }),
            )
            .await
            .expect("工作区内 folder 应放行");
        assert_eq!(out["userSpecified"], true);
        assert_eq!(
            out["path"].as_str().expect("path 必须存在"),
            "docs/reports/",
            "展示路径应为工作区相对路径"
        );
        assert!(out["text"].as_str().unwrap().contains("用户指定路径已生效"));

        // 越界 folder：tool.path_escape
        let err = tool
            .execute(&ctx, serde_json::json!({ "folder": "../outside" }))
            .await
            .expect_err("越界 folder 必须拒绝");
        assert_eq!(err.code(), "tool.path_escape");

        // 空白 folder：invalid_input
        let err = tool
            .execute(&ctx, serde_json::json!({ "folder": "   " }))
            .await
            .expect_err("空白 folder 必须拒绝");
        assert_eq!(err.code(), "tool.invalid_input");
    }

    /// 只读子代理：不允许自选输出目录——folder 参数忽略，仅返回主 agent
    /// 规划的产出目录（对齐「按主 agent 规划」语义）
    #[tokio::test]
    async fn tool_readonly_subagent_cannot_choose_folder() {
        let ws = TempWorkspace::new("out_dir_tool_ro");
        let store: Arc<dyn OutputDirStore> = Arc::new(InMemoryOutputDirStore::new());
        let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
        let tool = ResolveOutputDirTool::new();
        let mut ctx = tool_ctx(&ws, svc);
        // 探索类（read-only）子代理上下文：配额上下文装配 = 只读信号
        ctx.explore_docs_quota = Some(ExploreDocsQuotaContext {
            session_id: "sess-1".to_string(),
            run_id: "run-researcher-1".to_string(),
            granted: false,
            quota: 1,
            store: None,
        });

        // 带 folder 调用：folder 被忽略，返回默认（主 agent 规划）目录
        let out = tool
            .execute(&ctx, serde_json::json!({ "folder": "C:/outside/evil" }))
            .await
            .expect("只读子代理调用不应失败");
        assert_eq!(
            out["path"].as_str().expect("path 必须存在"),
            ".agent-outputs/2026-08-05-sess-1/",
            "只读子代理必须返回主 agent 规划的产出目录"
        );
        assert_eq!(out["userSpecified"], false);
        let text = out["text"].as_str().expect("text 必须存在");
        assert!(text.contains("folder 参数已忽略"), "必须明示 folder 被忽略");

        // 无 folder 调用：正常返回默认目录
        let plain = tool
            .execute(&ctx, serde_json::json!({}))
            .await
            .expect("只读子代理默认调用应成功");
        assert_eq!(
            plain["path"], out["path"],
            "只读子代理路径与主 agent 规划一致"
        );
    }

    /// 非法字符净化：工具级调用携带含非法字符的 session_id → 目录名净化、
    /// session_meta 键仍用原始标识（键稳定性）
    #[tokio::test]
    async fn tool_sanitizes_session_id_in_dir_name() {
        let ws = TempWorkspace::new("out_dir_tool_san");
        let db = conex_db::LocalDb::open_in_memory().expect("打开内存库");
        let store: Arc<dyn OutputDirStore> = Arc::new(SessionMetaOutputDirStore { db: db.clone() });
        let svc: Arc<dyn OutputDirResolver> = Arc::new(fixed_workspace(ws.path().clone(), store));
        let tool = ResolveOutputDirTool::new();
        let ctx = ToolContext {
            session_id: "s/1\\2:3*4".to_string(),
            workspace_root: ws.path().clone(),
            output_dir: Some(svc),
            ..create_mock_tool_context()
        };

        let out = tool
            .execute(&ctx, serde_json::json!({}))
            .await
            .expect("净化后的解析应成功");
        assert_eq!(out["path"], ".agent-outputs/2026-08-05-s1234/");
        // 键仍按原始 session_id 编码（幂等稳定）
        let key =
            crate::explore_quota::session_meta_key_of("s/1\\2:3*4", SESSION_META_KEY_OUTPUT_DIR);
        assert!(
            db.get_session_meta(&key).expect("读 meta").is_some(),
            "meta 键必须用原始标识"
        );
    }
}
