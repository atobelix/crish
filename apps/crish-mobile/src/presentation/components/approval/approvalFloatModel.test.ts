// 审批悬浮卡可见性单测：隐藏路由、裁决方过滤、L1/L2 分支、多条、锚点。
import type { PermissionRequest } from '@crish/shared-types';
import type { ApprovalItem } from '@/domain/types/domain';
import {
  approvalFloatAnchorFor,
  approvalFloatModel,
  isApprovalFloatHiddenOn,
} from './approvalFloatModel';

const NOW = 1_800_000_000_000;

function makeItem(
  toolCallId: string,
  overrides: Partial<ApprovalItem> = {}
): ApprovalItem {
  const request: PermissionRequest = {
    id: `approval-${toolCallId}`,
    sessionId: 's-1',
    cwd: 'C:\\work',
    toolCallId,
    toolName: 'write_file',
    parameters: { path: 'a.ts' },
    summary: 'write a.ts',
    toolMetadata: {},
  };
  return {
    request,
    runId: null,
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: NOW,
    expiresAt: NOW + 120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

describe('isApprovalFloatHiddenOn', () => {
  it.each([
    '/approval/tc-1',
    '/approvals',
    '/approval-history',
    '/tools/s-1',
    '/welcome',
    '/pair/welcome',
    '/account/login',
    '/account',
    '/account/sessions',
    '/settings',
  ])('%s → 隐藏', (pathname) => {
    expect(isApprovalFloatHiddenOn(pathname)).toBe(true);
  });

  it.each(['/', '/session/s-1', '/notifications', '/run/r-1'])(
    '%s → 显示',
    (pathname) => {
      expect(isApprovalFloatHiddenOn(pathname)).toBe(false);
    }
  );
});

describe('approvalFloatAnchorFor', () => {
  it('新对话与会话页贴输入条，其余贴安全区', () => {
    expect(approvalFloatAnchorFor('/')).toBe('composer');
    expect(approvalFloatAnchorFor('/session/s-1')).toBe('composer');
    expect(approvalFloatAnchorFor('/notifications')).toBe('safeArea');
  });
});

describe('approvalFloatModel', () => {
  it('无待裁决条目 → null', () => {
    expect(approvalFloatModel([], '/')).toBeNull();
  });

  it('隐藏路由下即使有条目也 → null', () => {
    expect(approvalFloatModel([makeItem('tc-1')], '/approvals')).toBeNull();
  });

  it('只呈现用户裁决且未决的条目', () => {
    const items = [
      makeItem('agent', { arbiter: 'main-agent' }),
      makeItem('done', { status: 'approved' }),
      makeItem('mine', { status: 'queued' }),
    ];
    const model = approvalFloatModel(items, '/');
    expect(model?.item.request.toolCallId).toBe('mine');
    expect(model?.others).toBe(0);
  });

  it('dangerLevel 1 → quick，2 → review', () => {
    expect(approvalFloatModel([makeItem('l1')], '/')?.mode).toBe('quick');
    expect(
      approvalFloatModel([makeItem('l2', { dangerLevel: 2 })], '/')?.mode
    ).toBe('review');
  });

  it('多条时取首条（最紧急），others 计其余', () => {
    const model = approvalFloatModel(
      [makeItem('a'), makeItem('b', { status: 'deciding' }), makeItem('c')],
      '/session/s-1'
    );
    expect(model?.item.request.toolCallId).toBe('a');
    expect(model?.others).toBe(2);
    expect(model?.anchor).toBe('composer');
  });
});
