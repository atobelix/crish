# 供应商与模型能力统一 — 兼容 Shim、静默吞咽与无日期降级审计

> **文档编号**：`20-Audit-AntiShim-FailOpen`  
> **所属战役工作区**：`docs/provider-model-unification/audits/`  
> **审查角色**：Anti-Shim & Fail-Open Auditor（只读，不改源码）  
> **审计日期**：2026-09-08  
> **对齐**：`AGENTS.md` §7 禁补丁；`review.md` §6 错误治理（无日期 fallback=红）、§13 未接线标记趋势（新增=0）、§15.4 假收敛  
> **问题同权**：下表条目不按 P0/P1 砍项；红/黄仅表示纪律判定，不表示业务优先级。

---

## 一、总判色与给主控的一句话

**总判：红。**

本战役在注释与门面上大量宣称「彻底铲除 URL 盲猜 / 手拼 YAML 降级 / KNOWN_CONTEXT 128K / 双字段」，但生产热路径仍保留：

1. **无删除日期的 fallback 全表几乎全红**（本会话 grep `删除日期|sunset|remove by|until:` 于战役相关生产文件 **零命中**）；
2. **兼容双字段已成永久双读**（`input`∥`input_per_m_tok`、`capabilities.image`∥`modalities.input`、`defaultThinkingLevel`∥`thinking` map）；
3. **`checkModelVisionSupport` 三连 fallback 是伪连通**（catalog 契约 → meta → 模型名正则猜测）；
4. **`bundled_catalog()` 与 `live_catalog()` 双目录**：YAML 热重载只写 live，请求/校验/计费仍读编译期 catalog.json；
5. **迁移代码是每次读盘的运行时分支**，不是一次性离线工具。

不要把合理错误传播当成 shim。下列 **不算** shim：协议字段驱动的 dialect 分支、Anthropic 交替 user 占位、usage 可选 token 的 `unwrap_or(0)`、`String.normalize` 环境缺失、剪贴板失败并 `notify` 用户。

---

## 二、判定口径（本报告强制）

| 色 | 条件 |
| --- | --- |
| **红** | fallback/shim/降级 **无删除日期**；URL/模型名猜测驱动能力或协议；关键路径空 catch / `unwrap_or_default` 把致命错误变成空成功；宣称已删但符号仍在（§15.4）；迁移函数成为热路径永久分支 |
| **黄** | 一次性迁移（带幂等旗）或协议别名读入、写出口径已归一；空 catch 仅覆盖 localStorage quota / NFC；错误有日志但无用户面 |
| **绿** | 显式协议字段（`compat.thinkingFormat` / `Model.protocol` / `modalities.input`）驱动的分支；错误向上传播或分类拒绝（`DegradePolicy::Reject` 默认路径） |

**合法 vs 非法**：`compat.thinking_format == "deepseek"` 是合法协议字段；`url.contains("deepseek")` / `model.starts_with("gpt")` 是非法猜测。

---

## 三、Shim / Fallback 全表

> 删除日期列：**无** = review.md §6 红。测试文件另列于表末，不计入生产红数。

### 3.1 内核：URL / 模型名猜测（非法，红）

| # | 文件:行号 | 行为 | 删除日期 | 判定 |
| --- | --- | --- | --- | --- |
| S-01 | `crates/agent-provider/src/request/compat.rs:31-54` | `is_legacy_max_tokens_gateway`：vendor 未命中后仍 `url.contains("chutes.ai" \| "api.moonshot." \| "together.ai" \| …)` | 无 | **红** 非法 URL 猜测 |
| S-02 | `crates/agent-provider/src/request/compat.rs:94-111` | `resolve_max_tokens_field`：`url.contains("openai.com")` 或 `is_openai_o_series(model)` 决定 `max_completion_tokens` | 无 | **红** 注释自称「纯 URL/名子串」 |
| S-03 | `crates/agent-provider/src/request/compat.rs:121-131` | `resolve_max_tokens_field_with_compat`：`CompatSpec` 缺失时 **安全回落** 到 S-02 | 无 | **红** 协议字段有则合法，无则永久猜测 |
| S-04 | `crates/agent-provider/src/request/compat.rs:145-161` | `resolve_developer_role`：`vendor.contains("openrouter") \|\| url.contains("openrouter")` + `model.starts_with("anthropic/"\|"openai/")` | 无 | **红** |
| S-05 | `crates/agent-provider/src/request/compat.rs:169-180` | `resolve_developer_role_with_compat`：compat 未配则回落 S-04 | 无 | **红** |
| S-06 | `crates/agent-provider/src/request/vendor.rs:182-214` | `infer_reasoning_vendor`：`url.contains("anthropic"\|"deepseek"\|"openai"\|"gemini")` + `model.starts_with("gpt"\|"o1"\|"claude"…)` | 无 | **红** 热路径厂商推断 |
| S-07 | `crates/agent-provider/src/models/behavior.rs:310-359` | `infer_vendor`：与 S-06 同构的第二套 URL/前缀表（再加 minimax/x.ai/moonshot/z.ai/dashscope） | 无 | **红** 双实现猜测表 |
| S-08 | `crates/agent-provider/src/request/cache_policy.rs:541-606` | `infer_cache_capability` / `CACHE_CAPABILITY_TABLE`：无 catalog 时 URL 关键字 + 模型前缀最长命中；注释自称「降级为内置保守兜底」 | 无 | **红** |
| S-09 | `crates/agent-provider/src/request/cache_policy.rs:141-161` | `build_cache_policy`：`catalog=None` 走 S-08；`catalog=Some` 仍先 `infer_vendor(&url, &model)` | 无 | **红** catalog 在仍用 URL 猜 vendor |
| S-10 | `crates/agent-provider/src/request/vendor_capability.rs:104-168` | `infer_thinking_capability`：`MODEL_SERIES_CAPABILITIES` 模型名前缀最长命中（`gpt-5`/`claude-3-7`/`deepseek-r1`…） | 无 | **红** 与 YAML `thinking` map 并行 |
| S-11 | `crates/agent-provider/src/request/build_chat.rs:85-137` | 未配 `thinking_format`/`thinking_map` 时「兜底分支」：按 `vendor` 调 `reasoning_effort_object`，再按 **模型名** `infer_thinking_capability` 注入存量 `thinkingIntensity` | 无 | **红** 协议未配则猜测 |
| S-12 | `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs:78-101` | `catalog_vendor` / `max_tokens_field`：配置无独立 vendor 字段，经 S-06 猜 vendor 再调 S-02 | 无 | **红** 壳层消费猜测链 |
| S-13 | `crates/agent-provider/src/request/compat.rs:113` | 注释写「彻底杜绝 URL 盲猜」，同文件 43-49 行仍 `url.contains` | — | **红** §15.4 叙事与代码矛盾 |

