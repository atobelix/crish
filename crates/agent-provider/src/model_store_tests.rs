//! 从真实文件与提交入口验证单轨语义；承接旧配置存储的持久化、隔离及错误资产。

use super::*;
use conex_test_utils::TempWorkspace;

fn store(dir: &TempWorkspace) -> ModelsStore {
    ModelsStore::new(
        dir.path().join("models.yaml"),
        dir.path().join("secrets"),
        None,
    )
}

fn configured() -> UnifiedModelsConfig {
    UnifiedModelsConfig::from_yaml_str(
        r#"
version: 2
activeModel: { providerId: Acme, modelId: 'shared::model' }
providers:
  Acme:
    displayName: '展示名'
    baseUrl: 'https://example.test/v1'
    protocol: openai/chat
    enabled: true
    order: 0
    proxyUrl: 'http://localhost:8181'
    headers: { X-Test: value }
    compat: { supportsDeveloperRole: false }
    models:
      - id: 'shared::model'
        displayName: 模型
        enabled: true
        order: 0
        contextWindow: 100000
        maxOutputTokens: 1000
        supportsTools: false
        cacheTtl: 5m
        modalities: { input: [text, image], output: [text] }
        thinking: { Off: off, High: high }
        pricing:
          currency: USD
          unit: per_1m_tokens
          input: 0
          output: 2
          cacheRead: 0.1
          cacheWrite: 0
          perImage: 0.01
          tiers: [{ inputTokensAbove: 5000, input: 1, cacheWrite: 0 }]
  acme:
    baseUrl: 'https://other.test/v1'
    protocol: openai/responses
    models: [{ id: 'shared::model' }]
"#,
    )
    .unwrap()
}

#[test]
fn load_missing_config_file_yields_empty_unselected_tree() {
    let dir = TempWorkspace::new("model-store-empty");
    let store = store(&dir);
    let snapshot = store.read().unwrap();
    let tree = snapshot.tree.unwrap();
    assert!(tree.providers.is_empty());
    assert!(tree.active_model.is_none());
    assert!(snapshot.content.contains("activeModel: null"));
    assert_eq!(
        snapshot.revision,
        content_revision(Some(&fs::read_to_string(store.path()).unwrap()))
    );
}

#[test]
fn save_then_reload_preserves_every_config_field() {
    let dir = TempWorkspace::new("model-store-roundtrip");
    let store = store(&dir);
    let base = store.read().unwrap();
    let tree = configured();
    let saved = store.apply(tree.clone(), &base.revision).unwrap();
    let loaded = ModelsStore::new(store.path().into(), dir.path().join("secrets"), None)
        .read()
        .unwrap();
    assert_eq!(loaded.tree, Some(tree));
    assert_eq!(saved.revision, loaded.revision);
    assert_eq!(
        serde_json::to_value(saved).unwrap()["tree"],
        serde_json::to_value(loaded).unwrap()["tree"]
    );
}

#[test]
fn display_name_change_does_not_rebuild_pricing_or_capabilities() {
    let dir = TempWorkspace::new("model-store-edit");
    let store = store(&dir);
    let base = store.read().unwrap();
    let initial = configured();
    let first = store.apply(initial.clone(), &base.revision).unwrap();
    let mut edited = first.tree.unwrap();
    edited.providers["Acme"].display_name = Some("新名称".into());
    let saved = store.apply(edited, &first.revision).unwrap().tree.unwrap();
    assert_eq!(
        saved.providers["Acme"].models,
        initial.providers["Acme"].models
    );
    assert_eq!(
        saved.providers["Acme"].proxy_url,
        initial.providers["Acme"].proxy_url
    );
}

#[test]
fn stale_window_cannot_overwrite_a_newer_commit() {
    let dir = TempWorkspace::new("model-store-cas");
    let first = store(&dir);
    let second = store(&dir);
    let base = first.read().unwrap();
    second.read().unwrap();
    let accepted = first.apply(configured(), &base.revision).unwrap();
    let error = second
        .apply(UnifiedModelsConfig::default(), &base.revision)
        .unwrap_err();
    assert_eq!(error.code, "REVISION_CONFLICT");
    assert_eq!(
        error.current_revision.as_deref(),
        Some(accepted.revision.as_str())
    );
    assert_eq!(fs::read_to_string(first.path()).unwrap(), accepted.content);
}

