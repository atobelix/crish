//! run/run_approval.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。
use super::*;

/// core_approve_tool / core_deny_tool 返回（{ok, toolCallId, decision}）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResponse {
    pub ok: bool,
    pub tool_call_id: String,
    pub decision: &'static str,
}

// ── 审批门（ApprovalGate 实现）────────────────────────────────────

/// 待审批请求元信息（R1-04 REST 写面 [list_pending_approvals_impl] 数据源）
///
/// 生命周期与 [ApprovalGateImpl::pending] 的 oneshot 通道完全一致：
/// `request_approval` 登记、`resolve` 清除——「已请求未裁决」的运行时真源
/// （M6 C13 派生态的实时版本；run 终态移出活动注册表，天然满足「run 未
/// 终态」条件）。parameters 全量不下发（隐私红线，D6 §7.2），只记键名。
pub(crate) struct PendingRequestMeta {
    /// 工具名
    pub tool_name: String,
    /// 请求摘要
    pub summary: String,
    /// 工具工作目录
    pub cwd: String,
    /// 会话 id
    pub session_id: String,
    /// 请求方 run 归属（None = 主 agent run；与 approval-requested 同源）
    pub requester_run_id: Option<String>,
    /// 申请理由（子代理来源；None = 主 agent 请求）
    pub reason: Option<String>,
    /// 裁决者 wire 名（user / main-agent；与
    /// approval-requested.metadata.arbiter 同源）
    pub arbiter: String,
    /// 请求时刻（epoch ms；expiresAt = requestedAt + APPROVAL_TIMEOUT）
    pub requested_at_ms: u64,
    /// 参数键名列表（parameters 全量不下发，仅键名，M6 C13）
    pub param_keys: Vec<String>,
}

/// 审批门（B6.1：approval-requested 先发后等防死锁，01 §五.8）
///
/// - `request_approval`：广播 approval-requested（经缓冲事件桥，实时通道）
///   → 注册 oneshot 等待 → 超时返回 [ApprovalDecision::Expired]；
/// - `resolve`：core_approve_tool / core_deny_tool 入口——**先校验
///   tool_call_id 在待审批集合**（AA-05 I-02 / PE-12 T12.3：不匹配返回
///   NotFound，杜绝伪造审计事件），再送决策并恢复 run 状态机
///   （awaiting-approval → running）。
pub type DeadlockDetectorFn = Box<dyn Fn(&str) -> bool + Send + Sync>;

pub(crate) struct ApprovalGateImpl {
    /// run 标识
    pub(crate) run_id: String,
    /// 会话标识
    pub(crate) session_id: String,
    /// 父 run 归属（T-D-14 权限传递层）：None = 主 agent run / 无父 run
    /// （审批裁决者 = 用户，现状不变）；Some = 子代理 run 的父 run id
    /// （审批请求路由给主 agent 裁决，可经死锁防护转用户兜底）
    pub(crate) parent_run_id: Option<String>,
    /// 死锁检测器（T-D-14 开放问题 6.4，时序评审见 approval_router.rs 模块
    /// 头注）：判定「裁决者（主 agent）正在 wait 本 run（子代理）」——
    /// 命中时路由转用户打破 120s 空等；None = 未接线（退化纯超时兜底，
    /// 行为与现状一致）。真实 wait 态信号源 = orchestrator 子代理跟踪器
    /// （wait_subagents 工具执行期间标记），由 F11 T-D-13 引擎接线注入。
    pub(crate) deadlock_detector: Option<DeadlockDetectorFn>,
    /// 广播 approval-requested（先发后等；信封 sequence=None 实时预览，
    /// 收口流携带持久化序列）
    pub(crate) broadcast: Box<dyn Fn(AgentEvent) + Send + Sync>,
    /// 待审批集合：tool_call_id → 决策通道（I-02 校验依据）
    pub(crate) pending:
        std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<ApprovalDecision>>>,
    /// 待审批请求元信息（R1-04：与 [Self::pending] 同生命周期，见
    /// [PendingRequestMeta]——request 登记、resolve 清除）
    pub(crate) pending_meta: std::sync::Mutex<HashMap<String, PendingRequestMeta>>,
    /// run 状态机联动（awaiting-approval 中间态落库）
    pub(crate) handle: Arc<tokio::sync::Mutex<RunHandle>>,
    /// store（状态机转移落库）
    pub(crate) store: Arc<dyn Store>,
    /// 工具执行工作目录（PermissionRequest.cwd）
    pub(crate) cwd: Option<String>,
    /// 审批等待超时（生产 = [APPROVAL_TIMEOUT] 120s；测试注入短超时验证
    /// 过期收场——P1 审批竞态红线：超时 Expired 后待审批集合清除）
    approval_timeout: Duration,
}

