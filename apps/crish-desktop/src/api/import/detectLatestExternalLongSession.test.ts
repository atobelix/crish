import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectLatestExternalLongSession } from './autoSyncExternalSessions';
import * as pluginRegistry from '../../components/settings-extensions/pluginRegistryAdapter';
import * as scan from './scan';
import * as map from './map';
import * as workspace from '../workspaceFsApi';
import * as tombstones from './externalSessionTombstone';
import { useSessionStore } from '../../store/sessionStore';
import type { DetectedExternalSession, MappedImportSession } from './types';

const sourceScan = (
  source: 'claude-code' | 'codex',
  sessions: DetectedExternalSession[]
) => ({ source, sessions, issues: [] });

vi.mock('../../components/settings-extensions/pluginRegistryAdapter');
vi.mock('./scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan')>();
  return {
    ...actual,
    scanClaudeCodeSessions: vi.fn(),
    scanCodexSessions: vi.fn(),
  };
});
vi.mock('./map');
vi.mock('../workspaceFsApi');

describe('detectLatestExternalLongSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useSessionStore.setState({ sessions: [], activeSessionId: null });
    vi.mocked(pluginRegistry.isPluginEnabled).mockReturnValue(true);
    vi.mocked(workspace.getWorkspacePath).mockReturnValue('/workspaces/my-app');
  });

  it('returns null if plugin is disabled', async () => {
    vi.mocked(pluginRegistry.isPluginEnabled).mockReturnValue(false);
    const result = await detectLatestExternalLongSession();
    expect(result).toBeNull();
  });

  it('detects latest long session matching minMessages and maps messages', async () => {
    const mockSessions: DetectedExternalSession[] = [
      {
        id: 'short-session',
        source: 'claude-code',
        title: '短对话',
        messageCount: 3,
        updatedAt: 1000,
        cwd: '/workspaces/my-app',
      },
      {
        id: 'older-long-session',
        source: 'claude-code',
        title: '较早长对话',
        messageCount: 12,
        updatedAt: 2000,
        cwd: '/workspaces/my-app',
      },
      {
        id: 'latest-long-session',
        source: 'codex',
        title: '最新长对话',
        messageCount: 15,
        updatedAt: 5000,
        cwd: '/workspaces/my-app',
      },
    ];

    vi.mocked(scan.scanClaudeCodeSessions).mockResolvedValue(
      sourceScan('claude-code', [mockSessions[0], mockSessions[1]])
    );
    vi.mocked(scan.scanCodexSessions).mockResolvedValue(
      sourceScan('codex', [mockSessions[2]])
    );

    const mockMapped: MappedImportSession = {
      source: 'codex',
      sourceId: 'latest-long-session',
      title: '最新长对话',
      messages: [
        {
          id: 'm1',
          sender: 'user',
          text: 'Hello',
          timestamp: 5000,
          status: 'completed',
        },
        {
          id: 'm2',
          sender: 'assistant',
          text: 'World',
          timestamp: 5001,
          status: 'completed',
        },
      ],
    };
    vi.mocked(map.mapExternalSession).mockResolvedValue(mockMapped);

    const result = await detectLatestExternalLongSession(8);
    expect(result).not.toBeNull();
    expect(result?.detected.id).toBe('latest-long-session');
    expect(result?.detected.source).toBe('codex');
    expect(result?.mapped).toEqual(mockMapped);
    expect(map.mapExternalSession).toHaveBeenCalledWith(mockSessions[2]);
  });

  it('ignores sessions that have already been imported', async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 'local-1',
          title: '已存在',
          messages: [],
          importMeta: {
            source: 'claude-code',
            sourceSessionId: 'already-imported',
            importedAt: '2026-08-01T00:00:00Z',
          },
        } as never,
      ],
    });

    const mockSessions: DetectedExternalSession[] = [
      {
        id: 'already-imported',
        source: 'claude-code',
        title: '已导入过',
        messageCount: 20,
        updatedAt: 9000,
        cwd: '/workspaces/my-app',
      },
      {
        id: 'valid-long-session',
        source: 'claude-code',
        title: '未导入的长对话',
        messageCount: 10,
        updatedAt: 4000,
        cwd: '/workspaces/my-app',
      },
    ];

    vi.mocked(scan.scanClaudeCodeSessions).mockResolvedValue(
      sourceScan('claude-code', mockSessions)
    );
    vi.mocked(scan.scanCodexSessions).mockResolvedValue(
      sourceScan('codex', [])
    );
    vi.mocked(map.mapExternalSession).mockResolvedValue({
      source: 'claude-code',
      sourceId: 'valid-long-session',
      title: '未导入的长对话',
      messages: [
        {
          id: 'm1',
          sender: 'user',
          text: 'hi',
          timestamp: 4000,
          status: 'completed',
        },
      ],
    });

    const result = await detectLatestExternalLongSession(8);
    expect(result).not.toBeNull();
    expect(result?.detected.id).toBe('valid-long-session');
  });

  it('ignores sessions blocked by tombstone', async () => {
    tombstones.recordDeletedExternalSession('claude-code', 'deleted-id');

    const mockSessions: DetectedExternalSession[] = [
      {
        id: 'deleted-id',
        source: 'claude-code',
        title: '被删除的长对话',
        messageCount: 30,
        updatedAt: 9999,
        cwd: '/workspaces/my-app',
      },
    ];

    vi.mocked(scan.scanClaudeCodeSessions).mockResolvedValue(
      sourceScan('claude-code', mockSessions)
    );
    vi.mocked(scan.scanCodexSessions).mockResolvedValue(
      sourceScan('codex', [])
    );

    const result = await detectLatestExternalLongSession(8);
    expect(result).toBeNull();
  });
});
