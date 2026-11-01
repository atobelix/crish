//! 远程命令白名单（R1-11 G-5 / D5 §4.5 M-REG 落点）
//!
//! 远程网关不暴露 Tauri IPC（D11）：REST/WS 服务面即远程命令面，可调
//! 用的引擎能力收敛为本文件的独立白名单注册表（对偶
//! `command_manifest.rs` 的 registered=true 机制）。命令名 ∈ 白名单 →
//! 放行；否则 403 cmd.denied + RemoteSourceAttempt 审计事件（router
//! 命令执行端点守卫 + fallback 拒绝分支接线，见 router.rs）。
//!
//! 白名单真源 = M6 §4 命令总表 C01-C32 + G2 增补 C38-C39 + G3 增补 C40-C43 + G7 增补 C44（wire 名取命令 kind 去掉
//! `remote.` 前缀的 camelCase 后缀；D5 §4.5 三列映射表对齐口径）：
//!
//! | 功能域 | 条数 | M6 编号 | 命令 |
//! |--------|------|---------|------|
//! | F1 监控 | 10 | C01-C10 | getStatus / getRunSnapshot / readSessionEvents / readRunEvents / listSessions / listBackgroundTasks / getTaskOutput / getFlowSnapshot / listCommands / getSearchIndex |
//! | F2 审批 | 5 | C11-C15 | approve / deny / listPendingApprovals / approvalHistory / checkCommand |
//! | F4 文件 | 8 | C16-C23 | listDir / readFile / writeFile / listWorkspaces / switchWorkspace / searchFiles / assetUrl / fileStat |
//! | F5 会话 | 4 | C24-C27 | runTask / runControl / cancelRun / searchSessions |
//! | F6 设置 | 5 | C28-C32 | getSettings / setSettings / settingsConfirm / pauseAutomation / queryPresence |
//! | F6 设置（G2 增补） | 2 | C38-C39 | listModels / setActiveModel（全局默认模型读写——桌面同一真源，用户裁决 Q3：切换含桌面端全局生效） |
//! | F5 会话（G3 增补） | 4 | C40-C43 | renameSession / setSessionPinned / setSessionArchived / deleteSession（会话操作——与桌面侧栏同一存储层同一语义；删除守卫与桌面孤儿清理豁免同源） |
//! | F6 设置（G7 增补） | 1 | C44 | listSkills（技能目录只读——与桌面「设置 → 扩展 → 技能」同一发现真源；启停生效值是桌面 webview 本地状态、宿主无数据面，故无启停写命令） |
//!
//! 显式不进白名单（无论何级能力，D5 §4.5）：
//!
//! - `config_secret_get / set / clear / reveal / has`——密钥命令面
//!   （TH-10/TH-11；纵深防御第二层 remote_source 命令级拒绝 + 第三层
//!   remote-source-attempt 审计见 router.rs SECRET_COMMAND_SURFACE /
//!   core_backend emit_remote_source_attempt_audit）；
//! - `workbench_git_run` / `workbench_pty_*` / `workbench_run_shell` /
//!   `host_openers` 族——直接终端/执行面（GUI fs 删除命令已于 R7 收口幽灵退役，
//!   无远程面）;
//! - 设备域 C33-C37（listDevices / renameDevice / revokeDevice /
//!   getPairState / unlink）与设备管理/服务配置命令——admin 面仅桌面端
//!   （D5 §4.5「设备管理与服务配置命令（admin 面，仅桌面端）」）；
//! - 任何以明文返回密钥/令牌/配对码的命令。

use conex_run::core_event_bridge::EventBridge;
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, SecurityAuditDecision, SecurityAuditOperation,
};
use conex_types::impact::ImpactAssessment;

#[cfg(test)]
pub(crate) fn remote_source_attempt_marker(command: &str) -> String {
    format!("operation=remote-source-attempt;command={command};decision=blocked")
}

fn remote_audit_event(
    session_id: &str,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
    decision: SecurityAuditDecision,
    permission_mode: Option<String>,
) -> AgentEvent {
    let now = conex_shared::time::now_iso_utc();
    AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: now,
        operation,
        targets,
        impact: ImpactAssessment::default(),
        decision,
        permission_mode,
        tool_call_id: None,
    }
}

