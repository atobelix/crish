//! 原生 Webview COM 事件监听 Token RAII 寄存器与生命周期守护
//!
//! 依据 `docs/native-browser-overhaul/audits/02-concurrency-and-win32-runtime-audit.md` §2.3 / §3.2 编制。
//!
//! # 核心问题与设计原则
//! Windows WebView2 中所有事件挂载 API（`add_AcceleratorKeyPressed`、`add_NavigationStarting`、`add_ProcessFailed` 等）
//! 都会向调用方返回一个 64 位整数凭据 `token: i64`（COM EventRegistrationToken）。
//!
//! 若在 Webview 销毁时未显式调用对应的 `remove_*` 接口：
//! 1. WebView2 COM 事件源将永久持有 Rust 闭包的虚表接口引用；
//! 2. 闭包内部捕获的上下文导致 COM 对象引用计数无法归零；
//! 3. 产生 COM 循环引用泄漏，导致底层 `msedgewebview2.exe` 进程在窗口关闭后沦为僵尸孤儿进程，
//!    句柄（User / GDI Objects）持续耗尽。
//!
//! 本模块提供 [EventTokenRegistry]：强类型的 Token 寄存器，支持细粒度分类追踪
//! 与逆序（LIFO）确定性注销。注销时机由 `native_manager` 的 `close()` /
//! `close_all()` 在主线程上显式触发（注销必须经 STA 线程访问 COM 接口，
//! 因此不做成 Drop 守卫——Drop 的调用线程不可控）。

#![allow(unsafe_code)]
#![allow(dead_code)]

