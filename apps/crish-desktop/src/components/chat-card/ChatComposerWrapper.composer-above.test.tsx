// @vitest-environment jsdom
/**
 * S5：composer 上沿 SlotOutlet；插件开才挂冷静条；关插件无 PermissionBar。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { slotCore } from '../../services/view-registry/SlotCore';
import {
  activateConversationFlow,
  deactivateConversationFlow,
  setOfficialConversationFlowActivateForTesting,
} from '../../extensions/conversation-flow/activate';
import { ChatComposerWrapper, type RibbonsGroup } from './ChatComposerWrapper';
import './workspaceChatComposerAbove.slot';

vi.mock('./ChatStatusRibbons', () => ({
  ChatStatusRibbons: (props: {
    approval?: { showApprovalDock?: boolean };
  }) => (
    <div
      data-testid="ribbons"
      data-show-dock={String(Boolean(props.approval?.showApprovalDock))}
    />
  ),
}));

vi.mock('./ApprovalDock', () => ({
  ApprovalDock: (props: { show?: boolean; pendingCount?: number }) =>
    props.show ? (
      <div data-testid="approval-dock" data-pending={String(props.pendingCount)} />
    ) : null,
}));

vi.mock('./PlanGoalRibbons', () => ({
  PlanGoalRibbons: () => null,
}));

const ribbons = { streaming: {}, goal: {} } as RibbonsGroup;

function renderWrap(
  overrides: Partial<React.ComponentProps<typeof ChatComposerWrapper>> = {}
) {
  return render(
    <ChatComposerWrapper
      mainSurface="chat"
      emptyKind={null}
      composerElement={<div data-testid="composer" />}
      ribbons={ribbons}
      pendingApprovalCount={2}
      showApprovalDock={true}
      pendingApprovalSummary="运行 shell"
      pendingApprovalToolId="t1"
      pendingApprovalMsgId="m1"
      approvalBusy={false}
      onApprovalAllow={vi.fn()}
      onApprovalDeny={vi.fn()}
      activeSessionId="sess-1"
      openSidePanel={vi.fn()}
      handleGlobalTabClick={vi.fn()}
      {...overrides}
    />
  );
}

describe('ChatComposerWrapper workspace.chat.composerAbove', () => {
  beforeEach(() => {
    deactivateConversationFlow();
    setOfficialConversationFlowActivateForTesting(null);
    slotCore.clear();
  });

  afterEach(() => {
    cleanup();
    act(() => {
      deactivateConversationFlow();
    });
    setOfficialConversationFlowActivateForTesting(null);
    slotCore.clear();
  });

  it('关插件：槽口在，无 PermissionBar；dock 保持传入值', () => {
    const { container } = renderWrap();
    expect(
      container.querySelector('[data-slot="workspace.chat.composerAbove"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-composer-float-zone]')).not.toBeNull();
    expect(container.querySelector('[data-composer-wrapper]')).not.toBeNull();
    expect(container.querySelector('[data-permission-bar]')).toBeNull();
    expect(
      container.querySelector('[data-testid="ribbons"]')?.getAttribute(
        'data-show-dock'
      )
    ).toBe('true');
  });

  it('开插件 + pending：冷静条在 composer 上；dock 关掉', async () => {
    activateConversationFlow();
    const { container } = renderWrap();
    await waitFor(() => {
      expect(container.querySelector('[data-permission-bar]')).not.toBeNull();
    });
    const bar = container.querySelector('[data-permission-bar]');
    expect(bar?.getAttribute('data-tool-id')).toBe('t1');
    expect(bar?.textContent).toMatch(/还有 1/);
    expect(
      container.querySelector('[data-testid="ribbons"]')?.getAttribute(
        'data-show-dock'
      )
    ).toBe('false');
  });

  it('开插件但无 pending：不挂条', async () => {
    activateConversationFlow();
    const { container } = renderWrap({
      pendingApprovalCount: 0,
      pendingApprovalToolId: '',
      showApprovalDock: false,
    });
    await waitFor(() => {
      expect(
        slotCore.getSingle('workspace.chat.composerAbove')
      ).toBeDefined();
    });
    expect(container.querySelector('[data-permission-bar]')).toBeNull();
  });
});
