//! agent-provider：provider HTTP 协议层（reqwest + SSE）。
//!
//! 已实现：
//! - [events]（B2.4）：低级流事件 ProviderStreamEvent 5 种 + ProviderUsage +
//!   每流恰好一个 stop 的状态机包装器（02 §六.9）
//! - [sse]（B2.3）：分帧层 frame + 双段超时/abort 读取 reader（02 §二.1、§六.1-2）
//! - [transport]（B2.3）：reqwest bytes_stream 适配
//! - [config] / [credentials]（B2.2）：Provider 配置加载/解析与凭据存储
//! - [parse]（B2.5/B2.9）：chat-completions 帧解析与 tool_call 增量收集（02 §六.3-5）；
//!   Responses / Anthropic / Gemini 三家补充解析器与各自 usage 合并策略（02 §二.4、§三、§六.6）
//! - [request]（B2.6）：chat-completions 请求体构建、消息映射、vendor 机制、thinking 透传
//! - [error]（B2.7）：ProviderError 分类管线，收敛 conex-types 13 类（02 §四）
//! - [retry]（B2.7）：指数退避重试器与 provider_stream 高层封装（02 §六.7-8）
//! - [consume]（B2.8）：流事件消费聚合 + stopReason 生成（02 §一.3、§五.12、§六.12；01 D6）
//! - [models]（P3）：厂商/模型层数据目录（模型元数据 + 内置表 + 多级兜底查询）
//! - [migration]：存量 models.yaml 无损平滑自动迁移引擎
//! - [pricing]：四维双币微元定点计费引擎 (Micros Pricing Engine)

pub mod config;
pub mod consume;
pub mod credentials;
pub mod error;
pub mod events;
pub mod migration;
pub mod models;
pub mod parse;
pub mod pricing;
pub mod request;
pub mod retry;
pub mod sse;
pub mod transport;
