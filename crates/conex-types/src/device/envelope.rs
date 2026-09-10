//! 跨端协议 L3 外层信封（D3 §5.3 / M6 §10.1 唯一形态）
//!
//! 所有跨端消息统一经 [DeviceEnvelope] 包装：`v`（协议版本）/ `kind`（103 种
//! 消息类别）/ `msgId`（幂等键 + 请求-响应关联键）/ `ts`（发送方时钟）/ `from` /
//! `to`（端字面量）/ `auth`（消息级 HMAC 签名域）/ `body`（业务载荷）。
//!
//! - 帧序列化纪律：serde camelCase + Option 省略（与 `AgentEventEnvelope`
//!   同构，events.rs:905-1013 先例）；
//! - `kind` 为 [MessageKind]：静态类别为枚举变体（wire 名经 serde rename），
//!   命令类 `remote.<name>` / `result.<name>` 为动态后缀新类型变体；
//! - 签名输入规范化（D3 §5.1）：`canon(header) = deviceId ∥ ts ∥ nonce ∥
//!   msgId ∥ kind ∥ v`，再拼接 body 原始 JSON 字节——[DeviceEnvelope::
//!   canonical_signing_payload] 产出该拼接串（真实 HMAC 计算在网关层持
//!   token_key 完成，本模块只提供类型与规范输入）。
//!
//! 注：M6 §10.1 的 AuthHeader 描述把 `from/to` 也列入 canon 输入（与 D3
//! 略有差异），该差异由 R0-05 注册表对拍统一；本实现以 D3 §5.1（唯一真源
//! Z0 §4.2 复述）为准。

use serde::{Deserialize, Serialize};

/// 端角色字面量（D3 §5.3：from/to 为字面量 desktop/mobile，鉴权不依赖它）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceEndpoint {
    /// 桌面 Hub（唯一权威）
    Desktop,
    /// 移动端 Companion（或未来其他端）
    Mobile,
}

/// 消息签名头（L3 信封 `auth` 域；M6 §10.1 $defs.AuthHeader）
///
/// `sig = HMAC-SHA256(token_key, canon(header) ∥ bodyJson)`，base64 承载；
/// `nonce` 随机字节 base64 防重放（±5min 窗口 + per-device LRU）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthHeader {
    /// 设备 id（注册表主键）
    pub device_id: String,
    /// 签名时戳（epoch ms，窗口 ±5min）
    pub ts: u64,
    /// 随机 nonce（base64，16-64 字符）
    pub nonce: String,
    /// HMAC-SHA256 签名（base64）
    pub sig: String,
}

impl AuthHeader {
    /// 构造签名头
    pub fn new(
        device_id: impl Into<String>,
        ts: u64,
        nonce: impl Into<String>,
        sig: impl Into<String>,
    ) -> Self {
        Self {
            device_id: device_id.into(),
            ts,
            nonce: nonce.into(),
            sig: sig.into(),
        }
    }
}

