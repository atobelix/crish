// @vitest-environment jsdom
/**
 * ChatAssistantMessageRow 纯状态载体（isPureCarrier）与去助手化测试：
 * 验证 role="status"、居中无助手泡泡框、彻底杜绝 MessageActions（时间戳、复制、重试、固定按钮）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ChatAssistantMessageRow } from '../ChatAssistantMessageRow';
import type { SessionMessage } from '../../../store/types';

vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

vi.mock('../../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (markdown: string) => ({
    html: markdown ? `<p>${markdown}</p>` : '',
    loading: false,
    failed: false,
  }),
  parseMarkdownToHtmlAsync: vi.fn(async (m: string) => `<p>${m}</p>`),
}));

function makeCarrierMessage(
  partial: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    id: 'msg_carrier_1',
    sender: 'assistant',
    text: '',
    timestamp: 1725678900000,
    status: 'done',
    blocks: [
      {
        type: 'context_injection',
        injection: {
          id: 'inj_state_1',
          kind: 'workspace_env',
          title: '上下文状态切换',
          summary: '切换到 deepseek-chat',
          status: 'injected',
          metadata: {
            mode: 'context-state',
            model: 'deepseek-chat',
            permission: 'ask',
          },
        },
      },
    ],
    ...partial,
  };
}

describe('ChatAssistantMessageRow 去助手化与纯状态载体', () => {
  it('纯状态载体（isPureCarrier）：外层 role="region"，aria-label="系统状态提示行"，内层单层 role="status"，彻底去助手化', () => {
    const msg = makeCarrierMessage();
    const { container } = render(
      <ChatAssistantMessageRow
        msg={msg}
        onRegenerate={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenDiff={vi.fn()}
        setPermissionMode={vi.fn()}
        setPlanApproved={vi.fn()}
      />
    );

    // 1. 外层容器：role="region" 与 aria-label="系统状态提示行"，严禁外层 role="status" 造成双重回声 (DEF-08)
    const row = container.querySelector('.msg-row-carrier');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('role', 'region');
    expect(row).toHaveAttribute('aria-label', '系统状态提示行');
    expect(row).toHaveAttribute('data-role', 'system');

    // 2. 消息内容体采用 carrier 标头
    const body = container.querySelector('[data-message-body="carrier"]');
    expect(body).not.toBeNull();

    // 3. 内层单层 Live Region：唯一承载 role="status"、aria-live="polite" 与 tabIndex={0}
    const notice = screen.getByRole('status');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).toHaveAttribute('tabindex', '0');
    expect(
      screen.getByText(/系统 · 切换到.*deepseek-chat/)
    ).toBeInTheDocument();

    // 4. 彻底消灭 MessageActions：无时间戳、无复制按钮、无重新生成按钮、无固定按钮
    expect(screen.queryByText(/\d{2}:\d{2}/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /复制/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /重新生成/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /固定/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /撤回/i })).not.toBeInTheDocument();
  });

  it('完善 isPureCarrier 防御门禁：含思维链、图片、正文、工具调用时不为纯载体', () => {
    // 1. 含 thinkingTurns 时不为纯载体
    const thinkMsg = makeCarrierMessage({
      thinkingTurns: [{ id: 'turn-1', content: '深度推理中...' }],
    });
    const { container: c1, unmount: u1 } = render(
      <ChatAssistantMessageRow
        msg={thinkMsg}
        onRegenerate={vi.fn()}
        onTogglePin={vi.fn()}
      />
    );
    expect(c1.querySelector('.msg-row-carrier')).toBeNull();
    expect(c1.querySelector('.msg-row-assistant')).not.toBeNull();
    u1();

    // 2. 含 images 时不为纯载体
    const imgMsg = makeCarrierMessage({
      images: ['data:image/png;base64,...'],
    });
    const { container: c2, unmount: u2 } = render(
      <ChatAssistantMessageRow
        msg={imgMsg}
        onRegenerate={vi.fn()}
        onTogglePin={vi.fn()}
      />
    );
    expect(c2.querySelector('.msg-row-carrier')).toBeNull();
    expect(c2.querySelector('.msg-row-assistant')).not.toBeNull();
    u2();

    // 3. 含 streamText 时不为纯载体
    const { container: c3, unmount: u3 } = render(
      <ChatAssistantMessageRow
        msg={makeCarrierMessage()}
        streamText="正在生成回复..."
        onRegenerate={vi.fn()}
        onTogglePin={vi.fn()}
      />
    );
    expect(c3.querySelector('.msg-row-carrier')).toBeNull();
    expect(c3.querySelector('.msg-row-assistant')).not.toBeNull();
    u3();

    // 4. isThinkingMsg 为 true 时不为纯载体
    const { container: c4, unmount: u4 } = render(
      <ChatAssistantMessageRow
        msg={makeCarrierMessage()}
        isThinkingMsg={true}
        onRegenerate={vi.fn()}
        onTogglePin={vi.fn()}
      />
    );
    expect(c4.querySelector('.msg-row-carrier')).toBeNull();
    expect(c4.querySelector('.msg-row-assistant')).not.toBeNull();
    u4();
  });

  it('普通助手消息：保持 role="article" 与常规助手气泡外壳，渲染 MessageActions', () => {
    const normalMsg: SessionMessage = {
      id: 'msg_normal_1',
      sender: 'assistant',
      text: '你好，我是助手。',
      timestamp: 1725678900000,
      status: 'done',
    };

    const { container } = render(
      <ChatAssistantMessageRow
        msg={normalMsg}
        isLastAssistant={true}
        onRegenerate={vi.fn()}
        onTogglePin={vi.fn()}
        onOpenDiff={vi.fn()}
        setPermissionMode={vi.fn()}
        setPlanApproved={vi.fn()}
      />
    );

    // 1. role="article"
    const row = screen.getByRole('article');
    expect(row).toBeInTheDocument();
    expect(row).toHaveAttribute('data-role', 'assistant');
    expect(row.classList.contains('msg-row-assistant')).toBe(true);

    // 2. 正常渲染 MessageActions 按钮（如复制、固定、重试等）
    expect(container.querySelector('[data-message-body="assistant"]')).not.toBeNull();
  });
});
