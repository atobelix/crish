//! run/run_retry.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。
use super::*;
/// D1 §3.2.1：`provider_fail_streak` 键形状（05 形状冻结；字段 snake_case，
/// 02-定夺 S1）。宽容解析 fail-open：坏 JSON / 缺字段 → count=0。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct ProviderFailStreak {
    /// 当前连续失败计数（瞬态类）
    pub count: u32,
    /// 首次失败时刻（epoch ms）
    pub first_fail_at_ms: i64,
    /// 最近一次失败时刻（epoch ms）
    pub last_fail_at_ms: i64,
    /// 窗口配置（0 = 无窗口；>0 时读侧惰性过期判定，D1 §3.2.1）
    pub window_ms: u64,
}

impl ProviderFailStreak {
    /// 清零形态（成功面，C3）
    pub(crate) fn cleared(now_ms: u64) -> Self {
        Self {
            count: 0,
            first_fail_at_ms: 0,
            last_fail_at_ms: now_ms as i64,
            window_ms: PROVIDER_FAIL_WINDOW_MS_DEFAULT,
        }
    }

    /// 宽容解析（fail-open：缺键 / 坏 JSON / 缺字段 → count=0）
    pub(crate) fn from_json(raw: Option<&str>) -> Self {
        raw.and_then(|raw| serde_json::from_str::<ProviderFailStreak>(raw).ok())
            .unwrap_or_else(|| Self::cleared(0))
    }

    pub(crate) fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 连续失败 +1（首次失败填充 first_fail_at）
    pub(crate) fn record_failure(&mut self, now_ms: u64) {
        if self.count == 0 {
            self.first_fail_at_ms = now_ms as i64;
        }
        self.count = self.count.saturating_add(1);
        self.last_fail_at_ms = now_ms as i64;
    }

    /// 读取侧惰性过期（window_ms > 0 且超窗 → 视为清零，D1 §3.2.1）
    pub(crate) fn effective_count(&self, now_ms: u64) -> u32 {
        if self.window_ms > 0
            && self.first_fail_at_ms > 0
            && now_ms >= self.first_fail_at_ms as u64
            && now_ms - self.first_fail_at_ms as u64 >= self.window_ms
        {
            0
        } else {
            self.count
        }
    }
}

/// D2 §3.3：带唤醒源类型的操作指纹（裁决 #8：同注入模板 = 同任务会
/// 混淆不同唤醒源；source 参与哈希输入，与 task 字节间以 0x00 分隔）。
///
/// 复刻 recovery.rs fingerprint 的 FNV-1a 循环（同参数防漂移）；D2 §3.3
/// 建议 recovery.rs 新增三参变体，本轮文件域限制实现于壳层。
pub(crate) fn fingerprint_with_source(subagent_id: &str, task: &str, source: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in subagent_id.as_bytes().iter().chain(&[0u8]) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    for byte in task.as_bytes().iter().chain(&[0u8]) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    for byte in source.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
    format!("{hash:016x}")
}

/// D1 §3.1.4：`provider_retry_backoff_ms` 键纯解析（可单测；宽容
/// fail-open）：
/// - JSON 数组 [base, max, budget] → 三字段全量配置；
/// - JSON 单数值 base → 仅 base 定制（max/budget None 回落内核常量）；
/// - 其余形状 / 坏 JSON → None（不装配 = 现状立即重试向后兼容）。
pub(crate) fn parse_retry_backoff_config(
    raw: &str,
) -> Option<session_loop::r#loop::RetryBackoffConfig> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    match value {
        serde_json::Value::Number(n) => Some(session_loop::r#loop::RetryBackoffConfig {
            base_ms: n.as_u64(),
            max_ms: None,
            total_budget_ms: None,
        }),
        serde_json::Value::Array(items) => {
            let mut nums = items.iter().filter_map(|item| item.as_u64());
            let base_ms = nums.next();
            let max_ms = nums.next();
            let total_budget_ms = nums.next();
            base_ms.map(|base_ms| session_loop::r#loop::RetryBackoffConfig {
                base_ms: Some(base_ms),
                max_ms,
                total_budget_ms,
            })
        }
        _ => None,
    }
}

/// D2 §3.4（C4 锁死）：跨 run 续 run 退避延迟注入点类型（attempt =
/// 本次消费后的预算计数；测试直接驱动，不依赖 tokio pause）
pub(crate) type BackoffDelayFn = Arc<dyn Fn(u32) -> Duration + Send + Sync>;

