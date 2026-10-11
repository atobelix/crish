//! 全局运行策略（用户裁决：重试时间预算与上限用户可配置，进配置文件，
//! 不与供应商绑定——与主题等同类的应用级偏好）。
//!
//! 权威文件 = `<config_dir>/settings.json` 的 `runPolicy` 段：
//! ```json
//! {
//!   "runPolicy": {
//!     "retryBackoff": { "baseMs": 750, "maxMs": 8000, "totalBudgetMs": 180000 },
//!     "transientRetryLimit": 10
//!   }
//! }
//! ```
//! 语义：
//! - 文件 / 段缺失 → 全 `None` → 装配点落现行缺省（750ms 指数退避 /
//!   8s 封顶 / 180s 预算、10 次上限）——缺省行为与文件引入前完全一致；
//! - 解析失败 → 记 warn 日志后按缺失处理（运行策略是增强性偏好，非
//!   关键数据；与 models.yaml 的 fail-closed 不同——坏策略文件不得
//!   阻断 run 发起）；
//! - 优先级：会话级键（provider_retry_backoff_ms，既有）> 本文件 > 缺省。

use serde::Deserialize;

/// 全局运行策略文件形状（settings.json；只认 runPolicy 段，其余字段忽略）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SettingsFile {
    #[serde(default)]
    pub(crate) run_policy: Option<RunPolicy>,
}

/// 运行策略：重试退避与瞬态重试上限（None = 落装配点缺省）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunPolicy {
    /// 重试退避（毫秒；None 字段落内核缺省：base 750 / max 8000 / 预算 60s）
    #[serde(default)]
    pub(crate) retry_backoff: Option<RetryBackoffPolicy>,
    /// 瞬态重试次数上限（0 = 显式禁用重试；None = 缺省 10）
    #[serde(default)]
    pub(crate) transient_retry_limit: Option<u32>,
}

/// 退避三参（与内核 [session_loop RetryBackoffConfig] 同形；None 字段
/// 落内核缺省，不在此处补值——「未配置 ≠ 补造」与价格同纪律）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetryBackoffPolicy {
    pub(crate) base_ms: Option<u64>,
    pub(crate) max_ms: Option<u64>,
    pub(crate) total_budget_ms: Option<u64>,
}

/// 读取全局运行策略（生产入口：权威目录 = config_dir）。
///
/// 文件缺失 / 无 runPolicy 段 → `Ok(None)`（装配点落缺省）；解析失败 →
/// warn + `Ok(None)`（见模块头 fail-open 裁决）。
pub(crate) fn read_run_policy() -> Option<RunPolicy> {
    let dir = super::persistence::config_dir().ok()?;
    read_run_policy_from(&dir)
}

/// 目录参数化读取（测试注入与生产入口共用同一解析路径）。
pub(crate) fn read_run_policy_from(dir: &std::path::Path) -> Option<RunPolicy> {
    let path = dir.join("settings.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(error = %error, path = %path.display(), "运行策略文件不可读，按缺省处理");
            return None;
        }
    };
    match serde_json::from_str::<SettingsFile>(&raw) {
        Ok(parsed) => parsed.run_policy,
        Err(error) => {
            tracing::warn!(
                error = %error,
                path = %path.display(),
                "运行策略文件解析失败，按缺省处理（修复文件后重启生效）"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_policy_parses_full_shape() {
        let raw = r#"{
            "runPolicy": {
                "retryBackoff": { "baseMs": 100, "maxMs": 2000, "totalBudgetMs": 30000 },
                "transientRetryLimit": 3
            }
        }"#;
        let parsed: SettingsFile = serde_json::from_str(raw).expect("合法策略文件");
        let policy = parsed.run_policy.expect("runPolicy 段");
        let backoff = policy.retry_backoff.expect("退避段");
        assert_eq!(backoff.base_ms, Some(100));
        assert_eq!(backoff.max_ms, Some(2000));
        assert_eq!(backoff.total_budget_ms, Some(30000));
        assert_eq!(policy.transient_retry_limit, Some(3));
    }

    #[test]
    fn run_policy_partial_fields_fall_back_to_kernel_defaults() {
        let raw = r#"{ "runPolicy": { "transientRetryLimit": 5 } }"#;
        let parsed: SettingsFile = serde_json::from_str(raw).expect("合法策略文件");
        let policy = parsed.run_policy.expect("runPolicy 段");
        assert!(
            policy.retry_backoff.is_none(),
            "未配置退避 → 装配点落内核缺省"
        );
        assert_eq!(policy.transient_retry_limit, Some(5));
    }

    #[test]
    fn run_policy_missing_section_is_none() {
        let parsed: SettingsFile = serde_json::from_str("{}").expect("空对象合法");
        assert!(parsed.run_policy.is_none());
    }

    #[test]
    fn run_policy_unknown_fields_rejected() {
        // deny_unknown_fields：策略文件拼错字段名显式失败（warn + 缺省），
        // 不静默吞掉拼错的意图
        let raw = r#"{ "runPolicy": { "retrryBackoff": {} } }"#;
        let parsed: Result<SettingsFile, _> = serde_json::from_str(raw);
        assert!(parsed.is_err(), "未知字段必须拒绝（fail-closed 解析面）");
    }
}
