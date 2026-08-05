//! E01 引擎级集成测试（T-EG-07）——multi_replace 接线后的行为验证四组
//!
//! 任务书：docs/feature-gap-analysis/plans/04-EG编辑工具与文档工作区方案.md §5.2.2
//! T-EG-07（:682-693）；验收映射：docs/feature-gap-analysis/REQ-EG-现状分析.md 1.9
//!（:339-342：并发防竞争 / 备份覆盖 / 幂等 / 探索配额）。
//!
//! 四组覆盖与参照模式：
//! 1. 并发防竞争：A 持有 write claim 期间，B 调 multi_replace 同路径 →
//!    `tool.write_path_conflict`（对齐 write_paths.rs:596-628 的 write_file 冲突测试）；
//! 2. 备份覆盖：multi_replace 前快照登记（.crish-trash），模拟写坏后
//!    restore_force 恢复（对齐 backup.rs:379-401 的 roundtrip 消费侧闭环）；
//! 3. 幂等：同 chunk 集合二次调用 → Deduplicated（对齐 executor.rs:277-299）；
//! 4. 探索配额：配额耗尽后借 multi_replace 写文档 → 被 guard 拒绝
//!    （explore_quota.rs:262-276 guard_explore_docs_write 接线点）。
//!
//! 层级说明（T-EG-07 与 T-EG-06 并行编写，契约先行）：
//! - 契约层用例直接装配 ToolContext（write_claims / explore_docs_quota 字段），
//!   验证 multi_replace 对互斥与配额契约的遵守（replace.rs:98/:100 接线点）；
//! - 引擎层用例经 ToolExecutor 全链路执行（真实内置注册表 + 中间件链 + 幂等
//!   守卫），验证 T-EG-06 会话级装配（tool_exec.rs:670-687 write_claims /
//!   explore_docs_quota 从 None 变为接线）与 T-EG-05 中间件装配（backup 中间件
//!   识别 target_file 入参，F5 轮次报告 L1）后的整体行为；
//! - 依赖矩阵见各用例头注：用例 1b/4b 依赖 T-EG-06 装配，用例 2 依赖 T-EG-05
//!   的 backup 中间件 target_file 识别；装配未完成时对应用例红（按 T-EG-07
//!   验收标准降级登记，由 R-EG3 承接），契约层用例（1a/4a）与幂等用例（3）
//!   不依赖装配、应全绿。

use std::sync::Arc;

use agent_tools::backup::BackupMiddleware;
use agent_tools::context::{create_mock_tool_context, ExploreDocsQuotaContext, ToolContext};
use agent_tools::explore_quota::{ExploreDocsQuotaStore, InMemoryExploreDocsQuotaStore};
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::register_builtin_tools;
use agent_tools::registry::ToolRegistry;
use agent_tools::write_paths::{ClaimMode, WritePathRegistry};
use conex_fs::trash::{EntryMode, TrashService};
use conex_test_utils::TempWorkspace;
use conex_types::tool::{ToolBatchCall, ToolCategory, ToolConcurrency};
use serde_json::json;
use session_loop::{ToolBatchOptions, ToolErrorKind, ToolExecCtx, ToolExecutor};

/// multi_replace 工具名（注册键；与 replace.rs:28 常量同值，测试面硬断言）
const MULTI_REPLACE_TOOL: &str = "multi_replace_file_content";

/// 写路径互斥冲突错误码（write_paths.rs:37 局部码，pub(crate) 不导出——
/// 测试面按字面量断言）
const TOOL_WRITE_PATH_CONFLICT_CODE: &str = "tool.write_path_conflict";

/// 对标 legacy e2e 黄金用例（REQ-EG-现状分析.md 1.10）：初始 5 行组件
const COMPONENT_TS_INITIAL: &str = "\
import React from 'react';
function Component() {
  const [count, setCount] = useState(0);
  return <div>{count}</div>;
}
";

/// 三块替换后的期望形态（= legacy e2e 中 replacedCode 的期望）
const COMPONENT_TS_EXPECTED: &str = "\
import React, { useState } from 'react';
function Component() {
  const [count, setCount] = useState(10);
  return <button>{count}</button>;
}
";

/// 新建内置工具注册表（含 multi_replace_file_content，mod.rs:118 注册面）
fn builtin_registry() -> Arc<ToolRegistry> {
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("内置工具注册失败");
    Arc::new(reg)
}