fn emit_remote_audit(
    bridge: Option<&EventBridge>,
    session_id: &str,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
    decision: SecurityAuditDecision,
    permission_mode: Option<String>,
) {
    tracing::info!(
        target: "security.audit",
        kind = "remote-action",
        operation = ?operation,
        decision = ?decision,
        targets = ?targets,
        session_id,
        "远程动作审计（结构化日志 + SecurityAudit 事件双写）"
    );
    let Some(bridge) = bridge else {
        return;
    };
    let envelope = AgentEventEnvelope::new(
        remote_audit_event(session_id, operation, targets, decision, permission_mode),
        None,
        None,
    );
    bridge.emit_envelope(&envelope);
}

pub(crate) fn emit_remote_source_attempt_audit(bridge: Option<&EventBridge>, command: &str) {
    let redacted = conex_telemetry::redact::redact_text(command);
    emit_remote_audit(
        bridge,
        "",
        SecurityAuditOperation::RemoteSourceAttempt,
        vec![redacted.clone()],
        SecurityAuditDecision::Blocked,
        None,
    );
    tracing::info!(
        target: "security.audit",
        kind = "remote-command",
        operation = "remote-source-attempt",
        command = %redacted,
        decision = "blocked",
        "远程来源触达被禁命令面（白名单拒绝 + 审计标记，敏感形态已打码）"
    );
}

/// 远程命令能力分级（M6 §4 功能域；D5 §4.1 observe/approve/operate 语义
/// 在注册表声明所需能力级——本表先冻结命令面真源，能力门禁由网关装配
/// 层按 §4.2 矩阵执行）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteCommandCategory {
    /// F1 监控域（C01-C10：只读状态/快照/事件分页，observe 级）
    Monitor,
    /// F2 审批域（C11-C15：裁决/对账/历史，approve 级）
    Approval,
    /// F4 文件域（C16-C23：目录/文件/工作区浏览与受控写，observe 读 /
    /// operate 写）
    File,
    /// F5 会话域（C24-C27：run 发起/控制/取消/搜索 + G3 增补 C40-C43
    /// 会话操作，operate 级）
    Session,
    /// F6 设置域（C28-C32：设置镜像/确认/暂停 + G2 增补 C38-C39 模型
    /// + G7 增补 C44 技能目录只读，approve 级）
    Settings,
}

/// 白名单条目（命令名 = M6 命令 kind 去掉 `remote.` 前缀；wire 名
/// camelCase，与 REST 路径/载荷命名同源）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteCommandEntry {
    /// 命令名（M6 wire kind 后缀）
    pub name: &'static str,
    /// 功能域类别（能力分级声明）
    pub category: RemoteCommandCategory,
}

