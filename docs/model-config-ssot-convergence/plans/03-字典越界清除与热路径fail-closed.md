# W3 字典越界清除与热路径 fail-closed

> **维度**：W3（依赖 W1）
> **上游**：`00-总方案.md` §0 U3、§2.4、§2.5、§3 INV-5/INV-6、§5 N3/N7
> **本维使命**：让模型字典（D1 预填库 / D2 内置目录 / D3 代码内 TTL 表）**只保留「用户新增模型时填充草稿」这一条出口**，其余全部物理切除；热路径 lookup Miss 一律 fail-closed。
> **本维不改**：模型身份（W1）；活动选择（W2）。

---

## 1. 问题（本维负责的条目）

| # | 问题 | 证据 |
| --- | --- | --- |
| 9 | 缓存 TTL 热路径回落 `bundled_catalog` | `apps/agent-workbench/src-tauri/src/engine_build.rs:977-994` |
| 10 | vendor 默认 TTL 表硬编码在代码 | `crates/agent-provider/src/models/ttl.rs:62-117` |
| 11 | `catalog_get` state = `ModelCatalog::bundled()` | `apps/agent-workbench/src-tauri/src/main.rs:993-995`；`catalog_commands.rs:42-50` |
| 12 | `catalog_refresh` 把扫描结果写回字典（反向污染） | `catalog_commands.rs:57-71` |
| 13 | 前端 `bootstrap-full` 启动灌入字典 | `apps/crish-desktop/src/bootstrap-full.ts:18-24` |
| 14 | `pricingStore` 缓存价把字典排在用户之前 | `apps/crish-desktop/src/api/pricingStore.ts:157-194` |
| 15 | `getModelMeta` 回落 `guessContextLength` | `apps/crish-desktop/src/api/modelCatalogMeta.ts:163,170` |
| 16 | `thinkingGear` D2 档位 + D6 正则兜底 | `apps/crish-desktop/src/api/thinkingGear.ts:153-177` |
| — | `lookup_by_model_id`（W1 已删，本维不重复） | — |

---

## 2. 目标态

### 2.1 字典的合法出口（唯一）

**D1 预填库**（`modelsAutofillBaseline.ts`）保留的唯一消费路径：

| 位置 | 状态 | 裁决 |
| --- | --- | --- |
| `manualAddAutofill.ts:11-96` `calculateAutofillDraft` | 生产可达，`live?.x ?? autofill?.x ?? prev.x` | **✅ 保留**（合规 A：live 优先，用户可改） |
| `modelsCatalogActions.ts:97-111` `addModel` | `{ ...baseModel, ...modelInput, id }`，用户值整体覆盖 | **✅ 保留** |
| `probeIncremental.ts:76-92` | 仅对 `newlyDiscoveredIds` 用 D1 补全 | **✅ 保留** |
| `ModelThinkingEditor.tsx:6-12` `STANDARD_THINKING_PRESET` | UI 行模板，用户可增删改 | **✅ 保留** |

**其余全部 D1 读取路径 → 物理删除。**

### 2.2 缓存 TTL 决策（修复问题 9/10）

**目标**：`build_cache_tracking_config`（`engine_build.rs:969-1003`）**删除第 2、3 级回落**：

```rust
// 目标态：只有一级
fn build_cache_tracking_config(...) -> Option<CacheTrackingConfig> {
    let live = live_catalog();
    let entry = live.catalog.lookup(vendor_str, &config.model)?;   // Miss → None（fail-closed）
    let ttl = entry.cache_ttl.as_deref().and_then(CacheTtl::parse)?; // 无 cacheTtl → None
    Some(CacheTrackingConfig { ttl, ... })
}
```

- **删除** `bundled_catalog().lookup(...)` 分支（`:984`）。
- **删除** `cache_ttl_for_provider_model(None, vendor_id_from_live_slot(vendor_str), &config.model)` 回落（`:994`）。
- **物理删除** `ttl.rs` 的 `vendor_default_ttl` / `openai_default_ttl` / `is_openai_extended_retention`（`:62-117`）——**若 `CacheTtl::parse` 等仍需保留，只删 vendor 默认表部分**。
- `engine_build.rs:816-819` 的 `#[allow(dead_code)]` 一并移除（其生产调用点 `run/run_core.rs:1400`、`run/run_launch.rs:847` 已确认存在，标注属误留）。

**语义变更（必须记录）**：yaml 未声明 `cacheTtl` 的模型 → **不追踪缓存**。这是 U3 的直接推论：字典不得替用户决定 TTL。