### 3.2 内核：兼容双字段 / 双类型 / 双目录（永久双读，红）

| # | 文件:行号 | 行为 | 删除日期 | 判定 |
| --- | --- | --- | --- | --- |
| D-01 | `crates/agent-provider/src/models/catalog.rs:745-748,842-845,897-900` | `DynamicYamlPricing` 同时收 `input` 与 `input_per_m_tok`，`p.input.or(p.input_per_m_tok)` | 无 | **红** 永久双读，非一次性迁移 |
| D-02 | `apps/agent-workbench/src-tauri/src/models_yaml.rs:125-137,317-324` | `ModelsYamlPricingV2` 注释「兼容 v1 命名」；flatten 时 `p.input.or(p.input_per_m_tok)` 写回 **v1 字段名** `input_per_m_tok` | 无 | **红** 读 v2 再投影成 v1 形状 |
| D-03 | `crates/agent-provider/src/models/catalog.rs:751-759,866-870` | `DynamicYamlModalities { image, video, audio: bool }`；v2 契约是 `{ input: [...], output: [...] }`（`catalog_types.rs:238-248`）。serde 忽略未知键 → **数组形态永远解析成全 false** | 无 | **红** 假连通：内核读不到 YAML modalities |
| D-04 | `crates/agent-provider/src/models/catalog.rs:857-870` | `capabilities.image` 与错误形状的 `modalities.image` **或** 到 `supports_vision` | 无 | **红** 双轨能力位 |
| D-05 | `apps/agent-workbench/src-tauri/src/models_yaml.rs:327-337` | flatten 到 `ModelsYamlModel` **丢** `modalities` / `thinking` / `compat`（结构体无这些字段） | 无 | **红** 平铺门面致残 |
| D-06 | `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs:35-73,112-128` | `LIVE_CATALOG` 与 `BUNDLED_CATALOG` 并存；`effective_protocol` **只用** `bundled_catalog()` | 无 | **红** 热重载 live 不进请求 |
| D-07 | `apps/agent-workbench/src-tauri/src/engine_provider.rs:145-148` | `build_cache_policy(Some(bundled_catalog()), …)` | 无 | **红** 缓存策略读死表 |
| D-08 | `apps/agent-workbench/src-tauri/src/engine_provider/thinking.rs:86-91` | `validate_reasoning_effort` → `describe_model(bundled_catalog(), …)` | 无 | **红** 用户 YAML 档位白名单不生效 |
| D-09 | `apps/agent-workbench/src-tauri/src/engine_build.rs:945,1022-1038,1626` | TTL / 四价估算走 `bundled_catalog` | 无 | **红** 计费与 YAML 脱节 |
| D-10 | `crates/agent-provider/src/request/vendor/dialect.rs:19,33-36,129-155` | 新 `ReasoningEffort` + `LegacyReasoningEffort` + `ThinkingIntensity` 三套档位枚举，`From` 互转；`Auto→Medium` | 无 | **红** 改名≠收敛 |
| D-11 | `crates/agent-provider/src/request/vendor/reject.rs:40-48` | `DegradePolicy::AllowDegrade` 永久开关，保留旧钳制（xhigh→high）「供兼容调用方」 | 无 | **红** 默认 Reject 合法，开关本身是无日期兼容层 |
| D-12 | `crates/agent-provider/src/request/vendor.rs:316-347` | `normalize_thinking_intensity` 静默改档（xhigh→high、minimal→low） | 无 | **黄/红** 仅 AllowDegrade 消费则为黄；`resolve_thinking_params` 仍调用则为红 |
| D-13 | `crates/agent-provider/src/request/wire_protocol.rs:66-79,135-141` | `from_raw_str` 多别名；缺省 `unwrap_or(ProtocolKind::OpenAiChat)` | 无 | **黄** 别名读入可接受；缺协议静默 chat 为无日期降级 |
| D-14 | `crates/agent-provider/src/models/catalog.rs:392-397` | `load_user_catalog_or_default`：YAML 读失败 `unwrap_or_else` → **空目录** + warn | 无 | **红** §6 兜底值掩盖致命 IO/解析错误 |
| D-15 | `crates/agent-provider/src/models/catalog.rs:836` | `p.contains("responses")` 猜 `supports_responses` | 无 | **红** 协议字符串子串 |

