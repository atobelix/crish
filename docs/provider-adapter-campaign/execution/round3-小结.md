# Round 3 小结 · 接线主干（G1 全部子面 + M3 承接）

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 3
> 日期：2026-08-14 · 主控收束

## 一、完成项（含测试证据）

| 单元     | 任务                                                                            | 结果 | 测试证据                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3.1     | ProviderRequest 增 reasoning_effort（session-loop 本地等价枚举）                | ✅   | session-loop lib 452 passed；`reasoning_effort_wire_literals_align_with_agent_provider` + `reasoning_effort_field_propagates_through_request`（run_loop 46 passed）                                                 |
| T3.2     | 壳层一体改造：四轨协议路由 + 思考档位消费 + INV-07 + engine_provider.rs 拆分    | ✅   | engine_provider 模块 17 passed（9 新增）；engine 套件 103 passed；**engine_provider.rs 848→400 行**（拆 connection/timestamp/protocol/headers/thinking/stream 6 子模块）；`cargo check -p crish-agent-workbench` 绿 |
| T3.3     | error_kind 全链（events/consume/4 parse core）                                  | ✅   | agent-provider lib 641 passed；`stream_error_kind` 统一分类入口 + Stop.error_kind 字段                                                                                                                              |
| T3.4     | usage 归一化（anthropic reasoning + gemini cache-write + cache_breakdown 派生） | ✅   | agent-provider 674 passed（lib 641 + 集成 33）；5 项归一用例；两端 e2e usage 断言更新                                                                                                                               |
| T3.5     | 会话亲和头 seam（x-deepseek-harness-session-id）                                | ✅   | 波 2 新增 7 测试全绿；既有 x-grok-conv-id 回归绿                                                                                                                                                                    |
| T3.6     | maxTokensField 消费（protocol::max_tokens_field 按 C5 判定表）                  | ✅   | 波 2 断言：moonshot → max_tokens / openai.com → max_completion_tokens / 默认 → max_tokens                                                                                                                           |
| 主控顺带 | engine_channels.rs:128 第二处 maxTokensField 硬编码修复 + unused import 清理    | ✅   | `cargo check -p crish-agent-workbench` 零警告                                                                                                                                                                       |

**主控全量核验（真跑）**：agent-provider **674 passed; 0 failed; 0 ignored**；session-loop lib 452 passed；壳层编译零警告；engine_provider.rs 恰好 400 行（门禁达标）。

## 二、契约登记（对 R4-R5 的输入；只追加不删改语义）

### C11 · ProviderRequest.reasoning_effort（R4 校验面消费）

- `session_loop::ReasoningEffort` 本地等价枚举（Off/Auto/Minimal/Low/Medium/High/Xhigh/Max），wire 字面与 agent-provider 完全一致（单测锁定）；`ProviderRequest.reasoning_effort: Option<ReasoningEffort>`，None=提供方默认；未引入跨 crate 依赖（B3.4 契约保持）。

### C12 · 四轨协议路由接线（R4/R5 消费）

- WireProtocol → URL/body/parser 三处同轨（`engine_provider/protocol.rs`）：chat→`/chat/completions`+chat body+ChatParser；responses→`/responses`+responses body+ResponsesParser；anthropic→`/v1/messages`+anthropic body+AnthropicParser（含 push_alternating INV-07 投影）；gemini→`:generateContent`+gemini body+GeminiParser。
- 思考档位：R3 经 `resolve_thinking_params`（系列级）→ thinking_intensity → builder（anthropic budget_tokens / gemini thinking_level / chat reasoning_effort）；**R4 落模型级映射**（T4.2）。
- **测试局限记录**：`ModelCatalog.entries` 为 `pub(crate)`，壳层无法构造 fake catalog，三处一致测试用显式 WireProtocol dispatch 证明；请求侧 mock 端到端留 R5 补（S-A6 形态）。

### C13 · error_kind（R4 校验面消费）

