# 轮次报告：R1（前缀稳定，P1）

## 轮次元信息

- 轮次：R1
- 本轮 Agent 数：9 / 12（A1 T-01、A2 T-02、A3 T-03、A4 T-04、A5 T-05、A6 T-06、A7 T-07、A8 T-08、A9 T-09）
- 任务包数：9（T-01~T-09，P1 全量）
- 门禁执行结果：**通过**（Rust 74 套件 0 失败 / typecheck 0 错误 / vitest scoped 93 通过）
- 日期：2026-08-03

## 一、已完成

| 任务单元 | 文件域                                                          | 改动摘要                                                                                                                                           | 自验证                                |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| T-01     | `crates/agent-tools/src/registry.rs`                            | `list_definitions` 按 name 码点序排序（P6 R1，不动 `list()`）+ 新测试                                                                              | agent-tools 全绿                      |
| T-02     | `request/schema.rs`（新）、`request/mod.rs`、`request/tools.rs` | `canonicalize_schema`（R2.1-R2.9 对齐）+ `canonical_json_string` + wire 出口接线 + rust-parity 34 样例 cargo 测试                                  | agent-provider 全绿、clippy 零警告    |
| T-03     | `session-loop` handlers/streaming/mod/steering + tests + bench  | LoopState.tools_snapshot 快照锁定、build_request 补 system_prompt 填充行、4 追加点不变量注释、3 个 E2 集成测试（`prefix_stability.rs` 新套件）     | session-loop 全绿                     |
| T-04     | `request/build.rs`                                              | `build_system_prompt`（trim+空值归一）+ 三态单测                                                                                                   | agent-provider 全绿                   |
| T-05     | `session-loop/loop/mod.rs`、`provider.rs` + 契约登记文档        | SessionLoopOptions.system_prompt、ProviderRequest.system_prompt（全 Option 扩展）+ `default_options` 断言 + C5 登记发起                            | session-loop 编译通过（域内零错误）   |
| T-06     | `apps/agent-workbench/src-tauri/src/engine.rs`                  | build_context system_prompt 透传、request_options reasoning_content 接线、`reasoning_content_mode()`（C1：Deepseek→Require/其余 Omit）+ 2 集成测试 | crish-agent-workbench 172 通过        |
| T-07     | `apps/agent-workbench/src-tauri/src/core_run_commands.rs`       | core_run_task 签名加 system_prompt + 入站 build_system_prompt 规范化 + 去 BOM                                                                      | 编译阻塞已于 T-03 落地后解除          |
| T-08     | `ConnectionLifecycle.ts` + 测试                                 | `composeSystemPrompt` 纯函数、responseStyleGuidance 改名、删除三形态分支 + 6 条新单测                                                              | chat-bridge 93 用例通过、typecheck 绿 |
| T-09     | `request/messages.rs`                                           | `sanitize_tool_call_id`、arguments 规范化、Require 空串兜底落地 + 6 新测试                                                                         | agent-provider 347 通过               |

提交记录：`226fe69c`（波 1）、`0cb335b9`（波 2）、`c2465321`（波 3）。

## 二、门禁执行结果

- `cargo test --workspace`：**74 套件全部通过，0 失败**（73 基线 + 新增 prefix_stability 套件；`prefix_stability.rs` 3 用例全绿）
- `npm run typecheck`：exit 0
- `npx vitest run src/api/chat-bridge`（apps/crish-desktop 内，scoped）：11 文件 93 用例通过
- 根目录全量 vitest 形态问题（R0 已记录）不影响本轮（scoped 无 mass failure）

## 三、发现的问题与主 Agent 裁决

| #     | 问题                                                                                     | 裁决/处置                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| R1-D1 | T-01 连带：`tools/mod.rs` 的 `register_builtin_tools_registers_all` 断言注册序（旧行为） | 主 Agent 裁决：T-01 语义变更的直接连带，扩展域修正断言为码点序（`diff_text` 开头），已验证全绿                                   |
| R1-D2 | `ProviderRequest.system_prompt` 新字段打断 4 处测试/bench 构造点（E0063）                | 主 Agent 扩展 A3 文件域补 `system_prompt: None,`（streaming_incremental_contract ×2 / run_loop / benches/request_build），已全绿 |
| R1-D3 | R0 表 2 遗漏项 D1（request/mod.rs 双写）                                                 | 按裁决执行：A2 独占 mod.rs；A4 的 `build_system_prompt` re-export 由主 Agent 波间合并，T-07 无缝接入                             |
| R1-D4 | R0 表 2 遗漏项 D2（loop/mod.rs 双写）                                                    | 简化执行：A5 先交付字段，A3 后直接写注释（波次天然串行，未走声明合并）                                                           |
| R1-D5 | vitest 根目录 mass failure（R0 已记录）                                                  | 本轮 scoped 门禁未受影响；R7 终验时按 R0 报告采用应用侧配置形态                                                                  |

## 四、契约登记（C5）

- 建立 `docs/cache-optimization/90-final/R1-contract-registration.md`（T-05 发起）：
  - 已登记：`ProviderRequest.system_prompt`、`SessionLoopOptions.system_prompt`、`core_run_task.system_prompt`、`SessionLoopOptions 装配行`
  - 占位：`ProviderRequest.session_id`（T-16 R2 补记）
- 遗留：PE-02 §3.1.1 契约正文载荷注释更新归 T-16 补记时一并执行（已在登记文档注明）

## 五、输出为下一轮输入（R2）

- T-10（events.rs usage 类型）与 T-13（request/cache.rs）零依赖，可直接开波
- T-16 补记 `ProviderRequest.session_id`（C5 合并登记 + PE-02 载荷注释更新）
- T-14 与 T-09 跨轮串行已满足（messages.rs，R1 先行）
- T-17 与 T-06 跨轮串行已满足（engine.rs，R1 先行）
- 契约登记文档路径：`docs/cache-optimization/90-final/R1-contract-registration.md`
