//! 存量 models.yaml 迁移引擎自动化验证套件
//!
//! 验证点：
//! 1. 旧版 v1.0 多厂商平铺配置无损升级为 v2.0 Provider-Centric 树状拓扑；
//! 2. 思考能力平铺字典映射（{ Low: "low", Medium: "medium", High: "high" }）与非思考模型缺省；
//! 3. 模态字段自动补齐（modalities: input/output: ["text"]）；
//! 4. 时间戳物理防灾备份 (.bak) 创建与字节一致性校验；
//! 5. 幂等性：连续多次调用安全返回 AlreadyUpToDate，绝不生成冗余备份；
//! 6. 边界与容灾：空文件、纯注释、已是 v2 配置以及损坏 YAML 的自愈与安全拦截。

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
            ConfigMigrationManager::current_local_timestamp()
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

#[test]
fn test_v1_multi_vendor_migration_success() {
    let test_dir = TempTestDir::new("v1_multi_vendor");
    let config_path = test_dir.file_path("models.yaml");

    let legacy_yaml = r#"
schema_version: 1
models:
  - id: "deepseek-chat"
    name: "DeepSeek V3"
    vendor: "deepseek"
    baseUrl: "https://api.deepseek.com"
    contextWindow: 65536
    maxTokens: 8192
    reasoning: false
  - id: "deepseek-reasoner"
    name: "DeepSeek R1"
    vendor: "deepseek"
    baseUrl: "https://api.deepseek.com"
    contextWindow: 131072
    maxTokens: 32768
    reasoning: true
  - id: "qwen3.8-max"
    name: "通义千问 3.8 Max"
    vendor: "qwen"
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    contextWindow: 1000000
    maxTokens: 65536
  - id: "gpt-4o"
    displayName: "GPT-4o 旗舰"
    vendor: "openai"
    apiKey: "sk-proj-test123456"
    contextWindow: 128000
    maxTokens: 16384
  - id: "claude-3-5-sonnet"
    name: "Claude 3.5 Sonnet"
    vendor: "anthropic"
    protocol: "anthropic/messages"
    contextWindow: 200000
    maxTokens: 8192
    capabilities:
      reasoning: true
  - id: "custom-llama"
    name: "Llama 3.3 70B"
    vendor: ""
    contextWindow: 32768
    maxTokens: 4096
"#;

    fs::write(&config_path, legacy_yaml).expect("写入旧版配置成功");
    let original_bytes = fs::metadata(&config_path).unwrap().len();

    let status = ConfigMigrationManager::ensure_migrated(&config_path)
        .expect("旧版配置迁移必须成功");

    // 1. 状态与备份校验
    match status {
        MigrationStatus::MigratedSuccessfully {
            backup_path,
            provider_count,
            model_count,
        } => {
            assert!(backup_path.exists(), "备份文件必须物理存在");
            assert_eq!(
                fs::metadata(&backup_path).unwrap().len(),
                original_bytes,
                "备份文件大小必须严格等于原文件大小"
            );
            assert!(
                backup_path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .contains(".bak."),
                "备份文件名必须包含 .bak. 时间戳标记"
            );
            assert_eq!(model_count, 6, "迁移后模型数必须为 6");
            assert_eq!(provider_count, 5, "供应商聚类总数必须为 5 (deepseek, qwen, openai, anthropic, custom)");
        }
        MigrationStatus::AlreadyUpToDate => panic!("初次运行旧版配置不应返回 AlreadyUpToDate"),
    }

    // 2. 验证临时文件 .tmp 已被干净清理
    let tmp_file = config_path.with_file_name("models.yaml.tmp");
    assert!(!tmp_file.exists(), "原子写完成后临时文件必须不存在");

    // 3. 验证迁移后的树状 YAML 结构与字段保真度
    let migrated_str = fs::read_to_string(&config_path).expect("读取迁移后文件");
    let v2_value: serde_json::Value = serde_yaml::from_str(&migrated_str).expect("有效 YAML 反序列化");

    assert_eq!(v2_value.get("schema_version").and_then(|v| v.as_u64()), Some(2));
    assert_eq!(v2_value.get("version").and_then(|v| v.as_u64()), Some(2));

    let providers = v2_value.get("providers").and_then(|v| v.as_object()).expect("providers 对象");
    assert_eq!(providers.len(), 5);

    // 4. 验证 DeepSeek 供应商及其下属模型
    let ds = providers.get("deepseek").expect("deepseek 供应商存在");
    assert_eq!(ds.get("baseUrl").and_then(|v| v.as_str()), Some("https://api.deepseek.com"));
    assert_eq!(ds.get("protocol").and_then(|v| v.as_str()), Some("openai/chat"));
    assert_eq!(
        ds.get("compat").and_then(|c| c.get("thinkingFormat")).and_then(|v| v.as_str()),
        Some("deepseek")
    );

    let ds_models = ds.get("models").and_then(|v| v.as_array()).expect("deepseek 模型数组");
    assert_eq!(ds_models.len(), 2);

    let ds_chat = ds_models.iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some("deepseek-chat")).unwrap();
    assert_eq!(ds_chat.get("displayName").and_then(|v| v.as_str()), Some("DeepSeek V3"));
    assert_eq!(ds_chat.get("contextWindow").and_then(|v| v.as_u64()), Some(65536));
    assert_eq!(ds_chat.get("maxOutputTokens").and_then(|v| v.as_u64()), Some(8192));
    assert!(ds_chat.get("thinking").is_none(), "非思考模型必须省略 thinking 字段");
    let modalities = ds_chat.get("modalities").expect("多模态规格补齐");
    assert_eq!(modalities.get("input").and_then(|v| v.as_array()).unwrap().len(), 1);
    assert_eq!(modalities.get("output").and_then(|v| v.as_array()).unwrap().len(), 1);

    let ds_reasoner = ds_models.iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some("deepseek-reasoner")).unwrap();
    assert_eq!(ds_reasoner.get("contextWindow").and_then(|v| v.as_u64()), Some(131072));
    assert_eq!(ds_reasoner.get("maxOutputTokens").and_then(|v| v.as_u64()), Some(32768));
    let thinking = ds_reasoner.get("thinking").and_then(|v| v.as_object()).expect("思考模型拍平字典");
    assert_eq!(thinking.get("Low").and_then(|v| v.as_str()), Some("low"));
    assert_eq!(thinking.get("Medium").and_then(|v| v.as_str()), Some("medium"));
    assert_eq!(thinking.get("High").and_then(|v| v.as_str()), Some("high"));

    // 5. 验证 OpenAI 供应商与 apiKey 迁移
    let openai = providers.get("openai").expect("openai 供应商存在");
    assert_eq!(openai.get("apiKey").and_then(|v| v.as_str()), Some("sk-proj-test123456"));
    assert_eq!(
        openai.get("compat").and_then(|c| c.get("thinkingFormat")).and_then(|v| v.as_str()),
        Some("openai")
    );

    // 6. 验证 Anthropic 供应商与协议继承
    let anthropic = providers.get("anthropic").expect("anthropic 供应商存在");
    assert_eq!(anthropic.get("protocol").and_then(|v| v.as_str()), Some("anthropic/messages"));
    let claude_model = anthropic
        .get("models")
        .and_then(|v| v.as_array())
        .unwrap()
        .iter()
        .find(|m| m.get("id").and_then(|v| v.as_str()) == Some("claude-3-5-sonnet"))
        .unwrap();
    assert!(claude_model.get("thinking").is_some(), "capabilities.reasoning 思考模型正常转换");

    // 7. 验证 custom 默认聚类
    let custom = providers.get("custom").expect("custom 供应商存在");
    assert_eq!(custom.get("protocol").and_then(|v| v.as_str()), Some("openai/chat"));
    assert_eq!(custom.get("models").and_then(|v| v.as_array()).unwrap().len(), 1);

    // 8. 强类型契约反序列化校验（保证与 catalog_types 完全契约对齐）
    let catalog_config: crate::models::catalog_types::UnifiedModelsConfig =
        serde_yaml::from_str(&migrated_str).expect("必须成功反序列化为 UnifiedModelsConfig 契约");
    assert_eq!(catalog_config.version, 2);
    assert_eq!(catalog_config.providers.len(), 5);
}

