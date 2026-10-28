//! workflow 命令面测试（自 workflow.rs 内联段拆出；覆盖命令语义 / 委托注册表 /
//! 存储无损合并 / 孤儿收割 / 真实 launcher / INT-02 / INT-04 / steering 路由）。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use conex_db::LocalDb;
use conex_types::cron::parse_cron;
use orchestrator::PendingMessageQueue;

use crate::core_error::CoreError;
use crate::sched::SchedulerRegistry;

use super::schedule::{epoch_ms_to_iso, next_fire_after_ms, validate_cron_expression};
use super::store::SESSION_META_INDEX_KEY_FOR_TEST as SESSION_META_INDEX_KEY;
use super::*;

/// 测试桩：steering 落点记录
#[derive(Default)]
struct ProbeSink {
    entries: Mutex<Vec<(String, String, u64)>>,
}

impl SteeringSink for ProbeSink {
    fn enqueue_steering(
        &self,
        cron_id: &str,
        text: String,
        enqueued_at_ms: u64,
        _target_session_id: Option<&str>,
    ) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((cron_id.to_string(), text, enqueued_at_ms));
    }
}

/// 测试桩：sched.rs PendingSink 落点（委托测试用）
#[derive(Default)]
struct SchedProbe {
    entries: Mutex<Vec<String>>,
}

impl crate::sched::PendingSink for SchedProbe {
    fn enqueue_steering(
        &self,
        cron_id: &str,
        text: String,
        _enqueued_at_ms: u64,
        _target_session_id: Option<&str>,
    ) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(format!("{cron_id}|{text}"));
    }
}

/// 构造测试后端（内存 store + probe sink；独立模式，注册表委托未注入）
fn test_backend() -> (Arc<WorkflowBackend>, Arc<ProbeSink>) {
    let sink = Arc::new(ProbeSink::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::new(MemoryWorkflowStore::default()),
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));
    (backend, sink)
}

/// 构造 daily 调度入参
fn daily_schedule(time: &str) -> WorkflowScheduleWire {
    WorkflowScheduleWire::Daily {
        time: time.to_string(),
        timezone: "Asia/Shanghai".to_string(),
    }
}

// ── 命令语义：创建 / 列表 / 删除 / 触发 ────────────────────────

/// 创建 → 列表同形状条目（id/名称/提示词/调度/表达式转换齐备）
#[tokio::test]
async fn create_workflow_persists() {
    let (backend, _) = test_backend();
    let view = backend
        .create(
            "每日检查".to_string(),
            "检查仓库状态".to_string(),
            daily_schedule("09:30"),
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");
    assert!(
        view.id.starts_with("cron-"),
        "id 应为 cron-<seq>：{}",
        view.id
    );
    assert_eq!(view.name, "每日检查");
    assert_eq!(view.prompt, "检查仓库状态");
    assert!(view.enabled);
    assert!(view.next_run_at.is_some(), "daily 应有 nextRunAt");

    let list = backend.list();
    assert_eq!(list.len(), 1, "列表应含创建条目");
    let listed = &list[0];
    assert_eq!(listed.id, view.id, "列表条目 id 与创建一致");
    assert_eq!(listed.name, view.name);
    assert_eq!(listed.prompt, view.prompt);
    assert_eq!(
        listed.schedule,
        WorkflowScheduleWire::Daily {
            time: "09:30".to_string(),
            timezone: "Asia/Shanghai".to_string(),
        },
        "schedule 应原样回显"
    );
    // 持久化形状：sched_<cronId> 键可读回
    let persisted = backend.store().load_all();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].cron_id, view.id);
    assert_eq!(persisted[0].expression, "30 9 * * *", "daily → M H * * *");
}

/// 删除后列表不含该条目（运行历史保留）
#[tokio::test]
async fn delete_workflow_removes() {
    let (backend, _) = test_backend();
    let view = backend
        .create(
            "临时任务".to_string(),
            "清理".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");
    backend.trigger(&view.id).expect("触发应成功");
    backend.delete(&view.id).await.expect("删除应成功");
    assert!(
        backend.list().iter().all(|w| w.id != view.id),
        "删除后列表不得含该条目"
    );
    assert_eq!(backend.store().load_all().len(), 0, "存储应移除 sched_* 键");
    // 删除不存在的 id → NotFound
    let again = backend.delete(&view.id).await;
    assert!(
        matches!(again, Err(CoreError::NotFound(_))),
        "删除不存在应 NotFound：{again:?}"
    );
}

/// 立即触发：fired_count+1、steering 条目按 §4.8 模板出现、
/// 运行记录登记、表达式任务的 next_fire 重算
#[tokio::test]
async fn trigger_workflow_immediate_fire() {
    let (backend, sink) = test_backend();
    let view = backend
        .create(
            "巡检".to_string(),
            "巡检工作区".to_string(),
            daily_schedule("08:00"),
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");
    let result = backend.trigger(&view.id).expect("触发应成功");
    assert_eq!(result.run_id.as_deref(), Some("cron-0-manual-fire-1"));
    assert_eq!(result.session_id.as_deref(), Some("sched-cron-0-1"));
    // fired_count 计入
    let persisted = backend.store().load_all();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].fired_count, 1, "触发后 fired_count 应为 1");
    assert!(persisted[0].last_run_at_ms.is_some());
    // steering 条目（§4.8 模板：prompt + 第 N 次触发；group = cron-<id>）
    let entries = sink.entries.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(entries.len(), 1, "应恰好注入一条 steering 条目");
    let (cron_id, text, _) = &entries[0];
    assert_eq!(cron_id, &view.id);
    assert!(
        text.contains("巡检工作区") && text.contains("第 1 次触发"),
        "steering 文本应按冻结模板：{text}"
    );
    // 运行记录
    let runs = backend.list_runs(Some(&view.id), None);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].workflow_id, view.id);
    assert_eq!(runs[0].status, "completed");
    assert_eq!(runs[0].trigger_kind, "manual");
    assert_eq!(runs[0].prompt, "巡检工作区");
}

