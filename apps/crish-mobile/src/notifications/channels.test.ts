// Android 通道四类单测（R3-04）：定义完整性 / D7 七渠道归一 / 注册调用面
import {
  AndroidImportance,
  setNotificationChannelAsync,
} from 'expo-notifications';
import {
  NOTIFICATION_CHANNELS,
  channelIdOf,
  channelInputOf,
  registerChannelsAsync,
} from './channels';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('四通道定义（Z0 §7.4：approval/run/security/general）', () => {
  it('恰有四类通道且 id 唯一有序', () => {
    expect(NOTIFICATION_CHANNELS.map((c) => c.id)).toEqual([
      'approval',
      'run',
      'security',
      'general',
    ]);
    expect(new Set(NOTIFICATION_CHANNELS.map((c) => c.id)).size).toBe(4);
  });

  it('importance 对齐 D7 §7.7：approval/security MAX，run HIGH，general LOW', () => {
    const byId = Object.fromEntries(
      NOTIFICATION_CHANNELS.map((c) => [c.id, c])
    ) as Record<string, (typeof NOTIFICATION_CHANNELS)[number]>;
    expect(byId.approval!.importance).toBe(AndroidImportance.MAX);
    expect(byId.security!.importance).toBe(AndroidImportance.MAX);
    expect(byId.run!.importance).toBe(AndroidImportance.HIGH);
    expect(byId.general!.importance).toBe(AndroidImportance.LOW);
  });

  it('审批渠道带震动模式（D7 §7.7「可全屏/震动」），其余渠道不设', () => {
    const approval = NOTIFICATION_CHANNELS.find((c) => c.id === 'approval')!;
    expect(approval.vibrationPattern).toEqual([0, 250]);
    for (const c of NOTIFICATION_CHANNELS) {
      if (c.id !== 'approval') {
        expect(c.vibrationPattern).toBeUndefined();
      }
    }
  });

  it('各渠道名称与描述文案齐备（系统设置可见）', () => {
    for (const c of NOTIFICATION_CHANNELS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe('channelIdOf（D7 §7.7 七渠道 → Z0 四类归一）', () => {
  it('七渠道全映射（run/subagent/task/timer 折叠进 run；summary 折叠进 general）', () => {
    expect(channelIdOf('approval')).toBe('approval');
    expect(channelIdOf('run')).toBe('run');
    expect(channelIdOf('subagent')).toBe('run');
    expect(channelIdOf('task')).toBe('run');
    expect(channelIdOf('timer')).toBe('run');
    expect(channelIdOf('security')).toBe('security');
    expect(channelIdOf('summary')).toBe('general');
  });

  it('未知渠道兜底 general（不崩溃不猜测，低打扰收敛）', () => {
    expect(channelIdOf('unknown-channel')).toBe('general');
    expect(channelIdOf('')).toBe('general');
  });
});

describe('registerChannelsAsync（注册调用面）', () => {
  it('注册全部四通道，参数含 name/description/importance', async () => {
    const count = await registerChannelsAsync();
    expect(count).toBe(4);
    expect(setNotificationChannelAsync).toHaveBeenCalledTimes(4);
    for (const def of NOTIFICATION_CHANNELS) {
      expect(setNotificationChannelAsync).toHaveBeenCalledWith(
        def.id,
        channelInputOf(def)
      );
    }
    const approvalArgs = (
      setNotificationChannelAsync as jest.Mock
    ).mock.calls.find(([id]) => id === 'approval');
    expect(approvalArgs?.[1]).toMatchObject({
      name: '审批',
      importance: AndroidImportance.MAX,
      vibrationPattern: [0, 250],
    });
  });

  it('幂等：重复调用不报错（渠道创建幂等语义，权限请求前置重复安全）', async () => {
    await registerChannelsAsync();
    await registerChannelsAsync();
    expect(setNotificationChannelAsync).toHaveBeenCalledTimes(8);
  });
});