#[test]
fn test_idempotency_multiple_calls_no_redundant_backups() {
    let test_dir = TempTestDir::new("idempotency");
    let config_path = test_dir.file_path("models.yaml");

    let legacy_yaml = r#"
schema_version: 1
models:
  - id: "deepseek-chat"
    vendor: "deepseek"
"#;
    fs::write(&config_path, legacy_yaml).unwrap();

    // 第一次调用：执行迁移
    let res1 = ConfigMigrationManager::ensure_migrated(&config_path).unwrap();
    assert!(matches!(res1, MigrationStatus::MigratedSuccessfully { .. }));

    // 统计当前备份文件数量
    let count_backups = || -> usize {
        fs::read_dir(&test_dir.path)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".bak."))
            .count()
    };
    assert_eq!(count_backups(), 1);

    // 第二次调用：应当幂等跳过
    let res2 = ConfigMigrationManager::ensure_migrated(&config_path).unwrap();
    assert_eq!(res2, MigrationStatus::AlreadyUpToDate);
    assert_eq!(count_backups(), 1, "幂等调用不得生成新的冗余备份");

    // 第三次调用：继续幂等跳过
    let res3 = ConfigMigrationManager::ensure_migrated(&config_path).unwrap();
    assert_eq!(res3, MigrationStatus::AlreadyUpToDate);
    assert_eq!(count_backups(), 1, "多次幂等调用备份数量始终保持为 1");
}

