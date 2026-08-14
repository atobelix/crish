# Round 1 小结 · 数据载体层（G2 + G3 + G4 + G5 纯函数面）

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 1
> 日期：2026-08-14 · 主控收束

## 一、完成项（含测试证据）

| 单元   | 任务                                                                                   | 结果 | 测试证据                                                                                     |
| ------ | -------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| T1.1   | 档位映射载体（reasoning_effort_tiers → TierEffortMap + thinking_level_map + 查询辅助） | ✅   | `models::catalog` 42 passed；新增 t11_* 5 测试；旧 Vec 兼容解析                              |
| T1.2-4 | 配置/凭据/env 三单例一体改造（主控合并裁量）                                           | ✅   | `config` 27 passed（新增 multi_provider/per_provider_secrets/provider_env 等）；旧单对象兼容 |
| T1.5   | models 整体替换双模式（replace_models）                                                | ✅   | `replace_models` 5 passed；upsert_from_scan/with_overrides 回归绿                            |
| T1.6   | resolve_wire_protocol 纯函数 + WireProtocol 枚举                                       | ✅   | `request::wire_protocol` 13 passed（含 mode:anthropic/gemini/both 路由）                     |
| T1.7   | compat 三纯函数（maxTokensField/developer role/空 content）                            | ✅   | `request::compat` 18 passed（含极性修正后用例）                                              |

**主控全量核验（真跑）**：`cargo test -p agent-provider` → **588 passed; 0 failed**（lib + 全部集成二进制）；`cargo build -p agent-provider` 无警告；`cargo fmt --check` 干净。

## 二、契约登记（对 R2-R4 的输入；变更顺序纪律：本登记后只追加不删改语义）

### C1 · 档位映射载体（R4 T4.2 消费）

- `reasoningEffortTiers` / `thinkingLevelMap` JSON：对象 `{"档位": null|"wire拼写"}`（null=隐藏、字符串=wire 改名/同名）；旧数组 `["low","medium"]` 兼容（=各档 wire 同规范名）；序列化输出对象形式。
- 查询辅助：`wire_effort_for(level) -> Option<&str>`（thinking_level_map 优先、回落 reasoning_effort_tiers）；`offered_levels() -> Vec<String>`（提供档并集，隐藏档不入集）。

### C2 · 多提供方配置（R3 接线 + R5 前端收敛消费）

- `provider-config.json` 新形状：顶层映射 `{"openai": {...}, "deepseek": {...}}`；顶层含 `providerId` 的旧单对象自动包装为 `{"openai-compatible": {...}}`。
- 新 API：`resolve(id)` / `resolve_default()`（= openai-compatible，00 D3）/ `set_api_key(id, v)` / `config(id)` / `configs()`。
- 凭据：无 apiKeyRef → `secrets/{provider_id}.dpapi`；有 ref → `secrets/{ref}.dpapi`；`CredentialStore` 实现未动。
- env：`{P}_API_KEY/BASE_URL/MODEL/ENDPOINT`（P 大写）→ 回退 `CRISH_*`/`FLOWBIT_*`/`OPENAI_*` 兼容组。
- `ResolvedProviderConfig.provider_id` 取 resolve 入参键（比内嵌字段权威）。
- **外部调用点核查**：`apps/agent-workbench/src-tauri/src/` 仅引用 `Endpoint`，无编译破坏；R3 接线用新签名。

### C3 · models 整体替换（R5 前端 profile 收敛消费）

- `replace_models(&mut self, provider: &str, models: &[serde_json::Value]) -> Result<u64, CatalogError>`：声明列表后路由只服务列表内模型；白名单纪律沿用；version +1。

### C4 · 协议路由（R3 T3.2 消费）

- `enum WireProtocol { Chat, Responses, Anthropic, Gemini }` + `as_str()` 稳定字面量。
- `resolve_wire_protocol(catalog, vendor, model, endpoint: Option<Endpoint>) -> WireProtocol`。
- 决议优先级：模型级 mode（chat/responses/both/anthropic/gemini）→ supports_responses 能力位 → 全局 Endpoint → chat 兜底（00 D3）。
- **mode 值域扩展知会**：官方值域仅 chat/responses/both，本单元扩展支持 anthropic/gemini 字面量；R2 builder 与 R3 消费**不得对 mode 值域做非法校验拒绝**。

### C5 · compat 纯函数（R2 T2.2-2.3 / R3 T3.6 消费）

- `resolve_max_tokens_field(vendor, model, base_url) -> MaxTokensField`（**勘误后判定表**）：
  - 旧式网关轨（chutes/moonshot/cloudflare-ai-gateway/together/nvidia/ant-ling）→ `MaxTokens`
  - OpenAI 官方（base_url 含 openai.com）或 o 系列模型（o1/o3/o4/o5 前缀）→ `MaxCompletionTokens`
  - 其余（openai-compatible 默认轨）→ `MaxTokens`（保持 Conex 既有字节兼容）
- `resolve_developer_role(vendor, model, base_url, supports_reasoning) -> bool`：supports_reasoning + openrouter + (anthropic/|openai/ 前缀) → true。
- `empty_content_wire_value(role) -> &'static str` → 恒 `""`（M8 契约）。

## 三、主控裁决与勘误记录

1. **T1.7 maxTokensField 极性勘误**（方案文档已标注）：原方案写「moonshot → max_completion_tokens」，经核对 pi-ai 源码（`openai-completions.js:1134-1140` useMaxTokens）与本地实际现状（cherry-studio `OpenAiMessageConverter.ts:236-239` 优先新字段；goose `openai.rs:335` 对已知兼容网关重映射回旧字段；cline provider-defaults 新模型用新字段）——实际现状：**OpenAI 官方/新模型用 max_completion_tokens，旧式兼容网关用 max_tokens**。修正后判定表见 C5。
2. **T1.2-4 合并派单**：三单例同写 config.rs（评审 M5），主控合并为 1 Agent 一体改造，零并发冲突。
3. **并行协调记录**：catalog_tests.rs 由 T1.1/T1.5 并行写入（已合并共存全绿）；运行期多次出现其他 Agent in-flight 编译阻塞（自愈，无跨域代修）；T1.1 与 T1.6 的 catalog.rs 交集实际未冲突（T1.6 用新文件）。

## 四、基线变化

- 轮前：`cargo test -p agent-provider` 可编译（17 测试文件基线）
- 轮后：**588 passed; 0 failed**（+5 T1.1 +5 T1.5 +13 wire_protocol +18 compat +9 config 多提供方等净增测试）
- 前端 `npm run typecheck` 未触及（R1 纯 Rust 数据层）；`cargo test --workspace` 全量留 R5 门禁轮

## 五、对下一轮（R2 协议面）的输入

- 依赖 C1（档位载体）/C4（协议路由）/C5（compat 纯函数）与 `wire_effort_for`/`offered_levels` 查询辅助
- R2 任务：T2.1 anthropic/gemini 请求体 builder、T2.2 空 content ""/reasoning_content 模型级强制、T2.3 developer role 消费、T2.4 能力描述只读接口、T2.5 四协议流式端到端
- 注意：messages.rs 由 T2.2/T2.3 双写（同 Agent 顺序或串行标注）；MockServer 基座复用 `tests/common/mod.rs` 形态
