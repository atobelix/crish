//! 厂商凭据注入面（R3-03 接线轮：环境变量装配，不落配置明文）
//!
//! 规格真源：D7 §8.2「厂商凭据：优先环境变量（`CRISH_PUSH_HMS_APP_ID` 等），
//! 或复用现有密钥槽——**不落配置文件明文、不进 git**」+ §8.4-1「厂商凭据
//! 不进 git、不进日志（tracing 打码）」。
//!
//! 变量名约定：`CRISH_PUSH_<厂商>_<字段>`（D7 §8.2 举例 HMS APP_ID 的
//! 完整形态推导；APNs 四件套 + 沙箱开关、HMS 三件套）：
//!
//! | 变量 | 字段 | 缺失语义 |
//! | --- | --- | --- |
//! | `CRISH_PUSH_APNS_AUTH_KEY_PATH` | `.p8` AuthKey 路径 | 视为未配置 → 通道不装配 |
//! | `CRISH_PUSH_APNS_KEY_ID` | JWT header `kid` | 同上 |
//! | `CRISH_PUSH_APNS_TEAM_ID` | JWT claims `iss` | 同上 |
//! | `CRISH_PUSH_APNS_BUNDLE_ID` | `apns-topic` 头 | 同上 |
//! | `CRISH_PUSH_APNS_SANDBOX` | 沙箱开关（`1`/`true`/`yes` → 沙箱） | 缺省 = 生产 |
//! | `CRISH_PUSH_HMS_APP_ID` | AGC App ID（OAuth2 `client_id`） | 视为未配置 → 通道不装配 |
//! | `CRISH_PUSH_HMS_APP_SECRET` | AGC App Secret（换 AT 用） | 同上 |
//! | `CRISH_PUSH_HMS_PACKAGE_NAME` | 应用包名 | 同上 |
//!
//! 注入语义（对齐 [crate::push::pusher::PushDispatcher] 的「宁可待发不丢」
//! 最小姿态）：凭据缺失 = 厂商通道不可装配 → [send_pending_batch] 将该
//! 设备条目保留回 pending 队列 + warn 日志，不崩溃。
//!
//! 本模块不落盘、不缓存进程内密钥副本之外的状态；凭据对象生命周期由
//! 装配方（发送器）持有。

use std::collections::HashMap;

use super::{APNsCredentials, HMSCredentials};

/// APNs `.p8` AuthKey 文件路径（环境变量名）
pub const ENV_APNS_AUTH_KEY_PATH: &str = "CRISH_PUSH_APNS_AUTH_KEY_PATH";
/// APNs Key ID（JWT header `kid`）
pub const ENV_APNS_KEY_ID: &str = "CRISH_PUSH_APNS_KEY_ID";
/// APNs Team ID（JWT claims `iss`）
pub const ENV_APNS_TEAM_ID: &str = "CRISH_PUSH_APNS_TEAM_ID";
/// APNs App bundle id（`apns-topic` 头）
pub const ENV_APNS_BUNDLE_ID: &str = "CRISH_PUSH_APNS_BUNDLE_ID";
/// APNs 沙箱开关（`1`/`true`/`yes` → 沙箱；缺省 = 生产）
pub const ENV_APNS_SANDBOX: &str = "CRISH_PUSH_APNS_SANDBOX";
/// HMS AGC App ID（OAuth2 `client_id`；发送端点路径段）
pub const ENV_HMS_APP_ID: &str = "CRISH_PUSH_HMS_APP_ID";
/// HMS AGC App Secret（仅换 AT 用，不外泄）
pub const ENV_HMS_APP_SECRET: &str = "CRISH_PUSH_HMS_APP_SECRET";
/// HMS 应用包名
pub const ENV_HMS_PACKAGE_NAME: &str = "CRISH_PUSH_HMS_PACKAGE_NAME";

