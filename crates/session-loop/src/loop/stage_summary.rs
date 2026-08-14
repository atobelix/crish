//! 分阶段总结（E2 F5）内核面：里程碑判定 + Schema 构造 + checkpoint 载荷
//! 转换 + 终结摘要素材继承链 + 配置解析辅助
//!
//! 本模块为 F5 的**独立面**（07-实现方案 §4「卡 D」）：提供纯函数与配置
//! 位，供后续批次（core_run_commands.rs 壳层接线）在 run 收口评估里程碑、
//! 经 Summarizer 对完整对话产出阶段总结、拼接系统提示词段、落
//! checkpoint 载荷。**本模块不持有 run 状态**——已触发里程碑集合由调用方
//! 经 [StageMilestoneState] 维护（会话级，跨 run 持久化由壳层批次承接）。
//!
//! 设计来源：
//! - E2 §6.2（Schema V1 骨架 + tier="stage-N" + droppedIds 空 + custom
//!   range 字段；里程碑阈值 40/60/80% 可配）；
//! - 07-实现方案 §4.2/§4.3（触发即 Summarizer 产出、注入系统提示词段、
//!   落 checkpoint 载荷、素材继承链）；
//! - D7 §3.2 阶段总结载荷（set_leaf_checkpoint 承载，恢复/续跑经
//!   read_leaf_checkpoint 注入系统段；summary 截断 ≤500 字符由注入侧执行）。
//!
//! 稳定化纪律（E2 §6.5 ①/⑤）：所有文本产出（md 渲染 / checkpoint
//! summary / existing 素材）均为**确定性序列化**——同文档同输出、无时间戳、
//! 无随机量，使触发后的新前缀可重复命中 provider 缓存。

use conex_compaction::summary_document::{summary_to_markdown, SUMMARY_SCHEMA_VERSION};
use conex_types::checkpoint::CheckpointPayload;

/// 默认里程碑阶梯（E2 §7.1：`compact_stage_ratios` 默认 [0.4, 0.6, 0.8]；
/// 语义 = estimate/window 比例）
pub const DEFAULT_COMPACT_STAGE_RATIOS: [f64; 3] = [0.4, 0.6, 0.8];

/// session_meta 键：里程碑阶梯（JSON 数组；缺省 [DEFAULT_COMPACT_STAGE_RATIOS]）
pub const META_KEY_STAGE_RATIOS: &str = "compact_stage_ratios";

/// 解析里程碑阶梯配置值（宽容 fail-open，仿 summary_dispatch
/// `parse_backoff_ms` 先例）：
/// - JSON 数组 → 逐项取 f64，过滤非有限值 / ≤0 / >1（比例必须在 (0,1]），
///   非法项丢弃；结果排序 + 去重（升序，判定遍历确定性）；
/// - 单个数值 → 退化为单元素序列；
/// - 空数组 / 其余形态 → None（调用方回退默认阶梯）。
pub fn parse_stage_ratios(raw: &str) -> Option<Vec<f64>> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let mut ratios: Vec<f64> = match value {
            serde_json::Value::Array(items) => items
                .into_iter()
                .filter_map(|item| {
                    let v = item.as_f64()?;
                    if v.is_finite() && v > 0.0 && v <= 1.0 {
                        Some(v)
                    } else {
                        None
                    }
                })
                .collect(),
            serde_json::Value::Number(n) => {
                let v = n.as_f64()?;
                if v.is_finite() && v > 0.0 && v <= 1.0 {
                    vec![v]
                } else {
                    Vec::new()
                }
            }
            _ => return None,
        };
        if ratios.is_empty() {
            return None;
        }
        ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        ratios.dedup();
        Some(ratios)
    } else if let Ok(v) = trimmed.parse::<f64>() {
        if v.is_finite() && v > 0.0 && v <= 1.0 {
            Some(vec![v])
        } else {
            None
        }
    } else {
        None
    }
}

