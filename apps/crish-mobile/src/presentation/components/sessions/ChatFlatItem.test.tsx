// ChatFlatItem 状态派生纯函数测试：运行中 > 待审批 > 已完成 的优先级不变量。
import { chatStatusOf } from './ChatFlatItem';

describe('chatStatusOf', () => {
  it('无活动 run 且无待审批 → done', () => {
    expect(chatStatusOf({ activeRunIds: [], pendingApprovalCount: 0 })).toBe(
      'done'
    );
  });

  it('有待审批 → pending', () => {
    expect(chatStatusOf({ activeRunIds: [], pendingApprovalCount: 1 })).toBe(
      'pending'
    );
  });

  it('有活动 run → running（优先于待审批）', () => {
    expect(
      chatStatusOf({ activeRunIds: ['r-1'], pendingApprovalCount: 2 })
    ).toBe('running');
    expect(
      chatStatusOf({ activeRunIds: ['r-1'], pendingApprovalCount: 0 })
    ).toBe('running');
  });
});
