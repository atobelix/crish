// useSettingsVm 视图模型测试（R2-06 部分 3 · R4 批次2 单真源）：
// 未连接禁用投影 / 通知偏好开关（settingsStore 持久化 + 权限联动）/ 主题切换 /
// 关于装载（queryPresence+getSettings 并行 + 竞态 + 错误重试 + 断线诚实化）/
// 移除本机（注入 + 缺省 unpair 退化路径）
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { connectionStore } from '@/domain/store/connectionStore';
import { authStore } from '@/domain/store/authStore';
import {
  settingsStore,
  configureSettingsPersistence,
} from '@/domain/store/settingsStore';
import { defaultSettingsGroups } from '@/domain/store/settingsReducers';
import { resetPairingWiringForTest } from '@/adapters/wiring/pairing';
import {
  resetSettingsContextForTest,
  type SettingsContext,
} from '@/adapters/settings/settingsWiring';
import type { SettingsRepository } from '@/adapters/settings/settingsRepository';
import { SettingsCommandError } from '@/adapters/settings/settingsRepository';
import { notificationPermissionStore } from '@/notifications/permissions';
import {
  defaultRemoveLocal,
  mirrorInfoOf,
  useSettingsVm,
} from './useSettingsVm';

// ── 测试基建 ──────────────────────────────────────────────────────────────

function makeFakeRepo(): SettingsRepository {
  return {
    getSettings: jest.fn(async () => ({
      settings: {
        permissionMode: 'ask',
        trustedCommandCount: 12,
        activeProfileId: 'default',
      },
    })),
    setSettings: jest.fn(async () => ({ ok: true, applied: true })),
    queryPresence: jest.fn(async () => ({
      desktopOnline: true,
      engineVersion: '1.4.2',
    })),
  };
}

function makeFakeContext(repo: SettingsRepository): SettingsContext {
  return { repository: repo };
}

beforeEach(() => {
  connectionStore.setState({ phase: 'disconnected' });
  resetSettingsContextForTest();
  configureSettingsPersistence(null);
  settingsStore.setState({
    groups: defaultSettingsGroups(),
    hydrated: false,
  });
  notificationPermissionStore.setState({
    status: 'undetermined',
    checked: false,
    refreshing: false,
  });
  resetPairingWiringForTest();
  authStore.getState().clearPairing();
});

// ── mirrorInfoOf（F6 §3.2 镜像摘要抽取） ──────────────────────────────────

describe('mirrorInfoOf', () => {
  it('快照对象 → 抽取已知字段（其余宽容忽略）', () => {
    expect(
      mirrorInfoOf({
        responseStyle: 'balanced',
        permissionMode: 'ask',
        trustedCommandCount: 12,
        activeProfileId: 'default',
        apiKey: '',
      })
    ).toEqual({
      permissionMode: 'ask',
      trustedCommandCount: 12,
      activeProfileId: 'default',
    });
  });

  it('缺省字段 → null；非对象（null/数组/标量）→ null', () => {
    expect(mirrorInfoOf({})).toEqual({
      permissionMode: null,
      trustedCommandCount: null,
      activeProfileId: null,
    });
    expect(mirrorInfoOf(null)).toBeNull();
    expect(mirrorInfoOf([1, 2])).toBeNull();
    expect(mirrorInfoOf('x')).toBeNull();
  });
});

// ── 连接投影与关于装载 ────────────────────────────────────────────────────

describe('useSettingsVm 连接投影与关于装载', () => {
  it('未连接（phase 非 ready）→ connected=false，不拉取关于数据', async () => {
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    const { result } = await renderHook(() => useSettingsVm(ctx));
    expect(result.current.connected).toBe(false);
    expect(result.current.aboutStatus).toBe('disconnected');
    expect(repo.queryPresence).not.toHaveBeenCalled();
    expect(repo.getSettings).not.toHaveBeenCalled();
  });

  it('连接就绪 → 并行拉 queryPresence + getSettings → loaded（在场/版本/镜像）', async () => {
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSettingsVm(ctx));
    await waitFor(() => expect(result.current.aboutStatus).toBe('loaded'));
    expect(repo.queryPresence).toHaveBeenCalledTimes(1);
    expect(repo.getSettings).toHaveBeenCalledTimes(1);
    expect(result.current.presence).toEqual({
      desktopOnline: true,
      engineVersion: '1.4.2',
    });
    expect(result.current.mirror).toEqual({
      permissionMode: 'ask',
      trustedCommandCount: 12,
      activeProfileId: 'default',
    });
  });

  it('拉取失败 → error 态；refreshAbout 重试成功 → loaded', async () => {
    const repo = makeFakeRepo();
    (repo.queryPresence as jest.Mock).mockRejectedValueOnce(
      new SettingsCommandError('transport.closed', '未连接', true)
    );
    const ctx = makeFakeContext(repo);
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSettingsVm(ctx));
    await waitFor(() => expect(result.current.aboutStatus).toBe('error'));
    await act(async () => {
      result.current.refreshAbout();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.aboutStatus).toBe('loaded'));
  });

  it('loaded 后断线（相位离开 ready）→ disconnected 诚实化', async () => {
    const repo = makeFakeRepo();
    const ctx = makeFakeContext(repo);
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSettingsVm(ctx));
    await waitFor(() => expect(result.current.aboutStatus).toBe('loaded'));
    await act(async () => {
      connectionStore.setState({ phase: 'recovering' });
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.aboutStatus).toBe('disconnected');
    expect(result.current.presence).not.toBeNull(); // 上次数据保留（诚实化）
  });
});