/// 从内置注册表取出 multi_replace 工具（pub(crate) 工具类，集成测试唯一入口）
fn multi_replace_tool() -> Arc<dyn agent_tools::Tool> {
    builtin_registry()
        .get(MULTI_REPLACE_TOOL)
        .expect("multi_replace_file_content 必须已注册")
}

/// 黄金用例三块入参（头 import + 中部字段 + 尾部 JSX，互不连续，
/// 对齐 replace.rs:682-706 的 golden_chunks_args）
fn golden_args(target_file: &str) -> serde_json::Value {
    json!({
        "target_file": target_file,
        "replacement_chunks": [
            {
                "start_line": 1,
                "end_line": 1,
                "target_content": "import React from 'react';",
                "replacement_content": "import React, { useState } from 'react';"
            },
            {
                "start_line": 3,
                "end_line": 3,
                "target_content": "  const [count, setCount] = useState(0);",
                "replacement_content": "  const [count, setCount] = useState(10);"
            },
            {
                "start_line": 4,
                "end_line": 4,
                "target_content": "  return <div>{count}</div>;",
                "replacement_content": "  return <button>{count}</button>;"
            }
        ]
    })
}

/// 引擎执行上下文：workspace_root 与 cwd 同指临时工作区
///（backup 中间件以 cwd 为快照解析基准、工具以 workspace_root 为解析基准，
/// 两处一致才能对同一目标登记快照）
fn exec_ctx(ws: &TempWorkspace) -> ToolExecCtx {
    exec_ctx_wired(ws, None, None)
}

/// 装配注入变体（T-EG-06 总接线点契约）：1b/4b 引擎层用例按会话级装配
/// 注入写路径互斥注册表与探索配额上下文（对齐 with_options 装配语义）
fn exec_ctx_wired(
    ws: &TempWorkspace,
    write_claims: Option<Arc<WritePathRegistry>>,
    explore_docs_quota: Option<ExploreDocsQuotaContext>,
) -> ToolExecCtx {
    ToolExecCtx {
        run_id: "run-B".to_string(),
        session_id: "sess-1".to_string(),
        cwd: Some(ws.path_str()),
        workspace_root: Some(ws.path().clone()),
        write_claims,
        explore_docs_quota,
    }
}

/// 构造 multi_replace 批调用（串行 + 文件系统类别）
fn mrepl_call(id: &str, args: serde_json::Value) -> ToolBatchCall {
    ToolBatchCall {
        id: id.to_string(),
        tool_name: MULTI_REPLACE_TOOL.to_string(),
        summary: "multi_replace 集成测试调用".to_string(),
        input: args,
        category: ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }
}

// ==================== 组 1：并发防竞争（REQ-E01 1.3 后半） ====================

