# @chat-sync/agent-runtime

Small, UI-agnostic agent runtime for Chat Sync.

The package is intentionally below the desktop app and below any specific model SDK. It owns the parts that must stay stable:

- agent event stream
- message and tool-call transcript model
- tool registry and tool source loading
- sequential, parallel, and exclusive tool execution
- permission and approval boundaries
- JSONL session persistence
- Agent Skills loading

Provider adapters, MCP adapters, local shell tools, and GUI rendering should plug into this package instead of becoming part of the runtime core.

The package includes a small memory foundation: `InMemoryMemoryStore`, `JsonlMemoryStore`, and `createMemoryTools()`. This is intentionally simple and inspectable; richer ranking, vector search, and GUI controls can layer on top without changing the tool contract.

## Current Security Boundary

This package now has a permission boundary, not a true OS sandbox.

- `project`: default mode. The active project is trusted: reads, edits, tests, builds, dependency installs, downloads, MCP calls, and sub-agent calls are allowed. Destructive commands, secret exposure, and external side effects still ask.
- `read-only`: soft sub-agent/review mode. Reads are allowed, Markdown report writes are allowed, and the first mutating action asks. If the user allows it, later actions in the same capability scope are allowed for that policy instance.
- `full-access`: trusted power-user mode. Most actions are allowed automatically, but hardline host-destroying commands are still denied and high-risk actions still ask.

Hardline commands are non-bypassable and are also enforced inside the terminal tool, not only in the permission policy. Examples include deleting root/home/system directories, disk formatting, raw block-device writes, fork bombs, full-system process kills, and shutdown/reboot commands. Killing a specific process is allowed; the GUI can add non-blocking hints if process-control commands repeat frequently.

Mutating filesystem tools can attach short-term file snapshots so the GUI can offer rollback. For high-risk terminal commands, the permission decision includes `metadata.recommendSnapshot`; the desktop approval dialog should let users opt into a broader checkpoint before running the command.

Real sandboxing should be added below tools as an execution backend, not inside the agent loop. The first production path is Windows native guard behavior: workspace cwd guards, secret-like environment variable scrubbing, process-tree timeout/abort cleanup, command classification, and optional pre-run checkpoints. WSL, Docker, Windows Sandbox, or remote workers should stay optional advanced backends.

Text file tools decode BOM-aware UTF-8/UTF-16 and fall back to GB18030 for reads when UTF-8 fails. Writes preserve existing UTF-8/UTF-16 encodings by default and refuse to overwrite non-writable legacy encodings unless the caller explicitly converts to UTF-8. Windows terminal commands start with a UTF-8 PowerShell prelude and scrub secret-like environment variables before spawning.

## Minimal Usage

```ts
import {
  AgentRuntime,
  createLocalWorkspaceTools,
  createPermissionPolicy,
  createScriptedProvider,
  ToolRegistry
} from "@chat-sync/agent-runtime";

const tools = new ToolRegistry();
for (const tool of createLocalWorkspaceTools({ workspaceRoot: process.cwd() })) {
  tools.register(tool);
}

const provider = createScriptedProvider([
  [
    { type: "text-delta", text: "Running echo.\n" },
    { type: "tool-call", toolName: "shell_command", input: { command: "git status --short" } },
    { type: "stop", reason: "tool-call" }
  ],
  [{ type: "text-delta", text: "Done.", }, { type: "stop", reason: "stop" }]
]);

const runtime = new AgentRuntime({
  cwd: process.cwd(),
  provider,
  toolSources: [tools],
  permissionPolicy: createPermissionPolicy({ mode: "project" })
});

for await (const event of runtime.run("start")) {
  console.log(event.type);
}
```

## Flowbit / OpenAI-Compatible Provider

`OpenAICompatibleProvider` defaults to `endpoint: "auto"`: it tries OpenAI-compatible `/v1/responses` first and can fall back to `/v1/chat/completions` when the Responses endpoint is clearly unavailable. Set `endpoint: "responses"` or `endpoint: "chat-completions"` to force a specific wire format. Model listing defaults to `/v1/models`.

```ts
import {
  AgentRuntime,
  createLocalWorkspaceTools,
  createPermissionPolicy,
  OpenAICompatibleProvider
} from "@chat-sync/agent-runtime";

const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.flowbit.me/",
  apiKey: process.env.FLOWBIT_API_KEY,
  model: "mimo-v2.5",
  endpoint: "auto",
  topP: 0.95,
  stream: true
});

const runtime = new AgentRuntime({
  cwd: process.cwd(),
  provider,
  tools: createLocalWorkspaceTools({ workspaceRoot: process.cwd() }),
  permissionPolicy: createPermissionPolicy({ mode: "project" })
});
```

MiMo-style thinking models on providers that only expose the chat-completions transport emit `reasoning_content` and expect that reasoning field to be replayed on later assistant messages. Set `endpoint: "chat-completions"`, `maxTokensField: "max_completion_tokens"`, and `reasoningContent: "require"` for that dialect.

Do not store user API keys in this package. The desktop app should inject either the official logged-in Flowbit credential or a user-provided provider key at runtime.

## Sub-Agents

Sub-agents are normal tools at the parent boundary:

```ts
import { createSubagentTool } from "@chat-sync/agent-runtime";

const worker = createSubagentTool({
  cwd: process.cwd(),
  provider,
  tools: createLocalWorkspaceTools({ workspaceRoot: process.cwd() }),
  permissionPolicy: (input) => createPermissionPolicy({ mode: input.mode === "implement" ? "project" : "read-only" })
});
```

The parent receives structured progress updates (`started`, tool batches, completion) and a final text result. Workers start with isolated conversation state, so prompts must be self-contained: goal, scope, files, constraints, and done criteria.

## Design Notes

The runtime follows a Pi-style small core but keeps Claude-Code-style boundaries for permissions, task progress, tool summaries, and future MCP integration. Hermes influenced the toolset/backend split: terminal execution, browser/MCP integrations, memory, and skills should be pluggable capability groups rather than hardcoded runtime features.

The UI should render the event stream directly. Do not reconstruct tool order from final messages when live events are available.

Use `runRuntimeWithProbe()` in tests and development harnesses to monitor long-running agent turns. It records event counts, tool calls by name, approvals, max event gap, and tool/runtime errors without requiring GUI integration.

MCP should be implemented as a `ToolSource`: connect to servers, normalize their tools into `AgentTool`, and let the runtime handle permissions and execution ordering.

Memory is also tool-driven. Add `createMemoryTools(new JsonlMemoryStore(path))` to a runtime to give the agent `remember_memory` and `search_memory` without adding special cases to the provider loop.

Sub-agents should also be tools at the boundary: the parent agent calls an `agent` category tool, and that tool starts another `AgentRuntime` with its own session id and event bridge.
