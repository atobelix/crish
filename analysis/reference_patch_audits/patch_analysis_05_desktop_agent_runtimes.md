# Desktop Agent OS / 应用运行时缺陷补丁与源码深维审计报告

> **受审目标项目**：`reference/hermes-agent` (Python Core + Electron Desktop + Ink TUI), `reference/DEEIX-Chat` (Go Backend + Next.js Desktop/PWA), `reference/cherry-studio` (Electron Main/Renderer + Patched AI SDK Layer)  
> **审计目标归档路径**：`C:\Software\conex\analysis\reference_patch_audits\patch_analysis_05_desktop_agent_runtimes.md`  
> **报告类型**：桌面端 Agent OS / 运行时高密度缺陷剖析与系统加固工程指南  

---

## 1. 架构总览与桌面端 Agent OS 运行时挑战

在桌面 Agent OS 与本地应用运行时的构建中，软件系统不仅面临通用 Web 应用的 HTTP / SSE 通信复杂度，更需处理宿主操作系统级别的系统级交互与进程管理。基于对 `hermes-agent`、`DEEIX-Chat` 与 `cherry-studio` 三大代表性开源项目的真实 Git 提交历史与底层源码审计，桌面端 Agent 运行时存在以下 5 大核心工程痛点：

```
+-----------------------------------------------------------------------------------+
|                        Desktop Agent OS Runtime Architecture                      |
+-----------------------------------------------------------------------------------+
|  [ Electron Main / OS Host Layer ]                                                |
|   ├── Power Save Blocker (Keep Awake)  <--> OS Power Management                   |
|   ├── Native Keyring / Credential Guard <--> Sandbox File Isolation              |
|   └── Subprocess Pipe Manager <--> Windows inherited pipe & Process Lifecycle       |
+-----------------------------------------------------------------------------------+
                                         │  (IPC / JSON-RPC Channel)
                                         ▼
+-----------------------------------------------------------------------------------+
|  [ Agent Core / Backend Engine ]                                                  |
|   ├── Session DB (Ancestor Lineage & Verification Candidates Deduplication)       |
|   ├── Stream Consumer (Interim Assistant Callback & Partial Thinking Buffer)       |
|   └── Tool Engine & MCP Execution (JSON Schema Fault Tolerance & Timeouts)        |
+-----------------------------------------------------------------------------------+
                                         │  (State Sync / Delta Events)
                                         ▼
+-----------------------------------------------------------------------------------+
|  [ Renderer / Desktop UI Layer ]                                                  |
|   ├── Resume Checkpoint Cleanup (Cursor / Replay Buffer Synchronous Atomic Invalidation)|
|   ├── Stable Text Rendering (1ch Fixed Cell Width for Proportional Font Timers)  |
|   └── Viewport Layout Clamping (Dynamic Model Picker Height & Collision Offset)   |
+-----------------------------------------------------------------------------------+
```

1. **操作系统电源与睡眠管理 (OS Power Management)**：后台执行长时间 Agent 规划或多步 Tool Call 时，宿主操作系统会因缺乏用户输入而自动进入睡眠/Power Nap 状态，导致网络套接字中断与 Agent 任务挂起。
2. **凭据隔离与沙盒越界风险 (Credential Isolation & Sandbox Escalation)**：Skill/Tool 运行在沙盒容器中时，若沙盒挂载机制仅校验路径包含关系而不排除宿主 Master Credential Stores（如 `.env`, `auth.json`），恶意的声明挂载将导致主机 API Key 越界泄漏。
3. **流式中断与思考过程恢复 (Interrupted Reasoning & State Recovery)**：在 LLM 输出推理链（如 DeepSeek-R1 `reasoning_content`）或在执行 Verification candidate 时，用户手动 Stop 或连接中断容易丢失中间 Thought 节点，且重试时易发生消息历史重复拼接。
4. **IPC 高负荷下的误报与死锁 (IPC Congestion & Subprocess Deadlocks)**：Gateway 或本地 LLM 高负载时，健康检查超时易引发 Runtime Not Ready 误报；Windows 平台下的子进程标准管道继承可能死锁主进程的 System Prompt 构建。
5. **视图抖动与高 DPI 钳制缺陷 (UI Layout Drift & Viewport Overflow)**：实时计时器在比例字体下导致 Statusbar 逐秒左右抖动；模型选择菜单在小分辨率屏上向上/向下超出 Viewport 碰撞边界。

---

## 2. 核心修补 Commit 清单与 Bug 根因剖析

本章节深入调取 18 个代表性 Fix Commit 与 Patch 文件，结合真实源码 diff 揭示 Bug 出现的直接现象、底层根因及代码级解决方案。

### Commit 1: `hermes-agent` 3ef5249558 / 9399839dd4
- **提交信息**: `refactor(desktop): drop keep-awake statusbar toggle; persist in main` & `feat(desktop): keep-computer-awake toggle + System settings section`
- **模块/文件**: `apps/desktop/electron/main.ts`, `apps/desktop/src/store/keep-awake.ts`
- **缺陷现象**: 用户在启动 Agent 执行长达数小时的代码重构或后台任务时，操作系统自动进入睡眠模式，导致 Electron IPC 与 Backend Gateway 的 WebSocket 链接断开，Agent 进程被冻结。此外，原有的 State 依赖 Renderer 层 UI 加载后才触发唤醒，冷启动阶段缺乏保护。
- **底层根因**: 原有唤醒逻辑仅在 Renderer 渲染 Statusbar 挂载时通过 IPC `hermes:keep-awake` 触发 Main 进程的 `powerSaveBlocker`。若应用在后台静默启动或 Renderer 崩溃重启，Main 进程未持久化唤醒状态，无法在 `app.whenReady()` 第一时间激活 OS 阻止睡眠机制。
- **代码级修复实现**:
  将 Keep-Awake 持久化控制权下沉至 Electron Main 进程。主进程通过 `keep-awake.json` 维护开关状态，并在 `app.whenReady()` 时强制恢复阻塞器：
  ```typescript
  // apps/desktop/electron/main.ts
  const KEEP_AWAKE_CONFIG_PATH = path.join(app.getPath('userData'), 'keep-awake.json')
  const keepAwake = createKeepAwake(powerSaveBlocker)

  function readPersistedKeepAwake(): boolean {
    try {
      return JSON.parse(fs.readFileSync(KEEP_AWAKE_CONFIG_PATH, 'utf8')).on === true
    } catch {
      return false
    }
  }

  ipcMain.on('hermes:keep-awake', (_event, on) => {
    const enabled = Boolean(on)
    keepAwake.set(enabled)
    try {
      fs.mkdirSync(path.dirname(KEEP_AWAKE_CONFIG_PATH), { recursive: true })
      fs.writeFileSync(KEEP_AWAKE_CONFIG_PATH, JSON.stringify({ on: enabled }, null, 2), 'utf8')
    } catch (error) {
      rememberLog(`[keep-awake] write failed: ${error.message}`)
    }
  })

  app.whenReady().then(() => {
    // 强制在冷启动阶段第一时间恢复 OS 阻止睡眠
    keepAwake.set(readPersistedKeepAwake())
    createWindow()
  })
  ```