/// 解析 session_meta 键值 → 里程碑阶梯（T-44 配置读取 helper 形状，供壳层
/// 后续批次装配 `SessionLoopOptions::compact_stage_ratios` 时复用）。
///
/// 宽容 fail-open：键缺失 → None（调用方回退默认阶梯）；键存在但解析
/// 失败 → warn 留痕 + None（不 panic、不阻断 run 装配）。
pub fn stage_ratios_from_session_meta(meta: impl Fn(&str) -> Option<String>) -> Option<Vec<f64>> {
    let raw = meta(META_KEY_STAGE_RATIOS)?;
    let parsed = parse_stage_ratios(&raw);
    if parsed.is_none() {
        tracing::warn!(
            key = META_KEY_STAGE_RATIOS,
            default = ?DEFAULT_COMPACT_STAGE_RATIOS,
            "阶段里程碑阶梯配置缺失/非法 → 回退默认 [0.4, 0.6, 0.8]"
        );
    }
    parsed
}

/// 对话长度比例（estimate/window 双源口径，E2 §6.2：estimate_context 与
/// 窗口元数据；窗口为 0 → 0.0 = 永不触发，防除零）。
pub fn estimate_ratio(estimate: u64, window: u64) -> f64 {
    if window == 0 {
        0.0
    } else {
        estimate as f64 / window as f64
    }
}

/// 里程碑判定纯函数（E2 §6.2 / 07-实现方案 §4.1）：`ratio`（estimate/window
/// 比例）≥ 某未触发里程碑 → 返回该里程碑的**下标**（对应 `ratios` 升序
/// 阶梯的索引）；无可触发里程碑 → None。
///
/// - `ratios`：配置里程碑（升序，建议经 [parse_stage_ratios] 归一化）；
/// - `triggered`：已触发里程碑下标集合（对话生命周期内每阶梯只触发一次；
///   会话级跨 run 由 [StageMilestoneState] / 壳层持久化维护）；
/// - 遍历取**第一个**满足者：对话渐进增长时低阶梯先于高阶梯达成，返回
///   未触发的最小满足者（异常顺序——高阶梯已触发而低阶梯未触发——同样
///   补触发低阶梯，保证里程碑覆盖完备）；
/// - `ratio` 非有限 / 负值 → None（防御，不触发）。
pub fn next_pending_milestone(ratio: f64, ratios: &[f64], triggered: &[u32]) -> Option<u32> {
    if !ratio.is_finite() || ratio < 0.0 {
        return None;
    }
    for (index, threshold) in ratios.iter().enumerate() {
        if !threshold.is_finite() {
            continue;
        }
        if ratio >= *threshold && !triggered.contains(&(index as u32)) {
            return Some(index as u32);
        }
    }
    None
}

/// 里程碑下标 → tier 标记（E2 §6.2：`"stage-N"`，N 从 1 起；默认阶梯
/// [0.4, 0.6, 0.8] 对应 stage-1 / stage-2 / stage-3）。
pub fn stage_tier(stage_index: u32) -> String {
    format!("stage-{}", stage_index + 1)
}

/// 阶段总结覆盖的消息 id 区间（Schema V1 custom `range` 字段，E2 §6.2：
/// 无损视角的进度快照范围，非丢弃段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageSummaryRange {
    /// 区间起点消息 id（含）
    pub start_message_id: String,
    /// 区间终点消息 id（含）
    pub end_message_id: String,
    /// 区间消息条数
    pub message_count: u32,
}

