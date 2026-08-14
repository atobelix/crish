# 轮 2 汇总 —— D-01 事件归属与读取面建模（BATCH-agent-loop-trace）

> 战役：2026-08-14 agent-loop-trace-wave · 执行轮 2
> 上游：00-执行方案定稿.md 轮 2（8 单元 + 迁移审计位）

## 一、单元完成情况（8/8）

| 单元     | 内容                                                                                                                                         | 状态 | 验收证据                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| DM-01    | 迁移波 v9（run_id 列 + idx_events_run + sub_session_id 列 + 备份区间 5..=9 + LATEST_VERSION 8→9）                                            | ✅   | cargo test -p conex-db 全绿（migrations 17/17）；3 新锚点名可跑；runs.model 列未建（F-02）                               |
| DM-02+03 | append_event 签名连锁（5 参带 run_id）+ query_events_by_run（SQL 下推 idx_events_run）+ limit 下推 + created_at 毫秒 + PersistedEvent.run_id | ✅   | cargo test -p conex-db 全绿（74+4+2+17+16+5）；conex-types 全绿；orchestrator check 绿；9 新锚（5 conex-db + 4 persist） |
| DM-04    | EventQueue 构造期绑 run_id + normalize_envelope 真接线 + 三落库路径完整信封 JSON + goal 轮次域特判                                           | ✅   | 集成测试 6 文件全绿（drive/cancel/approval/normalize/crash_consistency/stress）；5 新锚（lib 单测被并行域阻塞未真跑）    |
| DM-05    | 直写路径规范化：run-interrupted 补 type+run_id；recovery-* 六点 3 typed + 3 镜像+type 降级                                                   | ✅   | cargo check 零新增错误；recovery 域测试锚 `recovery_event_payload_type_tagged` 落盘；reserve_sequence 零新增             |
| DM-06    | parse_envelopes 三态（corrupt 跳过计数 / typed sequence 回填 / D8 合成 fallback 透出）+ EnvelopeParseStats                                   | ✅   | 5 测试锚落盘（编译验证，真跑待并行域收口）                                                                               |
| DM-07    | read_run_events_impl 改 by_run + IPC 注册恢复三件套 + run_id 列优先 + limit 下推                                                             | ✅   | 前端 commandManifest.test.ts 12/12 绿；9 新测试锚（workbench 编译阻塞未真跑）；manifest 125/120 断言适配                 |
| DM-08    | G-29 终态矛盾对账（只上报不修正）+ 三分类归属契约注释（F-04 唯一执行）                                                                       | ✅   | crash_consistency 16/16 全绿；4 新锚含三分类契约锚                                                                       |

## 二、提交记录（主控，3 批）

| 提交     | 内容                                                                                 | 文件数           |
| -------- | ------------------------------------------------------------------------------------ | ---------------- |
| d46f42c1 | feat(conex-db): v9 迁移 + 签名连锁 + by_run + limit（DM-01/02）                      | 10（468+/28-）   |
| 8f06a389 | feat(orchestrator): EventQueue 绑定 + 信封落库 + 直写规范化 + 对账（DM-03/04/05/08） | 14（1230+/137-） |
| 89b85af2 | feat(workbench): 读侧三态 + 按 run 查询 + IPC 恢复 + 前端镜像（DM-06/07）            | 6（1065+/80-）   |

**遗留工作区**：`apps/agent-workbench/src-tauri/src/run/`（run_launch.rs / run_commands.rs）含 DM-04/07 的构造点与 by_run 改动——并行 SR-01 拆分域，待并行收口后随其提交或主控择机收口（内容已完整落盘，被吞并不影响）。

## 三、并行域阻塞记录（如实）

1. `orchestrator/src/restore.rs:181-185` include 的 5 个旁挂测试文件（restore_tests.rs 等）缺失（并行 G-21/SR-06d 中间态）→ orchestrator lib test profile 编译阻塞，影响 DM-04 的 5 个 lib 新锚与部分既有测试真跑。
2. `crates/agent-workbench` 整体编译被并行 SR-01/SR-02 拆分中间态阻塞（bg_* 模块、run/ import 收敛、ActiveRun 字段私有等 70 错误）→ workbench 测试无法真跑（DM-06/07 的 14 新锚均以 cargo check --tests 零错误 + 前端测试绿作为证据链）。
3. 上述阻塞均为并行 Agent 工作区，**未尝试修复**（禁越域）。

## 四、重要发现（影响后续轮次）

1. **S2 trace_id 信封字段已被并行 Agent 落地**（`AgentEventEnvelope.trace_id: Option<String>` 已存在于 events.rs:1129，Serialize/Deserialize 齐全）——轮 5 TR-01 由"新增字段"调整为"核查完整性 + 验证 run 启动装配面注入接线 + 落库面随完整信封自然入 payload"。
2. **core_run_commands.rs 被并行 SR-01 拆分**为 `run/` 目录 9 模——后续轮次涉及 workbench 的派单行号必须重新定位（锚点表已记录实测）。
3. **事件落库已是完整信封**（DM-04）：runId/sequence/schemaVersion 随 payload 落库，读侧可还原完整信封（G-01/G-05 结构性缺口关闭）。

## 五、轮 3 计划（D-02 关联键 + D-04 分类统一）

- 子波 A：LK-01（ToolContext 键源）、LK-03（审计发射点真值 + task 空串消解）、PC-01（timer/cron 伪 runId）、LK-06（观测定案登记）、PC-05（EventPolicy 单一分类——独占 conex-types/events.rs 契约面）
- 子波 B：LK-02（三 spawn 构造点，依赖 LK-01）、LK-04（子会话映射双轨——subagent_session_id 字段入契约窗口，依赖 PC-05 完成）、LK-07（死路径收口）
- 子波 C：LK-05（started/ended 广播，依赖 LK-04）、LK-08（契约测钉收口）
- 审计位：关联键接线审计（子波 C 并行）

_轮 2 汇总：2026-08-14 · 主控_
