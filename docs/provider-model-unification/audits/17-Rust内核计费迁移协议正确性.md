# 17 — Rust 内核计费 / 迁移 / 目录契约 / 出站协议正确性审计

> **角色**：Rust Kernel Correctness Auditor（只读，不改源码）  
> **日期**：2026-09-08  
> **范围**：Wave 1–4 落入的 `crates/agent-provider` 计费、迁移、目录契约、出站协议；宿主接线 `apps/agent-workbench/src-tauri` 仅作「是否真正消费内核」判定。不审前端 UI。  
> **对账基准**：`docs/provider-model-unification/audits/10-反打补丁与异常韧性深度审查.md` 四条红项必须按**当前代码**重判。

---

## 一、总裁决

**Wave 4 把 10 审计里两条硬逻辑红项修进了函数体（免费阶梯短路、capabilities 迁移拷贝），Windows 落盘从「先删后 rename」升级为自写 3 阶段替换，魔鬼测试也改挂生产模块。这些是真修，不是文档宣称。**

**但不能宣布「内核计费 / 目录 / 出站协议已打通」。当前最大断层不在公式，而在接线：**

1. 运行时 `~/.conex/models.yaml` 快照（`live_catalog`）写了、重载了，**请求热路径零读取**；协议、缓存、思考白名单全部走编译期 `catalog.json`（`bundled_catalog`）。
2. `thinking` 拍平字典与 `ensure_content_modalities` 都在 builder / messages 层实现并有单测，**宿主 `request_options` 不填 `thinking_map` / `thinking_format`，`to_chat_messages` 不调用模态守卫**——Wave 4 新增能力对生产出站是死代码。
3. 目录契约三套并行且不同构：`catalog_types::ModelSpec`、`models_yaml` V2、`ModelCatalogEntry` + `DynamicYaml*`。`capabilities` / `modalities.input|output` / `pricing.tiers` 在迁移层能保住，进 `UnifiedModelsConfig` 或 live 解析时被静默丢掉。
4. 计费存在**双实现语义分叉**：`PricingEngine`（微元、扣减 cacheRead、饱和）vs `ModelPricingSpec::calculate_cost`（f64、不扣减 cacheRead、无阶梯）。`From<ModelPricingSpec>` 还把 `tiers` 清成空向量。

**裁决等级：内核函数体硬化通过；全链路正确性未通过。禁止以本轮单测全绿代替「yaml 真源驱动请求 / 结算」。**

---

## 二、本会话验证口径（源码形状 ≠ 真跑绿）

| 项 | 口径 | 结果 |
| :--- | :--- | :--- |
| 源码穿透 | 必读文件全量精读 + 宿主接线 grep | 完成 |
| `cargo test -p agent-provider pricing -- --nocapture` | **本会话真跑** | lib 命中 30 通过；devil 套件因 filter 只跑到 3 条（随后补跑全套） |
| `cargo test -p agent-provider --lib catalog_types` | **本会话真跑** | 4 通过 |
| `cargo test -p agent-provider --lib migration` | **本会话真跑** | 11 通过（含 Wave 4 hardening：capabilities / atomic_replace） |
| `cargo test -p agent-provider --test devil_cases_tests` | **本会话真跑** | 28/28 通过 |
| workbench / session-loop 结算接线 | 只 grep，未跑宿主集成 | `PricingEngine` / `CostBreakdown` 在 `apps/agent-workbench` **零引用** |
| 重叠阶梯 / TOCTOU 备份 / live 热路径 | 无生产测试覆盖 | 见「未跑的测试」 |

---

## 三、与 10 审计四条红项对账（必须重判）