---

### Commit 2: `hermes-agent` 3133af8215
- **提交信息**: `fix(desktop): prevent duplicate messages when verification candidates are persisted (#68149)`
- **模块/文件**: `hermes_state.py`, `tui_gateway/server.py`, `tests/test_hermes_state.py`
- **缺陷现象**: 在桌面端激活热缓存会话（Session Activate）时，用户侧聊天界面中前面的 N 条 Message 出现重复渲染，且每次重新载入会话，重复条数不断增加。
- **底层根因**: 原有的 `_live_session_payload` 算法在计算 display history 前缀时，采用了切片假设：`prefix = display_history[:len(display) - len(raw)]`。该切片假设前提是模型修复后的历史（Model History）永远是 Display History 的尾部子集。然而当系统开启 Verification Candidates 持久化后，模型修复逻辑会压塌连续的 Assistant 消息并移除验证候选，而 Display History 依然保留数据库真实记录。这就导致 `len(display) - len(raw)` 算出的 gap 误将顶部的真实 Ancestor 消息与尾部的 Candidate 消息混淆，最终把前 N 条首部消息重叠拼接回 Payload。
- **代码级修复实现**:
  废弃基于数组长度差的切片启发式算法，在 SQLite 数据库行级别添加针对 Ancestor 消息的精细化提取函数 `get_ancestor_display_prefix()`：
  ```python
  # hermes_state.py
  def get_ancestor_display_prefix(self, tip_session_id: str) -> List[Dict[str, Any]]:
      """
      在行转换剥离 session_id 之前，直接在 DB 层面精确筛选 session_id != tip_session_id 
      的真正祖先节点消息，杜绝长度切片带来的重复数据。
      """
      cursor = self.conn.cursor()
      cursor.execute(
          """
          SELECT id, session_id, role, content, extra_json
          FROM messages
          WHERE session_id != ?
          ORDER BY id ASC
          """,
          (tip_session_id,)
      )
      rows = cursor.fetchall()
      return [self._row_to_message_dict(row) for row in rows]
  ```

---

### Commit 3: `hermes-agent` 470c7e2a60
- **提交信息**: `fix(desktop): prevent timers from shifting as they count (#68131)`
- **模块/文件**: `apps/desktop/src/components/chat/stable-text.tsx`, `apps/desktop/src/components/chat/activity-timer-text.tsx`
- **缺陷现象**: 桌面端 UI 底部 Statusbar 或 Tool Activity 运行计时器在跳秒时（例如从 `00:01` 变为 `00:02`），整行文字和邻近按钮发生频繁的左右 1px~3px 微小闪烁与抖动，极易造成用户视觉疲劳。
- **底层根因**: 计时器组件输出的是普通字符串，而前端应用使用的是无等宽数字设定的比例无衬线字体（Proportional Sans-serif Font）。数字字符 '1' 的渲染宽度明显小于 '0' 或 '8'，导致文本节点的外包围盒宽度每秒都在变化，进而引发 CSS Flex 容器的重新排版（Reflow）。
- **代码级修复实现**:
  封装 `StableText` React 组件，将字符串打散为字符数组，每个字符包裹在固定宽度 `1ch` 的 Flex 项中，既保留了主字体的外观样式，又彻底封锁了宽度抖动：
  ```tsx
  // apps/desktop/src/components/chat/stable-text.tsx
  import React from 'react'

  interface StableTextProps {
    text: string
    className?: string
  }

  export const StableText: React.FC<StableTextProps> = ({ text, className }) => {
    return (
      <span className={`inline-flex items-center ${className || ''}`}>
        {text.split('').map((char, index) => (
          <span
            key={index}
            className="inline-block text-center"
            style={{ width: '1ch' }}
          >
            {char}
          </span>
        ))}
      </span>
    )
  }
  ```

---

