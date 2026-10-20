//! 感知快照（维度 13）—— 对外入口
//!
//! 单次快照流水线（§0）：
//! ```text
//! collect.rs（CDP 并行采集）→ EnhancedNode（DOM + AX + 样式/布局）
//!   → interactive.rs（四层启发式判定）→ redact.rs（敏感字段清洗）
//!   → serialize.rs（简化树 → 紧凑文本 + selector_map）→ SnapshotDocument（携带 snapshotVersion）
//! ```
//!
//! ## 采集事务化（M-5，§4）：版本读-采集-校验-提交四步
//! 1. 版本读：起始读 `snapshot_version(tab_id)` 与 `global_epoch`
//! 2. 采集：CDP 四路并行 + 增强树构建/序列化
//! 3. 校验：结束再读——窗口内版本推进或 epoch 变化 → 中止不提交，返回 Stale
//! 4. 提交：以 (tab_id, version) 为键写入缓存（含防回退断言）并返回
//!
//! 采集状态机：`Idle → Collecting{...} → Committed`；提交是唯一写入点，
//! 中断/崩溃无半成品缓存条目，状态回 Idle 后下次从头采集。
//! 并发（M9）：采集经信号量限流（默认同时 1 个，可配），超限调用排队等待
//! 而非 Busy 失败；状态机按 tab 键位互斥，跨 tab 并行由限流额度决定。
//!
//! ## 版本校验（R-1 per-tab + U-2 VersionReset）
//! `validate_snapshot(tab_id, version)` 对版本不匹配/epoch 变化/+1000 跳变
//! 一律返回 Stale；快照缓存键 (tab_id, version)，LRU 逐出，版本防回退断言（M-6）。

pub mod budget;
pub mod collect;
pub mod interactive;
pub mod redact;
pub mod serialize;

pub use budget::{BudgetConfig, TruncationInfo, TruncationKind};
pub use collect::{
    AxInfo, AxProperties, Bounds, CdpCollector, CollectError, CollectedData, CrossOriginStats,
    EnhancedNode, FixtureCollector, FrameMarker, LayoutMetrics, SnapshotCollector, StyleInfo,
    COMPUTED_STYLES_WHITELIST, FIRST_ROUND_TIMEOUT, FRAME_COLLECT_TIMEOUT, MAX_IFRAMES,
    MIN_IFRAME_SIZE, RETRY_WINDOW, VIEWPORT_THRESHOLD,
};
pub use serialize::{BlindZoneKind, NodeRef, SerializeOptions, SerializeOutput, SimplifiedNode};

use crate::cdp::version::{Stale, TabId, VersionTracker, VERSION_RESET_DELTA};
use crate::snapshot::budget::{HARD_RAW_PAYLOAD_BYTES, HARD_TIMEOUT, SNAPSHOT_CACHE_TOTAL_BYTES};
use crate::snapshot::serialize::build_and_serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// 已知盲区统计（§3.6，T-16；unoperable 为 closed shadow 降级元素数，T-5）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
pub struct BlindZoneStats {
    /// |CANVAS| 占位（canvas/WebGL 像素内容）
    pub canvas: usize,
    /// |VIDEO| 占位（视频画面）
    pub video: usize,
    /// |IMG| 占位（纯图片内容）
    pub image: usize,
    /// closed shadow 内 AX 检出但无 backendNodeId 的不可操作元素数（T-5）
    pub unoperable: usize,
}

/// 快照元数据（§3.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotMeta {
    /// 采集时刻页面版本（§4，per-tab）
    pub snapshot_version: u64,
    /// 采集时刻 global_epoch（§4 U-2：VersionReset 检测）
    pub epoch: u64,
    /// 采集耗时（含各阶段明细，供自测）
    pub captured_at_ms: u64,
    pub url: String,
    pub title: String,
    /// 多标签隔离键（维度 15）
    pub tab_id: String,
    /// 简化树节点数（截断前）
    pub element_count: usize,
    /// 已分配索引数（截断前）
    pub selector_count: usize,
    pub truncation: Option<TruncationInfo>,
    /// 已知盲区统计（§3.6，T-16；closed shadow 降级计入 unoperable，T-5）
    pub blind_zone: BlindZoneStats,
}

/// 快照文档（§3.1 对外结构）。
#[derive(Debug, Clone)]
pub struct SnapshotDocument {
    /// 紧凑文本树（§3.2）
    pub serialized_text: String,
    /// 模型索引 → 执行定位引用（backendNodeId 为主）
    pub selector_map: HashMap<u32, NodeRef>,
    /// 敏感输入（type=password / 敏感 autocomplete）backendNodeId 集合（M2：
    /// 工具面 is_password 输入目标判定；与 redact.rs 同一敏感判定出口，不泄值）
    pub password_backend_ids: HashSet<i64>,
    pub meta: SnapshotMeta,
}

impl SnapshotDocument {
    /// 估算缓存占用字节（LRU 总量预算用；文本 + 映射 + 元数据近似）。
    pub fn approx_bytes(&self) -> usize {
        self.serialized_text.len() + self.selector_map.len() * 64 + 512
    }
}

