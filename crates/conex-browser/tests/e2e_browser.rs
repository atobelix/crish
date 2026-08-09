//! e2e_browser.rs —— MVP 核心链路 e2e（真实浏览器集成验证）
//!
//! 覆盖（对齐 10/11 文档 e2e 口径）：E1 启动+连接 → E2 导航+快照 →
//! E3 动作（click/type_text）→ E4 版本推进 → E5 关闭。
//!
//! 运行（`#[ignore]` + 串行，10 文档 §10.2 / 11 文档 §9.2 约定）：
//!
//! ```text
//! cargo test -p conex-browser --test e2e_browser -- --ignored --test-threads=1
//! ```
//!
//! CI 执行约定（32 评审 P1-2）：本文件依赖本机真实浏览器，**不进常规门禁**，
//! 仅在具备浏览器的环境按上述命令显式执行：
//! - Windows 本地：串行跑通全部用例（本机应有 Chrome/Edge）；
//! - ubuntu 慢层（`--ignored` 全量命令）：无 DISPLAY / 未安装浏览器 →
//!   各用例经 [browser_available] 探测（discover 回退链）失败后打印
//!   `[SKIP]` 说明并以 OK（skip 语义）结束，不 panic 不红；
//!   真实跑通需专用 job 提供 xvfb-run + chromium 安装（32 评审 §四）。
//!
//! 浏览器发现：经 `BrowserManager.start` 内部 `resolve_backend` 的 Auto 回退链
//! （CfT 缓存 → 系统 Chrome → 系统 Edge），无需测试侧自建候选逻辑。
//! 测试页：data: URL（本地内联 HTML，无 fixture server、无临时文件）。

use conex_browser::cdp::bus::{BrowserEvent, LifecycleKind};
use conex_browser::cdp::sender::{
    ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, CommandPolicyHooks,
    IdKey,
};
use conex_browser::action::{ActionExecutor, ElementRef, MouseButton};
use conex_browser::action::gate::{DomainGate, GateDenial};
use conex_browser::action::ops::{
    BrowserPageOps, BrowserSnapshotStore, session_for_active,
};
use conex_browser::browser::discover::{resolve_backend, BackendOverride, ResolveOptions};
use conex_browser::browser::{BrowserManager, LaunchConfig, ProcessError, StopReason};
use conex_browser::snapshot::{BudgetConfig, SnapshotDocument, SnapshotError, SnapshotManager};
use conex_browser::{BrowserSession, BrowserState, CdpError};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 全放行策略钩子（e2e 场景：无审批/审计/急停；引擎侧注入由 conex-browser-tools 提供）。
struct AllowHooks;

#[async_trait::async_trait]
impl CommandPolicyHooks for AllowHooks {
    async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
        None
    }
    async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
        Ok(())
    }
    fn audit(&self, _event: BrowserAuditEvent) {}
    fn emergency_stop(&self) -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }
    fn abort_token(&self) -> CancellationToken {
        CancellationToken::new()
    }
}

/// 全放行域名门禁（e2e 场景仅访问 data:/本地页；维度 17 §4 的唯一实现属引擎侧）。
struct AllowGate;

impl DomainGate for AllowGate {
    fn check(&self, _url: &str) -> Result<(), GateDenial> {
        Ok(())
    }
}

/// 联调测试页（中文元素：输入框占位 + 中文按钮 + 结果区）。
const TEST_HTML: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>联调测试页</title></head>
<body>
<h1>MVP 联调页</h1>
<input id="name" placeholder="请输入姓名">
<button id="go" onclick="document.getElementById('out').textContent='点击成功：'+document.getElementById('name').value">中文按钮</button>
<div id="out">初始文本</div>
</body>
</html>"#;

