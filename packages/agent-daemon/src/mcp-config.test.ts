import { describe, expect, it } from 'vitest';
import type { DaemonMcpServerConfig } from './types.js';
import {
  buildMcpServerDefinitions,
  normalizeDaemonMcpServers,
  resolveDaemonMcpServers,
} from './mcp-config.js';

describe('mcp-config', () => {
  it('normalizes array and wrapped mcpServers / servers shapes', () => {
    expect(
      normalizeDaemonMcpServers([
        { name: 'a', command: 'npx', args: ['-y', 'x'] },
        { id: 'b', transport: 'stdio', command: 'node' },
        { name: 'a', command: 'dup' },
        null,
        'skip',
      ])
    ).toEqual([
      { name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      { name: 'b', transport: 'stdio', command: 'node' },
    ]);

    expect(
      normalizeDaemonMcpServers({
        mcpServers: [{ name: 'wrapped', command: 'echo' }],
      })
    ).toEqual([{ name: 'wrapped', transport: 'stdio', command: 'echo' }]);
  });

  it('resolveDaemonMcpServers prefers explicit config over env/file', () => {
    const resolved = resolveDaemonMcpServers({
      configServers: [{ name: 'from-config', command: 'node', args: ['s.js'] }] as DaemonMcpServerConfig[],
      env: {
        CRISH_MCP_SERVERS: JSON.stringify([{ name: 'from-env', command: 'x' }]),
      },
      loadDefaultFile: false,
    });
    expect(resolved).toEqual([
      {
        name: 'from-config',
        transport: 'stdio',
        command: 'node',
        args: ['s.js'],
      },
    ]);
  });

  it('resolveDaemonMcpServers falls back to env JSON', () => {
    const resolved = resolveDaemonMcpServers({
      env: {
        CRISH_MCP_SERVERS: JSON.stringify([
          { name: 'env-mcp', command: 'npx', args: ['-y', 'demo'] },
        ]),
      },
      loadDefaultFile: false,
    });
    expect(resolved.map((s) => s.name)).toEqual(['env-mcp']);
  });

  it('buildMcpServerDefinitions attaches adapters for stdio and deferred', () => {
    const defs = buildMcpServerDefinitions([
      { name: 'stdio-ok', command: 'node', args: ['x.js'] },
      { name: 'no-cmd' },
      { name: 'sse', transport: 'sse', url: 'http://localhost:1' },
    ] as unknown as DaemonMcpServerConfig[]);
    expect(defs).toHaveLength(3);
    expect(defs[0]?.name).toBe('stdio-ok');
    expect(typeof defs[0]?.adapter.connect).toBe('function');
    // deferred adapters throw on connect
    expect(() =>
      defs[1]?.adapter.connect({
        serverName: 'no-cmd',
        signal: new AbortController().signal,
        attempt: 1,
      })
    ).toThrow(/no stdio command/);
    expect(() =>
      defs[2]?.adapter.connect({
        serverName: 'sse',
        signal: new AbortController().signal,
        attempt: 1,
      })
    ).toThrow(/not wired/);
  });
});