impl ApprovalGateImpl {
    /// 新建审批门
    pub(crate) fn new(
        run_id: String,
        session_id: String,
        parent_run_id: Option<String>,
        broadcast: Box<dyn Fn(AgentEvent) + Send + Sync>,
        handle: Arc<tokio::sync::Mutex<RunHandle>>,
        store: Arc<dyn Store>,
        cwd: Option<String>,
    ) -> Self {
        Self {
            run_id,
            session_id,
            parent_run_id,
            deadlock_detector: None,
            broadcast,
            pending: std::sync::Mutex::new(HashMap::new()),
            pending_meta: std::sync::Mutex::new(HashMap::new()),
            handle,
            store,
            cwd,
            approval_timeout: APPROVAL_TIMEOUT,
        }
    }

    /// 覆盖审批等待超时（测试注入短超时验证过期收场；生产保持
    /// [APPROVAL_TIMEOUT] 120s 兜底）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_approval_timeout(mut self, timeout: Duration) -> Self {
        self.approval_timeout = timeout;
        self
    }

    /// 注入死锁检测器（T-D-14 开放问题 6.4）：判定「裁决者 run 正在 wait
    /// 本 run（子代理）」——命中时审批请求路由转用户（UI 裁决面不受主
    /// agent wait 状态阻塞）；不注入 = 纯超时兜底（120s Expired，子代理
    /// run 不中断，行为与现状一致）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_deadlock_detector(
        mut self,
        detector: Box<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Self {
        self.deadlock_detector = Some(detector);
        self
    }

    /// 解析审批（core_approve_tool / core_deny_tool 入口）
    ///
    /// I-02（T12.3）：tool_call_id 必须在待审批集合，不匹配返回
    /// NotFound（杜绝伪造 approval-resolved 审计事件 / 提前审批）。
    /// 文案含 `pending` 关键字：`DeviceErrorCode::from_core_error` 对
    /// 审批域 NotFound 升级为 cmd.approval_mismatch（F2 §11.2 冲突信号，
    /// 移动端据此收敛「已被其他设备处理 / 已过期」）。
    pub(crate) async fn resolve(
        &self,
        tool_call_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), CoreError> {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_call_id)
            .ok_or_else(|| {
                CoreError::NotFound(format!(
                    "tool_call_id not in pending approvals（run={}）：{tool_call_id}",
                    self.run_id
                ))
            })?;
        // R1-04：与决策通道同步清除待办元信息（list_pending_approvals
        // 不再返回已裁决条目）
        self.pending_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_call_id);
        let _ = sender.send(decision);
        // 状态机恢复：awaiting-approval → running（B4.1 审批恢复路径）
        let mut handle = self.handle.lock().await;
        if let Err(error) = handle.resolve_approval(self.store.as_ref()).await {
            tracing::warn!(
                target: "approval",
                run_id = %self.run_id,
                error = %error,
                "resolve_approval 失败（审批决策已送达，状态机兜底）"
            );
        }
        Ok(())
    }

    /// 待审批集合是否包含指定工具调用（R1-04：run_id 缺失时按待审批
    /// 集合反查——M6 C11「runId 缺失容错」）
    pub(crate) fn contains_pending(&self, tool_call_id: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(tool_call_id)
    }

    /// 待审批请求元信息快照（R1-04：[list_pending_approvals_impl]
    /// 数据源；返回 (tool_call_id, meta) 列表，与 pending 通道同生命周期）
    pub(crate) fn pending_requests(&self) -> Vec<(String, PendingRequestMeta)> {
        self.pending_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(tool_call_id, meta)| {
                (
                    tool_call_id.clone(),
                    PendingRequestMeta {
                        tool_name: meta.tool_name.clone(),
                        summary: meta.summary.clone(),
                        cwd: meta.cwd.clone(),
                        session_id: meta.session_id.clone(),
                        requester_run_id: meta.requester_run_id.clone(),
                        reason: meta.reason.clone(),
                        arbiter: meta.arbiter.clone(),
                        requested_at_ms: meta.requested_at_ms,
                        param_keys: meta.param_keys.clone(),
                    },
                )
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl ApprovalGate for ApprovalGateImpl {
    async fn request_approval(
        &self,
        call_id: &str,
        tool_name: &str,
        args: &serde_json::Value,
        requester: Option<&ApprovalRequester>,
    ) -> ApprovalDecision {
        // 1. 来源分类 + 裁决者路由（T-D-14 权限传递层）：子代理来源 →
        //    主 agent 裁决（默认）；主 agent 来源 → 用户（现状不变）；
        //    死锁检测命中（主 agent 正在 wait 该子代理）→ 转用户兜底。
        let source = classify_source(&self.run_id, self.parent_run_id.as_deref());
        let arbiter = self
            .deadlock_detector
            .as_ref()
            .map(|detector| route_approval_guarded(&source, detector(&self.run_id)))
            .unwrap_or_else(|| route_approval(&source));
        tracing::info!(
            target: "approval",
            run_id = %self.run_id,
            parent_run_id = ?self.parent_run_id,
            arbiter = ?arbiter,
            requester_run_id = requester.map(|r| r.run_id.as_str()),
            "审批请求（权限传递层裁决者路由）"
        );

        // 2. 广播 approval-requested（防死锁：先发出再等待，01 §五.8；
        //    实时通道 sequence=None 预览，持久化副本随收口流落库）
        let request = PermissionRequest {
            id: format!("approval-{call_id}"),
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone().unwrap_or_default(),
            tool_call_id: call_id.to_string(),
            tool_name: tool_name.to_string(),
            parameters: args.clone(),
            summary: format!("call {tool_name}"),
            tool_metadata: Default::default(),
            // T-D-14：路由分支可观测落点——子代理来源路由给主 agent 时
            // metadata.arbiter=main-agent（前端据此渲染主 agent 裁决面）；
            // 用户裁决面 None（主 agent run 现状载荷字节不变）
            metadata: arbiter_metadata(arbiter),
            // T-D-14：请求方身份（子代理 run id + 申请理由）随载荷广播
            // 与落库（None = 主 agent run，向后兼容）
            requester_run_id: requester.map(|r| r.run_id.clone()),
            reason: requester.and_then(|r| r.reason.clone()),
        };
        (self.broadcast)(AgentEvent::ApprovalRequested {
            session_id: self.session_id.clone(),
            request,
            timestamp: crate::engine::now_iso_utc(),
        });

        // 2. 状态机联动：running → awaiting-approval（落库，中间态可观测）
        {
            let mut handle = self.handle.lock().await;
            if let Err(error) = handle.request_approval(self.store.as_ref()).await {
                tracing::warn!(
                    target: "approval",
                    run_id = %self.run_id,
                    error = %error,
                    "request_approval 状态机转移失败（审批仍可等待）"
                );
            }
        }

        // 3. 注册等待通道（先发后等，防死锁）
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if pending.contains_key(call_id) {
                // 同 call 重复审批请求：覆盖旧通道（旧等待超时自然收口）
                let _ = pending.remove(call_id);
            }
            pending.insert(call_id.to_string(), tx);
        }
        // R1-04：同步登记待办元信息（list_pending_approvals 对账数据源；
        // 与 pending 通道同生命周期，resolve 时清除）。arbiter wire 名与
        // 上方广播的 metadata.arbiter 同源（main-agent / user）。
        {
            let mut meta = self.pending_meta.lock().unwrap_or_else(|e| e.into_inner());
            meta.insert(
                call_id.to_string(),
                PendingRequestMeta {
                    tool_name: tool_name.to_string(),
                    summary: format!("call {tool_name}"),
                    cwd: self.cwd.clone().unwrap_or_default(),
                    session_id: self.session_id.clone(),
                    requester_run_id: requester.map(|r| r.run_id.clone()),
                    reason: requester.and_then(|r| r.reason.clone()),
                    arbiter: match arbiter {
                        session_loop::approval_router::Arbiter::MainAgent => {
                            "main-agent".to_string()
                        }
                        session_loop::approval_router::Arbiter::User => "user".to_string(),
                    },
                    requested_at_ms: crate::server::now_ms(),
                    param_keys: args
                        .as_object()
                        .map(|map| map.keys().cloned().collect())
                        .unwrap_or_default(),
                },
            );
        }

        // 4. 等待决策（超时 → Expired；工具侧按非致命处理，01 §五.8）
        match tokio::time::timeout(self.approval_timeout, rx).await {
            Ok(Ok(decision)) => decision,
            Ok(Err(_)) | Err(_) => {
                // P1 审批竞态红线（主控裁决 4 / 详案 P1 §5.1）：超时 →
                // Expired 权威收场后**同步清除待审批集合与元信息**——迟到
                // 的 approve/deny 对已过期请求一律 NotFound（杜绝「过期后
                // 补批」伪造 approval-resolved(approved) 审计事件；R1-04
                // 对账面也不再把已过期条目列为待审批）
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(call_id);
                self.pending_meta
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(call_id);
                ApprovalDecision::Expired
            }
        }
    }
}

// ── 命令：core_approve_tool / core_deny_tool ──────────────────────

/// 批准工具调用（03 §3.2 A 组：{ok, toolCallId, decision:'approved'}）
///
/// I-02（PE-12 T12.3）：tool_call_id 必须在待审批集合（ApprovalGateImpl
/// 校验）；审批决策送达后落地 approval-resolved（持久化，03 §5.1-10
/// 硬依赖）并实时发射（前端关闭审批卡片）。
#[tauri::command]
pub(crate) async fn core_approve_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    decision: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    approve_tool_impl(state.inner(), &run_id, &tool_call_id, decision).await
}