/// 消息类别（kind，103 种注册 kind = 静态 29 + remote.* 37 + result.* 37）
///
/// 静态类别（配对/认证/设备/事件会话面/流/保活/错误）为枚举变体，wire 名经
/// serde rename 锁死；命令类 `remote.<name>` / `result.<name>` 为动态后缀，
/// 以新类型变体承载（序列化为裸字符串，反序列化按内容还原）。
///
/// 计数基线（M6 §1.1）：events 11 + stream 4 + pair 4 + auth 3（rotate 为
/// 可选扩展，不在 103 内）+ device 4 + heartbeat 2 + error 1 = 29 静态；
/// 命令 37 + 响应 37 = 74；合计 103。
///
/// 序列化实现：手动 [Serialize]（与 [Deserialize] / [MessageKind::as_str]
/// 对称，wire 一律裸字符串）——derive 外部标签会对 `Remote/Result` 新类型
/// 变体输出 `{"Remote":"approve"}`，破坏 wire 形态（R0-05 对拍发现）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageKind {
    // ── 事件会话面（11）──
    /// 按会话订阅
    EventsSubscribe,
    /// 全局轻订阅
    EventsSubscribeAll,
    /// 订阅确认
    EventsSubscribeOk,
    /// 事件实时推送（一帧一事件）
    EventsPush,
    /// 事件确认（仅 ackMode=critical 诊断模式）
    EventsAck,
    /// 断线续传请求
    EventsResume,
    /// 续传分页
    EventsResumePage,
    /// 续传完成
    EventsResumeDone,
    /// 会话索引变更广播
    SessionUpdated,
    /// 会话删除广播
    SessionRemoved,
    /// 会话索引全量刷新信号
    SessionUpdatedAll,

    // ── 流控制（4）──
    /// 大载荷流开启
    StreamOpen,
    /// 流数据块
    StreamChunk,
    /// 断线续传
    StreamResume,
    /// 流结束
    StreamClose,

    // ── 配对（4）──
    /// 配对请求
    PairHello,
    /// 挑战 + 桌面公钥
    PairChallenge,
    /// 挑战签名
    PairVerify,
    /// 配对成功
    PairOk,

    // ── 认证（3 + rotate 可选扩展，M6 §1.1）──
    /// 会话握手（版本协商）
    AuthHello,
    /// 握手成功
    AuthHelloOk,
    /// 重连刷新
    AuthRefresh,
    /// 签名上下文轮换（可选扩展，不在 103 注册数内）
    AuthRotate,

    // ── 设备生命周期（4）──
    /// 配对完成后通知可正常会话
    DeviceReady,
    /// 移动端主动解除配对
    DeviceUnlink,
    /// 桌面撤销设备广播
    DeviceRevoked,
    /// 设备域审计
    DeviceAudit,

    // ── 保活（2）──
    /// 心跳（30s）
    Heartbeat,
    /// 心跳回执（60s）
    HeartbeatOk,

    // ── 统一错误（1）──
    /// 错误通知
    Error,

    // ── 命令（37 动态后缀，M6 §4）──
    /// 命令请求（wire 值 `remote.<name>`，name 为命令后缀如 getStatus）
    Remote(String),
    /// 命令响应（wire 值 `result.<name>`，与请求一一对应）
    Result(String),
    /// 未注册 kind 兜底（D3 §10.3：旧端收到未知 kind 丢弃 + 记日志，不报错）
    Unknown(String),
}

impl<'de> Deserialize<'de> for MessageKind {
    /// 反序列化：静态 wire 名 → 对应变体；`remote.*` / `result.*` 前缀 →
    /// 动态变体；其余 → [MessageKind::Unknown] 兜底（宽容未知 kind）。
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = String::deserialize(deserializer)?;
        Ok(match wire.as_str() {
            "events.subscribe" => MessageKind::EventsSubscribe,
            "events.subscribeAll" => MessageKind::EventsSubscribeAll,
            "events.subscribe.ok" => MessageKind::EventsSubscribeOk,
            "events.push" => MessageKind::EventsPush,
            "events.ack" => MessageKind::EventsAck,
            "events.resume" => MessageKind::EventsResume,
            "events.resume.page" => MessageKind::EventsResumePage,
            "events.resume.done" => MessageKind::EventsResumeDone,
            "session.updated" => MessageKind::SessionUpdated,
            "session.removed" => MessageKind::SessionRemoved,
            "session.updatedAll" => MessageKind::SessionUpdatedAll,
            "stream.open" => MessageKind::StreamOpen,
            "stream.chunk" => MessageKind::StreamChunk,
            "stream.resume" => MessageKind::StreamResume,
            "stream.close" => MessageKind::StreamClose,
            "pair.hello" => MessageKind::PairHello,
            "pair.challenge" => MessageKind::PairChallenge,
            "pair.verify" => MessageKind::PairVerify,
            "pair.ok" => MessageKind::PairOk,
            "auth.hello" => MessageKind::AuthHello,
            "auth.hello.ok" => MessageKind::AuthHelloOk,
            "auth.refresh" => MessageKind::AuthRefresh,
            "auth.rotate" => MessageKind::AuthRotate,
            "device.ready" => MessageKind::DeviceReady,
            "device.unlink" => MessageKind::DeviceUnlink,
            "device.revoked" => MessageKind::DeviceRevoked,
            "device.audit" => MessageKind::DeviceAudit,
            "heartbeat" => MessageKind::Heartbeat,
            "heartbeat.ok" => MessageKind::HeartbeatOk,
            "error" => MessageKind::Error,
            _ if wire.starts_with("remote.") => {
                MessageKind::Remote(wire["remote.".len()..].to_string())
            }
            _ if wire.starts_with("result.") => {
                MessageKind::Result(wire["result.".len()..].to_string())
            }
            _ => MessageKind::Unknown(wire),
        })
    }
}

