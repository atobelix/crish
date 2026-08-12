//! W4-C contribute 执行面：View 轨注册表 + 旁路写禁令
//!
//! - 与 `ToolRegistry` **分轨**：本表只服务 View 投影，不持文档权威
//! - `list()` 仅 [`ViewDescriptor`]；写权威仅经 NoteBackend / 审批矩阵
//! - **≠ EL-07** 满关；**≠ A-EXT** 全表；拒写方向不回退

use crate::note_backend::NoteBackendError;
use crate::note_w6e_skeleton::find_forbidden_write_handle;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::sync::Mutex;

use super::schema::{
    ContributeKind, ContributeRegisterError, ContributeRegisterOk, ContributeRegistration,
    ViewDescriptor,
};
use super::validate::{reject_write_handles, validate_base, validate_permissions};
use super::CONTRIBUTE_MUTATE_DENIED;

// ── 注册表 ──────────────────────────────────────────────────────────

/// 全局注册键：`pluginId\0kind\0id`（对齐 plugin-sdk `makeRegistrationKey`）
pub fn make_registration_key(plugin_id: &str, kind: ContributeKind, id: &str) -> String {
    format!("{plugin_id}\0{}\0{id}", kind.as_str())
}

/// 扩展宿主 · View 轨 contribute 注册表（W4-C 产品向路径）
///
/// - 与 `ToolRegistry` **分轨**：本表只服务 View 投影，不持文档权威
/// - `list()` 仅 [`ViewDescriptor`]；写权威仅经 NoteBackend / 审批矩阵
/// - **≠ EL-07** 满关；**≠ A-EXT** 全表
#[derive(Debug, Default)]
pub struct ContributeViewRegistry {
    entries: Mutex<BTreeMap<String, ViewDescriptor>>,
}

impl ContributeViewRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
        }
    }

    /// 注册一条 View 轨贡献。
    ///
    /// 守卫顺序：权限 → 载荷合法性 → **拒写句柄** → 去重 → 入表为 ViewDescriptor。
    pub fn register(
        &self,
        contrib: ContributeRegistration,
    ) -> Result<ContributeRegisterOk, ContributeRegisterError> {
        validate_base(&contrib)?;
        validate_permissions(&contrib)?;
        reject_write_handles(&contrib)?;

        let key = make_registration_key(&contrib.plugin_id, contrib.kind, &contrib.id);
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if guard.contains_key(&key) {
            return Err(ContributeRegisterError::DuplicateId {
                message: format!(
                    "contribute already registered: plugin={} kind={} id={}",
                    contrib.plugin_id,
                    contrib.kind.as_str(),
                    contrib.id
                ),
            });
        }

        let descriptor = to_view_descriptor(contrib);
        guard.insert(key.clone(), descriptor);
        Ok(ContributeRegisterOk {
            registration_key: key,
        })
    }

    /// 列出投影-only 视图描述符（可选 kind 过滤）。
    ///
    /// **永不**返回写句柄；调用方不得据此 apply。
    pub fn list(&self, kind: Option<ContributeKind>) -> Vec<ViewDescriptor> {
        let guard = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<ViewDescriptor> = guard
            .values()
            .filter(|d| match kind {
                None => true,
                Some(k) => d.kind == k,
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| {
            a.plugin_id
                .cmp(&b.plugin_id)
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    /// 按全局键注销；返回是否删到。
    pub fn unregister(&self, registration_key: &str) -> bool {
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.remove(registration_key).is_some()
    }

    /// 按 plugin_id 批量注销；返回删除条数。
    pub fn unregister_by_plugin(&self, plugin_id: &str) -> usize {
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let keys: Vec<String> = guard
            .iter()
            .filter(|(_, d)| d.plugin_id == plugin_id)
            .map(|(k, _)| k.clone())
            .collect();
        let n = keys.len();
        for k in keys {
            guard.remove(&k);
        }
        n
    }

    /// 当前条目数（测用）
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn to_view_descriptor(c: ContributeRegistration) -> ViewDescriptor {
    ViewDescriptor {
        id: c.id,
        plugin_id: c.plugin_id,
        kind: c.kind,
        permissions: c.permissions,
        fields: c.fields,
    }
}

// ── 旁路写禁令（产品向可点名路径）────────────────────────────────

/// 试图经 contribute / View 描述符 mutate 权威树 → **恒拒写**。
///
/// # 语义
/// - View 轨 **无** applyOp / store；任何「用注册表写文档」调用失败
/// - 本函数 **不**触达 [`NoteBackend`] 写路径
/// - 调用方须在拒写后断言权威树不变（见测
///   `w4c_try_mutate_via_contribute_zero_persist`）
///
/// # 诚实
/// - 本闸 = A-EXT-05 局部方向；**≠** EL-07 / A-EXT 全表 / W6-E 端到端
pub fn try_mutate_via_contribute(
    _registry: &ContributeViewRegistry,
    _descriptor_id: &str,
    _doc_id: &str,
    _content: &str,
) -> Result<(), NoteBackendError> {
    Err(NoteBackendError::Invalid(format!(
        "{CONTRIBUTE_MUTATE_DENIED}: View 轨 contribute 为投影-only，禁止经扩展描述符写权威树；\
         写路径仅 NoteBackend / session-loop 审批工具面 — ≠ EL-07 满关 / ≠ A-EXT 全表"
    )))
}

/// 将 contribute 注册错误转为后端 Invalid（稳定 message 含 code）。
pub fn contribute_err_to_backend_err(err: &ContributeRegisterError) -> NoteBackendError {
    NoteBackendError::Invalid(format!("{}: {}", err.code(), err.message()))
}

/// 扫描任意 JSON 是否含禁写句柄（宿主侧复用；与 W6-E-S 同源表）
pub fn contribute_payload_has_write_handle(payload: &JsonValue) -> Option<&'static str> {
    find_forbidden_write_handle(payload)
}