/// manual 与 cron 触发的 run_id 不得冲突：manual 路径使用独立
/// `manual-fire-` 命名空间（<cron_id>-manual-fire-<fired_count>），
/// 与 sched.rs 触发协程的 `<cron_id>-fire-<iteration>` 格式隔离——
/// 两套计数器（fired_count vs iteration）同起点，若共用 fire- 格式，
/// "手动触发后紧跟 cron 触发"会产出相同 run_id，
/// register_scheduled_run_hook（run_launch.rs HashMap::insert 按 run_id
/// 覆盖）会顶掉在途钩子，终态回写永久丢失。
#[tokio::test]
async fn manual_and_cron_run_ids_do_not_collide() {
    let (backend, _) = test_backend();
    let view = backend
        .create(
            "命名空间".to_string(),
            "命名空间提示".to_string(),
            daily_schedule("08:00"),
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");

    // manual 路径实际产出的 run_id（trigger 内 fired_count 从 1 起）
    let result = backend.trigger(&view.id).expect("触发应成功");
    let manual_run_id = result.run_id.expect("manual 触发应返回 run_id");

    // sched.rs cron 路径对同一计数起点（iteration=1）会产出的 run_id 格式
    let cron_run_id = format!("{}-fire-{}", view.id, 1);

    assert!(
        manual_run_id.starts_with(&format!("{}-manual-fire-", view.id)),
        "manual run_id 应落在 manual-fire- 命名空间：{manual_run_id}"
    );
    assert_ne!(
        manual_run_id, cron_run_id,
        "同一计数起点下 manual 与 cron 的 run_id 不得相同（钩子覆盖风险）"
    );
}

/// 非法调度拒绝（Rust 侧真实错误文案——parse_cron 中文错误，不落库）
#[tokio::test]
async fn create_workflow_rejects_invalid_schedule() {
    let (backend, _) = test_backend();
    // 非法 cron：6 字段（parse_cron 真实文案含「6 字段」定位）
    let err = backend
        .create(
            "坏 cron".to_string(),
            "x".to_string(),
            WorkflowScheduleWire::Cron {
                expression: "0 0 0 * * *".to_string(),
            },
            None,
            None,
            true,
        )
        .await;
    assert!(
        matches!(&err, Err(CoreError::InvalidInput(detail)) if detail.contains("字段")),
        "非法 cron 应返回 parse_cron 中文文案：{err:?}"
    );
    // 无未来命中时刻（2 月 30 日）→ 拒绝
    let err = backend
        .create(
            "坏 cron".to_string(),
            "x".to_string(),
            WorkflowScheduleWire::Cron {
                expression: "0 0 30 2 *".to_string(),
            },
            None,
            None,
            true,
        )
        .await;
    assert!(err.is_err(), "2 月 30 日类表达式应拒绝：{err:?}");
    // 非法 intervalMinutes 越界
    let err = backend
        .create(
            "坏间隔".to_string(),
            "x".to_string(),
            WorkflowScheduleWire::IntervalMinutes {
                interval_minutes: 0,
            },
            None,
            None,
            true,
        )
        .await;
    assert!(err.is_err(), "间隔 0 应拒绝");
    // 空名称拒绝
    let err = backend
        .create(
            "  ".to_string(),
            "x".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await;
    assert!(
        matches!(err, Err(CoreError::InvalidInput(_))),
        "空名称应拒绝"
    );
    // 全部拒绝不落库
    assert_eq!(backend.store().load_all().len(), 0, "拒绝路径不得落库");
}

/// 更新：部分补丁（改名称 / 暂停 / 换调度 → 表达式与 next_fire 重算）
#[tokio::test]
async fn update_workflow_patch_and_recompute() {
    let (backend, _) = test_backend();
    let view = backend
        .create(
            "旧名".to_string(),
            "旧提示".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");
    let updated = backend
        .update(
            &view.id,
            WorkflowPatch {
                name: Some("新名".to_string()),
                schedule: Some(daily_schedule("12:00")),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("更新应成功");
    assert_eq!(updated.name, "新名");
    assert_eq!(updated.prompt, "旧提示", "未补丁字段保持原值");
    let persisted = backend.store().load_all();
    assert_eq!(persisted[0].expression, "0 12 * * *", "换调度应重算表达式");
    assert_ne!(persisted[0].next_fire_at_ms, 0, "换调度应重算 next_fire");
    // 暂停
    let paused = backend
        .update(
            &view.id,
            WorkflowPatch {
                enabled: Some(false),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("暂停应成功");
    assert!(!paused.enabled);
    // 更新不存在的 id → NotFound
    let missing = backend.update("cron-999", WorkflowPatch::default()).await;
    assert!(
        matches!(missing, Err(CoreError::NotFound(_))),
        "更新不存在应 NotFound：{missing:?}"
    );
}

/// 已暂停任务触发拒绝；manual 任务允许触发（仅 steering 面）
#[tokio::test]
async fn trigger_disabled_rejected_manual_allowed() {
    let (backend, _) = test_backend();
    let view = backend
        .create(
            "手动".to_string(),
            "手动作业".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            false,
        )
        .await
        .expect("创建应成功");
    let err = backend.trigger(&view.id);
    assert!(
        matches!(&err, Err(CoreError::InvalidInput(detail)) if detail.contains("暂停")),
        "暂停任务触发应拒绝：{err:?}"
    );
    // 启用后 manual 触发成功（无表达式仅 steering 面）
    backend
        .update(
            &view.id,
            WorkflowPatch {
                enabled: Some(true),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("启用应成功");
    backend.trigger(&view.id).expect("manual 触发应成功");
    let persisted = backend.store().load_all();
    assert_eq!(persisted[0].fired_count, 1);
}

// ── 委托注册表（A5 注入后语义）────────────────────────────────

/// 委托激活：create → 注册表 snapshot 出现任务（id 同源），
/// delete → 注册表 cancel（enabled=false 落库）+ 元数据移除。
#[tokio::test]
async fn delegation_wires_register_and_cancel() {
    use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

    // 构造注册表（sched.rs 适配器；launcher 未接线；注意 shared() 已返回 Arc）
    let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
    let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
    let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
    let sched_store_assert = Arc::clone(&sched_store);
    let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

    // 命令后端注入委托
    let sink = Arc::new(ProbeSink::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::new(MemoryWorkflowStore::default()),
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));
    backend.set_registry(Arc::clone(&registry));

    // 创建 → 注册表 snapshot 同源条目
    let view = backend
        .create(
            "委托创建".to_string(),
            "委托提示".to_string(),
            daily_schedule("07:00"),
            None,
            None,
            true,
        )
        .await
        .expect("委托模式创建应成功");
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.len(), 1, "注册表应有同源任务");
    assert_eq!(snapshot[0].cron_id, view.id);
    assert_eq!(snapshot[0].expression, "0 7 * * *");
    assert_eq!(snapshot[0].prompt, "委托提示");

    // 删除 → 注册表 cancel（enabled=false 落库）+ 元数据移除
    backend.delete(&view.id).await.expect("委托模式删除应成功");
    let persisted = sched_store_assert.load_all();
    assert_eq!(persisted.len(), 1);
    assert!(!persisted[0].enabled, "cancel 应 enabled=false 落库");
    assert!(registry.snapshot().iter().all(|t| !t.enabled));
    assert!(backend.list().is_empty(), "元数据列表应移除");
}

/// 委托模式下删除未注册进 registry 的 manual workflow 应成功：
/// manual 任务创建时表达式为空、从未 register，registry.cancel 返回
/// IdNotFound 属幂等成功，不得阻断 store.remove（否则任务永久删不掉）。
#[tokio::test]
async fn delegation_delete_unregistered_manual_workflow() {
    use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

    let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
    let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
    let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

    let sink = Arc::new(ProbeSink::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::new(MemoryWorkflowStore::default()),
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));
    backend.set_registry(Arc::clone(&registry));

    // manual（表达式为空）不经注册表注册
    let view = backend
        .create(
            "手动任务".to_string(),
            "手动提示".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("manual 创建应成功");
    assert!(
        !registry.snapshot().iter().any(|t| t.cron_id == view.id),
        "manual 任务不应出现在注册表中"
    );

    // 删除应成功（cancel 的 IdNotFound 幂等放行，store.remove 照常执行）
    backend
        .delete(&view.id)
        .await
        .expect("删除未注册 manual workflow 应成功");
    assert!(
        backend.list().iter().all(|w| w.id != view.id),
        "删除后列表不得含该条目"
    );
    assert_eq!(backend.store().load_all().len(), 0, "存储应移除 sched_* 键");
}

/// 验收（30 方案 P6）：trigger → steering 条目落入真实共享队列——
/// QueueSteeringSink 适配 PendingMessageQueue（group_id = cron-<id>
/// 原位替换去重、is_steering 受保护位、摘要文本含 prompt 与第 N 次触发）
#[tokio::test]
async fn trigger_workflow_enqueues_shared_steering() {
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let backend = Arc::new(WorkflowBackend::new(
        Arc::new(MemoryWorkflowStore::default()),
        Arc::new(QueueSteeringSink::new(Arc::clone(&queue))),
    ));
    let view = backend
        .create(
            "手动巡检".to_string(),
            "检查仓库状态".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("manual 创建应成功");
    backend.trigger(&view.id).expect("触发应成功");

    let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(queue.len(), 1, "触发必须写入共享队列");
    let entry = queue.peek().expect("队列必有条目");
    assert_eq!(
        entry.group_id.as_deref(),
        Some(format!("{CRON_ID_PREFIX}{}", view.id).as_str()),
        "group_id 应为 cron-<id>"
    );
    assert!(entry.is_steering, "触发条目为 steering 受保护位");
    assert!(
        entry.text.contains("检查仓库状态") && entry.text.contains("第 1 次触发"),
        "摘要文本应含 prompt 与触发计数：{}",
        entry.text
    );
}

/// 验收（30 方案 P6）：create（cron 表达式）→ 注册表快照含 next_fire
/// ——真实注册调度接入（不再只落库）；注册表表内条目即活跃（P7
/// has_active 判定真源）。
#[tokio::test]
async fn create_workflow_registers_real_scheduler() {
    use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

    let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
    let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
    let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));
    let backend = Arc::new(WorkflowBackend::new(
        Arc::new(MemoryWorkflowStore::default()),
        Arc::new(ProbeSink::default()) as Arc<dyn SteeringSink>,
    ));
    backend.set_registry(Arc::clone(&registry));

    let view = backend
        .create(
            "每日备份".to_string(),
            "执行备份".to_string(),
            daily_schedule("07:00"),
            None,
            None,
            true,
        )
        .await
        .expect("委托模式创建应成功");
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.len(), 1, "注册表应有同源任务");
    assert_eq!(snapshot[0].cron_id, view.id);
    assert!(
        snapshot[0].next_fire_at_ms > 0,
        "快照应含 next_fire（真实调度，不再只落库）"
    );
    assert!(
        registry.has_active(),
        "表内条目即活跃（P7 cron_has_enabled 判定真源）"
    );
    // 清理：取消防触发任务泄漏（daily 表达式真实 sleep 挂起）
    registry.cancel(&view.id).await.expect("清理取消应成功");
}

// ── 表达式校验与 next_fire（委托 parse_cron 纯函数）────────────

#[test]
fn cron_validation_delegates_to_parser() {
    // 合法：*、n、a-b、列表、步进、范围步进、dow 0/7
    for expr in [
        "* * * * *",
        "0 9 * * *",
        "5 8 * * 1-5",
        "0,30 9-18 * * *",
        "*/5 * * * *",
        "0 8-20/2 * * *",
        "0 0 * * 7",
    ] {
        assert_eq!(
            validate_cron_expression(expr).as_deref(),
            Ok(expr),
            "{expr} 应合法"
        );
    }
    // 非法：空 / @ 宏 / 6 字段 / 4 字段 / 越界（parse_cron 真实文案）
    assert!(validate_cron_expression("").is_err());
    assert!(validate_cron_expression("@daily").is_err());
    assert!(validate_cron_expression("0 0 0 * * *").is_err());
    assert!(validate_cron_expression("0 0 * *").is_err());
    assert!(validate_cron_expression("60 * * * *").is_err());
    assert!(validate_cron_expression("0 24 * * *").is_err());
    assert!(validate_cron_expression("0 0 32 * *").is_err());
    assert!(validate_cron_expression("0 0 * 13 *").is_err());
    assert!(validate_cron_expression("0 0 * * 8").is_err());
    // 错误文案为中文（前端可直接展示）
    let err = validate_cron_expression("0 0 0 * * *").unwrap_err();
    assert!(err.contains("6 字段"), "应含字段数定位：{err}");
}

#[test]
fn next_fire_delegates_to_parser() {
    // 确定性断言走固定偏移（offset=0 即 UTC；next_fire_after_in_offset
    // 是 T-CF-08 冻结签名的确定性变体，不依赖本机时区）
    let after = 1_752_000_000_000u64;
    let schedule = parse_cron("30 9 * * *").expect("表达式应合法");
    let next = schedule
        .next_fire_after_in_offset(after, 0)
        .expect("daily 应有下次触发");
    assert!(next > after);
    let secs = next / 1000;
    let (h, m) = ((secs % 86_400) / 3600, (secs % 3600) / 60);
    assert_eq!((h, m), (9, 30), "下次触发应为 09:30（UTC 偏移）");
    // 无命中：2 月 30 日不存在
    assert_eq!(
        schedule_next("0 0 30 2 *", after),
        None,
        "2 月 30 日应无命中"
    );
    // 包装函数（本地时区语义）行为面断言：Some 且在 after 之后、分钟对齐
    if let Some(wrapped) = next_fire_after_ms("30 9 * * *", after) {
        assert!(wrapped > after);
        assert_eq!(wrapped % 60_000, 0, "应为整分钟");
    } else {
        panic!("next_fire_after_ms 应返回 Some");
    }
}

/// 便捷：表达式 → 固定偏移下次触发
fn schedule_next(expression: &str, after_ms: u64) -> Option<u64> {
    parse_cron(expression)
        .ok()?
        .next_fire_after_in_offset(after_ms, 0)
}

#[test]
fn epoch_iso_format_is_parseable() {
    let iso = epoch_ms_to_iso(1_752_000_000_000);
    assert!(iso.ends_with('Z'), "应为 UTC Z 后缀：{iso}");
    assert!(iso.contains('T'), "应为 ISO 格式：{iso}");
    let secs = iso[..iso.len() - 5].replace(['T', ':'], "-");
    let parts: Vec<&str> = secs.split('-').collect();
    assert_eq!(parts.len(), 6, "ISO 应含完整日期时间字段：{iso}");
}

/// 持久化重启恢复：MemoryStore 残留 → 新后端 seq 不撞号、列表可读回
#[tokio::test]
async fn backend_recovers_from_store_on_restart() {
    let store = Arc::new(MemoryWorkflowStore::default());
    let sink = Arc::new(ProbeSink::default());
    let backend_a = Arc::new(WorkflowBackend::new(
        Arc::clone(&store) as Arc<dyn WorkflowStore>,
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));
    let first = backend_a
        .create(
            "重启前".to_string(),
            "x".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");
    assert_eq!(first.id, "cron-0");
    drop(backend_a); // 模拟重启（store 残留）
    let backend_b = WorkflowBackend::new(
        Arc::clone(&store) as Arc<dyn WorkflowStore>,
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    );
    let list = backend_b.list();
    assert_eq!(list.len(), 1, "重启后列表应恢复");
    assert_eq!(list[0].id, "cron-0");
    let second = backend_b
        .create(
            "重启后".to_string(),
            "y".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");
    assert_eq!(second.id, "cron-1", "重启后 seq 不得撞号");
}

// ── Wave 1 存储无损合并与孤儿运行收割实施专项测试 ─────────────

/// 1. ID 恒定铁律：委托模式下修改调度表达式与提示词，cron_id 与 created_at 严格不变
#[tokio::test]
async fn update_workflow_preserves_id_and_invariance() {
    use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

    let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
    let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
    let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

    let sink = Arc::new(ProbeSink::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::new(MemoryWorkflowStore::default()),
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));
    backend.set_registry(Arc::clone(&registry));

    let created = backend
        .create(
            "恒定任务".to_string(),
            "初始提示词".to_string(),
            daily_schedule("08:00"),
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");

    let original_id = created.id.clone();
    let original_created_at = created.created_at.clone();

    // 更新调度表达式与提示词
    let updated = backend
        .update(
            &original_id,
            WorkflowPatch {
                prompt: Some("热更新提示词".to_string()),
                schedule: Some(daily_schedule("18:30")),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("更新应成功");

    // 核心断言：ID 与创建时间绝对恒定
    assert_eq!(
        updated.id, original_id,
        "cron_id 必须绝对恒定，严禁因更新表达式重分 ID"
    );
    assert_eq!(
        updated.created_at, original_created_at,
        "created_at 必须绝对恒定，严禁被重置"
    );
    assert_eq!(updated.prompt, "热更新提示词");

    // 注册表快照检验：注册表中也是同一个 ID，且表达式已热更新
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].cron_id, original_id);
    assert_eq!(snapshot[0].expression, "30 18 * * *");
    assert_eq!(snapshot[0].prompt, "热更新提示词");
}

/// 2. 启停联动：更新 enabled 联动触发底座 pause_task / resume_task，且 list() 真实回显
#[tokio::test]
async fn update_workflow_pause_resume_linkage() {
    use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

    let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
    let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
    let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

    let sink = Arc::new(ProbeSink::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::new(MemoryWorkflowStore::default()),
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));
    backend.set_registry(Arc::clone(&registry));

    let created = backend
        .create(
            "联动任务".to_string(),
            "提示词".to_string(),
            daily_schedule("09:00"),
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");

    assert!(registry.snapshot()[0].enabled, "注册后初始为 active");

    // 暂停任务
    let paused = backend
        .update(
            &created.id,
            WorkflowPatch {
                enabled: Some(false),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("暂停应成功");

    assert!(!paused.enabled);
    assert!(
        paused.next_run_at.is_none(),
        "暂停态 next_run_at 必须为 None"
    );
    assert!(
        !registry.snapshot()[0].enabled,
        "注册表中任务必须同步置为 paused"
    );

    // 恢复任务
    let resumed = backend
        .update(
            &created.id,
            WorkflowPatch {
                enabled: Some(true),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("恢复应成功");

    assert!(resumed.enabled);
    assert!(resumed.next_run_at.is_some(), "恢复后应有 next_run_at");
    assert!(
        registry.snapshot()[0].enabled,
        "注册表中任务必须同步置为 active"
    );
}

/// 3. Safe Field Merge 治理：save 不会冲刷业务或底座自定义 JSON 字段，实现双向安全无损
#[test]
fn safe_field_merge_preserves_business_and_scheduling_fields() {
    let db = LocalDb::open_in_memory().expect("内存库应打开成功");
    let store = SessionMetaWorkflowStore::new(db.clone());

    // 预置存量 JSON，包含上层业务私有扩展字段与底座扩展字段
    let raw_json = serde_json::json!({
        "cronId": "cron-42",
        "expression": "0 10 * * *",
        "prompt": "原始提示词",
        "enabled": true,
        "status": "Active",
        "name": "业务工作流",
        "customBusinessField": "important_value",
        "extraMeta": { "nested": 123 },
        "createdAtMs": 1000u64,
        "updatedAtMs": 1000u64
    });
    db.set_session_meta("sched_cron-42", &raw_json.to_string())
        .expect("预置元数据应成功");
    db.set_session_meta(
        SESSION_META_INDEX_KEY,
        &serde_json::to_string(&vec!["cron-42"]).unwrap(),
    )
    .expect("预置索引应成功");

    // 从 store 加载
    let mut loaded = store.load_all();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].cron_id, "cron-42");

    // 修改某字段后调用 store.save
    loaded[0].prompt = "修改后的提示词".to_string();
    store.save(&loaded[0]);

    // 直接读取底座 JSON 校验：业务扩展字段未被冲刷丢失
    let saved_json_str = db
        .get_session_meta("sched_cron-42")
        .expect("读取")
        .expect("存在");
    let saved_val: serde_json::Value = serde_json::from_str(&saved_json_str).unwrap();

    assert_eq!(saved_val["prompt"], "修改后的提示词");
    assert_eq!(saved_val["customBusinessField"], "important_value");
    assert_eq!(saved_val["extraMeta"]["nested"], 123);
}

/// 4. 启发式自愈：Manual 调度但有合法 cron 表达式的历史脏数据，在 load_all 时自动自愈为 Cron
#[test]
fn heuristic_rehydration_restores_manual_with_valid_expression() {
    let db = LocalDb::open_in_memory().expect("内存库应打开成功");
    let store = SessionMetaWorkflowStore::new(db.clone());

    // 预置存量脏数据：schedule 为 manual，但 expression 为有效 5 字段表达式
    let legacy_json = serde_json::json!({
        "cronId": "cron-legacy-1",
        "expression": "*/15 * * * *",
        "prompt": "历史脏任务",
        "enabled": true,
        "name": "自愈测试",
        "schedule": { "type": "manual" },
        "createdAtMs": 2000u64,
        "updatedAtMs": 2000u64
    });
    db.set_session_meta("sched_cron-legacy-1", &legacy_json.to_string())
        .unwrap();
    // 且索引位于老键 sched_ids 中，测试索引合并
    db.set_session_meta(
        "sched_ids",
        &serde_json::to_string(&vec!["cron-legacy-1"]).unwrap(),
    )
    .unwrap();

    let all = store.load_all();
    assert_eq!(all.len(), 1);
    let wf = &all[0];
    // 断言自愈成功
    assert_eq!(
        wf.schedule,
        WorkflowScheduleWire::Cron {
            expression: "*/15 * * * *".to_string()
        },
        "启发式自愈应将 Manual + 有效表达式恢复为 WorkflowScheduleWire::Cron"
    );

    // 断言已回写持久化库，并且新索引 sched_index 已写入
    let reloaded_index: Vec<String> = serde_json::from_str(
        &db.get_session_meta(SESSION_META_INDEX_KEY)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(reloaded_index.contains(&"cron-legacy-1".to_string()));
}

/// 5. 孤儿运行收割与 update_run_finish Upsert 语义验证
#[test]
fn orphan_running_runs_reaped_and_update_run_finish_upsert() {
    let store = MemoryWorkflowStore::default();

    // 插入各种在途状态记录与一条已完成记录
    let statuses = [
        ("r1", "running"),
        ("r2", "queued"),
        ("r3", "pending"),
        ("r4", "in_progress"),
        ("r5", "accepted"),
        ("r6", "started"),
        ("r7", "completed"),
    ];
    for (rid, st) in statuses {
        store.append_or_update_run(WorkflowRunRecord {
            workflow_id: "wf-1".to_string(),
            run_id: rid.to_string(),
            session_id: None,
            trigger_kind: "cron".to_string(),
            scheduled_for_ms: 1000,
            started_at_ms: 1000,
            finished_at_ms: None,
            duration_ms: Some(999),
            status: st.to_string(),
            prompt: "测试".to_string(),
            error: None,
            output_summary: None,
        });
    }

    // 执行收割
    let reaped = store.reap_orphan_running_runs();
    assert_eq!(reaped, 6, "6 条在途记录应全部被收割");

    let runs = store.load_runs();
    for run in &runs {
        if run.run_id == "r7" {
            assert_eq!(run.status, "completed");
        } else {
            assert_eq!(run.status, "interrupted");
            assert_eq!(run.duration_ms, None);
            assert!(run.error.as_deref().unwrap_or("").contains("自愈收割"));
        }
    }

    // 验证 update_run_finish Upsert：更新已有记录
    store.update_run_finish(
        "wf-1",
        "r1",
        "success",
        2000,
        1000,
        None,
        Some("完成摘要".to_string()),
    );
    let updated_r1 = store
        .load_runs()
        .into_iter()
        .find(|r| r.run_id == "r1")
        .unwrap();
    assert_eq!(updated_r1.status, "success");
    assert_eq!(updated_r1.duration_ms, Some(1000));
    assert_eq!(updated_r1.output_summary.as_deref(), Some("完成摘要"));

    // 验证 update_run_finish Upsert：若记录不存在，原地创建终态记录
    store.update_run_finish(
        "wf-1",
        "r-brand-new",
        "failed",
        3000,
        500,
        Some("外部超时".to_string()),
        None,
    );
    let created_new = store
        .load_runs()
        .into_iter()
        .find(|r| r.run_id == "r-brand-new")
        .unwrap();
    assert_eq!(created_new.status, "failed");
    assert_eq!(created_new.started_at_ms, 2500);
    assert_eq!(created_new.finished_at_ms, Some(3000));
    assert_eq!(created_new.error.as_deref(), Some("外部超时"));
}

/// list_runs 热路径不得改写在途 run：reaper 只能在冷启动
/// （WorkflowBackend::new）执行。真实 Agent 执行链路先落 `status:"running"`
/// 记录再异步执行（可达数分钟），在途 running 记录是合法状态；若
/// list_runs 收割，前端任何一次历史查询都会把执行中的任务误标为
/// interrupted 并写入"自愈收割"错误文案。
#[tokio::test]
async fn list_runs_preserves_in_flight_running_records() {
    let (backend, _) = test_backend();
    backend.store().append_or_update_run(WorkflowRunRecord {
        workflow_id: "wf-hot".to_string(),
        run_id: "wf-hot-manual-fire-1".to_string(),
        session_id: Some("sess-1".to_string()),
        trigger_kind: "manual".to_string(),
        scheduled_for_ms: 1000,
        started_at_ms: 1000,
        finished_at_ms: None,
        duration_ms: None,
        status: "running".to_string(),
        prompt: "在途任务".to_string(),
        error: None,
        output_summary: None,
    });

    // 连续多次 list_runs（模拟前端刷新）不得改写该记录
    for _ in 0..3 {
        let views = backend.list_runs(Some("wf-hot"), None);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].run_id, "wf-hot-manual-fire-1");
        assert_eq!(views[0].status, "running", "在途 run 不得被 list_runs 改写");
        assert!(
            views[0].error.is_none(),
            "在途 run 不得被写入收割错误文案：{:?}",
            views[0].error
        );
    }

    // 落盘记录同样保持 running（收割未发生、未持久化改写）
    let persisted = backend
        .store()
        .load_runs()
        .into_iter()
        .find(|r| r.run_id == "wf-hot-manual-fire-1")
        .expect("记录应仍在");
    assert_eq!(persisted.status, "running");
    assert_eq!(persisted.finished_at_ms, None);
    assert_eq!(persisted.duration_ms, None);
}

/// 6. list() 杜绝冲刷覆盖 DB 启用状态
#[tokio::test]
async fn list_does_not_overwrite_db_enabled_state() {
    use crate::sched::{MemorySchedStore, SchedEventSink, SchedStore};

    let pending: Arc<dyn crate::sched::PendingSink> = Arc::new(SchedProbe::default());
    let events: Arc<dyn crate::sched::EventSink> = Arc::new(SchedEventSink::new());
    let sched_store: Arc<dyn SchedStore> = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(pending, events, sched_store, None));

    let sink = Arc::new(ProbeSink::default());
    let store = Arc::new(MemoryWorkflowStore::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::clone(&store) as Arc<dyn WorkflowStore>,
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));
    backend.set_registry(Arc::clone(&registry));

    let created = backend
        .create(
            "禁用任务".to_string(),
            "提示词".to_string(),
            daily_schedule("10:00"),
            None,
            None,
            false,
        )
        .await
        .expect("创建应成功");

    assert!(!created.enabled);

    // 调用 list()，断言其 enabled 依然为 false，且 next_run_at 为 None
    let list = backend.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, created.id);
    assert!(!list[0].enabled, "list() 严禁覆盖库中的禁用状态");
    assert!(list[0].next_run_at.is_none());
}

/// 7. prune_runs 针对所有运行记录限制单任务与全局容量（不豁免 running）
#[test]
fn prune_runs_limits_all_runs() {
    let mut runs = Vec::new();
    // 单工作流插入 30 条 running 状态的记录
    for i in 0..30 {
        runs.push(WorkflowRunRecord {
            workflow_id: "wf-prune".to_string(),
            run_id: format!("run-{i}"),
            session_id: None,
            trigger_kind: "cron".to_string(),
            scheduled_for_ms: i * 100,
            started_at_ms: i * 100,
            finished_at_ms: None,
            duration_ms: None,
            status: "running".to_string(),
            prompt: "提示".to_string(),
            error: None,
            output_summary: None,
        });
    }

    let pruned = prune_runs(runs);
    assert_eq!(
        pruned.len(),
        20,
        "单工作流上限为 20，即使全部为 running 也必须滚动淘汰最老记录"
    );
    // 保留的是 started_at_ms 最大的最新 20 条（10..30）
    let min_started = pruned.iter().map(|r| r.started_at_ms).min().unwrap();
    assert_eq!(min_started, 1000);
}

/// 测试桩：模拟真实异步 ScheduledTaskLauncher（支持延迟完成或终态钩子管理）
struct AsyncTestLauncher {
    contexts: Mutex<Vec<crate::sched::ScheduledExecutionContext>>,
    delay_ms: u64,
    async_terminal_managed: bool,
    fail_msg: Option<String>,
}

#[async_trait]
impl crate::sched::ScheduledTaskLauncher for AsyncTestLauncher {
    async fn launch_scheduled_task(
        &self,
        ctx: crate::sched::ScheduledExecutionContext,
    ) -> Result<crate::sched::ScheduledRunHandle, CoreError> {
        self.contexts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(ctx.clone());
        if self.delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
        }
        if let Some(msg) = &self.fail_msg {
            return Err(CoreError::Internal(msg.clone()));
        }
        let session_id = ctx
            .target_session_id
            .unwrap_or_else(|| format!("sched-run-{}-{}", ctx.cron_id, ctx.fired_at_ms));
        Ok(crate::sched::ScheduledRunHandle {
            run_id: ctx.run_id,
            session_id,
            async_terminal_managed: self.async_terminal_managed,
            immediate_output_summary: None,
        })
    }
}

/// 8. 终结假跑：注入真实 ScheduledTaskLauncher 时，trigger 初始写入 running（duration_ms=None），
///    待异步执行或终态回写钩子完成后才跃迁为 completed / failed 并写入真实耗时与摘要
#[tokio::test]
async fn trigger_with_real_launcher_transitions_running_to_terminal() {
    let store = Arc::new(MemoryWorkflowStore::default());
    let sink = Arc::new(ProbeSink::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::clone(&store) as Arc<dyn WorkflowStore>,
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));

    let launcher = Arc::new(AsyncTestLauncher {
        contexts: Mutex::new(Vec::new()),
        delay_ms: 40,
        async_terminal_managed: true,
        fail_msg: None,
    });
    backend.set_launcher(Arc::clone(&launcher) as Arc<dyn crate::sched::ScheduledTaskLauncher>);

    let created = backend
        .create(
            "真实驱动测试".to_string(),
            "总结工作区进度".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");

    let res = backend.trigger(&created.id).expect("触发应成功");
    let run_id = res.run_id.expect("应返回 run_id");

    // 触发刚返回瞬间：store 内的原始记录必须是 running，且 duration_ms / finished_at_ms 均为 None
    let raw_runs = store.load_runs();
    assert_eq!(raw_runs.len(), 1);
    assert_eq!(raw_runs[0].run_id, run_id);
    assert_eq!(
        raw_runs[0].status, "running",
        "注入真实 launcher 后禁止同步秒回 completed 0ms 假数据"
    );
    assert_eq!(raw_runs[0].duration_ms, None);
    assert_eq!(raw_runs[0].finished_at_ms, None);

    // 等待异步 launcher 被调用
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert_eq!(launcher.contexts.lock().unwrap().len(), 1);

    // 模拟真实 Agent Loop 结束并触发 finish_run 回写终态
    let finished_at = raw_runs[0].started_at_ms + 125;
    backend.finish_run(
        &created.id,
        &run_id,
        "completed",
        finished_at,
        125,
        None,
        Some("Agent 已完成定时巡检并输出报告".to_string()),
    );

    let updated_runs = store.load_runs();
    assert_eq!(updated_runs.len(), 1);
    assert_eq!(updated_runs[0].status, "completed");
    assert_eq!(updated_runs[0].duration_ms, Some(125));
    assert_eq!(updated_runs[0].finished_at_ms, Some(finished_at));
    assert_eq!(
        updated_runs[0].output_summary.as_deref(),
        Some("Agent 已完成定时巡检并输出报告")
    );
}

/// 9. INT-02 全局默认沙箱目录兜底：cwd 为 None 或空串时自动解析并创建 <app_data_dir>/scheduled-tasks-sandbox
#[test]
#[allow(clippy::disallowed_methods)] // 测试临时目录清理，非产品物理删除路径
fn resolve_effective_workflow_cwd_creates_default_sandbox_int02() {
    let unique_dir = std::env::temp_dir().join(format!("crish-int02-sandbox-test-{}", now_ms()));
    let _ = std::fs::remove_dir_all(&unique_dir);

    // 1. cwd = None -> 自动创建 <unique_dir>/scheduled-tasks-sandbox
    let resolved_none =
        resolve_effective_workflow_cwd(None, Some(&unique_dir)).expect("应返回沙箱路径");
    let expected_sandbox = unique_dir.join("scheduled-tasks-sandbox");
    assert_eq!(
        std::path::Path::new(&resolved_none),
        expected_sandbox.as_path()
    );
    assert!(
        expected_sandbox.exists() && expected_sandbox.is_dir(),
        "默认沙箱目录必须在磁盘上被真实创建"
    );

    // 2. cwd = Some("   ") -> 同样回退到默认沙箱目录
    let resolved_empty =
        resolve_effective_workflow_cwd(Some("   "), Some(&unique_dir)).expect("应返回沙箱路径");
    assert_eq!(
        std::path::Path::new(&resolved_empty),
        expected_sandbox.as_path()
    );

    // 3. cwd 指向真实存在目录 -> 原样返回
    let custom_dir = unique_dir.join("custom-workspace");
    std::fs::create_dir_all(&custom_dir).expect("创建自定义目录");
    let custom_str = custom_dir.to_string_lossy().to_string();
    let resolved_custom =
        resolve_effective_workflow_cwd(Some(&custom_str), Some(&unique_dir)).unwrap();
    assert_eq!(resolved_custom, custom_str);

    let _ = std::fs::remove_dir_all(&unique_dir);
}

/// 10. INT-04 僵尸会话自愈：当绑定的 target_session_id 已被删除时，trigger 自动抹除脏绑定并降级至独立会话
#[tokio::test]
async fn trigger_self_heals_deleted_target_session_id_int04() {
    let store = Arc::new(MemoryWorkflowStore::default());
    // 仅登记 alive-session-1 存在，deleted-session-404 不存在
    store.set_existing_sessions(vec!["alive-session-1".to_string()]);

    let sink = Arc::new(ProbeSink::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::clone(&store) as Arc<dyn WorkflowStore>,
        Arc::clone(&sink) as Arc<dyn SteeringSink>,
    ));

    let launcher = Arc::new(AsyncTestLauncher {
        contexts: Mutex::new(Vec::new()),
        delay_ms: 10,
        async_terminal_managed: false,
        fail_msg: None,
    });
    backend.set_launcher(Arc::clone(&launcher) as Arc<dyn crate::sched::ScheduledTaskLauncher>);

    let created = backend
        .create(
            "绑定已删会话任务".to_string(),
            "执行检查".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");

    // 绑定一个已被删除的 target_session_id
    backend
        .update(
            &created.id,
            WorkflowPatch {
                target_session_id: Some("deleted-session-404".to_string()),
                execution_mode: Some("current_session".to_string()),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("绑定应成功");

    assert_eq!(
        store.load_all()[0].target_session_id.as_deref(),
        Some("deleted-session-404")
    );

    // 触发任务：应触发 INT-04 自愈降级而非报错
    let trigger_res = backend
        .trigger(&created.id)
        .expect("绑定会话被删时触发必须自愈成功而非失败");
    let fallback_sid = trigger_res.session_id.expect("应返回自愈后的独立会话 ID");
    assert!(
        fallback_sid.starts_with(&format!("sched-run-{}-", created.id)),
        "应降级为独立后台会话 sched-run-*，实际: {fallback_sid}"
    );

    // 校验持久化层：target_session_id 已被自动抹除为 None，execution_mode 更新为 isolated
    let persisted = store.load_all();
    assert_eq!(
        persisted[0].target_session_id, None,
        "脏 target_session_id 必须被永久抹除"
    );
    assert_eq!(
        persisted[0].execution_mode.as_deref(),
        Some("isolated"),
        "execution_mode 应同步自愈为 isolated"
    );
}

/// 11. 阶段 3 §4.3 Steering 动态会话路由验证：绑定 target_session_id 时精确路由至目标对话会话，未绑定时回退至 sched-{cron_id}
#[tokio::test]
async fn trigger_workflow_steering_routes_to_bound_target_session_or_fallback() {
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let store = Arc::new(MemoryWorkflowStore::default());
    let backend = Arc::new(WorkflowBackend::new(
        Arc::clone(&store) as Arc<dyn WorkflowStore>,
        Arc::new(QueueSteeringSink::new(Arc::clone(&queue))),
    ));

    // 1. 绑定 target_session_id = Some("sess-bound-chat-42".into()) 的任务
    let bound_wf = backend
        .create(
            "绑定会话巡检".to_string(),
            "检查当前对话分支状态".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建绑定任务应成功");

    backend
        .update(
            &bound_wf.id,
            WorkflowPatch {
                target_session_id: Some("sess-bound-chat-42".to_string()),
                execution_mode: Some("current_session".to_string()),
                ..WorkflowPatch::default()
            },
        )
        .await
        .expect("更新 target_session_id 应成功");

    backend.trigger(&bound_wf.id).expect("触发绑定任务应成功");

    let bound_entries = queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .dequeue_all();
    assert_eq!(bound_entries.len(), 1);
    assert_eq!(
        bound_entries[0].session_id, "sess-bound-chat-42",
        "绑定 target_session_id 时，SteeringInputEntry.session_id 必须精确等于 sess-bound-chat-42"
    );

    // 2. 未绑定 target_session_id（None）的任务：回退至 sched-{cron_id}
    let unbound_wf = backend
        .create(
            "独立后台巡检".to_string(),
            "执行全局巡检".to_string(),
            WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建未绑定任务应成功");

    backend
        .trigger(&unbound_wf.id)
        .expect("触发未绑定任务应成功");

    let unbound_entries = queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .dequeue_all();
    assert_eq!(unbound_entries.len(), 1);
    assert_eq!(
        unbound_entries[0].session_id,
        format!("sched-{}", unbound_wf.id),
        "未绑定 target_session_id 时，SteeringInputEntry.session_id 必须回退为 sched-<cron_id>"
    );
}
