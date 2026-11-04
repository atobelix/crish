// 抽屉会话列表段 memo 化（C-PERF）：内容区因账号/审批订阅或 isOpen
// 中点翻转重渲染时，入参（分组行数组 / selected / 稳定回调）未变的
// 列表段必须整段跳过；行数据真变（新数组）时必须重渲染（不冻结
// 数据，下次打开所见恒为最新）。以「计数型行替身」统计行组件执行
// 次数钉口径（列表段跳过时行零调用；段真渲染时行随之执行）。
import { render } from '@testing-library/react-native';
import type { DrawerRow } from '@/domain/pure/drawerRows';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { DrawerSessionList } from './CrishDrawerContent';
import type { DrawerListViewState } from './drawerListState';

// memo 纯洁性前提：入参恒定即恒定——三态入参用模块级稳定常量
// （生产侧 listState 由 useMemo 派生、onRetry 为 vm.refresh，同口径）
const CONTENT_LIST_STATE: DrawerListViewState = { kind: 'content' };
const NOOP_RETRY = () => {};

let mockRemoteRowRenders = 0;

jest.mock('@/presentation/components/sessions/SessionListItem', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SessionListItem: (props: { session: { id: string } }) => {
      mockRemoteRowRenders += 1;
      return React.createElement(View, {
        testID: `session-row-${props.session.id}`,
      });
    },
  };
});

jest.mock('@/presentation/components/sessions/LocalSessionListItem', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    LocalSessionListItem: (props: { thread: { id: string } }) =>
      React.createElement(View, {
        testID: `local-row-${props.thread.id}`,
      }),
  };
});

function session(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    activeRunIds: [],
    pendingApprovalCount: 0,
    unreadCount: 0,
  } as unknown as SessionSummary;
}

function remoteRow(id: string, title: string): DrawerRow {
  return { kind: 'remote', id, updatedAt: 1, session: session(id, title) };
}

function sectionsOf(rows: DrawerRow[]) {
  return [
    { key: 'today', label: '今天', data: rows },
    { key: 'earlier', label: '更早', data: [] as DrawerRow[] },
  ];
}

beforeEach(() => {
  mockRemoteRowRenders = 0;
});

describe('DrawerSessionList memo（C-PERF）', () => {
  it('入参未变 rerender 行零执行；行数组换新时重渲染', async () => {
    const callbacks = {
      onOpenSession: () => {},
      onOpenLocalThread: () => {},
      onSessionActions: () => {},
      onLocalThreadActions: () => {},
    };
    const sections = sectionsOf([remoteRow('s1', '会话一')]);
    const view = await render(
      <DrawerSessionList
        sections={sections}
        listState={CONTENT_LIST_STATE}
        onRetry={NOOP_RETRY}
        selected={null}
        {...callbacks}
      />
    );
    expect(mockRemoteRowRenders).toBe(1);
    // 内容区无关重渲染等价场景：同入参 rerender ×2 → 整段跳过
    for (let i = 0; i < 2; i += 1) {
      await view.rerender(
        <DrawerSessionList
          sections={sections}
          listState={CONTENT_LIST_STATE}
          onRetry={NOOP_RETRY}
          selected={null}
          {...callbacks}
        />
      );
    }
    expect(mockRemoteRowRenders).toBe(1);
    // 行数据真变（新数组 + 新行）→ 必须重渲染且新行在列
    const next = sectionsOf([
      remoteRow('s1', '会话一'),
      remoteRow('s2', '会话二'),
    ]);
    await view.rerender(
      <DrawerSessionList
        sections={next}
        listState={CONTENT_LIST_STATE}
        onRetry={NOOP_RETRY}
        selected={null}
        {...callbacks}
      />
    );
    expect(mockRemoteRowRenders).toBeGreaterThan(1);
    expect(view.getByTestId('session-row-s2')).toBeTruthy();
  });

  it('手势拖动过程中入参保持稳定时，列表行零额外重渲染（方案 04 Memo 纯洁性测试）', async () => {
    const callbacks = {
      onOpenSession: () => {},
      onOpenLocalThread: () => {},
      onSessionActions: () => {},
      onLocalThreadActions: () => {},
    };
    const sections = sectionsOf([remoteRow('s1', '会话一')]);
    const view = await render(
      <DrawerSessionList
        sections={sections}
        listState={CONTENT_LIST_STATE}
        onRetry={NOOP_RETRY}
        selected={null}
        {...callbacks}
      />
    );
    expect(mockRemoteRowRenders).toBe(1);

    // 方案 04 断言：模拟抽屉连续 100 次手势拖动 progress 变化，由于手势中途不触发 setIsOpen，
    // sections 与 callbacks 保持稳定引用，内部 SessionListItem 的 render counter 维持为 1（0 次多余重绘）
    for (let i = 0; i < 100; i += 1) {
      await view.rerender(
        <DrawerSessionList
          sections={sections}
          listState={CONTENT_LIST_STATE}
          onRetry={NOOP_RETRY}
          selected={null}
          {...callbacks}
        />
      );
    }
    expect(mockRemoteRowRenders).toBe(1);
  });
});
