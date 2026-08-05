//! G02 端到端验收集成测试（T-EG-13）——多 Agent 协作文档产出
//!
//! 任务书：docs/feature-gap-analysis/plans/04-EG编辑工具与文档工作区方案.md
//! §5.3.2 T-EG-13（:804-815）；目标时序形态：docs/feature-gap-analysis/
//! REQ-EG-现状分析.md 5.8（:638-662）；验收映射：5.7（REQ-G02:833-835）。
//!
//! 四组场景：
//! 1. 并行放行：主控 resolve_output_dir 得产出目录 → spawn A/B（各自声明
//!    产出目录下的写路径）→ A/B 并行 write_file 不同文件（01-kernel-analysis.md
//!    / 02-frontend.md）→ 放行（write_paths.rs:636-646 兄弟文件语义）+
//!    惰性创建（resolve 后目录不存在，首次写入自动创建）；
//! 2. 冲突拒绝：B 误写 A 的文件 → `tool.write_path_conflict`
//!    （write_paths.rs:92-115 载荷含谁占用/何时；write_paths.rs:606-623）；
//! 3. 汇总索引：主控 list_dir + write_file 生成 00-summary.md（现状分析
//!    5.4 第 3 条最小方案：不新增 list_outputs 工具，REQ-EG-现状分析.md:601）；
//! 4. 探索配额：探索类子代理配额耗尽后写第二份文档被 guard 拒绝
//!    （tools/fs.rs:332 guard_explore_docs_write 接线点）。
//!
//! 依赖矩阵（本轮与 G-A1/G-A3 并行编写，契约先行；不满足项登记轮次报告）：
//! - T-EG-06（引擎总接线，F7 已落地）：write_claims / explore_docs_quota 经
//!   ToolExecCtx 注入——用例 1/2/3/4 引擎层执行依赖，已满足；
//! - T-EG-08（resolve_output_dir 工具 + OutputWorkspace 服务，G-A1 域）：
//!   未落地（output_dir.rs 与 ToolContext.output_dir 均不存在）→ 用例 1 的
//!   resolve 段走「契约模拟」分支（注册表出现该工具后自动切换真实调用，
//!   无需改测试），登记轮次报告；
//! - T-EG-09（产出目录注入段，G-A2 域）：subagent_inject.rs 已实现
//!   output_dir_section（工作区改动）——测试面不直接依赖，轮末门禁快照验证；
//! - T-EG-10（wait_subagents outputFiles 载荷，G-A3 域）：未落地
//!   （wait_subagents.rs 无 SubagentOutput）→ 用例 3 的 outputFiles 断言以
//!   磁盘实测（行数/字节）等价构造清单表，登记轮次报告；
//! - T-EG-12（G03 清理链路，G-A5 域）：壳层行为，测试面不直接依赖。
//!
//! 层级说明（对齐 e01_multi_replace_integration.rs 模式）：全部经
//! ToolExecutor 引擎层执行（真实内置注册表 + 写路径互斥 + 配额守卫）；
//! 子代理语义 = 独立 run_id + spawn 级长期声明（write_paths.rs 模块头 M2）。

use std::sync::Arc;

use agent_tools::context::ExploreDocsQuotaContext;
use agent_tools::explore_quota::{ExploreDocsQuotaStore, InMemoryExploreDocsQuotaStore};
use agent_tools::register_builtin_tools;
use agent_tools::registry::ToolRegistry;
use agent_tools::write_paths::{ClaimMode, WritePathRegistry};
use conex_test_utils::TempWorkspace;
use conex_types::tool::{ToolBatchCall, ToolCategory, ToolConcurrency};
use serde_json::json;
use session_loop::{
    ClassifiedToolResult, ToolBatchOptions, ToolErrorKind, ToolExecCtx, ToolExecutor,
};

/// 写文件工具注册名（注册表键；对齐 tools/fs.rs:265 WriteFileTool::new）
const WRITE_FILE_TOOL: &str = "write_file";

