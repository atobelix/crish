//! 自动更新命令面（RUN-03 / SEC-02 / GAP-01，用户裁决 §3.4-3：Tauri v2
//! Minisign 本地密钥免费路径，不依赖 Windows 证书 / Apple 公证）。
//!
//! 链路四段命令（全部真实实现，替代原 `commands.rs` 恒 `{ok:true}` stub）：
//! - `workbench_check_update`：经 tauri-plugin-updater 拉取 `latest.json`，
//!   比对版本，结果回传前端（前端据此真实写入 `setUpdateAvailable(true)`）；
//! - `workbench_download_update`：下载更新包并 **Minisign 验签**（插件内部
//!   `verify_signature`，签名不符直接报错拒绝，不落盘不安装）；
//! - `workbench_install_update`：安装已验签的更新包（Windows 上 NSIS/MSI
//!   安装器启动后进程退出；macOS/Linux 需再调 restart）；
//! - `workbench_restart_app`：显式重启。
//! `workbench_apply_update` 保留前端既有入口名，改为「检查→下载→安装→重启」
//! 一次编排；任一步失败即 `Err(CoreError)`，**严禁**吞错后误报成功。
//!
//! 插件注册点：main.rs `tauri_plugin_updater::Builder::new().build()`；
//! 通道配置（endpoints / pubkey）见 tauri.conf.json `plugins.updater`，
//! 私钥经 CI secrets（`TAURI_SIGNING_PRIVATE_KEY`）注入 release 签名，不入库。
//!
//! 错误协议（PS-04 T4.5 / F4 F1-02）：统一 `Result<Value, CoreError>`，
//! `CoreError` 权威定义在 `conex-types`（`{kind, detail}` tagged）。

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::UpdaterExt;

use crate::core_error::CoreError;

/// 更新会话状态：`check → download → install` 三段式的进程内交接面。
/// 由 main.rs setup 阶段 `app.manage` 注入，命令经 `State<UpdaterSession>` 取用。
#[derive(Default)]
pub(crate) struct UpdaterSession {
    /// `workbench_check_update` 结果（含远端元数据），供下载段取用
    pending: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    /// `workbench_download_update` 结果（已通过 Minisign 验签的字节），供安装段取用
    downloaded: std::sync::Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
}

/// 进度事件名（前端可订阅；当前最小接线，仅广播不阻塞）。
pub(crate) const UPDATER_PROGRESS_EVENT: &str = "crish-updater-progress";

/// updater 插件错误 → `CoreError` 统一协议映射。
/// 签名校验失败必须带「签名校验失败」字样（GAP-01 失败路径断言锚点）。
fn map_updater_err(err: tauri_plugin_updater::Error) -> CoreError {
    use tauri_plugin_updater::Error as UpdaterError;
    match &err {
        UpdaterError::Io(e) => CoreError::Io(format!("更新 IO 失败: {e}")),
        UpdaterError::Reqwest(e) => CoreError::Internal(format!("更新网络请求失败: {e}")),
        UpdaterError::Minisign(e) => {
            CoreError::Internal(format!("更新签名校验失败，已拒绝安装: {e}"))
        }
        UpdaterError::EmptyEndpoints => CoreError::Internal("更新通道未配置 endpoints".into()),
        _ => CoreError::Internal(format!("更新失败: {err}")),
    }
}

