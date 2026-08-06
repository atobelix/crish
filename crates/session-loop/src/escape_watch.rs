//! 逃逸监视装配层（T-ESC-03 P3 装配面：run 生命周期 + 聚合限流发射）
//!
//! 逃逸追踪主方案（docs/feature-gap-analysis/REQ-逃逸追踪分析.md §3）：
//! run 期间 watcher 事件 → 判定（声明覆盖跳过）→ 聚合（同 run 同路径
//! 去重 + 批阈值/时间窗限流）→ 发射（审计事件 + 主 agent 注入双通道）。
//!
//! 本模块承载装配面（§3.5.1）：
//! - [EscapeWatchConfig]：装配配置（经 [crate::r#loop::SessionLoopOptions]
//!   的 `escape_watch` 字段透传；壳层 core_run_commands.rs 装配）；
//! - [spawn_escape_watch]：run 启动钩子一步到位（watcher.start + 消费
//!   任务 spawn，静态排除清单见 [escape_exclude_paths]，§3.4）；
//! - [EscapeWatchHandle]：run 收口句柄（shutdown = stop + flush 剩余
//!   事件聚合补发；Drop 兜底停止，§5.4「run 中崩溃」风险缓解）；
//! - [EscapeAggregator]：聚合器纯逻辑（同路径去重、批阈值、破坏性
//!   标记、时间窗字段）。
//!
//! 判定器接线（§3.1 关键决策点 + 任务卡第 6 点，C-36 已闭环）：
//! 壳层 run 装配（core_run_commands.rs，30 方案 P5 接线，2026-08-05 批 1
//! 落地）经 [EscapeWatchConfig::with_detector] 注入
//! [crate::undeclared_detector::RegistryBackedDetector]，且同一
//! `WritePathRegistry` 实例成对注入 loop 的 write_claims（双端注入成对，
//! 共用解析 helper [resolve_escape_watch_root] 杜绝根解析双处漂移）——
//! 工具声明覆盖即判定器命中，未声明写入经监视事件上报（E2E-3 声明静默 /
//! 未声明上报两端到端断言锚定）。[EscapeWatchConfig::detector] 缺省
//! None 仅表示未装配降级（无注册表时依赖监视事件直接发射的兜底语义，
//! REQ §3.1:349-356）。
//!
//! 发射语义（§3.3:482-509）：审计事件 operation=undeclared-write、
//! targets=变更路径（绝对路径，与 delete/shell 审计惯例一致）、
//! decision=denied（「非引擎批准路径的操作」标记，不改 decision 枚举）、
//! tool_call_id=None（工具外写入，无工具调用）；主 agent 注入文案见
//! [build_escape_injection_text]（限流同 run 聚合：一条聚合报告 = 一条
//! 注入，防刷屏，§3.5.3）。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_tools::audit::{AuditSink, security_audit_event};
use conex_fs::watch::{ChangeKind, FileChangeEvent, UndeclaredWrite, WorkspaceWatcher};
use conex_types::events::{SecurityAuditDecision, SecurityAuditOperation};
use conex_types::impact::{IMPACT_FLAG_FILE_THRESHOLD, ImpactAssessment};

use crate::undeclared_detector::UndeclaredWriteDetector;

/// 批量限流默认阈值（聚合路径数）：聚合批达到该数量立即发射一批
/// （防刷屏：单条报告承载最多该数量的路径摘要）
const DEFAULT_BATCH_SIZE: usize = 10;

/// 时间窗限流默认值（毫秒）：距上次发射超窗且有待报聚合 → 发射
/// （低频事件不长时间静默，实时性粒度 = 时间窗）
const DEFAULT_FLUSH_INTERVAL_MS: u64 = 5_000;

/// 逃逸监视装配配置（SessionLoopOptions 透传 + 消费任务输入）
///
/// 壳层装配（core_run_commands.rs run 起停钩子）：watcher 启动 →
/// [spawn_escape_watch_consumer] 消费 → run 收口 shutdown。LoopState
/// 不消费本配置（消费循环由壳层 spawn，本类型仅作装配上下文透传）。
#[derive(Clone)]
pub struct EscapeWatchConfig {
    /// 监视根（工作区根；相对路径显示基准，与 watcher 同源）
    pub root: PathBuf,
    /// 会话标识（审计事件体）
    pub session_id: String,
    /// run 标识（归因报告与注入文案）
    pub run_id: String,
    /// 审计 sink（security-audit 事件出口；必填）
    pub audit_sink: AuditSink,
    /// 主 agent 注入回调（None = 不注入，仅审计发射）
    pub injector: Option<Arc<dyn EscapeWatchInjector>>,
    /// 判定器（None = 仅依赖监视事件直接发射——write_claims 未接线的
    /// 「工具审计覆盖」第二来源兜底；30 方案 P5 后生产装配恒注入
    /// [crate::undeclared_detector::RegistryBackedDetector]，C-36 已闭环）
    pub detector: Option<Arc<dyn UndeclaredWriteDetector>>,
    /// 批量限流阈值（聚合路径数；默认 [DEFAULT_BATCH_SIZE]）
    pub batch_size: usize,
    /// 时间窗限流（毫秒；默认 [DEFAULT_FLUSH_INTERVAL_MS]）
    pub flush_interval_ms: u64,
}