/// 凭据提供者抽象（装配方注入；生产 = 环境变量，测试 = 内存映射）
///
/// 返回 `None` = 该厂商凭据未配置（通道不可装配，pending 保留——
/// 优雅降级语义见 [send_pending_batch]）。
pub trait CredentialsProvider: Send + Sync {
    /// APNs 凭据（.p8 路径/keyId/teamId/bundleId/沙箱开关；缺任一 → None）
    fn apns(&self) -> Option<APNsCredentials>;
    /// HMS 凭据（appId/appSecret/包名；缺任一 → None）
    fn hms(&self) -> Option<HMSCredentials>;
}

/// 环境变量凭据提供者（生产装配入口，D7 §8.2）
///
/// 任一项环境变量缺失 → 对应厂商返回 `None`（不抛错——启动期优雅降级）。
#[derive(Debug, Default, Clone, Copy)]
pub struct EnvCredentialsProvider;

impl CredentialsProvider for EnvCredentialsProvider {
    fn apns(&self) -> Option<APNsCredentials> {
        Some(APNsCredentials {
            auth_key_path: std::env::var(ENV_APNS_AUTH_KEY_PATH).ok()?.into(),
            key_id: std::env::var(ENV_APNS_KEY_ID).ok()?,
            team_id: std::env::var(ENV_APNS_TEAM_ID).ok()?,
            bundle_id: std::env::var(ENV_APNS_BUNDLE_ID).ok()?,
            sandbox: std::env::var(ENV_APNS_SANDBOX)
                .map(|value| sandbox_flag(&value))
                .unwrap_or(false),
        })
    }

    fn hms(&self) -> Option<HMSCredentials> {
        Some(HMSCredentials {
            app_id: std::env::var(ENV_HMS_APP_ID).ok()?,
            app_secret: std::env::var(ENV_HMS_APP_SECRET).ok()?,
            package_name: std::env::var(ENV_HMS_PACKAGE_NAME).ok()?,
        })
    }
}

/// 内存映射凭据提供者（测试与装配引导用；键 = 环境变量名，值 = 变量值）
///
/// 与 [EnvCredentialsProvider] 走同一套变量名与语义，测试不触碰进程级
/// 环境变量（cargo test 并行线程下 `set_var` 有竞态），只验证解析逻辑。
#[derive(Debug, Clone, Default)]
pub struct MapCredentialsProvider {
    vars: HashMap<String, String>,
}

impl MapCredentialsProvider {
    /// 用（变量名 → 值）映射构造
    pub fn new(vars: HashMap<String, String>) -> Self {
        Self { vars }
    }