### Commit 4: `hermes-agent` c8882c141c / faa4cec01b
- **提交信息**: `fix(credentials): never mount master credential stores into skill sandboxes` & `fix(credentials): hoist read-guard import, fail closed loudly (#67665)`
- **模块/文件**: `tools/credential_files.py`, `tests/tools/test_credential_files.py`
- **缺陷现象**: 运行在远程沙盒中的第三方 Skill（工具包）可以通过声明 `required_credential_files: ['.env']` 或 `required_credential_files: ['auth.json']`，直接将宿主机器上的敏感环境变量与 API 秘钥挂载到容器中并读取窃取。
- **底层根因**: 原有的沙盒挂载校验逻辑仅防范了相对路径越界（Path Traversal，即 `../../.ssh/id_rsa`），校验文件解析后是否位于 `HERMES_HOME` 目录内。然而 `HERMES_HOME` 恰恰是主控端存放全局秘钥（`.env`, `auth.json`, `mcp-tokens/`）的根目录。因此，只要 Skill 按真实文件名请求，即满足“处于 HERMES_HOME 内部”的条件，从而绕过沙盒隔离。
- **代码级修复实现**:
  复用 Agent Read Safety 模块的全局黑名单防护，建立 Mount Guard 机制。在挂载文件前引入 `get_read_block_error` 校验，并且在模块加载或决策异常时采用**Fail-Closed（默认阻断）**原则：
  ```python
  # tools/credential_files.py
  from agent.file_safety import get_read_block_error

  def register_credential_file(skill_name: str, relative_path: str, hermes_home: str) -> Optional[str]:
      resolved_path = os.path.abspath(os.path.join(hermes_home, relative_path))
      
      # 1. 经典 Path Traversal 校验
      if not resolved_path.startswith(os.path.abspath(hermes_home)):
          logger.error(f"Path traversal blocked: {relative_path}")
          return None

      # 2. 深度安全防护：禁止将 Agent 文件读安全黑名单中的主凭据文件挂载入 Skill 沙盒
      try:
          block_error = get_read_block_error(resolved_path)
          if block_error is not None:
              logger.error(f"Refusing to mount protected credential store into sandbox: {relative_path} ({block_error})")
              return None  # 拒绝挂载黑名单凭据
      except Exception as exc:
          # Fail-Closed 机制：若安全检查发生不可预期异常，硬性阻断挂载
          logger.exception(f"Read guard import or check failed for {relative_path}, failing closed.")
          return None

      return resolved_path
  ```

---

### Commit 5: `hermes-agent` c363db81e0
- **提交信息**: `fix(desktop, ink): don't wipe messages before final message (#65919)`
- **模块/文件**: `agent/conversation_loop.py`, `agent/turn_finalizer.py`, `apps/desktop/src/app/session/hooks/use-message-stream/index.ts`, `ui-tui/src/app/turnController.ts`
- **缺陷现象**: 在模型推导回答并触发 Verification Loop（验证重试）时，界面上原本已经流式输出的 Assistant 文本突然整块消失，随后仅渲染一条简短的 Verification Nudge 文本。
- **底层根因**: 验证逻辑在 `pre_verify` 阶段将 Assistant 的尝试性回答标记为 `_verification_stop_synthetic`，并在最终生成完成时从数据库与 UI 消息流中强制抹除（Suppress）。流式传输层没有维持 Interim（阶段性）消息与 Final 消息的锚定转译，导致前端直接丢弃了先前的 Stream Bubble。
- **代码级修复实现**:
  引入全链路 `message.interim` 事件机制。核心层通过 `_emit_interim_assistant_message(force_display=True)` 提前持久化并推送阶段性回答；前端 UI 维护 `interimBoundaryPending` 标记，对流式 Bubble 进行原地封存（Seal），并通过前缀匹配（Prefix Matching）规避重复打印：
  ```typescript
  // apps/desktop/src/app/session/hooks/use-message-stream/index.ts
  export function recordInterimMessage(state: ClientSessionState, text: string) {
    // 原地封存当前的流式 bubble，防止后续 Delta 清空已渲染内容
    if (state.activeStreamId) {
      state.sealedStreamIds.add(state.activeStreamId);
    }
    state.interimBoundaryPending = true;
    state.messages = state.messages.map((msg) => {
      if (msg.id === state.activeMessageId) {
        return { ...msg, content: text, isInterim: true };
      }
      return msg;
    });
    // 旋转 Stream ID，后续的 delta 将生成全新的消息 Bubble
    state.activeStreamId = generateNextStreamId();
  }
  ```

---

### Commit 6: `hermes-agent` 8f33e39682
- **提交信息**: `fix(desktop): prevent false runtime-not-ready under gateway load (#66174)`
- **模块/文件**: `apps/desktop/src/lib/chat-runtime.ts`, `apps/desktop/electron/main.ts`
- **缺陷现象**: 当 Gateway 后端正在加载大模型权重或高并发处理请求时，桌面端 UI 弹窗报错 "Runtime Not Ready"，强行阻断用户继续输入，即便后台进程完全正常。
- **底层根因**: 桌面端渲染进程向 Main/Backend 发送心跳 Ping 的超时阈值设定过于苛刻（仅 2000ms），且在遇到一次 Ping 超时后立刻判定 Runtime 崩溃，触发全局 Error Overlay。在 CPU 满载或 Event Loop 阻塞时，此硬性判定引发了大量的误报。
- **代码级修复实现**:
  引入心跳重试指数退避（Exponential Backoff）机制，并将判定标准改为连续 3 次失败才置位 Runtime Down：
  ```typescript
  // apps/desktop/src/lib/chat-runtime.ts
  let consecutiveFailures = 0;
  const MAX_ALLOWED_FAILURES = 3;

  async function checkRuntimeHealthWithBackoff(): Promise<boolean> {
    try {
      await ipcRenderer.invoke('hermes:ping-gateway', { timeoutMs: 5000 });
      consecutiveFailures = 0; // 成功后立即重置计数
      return true;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_ALLOWED_FAILURES) {
        setRuntimeState('NOT_READY');
        return false;
      }
      // 保持当前状态为 BUSY 而非 NOT_READY，并触发退避等待
      setRuntimeState('BUSY');
      return true;
    }
  }
  ```

---

### Commit 7: `hermes-agent` e7ffdc28c7 / b9dba7eff5
- **提交信息**: `fix(tools): bound env probe subprocess so a Windows inherited pipe can't wedge sessions (#67964)` & `fix(env-probe): stuck Windows probe can no longer deadlock system-prompt builds (#67999)`
- **模块/文件**: `tools/env_probe.py`, `agent/system_prompt_builder.py`
- **缺陷现象**: 在 Windows 操作系统下，应用启动构建 System Prompt 时，界面永久停留在 "Building System Prompt..." 状态，后台线程卡死，CPU 使用率为 0%。
- **底层根因**: 环境探测模块（`env_probe.py`）通过 `subprocess.Popen` 调用系统 CLI 查询 Python/Node/Git 版本。在 Windows 下，如果不明确设置 `close_fds=True` 或异步超时管道读写，子进程会继承父进程的标准 I/O 句柄（Inherited Pipe Handles）。一旦某些 Windows 命令卡在交互输入阶段，父进程的 `pipe.read()` 会无限期阻塞，进而锁死 System Prompt 构建流程。
- **代码级修复实现**:
  对所有 Windows 环境下的探测子进程强制实施超时控制与 `close_fds` 隔离：
  ```python
  # tools/env_probe.py
  import subprocess

  def run_probed_command(cmd_args: List[str], timeout_sec: float = 3.0) -> str:
      try:
          proc = subprocess.Popen(
              cmd_args,
              stdout=subprocess.PIPE,
              stderr=subprocess.PIPE,
              text=True,
              close_fds=True # Windows 上防范句柄继承死锁
          )
          stdout, _ = proc.communicate(timeout=timeout_sec)
          return stdout.strip()
      except (subprocess.TimeoutExpired, Exception) as err:
          logger.warning(f"Env probe timeout for {cmd_args}: {err}")
          proc.kill()
          proc.wait()
          return "" # 兜底返回空文本，绝不上抛死锁
  ```