// ── 通知偏好与主题（settingsStore 单真源） ────────────────────────────────

describe('useSettingsVm 通知偏好与主题', () => {
  it('总开关与场景开关切换 → settingsStore.notification 更新（持久化分组）', async () => {
    const { result } = await renderHook(() => useSettingsVm());
    expect(result.current.notifyMasterOn).toBe(true);
    expect(result.current.notifyScenes.approval).toBe(true);
    await act(async () => {
      result.current.setNotifyMasterOn(false);
      result.current.setNotifyScene('approval', false);
    });
    const notify = settingsStore.getState().groups.notification;
    expect(notify.masterOn).toBe(false);
    expect(notify.sceneFlags.approval).toBe(false);
    expect(notify.sceneFlags.message).toBe(true); // 未提及保留
    expect(result.current.notifyMasterOn).toBe(false);
  });

  it('场景开关开（undetermined 首次）→ 先请求权限再落值', async () => {
    const { result } = await renderHook(() => useSettingsVm());
    await act(async () => {
      await result.current.setNotifyScene('taskDone', false);
      await result.current.setNotifyScene('taskDone', true);
    });
    // undetermined → requestPermissionOnEnable 弹系统框（jest mock 恒 granted）→ 落值
    expect(
      settingsStore.getState().groups.notification.sceneFlags.taskDone
    ).toBe(true);
  });

  it('主题切换 → settingsStore.appearance 更新（三选，R2UX-06-05）', async () => {
    const { result } = await renderHook(() => useSettingsVm());
    expect(result.current.themeMode).toBe('system');
    await act(async () => {
      result.current.setThemeMode('dark');
    });
    expect(settingsStore.getState().groups.appearance.theme).toBe('dark');
    expect(result.current.themeMode).toBe('dark');
  });

  it('权限 denied → notifySwitchGate 禁用投影（F6 §10.3 UI 置灰数据面）', async () => {
    notificationPermissionStore.setState({
      status: 'denied',
      checked: true,
      refreshing: false,
    });
    const { result } = await renderHook(() => useSettingsVm());
    expect(result.current.notifyPermission).toBe('denied');
    expect(result.current.notifySwitchGate.enabled).toBe(false);
    expect(result.current.notifySwitchGate.hint).toContain('前往设置');
  });
});

// ── 移除本机 ──────────────────────────────────────────────────────────────

describe('useSettingsVm 移除本机（M5 §6.2 / R2UX-06-06）', () => {
  it('注入 removeLocal 被调用一次；返回值 true（页面层据此重定向）', async () => {
    const removeLocal = jest.fn(async () => {});
    const { result } = await renderHook(() =>
      useSettingsVm(undefined, removeLocal)
    );
    const ok = await act(async () => result.current.removeLocal());
    expect(removeLocal).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
  });

  it('缺省 defaultRemoveLocal：接线未装配 → authStore 复位回 unpaired', async () => {
    await authStore
      .getState()
      .onPaired(
        { deviceId: 'dev-1', desktopId: 'hub-1', host: '192.168.1.5' },
        { issuedAt: 0, ttlMs: 1000 }
      );
    expect(authStore.getState().pairState).toBe('paired');
    await defaultRemoveLocal();
    expect(authStore.getState().pairState).toBe('unpaired');
    expect(authStore.getState().host).toBeNull();
  });

  it('配对身份透传（关于页桌面连接信息数据面）', async () => {
    await authStore
      .getState()
      .onPaired(
        { deviceId: 'dev-1', desktopId: 'hub-1', host: '192.168.1.5' },
        { issuedAt: 0, ttlMs: 1000 }
      );
    const { result } = await renderHook(() => useSettingsVm());
    expect(result.current.host).toBe('192.168.1.5');
    expect(result.current.desktopId).toBe('hub-1');
    expect(result.current.deviceId).toBe('dev-1');
  });
});