/// 批准工具调用直调体（R1-04 REST 写面：与 core_approve_tool 同一
/// 语义——I-02 pending 校验 + approval-resolved 落库与实时发射；
/// 不依赖 Tauri runtime）。
pub(crate) async fn approve_tool_impl(
    state: &CoreRunState,
    run_id: &str,
    tool_call_id: &str,
    decision: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    // 仅接受 approved（其余值按 InvalidInput 拒绝，杜绝伪造）
    if decision.is_some_and(|d| d != "approved") {
        return Err(CoreError::invalid_input(
            "approve 的 decision 只能为 approved",
        ));
    }
    active
        .approval
        .resolve(tool_call_id, ApprovalDecision::Approved)
        .await?;
    emit_approval_resolved(&active, tool_call_id, WireApprovalDecision::Approved).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id: tool_call_id.to_string(),
        decision: "approved",
    })
}

/// 拒绝工具调用（03 §3.2 A 组：{ok, toolCallId, decision:'denied'}）
#[tauri::command]
pub(crate) async fn core_deny_tool(
    state: tauri::State<'_, Arc<CoreRunState>>,
    run_id: String,
    tool_call_id: String,
    reason: Option<String>,
) -> Result<ApproveResponse, CoreError> {
    deny_tool_impl(state.inner(), &run_id, &tool_call_id, reason.as_deref()).await
}

