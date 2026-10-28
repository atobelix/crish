//! 不可变决策账本 (Pinned Decision Ledger - Slot 2.2)
//!
//! 依据 `03-context-and-resilience-improvement.md` §七（§7.1）与 §八（§8.1）：
//! 解决长程多轮压缩后关键决策信息被反复折叠抹平（信息退相干）的问题。
//!
//! ## 核心机制与不变量
//! 1. **槽位归属 (Slot 2.2)**：
//!    - Slot 2: Pinned Global Anchor (全局锚定区，极高命中 KV Cache)
//!      - Slot 2.1: 不可变环境上下文 (工作区根路径、运行平台、基线常量，<= 200t)
//!      - Slot 2.2: Pinned Decision Ledger (不可变决策账本，<= 800t)
//! 2. **沉淀规则 (Promotion)**：
//!    在执行过程中，凡是带有 `DECISION:`（技术选型与架构决策）、
//!    `CONSTRAINT:`（硬性业务约束）、`REDLINE:`（安全红线）的指令与确认项，
//!    在被滑动窗口淘汰时，自动提升沉淀（Promote）进入 Slot 2.2 决策账本；
//! 3. **跨代绝对不可折叠保证 (Pinned & Non-Foldable)**：
//!    Slot 2 决策账本在后续所有轮次的多代压缩中标记为不可折叠（Pinned），
//!    严禁被后续摘要级联压缩抹平；
//! 4. **容量控制 (<= 800 Tokens)**：
//!    超出 800 Tokens 时按优先级（SecurityBoundary > UserExplicitConstraint > ArchitecturalRule）
//!    与时间戳淘汰修剪，确保核心高优决策永不被挤出。

use conex_compaction::tokens::count_tokens_fast;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};

/// 决策账本条目全局保留的 Token 预算上限 (Tokens <= 800)
pub const MAX_DECISION_LEDGER_TOKENS: usize = 800;

/// 不可变决策账本在会话消息流中的标准固化 ID
pub const PINNED_LEDGER_MESSAGE_ID: &str = "slot2-pinned-decision-ledger";

/// 决策类别（依据 §8.1 类型契约）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
pub enum DecisionCategory {
    /// 架构规则与重大技术选型 (DECISION:)
    ArchitecturalRule = 1,
    /// 用户显式硬性约束与业务限制 (CONSTRAINT:)
    UserExplicitConstraint = 2,
    /// 安全红线与绝对禁区 (REDLINE:)
    SecurityBoundary = 3,
}

impl DecisionCategory {
    /// 分类标准字符串标签
    pub fn as_tag(&self) -> &'static str {
        match self {
            Self::ArchitecturalRule => "DECISION",
            Self::UserExplicitConstraint => "CONSTRAINT",
            Self::SecurityBoundary => "REDLINE",
        }
    }

    /// 分类可读中文标签
    pub fn as_label(&self) -> &'static str {
        match self {
            Self::ArchitecturalRule => "架构决策",
            Self::UserExplicitConstraint => "用户约束",
            Self::SecurityBoundary => "安全红线",
        }
    }

    /// 优先级权重（数值越大越重要，淘汰修剪时越靠后被剔除）
    pub fn priority_weight(&self) -> u8 {
        match self {
            Self::SecurityBoundary => 3,
            Self::UserExplicitConstraint => 2,
            Self::ArchitecturalRule => 1,
        }
    }
}

/// 决策账本单个记录条目（依据 §8.1 类型契约）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DecisionLedgerEntry {
    /// 唯一标识（例如 dec-turn3-1）
    pub id: String,
    /// 决策分类
    pub category: DecisionCategory,
    /// 决策核心声明内容
    pub statement: String,
    /// 产生的回合序号 (Turn Index)
    pub created_at_turn: u64,
    /// 来源消息 ID（若有）
    pub source_message_id: Option<String>,
}

/// 不可变决策账本 (Slot 2.2 核心载体)
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PinnedDecisionLedger {
    /// 有序决策条目
    entries: Vec<DecisionLedgerEntry>,
}

