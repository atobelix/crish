//! 工具幂等守卫（任务书 B5.3）
//!
//! 语义来源：05 §5.5 tools::idempotency（packages/agent-core/src/recovery/stream-recovery.test.ts:188-229）。
//! 提供两层接口：
//! - TS 对齐层：`should_execute` / `restore` / `snapshot`，以工具调用 ID 为键（默认域），
//!   直接承载 stream-recovery.test.ts:188-229 的语义
//! - 域级层：`check` / `record` / `clear`，以 run_id+session_id 为域、
//!   以“工具名+参数规范 hash”或 snapshotTag 为键，供执行器在重连/恢复场景去重已执行结果
//!
//! 持久化：`IdempotencyStore` 钩子（对齐 conex-db `save_checkpoint` 的“同一 id 覆盖重写”
//! 语义），本轮默认内存版；接入方可在跨进程场景用 conex-db checkpoint 表落地
//! （save_checkpoint(checkpoint_id, session_id, run_id, payload)）。

use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use crate::definition::ToolError;

/// 默认域（TS 对齐层使用：以工具调用 ID 为键）
pub const DEFAULT_IDEMPOTENCY_DOMAIN: &str = "__default__";

/// 幂等持久化钩子（跨进程可选）
///
/// 对齐 conex-db `save_checkpoint(checkpoint_id, session_id, run_id, payload)`：
/// - `load_keys` 返回指定域全部已执行键（对应启动恢复时读取检查点）
/// - `append_key` 幂等追加（同一键重复记录不报错，对应检查点覆盖重写语义）
#[async_trait]
pub trait IdempotencyStore: Send + Sync {
    /// 加载指定域的已执行键
    async fn load_keys(&self, domain: &str) -> Result<Vec<String>, ToolError>;

    /// 追加记录已执行键（幂等：重复记录不报错）
    async fn append_key(&self, domain: &str, key: &str) -> Result<(), ToolError>;
}

/// 幂等上下文（域 + 键素材）
///
/// 域 = run_id + session_id 拼合；键 = 工具名 + 参数规范 hash，
/// 提供 snapshot_tag 时改用“工具名@快照标记”（如 read_file 输出的 snapshotTag、
/// edit 类工具入参携带的快照），对文件状态类工具去重更精确。
#[derive(Debug, Clone)]
pub struct IdempotencyContext {
    /// 运行标识（域一半）
    pub run_id: String,
    /// 会话标识（域一半）
    pub session_id: String,
    /// 工具名（键素材）
    pub tool_name: String,
    /// 可选快照标记：有则作为更强键（“工具名@标记”）
    pub snapshot_tag: Option<String>,
    /// 额外键素材（F7 遗留 2 接线）：路径类工具同参对「已存在/不存在」文件
    /// 结果不同（如 write_file overwrite=false → tool.file_exists），由执行器
    /// 在构造上下文时追加「目标存在状态」探针；无额外素材时为空、键与旧版一致
    pub extra_key_material: Vec<String>,
}

impl IdempotencyContext {
    /// 新建幂等上下文
    pub fn new(
        run_id: impl Into<String>,
        session_id: impl Into<String>,
        tool_name: impl Into<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            session_id: session_id.into(),
            tool_name: tool_name.into(),
            snapshot_tag: None,
            extra_key_material: Vec::new(),
        }
    }

    /// 域标识：run_id+session_id 拼合
    pub fn domain(&self) -> String {
        domain_for(&self.run_id, &self.session_id)
    }
}

/// 拼合域标识（run_id+session_id 为域）
pub fn domain_for(run_id: &str, session_id: &str) -> String {
    format!("{run_id}:{session_id}")
}

/// 幂等判定结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdempotencyDecision {
    /// 未执行过，可执行（携带键，供 record 复用）
    Execute { key: String },
    /// 已执行过，应去重（携带键，供输出标记）
    Deduplicated { key: String },
}

/// 单个域的执行状态
#[derive(Default)]
struct DomainState {
    keys: HashSet<String>,
    /// 是否已从持久化存储加载（懒加载标记）
    loaded: bool,
}

