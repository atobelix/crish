import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async () => undefined),
}));

vi.mock('./transport', () => ({
  getTransport: () => ({ send: sendMock }),
}));

import {
  buildRunControlWireMessage,
  cancelModeForLevel,
  dispatchRunControl,
  requestFollowUp,
  requestSoftInject,
} from './runControlClient';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';
import { getControlMetrics, resetControlMetrics } from './controlMetrics';

describe('runControlClient', () => {
  beforeEach(() => {
    resetControlMetrics();
    sendMock.mockClear();
  });

  it('cancelModeForLevel maps L2/L3 only', () => {
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L0)).toBeNull();
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L1)).toBeNull();
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L2)).toBe('cooperative');
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L3)).toBe('force');
  });

  it('dispatchRunControl records L1/L2/L3 metrics', async () => {
    await dispatchRunControl({ level: RUN_CONTROL_LEVEL.L1 });
    await dispatchRunControl({ level: RUN_CONTROL_LEVEL.L2, runId: 'r1' });
    await dispatchRunControl({ level: RUN_CONTROL_LEVEL.L3, runId: 'r2' });
    const m = getControlMetrics();
    expect(m.run_control_L1).toBe(1);
    expect(m.run_control_L2).toBe(1);
    expect(m.run_control_L3).toBe(1);
  });

  it('buildRunControlWireMessage 构造 L2 协议帧', () => {
    expect(
      buildRunControlWireMessage({
        level: 'cooperative_stop',
        runId: 'run-1',
        sessionId: 'sess-1',
        reason: 'ui-stop',
      })
    ).toEqual({
      type: 'run-control',
      level: 'cooperative_stop',
      runId: 'run-1',
      sessionId: 'sess-1',
      reason: 'ui-stop',
    });
  });

  it('dispatchRunControl L2 仅发单一 core_run_control（Wave C 双线已删）', async () => {
    const ok = await dispatchRunControl({
      level: RUN_CONTROL_LEVEL.L2,
      runId: 'run-pair',
      sessionId: 'sess-p',
      reason: 'ui-stop',
    });
    expect(ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('core_run_control', {
      level: 'cooperative_stop',
      runId: 'run-pair',
      sessionId: 'sess-p',
      reason: 'ui-stop',
    });
  });

  it('dispatchRunControl L3 force 仅发单一 core_run_control（不附 cancel-run）', async () => {
    const ok = await dispatchRunControl({
      level: RUN_CONTROL_LEVEL.L3,
      runId: 'run-f',
      reason: 'ui-force-cancel',
    });
    expect(ok).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('core_run_control', {
      level: 'force_cancel',
      runId: 'run-f',
      reason: 'ui-force-cancel',
    });
  });

  it('requestFollowUp 为 L1 + payload.kind=follow_up（单 wire）', async () => {
    await requestFollowUp({
      sessionId: 'sess-1',
      runId: 'run-1',
      text: 'queue me',
      clientMessageId: 'user-1',
    });
    const m = getControlMetrics();
    expect(m.run_control_L1).toBe(1);
    expect(m.run_control_L2).toBe(0);
    expect(m.run_control_L3).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]![0]).toBe('core_run_control');
    expect(
      buildRunControlWireMessage({
        level: RUN_CONTROL_LEVEL.L1,
        sessionId: 'sess-1',
        runId: 'run-1',
        reason: 'ui-follow-up',
        payload: { kind: 'follow_up', text: 'queue me', clientMessageId: 'user-1' },
      })
    ).toMatchObject({
      type: 'run-control',
      level: 'soft_inject',
      sessionId: 'sess-1',
      runId: 'run-1',
      payload: {
        kind: 'follow_up',
        text: 'queue me',
        clientMessageId: 'user-1',
      },
    });
  });

  it('requestSoftInject 默认 kind soft_inject；可显式 steer', async () => {
    await requestSoftInject({ runId: 'r', text: 'nudge' });
    await requestSoftInject({ runId: 'r', text: 'steer', kind: 'steer' });
    expect(getControlMetrics().run_control_L1).toBe(2);
  });
});
