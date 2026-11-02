// 已知设备目录合并：新鲜快照权威、历史设备离线保留、排序确定性。
import { mergeKnownDevices } from './deviceDirectory';
import type { AccountDevice } from '@/domain/types/account';

function device(
  id: string,
  online: boolean,
  lastSeenAt = 0,
  name = id
): AccountDevice {
  return { id, name, platform: 'desktop', lastSeenAt, online };
}

describe('mergeKnownDevices', () => {
  it('首次合并 = 新鲜快照本身（在线在前）', () => {
    const merged = mergeKnownDevices(
      [],
      [device('desk-b', true, 10), device('desk-a', true, 20)]
    );
    expect(merged.map((d) => d.id)).toEqual(['desk-a', 'desk-b']);
    expect(merged.every((d) => d.online)).toBe(true);
  });

  it('本次未命中的历史设备保留但强制离线（不谎报在线）', () => {
    const known = [device('desk-a', true, 100), device('desk-b', true, 90)];
    const merged = mergeKnownDevices(known, [device('desk-b', true, 200)]);
    const a = merged.find((d) => d.id === 'desk-a');
    const b = merged.find((d) => d.id === 'desk-b');
    expect(a).toBeTruthy();
    expect(a?.online).toBe(false);
    expect(b?.online).toBe(true);
    expect(b?.lastSeenAt).toBe(200);
    // 在线在前：b 排在 a 之前
    expect(merged[0]?.id).toBe('desk-b');
  });

  it('命中设备的名称/在线状态以新鲜快照为准（改名跟随）', () => {
    const known = [device('desk-a', false, 10, '旧名')];
    const merged = mergeKnownDevices(known, [
      device('desk-a', true, 50, '新名'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('新名');
    expect(merged[0]?.online).toBe(true);
  });

  it('空发现轮次：全部已知设备转为离线保留（不清空目录）', () => {
    const known = [device('desk-a', true, 10), device('desk-b', true, 5)];
    const merged = mergeKnownDevices(known, []);
    expect(merged).toHaveLength(2);
    expect(merged.every((d) => !d.online)).toBe(true);
  });

  it('同为离线时按 lastSeenAt 倒序，再按 id 升序保证确定性', () => {
    const known = [
      device('desk-c', true, 10),
      device('desk-a', true, 10),
      device('desk-b', true, 30),
    ];
    const merged = mergeKnownDevices(known, []);
    expect(merged.map((d) => d.id)).toEqual(['desk-b', 'desk-a', 'desk-c']);
  });

  it('不修改入参数组与条目（纯函数）', () => {
    const known = [device('desk-a', true, 10)];
    const fresh = [device('desk-b', true, 20)];
    const merged = mergeKnownDevices(known, fresh);
    expect(known[0]?.online).toBe(true);
    expect(merged.find((d) => d.id === 'desk-a')?.online).toBe(false);
    expect(merged).not.toBe(known);
  });
});