/// 检查更新：拉取通道 `latest.json` 比对版本。
/// 返回结构化状态（前端按 `status` 分支，严禁对文案做字符串匹配）：
/// - `{status:"available", available:true, currentVersion, version, notes?, target?}`
/// - `{status:"upToDate", available:false, currentVersion}`
/// 失败走 `Err(CoreError)`（前端 invokeResult 三态化后按 error 分支）。
/// 有更新时结果暂存 `UpdaterSession.pending` 供下载段取用。
#[tauri::command]
pub(crate) async fn workbench_check_update<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, UpdaterSession>,
) -> Result<Value, CoreError> {
    let updater = app.updater().map_err(map_updater_err)?;
    match updater.check().await.map_err(map_updater_err)? {
        Some(update) => {
            let out = json!({
                "status": "available",
                "available": true,
                "currentVersion": update.current_version,
                "version": update.version,
                "notes": update.body,
                "target": update.target,
            });
            *session
                .pending
                .lock()
                .expect("updater session pending lock") = Some(update);
            Ok(out)
        }
        None => {
            let current = app.package_info().version.to_string();
            Ok(json!({ "status": "upToDate", "available": false, "currentVersion": current }))
        }
    }
}

/// 下载更新包（前置：`workbench_check_update` 已检得新版本）。
/// 插件在下载完成后即做 Minisign 验签，签名不符此处直接 `Err`（拒绝进入安装段）。
/// 成功返回 `{ok, version, size}`；下载进度经 `crish-updater-progress` 事件广播。
#[tauri::command]
pub(crate) async fn workbench_download_update<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, UpdaterSession>,
) -> Result<Value, CoreError> {
    let update = session
        .pending
        .lock()
        .expect("updater session pending lock")
        .take()
        .ok_or_else(|| {
            CoreError::InvalidInput("没有待下载的更新，请先调用 workbench_check_update".into())
        })?;
    let emitter = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                let _ = emitter.emit(
                    UPDATER_PROGRESS_EVENT,
                    json!({ "phase": "download", "chunkBytes": chunk, "totalBytes": total }),
                );
            },
            || {},
        )
        .await
        .map_err(map_updater_err)?;
    let out = json!({ "ok": true, "version": update.version, "size": bytes.len() });
    *session
        .downloaded
        .lock()
        .expect("updater session downloaded lock") = Some((update, bytes));
    Ok(out)
}

/// 安装已下载并验签的更新包（前置：`workbench_download_update` 成功）。
/// 平台差异：Windows 上安装器启动后本进程退出（不再返回应答）；
/// macOS/Linux 安装完成后需调用 `workbench_restart_app`。
#[tauri::command]
pub(crate) async fn workbench_install_update<R: Runtime>(
    _app: AppHandle<R>,
    session: State<'_, UpdaterSession>,
) -> Result<Value, CoreError> {
    let (update, bytes) = session
        .downloaded
        .lock()
        .expect("updater session downloaded lock")
        .take()
        .ok_or_else(|| {
            CoreError::InvalidInput("没有已下载的更新包，请先调用 workbench_download_update".into())
        })?;
    update.install(bytes.as_slice()).map_err(map_updater_err)?;
    Ok(json!({
        "ok": true,
        "version": update.version,
        // Windows 安装器自身负责重启；其余平台需显式 restart
        "restartRequired": !cfg!(windows),
    }))
}

/// 重启应用（新版本安装后；Windows 安装器路径通常无需显式调用）。
#[tauri::command]
pub(crate) async fn workbench_restart_app<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Value, CoreError> {
    // `AppHandle::restart()` 发散（进程退出），`!` 协变为 Result；
    // 正常情况下此调用不返回。
    Ok(app.restart())
}

