//! e2e_browser.rs —— MVP 核心链路 e2e（真实浏览器集成验证）
//!
//! 覆盖（对齐 10/11 文档 e2e 口径）：E1 启动+连接 → E2 导航+快照 →
//! E3 动作（click/type_text）→ E4 版本推进 → E5 关闭；
//! G-3 帧流/输入链路扩展：E6 帧流端到端（pacing/延迟）→ E7 输入注入后帧变化
//! → E8 IME insertText 中文端到端 → E9 快照-动作-帧联动。
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
use conex_browser::browser::args::EngineMode;
use conex_browser::browser::discover::{resolve_backend, BackendOverride, ResolveOptions};
use conex_browser::browser::{BrowserManager, LaunchConfig, ProcessError, StopReason};
use conex_browser::frames::{ScreencastConfig, ScreencastSession, ScreencastStatus};
use conex_browser::input::{InputCmd, InputPipeline};
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

/// 帧流测试页（E6）：CSS 动画（合成器驱动，不受 background timer throttling
/// 影响——headless 下 setInterval 会被节流到 ~1s/次导致帧流近停）+ JS 定时器
/// 双保险，保证页面持续变化、帧流持续产出（供 pacing/延迟测量）。
const TEST_HTML_FRAMES: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>帧流测试页</title>
<style>
  #tick { width: 240px; height: 24px; background: #369;
          animation: pulse 0.4s ease-in-out infinite alternate; }
  @keyframes pulse { from { opacity: 1; } to { opacity: 0.3; } }
</style>
</head>
<body>
<h1>帧流测试页</h1>
<div id="tick">tick0</div>
<div id="dyn">初始文本</div>
<script>
  setInterval(function () {
    document.getElementById('tick').textContent = 'tick' + Date.now();
  }, 100);
</script>
</body>
</html>"#;

/// IME 注入测试页（E8）：输入框 + contenteditable + 事件计数（C2 实测面：
/// insertText 应仅触发 beforeinput+input 各 1，无 composition/keydown）。
const TEST_HTML_IME: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>IME 注入页</title></head>
<body>
<h1>IME 注入页</h1>
<input id="ime">
<div id="ce" contenteditable="true"></div>
<script>
  window.__evt = { beforeinput: 0, input: 0, compositionstart: 0, compositionend: 0, keydown: 0 };
  (function () {
    var el = document.getElementById('ime');
    ['beforeinput', 'input', 'compositionstart', 'compositionend', 'keydown'].forEach(function (t) {
      el.addEventListener(t, function () { window.__evt[t] += 1; });
    });
  })();