/// 拒绝工具调用直调体（R1-04 REST 写面：与 core_deny_tool 同一语义；
/// 不依赖 Tauri runtime；reason 缺省 "user denied"）。
pub(crate) async fn deny_tool_impl(
    state: &CoreRunState,
    run_id: &str,
    tool_call_id: &str,
    reason: Option<&str>,
) -> Result<ApproveResponse, CoreError> {
    let active = active_run(state, run_id.trim())?;
    active
        .approval
        .resolve(
            tool_call_id,
            ApprovalDecision::Denied {
                reason: reason.unwrap_or("user denied").to_string(),
            },
        )
        .await?;
    emit_approval_resolved(&active, tool_call_id, WireApprovalDecision::Denied).await;
    Ok(ApproveResponse {
        ok: true,
        tool_call_id: tool_call_id.to_string(),
        decision: "denied",
    })
}

/// 按待审批集合反查 run（R1-04：M6 C11「runId 缺失容错」——toolCallId
/// 为真键，run_id 缺失时遍历活动 run 注册表命中首个包含该 tool_call_id
/// 的 run；未命中 None）
pub(crate) fn find_run_by_pending_tool_call(
    state: &CoreRunState,
    tool_call_id: &str,
) -> Option<String> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|(_, active)| active.approval.contains_pending(tool_call_id))
        .map(|(run_id, _)| run_id.clone())
}

