//! WebView2 导航历史与下载观察者（native_manager 拆分）：
//! HistoryChanged / DownloadStarting 监听与事件推送。

use super::*;

#[cfg(windows)]
fn query_history_capabilities(core: &ICoreWebView2) -> (Option<bool>, Option<bool>) {
    let can_go_back = {
        let mut value = std::mem::MaybeUninit::uninit();
        unsafe { core.CanGoBack(value.as_mut_ptr()) }
            .ok()
            .map(|()| unsafe { value.assume_init().as_bool() })
    };
    let can_go_forward = {
        let mut value = std::mem::MaybeUninit::uninit();
        unsafe { core.CanGoForward(value.as_mut_ptr()) }
            .ok()
            .map(|()| unsafe { value.assume_init().as_bool() })
    };
    (can_go_back, can_go_forward)
}

#[cfg(windows)]
fn publish_history_state(
    app: &AppHandle,
    tab_id: &str,
    state: &Arc<Mutex<BrowserNavigationStatePayload>>,
    core: &ICoreWebView2,
) {
    let (can_go_back, can_go_forward) = query_history_capabilities(core);
    let current_url = {
        let mut source = std::mem::MaybeUninit::uninit();
        unsafe { core.Source(source.as_mut_ptr()) }
            .ok()
            .map(|()| webview2_com::take_pwstr(unsafe { source.assume_init() }))
    };

    let payload = {
        let Ok(mut current) = state.lock() else {
            return;
        };
        current.can_go_back = can_go_back;
        current.can_go_forward = can_go_forward;
        if let Some(url) = current_url.filter(|url| !url.is_empty()) {
            current.url = url;
        }
        if current.tab_id.is_empty() {
            current.tab_id = tab_id.to_string();
        }
        current.clone()
    };
    let _ = app.emit("browser://navigation-state", payload);
}

#[cfg(windows)]
pub(super) async fn register_history_changed_listener(
    webview: &Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
    state: Arc<Mutex<BrowserNavigationStatePayload>>,
) -> Result<i64, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<i64, String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let callback_app = app.clone();
                    let callback_tab_id = tab_id.clone();
                    let callback_state = Arc::clone(&state);
                    let handler =
                        HistoryChangedEventHandler::create(Box::new(move |sender, _args| {
                            if let Some(core) = sender.as_ref() {
                                publish_history_state(
                                    &callback_app,
                                    &callback_tab_id,
                                    &callback_state,
                                    core,
                                );
                            }
                            Ok(())
                        }));
                    let mut token = 0_i64;
                    core.add_HistoryChanged(&handler, &mut token)
                        .map_err(|error| format!("Could not register HistoryChanged: {error}"))?;
                    publish_history_state(&app, &tab_id, &state, &core);
                    Ok(token)
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule HistoryChanged registration: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("HistoryChanged registration callback was dropped: {error}"))?
}

/// 读取下载操作的当前快照并映射为事件载荷。
///
/// `state` 取值对齐前端契约：`progress` / `completed` / `interrupted`
/// （进行中态统一映射为 progress）。
#[cfg(windows)]
pub(super) fn download_state_label(state: COREWEBVIEW2_DOWNLOAD_STATE) -> &'static str {
    if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
        "completed"
    } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
        "interrupted"
    } else {
        "progress"
    }
}

#[cfg(windows)]
fn download_progress_payload(
    tab_id: &str,
    operation: &ICoreWebView2DownloadOperation,
) -> Option<DownloadProgressPayload> {
    unsafe {
        let mut uri = std::mem::MaybeUninit::uninit();
        operation.Uri(uri.as_mut_ptr()).ok()?;
        let url = webview2_com::take_pwstr(uri.assume_init());

        let mut raw_path = std::mem::MaybeUninit::uninit();
        let filename = if operation.ResultFilePath(raw_path.as_mut_ptr()).is_ok() {
            let path = webview2_com::take_pwstr(raw_path.assume_init());
            let name = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string);
            name.unwrap_or(path)
        } else {
            String::new()
        };

        let mut total_bytes = -1_i64;
        let _ = operation.TotalBytesToReceive(&mut total_bytes);
        let mut received_bytes = 0_i64;
        let _ = operation.BytesReceived(&mut received_bytes);
        let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
        operation.State(&mut state).ok()?;

        Some(DownloadProgressPayload {
            tab_id: tab_id.to_string(),
            url,
            filename,
            total_bytes: (total_bytes >= 0).then_some(total_bytes as u64),
            received_bytes: received_bytes.max(0) as u64,
            state: download_state_label(state).to_string(),
        })
    }
}