#[test]
fn external_raw_change_is_part_of_revision() {
    let dir = TempWorkspace::new("model-store-external");
    let store = store(&dir);
    let base = store.read().unwrap();
    let external = format!("# external edit\n{}", base.content);
    fs::write(store.path(), &external).unwrap();
    assert_eq!(
        store.apply(configured(), &base.revision).unwrap_err().code,
        "REVISION_CONFLICT"
    );
    assert_eq!(fs::read_to_string(store.path()).unwrap(), external);
}

#[test]
fn concurrent_stores_have_one_successful_cas_writer() {
    let dir = TempWorkspace::new("model-store-concurrent");
    let base = store(&dir).read().unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let handles: Vec<_> = (0..2)
        .map(|index| {
            let store = store(&dir);
            let revision = base.revision.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut tree = configured();
                tree.providers["Acme"].display_name = Some(format!("writer-{index}"));
                barrier.wait();
                store.apply(tree, &revision)
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result
                .as_ref()
                .is_err_and(|error| error.code == "REVISION_CONFLICT"))
            .count(),
        1
    );
}

#[test]
fn invalid_yaml_does_not_change_disk_or_committed_tree() {
    let dir = TempWorkspace::new("model-store-invalid");
    let store = store(&dir);
    let base = store.read().unwrap();
    let saved = store.apply(configured(), &base.revision).unwrap();
    assert!(store
        .save_yaml("providers: [broken", &saved.revision)
        .is_err());
    assert_eq!(fs::read_to_string(store.path()).unwrap(), saved.content);
    assert_eq!(store.committed().unwrap().tree, saved.tree.unwrap());
}

#[test]
fn external_invalid_yaml_blocks_new_requests_and_keeps_original() {
    let dir = TempWorkspace::new("model-store-invalid-external");
    let store = store(&dir);
    store.read().unwrap();
    fs::write(store.path(), "providers: [broken").unwrap();
    let read = store.read().unwrap();
    assert!(read.tree.is_none());
    assert!(read.parse_error.is_some());
    assert!(store.committed().is_err());
    assert_eq!(
        fs::read_to_string(store.path()).unwrap(),
        "providers: [broken"
    );
}

#[test]
fn unknown_fields_and_conflicting_aliases_are_not_dropped() {
    let dir = TempWorkspace::new("model-store-fields");
    let store = store(&dir);
    for content in ["version: 2\nproviders: {}\nfuture: 1\n", "version: 2\nproviders:\n  a:\n    models:\n      - id: x\n        contextWindow: 10\n        contextLength: 20\n"] {
        fs::write(store.path(), content).unwrap();
        assert!(store.read().unwrap().parse_error.is_some());
        assert_eq!(fs::read_to_string(store.path()).unwrap(), content);
    }
}

#[test]
fn old_aliases_are_imported_once_then_physically_removed() {
    let dir = TempWorkspace::new("model-store-import");
    let store = store(&dir);
    fs::write(store.path(), "version: 2\nproviders:\n  a:\n    models:\n      - model: x\n        contextLength: 99\n        pricing: {currency: USD, inputPerMTok: 0}\n").unwrap();
    let first = store.read().unwrap();
    assert!(first.parse_error.is_none());
    assert!(!first.content.contains("contextLength"));
    assert!(!first.content.contains("inputPerMTok"));
    assert_eq!(
        first.tree.unwrap().providers["a"].models[0].context_window,
        Some(99)
    );
    assert_eq!(store.read().unwrap().revision, first.revision);
}

#[test]
fn disabling_selection_clears_it_in_same_commit() {
    let dir = TempWorkspace::new("model-store-disable");
    let store = store(&dir);
    let base = store.read().unwrap();
    let mut tree = configured();
    tree.providers["Acme"].enabled = false;
    let snapshot = store.apply(tree, &base.revision).unwrap();
    assert!(snapshot.tree.unwrap().active_model.is_none());
    assert!(snapshot.content.contains("activeModel: null"));
    assert!(store.resolve_active().unwrap().is_none());
}

