# 方案 04：全链路防御性测试与回归断言网

## 一、方案全景与设计哲学

### 1.1 现状断层与脆弱性根因剖析（基于一手源码审计）

通过对 `session-loop`、`conex-db`、`agent-provider` 以及 `orchestrator` 核心代码与既有测试网的深度研读，当前系统在会话完整性（Session Integrity）保障上存在三处致命架构断层：

1. **会话循环层：工具执行中断黑洞与空 ID 孤儿漏洞**
   - **前置截断黑洞**：在 `crates/session-loop/src/loop/handlers/executing_tools.rs:49-53`，函数入口直接执行 `if let Some(end) = check_control(state)? { return Ok(HandlerOutcome::end(end)); }`。当安全点或外部强停（L3 Abort）在进入工具执行前触发时，上一轮 streaming 产生并已写入 `state.conversation` 的 Assistant 消息中包含的 `ToolCall` 块被直接悬空，没有任何对应的 `ToolResult` 被生成并记入上下文，导致对话历史永久留下孤儿工具调用。
   - **空 ID 兜底伪造**：在 `crates/session-loop/src/exec_batch.rs:188-191`，批次执行结果解包兜底写为 `ClassifiedToolResult::error("", "", ToolErrorKind::Cancelled, "cancelled", 0)`。一旦某项工具因异常分支未填充结果，其 ID 与 tool_name 均被抹成空字符串 `""`。在转换为 `AgentMessageBlock::ToolResult` 时，其 `tool_call_id` 为空，根本无法与原 `tool_use` 配对。
   - **兄弟取消与组间判空疏漏**：在 `exec_batch.rs:252-264`，批次分组遍历中，仅在 `fatal.is_some()` 且为 `CancelSiblings` 时调用 `mark_rest_cancelled`；而在外部 `abort` 触发时，组与组之间并未及时短路剩余组，且未能保证被取消工具的 1-to-1 成对闭环。
   - **现有测试盲区**：`crates/session-loop/src/loop/invariants.rs` 仅覆盖了 I1–I6 缓存与压缩不变量，完全缺失针对“工具调用与结果成对性（Tool Call / Result Pairing）”的循环不变量检验；`crates/session-loop/src/loop/handlers/executing_tools_tests.rs:87-143` 甚至存在妥协性测试 `tool_result_message_id_derivation_documented`，将“相同 tool-call id 发生冲突”当作既成事实钉死，而非进行防重消歧与成对保证。

2. **协议序列化层：无守门直通 HTTP 400 漏洞**
   - **Anthropic Wire 盲序列化**：在 `crates/agent-provider/src/request/build_anthropic.rs:342-381`，`to_anthropic_messages` 在遍历 `context.messages` 时，盲目地将 Assistant 消息中的 `ToolCall` 投影为 `tool_use` 块，将 Tool 消息投影为 `tool_result` 块。如果前序执行被中断导致某 `tool_use` 没有对应的 `tool_result`，或者存在孤儿 `tool_result`，该方法直接原样放行，毫无拦截。请求发送至 Anthropic Messages API 后立即触发 HTTP 400 灾难性错误（`each tool_use block must be followed by a tool_result block in the next message`）。
   - **OpenAI / DeepSeek 轨缺失成对校验**：在 `crates/agent-provider/src/request/messages.rs:296-398` 中，`to_chat_messages_with_compat` 仅处理了 `WIRE_CONTINUATION_NOTE` 角色交替防 400，以及历史水合同体 ToolResult 的展开，却未在请求发出前对 `tool_calls` 与后续 `role: "tool"` 消息做成对校验。
   - **测试覆盖虚假繁荣**：`crates/agent-provider/src/request/build_anthropic_tests.rs` 仅测试了单一工具正常配对的快乐路径（lines 111-177），以及思考模式关闭、连续 Assistant 注入等边缘情况，完全没有编写针对“未成对工具调用传入时是否会被拦截/修补”的守门断言测试。

