//! 历史迁移测试资产：无损转换、显式声明、备份与失败保护。

use super::*;
use std::fs;
use std::path::PathBuf;

/// 创建临时测试目录并在用例结束时自动清理
struct TempTestDir {
    path: PathBuf,
}

impl TempTestDir {
    fn new(name: &str) -> Self {
        let temp_base = std::env::temp_dir();
        let unique_name = format!(
            "conex_migration_test_{}_{}_{}",
            name,
            std::process::id(),
            ConfigMigrationManager::current_utc_timestamp()
        );
        let path = temp_base.join(unique_name);
        fs::create_dir_all(&path).expect("创建临时测试目录成功");
        Self { path }
    }

    fn file_path(&self, file_name: &str) -> PathBuf {
        self.path.join(file_name)
    }
}

impl Drop for TempTestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn read_tree(path: &std::path::Path) -> crate::models::UnifiedModelsConfig {
    crate::models::UnifiedModelsConfig::from_yaml_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn test_v1_multi_vendor_migration_success() {
    let directory = TempTestDir::new("multi_vendor");
    let path = directory.file_path("models.yaml");
    let raw = json!({"schema_version": 1, "models": [
        {"id": "deepseek-chat", "name": "DeepSeek V3", "vendor": "deepseek",
            "protocol": "openai/chat", "baseUrl": "https://example.invalid/deepseek",
            "contextWindow": 65536, "maxTokens": 8192, "reasoning": false},
        {"id": "deepseek-reasoner", "vendor": "deepseek", "protocol": "openai/chat",
            "baseUrl": "https://example.invalid/deepseek", "reasoning": true,
            "thinking": {"Low": "low", "Medium": "medium", "High": "high"},
            "compat": {"thinkingFormat": "deepseek"}, "maxTokens": 32768},
        {"id": "qwen3.8-max", "vendor": "qwen", "protocol": "openai/chat",
            "maxTokens": 65536, "compat": {"thinkingFormat": "qwen"}},
        {"id": "gpt-4o", "vendor": "openai", "protocol": "openai/chat",
            "apiKey": "$MIGRATION_TEST_KEY", "contextWindow": 128000, "maxTokens": 16384},
        {"id": "claude-3-5-sonnet", "vendor": "anthropic", "protocol": "anthropic/messages",
            "capabilities": {"reasoning": true, "tools": false, "image": true},
            "thinking": {"High": "16384"}, "contextWindow": 200000},
        {"id": "custom-llama", "vendor": "custom", "protocol": "openai/chat",
            "modalities": {"input": ["text"], "output": ["text"]}, "maxTokens": 4096}
    ]});
    let original = serde_yaml::to_string(&raw).unwrap();
    fs::write(&path, &original).unwrap();
    let result = ConfigMigrationManager::ensure_migrated(&path).unwrap();
    let MigrationStatus::MigratedSuccessfully {
        backup_path,
        provider_count,
        model_count,
    } = result
    else {
        panic!("旧版配置必须转换");
    };
    assert_eq!((provider_count, model_count), (5, 6));
    assert_eq!(fs::read_to_string(backup_path).unwrap(), original);
    assert!(!path.with_file_name("models.yaml.tmp").exists());
    let tree = read_tree(&path);
    let chat = tree.find_model("deepseek", "deepseek-chat").unwrap();
    assert_eq!(chat.context_window, Some(65536));
    assert_eq!(chat.max_output_tokens, Some(8192));
    assert!(chat.thinking.is_none());
    assert!(chat.modalities.is_none(), "缺省模态不能被补成 text");
    let reasoning = tree.find_model("deepseek", "deepseek-reasoner").unwrap();
    assert_eq!(reasoning.thinking.as_ref().unwrap()["High"], "high");
    assert_eq!(reasoning.max_output_tokens, Some(32768));
    let provider = tree.find_provider("openai").unwrap();
    assert_eq!(
        provider.api_key_ref.as_deref(),
        Some("env:MIGRATION_TEST_KEY")
    );
    let claude = tree.find_model("anthropic", "claude-3-5-sonnet").unwrap();
    assert_eq!(claude.supports_tools, Some(false));
    assert!(claude.supports_image_input());
    assert!(tree.find_provider("custom").unwrap().base_url.is_none());
    let written = fs::read_to_string(&path).unwrap();
    assert!(!written.contains("schema_version"));
    assert!(!written.contains("apiKey:"));
    assert!(!written.contains("capabilities:"));
}

#[test]
fn test_idempotency_multiple_calls_no_redundant_backups() {
    let directory = TempTestDir::new("idempotency");
    let path = directory.file_path("models.yaml");
    fs::write(
        &path,
        "models: [{vendor: Acme, id: m, protocol: openai/chat}]",
    )
    .unwrap();
    assert!(matches!(
        ConfigMigrationManager::ensure_migrated(&path).unwrap(),
        MigrationStatus::MigratedSuccessfully { .. }
    ));
    let first = fs::read(&path).unwrap();
    for _ in 0..2 {
        assert_eq!(
            ConfigMigrationManager::ensure_migrated(&path).unwrap(),
            MigrationStatus::AlreadyUpToDate
        );
        assert_eq!(fs::read(&path).unwrap(), first);
    }
    let backups = fs::read_dir(&directory.path)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".bak."))
        .count();
    assert_eq!(backups, 1);
}

