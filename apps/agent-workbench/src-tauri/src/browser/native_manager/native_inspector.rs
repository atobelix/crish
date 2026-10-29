//! WebView2 Inspector 的 COM 装配（native_manager 拆分）：
//! 消息监听、导航完成控制、按文档注入 runtime。

use super::*;

pub(super) fn generate_inspector_challenge() -> Result<String, String> {
    let mut entropy = [0_u8; 32];
    getrandom::getrandom(&mut entropy)
        .map_err(|error| format!("Could not generate Inspector challenge: {error}"))?;
    Ok(hex::encode(entropy))
}

#[cfg(windows)]
unsafe fn take_bounded_inspector_message(message: PWSTR) -> Result<String, &'static str> {
    let pointer = message.0;
    if pointer.is_null() {
        return Err("WebView2 returned a null message buffer");
    }

    let mut units = 0_usize;
    let mut utf8_bytes = 0_usize;
    loop {
        let unit = unsafe { *pointer.add(units) };
        if unit == 0 {
            break;
        }

        let unit_bytes = if (0xD800..=0xDBFF).contains(&unit) {
            let next = unsafe { *pointer.add(units + 1) };
            if (0xDC00..=0xDFFF).contains(&next) {
                units += 1;
                4
            } else {
                3
            }
        } else if (0xDC00..=0xDFFF).contains(&unit) || unit > 0x07FF {
            3
        } else if unit > 0x007F {
            2
        } else {
            1
        };
        utf8_bytes += unit_bytes;
        if utf8_bytes > MAX_INSPECTOR_MESSAGE_BYTES {
            unsafe { CoTaskMemFree(Some(pointer.cast())) };
            return Err("message exceeds size limit");
        }
        units += 1;
    }

    let text = unsafe { std::slice::from_raw_parts(pointer, units) };
    let decoded = String::from_utf16_lossy(text);
    unsafe { CoTaskMemFree(Some(pointer.cast())) };
    Ok(decoded)
}

