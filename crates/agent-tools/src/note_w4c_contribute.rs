//! **W4-C** Strict 方向：扩展宿主 contribute points · View 轨 + 拒写句柄
//!
//! # 轨与包标识
//! - 包 ID：**W4-C**（Strict 方向子集；**不是** W6-E-S）
//! - 文件域：`crates/agent-tools/**` 扩展/contribute 相关
//! - TS 对齐：`packages/plugin-sdk/src/contribute/**`（View 轨 / FORBIDDEN_WRITE_KEYS）
//!
//! # 本包交付（产品向可点名路径）
//! 1. **View 轨注册表** [`ContributeViewRegistry`]：`register` / `list` / `unregister`
//! 2. **拒写句柄**：载荷夹带 `store` / `applyOp` / `sqlite` 等 →
//!    [`ContributeRegisterError::ForbiddenWriteHandle`]，**不**入表
//! 3. **投影-only**：`list()` 仅 [`ViewDescriptor`] 可序列化 UI 元数据；
//!    **永不**暴露写 store / applyOp
//! 4. **旁路写禁令**：[`try_mutate_via_contribute`] 恒拒写，权威树不变
//!
//! # 诚实边界（强制 · 禁止假关）
//! - **≠ EL-07** 满关（须 W4-C + **W6-E** + A-EXT 全表 + A-INV-01；见 `08` / EL-dashboard）
//! - **≠ A-EXT-01…06 全表**（本包仅 A-EXT-05 局部：View 无 applyOp / 拒写句柄方向）
//! - **≠** registerFlavour F1 后半–F3 / TrustGate 打包 / 恶意扩展零持久化端到端
//! - Memory 测绿 **禁关**生产 A-AGT / EL-05 / EL-07
//! - **不回退** W4-B 审批矩阵、W4-F batch token / move、W6-E-S 骨架
//!
//! # 与 plans
//! - `plans/06` §5：contribute 写句柄拒绝 = A-EXT-05 局部；**≠** EL-07 全关
//! - `plans/09` W4-C：投影-only；拒写句柄；A-EXT 方向
//! - `EL-dashboard` EL-07：禁止冒充「仅 contribute 拒写句柄」

use crate::note_backend::NoteBackendError;
use crate::note_w6e_skeleton::{
    find_forbidden_write_handle, FORBIDDEN_WRITE_HANDLE_KEYS, MALICIOUS_EXTENSION_FORBIDDEN_WRITE,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::sync::Mutex;

// ── 包锚 ────────────────────────────────────────────────────────────

/// **W4-C** Strict 方向包标识（测 / 文档 / 调度对账）
pub const W4C_PACKAGE_ID: &str = "W4-C";

/// 稳定拒写码：contribute 载荷夹带写句柄（View 轨 · 投影-only）
pub const CONTRIBUTE_FORBIDDEN_WRITE: &str = "note.contribute_forbidden_write_handle";

/// 稳定拒写码：试图经 contribute / View 轨 mutate 权威树（旁路禁令）
pub const CONTRIBUTE_MUTATE_DENIED: &str = "note.contribute_mutate_denied";

/// 注册 contribute 的硬性权限（对齐 plugin-sdk `REQUIRED_CONTRIBUTE_PERMISSION`）
pub const REQUIRED_CONTRIBUTE_PERMISSION: &str = "ui:contribute";

/// 文档/测用：本包 **不** 关闭的项（假关检查清单）
pub const W4C_NOT_CLOSING: &[&str] = &[
    "EL-07",
    "A-EXT-01…06 全表",
    "TrustGate F3 打包",
    "registerFlavour F1 后半–F3",
    "恶意扩展零持久化端到端（W6-E）",
];

// ── View 轨类型 ─────────────────────────────────────────────────────

/// Contribute point 种类（View 轨；对齐 plugin-sdk `ContributeKind`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributeKind {
    SlashItem,
    BlockView,
    Widget,
    Keymap,
}