#[test]
fn test_empty_and_comments_only_files_safe_skip() {
    let directory = TempTestDir::new("empty");
    let path = directory.file_path("models.yaml");
    assert_eq!(
        ConfigMigrationManager::ensure_migrated(&path).unwrap(),
        MigrationStatus::AlreadyUpToDate
    );
    for raw in ["", "  \n", "# 注释\n", "null"] {
        fs::write(&path, raw).unwrap();
        assert_eq!(
            ConfigMigrationManager::ensure_migrated(&path).unwrap(),
            MigrationStatus::AlreadyUpToDate
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }
}

#[test]
fn test_already_v2_tree_config_no_op() {
    let directory = TempTestDir::new("canonical");
    let path = directory.file_path("models.yaml");
    let raw = "version: 2\nproviders: {p: {models: [{id: m}]}}\n";
    fs::write(&path, raw).unwrap();
    assert_eq!(
        ConfigMigrationManager::ensure_migrated(&path).unwrap(),
        MigrationStatus::AlreadyUpToDate
    );
    assert_eq!(fs::read_to_string(path).unwrap(), raw);
    assert_eq!(fs::read_dir(&directory.path).unwrap().count(), 1);
}

#[test]
fn test_invalid_yaml_syntax_returns_error_and_preserves_file() {
    let directory = TempTestDir::new("invalid");
    let path = directory.file_path("models.yaml");
    let raw = "models: [}";
    fs::write(&path, raw).unwrap();
    assert!(ConfigMigrationManager::ensure_migrated(&path).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), raw);
}

#[test]
fn test_zero_model_loss_invariant() {
    let raw = json!({"providers": {"existing": {"models": [{"id": "kept"}]}}, "models": [
        {"vendor": "v1", "id": "m1", "protocol": "openai/chat"},
        {"vendor": "v1", "id": "m2", "protocol": "openai/chat"},
        {"vendor": "v2", "id": "m3", "protocol": "anthropic/messages"}
    ]});
    let (value, count) = ConfigMigrationManager::transform_flat_to_tree(&raw).unwrap();
    assert_eq!(count, 4);
    let tree =
        crate::models::UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&value).unwrap())
            .unwrap();
    for (provider, model) in [
        ("existing", "kept"),
        ("v1", "m1"),
        ("v1", "m2"),
        ("v2", "m3"),
    ] {
        assert!(tree.find_model(provider, model).is_some());
    }
}