/// 阶段总结文档构造入参（对齐 Schema V1 骨架，E2 §6.2 / 07 §4.2）。
///
/// 构造辅助 [build_stage_summary_document] 产出合法 Schema V1 JSON：
/// schemaVersion/blockId/generation/droppedIds=[]/height=1/
/// tier="stage-N"/goal/constraints/progress/decisions/nextSteps/
/// criticalContext + custom `range`（覆盖消息 id 区间）。required 骨架
/// 与压缩摘要完全一致（校验兼容，summary_document.rs 不变）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageSummaryDocument {
    /// 里程碑下标（0-based；tier = stage-{stage_index + 1}）
    pub stage_index: u32,
    /// 块 id（建议 `stage-summary-{stage_index + 1}`，调用方定）
    pub block_id: String,
    /// 压缩代数（会话代数单源；无压缩代数时 0）
    pub generation: u32,
    /// 当前目标（goal 字段；终结摘要 / checkpoint target 继承面）
    pub goal: String,
    /// 约束清单
    pub constraints: Vec<String>,
    /// 已完成进展（progress 字段；终结摘要 / checkpoint 继承面）
    pub progress: Vec<String>,
    /// 关键决策
    pub decisions: Vec<String>,
    /// 下一步清单（nextSteps 字段；终结摘要 / checkpoint 继承面）
    pub next_steps: Vec<String>,
    /// 关键上下文（criticalContext 字段）
    pub critical_context: String,
    /// 覆盖消息 id 区间（custom range 字段；None = 不输出）
    pub range: Option<StageSummaryRange>,
}

/// 构造阶段总结 Schema V1 文档（纯函数；产出可经
/// [conex_compaction::summary_document::validate_summary_document] 校验）。
pub fn build_stage_summary_document(input: &StageSummaryDocument) -> serde_json::Value {
    let mut doc = serde_json::json!({
        "schemaVersion": SUMMARY_SCHEMA_VERSION,
        "blockId": input.block_id,
        "generation": input.generation,
        "droppedIds": [],
        "height": 1,
        "tier": stage_tier(input.stage_index),
        "goal": input.goal,
        "constraints": input.constraints,
        "progress": input.progress,
        "decisions": input.decisions,
        "nextSteps": input.next_steps,
        "criticalContext": input.critical_context,
    });
    if let Some(range) = &input.range {
        doc["range"] = serde_json::json!({
            "startMessageId": range.start_message_id,
            "endMessageId": range.end_message_id,
            "messageCount": range.message_count,
        });
    }
    doc
}

/// 阶段总结 md 渲染（确定性投影：同文档同输出、无时间戳；骨架节复用
/// Schema V1 渲染面，另加 tier 标注头——系统提示词段注入 / 观测展示用）。
pub fn stage_summary_to_markdown(doc: &serde_json::Value) -> String {
    let tier = doc.get("tier").and_then(|v| v.as_str()).unwrap_or("stage");
    let mut out = String::new();
    out.push_str(&format!("## 阶段性总结（{tier}）\n"));
    out.push_str(&summary_to_markdown(doc));
    out
}

/// 终结摘要素材继承面（E2 §6.4 / 07 §4.4：阶段总结是终结摘要的素材与
/// 继承链——终结摘要以最新阶段总结文本为 `existing` 迭代合并，贯通
/// goal/nextSteps 续轮注入）。本结构定义**可被终结摘要继承的字段面**。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StageSummaryInheritance<'a> {
    /// goal 字段（目标继承）
    pub goal: Option<&'a str>,
    /// progress 字段（进展继承）
    pub progress: Vec<&'a str>,
    /// nextSteps 字段（下一步继承，续轮注入数据源）
    pub next_steps: Vec<&'a str>,
}

/// 提取阶段总结的可继承字段（纯函数；字段缺失/非字符串 → 空面）。
pub fn stage_summary_inheritance(doc: &serde_json::Value) -> StageSummaryInheritance<'_> {
    StageSummaryInheritance {
        goal: doc.get("goal").and_then(|v| v.as_str()),
        progress: string_array(doc, "progress"),
        next_steps: string_array(doc, "nextSteps"),
    }
}

