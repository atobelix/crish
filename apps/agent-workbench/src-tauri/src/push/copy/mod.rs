//! 推送文案渲染（R3-01 部分 3：D7 §6.5 push/copy.rs）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md` §6.5（文案生成：新增
//!   push/copy.rs，复用 wakeup_summary 风格与「无占位符残留」测试护栏）、
//!   §3.3 场景明细（S1-S12 文案规则）、§3.3.13（场景载荷样例 = §10.2 文案
//!   单测的 golden fixture）；
//! - `docs/multi-device/plans/M8-push-release.md`（render_copy(intent) →
//!   {title, body}）。
//!
//! 输入契约：[crate::push::intent::PayloadDigest]（`digest` = 正文主体文本、
//! `detail` = 次级文本）；输出 [CopyText] {title, body}，经
//! [crate::push::schema::PushMessage::with_copy] 填入 [PushMessage]
//! （[message_with_copy] 为组装入口——[crate::push::pusher::PushDispatcher]
//! 分发时调用，WS 直推与离线 pending 一并携带完整文案；厂商通道消费
//! [crate::push::vendor::consumer::notification_from_pending] 的
//! title/body→digest 桥接即还原完整通知）。
//!
//! 场景 → 文案映射（对齐 D7 §3.3 明细 + §3.3.13 样例；样例缺失的场景按
//! 明细模板渲染。载荷缺口如实注记：时长/退出码/角色/拦截目标等不在
//! [PayloadDigest] 的面——装配轮如需补齐，扩展 PayloadDigest 或文案入参即可，
//! 本层按现有契约渲染）：
//!
//! | 场景 | 标题 | 正文 |
//! | --- | --- | --- |
//! | S1 审批请求 | Crish 需要你的批准 | `{toolName}：{summary}` |
//! | S2 审批过期 | 审批已过期 | `审批（{toolCallId}）等待超时，已自动拒绝` |
//! | S3 run 完成 | 任务已完成 | `任务 {runId} 已完成` |
//! | S4 run 失败 | 任务运行失败 | `{runId}：{error}` |
//! | S5 run 取消 | 任务已取消 | `任务 {runId} 已被取消` |
//! | S6 子代理完成 | 子代理已完成 | `子代理（{id}）已完成：成功[——{summary}]` |
//! | S7 子代理失败 | 子代理失败 | `子代理（{id}）失败[——{summary}]` |
//! | S8a 任务启动 | 后台任务已启动 | `{command}` |
//! | S8b 任务完成 | 任务已完成 | `任务 {taskId} 已完成[，{exit code N}]` |
//! | S8c 任务卡死 | 任务疑似卡死 | `任务 {taskId} 疑似卡死（{N} 秒无输出）` |
//! | S8d 任务失败 | 后台任务异常退出 | `任务 {taskId} 异常退出（exit code N）` |
//! | S8e 任务终止 | 任务已终止 | `任务 {taskId} 已被终止` |
//! | S9a 定时器 | 定时器提醒 | `{prompt}（定时器 {id} 已到期）` |
//! | S9b cron | 定时器提醒 | `{prompt}（cron {id} 第 {n} 次触发）` |
//! | S10a 运行异常 | 运行异常 | `{error}` |
//! | S10b 需介入 | 需要你介入 | `{reason}` |
//! | S11 安全拦截 | 安全拦截 | `拦截{操作}操作` |
//! | S12 缓存告警 | 缓存浪费告警 | `本次运行浪费约 {N} token[（约 ${cost}）]` |

use super::engine::PushDecision;
use super::intent::PayloadDigest;
use super::scenes::SceneId;
use super::schema::{message_from_decision, PushMessage};
use super::vendor::VendorDevice;

mod night_summary;
mod scene_en;
mod scene_zh;

pub use night_summary::{
    render_night_summary_copy, render_night_summary_for_device, render_night_summary_with_locale,
};
use scene_en::{render_body_en, render_title_en};
use scene_zh::{render_body_zh, render_title_zh};

/// 渲染产物（title/body；[crate::push::schema::PushMessage::with_copy] 入参）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyText {
    /// 通知标题（移动端横幅主文本）
    pub title: String,
    /// 通知正文
    pub body: String,
}

/// 判断指定 locale 是否为英文（"en", "en-US", "en_GB" 等）
pub fn is_english(locale: Option<&str>) -> bool {
    locale
        .map(|l| l.trim().to_ascii_lowercase().starts_with("en"))
        .unwrap_or(false)
}

/// 场景 → 标题/正文渲染（兼容现有签名，默认中文兜底）
pub fn render_copy(scene: SceneId, payload: &PayloadDigest) -> CopyText {
    render_copy_with_locale(scene, payload, None)
}

/// 场景 → 标题/正文多语言渲染（纯函数无 I/O，支持 en / zh）
pub fn render_copy_with_locale(
    scene: SceneId,
    payload: &PayloadDigest,
    locale: Option<&str>,
) -> CopyText {
    let is_en = is_english(locale);
    let title = if is_en {
        render_title_en(scene)
    } else {
        render_title_zh(scene)
    };
    let body = if is_en {
        render_body_en(scene, payload)
    } else {
        render_body_zh(scene, payload)
    };
    CopyText { title, body }
}

/// 为指定目标设备渲染文案（从设备的 preferred_language 获取 locale）
pub fn render_copy_for_device(
    scene: SceneId,
    payload: &PayloadDigest,
    device: &VendorDevice,
) -> CopyText {
    render_copy_with_locale(scene, payload, device.preferred_language.as_deref())
}

/// 组装入口：决策 → 带完整文案的 [PushMessage]（默认中文）
pub fn message_with_copy(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
) -> PushMessage {
    message_with_copy_locale(decision, id, seq, now_ms, None)
}

/// 组装入口：决策 → 带多语言文案的 [PushMessage]
pub fn message_with_copy_locale(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
    locale: Option<&str>,
) -> PushMessage {
    let copy = render_copy_with_locale(decision.scene, &decision.payload, locale);
    message_from_decision(decision, id, seq, now_ms).with_copy(copy.title, copy.body)
}

/// 组装入口：决策 → 带目标设备语言文案的 [PushMessage]
pub fn message_with_copy_for_device(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
    device: &VendorDevice,
) -> PushMessage {
    message_with_copy_locale(
        decision,
        id,
        seq,
        now_ms,
        device.preferred_language.as_deref(),
    )
}

#[cfg(test)]
mod tests;
