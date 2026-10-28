//! 会话历史 LRU 缓存（Session History LRU Cache）
//!
//! 核心设计与长程连续运行内存治理（03-context-and-resilience-improvement.md §四）：
//! 1. **内存真源治理**：
//!    跨昼夜连续运行时，跨 Run 历史消息若无界堆积在内存中会导致进程驻留集（RSS）持续膨胀。
//!    本模块通过基于 LRU（最近最少使用）策略的淘汰机制，将常驻会话历史严格约束在预设上限内
//!    （默认 [`MAX_CACHED_SESSIONS_DEFAULT`] = 16），将历史缓存常驻内存死锁在 ≤ 50MB。
//! 2. **真源保卫与淘汰语义**：
//!    内存淘汰纯属物理内存释放（Drop 堆内存），绝不改写、覆盖或删除底层 SQLite `events` 表。
//!    单 Run 内部的 `LoopState.events` 保持全量事件累加，在 Run 结束时完整移交持久化；
//!    当被淘汰的会话在未来再次被唤醒发起 Run 时，调度层透明自动从 SQLite 重新读取并反序列化水合，
//!    实现「内存有界、真源完整、自动回填」。
//! 3. **并发与线程安全**：
//!    基于 [`std::sync::Mutex`] 保护 LRU 状态机与条目字典，提供无死锁、无竞争的干净接口。
//! 4. **完全 LRU 访问序刷新**：
//!    无论是写入（[`SessionHistoryLruCache::store`]）还是命中读取
//!    （[`SessionHistoryLruCache::get`] / [`SessionHistoryLruCache::get_hydrated`]），
//!    均将目标会话原子更新至最近使用（MRU）端，淘汰端始终严格弹出最久未访问（LRU）的会话。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use conex_types::history::HistoryMessage;
use conex_types::message::AgentMessage;

use super::hydrate_history;

/// 默认最大缓存会话数（长程连续运行中内存治理基线，保证常驻内存 <= 50MB）
pub const MAX_CACHED_SESSIONS_DEFAULT: usize = 16;

/// 会话历史 LRU 缓存
///
/// 内部通过 [`Mutex`] 保护并发访问，所有接口均接受 `&self`，天生具备线程安全。
#[derive(Debug)]
pub struct SessionHistoryLruCache {
    /// 缓存容量上限（会话数量）
    capacity: usize,
    /// 受互斥锁保护的 LRU 内部状态
    inner: Mutex<LruInner>,
}

/// LRU 内部结构体
#[derive(Debug)]
struct LruInner {
    /// 会话 ID 到历史消息列表的映射
    entries: HashMap<String, Vec<HistoryMessage>>,
    /// 访问时间序双端队列：front 为最久未访问（LRU，淘汰端），back 为最近访问（MRU）
    order: VecDeque<String>,
}

impl Default for SessionHistoryLruCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionHistoryLruCache {
    /// 创建默认容量（[`MAX_CACHED_SESSIONS_DEFAULT`] = 16）的会话历史 LRU 缓存
    pub fn new() -> Self {
        Self::with_capacity(MAX_CACHED_SESSIONS_DEFAULT)
    }

