# 14 — 多轨 SSOT 与 LocalStorage 孤岛

> **角色**：SSOT & Dual-Track Auditor（只读，不改源码）  
> **战役铁律**：唯一物理真源 `~/.conex/models.yaml`；禁止 LocalStorage 孤岛；禁止多轨。  
> **方法**：全仓 grep 生产 import（测试另列）；按概念枚举全部实现路径；canonical = 铁律指定的 yaml 真源；路径数 > 1 记 **红**。  
> **对照**：`audits/09-单一真源与多轨状态漂移深度审查.md` 只作线索，本文件全部重新取证。09 中「写回平铺自毁」一条已部分过期（见 §7.1）；其余双轨结论仍成立。  
> **配合 15 号**：未提交工作区旧轨扩字段从「路径数」判定——**加固旧岛，不是收敛**（§8）。

---

## 0. 结论先行

**现行生产仍是双轨（实际是三轨以上）**。磁盘 `~/.conex/models.yaml` 被文档与新轨 store 称为唯一真源，但：

1. **设置抽屉的增删改、开关、协议、思考、价格、多模态**几乎全部写进 LocalStorage（`crish_provider_profiles_v1` + `crish_model_meta_v1` + `crish_model_prices_v1`）。
2. **主界面模型列表 / 激活选择**读同一套 LS 孤岛，不读 yaml store。
3. **运行时请求**既不读 LS meta，也不读 yaml：引擎 `config_profile_apply` 只同步 profile 的 baseUrl/model/密钥；协议、窗口、思考白名单、牌价走 **编译期 `catalog.json`（`bundled_catalog`）**。
4. 新轨 `modelsCatalogStore` 在生产里几乎只做 **联想补全的只读镜像**；`addModel` / `updateModel` / `addProvider` **零生产调用**（仅测试）。
5. 未提交工作区给旧轨 `modelCatalogTypes` / `modelCatalogMeta` 补上 `modalities` / `thinking` / `pricing` 并复制一整份树状契约 → **路径数上升，不是下降**。

canonical 列一律按战役铁律标 `~/.conex/models.yaml`。凡生产读写不落该文件的，记红。

---

## 1. 概念路径表

判定规则：

- **路径** = 独立持久化面或独立运行时决议面（文件:符号），不是每一个 helper。
- **canonical** = 铁律指定的物理真源（yaml 树上的对应字段）。
- **路径数 > 1** → 红。
- 生产消费只列非测试 import。

### 1.1 供应商（Provider）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 供应商档案（名称 / baseUrl / 密钥标记 / 模型 id 数组） | ① LS `crish_provider_profiles_v1` ← `profileStorePersistence.saveProfiles/loadProfiles`（`apps/crish-desktop/src/api/provider-profiles/profileStorePersistence.ts:38-79`）<br>② yaml `providers` 树 ← `modelsCatalogStore` / `workbench_*_models_yaml`（`models.yaml`）<br>③ 种子 `DEFAULT_PROFILES`（`profileCatalog.ts:86`）<br>④ 设置页 `PRESETS`（`modelsPresets.ts`，经 `useModelProfilesState.addFromPreset` → 仍写 ①）<br>⑤ 预填种子 `COMMON_PROVIDER_SEEDS`（`services/modelsAutofillBaseline.ts:35`）<br>⑥ 引擎运行时 `config_profile_apply`（`profileStoreActivation.ts:157`） | ① yaml `providers.<id>` | **6 · 红** | **写 ①**：设置抽屉全部增删改（`useModelProfilesState` / `useModelProviderActions.confirmScannedModels` / `createCustomProfile` / `upsertProfile`）；首次加载空 LS 播种 ③。<br>**读 ①**：`ModelBadgePickerMenu.listPickerProfiles`、`ChatHeaderControls.resolvePreferredModelSelection`、`ComposerFusedTrigger.getActiveProfile`、`slashSendPreflight.getActiveProfileId`、首次向导。<br>**写 ②**：仅 YAML 文本弹窗 `YamlConfigEditorModal` + 测试里的 `modelsCatalogStore.updateTree`。<br>**写 ⑥**：选模型时 `activateProfileModel`（不同步模型能力/价格）。 |

**生产 import 证据（旧轨档案）**：`ModelsSettingsTab.tsx:17` `providerProfiles`；`useModelProfilesState.ts:15` `loadProfiles/addModelToProfile`；`ModelBadgePickerMenu.tsx:10` `activateProfileModel`。  
**生产 import 证据（新轨 yaml）**：`ModelsSettingsTab.tsx:23` 只 `ensureModelsCatalogLoaded` / `getModelsCatalogPath`（取路径展示）；`YamlConfigEditorModal.tsx:26,105,257` 才真正读写 yaml。