### 3.3 迁移引擎：一次性转换 vs 永久运行时

| # | 文件:行号 | 行为 | 删除日期 | 判定 |
| --- | --- | --- | --- | --- |
| M-01 | `crates/agent-provider/src/migration.rs:58-177` | `ensure_migrated`：每次读盘检测扁平 `models:` 并改写为树 | 无（无「迁移窗口结束日」） | **红** 见 §六：已成为热路径 |
| M-02 | `crates/agent-provider/src/migration.rs:297-310,370-376` | vendor 空 → `"custom"`；缺 `baseUrl` → `default_base_url_for_vendor`；缺窗口 → **131072**；缺 max → **8192** | 无 | **红** 迁移期发明默认值（含 128K 近亲） |
| M-03 | `crates/agent-provider/src/migration.rs:389-397,502-538` | 仅 `capabilities.reasoning=true` 时 **发明** Low/Medium/High thinking map；`infer_compat_for_vendor` / `infer_protocol_for_vendor` 按 vendor 名填方言 | 迁移期可接受 | **黄** 一次性写盘后不再跑；但发明档位无日期 |
| M-04 | `apps/agent-workbench/src-tauri/src/models_yaml.rs:405-428` | 每次 `read_models_yaml_at` 调 `ensure_migrated`；失败仅 `tracing::warn` 后继续读原文件 | 无 | **黄** 损坏文件不覆盖（正确 fail-closed 写盘）；warn 后静默继续为可观测降级 |
| M-05 | `apps/crish-desktop/src/api/provider-profiles/migrateLegacyProfiles.ts:1-16,120-136` | 明文 apiKey → DPAPI，幂等旗 `crish_profiles_secrets_migrated_v1` | 无 sunset，但有完成旗 | **黄** 一次性；`degraded` 永不置旗 → 每启动重试，永久分叉风险 |
| M-06 | `apps/crish-desktop/src/api/modelCatalogMeta.ts:30-40` | `migrateLegacyCapabilities`：`vision`→`image` 读时搬移 | 无 | **黄** 幂等写回；键级一次性 |

### 3.4 前端：IPC 双命令 / 平铺门面 / 128K

| # | 文件:行号 | 行为 | 删除日期 | 判定 |
| --- | --- | --- | --- | --- |
| F-01 | `apps/crish-desktop/src/api/modelsCatalogIpc.ts:80-146` | `models_yaml_read` missing → `workbench_read_models_yaml`；平铺 `models` → `convertFlatModelsToTree` | 无 | **红** 双 IPC + 手拼树（审计 10 已点名，仍在） |
| F-02 | `apps/crish-desktop/src/api/modelsCatalogIpc.ts:25-75` | `convertFlatModelsToTree`：按 vendor 名 **猜** `https://api.openai.com/v1` 等；**不拷贝** thinking/modalities/compat | 无 | **红** URL 猜测 + 字段丢失 |
| F-03 | `apps/crish-desktop/src/api/modelsCatalogIpc.ts:251-285` | `models_yaml_write` missing → `workbench_save_models_yaml`（手序列化 YAML 字符串） | 无 | **红** 注释写「彻底铲除手拼」但 fallback 仍手拼 |
| F-04 | `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.tsx:105,257` | 编辑器 **直接** `workbench_read/save_models_yaml`，不走 `models_yaml_*` | 无 | **红** 第三套读写入口 |
| F-05 | `apps/crish-desktop/src/api/modelsCatalogTypes.ts:110-116,152-158` | `PricingConfig` 同时声明 `input` 与 `inputPerMTok`；`ModelSpec.capabilities` 标「兼容旧版只读」 | 无 | **红** 类型层永久双字段 |
| F-06 | `apps/crish-desktop/src/api/modelsCatalogQuery.ts:63-96` | 树→平铺门面：价格折成 `inputPerMTok`；`google/generate-content` **反映射** 为 `google/interactions` | 无 | **红** 写时归一、读时再拆开 |
| F-07 | `apps/crish-desktop/src/api/modelsCatalogSelectors.ts:47-53` | `selectEffectiveContextWindow` 缺窗口 → **`return 128_000`** | 无 | **红** 假删除 KNOWN_CONTEXT（见 §七） |
| F-08 | `apps/crish-desktop/src/api/modelsCatalogStore.test.ts:581-585` | 单测钉死 128000 与 `openai/chat` 最终回退 | — | **红** 陪葬测试保护死兜底 |
| F-09 | `apps/crish-desktop/src/api/modelCatalogPure.ts:257-273` | `guessContextLength`：注释「彻底废除 KNOWN_CONTEXT」；未命中 autofill → `undefined`（此函数本身绿） | — | **绿** 函数收敛；调用方 F-07 另红 |
| F-10 | `apps/crish-desktop/src/api/modelCatalogIpc.ts:94-146,229-287` | `catalog_refresh` / `catalog_get` 失败 → logger.warn + 静态表；`errorStore.push` 再套空 catch | 无 | **红** 命令缺失 fail-open 到静态表 |
| F-11 | `apps/crish-desktop/src/api/thinkingGear.ts:150-176` | `resolveCatalogEfforts`：快照未命中则正则 `/r1\|o1\|o3\|spark\|reasoner\|thinking\|claude-3-7/` **发明** off/low/medium/high | 无 | **红** 与「档位面板不再自造表」注释矛盾 |
| F-12 | `apps/crish-desktop/src/api/thinkingGear.ts:204-214` | `fetchDescribeEffortsSnapshot` catch → `false`（面板回落「默认」） | 无 | **黄** 有注释；无删除日期 |
| F-13 | `apps/crish-desktop/src/components/settings-models/useModelConfigSession.ts:97-149` | 价格 `input \|\| inputPerMTok`（`as any`）；`caps.image = capabilities.image ?? modalities.input.includes('image')`；`thinkingLevel: meta.defaultThinkingLevel` | 无 | **红** 三组双字段在同一保存会话 |
| F-14 | `apps/crish-desktop/src/components/settings-models/ModelModalitiesEditor.tsx:54-58` | 勾选 image/video 时 `onSyncCaps` **双写** capabilities | 无 | **红** 写路径维持双轨 |
| F-15 | `apps/crish-desktop/src/api/modelsCatalogIpc.ts:186-214` | 序列化时 `input ?? inputPerMTok` 写出 `input`（写归一、读仍双） | 无 | **黄** 写出口径正确；读侧 F-05 未删 |
| F-16 | `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx:219-244` | 「同厂商自愈降级」：当前模型停用则自动切同厂商另一模型 | 无 | **黄** 有用户 toast；仍是无日期自动切模（审计 04 禁令 4 相关） |
| F-17 | `apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx:44-49` | `FALLBACK_EMPTY_SELECTION` 空态假体 | — | **绿** UI 空态，非能力猜测 |
| F-18 | `apps/crish-desktop/src/api/modelsCatalogStore.ts:168-189` | IPC 失败 → 空树 + `lastError`，`ensureLoaded` 返回 false | — | **黄** 错误入状态；消费方若忽略 lastError 则 fail-open |

