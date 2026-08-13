//! Responses API pending function_call 管理（SR-06e · 拆分 · ≠ EL）
//!
//! [super::ResponsesParser] 的工具调用增量收集面：按 item_id/call_id 分组合并
//! function_call item 与 arguments 增量（对齐 mergeResponseToolCallItem 290-315、
//! mergeResponseToolCallArguments 317-340），定位与 emit 去重（findResponseToolCallKey
//! 342-355、emitResponseToolCall 357-371）。状态机在 [super::responses_core]。

use serde_json::{Map, Value};

use crate::events::ProviderStreamEvent;

use super::super::tool_call::parse_arguments;
use super::responses_core::string_field;
use super::{ResponsePendingToolCall, ResponsesParser};

impl ResponsesParser {
    /// 合并 function_call item 进 pending（对齐 mergeResponseToolCallItem 290-315）
    ///
    /// 仅 `type === 'function_call'` 的 item 参与；返回 pending 下标（未命中返回 None）。
    pub(super) fn merge_item(&mut self, item: Option<&Value>) -> Option<usize> {
        let record = item?.as_object()?;
        if string_field(record.get("type")) != Some("function_call") {
            return None;
        }        let item_id = string_field(record.get("id"));
        let call_id = string_field(record.get("call_id"));
        // key 兜底链：findKey ?? item_id ?? call_id ?? `response_call_{n}`（298-303）
        let key = self
            .find_pending(item_id, call_id)
            .map(|index| self.pending[index].key.clone())
            .unwrap_or_else(|| {
                item_id
                    .map(str::to_owned)
                    .or_else(|| call_id.map(str::to_owned))
                    .unwrap_or_else(|| format!("response_call_{}", self.pending.len()))
            });
        let index = match self.pending.iter().position(|call| call.key == key) {
            Some(index) => index,
            None => {
                self.pending.push(ResponsePendingToolCall {
                    key: key.clone(),
                    call_id: call_id.map(str::to_owned).unwrap_or_else(|| {
                        item_id.map(str::to_owned).unwrap_or_else(|| key.clone())
                    }),
                    name: String::new(),
                    arguments_text: String::new(),
                    arguments_done: false,
                });
                self.pending.len() - 1
            }
        };
        {
            let call = &mut self.pending[index];
            // 覆盖式：call_id / name 仅在提供时覆盖；arguments 字符串整体替换（309-312）
            if let Some(call_id) = call_id {
                call.call_id = call_id.to_owned();
            }
            if let Some(name) = string_field(record.get("name")) {
                call.name = name.to_owned();
            }
            if let Some(arguments) = string_field(record.get("arguments")) {
                call.arguments_text = arguments.to_owned();
            }
        }
        Some(index)
    }

    /// 合并 function_call_arguments 增量（对齐 mergeResponseToolCallArguments 317-340）
    ///
    /// `append=true`（delta 帧）追加拼接；`append=false`（done 帧）整体替换。
    /// 找不到 key（item_id/call_id 均缺失且无法定位）→ 无操作（325-326）。
    pub(super) fn merge_arguments(&mut self, payload: &Map<String, Value>, append: bool) -> Option<usize> {
        let item_id = string_field(payload.get("item_id"));
        let call_id = string_field(payload.get("call_id"));
        let index = match self.find_pending(item_id, call_id) {
            Some(index) => index,
            None => {
                // key = item_id ?? call_id；均缺失 → 无操作（325-326）
                let key = item_id
                    .map(str::to_owned)
                    .or_else(|| call_id.map(str::to_owned))?;
                let new_index = self.pending.len();
                self.pending.push(ResponsePendingToolCall {
                    key: key.clone(),
                    call_id: call_id.map(str::to_owned).unwrap_or_else(|| key.clone()),
                    name: String::new(),
                    arguments_text: String::new(),
                    arguments_done: false,
                });
                new_index
            }
        };
        // arguments ?? delta（333-335）
        let arguments_text = string_field(payload.get("arguments"))
            .or_else(|| string_field(payload.get("delta")));
        if let Some(arguments_text) = arguments_text {
            let call = &mut self.pending[index];
            if append {
                call.arguments_text.push_str(arguments_text);
            } else {
                call.arguments_text = arguments_text.to_owned();
            }
        }
        Some(index)
    }

    /// 定位已有 pending（对齐 findResponseToolCallKey 342-355）
    ///
    /// 顺序：key==item_id → key==call_id → 扫 call_id 字段。
    pub(super) fn find_pending(&self, item_id: Option<&str>, call_id: Option<&str>) -> Option<usize> {
        if let Some(item_id) = item_id {
            if let Some(index) = self.pending.iter().position(|call| call.key == item_id) {
                return Some(index);
            }
        }
        if let Some(call_id) = call_id {
            if let Some(index) = self.pending.iter().position(|call| call.key == call_id) {
                return Some(index);
            }
        }
        if let Some(call_id) = call_id {
            if let Some(index) = self.pending.iter().position(|call| call.call_id == call_id) {
                return Some(index);
            }
        }
        None
    }

    /// emit 工具调用（对齐 emitResponseToolCall 357-371）
    ///
    /// 无 name、无 emittedKey 或已 emit → None（去重）；事件 id 取 call_id ?? id。
    pub(super) fn emit_tool_call(&mut self, index: usize) -> Option<ProviderStreamEvent> {
        let call = &self.pending[index];
        if call.name.is_empty() {
            return None;
        }
        let emitted_key = call.call_id.clone();
        if self.emitted.contains(&emitted_key) {
            return None;
        }
        self.emitted.insert(emitted_key.clone());
        Some(ProviderStreamEvent::ToolCall {
            id: Some(call.call_id.clone()),
            tool_name: call.name.clone(),
            input: parse_arguments(&call.arguments_text),
        })
    }
}
