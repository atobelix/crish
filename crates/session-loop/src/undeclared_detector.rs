//! 未声明写入判定器（T-ESC-02 判定面：脚本逃逸追踪的判定基准）
//!
//! 逃逸追踪主方案（docs/feature-gap-analysis/REQ-逃逸追踪分析.md §3.1/3.2）：
//! watcher 事件 × 声明基准 → 归因报告。声明基准 =
//! [WritePathRegistry::active_claims]（write_paths.rs:260-262 快照），
//! Overlaps 复用 [paths_overlap_normalized] 语义（write_paths.rs:333-341：
//! 前缀组件边界一致——`a/b` 命中 `a/b/c.txt`，`a/b` 与 `a/bc` 不命中，
//! Windows 大小写折叠）。
//!
//! 依赖方向：session-loop → agent-tools（agent-tools/src/audit.rs:11-12
//! 记载的既有方向）；事件形状取 conex-fs::watch（T-ESC-01 数据面产物）。
//!
//! 诚实边界（§3.1）：判定粒度是「声明覆盖 or 未覆盖」，不承诺命令级归因
//! （notify 事件无进程来源）；未接线声明基准的会话由 P3 装配面要求接线
//! （推荐，壳层装配已存在）。

use agent_tools::write_paths::{paths_overlap_normalized, WritePathRegistry};
use conex_fs::watch::FileChangeEvent;
use std::sync::Arc;

/// 未声明写入判定器：watcher 事件 × 声明基准 → 归因报告
pub trait UndeclaredWriteDetector: Send + Sync {
    /// 判定单条变更是否被声明覆盖；false = 未覆盖（需上报）
    fn is_declared(&self, event: &FileChangeEvent) -> bool;
}

/// 注册表适配实现：比对 [WritePathRegistry::active_claims] 快照
///
/// 任意一条活跃声明与事件路径 Overlaps（同路径 / 声明目录命中子文件 /
/// 声明文件命中其下子路径）即视为已声明；全部不命中则未声明（工具外
/// 写入候选）。
pub struct RegistryBackedDetector {
    /// 会话级写路径注册表（与工具执行期共享同一实例）
    registry: Arc<WritePathRegistry>,
}

impl RegistryBackedDetector {
    /// 新建判定器（注册表须与会话执行上下文同源）
    pub fn new(registry: Arc<WritePathRegistry>) -> Self {
        Self { registry }
    }
}

impl UndeclaredWriteDetector for RegistryBackedDetector {
    fn is_declared(&self, event: &FileChangeEvent) -> bool {
        self.registry
            .active_claims()
            .iter()
            .any(|c| paths_overlap_normalized(&c.path, &event.path))
    }
}

#[cfg(test)]
mod tests {
    // 测试构造临时工作区（目录清理归 TempWorkspace RAII，非产品删除路径）
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use agent_tools::write_paths::ClaimMode;
    use conex_test_utils::TempWorkspace;

    /// 构造测试事件（occurred_at_ms 固定值，判定与时间无关）
    fn event_at(rel: &str, ws: &TempWorkspace) -> FileChangeEvent {
        FileChangeEvent {
            path: ws.path().join(rel),
            kind: conex_fs::watch::ChangeKind::Created,
            from: None,
            occurred_at_ms: 1000,
        }
    }

    #[test]
    fn declared_directory_matches_child_file() {
        // 声明目录 src/ → 子文件 src/lib.rs 命中（Overlaps 前缀语义）
        let ws = TempWorkspace::new("det_dir");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _g = registry.claim_one("runA", "src", ClaimMode::Write).unwrap();
        let detector = RegistryBackedDetector::new(registry);

        assert!(
            detector.is_declared(&event_at("src/lib.rs", &ws)),
            "声明目录必须命中子文件"
        );
        assert!(
            detector.is_declared(&event_at("src/deep/main.rs", &ws)),
            "声明目录必须命中深层子文件"
        );
        assert!(
            detector.is_declared(&event_at("src", &ws)),
            "声明目录自身事件必须命中"
        );
    }

