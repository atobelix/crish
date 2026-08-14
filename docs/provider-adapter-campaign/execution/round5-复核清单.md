# Round 5 · T5.4 回归验证复核清单（契约接线核查 · 只读不改码）

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 5 · T5.4（复核不改码，产出复核清单）
> 复核范围：沿关键链路逐环核查「契约登记 ↔ 实际代码」一致性，重点复核 **R4-A1 遗留（请求面 I/O 前拒绝接线）** 与 **R4-A5 遗留（catalog mode 数据激活四轨路由）**。
> 纪律：只读核查 + 写本唯一文档；不改任何代码；不提交 git；不碰 reference/markdown-editor 与 tests/e2e。
> 产出：本文档。结论等级：`✅ 一致` / `🔗 断链` / `⚠️ 部分/待核查`。断链按严重度分类（阻塞 I1-I6 不变式 vs 非阻塞）。

---

## 〇、结论速览（给主控）

| #   | 链路                                                                      | 结论                 | 严重度            | 一句话                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------- | -------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 档位链路（C1→C9→C17→请求构建入口）                                        | 🔗 **断链**          | **阻塞 I4**       | C1/C9/C17 载体与拒绝逻辑均已就位并被单测钉死，但**生产请求构建入口未接拒绝校验**（A1 遗留确认仍在）——显式档位越能力时不会在 I/O 前拒绝，反而被静默序列化发出                                                                                                                  |
| 2   | 四轨路由链路（C4→C12→A6 mode 激活）                                       | 🔗 **断链（回归）**  | **阻塞 I6 / I2**  | A6 已把 bundled catalog.json 的 anthropic/gemini 条目 `mode` 补齐为 `"anthropic"/"gemini"`，生产四轨路由**真实激活**；但 A5 的 stale 测试 `wire_integration.rs::wire_routing_bundled_catalog_ground_truth` 仍断言「mode=chat → 路由 chat」，**实测失败（Anthropic vs Chat）** |
| 3   | 错误链路（C13 error_kind）                                                | ✅ **一致**          | —                 | agent-provider Stop.error_kind → 壳层 to_loop_event 透传 → session-loop stream.rs 聚合，全链接通                                                                                                                                                                              |
| 4   | usage 链路（C14 归一化）                                                  | ✅ **一致**          | —                 | cache_breakdown 聚合层派生、anthropic/gemini reasoning/cache-write 解析、各轨 e2e 断言与契约一致                                                                                                                                                                              |
| 5   | 多供应商链路（C2→config_profile_apply→前端 providerProfiles/opencode-go） | ⚠️ **部分 / 待核查** | **I2 部分未满足** | 前端 providerProfiles + config_profile_apply 端到端已通；但**壳层未消费 C2 多提供方映射**（用单活动 effective config），Tauri 壳 config 快照为单提供商形状（不含 ≥2 提供方），I2「壳 config 快照 ≥2 提供方」子断言未达成                                                      |

**复核实测**：`cargo test -p agent-provider --test wire_integration` → **12 passed; 1 failed**。失败项 = `wire_routing_bundled_catalog_ground_truth`（stale 断言，见链路 2）。

---

## 一、档位链路：C1 载体 → C9 描述接口 → C17 拒绝校验 → 请求构建入口

> 契约引用：C1（round1 §二）、C9（round2）、C17（round4 校验面-vendor一体 §二）、I4（能力描述与请求校验分离：请求面不支持的档位在网络 I/O 前拒绝，默认开启不降级）。

### 1.1 C1 载体（`TierEffortMap` / `wire_effort_for`）—— ✅ 一致

- `crates/agent-provider/src/models/catalog.rs:45` `pub type TierEffortMap = BTreeMap<String, Option<String>>`
- `catalog.rs:268` `wire_effort_for(&self, level) -> Option<&str>`（thinking_level_map 优先、回落 reasoning_effort_tiers）
- `catalog.rs:283` `offered_levels() -> Vec<String>`
- 载体类型与查询辅助均与 C1 契约一致（旧 Vec 兼容解析由 `catalog.rs:52` `deserialize_tier_map` 承载）。