#[test]
fn test_missing_context_window_and_max_output_stay_none() {
    let raw =
        json!({"models": [{"id": "bare-model", "vendor": "deepseek", "protocol": "openai/chat"}]});
    let (value, total) = ConfigMigrationManager::transform_flat_to_tree(&raw).unwrap();
    assert_eq!(total, 1);
    let tree =
        crate::models::UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&value).unwrap())
            .unwrap();
    let model = tree.find_model("deepseek", "bare-model").unwrap();
    assert_eq!(model.context_window, None);
    assert_eq!(model.max_output_tokens, None);
    assert_eq!(model.modalities, None);
    assert_eq!(model.thinking, None);
    assert_eq!(tree.find_provider("deepseek").unwrap().base_url, None);
}

#[test]
fn test_timestamp_format_and_civil_days_math() {
    let stamp = ConfigMigrationManager::current_utc_timestamp();
    assert_eq!(stamp.len(), 15);
    let parts: Vec<_> = stamp.split('_').collect();
    assert_eq!((parts[0].len(), parts[1].len()), (8, 6));
    assert!(parts
        .iter()
        .all(|part| part.bytes().all(|byte| byte.is_ascii_digit())));
    assert_eq!(ConfigMigrationManager::civil_from_days(0), (1970, 1, 1));
    assert_eq!(
        ConfigMigrationManager::civil_from_days(11016),
        (2000, 2, 29)
    );
    assert_eq!(ConfigMigrationManager::civil_from_days(20704), (2026, 9, 8));
}

#[test]
fn test_protocol_and_compat_inference_for_all_vendors() {
    // 保留旧测试资产并反转被废止的“按厂商猜测”合同：现在只认原声明。
    for vendor in [
        "anthropic",
        "claude",
        "google",
        "gemini",
        "deepseek",
        "qwen",
        "openai",
    ] {
        let raw = json!({"models": [{"vendor": vendor, "id": "m",
            "protocol": "google/generate-content", "compat": {"thinkingFormat": "qwen"}}]});
        let (value, count) = ConfigMigrationManager::transform_flat_to_tree(&raw).unwrap();
        assert_eq!(count, 1);
        let model = &value["providers"][vendor]["models"][0];
        assert_eq!(model["protocol"], "google/generate-content");
        assert_eq!(model["compat"]["thinkingFormat"], "qwen");
        assert!(value["providers"][vendor].get("baseUrl").is_none());
        let missing = json!({"models": [{"vendor": vendor, "id": "m"}]});
        assert!(ConfigMigrationManager::transform_flat_to_tree(&missing).is_err());
    }
}

#[test]
fn test_unknown_vendor_migration_leaves_base_url_empty() {
    let raw =
        json!({"models": [{"vendor": "Unknown/供应商", "id": "m", "protocol": "openai/chat"}]});
    let (value, count) = ConfigMigrationManager::transform_flat_to_tree(&raw).unwrap();
    assert_eq!(count, 1);
    assert!(value["providers"]["Unknown/供应商"]
        .get("baseUrl")
        .is_none());
    assert!(value["providers"]["Unknown/供应商"]
        .get("displayName")
        .is_none());
    assert!(value["providers"]["Unknown/供应商"].get("compat").is_none());
}

#[test]
fn test_pricing_and_custom_protocol_retention() {
    let raw = json!({"models": [{"vendor": "custom", "id": "special-model",
        "protocol": "openai/responses", "pricing": {"currency": "CNY", "billingUnit": "token",
            "inputPerMTok": 5, "outputPerMTok": 15, "cacheReadPerMTok": 0.5,
            "cacheWritePerMTok": 3.75, "perImageCost": 0,
            "tiers": [{"inputTokensAbove": 0, "inputPerMTok": 0, "outputPerMTok": 2}]}}]});
    let value = ConfigMigrationManager::migrate_legacy_value(&raw).unwrap();
    let model = &value["providers"]["custom"]["models"][0];
    assert_eq!(model["protocol"], "openai/responses");
    assert_eq!(model["pricing"]["unit"], "token");
    assert_eq!(model["pricing"]["input"].as_f64(), Some(5.0));
    assert_eq!(model["pricing"]["output"].as_f64(), Some(15.0));
    assert_eq!(model["pricing"]["cacheRead"], 0.5);
    assert_eq!(model["pricing"]["cacheWrite"], 3.75);
    assert_eq!(model["pricing"]["perImage"].as_f64(), Some(0.0));
    assert_eq!(model["pricing"]["tiers"][0]["input"].as_f64(), Some(0.0));
    assert!(model["pricing"].get("inputPerMTok").is_none());
}

