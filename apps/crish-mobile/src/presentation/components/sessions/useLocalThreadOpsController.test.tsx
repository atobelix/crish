// 本地线程操作控制器：长按 Sheet 三条目在位；改名走 setThreadTitle
// 置 'user' 来源（AI/派生永不覆盖）；清空与删除作用于本地 store 真源。
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import type {
  LocalChatMessage,
  LocalThreadMeta,
} from '@/domain/types/localChat';
import { ToastProvider } from '@/presentation/ui';
import {
  useLocalThreadOpsController,
  type LocalThreadOpsController,
} from './useLocalThreadOpsController';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

const META: LocalThreadMeta = {
  id: 'lth-1',
  title: '旧标题',
  titleSource: 'derived',
  preview: '你好',
  modelRef: null,
  createdAt: 1_000,
  updatedAt: 2_000,
};

const MESSAGES: LocalChatMessage[] = [
  { id: 'm-1', role: 'user', content: '你好' },
  { id: 'm-2', role: 'assistant', content: '你好，有什么可以帮你' },
];

let latest: LocalThreadOpsController | null = null;
let deletedIds: string[] = [];

function Probe() {
  const ctl = useLocalThreadOpsController({
    onThreadDeleted: (id) => deletedIds.push(id),
  });
  latest = ctl;
  return <>{ctl.layer}</>;
}

function seedStore() {
  localChatSessionStore.setState({
    threads: [META],
    activeThreadId: 'lth-1',
    inactive: {},
    messages: [...MESSAGES],
    streaming: false,
    error: null,
    completedAtByThread: {},
  });
}

beforeEach(() => {
  latest = null;
  deletedIds = [];
  seedStore();
});

async function openSheet() {
  const view = await render(<Probe />, { wrapper: Wrapper });
  await act(async () => {
    latest?.openActions(META);
  });
  // findBy 轮询自带 act 冲刷（Sheet 的挂载 effect 靠它落渲）
  await view.findByTestId('local-thread-actions-sheet');
  return view;
}

describe('useLocalThreadOpsController', () => {
  it('操作 Sheet 三条目在位（重命名 / 清空对话 / 删除对话）', async () => {
    const view = await openSheet();
    expect(view.getByTestId('local-thread-actions-sheet')).toBeTruthy();
    expect(view.getByText('重命名')).toBeTruthy();
    expect(view.getByText('清空对话')).toBeTruthy();
    expect(view.getByText('删除对话')).toBeTruthy();
  });

  it('改名：清洗后写入标题并置 titleSource=user', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByTestId('local-thread-actions-rename'));
    const input = await waitFor(() =>
      view.getByTestId('rename-local-thread-dialog-input')
    );
    await fireEvent.changeText(input, '  我的  新标题 ');
    await fireEvent.press(
      view.getByTestId('rename-local-thread-dialog-submit')
    );
    await waitFor(() => {
      const meta = localChatSessionStore
        .getState()
        .threads.find((t) => t.id === 'lth-1');
      expect(meta?.title).toBe('我的 新标题');
      expect(meta?.titleSource).toBe('user');
    });
  });

  it('清空：确认后消息清空（标题回占位为 store 既有口径）', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByTestId('local-thread-actions-clear'));
    const confirm = await waitFor(() =>
      view.getByTestId('clear-local-thread-confirm')
    );
    await fireEvent.press(confirm);
    await waitFor(() => {
      expect(localChatSessionStore.getState().messages).toEqual([]);
    });
    // 线程本身保留（清空 ≠ 删除）
    expect(
      localChatSessionStore.getState().threads.some((t) => t.id === 'lth-1')
    ).toBe(true);
  });

  it('删除：确认后线程移除并回调宿主', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByTestId('local-thread-actions-delete'));
    const confirm = await waitFor(() =>
      view.getByTestId('delete-local-thread-confirm')
    );
    await fireEvent.press(confirm);
    await waitFor(() => {
      expect(
        localChatSessionStore.getState().threads.some((t) => t.id === 'lth-1')
      ).toBe(false);
    });
    expect(deletedIds).toEqual(['lth-1']);
  });

  it('删除取消：线程保留、无回调', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByTestId('local-thread-actions-delete'));
    const cancel = await waitFor(() =>
      view.getByTestId('delete-local-thread-cancel')
    );
    await fireEvent.press(cancel);
    expect(
      localChatSessionStore.getState().threads.some((t) => t.id === 'lth-1')
    ).toBe(true);
    expect(deletedIds).toEqual([]);
  });
});