impl EscapeWatchConfig {
    /// 新建装配配置（root / session / run / 审计 sink；批量与时间窗取
    /// 默认值，注入与判定器缺省关闭）
    pub fn new(
        root: impl Into<PathBuf>,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        audit_sink: AuditSink,
    ) -> Self {
        Self {
            root: root.into(),
            session_id: session_id.into(),
            run_id: run_id.into(),
            audit_sink,
            injector: None,
            detector: None,
            batch_size: DEFAULT_BATCH_SIZE,
            flush_interval_ms: DEFAULT_FLUSH_INTERVAL_MS,
        }
    }

    /// 装配主 agent 注入回调（归因摘要经注入通道塞进会话）
    pub fn with_injector(mut self, injector: Arc<dyn EscapeWatchInjector>) -> Self {
        self.injector = Some(injector);
        self
    }

    /// 装配判定器（声明覆盖判定；F7 T-EG-06 接线注册表时调用）
    pub fn with_detector(mut self, detector: Arc<dyn UndeclaredWriteDetector>) -> Self {
        self.detector = Some(detector);
        self
    }

    /// 调整限流参数（批量阈值 / 时间窗毫秒；测试收紧用）
    pub fn with_limits(mut self, batch_size: usize, flush_interval_ms: u64) -> Self {
        self.batch_size = batch_size.max(1);
        self.flush_interval_ms = flush_interval_ms;
        self
    }
}

impl std::fmt::Debug for EscapeWatchConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 判定器/注入器为动态 trait 对象（无 Debug bound），仅打印存在性
        f.debug_struct("EscapeWatchConfig")
            .field("root", &self.root)
            .field("session_id", &self.session_id)
            .field("run_id", &self.run_id)
            .field("audit_sink", &self.audit_sink)
            .field("injector", &self.injector.as_ref().map(|_| "Some(..)"))
            .field("detector", &self.detector.as_ref().map(|_| "Some(..)"))
            .field("batch_size", &self.batch_size)
            .field("flush_interval_ms", &self.flush_interval_ms)
            .finish()
    }
}

/// 主 agent 注入回调（把归因摘要作为注入消息塞进会话）
///
/// 语义（§3.3 第 3 点 / §3.5.3）：注入文本已由装配层按聚合报告生成
/// （[build_escape_injection_text]），回调只负责落环（壳层实现走
/// followUp 环，D8：run 内不注入，run idle promote 后成为下一条用户
/// 消息——主 agent 下一轮即可看到）。
pub trait EscapeWatchInjector: Send + Sync {
    /// 注入一条归因摘要文本
    fn inject(&self, text: &str);
}

/// 单路径聚合态（同路径多事件只保留首条 + 更新末时刻）
#[derive(Debug, Clone)]
struct AggregatedPath {
    /// 首条事件（聚合清单以首现事件为骨架）
    first: FileChangeEvent,
    /// 末次事件时刻（时间窗终点推进用）
    last_occurred_at_ms: i64,
}

/// 聚合器纯逻辑（同 run 同路径去重 + 时间窗字段 + 破坏性标记）
///
/// - 同路径去重：首条事件保留，后续仅推进末时刻（§3.3「同 run 同路径
///   聚合为一条」）；
/// - 批阈值限流由消费循环承担（[consume_loop]：路径数达
///   [EscapeWatchConfig::batch_size] 即取报告发射），本类型保持纯聚合
///   （不携带发射策略）；
/// - 时间窗字段：first_occurred_at_ms / last_occurred_at_ms 对齐
///   [UndeclaredWrite] wire 契约（§3.2）；
/// - 破坏性标记：含删除/改名类变更 → has_destructive（高风险着色）。
#[derive(Debug, Default)]
pub struct EscapeAggregator {
    /// 会话标识（报告信封）
    session_id: String,
    /// run 标识（报告信封）
    run_id: String,
    /// 路径 → 聚合态（同路径去重表）
    paths: HashMap<PathBuf, AggregatedPath>,
    /// 路径出现顺序（首事件排序稳定，聚合清单按此输出）
    order: Vec<PathBuf>,
    /// 时间窗起点（首事件时刻）
    first_ms: i64,
    /// 时间窗终点（末事件时刻）
    last_ms: i64,
    /// 是否含删除/改名类变更（高风险标记）
    has_destructive: bool,
}

