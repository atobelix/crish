# 轮次报告：δ

## 轮次元信息

- 轮次：δ
- 对应维：S4（出站方言与多模态）∥ S5（计费入账与费用呈现）
- 本轮 Agent 数：1（主控亲力亲为；γ 遗留 γ-9 补洞 + γ 审计亦由主控收口）
- 任务单元：TU-S4-1…TU-S4-5、T5.1–T5.5（派单 δ-1…δ-10 全部由主控一人完成）
- 输入包：00-总方案 + plans/04 + plans/05 + execution/γ-轮次报告.md + execution/δ-派单.md
- 本轮闭合的产品链环节（调度 §3 动词）：
  - [x] 出站 HTTP JSON 含 yaml 字典映射出的 wire 键值（W1–W8 宿主/构建体断言）
  - [x] 无图模型带图：入口不可挂（S3）且出站硬拒（本轮回流前 InvalidRequest，M1/M2/M4）
  - [x] SSE usage 进入 PricingEngine（RunUsage.cost = 引擎微元，宿主测钉字符串字节一致）
  - [x] 会话 UI 展示的费用 = 微元定点结果（前端只渲染三态；estimateCostUsd 生产零调用）
  - [ ] 4000 真机用户路径（η）

---

## 一、已完成

### S4 · 出站方言与多模态

| 任务单元 | 文件域 | 闭合 |
| --- | --- | --- |
| TU-S4-1 | `engine_provider.rs` / `protocol.rs` / `thinking.rs` | `catalog_request_profile` 单次 live lookup（provider_id, model）；`request_options` 显式灌 `thinking_map`/`thinking_format`/`max_tokens_field`/`reasoning_content`，禁止 `..Default` 清空；`effective_protocol`/`max_tokens_field`/`effective_context_window` 全改读剖面；validate 白名单 = yaml 字典 TitleCase 键 |
| TU-S4-2 | `vendor.rs`（dialect path 行）/`cache_policy.rs` 消费面/`headers.rs`/`protocol.rs` | 出站链生产零 `url.contains` / `infer_reasoning_vendor` / `infer_thinking_capability` / `is_openai_o_series` / `MODEL_SERIES`；缓存只来自 yaml `compat.cacheControlFormat`（无声明 → None）；全局 `x-deepseek-harness-session-id` 删除（M16），亲和头只来自 yaml `providers.*.headers` |
| TU-S4-3 | `vendor/dialect.rs` / `build_chat.rs` / `build.rs` | dialect 单模块（vendor.rs 双 `#[path]` 删除）；新增 `GeminiThinkingConfig` 变体；`assemble_thinking_dialect` map 驱动（禁 `to_openai_str` fallback；map None → 不注入，DeepSeek/Qwen Off 例外）；`build_chat` 84-150 兜底枝整枝删除 |
| TU-S4-4 | `build_responses.rs` / `build_anthropic.rs` / `build_gemini.rs` / `messages*.rs` | Responses 禁 `_ => Nested`（Anthropic/Gemini 冲突 fail-closed）；Anthropic/Gemini options 补 `thinking_map`/`thinking_format`，思考键只走 dialect（删 `effort_to_budget_tokens`/`thinking_to_gemini_thinking_level` 生产调用）；`to_chat_messages_with_compat` 接真 `WireCompat`（base_url 不再传启发式）；`resolve_system_role` 只信 yaml `supportsDeveloperRole` |
| TU-S4-5 | `messages_content.rs` / `run_launch.rs` / `timestamp.rs` / 四 builder 图块 | `ensure_outbound_modalities` 唯一挂 `stream`（validate 后、HTTP 前）；`RunTaskOptions.content`/`has_images` → `metadata.contentParts`；Chat image_url / Responses input_image / Anthropic image source / Gemini inline_data·fileData 四协议图形状 |
| TU-S4-6 | 防回潮测 | W1–W8、M1–M5、C1–C4 断言入库（engine_provider_tests / build_*_tests / dialect tests）；宿主测：live yaml 快照下 `request_options.thinking_map` 非空 |

