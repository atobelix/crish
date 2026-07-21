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
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

type LazyMcpClient = {
  connect: (transport: unknown) => Promise<void>;
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  callTool: (args: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<unknown>;
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
      _context: McpServerStartContext
    ): Promise<McpServerConnection> {
      void _context;
      let ClientCtor: new (info: {
        name: string;
        version: string;
      }) => LazyMcpClient;
      let StdioClientTransport: new (opts: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
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

function mergeProcessEnv(
  extra: Record<string, string>
): Record<string, string> {
  // StdioClientTransport 在提供 env 时通常不自动继承；合并 process.env 并覆盖 extra
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v;
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
    inputSchema,
    concurrency: 'parallel',
    isReadOnly: () => false,
    summarize: () => `${serverName}/${name}`,
    async execute(
      input: JsonObject,
      _context: ToolExecutionContext
    ): Promise<ToolOutput> {
      void _context;
      const result = await client.callTool({
        name,
        arguments: input as Record<string, unknown>,
      });
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