#[cfg(windows)]
unsafe fn release_inspector_message(message: PWSTR) {
    if !message.0.is_null() {
        unsafe { CoTaskMemFree(Some(message.0.cast())) };
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg(windows)]
pub(super) async fn register_inspector_listener(
    webview: &Webview<tauri::Wry>,
    app: AppHandle,
    tab_id: String,
    inspector_enabled: Arc<AtomicBool>,
    inspector_available: Arc<AtomicBool>,
    inspector_generation: Arc<AtomicU64>,
    navigation_id: Arc<AtomicU64>,
    navigation_pending: Arc<AtomicBool>,
    ready_pending: Arc<AtomicBool>,
    inspector_challenge: String,
) -> Result<(i64, i64, i64), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(i64, i64, i64), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let callback_app = app.clone();
                    let callback_tab_id = tab_id.clone();
                    let callback_enabled = Arc::clone(&inspector_enabled);
                    let callback_available = Arc::clone(&inspector_available);
                    let callback_generation = Arc::clone(&inspector_generation);
                    let callback_navigation_pending = Arc::clone(&navigation_pending);
                    let callback_ready_pending = Arc::clone(&ready_pending);
                    let callback_challenge = inspector_challenge.clone();
                    let navigation_available = Arc::clone(&inspector_available);
                    let navigation_generation = Arc::clone(&inspector_generation);
                    let navigation_pending_state = Arc::clone(&navigation_pending);
                    let navigation_ready_pending = Arc::clone(&ready_pending);
                    let navigation_id_state = Arc::clone(&navigation_id);
                    let navigation_handler = NavigationStartingEventHandler::create(Box::new(
                        move |_, args| {
                            navigation_ready_pending.store(false, Ordering::Release);
                            let mut id = u64::MAX;
                            if let Some(args) = args.as_ref() {
                                let mut value = 0_u64;
                                if args.NavigationId(&mut value).is_ok() && value != 0 {
                                    id = value;
                                }
                            }
                            navigation_id_state.store(id, Ordering::Release);
                            navigation_pending_state.store(true, Ordering::Release);
                            navigation_generation.fetch_add(1, Ordering::AcqRel);
                            navigation_available.store(false, Ordering::Release);
                            Ok(())
                        },
                    ));
                    let mut navigation_token = 0_i64;
                    core.add_NavigationStarting(&navigation_handler, &mut navigation_token)
                        .map_err(|error| {
                            format!("Could not register Inspector NavigationStarting: {error}")
                        })?;
                    let completed_generation = Arc::clone(&inspector_generation);
                    let completed_enabled = Arc::clone(&inspector_enabled);
                    let completed_navigation_id = Arc::clone(&navigation_id);
                    let completed_navigation_pending = Arc::clone(&navigation_pending);
                    let completed_ready_pending = Arc::clone(&ready_pending);
                    let completed_tab_id = tab_id.clone();
                    let completed_handler = NavigationCompletedEventHandler::create(Box::new(
                        move |sender, args| {
                            let (Some(core), Some(args)) = (sender.as_ref(), args.as_ref()) else {
                                return Ok(());
                            };
                            let mut completed_id = 0_u64;
                            if args.NavigationId(&mut completed_id).is_err()
                                || completed_id == 0
                            {
                                return Ok(());
                            }
                            let started_id = completed_navigation_id.load(Ordering::Acquire);
                            if started_id == u64::MAX
                                || (started_id != 0 && started_id != completed_id)
                            {
                                return Ok(());
                            }
                            completed_navigation_id.store(completed_id, Ordering::Release);
                            completed_navigation_pending.store(false, Ordering::Release);
                            let generation = completed_generation.load(Ordering::Acquire);
                            let enabled = completed_enabled.load(Ordering::Acquire);
                            let current_navigation_id = Arc::clone(&completed_navigation_id);
                            let current_navigation_pending =
                                Arc::clone(&completed_navigation_pending);
                            let current_generation = Arc::clone(&completed_generation);
                            if let Err(error) = post_inspector_control_for_document(
                                &completed_ready_pending,
                                || {
                                    !current_navigation_pending.load(Ordering::Acquire)
                                        && current_navigation_id.load(Ordering::Acquire)
                                            == completed_id
                                        && current_generation.load(Ordering::Acquire) == generation
                                },
                                || post_inspector_control(core, generation, enabled),
                            ) {
                                tracing::warn!(
                                    "[NativeWebview] Could not activate Inspector after navigation for tab {}: {}",
                                    completed_tab_id,
                                    error
                                );
                            }
                            Ok(())
                        },
                    ));
                    let mut navigation_completed_token = 0_i64;
                    if let Err(error) = core.add_NavigationCompleted(
                        &completed_handler,
                        &mut navigation_completed_token,
                    ) {
                        let _ = core.remove_NavigationStarting(navigation_token);
                        return Err(format!(
                            "Could not register Inspector NavigationCompleted: {error}"
                        ));
                    }
                    let handler = WebMessageReceivedEventHandler::create(Box::new(
                        move |sender, args| {
                            let (Some(_core), Some(args)) = (sender.as_ref(), args.as_ref()) else {
                                return Ok(());
                            };
                            let admission = inspector_message_admission(
                                callback_available.load(Ordering::Acquire),
                                callback_enabled.load(Ordering::Acquire),
                                &callback_ready_pending,
                            );
                            if admission == InspectorMessageAdmission::Rejected {
                                return Ok(());
                            }
                            let mut message = PWSTR::null();
                            if args.TryGetWebMessageAsString(&mut message).is_err() {
                                release_inspector_message(message);
                                return Ok(());
                            }
                            let raw = match take_bounded_inspector_message(message) {
                                Ok(raw) => raw,
                                Err(reason) => {
                                    tracing::debug!(
                                        "[NativeWebview] Dropped Inspector message for tab {}: {}",
                                        callback_tab_id,
                                        reason
                                    );
                                    return Ok(());
                                }
                            };
                            let expected_generation =
                                callback_generation.load(Ordering::Acquire).to_string();
                            let message = match parse_inspector_message(
                                &raw,
                                &callback_challenge,
                                &expected_generation,
                            ) {
                                Ok(message) => message,
                                Err(reason) => {
                                    tracing::debug!(
                                        "[NativeWebview] Dropped invalid Inspector message for tab {}: {}",
                                        callback_tab_id,
                                        reason
                                    );
                                    return Ok(());
                                }
                            };

                            if !inspector_message_admission_allows(
                                admission,
                                matches!(&message, InspectorMessage::Ready),
                            ) {
                                return Ok(());
                            }

                            let ready_is_current = inspector_ready_may_mark_available(
                                &message,
                                callback_generation.load(Ordering::Acquire).to_string()
                                    == expected_generation,
                                callback_navigation_pending.load(Ordering::Acquire),
                            );
                            if matches!(&message, InspectorMessage::Ready) && !ready_is_current {
                                return Ok(());
                            }
                            if ready_is_current {
                                callback_available.store(true, Ordering::Release);
                                if callback_navigation_pending.load(Ordering::Acquire)
                                    || callback_generation.load(Ordering::Acquire).to_string()
                                        != expected_generation
                                {
                                    callback_available.store(false, Ordering::Release);
                                    return Ok(());
                                }
                            }
                            if message.requires_enabled_inspector()
                                && !callback_enabled.load(Ordering::Acquire)
                            {
                                return Ok(());
                            }
                            if matches!(&message, InspectorMessage::ToggleOff) {
                                callback_enabled.store(false, Ordering::Release);
                            }

                            let _ = callback_app.emit(
                                INSPECTOR_EVENT,
                                message.envelope(callback_tab_id.clone()),
                            );
                            Ok(())
                        },
                    ));
                    let mut token = 0_i64;
                    if let Err(error) = core.add_WebMessageReceived(&handler, &mut token) {
                        let _ = core.remove_NavigationCompleted(navigation_completed_token);
                        let _ = core.remove_NavigationStarting(navigation_token);
                        return Err(format!("Could not register WebMessageReceived: {error}"));
                    }
                    Ok((token, navigation_token, navigation_completed_token))
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule Inspector registration: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Inspector registration callback was dropped: {error}"))?
}