### 2.3 `catalog_get` 通道（修复问题 11/12/13，N3）

**裁决**：`catalog_get` 是 D2 下发给前端的**唯一通道**，且其 state **不是 yaml 投影**。分两步：

**步骤 1（本维）**：确认其下游消费者。
- 前序勘察已确认：`pricingStore` / `thinkingGear` 的消费 API **当前零 UI 调用**。
- 若确认零消费者 → **物理删除** `catalog_get` / `catalog_refresh` 命令 + 其清单登记（`commandManifest.ts` / `command_manifest.rs` / `main.rs` 三处同步）+ `main.rs:993-995` 的 `app.manage(...)` + `catalog_commands.rs` + `bootstrap-full.ts:18-24` 的调用。
- 若存在合法消费者 → 该命令**必须改为返回 yaml 投影**（`live_catalog()`），**禁止**返回 `ModelCatalog::bundled()`。

**步骤 2**：`catalog_refresh`（`:57-71`）把前端扫描结果 `upsert_from_scan` 写回 D2 state —— 这是**反向污染字典**。若命令保留，写入目标必须改为 yaml（经 `workbench_save_models_yaml`），**禁止**写 D2 state。

### 2.4 前端字典兜底清除（修复问题 14/15/16）

| 位置 | 裁决 |
| --- | --- |
| `pricingStore.ts:157-194` `resolve4dPrices` 缓存价快照优先于用户 | **物理删除该函数及其族**（`resolve4dPrices` / `resolve4dPricesForTokens` / `estimateCostUsd4d` / `estimateSavingsUsd`），因**零生产消费者**。若保留，缓存价必须改为**用户优先**（与输入/输出价一致）。 |
| `pricingResolver.ts:42` `CATALOG_CACHE_RATES`（D4） | 同上：随 `resolve4dPrices` 一并删除，或改为仅在添加表单预填时读。 |
| `pricingTypes.ts:177-186` `DEFAULT_PRICES`（D5） | 若 `resolve4dPrices` 删除则一并删除。 |
| `modelCatalogMeta.ts:155-172` `getModelMeta` 的 `contextLength ?? guessContextLength(model)` | **删除 `?? guessContextLength(...)` 回落**。`contextLength` 只来自 yaml；缺失即 `undefined`（UI 显示「—」，承上游 M11）。 |
| `modelCatalogPure.ts:279-292` `guessContextLength` | **物理删除**。 |
| `thinkingGear.ts:153-177`（D2 档位 + D6 正则） | **物理删除**该模块（零 UI 消费者）。档位唯一来源 = yaml `Model.thinking`（`listThinkingOptions`）。 |
| `modelsCatalogSelectors.ts:75-92` `selectEstimatedCost` gravestone | **物理删除**（注释自述「生产零调用…保留签名作 gravestone」）。 |

**约束**：删除前必须逐一 grep 确认零生产消费者（前序已确认，实现时复核）。**禁止**为了「不破坏测试」而保留死函数 —— 测试桩若打幽灵 API，测试本身要改（承上游 M4 精神）。

### 2.5 字典文件本身

- `modelsAutofillBaselineData.json`（D1）、`catalog.json`（D2）**文件保留**（数据资产，供预填）。
- `models.default.yaml` **保持空树**（已合规，见 `survey/01` §8）。

---

## 3. 文件域（互斥写集）

| 文件 | 本维改动 |
| --- | --- |
| `apps/agent-workbench/src-tauri/src/engine_build.rs` | `build_cache_tracking_config` 删两级回落；移除 `#[allow(dead_code)]` |
| `crates/agent-provider/src/models/ttl.rs` | 删除 vendor 默认 TTL 表 |
| `apps/agent-workbench/src-tauri/src/catalog_commands.rs` | `catalog_get`/`catalog_refresh` 删除或改 yaml 投影 |
| `apps/agent-workbench/src-tauri/src/main.rs` | 删除 `ModelCatalog::bundled()` manage + 命令注册 |
| `apps/agent-workbench/src-tauri/src/command_manifest.rs` | 同步清单 |
| `apps/crish-desktop/src/api/transport/commandManifest.ts` | 同步清单 |
| `apps/crish-desktop/src/bootstrap-full.ts` | 删除字典灌入调用 |
| `apps/crish-desktop/src/api/pricingStore.ts` | 删除 `resolve4dPrices` 族 |
| `apps/crish-desktop/src/api/pricingResolver.ts` | 删除 `CATALOG_CACHE_RATES` |
| `apps/crish-desktop/src/api/pricingTypes.ts` | 删除 `DEFAULT_PRICES` |
| `apps/crish-desktop/src/api/modelCatalogMeta.ts` | 删除 `guessContextLength` 回落 |
| `apps/crish-desktop/src/api/modelCatalogPure.ts` | 删除 `guessContextLength` |
| `apps/crish-desktop/src/api/thinkingGear.ts` | 物理删除模块 |
| `apps/crish-desktop/src/api/modelsCatalogSelectors.ts` | 删除 `selectEstimatedCost` |