| 10 审计红项 | Wave 4 自称 | **当前代码判定** | 证据 |
| :--- | :--- | :--- | :--- |
| **免费首档短路导致后续阶梯永不生效** | 已修 | **已修，函数体 + 单测钉死** | `pricing.rs:283-291` 增加 `pricing.tiers.is_empty()`；`pricing_tests.rs:642-692` 用「基础 0 + 32_768 阶梯、prompt=100_000」断言 `is_free == false` 且 `total_micros == 640_000`。本会话该测试绿。 |
| **Windows 非原子替换（先 `remove_file` 再 `rename`）** | 已修 | **部分修：窗口从「目标已删」变成「目标改名到 `.roll.bak`」，仍不是 conex-fs** | `migration.rs:219-252` 三阶段：`rename(target → roll.bak)` → `rename(tmp → target)` → 失败回滚。**未**调用 `conex_fs::atomic_write_file`；tmp 无 `sync_all`；无 `Drop` 回滚；进程在阶段 1 成功后崩溃时目标路径空洞，数据在 `{name}.{pid}.roll.bak`，下次启动不会自动回滚。宿主保存面 `models_yaml.rs:475` 才走 conex-fs。 |
| **capabilities 遗漏** | 已修 | **迁移变换层已修；契约层仍丢** | `migration.rs:438-456` 拷贝 `capabilities` 并吸收扁平 `tools/image/video`；hardening 单测 `migration.rs:585-665` 绿。但 `catalog_types::ModelSpec`（`catalog_types.rs:194-218`）**没有** `capabilities` 字段，`serde` 默认忽略未知键，`UnifiedModelsConfig` 往返会静默丢弃。 |
| **备份时间戳碰撞** | 未明确宣称修 | **未修实质竞态** | 仍是秒级 `%Y%m%d_%H%M%S`（`migration.rs:254-263`）+ `exists()` 后自增 `_1/_2`（`195-202`）再 `fs::copy`。TOCTOU 仍在；函数名 `current_local_timestamp` 实际用 Unix UTC（`secs/86400` + `secs/3600%24`），中国 UTC+8 凌晨 0–8 点备份日期会落到前一日。 |

**10 审计另外两条（前端手拼 YAML、devil 替身）不在本内核审计主范围，但接线事实如下：**

- devil 替身：**已拆**。`tests/devil_cases_tests.rs:9-14` 现 `use agent_provider::pricing::*` / `migration::*` / `catalog_types::*`，本会话 28/28 绿。Case 28 仍只断言 `is_some()`，饱和到 `u64::MAX` 的硬钉在 `pricing_tests.rs:698-749`，不在 devil。
- `models_yaml_write`：**内核仍未注册**。`main.rs` 只有 `workbench_save_models_yaml`。这是宿主命令面缺口，不是 pricing/migration 公式问题。

---

## 四、正确性缺陷清单（按严重度，均带文件:行号）

### 严重（热路径行为与宣称契约相反）

| ID | 缺陷 | 位置 | 为什么是正确性问题 |
| :--- | :--- | :--- | :--- |
| **K-01** | live 快照 vs 编译期目录：请求构建读错真源 | `engine_provider/protocol.rs:35-61`（`LIVE_CATALOG` / `live_catalog` / `reload_live_catalog`）；`protocol.rs:112-129` `effective_protocol` 调 `bundled_catalog()`；`engine_provider.rs:147-148, 154-162` `request_options` 同样 `bundled_catalog()`；`thinking.rs:86-91` 思考白名单也是 bundled；`engine_build.rs:1038-1040` 浪费预警价也是 bundled。全仓 `live_catalog()` **除定义外零调用**，仅 `models_yaml.rs:479` 在保存后 `reload_live_catalog()`。 | 用户改 `models.yaml` 的 protocol / thinking / pricing / modalities，运行时请求仍按 `include_str!("catalog.json")`（`catalog.rs:350-357`）决策。热重载是空转。 |
| **K-02** | yaml `thinking` 拍平字典未进入出站请求 | `engine_provider.rs:154-162`：`ChatCompletionsRequestOptions` 用 `..Default`，**不填** `thinking_map` / `thinking_format`。builder 本身会消费它们：`build_chat.rs:62-83`、`build_responses.rs:100-127`、`dialect.rs:213-229`。未配置时 `build_chat.rs:85-150` 掉进 `infer_thinking_capability(model_name)` 启发式。 | Wave 4 拍平字典在单测里是活的（`build_chat.rs:280-294`），生产宿主永不传入，出站思考参数不跟 yaml 走。 |
| **K-03** | 多模态 content parts 未按 modalities 过滤 | `messages_content.rs:271-297` `ensure_content_modalities` 标 `#[allow(dead_code)]`；`messages.rs:40-43` 的 `pub use` **不含**该函数；`messages.rs:376-384` user 消息直接 `user_message_content(message)`，有 `image_url` 就进 wire。 | 纯文本模型仍会把图片 part 发给上游。Devil Case 08（`devil_cases_tests.rs:297-311`）只断言 `ModelSpec::supports_image_input()` 返回 false，**从未调用守卫，从未构建请求体**。 |
| **K-04** | 双 `calculate_cost` 语义分叉 | `catalog_types.rs:336-357` `ModelPricingSpec::calculate_cost`：f64，**不对 cacheRead 做 prompt 扣减**，无 NaN 过滤，无饱和，无 tiers。`pricing.rs:274-377` `PricingEngine::calculate_cost`：微元，`saturating_sub` 扣减（`355`），四维独立乘算。测试 `catalog_types.rs:485` 用 spec 路径算 `1M input + 2M cache_read`，把 cache 段**按全价 input 再加一遍**。 | 同一组 token 走两条 API 账单不同。权威入口若被误用 spec 方法，缓存会话会系统性高估。 |
| **K-05** | `From<ModelPricingSpec>` 丢弃阶梯 | `pricing.rs:121-136`：`tiers: Vec::new()`。`ModelPricingSpec`（`catalog_types.rs:318-334`）本身没有 `tiers` 字段。 | `calculate_cost_from_spec`（`pricing.rs:380-394`）永远看不到阶梯。yaml/TS 的 `pricing.tiers` 无法进入引擎。 |

