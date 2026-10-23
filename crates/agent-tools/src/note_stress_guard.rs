//! **W6-E-S** Skeleton：千次批压测夹具 + 恶意扩展拒写 / 零持久化方向
//!
//! # 轨与包标识
//! - 包 ID：**W6-E-S**（必须带 `-S`；Skeleton 轨）
//! - 文件域：`crates/agent-tools/**`（本模块 + 既有 batch / 矩阵 / 审批）
//!
//! # 骨架可测点（本包交付）
//! 1. **千次批压测夹具**：[`build_stress_insert_ops`] + Memory `apply_block_ops`
//!    dryRun / 可选 batch token；可点名测千级 ops 形状与零写语义。
//! 2. **恶意扩展拒写 / 零持久化方向**：[`FORBIDDEN_WRITE_HANDLE_KEYS`] 扫描
//!    + [`reject_malicious_extension_payload`]；被拒后 **不**触达后端写；
//!      Plugin 源 plan Deny / full 仍 NeedsApproval（表驱动 Source 维）。
//!
//! # 诚实边界（强制 · 禁止假关）
//! - **≠ EL-05**（须 W4-B + **W6-E Strict** + 持久/写锥，见 `08`）
//! - **≠ A-AGT-01…08 满表关闭**
//! - **≠ W6-E Strict 闭环**（千次批 + 恶意扩展零持久化生产门禁）
//! - **≠ EL-07** / A-EXT 全表（contribute 拒写句柄仅方向；F3 TrustGate 未关）
//! - Memory 测绿 **禁关**生产 A-AGT / EL-05
//! - **不回退** batch / move / insert / update / delete / lossy / plan Deny
//! - **W4-C 旁路写禁令移交（E1 收口）**：W4-C View 轨双实现（View 注册表 +
//!   恒拒写入口）已随 E1 删除；「View 轨扩展描述符绝不写权威树 / 旁路写」
//!   禁令语义由本模块 [`find_forbidden_write_handle`] 扫描承载，勿恢复双
//!   实现；若产品重建 View 扩展宿主，须在 A-EXT 侧以统一权限表承接（E2 裁决）
//!
//! # 与 plans/09
//! - W6-E Strict：千次批 + 恶意扩展零持久化（本包 **不做** 满关）
//! - W6-E-S Skeleton：batch token / 审批 / 压测夹具骨架（本文）

use crate::note_action_matrix::{decide_from_matrix, ActionSource};
use crate::note_backend::{NoteBackendError, NoteBlockBatchRequest, NoteBlockOp, NoteBlockOpKind};
use crate::permission::{PermissionMode, PermissionVerdict};
use serde_json::Value as JsonValue;

// ── 包锚 ────────────────────────────────────────────────────────────

/// **W6-E-S** Skeleton 包标识（测 / 文档 / 调度对账）
pub const W6E_SKELETON_PACKAGE_ID: &str = "W6-E-S";

/// 千次批压测默认 op 数（Strict W6-E 同量级门槛的 Skeleton 夹具常量）
pub const W6E_S_THOUSAND_BATCH_COUNT: usize = 1000;

/// 稳定拒写码：恶意扩展载荷夹带写句柄（骨架；≠ A-EXT 全表 / ≠ EL-07）
pub const MALICIOUS_EXTENSION_FORBIDDEN_WRITE: &str = "note.malicious_extension_forbidden_write";

// ── 恶意扩展 · 禁写句柄键（对齐 plugin-sdk FORBIDDEN_WRITE_KEYS 方向）──

/// 扩展/插件载荷中禁止出现的写路径键名（Skeleton 扫描表）。
///
/// 与 `packages/plugin-sdk` contribute `FORBIDDEN_WRITE_KEYS` 对齐方向：
/// 夹带 → 拒注册/拒写；**零持久化**由调用方在拒写后断言后端未变。
///
/// **≠** TrustGate / F3 打包 / EL-07 满关。
pub const FORBIDDEN_WRITE_HANDLE_KEYS: &[&str] = &[
    "store",
    "writeStore",
    "getWriteStore",
    "applyOp",
    "apply",
    "transaction",
    "mutate",
    "db",
    "sqlite",
    "write",
    "documentWrite",
    "fsWrite",
    "getRootElement",
    "innerHTML",
];

