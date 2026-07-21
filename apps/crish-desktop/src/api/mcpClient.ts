import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: any;
}

export class McpClientManager {
  private clients = new Map<string, { client: Client; transport: StdioClientTransport }>();
  private toolCache = new Map<string, McpToolInfo[]>();

  async connect(serverId: string, config: McpServerConfig): Promise<void> {
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
    this.clients.set(serverId, { client, transport });

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

  async callTool(serverId: string, toolName: string, args: any): Promise<any> {
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