3. **存储与并发层：破坏性全量清空与伪 SSOT 隐患**
   - **全量清空 DELETE 恶习**：在 `crates/conex-db/src/messages.rs:112-119`，`save_session_body` 内部竟执行了 `conn.execute("DELETE FROM session_messages WHERE session_id = ?1", rusqlite::params![session_id])`。每次保存会话消息体，都是先全量物理清空该会话的全部既有消息，再全量逐条重新插入。同样的问题亦存在于 `crates/conex-db/src/import.rs:91` 与 `crates/conex-db/src/agents.rs:200`。若系统在 DELETE 之后、写入完成前发生崩溃或断电，会话数据即遭毁灭性丢失。
   - **Events 未成真正 SSOT**：`crates/conex-db/src/schema.rs:17` 定义了 `events` 表（以 `(session_id, sequence)` 为主键，天然单调追加），本应是系统的单一真理源（SSOT）。但因为 `session_messages` 可以被任意整表全量重写，当 `session_messages` 与 `events` 发生状态漂移或冲突时，缺乏一套刚性的、以 `events` 为权威单向强制收敛的恢复与断言机制。
   - **测试妥协**：`crates/conex-db/src/tests.rs:219-244`（`save_session_body_cas_conflict_rejects_stale_batch`）默认将基于全量清空的重写视作合法逻辑，未设立阻止破坏性清空的负向断言。

### 1.2 三维防御性断言网设计原则

针对上述架构断裂，本方案构建全链路防御性测试与回归断言网，遵循以下最高设计准则：

- **逻辑全权同权**：取消一切人为工期与 P0/P1 等级划分，所有断言模块、防护网与收敛步骤在系统架构中具有相同权重，缺一不可。
- **杜绝脱水 Mock，依托真实内核**：严禁编写仅脱离宿主环境测试局部纯函数算法的虚假用例；所有新增测试必须运行在真实的 Tokio 异步运行时、真实的 `AgentSessionStateMachine` 状态转移、真实的 `LocalDb`（SQLite WAL 内存与临时文件引擎）以及真实的请求体构建链路中。
- **正负双向刚性门禁**：不仅测试在各种极端并发打断下“100% 能够产出合规数据”（正向断言），更要构造“绝对不允许执行破坏性操作”、“绝对不允许未成对协议报文流向网络”的刚性阻断（负向断言）。

---

## 二、维度 1：孤儿工具打断立体测试网设计

### 2.1 并发工具批次执行的中断场景拓扑分析

为彻底根治孤儿工具调用，必须将工具执行生命周期中所有可能导致中断的物理时间点穷举化，并在会话循环层建立闭环防御。拓扑分解如下：

```
[Assistant 输出包含 ToolCalls]
             │
             ▼
    ┌─────────────────┐
    │ 阶段 0: 前置检查 │ ──(Abort/Stop 触发)──► [场景 A: 前置取消拦截] ──► 补齐所有工具 Cancelled 结果
    └────────┬────────┘
             │ 放行
             ▼
    ┌─────────────────┐
    │ 阶段 1: 审批处理 │ ──(Abort/Timeout)──► [场景 B: 审批期取消/超时] ──► 补齐未决工具 Expired/Cancelled 结果
    └────────┬────────┘
             │ 批准
             ▼
    ┌─────────────────┐
    │ 阶段 2: 并发执行 │ ──(信号触发/崩溃)──► [场景 C: 运行中并发打断] ──► 正在运行者中断，未运行者取消
    │                 │ ──(单项耗时超限)──► [场景 D: 单项执行超时]   ──► 标记 TimedOut，其余按策略处理
    │                 │ ──(致命错误发生)──► [场景 E: 兄弟失败级联]   ──► 剩余未执行兄弟标记 SiblingFailure
    └────────┬────────┘
             │
             ▼
[保证 100% 对应数量的 ToolResult 写入 Conversation 与持久化]
```

#### 场景 A：前置取消（Pre-flight Abort）
- **触发时机**：在 `executing_tools::handle` 入口处的 `check_control(state)`（第 49 行）。
- **防御机制**：严禁直接 `return Ok(HandlerOutcome::end(end))`。若存在包含工具调用的最新 Assistant 消息，必须首先遍历其所有的 `tool_calls`，就地构造对应的 `ToolResult`（错误码 `tool.cancelled`，消息 `cancelled: aborted before execution`），将其注入 `state.conversation`，随后才允许终止退出。