### 3.5 视觉三连 fallback（必判 3，专节）

见 **§五**。表项：

| # | 文件:行号 | 行为 | 删除日期 | 判定 |
| --- | --- | --- | --- | --- |
| V-01 | `apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts:54-78` | catalog `modalities.input` → meta `modalities.input` → `isModelVisionSupported` | 无 | **红** 伪连通 |
| V-02 | `apps/crish-desktop/src/api/modelVisionSupport.ts:18-129` | meta `capabilities.image` → 平铺 catalog `capabilities.image` → **负向/正向模型名正则** → false | 无 | **红** 非法名猜测；与 V-01 字段不一致 |
| V-03 | `apps/crish-desktop/src/api/modelVisionSupport.ts:5-9` vs V-01 | 文件头优先级（capabilities）与 preflight（modalities）**两套 SSOT** | — | **红** |

### 3.6 思考档位双字段

| # | 文件:行号 | 行为 | 删除日期 | 判定 |
| --- | --- | --- | --- | --- |
| T-01 | `apps/crish-desktop/src/api/modelCatalogTypes.ts:35` + `modelCatalogMeta.ts:292-297` | `defaultThinkingLevel` 存在 LS meta | 无 | **红** 与 YAML `thinking` map 并行 |
| T-02 | `apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.tsx:41-83` | UI 档位：`modelMeta.defaultThinkingLevel \|\| appSettings.defaultThinkingLevel` | 无 | **红** 第三源（全局 settings） |
| T-03 | `apps/crish-desktop/src/api/chat-bridge/streamSession.ts:106-107` | 出站：`sets.defaultThinkingLevel` → ReasoningEffort，**不读** YAML thinking map | 无 | **红** 配置中枢与请求脱节（审计 08 已报，仍在） |
| T-04 | `crates/agent-provider/src/models/catalog.rs:207-213` | 注释：`thinking_tiers` 取代旧双字段「不允许向后兼容多轨」 | — | **绿** catalog.json 侧已单源；前端 T-01 未跟 |

### 3.7 测试另列（不计入生产红，但保护死层者标陪葬）

| 文件:行号 | 说明 |
| --- | --- |
| `compat_tests.rs` / `compat.rs:226-252` | 单测 **要求** compat 缺失时回落 URL 网关判定 |
| `modelsCatalogStore.test.ts:581-585` | 钉死 128k / openai/chat 兜底 |
| `modelVisionSupport.test.ts` | 用模型名正则真值（`gpt-4o` true、`deepseek-chat` false），保护 V-02 猜测表 |
| `thinkingGear.test.ts:70` | 「失败降级 → false」 |
| `engine_provider_tests.rs:222` | 未收录模型 + Responses → 保守降级 chat |
| `migration_tests.rs` | 合法：测一次性迁移与破损文件不动 |
| `vendor_tests.rs` AllowDegrade | 保护 D-11 兼容开关 |

