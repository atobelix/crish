/**
 * resolveApprovalRunId 解析顺序测试（批 C 第 0 件，2026-11-03）。
 *
 * 背景：core_approve_tool / core_deny_tool 的 run_id 为 Rust 必填参数，
 * 缺失时 invoke 在 Tauri 参数层被拒、用户裁决永远送不到闸门（「批准
 * 失败」+ 120s 过期）。本解析器是全部裁决调用面的唯一 runId 来源，
 * 顺序钉死：申请人快照 → agent run → 会话活动 run → 会话最近 run。
 */
import { describe, expect, it, vi } from 'vitest';

const streamRunIds = new Map<string, string | null>();
const sessionLastRunIds = new Map<string, string | undefined>();

vi.mock('../sessionStreamManager', () => ({
  sessionStreams: {
    get: (sessionId: string) =>
      streamRunIds.has(sessionId)
        ? { runId: streamRunIds.get(sessionId) }
        : undefined,
  },
}));

vi.mock('../../store/storeAccess', () => ({
  getSessionById: (sessionId: string) =>
    sessionLastRunIds.has(sessionId)
      ? { engineLastRunId: sessionLastRunIds.get(sessionId) }
      : undefined,
}));

import { resolveApprovalRunId } from './approvalRunId';
import type { MessageToolCall } from '../../store/types';

function toolCallWithRequester(
  runId?: string
): Pick<MessageToolCall, 'approvalMeta'> {
  return {
    approvalMeta: runId === undefined ? undefined : { requester: { runId } },
  } as Pick<MessageToolCall, 'approvalMeta'>;
}

describe('resolveApprovalRunId', () => {
  it('申请人快照（子 agent 发起）优先于一切兜底', () => {
    streamRunIds.set('s1', 'run-stream');
    sessionLastRunIds.set('s1', 'run-last');
    expect(
      resolveApprovalRunId({
        sessionId: 's1',
        toolCall: toolCallWithRequester('run-requester'),
        agentRunId: 'run-agent',
      })
    ).toBe('run-requester');
  });

  it('无申请人快照时用 agentRunId（子 agent 面板面）', () => {
    streamRunIds.set('s2', 'run-stream');
    expect(
      resolveApprovalRunId({
        sessionId: 's2',
        toolCall: toolCallWithRequester(undefined),
        agentRunId: 'run-agent',
      })
    ).toBe('run-agent');
  });

  it('主 agent 审批：会话活动 run（sessionStreams）', () => {
    streamRunIds.set('s3', 'run-stream');
    sessionLastRunIds.set('s3', 'run-last');
    expect(resolveApprovalRunId({ sessionId: 's3' })).toBe('run-stream');
  });

  it('流注册已释放：回落会话最近 run（engineLastRunId）', () => {
    sessionLastRunIds.set('s4', 'run-last');
    expect(resolveApprovalRunId({ sessionId: 's4' })).toBe('run-last');
  });

  it('全部落空 → 空串（engine 层显式抛错，不发必死请求）', () => {
    expect(resolveApprovalRunId({ sessionId: 'nope' })).toBe('');
    expect(resolveApprovalRunId({ sessionId: '' })).toBe('');
  });

  it('空白申请人 runId 视为未标注，继续向下解析', () => {
    streamRunIds.set('s5', 'run-stream');
    expect(
      resolveApprovalRunId({
        sessionId: 's5',
        toolCall: toolCallWithRequester('   '),
      })
    ).toBe('run-stream');
  });
});
