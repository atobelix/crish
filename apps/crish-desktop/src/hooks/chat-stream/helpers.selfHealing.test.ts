// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../store/sessionStore';
import { SessionStreamManager } from '../../api/sessionStreamManager';
import { isSessionAiBusy, settleStaleSessionProcessingMessages } from './helpers';
import type { Session, SessionMessage } from '../../store/sessionStore';

const TEST_SESSION_ID = 'test-session-self-healing';

function setupTestSession(messages: Partial<SessionMessage>[] = []) {
  const session: Session = {
    id: TEST_SESSION_ID,
    title: 'Self Healing Test Session',
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: new Date().toISOString(),
    messages: messages.map((m, idx) => ({
      id: m.id || `msg-${idx}`,
      sender: m.sender || 'assistant',
      text: m.text ?? 'some content',
      timestamp: m.timestamp ?? Date.now(),
      status: m.status || 'completed',
      thinking: m.thinking,
      errorDetail: m.errorDetail,
    })) as SessionMessage[],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  useSessionStore.setState((state) => ({
    sessionsById: {
      ...state.sessionsById,
      [TEST_SESSION_ID]: session,
    },
    sessions: [session],
    activeSessionId: TEST_SESSION_ID,
  }));
}

describe('helpers.ts - 对话流自愈与死锁根除断言 (Self-Healing & Anti-Deadlock)', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionsById: {},
      sessions: [],
      activeSessionId: null,
    });
  });

  it('当存在残留 processing/queued 且无真实流时，settleStaleSessionProcessingMessages 自动清理孤儿状态收束为 error/completed', () => {
    setupTestSession([
      { id: 'user-1', sender: 'user', text: '你好', status: 'completed' },
      { id: 'asst-stale', sender: 'assistant', text: '部分生成的内容...', status: 'processing' },
      { id: 'asst-queued', sender: 'assistant', text: '', status: 'queued' },
    ]);

    // 触发自愈（hasLiveStream = false）
    const result = settleStaleSessionProcessingMessages(TEST_SESSION_ID, false);
    expect(result.healedCount).toBe(1);
    expect(result.clearedQueueCount).toBe(1);

    const session = useSessionStore.getState().sessionsById[TEST_SESSION_ID];
    const staleMsg = session?.messages.find((m) => m.id === 'asst-stale');
    const queuedMsg = session?.messages.find((m) => m.id === 'asst-queued');

    expect(staleMsg?.status).toBe('error');
    // 单轨收敛：自愈不再写 errorDetail 气泡错误卡（partial 文本保留即可）
    expect(staleMsg?.text).toBe('部分生成的内容...');
    expect(staleMsg?.errorDetail).toBeUndefined();
    expect(queuedMsg?.status).toBe('completed');
  });

  it('当存在真实活跃流时，settleStaleSessionProcessingMessages 绝不误伤正在流式传输的消息', () => {
    setupTestSession([
      { id: 'user-1', sender: 'user', text: '你好', status: 'completed' },
      { id: 'asst-live', sender: 'assistant', text: '正在实时流式生成...', status: 'processing' },
    ]);

    // 触发自愈（hasLiveStream = true）
    const result = settleStaleSessionProcessingMessages(TEST_SESSION_ID, true);
    expect(result.healedCount).toBe(0);
    expect(result.clearedQueueCount).toBe(0);

    const session = useSessionStore.getState().sessionsById[TEST_SESSION_ID];
    const liveMsg = session?.messages.find((m) => m.id === 'asst-live');
    expect(liveMsg?.status).toBe('processing');
  });

  it('isSessionAiBusy 核心防御：当无活跃流时，即便历史消息残留 processing 也绝不判定为忙碌（彻底打通打回死锁）', () => {
    setupTestSession([
      { id: 'asst-stale', sender: 'assistant', text: '', status: 'processing' },
    ]);

    const session = useSessionStore.getState().sessionsById[TEST_SESSION_ID];

    // 关键断言：hasLiveStream 为 false 时，绝对不返回 busy！
    const busy = isSessionAiBusy({
      hasLiveStream: false,
      messages: session?.messages,
    });
    expect(busy).toBe(false);
  });

  it('isSessionAiBusy 在真正存在活跃流时严格返回 true', () => {
    setupTestSession([
      { id: 'asst-live', sender: 'assistant', text: '', status: 'processing' },
    ]);

    const session = useSessionStore.getState().sessionsById[TEST_SESSION_ID];

    const busy = isSessionAiBusy({
      hasLiveStream: true,
      messages: session?.messages,
    });
    expect(busy).toBe(true);
  });
});