impl Serialize for MessageKind {
    /// 序列化：与 [MessageKind::as_str] 对称的裸字符串（wire 形态）。
    /// 静态变体输出注册 wire 名；`Remote/Result` 拼出 `remote.<name>` /
    /// `result.<name>`；`Unknown` 原样透传。
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.as_str())
    }
}

/// 已注册的 29 个静态 kind（M6 §1.1 账目；不含可选扩展 auth.rotate）
pub const STATIC_KINDS: [&str; 29] = [
    "events.subscribe",
    "events.subscribeAll",
    "events.subscribe.ok",
    "events.push",
    "events.ack",
    "events.resume",
    "events.resume.page",
    "events.resume.done",
    "session.updated",
    "session.removed",
    "session.updatedAll",
    "stream.open",
    "stream.chunk",
    "stream.resume",
    "stream.close",
    "pair.hello",
    "pair.challenge",
    "pair.verify",
    "pair.ok",
    "auth.hello",
    "auth.hello.ok",
    "auth.refresh",
    "device.ready",
    "device.unlink",
    "device.revoked",
    "device.audit",
    "heartbeat",
    "heartbeat.ok",
    "error",
];

impl MessageKind {
    /// wire 字面量（动态命令类拼出 `remote.<name>` / `result.<name>`）
    pub fn as_str(&self) -> String {
        match self {
            MessageKind::EventsSubscribe => "events.subscribe".to_string(),
            MessageKind::EventsSubscribeAll => "events.subscribeAll".to_string(),
            MessageKind::EventsSubscribeOk => "events.subscribe.ok".to_string(),
            MessageKind::EventsPush => "events.push".to_string(),
            MessageKind::EventsAck => "events.ack".to_string(),
            MessageKind::EventsResume => "events.resume".to_string(),
            MessageKind::EventsResumePage => "events.resume.page".to_string(),
            MessageKind::EventsResumeDone => "events.resume.done".to_string(),
            MessageKind::SessionUpdated => "session.updated".to_string(),
            MessageKind::SessionRemoved => "session.removed".to_string(),
            MessageKind::SessionUpdatedAll => "session.updatedAll".to_string(),
            MessageKind::StreamOpen => "stream.open".to_string(),
            MessageKind::StreamChunk => "stream.chunk".to_string(),
            MessageKind::StreamResume => "stream.resume".to_string(),
            MessageKind::StreamClose => "stream.close".to_string(),
            MessageKind::PairHello => "pair.hello".to_string(),
            MessageKind::PairChallenge => "pair.challenge".to_string(),
            MessageKind::PairVerify => "pair.verify".to_string(),
            MessageKind::PairOk => "pair.ok".to_string(),
            MessageKind::AuthHello => "auth.hello".to_string(),
            MessageKind::AuthHelloOk => "auth.hello.ok".to_string(),
            MessageKind::AuthRefresh => "auth.refresh".to_string(),
            MessageKind::AuthRotate => "auth.rotate".to_string(),
            MessageKind::DeviceReady => "device.ready".to_string(),
            MessageKind::DeviceUnlink => "device.unlink".to_string(),
            MessageKind::DeviceRevoked => "device.revoked".to_string(),
            MessageKind::DeviceAudit => "device.audit".to_string(),
            MessageKind::Heartbeat => "heartbeat".to_string(),
            MessageKind::HeartbeatOk => "heartbeat.ok".to_string(),
            MessageKind::Error => "error".to_string(),
            MessageKind::Remote(name) => format!("remote.{name}"),
            MessageKind::Result(name) => format!("result.{name}"),
            MessageKind::Unknown(wire) => wire.clone(),
        }
    }

