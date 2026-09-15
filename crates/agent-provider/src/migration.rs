//! 历史配置的显式迁移。转换不能证明无损时拒绝，不补厂商、能力或价格。
//! 凭据字面量必须先由存储事务导入凭据库；本模块不会把它复制进规范树。

use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[path = "models/config_legacy.rs"]
mod legacy;

#[derive(Error, Debug)]
pub enum MigrationError {
    #[error("文件 I/O 异常: {0}")]
    Io(#[from] std::io::Error),
    #[error("YAML 序列化/反序列化失败: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("JSON 序列化/反序列化失败: {0}")]
    Json(#[from] serde_json::Error),
    #[error("备份校验失败: 备份文件大小不匹配 (原始: {expected}B, 实际: {actual}B)")]
    BackupVerificationFailed { expected: u64, actual: u64 },
    #[error("迁移完整性校验未通过: 原始模型数 {original} 与迁移后模型数 {migrated} 不一致")]
    LossyMigrationDetected { original: usize, migrated: usize },
    #[error("目标路径非法或不存在: {0}")]
    InvalidPath(String),
    #[error("旧配置无法无损转换: {0}")]
    InvalidConfig(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MigrationStatus {
    AlreadyUpToDate,
    MigratedSuccessfully {
        backup_path: PathBuf,
        provider_count: usize,
        model_count: usize,
    },
}

pub struct ConfigMigrationManager;

impl ConfigMigrationManager {
    /// 纯转换完成并经规范解析入口确认后才创建备份与替换原件。
    pub fn ensure_migrated(config_path: &Path) -> Result<MigrationStatus, MigrationError> {
        if !config_path.exists() {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }
        let raw = fs::read_to_string(config_path)?;
        let yaml: serde_yaml::Value = serde_yaml::from_str(&raw)?;
        if yaml.is_null() {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }
        let old = serde_json::to_value(yaml)?;
        // 规范配置无需重写缺省字段，也不因字段顺序或空白不同制造备份。
        if crate::models::UnifiedModelsConfig::from_yaml_str(&raw).is_ok() {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }
        let migrated = Self::migrate_legacy_value(&old)?;
        if migrated == old {
            return Ok(MigrationStatus::AlreadyUpToDate);
        }
        let serialized = serde_yaml::to_string(&migrated)?;
        let tree = crate::models::UnifiedModelsConfig::from_yaml_str(&serialized)
            .map_err(MigrationError::InvalidConfig)?;
        let backup_path = Self::create_disaster_backup(config_path)?;
        let name = config_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| MigrationError::InvalidPath("缺少配置文件名".into()))?;
        let temporary = config_path.with_file_name(format!("{name}.tmp"));
        fs::write(&temporary, serialized.as_bytes())?;
        let written = fs::read_to_string(&temporary)?;
        let verified = crate::models::UnifiedModelsConfig::from_yaml_str(&written)
            .map_err(MigrationError::InvalidConfig)?;
        if verified != tree {
            return Err(MigrationError::InvalidConfig(
                "临时配置回读不一致，原件未替换".into(),
            ));
        }
        Self::atomic_replace(&temporary, config_path)?;
        Ok(MigrationStatus::MigratedSuccessfully {
            backup_path,
            provider_count: tree.providers.len(),
            model_count: tree
                .providers
                .values()
                .map(|provider| provider.models.len())
                .sum(),
        })
    }

    /// 历史别名只在这个显式入口消费；不允许在请求期读取旧字段或补查字典。
    pub fn migrate_legacy_value(old: &Value) -> Result<Value, MigrationError> {
        legacy::migrate(old)
    }

    /// 原有扁平格式迁移入口，仍执行同一无损转换与规范校验。
    pub fn transform_flat_to_tree(old: &Value) -> Result<(Value, usize), MigrationError> {
        let migrated = Self::migrate_legacy_value(old)?;
        let count = migrated
            .get("providers")
            .and_then(Value::as_object)
            .map(|providers| {
                providers
                    .values()
                    .filter_map(|provider| provider.get("models").and_then(Value::as_array))
                    .map(Vec::len)
                    .sum()
            })
            .unwrap_or(0);
        Ok((migrated, count))
    }

    /// 修改前保留原始字节；时间戳冲突使用独立备份名。
    pub fn create_disaster_backup(source: &Path) -> Result<PathBuf, MigrationError> {
        let metadata = fs::metadata(source)?;
        let original_size = metadata.len();

        let timestamp = Self::current_utc_timestamp();
        let file_stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("models");
        let ext = source
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("yaml");
        let backup_file_name = format!("{}.{}.bak.{}", file_stem, timestamp, ext);
        let mut backup_path = source.with_file_name(&backup_file_name);

        if backup_path.exists() {
            let mut counter = 1;
            while backup_path.exists() {
                let backup_file_name =
                    format!("{}.{}_{}.bak.{}", file_stem, timestamp, counter, ext);
                backup_path = source.with_file_name(backup_file_name);
                counter += 1;
            }
        }

        fs::copy(source, &backup_path)?;

        // 严格验证备份文件体积
        let backup_size = fs::metadata(&backup_path)?.len();
        if backup_size != original_size {
            let _ = fs::remove_file(&backup_path);
            return Err(MigrationError::BackupVerificationFailed {
                expected: original_size,
                actual: backup_size,
            });
        }

        Ok(backup_path)
    }

    /// 安全替换目标文件，消除 Windows 平台先删后移的物理丢失崩溃窗口
    pub fn atomic_replace(tmp_path: &Path, target: &Path) -> Result<(), MigrationError> {
        // 先尝试直接原子重命名（Unix 或目标不存在时直接成功）
        if fs::rename(tmp_path, target).is_ok() {
            return Ok(());
        }

        // Windows 3 阶段安全替换：
        // 阶段 1：先将原目标安全改名为临时暂存文件 .roll.bak（绝不在改名前删除目标）
        let pid = std::process::id();
        let target_name = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("models.yaml");
        let roll_bak_path = target.with_file_name(format!("{}.{}.roll.bak", target_name, pid));

        if roll_bak_path.exists() {
            let _ = fs::remove_file(&roll_bak_path);
        }

        fs::rename(target, &roll_bak_path)?;

        // 阶段 2：将新文件重命名为目标路径
        if let Err(rename_err) = fs::rename(tmp_path, target) {
            // 提交失败时执行原子回滚，将 .roll.bak 恢复至目标路径
            let _ = fs::rename(&roll_bak_path, target);
            let _ = fs::remove_file(tmp_path);
            return Err(MigrationError::Io(rename_err));
        }

        // 阶段 3：成功提交后清理临时暂存文件
        let _ = fs::remove_file(&roll_bak_path);
        Ok(())
    }

    /// 获取 UTC 时间戳字符串 (%Y%m%d_%H%M%S)。
    /// 实现基于 Unix epoch 的秒数换算，天然为 UTC，绝非本地时区；
    /// 历史名 current_local_timestamp 已更名为 current_utc_timestamp，消除撒谎命名。
    pub fn current_utc_timestamp() -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let secs = now.as_secs();
        let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
        let (year, month, day) = Self::civil_from_days((secs / 86400) as i64);
        format!("{year:04}{month:02}{day:02}_{hours:02}{mins:02}{sec:02}")
    }

    /// 从 Unix 天数换算公历年月日（Howard Hinnant 算法）
    pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        (if m <= 2 { y + 1 } else { y }, m, d)
    }
}

#[cfg(test)]
#[path = "migration_tests.rs"]
mod migration_tests;

#[cfg(test)]
mod migration_hardening_tests {
    use super::*;