### 1.2 模型身份与列表（Model id 列表）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 「这个供应商有哪些模型」 | ① `ProviderProfile.models: string[]` 存 LS（`addModelToProfile` `profileStorePersistence.ts:234`）<br>② yaml `providers.*.models[]`（`ModelSpec.id`）<br>③ 扫描结果 `scanProviderModels` → 合并进 ①（`useModelProviderActions.ts:85-104`），**不**走 `probeIncremental` / yaml<br>④ 引擎当前模型 `fetchEngineStatus().model` + Settings `defaultModel`<br>⑤ LS `crish_active_model_id` / `crish_active_profile_id`<br>⑥ LS `crish_recent_models`（`engineConfigIO.ts:20`） | ① yaml 模型节点 | **6 · 红** | 主界面 picker 读 ①+⑤（`listPickerProfiles` ← `loadProfiles`）。设置抽屉手动添加：`handleManualAdd` 调 `addModelToProfile`（①）+ `applyMetaForModel`（meta LS），**从不** `modelsCatalogStore.addModel`。 |

`modelsCatalogStore.addModel/updateModel/addProvider` 全仓生产调用：**0**（仅 `modelsCatalogStore.test.ts:414,469`）。

### 1.3 模型元数据（启用 / 展示名 / 上下文 / 输出上限 / 协议）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 启用开关 / 展示名 / context / maxOutput / protocol | ① LS `crish_model_meta_v1` ← `modelCatalogMeta.upsertModelMeta`（`modelCatalogMeta.ts:14,74-78,176-226`）<br>② yaml `ModelSpec.{enabled,displayName,contextWindow,maxOutputTokens,protocol}`<br>③ 缺省猜测 `guessContextLength` ← 预填库（`modelCatalogPure.ts:262`；`getModelMeta` 空记录时填 `contextLength`）<br>④ 扫描上送 `catalog_refresh` 合并进 **bundled `catalog.json` 内存表**（不落 yaml、不落 LS 除 contextLength） | ① yaml 模型字段 | **4 · 红** | **写 ①**：`modelsIpcHelpers.applyMetaForModel`（设置保存）、`CapEditor`、`setModelEnabled`、`scanProviderModels` 写 `contextLength`（`modelCatalogIpc.ts:50`）。<br>**读 ①**：`getModelMeta` 被 Composer、Picker、设置列表、`readiness.resolveContextWindow`、`slashSendPreflight` 全用。<br>**读 ②**：仅联想（`ManualAddForm.searchCatalogModels`）与视觉兜底（`findCatalogModel`）。 |

### 1.4 能力 / 多模态（Capability / Modalities）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 工具/图/视频/推理开关 | ① LS `ModelMeta.capabilities`（tools/image/video/reasoning；历史 `vision` 读时迁 `image`，`modelCatalogMeta.ts:30-40`）<br>② yaml `ModelSpec.capabilities`<br>③ yaml / 预填 `ModelSpec.modalities.{input,output}`<br>④ **未提交** LS `ModelMeta.modalities`（`setModelModalities` → 仍写 ① 的同一把 LS 键）<br>⑤ 硬编码正则 `VISION_MODEL_PATTERNS` / `NON_VISION_MODEL_PATTERNS`（`modelVisionSupport.ts:18-86`）<br>⑥ `catalog.json` `supports_*` 能力位<br>⑦ 扫描 wire `ScannedModelCapabilities.vision`（与本地 `image` 不同契约域，`modelCatalogTypes.ts:93-96`） | ① yaml `modalities` + `capabilities` | **7 · 红** | 发送前视觉：`slashSendPreflight.checkModelVisionSupport` **先读 yaml store modalities，再读 LS meta.modalities，再 `isModelVisionSupported`（LS capabilities → yaml capabilities → 正则）**（`slashSendPreflight.ts:54-78`，`modelVisionSupport.ts:100-129`）。<br>设置页 `CapEditor` 写 ① 的四布尔，不写 yaml。 |

`capabilitiesStore.ts` 是 MCP product capabilities 缓存，**不是**模型能力，不计入本概念。

### 1.5 价格（Pricing）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 四维单价 / 缓存价 / 币种 | ① LS `crish_model_prices_v1` ← `pricingStore.upsertPrice/savePrices`（`pricingTypes.ts:82`，`pricingStore.ts:66-86`）<br>② LS `ModelMeta.pricing`（未提交 setter；HEAD 的 `applyMetaForModel` 已调用，`modelsIpcHelpers.ts:147-157` **双写 ①+②**）<br>③ 前端静态牌价 `CATALOG_CACHE_RATES`（`pricingCatalogDataA/B/C.ts` + OpenAI/Anthropic/Qwen 分表，`pricingResolver.ts:42`）<br>④ `catalog_get` 快照 ← **bundled `catalog.json`**（`bootstrap-full.ts:18` `fetchCatalogSnapshot` → `applyCatalogCacheSnapshot`）<br>⑤ yaml `ModelSpec.pricing`（`input` / 兼容 `inputPerMTok`）<br>⑥ 预填 JSON `modelsAutofillBaselineData.json`<br>⑦ `DEFAULT_PRICES` 种子（`pricingTypes.ts:177`）<br>⑧ Rust `PricingEngine`（`crates/agent-provider/src/pricing.rs:268`）吃 catalog 条目，不吃前端 LS<br>⑨ 选择器 `selectEstimatedCost`（`modelsCatalogSelectors.ts:65`）——**仅测试** | ① yaml `pricing` | **8（生产 8，选择器不计）· 红** | **UI 写**：`PriceConfigModal.handleAddPrice` → 只 `upsertPrice`（①）；设置保存 `applyMetaForModel` → ①+②，yaml 只当「已知模型且用户未填」时 **抄进 ①**（`modelsIpcHelpers.ts:160-176`）。<br>**运行时估算**：`streamCallbacksUsage.ts` / `useRuntimePanelData.ts` 走 `pricingStore.estimateCostUsd*`：快照④ → 静态表③ → 用户价① → 乘数。**不读 yaml，不读 meta.pricing。** |

