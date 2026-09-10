# 轮次 δ 派单（S4 出站 ∥ S5 计费）

## 1.1 问题识别

| 字段 | 值 |
| --- | --- |
| 轮次代号 | δ |
| 对应维 | S4 与 S5 并行 |
| 本轮要对齐的 §3 动词 | 出站 HTTP JSON 含 yaml 字典 wire；无图模型出站硬拒；SSE usage 进入 PricingEngine；会话 UI 费用 = 微元 |
| 上轮未闭合 | `request_options` Default 清空 map；四 builder 启发式；`ensure_content_modalities` 花瓶；PricingEngine 生产 0 调用；前端 JS 浮点账本；4000 未跑 |
| 依赖是否已满足 | 是。γ：UI 读 live；发送带 thinkingWire。α：`live_catalog().find`；EngineProviderConfig 槽位已灌。S4 仍须 **每次** lookup，禁止用槽位当过期副本 |
| 工作区风险 | 旧岛 `modelCatalog*` 仍 dirty，禁止提交。`engine_provider.rs` 只允许 δ-1 写。`engine_build.rs` 只允许 δ-9 写 |

## 1.2 任务分解

### S4（plans/04）

| 任务单元 | 写集 | 禁动 | 验收 |
| --- | --- | --- | --- |
| TU-S4-1 | `engine_provider.rs`；`engine_provider/protocol.rs`；`engine_provider/thinking.rs` | 不删 `bundled_catalog()` 函数（S5 仍暂时调用）；不改 pricing | W10、C3；`request_options` 显式 `thinking_map`/`thinking_format`；stream 在 HTTP 前 validate + modalities |
| TU-S4-2 | `vendor.rs`（不含 dialect.rs）；`compat.rs`；`cache_policy.rs`；`behavior.rs`；`headers.rs`；`wire_protocol.rs` 仅 URL 拼装 | 不改 dialect.rs；不改 engine_provider.rs | W3、W4；生产零 `url.contains` 决议；无声明不发 DeepSeek 头 |
| TU-S4-3 chat | `request/vendor/dialect.rs`；`build_chat.rs`；`build.rs` 的 dialect `#[path]` | 不改 engine_provider.rs | 删 else 枝；Gemini 变体；单模块编译；W1/W2 |
| TU-S4-3 responses | `build_responses.rs` + 其测试 | 不改 dialect 文件本体（只 use） | W8；禁止 `_ => OpenAiResponsesNested` |
| TU-S4-3 anthropic | `build_anthropic.rs` + 测试 | 不改 dialect 本体 | 结构补 `thinking_map`/`thinking_format`；思考键只来自 dialect；W6；视觉模型图块 |
| TU-S4-3 gemini | `build_gemini.rs` + 测试 | 不改 dialect 本体 | 同上；W7；`inline_data`；禁止 `thinking_to_gemini_thinking_level` 生产 |
| TU-S4-5 | `messages_content.rs`；`messages.rs` 生产 with_compat 导出；`run_launch.rs`；`timestamp.rs` 仅 content 桥 | 不改四个 builder 函数体 | M1/M5；去掉 `ensure_content_modalities` 的 `dead_code` |

### S5（plans/05）

| 任务单元 | 写集 | 禁动 | 验收 |
| --- | --- | --- | --- |
| T5.1 | `catalog_types.rs` 仅 `calculate_cost` + 7.7 测；`pricing.rs` `From` 拷贝阶梯（spec 无 `tiers` 则补字段） | 不改引擎四则公式 | 双入口消失；A vs 已删 B 同一结果 |
| T5.2+T5.3 | **新建** `apps/agent-workbench/src-tauri/src/live_pricing.rs`；`engine_build.rs`；`core_query_commands.rs` `RunUsage`；必要的 snapshot 组装 | **零改** `protocol.rs` / `engine_provider.rs` / `build_*` | 宿主测：live 单价 + usage → `formatted_total` 等于引擎；无定价 → null；免费 → 免费；waste 不读 bundled 价 |
| T5.4+T5.5 | 前端 usage 展示与切断 LS 账本（见互斥表） | 不改 Composer/Picker/saveConfig | 呈现文件零 `estimateCostUsd`；零硬编码 `$`；三态 |

## 1.3 Agent 分配