</script>
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
        Self::launch_with_mode(EngineMode::HeadlessNew).await
    }

    /// 指定引擎模式启动（帧流用例用 HeadedOffscreen：headless 下页面视口
    /// 不可见 → timer/动画被节流，screencast 帧近停；headed 离屏模式页面
    /// 可见性与真实面板一致）。
    async fn launch_with_mode(mode: EngineMode) -> E2eEnv {
        let root = tempfile::tempdir().expect("创建临时数据根失败");
        let mgr = BrowserManager::new(root.path().to_path_buf());
        let started = Instant::now();
        let report = mgr
            .start(LaunchConfig {
                mode,
                ..Default::default()
            })
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

// ---------------------------------------------------------------------------
// G-3 帧流/输入链路扩展（真实 Chrome；维度 12 §2 帧流数据面 + §3/§4 输入管线）
// ---------------------------------------------------------------------------

/// 排序后中位数（毫秒；空切片返回 None）。
fn median_ms(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_unstable();
    Some(v[v.len() / 2])
}

/// P95（毫秒；95% 分位下标，最小 1 样本）。
fn p95_ms(values: &[u64]) -> u64 {
    let mut v = values.to_vec();
    v.sort_unstable();
    let idx = (v.len().saturating_mul(95) / 100).min(v.len() - 1);
    v[idx]
}

// ---------------------------------------------------------------------------
// E6 帧流端到端：启动 → 连接 → ScreencastSession::start → 订阅帧 → 内容页
// 持续产帧（JS 定时器）→ JPEG 非空/尺寸合理/序号递增 → ack pacing（Base 档
// 8fps 宽松断言防 flaky：间隔中位下界 + 每帧恰一 ack）→ 帧延迟测量（注入
// DOM 变化 → 含变化帧到达，≥5 样本记录 min/avg/p95 非硬断言）→ stop → 通道关闭。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_frame_stream_end_to_end() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch_with_mode(EngineMode::HeadedOffscreen).await;
    let url = data_url(TEST_HTML_FRAMES);
    navigate_and_wait(&env, &url).await;

    // 帧流会话（Base 档启动，验证 8fps ack pacing）
    let frames = ScreencastSession::new(env.session.clone(), ScreencastConfig::default());
    let rx = frames.subscribe_frames();
    let s_started = Instant::now();
    frames.start().await.expect("帧流启动失败");
    let start_ms = s_started.elapsed().as_millis() as u64;
    assert_eq!(frames.status(), ScreencastStatus::Active, "启动后应 Active");

    // —— 帧有效性：≥3 帧，JPEG 非空、尺寸合理、序号递增 ——
    let mut seqs: Vec<u64> = Vec::new();
    let mut total_bytes = 0usize;
    for _ in 0..3 {
        let f = rx
            .recv_timeout(Duration::from_secs(5))
            .await
            .unwrap_or_else(|| panic!("帧流超时未产出（已收 {} 帧）", seqs.len()));
        seqs.push(f.seq);
        total_bytes += f.data.len();
        assert!(!f.data.is_empty(), "帧数据不得为空");
        assert!(f.data.len() > 200, "JPEG 帧应有体量（{} 字节）", f.data.len());
        assert!(
            f.data.starts_with(&[0xFF, 0xD8]),
            "JPEG SOI 头（FF D8），前 2 字节 {:02X}{:02X}",
            f.data[0],
            f.data[1]
        );
        assert!(
            f.width >= 100 && f.height >= 100,
            "帧尺寸合理：{}x{}",
            f.width,
            f.height
        );
    }
    assert!(
        seqs.windows(2).all(|w| w[1] > w[0]),
        "帧序号单调递增：{seqs:?}"
    );

    // —— ack pacing（Base 档 8fps）：2s 窗口帧间隔中位下界（宽松防 flaky）——
    let mut intervals: Vec<u64> = Vec::new();
    let mut last: Option<Instant> = None;
    let window = Instant::now();
    while window.elapsed() < Duration::from_secs(2) && intervals.len() < 12 {
        match rx.recv_timeout(Duration::from_millis(300)).await {
            Some(_) => {
                let now = Instant::now();
                if let Some(l) = last {
                    intervals.push(now.duration_since(l).as_millis() as u64);
                }
                last = Some(now);
            }
            None => break,
        }
    }
    let stats = frames.stats();
    assert!(
        intervals.len() >= 2,
        "pacing 窗口内帧间间隔样本应 ≥2（实际 {}，页面可能未持续产帧）",
        intervals.len()
    );
    let med = median_ms(&intervals).expect("间隔样本非空");
    assert!(
        med >= 90,
        "Base 档 ack 持住应使帧间隔中位 ≥90ms（8fps 换算持住 125ms，实际 {med}ms）"
    );
    // 每帧恰一 ack：持续产帧页面下快照瞬时允许 1 帧在途（已输出未 ack，
    // 持住 125ms 后即发）；ack_failures 必须为 0（修复前 ack 全失败停流）
    assert!(
        stats.acks_sent + 1 >= stats.frames_sent,
        "每帧恰一 ack（pacing 生效；允许 1 帧在途）：acks={} sent={}",
        stats.acks_sent,
        stats.frames_sent
    );
    assert!(stats.frames_sent >= 5, "帧流应持续产出（实际 {}）", stats.frames_sent);
    assert_eq!(stats.ack_failures, 0, "ack 发送不得失败");

    // —— 帧延迟测量：注入 DOM 变化 → 含变化帧到达（≥5 样本，记录 min/avg/p95）——
    while rx.recv_timeout(Duration::from_millis(50)).await.is_some() {} // 排空积压
    let mut lats: Vec<u64> = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        eval_dom(&env, "document.getElementById('dyn').textContent='注入'+Date.now()").await;
        let f = rx
            .recv_timeout(Duration::from_secs(2))
            .await
            .unwrap_or_else(|| panic!("注入后未收到含变化帧"));
        lats.push(started.elapsed().as_millis() as u64);
        assert!(f.data.len() > 200, "变化帧数据有效");
    }
    let lat_min = lats.iter().min().copied().unwrap_or(0);
    let lat_avg = lats.iter().sum::<u64>() / lats.len() as u64;
    let lat_p95 = p95_ms(&lats);

    // —— stop：状态回 Idle、帧停止输出、通道关闭 ——
    frames.stop().await;
    assert_eq!(frames.status(), ScreencastStatus::Idle, "stop 后回 Idle");
    let after_stop = frames.stats().frames_sent;
    eval_dom(&env, "document.getElementById('dyn').textContent='停流后注入'").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(frames.stats().frames_sent, after_stop, "stop 后不再输出帧");
    assert!(
        rx.recv_timeout(Duration::from_millis(50)).await.is_none(),
        "stop 后输出槽应排空"
    );
    frames.shutdown().await;
    assert!(rx.recv().await.is_none(), "shutdown 后帧通道关闭（recv=None）");

    println!(
        "[E6] start={start_ms}ms 帧数={} 总字节={} 间隔中位={med}ms \
         延迟 min/avg/p95={lat_min}/{lat_avg}/{lat_p95}ms acks={}",
        stats.frames_sent, total_bytes, stats.acks_sent
    );
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// E7 输入注入后帧变化：start 帧流 → InputPipeline::dispatch(Text 中文) →
// 版本推进 +1（R-1/U-1）+ 旧版本 Stale → 注入后收到新帧（帧变化链路）。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_input_injection_frame_change() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch_with_mode(EngineMode::HeadedOffscreen).await;
    let url = data_url(TEST_HTML);
    navigate_and_wait(&env, &url).await;

    let pipeline = InputPipeline::new(env.session.clone());
    let frames = ScreencastSession::new(env.session.clone(), ScreencastConfig::default());
    let rx = frames.subscribe_frames();
    frames.start().await.expect("帧流启动失败");
    // 聚焦输入框（insertText 落点确定性）+ 排空积压帧
    eval_dom(&env, "document.getElementById('name').focus()").await;
    while rx.recv_timeout(Duration::from_millis(50)).await.is_some() {}

    let v0 = env.session.snapshot_version(&env.tab_id);
    let t0 = Instant::now();
    pipeline
        .dispatch(InputCmd::Text {
            text: "你好世界".to_string(),
        })
        .await
        .expect("中文注入失败");
    let v1 = env.session.snapshot_version(&env.tab_id);
    assert_eq!(v1, v0 + 1, "R-1/U-1：注入成功即时 +1");
    assert!(
        env.session.validate_snapshot(&env.tab_id, v0).is_err(),
        "旧版本应 Stale"
    );
    let f = rx
        .recv_timeout(Duration::from_secs(2))
        .await
        .expect("注入后应收到新帧（帧变化链路）");
    let latency_ms = t0.elapsed().as_millis() as u64;
    let value = eval_dom(&env, "document.getElementById('name').value").await;
    assert_eq!(value, "你好世界", "注入内容应落位");
    println!(
        "[E7] v{v0}→v{v1} 帧 seq={} 注入→帧到达 {latency_ms}ms injected={}",
        f.seq,
        pipeline.stats().injected
    );

    frames.shutdown().await;
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// E8 IME insertText 中文端到端：input 框 + contenteditable 双形态——
// InputPipeline::dispatch(Text 中文) → Runtime.evaluate 回读 value/textContent
// 整串落位 + input 事件计数（C2 实测面：仅 beforeinput+input 各 1，无合成/
// 键盘事件污染）。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_ime_insert_text_chinese() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch_with_mode(EngineMode::HeadedOffscreen).await;
    let url = data_url(TEST_HTML_IME);
    navigate_and_wait(&env, &url).await;
    let pipeline = InputPipeline::new(env.session.clone());

    // —— 输入框（input）：整串中文注入 + 事件干净度 ——
    eval_dom(&env, "document.getElementById('ime').focus()").await;
    let t0 = Instant::now();
    pipeline
        .dispatch(InputCmd::Text {
            text: "你好世界".to_string(),
        })
        .await
        .expect("insertText 注入失败");
    let inject_ms = t0.elapsed().as_millis() as u64;
    let value = eval_dom(&env, "document.getElementById('ime').value").await;
    assert_eq!(value, "你好世界", "输入框 value 应整串落位（无逐字拆分）");
    let evt_json = eval_dom(&env, "JSON.stringify(window.__evt)").await;
    let evt_json = evt_json.as_str().expect("事件计数应为 JSON 串");
    let evt: Value = serde_json::from_str(evt_json).expect("事件计数 JSON 解析失败");
    assert_eq!(evt["input"], 1, "input 事件应恰 1 条（C2）");
    assert_eq!(evt["beforeinput"], 1, "beforeinput 应恰 1 条（C2）");
    assert_eq!(evt["compositionstart"], 0, "insertText 不得触发合成");
    assert_eq!(evt["compositionend"], 0, "insertText 不得触发合成结束");
    assert_eq!(evt["keydown"], 0, "insertText 不得触发键盘事件（无 229/Process 污染）");

    // —— contenteditable：同样整串注入（C6 实测面） ——
    eval_dom(
        &env,
        "document.getElementById('ce').textContent=''; document.getElementById('ce').focus()",
    )
    .await;
    pipeline
        .dispatch(InputCmd::Text {
            text: "你好世界".to_string(),
        })
        .await
        .expect("contenteditable 注入失败");
    let tc = eval_dom(&env, "document.getElementById('ce').textContent").await;
    assert_eq!(tc, "你好世界", "contenteditable 文本应整串落位");

    println!(
        "[E8] 注入={inject_ms}ms input事件={} value=你好世界 contenteditable=你好世界",
        evt["input"]
    );
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// E9 快照-动作-帧联动：capture → 按索引 click（版本推进 +1）→ 帧到达（动作
// 触发页面变化）→ 重快照断言页面状态变化（R-1 契约全链路）。
// ---------------------------------------------------------------------------

