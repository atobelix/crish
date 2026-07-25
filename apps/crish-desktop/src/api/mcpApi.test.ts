import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./daemonClient', () => {
  const mockClient = {
    isConnected: vi.fn(() => true),
    waitUntilConnected: vi.fn(async () => true),
    request: vi.fn(),
  };
  return {
    getDesktopDaemonClient: () => mockClient,
    __mockClient: mockClient,
  };
});

vi.mock('./mcpClient', () => {
  return {
    mcpClientManager: {
      getServers: vi.fn(() => []),
      startServer: vi.fn(),
      stopServer: vi.fn(),
    },
  };
});

import {
  listMcpServers,
  startMcpServer,
  stopMcpServer,
  probeMcpControl,
  mcpStateKind,
  mcpStateLabel,
  invalidateListCapabilitiesCache,
  resetMcpControlProbeMemory,
} from './mcpApi';
import { getDesktopDaemonClient } from './daemonClient';

describe('mcpApi', () => {
  const daemonClient = getDesktopDaemonClient() as any;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateListCapabilitiesCache();
    resetMcpControlProbeMemory();
    daemonClient.isConnected.mockReturnValue(true);
  });

  describe('mcpStateKind & mcpStateLabel', () => {
    it('categorizes and labels MCP states correctly', () => {
      expect(mcpStateKind('running')).toBe('ok');
      expect(mcpStateKind('ready')).toBe('ok');
      expect(mcpStateKind('starting')).toBe('warn');
      expect(mcpStateKind('stopped')).toBe('idle');
      expect(mcpStateKind('error')).toBe('err');

      expect(mcpStateLabel('running')).toBe('运行中');
      expect(mcpStateLabel('starting')).toBe('启动中');
      expect(mcpStateLabel('stopped')).toBe('已停止');
    });
  });

  describe('listMcpServers', () => {
    it('returns error when daemon is not connected', async () => {
      daemonClient.isConnected.mockReturnValue(false);
      daemonClient.waitUntilConnected.mockResolvedValue(false);

      const res = await listMcpServers();
      expect(res.ok).toBe(false);
      expect(res.servers).toEqual([]);
      expect(res.errorCode).toBe('not_connected');
    });

    it('parses server list from daemon response', async () => {
      daemonClient.request
        .mockResolvedValueOnce({
          mcpStatus: { configured: true, serverCount: 2 },
        })
        .mockResolvedValueOnce({
          servers: [
            { id: 'filesystem', name: 'File System', state: 'running', tools: ['read', 'write'] },
            { id: 'fetch', name: 'Web Fetch', state: 'stopped', tools: ['fetch_url'] },
          ],
        });

      const res = await listMcpServers();
      expect(res.ok).toBe(true);
      expect(res.configured).toBe(true);
      expect(res.servers).toHaveLength(2);
      expect(res.servers[0].id).toBe('filesystem');
      expect(res.servers[0].tools).toEqual(['read', 'write']);
    });
  });

  describe('startMcpServer & stopMcpServer', () => {
    it('routes start to daemon RPC', async () => {
      daemonClient.request.mockResolvedValueOnce({
        state: 'starting',
      });

      const res = await startMcpServer('remote-mcp-1');
      expect(res.ok).toBe(true);
      expect(res.serverId).toBe('remote-mcp-1');
      expect(daemonClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'start-mcp-server', serverId: 'remote-mcp-1' }),
        'mcp-server-started',
        30_000
      );
    });

    it('routes stop to daemon RPC', async () => {
      daemonClient.request.mockResolvedValueOnce({
        state: 'stopped',
      });

      const res = await stopMcpServer('remote-mcp-1');
      expect(res.ok).toBe(true);
      expect(res.serverId).toBe('remote-mcp-1');
      expect(daemonClient.request).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stop-mcp-server', serverId: 'remote-mcp-1' }),
        'mcp-server-stopped',
        20_000
      );
    });
  });

  describe('probeMcpControl', () => {
    it('evaluates control capability probes correctly', async () => {
      daemonClient.request.mockResolvedValue({
        capabilities: [{ id: 'mcp.lifecycle', state: 'implemented' }],
      });

      const probe = await probeMcpControl({
        ok: true,
        configured: true,
        servers: [{ id: 's1', name: 'S1', state: 'running', tools: [] }],
      });

      expect(probe.canList).toBe(true);
      expect(probe.canStartStop).toBe(true);
    });
  });
});
