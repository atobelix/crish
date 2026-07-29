import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCancelRunWireMessage,
  buildRunControlWireMessage,
  cancelModeForLevel,
  dispatchRunControl,
  requestFollowUp,
  requestSoftInject,
  sendTerminateDualWire,
  TRANSITIONAL_DUAL_CANCEL_RUN_WIRE,
} from './runControlClient';
import { RUN_CONTROL_LEVEL } from '@crish/shared-types';
import { getControlMetrics, resetControlMetrics } from './controlMetrics';

vi.mock('./daemonClient', () => ({
  getDesktopDaemonClient: () => {
    throw new Error('no-daemon-in-unit');
  },
}));

describe('runControlClient', () => {
  beforeEach(() => {
    resetControlMetrics();
  });

  it('cancelModeForLevel maps L2/L3 only', () => {
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L0)).toBeNull();
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L1)).toBeNull();
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L2)).toBe('cooperative');
    expect(cancelModeForLevel(RUN_CONTROL_LEVEL.L3)).toBe('force');
  });

  it('dispatchRunControl records L1/L2/L3 metrics even without daemon', async () => {
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

  it('buildCancelRunWireMessage 带 mode 扩展字段', () => {
    expect(buildCancelRunWireMessage('run-x', 'cooperative')).toEqual({
      type: 'cancel-run',
      runId: 'run-x',
      mode: 'cooperative',
    });
    expect(buildCancelRunWireMessage('run-x', 'force')).toEqual({
      type: 'cancel-run',
      runId: 'run-x',
      mode: 'force',
    });
  });

  it('sendTerminateDualWire pairs run-control then cancel-run.mode (transitional)', async () => {
    expect(TRANSITIONAL_DUAL_CANCEL_RUN_WIRE).toBe(true);
    const send = vi.fn();
    const ok = await sendTerminateDualWire(
      { send },
      {
        level: RUN_CONTROL_LEVEL.L2,
        runId: 'run-pair',
        sessionId: 'sess-p',
        reason: 'ui-stop',
      },
      'cooperative'
    );
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toEqual({
      type: 'run-control',
      level: 'cooperative_stop',
      runId: 'run-pair',
      sessionId: 'sess-p',
      reason: 'ui-stop',
    });
    expect(send.mock.calls[1]![0]).toEqual({
      type: 'cancel-run',
      runId: 'run-pair',
      mode: 'cooperative',
    });
  });

  it('sendTerminateDualWire L3 force pairs force_cancel + mode=force', async () => {
    const send = vi.fn();
    await sendTerminateDualWire(
      { send },
      { level: RUN_CONTROL_LEVEL.L3, runId: 'run-f', reason: 'ui-force-cancel' },
      'force'
    );
    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'run-control',
      level: 'force_cancel',
      runId: 'run-f',
      reason: 'ui-force-cancel',
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'cancel-run',
      runId: 'run-f',
      mode: 'force',
    });
  });

  it('sendTerminateDualWire without runId only sends run-control', async () => {
    const send = vi.fn();
    await sendTerminateDualWire(
      { send },
      { level: RUN_CONTROL_LEVEL.L2, reason: 'ui-stop' },
      'cooperative'
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      type: 'run-control',
      level: 'cooperative_stop',
    });
  });

  it('requestFollowUp 为 L1 + payload.kind=follow_up（不附 cancel-run）', async () => {
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