    /// 创建指定容量上限的会话历史 LRU 缓存
    ///
    /// 若 `capacity == 0`，自动校正为 1，确保至少能容纳 1 个活跃会话并防范算术异常。
    pub fn with_capacity(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            inner: Mutex::new(LruInner {
                entries: HashMap::with_capacity(capacity),
                order: VecDeque::with_capacity(capacity),
            }),
        }
    }

    /// 获取缓存容量上限
    #[inline]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// 当前缓存中的会话数量
    pub fn len(&self) -> usize {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.len()
    }

    /// 缓存是否为空
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 检查某会话是否在缓存中（纯只读探测，不变更 LRU 访问序）
    pub fn contains(&self, session_id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.contains_key(session_id)
    }

    /// 只读窥探会话历史（不改变 LRU 访问序）
    pub fn peek(&self, session_id: &str) -> Option<Vec<HistoryMessage>> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.get(session_id).cloned()
    }

    /// 显式刷新某个已存在会话的访问顺序至最新（MRU）
    ///
    /// 若会话在缓存中，返回 `true` 并刷新；若不存在返回 `false`。
    pub fn touch(&self, session_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.entries.contains_key(session_id) {
            touch_order(&mut inner.order, session_id);
            true
        } else {
            false
        }
    }

    /// 读取会话历史
    ///
    /// 核心行为：
    /// - 若命中：将该 `session_id` 提升至最新访问（MRU）队尾，并返回消息列表的拷贝；
    /// - 若未命中：返回 `None`（调度层可回退至从持久化 SQLite 事件流中重新反序列化水合）。
    pub fn get(&self, session_id: &str) -> Option<Vec<HistoryMessage>> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(messages) = inner.entries.get(session_id).cloned() {
            touch_order(&mut inner.order, session_id);
            Some(messages)
        } else {
            None
        }
    }

    /// 读取并就地水合为 `Vec<Arc<AgentMessage>>`
    ///
    /// 命中时刷新 LRU 序列，并通过 [`hydrate_history`] 映射为直接供运行循环使用的消息序列；
    /// 未命中时返回 `None`。
    pub fn get_hydrated(&self, session_id: &str) -> Option<Vec<Arc<AgentMessage>>> {
        self.get(session_id).map(hydrate_history)
    }

    /// 写入/更新指定会话的历史消息
    ///
    /// 核心行为：
    /// 1. 刷新或插入该 `session_id` 至最新访问（MRU）队尾；
    /// 2. 更新内存字典中的消息数据；
    /// 3. 若缓存条目总数超过 `capacity`，从队头弹出最旧的会话（LRU）并彻底释放其内存；
    /// 4. 淘汰动作纯属内存释放，绝不改写或删除底层 SQLite 事件库。
    pub fn store(&self, session_id: &str, messages: Vec<HistoryMessage>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        // 刷新/记录访问顺序至队尾 (MRU)
        touch_order(&mut inner.order, session_id);
        inner.entries.insert(session_id.to_string(), messages);

        // 超额淘汰检查
        while inner.order.len() > self.capacity {
            if let Some(oldest_id) = inner.order.pop_front() {
                let removed = inner.entries.remove(&oldest_id);
                if removed.is_some() {
                    tracing::debug!(
                        target: "hydrate::cache",
                        evicted_session = %oldest_id,
                        capacity = self.capacity,
                        "SessionHistoryLruCache: 内存淘汰最旧会话历史条目（纯属内存释放，SQLite 事件持久化真源完好）"
                    );
                }
            }
        }
    }

    /// 从缓存中显式移除某会话（例如会话显式销毁或清空缓存）
    pub fn remove(&self, session_id: &str) -> Option<Vec<HistoryMessage>> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = inner.order.iter().position(|id| id == session_id) {
            inner.order.remove(pos);
        }
        inner.entries.remove(session_id)
    }

    /// 清空整个缓存
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.clear();
        inner.order.clear();
    }

    /// 窥视当前最旧（最可能被下一个淘汰）的会话 ID
    pub fn oldest_session(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.order.front().cloned()
    }

    /// 窥视当前最新（最近访问）的会话 ID
    pub fn newest_session(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.order.back().cloned()
    }

    /// 手动淘汰最旧的会话历史（若有）
    pub fn evict_oldest(&self) -> Option<(String, Vec<HistoryMessage>)> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(oldest_id) = inner.order.pop_front() {
            if let Some(msgs) = inner.entries.remove(&oldest_id) {
                return Some((oldest_id, msgs));
            }
        }
        None
    }
}