### S5 · 计费入账与费用呈现

| 任务单元 | 文件域 | 闭合 |
| --- | --- | --- |
| T5.1 | `catalog_types.rs`（仅 calculate_cost）/ `pricing.rs` | `ModelPricingSpec::calculate_cost` 改为一行委托引擎（返回 `Option<CostBreakdown>`，7.7 旧断言改引擎扣减语义 4.7）；`From<ModelPricingSpec>` 拷贝 `tiers`（spec 补 `tiers` 字段 + `PricingTier` 类型），双向 From 往返保真 |
| T5.2 | `live_pricing.rs`（新） | 唯一取价 = `live_catalog().find(provider_id, model)` 精确命中 → `ModelPricing`；禁止 bundled/LS/模糊 includes |
| T5.3 | `core_query_commands.rs` `RunUsage` / `run_core.rs` / `engine_build.rs` | `RunUsage.cost: Option<CostBreakdown>`（serde camelCase 同形）；`from_run_cache_stats(stats, pricing)` 内部只调 `PricingEngine::calculate_cost`（扣 cacheRead 不扣 cacheWrite）；waste_alert 改用 live 单价 × 引擎微元（字段名 usd → 仅 USD 币种填充，CNY 诚实 None，§13.3b） |
| T5.4 | 前端 usage 呈现 | `TokenUsageState` 三态（costStatus/currency/costMicros/formattedCost）；`parseRunSnapshotUsage` 解析引擎 cost；`applyUsageDelta`/`mergeTokenUsageDelta` 只累计引擎微元（同币种）；`streamCallbacksUsage` 删 pricingStore 动态 import 与 approx 估费；五个呈现文件零 `estimateCostUsd`、零硬编码 `$`、零 `toFixed` 货币 |
| T5.5 | `modelsCatalogSelectors.ts` | `selectEstimatedCost` 生产实现删除 → gravestone 返回 null（store 测改断言 null） |

### γ 遗留收口（主控本轮）

- **γ-9 补洞**：`thinking-title-changed` UI 事件打通 Picker→Composer 胶囊同步；几何/互斥测改灌 yaml 夹具（3 文件 47 测绿，修复前基线 4 failed）。
- **γ 审计**：`audits/γ-执行位抽检.md` 落盘（13 文件 161 测复跑绿 + 源码形状 grep）。

---

## 二、未闭合与阻断

| 项 | 状态 | 承接 |
| --- | --- | --- |
| 4000 真机用户路径（改 yaml → 发一条 → 出站体/费用变） | 未跑 | η |
| 历史账单入账时点快照 | **偏差**：cost 在 `run_usage()` 读取时按 live 现价计算（DB runs 表 v5 固定列，未加 cost 列；事件 DTO 跨 crate 约束）。**用户侧「改 yaml → 下一 run 变」成立**；但改 yaml 后历史 run 重读会反映新价。方案 §3.6「入账时点快照」未完全落地，留 S7/后续加列 | S7 |
| `waste_alert_event` 金额字段 | 事件 schema 未改（`missed_cost_usd: Option<f64>` 保留）；按 §13.3b 停更 f64 的 bundled 源，改为 live 单价×引擎微元且仅 USD 填充。CNY 模型浪费金额不展示（token 阈值仍预警） | S7 可改 schema |
| `EngineProviderConfig` 槽位字段（vendor/protocol/thinking_map/thinking_format） | S4 热路径不再消费（每次 live lookup），保留给 S7 删除面（已 allow(dead_code) + 注释） | S7 |
| `bundled_catalog()` 符号 | 保留（测试/预填）；生产出站链与结算零读取 | S7 |
| 前端全量单测 39 文件失败 | **既有失败**（与本轮写集无关：零 cost/pricing 命中；多为环境/转换层崩溃如 tauri-command-registry 空消息、layoutStore workspaces 状态形状不匹配）。本轮触碰的全部前端测 155 测绿 | 既有债，非本轮引入 |
| watcher e2e（watcher_wakes_sleeping_ai_after_timer_expiry_e2e） | 并行套件偶发失败，隔离跑绿（时序 flake，与本轮写集无关） | — |