### 1.2 C9 描述接口（describe_model）—— ✅ 一致

- `crates/agent-provider/src/request/capability.rs:74` `pub fn describe_model(catalog, vendor, model, endpoint) -> ModelCapability`
- 合并语义（模型级 offered_levels 优先、系列级兜底）与 C9 一致；`capability_tests.rs` 钉死「坏配置不藏同 provider 其它模型」。
- **消费面观察**：describe_model 在 agent-provider 内提供，但**生产壳层请求路径未消费它**（见 1.4）。

### 1.3 C17 拒绝校验（ReasoningReject / resolve_reasoning_level / build_reasoning_wire）—— ✅ 逻辑就位（但接线缺口，见 1.4）

- `crates/agent-provider/src/request/vendor/reject.rs:100` `resolve_reasoning_level(effort: ReasoningEffortState, capability, policy) -> Result<Option<ReasoningEffort>, ReasoningReject>`
- `reject.rs:58` `ReasoningReject { effort, kind: ProviderErrorKind::InvalidRequest, message }`；`UNSUPPORTED_TAG = "UNSUPPORTED_REASONING_EFFORT"`（reject.rs:69）
- `crates/agent-provider/src/request/vendor/dialect.rs:53` `build_reasoning_wire(...)` 一体化协调入口（T4.1 拒绝 → T4.2 改名 → T4.5 方言）
- 逻辑单测：`vendor_tests.rs`（14 新增 + 既有 21 保持）全绿；`consistency_gate_tests.rs` 6 通过。**逻辑本身正确。**

### 1.4 🔗 断链：生产请求构建入口未接拒绝校验（A1 遗留确认仍在）

**实际代码**（生产请求路径，全部绕过 C17）：

- `apps/agent-workbench/src-tauri/src/engine_provider.rs:159` —— `request_options()` 中 `reasoning_effort: request.reasoning_effort.map(thinking::to_provider_effort)`：**直接 passthrough 映射，无能力校验、无拒绝**。
- `engine_provider.rs:197/206` —— `request_body_for()`（Anthropic/Gemini 分支）同样直接 `request.reasoning_effort.map(thinking::to_provider_effort)` / `effort_to_intensity`，无拒绝。
- `engine_provider.rs:295` —— `stream()` 中 `let body = self.request_body_for(protocol, request);` 后立即 `request_builder.json(&body).send()`（:323）：**请求体构建 → HTTP I/O 之间没有任何档位拒绝检查**。
- 壳层换算域 `apps/agent-workbench/src-tauri/src/engine_provider/thinking.rs:16/33` —— `to_provider_effort` / `effort_to_intensity` 仅为**纯转发映射**，不含能力白名单判定。
- `crates/agent-provider/src/request/build_chat.rs:47` —— builder 内 `reasoning_effort_object(Endpoint::ChatCompletions, ...)`（vendor 分支）只做 `effort.and_then(normalize_reasoning_effort)`（:233 `vendor_wire.rs`），**无能力白名单、无拒绝**；`build_chat.rs:61` `resolve_thinking_params` 为旧降级钳制（非拒绝）。

**全仓引用验证**：`build_reasoning_wire` / `resolve_reasoning_level` / `ReasoningReject` / `DegradePolicy` / `ReasoningEffortState` 仅被 `agent-provider` **crate 内部**（vendor.rs / reject.rs / dialect.rs / vendor_tests.rs / consistency_gate_tests.rs）引用，**未被 `apps/agent-workbench` 壳层任何文件消费**。生产请求面拒绝**未接线**。

**影响**（对应不变式 I4）：`request.reasoning_effort` 显式档位若超出该模型能力白名单，壳层会把它当作普通 effort **静默序列化进 wire 发出**（chat 轨写 `reasoning_effort`、anthropic 写 budget、gemini 写 generation_config），而非在 I/O 前拒绝。这与 I4「请求面不支持的档位在网络 I/O 前拒绝（默认开启不降级）」直接冲突，**属阻塞性断链**。注意 `login_provider_call` 这条**旧路径本身不降级**（不做钳制），因此行为是「越能力档位原样上wire」而非「钳制降级」——两者都不符合拒绝语义。