/// 终结摘要 existing 素材文本（确定性序列化：tier 标注 + goal/nextSteps
/// 全量字段，供 Summarizer::summarize(dropped, existing) 的 existing 入参
/// 迭代合并——阶段总结产出 progress/nextSteps 被终结摘要继承）。
pub fn stage_summary_to_existing_text(doc: &serde_json::Value) -> String {
    let inherited = stage_summary_inheritance(doc);
    let tier = doc.get("tier").and_then(|v| v.as_str()).unwrap_or("stage");
    let mut out = String::new();
    out.push_str(&format!("[{tier} 阶段总结]\n"));
    if let Some(goal) = inherited.goal {
        out.push_str(&format!("目标：{goal}\n"));
    }
    for progress in &inherited.progress {
        out.push_str(&format!("已完成：{progress}\n"));
    }
    for next in &inherited.next_steps {
        out.push_str(&format!("下一步：{next}\n"));
    }
    out
}

/// 阶段总结 → checkpoint 载荷转换（E2 §6.4 / D7 §3.2：阶段总结经
/// set_leaf_checkpoint 落叶子 payload 的 `checkpoint` 键；恢复/续跑经
/// read_leaf_checkpoint 注入系统提示词段）。
///
/// 字段映射（CheckpointPayload 形状，conex-types/checkpoint.rs）：
/// - target ← goal（当前目标）；
/// - summary ← `[tier] progress 列表拼接`（进度快照；tier 前缀为稳定化
///   序列化——恢复注入文本可辨识阶段，无额外载荷键）；
/// - completed ← progress（已完成步骤）；
/// - next ← nextSteps（下一步）；
/// - files 空（阶段总结为无损进度快照，不携带文件清单）；
/// - timestamp None（采集端补当前时间，与 CHECKPOINT 行标记同通道语义）。
///
/// 实际落库由 D7 面 / 后续批次接线（本函数为转换接口）。
pub fn stage_summary_to_checkpoint_payload(doc: &serde_json::Value) -> CheckpointPayload {
    let goal = doc
        .get("goal")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let progress: Vec<String> = string_array(doc, "progress")
        .into_iter()
        .map(str::to_string)
        .collect();
    let next_steps: Vec<String> = string_array(doc, "nextSteps")
        .into_iter()
        .map(str::to_string)
        .collect();
    let tier = doc.get("tier").and_then(|v| v.as_str()).unwrap_or("stage");
    let summary = if progress.is_empty() {
        format!("[{tier}] 阶段无进展记录")
    } else {
        format!("[{tier}] {}", progress.join("；"))
    };
    CheckpointPayload {
        target: goal,
        summary,
        timestamp: None,
        completed: progress,
        files: Vec::new(),
        next: next_steps,
    }
}

/// 字符串数组字段读取（非数组 / 非字符串项跳过）
fn string_array<'a>(doc: &'a serde_json::Value, key: &str) -> Vec<&'a str> {
    doc.get(key)
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|item| item.as_str()).collect())
        .unwrap_or_default()
}

/// 已触发里程碑集合（对话生命周期内每阶梯只触发一次，E2 §6.2）。
///
/// 会话级状态容器：跨 run 持久化（快照/恢复）由壳层后续批次承接；本
/// 结构为纯内存面，判定经 [next_pending_milestone] 消费 `triggered()`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StageMilestoneState {
    triggered: Vec<u32>,
}

impl StageMilestoneState {
    /// 空集合（新会话 / 恢复后的起点）
    pub fn new() -> Self {
        Self::default()
    }

    /// 已触发里程碑下标（升序；对应配置阶梯下标）
    pub fn triggered(&self) -> &[u32] {
        &self.triggered
    }

    /// 某里程碑是否已触发
    pub fn has_triggered(&self, index: u32) -> bool {
        self.triggered.contains(&index)
    }

    /// 标记某里程碑已触发（幂等：重复标记不重复登记）
    pub fn mark_triggered(&mut self, index: u32) {
        if !self.triggered.contains(&index) {
            self.triggered.push(index);
            self.triggered.sort_unstable();
        }
    }
}

#[cfg(test)]
#[path = "stage_summary_tests.rs"]
mod tests;