#[cfg(windows)]
fn post_inspector_control(
    core: &ICoreWebView2,
    generation: u64,
    enabled: bool,
) -> Result<(), String> {
    let message = HSTRING::from(inspector_control_message(generation, enabled));
    unsafe { core.PostWebMessageAsString(&message) }
        .map_err(|error| format!("Could not send Inspector control: {error}"))
}

#[cfg(windows)]
pub(super) fn schedule_inspector_control_after_page_load(
    webview: &Webview<tauri::Wry>,
    generation: Arc<AtomicU64>,
    navigation_pending: Arc<AtomicBool>,
    inspector_enabled: Arc<AtomicBool>,
    ready_pending: Arc<AtomicBool>,
) {
    let scheduled = webview.with_webview(move |platform_webview| {
        let ready_pending_for_post = Arc::clone(&ready_pending);
        let result = unsafe {
            (|| -> Result<(), String> {
                let core = platform_webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                if navigation_pending.load(Ordering::Acquire) {
                    return Ok(());
                }
                let current_generation = Arc::clone(&generation);
                let generation = generation.load(Ordering::Acquire);
                let enabled = inspector_enabled.load(Ordering::Acquire);
                let current_navigation_pending = Arc::clone(&navigation_pending);
                post_inspector_control_for_document(
                    &ready_pending_for_post,
                    || {
                        !current_navigation_pending.load(Ordering::Acquire)
                            && current_generation.load(Ordering::Acquire) == generation
                    },
                    || post_inspector_control(&core, generation, enabled),
                )
            })()
        };
        if let Err(error) = result {
            tracing::warn!(
                "[NativeWebview] Could not send Inspector control after page load: {error}"
            );
        }
    });
    if let Err(error) = scheduled {
        tracing::warn!(
            "[NativeWebview] Could not schedule Inspector control after page load: {error}"
        );
    }
}