impl EscapeAggregator {
    /// 新建聚合器（会话/run 标识注入报告）
    pub fn new(session_id: impl Into<String>, run_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            run_id: run_id.into(),
            paths: HashMap::new(),
            order: Vec::new(),
            first_ms: 0,
            last_ms: 0,
            has_destructive: false,
        }
    }

    /// 当前聚合路径数
    pub fn len(&self) -> usize {
        self.paths.len()
    }

    /// 是否无待报聚合
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// 聚合单条事件（同路径再次到达只推进末时刻与时间窗终点，不新增
    /// 聚合项——同 run 同路径去重语义）；批阈值检查由消费循环承担
    pub fn push(&mut self, ev: &FileChangeEvent) {
        match self.paths.get_mut(&ev.path) {
            Some(entry) => {
                // 同路径：仅更新末时刻（首条事件保留为聚合骨架）
                entry.last_occurred_at_ms = ev.occurred_at_ms;
            }
            None => {
                self.paths.insert(
                    ev.path.clone(),
                    AggregatedPath {
                        first: ev.clone(),
                        last_occurred_at_ms: ev.occurred_at_ms,
                    },
                );
                self.order.push(ev.path.clone());
                // 首事件时刻 = 时间窗起点
                if self.first_ms == 0 {
                    self.first_ms = ev.occurred_at_ms;
                }
            }
        }
        // 时间窗终点推进（去重后仍推进）
        self.last_ms = self.last_ms.max(ev.occurred_at_ms);
        // 破坏性标记：删除 / 改名类变更（供 UI 高风险着色）
        if matches!(ev.kind, ChangeKind::Removed | ChangeKind::Renamed) {
            self.has_destructive = true;
        }
    }

    /// 取走当前全部聚合（时间窗到期 / run 收口），重置为空；无待报
    /// 聚合时返回 None
    pub fn take_report(&mut self) -> Option<UndeclaredWrite> {
        if self.paths.is_empty() {
            return None;
        }
        let report = self.build_report();
        self.reset();
        Some(report)
    }

    /// 构造 [UndeclaredWrite] 归因报告（wire 形状，§3.2）
    fn build_report(&self) -> UndeclaredWrite {
        let changes: Vec<FileChangeEvent> = self
            .order
            .iter()
            .filter_map(|p| self.paths.get(p).map(|entry| entry.first.clone()))
            .collect();
        UndeclaredWrite {
            session_id: self.session_id.clone(),
            run_id: self.run_id.clone(),
            changes,
            first_occurred_at_ms: self.first_ms,
            last_occurred_at_ms: self.last_ms,
            file_count: self.paths.len(),
            has_destructive: self.has_destructive,
        }
    }

    /// 重置聚合状态（取走报告后清空）
    fn reset(&mut self) {
        self.paths.clear();
        self.order.clear();
        self.first_ms = 0;
        self.last_ms = 0;
        self.has_destructive = false;
    }
}

/// 逃逸监视运行句柄（run 收口调用 [Self::shutdown]；Drop 兜底停止）
pub struct EscapeWatchHandle {
    /// 监视句柄（Drop 即停止监视，兜底路径；shutdown 先 stop 再 drop）
    watcher: Option<WorkspaceWatcher>,
    /// 消费任务（通道关闭后自然收口 flush 剩余聚合）
    task: Option<tokio::task::JoinHandle<()>>,
}