/// D3 §3.2.2：阶梯 1 恢复计划（C7 决策的壳层执行载体——AutoRetry 时
/// 携带退避 delay、重入上下文与协调器引用，供收口后重派执行）
pub(crate) enum RecoveryPlan {
    /// 预算内自动重试（重试不计入 run 失败；delay 已钳到单次上限与
    /// 剩余预算）
    AutoRetry {
        /// 重试前等待时长
        delay: Duration,
        /// run 失败上下文（重派请求与 escalate 重入共用）
        ctx: RunFailureContext,
        /// 会话恢复协调器（重入 escalate 用）
        coord: Arc<tokio::sync::Mutex<RecoveryCoordinator>>,
    },
}

impl CoreRunState {
    /// D3 §3.5：跨 run 阶梯 1 已重派次数（(session_id, fingerprint) 键；
    /// 进程内记账，重启清零——阶梯 1 不留痕是既有语义，recovery.rs:1801
    /// -1803 测试锁定）。retries 语义 = 该任务跨 run 已重试次数，与 run
    /// 内 provider_error.retries 是两套独立计数（D3 §8 决策 1）。
    pub(crate) fn ladder1_retry_count(&self, session_id: &str, fp: &str) -> u32 {
        self.ladder1_retries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(session_id.to_string(), fp.to_string()))
            .copied()
            .unwrap_or(0)
    }

    /// D3 §3.5：重派成功后计数 +1（AutoRetry 实际拉起）
    pub(crate) fn bump_ladder1_retry(&self, session_id: &str, fp: &str) -> u32 {
        let mut map = self
            .ladder1_retries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = map
            .entry((session_id.to_string(), fp.to_string()))
            .or_insert(0);
        *entry += 1;
        *entry
    }

    /// D3 §3.5：spawn 失败（含 16/16/1 守卫拒绝）→ 计数推满（重入
    /// [RecoveryCoordinator::on_subagent_run_failure] 必 Escalate 上阶梯 2，
    /// 不静默、无假重试）
    pub(crate) fn force_ladder1_retry_max(&self, session_id: &str, fp: &str) {
        let max = self.ladder1_max_retries_config();
        let mut map = self
            .ladder1_retries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *map.entry((session_id.to_string(), fp.to_string()))
            .or_insert(0) = max;
    }

    /// D3 §4.1：阶梯 1 跨 run 重试次数配置解析（可配键缺省 2；与
    /// coordinator_for 装配口径同源，保证「推满 = 必然 Escalate」判定一致）
    pub(crate) fn ladder1_max_retries_config(&self) -> u32 {
        let Some(db) = self.local_db() else {
            return RECOVER_LADDER1_MAX_RETRIES_DEFAULT;
        };
        db.get_session_meta(RECOVER_LADDER1_MAX_RETRIES_KEY)
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(RECOVER_LADDER1_MAX_RETRIES_DEFAULT)
    }
}

impl CoreRunState {
    // ── D6：会话级 user_stopped + 每会话唤醒 watcher（无人值守最后一跳）──

    /// D6 §8 决策 1：设置会话级用户停止标记（用户 L2/L3 停止路径调用；
    /// 同步到该会话 watcher 实例——watcher 判定与 decide_idle_resume
    /// 共享同一跨 run 语义；不落库，重启天然消失）
    pub(crate) fn set_user_stopped(&self, session_id: &str) {
        let now = now_ms_internal();
        *self
            .user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(session_id.to_string())
            .or_insert(0) = now;
        if let Some(watcher) = self
            .wake_watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
        {
            watcher.set_user_stopped_at(now);
        }
    }

    /// D6 §8 决策 1：清除会话级用户停止标记（用户新 run 装配成功后
    /// 调用——用户新 run = 显式授权恢复自动行为；idle-resume/子代理
    /// run 不写不清，停止语义跨 run 存活直到用户介入）
    pub(crate) fn clear_user_stopped(&self, session_id: &str) {
        self.user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
        if let Some(watcher) = self
            .wake_watchers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
        {
            watcher.clear_user_stopped();
        }
    }

    /// D6 §4.2：会话级用户停止标记是否存在（decide_idle_resume 与
    /// watcher 判定共享的读面）
    pub(crate) fn is_user_stopped(&self, session_id: &str) -> bool {
        self.user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(session_id)
    }
}

