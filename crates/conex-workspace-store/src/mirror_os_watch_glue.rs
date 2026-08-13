//! `mirror_os_watch` detect / poll 胶水（**SD-51** 胶水再抽）。
//!
//! 由父模 [`crate::mirror_os_watch`] 经 `#[path]` 接入。
//! **诚实**：**不** apply / **不** import；**≠ EL-03**；**≠** A-INV-02 产品 UI；
//! **≠** 占 SD-19/36；**≠** 默认双开 poll+OS；**≠** inotify 产品满关。

use super::path::paths_equal_for_mirror;
use super::MirrorOsEvent;
use crate::mirror::{MirrorDriftReport, MirrorWatchPollResult};
use crate::{StoreError, WorkspaceStore};

/// 若 OS 事件路径命中该 doc 当前 mirror path，则跑 [`WorkspaceStore::detect_mirror_drift`]。
///
/// - 命中 → `Some(report)`（含三路分类）
/// - 未命中 / 无 meta path → `Ok(None)`（事件与本 doc 无关）
///
/// **诚实**：
/// - **不** apply / **不** import；仅 detect。
/// - **≠** A-INV-02 产品 UI；**≠ EL-03**。
/// - **≠**「有 poll 即 inotify」——本函数消费的是 **OS 事件 hint**，与 poll 并行。
pub fn detect_if_os_event_hits_mirror(
    store: &WorkspaceStore,
    doc_id: &str,
    authority_rev: u64,
    event: &MirrorOsEvent,
) -> Result<Option<MirrorDriftReport>, StoreError> {
    let report = store.detect_mirror_drift(doc_id, authority_rev)?;
    if report.path.as_os_str().is_empty() {
        return Ok(None);
    }
    if paths_equal_for_mirror(&report.path, &event.path) {
        Ok(Some(report))
    } else {
        Ok(None)
    }
}

/// OS 事件命中后：用 [`crate::MirrorWatchHandle::poll_mirror_once`] 刷新指纹基线并得完整 poll 结果。
///
/// 组合路径：`OS hint → poll/detect`；**仍 ≠** 产品 UI / EL-03。
/// **≠** 默认双开：调用方显式组合，本函数不启动 poll watcher。
pub fn poll_on_os_hint(
    handle: &mut crate::MirrorWatchHandle,
    store: &WorkspaceStore,
    authority_rev: u64,
    event: &MirrorOsEvent,
) -> Result<Option<MirrorWatchPollResult>, StoreError> {
    let report = store.detect_mirror_drift(handle.doc_id(), authority_rev)?;
    if report.path.as_os_str().is_empty() {
        return Ok(None);
    }
    if !paths_equal_for_mirror(&report.path, &event.path) {
        return Ok(None);
    }
    // 命中后走既有 poll（指纹 + 分类）；不绕过 X-05 / detect
    let r = handle.poll_mirror_once(store, authority_rev)?;
    Ok(Some(r))
}
