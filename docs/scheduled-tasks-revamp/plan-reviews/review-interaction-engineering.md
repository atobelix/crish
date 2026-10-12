# 定时任务全流程修复与能力升级战役（Scheduled Tasks Revamp）

# 端到端交互与产品工程首席审查报告（Interaction & Product Engineering Review）

> **文档标识**：`review-interaction-engineering.md`  
> **审查官**：端到端交互与产品工程首席审查官（Interaction & Product Engineering Reviewer）  
> **审查对象**：
>
> - 战役总方案：`docs/scheduled-tasks-revamp/00-总方案-定时任务全链路重构与功能完善实施规划.md`
> - 阶段 3 最终方案：`docs/scheduled-tasks-revamp/plans/03-阶段三-目标会话绑定与对话内自动化定时任务能力最终方案.md`
> - 阶段 5 最终方案：`docs/scheduled-tasks-revamp/plans/05-阶段五-前端UI交互表单能力与状态同步最终方案.md`
> - 阶段 4 最终方案：`docs/scheduled-tasks-revamp/plans/04-阶段四-Tauri-IPC命令面与元数据双向一致性最终方案.md`
> - 核心涉及代码：
>   - `apps/crish-desktop/src/components/settings/WorkflowForm.tsx`
>   - `apps/crish-desktop/src/components/settings/useWorkflowsState.ts`
>   - `apps/crish-desktop/src/components/settings/workflowsSharedLib.ts`
>   - `apps/crish-desktop/src/api/workflow-api/workflowDraft.ts`
>   - `apps/crish-desktop/src/api/workflow-api/workflowScheduler.ts`
>   - `apps/crish-desktop/src/components/chat-card/useChatInput.ts`
>   - `apps/crish-desktop/src/components/chat-card/ChatCard.tsx`
>   - `apps/crish-desktop/src/components/chat-composer/TiptapComposerField.tsx`
>   - `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`
>   - `apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts`
>   - `apps/crish-desktop/src/api/draft/sessionDraftManager.ts`
>   - `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`
>   - `crates/agent-tools/src/tools/create_workflow.rs`
>   - `crates/conex-types/src/cron.rs`
>   - `apps/agent-workbench/src-tauri/src/run/run_launch.rs`  
>     **审查纪律基线**：仓库根目录 `AGENTS.md`（§12 Tooltip、§13 输入框对比度、§14 现代色彩、§7 严禁补丁与立体验证）、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`。  
>     **编码格式**：UTF-8 无 BOM 中文。

---

## Executive Summary 审查执行摘要与裁决结论

本审查官立足于**真实用户心智链路**、**React 复杂并发渲染树性能**与**生产级前端工程健壮性**，对《Scheduled Tasks Revamp》战役的阶段 3、4、5 方案及总方案展开了逐行代码级穿透审查。

### 总体审查裁决：【原则性通过，但必须补齐 5 项交互与工程防御加固】（Conditional Pass with Hardening Gates）

方案整体结构恢弘，精准切中了旧版本“虚假完成、双写抹杀、单任务控制失效、CWD 暴力绑架”等核心架构病灶。双模会话绑定（Bound vs Isolated）与 0ms 乐观更新的设计极具产品前瞻性。

然而，在**真实 React 渲染树运作细节**、**用户输入法（IME）并发安全**、**时区跨端一致性**及**全局任务降级边界**上，方案存在**脱离真实浏览器物理表现的理论化盲区**。若直接按现有方案落地，必将引发“中文打字丢字跳光标、幽灵会话死灰复燃、全局任务误删安装包、断网时状态机卡死”等次生灾难。

### 六大核心缺陷与隐患速览（Red Flags Summary）

| 缺陷编号  | 严重等级    | 缺陷定性                                                          | 真实物理场景后果                                                                                                                                                                                                |
| :-------- | :---------- | :---------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RF-01** | **P0 致命** | **Tiptap 150ms 防抖与 `setContent` 竞态致光标重置与丢字**         | 用户在绑定的当前会话打字时，定时任务触发流式输出；由于 `TiptapEditorExtensions` 的 150ms 序列化防抖，`lastContentRef` 滞后，父级重新传参触发 `setContent`，**直接粉碎用户正在键入的拼音并强制将光标移至文末**。 |
| **RF-02** | **P0 致命** | **全局任务 `cwd: None` 降级至应用程序安装目录产生破坏风险**       | 方案移除了 `WorkflowForm` 的强行覆写 `cwd`，但 Rust 执行端 `run_launch.rs:132` 将 `None` 降级为 `std::env::current_dir()`。在桌面客户端中这往往是应用程序安装目录，用户执行清理指令极易误删软件自身文件。       |
| **RF-03** | **P1 严重** | **5 字段 Cron 下发缺失显式时区导致跨端 8 小时触发时差**           | 前端下发 `cron` 调度类型时只传 `expression` 字符串，缺失 `timezone`；而 Rust 仅在 Windows 下取本地时区，非 Windows 或远程引擎 fallback 为 UTC，导致人读徽标与真实触发时间偏差 8 小时。                          |
| **RF-04** | **P1 严重** | **被绑定会话删除后，定时到期导致幽灵会话死灰复燃**                | 用户在侧栏删除了绑定的会话，但定时任务依然持有旧 `target_session_id`。到期触发时 `run_launch.rs:455` 执行 `insert_session` 自愈补建，已删除的空会话重新出现在侧边栏，破坏用户预期。                             |
| **RF-05** | **P2 中度** | **0ms 乐观锁的 React 状态不可变性与快速连击（Flapping）状态卡死** | `togglingIds` 采用原位 `Set.add()` 会使 React 丢失重渲染通知；2000ms 粗粒度时间戳在用户 2 秒内快速反向连击时，导致新状态被旧的保护锁强行冲刷回退。                                                              |
| **RF-06** | **P2 中度** | **侧栏时钟徽标引发全量长列表（数百会话）重渲染性能风暴**          | 若每个 `SessionRow` 粗暴订阅全局 `workflows` 状态，定时任务的每次触发与轮询将导致整个侧栏所有会话全部重新 render，引发侧栏滚动掉帧卡顿。                                                                        |

---

## 一、方案逻辑顺序与用户心智闭环审查（Mental Model & User Journey）

### 1.1 三大入口全路径闭环核查

用户与定时任务的交互在 Crish 中存在三个主要触点：

1. **侧栏定时任务面板（`ScheduledTasksPanel`）**：全局查阅、手动创建与启停；
2. **对话输入框斜杠命令（`/schedule`）**：基于自然语言模板引导创建；
3. **Agent 交互与自主编排（`CreateWorkflowTool`）**：模型根据对话上下文自动创建。

```
┌────────────────────────────────────────────────────────────────────────┐
│                        三大入口与目标模式映射链路                       │
└────────────────────────────────────────────────────────────────────────┘
 [入口 1: 对话输入框 /schedule]   [入口 2: AI 自主编排]    [入口 3: 侧栏管理面板]
             │                            │                         │
             ▼                            ▼                         ▼
   填充自然语言模板              调用 create_workflow 工具      表单创建 WorkflowForm
   (默认绑定当前活跃会话)         (读取 ctx.session_id)         (单选 ExecutionTarget)
             │                            │                         │
             ├────────────────────────────┴─────────────────────────┤
             ▼                                                      ▼
     【当前会话绑定 Bound】                                  【独立后台 Isolated】
   target_mode = "current"                                target_mode = "isolated"
   target_session_id = Some(sid)                          target_session_id = None
             │                                                      │
             ▼                                                      ▼
   宿主对话侧栏点亮时钟 ⏰                                 侧栏归档专用会话
   时间线追加 ScheduledTaskExecutionCard                  静默后台运行不打扰
