# 轮次报告：R3（厂商模型层，P3）

## 轮次元信息

- 轮次：R3
- 本轮 Agent 数：10 / 12（T-18、T-19、T-21、T-23、T-20、T-22、T-24、T-25、T-26、T-24.5）
- 任务包数：9（T-18~T-26，P3 全量）+ 1 项整合任务（T-24.5）
- 门禁执行结果：**通过（本方案域）**——Rust 74 套件本域全绿（474 agent-provider 测试）；crish-agent-workbench 2 项失败**归因并行 I1 阵营**（见第三节 R3-D3）
- 日期：2026-08-03

## 一、已完成

| 任务单元 | 文件域                                                                                                   | 改动摘要                                                                                                                                                                                                           | 自验证                                                |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| T-18     | `models/`（新）                                                                                          | ModelCatalog + catalog.json 28 条（deepseek×2/anthropic×7/openai×2/kimi×1/grok×2/minimax×3/gemini×4/glm×4/qwen×3）+ 多级兜底 lookup + 查询接口 + 9 测试                                                            | agent-provider 427 全绿                               |
| T-19     | `models/behavior.rs`                                                                                     | VendorId（11 变体，A1-20 独立类型）、CacheBehavior 9 开关、静态矩阵（DeepSeek omit 恒 true / MiniMax M2 开 M3 关 / GLM 保守）、kimi-k3/glm-4.7 覆盖补全（R0.5 表 3）、`cache_behavior_for`（C2 数据真源）+ 15 测试 | 442 全绿                                              |
| T-21     | `models/ttl.rs`                                                                                          | CacheTtl（C3 单实现于 behavior.rs，ttl.rs re-export）+ `cache_ttl_for_provider_model`（catalog > vendor 默认 > None；gpt-5.6 排除 24h 档 A1-11）+ 5 测试                                                           | 29（合并 harness）全绿                                |
| T-23     | `engine.rs`                                                                                              | provider_url 接入 supports_responses_for（v4-flash 允许 / v4-pro 降级 chat-completions / 未知厂商放行）+ OnceLock catalog 单例 + 2 测试                                                                            | crish-agent-workbench 176 全绿                        |
| T-20     | `models/cache_key.rs`                                                                                    | `derive_prompt_cache_key` 等价委托（C4 真源在 P2）+ `session_affinity_headers`（Grok x-grok-conv-id / Dashscope enable 数据表）+ 9 测试                                                                            | 462 全绿                                              |
| T-22     | `request/deepseek_invariants.rs`                                                                         | DeepSeek 不变量测试钉死（无 cache_control 键 / reasoning_content 必带 / 矩阵联动）+ git grep 越界审计通过（257 行全部在框架/矩阵/测试）                                                                            | 462 全绿                                              |
| T-24     | `models/catalog.rs`、`catalog_commands.rs`（新）、`main.rs`、`command_manifest.rs`、`commandManifest.ts` | `with_overrides`（白名单禁覆盖身份键）/`upsert_from_scan`（不覆盖价格）、`catalog_get`/`catalog_refresh` 命令 + **C7 三处登记**（manifest 73→75、main.rs 注册、mock 快照真源 commandManifest.ts）+ 11 测试         | workspace 75 套件全绿、e2e 单 worker 17/17            |
| T-25     | `modelCatalog.ts`                                                                                        | 扫描结果经 catalog_refresh 上送合并（窗口/能力位，失败降级不阻塞）+ 4 测试                                                                                                                                         | 19/19 全绿、typecheck 绿                              |
| T-26     | 00-catalog、P3 方案文档                                                                                  | §12.4 落地核销（28 条转录差异、R0.5 表 3 消化状态）、P3 ⑦ 实施核销（步骤 1-6、A1-13 核销）                                                                                                                         | 回读校验通过                                          |
| T-24.5   | `request/cache.rs`、`engine.rs`                                                                          | **C2 完整化**：build_cache_policy 接入真实 ModelCatalog + cache_behavior_for（删除 PlaceholderCatalog，omit 由矩阵唯一驱动），engine 传 bundled_catalog() + 4 新测试                                               | agent-provider 474 全绿；T-17 用例走真实 catalog 路径 |

提交记录：`656d67c6`（波 2）、`21191a0d`（波 3）、`93b19061`（波 4）。

## 二、门禁执行结果

- `cargo test -p agent-provider`：474 passed / 0 failed
- `cargo test -p crish-agent-workbench`：177 passed / **2 failed（归因外部，见 R3-D3）** / 2 ignored
- `cargo test --workspace`：74 套件（2 项失败同上归因）
- `npm run typecheck`：exit 0；vitest modelCatalog 19/19；e2e 单 worker 17/17

## 三、发现的问题与主 Agent 裁决

| #     | 问题                                                                                                                                                                                                               | 裁决/处置                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-D1 | T-19 将 `CacheTtl` 定义于 behavior.rs（任务书 C3 原意放 ttl.rs）                                                                                                                                                   | 接受单一实现（serde 值域/seconds/parse 齐备），T-21 re-export + 固有 impl 补 as_str()；C3 实质目标（单类型、无 CacheTtl 冲突）达成；已记入 P3 ⑦ 核销                                                                                                                                                                                                                              |
| R3-D2 | T-22 观察：build_cache_policy 仍消费 PlaceholderCatalog                                                                                                                                                            | T-24.5 专门任务解决（见上），C2 闭环                                                                                                                                                                                                                                                                                                                                              |
| R3-D3 | **crish-agent-workbench 2 项测试失败**（test_workbench_run_shell_blocks_eleven_red_lines / test_host_opener_blocks_eleven_red_line_targets）——mkfs.ext4 /dev/sda 被 sandbox 判 RequiresApproval 而测试期望 Blocked | **归因并行 I1 阵营提交 824db293（2026-08-03 14:22，redline-first gatekeeper S2 语义变更）**：时间线证据——本方案 R3 波 2 门禁（13:30）该批全绿（176/0）、I1 提交（14:22）后失败出现、失败文件（process.rs/host_openers/execute.rs）与 conex-sandbox 分类均非本方案文件域。**移交 I1 阵营修复**（其 S2 变更需同步 workbench 红线测试或调整分类），本方案轮次报告登记，R7 终验时复核 |
| R3-D4 | e2e 并行模式启动门闩 flaky（T-24 记录）                                                                                                                                                                            | 单 worker 全绿判定通过；并行 flaky 记录移交 R7/CI 层                                                                                                                                                                                                                                                                                                                              |

## 四、输出为下一轮输入（R4）

- `build_cache_policy` 已完整消费 catalog/矩阵（C2 闭环），R4 预算层可直接消费 `ModelCatalog::context_window_for`（C12）
- 契约登记文档：`ProviderRequest.session_id` 已登记（C5 闭环）
- T-29 与 T-07 跨轮串行已满足（core_run_commands.rs）；T-33 与 T-03 串行（LoopState）；T-30 与 T-06/T-17/T-23 串行（engine.rs）
- 外部依赖注意：R4 起若 crish-agent-workbench 全量门禁仍被 R3-D3 的 2 项失败阻塞，以"非本方案域 + 归因登记"为准判定，避免误伤
