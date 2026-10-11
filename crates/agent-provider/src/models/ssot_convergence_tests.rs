//! 单轨收敛（SSOT）不变量测试。
//!
//! 战役：`docs/provider-single-track-convergence/`（阶段 4：运行期修订一致性）。
//!
//! 本文件钉死四条跨文件不变量，全部对应**已实证的真实缺陷**，不是泛化断言：
//!
//! 1. **出厂字典 ≠ 用户声明**：`ModelCatalog::bundled()`（`catalog.json`
//!    编译期打包）是出厂只读数据；用户树为空时投影必须为空——禁止把出厂
//!    条目冒充成用户已配置的模型（否则「模型列表」会显示用户从未配过的模型）。
//! 2. **缓存 TTL 单一来源**：唯一决议函数 `cache_ttl_for_declared_model`，
//!    未声明 / 未收录 / 值域非法一律 `None` = **不追踪缓存**（fail-closed）。
//!    旧实现有三级回落（live 树 → 内置 `catalog.json` → `ttl.rs` vendor 默认表），
//!    已按 `docs/model-config-ssot-convergence/00-总方案.md:307-308` 物理删除。
//! 3. **模型身份 = `(providerId, modelId)` 二元组**：同一 `modelId` 在不同
//!    provider 下必须命中各自条目（`ornith` 同时存在于 `ollama` 与自建网关，
//!    旧实现按裸 id 匹配会串价 / 串能力）。
//! 4. **运行期快照无独立读盘路径**：`LiveModels` 只能由已提交树 / yaml 字符串
//!    派生；`load_user()` 那条绕过 `ModelsStore` 的读盘路径已物理删除
//!    （它是「修订撕裂」的第二读面）。

use crate::models::{
    cache_ttl_for_declared_model, CacheTtl, LiveModels, ModelCatalog, UnifiedModelsConfig,
};

fn catalog_from_yaml(yaml: &str) -> ModelCatalog {
    ModelCatalog::from_yaml_str(yaml).expect("夹具 yaml 必须能投影为目录")
}

/// 不变量 1：出厂字典不得冒充用户声明。
#[test]
fn bundled_dictionary_is_not_user_declaration() {
    let bundled = ModelCatalog::bundled();
    assert!(
        bundled.iter_entries().count() > 100,
        "出厂能力字典应含大量条目（编译期打包的 catalog.json），实际 {}",
        bundled.iter_entries().count()
    );

    let empty_tree =
        UnifiedModelsConfig::from_yaml_str("version: 2\nproviders: {}\n").expect("空树必须可解析");
    let projected = ModelCatalog::from_unified(&empty_tree).expect("空树必须可投影");
    assert_eq!(
        projected.iter_entries().count(),
        0,
        "用户树为空时投影必须为空——出厂字典条目不得出现在用户声明面"
    );
}

/// 不变量 2a：只有用户声明 `cacheTtl` 才产生 TTL。
#[test]
fn declared_ttl_is_honored_and_absent_ttl_is_fail_closed() {
    let declared = catalog_from_yaml(
        "version: 2\nproviders:\n  acme:\n    models:\n    - id: acme-a\n      cacheTtl: 1h\n",
    );
    assert_eq!(
        cache_ttl_for_declared_model(&declared, "acme", "acme-a"),
        Some(CacheTtl::Hour)
    );

    let undeclared =
        catalog_from_yaml("version: 2\nproviders:\n  acme:\n    models:\n    - id: acme-a\n");
    assert_eq!(
        cache_ttl_for_declared_model(&undeclared, "acme", "acme-a"),
        None,
        "未声明 cacheTtl 必须不追踪缓存（fail-closed），禁止凭空推断"
    );

    assert_eq!(
        cache_ttl_for_declared_model(&undeclared, "acme", "never-configured"),
        None,
        "未收录模型必须返回 None"
    );

    // 值域外的 cacheTtl 在**解析边界**就被显式拒绝（fail-closed 的第一道闸），
    // 不会以「静默忽略」的形式进入已提交树。
    let illegal = ModelCatalog::from_yaml_str(
        "version: 2\nproviders:\n  acme:\n    models:\n    - id: acme-a\n      cacheTtl: 7h\n",
    );
    let err = illegal.expect_err("值域外 cacheTtl 必须在解析期被拒绝");
    assert!(
        err.contains("cacheTtl"),
        "拒绝信息必须指名 cacheTtl，便于用户定位：{err}"
    );
}

