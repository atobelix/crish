//! 写路径声明与引擎级互斥（I4-M3：Reasonix WritePathSet 落地）
//!
//! 把 05 手册 §3 文件域互斥表从提示词纪律升级为引擎强制：
//! - **声明**：写类工具（write_file / delete_file / delete_dir / shell 删除重定向）
//!   执行前经 `ToolContext.write_claims` 注册表声明写路径；子代理 spawn 时
//!   （M2 run_subagent）可声明长期写路径（本模块 `claim` 的持有期由守卫
//!   `WriteClaimGuard` 决定——工具执行期临时声明随守卫 Drop 释放，子代理
//!   声明由 M2/M6 持有守卫到 run 结束）。
//! - **互斥**：Overlaps 检测（路径前缀语义：`a/b/c.txt` 与 `a/b/` 冲突），
//!   冲突 → `tool.write_path_conflict` 结构化错误（谁占用 / 何时 / 有效期）。
//! - **同持有者豁免**：同一 holder 对自身声明路径的再声明 / 扩展不冲突
//!   （子代理可写自己的声明内路径），不同持有者重叠即拒绝。
//! - **超时释放**：声明带 TTL（默认 60s 无活动自动释放，防悬挂）；
//!   `claim` / `check_conflict` 前先清扫过期声明。
//! - **校验**：复用 `resolve_workspace_path`（symlink 解析后比较、拒绝 `..`、
//!   拒绝工作区外、Windows 大小写折叠），另拒绝 glob（`* ? [`）。
//!
//! T-D-08 起增补 run 级硬沙箱（REQ-D04 越权拒绝，权限层）：
//! - **[WritePathPolicy]**（`Allowed` 允许集 / `Unrestricted` 不限制）经
//!   [check_write_allowance] 在写工具执行前拦截：目标不在任何允许前缀下 →
//!   `tool.write_not_allowed`（conex-types 已登记，Permanent 不可重试）；
//! - 允许集与互斥注册表同载体装配（[WritePathRegistry::with_write_policy]，
//!   引擎侧 T-D-13 把 spawn 字段与 task_type 默认集合并后转策略再注册），
//!   但**语义独立**——白名单是"允许集"（权限沙箱）、互斥是"并发控制"，
//!   挂接顺序一先一后串行叠加：先 [check_write_allowance_for_ctx]（越权拒绝）
//!   → 再 `claim_write_guard`（冲突拒绝）；
//! - 未接线语义扩展：`write_claims = None` 或注册表未装配策略 → 不强制，
//!   写工具保持现状行为（测试与直连场景不受影响）。
//!
//! 未接线语义：`ToolContext.write_claims = None` 时写工具不强制互斥
//! （现状行为保持，测试与直连场景不受影响）；接线由执行器按会话装配
//! （session-loop ToolExecutor 或 M2 子代理执行上下文）。
//!
//! 与 M6 调度器交接：`check_conflict` / `active_claims` 供 spawn 前
//! preflight（`ValidateNonOverlappingWriteClaims` 语义）与父代理写预留
//! （`ReserveParentWrite`）消费；本模块只提供会话级记账，不碰调度。

use crate::context::ToolContext;
use crate::definition::ToolError;
use crate::tools::epoch_millis;
use crate::tools::resolve_workspace_path;
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// 写路径互斥冲突错误码（本域局部码，对齐 shell.rs 的 tool.requires_approval 模式；
/// 不入 conex-types 注册表——执行器按错误码分类路由，冲突为确定拒绝、不可重试）
pub(crate) const TOOL_WRITE_PATH_CONFLICT: &str = "tool.write_path_conflict";

/// 声明默认有效期（毫秒）：60s 无活动自动释放，防悬挂（I4-M3 内容 4）
pub const DEFAULT_CLAIM_TTL_MS: u64 = 60_000;

/// 声明模式：写入 / 删除（互斥检测不区分模式——两者都是对路径的写操作；
/// 模式保留在声明里供错误信息与审计展示）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimMode {
    /// 写入文件（write_file 等）
    Write,
    /// 删除目标（delete_file / delete_dir / shell 删除重定向）
    Delete,
}

impl std::fmt::Display for ClaimMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaimMode::Write => write!(f, "write"),
            ClaimMode::Delete => write!(f, "delete"),
        }
    }
}

/// 单条写路径声明（会话级记账条目）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritePathClaim {
    /// 占用者标识（子代理 run id / 工具执行 holder / 主 agent）
    pub holder: String,
    /// 会话标识（注册表按会话隔离，跨会话声明不互相占用）
    pub session_id: String,
    /// 规范化绝对路径（symlink 已解析、工作区内、`\\?\` 前缀已剥离）
    pub path: PathBuf,
    /// 声明模式
    pub mode: ClaimMode,
    /// 声明时刻（纪元毫秒，对齐全仓 epoch ms 惯例）
    pub claimed_at_ms: i64,
    /// 到期时刻（毫秒）：超过即视为自动释放（防悬挂）
    pub expires_at_ms: i64,
}

/// 写路径互斥冲突（结构化错误载荷：谁占用 / 何时 / 有效期）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritePathConflict {
    /// 本次请求的路径（规范化）
    pub requested_path: PathBuf,
    /// 占用该路径的既有声明（含 holder / 时间 / 模式）
    pub conflicting: WritePathClaim,
}

impl std::fmt::Display for WritePathConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "写路径互斥冲突：{} 已被占用（占用者 {}，会话 {}，模式 {}，声明于 {} ms，有效期至 {} ms）；\
             请等待占用者完成或改由主 agent 编排串行",
            self.requested_path.display(),
            self.conflicting.holder,
            self.conflicting.session_id,
            self.conflicting.mode,
            self.conflicting.claimed_at_ms,
            self.conflicting.expires_at_ms,
        )
    }
}