/// 在 JSON 对象（及一层嵌套对象）中扫描禁写键；命中返回键名。
///
/// # Skeleton 语义
/// - 仅形状/方向：递归深度有限（2 层对象 + 数组元素对象），够夹具与契约测
/// - **≠** 生产 TrustGate 全量 AST 消毒
pub fn find_forbidden_write_handle(payload: &JsonValue) -> Option<&'static str> {
    find_forbidden_in_value(payload, 0)
}

fn find_forbidden_in_value(v: &JsonValue, depth: u8) -> Option<&'static str> {
    if depth > 2 {
        return None;
    }
    match v {
        JsonValue::Object(map) => {
            for key in FORBIDDEN_WRITE_HANDLE_KEYS {
                if map.contains_key(*key) {
                    return Some(*key);
                }
            }
            for child in map.values() {
                if let Some(hit) = find_forbidden_in_value(child, depth + 1) {
                    return Some(hit);
                }
            }
            None
        }
        JsonValue::Array(arr) => {
            for item in arr {
                if let Some(hit) = find_forbidden_in_value(item, depth + 1) {
                    return Some(hit);
                }
            }
            None
        }
        _ => None,
    }
}

/// 恶意扩展拒写结果（Skeleton）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaliciousExtensionGate {
    /// 放行（未发现禁写句柄）——仍须走正常审批 / backend
    Allow,
    /// 拒写：稳定码 + 命中键
    Reject {
        code: &'static str,
        forbidden_key: &'static str,
    },
}

/// 扫描载荷；若含禁写句柄 → Reject（**不得**继续写后端）。
///
/// 返回 Reject 时调用方须 **零持久化**（本函数本身不触达 NoteBackend）。
pub fn reject_malicious_extension_payload(payload: &JsonValue) -> MaliciousExtensionGate {
    match find_forbidden_write_handle(payload) {
        Some(key) => MaliciousExtensionGate::Reject {
            code: MALICIOUS_EXTENSION_FORBIDDEN_WRITE,
            forbidden_key: key,
        },
        None => MaliciousExtensionGate::Allow,
    }
}

/// 将拒写门闸转为 [`NoteBackendError::Invalid`]（稳定 message 含 code）。
pub fn malicious_gate_to_backend_err(gate: &MaliciousExtensionGate) -> Option<NoteBackendError> {
    match gate {
        MaliciousExtensionGate::Allow => None,
        MaliciousExtensionGate::Reject {
            code,
            forbidden_key,
        } => Some(NoteBackendError::Invalid(format!(
            "{code}: payload contains forbidden write handle `{forbidden_key}` — zero persist"
        ))),
    }
}

// ── 千次批压测夹具 ──────────────────────────────────────────────────

/// 构造 `count` 条 insert op（千次批压测夹具）。
///
/// - 默认 `count = `[`W6E_S_THOUSAND_BATCH_COUNT`]（1000）
/// - 预分配稳定 id：`stress-{i:04}`，便于断言与 dryRun preview
/// - **≠** W6-E Strict 生产门禁标定；仅 Skeleton 可重复夹具
pub fn build_stress_insert_ops(count: usize) -> Vec<NoteBlockOp> {
    let mut ops = Vec::with_capacity(count);
    for i in 0..count {
        ops.push(NoteBlockOp {
            op: NoteBlockOpKind::Insert,
            id: Some(format!("stress-{i:04}")),
            parent_id: None,
            previous_id: None,
            content: Some(format!("W6-E-S stress body {i}")),
            kind: Some("paragraph".into()),
            attrs: None,
        });
    }
    ops
}

/// 构造千次批 dryRun 请求（零写权威树）。
pub fn thousand_batch_dry_run_request(doc_id: impl Into<String>) -> NoteBlockBatchRequest {
    NoteBlockBatchRequest {
        doc_id: doc_id.into(),
        ops: build_stress_insert_ops(W6E_S_THOUSAND_BATCH_COUNT),
        dry_run: true,
        batch_id: None,
        origin: Some("agent".into()),
        force_execution_unknown: false,
    }
}