/// 不变量 2b：出厂字典里的 `cacheTtl` 声明不得成为用户 TTL 的兜底。
///
/// 这是对「三级回落」被删除的**反向**断言：即使出厂字典的某个模型带了
/// `cacheTtl`，只要用户树没声明，决议就必须是 `None`。
#[test]
fn bundled_ttl_never_leaks_into_user_resolution() {
    let bundled = ModelCatalog::bundled();
    let total = bundled.iter_entries().count();
    let with_ttl: Vec<(String, String)> = bundled
        .iter_entries()
        .filter(|(_, entry)| entry.cache_ttl.is_some())
        .map(|(_, entry)| (entry.provider.clone(), entry.model.clone()))
        .collect();

    // 出厂字典确实含 cacheTtl 声明（否则本测试无意义，属夹具失效而非通过）。
    assert!(
        !with_ttl.is_empty(),
        "出厂字典应含至少一条 cacheTtl 声明；实际条目 {total} 条"
    );

    // 用户树只声明「供应商存在」，不含任何 cacheTtl。
    for (vendor, model) in with_ttl.iter().take(8) {
        let user_yaml =
            format!("version: 2\nproviders:\n  {vendor}:\n    models:\n    - id: {model}\n");
        let user_catalog = catalog_from_yaml(&user_yaml);
        assert_eq!(
            cache_ttl_for_declared_model(&user_catalog, vendor, model),
            None,
            "出厂字典的 cacheTtl 不得兜底成用户 TTL（{vendor}::{model}）"
        );
    }
}
/// 不变量 3：模型身份是二元组，同一 `modelId` 在不同 provider 下互不串。
#[test]
fn model_identity_is_provider_and_model_pair() {
    let catalog = catalog_from_yaml(
        "version: 2\nproviders:\n  \
         alpha:\n    models:\n    - id: shared-model\n      contextWindow: 1000\n      \
         pricing:\n        currency: CNY\n        input: 1.0\n        output: 2.0\n  \
         beta:\n    models:\n    - id: shared-model\n      contextWindow: 2000\n      \
         pricing:\n        currency: USD\n        input: 9.0\n        output: 18.0\n",
    );

    let alpha = catalog.lookup("alpha", "shared-model").expect("alpha 条目");
    let beta = catalog.lookup("beta", "shared-model").expect("beta 条目");

    assert_eq!(alpha.context_window, Some(1000));
    assert_eq!(beta.context_window, Some(2000));
    assert_ne!(
        alpha.context_window, beta.context_window,
        "同名模型跨 provider 必须各自独立，不得互相污染"
    );
    assert_eq!(catalog.currency_for("alpha", "shared-model"), Some("CNY"));
    assert_eq!(catalog.currency_for("beta", "shared-model"), Some("USD"));

    // 不存在的 provider 必须落空，而不是回落到「任意同名条目」。
    assert!(catalog.lookup("gamma", "shared-model").is_none());
}

