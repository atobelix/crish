# Wave 4 对账：上一轮审计 06–10 红项闭合核验

> **文档标识**：`docs/provider-model-unification/audits/11-Wave4对账-上一轮红项闭合核验.md`  
> **角色**：Hard Close-out Auditor（只读）  
> **对照基线**：`06`–`10` 审计（Wave 4 前约 1.5 小时，仅作问题清单，不当事实验）  
> **自称修复提交**：`f98b7f62` `feat(models): 全线打通净收敛与深度审查加固 BATCH-UNIFY-04`  
> **取证范围**：当前工作区代码（含未提交）。Wave 4 相关文件与 `HEAD` 一致；工作区仅多一处无关改动 `apps/agent-workbench/src-tauri/src/main.rs` 增加 `pub(crate) use engine::engine_provider`，不影响本对账。  
> **取证纪律**：每条判定均重新 grep / read_file；禁止把 06–10 当真理照抄；禁止空壳「基本已修复」。

---

## 总裁决

Wave 4 把若干**模块内**断层接上了线（`assemble_thinking_dialect` 进入 `build_chat.rs` / `build_responses.rs`；手拼扁平 YAML 降级删除；阶梯计费免费短路与微元饱和截断修复；魔鬼测试改直连生产模块；保存按钮回归 `variant="primary"` 并 sticky；前端发送路径对纯文本模型传图改为 abort），但**端到端效果锁未闭合**：`EngineProviderConfig` 仍无 `vendor` / `protocol` / `compat` / `thinking_map`，宿主 `request_options` 用 `Default` 把思考字典清成 `None`，生产 chat 轨因此仍走前缀表 `infer_thinking_capability` 兜底；`ModelConfigPanel` 保存仍写 LocalStorage 不写 `models.yaml`；`PricingEngine::calculate_cost` 在 session-loop / orchestrator / 工作台结算路径仍为零调用；`url.contains` 与模型前缀启发式仍盘踞 `vendor.rs` / `compat.rs` / `cache_policy.rs` / `behavior.rs`；Composer / 模型选择器仍读 `crish_provider_profiles_v1` / `crish_model_meta_v1`；Rust 多模态守卫 `ensure_content_modalities` 带 `#[allow(dead_code)]` 未进入 `HttpProviderCall::stream`。Wave 4 自称的「全线打通净收敛」在宿主接线与 UI 真源两层仍是伪连通。

---

## 对账表

判定口径：`closed` = 原红项在当前代码已消失且生产路径可复核；`still-open` = 原问题仍在；`worsened` = 比 06–10 更差；`stale` = 原结论已过时（含当时已 PASS、现仍 PASS，或原「零调用」已被接线取代但效果锁未完——后者在表中拆成两条，避免把「函数进了 builder」误写成「yaml 字典已出站」）。