#### 场景 B：审批等待期取消与超时（Approval-Wait Abort & Timeout）
- **触发时机**：在 `BatchRunner::collect_approvals`（`exec_batch.rs:368-403`）逐项等待用户审批期间，外部 `AbortSignal` 触发，或审批超过设定的 `approval_timeout`。
- **防御机制**：已批准项不启动执行；当前等待项与后续所有待审批项全部标记为 `ToolErrorKind::ApprovalExpired`（超时）或 `ToolErrorKind::Cancelled`（中止）；必须严格保留原始 `call.id` 与 `call.tool_name`。

#### 场景 C：并行组并发执行中打断（Mid-flight Execution Abort）
- **触发时机**：在 `BatchRunner::execute_group`（`exec_batch.rs:514-526`）通过 `futures::future::join_all` 并发执行工具时，某个长耗时工具正在异步等待，外部下发中断信号。
- **防御机制**：信号量 permit 安全释放，未完成的 Future 及时退出，已完成的保留其真实结果，未完成/被中断的工具统一产出 `ToolErrorKind::Cancelled`（原因 `aborted`），严禁抛弃任何一项。

#### 场景 D：单项工具执行超时（Tool Execution Timeout）
- **触发时机**：单项工具执行超过 `ToolBatchOptions::tool_timeout` 限制。
- **防御机制**：被超时的工具产出 `ToolErrorKind::TimedOut`，其耗时记录为设定的超时阈值，`is_error = true`，结果结构规范完整。

#### 场景 E：兄弟失败级联取消（Sibling Failure Cancellation）
- **触发时机**：某工具执行产生致命错误且 `fail_strategy == FailStrategy::CancelSiblings`。
- **防御机制**：调用 `mark_rest_cancelled`，遍历未执行的兄弟工具，严格补全 `ToolStart`、`ToolEnd` 事件以及包含正确 `call.id` 的 `ClassifiedToolResult`。

### 2.2 成对性立体断言网与合成结果规范

建立两大系统级循环不变量（纳入 `crates/session-loop/src/loop/invariants.rs`）：

#### 不变量 I7：工具调用与结果双向闭包不变量（Tool Call / Result Dual-Inclusion Invariant）
在任何轮次结束（Turn End）、执行收敛（Outcome）、或者中断退出（Abort）时刻，`state.conversation` 必须满足：
$$\forall c \in \text{Conversation}, \forall \text{call} \in \text{ToolCalls}(c), \exists! r \in \text{ToolResults}(\text{Conversation}): r.\text{tool\_call\_id} == \text{call.id}$$
反向亦然：
$$\forall r \in \text{ToolResults}(\text{Conversation}), \exists c \in \text{ToolCalls}(\text{Conversation}): c.\text{id} == r.\text{tool\_call\_id}$$
任何时刻出现未闭环的 `ToolCall` 或无源的 `ToolResult`，状态机立即判定为状态损坏（State Invariant Broken）。

#### 不变量 I8：合成取消结果规范不变量（Synthetic Result Normalization Invariant）
严禁任何使用空字符串 `""` 占位的兜底行为。任何在取消、打断、异常收敛路径合成的 `ClassifiedToolResult`，必须满足：
1. `result.id == call.id`（完全匹配）；
2. `result.tool_name == call.tool_name`（完全匹配）；
3. `result.is_error == true`；
4. `result.error_kind` 必须是强类型的 `ToolErrorKind::Cancelled`、`ToolErrorKind::TimedOut`、`ToolErrorKind::ApprovalExpired` 或 `ToolErrorKind::UserDenied`；
5. `result.duration_ms` 必须准确反映真实消耗时间（未执行为 0，超时为超时时限）；
6. 派生的 `AgentMessage` ID 必须为 `format!("tool-result-{}", call.id)`。

### 2.3 真实执行链测试套件设计（落地代码蓝图）

在 `crates/session-loop/src/loop/handlers/executing_tools_tests.rs` 与 `crates/session-loop/src/loop/invariants.rs` 中新增立体测试：

