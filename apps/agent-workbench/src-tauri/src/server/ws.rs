//! WS 事件端点占位（R1-05 实现）
//!
//! R1-05 在此实现 `WS /v1/events`（D2 §10 / Z0 §9.3 R1-05）：
//! - 认证：Bearer 令牌（复用 [crate::server::auth] 校验）；
//! - 订阅：`events.subscribe` / `subscribeAll`（会话级 + 全局轻订阅，
//!   上限 32 会话/设备）；
//! - 重放：按游标 `events.resume`（复用 core_read_session_events 的
//!   EventPage 契约，开区间分页）；
//! - 实时尾随：FanOutEmitter 的 WsBroadcast 分支（R1-01 装配）+ 心跳
//!   （30s）+ 踢出（token 撤销后 `{"type":"kicked"}` 关闭，D2 §10.6）；
//! - 连接上限与端级背压（Delta 可丢 / Critical 必达）。
//!
//! 本文件骨架期仅登记路径常量，不注册路由（避免幽灵路由）。

/// WS 事件端点路径（R1-05 注册进 router）
// R1-02 备注：R1-05 注册路由消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
pub const WS_EVENTS_PATH: &str = "/v1/events";