/// 为单次下载挂字节进度与状态变更监听。
///
/// 两个操作级 Token 在回调内共享，终态（completed / interrupted）时自注销；
/// 若 Tab 先关闭，WebView2 释放下载操作对象时回调随之释放。操作对象刻意
/// 不进 [EventTokenRegistry]——注册表只持有 Webview2 级 Token，下载操作
/// 的生命周期由 WebView2 管理。
#[cfg(windows)]
fn attach_download_progress_handlers(
    app: &AppHandle,
    tab_id: &str,
    operation: &ICoreWebView2DownloadOperation,
) {
    let tokens = Arc::new(Mutex::new((0_i64, 0_i64)));

    let bytes_app = app.clone();
    let bytes_tab_id = tab_id.to_string();
    let bytes_handler = BytesReceivedChangedEventHandler::create(Box::new(move |sender, _args| {
        if let Some(operation) = sender.as_ref() {
            if let Some(payload) = download_progress_payload(&bytes_tab_id, operation) {
                let _ = bytes_app.emit(EVENT_BROWSER_DOWNLOAD_PROGRESS, payload);
            }
        }
        Ok(())
    }));
    let mut bytes_token = 0_i64;
    if unsafe { operation.add_BytesReceivedChanged(&bytes_handler, &mut bytes_token) }.is_err() {
        return;
    }

    let state_app = app.clone();
    let state_tab_id = tab_id.to_string();
    let state_tokens = Arc::clone(&tokens);
    let state_handler = StateChangedEventHandler::create(Box::new(move |sender, _args| {
        let Some(operation) = sender.as_ref() else {
            return Ok(());
        };
        let Some(payload) = download_progress_payload(&state_tab_id, operation) else {
            return Ok(());
        };
        let terminal = payload.state != "progress";
        let _ = state_app.emit(EVENT_BROWSER_DOWNLOAD_PROGRESS, payload);
        if terminal {
            let (bytes_token, state_token) = *state_tokens
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            unsafe {
                let _ = operation.remove_BytesReceivedChanged(bytes_token);
                let _ = operation.remove_StateChanged(state_token);
            }
        }
        Ok(())
    }));
    let mut state_token = 0_i64;
    if unsafe { operation.add_StateChanged(&state_handler, &mut state_token) }.is_err() {
        unsafe {
            let _ = operation.remove_BytesReceivedChanged(bytes_token);
        }
        return;
    }

    *tokens.lock().unwrap_or_else(|error| error.into_inner()) = (bytes_token, state_token);
}

/// 注册下载发起监听：每次下载建档并向 `browser://download-progress` 广播。
#[cfg(windows)]
pub(super) async fn register_download_listener(
    webview: &Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
) -> Result<i64, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<i64, String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let callback_app = app.clone();
                    let callback_tab_id = tab_id.clone();
                    let handler =
                        DownloadStartingEventHandler::create(Box::new(move |_sender, args| {
                            let Some(args) = args.as_ref() else {
                                return Ok(());
                            };
                            let operation = args.DownloadOperation();
                            let Ok(operation) = operation else {
                                return Ok(());
                            };
                            if let Some(payload) =
                                download_progress_payload(&callback_tab_id, &operation)
                            {
                                let _ = callback_app.emit(EVENT_BROWSER_DOWNLOAD_PROGRESS, payload);
                            }
                            attach_download_progress_handlers(
                                &callback_app,
                                &callback_tab_id,
                                &operation,
                            );
                            Ok(())
                        }));
                    // 下载事件自 ICoreWebView2_4 起提供，基础接口无此 vtable。
                    let core_download: ICoreWebView2_4 = core.cast().map_err(|error| {
                        format!("CoreWebView2 does not expose download support: {error}")
                    })?;
                    let mut token = 0_i64;
                    core_download
                        .add_DownloadStarting(&handler, &mut token)
                        .map_err(|error| format!("Could not register DownloadStarting: {error}"))?;
                    Ok(token)
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule DownloadStarting registration: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("DownloadStarting registration callback was dropped: {error}"))?
}

#[cfg(windows)]
pub(super) fn request_history_state(
    webview: Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
    state: Arc<Mutex<BrowserNavigationStatePayload>>,
) {
    let error_tab_id = tab_id.clone();
    if let Err(error) = webview.with_webview(move |platform_webview| unsafe {
        match platform_webview.controller().CoreWebView2() {
            Ok(core) => publish_history_state(&app, &tab_id, &state, &core),
            Err(error) => tracing::warn!(
                "[NativeWebview] Could not query WebView2 history for tab {tab_id}: {error}"
            ),
        }
    }) {
        tracing::warn!(
            "[NativeWebview] Could not schedule WebView2 history query for tab {error_tab_id}: {error}"
        );
    }
}
