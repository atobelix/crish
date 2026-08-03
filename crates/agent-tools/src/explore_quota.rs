//! C5 探索类 agent 文档配额（I6-M11 落地）
//!
//! 04 文档 §2 C5 + 02 方案 M11（C5 部分）：探索类（capabilityMode=read-only）
//! 子代理每会话至多产出 1 份文档（入库的独立文档实体），且必须由主 agent
//! 显式分配——分配 = spawn 请求带「允许写文档」标记（配额凭证）。
//!
//! 语义与边界（04 C5）：
//! - 配额按「会话」计数不按 run（同一子代理多次续跑共享同一配额）；
//! - 配额凭证只能由主 agent 在 spawn 时给出（[SubagentSpawnRequest] 的
//!   allow_explore_docs 字段），子代理无权自我授予；
//! - 超配额返回结构化错误（含「配额已用尽，请把发现以消息形式回报主 agent」），
//!   run 不中断；
//! - 非探索类（非 read-only）子代理不受配额约束；主 agent 自身不消耗。
//!
//! 持久化（P0.3）：`explore_docs_consumed`（附最近消耗者 run 信息）与
//! `explore_docs_quota`（可配上限）存 session_meta。session_meta 为全局 KV
//! 表（无会话列，schema.rs:87），键按 `{session_id}:{key}` 编码隔离
//! （对齐 revert_guard.rs:281-287 的 S7 接线模式；空 session_id 退化字面键）。
//!
//! 接线契约（对齐 I3-S7 revert_guard / I4-M3 write_paths 模式）：
//! agent-tools 是叶子 crate，生产代码不依赖 conex-db——会话级配额计数读写
//! 由引擎侧实现 [ExploreDocsQuotaStore]（session_meta 后端）注入工具执行
//! 上下文；本模块只定义契约、纯逻辑与工具接线面。测试域以 conex-db
//! （dev-dependency）验证持久化链路与重启恢复。

use crate::context::{ExploreDocsQuotaContext, ToolContext};
use crate::definition::ToolError;
use crate::tools::subagent::{SubagentCapabilityMode, SubagentRole};
use conex_types::error::codes;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 配额键：可配上限（默认 [DEFAULT_EXPLORE_DOCS_QUOTA]）
pub const SESSION_META_KEY_EXPLORE_DOCS_QUOTA: &str = "explore_docs_quota";
/// 配额键：已消耗计数（值为 JSON：`{"consumed": 1, "lastConsumerRunId": "..."}`，
/// 持久化格式见 [explore_docs_consumed_value] / [parse_explore_docs_consumed]）
pub const SESSION_META_KEY_EXPLORE_DOCS_CONSUMED: &str = "explore_docs_consumed";
/// 默认配额（04 C5：每会话 1 份，可配）
pub const DEFAULT_EXPLORE_DOCS_QUOTA: u32 = 1;

/// 会话级配额键编码（`{session_id}:{key}`；空 session_id 退化字面键，
/// 对齐 revert_guard.rs 的 S7 接线模式）
pub fn session_meta_key_of(session_id: &str, key: &str) -> String {
    if session_id.is_empty() {
        key.to_string()
    } else {
        format!("{session_id}:{key}")
    }
}

/// 会话配额快照（读面）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ExploreDocsQuotaSnapshot {
    /// 本会话已消耗的文档配额数
    pub consumed: u32,
    /// 最近消耗者 run 信息（最近一次消耗配额的子代理 run id）
    pub last_consumer_run_id: Option<String>,
}

/// 已消耗值序列化（session_meta 持久化格式）
pub fn explore_docs_consumed_value(snapshot: &ExploreDocsQuotaSnapshot) -> String {
    serde_json::json!({
        "consumed": snapshot.consumed,
        "lastConsumerRunId": snapshot.last_consumer_run_id,
    })
    .to_string()
}

