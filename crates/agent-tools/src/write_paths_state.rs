//! 互斥状态机域（SR-06a-5 拆分 · 由 write_paths 门面 `#[path]` 接线）
//!
//! - **声明记账数据**：`ClaimMode` / `WritePathClaim` / `WritePathConflict` /
//!   `TOOL_WRITE_PATH_CONFLICT` / `DEFAULT_CLAIM_TTL_MS`（数据与常量随状态机
//!   域驻留，供门面 re-export 保持公开 API）；
//! - **注册表**：[WritePathRegistry]——claim 的冲突检测与插入在同一锁区间内
//!   原子完成（防 TOCTOU）、check_conflict / release_holder / TTL 清扫
//!   （expire_stale_at）、锁中毒恢复式处理（A 模式，不 panic）；
//! - **RAII 守卫**：[WriteClaimGuard]——Drop 时释放本持有者全部声明；
//! - **工具接线助手**：[claim_write_guard] / [check_write_allowance_for_ctx]
//!   （写类工具执行前先越权检查、再冲突声明，一先一后串行叠加）。
//! 诚实边界：仅结构拆分，互斥语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use super::write_paths_validate::{
    check_write_allowance, paths_overlap_normalized, validate_write_path, WriteAllowanceError,
    WritePathPolicy,
};
use super::TOOL_WRITE_PATH_CONFLICT;
use crate::context::ToolContext;
use crate::definition::ToolError;
use crate::tools::epoch_millis;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

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
fn lock_inner(
    inner: &Mutex<Vec<WritePathClaim>>,
) -> std::sync::MutexGuard<'_, Vec<WritePathClaim>> {
    inner.lock().unwrap_or_else(|e| {
        tracing::error!("写路径注册表锁中毒，按恢复模式继续：{e}");
        e.into_inner()
    })
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
