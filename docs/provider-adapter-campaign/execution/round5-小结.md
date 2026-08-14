# Round 5 小结 · 边缘协议 + 前端收敛 + 全量回归 + 复核闭环

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 5
> 日期：2026-08-14 · 主控收束

## 一、完成项（含测试证据）

| 单元  | 任务                                              | 结果 | 测试证据                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A6    | catalog mode 数据补录（四轨路由数据层激活）       | ✅   | 33 组 mode 变更（anthropic 11 / gemini 22）；`catalog_json_parses_fully_and_keys_match_entries` 绿；wire_integration 断言同步更新                                                                                           |
| T5.1  | 边缘协议解析器（azure-openai-responses 先例）     | ✅   | `AzureResponsesParser` 95 行（**100% 委托既有 ResponsesParser 内核**，零复制）；10 单测 + 3 e2e；parse_responses 回归绿                                                                                                     |
| T5.2a | 壳层 profile 服务（引擎服务 opencode-go profile） | ✅   | `config/profile.rs`（395 行）+ provider.rs profile-aware；**opencode-go 真实 HTTP 断言**（→ `/zen/go/v1/chat/completions` + deepseek-v4-flash）；config 30 + engine 83 + engine_provider 16 全绿；**I2 关键验收达成**       |
| T5.2b | 前端档位单源收敛（thinkingGear.ts）               | ✅   | 静态档位表移除；148/148 目标单测绿；typecheck 绿；行数 Hard blocks: 0（modelCatalog 回落 BASELINE）                                                                                                                         |
| T5.3  | 全量门禁回归                                      | ✅   | agent-provider **720 passed**（含 azure）+ session-loop **534 passed** + workspace 收敛窗口绿 + typecheck 绿；记录文档落盘                                                                                                  |
| T5.4  | 回归复核链（B-1/B-2/B-3 识别）                    | ✅   | 复核清单落盘；3 断链项全部分类（B-1 阻塞 I4 / B-2 阻塞 I6 / B-3 阻塞 I2）                                                                                                                                                   |
| B-1   | 请求面拒绝接线 + 点号归一（补丁）                 | ✅   | `out_of_whitelist_effort_rejected_before_http`（**死端口证明 HTTP 未发出**）+ 省略/合法档位三态断言；`dotted_model_normalizes_to_hyphen_key_gemini`；agent-provider **675 passed**；壳层 engine_provider 21 + engine 103 绿 |

## 二、断链闭环记录（T5.4 → B-1）

| 断链 | 内容                                     | 闭环                                                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1  | 生产请求面拒绝未接线（I4 最后一块）      | ✅ B-1 落线：壳层 `stream()` HTTP 前调 `validate_reasoning_effort`（数据源 = C9 `describe_model`——因 C17 `ThinkingCapability.levels` 为 `&'static` 无法承载动态模型级白名单，技术决策上报主控采纳）；错误 = `ClassifiedStreamError`（InvalidRequest + `UNSUPPORTED_REASONING_EFFORT` 标签） |
| B-2  | wire_integration stale 断言红（A6 引发） | ✅ A6 同步更新断言（claude→Anthropic / gemini→Gemini）；wire_integration 13/13 绿                                                                                                                                                                                                           |
| B-3  | 壳层单活动 provider（I2）                | ✅ T5.2a profile 服务：活跃 profile → 独立 EngineProviderConfig；opencode-go 预置 profile 真实可服务                                                                                                                                                                                        |

## 三、契约登记（R6 收尾消费）

- **C21 profile 服务**：`config/profile.rs`（`ProfileConfig`/`PersistedProfileState`/`apply_profile_config`/`resolve_active_context`/`snapshot_providers`）；活跃 profile 优先、回退单轨；`config_get` 快照含 `activeProfileId` + `providers`（≥2 提供方可达）。
- **C22 请求面拒绝**：`validate_reasoning_effort`（壳层 thinking.rs，数据源 describe_model）；三态（显式越界拒绝 / 省略放行不发送 / 合法放行发送）；错误 InvalidRequest + UNSUPPORTED_REASONING_EFFORT。
- **C23 点号归一**：`resolve_wire_protocol` 模型 lookup 支持点号→横线归一（`gemini-2.5-pro` → `gemini-2-5-pro`）；不匹配走原兜底。
- **C24 azure 解析器**：`AzureResponsesParser`（100% 委托 ResponsesParser 内核；错误帧 message 优先；usage 走 C14 共享归一；终态映射 response_status_to_stop）。
- **C25 前端档位单源**：`thinkingGear.ts`（`thinkingLevelOptionsFor`/`effortsFromEntryWire`/`resolveCatalogEfforts`）；`defaultThinkingLevel` 语义 = 引擎默认档位透传（'default' 回落提供方默认）；消费端 ConnectionLifecycle/directFetchBridge/bootstrap-full 接线。

## 四、主控裁决与记录

1. **B-1 数据源决策**：C17 `&'static levels` 无法承载动态模型级白名单 → 用 C9 `describe_model` 作校验数据源（保留 `ReasoningReject::UNSUPPORTED_TAG` 分类语义）——采纳；reject.rs/dialect.rs 实现未改。
2. **T5.2a 吞并**：其 3 个测试被并行 git 定时 Agent 扫入 `3819df61`——已核对工作区与 HEAD 一致（内容完整，不管归属）。
3. **既有基线/并行战役失败**（不阻塞本战役）：skillsApi.ts 676 行基线、clippy manual_map 2 条、conex-browser flaky 1 条、壳层 core_run_commands 4 条（并行改动域）。
4. **A2 宁缺毋滥遗留**：hy3 无条目、qwen3-8-max 无 pi-ai 数据、kimi-k3 分裂——保持。
5. **历史溢出**（R6 决定）：consume/mod.rs 891、messages.rs 531、modelCatalog.ts 868（BASELINE 登记）。

## 五、基线变化

- 轮前：R4 661 passed
- 轮后：agent-provider **675 passed**（lib）+ wire_integration 13 + azure 3 e2e；session-loop 534；壳层 engine 103 + engine_provider 21 + config 30；前端 typecheck 绿；行数 Hard blocks: 0
- 全量 `cargo test --workspace`：收敛窗口绿（并行战役 in-flight 波动排除）

## 六、对下一轮（R6 收尾）的输入

- 不变式 I1-I6 全部有测试证据（I1 四协议 / I2 opencode-go profile / I3 档位映射 / I4 拒绝语义 / I5 真实接线 / I6 回归门禁）
- R6 任务：T6.1 关闭报告（不变式核对表逐条对应测试名）、T6.2 跨轮毒点沉淀 + 基线闭环
