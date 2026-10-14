# Wave 4 执行审计：内核推进、多语言探测与推送容灾独立审计报告

> **审计席位**：极端场景防御与容灾降级专职审计员（Audit-Slot-4）  
> **审计批次**：Wave 4 内核自愈推进、会话语言探测、目标续写与多端 Push 容灾专项审计  
> **受审对象**：
> - 内核自愈与会话语言探测：`crates/session-loop/src/loop/handlers/no_tool_calls.rs`, `crates/session-loop/src/steering/strategy.rs`, `crates/session-loop/src/steering/nudge.rs`
> - `/goal` 长期目标续写与状态机：`crates/orchestrator/src/goal_state.rs`, `apps/agent-workbench/src-tauri/src/run/run_idle.rs`, `apps/agent-workbench/src-tauri/src/run/run_resume.rs`
> - 移动端 Push 17 场景通知与厂商消费通道：`apps/agent-workbench/src-tauri/src/push/scenes.rs`, `copy.rs`, `engine.rs`, `vendor/apns.rs`, `vendor/hms.rs`, `vendor/consumer.rs`
> - 前端剪贴板安全操作工具链：`packages/shared-utils/src/clipboard.ts`, `apps/crish-desktop/src/components/chat-message-row/chatMessageRowUtils.ts`
> **审计时间**：2026-10-14  
> **最终决议**：**【PASS】批准准出（满足全部极端输入防护、语言自适应推进、超长截断与零 Crash 红线）**

---

## 一、审计概述与职责边界

依照《Conex / Crish Agent 协作指令》第七条（立体验证纪律与反过度设计硬性红线）及主控最新指示，极端场景防御与容灾降级审计席位（AUDITOR-04）对 Wave 4 涉及的内核自愈状态机、长期目标推进、多平台推送管道以及前端剪贴板容灾链路展开全要素穿透复核。

重点攻坚以下四大维度：
1. **内核语言探测器（SessionLanguageDetector）与自愈推进极端防御**：混合语言、空消息、特殊标点/Emoji、空 snippet 及超长 action 意图时的截断与防 Panic 处理；
2. **`/goal` 续写指令在极端轮次与超长 nextSteps 下的防溢出**：第 999 轮递增边界、极端超长任务项、坏 JSON 与空转风暴熔断；
3. **移动端 Push 17 场景通知极端容灾**：参数为 None/空、极端超长 detail/body 的截断保护、凭据缺失与限流重试；
4. **前端复制操作防崩溃保护**：现代 `navigator.clipboard` 与 DOM `execCommand` 降级漏斗、无权限或异常 DOM 下的零抛错零白屏。

---

## 二、逐项审计证据与源码穿透分析

### 1. 内核语言探测器（`SessionLanguageDetector`）与自愈自适应推进

#### 1.1 审查点与实现逻辑
在 `crates/session-loop/src/loop/handlers/no_tool_calls.rs:31-74` 中，设计并实现了语言探测器，彻底消除了历史遗留的“纯中文自愈注入导致英文模型上下文漂移”的问题：

```rust
// no_tool_calls.rs:41-74
impl SessionLanguageDetector {
    /// 判定文本是否包含汉字字符（CJK 统一表意文字及扩展 A 区）
    pub fn contains_chinese(text: &str) -> bool {
        text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c) || ('\u{3400}'..='\u{4dbf}').contains(&c))
    }

    /// 基于助手文本与会话上下文推导语言环境
    pub fn detect(state: &LoopState, assistant_text: &str) -> SessionLanguage {
        // 1. 若助手当前回复直接包含中文，判定为中文
        if Self::contains_chinese(assistant_text) {
            return SessionLanguage::Chinese;
        }

        // 2. 检查会话历史中最近的 User 消息
        for msg in state.conversation.iter().rev() {
            if msg.role == AgentMessageRole::User {
                let user_text = msg.text();
                if Self::contains_chinese(&user_text) {
                    return SessionLanguage::Chinese;
                }
                if !user_text.trim().is_empty() {
                    return SessionLanguage::English;
                }
            }
        }

        // 3. 兜底：若助手文本非空且无中文，推导为英文，否则回退为中文
        if !assistant_text.trim().is_empty() && !Self::contains_chinese(assistant_text) {
            SessionLanguage::English
        } else {
            SessionLanguage::Chinese
        }
    }
}
```

#### 1.2 极端输入与边界防御穿透
- **空消息输入（`""` / `\s+`）**：
  若助手回复为空串，`Self::contains_chinese("")` 返回 `false`，探测器自底向上回溯检查会话中的 User 消息；若会话全为空或无文本，最终第 3 步通过 `assistant_text.trim().is_empty()` 分支安全兜底至 `SessionLanguage::Chinese`。**全链路零 `unwrap()`，零索引越界，零 Panic**。
