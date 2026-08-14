# Round 4 · 校验面（vendor 一体 · T4.1+T4.2+T4.4+T4.5）

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 4
> 任务单元：T4.1（G8-b 请求拒绝）+ T4.2（G6-a 模型级改名）+ T4.4（G6-b beta 头跳过）+ T4.5（G5-c/G6-c 方言与 off disabled）
> 文件域：`crates/agent-provider/src/request/vendor.rs` + `vendor_wire.rs` + `vendor_tests.rs`（+ 新拆分模块 `vendor/reject.rs`、`vendor/dialect.rs`，`request/mod.rs` 接线）
> 状态：**完成**，`cargo test -p agent-provider` 全绿

## 一、完成项（含测试证据）

| 单元 | 任务                                             | 结果 | 新增测试                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T4.1 | 请求侧降级改拒绝（G8-b + G8-c 三态分流）         | ✅   | `reject_explicit_max_outside_whitelist` / `reject_explicit_unknown_model` / `omitted_state_yields_no_params` / `three_state_explicit_default_omitted_distinguishable` / `off_and_auto_never_send` / `degrade_policy_switch_preserves_old_behavior_when_on` |
| T4.2 | 模型级 wire 改名消费（G6-a）                     | ✅   | `model_level_rename_medium_to_high_wire_byte` / `model_level_rename_falls_back_to_series_spelling` / `hidden_tier_rejects_as_unsupported`                                                                                                                  |
| T4.4 | anthropic-beta 头随 adaptive 跳过（G6-b）        | ✅   | `adaptive_model_skips_beta_header`                                                                                                                                                                                                                         |
| T4.5 | 开关/嵌套方言 + off 显式 disabled（G5-c + G6-c） | ✅   | `qwen_dialect_uses_enable_thinking` / `zai_dialect_uses_thinking_object` / `openrouter_dialect_uses_nested_reasoning` / `deepseek_off_emits_disabled_thinking`                                                                                             |

**主控全量核验（真跑）**：`cargo test -p agent-provider` → **661 passed; 0 failed; 0 ignored**（lib）+ 全部集成二进制绿；`cargo build -p agent-provider --all-targets` 零警告；`cargo check --workspace` 零错误。vendor.rs 397 行（≤400 门禁达标）。新模块零 `todo!()`/`#[allow]`。

## 二、契约登记（对 R5 回归闸 + 前端 R5 T5.2b 的输入）

### C17 · 请求面拒绝语义（G8-b + G8-c 三态分流）

- **载体**：`reject.rs::ReasoningEffortState`（`Omitted` / `Default` / `Explicit(ReasoningEffort)`），`DegradePolicy`（`Reject` 默认 / `AllowDegrade`），`ReasoningReject`（错误分类载荷）。
- **分类错误码**：`ReasoningReject.kind` 恒 `ProviderErrorKind::InvalidRequest`（analysis 04:98「复用既有分类」路径，conex-types 数据面不新增变体）；文案携带 `ReasoningReject::UNSUPPORTED_TAG = "UNSUPPORTED_REASONING_EFFORT"` 语义标签（对齐 DSH）。
- **三态流转规则**：
  - `Omitted` → `Ok(None)`（不发送思考参数，保留提供方默认）；
  - `Default` → `Ok(白名单首个支持档)`（派生默认恒在白名单，故默认请求不拒绝）；
  - `Explicit(level)` → off/auto 时 `Ok(None)`；在白名单直发；不在 → `Reject` 拒绝（不降级不改写）；`AllowDegrade` 时走旧降级钳制。
- **降级开关**：`DegradePolicy::AllowDegrade`（默认关闭=拒绝；开启时保留 `normalize_thinking_intensity` 旧降级行为，供兼容调用方——方案 T4.1 验收 C3）。

### C18 · 模型级 wire 改名（G6-a，衔接 R1 C1 载体）

