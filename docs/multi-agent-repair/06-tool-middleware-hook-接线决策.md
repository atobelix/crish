# 06 ToolMiddleware 接线与 Hook 运行时决策记录

> 审计发现处置（R6 多 Agent 修复轮）：
> 1. ToolMiddleware 半成品——生产 API 面零消费者（middleware.rs:51-91 定义 trait，
>    lib.rs:45-51 导出，但真正执行链 tool_exec.rs 的 execute_single 直接调用
>    execute_with_output_policy，中间件链只在 middleware.rs 自身测试模块存在）。
> 2. 14 个插件钩子全部死声明——hooks.ts:6-23 定义事件面，Rust 侧无分派运行时。

---

## 一、问题 1 决策：选 A —— 接线为真实扩展点

**决策：** ToolMiddleware 在 `session-loop` 的 `ToolExecutor::execute_single`
（tool_exec.rs）接入真实执行路径，作为生态扩展点保留并激活；不降级为
cfg(test)。

**理由：**
- middleware.rs 的 trait 设计（before_execute/on_result/on_error，Block/Replace/
  Passthrough 语义）与 TS 端 tool-middleware.ts 对齐，语义完整，仅缺接线；
- 降级 B 会永久锁死扩展点，生态轮（插件/审计/遥测）仍需重新开面；
- 接线成本可控：单点接入（execute_single 是顺序路径 execute_one 与并行组路径
  execute_single_with_retry 的汇聚点），空链零开销。

**接线点选择（为什么不在 agent-tools/executor.rs）：**
- 中间件与审批的优先级语义只能定义在审批之后的执行面（审批在 session-loop 层）；
- agent-tools 的 `execute_with_output_policy` 是通用单工具执行器，不引入审批
  概念——若把中间件链放其中，会造成职责混杂且波及全部既有调用方；
- 链持有在 `ToolExecutor`（`with_middleware`），与幂等守卫同级配置，批级
  复用，不污染 `ToolBatchOptions`（批级只放批语义）。

### 中间件与审批的优先级语义（正式定义）

**审批优先于中间件。** 完整顺序：

```
权限判定（PermissionVerdict）
  ├─ Deny        → 直接拒绝（中间件不参与）
  ├─ NeedsApproval → 审批流程（拒绝 / 过期 → 直接收场，中间件不参与）
  └─ Allow / 已批准
       → middleware before_execute 链（改输入 / Block 阻止）
       → tool.pre 事件广播（HookRegistry；Block = 阻止）
       → 工具执行（execute_with_output_policy：幂等 + 输出预算）
       → tool.post 事件广播（成功 / 失败）
       → middleware on_result 链（改写输出）｜ on_error 链（仅观察）
```

推论：
1. **中间件无法绕过审批**：Block 只拦截「审批已通过」的调用；审批拒绝时
   中间件 before_execute 根本不会被调用（已由测试锁定）。
2. **审批拒绝不会被中间件吞掉**：Deny/Denied/Expired 结果直接构造返回，
   不经中间件链。

### 中间件自身错误语义

| 钩子 | 失败行为 |
| --- | --- |
| before_execute 返回 Err | 视为阻止执行（与 Block 同语义，文案带中间件名）——守门者报错 = 不放行 |
| on_result 返回 Err | 记录日志并降级透传原输出——后置钩子错误不改变已完成的执行结果 |
| on_error 返回 Err | 记录日志（仅观察，不吞原错误） |

---

## 二、问题 2 决策：Hook 运行时骨架（并入 session-loop）

**决策：** 新建 `crates/session-loop/src/hooks.rs` 承载 hook 注册/分派运行时，
不新建 crate。理由：
- turn.end 接线点在 turn_complete handler、tool.pre/tool.post 接线点在
  ToolExecutor（均属 session-loop 域内）；
- 新建 crate 需动根 Cargo.toml workspace（包级文件），骨架期收益不成比例；
- 生态轮若需独立插件运行时 crate，可从 hooks.rs 提取（模块头注已标注演进方向）。

### HookEvent 事件面（第一批）

对齐 `packages/shared-types/src/hooks.ts` 事件名与 payload：

| Rust 变体 | 事件名 | payload 对齐 | 接线点 |
| --- | --- | --- | --- |
| `HookEvent::TurnEnd` | turn.end | TurnEndPayload（sessionId/turnIndex/outcome） | turn_complete.rs 步骤 4.5 |
| `HookEvent::ToolPre` | tool.pre | ToolPrePayload（sessionId/toolName/input） | execute_single（middleware before 链后） |
| `HookEvent::ToolPost` | tool.post | ToolPostPayload（output/durationMs/isError） | execute_single（on_result/on_error 链邻接） |

### 失败策略（对齐 plugin-sdk `HookFailStrategy`）