**最小接线点建议（不改码，仅供主控派单）**：

1. **首选 seam = 壳层 `HttpProviderCall` 请求装配**（`engine_provider.rs:287-295` `stream()`，或 `request_options`/`request_body_for` 之上）：在 `request_body_for` 产出 body 之前，按 `effective_protocol` + 生效 model 取能力（复用 agent-provider `infer_thinking_capability` / `describe_model` + `bundled_catalog()`），调用 `build_reasoning_wire` / `resolve_reasoning_level`（`DegradePolicy::Reject` 默认）做显式档位能力校验；返回 `Err`（分类 `InvalidRequest`，文案含 `UNSUPPORTED_REASONING_EFFORT`）即在 HTTP I/O 前拒绝。
2. 需把 effort 的「三态来源」在壳层正确构造：`request.reasoning_effort` 为 `None`（省略）时按 `Omitted`，有显式值时按 `Explicit`；派生默认的处理需明确是否由 session-loop 已 resolve 成某档位（若是，按 `Default` 语义——默认档位恒在白名单内，不会误拒）。
3. 关注 `session-loop` 与壳层边界：B3.4 契约（session-loop 不依赖 agent-provider catalog），故**校验必须落在壳层**（壳层已有 catalog/能力访问权限），不建议下放到 session-loop。
4. 接线后以既有的 `vendor_tests.rs` 拒绝用例为**回归锚**，在壳层补 1 个端到端断言（claude 模型 + 越能力 explicit 档位 → 流前 Err，无 HTTP 请求）。

---

## 二、四轨路由链路：C4 resolve_wire_protocol → C12 壳层三处同轨 → A6 mode 数据激活

> 契约引用：C4（round1）、C12（round3）、A6（round4 主控裁决派数据补录）、I1（四协议接线全通）。

### 2.1 C4 `resolve_wire_protocol` —— ✅ 一致

- `crates/agent-provider/src/request/wire_protocol.rs:72` 纯函数；`mode="anthropic"→Anthropic`（:88）、`mode="gemini"→Gemini`（:89）。
- 决议优先级（模型级 mode → supports_responses → endpoint → chat 兜底）与 C4/C1.6 一致，`wire_protocol_tests.rs` 13 passed。

### 2.2 C12 壳层三处同轨 —— ✅ 一致

- `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs`：`effective_protocol`（:82，消费 `resolve_wire_protocol(bundled_catalog(), ...)`，对 Anthropic/Gemini 强路由 :90）→ `provider_url`（:118）→ `http_parser_for`（:170）→ 三者同轨。
- `engine_provider.rs:294-295` URL/body/parser 收敛于同一 `effective_protocol`。`engine_provider_tests.rs` `effective_protocol_keeps_url_body_parser_in_rail`（:174）钉死三处同轨（anthropic/gemini 显式 dispatch，不受数据层影响）。

### 2.3 A6 mode 数据激活 —— ✅ 已激活（生产四轨路由真源成立）

**实际证据**：`crates/agent-provider/src/models/catalog.json`（`git status` 已修改，A6 补录在案）——

- `anthropic::claude-*` 条目全部 `"mode":"anthropic"`：claude-fable-5（catalog.json:10）、claude-mythos-5（:45）、claude-opus-5（:80）、claude-opus-4-8（:115）、claude-sonnet-4-5（:326）、claude-sonnet-5（:255）等；
- `gemini::gemini-2-5-pro`（catalog.json:828 `mode:"gemini"`）及其余 gemini-* 条目全部 `"mode":"gemini"`。

