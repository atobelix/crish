// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../api/mcpApi', () => ({
  listMcpServers: vi.fn(),
  probeMcpControl: vi.fn(),
  startMcpServer: vi.fn(),
  stopMcpServer: vi.fn(),
  mcpStateKind: (s: string) => (s === 'running' ? 'ok' : 'idle'),
}));

vi.mock('../../api/appMode', () => ({
  isDemoMode: vi.fn(() => false),
}));

import { useMcpSettings } from './useMcpSettings';
import {
  listMcpServers,
  probeMcpControl,
  startMcpServer,
  stopMcpServer,
} from '../../api/mcpApi';

describe('useMcpSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (listMcpServers as any).mockResolvedValue({
      ok: true,
      configured: true,
      servers: [
        {
          id: 'git',
          name: 'Git Tool',
          state: 'running',
          tools: ['git_status'],
        },
        { id: 'db', name: 'Database', state: 'stopped', tools: ['sql_query'] },
      ],
      status: { configured: true, serverCount: 2 },
    });
    (probeMcpControl as any).mockResolvedValue({
      canList: true,
      canStartStop: true,
      configured: true,
    });
  });

  it('loads and lists MCP servers in live mode', async () => {
    const { result } = renderHook(() => useMcpSettings());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.servers).toHaveLength(2);
    expect(result.current.canStartStop).toBe(true);
  });

  it('filters servers by search query and sort mode', async () => {
    const { result } = renderHook(() => useMcpSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setFilter('Git');
    });

    expect(result.current.filtered).toHaveLength(1);
    expect(result.current.filtered[0].id).toBe('git');
  });

  it('handles toggle start/stop for server', async () => {
    (startMcpServer as any).mockResolvedValue({ ok: true });
    (stopMcpServer as any).mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useMcpSettings());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.handleToggleServer(
        result.current.servers[0].id,
        'stop'
      );
    });

    expect(stopMcpServer).toHaveBeenCalledWith('git');
  });
});
