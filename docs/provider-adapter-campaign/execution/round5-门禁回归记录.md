# Round 5 · 门禁回归记录（T5.3 · I6 全量门禁）

> 战役：`docs/provider-adapter-campaign/` · 定稿方案 §三 轮次 5 T5.3（I6）
> 角色：T5.3 全量门禁回归（验证为主，**不改码**）
> 窗口：2026-08-14（并行 in-flight 收敛窗口，含多次复跑）
> 纪律：只跑测试 + 写本唯一记录文档；部分失败为并行 in-flight 所致，按归属分类、标注「待复跑」，不代修。

---

## 一、执行环境与并行窗口说明

本轮执行期间仓库处于**多 Agent 并行改码**状态（T5.1 边缘解析器 / A6 目录 mode 补录 / T5.2a 壳层 profile / T5.2b 前端固化 同时在写）。回归采用「稳定窗口」策略：

- 首次 `cargo test --workspace` 在 **agent-provider `wire_integration` 失败**处中止——其根因为 **A6 目录 mode 补录（catalog.json `chat`→`anthropic`/`gemini`，未提交）先行落地、而配套 ground-truth 测试断言未同步** 的**并行 in-flight 中间态**。
- 等待并行收敛后复跑：`wire_integration.rs`（mtime 14:55:50）已由并行 Agent 同步更新为断言 `Anthropic`/`Gemini` 路由，并将 gemini 模型串从 `gemini-2.5-pro`（点号）改为 `gemini-2-5-pro`（横线，匹配 catalog 键）。复跑后 **agent-provider 全绿**。
- 全量 workspace 复跑期间，**T5.2a 壳层（crish-agent-workbench）出现跨 crate in-flight 编译断裂**（`DeviceErrorCode::AuthInvalid` 未定义），见 §四。

---

## 二、结果总表（各套件 绿 / 红 / 待复跑）

| 套件 / 门禁                             | 命令                                                                                   | 本次结果（真跑）                                   | 归属                     | 备注                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| agent-provider（lib+集成，含专项）      | `cargo test -p agent-provider`                                                         | ✅ **绿**                                          | 本战役域                 | 671 lib + 49 集成 = **720 passed; 0 failed**                                                       |
| agent-provider 专项 deepseek_invariants | 上述 lib 内                                                                            | ✅ **绿**                                          | 本战役域                 | 6 passed（矩阵注入/缓存键/工具调用 reasoning_content 等）                                          |
| agent-provider 专项 system_role         | `tests/system_role.rs`                                                                 | ✅ **绿**                                          | 本战役域                 | 2 passed                                                                                           |
| agent-provider 专项 parse_*             | `parse_{chat,gemini,responses,anthropic}.rs` + `parse_azure_responses.rs` + lib 内模块 | ✅ **绿**                                          | 本战役域                 | 含 **T5.1 新 azure-openai-responses 解析器** 10 lib + 3 集成 passed                                |
| agent-provider 专项 retry / classify    | `tests/retry.rs`（5）、`tests/classify.rs`（7）                                        | ✅ **绿**                                          | 本战役域                 | 均 passed                                                                                          |
| agent-provider 专项 catalog / vendor    | lib 内 `models::catalog` / `request::vendor` / `consistency_gate`                      | ✅ **绿**                                          | 本战役域                 | 全部 passed                                                                                        |
| session-loop                            | `cargo test -p session-loop`                                                           | ✅ **绿**                                          | 本战役域                 | **534 passed; 0 failed**（lib 452 + 集成 82），stress 用例 ignored                                 |
| 壳层 crish-agent-workbench（编译）      | `cargo check -p crish-agent-workbench`                                                 | 🟡 **待复跑**（曾绿）                              | 本战役域 T5.2a in-flight | 首轮 check **exit 0 干净**；后 T5.2a 引入 `AuthInvalid` 跨 crate 断裂（见 §四）                    |
| clippy agent-provider --lib             | `cargo clippy -p agent-provider --lib`                                                 | 🟡 **非零警告**（exit 0）                          | 既有基线                 | 2 条 `manual_map`（parse/gemini_core:259、responses_core:210）——**既存基线，非本轮引入**           |
| 前端 typecheck（全工作区 TS）           | `npm run typecheck`                                                                    | ✅ **绿**                                          | 本战役域                 | **exit 0 干净**（T5.2b 未阻塞类型）                                                                |
| 前端行数门禁 check:line-counts          | `npm run check:line-counts`                                                            | ❌ **红**（2 HARD BLOCK）                          | 并行/基线                | modelCatalog.ts(872) ← **T5.2b in-flight**；skillsApi.ts(676) ← **既有基线**                       |
| workspace 全量（含壳层）                | `cargo test --workspace`                                                               | 🟡 **待复跑**（壳层编译断裂中止，其余 crate 全绿） | 本战役域 T5.2a in-flight | 排除壳层 + skip flaky 后 `--exclude crish-agent-workbench` → **exit 0 全绿**；壳层收敛后按全量复跑 |