#[test]
fn lossy_or_conflicting_legacy_input_is_rejected_without_mutation() {
    for raw in [
        json!({"models": [{"id": "m", "protocol": "openai/chat"}]}),
        json!({"models": [{"vendor": "p", "protocol": "openai/chat"}]}),
        json!({"models": [{"vendor": "p", "id": "m", "protocol": "openai/chat", "reasoning": true}]}),
        json!({"models": [{"vendor": "p", "id": "m", "protocol": "openai/chat", "apiKey": "test-inline-secret"}]}),
        json!({"providers": {"p": {"models": [{"id": "m", "model": "other"}]}}}),
        json!({"providers": {"p": {"models": [{"id": "m", "pricing": {"currency": "USD",
            "input": 1, "inputPerMTok": 2}}]}}}),
        json!({"models": [{"vendor": "p", "id": "m1", "protocol": "openai/chat", "baseUrl": "https://a.invalid"},
            {"vendor": "p", "id": "m2", "protocol": "openai/chat", "baseUrl": "https://b.invalid"}]}),
        json!({"providers": {"p": {"models": [{"id": "m", "unknown": 1}]}}}),
    ] {
        let before = raw.clone();
        let error = ConfigMigrationManager::migrate_legacy_value(&raw).unwrap_err();
        assert_eq!(raw, before);
        assert!(!error.to_string().contains("test-inline-secret"));
    }
}

#[test]
fn failed_semantic_migration_preserves_original_bytes() {
    let directory = TempTestDir::new("lossy");
    let path = directory.file_path("models.yaml");
    let raw = "models: [{vendor: p, id: m, protocol: openai/chat, reasoning: true}]\n";
    fs::write(&path, raw).unwrap();
    assert!(ConfigMigrationManager::ensure_migrated(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    assert!(!path.with_file_name("models.yaml.tmp").exists());
}

#[test]
fn field_aliases_migrate_only_at_the_explicit_boundary() {
    let raw = json!({"providers": {"p": {"protocol": "google/interactions",
    "compat": {"thinkingFormat": "google"}, "models": [{
        "model": "m", "contextLength": 1, "capabilities": {"tools": false},
        "thinking": {"X-High": "CUSTOM"}, "pricing": {"currency": "USD", "per_image_cost": 0}
    }]}}});
    let original_yaml = serde_yaml::to_string(&raw).unwrap();
    assert!(crate::models::UnifiedModelsConfig::from_yaml_str(&original_yaml).is_err());
    let migrated = ConfigMigrationManager::migrate_legacy_value(&raw).unwrap();
    let tree = crate::models::UnifiedModelsConfig::from_yaml_str(
        &serde_yaml::to_string(&migrated).unwrap(),
    )
    .unwrap();
    let model = tree.find_model("p", "m").unwrap();
    assert_eq!(model.context_window, Some(1));
    assert_eq!(model.supports_tools, Some(false));
    assert_eq!(model.thinking.as_ref().unwrap()["XHigh"], "CUSTOM");
    assert_eq!(model.pricing.as_ref().unwrap().per_image, Some(0.0));
    assert_eq!(
        ConfigMigrationManager::migrate_legacy_value(&migrated).unwrap(),
        migrated
    );
}