---

## 四、必判 1：每条 fallback 有没有删除日期

**结论：战役相关生产代码 0 条带删除日期。无日期 = 红（review.md §6）。**

本会话在下列路径 grep `删除日期|sunset|remove by|until:|FIXME.*20|TODO.*20`：**零命中**。

- `crates/agent-provider/src/request/{compat,messages_compat,vendor,cache_policy,vendor/dialect,vendor/reject}.rs`
- `crates/agent-provider/src/{migration,pricing,models/behavior,models/catalog}.rs`
- `apps/agent-workbench/src-tauri/src/{models_yaml.rs,engine_provider/**}`
- `apps/crish-desktop/src/api/{modelsCatalog*,modelCatalog*,pricing*,thinkingGear*,engineConfig*,modelVisionSupport*,provider-profiles*}`
- `slashSendPreflight.ts`、`settings-models/**`

注释里的「兼容 / 兜底 / 降级 / 向后兼容」全部没有 sunset。`DegradePolicy::AllowDegrade` 也没有关闭日期。

---

## 五、必判 2：兼容双字段 — 迁移期必要还是永久双读

### 5.1 `input` ∥ `input_per_m_tok`

| 层 | 证据 | 判定 |
| --- | --- | --- |
| Rust 真源契约 | `catalog_types.rs:318-323` **只有** `input`/`output`/`cache_read`/`cache_write` | 单源已存在 |
| YAML 动态解析 | `catalog.rs:745-748` 仍收 v1 名；`input.or(input_per_m_tok)` | **永久双读** |
| 壳 flatten | `models_yaml.rs:317-318` 把 v2 `input` **写回** `input_per_m_tok` 字段 | **反向投影，永久** |
| TS 类型 | `modelsCatalogTypes.ts:110-114` 两组字段并列，标「兼容历史」 | **永久** |
| UI 会话 | `useModelConfigSession.ts:101-104` `as any` 双读 | **永久** |
| 写出 | `modelsCatalogIpc.ts:190-193` 归一成 `input` | 写侧已收敛 |

**裁决**：不是「读旧盘一次」的迁移期 shim。v2 写出后，读路径与 flatten 仍认旧名，且 flatten 把新名折回旧名 → **永久双读 + 双向污染**。无删除日期 → 红。

### 5.2 `defaultThinkingLevel` ∥ `thinking` map

这不是同一概念的新旧名，是 **两条未汇合的真源**：

- YAML `model.thinking`：TitleCase → wire（`catalog_types.rs:209-214`），宣称 UI 唯一档位表；
- LS `ModelMeta.defaultThinkingLevel` + `appSettings.defaultThinkingLevel`：会话/全局默认档；
- 出站 `streamSession.ts:106` 只读 settings，不读 thinking map；
- Rust 请求面 `build_chat.rs:62` 要 `thinking_format`/`thinking_map` 才走 dialect；否则 S-11 猜测。

**裁决**：永久双轨，不是迁移别名。红。

### 5.3 `capabilities.image` ∥ `modalities.input`

| 写 | `ModelModalitiesEditor.tsx:54-58` 改 modalities 同时 `onSyncCaps({ image })` |
| 读（设置） | `useModelConfigSession.ts:141-142` `capabilities.image ?? modalities.input.includes('image')` |
| 读（发送守卫） | V-01 优先 modalities；V-02 优先 capabilities |
| 读（内核） | D-03 解析器 **认错 modalities 形状**，实际只吃 `capabilities.image` |

**裁决**：前端主动双写维持旧布尔；内核契约是数组但解析器是布尔。永久双读且形状不一致。红。

---

## 六、必判 3：`checkModelVisionSupport` 三连是否伪连通

调用序（发送拦截，`slashSendPreflight.ts:149-159`）：

```
hasImage
  → checkModelVisionSupport(activeModel, activeProfileId)
      ① modelsCatalogStore.modelIndex[profile::model].modalities.input.includes("image")
         否则 globalModelIndex[model][0] 同字段
      ② getModelMeta(profile, model).modalities.input
      ③ isModelVisionSupported(model, profile)
           a. getModelMeta.capabilities.image   ← 不是 modalities
           b. findCatalogModel(model).capabilities.image  ← 平铺门面无 modalities
           c. NON_VISION_MODEL_PATTERNS 模型名正则
           d. VISION_MODEL_PATTERNS 模型名正则
           e. false
```

**伪连通判定：是。**

1. **字段不一致**：①② 读 `modalities.input`；③ 读 `capabilities.image`。用户只改矩阵未同步 caps 时，① 可能 true、③ 走正则。
2. **catalog 未加载 / 空树**：`ensureLoaded` 失败得到空 index（F-18）→ ① 跳过 → ③ 正则。YAML 里 `modalities.input: ["text"]` 的自定义模型若名含 `gpt-4o` 会被 **放行传图**；名不含视觉关键词的多模态模型会被 **误拦**。
3. **内核不读同一契约**：D-03 导致 Rust `supports_vision` 几乎只来自 `capabilities.image`。前端拦了不等于后端拦（审计 08 已报后端零拦截）。
4. **`findCatalogModel` 跨厂首条**：③b 无 profile 时取 `globalModelIndex[0]`（`modelsCatalogQuery.ts:183-186`），同名模型可串厂。
5. **正则是非法猜测**：`modelVisionSupport.ts:18-85` 用 `/gpt-5/i`、`/claude-(3|sonnet|opus)/i` 等，与协议字段无关。
6. **文件头谎称 SSOT**：`modelVisionSupport.ts:5-9` 写「SSOT 权威判定」，preflight 又包了一层不同优先级。两个权威。