/// 快照错误。
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// 采集阶段超时（12s 硬超时上限，T-1；中止本次采集，不产出半成品）
    #[error("快照采集超时（硬超时上限 {0:?}）")]
    Timeout(std::time::Duration),
    /// 版本竞态：采集窗口内版本已推进或 epoch 变化（M-5 第 3 步；调用方决定重拍）
    #[error("版本竞态：{0:?}")]
    Stale(Stale),
    /// 采集失败（CDP 主三路失败）
    #[error("采集失败：{0}")]
    Collect(String),
    /// 原始载荷超限（150KB 采集层护栏，T-2）
    #[error("CDP 原始采集载荷超限：{bytes} > {max}")]
    PayloadOverflow { bytes: usize, max: usize },
    /// 采集状态机忙（另有采集进行中）
    #[error("采集状态机忙：另有采集进行中")]
    Busy,
    /// 缓存写入拒绝（版本回退断言，M-6）
    #[error("快照缓存拒绝版本回退：tab={tab_id} version={version} < 已缓存最大 {max}")]
    CacheRollback {
        tab_id: TabId,
        version: u64,
        max: u64,
    },
}

/// 采集状态机（M-5：Idle → Collecting{...} → Committed；中断回 Idle）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureStateKind {
    Idle,
    Collecting,
}

/// 采集中的事务条目（版本读-采集-校验-提交窗口）。
#[derive(Debug, Clone)]
struct CaptureEntry {
    start_version: u64,
    start_epoch: u64,
    started_at: Instant,
}

/// 快照缓存条目（LRU 链表维护 (tab_id, version) 键序）。
struct CacheEntry {
    doc: Arc<SnapshotDocument>,
    bytes: usize,
}

/// 快照缓存（M-6：键 (tab_id, version)、LRU 逐出、总量 8MB、版本防回退断言）。
struct SnapshotCache {
    entries: HashMap<(TabId, u64), CacheEntry>,
    lru: VecDeque<(TabId, u64)>,
    bytes: usize,
    max_bytes: usize,
    /// 同 tab 最大已提交版本（防回退断言）
    max_version: HashMap<TabId, u64>,
}

impl SnapshotCache {
    fn new(max_bytes: usize) -> Self {
        SnapshotCache {
            entries: HashMap::new(),
            lru: VecDeque::new(),
            bytes: 0,
            max_bytes,
            max_version: HashMap::new(),
        }
    }

    /// 读取（刷新 LRU 最近使用序）。
    fn get(&mut self, tab_id: &TabId, version: u64) -> Option<Arc<SnapshotDocument>> {
        let key = (tab_id.clone(), version);
        let doc = self.entries.get(&key).map(|e| e.doc.clone())?;
        // 移动到 LRU 尾部（最近使用）
        if let Some(pos) = self.lru.iter().position(|k| *k == key) {
            self.lru.remove(pos);
            self.lru.push_back(key);
        }
        Some(doc)
    }

    /// 写入（含版本防回退断言；epoch 变化/跳变清同 tab 旧条目）。
    fn put(
        &mut self,
        tab_id: &TabId,
        version: u64,
        doc: Arc<SnapshotDocument>,
        current_epoch: u64,
    ) -> Result<(), SnapshotError> {
        // 版本防回退断言（M-6：版本单调不减，任何回退写入一律拒绝并记录审计）
        if let Some(max) = self.max_version.get(tab_id) {
            if version < *max {
                return Err(SnapshotError::CacheRollback {
                    tab_id: tab_id.clone(),
                    version,
                    max: *max,
                });
            }
            // VersionReset 跳变（+1000，U-2）为唯一允许的大跳变：同 tab 旧版本失效并清出
            if version >= *max + VERSION_RESET_DELTA {
                self.clear_tab(tab_id);
            }
        }
        // epoch 变化（重连/崩溃重启）→ 同 tab 旧条目全部失效清出
        if doc.meta.epoch != current_epoch {
            self.clear_tab(tab_id);
        }
        let max = self.max_version.get(tab_id).copied().unwrap_or(0);
        self.max_version.insert(tab_id.clone(), version.max(max));

        let bytes = doc.approx_bytes();
        self.entries
            .insert((tab_id.clone(), version), CacheEntry { doc, bytes });
        self.lru.push_back((tab_id.clone(), version));
        self.bytes += bytes;

        // 总量预算：LRU 逐出最久未用条目（M-6）
        while self.bytes > self.max_bytes {
            if let Some(key) = self.lru.pop_front() {
                self.remove(key);
            } else {
                break;
            }
        }
        Ok(())
    }

    /// 清空同 tab 全部条目（跳变/epoch 变化时旧版本失效）。
    fn clear_tab(&mut self, tab_id: &TabId) {
        let stale: Vec<(TabId, u64)> = self
            .entries
            .keys()
            .filter(|(t, _)| t == tab_id)
            .cloned()
            .collect();
        for key in stale {
            self.remove(key);
        }
    }