```rust
// 验证场景 A：前置中断时，已有的 tool_calls 必须 100% 产出 Cancelled ToolResult，杜绝孤儿调用
#[tokio::test]
async fn test_orphan_prevention_on_preflight_abort() {
    let mut s = state_with_pending_tool_calls(vec![
        ("call_1", "read_file", json!({"path": "/tmp/1"})),
        ("call_2", "shell_command", json!({"command": "ls"})),
    ]);
    // 在 handle 执行前预先置位 abort 信号
    s.abort_signal.abort();

    let outcome = handle(&mut s, &test_executor(), &test_ctx(), &default_batch_opts(), None)
        .await
        .expect("handle 执行正常收敛");

    assert!(outcome.is_end(), "前置 abort 必须收敛为结束状态");
    
    // 断言 conversation 中必须已补全两条 tool-result 消息
    let tool_results: Vec<_> = s.conversation.iter()
        .filter(|m| m.role == AgentMessageRole::Tool)
        .collect();
    assert_eq!(tool_results.len(), 2, "必须为每个未执行工具补全结果");
    assert_eq!(tool_results[0].id, "tool-result-call_1");
    assert_eq!(tool_results[1].id, "tool-result-call_2");
    
    // 验证不变量 I7 完全满足
    assert_conversation_tool_pairing_invariants(&s.conversation);
}

// 验证场景 C：真实 4 并发工具在执行中途触发 Abort，断言正在执行者与未完成者全部成对闭环
#[tokio::test]
async fn test_midflight_concurrency_abort_pairing_closure() {
    let calls = vec![
        make_slow_tool_call("call_fast_1", 10),
        make_slow_tool_call("call_slow_2", 2000),
        make_slow_tool_call("call_slow_3", 2000),
        make_slow_tool_call("call_slow_4", 2000),
    ];
    let abort_signal = AbortSignal::new();
    let abort_clone = abort_signal.clone();

    // 延迟 50ms 触发中止，此时 call_fast_1 已完成，其余 3 个正在执行
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        abort_clone.abort();
    });

    let outcome = executor.execute_batch(&calls, &ctx, None, &opts, Some(&abort_signal)).await;
    
    assert_eq!(outcome.results.len(), 4, "批次结果数量必须严格等于调用数量");
    for (idx, res) in outcome.results.iter().enumerate() {
        assert_eq!(res.id, calls[idx].id, "每个结果的 call_id 必须与原调用完全一致");
        assert_eq!(res.tool_name, calls[idx].tool_name);
    }
    assert!(outcome.results[0].is_ok(), "fast 工具应当正常执行成功");
    assert_eq!(outcome.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(outcome.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(outcome.results[3].error_kind, Some(ToolErrorKind::Cancelled));
}
```

---

## 三、维度 2：严苛 Mock LLM 序列化守门断言网设计

### 3.1 上游 Provider 构造层守门断言契约

在将上下文消息转换并序列化为具体的下游大模型报文时，Provider 构造层必须充当一道刚性的“协议防火墙”。任何内部状态机的逻辑缺陷、并发竞态残留或外部历史污染，一旦导致上下文包含畸形工具序列，**绝对不允许穿透到网络层**。

#### Anthropic Messages API 构造守门铁律：
1. **Tool Use 成对闭环约束**：对于 `to_anthropic_messages` 序列化结果中的任何一个 Assistant 角色块 `{"type": "tool_use", "id": X}`，其下一个紧随的 User 角色块中必须包含 `{"type": "tool_result", "tool_use_id": X}`。
2. **禁止连续 Assistant 块**：由 `WIRE_CONTINUATION_NOTE` 兜底（既有约束保持）。
3. **禁止孤儿 Tool Result**：任何 `tool_result` 的 `tool_use_id` 必须在此前已出现的某条 Assistant 消息的 `tool_use` 中注册过。
4. **禁止空 ID / 格式非法 ID**：`tool_use.id` 与 `tool_result.tool_use_id` 必须满足 Anthropic 字符集要求（`^[a-zA-Z0-9_-]+$` 且长度不超过 64）。

#### OpenAI / Chat 兼容轨构造守门铁律：
1. **Tool Call ID 严格回应约束**：若 `role: "assistant"` 的 `tool_calls` 包含 `id: "call_abc"`，则后续的连续 `role: "tool"` 消息集必须精确覆盖所有被声明的 `call_id`。
2. **禁止在未回应工具调用前插入新的 User 消息或产生连续 Assistant 消息**。

### 3.2 请求体预检阻断断言（Wire Serialization Preflight Gatekeeper）

在 `crates/agent-provider/src/request/build_anthropic.rs` 与 `crates/agent-provider/src/request/messages.rs` 中引入守门校验器 `assert_wire_messages_integrity`：