---

## 三、Rust 全量（cargo test --workspace）——按 crate 逐项

由于壳层编译断裂会使 `--workspace` 整体在 workbench 处中止，对**其余全部 crate** 用
`cargo test --workspace --exclude crish-agent-workbench` 单列验证（crish-agent-workbench 无任何 crate 依赖它，其余 crate 测试不受影响）。

> 注：本次回归期间 shell 断裂，`--exclude` 结果见 `execution/round5-门禁回归记录` 下文；若 shell 收敛后需回归时以**全量**为准复跑。

**已在本窗口真跑确认（含上表 agent-provider / session-loop）：**

| crate                            | lib + 集成 结果（本次窗口）                                    | 归属             |
| -------------------------------- | -------------------------------------------------------------- | ---------------- |
| agent-provider                   | 720 passed, 0 failed（含新 azure 解析器）                      | 本战役域         |
| session-loop                     | 534 passed, 0 failed                                           | 本战役域         |
| agent-tools                      | 724 passed, 0 failed（含 subagent 专用）                       | 并行/工具域      |
| conex-browser                    | 591 passed, **1 flaky 时序失败**（隔离复跑 1/1 绿）+ 1 ignored | 并行（另一战役） |
| 其余 conex-* / orchestrator / 等 | 见 §三续（`--skip` 复跑补齐）                                  | —                |

> **全部其余 crate 收敛确认**（`cargo test --workspace --exclude crish-agent-workbench -- --skip frames_fps_level_switching_ack_timing` **→ exit 0 全绿**）：orchestrator 226+51、session-loop 452+82、agent-provider 671+49、agent-tools 724、conex-browser 591（skip 1 flaky）、conex-browser-tools、conex-* 各 crate、doc-tests 全通过。
>
> **conex-browser 注**：`frames_fps_level_switching_ack_timing`（`src/frames/session.rs:1243`）为**时序敏感 flaky 测试**（断言 Burst 档持住 < Interactive 档；全量并行 suite 下 108~~123ms vs 97~~104ms 比例翻转），**隔离复跑 1/1 绿**→ 判定 flaky，非真实回归；归并行战役既有项。除该项外 conex-browser 其余 591 测试全绿。

**失败项分类（§四、§五）。**

---

## 四、失败项归属分类清单

### A. 本战役域 in-flight 失败（→ 上报主控，待并行收敛后复跑）

| 项  | 位置                                                                                                                                                                        | 分类                                                                                                            | 状态                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `crates/agent-provider/tests/wire_integration.rs::wire_routing_bundled_catalog_ground_truth`                                                                                | **并行 in-flight 中间态**（A6 目录 mode 补录已落地、test 断言未同步）→ 后已由并行 Agent 同步，**复跑 13/13 绿** | ✅ 已解决（等待窗口复跑绿）                                                               |
| 2   | 壳层 `apps/agent-workbench/src-tauri/src/server/auth.rs:718` 引用 `DeviceErrorCode::AuthInvalid`，但 `crates/conex-types/src/device/error.rs`（M，in-flight）**尚无该变体** | **跨 crate in-flight 编译断裂（T5.2a 壳层）**；两文件均为未提交工作区改动，为并行 Agent 中间态                  | 🟡 **待复跑**（T5.2a 收敛后复跑 `cargo check -p crish-agent-workbench` 与全量 workspace） |

