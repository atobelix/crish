# 轮次报告：R2（协议层，P2）

## 轮次元信息

- 轮次：R2
- 本轮 Agent 数：9 / 12（T-10、T-11、T-12、T-13a、T-13b、T-14/T-15、T-16、T-17 + 模型时代审计）
- 任务包数：8（T-10~T-17，P2 全量）+ 1 项审计修正任务（R0.5）
- 门禁执行结果：**通过**（Rust 75 套件 0 失败 / typecheck 0 错误 / vitest 26 通过）
- 日期：2026-08-03

## 一、已完成

| 任务单元 | 文件域                                  | 改动摘要                                                                                                                                                                                                                                                                                                                                                     | 自验证                                                  |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| T-10     | `events.rs`                             | `cache_miss_tokens` 字段、`CacheAccounting`（Included/Excluded）、`CacheBreakdown`（C9 恒等式）、`cache_breakdown()`、`merge_usage_shards`（max 语义）+ 12 测试                                                                                                                                                                                              | agent-provider 全绿                                     |
| T-11     | `parse/chat.rs`、`parse/gemini.rs`      | hit 链（顶层 prompt_cache_hit_tokens 优先→details→Kimi 顶层）、write 链三别名、`total_cached_tokens` 别名 + 7 测试                                                                                                                                                                                                                                           | agent-provider 全绿                                     |
| T-12     | `parse/anthropic.rs`                    | `merge_anthropic_usage` 收敛共享 `merge_usage_shards`（行为等价）+ 帧级 0-不覆盖用例                                                                                                                                                                                                                                                                         | agent-provider 全绿                                     |
| T-13     | `request/cache.rs`（新）+ mod.rs        | 类型族（CacheRetention/TtlBucket(C3)/CacheControl/CacheKey 码点64(C4)/CacheMechanism/CacheCapability）、`allocate_breakpoints`（4 上限丢尾）、`build_cache_policy`（C2 唯一入口，PlaceholderCatalog 占位）、`CACHE_CAPABILITY_TABLE`（P3 矩阵转录兜底）、`retention_wire_value`、`affinity_header`、`apply_cache_controls`/`text_to_parts_with_cc` + 25 测试 | agent-provider 全绿                                     |
| T-14     | `request/messages.rs`                   | `ChatContentPart::Text.cache_control` 载体 + `with_cache_control`（None 时字节不变）                                                                                                                                                                                                                                                                         | agent-provider 全绿                                     |
| T-15     | `request/build.rs`、`tools.rs`          | `ChatCompletionsRequestOptions.cache`、body 顶层三键注入（compactObject 等价）、`to_cache_aware_tool`、`cache_control_for_ttl`                                                                                                                                                                                                                               | agent-provider 全绿                                     |
| T-16     | `session-loop/provider.rs`、`stream.rs` | `ProviderRequest.session_id`、ConsumeBuilder `usage_accounting`、metadata `cacheBreakdown` 派生（camelCase）+ C5 补记                                                                                                                                                                                                                                        | session-loop 217 通过                                   |
| T-17     | `engine.rs`、`comparison.md`            | `build_cache_policy` 唯一入口接线（C2）、SharedProvider session_id 注入、E0063 修复、`extra` overrides 预留通道、comparison 2.4-2.7 已落地标记                                                                                                                                                                                                               | crish-agent-workbench 174+10+17 全绿；workspace 75 套件 |
| R0.5     | 前端 8 文件 + 审计文档                  | 模型时代审计：~150 处引用，37 处过时纠正（deepseek-chat→v4-flash、gpt-4o→gpt-5.x、gemini-1.5→3.x、claude-3.5→4.5+ 等，v4-flash 上下文 128k→1M）；8 项风险留待 R3                                                                                                                                                                                             | vitest 26 通过、tsc 绿                                  |

提交记录：`59d4efde`（波2 usage+session_id）、`ff544421`（T-13a/b）、`80b4fb11`（T-14/15）、`807ae81d`（T-17+审计）。

## 二、门禁执行结果

- `cargo test --workspace`：**75 套件 0 失败**（74→75，T-17 新增用例计入）
- `npm run typecheck`：exit 0
- `npx vitest run src/api/pricingStore.test.ts src/api/modelCatalog.test.ts`（app 侧）：26 通过

## 三、发现的问题与主 Agent 裁决

| #     | 问题                                                                                                       | 裁决/处置                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R2-D1 | T-13 任务体过大导致 3 次空返回（中断 agent 曾写入磁盘但未回报）                                            | 拆分 T-13a（类型）/T-13b（策略）串行执行；中断 agent 写入的 T-14/T-15 实现经核验完整且与方案一致，直接采纳并提交 |
| R2-D2 | T-17 声明 1：`build_cache_policy` 等函数未在 request/mod.rs re-export                                      | 接受 engine.rs 完整路径直导；request 层函数 re-export 不再追加（避免域外改动），后续轮次如需可补                 |
| R2-D3 | T-17 声明 2：session_id 注入选型（SharedProvider 适配层 vs build_request 直填）                            | 接受适配层方案（测试已验证）；streaming.rs 直填改动归 T-33（R4）评估                                             |
| R2-D4 | T-17 声明 3：ConsumeBuilder Excluded 无消费路径（无 anthropic/gemini 原生端点）                            | 接受：以 HttpProviderCall 注释登记规则，实际接线待原生端点创建时落地                                             |
| R2-D5 | T-17 声明 4：`EngineProviderConfig.extra` 恒空表                                                           | 接受为 P3 overrides 预留通道（非死代码）                                                                         |
| R2-D6 | 模型时代审计 8 项风险（vendor.rs/thinking-intensity.ts 的 kimi-k3/glm-4.7 能力判定缺口、catalog 未收录项） | 移交 R3：T-19（行为矩阵）与 T-26（文档回写）消化                                                                 |

## 四、输出为下一轮输入（R3）

- `build_cache_policy` 的 PlaceholderCatalog 待 T-18/T-19 替换为 ModelCatalog + `cache_behavior_for` 数据真源（C2 完整化；T-17 验收用例复验）
- 模型时代审计 8 项风险项清单 → T-19/T-26 处理（详见 `R0.5-model-era-audit.md` 表 3）
- `EngineProviderConfig.extra` overrides 通道 → T-23 注入点
- 契约登记文档已含 `ProviderRequest.session_id`（C5 闭环）