TS 端 `'swallow' | 'log' | 'propagate'`，Rust 侧同名枚举三值一一对应。
**propagate 不中断会话**（与"插件错误不应杀死 run"的产品原则对齐）：
- tool.pre 的 propagate 失败 → 该工具调用降级为执行失败结果（批继续）；
- turn.end 的 propagate 失败 → 记录日志后收场流程继续。

### RecoveryHook 不并入事件分派（接线决策）

`RecoveryHook::decide(&CrishError, state)` 是 **F6 冻结签名**（AU-04）的同步
裁决 API（返回 Retry/Skip/Abort 决策），与 HookEvent 的"观察事件"语义不同。
本轮保持原接口不动；后续生态轮可新增 `HookEvent::Recovery` 观察变体（如
对齐 hooks.ts 的 model.afterResponse）。

### tool 事件与 ToolMiddleware 的合并关系

两者在 execute_single 共享同一点位但语义分工：
- **ToolMiddleware = 链式扩展面**：可改输入（Proceed modified_input）、可改写
  输出（Replace）、可阻止（Block）——程序化策略层（审批/审计/改写类中间件）；
- **HookRegistry = 广播观察面**：事件分发给注册的插件 handler，观察 +
  可选的 tool.pre 阻止——插件生态层；
- 顺序固定：middleware before 链 → tool.pre 广播 → 执行 → tool.post 广播 →
  middleware on_result/on_error 链。tool.post 广播的是中间件改写后的最终输出。

---

## 三、实施文件清单

| 文件 | 改动 |
| --- | --- |
| `crates/session-loop/src/hooks.rs` | 新增：HookEventKind/HookEvent/HookAction/HookError/HookFailStrategy/HookHandler/HookRegistry + 7 个单元测试 |
| `crates/session-loop/src/lib.rs` | 注册 hooks 模块并导出 |
| `crates/session-loop/src/tool_exec.rs` | ToolExecutor 加 middleware/hooks 字段；with_middleware/with_hooks；execute_single 接链（before → tool.pre → 执行 → tool.post → on_result/on_error）；9 个集成测试 |
| `crates/session-loop/src/loop/mod.rs` | SessionLoopOptions 加 tool_middleware/hooks；with_options 派生同步到执行器 |
| `crates/session-loop/src/loop/handlers/turn_complete.rs` | 步骤 4.5：turn.end 广播（Block = stop 建议） |
| `crates/agent-tools/src/middleware.rs` | 头注更新（不再"生产零引用"） |
| `crates/agent-tools/src/lib.rs` | 注释更新（middleware 有生产消费者） |
| `docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md` | 本文档 |

## 四、新增测试清单

**hooks.rs 单元测试（7）：**
1. dispatch_routes_to_matching_handlers_in_order —— 注册→触发→分派顺序
2. tool_pre_block_stops_dispatch —— tool.pre Block 阻止并携带原因
3. block_on_non_tool_pre_is_ignored —— 非 tool.pre 的 Block 按观察忽略
4. swallow_ignores_handler_error —— swallow 吞错继续分派
5. log_records_and_continues —— log 记录后继续分派
6. propagate_stops_and_raises —— propagate 停止分派并传播
7. dispatch_noop_without_matches / tool_post_payload_carries_output_and_flags

**tool_exec.rs 集成测试（9）：**
1. middleware_before_chain_modifies_input —— before 链改输入生效
2. middleware_before_block_prevents_execution —— Block 阻止且工具未执行
3. middleware_on_result_replace_output —— on_result 改写输出
4. middleware_on_error_observes_failure —— 失败观察
5. middleware_on_result_error_degrades_to_passthrough —— 后置错误降级透传
6. middleware_empty_chain_is_noop —— 空链行为不变
7. middleware_runs_after_approval_gate —— **审批优先语义**：拒绝时中间件不参与、通过后参与
8. hook_tool_pre_block_prevents_execution / hook_tool_pre_propagate_failure_blocks_tool —— tool.pre 阻止与 propagate 降级
9. hook_tool_post_receives_success_and_failure —— tool.post 成功/失败广播

## 五、遗留（下一轮 / 生态轮）

- **前端/插件 SDK 全链路接线**：本轮仅 Rust 侧运行时骨架 + 单元测试；hooks.ts
  的 HookRegistration（mode/timeoutMs/handlerType）字段语义未接入 Rust 侧
  （handler 当前为同步回调，生态轮转 async_trait）。
- **RecoveryHook 观察变体**（HookEvent::Recovery）与 session.start/end、
  model.beforeRequest/afterResponse、context.compact.* 等事件留待生态轮扩展。
- **中间件/hook 的 timeout 与 abort 感知**：before 链与广播当前在竞速外执行
  （快速内存操作），生态轮若引入慢 handler 需并入 abort 竞速窗口。
- **中间件链的并发安全语义**：并行组内每项独立走链（中间件实例跨项共享，
  需自持线程安全状态——trait 已要求 Send + Sync）。