#[ignore]
#[tokio::test(flavor = "multi_thread")]
async fn e2e_snapshot_action_frame_linkage() {
    // 环境守卫（P1-2）：无可用浏览器 → 打印 [SKIP] 说明并以 OK 结束
    if !browser_available().await {
        return;
    }
    let env = E2eEnv::launch_with_mode(EngineMode::HeadedOffscreen).await;
    let url = data_url(TEST_HTML);
    navigate_and_wait(&env, &url).await;

    let frames = ScreencastSession::new(env.session.clone(), ScreencastConfig::default());
    let rx = frames.subscribe_frames();
    frames.start().await.expect("帧流启动失败");
    while rx.recv_timeout(Duration::from_millis(50)).await.is_some() {}

    let doc = capture_snapshot(&env).await;
    let v0 = doc.meta.snapshot_version;
    let btn = element_ref_by_tag(&doc, "button");

    let t0 = Instant::now();
    env.exec
        .click(&env.tab_id, v0, btn, MouseButton::Left, 1)
        .await
        .expect("click 失败");
    let v1 = env.session.snapshot_version(&env.tab_id);
    assert!(v1 > v0, "动作后版本应推进：v{v0} → v{v1}");
    let f = rx
        .recv_timeout(Duration::from_secs(2))
        .await
        .expect("click 后应收到变化帧");
    let frame_ms = t0.elapsed().as_millis() as u64;

    // 重快照：版本不回退 + 页面状态反映点击（快照-动作-帧联动闭环）
    let doc2 = capture_snapshot(&env).await;
    assert!(doc2.meta.snapshot_version >= v1, "重拍版本不得回退");
    let out = eval_dom(&env, "document.getElementById('out').textContent").await;
    assert_eq!(out, "点击成功：", "重快照后页面状态应反映点击");

    println!(
        "[E9] v{v0}→v{v1} 帧 seq={} click→帧到达 {frame_ms}ms 重拍 v{}",
        f.seq, doc2.meta.snapshot_version
    );
    frames.shutdown().await;
    env.shutdown().await;
}