// ── P-7（R2-07 D-02 收尾）：/v1/status activeRuns / pendingApprovals 摘要 ──

/// 活动 run 摘要（P-7：/v1/status activeRuns 数据源；M6 §4.1.1 形状
/// `{runId, sessionId, status, startedAt, prompt}`；注册表 StatusResult
/// activeRuns 为可选 JsonValue[]——桌面端总是下发数组，空数组合法）。
///
/// `prompt` 兜底：runs 表无 prompt 持久化（ActiveRun 不保留 prompt，
/// D-02 判定已注记）——恒空串下发，移动端按「无摘要文本」展示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveRunSummary {
    /// run 标识
    pub run_id: String,
    /// 会话标识
    pub session_id: String,
    /// 状态字面量（conex-db RunStatus::as_str 口径；活动注册表内恒非终态）
    pub status: String,
    /// 创建时刻（epoch ms；RunHandle.created_at）
    pub started_at: i64,
    /// 提示词摘要（兜底恒空串——runs 表无 prompt 持久化，见结构注释）
    pub prompt: String,
}

/// 待审批摘要（P-7：/v1/status pendingApprovals 数据源；M6 §4.1.1 形状
/// `{toolCallId, toolName, runId, summary}` 子集——全量对账面为 C13
/// list_pending_approvals，本面仅首页状态卡摘要，不重复下发
/// cwd/reason/paramKeys 等 C13 全量字段）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingApprovalSummary {
    /// 工具调用 id
    pub tool_call_id: String,
    /// 工具名
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// 活动 run 摘要列表（P-7：/v1/status activeRuns 数据源；注册表活动 run
/// 为运行时真源——终态 run 收口即移出，天然只含活动 run；按 run_id 排序
/// 保证 wire 确定性）。
///
/// 锁纪律：std Mutex（active_runs）内只克隆 Arc 句柄，tokio Mutex
/// （handle）锁不跨 await 持有（future 保持 Send）。
pub(crate) async fn list_active_runs_impl(state: &CoreRunState) -> Vec<ActiveRunSummary> {
    let entries: Vec<(String, String, Arc<tokio::sync::Mutex<RunHandle>>)> = {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        active
            .values()
            .map(|run| {
                (
                    run.run_id.clone(),
                    run.session_id.clone(),
                    Arc::clone(&run.handle),
                )
            })
            .collect()
    };
    let mut summaries = Vec::with_capacity(entries.len());
    for (run_id, session_id, handle) in entries {
        let guard = handle.lock().await;
        summaries.push(ActiveRunSummary {
            run_id,
            session_id,
            status: guard.status.as_str().to_string(),
            started_at: guard.created_at,
            prompt: String::new(),
        });
    }
    summaries.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    summaries
}

