/**
 * computerPanelLib 纯函数层测试：三态归一化 / 载荷解析（合法与防御非法）/
 * 按钮可用性矩阵。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPUTER_ACTIVATION_DESC,
  COMPUTER_ACTIVATION_LABEL,
  canDisableComputerSession,
  canEnableComputerSession,
  isComputerActivation,
  normalizeComputerActivation,
  parseComputerStatePayload,
  type ComputerActivation,
} from './computerPanelLib';

describe('computerPanelLib 三态归一化', () => {
  it('isComputerActivation：仅接受三态契约值', () => {
    expect(isComputerActivation('idle')).toBe(true);
    expect(isComputerActivation('browser')).toBe(true);
    expect(isComputerActivation('desktop')).toBe(true);
    expect(isComputerActivation('BrowserActive')).toBe(false);
    expect(isComputerActivation('active')).toBe(false);
    expect(isComputerActivation(123)).toBe(false);
    expect(isComputerActivation(null)).toBe(false);
  });

  it('normalizeComputerActivation：合法原样 / 非法返回 null', () => {
    expect(normalizeComputerActivation('desktop')).toBe('desktop');
    expect(normalizeComputerActivation('bogus')).toBeNull();
    expect(normalizeComputerActivation(undefined)).toBeNull();
  });

  it('三态文案齐全（Idle/BrowserActive/DesktopActive 语义）', () => {
    const modes: ComputerActivation[] = ['idle', 'browser', 'desktop'];
    for (const m of modes) {
      expect(COMPUTER_ACTIVATION_LABEL[m]).toBeTruthy();
      expect(COMPUTER_ACTIVATION_DESC[m]).toBeTruthy();
    }
    expect(COMPUTER_ACTIVATION_LABEL.idle).toContain('待机');
    expect(COMPUTER_ACTIVATION_LABEL.browser).toContain('浏览器');
    expect(COMPUTER_ACTIVATION_LABEL.desktop).toContain('桌面');
  });
});

describe('computerPanelLib 载荷解析', () => {
  it('status 载荷：enabled + mode 完整解析', () => {
    expect(
      parseComputerStatePayload({ enabled: true, mode: 'desktop' })
    ).toEqual({ enabled: true, activation: 'desktop' });
  });

  it('事件载荷：仅携带变更域（enabled-only / mode-only）', () => {
    expect(parseComputerStatePayload({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(parseComputerStatePayload({ mode: 'browser' })).toEqual({
      activation: 'browser',
    });
  });

  it('防御非法载荷：enabled 非布尔忽略 / mode 非法忽略 / 全非法返回 null', () => {
    expect(
      parseComputerStatePayload({ enabled: 'yes', mode: 'desktop' })
    ).toEqual({ activation: 'desktop' });
    expect(
      parseComputerStatePayload({ enabled: true, mode: 'active' })
    ).toEqual({ enabled: true });
    expect(
      parseComputerStatePayload({ enabled: 1, mode: 'active' })
    ).toBeNull();
    expect(parseComputerStatePayload(null)).toBeNull();
    expect(parseComputerStatePayload('x')).toBeNull();
    expect(parseComputerStatePayload({})).toBeNull();
  });
});

describe('computerPanelLib 按钮可用性矩阵', () => {
  it('启用：仅未开启时可用；停用：仅已开启时可用', () => {
    expect(canEnableComputerSession(false)).toBe(true);
    expect(canEnableComputerSession(true)).toBe(false);
    expect(canDisableComputerSession(false)).toBe(false);
    expect(canDisableComputerSession(true)).toBe(true);
  });
});
