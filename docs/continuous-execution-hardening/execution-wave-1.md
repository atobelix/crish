# 全天候自主 Agent 连续运行硬化战役：Wave 1 核心止血与权限打通执行记录 (已完成)

> **波次目标**：落地强类型权限偏序格、彻底消除三大调度点权限丢失断崖、物理删除 Legacy 全量审批兜底与毒丸清理、拔除 64 轮死刑截断与单 Run 压缩限制，建立零崩溃降级防线。  
> **工程铁律**：严禁打补丁，严禁硬编码；合理抽象，面向未来；坚决删除历史包袱，减少不必要的兼容；提交权仅归主 Agent。

---

## Wave 1 任务落地验收矩阵 (全量完成)

| 任务编号 | 任务主题 | 核心执行文件域 | 核心重构与除旧成果 | 验收状态 |
|:---:|:---|:---|:---|:---:|
| **W1-T1** | **权限核心类型与偏序格重构** | `crates/agent-tools/src/permission.rs` | 1. 确立 `PermissionMode` 强类型偏序格（`Plan < Ask < FullAccess`）；<br>2. 落地 `intersect` 单向交集最小特权计算，杜绝提权；<br>3. 确立 8 大 Redline 规则字典；升级 `PolicyBlocked` 结构化反馈替代 `UserDenied`。 | **已完成** |
| **W1-T2** | **执行器判定层重构与 Legacy 陷阱清除** | `crates/session-loop/src/exec_verdict.rs`<br>`crates/session-loop/src/tool_events.rs` | 1. 彻底物理删除导致所有命令及非命令工具全盘需审批的 Legacy 兜底；<br>2. 废除 `approval_enabled` 双源矛盾；<br>3. 放行 `.agent-outputs/` 受控写入白名单；<br>4. 消灭反常报错文案，纳入 `is_never_fatal` 保护。 | **已完成** |
| **W1-T3** | **会话级权限记忆持久化与毒丸清除根除** | `crates/conex-run/src/run/run_idle.rs` | 1. 消除 `permission_mode: None` 硬编码，读取会话当前记忆原样透传；<br>2. **物理删除 `clear_for_before` 毒丸清理代码**，确保异步事件 0 丢失；<br>3. 废除 `MaxTurns` 永不续跑的保守死刑逻辑。 | **已完成** |
| **W1-T4** | **子代理派发器与工作流权限透传** | `crates/conex-run/src/subagent_spawner/`<br>`crates/conex-run/src/workflow/launcher.rs` | 1. 消除子代理派发处 `permission_mode: None`，实现最小特权继承；<br>2. 定时工作流无人值守默认赋予 `full-access`，杜绝夜间审批卡死；<br>3. 补齐 `RunTaskOptions.max_turns` 支持。 | **已完成** |
| **W1-T5** | **启动装配层规范化与 64 轮解耦** | `crates/conex-run/src/run/run_launch.rs`<br>`crates/conex-run/src/run/mod.rs` | 1. 移除 `MAX_TURNS_DEFAULT = 64` 硬编码，全链路支持动态轮次与 `0 = 无限`；<br>2. 消除装配期二元拔除 ApprovalGate 缺陷；<br>3. 补齐主 Run `resolve_context_budget` 窗口兜底。 | **已完成** |
| **W1-T6** | **会话状态机轮次预算与 0 预算误杀解除** | `crates/conex-types/src/session.rs`<br>`crates/session-loop/src/loop/loop_exec.rs`<br>`crates/session-loop/src/loop/handlers/turn_complete.rs` | 1. 重写 `should_stop_for_max_turns` 支持 `0 = 无限预算`；<br>2. **物理删除启动点对 0 轮次的误杀抛错代码**；<br>3. 实现 `LeaseRenewalGuard` 租约评估与动态续订接口支持。 | **已完成** |
| **W1-T7** | **单 Run 压缩限制拔除与 Stub 降级零崩溃** | `crates/session-loop/src/loop/loop_options.rs`<br>`crates/session-loop/src/loop/handlers/stream_error_recover.rs`<br>`crates/session-loop/src/loop/compaction_dispatch.rs` | 1. 彻底拔除 `max_auto_compactions_per_run: 1` 限制，建立轮次与增量自适应防抖；<br>2. 默认启用 `compact_allow_stub_fallback: true`；<br>3. 废除 LLM 摘要失败直接 fatal 杀死全会话的死刑判决；<br>4. 修正 `length_ladder` 输入超限穿透压缩阶梯。 | **已完成** |

---

## 编译与代码健康度核验

- **编译断言**：`cargo check --workspace` 全量通过（Exit Code 0，dev profile target 完成）；
- **纯洁性断言**：彻底消除了双源矛盾、弱类型字符串浅比较、毒丸清除与 0 预算误杀；
- **Git 纪律**：改动完整保留在工作区未提交。