默认保守 `false` 本身不是 shim（避免 400），但 **夹在两层猜测之间** 使「YAML 契约驱动」成为假象。

---

## 七、必判 4：空 catch / swallow-ok

### 7.1 战役域生产（计入）

| 文件:行号 | 吞什么 | 后果 | 判定 |
| --- | --- | --- | --- |
| `profileStorePersistence.ts:45-49,134-138` | `emitUiEvent('profiles-changed')` 空 catch，注释 swallow-ok | 落盘成功但 UI/其它窗不同步；任务书点名的旧伤 **仍在** | **红** |
| `profileStorePersistence.ts:145-152` | `loadProfiles` JSON 坏 → 静默播种 `DEFAULT_PROFILES` | 用户档案被默认列表替换，无 toast | **红** fail-open 分叉 |
| `migrateLegacyProfiles.ts:159-168` | `security-migration-failed` 事件总线失败忽略 | 密钥迁移失败可无 UI | **黄** 有 logger.warn |
| `modelCatalogMeta.ts:65-67` | LS 解析失败 → `{}` | 全部 meta（含 image/思考默认）丢失且无提示 | **红** |
| `modelCatalogMeta.ts:80-82` | `saveMap` quota → ignore | 内存有、磁盘无，重启丢 | **黄** |
| `modelCatalogIpc.ts:124-126,143-145,250,265` | `errorStore.push` 再空 catch | 降级通知本身可被吞 | **黄** |
| `ModelsSettingsTab.tsx:211-213` | `listHostOpeners` 失败 swallow-ok | YAML 外部打开菜单变空，无提示 | **黄** |
| `ModelsSettingsTab.tsx:277-283` | reveal 失败再 fallback `openPathDefault` | 第二层有 notify | **绿** 最终有用户面 |
| `thinkingGear.ts:212-213` | catalog_get 失败 → false | 档位面板自造/仅默认（F-11） | **红**（与 F-11 叠加） |
| `pricingStore.ts:72-74,241-243,351-355` | LS 坏 → `DEFAULT_PRICES` / 乘数默认 | 用户价表静默变官方表 | **红** §6 兜底值误导 |
| `pricingStore.ts:381-383,409-411` | 写 LS 失败 ignore | 设置页以为已存 | **黄** |
| `engineConfigIO.ts:29-30,40-41` | recent-models 读失败 `[]` / 写 ignore | 非能力路径 | **黄** |
| `modelsCatalogIpc.ts:335-339` | 防抖保存回调抛错 `console.error` | 有日志 | **黄** |
| `modelsCatalogStore.ts:127-131` | store listener 抛错打 log | 单订阅者失败不影响落盘 | **绿** |

### 7.2 明确不算 shim（合理传播 / 环境缺失）

| 位置 | 理由 |
| --- | --- |
| `engineConfigHelpers.ts:35-36,79` | `String.normalize` / `new URL` 非法 → 返回分类错误 |
| `thinkingGear.ts:192-193` | NFC 环境缺失 |
| `useModelProfilesState.ts:58-59` | sessionStorage 读选中项，失败用其它源 |
| `ModelsSettingsTab.tsx:293-295` | 剪贴板失败 `notify(false)` |
| `engine_provider.rs:80-87` | 三件套缺失 → `None`（未就绪），不伪造配置 |
| usage `unwrap_or(0)`（`pricing.rs:402-405`） | 协议可选计数字段，缺省 0 是计量语义不是吞错误 |
| poison `into_inner`（`config.rs:478`） | 并发毒丸恢复，非业务 fallback |

### 7.3 `unwrap_or_default` 吞错误（Rust 战役热路径）

| 位置 | 判定 |
| --- | --- |
| `catalog.rs:394-397` `load_user_catalog_or_default` | **红** IO/YAML 错 → 空目录继续跑 |
| `catalog.rs:820` `m.id.or(m.model).unwrap_or_default()` 后 `continue` | **绿** 空 id 跳过条目，不把错目录当成功 |
| `migration.rs` 缺字段默认 custom/131072/8192 | **红** 见 M-02 |
| `protocol.rs:46` RwLock poison `into_inner` | **黄** 锁毒仍继续用 catalog |
| `wire_protocol.rs:141` 缺协议 → OpenAiChat | **黄** 静默默认协议 |

---

## 八、必判 5：迁移代码是否成为永久运行时分支

**是。**