| 原审计编号 | 原结论摘要 | 当前证据（文件:行号） | 判定 |
| :--- | :--- | :--- | :--- |
| **必核-1 / 06-4.2 / 08-4.3** | `assemble_thinking_dialect` 全仓零生产调用，只在 `dialect.rs` 单测里跑 | **已进入生产 builder**：`build_chat.rs:12,49,74,104,116` 与 `build_responses.rs:11,87,119` 均 `use` 并调用。`build.rs:97-100` 已补 `thinking_map` / `thinking_format`。builder 单测 `build_chat.rs:280-308`、`build_responses.rs:166-177` 断言自定义 wire。**但宿主未灌字典**：`engine_provider.rs:154-162` `request_options` 只填 model/stream/max_tokens/effort/cache，其余 `..Default::default()` → `thinking_map=None`、`thinking_format=None`。因此 chat 生产路径必入 `build_chat.rs:85-149` 兜底：Anthropic 仍调 `reasoning_effort_object`（`:88`），随后 `infer_thinking_capability`（`:124`）可整表覆盖。`EngineProviderConfig`（`engine_provider.rs:64-77`）仍无 vendor/protocol/compat/thinking_map。 | **必核-1：closed**（进入 builder，非仅单测）。**06-4.2/08-4.3 效果锁：still-open**（yaml 拍平字典到出站仍断） |
| **06-4.3** | `ChatCompletionsRequestOptions` 无 `thinking_map` 字段 | `build.rs:97-100` 已有 `thinking_map` / `thinking_format`。 | **closed** |
| **必核-2 / 08-断层0** | `ModelConfigPanel` 保存写入 LocalStorage，不写 `models.yaml` | `useModelConfigSession.ts:171-186` `saveConfig` → `applyMetaForModel`。`modelsIpcHelpers.ts:66-156` 调用 `setModelModalities` / `setModelThinking` / `setModelPricing` / `upsertPrice`。`modelCatalogMeta.ts:14,74-78` `saveMap` → `localStorage.setItem('crish_model_meta_v1')`。全仓 UI 保存路径仍 **0 次** 调用 `modelsCatalogStore.updateModel`（该 API 仅 `modelsCatalogStore.ts:277` 定义 + 单测）。 | **still-open** |
| **必核-3 / 08-5.1 / 08-5.2** | `PricingEngine::calculate_cost` 生产零调用；RunSnapshot 无 `CostBreakdown` | 当前 `calculate_cost` 命中：`pricing.rs` 定义/转发、`pricing_tests.rs`、`devil_cases_tests.rs`、`catalog_types.rs:338` 转发。`crates/session-loop` **0**、`crates/orchestrator` **0**、`apps/` **0**。`CostBreakdown` 同样只在 pricing 模块与测试。`core_query_commands.rs:1479-1487` 快照仍只序列化 token/cache 计数。`streamCallbacksUsage.ts:36-87` 仍 `import('../../api/pricingStore')` 做 JS 浮点估算。 | **still-open** |
| **必核-4 / 06-2.1 / 06-3.1-3.2** | `url.contains` 与模型前缀启发式主导运行时 | 生产仍在：`compat.rs:43-49,105,156`；`vendor.rs:185-197` `infer_reasoning_vendor`；`cache_policy.rs:568-591`；`behavior.rs:313-356`。`is_openai_o_series`：`compat.rs:58-67`。`MODEL_SERIES_CAPABILITIES`：`vendor_capability.rs:106-156`，且被 `build_chat.rs:124` 生产兜底调用。`protocol.rs:78-89,99-100` 仍用 `infer_reasoning_vendor` + `resolve_max_tokens_field`（URL 轨）；`resolve_max_tokens_field_with_compat`（`compat.rs:122`）**仅单测调用**。`engine_provider.rs:243-247` 仍 URL/模型名猜 DeepSeek。 | **still-open** |
| **06-2.2** | `messages_compat.is_deepseek` 盆景；生产 `to_chat_messages` 用空 `WireCompat` | `build_chat.rs:183` 仍调四参 `to_chat_messages`；`messages.rs:240-246` 内部硬灌 `WireCompat::default()`。`to_chat_messages_with_compat` 存在但生产 builder 未切。 | **still-open** |
| **06-2.3 / 08-4.2** | `EngineProviderConfig` 无显式配置；`validate_reasoning_effort` 读死 `bundled_catalog` | 结构体仍只有 base_url/api_key/model/endpoint/stream/extra（`engine_provider.rs:64-77`）。`thinking.rs:86-87` 仍 `bundled_catalog()`。`protocol.rs:39-40` `live_catalog()` 仍 `#[allow(dead_code)]`；`effective_protocol`（`:112-114`）仍 `bundled_catalog()`。`reload_live_catalog`（`models_yaml.rs:479`）会写 LIVE_CATALOG，但请求路径从不读它。 | **still-open** |
| **06-3.3** | 全局注入 `x-deepseek-harness-session-id` | `headers.rs:69-73` 非空 session_id 仍无条件注入该头。测试 `engine_provider_tests.rs:411-459` 仍钉死该行为。 | **still-open** |
| **06-5 / 重点4** | 预填库与默认激活隔离合规 | `modelsAutofillBaseline.ts:1-16` 仍声明纯字典；`models.default.yaml:1-3` 仍 `providers: {}`。此项 06 已 PASS，当前未回潮。**注意**：LocalStorage 轨 `loadProfiles()`（`profileStorePersistence.ts:80-81`）无数据时仍 `saveProfiles(DEFAULT_PROFILES)`，那是 09 双轨问题，不是预填库偷激活 yaml。 | **stale**（原已 PASS，现仍 PASS） |
| **必核-5 / 10-5.1 / 09-DEF-02 写降级** | 前端手拼 `models:` 扁平 YAML，丢 pricing/thinking/modalities | `modelsCatalogIpc.ts` 已无 `lines.push(\`  - model:\`)`。`serializeModelsYamlTree`（`:156-244`）用 `yamlStringify` 输出 v2 `providers` 树，保留 thinking/modalities/pricing/compat/headers/baseUrl。`writeModelsYamlIpc`（`:251-285`）missing 时把该树文本交给 `workbench_save_models_yaml`，失败返回 `{ok:false}`，不再自毁降级。 | **closed**（手拼扁平降级已删） |
| **09-DEF-02 命令注册 / 必核-10** | `models_yaml_read/write` 未注册；`workbench_*_models_yaml` 应注册且 fail-closed | **`workbench_*` 已注册**：`main.rs:200-211`、`command_manifest.rs:92-94`。YAML 弹窗 fail-closed：`YamlConfigEditorModal.tsx:144-149` validate missing → 禁存；`:257-262` save missing → 报错。**`models_yaml_read` / `models_yaml_write` / `models_yaml_reload` 仍未在 `main.rs` 注册**。读回退（`modelsCatalogIpc.ts:114-133`）在 `models_yaml_read` missing 时走 `workbench_read_models_yaml`，但组装树用 `wire.tree \|\| convertFlatModelsToTree(wire.models)`——Rust DTO（`models_yaml.rs:217-230`）字段是 `providers` **没有 `tree`**，故生产读路径会丢掉 `providers` 树、从扁平 `models` 重建（扁平结构 `models_yaml.rs:317-336` 不含 thinking/modalities/compat/baseUrl）。 | **必核-10 workbench_* 注册+YAML弹窗 fail-closed：closed**。**models_yaml_* 未注册 + 读回退丢树：still-open** |
| **必核-6 / 10-5.2** | `devil_cases_tests.rs` 内部重写 pricing/migration 掩盖生产缺陷 | 文件头 `devil_cases_tests.rs:5,9-14`：`use agent_provider::migration::{...}`、`use agent_provider::pricing::{PricingEngine,...}`。无 `pub mod pricing` / `pub mod migration`。仍内联 `ArcSwap` 测试夹具（`:19-41`），与原「复制生产实现」红项不是同一件事。 | **closed** |
| **必核-7 / 10-4.3** | 基础四价全 0 短路「免费」，架空 `tiers` | `pricing.rs:283-291` 现要求 `pricing.tiers.is_empty() &&` 四价为 0 才 `CostBreakdown::free`。`pricing_tests.rs:682` 有免费阶梯回归。 | **closed** |
| **10-4.1** | `tokens_to_micros` / 按张计费 `as u64` 截断回绕 | `pricing.rs:443-446`：`result.min(u64::MAX as u128) as u64`。按张：`pricing.rs:297-298` `product.min(u64::MAX as u128)`。`f64_to_micros`（`:451-460`）亦钳 `u64::MAX`。 | **closed** |
| **10-3.3B** | v1→v2 迁移遗漏 `capabilities` | `migration.rs:438-456` 保留/补齐 capabilities；`:458-460` 保留 headers。 | **closed** |
| **10-3.3A** | Windows `remove_file` 再 `rename` 非原子窗口 | `migration.rs:164` 改走 `atomic_replace`；`:219-251` 三阶段：目标改名为 `.roll.bak` → tmp 改名为目标 → 失败回滚。**未改用 `conex-fs::atomic_write_file`**（migration.rs 内 0 处 `conex_fs::atomic`）。比原「先删后移」闭合；与 10 建议的 conex-fs 事务仍有差。 | **closed**（原断裂窗口已改；conex-fs 收敛未做，列入残留） |
| **必核-8 / 08-3.1-3.4** | 多模态不拦截：Toast + Base64 当文本发；Rust `supports_image_input` 零生产调用 | **前端发送已硬拦截**：`slashSendPreflight.ts:149-160` `hasImage && !checkModelVisionSupport` → toast + `status:'abort'`；`assembleChatPayload` `:404-408` 再 throw。`checkModelVisionSupport`（`:54-78`）优先读 `modelsCatalogStore` 的 `modalities.input` 含 `image`，否则 LS meta，再回落 `isModelVisionSupported` 正则（`modelVisionSupport.ts:93-129` 仍不读 modalities）。**Composer 添加入口仍零感知**：`ComposePlusMenu.tsx:28-35`「添加文件」无模型能力禁用。`multimodal.ts:70-73` 非视觉路径仍把图片改写成文本 note（发送前 abort 后此枝成死代码，但入口未堵）。**Rust 出站仍无守卫**：`supports_image_input` 仍仅 `catalog_types.rs:233` 定义 + 测试。Wave 4 新增 `ensure_content_modalities`（`messages_content.rs:276-297`）标 `#[allow(dead_code)]`，全仓生产 0 调用。`HttpProviderCall::stream`（`engine_provider.rs:283-295`）只 `validate_reasoning_effort`，无 modalities 校验。 | **前端发送拦截：closed**。**Composer 入口 + Rust 出站守卫：still-open**（必核-8 整体 **still-open**） |
| **必核-9 / 09-DEF-01 / 09-DEF-03 / 08-2.2** | Composer / 模型选择器读 LocalStorage 孤岛，不订 `modelsCatalogStore` | `ComposerFusedTrigger.tsx:44,61-63,80`：`getActiveModelId` / `getActiveProfile` / `getModelMeta` / `setModelThinkingLevel`（全 LS）。`useChatModelPicker.ts:32-38` → `useModelSelection`；`ChatHeaderControls.tsx:60-67` `getActiveModelId` / `getActiveProfileId`。`ModelBadgePickerMenu.tsx:61-76` `listPickerProfiles()` + `getModelMeta`；`listPickerProfiles`（`modelCatalogIpc.ts:325-327`）→ `loadProfiles()` → `localStorage.getItem('crish_provider_profiles_v1')`（`profileStorePersistence.ts:38-79`）。Picker 只订 `model-meta-changed`（`useModelMetaTick.ts:18`），**不订** `profiles-changed` / `models-catalog-changed`。 | **still-open** |
| **09-DEF-04** | Rust `google/generate-content` vs TS `google/interactions`，`deny_unknown_fields` 会拒存 | `modelsCatalogTypes.ts:11-16` 现同时列出两者。`serializeModelsYamlTree`（`modelsCatalogIpc.ts:160-169`）写盘前把 `google/interactions` 归一成 `google/generate-content`。内核 `catalog_types.rs:110` 有 `alias = "google/interactions"`。**宿主 schema 未跟**：`models_yaml.rs:29-37` `ModelsYamlProtocol` 只有 `rename = "google/generate-content"`，**无 alias**。YAML 弹窗若手写 `google/interactions`，`workbench_validate/save` 仍会 unknown variant 失败。`modelsCatalogQuery.ts:17-21,80-82` 读出时又把 generate-content **映射回** `google/interactions`，门面双名仍在。 | **still-open**（写路径有归一，校验枚举未 alias） |
| **09-DEF-05** | `findCatalogModel` 只取 `globalModelIndex[0]` 跨厂商串线 | `modelsCatalogQuery.ts:151-187` 已支持 `providerId` 联合主键。**生产调用方仍不传**：`modelVisionSupport.ts:109` `findCatalogModel(rawModel)`；`modelsIpcHelpers.ts:161` 同。无 providerId 时仍 `[0]`（`:184`）。 | **still-open**（API 半闭合，调用未传 providerId） |
| **09-3.1** | `contextWindow` vs `contextLength` 撕裂 | `modelsCatalogQuery.ts:70,98-119` 用同一内部值做双向 getter。`serializeModelsYamlTree` `:178-179` 写盘统一 `contextWindow`。旧 `ModelMeta.contextLength` LS 契约仍在。 | **still-open**（门面别名补了，双轨未灭） |
| **09-DEF-06** | 删除模型只发 `profiles-changed`，Picker 不刷新 | `ModelBadgePickerMenu.tsx:59-64` 仍只依赖 `useModelMetaTick`（`model-meta-changed`）。`saveProfiles` 发 `profiles-changed`（`profileStorePersistence.ts:46`），Picker 未监听。 | **still-open** |
| **09-DEF-07** | `defaultThinkingLevel` 无法落入 yaml | `ComposerFusedTrigger.tsx:63,80` 仍读写 LS `defaultThinkingLevel`。`models.yaml` / `ModelSpec` 仍无该字段。 | **still-open** |
| **07-5.2** | 保存按钮 `variant="secondary"` + 内联绿底 `#fff` 打补丁 | `ModelConfigPanel.tsx:292-298` 现为 `<Button variant="primary" size="sm">`，无 inline style。 | **closed** |
| **07-4.4** | `.mrdCfgFooter` 无 sticky，保存按钮被挤出首屏 | `ModelsSettingsTab.module.css:438-441`：`position: sticky; bottom: -12px; backdrop-filter: blur(8px)`。 | **closed**（CSS 已加；真机视口未在本审计用 Tauri MCP 量） |
| **07-6.1** | `ModelThinkingEditor` 内嵌 Switch 自杀式 Unmount | `ModelThinkingEditor.tsx:27-29` `onEnabledChange` 改名为 `_onEnabledChange` 弃用；头部（`:89-99`）无 Switch，仅文案。启闭仍由外层 `CapEditor`（`ModelConfigPanel.tsx:244-277`）。 | **closed** |
| **07-5.3 / 07-3.3** | 魔术像素 10/5/26/22/20；裸写 `#10b981`/`#fff` | 仍在：`ModelsSettingsTab.module.css:408` `margin-top: 10px`；`:733` `border-radius: 5px`；`:739` `padding: 1px 7px`。`ModelThinkingEditor.tsx:140,154,166` height 26/22。`ModelConfigPanel.tsx:149` height 20px。`ModelModalitiesEditor.tsx:84`、`ModelPricingEditor.tsx:57` 仍 `var(--brand, #10b981)`。ConfigPanel 智能预填色已改 `hsl(160 84% 39%)`（`:152`）。目标 6 文件 `rgba(`：核心表单仍 0；`ManualAddForm.tsx:192`、`YamlConfigEditorModal.module.css` 多处 rgba 与 07 当时附注一致。 | **still-open**（主补丁两项已关；魔术像素与 HEX fallback 未清） |
| **07-4.1 / 07-4.2 / 07-4.3 / 07-2** | 协议上移、非思考隐藏、TitleCase、输入焦点 | 抽查：`ModelConfigPanel.tsx` 无 protocol 控件；思考区仍 `{cfgDraft.thinkingEnabled && (`（`:212`）；`STANDARD_THINKING_PRESET`（`ModelThinkingEditor.tsx:6-12`）仍 TitleCase。此项 07 已 PASS，未回潮。 | **stale** |
| **10-3.1 / 10-6.1** | 破损 YAML 不覆盖原文件；生产 0 unwrap | `migration.rs` 语法错误仍提前 `Err`；`models_yaml.rs:422-430` warn 后原样读出。pricing/migration 生产路径无 unwrap。原已 PASS。 | **stale** |
| **10-5.3** | `input` vs `input_per_m_tok` 双轨 Shim | `models_yaml.rs:110-137,317-325` v2 仍同时持有 `input` 与 `input_per_m_tok`，序列化未收敛为 alias-only。 | **still-open** |
| **10-6.2** | 迁移 `Err`（含备份校验失败）只 warn 继续按旧文件解析 | `models_yaml.rs:422-430` 仍 `Err(err) => tracing::warn!(...)`，不区分 `BackupVerificationFailed`。 | **still-open** |
| **08-3.2** | Composer 拖拽/加文件无视 modalities | `ComposePlusMenu.tsx:28-35` 未读 modalities。全 Composer 树无 `modalities` 引用（除 slashSendPreflight 发送时）。 | **still-open** |