/// 工具幂等守卫（对齐 TS ToolIdempotencyGuard + 域级扩展）
///
/// 线程安全：内部共享状态经 Mutex 保护，check/record 可并发调用
/// （同一键并发首次执行允许并行，重复键只去重一次）。
pub struct ToolIdempotencyGuard {
    domains: Mutex<HashMap<String, DomainState>>,
    store: Option<Arc<dyn IdempotencyStore>>,
}

/// 锁中毒恢复（PE-07 T07.6 A 模式，Q16 处置）：PoisonError → 记录错误并取回守卫继续使用。
///
/// 对齐 AA-01 正面发现 3（handlers/mod.rs:199 先例）：临界区无 await、持锁时间短，
/// 恢复后状态可能不完整但进程不 panic（外部 store 回调持锁 panic 不再级联 DoS）。
fn recover_lock<T>(poison: std::sync::PoisonError<T>) -> T {
    tracing::error!("幂等守卫锁中毒，按恢复模式继续（锁内状态可能不完整）：{poison}");
    poison.into_inner()
}

impl Default for ToolIdempotencyGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolIdempotencyGuard {
    /// 内存版守卫（无持久化）
    pub fn new() -> Self {
        Self {
            domains: Mutex::new(HashMap::new()),
            store: None,
        }
    }

    /// 带持久化钩子的守卫：record 追加写 store，check 首次访问域时懒加载
    pub fn with_store(store: Arc<dyn IdempotencyStore>) -> Self {
        Self {
            domains: Mutex::new(HashMap::new()),
            store: Some(store),
        }
    }

    // ── TS 对齐层（stream-recovery.test.ts:188-229 语义） ──

    /// 首次出现的调用 ID 返回 true 并记录；重复 ID 返回 false
    pub fn should_execute(&self, tool_call_id: &str) -> bool {
        let mut domains = self
            .domains
            .lock()
            .unwrap_or_else(recover_lock);
        let state = domains
            .entry(DEFAULT_IDEMPOTENCY_DOMAIN.to_string())
            .or_default();
        if state.keys.contains(tool_call_id) {
            return false;
        }
        state.keys.insert(tool_call_id.to_string());
        true
    }

    /// 批量注册已执行过的 ID（从持久化状态恢复时）
    pub fn restore(&self, ids: &[String]) {
        let mut domains = self
            .domains
            .lock()
            .unwrap_or_else(recover_lock);
        let state = domains
            .entry(DEFAULT_IDEMPOTENCY_DOMAIN.to_string())
            .or_default();
        state.keys.extend(ids.iter().cloned());
    }

    /// 已执行的调用 ID 快照（副本，修改不影响内部状态）
    pub fn snapshot(&self) -> Vec<String> {
        let domains = self
            .domains
            .lock()
            .unwrap_or_else(recover_lock);
        domains
            .get(DEFAULT_IDEMPOTENCY_DOMAIN)
            .map(|s| s.keys.iter().cloned().collect())
            .unwrap_or_default()
    }

    // ── 域级层（run_id+session_id 为域，工具名+参数 hash / snapshotTag 为键） ──

    /// 检查是否已执行（未执行返回 Execute，已执行返回 Deduplicated）
    ///
    /// 首次访问某域时若配置了持久化 store，会懒加载该域已执行键。
    pub async fn check(
        &self,
        ctx: &IdempotencyContext,
        args: &Value,
    ) -> Result<IdempotencyDecision, ToolError> {
        let domain = ctx.domain();
        self.ensure_loaded(&domain).await?;
        let key = execution_key(ctx, args);
        let domains = self
            .domains
            .lock()
            .unwrap_or_else(recover_lock);
        let executed = domains
            .get(&domain)
            .map(|s| s.keys.contains(&key))
            .unwrap_or(false);
        if executed {
            Ok(IdempotencyDecision::Deduplicated { key })
        } else {
            Ok(IdempotencyDecision::Execute { key })
        }
    }