    /// 上一轮索引集合（(tab_id, version-1) 前驱；版本不连续/无前驱 → None 全量视角）。
    fn previous_selector_ids(&mut self, tab_id: &TabId, version: u64) -> Option<HashSet<i64>> {
        if version == 0 {
            return None;
        }
        let doc = self.get(tab_id, version - 1)?;
        Some(
            doc.selector_map
                .values()
                .map(|r| r.backend_node_id)
                .collect(),
        )
    }

    /// 按键删除（LRU/跳变清出共用）。
    fn remove(&mut self, key: (TabId, u64)) {
        if let Some(e) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(e.bytes);
        }
        if let Some(pos) = self.lru.iter().position(|k| *k == key) {
            self.lru.remove(pos);
        }
    }
}

/// 快照管理器（采集事务化 + 版本校验 + 快照缓存）。
pub struct SnapshotManager {
    version: Arc<VersionTracker>,
    collector: Arc<dyn SnapshotCollector>,
    budgets: BudgetConfig,
    /// getEventListeners 增强通道（T-4：默认关闭；S0 实证后决定默认开关）
    listener_channel: bool,
    /// 绘制序过滤开关（§3.1 步骤 3）
    paint_filter: bool,
    cache: Mutex<SnapshotCache>,
    /// 采集状态机（per-tab 键位；M9：同 tab 并发互斥，跨 tab 并行由限流额度决定）
    state: Mutex<HashMap<TabId, CaptureEntry>>,
    /// 采集并发限流（M9：默认同时 1 个采集，可配；并发采集排队等待而非 Busy 失败）
    limit: tokio::sync::Semaphore,
}

impl SnapshotManager {
    /// 新建管理器（版本源 + 采集器注入；构造输入与真实 CDP 共用入口）。
    pub fn new(
        version: Arc<VersionTracker>,
        collector: Arc<dyn SnapshotCollector>,
        budgets: BudgetConfig,
    ) -> Self {
        SnapshotManager {
            version,
            collector,
            budgets,
            listener_channel: false,
            paint_filter: false,
            cache: Mutex::new(SnapshotCache::new(SNAPSHOT_CACHE_TOTAL_BYTES)),
            state: Mutex::new(HashMap::new()),
            limit: tokio::sync::Semaphore::new(1),
        }
    }

    /// 开启 getEventListeners 增强通道（T-4：默认关闭，S0 实证增益后决定）。
    pub fn with_listener_channel(mut self, on: bool) -> Self {
        self.listener_channel = on;
        self
    }

    /// 开启绘制序过滤（§3.1 步骤 3）。
    pub fn with_paint_filter(mut self, on: bool) -> Self {
        self.paint_filter = on;
        self
    }

    /// 配置采集并发度（M9：默认 1；超过限额的采集排队等待信号量，不 Busy 失败）。
    pub fn with_capture_concurrency(mut self, n: usize) -> Self {
        self.limit = tokio::sync::Semaphore::new(n.max(1));
        self
    }

    /// 当前采集状态（状态机观测/审计）。
    pub fn state_kind(&self) -> CaptureStateKind {
        if self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty()
        {
            CaptureStateKind::Idle
        } else {
            CaptureStateKind::Collecting
        }
    }

