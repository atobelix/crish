//! 日志可观测性测试（PE-04 T04.2）
//!
//! 验证：run 生命周期启动 / 收场日志发出。
//! 用 tracing-subscriber 的 fmt 写入内存缓冲捕获，不依赖外部日志文件。

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use session_loop::testing::TestProvider;
use session_loop::AgentSessionLoop;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

/// 捕获日志的内存缓冲（fmt writer 共享同一缓冲）。
#[derive(Default)]
struct LogCapture {
    lines: Mutex<Vec<String>>,
}

impl LogCapture {
    fn push(&self, line: &str) {
        self.lines.lock().unwrap().push(line.to_string());
    }
    fn snapshot(&self) -> Vec<String> {
        self.lines.lock().unwrap().clone()
    }
}

/// fmt writer：Arc 包装共享缓冲。
struct ArcWriter(Arc<LogCapture>);

impl Write for ArcWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // fmt 会以行调用；按行切分逐行记录
        let text = String::from_utf8_lossy(buf);
        for line in text.lines() {
            self.0.push(line);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 在捕获 subscriber 下执行闭包，返回捕获行。
fn with_capture<F, R>(f: F) -> (R, Vec<String>)
where
    F: FnOnce() -> R,
{
    let capture = Arc::new(LogCapture::default());
    let writer = capture.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || ArcWriter(writer.clone()))
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let result = f();
    let lines = capture.snapshot();
    (result, lines)
}

fn user_input(text: &str, seq: u32) -> AgentMessage {
    AgentMessage {
        id: format!("run-{seq}"),
        role: AgentMessageRole::User,
        created_at: "2026-08-01T00:00:00.000Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

#[test]
fn run_emits_start_and_end_logs() {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let provider = TestProvider::text_reply("好的");
    let mut loop_inst = AgentSessionLoop::new(
        "sess-log-test",
        "run-log-test",
        16,
        Box::new(provider),
        Arc::new(agent_tools::registry::ToolRegistry::new()),
    );
    let input = user_input("你好", seq);

    let (outcome, lines) = with_capture(|| {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async { loop_inst.run(input).await })
    });

    // AgentEndReason 未从 conex-types 导出，用 Debug 串比较
    let reason_debug = format!("{:?}", outcome.reason);
    assert!(
        reason_debug.contains("YieldSuspended"),
        "期望协作式让出收场，实际：{reason_debug}"
    );
    let joined = lines.join("\n");
    assert!(
        joined.contains("run 启动"),
        "缺少 run 启动日志，捕获：\n{joined}"
    );
    assert!(
        joined.contains("run 收场"),
        "缺少 run 收场日志，捕获：\n{joined}"
    );
}