/// 契约层：A 持有 write claim 期间，B 调 multi_replace 同路径 → 冲突拒绝
///
/// 对齐 write_paths.rs:600-632（write_file_rejects_conflicting_holder）：
/// 子代理 A 长期声明 `src/`，子代理 B 的执行上下文同注册表、不同持有者；
/// 冲突必须返回 `tool.write_path_conflict`（含占用者）、不得写盘；
/// 释放后重试成功，且工具执行期声明不残留记账。
#[tokio::test]
async fn multi_replace_conflict_via_wired_ctx() {
    let ws = TempWorkspace::new("e01_mr_conflict_ctx");
    ws.write_file("src/component.ts", COMPONENT_TS_INITIAL);
    let registry = Arc::new(WritePathRegistry::new("sess-1", ws.path()));
    // 子代理 A 长期声明 src/（run_subagent write_paths 语义，对齐 write_paths.rs:605）
    let _a_guard = registry.claim_one("runA", "src", ClaimMode::Write).unwrap();

    // 子代理 B 的执行上下文：同注册表、不同持有者（对齐 write_paths.rs:608-614）
    let ctx_b = ToolContext {
        workspace_root: ws.path().clone(),
        write_claims: Some(Arc::clone(&registry)),
        write_claim_holder: Some("runB".to_string()),
        explore_docs_quota: None,
        ..create_mock_tool_context()
    };
    let err = multi_replace_tool()
        .execute(&ctx_b, golden_args("src/component.ts"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_WRITE_PATH_CONFLICT_CODE, "冲突必须返回专用错误码");
    assert!(err.to_string().contains("runA"), "错误必须说明谁占用");
    assert_eq!(
        ws.read_file("src/component.ts"),
        COMPONENT_TS_INITIAL,
        "冲突拒绝时不得写盘"
    );

    // 释放后同调用重试成功（对齐 write_paths.rs:624-629）
    drop(_a_guard);
    multi_replace_tool()
        .execute(&ctx_b, golden_args("src/component.ts"))
        .await
        .unwrap();
    assert_eq!(ws.read_file("src/component.ts"), COMPONENT_TS_EXPECTED);
    // 工具执行期声明随执行结束释放（不残留记账，对齐 write_paths.rs:631）
    assert!(registry.active_claims().is_empty());
}

/// 引擎层：A 持有 write claim 期间，B 经引擎执行器调 multi_replace → 冲突拒绝
///
/// 依赖 T-EG-06 装配（tool_exec.rs:670-687：会话级 WritePathRegistry 与
/// workspace_root 同源注入引擎执行上下文）；装配完成后本用例转绿。
/// 冲突错误码 `tool.write_path_conflict` 为 agent-tools 局部码，经执行器
/// 分类为 ToolErrorKind::ExecutionFailed（tool_exec.rs:1206 兜底分支），
/// 断言以错误文案为准。
#[tokio::test]
async fn multi_replace_conflict_through_engine_executor() {
    let ws = TempWorkspace::new("e01_mr_conflict_engine");
    ws.write_file("docs/readme.md", "line one\nline two\n");
    // 会话级注册表（对齐 T-EG-06 装配契约：与 workspace_root 同源）
    let registry = Arc::new(WritePathRegistry::new("sess-1", ws.path()));
    // 子代理 A 长期声明 docs/（前缀语义：docs/readme.md 在声明范围内）
    let _a_guard = registry.claim_one("runA", "docs", ClaimMode::Write).unwrap();
    let exec = ToolExecutor::new(builtin_registry());

    let args = json!({
        "target_file": "docs/readme.md",
        "replacement_chunks": [
            { "start_line": 1, "end_line": 1, "target_content": "line one", "replacement_content": "LINE ONE" }
        ]
    });
    let outcome = exec
        .execute_batch(
            &[mrepl_call("c1", args)],
            &exec_ctx_wired(&ws, Some(Arc::clone(&registry)), None),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    let r = &outcome.results[0];
    assert_eq!(
        r.error_kind,
        Some(ToolErrorKind::ExecutionFailed),
        "冲突必须被分类为执行失败"
    );
    let msg = r.error_message.as_deref().unwrap_or_default();
    assert!(msg.contains("写路径互斥冲突"), "错误必须为互斥冲突：{msg}");
    assert!(msg.contains("runA"), "错误必须指明占用者：{msg}");
    assert_eq!(
        ws.read_file("docs/readme.md"),
        "line one\nline two\n",
        "冲突拒绝时不得写盘"
    );
}

// ==================== 组 2：备份覆盖（安全铁律 backup.rs:3-8） ====================

/// 引擎层：multi_replace 写前快照登记（.crish-trash）→ 模拟写坏 →
/// restore_force 覆盖恢复 → 内容还原
///
/// 对齐 backup.rs:396-418（backup_snapshot_restore_force_roundtrip）消费侧
/// 闭环：中间件链经执行器 with_middleware 注入（对齐 loop/mod.rs:333 装配链），
/// 快照兜底落回收站域。依赖 T-EG-05 装配时教 BackupMiddleware 识别
/// target_file 入参（F5 轮次报告 L1：backup.rs:117 现只读 input["path"]，
/// multi_replace 入参为 target_file，当前走「无 path → 无备份义务」分支——
/// E-A2 修复后本用例转绿）。
#[tokio::test]
async fn multi_replace_snapshot_and_restore_force_roundtrip() {
    let ws = TempWorkspace::new("e01_mr_backup");
    ws.write_file("doc.txt", "good version\n");
    // 中间件链：默认备份名单（write_file + multi_replace_file_content，
    // backup.rs:45-50）；trash_root=None → 执行期回退工作区 .crish-trash
    let exec = ToolExecutor::new(builtin_registry()).with_middleware(vec![Arc::new(
        BackupMiddleware::with_defaults(None),
    )]);

    // 本次 multi_replace 即「写坏」动作：把好版本替换为坏版本
    let args = json!({
        "target_file": "doc.txt",
        "replacement_chunks": [
            { "start_line": 1, "end_line": 1, "target_content": "good version", "replacement_content": "bad version" }
        ]
    });
    let outcome = exec
        .execute_batch(
            &[mrepl_call("c1", args)],
            &exec_ctx(&ws),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert!(outcome.results[0].is_ok(), "multi_replace 应执行成功");

    // 写前快照已登记（.crish-trash 内一份快照条目，模式 Snapshot）
    let svc = TrashService::new(ws.path().join(".crish-trash"));
    let entries = svc.list();
    assert_eq!(entries.len(), 1, "multi_replace 写前必须登记一份快照");
    assert_eq!(entries[0].mode, EntryMode::Snapshot, "写前备份为快照模式");
    assert_eq!(ws.read_file("doc.txt"), "bad version\n", "工具已覆盖写入坏版本");

    // 覆盖式恢复（快照条目专用 restore_force）：内容还原 + 登记清除
    svc.restore_force(&entries[0].id).unwrap();
    assert_eq!(ws.read_file("doc.txt"), "good version\n", "restore_force 必须还原快照内容");
    assert!(svc.list().is_empty(), "恢复后登记清除");
}

// ==================== 组 3：幂等（同参重试不重复执行） ====================

/// 引擎层：同 chunk 集合二次调用 → Deduplicated（对齐 executor.rs:277-299）
///
/// 经引擎执行器 + 幂等守卫全链路：同 run/session 域 + 同参数规范 hash →
/// 键一致 → 第二次去重（未真正执行、文件不被二次改写、输出带
/// deduplicated 标记）。本用例不依赖 T-EG-06 装配，独立全绿。
#[tokio::test]
async fn multi_replace_second_call_deduplicated() {
    let ws = TempWorkspace::new("e01_mr_idem");
    ws.write_file("src/component.ts", COMPONENT_TS_INITIAL);
    let guard = Arc::new(ToolIdempotencyGuard::new());
    let exec = ToolExecutor::new(builtin_registry()).with_idempotency(guard);
    let ctx = exec_ctx(&ws);
    let opts = ToolBatchOptions::default();

    // 第一次调用：真正执行，三块全部生效
    let first = exec
        .execute_batch(&[mrepl_call("c1", golden_args("src/component.ts"))], &ctx, None, &opts, None)
        .await;
    assert!(first.results[0].is_ok(), "第一次调用应执行成功");
    assert_eq!(first.results[0].output["chunksApplied"], 3);
    assert_eq!(ws.read_file("src/component.ts"), COMPONENT_TS_EXPECTED);

    // 第二次调用（同 chunk 集合）：幂等去重，不再执行
    let second = exec
        .execute_batch(&[mrepl_call("c2", golden_args("src/component.ts"))], &ctx, None, &opts, None)
        .await;
    let r = &second.results[0];
    assert!(r.is_ok(), "去重仍按成功收场");
    assert_eq!(r.output["json"]["deduplicated"], true, "输出必须带 deduplicated 标记");
    assert!(
        r.output["text"].as_str().unwrap().contains("skipped re-execution"),
        "输出文本必须说明跳过重执行"
    );
    // 文件内容保持第一次的结果（未被二次改写）
    assert_eq!(ws.read_file("src/component.ts"), COMPONENT_TS_EXPECTED);
}

// ==================== 组 4：探索配额（C5：配额耗尽后拒绝写文档） ====================

/// 契约层：配额耗尽后借 multi_replace 写文档 → 被 guard 拒绝
///
/// 对齐 explore_quota.rs:482-519（write_file_enforces_quota_end_to_end）的
/// multi_replace 版本：消耗一次（quota=1）后配额已用尽，写文档被拒
/// （结构化错误含配额语义与回报指引）、不得写盘；非探索类（无配额上下文）
/// 不受约束（对齐 explore_quota.rs:523-534）。
#[tokio::test]
async fn multi_replace_rejects_exhausted_quota_via_wired_ctx() {
    let ws = TempWorkspace::new("e01_mr_quota_ctx");
    ws.write_file("src/component.ts", COMPONENT_TS_INITIAL);
    let store = Arc::new(InMemoryExploreDocsQuotaStore::new());
    // 先消耗一次：consumed=1 >= quota=1 → 配额已用尽（对齐 explore_quota.rs:132-142）
    store.consume("sess-q", "run-researcher").unwrap();
    let ctx = ToolContext {
        workspace_root: ws.path().clone(),
        explore_docs_quota: Some(ExploreDocsQuotaContext {
            session_id: "sess-q".to_string(),
            run_id: "run-researcher".to_string(),
            granted: true,
            quota: 1,
            store: Some(Arc::clone(&store) as Arc<dyn ExploreDocsQuotaStore>),
        }),
        ..create_mock_tool_context()
    };

    let err = multi_replace_tool()
        .execute(&ctx, golden_args("src/component.ts"))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.execution_failed", "配额拒绝复用执行失败码");
    assert!(err.to_string().contains("配额已用尽"), "错误必须指明配额语义");
    assert!(err.to_string().contains("回报主 agent"), "错误必须含回报指引");
    assert_eq!(
        ws.read_file("src/component.ts"),
        COMPONENT_TS_INITIAL,
        "超配额拒绝时不得写盘"
    );

    // 非探索类（无配额上下文）不受约束：同一调用放行（对齐 explore_quota.rs:523-534）
    let plain = ToolContext {
        workspace_root: ws.path().clone(),
        ..create_mock_tool_context()
    };
    multi_replace_tool()
        .execute(&plain, golden_args("src/component.ts"))
        .await
        .unwrap();
    assert_eq!(ws.read_file("src/component.ts"), COMPONENT_TS_EXPECTED);
}

/// 引擎层：配额耗尽后经引擎执行器借 multi_replace 写文档 → 被 guard 拒绝
///
/// 依赖 T-EG-06 装配（tool_exec.rs:670-687：ExploreDocsQuotaContext 含配额
/// store 注入引擎执行上下文）；装配完成后本用例转绿。配额错误码为
/// tool.execution_failed（explore_quota.rs:157-159），经执行器分类为
/// ToolErrorKind::ExecutionFailed，断言以错误文案为准。
#[tokio::test]
async fn multi_replace_quota_exhaustion_through_engine_executor() {
    let ws = TempWorkspace::new("e01_mr_quota_engine");
    ws.write_file("doc1.md", "发现一\n");
    let exec = ToolExecutor::new(builtin_registry());
    let opts = ToolBatchOptions::default();
    // 配额上下文（T-EG-06 契约：配额 store 实例注入执行上下文；quota=1
    // 首份消耗后即耗尽）
    let quota_ctx = ExploreDocsQuotaContext {
        session_id: "sess-1".to_string(),
        run_id: "run-B".to_string(),
        granted: true,
        quota: 1,
        store: Some(Arc::new(InMemoryExploreDocsQuotaStore::new())),
    };

    // 第 1 份写盘成功（配额消耗 +1）
    let args1 = json!({
        "target_file": "doc1.md",
        "replacement_chunks": [
            { "start_line": 1, "end_line": 1, "target_content": "发现一", "replacement_content": "发现（已更新）" }
        ]
    });
    let first = exec
        .execute_batch(
            &[mrepl_call("c1", args1)],
            &exec_ctx_wired(&ws, None, Some(quota_ctx.clone())),
            None,
            &opts,
            None,
        )
        .await;
    assert!(first.results[0].is_ok(), "第 1 份（配额内）应执行成功");

    // 第 2 份（配额耗尽）→ 被 guard 拒绝，不写盘
    ws.write_file("doc2.md", "发现二\n");
    let args2 = json!({
        "target_file": "doc2.md",
        "replacement_chunks": [
            { "start_line": 1, "end_line": 1, "target_content": "发现二", "replacement_content": "发现（已更新）" }
        ]
    });
    let second = exec
        .execute_batch(
            &[mrepl_call("c2", args2)],
            &exec_ctx_wired(&ws, None, Some(quota_ctx)),
            None,
            &opts,
            None,
        )
        .await;
    let r = &second.results[0];
    assert_eq!(
        r.error_kind,
        Some(ToolErrorKind::ExecutionFailed),
        "超配额必须被分类为执行失败"
    );
    let msg = r.error_message.as_deref().unwrap_or_default();
    assert!(msg.contains("配额已用尽"), "错误必须指明配额已用尽：{msg}");
    assert_eq!(ws.read_file("doc2.md"), "发现二\n", "超配额拒绝时不得写盘");
}