    /// 记录已执行（执行成功后调用；失败执行不记录，允许重试）
    ///
    /// 配置了持久化 store 时同步追加（save_checkpoint 语义），
    /// 追加失败返回错误（内存键已写入，上层可决定是否视为不可恢复）。
    pub async fn record(
        &self,
        ctx: &IdempotencyContext,
        args: &Value,
    ) -> Result<(), ToolError> {
        let domain = ctx.domain();
        self.ensure_loaded(&domain).await?;
        let key = execution_key(ctx, args);
        self.domains
            .lock()
            .unwrap_or_else(recover_lock)
            .entry(domain.clone())
            .or_default()
            .keys
            .insert(key.clone());
        if let Some(store) = &self.store {
            store.append_key(&domain, &key).await?;
        }
        Ok(())
    }

    /// 清除指定域的已执行记录（含默认域）
    ///
    /// 注意：接入持久化 store 时，clear 只清内存缓存，
    /// 已落盘的键会在下次 check 时被懒加载恢复；彻底清除需由 store 层配合。
    pub fn clear(&self, domain: &str) {
        self.domains
            .lock()
            .unwrap_or_else(recover_lock)
            .remove(domain);
    }

    /// 清除全部域的已执行记录
    pub fn clear_all(&self) {
        self.domains
            .lock()
            .unwrap_or_else(recover_lock)
            .clear();
    }

    /// 懒加载：某域首次访问时从持久化 store 拉取已执行键
    async fn ensure_loaded(&self, domain: &str) -> Result<(), ToolError> {
        let need_load = {
            let domains = self
                .domains
                .lock()
                .unwrap_or_else(recover_lock);
            !domains
                .get(domain)
                .map(|s| s.loaded)
                .unwrap_or(false)
        };
        if !need_load {
            return Ok(());
        }
        if let Some(store) = &self.store {
            let keys = store.load_keys(domain).await?;
            let mut domains = self
                .domains
                .lock()
                .unwrap_or_else(recover_lock);
            let state = domains.entry(domain.to_string()).or_default();
            state.keys.extend(keys);
            state.loaded = true;
        } else {
            let mut domains = self
                .domains
                .lock()
                .unwrap_or_else(recover_lock);
            domains.entry(domain.to_string()).or_default().loaded = true;
        }
        Ok(())
    }
}

/// 执行键：优先“工具名@快照标记”（ctx 显式标记或入参 snapshotTag 字段），
/// 否则“工具名:参数规范 hash”；
/// `extra_key_material` 逐个拼接到 hash 键尾部（`|` 分隔）——键素材含
/// 路径存在状态等执行结果相关探针，check/record 各自实时探测，保证
/// 「同参但文件状态不同」的调用不共享键
pub fn execution_key(ctx: &IdempotencyContext, args: &Value) -> String {
    let tag = ctx
        .snapshot_tag
        .as_deref()
        .or_else(|| args.get("snapshotTag").and_then(Value::as_str));
    match tag {
        Some(tag) => format!("{}@{tag}", ctx.tool_name),
        None => {
            let mut key = format!("{}:{:016x}", ctx.tool_name, args_hash(args));
            for extra in &ctx.extra_key_material {
                key.push('|');
                key.push_str(extra);
            }
            key
        }
    }
}

/// 参数规范 hash（SipHash-13，非加密散列，仅作同进程/同域去重键）
///
/// 输入为 `canonicalize_json` 的规范序列化，保证键序不同但逻辑相同的
/// 入参产生同一 hash；DefaultHasher 使用固定种子，跨进程稳定。
fn args_hash(args: &Value) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonicalize_json(args).hash(&mut hasher);
    hasher.finish()
}

