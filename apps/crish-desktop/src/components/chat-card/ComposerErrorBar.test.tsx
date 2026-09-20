// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ComposerErrorBar } from './ComposerErrorBar';
import {
  useSessionRuntimeStatusStore,
  reportRuntimeStatus,
} from '../../store/sessionRuntimeStatusStore';
import { onUiEvent } from '../../api/uiEvents';

describe('ComposerErrorBar (单轨收敛 §2.3)', () => {
  beforeEach(() => {
    useSessionRuntimeStatusStore.getState().clearAll();
  });

  it('无活跃会话时不渲染', () => {
    reportRuntimeStatus({
      type: 'failed',
      sessionId: 'sess-1',
      id: 'err-1',
      kind: 'network',
      message: '网络断开连接',
      turn: { userMsgId: 'u-1', assistantMsgId: 'a-1' },
    });

    const { container } = render(<ComposerErrorBar activeSessionId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('非 failed 相位（idle / retrying）时不渲染', () => {
    const { container: idleContainer } = render(
      <ComposerErrorBar activeSessionId="sess-1" />
    );
    expect(idleContainer.firstChild).toBeNull();

    act(() => {
      reportRuntimeStatus({
        type: 'retrying',
        sessionId: 'sess-1',
        retry: { attempt: 1, maxAttempts: 3 },
      });
    });

    const { container: retryingContainer } = render(
      <ComposerErrorBar activeSessionId="sess-1" />
    );
    expect(retryingContainer.firstChild).toBeNull();
  });

  it('failed 相位渲染全宽错误条并支持展开详情', () => {
    reportRuntimeStatus({
      type: 'failed',
      sessionId: 'sess-1',
      id: 'err-1',
      kind: 'server_error',
      message: '模型推理异常',
      technicalDetail: '500 Internal Server Error: CUDA out of memory',
      turn: { userMsgId: 'u-1', assistantMsgId: 'a-1' },
    });

    render(<ComposerErrorBar activeSessionId="sess-1" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('composer-error-text')).toHaveTextContent(
      '模型推理异常'
    );

    // 详情切换
    expect(screen.queryByTestId('composer-error-detail')).toBeNull();
    const detailBtn = screen.getByRole('button', { name: '详情' });
    fireEvent.click(detailBtn);
    expect(screen.getByTestId('composer-error-detail')).toHaveTextContent(
      '500 Internal Server Error: CUDA out of memory'
    );
    fireEvent.click(detailBtn);
    expect(screen.queryByTestId('composer-error-detail')).toBeNull();
  });

  it('无 technicalDetail 时不渲染详情按钮', () => {
    reportRuntimeStatus({
      type: 'failed',
      sessionId: 'sess-1',
      id: 'err-2',
      kind: 'network',
      message: '网络连接超时',
      turn: { userMsgId: 'u-1', assistantMsgId: 'a-1' },
    });

    render(<ComposerErrorBar activeSessionId="sess-1" />);

    expect(screen.queryByRole('button', { name: '详情' })).toBeNull();
  });

  it('点击关闭按钮清空当前会话运行时错误', () => {
    reportRuntimeStatus({
      type: 'failed',
      sessionId: 'sess-1',
      id: 'err-1',
      kind: 'network',
      message: '网络异常',
      turn: { userMsgId: 'u-1', assistantMsgId: 'a-1' },
    });

    render(<ComposerErrorBar activeSessionId="sess-1" />);

    const closeBtn = screen.getByTestId('composer-error-close');
    fireEvent.click(closeBtn);

    const status =
      useSessionRuntimeStatusStore.getState().statusBySession['sess-1'];
    expect(status).toBeUndefined();
  });

  it('点击重试按钮派发 retry-failed-turn 事件（错误态由重试执行流收敛清空）', () => {
    const onRetry = vi.fn();
    const unsub = onUiEvent('retry-failed-turn', onRetry);

    reportRuntimeStatus({
      type: 'failed',
      sessionId: 'sess-1',
      id: 'err-1',
      kind: 'rate_limit',
      message: '频率限制',
      turn: { userMsgId: 'u-100', assistantMsgId: 'a-101' },
    });

    render(<ComposerErrorBar activeSessionId="sess-1" />);

    const retryBtn = screen.getByTestId('composer-error-retry');
    fireEvent.click(retryBtn);

    expect(onRetry).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      userMsgId: 'u-100',
      assistantMsgId: 'a-101',
    });

    // S4.2：重试按钮本身不立即抹除状态，交由 regenerateTurn 节流通过后清空
    const status =
      useSessionRuntimeStatusStore.getState().statusBySession['sess-1'];
    expect(status?.phase).toBe('failed');

    unsub();
  });
});