---

## 三、文件清单

**S4**：`engine_provider.rs`、`engine_provider/protocol.rs`、`engine_provider/thinking.rs`、`engine_provider/headers.rs`、`engine_provider_tests.rs`、`engine_tests.rs`；`crates/agent-provider`：`request/vendor/dialect.rs`、`request/vendor.rs`、`request/build.rs`、`request/build_chat.rs`、`request/build_responses.rs`、`request/build_anthropic.rs`、`request/build_gemini.rs`、`request/messages.rs`、`request/messages_content.rs`、`request/messages_compat.rs`、`request/mod.rs`、`request/wire_protocol.rs`（build_endpoint_url re-export）、`run/run_launch.rs`、`run/run_idle.rs`、`subagent_spawner.rs`、`server/core_backend.rs`、`core_run_commands_tests.rs`（+ 各 `build_*_tests.rs` / `messages_tests.rs` 测试资产按新语义改写）。

**S5**：`live_pricing.rs`（新）、`main.rs`（mod）、`core_query_commands.rs`、`run/run_core.rs`、`engine_build.rs`、`catalog_types.rs`、`pricing.rs`、`pricing_tests.rs`、`models/mod.rs`；前端 `store-types.ts`、`telemetryAccess.ts`、`sessionEventUsage.ts`、`sessionEventHydrate.test.ts`、`sessionEventUsage.cost.test.ts`（新）、`streamCallbacksUsage.ts`、`OverviewCard.tsx`、`OverviewStats.tsx`、`UsageSection.tsx`、`useRuntimePanelData.ts`、`RuntimePanel.tsx`、`modelsCatalogSelectors.ts`、`modelsCatalogStore.test.ts`。

**γ-9/γ 审计**：`uiEvents.ts`、`SessionRuntimeRegistry.ts`、`ComposerFusedTrigger.tsx`（+test）、`permAndModelExclusive.test.tsx`、`PhysicalGeometryGuards.test.tsx`、`audits/γ-执行位抽检.md`。

未提交；旧岛 `modelCatalog*` 八文件仍 dirty 禁止提交。

---

## 四、新发现（同权）

1. **Responses URL 规范化变化**：`provider_url_for` 改走 `build_endpoint_url`（SSOT）后，base_url 不带 `/v1` 的自建网关 Responses 端点由 `{base}/responses` 变为 `{base}/v1/responses`（plans/04 §2.4 要求删双拼装器，行为以 build_endpoint_url 为准）。
2. **`thinking_format` 协议缺省**：openai/chat 与 openai/responses 无 `compat.thinkingFormat` 时剖面补 `OpenAi` 缺省（§2.3）；Anthropic/Gemini 无声明 → None（fail-closed 不注入）。这使「有字典无 format」的 chat 模型仍走 OpenAiEffort。
3. **缓存语义收紧**：无 yaml `cacheControlFormat` 声明 → cache 恒 None（请求体零 cache 键）。OpenAI Key 机制 / Grok 亲和头等旧 bundled 驱动行为在产品默认下不再出现（仅 yaml 声明驱动）。这是 plans/04 §1.3/§2.4 的预期收紧，非回归。
4. **waste 取价键**：settle 处用 `cache_tracking.provider`（URL 推断串）当 yaml 键 best-effort 命中；键不一致时浪费金额 None（token 阈值仍生效）。诚实但不精确，S7 可改为传 EngineHandle 的 yaml provider_id。
5. **yaml 投影**：live `ModelSpec.compat` / `thinking` / `modalities.input` / `pricing` 在 α/S1 投影已齐（夹具验证），本轮无需补投影。