impl WritePathConflict {
    /// 转为工具错误（错误码 `tool.write_path_conflict`，消息含占用者与时间）
    pub fn into_tool_error(self) -> ToolError {
        ToolError::new(TOOL_WRITE_PATH_CONFLICT, format!("{self}"))
    }
}

// ==================== T-D-08：run 级硬沙箱（REQ-D04 越权拒绝） ====================

/// run 级硬性写入允许集（None = 不限制路径；implementation 默认 = 工作区根）
///
/// 权限沙箱（不是并发层）：`Allowed` 为白名单前缀集合，目标必须落在任一
/// 允许前缀下（组件边界语义 + Windows 大小写折叠，复用 [paths_overlap_normalized]
/// 的归一化底座）；`Unrestricted` 不做路径限制。引擎侧（T-D-13）把 spawn 的
/// `allowed_write_paths` 字段与 task_type 默认集合并后经 [WritePathPolicy::from_entries]
/// 构造，再装配进 [WritePathRegistry]（[WritePathRegistry::with_write_policy]）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum WritePathPolicy {
    /// 白名单允许集：目标必须在任一允许前缀下（空列表 = 全部拒绝，fail-closed）
    Allowed(Vec<PathBuf>),
    /// 不限制路径（缺省；implementation 的默认集由引擎装配为工作区根）
    #[default]
    Unrestricted,
}

impl WritePathPolicy {
    /// 从原始路径条目构造策略（供引擎 T-D-13 装配与测试使用）
    ///
    /// - 空列表 → [WritePathPolicy::Unrestricted]（REQ-D04：`allowed_write_paths`
    ///   为空 = 不做路径限制，仅受工具面控制）；
    /// - 每条目经 [validate_write_path] 校验并解析为规范化绝对路径
    ///   （glob 拒绝 / `..` 越界拒绝 / 工作区外拒绝），保证白名单与写工具
    ///   执行期目标在同一坐标空间（绝对路径）比较。
    pub fn from_entries(workspace_root: &Path, entries: Vec<String>) -> Result<Self, ToolError> {
        if entries.is_empty() {
            return Ok(WritePathPolicy::Unrestricted);
        }
        let resolved: Vec<PathBuf> = entries
            .iter()
            .map(|e| validate_write_path(workspace_root, e))
            .collect::<Result<_, _>>()?;
        Ok(WritePathPolicy::Allowed(resolved))
    }
}

/// 写路径越权（结构化错误载荷：目标路径 + 允许范围提示）
///
/// 与 [WritePathConflict]（并发冲突）语义区分：本错误属权限层——路径合法
/// 且未被占用，只是不在 run 级允许集内；文案指引调整目标或走权限申请通道。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteAllowanceError {
    /// 本次请求的目标路径（规范化绝对路径）
    pub requested_path: PathBuf,
    /// 当前允许范围（白名单前缀；提示用）
    pub allowed: Vec<PathBuf>,
}

impl std::fmt::Display for WriteAllowanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let allowed = if self.allowed.is_empty() {
            "无（写入被整体禁止）".to_string()
        } else {
            self.allowed
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join("、")
        };
        write!(
            f,
            "写入路径不在允许范围内：{}；当前允许范围：{}。如需写入，请调整目标路径或向主 agent 申请权限",
            self.requested_path.display(),
            allowed,
        )
    }
}

impl WriteAllowanceError {
    /// 转为工具错误（错误码 `tool.write_not_allowed`，conex-types 已登记，
    /// Permanent / 不可重试；消息含目标路径与允许范围提示）
    pub fn into_tool_error(self) -> ToolError {
        ToolError::new(codes::TOOL_WRITE_NOT_ALLOWED, format!("{self}"))
    }
}

impl From<WriteAllowanceError> for ToolError {
    fn from(e: WriteAllowanceError) -> Self {
        e.into_tool_error()
    }
}

/// 硬沙箱越权判定（纯函数，无副作用；T-D-08 核心）
///
/// - [WritePathPolicy::Unrestricted] → 放行（不限制路径）；
/// - [WritePathPolicy::Allowed] → 目标必须在任一允许前缀下（组件边界 +
///   Windows 大小写折叠），否则拒绝，返回 [WriteAllowanceError]（含目标与
///   允许范围提示，`?` 转换为 `tool.write_not_allowed`）。
pub fn check_write_allowance(
    policy: &WritePathPolicy,
    target: &Path,
) -> Result<(), WriteAllowanceError> {
    match policy {
        WritePathPolicy::Unrestricted => Ok(()),
        WritePathPolicy::Allowed(allowed) => {
            if allowed.iter().any(|p| is_within_allowed(target, p)) {
                return Ok(());
            }
            Err(WriteAllowanceError {
                requested_path: target.to_path_buf(),
                allowed: allowed.clone(),
            })
        }
    }
}

/// 写路径声明守卫（RAII）：Drop 时释放本持有者的全部声明
///
/// - 工具执行期：守卫随 execute 作用域结束（成功 / 错误 / panic / 取消）
///   自动释放，无泄漏；
/// - 子代理 run 期：M2/M6 持有守卫到 run 结束，中途异常即自动释放（防悬挂
///   的第二道保险，第一道是 TTL 超时）。
#[derive(Debug)]
pub struct WriteClaimGuard {
    registry: Arc<WritePathRegistry>,
    holder: String,
}

impl Drop for WriteClaimGuard {
    fn drop(&mut self) {
        self.registry.release_holder(&self.holder);
    }
}