### 高（契约不同构 / 迁移保真在下一层丢失）

| ID | 缺陷 | 位置 | 说明 |
| :--- | :--- | :--- | :--- |
| **K-06** | `catalog_types::ModelSpec` 与 yaml/TS 不同构 | Rust `catalog_types.rs:194-218`：无 `capabilities` / `headers` / `compat` / `enabled`；`pricing` 无 `tiers`；`display_name`/`context_window`/`max_output_tokens` 为必填。TS `modelsCatalogTypes.ts:123-161`：有 `capabilities`、`compat`、`enabled`、`contextLength` 别名；`PricingConfig.tiers` 字段名是 `inputCost`/`outputCost`（`79-87`），Rust `PricingTier` 是 `input`/`output`（`pricing.rs:82-95`）。`ThinkingFormat`：TS 有 `'google' \| 'custom' \| 'qwen_enable_thinking'`（`29-36`），Rust 序列化为 `"gemini"`（`catalog_types.rs:168-170`）。 | 宣称「与 TypeScript 镜像 100% 同构」（TS 文件头 / `ModelSpec 100% 同构` 注释）不成立。 |
| **K-07** | live YAML 解析把 `modalities: {input, output}` 读成 bool 旗标 | `catalog.rs:751-759` `DynamicYamlModalities { image, video, audio: bool }`；`866-870` 只读这三个 bool。v2 真源是 `input: [text, image]`（`catalog_types.rs:242-248`）。serde 忽略未知键 `input`/`output`，三个 bool 默认 false。 | 即便将来接上 `live_catalog`，视觉模型在 yaml 里声明了 `input: [image]` 仍会变成 `supports_vision = false`（除非另有 `capabilities.image`）。 |
| **K-08** | 两套阶梯模型并存且匹配规则不同 | 引擎：`PricingTier.input_tokens_above` + 倒序 `>=` 后 `break`（`pricing.rs:335-351`）。目录：`TieredPriceTier` `[min, max)` 半开、**数组原序 first-match**（`catalog_price.rs:66-73`）。`input_price_for_tokens`（`catalog.rs:599-609`）走后者。浪费预警（`engine_build.rs:1021-1024`）明确「tieredPricing 长档匹配归演进项」，只用基础四价。 | 长上下文 2x 档在目录查询面存在，在 `PricingEngine` 与宿主结算面不存在。DEEPCHECK-05 已承认低估，Wave 4 未收敛。 |
| **K-09** | 迁移 3 阶段替换未复用 conex-fs，崩溃窗口仍在 | `migration.rs:161-164` `fs::write(tmp)` 无 fsync；`219-252` 自写 `atomic_replace`。conex-fs 对照：`crates/conex-fs/src/atomic_write.rs:1-10, 186-195` 有 `sync_all` + `Drop` 回滚。`235-237` 若 `{name}.{pid}.roll.bak` 已存在则直接 `remove_file`，可能删掉上一次崩溃留下的唯一副本。 | 10 审计要求「对齐 conex-fs」。当前是平行实现，Windows 目标空洞窗口从「已删除」缩小为「改名到 roll.bak」，不是关闭。 |

### 中（边界 / 命名 / 测试资产偏弱）