```rust
/// 协议导线级报文完整性守门器（在 debug_assertions / 测试中硬性 panic 拦截；在 release 中执行自愈修补）
pub fn assert_wire_messages_integrity(messages: &[Value], dialect: ProviderDialect) {
    let mut pending_tool_calls: std::collections::HashSet<String> = std::collections::HashSet::new();
    
    for (idx, msg) in messages.iter().enumerate() {
        let role = msg["role"].as_str().unwrap_or_default();
        match role {
            "assistant" => {
                // 如果上一轮还有未闭环的 tool_calls，立刻断言失败！
                if !pending_tool_calls.is_empty() {
                    panic!(
                        "FATAL [WireGatekeeper]: 连续出现 Assistant 消息，但前序工具调用未闭环！未闭环 ID: {:?}, 索引: {}",
                        pending_tool_calls, idx
                    );
                }
                // 登记本轮 tool_calls / tool_use
                if let Some(content_blocks) = msg["content"].as_array() {
                    for block in content_blocks {
                        if block["type"] == "tool_use" {
                            let id = block["id"].as_str().expect("tool_use 必须有 id");
                            pending_tool_calls.insert(id.to_string());
                        }
                    }
                }
            }
            "user" => {
                // 消费 tool_results
                if let Some(content_blocks) = msg["content"].as_array() {
                    for block in content_blocks {
                        if block["type"] == "tool_result" {
                            let id = block["tool_use_id"].as_str().expect("tool_result 必须有 tool_use_id");
                            if !pending_tool_calls.remove(id) {
                                panic!("FATAL [WireGatekeeper]: 出现孤儿 tool_result！tool_use_id: {}, 索引: {}", id, idx);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    
    // 序列末尾若仍有未闭环的 tool_calls，立即拦截！
    if !pending_tool_calls.is_empty() {
        panic!(
            "FATAL [WireGatekeeper]: 请求报文末尾存在未响应的孤儿工具调用，绝对不允许发往真实环境！未闭环 ID: {:?}",
            pending_tool_calls
        );
    }
}
```

### 3.3 严苛 Mock 校验与真实执行链断言设计

在 `crates/agent-provider/src/request/build_anthropic_tests.rs` 中编写真实构造链断言：

```rust
// 变态测试 1：Assistant 发出 3 个工具调用，但上下文仅包含 2 个结果，断言守门器阻断
#[test]
#[should_panic(expected = "请求报文末尾存在未响应的孤儿工具调用")]
fn gatekeeper_rejects_partial_tool_results_in_anthropic_wire() {
    let assistant_msg = Arc::new(AgentMessage {
        id: "a1".into(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![
            AgentMessageBlock::ToolCall(ToolCallBlock { id: "call_1".into(), tool_name: "tool_a".into(), input: json!({}) }),
            AgentMessageBlock::ToolCall(ToolCallBlock { id: "call_2".into(), tool_name: "tool_b".into(), input: json!({}) }),
            AgentMessageBlock::ToolCall(ToolCallBlock { id: "call_3".into(), tool_name: "tool_c".into(), input: json!({}) }),
        ],
        metadata: None, client_message_id: None, content: None,
    });
    let partial_results = Arc::new(AgentMessage {
        id: "t1".into(),
        role: AgentMessageRole::Tool,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![
            AgentMessageBlock::ToolResult { tool_call_id: "call_1".into(), tool_name: "tool_a".into(), output: ToolOutput::text("ok"), is_error: false },
            AgentMessageBlock::ToolResult { tool_call_id: "call_2".into(), tool_name: "tool_b".into(), output: ToolOutput::text("ok"), is_error: false },
            // call_3 遗失！
        ],
        metadata: None, client_message_id: None, content: None,
    });

    let msgs: &'static [Arc<AgentMessage>] = Box::leak(vec![assistant_msg, partial_results].into_boxed_slice());
    let opts = AnthropicRequestOptions::default();
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: vec![],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };

    // 此处调用必须被守门器拦截并 panic，绝不允许流向请求构建完成状态
    build_anthropic_request_body(&opts, &context);
}

// 变态测试 2：工具执行中途被中断后直接发起新轮次 User 提问，断言守门器拦截孤儿调用
#[test]
#[should_panic(expected = "前序工具调用未闭环")]
fn gatekeeper_rejects_orphan_tool_call_followed_by_new_user_turn() {
    let assistant_tool = Arc::new(AgentMessage {
        id: "a1".into(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::ToolCall(ToolCallBlock { id: "call_x".into(), tool_name: "t".into(), input: json!({}) })],
        metadata: None, client_message_id: None, content: None,
    });
    let new_user = Arc::new(AgentMessage {
        id: "u2".into(),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:01Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: "算了，我不查了，直接回答我吧".into() }],
        metadata: None, client_message_id: None, content: None,
    });

    let msgs: &'static [Arc<AgentMessage>] = Box::leak(vec![assistant_tool, new_user].into_boxed_slice());
    let context = RequestBuildContext {
        system_prompt: None,
        messages: msgs,
        tools: vec![],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    build_anthropic_request_body(&AnthropicRequestOptions::default(), &context);
}
```

