//! Runtime 域（会话级）命令、结果与事件类型。

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Runtime 域（会话级）
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateParams {
    pub expression: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_by_value: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub await_promise: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_gesture: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateResult {
    pub result: RemoteObject,
    pub exception_details: Option<ExceptionDetails>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIsolatedWorldResult {
    pub execution_context_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteObject {
    #[serde(rename = "type")]
    pub object_type: String,
    pub subtype: Option<String>,
    pub value: Option<Value>,
    pub description: Option<String>,
    pub object_id: Option<String>,
    pub class_name: Option<String>,
    pub unserializable_value: Option<String>,
    pub preview: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionDetails {
    pub text: String,
    pub exception: Option<RemoteObject>,
    pub line_number: Option<i64>,
    pub column_number: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallFunctionOnParams {
    pub function_declaration: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<CallArgument>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_by_value: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub await_promise: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallArgument {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPropertiesParams {
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub own_properties: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generate_preview: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPropertiesResult {
    pub result: Vec<PropertyDescriptor>,
    pub internal_properties: Option<Vec<PropertyDescriptor>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDescriptor {
    pub name: String,
    pub value: Option<RemoteObject>,
    pub writable: Option<bool>,
    pub get: Option<RemoteObject>,
    pub set: Option<RemoteObject>,
    pub configurable: Option<bool>,
    pub enumerable: Option<bool>,
    pub is_own: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseObjectParams {
    pub object_id: String,
}

// Runtime 事件

/// Runtime.executionContextCreated 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextCreatedEvent {
    pub context: ExecutionContextDescription,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContextDescription {
    pub id: i64,
    pub origin: Option<String>,
    pub name: Option<String>,
    pub aux_data: Option<Value>,
}

/// Runtime.consoleAPICalled 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleApiCalledEvent {
    #[serde(rename = "type")]
    pub call_type: String,
    pub args: Vec<RemoteObject>,
    pub timestamp: Option<f64>,
    pub execution_context_id: Option<i64>,
}

/// Runtime.exceptionThrown 事件参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionThrownEvent {
    pub timestamp: f64,
    pub exception_details: ExceptionDetails,
}