/// 会话级写路径注册表（I4-M3 引擎级互斥的记账本体）
///
/// 一个注册表对应一个会话（`session_id` 固定），全部声明与该会话绑定；
/// 供工具执行期临时声明与子代理长期声明共用。内部为 `Mutex<Vec<..>>`，
/// 锁中毒按项目约定恢复式处理（A 模式：记录错误、取回内值继续，不 panic）。
#[derive(Debug)]
pub struct WritePathRegistry {
    session_id: String,
    workspace_root: PathBuf,
    default_ttl_ms: u64,
    /// run 级硬沙箱允许集（T-D-08：None = 未装配策略，不强制越权检查；
    /// 与互斥声明同载体，但语义独立——白名单是"允许集"，互斥是"并发控制"）
    write_policy: Option<WritePathPolicy>,
    inner: Mutex<Vec<WritePathClaim>>,
}

impl WritePathRegistry {
    /// 新建会话级注册表（默认 TTL：`DEFAULT_CLAIM_TTL_MS`）
    pub fn new(session_id: impl Into<String>, workspace_root: impl AsRef<Path>) -> Self {
        Self::with_ttl(session_id, workspace_root, DEFAULT_CLAIM_TTL_MS)
    }

    /// 新建注册表并指定声明默认有效期（毫秒；测试与调度器可收紧/放宽）
    pub fn with_ttl(
        session_id: impl Into<String>,
        workspace_root: impl AsRef<Path>,
        default_ttl_ms: u64,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            workspace_root: workspace_root.as_ref().into(),
            default_ttl_ms,
            write_policy: None,
            inner: Mutex::new(Vec::new()),
        }
    }

    /// 装配 run 级写允许集（T-D-08 硬沙箱；引擎侧 T-D-13 转策略后注册。
    /// 消费方：[check_write_allowance_for_ctx] 在写工具执行前先做越权检查，
    /// 再走互斥声明——权限层与并发层一先一后，互不替代）
    pub fn with_write_policy(mut self, policy: WritePathPolicy) -> Self {
        self.write_policy = Some(policy);
        self
    }

    /// 当前装配的写允许集（None = 未装配，越权检查不强制）
    pub fn write_policy(&self) -> Option<&WritePathPolicy> {
        self.write_policy.as_ref()
    }

    /// 声明写路径（多路径原子化：任一校验失败或冲突即整体拒绝，不产生部分声明）
    ///
    /// 接收者要求 `Arc<Self>`：守卫须持有与注册表同一实例的 Arc，Drop 时
    /// 才能释放到本注册表（ctx 侧经 `ToolContext.write_claims: Option<Arc<..>>`
    /// 传入，天然满足）。
    ///
    /// - 全部路径先经 [validate_write_path] 校验（glob 拒绝 / 工作区越界拒绝）；
    /// - 冲突检测排除同持有者（子代理可写自己声明的路径，扩展不冲突）；
    /// - 成功返回守卫，Drop 释放本持有者全部声明；失败返回
    ///   `tool.write_path_conflict`（含占用者与时间信息）。
    pub fn claim<I, S>(
        self: &Arc<Self>,
        holder: I,
        paths: &[S],
        mode: ClaimMode,
    ) -> Result<WriteClaimGuard, ToolError>
    where
        I: Into<String>,
        S: AsRef<str>,
    {
        let holder = holder.into();
        let resolved: Vec<PathBuf> = paths
            .iter()
            .map(|p| validate_write_path(&self.workspace_root, p.as_ref()))
            .collect::<Result<_, _>>()?;
        self.expire_stale();
        let now = epoch_millis(Some(SystemTime::now()));
        let expires_at = now + self.default_ttl_ms as i64;
        {
            // 冲突检测与插入在同一锁区间内完成（原子化）：防止 TOCTOU——
            // 检测后、插入前他方抢注同路径
            let mut inner = lock_inner(&self.inner);
            for path in &resolved {
                if let Some(conflicting) = inner
                    .iter()
                    .find(|c| c.holder != holder && paths_overlap_normalized(path, &c.path))
                {
                    return Err(WritePathConflict {
                        requested_path: path.clone(),
                        conflicting: conflicting.clone(),
                    }
                    .into_tool_error());
                }
            }
            for path in resolved {
                // 同持有者同路径：去重并续期（重复声明视为刷新活动时间）
                inner.retain(|c| !(c.holder == holder && c.path == path));
                inner.push(WritePathClaim {
                    holder: holder.clone(),
                    session_id: self.session_id.clone(),
                    path,
                    mode,
                    claimed_at_ms: now,
                    expires_at_ms: expires_at,
                });
            }
        }
        Ok(WriteClaimGuard {
            registry: Arc::clone(self),
            holder,
        })
    }

    /// 声明单条写路径（[claim] 的便捷形态）
    pub fn claim_one(
        self: &Arc<Self>,
        holder: impl Into<String>,
        path: &str,
        mode: ClaimMode,
    ) -> Result<WriteClaimGuard, ToolError> {
        self.claim(holder, std::slice::from_ref(&path), mode)
    }

    /// 冲突预检（纯检查，不插入声明；供 M6 spawn preflight /
    /// `ValidateNonOverlappingWriteClaims` 消费）
    ///
    /// 排除同持有者；过期声明先清扫。命中返回 [WritePathConflict]（谁占用/何时），
    /// 未命中返回 None。
    pub fn check_conflict(&self, holder: &str, path: &Path) -> Option<WritePathConflict> {
        self.expire_stale();
        let path = strip_prefix_normalized(path);
        let inner = lock_inner(&self.inner);
        inner
            .iter()
            .find(|c| c.holder != holder && paths_overlap_normalized(&path, &c.path))
            .cloned()
            .map(|conflicting| WritePathConflict {
                requested_path: path,
                conflicting,
            })
    }

    /// 释放本持有者的全部声明（幂等；守卫 Drop 也会调用）
    pub fn release_holder(&self, holder: &str) {
        lock_inner(&self.inner).retain(|c| c.holder != holder);
    }

    /// 当前活跃声明快照（测试与 M6 调度器消费）
    pub fn active_claims(&self) -> Vec<WritePathClaim> {
        lock_inner(&self.inner).clone()
    }

    /// 清扫全部过期声明（按系统当前时间），返回清扫条数
    pub fn expire_stale(&self) -> usize {
        self.expire_stale_at(epoch_millis(Some(SystemTime::now())))
    }

    /// 按指定时刻清扫过期声明（显式时钟便于测试与调度器注入），返回清扫条数
    pub fn expire_stale_at(&self, now_ms: i64) -> usize {
        let mut inner = lock_inner(&self.inner);
        let before = inner.len();
        inner.retain(|c| c.expires_at_ms > now_ms);
        before - inner.len()
    }

    /// 注册表所属会话标识（调试与审计用）
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

