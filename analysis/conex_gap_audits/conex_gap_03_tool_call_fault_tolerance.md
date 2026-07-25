# Conex 架构差距诊断报告 — Agent 3：Tool Call 容错域

> **审计日期**：2026-07-24  
> **审计 Agent**：Agent 3 (Tool Call 容错域专职审计)  
> **目标代码库**：`packages/agent-runtime` | `packages/agent-daemon` | `packages/protocol` | `packages/shared-types`  
> **参考标杆**：`C:\Software\conex\analysis\reference_patch_audits\` (涵盖 agno, pydantic-ai, crewai, smolagents, cline, claude-code 等 6 份标杆补丁报告)  
> **报告输出路径**：`C:\Software\conex\analysis\conex_gap_audits\conex_gap_03_tool_call_fault_tolerance.md`  
> **架构合规指引**：严格遵循 [AGENTS.md](file:///c:/Software/conex/.agents/AGENTS.md) 及 [ANTI_OVERENGINEERING_GUARDRAILS.md](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md) 中的反过度设计硬性红线。

---

## 概述与诊断元数据

Tool Call（工具调用）是现代 AI Agent 系统的核心交互通道。然而，由于大语言模型（LLM）输出存在天然的不确定性、不同模型 Provider 序列化格式的微小差异、人类交互审批的随机拒绝以及外部 MCP 服务器的不可靠连接，Tool Call 管道极易引发死循环弹窗、响应污染、进程挂起与模型重复报错等崩塌事故。

本报告深入对比分析了 6 份标杆补丁报告（如 `patch_analysis_03_agent_frameworks.md` 中 agno Commit `d21699284` 与 `2594f206c`，`patch_analysis_02_cline_claudecode.md` 等），针对 Conex 现有的 Agent Runtime、Daemon 审批队列及 MCP 适配层进行了全量源码审计。诊断结果表明，Conex 在 Tool Call 参数归一化、人类拒绝意图记忆、空 content 序列化以及 MCP 熔断防护 4 个核心领域均存在重大架构缺陷与真实隐患。

---

## 一、 Zod 工具 Schema 与 Union Input Normalization（参数自动纠偏）

### 1.1 标杆项目补丁经验参照
* **agno Commit `d21699284` (PR #6303)**：LLM 在调用无参工具（如 `get_current_time()`）时，不同 Provider 会输出 `None`、`null`、`{}` 或空数组 `[]`。agno 原代码由于直接执行 `**arguments` 或断言 `isinstance(dict)`，导致 Python 抛出 `TypeError` 崩溃或将 `[]` 误判为非法参数导致死循环。修复方案引入了 Union 参数解包与空数组坍塌归一化。
* **Pydantic-AI Input Coercion**：在 Tool 参数解析层引入宽松类型转换与 Union 预处理，将字符串数字、单元素数组与空值转换为目标 Schema 期望的合规类型。

### 1.2 Conex 现状代码剖析
在 Conex 中，LLM 输出的 Tool Call 参数首先由 Provider 流式解析器提取，再由 `packages/agent-runtime/src/tools.ts` 中的 `repairToolInput` 进行修复。

1. **Provider 层参数解析边界缺陷**：
   - [packages/agent-runtime/src/provider-openai-chat.ts](file:///C:/Software/conex/packages/agent-runtime/src/provider-openai-chat.ts#L128-L131) 中的 `parseArguments` 实现如下：
     ```typescript
     function parseArguments(input: string): any {
       if (!input.trim()) return {};
       try {
         const parsed = JSON.parse(input);
         if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
         return { value: parsed };
       } catch (cause) {
         return { __rawArguments: input, __parseError: cause instanceof Error ? cause.message : String(cause) };
       }
     }
     ```
   - [packages/agent-runtime/src/anthropic-stream-parse.ts](file:///C:/Software/conex/packages/agent-runtime/src/anthropic-stream-parse.ts#L330-L344) 同样使用类似的包装逻辑：
     ```typescript
     function parseArguments(input: string): JsonObject {
       if (!input.trim()) return {};
       try {
         const parsed = JSON.parse(input) as JsonValue;
         if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
           return parsed as JsonObject;
         }
         return { value: parsed as JsonValue };
       } catch ...
     }
     ```
   - **缺陷场景 1**：当 LLM 为无参工具或带可选参数工具输出 JSON 字符串 `"null"` 或 `"[]"` 时，`JSON.parse("null")` 得到 `null`，`JSON.parse("[]")` 得到 `[]`。两者的 `typeof === 'object'` 分别被 `parsed && ...`（`null` 为 falsy）和 `!Array.isArray(parsed)` 拦截，均被包装为 `{ value: null }` 或 `{ value: [] }`。
   - **缺陷场景 2**：当 LLM 输出 `"None"` 或 Python 风格字面量时，`JSON.parse` 失败，返回 `{ __rawArguments: "None", __parseError: "Unexpected token N..." }`。

2. **`repairToolInput` 无法解包 `value: null` / `value: []`**：
   - 深入查看 [packages/agent-runtime/src/tools.ts](file:///C:/Software/conex/packages/agent-runtime/src/tools.ts#L120-L144) 的 `extractToolArgumentObject`：
     ```typescript
     function extractToolArgumentObject(tool: AgentTool, input: JsonObject): JsonObject | undefined {
       ...
       const value = input.value;
       if (!hasSchemaRelevantField(tool, input)) {
         if (isPlainObject(value)) return cloneJsonObject(value);
         if (typeof value === "string") return parseToolArgumentText(value);
       }
       return undefined;
     }
     ```
   - 当 `input` 为 `{ value: null }` 或 `{ value: [] }` 时，`isPlainObject(null)` 和 `isPlainObject([])` 均返回 `false`，`extractToolArgumentObject` 返回 `undefined`！
   - 结果：`input` 保持为 `{ value: null }` 或 `{ value: [] }` 被传给 `validateToolInput` 或底层工具执行函数。如果工具定义要求无参（`{ type: "object", properties: {} }`），校验虽然不会报错，但工具执行逻辑（例如依赖 `Object.keys(input)` 的处理逻辑）会接收到意外的 `value` 键或 `null` 伪参数，触发运行时异常。

3. **缺少 Schema 级 Zod Union Input Normalization 中间件**：
   - Conex 中的 Zod Protocol 校验器（如 [packages/agent-daemon/src/protocol/validators/common.ts](file:///C:/Software/conex/packages/agent-daemon/src/protocol/validators/common.ts#L25)）以及自定义工具输入，直接使用标准 `z.object({...})`，**完全缺乏 `.preprocess()` 或 Union Input Normalization**。
   - 当模型产生类型微小漂移（例如：期望 `number` 但模型传了 `"123"`；期望 `string[]` 但模型传了单字符串 `"main.ts"`；或传了空值 `null` / `undefined` / `""`），Schema 抛出硬性校验失败 `ZodError: Expected array, received string`，直接破坏 Tool Call 执行链条。

### 1.3 代码级修复指引与加固方案

#### 方案 1：加固 `parseArguments` 与 `extractToolArgumentObject`
在 `tools.ts` 中增强 Union Input 提取逻辑，彻底归一化 `null`、`[]`、`"None"` 等垃圾空值：

```typescript
// packages/agent-runtime/src/tools.ts
export function normalizeToolInputObject(input: unknown): JsonObject {
  if (input == null) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input as JsonObject;
  if (Array.isArray(input) && input.length === 0) return {};
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'None' || trimmed === '{}' || trimmed === '[]') {
      return {};
    }
  }
  return { value: input as JsonValue };
}
```

#### 方案 2：提供 Zod Schema Union Normalization 辅助函数
为框架工具和 Daemon 提供通用的 Zod Preprocess 转换工具，支持零代码入侵参数自动纠偏：

```typescript
// packages/shared-types/src/validators/schema-helpers.ts
import { z } from 'zod';