/// 辅助纯函数：将 session_id 移至队列末尾（MRU）
#[inline]
fn touch_order(order: &mut VecDeque<String>, session_id: &str) {
    if let Some(pos) = order.iter().position(|id| id == session_id) {
        order.remove(pos);
    }
    order.push_back(session_id.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_message(id: &str, sender: &str, text: &str) -> HistoryMessage {
        HistoryMessage {
            id: id.to_string(),
            sender: sender.to_string(),
            text: Some(text.to_string()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_000,
        }
    }

    #[test]
    fn default_capacity_and_initial_state() {
        let cache = SessionHistoryLruCache::new();
        assert_eq!(cache.capacity(), MAX_CACHED_SESSIONS_DEFAULT);
        assert_eq!(cache.len(), 0);
        assert!(cache.is_empty());
        assert_eq!(cache.oldest_session(), None);
        assert_eq!(cache.newest_session(), None);
    }

    #[test]
    fn custom_capacity_clamps_zero_to_one() {
        let cache = SessionHistoryLruCache::with_capacity(0);
        assert_eq!(cache.capacity(), 1);
    }

    #[test]
    fn basic_store_and_get() {
        let cache = SessionHistoryLruCache::with_capacity(3);
        let msgs = vec![
            dummy_message("m1", "user", "hello"),
            dummy_message("m2", "assistant", "world"),
        ];

        cache.store("session-1", msgs.clone());
        assert_eq!(cache.len(), 1);
        assert!(cache.contains("session-1"));
        assert!(!cache.contains("session-2"));

        let retrieved = cache.get("session-1").expect("应命中缓存");
        assert_eq!(retrieved.len(), 2);
        assert_eq!(retrieved[0].text.as_deref(), Some("hello"));
        assert_eq!(retrieved[1].text.as_deref(), Some("world"));

        // 未命中测试
        assert!(cache.get("session-none").is_none());
    }

    #[test]
    fn get_refreshes_lru_order() {
        let cache = SessionHistoryLruCache::with_capacity(3);

        cache.store("s1", vec![dummy_message("1", "user", "1")]);
        cache.store("s2", vec![dummy_message("2", "user", "2")]);
        cache.store("s3", vec![dummy_message("3", "user", "3")]);

        // 当前顺序 (旧 -> 新): s1, s2, s3
        assert_eq!(cache.oldest_session().as_deref(), Some("s1"));
        assert_eq!(cache.newest_session().as_deref(), Some("s3"));

        // 访问最旧的 s1，此时 s1 应当跃升为最新，顺序变为: s2, s3, s1
        let _ = cache.get("s1");
        assert_eq!(cache.oldest_session().as_deref(), Some("s2"));
        assert_eq!(cache.newest_session().as_deref(), Some("s1"));

        // 写入新会话 s4，容量上限为 3，应当淘汰当前最旧的 s2！
        cache.store("s4", vec![dummy_message("4", "user", "4")]);
        assert_eq!(cache.len(), 3);
        assert!(!cache.contains("s2"), "s2 应已被 LRU 淘汰");
        assert!(cache.contains("s1"), "s1 因被访问过应保留");
        assert!(cache.contains("s3"), "s3 应保留");
        assert!(cache.contains("s4"), "s4 应保留");

        // 当前顺序: s3, s1, s4
        assert_eq!(cache.oldest_session().as_deref(), Some("s3"));
        assert_eq!(cache.newest_session().as_deref(), Some("s4"));
    }

    #[test]
    fn store_existing_session_updates_and_refreshes_mru() {
        let cache = SessionHistoryLruCache::with_capacity(2);

        cache.store("s1", vec![dummy_message("1", "user", "old_1")]);
        cache.store("s2", vec![dummy_message("2", "user", "2")]);

        // 再次 store s1，更新内容并刷新至 MRU
        cache.store("s1", vec![dummy_message("1", "user", "new_1")]);
        assert_eq!(cache.oldest_session().as_deref(), Some("s2"));
        assert_eq!(cache.newest_session().as_deref(), Some("s1"));

        // 写入 s3，应淘汰 s2
        cache.store("s3", vec![dummy_message("3", "user", "3")]);
        assert_eq!(cache.len(), 2);
        assert!(!cache.contains("s2"));
        assert!(cache.contains("s1"));
        assert!(cache.contains("s3"));

        let s1_msgs = cache.get("s1").unwrap();
        assert_eq!(s1_msgs[0].text.as_deref(), Some("new_1"));
    }

    #[test]
    fn peek_and_contains_do_not_alter_order() {
        let cache = SessionHistoryLruCache::with_capacity(3);

        cache.store("s1", vec![dummy_message("1", "user", "1")]);
        cache.store("s2", vec![dummy_message("2", "user", "2")]);

        // 检查 contains 与 peek
        assert!(cache.contains("s1"));
        let peeked = cache.peek("s1").expect("peek 应返回值");
        assert_eq!(peeked[0].id, "1");

        // 顺序应当保持不变: s1 (旧) -> s2 (新)
        assert_eq!(cache.oldest_session().as_deref(), Some("s1"));
        assert_eq!(cache.newest_session().as_deref(), Some("s2"));
    }

    #[test]
    fn touch_explicitly_refreshes_order() {
        let cache = SessionHistoryLruCache::with_capacity(2);
        cache.store("s1", vec![dummy_message("1", "user", "1")]);
        cache.store("s2", vec![dummy_message("2", "user", "2")]);

        assert!(cache.touch("s1"));
        assert!(!cache.touch("s_not_found"));

        assert_eq!(cache.oldest_session().as_deref(), Some("s2"));
        assert_eq!(cache.newest_session().as_deref(), Some("s1"));
    }

    #[test]
    fn remove_and_clear_work_cleanly() {
        let cache = SessionHistoryLruCache::with_capacity(3);
        cache.store("s1", vec![dummy_message("1", "user", "1")]);
        cache.store("s2", vec![dummy_message("2", "user", "2")]);

        let removed = cache.remove("s1").expect("应成功移除");
        assert_eq!(removed[0].id, "1");
        assert_eq!(cache.len(), 1);
        assert!(!cache.contains("s1"));
        assert_eq!(cache.oldest_session().as_deref(), Some("s2"));

        cache.clear();
        assert_eq!(cache.len(), 0);
        assert!(cache.is_empty());
        assert_eq!(cache.oldest_session(), None);
    }

    #[test]
    fn evict_oldest_manually() {
        let cache = SessionHistoryLruCache::with_capacity(3);
        cache.store("s1", vec![dummy_message("1", "user", "1")]);
        cache.store("s2", vec![dummy_message("2", "user", "2")]);

        let evicted = cache.evict_oldest().expect("应淘汰最旧");
        assert_eq!(evicted.0, "s1");
        assert_eq!(cache.len(), 1);
        assert!(!cache.contains("s1"));
        assert!(cache.contains("s2"));
    }

    #[test]
    fn get_hydrated_returns_agent_messages_and_refreshes_lru() {
        let cache = SessionHistoryLruCache::with_capacity(2);
        let msgs = vec![
            dummy_message("u1", "user", "用户问题"),
            dummy_message("a1", "assistant", "模型回答"),
        ];
        cache.store("s1", msgs);
        cache.store("s2", vec![dummy_message("u2", "user", "问题2")]);

        // get_hydrated s1
        let hydrated = cache.get_hydrated("s1").expect("应成功水合");
        assert_eq!(hydrated.len(), 2);
        assert_eq!(hydrated[0].id, "u1");
        assert_eq!(hydrated[0].content.as_deref(), Some("用户问题"));
        assert_eq!(hydrated[1].id, "a1");
        assert_eq!(hydrated[1].content.as_deref(), Some("模型回答"));

        // 验证访问后 s1 刷新为最新，最旧变为 s2
        assert_eq!(cache.oldest_session().as_deref(), Some("s2"));
        assert_eq!(cache.newest_session().as_deref(), Some("s1"));
    }

    #[test]
    fn multithreaded_concurrent_access_is_safe() {
        let cache = Arc::new(SessionHistoryLruCache::with_capacity(8));
        let mut handles = Vec::new();

        for i in 0..16 {
            let cache_clone = Arc::clone(&cache);
            let handle = std::thread::spawn(move || {
                let session_id = format!("session-{}", i % 6);
                for step in 0..50 {
                    let msg = vec![dummy_message(
                        &format!("m-{i}-{step}"),
                        "user",
                        "concurrent text",
                    )];
                    cache_clone.store(&session_id, msg);
                    let _ = cache_clone.get(&session_id);
                    let _ = cache_clone.peek(&session_id);
                    let _ = cache_clone.contains(&session_id);
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.join().expect("线程应正常结束，无死锁无 panic");
        }

        assert!(cache.len() <= 8, "会话数量必须受上限约束");
    }
}
