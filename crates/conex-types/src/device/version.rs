//! 协议版本与握手期消息（D3 §10 / M6 §10.4 / §11 / §14.1）
//!
//! - 版本化三轨之一：跨端协议 `v`（DeviceEnvelope 字段 + `auth.hello` 协商）；
//!   协商规则（D3 §10.2）：移动端声明支持区间 `protocolVersions`，桌面回
//!   `hello.ok {protocolVersion, minProtocolVersion, manifest, serverTime}`；
//!   交集为空 → `version_mismatch` + 升级引导；会话期禁止换版本；
//! - 能力位：`hello.capabilities`（移动端声明）/ `hello.ok.capabilities`
//!   （桌面声明，17 位见 [Capability]）；缺省 = false（fail-closed）；
//! - 常量表：M6 §14.1（本文件为落位处），供网关/流/配对实现引用；
//! - 握手期消息（auth.hello / auth.hello.ok / auth.refresh / auth.rotate）
//!   因承载版本协商与能力声明，随本模块落位（M6 §10.4 同节定义）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::device::events::ResumeState;
use crate::device::pair::Platform;

// ── 版本常量 ──

/// 当前协议主版本（DeviceEnvelope.v；现值 1）
pub const PROTOCOL_VERSION: u32 = 1;
/// 兼容下限（低于此版本的客户端收到 version_mismatch）
pub const MIN_PROTOCOL_VERSION: u32 = 1;

/// 协议版本（信封 `v` 与 `hello.protocolVersion` 的承载类型）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProtocolVersion(pub u32);

impl ProtocolVersion {
    /// 当前协议版本
    pub fn current() -> Self {
        Self(PROTOCOL_VERSION)
    }

    /// 兼容下限
    pub fn min_supported() -> Self {
        Self(MIN_PROTOCOL_VERSION)
    }
}

/// 协议版本协商（D3 §10.2）
///
/// 客户端声明支持区间，服务端声明支持区间；取**交集最大值**（客户端取
/// min(客户端最高, 桌面支持最高) 且该值必须在双方区间内的交集语义）。
/// 交集为空 → `None`（网关回 `version_mismatch`）。
pub fn negotiate_protocol(client_versions: &[u32], server_versions: &[u32]) -> Option<u32> {
    let mut common: Vec<u32> = client_versions
        .iter()
        .copied()
        .filter(|v| server_versions.contains(v))
        .collect();
    common.sort_unstable();
    common.pop()
}

/// 版本是否互为兼容（支持区间有交集）
pub fn versions_compatible(client_versions: &[u32], server_versions: &[u32]) -> bool {
    negotiate_protocol(client_versions, server_versions).is_some()
}

// ── 能力位（M6 §11.2 17 位全表）──

/// 能力位（wire camelCase；hello 声明 / hello.ok 回执）
///
/// 移动端按能力位裁剪 UI；能力位缺省 = false（fail-closed）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// 文件读取/浏览（C16/C17/C19/C20/C22/C23）
    FileRead,
    /// 受控写文件（C18；桌面侧）
    FileWrite,
    /// 后台任务查询（C06/C07；桌面侧）
    TaskList,
    /// 终端输入（本期不开；桌面侧）
    TaskInput,
    /// 发起 run（P2 默认关；桌面侧）
    RunTask,
    /// run 控制（C25/C26；桌面侧）
    RunControl,
    /// 分块流支持（stream.*；桌面侧）
    Streams,
    /// 断线续传/历史回放（events.resume / C03；桌面侧）
    EventReplay,
    /// 审批中心（C11-C14；桌面侧）
    Approval,
    /// 设置镜像 + 确认通道（C28-C31；桌面侧）
    Settings,
    /// 设备管理（C33-C37；桌面侧）
    Devices,
    /// 文件名搜索（C21；桌面侧）
    Search,
    /// 服务端会话搜索（C27，P2；桌面侧）
    SessionSearch,
    /// cron 事件能力位
    Cron,
    /// timer 事件能力位
    Timer,
    /// 子代理事件能力位
    Subagent,
    /// 桌面在场查询（C32；桌面侧）
    Presence,
}

