//! SR-05 · 测试外置 · ≠ EL（资源监视域旁挂）：T-AB-15 资源采集原语 +
//! T-AB-16 健康判定三态与通知 + 34 方案 §2.3 采样循环置位 suspicious。
//! 本文件自 fdb512d4^（拆分前 background.rs `mod tests`）原样重建，
//! 断言零改动；接线：background.rs
//! `#[cfg(test)] #[path = "background_tests_resource.rs"] mod tests_resource;`，
//! helper 经 `use super::tests::*;` 共享（background_tests.rs）。
//! 可见性适配（SR-05 同型最小改动）：[adopt_request_monitored] 提为
//! pub(crate)——events 域（task_seven_events / task_failed 用例）复用。

// G2 禁令豁免：
// - 测试临时目录清理（非产品删除路径，可恢复语义不适用）；
// - 测试 mod 子进程拉起面：真实 spawn 探测（红线 Blocked 断言 +
//   tasklist / kill -0 存活探测辅助，T-AB-06/07 验收），非产品执行面；
//   测试 mod 内 allow + 理由（裁决 D8 背书）。
#![allow(clippy::disallowed_methods)]
use super::tests::*;
use super::*;
use crate::resource::ProcessHealth;
pub(crate) use super::bg_events::SuspiciousDebounce;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::Child;

/// 短周期测试注册表（资源段专用）：500ms 采样 / 2s 静默阈值 + 通知队列注入；
/// 采样源为真实 [crate::resource::sample_usage]（resource_* 验收用）。
/// 返回 (registry, queue)。
fn resource_test_registry() -> (Arc<BackgroundTaskRegistry>, Arc<Mutex<VecDeque<String>>>) {
    let (queue, sampler) = (
        Arc::new(Mutex::new(VecDeque::new())),
        Arc::new(sample_usage),
    );
    resource_test_registry_with_sampler(queue, sampler)
}

/// 短周期测试注册表 + 采样源替身注入（健康类测试用）：500ms 采样 / 2s
/// 静默阈值 + 通知队列注入 + 自定义采样源。
/// 返回 (registry, queue)。
fn resource_test_registry_with_sampler(
    queue: Arc<Mutex<VecDeque<String>>>,
    sampler: SamplerFn,
) -> (Arc<BackgroundTaskRegistry>, Arc<Mutex<VecDeque<String>>>) {
    let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("crish-bg-resource-{}-{seq}", std::process::id()));
    let registry = BackgroundTaskRegistry::with_resource_monitor(
        root,
        Duration::from_secs(30 * 60),
        MAX_BACKGROUND_TASKS,
        ResourceMonitorConfig {
            sample_interval_ms: 500,
            silence_threshold_ms: 2000,
        },
        TaskNotifier::with_nudge_queue(Arc::clone(&queue)),
        sampler,
    );
    (registry, queue)
}

/// 静默采样替身：CPU 累计恒定（差值恒 0%）——模拟无 CPU 消耗的静默任务，
/// 判定输入确定性可控（不受共享 daemon Job 的并行测试污染，见 [SamplerFn]）。
fn silent_sampler() -> SamplerFn {
    Arc::new(|_pid| {
        Ok::<RawUsage, String>(RawUsage {
            cpu_ms: 1000,
            rss_bytes: 4096,
        })
    })
}

/// 脚本化采样替身：静默恒定 → 第 `spike_at` 次采样注入一次 CPU 尖峰
/// （+300ms，2s 窗口下 60% ≫ 活跃阈值 1%）→ 恢复静默。用于确定性复现
/// 「Suspicious 保持期被 CPU 抖动打断 → 恢复 Healthy 重置防抖 → 再次
/// Suspicious 重新通知」的合法重复通知场景（T-AB-16 2 语义）。
fn spiking_sampler(spike_at: u64) -> SamplerFn {
    let n = Arc::new(AtomicU64::new(0));
    let n2 = Arc::clone(&n);
    Arc::new(move |_pid| {
        let i = n2.fetch_add(1, Ordering::Relaxed);
        let cpu_ms = if i == spike_at { 1300 } else { 1000 };
        Ok::<RawUsage, String>(RawUsage {
            cpu_ms,
            rss_bytes: 4096,
        })
    })
}