#[test]
fn api_key_ref_with_invalid_chars_errors_before_write() {
    let dir = TempWorkspace::new("model-store-path");
    let store = store(&dir);
    let base = store.read().unwrap();
    let mut tree = configured();
    tree.providers["Acme"].api_key_ref = Some("dpapi:../other".into());
    assert!(store.apply(tree, &base.revision).is_err());
    assert_eq!(fs::read_to_string(store.path()).unwrap(), base.content);
}

#[test]
fn no_implicit_global_env_or_provider_config_can_fill_missing_fields() {
    let dir = TempWorkspace::new("model-store-no-fallback");
    let store = store(&dir);
    let base = store.read().unwrap();
    let tree = configured();
    fs::write(
        dir.path().join("provider-config.json"),
        r#"{"baseUrl":"https://legacy.test","model":"other"}"#,
    )
    .unwrap();
    store.apply(tree, &base.revision).unwrap();
    assert_eq!(
        store.resolve_active().unwrap_err().code,
        "CREDENTIAL_MISSING"
    );
    assert_eq!(
        store
            .resolve_model(&ModelRef::new("missing", "shared::model"))
            .unwrap_err()
            .code,
        "PROVIDER_UNAVAILABLE"
    );
}

#[cfg(windows)]
#[test]
fn per_provider_secrets_do_not_overwrite_and_clear_independently() {
    let dir = TempWorkspace::new("model-store-secrets");
    let store = store(&dir);
    let initial = store.read().unwrap();
    let base = store.apply(configured(), &initial.revision).unwrap();
    let first = store
        .set_credential(
            "Acme",
            SecretString::new("private-A".into()),
            &base.revision,
        )
        .unwrap();
    let second = store
        .set_credential(
            "acme",
            SecretString::new("private-B".into()),
            &first.revision,
        )
        .unwrap();
    let tree = second.tree.as_ref().unwrap();
    assert_ne!(
        tree.providers["Acme"].api_key_ref,
        tree.providers["acme"].api_key_ref
    );
    let wire = serde_json::to_string(&second).unwrap();
    assert!(!wire.contains("private-A") && !wire.contains("private-B"));
    assert_eq!(
        store
            .resolve_model(&ModelRef::new("Acme", "shared::model"))
            .unwrap()
            .api_key
            .as_str(),
        "private-A"
    );
    let cleared = store.clear_credential("Acme", &second.revision).unwrap();
    assert!(cleared.tree.unwrap().active_model.is_none());
    assert_eq!(store.provider_key("acme").unwrap().as_str(), "private-B");
    assert!(store.provider_key("Acme").is_err());
    assert!(!dir.path().join("provider-direct-key.dpapi").exists());
}

#[cfg(windows)]
#[test]
fn request_retains_original_secret_and_revision_after_rotation() {
    let dir = TempWorkspace::new("model-store-pinned");
    let store = store(&dir);
    let first = store.read().unwrap();
    let second = store.apply(configured(), &first.revision).unwrap();
    let third = store
        .set_credential(
            "Acme",
            SecretString::new("original".into()),
            &second.revision,
        )
        .unwrap();
    let pinned = store.resolve_active().unwrap().unwrap();
    let fourth = store
        .set_credential(
            "Acme",
            SecretString::new("replacement".into()),
            &third.revision,
        )
        .unwrap();
    assert_eq!(pinned.api_key.as_str(), "original");
    assert_eq!(pinned.revision, third.revision);
    assert_eq!(
        store.resolve_active().unwrap().unwrap().revision,
        fourth.revision
    );
}

#[cfg(windows)]
#[test]
fn inline_key_import_is_canonical_and_secret_free() {
    let dir = TempWorkspace::new("model-store-inline");
    let store = store(&dir);
    fs::write(
        store.path(),
        "version: 2\nproviders:\n  Acme:\n    apiKey: private-inline-secret\n    models: []\n",
    )
    .unwrap();
    let snapshot = store.read().unwrap();
    assert!(snapshot.parse_error.is_none());
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("private-inline-secret"));
    assert!(snapshot.content.contains("apiKeyRef: dpapi:"));
    assert_eq!(
        store.provider_key("Acme").unwrap().as_str(),
        "private-inline-secret"
    );
}

