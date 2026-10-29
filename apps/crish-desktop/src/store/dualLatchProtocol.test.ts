import { beforeEach, describe, expect, it } from 'vitest';
import {
  DualLatchStateMachine,
  applyTerminalStatusLatch,
  dualLatchStateMachine,
  executeDualRafHandoff,
  resolveMonotonicRenderedText,
  resolveStreamMessageLatch,
  scheduleDualRafClearStream,
  scheduleDualRafClearStreams,
} from './dualLatchProtocol';
import {
  SubagentRuntimeBatcher,
  archiveFinalAgentsToSession,
  buildFinalSubagentSnapshots,
} from './sessionAgentActions';
import {
  clearSessionStreams,
  clearStream,
  clearStreams,
  getStreamText,
  setStreamText,
} from './streamingStore';
import type { SessionAgent, SessionState } from './types';

function createManualRafQueue() {
  let nextId = 1;
  const queue = new Map<number, (ts: number) => void>();
  let nowTs = 16;

  return {
    schedule: (cb: (ts: number) => void): number => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancel: (id: number): void => {
      queue.delete(id);
    },
    stepFrame: (): number => {
      const snapshot = [...queue.entries()];
      queue.clear();
      nowTs += 16;
      for (const [, cb] of snapshot) {
        cb(nowTs);
      }
      return snapshot.length;
    },
    pendingCount: (): number => queue.size,
  };
}

