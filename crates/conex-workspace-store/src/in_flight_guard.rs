//! 工作区导出在途守卫（`InFlightExportGuard`）
//!
//! # 核心职责与不变量（ROUND-3-IMPROVEMENT-02 §2）
//! 1. **代际令牌驱动（`generation_counter: AtomicU64`）**：每次导出登记均分配单调递增代际令牌；
//! 2. **1000ms 自然 TTL 淘汰**：彻底废除即时 `unregister`，保留条目覆盖 OS Watcher 防抖窗口（150ms）；
//! 3. **瞬态缺失容忍机制（`SuppressTransientDeletion`）**：在 Windows 3 阶段原子写重命名期间（<=300ms），
//!    容忍物理文件微秒级缺失，消除 OS Watcher 假删除（`MissingFile`）误报；
//! 4. **零假漂移不变量（INV-STORE-01）**：系统自身落盘内容（`SuppressMatched`）与瞬态重命名（`SuppressTransientDeletion`）
//!    100% 压制，不产生假冲突或假外部修改。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// 压制裁决结果枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InFlightSuppressVerdict {
    /// 严格匹配内容 Hash，压制自发修改/创建事件
    SuppressMatched,
    /// 命中写入中过渡态，容忍瞬时文件缺失，压制假删除事件
    SuppressTransientDeletion,
    /// 未命中守卫或已过期，放行交由下游进行真实漂移检测
    PassThrough,
}

impl InFlightSuppressVerdict {
    /// 是否应该压制该事件（不作为外部漂移上报）
    #[inline]
    pub fn is_suppressed(&self) -> bool {
        matches!(
            self,
            Self::SuppressMatched | Self::SuppressTransientDeletion
        )
    }
}

/// 写入中状态阶段
#[derive(Debug, Clone)]
pub enum InFlightPhase {
    /// 正在进行物理写入与重命名（0~300ms 容忍瞬态文件缺失）
    Writing { started_at: Instant },
    /// 物理写入已提交，等待 OS Watcher 防抖事件收尾（至 1000ms）
    Committed { committed_at: Instant },
}

/// 导出落盘中的单个条目
#[derive(Debug, Clone)]
pub struct InFlightEntry {
    pub expected_hash: String,
    pub rev: i64,
    pub token: u64,
    pub phase: InFlightPhase,
    pub expiry: Instant,
}

/// 工作区导出在途守卫（InFlightExportGuard）
pub struct InFlightExportGuard {
    entries: RwLock<HashMap<String, InFlightEntry>>,
    generation_counter: AtomicU64,
}

impl InFlightExportGuard {
    /// 默认自然 TTL（1000ms）
    pub const DEFAULT_TTL: Duration = Duration::from_millis(1000);
    /// 瞬态缺失容忍窗口（300ms）
    pub const TRANSIENT_DELETION_TOLERANCE: Duration = Duration::from_millis(300);
    /// 自动清理触发容量阈值（64 条目）
    pub const AUTO_SWEEP_THRESHOLD: usize = 64;