/// 待审批摘要列表（P-7：/v1/status pendingApprovals；从 C13 全量对账
/// [list_pending_approvals_impl] 投影 M6 §4.1.1 摘要子集——单一数据源
/// 复用，无第二套 pending 查询语义；按 tool_call_id 排序保证 wire
/// 确定性）
pub(crate) fn list_pending_approval_summaries_impl(
    state: &CoreRunState,
) -> Vec<PendingApprovalSummary> {
    let mut summaries: Vec<PendingApprovalSummary> = list_pending_approvals_impl(state)
        .into_iter()
        .map(|approval| PendingApprovalSummary {
            tool_call_id: approval.tool_call_id,
            tool_name: approval.tool_name,
            run_id: approval.run_id,
            summary: approval.summary,
        })
        .collect();
    summaries.sort_by(|a, b| a.tool_call_id.cmp(&b.tool_call_id));
    summaries
}

/// 待审批对账（R1-04 / M6 C13：活动 run 审批门待审批集合快照——「已
/// 请求未裁决」的运行时真源；run 未终态天然成立（终态移出活动注册表）。
/// after_sequence 增量水位属 wire 层对账扩展，实现为全量对账（M6 C13
/// 参数可选，缺省即全量）。
pub(crate) fn list_pending_approvals_impl(state: &CoreRunState) -> Vec<PendingApproval> {
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .flat_map(|active| {
            active
                .approval
                .pending_requests()
                .into_iter()
                .map(move |(tool_call_id, meta)| {
                    // 危险级别在字段 move 前计算（tool_name 随后移入结构体）
                    let danger_level = derive_danger_level(&meta.tool_name, &meta.param_keys);
                    PendingApproval {
                        request_id: format!("approval-{tool_call_id}"),
                        tool_call_id,
                        tool_name: meta.tool_name,
                        summary: Some(meta.summary),
                        cwd: Some(meta.cwd),
                        session_id: Some(meta.session_id),
                        run_id: Some(active.run_id.clone()),
                        requester_run_id: meta.requester_run_id,
                        reason: meta.reason,
                        arbiter: if meta.arbiter == "main-agent" {
                            Arbiter::MainAgent
                        } else {
                            Arbiter::User
                        },
                        requested_at: meta.requested_at_ms,
                        expires_at: meta.requested_at_ms + APPROVAL_TIMEOUT.as_millis() as u64,
                        danger_level,
                        param_keys: Some(meta.param_keys),
                    }
                })
        })
        .collect()
}

/// 危险级别推导（R1-04 / M6 C13：桌面按 F2 §2.2 表推导，移动端不重算）
///
/// 轻量启发式（与前端 approvalHandlers S9 宽容解析同语义的子集）：
/// 删除类工具 / 参数含删除语义 → 2（高风险，移动端二次确认），其余
/// 常规确认 → 1。红线请求不会到达审批门（decide_with_redline 先行拒绝），
/// 此处无需红线分支。
pub(crate) fn derive_danger_level(tool_name: &str, param_keys: &[String]) -> u8 {
    const DESTRUCTIVE_TOOLS: [&str; 5] = [
        "shell:write",
        "shell:exec",
        "git:revert",
        "file:delete",
        "workspace:delete",
    ];
    if DESTRUCTIVE_TOOLS.contains(&tool_name) {
        return 2;
    }
    if param_keys
        .iter()
        .any(|k| k.contains("delete") || k.contains("remove") || k.contains("overwrite"))
    {
        return 2;
    }
    1
}