**禁止触碰**：`profileValidation.ts`、`profileStoreActivation.ts`、`profileActiveSelection.ts`（W2）；`behavior.rs`、`migration.rs`、`cache_policy.rs`（W4）。

**跨维冲突警告**：`modelsCatalogSelectors.ts` 同时被 W1（`selectModelGlobally`）与 W3（`selectEstimatedCost`）触碰 → **必须串行**（W1 先，W3 后）。

---

## 4. 验收断言

### A 源码形状
- `engine_build.rs` 的 `build_cache_tracking_config` 中 `bundled_catalog` grep = 0。
- `ttl.rs` 中 `vendor_default_ttl` grep = 0。
- `engine_build.rs:816` 附近 `#[allow(dead_code)]` grep = 0。
- 若 `catalog_get` 删除：三处清单中 `catalog_get` / `catalog_refresh` grep = 0；`main.rs` 中 `ModelCatalog::bundled` grep = 0。
- `pricingStore.ts` 中 `resolve4dPrices` grep = 0。
- `thinkingGear.ts` 文件不存在（或导出全空）。
- `guessContextLength` grep = 0。
- `selectEstimatedCost` grep = 0。

### B 本会话真跑测
- **缓存 TTL fail-closed 用例**：构造 yaml 中某 provider/model **无** `cacheTtl` → 断言 `build_cache_tracking_config` 返回 `None`（**不**返回内置字典推断值）。
- 用例：yaml 中该模型**有** `cacheTtl: 5m` → 断言返回 `Some(Short)`。
- 用例：provider/model 在 yaml 中**不存在** → 断言 `None`（不 panic、不回落）。
- 若 `catalog_get` 删除：断言其命令未注册（清单断言 + invoke 返回 missing）。
- 用例：`getModelMeta` 对 yaml 中无 `contextWindow` 的模型 → 断言 `contextLength === undefined`（**不**是猜测值）。
- 既有测试若引用 `resolve4dPrices` / `thinkingGear` / `selectEstimatedCost` → **同步删除或改写**（禁止保留死测）。

### C 真实宿主用户路径
- **缓存 TTL 剧本**（`00-总方案.md` §8 剧本 4）：真机 yaml 某模型无 `cacheTtl` → 观察不追踪缓存；补上 `cacheTtl` → 观察开始追踪。
- **字典边界剧本**（§8 剧本 3）：yaml 中不配置某模型 → 对话界面**不**出现；在添加表单输入该模型名 → 字段被预填。

---

## 5. 未确认项（实现时必须先钉）

1. `catalog_get` / `catalog_refresh` 的**全部**下游消费者 —— 前序勘察确认「零 UI 调用」，但实现前必须再穷尽 grep 一次（含测试桩）以决定删除还是改造。
2. `bootstrap-full.ts:22` 的 `await import('./api/thinkingGear')` 是否仅为加载副作用 —— 删除模块时需确认无其他副作用依赖。
3. `pricingStore` 是否被**非价格**用途引用（如「最近使用」），若是则只删价格解析部分。
4. `CacheTtl::parse` 等 ttl.rs 其余部分是否被 `cache_policy_from_profile` 依赖 —— 删 vendor 表时须保留解析器。
5. `modelCatalogMeta.ts` 的 `crish_model_meta_v1` 在删除 `guessContextLength` 后是否还有合法用途（如 `.lastTest` 连通性）—— `ModelList.tsx:67` 确认为合法消费者，保留。

---

## 6. 与其它维的接口

- **依赖 W1**：`modelsCatalogSelectors.ts` 的同文件改动必须等 W1 完成（串行）。
- **输出给 W5**：本维已物理删除的符号（`thinkingGear` 模块、`resolve4dPrices` 族、`guessContextLength`、`selectEstimatedCost`、`catalog_get` 若删）在 W5 删除清单中勾销。
- **输出给 W8**：热路径零字典读取是门禁的核心负向断言。