#[test]
fn failed_secret_import_preserves_file_without_returning_plaintext() {
    let dir = TempWorkspace::new("model-store-inline-failure");
    fs::write(dir.path().join("blocked"), "block").unwrap();
    let store = ModelsStore::new(
        dir.path().join("models.yaml"),
        dir.path().join("blocked/secret"),
        None,
    );
    let raw =
        "version: 2\nproviders:\n  Acme:\n    apiKey: private-must-remain-local\n    models: []\n";
    fs::write(store.path(), raw).unwrap();
    let snapshot = store.read().unwrap();
    assert!(snapshot.parse_error.is_some());
    assert!(snapshot.content.is_empty());
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("private-must-remain-local"));
    assert_eq!(fs::read_to_string(store.path()).unwrap(), raw);
}

#[test]
fn legacy_single_object_requires_identity_instead_of_default_provider() {
    let dir = TempWorkspace::new("model-store-old-global");
    fs::write(
        dir.path().join("provider-config.json"),
        r#"{"baseUrl":"https://old.test","model":"m"}"#,
    )
    .unwrap();
    let store = ModelsStore::new(
        dir.path().join("models.yaml"),
        dir.path().join("secrets"),
        Some(dir.path().clone()),
    );
    assert_eq!(
        store.read().unwrap_err().code,
        "MIGRATION_IDENTITY_REQUIRED"
    );
    assert!(!store.path().exists());
}

#[test]
fn explicit_null_selection_never_imports_old_active_pointer() {
    let dir = TempWorkspace::new("model-store-old-active");
    fs::write(
        dir.path().join("profile-config.json"),
        r#"{"activeProfileId":"Acme","profiles":{"Acme":{"model":"shared::model"}}}"#,
    )
    .unwrap();
    let mut tree = configured();
    tree.active_model = None;
    fs::write(
        dir.path().join("models.yaml"),
        serde_yaml::to_string(&tree).unwrap(),
    )
    .unwrap();
    let store = ModelsStore::new(
        dir.path().join("models.yaml"),
        dir.path().join("secrets"),
        Some(dir.path().clone()),
    );
    assert!(store.read().unwrap().tree.unwrap().active_model.is_none());
}

#[test]
#[allow(clippy::disallowed_methods)]
fn deleted_yaml_after_migration_never_resurrects_legacy_profile() {
    let dir = TempWorkspace::new("model-store-no-resurrection");
    fs::write(dir.path().join("profile-config.json"), r#"{"activeProfileId":"old","profiles":{"old":{"model":"old-model","baseUrl":"https://old.test"}}}"#).unwrap();
    let store = ModelsStore::new(
        dir.path().join("models.yaml"),
        dir.path().join("secrets"),
        Some(dir.path().clone()),
    );
    let imported = store.read().unwrap();
    assert!(imported.tree.unwrap().providers.contains_key("old"));
    fs::remove_file(store.path()).unwrap();
    let fresh = ModelsStore::new(
        store.path().into(),
        dir.path().join("secrets"),
        Some(dir.path().clone()),
    );
    let empty = fresh.read().unwrap().tree.unwrap();
    assert!(empty.providers.is_empty());
    assert!(empty.active_model.is_none());
}

#[test]
fn io_failure_invalidates_previously_committed_snapshot() {
    let dir = TempWorkspace::new("model-store-io-state");
    let store = store(&dir);
    store.read().unwrap();
    fs::rename(store.path(), dir.path().join("preserved.yaml")).unwrap();
    fs::create_dir(store.path()).unwrap();
    assert!(store.read().is_err());
    assert_eq!(store.committed().unwrap_err().code, "CONFIG_IO");
}

#[test]
fn canonical_reads_do_not_accept_new_legacy_fields_after_import_completed() {
    let dir = TempWorkspace::new("model-store-canonical-only");
    let store = store(&dir);
    store.read().unwrap();
    let old = "version: 2\nproviders:\n  a:\n    models: [{id: m, contextLength: 10}]\n";
    fs::write(store.path(), old).unwrap();
    assert!(store.read().unwrap().parse_error.is_some());
    assert_eq!(fs::read_to_string(store.path()).unwrap(), old);
}
