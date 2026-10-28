// useSettingsVm 视图模型测试（R2-06 部分 3）：
// 未连接禁用投影 / 本机偏好开关 / 主题切换 / 关于装载（queryPresence+getSettings
// 并行 + 竞态 + 错误重试 + 断线诚实化）/ 移除本机（注入 + 缺省 unpair 退化路径）
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { connectionStore } from '@/domain/store/connectionStore';
import { authStore } from '@/domain/store/authStore';
import { resetPairingWiringForTest } from '@/adapters/wiring/pairing';
import {
  resetSettingsContextForTest,
  type SettingsContext,
} from '@/adapters/settings/settingsWiring';
import type { SettingsRepository } from '@/adapters/settings/settingsRepository';
import { SettingsCommandError } from '@/adapters/settings/settingsRepository';
import {
  resetSettingsLocalStoreForTest,
  settingsLocalStore,
} from '@/adapters/settings/settingsLocalStore';
import {
  resetThemeModeForTest,
  themeModeStore,
} from '@/adapters/platform/theme';
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
  resetSettingsLocalStoreForTest();
  resetThemeModeForTest();
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

// ── 本机偏好开关与主题 ────────────────────────────────────────────────────

describe('useSettingsVm 开关与主题', () => {
  it('开关切换 → settingsLocalStore 更新（通知偏好 + 缩略图）', async () => {
    const { result } = await renderHook(() => useSettingsVm());
    expect(result.current.approvalNotifications).toBe(true);
    expect(result.current.eventNotifications).toBe(true);
    expect(result.current.thumbnailWifiOnly).toBe(true);
    await act(async () => {
      result.current.setApprovalNotifications(false);
      result.current.setEventNotifications(false);
      result.current.setThumbnailWifiOnly(false);
    });
    expect(settingsLocalStore.getState().prefs.approvalNotifications).toBe(
      false
    );
    expect(settingsLocalStore.getState().prefs.eventNotifications).toBe(false);
    expect(settingsLocalStore.getState().prefs.thumbnailWifiOnly).toBe(false);
    expect(result.current.approvalNotifications).toBe(false);
  });

  it('主题切换 → themeModeStore 更新（三选，R2UX-06-05）', async () => {
    const { result } = await renderHook(() => useSettingsVm());
    expect(result.current.themeMode).toBe('system');
    await act(async () => {
      result.current.setThemeMode('dark');
    });
    expect(themeModeStore.getState().mode).toBe('dark');
    expect(result.current.themeMode).toBe('dark');
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
