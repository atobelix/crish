// 发送队列排空状态机测试（批 C ②）：生成中入队不发、生成结束逐条
// 续发、撤回生效、被拒回滚队首不丢且不热循环。
// 断言口径：队列是外部 store 驱动的渲染面，条目断言一律经 waitFor
// 沉降（与 useLocalConversationEngine.test 的 store 断言同口径）。
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useSendQueue, type SendQueueDrain } from './useSendQueue';
import {
  resetSendQueueForTest,
  sendQueueStore,
  type SendQueueItem,
} from '@/domain/store/sendQueueStore';

const KEY = 'local:t-queue';

function makeSend(impl?: (item: SendQueueItem) => boolean) {
  return jest.fn((item: SendQueueItem) => (impl ? impl(item) : true));
}

beforeEach(() => {
  resetSendQueueForTest();
});

afterEach(() => {
  resetSendQueueForTest();
});

describe('useSendQueue（排空状态机）', () => {
  it('生成中入队不发送；活动结束逐条续发（一轮一条，活动再起暂停）', async () => {
    const send = makeSend();
    const { result, rerender } = await renderHook(
      ({ active }: { active: boolean }) =>
        useSendQueue(KEY, { active, send } as SendQueueDrain),
      { initialProps: { active: true } }
    );
    await act(async () => {
      result.current.enqueue('第一条');
      result.current.enqueue('第二条');
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(send).not.toHaveBeenCalled();

    // 活动结束 → 队首被发送并出队；受理后进入 awaiting，第二条不连发
    await rerender({ active: false });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].text).toBe('第一条');
    await waitFor(() =>
      expect(result.current.items.map((i) => i.text)).toEqual(['第二条'])
    );

    // 活动再起（第一条的运行开始）→ 落下（运行结束）→ 第二条续发
    await rerender({ active: true });
    await rerender({ active: false });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![0].text).toBe('第二条');
    await waitFor(() => expect(result.current.items).toHaveLength(0));
  });

  it('撤回：排队条目被撤后不再发送', async () => {
    const send = makeSend();
    const { result, rerender } = await renderHook(
      ({ active }: { active: boolean }) =>
        useSendQueue(KEY, { active, send } as SendQueueDrain),
      { initialProps: { active: true } }
    );
    await act(async () => {
      result.current.enqueue('要撤回的');
      result.current.enqueue('保留的');
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    const firstId = result.current.items[0]!.id;
    await act(async () => {
      result.current.withdraw(firstId);
    });
    await waitFor(() =>
      expect(result.current.items.map((i) => i.text)).toEqual(['保留的'])
    );
    await rerender({ active: false });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].text).toBe('保留的');
  });

  it('发送被拒：条目回滚队首不丢失，同一条不自动重试（闩住）', async () => {
    let calls = 0;
    const send = makeSend(() => {
      calls += 1;
      return calls > 1; // 第一次拒，之后受理
    });
    const { result, rerender } = await renderHook(
      ({ active }: { active: boolean }) =>
        useSendQueue(KEY, { active, send } as SendQueueDrain),
      { initialProps: { active: false } }
    );
    await act(async () => {
      result.current.enqueue('会被拒一次');
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // 回滚：仍在队列里，不丢
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    // 无活动周期变化时不自动重试（不热循环）：再渲染一拍仍只调一次
    await rerender({ active: false });
    expect(send).toHaveBeenCalledTimes(1);
    // 一轮活动周期（用户手动发了一轮）落下 → 解闩重试并成功出队
    await rerender({ active: true });
    await rerender({ active: false });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.items).toHaveLength(0));
    expect(sendQueueStore.getState().queues[KEY] ?? []).toHaveLength(0);
  });

  it('blocked（未连接/未配置）：不取队首，解除后自动续发', async () => {
    const send = makeSend();
    const { result, rerender } = await renderHook(
      ({ blocked }: { blocked: boolean }) =>
        useSendQueue(KEY, { active: false, blocked, send } as SendQueueDrain),
      { initialProps: { blocked: true } }
    );
    await act(async () => {
      result.current.enqueue('等连接');
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(send).not.toHaveBeenCalled();
    await rerender({ blocked: false });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.items).toHaveLength(0));
  });
});