#[cfg(windows)]
use windows_core::Interface;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControllerTokenKind {
    /// 快捷键预拦截监听 (add_AcceleratorKeyPressed)
    AcceleratorKeyPressed,
    /// 缩放比例变动监听 (add_ZoomFactorChanged)
    ZoomFactorChanged,
    /// 焦点移动请求 (add_MoveFocusRequested)
    MoveFocusRequested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CoreTokenKind {
    /// 导航发起拦截 (add_NavigationStarting)
    NavigationStarting,
    /// 导航完成 (add_NavigationCompleted)
    NavigationCompleted,
    /// 地址源变更 (add_SourceChanged)
    SourceChanged,
    /// 标题变更 (add_DocumentTitleChanged)
    DocumentTitleChanged,
    /// 历史记录变更 (add_HistoryChanged)
    HistoryChanged,
    /// 进程崩溃或挂起 (add_ProcessFailed)
    ProcessFailed,
    /// 新窗口弹出拦截 (add_NewWindowRequested)
    NewWindowRequested,
    /// WebMessage 消息接收 (add_WebMessageReceived)
    WebMessageReceived,
    /// 硬件/设备权限申请 (add_PermissionRequested)
    PermissionRequested,
    /// 全屏状态变更 (add_ContainsFullScreenElementChanged)
    ContainsFullScreenElementChanged,
    /// 网页请求关闭窗口 (add_WindowCloseRequested)
    WindowCloseRequested,
    /// 下载发起拦截 (add_DownloadStarting)
    DownloadStarting,
}

/// Token 记录项
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenEntry {
    /// Controller 级别的事件 Token
    Controller {
        kind: ControllerTokenKind,
        token: i64,
    },
    /// Core 级别的事件 Token
    Core { kind: CoreTokenKind, token: i64 },
    /// 自定义命名的扩展 Token
    Custom { name: String, token: i64 },
}

/// RAII 风格的事件监听 Token 寄存器
#[derive(Debug, Default)]
pub struct EventTokenRegistry {
    tokens: Vec<TokenEntry>,
}

impl EventTokenRegistry {
    /// 构造空的 Token 寄存器
    pub fn new() -> Self {
        Self { tokens: Vec::new() }
    }

    /// 登记一个 Controller 级别事件 Token
    pub fn register_controller(&mut self, kind: ControllerTokenKind, token: i64) {
        self.tokens.push(TokenEntry::Controller { kind, token });
    }

    /// 登记一个 Core 级别事件 Token
    pub fn register_core(&mut self, kind: CoreTokenKind, token: i64) {
        self.tokens.push(TokenEntry::Core { kind, token });
    }

    /// 注册快捷键拦截 Token (常用快捷入口)
    pub fn register_accelerator(&mut self, token: i64) {
        self.register_controller(ControllerTokenKind::AcceleratorKeyPressed, token);
    }

    /// 注册导航开始 Token
    pub fn register_navigation_starting(&mut self, token: i64) {
        self.register_core(CoreTokenKind::NavigationStarting, token);
    }

    /// 注册导航完成 Token
    pub fn register_navigation_completed(&mut self, token: i64) {
        self.register_core(CoreTokenKind::NavigationCompleted, token);
    }

    /// 注册源地址变更 Token
    pub fn register_source_changed(&mut self, token: i64) {
        self.register_core(CoreTokenKind::SourceChanged, token);
    }

    /// 注册文档标题变更 Token
    pub fn register_document_title_changed(&mut self, token: i64) {
        self.register_core(CoreTokenKind::DocumentTitleChanged, token);
    }

    /// 注册历史栈变更 Token
    pub fn register_history_changed(&mut self, token: i64) {
        self.register_core(CoreTokenKind::HistoryChanged, token);
    }

    /// 注册 WebView2 原生拾取消息接收 Token。
    pub fn register_web_message_received(&mut self, token: i64) {
        self.register_core(CoreTokenKind::WebMessageReceived, token);
    }

    /// 注册进程失败/崩溃监控 Token
    pub fn register_process_failed(&mut self, token: i64) {
        self.register_core(CoreTokenKind::ProcessFailed, token);
    }

    /// 注册弹窗拦截 Token
    pub fn register_new_window_requested(&mut self, token: i64) {
        self.register_core(CoreTokenKind::NewWindowRequested, token);
    }

    /// 注册权限拦截 Token
    pub fn register_permission_requested(&mut self, token: i64) {
        self.register_core(CoreTokenKind::PermissionRequested, token);
    }

    /// 注册全屏元素状态变更 Token
    pub fn register_contains_fullscreen_element_changed(&mut self, token: i64) {
        self.register_core(CoreTokenKind::ContainsFullScreenElementChanged, token);
    }

    /// 注册窗口关闭请求 Token
    pub fn register_window_close_requested(&mut self, token: i64) {
        self.register_core(CoreTokenKind::WindowCloseRequested, token);
    }

    /// 注册下载发起监听 Token
    pub fn register_download_starting(&mut self, token: i64) {
        self.register_core(CoreTokenKind::DownloadStarting, token);
    }

    /// 注册自定义扩展 Token
    pub fn register_custom(&mut self, name: impl Into<String>, token: i64) {
        self.tokens.push(TokenEntry::Custom {
            name: name.into(),
            token,
        });
    }

    /// 当前已登记的 Token 数量
    #[inline]
    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    /// 当前是否为空
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    /// 获取 Token 列表只读切片
    #[inline]
    pub fn tokens(&self) -> &[TokenEntry] {
        &self.tokens
    }

    /// 清空登记列表（不执行底层注销）
    pub fn clear(&mut self) {
        self.tokens.clear();
    }

    /// 按照后进先出（LIFO，逆序）排空所有已记录的 Token
    pub fn drain_lifo(&mut self) -> Vec<TokenEntry> {
        let mut drained = Vec::with_capacity(self.tokens.len());
        while let Some(entry) = self.tokens.pop() {
            drained.push(entry);
        }
        drained
    }

    /// 在 Windows 平台上，按照逆序显式注销所有已注册的 COM 事件
    ///
    /// # 异常保障
    /// 即使某一个 Token 注销失败，也不会中断循环，将继续尝试卸载其余全部 Token，
    /// 并汇总所有错误信息返回，确保最大程度释放资源。
    #[cfg(windows)]
    pub fn unregister_all(
        &mut self,
        controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
        core: Option<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>,
    ) -> Vec<Result<(), String>> {
        let mut results = Vec::new();
        while let Some(entry) = self.tokens.pop() {
            unsafe {
                match entry {
                    TokenEntry::Controller { kind, token } => {
                        let res = match kind {
                            ControllerTokenKind::AcceleratorKeyPressed => {
                                controller.remove_AcceleratorKeyPressed(token)
                            }
                            ControllerTokenKind::ZoomFactorChanged => {
                                controller.remove_ZoomFactorChanged(token)
                            }
                            ControllerTokenKind::MoveFocusRequested => {
                                controller.remove_MoveFocusRequested(token)
                            }
                        };
                        results.push(res.map_err(|e| {
                            format!("Failed to unregister Controller event {kind:?} (token: {token}): {e}")
                        }));
                    }
                    TokenEntry::Core { kind, token } => {
                        if let Some(core_webview) = core {
                            let res = match kind {
                                CoreTokenKind::NavigationStarting => {
                                    core_webview.remove_NavigationStarting(token)
                                }
                                CoreTokenKind::NavigationCompleted => {
                                    core_webview.remove_NavigationCompleted(token)
                                }
                                CoreTokenKind::SourceChanged => {
                                    core_webview.remove_SourceChanged(token)
                                }
                                CoreTokenKind::DocumentTitleChanged => {
                                    core_webview.remove_DocumentTitleChanged(token)
                                }
                                CoreTokenKind::HistoryChanged => {
                                    core_webview.remove_HistoryChanged(token)
                                }
                                CoreTokenKind::ProcessFailed => {
                                    core_webview.remove_ProcessFailed(token)
                                }
                                CoreTokenKind::NewWindowRequested => {
                                    core_webview.remove_NewWindowRequested(token)
                                }
                                CoreTokenKind::WebMessageReceived => {
                                    core_webview.remove_WebMessageReceived(token)
                                }
                                CoreTokenKind::PermissionRequested => {
                                    core_webview.remove_PermissionRequested(token)
                                }
                                CoreTokenKind::ContainsFullScreenElementChanged => {
                                    core_webview.remove_ContainsFullScreenElementChanged(token)
                                }
                                CoreTokenKind::WindowCloseRequested => {
                                    core_webview.remove_WindowCloseRequested(token)
                                }
                                CoreTokenKind::DownloadStarting => {
                                    match core_webview.cast::<
                                        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4,
                                    >() {
                                        Ok(core4) => core4.remove_DownloadStarting(token),
                                        Err(error) => Err(error),
                                    }
                                }
                            };
                            results.push(res.map_err(|e| {
                                format!("Failed to unregister Core event {kind:?} (token: {token}): {e}")
                            }));
                        } else {
                            results.push(Err(format!(
                                "Cannot unregister Core event {kind:?} (token: {token}): CoreWebView2 pointer is null"
                            )));
                        }
                    }
                    TokenEntry::Custom { name, token } => {
                        tracing::debug!(
                            "[NativeTokenRegistry] Custom token '{name}' (token: {token}) popped"
                        );
                        results.push(Ok(()));
                    }
                }
            }
        }
        results
    }

    /// 非 Windows 平台占位实现
    #[cfg(not(windows))]
    pub fn unregister_all(&mut self) -> Vec<Result<(), String>> {
        self.clear();
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_registration_and_lifo_order() {
        let mut registry = EventTokenRegistry::new();
        assert!(registry.is_empty());

        registry.register_accelerator(101);
        registry.register_navigation_starting(102);
        registry.register_process_failed(103);

        assert_eq!(registry.len(), 3);

        let drained = registry.drain_lifo();
        assert_eq!(drained.len(), 3);
        assert!(registry.is_empty());

        // 断言 LIFO 倒序：最后加入的 103 最先被弹出注销
        assert_eq!(
            drained[0],
            TokenEntry::Core {
                kind: CoreTokenKind::ProcessFailed,
                token: 103,
            }
        );
        assert_eq!(
            drained[1],
            TokenEntry::Core {
                kind: CoreTokenKind::NavigationStarting,
                token: 102,
            }
        );
        assert_eq!(
            drained[2],
            TokenEntry::Controller {
                kind: ControllerTokenKind::AcceleratorKeyPressed,
                token: 101,
            }
        );
    }

    #[test]
    fn test_custom_token() {
        let mut registry = EventTokenRegistry::new();
        registry.register_custom("ext_channel", 999);
        assert_eq!(registry.len(), 1);

        let drained = registry.drain_lifo();
        assert_eq!(
            drained[0],
            TokenEntry::Custom {
                name: "ext_channel".to_string(),
                token: 999,
            }
        );
    }

    #[test]
    fn inspector_web_message_token_uses_the_core_unregister_path() {
        let mut registry = EventTokenRegistry::new();
        registry.register_web_message_received(204);

        assert_eq!(
            registry.tokens(),
            &[TokenEntry::Core {
                kind: CoreTokenKind::WebMessageReceived,
                token: 204,
            }]
        );
    }
}