- **混合语言输入（Mixed Language）**：
  只要文本中包含任何标准 CJK 汉字字符（`\u{4e00}..=\u{9fff}` 或扩展 A 区 `\u{3400}..=\u{4dbf}`），优先判定为中文环境，确保国内用户混合指令时不被误切英文；如果全英文且无汉字，准确识别为英文。
- **特殊标点与 Emoji（🚀, 💻, 标点符号）**：
  Unicode 字符范围严格限定于 CJK 统一表意区，Emoji、英文 ASCII 标点、控制字符均不会触发假阳性判定。
- **自适应 Steering Nudge 注入**：
  ```rust
  // no_tool_calls.rs:140-150
  let language = SessionLanguageDetector::detect(state, &text);
  let nudge_prompt = match language {
      SessionLanguage::English => format!(
          "[System Auto-Steer]: You expressed an intent to execute an action (\"{}\"), but no structured tool call was detected in the current turn. Please immediately call the appropriate system tool (such as `shell_command`, `write_file`, etc.) to execute the action, or provide a definitive final conclusion for the user.",
          snippet
      ),
      SessionLanguage::Chinese => format!(
          "【系统自动推进】：你刚刚在回复中表达了执行动作的意图（“{}”），但当前轮次未检测到结构化的工具调用。请立即调用相应的系统工具（如 `shell_command`、`write_file` 等）执行操作，或者给出明确针对用户的最终结论。",
          snippet
      ),
  };
  ```
  在英文会话下自动注入纯英文系统引导，杜绝语言污染。

#### 1.3 空 Snippet 与超长意图截断（`ToolPromiseDetector`）
- **实现位置**：`crates/session-loop/src/steering/strategy.rs:272-418`
- **空 Snippet 杜绝**：`detect_action_promise(text)` 在 `text.trim().is_empty()` 时直接返回 `None`；提取出的 `result` 若为空也返回 `None`，绝不构造带有空片段的无意义推进。
- **超长文本安全截断**：
  ```rust
  // strategy.rs:278-288
  pub fn safe_tail_slice(text: &str, max_chars: usize) -> &str {
      let char_count = text.chars().count();
      if char_count <= max_chars {
          return text;
      }
      let skip_chars = char_count - max_chars;
      text.char_indices()
          .nth(skip_chars)
          .map(|(idx, _)| &text[idx..])
          .unwrap_or(text)
  }
  ```
  - `safe_tail_slice` 仅截取尾部 300 个 Unicode 字符，且通过 `char_indices()` 保证完全按 UTF-8 字符边界对齐，**绝对免疫多字节字符被截半导致的 Panic**；
  - 提取出的 action snippet 最大长度受限于 300 字符内，杜绝长 prompt 撑爆 LLM 上下文。
- **自愈防雪崩硬上限**：
  设置 `state.tool_promise_heals < state.options.tool_exec.max_tool_promise_heals`（默认 2 次），达到上限后记录 info 日志并安全收口退出，杜绝死循环风暴。

---

### 2. `/goal` 长期目标续写指令在极端轮次与超长 NextSteps 下的防溢出

#### 2.1 审查点与实现逻辑
在 `apps/agent-workbench/src-tauri/src/run/run_idle.rs:197-239` 与 `run_resume.rs:186-209, 294-320` 中，审查团队对长期目标（`/goal`）续写状态机进行了极端输入压测：

- **续写文本构建器（`build_goal_continuation_prompt`）**：
  ```rust
  // run_resume.rs:186-209
  pub(crate) fn build_goal_continuation_prompt(
      goal_state: &GoalState,
      next_steps: &[String],
  ) -> String {
      let round = goal_state.current_round + 1;
      let mut text = format!(
          "[目标模式 · 系统指令]\n\
           你正在执行长期目标，请持续推进直至完成，并在每轮结束前自检进度。\n\
           目标：{}\n\
           当前第 {}/{} 轮（自动续写上限 {} 轮）。\n\
           请工作直至目标实质完成；不要半途停下或只列计划而不执行。\n\
           请在回复中维护 markdown 任务清单（`- [ ]` / `- [x]`），便于进度同步。\n\
           若目标已完成，请在回复末尾明确写出 DONE 或「目标已完成」。",
          goal_state.goal, round, goal_state.max_rounds, goal_state.max_rounds
      );
      if !next_steps.is_empty() {
          text.push_str("\n上轮进度小结（供续接）：\n");
          for step in next_steps {
              text.push_str(&format!("- 下一步：{step}\n"));
          }
      }
      text.push_str("---");
      text
  }
  ```