    #[test]
    fn test_capabilities_and_headers_migration_retention() {
        let mut legacy_json = json!({
            "schema_version": 1,
            "headers": {
                "X-Global-Key": "global-secret"
            },
            "models": [
                {
                    "id": "custom-vision-model",
                    "vendor": "custom-ai",
                    "protocol": "openai/chat",
                    "providerHeaders": {
                        "X-Vendor-Auth": "Bearer token123"
                    },
                    "headers": {
                        "X-Model-Direct": "model-opt"
                    },
                    "capabilities": {
                        "tools": true,
                        "image": true,
                        "video": false
                    }
                },
                {
                    "id": "flat-tools-model",
                    "vendor": "custom-ai",
                    "protocol": "openai/chat",
                    "tools": true
                }
            ]
        });

        // 旧根级 headers 没有明确供应商作用域，不能悄悄丢失或广播给所有供应商。
        assert!(ConfigMigrationManager::transform_flat_to_tree(&legacy_json).is_err());
        legacy_json.as_object_mut().unwrap().remove("headers");
        let (migrated, total_models) =
            ConfigMigrationManager::transform_flat_to_tree(&legacy_json).expect("迁移转换应当成功");
        assert_eq!(total_models, 2);

        let providers = migrated
            .get("providers")
            .and_then(|v| v.as_object())
            .unwrap();
        let provider = providers.get("custom-ai").expect("custom-ai 供应商存在");

        // 验证供应商级 headers
        let prov_headers = provider.get("headers").expect("供应商级 headers 存在");
        assert_eq!(
            prov_headers.get("X-Vendor-Auth").and_then(|v| v.as_str()),
            Some("Bearer token123")
        );

        let models = provider.get("models").and_then(|v| v.as_array()).unwrap();
        let m1 = models
            .iter()
            .find(|m| m.get("id").and_then(|v| v.as_str()) == Some("custom-vision-model"))
            .unwrap();

        // 验证模型级 headers
        let m1_headers = m1.get("headers").expect("模型级 headers 存在");
        assert_eq!(
            m1_headers.get("X-Model-Direct").and_then(|v| v.as_str()),
            Some("model-opt")
        );

        // 旧能力只有一个规范出口，不能留下 capabilities 第二真源。
        assert!(m1.get("capabilities").is_none());
        assert_eq!(m1.get("supportsTools").and_then(Value::as_bool), Some(true));

        // 验证 modalities 自动补齐含 image
        let modalities = m1.get("modalities").expect("modalities 存在");
        let input_mods: Vec<String> = modalities
            .get("input")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        assert!(input_mods.contains(&"image".to_string()));
        assert!(!input_mods.contains(&"video".to_string()));

        let m2 = models
            .iter()
            .find(|m| m.get("id").and_then(|v| v.as_str()) == Some("flat-tools-model"))
            .unwrap();
        assert!(m2.get("capabilities").is_none());
        assert_eq!(m2.get("supportsTools").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn test_atomic_replace_clean_commit_and_cleanup() {
        let temp_dir = std::env::temp_dir().join(format!(
            "conex_atomic_replace_test_{}_{}",
            std::process::id(),
            ConfigMigrationManager::current_utc_timestamp()
        ));
        let _ = fs::create_dir_all(&temp_dir);

        let target_path = temp_dir.join("models.yaml");
        let tmp_path = temp_dir.join("models.yaml.tmp");

        fs::write(&target_path, "old: 1").unwrap();
        fs::write(&tmp_path, "new: 2").unwrap();

        ConfigMigrationManager::atomic_replace(&tmp_path, &target_path).expect("原子替换应当成功");

        assert!(!tmp_path.exists(), "临时文件必须已被移动");
        let content = fs::read_to_string(&target_path).unwrap();
        assert_eq!(content, "new: 2");

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
