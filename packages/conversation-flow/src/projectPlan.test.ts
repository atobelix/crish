/**
 * projectPlanRoot：只看已有 plan 状态，不发明步骤 / 不吃消息。
 */
import { describe, expect, it } from 'vitest';
import { projectMessage, projectPlanRoot, isPlanModeEnabled } from './index';

const DEMO_STEP = '摸清 crates/session-loop 的 IPC 通道瓶颈';

describe('isPlanModeEnabled', () => {
  it('permissionMode=plan 或 planModeEnabled 任一为真', () => {
    expect(isPlanModeEnabled({ permissionMode: 'plan' })).toBe(true);
    expect(isPlanModeEnabled({ planModeEnabled: true })).toBe(true);
    expect(isPlanModeEnabled({ permissionMode: 'ask', planModeEnabled: false })).toBe(
      false,
    );
    expect(isPlanModeEnabled(null)).toBe(false);
    expect(isPlanModeEnabled({})).toBe(false);
  });
});

describe('projectPlanRoot', () => {
  it('非 plan 模式返回 null', () => {
    expect(projectPlanRoot({ permissionMode: 'ask' })).toBeNull();
    expect(projectPlanRoot({ permissionMode: 'full', planModeEnabled: false })).toBeNull();
    expect(projectPlanRoot(undefined)).toBeNull();
  });

  it('plan 模式长出 Task 根，steps / children 为空', () => {
    const node = projectPlanRoot({
      permissionMode: 'plan',
      planModeEnabled: true,
      planApproved: false,
    });
    expect(node).toMatchObject({
      kind: 'plan',
      id: 'plan-root',
      title: '计划模式',
      status: 'running',
      currentStepIndex: 0,
    });
    expect(node?.steps).toEqual([]);
    expect(node?.children).toEqual([]);
    expect(JSON.stringify(node)).not.toContain(DEMO_STEP);
  });

  it('planApproved 只改 status，仍不发明步骤', () => {
    const node = projectPlanRoot({ planModeEnabled: true, planApproved: true });
    expect(node?.status).toBe('success');
    expect(node?.steps).toEqual([]);
  });

  it('projectMessage 不从产品消息长出 plan', () => {
    const { nodes } = projectMessage({
      id: 'a1',
      sender: 'assistant',
      text: '先规划再改。',
      thinking: '只规划。',
      toolCalls: [
        {
          id: 'r1',
          name: 'read_file',
          status: 'success',
          arguments: JSON.stringify({ path: 'src/a.ts' }),
        },
      ],
    });
    expect(nodes.some((n) => n.kind === 'plan')).toBe(false);
  });
});