/// 远程命令白名单注册表（M6 §4 C01-C32 冻结 32 条 + G2/G3/G7 增补 7 条；条目顺序即 M6
/// 命令总表顺序——测试按序断言防漂移，注册表是命令面的唯一真源）
pub const REMOTE_COMMAND_WHITELIST: &[RemoteCommandEntry] = &[
    // ── F1 监控域（C01-C10，10 条）──
    RemoteCommandEntry {
        name: "getStatus",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "getRunSnapshot",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "readSessionEvents",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "readRunEvents",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "listSessions",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "listBackgroundTasks",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "getTaskOutput",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "getFlowSnapshot",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "listCommands",
        category: RemoteCommandCategory::Monitor,
    },
    RemoteCommandEntry {
        name: "getSearchIndex",
        category: RemoteCommandCategory::Monitor,
    },
    // ── F2 审批域（C11-C15，5 条）──
    RemoteCommandEntry {
        name: "approve",
        category: RemoteCommandCategory::Approval,
    },
    RemoteCommandEntry {
        name: "deny",
        category: RemoteCommandCategory::Approval,
    },
    RemoteCommandEntry {
        name: "listPendingApprovals",
        category: RemoteCommandCategory::Approval,
    },
    RemoteCommandEntry {
        name: "approvalHistory",
        category: RemoteCommandCategory::Approval,
    },
    RemoteCommandEntry {
        name: "checkCommand",
        category: RemoteCommandCategory::Approval,
    },
    // ── F4 文件域（C16-C23，8 条）──
    RemoteCommandEntry {
        name: "listDir",
        category: RemoteCommandCategory::File,
    },
    RemoteCommandEntry {
        name: "readFile",
        category: RemoteCommandCategory::File,
    },
    RemoteCommandEntry {
        name: "writeFile",
        category: RemoteCommandCategory::File,
    },
    RemoteCommandEntry {
        name: "listWorkspaces",
        category: RemoteCommandCategory::File,
    },
    RemoteCommandEntry {
        name: "switchWorkspace",
        category: RemoteCommandCategory::File,
    },
    RemoteCommandEntry {
        name: "searchFiles",
        category: RemoteCommandCategory::File,
    },
    RemoteCommandEntry {
        name: "assetUrl",
        category: RemoteCommandCategory::File,
    },
    RemoteCommandEntry {
        name: "fileStat",
        category: RemoteCommandCategory::File,
    },
    // ── F5 会话域（C24-C27，4 条）──
    RemoteCommandEntry {
        name: "runTask",
        category: RemoteCommandCategory::Session,
    },
    RemoteCommandEntry {
        name: "runControl",
        category: RemoteCommandCategory::Session,
    },
    RemoteCommandEntry {
        name: "cancelRun",
        category: RemoteCommandCategory::Session,
    },
    RemoteCommandEntry {
        name: "searchSessions",
        category: RemoteCommandCategory::Session,
    },
    // ── F6 设置域（C28-C32，5 条）──
    RemoteCommandEntry {
        name: "getSettings",
        category: RemoteCommandCategory::Settings,
    },
    RemoteCommandEntry {
        name: "setSettings",
        category: RemoteCommandCategory::Settings,
    },
    RemoteCommandEntry {
        name: "settingsConfirm",
        category: RemoteCommandCategory::Settings,
    },
    RemoteCommandEntry {
        name: "pauseAutomation",
        category: RemoteCommandCategory::Settings,
    },
    RemoteCommandEntry {
        name: "queryPresence",
        category: RemoteCommandCategory::Settings,
    },
    // ── G2 增补（C38-C39，F6 设置域）──
    RemoteCommandEntry {
        name: "listModels",
        category: RemoteCommandCategory::Settings,
    },
    RemoteCommandEntry {
        name: "setActiveModel",
        category: RemoteCommandCategory::Settings,
    },
    // ── G3 增补（C40-C43，F5 会话域）──
    RemoteCommandEntry {
        name: "renameSession",
        category: RemoteCommandCategory::Session,
    },
    RemoteCommandEntry {
        name: "setSessionPinned",
        category: RemoteCommandCategory::Session,
    },
    RemoteCommandEntry {
        name: "setSessionArchived",
        category: RemoteCommandCategory::Session,
    },
    RemoteCommandEntry {
        name: "deleteSession",
        category: RemoteCommandCategory::Session,
    },
    // ── G7 增补（C44，F6 设置域）──
    RemoteCommandEntry {
        name: "listSkills",
        category: RemoteCommandCategory::Settings,
    },
];

/// 白名单条目总数（M6 §4 C01-C32 + G2 增补 C38-C39 + G3 增补 C40-C43 + G7 增补 C44：39 条）
#[cfg(test)]
pub const REMOTE_COMMAND_WHITELIST_LEN: usize = REMOTE_COMMAND_WHITELIST.len();

/// 判定纯函数：命令名 ∈ 白名单 → 放行（D5 §4.5「命令名 ∈ 白名单 →
/// 放行；否则 403 cmd.denied + RemoteSourceAttempt 审计事件」的判定
/// 真源；大小写敏感——wire kind 名精确匹配）
pub fn is_remote_command_whitelisted(command: &str) -> bool {
    REMOTE_COMMAND_WHITELIST
        .iter()
        .any(|entry| entry.name == command)
}