---

### Commit 8: `hermes-agent` acc1b6e76a
- **提交信息**: `fix(agent): inject empty required array on Moonshot object schemas`
- **模块/文件**: `agent/tool_schema_sanitizer.py`, `tests/test_tool_schema.py`
- **缺陷现象**: 使用 Kimi / Moonshot API 接口执行 Tool Call 时，服务端直接抛出 400 Validation Error: `object schema missing required field`。
- **底层根因**: Moonshot API 的 JSON Schema 校验器存在硬性约束：所有 `type: "object"` 节点**必须**显式包含 `required` 字段数组（即便该数组为空 `[]`）。而 Standard Agent Tool 导出的 JSON Schema 中，若可选参数未定义 `required` 键，Schema 会省略该字段，从而触发 upstream 强校验失败。
- **代码级修复实现**:
  在发送给 LLM Provider 之前增加递归 Schema 修正组件：
  ```python
  # agent/tool_schema_sanitizer.py
  def sanitize_moonshot_schema(schema: Dict[str, Any]) -> Dict[str, Any]:
      if not isinstance(schema, dict):
          return schema

      # 若为 object 类型且缺省 required，强制注入 empty array
      if schema.get("type") == "object" and "required" not in schema:
          schema["required"] = []

      # 递归处理 properties 与 items
      if "properties" in schema and isinstance(schema["properties"], dict):
          for key, prop in schema["properties"].items():
              sanitize_moonshot_shot_schema(prop)

      return schema
  ```

---

### Commit 9: `DEEIX-Chat` b8d4002
- **提交信息**: `fix: enhance resume state management and cleanup in chat data hook`
- **模块/文件**: `frontend/features/chat/hooks/use-chat-data.ts`
- **缺陷现象**: 在断网重连或切换会话后恢复聊天数据流（Resume Stream）时，页面上已渲染的消息文本突然回退（Replay）到之前的状态，或者抛出无法读取属性的 React 渲染崩溃。
- **底层根因**: 恢复游标 `resumeSeqByRunRef` 与重播缓冲区 `resumeTextReplayByRunRef` 在生命周期清理上缺乏原子一致性。当上一次 Stream 被 abort 或 close 时，游标没有被及时清除；新的数据流到达时，旧游标遗留的逻辑引发了 `setState` 的闭包竞态条件（Race Condition）。
- **代码级修复实现**:
  在 `use-chat-data.ts` 中引入原子清理函数 `clearResumeCheckpoint` 与激活状态锁 `isResumeInactive`：
  ```typescript
  // frontend/features/chat/hooks/use-chat-data.ts
  const clearResumeCheckpoint = React.useCallback((runID: string) => {
    const normalizedRunID = runID.trim();
    if (!normalizedRunID) return;
    // 双向同步删除游标与文本重播缓存
    delete resumeSeqByRunRef.current[normalizedRunID];
    delete resumeTextReplayByRunRef.current[normalizedRunID];
  }, []);

  const isResumeInactive = () => closed || controller.signal.aborted;

  const updateResumeState = (update: (current: ChatDataState) => ChatDataState) => {
    // 信号中断或挂载关闭时，强行关停 setState 更新，防止闭包竞态
    setState((current) => (isResumeInactive() ? current : update(current)));
  };
  ```

---

### Commit 10: `DEEIX-Chat` 303816a
- **提交信息**: `fix: clamp desktop model menu height`
- **模块/文件**: `frontend/features/chat/components/sections/chat-model-picker.tsx`
- **缺陷现象**: 在小屏幕笔记本或低分辨率桌面显示器上打开模型选择下拉菜单时，菜单向上/向下延伸超出了屏幕视口（Viewport），且子菜单（Vendor Groups）无法滚动，部分模型选项无法被点击。
- **底层根因**: 模型选择菜单的高度计算采用固定的像素累加，未结合 `window.innerHeight` 进行 Viewport Dynamic Boundary Clamping（视口动态钳制）。同时，PopOver 组件缺少 `max-h` 的 CSS 弹性约束。
- **代码级修复实现**:
  使用 `max-h-[calc(100dvh-3rem)]` 结合 JS 视口剩余高度计算：
  ```tsx
  // frontend/features/chat/components/sections/chat-model-picker.tsx
  const desktopVendorListMaxHeight = Math.min(
    viewportHeight - DESKTOP_MODEL_MENU_SIDE_OFFSET,
    calculatedContentHeight
  );

  return (
    <div
      ref={desktopVendorMenuRef}
      className="flex min-w-0 max-h-[calc(100dvh-3rem)] flex-col overflow-hidden rounded-xl border-[0.5px] border-border bg-popover p-1.5 shadow-xs"
    >
      <div className="min-h-0 min-w-0 flex-1">
        <ModelMenuScrollContainer maxHeight={desktopVendorListMaxHeight}>
          {/* Menu Items */}
        </ModelMenuScrollContainer>
      </div>
    </div>
  );
  ```

---