本轮未发现 **worsened** 项。最接近的风险是 Wave 4 新增 `ensure_content_modalities` 再次成为带 `#[allow(dead_code)]` 的花瓶函数，与 06/08 当初的 `assemble_thinking_dialect` 同构——这是**新的伪连通实例**，但相对「完全无函数」并未让出站行为更差（出站仍无守卫）。

---

## 仍开放问题清单（同权，不写优先级）

1. **宿主未把 yaml 思考字典灌进请求选项**。`assemble_thinking_dialect` 虽在 builder 内，`HttpProviderCall::request_options` 不填 `thinking_map`/`thinking_format`；chat 生产必走前缀表兜底，用户自定义 High→`custom-wire` 不会出现在真实 HTTP 体。
2. **`EngineProviderConfig` 仍无 vendor/protocol/compat/thinking_map**。下游被迫 `infer_reasoning_vendor` + `bundled_catalog`；`live_catalog()` 仍 dead_code，热重载写入的 LIVE_CATALOG 不被请求路径消费。
3. **`url.contains` / 模型前缀启发式未拔除**（`compat.rs`、`vendor.rs`、`behavior.rs`、`cache_policy.rs`、`is_openai_o_series`、`MODEL_SERIES_CAPABILITIES`）。`resolve_*_from_compat` 只在单测里存在。
4. **生产 `to_chat_messages` 仍灌空 `WireCompat`**，`compat.thinking_format == deepseek` 在出站消息角色/推理键上不生效。
5. **全局请求头仍写死 `x-deepseek-harness-session-id`**。
6. **`ModelConfigPanel` 保存仍只写 LocalStorage**（`applyMetaForModel`），不调用 `modelsCatalogStore.updateModel` / `writeModelsYamlIpc`。设置 UI 与 `~/.conex/models.yaml` 脱节。
7. **`PricingEngine::calculate_cost` 仍无 session-loop / orchestrator / 工作台结算调用**；RunSnapshot 无 `CostBreakdown`；前端继续用 `pricingStore` JS 浮点估算。
8. **Composer / Picker / 设置列表仍以 `crish_provider_profiles_v1` + `crish_model_meta_v1` 为运行真源**；不订 `models-catalog-changed`；删模型后主界面下拉可不刷新。
9. **`models_yaml_read/write/reload` 未注册**。读回退用扁平 `models` 重建树，**忽略 Rust 已返回的 `providers`**，thinking/modalities/compat/真实 baseUrl 在 Store 镜像层被吃掉。
10. **Rust 多模态出站守卫未接线**。`ensure_content_modalities` dead_code；`supports_image_input` 生产 0 调用。纯文本模型若绕过前端 abort，仍会把 `image_url` 发给上游。
11. **Composer 添加文件 / 拖拽不读 modalities**，纯文本模型仍可把图片挂上附件栏，直到点发送才 abort。
12. **`findCatalogModel` 调用方不传 `providerId`**，跨服务商同名模型仍可能串线。
13. **`ModelsYamlProtocol` 无 `google/interactions` alias**；YAML 弹窗手写该字面量仍会被 `deny_unknown_fields`/unknown variant 拒存。
14. **价格字段双名 Shim、魔术像素、HEX `#10b981` fallback、迁移失败一律 warn 吞掉** 仍在。
15. **`defaultThinkingLevel` 仍只活在 LocalStorage**，yaml 契约无该字段。