### B. 既有基线失败 / 非本轮引入

| 项  | 位置                                                                                                                         | 分类                                                                                 | 说明                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 3   | clippy `cargo clippy -p agent-provider --lib` 2 条 `manual_map`（`parse/gemini_core.rs:259`、`parse/responses_core.rs:210`） | **既有基线警告**（非本轮文件域）；clippy exit 0（不阻断）                            | `responses_core.rs` 最近 touch 于 batch-1（cf1d3b20 前序轮），非 R5 新增；记录不代修 |
| 4   | `conex-browser` `frames::session::tests::frames_fps_level_switching_ack_timing`（全量 suite 下 108ms vs 97ms 时序断言）      | **flaky 时序敏感测试（并行战役 conex-browser）**；隔离复跑 1/1 绿、lib 其余 592 全绿 | 非本战役域；记录                                                                     |
| 5   | 前端行数 `apps/crish-desktop/src/api/skillsApi.ts`（676 有效行 > 650 硬阻断）                                                | **既有基线**（git 已提交、非本轮改动）                                               | 需走 `--update` 登记基线或拆分；记录                                                 |

### C. 本战役域并行任务在途（T5.2b 前端，尚未落盘完成）

| 项  | 位置                                                                             | 分类                                                                    | 说明                                                                 |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 6   | 前端行数 `apps/crish-desktop/src/api/modelCatalog.ts`（872 有效行 > 868 硬阻断） | **T5.2b in-flight**（未提交，+93 行改动把档位收敛逻辑塞入该文件致超限） | 🟡 **待 T5.2b 落盘后复跑 `npm run check:line-counts`**；记录，不代修 |

---

## 五、各专项套件核对（真跑绿）

| 专项                         | 结果        | 关键断言样例                                                                                                             |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `deepseek_invariants`        | ✅ 6 passed | matrix 不注入 cache_control、工具调用消息恒带 reasoning_content 键、请求体永不含 cache_control 键                        |
| `system_role`                | ✅ 2 passed | 显式 system role 被拒绝后 user-prefix 改写重试；消息内 system role 亦被改写                                              |
| `parse_*`（四轨 + 新 azure） | ✅ 全绿     | chat/gemini/responses/anthropic 流解析 e2e + usage 映射；**azure-openai-responses 解析器（T5.1）10 lib + 3 集成 passed** |
| `retry`                      | ✅ 5 passed | 预算耗尽停、auth 不重试、服务端 429 retry-after 退避成功                                                                 |
| `classify`                   | ✅ 7 passed | 401/403→auth、429→rate_limit、400 context→context_length、500→server、网络断连→network                                   |
| `catalog`                    | ✅ 全绿     | 目录按键命中/vendor 兜底/版本后缀/模型级 mode 互查                                                                       |
| `vendor`                     | ✅ 全绿     | 模型级 wire 改名、beta 头跳过、方言 qwen/zai/openrouter、deepseek off→disabled                                           |
| `consistency_gate`           | ✅ 全绿     | 白名单≡接受集、坏配置不藏、wire 一致                                                                                     |

---

## 六、前端门禁

| 门禁                | 命令                        | 结果                                                                                                                               |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| TS 类型（全工作区） | `npm run typecheck`         | ✅ **exit 0 全绿**（5 个 tsc 工程：crish-desktop app/node、agent-workbench、shared-types、shared-utils）。**T5.2b 未阻塞类型检查** |
| 行数门禁            | `npm run check:line-counts` | ❌ 2 HARD BLOCK（见 §四-C/§四-B-5）；Scanned 779 / Warnings 0 / Violations 0 / Hard blocks 2 / Baselined 61                        |

