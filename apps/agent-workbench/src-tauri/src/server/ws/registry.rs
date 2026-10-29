//! WS 连接注册表实现（conn_id / 令牌 / 订阅 / 最近活动 + 踢出信号）。

use super::*;

impl WsRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WsRegistryInner {
                next_id: 1,
                conns: HashMap::new(),
                by_token: HashMap::new(),
            }),
        }
    }

    /// 注册新连接：全局上限检查 → 同令牌旧连接踢旧（duplicate-connection）
    /// → 入表。返回新连接 id 或上限拒绝。
    pub fn register(
        &self,
        token_hash: &str,
        label: &str,
        kill: watch::Sender<Option<String>>,
        now: u64,
    ) -> RegisterOutcome {
        let mut inner = lock(&self.inner);
        // 同令牌已有连接 → 踢旧（每设备一主连接，D2 §10.5）
        if let Some(old_id) = inner.by_token.get(token_hash).copied() {
            if let Some(old) = inner.conns.remove(&old_id) {
                tracing::info!(
                    target: "ws",
                    conn_id = old.conn_id,
                    label = %old.label,
                    "同令牌重复连接，踢出旧连接"
                );
                let _ = old.kill.send(Some(KICK_DUPLICATE.to_string()));
            }
            inner.by_token.remove(token_hash);
        }
        // 全局上限检查（D2 §10.5：超限拒绝新连接）
        if inner.conns.len() >= MAX_WS_CONNECTIONS {
            return RegisterOutcome::LimitExceeded;
        }
        let conn_id = inner.next_id;
        inner.next_id += 1;
        inner.conns.insert(
            conn_id,
            ConnInfo {
                conn_id,
                token_hash: token_hash.to_string(),
                label: label.to_string(),
                authenticated: false,
                connected_at_ms: now,
                last_frame_at_ms: now,
                sessions: HashSet::new(),
                subscribe_all: HashSet::new(),
                kill,
                out_tx: None,
                replaying: HashSet::new(),
                pending: HashMap::new(),
            },
        );
        inner.by_token.insert(token_hash.to_string(), conn_id);
        RegisterOutcome::Registered(conn_id)
    }

    /// 注销连接（sender task 收尾调用；幂等）
    pub fn unregister(&self, conn_id: u64) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.remove(&conn_id) {
            if inner.by_token.get(&conn.token_hash) == Some(&conn_id) {
                inner.by_token.remove(&conn.token_hash);
            }
            tracing::info!(target: "ws", conn_id, label = %conn.label, "连接注销");
        }
    }

    /// 刷新最近活动时刻（收到任何客户端帧时调用）
    pub fn touch(&self, conn_id: u64, now: u64) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.last_frame_at_ms = now;
        }
    }

    /// 最近活动时刻（None = 连接已注销；心跳 task 用）
    pub fn last_frame_at(&self, conn_id: u64) -> Option<u64> {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .map(|conn| conn.last_frame_at_ms)
    }

    /// 更新会话订阅（events.subscribe；整体替换）
    pub fn set_subscriptions(&self, conn_id: u64, sessions: Vec<String>) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.sessions = sessions.into_iter().collect();
        }
    }

    /// 更新全局轻订阅白名单（events.subscribeAll；整体替换）
    pub fn set_subscribe_all(&self, conn_id: u64, events: Vec<String>) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.subscribe_all = events.into_iter().collect();
        }
    }

    /// 订阅过滤器双元组快照（fanout 重建 SubscriptionFilter 用；
    /// 订阅变更时由连接侧调用）
    pub fn filter_parts(&self, conn_id: u64) -> (Vec<String>, Vec<String>) {
        let inner = lock(&self.inner);
        let Some(conn) = inner.conns.get(&conn_id) else {
            return (Vec::new(), Vec::new());
        };
        let mut sessions: Vec<String> = conn.sessions.iter().cloned().collect();
        sessions.sort();
        let mut global: Vec<String> = conn.subscribe_all.iter().cloned().collect();
        global.sort();
        (sessions, global)
    }

    /// 会话是否已订阅（resume 前置校验：未订阅 → stream.not_subscribed）
    pub fn is_subscribed(&self, conn_id: u64, session_id: &str) -> bool {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .is_some_and(|conn| conn.sessions.contains(session_id))
    }

    /// 标记会话进入重放（resume 处理开始；实时事件改入 pending）
    pub fn begin_replay(&self, conn_id: u64, session_id: &str) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.replaying.insert(session_id.to_string());
            conn.pending.entry(session_id.to_string()).or_default();
        }
    }

    /// 结束重放并取回 pending 实时事件（resume.done 后按序 flush）
    pub fn end_replay(
        &self,
        conn_id: u64,
        session_id: &str,
    ) -> VecDeque<(BackpressureLevel, String)> {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.replaying.remove(session_id);
            conn.pending.remove(session_id).unwrap_or_default()
        } else {
            VecDeque::new()
        }
    }

    /// 会话是否处于重放中（drain 侧判定入 pending）
    pub fn is_replaying(&self, conn_id: u64, session_id: &str) -> bool {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .is_some_and(|conn| conn.replaying.contains(session_id))
    }

    /// 重放期间实时事件入 pending（上限 [RESUME_PENDING_CAPACITY]；超限丢
    /// Delta 保 Critical——复用既有丢帧哲学，D2 §10.3）
    pub fn push_pending(
        &self,
        conn_id: u64,
        session_id: &str,
        payload: String,
        level: BackpressureLevel,
    ) {
        let mut inner = lock(&self.inner);
        let Some(conn) = inner.conns.get_mut(&conn_id) else {
            return;
        };
        let queue = conn.pending.entry(session_id.to_string()).or_default();
        if queue.len() >= RESUME_PENDING_CAPACITY {
            if level == BackpressureLevel::Delta {
                tracing::debug!(
                    target: "ws",
                    conn_id,
                    session_id,
                    "重放 pending 满，丢 Delta 实时帧"
                );
                return;
            }
            // Critical / Soft 必达：从队头挤掉最早帧（Delta 优先）再入队
            queue.pop_front();
        }
        queue.push_back((level, payload));
    }

    /// 踢出连接（发送踢出信号；sender task 发 kicked 帧后关闭并注销）
    pub fn kick(&self, conn_id: u64, reason: &str) -> bool {
        let inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get(&conn_id) {
            let _ = conn.kill.send(Some(reason.to_string()));
            true
        } else {
            false
        }
    }

    /// 按令牌哈希踢出（R1-07 设备撤销全链：撤销即时生效，D2 §10.6）；
    /// 返回被踢连接 id 列表
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn kick_by_token_hash(&self, token_hash: &str, reason: &str) -> Vec<u64> {
        let inner = lock(&self.inner);
        let Some(conn_id) = inner.by_token.get(token_hash).copied() else {
            return Vec::new();
        };
        if let Some(conn) = inner.conns.get(&conn_id) {
            let _ = conn.kill.send(Some(reason.to_string()));
            vec![conn_id]
        } else {
            Vec::new()
        }
    }

    /// 标记连接已认证（R1-11 G-2 两条路径）。
    pub fn mark_authenticated(&self, conn_id: u64, token_hash: &str, label: &str) -> bool {
        let mut inner = lock(&self.inner);
        let Some(conn) = inner.conns.get_mut(&conn_id) else {
            return false;
        };
        // 先克隆旧哈希并完成 conn 字段更新（NLL 在最后一次使用后结束借用），
        // 再操作 by_token 表——两把借用不交错（borrow 冲突收口）
        let old_hash = conn.token_hash.clone();
        conn.token_hash = token_hash.to_string();
        conn.label = label.to_string();
        conn.authenticated = true;
        if inner.by_token.get(&old_hash) == Some(&conn_id) {
            inner.by_token.remove(&old_hash);
        }
        inner.by_token.insert(token_hash.to_string(), conn_id);
        true
    }

    /// 连接是否已认证（配对升级连接完成 pair.hello 前 = false；相位门控
    /// 消费：未认证连接仅放行 pair.hello，其余 kind → auth.unknown_device）
    pub fn is_authenticated(&self, conn_id: u64) -> bool {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .is_some_and(|conn| conn.authenticated)
    }

    /// 当前连接数
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn count(&self) -> usize {
        lock(&self.inner).conns.len()
    }

    /// 连接快照（R1-08 设备管理页 / workbench_pairing_status.connections；
    /// label + 最近活动时间，D2 §10.5）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn snapshot(&self) -> Vec<ConnSnapshot> {
        lock(&self.inner)
            .conns
            .values()
            .map(|conn| ConnSnapshot {
                conn_id: conn.conn_id,
                label: conn.label.clone(),
                connected_at_ms: conn.connected_at_ms,
                last_frame_at_ms: conn.last_frame_at_ms,
                subscribed_count: conn.sessions.len(),
            })
            .collect()
    }

    /// 连接建立时刻（测试 / 诊断用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn connected_at(&self, conn_id: u64) -> Option<u64> {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .map(|conn| conn.connected_at_ms)
    }

    /// 连接标签（测试 / 诊断用）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn label_of(&self, conn_id: u64) -> Option<String> {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .map(|conn| conn.label.clone())
    }

    /// 注入连接出站通道（R3-02 推送直投数据面：handle_socket 创建 channel
    /// 后调用；未注入前直投按无通道处理）
    pub fn attach_outbound(&self, conn_id: u64, out_tx: mpsc::Sender<Outbound>) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.out_tx = Some(out_tx);
        }
    }

    /// 设备活跃快照（R3-02 DevicePresenceSource 适配数据源：token_hash +
    /// label + 最近活动时刻，对齐 push::online::DeviceActivity 字段形状；
    /// 连接关闭即不在列表——R1-05 断线清理语义）
    pub fn device_activities(&self) -> Vec<(String, String, u64)> {
        lock(&self.inner)
            .conns
            .values()
            .map(|conn| {
                (
                    conn.token_hash.clone(),
                    conn.label.clone(),
                    conn.last_frame_at_ms,
                )
            })
            .collect()
    }

    /// 直推 events.push 帧到指定令牌设备（R3-02 PushChannel 消费；M8 裁决
    /// 修正 2——复用 R1 事件面 outbound_frame 信封构造，from=desktop →
    /// to=mobile，body 为 EventsPush 载荷）。
    pub fn send_push_frame(&self, token_hash: &str, body: Value) -> Option<bool> {
        let inner = lock(&self.inner);
        let conn_id = inner.by_token.get(token_hash).copied()?;
        let conn = inner.conns.get(&conn_id)?;
        let out_tx = conn.out_tx.as_ref()?;
        let frame = outbound_frame(conn_id, MessageKind::EventsPush, body);
        Some(
            out_tx
                .try_send(Outbound::Frame(axum::extract::ws::Message::Text(
                    frame.into(),
                )))
                .is_ok(),
        )
    }
}

impl Default for WsRegistry {
    fn default() -> Self {
        Self::new()
    }
}
