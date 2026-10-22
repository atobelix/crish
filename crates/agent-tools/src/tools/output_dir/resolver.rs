//! 产出目录数据结构与解析契约 + OutputWorkspace 服务（OutputDirResolver 通用实现）

use super::{
    format_date_prefix, local_utc_offset_minutes, sanitize_session_id, DEFAULT_OUTPUTS_ROOT_NAME,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

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