#[test]
fn test_empty_and_comments_only_files_safe_skip() {
    let test_dir = TempTestDir::new("empty_files");

    // 1. 文件不存在
    let non_existent = test_dir.file_path("not_found.yaml");
    let res = ConfigMigrationManager::ensure_migrated(&non_existent).unwrap();
    assert_eq!(res, MigrationStatus::AlreadyUpToDate);

    // 2. 0 字节空白文件
    let zero_byte = test_dir.file_path("empty.yaml");
    fs::write(&zero_byte, "").unwrap();
    let res = ConfigMigrationManager::ensure_migrated(&zero_byte).unwrap();
    assert_eq!(res, MigrationStatus::AlreadyUpToDate);

    // 3. 仅含空白字符文件
    let whitespace_file = test_dir.file_path("spaces.yaml");
    fs::write(&whitespace_file, "   \n\t  \n  ").unwrap();
    let res = ConfigMigrationManager::ensure_migrated(&whitespace_file).unwrap();
    assert_eq!(res, MigrationStatus::AlreadyUpToDate);

    // 4. 纯注释文件
    let comments_file = test_dir.file_path("comments.yaml");
    fs::write(
        &comments_file,
        "# 这是 models.yaml 配置文件\n# 尚未配置任何模型\n# 纯注释内容",
    )
    .unwrap();
    let res = ConfigMigrationManager::ensure_migrated(&comments_file).unwrap();
    assert_eq!(res, MigrationStatus::AlreadyUpToDate);
}

#[test]
fn test_already_v2_tree_config_no_op() {
    let test_dir = TempTestDir::new("already_v2");
    let config_path = test_dir.file_path("models.yaml");

    let v2_yaml = r#"
version: 2
providers:
  deepseek:
    displayName: "DeepSeek 官方"
    baseUrl: "https://api.deepseek.com"
    protocol: "openai/chat"
    models:
      - id: "deepseek-chat"
        displayName: "DeepSeek V3"
        contextWindow: 65536
        maxOutputTokens: 8192
"#;
    fs::write(&config_path, v2_yaml).unwrap();

    let res = ConfigMigrationManager::ensure_migrated(&config_path).unwrap();
    assert_eq!(res, MigrationStatus::AlreadyUpToDate);

    // 验证未产生任何 .bak 文件
    let backup_exists = fs::read_dir(&test_dir.path)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().contains(".bak."));
    assert!(!backup_exists, "已是 v2 配置绝不应产生任何 .bak 文件");
}

#[test]
fn test_invalid_yaml_syntax_returns_error_and_preserves_file() {
    let test_dir = TempTestDir::new("invalid_yaml");
    let config_path = test_dir.file_path("models.yaml");

    let broken_yaml = "models: [ { id: unclosed_string, ";
    fs::write(&config_path, broken_yaml).unwrap();

    let res = ConfigMigrationManager::ensure_migrated(&config_path);
    assert!(res.is_err(), "语法损坏的 YAML 必须报错拦截");
    match res.unwrap_err() {
        MigrationError::Yaml(_) => {}
        other => panic!("预期返回 Yaml 错误，实际: {:?}", other),
    }

    // 验证原文件未被破坏覆盖
    let content = fs::read_to_string(&config_path).unwrap();
    assert_eq!(content, broken_yaml, "发生语法解析异常时必须 100% 保持原文件不动");
}

#[test]
fn test_zero_model_loss_invariant() {
    let test_dir = TempTestDir::new("zero_loss");
    let config_path = test_dir.file_path("models.yaml");

    let legacy_yaml = r#"
schema_version: 1
models:
  - id: "m1"
    vendor: "v1"
  - id: "m2"
    vendor: "v1"
  - id: "m3"
    vendor: "v2"
"#;
    fs::write(&config_path, legacy_yaml).unwrap();

    let status = ConfigMigrationManager::ensure_migrated(&config_path).unwrap();
    if let MigrationStatus::MigratedSuccessfully { model_count, provider_count, .. } = status {
        assert_eq!(model_count, 3);
        assert_eq!(provider_count, 2);
    } else {
        panic!("预期 MigratedSuccessfully");
    }
}