/// 审批历史补拉（R1-04 / M6 C14：approval-resolved 事件白名单投影——
/// events 表按事件类型过滤，不携带参数全量（同 C13 隐私红线）。
/// sessionId 提供时按会话内 sequence 水位过滤，缺省跨会话按落库时刻
/// 近似排序；limit 缺省 100、上限 500。
pub(crate) async fn approval_history_impl(
    state: &CoreRunState,
    session_id: Option<&str>,
    after_sequence: Option<u64>,
    limit: Option<u32>,
) -> Result<ApprovalHistoryResult, CoreError> {
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    let Some(db) = state.local_db() else {
        // 无本地库（测试替身 store）：诚实返回空历史（不编造）
        return Ok(ApprovalHistoryResult {
            items: Vec::new(),
            next_after_sequence: None,
            has_more: None,
        });
    };
    let after = after_sequence.unwrap_or(0);
    // 会话范围：显式 sessionId → 单会话；缺省 → 全部会话索引
    let session_ids: Vec<String> = match session_id {
        Some(id) if !id.trim().is_empty() => vec![id.trim().to_string()],
        _ => db
            .list_sessions()
            .map_err(map_db_failure)?
            .into_iter()
            .map(|s| s.id)
            .collect(),
    };
    // 逐会话拉取 approval-resolved 事件行（(sequence, created_at, payload)；
    // created_at 为 ISO 字符串列，跨会话排序按字典序 = 时间序）
    let mut rows: Vec<(i64, String, serde_json::Value)> = Vec::new();
    for sid in &session_ids {
        let events = db
            .query_events(sid, after as i64, None)
            .map_err(map_db_failure)?;
        for event in events {
            if event.event_type != "approval-resolved" {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
                continue; // 损坏载荷跳过（防御性，与 core_read_session_events 同口径）
            };
            rows.push((event.sequence, event.created_at, payload));
        }
    }
    // 排序：跨会话按落库时刻（单会话天然按 sequence 升序，created_at 同序）
    rows.sort_by(|a, b| a.1.cmp(&b.1));
    let has_more = rows.len() > limit;
    let page = rows.into_iter().take(limit).collect::<Vec<_>>();
    let next_after_sequence = page
        .last()
        .map(|(sequence, _, _)| (*sequence).max(0) as u64);
    let items = page
        .into_iter()
        .filter_map(|(sequence, _, payload)| {
            let tool_call_id = payload
                .get("toolCallId")
                .and_then(serde_json::Value::as_str)?
                .to_string();
            let decision =
                serde_json::from_value(payload.get("decision").cloned().unwrap_or_default())
                    .unwrap_or(conex_types::events::ApprovalDecision::Expired);
            let resolved_at = payload
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .map(|iso| iso8601_to_epoch_millis(iso).max(0) as u64);
            Some(ApprovalHistoryItem {
                sequence: sequence.max(0) as u64,
                tool_call_id,
                tool_name: None,
                decision,
                reason: None,
                channel: Some(RemoteApprovalChannel::Mobile),
                resolved_at,
                session_id: payload
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                run_id: payload
                    .get("runId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    Ok(ApprovalHistoryResult {
        items,
        next_after_sequence,
        has_more: Some(has_more),
    })
}

/// conex-db [conex_db::DbFailure] → CoreError（本地库访问直调面通用映射）
pub(crate) fn map_db_failure(error: conex_db::DbFailure) -> CoreError {
    CoreError::Io(format!("本地库访问失败：{error}"))
}

/// 落地 approval-resolved 事件（持久化 + 实时发射）
pub(crate) async fn emit_approval_resolved(
    active: &ActiveRun,
    tool_call_id: &str,
    decision: WireApprovalDecision,
) {
    let event = AgentEvent::ApprovalResolved {
        session_id: active.session_id.clone(),
        tool_call_id: tool_call_id.to_string(),
        request_id: None,
        decision,
        timestamp: crate::engine::now_iso_utc(),
    };
    let mut queue = active.queue.lock().await;
    match queue.push(&active.session_id, event).await {
        Ok(sequenced) => {
            let envelope = AgentEventEnvelope::new(
                sequenced.event,
                Some(active.run_id.clone()),
                Some(sequenced.sequence),
            );
            active.bridge.emit(&envelope);
            active.bridge.flush();
        }
        Err(error) => {
            tracing::error!(
                target: "approval",
                run_id = %active.run_id,
                tool_call_id,
                error = %error,
                "approval-resolved 落库失败"
            );
        }
    }
}
