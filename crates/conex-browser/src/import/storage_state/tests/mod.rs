use super::*;
use crate::cdp::domains::Cookie;
use crate::cdp::mock::{MockReply, MockServer};
use crate::cdp::transport::CdpEndpoint;
use serde_json::json;

// 原 `mod tests` 经 `use super::*` 取得父模块的私有导入（async_trait、Arc）；拆分后父模块不再持有，这里显式导入。
use async_trait::async_trait;
use std::sync::Arc;

mod export_guard;
mod parse_and_inject;
mod session_channel;

fn cdp_cookie(overrides: impl Fn(&mut Cookie)) -> Cookie {
    let mut c = Cookie {
        name: "sid".to_string(),
        value: "abc123".to_string(),
        domain: ".example.com".to_string(),
        path: "/".to_string(),
        expires: 1_750_000_000.0,
        size: 10,
        http_only: true,
        secure: true,
        session: false,
        same_site: Some("Lax".to_string()),
        priority: Some("Medium".to_string()),
    };
    overrides(&mut c);
    c
}