**结论**：`resolve_wire_protocol(bundled_catalog())` 对 claude-_/gemini-_ 条目**真实返回** `WireProtocol::Anthropic/Gemini`（链路 1.2 已确认 resolve_wire_protocol 代码分支），壳层 `effective_protocol` 由此强路由到 anthropic/gemini 轨 → **A5 遗留的目录层路由缺口已在数据层闭合**。

### 2.4 🔗 断链（回归）：A5 的 stale 测试未随 A6 同步更新

**实际证据**：

- `crates/agent-provider/tests/wire_integration.rs:383-412` `wire_routing_bundled_catalog_ground_truth`：
  - :384 `ModelCatalog::bundled()`
  - :398 `assert_eq!(claude, WireProtocol::Chat, "catalog 当前 mode=chat → claude 路由 chat")`
  - :403 `assert_eq!(gemini, WireProtocol::Chat, "catalog 当前 mode=chat → gemini 路由 chat")`
- 该测试写于 A6 补录**之前**（当时的 bundled catalog mode="chat"），断言的是**旧行为**。注释（:381-382）已预告「目录 mode 演进为专轨值时本断言须同步更新」，但 A6 补录**未更新该测试**。

**复核实测**（本复核真跑）：`cargo test -p agent-provider --test wire_integration wire_routing_bundled_catalog_ground_truth` → **FAILED**

```
thread '...panicked at crates\agent-provider\tests\wire_integration.rs:398:5:
assertion `left == right` failed: catalog 当前 mode=chat → claude 路由 chat
  left: Anthropic
 right: Chat
```

**影响**（对应不变式 I6 回归门禁 + I1）：当前 `cargo test -p agent-provider --test wire_integration` 为 **12 passed; 1 failed**——同一套件内既有 assertion（如 `anthropic_effort_tier_produces_enabled_thinking`）全绿，唯独这条陈旧路由断言失败。**这是「数据已激活、测试未跟」造成的回归红**，并非能力回退，但会阻塞 I6 全量门禁与 `wire_integration` 套件绿标。

**最小接线点建议（不改码）**：

- 更新 `wire_integration.rs:398/403` 断言为 `WireProtocol::Anthropic` / `WireProtocol::Gemini`（并把每条断言改为同时校验 mode 影响，如「A6 后 claude → Anthropic」），删除陈旧「当前 mode=chat」注释；这属**本轮 A6 收尾的一部分**（数据激活的测试同步），建议主控派单（T5.x 小单元或 A6 跟进 Agent）在一个绿窗口内落地并全量 `cargo test -p agent-provider` 复跑。
- 同步核查无其它 stale 断言：全仓 grep 仅此一处把 claude/gemini 钉在 Chat（链路 2 已覆盖），壳层测试用显式 dispatch 不受影响。

---

## 三、错误链路：C13 error_kind → 壳层 to_loop_event 透传 → session-loop stream.rs 消费

> 契约引用：C13（round3）、I5（错误分类链路贯通）、D7 §3.7 结构化分类字段。

### 3.1 agent-provider 侧（C13 产出）—— ✅ 一致

- `crates/agent-provider/src/events.rs:278` `Stop.error_kind: Option<ProviderErrorKind>`（wire 键 `errorKind`，None 省略）
- `events.rs:291` `stream_error_kind(message)` 统一分类入口；events.rs 测试（:545/:566/:595）钉死 None 省略 / camalCase wire / 13 类 kebab value。
- 各 parse core 均注入 error_kind：
  - `chat_core.rs:74-78`（错误帧分类）、`responses_core.rs:77-81/:210`、`anthropic_core.rs:117-121`、`gemini_core.rs:101-105/:259`.
- consume 侧 `consume/mod.rs:198-213` `effective_error_kind()`：优先采用 Stop 携带 error_kind，兜底按文案重分类。

### 3.2 壳层透传（to_loop_event）—— ✅ 一致

- `apps/agent-workbench/src-tauri/src/engine_provider/stream.rs:168-217` `to_loop_event`：`WireEvent::Stop { ... error_kind, ... }` → `ProviderStreamEvent::Stop { ..., error_kind, ... }`（:205 字段原样透传）。
- 注：该文件头注释（:164-167）仍写着「当前无 error_kind 字段……恒 None」的过时描述，但**实际代码已透传 error_kind**——注释滞后于实现，仅文档瑕疵，不影响接线（已在连接点核实代码 > 注释）。

