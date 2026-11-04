// 抽屉列表三态裁决（批 D）：有行恒内容、数据未到先加载不闪空、
// 错误仅空列表占面、空态文案分区口径——逐项钉死。
import {
  deriveDrawerListState,
  type DrawerListStateInput,
} from './drawerListState';

function input(
  partial: Partial<DrawerListStateInput> = {}
): DrawerListStateInput {
  return {
    partition: 'remote',
    rowCount: 0,
    query: '',
    connected: true,
    syncStatus: 'ok',
    lastReconcileAt: 1000,
    localHydrated: true,
    ...partial,
  };
}

describe('deriveDrawerListState', () => {
  it('有行恒为内容（同步失败/未水合都不覆盖已到手数据）', () => {
    expect(deriveDrawerListState(input({ rowCount: 3 }))).toEqual({
      kind: 'content',
    });
    expect(
      deriveDrawerListState(input({ rowCount: 1, syncStatus: 'error' }))
    ).toEqual({ kind: 'content' });
    expect(
      deriveDrawerListState(
        input({ rowCount: 2, partition: 'local', localHydrated: false })
      )
    ).toEqual({ kind: 'content' });
  });

  it('远端冷启（已连接、从未对账成功、对账进行中/未开始）→ 加载，不闪空态', () => {
    expect(
      deriveDrawerListState(
        input({ lastReconcileAt: null, syncStatus: 'syncing' })
      )
    ).toEqual({ kind: 'loading', label: '正在同步会话…' });
    expect(
      deriveDrawerListState(
        input({ lastReconcileAt: null, syncStatus: 'idle' })
      ).kind
    ).toBe('loading');
  });

  it('远端对账失败 + 空列表 → 错误态（带重试出口）', () => {
    expect(
      deriveDrawerListState(
        input({ lastReconcileAt: null, syncStatus: 'error' })
      )
    ).toEqual({ kind: 'error' });
    // 曾经成功过、后续刷新失败且列表为空：仍是错误面而非假空态
    expect(deriveDrawerListState(input({ syncStatus: 'error' }))).toEqual({
      kind: 'error',
    });
  });

  it('远端已对账成功 + 空列表 → 空态「还没有会话」', () => {
    expect(deriveDrawerListState(input())).toEqual({
      kind: 'empty',
      text: '还没有会话',
    });
  });

  it('远端未连接 → 连接文案空态（不进加载/错误）', () => {
    expect(
      deriveDrawerListState(
        input({ connected: false, syncStatus: 'idle', lastReconcileAt: null })
      )
    ).toEqual({ kind: 'empty', text: '连接桌面后同步会话' });
  });

  it('本地未水合 → 加载；水合后空列表 → 「还没有会话」', () => {
    expect(
      deriveDrawerListState(input({ partition: 'local', localHydrated: false }))
    ).toEqual({ kind: 'loading', label: '正在加载本地会话…' });
    expect(deriveDrawerListState(input({ partition: 'local' }))).toEqual({
      kind: 'empty',
      text: '还没有会话',
    });
  });

  it('搜索无果 → 「没有匹配的会话」（两分区同口径，优先于同步错误面）', () => {
    expect(deriveDrawerListState(input({ query: 'xyz' }))).toEqual({
      kind: 'empty',
      text: '没有匹配的会话',
    });
    expect(
      deriveDrawerListState(input({ query: 'xyz', syncStatus: 'error' }))
    ).toEqual({ kind: 'empty', text: '没有匹配的会话' });
    expect(
      deriveDrawerListState(input({ query: 'xyz', partition: 'local' }))
    ).toEqual({ kind: 'empty', text: '没有匹配的会话' });
  });
});
