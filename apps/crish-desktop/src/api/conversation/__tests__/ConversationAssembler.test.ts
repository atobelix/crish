/**
 * ConversationAssembler 增量状态机引擎单元测试
 * 
 * 依据: docs/linear-chat-stream-convergence/01-维度详案-数据链路单轨化与列表Props解耦.md §1.1, §1.3, §5.1
 * 
 * 核心断言覆盖:
 * 1. 单调 seq 滑动窗口校验、幂等去重与丢包跳号容灾断言
 * 2. Definition 模式动态认领、start/update 纯逻辑折叠与 publication 节奏断言
 * 3. clientMessageId (rpcId) Echo 同帧互斥排他物化与防双气泡断言
 * 4. 不可变快照物化 (Object.freeze、ReadonlyMap 防篡改、单调 revision)
 * 5. 脏节点延迟物化与干净节点引用稳定性 (Reference Equality)
 * 6. 订阅者广播 (subscribe)、水合 (hydrate) 与重置 (reset) 容灾
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ConversationAssembler,
  buildSnapshotWithEchoExclusion,
} from '../ConversationAssembler';
import type {
  ConversationNodeDefinition,
  ConversationNodeViewData,
  PublicationRhythm,
  SessionEventEnvelope,
  SubmissionEcho,
} from '../types';

// ==========================================
// 辅助 Mock Definition 构造器
// ==========================================

interface AssistantNodeState {
  id: string;
  turnId: string;
  text: string;
  completed: boolean;
  toolCallCount: number;
}

function createAssistantDefinition(): ConversationNodeDefinition<AssistantNodeState, ConversationNodeViewData> {
  return {
    kind: 'assistant',
    getNodeKey(event: SessionEventEnvelope): string {
      return event.turnId ? `turn:${event.turnId}:assistant` : `node:${event.sessionId}:assistant`;
    },
    match(event: SessionEventEnvelope): boolean {
      return (
        event.type === 'chunk' ||
        event.type === 'message_end' ||
        event.type === 'assistant_start'
      );
    },
    start(event: SessionEventEnvelope): AssistantNodeState {
      return {
        id: event.turnId ? `msg_assistant_${event.turnId}` : `msg_${event.seq}`,
        turnId: event.turnId || 'turn_default',
        text: typeof event.payload === 'string' ? event.payload : (event.payload as { text?: string })?.text || '',
        completed: event.type === 'message_end',
        toolCallCount: 0,
      };
    },
    update(prevState: AssistantNodeState, event: SessionEventEnvelope): AssistantNodeState {
      const addedText = typeof event.payload === 'string' ? event.payload : (event.payload as { text?: string })?.text || '';
      return {
        ...prevState,
        text: prevState.text + addedText,
        completed: prevState.completed || event.type === 'message_end',
      };
    },
    publication(nextState: AssistantNodeState, prevState: AssistantNodeState): PublicationRhythm {
      if (nextState.completed && !prevState.completed) {
        return 'immediate';
      }
      return 'animation-frame';
    },
    buildViewNode(state: AssistantNodeState): ConversationNodeViewData {
      return {
        id: state.id,
        kind: 'assistant',
        sender: 'assistant',
        text: state.text,
        timestamp: 1000,
        completed: state.completed,
      };
    },
  };
}

interface UserNodeState {
  id: string;
  rpcId?: string;
  text: string;
}

function createUserDefinition(): ConversationNodeDefinition<UserNodeState, ConversationNodeViewData> {
  return {
    kind: 'user',
    getNodeKey(event: SessionEventEnvelope): string {
      return event.clientMessageId
        ? `user:${event.clientMessageId}`
        : `user:${event.turnId || event.seq}`;
    },
    match(event: SessionEventEnvelope): boolean {
      return event.type === 'user_message';
    },
    start(event: SessionEventEnvelope): UserNodeState {
      const payload = event.payload as { text?: string; id?: string };
      return {
        id: payload?.id || `user_msg_${event.seq}`,
        rpcId: event.clientMessageId,
        text: payload?.text || '',
      };
    },
    update(prevState: UserNodeState, event: SessionEventEnvelope): UserNodeState {
      return prevState;
    },
    publication(): PublicationRhythm {
      return 'immediate';
    },
    buildViewNode(state: UserNodeState): ConversationNodeViewData {
      return {
        id: state.id,
        rpcId: state.rpcId,
        kind: 'user',
        sender: 'user',
        text: state.text,
        timestamp: 1000,
      };
    },
  };
}

interface ToolNodeState {
  id: string;
  toolName: string;
  status: 'running' | 'completed';
}

function createToolDefinition(): ConversationNodeDefinition<ToolNodeState, ConversationNodeViewData> {
  return {
    kind: 'tool',
    getNodeKey(event: SessionEventEnvelope): string {
      const payload = event.payload as { toolCallId: string };
      return `tool:${payload.toolCallId}`;
    },
    match(event: SessionEventEnvelope): boolean {
      return event.type === 'tool_started' || event.type === 'tool_finished';
    },
    start(event: SessionEventEnvelope): ToolNodeState {
      const payload = event.payload as { toolCallId: string; toolName: string };
      return {
        id: payload.toolCallId,
        toolName: payload.toolName,
        status: event.type === 'tool_finished' ? 'completed' : 'running',
      };
    },
    update(prevState: ToolNodeState, event: SessionEventEnvelope): ToolNodeState {
      return {
        ...prevState,
        status: event.type === 'tool_finished' ? 'completed' : prevState.status,
      };
    },
    publication(nextState: ToolNodeState): PublicationRhythm {
      return 'immediate';
    },
    buildViewNode(state: ToolNodeState): ConversationNodeViewData {
      return {
        id: state.id,
        kind: 'tool',
        sender: 'system',
        timestamp: 1000,
        toolName: state.toolName,
        status: state.status,
      };
    },
  };
}

// ==========================================
// 测试套件开始
// ==========================================

describe('ConversationAssembler 单轨增量状态机引擎测试', () => {
  const SESSION_ID = 'session_test_001';

  // ----------------------------------------------------
  // 1. 单调 seq 滑动窗口与幂等去重
  // ----------------------------------------------------
  describe('1. 单调 seq 滑动窗口校验与幂等去重拦截', () => {
    it('连续严格自增的合法事件应被成功处理并推进 lastProcessedSeq', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      const res1 = assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Hello',
        timestamp: 1001,
      });

      expect(res1.accepted).toBe(true);
      expect(res1.reason).toBe('processed');
      expect(assembler.getLastProcessedSeq()).toBe(1);

      const res2 = assembler.processEvent({
        seq: 2,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: ' World',
        timestamp: 1002,
      });

      expect(res2.accepted).toBe(true);
      expect(assembler.getLastProcessedSeq()).toBe(2);
      expect(assembler.getMetrics().processedEventCount).toBe(2);
      expect(assembler.getMetrics().droppedDeduplicatedCount).toBe(0);
    });

    it('乱序或重复事件（seq <= lastProcessedSeq）被状态机静默丢弃，内部 State 保持纯净', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      // 处理 seq = 1, 2, 3
      assembler.processEvent({ seq: 1, sessionId: SESSION_ID, turnId: 't1', type: 'chunk', payload: 'A', timestamp: 1001 });
      assembler.processEvent({ seq: 2, sessionId: SESSION_ID, turnId: 't1', type: 'chunk', payload: 'B', timestamp: 1002 });
      assembler.processEvent({ seq: 3, sessionId: SESSION_ID, turnId: 't1', type: 'chunk', payload: 'C', timestamp: 1003 });

      expect(assembler.getLastProcessedSeq()).toBe(3);

      // 模拟网络重复投递：重投 seq = 2
      const dup2 = assembler.processEvent({
        seq: 2,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'DUPLICATE_B',
        timestamp: 1004,
      });

      expect(dup2.accepted).toBe(false);
      expect(dup2.reason).toBe('duplicate_seq');
      expect(dup2.rhythm).toBe('none');

      // 模拟过期乱序：投递更旧的 seq = 1
      const dup1 = assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'STALE_A',
        timestamp: 1005,
      });

      expect(dup1.accepted).toBe(false);
      expect(dup1.reason).toBe('duplicate_seq');

      // 指标验证
      const metrics = assembler.getMetrics();
      expect(metrics.processedEventCount).toBe(3);
      expect(metrics.droppedDeduplicatedCount).toBe(2);
      expect(assembler.getLastProcessedSeq()).toBe(3);

      // 验证内部文本未被重复或旧包污染
      const snapshot = assembler.getSnapshot();
      const node = snapshot.nodes.get('msg_assistant_t1');
      expect(node?.text).toBe('ABC');
    });

    it('检测到序列号断裂（跳号丢包）时记录指标与容灾告警', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      // seq: 1 到达
      assembler.processEvent({ seq: 1, sessionId: SESSION_ID, turnId: 't1', type: 'chunk', payload: 'Part1', timestamp: 1001 });

      // seq: 5 到达 (发生丢包跳号: expectedSeq: 2, receivedSeq: 5)
      const resGap = assembler.processEvent({
        seq: 5,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Part5',
        timestamp: 1005,
      });

      expect(resGap.accepted).toBe(true);
      expect(assembler.getLastProcessedSeq()).toBe(5);

      const metrics = assembler.getMetrics();
      expect(metrics.sequenceGapsCount).toBe(1);
      expect(metrics.lastSequenceGap).toEqual({
        expectedSeq: 2,
        receivedSeq: 5,
        timestamp: 1005,
      });
    });

    it('跨 session 事件若不匹配 assembler.sessionId 则拦截拒收', () => {
      const assembler = new ConversationAssembler({ sessionId: 'session_A' });
      assembler.registerDefinition(createAssistantDefinition());

      const res = assembler.processEvent({
        seq: 1,
        sessionId: 'session_B',
        type: 'chunk',
        payload: 'hello',
        timestamp: 1000,
      });

      expect(res.accepted).toBe(false);
      expect(res.reason).toBe('session_mismatch');
      expect(assembler.getMetrics().processedEventCount).toBe(0);
    });
  });

  // ----------------------------------------------------
  // 2. Definition 模式动态认领与增量累加折叠
  // ----------------------------------------------------
  describe('2. Definition 动态认领与增量状态折叠', () => {
    it('多个 Definition 注册后，各事件精准分发至对应 Definition', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinitions([
        createUserDefinition(),
        createAssistantDefinition(),
        createToolDefinition(),
      ]);

      // 1. 用户消息事件
      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        type: 'user_message',
        payload: { id: 'u_1', text: 'Run bash' },
        timestamp: 1001,
      });

      // 2. 助手流式事件
      assembler.processEvent({
        seq: 2,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Executing...',
        timestamp: 1002,
      });

      // 3. 工具事件
      assembler.processEvent({
        seq: 3,
        sessionId: SESSION_ID,
        type: 'tool_started',
        payload: { toolCallId: 'tool_1', toolName: 'bash' },
        timestamp: 1003,
      });

      const snapshot = assembler.getSnapshot();
      expect(snapshot.order).toHaveLength(3);
      expect(snapshot.nodes.get('u_1')?.kind).toBe('user');
      expect(snapshot.nodes.get('msg_assistant_t1')?.kind).toBe('assistant');
      expect(snapshot.nodes.get('tool_1')?.kind).toBe('tool');
    });

    it('连续 chunk 累加折叠，并在 message_end 产生 immediate 终态发布节奏', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      const r1 = assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Hello',
        timestamp: 1000,
      });
      expect(r1.rhythm).toBe('animation-frame');

      const r2 = assembler.processEvent({
        seq: 2,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: ' World',
        timestamp: 1001,
      });
      expect(r2.rhythm).toBe('animation-frame');

      const rEnd = assembler.processEvent({
        seq: 3,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'message_end',
        payload: '!',
        timestamp: 1002,
      });
      expect(rEnd.rhythm).toBe('immediate');

      const snapshot = assembler.getSnapshot();
      const node = snapshot.nodes.get('msg_assistant_t1');
      expect(node?.text).toBe('Hello World!');
      expect(node?.completed).toBe(true);
    });

    it('未被任何 Definition 认领的事件返回 no_definition_match', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      const res = assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        type: 'unknown_alien_event',
        payload: {},
        timestamp: 1000,
      });

      expect(res.accepted).toBe(false);
      expect(res.reason).toBe('no_definition_match');
      expect(assembler.getSnapshot().order).toHaveLength(0);
    });
  });

  // ----------------------------------------------------
  // 3. clientMessageId (rpcId) Echo 同帧互斥换装
  // ----------------------------------------------------
  describe('3. echo → durable 用户发问同帧互斥原子换装断言', () => {
    it('在持久化消息未到达前，快照呈现本地乐观回显 (user-echo)', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createUserDefinition());

      // 用户敲击回车，本地注入回显
      assembler.addPendingEcho({
        echoId: 'echo_msg_100',
        rpcId: 'rpc_req_42',
        prompt: 'How to write Rust tests?',
        timestamp: 1000,
        status: 'pending',
      });

      const snapshot = assembler.getSnapshot();
      expect(snapshot.order).toContain('echo:echo_msg_100');
      const echoNode = snapshot.nodes.get('echo:echo_msg_100');
      expect(echoNode).toBeDefined();
      expect(echoNode?.kind).toBe('user-echo');
      expect(echoNode?.isEcho).toBe(true);
      expect(echoNode?.text).toBe('How to write Rust tests?');
      expect(echoNode?.submissionStatus).toBe('pending');
    });

    it('更新 echo 状态 (pending -> submitting) 正确在快照中反映', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.addPendingEcho({
        echoId: 'echo_msg_100',
        rpcId: 'rpc_req_42',
        prompt: 'Prompt',
        timestamp: 1000,
        status: 'pending',
      });

      const updated = assembler.updatePendingEchoStatus('rpc_req_42', 'submitting');
      expect(updated).toBe(true);

      const snapshot = assembler.getSnapshot();
      const echoNode = snapshot.nodes.get('echo:echo_msg_100');
      expect(echoNode?.submissionStatus).toBe('submitting');
    });

    it('持久化消息到达命中相同 rpcId 时，本地 echo 当帧排他抑制，绝无双气泡瞬态', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createUserDefinition());

      // Frame T0: 用户敲回车注入回显
      assembler.addPendingEcho({
        echoId: 'echo_42',
        rpcId: 'rpc_req_42',
        prompt: 'Explain borrow checker',
        timestamp: 1000,
        status: 'submitting',
      });

      const snapT0 = assembler.getSnapshot();
      expect(snapT0.order).toEqual(['echo:echo_42']);
      expect(snapT0.nodes.has('echo:echo_42')).toBe(true);

      // Frame T1: 引擎返回真实持久化消息 (携带相同 clientMessageId / rpcId)
      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        clientMessageId: 'rpc_req_42',
        type: 'user_message',
        payload: { id: 'durable_user_999', text: 'Explain borrow checker' },
        timestamp: 1001,
      });

      const snapT1 = assembler.getSnapshot();

      // 断言：order 中绝无 echo，只有持久消息
      expect(snapT1.order).toEqual(['durable_user_999']);
      expect(snapT1.nodes.has('durable_user_999')).toBe(true);
      expect(snapT1.nodes.has('echo:echo_42')).toBe(false);

      // 双气泡排他断言：同帧中针对该 rpcId 气泡数量严格为 1
      const matchingBubbles = snapT1.order.filter(
        (id) => id === 'echo:echo_42' || id === 'durable_user_999'
      );
      expect(matchingBubbles).toHaveLength(1);
    });

    it('发送失败时 echo 转换为 failed 状态，保留在原位供用户重试', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.addPendingEcho({
        echoId: 'echo_fail',
        rpcId: 'rpc_fail_1',
        prompt: 'Retry prompt',
        timestamp: 1000,
        status: 'submitting',
      });

      assembler.updatePendingEchoStatus('rpc_fail_1', 'failed', 'Network timeout');

      const snapshot = assembler.getSnapshot();
      const node = snapshot.nodes.get('echo:echo_fail');
      expect(node?.submissionStatus).toBe('failed');
      expect(node?.error).toBe('Network timeout');
      expect(snapshot.order).toContain('echo:echo_fail');
    });

    it('buildSnapshotWithEchoExclusion 纯函数行为穷尽验证', () => {
      const durable: ConversationNodeViewData[] = [
        { id: 'm1', rpcId: 'rpc_1', kind: 'user', sender: 'user', timestamp: 100 },
        { id: 'm2', kind: 'assistant', sender: 'assistant', timestamp: 101 },
      ];
      const echoes: SubmissionEcho[] = [
        { echoId: 'e1', rpcId: 'rpc_1', prompt: 'echo 1', timestamp: 90, status: 'submitting' }, // 应被抑制
        { echoId: 'e2', rpcId: 'rpc_2', prompt: 'echo 2', timestamp: 95, status: 'pending' },    // 应被放行
      ];

      const snapshot = buildSnapshotWithEchoExclusion(durable, echoes, 42);

      expect(snapshot.order).toEqual(['m1', 'm2', 'echo:e2']);
      expect(snapshot.nodes.has('m1')).toBe(true);
      expect(snapshot.nodes.has('m2')).toBe(true);
      expect(snapshot.nodes.has('echo:e1')).toBe(false);
      expect(snapshot.nodes.has('echo:e2')).toBe(true);
      expect(snapshot.revision).toBe(42);
    });
  });

  // ----------------------------------------------------
  // 4. 不可变快照输出与引用稳定性
  // ----------------------------------------------------
  describe('4. 不可变快照物化与增量引用稳定性', () => {
    it('快照 order 数组、nodes Map 及快照本身均被严格浅冻结，禁止运行时逆向篡改', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Readonly',
        timestamp: 1000,
      });

      const snapshot = assembler.getSnapshot();

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.order)).toBe(true);
      expect(Object.isFrozen(snapshot.nodes)).toBe(true);

      // 试图通过 mutating 操作篡改 Map 应抛出异常
      expect(() => {
        (snapshot.nodes as Map<string, any>).set('illegal', {} as any);
      }).toThrow(/Cannot modify read-only ConversationSnapshot.nodes/);

      expect(() => {
        (snapshot.nodes as Map<string, any>).delete('msg_assistant_t1');
      }).toThrow(/Cannot modify read-only ConversationSnapshot.nodes/);

      expect(() => {
        (snapshot.nodes as Map<string, any>).clear();
      }).toThrow(/Cannot modify read-only ConversationSnapshot.nodes/);
    });

    it('每次产生状态跃迁物化新快照时，revision 严格单调自增', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      const s0 = assembler.getSnapshot();
      const rev0 = s0.revision;

      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'A',
        timestamp: 1000,
      });

      const s1 = assembler.getSnapshot();
      expect(s1.revision).toBeGreaterThan(rev0);

      assembler.processEvent({
        seq: 2,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'B',
        timestamp: 1001,
      });

      const s2 = assembler.getSnapshot();
      expect(s2.revision).toBeGreaterThan(s1.revision);
    });

    it('未变更节点的 ViewNode 保持引用全等（Reference Equality），受影响的节点物化新引用', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinitions([
        createUserDefinition(),
        createAssistantDefinition(),
      ]);

      // 节点 1: 用户消息
      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        type: 'user_message',
        payload: { id: 'user_node', text: 'Hello' },
        timestamp: 1000,
      });

      // 节点 2: 助手开始
      assembler.processEvent({
        seq: 2,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Chunk 1',
        timestamp: 1001,
      });

      const snapshotA = assembler.getSnapshot();
      const userNodeA = snapshotA.nodes.get('user_node');
      const assistantNodeA = snapshotA.nodes.get('msg_assistant_t1');

      // 仅更新助手节点 2
      assembler.processEvent({
        seq: 3,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Chunk 2',
        timestamp: 1002,
      });

      const snapshotB = assembler.getSnapshot();
      const userNodeB = snapshotB.nodes.get('user_node');
      const assistantNodeB = snapshotB.nodes.get('msg_assistant_t1');

      // 断言：用户节点没有被污染，ViewNode 引用恒定保持 ===
      expect(userNodeA).toBe(userNodeB);

      // 断言：助手节点发生状态变更，ViewNode 引用已更新 !==
      expect(assistantNodeA).not.toBe(assistantNodeB);
      expect(assistantNodeB?.text).toBe('Chunk 1Chunk 2');
    });

    it('无任何变更时重复调用 getSnapshot() 返回同一不可变快照引用', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Static',
        timestamp: 1000,
      });

      const snap1 = assembler.getSnapshot();
      const snap2 = assembler.getSnapshot();

      expect(snap1).toBe(snap2);
    });
  });

  // ----------------------------------------------------
  // 5. 订阅、水合与容灾重置
  // ----------------------------------------------------
  describe('5. 订阅者广播、水合全量替换与重置容灾', () => {
    it('subscribe 监听器能在 emitSnapshot 及 immediate 节奏时收到快照推送', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      const listener = vi.fn();
      const unsubscribe = assembler.subscribe(listener);

      // chunk (animation-frame): 不自动 emitSnapshot
      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'Test',
        timestamp: 1000,
      });
      expect(listener).not.toHaveBeenCalled();

      // 手动触发 emitSnapshot
      assembler.emitSnapshot('animation-frame');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.anything(), 'animation-frame');

      // message_end (immediate): 自动同步 emitSnapshot
      assembler.processEvent({
        seq: 2,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'message_end',
        payload: 'Done',
        timestamp: 1001,
      });
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(expect.anything(), 'immediate');

      // 取消订阅
      unsubscribe();
      assembler.emitSnapshot('immediate');
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('hydrate 全量水合可原子重构快照与序列号基线', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      const historyNodes: ConversationNodeViewData[] = [
        { id: 'h1', kind: 'user', sender: 'user', text: 'Hi', timestamp: 500 },
        { id: 'h2', kind: 'assistant', sender: 'assistant', text: 'Hello', timestamp: 600 },
      ];

      const snapshot = assembler.hydrate(historyNodes, 50);

      expect(assembler.getLastProcessedSeq()).toBe(50);
      expect(snapshot.order).toEqual(['h1', 'h2']);
      expect(snapshot.nodes.get('h1')?.text).toBe('Hi');
      expect(snapshot.nodes.get('h2')?.text).toBe('Hello');

      // 序列号基线已被提升到 50，seq <= 50 应被去重拦截
      const dup = assembler.processEvent({
        seq: 40,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'old',
        timestamp: 1000,
      });
      expect(dup.accepted).toBe(false);

      // seq: 51 应被正常接收
      const valid = assembler.processEvent({
        seq: 51,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'new',
        timestamp: 1001,
      });
      expect(valid.accepted).toBe(true);
    });

    it('reset 可彻底清空状态并重新从指定 seq 起步', () => {
      const assembler = new ConversationAssembler({ sessionId: SESSION_ID });
      assembler.registerDefinition(createAssistantDefinition());

      assembler.processEvent({
        seq: 1,
        sessionId: SESSION_ID,
        turnId: 't1',
        type: 'chunk',
        payload: 'CleanMe',
        timestamp: 1000,
      });
      expect(assembler.getLastProcessedSeq()).toBe(1);

      assembler.reset({ initialSeq: 10 });
      expect(assembler.getLastProcessedSeq()).toBe(10);
      expect(assembler.getMetrics().processedEventCount).toBe(0);
      expect(assembler.getMetrics().droppedDeduplicatedCount).toBe(0);

      const snapshot = assembler.getSnapshot();
      expect(snapshot.order).toHaveLength(0);
      expect(snapshot.nodes.size).toBe(0);
    });
  });
});