---

## 四、维度 3：持久化 SSOT 与崩溃一致性测试网设计

### 4.1 数据库全量清空（DELETE）彻底绝迹的负向断言设计

#### 架构收敛策略
彻底取缔 `DELETE FROM session_messages WHERE session_id = ?1`。
- **持久化写入原则**：采用版本受控的增量写入（Incremental Append-Only）与非破坏性 UPSERT（`INSERT INTO session_messages (...) VALUES (...) ON CONFLICT(session_id, seq) DO UPDATE SET ...`）。
- **静态代码防线**：在 CI 与编译检查中，使用 `ripgrep` / AST 门禁对 `crates/conex-db` 全目录执行扫描，严禁出现针对消息主表或事件主表的 `DELETE FROM session_messages` 语句。
- **运行时动态拦截守门断言**：在测试执行中，使用包装型 SQLite Driver 或自定义 Tracer 挂载每一个执行的 SQL 语句。如果检测到包含 `DELETE FROM session_messages`，测试直接失败。

#### 负向断言测试实现（`crates/conex-db/src/tests.rs`）

```rust
/// 负向断言：全量会话保存与版本演进中，绝对不允许执行破坏性 DELETE FROM session_messages 语句
#[test]
fn negative_assertion_no_delete_executed_on_session_messages_save() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    
    // 注入 SQL 审计钩子，记录写入过程中执行的所有 SQL
    let sql_log = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sql_log_clone = Arc::clone(&sql_log);
    
    db.set_sql_tracer(Box::new(move |sql| {
        sql_log_clone.lock().unwrap().push(sql.to_uppercase());
    }));

    // 执行初次保存
    let msg1 = sample_message("m1", "user", 100);
    db.save_session_body_versioned("s1", &[msg1.clone()], Some(1)).unwrap();

    // 执行版本演进保存（追加一条助手消息）
    let msg2 = sample_message("m2", "assistant", 200);
    db.save_session_body_versioned("s1", &[msg1, msg2], Some(2)).unwrap();

    // 严苛断言：所有执行的 SQL 中，绝对不能存在针对 session_messages 的 DELETE 语句
    let logs = sql_log.lock().unwrap();
    for stmt in logs.iter() {
        assert!(
            !(stmt.contains("DELETE") && stmt.contains("SESSION_MESSAGES")),
            "VIOLATION: 检测到针对 session_messages 表的破坏性 DELETE 语句！SQL: {}",
            stmt
        );
    }
}
```

### 4.2 多源数据冲突下 Events 单向强制收敛恢复测试

#### SSOT 权威收敛法则
系统遵循唯一的真理流动拓扑：
$$\text{Append-Only Events (SSOT)} \xrightarrow{\quad\text{Deterministic Replay}\quad} \text{Session Messages (Projection View)}$$
当发生异常（进程崩溃、快照损坏、并发覆盖导致版本错乱）时，任何投影视图中的数据与 `events` 冲突，一律以 `events` 为权威单向覆盖。

#### 冲突收敛测试矩阵（`crates/orchestrator/src/recovery_tests.rs`）

