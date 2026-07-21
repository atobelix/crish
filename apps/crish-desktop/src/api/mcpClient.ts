/**
 * MCP SDK 直连客户端（stdio transport）。
 *
 * SDK 的 stdio transport 依赖 Node 内置（node:stream / child_process 等），
 * 不能被 Vite 浏览器构建静态打进包。因此 Client / StdioClientTransport /
 * 通知 schema 一律在 connect 时动态 import；纯浏览器环境友好失败。
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { isTauriShell } from './productMode';

/** 懒加载后的 Client 实例形状（避免顶层值导入 SDK） */
type LazyMcpClient = {
  connect: (transport: unknown) => Promise<void>;
  listTools: () => Promise<{ tools: Tool[] }>;
  callTool: (args: { name: string; arguments: unknown }) => Promise<unknown>;
  close: () => Promise<void>;
  setNotificationHandler: (schema: unknown, handler: () => void) => void;
};

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class McpClientManager {
  private clients = new Map<
    string,
    { client: LazyMcpClient; transport: unknown }
  >();
  private toolCache = new Map<string, McpToolInfo[]>();

  async connect(serverId: string, config: McpServerConfig): Promise<void> {
    // 纯浏览器：stdio MCP 不可用（需桌面 runtime / Node 侧）
    if (typeof window !== 'undefined' && !isTauriShell()) {
      throw new Error(
        'MCP stdio transport is only available in the desktop runtime'
      );
    }

    const [
      { Client },
      { StdioClientTransport },
      { ToolListChangedNotificationSchema },
    ] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/types.js'),
    ]);

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });

    const client = new Client({
      name: 'crish-desktop',
      version: '1.0.0',
    });

    await client.connect(transport);
    this.clients.set(serverId, {
      client: client as unknown as LazyMcpClient,
      transport,
    });

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.invalidateToolCache(serverId);
    });
  }

  async listTools(serverId: string): Promise<McpToolInfo[]> {
    if (this.toolCache.has(serverId)) {
      return this.toolCache.get(serverId)!;
    }

    const entry = this.clients.get(serverId);
    if (!entry) throw new Error(`MCP server "${serverId}" not connected`);

    const result = await entry.client.listTools();
    const tools: McpToolInfo[] = result.tools.map((t: Tool) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    this.toolCache.set(serverId, tools);
    return tools;
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown
  ): Promise<unknown> {
    const entry = this.clients.get(serverId);
    if (!entry) throw new Error(`MCP server "${serverId}" not connected`);

    return entry.client.callTool({ name: toolName, arguments: args });
  }

  invalidateToolCache(serverId: string): void {
    this.toolCache.delete(serverId);
  }

  async disconnect(serverId: string): Promise<void> {
    const entry = this.clients.get(serverId);
    if (entry) {
      await entry.client.close();
      this.clients.delete(serverId);
      this.toolCache.delete(serverId);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const id of this.clients.keys()) {
      await this.disconnect(id);
    }
  }

  getConnectedServers(): string[] {
    return [...this.clients.keys()];
  }
}

export const mcpClientManager = new McpClientManager();