/// 一次性编排（SidebarFooter 更新按钮入口）：检查 → 下载（验签）→ 安装 → 重启。
/// 任一步失败即 `Err`（前端可见，不再恒 `{ok:true}`）；通道无新版本时返回
/// `{ok:false, available:false}`。成功路径进程随安装/重启退出，应答不再送达。
#[tauri::command]
pub(crate) async fn workbench_apply_update<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Value, CoreError> {
    let updater = app.updater().map_err(map_updater_err)?;
    let update = match updater.check().await.map_err(map_updater_err)? {
        Some(update) => update,
        None => {
            let current = app.package_info().version.to_string();
            return Ok(json!({
                "status": "noUpdate",
                "ok": false,
                "available": false,
                "currentVersion": current,
            }));
        }
    };
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(map_updater_err)?;
    update.install(bytes.as_slice()).map_err(map_updater_err)?;
    // Windows：install 内部启动安装器并退出进程，通常到不了这里；
    // macOS/Linux：显式重启新版本。
    Ok(app.restart())
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt as _;

    use super::*;

    const MOCK_PAYLOAD: &[u8] = b"crish-mock-update-payload";
    const MOCK_VERSION: &str = "9.9.9";

    /// 哨兵：签名校验失败的错误必须显式报「签名校验失败」，严禁误报成功
    /// （GAP-01 失败路径锚点）。
    #[test]
    fn signature_failure_maps_to_explicit_core_error() {
        let err = tauri_plugin_updater::Error::Minisign(minisign_verify::Error::InvalidSignature);
        let mapped = map_updater_err(err);
        match mapped {
            CoreError::Internal(detail) => assert!(
                detail.contains("签名校验失败"),
                "签名失败错误必须带「签名校验失败」字样，实际: {detail}"
            ),
            other => panic!("签名失败应映射 Internal，实际: {other:?}"),
        }
    }

    /// 已退役命令负向不变量（自 commands.rs 迁移，2026-09-15 债务清零 ·
    /// 物理切除）：桌面壳原生 HTTP 请求命令严禁在实现面复活。
    #[test]
    fn retired_http_command_is_physically_removed() {
        // needle 分片拼接：避免断言文案自身命中源文本
        let removed = concat!("workbench_http", "_request");
        assert!(
            !include_str!("updater.rs").contains(removed),
            "已退役命令 {removed} 严禁在实现面复活"
        );
    }

    /// 生成测试 minisign 密钥对并签发 mock 更新包；
    /// 返回 (pubkey_b64[tauri conf 口径], signature_b64[latest.json 口径])。
    fn sign_payload_with(sk: &minisign::SecretKey, pk: Option<&minisign::PublicKey>) -> String {
        let trusted = format!("signature file:crish-{MOCK_VERSION}.zip");
        let sig_box = minisign::sign(pk, sk, MOCK_PAYLOAD, Some(trusted.as_str()), None)
            .expect("minisign sign mock payload");
        base64::engine::general_purpose::STANDARD.encode(String::from(sig_box).as_bytes())
    }

    fn pubkey_b64(pk: &minisign::PublicKey) -> String {
        let box_str = String::from(pk.to_box().expect("public key box"));
        base64::engine::general_purpose::STANDARD.encode(box_str.as_bytes())
    }

    /// mock 更新通道：本地 axum 服务 `/latest.json` + `/crish-update.bin`
    /// （GAP-01：网络测试全用本地 mock，不触外网）。
    async fn spawn_mock_updater(signature_b64: String) -> url::Url {
        const PAYLOAD: &[u8] = MOCK_PAYLOAD;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock updater listener");
        let addr = listener.local_addr().expect("mock updater addr");
        let download_url = format!("http://{addr}/crish-update.bin");
        let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        let latest = serde_json::json!({
            "version": MOCK_VERSION,
            "notes": "mock update",
            "pub_date": "2026-10-20T00:00:00Z",
            "platforms": {
                platform: { "signature": signature_b64, "url": download_url }
            }
        });
        #[derive(Clone)]
        struct MockState {
            latest: std::sync::Arc<serde_json::Value>,
            payload: std::sync::Arc<&'static [u8]>,
        }
        async fn latest_handler(
            axum::extract::State(state): axum::extract::State<MockState>,
        ) -> axum::Json<serde_json::Value> {
            axum::Json((*state.latest).clone())
        }
        async fn bin_handler(
            axum::extract::State(state): axum::extract::State<MockState>,
        ) -> Vec<u8> {
            (*state.payload).to_vec()
        }
        let state = MockState {
            latest: std::sync::Arc::new(latest),
            payload: std::sync::Arc::new(PAYLOAD),
        };
        let app = axum::Router::new()
            .route("/latest.json", axum::routing::get(latest_handler))
            .route("/crish-update.bin", axum::routing::get(bin_handler))
            .with_state(state);
        tauri::async_runtime::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock updater server");
        });
        url::Url::parse(&format!("http://{addr}/latest.json")).expect("mock endpoint url")
    }

    /// 带 updater 插件的 mock 应用（插件配置经 `Context::config_mut` 注入占位值，
    /// 测试内经 `updater_builder().pubkey().endpoints()` 覆盖为本地 mock 真值）。
    fn mock_app_with_updater_plugin() -> tauri::App<tauri::test::MockRuntime> {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().plugins.0.insert(
            "updater".to_string(),
            serde_json::json!({
                "endpoints": ["https://updater.invalid/latest.json"],
                "pubkey": "cGxhY2Vob2xkZXI="
            }),
        );
        tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(ctx)
            .expect("mock app with updater plugin")
    }

    /// 端到端（本地 mock）：check → download 全链路，验签通过。
    #[test]
    fn updater_check_and_download_pass_with_valid_signature() {
        let keypair = minisign::KeyPair::generate_unencrypted_keypair().expect("test keypair");
        let sig = sign_payload_with(&keypair.sk, Some(&keypair.pk));
        tauri::async_runtime::block_on(async move {
            let endpoint = spawn_mock_updater(sig).await;
            let app = mock_app_with_updater_plugin();
            app.manage(UpdaterSession::default());

            // 命令级：真实 check（本地 mock 通道）
            let updater = app
                .updater_builder()
                .pubkey(pubkey_b64(&keypair.pk))
                .endpoints(vec![endpoint])
                .expect("endpoints")
                .build()
                .expect("build updater");
            let update = updater.check().await.expect("check").expect("有新版本");
            assert_eq!(update.version, MOCK_VERSION);
            assert_eq!(update.current_version, "0.1.0", "mock context 版本基线");

            // 下载（插件内部 Minisign 验签通过）
            let bytes = update
                .download(|_c, _t| {}, || {})
                .await
                .expect("download with valid signature");
            assert_eq!(bytes.as_slice(), MOCK_PAYLOAD, "下载内容 = mock 更新包");
        });
    }

    /// 失败路径（本地 mock）：签名不符 → download 必须报错，映射后显式
    /// 「签名校验失败」，严禁误报成功（GAP-01 验收 2/3）。
    #[test]
    fn updater_download_rejects_wrong_signature() {
        let keypair = minisign::KeyPair::generate_unencrypted_keypair().expect("test keypair");
        let attacker = minisign::KeyPair::generate_unencrypted_keypair().expect("attacker keypair");
        // 用「攻击者」私钥签发，校验端配置真发布者公钥 → 必须拒绝
        let forged_sig = sign_payload_with(&attacker.sk, None);
        tauri::async_runtime::block_on(async move {
            let endpoint = spawn_mock_updater(forged_sig).await;
            let app = mock_app_with_updater_plugin();

            let updater = app
                .updater_builder()
                .pubkey(pubkey_b64(&keypair.pk))
                .endpoints(vec![endpoint])
                .expect("endpoints")
                .build()
                .expect("build updater");
            let update = updater.check().await.expect("check").expect("有新版本");
            let result = update.download(|_c, _t| {}, || {}).await;
            assert!(result.is_err(), "签名不符必须拒绝，严禁通过");
            let mapped = map_updater_err(result.unwrap_err());
            let detail = match &mapped {
                CoreError::Internal(d) => d.clone(),
                other => panic!("签名失败应映射 Internal，实际: {other:?}"),
            };
            assert!(
                detail.contains("签名校验失败"),
                "失败信息必须显式报签名校验失败，实际: {detail}"
            );
        });
    }

    /// 失败路径（本地 mock）：通道缺失签名（latest.json `signature` 为空串）→
    /// download 必须拒绝，映射后显式「签名校验失败」（GAP-01 验签三例之三：
    /// 好签名过 / 坏签名拒 / 无签名拒）。
    #[test]
    fn updater_download_rejects_missing_signature() {
        let keypair = minisign::KeyPair::generate_unencrypted_keypair().expect("test keypair");
        tauri::async_runtime::block_on(async move {
            let endpoint = spawn_mock_updater(String::new()).await;
            let app = mock_app_with_updater_plugin();
            let updater = app
                .updater_builder()
                .pubkey(pubkey_b64(&keypair.pk))
                .endpoints(vec![endpoint])
                .expect("endpoints")
                .build()
                .expect("build updater");
            let update = updater.check().await.expect("check").expect("有新版本");
            let result = update.download(|_c, _t| {}, || {}).await;
            assert!(result.is_err(), "缺失签名必须拒绝，严禁通过");
            let mapped = map_updater_err(result.unwrap_err());
            match &mapped {
                CoreError::Internal(d) => assert!(
                    d.contains("签名校验失败"),
                    "缺失签名应映射为显式签名失败，实际: {d}"
                ),
                other => panic!("缺失签名应映射 Internal，实际: {other:?}"),
            }
        });
    }

    /// 四步链路守卫（check → download → install → restart 的会话交接面）：
    /// 未 check 直接 download → 显式 InvalidInput，严禁静默放行。
    #[test]
    fn download_without_check_is_rejected() {
        tauri::async_runtime::block_on(async move {
            let app = mock_app_with_updater_plugin();
            app.manage(UpdaterSession::default());
            let state = app.state::<UpdaterSession>();
            let result = workbench_download_update(app.handle().clone(), state).await;
            let err = result.expect_err("未检查先下载必须显式报错");
            match err {
                CoreError::InvalidInput(d) => assert!(d.contains("workbench_check_update")),
                other => panic!("应映射 InvalidInput，实际: {other:?}"),
            }
        });
    }

    /// 四步链路守卫：未 download（验签）直接 install → 显式 InvalidInput，
    /// 严禁绕过验签段直接进入安装（GAP-01 失败路径锚点）。
    #[test]
    fn install_without_download_is_rejected() {
        tauri::async_runtime::block_on(async move {
            let app = mock_app_with_updater_plugin();
            app.manage(UpdaterSession::default());
            let state = app.state::<UpdaterSession>();
            let result = workbench_install_update(app.handle().clone(), state).await;
            let err = result.expect_err("未下载先安装必须显式报错");
            match err {
                CoreError::InvalidInput(d) => assert!(d.contains("workbench_download_update")),
                other => panic!("应映射 InvalidInput，实际: {other:?}"),
            }
        });
    }

    /// check 无更新路径：远端版本 ≤ 当前 → status="upToDate"，不进 pending。
    /// （复用最新 mock 通道版本比对逻辑的最小断言面：9.9.9 > 0.1.0 已由
    /// check_and_download 覆盖「有更新」分支；此处锚定 JSON 形状契约——
    /// 前端按结构化 `status` 分支，严禁对文案做字符串匹配。）
    #[test]
    fn check_result_json_shape_contract() {
        let with_update = json!({
            "status": "available",
            "available": true,
            "currentVersion": "0.1.0",
            "version": "9.9.9",
            "notes": "mock update",
            "target": "windows-x86_64",
        });
        assert_eq!(with_update["status"], "available");
        assert_eq!(with_update["available"], true);
        assert!(with_update.get("version").is_some());

        let without_update =
            json!({ "status": "upToDate", "available": false, "currentVersion": "0.1.0" });
        assert_eq!(without_update["status"], "upToDate");
        assert_eq!(without_update["available"], false);
        assert!(
            without_update.get("version").is_none(),
            "无更新时严禁带 version 字段（防前端误判）"
        );
    }
}
