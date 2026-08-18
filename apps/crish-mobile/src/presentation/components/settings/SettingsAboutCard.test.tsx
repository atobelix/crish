// SettingsAboutCard 组件测试（R2-06 关于卡片 + R2-16 §3.2 第 7 项热区修复）：
// - 渲染冒烟：版本 / 桌面连接四态（disconnected/loading/error/loaded 在线离线）/
//   桌面 id 短显 / 镜像摘要（只读展示，F6 §8.1 手机端不改权限）；
// - 热区断言（R2-16 §3.2 表项 7）：重试钮视觉 minHeight 28 → dualHitSlop(28)
//   补足 iOS 44pt（全向补 8）/ Android 48dp（全向补 10）；28+8×2=44 达标；
//   press → onRefresh 上抛。
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { PresenceResult } from '@crish/shared-types';
import type { SettingsMirror } from '@/adapters/viewmodels/useSettingsVm';
import SettingsAboutCard, { shortDesktopId } from './SettingsAboutCard';

// jest-expo 默认解析 ios 平台（haste defaultPlatform=ios）；Android 分支用例临时改写 Platform.OS
const ORIGINAL_OS = Platform.OS;

afterEach(() => {
  Platform.OS = ORIGINAL_OS;
});

function makePresence(overrides: Partial<PresenceResult> = {}): PresenceResult {
  return { desktopOnline: true, engineVersion: '1.4.2', ...overrides };
}

function makeMirror(overrides: Partial<SettingsMirror> = {}): SettingsMirror {
  return {
    permissionMode: 'ask',
    trustedCommandCount: 12,
    activeProfileId: null,
    ...overrides,
  };
}

describe('shortDesktopId（桌面 id 短显前 4 位）', () => {
  it('超长 → 截前 4 位；null → null、空串 → 空串（均不显示）', () => {
    expect(shortDesktopId('hub-1-a1b2c3')).toBe('hub-');
    expect(shortDesktopId('hub-1')).toBe('hub-');
    expect(shortDesktopId('hub')).toBe('hub');
    expect(shortDesktopId(null)).toBeNull();
    expect(shortDesktopId('')).toBe('');
  });
});

describe('SettingsAboutCard 四态渲染（R2UX-06 关于卡）', () => {
  it('loaded 在线：版本 + 桌面连接信息 + 镜像摘要（只读）', async () => {
    await render(
      <SettingsAboutCard
        status="loaded"
        presence={makePresence()}
        mirror={makeMirror()}
        host="192.168.1.5"
        desktopId="hub-1-a1b2c3"
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByText('1.4.2')).toBeTruthy();
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.getByText('192.168.1.5')).toBeTruthy();
    expect(screen.getByText('桌面 #hub-')).toBeTruthy();
    expect(screen.getByText(/ask/)).toBeTruthy();
    expect(screen.getByText(/信任 12 条/)).toBeTruthy();
  });

  it('loaded 离线：desktopOnline=false → 「离线」', async () => {
    await render(
      <SettingsAboutCard
        status="loaded"
        presence={makePresence({ desktopOnline: false })}
        mirror={null}
        host={null}
        desktopId={null}
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByText('离线')).toBeTruthy();
  });

  it('disconnected → 「未连接」禁用文案（不渲染重试钮）', async () => {
    await render(
      <SettingsAboutCard
        status="disconnected"
        presence={null}
        mirror={null}
        host={null}
        desktopId={null}
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByText('未连接')).toBeTruthy();
    expect(screen.queryByTestId('settings-about-refresh')).toBeNull();
  });

  it('loading → 菊花（版本行仍在，数据区不渲染）', async () => {
    await render(
      <SettingsAboutCard
        status="loading"
        presence={null}
        mirror={null}
        host={null}
        desktopId={null}
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByText('版本')).toBeTruthy();
    expect(screen.queryByText('在线')).toBeNull();
    expect(screen.queryByText('获取失败')).toBeNull();
  });

  it('error → 「获取失败」+ 重试钮 press → onRefresh', async () => {
    const onRefresh = jest.fn();
    await render(
      <SettingsAboutCard
        status="error"
        presence={null}
        mirror={null}
        host={null}
        desktopId={null}
        onRefresh={onRefresh}
      />
    );
    expect(screen.getByText('获取失败')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-about-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('无障碍：重试钮 role=button + 中文读屏标签', async () => {
    await render(
      <SettingsAboutCard
        status="error"
        presence={null}
        mirror={null}
        host={null}
        desktopId={null}
        onRefresh={jest.fn()}
      />
    );
    const retry = screen.getByTestId('settings-about-refresh');
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.accessibilityLabel).toBe('重试获取桌面连接信息');
  });
});

describe('SettingsAboutCard 重试钮热区（R2-16 §3.2 第 7 项）', () => {
  it('iOS（默认）：视觉 28 + dualHitSlop(28) 全向补 8 → 有效热区 44pt', async () => {
    await render(
      <SettingsAboutCard
        status="error"
        presence={null}
        mirror={null}
        host={null}
        desktopId={null}
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByTestId('settings-about-refresh').props.hitSlop).toEqual({
      top: 8,
      bottom: 8,
      left: 8,
      right: 8,
    });
  });

  it('Android：视觉 28 + dualHitSlop(28) 全向补 10 → 命中热区 48dp', async () => {
    Platform.OS = 'android';
    await render(
      <SettingsAboutCard
        status="error"
        presence={null}
        mirror={null}
        host={null}
        desktopId={null}
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByTestId('settings-about-refresh').props.hitSlop).toEqual({
      top: 10,
      bottom: 10,
      left: 10,
      right: 10,
    });
  });
});
