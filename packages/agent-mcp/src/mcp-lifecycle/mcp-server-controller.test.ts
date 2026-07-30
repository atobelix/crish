import { describe, expect, it, vi } from 'vitest';
import { McpServerController } from './mcp-server-controller';
import { McpLifecycleError } from './types';

describe('McpServerController', () => {
  it('should trip circuit breaker after 3 consecutive failures', async () => {
    const mockTool = {
      name: 'failing_tool',
      description: 'Fails always',
      inputSchema: { type: 'object' },
      execute: vi.fn().mockRejectedValue(new Error('Tool error')),
    };

    const mockAdapter = {
      connect: async () => ({
        listTools: async () => [mockTool],
      }),
    };

    const controller = new McpServerController({
      name: 'test-server',
      adapter: mockAdapter as any,
    });

    await controller.start();
    expect(controller.state).toBe('ready');

    const tools = controller.listTools();
    const tool = tools.find((t) => t.name === 'failing_tool')!;

    const ctx: any = { signal: new AbortController().signal };

    // 3 consecutive failures
    await expect(tool.execute({}, ctx)).rejects.toThrow('Tool error');
    await expect(tool.execute({}, ctx)).rejects.toThrow('Tool error');
    await expect(tool.execute({}, ctx)).rejects.toThrow('Tool error');

    // Circuit breaker tripped -> state becomes degraded
    expect(controller.state).toBe('degraded');
  });

  it('should not call degraded servers', async () => {
    const mockAdapter = {
      connect: async () => {
        throw new Error('Connection failed');
      },
    };

    const controller = new McpServerController({
      name: 'degraded-server',
      adapter: mockAdapter as any,
    });

    // Start fails -> transitions to degraded
    const result = await controller.start();
    expect(result.ok).toBe(false);
    expect(controller.state).toBe('degraded');

    const tools = controller.listTools();
    const tool = tools[0];

    if (tool) {
      const ctx: any = { signal: new AbortController().signal };
      await expect(tool.execute({}, ctx)).rejects.toThrow(McpLifecycleError);
    } else {
      expect(controller.snapshot().state).toBe('degraded');
    }
  });
});