### 1.6 思考档位（Thinking）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 「有哪些档」+「当前选哪档」+「请求怎么发」 | ① yaml 拍平 `thinking: { Low: "low", ... }`（`ModelSpec.thinking`）<br>② LS `ModelMeta.defaultThinkingLevel`（当前选择）<br>③ **未提交** LS `ModelMeta.thinking` 映射表（`setModelThinking`）<br>④ Settings `defaultThinkingLevel`（`clientApiDefaultSettings.ts:11`，Composer **双写** ②+④，`ComposerFusedTrigger.ts:73-83`）<br>⑤ `thinkingGear` 内存快照 ← `catalog_get.thinkingTiers` ← **bundled catalog.json**（`thinkingGear.ts:19-27,204-210`）<br>⑥ `thinkingGear.resolveCatalogEfforts` 名称正则保底（r1/o1/spark/reasoner…，`thinkingGear.ts:166-174`）<br>⑦ Rust `MODEL_SERIES_CAPABILITIES`（`vendor_capability.rs:106`）+ TS 同源表（`packages/shared-types/src/thinking-intensity.ts:80`）<br>⑧ `describe_model` / `offered_levels` 以 catalog.json `thinkingTiers` 为单源（`capability.rs`），请求拒绝校验走 `bundled_catalog()`（`engine_provider/thinking.rs:86-90`）<br>⑨ 发送链路只取 Settings：`streamSession.ts:106-111` `sets.defaultThinkingLevel` → `reasoningEffort`，**不读 yaml thinking map，不读 per-model LS** | ① yaml `thinking` | **9 · 红** | **档位面板选项**：Composer / `ModelBadgePickerMenu` 用 ⑤+⑥（`thinkingLevelOptionsFor(resolveCatalogEfforts(modelId))`）。<br>**当前值**：Composer `modelMeta.defaultThinkingLevel \|\| settings`（② 优先 ④）。<br>**请求**：只 ④ → 引擎；白名单校验 ⑧（catalog.json），与用户 yaml/LS 无关。 |

`selectThinkingLevelsMap` / `selectSupportsThinking`（yaml store 选择器）**仅测试**引用。

### 1.7 协议方言（Protocol）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 模型/供应商通信协议 | ① LS `ModelMeta.protocol`（HEAD 三值；未提交扩 `google/interactions`，**无** `google/generate-content`）<br>② yaml `ProviderSpec.protocol` / `ModelSpec.protocol`<br>③ 新轨查询门面把 yaml 的 `google/generate-content` **改写成** `google/interactions`（`modelsCatalogQuery.ts:79-83`）<br>④ 新轨序列化把 `google/interactions` **改回** `google/generate-content`（`modelsCatalogIpc.ts:160-170`）<br>⑤ Rust `ProtocolKind`：rename=`google/generate-content`，alias=`google/interactions`（`catalog_types.rs:109-111`）<br>⑥ 壳 `ModelsYamlProtocol` **只有** `google/generate-content`，无 alias（`models_yaml.rs:29-37`）→ yaml 写 `google/interactions` 可能解析失败<br>⑦ 预填 JSON 写 `google/interactions`（`modelsAutofillBaselineData.json:560,1105`）<br>⑧ 运行时路由 `resolve_wire_protocol(bundled_catalog(), …)`（`protocol.rs:112-128`），**不读 ①②** | ① yaml `protocol` = `google/generate-content` | **8 · 红** | 设置页协议下拉写 ①。联想补全读 ③。引擎请求读 ⑧（catalog.json `mode`）。 |

### 1.8 上下文窗口字段名（contextWindow vs contextLength）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 上下文窗口数值 | ① LS / 旧契约 `contextLength`（`ModelMeta`）<br>② yaml / catalog.json / 预填 `contextWindow`<br>③ 新轨 `CatalogModelSpec` 用 `Object.defineProperty` 把两名绑同一私有值（`modelsCatalogQuery.ts:98-119`）<br>④ 扫描 IPC `m.contextWindow` → 写入 LS `contextLength`（`modelCatalogIpc.ts:49-51`）<br>⑤ 发送 `streamSession.contextWindow` ← `resolveContextWindow` 读 LS `contextLength`（`readiness.ts:66-78`）<br>⑥ 引擎 `effective_context_window` 读 **bundled catalog.json**（`protocol.rs:187-191`） | ① yaml `contextWindow` | **6 · 红** | 前端发送用 ①⑤；引擎预算用 ⑥。同一用户改设置页上下文 **只改 ①**，引擎钳制窗口不更新。 |

