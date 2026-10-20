//! wait_for 等待原语（维度 14 §6，wait.rs）
//!
//! - 条件面（R-5）：仅两类入参——**快照索引**（内部解析为 backendNodeId）与
//!   **纯文本/URL 字符串匹配**；禁止 CSS selector 与 JS 表达式入参（对齐 17 §1.2
//!   browser_wait_for schema）；
//! - 注入面（R-5）：文本匹配实现为**固定代码模板 + 参数 JSON 序列化注入**
//!   （`JSON.stringify` 包裹，永不经字符串拼接进代码文本），谓词代码不含任何模型输入；
//! - 轮询间隔（T-7）：Text/Url 定值 100ms；Element 快照重拍轮询定值
//!   `max(200ms, 维度13快照耗时预算)`（快照耗时预算取 13 §6.1 p95 ≤2s 目标，
//!   SNAPSHOT_POLL_BUDGET_MS 常量实现，S0 实证后微调）；
//! - 超时（§6.2）：Element/Text 默认 10s，其余 30s；超时错误归类 `Timeout`
//!   （工具面可作结果喂回模型，非致命，对齐 agent-tools fatalOnError=false）；
//! - 等待期间必须可被 abort 中断（用户接管即退出，不空等，§6.2）。

use crate::action::{ActionError, ActionErrorKind, ActionExecutor, ActionSuccess, TabId};
use std::time::{Duration, Instant};

/// Text/Url 轮询间隔（§6.2 表：100ms）。
pub const POLL_TEXT_MS: u32 = 100;
/// NetworkIdle 轮询间隔（事件驱动主路径缺失时的轮询兜底）。
pub const POLL_NETWORK_MS: u32 = 50;
/// 快照重拍轮询间隔的绝对下界（T-7：200ms）。
pub const POLL_ELEMENT_FLOOR_MS: u32 = 200;
/// 维度 13 快照耗时预算（13 §6.1 p95 ≤2s 目标，常量实现，S0 实证后微调）。
pub const SNAPSHOT_POLL_BUDGET_MS: u32 = 2_000;
/// NetworkIdle 静默窗口默认值（对齐 browser-use networkidle 语义）。
pub const NETWORK_QUIET_DEFAULT_MS: u32 = 500;

/// 等待条件（§6.1，R-5 条件面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitCondition {
    /// 元素可见可交互：快照索引（内部解析为 backendNodeId，R-5）
    Element { index: usize },
    /// 页面纯文本子串匹配（document.body.innerText 包含；参数经 JSON 序列化注入固定模板）
    Text(String),
    /// 网络空闲：在途请求数归零并持续 quiet 窗口
    NetworkIdle { quiet_ms: u32 },
    /// URL 纯字符串匹配（子串包含；禁止正则/JS 表达式，R-5）
    Url { contains: String },
}

/// 等待选项（§6.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaitOptions {
    /// 等待作用标签（Element 条件快照重拍维度）
    pub tab_id: TabId,
    /// 超时（0 = 按条件默认：Element/Text 10s，其余 30s）
    pub timeout_ms: u32,
    /// 轮询间隔（0 = 按条件默认：Text/Url 100ms，Element max(200ms, 快照预算)）
    pub poll_ms: u32,
}

impl WaitOptions {
    /// 按条件取默认（§6.2 超时默认 + T-7 轮询定值）。
    pub fn for_condition(cond: &WaitCondition, tab_id: TabId) -> Self {
        let timeout_ms = match cond {
            WaitCondition::Element { .. } | WaitCondition::Text(_) => 10_000,
            _ => 30_000,
        };
        WaitOptions {
            tab_id,
            timeout_ms,
            poll_ms: 0,
        }
    }

    pub fn with_timeout_ms(mut self, timeout_ms: u32) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }

    pub fn with_poll_ms(mut self, poll_ms: u32) -> Self {
        self.poll_ms = poll_ms;
        self
    }
}

