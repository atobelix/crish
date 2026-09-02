//! 对话流可见注入卡片 Rust 契约镜像（维度二 · 详案 02 §2.1.2）
//!
//! **定位声明（主控复核裁决，00-总方案 §三「统一契约裁决」#1）**：本模块是
//! 全战役**唯一时间线卡片契约** `MessageContextInjection`（TS：
//! `apps/crish-desktop/src/store/types.ts`，详案 02 定义版）的 Rust 侧 wire
//! 镜像；字段 wire 键 camelCase（`summary` 非 description、`tokenEstimate`
//! 非 estimatedTokens），`kind` 经 snake_case 序列化为前端 9 类注入分类字面量
//! （`rule / skill / file_context / git_status / terminal_output /
//! runtime_steering / schedule_trigger / memory / workspace_env`），`status`
//! 序列化为 5 态（`pending / injected / active / expired / failed`）。
//!
//! 卡片 `metadata` 携带详案 04 的附件类型化子结构 schema——见
//! `crates/conex-types/src/attachment.rs`（**非顶层平行实体**）。
//!
//! 接线状态（本轮）：仅契约落地（Rust 模型 + serde wire 测试），消费侧
//! （前端 IPC 往返 / session-loop 写卡）由战役后续轮次接线，本模块暂无
//! 非测试消费方属预期。

use serde::{Deserialize, Serialize};

/// 上下文注入来源分类（wire：snake_case；对齐 TS `ContextInjectionKind` 9 类）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextInjectionCardKind {
    /// 项目/全局规则注入（如 AGENTS.md、custom rules）
    Rule,
    /// 专家技能/提示词模板注入
    Skill,
    /// 文件引用与代码快照（@file、选区批注）
    FileContext,
    /// Git 工作区状态与改动快照（Diff、分支状态）
    GitStatus,
    /// 终端历史上下文与命令回执（错误日志）
    TerminalOutput,
    /// 运行时纠偏与目标模式指令（/goal 状态）
    RuntimeSteering,
    /// 定时任务/助手模式唤醒元数据（/schedule、Workflow Grill-Me）
    ScheduleTrigger,
    /// 会话记忆与阶段性总结
    Memory,
    /// 工作区目录拓扑与运行环境契约
    WorkspaceEnv,
}

/// 注入项生命周期状态（wire：snake_case；对齐 TS `ContextInjectionStatus` 5 态）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextInjectionStatus {
    /// 准备注入（待下发）
    Pending,
    /// 已成功注入当前 Turn 上下文（活跃生效）
    Injected,
    /// 持续跨轮次生效中（Persistent）
    Active,
    /// 已过期/单次有效已消费
    Expired,
    /// 注入失败（如超限熔断/文件读取错误）
    Failed,
}

