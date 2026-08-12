//! W2-E Strict · P6 外部改盘：detect → 分类 → 三路提案 + **可轮询 watcher 入口**（A-INV-02 / X-05 方向）。
//!
//! # 模块内聚（SD-10）
//! - [`mirror_detect`]：[`WorkspaceStore::detect_mirror_drift`] + 漂移分类/报告
//! - [`mirror_import`]：[`ThreeWayStrategy`] / [`import_mirror_proposal`] 三路提案（X-05 禁静默盖）
//! - [`mirror_poll`]：[`MirrorWatchHandle`] / [`poll_mirror_once`] / [`MirrorWatcher`] 轮询子集
//! - 本文件：**薄 re-export 门面**（公开 API 路径不变：`crate::mirror::*` / `crate::*`）
//! - OS 事件封装（同 crate · [`crate::mirror_os_watch`]）与 poll **并存**；**禁止**用 poll 叙事冒充 inotify 满关
//!
//! # 地基 vs 本包新增
//! - **W2-E-S 已有地基**（`lib` / `projection`）：`export_md_mirror` + `mirror_lag` /
//!   `note_authority_advanced` + `commit_ops_with_mirror`（export + lag 水位）。
//! - **detect/三路**：见 [`mirror_detect`] / [`mirror_import`]
//! - **轮询 watcher 子集**：见 [`mirror_poll`]
//!
//! # 诚实边界（不可冒充）
//! - **本模块 poll 路径 ≠ OS inotify/FSEvents 生产满关**：poll 靠上层 timer / 测试直接调
//!   [`MirrorWatchHandle::poll_mirror_once`] 或 [`MirrorWatcher::poll_once`]。
//! - **OS 路径**见 [`crate::mirror_os_watch`]（notify 封装）；有 OS 入口 **仍 ≠**
//!   A-INV-02 产品 UI / 桌面订阅全链路 / **EL-03**。
//! - **≠ A-INV-02 产品 UI**：不弹三路对话框、不接线桌面；仅交付 **可测观察入口**。
//! - **≠ EL-03**（恢复/打开叙事属 G-HYD / W3 等，不在本模块）。
//! - **≠ Wave 2 存储完成**（杀进程权威恢复、refs 自动物化等分属他包）。
//! - 仅 export+lag **≠** P6 完成；detect/三路 + 轮询/OS watcher 仍 **≠** 产品 UI 三路对话框满关。
//!
//! # 不变量（S1 / X-05）
//! 1. mirror **非**权威；工具默认 **禁止** 读 `exports/**` / mirror 文件当 get_md。
//! 2. `import_mirror_proposal` **只提案**，从不 `apply` / 从不改 `doc_updates`。
//! 3. `unpushed_op_count > 0` 且策略非显式 [`ThreeWayStrategy::DropUnacked`] 时，
//!    **禁止**产出「可静默盖写」路径；默认/冲突 → [`ImportMirrorResult::Conflict`]。
//! 4. **禁止**默认 fullRemount 当唯一路径：提案优先块级 TextEdit/Insert/Delete，
//!    而非「删光整树再挂载」。

// 实现拆至同 crate 内聚子模块；本文件仅 re-export 保持公开 API 稳定。
#[doc(inline)]
pub use crate::mirror_detect::{MirrorDriftClass, MirrorDriftReport};
#[doc(hidden)]
pub(crate) use crate::mirror_detect::file_mtime_ms;

#[doc(inline)]
pub use crate::mirror_import::{
    ConflictBlockInfo, ImportMirrorOpts, ImportMirrorResult, ThreeWayStrategy,
};

#[doc(inline)]
pub use crate::mirror_poll::{
    poll_mirror_once, MirrorFileFingerprint, MirrorWatchHandle, MirrorWatchPollResult,
    MirrorWatcher,
};