---

## 没覆盖什么

- 未启动 Tauri / 未走 4000 MCP 做真窗口截图或发送抓包；07 sticky 与「首屏可点」只核了 CSS，未向量视口。
- 未跑 `cargo test` / vitest；单测存在性以源码为准，不以「全绿」代验收。
- 未审计 `reference/`、非本战役的 session 水合、OAuth、密钥 DPAPI。
- 未穷尽所有 `localStorage.getItem` 键（如 `crish_recent_models`）；只核模型/供应商/价格/思考消费链。
- 未验证 `reload_live_catalog` 在无请求消费下的并发正确性。
- 未对照用户磁盘上真实 `~/.conex/models.yaml` 做往返 round-trip。
- `convertFlatModelsToTree` 内按 vendor 名写死 openai/anthropic/deepseek baseUrl（`modelsCatalogIpc.ts:35-42`）作为读回退副作用，06 未单列，本轮记入仍开放 #9，未单独开新审计号。

---

## 给主控的总结

Wave 4（`f98b7f62`）**闭合的是模块内可单测的洞**，不是 06–10 所锁的端到端效果。

已可记 closed 的硬项：builder 层方言函数不再是零调用；手拼扁平 YAML 自毁降级删除；阶梯免费短路与 u64 饱和；魔鬼测试直连生产；capabilities 迁移与 Windows 三阶段替换；保存按钮 primary + sticky + 思考双重开关拆除；发送路径对非视觉模型 abort；`workbench_*_models_yaml` 已注册且 YAML 弹窗校验缺失 fail-closed。

**不得对外宣称「方言真接线 / 计费阶梯 / IPC 降级清除 / 多模态刚性守卫」已全线打通。** 宿主 `request_options` 仍把 `thinking_map` 留空，所以方言接线在真实出站是空转；计费引擎仍是测试孤岛；IPC 只拆了写降级、读回退仍可能把树打扁；多模态只在前端发送点 abort，Rust 新守卫再次 dead_code。主控下一轮若收口，必须把 **UI 保存 → yaml → live_catalog → EngineProviderConfig → request_options** 打成一条链，并让 `calculate_cost` 出现在 Run 收口，而不是再加一层只在单测里绿的函数。