/// 写路径声明校验纯函数（M3 任务卡内容 1：校验）
///
/// - 拒绝 glob（`* ? [`——声明必须是确定性路径，通配符无法做互斥记账）；
/// - 复用 `resolve_workspace_path`：`..` 越界拒绝、symlink 解析后比较、
///   工作区外拒绝、Windows 大小写折叠由比较层承担；
/// - 返回规范化绝对路径（`\\?\` 前缀已剥离），供注册表记账与 Overlaps 比较。
pub fn validate_write_path(workspace_root: &Path, input: &str) -> Result<PathBuf, ToolError> {
    if input.chars().any(|c| matches!(c, '*' | '?' | '[')) {
        return Err(ToolError::invalid_input(format!(
            "声明路径不允许通配符（glob）：{input:?}"
        )));
    }
    resolve_workspace_path(workspace_root, input)
}

/// 工具执行期写路径互斥声明助手（写类工具接线入口）
///
/// - `ToolContext.write_claims` 未接线（None）→ 返回 Ok(None)，不强制互斥；
/// - 已接线 → 以 `write_claim_holder`（子代理 run id）或回退 `session_id`
///   为持有者声明；冲突返回 `tool.write_path_conflict`（谁占用/何时）。
pub(crate) fn claim_write_guard(
    ctx: &ToolContext,
    path_str: &str,
    mode: ClaimMode,
) -> Result<Option<WriteClaimGuard>, ToolError> {
    let Some(registry) = ctx.write_claims.as_ref() else {
        return Ok(None);
    };
    let holder = ctx
        .write_claim_holder
        .clone()
        .unwrap_or_else(|| ctx.session_id.clone());
    registry
        .claim(holder, std::slice::from_ref(&path_str), mode)
        .map(Some)
}

/// 工具执行期硬沙箱越权检查助手（T-D-08 写工具接线入口）
///
/// 挂接顺序：写工具执行前**先**本函数（越权拒绝 → `tool.write_not_allowed`），
/// **再** [claim_write_guard]（冲突拒绝 → `tool.write_path_conflict`）——
/// 白名单是"允许集"（权限沙箱）、互斥是"并发控制"，一先一后串行叠加；
/// 未接线（`write_claims = None`）或注册表未装配策略 → 放行（现状行为）。
pub(crate) fn check_write_allowance_for_ctx(
    ctx: &ToolContext,
    target: &Path,
) -> Result<(), WriteAllowanceError> {
    let Some(registry) = ctx.write_claims.as_ref() else {
        return Ok(());
    };
    let Some(policy) = registry.write_policy() else {
        return Ok(());
    };
    check_write_allowance(policy, target)
}

/// 锁读取助手：中毒恢复（A 模式，PE-07 T07.6：记录错误、取回内值继续，不 panic）
fn lock_inner(inner: &Mutex<Vec<WritePathClaim>>) -> std::sync::MutexGuard<'_, Vec<WritePathClaim>> {
    inner.lock().unwrap_or_else(|e| {
        tracing::error!("写路径注册表锁中毒，按恢复模式继续：{e}");
        e.into_inner()
    })
}