/// 构造千次批实写请求（可挂 batch_id；Skeleton 形状，Memory 非生产）。
pub fn thousand_batch_apply_request(
    doc_id: impl Into<String>,
    batch_id: Option<String>,
) -> NoteBlockBatchRequest {
    NoteBlockBatchRequest {
        doc_id: doc_id.into(),
        ops: build_stress_insert_ops(W6E_S_THOUSAND_BATCH_COUNT),
        dry_run: false,
        batch_id,
        origin: Some("agent".into()),
        force_execution_unknown: false,
    }
}

// ── 诚实边界辅助（测用钉）──────────────────────────────────────────

/// 文档/测用：本包 **不** 关闭的项（假关检查清单）
pub const W6E_S_NOT_CLOSING: &[&str] = &[
    "EL-05",
    "A-AGT-01…08 满表",
    "W6-E Strict 千次+恶意闭环",
    "EL-07 / A-EXT 全表",
];

/// Plugin 源对笔记写工具：plan 必须 Deny（恶意扩展抬权方向 · Skeleton）
pub fn plugin_plan_denies_note_write(tool_name: &str) -> bool {
    matches!(
        decide_from_matrix(tool_name, ActionSource::Plugin, PermissionMode::Plan),
        Some(PermissionVerdict::Deny)
    )
}

/// Plugin 源 full 仍 NeedsApproval（外部源默认确认；≠ 自动放行写）
pub fn plugin_full_needs_approval_for_write(tool_name: &str) -> bool {
    matches!(
        decide_from_matrix(tool_name, ActionSource::Plugin, PermissionMode::FullAccess),
        Some(PermissionVerdict::NeedsApproval)
    )
}