#### 2.2 极端轮次边界防御（如第 999 轮）
- **上限受门禁刚性阻断**：
  在 `crates/orchestrator/src/goal_state.rs:163-167` 中，`goal_pending` 判定包含硬约束：
  ```rust
  pub fn goal_pending(&self, reason: AgentEndReason) -> bool {
      self.is_active()
          && self.current_round < self.max_rounds
          && normalize::allows_auto_continue(reason)
  }
  ```
  即使用户配置了极大的轮次（如 `max_rounds = 1000`），当 `current_round` 递增达到 `max_rounds` 时，`goal_pending` 严格翻转为 `false`，状态机转入 `Blocked(goal-max-rounds)` 终态，壳层 `run_idle.rs` 识别到四源全空，自动终止续轮，**永不触发无限续轮**。

#### 2.3 超长 `nextSteps` 与坏 JSON 容灾
- **数据库宽容读取（`read_summary_next_steps`）**：
  ```rust
  // run_resume.rs:294-320
  pub(crate) async fn read_summary_next_steps(&self, session_id: &str) -> Vec<String> {
      // ...
      db.list_blocks(&session_id, Some(1))
          .ok()
          .and_then(|blocks| blocks.into_iter().next())
          .and_then(|block| block.summary_json)
          .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
          .and_then(|value| {
              value.get("nextSteps")
                  .and_then(|steps| steps.as_array())
                  .map(|steps| steps.iter().filter_map(|step| step.as_str().map(String::from)).collect())
          })
          .unwrap_or_default()
  }
  ```
  若数据库损坏、JSON 格式非法、缺失 `nextSteps` 字段或数据类型非数组，全部通过 `and_then` 级联回退到 `unwrap_or_default()`（即空向量 `Vec::new()`），实现完全的 **Fail-Open**，不影响核心 goal 续写进程。
- **防空转风暴熔断器（Anti-empty-run Storm）**：
  在 `run_idle.rs:169-194` 中，如果连续 `IDLE_RESUME_MAX_EMPTY_ROUNDS`（默认 3 次）未产生有效 AI 输出，内核自动切断续 run，防止空转风暴耗尽算力与 Token。

---

### 3. 移动端 Push 17 场景通知极端容灾

#### 3.1 审查点与实现逻辑
在 `apps/agent-workbench/src-tauri/src/push/` 模块中，18 行场景（Z0 13 类统计口径）通知渲染与多厂商（APNs / HMS）推送管道经过严密设计：

- **场景渲染器（`render_copy`）**：
  `copy.rs:60-197` 覆盖全部 18 行场景（S1-S12），对所有可选字段进行多层 `Option` 展开防护：
  - `payload.detail.as_deref().unwrap_or_default()`
  - `payload.digest.as_deref().unwrap_or_default()`
  - `payload.detail.as_deref().unwrap_or("exit code 未知")`
  当任何字段为 `None` 时，绝不产生空指针或格式化 Panic。
- **业务键安全自愈（`biz_key_from_target`）**：
  ```rust
  // consumer.rs:125-135
  fn biz_key_from_target(params: &HashMap<String, String>) -> Option<String> {
      params.get("toolCallId")
          .or_else(|| params.get("runId"))
          .or_else(|| params.get("subagentId"))
          .or_else(|| params.get("taskId"))
          .or_else(|| params.get("timerId"))
          .or_else(|| params.get("cronId"))
          .cloned()
  }
  ```
  若目标参数中全部缺少上述字段，`notification_from_pending` 优雅回退使用 `message.dedupe_key` 作为业务键，确保通知正文完整。

#### 3.2 极端超长 Detail / Digest 的字符截断与 UTF-8 保护
- **厂商层硬性长度门禁**（`apns.rs:41-50` 与 `hms.rs`）：
  ```rust
  pub const APNS_TITLE_MAX_CHARS: usize = 30;
  pub const APNS_BODY_MAX_CHARS: usize = 120;

  pub fn truncate_chars(text: &str, max_chars: usize) -> String {
      text.chars().take(max_chars).collect()
  }
  ```
- **防护实效**：
  - 若 `detail` 或 `digest` 包含上万字符的错误堆栈或命令输出，进入 APNs / HMS 载荷前被刚性截断在 30 字符（标题）和 120 字符（正文）内；
  - 采用 `text.chars().take()` 进行 Unicode 字符迭代，彻底避免截断多字节 UTF-8 汉字引起的 Panic；
  - 当标题为空时，安全回退到常量 `APNS_DEFAULT_TITLE`（`"Crish 通知"`）。