/// Overlaps 检测：路径前缀语义（组件级）
///
/// `a/b/c.txt` 与 `a/b/` 冲突、`a/b` 与 `a/b` 冲突（同路径双向命中），
/// `a/b` 与 `a/bc` 不冲突（组件边界）。比较基于 [normalize_for_compare]：
/// 统一分隔符 + Windows 小写 + 去尾部分隔符，跨平台确定性一致。
///
/// 可见性：T-ESC-02（脚本逃逸追踪判定面）——session-loop 判定器复用
/// 本语义做「声明路径 vs 监视事件路径」比对，按 REQ-逃逸追踪分析 §3.2
/// 对外公开（声明基准复用，语义单一来源不复制实现）。
pub fn paths_overlap_normalized(a: &Path, b: &Path) -> bool {
    let na = normalize_for_compare(a);
    let nb = normalize_for_compare(b);
    if na == nb {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    na.starts_with(&format!("{nb}{sep}")) || nb.starts_with(&format!("{na}{sep}"))
}

/// 白名单前缀判定（T-D-08 硬沙箱：目标是否落在允许前缀下）
///
/// 语义与 [paths_overlap_normalized] 同源（组件级前缀 + Windows 大小写折叠）：
/// `a/b/c.txt` 命中白名单 `a/b/`、`a/b` 与 `a/b` 双向命中，`a/b` 与 `a/bc`
/// 不误匹配（组件边界）。方向性：只判「目标在允许前缀内」单侧——
/// 白名单是允许集，允许项之间互不影响。
fn is_within_allowed(target: &Path, allowed: &Path) -> bool {
    let nt = normalize_for_compare(target);
    let na = normalize_for_compare(allowed);
    if nt == na {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    nt.starts_with(&format!("{na}{sep}"))
}

/// 归一化（用于 Overlaps 比较；与 tools/mod.rs 的内部归一化同语义）
fn normalize_for_compare(p: &Path) -> String {
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let mut s = p.to_string_lossy().replace(['/', '\\'], &sep);
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    if s.len() > 1 {
        s = s.trim_end_matches(std::path::MAIN_SEPARATOR).to_string();
    }
    s
}

/// 路径剥离 `\\?\` 前缀后再归一化比较（resolve_workspace_path 输出已剥离，
/// 防御性兜底：外部传入的绝对路径可能带 verbatim 前缀）
fn strip_prefix_normalized(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!("\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{create_mock_tool_context, ToolContext};
    use crate::definition::Tool;
    use crate::tools::fs::WriteFileTool;
    use conex_test_utils::TempWorkspace;
    use serde_json::json;
    use std::time::Duration;

    /// 测试用会话上下文：workspace_root 指向临时工作区
    fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        }
    }

    #[test]
    fn claim_and_release_roundtrip() {
        let ws = TempWorkspace::new("wp_roundtrip");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        assert!(reg.active_claims().is_empty());

        let guard = reg.claim_one("runA", "src/lib.rs", ClaimMode::Write).unwrap();
        assert_eq!(reg.active_claims().len(), 1);
        let claim = &reg.active_claims()[0];
        assert_eq!(claim.holder, "runA");
        assert_eq!(claim.session_id, "s1");
        assert_eq!(claim.mode, ClaimMode::Write);
        assert!(claim.path.is_absolute());
        assert_eq!(claim.path, ws.path().join("src/lib.rs"));
        assert!(claim.claimed_at_ms > 0);
        assert!(claim.expires_at_ms > claim.claimed_at_ms);

        drop(guard);
        assert!(reg.active_claims().is_empty(), "守卫 Drop 后声明必须释放");
    }

    #[test]
    fn release_holder_idempotent() {
        let ws = TempWorkspace::new("wp_release");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _g = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
        reg.release_holder("runA");
        assert!(reg.active_claims().is_empty());
        // 幂等：重复释放不报错
        reg.release_holder("runA");
        // 只释放指定持有者
        let _g2 = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
        let _g3 = reg.claim_one("runB", "b.txt", ClaimMode::Write).unwrap();
        reg.release_holder("runB");
        let holders: Vec<String> = reg.active_claims().iter().map(|c| c.holder.clone()).collect();
        assert_eq!(holders, ["runA".to_string()]);
    }

    #[test]
    fn overlaps_prefix_dir_vs_file_conflict() {
        let ws = TempWorkspace::new("wp_prefix");
        ws.write_file("a/b/c.txt", "x");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        // A 声明目录 a/b/，B 声明其下文件 → 冲突
        let _a = reg.claim_one("runA", "a/b", ClaimMode::Write).unwrap();
        let err = reg.claim_one("runB", "a/b/c.txt", ClaimMode::Write).unwrap_err();
        assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
        assert!(err.to_string().contains("runA"), "冲突信息必须含占用者");
        assert!(err.to_string().contains("write"), "冲突信息必须含模式");
        assert!(err.to_string().contains("有效期至"), "冲突信息必须含时间");
        drop(_a);
        // 反向：A 声明文件，B 声明其父目录 → 同样冲突
        let _a = reg.claim_one("runA", "a/b/c.txt", ClaimMode::Write).unwrap();
        let err = reg.claim_one("runB", "a/b", ClaimMode::Write).unwrap_err();
        assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
    }

    #[test]
    fn overlaps_same_path_conflict() {
        let ws = TempWorkspace::new("wp_same");
        ws.write_file("x.txt", "x");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _a = reg.claim_one("runA", "x.txt", ClaimMode::Delete).unwrap();
        let err = reg.claim_one("runB", "x.txt", ClaimMode::Write).unwrap_err();
        assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
    }

    #[test]
    fn overlaps_no_conflict_siblings_and_component_boundary() {
        let ws = TempWorkspace::new("wp_siblings");
        ws.write_file("a/x.txt", "x");
        ws.write_file("a/y.txt", "y");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        // 兄弟文件互不冲突
        let _a = reg.claim_one("runA", "a/x.txt", ClaimMode::Write).unwrap();
        reg.claim_one("runB", "a/y.txt", ClaimMode::Write).unwrap();
        // 组件边界：a/b 与 a/bc 不冲突（前缀必须在组件边界）
        reg.claim_one("runB", "a/bc.txt", ClaimMode::Write).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn overlaps_case_insensitive_on_windows() {
        let ws = TempWorkspace::new("wp_case");
        ws.write_file("Src/File.txt", "x");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _a = reg.claim_one("runA", "src/file.txt", ClaimMode::Write).unwrap();
        let err = reg.claim_one("runB", "SRC/FILE.TXT", ClaimMode::Write).unwrap_err();
        assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT, "Windows 语义大小写折叠");
    }

    #[test]
    fn same_holder_reclaim_and_extension_allowed() {
        let ws = TempWorkspace::new("wp_self");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _a = reg.claim_one("runA", "src", ClaimMode::Write).unwrap();
        // 同持有者声明自身路径内的文件：不冲突（子代理可写自己声明范围内）
        reg.claim_one("runA", "src/lib.rs", ClaimMode::Write).unwrap();
        // 同持有者重复声明同路径：去重续期（只留一条）
        let g = reg.claim_one("runA", "src", ClaimMode::Write).unwrap();
        let claims = reg.active_claims();
        let same: Vec<_> = claims
            .iter()
            .filter(|c| c.holder == "runA" && c.path == ws.path().join("src"))
            .collect();
        assert_eq!(same.len(), 1, "同持有者同路径重复声明应去重");
        drop(g);
    }

    #[test]
    fn expired_claim_released_automatically() {
        let ws = TempWorkspace::new("wp_expire");
        let reg = Arc::new(WritePathRegistry::with_ttl("s1", ws.path(), 100));
        let _a = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
        let err = reg.claim_one("runB", "a.txt", ClaimMode::Write).unwrap_err();
        assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT, "未到期必须冲突");
        // 显式时钟推进：到期清扫（不依赖真实 sleep）
        let now = epoch_millis(Some(SystemTime::now()));
        let swept = reg.expire_stale_at(now + 1_000);
        assert_eq!(swept, 1, "过期声明必须被清扫");
        reg.claim_one("runB", "a.txt", ClaimMode::Write).unwrap();
    }

    #[test]
    fn expired_claim_does_not_block_new_claim_lazily() {
        let ws = TempWorkspace::new("wp_expire_lazy");
        let reg = Arc::new(WritePathRegistry::with_ttl("s1", ws.path(), 80));
        let _a = reg.claim_one("runA", "a.txt", ClaimMode::Write).unwrap();
        // 真实时间流逝（短 TTL）：claim 内部先清扫过期声明再判冲突
        std::thread::sleep(Duration::from_millis(150));
        reg.claim_one("runB", "a.txt", ClaimMode::Write).unwrap();
    }

    #[test]
    fn glob_and_workspace_escape_rejected() {
        let ws = TempWorkspace::new("wp_validate");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        // glob 拒绝
        let err = reg.claim_one("runA", "src/*.rs", ClaimMode::Write).unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("通配符"));
        // 工作区外绝对路径拒绝
        let outside = std::env::temp_dir().join("wp_outside_target.txt");
        let err = reg
            .claim_one("runA", &outside.display().to_string(), ClaimMode::Write)
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        // `..` 越界拒绝
        let err = reg.claim_one("runA", "../escape.txt", ClaimMode::Write).unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        // 不存在的目标允许声明（写新文件场景）
        reg.claim_one("runA", "new/dir/fresh.txt", ClaimMode::Write).unwrap();
    }

    #[test]
    fn check_conflict_reports_structured_info() {
        let ws = TempWorkspace::new("wp_preflight");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _a = reg.claim_one("runA", "docs", ClaimMode::Write).unwrap();
        let conflict = reg
            .check_conflict("runB", &ws.path().join("docs/readme.md"))
            .expect("preflight 必须命中冲突");
        assert_eq!(conflict.conflicting.holder, "runA");
        assert_eq!(conflict.requested_path, ws.path().join("docs/readme.md"));
        assert!(conflict.conflicting.expires_at_ms > 0);
        // 同持有者预检不命中
        assert!(reg.check_conflict("runA", &ws.path().join("docs/readme.md")).is_none());
    }

    #[tokio::test]
    async fn concurrent_two_holders_same_file_one_rejected() {
        // I4-M3 验收：并发两子代理同文件冲突——同一时刻只有一方可声明
        let ws = TempWorkspace::new("wp_concurrent");
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let reg_a = Arc::clone(&reg);
        let reg_b = Arc::clone(&reg);
        let t1 = tokio::spawn(async move {
            // 子代理 A 声明并持有 100ms（模拟写文件过程）
            let guard = reg_a.claim_one("runA", "shared.txt", ClaimMode::Write).unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(guard);
            true
        });
        let t2 = tokio::spawn(async move {
            // 子代理 B 稍后尝试声明同一文件 → 必须被拒绝
            tokio::time::sleep(Duration::from_millis(20)).await;
            reg_b.claim_one("runB", "shared.txt", ClaimMode::Write).is_err()
        });
        let (r1, r2) = tokio::join!(t1, t2);
        assert!(r1.unwrap(), "A 应成功完成");
        assert!(r2.unwrap(), "并发同路径声明必须被拒绝");
    }

    #[tokio::test]
    async fn unwired_context_no_enforcement() {
        // 未接线（write_claims = None）：写工具保持现状行为，不强制互斥
        let ws = TempWorkspace::new("wp_unwired");
        let tool = WriteFileTool::new();
        tool.execute(&mock_ctx(&ws), json!({ "path": "a.txt", "content": "hi" }))
            .await
            .unwrap();
        assert_eq!(ws.read_file("a.txt"), "hi");
    }

    #[tokio::test]
    async fn write_file_rejects_conflicting_holder() {
        // I4-M3 验收：写工具执行前检查 registry——冲突 → 拒绝执行（谁占用/何时）
        let ws = TempWorkspace::new("wp_tool_conflict");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        // 子代理 A 长期声明 src/（run_subagent write_paths 语义）
        let _a_guard = registry.claim_one("runA", "src", ClaimMode::Write).unwrap();

        // 子代理 B 的执行上下文：同注册表、不同持有者
        let ctx_b = ToolContext {
            workspace_root: ws.path().clone(),
            write_claims: Some(Arc::clone(&registry)),
            write_claim_holder: Some("runB".to_string()),
            explore_docs_quota: None,
            ..create_mock_tool_context()
        };
        let tool = WriteFileTool::new();
        let err = tool
            .execute(&ctx_b, json!({ "path": "src/lib.rs", "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
        assert!(err.to_string().contains("runA"), "错误必须说明谁占用");
        assert!(!ws.path().join("src/lib.rs").exists(), "冲突拒绝时不得写盘");

        // 释放后同调用重试成功
        drop(_a_guard);
        tool.execute(&ctx_b, json!({ "path": "src/lib.rs", "content": "x" }))
            .await
            .unwrap();
        assert_eq!(ws.read_file("src/lib.rs"), "x");
        // 工具执行期声明随执行结束释放（不残留记账）
        assert!(registry.active_claims().is_empty());
    }

    #[tokio::test]
    async fn write_file_own_holder_allowed_within_declared_paths() {
        // 同持有者（子代理自身）在其声明范围内写入：允许
        let ws = TempWorkspace::new("wp_self_write");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _a_guard = registry.claim_one("runA", "src", ClaimMode::Write).unwrap();
        let ctx_a = ToolContext {
            workspace_root: ws.path().clone(),
            write_claims: Some(Arc::clone(&registry)),
            write_claim_holder: Some("runA".to_string()),
            explore_docs_quota: None,
            ..create_mock_tool_context()
        };
        let tool = WriteFileTool::new();
        tool.execute(&ctx_a, json!({ "path": "src/main.rs", "content": "fn main() {}" }))
            .await
            .unwrap();
        assert!(ws.path().join("src/main.rs").is_file());
    }

    // ===== T-D-08：硬沙箱（WritePathPolicy + check_write_allowance）=====

    /// Unrestricted（不限制路径）→ 任何目标放行
    #[test]
    fn allowance_unrestricted_allows_everything() {
        let policy = WritePathPolicy::Unrestricted;
        assert!(check_write_allowance(&policy, Path::new("C:/any/where.txt")).is_ok());
        assert!(check_write_allowance(&policy, Path::new("相对/路径.txt")).is_ok());
    }

    /// Allowed 命中/未命中：docs/a.md 放行、src/main.rs 拒绝（tool.write_not_allowed，
    /// 载荷含目标路径与允许范围提示）
    #[test]
    fn allowance_matches_prefix_and_rejects_outside() {
        let ws = TempWorkspace::new("wp_allowance");
        let policy = WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap();
        // 命中：白名单前缀 docs/ 下的文件与目录自身均放行
        assert!(check_write_allowance(&policy, &ws.path().join("docs/a.md")).is_ok());
        assert!(check_write_allowance(&policy, &ws.path().join("docs")).is_ok());
        assert!(check_write_allowance(&policy, &ws.path().join("docs/sub/nested.md")).is_ok());
        // 未命中：src/main.rs 不在允许范围 → tool.write_not_allowed
        let err = check_write_allowance(&policy, &ws.path().join("src/main.rs")).unwrap_err();
        assert_eq!(err.requested_path, ws.path().join("src/main.rs"));
        assert!(!err.allowed.is_empty(), "载荷必须含允许范围提示");
        let tool_err = err.into_tool_error();
        assert_eq!(tool_err.code(), codes::TOOL_WRITE_NOT_ALLOWED);
        assert!(tool_err.to_string().contains("src/main.rs"), "消息须含目标路径");
        assert!(tool_err.to_string().contains("docs"), "消息须含允许范围");
        assert!(tool_err.to_string().contains("主 agent"), "消息须含申请指引");
    }

    /// 前缀边界：a/b 与 a/bc 不误匹配（组件边界）、a/b 与 a/b/c.txt 命中
    #[test]
    fn allowance_component_boundary_no_false_positive() {
        let ws = TempWorkspace::new("wp_allowance_boundary");
        let policy = WritePathPolicy::from_entries(ws.path(), vec!["a/b".to_string()]).unwrap();
        assert!(check_write_allowance(&policy, &ws.path().join("a/b")).is_ok());
        assert!(check_write_allowance(&policy, &ws.path().join("a/b/c.txt")).is_ok());
        assert!(check_write_allowance(&policy, &ws.path().join("a/bc")).is_err());
        assert!(check_write_allowance(&policy, &ws.path().join("a/bc.txt")).is_err());
        assert!(check_write_allowance(&policy, &ws.path().join("a/bc/d.txt")).is_err());
        let err = check_write_allowance(&policy, &ws.path().join("a/bc/d.txt")).unwrap_err();
        assert_eq!(
            err.into_tool_error().code(),
            codes::TOOL_WRITE_NOT_ALLOWED,
            "未命中必须返回 tool.write_not_allowed"
        );
    }

    /// Windows 语义：大小写折叠（复用 normalize_for_compare）
    #[cfg(windows)]
    #[test]
    fn allowance_case_folding_on_windows() {
        let ws = TempWorkspace::new("wp_allowance_case");
        let policy =
            WritePathPolicy::from_entries(ws.path(), vec!["Src/File.TXT".to_string()]).unwrap();
        assert!(check_write_allowance(&policy, &ws.path().join("src/file.txt")).is_ok());
        assert!(check_write_allowance(&policy, &ws.path().join("SRC/FILE.TXT")).is_ok());
        assert!(check_write_allowance(&policy, &ws.path().join("src/other.md")).is_err());
    }

    /// 显式空允许集 = 全部拒绝（fail-closed 兜底）
    #[test]
    fn allowance_empty_whitelist_denies_all() {
        let policy = WritePathPolicy::Allowed(Vec::new());
        let err = check_write_allowance(&policy, Path::new("anything")).unwrap_err();
        assert!(err.allowed.is_empty());
        assert_eq!(err.into_tool_error().code(), codes::TOOL_WRITE_NOT_ALLOWED);
    }

    /// from_entries：空列表 → Unrestricted（REQ-D04 口径）；glob/越界条目拒绝；
    /// 相对条目解析为规范化绝对路径
    #[test]
    fn from_entries_empty_unrestricted_and_bad_entries_rejected() {
        let ws = TempWorkspace::new("wp_from_entries");
        assert_eq!(
            WritePathPolicy::from_entries(ws.path(), Vec::new()).unwrap(),
            WritePathPolicy::Unrestricted,
            "空条目列表 = 不做路径限制（REQ-D04）"
        );
        let err = WritePathPolicy::from_entries(ws.path(), vec!["docs/*.md".to_string()])
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input", "glob 条目必须拒绝");
        let err = WritePathPolicy::from_entries(ws.path(), vec!["../outside".to_string()])
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape", "越界条目必须拒绝");
        let policy = WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap();
        let WritePathPolicy::Allowed(paths) = policy else {
            panic!("非空条目必须为 Allowed");
        };
        assert_eq!(paths, vec![ws.path().join("docs")], "条目必须解析为绝对路径");
    }

    /// 注册表策略载体：with_write_policy 装配 / 缺省不装配
    #[test]
    fn registry_policy_roundtrip() {
        let ws = TempWorkspace::new("wp_policy_reg");
        let policy = WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap();
        let reg = Arc::new(WritePathRegistry::new("s1", ws.path()).with_write_policy(policy));
        match reg.write_policy() {
            Some(WritePathPolicy::Allowed(paths)) => {
                assert_eq!(paths, &vec![ws.path().join("docs")]);
            }
            other => panic!("装配后必须为 Allowed，实际 {other:?}"),
        }
        let plain = Arc::new(WritePathRegistry::new("s2", ws.path()));
        assert!(plain.write_policy().is_none(), "缺省注册表不装配策略");
    }

    /// 工具级硬沙箱：Allowed(["docs/"]) 下写 src/main.rs → tool.write_not_allowed、
    /// 写 docs/a.md 放行（权限层生效，与 Prompt 无关）
    #[tokio::test]
    async fn write_file_respects_hard_sandbox() {
        let ws = TempWorkspace::new("wp_sandbox");
        let registry = Arc::new(
            WritePathRegistry::new("s1", ws.path()).with_write_policy(
                WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap(),
            ),
        );
        let ctx = ToolContext {
            workspace_root: ws.path().clone(),
            write_claims: Some(Arc::clone(&registry)),
            write_claim_holder: Some("runA".to_string()),
            explore_docs_quota: None,
            ..create_mock_tool_context()
        };
        let tool = WriteFileTool::new();
        // 越权写：src/main.rs 不在允许集 → tool.write_not_allowed，不得写盘
        let err = tool
            .execute(&ctx, json!({ "path": "src/main.rs", "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_WRITE_NOT_ALLOWED);
        assert!(!ws.path().join("src/main.rs").exists(), "越权拒绝时不得写盘");
        // 白名单内写 docs/a.md → 放行
        tool.execute(&ctx, json!({ "path": "docs/a.md", "content": "x" }))
            .await
            .unwrap();
        assert_eq!(ws.read_file("docs/a.md"), "x");
    }

    /// 两机制串行叠加：白名单放行但被占用 → 仍 tool.write_path_conflict
    /// （先越权拒绝、再冲突拒绝；错误码必须区分——越权 vs 冲突）
    #[tokio::test]
    async fn sandbox_and_conflict_serial_stack() {
        let ws = TempWorkspace::new("wp_sandbox_serial");
        let registry = Arc::new(
            WritePathRegistry::new("s1", ws.path()).with_write_policy(
                WritePathPolicy::from_entries(ws.path(), vec!["docs/".to_string()]).unwrap(),
            ),
        );
        // 子代理 A 长期声明 docs/（白名单内，占用者 B 的互斥面）
        let _a_guard = registry.claim_one("runA", "docs", ClaimMode::Write).unwrap();
        let ctx_b = ToolContext {
            workspace_root: ws.path().clone(),
            write_claims: Some(Arc::clone(&registry)),
            write_claim_holder: Some("runB".to_string()),
            explore_docs_quota: None,
            ..create_mock_tool_context()
        };
        let tool = WriteFileTool::new();
        // 越权优先：src/main.rs 不在允许集 → tool.write_not_allowed（不落互斥检查）
        let err = tool
            .execute(&ctx_b, json!({ "path": "src/main.rs", "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_WRITE_NOT_ALLOWED);
        // 白名单放行但被占用 → tool.write_path_conflict（互斥拒绝，机制串行生效）
        let err = tool
            .execute(&ctx_b, json!({ "path": "docs/a.md", "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT);
        assert!(err.to_string().contains("runA"));
        assert!(!ws.path().join("docs/a.md").exists(), "冲突拒绝时不得写盘");
        // 占用释放后：白名单内放行
        drop(_a_guard);
        tool.execute(&ctx_b, json!({ "path": "docs/a.md", "content": "x" }))
            .await
            .unwrap();
        assert_eq!(ws.read_file("docs/a.md"), "x");
    }

    /// 未装配策略（未接线 / 注册表无策略）：写工具保持现状行为（回归）
    #[tokio::test]
    async fn unwired_policy_context_no_enforcement() {
        let ws = TempWorkspace::new("wp_policy_unwired");
        let tool = WriteFileTool::new();
        tool.execute(&mock_ctx(&ws), json!({ "path": "anywhere.txt", "content": "hi" }))
            .await
            .unwrap();
        assert_eq!(ws.read_file("anywhere.txt"), "hi");
        // 注册表接线但未装配策略：同样不强制
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let ctx = ToolContext {
            workspace_root: ws.path().clone(),
            write_claims: Some(registry),
            write_claim_holder: Some("runA".to_string()),
            explore_docs_quota: None,
            ..create_mock_tool_context()
        };
        tool.execute(&ctx, json!({ "path": "out.txt", "content": "hi" }))
            .await
            .unwrap();
        assert_eq!(ws.read_file("out.txt"), "hi");
    }
}