### 3.3 session-loop 消费 —— ✅ 一致

- `crates/session-loop/src/stream.rs:164` `ProviderStreamEvent::Stop { error_kind: Option<ProviderErrorKind> }`
- `stream.rs:278` `Aggregate.error_kind`；`stream.rs:314` `self.error_kind = error_kind`（reason==Error 时）聚合。
- 向后兼容：`stream.rs:641`（D7 §3.7）Stop 未携带 error_kind（老注入方）→ 只标 providerError 不伪造；`stream_error_retry.rs:201` `error_kind: Some(classified.kind)` 消费。
- `conex_types::error::ProviderErrorKind` 两侧**共享类型直通**，无映射（round3 C13）。

**结论**：错误链路全链接通，无断链。每流错误 Stop 携带 `error_kind`（不再恒 None），符合 I5。

---

## 四、usage 链路：C14 归一化 → 各轨 usage 断言一致性

> 契约引用：C14（round3）、S-B1（usage 归一化形状）、I1。

### 4.1 归一化实现 —— ✅ 一致

- `crates/agent-provider/src/events.rs:155` `ProviderUsage::cache_breakdown(accounting) -> Option<CacheBreakdown>`：`input_total = miss + read + write` 恒等式（:73-74）；Included（OpenAI 系）`miss = prompt - read - write`、`input_total = prompt`（:150-151）；Excluded（anthropic/gemini 系）`miss = prompt`、`input_total = prompt + read + write`（:151；`event.rs:40` 注释对齐）。
- 归一在最底层 wait，`prompt_tokens` 保留原始值，`input=prompt-cached-write` 在聚合层派生（`consume/mod.rs:837-840` 注释对齐 C14）。

### 4.2 各轨 usage 断言一致性 —— ✅ 一致

- chat：`consume/mod.rs:843` `chat_usage_normalized_input_matches_s_b1`（miss=100-70-10=20，input_total=100，恒等式成立）。
- anthropic：`tests/parse_anthropic_e2e.rs:166-184`（prompt 保 50、reasoningTokens=4 拆分、cacheReadTokens=8、cacheWriteTokens=4）；`parse/anthropic_tests_usage.rs:147/173`（reasoning_tokens / thinking_tokens 别名）。
- gemini：`tests/parse_gemini_e2e.rs:121-139`（prompt=40、reasoning=15、cacheWrite=4）；`parse/gemini_tests_usage.rs:190`（cache_write 解析）。
- responses：`parse/responses_tests.rs:577`（reasoning_tokens=4）。
- `events.rs:735-853` 5 项 `cache_breakdown` 单测（Included/Excluded/None read·write/优先 miss 字段/负值钳 0/缺 prompt 返回 None）。

**结论**：usage 归一化形状（C14/S-B1）实现与各轨断言一致性成立，reasoning **从 completion 侧独立解析不从 completion 扣走**（与 session-loop 语义一致，`anthropic_e2e.rs:179-184` explicit）。无断链。

---

## 五、多供应商链路：C2 ProviderConfigStore → 壳层 config_profile_apply → 前端 providerProfiles / opencode-go

> 契约引用：C2（round1）、I2（多提供方并存、壳 config 快照 ≥2 提供方、引擎可服务 opencode-go profile）、T5.2a（引擎侧 profile 服务）。

### 5.1 C2 ProviderConfigStore（agent-provider crate）—— ✅ 一致（crate 层）

- `crates/agent-provider/src/config.rs` 多提供方映射（`config` / `resolve(id)` / `configs()` / per-provider secret/env，round1 27 passed）。**此层正确且测试绿。**

### 5.2 壳层 config_profile_apply → 前端端到端 —— ✅ 一致（单活动 profile 流）