    /// 是否命令请求（remote.*）
    pub fn is_remote(&self) -> bool {
        matches!(self, MessageKind::Remote(_))
    }

    /// 是否命令响应（result.*）
    pub fn is_result(&self) -> bool {
        matches!(self, MessageKind::Result(_))
    }

    /// 命令请求 kind（`remote.<name>`）
    pub fn remote_command(name: impl Into<String>) -> Self {
        MessageKind::Remote(name.into())
    }

    /// 命令响应 kind（`result.<name>`）
    pub fn result_of(name: impl Into<String>) -> Self {
        MessageKind::Result(name.into())
    }
}

/// 跨端协议外层信封（D3 §5.3；全部消息统一包装）
///
/// 序列化为**扁平** JSON 对象：`{ v, kind, msgId, ts, from, to, auth, body }`，
/// camelCase + Option 省略；`body` 为业务载荷（kind 决定结构，见各模块类型）。
/// `msgId` 是幂等键与请求-响应关联键（重发保持不变，D3 §5.4）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEnvelope {
    /// 协议主版本（握手协商后固定；现值 1）
    pub v: u32,
    /// 消息类别（103 种 kind 之一）
    pub kind: MessageKind,
    /// 发送方唯一消息 id（8-64 字符）
    pub msg_id: String,
    /// 发送方时钟（epoch ms）
    pub ts: u64,
    /// 发送端字面量
    pub from: DeviceEndpoint,
    /// 接收端字面量
    pub to: DeviceEndpoint,
    /// 消息级 HMAC 签名域（配对期可为空占位，D3 §5.2）
    #[serde(default)]
    pub auth: AuthHeader,
    /// 业务载荷（kind 决定结构）
    pub body: serde_json::Value,
}

impl DeviceEnvelope {
    /// 构造信封（auth 为空占位——配对期消息按 D3 §5.2 可不签名；
    /// 会话期消息须经签名构造填充 [AuthHeader]）
    pub fn unsigned(
        kind: MessageKind,
        msg_id: impl Into<String>,
        ts: u64,
        from: DeviceEndpoint,
        to: DeviceEndpoint,
        body: serde_json::Value,
    ) -> Self {
        Self {
            v: crate::device::version::PROTOCOL_VERSION,
            kind,
            msg_id: msg_id.into(),
            ts,
            from,
            to,
            auth: AuthHeader {
                device_id: String::new(),
                ts: 0,
                nonce: String::new(),
                sig: String::new(),
            },
            body,
        }
    }

    /// 填充签名头（验签/构造完成后覆盖占位）
    pub fn with_auth(mut self, auth: AuthHeader) -> Self {
        self.auth = auth;
        self
    }

    /// 签名输入规范化串（D3 §5.1）：
    /// `canon(header) = deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v`，
    /// 再拼接 body 的紧凑 JSON 字节。
    ///
    /// 实际签名 = `HMAC-SHA256(token_key, 本串)`；网关层验签时须按接收到的
    /// 原始字节重算（本 helper 只做类型域内的规范化产形）。
    pub fn canonical_signing_payload(&self) -> String {
        let canon = format!(
            "{}{}{}{}{}{}",
            self.auth.device_id,
            self.auth.ts,
            self.auth.nonce,
            self.msg_id,
            self.kind.as_str(),
            self.v
        );
        let body = serde_json::to_string(&self.body).unwrap_or_default();
        format!("{canon}{body}")
    }