impl PinnedDecisionLedger {
    /// 新建空决策账本
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// 获取所有条目只读切片
    pub fn entries(&self) -> &[DecisionLedgerEntry] {
        &self.entries
    }

    /// 账本是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 账本条目总数
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 添加单个决策条目（自动去重与容量修剪）
    pub fn add_entry(&mut self, entry: DecisionLedgerEntry) -> bool {
        let norm_stmt = normalize_statement(&entry.statement);
        if norm_stmt.is_empty() {
            return false;
        }

        // 规范化去重判定：若已有相同核心文本，则忽略或保留更高优者
        if let Some(pos) = self.entries.iter().position(|e| normalize_statement(&e.statement) == norm_stmt) {
            let existing = &self.entries[pos];
            if entry.category.priority_weight() > existing.category.priority_weight() {
                // 升级类别权重
                self.entries[pos] = entry;
                self.enforce_capacity_limit();
                return true;
            }
            return false;
        }

        self.entries.push(entry);
        self.enforce_capacity_limit();
        true
    }

    /// 从一批消息（例如即将丢弃的历史交互）中扫描并提取决策，自动提升沉淀至账本
    ///
    /// 规则：凡是带有 `DECISION:`、`CONSTRAINT:`、`REDLINE:` 的段落/语句行，
    /// 提取分类与核心陈述，提升进 Slot 2.2 账本，返回成功提升的条目数。
    pub fn promote_from_messages(&mut self, messages: &[AgentMessage], current_turn: u64) -> usize {
        let mut promoted_count = 0;
        let mut seq: u32 = 0;

        for msg in messages {
            // 避免从已有的账本锚点中重复自提取
            if Self::is_pinned_ledger_message(msg) {
                continue;
            }

            for block in &msg.blocks {
                let text = match block {
                    AgentMessageBlock::Text { text } => text.as_str(),
                    AgentMessageBlock::ToolResult { output, .. } => {
                        output.text.as_deref().unwrap_or("")
                    }
                    _ => continue,
                };

                for line in text.lines() {
                    let trimmed = line.trim();
                    if let Some((cat, stmt)) = parse_decision_line(trimmed) {
                        seq += 1;
                        let entry = DecisionLedgerEntry {
                            id: format!("dec-t{}-{}", current_turn, seq),
                            category: cat,
                            statement: stmt,
                            created_at_turn: current_turn,
                            source_message_id: Some(msg.id.clone()),
                        };
                        if self.add_entry(entry) {
                            promoted_count += 1;
                        }
                    }
                }
            }
        }

        promoted_count
    }

    /// 估算当前账本的总 Token 占用
    pub fn tokens_estimate(&self) -> usize {
        if self.entries.is_empty() {
            return 0;
        }
        let rendered = self.render_markdown();
        count_tokens_fast(&rendered)
    }

    /// 强制执行容量上限（<= 800 Tokens）
    ///
    /// 超限裁剪规则：
    /// 优先保留 `SecurityBoundary` 与 `UserExplicitConstraint`；
    /// 先按类别优先级升序排序（1 最低，3 最高），同优先级淘汰 `created_at_turn` 较小（较旧）者。
    pub fn enforce_capacity_limit(&mut self) {
        while self.tokens_estimate() > MAX_DECISION_LEDGER_TOKENS && !self.entries.is_empty() {
            // 寻找最适合淘汰的条目索引：
            // 比较键：(priority_weight, created_at_turn) 越小越优先淘汰
            let mut victim_idx = 0;
            let mut min_priority = self.entries[0].category.priority_weight();
            let mut min_turn = self.entries[0].created_at_turn;

            for (idx, item) in self.entries.iter().enumerate().skip(1) {
                let prio = item.category.priority_weight();
                if prio < min_priority || (prio == min_priority && item.created_at_turn < min_turn) {
                    victim_idx = idx;
                    min_priority = prio;
                    min_turn = item.created_at_turn;
                }
            }

            tracing::info!(
                evicted_id = %self.entries[victim_idx].id,
                category = ?self.entries[victim_idx].category,
                "不可变决策账本容量超 800t，按优先级淘汰低优历史决策条目"
            );
            self.entries.remove(victim_idx);
        }
    }