impl CoreRunState {
    /// D6 §3.2 spawn 点 1/2：每会话唤醒 watcher 惰性 spawn（幂等持有——
    /// 已存在返回 false 不重复 spawn）。注入件：
    /// - queue = [Self::pending_queue]（与 TimerRegistry / watchdog 同一
    ///   实例）；
    /// - has_active_run = active_runs 锁内同会话扫描（拉起前检查；串行
    ///   守卫由 run_task_impl 兜底拒绝并发双拉，验收 A5）；
    /// - empty_streak = [Self::resume_empty_streak] 只读（计数由收口
    ///   decide_idle_resume 维护，W2 按唤醒源区分，watcher 只读判停）；
    /// - launcher = [spawn_idle_resume_run] 包装（空 Vec 注入——队列条目
    ///   由新 run 收口时 decide_idle_resume drain，D6 §8 决策 2 路径①，
    ///   wake_watcher.rs 装配注记）。
    ///
    /// 首轮延迟 5s + 最小拉 run 间隔 10s（WakeWatcherOptions 缺省）。
    /// 无 tokio runtime（非 async 上下文）→ 跳过 spawn（对齐
    /// engine.rs:1313-1320 watchdog 先例）。
    pub(crate) fn ensure_wake_watcher(self: &Arc<Self>, session_id: &str) -> bool {
        // 幂等：已存在 → false（不重复 spawn）
        {
            let map = self.wake_watchers.lock().unwrap_or_else(|e| e.into_inner());
            if map.contains_key(session_id) {
                return false;
            }
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::debug!(
                target: "wake_watcher",
                session_id,
                "唤醒 watcher 跳过 spawn：当前上下文无 tokio runtime"
            );
            return false;
        };
        let watcher = self.build_wake_watcher(session_id);
        let started = watcher.start(&runtime);
        // 同步 user_stopped（停止标记先于 watcher 创建的场景——watcher
        // 幂等持有期间 L2/L3 停止经 set_user_stopped 同步；此处兜底
        // watcher 晚于停止创建的情形）
        if let Some(at) = self
            .user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
        {
            watcher.set_user_stopped_at(at);
        }
        // double-check（并发双构造丢弃后到者，对齐 coordinator_for 先例）
        let mut map = self.wake_watchers.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(session_id) {
            watcher.stop();
            return false;
        }
        map.insert(session_id.to_string(), watcher);
        started
    }

    /// D6 §3.2：构造会话 watcher（注入件闭包全部经 Weak 引用——
    /// CoreRunState ↔ watcher 互相持有会构成 Arc 强引用环泄漏）
    pub(crate) fn build_wake_watcher(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Arc<crate::wake_watcher::WakeWatcher> {
        let queue = Arc::clone(&self.pending_queue);
        let weak_active = Arc::downgrade(self);
        let has_active_run: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(move |sid: &str| {
            weak_active
                .upgrade()
                .map(|state| {
                    state
                        .active_runs
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .values()
                        .any(|run| run.session_id == sid)
                })
                .unwrap_or(false)
        });
        let weak_streak = Arc::downgrade(self);
        let empty_streak: Arc<dyn Fn(&str) -> u32 + Send + Sync> = Arc::new(move |sid: &str| {
            weak_streak
                .upgrade()
                .map(|state| {
                    state
                        .resume_empty_streak
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(sid)
                        .copied()
                        .unwrap_or(0)
                })
                .unwrap_or(0)
        });
        let weak_launcher = Arc::downgrade(self);
        let launcher: crate::wake_watcher::WakeLauncher = Arc::new(move |sid: String| {
            let weak = weak_launcher.clone();
            Box::pin(async move {
                let Some(state) = weak.upgrade() else {
                    return;
                };
                // D6 §8 决策 2 路径①：空 Vec 注入——队列条目由新 run 收口
                // 时 decide_idle_resume drain（wake_watcher.rs 装配注记）；
                // D7 摘要注入在 spawn_idle_resume_run 内统一拼接
                idle_resume::spawn_idle_resume_run(state, sid, "idle-resume", Vec::new()).await;
            })
        });
        Arc::new(crate::wake_watcher::WakeWatcher::new(
            session_id.to_string(),
            queue,
            has_active_run,
            empty_streak,
            launcher,
            crate::wake_watcher::WakeWatcherOptions::default(),
        ))
    }
}

impl CoreRunState {
    // ── D1/D2/D5：壳层恢复面（熔断计数 / goal_state / 退避注入）─────

    /// D1 §3.2.4：熔断闸查询（读 `provider_fail_streak` 键 count 字段；
    /// count >= 阈值 → true；fail-open：坏 JSON / 缺字段 → count=0）。
    ///
    /// 落点 ① transient_retry 入口（经 [Self::provider_fail_streak_count]
    /// 装配进 SessionLoopOptions，D1 §3.2.3）；落点 ② decide_idle_resume
    /// error 分支与 E1 续写分支（02-定夺 S2：两处共用同一查询面）。
    pub(crate) async fn circuit_breaker_is_tripped(&self, _session_id: &str) -> bool {
        let Some(db) = self.local_db() else {
            return false;
        };
        let threshold = self.provider_fail_threshold_config(&db);
        tokio::task::spawn_blocking(move || {
            let raw = db.get_session_meta(PROVIDER_FAIL_STREAK_KEY).ok().flatten();
            let streak = ProviderFailStreak::from_json(raw.as_deref());
            streak.effective_count(now_ms_internal()) >= threshold
        })
        .await
        .unwrap_or(false)
    }