/** 自动纠偏单值到数组的 Zod Union 转换器 */
export function zCoerceArray<T extends z.ZodTypeAny>(elementSchema: T) {
  return z.preprocess((val) => {
    if (val == null) return [];
    if (Array.isArray(val)) return val;
    return [val];
  }, z.array(elementSchema));
}

/** 自动归一空值/None/null 到默认值的 Zod Preprocess */
export function zDefaultEmpty<T extends z.ZodTypeAny>(schema: T, defaultValue: z.infer<T>) {
  return z.preprocess((val) => {
    if (val == null || val === '' || val === 'None' || val === 'null') return defaultValue;
    if (typeof val === 'object' && Object.keys(val as object).length === 0) return defaultValue;
    return val;
  }, schema);
}
```

---

## 二、 人类主动拒绝（Deny）与 `runIntentDenylist` / `retryable: false`

### 2.1 标杆项目补丁经验参照
* **Cline / Claude Code 审批阻断机制**：当人类用户主动点击 "Deny" 拒绝某项敏感工具（如 `rm -rf` 或高危写操作）时，Agent 系统必须：
  1. 记录当前 Run 的 Intent 拒绝黑名单（Denylist）；
  2. 向模型返回 `retryable: false` / `softDeny: true`，明确告之“人类用户已显式拒绝该操作，严禁重复尝试”；
  3. 当模型在后续 Turn 中再次发起相同 Intent 的 Tool Call 时，系统自动拦截并立即返回拒绝结果，**绝对禁止再次向 UI 发起审批弹窗**，防止死循环打扰用户。

### 2.2 Conex 现状代码剖析
在 Conex 的 Daemon 审批管理模块 [packages/agent-daemon/src/daemon-approval-handler.ts](file:///C:/Software/conex/packages/agent-daemon/src/daemon-approval-handler.ts) 中：

1. **完全缺失 `runIntentDenylist`**：
   - 检查 `DaemonApprovalHandler` 的成员变量（[L18-L20](file:///C:/Software/conex/packages/agent-daemon/src/daemon-approval-handler.ts#L18-L20)）：
     ```typescript
     export class DaemonApprovalHandler {
       /** runId → 已批准的 intentKey 集合 */
       private static readonly runIntentAllowlist = new Map<string, Set<string>>();
       /** 跨 run 的 always 意图放行（approve-tool scope=always） */
       private static readonly alwaysIntentAllowlist = new Set<string>();
     ```
   - **重大缺陷**：代码中仅定义了 `runIntentAllowlist` 和 `alwaysIntentAllowlist`，**没有任何 `runIntentDenylist`！**

2. **拒绝决策处理缺失记忆逻辑**：
   - 查看 [L193-L229](file:///C:/Software/conex/packages/agent-daemon/src/daemon-approval-handler.ts#L193-L229) 的 `decisionFromResult`：
     ```typescript
     if (result.decision === "approved") {
       let set = DaemonApprovalHandler.runIntentAllowlist.get(runId);
       if (!set) {
         set = new Set();
         DaemonApprovalHandler.runIntentAllowlist.set(runId, set);
       }
       set.add(intentKey);
       ...
       return { behavior: "allow", ... };
     }

     // 拒绝或超时分支：
     const expired = result.decision === "expired";
     return {
       behavior: "deny",
       reason: expired ? "Approval timed out..." : (result.reason ?? "Denied"),
       metadata: { approval: approvalMeta, softDeny: expired, intentKey, trustZone: zone }
     };
     ```
   - **致命漏洞**：当 `result.decision === "denied"`（即用户主动点击 UI 上的拒绝按钮）时，`DaemonApprovalHandler` 既不记录 `intentKey` 到黑名单，也不在返回的决策中设置 `retryable: false`！

3. **无限重复弹窗死循环（Modal Re-prompting Loop）**：
   - 当 LLM 接收到工具执行失败（`Permission error: Denied`）后，如果不具备自我纠错意图，极可能在下一个 Turn 中再次发出**完全相同**的 Tool Call（如 `shell_command(cmd="git push -f")`）。
   - 由于 `intentKey` 没有存在于 `runIntentAllowlist` 中，`DaemonApprovalHandler.requestApproval()` 再次进入 [L85](file:///C:/Software/conex/packages/agent-daemon/src/daemon-approval-handler.ts#L85)：
     `await this.approvalQueue.waitForApproval(...)`
   - **用户体验灾难**：UI 前端再次弹窗询问用户！如果用户再次点击 Deny，模型再次重试，导致**用户被无限重复弹窗轰炸**，整个 Agent 挂起在死循环中。

4. **Runtime 工具输出缺失 `retryable: false` 标记**：
   - 检查 [packages/agent-runtime/src/runtime-helpers.ts](file:///C:/Software/conex/packages/agent-runtime/src/runtime-helpers.ts#L369-L393) 的 `buildPermissionDenyToolOutput`：
     ```typescript
     export function buildPermissionDenyToolOutput(decision: PermissionDecision): ToolOutput {
       ...
       const json: JsonObject = {
         ...(decision.metadata ?? {}),
         softDeny,
         code,
         reason: text,
       };
       return { text, json };
     }
     ```
   - `json` 结构体中缺失 `retryable: false` 字段，导致 `single-tool-executor.ts` 和 Agent 转向引擎（Steering Engine）无法将此拒绝标识为不可重试错误，限制了恢复管线的智能切断。

### 2.3 代码级修复指引与加固方案

在 `DaemonApprovalHandler` 中增加 `runIntentDenylist` 记忆，并在拒绝决策中注入 `retryable: false` 与自动拦截：

```typescript
// packages/agent-daemon/src/daemon-approval-handler.ts 修复加固
export class DaemonApprovalHandler {
  private static readonly runIntentAllowlist = new Map<string, Set<string>>();
  private static readonly alwaysIntentAllowlist = new Set<string>();
  /** 增加：runId → 已拒绝的 intentKey 集合 */
  private static readonly runIntentDenylist = new Map<string, Set<string>>();

  async requestApproval(request: PermissionRequest): Promise<PermissionDecision> {
    const runId = this.runId ?? "unknown";
    ...
    // 1. 检查是否在拒绝黑名单中
    const denylist = DaemonApprovalHandler.runIntentDenylist.get(runId);
    if (denylist?.has(intentKey)) {
      return {
        behavior: "deny",
        reason: "User previously denied this operation intent in the current run; execution blocked automatically.",
        metadata: {
          matchedRule: "run-intent-denylist",
          autoDenied: true,
          retryable: false,
          intentKey,
          trustZone: resolution.zone,
          risk: String(resolution.risk),
        },
      };
    }
    ...
  }

  private decisionFromResult(...): PermissionDecision {
    ...
    if (result.decision === "denied") {
      // 记录到本 run 的 Intent 拒绝黑名单
      let denySet = DaemonApprovalHandler.runIntentDenylist.get(runId);
      if (!denySet) {
        denySet = new Set();
        DaemonApprovalHandler.runIntentDenylist.set(runId, denySet);
      }
      denySet.add(intentKey);

      return {
        behavior: "deny",
        reason: result.reason ?? "User denied tool execution",
        metadata: {
          approval: approvalMeta,
          softDeny: true,
          retryable: false, // 显式标记不可重试
          intentKey,
          trustZone: zone,
        } satisfies JsonObject,
      };
    }
    ...
  }

  static clearRun(runId: string): void {
    DaemonApprovalHandler.runIntentAllowlist.delete(runId);
    DaemonApprovalHandler.runIntentDenylist.delete(runId); // 干净清理
  }
}
```

---

## 三、 Tool 消息体空 content 序列化与 `"[]"` 响应污染

### 3.1 标杆项目补丁经验参照
* **agno Commit `2594f206c` (PR #6122)**：在处理 LLM 或 Tool 返回的空列表/空 content 时，原代码判断 `if len(self.content) > 0` 失败后降级回退到 `json.dumps(self.content)`，导致空列表被序列化为字符串字面量 `"[]"`。后续响应拼接时，输出了 `"I will check the order status.[]"` 的脏字符。修复方案要求显式拦截空列表并返回空字符串 `""`。

### 3.2 Conex 现状代码剖析
在 Conex 的工具输出序列化与 Provider 请求构建模块中：

1. **`stringifyToolOutput` 序列化边缘漏洞**：
   - 检查 [packages/agent-runtime/src/tool-output-budget.ts](file:///C:/Software/conex/packages/agent-runtime/src/tool-output-budget.ts#L63-L70) 的 `stringifyToolOutput` 实现：
     ```typescript
     export function stringifyToolOutput(output: ToolOutput): string {
       if (typeof output.text === "string") return output.text;
       if (output.json !== undefined) return JSON.stringify(output.json, null, 2);
       if (output.artifacts?.length) {
         return output.artifacts.map((artifact) => artifact.text ?? artifact.uri ?? artifact.title).join("\n");
       }
       return "";
     }
     ```
   - 检查 [packages/agent-runtime/src/openai-request-build.ts](file:///C:/Software/conex/packages/agent-runtime/src/openai-request-build.ts#L58-L63)：
     ```typescript
     export function stringifyToolOutput(output: ToolOutput): string {
       if (output.text) return output.text;
       if (output.json !== undefined) return JSON.stringify(output.json);
       if (output.artifacts?.length) return JSON.stringify(output.artifacts);
       return "";
     }
     ```
   - **两处缺陷剖析**：
     - 当工具返回 `{ text: "", json: [] }` 或结构化输出为 `{ json: [] }` 时，`output.text` 为空，代码进入 `output.json !== undefined` 分支，执行 `JSON.stringify([])`，返回字符串 `"[]"`！
     - 当工具返回 `{ text: "", json: {} }` 时，执行 `JSON.stringify({})`，返回字符串 `"{}"`！

2. **OpenAI Chat Messages 请求体空 content 序列化风险**：
   - 查看 [packages/agent-runtime/src/openai-request-build.ts](file:///C:/Software/conex/packages/agent-runtime/src/openai-request-build.ts#L333-L343)：
     ```typescript
     if (message.role === "tool") {
       for (const block of message.blocks) {
         if (block.type === "tool-result") {
           result.push({
             role: "tool",
             tool_call_id: block.toolCallId,
             content: stringifyToolOutput(block.output)
           });
         }
       }
       continue;
     }
     ```
   - **风险 1（字符串污染）**：若工具返回空 json 列表，`content` 变成 `"[]"`，作为 Tool Result 存入历史消息。下一轮对话中模型会将字面量 `"[]"` 识别为有效工具输出，导致上下文污染。
   - **风险 2（空字符串触发 Provider 拒绝）**：若 `stringifyToolOutput` 返回 `""`（空字符串），部分严格校验的 Provider API（如 Azure OpenAI / DeepSeek / vLLM 某版本）对 `role: "tool"` 消息要求 `content` 必须为非空字符串，否则返回 HTTP 400 `Invalid request: content cannot be empty`。

### 3.3 代码级修复指引与加固方案

统一修正 `stringifyToolOutput`，避免 `[]` 坍塌为污染字面量 `"[]"`，并为 `role: "tool"` 消息提供安全占位符：

```typescript
// packages/agent-runtime/src/tool-output-budget.ts 修复
export function stringifyToolOutput(output: ToolOutput): string {
  if (typeof output.text === "string" && output.text.length > 0) {
    return output.text;
  }
  if (output.json !== undefined) {
    // 拦截空数组与空对象，避免导出 "[]" 或 "{}" 污染上下文
    if (Array.isArray(output.json) && output.json.length === 0) {
      return typeof output.text === "string" ? output.text : "";
    }
    if (isPlainObject(output.json) && Object.keys(output.json).length === 0) {
      return typeof output.text === "string" ? output.text : "";
    }
    return JSON.stringify(output.json, null, 2);
  }
  if (output.artifacts?.length) {
    return output.artifacts.map((a) => a.text ?? a.uri ?? a.title).join("\n");
  }
  return typeof output.text === "string" ? output.text : "";
}

// packages/agent-runtime/src/openai-request-build.ts 修复
export function safeToolResultContent(output: ToolOutput): string {
  const text = stringifyToolOutput(output).trim();
  // 若为空，提供安全的 Tool Success/Empty 占位文本，防止 Provider HTTP 400 校验失败
  return text.length > 0 ? text : "(empty tool output)";
}
```

---

## 四、 MCP 工具注册、鉴权与超时熔断保护机制

### 4.1 标杆项目补丁经验参照
* **Desktop Agent Runtimes (Claude Desktop / Cline MCP Engine)**：
  - MCP 工具的 RPC 调用必须绑定超时与 AbortSignal，绝不能死等子进程。
  - 必须具备滑动窗口熔断器（Circuit Breaker），当某个 MCP Server 连续失败 N 次或超时，自动切断该 Server 状态为 `degraded`，避免单个 MCP 工具拖垮整个 Agent 会话。
  - 必须对 MCP 工具进行显式权限域（TrustZone T0-T4）映射，禁止默认所有 MCP 工具均为无限制写操作或完全放行。
  - 必须同时支持 Stdio 和 Remote SSE / WebSocket 传输层。

### 4.2 Conex 现状代码剖析
在 Conex 的 MCP 模块 [packages/agent-daemon/src/mcp-stdio-adapter.ts](file:///C:/Software/conex/packages/agent-daemon/src/mcp-stdio-adapter.ts) 与 `packages/agent-runtime/src/mcp-lifecycle/` 中：

1. **`client.callTool` 忽略超时与取消 Signal**：
   - 检查 [packages/agent-daemon/src/mcp-stdio-adapter.ts](file:///C:/Software/conex/packages/agent-daemon/src/mcp-stdio-adapter.ts#L189-L198) 的工具 `execute` 方法：
     ```typescript
     async execute(
       input: JsonObject,
       _context: ToolExecutionContext
     ): Promise<ToolOutput> {
       void _context; // 致命：完全忽略了 _context 中的 signal 与 timeout
       const result = await client.callTool({
         name,
         arguments: input as Record<string, unknown>,
       });
       return formatToolResult(result);
     }
     ```
   - **重大缺陷**：`_context.signal` 被直接丢弃（`void _context`）！若 MCP Stdio 子进程卡死、无限循环或网络超时，`await client.callTool` 将**永久挂起**，导致 Agent Session 主循环卡死无法响应。

2. **缺失 Circuit Breaker（熔断器）与连续失败隔离**：
   - 检查 `McpServerController`（[packages/agent-runtime/src/mcp-lifecycle/mcp-server-controller.ts](file:///C:/Software/conex/packages/agent-runtime/src/mcp-lifecycle/mcp-server-controller.ts#L358-L404)）：
   - `McpServerController` 维护了状态机（`discovering` -> `starting` -> `ready` -> `degraded`），但是在工具调用路径 `executeManagedTool` 中：
     `return tool.execute(input, context);`
   - 当 `tool.execute` 抛出网络错、进程崩溃错或超时，`McpServerController` **没有统计连续失败次数**，也没有触发熔断切断。每次模型再调用该 MCP 工具，系统依然重新发起 RPC 请求并再次等待超时。

3. **鉴权与 TrustZone 映射粗糙**：
   - 查看 [packages/agent-daemon/src/mcp-stdio-adapter.ts](file:///C:/Software/conex/packages/agent-daemon/src/mcp-stdio-adapter.ts#L187)：
     `isReadOnly: () => false,`
   - **安全隐患**：所有通过 MCP SDK 导出的工具被一律硬编码标记为 `isReadOnly: () => false`。系统没有读取 MCP 工具的 Annotations 或元数据来区分只读查询工具与高危写工具，导致 MCP 只读工具（如 `mcp_read_resource`）也会被误判为 `T1/T2` 写操作而频繁触发不必要的审批。

4. **单传输层局限（缺少 SSE / WebSocket Remote MCP 支持）**：
   - Conex 目前仅在 `mcp-stdio-adapter.ts` 中实现了 Stdio 子进程适配器，完全缺少基于 HTTP SSE (Server-Sent Events) 或 WebSockets 的远程 MCP 服务连接能力。

### 4.3 代码级修复指引与加固方案

#### 方案 1：在 Stdio Adapter 中注入信号控制与超时保护
```typescript
// packages/agent-daemon/src/mcp-stdio-adapter.ts 修复
async execute(
  input: JsonObject,
  context: ToolExecutionContext
): Promise<ToolOutput> {
  const timeoutMs = context.timeoutMs ?? 30_000;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`MCP tool ${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  
  // 组合 context.signal 与 timeoutSignal
  const combinedSignal = combineAbortSignals(context.signal, timeoutController.signal);

  try {
    const result = await Promise.race([
      client.callTool({ name, arguments: input as Record<string, unknown> }),
      new Promise<never>((_, reject) => {
        combinedSignal.addEventListener('abort', () => reject(combinedSignal.reason), { once: true });
      }),
    ]);
    return formatToolResult(result);
  } finally {
    clearTimeout(timer);
  }
}
```

#### 方案 2：在 `McpServerController` 中增加轻量熔断计数器
```typescript
// packages/agent-runtime/src/mcp-lifecycle/mcp-server-controller.ts
export class McpServerController {
  private consecutiveFailures = 0;
  private static readonly FAILURE_THRESHOLD = 3;

  private async executeManagedTool(...) {
    if (this.consecutiveFailures >= McpServerController.FAILURE_THRESHOLD) {
      this.degrade(this.createDiagnostic('MCP_SERVER_UNAVAILABLE', 'execute-tool', 'Circuit breaker open due to consecutive failures', false));
      throw new McpLifecycleError(this.diagnostic!);
    }
    try {
      const output = await tool.execute(input, context);
      this.consecutiveFailures = 0; // 成功则复位
      return output;
    } catch (err) {
      this.consecutiveFailures += 1;
      throw err;
    }
  }
}
```

---

## 五、 缺陷矩阵与重构实施路线图

### 5.1 Conex Tool Call 容错域差距汇总表

| 诊断领域 | 真实 Conex 文件与代码位置 | 现有缺陷与安全隐患 | 标杆经验 (Reference Patch) | 重构目标 (Target State) |
| :--- | :--- | :--- | :--- | :--- |
| **1. Union Input Normalization** | `provider-openai-chat.ts:L128`<br>`tools.ts:L64, L120` | `null` / `[]` 参数被错误包装为 `{value: null}`，导致参数提取失败；缺少 Zod `.preprocess()` 自动归一化 | agno Commit `d21699284` (无参调用坍塌修复) | 全量实现空值/空数组归一化；在 Zod 校验器中注入 `zCoerceArray` / `zDefaultEmpty` |
| **2. Deny 意图记忆与 Retryable** | `daemon-approval-handler.ts:L18, L193`<br>`runtime-helpers.ts:L369` | 完全缺少 `runIntentDenylist`；人类拒绝后不记录黑名单且未标记 `retryable: false`，引发无限重复弹窗死循环 | Cline / Claude Code 人类拒绝非重试拦截 | 增加 `runIntentDenylist` 记忆；拒绝自动返回 `retryable: false` 拦截同 Run 再次弹窗 |
| **3. Content 空值与 `"[]"` 污染** | `tool-output-budget.ts:L63`<br>`openai-request-build.ts:L58, L333` | 空 json 数组被 `JSON.stringify` 导出为 `"[]"` 污染上下文；Tool 消息 `content: ""` 易导致 Provider HTTP 400 | agno Commit `2594f206c` (空 content 导为 `"[]"` 修复) | `stringifyToolOutput` 拦截空数组/空对象导出 `""`；Tool Result 注入 safe text 占位 |
| **4. MCP 熔断与鉴权** | `mcp-stdio-adapter.ts:L189`<br>`mcp-server-controller.ts:L358` | `client.callTool` 完全忽略 AbortSignal 与超时；无熔断器；所有 MCP 工具盲目硬编码为 `isReadOnly: false` | Desktop Agent Runtimes 进程隔离与超时熔断 | 绑定 AbortSignal 与 30s 默认超时；增加 3 次连续失败熔断器；支持 Tool 读写元数据映射 |

---

## 六、 结论与 Agent 3 诊断结论

本次对 Conex 代码库 Tool Call 容错域的深入审计表明：**Conex 在底层工具调用管线中缺乏足够的鲁棒性防护**。特别是 `DaemonApprovalHandler` 缺失 `runIntentDenylist` 导致的无限弹窗死循环、`mcp-stdio-adapter` 忽略 `AbortSignal` 导致的线程挂起风险，均属于高风险工程隐患。

本报告给出的重构方案严格遵循了反过度设计硬性红线（未引入复杂的沙箱隔离或多余的中间件重构），通过轻量级归一化函数、Set 缓存记忆与超时 Signal 绑定，即可彻底消除上述隐患。

---
*报告完成，已保存至 `C:\Software\conex\analysis\conex_gap_audits\conex_gap_03_tool_call_fault_tolerance.md`。*
