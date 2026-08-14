//! 导航栈（维度 10 §6.4）：标签 URL 列表快照与恢复
//!
//! - 维护：维度 11 的 Target/Page 事件持续更新（新标签/导航/关闭/切换），本模块只存不解释；
//! - 落盘：状态变化后异步写 `nav_stack.json`（会话 profile 根；防浏览器崩溃瞬间内存态丢失），
//!   崩溃重启后读取覆盖内存态（U-7 分工：本模块仅保留崩溃瞬间快照，恢复编排归维度 15）；
//! - 序列化：serde 往返（`serialize_roundtrip` 单测），URL 用 `url::Url` 规范表示。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁；读写全部经值传递。

use serde::{Deserialize, Serialize};
use std::path::Path;
use url::Url;

/// 导航栈落盘文件名（会话 profile 根）。
pub const NAV_STACK_FILE: &str = "nav_stack.json";

/// 单个标签条目（TargetId 由维度 11 重建，本模块不承载）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabEntry {
    pub url: Url,
    pub pinned: bool,
}

/// 导航栈：标签列表 + 活动标签索引。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct NavStack {
    pub tabs: Vec<TabEntry>,
    pub active: usize,
}

impl NavStack {
    /// 空栈。
    pub fn new() -> Self {
        Self::default()
    }

    /// 追加标签（返回新索引）。
    pub fn push(&mut self, url: Url, pinned: bool) -> usize {
        self.tabs.push(TabEntry { url, pinned });
        self.tabs.len() - 1
    }

    /// 移除标签（越界忽略）；活动索引随之收敛。
    pub fn remove(&mut self, idx: usize) {
        if idx >= self.tabs.len() {
            return;
        }
        self.tabs.remove(idx);
        if self.tabs.is_empty() {
            self.active = 0;
        } else if self.active >= self.tabs.len() {
            self.active = self.tabs.len() - 1;
        } else if self.active > idx {
            self.active -= 1;
        }
    }

    /// 切换活动标签（越界忽略）。
    pub fn set_active(&mut self, idx: usize) {
        if idx < self.tabs.len() {
            self.active = idx;
        }
    }

    /// 活动标签条目（空栈 → None）。
    pub fn active_entry(&self) -> Option<&TabEntry> {
        self.tabs.get(self.active)
    }

    /// 序列化为 JSON 字符串（落盘）。
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// 从 JSON 字符串恢复（损坏时返回错误，调用方决定回退内存态）。
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// 同步落盘到指定路径（写入失败仅由调用方记 warning，不阻断主流程）。
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = self
            .to_json()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        std::fs::write(path, json)
    }

    /// 从指定路径读取（不存在 → Ok(None)；损坏 → Err，调用方回退内存态）。
    pub fn load(path: &Path) -> std::io::Result<Option<Self>> {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        match Self::from_json(&String::from_utf8_lossy(&bytes)) {
            Ok(s) => Ok(Some(s)),
            Err(e) => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e.to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use url::Url;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    /// 序列化往返一致（tabs/active 全量字段）。
    #[test]
    fn serialize_roundtrip() {
        let mut stack = NavStack::new();
        stack.push(u("https://a.example"), false);
        stack.push(u("https://b.example"), true);
        stack.push(u("https://c.example"), false);
        stack.set_active(1);

        let json = stack.to_json().expect("序列化");
        let back = NavStack::from_json(&json).expect("反序列化");
        assert_eq!(back, stack);
        assert_eq!(back.active, 1);
        assert_eq!(back.tabs.len(), 3);
        assert!(back.tabs[1].pinned);
        assert_eq!(back.tabs[0].url.as_str(), "https://a.example/");
    }

    /// 恢复保序 + 激活标签正确。
    #[test]
    fn restore_order_and_active() {
        let json = r#"{"tabs":[{"url":"https://x.example/","pinned":false},{"url":"https://y.example/","pinned":false}],"active":1}"#;
        let stack = NavStack::from_json(json).expect("解析");
        assert_eq!(stack.active, 1);
        assert_eq!(
            stack.active_entry().unwrap().url.as_str(),
            "https://y.example/"
        );
        assert_eq!(stack.tabs[0].url.as_str(), "https://x.example/");
    }

    /// 损坏 JSON → 错误（不静默回退）。
    #[test]
    fn corrupt_json_is_error() {
        assert!(NavStack::from_json("{not json").is_err());
        assert!(NavStack::from_json(r#"{"tabs": 42}"#).is_err());
    }

    /// remove 的索引收敛语义。
    #[test]
    fn remove_adjusts_active() {
        let mut s = NavStack::new();
        s.push(u("https://a.example"), false);
        s.push(u("https://b.example"), false);
        s.push(u("https://c.example"), false);
        s.set_active(2);
        s.remove(2);
        assert_eq!(s.active, 1);
        s.remove(0);
        assert_eq!(s.active, 0);
        s.remove(5); // 越界忽略
        assert_eq!(s.tabs.len(), 1);
    }

    /// 落盘/读取往返（tempfile）。
    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join(NAV_STACK_FILE);
        let mut s = NavStack::new();
        s.push(u("https://roundtrip.example"), false);
        s.save(&path).expect("落盘");
        let back = NavStack::load(&path).expect("读取").expect("文件存在");
        assert_eq!(back, s);
        // 不存在 → None
        assert!(NavStack::load(&dir.path().join("missing.json"))
            .expect("读取")
            .is_none());
    }
}