    /// 便捷构造：从 (变量名, 值) 对迭代器
    pub fn from_pairs(iter: impl IntoIterator<Item = (&'static str, String)>) -> Self {
        Self::new(
            iter.into_iter()
                .map(|(name, value)| (name.to_string(), value))
                .collect(),
        )
    }

    fn get(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
}

impl CredentialsProvider for MapCredentialsProvider {
    fn apns(&self) -> Option<APNsCredentials> {
        Some(APNsCredentials {
            auth_key_path: self.get(ENV_APNS_AUTH_KEY_PATH)?.into(),
            key_id: self.get(ENV_APNS_KEY_ID)?,
            team_id: self.get(ENV_APNS_TEAM_ID)?,
            bundle_id: self.get(ENV_APNS_BUNDLE_ID)?,
            sandbox: self
                .get(ENV_APNS_SANDBOX)
                .map(|value| sandbox_flag(&value))
                .unwrap_or(false),
        })
    }

    fn hms(&self) -> Option<HMSCredentials> {
        Some(HMSCredentials {
            app_id: self.get(ENV_HMS_APP_ID)?,
            app_secret: self.get(ENV_HMS_APP_SECRET)?,
            package_name: self.get(ENV_HMS_PACKAGE_NAME)?,
        })
    }
}

/// 沙箱开关解析（`1` / `true` / `yes` 不区分大小写 → 沙箱；其余 → 生产）
pub fn sandbox_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 沙箱开关解析矩阵（真值 1/true/yes 大小写不敏感；其余为假）
    #[test]
    fn sandbox_flag_accepts_truthy_values() {
        assert!(sandbox_flag("1"));
        assert!(sandbox_flag("true"));
        assert!(sandbox_flag("TRUE"));
        assert!(sandbox_flag("Yes"));
        assert!(sandbox_flag(" yes "), "空白容忍");
        assert!(!sandbox_flag("0"));
        assert!(!sandbox_flag("false"));
        assert!(!sandbox_flag("no"));
        assert!(!sandbox_flag(""), "空串 = 生产");
        assert!(!sandbox_flag("on"), "未登记值 = 生产（保守）");
    }

    /// APNs 全量变量 → 凭据（沙箱开关缺省 false；显式 1 → true）
    #[test]
    fn map_provider_assembles_apns() {
        let vars = [
            (ENV_APNS_AUTH_KEY_PATH, "AuthKey.p8".to_string()),
            (ENV_APNS_KEY_ID, "KEYID1".to_string()),
            (ENV_APNS_TEAM_ID, "TEAM42".to_string()),
            (ENV_APNS_BUNDLE_ID, "com.crish.mobile".to_string()),
        ];
        let provider = MapCredentialsProvider::from_pairs(vars);
        let creds = provider.apns().expect("全量变量 → APNs 凭据");
        assert_eq!(creds.key_id, "KEYID1");
        assert_eq!(creds.team_id, "TEAM42");
        assert_eq!(creds.bundle_id, "com.crish.mobile");
        assert!(!creds.sandbox, "缺沙箱变量 = 生产");

        let provider = MapCredentialsProvider::from_pairs([
            (ENV_APNS_AUTH_KEY_PATH, "AuthKey.p8".to_string()),
            (ENV_APNS_KEY_ID, "K".to_string()),
            (ENV_APNS_TEAM_ID, "T".to_string()),
            (ENV_APNS_BUNDLE_ID, "com.crish.mobile".to_string()),
            (ENV_APNS_SANDBOX, "true".to_string()),
        ]);
        assert!(provider.apns().expect("完整凭据").sandbox, "沙箱显式开启");
    }

    /// HMS 全量变量 → 凭据；缺任一 → None（优雅降级）
    #[test]
    fn map_provider_assembles_hms_and_degrades() {
        let provider = MapCredentialsProvider::from_pairs([
            (ENV_HMS_APP_ID, "100123456".to_string()),
            (ENV_HMS_APP_SECRET, "s3cret".to_string()),
            (ENV_HMS_PACKAGE_NAME, "com.crish.mobile".to_string()),
        ]);
        let creds = provider.hms().expect("全量变量 → HMS 凭据");
        assert_eq!(creds.app_id, "100123456");
        assert_eq!(creds.app_secret, "s3cret");
        assert_eq!(creds.package_name, "com.crish.mobile");

        // 缺 App Secret → None（不抛错，通道不装配）
        let partial = MapCredentialsProvider::from_pairs([
            (ENV_HMS_APP_ID, "100123456".to_string()),
            (ENV_HMS_PACKAGE_NAME, "com.crish.mobile".to_string()),
        ]);
        assert!(partial.hms().is_none(), "缺 secret → 未配置");

        let empty = MapCredentialsProvider::default();
        assert!(empty.apns().is_none(), "缺变量 → 未配置");
        assert!(empty.hms().is_none());
    }

    /// 变量名遵循 D7 §8.2 约定（CRISH_PUSH_ 前缀 + 厂商 + 字段）
    #[test]
    fn env_names_follow_crish_push_convention() {
        for name in [
            ENV_APNS_AUTH_KEY_PATH,
            ENV_APNS_KEY_ID,
            ENV_APNS_TEAM_ID,
            ENV_APNS_BUNDLE_ID,
            ENV_APNS_SANDBOX,
            ENV_HMS_APP_ID,
            ENV_HMS_APP_SECRET,
            ENV_HMS_PACKAGE_NAME,
        ] {
            assert!(
                name.starts_with("CRISH_PUSH_"),
                "变量名须带 CRISH_PUSH_ 前缀：{name}"
            );
        }
        assert!(ENV_HMS_APP_ID.starts_with("CRISH_PUSH_HMS_"));
        assert!(ENV_APNS_KEY_ID.starts_with("CRISH_PUSH_APNS_"));
    }
}
