//! 定时器持久化存储抽象与实现（内存版与 LocalDb 真适配）

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use conex_db::LocalDb;
use conex_types::timer::TimerDeclaration;

/// session_meta 持久化键前缀（`timer_<id>` 键）
pub const SESSION_META_TIMER_KEY_PREFIX: &str = "timer_";
/// 索引键（timer id 列表；conex-db 暂无 session_meta 键扫描 API，
/// 索引键保证可枚举；维护方式与 sched/store.rs 的索引适配一致）
pub const SESSION_META_TIMER_INDEX_KEY: &str = "timer_ids";

/// 持久化键（`timer_` 前缀 + timer id）
pub fn store_key(timer_id: &str) -> String {
    format!("{SESSION_META_TIMER_KEY_PREFIX}{timer_id}")
}

/// session_meta 持久化适配（conex-db `timer_*` 键读写）
pub trait TimerStore: Send + Sync {
    /// 读取全部声明（重启恢复扫描用）
    fn load_all(&self) -> Vec<TimerDeclaration>;
    /// 保存声明（幂等 upsert）
    fn save(&self, declaration: &TimerDeclaration);
}

/// 内存持久化适配（测试 + 引擎默认装配；conex-db session_meta 真适配
/// 在 R-CF3 接线——键形状已冻结为 `timer_<id>`）
#[derive(Default)]
pub struct MemoryTimerStore {
    /// timer_<id> → TimerDeclaration JSON
    map: Mutex<HashMap<String, String>>,
}

impl MemoryTimerStore {
    /// 共享实例（重启恢复测试中两个注册表共用同一存储）
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

impl TimerStore for MemoryTimerStore {
    fn load_all(&self) -> Vec<TimerDeclaration> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }

    fn save(&self, declaration: &TimerDeclaration) {
        if let Ok(json) = serde_json::to_string(declaration) {
            self.map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(store_key(&declaration.timer_id), json);
        }
    }
}

/// LocalDb session_meta 真适配（键 `timer_<id>` + 索引 `timer_ids`；
/// 维护模式与 sched/store.rs 的索引适配一致）。
///
/// 注：conex-db 当前仅有 get/set_session_meta（无键扫描 / 删除 API），
/// 故以 `timer_ids` 索引键承载可枚举性；本域无 remove 面——fire 后标
/// fired=true 落库即终态（timers.rs:704-707），索引只增不摘（D6 §3.1）。
#[derive(Clone)]
pub struct LocalDbTimerStore {
    db: LocalDb,
}

impl LocalDbTimerStore {
    /// 新建真适配（db 由装配点提供；轮 2 装配替换时注入）
    pub fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl TimerStore for LocalDbTimerStore {
    fn load_all(&self) -> Vec<TimerDeclaration> {
        // 读 timer_ids 索引 → 逐键 get_session_meta(store_key(id))
        // → serde_json 宽容解析（坏 JSON 跳过，fail-open 对齐
        // MemoryTimerStore::load_all 的 filter_map 语义 timers.rs:253-260）
        let index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_TIMER_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        index
            .into_iter()
            .filter_map(|timer_id| {
                self.db
                    .get_session_meta(&store_key(&timer_id))
                    .ok()
                    .flatten()
                    .and_then(|json| serde_json::from_str(&json).ok())
            })
            .collect()
    }

    fn save(&self, declaration: &TimerDeclaration) {
        // upsert 键值 + 索引幂等追加（与 sched/store.rs 的索引维护模式一致）
        if let Ok(json) = serde_json::to_string(declaration) {
            let _ = self
                .db
                .set_session_meta(&store_key(&declaration.timer_id), &json);
        }
        let mut index: Vec<String> = self
            .db
            .get_session_meta(SESSION_META_TIMER_INDEX_KEY)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        if !index.iter().any(|id| id == &declaration.timer_id) {
            index.push(declaration.timer_id.clone());
            if let Ok(json) = serde_json::to_string(&index) {
                let _ = self
                    .db
                    .set_session_meta(SESSION_META_TIMER_INDEX_KEY, &json);
            }
        }
    }
}
