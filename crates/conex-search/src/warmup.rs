//! 启动期搜索索引预热（RUN-04 / GAP-09）：
//!
//! - **多根全量**：遍历全部已授权工作区根，不再只预热第一个根；
//! - **上限护栏**：文件数 / 超时合计预算，超限截断并如实上报（不无限增长）；
//! - **失败可观测**：根级与条目级失败全部收集进报告，由调用方落
//!   `tracing::warn!`，不静默吞错（R-13）；
//! - **代数守卫**：`IndexCell` 以 generation 防护——预热构建期间用户手动
//!   重建索引后，晚到的旧预热结果被拒绝提交，不会覆盖较新的索引。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// 默认文件数上限（全部根合计）。
pub const DEFAULT_MAX_FILES: usize = 100_000;
/// 默认预热超时预算（全部根合计）。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// 条目级失败样本上限（防错误列表本身无限增长；总数另计上报）。
pub const ENTRY_ERROR_SAMPLES: usize = 16;

/// 预热护栏上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WarmupLimits {
    /// 全根合计文件数上限；达到后截断（`truncated = true`）。
    pub max_files: usize,
    /// 全根合计时间预算；超时后提前停止（`timed_out = true`）。
    pub timeout: Duration,
}

impl Default for WarmupLimits {
    fn default() -> Self {
        Self {
            max_files: DEFAULT_MAX_FILES,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

/// 根级失败：整个根无法预热（不存在 / 非目录等）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmupRootError {
    pub root: String,
    pub message: String,
}

/// 条目级失败：遍历中单个条目读取失败（权限等），记录根归属与样本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WarmupEntryError {
    pub root: String,
    pub path: String,
    pub message: String,
}

/// 预热报告：调用方据此落日志（成功 `info!` / 失败 `warn!`），不静默。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WarmupReport {
    /// 合并后的索引文件清单（已全局排序去重，保证确定性）。
    pub files: Vec<String>,
    /// 参与预热的根数（≠ 成功根数时必有 `root_errors`）。
    pub root_count: usize,
    /// 根级失败清单。
    pub root_errors: Vec<WarmupRootError>,
    /// 条目级失败总数（样本见 `entry_error_samples`）。
    pub entry_error_count: usize,
    /// 条目级失败样本（至多 [`ENTRY_ERROR_SAMPLES`] 条）。
    pub entry_error_samples: Vec<WarmupEntryError>,
    /// 是否因达到文件数上限而截断。
    pub truncated: bool,
    /// 是否因超时预算耗尽而提前停止。
    pub timed_out: bool,
}

impl WarmupReport {
    /// 是否完全干净（无根级/条目级失败、未截断、未超时）。
    pub fn is_clean(&self) -> bool {
        self.root_errors.is_empty()
            && self.entry_error_count == 0
            && !self.truncated
            && !self.timed_out
    }
}

/// 多根全量预热：遍历全部根，合并文件清单，收集失败，执行上限护栏。
///
/// 文件数与超时预算均为**全根合计**口径：任一根耗尽预算后停止后续根，
/// 并以 `truncated` / `timed_out` 如实标记，调用方可观测。
pub fn warm_index(roots: &[String], limits: &WarmupLimits) -> WarmupReport {
    let deadline = Instant::now() + limits.timeout;
    let mut report = WarmupReport {
        root_count: roots.len(),
        ..Default::default()
    };

    for root in roots {
        // 文件数预算耗尽：截断并停止（超限行为有界、可测）
        if report.files.len() >= limits.max_files {
            report.truncated = true;
            break;
        }
        // 超时预算耗尽：提前停止
        if Instant::now() >= deadline {
            report.timed_out = true;
            break;
        }
        let path = Path::new(root);
        if !path.is_dir() {
            report.root_errors.push(WarmupRootError {
                root: root.clone(),
                message: "根不存在或不是目录，已跳过".to_string(),
            });
            continue;
        }
        let remaining = limits.max_files - report.files.len();
        let outcome =
            super::walker::build_directory_index_limited(root, Some(remaining), Some(deadline));
        let super::walker::WalkOutcome {
            files,
            truncated,
            timed_out,
            entry_errors,
        } = outcome;
        report.files.extend(files);
        if truncated {
            report.truncated = true;
        }
        if timed_out {
            report.timed_out = true;
        }
        for (entry_path, message) in entry_errors {
            report.entry_error_count += 1;
            if report.entry_error_samples.len() < ENTRY_ERROR_SAMPLES {
                report.entry_error_samples.push(WarmupEntryError {
                    root: root.clone(),
                    path: entry_path,
                    message,
                });
            }
        }
    }

    // 多根可能嵌套重叠（根 A 是根 B 的子目录）→ 全局排序去重
    report.files.sort();
    report.files.dedup();
    report
}

/// 搜索索引槽：Arc 交换（读方零拷贝）+ 代数（generation）守卫。
///
/// - [`IndexCell::rebuild`]：手动重建，无条件覆盖并推进代数；
/// - [`IndexCell::commit_if_current`]：预热提交，仅当代数未被推进时写入；
///   预热构建期间发生过手动重建 → 拒绝并返回当前代数（防旧覆盖新）。
#[derive(Debug, Default)]
pub struct IndexCell {
    files: RwLock<Arc<Vec<String>>>,
    generation: AtomicU64,
}

impl IndexCell {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前索引快照（Arc clone，零数据拷贝；锁中毒时以 panic 载荷回退）。
    pub fn snapshot(&self) -> Arc<Vec<String>> {
        self.files
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 当前代数。
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// 手动重建：无条件覆盖，代数 +1，返回新代数。
    pub fn rebuild(&self, files: Vec<String>) -> u64 {
        let mut lock = self.files.write().unwrap_or_else(|e| e.into_inner());
        *lock = Arc::new(files);
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 预热提交：仅当代数仍为 `expected` 时写入（写入与代数比对在同一把
    /// 写锁内完成，与 [`IndexCell::rebuild`] 互斥），代数 +1；
    /// 代数已推进 → `Err(当前代数)`，提交被拒绝。
    pub fn commit_if_current(&self, files: Vec<String>, expected: u64) -> Result<u64, u64> {
        let mut lock = self.files.write().unwrap_or_else(|e| e.into_inner());
        let current = self.generation.load(Ordering::SeqCst);
        if current != expected {
            return Err(current);
        }
        *lock = Arc::new(files);
        Ok(current + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_cell_starts_empty_generation_zero() {
        let cell = IndexCell::new();
        assert!(cell.snapshot().is_empty());
        assert_eq!(cell.generation(), 0);
    }

    #[test]
    fn rebuild_overrides_and_bumps_generation() {
        let cell = IndexCell::new();
        let g1 = cell.rebuild(vec!["a.rs".to_string()]);
        assert_eq!(g1, 1);
        assert_eq!(cell.snapshot().as_slice(), ["a.rs"]);
        let g2 = cell.rebuild(vec!["b.rs".to_string()]);
        assert_eq!(g2, 2);
        assert_eq!(cell.snapshot().as_slice(), ["b.rs"]);
    }
}