- 前端：`apps/crish-desktop/src/api/provider-profiles/rustProfileStore.ts:95` `configProfileApply(...)` → Tauri `config_profile_apply`；`profileStore.ts:610` `activateProfileModel`；`profileCatalog.ts:86` 定义 `opencode-go` 预置 profile（预置 seed deepseek-v4-flash，`providerProfiles.ts` 测试 :146/:351 钉死）。
- 壳层命令：`apps/agent-workbench/src-tauri/src/config/provider.rs:527` `config_profile_apply`（写 DPAPI 密钥槽 + 引擎 store + `state.reload_provider()` 重建 `HttpProviderCall` 原子交换）；注册于 `main.rs:216`、`command_manifest.rs:120`。`core_run_commands_tests.rs:1604/1694/1746` 三个命令级测试全绿。
- 引擎侧：`engine_provider.rs:81` `load_provider_endpoint()` → `EngineProviderConfig`（base_url/api_key/model 三件套）→ `HttpProviderCall`。`config_profile_apply` 热切换后引擎**可服务切换到 profile 的生效模型**。

### 5.3 ⚠️ 部分 / 待核查：壳层未消费 C2 多提供方映射；Tauri 壳 config 快照非多提供商

**实际证据**：

- 壳层**不引用** `agent_provider::config::ProviderConfigStore`（全仓 grep 壳层无 ProviderConfigStore / resolve(provider_id) / configs() 消费；`engine_provider.rs:34` 仅 `use agent_provider::config::Endpoint`）。壳层用**单活动** `ApiConfigStore`（`config/provider.rs` `effective_*` 路径）+ `RuntimeProviderConfig`（`config/resolution.rs:17`）。
- Tauri 壳 config 快照为**单提供商形状**：`config/provider.rs:299-324` `snapshot()` 只含单 `baseUrl` / 单 `model` / `hasApiKey` / `credentialMode`，**无 ≥2 提供方数组**；`core_query_commands.rs:244-252` `provider_status_from_config()` 同为单活动有效配置。
- 前端 `clientApi.ts:798` 注释直言：「真实配置轨 = providerProfiles + update-config；**引擎仅 OpenAI-compatible**」，侧面印证引擎当前以单活动 openai-compatible 轨服务，未驱动 C2 多提供方并存的运行时。

**结论**：**`配置面多提供方并存 + UI 可切换`（I2 第一子断言）在运行时未达成**——profile 切换是「换单活动生效配置」而非「多提供方并行注册」。`Tauri 壳 config 快照 ≥2 提供方`（I2 第二子断言）未达成。`引擎可服务 opencode-go profile`（I2 第三子断言）**部分达成**（单活动切换可用，非多提供方）。此属 **T5.2a 未/部分完成** 状态，与本复核任务提示「T5.2a 若未完成标注待核查」一致。

**非阻塞 vs 阻塞定性**：多提供方并存的运行时化（引擎按 profile/provider 多实例并行）归属 T5.2a 的完整交付；若战役以「单活动 profile 切换 + 引擎服务生效 profile」为可接受的 I2 达成口径，则链路 5 仅剩「config 快照 ≥2 提供方」一项未满足（**阻塞 I2 完整验收**）；否则 T5.2a 需派单补引擎多实例装配。**建议主控按 I2 验收口径裁决**（是否允许单活动达成）。

---

## 六、断链/待核查项汇总（按严重度分类）

### 🔴 阻塞 I1-I6 不变式

