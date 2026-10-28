//! 统一配置单轨测试夹具（壳层域）
//!
//! 壳层测试（probe / engine_tests 等）操作**壳层 ModelsStore 单例**
//! （`config::install_models_store_for_test` / `reset_config_stores_for_test`
//! 测试钩子），并经 [inject_shell_config_source] 把同一单例接到 conex-run
//! 的 `CommittedConfigSource` 注入槽（生产等价：EngineHost::new 注入
//! ShellConfigSource）；`conex-run` crate 内测试使用自己的注入式替身
//! （`conex_run::engine_provider::set_committed_config_source`）。键名契约
//! 一致：TEST_ENV_KEY / TEST_PROFILE_*。
//!
//! 纪律（自 crate 侧夹具沿袭）：`config_profile_apply` / `config_update` 会
//! 写 store 静态存储；命令级测试必须①并行串行化（CONFIG_TEST_LOCK）、
//! ②重置静态到独立临时目录（禁止触碰真实用户配置）。

/// 配置域测试串行锁（set_var / store 重置非并发安全）
pub(crate) static CONFIG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 单轨测试凭据环境变量名（key 经 set_var/remove_var 注入）
pub(crate) const TEST_ENV_KEY: &str = "CONEX_TEST_WIZARD_KEY";

/// 写统一树 YAML 到 dir/models.yaml，读入提交，安装为生效 store。
pub(crate) fn install_yaml_store(
    dir: &std::path::Path,
    yaml: &str,
) -> std::sync::Arc<agent_provider::model_store::ModelsStore> {
    let config_path = dir.join("models.yaml");
    std::fs::write(&config_path, yaml).expect("write models.yaml");
    let store = std::sync::Arc::new(agent_provider::model_store::ModelsStore::new(
        config_path,
        dir.join("secrets"),
        None,
    ));
    store.read().expect("load unified models tree");
    crate::config::install_models_store_for_test(std::sync::Arc::clone(&store));
    inject_shell_config_source();
    store
}

/// 在已提交统一树上以新修订重应用 YAML（CAS：expected = 当前提交修订）。
pub(crate) fn apply_unified_yaml(store: &agent_provider::model_store::ModelsStore, yaml: &str) {
    let revision = store
        .committed()
        .expect("unified tree 必须已提交")
        .revision
        .clone();
    store
        .save_yaml(yaml, &revision)
        .expect("apply unified tree");
}

/// 单 provider(p1) 统一树 YAML：active=(p1, active_model)，含 model-a/model-b
/// 候选，apiKeyRef=env:<env_key>。
fn unified_tree_yaml(base_url: &str, active_model: &str, env_key: &str) -> String {
    format!(
        "version: 2\n\
         activeModel:\n  providerId: p1\n  modelId: {active_model}\n\
         providers:\n  p1:\n    displayName: P1\n    baseUrl: {base_url}\n    protocol: openai/chat\n    apiKeyRef: env:{env_key}\n    models:\n      - id: model-a\n        enabled: true\n      - id: model-b\n        enabled: true\n"
    )
}

/// 安装单 provider 初始树（provider=p1，base_url，active=model-a，key 经
/// `TEST_ENV_KEY` 注入为 "sk-a"）。返回已安装 store。
pub(crate) fn install_tree_models_store(
    dir: &std::path::Path,
    base_url: &str,
) -> std::sync::Arc<agent_provider::model_store::ModelsStore> {
    std::env::set_var(TEST_ENV_KEY, "sk-a");
    install_yaml_store(dir, &unified_tree_yaml(base_url, "model-a", TEST_ENV_KEY))
}

/// 单 provider 树上切换 base_url/model（provider=p1 不变；key 由调用方经
/// set_var 切换）。
pub(crate) fn apply_single_provider(
    store: &agent_provider::model_store::ModelsStore,
    base_url: &str,
    model: &str,
) {
    apply_unified_yaml(store, &unified_tree_yaml(base_url, model, TEST_ENV_KEY));
}

/// 把静态 config store 重置并隔离到 `dir`（调用方必须持
/// [CONFIG_TEST_LOCK]）。写入永不落到真实用户配置。
pub(crate) fn isolate_config_store(dir: &std::path::Path) {
    std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", dir);
    crate::config::reset_config_stores_for_test();
    let store = std::sync::Arc::new(agent_provider::model_store::ModelsStore::new(
        dir.join("models.yaml"),
        dir.join("secrets"),
        None,
    ));
    store.read().expect("isolate config store read");
    crate::config::install_models_store_for_test(store);
    inject_shell_config_source();
}

/// 向 conex-run 注入壳层配置源（生产语义等价：EngineHost::new 在装配时
/// 注入同一 [crate::engine::engine_build::ShellConfigSource]）。直接构造
/// `EngineHandle` 的壳层测试必须经此接线，否则 crate 侧配置源槽为空、
/// 引擎恒降级未就绪。
pub(crate) fn inject_shell_config_source() {
    conex_run::engine_provider::set_committed_config_source(std::sync::Arc::new(
        crate::engine::engine_build::ShellConfigSource,
    ));
}