/// 轮询间隔（T-7 定值公式：Element = max(200ms, 快照耗时预算)；Text/Url = 100ms）。
pub fn poll_interval_ms(cond: &WaitCondition, opts: &WaitOptions) -> u32 {
    if opts.poll_ms > 0 {
        return opts.poll_ms;
    }
    match cond {
        WaitCondition::Element { .. } => POLL_ELEMENT_FLOOR_MS.max(SNAPSHOT_POLL_BUDGET_MS),
        WaitCondition::NetworkIdle { .. } => POLL_NETWORK_MS,
        WaitCondition::Text(_) | WaitCondition::Url { .. } => POLL_TEXT_MS,
    }
}

/// 文本轮询固定模板（R-5：唯一占位符 `%PARAM%`，仅由 JSON 序列化结果填充；
/// 模板不含反引号——`${}` 在双引号字符串字面量内惰性，无执行面）。
const TEXT_POLL_TEMPLATE: &str = r#"(function() { const needle = %PARAM%; const el = document.body; if (!el || !el.innerText) return false; return el.innerText.includes(needle); })()"#;

/// 文本匹配表达式构造（R-5 注入面红线）：参数经 `JSON.stringify` 序列化注入固定
/// 模板，永不经字符串拼接进代码文本。
pub fn text_poll_expression(needle: &str) -> String {
    let encoded = serde_json::to_string(needle).expect("字符串 JSON 序列化不会失败");
    TEXT_POLL_TEMPLATE.replace("%PARAM%", &encoded)
}

/// wait_for 主循环（§6.2：轮询兜底；等待期间可被 abort 中断）。
pub async fn wait_for(
    exec: &ActionExecutor,
    cond: WaitCondition,
    opts: WaitOptions,
) -> Result<ActionSuccess, ActionError> {
    let timeout_ms = opts.timeout_ms.max(1);
    let poll_ms = poll_interval_ms(&cond, &opts).max(1);
    let timeout = Duration::from_millis(u64::from(timeout_ms));
    let poll = Duration::from_millis(u64::from(poll_ms));
    let started = Instant::now();
    // NetworkIdle 静默窗口按「连续零在途轮询 × 轮询间隔 ≥ quiet 窗口」判定（确定性）
    let quiet_polls = quiet_polls_for(&cond, poll_ms);
    let mut zero_count: u32 = 0;
    loop {
        if exec.abort.is_cancelled() {
            return Err(ActionError::new(
                ActionErrorKind::Aborted,
                "用户接管/令牌吊销（wait_for 等待中断）",
            ));
        }
        let matched = poll_condition(exec, &cond, &opts, &mut zero_count, quiet_polls).await?;
        if matched {
            return Ok(ActionSuccess {
                navigated: false,
                url_after: None,
                page_changed: false,
                payload: None,
            });
        }
        if started.elapsed() >= timeout {
            return Err(ActionError::new(
                ActionErrorKind::Timeout,
                format!("wait_for 超时（{}ms）", timeout_ms),
            ));
        }
        exec.delay.sleep(poll).await;
    }
}

/// NetworkIdle 静默窗口的轮询次数折算（quiet_ms / poll_ms，至少 1）。
fn quiet_polls_for(cond: &WaitCondition, poll_ms: u32) -> u32 {
    match cond {
        WaitCondition::NetworkIdle { quiet_ms } => ((*quiet_ms).max(1) / poll_ms.max(1)).max(1),
        _ => 0,
    }
}