```rust
/// 多源冲突恢复测试：当 session_messages 物化视图损坏、缺失或内容与 events 表冲突时，
/// 恢复流程必须单向强制从 events 表重新投影收敛，实现无损恢复
#[tokio::test]
async fn test_unidirectional_events_ssot_recovery_convergence() {
    let db = LocalDb::open_in_memory().unwrap();
    let session_id = "sess-conflict-1";
    db.insert_session(session_id, "SSOT Conflict Test").unwrap();

    // 1. 在 events 表中写入真实的权威事件流（1 条用户消息 + 1 条带工具调用的助手消息 + 1 条工具返回）
    let events_authoritative = vec![
        (1, "user-message", json!({"id": "m1", "role": "user", "text": "发起查询"})),
        (2, "assistant-message", json!({"id": "m2", "role": "assistant", "tool_calls": [{"id": "call_99", "name": "query"}]})),
        (3, "tool-result", json!({"id": "tool-result-call_99", "tool_call_id": "call_99", "output": "数据正常"})),
    ];
    for (seq, event_type, payload) in &events_authoritative {
        db.append_event(session_id, *seq, event_type, &payload.to_string(), Some("run-orig")).unwrap();
    }

    // 2. 故意在 session_messages 表中写入相冲突的脏数据（甚至被恶意删减至只有 1 条，且文本被篡改）
    let corrupted_messages = vec![
        SessionMessage {
            id: "m1".into(),
            sender: "user".into(),
            text: Some("被污染的篡改内容".into()),
            thinking: None,
            timestamp: 50,
            status: Some("completed".into()),
            stream_text_offset: None,
            thinking_time: None,
            tool_calls_json: None,
            blocks_json: None,
            tool_call_results_json: None,
            usage: None,
        }
    ];
    // 强制写入脏视图
    db.raw_force_write_messages(session_id, &corrupted_messages).unwrap();

    // 3. 执行会话水合恢复流程（Hydration / Recovery Coordinator）
    let recovered_messages = RecoveryCoordinator::hydrate_session_messages(&db, session_id)
        .await
        .expect("会话水合成功");

    // 4. 断言单向强制收敛生效：
    // - 脏视图被彻底清除或矫正
    // - 消息数量严格等于 events 投影出的 3 条
    // - 第一条用户消息文本必须来自 events，而非被污染的文本
    // - 工具调用与工具结果 100% 恢复闭合
    assert_eq!(recovered_messages.len(), 3);
    assert_eq!(recovered_messages[0].text.as_deref(), Some("发起查询"));
    assert_eq!(recovered_messages[1].id, "m2");
    assert_eq!(recovered_messages[2].id, "tool-result-call_99");
}
```

### 4.3 故障注入与崩溃一致性（Crash Consistency）压力矩阵

利用 SQLite WAL 模式特性与 Tokio 任务打断机制，对数据库进行硬故障注入测试：

1. **写入事务中途硬崩溃注入**：
   - 在 `GroupCommit` 单事务包裹多个操作时，使用故障注入代理在提交前随机触发连接关闭（模拟断电）。
   - 断言：SQLite 原生原子性保证未提交事务完全回滚；重新打开后，数据库 `PRAGMA integrity_check` 恒为 `ok`，无半写入状态。
2. **多并发 Worker 竞争恢复**：
   - 启动 16 个 Worker 随机并发调用 `append_event` 与 `save_session_body_versioned`，中途随机强杀半数 Worker 并立即拉起。
   - 断言：所有最终落盘的 events 满足单调递增连续性（`sequence` 严格自增无洞），版本冲突被 `DbFailureKind::CasConflict` 规范拦截，无任何死锁与连接池泄露。

---

## 五、专节：本方案要删掉什么 / 收敛什么

为保证代码库整洁与架构刚性，彻底消除“把缺陷当契约”的消极妥协测试，本方案明确界定必须废弃、删除与收敛的具体代码与测试清单：