    /// 渲染为 Slot 2.2 标准 Markdown 全局锚定块
    pub fn render_markdown(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }

        let mut out = String::with_capacity(1024);
        out.push_str("## [不可变决策账本 (Pinned Decision Ledger - Slot 2.2)]\n");
        out.push_str("*本账本记录全局核心不可变决断与约束；跨代压缩绝对不折叠抹平。*\n\n");

        let mut redlines = Vec::new();
        let mut constraints = Vec::new();
        let mut decisions = Vec::new();

        for item in &self.entries {
            match item.category {
                DecisionCategory::SecurityBoundary => redlines.push(item),
                DecisionCategory::UserExplicitConstraint => constraints.push(item),
                DecisionCategory::ArchitecturalRule => decisions.push(item),
            }
        }

        if !redlines.is_empty() {
            out.push_str("### 1. 安全红线 (Security Boundaries)\n");
            for item in redlines {
                out.push_str(&format!("- **[REDLINE]**: {}\n", item.statement));
            }
            out.push('\n');
        }

        if !constraints.is_empty() {
            out.push_str("### 2. 用户硬性约束 (User Explicit Constraints)\n");
            for item in constraints {
                out.push_str(&format!("- **[CONSTRAINT]**: {}\n", item.statement));
            }
            out.push('\n');
        }

        if !decisions.is_empty() {
            out.push_str("### 3. 架构决策与技术选型 (Architectural Decisions)\n");
            for item in decisions {
                out.push_str(&format!("- **[DECISION]**: {}\n", item.statement));
            }
            out.push('\n');
        }

        out
    }

    /// 生成一个标记为不可折叠的 Slot 2.2 锚点 AgentMessage
    pub fn to_anchor_message(&self) -> Option<AgentMessage> {
        if self.entries.is_empty() {
            return None;
        }

        let content = self.render_markdown();
        let mut metadata = serde_json::Map::new();
        metadata.insert("slot".to_string(), serde_json::Value::String("2.2".to_string()));
        metadata.insert("pinned".to_string(), serde_json::Value::Bool(true));
        metadata.insert("non_foldable".to_string(), serde_json::Value::Bool(true));

        Some(AgentMessage {
            id: PINNED_LEDGER_MESSAGE_ID.to_string(),
            role: AgentMessageRole::System,
            created_at: conex_shared::time::now_iso_utc(),
            blocks: vec![AgentMessageBlock::Text { text: content }],
            metadata: Some(serde_json::Value::Object(metadata)),
            client_message_id: None,
            content: None,
        })
    }

    /// 判定一条消息是否为 Slot 2.2 不可变决策账本消息
    pub fn is_pinned_ledger_message(msg: &AgentMessage) -> bool {
        if msg.id == PINNED_LEDGER_MESSAGE_ID {
            return true;
        }
        if let Some(meta) = &msg.metadata {
            if let Some(pinned) = meta.get("pinned").and_then(|v| v.as_bool()) {
                if pinned {
                    return true;
                }
            }
            if let Some(slot) = meta.get("slot").and_then(|v| v.as_str()) {
                if slot == "2.2" {
                    return true;
                }
            }
        }
        false
    }

    /// 跨代不可折叠保护：从即将丢弃的 IDs 列表中剥离账本消息并维护在 kept_ids 中
    pub fn protect_from_dropped(
        dropped_ids: &mut Vec<String>,
        kept_ids: &mut Vec<String>,
    ) -> bool {
        let before_len = dropped_ids.len();
        dropped_ids.retain(|id| {
            if id == PINNED_LEDGER_MESSAGE_ID {
                if !kept_ids.contains(id) {
                    kept_ids.push(id.clone());
                }
                false
            } else {
                true
            }
        });
        before_len != dropped_ids.len()
    }
}

