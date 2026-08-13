//! chat-completions 流解析器（任务书 B2.5；02-provider-semantics.md §二.2-2.3、§六.3-5）
//!
//! 帧处理顺序（02 §2.2，不可变，§六.3）：
//! 1. 错误帧（error / message / error_description / code）→ 立即 `stop{reason:'error'}` 终止
//! 2. usage 覆盖式解析（任何帧都可能携带；仅接受有限数值，§2.5）
//! 3. `choices[0].delta`：content → text-delta；reasoning_content → thinking → thinking_delta
//!    优先级 → thought-delta（02 §1.4）；tool_calls → 合并进 pending
//! 4. 兼容位置全探测（§五 #7/#8）：delta.tool_calls / delta.function_call /
//!    choice.message.tool_calls / choice.tool_calls / 平铺字段
//! 5. finish_reason → 覆盖式映射（§2.2 末表格）
//!
//! 仅当无 `choice` 时跳过整帧（delta 缺失不得连带跳过 finish_reason，§五 #7）。
//! 流结束（[ChatCompletionsParser::finish]）：flush pending（RU-06 缺 name 诊断）→
//! RU-08 强制 tool-call → RU-09 零捕获诊断 → 唯一 stop（02 §五 #4/#5/#6）。
//!
//! 产出事件全部经 [StreamParser](crate::events::StreamParser)（events.rs B2.4）校验，
//! 保证每流恰好一个 stop。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 chat_tests.rs）：
//! - [chat_core]：ChatCompletionsParser 状态机（push_frame / finish 帧处理顺序）
//! - [chat_mapping]：finish_reason_to_stop / parse_usage / provider_body_error 与字段工具

#[path = "chat_core.rs"]
mod chat_core;
#[path = "chat_mapping.rs"]
mod chat_mapping;

pub use chat_core::ChatCompletionsParser;
pub use chat_mapping::{finish_reason_to_stop, parse_usage};

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;