| ID | 缺陷 | 位置 | 说明 |
| :--- | :--- | :--- | :--- |
| **K-10** | 备份时间戳：UTC 冒充 local + 秒级 TOCTOU | `migration.rs:189-202, 254-263` | 自增后缀只能挡单进程同秒；`fs::copy` 前无 `create_new`。UTC vs 本地日期会让备份文件名与用户墙钟不一致。 |
| **K-11** | 重叠 / 同门槛阶梯：`sort_by` 不稳定 | `pricing.rs:337-338` 用 `sort_by` 而非 `sort_by_key` 稳定序 | 两档 `input_tokens_above` 相同则赢家无定义。无测试。目录侧重叠区间同样 first-match 无告警（`catalog_price.rs:70-72`）。 |
| **K-12** | `PerImage` / `PerRequest` 架空四维与阶梯 | `pricing.rs:293-327` 在阶梯检索之前 return | PerImage 用 `completion_tokens` 当张数；PerRequest 用 `input.max(output)` 单值。有阶梯的「低用量免费、超量按张」无法表达。 |
| **K-13** | 免费首档用量命中后 `is_free` 仍为 false | `pricing.rs:367-376` 阶梯路径恒 `is_free: false`；测试 `pricing_tests.rs:681-691` 断言 `formatted_total == "¥0.0000"` 而非 `"免费"` | 与「显式全 0 且无阶梯 → 免费」（`283-291`）有意区分，但 UI 若只看 `is_free` 会把免费额度内的调用显示成「¥0.0000 非免费」。属语义需锁，不是回归。 |
| **K-14** | thinking 键空间双轨 | yaml/ModelSpec：TitleCase `Low`（`catalog_types.rs:209-215`，迁移 `389-393`）。catalog.json：lowercase `thinkingTiers.low`（例 `catalog.json:43-49`）。`parse_thinking_value`（`catalog.rs:773-790`）原样保留键。`describe_model` 白名单用 bundled 小写键（`capability.rs:87-93`）。 | 同一档位在 yaml 与 catalog.json 不能直接 `eq`。 |
| **K-15** | `catalog.json` 推导因子 0.1 是元数据，不是运行时隐藏公式 | `catalog_price.rs:43-44` `cache_read_factor`；例 `catalog.json:4767-4772` qwen 派生条 `cacheReadPrice: 1.2` 且 `cacheReadFactor: 0.1` | **计费函数没有 `cacheRead = input * 0.1`。** 绝对价已写入 `cacheReadPrice`。反例：`deepseek-v4-flash` `inputPrice: 0.14` / `cacheReadPrice: 0.0028`（`catalog.json:556-558`）= 0.02x，不是一折。四维独立在引擎层成立。 |
| **K-16** | Devil Case 05「中文键拦截」不断言失败 | `devil_cases_tests.rs:237-254`：serde 若接受中文键，测试**要求** `has_illegal_key == true`，并不 `assert!(res.is_err())` | 白名单拦截未实现；测试在「接受非法键」时通过。 |
| **K-17** | `PricingEngine` 未接到宿主结算 | workbench 全仓无 `PricingEngine`/`CostBreakdown` 引用；浪费预警用 bundled 基础四价的 f64 乘除（`engine_build.rs:1041-1044`） | 微元引擎是库内闭环。会话账单若在别层用 spec.f64 或前端自算，内核定点不生效。 |
| **K-18** | 坏 YAML：迁移不动原文件（正确）；宿主吞掉非语法迁移错误 | `migration.rs:68-71` 语法错误直接 `Err`，本会话 `test_invalid_yaml_syntax_returns_error_and_preserves_file` 绿。`models_yaml.rs:422-428` 对**任何** `ensure_migrated` Err 只 `warn`，含 `BackupVerificationFailed` / `LossyMigrationDetected`。 | 10 审计 §6.2 中风险仍在。语法损坏安全；备份校验失败用户无感知。 |

---

## 五、必查 9 项逐条结论

### 1. 四维独立单价（input / output / cacheRead / cacheWrite）

**引擎层：独立。无 `cacheRead = input * 0.1` 运行时假定。**

- 结构注释写明「绝非固定一折」（`pricing.rs:110-111`，`catalog_types.rs:325-326`）。
- 乘算四路分开（`pricing.rs:357-360`），缺省 `unwrap_or(0.0)`，**不会**回落到 `input * 0.1`。
- `catalog.json` 存绝对价；`derivation.cacheReadFactor` 只解释派生条怎么来的，`PricingEngine` 不读它。
- DeepSeek 测试用 `cache_read: Some(0.10)` 对 `input: 3.00`（约 1/30，不是 1/10），`pricing_tests.rs:7-41`，本会话绿。