/// 单轮条件判定（§6.1 表）。
async fn poll_condition(
    exec: &ActionExecutor,
    cond: &WaitCondition,
    opts: &WaitOptions,
    zero_count: &mut u32,
    quiet_polls: u32,
) -> Result<bool, ActionError> {
    match cond {
        WaitCondition::Text(needle) => {
            // 固定模板 + JSON 序列化注入（R-5）；页面求值异常不终止等待（视为未命中）
            match exec.ops.evaluate(&text_poll_expression(needle)).await {
                Ok(value) => Ok(value.as_bool().unwrap_or(false)),
                Err(_) => Ok(false),
            }
        }
        WaitCondition::Url { contains } => match exec.ops.current_url().await {
            Ok(url) => Ok(url.contains(contains.as_str())),
            Err(_) => Ok(false),
        },
        WaitCondition::NetworkIdle { quiet_ms: _ } => {
            let in_flight = exec.ops.network_in_flight().await?;
            if in_flight == 0 {
                *zero_count += 1;
                Ok(*zero_count >= quiet_polls)
            } else {
                *zero_count = 0;
                Ok(false)
            }
        }
        WaitCondition::Element { index } => {
            // 快照重拍轮询（T-7）；重拍失败（预算超限）→ 按超时处理（§6.2）
            let version = exec
                .snapshot
                .take_snapshot(&opts.tab_id)
                .await
                .map_err(|e| {
                    ActionError::new(
                        ActionErrorKind::Timeout,
                        format!("wait_for 元素快照重拍失败：{}", e.message),
                    )
                })?;
            let Some(meta) = exec
                .snapshot
                .element_by_index(&opts.tab_id, version, *index)
            else {
                return Ok(false);
            };
            // 复用 §3 定位链可见性校验（push → box 有效即可视为可见可交互）
            match exec.ops.push_nodes(&[meta.backend_node_id]).await {
                Ok(ids) if ids.first().copied().unwrap_or(-1) > 0 => {
                    let node_id = ids[0];
                    match exec.ops.box_model(node_id).await {
                        Ok(model) => Ok(crate::action::locate::click_point_from_model(
                            &model,
                            &exec.ops.viewport().await?,
                        )
                        .is_some()),
                        Err(_) => Ok(false),
                    }
                }
                _ => Ok(false),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;
    use crate::action::{ActionExecutor, ElementMeta};
    use crate::cdp::sender::CancellationToken;
    use async_trait::async_trait;
    use std::sync::Arc;

    fn exec_with(
        ops: MockOps,
        snapshot: MockSnapshotStore,
    ) -> (ActionExecutor, MockOps, Arc<RecordingDelay>) {
        let token = CancellationToken::new();
        let delay = Arc::new(RecordingDelay::new());
        let exec = ActionExecutor::new(Arc::new(ops.clone()), Arc::new(snapshot), token)
            .with_gate(Arc::new(AllowGate))
            .with_delay(delay.clone());
        (exec, ops, delay)
    }

    fn opts(cond: &WaitCondition) -> WaitOptions {
        WaitOptions::for_condition(cond, "t1".to_string())
    }

    /// 文本命中（固定模板轮询返回 true）。
    #[tokio::test]
    async fn text_condition_hit() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().text_match = true;
        let (exec, _ops, _delay) = exec_with(ops, MockSnapshotStore::new(1));
        exec.wait_for(
            WaitCondition::Text("你好".to_string()),
            opts(&WaitCondition::Text("你好".to_string())),
        )
        .await
        .expect("文本应命中");
    }

    /// 文本超时：恒 false → Timeout。
    #[tokio::test]
    async fn text_condition_timeout() {
        let (exec, _ops, _delay) = exec_with(MockOps::new(), MockSnapshotStore::new(1));
        let cond = WaitCondition::Text("不存在的文本".to_string());
        let mut options = opts(&cond);
        options = options.with_timeout_ms(10).with_poll_ms(5);
        let err = exec.wait_for(cond, options).await.expect_err("应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
    }

    /// URL 命中/超时（纯字符串子串匹配，禁止正则语义）。
    #[tokio::test]
    async fn url_condition_hit_and_timeout() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().url = "https://example.com/login?next=/home".to_string();
        let (exec, _ops, _delay) = exec_with(ops, MockSnapshotStore::new(1));
        exec.wait_for(
            WaitCondition::Url {
                contains: "/home".to_string(),
            },
            opts(&WaitCondition::Url {
                contains: "/home".to_string(),
            }),
        )
        .await
        .expect("URL 子串应命中");
        // 非命中 → 超时
        let cond = WaitCondition::Url {
            contains: "other".to_string(),
        };
        let mut options = opts(&cond);
        options = options.with_timeout_ms(10).with_poll_ms(5);
        let err = exec.wait_for(cond, options).await.expect_err("应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
    }

    /// 网络空闲：在途归零并持续静默窗口（确定性轮询计数）。
    #[tokio::test]
    async fn network_idle_quiet_window() {
        let (exec, ops, delay) = exec_with(MockOps::new(), MockSnapshotStore::new(1));
        // 静默窗口 30ms，轮询 10ms → 3 次连续零在途（确定性：初始即在途 0）
        let cond = WaitCondition::NetworkIdle { quiet_ms: 30 };
        let mut options = opts(&cond);
        options = options.with_timeout_ms(5000).with_poll_ms(10);
        let result = exec.wait_for(cond, options).await.expect("应命中空闲");
        assert!(!result.navigated);
        // 3 次连续零在途轮询 → 2 次轮询间隔（第 3 次命中）
        assert_eq!(delay.durations().len(), 2, "应轮询 3 次（2 间隔 + 命中）");
        assert_eq!(ops.count(MockOp::NetworkInFlight), 3);
    }

    /// 元素命中：快照重拍后索引存在且 box 可见。
    #[tokio::test]
    async fn element_condition_hit() {
        let (exec, _ops, _delay) = exec_with(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        let cond = WaitCondition::Element { index: 0 };
        let mut options = opts(&cond);
        options = options.with_poll_ms(10);
        exec.wait_for(cond, options).await.expect("元素应可见命中");
    }

    /// 元素中途版本失效：重拍失败（快照预算超限）→ 按超时处理（§6.2）。
    #[tokio::test]
    async fn element_condition_snapshot_failure_timeout() {
        let snapshot = MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }],
        );
        snapshot
            .state
            .lock()
            .unwrap()
            .take_errors
            .push_back(ActionError::new(ActionErrorKind::Timeout, "快照重拍超时"));
        let (exec, _ops, _delay) = exec_with(MockOps::new(), snapshot);
        let cond = WaitCondition::Element { index: 0 };
        let options = opts(&cond);
        let err = exec
            .wait_for(cond, options)
            .await
            .expect_err("重拍失败应按超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
    }

    /// 元素消失：重拍后索引不存在 → 轮询至超时。
    #[tokio::test]
    async fn element_condition_gone_times_out() {
        // 快照 v1 无该索引（元素从未出现/已被删除）
        let snapshot = MockSnapshotStore::new(1);
        let (exec, _ops, _delay) = exec_with(MockOps::new(), snapshot);
        let cond = WaitCondition::Element { index: 5 };
        let mut options = opts(&cond);
        options = options.with_timeout_ms(10).with_poll_ms(5);
        let err = exec.wait_for(cond, options).await.expect_err("应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
    }

    /// 等待期间 abort：立即退出（不空等）。
    #[tokio::test]
    async fn wait_abort_interrupts() {
        let token = CancellationToken::new();
        token.cancel();
        let exec = ActionExecutor::new(
            Arc::new(MockOps::new()),
            Arc::new(MockSnapshotStore::new(1)),
            token,
        )
        .with_gate(Arc::new(AllowGate));
        let cond = WaitCondition::Text("x".to_string());
        let options = opts(&cond);
        let err = exec.wait_for(cond, options).await.expect_err("应中止");
        assert_eq!(err.kind, ActionErrorKind::Aborted);
    }

    // —— R-5 注入面安全红线：恶意文本不得产生代码执行面 ——

    /// 序列化注入 round-trip：任何恶意输入解码后必须原样还原（无逃逸）。
    #[test]
    fn text_poll_injection_roundtrip() {
        let cases = [
            r#"a"b"#,                                // 双引号
            r#"a\b"#,                                // 反斜杠
            "line1\nline2\t\"x\"",                   // 换行/制表
            r#"${alert(1)}"#,                        // 模板插值尝试
            r#"</script><script>alert(1)</script>"#, // JS 片段
            r#"', alert(1), '"#,                     // 引号逃逸尝试
            r#"")); eval("pwned"); //"#,             // 括号逃逸
            "中文\n'\"\\",                           // 中文 + 转义混排
        ];
        for input in cases {
            let expr = text_poll_expression(input);
            // 模板前缀/后缀字节级固定（模型输入只允许落在唯一占位符处）
            assert!(
                expr.starts_with(r#"(function() { const needle = "#),
                "模板前缀必须固定"
            );
            assert!(expr.ends_with(r#"; const el = document.body; if (!el || !el.innerText) return false; return el.innerText.includes(needle); })()"#), "模板后缀必须固定");
            // 字面量必须是双引号 JSON 字符串（非反引号模板串 → ${} 惰性无执行面）
            let literal = &expr[r#"(function() { const needle = "#.len()..expr.len() - r#"; const el = document.body; if (!el || !el.innerText) return false; return el.innerText.includes(needle); })()"#.len()];
            assert!(literal.starts_with('"'), "字面量必须为双引号包裹");
            // 关键红线：解码还原 = 输入原样（JSON 字符串字面量无逃逸）
            let decoded: String = serde_json::from_str(literal).expect("必须是合法 JSON 字符串");
            assert_eq!(decoded, input, "注入必须无损还原（无代码执行面）");
            // 辅助红线：字面量内不得出现可执行括号序列（`"));` 形态必须被转义）
            assert!(
                !literal.contains(r#"));"#) || literal.contains(r#"\"));"#),
                "括号逃逸形态必须被 JSON 转义"
            );
        }
    }

    /// 模板结构红线：占位符唯一、无反引号、无 eval/Function 形态。
    #[test]
    fn text_poll_template_structure() {
        assert_eq!(
            TEXT_POLL_TEMPLATE.matches("%PARAM%").count(),
            1,
            "占位符唯一"
        );
        assert!(
            !TEXT_POLL_TEMPLATE.contains('`'),
            "禁止反引号模板串（模板插值惰性面）"
        );
        assert!(!TEXT_POLL_TEMPLATE.contains("eval"), "模板不含 eval");
        assert!(
            !TEXT_POLL_TEMPLATE.contains("new Function"),
            "模板不含构造面"
        );
        // 序列化注入结果中 `${` 只能出现在双引号字面量内（模板无反引号 → 惰性）
        let expr = text_poll_expression(r#"${x}"#);
        assert!(expr.contains(r#""${x}""#), "模板插值应原样留在字面量内");
        assert_eq!(expr.matches('`').count(), 0);
    }

    /// 轮询间隔定值（T-7）：Element = max(200, 快照预算)；Text/Url = 100ms。
    #[test]
    fn poll_interval_defaults() {
        let opts =
            WaitOptions::for_condition(&WaitCondition::Element { index: 0 }, "t1".to_string());
        assert_eq!(
            poll_interval_ms(&WaitCondition::Element { index: 0 }, &opts),
            2000
        );
        let opts =
            WaitOptions::for_condition(&WaitCondition::Text("x".to_string()), "t1".to_string());
        assert_eq!(
            poll_interval_ms(&WaitCondition::Text("x".to_string()), &opts),
            100
        );
        // 显式覆盖优先
        let opts = opts.with_poll_ms(77);
        assert_eq!(
            poll_interval_ms(&WaitCondition::Text("x".to_string()), &opts),
            77
        );
    }

    /// 超时默认值（§6.2）：Element/Text 10s；NetworkIdle/Url 30s。
    #[test]
    fn wait_timeout_defaults() {
        let el = WaitOptions::for_condition(&WaitCondition::Element { index: 0 }, "t1".to_string());
        assert_eq!(el.timeout_ms, 10_000);
        let text =
            WaitOptions::for_condition(&WaitCondition::Text("x".to_string()), "t1".to_string());
        assert_eq!(text.timeout_ms, 10_000);
        let idle = WaitOptions::for_condition(
            &WaitCondition::NetworkIdle { quiet_ms: 500 },
            "t1".to_string(),
        );
        assert_eq!(idle.timeout_ms, 30_000);
        let url = WaitOptions::for_condition(
            &WaitCondition::Url {
                contains: "x".to_string(),
            },
            "t1".to_string(),
        );
        assert_eq!(url.timeout_ms, 30_000);
    }

    /// 文本轮询表达式可注入执行面校验的补充：`all` 形状参数（数组/对象形态文本）。
    #[test]
    fn text_poll_expression_any_shape() {
        for input in ["", " ", "x=1&y=2", "[]{}\"\\", "你好，世界！"] {
            let expr = text_poll_expression(input);
            let literal = &expr[r#"(function() { const needle = "#.len()..expr.len() - r#"; const el = document.body; if (!el || !el.innerText) return false; return el.innerText.includes(needle); })()"#.len()];
            let decoded: String = serde_json::from_str(literal).expect("合法 JSON");
            assert_eq!(decoded, input);
        }
    }

    // ---------- 轮询循环时间语义（评审 P2 补强：注入时钟逐轮断言） ----------

    /// 轮询间隔公式（T-7 定值，常量级断言）：Element = max(200ms, 快照预算)；
    /// Text/Url = 100ms；NetworkIdle = 50ms；显式覆盖优先。
    #[test]
    fn poll_interval_formula_by_condition() {
        let el = WaitOptions::for_condition(&WaitCondition::Element { index: 0 }, "t1".to_string());
        assert_eq!(
            poll_interval_ms(&WaitCondition::Element { index: 0 }, &el),
            POLL_ELEMENT_FLOOR_MS.max(SNAPSHOT_POLL_BUDGET_MS),
            "Element 间隔 = max(200ms, 快照预算)"
        );
        let idle = WaitOptions::for_condition(
            &WaitCondition::NetworkIdle { quiet_ms: 500 },
            "t1".to_string(),
        );
        assert_eq!(
            poll_interval_ms(&WaitCondition::NetworkIdle { quiet_ms: 500 }, &idle),
            POLL_NETWORK_MS
        );
        let text =
            WaitOptions::for_condition(&WaitCondition::Text("x".to_string()), "t1".to_string());
        assert_eq!(
            poll_interval_ms(&WaitCondition::Text("x".to_string()), &text),
            POLL_TEXT_MS
        );
        let url = WaitOptions::for_condition(
            &WaitCondition::Url {
                contains: "x".to_string(),
            },
            "t1".to_string(),
        );
        assert_eq!(
            poll_interval_ms(
                &WaitCondition::Url {
                    contains: "x".to_string()
                },
                &url
            ),
            POLL_TEXT_MS
        );
        // 显式覆盖（注入时钟入口）优先于条件默认
        let overridden = text.clone().with_poll_ms(77);
        assert_eq!(
            poll_interval_ms(&WaitCondition::Text("x".to_string()), &overridden),
            77
        );
    }

    /// Text 超时路径的逐轮间隔记录：每次 sleep 都精确等于默认 100ms
    /// （RecordingDelay 即注入时钟，记录值即调度面语义）。
    #[tokio::test]
    async fn text_poll_records_default_interval() {
        let (exec, _ops, delay) = exec_with(MockOps::new(), MockSnapshotStore::new(1));
        let cond = WaitCondition::Text("永远不出现".to_string());
        let options = WaitOptions::for_condition(&cond, "t1".to_string()).with_timeout_ms(30);
        let err = exec.wait_for(cond, options).await.expect_err("应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        let durations = delay.durations();
        assert!(!durations.is_empty(), "超时前必须至少发起一次轮询");
        assert!(
            durations
                .iter()
                .all(|d| *d == Duration::from_millis(POLL_TEXT_MS as u64)),
            "Text 每轮间隔必须为默认 100ms：{durations:?}"
        );
    }

    /// Element 超时路径：每轮间隔精确等于 max(200ms, 快照预算) = 2000ms
    /// （T-7 定值落进真实调度循环）。
    #[tokio::test]
    async fn element_poll_records_budget_interval() {
        let (exec, _ops, delay) = exec_with(MockOps::new(), MockSnapshotStore::new(1));
        let cond = WaitCondition::Element { index: 99 };
        let options = WaitOptions::for_condition(&cond, "t1".to_string()).with_timeout_ms(30);
        let err = exec
            .wait_for(cond, options)
            .await
            .expect_err("索引不存在应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        let durations = delay.durations();
        assert!(!durations.is_empty());
        let expected = POLL_ELEMENT_FLOOR_MS.max(SNAPSHOT_POLL_BUDGET_MS) as u64;
        assert!(
            durations.iter().all(|d| d.as_millis() as u64 == expected),
            "Element 每轮间隔必须为 {expected}ms：{durations:?}"
        );
    }

    /// 显式 poll 覆盖（注入面）：记录值 = 覆盖值，与条件无关。
    #[tokio::test]
    async fn explicit_poll_override_records_value() {
        let (exec, _ops, delay) = exec_with(MockOps::new(), MockSnapshotStore::new(1));
        let cond = WaitCondition::Text("永不".to_string());
        let options = WaitOptions::for_condition(&cond, "t1".to_string())
            .with_timeout_ms(30)
            .with_poll_ms(77);
        let err = exec.wait_for(cond, options).await.expect_err("应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        let durations = delay.durations();
        assert!(
            durations.iter().all(|d| *d == Duration::from_millis(77)),
            "显式覆盖必须生效：{durations:?}"
        );
    }

    /// 确定性快照存储：第一次 take 成功（空索引表），第二次 take 失败（预算超限）。
    /// 模拟「首轮未命中 → 中途版本失效 → 重拍失败」的确定性序列。
    struct TakeThenFailStore {
        takes: std::sync::atomic::AtomicU8,
    }

    impl TakeThenFailStore {
        fn new() -> Self {
            TakeThenFailStore {
                takes: std::sync::atomic::AtomicU8::new(0),
            }
        }

        fn take_count(&self) -> u8 {
            self.takes.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl crate::action::SnapshotStore for TakeThenFailStore {
        fn snapshot_version(&self, _tab_id: &TabId) -> u64 {
            0
        }

        fn validate_snapshot(
            &self,
            _tab_id: &TabId,
            _version: u64,
        ) -> Result<(), crate::cdp::version::Stale> {
            Ok(())
        }

        async fn take_snapshot(&self, _tab_id: &TabId) -> Result<u64, ActionError> {
            let n = self.takes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n == 0 {
                Ok(1)
            } else {
                Err(ActionError::new(
                    ActionErrorKind::Timeout,
                    "快照重拍超时（中途失效）",
                ))
            }
        }

        fn element_by_index(
            &self,
            _tab_id: &TabId,
            _version: u64,
            _index: usize,
        ) -> Option<ElementMeta> {
            None
        }

        fn note_action_done(&self, _tab_id: &TabId) {}
    }

    /// 中途版本失效 1：首轮快照未命中 → 第二轮重拍失败（快照预算超限）
    /// → 立即按超时终止（§6.2），不拖到 deadline。
    #[tokio::test]
    async fn element_mid_wait_take_failure_times_out_immediately() {
        let store = Arc::new(TakeThenFailStore::new());
        let delay = Arc::new(RecordingDelay::new());
        let exec = ActionExecutor::new(
            Arc::new(MockOps::new()),
            store.clone(),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(delay.clone());
        let cond = WaitCondition::Element { index: 0 };
        let options = WaitOptions::for_condition(&cond, "t1".to_string()).with_timeout_ms(60_000);
        let err = exec
            .wait_for(cond, options)
            .await
            .expect_err("重拍失败应按超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        assert_eq!(store.take_count(), 2, "首轮成功后第二轮失败");
        let durations = delay.durations();
        assert_eq!(durations.len(), 1, "失败终止前只允许一次轮询间隔");
        assert_eq!(
            durations[0].as_millis() as u64,
            POLL_ELEMENT_FLOOR_MS.max(SNAPSHOT_POLL_BUDGET_MS) as u64,
            "间隔仍按 Element 定值"
        );
    }

    /// 中途版本失效 2：元素在等待期间才出现（快照 v1 空 → 页面版本推进 →
    /// 快照 v2 含元素）→ 次轮命中（失效不毒化后续轮询，合并语义）。
    #[tokio::test]
    async fn element_appears_mid_wait_then_hit() {
        // 版本键控索引表：v1 无元素（首轮未命中），v2 含元素（版本推进后出现）
        let snapshot = MockSnapshotStore::new(0);
        {
            let mut s = snapshot.state.lock().unwrap_or_else(|p| p.into_inner());
            s.elements.insert(1, Vec::new());
            s.elements.insert(
                2,
                vec![ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            );
        }
        let (exec, _ops, delay) = exec_with(MockOps::new(), snapshot.clone());
        let cond = WaitCondition::Element { index: 0 };
        let options = WaitOptions::for_condition(&cond, "t1".to_string()).with_timeout_ms(60_000);
        exec.wait_for(cond, options)
            .await
            .expect("版本推进后元素应命中");
        assert_eq!(snapshot.take_count(), 2, "首轮未命中 + 次轮命中");
        let durations = delay.durations();
        assert_eq!(durations.len(), 1, "仅一次未命中间隔");
        assert_eq!(
            durations[0].as_millis() as u64,
            POLL_ELEMENT_FLOOR_MS.max(SNAPSHOT_POLL_BUDGET_MS) as u64
        );
    }

    /// 中途版本失效 3：元素 box 状态中途失效（首次 box 计算失败）
    /// → 视为未命中继续轮询 → 次轮恢复命中。
    #[tokio::test]
    async fn element_box_invalid_mid_wait_recovers() {
        let ops = MockOps::new();
        ops.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .fail_queue
            .push_back((
                MockOp::BoxModel,
                ActionError::new(ActionErrorKind::NodeStale, "box 计算失败（中途失效）"),
            ));
        let (exec, _ops, delay) = exec_with(
            ops,
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        let cond = WaitCondition::Element { index: 0 };
        let options = WaitOptions::for_condition(&cond, "t1".to_string()).with_timeout_ms(60_000);
        exec.wait_for(cond, options)
            .await
            .expect("box 恢复后应命中");
        let durations = delay.durations();
        assert_eq!(durations.len(), 1, "一次失败 + 一次成功 = 一个间隔");
        assert_eq!(
            durations[0].as_millis() as u64,
            POLL_ELEMENT_FLOOR_MS.max(SNAPSHOT_POLL_BUDGET_MS) as u64
        );
    }

    /// NetworkIdle 超时路径：每轮间隔 = 50ms（POLL_NETWORK_MS 定值记录）。
    #[tokio::test]
    async fn network_idle_poll_records_interval() {
        let ops = MockOps::new();
        ops.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .in_flight = 3;
        let (exec, _ops, delay) = exec_with(ops, MockSnapshotStore::new(1));
        let cond = WaitCondition::NetworkIdle { quiet_ms: 500 };
        let options = WaitOptions::for_condition(&cond, "t1".to_string()).with_timeout_ms(30);
        let err = exec
            .wait_for(cond, options)
            .await
            .expect_err("在途不清零应超时");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        let durations = delay.durations();
        assert!(!durations.is_empty());
        assert!(
            durations
                .iter()
                .all(|d| *d == Duration::from_millis(POLL_NETWORK_MS as u64)),
            "NetworkIdle 每轮间隔必须为 50ms：{durations:?}"
        );
    }
}
