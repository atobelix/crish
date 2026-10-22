//! 重试决策执行（§5.3 状态机）：handle_retry / retake，以及内部协议 RetryFlow。

use super::{
    ActionError, ActionErrorKind, ActionExecutor, ActionRequest, ActionSuccess, ElementRef,
    RetryDecision, RetryState, WaitCondition, WaitOptions,
};

impl ActionExecutor {
    /// 重试决策执行（§5.3 状态机：错误 → 策略 → 具体动作）。
    pub(super) async fn handle_retry(
        &self,
        retry: &mut RetryState,
        req: &mut ActionRequest,
        first_err: ActionError,
    ) -> RetryFlow {
        let mut err = first_err;
        loop {
            if self.abort.is_cancelled() {
                return RetryFlow::Done(Err(ActionError::new(
                    ActionErrorKind::Aborted,
                    "用户接管/令牌吊销（重试期间）",
                )));
            }
            match retry.decide(&err) {
                RetryDecision::Stop(outcome) => return RetryFlow::Done(Err(outcome)),
                RetryDecision::Continue => return RetryFlow::Continue,
                RetryDecision::DelayThenRetry => {
                    // ContextGone：延迟 300ms → 版本校验（§5.4）
                    self.delay.sleep(self.opts.retry_delay).await;
                    if self
                        .snapshot
                        .validate_snapshot(&req.tab_id, req.snapshot_version)
                        .is_err()
                    {
                        // 版本已推进 → 按 VersionInvalid 重快照
                        err = ActionError::new(
                            ActionErrorKind::VersionInvalid,
                            "延迟后版本已推进（导航竞态）",
                        );
                        continue;
                    }
                    return RetryFlow::Continue;
                }
                RetryDecision::DelayThenRetake => {
                    // TargetClosed：延迟 300ms → 目标存活校验（§5.1）
                    self.delay.sleep(self.opts.retry_delay).await;
                    let alive = match self.ops.target_alive().await {
                        Ok(alive) => alive,
                        Err(e) => {
                            err = e;
                            continue;
                        }
                    };
                    if !alive {
                        return RetryFlow::Done(Err(ActionError::new(
                            ActionErrorKind::TargetClosed,
                            "目标（标签页）已销毁，不再自动重试",
                        )));
                    }
                    match self.retake(req).await {
                        Ok(flow) => return flow,
                        Err(take_err) => {
                            err = take_err;
                            continue;
                        }
                    }
                }
                RetryDecision::Retake => match self.retake(req).await {
                    Ok(flow) => return flow,
                    Err(take_err) => {
                        err = take_err;
                        continue;
                    }
                },
                RetryDecision::WaitVisible => {
                    // NotInteractive 首轮：wait_for 可见（≤2s）→ 重试（§5.1）
                    let Some(index) = req.element.map(|el| el.index) else {
                        return RetryFlow::Continue;
                    };
                    let wait = self
                        .wait_for(
                            WaitCondition::Element { index },
                            WaitOptions::for_condition(
                                &WaitCondition::Element { index },
                                req.tab_id.clone(),
                            )
                            .with_timeout_ms(self.opts.not_interactive_wait_ms),
                        )
                        .await;
                    if let Err(wait_err) = wait {
                        // 等待可见超时仍归类 NotInteractive（元素持续不可见，§5.1）
                        err = ActionError::new(
                            ActionErrorKind::NotInteractive,
                            format!("元素等待可见超时：{}", wait_err.message),
                        );
                        continue;
                    }
                    return RetryFlow::Continue;
                }
                RetryDecision::WaitThenRetry => {
                    // Timeout 首轮：等待元素可见/网络空闲 → 重试 1 次（§5.1）
                    let ready = match req.element {
                        Some(el) => self
                            .wait_for(
                                WaitCondition::Element { index: el.index },
                                WaitOptions::for_condition(
                                    &WaitCondition::Element { index: el.index },
                                    req.tab_id.clone(),
                                )
                                .with_timeout_ms(self.opts.not_interactive_wait_ms),
                            )
                            .await
                            .is_ok(),
                        None => self
                            .wait_for(
                                WaitCondition::NetworkIdle { quiet_ms: 500 },
                                WaitOptions::for_condition(
                                    &WaitCondition::NetworkIdle { quiet_ms: 500 },
                                    req.tab_id.clone(),
                                ),
                            )
                            .await
                            .is_ok(),
                    };
                    if !ready {
                        err = ActionError::new(ActionErrorKind::Timeout, "等待就绪后仍超时");
                        continue;
                    }
                    return RetryFlow::Continue;
                }
                RetryDecision::AwaitConnection => {
                    // ConnectionLost：等待 ConnectionRestored → 重试 ≤1 次（R-9，不计数）
                    match self
                        .ops
                        .await_connection_restored(self.opts.connection_wait)
                        .await
                    {
                        Ok(()) => return RetryFlow::Continue,
                        Err(restore_err) => {
                            err = restore_err;
                            continue;
                        }
                    }
                }
            }
        }
    }

    /// 重快照 → 按索引重定位（§5.3；索引在新快照中不存在 → InvalidInput 致命，E2E-10）。
    /// 重快照失败 → Err（原错误原样返回，§5.3），由 handle_retry 决策循环接管。
    async fn retake(&self, req: &mut ActionRequest) -> Result<RetryFlow, ActionError> {
        let version = self.snapshot.take_snapshot(&req.tab_id).await?;
        req.snapshot_version = version;
        match req.element.map(|el| el.index) {
            Some(index) => match self.snapshot.element_by_index(&req.tab_id, version, index) {
                Some(meta) => {
                    req.element = Some(ElementRef {
                        index,
                        backend_node_id: meta.backend_node_id,
                    });
                    Ok(RetryFlow::Continue)
                }
                None => Ok(RetryFlow::Done(Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("索引 [{index}] 在新快照（v{version}）中不存在（元素已消失，E2E-10）"),
                )))),
            },
            None => Ok(RetryFlow::Continue),
        }
    }
}

/// 重试流控制（execute_inner ↔ handle_retry 内部协议）。
pub(super) enum RetryFlow {
    /// 继续下一轮 run_once
    Continue,
    /// 终止并返回最终结果
    Done(Result<ActionSuccess, ActionError>),
}