### 1.9 价格字段双名（input vs input_per_m_tok）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 输入单价字段 | ① yaml v2 `pricing.input`（`ModelsYamlPricingV2`，`models_yaml.rs:116`）<br>② yaml v1 / flatten `input_per_m_tok`（`models_yaml.rs:70,317`：`p.input.or(p.input_per_m_tok)`）<br>③ TS `PricingConfig.input` + 兼容 `inputPerMTok`（`modelsCatalogTypes.ts:95,111`）<br>④ 平铺门面只暴露 `inputPerMTok`（`modelsCatalogQuery.ts:86-87`）<br>⑤ 用户价表 `ModelPrice.inputPerMTok`（`pricingTypes.ts:49`）<br>⑥ catalog.json `inputPrice` → wire → `inputPerMTok`（`modelCatalogIpc.ts:160-161`）<br>⑦ Rust catalog 解析 `entry.input_price = p.input.or(p.input_per_m_tok)`（`catalog.rs:842,897`） | ① yaml `pricing.input` | **7 · 红** | 读路径到处 `or` 兼容；写路径：yaml 序列化优先 `input`（`modelsCatalogIpc.ts:190-194`），LS 价表写 `inputPerMTok`，meta 写 `pricing.input`。 |

### 1.10 Rust 目录真源（live vs bundled vs 文件）

| 概念 | 路径列表 | canonical | 路径数 | 谁在生产消费 |
| --- | --- | --- | --- | --- |
| 内核模型目录 | ① `~/.conex/models.yaml` ← `ModelCatalog::load_user_catalog`（`catalog.rs:382`）<br>② `live_catalog()` RwLock（`protocol.rs:40-53`，`#[allow(dead_code)]`）<br>③ `bundled_catalog()` OnceLock ← `include_str!("catalog.json")`（`protocol.rs:71-73`，`catalog.rs:350-356`）<br>④ Tauri State `ModelCatalog::bundled()` 供 `catalog_get`（`main.rs:992-994`，`catalog_commands.rs:8-10`）<br>⑤ 播种模板 `models.default.yaml` = `version: 2` + `providers: {}`（空树，`models.default.yaml:1-2`）<br>⑥ yaml 保存后 `reload_live_catalog()`（`models_yaml.rs:479`）——**不**刷新 ③④ | ① yaml | **5 活跃 + 1 空模板 · 红** | **请求协议 / 窗口 / 思考白名单 / catalog_get 价格快照：全部 ③④**。② 仅在保存 yaml 时写入，**无生产读点**（`live_catalog()` 除自身定义外零调用）。 |

---

## 2. 前端两套 catalog 产消图

### 2.1 旧轨（LS 岛）— 文件

| 文件 | 职责 |
| --- | --- |
| `apps/crish-desktop/src/api/modelCatalog.ts` | hub re-export |
| `modelCatalogTypes.ts` | `ModelMeta` / 扫描 wire；**未提交**后半段复制树状契约 |
| `modelCatalogPure.ts` | 纯函数 + `guessContextLength`（现读预填库） |
| `modelCatalogMeta.ts` | **LS 读写** `crish_model_meta_v1` |
| `modelCatalogIpc.ts` | 扫描 / `catalog_get` 价格快照 / picker 列表（列表数据源仍是 `loadProfiles`） |

### 2.2 新轨（yaml 镜像）— 文件

| 文件 | 职责 |
| --- | --- |
| `modelsCatalogStore.ts` | 内存树 + `ensureLoaded` / `updateTree` |
| `modelsCatalogTypes.ts` | 树状契约（与旧轨未提交段重复） |
| `modelsCatalogIpc.ts` | `models_yaml_read/write`（未注册）→ 回退 `workbench_*` |
| `modelsCatalogActions.ts` | 纯函数 add/update；`addModel` 调预填 |
| `modelsCatalogQuery.ts` | 平铺门面；协议改写；价格字段改写 |
| `modelsCatalogSelectors.ts` | O(1) 选择器——**生产零引用** |

### 2.3 生产 import（排除测试）

**旧轨 `modelCatalog` / `modelCatalogMeta`：**

- `components/chat-composer/ComposerFusedTrigger.tsx`
- `components/provider/ModelBadgePickerMenu.tsx`
- `components/settings-models/ModelsSettingsTab.tsx`
- `components/settings-models/useModelProfilesState.ts`
- `components/settings-models/useModelConfigSession.ts`
- `components/settings-models/useModelProviderActions.ts`
- `components/settings-models/modelsIpcHelpers.ts`
- `components/settings-models/modelProfilesHelpers.ts`
- `components/settings-models/ModelProfileList.tsx`
- `components/settings-models/ModelList.tsx`
- `components/settings-models/ModelConfigPanel.tsx`（type）
- `components/settings-models/CapEditor.tsx`
- `hooks/chat-stream/slashSendPreflight.ts`（直接 `modelCatalogMeta`）
- `api/chat-bridge/readiness.ts`
- `api/modelVisionSupport.ts`

**新轨 `modelsCatalogStore`：**