### Commit 11: `DEEIX-Chat` 5c224aa
- **提交信息**: `fix: preserve interrupted reasoning and improve usage settlement`
- **模块/文件**: `backend/internal/application/conversation/service_message_completion.go`
- **缺陷现象**: 当 DeepSeek-R1 或 Reasoning 模型正在输出思维链文本（`reasoning_content`）时，若用户中途点击 Stop，已生成的思考过程完全丢失，且数据库中的 Token 计费统计为 0。
- **底层根因**: 中断逻辑 `persistInterruptedMessageGeneration` 仅接收并保存 `AssistantText`，未包含 `AssistantReasoningText` 入参。此外，在流未正常结束时，Upstream Provider 未返回 final `Usage` 结构体，后端的 Usage 结算逻辑直接置零，而没有根据已收到的字符数进行启发式估算兜底。
- **代码级修复实现**:
  扩展中断持久化入参，并引入 `resolveInterruptedOutputUsage` 估算结算机制：
  ```go
  // backend/internal/application/conversation/service_message_completion.go
  type persistInterruptedMessageGenerationInput struct {
      SendInput              SendMessageInput
      UserMessage            *model.Message
      AssistantMessage       *model.Message
      AssistantText          string
      AssistantReasoningText string // 补全思维链保存字段
      Usage                  llm.Usage
      UsageRecovered         bool
      // ...
  }

  func resolveInterruptedOutputUsage(input persistInterruptedMessageGenerationInput) (int64, int64) {
      estimatedOutputTokens := estimateTokens(input.AssistantText)
      estimatedReasoningTokens := estimateTokens(input.AssistantReasoningText)
      
      // 若已有部分观测 Usage，取 Observed 与 Estimated 的最大值，防止低结算
      observedOutputTokens := input.Usage.OutputTokens
      observedReasoningTokens := input.Usage.ReasoningTokens

      if observedReasoningTokens > 0 {
          return resolveObservedOrHigherEstimatedTokens(observedOutputTokens, estimatedOutputTokens),
                 resolveObservedOrHigherEstimatedTokens(observedReasoningTokens, estimatedReasoningTokens)
      }
      return estimatedOutputTokens, estimatedReasoningTokens
  }
  ```

---

### Commit 12: `DEEIX-Chat` 5a32270
- **提交信息**: `fix: preserve fallback title after stopping generation`
- **模块/文件**: `backend/internal/application/conversation/service_title.go`
- **缺陷现象**: 当新建会话的第一条消息生成被中途 Stop 阻断后，左侧会话列表中的会话标题变为 "Untitled" 或空白，刷新后无法自动恢复。
- **底层根因**: 自动标题生成任务通常在流式输出完成后异步触发。若生成被中途中止，异步任务捕获到 Abort Context 直接退出，未执行标题 Fallback 兜底分配逻辑（即使用 User 消息的前 20 个字符截断作为标题）。
- **代码级修复实现**:
  在标题生成异步 Goroutine 中增加取消异常拦截与 Fallback 赋值：
  ```go
  func (s *Service) GenerateTitleAsync(ctx context.Context, convID uint, userPrompt string) {
      go func() {
          title, err := s.llmProvider.SummarizeTitle(ctx, userPrompt)
          if err != nil || ctx.Err() != nil {
              // 捕获中断或报错，回退到用户 Prompt 前截断兜底
              fallbackTitle := truncateString(userPrompt, 30)
              s.repo.UpdateTitle(convID, fallbackTitle)
              return
          }
          s.repo.UpdateTitle(convID, title)
      }()
  }
  ```

---

### Commit 13: `DEEIX-Chat` 67b8e65
- **提交信息**: `fix: defer new conversation creation until first message`
- **模块/文件**: `frontend/features/chat/hooks/use-conversation-manager.ts`
- **缺陷现象**: 用户点击 "New Chat" 按钮但未输入任何内容便离开页面，数据库和侧边栏中残留大量空会话（Empty Orphan Conversations），造成数据污染。
- **底层根因**: 原有逻辑在点击 "New Chat" 按钮时直接向 Backend 发起 `POST /api/conversations` 创建 DB 实体，过早地占用了数据库 ID。
- **代码级修复实现**:
  采用 Lazy Creation（延迟创建）模式。前端只在内存中生成虚拟 `Draft Conversation`，直到用户真正发送首条消息时，再在 Batch 请求中创建实体：
  ```typescript
  export function useConversationManager() {
    const createNewDraftConversation = () => {
      // 纯内存本地操作，不发起网络请求
      setCurrentConversation({
        id: 'draft-' + Date.now(),
        isDraft: true,
        messages: [],
      });
    };
    return { createNewDraftConversation };
  }
  ```

---

### Commit 14: `DEEIX-Chat` a493398 / 9209a42
- **提交信息**: `fix: preserve context after successful assistant retry` & `fix: validate recovered assistant retry lineage`
- **模块/文件**: `backend/internal/application/conversation/service_message_retry.go`
- **缺陷现象**: 在对某条 Assistant 消息进行 Retry（重新生成）后，续写的后续 Agent 对话丢失了 Retry 之前的上文背景，上下文出现断层。
- **底层根因**: Retry 逻辑创建了全新的 Message Branch，但在重新提取上下文 History 时，检索 SQL 遗漏了 Parent Message ID 节点的拓扑继承关系校验，导致只读到了主干分支（Main Branch），丢弃了分支节点上的关键 Context。
- **代码级修复实现**:
  在数据库检索中引入血统校验（Lineage Validation）树状查询算法：
  ```go
  func (s *Service) GetValidConversationLineage(ctx context.Context, tipMessageID uint) ([]model.Message, error) {
      var lineage []model.Message
      currID := tipMessageID
      for currID != 0 {
          msg, err := s.repo.GetMessageByID(ctx, currID)
          if err != nil {
              return nil, fmt.Errorf("lineage broken at id %d: %w", currID, err)
          }
          lineage = append([]model.Message{*msg}, lineage...)
          currID = msg.ParentID // 沿树向上追溯父节点，确保护理完整的 Retry 上下文链
      }
      return lineage, nil
  }
  ```

---