#[test]
fn test_timestamp_format_and_civil_days_math() {
    let ts = ConfigMigrationManager::current_local_timestamp();
    // 格式应当为 15 字符，如 "20260908_120000"
    assert_eq!(ts.len(), 15);
    let parts: Vec<&str> = ts.split('_').collect();
    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].len(), 8);
    assert_eq!(parts[1].len(), 6);
    assert!(parts[0].chars().all(|c| c.is_ascii_digit()));
    assert!(parts[1].chars().all(|c| c.is_ascii_digit()));

    // 验证 Howard Hinnant 算法对已知公历日的绝对精度
    // 1970-01-01 -> days = 0
    let (y1, m1, d1) = ConfigMigrationManager::civil_from_days(0);
    assert_eq!((y1, m1, d1), (1970, 1, 1));

    // 2000-02-29 (世纪闰年) -> Unix days = 11016
    let (y2, m2, d2) = ConfigMigrationManager::civil_from_days(11016);
    assert_eq!((y2, m2, d2), (2000, 2, 29));

    // 2026-09-08 -> Unix days = 20704
    let (y3, m3, d3) = ConfigMigrationManager::civil_from_days(20704);
    assert_eq!((y3, m3, d3), (2026, 9, 8));
}

#[test]
fn test_protocol_and_compat_inference_for_all_vendors() {
    assert_eq!(
        ConfigMigrationManager::infer_protocol_for_vendor("anthropic"),
        "anthropic/messages"
    );
    assert_eq!(
        ConfigMigrationManager::infer_protocol_for_vendor("claude"),
        "anthropic/messages"
    );
    assert_eq!(
        ConfigMigrationManager::infer_protocol_for_vendor("google"),
        "google/generate-content"
    );
    assert_eq!(
        ConfigMigrationManager::infer_protocol_for_vendor("gemini"),
        "google/generate-content"
    );
    assert_eq!(
        ConfigMigrationManager::infer_protocol_for_vendor("deepseek"),
        "openai/chat"
    );
    assert_eq!(
        ConfigMigrationManager::infer_protocol_for_vendor("qwen"),
        "openai/chat"
    );
    assert_eq!(
        ConfigMigrationManager::infer_protocol_for_vendor("openai"),
        "openai/chat"
    );

    // Compat 方言校验
    let ds_compat = ConfigMigrationManager::infer_compat_for_vendor("deepseek");
    assert_eq!(
        ds_compat.get("thinkingFormat").and_then(|v| v.as_str()),
        Some("deepseek")
    );

    let qwen_compat = ConfigMigrationManager::infer_compat_for_vendor("qwen");
    assert_eq!(
        qwen_compat.get("thinkingFormat").and_then(|v| v.as_str()),
        Some("qwen")
    );

    let oai_compat = ConfigMigrationManager::infer_compat_for_vendor("openai");
    assert_eq!(
        oai_compat.get("supportsDeveloperRole").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        oai_compat.get("maxTokensField").and_then(|v| v.as_str()),
        Some("max_completion_tokens")
    );
}

#[test]
fn test_pricing_and_custom_protocol_retention() {
    let test_dir = TempTestDir::new("pricing_retention");
    let config_path = test_dir.file_path("models.yaml");

    let legacy_yaml = r#"
models:
  - id: "special-model"
    vendor: "custom"
    protocol: "openai/responses"
    pricing:
      currency: "USD"
      input: 5.0
      output: 15.0
      cacheRead: 0.5
      cacheWrite: 3.75
"#;
    fs::write(&config_path, legacy_yaml).unwrap();

    let res = ConfigMigrationManager::ensure_migrated(&config_path).unwrap();
    assert!(matches!(res, MigrationStatus::MigratedSuccessfully { .. }));

    let content = fs::read_to_string(&config_path).unwrap();
    let unified: crate::models::catalog_types::UnifiedModelsConfig =
        serde_yaml::from_str(&content).expect("与 catalog_types 强类型契约无缝对齐");

    let prov = unified.providers.get("custom").expect("custom provider 存在");
    let model = prov.models.first().expect("model 存在");
    assert_eq!(model.id, "special-model");
    assert_eq!(
        model.protocol,
        Some(crate::models::catalog_types::ProtocolKind::OpenAiResponses)
    );
    assert!(model.pricing.is_some(), "pricing 规格定义完整保留");
    let pricing = model.pricing.as_ref().unwrap();
    assert_eq!(pricing.currency, crate::models::catalog_types::CurrencyKind::Usd);
    assert_eq!(pricing.input, 5.0);
    assert_eq!(pricing.output, 15.0);
    assert_eq!(pricing.cache_read, Some(0.5));
    assert_eq!(pricing.cache_write, Some(3.75));
}