```

#### 审查结论与闭环断层：

- **入口 1 & 2 闭环良好**：通过改造 `CreateWorkflowTool`，消除 `_ctx` 下划线忽略，直接读取 `ctx.session_id` 作为默认绑定，心智自然。回执文案明确回显“已绑定当前对话（会话 ID: xxx）”，对模型和用户皆具备确定性反馈。
- **入口 3 存在无活跃会话时的心智断裂**：
  在 `WorkflowForm.tsx` 中，单选控件呈现：
  - “在当前活跃对话追加执行（推荐）”
  - “创建独立后台新会话”
    **真实断裂场景**：当用户处于系统设置页（`SettingsScheduleTab`）或刚启动应用处于空态落地页时，当前根本没有打开任何会话（`activeSessionId == null`）。
    现有代码草稿构造为：
    `targetSessionId: draft.targetSessionId || activeSessionId`。
    当 `activeSessionId` 为空时，若用户勾选了“在当前活跃对话追加执行”，保存时下发的 `target_session_id` 实际上是 `undefined`！
    结果系统悄悄将其降级为 `isolated_session`，用户在表单上选了“当前对话”，保存后却变成了“独立后台会话”，**完全违反了界面确定性原则**。
    **【必修改进】**：若 `activeSessionId` 为空，表单中“在当前活跃对话追加执行”单选项必须自动置灰禁用，并附带 Tooltip 提示“当前未处于任何对话中，仅可创建独立后台任务”，或者在创建时动态为用户新建一个命名会话并绑定。

### 1.2 幽灵会话死灰复燃陷阱（Zombie Session Resurrection）

这是阶段 3 方案中遗漏的**最严重的产品生命周期断层**。

- **断裂链路推演**：
  1. 用户在会话 `sess-dev-daily` 中创建了定时任务 A，绑定模式为当前会话（`target_session_id = "sess-dev-daily"`）；
  2. 任务运行数天后，用户在侧边栏右键删除了 `sess-dev-daily`（数据已被从 SQLite `sessions` 表软删或物理删除）；
  3. 明天 09:00 到达，底层调度器触发任务 A；
  4. 调度器读取 `StoredWorkflow`，发现 `target_session_id = Some("sess-dev-daily")`；
  5. 阶段 2 执行引擎拉起 `run_task_impl(session_id = "sess-dev-daily")`；
  6. 查看 `apps/agent-workbench/src-tauri/src/run/run_launch.rs:452-456`：
     ```rust
     // 确保 session 行存在（自愈补建，避免 FK 报错）
     if let Some(db) = state.local_db() {
         let sid = session_id.clone();
         let _ = tokio::task::spawn_blocking(move || db.insert_session(&sid, "")).await;
     }
     ```
  7. **灾难发生**：底层执行器为了防止外键崩溃，**静默将已被用户删除的 `sess-dev-daily` 重新插入了数据库**！
  8. 前端收到事件，侧边栏突然“复活”了一个被用户早已删除的空会话，并开始流式输出内容！用户会误以为软件发生灵异事件或数据错乱。
- **【必修改进】**：
  1. **执行前会话存活性校验**：在 `launch_scheduled_task` 时，必须预先查询目标会话是否存在且未被标记删除。若已物理不存在，**绝不可盲目 `insert_session` 复活**，而是自动降级为 Isolated 模式（生成专用执行会话 `sched-{cron_id}`），并将任务的 `target_mode` 原地转为 `isolated`，向前端发出告警事件。
  2. **删除会话时的级联治理**：在前端用户尝试删除一个会话时，若检测到该会话绑定有活跃的定时任务，弹出确认弹窗：“该对话绑定了 N 个定时任务，删除后任务将自动转为独立后台运行。是否确认删除？”。

---

## 二、非侵入式草稿保护锁的 React 渲染树可行性极限检验（Draft Guardrails Deep Dive）

阶段 3 方案宣称拥有“四大草稿保护锁（Draft Guardrails）”，承诺：

> “流式输出不冲刷输入框草稿、不抢焦点、输入打字不卡顿”。

本审查官深入剖析了 `apps/crish-desktop/src/components/chat-composer/` 的 ProseMirror / Tiptap 渲染机制，结论是：**仅靠概念上的“数据流隔离”，在 React 渲染树中根本无法保障上述承诺，必须正视并根治以下三大渲染层硬伤！**

### 2.1 致命隐患 A：Tiptap 150ms 序列化防抖与 `setContent` 竞态（光标重置与丢字）

#### 1. 真实代码断点穿透

在 `apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts:168-180` 中：

```typescript
onUpdate: ({ editor }: any) => {
  if (bridge.debounceTimerRef.current) {
    clearTimeout(bridge.debounceTimerRef.current);
  }
  bridge.debounceTimerRef.current = setTimeout(() => {
    const markdown = serializeToMarkdown(editor.getJSON());
    bridge.lastContentRef.current = markdown;
    checkOversize(markdown);
    bridge.callbacksRef.current.onMarkdownChange?.(markdown);
  }, 150); // <--- 关键防抖：150 毫秒！
},
```

而在 `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx:282-316` 中：

```typescript
useEffect(() => {
  if (!editor || content === undefined) return;
  let safeContent = content;
  // ...
  if (safeContent === lastContentRef.current) return;

  const rafId = requestAnimationFrame(() => {
    if (!editor || editor.isDestroyed) return;
    try {
      const doc = parseFromMarkdown(safeContent);
      editor.commands.setContent(doc); // <--- 致命调用：强制重置 ProseMirror 文档
    } catch { ... }
    lastContentRef.current = safeContent;
  });
  return () => cancelAnimationFrame(rafId);
}, [editor, content]);
```

#### 2. 竞态发生过程（打字被打断丢字）

1. 用户正在当前绑定的会话中聚精会神输入一段内容，刚输入到“今天下午我们讨论一下...”；
2. 此时定时任务到期触发，在当前会话追加了一条消息并开始流式吐字；
3. `ChatCard` 订阅的 `messages` 频繁变更，触发 `ChatCard` 重渲染；
4. 用户在 Tiptap 中又键入了字符“架构”，触发 ProseMirror 的本地 DOM 更新；
5. 但是 `onMarkdownChange` 被 `setTimeout(..., 150)` 拦截，**此时宿主父组件的 `chatInput` 还是 150ms 之前的旧文本**！
6. 在这 150ms 的空窗期内，由于后台流式事件到达，`ChatCard` 把旧的 `chatInput` 再次透传给 `TiptapComposerField` -> `TiptapEditorField(content: "今天下午我们讨论一下...")`；
7. 此时 `safeContent`（旧内容）与 `lastContentRef.current` 不相等！
8. `useEffect` 命中，在下一帧 `requestAnimationFrame` 中暴力执行 `editor.commands.setContent(doc)`！
9. **现场惨剧**：用户刚刚键入的“架构”两个字被瞬间抹除，正在进行的中文输入法拼音选词框被强行打断关闭，**光标瞬间被重置并弹跳到整段文字的最末尾**！

#### 3. 权威根治策略（不可妥协的工程防护）

必须为 `TiptapEditorField` 引入**正在打字保护屏障（Is-Typing Barrier）**：

```typescript
// 当编辑器处于聚焦态且距上次本地按键不到 300ms 时，禁止任何外部 content 的 setContent 水合！
const isUserActivelyTyping =
  editor.isFocused && Date.now() - lastLocalKeystrokeTime < 300;
