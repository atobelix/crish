/**
 * 审计 04 阻断项补测：前端临时通知滚动集成链路（D8 §3.7.4 老虎机重连）。
 *
 * 链路：provider-diagnostic（phase=retry）事件 → diagnosticHandlers.onProviderDiagnostic
 * → continuityUiStore.applyRetryNotice → ChatStatusRibbons 消费面
 * （retryNotices[activeSession] → RetrySlotNotice）→ 老虎机滚动渲染（1/6 → 2/6）。
 *
 * 断言覆盖（对齐 D8 §5.2 临时通知两断言 + 审计 04 §4 补测建议 1）：
 * - 事件 → store → 组件 全链路递增滚动，不进对话历史（用户约束 A/C）；
 * - 重连完成/失败 → 清除临时通知，无残留滚动态；
 * - 分母缺省（引擎未下发 max_attempts → 按 0 显示，不臆测上限）；
 * - 会话隔离（多会话事件按 sessionId 路由，不串扰）；
 * - 与失败态卡片区分（过程性通知：role=status、无 resume/kill/kill_all 动作面）。
 */
// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ChatStatusRibbons } from '../../../components/chat-card/ChatStatusRibbons';
import { onProviderDiagnostic } from './diagnosticHandlers';
import { engineDispatchTable } from './dispatch';
import {
  resetContinuityUiStoreForTests,
  useContinuityUiStore,
} from '../../continuity/continuityUiStore';
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

/**
 * ChatStatusRibbons 最小 props（本测试只关注临时通知区，其余传空值；
 * 空态下各子条均不挂载，不干扰断言）。
 */
function ribbonProps(activeSessionId: string | null) {
  return {
    streaming: {
      engineHint: null,
      needsKeySetup: false,
      localHasKey: false,
      onOpenModelSettings: () => {},
      onOpenModelDropdown: () => {},
      showScrollToBottom: false,
      onScrollToBottom: () => {},
      runNotice: null,
      onDismissRunNotice: () => {},
    },
    goal: {
      inPlanMode: false,
      planApproved: false,
      onApprovePlan: () => {},
      goalModeActive: false,
      goalText: '',
      goalIteration: 0,
      onStopGoal: () => {},
    },
    approval: {
      pendingApprovalCount: 0,
      pendingApprovalSummary: '',
      pendingApprovalToolId: '',
      pendingApprovalMsgId: '',
      activeSessionId,
    },
  };
}