    /// 创建新的守卫实例
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            generation_counter: AtomicU64::new(1),
        }
    }

    /// 登记导出落盘，分配代际令牌（容量超阈值时自动清理过期条目，彻底根除无界膨胀隐患）
    pub fn register(&self, path: &Path, expected_hash: &str, rev: i64) -> u64 {
        let key = guard_path_key(path);
        let token = self.generation_counter.fetch_add(1, Ordering::SeqCst);
        let now = Instant::now();
        let mut map = self.entries.write().unwrap_or_else(|p| p.into_inner());
        if map.len() > Self::AUTO_SWEEP_THRESHOLD {
            map.retain(|_, entry| entry.expiry > now);
        }
        map.insert(
            key,
            InFlightEntry {
                expected_hash: expected_hash.to_string(),
                rev,
                token,
                phase: InFlightPhase::Writing { started_at: now },
                expiry: now + Self::DEFAULT_TTL,
            },
        );
        token
    }

    /// 标记物理写入完成，转入 Committed 阶段（严禁在此删除条目，依靠 1000ms 自然 TTL 淘汰）
    pub fn mark_committed(&self, path: &Path, token: u64) {
        let key = guard_path_key(path);
        let mut map = self.entries.write().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = map.get_mut(&key) {
            if entry.token == token {
                entry.phase = InFlightPhase::Committed {
                    committed_at: Instant::now(),
                };
            }
        }
    }

    /// 供 OS Watcher 在接收到事件时进行核心压制判定
    pub fn check_and_suppress(
        &self,
        path: &Path,
        current_file_hash: Option<&str>,
    ) -> InFlightSuppressVerdict {
        let key = guard_path_key(path);
        let map = self.entries.read().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = map.get(&key) else {
            return InFlightSuppressVerdict::PassThrough;
        };

        let now = Instant::now();
        if now > entry.expiry {
            return InFlightSuppressVerdict::PassThrough;
        }

        match (&entry.phase, current_file_hash) {
            // 场景 1: 文件在 Windows 重命名微秒间隙不存在，且处于写入初期（<=300ms）
            (InFlightPhase::Writing { started_at }, None) => {
                if now.duration_since(*started_at) <= Self::TRANSIENT_DELETION_TOLERANCE {
                    InFlightSuppressVerdict::SuppressTransientDeletion
                } else {
                    InFlightSuppressVerdict::PassThrough
                }
            }
            // 场景 2: 文件已就绪，比对 Hash 是否与预期完全一致
            (_, Some(hash)) => {
                if entry.expected_hash == hash {
                    InFlightSuppressVerdict::SuppressMatched
                } else {
                    InFlightSuppressVerdict::PassThrough
                }
            }
            // 场景 3: 已处于 Committed 态但文件丢失，代表被外部真实删除
            (InFlightPhase::Committed { .. }, None) => InFlightSuppressVerdict::PassThrough,
        }
    }

    /// 检查指定路径是否处于在途保护中（未过期）
    pub fn is_in_flight(&self, path: &Path) -> bool {
        let key = guard_path_key(path);
        let map = self.entries.read().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = map.get(&key) {
            Instant::now() <= entry.expiry
        } else {
            false
        }
    }

    /// 获取活跃（未过期）条目数
    pub fn active_count(&self) -> usize {
        let map = self.entries.read().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        map.values().filter(|e| e.expiry > now).count()
    }

    /// 惰性清理过期条目（避免内存无限增长）
    pub fn sweep_expired(&self) {
        let mut map = self.entries.write().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        map.retain(|_, entry| entry.expiry > now);
    }
}

impl Default for InFlightExportGuard {
    fn default() -> Self {
        Self::new()
    }
}