- `Stop.error_kind: Option<ProviderErrorKind>`（wire 键 `errorKind`，None 省略）；统一分类入口 `stream_error_kind`；两侧共享 `conex_types::error::ProviderErrorKind` **直通无需映射**；`#[serde(default)]` 兼容既有消费方。

### C14 · usage 归一化（R5 回归消费）

- `prompt_tokens` 保留原始值；归一 `input = prompt - cached - write` 在 usage 聚合层经 `cache_breakdown(accounting)` 派生（Included → miss；Excluded → miss=prompt/input_total=prompt+read+write）；anthropic reasoning_tokens 解析补全（output_tokens_details.reasoning_tokens → thinking_tokens 兜底）；gemini cache_write_tokens 解析补全（cache.writeTokenCount，camel/snake 双形别名）；reasoning 独立解析不从 completion 扣走（与 session-loop 语义一致）。

### C15 · 会话亲和头 seam（R5 前端收敛消费）

- `session_affinity_headers(session_id)`：非空注入 `x-deepseek-harness-session-id`；`affinity_headers_for(policy)`（x-grok-conv-id 缓存亲和）保留；头只进 HTTP 层不进 body。

### C16 · maxTokensField 消费

- `engine_provider/protocol.rs::max_tokens_field(config)` 按 C5 判定表（moonshot 等旧式网关 → MaxTokens；openai.com/o 系列 → MaxCompletionTokens；openai-compatible 默认 → MaxTokens）；**engine_channels.rs:128（ProviderSummarizer）第二处硬编码已由主控同轨修复**（复用同一函数），unused import 清理。

## 三、主控裁决与记录

1. **maxTokensField 第二处硬编码**（波 2 上报 engine_channels.rs:128）→ 主控复用 `protocol::max_tokens_field` 修复 + 清理 unused import，壳层零警告。
2. **error_kind 直通**：两侧共享 `conex_types::error::ProviderErrorKind`，无需类型映射。
3. **四轨测试局限**：壳层无法构造 fake catalog（entries pub(crate)）→ 请求侧 mock 端到端留 R5（T5.x 或新增小单元）。
4. **并行战役中间态**（非本战役）：其他 Agent 移除 `BlockId::parse`（conex-note-runtime 编译失败）、in-flight 改 `budget_compaction.rs`——观察自愈，未干预。
5. **历史溢出登记**（战役范围外，R6 收尾时决定是否另开）：`consume/mod.rs` 891 行（轮前 836）、`messages.rs` 531 行（轮前 481）——SR-06e 门面历史基线。
6. **规范遵守**：全轮 Agent 逐条确认（零占位/零压制/ignored=0/语义断言/行数 ≤400/领域纯净）；clippy agent-provider 与壳层均清零。

## 四、基线变化

- 轮前：R2 631 passed
- 轮后：agent-provider **674 passed**（+43：error_kind/usage 归一/壳层相关新增）；session-loop 452 passed；壳层编译零警告；engine_provider.rs 400 行（门禁达标）
- `cargo test --workspace` 全量留 R5 门禁轮（受并行战役中间态干扰，R5 收口时以稳定窗口为准）

## 五、对下一轮（R4 校验面）的输入

- 依赖 C9（描述接口）/C11（ProviderRequest.reasoning_effort）/C12（四轨接线）/C13（error_kind）/C1（模型级档位载体）
- R4 任务：T4.1 请求侧降级改拒绝（G8-b，显式档位 I/O 前拒绝，默认开启）+ G8-c 覆盖；T4.2 模型级 wire 改名消费（G6-a，C1 wire_effort_for 接入）；T4.4 anthropic-beta 头随 adaptive 跳过（G6-b）；T4.5 开关/嵌套方言 + off 显式 disabled（G5-c + G6-c，T4.3 已并入）
- 注意：vendor.rs/vendor_wire.rs 为 T4.1/T4.2/T4.4/T4.5 共写文件（拆函数面或同 Agent 顺序，方案 M7 同款处理）