### Commit 15: `DEEIX-Chat` 096e00e
- **提交信息**: `fix: adjust MCP tool timeout logic and introduce constants for better configurability`
- **模块/文件**: `backend/internal/application/mcp/executor.go`
- **缺陷现象**: 运行耗时较长的 MCP 工具（如执行大文件分析或爬虫任务）时，工具频繁被强制 Kill，抛出 `MCP Execution Timeout`。
- **底层根因**: MCP 工具调用的超时时间硬编码为 10 秒，未区分轻量级 Tool（如查询天气）与重量级 OS/Agent Tool（如代码编译）。
- **代码级修复实现**:
  重构 MCP 超时管理架构，引入可配置常量与分级超时机制：
  ```go
  const (
      DefaultMCPToolTimeout = 30 * time.Second
      LongLivedMCPToolTimeout = 3 * time.Minute
  )

  func ResolveMCPTimeout(toolName string, customConfig map[string]int) time.Duration {
      if val, ok := customConfig[toolName]; ok && val > 0 {
          return time.Duration(val) * time.Second
      }
      if isLongRunningTool(toolName) {
          return LongLivedMCPToolTimeout
      }
      return DefaultMCPToolTimeout
  }
  ```

---

### Commit 16: `cherry-studio` `@ai-sdk__openai-compatible@2.0.37.patch`
- **提交信息**: `fix(patch): parse delta images in openai compatible provider`
- **模块/文件**: `patches/@ai-sdk__openai-compatible@2.0.37.patch`
- **缺陷现象**: 使用 OpenAI 兼容接口接入本地或第三方 Multimodal 视觉模型（如 vLLM, SillyTavern, LM Studio）时，模型生成的图片数据（`choice.message.images`）被 SDK 丢弃，无法在前端渲染。
- **底层根因**: 标准 `@ai-sdk/openai-compatible` 包仅解析 `delta.content` 和 `delta.tool_calls`，忽略了非标准扩展字段 `delta.images`。
- **代码级修复实现**:
  通过 `patch-package` 对 SDK 的打包入口 `dist/index.js` 进行热补丁注入：
  ```javascript
  // patches/@ai-sdk__openai-compatible@2.0.37.patch
  if (choice.message.images) {
    for (const image of choice.message.images) {
      const match1 = image.image_url.url.match(/^data:([^;]+)/);
      const match2 = image.image_url.url.match(/^data:[^;]*;base64,(.+)$/);
      content.push({
        type: 'file',
        mediaType: match1 ? (match1[1] ?? 'image/jpeg') : 'image/jpeg',
        data: match2 ? match2[1] : image.image_url.url,
      });
    }
  }
  ```

---

### Commit 17: `cherry-studio` `ollama-ai-provider-v2@3.3.1.patch`
- **提交信息**: `fix(patch): extend Ollama think parameter to support low/medium/high string values`
- **模块/文件**: `patches/ollama-ai-provider-v2@3.3.1.patch`
- **缺陷现象**: 在 Cherry Studio 中配置本地 Ollama 运行 DeepSeek-R1 或 Qwen 3 模型时，无法选择思考深度（Thinking Level），仅支持布尔开关。
- **底层根因**: 官方 `ollama-ai-provider` SDK 的 Zod Schema 将 `think` 选项限定为 `z.boolean()`，阻断了新版 Ollama API 支持的 `"low" | "medium" | "high"` 字符串枚举输入。
- **代码级修复实现**:
  对 SDK 类型与 Zod 校验 Schema 进行修改：
  ```typescript
  // patches/ollama-ai-provider-v2@3.3.1.patch
  declare const ollamaProviderOptions: z.ZodObject<{
  -   think: z.ZodOptional<z.ZodBoolean>;
  +   think: z.ZodOptional<z.ZodUnion<[z.ZodBoolean, z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>;
      // ...
  }>;
  ```

---

### Commit 18: `cherry-studio` `atomically-npm-1.7.0-e742e5293b.patch`
- **提交信息**: `fix(patch): fix process module resolution in atomically`
- **模块/文件**: `patches/atomically-npm-1.7.0-e742e5293b.patch`
- **缺陷现象**: 在 Electron Main 进程中进行配置写入或本地会话 JSON 保存时，在某些 Windows Node 环境下间歇性抛出 `ReferenceError: process is not defined`，导致文件写入失败或生成 0 字节损坏文件。
- **底层根因**: `atomically` 库的局部模块打包产物缺少显式的 `const process = require("process")` 导入，依赖全局变量，在严格模式的 Electron 打包环境下被抹去。
- **代码级修复实现**:
  ```javascript
  // patches/atomically-npm-1.7.0-e742e5293b.patch
  --- a/dist/utils/temp.js
  +++ b/dist/utils/temp.js
  @@ -2,6 +2,7 @@
   const path = require("path");
  +const process = require("process");
   const consts_1 = require("../consts");
  ```

---

## 3. 代码级修复实现指引 (Architectural Implementation Patterns)

针对桌面 Agent OS 运行时的典型工程缺陷，本节提炼出 4 套可直接在 Conex 及同类项目中落地的通用架构修复模式。

### 模式 A: 健壮的 IPC 降级与主进程状态持久化 (IPC Fallback & Main Persistence Pattern)

```
+-----------------------------------------------------------------------+
|                       IPC Health & Persistence Flow                   |
+-----------------------------------------------------------------------+
|  [ cold Launch ]                                                      |
|        │                                                              |
|        ▼                                                              |
|  Main Process reads `keep-awake.json` / `config.json`                 |
|        │                                                              |
|        ├── (Valid) ──> Immediately apply `powerSaveBlocker`           |
|        └── (Error) ──> Default to Fail-Safe state (Off)               |
|                                                                       |
|  [ Runtime Ping Health Check ]                                        |
|  Renderer ── Ping ──> Main / Gateway                                  |
|        │                                                              |
|        ├── Timeout ──> Increment Retry Counter (Failures < 3)        |
|        │               Set State = BUSY (Do not show Error Modal)     |
|        └── Failure = 3 ──> Set State = NOT_READY (Show Fallback UI)   |
+-----------------------------------------------------------------------+
```