| Agent | 任务 | 写集 |
| --- | --- | --- |
| δ-1 | TU-S4-1 剖面 + request_options + stream 挂载点 | `apps/agent-workbench/src-tauri/src/engine_provider.rs`；`engine_provider/protocol.rs`；`engine_provider/thinking.rs` 及其测试 |
| δ-2 | TU-S4-2 拆除启发式 + DeepSeek 头 | `crates/agent-provider/src/request/vendor.rs`（**不要**改 dialect.rs）；`compat.rs`；`cache_policy.rs`；`behavior.rs`；`wire_protocol.rs`；`apps/agent-workbench/src-tauri/src/engine_provider/headers.rs` |
| δ-3 | dialect 单模块 + build_chat 删兜底 | `crates/agent-provider/src/request/vendor/dialect.rs`；`build_chat.rs`；`build.rs` 与 `vendor.rs` 的双 `#[path]` **只许 δ-3 改 path/re-export** |
| δ-4 | Responses builder | `build_responses.rs`；`build_responses_tests.rs` |
| δ-5 | Anthropic builder | `build_anthropic.rs`；`build_anthropic_tests.rs`。开工第一件事：给 `AnthropicRequestOptions` 加 `thinking_map`/`thinking_format` |
| δ-6 | Gemini builder | `build_gemini.rs`；`build_gemini_tests.rs`。开工第一件事：给 `GeminiRequestOptions` 加 `thinking_map`/`thinking_format` |
| δ-7 | 多模态函数 + IPC content 桥 + 生产 WireCompat 导出 | `messages_content.rs`；`messages.rs`；`messages_compat.rs` 仅接线；`apps/agent-workbench/src-tauri/src/run_launch.rs`（若路径不同以 `RunTaskOptions` 定义为准）；`timestamp.rs` `user_message` |
| δ-8 | T5.1 双 calculate_cost | `crates/agent-provider/src/models/catalog_types.rs`（仅 calculate_cost/tiers）；`crates/agent-provider/src/pricing.rs` From + 测试 |
| δ-9 | T5.2+T5.3 宿主入账 | `live_pricing.rs`（新）；`engine_build.rs`；`core_query_commands.rs`；`engine_tests.rs` 中 waste/usage 相关；禁止改 protocol.rs |
| δ-10 | T5.4+T5.5 前端只渲染 | `streamCallbacksUsage.ts`；`streamCallbacksSurfaces.ts`；`sessionEventUsage.ts`；`store-types.ts` TokenUsageState；`telemetryAccess.ts`；`OverviewCard.tsx`；`UsageSection.tsx`；`useRuntimePanelData.ts`；`RuntimePanel.tsx`；`modelsCatalogSelectors.ts` 的 `selectEstimatedCost` |

## 1.4 互斥

| 路径 | 所有者 |
| --- | --- |
| `engine_provider.rs` / `protocol.rs` / `thinking.rs` | δ-1 |
| `headers.rs` | δ-2 |
| `dialect.rs` + `build_chat.rs` + 双 path | δ-3 |
| `build_responses.rs` | δ-4 |
| `build_anthropic.rs` | δ-5 |
| `build_gemini.rs` | δ-6 |
| `messages*.rs` / `run_launch.rs` / `timestamp.rs` | δ-7 |
| `catalog_types.rs` calculate_cost / `pricing.rs` | δ-8 |
| `engine_build.rs` / `live_pricing.rs` / `RunUsage` | δ-9 |
| 前端 usage 文件 | δ-10 |
| `vendor.rs` 除 dialect path 外 | δ-2；**dialect `#[path]` 行归 δ-3** |
| Composer / Picker / saveConfig / 设置 CSS | 禁改 |
| `modelCatalog*` 旧岛 | 禁写禁提交 |

交叉编译约定：

- δ-1 填充 `AnthropicRequestOptions` / `GeminiRequestOptions` 的 map 字段。若结构尚无字段，**允许 δ-1 只加这两字段声明**（两行），不改 builder 函数体。
- δ-1 `stream()` 调用 `ensure_content_modalities`（或 δ-7 将提供的 `ensure_outbound_modalities`）。函数尚未去 `dead_code` 时仍可调用。
- δ-9 **调用** `protocol::live_catalog()`，不改 `protocol.rs`。取价函数放新文件 `live_pricing.rs`。
- 不要删除 `bundled_catalog()` 符号，只停止自己写集里的热路径调用。

## 1.5 当前代码锚点（本会话已读）

- `engine_provider.rs:169-191` `request_options` 仍 `bundled_catalog` + `..ChatCompletionsRequestOptions::default()`。
- `engine_provider.rs:220-236` Anthropic/Gemini `..Default::default()`。
- `engine_provider.rs:271-275` `reasoning_content_mode` 仍 `infer_reasoning_vendor(base_url, model)`。
- `engine_provider.rs:311-324` `stream`：validate 仍 `bundled_catalog`；**不**调用 `ensure_content_modalities`。
- `protocol.rs:98` `live_catalog()` 已可调用；`slots_for_unique_model` 是按模型 id 唯一命中，S4 热路径改 `(provider_id, model)` `LiveModels::find`。
- `thinking.rs:86-96` `describe_model(bundled_catalog(), catalog_vendor(config), ...)` 小写白名单。
- `catalog.rs:763-837` 投影已含 thinking_tiers / modalities.input / thinking_format。S4 **不必**再开第二解析器。
- `ChatCompletionsRequestOptions` 已有 `thinking_map`/`thinking_format`；Anthropic/Gemini options **没有**。
- `vendor.rs:17` 与 `build.rs:30` 双 `#[path] dialect.rs`。
- `pricing.rs:135` `From<ModelPricingSpec>` `tiers: Vec::new()`；`catalog_types.rs:570` 独立 f64 `calculate_cost`；spec **尚无** `tiers` 字段。
- `RunUsage`（`core_query_commands.rs:395`）无 `cost`。
- `waste_alert_event`（`engine_build.rs:1036`）`bundled_catalog()` 取价。
- 前端 `streamCallbacksUsage.ts` / `OverviewCard` / `useRuntimePanelData` / `UsageSection` / `RuntimePanel` 仍 `estimateCostUsd` 与硬编码 `$`。