    /// kind 的 wire 字面量（委托 [MessageKind::as_str]）
    pub fn kind_str(&self) -> String {
        self.kind.as_str()
    }
}

// ── 保活消息（heartbeat / heartbeat.ok；M6 §10.4）──

/// 心跳（M→D，30s；设备活性 + 时钟偏移校准）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    /// 发送方时钟（epoch ms）
    pub ts: u64,
    /// 移动端本地时钟（校准用）
    pub device_time_ms: u64,
}

/// 心跳回执（D→M，60s；时钟校准）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatOk {
    /// 回执时戳（epoch ms）
    pub ts: u64,
    /// 桌面时钟（epoch ms，移动端据此校准偏移）
    pub server_time: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_body() -> serde_json::Value {
        serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT", "deviceId": "dev-01HZ" })
    }

    #[test]
    fn envelope_full_roundtrip_camel_case() {
        let auth = AuthHeader::new("dev-01HZ", 1754651200000, "nonce-abcdef", "sig-abc");
        let envelope = DeviceEnvelope::unsigned(
            MessageKind::PairHello,
            "m-iph-001-12",
            1754651200000,
            DeviceEndpoint::Mobile,
            DeviceEndpoint::Desktop,
            sample_body(),
        )
        .with_auth(auth.clone());

        let json = serde_json::to_value(&envelope).unwrap();
        assert_eq!(json["v"], 1);
        assert_eq!(json["kind"], "pair.hello");
        assert_eq!(json["msgId"], "m-iph-001-12");
        assert_eq!(json["from"], "mobile");
        assert_eq!(json["to"], "desktop");
        assert_eq!(json["auth"]["deviceId"], "dev-01HZ");
        assert_eq!(json["auth"]["ts"], 1754651200000_i64);
        assert_eq!(json["auth"]["nonce"], "nonce-abcdef");
        assert_eq!(json["auth"]["sig"], "sig-abc");
        assert_eq!(json["body"]["code"], "CXN-7K4P-Q2MB-9XRT");

        let back: DeviceEnvelope =
            serde_json::from_str(&serde_json::to_string(&envelope).unwrap()).unwrap();
        assert_eq!(envelope, back);
    }

    #[test]
    fn kind_wire_values_and_dynamic_commands() {
        assert_eq!(MessageKind::PairHello.as_str(), "pair.hello");
        assert_eq!(
            MessageKind::EventsSubscribeOk.as_str(),
            "events.subscribe.ok"
        );
        assert_eq!(MessageKind::HeartbeatOk.as_str(), "heartbeat.ok");
        assert_eq!(
            MessageKind::remote_command("approve").as_str(),
            "remote.approve"
        );
        assert_eq!(
            MessageKind::result_of("getStatus").as_str(),
            "result.getStatus"
        );

        // 反序列化：静态变体按 wire 名还原
        let kind: MessageKind = serde_json::from_str("\"pair.challenge\"").unwrap();
        assert_eq!(kind, MessageKind::PairChallenge);
        // 动态命令：裸字符串还原为 Remote/Result 新类型变体
        let kind: MessageKind = serde_json::from_str("\"remote.runTask\"").unwrap();
        assert_eq!(kind, MessageKind::Remote("runTask".into()));
        let kind: MessageKind = serde_json::from_str("\"result.listSessions\"").unwrap();
        assert_eq!(kind, MessageKind::Result("listSessions".into()));
    }

    #[test]
    fn kind_serde_is_symmetric_bare_string() {
        // R0-05 对拍发现：derive Serialize 会把 Remote/Result 序列化为
        // {"Remote":"approve"} 外部标签；修复后 wire 一律裸字符串且可往返。
        for (wire, expected) in [
            ("pair.hello", MessageKind::PairHello),
            ("events.push", MessageKind::EventsPush),
            ("remote.approve", MessageKind::Remote("approve".into())),
            ("result.approve", MessageKind::Result("approve".into())),
            ("future.kind", MessageKind::Unknown("future.kind".into())),
        ] {
            let serialized = serde_json::to_string(&expected).unwrap();
            assert_eq!(
                serialized,
                format!("\"{wire}\""),
                "kind [{wire}] 序列化非裸字符串"
            );
            let back: MessageKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(back, expected, "kind [{wire}] 序列化-反序列化不对称");
        }
    }

    #[test]
    fn static_kinds_count_matches_registry_accounting() {
        // M6 §1.1：events 11 + stream 4 + pair 4 + auth 3 + device 4 +
        // heartbeat 2 + error 1 = 29（rotate 为可选扩展不计入 103）
        assert_eq!(STATIC_KINDS.len(), 29);
        let unique: std::collections::HashSet<&str> = STATIC_KINDS.iter().copied().collect();
        assert_eq!(unique.len(), STATIC_KINDS.len());
        // 与 mod.rs 的 103 全量核对
        assert_eq!(crate::device::all_kinds().len(), 103);
    }

    #[test]
    fn canonical_signing_payload_format() {
        let auth = AuthHeader::new("dev-01HZ", 1754651200000, "nonce-abcdef", "");
        let envelope = DeviceEnvelope::unsigned(
            MessageKind::EventsPush,
            "m-iph-002-34",
            1754651200000,
            DeviceEndpoint::Desktop,
            DeviceEndpoint::Mobile,
            serde_json::json!({ "ok": true }),
        )
        .with_auth(auth);
        // canon = deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v，随后拼接 body JSON
        let expected = "dev-01HZ1754651200000nonce-abcdefm-iph-002-34events.push1{\"ok\":true}";
        assert_eq!(envelope.canonical_signing_payload(), expected);
    }

    #[test]
    fn endpoint_and_heartbeat_wire_values() {
        assert_eq!(
            serde_json::to_string(&DeviceEndpoint::Desktop).unwrap(),
            "\"desktop\""
        );
        assert_eq!(
            serde_json::to_string(&DeviceEndpoint::Mobile).unwrap(),
            "\"mobile\""
        );

        let hb = Heartbeat {
            ts: 1754651200000,
            device_time_ms: 1754651199500,
        };
        let json = serde_json::to_value(hb).unwrap();
        assert_eq!(json["ts"], 1754651200000_i64);
        assert_eq!(json["deviceTimeMs"], 1754651199500_i64);

        let hb_ok = HeartbeatOk {
            ts: 1754651200000,
            server_time: 1754651200001,
        };
        let json = serde_json::to_value(hb_ok).unwrap();
        assert_eq!(json["serverTime"], 1754651200001_i64);
        let back: HeartbeatOk =
            serde_json::from_str(&serde_json::to_string(&hb_ok).unwrap()).unwrap();
        assert_eq!(hb_ok, back);
    }

    #[test]
    fn device_envelope_deserialization_with_omitted_auth() {
        // 彻底缺失 auth 字段的信封（配对阶段免签帧反序列化兼容）
        let json_str = r#"{
            "v": 1,
            "kind": "pair.hello",
            "msgId": "msg-001",
            "ts": 1754651200000,
            "from": "mobile",
            "to": "desktop",
            "body": { "code": "7K4LQ2MB9XRT" }
        }"#;
        let env: DeviceEnvelope =
            serde_json::from_str(json_str).expect("缺失 auth 字段必须反序列化成功");
        assert_eq!(env.auth, AuthHeader::default());
        assert_eq!(env.auth.device_id, "");
        assert_eq!(env.auth.ts, 0);
        assert_eq!(env.auth.nonce, "");
        assert_eq!(env.auth.sig, "");
    }
}