    #[test]
    fn same_path_matches() {
        // 声明文件 x.txt → 同路径事件命中
        let ws = TempWorkspace::new("det_same");
        ws.write_file("x.txt", "x");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _g = registry
            .claim_one("runA", "x.txt", ClaimMode::Write)
            .unwrap();
        let detector = RegistryBackedDetector::new(registry);
        assert!(
            detector.is_declared(&event_at("x.txt", &ws)),
            "同路径必须命中"
        );
    }

    #[test]
    fn siblings_and_component_boundary_not_matched() {
        // 兄弟文件不命中（声明 a/x.txt，事件 a/y.txt）
        let ws = TempWorkspace::new("det_sib");
        ws.write_file("a/x.txt", "x");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _g = registry
            .claim_one("runA", "a/x.txt", ClaimMode::Write)
            .unwrap();
        let detector = RegistryBackedDetector::new(registry);
        assert!(
            !detector.is_declared(&event_at("a/y.txt", &ws)),
            "兄弟文件不得命中"
        );

        // 组件边界：声明 a/b 不命中 a/bc.txt（前缀必须在组件边界）
        let ws2 = TempWorkspace::new("det_bound");
        let registry2 = Arc::new(WritePathRegistry::new("s1", ws2.path()));
        let _g2 = registry2
            .claim_one("runA", "a/b", ClaimMode::Write)
            .unwrap();
        let detector2 = RegistryBackedDetector::new(registry2);
        assert!(
            !detector2.is_declared(&event_at("a/bc.txt", &ws2)),
            "组件边界外不得命中"
        );
    }

    #[test]
    fn no_active_claims_means_not_declared() {
        // 无声明（未接线/已释放）：一律未声明（需上报）
        let ws = TempWorkspace::new("det_none");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let detector = RegistryBackedDetector::new(registry);
        assert!(
            !detector.is_declared(&event_at("anything.txt", &ws)),
            "无声明必须未声明"
        );

        // 守卫 Drop 释放后：声明消失，同路径变为未声明
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let guard = registry
            .claim_one("runA", "x.txt", ClaimMode::Write)
            .unwrap();
        let detector = RegistryBackedDetector::new(registry);
        ws.write_file("x.txt", "x");
        assert!(
            detector.is_declared(&event_at("x.txt", &ws)),
            "持守卫期必须声明"
        );
        drop(guard);
        assert!(
            !detector.is_declared(&event_at("x.txt", &ws)),
            "守卫释放后必须未声明"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_folding_matches() {
        // Windows 大小写折叠：声明 src/File.txt（大写），事件 SRC/file.txt
        // （全小写）→ 归一化后必须命中（write_paths Overlaps 同语义）
        let ws = TempWorkspace::new("det_case");
        ws.write_file("Src/File.txt", "x");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _g = registry
            .claim_one("runA", "src/File.txt", ClaimMode::Write)
            .unwrap();
        let detector = RegistryBackedDetector::new(registry);
        assert!(
            detector.is_declared(&event_at("SRC/file.txt", &ws)),
            "Windows 语义必须大小写折叠命中"
        );
    }

    #[test]
    fn detector_rejects_workspace_outside_event() {
        // 工作区外事件：注册表声明的都是工作区内路径，工作区外路径不命中
        let ws = TempWorkspace::new("det_outside");
        let registry = Arc::new(WritePathRegistry::new("s1", ws.path()));
        let _g = registry.claim_one("runA", "src", ClaimMode::Write).unwrap();
        let detector = RegistryBackedDetector::new(registry);
        let outside = FileChangeEvent {
            path: std::env::temp_dir().join("outside.txt"),
            kind: conex_fs::watch::ChangeKind::Created,
            from: None,
            occurred_at_ms: 1000,
        };
        assert!(!detector.is_declared(&outside), "工作区外事件不得命中声明");
    }
}