- `ModelsSettingsTab.tsx` — 仅 `ensureModelsCatalogLoaded` + 路径
- `YamlConfigEditorModal.tsx` — 保存后强制重载
- `ManualAddForm.tsx` — `searchCatalogModels` 联想
- `PriceConfigModal.tsx` — 联想（写价仍 `upsertPrice`）
- `modelsIpcHelpers.ts` — `findCatalogModel` 抄牌价进 LS
- `slashSendPreflight.ts` — `modelsCatalogStore.getState()` 读 modalities
- `modelVisionSupport.ts` — `findCatalogModel`
- `hooks/useModelsCatalogVersion.ts`
- `probeIncremental.ts` — 只被 store 内部 `probeAndAppendModels` 调用，**UI 扫描不走这条**

**两轨同时 import 的生产文件（双读）：**

| 文件 | 旧轨用途 | 新轨用途 |
| --- | --- | --- |
| `ModelsSettingsTab.tsx` | `getModelMeta` 判启用 | 加载 yaml 镜像、显示磁盘路径 |
| `slashSendPreflight.ts` | `getModelMeta.modalities` 兜底 | `modelIndex` 优先读 yaml modalities |
| `modelsIpcHelpers.ts` | 全部 setter 写 LS | `findCatalogModel` 预填价写入 LS |
| `modelVisionSupport.ts` | LS `capabilities.image` 优先 | yaml `capabilities.image` 次优先 |
| `ManualAddForm.tsx` | `formatContextLabel` | `searchCatalogModels` |

嫌疑 1 **证实**。

---

## 3. LocalStorage 键清单

| 键 | 定义 | 读 | 写 | 生产是否活 |
| --- | --- | --- | --- | --- |
| `crish_provider_profiles_v1` | `profileStorePersistence.ts:38`；迁移别名 `LEGACY_PROFILES_KEY`（`migrateLegacyProfiles.ts:26`） | `loadProfiles:79` | `saveProfiles:41`；规范化写回 `130` | **活。供应商+模型列表真源。** |
| `crish_model_meta_v1` | `modelCatalogMeta.ts:14` | `loadMap:52`；跨窗 `storage` 事件 `89` | `saveMap:78`；所有 `setModel*` / `upsertModelMeta` | **活。启用/上下文/思考/协议/能力；未提交后含 modalities/thinking/pricing。** |
| `crish_model_prices_v1` | `pricingTypes.ts:82` | `pricingStore.loadPrices:68` | `savePrices:78` / `upsertPrice:81` | **活。价表 UI 与流式估算。** |
| `crish_cache_price_opts_v1` | `pricingTypes.ts:83` | `pricingStore` 缓存乘数 | 同左 | 活（费率兜底，非模型目录） |
| `crish_cache_ttl_mode_v1` | `pricingTypes.ts:84` | `pricingStore.ts:393` | `408` | 活（Anthropic 5m/1h 写价档） |
| `crish_active_profile_id` | `profileActiveSelection.ts:11` | `getActiveProfileId:34`；`contextStatePending.ts:44` | `setActiveProfileId:41` | **活。当前供应商。** |
| `crish_active_model_id` | `profileActiveSelection.ts:12` | `getActiveModelId:46`；Composer/ChatHeader/readiness | `setActiveModelId:53` | **活。当前模型。** |
| `crish_recent_models` | `engineConfigIO.ts:20` | `loadRecentModels:25` | `pushRecentModel:39`（`activateProfileModel` 调用） | 活（picker 近期，非能力真源） |
| `crish_profiles_secrets_migrated_v1` | `migrateLegacyProfiles.ts:24` | `60` | `147` | 活（密钥迁移幂等标记） |
| `crish_models_selected_profile_v1` | **sessionStorage** `useModelProfilesState.ts:57,175` | 设置页选中供应商 | 同左 | 活（UI 瞬态，非模型真源） |
| `crish_providers` / `conex_pi_providers` | `ORPHAN_LEGACY_KEYS`（`migrateLegacyProfiles.ts:37`） | 仅迁移剥离明文 | 迁移写回无 apiKey | **死读写点**；启动时仍可能被扫到 |

测试里直接 `setItem` 的同上键：`providerProfiles.test.ts`、`modelCatalogMeta.test.ts`、`pricingStore.test.ts`、`ModelBadgePickerMenu.test.tsx`、`ConnectionLifecycle*.test.ts`、`permAndModelExclusive.test.tsx`。

---

## 4. 数据流（UI 读 / 保存写 / 运行时请求读）