    /// D1 §3.2.2（S2）：收口熔断计数更新（唯一写方；spawn_blocking 读-改-
    /// 写键）。`transient_failure = true` → 连续失败 +1（部分保留断流计入）；
    /// false → 清零（规则 C3：仅 run 以非瞬态错误收场或正常完成时执行）。
    ///
    /// 返回是否本次更新**跨过**阈值（熔断触发边沿；调用方负责发射
    /// runtime-intervention-required + recovery-escalated 观测事件）。
    pub(crate) async fn update_provider_fail_streak(
        &self,
        _session_id: &str,
        transient_failure: bool,
    ) -> bool {
        let Some(db) = self.local_db() else {
            return false;
        };
        let threshold = self.provider_fail_threshold_config(&db);
        tokio::task::spawn_blocking(move || {
            let raw = db.get_session_meta(PROVIDER_FAIL_STREAK_KEY).ok().flatten();
            let mut streak = ProviderFailStreak::from_json(raw.as_deref());
            let now = now_ms_internal();
            let before = streak.effective_count(now);
            if transient_failure {
                streak.record_failure(now);
            } else {
                streak = ProviderFailStreak::cleared(now);
            }
            if db
                .set_session_meta(PROVIDER_FAIL_STREAK_KEY, &streak.to_json())
                .is_err()
            {
                return false;
            }
            before < threshold && streak.count >= threshold
        })
        .await
        .unwrap_or(false)
    }

    /// D1 §3.1.4：熔断阈值配置解析（`provider_fail_threshold` 键，缺省 6；
    /// 与 stream_error.rs PROVIDER_FAIL_THRESHOLD 同值防漂移）
    pub(crate) fn provider_fail_threshold_config(&self, db: &LocalDb) -> u32 {
        db.get_session_meta(PROVIDER_FAIL_THRESHOLD_KEY)
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<u32>().ok())
            .unwrap_or(PROVIDER_FAIL_THRESHOLD_DEFAULT)
    }

    /// D1 §3.2.3：熔断计数当前值（run 装配面注入 SessionLoopOptions
    /// provider_fail_streak——transient_retry 入口闸 C1 输入；无键 → None
    /// = 不启用闸，向后兼容）
    pub(crate) async fn provider_fail_streak_count(&self, _session_id: &str) -> Option<u32> {
        let db = self.local_db()?;
        tokio::task::spawn_blocking(move || {
            let raw = db.get_session_meta(PROVIDER_FAIL_STREAK_KEY).ok().flatten();
            let streak = ProviderFailStreak::from_json(raw.as_deref());
            let count = streak.effective_count(now_ms_internal());
            (count > 0).then_some(count)
        })
        .await
        .ok()
        .flatten()
    }

    /// D1 §3.1.4（R6）：瞬态重试退避配置读取（run 装配面注入
    /// SessionLoopOptions.retry_backoff——Some 时内核退避
    /// 750ms×2^(n-1)/8s 封顶/60s 预算生产生效；None = 现状立即重试
    /// 向后兼容）。键 = `provider_retry_backoff_ms`，形状 = JSON 数组
    /// [base, max, budget] 或单值 base（宽容解析：坏值 → None fail-open，
    /// 不阻断装配）。
    pub(crate) fn retry_backoff_config(
        &self,
        _session_id: &str,
    ) -> Option<session_loop::r#loop::RetryBackoffConfig> {
        let db = self.local_db()?;
        let raw = db
            .get_session_meta(PROVIDER_RETRY_BACKOFF_MS_KEY)
            .ok()
            .flatten()?;
        parse_retry_backoff_config(&raw)
    }
}

impl CoreRunState {
    /// D2 §3.4（C4 锁死）：跨 run 退避延迟（注入点存在 → 注入函数直取
    /// 测试驱动；None → 镜像 recovery.rs 常量 750→1500→3000，8s 封顶）
    pub(crate) fn backoff_delay_for(&self, attempt: u32) -> Duration {
        if let Some(f) = self
            .resume_backoff
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return f(attempt);
        }
        backoff_delay_ms(&RecoveryRetryPolicy::default(), attempt)
    }

    /// D2 §3.4：退避睡眠（注入点存在 = 测试驱动模式，跳过真实睡眠；
    /// 生产经 tokio::time::sleep 等待）
    pub(crate) async fn sleep_resume_backoff(&self, delay: Duration) {
        let injected = self
            .resume_backoff
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some();
        if injected {
            return;
        }
        tokio::time::sleep(delay).await;
    }
}
