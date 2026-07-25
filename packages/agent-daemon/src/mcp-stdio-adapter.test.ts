import { describe, expect, it } from 'vitest';
import { createStdioMcpAdapter } from './mcp-stdio-adapter';

describe('McpStdioAdapter', () => {
  it('should reject connect with empty command', () => {
    const adapter = createStdioMcpAdapter({
      name: 'empty-server',
      command: '',
      args: [],
      env: undefined,
      cwd: undefined,
      confirmStart: undefined,
    });

    expect(() => adapter.connect({ signal: new AbortController().signal, serverName: 'test', attempt: 1 })).toThrow(
      'empty stdio command'
    );
  });

  it('should reject connect when confirmStart returns false', async () => {
    const adapter = createStdioMcpAdapter({
      name: 'denied-server',
      command: 'node',
      args: [],
      env: undefined,
      cwd: undefined,
      confirmStart: async () => false,
    });

    await expect(adapter.connect({ signal: new AbortController().signal, serverName: 'test', attempt: 1 })).rejects.toThrow(
      'startup denied'
    );
  });

  it('should accept an AbortSignal in the connect context', () => {
    const adapter = createStdioMcpAdapter({
      name: 'signal-test',
      command: 'node',
      args: [],
      env: undefined,
      cwd: undefined,
      confirmStart: () => true,
    });

    const ac = new AbortController();
    const result = adapter.connect({ signal: ac.signal, serverName: 'test', attempt: 1 });
    expect(result).toBeInstanceOf(Promise);
    ac.abort();
  });
});