// ── 测试 ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note_action_matrix::plan_denies_matrix_tool;
    use crate::note_backend::{
        MemoryNoteBackend, NoteBackend, NoteBatchTokens, NoteQueryBlocksParams,
    };
    use crate::note_permission::plan_denies_note_tool;
    use std::time::Duration;

    /// 包锚：常量与 `-S` 叙事
    #[test]
    fn w6e_s_package_id_is_skeleton_track() {
        assert_eq!(W6E_SKELETON_PACKAGE_ID, "W6-E-S");
        assert!(
            W6E_SKELETON_PACKAGE_ID.ends_with("-S"),
            "Skeleton 轨必须带 -S；禁止去 -S 冒充 Strict"
        );
        assert_eq!(W6E_S_THOUSAND_BATCH_COUNT, 1000);
        // 诚实钉：≠ EL-05 / ≠ A-AGT 满表 / ≠ W6-E Strict
        assert!(W6E_S_NOT_CLOSING.iter().any(|s| s.contains("EL-05")));
        assert!(W6E_S_NOT_CLOSING.iter().any(|s| s.contains("W6-E Strict")));
        assert!(W6E_S_NOT_CLOSING.iter().any(|s| s.contains("A-AGT")));
        let _ = "W6-E-S ≠ EL-05 / ≠ A-AGT 满表 / ≠ W6-E Strict 闭环";
    }

    /// 千次批夹具：生成 1000 insert ops
    #[test]
    fn w6e_s_build_stress_ops_thousand() {
        let ops = build_stress_insert_ops(W6E_S_THOUSAND_BATCH_COUNT);
        assert_eq!(ops.len(), 1000);
        assert_eq!(ops[0].id.as_deref(), Some("stress-0000"));
        assert_eq!(ops[999].id.as_deref(), Some("stress-0999"));
        assert!(ops.iter().all(|o| o.op == NoteBlockOpKind::Insert));
        assert!(
            ops[0].content.as_deref().unwrap_or("").contains("W6-E-S"),
            "夹具 content 须可点名 W6-E-S"
        );
    }

    /// 千次批 dryRun：零写权威树 + applied=1000（压测夹具可测）
    #[tokio::test]
    async fn w6e_s_thousand_batch_dry_run_zero_write() {
        let backend = MemoryNoteBackend::new();
        let req = thousand_batch_dry_run_request("doc-w6e-s-dr");
        assert_eq!(req.ops.len(), 1000);
        assert!(req.dry_run);

        let result = backend.apply_block_ops(req).await.expect("dryRun ok");
        assert!(result.dry_run);
        assert_eq!(result.applied, 1000);
        assert_eq!(result.preview.len(), 1000);
        assert_eq!(result.block_ids.len(), 1000);

        // 零写
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-w6e-s-dr".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(
            q.blocks.is_empty(),
            "W6-E-S dryRun 千次批必须零写；got {}",
            q.blocks.len()
        );
    }

    /// 千次批 + batch token：占用后 dryRun 通过；未占用拒绝
    #[tokio::test]
    async fn w6e_s_thousand_batch_token_gate_skeleton() {
        let backend = MemoryNoteBackend::new();

        // 未占用 → Invalid
        let err = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-tok".into(),
                ops: build_stress_insert_ops(8), // 形状测用小批亦可
                dry_run: true,
                batch_id: Some("w6e-s-missing".into()),
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .unwrap_err();
        assert!(matches!(err, NoteBackendError::BatchTokenInvalid(_)));

        // 占用后 dryRun 千次批
        backend.batch_tokens().acquire("w6e-s-batch").unwrap();
        let result = backend
            .apply_block_ops(NoteBlockBatchRequest {
                doc_id: "doc-tok".into(),
                ops: build_stress_insert_ops(W6E_S_THOUSAND_BATCH_COUNT),
                dry_run: true,
                batch_id: Some("w6e-s-batch".into()),
                origin: Some("agent".into()),
                force_execution_unknown: false,
            })
            .await
            .expect("token + dryRun");
        assert_eq!(result.applied, 1000);
        assert!(result.dry_run);

        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-tok".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(q.blocks.is_empty(), "token dryRun 仍零写");
    }

    /// 千次批实写形状（Memory 仅测；**禁关**生产 A-AGT / EL-05）
    #[tokio::test]
    async fn w6e_s_thousand_batch_apply_memory_shape() {
        let backend = MemoryNoteBackend::new();
        let result = backend
            .apply_block_ops(thousand_batch_apply_request("doc-w6e-s-ap", None))
            .await
            .expect("apply shape");
        assert!(!result.dry_run);
        assert_eq!(result.applied, 1000);
        assert_eq!(result.block_ids.len(), 1000);
        assert_eq!(result.block_ids[0], "stress-0000");
        assert_eq!(result.block_ids[999], "stress-0999");

        // Memory query limit clamp(1,200)：用 text_match 点名首/末块证落盘
        let first = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-w6e-s-ap".into(),
                text_match: Some("W6-E-S stress body 0".into()),
                limit: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(first.blocks.len(), 1);
        assert_eq!(first.blocks[0].id, "stress-0000");

        let last = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-w6e-s-ap".into(),
                text_match: Some("W6-E-S stress body 999".into()),
                limit: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(last.blocks.len(), 1);
        assert_eq!(last.blocks[0].id, "stress-0999");

        // 全量列表 truncated（query 上限 200 ≠ 未落盘）
        let page = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-w6e-s-ap".into(),
                limit: Some(200),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page.blocks.len(), 200);
        assert!(page.truncated, "千次落盘时 query 页应 truncated");

        // 诚实：Memory 全绿 ≠ 生产关项
        let _ = "W6-E-S Memory 千次批形状 ≠ EL-05 / ≠ W6-E Strict / ≠ A-AGT 满表";
    }

    /// 恶意扩展：禁写键扫描命中
    #[test]
    fn w6e_s_malicious_extension_forbidden_keys_detected() {
        assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"applyOp"));
        assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"innerHTML"));
        assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"sqlite"));

        let payload = serde_json::json!({
            "pluginId": "evil",
            "kind": "block_view",
            "descriptor": { "applyOp": "steal" }
        });
        assert_eq!(find_forbidden_write_handle(&payload), Some("applyOp"));

        let gate = reject_malicious_extension_payload(&payload);
        match gate {
            MaliciousExtensionGate::Reject {
                code,
                forbidden_key,
            } => {
                assert_eq!(code, MALICIOUS_EXTENSION_FORBIDDEN_WRITE);
                assert_eq!(forbidden_key, "applyOp");
            }
            MaliciousExtensionGate::Allow => panic!("must reject"),
        }
        assert!(malicious_gate_to_backend_err(&gate).is_some());
    }

    /// 恶意扩展拒写后 **零持久化**（不调用 backend 写；权威树不变）
    #[tokio::test]
    async fn w6e_s_malicious_extension_reject_zero_persist() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-evil",
            vec![("keep".into(), "paragraph".into(), "stay".into())],
        );

        let evil = serde_json::json!({
            "pluginId": "malware-ext",
            "payload": {
                "store": {},
                "content": "should never land"
            }
        });
        let gate = reject_malicious_extension_payload(&evil);
        assert!(matches!(
            gate,
            MaliciousExtensionGate::Reject {
                forbidden_key: "store",
                ..
            }
        ));

        // 被拒 → **禁止** apply_block_ops / apply_md
        let err = malicious_gate_to_backend_err(&gate).expect("must err");
        assert!(
            err.message().contains(MALICIOUS_EXTENSION_FORBIDDEN_WRITE)
                || format!("{err:?}").contains("forbidden"),
            "err should name forbidden write: {err:?}"
        );

        // 零持久化：文档仍仅 1 块
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-evil".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
        assert_eq!(q.blocks[0].id, "keep");
        assert!(
            q.blocks[0].snippet.contains("stay"),
            "零持久化：原块 snippet 须保留 stay，got {:?}",
            q.blocks[0].snippet
        );
    }

    /// 干净载荷放行扫描（仍须审批；本测仅门闸）
    #[test]
    fn w6e_s_clean_payload_allows_gate() {
        let clean = serde_json::json!({
            "pluginId": "good",
            "kind": "slash",
            "id": "cmd-1",
            "label": "Hello"
        });
        assert_eq!(
            reject_malicious_extension_payload(&clean),
            MaliciousExtensionGate::Allow
        );
        assert!(malicious_gate_to_backend_err(&MaliciousExtensionGate::Allow).is_none());
    }

    /// Plugin 源：plan Deny 写工具 + full NeedsApproval（审批骨架 · 不回退）
    #[test]
    fn w6e_s_plugin_source_plan_deny_and_full_needs_approval() {
        for tool in [
            "block_batch",
            "block_insert",
            "block_update",
            "block_delete",
            "block_move",
            "document_apply_md",
            "send_to_note",
        ] {
            assert!(
                plugin_plan_denies_note_write(tool),
                "W6-E-S: Plugin plan must Deny {tool}"
            );
            assert!(
                plugin_full_needs_approval_for_write(tool),
                "W6-E-S: Plugin full must NeedsApproval {tool}"
            );
            // Builtin plan Deny 不回退
            assert!(plan_denies_matrix_tool(tool), "plan Deny 不回退: {tool}");
            assert!(
                plan_denies_note_tool(tool),
                "note_permission plan Deny 不回退: {tool}"
            );
        }
    }

    /// 过期 batch token 仍拒（骨架与 W4-B 共存；不回退）
    #[test]
    fn w6e_s_batch_token_expire_still_enforced() {
        let tokens = NoteBatchTokens::with_ttl(Duration::from_millis(30));
        tokens.acquire("w6e-s-exp").unwrap();
        tokens.validate("w6e-s-exp").unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert!(matches!(
            tokens.validate("w6e-s-exp"),
            Err(NoteBackendError::BatchTokenExpired(_))
        ));
    }

    /// 诚实钉总表：W6-E-S 可测 ≠ 关项
    #[test]
    fn w6e_s_honest_boundaries_not_closing_el05_or_w6e_strict() {
        assert_eq!(W6E_SKELETON_PACKAGE_ID, "W6-E-S");
        // 夹具与门闸存在 ≠ Strict 闭环
        assert!(!FORBIDDEN_WRITE_HANDLE_KEYS.is_empty());
        assert_eq!(W6E_S_THOUSAND_BATCH_COUNT, 1000);
        for item in W6E_S_NOT_CLOSING {
            assert!(!item.is_empty());
        }
        let _ = "≠ EL-05 / ≠ A-AGT 满表 / ≠ W6-E Strict / W6-E-S Skeleton only";
    }
}
