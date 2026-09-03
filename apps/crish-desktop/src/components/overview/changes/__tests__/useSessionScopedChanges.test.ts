// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionScopedChanges } from '../useSessionScopedChanges';
import { useSessionStore } from '../../../../store/sessionStore';
import { useTerminalStore } from '../../../../store/terminalStore';
import type { SessionState, SessionMessage } from '../../../../store/types';

describe('useSessionScopedChanges — 会话作用域文件改动隔离测试', () => {
  beforeEach(() => {
    useSessionStore.setState({
      activeSessionId: 'sess-1',
      sessions: [
        {
          id: 'sess-1',
          title: '会话 1',
          folder: 'conex',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
        },
      ] as SessionState[],
      sessionsById: {
        'sess-1': {
          id: 'sess-1',
          title: '会话 1',
          folder: 'conex',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
        } as SessionState,
      },
    });

    useTerminalStore.setState({
      diffFiles: [],
      activeDiffSource: null,
    });
  });

  it('新会话或无消息时，严格返回空改动列表且 isEmpty 为 true', () => {
    const { result } = renderHook(() => useSessionScopedChanges());
    expect(result.current.sessionFiles).toEqual([]);
    expect(result.current.totalFiles).toBe(0);
    expect(result.current.isEmpty).toBe(true);
  });

  it('仅统计成功执行的写文件与编辑工具调用', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: '修改文件',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-1',
            name: 'write_to_file',
            arguments: { TargetFile: 'src/app.ts', CodeContent: 'console.log("hi");' },
            status: 'completed',
          },
          {
            id: 'tc-2',
            name: 'replace_file_content',
            arguments: { TargetFile: 'src/bad.ts', TargetContent: 'a', ReplacementContent: 'b' },
            status: 'error', // 报错不计入
          },
        ],
      },
    ];

    useSessionStore.setState((s) => {
      const sess = s.sessions.find((x) => x.id === 'sess-1');
      if (sess) sess.messages = messages;
      const sessById = s.sessionsById['sess-1'];
      if (sessById) sessById.messages = messages;
    });

    const { result } = renderHook(() => useSessionScopedChanges());
    expect(result.current.totalFiles).toBe(1);
    expect(result.current.sessionFiles[0]?.filePath).toBe('src/app.ts');
    expect(result.current.isEmpty).toBe(false);
  });

  it('支持聚合多 Agent 协同产生的文件改动', () => {
    const messages: SessionMessage[] = [];
    const agentMessages: SessionMessage[] = [
      {
        id: 'sub-msg-1',
        role: 'assistant',
        content: '子 agent 写入',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-sub-1',
            name: 'write_to_file',
            arguments: { TargetFile: 'src/subagent.ts', CodeContent: 'export const sub = true;' },
            status: 'completed',
          },
        ],
      },
    ];

    useSessionStore.setState((s) => {
      const agents = [
        {
          id: 'agent-1',
          parentSessionId: 'sess-1',
          parentRunId: 'run-1',
          description: '测试 Agent',
          mode: 'implement',
          status: 'completed' as const,
          startedAt: Date.now(),
          messages: agentMessages,
        },
      ];
      const sess = s.sessions.find((x) => x.id === 'sess-1');
      if (sess) {
        sess.messages = messages;
        sess.agents = agents;
      }
      const sessById = s.sessionsById['sess-1'];
      if (sessById) {
        sessById.messages = messages;
        sessById.agents = agents;
      }
    });

    const { result } = renderHook(() => useSessionScopedChanges());
    expect(result.current.totalFiles).toBe(1);
    expect(result.current.sessionFiles[0]?.filePath).toBe('src/subagent.ts');
  });

  it('会话切换时，改动列表即时重置为目标会话数据，绝不跨会话残留', () => {
    useSessionStore.setState({
      activeSessionId: 'sess-2',
      sessionsById: {
        'sess-2': {
          id: 'sess-2',
          title: '会话 2',
          folder: 'conex',
          isPinned: false,
          isArchived: false,
          timestamp: new Date().toISOString(),
          messages: [],
        } as SessionState,
      },
    });

    const { result } = renderHook(() => useSessionScopedChanges());
    expect(result.current.totalFiles).toBe(0);
    expect(result.current.isEmpty).toBe(true);
  });
});
