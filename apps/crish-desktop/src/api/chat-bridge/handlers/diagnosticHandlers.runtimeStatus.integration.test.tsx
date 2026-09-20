/**
 * 单轨收敛集成链路（docs/chat-notice-convergence §2.0/§2.2）：
 * 重试进行中的「事件 → 状态机 → 组件」唯一链路。
 *
 * 链路：provider-diagnostic（phase=retry） → diagnosticHandlers.onProviderDiagnostic
 * → reportRuntimeStatus（唯一上报入口） → SessionRuntimeStatusStore.retrying
 * → 对话流内 InFlowStatusLine（图标 + shimmer 单行文字）。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { InFlowStatusLine } from '../../../components/chat-message-row/InFlowStatusLine';
import { onProviderDiagnostic } from './diagnosticHandlers';
import { engineDispatchTable } from './dispatch';
import {
  clearRuntimeStatus,
  useSessionRuntimeStatusStore,
} from '../../../store/sessionRuntimeStatusStore';
import type { ProviderDiagnostic } from '../../../../../../packages/shared-types/src/generated/engine';
import type { EngineEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

/** 分派环境最小桩（本链路 handler 不消费 env，保持既有测试先例） */
const env = {} as HandlerEnv;

/**
 * 构造 provider-diagnostic 信封（默认 phase=retry + attempt=1/maxAttempts=6，
 * 载荷对齐 D1 §4.3 事件面真源；diag 覆盖项透传）。
 */
function diagnosticEnvelope(
  sessionId: string,
  diag: Partial<ProviderDiagnostic> = {}
): EngineEnvelope<'provider-diagnostic'> {
  return {
    kind: 'engine',
    type: 'provider-diagnostic',
    event: {
      type: 'provider-diagnostic',
      sessionId,
      timestamp: '2026-08-12T00:00:00.000Z',
      diagnostic: { phase: 'retry', attempt: 1, maxAttempts: 6, ...diag },
    },
    raw: {},
  } as EngineEnvelope<'provider-diagnostic'>;
}

/** 读取指定会话的 retrying 相位（无则 null） */
function retryingOf(sessionId: string) {
  const s = useSessionRuntimeStatusStore.getState().statusBySession[sessionId];
  return s?.phase === 'retrying' ? s.retry : null;
}

describe('重试进行中单轨链路（会话运行时状态机）', () => {
  beforeEach(() => {
    useSessionRuntimeStatusStore.getState().clearAll();
  });

  it('链路入口锁定：engineDispatchTable 已接线 provider-diagnostic → onProviderDiagnostic', () => {
    expect(engineDispatchTable['provider-diagnostic']).toBe(
      onProviderDiagnostic
    );
  });

  it('事件 → 状态机 → 组件：attempt 递增渲染 1/6 → 2/6', () => {
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 1, maxAttempts: 6 })
      );
    });
    let retry = retryingOf('s1');
    expect(retry).not.toBeNull();

    const { rerender } = render(<InFlowStatusLine retry={retry!} />);
    expect(screen.getByTestId('in-flow-status-line').textContent).toContain(
      '1/6'
    );

    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 2, maxAttempts: 6 })
      );
    });
    retry = retryingOf('s1');
    expect(retry!.attempt).toBe(2);
    rerender(<InFlowStatusLine retry={retry!} />);
    expect(screen.getByTestId('in-flow-status-line').textContent).toContain(
      '2/6'
    );
  });

  it('单轨：存续载体只有状态机 retrying 相位（单例覆盖，无第二通道）', () => {
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 3, maxAttempts: 6 })
      );
    });
    const status = useSessionRuntimeStatusStore.getState().statusBySession['s1'];
    expect(status?.phase).toBe('retrying');
    expect(
      Object.keys(useSessionRuntimeStatusStore.getState().statusBySession)
    ).toEqual(['s1']);
  });

  it('分母缺省：引擎未下发 maxAttempts → 不臆造上限，文案退化为「第 n 次」', () => {
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 1, maxAttempts: undefined })
      );
    });
    const retry = retryingOf('s1')!;
    expect(retry.maxAttempts).toBeUndefined();
    render(<InFlowStatusLine retry={retry} />);
    const text = screen.getByTestId('in-flow-status-line').textContent ?? '';
    expect(text).toContain('第 1 次');
    expect(text).not.toMatch(/\/\d/);
  });

  it('会话隔离：事件按 sessionId 路由，清除只影响目标会话', () => {
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 1, maxAttempts: 6 })
      );
    });
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s2', { attempt: 4, maxAttempts: 6 })
      );
    });
    expect(retryingOf('s1')!.attempt).toBe(1);
    expect(retryingOf('s2')!.attempt).toBe(4);

    act(() => {
      clearRuntimeStatus('s2');
    });
    expect(retryingOf('s2')).toBeNull();
    expect(retryingOf('s1')!.attempt).toBe(1);
  });

  it('自愈：清空 → 瞬态行物理消失（对话流不留痕）', () => {
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 2, maxAttempts: 6 })
      );
    });
    expect(retryingOf('s1')).not.toBeNull();

    act(() => {
      clearRuntimeStatus('s1');
    });
    expect(retryingOf('s1')).toBeNull();
    expect(
      useSessionRuntimeStatusStore.getState().statusBySession['s1']
    ).toBeUndefined();
  });

  it('形态契约：过程性（role=status / polite / 零按钮 / 单行）', () => {
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 3, maxAttempts: 6 })
      );
    });
    render(<InFlowStatusLine retry={retryingOf('s1')!} />);
    const el = screen.getByTestId('in-flow-status-line');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.querySelectorAll('button')).toHaveLength(0);
    const text = el.textContent ?? '';
    expect(text).not.toContain('\n');
    expect(text).toContain('重试');
  });

  it('phase≠retry（终态诊断）→ 不投影瞬态行（终态走 ComposerErrorBar）', () => {
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { phase: 'request-error', attempt: 1 })
      );
    });
    expect(retryingOf('s1')).toBeNull();
    expect(
      useSessionRuntimeStatusStore.getState().statusBySession
    ).toEqual({});
  });

  it('载荷宽容：attempt 非有限值/≤0 或空 sessionId → 不投影（不留 NaN 态）', () => {
    act(() => {
      onProviderDiagnostic(env, diagnosticEnvelope('s1', { attempt: NaN }));
    });
    act(() => {
      onProviderDiagnostic(env, diagnosticEnvelope('s1', { attempt: 0 }));
    });
    act(() => {
      onProviderDiagnostic(env, diagnosticEnvelope('', { attempt: 1 }));
    });
    expect(
      useSessionRuntimeStatusStore.getState().statusBySession
    ).toEqual({});
  });
});