| 目标文件 | 代码/测试位置 | 当前现状与缺陷分析 | 收敛与清理动作 |
|---|---|---|---|
| `crates/session-loop/src/exec_batch.rs` | Lines 188–191 | `r.unwrap_or_else(\|| ClassifiedToolResult::error("", "", ToolErrorKind::Cancelled, "cancelled", 0))` | **彻底删除**。严禁产出空 ID 占位符。改为从 `self.calls[idx]` 严格继承 `id` 与 `tool_name` 构造标准 Cancelled 结果。 |
| `crates/session-loop/src/loop/handlers/executing_tools_tests.rs` | Lines 87–143 | `tool_result_message_id_derivation_documented` 测试 | **彻底删除并重构**。原测试公开宣称“同 tool-call id 复用时产生冲突是已知形态并锁死”。将其替换为“基于出现序生成唯一消息 ID”的单调消歧断言测试。 |
| `crates/conex-db/src/messages.rs` | Lines 112–119 | `conn.execute("DELETE FROM session_messages WHERE session_id = ?1", ...)` | **彻底删除**。清空全表语句绝迹，改为基于 `(session_id, seq)` 的增量 UPSERT 语句。 |
| `crates/conex-db/src/import.rs` | Line 91 | `conn.execute("DELETE FROM session_messages WHERE session_id = ?1", ...)` | **彻底删除**。导入逻辑同样收敛为事务内有序覆盖写入，杜绝裸 DELETE。 |
| `crates/conex-db/src/tests.rs` | Lines 219–244 | `save_session_body_cas_conflict_rejects_stale_batch` | **重构测试**。剥离其底层依赖的 DELETE 验证，替换为验证增量版本保护与负向非 DELETE 断言。 |
| `crates/orchestrator/src/recovery_tests.rs` | Lines 467–471 | `serde_json::from_str::<ForkContextMode>("\"summarized\"")` | **彻底删除**。B6 战役早已废弃 `Summarized` 模式，清理此处的历史别名反序列化冗余测试。 |
| `crates/session-loop/src/loop/handlers/stream_error_tests.rs` | Lines 180–275 | 脱水测试 `retry_delay_ms_decision_table` | **收敛精简**。保留核心阶梯断言，移除纯数字溢出循环脱水验证，将测试预算迁移至驱动真实状态机推进的 `backoff_sequence_750_1500_3000_virtual_clock`。 |

---

## 六、实施拓扑与逻辑验证依赖网

本方案遵循纯逻辑依赖拓扑，各步骤同权推进，依赖关系如下：

```
[阶段 1: 引擎内核修复与 I7/I8 不变量]
  ├── 1.1 修复 exec_batch 空 ID 兜底，补全中断场景映射
  ├── 1.2 修复 executing_tools 前置 abort 补全工具结果
  └── 1.3 落地 loop/invariants.rs I7/I8 成对性自动化校验
             │
             ▼
[阶段 2: Provider 导线守门断言网]
  ├── 2.1 落地 build_anthropic 请求体成对性预检守门器
  ├── 2.2 落地 to_chat_messages_with_compat 请求体验证器
  └── 2.3 编写 build_anthropic_tests 变态级畸变拦截测试
             │
             ▼
[阶段 3: 存储 SSOT 与崩溃一致性网]
  ├── 3.1 改造 save_session_body 为非破坏性增量 UPSERT
  ├── 3.2 落地 DELETE FROM session_messages 运行时负向断言
  └── 3.3 编写 events 单向强制收敛恢复与崩溃注入测试
             │
             ▼
[阶段 4: 坏测试与陈旧 Mock 清退]
  ├── 4.1 删除 executing_tools_tests 中的冲突锁死测试
  ├── 4.2 清理 recovery_tests 中的废弃别名测试
  └── 4.3 全量回归与覆盖率立体闭环验证
```

### 6.1 单元 1：循环层中断成对性闭环
- **逻辑依赖**：无前置依赖，首行启动。
- **验收断言**：在任意时刻（前置、等待中、并发运行中）打断包含多工具调用的轮次，产生的 `state.conversation` 均通过 I7/I8 不变量校验，0 孤儿工具调用。

### 6.2 单元 2：Provider Wire 守门器注入
- **逻辑依赖**：单元 1 确立成对格式规范。
- **验收断言**：向 Provider 传入故意构造的缺少 tool_result 或包含非法孤儿调用的消息集，构造器必定触发结构化断言阻断，拦截率 100%，杜绝真实环境 HTTP 400。

### 6.3 单元 3：数据库增量化与 Events SSOT 收敛
- **逻辑依赖**：无前置依赖，与单元 1 并行推进。
- **验收断言**：负向测试中针对 `session_messages` 的 DELETE 触发次数恒为 0；在人为制造视图与事件冲突的场景下，水合程序 100% 按照 `events` 恢复消息历史。

### 6.4 单元 4：清理收尾与立体回归
- **逻辑依赖**：依赖单元 1、2、3 全部就绪。
- **验收断言**：执行专节中列出的全部删除动作；运行全量测试套件 `cargo test --workspace`，所有用例全绿，代码库中不再保留任何掩盖缺陷的妥协性测试。