1. **YAML v1→v2**：`read_models_yaml_at`（`models_yaml.rs:405`）**每次读**调用 `ensure_migrated`。已是 v2 则 `AlreadyUpToDate` 仍付解析成本。扁平文件在用户机器上会于任意一次打开设置时被改写。没有「迁移窗口结束后删除 `transform_flat_to_tree`」的日期。
2. **读路径双形态**：`parse_models_yaml` 同时接受 `providers` 树与顶层 `models` 数组（`models_yaml.rs:287-375`）。即使磁盘已全是 v2，**解析器永久保留 v1 枝**。前端 `convertFlatModelsToTree` 是同一枝的 TS 镜像。
3. **明文密钥**：`loadProfiles` 每次前置 `ensureLegacyProfilesMigration()`（`profileStorePersistence.ts:61`）。完成旗未置（含 `degraded`）则每启动跑 DPAPI。这是带旗的热路径，不是构建期脚本。
4. **vision→image**：`loadMap` 首次填内存缓存时迁移（`modelCatalogMeta.ts:59`）。进程级一次，但函数永驻读路径。

一次性迁移 **允许** 存在；不允许没有 sunset、且被每请求/每读盘调用。M-01/M-04/F-01 构成「迁移器 = 运行时兼容层」。

---

## 九、必判 6：假删除（「已废除」旁旧函数仍在）

| 宣称 | 证据仍在 | §15.4 形态 |
| --- | --- | --- |
| `messages_compat.rs:11-12,71`「彻底删除 `url.contains("deepseek")`」 | 同 crate `vendor.rs:188`、`cache_policy.rs:571`、`behavior.rs:316` 仍 `url.contains("deepseek")` | 删 A 留 A′（换文件） |
| `compat.rs:113`「彻底杜绝 URL 盲猜」 | 同文件 `43-49,105,156` | 注释撒谎 |
| `modelsCatalogIpc.ts:154,249,268`「彻底铲除手拼 flat / 绝不降级 v1」 | 同文件 `25-75,114-116,267-272` 仍 convert + workbench_save | 删 A 加 A′ |
| `modelCatalogPure.ts:258` / `modelsCatalogStore.ts:6`「彻底废除 KNOWN_CONTEXT 128K」 | `modelsCatalogSelectors.ts:52` `return 128_000`；测试钉死 | 改名≠收敛 |
| catalog.rs:207-211「thinking_tiers 单一载体，不允许向后兼容多轨」 | 前端 `defaultThinkingLevel` + `infer_thinking_capability` 前缀表 | 单源只在 JSON 结构 |
| `thinkingGear.ts:6,66`「不再自造静态档位表」 | `resolveCatalogEfforts` 166-174 正则发明四档 | 删表加正则 |
| `protocol.rs:11-12,63-67` 搬来 `bundled_catalog`，「T-24 后可换运行时」 | `live_catalog()` 已实现且 save 时 `reload_live_catalog`（`models_yaml.rs:479`），**请求仍 bundled** | 半拆未接线 |
| `wire_protocol.rs:7`「彻底根除 URL Substring 盲猜」 | 协议拼装函数本身合法；调用方 `catalog_vendor` 仍 URL 猜 | 下层干净、上层脏 |

`guessContextLength` 函数本身已不再返回 128K（绿），但选择器与迁移默认 131072 把假上限从「函数」搬到「调用方」——典型删 A 加 A′。

---

## 十、必判 7：未接线标记 Δ（§13 新增=0）

范围：本战役相关生产代码（测试与「临时文件 .tmp」原子写注释不计）。

| 标记 | 本战役生产命中 | 相对本战役新增代码 | 趋势 |
| --- | --- | --- | --- |
| `TODO` / `FIXME` / `hack` | **0**（agent-provider 战役文件、models_yaml、engine_provider、modelsCatalog*、thinkingGear、modelVisionSupport、settings-models 生产 ts） | 0 | 绿 |
| `未接线` | `slashSendPreflight.ts:330`（`core_compact_now` toast）；`YamlConfigEditorModal.tsx:122,149,262`（workbench_* 命令） | 设置页 3 条为战役面；compact toast 属 chat-stream 既有 | 黄（文案级，非新 TODO） |
| `降级`（注释/标识符） | 多：`cache_policy.rs:541`、`catalog_types.rs:139`、`vendor.rs`/`reject.rs` AllowDegrade、`engine_provider.rs:80`、`ModelsSettingsTab.tsx:9,219`、`modelCatalogIpc.ts` 静态表降级、`thinkingGear.test.ts` | **本战役实现波新增若干「降级」叙事与运行时枝** | **红** 上升 |
| `临时` | 仅原子写 `.tmp` / 测试 temp dir | 0 产品 shim | 绿 |
| `占位` | Anthropic user 占位（协议铁律）；凭证日志占位符 | 不算未接线 | 绿 |
| 无日期 fallback 条数（本表 S/D/F/V/T/M 红） | **≥40** | 本战役引入或未删的兼容层为主体 | **红** |

**§13 硬性「新增=0」**：TODO/FIXME/hack 面达标；**「降级」运行时路径与无日期 fallback 未达标**。不能用 TODO=0 冒充收敛。

无法与上一轮 07 量表做精确数字 Δ（本会话无该基线文件）。定性：审计 08/10（同日战役）已点名的手拼 YAML、128K、视觉正则、bundled_catalog **本轮代码仍在**，并多了 `live_catalog` 半接线与 `convertFlatModelsToTree`。

---

## 十一、双轨映射函数清单（给主控）

这些是「两套函数做同一判定」——收敛时应只留协议字段驱动的一条。