impl ContributeKind {
    /// 稳定字符串（注册键 / list 过滤）
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SlashItem => "slash_item",
            Self::BlockView => "block_view",
            Self::Widget => "widget",
            Self::Keymap => "keymap",
        }
    }

    /// 解析 kind；未知 → None
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "slash_item" => Some(Self::SlashItem),
            "block_view" => Some(Self::BlockView),
            "widget" => Some(Self::Widget),
            "keymap" => Some(Self::Keymap),
            _ => None,
        }
    }
}

/// 全部合法 View 轨 kind
pub const CONTRIBUTE_KINDS: &[ContributeKind] = &[
    ContributeKind::SlashItem,
    ContributeKind::BlockView,
    ContributeKind::Widget,
    ContributeKind::Keymap,
];

/// 投影-only 视图描述符（list 唯一对外形状）
///
/// 不变量（A-EXT-05 局部 / 恶意扩展方向）：
/// - 仅含可序列化 UI 元数据
/// - **永不**包含 store / applyOp / write / transaction 等写句柄
/// - 宿主据此渲染；写权威仍走 RS 工具面（NoteBackend / DocSession.apply）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewDescriptor {
    pub id: String,
    pub plugin_id: String,
    pub kind: ContributeKind,
    /// 注册时声明的权限快照（只读；不含提升）
    pub permissions: Vec<String>,
    /// kind 特有字段（title / flavour / component / keys / commandId …）
    /// **禁止**写句柄键（注册时已剥离校验）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

/// 插件侧注册载荷（View 轨）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContributeRegistration {
    pub id: String,
    pub plugin_id: String,
    pub kind: ContributeKind,
    /// 必须含 `ui:contribute`
    pub permissions: Vec<String>,
    /// kind 特有字段
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    /// 可选附加 JSON（如 slash action 意图数据）；扫描禁写键
    #[serde(default)]
    pub payload: Option<JsonValue>,
}

/// 注册错误码（对齐 plugin-sdk `RegisterErrorCode` 方向子集）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContributeRegisterError {
    MissingPermission { message: String },
    ForbiddenWriteHandle { key: String, message: String },
    DuplicateId { message: String },
    InvalidPayload { message: String },
}

impl ContributeRegisterError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingPermission { .. } => "missing_permission",
            Self::ForbiddenWriteHandle { .. } => "forbidden_write_handle",
            Self::DuplicateId { .. } => "duplicate_id",
            Self::InvalidPayload { .. } => "invalid_payload",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::MissingPermission { message }
            | Self::ForbiddenWriteHandle { message, .. }
            | Self::DuplicateId { message }
            | Self::InvalidPayload { message } => message,
        }
    }
}

impl std::fmt::Display for ContributeRegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for ContributeRegisterError {}

/// 注册成功结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContributeRegisterOk {
    pub registration_key: String,
}

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

fn validate_base(c: &ContributeRegistration) -> Result<(), ContributeRegisterError> {
    if c.id.trim().is_empty() {
        return Err(ContributeRegisterError::InvalidPayload {
            message: "contribute.id is required (non-empty)".into(),
        });
    }
    if c.plugin_id.trim().is_empty() {
        return Err(ContributeRegisterError::InvalidPayload {
            message: "contribute.plugin_id is required (non-empty)".into(),
        });
    }
    match c.kind {
        ContributeKind::SlashItem => {
            if field_empty(c, "title") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "slash_item.title is required".into(),
                });
            }
        }
        ContributeKind::BlockView => {
            if field_empty(c, "flavour") || field_empty(c, "component") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "block_view.flavour and component are required".into(),
                });
            }
        }
        ContributeKind::Widget => {
            if field_empty(c, "anchor") || field_empty(c, "component") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "widget.anchor and component are required".into(),
                });
            }
        }
        ContributeKind::Keymap => {
            if field_empty(c, "keys") || field_empty(c, "command_id") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "keymap.keys and command_id are required".into(),
                });
            }
        }
    }
    Ok(())
}

fn field_empty(c: &ContributeRegistration, key: &str) -> bool {
    c.fields
        .get(key)
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
}