/// 命令功能域类别（None = 不在白名单；能力分级声明的查询入口）
#[cfg(test)]
pub fn remote_command_category(command: &str) -> Option<RemoteCommandCategory> {
    REMOTE_COMMAND_WHITELIST
        .iter()
        .find(|entry| entry.name == command)
        .map(|entry| entry.category)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── M6 §4 总表 + G2/G3/G7 增补对齐：39 条逐条锁定（防注册表漂移）──

    /// 白名单覆盖 M6 §4 C01-C32 全 32 条：按域断言数量（监控 10 /
    /// 审批 5 / 文件 8 / 会话 4 / 设置 5）+ 按 M6 表顺序逐条断言命令名
    /// 与类别——任何一条缺漏/错位即红（D5 §4.5 与 M6 §4 的双源对账）
    #[test]
    fn whitelist_covers_m6_c01_to_c32_plus_g2_g3_g7_exactly() {
        let expected = [
            // F1 监控域（C01-C10）
            ("getStatus", RemoteCommandCategory::Monitor),
            ("getRunSnapshot", RemoteCommandCategory::Monitor),
            ("readSessionEvents", RemoteCommandCategory::Monitor),
            ("readRunEvents", RemoteCommandCategory::Monitor),
            ("listSessions", RemoteCommandCategory::Monitor),
            ("listBackgroundTasks", RemoteCommandCategory::Monitor),
            ("getTaskOutput", RemoteCommandCategory::Monitor),
            ("getFlowSnapshot", RemoteCommandCategory::Monitor),
            ("listCommands", RemoteCommandCategory::Monitor),
            ("getSearchIndex", RemoteCommandCategory::Monitor),
            // F2 审批域（C11-C15）
            ("approve", RemoteCommandCategory::Approval),
            ("deny", RemoteCommandCategory::Approval),
            ("listPendingApprovals", RemoteCommandCategory::Approval),
            ("approvalHistory", RemoteCommandCategory::Approval),
            ("checkCommand", RemoteCommandCategory::Approval),
            // F4 文件域（C16-C23）
            ("listDir", RemoteCommandCategory::File),
            ("readFile", RemoteCommandCategory::File),
            ("writeFile", RemoteCommandCategory::File),
            ("listWorkspaces", RemoteCommandCategory::File),
            ("switchWorkspace", RemoteCommandCategory::File),
            ("searchFiles", RemoteCommandCategory::File),
            ("assetUrl", RemoteCommandCategory::File),
            ("fileStat", RemoteCommandCategory::File),
            // F5 会话域（C24-C27）
            ("runTask", RemoteCommandCategory::Session),
            ("runControl", RemoteCommandCategory::Session),
            ("cancelRun", RemoteCommandCategory::Session),
            ("searchSessions", RemoteCommandCategory::Session),
            // F6 设置域（C28-C32）
            ("getSettings", RemoteCommandCategory::Settings),
            ("setSettings", RemoteCommandCategory::Settings),
            ("settingsConfirm", RemoteCommandCategory::Settings),
            ("pauseAutomation", RemoteCommandCategory::Settings),
            ("queryPresence", RemoteCommandCategory::Settings),
            // G2 增补（C38-C39，F6 设置域）
            ("listModels", RemoteCommandCategory::Settings),
            ("setActiveModel", RemoteCommandCategory::Settings),
            // G3 增补（C40-C43，F5 会话域）
            ("renameSession", RemoteCommandCategory::Session),
            ("setSessionPinned", RemoteCommandCategory::Session),
            ("setSessionArchived", RemoteCommandCategory::Session),
            ("deleteSession", RemoteCommandCategory::Session),
            // G7 增补（C44，F6 设置域）
            ("listSkills", RemoteCommandCategory::Settings),
        ];
        assert_eq!(
            REMOTE_COMMAND_WHITELIST_LEN, 39,
            "白名单必须恰好 39 条（M6 §4 C01-C32 + G2 增补 C38-C39 + G3 增补 C40-C43 + G7 增补 C44）"
        );
        assert_eq!(expected.len(), 39, "期望表必须恰好 39 条");
        for (index, (name, category)) in expected.iter().enumerate() {
            let entry = &REMOTE_COMMAND_WHITELIST[index];
            assert_eq!(entry.name, *name, "第 {index} 条命令名与 M6 表不符（漂移）");
            assert_eq!(
                entry.category, *category,
                "第 {index} 条 {name} 类别与 M6 功能域不符"
            );
        }
        // 判定函数与注册表一致：全部命中、无重复
        for entry in REMOTE_COMMAND_WHITELIST {
            assert!(
                is_remote_command_whitelisted(entry.name),
                "{} 必须在白名单",
                entry.name
            );
            assert_eq!(remote_command_category(entry.name), Some(entry.category));
        }
        let unique_count = REMOTE_COMMAND_WHITELIST
            .iter()
            .map(|entry| entry.name)
            .collect::<std::collections::HashSet<_>>()
            .len();
        assert_eq!(unique_count, 39, "白名单不得有重复命令名");
    }

    // ── 显式排除面（D5 §4.5「无论何级能力」）──

    /// 密钥命令面（config_secret_* 五条）一律不在白名单——白名单拒绝 +
    /// 命令级 remote_source Forbidden 的双层第一层（TH-10/TH-11）
    #[test]
    fn whitelist_excludes_config_secret_surface() {
        for name in [
            "config_secret_get",
            "config_secret_set",
            "config_secret_clear",
            "config_secret_reveal",
            "config_secret_has",
        ] {
            assert!(
                !is_remote_command_whitelisted(name),
                "{name} 密钥命令面必须被白名单排除"
            );
            assert_eq!(remote_command_category(name), None);
        }
    }

    /// 直接文件/终端/执行面（workbench 黑名单族 + host_openers）一律
    /// 不在白名单（D5 §4.5 显式排除清单）
    #[test]
    fn whitelist_excludes_direct_execution_surface() {
        for name in [
            "workbench_git_run",
            "workbench_pty",
            "workbench_run_shell",
            "host_openers",
        ] {
            assert!(
                !is_remote_command_whitelisted(name),
                "{name} 直接执行面必须被白名单排除"
            );
        }
    }

    /// 设备域（M6 C33-C37）与 admin 面（设备管理/服务配置）不进白名单
    /// ——仅桌面端本地（D5 §4.5「设备管理与服务配置命令（admin 面，仅
    /// 桌面端）」）
    #[test]
    fn whitelist_excludes_device_admin_surface() {
        for name in [
            "listDevices",
            "renameDevice",
            "revokeDevice",
            "getPairState",
            "unlink",
        ] {
            assert!(
                !is_remote_command_whitelisted(name),
                "{name} 设备域命令必须被白名单排除（admin 面仅桌面端）"
            );
        }
        // 服务/配置开关类（桌面安全中心面）同样拒绝
        for name in ["pairingStart", "pairingCancel", "deviceRevokeAll"] {
            assert!(!is_remote_command_whitelisted(name));
        }
    }

    /// 判定大小写敏感：wire kind 名精确匹配（大小写变体一律拒绝——
    /// 防「GetStatus」等变体绕过）
    #[test]
    fn whitelist_is_case_sensitive() {
        assert!(!is_remote_command_whitelisted("getstatus"));
        assert!(!is_remote_command_whitelisted("GETSTATUS"));
        assert!(!is_remote_command_whitelisted("getStatus "));
        assert!(!is_remote_command_whitelisted(""));
        assert!(!is_remote_command_whitelisted("remote.getStatus"));
        assert!(
            !is_remote_command_whitelisted("remote.runTask"),
            "网关内部路由名带 remote. 前缀也不放行——命令名必须是 kind 后缀"
        );
    }

    /// 类别抽查：审批域核心命令（approve/deny）显式登记——审批决策是
    /// 移动端核心能力（D5 §4.2），即使 REST 审批端点不挂执行守卫，
    /// 命令面注册表仍完整声明其能力位
    #[test]
    fn whitelist_approval_core_commands_categorized() {
        assert_eq!(
            remote_command_category("approve"),
            Some(RemoteCommandCategory::Approval)
        );
        assert_eq!(
            remote_command_category("deny"),
            Some(RemoteCommandCategory::Approval)
        );
    }
}
