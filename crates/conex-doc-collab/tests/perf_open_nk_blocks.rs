//! Round9 · A-PERF 数值门测量脚手架（DocSession 打开 N 块代理）
//!
//! # 度量
//! - **metric** `open_nk_blocks`：向空 `DocSession` **批量** `apply` N 个根级
//!   `Op::Insert`（Paragraph）的 wall time（ms）。
//! - 这是 A-PERF-01「打开 N 块至可交互」的 **数据层代理**（无 UI / WebView）；
//!   不得把本测结果直接标成「数值门通过」——须人工回填 `perf-baseline.md`。
//!
//! # 环境变量
//! | 变量 | 默认 | 说明 |
//! |------|------|------|
//! | `PERF_N` | `1000` | 块数（常用 1000 / 10000；100k 仅本机自愿） |
//! | `PERF_ITERS` | `7` | 计时样本数（用于 p50/p95） |
//! | `PERF_WARMUP` | `1` | 不计时热身轮次 |
//!
//! # 运行（CI **默认不跑**：`#[ignore]`）
//! ```text
//! cargo test -p conex-doc-collab --test perf_open_nk_blocks --release -- --ignored --nocapture
//! # 10k：
//! set PERF_N=10000   # Windows PowerShell: $env:PERF_N=10000
//! cargo test -p conex-doc-collab --test perf_open_nk_blocks --release -- --ignored --nocapture
//! ```
//!
//! 输出：**单行 JSON**（stdout），字段见 `perf-baseline.md` §7。
//!
//! # 权威
//! - `docs/block-workspace-architecture/plans/acceptance/perf-baseline.md`
//! - H3 / A-PERF-DEG-01（`18-实现波前待决锁定-H1H2H3M1.md` §H3）
//!
//! # 纪律
//! - **禁止** 脚本自动把 TBD 改成「达标」数字
//! - 本测 **无** 相对 baseline 的 pass/fail 断言（数值门未标定前不比较）

use std::env;
use std::time::Instant;

use conex_doc_collab::{
    a_perf, BlockId, BlockKind, BlockProps, DocSession, Op, Origin, DEFAULT_MAX_HOT,
};

fn env_usize(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

/// 构建 N 个根级 Insert Op（order 零填充保证字典序稳定且可扩到 100k+）。
fn make_insert_ops(n: usize) -> Vec<Op> {
    let width = ((n as f64).log10().floor() as usize) + 1;
    let width = width.max(6);
    (0..n)
        .map(|i| Op::Insert {
            id: BlockId::new(),
            parent: None,
            order: format!("{i:0width$}"),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        })
        .collect()
}

/// 单次：新建 session + 批量 apply N 块；返回 wall ms。
fn once_insert_n(n: usize) -> (f64, usize, usize) {
    let ops = make_insert_ops(n);
    let mut s = DocSession::new("perf-open-nk");
    let t0 = Instant::now();
    s.apply(Origin::System, &ops)
        .expect("batch insert N blocks must succeed");
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let node_count = s.tree().nodes.len();
    let hot = s.text_hot_count();
    // 结构伴随：节点数 = N；热集 ≤ DEFAULT_MAX_HOT（Insert 不强制全热，但不得越界）
    assert_eq!(node_count, n, "tree.nodes.len() must equal N");
    assert!(
        hot <= s.text_max_hot(),
        "hot_count {hot} must be ≤ max_hot {}",
        s.text_max_hot()
    );
    assert_eq!(s.text_max_hot(), DEFAULT_MAX_HOT);
    let _ = a_perf::A_PERF_DEG_01; // 锚定退化 ID 可引用
    (ms, node_count, hot)
}

fn percentile_ms(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = (p / 100.0) * (sorted.len() as f64 - 1.0);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let w = rank - lo as f64;
        sorted[lo] * (1.0 - w) + sorted[hi] * w
    }
}

fn machine_hints() -> serde_json::Value {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    serde_json::json!({
        "os": os,
        "arch": arch,
        "cpu_logical": cpus,
        "family": std::env::consts::FAMILY,
    })
}

/// 测量脚手架：默认 ignore，本地显式 `--ignored` 跑。
#[test]
#[ignore = "perf scaffold: local only; CI must not run by default (H3 numerical gate)"]
fn perf_open_nk_blocks() {
    let n = env_usize("PERF_N", 1_000);
    let iters = env_usize("PERF_ITERS", 7);
    let warmup = env_usize("PERF_WARMUP", 1);

    for _ in 0..warmup {
        let _ = once_insert_n(n);
    }

    let mut samples = Vec::with_capacity(iters);
    let mut last_hot = 0usize;
    for _ in 0..iters {
        let (ms, _nodes, hot) = once_insert_n(n);
        samples.push(ms);
        last_hot = hot;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let p50 = percentile_ms(&samples, 50.0);
    let p95 = percentile_ms(&samples, 95.0);
    let hints = machine_hints();

    // 单行 JSON：metric / n / p50_ms / p95_ms / machine hints
    // 人工复制到 perf-baseline.md；本进程 **绝不** 改写该文件。
    let line = serde_json::json!({
        "metric": "open_nk_blocks",
        "metric_id": format!("open_{n}_insert_batch"),
        "n": n,
        "iters": iters,
        "warmup": warmup,
        "p50_ms": (p50 * 1000.0).round() / 1000.0,
        "p95_ms": (p95 * 1000.0).round() / 1000.0,
        "samples_ms": samples.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>(),
        "text_hot_count_last": last_hot,
        "text_max_hot": DEFAULT_MAX_HOT,
        "mode": "release_or_debug_as_built",
        "a_perf_deg": a_perf::A_PERF_DEG_01,
        "os": hints["os"],
        "arch": hints["arch"],
        "cpu_logical": hints["cpu_logical"],
        "family": hints["family"],
        "note": "manual backfill only; do not auto-rewrite TBD in perf-baseline.md",
    });

    println!("{}", serde_json::to_string(&line).expect("json"));
    // 人工可读副输出（非 JSON，便于 --nocapture 扫一眼）
    eprintln!(
        "[perf_open_nk_blocks] n={n} iters={iters} p50_ms={p50:.3} p95_ms={p95:.3} os={} arch={}",
        hints["os"].as_str().unwrap_or("?"),
        hints["arch"].as_str().unwrap_or("?"),
    );
}