/// 全部能力位（17 位；与 M6 §11.2 注册表一致）
pub const ALL_CAPABILITIES: [Capability; 17] = [
    Capability::FileRead,
    Capability::FileWrite,
    Capability::TaskList,
    Capability::TaskInput,
    Capability::RunTask,
    Capability::RunControl,
    Capability::Streams,
    Capability::EventReplay,
    Capability::Approval,
    Capability::Settings,
    Capability::Devices,
    Capability::Search,
    Capability::SessionSearch,
    Capability::Cron,
    Capability::Timer,
    Capability::Subagent,
    Capability::Presence,
];

// ── 命令面条目（hello.ok.manifest 与 C09 listCommands 共用）──

/// 命令面（wire lowercase：engine = 三端共用契约面 / gui = 桌面前端专用）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSurface {
    /// engine 面（跨端白名单的唯一基础）
    Engine,
    /// gui 面（桌面前端专用；移动端白名单特批例外见 M6 §4.8）
    Gui,
}

/// manifest 条目（D3 §8.1 / M6 §10.4 ManifestEntry）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// 命令名（如 core_get_status）
    pub name: String,
    /// 命令族（core/session/workbench/config 等）
    pub family: String,
    /// 命令面
    pub surface: CommandSurface,
    /// 是否已注册（registered=false = 登记先行）
    pub registered: bool,
}

/// 命令清单（hello.ok.manifest；C09 listCommands 响应同构）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestList {
    /// 命令清单契约版本（semver；变化时移动端提示刷新）
    pub contract_version: String,
    /// 命令条目（白名单三重约束的 A 面）
    pub commands: Vec<ManifestEntry>,
}

// ── 握手期消息（M6 §10.4）──

/// 会话握手（auth.hello，M→D；版本协商 + 能力 + 断线游标）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// 移动端支持的协议版本区间
    pub protocol_versions: Vec<u32>,
    /// 移动端能力位（fileRead/taskInput/runTask/...）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<Capability>>,
    /// 应用版本（semver，≤32 字符）
    pub app_version: String,
    /// 端平台
    pub platform: Platform,
    /// 断线重连时携带的逐会话游标状态
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ResumeState>,
}

/// 握手成功（auth.hello.ok，D→M）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloOk {
    /// 协商后的协议版本
    pub protocol_version: u32,
    /// 兼容下限（低于此版本需升级）
    pub min_protocol_version: u32,
    /// 桌面自身标识
    pub desktop_id: String,
    /// 桌面时钟（epoch ms；时钟校准）
    pub server_time: u64,
    /// 桌面能力位（流/fileRead/taskInput/cron/timer/subagent/...）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<HashMap<String, bool>>,
    /// 命令清单（contractVersion + commands）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<ManifestList>,
}

/// 重连刷新（auth.refresh，M→D；refresh token 一次性）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refresh {
    /// `HMAC(refresh_key, desktopId ∥ ts ∥ nonce)`（base64，一次性；
    /// 桌面记录最后使用时间做被盗检测）
    pub refresh_token: String,
}

/// 签名上下文轮换（auth.rotate，D→M；可选扩展）
///
/// 长连接下每 24h 轮换 nonce 基数（token_key 不变，只换 nonce 种子），
/// 避免长期同上下文被流量分析。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rotate {
    /// 新 nonce 种子（移动端更新签名上下文）
    pub nonce_seed: String,
}

// ── 协议常量表（M6 §14.1 落位）──