fn validate_permissions(c: &ContributeRegistration) -> Result<(), ContributeRegisterError> {
    if !c
        .permissions
        .iter()
        .any(|p| p == REQUIRED_CONTRIBUTE_PERMISSION)
    {
        return Err(ContributeRegisterError::MissingPermission {
            message: format!(
                "contribute requires permission `{REQUIRED_CONTRIBUTE_PERMISSION}` (got {:?})",
                c.permissions
            ),
        });
    }
    Ok(())
}

/// 拒写句柄：顶层 fields 键 + 可选 payload JSON 扫描。
///
/// 对齐 plugin-sdk `FORBIDDEN_WRITE_KEYS` / W6-E-S [`FORBIDDEN_WRITE_HANDLE_KEYS`]。
fn reject_write_handles(c: &ContributeRegistration) -> Result<(), ContributeRegisterError> {
    for key in FORBIDDEN_WRITE_HANDLE_KEYS {
        if c.fields.contains_key(*key) {
            return Err(ContributeRegisterError::ForbiddenWriteHandle {
                key: (*key).to_string(),
                message: format!(
                    "{CONTRIBUTE_FORBIDDEN_WRITE}: contribution must not carry write handle `{key}` \
                     (View 轨投影-only；写权威仅经 RS 工具面) — ≠ EL-07 满关"
                ),
            });
        }
    }
    if let Some(payload) = &c.payload {
        if let Some(hit) = find_forbidden_write_handle(payload) {
            return Err(ContributeRegisterError::ForbiddenWriteHandle {
                key: hit.to_string(),
                message: format!(
                    "{CONTRIBUTE_FORBIDDEN_WRITE}: payload contains forbidden write handle `{hit}` \
                     (aligned {MALICIOUS_EXTENSION_FORBIDDEN_WRITE}) — zero register"
                ),
            });
        }
    }
    Ok(())
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

// ── 测试 ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note_action_matrix::plan_denies_matrix_tool;
    use crate::note_backend::{
        MemoryNoteBackend, NoteBackend, NoteBatchTokens, NoteBlockInsertRequest,
        NoteBlockMoveRequest, NoteQueryBlocksParams,
    };
    use crate::note_permission::plan_denies_note_tool;
    use crate::permission::{PermissionMode, PermissionVerdict};
    use std::time::Duration;

    fn slash_ok(id: &str) -> ContributeRegistration {
        let mut fields = BTreeMap::new();
        fields.insert("title".into(), "Hello".into());
        ContributeRegistration {
            id: id.into(),
            plugin_id: "@demo/plugin".into(),
            kind: ContributeKind::SlashItem,
            permissions: vec![REQUIRED_CONTRIBUTE_PERMISSION.into()],
            fields,
            payload: None,
        }
    }

    fn block_view_ok(id: &str, flavour: &str) -> ContributeRegistration {
        let mut fields = BTreeMap::new();
        fields.insert("flavour".into(), flavour.into());
        fields.insert("component".into(), "DemoView".into());
        ContributeRegistration {
            id: id.into(),
            plugin_id: "@demo/plugin".into(),
            kind: ContributeKind::BlockView,
            permissions: vec![REQUIRED_CONTRIBUTE_PERMISSION.into()],
            fields,
            payload: None,
        }
    }

    /// 包锚：W4-C 标识 + 诚实 ≠ EL-07 / ≠ A-EXT 全表
    #[test]
    fn w4c_package_id_and_honest_not_closing_el07() {
        assert_eq!(W4C_PACKAGE_ID, "W4-C");
        assert!(!W4C_PACKAGE_ID.ends_with("-S"), "W4-C 为 Strict 方向，非 Skeleton -S");
        assert!(W4C_NOT_CLOSING.iter().any(|s| s.contains("EL-07")));
        assert!(W4C_NOT_CLOSING.iter().any(|s| s.contains("A-EXT")));
        assert_eq!(REQUIRED_CONTRIBUTE_PERMISSION, "ui:contribute");
        assert_eq!(CONTRIBUTE_FORBIDDEN_WRITE, "note.contribute_forbidden_write_handle");
        // 禁写表与 W6-E-S / plugin-sdk 对齐方向
        assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"applyOp"));
        assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"store"));
        assert!(FORBIDDEN_WRITE_HANDLE_KEYS.contains(&"innerHTML"));
        let _ = "W4-C ≠ EL-07 满关 / ≠ A-EXT 全表 / 仅 View 轨拒写句柄方向";
    }

    /// 产品向路径：View 轨 register + list 仅 ViewDescriptor
    #[test]
    fn w4c_contribute_view_registry_register_and_list_projection_only() {
        let reg = ContributeViewRegistry::new();
        let ok = reg.register(slash_ok("cmd-1")).expect("register ok");
        assert!(ok.registration_key.contains("slash_item"));
        assert!(ok.registration_key.contains("cmd-1"));

        let list = reg.list(None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "cmd-1");
        assert_eq!(list[0].kind, ContributeKind::SlashItem);
        assert!(list[0]
            .permissions
            .iter()
            .any(|p| p == REQUIRED_CONTRIBUTE_PERMISSION));
        assert_eq!(list[0].fields.get("title").map(String::as_str), Some("Hello"));

        // 投影-only：序列化 JSON 不得含写句柄键
        let json = serde_json::to_value(&list[0]).expect("ser");
        assert!(contribute_payload_has_write_handle(&json).is_none());
        for key in FORBIDDEN_WRITE_HANDLE_KEYS {
            assert!(
                json.get(*key).is_none(),
                "ViewDescriptor must not expose write handle `{key}`"
            );
        }

        // kind 过滤
        assert!(reg.list(Some(ContributeKind::BlockView)).is_empty());
        assert_eq!(reg.list(Some(ContributeKind::SlashItem)).len(), 1);
    }

    /// 拒写句柄：fields 夹带 applyOp / store → 拒绝且不入表
    #[test]
    fn w4c_contribute_reject_write_handle_in_fields() {
        let reg = ContributeViewRegistry::new();
        let mut evil = slash_ok("evil-apply");
        evil.fields.insert("applyOp".into(), "steal".into());

        let err = reg.register(evil).expect_err("must reject applyOp");
        assert_eq!(err.code(), "forbidden_write_handle");
        assert!(err.message().contains(CONTRIBUTE_FORBIDDEN_WRITE));
        assert!(err.message().contains("applyOp"));
        assert!(reg.is_empty(), "拒写后注册表须为空");

        let mut evil2 = slash_ok("evil-store");
        evil2.fields.insert("store".into(), "x".into());
        let err2 = reg.register(evil2).expect_err("must reject store");
        assert_eq!(err2.code(), "forbidden_write_handle");
        assert!(reg.is_empty());
    }

    /// 拒写句柄：payload JSON 嵌套夹带 sqlite / innerHTML
    #[test]
    fn w4c_contribute_reject_write_handle_in_payload_json() {
        let reg = ContributeViewRegistry::new();
        let mut evil = slash_ok("evil-nested");
        evil.payload = Some(serde_json::json!({
            "action": { "sqlite": "/tmp/evil.db" }
        }));
        let err = reg.register(evil).expect_err("must reject nested sqlite");
        assert_eq!(err.code(), "forbidden_write_handle");
        assert!(
            err.message().contains("sqlite") || err.message().contains(CONTRIBUTE_FORBIDDEN_WRITE)
        );
        assert!(reg.is_empty());

        let mut evil2 = block_view_ok("evil-html", "paragraph");
        evil2.payload = Some(serde_json::json!({ "innerHTML": "<script>" }));
        let err2 = reg.register(evil2).expect_err("must reject innerHTML");
        assert_eq!(err2.code(), "forbidden_write_handle");
        assert!(reg.is_empty());
    }

    /// 权限：无 ui:contribute → missing_permission
    #[test]
    fn w4c_contribute_requires_ui_contribute_permission() {
        let reg = ContributeViewRegistry::new();
        let mut bare = slash_ok("no-perm");
        bare.permissions.clear();
        let err = reg.register(bare).expect_err("must require ui:contribute");
        assert_eq!(err.code(), "missing_permission");
        assert!(err.message().contains("ui:contribute"));

        let mut note_only = slash_ok("note-only");
        note_only.permissions = vec!["note:write".into()];
        let err2 = reg.register(note_only).expect_err("note:write alone insufficient");
        assert_eq!(err2.code(), "missing_permission");
        assert!(reg.is_empty());
    }

    /// 声明 note:write 仍只得 ViewDescriptor（不提升写能力）
    #[test]
    fn w4c_note_write_permission_does_not_grant_write_handle() {
        let reg = ContributeViewRegistry::new();
        let mut c = slash_ok("with-write-decl");
        c.permissions = vec![
            REQUIRED_CONTRIBUTE_PERMISSION.into(),
            "note:write".into(),
        ];
        reg.register(c).expect("ui:contribute + note:write ok");
        let list = reg.list(None);
        assert_eq!(list.len(), 1);
        // 描述符仍无写句柄
        let json = serde_json::to_value(&list[0]).unwrap();
        assert!(contribute_payload_has_write_handle(&json).is_none());
        // 旁路 mutate 仍拒
        let deny = try_mutate_via_contribute(&reg, "with-write-decl", "doc-x", "hack");
        assert!(deny.is_err());
        let e = deny.unwrap_err();
        assert!(
            e.message().contains(CONTRIBUTE_MUTATE_DENIED)
                || format!("{e:?}").contains("contribute_mutate")
        );
    }

    /// 投影-only 旁路写：try_mutate 失败且权威树不变
    #[tokio::test]
    async fn w4c_try_mutate_via_contribute_zero_persist() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-w4c",
            vec![("keep".into(), "paragraph".into(), "authority-stay".into())],
        );

        let reg = ContributeViewRegistry::new();
        reg.register(slash_ok("ui-only")).expect("view ok");

        // 试图经 contribute 写 → 恒拒
        let err = try_mutate_via_contribute(&reg, "ui-only", "doc-w4c", "should-never-land")
            .expect_err("View 轨禁止 mutate");
        assert!(
            err.message().contains(CONTRIBUTE_MUTATE_DENIED)
                || format!("{err:?}").contains("denied"),
            "err must name contribute_mutate_denied: {err:?}"
        );

        // 权威树不变
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-w4c".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
        assert_eq!(q.blocks[0].id, "keep");
        assert!(
            q.blocks[0].snippet.contains("authority-stay"),
            "零持久化：权威块须保留 authority-stay，got {:?}",
            q.blocks[0].snippet
        );

        // 正常工具面写仍可用（分轨：contribute 拒写 ≠ 工具面拒写）
        let ins = backend
            .block_insert(NoteBlockInsertRequest {
                doc_id: "doc-w4c".into(),
                content: "tool-path-ok".into(),
                parent_id: None,
                previous_id: None,
                kind: Some("paragraph".into()),
                batch_id: None,
                origin: Some("agent".into()),
            })
            .await
            .expect("tool path insert");
        assert!(!ins.block_id.is_empty());
        assert_eq!(ins.kind, "paragraph");

        let q2 = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-w4c".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q2.blocks.len(), 2, "工具面写应落盘；contribute 旁路不影响");

        // 诚实：Memory 形状 ≠ 关 EL-07
        let _ = "W4-C Memory 投影-only 拒写 ≠ EL-07 满关 / ≠ A-EXT 全表";
    }

    /// 拒写注册后零持久化：恶意载荷不入表 + 不触达后端写
    #[tokio::test]
    async fn w4c_forbidden_write_register_zero_persist_authority() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-evil-reg",
            vec![("root".into(), "paragraph".into(), "seed".into())],
        );
        let before = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-evil-reg".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(before.blocks.len(), 1);

        let reg = ContributeViewRegistry::new();
        let mut evil = slash_ok("malware");
        evil.fields.insert("documentWrite".into(), "yes".into());
        evil.payload = Some(serde_json::json!({ "fsWrite": "/notes/x.md" }));

        let err = reg.register(evil).expect_err("must reject");
        let be = contribute_err_to_backend_err(&err);
        assert!(
            be.message().contains("forbidden_write_handle")
                || be.message().contains(CONTRIBUTE_FORBIDDEN_WRITE)
        );
        assert!(reg.is_empty());

        // 权威树仍仅 seed
        let after = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-evil-reg".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(after.blocks.len(), 1);
        assert_eq!(after.blocks[0].id, "root");
        assert!(after.blocks[0].snippet.contains("seed"));
    }

    /// 去重 / 注销
    #[test]
    fn w4c_contribute_duplicate_and_unregister() {
        let reg = ContributeViewRegistry::new();
        let ok = reg.register(slash_ok("dup")).unwrap();
        let err = reg.register(slash_ok("dup")).expect_err("duplicate");
        assert_eq!(err.code(), "duplicate_id");
        assert!(reg.unregister(&ok.registration_key));
        assert!(reg.is_empty());
        reg.register(slash_ok("a")).unwrap();
        reg.register(block_view_ok("b", "paragraph")).unwrap();
        assert_eq!(reg.unregister_by_plugin("@demo/plugin"), 2);
        assert!(reg.is_empty());
    }

    /// 不回退：plan Deny（W4-B/F）对写工具仍生效
    #[test]
    fn w4c_no_regress_plan_deny_write_tools() {
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
                plan_denies_note_tool(tool),
                "W4-C 不得回退 note_permission plan Deny: {tool}"
            );
            assert!(
                plan_denies_matrix_tool(tool),
                "W4-C 不得回退 action_matrix plan Deny: {tool}"
            );
        }
        // 读工具 plan 仍 Allow
        assert_eq!(
            crate::note_permission::decide_note_tool("query_blocks", PermissionMode::Plan),
            Some(PermissionVerdict::Allow)
        );
    }

    /// 不回退：batch token 占用 / 过期
    #[test]
    fn w4c_no_regress_batch_token_acquire_validate_expire() {
        let tokens = NoteBatchTokens::with_ttl(Duration::from_millis(30));
        tokens.acquire("w4c-batch").unwrap();
        tokens.validate("w4c-batch").unwrap();
        assert!(matches!(
            tokens.validate("missing"),
            Err(NoteBackendError::BatchTokenInvalid(_))
        ));
        std::thread::sleep(Duration::from_millis(50));
        assert!(matches!(
            tokens.validate("w4c-batch"),
            Err(NoteBackendError::BatchTokenExpired(_))
        ));
    }

    /// 不回退：block_move 工具路径（Memory 形状；禁关生产 A-AGT）
    #[tokio::test]
    async fn w4c_no_regress_block_move_memory_shape() {
        let backend = MemoryNoteBackend::new();
        backend.seed_doc(
            "doc-move",
            vec![
                ("a".into(), "paragraph".into(), "first".into()),
                ("b".into(), "paragraph".into(), "second".into()),
            ],
        );
        let mv = backend
            .block_move(NoteBlockMoveRequest {
                doc_id: "doc-move".into(),
                id: "b".into(),
                parent_id: None,
                previous_id: None, // 移到最前
                batch_id: None,
                origin: Some("agent".into()),
            })
            .await
            .expect("block_move shape");
        assert_eq!(mv.id, "b");
        let q = backend
            .query_blocks(NoteQueryBlocksParams {
                doc_id: "doc-move".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 2);
        // Memory 测绿 ≠ 生产关项
        let _ = "W4-C 不回退 move；Memory ≠ EL-05 / ≠ A-AGT 满表";
    }

    /// kind 解析与注册键稳定
    #[test]
    fn w4c_contribute_kind_parse_and_registration_key() {
        assert_eq!(ContributeKind::parse("slash_item"), Some(ContributeKind::SlashItem));
        assert_eq!(ContributeKind::parse("block_view"), Some(ContributeKind::BlockView));
        assert_eq!(ContributeKind::parse("nope"), None);
        assert_eq!(CONTRIBUTE_KINDS.len(), 4);
        let k = make_registration_key("@p/x", ContributeKind::Widget, "w1");
        assert_eq!(k, "@p/x\0widget\0w1");
    }

    /// 无效载荷
    #[test]
    fn w4c_contribute_invalid_payload_empty_id() {
        let reg = ContributeViewRegistry::new();
        let mut bad = slash_ok("");
        bad.id = "  ".into();
        let err = reg.register(bad).expect_err("empty id");
        assert_eq!(err.code(), "invalid_payload");
    }
}