describe('Dual-Latch Handoff Protocol (Stage 02)', () => {
  beforeEach(() => {
    dualLatchStateMachine.clearAll();
    clearSessionStreams('sess-1');
    clearSessionStreams('sess-100');
    clearSessionStreams('sess-12-agents');
    clearSessionStreams('sess-cancel');
  });

  it('transitions deterministically through STREAMING -> LATCHED -> COMMITTED -> DRAINED', () => {
    const sm = new DualLatchStateMachine();

    const s1 = sm.markStreaming('sess-1', 'msg-1');
    expect(s1.phase).toBe('STREAMING');

    const s2 = sm.markLatched('sess-1', 'msg-1', 42);
    expect(s2.phase).toBe('LATCHED');
    expect(s2.latchedTextLength).toBe(42);

    // 迟到的较短长度不得回退 latchedTextLength
    const s2Monotonic = sm.markLatched('sess-1', 'msg-1', 10);
    expect(s2Monotonic.latchedTextLength).toBe(42);

    const s3 = sm.markCommitted('sess-1', 'msg-1');
    expect(s3.phase).toBe('COMMITTED');
    expect(s3.latchedTextLength).toBe(42);

    const s4 = sm.markDrained('sess-1', 'msg-1');
    expect(s4.phase).toBe('DRAINED');
    expect(s4.latchedTextLength).toBe(42);
  });

  it('performs synchronous semantic self-latch: msg.text becomes SSOT and streamText becomes undefined', () => {
    const rawMsg = {
      id: 'msg-latch',
      text: 'Hello',
      streamText: 'Hello, streaming world',
      status: 'processing',
    };

    const latched = resolveStreamMessageLatch(
      rawMsg,
      'Hello, streaming world! Complete.',
      'completed'
    );

    expect(latched.status).toBe('completed');
    expect(latched.text).toBe('Hello, streaming world! Complete.');
    expect(latched.streamText).toBeUndefined();

    // 若外部误传更短前缀，自锁存绝不回退已落盘长文本
    const monotonic = applyTerminalStatusLatch(latched, 'completed', 'Hello');
    expect(monotonic.text).toBe('Hello, streaming world! Complete.');
    expect(monotonic.streamText).toBeUndefined();
  });

  it('guarantees 0 blank frames across 100 terminal status handoffs via Dual-rAF', () => {
    const raf = createManualRafQueue();

    for (let i = 0; i < 100; i += 1) {
      const sessionId = 'sess-100';
      const messageId = `msg-${i}`;
      const expectedText = `Final response payload #${i} with markdown content.`;

      setStreamText(sessionId, messageId, expectedText);
      dualLatchStateMachine.markStreaming(sessionId, messageId);

      let persistentMsgText = '';

      // 1. 终态到达：同步执行第一重锁存（语义自锁存）
      const latched = resolveStreamMessageLatch(
        { id: messageId, text: '', status: 'processing' },
        getStreamText(sessionId, messageId),
        'completed'
      );
      persistentMsgText = latched.text;
      dualLatchStateMachine.markLatched(
        sessionId,
        messageId,
        persistentMsgText.length
      );

      // 2. 启动第二重锁存（双帧物理 rAF 握手）
      scheduleDualRafClearStream(sessionId, messageId, clearStream, {
        requestAnimationFrame: raf.schedule,
        cancelAnimationFrame: raf.cancel,
      });

      // 阶段 A（rAF 前）：持久态已就绪，流式缓冲尚未清除，任意路径渲染均无空白帧
      expect(dualLatchStateMachine.getPhase(sessionId, messageId)).toBe(
        'LATCHED'
      );
      expect(getStreamText(sessionId, messageId)).toBe(expectedText);
      expect(
        resolveMonotonicRenderedText(
          persistentMsgText,
          getStreamText(sessionId, messageId)
        )
      ).toBe(expectedText);

      // 阶段 B（第 1 帧 rAF）：推进至 COMMITTED，流式缓冲仍保留兜底
      raf.stepFrame();
      expect(dualLatchStateMachine.getPhase(sessionId, messageId)).toBe(
        'COMMITTED'
      );
      expect(getStreamText(sessionId, messageId)).toBe(expectedText);
      expect(
        resolveMonotonicRenderedText(
          persistentMsgText,
          getStreamText(sessionId, messageId)
        )
      ).toBe(expectedText);

      // 阶段 C（第 2 帧 rAF）：推进至 DRAINED，流式缓冲被精确回收，持久态无缝接管
      raf.stepFrame();
      expect(dualLatchStateMachine.getPhase(sessionId, messageId)).toBe(
        'DRAINED'
      );
      expect(getStreamText(sessionId, messageId)).toBeUndefined();
      expect(
        resolveMonotonicRenderedText(
          persistentMsgText,
          getStreamText(sessionId, messageId)
        )
      ).toBe(expectedText);
    }
  });

  it('atomically settles 12 concurrent subagents via SubagentRuntimeBatcher + Dual-rAF batch drain without clearing peer streams', () => {
    const raf = createManualRafQueue();
    const sessionId = 'sess-12-agents';
    const mainMessageId = 'msg-main';
    const peerStreamingMsgId = 'msg-peer-still-running';

    // 模拟同会话下另一条仍在流式输出的并发消息，验证绝不被 clearSession 误杀
    setStreamText(sessionId, peerStreamingMsgId, 'Peer live stream...');
    setStreamText(
      sessionId,
      mainMessageId,
      'Synthesized report from 12 agents.'
    );

    // 1. 构造 12 个并发子代理及各自的流式输出
    const sessionAgentsList: SessionAgent[] = [];
    const subagentMsgIds: string[] = [];

    for (let i = 1; i <= 12; i += 1) {
      const agentId = `subagent-${i}`;
      const subMsgId = `sub-msg-${i}`;
      subagentMsgIds.push(subMsgId);
      setStreamText(sessionId, subMsgId, `Subagent #${i} final findings`);
      sessionAgentsList.push({
        id: agentId,
        subagentRunId: `run-${i}`,
        parentSessionId: sessionId,
        parentRunId: 'parent-run-1',
        description: `Agent ${i}`,
        mode: 'research',
        status: 'completed',
        startedAt: 1000,
        endedAt: 2000,
        messages: [
          {
            id: subMsgId,
            sender: 'assistant',
            timestamp: 1500,
            text: `Subagent #${i} partial`,
            status: 'processing',
          },
        ],
      });
    }

    // 2. 验证运行期 SubagentRuntimeBatcher 48ms 合并：12 个子代理高频推送不克隆主消息列表
    const flushedDeltas: string[] = [];
    const runtimeBatcher = new SubagentRuntimeBatcher(
      (delta) => {
        flushedDeltas.push(`${delta.agentId}:${delta.text}`);
      },
      { intervalMs: 48 }
    );
    for (let i = 1; i <= 12; i += 1) {
      runtimeBatcher.push({
        sessionId,
        agentId: `subagent-${i}`,
        text: `step-1`,
      });
      runtimeBatcher.push({
        sessionId,
        agentId: `subagent-${i}`,
        text: `step-2`,
      });
    }
    runtimeBatcher.flushNow();
    expect(flushedDeltas).toHaveLength(12);
    expect(flushedDeltas[0]).toBe('subagent-1:step-2');
    runtimeBatcher.reset();

    // 3. 提取 12 个子代理的终态归档快照
    const { snapshots, finalizedMessageIds } = buildFinalSubagentSnapshots(
      sessionId,
      sessionAgentsList
    );
    expect(snapshots).toHaveLength(12);
    expect([...finalizedMessageIds].sort()).toEqual([...subagentMsgIds].sort());
    expect(snapshots[11]?.finalText).toBe('Subagent #12 final findings');

    // 4. 主消息 + 12 个子代理消息通过 Dual-rAF 定向批量回收（严禁 clearSession）
    scheduleDualRafClearStreams(
      sessionId,
      [mainMessageId, ...finalizedMessageIds],
      clearStreams,
      {
        requestAnimationFrame: raf.schedule,
        cancelAnimationFrame: raf.cancel,
      }
    );

    // rAF 前：目标流全部保留兜底，处于 LATCHED
    expect(dualLatchStateMachine.getPhase(sessionId, mainMessageId)).toBe(
      'LATCHED'
    );
    expect(getStreamText(sessionId, mainMessageId)).toBe(
      'Synthesized report from 12 agents.'
    );

    // 5. 第 1 帧：COMMITTED，流式缓冲仍在；第 2 帧：DRAINED，精确回收目标流，
    //    同会话下的并发流 peerStreamingMsgId 完好无损！
    raf.stepFrame();
    for (const subMsgId of finalizedMessageIds) {
      expect(dualLatchStateMachine.getPhase(sessionId, subMsgId)).toBe(
        'COMMITTED'
      );
      expect(getStreamText(sessionId, subMsgId)).toBeDefined();
    }
    raf.stepFrame();

    expect(dualLatchStateMachine.getPhase(sessionId, mainMessageId)).toBe(
      'DRAINED'
    );
    expect(getStreamText(sessionId, mainMessageId)).toBeUndefined();
    for (const subMsgId of finalizedMessageIds) {
      expect(getStreamText(sessionId, subMsgId)).toBeUndefined();
    }
    expect(getStreamText(sessionId, peerStreamingMsgId)).toBe(
      'Peer live stream...'
    );

    // 6. 验证 archiveFinalAgentsToSession 对 SessionState.finalAgents 的归档
    const mockSession: SessionState = {
      id: sessionId,
      title: 'Test',
      folder: 'general',
      isPinned: false,
      isArchived: false,
      timestamp: new Date().toISOString(),
      messages: [],
      agents: sessionAgentsList,
    };
    const archived = archiveFinalAgentsToSession(mockSession, snapshots, true);
    expect(archived).toHaveLength(12);
    expect(mockSession.agents).toHaveLength(0);
  });

  it('cancels in-flight Dual-rAF handoff cleanly when cancel callback is invoked', () => {
    const raf = createManualRafQueue();
    let drained = false;

    const cancel = executeDualRafHandoff({
      sessionId: 'sess-cancel',
      messageId: 'msg-cancel',
      latchedTextLength: 10,
      scheduleFrame: {
        requestAnimationFrame: raf.schedule,
        cancelAnimationFrame: raf.cancel,
      },
      onDrain: () => {
        drained = true;
      },
    });

    raf.stepFrame();
    expect(dualLatchStateMachine.getPhase('sess-cancel', 'msg-cancel')).toBe(
      'COMMITTED'
    );

    cancel();
    raf.stepFrame();
    expect(drained).toBe(false);
  });
});