/// 列目录工具注册名（对齐 tools/fs.rs:475）
const LIST_DIR_TOOL: &str = "list_dir";

/// 产出目录解析工具注册名（T-EG-08 契约键；注册表缺省 = 未装配，用例走
/// 契约模拟分支，见 [resolve_output_dir_contract]）
const RESOLVE_OUTPUT_DIR_TOOL: &str = "resolve_output_dir";

/// 会话标识（测试统一会话域；写路径互斥与配额均按会话隔离）
const SESSION_ID: &str = "sess-g02-e2e";

/// 子代理 A 产出文件名（约定 NN-<模块标题>.md，00 留给汇总索引，§4.5）
const SUBFILE_A: &str = "01-kernel-analysis.md";

/// 子代理 B 产出文件名
const SUBFILE_B: &str = "02-frontend.md";

/// 汇总索引文件名（固定 00 前缀，§4.5）
const SUMMARY_FILE: &str = "00-summary.md";

/// 子代理 A 产出内容（中文文档，3 行）
const KERNEL_CONTENT: &str = "内核模块分析\n第 1 行\n第 2 行\n";

/// 子代理 B 产出内容（中文文档，4 行）
const FRONTEND_CONTENT: &str = "前端组件分析\n第 1 行\n第 2 行\n第 3 行\n";

/// 新建内置工具注册表（含 write_file / list_dir，mod.rs 注册面）
fn builtin_registry() -> Arc<ToolRegistry> {
    let mut reg = ToolRegistry::new();
    register_builtin_tools(&mut reg).expect("内置工具注册失败");
    Arc::new(reg)
}

/// 构造批内单工具调用（串行 + 文件系统类别，对齐 e01 模式）
fn tool_call(id: &str, tool_name: &str, args: serde_json::Value) -> ToolBatchCall {
    ToolBatchCall {
        id: id.to_string(),
        tool_name: tool_name.to_string(),
        summary: "G02 集成测试调用".to_string(),
        input: args,
        category: ToolCategory::Filesystem,
        concurrency: ToolConcurrency::Sequential,
    }
}

/// write_file 调用（新文件：默认拒绝覆盖语义下不存在即放行）
fn write_call(id: &str, path: &str, content: &str) -> ToolBatchCall {
    tool_call(
        id,
        WRITE_FILE_TOOL,
        json!({ "path": path, "content": content }),
    )
}

/// write_file 调用（显式 overwrite=true：已存在文件覆盖放行，REQ-E02）
fn write_call_overwrite(id: &str, path: &str, content: &str) -> ToolBatchCall {
    tool_call(
        id,
        WRITE_FILE_TOOL,
        json!({ "path": path, "content": content, "overwrite": true }),
    )
}

/// list_dir 调用（只读查询，无写路径声明）
fn list_call(id: &str, path: &str) -> ToolBatchCall {
    tool_call(id, LIST_DIR_TOOL, json!({ "path": path }))
}

/// 引擎执行上下文：workspace_root 与 cwd 同指临时工作区；run_id 即写声明
/// 持有者（tool_exec.rs:732 装配：write_claim_holder = run_id）
fn exec_ctx(
    ws: &TempWorkspace,
    run_id: &str,
    write_claims: Option<Arc<WritePathRegistry>>,
    explore_docs_quota: Option<ExploreDocsQuotaContext>,
) -> ToolExecCtx {
    ToolExecCtx {
        run_id: run_id.to_string(),
        session_id: SESSION_ID.to_string(),
        cwd: Some(ws.path_str()),
        parent_run_id: None,
        workspace_root: Some(ws.path().clone()),
        write_claims,
        explore_docs_quota,
        // T-EG-08：产出目录解析器（G01 契约）——集成测试注入真实
        // OutputWorkspace（InMemory store，工作区根同源），resolve 段
        // 走真实工具分支并断言日期前缀
        output_dir: Some(Arc::new(
            agent_tools::tools::output_dir::OutputWorkspace::new(
                ws.path().clone(),
                Arc::new(agent_tools::tools::output_dir::InMemoryOutputDirStore::new()),
            ),
        )),
    }
}

