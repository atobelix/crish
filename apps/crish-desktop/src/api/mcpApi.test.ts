import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listMcpServers,
  startMcpServer,
  stopMcpServer,
  toggleMcpTool,
  probeMcpControl,
  fetchMcpStatus,
  mcpStateKind,
  mcpStateLabel,
  invalidateListCapabilitiesCache,
  resetMcpControlProbeMemory,
} from './mcpApi';
import * as tauriInvoke from './tauriInvoke';

describe('mcpApi (BC11-1 真实接入与动态反射)', () => {
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

  describe('BC11-1 真实 IPC 通信命令与非 Tauri 环境容错', () => {
    it('在非 Tauri 环境下 invokeTyped 返回 missing 且优雅降级', async () => {
      vi.spyOn(tauriInvoke, 'invokeTyped').mockResolvedValue({
        status: 'missing',
      } as any);

      const res = await listMcpServers();
      expect(res.ok).toBe(false);
      expect(res.servers).toEqual([]);
      expect(res.errorCode).toBe('missing');

      const started = await startMcpServer('mcp-1');
      expect(started.ok).toBe(false);
      expect(started.errorCode).toBe('missing');

      const stopped = await stopMcpServer('mcp-1');
      expect(stopped.ok).toBe(false);
      expect(stopped.errorCode).toBe('missing');

      const toggled = await toggleMcpTool('mcp-1', 'click', true);
      expect(toggled).toBe(false);

      const probe = await probeMcpControl(res);
      expect(probe.canList).toBe(false);
      expect(probe.canStartStop).toBe(false);
    });

    it('成功调用 workbench_list_mcp_servers 并规范化工具列表与 toolDefs', async () => {
      vi.spyOn(tauriInvoke, 'invokeTyped').mockImplementation(
        async (cmd: string) => {
          if (cmd === 'workbench_list_mcp_servers') {
            return {
              status: 'ok',
              data: [
                {
                  id: 'server-1',
                  name: 'Chrome DevTools',
                  status: 'connected',
                  tools: [
                    'click',
                    {
                      name: 'navigate',
                      description: '导航到指定网址',
                      inputSchema: { type: 'object' },
                    },
                  ],
                },
              ],
            } as any;
          }
          return { status: 'missing' } as any;
        }
      );

      const res = await listMcpServers();
      expect(res.ok).toBe(true);
      expect(res.configured).toBe(true);
      expect(res.servers).toHaveLength(1);

      const s = res.servers[0];
      expect(s.id).toBe('server-1');
      expect(s.state).toBe('ready');
      expect(s.tools).toEqual(['click', 'navigate']);
      expect(s.toolDefs).toEqual([
        {
          name: 'navigate',
          prefixedName: undefined,
          description: '导航到指定网址',
          inputSchema: { type: 'object' },
          enabled: true,
        },
      ]);

      const probe = await probeMcpControl(res);
      expect(probe.canList).toBe(true);
      expect(probe.canStartStop).toBe(true);
      expect(probe.configured).toBe(true);
      expect(probe.capabilityState).toBe('ready');
    });

    it('成功调用 workbench_start_mcp_server / stop_mcp_server / toggle_mcp_tool', async () => {
      const invokeSpy = vi
        .spyOn(tauriInvoke, 'invokeTyped')
        .mockImplementation(async (cmd: string, args: any) => {
          if (cmd === 'workbench_start_mcp_server') {
            return { status: 'ok', data: { state: 'ready' } } as any;
          }
          if (cmd === 'workbench_stop_mcp_server') {
            return { status: 'ok', data: { state: 'stopped' } } as any;
          }
          if (cmd === 'workbench_toggle_mcp_tool') {
            return {
              status: 'ok',
              data: {
                ok: true,
                serverId: args.serverId,
                toolName: args.toolName,
              },
            } as any;
          }
          return { status: 'missing' } as any;
        });

      const started = await startMcpServer('srv-test');
      expect(started.ok).toBe(true);
      expect(started.serverId).toBe('srv-test');
      expect(started.state).toBe('ready');
      expect(invokeSpy).toHaveBeenCalledWith('workbench_start_mcp_server', {
        serverId: 'srv-test',
      });

      const stopped = await stopMcpServer('srv-test');
      expect(stopped.ok).toBe(true);
      expect(stopped.serverId).toBe('srv-test');
      expect(stopped.state).toBe('stopped');
      expect(invokeSpy).toHaveBeenCalledWith('workbench_stop_mcp_server', {
        serverId: 'srv-test',
      });

      const toggled = await toggleMcpTool('srv-test', 'click', false);
      expect(toggled).toBe(true);
      expect(invokeSpy).toHaveBeenCalledWith('workbench_toggle_mcp_tool', {
        serverId: 'srv-test',
        toolName: 'click',
        enabled: false,
      });
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
