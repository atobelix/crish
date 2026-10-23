//! 测试基础设施域（T11.7：PE-11 §2 T11.7 的公共能力收口）
//!
//! - [setup_test_env]：测试环境初始化（幂等）；
//! - [TempWorkspace]：RAII 临时工作区（drop 自动清理 / 失败保留 /
//!   fixture 复制）；
//! - [assert_json_roundtrip]：JSON 序列化往返断言；
//! - [assertions]：公共断言助手（事件序列 / delta 拼接 / 请求文本 /
//!   子序列，05 §6.2 建议一等公民化）；
//! - [clock]：注入式时钟与虚拟时间护栏（AA-01 Q41 承接，时间确定性）。
//!
//! 依赖边界（T11.7.1）：只依赖 conex-types（域类型叶子 crate），
//! 不依赖 session-loop/orchestrator 等业务 crate，杜绝循环依赖。

// 豁免理由：纯测试基础设施 crate，TempWorkspace RAII 析构时清理临时工作区目录（见 clippy.toml 豁免约定）
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

pub mod assertions;
pub mod clock;

// 顶层便捷再导出：断言助手与时钟能力按名直接引用（模块路径亦可）
pub use assertions::{
    assert_contains_subsequence, assert_event_sequence, assert_message_delta_concatenation,
    assert_message_text_contains, assert_request_text_contains,
};
pub use clock::{TestClock, TimePauseGuard};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// 初始化测试环境（幂等）。
/// 为测试输出装配 tracing subscriber（未初始化时）。
pub fn setup_test_env() {
    // 幂等：try_init 失败 = 既有 subscriber 已生效，显式放弃冲突错误。
    let _first_init_won = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
}

/// RAII 临时工作区：drop 时自动清理目录。
///
/// 保留现场两种途径（T11.7.1）：
/// - 环境变量 `CONEX_TEST_KEEP=1` 全局保留（调试用，不删目录）；
/// - [Self::keep_on_failure] 按实例标记保留，drop 时打印目录路径。
pub struct TempWorkspace {
    path: PathBuf,
    keep: bool,
}

impl TempWorkspace {
    /// 新建临时工作区目录（前缀区分测试场景；目录名含进程号防并发冲突）
    pub fn new(prefix: &str) -> Self {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("conex_test_{prefix}_{id}_{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("创建临时工作区失败");
        // 环境变量兜底：CONEX_TEST_KEEP=1 时全局保留（排查失败现场）
        let keep = std::env::var("CONEX_TEST_KEEP")
            .map(|v| v == "1")
            .unwrap_or(false);
        Self { path, keep }
    }

    /// 标记保留：drop 时不清除目录并打印路径（失败路径调试现场用）
    pub fn keep_on_failure(mut self) -> Self {
        self.keep = true;
        self
    }

    /// 工作区根路径
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// 工作区根路径字符串（便捷返回）
    pub fn path_str(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    /// 在工作区内创建文件（相对路径，自动建父目录）
    pub fn write_file(&self, relative_path: &str, content: &str) -> PathBuf {
        let full_path = self.path.join(relative_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).expect("创建父目录失败");
        }
        std::fs::write(&full_path, content).expect("写入文件失败");
        full_path
    }

    /// 读取工作区内文件
    pub fn read_file(&self, relative_path: &str) -> String {
        let full_path = self.path.join(relative_path);
        std::fs::read_to_string(&full_path).expect("读取文件失败")
    }

    /// 复制 fixture（文件或目录）到工作区指定相对路径（T11.7.1）。
    ///
    /// `from` 为文件时复制到 `to`；为目录时整体递归复制（保留相对结构）。
    pub fn copy_fixture(&self, from: &Path, to: &str) -> PathBuf {
        let target = self.path.join(to);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("创建父目录失败");
        }
        if from.is_dir() {
            copy_dir_all(from, &target);
        } else {
            std::fs::copy(from, &target).expect("复制 fixture 文件失败");
        }
        target
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        if self.keep {
            println!(
                "[conex-test-utils] 保留临时工作区（keep_on_failure 标记）：{}",
                self.path.display()
            );
            return;
        }
        // 清理失败不 panic（Drop 语义）：记录到 stderr 后忽略，保留
        // 现场的排查途径走 CONEX_TEST_KEEP=1。
        if let Err(e) = std::fs::remove_dir_all(&self.path) {
            eprintln!(
                "[conex-test-utils] 临时工作区清理失败（忽略）: {}: {}",
                self.path.display(),
                e
            );
        }
    }
}

/// 递归复制目录（[TempWorkspace::copy_fixture] 内部用）
fn copy_dir_all(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("创建目标目录失败");
    for entry in std::fs::read_dir(from).expect("读取 fixture 目录失败") {
        let entry = entry.expect("读取目录条目失败");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("读取文件类型失败").is_dir() {
            copy_dir_all(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("复制 fixture 文件失败");
        }
    }
}

/// 断言值经过 JSON 序列化/反序列化往返后与原值相等
pub fn assert_json_roundtrip<T>(value: &T)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let json = serde_json::to_string(value).expect("序列化失败");
    let back: T = serde_json::from_str(&json).expect("反序列化失败");
    assert_eq!(value, &back, "往返不一致");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_workspace_creates_and_cleans() {
        let path;
        {
            let ws = TempWorkspace::new("lifecycle");
            path = ws.path().clone();
            assert!(path.exists());
        }
        // drop 后目录应被移除
        assert!(!path.exists());
    }

    #[test]
    fn temp_workspace_write_and_read() {
        let ws = TempWorkspace::new("rw");
        ws.write_file("sub/dir/file.txt", "hello world");
        let content = ws.read_file("sub/dir/file.txt");
        assert_eq!(content, "hello world");
    }

    #[test]
    fn temp_workspace_path_str() {
        let ws = TempWorkspace::new("pathstr");
        assert_eq!(ws.path_str(), ws.path().to_string_lossy());
        assert!(ws.path_str().contains("conex_test_pathstr"));
    }

    #[test]
    fn temp_workspace_keep_on_failure_preserves_dir() {
        let path;
        {
            let ws = TempWorkspace::new("keep").keep_on_failure();
            path = ws.path().clone();
            assert!(path.exists());
        }
        // keep_on_failure 标记后 drop 不清理（现场保留语义）
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&path);
        assert!(!path.exists());
    }

    #[test]
    fn temp_workspace_copy_fixture_file_and_dir() {
        // 准备外部 fixture：单文件 + 嵌套目录
        let fixture_root = TempWorkspace::new("fixture_src");
        fixture_root.write_file("seed.txt", "种子内容");
        fixture_root.write_file("nested/inner.txt", "内层内容");

        let ws = TempWorkspace::new("fixture_dst");
        // 单文件复制
        let file_copy = ws.copy_fixture(&fixture_root.path().join("seed.txt"), "seed.txt");
        assert_eq!(ws.read_file("seed.txt"), "种子内容");
        assert_eq!(file_copy, ws.path().join("seed.txt"));
        // 目录整体复制（保留相对结构）
        ws.copy_fixture(&fixture_root.path().join("nested"), "copied");
        assert_eq!(ws.read_file("copied/inner.txt"), "内层内容");
        assert_eq!(
            ws.read_file("copied/inner.txt"),
            fixture_root.read_file("nested/inner.txt")
        );
    }

    #[test]
    fn json_roundtrip_helper() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Sample {
            name: String,
            value: i32,
        }
        let sample = Sample {
            name: "test".into(),
            value: 42,
        };
        assert_json_roundtrip(&sample);
    }
}