/// 单帧上限（信封层；超限断链 + frame_too_large）
pub const MAX_FRAME_BYTES: usize = 1_048_576;
/// 单事件 push 帧上限（超限先摘要化，仍超 → 降级元组）
pub const EVENT_PUSH_MAX_BYTES: usize = 65_536;
/// 每会话下行窗口（游标落后超窗 → 全量回放）
pub const EVENT_WINDOW: usize = 4096;
/// 订阅会话上限
pub const MAX_SUBSCRIPTIONS: usize = 32;
/// 并发流上限
pub const MAX_STREAMS: usize = 8;
/// 流块上限（字符）
pub const STREAM_CHUNK_MAX: usize = 65_536;
/// 单流总量上限（256 MiB）
pub const STREAM_MAX_BYTES: usize = 268_435_456;
/// 断线流上下文保留（5min；超时清理 → stream.cursor_stale）
pub const STREAM_TTL_MS: u64 = 300_000;
/// remote.runTask.prompt 跨端上限（256 KiB；超限走流上传）
pub const PROMPT_MAX_BYTES: usize = 262_144;
/// 分页默认页大小
pub const PAGE_SIZE_DEFAULT: u32 = 200;
/// 分页上限
pub const PAGE_SIZE_MAX: u32 = 1000;
/// 配对码有效期
pub const PAIR_CODE_TTL_MS: u64 = 600_000;
/// 单码失败上限
pub const PAIR_MAX_ATTEMPTS: u32 = 5;
/// 并发活跃码上限
pub const PAIR_MAX_ACTIVE: u32 = 3;
/// 设备数上限
pub const PAIR_MAX_DEVICES: u32 = 8;
/// 签名时戳窗口（±5min）
pub const AUTH_TS_WINDOW_MS: u64 = 300_000;
/// 移动端心跳间隔
pub const HEARTBEAT_INTERVAL_MS: u64 = 30_000;
/// 断线判定倍数（3 × 心跳间隔无消息 → 断线）
pub const HEARTBEAT_TIMEOUT_FACTOR: u32 = 3;
/// 命令幂等结果缓存 TTL（同 msgId 重发回显）
pub const IDEMPOTENCY_TTL_MS: u64 = 300_000;
/// sync_commands 表保留期（防重放窗口 > 离线 TTL 上限）
pub const IDEMPOTENCY_TABLE_TTL_DAYS: u32 = 30;
/// outbox 队列上限
pub const OUTBOX_MAX_ITEMS: usize = 200;
/// outbox 重试退避序列（1s/4s/16s/60s 封顶）
pub const OUTBOX_RETRY_BACKOFF_MS: [u64; 4] = [1_000, 4_000, 16_000, 60_000];
/// 游标落后重建阈值（事件数）
pub const RECONCILE_REBUILD_THRESHOLD: u64 = 5000;
/// 资源 URL 令牌有效期
pub const ASSET_TOKEN_TTL_MS: u64 = 600_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_baseline() {
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(MIN_PROTOCOL_VERSION, 1);
        assert_eq!(MAX_FRAME_BYTES, 1_048_576);
        assert_eq!(EVENT_WINDOW, 4096);
        assert_eq!(MAX_SUBSCRIPTIONS, 32);
        assert_eq!(MAX_STREAMS, 8);
        assert_eq!(STREAM_CHUNK_MAX, 65_536);
        assert_eq!(STREAM_MAX_BYTES, 268_435_456);
        assert_eq!(STREAM_TTL_MS, 300_000);
        assert_eq!(PROMPT_MAX_BYTES, 262_144);
        assert_eq!(PAGE_SIZE_DEFAULT, 200);
        assert_eq!(PAGE_SIZE_MAX, 1000);
        assert_eq!(PAIR_CODE_TTL_MS, 600_000);
        assert_eq!(PAIR_MAX_ATTEMPTS, 5);
        assert_eq!(PAIR_MAX_ACTIVE, 3);
        assert_eq!(PAIR_MAX_DEVICES, 8);
        assert_eq!(AUTH_TS_WINDOW_MS, 300_000);
        assert_eq!(HEARTBEAT_INTERVAL_MS, 30_000);
        assert_eq!(HEARTBEAT_TIMEOUT_FACTOR, 3);
        assert_eq!(IDEMPOTENCY_TTL_MS, 300_000);
        assert_eq!(IDEMPOTENCY_TABLE_TTL_DAYS, 30);
        assert_eq!(OUTBOX_MAX_ITEMS, 200);
        assert_eq!(RECONCILE_REBUILD_THRESHOLD, 5000);
        assert_eq!(ASSET_TOKEN_TTL_MS, 600_000);
        assert_eq!(ProtocolVersion::current(), ProtocolVersion(1));
    }

    #[test]
    fn negotiate_matrix() {
        // 同区间 → 取交集最大值
        assert_eq!(negotiate_protocol(&[1, 2], &[1, 2]), Some(2));
        // 客户端新、桌面旧 → 取桌面最高
        assert_eq!(negotiate_protocol(&[1, 2], &[1]), Some(1));
        // 客户端旧、桌面新 → 取客户端最高
        assert_eq!(negotiate_protocol(&[1], &[1, 2]), Some(1));
        // 无交集 → None（version_mismatch）
        assert_eq!(negotiate_protocol(&[2], &[1]), None);
        assert_eq!(negotiate_protocol(&[3], &[1, 2]), None);
        assert!(!versions_compatible(&[3], &[1, 2]));
        assert!(versions_compatible(&[1, 2], &[1, 2, 3]));
    }

    #[test]
    fn capability_wire_values() {
        assert_eq!(
            serde_json::to_string(&Capability::FileRead).unwrap(),
            "\"fileRead\""
        );
        assert_eq!(
            serde_json::to_string(&Capability::EventReplay).unwrap(),
            "\"eventReplay\""
        );
        assert_eq!(
            serde_json::to_string(&Capability::SessionSearch).unwrap(),
            "\"sessionSearch\""
        );
        assert_eq!(
            serde_json::to_string(&Capability::RunTask).unwrap(),
            "\"runTask\""
        );
        assert_eq!(
            serde_json::to_string(&Capability::Presence).unwrap(),
            "\"presence\""
        );
        let back: Capability = serde_json::from_str("\"taskList\"").unwrap();
        assert_eq!(back, Capability::TaskList);

        assert_eq!(ALL_CAPABILITIES.len(), 17);
        let unique: std::collections::HashSet<Capability> =
            ALL_CAPABILITIES.iter().copied().collect();
        assert_eq!(unique.len(), ALL_CAPABILITIES.len());
    }

    #[test]
    fn hello_roundtrip() {
        let mut resume = ResumeState::new();
        resume.0.insert("s-abc".into(), 128);
        let hello = Hello {
            protocol_versions: vec![1],
            capabilities: Some(vec![Capability::FileRead, Capability::Approval]),
            app_version: "0.1.0".into(),
            platform: Platform::Ios,
            resume: Some(resume),
        };
        let json = serde_json::to_value(&hello).unwrap();
        assert_eq!(json["protocolVersions"], serde_json::json!([1]));
        assert_eq!(json["capabilities"][0], "fileRead");
        assert_eq!(json["appVersion"], "0.1.0");
        assert_eq!(json["platform"], "ios");
        assert_eq!(json["resume"]["s-abc"], 128);
        let back: Hello = serde_json::from_str(&serde_json::to_string(&hello).unwrap()).unwrap();
        assert_eq!(hello, back);

        // 可选字段缺省 → None
        let minimal = r#"{"protocolVersions":[1],"appVersion":"0.1.0","platform":"android"}"#;
        let parsed: Hello = serde_json::from_str(minimal).unwrap();
        assert_eq!(parsed.capabilities, None);
        assert_eq!(parsed.resume, None);
    }

    #[test]
    fn hello_ok_roundtrip() {
        let ok = HelloOk {
            protocol_version: 1,
            min_protocol_version: 1,
            desktop_id: "d-01HZ".into(),
            server_time: 1754651200000,
            capabilities: Some(HashMap::from([("streams".to_string(), true)])),
            manifest: Some(ManifestList {
                contract_version: "1.0.0".into(),
                commands: vec![ManifestEntry {
                    name: "core_get_status".into(),
                    family: "core".into(),
                    surface: CommandSurface::Engine,
                    registered: true,
                }],
            }),
        };
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["protocolVersion"], 1);
        assert_eq!(json["minProtocolVersion"], 1);
        assert_eq!(json["desktopId"], "d-01HZ");
        assert_eq!(json["serverTime"], 1754651200000_i64);
        assert_eq!(json["capabilities"]["streams"], true);
        assert_eq!(json["manifest"]["contractVersion"], "1.0.0");
        assert_eq!(json["manifest"]["commands"][0]["name"], "core_get_status");
        assert_eq!(json["manifest"]["commands"][0]["surface"], "engine");
        let back: HelloOk = serde_json::from_str(&serde_json::to_string(&ok).unwrap()).unwrap();
        assert_eq!(ok, back);
    }

    #[test]
    fn refresh_and_rotate_roundtrip() {
        let refresh = Refresh {
            refresh_token: "hmac-base64".into(),
        };
        let json = serde_json::to_value(&refresh).unwrap();
        assert_eq!(json["refreshToken"], "hmac-base64");
        let back: Refresh =
            serde_json::from_str(&serde_json::to_string(&refresh).unwrap()).unwrap();
        assert_eq!(refresh, back);

        let rotate = Rotate {
            nonce_seed: "seed-1".into(),
        };
        let json = serde_json::to_value(&rotate).unwrap();
        assert_eq!(json["nonceSeed"], "seed-1");
        let back: Rotate = serde_json::from_str(&serde_json::to_string(&rotate).unwrap()).unwrap();
        assert_eq!(rotate, back);
    }
}