```
                    ┌─────────────────────────────────────────────────────────┐
                    │  磁盘 ~/.conex/models.yaml   ← canonical（铁律）         │
                    │  读：workbench_read_models_yaml / load_user_catalog      │
                    │  写：YamlConfigEditorModal + writeModelsYamlIpc 回退     │
                    │      （日常设置抽屉不写这里）                             │
                    └───────────────┬───────────────────────────┬─────────────┘
                                    │ 只读镜像                    │ reload_live_catalog
                                    ▼                            ▼
                    modelsCatalogStore                     live_catalog()  【无生产读点】
                    （联想 / 视觉兜底）                    bundled_catalog() ← catalog.json
                                                           catalog_get State ← bundled()
                                    │                            │
        设置抽屉日常路径             │                            │ 请求面
        ────────────────             │                            │
        添加供应商/模型 ──► saveProfiles ──► LS profiles           │
        改能力/思考/价 ──► applyMetaForModel                       │
                          ├─► LS meta                             │
                          └─► upsertPrice ──► LS prices           │
        改当前模型     ──► activateProfileModel                    │
                          ├─► LS active_*                         │
                          └─► config_profile_apply ──► 引擎       │
                                 (baseUrl + model + DPAPI key)    │
                                                                  ▼
        主界面 picker ──► loadProfiles + getModelMeta              HTTP 请求：
        Composer 思考 ──► getModelMeta.defaultThinkingLevel         protocol/window/tiers
                          || settings.defaultThinkingLevel          = bundled catalog.json
        发送 contextWindow ──► getModelMeta.contextLength           effort = settings.defaultThinkingLevel
        发送视觉判断 ──► yaml modalities || LS || 正则              thinking map（yaml）不进请求
        流式费用 ──► catalog_get 快照 || 静态表 || LS prices
```

### 4.1 设置面板改模型后，主界面是否同源刷新？

| 用户动作 | 写入 | 主界面是否刷新 | 是否同源 |
| --- | --- | --- | --- |
| 开关启用 / 改展示名 | LS meta + `model-meta-changed` | Picker `useModelMetaTick` **会**重过滤 | 同源（都是 LS），**不是 yaml** |
| 手动添加模型 | LS profiles + meta | meta 事件会让 picker 重读 `loadProfiles` | 同源 LS |
| 扫描确认 | LS profiles + 对新 id `applyMetaForModel` | 同上 | 同源 LS |
| 改思考档（设置抽屉） | LS meta（+ 可能价表） | Composer **不订** `model-meta-changed`，只订 `model-changed` → **当前会话可能不刷新** | 断链 |
| 改思考档（Composer 胶囊） | LS meta **且** Settings `defaultThinkingLevel` | 本胶囊即时；请求走 Settings | 双写 |
| YAML 弹窗保存 | `workbench_save_models_yaml` + `ensureModelsCatalogLoaded(true)` + `models-catalog-changed` | 联想（`useModelsCatalogVersion`）刷新；**Picker 列表不读 store** → **主列表不出现 yaml 新模型** | **不同源** |
| 改 yaml 价格 | yaml | 流式估算仍走 catalog.json/静态表/LS 价表 | **不同源** |

**总判**：设置抽屉 ↔ 主界面 picker 在 **LS 孤岛内部**有 `model-meta-changed` 总线，看起来「改了会刷新」，但刷新的不是 yaml。YAML 真源改动 **不能**驱动主界面模型列表。请求面与 UI 面再分裂一次（catalog.json / Settings）。

---

## 5. 已知双轨嫌疑 · 逐条证实或证伪

### 5.1 前端两套 catalog — **证实**

见 §2。旧轨仍是 UI 生命线；新轨是旁路镜像 + 联想。`selectEffectiveProtocol` 等选择器未接线。

### 5.2 LocalStorage 键 — **证实（铲除率 0）**

三把主钥匙均有生产读写。另有 active / recent / cache 附属键。见 §3。

### 5.3 预填双份路径 — **假双份（薄 re-export）+ 类型绑旧轨**

| 文件 | 角色 |
| --- | --- |
| `apps/crish-desktop/src/services/modelsAutofillBaseline.ts` | **唯一实现** + `modelsAutofillBaselineData.json` |
| `apps/crish-desktop/src/api/modelsAutofillBaseline.ts` | `export * from '../services/...'` 一行转口 |

实现不是两份。但：

- 实现文件 `import type { ModelSpec, ... } from '../api/modelCatalogTypes'`（**旧轨类型**，`services/modelsAutofillBaseline.ts:18`）
- `modelsCatalogActions.addModel` 从 `./modelsAutofillBaseline`（api 转口）取 `findAutofillModel`
- `useModelConfigSession` / `ModelConfigPanel` 直接从 `services/` import

这是 **入口双路径 + 类型绑错轨**，不是第二份数据表。预填库本身按注释「不是真源」，但 `guessContextLength` 与设置打开时的 modalities/thinking 默认都读它，**实际充当第三真源**。

### 5.4 价格多轨 — **证实**

静态牌价（③）+ catalog.json 快照（④）+ LS 用户价（①）+ LS meta.pricing（②）+ yaml（⑤）+ 预填 JSON（⑥）+ DEFAULT_PRICES（⑦）+ Rust PricingEngine（⑧）。  
前端估算链 **故意不读 yaml**。设置保存还把 yaml 牌价 **复制进 LS**，制造第四份副本。

### 5.5 思考多轨 — **证实**