/// 不变量 3 补充：出厂字典内 `model id` 是**唯一键**（前端按 id 查表的前提）。
///
/// 前端 `pricingResolver` / `toCatalogCacheSnapshot` 按 `model id` 索引出厂字典
/// （配置树的 `providerId` 与字典厂商是两个命名空间，无法直接作二元组查找）。
/// 该做法**只在不变量成立时**才不含猜测：若同一 id 在多个厂商下出现且价格不一致，
/// 按 id 查表就会任选一个 ⇒ 必须在此钉死，不成立时本条变红而不是静默出错。
#[test]
fn dictionary_model_ids_are_unique_keys() {
    let bundled = ModelCatalog::bundled();
    let mut by_id: std::collections::BTreeMap<String, Vec<(String, Option<f64>, Option<f64>)>> =
        std::collections::BTreeMap::new();
    for (_, entry) in bundled.iter_entries() {
        by_id.entry(entry.model.clone()).or_default().push((
            entry.vendor.clone(),
            entry.input_price,
            entry.output_price,
        ));
    }

    assert!(
        by_id.len() > 100,
        "出厂字典条目过少（{}），夹具失效",
        by_id.len()
    );

    let conflicting: Vec<String> = by_id
        .iter()
        .filter(|(_, rows)| {
            let first = rows.first().map(|r| (r.1, r.2));
            rows.iter().any(|r| Some((r.1, r.2)) != first)
        })
        .map(|(id, _)| id.clone())
        .collect();

    assert!(
        conflicting.is_empty(),
        "出厂字典出现同 id 不同价的条目（{conflicting:?}）：按 id 查表会任选一个，\
         必须改为按 (厂商, id) 查找或修数据"
    );
}

/// 不变量 4：运行期快照无独立读盘路径（源码形状断言）。
///
/// 两条路径曾造成「修订撕裂」与「第二读面」，必须保持物理删除状态：
/// - `ModelCatalog::load_user()` / `load_user_catalog*`（绕过 `ModelsStore` 读盘）；
/// - `ttl.rs` 的 `vendor_default_ttl`（厂商默认 TTL 兜底表）。
#[test]
fn runtime_snapshot_has_no_independent_disk_read_path() {
    let catalog_src = include_str!("catalog.rs");
    for forbidden in [
        "fn load_user",
        "load_user_catalog",
        "load_user_catalog_or_default",
        "PathBuf",
        "std::fs",
    ] {
        assert!(
            !catalog_src.contains(forbidden),
            "catalog.rs 不得再出现 `{forbidden}`：运行期快照必须由已提交树派生（单一读口）"
        );
    }

    let ttl_src = include_str!("ttl.rs");
    // 用「定义形态」判定，避免把说明「该表已删除」的注释本身当成残留。
    assert!(
        !ttl_src.contains("fn vendor_default_ttl"),
        "ttl.rs 的 vendor 默认表必须保持物理删除（无声明即不追踪缓存）"
    );
    assert!(
        !ttl_src.contains("fn cache_ttl_for_provider_model"),
        "旧三级回落签名 cache_ttl_for_provider_model(Option<&ModelCatalog>, VendorId, &str) 不得回归"
    );

    // 唯一决议函数仍在，且签名为 (目录投影, providerId, modelId)。
    assert!(
        ttl_src.contains("pub fn cache_ttl_for_declared_model"),
        "TTL 唯一决议函数必须存在"
    );
}

/// 不变量 4 补充：`LiveModels` 只能由已提交树 / yaml 派生，且失败态显式可辨。
#[test]
fn live_models_derive_from_tree_and_keep_failure_distinguishable() {
    let live = LiveModels::from_yaml_str("version: 2\nproviders: {}\n").expect("空树可派生");
    assert!(
        live.parse_error.is_none(),
        "合法空树是「诚实空树」，不得被当作解析失败"
    );

    let failed = LiveModels::parse_failed("boom");
    assert_eq!(
        failed.parse_error.as_deref(),
        Some("boom"),
        "解析失败必须与空树显式可辨（fail-closed 观测面）"
    );

    let tree = UnifiedModelsConfig::from_yaml_str(
        "version: 2\nproviders:\n  acme:\n    models:\n    - id: acme-a\n",
    )
    .expect("树可解析");
    let from_tree = ModelCatalog::from_unified(&tree).expect("树可投影");
    assert!(
        from_tree.lookup("acme", "acme-a").is_some(),
        "从已提交树投影必须保留用户声明"
    );
}