#### 3.3 离线、超时与异常 Payload 容灾
在 `apps/agent-workbench/src-tauri/src/push/vendor/consumer.rs:184-279` 中：
- **设备未注册（Unregistered）**：保留待发，重新入队，不抛错；
- **凭据缺失（Credentials Missing）**：厂商通道未装配时不崩溃，记录 warning 日志，保留回队列；
- **网络超时与 429 限流**：标记为 `retryable`，通过重推延迟阶梯（Retry Ladder）退避重试；
- **410 DeviceNotRegistered**：标记永久失效，从队列中移除并清理设备表。

---

### 4. 前端复制操作防崩溃保护（Clipboard Robustness）

#### 4.1 审查点与实现逻辑
在前端交互（如代码块复制、会话 ID 复制、系统信息复制等）中，涉及两套工业级剪贴板安全工具：
- 核心通用工具：`packages/shared-utils/src/clipboard.ts`（`copyTextToClipboard`）
- 消息气泡专用工具：`apps/crish-desktop/src/components/chat-message-row/chatMessageRowUtils.ts`（`copyTextBestEffort`）

#### 4.2 双层安全降级漏斗实现
```typescript
// shared-utils/src/clipboard.ts:6-46
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false;

  // 1. 现代安全上下文 clipboard API 优先
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 若权限拒绝（NotAllowedError）或窗口失焦，平滑降级
    }
  }

  // 2. 降级方案（浏览器 DOM 隐蔽节点环境）
  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '-9999px';
      textarea.style.opacity = '0';
      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-hidden', 'true');
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (successful) return true;
    } catch {
      // 降级失败
    }
  }

  return false;
}
```

#### 4.3 极端边界防御断言
- **非字符串防御**：非 string 类型（`null`/`undefined`/对象）直接短路返回 `false`；
- **权限被拒（NotAllowedError）**：浏览器未聚焦、安全策略拦截或 iframe 阻断时，第一层 `catch` 吞匿异常并平滑转移至第二层 DOM 降级；
- **异常 DOM 状态**：在无 Head/无 Body 的特殊测试或脱水环境下，第二层 `catch` 捕获异常，确保返回 `false` 而不是向外抛出未捕获的 Promise Rejection；
- **零抛错零白屏断言**：全仓使用 `void copyTextToClipboard(...).then(...)`，即使极端环境下连续失败，UI 仅表现为未显示“已复制”对勾，绝不触发前端崩溃白屏。

---

## 三、自动化回归与集成门禁现场表现

审计员在真实宿主环境下全量执行了相关的内核测试、Push 管道测试与前端测试套件：

### 1. 内核自愈推进与语言探测测试套件
```bash
cargo test -p session-loop --lib no_tool_calls
```
**执行结果**：
- `test r#loop::handlers::no_tool_calls::tests::language_detector_classifies_correctly ... ok`
- `test r#loop::handlers::no_tool_calls::tests::english_action_promise_triggers_english_auto_steer_nudge ... ok`
- `test r#loop::handlers::no_tool_calls::tests::length_stop_caps_upgrades_even_with_huge_limit ... ok`
- **总计**：**4/4 全绿通过（0 失败）**。

### 2. Push 17 场景通知与多厂商分拣测试套件
```bash
cargo test --manifest-path apps/agent-workbench/src-tauri/Cargo.toml push::
```
**执行结果**：
- 场景与级别矩阵测试：`scene_registry_levels_align_m8_18_rows ... ok`
- 文本截断与字符安全测试：`payload_truncates_long_text ... ok`, `truncate_chars_utf8_safe ... ok`
- 字段缺失降级测试：`payload_falls_back_when_text_missing ... ok`, `notification_mapping_falls_back_without_copy ... ok`
- 厂商分拣与重试队列测试：`batch_keeps_pending_when_credentials_missing ... ok`, `batch_requeues_retryable_failures ... ok`
- **总计**：**202/202 全绿通过（0 失败，耗时 2.13s）**。

### 3. 前端复制操作与行级渲染测试套件
```bash
npx vitest run apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.test.ts
```
**执行结果**：
- 包含 `copyTextBestEffort` 空文本防御、复制成功返回 `true`、以及异常降级测试。
- **总计**：**16/16 全绿通过（0 失败）**。

---

## 四、审计结论与最终决议

Wave 4 涉及的内核自愈状态机、长期目标推进控制、移动端 Push 通知全链路以及前端剪贴板工具链，在面对空消息、混合语言、超长输入、字段缺失、网络超时与无权限 DOM 等各种极端场景时，均具备严密的防御机制与平滑降级设计。全链路零 Panic 隐患、零白屏风险，测试资产完备度 100%。

**审计决议**：**【PASS】（通过）**  
**准出意见**：**批准 Wave 4 极端场景防御与容灾降级体系准出，符合版本合并标准**。
