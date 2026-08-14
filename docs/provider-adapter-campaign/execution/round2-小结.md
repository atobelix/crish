# Round 2 小结 · 协议面（G7-a + G5 序列化 + G8-a 描述面 + I1 端到端）

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 2
> 日期：2026-08-14 · 主控收束

## 一、完成项（含测试证据）

| 单元     | 任务                                                                                 | 结果 | 测试证据                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T2.1a    | anthropic 请求体 builder（含 **INV-07 交替投影层**，超出预期）                       | ✅   | `request::build_anthropic` 8 passed（含 `consecutive_assistant_messages_get_user_separator` / `leading_assistant_gets_user_prefix` 交替用例）；parse:: 137 回归绿         |
| T2.1b    | gemini 请求体 builder                                                                | ✅   | `request::build_gemini` 16 passed（角色映射/functionCall 配对/thinking_level/头/工具形状）；parse::gemini 35 回归绿                                                       |
| T2.2+2.3 | messages 序列化一体（空 content "" / reasoning_content 模型级强制 / developer role） | ✅   | `request::messages` 55 passed（新增 10 项）；**deepseek_invariants 6 passed 保持**；system_role 2 passed；build_chat 20 passed；compat 18 passed；wire_protocol 13 passed |
| T2.4     | 能力描述只读接口（describe_model + 不藏提供方）                                      | ✅   | `request::capability` 9 passed（含 `bad_config_model_a_does_not_hide_model_b_same_provider`）；catalog/vendor 回归绿                                                      |
| T2.5     | anthropic/gemini 流式端到端（MockServer 基座）                                       | ✅   | `parse_anthropic_e2e` 2 passed + `parse_gemini_e2e` 2 passed（全流 + 唯一 Stop + usage 透传）；既有四轨 parse e2e 回归绿                                                  |

**主控全量核验（真跑）**：`cargo test -p agent-provider` → **631 passed; 0 failed; 0 ignored**（lib + 全部集成二进制：abort/classify/divergence/parse_*/retry/system_role/ttfb 全绿）。

## 二、契约登记（对 R3-R5 的输入；只追加不删改语义）

### C6 · anthropic builder（R3 T3.2 接线消费）

- `build_anthropic_request_body(opts: &AnthropicRequestOptions, context: &RequestBuildContext) -> Value`
- `AnthropicRequestOptions { model, stream, temperature, max_tokens, reasoning_effort, thinking_intensity, tool_choice }`（thinking_intensity 覆盖 reasoning_effort）
- `anthropic_request_headers(api_key) -> Vec<(&'static str, String)>`（x-api-key / anthropic-version: "2023-06-01" / content-type）
- 请求体形状：`system` 字符串；messages 内容块数组（text/thinking/tool_use；tool_result 归 **user 角色**）；`thinking:{type:"enabled",budget_tokens}`（off/auto 不注入）；tools 官方 shape。
- **INV-07 交替投影**：`push_alternating`（序列化层）——assistant 首条或连续 → 前置 `WIRE_CONTINUATION_NOTE` user 占位；未注入核心领域模型。

### C7 · gemini builder（R3 T3.2 接线消费）

- `build_gemini_request_body(opts: &GeminiRequestOptions, context: &RequestBuildContext) -> Value`
- `GeminiRequestOptions { model, temperature, max_output_tokens, thinking_intensity, tool_choice }`
- `gemini_request_headers(api_key)`（x-goog-api-key 非空时 + content-type）
- 请求体形状：contents 角色 user/model（assistant→model）；systemInstruction 顶层（不进 contents）；generationConfig{maxOutputTokens, temperature, thinking_level}；tools functionDeclarations；toolConfig mode AUTO/NONE/ANY。
- functionResponse.response：非 JSON 输出包装 `{"result": <text>}`（主控裁决采纳）。
- **观察项**：Gemini 连续同 role 防护未加（任务未点名 + 反过度设计）；R3 mock 暴露 400 时追加。

### C8 · 消息序列化 wire 形状变更（M8 契约，R3 接线消费）

