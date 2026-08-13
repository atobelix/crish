//! `mirror_os_watch` 测试注入事件源（**SD-51** 胶水再抽）。
//!
//! 由父模 [`crate::mirror_os_watch`] 经 `#[path]` 接入。
//! **诚实**：Fake 绿 **≠** OS watcher 生产满关；**≠ EL-03**；**≠** 占 SD-19/36；**≠** 默认双开。

use super::{MirrorOsEvent, MirrorOsEventKind, MirrorOsEventSource};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

/// 测试注入用事件源（**不是** OS inotify；用于 trait 契约测）。
///
/// **诚实**：Fake 绿 **≠** OS watcher 生产满关；真 OS 路径见
/// `os_watcher_emits_event_on_mirror_file_write`。
#[derive(Debug, Default)]
pub struct FakeMirrorOsEventSource {
    queue: VecDeque<MirrorOsEvent>,
}

impl FakeMirrorOsEventSource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, event: MirrorOsEvent) {
        self.queue.push_back(event);
    }

    pub fn push_modified(&mut self, path: impl Into<PathBuf>) {
        self.push(MirrorOsEvent {
            path: path.into(),
            kind: MirrorOsEventKind::Modified,
        });
    }
}

impl MirrorOsEventSource for FakeMirrorOsEventSource {
    fn try_recv_event(&mut self) -> Option<MirrorOsEvent> {
        self.queue.pop_front()
    }

    fn recv_event_timeout(&mut self, _timeout: Duration) -> Option<MirrorOsEvent> {
        self.queue.pop_front()
    }
}