UI 选项 = catalog.json `thinkingTiers`（经 `thinkingGear`）+ 正则保底。  
当前值 = LS meta + Settings。  
请求 = Settings `defaultThinkingLevel`。  
yaml `thinking` map 与 `MODEL_SERIES` 仍在内核兜底路径（`build_chat.rs:49` 声称废除优先查系列表，但无 yaml map 时仍 `infer_thinking_capability`，`build_chat.rs:124`）。  
TS `inferThinkingCapability` 无生产组件 import（只定义于 `thinking-intensity.ts`）。

### 5.6 协议枚举漂移 — **证实**

- 旧 `ModelMeta.protocol` HEAD：无 Google；未提交：只有 `google/interactions`
- 新 `modelsCatalogTypes.ModelProtocol`：两值都有
- 查询层 yaml→UI：`generate-content` → `interactions`（`modelsCatalogQuery.ts:80-81`）
- 写回 yaml：反向归一（`modelsCatalogIpc.ts:160-170`）
- 壳 IPC schema **无 alias**（`models_yaml.rs:36`），内核 catalog_types **有 alias**
- `contextWindow` vs `contextLength`：LS/发送用 Length，yaml/catalog.json 用 Window，中间靠 defineProperty 与扫描时改名

### 5.7 Rust live vs bundled vs catalog.json vs models.default.yaml — **证实**

| 符号 | 数据 | 生产命运 |
| --- | --- | --- |
| `models.default.yaml` | 空 `providers: {}` | 仅首次播种 |
| `~/.conex/models.yaml` | 用户树 | IPC 读写；`load_user_catalog` |
| `live_catalog()` | yaml 解析结果 | **死代码**（allow dead_code） |
| `bundled_catalog()` / Tauri catalog State | `catalog.json` | **请求 + catalog_get 真源** |
| `reload_live_catalog` | 刷新 ② | 不刷新 bundled / catalog_get |

保存 yaml **不能**改变下一次请求的协议/窗口/思考白名单/catalog_get 牌价。

### 5.8 字段双名 — **证实**

`input` / `input_per_m_tok` / `inputPerMTok` / `inputPrice` 四套；思考旧双字段在 Rust catalog 已收敛为单一 `thinkingTiers`（`capability_tests.rs` 注释），但前端仍同时存在：

- `thinkingTiers`（catalog_get）
- `thinking` 拍平 map（yaml / 未提交 LS）
- `defaultThinkingLevel`（选择值）
- `THINKING_LEVEL_LABELS` 小写 id（off/low/medium…）vs yaml TitleCase 键（Low/Medium/High）

### 5.9 未提交 +234 行旧轨类型 — **加固旧岛（路径数判定）**

见 §8。与 15 号结论同向，本文件只数路径。

---

## 6. 假收敛（改名未删 / 镜像未接线 / 注释说谎）

| 现象 | 证据 | 判定 |
| --- | --- | --- |
| 新轨 store 注释「彻底消灭 LocalStorage」 | `modelsCatalogStore.ts:5-6` | 注释与生产相反 |
| IPC 名 `models_yaml_read/write/reload` | 前端调用（`modelsCatalogIpc.ts:84,255,292`）；Rust 只注册 `workbench_read/save/validate_models_yaml`（`main.rs:201-210`，`command_manifest.rs:92-94`） | **改名未接线**。读永远 `missing` → 回退 workbench |
| 回退读丢失 v2 字段 | `workbench_read` 返回 `providers` + 扁平 `models`；前端要 `tree`（`modelsCatalogTypes.ts:234`）。回退：`wire.tree \|\| convertFlatModelsToTree(wire.models)`（`modelsCatalogIpc.ts:133`）——**忽略 `wire.providers`**。扁平 `ModelsYamlModel` 不含 thinking/modalities（flatten 于 `models_yaml.rs:327-337`） | 新轨镜像自残：日常加载丢掉思考/模态 |
| 09 所述「写回平铺自毁」 | 现行 `writeModelsYamlIpc` missing 时 `serializeModelsYamlTree` 再 `workbench_save_models_yaml`（`modelsCatalogIpc.ts:267-273`） | **09 过期**：写路径已改 v2。但生产设置抽屉根本不走这条 |
| `api/modelsAutofillBaseline.ts` | 纯 re-export | 假双份入口 |
| 旧轨复制新轨类型 | 未提交 `modelCatalogTypes.ts` +233 | 改名/复制未删；两份 `ModelSpec`/`ModelProtocol`/`ModelsYamlTree` |
| `live_catalog` | 有加载、有 reload、无读点 | 假接线 |
| `probeIncremental` | store 方法存在；设置扫描走 `scanProviderModels` → LS | 扫描双路径，yaml 增量追加未接线 |
| `guessContextLength` 注释「废除 KNOWN_CONTEXT」 | 改为预填库（`modelCatalogPure.ts:258-273`） | 硬编码表换成另一份静态字典，仍不是 yaml |

---

## 7. 对 09 号审计的再取证差分

