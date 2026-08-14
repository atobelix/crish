//! 单工具执行面（SR-03 拆分 · ≠ EL）：execute_one / execute_single /
//! execute_single_with_retry
//!
//! 顺序路径完整事件序列（execute_one）、无事件产出的单工具执行
//! （execute_single，中间件链 + tool.pre/post 钩子 + 超时/abort 竞速）
//! 与 requires_approval 真实审批重试（execute_single_with_retry）随本模落位。
//! 语义与拆分前逐行一致（只搬移不改行为）。

use super::*;

impl ToolExecutor {
    /// 执行单个工具（顺序路径：完整事件序列 + 审批）
    // G2 允许理由（clippy::too_many_arguments）：参数为工具执行上下文聚合
    // 注入（批调用/下标/执行上下文/审批门/批选项/中止信号/事件收集/致命
    // 错误槽），各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_one(
        &self,
        calls: &[ToolBatchCall],
        idx: usize,
        ctx: &ToolExecCtx,
        approval: Option<Arc<dyn ApprovalGate>>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        events: &mut Vec<ToolEvent>,
        fatal: &mut Option<String>,
    ) -> ClassifiedToolResult {
        let call = &calls[idx];
        events.push(ToolEvent::ToolStart {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            input: call.input.clone(),
            category: call.category,
            concurrency: call.concurrency,
            summary: call.summary.clone(),
        });

        // abort 前置检查
        if let Some(sig) = abort {
            if sig.is_aborted() {
                events.push(ToolEvent::ToolEnd {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    is_error: true,
                    duration_ms: 0,
                    output: serde_json::Value::Null,
                    error_code: Some("tool.cancelled".to_string()),
                    error_message: Some("aborted".to_string()),
                });
                return ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                );
            }
        }

        // R4 T10：权限判定 → 放行 / 拒绝 / 需审批。permission_mode 显式
        // 设置时 dangerous 标记进入判定（ask 问询 / plan 拒绝 / full-access
        // 放行）；未设置时沿用既有语义（approval 开启 → 全批审批）。
        let verdict = self.call_verdict(call, options);
        let r = match (&approval, options.approval_enabled) {
            (Some(gate), true) => match verdict {
                PermissionVerdict::Allow => {
                    let (r, extra) = self
                        .execute_single_with_retry(call, ctx, options, abort, Some(Arc::clone(gate)))
                        .await;
                    events.extend(extra);
                    r
                }
                PermissionVerdict::Deny => denied_result(call, options),
                PermissionVerdict::NeedsApproval => {
                    // 审批：approval-requested 事件先发出，再挂起等待（防死锁）
                    // T-D-14：请求方身份（子代理 run + 理由）随事件与门调用透传
                    let requester = self.approval_requester_for(ctx, &call.input);
                    events.push(ToolEvent::ApprovalRequested {
                        call_id: call.id.clone(),
                        tool_name: call.tool_name.clone(),
                        args: call.input.clone(),
                        requester: requester.clone(),
                    });
                    // F1-02：竞速 abort vs 审批等待（带超时）——abort 命中
                    // 走取消收场，超时 → Expired 既有分支
                    match approval_wait(
                        gate.as_ref(),
                        &call.id,
                        &call.tool_name,
                        &call.input,
                        requester.as_ref(),
                        abort,
                        options.approval_timeout,
                    )
                    .await
                    {
                        ApprovalWaitOutcome::Cancelled => ClassifiedToolResult::error(
                            &call.id,
                            &call.tool_name,
                            ToolErrorKind::Cancelled,
                            "aborted",
                        ),
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                            let (r, extra) = self
                                .execute_single_with_retry(call, ctx, options, abort, Some(Arc::clone(gate)))
                                .await;
                            events.extend(extra);
                            r
                        }
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => {
                            ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::UserDenied,
                                denied_message(requester.is_some(), &reason),
                            )
                        }
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                            // G-9：超时 → Expired 权威语义落库——审批超时
                            //（APPROVAL_TIMEOUT）在引擎侧收敛为
                            // approval-resolved(expired) 事件进批事件流
                            //（翻译层映射 AgentEvent 随会话流持久化/广播，
                            // 多端过期状态统一；approve/deny 由壳层命令
                            // 路径落事件，避免双发）
                            events.push(ToolEvent::ApprovalResolved {
                                call_id: call.id.clone(),
                                decision: ApprovalDecision::Expired,
                            });
                            ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::ApprovalExpired,
                                "approval expired",
                            )
                        }
                    }
                }
            },
            // 审批未启用 / 无门：plan 模式写类仍拒绝；显式 ask 模式缺审批
            // 基础设施时危险项透传需审批状态（不再 SoftDeny 折叠）
            _ => match verdict {
                PermissionVerdict::Deny => denied_result(call, options),
                PermissionVerdict::NeedsApproval if options.permission_mode.is_some() => {
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::ApprovalRequired,
                        self.revert_refusal_message(call),
                    )
                }
                _ => {
                    let (r, extra) = self
                        .execute_single_with_retry(call, ctx, options, abort, approval.clone())
                        .await;
                    events.extend(extra);
                    r
                }
            },
        };
        if self.result_is_fatal(call, &r) {
            *fatal = Some(r.error_message.clone().unwrap_or_else(|| "tool failed".into()));
        }
        events.push(ToolEvent::ToolEnd {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            is_error: r.error_kind.is_some(),
            duration_ms: r.duration_ms,
            output: r.output.clone(),
            error_code: r.error_kind.map(|k| k.error_code().to_string()),
            error_message: r.error_message.clone(),
        });
        r
    }

    /// 单工具执行（不含事件产出；审批已通过或未启用）
    ///
    /// R4 T10：组装 ToolContext 时接线审批通道（ctx.ask）——有审批门时
    /// [ApprovalChannel]（真实审批请求 + abort 取消），full-access 模式
    /// [NoopAskChannel]（自动放行，T0–T3 语义），其余未接线 None（工具
    /// 自报 tool.requires_approval → 执行器分类 ApprovalRequired 透传）。
    /// 返回（结果, 审批附加事件）。
    async fn execute_single(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        // 未知工具
        let tool = match self.registry.get(&call.tool_name) {
            Some(t) => t,
            None => {
                return (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::NotFound,
                        format!("unknown tool: {}", call.tool_name),
                    ),
                    Vec::new(),
                )
            }
        };

        // 超时执行（abort 时 timeout 竞速后检查）
        let exec_ctx = ExecutorContext {
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            tool_call_id: Some(call.id.clone()),
            cwd: ctx.cwd.clone(),
        };
        // R3 T9：会话级 ToolContext——workspace_root 优先取显式注入，
        // 其次 cwd，最后当前目录（与既有 BuiltinToolConfig 默认语义对齐）。
        // R4 T10：ask 通道接线（approval 事件记录由通道侧收集，执行后取回
        // 并入批事件流，保持 tool-start → approval-requested → tool-end 顺序）。
        let abort_token = AbortToken::new();
        let mut approval_channel: Option<Arc<ApprovalChannel>> = None;
        // T-D-14：请求方身份（子代理 run + 理由）随审批通道透传——工具内
        // 审批提问（ctx.ask）同样按来源路由；主 agent run = None
        let requester = self.approval_requester_for(ctx, &call.input);
        let ask: Option<AskCallback> = match options.permission_mode {
            Some(PermissionMode::FullAccess) => Some(Arc::new(NoopAskChannel)),
            _ => approval.as_ref().map(|gate| {
                let channel = Arc::new(ApprovalChannel::new(
                    Arc::clone(gate),
                    &call.id,
                    abort.cloned(),
                    abort_token.clone(),
                    requester.clone(),
                ));
                approval_channel = Some(Arc::clone(&channel));
                channel as AskCallback
            }),
        };
        let tool_ctx = ToolContext {
            session_id: ctx.session_id.clone(),
            abort_token,
            ask,
            workspace_root: ctx
                .workspace_root
                .clone()
                .or_else(|| ctx.cwd.clone().map(PathBuf::from))
                .unwrap_or_else(|| {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                }),
            // I4-M3：写路径互斥注册表——会话级装配（与 workspace_root 同源，
            // 由 AgentSessionLoop::with_options 创建并经 ToolExecCtx 注入；
            // None = 写工具不强制互斥，测试与直连场景向后兼容）
            write_claims: ctx.write_claims.clone(),
            // 写声明持有者：当前 run 标识（M2 子代理执行上下文注入子代理
            // run id；主循环装配为 run 级归属——同 run 内工具再声明不互斥，
            // 跨 run 重叠即冲突）
            write_claim_holder: Some(ctx.run_id.clone()),
            // I6-M11 C5：探索类文档配额上下文（含配额 store 实例，会话级
            // 装配经 ToolExecCtx 透传；None = 不检查——非探索类不受配额
            // 约束，04 C5：主 agent 自身不消耗）
            explore_docs_quota: ctx.explore_docs_quota.clone(),
            // T-EG-08 REQ-G01：产出目录解析服务——经 ToolExecCtx 透传
            //（loop 装配面默认注入 OutputWorkspace；None = 未接线，
            // resolve_output_dir 返回 common.unsupported）
            output_dir: ctx.output_dir.clone(),
            // 后台任务管理器 / 日志落盘根未接线（A1 域新字段占位：None =
            // 无后台任务能力、截断不落盘；真实接线由引擎装配面注入）
            background: None,
            log_root: None,
            // T-40（记忆韧性轮次 5）：压缩块只读访问服务——本轮仅占位
            // None（search_context/decompress_context 返回
            // common.unsupported）；轮次 6 由引擎侧注入
            // CompressionContextStore 实现（conex-db compression_blocks）
            compression_store: None,
            // Round6 / W4-E：笔记后端经 ToolExecCtx 透传（None = unwired 占位；
            // 引擎 / SessionLoopOptions 可注入 conex-note-runtime::StoreNoteBackend）
            note_backend: ctx.note_backend.clone(),
            // D-02 LK-01：键源注入——与上方 ExecutorContext.tool_call_id
            //（:209 同源）取当前 call.id；工具侧审计/发射经 ctx.tool_call_id
            // 反查本调用（LK-03 消费）；None = 非工具调用上下文
            tool_call_id: Some(call.id.clone()),
        };
        // ── 中间件链 + 插件钩子（审批已通过，进入执行面；优先级语义
        //    见模块头注：审批优先于中间件，中间件 Block 不绕过审批）──
        let mw_ctx = ToolExecutionContext {
            session_id: Some(ctx.session_id.clone()),
            run_id: Some(ctx.run_id.clone()),
            tool_call_id: Some(call.id.clone()),
            cwd: ctx.cwd.clone(),
        };
        // 1) middleware before_execute 链：可修改入参 / Block 阻止（仅对
        //    「审批已通过」的调用生效；链中任一 Err 视为阻止执行）。
        //    E4：每项包超时竞速窗口（默认 2000ms，中间件可配）——超时视为
        //    Err → Block（守门者报错 = 不放行，06:57）；abort 竞速偏置——
        //    abort 在链执行期间触发 → 本调用取消（超时窗口内可取消）。
        let mut current_input = call.input.clone();
        let mut blocked: Option<String> = None;
        for m in &self.middleware {
            let result = run_hook_with_timeout(
                self.middleware_timeouts.before_execute,
                abort,
                m.before_execute(tool.as_ref(), current_input.clone(), &mw_ctx),
            )
            .await;
            let Some(result) = result else {
                // abort 在中间件 before 链竞速窗口内触发 → 取消收场
                return (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::Cancelled,
                        "aborted",
                    ),
                    Vec::new(),
                );
            };
            match result {
                Ok(Ok(BeforeExecuteResult::Proceed { modified_input })) => {
                    if let Some(v) = modified_input {
                        current_input = v;
                    }
                }
                Ok(Ok(BeforeExecuteResult::Block { reason })) => {
                    blocked = Some(format!("被中间件 {} 阻止：{reason}", m.name()));
                    break;
                }
                Ok(Err(e)) => {
                    blocked = Some(format!("中间件 {} 前置钩子错误：{e}", m.name()));
                    break;
                }
                Err(_elapsed) => {
                    blocked = Some(format!(
                        "中间件 {} 前置钩子超时（{}ms），按阻止处理",
                        m.name(),
                        self.middleware_timeouts.before_execute.as_millis()
                    ));
                    break;
                }
            }
        }
        // 2) tool.pre 事件广播（HookRegistry；handler Block = 阻止执行；
        //    propagate 失败降级为阻止，不中断批执行）
        if blocked.is_none() {
            if let Some(hooks) = &self.hooks {
                let event = HookEvent::ToolPre {
                    session_id: ctx.session_id.clone(),
                    tool_name: call.tool_name.clone(),
                    input: current_input.clone(),
                };
                // I8-E1：HookRegistry::dispatch 已转 async（async_trait +
                // timeout 竞速窗口，03 §2.4/§3.5）；tool.pre 广播 await
                match hooks.dispatch(&event).await {
                    Ok(outcome) => {
                        if let Some(reason) = outcome.blocked {
                            blocked = Some(format!("tool.pre 钩子阻止：{reason}"));
                        }
                    }
                    Err(e) => {
                        blocked = Some(format!("tool.pre 钩子失败（propagate）：{e}"));
                    }
                }
            }
        }
        if let Some(reason) = blocked {
            return (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::ExecutionFailed,
                    reason,
                ),
                Vec::new(),
            );
        }

        let policy = ToolExecutionPolicy {
            // T06.4.2：输出预算从 ToolBatchOptions 透传（None = 不截断，
            // 与 executor.rs 的 summarize 截断语义接通）
            output_budget_bytes: options.output_budget_bytes,
            idempotency: self.idempotency.is_some(),
        };
        let guard = self.idempotency.clone();
        // 执行入参 = 中间件链修改后的最终入参（未经 before 链时与原始入参一致）
        let exec_input = current_input.clone();
        let start = std::time::Instant::now();
        // S1（TOOLS-01 §3.1.5）：流式执行 + 进度出站——Progress 经
        // [tool_progress_update] 映射为 ToolEvent::ToolProgress 入进度缓冲，
        // 执行完成后并入事件链（时序 tool-start → tool-update* → tool-end；
        // ToolUpdate 为展示面不进消息历史，终值仍由 ToolEnd 承载）。Content
        // 阶段 1 不发射（映射返回 None 直接丢弃）；幂等命中路径零 Progress
        //（executor 内早退不回调，D3）；abort/超时路径已入队的进度保留
        //（流被 drop 前已回调，契约「已发 Progress 保留」）。
        let progress_buffer: Arc<Mutex<Vec<ToolEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let progress: Option<Arc<dyn Fn(ToolProgress) + Send + Sync>> = Some(Arc::new({
            let buffer = Arc::clone(&progress_buffer);
            let call_id = call.id.clone();
            move |p: ToolProgress| {
                if let Some(update) = tool_progress_update(&p) {
                    buffer.lock().unwrap().push(ToolEvent::ToolProgress {
                        call_id: call_id.clone(),
                        update,
                    });
                }
            }
        }));
        // 执行体 future：幂等守卫开启时透传守卫（execute_stream_with_output_policy
        // 的幂等去重 + 输出预算语义，T06.4.2/T06.4.4）
        let execute = async {
            if let Some(g) = guard.as_ref() {
                execute_stream_with_output_policy(
                    tool.as_ref(),
                    exec_input.clone(),
                    &tool_ctx,
                    &exec_ctx,
                    Some(g.as_ref()),
                    &policy,
                    progress.clone(),
                )
                .await
            } else {
                execute_stream_with_output_policy(
                    tool.as_ref(),
                    exec_input.clone(),
                    &tool_ctx,
                    &exec_ctx,
                    None,
                    &policy,
                    progress.clone(),
                )
                .await
            }
        };
        // Q21（T09.9）：abort-aware 竞速——`options.timeout` future 与
        // abort 监听 future 并置；abort 触发即取消等待并走取消收场
        // （不等 timeout 全长，AA-01 Q21：60s 长工具取消及时生效）。
        // 执行体 future 随分支丢失被 drop（尽力取消：MCP 远端尽力取消
        // 由传输层 abort 语义承接，本层以 drop 为取消语义）。
        let outcome = match abort {
            Some(sig) => tokio::select! {
                biased;
                _ = sig.wait_aborted() => None,
                result = tokio::time::timeout(options.timeout, execute) => Some(result),
            },
            None => Some(tokio::time::timeout(options.timeout, execute).await),
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        // 审批附加事件（approval-requested 等，执行后取回）
        let recorded = approval_channel
            .as_ref()
            .map(|c| c.take_recorded())
            .unwrap_or_default();
        // S1：进度事件并入事件链（执行 future 已 resolve/drop，缓冲不再
        // 增长）——后续所有返回分支（abort/超时/成功/失败）自动携带已发
        // 进度，保持 tool-start → tool-update* → tool-end 时序与
        // 「abort 后已发 Progress 保留」契约
        let mut recorded = recorded;
        recorded.extend(std::mem::take(&mut *progress_buffer.lock().unwrap()));

        if let Some(sig) = abort {
            if sig.is_aborted() {
                return (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::Cancelled,
                        "aborted",
                    ),
                    recorded,
                );
            }
        }

        match outcome {
            // 竞速获胜：abort 已触发（上方检查兜底），防御性按取消处理
            None => (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                ),
                recorded,
            ),
            Some(Err(_elapsed)) => (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Timeout,
                    format!(
                        "tool {} timed out after {:?}",
                        call.tool_name, options.timeout
                    ),
                ),
                recorded,
            ),
            Some(Ok(Ok(tool_result))) => {
                if tool_result.deduplicated {
                    // 幂等去重：未真正执行，跳过 on_result 改写链，仅广播
                    // tool.post（成功，duration=0）保持事件对称
                    if let Some(hooks) = &self.hooks {
                        let _ = hooks
                            .dispatch(&HookEvent::ToolPost {
                                session_id: ctx.session_id.clone(),
                                tool_name: call.tool_name.clone(),
                                output: tool_result.output.clone(),
                                duration_ms: 0,
                                is_error: false,
                            })
                            .await;
                    }
                    (
                        ClassifiedToolResult::ok(&call.id, &call.tool_name, tool_result.output, 0),
                        recorded,
                    )
                } else {
                    // 3) middleware on_result 链：可改写输出；Err/超时记录
                    //    日志并降级透传原输出（后置钩子错误不改变已完成的
                    //    执行结果；E4 超时语义 = 06:58）
                    let mut final_output = tool_result.output;
                    for m in &self.middleware {
                        let result = run_hook_with_timeout(
                            self.middleware_timeouts.on_result,
                            None,
                            m.on_result(
                                tool.as_ref(),
                                &current_input,
                                final_output.clone(),
                                &mw_ctx,
                            ),
                        )
                        .await;
                        match result {
                            Some(Ok(Ok(AfterExecuteResult::Passthrough))) => {}
                            Some(Ok(Ok(AfterExecuteResult::Replace(v)))) => final_output = v,
                            Some(Ok(Err(e))) => {
                                tracing::error!(
                                    middleware = %m.name(),
                                    error = %e,
                                    "中间件 on_result 失败，降级透传原输出"
                                );
                            }
                            Some(Err(_elapsed)) => {
                                tracing::error!(
                                    middleware = %m.name(),
                                    timeout_ms = self.middleware_timeouts.on_result.as_millis(),
                                    "中间件 on_result 超时，降级透传原输出"
                                );
                            }
                            None => {
                                // abort=None 竞速路径不可能返回 None（防御性
                                // 兜底，与降级语义一致：透传原输出）
                                tracing::error!(
                                    middleware = %m.name(),
                                    "中间件 on_result 竞速异常，降级透传原输出"
                                );
                            }
                        }
                    }
                    // 4) tool.post 事件广播（成功；广播中间件改写后的最终输出）
                    if let Some(hooks) = &self.hooks {
                        let _ = hooks
                            .dispatch(&HookEvent::ToolPost {
                                session_id: ctx.session_id.clone(),
                                tool_name: call.tool_name.clone(),
                                output: final_output.clone(),
                                duration_ms,
                                is_error: false,
                            })
                            .await;
                    }
                    (
                        ClassifiedToolResult::ok(
                            &call.id,
                            &call.tool_name,
                            final_output,
                            duration_ms,
                        ),
                        recorded,
                    )
                }
            }
            Some(Ok(Err(err))) => {
                // 5) middleware on_error 链（仅观察；Err/超时记录日志，
                //    不吞原错误；E4 超时语义 = 06:59）
                for m in &self.middleware {
                    let result = run_hook_with_timeout(
                        self.middleware_timeouts.on_error,
                        None,
                        m.on_error(tool.as_ref(), &current_input, &err, &mw_ctx),
                    )
                    .await;
                    match result {
                        Some(Ok(Ok(()))) => {}
                        Some(Ok(Err(e))) => {
                            tracing::error!(
                                middleware = %m.name(),
                                error = %e,
                                "中间件 on_error 失败（仅观察，不吞原错误）"
                            );
                        }
                        Some(Err(_elapsed)) => {
                            tracing::error!(
                                middleware = %m.name(),
                                timeout_ms = self.middleware_timeouts.on_error.as_millis(),
                                "中间件 on_error 超时（仅观察，不吞原错误）"
                            );
                        }
                        None => {
                            // abort=None 竞速路径不可能返回 None（防御性兜底）
                            tracing::error!(
                                middleware = %m.name(),
                                "中间件 on_error 竞速异常（仅观察，不吞原错误）"
                            );
                        }
                    }
                }
                // 6) tool.post 事件广播（失败；output 承载错误文案）。
                //    I8-E1：dispatch 已转 async（async_trait + 竞速窗口）
                if let Some(hooks) = &self.hooks {
                    let _ = hooks
                        .dispatch(&HookEvent::ToolPost {
                            session_id: ctx.session_id.clone(),
                            tool_name: call.tool_name.clone(),
                            output: serde_json::json!(err.to_string()),
                            duration_ms,
                            is_error: true,
                        })
                        .await;
                    // I8-E1：tool.error 追加广播（tool-end isError 分支，M13
                    // 映射第 7 行；on 模式可转 retry 信号——保留 ToolHook.onError
                    // 控制能力；失败吞掉 + 计数，结果保持）
                    let _ = hooks
                        .dispatch(&HookEvent::ToolError {
                            session_id: ctx.session_id.clone(),
                            tool_name: call.tool_name.clone(),
                            error: err.to_string(),
                        })
                        .await;
                }
                let (kind, msg) = classify_tool_error(&err);
                (
                    ClassifiedToolResult::error(&call.id, &call.tool_name, kind, msg),
                    recorded,
                )
            }
        }
    }

    /// 单工具执行 + requires_approval 真实审批（R4 T10）
    ///
    /// 工具返回 tool.requires_approval 时分类为 ApprovalRequired：有审批门
    /// 则发起真实审批请求（approval-requested 先发后等，防死锁），用户
    /// 同意后重试执行该工具调用一次（二次 ApprovalRequired 直接透传，
    /// 防循环）；拒绝返回明确拒绝结果（Denied 语义）；无门时透传需审批
    /// 状态给模型（不再伪装成 SoftDeny 可自行降级）。
    /// 返回（结果, 审批附加事件）。
    pub(crate) async fn execute_single_with_retry(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let (r, extra) = self
            .execute_single(call, ctx, options, abort, approval.clone())
            .await;
        if r.error_kind != Some(ToolErrorKind::ApprovalRequired) {
            return (r, extra);
        }
        // requires_approval：按权限模式裁决（ask → 真实审批；plan → 拒绝；
        // full-access → 自动放行；未设置 → 审批）
        let verdict = match options.permission_mode {
            Some(mode) => decide(false, true, mode),
            None => PermissionVerdict::NeedsApproval,
        };
        match verdict {
            PermissionVerdict::Deny => (denied_result(call, options), extra),
            PermissionVerdict::Allow => {
                // full-access：自动放行，直接重试执行一次
                let (r2, extra2) =
                    self.execute_single(call, ctx, options, abort, approval).await;
                (r2, [extra, extra2].concat())
            }
            PermissionVerdict::NeedsApproval => match approval {
                Some(gate) => {
                    let mut extra = extra;
                    // T-D-14：请求方身份（子代理 run + 理由）随事件与门调用透传
                    let requester = self.approval_requester_for(ctx, &call.input);
                    extra.push(ToolEvent::ApprovalRequested {
                        call_id: call.id.clone(),
                        tool_name: call.tool_name.clone(),
                        args: call.input.clone(),
                        requester: requester.clone(),
                    });
                    // F1-02：竞速 abort vs 审批等待（带超时）——abort 命中
                    // 走取消收场，超时 → Expired 既有分支
                    match approval_wait(
                        gate.as_ref(),
                        &call.id,
                        &call.tool_name,
                        &call.input,
                        requester.as_ref(),
                        abort,
                        options.approval_timeout,
                    )
                    .await
                    {
                        ApprovalWaitOutcome::Cancelled => (
                            ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::Cancelled,
                                "aborted",
                            ),
                            extra,
                        ),
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                            let (r2, extra2) = self
                                .execute_single(call, ctx, options, abort, Some(gate))
                                .await;
                            (r2, [extra, extra2].concat())
                        }
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => (
                            ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::UserDenied,
                                denied_message(requester.is_some(), &reason),
                            ),
                            extra,
                        ),
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                            // G-9：超时 → Expired 权威语义落库（requires_approval
                            // 重试路径同顺序路径；事件并入 extra 进批事件流）
                            extra.push(ToolEvent::ApprovalResolved {
                                call_id: call.id.clone(),
                                decision: ApprovalDecision::Expired,
                            });
                            (
                                ClassifiedToolResult::error(
                                    &call.id,
                                    &call.tool_name,
                                    ToolErrorKind::ApprovalExpired,
                                    "approval expired",
                                ),
                                extra,
                            )
                        }
                    }
                }
                // 无审批门：透传需审批状态（不再 SoftDeny 折叠）
                None => (r, extra),
            },
        }
    }
}