/// HTML → data: URL（UTF-8 百分号编码；仅保留 RFC 3986 unreserved 与标点）。
fn data_url(html: &str) -> String {
    let mut out = String::from("data:text/html;charset=utf-8,");
    for b in html.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'(' | b')'
            | b'!' | b'*' | b'\'' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// e2e 环境：真实浏览器实例 + 会话 + 快照/动作管线。
/// 正常路径显式 `shutdown()`；异常路径由 `BrowserManager` 的 Drop 兜底
/// （同步杀树，不依赖 async 运行时），数据根随 TempDir 清理。
struct E2eEnv {
    _root: tempfile::TempDir,
    mgr: BrowserManager,
    session: Arc<BrowserSession>,
    session_id: String,
    tab_id: String,
    snap: Arc<SnapshotManager>,
    exec: ActionExecutor,
    backend: String,
    launch_ms: u64,
    connect_ms: u64,
}

impl E2eEnv {
    /// 启动（Auto 回退链）→ 建连（身份校验）→ 等活动标签 → 组装管线。
    async fn launch() -> E2eEnv {
        let root = tempfile::tempdir().expect("创建临时数据根失败");
        let mgr = BrowserManager::new(root.path().to_path_buf());
        let started = Instant::now();
        let report = mgr
            .start(LaunchConfig::default())
            .await
            .expect("浏览器启动失败（无 CfT 缓存时回退系统 Chrome/Edge）");
        let launch_ms = started.elapsed().as_millis() as u64;
        assert!(
            matches!(report.state, BrowserState::Running),
            "启动态应为 Running：{:?}",
            report.state
        );
        let backend = report.backend.summary();

        // 端点私有通道 → 会话建连（三重校验：ws_path bearer + 产品前缀 + 最低版本线）
        let endpoint = mgr.endpoint().expect("端点未就绪（维度 11 私有通道）");
        let expected = report.backend.expected_browser();
        let c_started = Instant::now();
        let session = Arc::new(
            BrowserManager::connect_session(endpoint, expected, Arc::new(AllowHooks))
                .await
                .expect("会话建连失败"),
        );
        let connect_ms = c_started.elapsed().as_millis() as u64;

        // 活动标签就绪（SessionAttached 登记；订阅时序由 connect 内部保证）
        let deadline = Instant::now() + Duration::from_secs(10);
        let current = loop {
            if let Ok(cur) = session.current_session() {
                break cur;
            }
            assert!(
                Instant::now() < deadline,
                "未收到 SessionAttached，活动标签未就绪"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };

        // 快照/动作管线（真实 CDP 路径：CdpCollector + BrowserPageOps）
        let snap = Arc::new(session.snapshot_manager(BudgetConfig::active()));
        let ops = Arc::new(BrowserPageOps::new(session.clone()));
        let store = Arc::new(BrowserSnapshotStore::new(
            session.clone(),
            session_for_active(session.clone()),
            BudgetConfig::active(),
        ));
        let exec = ActionExecutor::new(ops, store, CancellationToken::new())
            .with_gate(Arc::new(AllowGate));

        E2eEnv {
            _root: root,
            mgr,
            session,
            session_id: current.session,
            tab_id: current.target_id,
            snap,
            exec,
            backend,
            launch_ms,
            connect_ms,
        }
    }

    /// 成功路径收尾（强制停止：直接杀树；优雅路径由 E5 专项验证）。
    async fn shutdown(&self) {
        self.mgr
            .stop(StopReason::Force)
            .await
            .expect("强制停止失败");
    }
}

/// 环境守卫（32 评审 P1-2）：真实浏览器可用性探测——经 discover 回退链
/// （CfT 缓存 → 系统 Chrome → 系统 Edge，不联网下载）判定本机是否可用；
/// 不可用（NoBrowser 或探测异常）→ 打印明确跳过说明并返回 `false`，
/// 调用方以 skip 语义提前结束（**不 panic**）。ubuntu CI 无 DISPLAY /
/// 无浏览器安装时全部用例走该跳过路径（见文件头 CI 执行约定）。
async fn browser_available() -> bool {
    let root = tempfile::tempdir().expect("创建临时数据根失败");
    match resolve_backend(
        root.path(),
        BackendOverride::Auto,
        &ResolveOptions {
            allow_cft_download: false,
            ..ResolveOptions::default()
        },
    )
    .await
    {
        Ok(_) => true,
        Err(ProcessError::NoBrowser(_)) => {
            println!(
                "[SKIP] 未探测到可用浏览器（discover 回退链：CfT 缓存/系统 Chrome/系统 \
                 Edge 全失败）；本用例跳过（CI 无浏览器安装或无 DISPLAY 时属预期）。\
                 安装浏览器后重跑：cargo test -p conex-browser --test e2e_browser \
                 -- --ignored --test-threads=1"
            );
            false
        }
        Err(error) => {
            println!("[SKIP] 浏览器可用性探测异常：{error}；本用例跳过（不 panic）");
            false
        }
    }
}

/// 等待订阅事件满足条件（先订阅后动作的时序铁律；事件通道关闭即失败）。
async fn wait_event(
    rx: &mut tokio::sync::broadcast::Receiver<BrowserEvent>,
    timeout: Duration,
    mut cond: impl FnMut(&BrowserEvent) -> bool,
) -> BrowserEvent {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) if cond(&ev) => return ev,
            Ok(Ok(_)) => {}
            Ok(Err(_)) => panic!("事件通道关闭（连接已断）"),
            Err(_) => panic!("等待事件超时（{timeout:?}）"),
        }
    }
}