/// 统一可见上下文注入卡片载荷（详案 02 §2.1.2 Rust 模型；wire：camelCase）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInjectionCardPayload {
    /// 唯一标识符（UUID 或基于内容 Blake3 哈希）
    pub id: String,
    /// 注入分类
    pub kind: ContextInjectionCardKind,
    /// 卡片展示标题
    pub title: String,
    /// 简明副标题/摘要（展示于卡片 Header 右侧）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 当前状态
    pub status: ContextInjectionStatus,
    /// 注入源标识（如 "rule_loader" / "slash_command" / "schedule_panel"）
    pub source: String,
    /// 核心正文内容（Markdown / 代码 / 结构化文本）
    pub content: String,
    /// 估算的 Token 消耗量（用于展示 Token 胶囊）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_estimate: Option<u32>,
    /// 关联的目标文件路径列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_paths: Option<Vec<String>>,
    /// 注入时间戳（epoch ms）
    pub timestamp: u64,
    /// 是否支持展开查看详情（默认 true）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_foldable: Option<bool>,
    /// 初始是否默认折叠（内容 > 160 字符默认 true）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_folded: Option<bool>,
    /// 失败时的错误诊断信息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 结构化扩展元数据（附件类型化子结构见 attachment.rs，详案 04 §2.1.1）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_kind_serializes_to_snake_case_wire_values() {
        // wire 字面量须与 TS ContextInjectionKind 9 类一一对齐（00-总方案 §三）
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::Rule).unwrap(),
            "rule"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::Skill).unwrap(),
            "skill"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::FileContext).unwrap(),
            "file_context"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::GitStatus).unwrap(),
            "git_status"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::TerminalOutput).unwrap(),
            "terminal_output"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::RuntimeSteering).unwrap(),
            "runtime_steering"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::ScheduleTrigger).unwrap(),
            "schedule_trigger"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::Memory).unwrap(),
            "memory"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionCardKind::WorkspaceEnv).unwrap(),
            "workspace_env"
        );
    }

    #[test]
    fn card_kind_kebab_case_is_rejected_on_deserialize() {
        // 卡片 kind 契约锚是 snake_case；kebab（附件 kind 风格）不是本枚举合法值
        let raw = r#""file-context""#;
        assert!(serde_json::from_str::<ContextInjectionCardKind>(raw).is_err());
    }

    #[test]
    fn injection_status_serializes_to_snake_case_wire_values() {
        assert_eq!(
            serde_json::to_value(ContextInjectionStatus::Pending).unwrap(),
            "pending"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionStatus::Injected).unwrap(),
            "injected"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionStatus::Active).unwrap(),
            "active"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionStatus::Expired).unwrap(),
            "expired"
        );
        assert_eq!(
            serde_json::to_value(ContextInjectionStatus::Failed).unwrap(),
            "failed"
        );
    }

    #[test]
    fn card_payload_serializes_to_camel_case_with_none_skipped() {
        let card = ContextInjectionCardPayload {
            id: "card_rule_01".into(),
            kind: ContextInjectionCardKind::Rule,
            title: "⚡ 规则注入: AGENTS.md".into(),
            summary: Some("仓库协作纪律".into()),
            status: ContextInjectionStatus::Injected,
            source: "rule_loader".into(),
            content: "# AGENTS.md\n- 反退避".into(),
            token_estimate: Some(320),
            target_paths: None,
            timestamp: 1_700_000_000_000,
            is_foldable: Some(true),
            default_folded: Some(true),
            error_message: None,
            metadata: None,
        };
        let value = serde_json::to_value(&card).unwrap();
        assert_eq!(value["id"], "card_rule_01");
        assert_eq!(value["kind"], "rule");
        assert_eq!(value["summary"], "仓库协作纪律");
        assert_eq!(value["status"], "injected");
        assert_eq!(value["tokenEstimate"], 320);
        assert_eq!(value["timestamp"], 1_700_000_000_000u64);
        assert_eq!(value["isFoldable"], true);
        assert_eq!(value["defaultFolded"], true);
        // 未设置的可选键应整体跳过（摘要语义键为 summary 而非 description）
        assert!(value.get("targetPaths").is_none());
        assert!(value.get("errorMessage").is_none());
        assert!(value.get("metadata").is_none());
        assert!(value.get("description").is_none(), "摘要键必须为 summary");
    }

    #[test]
    fn card_payload_roundtrip_with_attachment_metadata() {
        // metadata 挂详案 04 附件元数据子结构（attachment.rs 的 JSON 投影）
        let card = ContextInjectionCardPayload {
            id: "card_file_02".into(),
            kind: ContextInjectionCardKind::FileContext,
            title: "📎 文件引用: sessionStore.ts".into(),
            summary: None,
            status: ContextInjectionStatus::Active,
            source: "user_mention".into(),
            content: "export function addMessage() {}".into(),
            token_estimate: None,
            target_paths: Some(vec!["apps/crish-desktop/src/store/sessionStore.ts".into()]),
            timestamp: 1_700_000_000_001,
            is_foldable: None,
            default_folded: None,
            error_message: Some("文件读取失败".into()),
            metadata: Some(serde_json::json!({
                "kind": "code-snippet",
                "truncation": {
                    "isTruncated": false,
                    "originalSizeBytes": 120,
                    "injectedSizeBytes": 120,
                    "originalLines": 4,
                    "injectedLines": 4,
                    "truncationStrategy": "none"
                }
            })),
        };
        let json = serde_json::to_string(&card).unwrap();
        let back: ContextInjectionCardPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(card, back);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["metadata"]["kind"], "code-snippet");
        assert_eq!(value["errorMessage"], "文件读取失败");
    }

    #[test]
    fn card_payload_missing_optional_keys_deserialize_to_none() {
        // TS 侧可省略的可选键在 Rust 反序列化时缺省 → None，不炸
        let raw = r#"{
            "id": "c1",
            "kind": "schedule_trigger",
            "title": "🕒 定时触发",
            "status": "pending",
            "source": "schedule_panel",
            "content": "",
            "timestamp": 1700000000000
        }"#;
        let card: ContextInjectionCardPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(card.summary, None);
        assert_eq!(card.token_estimate, None);
        assert_eq!(card.target_paths, None);
        assert_eq!(card.is_foldable, None);
        assert_eq!(card.default_folded, None);
        assert_eq!(card.error_message, None);
        assert_eq!(card.metadata, None);
    }
}