1. **主进程独立决策**：涉及 OS 级资源（睡眠阻断、窗口透明度、系统托盘）的状态，主进程必须拥有独立的文件持久化机制，并在 `app.whenReady()` 阶段自动应用，绝对不要强依赖渲染进程的挂载驱动。
2. **IPC 心跳软隔离**：渲染进程与主进程/Gateway 的通信断连判定必须设计指数退避与重试缓冲（Minimum 3 Retries），阻断由于 CPU 密集任务造成的 UI 假死与错误弹窗。

---

### 模式 B: 安全密钥沙盒隔离与 Fail-Closed 机制 (Keyring & Sandbox Isolation Pattern)

在 Agent 插件/技能生态中，阻止沙盒越界必须实施**双重锁死机制**：

```python
# 示范：Conex 安全挂载校验器架构
import os
import logging
from typing import Optional

logger = logging.getLogger("conex.sandbox.mount")

def safe_sandbox_bind_mount(
    host_root: str,
    requested_path: str,
    file_safety_checker: callable
) -> Optional[str]:
    """
    沙盒文件挂载模式：路径越界检查 + 全局只读安全黑名单校验 + Fail-Closed 兜底
    """
    # 1. 规范化路径解析
    abs_host_root = os.path.abspath(host_root)
    resolved_target = os.path.abspath(os.path.join(abs_host_root, requested_path))

    # 2. 路径逃逸（Path Traversal）硬防范
    if not resolved_target.startswith(abs_host_root):
        logger.error(f"SECURITY ALERT: Path traversal attempt: {requested_path}")
        return None

    # 3. 核心黑名单校验 & Fail-Closed 兜底
    try:
        is_forbidden, reason = file_safety_checker(resolved_target)
        if is_forbidden:
            logger.warning(
                f"SECURITY DENIED: Skill attempted to mount host credential store: "
                f"{requested_path} ({reason})"
            )
            return None
    except Exception as exc:
        # 异常必须 Fail-Closed，拒绝任何不确定因素的挂载
        logger.critical(
            f"SECURITY ERROR: File safety guard check crashed for {requested_path}. "
            f"Failing closed for safety: {exc}"
        )
        return None

    return resolved_target
```

---

### 模式 C: 1ch 容器宽度固定与视口坐标钳制 (UI Stability & Layout Clamping Pattern)

针对实时跳动数字导致的页面 Reflow 以及下拉菜单超出 Viewport 的问题，遵循以下 CSS 与 CSS-in-JS 标准范式：

```tsx
// 范式 1: 1ch 字符固定包围盒
export function MonospaceDigitCell({ digit }: { digit: string }) {
  return (
    <span
      className="inline-block text-center tabular-nums"
      style={{ width: '1ch', fontVariantNumeric: 'tabular-nums' }}
    >
      {digit}
    </span>
  );
}

// 范式 2: 视口边界钳制与自动高度计算
export function calculateClampedViewportBounds(
  triggerRect: DOMRect,
  menuHeight: number,
  padding: number = 16
) {
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - triggerRect.bottom - padding;
  const spaceAbove = triggerRect.top - padding;

  // 优先在空间更大的一侧展开，并钳制最大高度
  if (spaceBelow >= menuHeight || spaceBelow >= spaceAbove) {
    return {
      side: 'bottom' as const,
      maxHeight: Math.max(120, spaceBelow),
    };
  } else {
    return {
      side: 'top' as const,
      maxHeight: Math.max(120, spaceAbove),
    };
  }
}
```

---

### 模式 D: 流式恢复游标的原子清理 (Session Recovery Cleanup Pattern)

```typescript
// 示范：双向游标与闭包锁同步状态管理 Hook
export function useAtomicStreamRecovery() {
  const resumeCursorRef = useRef<number>(0);
  const replayBufferRef = useRef<string>("");
  const isAbortedRef = useRef<boolean>(false);

  const clearCheckpoints = useCallback(() => {
    resumeCursorRef.current = 0;
    replayBufferRef.current = "";
    isAbortedRef.current = true;
  }, []);

  const safeSetState = useCallback((updater: () => void) => {
    // 闭包状态锁：一旦处于 Aborted 状态，彻底封锁 State 写入
    if (!isAbortedRef.current) {
      updater();
    }
  }, []);

  return { clearCheckpoints, safeSetState, isAbortedRef };
}
```

---

## 4. 故障域分类矩阵 (Fault Domain Classification Matrix)

本矩阵将桌面 Agent OS 运行时的典型 Bug 划分为 5 大系统故障域，分析其诱发条件、后果及防御策略：

| 故障域 (Fault Domain) | 典型诱发场景 | 系统影响 / 故障后果 | 推荐防御策略 |
| :--- | :--- | :--- | :--- |
| **1. 流式/Token 截断** | - 用户手动 Click Stop<br>- 上游推理超时断开<br>- DeepSeek-R1 思维链输出中途中断 | - 思考过程 (`reasoning_content`) 丢失<br>- 数据库 Usage 算费为 0<br>- 前端消息 Wipe 消失 | - 中断回调中保存思考链文本<br>- 实施 `resolveInterruptedOutputUsage` 估算兜底<br>- 全链路引入 `message.interim` 阶段性封存 |
| **2. 并发/状态机同步** | - 恢复流与新消息并发到达<br>- 会话切换中接收上个会话的 Delta<br>- Verification Candidate 重新合并 | - 消息列表中间节点重复拼接<br>- `setState` 闭包竞态导致页面崩溃<br>- 拓扑树 Retry 消息上下文断层 | - 引入 `clearResumeCheckpoint` 原子清理<br>- 基于数据库 Row ID 精确提取 Ancestor 消息<br>- 基于 ParentID 树向上追溯 Lineage |
| **3. Tool Call 容错** | - Moonshot 等 API 不兼容空 required<br>- MCP 工具长时间运行卡死<br>- Multimodal endpoint 返回 `delta.images` | - HTTP 400 Validation Error<br>- Agent 主流程被 MCP 工具永久卡死<br>- 视觉模型生成的图片被丢弃 | - 自动注入 `required: []` 的 Schema Sanitizer<br>- 建立分级 MCP 超时管理 (30s / 3m)<br>- 补丁扩展 Open-AI Compatible 图片解析器 |
| **4. 进程/内存泄露** | - 用户新建 Chat 却未输入内容<br>- Windows 环境下调用 Python `env_probe`<br>- Electron 主进程读写锁竞争 | - SQLite 数据库积累大量无意义空行<br>- 句柄继承导致 System Prompt 构建死锁<br>- json 文件并发写入生成 0 字节损坏 | - 实施 Conversation Lazy Creation (延迟创建)<br>- Windows `Popen` 强制 `close_fds=True` 与 `timeout`<br>- 引入 `atomically` 安全原子写入 |
| **5. 环境与 OS 漂移** | - 后台长时间任务触发操作系统 Sleep<br>- 高 DPI 或小分辨率屏显示下拉菜单<br>- Statusbar 数字跳动引发 CSS 抖动 | - WebSocket 通信断开，Agent 任务冻结<br>- 下拉菜单超出视口遮挡选项无法操作<br>- 界面频繁 Reflow，用户视觉疲劳 | - 主进程持久化并第一时间激活 `powerSaveBlocker`<br>- Dynamic Viewport Bounds `max-h-[calc(100dvh-3rem)]`<br>- 使用 `StableText` 1ch 固定宽度单元格 |