    /// 采集事务化入口（M-5 四步：版本读-采集-校验-提交）。
    ///
    /// `active`：标签活跃度（T-6：非活跃标签按 0.25 系数惰性快照）。
    /// 并发语义（M9）：采集经信号量限流（默认同时 1 个，可配）——超限调用排队
    /// 等待而非 Busy 失败；同 tab 并发由状态机（per-tab 键位）互斥。
    pub async fn capture(
        &self,
        tab_id: &TabId,
        session: &str,
        active: bool,
    ) -> Result<Arc<SnapshotDocument>, SnapshotError> {
        // —— 限流：并发采集排队（M9；信号量不关闭，acquire 不失败）——
        let _permit = self
            .limit
            .acquire()
            .await
            .map_err(|_| SnapshotError::Collect("采集限流信号量异常（关闭）".to_string()))?;

        // —— 状态机：同 tab 并发互斥（per-tab 键位）——
        {
            let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if guard.contains_key(tab_id) {
                return Err(SnapshotError::Busy);
            }
            let start_version = self.version.snapshot_version(tab_id);
            let start_epoch = self.version.epoch();
            guard.insert(
                tab_id.clone(),
                CaptureEntry {
                    start_version,
                    start_epoch,
                    started_at: Instant::now(),
                },
            );
        }

        // —— 采集（12s 硬超时，T-1）——
        let budgets = if active {
            self.budgets
        } else {
            self.budgets.inactive()
        };
        let collected: CollectedData =
            match tokio::time::timeout(HARD_TIMEOUT, self.collector.collect(tab_id, session)).await
            {
                Ok(Ok(data)) => data,
                Ok(Err(e)) => {
                    self.state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(tab_id);
                    return Err(e);
                }
                Err(_) => {
                    self.state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(tab_id);
                    return Err(SnapshotError::Timeout(HARD_TIMEOUT));
                }
            };

        // —— 校验（版本/epoch 双读；窗口内推进 → Stale 不提交）——
        let entry = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(tab_id);
        let Some(entry) = entry else {
            return Err(SnapshotError::Busy);
        };
        let end_version = self.version.snapshot_version(tab_id);
        let end_epoch = self.version.epoch();
        if end_version != entry.start_version || end_epoch != entry.start_epoch {
            return Err(SnapshotError::Stale(Stale {
                tab_id: tab_id.clone(),
                expected: entry.start_version,
                current: end_version,
                epoch: end_epoch,
            }));
        }

        // —— 密码标记（M2）：敏感输入集合与脱敏同源（redact.rs）——
        let password_backend_ids = redact::sensitive_input_backend_ids(&collected.roots);

        // —— 序列化（简化树 + 判定 + 脱敏 + 预算截断）——
        let mut previous = self
            .cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .previous_selector_ids(tab_id, entry.start_version);
        if previous.is_none() {
            previous = Some(HashSet::new());
        }
        let previous = previous.expect("上一轮集合已兜底为空集");
        let incremental = self
            .cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(tab_id, entry.start_version.saturating_sub(1))
            .is_some();
        let opts = serialize::SerializeOptions::new(&budgets, session, &previous)
            .with_incremental(incremental);
        let build_started = Instant::now();
        let out = build_and_serialize(&collected.roots, &opts);
        let build_ms = build_started.elapsed().as_millis() as u64;

        let doc = SnapshotDocument {
            serialized_text: out.text,
            selector_map: out.selector_map,
            password_backend_ids,
            meta: SnapshotMeta {
                snapshot_version: entry.start_version,
                epoch: entry.start_epoch,
                captured_at_ms: entry.started_at.elapsed().as_millis() as u64,
                url: collected.url,
                title: collected.title,
                tab_id: tab_id.clone(),
                element_count: out.element_count,
                selector_count: out.selector_count,
                truncation: out.truncation,
                blind_zone: out.blind_zone,
            },
        };
        // 序列化耗时为纯诊断指标（不入 SnapshotMeta，避免契约面扩容）：
        // 记录到日志，供现场排查「快照构建变慢」时定位到本阶段。
        tracing::debug!("快照序列化耗时 {build_ms}ms（{tab_id}）");
        let doc = Arc::new(doc);

        // —— 提交（防回退断言 + LRU + 跳变清出）——
        self.cache.lock().unwrap_or_else(|p| p.into_inner()).put(
            tab_id,
            entry.start_version,
            doc.clone(),
            entry.start_epoch,
        )?;

        Ok(doc)
    }

    /// 校验快照版本（R-1/U-2：版本不匹配/epoch 变化/+1000 跳变一律 Stale）。
    ///
    /// 契约签名与维度 11 §8 一致；epoch 面在缓存可命中快照时联动检测，
    /// 动作执行方如需完整校验请用 `validate_document`。
    pub fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale> {
        let current = self.version.snapshot_version(tab_id);
        let epoch = self.version.epoch();
        // 版本不匹配（含常规推进后的过期）
        if version != current {
            return Err(Stale {
                tab_id: tab_id.clone(),
                expected: version,
                current,
                epoch,
            });
        }
        // +1000 跳变（重连/崩溃重启，11 §5.4 #9）：防御性断言（版本单调下不常见）
        if current >= version.saturating_add(VERSION_RESET_DELTA) {
            return Err(Stale {
                tab_id: tab_id.clone(),
                expected: version,
                current,
                epoch,
            });
        }
        // epoch 变化（VersionReset）：缓存可命中该快照时联动检测
        if let Some(doc) = self
            .cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(tab_id, version)
        {
            if doc.meta.epoch != epoch {
                return Err(Stale {
                    tab_id: tab_id.clone(),
                    expected: version,
                    current,
                    epoch,
                });
            }
        }
        Ok(())
    }

    /// 完整校验（动作执行方持有快照文档时用：携带 meta.epoch 联动 epoch 检测）。
    pub fn validate_document(&self, doc: &SnapshotDocument) -> Result<(), Stale> {
        self.validate_snapshot(&doc.meta.tab_id, doc.meta.snapshot_version)?;
        let epoch = self.version.epoch();
        if doc.meta.epoch != epoch {
            return Err(Stale {
                tab_id: doc.meta.tab_id.clone(),
                expected: doc.meta.snapshot_version,
                current: self.version.snapshot_version(&doc.meta.tab_id),
                epoch,
            });
        }
        Ok(())
    }

    /// 缓存读取（LRU 命中刷新）。
    pub fn get_cached(&self, tab_id: &TabId, version: u64) -> Option<Arc<SnapshotDocument>> {
        self.cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(tab_id, version)
    }

    /// 上一轮 selector 集合（增量匹配前驱；无前驱返回空集，全量视角）。
    pub fn previous_selector_ids(&self, tab_id: &TabId, version: u64) -> HashSet<i64> {
        self.cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .previous_selector_ids(tab_id, version)
            .unwrap_or_default()
    }
}

