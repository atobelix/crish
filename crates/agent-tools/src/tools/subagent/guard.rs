//! 递归守卫域（SR-06a 拆分）：深度 / 嵌套 / 兄弟 / 并发判定 + 祖先链死锁检测。

use conex_types::error::codes;

// ── 递归守卫（RecursionGuard）────────────────────────────────────

/// 递归守卫配置（对齐 RecursionGuardConfig，shared-types/subagent.ts:23）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecursionGuardConfig {
    /// 最大递归深度（沿 parent_id 链数深度）
    pub max_depth: usize,
    /// 最大兄弟并发数（同父 run 下未终态子代理数）
    pub max_siblings: usize,
    /// 最大全局并发数（全会话未终态子代理 run 数，预算只算子代理）
    pub max_concurrent: usize,
}

/// 唯一权威默认值（对齐 DEFAULT_RECURSION_GUARD，shared-types/subagent.ts:36）
///
/// maxDepth=1 是「仅主 Agent 可派发」的最终防线（用户裁决，REQ-D08 kill 项）：
/// 主 Agent（深度 0）可派发直接子代理（新会话深度 1）；子 Agent 内再派发
/// （新会话深度 ≥ 2）由守卫层返回 [RecursionGuardRejection::NestingDenied]。
/// maxSiblings=16 与 maxConcurrent=16 相等（2026-08-11 用户裁决 12→16：
/// 所有子代理同父=主 agent，maxSiblings=5 时「同时跑 16 个」在第 6 个即被
/// 拒，必须同步扩额——同父上限 = 全局上限，原「兄弟并发应小于全局并发」
/// 注释口径相应废止；flow_graph 预算判定引用本默认值自动跟随）。
pub const DEFAULT_RECURSION_GUARD: RecursionGuardConfig = RecursionGuardConfig {
    max_depth: 1,
    max_siblings: 16,
    max_concurrent: 16,
};

/// 守卫判定输入快照（由引擎侧采集：深度沿 parent_id 链数、
/// 兄弟/并发按未终态子代理记账——M6 并发预算同口径）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecursionGuardSnapshot {
    /// 新会话沿 parent_id 链的深度（主会话的子代理 = 1，沿链递增；
    /// T-D-02：maxDepth=1 下新会话深度 > 1 即嵌套违规，发起者是子 Agent）
    pub depth: usize,
    /// 父 run 下未终态的子代理数（兄弟并发）
    pub active_siblings: usize,
    /// 全会话未终态的子代理 run 数（全局并发）
    pub active_concurrent: usize,
}

/// 递归守卫拒绝原因（结构化错误载荷，含「减少并发/合并任务」指引）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecursionGuardRejection {
    /// 递归深度超限（maxDepth；01 Top 6：超深快速失败而非排队）
    DepthExceeded { current: usize, max: usize },
    /// 嵌套禁止（T-D-02，用户裁决）：maxDepth=1 且新会话深度 > 1——
    /// 发起者本身是子 Agent，无派发能力；错误文案带编排指引
    /// （「所有子 Agent 由主 Agent 分配」）
    NestingDenied { current: usize, max: usize },
    /// 兄弟并发超限（maxSiblings）
    SiblingsExceeded { current: usize, max: usize },
    /// 全局并发超限（maxConcurrent）
    ConcurrentExceeded { current: usize, max: usize },
    /// 祖先链死锁（DeadlockCheckInput：目标会话已在祖先链上）
    DeadlockDetected { target_session_id: String },
}