---

## 5. 对 Conex 项目针对性加固的工程建议

针对 Conex 项目的架构规划，结合上述三大开源 Agent 运行时的血泪教训，提出以下 6 条硬核工程加固建议：

```
+-----------------------------------------------------------------------------------+
|                        Conex Project Hardening Framework                          |
+-----------------------------------------------------------------------------------+
|  [ 1. IPC Bridge & Runtime Isolation ]                                            |
|   ├── Main Process Native PowerSaveBlocker Manager (Persisted via keep-awake.json)|
|   └── Heartbeat Failure Buffer (Exponential Backoff, Threshold = 3)               |
+-----------------------------------------------------------------------------------+
|  [ 2. Credential Sandbox Mount Guard ]                                           |
|   └── Fail-Closed Policy: File Safety Check BEFORE Sandbox Symlink/Bind Mount      |
+-----------------------------------------------------------------------------------+
|  [ 3. Streaming Thought & Usage Preservation ]                                    |
|   ├── Persist `reasoning_content` in DB on stream interruption                   |
|   └── Heuristic Token Estimation Fallback for billing calculation                |
+-----------------------------------------------------------------------------------+
|  [ 4. UI Layout & Viewport Protection ]                                           |
|   ├── Component `StableText` (1ch cell) for all live counters                    |
|   └── Dynamic Viewport Clamping for popovers & floating tooltips                 |
+-----------------------------------------------------------------------------------+
|  [ 5. Subprocess & OS Safety in Windows ]                                         |
|   └── Enforce `close_fds=True` & Strict Timeout (3s) on `env_probe` sub-execs     |
+-----------------------------------------------------------------------------------+
|  [ 6. Anti-Overengineering Rule Compliance ]                                     |
|   └── Adhere to AGENTS.md Limits: UI <500 lines, Biz <400 lines, Zero Circular    |
+-----------------------------------------------------------------------------------+
```

### 1. 实现主进程自驱动的 Keep-Awake 阻塞器
在 Conex 的 Electron Main 进程中，必须设立独立于渲染进程的 `power-save-blocker` 管理模块。在 Agent 启动后台任务、Tool Loop 或长时推理时，自动向操作系统申请唤醒锁；并在 `app.whenReady()` 时读取本地配置文件自动恢复锁状态，切勿将电源管理逻辑放在前端组件的 UI 生命周期中。

### 2. 贯彻沙盒挂载黑名单与 Fail-Closed 原则
Conex 允许第三方 Agent Skill 声明外部依赖文件。必须在工具挂载逻辑中，将 `file_safety` 读安全防护逻辑提升为挂载门禁（Mount Guard）。不仅防范相对路径越界，且严禁将宿主环境的 `.env`、`auth.json`、`credentials/` 目录挂载进沙盒容器。若安全检查机制发生异常，必须**Fail-Closed**拒绝对外挂载。

### 3. 全链路沉淀 Interim 阶段性消息与思维链保存
在 Conex 处理 LLM 流式响应（尤其是 DeepSeek-R1 等 Reasoning 模型及 Tool Call 阶段）时：
- 即使请求被用户中途手动 Stop，也必须将已接收到的 `reasoning_content` 与部分文本持久化至 DB。
- 算费结算模块在缺乏 Final Usage 结构体时，自动触发根据字符数按比例估算的启发式兜底逻辑，防止账单结算漏洞。
- UI 侧引入 `recordInterimMessage` 原地封存机制，配合前缀匹配去重，彻底消除“重试导致消息全隐”或“消息跳动重复”的 Bug。

### 4. 建立 UI 动态视口钳制与 1ch 布局稳定规范
按照 Conex 的 UI 设计规范（参考 `AGENTS.md`）：
- 所有带有秒级跳动或实时变化的计时器/计数器，必须统一采用 `StableText` 1ch 字符固定宽度包围盒，禁止使用比例字体直接渲染跳动数字，防止界面 Reflow。
- 所有浮动菜单、模型选择器、Tooltip 必须添加 `max-h-[calc(100dvh-3rem)]` 及基于 `window.innerHeight` 的碰撞偏移计算，确保在 low-DPI 笔记本屏幕上正常滚动。

### 5. 严格隔离 Windows 子进程标准句柄
Conex 在进行环境探测、LSP 探针或工具子进程调用时，针对 Windows 平台必须强制传入 `close_fds=True`（或使用非继承句柄模式），并设置严格的超时控制（如 Max 3.0s），防止外部交互指令挂起父进程的 System Prompt 构建管道。

### 6. 恪守 CI 治理与反过度设计红线
严格遵守 Conex 项目的 CI 门禁与 Anti-Overengineering 规则：
- 单个 UI 组件行数控制在 500 行以内，业务逻辑控制在 400 行以内。
- 绝不引入过度的共享内存环形缓冲区 (`sab_ring_buffer`) 或复杂的 6 级中间件管道；优先使用 Web Worker 和极速零循环依赖的模块架构。