1. **空 content**：空文本 assistant（含纯思考/纯工具轮，content=None）序列化 `content:""`（非 null）。
2. **reasoning_content 强制键**：DeepSeek 厂商 + tool_calls 回合 → 必含 `reasoning_content`（有思考回传、无思考空串兜底）；DeepSeek 纯思考轮 → 带思考时保留（不强加）；非 DeepSeek → 不带。
3. **developer role 条件**：openrouter + `anthropic/`|`openai/` 前缀 + supports_reasoning → `role:"developer"`；其余 → `role:"system"`；user-prefix 模式恒 `role:"user"`。

- 新入口：`to_chat_messages_with_compat(..., compat: WireCompat)`（缺省与旧入口**逐字节一致**，测试钉死）；`WireCompat{vendor, model, base_url, supports_reasoning}` + `is_deepseek()`。R3 适配层切换消费入口；如需 `crate::request::` 级 re-export 由主控补。

### C9 · 能力描述接口（R4 T4.1 + R5 T5.2b 消费）

- `pub struct ModelCapability { supports_reasoning, efforts, default_effort, wire_protocol }`
- `pub fn describe_model(catalog, vendor, model, endpoint) -> ModelCapability`
- 合并语义：模型级 `offered_levels()` 非空 → 以模型级为准；否则系列级 `infer_thinking_capability` 兜底；supports_reasoning = 模型级白名单非空 ∨ (series.supported ∧ catalog supports_reasoning 非 false)。
- **待 R4 联动**：catalog `supports_reasoning` 缺省 false 与「未填」不可区分（serde default）；如需区分显式 false vs 未填，R4 T4.1 校验面补字段语义。
- default_effort 为派生默认（efforts 首个）。

### C10 · 端到端基座与 usage 现状（R3 T3.4 承接）

- 新测试：`tests/parse_anthropic_e2e.rs`（222 行）、`tests/parse_gemini_e2e.rs`（161 行）；mock 复用 `tests/common/mod.rs` 既有 API。
- **usage 归一缺口（R3 T3.4 承接）**：anthropic `reasoning_tokens` 恒 None（anthropic_map.rs）；gemini `cache_write_tokens` 恒 None（gemini_map.rs，miss 按 Excluded 口径推导）；`input = prompt - cached - write`、reasoning 从 completion 拆分的**目标形状**未实现（现状逐字段透传，e2e 断言钉死现状）。

## 三、主控裁决与记录

1. **INV-07 交替**：T2.1a 主动实现 `push_alternating` 投影层（优于「调用方保证」方案）；Gemini 侧同 role 防护列为 R3 观察项。
2. **思考档位入口**：T3.2 经 `resolve_thinking_params`（vendor.rs 既有）换算后传 `thinking_intensity` 给 builder（R3 系列级语义；R4 落模型级映射）。
3. **functionResponse 包装**：非 JSON 输出 → `{"result": text}`（采纳 T2.1b 取舍）。
4. **并行波动**：R2 运行期多次出现其他 Agent in-flight 编译/用例波动（自愈）；各 Agent 文件域在绿窗口内独立验证，最终全量 631 绿。
5. **clippy 基线**：agent-provider lib 6 条既有警告（error.rs/vendor.rs doc 缩进 5 处 + catalog.rs:285 if-let 1 处）——R2 收束后由主控清零（规范要求警告根因修复零压制）。

## 四、基线变化

- 轮前：R1 588 passed
- 轮后：**631 passed; 0 failed; 0 ignored**（净增 43 测试：anthropic 8 + gemini 16 + messages 10 + capability 9 + e2e 4 - 若干改写）
- `cargo check --workspace --all-targets` 与前端门禁留 R5 全量回归轮

## 五、对下一轮（R3 接线主干）的输入

- 依赖 C1（档位载体）/C2（多提供方配置）/C4（协议路由）/C5（compat）/C6-C8（三协议 builder 与序列化 wire 形状）/C9（描述接口）/C10（usage 缺口）
- R3 任务：T3.1 ProviderRequest 增 reasoning_effort、T3.2 HttpProviderCall 能力面补全（思考透传 + 协议路由三处同轨 + maxTokensField + **INV-07 交替接线验证**）、T3.3 error_kind 补全、T3.4 usage 归一、T3.5 会话亲和头 seam、T3.6 maxTokensField 消费接线
- 注意：engine_provider.rs 由 T3.2/T3.3/T3.5 三写（拆函数面串行标注，评审 M7）；ProviderRequest 字段只增不减（serde default 兼容）