---

## 五、验证

### A. 源码形状（本会话 grep）

- 生产出站链 `url.contains`（非测试）：仅 `models/behavior.rs`（TTL 缓存矩阵，S5 域外遗留，未接热路径）。`infer_reasoning_vendor`/`infer_thinking_capability`/`is_openai_o_series`/`MODEL_SERIES_CAPABILITIES` 生产调用：0。
- `x-deepseek-harness-session-id` 生产：0（仅注释）。
- `bundled_catalog()` 在 `engine_provider.rs` 生产：0；`engine_build.rs` 取价：0。
- `request_options` 栈上 `bundled_catalog`：0；`thinking_map: None` 字面仅 fail_closed 剖面（合法）。
- 前端生产：`estimateCostUsd` / `estimateCostUsd4d` / `pickUsageCostEstimators` 在 `streamCallbacksUsage` / `OverviewCard` / `useRuntimePanelData` / `RuntimePanel` / `UsageSection`：0；五文件无 `$`+`toFixed` 货币；`selectEstimatedCost` 生产实现已删（gravestone）。
- `ModelPricingSpec::calculate_cost` 函数体 = 一行委托引擎。

### B. 本会话真跑测

| 命令 | 出口 |
| --- | --- |
| `cargo test -p agent-provider` | 全目标绿（lib 819 + devil_cases 28 + 其余 integration 全部 ok） |
| `cargo test -p crish-agent-workbench` | lib 499 + bins 1153 绿（watcher e2e 并行偶发失败、隔离绿，非写集） |
| 新增宿主测 | `run_usage_cost_equals_pricing_engine_and_three_states`（改价变 / 未定价 / 免费 / CNY / 扣减）绿；engine_provider 剖面/校验/头/协议测按新语义改写绿 |
| 前端 typecheck | `tsc --noEmit` 绿 |
| 前端 vitest（本轮触碰文件） | 9 文件 / 155 测绿（含新 `sessionEventUsage.cost.test.ts` 7 测） |
| 前端全量 vitest | 39 文件失败为**既有**（与本轮写集零相关，见第二节）；本轮写集无新增失败 |

### C. Tauri 4000

**未跑。** 不能宣称「真机点保存→发一条→出站体/费用变」用户路径。η 轮执行 plans/08 §4 剧本（含 yaml 自定义 wire `"ultra_wire_param"` 钉 HTTP 体）。

---

## 六、双轨

- 出站决议单一真源：live yaml `(provider_id, model)` 剖面（协议/思考字典/方言/模态/字段名/窗口/头）。bundled catalog 仅预填与夹具。
- 计费单一真源：`PricingEngine`（micros）。前端零 JS 浮点账；`cost` 遗留字段不再写入（S7 删）。
- 新引入 fallback / TODO / 双轨：0。`selectEstimatedCost` gravestone 带删除条件（S7）。

---

## 七、输出到下一轮

- **可启动 ε（S6 样式）**：S4/S5 热路径闭合；前端费用三态已切引擎。ε 只动样式面，与本轮写集文件域互斥（Composer/Picker 样式可改，但读路径已单轨，勿碰 modelsCatalogLive 语义）。
- **可启动 ζ（S7 删旧轨）**：可删 `pricingStore` 会话消费模块、`selectEstimatedCost` gravestone、`EngineProviderConfig` 槽位字段、`session_affinity_headers`、`catalog_vendor`/`responses_supported` cfg(test) 面、陪葬测试（modelsCatalogStore selectEstimatedCost 浮点测已改 null）。
- **不启动 η**：未跑 4000。
- **遗留上报**：历史账单快照（加 DB cost 列或事件 DTO）；waste 事件 schema（`missed_cost_usd` → micros+currency）；waste 取价键改 yaml provider_id；前端全量 39 文件既有失败清册。
