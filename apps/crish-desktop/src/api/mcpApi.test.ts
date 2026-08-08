import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listMcpServers,
  startMcpServer,
  stopMcpServer,
  probeMcpControl,
  fetchMcpStatus,
  mcpStateKind,
  mcpStateLabel,
  invalidateListCapabilitiesCache,
  resetMcpControlProbeMemory,
} from './mcpApi';

describe('mcpApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateListCapabilitiesCache();
    resetMcpControlProbeMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  describe('T03.7 幽灵命令显式不可用', () => {
    it('listMcpServers 恒返回 unavailable（不发起 transport 请求）', async () => {
      const res = await listMcpServers();
      expect(res.ok).toBe(false);
      expect(res.servers).toEqual([]);
      expect(res.errorCode).toBe('unavailable');
    });

    it('startMcpServer / stopMcpServer 恒返回 unsupported', async () => {
      const started = await startMcpServer('mcp-1');
      expect(started.ok).toBe(false);
      expect(started.errorCode).toBe('unsupported');

      const stopped = await stopMcpServer('mcp-1');
      expect(stopped.ok).toBe(false);
      expect(stopped.errorCode).toBe('unsupported');
    });

    it('probeMcpControl 恒 canList=false / canStartStop=false', async () => {
      const probe = await probeMcpControl();
      expect(probe.canList).toBe(false);
      expect(probe.canStartStop).toBe(false);
      expect(probe.configured).toBe(false);
    });
  });

  describe('fetchMcpStatus（回补 core_get_status.mcpStatus）', () => {
    it('未就绪时返回 configured:false', async () => {
      const { getTransport } = await import('./transport');
      vi.spyOn(getTransport(), 'isReady').mockReturnValue(false);
      const res = await fetchMcpStatus();
      expect(res.configured).toBe(false);
    });

    it('读取 mcpStatus 字段投影 snapshot', async () => {
      const { getTransport } = await import('./transport');
      const transport = getTransport();
      vi.spyOn(transport, 'isReady').mockReturnValue(true);
      vi.spyOn(transport, 'request').mockResolvedValue({
        mcpStatus: { configured: true, serverCount: 2 },
      });
      const res = await fetchMcpStatus();
      expect(res.configured).toBe(true);
      expect(res.serverCount).toBe(2);
    });
  });
});