/// JSON 规范序列化：对象键递归排序，数组保序，字符串转义反斜杠与引号
///
/// 该序列化是单射（逐字符前缀无关编码），与 serde_json 的键序无关，
/// 保证“{"a":1,"b":2}”与“{"b":2,"a":1}”规范化为同一串。
fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("\"{}\"", escape_json_string(s)),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonicalize_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!(
                        "\"{}\":{}",
                        escape_json_string(k),
                        canonicalize_json(&map[*k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

/// JSON 字符串转义（反斜杠与引号；编码前缀无关，保证规范序列化单射）
fn escape_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx(run_id: &str, session_id: &str, tool_name: &str) -> IdempotencyContext {
        IdempotencyContext::new(run_id, session_id, tool_name)
    }

    // ── TS 对齐层（stream-recovery.test.ts:188-229 语义） ──

    #[test]
    fn should_execute_first_call_returns_true() {
        let guard = ToolIdempotencyGuard::new();
        assert!(guard.should_execute("call_1"));
    }

    #[test]
    fn should_execute_duplicate_returns_false() {
        let guard = ToolIdempotencyGuard::new();
        guard.should_execute("call_1");
        assert!(!guard.should_execute("call_1"));
    }

    #[test]
    fn should_execute_different_ids_return_true() {
        let guard = ToolIdempotencyGuard::new();
        guard.should_execute("call_1");
        assert!(guard.should_execute("call_2"));
    }

    #[test]
    fn restore_adds_previously_executed_ids() {
        let guard = ToolIdempotencyGuard::new();
        guard.restore(&["call_1".to_string(), "call_2".to_string()]);
        assert!(!guard.should_execute("call_1"));
        assert!(!guard.should_execute("call_2"));
        assert!(guard.should_execute("call_3"));
    }

    #[test]
    fn snapshot_returns_executed_ids() {
        let guard = ToolIdempotencyGuard::new();
        guard.should_execute("call_1");
        guard.should_execute("call_2");
        let snap = guard.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.contains(&"call_1".to_string()));
        assert!(snap.contains(&"call_2".to_string()));
    }

    #[test]
    fn snapshot_is_a_copy_of_internal_state() {
        let guard = ToolIdempotencyGuard::new();
        guard.should_execute("call_1");
        let mut snap = guard.snapshot();
        snap.push("call_2".to_string());
        assert_eq!(guard.snapshot(), vec!["call_1".to_string()]);
    }

    #[test]
    fn restore_handles_empty_array() {
        let guard = ToolIdempotencyGuard::new();
        guard.restore(&[]);
        assert!(guard.should_execute("call_1"));
    }

    // ── 域级层（check / record / clear） ──

    #[tokio::test]
    async fn check_first_execute_then_deduplicated() {
        let guard = ToolIdempotencyGuard::new();
        let c = ctx("run-1", "sess-1", "read_file");
        let args = json!({ "path": "a.txt" });

        let first = guard.check(&c, &args).await.unwrap();
        assert!(matches!(first, IdempotencyDecision::Execute { .. }));
        guard.record(&c, &args).await.unwrap();

        let second = guard.check(&c, &args).await.unwrap();
        match second {
            IdempotencyDecision::Deduplicated { key } => {
                // 键 = 工具名 + 参数规范 hash
                assert!(key.starts_with("read_file:"));
            }
            _ => panic!("同参重执行应判定为去重"),
        }
    }

    #[tokio::test]
    async fn check_different_args_execute() {
        let guard = ToolIdempotencyGuard::new();
        let c = ctx("run-1", "sess-1", "read_file");
        guard.record(&c, &json!({ "path": "a.txt" })).await.unwrap();
        let next = guard.check(&c, &json!({ "path": "b.txt" })).await.unwrap();
        assert!(matches!(next, IdempotencyDecision::Execute { .. }));
    }

    #[tokio::test]
    async fn check_different_domain_execute() {
        let guard = ToolIdempotencyGuard::new();
        let c1 = ctx("run-1", "sess-1", "read_file");
        let c2 = ctx("run-2", "sess-1", "read_file");
        guard.record(&c1, &json!({ "path": "a.txt" })).await.unwrap();
        let next = guard.check(&c2, &json!({ "path": "a.txt" })).await.unwrap();
        assert!(matches!(next, IdempotencyDecision::Execute { .. }));
    }

    #[tokio::test]
    async fn clear_allows_reexecution() {
        let guard = ToolIdempotencyGuard::new();
        let c = ctx("run-1", "sess-1", "write_file");
        let args = json!({ "path": "a.txt", "content": "hi" });
        guard.record(&c, &args).await.unwrap();
        let next = guard.check(&c, &args).await.unwrap();
        assert!(matches!(next, IdempotencyDecision::Deduplicated { .. }));

        guard.clear(&c.domain());
        let next = guard.check(&c, &args).await.unwrap();
        assert!(matches!(next, IdempotencyDecision::Execute { .. }));
    }

    #[tokio::test]
    async fn snapshot_tag_is_a_stronger_key() {
        let guard = ToolIdempotencyGuard::new();
        let args = json!({ "path": "a.txt" });

        // 同参不同快照标记 → 视为不同执行
        let mut c1 = ctx("run-1", "sess-1", "read_file");
        c1.snapshot_tag = Some("abc123".to_string());
        guard.record(&c1, &args).await.unwrap();
        let mut c2 = ctx("run-1", "sess-1", "read_file");
        c2.snapshot_tag = Some("def456".to_string());
        let next = guard.check(&c2, &args).await.unwrap();
        assert!(matches!(next, IdempotencyDecision::Execute { .. }));

        // 同快照标记 → 去重
        let next = guard.check(&c1, &args).await.unwrap();
        match next {
            IdempotencyDecision::Deduplicated { key } => {
                assert_eq!(key, "read_file@abc123");
            }
            _ => panic!("同快照标记应判定为去重"),
        }
    }

    #[tokio::test]
    async fn args_snapshot_tag_field_used_as_key() {
        let guard = ToolIdempotencyGuard::new();
        let c = ctx("run-1", "sess-1", "edit");
        // ctx 未显式携带标记时，取入参 snapshotTag 字段
        guard
            .record(&c, &json!({ "path": "a.txt", "snapshotTag": "tag-1" }))
            .await
            .unwrap();
        let next = guard
            .check(&c, &json!({ "path": "a.txt", "snapshotTag": "tag-1" }))
            .await
            .unwrap();
        assert!(matches!(next, IdempotencyDecision::Deduplicated { .. }));
        // 无 snapshotTag 字段的入参按参数 hash 走另一条键
        let next = guard.check(&c, &json!({ "path": "a.txt" })).await.unwrap();
        assert!(matches!(next, IdempotencyDecision::Execute { .. }));
    }

    #[test]
    fn canonicalize_ignores_object_key_order() {
        let mut a = serde_json::Map::new();
        a.insert("a".to_string(), json!(1));
        a.insert("b".to_string(), json!({ "x": 1, "y": 2 }));
        let mut b = serde_json::Map::new();
        b.insert("b".to_string(), json!({ "y": 2, "x": 1 }));
        b.insert("a".to_string(), json!(1));
        assert_eq!(
            canonicalize_json(&Value::Object(a)),
            canonicalize_json(&Value::Object(b))
        );
        assert_eq!(canonicalize_json(&json!(1)), "1");
        assert_eq!(canonicalize_json(&json!(null)), "null");
        assert_eq!(canonicalize_json(&json!("a\"b\\c")), r#""a\"b\\c""#);
        assert_eq!(canonicalize_json(&json!([1, 2])), "[1,2]");
    }

    /// F7 遗留 2：额外键素材折叠——同参不同存在状态素材不得共享键，
    /// 同素材重复计算键一致（去重判定依赖的幂等性）
    #[test]
    fn extra_key_material_splits_hash_keys() {
        let mut c = ctx("run-1", "sess-1", "write_file");
        let args = json!({ "path": "a.txt", "content": "x", "overwrite": false });
        let base = execution_key(&c, &args);

        c.extra_key_material = vec!["path:exists=true".to_string()];
        let present = execution_key(&c, &args);
        assert_ne!(base, present, "存在性素材不同不得共享键");
        assert_eq!(execution_key(&c, &args), present, "同素材键必须稳定");

        c.extra_key_material = vec!["path:exists=false".to_string()];
        let absent = execution_key(&c, &args);
        assert_ne!(present, absent, "exists=true/false 必须分键");

        // 快照标记路径不折叠素材（更强键，格式保持不变）
        c.snapshot_tag = Some("tag-1".to_string());
        assert_eq!(execution_key(&c, &args), "write_file@tag-1");
    }

    // ── 持久化钩子 ──

    /// 测试用内存持久化实现（模拟跨进程 store 共享）
    struct FakeStore {
        keys: Mutex<HashMap<String, Vec<String>>>,
    }

    impl FakeStore {
        fn new() -> Self {
            Self {
                keys: Mutex::new(HashMap::new()),
            }
        }
    }

    #[async_trait]
    impl IdempotencyStore for FakeStore {
        // PE-07 T07.6：下列 2 处 expect 属测试专属 store（cfg(test)），非运行时路径，
        // 按任务书「测试 expect 保留但标注」处置，保持不动。
        async fn load_keys(&self, domain: &str) -> Result<Vec<String>, ToolError> {
            Ok(self
                .keys
                .lock()
                .expect("测试 store 锁中毒后不可恢复")
                .get(domain)
                .cloned()
                .unwrap_or_default())
        }

        async fn append_key(&self, domain: &str, key: &str) -> Result<(), ToolError> {
            self.keys
                .lock()
                .expect("测试 store 锁中毒后不可恢复")
                .entry(domain.to_string())
                .or_default()
                .push(key.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn record_persists_via_store_and_reloads_in_new_guard() {
        let store = Arc::new(FakeStore::new());
        let guard = ToolIdempotencyGuard::with_store(store.clone());
        let c = ctx("run-1", "sess-1", "read_file");
        let args = json!({ "path": "a.txt" });

        guard.record(&c, &args).await.unwrap();
        // 落盘：store 中已有该域键
        let keys = store.load_keys(&c.domain()).await.unwrap();
        assert_eq!(keys.len(), 1);

        // 新守卫（模拟进程重启）共享同一 store：懒加载后判定去重
        let guard2 = ToolIdempotencyGuard::with_store(store.clone());
        let next = guard2.check(&c, &args).await.unwrap();
        assert!(matches!(next, IdempotencyDecision::Deduplicated { .. }));
    }

    // ── PE-07 T07.6 用例 1：锁中毒恢复（Q16 处置验证） ──

    #[test]
    fn poisoned_guard_sync_api_recovers_without_panic() {
        let guard = ToolIdempotencyGuard::new();
        crate::test_support::poison_std_lock(&guard.domains);
        // 毒化后公开同步 API 不 panic，且继续可用（恢复模式）
        assert!(guard.should_execute("call_1"));
        assert!(!guard.should_execute("call_1"));
        assert!(guard.snapshot().contains(&"call_1".to_string()));
        guard.restore(&["call_2".to_string()]);
        assert!(!guard.should_execute("call_2"));
        guard.clear(DEFAULT_IDEMPOTENCY_DOMAIN);
        assert!(guard.should_execute("call_3"));
        guard.clear_all();
        assert!(guard.snapshot().is_empty());
    }

    #[tokio::test]
    async fn poisoned_guard_async_api_recovers_without_panic() {
        let guard = ToolIdempotencyGuard::new();
        crate::test_support::poison_std_lock(&guard.domains);
        // 毒化后 check/record（含 ensure_loaded 懒加载路径）不 panic
        let c = ctx("run-1", "sess-1", "read_file");
        let args = json!({ "path": "a.txt" });
        assert!(matches!(
            guard.check(&c, &args).await.unwrap(),
            IdempotencyDecision::Execute { .. }
        ));
        guard.record(&c, &args).await.unwrap();
        assert!(matches!(
            guard.check(&c, &args).await.unwrap(),
            IdempotencyDecision::Deduplicated { .. }
        ));
    }
}