| 项  | 位置                                                                                       | 契约         | 结论                                                                              | 最小接线点建议                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | 生产请求构建入口 `engine_provider.rs:159/197/206/295` + `thinking.rs` + `build_chat.rs:47` | I4 / C17     | 显式档位越能力未在 I/O 前拒绝，被静默上wire                                       | 壳层 `HttpProviderCall::stream`/`request_body_for` 之上，按生效 model 能力（`bundled_catalog` + `describe_model`/`infer_thinking_capability`）调 `build_reasoning_wire`/`resolve_reasoning_level`（Reject 默认），Err 即在 HTTP 前返回 |
| B-2 | `crates/agent-provider/tests/wire_integration.rs:398/403`                                  | I6 / I1 / A6 | A6 激活目录 mode 后，stale 测试仍断言 chat，实测失败（12 passed / 1 failed）      | 更新断言为 `Anthropic/Gemini`，同步清理「当前 mode=chat」陈旧注释，全量复跑 agent-provider                                                                                                                                             |
| B-3 | 壳 config 快照 `config/provider.rs:299`；壳层未消费 C2 `ProviderConfigStore`               | I2 / C2      | 壳层仍单活动 provider，config 快照单提供商形状（<2 提供方）；多提供方运行时未装配 | 主控按 I2 口径裁决：接受「单活动 profile 切换」或派 T5.2a 补引擎多实例装配 + config 快照 ≥2 提供方                                                                                                                                     |

### 🟡 非阻塞（文档/注释/口径瑕疵，不影响接线）

| 项  | 位置                                                      | 说明                                                                                                                                                             |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-4 | `engine_provider/stream.rs:164-167`                       | 模块头注释仍写「Stop 当前无 error_kind 字段……恒 None」，但代码已透传 error_kind——注释滞后于实现（仅文档漂移，建议随权限更新注释，非功能问题）                    |
| B-5 | `engine_provider_tests.rs` anthropic/gemini 显式 dispatch | round3 C12 记录的「壳层无法构造 fake catalog，三处一致测试用显式 WireProtocol dispatch 证明」——测试局限，非错误；建议在 T5.2a 后补壳层 fake catalog 通路（可选） |

---

## 七、未覆盖项 / 新发现契约问题（上报主控裁决）

1. **A1 遗留确认（非阻塞性结论重申）**：round4 小结 §二已登记「生产请求面 I/O 前拒绝的接线未落（build_chat.rs 请求构建入口 / engine_provider 装配不在 A1 文件域）」。本复核确认该遗留**仍然存在**，且已被 `vendor.rs` 内的 `reasoning_effort_object`/`build_chat.rs` 旧序列化路径掩蔽（越能力档位原样上wire）。这是 **I4 目前唯一未接线子面**，请求主控在 R5 内或 R6 前派单落线（候选最小接线点见链路 1）。
2. **A5 遗留（C12 数据激活）结论分歧**：A6 已在数据层激活四轨路由（生产正确），但造成 A5 遗留测试 `wire_routing_bundled_catalog_ground_truth` **回归红**。这是「数据激活的测试未同步」——建议把该测试更新与 A6 作为同一完成态收束，避免 R5 门禁（T5.3）被打回。
3. **T5.2a 状态不透明**：本复核只能确认「壳层 config_profile_apply → 引擎单活动 provider 热切换」可用；无法确认「引擎多提供方实例装配」（C2 ProviderConfigStore 运行时消费）是否为 T5.2a 的当前交付范围。请求主控裁决 I2 验收口径并核对 T5.2a 产出（若 T5.2a 已完成，我复核的证据显示壳层未消费 C2 多提供方映射，二者需对齐）。
4. **新发现（文档漂移）**：`stream.rs:164-167` 注释与实现不符（见 B-4），非功能问题。

---

## 八、复核方法论与证据可信度

- 本复核为**只读核查**：未改任何代码，未提交 git，未运行 R5 之外的回归；唯一复核实测为 `cargo test -p agent-provider --test wire_integration wire_routing_bundled_catalog_ground_truth`（发现并确认 B-2 红）。
- 契约引用均依据 `execution/round1-4-*小结.md` + `round4-校验面-vendor一体.md`；实际代码均标注 `文件:行号`。
- 全仓符号引用核查用 grep 确认（`build_reasoning_wire`/`resolve_reasoning_level`/`ProviderConfigStore` 的壳层消费为空，支撑链路 1/5 的断链/部分结论）。
- 本清单为复核产物，不含修复；所有断链项均应以主控裁决为准，由主控派相应任务单元落地。