impl RecursionGuardRejection {
    /// 错误码（错误码注册表 subagent 域 4 正式码，conex-types：深度超限、
    /// 死锁与嵌套禁止为专用码；兄弟/并发超限复用最接近的 subagent 域
    /// 永久码 depth_exceeded，语义差异由 message 显式承载）
    pub fn code(&self) -> &'static str {
        match self {
            Self::DepthExceeded { .. }
            | Self::SiblingsExceeded { .. }
            | Self::ConcurrentExceeded { .. } => codes::SUBAGENT_DEPTH_EXCEEDED,
            Self::NestingDenied { .. } => codes::SUBAGENT_NESTING_DENIED,
            Self::DeadlockDetected { .. } => codes::SUBAGENT_DEADLOCK_DETECTED,
        }
    }

    /// 结构化错误文案（含指引：减少递归层级 / 上报主 Agent 请求派发 /
    /// 减少并发合并任务 / 终止循环链）
    pub fn message(&self) -> String {
        match self {
            Self::DepthExceeded { current, max } => format!(
                "递归深度超限（maxDepth={max}，当前 {current}）：请减少递归层级，\
                 或把任务拆给同级子代理并行处理"
            ),
            Self::NestingDenied { .. } => {
                "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。\
                 请通过消息/上报向主 Agent 请求派发。"
                    .to_string()
            }
            Self::SiblingsExceeded { current, max } => format!(
                "兄弟并发超限（maxSiblings={max}，当前 {current}）：请减少并发/合并任务，\
                 等待部分子代理完成后重试"
            ),
            Self::ConcurrentExceeded { current, max } => format!(
                "全局并发超限（maxConcurrent={max}，当前 {current}）：请减少并发/合并任务，\
                 等待部分子代理完成后重试"
            ),
            Self::DeadlockDetected { target_session_id } => {
                format!("子代理死锁：目标会话已在祖先链上（{target_session_id}）：请终止循环调用链")
            }
        }
    }
}

/// 递归守卫检查（纯函数）：嵌套禁止 → 深度 → 兄弟 → 并发依次判定
/// （01 Top 6：深层无容量即失败防死锁），全部通过返回 Ok。
///
/// 语义裁决（T-D-01/02 合并，任务书内部张力按此收敛）：
/// 快照 depth = **新会话（spawn 结果）沿 parent_id 链的深度**（主 Agent 的
/// 直接子代理 = 1）。maxDepth=1（仅主 Agent 可派发）下：
/// - 新会话深度 > 1（发起者是子 Agent）→ [RecursionGuardRejection::NestingDenied]
///   （专用变体 + 专用错误码 subagent.nesting_denied，文案带「所有子 Agent
///   由主 Agent 分配」指引）——T-D-02 语义；
/// - 新会话深度 = 1（主 Agent 派发直接子代理，含 flow_graph 流程节点快照
///   depth 恒为 1，`flow_graph.rs:974-983`）→ 恒通过嵌套判定——T-D-01
///   item 6「流程快照不受 maxDepth=1 影响」据此成立，flow_scheduler 回归全绿；
/// - 其它 maxDepth 配置（>1）下深度超限仍返回 [RecursionGuardRejection::DepthExceeded]
///   ——「DepthExceeded 语义保留」据此成立（max=1 时 depth>1 即嵌套违规，
///   NestingDenied 优先命中，二者不共存）。
pub fn check_recursion_guard(
    snapshot: RecursionGuardSnapshot,
    config: RecursionGuardConfig,
) -> Result<(), RecursionGuardRejection> {
    if config.max_depth == 1 && snapshot.depth > 1 {
        return Err(RecursionGuardRejection::NestingDenied {
            current: snapshot.depth,
            max: config.max_depth,
        });
    }
    if snapshot.depth > config.max_depth {
        return Err(RecursionGuardRejection::DepthExceeded {
            current: snapshot.depth,
            max: config.max_depth,
        });
    }
    if snapshot.active_siblings > config.max_siblings {
        return Err(RecursionGuardRejection::SiblingsExceeded {
            current: snapshot.active_siblings,
            max: config.max_siblings,
        });
    }
    if snapshot.active_concurrent > config.max_concurrent {
        return Err(RecursionGuardRejection::ConcurrentExceeded {
            current: snapshot.active_concurrent,
            max: config.max_concurrent,
        });
    }
    Ok(())
}

/// 死锁检测输入（对齐 DeadlockCheckInput，shared-types/subagent.ts:75：
/// spawn 时 O(depth) 祖先链检查）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeadlockCheckInput {
    /// 目标会话 id（即将 spawn 出的新会话）
    pub target_session_id: String,
    /// 祖先会话 id 链（沿 parent_id 链，从父到根）
    pub ancestor_session_ids: Vec<String>,
}

/// 祖先链死锁检查：目标会话已在祖先链上 → 拒绝（防把祖先会话再 fork
/// 成子会话形成环）；复杂度 O(depth)。
pub fn check_ancestor_chain(input: &DeadlockCheckInput) -> Result<(), RecursionGuardRejection> {
    if input
        .ancestor_session_ids
        .contains(&input.target_session_id)
    {
        return Err(RecursionGuardRejection::DeadlockDetected {
            target_session_id: input.target_session_id.clone(),
        });
    }
    Ok(())
}