/// 启用 resourceMonitor 的 adopt 请求（T-AB-15 验收用）。
pub(crate) fn adopt_request_monitored(
    child: Child,
    command: &str,
    cwd: &Path,
) -> BackgroundAdoptRequest {
    let mut req = adopt_request(child, command, cwd, false, None);
    req.resource_monitor = true;
    req
}

/// 验收：启用 resourceMonitor 的真实长跑任务——采样后 `status().resource`
/// 非空且 `cpu_percent ∈ [0,100]`、`rss_bytes > 0`、快照内 `last_output_at_ms`
/// 与 status 一致且随输出更新。
///
/// 采样口径：首拍建基线（丢弃），第二拍起产生有效采样（本测试轮询等待
/// resource 非空——首采样丢弃语义的集成断言由 resource_first_sample_dropped
/// 单元覆盖）。
#[tokio::test]
async fn resource_sample_collected() {
    let (registry, _queue) = resource_test_registry();
    let child = spawn_test_child(OUTPUT_COMMAND);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "resource-sample",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 轮询等待第一份有效采样（窗口 20s：首拍丢弃 + 500ms 周期 + 输出命令 4s）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let first_output_at = loop {
        let status = registry.status(&task_id).await.expect("status");
        if let Some(res) = &status.resource {
            assert!(
                res.cpu_percent.is_finite(),
                "cpu_percent 必须为有限值：{}",
                res.cpu_percent
            );
            assert!(
                (0.0..=100.0).contains(&res.cpu_percent),
                "cpu_percent 应在 [0,100]：{}",
                res.cpu_percent
            );
            assert!(res.rss_bytes > 0, "rss_bytes 应 > 0：{}", res.rss_bytes);
            assert_eq!(
                res.last_output_at_ms, status.last_output_at_ms,
                "快照内 last_output_at_ms 与 status 一致（事件驱动刷新）"
            );
            break res.last_output_at_ms;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "采样迟迟未生效（首采样丢弃后应有有效采样）"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };

    // last_output_at_ms 随输出更新：输出命令持续产出，再等一拍后应增长
    tokio::time::sleep(Duration::from_millis(700)).await;
    let status = registry.status(&task_id).await.expect("status");
    assert!(
        status.last_output_at_ms >= first_output_at,
        "last_output_at_ms 应随输出单调更新：{first_output_at} -> {}",
        status.last_output_at_ms
    );

    // 清理
    let _ = registry.kill(&task_id).await;
}

/// 验收：首采样无基线不产生无效值（cpu_percent 不出现 NaN/异常值）——
/// 单元断言差值语义（零差值 → 0.0、墙钟零差值不除零、差值回退 clamp 0）；
/// 真实任务路径的「首拍仅建基线」由 resource_sample_collected 的首份
/// 采样有效性断言覆盖。
#[test]
fn resource_first_sample_dropped() {
    let prev = RawUsage {
        cpu_ms: 1000,
        rss_bytes: 4096,
    };
    // 首采样基线自身不产生差值（零差值 → 0.0 而非 NaN）
    let same = RawUsage {
        cpu_ms: 1000,
        rss_bytes: 4096,
    };
    let pct = cpu_percent_from_delta(&prev, &same, 1_000, 3_000);
    assert!(
        pct.is_finite() && pct >= 0.0 && pct <= 100.0,
        "零差值不得出 NaN：{pct}"
    );
    // 墙钟零差值：不除零
    assert_eq!(cpu_percent_from_delta(&prev, &same, 3_000, 3_000), 0.0);
    // 差值回退（进程 CPU 时间非单调的防御）：clamp 0
    let lower = RawUsage {
        cpu_ms: 800,
        rss_bytes: 4096,
    };
    assert_eq!(cpu_percent_from_delta(&prev, &lower, 1_000, 3_000), 0.0);
    // 正常差值：500ms CPU / 2s 墙钟 = 25%
    let busy = RawUsage {
        cpu_ms: 1500,
        rss_bytes: 4096,
    };
    assert_eq!(cpu_percent_from_delta(&prev, &busy, 1_000, 3_000), 25.0);
}

/// 验收：`.samples.jsonl` 内容为合法 JSONL 且条数随时间增长
/// （复用 append_jsonl_lines 落盘，perf/jsonl.rs:49-72）。
#[tokio::test]
async fn resource_samples_persisted() {
    let (registry, _queue) = resource_test_registry();
    // 用 20s 持续输出命令（而非 ~4s 的 OUTPUT_COMMAND）：采样循环在任务
    // 终态即停止（见 spawn_resource_monitor_loop）——「条数随时间增长」
    // 断言要求第二次读取时任务仍存活，短命令在负载下可能早于第二次
    // 读取自然完成（计数停涨）而误报
    let child = spawn_test_child(LOG_KILL_COMMAND);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "resource-persist",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();
    let samples_path = {
        let status = registry.status(&task_id).await.expect("status");
        PathBuf::from(status.log_path).with_extension("samples.jsonl")
    };

    // 轮询等待至少 2 条采样（首拍丢弃 → 第二拍起写盘）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let first_count = loop {
        if samples_path.exists() {
            let raw = std::fs::read_to_string(&samples_path).expect("读 samples");
            let lines: Vec<&str> = raw.lines().filter(|l| !l.is_empty()).collect();
            if lines.len() >= 2 {
                // 逐行合法 JSON + 冻结字段形状（camelCase）
                for line in &lines {
                    let v: serde_json::Value =
                        serde_json::from_str(line).expect("每行必须为合法 JSON");
                    for key in [
                        "sampledAtMs",
                        "cpuPercent",
                        "rssBytes",
                        "lastOutputAtMs",
                        "ioReadBytes",
                        "ioWriteBytes",
                    ] {
                        assert!(v.get(key).is_some(), "采样缺字段 {key}: {v}");
                    }
                    assert_eq!(v["ioReadBytes"], 0, "I/O 首版恒 0（诚实边界）");
                    assert_eq!(v["ioWriteBytes"], 0, "I/O 首版恒 0（诚实边界）");
                }
                break lines.len();
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "samples.jsonl 迟迟未累积（首采样丢弃后应持续写盘）"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };

    // 条数随时间增长（F-009 flaky 根因同族：固定 sleep(1000) 在负载
    // 下采样循环可能未达 2 拍 → 改轮询观测状态，8s 上限充足）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let second_count = loop {
        let raw = std::fs::read_to_string(&samples_path).expect("读 samples");
        let count = raw.lines().filter(|l| !l.is_empty()).count();
        if count > first_count {
            break count;
        }
        assert!(tokio::time::Instant::now() < deadline, "采样条数迟迟不增长");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(
        second_count > first_count,
        "采样条数应随时间增长：{first_count} -> {second_count}"
    );

    // 清理
    let _ = registry.kill(&task_id).await;
}

/// 验收：未启用 resourceMonitor 的任务 `resource: None` 且不落盘
/// `.samples.jsonl`（采样 loop 未挂载）。
#[tokio::test]
async fn resource_disabled_none() {
    let (registry, _queue) = resource_test_registry();
    let child = spawn_test_child(LONG_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "resource-disabled",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 等几拍采样周期（若误挂载采样则此时应已落盘/置位）
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let status = registry.status(&task_id).await.expect("status");
    assert!(
        status.resource.is_none(),
        "未启用 resourceMonitor 的任务 resource 必须为 None：{:?}",
        status.resource
    );
    let samples_path = PathBuf::from(status.log_path).with_extension("samples.jsonl");
    assert!(!samples_path.exists(), "未启用采样不得创建 .samples.jsonl");

    // 清理
    let _ = registry.kill(&task_id).await;
}

/// 防抖状态机纯单测（T-AB-16 2 语义确定性证明；注入 mock 判定序列——
/// 即「直接注入已静默的 mock 状态」，不受真实采样/共享 daemon Job 影响）：
/// 同任务保持期间仅一次，恢复 Healthy 后重置。
#[test]
fn debounce_suspicious_notifies_once_per_keep_period() {
    let mut d = SuspiciousDebounce::default();
    // 保持期间：连续 Suspicious 仅首次通知
    assert!(
        d.observe(ProcessHealth::Suspicious),
        "首次 Suspicious 应通知"
    );
    assert!(
        !d.observe(ProcessHealth::Suspicious),
        "保持期第二次不得通知"
    );
    assert!(
        !d.observe(ProcessHealth::Suspicious),
        "保持期第三次不得通知"
    );
    // 恢复 Healthy 重置后，再次进入 Suspicious 才允许新通知
    assert!(!d.observe(ProcessHealth::Healthy), "Healthy 不通知");
    assert!(
        d.observe(ProcessHealth::Suspicious),
        "恢复 Healthy 后再次 Suspicious 应重新通知（重置语义）"
    );
    assert!(
        !d.observe(ProcessHealth::Suspicious),
        "新保持期第二次不得通知"
    );
    // 重置后保持期内连续多次 Healthy → 不通知且保持重置
    assert!(!d.observe(ProcessHealth::Healthy), "重置不通知");
    assert!(!d.observe(ProcessHealth::Healthy), "连续 Healthy 不通知");
    assert!(
        d.observe(ProcessHealth::Suspicious),
        "再次重置后仍可重新通知"
    );
}

/// 防抖状态机纯单测：Healthy 稳态永不通知；Crashed 不参与防抖。
#[test]
fn debounce_healthy_steady_never_notifies() {
    let mut d = SuspiciousDebounce::default();
    for _ in 0..8 {
        assert!(
            !d.observe(ProcessHealth::Healthy),
            "Healthy 稳态不得产生任何通知"
        );
    }
    assert!(
        !d.observe(ProcessHealth::Crashed),
        "Crashed 不参与防抖（终态由 finish_task 通知）"
    );
    // Crashed 不清除也未武装防抖：后续 Suspicious 仍按保持期语义通知
    assert!(
        d.observe(ProcessHealth::Suspicious),
        "Crashed 拍不影响后续 Suspicious 判定"
    );
}

/// 验收：Suspicious 检测 + 通知去重——注入短静默阈值（2s）的静默任务 →
/// 转 Suspicious、nudge 队列收到通知（文案含任务 id / 疑似卡死 / 由 AI 裁决）
/// 且同任务保持期间不重复通知。
///
/// 判定输入注入静默采样替身（[silent_sampler]，判定稳定为「CPU 近零 +
/// 无输出 → Suspicious」）：真实采样读共享 daemon Job 的 CPU 读数受并行
/// 测试子进程污染（[SamplerFn] 登记说明），替身使「保持期间仅一次」断言
/// 确定性成立；CPU 抖动导致的合法重复通知（恢复 Healthy 重置）由
/// health_healthy_reset_reenables_notification 单独覆盖。
#[tokio::test]
async fn health_suspicious_detected() {
    let (registry, queue) = resource_test_registry_with_sampler(
        Arc::new(Mutex::new(VecDeque::new())),
        silent_sampler(),
    );
    let child = spawn_test_child(LONG_COMMAND);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "health-suspicious",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 轮询等待 Suspicious 通知入队（2s 静默阈值 + 采样拍；窗口 25s）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    let text = loop {
        if let Some(text) = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front() {
            break text;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "静默任务迟迟未触发 Suspicious 通知"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(text.contains(&task_id), "通知含任务 id：{text}");
    assert!(text.contains("疑似卡死"), "文案含疑似卡死：{text}");
    assert!(
        text.contains("2 秒无输出"),
        "文案含静默时长（M=2s）：{text}"
    );
    assert!(text.contains("由 AI 裁决"), "文案注明 AI 裁决：{text}");

    // 防抖：保持期间再等 3s（多拍采样），队列不得出现重复通知（判定
    // 输入为静默替身 → 保持期间判定恒为 Suspicious，断言确定性成立）
    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert!(
        queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
        "同任务保持期间不得重复通知（防抖）：{:?}",
        queue.lock().unwrap_or_else(|p| p.into_inner())
    );

    // 清理
    let _ = registry.kill(&task_id).await;
}

/// 验收：Suspicious 保持期被 CPU 抖动打断后的**合法重复通知**（T-AB-16 2
/// 语义：「同任务防抖——保持期间仅一次，恢复 Healthy 后重置」）。
///
/// 注入脚本化采样替身（[spiking_sampler]）确定性复现 flaky 报告中的
/// 场景：首通知后采样读入一次 CPU 尖峰（判 Healthy → 重置防抖）→ 再静默
/// （判 Suspicious）→ 第二次通知。断言恰好两次（每次保持期仅一次），
/// 确认实现与方案语义一致——CPU 抖动产生的重复通知属合法行为而非 bug。
#[tokio::test]
async fn health_healthy_reset_reenables_notification() {
    // 采样拍序：拍 1 建基线（丢弃），拍 2 起判定；spike_at=8 → 拍 9
    // （约 t=4.5s，首通知 ~2.5s 之后）注入尖峰 → 拍 10 起恢复静默
    let (registry, queue) = resource_test_registry_with_sampler(
        Arc::new(Mutex::new(VecDeque::new())),
        spiking_sampler(8),
    );
    let child = spawn_test_child(LONG_COMMAND);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "health-reset-renotify",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 第一次通知（静默 2s 阈值 + 采样拍；窗口 25s）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    let first = loop {
        if let Some(text) = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front() {
            break text;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "静默任务迟迟未触发首次 Suspicious 通知"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(first.contains(&task_id), "首次通知含任务 id：{first}");

    // 第二次通知（尖峰判 Healthy 重置防抖 → 再静默再次通知；窗口 30s——
    // 并行负载下采样拍可能大幅漂移，尖峰拍到达时间随之后移，放宽窗口防偶发）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let second = loop {
        if let Some(text) = queue.lock().unwrap_or_else(|p| p.into_inner()).pop_front() {
            break text;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "恢复 Healthy 后再次静默应重新通知（防抖重置）"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(second.contains(&task_id), "第二次通知含任务 id：{second}");
    assert!(
        second.contains("疑似卡死"),
        "第二次通知文案含疑似卡死：{second}"
    );

    // 尖峰已过、判定恒为 Suspicious：再等 2s 不得出现第三次（每次保持期
    // 仅一次——恢复 Healthy 重置语义只允许「一次重置 → 一次新通知」）
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert!(
        queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
        "恢复 Healthy 后应恰好重新通知一次，不得再次重复：{:?}",
        queue.lock().unwrap_or_else(|p| p.into_inner())
    );

    // 清理
    let _ = registry.kill(&task_id).await;
}

/// 验收：Healthy 无误报——持续输出任务（last_output_at_ms 不断刷新）
/// 不产生 Suspicious 通知；任务自然完成后再等几拍也不通知。
#[tokio::test]
async fn health_healthy_no_false_positive() {
    let (registry, queue) = resource_test_registry();
    let child = spawn_test_child(OUTPUT_COMMAND);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "health-healthy",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 等待自然完成（OUTPUT_COMMAND ~4s 持续输出；窗口 15s）
    let _ = wait_for_terminal(&registry, &task_id, Duration::from_secs(30)).await;
    // 终态后采样循环已退出（无后续判定），队列应始终为空
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert!(
        queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
        "持续输出任务不得误报 Suspicious"
    );
}

/// 验收：Crashed 通知——非零退出（启用 resourceMonitor）→ 队列收到通知
/// 且附最后 20 行日志（复用 read_log 尾部读取语义）。
#[tokio::test]
async fn health_crashed_notified() {
    let (registry, queue) = resource_test_registry();
    let command = if cfg!(windows) {
        "Write-Output 'crash-line-1'; Write-Output 'crash-line-2'; exit 7"
    } else {
        "echo crash-line-1; echo crash-line-2; exit 7"
    };
    let child = spawn_test_child(command);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "health-crashed",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    let status = wait_for_terminal(&registry, &task_id, Duration::from_secs(30)).await;
    assert_eq!(status.status, TaskState::Failed, "exit 7 → Failed");
    // 终态即屏障：writer 收口时已投递 Crashed 通知，队列应恰好 1 条
    let text = queue
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .pop_front()
        .expect("非零退出应收到 Crashed 通知");
    assert!(text.contains(&task_id), "通知含任务 id：{text}");
    assert!(text.contains("异常退出"), "文案含异常退出：{text}");
    assert!(text.contains("exit code 7"), "文案含退出码：{text}");
    assert!(
        text.contains("crash-line-2"),
        "附最后 20 行日志（含末行）：{text}"
    );
    assert!(text.contains("由 AI 裁决"), "文案注明 AI 裁决：{text}");
    assert!(
        queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
        "Crashed 通知只投递一次（终态唯一）"
    );
}

/// 验收：不自动杀——Suspicious 判定后进程仍存活（显式断言不自动杀、
/// 不自动降级超时，T-AB-16 4 严格不做）。
///
/// 判定输入注入静默采样替身（与 health_suspicious_detected 同理：真实
/// 采样读共享 daemon Job 受并行测试污染，替身保证 Suspicious 判定必然
/// 且稳定到达——本测试只关心「判定后不杀进程」，与 CPU 读数无关）。
#[tokio::test]
async fn health_no_autokill() {
    let (registry, queue) = resource_test_registry_with_sampler(
        Arc::new(Mutex::new(VecDeque::new())),
        silent_sampler(),
    );
    let child = spawn_test_child(LONG_COMMAND);
    let pid = child.id().expect("spawned pid");
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "health-no-autokill",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 等待 Suspicious 通知（= 判定已发生）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    loop {
        if !queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "静默任务迟迟未触发 Suspicious 通知"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // 显式断言：Suspicious 判定后进程仍存活（系统不自动终止）
    assert!(
        pid_is_alive(pid),
        "Suspicious 判定不得自动杀进程（pid={pid}）"
    );
    // 再等 2s（多拍判定后）确认仍未杀
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert!(
        pid_is_alive(pid),
        "Suspicious 持续期间进程必须存活（pid={pid}）"
    );

    // 清理
    let _ = registry.kill(&task_id).await;
}

/// 验收（34 方案 §2.3/§2.4）：采样循环健康判定拆出写 info.suspicious——
/// 静默任务（判定 Suspicious）→ list 快照 suspicious 转 true（wire 可达，
/// 前端轮询渲染「疑似卡死」标记的真源路径）。
#[tokio::test]
async fn suspicious_wire_set_by_monitor_loop() {
    let (registry, queue) = resource_test_registry_with_sampler(
        Arc::new(Mutex::new(VecDeque::new())),
        silent_sampler(),
    );
    let child = spawn_test_child(LONG_COMMAND);
    let r = registry
        .adopt(adopt_request_monitored(
            child,
            "suspicious-wire",
            Path::new("."),
        ))
        .await
        .expect("adopt");
    let task_id = r.task_id.clone();

    // 轮询 list 快照直到 suspicious == true（2s 静默阈值 + 采样拍 + 防抖
    // 首拍丢弃；窗口 25s——判定输入为静默替身，置位必然且稳定到达）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
    loop {
        let all = registry.list(true).await.expect("list");
        if all.iter().any(|i| i.task_id == task_id && i.suspicious) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "静默任务迟迟未置位 suspicious（采样判定未生效）"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // 队列收到 Suspicious 通知（与置位同拍——双通道一致）
    assert!(
        !queue.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
        "置位同时应投递 Suspicious 通知"
    );
    // 保持期：置位保持不回落（保持期判定仍 Suspicious，info 不被改写）
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let all = registry.list(true).await.expect("list");
    let info = all.iter().find(|i| i.task_id == task_id).expect("条目存在");
    assert!(info.suspicious, "保持期 suspicious 保持 true（不回落）");

    // 清理
    let _ = registry.kill(&task_id).await;
}