/// 规范化路径比较键（统一分隔符 + 剥离 `\\?\` + Windows 大小写折叠）
pub(crate) fn guard_path_key(p: &Path) -> String {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    };
    let canon = abs.canonicalize().unwrap_or(abs);
    let s = canon.to_string_lossy();
    let stripped = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    };

    let mut norm = stripped.replace('\\', "/");
    #[cfg(windows)]
    {
        norm = norm.to_lowercase();
    }
    if norm.len() > 1 {
        norm = norm.trim_end_matches('/').to_string();
    }
    norm
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_match_suppressed() {
        let guard = InFlightExportGuard::new();
        let path = Path::new("c:/workspace/mirrors/doc-1.md");
        let token = guard.register(path, "hash_abc", 1);
        assert_eq!(token, 1);
        assert!(guard.is_in_flight(path));

        // 匹配 Hash -> SuppressMatched
        let verdict = guard.check_and_suppress(path, Some("hash_abc"));
        assert_eq!(verdict, InFlightSuppressVerdict::SuppressMatched);
        assert!(verdict.is_suppressed());

        // 提交后依然在 TTL 内压制
        guard.mark_committed(path, token);
        let verdict_after = guard.check_and_suppress(path, Some("hash_abc"));
        assert_eq!(verdict_after, InFlightSuppressVerdict::SuppressMatched);
    }

    #[test]
    fn transient_deletion_suppressed_in_writing_phase() {
        let guard = InFlightExportGuard::new();
        let path = Path::new("c:/workspace/mirrors/doc-2.md");
        let _token = guard.register(path, "hash_xyz", 1);

        // 在 Writing 阶段且未传 Hash（文件瞬态不存在）-> SuppressTransientDeletion
        let verdict = guard.check_and_suppress(path, None);
        assert_eq!(verdict, InFlightSuppressVerdict::SuppressTransientDeletion);
        assert!(verdict.is_suppressed());
    }

    #[test]
    fn committed_deletion_passes_through() {
        let guard = InFlightExportGuard::new();
        let path = Path::new("c:/workspace/mirrors/doc-3.md");
        let token = guard.register(path, "hash_xyz", 1);
        guard.mark_committed(path, token);

        // 已处于 Committed 态但文件不存在 -> PassThrough（说明是外部真实物理删除）
        let verdict = guard.check_and_suppress(path, None);
        assert_eq!(verdict, InFlightSuppressVerdict::PassThrough);
        assert!(!verdict.is_suppressed());
    }

    #[test]
    fn mismatched_hash_passes_through() {
        let guard = InFlightExportGuard::new();
        let path = Path::new("c:/workspace/mirrors/doc-4.md");
        let _token = guard.register(path, "expected_hash", 1);

        // Hash 不匹配 -> PassThrough（外部修改）
        let verdict = guard.check_and_suppress(path, Some("different_hash"));
        assert_eq!(verdict, InFlightSuppressVerdict::PassThrough);
        assert!(!verdict.is_suppressed());
    }

    #[test]
    fn token_generation_monotonic_and_overwrites() {
        let guard = InFlightExportGuard::new();
        let path = Path::new("c:/workspace/mirrors/doc-5.md");

        let t1 = guard.register(path, "hash_1", 1);
        assert_eq!(t1, 1);
        let t2 = guard.register(path, "hash_2", 2);
        assert_eq!(t2, 2);

        // 新写入覆盖旧预期
        assert_eq!(
            guard.check_and_suppress(path, Some("hash_1")),
            InFlightSuppressVerdict::PassThrough
        );
        assert_eq!(
            guard.check_and_suppress(path, Some("hash_2")),
            InFlightSuppressVerdict::SuppressMatched
        );

        // 使用旧 token mark_committed 不会改变新写入的 phase
        guard.mark_committed(path, t1);
        let map = guard.entries.read().unwrap();
        let entry = map.get(&guard_path_key(path)).unwrap();
        assert_eq!(entry.token, 2);
        assert!(matches!(entry.phase, InFlightPhase::Writing { .. }));
    }

    #[test]
    fn sweep_expired_cleans_entries() {
        let guard = InFlightExportGuard::new();
        let path = Path::new("c:/workspace/mirrors/doc-6.md");
        let _token = guard.register(path, "hash", 1);
        assert_eq!(guard.active_count(), 1);

        // 手动修改过期时间为过去
        {
            let mut map = guard.entries.write().unwrap();
            let entry = map.get_mut(&guard_path_key(path)).unwrap();
            entry.expiry = Instant::now() - Duration::from_millis(50);
        }

        assert_eq!(guard.active_count(), 0);
        assert_eq!(
            guard.check_and_suppress(path, Some("hash")),
            InFlightSuppressVerdict::PassThrough
        );

        guard.sweep_expired();
        let map = guard.entries.read().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn auto_sweep_on_register_exceeding_threshold() {
        let guard = InFlightExportGuard::new();
        // 注册 AUTO_SWEEP_THRESHOLD + 5 个条目
        for i in 0..(InFlightExportGuard::AUTO_SWEEP_THRESHOLD + 5) {
            let p = format!("c:/workspace/mirrors/doc-sweep-{i}.md");
            guard.register(Path::new(&p), &format!("hash_{i}"), i as i64);
        }

        // 手动将前 50 个条目的过期时间设为过去
        {
            let mut map = guard.entries.write().unwrap();
            let mut count = 0;
            for entry in map.values_mut() {
                if count < 50 {
                    entry.expiry = Instant::now() - Duration::from_millis(50);
                    count += 1;
                }
            }
        }

        // 此时 map 中有 AUTO_SWEEP_THRESHOLD + 5 个条目（> 64）
        assert_eq!(
            guard.entries.read().unwrap().len(),
            InFlightExportGuard::AUTO_SWEEP_THRESHOLD + 5
        );

        // 再次 register 新条目，将触发 map.len() > 64 的自动清理
        let p_new = "c:/workspace/mirrors/doc-sweep-trigger.md";
        guard.register(Path::new(p_new), "hash_trigger", 999);

        // 过期的 50 个条目已被自动清除，当前剩余条目数应为 (AUTO_SWEEP_THRESHOLD + 5 - 50 + 1)
        let expected_remaining = InFlightExportGuard::AUTO_SWEEP_THRESHOLD + 5 - 50 + 1;
        assert_eq!(guard.entries.read().unwrap().len(), expected_remaining);
        assert!(guard.is_in_flight(Path::new(p_new)));
    }
}
