/**
 * Stdio MCP adapter：将可序列化 command/args 接到 McpLifecycleManager。
 *
 * 使用 @modelcontextprotocol/sdk 的 StdioClientTransport（动态 import，
 * 失败时抛出明确错误，由 lifecycle 记为 degraded）。
 */

import type {
  AgentTool,
  McpServerAdapter,
  McpServerConnection,
  McpServerStartContext,
} from '@crish/agent-runtime';
import type {
  JsonObject,
  ToolExecutionContext,
  ToolOutput,
} from '@crish/shared-types';

export interface StdioMcpAdapterOptions {
  name: string;
  command: string;
  args: string[] | undefined;
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  /**
   * Optional confirmation hook called before the child process is spawned.
   * Return false to abort startup; the caller should surface a dialog to the
   * user (PP-4 / MC-2 flow).
   */
  confirmStart: ((command: string, args: string[]) => boolean | Promise<boolean>) | undefined;
}

type LazyMcpClient = {
  connect: (transport: unknown) => Promise<void>;
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  callTool: (args: {
    name: string;
    arguments?: Record<string, unknown>;
  }, options?: { signal?: AbortSignal }) => Promise<unknown>;
  close: () => Promise<void>;
};

/**
 * 创建 stdio MCP adapter。connect 时 spawn 子进程并完成 MCP handshake。
 */
export function createStdioMcpAdapter(
  options: StdioMcpAdapterOptions
): McpServerAdapter {
  const command = options.command.trim();
  if (!command) {
    return {
      connect() {
        throw new Error(`MCP server "${options.name}" has empty stdio command`);
      },
    };
  }

  return {
    async connect(
      context: McpServerStartContext
    ): Promise<McpServerConnection> {

      // PP-4 / MC-2: user confirmation check before spawning MCP child process
      if (options.confirmStart) {
        const allowed = await options.confirmStart(command, options.args ?? []);
        if (!allowed) {
          throw new Error(
            `MCP server "${options.name}" startup denied: user did not confirm command "${command}"`
          );
        }
      }

      let ClientCtor: new (info: {
        name: string;
        version: string;
      }) => LazyMcpClient;
      let StdioClientTransport: new (opts: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        signal?: AbortSignal;
      }) => { close?: () => Promise<void> };

      try {
        const clientMod =
          await import('@modelcontextprotocol/sdk/client/index.js');
        const stdioMod =
          await import('@modelcontextprotocol/sdk/client/stdio.js');
        ClientCtor = clientMod.Client as unknown as typeof ClientCtor;
        StdioClientTransport =
          stdioMod.StdioClientTransport as unknown as typeof StdioClientTransport;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `MCP SDK unavailable for stdio server "${options.name}": ${detail}`
        );
      }

      const transport = new StdioClientTransport({
        command,
        args: options.args ?? [],
        signal: context.signal,
        ...(options.env ? { env: mergeProcessEnv(options.env) } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });

      const client = new ClientCtor({
        name: 'crish-agent-daemon',
        version: '0.1.0',
      });

      await client.connect(transport);

      return {
        async listTools(): Promise<AgentTool[]> {
          const result = await client.listTools();
          const tools = Array.isArray(result?.tools) ? result.tools : [];
          return tools.map((tool) =>
            sdkToolToAgentTool(options.name, tool, client)
          );
        },
        async close(): Promise<void> {
          try {
            await client.close();
          } catch {
            // best-effort
          }
          try {
            await transport.close?.();
          } catch {
            // best-effort
          }
        },
      };
    },
  };
}

/** Whitelist of process env keys to inherit into MCP child processes. */
const MCP_ENV_WHITELIST = new Set(['PATH', 'HOME']);

function mergeProcessEnv(
  extra: Record<string, string>
): Record<string, string> {
  // Whitelist mode: only inherit PATH, HOME, and keys the config explicitly declares
  const base: Record<string, string> = {};
  for (const key of MCP_ENV_WHITELIST) {
    const val = process.env[key];
    if (typeof val === 'string') base[key] = val;
  }
  // Also inherit env keys that the config declares (they may need resolution)
  for (const key of Object.keys(extra)) {
    const val = process.env[key];
    if (typeof val === 'string' && !MCP_ENV_WHITELIST.has(key)) {
      base[key] = val;
    }
  }
  return { ...base, ...extra };
}

function sdkToolToAgentTool(
  serverName: string,
  tool: Record<string, unknown>,
  client: LazyMcpClient
): AgentTool {
  const name =
    typeof tool.name === 'string' && tool.name.trim()
      ? tool.name.trim()
      : 'unnamed';
  const description =
    typeof tool.description === 'string' && tool.description.trim()
      ? tool.description
      : `MCP tool ${name} from ${serverName}`;
  const inputSchema =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? (tool.inputSchema as JsonObject)
      : undefined;

  return {
    name,
    label: name,
    description,
    category: 'mcp',
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    concurrency: 'parallel',
    isReadOnly: () => {
      const readOnlyKeys = ['list', 'get', 'read', 'search', 'query'];
      return readOnlyKeys.some(k => name.toLowerCase().startsWith(k));
    },
    summarize: () => `${serverName}/${name}`,
    async execute(
      input: JsonObject,
      context: ToolExecutionContext
    ): Promise<ToolOutput> {
      const timeoutSignal = AbortSignal.timeout(30000);
      const combinedSignal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
      const result = await client.callTool({
        name,
        arguments: input as Record<string, unknown>,
      }, { signal: combinedSignal });
      return formatToolResult(result);
    },
  };
}

function formatToolResult(result: unknown): ToolOutput {
  if (result == null) return { text: '' };
  if (typeof result === 'string') return { text: result };

  if (typeof result === 'object') {
    const o = result as Record<string, unknown>;
    // MCP CallToolResult: { content: [{ type, text }], isError? }
    if (Array.isArray(o.content)) {
      const texts = o.content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (p.type === 'resource' && p.resource)
            return JSON.stringify(p.resource);
          return JSON.stringify(p);
        })
        .filter(Boolean);
      const text = texts.join('\n');
      if (o.isError === true) {
        return { text: text || 'MCP tool error' };
      }
      return { text };
    }
    try {
      return { text: JSON.stringify(result) };
    } catch {
      return { text: String(result) };
    }
  }

  return { text: String(result) };
}