**仍有的非独立点：** `PerRequest` 用 `input.max(output)`（`pricing.rs:314`）；`From<ModelPricingSpec>` 把 `per_image` 塞进 `output`（`123-124`）。这是单位折叠，不是 0.1 隐藏公式。

### 2. 微元定点：溢出 / NaN / 负单价 / `u64::MAX`

**`PricingEngine` 分支已硬化，本会话 `test_u64_max_extreme_token_saturation_anti_wrapping` 绿。**

| 分支 | 行为 | 行号 |
| :--- | :--- | :--- |
| 空配置 | `None`（静默） | `281` |
| 显式免费 | 仅当 `tiers.is_empty()` 且四价均为 0 | `283-291` |
| PerImage | `u128` 乘积 `.min(u64::MAX as u128)` | `293-298` |
| PerRequest | `f64_to_micros` 已钳 `u64::MAX` | `312-315, 451-460` |
| Per1m + 阶梯 | 倒序匹配后四维 `tokens_to_micros` + `saturating_add` | `329-365` |
| cacheRead > prompt | `saturating_sub` → 普通输入 0 | `355` |
| NaN / Inf / 负费率 | 直接 0 | `438-440, 451-453` |
| `tokens_to_micros` | `saturating_add(500_000)` 后 `/ 1e6` 再 `min(u64::MAX)` | `443-446` |

`ModelPricingSpec::calculate_cost` **没有**上述任何防护（见 K-04）。

### 3. 阶梯 `PricingTier`：重叠、无序、免费首档短路

- **无序：** 每次 `clone` + 倒序排序（`337-338`），乱序配置可匹配。`test_multi_tier_descending_matching` 绿。
- **短路：** Wave 4 已加 `tiers.is_empty()` 门闩。`test_base_price_zero_with_tiers_not_short_circuited_as_free` 绿。**10 审计核心红项关闭。**
- **重叠 / 同门槛：** 不稳定排序，未测（K-11）。
- **字段继承：** 阶梯 `cache_read`/`cache_write` 为 `Option`，`None` 保留基础费率（`343-348`）。正确。
- **与目录阶梯未合并：** 见 K-08。

### 4. 迁移 `ensure_migrated`

| 问题 | 判定 |
| :--- | :--- |
| 坏 YAML 是否动原文件 | **不动。** `68-71` 解析失败即返回；测试 `migration_tests.rs:305-322` 本会话绿。 |
| 原子写 | **自写 3 阶段，不是 conex-fs**（K-09）。成功路径单测 `test_atomic_replace_clean_commit_and_cleanup` 绿（无崩溃注入）。 |
| capabilities | **变换层保留**（`438-456`），hardening 测试绿；**`UnifiedModelsConfig` 类型会丢**（K-06）。 |
| thinking 拍平 | `reasoning: true` 或 `capabilities.reasoning` → `{Low,Medium,High}`（`378-398`）。已有 thinking 对象则原样拷贝，**不会**把嵌套 `levels:` 拍平。 |
| modalities | 已有则保留；否则从 `capabilities.image/video` 补 `input` 数组（`400-425`）。 |
| 完整性 | 模型数 + ID 集合校验在写盘前（`106-148`）。失败时备份可能已生成、原文件未覆盖。 |
| 幂等 | v2 `providers` 且无顶层 `models` 数组 → `AlreadyUpToDate`（`89-91`）。测试绿。 |

### 5. `catalog_types` ↔ yaml ↔ 前端 `modelsCatalogTypes` 同构？thinking 是否真拍平？

**不同构。thinking 在 ModelSpec 层是真拍平，全链路不是单一形状。**

- `ModelSpec.thinking: Option<IndexMap<String, String>>`（`catalog_types.rs:215`）：无 `levels` 包装。JSON 样例测试断言 `!serialized.contains("\"levels\"")`（`501`），本会话绿。
- `ThinkingMapExt` 按 TitleCase 键取 wire（`372-394`）。
- 宿主 `ModelsYamlModelV2.thinking` 是 `Option<serde_yaml::Value>`（`models_yaml.rs:156`），不强制拍平。
- live 解析 `parse_thinking_value` 接受 Mapping / Sequence / `true`（`catalog.rs:773-808`），键不规范成 TitleCase。
- catalog.json `thinkingTiers` 是 lowercase + `Option<String>` 可隐藏档（`catalog.rs:47-52, 276-281`）。
- 前端 `ThinkingMap = Record<string, string>`，档位联合类型含 `XHigh`（`modelsCatalogTypes.ts:19-26`），迁移写入 `X-High` 需 dialect 特判（`dialect.rs:217-220`）。