- `dialect.rs::resolve_wire_spelling_with_tiers(effort, tiers) -> Option<String>`：模型级档位载体命中（改名如 `{medium:"high"}` → "high"）覆盖系列级换算；未命中回落 `normalize_reasoning_effort`。两级同链单真源。
- 模型级隐藏档（None 值）与未收录档 → `None` → 由协调入口 `build_reasoning_wire` 走 `Err(ReasoningReject::hidden_tier)`（拒绝，不静默省略/改名）。

### C19 · wire 改名与方言矩阵（G6-a / G5-c / G6-c，衔接 pi-ai openai-completions.js:560-641）

- 协调入口 `dialect.rs::build_reasoning_wire(endpoint, tiers, effort_state, vendor, capability, dialect, policy) -> Result<Option<Value>, ReasoningReject>`。
- 方言（`ReasoningFormat` 扩展变体 `QwenEnableThinking`/`ZaiThinking`/`OpenRouterReasoning`）：
  - qwen → `enable_thinking:true`；
  - zai/GLM → `thinking:{type:"enabled",clear_thinking:false}` + `reasoning_effort`；
  - openrouter → 嵌套 `reasoning:{effort}`；
  - deepseek off → 显式 `thinking:{type:"disabled"}`（无 `reasoning_effort`）；非 deepseek off → 省略（关闭思考）。

### C20 · anthropic-beta 头跳过（G6-b / T4.4）

- `vendor.rs::reasoning_effort_headers_for_model(model, vendor, effort)`：`is_adaptive_thinking_model(model)` 为真 → 不返头（对齐 pi-ai anthropic-messages.js:641 forceAdaptive 跳过）；旧代际 + 活跃档 → 返 `anthropic-beta: interleaved-thinking-2025-05-14`。
- 既有 2 参 `reasoning_effort_headers(vendor, effort)` 保留（headers.rs 生产调用点），按旧代际语义返头；模型感知版供 R5 接线切换。

## 三、文件变更清单

| 文件                        | 类型 | 说明                                                                                                        |
| --------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| `request/vendor.rs`         | 改   | 门面收敛：加 `ReasoningFormat` 方言变体、`reasoning_effort_headers_for_model`；保持既有公开函数签名；397 行 |
| `request/vendor/reject.rs`  | 新增 | T4.1 拒绝校验（三态 + 降级开关 + 分类错误）                                                                 |
| `request/vendor/dialect.rs` | 新增 | T4.2 改名 + T4.5 方言与 off disabled + `build_reasoning_wire` 协调                                          |
| `request/vendor_tests.rs`   | 改   | 新增 14 测试（既有 21 测试保持绿）                                                                          |
| `request/mod.rs`            | 改   | re-export 新公开符号（接线）                                                                                |

## 四、未覆盖项 / 新发现契约问题（报主控）

1. **生产接线未落**：`build_reasoning_wire` / `reasoning_effort_headers_for_model` / `describe_model` 白名单拒绝的**真实请求面接线**（build_chat.rs build 入口、engine_provider 请求装配）不在本单元文件域（禁改）。本单元提供并通过单测钉死全部校验/改名/方言/头逻辑；接线留 R5（T5.4 复核清单应沿该链核查）。
2. **`ReasoningEffort` ∈ `ThinkingCapability.levels` 类型差异**：能力白名单为 `[ThinkingIntensity]`，与 `ReasoningEffort` 非同一枚举，`reject.rs` 内做双向映射（`effort_to_intensity` / `intensity_to_effort`）。若未来统一档位类型可简化为同构比较，现按序一一对应。
3. **`vendor_wire.rs` 未新增重函数**（改名逻辑收敛在 dialect.rs，未污染换算域）：transform 保持既有 `normalize_reasoning_effort` 为系列级基底。
4. **前置依赖确认**：`catalog.rs` / `capability.rs` / `vendor_capability.rs` 由他 Agent 处理或只读，本单元仅消费其已有公开接口（`TierEffortMap as BTreeMap`、`ThinkingCapability`、`describe_model` 语义），未改。