#[cfg(windows)]
pub(super) fn schedule_inspector_control(
    webview: &Webview<tauri::Wry>,
    generation: u64,
    enabled: bool,
    inspector_enabled: Arc<AtomicBool>,
    previous: bool,
) -> Result<(), String> {
    let message = HSTRING::from(inspector_control_message(generation, enabled));
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    core.PostWebMessageAsString(&message)
                        .map_err(|error| format!("Could not send Inspector control: {error}"))
                })()
            };
            if let Err(error) = result {
                let _ = inspector_enabled.compare_exchange(
                    enabled,
                    previous,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                tracing::warn!("[NativeWebview] Could not send Inspector control: {error}");
            }
        })
        .map_err(|error| format!("Could not schedule Inspector control: {error}"))
}

#[cfg(windows)]
pub(super) async fn register_inspector_runtime_for_future_documents(
    webview: &Webview<tauri::Wry>,
    challenge: &str,
) -> Result<(), String> {
    let runtime = inspector_runtime_script(challenge)
        .map_err(|error| format!("Could not configure Inspector runtime: {error}"))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let script = runtime.clone();
                    let registration_core = core.clone();
                    AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
                        Box::new(move |handler| {
                            let script = HSTRING::from(script);
                            registration_core
                                .AddScriptToExecuteOnDocumentCreated(&script, &handler)
                                .map_err(Into::into)
                        }),
                        Box::new(|error, _| error),
                    )
                    .map_err(|error| {
                        format!("Could not register Inspector document script: {error}")
                    })?;

                    Ok(())
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule Inspector runtime install: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Inspector runtime callback was dropped: {error}"))?
}

#[cfg(windows)]
pub(super) async fn current_document_is_complete(
    webview: &Webview<tauri::Wry>,
) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<bool, String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    let current_document_core = core.clone();
                    let (status_sender, status_receiver) = std::sync::mpsc::sync_channel(1);
                    ExecuteScriptCompletedHandler::wait_for_async_operation(
                        Box::new(move |handler| {
                            let script = HSTRING::from("document.readyState === 'complete'");
                            current_document_core
                                .ExecuteScript(&script, &handler)
                                .map_err(Into::into)
                        }),
                        Box::new(move |error, result| {
                            let result = error
                                .map(|()| result)
                                .map_err(|error| error.to_string())
                                .and_then(|result| {
                                    serde_json::from_str::<bool>(&result)
                                        .map_err(|error| error.to_string())
                                });
                            let _ = status_sender.send(result);
                            Ok(())
                        }),
                    )
                    .map_err(|error| {
                        format!("Could not query current document readiness: {error}")
                    })?;
                    status_receiver
                        .recv()
                        .map_err(|error| {
                            format!("Document readiness callback was dropped: {error}")
                        })?
                        .map_err(|error| format!("Could not read document readiness: {error}"))
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule document readiness query: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Document readiness callback was dropped: {error}"))?
}

#[cfg(windows)]
pub(super) async fn post_inspector_control_to_webview(
    webview: &Webview<tauri::Wry>,
    generation: Arc<AtomicU64>,
    navigation_pending: Arc<AtomicBool>,
    inspector_enabled: Arc<AtomicBool>,
    ready_pending: Arc<AtomicBool>,
) -> Result<(), String> {
    if navigation_pending.load(Ordering::Acquire) {
        return Ok(());
    }
    let current_generation = Arc::clone(&generation);
    let generation = generation.load(Ordering::Acquire);
    let enabled = inspector_enabled.load(Ordering::Acquire);
    let message = HSTRING::from(inspector_control_message(generation, enabled));
    let navigation_pending_for_post = Arc::clone(&navigation_pending);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Could not obtain CoreWebView2: {error}"))?;
                    if navigation_pending_for_post.load(Ordering::Acquire)
                        || current_generation.load(Ordering::Acquire) != generation
                    {
                        return Ok(());
                    }
                    post_inspector_control_for_document(
                        &ready_pending,
                        || {
                            !navigation_pending_for_post.load(Ordering::Acquire)
                                && current_generation.load(Ordering::Acquire) == generation
                        },
                        || {
                            core.PostWebMessageAsString(&message).map_err(|error| {
                                format!("Could not send Inspector control: {error}")
                            })
                        },
                    )
                })()
            };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not schedule Inspector control: {error}"))?;

    receiver
        .await
        .map_err(|error| format!("Inspector control callback was dropped: {error}"))?
}