### 6. live 快照 vs 编译期 `catalog.json`：运行时请求读哪个？

**读编译期 `catalog.json`。live 是死快照。** 见 K-01。

`ModelCatalog::load_user_catalog_or_default`（`catalog.rs:392-398`）只在 `live_catalog()` 初始化用；`effective_protocol` / `request_options` / `validate_reasoning_effort` / 浪费预警全部 `bundled_catalog()`。

`bundled()` 对 `include_str!("catalog.json")` 使用 `expect`（`catalog.rs:351-352`）——损坏内置表会在首次 lookup panic。这是启动期、可被 serde 全量解析测试钉死，不算请求热路径随机 panic。

### 7. 出站：thinking 字典、多模态 parts 是否按 modalities 过滤？

**thinking 字典：builder 支持，宿主未传（K-02）。**  
**modalities 过滤：函数在、测试在、生产调用链不在（K-03）。**

`user_message_content`（`messages_content.rs:176-226`）只按 `metadata.contentParts` 是否含 `image_url` 决定 Parts vs Text，不读模型 modalities。

### 8. `unwrap` / `expect` 热路径 panic

| 文件 | 生产路径 |
| :--- | :--- |
| `pricing.rs` | **0** unwrap/expect |
| `migration.rs` 生产函数 | **0** unwrap/expect（`unwrap_or` / `unwrap_or_default` 仅缺省） |
| `wire_protocol.rs` / `build_chat.rs` / `build_responses.rs` / `compat.rs` / `messages_content.rs` | **0** unwrap/expect |
| `catalog.rs::bundled` | `expect` 解析内置 JSON（启动/首次，非每请求） |
| `protocol.rs:46` | `LIVE_CATALOG.write().unwrap_or_else(poison → into_inner)`，且 `live_catalog` 本身未被调用 |

**计费/出站构建热路径无 unwrap panic。** 符合 10 审计 §6.1 对这三文件的原结论，Wave 4 未引入新的热路径 unwrap。

### 9. 双实现：`catalog_types::calculate_cost` vs `PricingEngine::calculate_cost`

**不是同一算法的两个入口，是两套账。**

数值反例（prompt=100_000，cache_read=80_000，input=3.0，cache_read 价=0.10）：

| 实现 | 输入段 | cache 段 | 合计（仅这两维） |
| :--- | :--- | :--- | :--- |
| `PricingEngine` | 20_000 × 3 / 1M = 0.06 | 80_000 × 0.10 / 1M = 0.008 | **0.068**（`pricing_tests.rs:28-33`，本会话绿） |
| `ModelPricingSpec::calculate_cost` | 100_000 × 3 / 1M = 0.30 | 80_000 × 0.10 / 1M = 0.008 | **0.308**（cache 段按全价 input 重复计） |

`PricingEngine::calculate_cost_from_spec` 走引擎（扣减正确）但 **丢阶梯**（K-05）。  
公开的 `ModelPricingSpec::calculate_cost` 仍在类型上引诱误用。

---

## 六、出站协议其余观察（非 10 红项，但属本范围）

1. **三级协议决议纯函数是干净的**：`resolve_effective_protocol`（`wire_protocol.rs:135-142`）= Model ≻ Provider ≻ `openai/chat`，无 URL 猜测。`build_endpoint_url`（`166-201`）按协议拼路径。
2. **消费点把决议结果部分作废**：`effective_protocol`（`protocol.rs:112-129`）对 anthropic/gemini 用 bundled 的 `mode`；chat/responses 再套 `responses_endpoint_active`。用户 yaml 的 `protocol: openai/responses` 若不在 bundled 条目里，不会改变 URL/body。
3. **compat 仍保留 URL 子串兜底**（`compat.rs:41-53, 99-111`），但提供 `resolve_*_from_compat` 优先走 `CompatSpec`。宿主 `max_tokens_field`（`protocol.rs:99-101`）调用的是**无 compat 的** `resolve_max_tokens_field(catalog_vendor, model, base_url)`，yaml `compat.maxTokensField` 未进热路径。
4. **`lib.rs` 接线**：`pub mod pricing` / `migration` / `models` / `request` 均导出，类型不在 crate root 再 export 一层。这不是正确性缺陷。