/// 构造输入 → 快照文档（测试/引擎侧确定性入口；不含版本事务，由调用方
/// 决定是否经 `capture` 走事务化路径）。
pub fn snapshot_from_roots(
    roots: Vec<EnhancedNode>,
    tab_id: &TabId,
    version: u64,
    epoch: u64,
    session_id: &str,
    budgets: &BudgetConfig,
) -> SnapshotDocument {
    let out = build_and_serialize(
        &roots,
        &serialize::SerializeOptions::new(budgets, session_id, &HashSet::new()),
    );
    SnapshotDocument {
        serialized_text: out.text,
        selector_map: out.selector_map,
        password_backend_ids: redact::sensitive_input_backend_ids(&roots),
        meta: SnapshotMeta {
            snapshot_version: version,
            epoch,
            captured_at_ms: 0,
            url: String::new(),
            title: String::new(),
            tab_id: tab_id.to_string(),
            element_count: out.element_count,
            selector_count: out.selector_count,
            truncation: out.truncation,
            blind_zone: out.blind_zone,
        },
    }
}

/// 原始载荷护栏断言（采集层 512KB 硬护栏，T-2 + 46 复核；150KB 常规预算
/// 为降级触发阈值不阻断采集，硬护栏才是「采集成功」的载荷上界）。
pub fn raw_payload_within_budget(bytes: usize) -> bool {
    bytes <= HARD_RAW_PAYLOAD_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::bus::BusHandle;
    use crate::snapshot::budget::{BudgetConfig, HARD_RAW_PAYLOAD_BYTES};
    use crate::snapshot::collect::{CollectedData, EnhancedNode, FixtureCollector};
    use async_trait::async_trait;
    use std::time::Duration;

    fn test_manager(
        collector: Arc<dyn SnapshotCollector>,
    ) -> (SnapshotManager, Arc<VersionTracker>, BusHandle) {
        let bus = BusHandle::new(64, 4);
        let version = Arc::new(VersionTracker::new(
            bus.event_tx(),
            Duration::from_millis(200),
        ));
        (
            SnapshotManager::new(version.clone(), collector, BudgetConfig::active()),
            version,
            bus,
        )
    }

    fn page_fixture() -> Vec<EnhancedNode> {
        vec![
            EnhancedNode::element("input", 1)
                .attr("name", "q")
                .bounds(0.0, 0.0, 300.0, 36.0),
            EnhancedNode::element("button", 2)
                .push(EnhancedNode::text_node("搜索", 3))
                .bounds(310.0, 0.0, 80.0, 36.0),
        ]
    }

    /// 事务化采集：版本读-采集-校验-提交全流程（版本推进 → 提交成功）。
    #[tokio::test]
    async fn capture_transaction_commits() {
        let (mgr, version, _bus) = test_manager(Arc::new(FixtureCollector::new(page_fixture())));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        let doc = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("采集应成功");
        assert_eq!(doc.meta.snapshot_version, 1);
        assert_eq!(doc.meta.tab_id, "t1");
        assert!(doc.serialized_text.contains("[1]<input name=q"));
        assert_eq!(mgr.state_kind(), CaptureStateKind::Idle, "提交后回 Idle");
        // 缓存可命中
        assert!(mgr.get_cached(&"t1".to_string(), 1).is_some());
    }

    /// M-5：采集窗口内版本推进 → Stale 不提交（状态回 Idle）。
    #[tokio::test]
    async fn capture_stale_on_version_advance() {
        // 采集器与管理器共享同一版本跟踪器（窗口内推进才能被校验检出）
        let bus = BusHandle::new(64, 4);
        let version = Arc::new(VersionTracker::new(
            bus.event_tx(),
            Duration::from_millis(200),
        ));
        let collector = Arc::new(AdvancingCollector {
            version: version.clone(),
        });
        let mgr = SnapshotManager::new(version.clone(), collector, BudgetConfig::active());
        let err = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect_err("窗口内推进应 Stale");
        assert!(matches!(err, SnapshotError::Stale(_)));
        assert_eq!(
            mgr.state_kind(),
            CaptureStateKind::Idle,
            "Stale 后状态回 Idle"
        );
        assert!(
            mgr.get_cached(&"t1".to_string(), 0).is_none(),
            "Stale 不产生缓存条目"
        );
        // 再次采集应成功（无半成品残留）
        let collector2 = Arc::new(FixtureCollector::new(page_fixture()));
        let (mgr2, version2, _bus2) = test_manager(collector2);
        version2.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        let _ = mgr2
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("重拍应成功");
    }

    /// 采集期间推进版本的采集器（Stale 注入）。
    struct AdvancingCollector {
        version: Arc<VersionTracker>,
    }

    #[async_trait]
    impl SnapshotCollector for AdvancingCollector {
        async fn collect(
            &self,
            _tab_id: &str,
            _session: &str,
        ) -> Result<CollectedData, SnapshotError> {
            self.version
                .bump("t1", crate::cdp::bus::VersionReason::ActionDone);
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok(CollectedData {
                roots: page_fixture(),
                url: String::new(),
                title: String::new(),
                layout: LayoutMetrics::default(),
                raw_payload_bytes: 0,
                collect_ms: 0,
                cross_origin: CrossOriginStats::default(),
            })
        }
    }

    /// 12s 硬超时（T-1）：注入挂起采集 → Timeout，状态回 Idle。
    #[tokio::test]
    async fn capture_hard_timeout_hangs() {
        let hanging =
            Arc::new(FixtureCollector::new(page_fixture()).hang_for(Duration::from_secs(30)));
        let (mgr, _version, _bus) = test_manager(hanging);
        let started = std::time::Instant::now();
        let err = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect_err("挂起采集应超时");
        assert!(matches!(err, SnapshotError::Timeout(_)));
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "应在 12s 硬超时内返回"
        );
        assert_eq!(
            mgr.state_kind(),
            CaptureStateKind::Idle,
            "超时后状态回 Idle"
        );
        assert!(
            mgr.get_cached(&"t1".to_string(), 0).is_none(),
            "超时不产生缓存条目"
        );
    }

    /// M2：采集文档携带密码标记——type=password 输入 backendNodeId 入集合，
    /// 普通输入/容器/文本节点排除（redact.rs 同源判定）。
    #[tokio::test]
    async fn capture_marks_password_backend_ids() {
        let roots = vec![
            EnhancedNode::element("input", 1)
                .attr("type", "password")
                .bounds(0.0, 0.0, 300.0, 36.0),
            EnhancedNode::element("input", 2)
                .attr("type", "text")
                .attr("autocomplete", "current-password")
                .bounds(0.0, 40.0, 300.0, 36.0),
            EnhancedNode::element("button", 3)
                .push(EnhancedNode::text_node("登录", 4))
                .bounds(0.0, 80.0, 80.0, 36.0),
        ];
        let (mgr, version, _bus) = test_manager(Arc::new(FixtureCollector::new(roots)));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        let doc = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("采集应成功");
        assert!(
            doc.password_backend_ids.contains(&1),
            "type=password 输入必须入标记集合"
        );
        assert!(
            doc.password_backend_ids.contains(&2),
            "敏感 autocomplete 输入必须入标记集合"
        );
        assert!(!doc.password_backend_ids.contains(&3), "普通按钮不敏感");
        assert!(!doc.password_backend_ids.contains(&4), "文本节点不敏感");
    }

    /// M9：并发采集排队串行（默认限流 1）——不同标签同时采集不再 Busy 失败，
    /// 而是等待信号量依次执行；探针断言同时活跃采集数恒为 1。
    #[tokio::test]
    async fn capture_concurrent_queues_serially() {
        let probe = ProbeCollector::new(Duration::from_millis(150));
        let bus = BusHandle::new(64, 4);
        let version = Arc::new(VersionTracker::new(
            bus.event_tx(),
            Duration::from_millis(200),
        ));
        let mgr = Arc::new(SnapshotManager::new(
            version.clone(),
            probe.clone(),
            BudgetConfig::active(),
        ));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        version.bump("t2", crate::cdp::bus::VersionReason::Navigation);

        let mgr_a = mgr.clone();
        let mgr_b = mgr.clone();
        let a = tokio::spawn(async move { mgr_a.capture(&"t1".to_string(), "s1", true).await });
        let b = tokio::spawn(async move { mgr_b.capture(&"t2".to_string(), "s1", true).await });
        let ra = a.await.expect("任务应完成");
        let rb = b.await.expect("任务应完成");
        assert!(ra.is_ok(), "排队后首拍应成功：{ra:?}");
        assert!(rb.is_ok(), "排队后次拍应成功：{rb:?}");
        assert_eq!(probe.max_active(), 1, "默认限流 1：同时最多 1 个采集在跑");
        assert_eq!(
            mgr.state_kind(),
            CaptureStateKind::Idle,
            "全部结束后回 Idle"
        );
        assert!(
            mgr.get_cached(&"t1".to_string(), 1).is_some(),
            "t1 快照已提交"
        );
        assert!(
            mgr.get_cached(&"t2".to_string(), 1).is_some(),
            "t2 快照已提交"
        );
    }

    /// M9：限流可配——并发度 2 时不同标签采集并行执行（同时活跃数到 2）。
    #[tokio::test]
    async fn capture_concurrency_limit_configurable() {
        let probe = ProbeCollector::new(Duration::from_millis(150));
        let bus = BusHandle::new(64, 4);
        let version = Arc::new(VersionTracker::new(
            bus.event_tx(),
            Duration::from_millis(200),
        ));
        let mgr = Arc::new(
            SnapshotManager::new(version.clone(), probe.clone(), BudgetConfig::active())
                .with_capture_concurrency(2),
        );
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        version.bump("t2", crate::cdp::bus::VersionReason::Navigation);

        let mgr_a = mgr.clone();
        let mgr_b = mgr.clone();
        let a = tokio::spawn(async move { mgr_a.capture(&"t1".to_string(), "s1", true).await });
        let b = tokio::spawn(async move { mgr_b.capture(&"t2".to_string(), "s1", true).await });
        let ra = a.await.expect("任务应完成");
        let rb = b.await.expect("任务应完成");
        assert!(ra.is_ok(), "并行采集应成功：{ra:?}");
        assert!(rb.is_ok(), "并行采集应成功：{rb:?}");
        assert_eq!(probe.max_active(), 2, "并发度 2：两个采集并行执行");
        assert_eq!(
            mgr.state_kind(),
            CaptureStateKind::Idle,
            "全部结束后回 Idle"
        );
    }

    /// 并发探针采集器（M9）：统计同时活跃的采集数（确定性并发度断言）。
    struct ProbeCollector {
        roots: Vec<EnhancedNode>,
        hang: Duration,
        active: std::sync::atomic::AtomicUsize,
        max_active: std::sync::atomic::AtomicUsize,
    }

    impl ProbeCollector {
        fn new(hang: Duration) -> Arc<Self> {
            Arc::new(ProbeCollector {
                roots: page_fixture(),
                hang,
                active: std::sync::atomic::AtomicUsize::new(0),
                max_active: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        fn max_active(&self) -> usize {
            self.max_active.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl SnapshotCollector for ProbeCollector {
        async fn collect(
            &self,
            _tab_id: &str,
            _session: &str,
        ) -> Result<CollectedData, SnapshotError> {
            let now = self
                .active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            self.max_active
                .fetch_max(now, std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(self.hang).await;
            self.active
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            Ok(CollectedData {
                roots: self.roots.clone(),
                url: String::new(),
                title: String::new(),
                layout: LayoutMetrics::default(),
                raw_payload_bytes: 0,
                collect_ms: 0,
                cross_origin: CrossOriginStats::default(),
            })
        }
    }

    /// U-2：epoch 变化（VersionReset）→ Stale。
    #[tokio::test]
    async fn validate_epoch_change_is_stale() {
        let (mgr, version, _bus) = test_manager(Arc::new(FixtureCollector::new(page_fixture())));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        let doc = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("采集应成功");
        assert!(mgr
            .validate_snapshot(&"t1".to_string(), doc.meta.snapshot_version)
            .is_ok());
        // VersionReset：epoch+1、版本 +1000 → 旧快照 Stale
        version.reset(crate::cdp::bus::VersionReason::Reconnected);
        assert!(
            mgr.validate_snapshot(&"t1".to_string(), 1).is_err(),
            "epoch 变化应 Stale"
        );
        assert!(
            mgr.validate_document(&doc).is_err(),
            "validate_document 应检出 epoch 变化"
        );
    }

    /// +1000 跳变（重连/崩溃重启）→ Stale。
    #[tokio::test]
    async fn validate_plus_1000_jump_is_stale() {
        let (mgr, version, _bus) = test_manager(Arc::new(FixtureCollector::new(page_fixture())));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        assert!(mgr.validate_snapshot(&"t1".to_string(), 1).is_ok());
        // 直接跳变 +1000（模拟跟踪器重对齐）
        version.reset(crate::cdp::bus::VersionReason::LaggedResync);
        assert!(
            mgr.validate_snapshot(&"t1".to_string(), 1).is_err(),
            "+1000 跳变应 Stale"
        );
        assert!(mgr.validate_snapshot(&"t1".to_string(), 1001).is_ok());
    }

    /// 版本防回退断言（M-6）：向旧版本写入拒绝并记录审计。
    #[tokio::test]
    async fn cache_rejects_version_rollback() {
        let (mgr, version, _bus) = test_manager(Arc::new(FixtureCollector::new(page_fixture())));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        let _ = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("v1 采集成功");
        version.bump("t1", crate::cdp::bus::VersionReason::ActionDone);
        let _ = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("v2 采集成功");

        // 直接向缓存写入旧版本（模拟异常路径/外部注入）→ 防回退断言拒绝
        let doc = snapshot_from_roots(
            page_fixture(),
            &"t1".to_string(),
            2,
            0,
            "s1",
            &BudgetConfig::active(),
        );
        let mut cache = SnapshotCache::new(SNAPSHOT_CACHE_TOTAL_BYTES);
        cache
            .put(&"t1".to_string(), 2, Arc::new(doc), 0)
            .expect("v2 正常写入");
        let old_doc = snapshot_from_roots(
            page_fixture(),
            &"t1".to_string(),
            1,
            0,
            "s1",
            &BudgetConfig::active(),
        );
        let err = cache
            .put(&"t1".to_string(), 1, Arc::new(old_doc), 0)
            .expect_err("回退写入应拒绝");
        match err {
            SnapshotError::CacheRollback { version, max, .. } => {
                assert_eq!(version, 1);
                assert_eq!(max, 2);
            }
            other => panic!("应返回 CacheRollback，实际 {other:?}"),
        }
        // 拒绝后旧条目不残留（无半成品状态）
        assert!(cache.get(&"t1".to_string(), 1).is_none());
        assert!(cache.get(&"t1".to_string(), 2).is_some());
    }

    /// M-6：VersionReset 跳变清同 tab 旧条目（+1000 跳变放行并清旧）。
    #[tokio::test]
    async fn cache_clears_old_versions_on_reset_jump() {
        let (mgr, version, _bus) = test_manager(Arc::new(FixtureCollector::new(page_fixture())));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        let _ = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("v1 采集成功");
        assert!(mgr.get_cached(&"t1".to_string(), 1).is_some());
        version.reset(crate::cdp::bus::VersionReason::Reconnected);
        let _ = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("v1001 采集成功");
        assert!(mgr.get_cached(&"t1".to_string(), 1001).is_some());
        assert!(
            mgr.get_cached(&"t1".to_string(), 1).is_none(),
            "跳变后旧版本条目应清出（M-6）"
        );
    }

    /// LRU：总量预算逐出最久未用条目（键 (tab_id, version)）。
    #[test]
    fn cache_lru_evicts_oldest() {
        // 单条目容量：每次写入逐出最久未用（仅最新保留）
        let mut cache = SnapshotCache::new(720);
        for v in 1..=3 {
            let doc = snapshot_from_roots(
                page_fixture(),
                &"t1".to_string(),
                v,
                0,
                "s1",
                &BudgetConfig::active(),
            );
            cache
                .put(&"t1".to_string(), v, Arc::new(doc), 0)
                .expect("正常写入");
        }
        assert!(cache.get(&"t1".to_string(), 3).is_some(), "最新条目保留");
        assert!(cache.get(&"t1".to_string(), 2).is_none(), "最久未用逐出");
        assert!(cache.get(&"t1".to_string(), 1).is_none());

        // 双条目容量：v3 写入逐出 v1，v2/v3 保留；LRU 按 (tab_id, version) 键序
        let mut cache2 = SnapshotCache::new(1450);
        for v in 1..=3 {
            let doc = snapshot_from_roots(
                page_fixture(),
                &"t1".to_string(),
                v,
                0,
                "s1",
                &BudgetConfig::active(),
            );
            cache2
                .put(&"t1".to_string(), v, Arc::new(doc), 0)
                .expect("正常写入");
        }
        assert!(cache2.get(&"t1".to_string(), 3).is_some());
        assert!(cache2.get(&"t1".to_string(), 2).is_some());
        assert!(
            cache2.get(&"t1".to_string(), 1).is_none(),
            "最久未用（v1）逐出"
        );

        // 跨 tab 独立（维度 15 隔离语义）
        let mut cache3 = SnapshotCache::new(100 * 1024);
        let d1 = snapshot_from_roots(
            page_fixture(),
            &"t1".to_string(),
            1,
            0,
            "s1",
            &BudgetConfig::active(),
        );
        let d2 = snapshot_from_roots(
            page_fixture(),
            &"t2".to_string(),
            1,
            0,
            "s1",
            &BudgetConfig::active(),
        );
        cache3.put(&"t1".to_string(), 1, Arc::new(d1), 0).unwrap();
        cache3.put(&"t2".to_string(), 1, Arc::new(d2), 0).unwrap();
        assert!(cache3.get(&"t1".to_string(), 1).is_some());
        assert!(cache3.get(&"t2".to_string(), 1).is_some());
    }

    /// T-6：非活跃标签惰性快照（0.25 系数预算）。
    #[tokio::test]
    async fn capture_inactive_budget_scaled() {
        let (mgr, version, _bus) = test_manager(Arc::new(FixtureCollector::new(page_fixture())));
        version.bump("t1", crate::cdp::bus::VersionReason::Navigation);
        let _active = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect("活跃全额");
        version.bump("t1", crate::cdp::bus::VersionReason::ActionDone);
        let inactive = mgr
            .capture(&"t1".to_string(), "s1", false)
            .await
            .expect("非活跃惰性");
        // 小页面在非活跃预算下完整表达（250 节点/125 索引足够）
        assert!(inactive
            .serialized_text
            .contains("[2]<button>搜索</button>"));
    }

    /// 载荷护栏（T-2 + 46 复核）：512KB 硬护栏边界判定。
    #[tokio::test]
    async fn payload_budget_guard() {
        assert!(raw_payload_within_budget(HARD_RAW_PAYLOAD_BYTES));
        assert!(!raw_payload_within_budget(HARD_RAW_PAYLOAD_BYTES + 1));
    }

    /// 采集错误透传（采集失败 → 状态回 Idle）。
    #[tokio::test]
    async fn capture_propagates_collect_error() {
        let failing = Arc::new(FailingCollector);
        let (mgr, _version, _bus) = test_manager(failing);
        let err = mgr
            .capture(&"t1".to_string(), "s1", true)
            .await
            .expect_err("采集失败应透传");
        assert!(matches!(err, SnapshotError::Collect(_)));
        assert_eq!(mgr.state_kind(), CaptureStateKind::Idle);
    }

    struct FailingCollector;

    #[async_trait]
    impl SnapshotCollector for FailingCollector {
        async fn collect(
            &self,
            _tab_id: &str,
            _session: &str,
        ) -> Result<CollectedData, SnapshotError> {
            Err(SnapshotError::Collect("模拟采集失败".to_string()))
        }
    }
}
