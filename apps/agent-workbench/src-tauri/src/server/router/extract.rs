//! 请求提取：JSON body extractor 与手写查询参数解析（百分号解码）

use crate::server::ServerError;
use axum::extract::{FromRequest, Request};
use conex_types::device::DeviceErrorCode;
use serde::de::DeserializeOwned;

/// JSON body 请求体上限（2 MiB，与 axum 默认 DefaultBodyLimit 一致；
/// 命令请求默认 ≤64 KiB，超限即拒绝）
const JSON_BODY_LIMIT: usize = 2 * 1024 * 1024;

/// JSON body extractor（反序列化失败 → cmd.invalid 400 + ErrorBody——axum
/// 默认 Json rejection 为文本 400，REST 面统一走 [ServerError] 错误协议
/// 出网，与查询参数非法同码）
pub(super) struct JsonBody<T>(pub T);

impl<S, T> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ServerError;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let bytes = axum::body::to_bytes(req.into_body(), JSON_BODY_LIMIT)
            .await
            .map_err(|e| {
                ServerError::protocol(DeviceErrorCode::CmdInvalid, format!("读取请求体失败：{e}"))
            })?;
        let value: T = serde_json::from_slice(&bytes).map_err(|e| {
            ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                format!("请求体 JSON 非法：{e}"),
            )
        })?;
        Ok(Self(value))
    }
}

/// /v1/info 载荷类型别名（wire 形状见 ServerInfo）
pub(super) type ServerInfoWire = crate::server::ServerInfo;

/// 轻量查询参数表
///
/// axum `query` feature 未启用（D2 §6.4 显式 feature 面），R1-03 不扩依赖
/// 面，手写解析等价语义：未知键忽略、重复键取首个、`%XX`/`+` 解码；
/// 非法编码或非法值 → cmd.invalid 400。
#[derive(Debug, Default)]
pub(super) struct QueryParams {
    pairs: Vec<(String, String)>,
}

impl QueryParams {
    /// 解析查询串（`a=1&b=2` 形态；空串/无参 → 空表）
    pub(super) fn parse(raw: Option<&str>) -> Result<Self, ServerError> {
        let mut pairs = Vec::new();
        if let Some(raw) = raw {
            for part in raw.split('&') {
                if part.is_empty() {
                    continue;
                }
                let mut it = part.splitn(2, '=');
                let key = percent_decode(it.next().unwrap_or_default())?;
                if key.is_empty() {
                    continue;
                }
                let value = percent_decode(it.next().unwrap_or_default())?;
                pairs.push((key, value));
            }
        }
        Ok(Self { pairs })
    }

    /// 取首个值（重复键取首个；未知键 → None）
    pub(super) fn get(&self, key: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// u64 值（非法 → cmd.invalid 400；afterSequence 负值落入此路径）
    pub(super) fn get_u64(&self, key: &str) -> Result<Option<u64>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some(raw) => raw
                .parse::<u64>()
                .map(Some)
                .map_err(|_| invalid_param(key, raw)),
        }
    }

    /// u32 值（非法 → cmd.invalid 400）
    pub(super) fn get_u32(&self, key: &str) -> Result<Option<u32>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some(raw) => raw
                .parse::<u32>()
                .map(Some)
                .map_err(|_| invalid_param(key, raw)),
        }
    }

    /// bool 值（仅接受 true/false 字面量）
    pub(super) fn get_bool(&self, key: &str) -> Result<Option<bool>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some("true") => Ok(Some(true)),
            Some("false") => Ok(Some(false)),
            Some(raw) => Err(invalid_param(key, raw)),
        }
    }

    /// 枚举值（经 serde 反序列化，wire 形状由枚举 rename 规则决定——
    /// 如 direction=forward / include=coreStatus）
    pub(super) fn get_enum<T: DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<T>, ServerError> {
        match self.get(key) {
            None => Ok(None),
            Some(raw) => serde_json::from_value(serde_json::Value::String(raw.to_string()))
                .map(Some)
                .map_err(|_| invalid_param(key, raw)),
        }
    }
}

/// 查询参数非法（cmd.invalid 400）
pub(super) fn invalid_param(key: &str, raw: &str) -> ServerError {
    ServerError::protocol(
        DeviceErrorCode::CmdInvalid,
        format!("查询参数 {key} 非法：{raw}"),
    )
}

/// 百分号解码（`+` → 空格；`%XX` → 字节；非法序列/非法 UTF-8 → 400）
fn percent_decode(input: &str) -> Result<String, ServerError> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' => {
                let Some(hi) = bytes.get(i + 1).and_then(|b| hex_digit(*b)) else {
                    return Err(invalid_query_encoding(input));
                };
                let Some(lo) = bytes.get(i + 2).and_then(|b| hex_digit(*b)) else {
                    return Err(invalid_query_encoding(input));
                };
                out.push((hi << 4) | lo);
                i += 3;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| invalid_query_encoding(input))
}

/// 十六进制字符值（0-9 / a-f / A-F）
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 查询串含非法百分号编码（cmd.invalid 400）
fn invalid_query_encoding(raw: &str) -> ServerError {
    ServerError::protocol(
        DeviceErrorCode::CmdInvalid,
        format!("查询串含非法百分号编码：{raw}"),
    )
}