/// 导航并等待主 frame 完成（Navigated + load 生命周期，同会话过滤）。
async fn navigate_and_wait(env: &E2eEnv, url: &str) {
    let mut rx = env.session.subscribe();
    let result: Value = env
        .session
        .send_page(&env.session_id, "Page.navigate", json!({ "url": url }))
        .await
        .expect("Page.navigate 命令失败");
    assert!(
        result.get("errorText").is_none(),
        "导航被拦截：{result}"
    );
    let mut saw_navigated = false;
    wait_event(&mut rx, Duration::from_secs(15), |ev| {
        match ev {
            BrowserEvent::Navigated {
                session,
                main: true,
                url: u,
                ..
            } if *session == env.session_id => {
                assert_eq!(u, url, "导航落点不符");
                saw_navigated = true;
                false
            }
            BrowserEvent::Lifecycle {
                session,
                kind: LifecycleKind::Load,
                ..
            } if *session == env.session_id => saw_navigated,
            _ => false,
        }
    })
    .await;
    // 加载完成后再沉降一帧，避免采集窗口内首屏 DomChanged 竞态
    tokio::time::sleep(Duration::from_millis(150)).await;
}

/// 快照采集（M-5 版本竞态 Stale 时重拍，最多 3 次）。
async fn capture_snapshot(env: &E2eEnv) -> Arc<SnapshotDocument> {
    for _ in 0..3 {
        match env.snap.capture(&env.tab_id, &env.session_id, true).await {
            Ok(doc) => return doc,
            Err(SnapshotError::Stale(_)) => {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            Err(e) => panic!("快照采集失败：{e}"),
        }
    }
    panic!("快照连续 3 次版本竞态（Stale），页面持续变更");
}

/// 从快照文本按标签找首个元素索引（`[N]<tag` 行），解析为执行引用。
fn element_ref_by_tag(doc: &SnapshotDocument, tag: &str) -> ElementRef {
    let mark = format!("<{tag}");
    for line in doc.serialized_text.lines() {
        if line.contains(&mark) {
            let start = line.find('[').unwrap_or_else(|| panic!("行无索引前缀：{line}"));
            let end = line.find(']').expect("行无索引闭合括号");
            let index: usize = line[start + 1..end]
                .parse()
                .unwrap_or_else(|_| panic!("索引解析失败：{line}"));
            let node = doc
                .selector_map
                .get(&(index as u32))
                .unwrap_or_else(|| panic!("索引 [{index}] 无 selector_map 映射"));
            return ElementRef {
                index,
                backend_node_id: node.backend_node_id,
            };
        }
    }
    panic!("快照中未找到 <{tag}> 元素：\n{}", doc.serialized_text);
}

/// Runtime.evaluate 读取 DOM 值（断言输入面；exception 即失败）。
async fn eval_dom(env: &E2eEnv, expression: &str) -> Value {
    let result: Value = env
        .session
        .send_page(
            &env.session_id,
            "Runtime.evaluate",
            json!({ "expression": expression, "returnByValue": true }),
        )
        .await
        .expect("Runtime.evaluate 命令失败");
    assert!(
        result.get("exceptionDetails").is_none(),
        "页面求值异常：{result}"
    );
    result["result"]["value"].clone()
}

// ---------------------------------------------------------------------------
// E1 启动+连接：BrowserManager.start → connect_session → Browser.getVersion →
// current_session 就绪（维度 10 §5.2 三重校验全链路）。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_launch_and_connect() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch().await;
    // 状态机：Running；端点经私有通道就绪
    assert!(
        matches!(env.mgr.status().state, BrowserState::Running),
        "状态应为 Running：{:?}",
        env.mgr.status().state
    );
    assert!(env.mgr.endpoint().is_some(), "端点私有通道应就绪");
    // Browser.getVersion（连接期已校验过身份，此处显式回读）
    let ver: Value = env
        .session
        .send_browser::<Value>("Browser.getVersion", json!({}))
        .await
        .expect("Browser.getVersion 失败");
    let product = ver["product"].as_str().expect("product 字段缺失");
    assert!(!product.is_empty(), "product 为空");
    assert!(
        product.starts_with("Chrome/") || product.starts_with("Microsoft Edge/"),
        "product 身份不符：{product}"
    );
    // current_session 就绪（SessionAttached 已登记活动标签）
    let current = env.session.current_session().expect("current_session 未就绪");
    assert_eq!(current.session, env.session_id);
    assert_eq!(current.target_id, env.tab_id);
    println!(
        "[E1] backend={} product={} 启动={}ms 连接={}ms",
        env.backend, product, env.launch_ms, env.connect_ms
    );
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// E2 导航+快照：navigate 本地测试页 → SnapshotManager.capture →
// 快照含预期可交互元素（中文按钮/输入框），索引可解析。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_navigate_and_snapshot() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch().await;
    let url = data_url(TEST_HTML);
    navigate_and_wait(&env, &url).await;

    let started = Instant::now();
    let doc = capture_snapshot(&env).await;
    let snap_ms = started.elapsed().as_millis() as u64;

    // 快照含预期可交互元素（中文按钮/输入框）
    assert!(
        doc.serialized_text.contains("中文按钮"),
        "快照应含中文按钮文本：\n{}",
        doc.serialized_text
    );
    assert!(
        doc.serialized_text.contains("<input"),
        "快照应含输入框：\n{}",
        doc.serialized_text
    );
    assert_eq!(doc.meta.url, url, "快照 URL 应等于导航落点");
    assert!(doc.meta.element_count > 0, "快照元素数应为正");
    // 索引 → backendNodeId 可解析（E3 动作的输入面）
    let input = element_ref_by_tag(&doc, "input");
    let btn = element_ref_by_tag(&doc, "button");
    assert!(input.backend_node_id > 0 && btn.backend_node_id > 0, "backendNodeId 应有效");
    println!(
        "[E2] v{} 元素 {} 索引 {} 耗时 {}ms url={}",
        doc.meta.snapshot_version,
        doc.meta.element_count,
        doc.meta.selector_count,
        snap_ms,
        doc.meta.url
    );
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// E3 动作：click（按快照索引）→ type_text（中文+英文）→ Runtime.evaluate
// 读 DOM 值断言页面状态。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_click_and_type() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch().await;
    let url = data_url(TEST_HTML);
    navigate_and_wait(&env, &url).await;
    let doc = capture_snapshot(&env).await;
    let version = doc.meta.snapshot_version;
    let input = element_ref_by_tag(&doc, "input");
    let btn = element_ref_by_tag(&doc, "button");

    // type_text：中文 + 英文（非 ASCII 走 Input.insertText，ASCII 走键事件）
    let t_started = Instant::now();
    env.exec
        .type_text(&env.tab_id, version, input, "你好 world", None)
        .await
        .expect("type_text 失败");
    let type_ms = t_started.elapsed().as_millis() as u64;
    let value = eval_dom(&env, "document.getElementById('name').value").await;
    assert_eq!(value, "你好 world", "type 后输入框回读不一致");

    // click：按快照索引点击中文按钮（版本过期时执行器重快照自愈）
    let c_started = Instant::now();
    env.exec
        .click(&env.tab_id, version, btn, MouseButton::Left, 1)
        .await
        .expect("click 失败");
    let click_ms = c_started.elapsed().as_millis() as u64;
    let out = eval_dom(&env, "document.getElementById('out').textContent").await;
    assert_eq!(out, "点击成功：你好 world", "按钮点击未生效");
    println!("[E3] type={type_ms}ms click={click_ms}ms（版本 v{version} 动作）");
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// E4 版本推进：动作后 snapshot_version 增加、validate_snapshot 旧版本 Stale
// （R-1：AI 动作即时 +1；旧快照失效）。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_version_advance_on_action() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch().await;
    let url = data_url(TEST_HTML);
    navigate_and_wait(&env, &url).await;
    let doc = capture_snapshot(&env).await;
    let v0 = doc.meta.snapshot_version;
    assert!(
        env.session.validate_snapshot(&env.tab_id, v0).is_ok(),
        "刚采集的版本应有效"
    );
    let btn = element_ref_by_tag(&doc, "button");

    // 动作成功 → note_action_done 即时 +1（R-1）
    env.exec
        .click(&env.tab_id, v0, btn, MouseButton::Left, 1)
        .await
        .expect("click 失败");
    let v1 = env.session.snapshot_version(&env.tab_id);
    assert!(v1 > v0, "动作后版本应推进：v{v0} → v{v1}");
    assert!(
        env.session.validate_snapshot(&env.tab_id, v0).is_err(),
        "旧版本应 Stale"
    );

    // 重拍后版本恢复有效（新快照可被动作继续消费）
    let doc2 = capture_snapshot(&env).await;
    assert!(doc2.meta.snapshot_version >= v1, "重拍版本不得回退");
    assert!(
        env.session
            .validate_snapshot(&env.tab_id, doc2.meta.snapshot_version)
            .is_ok(),
        "新快照版本应有效"
    );
    println!("[E4] v{v0} → v{v1}（动作推进 + 旧版本 Stale）");
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// E5 关闭：BrowserManager.stop 干净退出（置位停止意图 → Browser.close →
// 进程自然退出 → profile 清理，不走杀树兜底）。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_clean_stop() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch().await;
    let url = data_url(TEST_HTML);
    navigate_and_wait(&env, &url).await;

    // 优雅路径：先置位停止意图（stop 任务），再发 Browser.close 令进程自然退出。
    // 若进程先于意图退出会被误判崩溃重启（§6.2 意图标志），故先 spawn stop。
    let mgr = env.mgr.clone();
    let stop_task = tokio::spawn(async move {
        mgr.stop(StopReason::Graceful).await.expect("优雅停止失败")
    });
    let _ = env
        .session
        .send_browser::<Value>("Browser.close", json!({}))
        .await;
    let report = stop_task.await.expect("停止任务崩溃");

    assert!(
        matches!(report.state, BrowserState::Stopped),
        "停止终态应为 Stopped：{:?}",
        report.state
    );
    assert!(report.profile_removed, "ephemeral profile 应清理");
    assert!(
        !report.force_killed,
        "Browser.close 后进程应自然退出（无需杀树）"
    );
    assert_eq!(
        env.mgr.status().state,
        BrowserState::Stopped,
        "管理器状态收敛 Stopped"
    );
    println!(
        "[E5] 停止耗时 {}ms force_killed={} profile_removed={}",
        report.elapsed_ms, report.force_killed, report.profile_removed
    );
}