describe('临时通知滚动集成链路（审计 04 阻断项补测）', () => {
  beforeEach(() => {
    resetContinuityUiStoreForTests();
  });

  it('链路入口锁定：engineDispatchTable 已接线 provider-diagnostic → onProviderDiagnostic', () => {
    expect(engineDispatchTable['provider-diagnostic']).toBe(
      onProviderDiagnostic
    );
  });

  it('事件 → store → 组件：attempt 递增渲染 1/6 → 2/6（老虎机滚动，动画键随切换）', () => {
    render(<ChatStatusRibbons {...ribbonProps('s1')} />);
    // 无事件 → 无临时通知（防幽灵条）
    expect(screen.queryByTestId('retry-slot-notice')).toBeNull();

    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 1, maxAttempts: 6 })
      );
    });
    // store 投影（单一数据源）
    expect(useContinuityUiStore.getState().retryNotices['s1']!.attempt).toBe(1);
    expect(
      useContinuityUiStore.getState().retryNotices['s1']!.maxAttempts
    ).toBe(6);
    // 组件渲染（消费面投影）
    const first = screen.getByTestId('retry-slot-notice');
    expect(first.textContent).toContain('重连中 1/6');
    expect(first.getAttribute('role')).toBe('status');

    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 2, maxAttempts: 6 })
      );
    });
    const second = screen.getByTestId('retry-slot-notice');
    expect(second.textContent).toContain('重连中 2/6');
    // 递增动画键：数字槽以 key 切换（旧槽 data-attempt=1 移除，新槽 data-attempt=2）
    expect(second.querySelector('[data-attempt="2"]')).toBeTruthy();
    expect(second.querySelector('[data-attempt="1"]')).toBeFalsy();
    // 不叠层：同一会话仅一个槽位
    expect(useContinuityUiStore.getState().retryNotices['s1']!.attempt).toBe(2);
  });

  it('重连完成/失败 → 清除临时通知：槽位移除，无残留滚动态', () => {
    render(<ChatStatusRibbons {...ribbonProps('s1')} />);
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 2, maxAttempts: 6 })
      );
    });
    expect(screen.getByTestId('retry-slot-notice')).toBeTruthy();

    act(() => {
      useContinuityUiStore.getState().clearRetryNotice('s1');
    });
    expect(screen.queryByTestId('retry-slot-notice')).toBeNull();
    expect(useContinuityUiStore.getState().retryNotices['s1']).toBeUndefined();
  });

  it('引擎未下发 max_attempts → store 不写分母字段，组件按 0 显示（不臆测上限）', () => {
    render(<ChatStatusRibbons {...ribbonProps('s1')} />);
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 1, maxAttempts: undefined })
      );
    });
    expect(
      useContinuityUiStore.getState().retryNotices['s1']!.maxAttempts
    ).toBeUndefined();
    expect(screen.getByTestId('retry-slot-notice').textContent).toContain(
      '重连中 1/0'
    );
  });

  it('会话隔离：事件按 sessionId 路由，切换活跃会话不串扰', () => {
    const { rerender } = render(<ChatStatusRibbons {...ribbonProps('s1')} />);
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 1, maxAttempts: 6 })
      );
    });
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s2', { attempt: 2, maxAttempts: 6 })
      );
    });
    // store 双侧独立（多会话不串）
    expect(useContinuityUiStore.getState().retryNotices['s1']!.attempt).toBe(1);
    expect(useContinuityUiStore.getState().retryNotices['s2']!.attempt).toBe(2);

    // 活跃会话 = s1 → 只展示 s1 的 1/6
    expect(screen.getByTestId('retry-slot-notice').textContent).toContain(
      '重连中 1/6'
    );

    // 切换活跃会话 = s2 → 展示 s2 的 2/6（s1 事件不污染 s2 展示）
    rerender(<ChatStatusRibbons {...ribbonProps('s2')} />);
    expect(screen.getByTestId('retry-slot-notice').textContent).toContain(
      '重连中 2/6'
    );

    // 清除 s2 → 切回 s1 仍保留 1/6（清除只影响目标会话）
    act(() => {
      useContinuityUiStore.getState().clearRetryNotice('s2');
    });
    rerender(<ChatStatusRibbons {...ribbonProps('s1')} />);
    expect(screen.getByTestId('retry-slot-notice').textContent).toContain(
      '重连中 1/6'
    );
  });

  it('与失败态卡片区分：过程性通知（role=status、无 resume/kill/kill_all 动作面、单行紧凑）', () => {
    render(<ChatStatusRibbons {...ribbonProps('s1')} />);
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { attempt: 3, maxAttempts: 6 })
      );
    });
    const el = screen.getByTestId('retry-slot-notice');
    // 过程级（D8 §3.7.5）：status + polite，非终态 alert
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    // 终态失败卡片（InlineAgentPanel）才有 resume/kill/kill_all 按钮动作面：
    // 临时通知零按钮、单行紧凑，无对话消息结构
    expect(el.querySelectorAll('button')).toHaveLength(0);
    const text = el.textContent ?? '';
    expect(text).not.toContain('\n');
    expect(text).toContain('重连');
  });

  it('phase≠retry（终态诊断）→ 不投影临时通知（终态走失败态卡片，D8 §3.7.5 分级）', () => {
    render(<ChatStatusRibbons {...ribbonProps('s1')} />);
    act(() => {
      onProviderDiagnostic(
        env,
        diagnosticEnvelope('s1', { phase: 'request-error', attempt: 1 })
      );
    });
    expect(screen.queryByTestId('retry-slot-notice')).toBeNull();
    expect(useContinuityUiStore.getState().retryNotices).toEqual({});
  });

  it('载荷宽容：attempt 非有限值/≤0 或空 sessionId → 不投影（不留 NaN 滚动态）', () => {
    render(<ChatStatusRibbons {...ribbonProps('s1')} />);
    act(() => {
      onProviderDiagnostic(env, diagnosticEnvelope('s1', { attempt: NaN }));
    });
    act(() => {
      onProviderDiagnostic(env, diagnosticEnvelope('s1', { attempt: 0 }));
    });
    act(() => {
      onProviderDiagnostic(env, diagnosticEnvelope('', { attempt: 1 }));
    });
    expect(screen.queryByTestId('retry-slot-notice')).toBeNull();
    expect(useContinuityUiStore.getState().retryNotices).toEqual({});
  });
});