| 09 断言 | 2026-09-08 再取证 |
| --- | --- |
| LS 孤岛未铲除 | **仍成立** |
| 主 UI 几乎 100% 跑在 LS | **仍成立**（picker/composer/设置抽屉） |
| `models_yaml_read/write` 未注册 | **仍成立** |
| 写回 missing 时手拼 v1 平铺自毁 | **已改**：现序列化 v2 树。09 §1.3 过期 |
| `contextWindow` vs `contextLength` | **仍成立** |
| `google/generate-content` vs `google/interactions` | **仍成立**，且查询/序列化互相改写 |
| 思考 `thinking` map vs `defaultThinkingLevel` | **仍成立**，并多了 thinkingGear catalog.json 轨 |
| 跨厂商 `findCatalogModel` 无 providerId 取 `[0]` | **仍成立**（`modelsCatalogQuery.ts:183-186`）；视觉兜底 `findCatalogModel(rawModel)` 不传 providerId（`modelVisionSupport.ts:109`） |

---

## 8. 未提交工作区：路径数判定（配合 15 号）

工作区相对 HEAD 实质改动（15 号已核 CRLF 噪音）：`modelCatalogTypes.ts` +233/−1；`modelCatalogMeta.ts` +50/−1；`modelCatalog.ts` +3；以及 `guessContextLength` 改读预填。

**路径数变化（本审计口径）：**

| 概念 | HEAD 路径数 | 未提交后 | 增减 |
| --- | --- | --- | --- |
| 树状契约 `ModelSpec`/`ModelsYamlTree` | 1（`modelsCatalogTypes.ts`） | **2**（再复制进 `modelCatalogTypes.ts`） | **+1 红** |
| `ModelProtocol` | 新轨含 generate-content+interactions；旧 meta 无 Google | 旧 meta 只加 interactions；仍无 generate-content | 漂移加大 |
| 多模态 | yaml `modalities` + LS `capabilities` + 正则 | **再加** LS `ModelMeta.modalities` 写穿透同一 `crish_model_meta_v1` | **+1 红** |
| 思考 map | yaml `thinking` + catalog.json `thinkingTiers` | **再加** LS `ModelMeta.thinking` | **+1 红** |
| 价格 | yaml + 静态表 + catalog.json + LS 价表 | **再加** LS `ModelMeta.pricing`（HEAD helper 已调用，本批补齐类型/setter 让它编过） | **把死调用变成活岛字段** |

`setModelModalities` / `setModelThinking` / `setModelPricing` 全部 `return upsertModelMeta(...)`（`modelCatalogMeta.ts:319-354`），零 `modelsCatalogStore.updateModel`，零 `workbench_save_models_yaml`。

**判定（路径数，不是动机）**：这是 **加固旧岛**。HEAD 设置抽屉（`modelsIpcHelpers.ts` 已提交）已经在调用这些 setter；本批把类型和 persist 补齐，让「统一体系字段」继续活在 `crish_model_meta_v1`。若提交，yaml 仍不是设置抽屉的写点，概念路径数上升。

15 号从 diff 语义得出同一结论；本文件从「每概念几条路」独立证实。

---

## 9. 给主控总结

1. **铁律未落地。** canonical 是 `~/.conex/models.yaml`，生产 UI 真源是三把 LS 钥匙，运行时真源是 `catalog.json`。三条世界互不同步。
2. **新轨是旁路。** `modelsCatalogStore` 生产只做加载/联想/视觉兜底；增删改 API 没有 UI 调用。设置抽屉 `handleManualAdd` / `confirmScannedModels` / `saveConfig` 全部打进 LS。
3. **IPC 名漂移。** 前端 `models_yaml_*` 未注册；回退读还用扁平 `models` 重建树，丢掉 thinking/modalities。即使有人打开 yaml 编辑器写对了，store 镜像也可能缺字段。
4. **请求面不认用户配置。** `bundled_catalog()` 决定协议、窗口、思考白名单、catalog_get 牌价；`live_catalog()` 死。用户改 yaml 或 LS，下一次 HTTP 仍按编译期 JSON。
5. **思考三条生命线。** 选项（catalog.json）≠ 当前值（LS meta / Settings）≠ 请求（Settings）。Composer 双写 Settings+LS；设置抽屉只写 LS → 主界面胶囊可能不刷新，请求也可能仍用旧 Settings。
6. **价格至少八条路。** 估算链不读 yaml；设置保存把 yaml 抄进 LS 价表，制造副本而非收敛。
7. **未提交 +234 是假收敛。** 把新轨类型贴进旧文件、把新字段写入旧 LS 键，路径数 +1 而非 −1。建议主控：**丢弃或改道**——setter 必须打 `modelsCatalogStore.updateModel` → yaml；禁止再扩 `ModelMeta`。
8. **问题同权，不排序砍项。** 供应商列表、模型 id、能力、价格、思考、协议、字段名、Rust 目录，每一条都是独立的多轨，任一留下都会让「改设置主界面/请求不同源」。

**收敛方向（只陈述依赖，不改目标）**：一条写路径（设置抽屉 → yaml IPC → 热重载 `live_catalog` **且** catalog_get State）；一条读路径（主界面/请求/估算都订阅该镜像）；LS 键删除或只留 active 选择这类非能力偏好；删掉复制的类型文件与静态牌价表（或降为预填，禁止运行时决议）。在路径数回到 1 之前，不得宣称 SSOT 完成。
