# 底层渲染引擎与 IPC 跨端消息国际化深度勘察报告

> **勘察角色**：T04 - 底层渲染引擎与 IPC 跨端消息勘察员 (T04-SURVEY-RENDER-IPC)  
> **勘察时间**：2026-10-14  
> **权威基准**：[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)、[`docs/agent-roles/general_task/三原则.md`](file:///c:/Software/conex/docs/agent-roles/general_task/三原则.md)、[`00-战役工作纪律与规范.md`](file:///c:/Software/conex/docs/i18n-full-remediation/00-战役工作纪律与规范.md)  
> **归属路径**：`docs/i18n-full-remediation/problems/04-底层渲染引擎与IPC跨端消息国际化勘察.md`

---

## 摘要与核心结论

多语言化（i18n）绝不能仅停留在 React 顶层 UI 的静态文案替换。如果底层渲染引擎、IPC 跨端通信协议、系统 Prompt 注入以及原生宿主交互中残留写死中文，会导致极其严重的**跨层体验撕裂（Cross-Layer UX Tearing）**与**大模型意图漂移（LLM Language Leakage）**。

本勘察员对 Rust 内核层（`crates/`）、Tauri 桌面宿主壳（`apps/agent-workbench/src-tauri/`）以及跨端 IPC 传输层展开了全景式的穿透勘察，发现以下**核心事实与架构断层**：

1. **渲染器直接缝合中文 UI（已抓现行）**：
   - `conex-markdown` 内核在构建代码块 HTML 时，直接将 `<button class="md-code-copy" title="复制" aria-label="复制代码">复制</button>` 硬编码写死在 Rust 字符串缓冲区中（[`renderer.rs:1312`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L1312)）；
   - 表格外壳直接输出 `<div class="md-table-wrap" role="region" aria-label="表格">`（[`renderer.rs:619`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L619)）；
   - **前端 DOM 调和器的致命反向耦合**：前端增量 DOM 调和模块 [`unitReconciler.ts:45`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/unitReconciler.ts#L45) 竟然直接使用了 CSS 选择器 `element.matches('.md-table-wrap, [role="region"][aria-label="表格"]')` 进行布局隔离！若草率将 Rust 中的 `表格` 改为英文 `Table`，将直接破坏前端表格的布局隔离（Layout Containment）逻辑；
   - 前端事件委托与临时反馈在 [`MarkdownDocumentView.tsx:168,172`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx#L168-L172) 和 [`useChatMessageState.ts:233,236,239`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts#L233-L239) 中同样手写写死了 `'已复制'`、`'复制'` 与 `'复制失败'`。

2. **IPC 错误体系存在双向“假本地化”错觉（The Localization Illusion）**：
   - 前端错误展示层 [`error-translation.ts:30`](file:///c:/Software/conex/apps/crish-desktop/src/utils/error-translation.ts#L30) 明确注记：`“用户可见的消息（直接使用 payload.message，已由 Rust 端本地化）”`；
   - 然而 Rust 内核与 Tauri 命令面在抛出错误时，全部直接使用中文拼接 `format!("会话不存在：{session_id}")`、`"run 已到终态，拒绝再转移"`、`"活动供应商不存在于配置树"`；
   - 结果：前端自以为“Rust 会负责本地化”，Rust 却直接“吐出硬编码中文”，导致英文 UI 下所有 Toast 提示、错误横幅正文全部强制显示中文。

3. **内核级 System Prompt 与意图自愈存在严重的单向中文偏向**：
   - `session-loop` 的 Tool-Promise 自愈推进直接向模型上下文注入纯中文 Steering 消息：`"【系统自动推进】：你刚刚在回复中表达了执行动作的意图（“{}”）..."`（[`no_tool_calls.rs:95-98`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/no_tool_calls.rs#L95-L98)），导致英文对话流中强行插入中文系统气泡；
   - 长期目标模式（`/goal`）续写系统指令全量硬编码中文（[`run_resume.rs:191-200`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_resume.rs#L191-L200)），且任务完成判据仅判定 `\bDONE\b` 或 `"目标已完成"`，伪任务过滤仅匹配 `"本轮总结"` 等中文前缀（[`goal_state.rs:506-520`](file:///c:/Software/conex/crates/orchestrator/src/goal_state.rs#L506-L520)）；
   - 子代理角色约束（`SUBAGENT_ROLE_CONSTRAINT_CONTENT`）、创建时间注入（`started_at_section`）、注释保留规范（`comment_preservation_section`）、权限申请指引（`permission_relay_section`）等系统级 Prompt 全量使用硬编码中文注入（[`subagent_inject.rs`](file:///c:/Software/conex/crates/agent-tools/src/subagent_inject.rs)）。

4. **移动端/多端推送通知（Push Notification）写死中文场景文案**：
   - Tauri 壳层推送渲染中心 [`push/copy.rs:61-197`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/push/copy.rs#L61-L197) 与静默汇总 [`push/quiet.rs:196-257`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/push/quiet.rs#L196-L257) 中，17 种场景（S1~S12，含审批请求、任务失败、卡死告警、Token浪费等）的推送标题与通知正文全量写死中文；
   - `VendorDevice`（APNs / HMS）设备注册完全没有感知设备当前 Locale，导致推送到海外或英文系统手机上的通知依然是中文。

5. **核心架构裁决建议**：
   - **严禁采用“Rust 动态感知前端 Locale”的重耦合设计**：若让 `conex-markdown` 或核心事件循环感知前端 Locale，将直接导致底层 LRU 缓存命中率崩溃、历史离线消息重绘性能灾难以及跨语言并发污染；
   - **必须采用“底层输出语言中立语义 DOM / 结构化 Token + 前端插槽替换/客户端水合”的最佳系统解**：Markdown 渲染器输出中立的属性（`data-action="copy"` / `class="md-code-copy"`），文案与无障碍标签交由 CSS 伪元素、SVG 图标与前端事件委托中心在运行时动态注入。
   - **跨端 IPC 错误重构为“Machine-Readable 错误码 + 命名参数字典 + 英文中立回退”单一真理源**。

---

## 一、底层硬编码中文全景实录（证据链与行号穷查）

### 1.1 渲染引擎层：`crates/conex-markdown` 与前端渲染镜像

#### (1) 代码块 HTML 外壳与复制按钮写死中文

- **文件路径**：[`crates/conex-markdown/src/renderer.rs:1312`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L1312)
- **代码片段**：
  ```rust
  out.push_str("<button type=\"button\" class=\"md-code-copy\" title=\"复制\" aria-label=\"复制代码\">复制</button></div></div><pre class=\"md-code-pre hljs\"><code class=\"language-");
  ```
- **问题分析**：
  - `title="复制"`：鼠标悬停原生气泡写死中文；
  - `aria-label="复制代码"`：屏幕阅读器读屏朗读写死中文；
  - 标签子节点文本 `复制`：直接渲染至 DOM 树，完全不受前端 i18n 控制。

#### (2) 表格区域无障碍属性写死中文

- **文件路径**：[`crates/conex-markdown/src/renderer.rs:619`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L619)
- **代码片段**：
  ```rust
  self.output.push_str(
      "<div class=\"md-table-wrap\" role=\"region\" aria-label=\"表格\"><table class=\"md-table\">",
  );
  ```
- **问题分析**：
  - `aria-label="表格"` 硬编码。

#### (3) 致命联动反噬：前端 DOM 调和器对中文属性的硬依赖

- **文件路径**：[`apps/crish-desktop/src/api/markdown/unitReconciler.ts:44-48`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/unitReconciler.ts#L44-L48)
- **代码片段**：
  ```ts
  function applyLayoutIsolation(element: Element): void {
    if (element.matches('.md-table-wrap, [role="region"][aria-label="表格"]')) {
      (element as HTMLElement).style.contain = 'layout';
    }
  }
  ```
- **问题分析**：
  - 前端流式渲染单元调和器（Unit Reconciler）竟然通过 `[aria-label="表格"]` 这一本地化属性来进行 CSS `contain: layout` 的排版隔离！
  - **严重架构耦合警告**：若仅在 Rust 侧修改 `aria-label`，而未同步重构 `unitReconciler.ts`（改为仅依靠类名 `.md-table-wrap`），会导致表格单元排版隔离静默失效，引发严重的流式重排性能抖动。

#### (4) 前端 Fallback 渲染器双轨镜像硬编码

在前端的 JavaScript 纯前端回退 Markdown 解析器中，存在与 Rust 完全同构的双轨硬编码：

- **文件路径**：[`apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts:79`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown-render/markdownCodeFence.ts#L79)
  ```ts
  const actions = `<div class="md-code-actions">${rightLang}<button type="button" class="md-code-copy" aria-label="复制代码" title="复制代码">复制</button></div>`;
  ```
- **文件路径**：[`apps/crish-desktop/src/api/markdown-render/markdownTable.ts:35`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown-render/markdownTable.ts#L35)
  ```ts
  const html = `<div class="md-table-wrap" role="region" aria-label="表格"><table class="md-table">...</table></div>`;
  ```

#### (5) 复制按钮运行时状态切换与 Toast 硬编码

用户点击代码块复制后，DOM 操作与 Toast 反馈写死中文：

- **文件路径**：[`apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx:167-173`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx#L167-L173)
  ```ts
  const originalText = copyBtn.textContent;
  copyBtn.textContent = '✓ 已复制';
  setTimeout(() => {
    copyBtn.classList.remove('is-copied');
    copyBtn.textContent = originalText || '复制';
  }, 1500);
  ```
- **文件路径**：[`apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts:232-239`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts#L232-L239)
  ```ts
  copyBtn.textContent = '已复制';
  window.setTimeout(() => {
    copyBtn.classList.remove('is-copied');
    copyBtn.textContent = originalText || '复制';
  }, 1500);
  // ...
  () => toast.show('复制失败');
  ```

---

### 1.2 核心会话循环与调度层：`session-loop` & `orchestrator`

#### (1) Tool-Promise 意图自愈机制的单向中文偏向与硬编码 Nudge

- **文件路径**：[`crates/session-loop/src/loop/handlers/no_tool_calls.rs:95-98`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/no_tool_calls.rs#L95-L98)
- **代码片段**：
  ```rust
  let nudge_prompt = format!(
      "【系统自动推进】：你刚刚在回复中表达了执行动作的意图（“{}”），但当前轮次未检测到结构化的工具调用。请立即调用相应的系统工具（如 `shell_command`、`write_file` 等）执行操作，或者给出明确针对用户的最终结论。",
      snippet
  );
  ```
- **影响**：
  - 当模型使用英文工作时（例如输出 `"I will now run the tests"`），内核自愈推进逻辑直接向模型会话历史中强行追加中文提示；
  - 该 Steering 消息会被模型作为 User 角色消息消费，直接污染上下文，导致模型随后的回复被强行拉入中文模式（Language Contamination）。
- **相关关键词侦测器**（[`strategy.rs:298-377`](file:///c:/Software/conex/crates/session-loop/src/steering/strategy.rs#L298-L377)）：
  - 排除短语包含写死中文：`"例如："`、`"示例如下："`、`"是否需要"`、`"您希望"`、`"请确认"`、`"我不会"`、`"暂不执行"`；
  - 行动承诺关键词：`"尝试单独调用"`、`"正在调用"`、`"现在开始执行"`、`"接下来使用"`、`"准备运行"`。

#### (2) C1 检查点（Checkpoint）协议 System Prompt 强制中文

- **文件路径**：[`crates/session-loop/src/checkpoint.rs:16-21`](file:///c:/Software/conex/crates/session-loop/src/checkpoint.rs#L16-L21)
- **代码片段**：
  ```rust
  pub fn checkpoint_prompt_section() -> &'static str {
      r#"## 检查点协议
  - 周期性输出一行结构化检查点：`CHECKPOINT: {"target":"当前目标","summary":"已完成摘要","timestamp":"2026-08-03T10:00:00.000Z","completed":["已完成步骤"],"files":["涉及文件"],"next":["下一步"]}`（前缀 `CONEX_CHECKPOINT` 同样识别）；
  - 存在 checkpoint 时优先恢复：中断后的续跑先消费检查点摘要与目标剩余部分，再继续行动，不重跑已完成步骤；
  - checkpoint 由引擎采集、只读不写（你不写入 checkpoint，引擎在安全点采集）；system 消息永不进入检查点内容。"#
  }
  ```
- **影响**：所有会话在装配 System Prompt 时，该检查点协议无条件以纯中文拼入，完全没有英文或中立版本。

#### (3) 长期目标模式（`/goal`）续写与任务匹配的硬编码

- **文件路径**：[`apps/agent-workbench/src-tauri/src/run/run_resume.rs:186-200`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_resume.rs#L186-L200)
- **代码片段**：
  ```rust
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
- **任务过滤判据**（[`crates/orchestrator/src/goal_state.rs:506-522`](file:///c:/Software/conex/crates/orchestrator/src/goal_state.rs#L506-L522)）：
  ```rust
  fn is_pseudo_task(body: &str) -> bool {
      body.starts_with("本轮总结") || body.starts_with("本轮小结") || body.starts_with("本轮回顾")
  }
  pub fn reply_looks_goal_done(text: &str) -> bool {
      // ...
      if trimmed.contains("目标已完成") {
          return true;
      }
      // ...
  }
  ```
  - 英文模型输出的 `- [ ] Round summary` 无法被 `is_pseudo_task` 识别过滤；
  - 英文模型输出 `"Goal completed"` 无法被 `reply_looks_goal_done` 识别，必须写死包含 `"目标已完成"` 或包含 `DONE`。

#### (4) 运行状态机收场错误文案

- **文件路径**：[`crates/session-loop/src/loop/handlers/turn_complete.rs:70,135,147`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/turn_complete.rs#L70)
  ```rust
  format!("run 失败（状态={machine_state:?}，事件=Error 收场）")
  format!("maxTurns 预算用尽（turnIndex={}，maxTurns={}）", state.turn_index, max_turns)
  ```

---

### 1.3 工具体系与系统注入层：`agent-tools` & `engine_build`

#### (1) 子代理体系角色与权限注入

- **文件路径**：[`apps/agent-workbench/src-tauri/src/engine_build.rs:1311-1321`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/engine_build.rs#L1311-L1321)
  ```rust
  pub(crate) const SUBAGENT_ROLE_CONSTRAINT_TITLE: &str = "子代理角色约束";
  pub(crate) const SUBAGENT_ROLE_CONSTRAINT_CONTENT: &str =
      "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。\
       如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。";
  ```
- **文件路径**：[`crates/agent-tools/src/subagent_inject.rs:56-69, 106-234`](file:///c:/Software/conex/crates/agent-tools/src/subagent_inject.rs#L56-L69)
  - `STARTED_AT_SECTION_TITLE`: `"会话注入（started_at）"`；正文：`"该时间点是隔离边界的一部分：你创建于上述时间点..."`；
  - `REVERT_CAUTION_TITLE`: `"git 回退谨慎指引"`；正文：`"你是子代理，创建于 started_at...执行 git 回退类操作前先自查目标状态年代..."`；
  - `COMMENT_PRESERVATION_TITLE`: `"注释保留规范"`；正文：`"替换时，replacement_content 必须完整承载目标区间内的原注释行..."`；
  - `PERMISSION_RELAY_TITLE`: `"权限申请指引"`；正文：`"你的任务类型为「{task_type}」...当任务确需超出默认权限的操作时：发起权限申请并说明理由..."`；
  - `OUTPUT_DIR_SECTION_TITLE`: `"文档产出目录"`；正文：`"本次会话的文档产出目录为 `{path}`（首次写入时自动创建）..."`。

#### (2) 探索类 Agent 配额错误与子代理守卫拦截

- **文件路径**：[`crates/agent-tools/src/explore_quota.rs:226-234`](file:///c:/Software/conex/crates/agent-tools/src/explore_quota.rs#L226-L234)
  ```rust
  Self::NotGranted => "探索类 agent 未获主 agent 分配的文档配额凭证：如需产出文档，请把发现以消息形式回报主 agent，由主 agent 分配后重试".to_string(),
  Self::Exhausted { consumed, quota } => format!(
      "探索类 agent 文档配额已用尽（quota={quota}，本会话已消耗 {consumed}）：请把发现以消息形式回报主 agent，不要再尝试创建文档"
  )
  ```
- **文件路径**：[`crates/agent-tools/src/tools/subagent/guard.rs:81-100`](file:///c:/Software/conex/crates/agent-tools/src/tools/subagent/guard.rs#L81-L100)
  ```rust
  Self::DepthExceeded { current, max } => format!("递归深度超限（maxDepth={max}，当前 {current}）：请减少递归层级，或把任务拆给同级子代理并行处理"),
  Self::NestingDenied { .. } => "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。请通过消息/上报向主 Agent 请求派发。".to_string(),
  Self::SiblingsExceeded { current, max } => format!("兄弟并发超限（maxSiblings={max}，当前 {current}）：请减少并发/合并任务，等待部分子代理完成后重试"),
  Self::ConcurrentExceeded { current, max } => format!("全局并发超限（maxConcurrent={max}，当前 {current}）：请减少并发/合并任务，等待部分子代理完成后重试"),
  Self::DeadlockDetected { target_session_id } => format!("子代理死锁：目标会话已在祖先链上（{target_session_id}）：请终止循环调用链"),
  ```

#### (3) 内置工具 Schema 描述与入参报错

- `conex-browser-tools`：
  - `helpers.rs:22-197`：入参校验报错全量写死中文：`"入参必须是 JSON 对象"`、`"缺少必填参数：{key}"`、`"参数 {key} 必须是字符串"`、`"URL 超长（> 4096 字符）"`、`"路径越出工作区：{input}"`；
  - `eval.rs:28-34`：工具 description 与入参说明写死中文：`"在页面隔离世界执行只读受限求值..."`；
- `conex-computer-tools`：
  - `tools.rs:813-975`：所有鼠标、键盘、截图工具的描述与参数 description 均为纯中文（`"向当前焦点输入文本（危险操作）..."`、`"发送组合键（危险操作）..."`）。
- `agent-tools/src/tools/subagent/tool.rs:249-387`：
  - `"tasks 必须是对象数组"`、`"tasks 不得为空数组"`、`"未知角色：{raw_role}"`、`"allowedTools 必须是字符串数组"`。

---

### 1.4 跨端 IPC 通信与推送通知：`src-tauri`

#### (1) 多端与移动端推送通知文案（Push Copy）全量硬编码中文

- **文件路径**：[`apps/agent-workbench/src-tauri/src/push/copy.rs:61-197`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/push/copy.rs#L61-L197)
- **代码实录**：
  ```rust
  let title = match scene {
      SceneId::ApprovalRequested => "Crish 需要你的批准".to_string(),
      SceneId::ApprovalExpired => "审批已过期".to_string(),
      SceneId::RunCompleted => "任务已完成".to_string(),
      SceneId::RunFailed => "任务运行失败".to_string(),
      SceneId::RunCancelled => "任务已取消".to_string(),
      SceneId::SubagentCompleted => "子代理已完成".to_string(),
      SceneId::SubagentFailed => "子代理失败".to_string(),
      SceneId::TaskStarted => "后台任务已启动".to_string(),
      SceneId::TaskCompleted => "任务已完成".to_string(),
      SceneId::TaskSuspicious => "任务疑似卡死".to_string(),
      SceneId::TaskFailed => "后台任务异常退出".to_string(),
      SceneId::TaskKilled => "任务已终止".to_string(),
      SceneId::TimerFired | SceneId::CronFired => "定时器提醒".to_string(),
      SceneId::RuntimeError => "运行异常".to_string(),
      SceneId::InterventionRequired => "需要你介入".to_string(),
      SceneId::SecurityBlocked => "安全拦截".to_string(),
      SceneId::CacheWasteAlert => "缓存浪费告警".to_string(),
  };
  ```
  正文模板同样硬编码（[`push/copy.rs:91-193`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/push/copy.rs#L91-L193)）：
  - `"审批（{}）等待超时，已自动拒绝"`
  - `"任务 {} 已完成"`
  - `"子代理（{}）已完成：成功"`
  - `"任务 {} 疑似卡死（{} 秒无输出）"`
  - `"拦截{}操作"`
  - `"本次运行浪费约 {} token"`
  - `operation_display`（[`push/copy.rs:201-210`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/push/copy.rs#L201-L210)）：`"删除"`、`"恢复"`、`"彻底清除"`、`"Git 回退"`、`"命令执行"`、`"未声明写入"`。
- **文件路径**：[`apps/agent-workbench/src-tauri/src/push/quiet.rs:196-257`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/push/quiet.rs#L196-L257)
  - 夜间静默折叠摘要正文：`format!("夜间完成 {total} 项")`、`"任务完成 ×{n}"`、`"定时器到期 ×{n}"`。

#### (2) 网络环境与防火墙引导文案（UI 直接渲染）

- **文件路径**：[`apps/agent-workbench/src-tauri/src/multi_device_network.rs:107-119`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/multi_device_network.rs#L107-L119)
- **代码实录**：
  ```rust
  fn hint_for(kind: NetworkKind) -> String {
      match kind {
          NetworkKind::Public => "当前为公用网络，请切换到专用网络后重试；若手机仍无法连接，\
               请关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。".to_string(),
          NetworkKind::Private | NetworkKind::Domain => {
              "手机无法连接时请关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。".to_string()
          }
          NetworkKind::Unknown => "未能识别当前网络类型。若手机无法连接，请检查 Windows 防火墙是否\
               放行专用网络，并关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。".to_string(),
      }
  }
  ```
  该 `hint` 字段直接通过 IPC 传递给前端 React 组件渲染，导致网络引导界面强行展示中文。

#### (3) 核心命令面与 Tauri 报错实录

- [`core_error.rs:46, 48`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/core_error.rs#L46):
  `CoreError::InvalidInput(format!("run 状态机拒绝转移：{e}"))`
  `CoreError::InvalidInput("run 已到终态，拒绝再转移".to_string())`
- [`run_commands.rs:454, 513, 645, 666, 800`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_commands.rs#L454):
  `CoreError::NotFound(format!("会话不存在：{session_id}"))`
  `CoreError::invalid_input(format!("模型配置未就绪：{e}"))`
  `CoreError::invalid_input("活动供应商不存在于配置树")`
  `CoreError::invalid_input(format!("配置保存被拒绝：{e}"))`
  `CoreError::NotFound(format!("任务不存在：{task_id}"))`
- [`sched.rs:987, 991, 1045`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/sched.rs#L987):
  `CoreError::NotFound(format!("cron 任务 {cron_id} 不存在"))`
  `CoreError::invalid_input(format!("cron 任务 {cron_id} 已处于暂停态"))`
  `CoreError::invalid_input(format!("cron 表达式非法：{e:?}"))`
- [`conex-fs/src/trash.rs:573-713`](file:///c:/Software/conex/crates/conex-fs/src/trash.rs#L573-L713):
  `bail!("回收站条目不存在：{entry_id}")`
  `"原路径不是绝对路径，拒绝恢复（登记数据异常，请重建条目）：{}"`
  `"原路径含「..」穿越组件，拒绝恢复（登记数据异常，请重建条目）：{}"`

---

### 1.5 错误注册表与数据契约断裂实录

在 `crates/conex-types/src/error.rs` 中，`CRISH_ERROR_REGISTRY`（102 个码）中所有的 `title` 均为中文写死：

- **文件路径**：[`crates/conex-types/src/error.rs:225-250`](file:///c:/Software/conex/crates/conex-types/src/error.rs#L225-L250)
  ```rust
  m.insert(codes::CONFIG_INVALID, CrishErrorInfo {
      code: codes::CONFIG_INVALID,
      title: "配置项非法",
      category: CrishErrorCategory::Permanent,
      retryable: false,
      is_public: true,
      action: "action.config.check_field",
  });
  ```
- **TS 侧镜像**：[`packages/shared-types/src/errors/info.ts:28-60`](file:///c:/Software/conex/packages/shared-types/src/errors/info.ts#L28-L60) 同样写死中文 `title`。
- **失真矛盾**：
  - 前端 `error-translation.ts` 试图通过 `translate(info.titleKey, BUILTIN_ERROR_DISPLAY[code]?.title)` 动态翻译 title；
  - 但对于 message 字段（[`error-translation.ts:30`](file:///c:/Software/conex/apps/crish-desktop/src/utils/error-translation.ts#L30)），前端直接使用 `payload.message`，而 `payload.message` 来自 Rust 内核硬编码的中文字符串！
  - 这种“前端以为 Rust 做了，Rust 以为前端做了”的断层，使得错误体系的国际化成为空中楼阁。

---

## 二、架构阻断分析：Rust 内核是否应感知前端当前 Locale？

在底层渲染（Markdown）与核心服务（SessionLoop）与前端 React 的交互中，存在一个核心架构抉择：**Rust 内核是否应该感知前端当前用户的 Locale？**

### 2.1 方案 A：Rust 内核感知 Locale 方案（Rust-Centric i18n）

**设计思路**：

1. 前端切换语言时，向 Rust 发送 IPC 命令 `set_locale("en-US")`；
2. 每次发起 Markdown 渲染或启动 Agent Run 时，入参携带 `locale: "en-US"`；
3. `conex-markdown` 的 `render(input, options)` 接收 `locale` 参数，在拼接 HTML 时分支判断 `if locale == "zh-CN" { "复制" } else { "Copy" }`；
4. `conex-markdown` 的 LRU Cache 键改为 `(hash(input), locale)`。

**缺陷与毁灭性代价**：

1. **LRU 缓存命中率断崖式下跌与内存翻倍**：
   - `crates/conex-markdown/src/cache.rs` 维护了一个高效的渲染缓存。如果引入 `locale` 作为缓存分叉维度，缓存容量消耗翻倍；
   - 切换语言时，所有缓存瞬间失效，导致全部重新解析渲染。
2. **离线历史消息持久化重绘灾难**：
   - Conex 会话历史保存在 SQLite（`sessions.db`）。若历史会话存储的是带“复制”字样的已渲染 HTML，切换语言后，所有历史消息必须全量重新走一遍 Markdown 渲染引擎！如果有上万条历史消息，将产生灾难性的 CPU 峰值与卡顿。
3. **多端/多窗口并发冲突**：
   - Crish 支持多端协同（`multi_device`）与多窗口；
   - 桌面端可能是 `zh-CN`，移动端或另一窗口可能是 `en-US`。如果 Rust 内核维护全局单例 Locale，会发生竞态覆盖；若每个请求透传，则跨层通信契约极度复杂。
4. **违反单一真理源（SSOT）与精简架构纪律**：
   - 必须在 Rust 中引入 `fluent-rs` 或自研字典包，造成前端与 Rust 两套字典冗余维护，完全违背反过度设计红线。

---

### 2.2 方案 B：语言中立语义 DOM + 前端插槽替换/Data-属性挂载方案（Decoupled Semantic Tokens）

**设计思路**：

1. **Rust 内核保持 100% 语言中立（Language-Agnostic）**：
   - `conex-markdown` 坚决不感知任何 Locale；
   - 渲染出的 HTML 外壳只输出中立的属性与标记：
     ```html
     <button
       type="button"
       class="md-code-copy"
       data-action="copy"
       aria-label="Copy code"
     >
       <span class="md-code-copy-icon" aria-hidden="true"></span>
     </button>
     ```
     或采用 `data-i18n-*` 插槽属性：
     ```html
     <button
       type="button"
       class="md-code-copy"
       data-action="copy"
       data-i18n-title="markdown.copy"
       data-i18n-aria="markdown.copyCode"
     >
       <span class="md-code-copy-label" data-i18n="markdown.copy"></span>
     </button>
     ```
   - 表格区域移除非语义中文：
     ```html
     <div
       class="md-table-wrap"
       role="region"
       data-role="table"
       data-i18n-aria="markdown.table"
     ></div>
     ```
2. **样式层与前端交互中心接管文案与图标展示**：
   - 现代代码编辑器（如 GitHub, VS Code, Notion）的代码块复制按钮**普遍仅显示图标**，不需要固定的“复制”汉字！
   - 悬停提示使用现有的 Tooltip 组件或 CSS `content: attr(data-tooltip)`；
   - 复制成功的反馈状态（`✓ 已复制`）通过 CSS 类名 `.is-copied` 与事件委托层 [`MarkdownDocumentView.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx) 中的 `t('markdown.copied')` 动态注入，1500ms 后自动复位；
   - 修复 [`unitReconciler.ts:45`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/unitReconciler.ts#L45) 中的选择器，统一为 `.md-table-wrap`，彻底解耦中文 `aria-label`。

---

### 2.3 方案对比矩阵与架构裁决

| 评估维度             | 方案 A：Rust 内核感知 Locale              | 方案 B：语言中立语义 DOM + 前端解耦挂载          |  优胜方案  |
| :------------------- | :---------------------------------------- | :----------------------------------------------- | :--------: |
| **缓存复用效率**     | 🔴 差（按 Locale 分叉，切换语言缓存全废） | 🟢 极佳（内容哈希唯一对应 HTML，全局 100% 复用） | **方案 B** |
| **历史消息切换表现** | 🔴 灾难（需异步遍历重绘全部历史消息）     | 🟢 瞬时（纯 CSS / 前端 DOM 属性响应，0 耗时）    | **方案 B** |
| **多端/多窗口协同**  | 🔴 冲突（全局状态冲突，并发请求易串味）   | 🟢 天然隔离（底层纯无状态，各端按本端渲染）      | **方案 B** |
| **字典维护成本**     | 🔴 双倍（Rust + TS 维护两套字典与映射）   | 🟢 单一真理源（所有文案 100% 收敛在前端字典）    | **方案 B** |
| **反过度设计红线**   | 🔴 违规（在 Rust 塞入大量本地化框架）     | 🟢 合规（Rust 仅做结构化解析，保持极致精简）     | **方案 B** |

> **权威裁决**：
> 采用 **方案 B（语言中立语义 DOM + 前端解耦挂载）**。Rust 内核坚决不做多语言字符串拼接，彻底将本地化呈现权交由前端表现层。

---

## 三、Tauri 原生层与跨宿主（Windows）多语言支持度勘察

### 3.1 Windows 原生层现状：无边框自定义渲染 vs 原生系统构件

在 `apps/agent-workbench/src-tauri/tauri.conf.json` 中：

```json
"app": {
  "windows": [
    {
      "title": "Crish",
      "decorations": false,
      "transparent": true,
      "visible": false
    }
  ]
}
```

- **窗口装饰**：`"decorations": false` 表明客户端采用**全自定义无边框窗口（Frameless Window）**。窗口标题栏、最小化/最大化/关闭按钮均由前端 TSX 自绘，完全不存在 Windows 原生标题栏文字本地化问题；
- **系统菜单与托盘**：当前代码库中**尚未启用原生系统菜单栏（Menu）与系统托盘（TrayIcon）**（`rg "tray" src-tauri` 为 0 结果）。上下文右键菜单均为前端 React 自研的 `SidebarContextMenus` 与 `LayerStack`，完全受前端 i18n 控制。

### 3.2 系统托盘与原生菜单的未来支持策略（前瞻防御）

若后续功能迭代需要引入 Windows 原生托盘（TrayIcon）或原生应用菜单，必须遵循以下策略：

1. **Windows 原生菜单的动态更新 API**：
   - Tauri v2 原生支持 `tray.set_tooltip(...)` 与 `menu_item.set_text(...)`；
   - **不能写死中文**：Rust 托盘模块应监听前端发出的 `i18n://language-changed` 事件，接收前端下发的轻量级系统级文案字典（如 `tray.tooltip`, `tray.quit`），调用 Win32 原生菜单 API 进行就地文本刷新。

### 3.3 原生文件选择对话框（IFileDialog）本地化勘察

当前客户端文件选择统一走官方插件 `tauri-plugin-dialog`。

- **Windows OS 底层行为**：
  - Windows 原生通用对话框（`IFileDialog`）的系统按钮（“打开”、“取消”、“查找范围”等）会**自动跟随 Windows 操作系统本身的显示语言**本地化，开发者无需干预；
- **缺陷暴露点：标题与过滤器写死中文**：
  - 对话框的窗口标题（`title`）与文件过滤器名称（`filters: [{ name: "图片文件" }]`）是由应用代码传入的；
  - 现状代码在 [`openFileDialog.ts:35`](file:///c:/Software/conex/apps/crish-desktop/src/api/openFileDialog.ts#L35) 与 [`openDirectoryDialog.ts:35`](file:///c:/Software/conex/apps/crish-desktop/src/api/openDirectoryDialog.ts#L35) 中，默认值与全部上层调用方均写死了中文：
    - `useFirstRunWizard.ts:396`: `openDirectoryDialogSafe('选择项目文件夹')`
    - `ExternalSessionImport.tsx:179,188`: `openDirectoryDialogSafe('选择 Claude 目录')` / `openDirectoryDialogSafe('选择 Codex 目录')`
    - `skillsApi.ts:97`: `openDirectoryDialogSafe('选择技能目录')`
    - `ProjectPickerMenu.tsx:86`: `openDirectoryDialogSafe('选择现有项目文件夹')`
    - `useChatAttachments.ts:468`: `openFileDialog({ title: '添加文件' })`
- **治理策略**：
  - 将 `openFileDialog` 与 `openDirectoryDialog` 的默认标题改为通过 i18n 解析（`t('dialog.selectFolder')` / `t('dialog.addFiles')`）；
  - 所有业务调用方严禁传入硬编码中文字符串，统一传入 `t(...)` 国际化词条。

---

## 四、跨端 IPC 通信协议改造技术路线建议

为了彻底根除跨端通信中的体验撕裂，必须在协议层划定清晰的**职责边界（Responsibility Boundary）**：

```
┌────────────────────────────────────────────────────────┐
│              Frontend Layer (React / UI)               │
│  - 掌握当前语言状态（zh-CN / en-US）                    │
│  - 持有全量本地化字典（UI、Error、Push、Markdown）        │
│  - 负责所有用户可见文案的格式化与参数插值                │
└──────────────────────────▲─────────────────────────────┘
                           │ IPC Event / Invoke
┌──────────────────────────┴─────────────────────────────┐
│             Cross-Process IPC Wire Protocol            │
│  - 语言中立（Language-Neutral）                         │
│  - 错误：{ code: "session.not_found", params: { id } }  │
│  - 渲染：中立 HTML (<button data-action="copy">)         │
│  - 推送：{ scene: "run_failed", params: { runId } }    │
└──────────────────────────▲─────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────┐
│                 Rust Core / Tauri Shell                │
│  - 零 Locale 状态（无状态，纯逻辑）                     │
│  - 抛出结构化错误码与原始技术参数                       │
│  - 生产英文标准日志（lingua franca for developers）    │
│  - 系统级 Prompt 针对会话 Locale 实施动态分流/中立化    │
└────────────────────────────────────────────────────────┘
```

### 4.1 错误协议标准化：统一错误码 + 结构化参数模型

#### 现状断层修复

将 `CoreError` 与 `CrishErrorPayload` 升级为具备**结构化参数**的标准协议：

```rust
// 改造后的 CrishErrorPayload 契约
pub struct CrishErrorPayload {
    pub code: String,                               // 机器可读错误码，如 "session.not_found"
    pub message: String,                            // 开发者英文回退，如 "Session not found: s-123"
    pub category: CrishErrorCategory,
    pub retryable: bool,
    pub is_public: bool,
    pub action: String,                             // 建议动作键，如 "action.session.select_existing"
    pub params: Option<HashMap<String, serde_json::Value>>, // 动态参数槽位，如 {"sessionId": "s-123"}
    pub metadata: Option<serde_json::Value>,
    pub cause: Option<Box<CrishErrorPayload>>,
    pub stack: Option<String>,
    pub timestamp: i64,
}
```

#### 前端 `error-translation.ts` 翻译收口

前端根据 `code` 查字典，并将 `params` 传入模板插值：

```ts
// 字典定义
"error.session.not_found": "会话不存在或已被删除（ID: {sessionId}）",
// en-US
"error.session.not_found": "Session not found or has been deleted (ID: {sessionId})",
```

当 `payload.params` 存在时，通过 `t('error.' + payload.code, payload.params)` 动态渲染本地化消息；仅当字典未命中时才回退至英文 `payload.message`。

---

### 4.2 Markdown 渲染器与 DOM 重构技术路线

1. **改造 `renderer.rs`**：
   - 移除写死中文：
     ```rust
     // 改造前：
     out.push_str("<button type=\"button\" class=\"md-code-copy\" title=\"复制\" aria-label=\"复制代码\">复制</button>");

     // 改造后（语言中立）：
     out.push_str("<button type=\"button\" class=\"md-code-copy\" data-action=\"copy\" aria-label=\"Copy code\"></button>");
     ```
   - 表格包装层：
     ```rust
     // 改造前：
     "<div class=\"md-table-wrap\" role=\"region\" aria-label=\"表格\"><table class=\"md-table\">"

     // 改造后（语言中立）：
     "<div class=\"md-table-wrap\" role=\"region\" aria-label=\"Data table\"><table class=\"md-table\">"
     ```
2. **清除前端 `unitReconciler.ts` 脏选择器**：
   ```ts
   // 改造前：
   if (element.matches('.md-table-wrap, [role="region"][aria-label="表格"]'))

   // 改造后：
   if (element.matches('.md-table-wrap'))
   ```
3. **前端交互与 CSS 图标化**：
   - 彻底将 `.md-code-copy` 改造成纯图标按钮（通过 SVG mask 图标），不再依赖文字“复制”；
   - 点击后的“已复制”状态，通过 CSS 伪元素与 i18n 动态挂载，或使用轻量级的气泡提示。

---

### 4.3 多端推送系统（Push Notification）的多语言设计

对于推送通知（`push/copy.rs`），必须支持用户设备当前语言：

1. **方案一：推送载荷解耦（推荐）**：
   - WS 直推（到手机端 Web/App）时，`PushMessage` 携带结构化 `scene` 与 `payload`，由手机端客户端根据手机本地语言自行调用字典渲染文案；
2. **方案二：服务侧双语字典**：
   - 厂商通道（APNs / HMS）无法在端侧解耦（厂商服务器需要直接展示标题正文）：
   - 在 `push/copy.rs` 中引入轻量级双语模板函数：
     ```rust
     pub fn render_copy(scene: SceneId, payload: &PayloadDigest, locale: Option<&str>) -> CopyText {
         let is_en = matches!(locale, Some("en" | "en-US"));
         // 根据语言输出对应标题与正文
     }
     ```
   - 在 `VendorDevice` 注册表（`push_devices`）中追加 `locale: Option<String>` 字段，由端侧注册 Token 时上报。

---

### 4.4 系统提示词（Prompt）注入层的分级国际化策略

Prompt 直接影响大模型的认知状态与输出语言：

1. **L0/L1 协议性提示词（如检查点、角色约束、时间注入）**：
   - 协议行前缀（如 `CHECKPOINT: {...}`）必须使用 ASCII 英文，防止模型解析失败；
   - 约束说明文字：改造 `checkpoint_prompt_section` 与 `subagent_session_injections`，使其接收会话级 `locale`（通过 `options.assembly.locale` 从前端透传），根据语言分别注入对应的中/英文提示词模板（对齐 `SYSTEM_CORE_PROMPT` 的双语模式）；
2. **意图自愈 Nudge 消息（`no_tool_calls.rs`）**：
   - 判断最近一轮助手回复的语言特征，或依据会话配置的 `locale`；
   - 英文会话注入：`"[System Auto-Steer]: You expressed an intent to execute an action (\"{snippet}\"), but no structured tool call was detected..."`；
   - 中文会话注入对应的中文提示词。
3. **长期目标模式（`/goal`）续写与匹配**：
   - `build_goal_continuation_prompt` 支持英文提示词；
   - `reply_looks_goal_done` 扩展识别 `\b(done|completed|finished|all tasks completed)\b`；
   - `is_pseudo_task` 扩展识别英文伪任务前缀：`Summary of this round`, `Round recap`, `Round summary` 等。

---

## 五、勘察清单与受影响源码全景对照表

|  序号  | 所属模块 / Crate | 文件路径与行号                                                                                                                                | 现存硬编码内容 / 缺陷                                                    | 危害级别 | 建议改造方案                                                  |
| :----: | :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------- | :------: | :------------------------------------------------------------ |
| **1**  | `conex-markdown` | [`renderer.rs:1312`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L1312)                                                   | `<button ... title="复制" aria-label="复制代码">复制</button>`           | 🔴 严重  | 改为语言中立结构，文案由前端接管                              |
| **2**  | `conex-markdown` | [`renderer.rs:619`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L619)                                                     | `aria-label="表格"`                                                      | 🔴 严重  | 改为 `aria-label="Data table"`，移除前端脏依赖                |
| **3**  | `crish-desktop`  | [`unitReconciler.ts:45`](file:///c:/Software/conex/apps/crish-desktop/src/api/markdown/unitReconciler.ts#L45)                                 | `element.matches('... [aria-label="表格"]')`                             | 🔴 致命  | 移除对中文属性的选择器依赖，仅保留 `.md-table-wrap`           |
| **4**  | `crish-desktop`  | [`MarkdownDocumentView.tsx:168`](file:///c:/Software/conex/apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx#L168)          | `copyBtn.textContent = '✓ 已复制'`                                       | 🟠 中等  | 接入 `useI18n` 动态获取 `t('markdown.copied')`                |
| **5**  | `crish-desktop`  | [`useChatMessageState.ts:233,239`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts#L233) | `copyBtn.textContent = '已复制'`, `toast.show('复制失败')`               | 🟠 中等  | 接入 `t('markdown.copied')`, `t('markdown.copyFailed')`       |
| **6**  | `session-loop`   | [`no_tool_calls.rs:95-98`](file:///c:/Software/conex/crates/session-loop/src/loop/handlers/no_tool_calls.rs#L95-L98)                          | `【系统自动推进】：你刚刚在回复中表达了执行动作的意图...`                | 🔴 严重  | 针对会话 `locale` 提供中/英双语自愈 Nudge 模板                |
| **7**  | `session-loop`   | [`checkpoint.rs:16-21`](file:///c:/Software/conex/crates/session-loop/src/checkpoint.rs#L16-L21)                                              | `checkpoint_prompt_section` 纯中文注入                                   | 🟠 中等  | 提取中英双语模板，按需加载                                    |
| **8**  | `src-tauri`      | [`run_resume.rs:191-200`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/run/run_resume.rs#L191-L200)                           | `[目标模式 · 系统指令]...` 全中文提示                                    | 🔴 严重  | 支持根据会话 `locale` 渲染英文续写 Prompt                     |
| **9**  | `orchestrator`   | [`goal_state.rs:506-520`](file:///c:/Software/conex/crates/orchestrator/src/goal_state.rs#L506-L520)                                          | `is_pseudo_task` 仅过滤中文，`reply_looks_goal_done` 仅判 `"目标已完成"` | 🔴 严重  | 扩充英文前缀识别（`Summary of this round` 等）与完成词        |
| **10** | `src-tauri`      | [`engine_build.rs:1311-1321`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/engine_build.rs#L1311-L1321)                       | `SUBAGENT_ROLE_CONSTRAINT_CONTENT` 写死中文                              | 🟠 中等  | 改为中英双语常量，按子代理配置分流                            |
| **11** | `agent-tools`    | [`subagent_inject.rs:106-234`](file:///c:/Software/conex/crates/agent-tools/src/subagent_inject.rs#L106-L234)                                 | `started_at_section`, `revert_caution` 等全中文 Prompt                   | 🟠 中等  | 增加中英双语支持，消除英文模型下的上下文撕裂                  |
| **12** | `agent-tools`    | [`explore_quota.rs:226-234`](file:///c:/Software/conex/crates/agent-tools/src/explore_quota.rs#L226-L234)                                     | `探索类 agent 未获主 agent 分配的文档配额凭证...`                        | 🟠 中等  | 统一为标准结构化错误码与英文回退                              |
| **13** | `agent-tools`    | [`guard.rs:81-100`](file:///c:/Software/conex/crates/agent-tools/src/tools/subagent/guard.rs#L81-L100)                                        | `递归深度超限...`、`你没有创建子 Agent 的能力...`                        | 🟠 中等  | 统一为标准结构化错误码与英文回退                              |
| **14** | `src-tauri`      | [`push/copy.rs:61-197`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/push/copy.rs#L61-L197)                                   | 17 种场景推送标题与正文全写死中文                                        | 🔴 严重  | 设备注册支持 `locale`，推送文案增加英文模板支持               |
| **15** | `src-tauri`      | [`multi_device_network.rs:107-119`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/multi_device_network.rs#L107-L119)           | 网络环境引导文案 `hint_for` 写死中文                                     | 🔴 严重  | 仅下发枚举/状态码，文案交由前端字典按 `kind` 渲染             |
| **16** | `conex-types`    | [`error.rs:225-250`](file:///c:/Software/conex/crates/conex-types/src/error.rs#L225-L250)                                                     | `CRISH_ERROR_REGISTRY` 102 码 title 全为中文                             | 🔴 严重  | 统一改为 i18n 键（如 `error.config.invalid.title`）与英文回退 |
| **17** | `crish-desktop`  | [`error-translation.ts:30`](file:///c:/Software/conex/apps/crish-desktop/src/utils/error-translation.ts#L30)                                  | `readonly message: string` 假定 Rust 已本地化                            | 🔴 严重  | 接入 `params` 插值机制，优先通过 i18n 字典格式化              |
| **18** | `crish-desktop`  | [`openDirectoryDialog.ts:35`](file:///c:/Software/conex/apps/crish-desktop/src/api/openDirectoryDialog.ts#L35)                                | 默认标题 `'选择文件夹'` 与调用方硬编码中文                               | 🟡 一般  | 改由调用方传入 `t('dialog.selectFolder')` 动态文案            |

---

## 结论与行动建议

底层渲染引擎与 IPC 跨端通信是国际化最容易被忽视的“暗礁”。若不治理，即使前端 React 页面将文字替换得再彻底，用户在代码复制、报错弹窗、目标推进、子代理交互以及手机通知中依然会频繁看到写死的中文，造成极其低质的体验。

**下一阶段（Phase 2: 分维方案设计）的关键行动项**：

1. **渲染层解耦方案**：制定 `conex-markdown` 纯净语言中立输出标准，彻底剥离 HTML 中的中文字符，同步重构 `unitReconciler.ts` 清理历史包袱；
2. **IPC 错误参数化改造案**：为 `CrishErrorPayload` 补充 `params` 字段，使 Rust 仅需输出结构化键值对，由前端字典负责最终多语言格式化；
3. **提示词中立化与分流策略**：梳理内核中注入大模型的所有 System Prompt，确立按会话 `locale` 动态选择中/英模板的规范，防止英文会话被中文系统提示词污染；
4. **推送系统多语言协议**：为 `VendorDevice` 增加语言字段，使 APNs / HMS 推送服务具备向不同设备下发对应语言通知的能力。