/// 规范化 statement，去除首尾标点、Markdown 强调符与多余空白
fn normalize_statement(raw: &str) -> String {
    let trimmed = raw.trim();
    let cleaned = trimmed
        .trim_start_matches(|c: char| c == '*' || c == '_' || c == '`' || c == '-' || c == '#' || c.is_whitespace())
        .trim_end_matches(|c: char| c == '*' || c == '_' || c == '`' || c.is_whitespace());
    cleaned.to_string()
}

/// 解析单行文本是否包含决策标记 (DECISION: / CONSTRAINT: / REDLINE:)
fn parse_decision_line(line: &str) -> Option<(DecisionCategory, String)> {
    let lower = line.to_ascii_lowercase();

    // 匹配前缀模式：支持 [TAG]、**TAG**、TAG:、TAG：
    let tag_candidates = [
        ("redline", DecisionCategory::SecurityBoundary),
        ("安全红线", DecisionCategory::SecurityBoundary),
        ("constraint", DecisionCategory::UserExplicitConstraint),
        ("硬性约束", DecisionCategory::UserExplicitConstraint),
        ("decision", DecisionCategory::ArchitecturalRule),
        ("架构决策", DecisionCategory::ArchitecturalRule),
    ];

    for (keyword, cat) in tag_candidates {
        if let Some(idx) = lower.find(keyword) {
            let after = &line[idx + keyword.len()..];
            // 剥除紧随的冒号、括号、中括号、强调符等分隔符
            let stripped = after.trim_start_matches(|c: char| {
                c == ':' || c == '：' || c == ']' || c == ')' || c == '*' || c == '_' || c == '-' || c.is_whitespace()
            });
            let stmt = normalize_statement(stripped);
            if !stmt.is_empty() && stmt.len() >= 4 {
                return Some((cat, stmt));
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_decision_lines() {
        let line1 = "REDLINE: 严禁自动换模或 Failover 切换模型";
        let res1 = parse_decision_line(line1);
        assert!(res1.is_some());
        let (cat1, stmt1) = res1.unwrap();
        assert_eq!(cat1, DecisionCategory::SecurityBoundary);
        assert_eq!(stmt1, "严禁自动换模或 Failover 切换模型");

        let line2 = "- **[CONSTRAINT]**: 单 Run 必须完整移交持久化，容量不得截断为 64";
        let res2 = parse_decision_line(line2);
        assert!(res2.is_some());
        let (cat2, stmt2) = res2.unwrap();
        assert_eq!(cat2, DecisionCategory::UserExplicitConstraint);
        assert!(stmt2.contains("单 Run 必须完整移交持久化"));

        let line3 = "DECISION：采用 Windows 原生 Job Object 终结孤儿逃逸";
        let res3 = parse_decision_line(line3);
        assert!(res3.is_some());
        let (cat3, stmt3) = res3.unwrap();
        assert_eq!(cat3, DecisionCategory::ArchitecturalRule);
        assert_eq!(stmt3, "采用 Windows 原生 Job Object 终结孤儿逃逸");
    }

    #[test]
    fn test_promote_and_protect_compaction() {
        let mut ledger = PinnedDecisionLedger::new();
        let msg = AgentMessage {
            id: "msg-history-1".to_string(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-10-27T10:00:00Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "我们在架构上做出了以下决断：\nREDLINE: 绝对禁止 In-Flight Hot-Swap 击穿 KV Cache\nDECISION: 使用 Slot 2.2 不可变决策账本".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };

        let promoted = ledger.promote_from_messages(&[msg], 3);
        assert_eq!(promoted, 2);
        assert_eq!(ledger.len(), 2);

        // 验证保护机制
        let mut dropped = vec!["msg-history-1".to_string(), PINNED_LEDGER_MESSAGE_ID.to_string()];
        let mut kept = vec!["msg-history-2".to_string()];
        let protected = PinnedDecisionLedger::protect_from_dropped(&mut dropped, &mut kept);
        assert!(protected);
        assert_eq!(dropped, vec!["msg-history-1".to_string()]);
        assert!(kept.contains(&PINNED_LEDGER_MESSAGE_ID.to_string()));
    }
}