impl EscapeWatchHandle {
    /// run 收口：停止监视（解注册 + flush 待配对删除）→ 销毁监视句柄
    /// （关闭事件通道）→ 等待消费任务收口（剩余事件聚合补发最后一条
    /// 报告）。正常路径必调（completed / failed / cancelled 共用）。
    pub async fn shutdown(&mut self) {
        if let Some(mut watcher) = self.watcher.take() {
            watcher.stop();
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for EscapeWatchHandle {
    /// Drop 兜底（§5.4「run 中崩溃」缓解）：监视句柄销毁即停止 notify
    /// 回调，事件通道关闭后消费任务经 [consume_loop] 收口 flush 剩余
    /// 聚合——run 崩溃路径亦不泄漏监视任务。
    fn drop(&mut self) {
        self.watcher.take();
    }
}

/// 静态排除清单（REQ-逃逸追踪分析 §3.4：排除表）
///
/// 构建产物与依赖目录（任意层级命中，WatcherState 组件级前缀匹配）、
/// git 内部对象、回收站根——这些是 run 期间高频合法写，排除后大幅
/// 降噪（E13 主体与 backup 域）。
pub fn escape_exclude_paths() -> Vec<PathBuf> {
    [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        "coverage",
        ".next",
        "__pycache__",
        ".venv",
        ".crish-trash",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

/// 启动逃逸监视（run 启动钩子一步到位）
///
/// 1. 监视根校验 + 静态排除清单（[escape_exclude_paths]）→
///    [WorkspaceWatcher::start]（T-ESC-01 数据面）；
/// 2. 消费任务 spawn（[consume_loop]：聚合 → 限流发射）。
///
/// `config.root` 与监视根强一致（本函数统一覆写，防调用方漂移）。
/// 失败返回错误文案（监视是追踪面，壳层失败仅告警不阻断 run）。
pub fn spawn_escape_watch(
    root: impl Into<PathBuf>,
    config: EscapeWatchConfig,
) -> Result<EscapeWatchHandle, String> {
    let root = root.into();
    let mut config = config;
    config.root = root.clone();
    let exclude = escape_exclude_paths();
    let (watcher, rx) =
        WorkspaceWatcher::start(root, exclude).map_err(|e| format!("watcher 启动失败：{e}"))?;
    Ok(spawn_escape_watch_consumer(watcher, rx, config))
}

/// 启动逃逸监视消费任务（watcher.start 之后调用；组合入口见
/// [spawn_escape_watch]）
pub fn spawn_escape_watch_consumer(
    watcher: WorkspaceWatcher,
    rx: tokio::sync::mpsc::Receiver<FileChangeEvent>,
    config: EscapeWatchConfig,
) -> EscapeWatchHandle {
    let task = tokio::spawn(consume_loop(rx, config));
    EscapeWatchHandle {
        watcher: Some(watcher),
        task: Some(task),
    }
}

/// 消费循环主体（run 期间独立任务）
///
/// 事件流 → 判定器（声明覆盖跳过；None = 全部视为未声明，第二来源
/// 兜底）→ 聚合 → 限流发射（批阈值 / 时间窗双限流，粒度 = 聚合报告）
/// → 通道关闭（run 收口，[EscapeWatchHandle::shutdown]）→ 收口 flush
/// 剩余聚合（聚合补发最后一条报告，§3.5.1「随后 flush 剩余未上报
/// 事件」）。
async fn consume_loop(
    mut rx: tokio::sync::mpsc::Receiver<FileChangeEvent>,
    config: EscapeWatchConfig,
) {
    let mut aggregator = EscapeAggregator::new(&config.session_id, &config.run_id);
    let mut last_emit = Instant::now();
    while let Some(ev) = rx.recv().await {
        // 判定器：声明覆盖的事件静默跳过（不落入归因）；未接线
        // （detector 为 None）时仅依赖监视事件直接发射——本轮第二来源
        // 兜底语义（write_claims 未装配）
        if config
            .detector
            .as_deref()
            .map(|d| d.is_declared(&ev))
            .unwrap_or(false)
        {
            continue;
        }
        // 时间窗限流：距上次发射超窗且有待报聚合 → 先发射一批（低频
        // 事件不长时间静默；实时性粒度 = 时间窗）
        if last_emit.elapsed() >= Duration::from_millis(config.flush_interval_ms)
            && !aggregator.is_empty()
        {
            if let Some(report) = aggregator.take_report() {
                emit_report(&config, &report);
            }
            last_emit = Instant::now();
        }
        // 批阈值限流：路径数达标即时产出（防风暴刷屏）
        aggregator.push(&ev);
        if aggregator.len() >= config.batch_size {
            if let Some(report) = aggregator.take_report() {
                emit_report(&config, &report);
            }
            last_emit = Instant::now();
        }
    }
    // run 收口 flush：剩余聚合补发最后一条报告（遗留事件兜底）
    if let Some(report) = aggregator.take_report() {
        emit_report(&config, &report);
    }
}

/// 发射一条归因报告（审计 + 注入双通道；限流粒度 = 聚合报告本身）
fn emit_report(config: &EscapeWatchConfig, report: &UndeclaredWrite) {
    // 审计通道（§3.3）：operation=undeclared-write、targets=变更路径
    // （绝对路径，与 delete/shell 审计惯例一致）、decision=denied
    // （「非引擎批准路径的操作」语义）、tool_call_id=None（工具外）
    let targets: Vec<String> = report
        .changes
        .iter()
        .map(|c| c.path.display().to_string())
        .collect();
    config.audit_sink.emit(&security_audit_event(
        &report.session_id,
        SecurityAuditOperation::UndeclaredWrite,
        targets,
        impact_for(report),
        SecurityAuditDecision::Denied,
        None,
    ));
    // 主 agent 注入通道（限流同 run 聚合：一条报告 = 一条注入）
    if let Some(injector) = &config.injector {
        injector.inject(&build_escape_injection_text(report, &config.root));
    }
}

/// 归因报告 → 影响面载荷（file_count 承载聚合数；跨目录与谨慎标记
/// 按变更清单计算；大小/目录数为 0——监视事件无字节级信息，诚实兜底）
fn impact_for(report: &UndeclaredWrite) -> ImpactAssessment {
    let parents: HashSet<Option<&Path>> =
        report.changes.iter().map(|c| c.path.parent()).collect();
    ImpactAssessment {
        file_count: report.file_count as u64,
        total_size_bytes: 0,
        directory_count: 0,
        cross_directory: parents.len() > 1,
        flagged: report.file_count as u64 > IMPACT_FLAG_FILE_THRESHOLD,
    }
}

/// 归因摘要注入文案（§3.3 第 3 点）
///
/// 单路径：「检测到工具外写入：src/x.ts（run r12 期间）」；
/// 多路径摘要（>3 条路径降级为「等 N 个文件」汇总，防刷屏）：
/// 「检测到工具外写入：src/a.ts、src/b.ts、src/c.ts 等 5 个文件
/// （run r12 期间）」。路径相对 `root` 显示（与 REQ 文案示例一致）。
pub fn build_escape_injection_text(report: &UndeclaredWrite, root: &Path) -> String {
    let rel_paths: Vec<String> = report
        .changes
        .iter()
        .map(|c| {
            c.path
                .strip_prefix(root)
                .unwrap_or(&c.path)
                .display()
                .to_string()
        })
        .collect();
    let path_part = if rel_paths.len() <= 3 {
        rel_paths.join("、")
    } else {
        format!("{} 等 {} 个文件", rel_paths[..3].join("、"), rel_paths.len())
    };
    format!("检测到工具外写入：{path_part}（run {} 期间）", report.run_id)
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use agent_tools::audit::RecordingAuditSink;
    use conex_test_utils::TempWorkspace;

    /// 记录型注入回调（测试断言注入文案用）
    #[derive(Debug, Default)]
    struct RecordingInjector {
        texts: std::sync::Mutex<Vec<String>>,
    }

    impl EscapeWatchInjector for RecordingInjector {
        fn inject(&self, text: &str) {
            self.texts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(text.to_string());
        }
    }

    impl RecordingInjector {
        fn texts(&self) -> Vec<String> {
            self.texts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    /// 测试事件构造（occurred_at_ms 递增）
    fn event_at(rel: &str, ws: &TempWorkspace, ms: i64) -> FileChangeEvent {
        FileChangeEvent {
            path: ws.path().join(rel),
            kind: ChangeKind::Created,
            from: None,
            occurred_at_ms: ms,
        }
    }

    /// 测试配置：大批阈值 + 长时间窗（聚合仅在收口 flush 时产出，
    /// 断言确定性强）
    fn settle_config(ws: &TempWorkspace, sink: AuditSink, run_id: &str) -> EscapeWatchConfig {
        EscapeWatchConfig::new(ws.path(), "s1", run_id, sink).with_limits(100, 60_000)
    }

    // ── 聚合器纯逻辑 ─────────────────────────────────────────────

    /// 同路径去重：多次写入同一路径只聚合为一条（同 run 同路径聚合）
    #[test]
    fn aggregator_dedups_same_path() {
        let ws = TempWorkspace::new("esc_agg_dedup");
        let mut agg = EscapeAggregator::new("s1", "r1");
        ws.write_file("a.txt", "x");

        agg.push(&event_at("a.txt", &ws, 1000));
        agg.push(&event_at("a.txt", &ws, 2000));
        assert_eq!(agg.len(), 1, "同路径去重后仍为 1 条");

        let report = agg.take_report().expect("有聚合必有报告");
        assert_eq!(report.file_count, 1);
        assert_eq!(report.changes.len(), 1);
        assert_eq!(report.first_occurred_at_ms, 1000, "时间窗起点为首事件");
        assert_eq!(report.last_occurred_at_ms, 2000, "时间窗终点推进到末事件");
        assert!(!report.has_destructive);
    }

    /// 取报告语义：路径数达阈值时消费循环取走（本测试模拟该策略）；
    /// 产出后重置
    #[test]
    fn aggregator_batch_limit_produces_report() {
        let ws = TempWorkspace::new("esc_agg_batch");
        let mut agg = EscapeAggregator::new("s1", "r1");

        agg.push(&event_at("a.txt", &ws, 1));
        agg.push(&event_at("b.txt", &ws, 2));
        agg.push(&event_at("c.txt", &ws, 3));
        assert_eq!(agg.len(), 3);
        let report = agg.take_report().expect("批满即产出");
        assert_eq!(report.file_count, 3);
        assert_eq!(report.changes.len(), 3);
        assert!(agg.is_empty(), "产出后重置");

        // 后续事件进入下一批
        agg.push(&event_at("d.txt", &ws, 4));
        assert_eq!(agg.len(), 1);
        let report = agg.take_report().expect("剩余聚合可取");
        assert_eq!(report.file_count, 1);
    }

    /// 聚合清单顺序 = 首现顺序；take_report 空聚合返回 None
    #[test]
    fn aggregator_order_and_empty_take() {
        let ws = TempWorkspace::new("esc_agg_order");
        let mut agg = EscapeAggregator::new("s1", "r1");
        assert!(agg.take_report().is_none(), "空聚合取报告返回 None");

        agg.push(&event_at("b.txt", &ws, 1));
        agg.push(&event_at("a.txt", &ws, 2));
        let report = agg.take_report().expect("有聚合必有报告");
        let paths: Vec<String> = report.changes.iter().map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(paths, vec!["b.txt", "a.txt"], "按首现顺序输出");
    }

    /// 破坏性标记：删除/改名类变更置 has_destructive（高风险着色）
    #[test]
    fn aggregator_marks_destructive() {
        let ws = TempWorkspace::new("esc_agg_destr");
        let mut agg = EscapeAggregator::new("s1", "r1");
        agg.push(&event_at("a.txt", &ws, 1));
        assert!(!agg.take_report().expect("报告").has_destructive, "纯新建非破坏性");

        agg.push(&FileChangeEvent {
            path: ws.path().join("a.txt"),
            kind: ChangeKind::Removed,
            from: None,
            occurred_at_ms: 2,
        });
        let report = agg.take_report().expect("报告");
        assert!(report.has_destructive, "删除类变更必须置破坏性标记");
    }

    /// 注入文案：单路径相对展示 + 多路径摘要（>3 降级汇总）
    #[test]
    fn injection_text_single_and_summary() {
        let ws = TempWorkspace::new("esc_text");
        let mut agg = EscapeAggregator::new("s1", "r12");
        agg.push(&event_at("src/x.ts", &ws, 1));
        let report = agg.take_report().expect("报告");
        let text = build_escape_injection_text(&report, ws.path());
        assert_eq!(text, "检测到工具外写入：src/x.ts（run r12 期间）");

        let mut agg = EscapeAggregator::new("s1", "r12");
        for (i, rel) in ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]
            .iter()
            .enumerate()
        {
            agg.push(&event_at(rel, &ws, i as i64 + 1));
        }
        let report = agg.take_report().expect("报告");
        let text = build_escape_injection_text(&report, ws.path());
        assert!(
            text.contains("等 5 个文件"),
            "超 3 条路径降级为摘要：{text}"
        );
        assert!(text.starts_with("检测到工具外写入：src/a.ts、src/b.ts、src/c.ts"));
        assert!(text.contains("（run r12 期间）"));
    }

    // ── 集成：真实 watcher + 消费循环 + 审计/注入双通道 ──────────

    /// 集成测试：run 内写文件 → 收口后 sink 收到一条
    /// operation=undeclared-write、targets 含路径、decision=denied 的
    /// 审计事件（对齐 REQ-逃逸追踪分析 §5.3 审计集成锚点）
    #[tokio::test]
    async fn consume_emits_undeclared_write_audit() {
        let ws = TempWorkspace::new("esc_int_audit");
        let sink = Arc::new(RecordingAuditSink::new());
        let injector = Arc::new(RecordingInjector::default());
        let config = settle_config(&ws, Arc::clone(&sink) as AuditSink, "r-int-1")
            .with_injector(Arc::clone(&injector) as Arc<dyn EscapeWatchInjector>);
        let mut handle = spawn_escape_watch(ws.path(), config).expect("监视启动成功");

        // run 期间工具外写入
        ws.write_file("src/escape.js", "process.exit(0)");
        // 等 notify 事件到达消费任务（异步回调，轮询注入/审计前置条件
        // 不可得——以固定等待 + 收口 flush 保证确定）
        tokio::time::sleep(Duration::from_millis(400)).await;

        handle.shutdown().await;

        let events = sink.emitted();
        assert_eq!(events.len(), 1, "收口 flush 应发射一条审计事件：{events:?}");
        match &events[0] {
            conex_types::AgentEvent::SecurityAudit {
                operation,
                targets,
                impact,
                decision,
                tool_call_id,
                ..
            } => {
                assert_eq!(operation, &SecurityAuditOperation::UndeclaredWrite);
                // 路径比较归一化：Windows 上事件路径为 `\` 分隔，join 入参
                // 可能带 `/`；统一分隔符 + 大小写折叠后比较
                let norm = |s: &str| s.replace('/', "\\").to_lowercase();
                assert!(
                    targets.iter().any(|t| {
                        norm(t) == norm(&ws.path().join("src/escape.js").display().to_string())
                    }),
                    "targets 应含变更文件路径（Windows 上可能附带父目录事件）：{targets:?}"
                );
                assert_eq!(decision, &SecurityAuditDecision::Denied);
                assert!(impact.file_count >= 1, "file_count 至少为变更文件数");
                assert_eq!(tool_call_id, &None, "工具外写入无工具调用 id");
            }
            other => panic!("应为 security-audit，实际 {}", other.type_name()),
        }
        // 注入通道：一条报告 = 一条注入（文案含路径与 run 标识；
        // 路径分隔符平台相关，按文件尾名断言）
        let texts = injector.texts();
        assert_eq!(texts.len(), 1, "聚合报告对应一条注入");
        assert!(
            texts[0].contains("escape.js") && texts[0].contains("r-int-1"),
            "注入文案应含路径与 run 标识：{}",
            texts[0]
        );
    }

    /// 聚合限流：同 run 多路径 → 收口聚合为一条摘要（防刷屏）
    #[tokio::test]
    async fn consume_aggregates_multi_path_to_single_report() {
        let ws = TempWorkspace::new("esc_int_multi");
        let sink = Arc::new(RecordingAuditSink::new());
        let config = settle_config(&ws, Arc::clone(&sink) as AuditSink, "r-int-2");
        let mut handle = spawn_escape_watch(ws.path(), config).expect("监视启动成功");

        for rel in ["a.txt", "b.txt", "c.txt", "d.txt"] {
            ws.write_file(rel, "x");
        }
        tokio::time::sleep(Duration::from_millis(400)).await;

        handle.shutdown().await;

        let events = sink.emitted();
        assert_eq!(events.len(), 1, "多路径必须聚合为一条摘要：{events:?}");
        match &events[0] {
            conex_types::AgentEvent::SecurityAudit {
                targets, impact, ..
            } => {
                assert_eq!(targets.len(), 4, "targets 承载全部变更路径");
                for rel in ["a.txt", "b.txt", "c.txt", "d.txt"] {
                    assert!(
                        targets.contains(&ws.path().join(rel).display().to_string()),
                        "targets 应含 {rel}"
                    );
                }
                assert_eq!(impact.file_count, 4);
            }
            other => panic!("应为 security-audit，实际 {}", other.type_name()),
        }
    }

    /// 批阈值限流：多路径超阈值按批分割为多条报告（notify 事件乱序/
    /// 重复到达时同路径可能跨批再现——同路径去重粒度 = 批内；断言
    /// 不依赖到达顺序）
    #[tokio::test]
    async fn consume_batch_limit_splits_reports() {
        let ws = TempWorkspace::new("esc_int_batch");
        let sink = Arc::new(RecordingAuditSink::new());
        let config = EscapeWatchConfig::new(ws.path(), "s1", "r-int-3", Arc::clone(&sink) as AuditSink)
            .with_limits(2, 60_000);
        let mut handle = spawn_escape_watch(ws.path(), config).expect("监视启动成功");

        for rel in ["a.txt", "b.txt", "c.txt"] {
            ws.write_file(rel, "x");
        }
        tokio::time::sleep(Duration::from_millis(400)).await;

        handle.shutdown().await;

        let events = sink.emitted();
        assert!(
            events.len() >= 2,
            "3 路径按批阈值 2 应分割为多条报告：{events:?}"
        );
        // 全部变更路径必须被覆盖（跨批分割不丢路径）
        let covered: Vec<String> = events
            .iter()
            .flat_map(|e| match e {
                conex_types::AgentEvent::SecurityAudit { targets, .. } => targets.clone(),
                _ => Vec::new(),
            })
            .collect();
        for rel in ["a.txt", "b.txt", "c.txt"] {
            assert!(
                covered.contains(&ws.path().join(rel).display().to_string()),
                "分割不得丢路径 {rel}：{covered:?}"
            );
        }
        // 每条报告路径数 ≤ 批阈值（防刷屏粒度）
        for e in &events {
            if let conex_types::AgentEvent::SecurityAudit { impact, .. } = e {
                assert!(impact.file_count <= 2, "单条报告路径数不得超过批阈值");
            }
        }
    }

    /// 停止后无事件：shutdown 后写文件不产任何新审计事件
    #[tokio::test]
    async fn consume_stopped_produces_no_events() {
        let ws = TempWorkspace::new("esc_int_stop");
        let sink = Arc::new(RecordingAuditSink::new());
        let config = settle_config(&ws, Arc::clone(&sink) as AuditSink, "r-int-4");
        let mut handle = spawn_escape_watch(ws.path(), config).expect("监视启动成功");

        ws.write_file("before.txt", "x");
        tokio::time::sleep(Duration::from_millis(300)).await;
        handle.shutdown().await;
        assert_eq!(sink.emitted().len(), 1, "收口 flush 补发 run 内事件");

        // 停止后写入：不应有任何新事件
        ws.write_file("after.txt", "x");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(sink.emitted().len(), 1, "停止后必须无事件");
    }

    /// 判定器跳过：声明覆盖的事件不落入归因（静默）
    #[tokio::test]
    async fn consume_skips_declared_events() {
        let ws = TempWorkspace::new("esc_int_declared");
        let sink = Arc::new(RecordingAuditSink::new());
        // 判定器：一切事件视为已声明（模拟 write_claims 覆盖命中）
        struct EverythingDeclared;
        impl UndeclaredWriteDetector for EverythingDeclared {
            fn is_declared(&self, _event: &FileChangeEvent) -> bool {
                true
            }
        }
        let config = settle_config(&ws, Arc::clone(&sink) as AuditSink, "r-int-5")
            .with_detector(Arc::new(EverythingDeclared));
        let mut handle = spawn_escape_watch(ws.path(), config).expect("监视启动成功");

        ws.write_file("declared.txt", "x");
        tokio::time::sleep(Duration::from_millis(300)).await;
        handle.shutdown().await;

        assert!(sink.emitted().is_empty(), "声明覆盖事件必须静默：{:?}", sink.emitted());
    }

    /// 静态排除清单：排除目录（node_modules/target）内写入不产事件
    #[tokio::test]
    async fn consume_excluded_dir_produces_no_events() {
        let ws = TempWorkspace::new("esc_int_excl");
        let sink = Arc::new(RecordingAuditSink::new());
        let config = settle_config(&ws, Arc::clone(&sink) as AuditSink, "r-int-6");
        let mut handle = spawn_escape_watch(ws.path(), config).expect("监视启动成功");

        ws.write_file("node_modules/pkg/index.js", "x");
        ws.write_file("target/debug/build/app", "x");
        tokio::time::sleep(Duration::from_millis(400)).await;
        handle.shutdown().await;

        assert!(sink.emitted().is_empty(), "排除目录必须不产事件：{:?}", sink.emitted());
    }

    /// 排除清单内容对齐 REQ §3.4（静态排除表）
    #[test]
    fn exclude_paths_cover_docs_table() {
        let excludes = escape_exclude_paths();
        for expected in [
            ".git",
            "node_modules",
            "target",
            "dist",
            "build",
            "coverage",
            ".next",
            "__pycache__",
            ".venv",
            ".crish-trash",
        ] {
            assert!(
                excludes.contains(&PathBuf::from(expected)),
                "排除清单缺 {expected}"
            );
        }
    }

    /// 时间窗字段语义：同路径推进 last_occurred_at_ms（已在去重用例
    /// 断言）；首事件时刻不随去重推进（追加断言）
    #[test]
    fn aggregator_first_ms_fixed_on_first_event() {
        let ws = TempWorkspace::new("esc_agg_first");
        let mut agg = EscapeAggregator::new("s1", "r1");
        agg.push(&event_at("a.txt", &ws, 100));
        agg.push(&event_at("a.txt", &ws, 300));
        agg.push(&event_at("b.txt", &ws, 500));
        let report = agg.take_report().expect("报告");
        assert_eq!(report.first_occurred_at_ms, 100, "时间窗起点固定在首事件");
        assert_eq!(report.last_occurred_at_ms, 500, "时间窗终点推进到末事件");
        assert_eq!(report.changes.len(), 2, "同路径去重 + 独立路径");
    }
}