if (isUserActivelyTyping) {
  return; // 坚决不执行 setContent，保护用户当前的输入缓冲区！
}
```

### 2.2 致命隐患 B：IME 中文输入法合成被打断与拼音误上屏

在中文、日文等 CJK 输入场景下，用户打字经历 `compositionstart -> compositionupdate -> compositionend`。
在浏览器底层，合成未结束时，任何微任务阻塞或 DOM 节点的重排都会让浏览器判定“输入法异常失焦”，从而把半成品的拼音英文字母直接强制确认上屏（例如输入 `ceshi` 本想打出“测试”，直接被截断成 `c'e's'h'i`）。

- **代码现状**：
  `ChatComposer.tsx` **未包裹 `React.memo`**（`ChatComposer.tsx:53`：`export const ChatComposer: React.FC<ChatComposerProps> = ({`）；
  流式 Token 每秒可能推送 30-60 次。每次 Token 推送都会引发 `ChatCard` 树自顶向下递归 Diff。
  虽然 `TiptapEditorField.tsx:323-340` 监听了 `compositionstart`，但这仅能阻止键盘事件穿透，**无法阻止外层 React 渲染调度对主线程渲染帧的抢占**。
- **【必修改进】**：
  必须将 `ChatComposer` 进行绝对的 `React.memo` 隔离，或通过 Context 将时间线消息（`ChatMessageList`）与输入区（`ChatComposer`）彻底解耦，确保时间线上的 Token 暴风雨在 React 虚拟 DOM 树上**物理阻断在 `ChatMessageList` 内部**，0 次波及 `ChatComposer`！

### 2.3 致命隐患 C：`MessageVirtualizer` 虚拟列表高度跳变与视口剧烈抖动

阶段 3 方案声称：

> “视口防跳动机制：若用户已滚动浏览历史记录（处于非贴底状态），禁止强行向下平滚；底部显示轻量胶囊「⏰ 定时任务正在执行，点击查看最新动态」”。

本审查官查阅了 `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` 的真实实现：

1. **轻量胶囊根本未接入**：
   `MessageVirtualizer` 目前只拥有一个通用的 `showFloorButton`（一个单纯回到底部的圆形箭头按钮），**根本没有“定时任务正在执行”的专属胶囊卡片与状态感知通道**！
2. **虚拟高度估算跳变问题**：
   当定时任务在时间线插入一张带有复杂 Markdown、思考折叠框和工具调用的 `ScheduledTaskExecutionCard` 时，虚拟滚动管理器 `vsManager` 初始使用的是 `fallbackHeight: 80px`（`estimateTimelineMessageHeight`）。
   当真实卡片渲染完成，`ResizeObserver` 回调（`useStableRowMeasureRef`）测得真实高度为 360px。
   高度瞬间暴增 280px！
   若此时用户正在输入框上方阅读第 5 条历史消息，这一暴增会导致视口发生瞬间向下的像素级位移（Jump Cut），视觉上产生严重闪烁跳动。

- **【必修改进】**：
  必须为 `ScheduledTaskExecutionCard` 预置精确的初始估高常量（例如预估 240px），并在 `useScrollAnchor.ts` 中针对定时任务追加事件启用视口锚定豁免（Scroll Anchoring），确保历史浏览位置绝对纹丝不动。

---

## 三、前端表单能力、时区偏差与 CWD 降级安全边界（Form & Timezone & CWD Guard）

### 3.1 5 字段 Cron 输入与实时人读徽标的时区偏差（Timezone Drift）

阶段 5 方案在 `WorkflowForm.tsx` 中引入了 5 字段 Cron 输入与动态徽标（如 `✓ 执行时机：工作日 09:00`）。
但在工程落地中，隐藏着一个极其严重的**跨时区计算断层**：

#### 1. 偏差根因剖析

- 前端解析器 `workflowScheduler.ts:567-610`：
  前端根据字符串硬编码解析：`0 9 * * 1-5` -> `工作日 09:00`。在用户心智中，这个 `09:00` 毫无疑问是指**本机本地时区**（如 `Asia/Shanghai` 的 09:00）。
- 前端数据下发契约 `workflowDraft.ts:462-467`：
  ```typescript
  if (draft.scheduleType === 'cron') {
    const expr = String(draft.cronExpression ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    return { type: 'cron', expression: expr || '0 9 * * *' };
  }
  ```
  **注意：下发给 Rust 的载荷中，完全缺失了时区标识！** 对比 `daily` 模式下发了 `timezone: defaultTimezone()`，`cron` 模式只下发了纯表达式字符串！
- 后端 Rust 调度器 `crates/conex-types/src/cron.rs:424-434`：
  ```rust
  #[cfg(windows)]
  fn local_utc_offset_minutes() -> i32 {
      local_offset_via_win32() // 仅在 Windows 编译目标下读取 Win32 本地时区
  }
  #[cfg(not(windows))]
  fn local_utc_offset_minutes() -> i32 {
      0 // 在 Linux / macOS / 容器环境下硬编码为 UTC 0！
  }
  ```
- **后果**：
  当用户在非 Windows 环境、或者运行在 WSL / 远程 Linux 核心上时，由于前端未传递时区，Rust 计算 `next_fire_after` 走 UTC 偏移 0。
  用户在界面上明明看到 `工作日 09:00`，实际却在 UTC 09:00（即北京时间 17:00，下午五点）才触发！整整偏差 8 小时！
- **【必修改进】**：
  `WorkflowScheduleWire::Cron` 必须补齐可选的 `timezone: Option<String>` 字段。前端在 `buildScheduleFromDraft` 时必须下发 `defaultTimezone()`；Rust 侧调用 `next_fire_after_in_offset` 时，优先根据传入的 IANA 时区解析偏移，杜绝多端时区漂移！

#### 2. 人类可读解析器 `cronExpressionLabel` 的模式匹配硬编码漏洞

阶段 5 方案中的 `cronExpressionLabel` 充斥着大量的全等判断：

```typescript
if (e === '0 9 * * 1-5') return '工作日 09:00';
```

在真实用户输入中：

- `0 09 * * 1-5`（小时前导 0）
- `0 9 * * 1,2,3,4,5`（等价的工作日写法）
- `*/10 9-18 * * 1-5`（工作日 9-18 点每 10 分钟）
  以上合法表达式全部会命中失败，直接回退为冷冰冰的原始字符串 `0 09 * * 1-5`，徽标失去人性化引导价值。
  **【建议改进】**：在实现中吸纳成熟的分段解释器逻辑（先解析 minute，再解析 hour，再解析 dow），不要只依赖静态字符串 `===` 匹配。

### 3.2 致命安全隐患：移除强行覆写 `cwd` 后，`run_launch.rs` 的危险降级

阶段 5 方案做出了一个非常优秀的改动：彻底清退了 `WorkflowForm.tsx:267` 中暴力篡改 `draft.cwd` 的 `useEffect`，并在项目下拉框中提供了“全局 / 不限项目（任何工作区均可执行）”（下发 `cwd: None`）。

**但是，前端方案完全没有审查上游 Rust 执行引擎对 `cwd: None` 的降级实现！**

我们查看 `apps/agent-workbench/src-tauri/src/run/run_launch.rs:132-135`：

```rust
pub(crate) fn resolve_run_workspace_root(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}
```

#### 致命破坏场景穿透：

1. 用户创建了一个全局定时任务：“每天凌晨自动执行 git clean 清理临时未跟踪文件”；
2. 用户选择了“全局 / 不限项目”，`cwd` 存为 `None`；
3. 到期触发时，`resolve_run_workspace_root(None)` 执行，降级为 `std::env::current_dir()`；
4. 在 Tauri 桌面客户端中，当前工作目录通常是：
   `C:\Users\orange\AppData\Local\Programs\conex\` 或应用工程主目录！
5. Agent 在此目录下执行 `shell(git clean -fdx)` 或 `write_to_file`；
6. **灾难发生**：Agent 直接对 Conex 软件安装包或工程本体执行了清理，导致客户端核心动态链接库或源码被批量删除，客户端瞬间崩溃暴毙！

- **【必修改进】**：
  方案必须刚性确立**全局定时任务的根路径降级策略**：
  当 `cwd == None` 时：
  - 严禁盲目降级到 `current_dir()`；
  - 必须降级到专用的受隔离沙箱目录（例如用户的缓存临时目录 `~/.conex/global-sandbox/` 或明确提示为用户主目录 `dirs::home_dir()`）；
  - 工具层对全局任务的 `shell` 和写文件操作强制开启安全白名单，禁止在全局任务中执行未指定绝对路径的高危递归清理命令！

---

## 四、0ms 乐观更新与 2000ms 保护窗口审查（State Machine & Lock Consistency）

阶段 5 方案为了消灭旧版本“整屏 busy 假死”和“点击开关后瞬间回弹”，设计了：

- 细粒度行锁：`togglingIds: Set<string>`；
- Epoch 保护锁：`optimisticLocks: Map<string, { enabled: boolean; expireAt: number }>`（2000ms 窗口）。

这个设计大方向非常正确，但其中的状态机转换存在**三处致命的 React / 异步竞态漏洞**：

### 4.1 React 不可变性陷阱（Immutable State Trap）

在阶段 5 方案的时序图与伪代码中写道：

```typescript
Hook->>Hook: togglingIds.add(w.id); // 锁定当前行
// ...
Hook->>Hook: togglingIds.delete(w.id);
```

**严重警告**：如果开发人员在 `useWorkflowsState.ts` 中使用 `const [togglingIds, setTogglingIds] = useState(new Set())`，然后直接调用 `togglingIds.add(w.id)`：
在 React 中，这是**原位突变（In-place mutation）**！对象的引用地址没有变，React 不会触发重新渲染！
结果：Switch 组件上的 `disabled={isItemToggling}` 根本不会生效，行锁形同虚设！用户依旧可以在几毫秒内疯狂连续点击！

- **【代码规范要求】**：
  必须在方案中明确声明使用不可变拷贝：
  ```typescript
  setTogglingIds((prev) => new Set(prev).add(w.id));
  setTogglingIds((prev) => {
    const next = new Set(prev);
    next.delete(w.id);
    return next;
  });
  ```

### 4.2 快速连续点击（Flapping）下的乱序 IPC 与 Epoch 竞态

考虑以下真实的高频操作场景：

1. 用户误触了开关，将任务从 `启用` 拨到 `暂停`；
2. 50ms 内 IPC 成功返回，`togglingIds.delete(w.id)` 释放行锁，同时 `optimisticLocks` 记录 `{ enabled: false, expireAt: now + 2000 }`；
3. 用户意识到点错了，立即在 200ms 后再次点击开关，试图将其切回 `启用`；
4. 第二次请求发起，`handleToggle` 将状态再次乐观翻转为 `enabled: true`，并将锁更新为 `{ enabled: true, expireAt: now + 2200 }`；
5. **但是**，第一次操作在 Rust 后端激发的异步广播事件 `workflow:updated(enabled: false)` 经过 Tokio 任务调度与 Webview 事件桥，由于微任务排队，**在第 250ms 刚刚到达前端**！
6. 前端监听到事件，触发 `debouncedRefresh()`；
7. 此时 `reconcileWorkflows` 执行：
   虽然 `optimisticLocks` 存着 `enabled: true`，但如果第二次 IPC 请求恰好因为网络抖动失败了，或者如果多个并发请求到达后端的顺序在操作系统层面发生交错：
   界面的状态机将陷入“闪烁震颤”（Flapping）。

- **【必修改进】**：
  粗暴的单时间戳 `expireAt` 不足以应对连续快速切换。应当为每次操作引入**单调递增的代际序列号（Epoch Sequence ID）**：
  每次 `handleToggle` 时 `epochSeqRef.current++`；
  锁结构记录 `{ enabled, expireAt, seq }`；
  只有当返回或广播的数据代际 `seq >= lock.seq` 时才允许解除保护，彻底杜绝历史残留包反向覆盖。

### 4.3 断网 / 异常回滚链路的刷新毒化

在阶段 5 方案中：

```typescript
} catch (e) {
  // 状态回滚
  workflows.map(item.id === w.id ? { ...item, enabled: !optimisticState } : item);
  optimisticEpochLock.delete(w.id);
  togglingIds.delete(w.id);
  Toast("更新失败");
}
```

**隐蔽漏洞**：
如果 IPC 调用超时报错了，前端回滚到了初始状态并删除了 `optimisticEpochLock`。
但在 IPC 超时之前，由于用户点击，Hook 内部或者事件总线可能已经调度了一个 `setTimeout(refresh, 100)`。
在错误回滚发生后的第 50ms，这个延迟的 `refresh()` 发出请求并拉取到了后端的数据。由于后端此时还未处理该失败请求，或者由于断网返回了陈旧缓存，界面刚弹回正确状态，又被这个排队的 `refresh()` 再次冲刷！

- **【必修改进】**：
  在 `catch` 块中执行回滚后，必须强制中止（cancel）所有挂起的 `debouncedRefresh` 计时器，确保回滚状态的纯洁性。

---

## 五、被忽视的工作量、性能损耗与规格模糊项（Gaps & Verification Matrix）

经过对前端全局组件树的扫描，本审查官发现以下四项**被方案严重低估或完全遗漏的工作量**：

### 5.1 侧栏会话时钟徽标的性能开销：O(N) 遍历与长列表重渲染风暴

阶段 3 方案要求：在 `SessionRow.tsx` 中根据任务绑定状态展示时钟徽标 ⏰。

#### 性能测算：

- 用户的侧边栏通常积累有 **50–200 个历史会话**；
- `SessionRow` 虽包裹了 `memo`，但它的属性依赖如果发生变化就会重绘；
- 如果每个 `SessionRow` 在渲染时都执行：
  `workflows.filter(w => w.targetSessionId === s.id)`；
  在 100 个会话的列表下，每帧需要执行 `100 * M` 次字符串匹配；
- 每次有定时任务触发、状态更新或定时轮询，`workflows` 数组发生引用变更；
- **全量 100 个 `SessionRow` 瞬间全部触发重渲染！** 这会导致侧边栏滚动出现肉眼可见的掉帧卡顿。

#### 【必修架构设计】：

**绝对严禁**在 `SessionRow` 中直接消费全局 `workflows` 列表！
必须建立**轻量级会话时钟哈希表（Session Clock Badge Store）**：

```typescript
// 维护极简的轻量映射：Map<SessionId, { count: number, names: string[] }>
export const useSessionScheduleBadges = create(...)
```

`SessionRow` 仅通过选择器订阅自己 `s.id` 对应的徽标信息：
`const badge = useSessionScheduleBadges(s => s[sessionId]);`
当 `workflows` 发生变化时，由全局 Listener 计算出 Diff，**仅局部通知真正受到影响的那 1~2 个 `SessionRow` 重渲染**，其余 99 个会话 0 消耗！

### 5.2 窄屏侧栏布局空间拥挤与 CSS 截断破坏

查看 `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css`：
侧栏会话项的高度锁死在 `SIDEBAR_SESSION_ROW_HEIGHT = 28px`。
尾部 `sessionTrailing` 区域容纳了：

1. `SessionRowTime`（时间文字，宽约 36px）；
2. 更多操作按钮 `sessionActionsBtn`（宽 24px）。
   当插入时钟徽标（16px + 4px margin）后：
   尾部固定宽度从 60px 暴增至 80px！
   在侧栏被用户拖拽收窄至 220px 时，左侧的会话标题只剩下不足 100px 宽度，会导致文字被截断得支离破碎。

- **【必修样式重构】**：
  必须制定明确的 CSS 响应式规则：
  - 常态下显示时钟徽标与时间；
  - 当鼠标 `hover` 该行时，更多操作按钮浮现，此时时钟徽标平滑隐藏或折叠，或者时间隐藏换为操作区，**严禁多元素无序挤压导致会话标题宽度塌陷**。

### 5.3 快速控制抽屉（`ScheduleDrawer`）的设计真空

阶段 3 方案提出了“点击时钟徽标滑出快速控制抽屉”，但翻遍阶段 3 和阶段 5 方案，**完全没有该抽屉的具体规格说明**：

- 它是一个全局单例 Modal？还是挂载在侧栏内部的 Drawer？还是类似 Popover 的悬浮菜单？
- 它的关闭手势是什么（点击遮罩、Esc、失焦）？
- 它的 Props 接口和类型定义完全缺失。
  如果不给出明确定义，开发人员在 Wave 4 实施时必然会各自为政，写出不符合设计系统的临时弹窗。

### 5.4 Vitest 测试成本严重低估

方案声称只需跑通既有的测试即可。但经审查：

- `WorkflowForm.test.tsx` 现有测试只覆盖了 `daily` 和 `manual`，**完全没有 5 字段 Cron 输入、非法表达式红标校验、预设芯片点击填充、以及执行目标单选的测试**；
- `useWorkflowsState.test.ts` **完全没有覆盖 0ms 乐观翻转、2000ms 保护期过滤旧数据、IPC 失败精准回滚、以及断网超时的测试用例**；
- 这些单测的编写与 Mock 调试至少需要 **2 个工作日**的纯工程投入，必须在计划中为 Wave 4 留足测试编写配额。

---

## 六、建设性改进方案与落地架构设计（Actionable Architecture Improvements）

针对上述审查发现的致命硬伤与工程断层，本审查官提出以下 5 项极具可行性、架构优雅的建设性改进方案：

### 建议一：会话时钟徽标轻量级选择器架构（解决侧栏重渲染风暴）

在前端状态层新增派生索引 Store（`sessionScheduleStore.ts`），将大数组转换为 O(1) 查找的字典：

```typescript
// apps/crish-desktop/src/store/sessionScheduleStore.ts
import { create } from 'zustand';
import type { WorkflowDefinition } from '../api/workflowApi';

export interface SessionScheduleBadgeInfo {
  count: number;
  taskNames: string[];
  hasRunning: boolean;
}

interface SessionScheduleState {
  badgeMap: Record<string, SessionScheduleBadgeInfo>;
  updateFromWorkflows: (workflows: WorkflowDefinition[]) => void;
}

export const useSessionScheduleStore = create<SessionScheduleState>((set) => ({
  badgeMap: {},
  updateFromWorkflows: (workflows) => {
    const nextMap: Record<string, SessionScheduleBadgeInfo> = {};
    for (const w of workflows) {
      if (w.enabled !== false && w.targetSessionId) {
        const sid = w.targetSessionId;
        if (!nextMap[sid]) {
          nextMap[sid] = { count: 0, taskNames: [], hasRunning: false };
        }
        nextMap[sid]!.count += 1;
        nextMap[sid]!.taskNames.push(w.name);
      }
    }
    set({ badgeMap: nextMap });
  },
}));
```

在 `SessionRow.tsx` 中精细化订阅：

```tsx
// 仅订阅自身 session_id，其他会话变化绝对不触发当前行 render！
const scheduleBadge = useSessionScheduleStore(
  useCallback((state) => state.badgeMap[s.id], [s.id])
);
```

### 建议二：Tiptap 编辑器与流式渲染树解耦隔离设计（彻底根治打字跳光标）

在 `TiptapEditorField.tsx` 中为外部 `content` 注入设置**输入感知锁（Typing Sentinel）**：

```typescript
// 1. 记录最后一次用户主动输入的本地时间戳
const lastUserInputTimeRef = useRef<number>(0);

const handleLocalInput = () => {
  lastUserInputTimeRef.current = Date.now();
};

// 2. 在 content 同步 effect 中增加阻断断言
useEffect(() => {
  if (!editor || content === undefined) return;

  // 核心守卫：若用户当前正聚焦在输入框打字（300ms 阈值内），
  // 绝对坚决禁止外部 props 调用 setContent！直接采信本地 ProseMirror 文档！
  const isActivelyTyping =
    editor.isFocused && Date.now() - lastUserInputTimeRef.current < 300;
  if (isActivelyTyping) {
    return;
  }

  if (content === lastContentRef.current) return;

  const rafId = requestAnimationFrame(() => {
    if (!editor || editor.isDestroyed) return;
    try {
      const doc = parseFromMarkdown(content);
      editor.commands.setContent(doc);
    } catch {}
    lastContentRef.current = content;
  });
  return () => cancelAnimationFrame(rafId);
}, [editor, content]);
```

### 建议三：全局任务的受隔离 Scratch 沙箱降级策略（根治系统目录误删隐患）

重构 `apps/agent-workbench/src-tauri/src/run/run_launch.rs` 中的 `resolve_run_workspace_root`：

```rust
pub(crate) fn resolve_run_workspace_root(cwd: Option<&str>) -> PathBuf {
    match cwd {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
        _ => {
            // 绝不使用 std::env::current_dir()！
            // 降级为用户家目录下的安全受控 scratch 空间
            let global_sandbox = dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".conex")
                .join("global-workspace");
            let _ = std::fs::create_dir_all(&global_sandbox);
            global_sandbox
        }
    }
}
```

并且在 `ScheduledExecutionContext` 中明确标记 `is_global_task: bool`，在工具层（`crates/agent-tools`）对全局任务的破坏性命令进行严格审计。

### 建议四：确定性代际令牌乐观锁模型（解决 Flapping 快速双击竞态）

在 `useWorkflowsState.ts` 中升级 Epoch 保护机制：

```typescript
interface OptimisticLockRecord {
  enabled: boolean;
  expireAt: number;
  generation: number; // 代际令牌
}

const currentGenRef = useRef<number>(0);
const optimisticLocksRef = useRef<Map<string, OptimisticLockRecord>>(new Map());

const handleToggle = async (w: WorkflowDefinition) => {
  const nextGen = ++currentGenRef.current;
  const targetEnabled = w.enabled === false;

  // 1. 0ms 乐观更新（不可变更新 Set）
  setTogglingIds((prev) => new Set(prev).add(w.id));
  optimisticLocksRef.current.set(w.id, {
    enabled: targetEnabled,
    expireAt: Date.now() + 2000,
    generation: nextGen,
  });
  setWorkflows((prev) =>
    prev.map((item) =>
      item.id === w.id ? { ...item, enabled: targetEnabled } : item
    )
  );

  try {
    const res = await updateWorkflow(w.id, { enabled: targetEnabled });
    if (!res.ok) throw new Error(res.error);

    // 成功后，仅当代际匹配时才就地校准
    const currentLock = optimisticLocksRef.current.get(w.id);
    if (currentLock && currentLock.generation === nextGen) {
      optimisticLocksRef.current.delete(w.id);
    }
  } catch (err) {
    // 失败回滚：仅当代际匹配时才回滚（防后到旧失败覆盖新成功）
    const currentLock = optimisticLocksRef.current.get(w.id);
    if (currentLock && currentLock.generation === nextGen) {
      optimisticLocksRef.current.delete(w.id);
      setWorkflows((prev) =>
        prev.map((item) =>
          item.id === w.id ? { ...item, enabled: !targetEnabled } : item
        )
      );
    }
    toast.error('状态切换失败');
  } finally {
    setTogglingIds((prev) => {
      const next = new Set(prev);
      next.delete(w.id);
      return next;
    });
  }
};
```

### 建议五：Cron 下发全链路补齐显式时区（消除 8 小时触发偏差）

1. **前端契约**：在 `workflowDraft.ts:462` 的 `buildScheduleFromDraft` 中，为 `cron` 分支补齐 `timezone`：
   ```typescript
   if (draft.scheduleType === 'cron') {
     return {
       type: 'cron',
       expression: expr || '0 9 * * *',
       timezone: defaultTimezone(), // 显式下发当前时区，如 "Asia/Shanghai"
     };
   }
   ```
2. **后端契约**：在 `WorkflowScheduleWire` 中将 `Cron` 声明为：
   ```rust
   Cron { expression: String, timezone: Option<String> }
   ```
3. **计算调用**：在调用 `next_fire_after` 时，优先根据 `timezone` 解析偏移，跨端行为 100% 确定一致。

---

## 七、审查总结与放行验收断言矩阵（Sign-off Matrix）

综合以上深度审查，本审查官对战役进入实施阶段给出**正式审查意见书**：

### 7.1 必须建立的前端交互门禁断言（Frontend Hardening Gates）

在 Wave 4 宣布完工并交付前，除原方案规划的常规门禁外，必须百分之百通过以下**5 项端到端人机交互极端场景实测**：

```powershell
# 1. 验证受控表单 Cron 双态徽标、时区回填与全局 CWD 校验
npx vitest run apps/crish-desktop/src/components/settings/WorkflowForm.test.tsx

# 2. 验证 0ms 乐观更新、行锁不可变性、代际防反弹与错误回滚
npx vitest run apps/crish-desktop/src/components/settings/useWorkflowsState.test.ts

# 3. 验证当前会话流式打字与 Tiptap 输入法打字并发不掉字、不跳光标专项测试
npx vitest run apps/crish-desktop/src/components/chat-composer/TiptapComposerField.test.tsx
```

| 门禁编号      | 极端测试场景                      | 预期断言与验收标准（Hard Assertion）                                                                                                        |
| :------------ | :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| **TC-INT-01** | **流式 Token 暴风雨下中文打字**   | 在绑定当前会话的定时任务流式输出期间（每秒 30+ Token），在输入框连续键入中文拼音，**拼音选词框不崩溃、光标位置不移动、输入文本 0 丢失**。   |
| **TC-INT-02** | **Switch 200ms 快速连续点击翻转** | 模拟用户在 2 秒内对同一行 Switch 快速连击 3 次，**界面不出现死锁、行锁正常释放、最终状态与最后一次点击意图绝对一致**。                      |
| **TC-INT-03** | **被绑定会话删除后定时到期**      | 创建绑定会话的定时任务，删除该会话后触发任务，**侧栏不出现复活的空会话，任务自动转为后台执行并在日志留下可查记录**。                        |
| **TC-INT-04** | **跨时区 Cron 触发与标签验证**    | 配置 `0 9 * * 1-5`，无论宿主处于何种操作系统，**人类可读徽标与计算出的 `next_fire_at` 严格对应本机本地时区的 09:00，绝不出现 8 小时漂移**。 |
| **TC-INT-05** | **全局任务 CWD 降级安全边界**     | 配置“全局 / 不限项目”任务并执行文件列出/创建，**文件绝对不会写进应用程序根目录，`current_dir` 保持绝对纯净**。                              |

---

### 首席审查官签字（Sign-off）

- **审查结论**：方案基础扎实、根因定位精确；上述提出的 5 项交互防御加固建议具有高度可操作性，已给出了确切的代码级改造方案。
- **实施准入**：**批准进入 Wave 1 ~ Wave 4 实施阶段**，要求研发团队在推进至 Wave 4 前端阶段时，严格将本审查报告中的防御方案作为强制落地规约！