/// 单调用引擎层执行（默认批选项；返回批内唯一结果）
async fn run_single(
    exec: &ToolExecutor,
    ctx: &ToolExecCtx,
    call: &ToolBatchCall,
) -> ClassifiedToolResult {
    let outcome = exec
        .execute_batch(
            std::slice::from_ref(call),
            ctx,
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    outcome.results.into_iter().next().expect("批内必须有结果")
}

/// 主控 resolve_output_dir 契约执行点（T-EG-08 装配面；返回产出目录相对路径）
///
/// - T-EG-08 已落地（注册表含 resolve_output_dir 工具）→ 真实工具调用：
///   断言目录名日期前缀格式 `^\d{4}-\d{2}-\d{2}-`（§4.4 契约，本地时区
///   零填充）、userSpecified=false、dirCreated=false 且目录未创建（惰性）；
/// - T-EG-08 未落地（当前状态）→ 按契约草案在测试内生成
///   `.agent-outputs/<session_id>/` 并 warn 登记；T-EG-08 落地后本函数
///   自动切换真实分支，无需改测试（编译对齐偏差登记见轮次报告）。
async fn resolve_output_dir_contract(
    exec: &ToolExecutor,
    reg: &ToolRegistry,
    ws: &TempWorkspace,
) -> String {
    if reg.get(RESOLVE_OUTPUT_DIR_TOOL).is_some() {
        // 真实分支（T-EG-08 落地后生效）：主控身份调用，无 folder → 默认生成
        let ctx = exec_ctx(ws, "run-main", None, None);
        let r = run_single(
            exec,
            &ctx,
            &tool_call("r1", RESOLVE_OUTPUT_DIR_TOOL, json!({})),
        )
        .await;
        assert!(
            r.is_ok(),
            "resolve_output_dir 必须执行成功：{:?}",
            r.error_message
        );
        let out = &r.output;
        let path = out["path"]
            .as_str()
            .expect("resolve_output_dir 输出必须含 path");
        assert_eq!(out["userSpecified"], false, "默认生成非用户指定");
        assert_eq!(out["dirCreated"], false, "惰性：解析不创建目录");
        // 目录名日期前缀（§4.4：`<YYYY-MM-DD>-<session_id>`，本地时区零填充）
        let dir_name = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default();
        let b = dir_name.as_bytes();
        let date_prefixed = b.len() > 10
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[4] == b'-'
            && b[5..7].iter().all(u8::is_ascii_digit)
            && b[7] == b'-'
            && b[8..10].iter().all(u8::is_ascii_digit)
            && b[10] == b'-';
        assert!(
            date_prefixed,
            "产出目录名必须带本地时区日期前缀 YYYY-MM-DD-（§4.4 契约）：{dir_name}"
        );
        assert!(
            !ws.path().join(path.trim_end_matches('/')).exists(),
            "惰性创建：解析后目录不得存在（首次写入才创建）"
        );
        path.trim_end_matches('/').to_string()
    } else {
        tracing::warn!(
            "G-A6(T-EG-13): resolve_output_dir 未装配（T-EG-08 未落地），本用例 resolve 段走契约模拟分支"
        );
        format!(".agent-outputs/{SESSION_ID}")
    }
}

/// G02 场景 spawn + 并行产出辅助（对齐 5.8 时序第 2/3 步）：
/// A/B 各自声明产出目录下的文件级长期写路径（兄弟文件语义，write_paths.rs
/// 模块头 M2：子代理 spawn 声明、run 结束释放）→ 并行 write_file 各自文件
/// → 断言放行 + 惰性建目录。返回（注册表、A 文件、B 文件相对路径）。
async fn spawn_and_write_collab(
    ws: &TempWorkspace,
    out_rel: &str,
) -> (Arc<WritePathRegistry>, String, String) {
    let registry = Arc::new(WritePathRegistry::new(SESSION_ID, ws.path()));
    let rel_a = format!("{out_rel}/{SUBFILE_A}");
    let rel_b = format!("{out_rel}/{SUBFILE_B}");
    // 子代理 A/B 长期声明各自分配的文件（spawn 级写路径；guard 存续至本
    // 函数返回 = 子代理 run 结束释放，对齐 write_paths.rs:5-8 模块头 M2）
    let _a_guard = registry
        .claim_one("runA", &rel_a, ClaimMode::Write)
        .unwrap();
    let _b_guard = registry
        .claim_one("runB", &rel_b, ClaimMode::Write)
        .unwrap();
    assert_eq!(
        registry.active_claims().len(),
        2,
        "spawn 级声明必须同时存续在册"
    );
    let exec = ToolExecutor::new(builtin_registry());
    let ctx_a = exec_ctx(ws, "runA", Some(Arc::clone(&registry)), None);
    let ctx_b = exec_ctx(ws, "runB", Some(Arc::clone(&registry)), None);
    // 并行执行（同一产出目录、不同文件 → 兄弟文件语义放行，write_paths.rs:636-646；
    // 执行期声明与 spawn 声明同 holder 合并续期，互不冲突）
    let call_a = write_call("a1", &rel_a, KERNEL_CONTENT);
    let call_b = write_call("b1", &rel_b, FRONTEND_CONTENT);
    let (ra, rb) = tokio::join!(
        run_single(&exec, &ctx_a, &call_a),
        run_single(&exec, &ctx_b, &call_b),
    );
    assert!(
        ra.is_ok(),
        "A 写 01 必须放行（兄弟文件语义）：{:?}",
        ra.error_message
    );
    assert!(
        rb.is_ok(),
        "B 写 02 必须放行（兄弟文件语义）：{:?}",
        rb.error_message
    );
    assert_eq!(ws.read_file(&rel_a), KERNEL_CONTENT, "A 产出内容必须落盘");
    assert_eq!(ws.read_file(&rel_b), FRONTEND_CONTENT, "B 产出内容必须落盘");
    // 惰性创建落盘：产出目录由首次 write_file 的 ensure_parent_dir 自动创建
    assert!(
        ws.path().join(out_rel).is_dir(),
        "首次写入必须自动创建产出目录"
    );
    // 执行期声明随工具执行结束释放（临时声明随守卫 Drop 释放，不残留记账；
    // spawn 级守卫随后 drop 幂等）
    assert!(registry.active_claims().is_empty());
    (registry, rel_a, rel_b)
}

/// 从产出文件名推导标题（`NN-<标题>.md` → 标题；对齐 §4.5 命名约定）
fn title_of(file_name: &str) -> String {
    let after_prefix = file_name.splitn(2, '-').nth(1).unwrap_or(file_name);
    after_prefix.trim_end_matches(".md").to_string()
}

// ==================== 场景 1：并行写不同文件放行（REQ-G02:833） ====================

/// 主控 resolve_output_dir 得产出目录 → spawn A/B（各声明产出目录下的写路径）
/// → A/B 并行 write_file 不同文件 → 放行；惰性创建：resolve 后目录不存在、
/// 首次写入自动创建（REQ-G01:811）。
///
/// 依赖 T-EG-08（resolve 段，当前走契约模拟分支）与 T-EG-06（写路径互斥
/// 接线，已满足）；子代理声明语义对齐 write_paths.rs:636-646 兄弟文件测试。
#[tokio::test]
async fn g02_parallel_siblings_writes_allowed() {
    let ws = TempWorkspace::new("g02_parallel");
    let reg = builtin_registry();
    let exec = ToolExecutor::new(Arc::clone(&reg));
    // 主控 resolve_output_dir（T-EG-08 装配面契约执行点）
    let out_rel = resolve_output_dir_contract(&exec, &reg, &ws).await;
    // 惰性创建前置断言：resolve 后目录不得存在（REQ-G01:811 验收）
    assert!(
        !ws.path().join(&out_rel).exists(),
        "resolve 只记录路径不创建目录（惰性）"
    );
    // spawn A/B + 并行产出（同目录不同文件 → 放行）
    let (_registry, rel_a, rel_b) = spawn_and_write_collab(&ws, &out_rel).await;
    assert!(ws.path().join(&rel_a).is_file());
    assert!(ws.path().join(&rel_b).is_file());
}

// ==================== 场景 2：B 误写 A 文件 → 冲突拒绝（REQ-G02:834） ====================

/// B 误写 A 已声明的文件 → `tool.write_path_conflict`（载荷含谁占用/何时，
/// write_paths.rs:92-115）；错误分类为执行失败（tool_exec.rs 兜底分支）、
/// 不得写盘。互斥检查先于覆盖保护（fs.rs:319→323 顺序）：冲突优先返回
/// 互斥错误而非 file_exists。A 释放后 B 显式 overwrite 重试成功（REQ-E02）。
#[tokio::test]
async fn g02_wrong_file_write_conflict() {
    let ws = TempWorkspace::new("g02_conflict");
    let out_rel = format!(".agent-outputs/{SESSION_ID}");
    let rel_a = format!("{out_rel}/{SUBFILE_A}");
    let registry = Arc::new(WritePathRegistry::new(SESSION_ID, ws.path()));
    let exec = ToolExecutor::new(builtin_registry());
    let ctx_main = exec_ctx(&ws, "run-main", Some(Arc::clone(&registry)), None);
    let ctx_b = exec_ctx(&ws, "runB", Some(Arc::clone(&registry)), None);

    // 主控已产出 01（A 尚未接管前的既有文档；主控执行期声明随调用结束释放）
    let rm = run_single(&exec, &ctx_main, &write_call("m1", &rel_a, KERNEL_CONTENT)).await;
    assert!(rm.is_ok(), "主控首次产出必须成功：{:?}", rm.error_message);

    // 子代理 A：spawn 级长期声明 01 文件（M2 语义：守卫由调度器持有到
    // run 结束，A run 期间 B 任何时刻写该文件都被拦截）
    let a_guard = registry
        .claim_one("runA", &rel_a, ClaimMode::Write)
        .unwrap();

    // 子代理 B：误写 A 的文件 → 冲突拒绝（执行期声明与 A 的长期声明重叠；
    // 互斥检查先于 overwrite 检查，错误必须是冲突而非 file_exists）
    let rb = run_single(&exec, &ctx_b, &write_call("b1", &rel_a, FRONTEND_CONTENT)).await;
    assert_eq!(
        rb.error_kind,
        Some(ToolErrorKind::ExecutionFailed),
        "冲突必须被分类为执行失败"
    );
    let msg = rb.error_message.as_deref().unwrap_or_default();
    assert!(
        msg.contains("写路径互斥冲突"),
        "错误必须为互斥冲突而非覆盖保护：{msg}"
    );
    assert!(msg.contains("runA"), "错误必须指明占用者：{msg}");
    assert_eq!(
        ws.read_file(&rel_a),
        KERNEL_CONTENT,
        "冲突拒绝时不得覆盖 A 的产出"
    );
    // A 的 spawn 级声明仍在册；B 的执行期声明随执行结束释放（不残留记账）
    let claims = registry.active_claims();
    let holders: Vec<String> = claims.iter().map(|c| c.holder.clone()).collect();
    assert_eq!(holders, ["runA".to_string()], "仅 A 的 spawn 级声明存活");

    // A 释放后 B 显式 overwrite 重试成功（覆盖放行，REQ-E02 语义）
    drop(a_guard);
    let rb2 = run_single(
        &exec,
        &ctx_b,
        &write_call_overwrite("b2", &rel_a, FRONTEND_CONTENT),
    )
    .await;
    assert!(
        rb2.is_ok(),
        "释放后同调用重试必须成功：{:?}",
        rb2.error_message
    );
    assert_eq!(ws.read_file(&rel_a), FRONTEND_CONTENT, "重试必须完成覆盖");
}

// ==================== 场景 3：汇总索引（REQ-G02:835） ====================

/// await-all 终态后主控汇总：list_dir 列产出 → write_file 生成 00-summary.md
/// （清单表：文件名/标题/行数/摘要）→ 断言索引内容；二次 overwrite=true
/// 覆盖生成更新版索引（§4.5 约定：00 留汇总索引、最小方案不新增 list_outputs）。
///
/// outputFiles 载荷（path/summary/bytes）由 T-EG-10 在 wait_subagents 终态
/// 携带（引擎强制收集）；T-EG-10 未落地，本用例按磁盘实测（行数/字节）
/// 等价构造清单表——载荷字段与磁盘同源，落地后可直接替换数据来源。
#[tokio::test]
async fn g02_summary_index_via_list_and_write() {
    let ws = TempWorkspace::new("g02_summary");
    // 主控 resolve + spawn A/B 并行产出（复用场景 1 流程）
    let reg = builtin_registry();
    let exec = ToolExecutor::new(Arc::clone(&reg));
    let out_rel = resolve_output_dir_contract(&exec, &reg, &ws).await;
    let (registry, rel_a, rel_b) = spawn_and_write_collab(&ws, &out_rel).await;

    // ── 主控（run-main，无配额上下文）：list_dir 列产出目录 ──
    let ctx_main = exec_ctx(&ws, "run-main", Some(Arc::clone(&registry)), None);
    let lr = run_single(&exec, &ctx_main, &list_call("l1", &out_rel)).await;
    assert!(lr.is_ok(), "list_dir 必须成功：{:?}", lr.error_message);
    let items = lr.output["items"]
        .as_array()
        .expect("list_dir 必须返回 items 数组");
    let names: Vec<&str> = items.iter().filter_map(|it| it["name"].as_str()).collect();
    assert!(
        names.iter().any(|n| *n == SUBFILE_A),
        "清单必须含 A 产出：{names:?}"
    );
    assert!(
        names.iter().any(|n| *n == SUBFILE_B),
        "清单必须含 B 产出：{names:?}"
    );
    let size_a = items
        .iter()
        .find(|it| it["name"] == SUBFILE_A)
        .and_then(|it| it["size"].as_u64())
        .expect("A 产出条目必须含字节数");
    assert!(size_a > 0, "A 产出字节数必须大于 0");

    // ── 主控汇总索引：按清单表约定生成 00-summary.md（§4.5 第 2 条）──
    // 摘要取首行、行数/字节取磁盘实测（等价 T-EG-10 outputFiles 载荷来源）
    let line_a = ws.read_file(&rel_a).lines().count();
    let line_b = ws.read_file(&rel_b).lines().count();
    let summary_a = ws
        .read_file(&rel_a)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let summary_b = ws
        .read_file(&rel_b)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let index_content = format!(
        "# 产出汇总索引\n\n\
         | 文件名 | 标题 | 行数 | 摘要 |\n\
         | --- | --- | --- | --- |\n\
         | {SUBFILE_A} | {} | {line_a} | {summary_a} |\n\
         | {SUBFILE_B} | {} | {line_b} | {summary_b} |\n",
        title_of(SUBFILE_A),
        title_of(SUBFILE_B),
    );
    let sum_rel = format!("{out_rel}/{SUMMARY_FILE}");
    let w1 = run_single(
        &exec,
        &ctx_main,
        &write_call("s1", &sum_rel, &index_content),
    )
    .await;
    assert!(w1.is_ok(), "首次写入索引必须成功：{:?}", w1.error_message);
    assert_eq!(
        ws.read_file(&sum_rel),
        index_content,
        "索引文件内容必须与清单表一致"
    );

    // 二次覆盖生成更新版索引（overwrite=true 放行，对齐 §4.5 write_file
    // overwrite=true 约定；REQ-E02 显式覆盖语义）
    let index_v2 = format!("# 产出汇总索引（更新版）\n\n{index_content}");
    let w2 = run_single(
        &exec,
        &ctx_main,
        &write_call_overwrite("s2", &sum_rel, &index_v2),
    )
    .await;
    assert!(w2.is_ok(), "覆盖生成索引必须成功：{:?}", w2.error_message);
    assert_eq!(ws.read_file(&sum_rel), index_v2, "索引必须被更新版覆盖");

    // 终态复核：list_dir 再次列出产出目录，00-summary.md 已出现
    let lr2 = run_single(&exec, &ctx_main, &list_call("l2", &out_rel)).await;
    let names2: Vec<&str> = lr2.output["items"]
        .as_array()
        .expect("list_dir 必须返回 items 数组")
        .iter()
        .filter_map(|it| it["name"].as_str())
        .collect();
    assert!(
        names2.iter().any(|n| *n == SUMMARY_FILE),
        "汇总索引必须出现在产出目录：{names2:?}"
    );
}

// ==================== 场景 4：探索配额（fs.rs:189 语义） ====================

/// 探索类子代理（read-only 能力模式）配额耗尽后写第二份文档被 guard 拒绝
/// （tools/fs.rs:332 guard_explore_docs_write；quota=1 时首份消耗即耗尽，
/// 第二份拒绝且不写盘、不建目录）；非探索类（无配额上下文）不受约束。
#[tokio::test]
async fn g02_explore_quota_second_doc_rejected() {
    let ws = TempWorkspace::new("g02_quota");
    let out_rel = format!(".agent-outputs/{SESSION_ID}");
    let doc1 = format!("{out_rel}/01-findings.md");
    let doc2 = format!("{out_rel}/02-findings.md");
    let exec = ToolExecutor::new(builtin_registry());
    let store = Arc::new(InMemoryExploreDocsQuotaStore::new());
    // 探索类子代理配额上下文（凭证 + 上限 1；T-EG-06 契约：store 实例注入）
    let quota_ctx = ExploreDocsQuotaContext {
        session_id: SESSION_ID.to_string(),
        run_id: "run-researcher".to_string(),
        granted: true,
        quota: 1,
        store: Some(Arc::clone(&store) as Arc<dyn ExploreDocsQuotaStore>),
    };
    let ctx_res = exec_ctx(&ws, "run-researcher", None, Some(quota_ctx));

    // 第 1 份文档（配额内）→ 放行，配额计数 +1
    let first = run_single(&exec, &ctx_res, &write_call("q1", &doc1, "发现一\n")).await;
    assert!(
        first.is_ok(),
        "第 1 份（配额内）必须放行：{:?}",
        first.error_message
    );
    assert_eq!(
        store.snapshot(SESSION_ID).consumed,
        1,
        "首份写盘后配额计数 +1"
    );
    assert_eq!(
        store.snapshot(SESSION_ID).last_consumer_run_id.as_deref(),
        Some("run-researcher"),
        "消耗登记最近消费者"
    );

    // 第 2 份文档（配额耗尽）→ guard 拒绝：不写盘、不建目录
    let second = run_single(&exec, &ctx_res, &write_call("q2", &doc2, "发现二\n")).await;
    assert_eq!(
        second.error_kind,
        Some(ToolErrorKind::ExecutionFailed),
        "超配额必须被分类为执行失败"
    );
    let msg = second.error_message.as_deref().unwrap_or_default();
    assert!(msg.contains("配额已用尽"), "错误必须指明配额语义：{msg}");
    assert!(msg.contains("回报主 agent"), "错误必须含回报指引：{msg}");
    assert!(!ws.path().join(&doc2).exists(), "超配额拒绝时不得写盘");
    assert_eq!(store.snapshot(SESSION_ID).consumed, 1, "拒绝不消耗配额");

    // 非探索类（主控身份，无配额上下文）写同一路径 → 放行（配额仅约束
    // 探索类，对齐 explore_quota.rs:523-534 边界语义）
    let ctx_main = exec_ctx(&ws, "run-main", None, None);
    let plain = run_single(&exec, &ctx_main, &write_call("q3", &doc2, "发现二\n")).await;
    assert!(
        plain.is_ok(),
        "非探索类不受配额约束：{:?}",
        plain.error_message
    );
    assert_eq!(ws.read_file(&doc2), "发现二\n");
}