---

## 七、未跑的测试 / 未覆盖的断言

本会话**已跑绿**：pricing 30、catalog_types 4、migration 11、devil_cases 28。

**未跑 / 仓库里根本没有：**

| 缺口 | 说明 |
| :--- | :--- |
| 重叠 / 同门槛 `PricingTier` | 无测试 |
| 备份 TOCTOU（两进程同秒 `create_disaster_backup`） | 无测试 |
| `atomic_replace` 在 `rename(tmp,target)` 失败后的回滚 | 只有成功路径 |
| `current_local_timestamp` 是否本地时区 | 只有格式与 civil_from_days 已知日 |
| `ensure_content_modalities` 经 `to_chat_messages` / `build_*_request_body` | 只有模块内单测 |
| `thinking_map` 经 `HttpProviderCall::request_options` | 只有直接构造 `ChatCompletionsRequestOptions` 的 builder 单测 |
| `live_catalog()` 被 `effective_protocol` / `describe_model` 读取 | 无；函数 `#[allow(dead_code)]` |
| `ModelPricingSpec::calculate_cost` vs `PricingEngine` 对照钉 | 无（两套各测各的） |
| `DynamicYamlModalities` 解析 `input: [image]` | 无（形状测错了也看不见） |
| `cargo test -p agent-provider` 全包、workbench `engine_tests`、session-loop 结算 | 本会话未跑 |
| Windows 真机 `rename` 已存在目标 | 在 Windows 上跑了 migration 成功路径，**没有**注入「目标锁定 / 断电」 |

Devil 全绿**不能**覆盖 K-01/K-02/K-03：那 28 条里 Case 08 不构建请求，Case 13 自写 `ArcSwap` 不碰 `LIVE_CATALOG`，Case 28 不钉饱和值。

---

## 八、给主控的总结

**可以收口的 Wave 4 成果（有测试、本会话绿）：**

- 免费基础价 + 非空 `tiers` 不再短路成「免费」。
- `tokens_to_micros` / PerImage 饱和截断，NaN/负价归零。
- 迁移拷贝 `capabilities` / 模型级 `headers` / provider `providerHeaders`。
- devil 测试改挂生产 `PricingEngine` / `ConfigMigrationManager`。
- 坏 YAML 不覆盖原文件。

**不能收口、建议主控下一轮只做接线与契约收敛（不要再平行实现一套引擎）：**

1. **把 `live_catalog()` 接到** `effective_protocol` / `request_options` / `validate_reasoning_effort` / 结算；`bundled_catalog` 仅作 yaml 缺失时的离线回落。否则 yaml SSOT 是假的。
2. **宿主填 `thinking_map` + `thinking_format`**（从 yaml ModelSpec / live entry 来），删掉生产路径对 `infer_thinking_capability(model_name)` 的依赖。
3. **在 `to_chat_messages` 前调用 `ensure_content_modalities`**，用模型 `modalities.input`（不是 live 解析器那个 bool 结构）。
4. **废或委托 `ModelPricingSpec::calculate_cost`**，只留 `PricingEngine`；`ModelPricingSpec` 补 `tiers` 或明确「阶梯只活在 PricingEngine / catalog_price 之一」。禁止 `From` 静默 `tiers: Vec::new()`。
5. **统一 ModelSpec 字段集**：`capabilities`、`headers`、`compat`、`modalities.input|output` 与 TS 对齐；live `DynamicYamlModalities` 改读数组。迁移已经写下的字段不要在下一层丢掉。
6. **迁移落盘改调 `conex_fs::atomic_write_file`**，删平行 `atomic_replace`；备份用 `create_new` 或纳秒/计数器，并纠正「local」时间戳实为 UTC。
7. 结算热路径若要微元账，从 workbench/session-loop **调用 `PricingEngine`**，不要让引擎只在 `#[cfg(test)]` 里正确。

**一句话给调度者：** Wave 4 修的是 10 审计指出的「函数写错」；本轮指出的是「函数没接到请求和真源上」。不接线，阶梯/拍平/模态守卫都是 Anti-Dead-Feature 测试里的活标本。