| 概念 | 路径 A（宣称真源） | 路径 B（猜测/旧轨） |
| --- | --- | --- |
| 厂商 | YAML `providers` 键 / `compat` | `infer_reasoning_vendor` ∥ `infer_vendor`（两份 URL 表） |
| max_tokens 字段 | `CompatSpec.max_tokens_field` | `resolve_max_tokens_field` URL/o-series |
| developer role | `CompatSpec.supports_developer_role` | `resolve_developer_role` openrouter URL |
| 思考方言 | `thinking_format` + `thinking` map → `assemble_thinking_dialect` | `infer_thinking_capability` + `reasoning_effort_object` + `thinkingIntensity` |
| 思考默认档 | YAML thinking 键集 | `defaultThinkingLevel`（meta + settings） |
| 缓存能力 | `cache_behavior_for(catalog)` | `infer_cache_capability` / `CACHE_CAPABILITY_TABLE` |
| 视觉 | `modalities.input` | `capabilities.image` + 正则 + 错误形状 `DynamicYamlModalities` |
| 上下文窗口 | `contextWindow` 声明值 | `selectEffectiveContextWindow` 128000；迁移 131072 |
| 协议 | `Model.protocol ≻ Provider.protocol` | `bundled_catalog` mode；未收录降级 chat；`p.contains("responses")` |
| models.yaml IO | `models_yaml_read/write` | `workbench_read/save_models_yaml` + 手拼 serialize |
| 模型目录 | `live_catalog`（YAML） | `BUNDLED_CATALOG`（catalog.json）——**生产走 B** |
| 价格字段 | `pricing.input` | `inputPerMTok` 双读 |
| Google 协议名 | 写出 `google/generate-content` | 平铺门面读回 `google/interactions` |

---

## 十二、给主控总结（只列证据，删除裁决在主控）

### 12.1 总判

战役 **未通过** Anti-Shim / Fail-Open 门。效果锁要求的「协议字段驱动、禁止 URL/模型名猜测」在 `messages_compat.is_deepseek` 与 `wire_protocol.build_endpoint_url` 两处局部兑现，**热路径其余猜测表全部还在，且无删除日期**。

### 12.2 建议主控亲自核的删除/收敛候选（08 清单，审计不删）

1. 删除或 sunset：`resolve_max_tokens_field` / `resolve_developer_role` 的 URL 回落；只留 `*_from_compat`，缺字段则 **拒绝或显式错误**，禁止猜。
2. 删除或 sunset：`infer_reasoning_vendor`、`infer_vendor`、`infer_cache_capability`、`infer_thinking_capability` 作为生产路径；vendor 必须来自 YAML provider id。
3. 接线：`effective_protocol` / `validate_reasoning_effort` / `build_cache_policy` / `engine_build` 计价改 `live_catalog()`；`bundled_catalog` 仅作缺文件时的只读种子并标日期。
4. 修 `DynamicYamlModalities` 为 `{ input: Vec<String>, output: Vec<String> }`，与 `ModalitiesSpec` 同构；删布尔 `capabilities.image` 热路径（或迁移写盘后拒绝旧键）。
5. 删 `selectEffectiveContextWindow` 的 `128_000`；缺窗口返回 `undefined`/`None` 并让 UI 显示「—」（与已收敛的 `guessContextLength` 一致）。改测试 581-585 行。
6. 删 `convertFlatModelsToTree` 与 `models_yaml_read`→`workbench_read_*` 回落；Yaml 编辑器改走同一 `models_yaml_*`。给 `ensure_migrated` 写删除日期：v2 全量后解析器去掉顶层 `models:` 枝。
7. 价格类型去掉 `inputPerMTok` 等别名；flatten 停止写 v1 字段名。
8. `checkModelVisionSupport` 只读 `modalities.input`（及内核同构字段）；删除 `isModelVisionSupported` 正则表；缺字段 → 保守 false **并** 可观测（toast 已有，勿再 regex true）。
9. 思考出站只消费 YAML thinking map + 用户显式档；删除 `resolveCatalogEfforts` 正则保底与 `AllowDegrade`（或标删除日期且生产默认不可达）。
10. `profileStorePersistence` 的 emitUiEvent / 坏 JSON 播种：失败要进 errorStore，禁止静默 DEFAULT_PROFILES。

### 12.3 不要误删

- Anthropic 交替 user 占位、DeepSeek tool-call 空 `reasoning_content` 键（协议强制，不是降级）。
- `CompatSpec` 本身、`assemble_thinking_dialect` 的 format 分支（字段驱动）。
- 原子写 `.tmp`、测试临时目录。
- `engineConfig` 剥离 apiKey（反兼容，K-01，绿）。
- 凭据「内存降级」在非 Windows 无 DPAPI 时的平台路径（需产品裁决，非本战役 URL shim）。

### 12.4 与同日审计 08/10 的关系

本报告不重复 08 的「保存写 LS 不写 YAML / PricingEngine 零生产调用 / assemble_thinking_dialect 孤岛」全文，但 **视觉伪消费、bundled_catalog、手拼 YAML** 在 08/10 点名后源码仍在。§15.4：若实现波宣称已按 10 的「斩断前端手拼」关账，本 grep 构成假关证据。

---

_审计完成。只读，未改生产源码。产出仅本文件。_