---

## 七、验收断言判定（对本轮窗口）

| 断言                                            | 判定 | 说明                                                                                    |
| ----------------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| 回归记录文档落盘                                | ✅   | 本文档（含各命令真实输出摘录）                                                          |
| 本战役域（agent-provider/session-loop）测试全绿 | ✅   | agent-provider 720 passed / session-loop 534 passed（稳定窗口内真跑）                   |
| 失败项全部归类                                  | ✅   | §四 三分类：本战役域 in-flight（→上报，待复跑）/ 并行跨越（标注等待）/ 既有基线（标注） |

---

## 八、未覆盖项 / 新发现契约问题（上报主控裁决）

1. **壳层 T5.2a 编译断裂（阻塞全量 workspace）**：
   `apps/agent-workbench/src-tauri/src/server/auth.rs:718` 引用 `DeviceErrorCode::AuthInvalid`，但 `crates/conex-types/src/device/error.rs` 尚无该变体（仅 `AuthBadSignature/AuthDeviceRevoked/AuthUnknownDevice/AuthUnknownDesktop/AuthExpired/AuthStale`）。
   → **契约问题**：T5.2a 若需新错误码，须同步在 `conex-types` 补枚举变体；当前两文件均为未提交 in-flight 态，属跨 crate 未收口。**报主控裁决归属，待 T5.2a 收敛后复跑 `cargo check -p crish-agent-workbench` / `cargo test --workspace`。**
2. **前端 modelCatalog.ts 872 行超硬阻断**：为 T5.2b 所述「前端档位面板单源收敛」工作合并所致。若该文件确实充当 `modelCatalog` 契约载体，建议 T5.2b 拆分或 `--update` 登记基线（UI<500/业务<400/类型<800 口径），按 §11-CI 治理执行，不赊阈。
3. **conex-browser flaky 时序测试**（`frames_fps_level_switching_ack_timing`）：并行战役域既有项，全量 suite 下偶发超 600ms/时序翻转边界。记录待并行战役归口（非本战役改码项）。

---

## 附：真实输出摘录（关键）

```text
# cargo test -p agent-provider（收敛窗口收敛后）
running 671 tests ... test result: ok. 671 passed; 0 failed; 0 ignored
# 集成二进制
abort 3 / classify 7 / divergence 3 / parse_anthropic 2 / parse_anthropic_e2e 2 /
parse_azure_responses 3 / parse_chat 2 / parse_gemini 2 / parse_gemini_e2e 2 /
parse_responses 2 / retry 5 / system_role 2 / ttfb_measure 1 / wire_integration 13
test result: ok. （全部 passed）
exit code: 0

# cargo test -p session-loop
lib 452 passed; integration budget_compaction4 divergence10 e01_multi_replace6 g02_collab_outputs4
  observability1 prefix_stability3 run_loop46 streaming_incremental_contract7 stress4(ignored) ttfb1
exit code: 0

# npm run typecheck -> exit code: 0（5 个 tsc 工程无报错）

# npm run check:line-counts -> exit code: 1
[check-line-counts] Scanned: 779 | Warnings: 0 | Violations: 0 | Hard blocks: 2 | Baselined: 61
❌ [HARD BLOCK] apps/crish-desktop/src/api/modelCatalog.ts (872 有效行 > 868)
❌ [HARD BLOCK] apps/crish-desktop/src/api/skillsApi.ts (676 有效行 > 650)

# cargo clippy -p agent-provider --lib -> exit 0，但 2 条既存 manual_map 警告（见 §四-B-3）

# cargo check -p crish-agent-workbench -> 首轮 exit 0 干净；后因 T5.2a 跨 crate 断裂（§四-A-2）不得复跑
```

_产出：`docs/provider-adapter-campaign/execution/round5-门禁回归记录.md`（T5.3 唯一文档）_