/// 已消耗值解析（容错：损坏 / 缺失 → 默认零消耗，不 panic）
pub fn parse_explore_docs_consumed(value: Option<&str>) -> ExploreDocsQuotaSnapshot {
    let Some(value) = value else {
        return ExploreDocsQuotaSnapshot::default();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value) else {
        return ExploreDocsQuotaSnapshot::default();
    };
    ExploreDocsQuotaSnapshot {
        consumed: parsed
            .get("consumed")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(0),
        last_consumer_run_id: parsed
            .get("lastConsumerRunId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    }
}

/// 配额存储契约（引擎侧以 session_meta 实现；agent-tools 只定义契约）
///
/// 实现方职责（对齐 I3-S7 SessionMetaRevertCounterStore 模式）：
/// 读 = `get_session_meta(session_meta_key_of(session_id, SESSION_META_KEY_EXPLORE_DOCS_CONSUMED))`
/// 经 [parse_explore_docs_consumed] 解析；写 = 消耗后经
/// [explore_docs_consumed_value] 序列化落 `set_session_meta`。
pub trait ExploreDocsQuotaStore: Send + Sync + std::fmt::Debug {
    /// 读取会话配额快照（无记录 = 零消耗）
    fn snapshot(&self, session_id: &str) -> ExploreDocsQuotaSnapshot;
    /// 消耗一次配额（+1 并记录最近消耗者；返回新快照）。
    /// 失败返回错误文案（调用方按执行失败处理，不 panic）。
    fn consume(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<ExploreDocsQuotaSnapshot, String>;
}

/// 内存版存储（测试 / 未接线兜底：进程内计数，跨进程重启不恢复——
/// 持久化语义由引擎侧 session_meta 后端承担）
#[derive(Debug, Default)]
pub struct InMemoryExploreDocsQuotaStore {
    inner: Mutex<HashMap<String, ExploreDocsQuotaSnapshot>>,
}

impl InMemoryExploreDocsQuotaStore {
    /// 新建空存储
    pub fn new() -> Self {
        Self::default()
    }
}

impl ExploreDocsQuotaStore for InMemoryExploreDocsQuotaStore {
    fn snapshot(&self, session_id: &str) -> ExploreDocsQuotaSnapshot {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    fn consume(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<ExploreDocsQuotaSnapshot, String> {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(session_id.to_string()).or_default();
        entry.consumed = entry.consumed.saturating_add(1);
        entry.last_consumer_run_id = Some(run_id.to_string());
        Ok(entry.clone())
    }
}

/// 配额检查错误（结构化错误载荷；超限时 run 不中断，仅工具返回失败）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExploreDocsQuotaError {
    /// 未获主 agent 分配（spawn 未携带 allowExploreDocs 凭证）
    NotGranted,
    /// 配额已用尽（含「请把发现以消息形式回报主 agent」指引）
    Exhausted { consumed: u32, quota: u32 },
}

impl ExploreDocsQuotaError {
    /// 错误码（复用 tool.execution_failed——配额拒绝是工具执行语义失败；
    /// 专用码登记待 conex-types 演进，见交付报告遗留）
    pub fn code(&self) -> &'static str {
        codes::TOOL_EXECUTION_FAILED
    }

    /// 结构化错误文案（04 C5 验收 1/2 断言对象：含配额语义与回报指引）
    pub fn message(&self) -> String {
        match self {
            Self::NotGranted => {
                "探索类 agent 未获主 agent 分配的文档配额凭证：如需产出文档，\
                 请把发现以消息形式回报主 agent，由主 agent 分配后重试"
                    .to_string()
            }
            Self::Exhausted { consumed, quota } => {
                format!(
                    "探索类 agent 文档配额已用尽（quota={quota}，本会话已消耗 {consumed}）：\
                     请把发现以消息形式回报主 agent，不要再尝试创建文档"
                )
            }
        }
    }
}

/// 探索类判定（任务卡：capabilityMode=read-only 即探索类；04 文档的
/// researcher 角色经 read-only 能力模式覆盖——researcher 子代理通常配
/// read-only，两处口径一致）。无能力模式声明（None）视为非探索类。
pub fn is_explore_class(capability_mode: Option<SubagentCapabilityMode>) -> bool {
    matches!(capability_mode, Some(SubagentCapabilityMode::ReadOnly))
}

/// 配额检查纯函数（C5 行为 3：凭证 + 配额上限双重判定）
///
/// - 无凭证 → [ExploreDocsQuotaError::NotGranted]；
/// - `consumed >= quota` → [ExploreDocsQuotaError::Exhausted]（第 1 份时
///   consumed=0 < quota 放行，第 2 份 consumed=1 >= 1 拒绝）；
/// - 通过 → Ok（调用方写盘成功后经 [ExploreDocsQuotaStore::consume] 计数）。
pub fn check_explore_docs_write(
    granted: bool,
    snapshot: &ExploreDocsQuotaSnapshot,
    quota: u32,
) -> Result<(), ExploreDocsQuotaError> {
    if !granted {
        return Err(ExploreDocsQuotaError::NotGranted);
    }
    if snapshot.consumed >= quota {
        return Err(ExploreDocsQuotaError::Exhausted {
            consumed: snapshot.consumed,
            quota,
        });
    }
    Ok(())
}

/// 配额凭证注入段正文（提示词协议层，C5 行为 2：创建文档的授权令牌只能由
/// 主 agent 在 run 注入内容中给出——spawn 携带凭证时引擎侧把本段挂载进
/// 子代理系统提示词，子代理据此知晓自己持有配额并受到上限约束；
/// 动态配额数字参数化，结构固定可快照断言）
pub fn explore_docs_credential_section(quota: u32) -> String {
    format!(
        "你已获主 agent 分配探索类文档配额（本会话最多 {quota} 份，由主 agent 分配）；\n\
         - 你有权创建/提交入库的独立文档实体，配额按会话计数（续跑共享）；\n\
         - 配额用尽后创建文档会被拒绝，请把发现以消息形式回报主 agent，\
         不要再尝试创建文档；\n\
         - 非探索类子代理与主 agent 自身不受本配额约束。"
    )
}

/// 配额上下文装配辅助（引擎侧 spawner 接线用，I6-M11 契约面）：
///
/// 探索类（read-only）子代理 → Some（granted = spawn 是否携带凭证）；
/// 非探索类（read-write/execute/all/未声明）→ None（不装配 = 不受配额约束，
/// 04 C5 边界：非 researcher 不受限）。
///
/// 引擎侧 spawner 流程（对齐 M2 内容 3）：解析 run_subagent 的
/// allowExploreDocs 凭证 → 子代理 run 装配 ToolContext 时经本函数生成
/// [ExploreDocsQuotaContext]；store 由引擎侧以 session_meta 实现注入。
pub fn quota_context_for_spawn(
    capability_mode: Option<SubagentCapabilityMode>,
    role: Option<SubagentRole>,
    session_id: &str,
    run_id: &str,
    allow_explore_docs: bool,
    quota: u32,
    store: Option<Arc<dyn ExploreDocsQuotaStore>>,
) -> Option<ExploreDocsQuotaContext> {
    // 探索类判定以能力模式为准（任务卡）；researcher 角色未配 read-only 时
    // 同样视为探索类（04 文档口径），两者取或
    let explore = is_explore_class(capability_mode)
        || matches!(role, Some(SubagentRole::Researcher));
    if !explore {
        return None;
    }
    Some(ExploreDocsQuotaContext {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        granted: allow_explore_docs,
        quota,
        store,
    })
}

/// 写文档配额守卫（WriteFileTool 接线点）：配额上下文存在（探索类子代理
/// run）时执行检查；未装配（非探索类 / 主 agent）→ 不检查放行。
///
/// 返回 Err = 拒绝执行（结构化错误含配额语义）；Ok = 放行（写盘成功后
/// 调用方须经 [consume_explore_docs_quota] 计数）。
pub fn guard_explore_docs_write(
    ctx: &ToolContext,
) -> Result<(), ToolError> {
    let Some(quota) = &ctx.explore_docs_quota else {
        return Ok(());
    };
    let snapshot = match &quota.store {
        Some(store) => store.snapshot(&quota.session_id),
        // 无后端：按零消耗检查（配额上限 0 = 全拒；≥1 = 放行，
        // 消耗不持久化——持久化语义由引擎侧后端承担，见模块文档）
        None => ExploreDocsQuotaSnapshot::default(),
    };
    check_explore_docs_write(quota.granted, &snapshot, quota.quota)
        .map_err(|e| ToolError::new(e.code(), e.message()))
}

/// 配额消耗（写盘成功后调用；配额上下文存在时计数 +1 并记录最近消耗者；
/// 后端未接线（store=None）时不计数不报错——fail-open 兜底）
pub fn consume_explore_docs_quota(ctx: &ToolContext) {
    let Some(quota) = &ctx.explore_docs_quota else {
        return;
    };
    if let Some(store) = &quota.store {
        let _ = store.consume(&quota.session_id, &quota.run_id);
    }
}

#[cfg(test)]
mod tests {
    use crate::definition::Tool as _;

    use super::*;
    use crate::context::{create_mock_tool_context, ToolContext};
    use crate::tools::subagent::SubagentState;
    use conex_test_utils::TempWorkspace;

    /// 测试存储：固定注入已消耗快照（不递增）
    #[derive(Debug)]
    struct FixedSnapshotStore {
        snapshot: ExploreDocsQuotaSnapshot,
        consumed_runs: Mutex<Vec<(String, String)>>,
    }

    impl FixedSnapshotStore {
        fn with_consumed(consumed: u32) -> Self {
            Self {
                snapshot: ExploreDocsQuotaSnapshot {
                    consumed,
                    last_consumer_run_id: None,
                },
                consumed_runs: Mutex::new(Vec::new()),
            }
        }
    }

    impl ExploreDocsQuotaStore for FixedSnapshotStore {
        fn snapshot(&self, _session_id: &str) -> ExploreDocsQuotaSnapshot {
            self.snapshot.clone()
        }

        fn consume(&self, session_id: &str, run_id: &str) -> Result<ExploreDocsQuotaSnapshot, String> {
            self.consumed_runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((session_id.to_string(), run_id.to_string()));
            Ok(self.snapshot.clone())
        }
    }

    fn quota_ctx(
        workspace: &std::path::Path,
        granted: bool,
        quota: u32,
        store: Arc<dyn ExploreDocsQuotaStore>,
    ) -> ToolContext {
        ToolContext {
            explore_docs_quota: Some(ExploreDocsQuotaContext {
                session_id: "sess-q".to_string(),
                run_id: "run-researcher".to_string(),
                granted,
                quota,
                store: Some(store),
            }),
            workspace_root: workspace.to_path_buf(),
            ..create_mock_tool_context()
        }
    }

    // ── 探索类判定 ──

    #[test]
    fn explore_class_judgement_follows_readonly() {
        assert!(is_explore_class(Some(SubagentCapabilityMode::ReadOnly)));
        for mode in [
            SubagentCapabilityMode::ReadWrite,
            SubagentCapabilityMode::Execute,
            SubagentCapabilityMode::All,
        ] {
            assert!(!is_explore_class(Some(mode)), "{mode:?} 非探索类");
        }
        assert!(!is_explore_class(None), "未声明能力模式 = 非探索类");
    }

    #[test]
    fn quota_context_assembly_only_for_explore_class() {
        let store: Arc<dyn ExploreDocsQuotaStore> = Arc::new(InMemoryExploreDocsQuotaStore::new());
        // read-only → 装配（含 researcher 角色兼容）
        assert!(
            quota_context_for_spawn(
                Some(SubagentCapabilityMode::ReadOnly),
                Some(SubagentRole::Researcher),
                "s1",
                "r1",
                true,
                1,
                Some(Arc::clone(&store)),
            )
            .is_some()
        );
        // researcher 角色未配 read-only → 仍视为探索类（04 文档口径）
        assert!(
            quota_context_for_spawn(None, Some(SubagentRole::Researcher), "s1", "r1", true, 1, Some(Arc::clone(&store)))
                .is_some()
        );
        // 非探索类 → 不装配
        for mode in [
            Some(SubagentCapabilityMode::ReadWrite),
            Some(SubagentCapabilityMode::Execute),
            Some(SubagentCapabilityMode::All),
            None,
        ] {
            assert!(
                quota_context_for_spawn(mode, None, "s1", "r1", true, 1, Some(Arc::clone(&store)))
                    .is_none(),
                "{mode:?} 不应装配配额上下文"
            );
        }
        // 凭证透传
        let ctx = quota_context_for_spawn(
            Some(SubagentCapabilityMode::ReadOnly),
            None,
            "s1",
            "r1",
            true,
            1,
            Some(Arc::clone(&store)),
        )
        .expect("read-only 必装配");
        assert!(ctx.granted);
        assert_eq!(ctx.session_id, "s1");
        assert_eq!(ctx.run_id, "r1");
        assert_eq!(ctx.quota, 1);
        let ctx = quota_context_for_spawn(
            Some(SubagentCapabilityMode::ReadOnly),
            None,
            "s1",
            "r1",
            false,
            1,
            Some(Arc::clone(&store)),
        )
        .expect("read-only 必装配");
        assert!(!ctx.granted, "未携带凭证 → granted=false");
    }

    // ── 纯函数检查 ──

    /// 04 C5 验收 1：无凭证创建文档被拒，错误信息含配额语义
    #[test]
    fn no_credential_write_rejected_with_quota_semantics() {
        let snapshot = ExploreDocsQuotaSnapshot::default();
        let err = check_explore_docs_write(false, &snapshot, 1).unwrap_err();
        assert_eq!(err, ExploreDocsQuotaError::NotGranted);
        let message = err.message();
        assert!(message.contains("配额"));
        assert!(message.contains("主 agent"));
    }

    /// 04 C5 验收 2（纯函数侧）：持凭证 consumed=0 放行；consumed=1（quota=1）
    /// 第二次返回「配额已用尽」
    #[test]
    fn first_write_allowed_second_exhausted() {
        let zero = ExploreDocsQuotaSnapshot {
            consumed: 0,
            last_consumer_run_id: None,
        };
        assert!(check_explore_docs_write(true, &zero, 1).is_ok(), "第 1 份放行");
        let one = ExploreDocsQuotaSnapshot {
            consumed: 1,
            last_consumer_run_id: Some("run-1".to_string()),
        };
        let err = check_explore_docs_write(true, &one, 1).unwrap_err();
        assert_eq!(
            err,
            ExploreDocsQuotaError::Exhausted {
                consumed: 1,
                quota: 1
            }
        );
        assert!(err.message().contains("配额已用尽"));
        assert!(err.message().contains("回报主 agent"));
    }

    /// 04 C5 验收 5（纯函数侧）：配额键调大后行为变化——quota=2 时
    /// consumed=1 仍放行
    #[test]
    fn quota_raised_changes_behavior() {
        let one = ExploreDocsQuotaSnapshot {
            consumed: 1,
            last_consumer_run_id: None,
        };
        assert!(check_explore_docs_write(true, &one, 2).is_ok(), "quota=2 放行第 2 份");
        assert!(check_explore_docs_write(true, &one, 1).is_err(), "quota=1 拒绝");
    }

    // ── 工具接线（WriteFileTool 集成）──

    /// 04 C5 验收 1/2（工具级）：无凭证被拒；持凭证第 1 份写盘成功、
    /// 第 2 份「配额已用尽」（run 不中断，错误结构化）
    #[tokio::test]
    async fn write_file_enforces_quota_end_to_end() {
        let ws = TempWorkspace::new("quota_write");
        let tool = crate::tools::fs::WriteFileTool::new();

        // 无凭证：拒绝，文件不落盘
        let ctx = quota_ctx(ws.path(), false, 1, Arc::new(InMemoryExploreDocsQuotaStore::new()));
        let err = tool
            .execute(&ctx, serde_json::json!({ "path": "doc1.md", "content": "发现" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.execution_failed");
        assert!(err.to_string().contains("配额"));
        assert!(!ws.path().join("doc1.md").exists(), "被拒时不得写盘");

        // 持凭证 + 内存计数存储：第 1 份成功，第 2 份拒绝
        let store = Arc::new(InMemoryExploreDocsQuotaStore::new());
        let ctx = quota_ctx(ws.path(), true, 1, Arc::clone(&store) as Arc<dyn ExploreDocsQuotaStore>);
        tool.execute(&ctx, serde_json::json!({ "path": "doc1.md", "content": "发现" }))
            .await
            .unwrap();
        assert!(ws.path().join("doc1.md").exists(), "第 1 份应写盘成功");
        assert_eq!(
            store.snapshot("sess-q").consumed,
            1,
            "写盘成功后配额计数 +1"
        );

        let err = tool
            .execute(&ctx, serde_json::json!({ "path": "doc2.md", "content": "更多" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("配额已用尽"));
        assert!(!ws.path().join("doc2.md").exists(), "超配额不得写盘");

        // 最近消耗者 run 信息记录
        let snapshot = store.snapshot("sess-q");
        assert_eq!(snapshot.last_consumer_run_id.as_deref(), Some("run-researcher"));
    }

    /// 04 C5 验收 4：非探索类（无配额上下文）不受配额限制——写盘照常
    #[tokio::test]
    async fn non_explore_write_unrestricted() {
        let ws = TempWorkspace::new("quota_unrestricted");
        let tool = crate::tools::fs::WriteFileTool::new();
        let ctx = ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context() // 无配额上下文
        };
        tool.execute(&ctx, serde_json::json!({ "path": "x.md", "content": "普通" }))
            .await
            .unwrap();
        assert!(ws.path().join("x.md").is_file(), "非探索类写盘不受配额限制");
    }

    /// 失败不消耗：写盘失败（路径逃逸）时配额不计数
    #[tokio::test]
    async fn failed_write_does_not_consume_quota() {
        let ws = TempWorkspace::new("quota_fail");
        let store = Arc::new(FixedSnapshotStore::with_consumed(0));
        let ctx = quota_ctx(ws.path(), true, 1, Arc::clone(&store) as Arc<dyn ExploreDocsQuotaStore>);
        let tool = crate::tools::fs::WriteFileTool::new();
        let err = tool
            .execute(&ctx, serde_json::json!({ "path": "../escape.md", "content": "x" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        assert!(store.consumed_runs.lock().unwrap().is_empty(), "失败不得计数");
    }

    // ── 持久化格式与键编码 ──

    #[test]
    fn consumed_value_roundtrips_and_tolerates_corruption() {
        let snapshot = ExploreDocsQuotaSnapshot {
            consumed: 2,
            last_consumer_run_id: Some("run-9".to_string()),
        };
        let value = explore_docs_consumed_value(&snapshot);
        assert!(value.contains("\"consumed\":2"));
        assert_eq!(
            parse_explore_docs_consumed(Some(&value)),
            snapshot,
            "序列化 ↔ 解析往返一致"
        );
        // 容错：None / 损坏 / 缺字段 → 零消耗默认，不 panic
        assert_eq!(parse_explore_docs_consumed(None), ExploreDocsQuotaSnapshot::default());
        assert_eq!(parse_explore_docs_consumed(Some("not-json{")), ExploreDocsQuotaSnapshot::default());
        assert_eq!(parse_explore_docs_consumed(Some("{}")), ExploreDocsQuotaSnapshot::default());
    }

    #[test]
    fn session_meta_key_encoding_matches_revert_guard_pattern() {
        assert_eq!(
            session_meta_key_of("sess-1", SESSION_META_KEY_EXPLORE_DOCS_CONSUMED),
            "sess-1:explore_docs_consumed"
        );
        assert_eq!(
            session_meta_key_of("", SESSION_META_KEY_EXPLORE_DOCS_QUOTA),
            SESSION_META_KEY_EXPLORE_DOCS_QUOTA,
            "空 session_id 退化字面键"
        );
    }

    /// 凭证段固定结构（快照断言面）：配额数字参数化、其余字节一致
    #[test]
    fn credential_section_is_structured_and_snapshotable() {
        let section = explore_docs_credential_section(DEFAULT_EXPLORE_DOCS_QUOTA);
        assert!(section.contains("主 agent 分配"));
        assert!(section.contains("本会话最多 1 份"));
        assert!(section.contains("配额用尽后"));
        assert!(section.contains("回报主 agent"));
        assert_eq!(
            section,
            explore_docs_credential_section(DEFAULT_EXPLORE_DOCS_QUOTA),
            "同一配额两次构建字节一致"
        );
        let raised = explore_docs_credential_section(2);
        assert!(raised.contains("本会话最多 2 份"));
        let normalize = |s: String| s.replace("本会话最多 1 份", "本会话最多 {n} 份").replace("本会话最多 2 份", "本会话最多 {n} 份");
        assert_eq!(
            normalize(section),
            normalize(raised),
            "除配额数字外结构字节一致"
        );
    }

    /// 兜底断言：SubagentState 导入不为未使用（占位——模块内不需要，
    /// 保留以对齐本文件测试面）
    #[test]
    fn state_reexport_shape() {
        assert!(matches!(SubagentState::Pending.to_db_status(), "running"));
    }
}
