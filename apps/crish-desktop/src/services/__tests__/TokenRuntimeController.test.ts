// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TokenRuntimeController,
  tokenRuntimeController,
  applyTokens,
  computeDynamicSolarAdjustments,
  DEFAULT_PERSONALIZATION,
} from '../TokenRuntimeController';
import { computeContrastGuardedTokens } from '../../api/oklchColorGuard';

describe('TokenRuntimeController 全仓单一运行时 Token 注入控制器测试套件', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
  });

  describe('1. 统一接管与全量 Token 注入权威源', () => {
    it('applyTokens 能够将全量语义 token 注入到 document.documentElement', () => {
      const result = applyTokens(
        {
          skin: 'warm-gray',
          fontSizeAdjust: 2,
          themeBrightnessAdjust: 0,
        },
        'default'
      );

      expect(result.isDark).toBe(false);
      expect(result.theme).toBe('default');

      const root = document.documentElement;
      expect(root.getAttribute('data-theme')).toBe('default');
      expect(root.classList.contains('theme-light')).toBe(true);
      expect(root.classList.contains('theme-dark')).toBe(false);

      expect(root.style.getPropertyValue('--font-size-adjust')).toBe('2px');
      expect(root.style.getPropertyValue('--bg-primary')).toBe('hsl(35 8% 95.2%)');
      expect(root.style.getPropertyValue('--bg-secondary')).toBe('hsl(35 8% 95%)');
      expect(root.style.getPropertyValue('--surface-chrome')).toBe('hsl(35 8% 95%)');
      expect(root.style.getPropertyValue('--surface-card')).toBe('hsl(0 0% 100%)');
      expect(root.style.getPropertyValue('--text-primary')).toBe('#1a1a1a');
      expect(root.style.getPropertyValue('--border-color')).toBe('hsl(35 10% 86%)');
      expect(root.style.getPropertyValue('--control-soft-bg')).toContain('hsl(35 8% 95%)');
      expect(root.style.getPropertyValue('--terminal-bg')).toBe('hsl(0 0% 100%)');
      expect(root.style.getPropertyValue('--terminal-fg')).toBe('#1a1a1a');
    });

    it('单例模式确保全局只有一个 TokenRuntimeController 实例', () => {
      const instance1 = TokenRuntimeController.getInstance();
      const instance2 = TokenRuntimeController.getInstance();
      expect(instance1).toBe(instance2);
      expect(instance1).toBe(tokenRuntimeController);
    });

    it('setCustomProperty 与 removeCustomProperty 提供受控注入面', () => {
      tokenRuntimeController.setCustomProperty('--test-custom-token', '42px');
      expect(document.documentElement.style.getPropertyValue('--test-custom-token')).toBe('42px');

      tokenRuntimeController.removeCustomProperty('--test-custom-token');
      expect(document.documentElement.style.getPropertyValue('--test-custom-token')).toBe('');
    });
  });

  describe('2. 纯布尔明暗判定与派生方向', () => {
    it('暗色模式由纯布尔值 isDark 为 true 驱动，派生深色调色板', () => {
      const result = applyTokens(
        {
          skin: 'dark-cozy',
          fontSizeAdjust: 0,
          themeBrightnessAdjust: 0,
        },
        'dark'
      );

      expect(typeof result.isDark).toBe('boolean');
      expect(result.isDark).toBe(true);
      expect(result.theme).toBe('dark');

      const root = document.documentElement;
      expect(root.getAttribute('data-theme')).toBe('dark');
      expect(root.classList.contains('theme-dark')).toBe(true);
      expect(root.classList.contains('theme-light')).toBe(false);

      expect(root.style.getPropertyValue('--bg-primary')).toBe('#1f1f1f');
      expect(root.style.getPropertyValue('--bg-secondary')).toBe('#191919');
      expect(root.style.getPropertyValue('--text-primary')).toBe('#cccccc');
    });

    it('浅色模式由纯布尔值 isDark 为 false 驱动，派生浅色调色板', () => {
      const result = applyTokens(
        {
          skin: 'classic-gray',
          fontSizeAdjust: 0,
          themeBrightnessAdjust: 0,
        },
        'default'
      );

      expect(typeof result.isDark).toBe('boolean');
      expect(result.isDark).toBe(false);
      expect(result.theme).toBe('default');

      const root = document.documentElement;
      expect(root.getAttribute('data-theme')).toBe('default');
      expect(root.classList.contains('theme-light')).toBe(true);
      expect(root.classList.contains('theme-dark')).toBe(false);

      expect(root.style.getPropertyValue('--bg-primary')).toBe('#f1f3f5');
      expect(root.style.getPropertyValue('--text-primary')).toBe('#212529');
    });

    it('智能时光温感过渡基于当前时刻布尔判定深浅模式', () => {
      // 14:00 (白天正午)
      const dayAdjust = computeDynamicSolarAdjustments(14);
      expect(dayAdjust.brightnessAdjust).toBe(1);
      expect(dayAdjust.periodLabel).toContain('耀眼正午');

      // 23:00 (深夜)
      const nightAdjust = computeDynamicSolarAdjustments(23);
      expect(nightAdjust.brightnessAdjust).toBeLessThan(0);
      expect(nightAdjust.periodLabel).toContain('深夜静谧');
    });
  });

  describe('3. 对比度防崩算法纯函数与反模式根除', () => {
    it('判定完全使用纯布尔逻辑，不依赖字符串相等反推', () => {
      // 极黑自定义背景 -> 纯布尔 isDarkBg 判定为 true，高对比白色文字
      const darkGuarded = computeContrastGuardedTokens('#050505', true, {
        isCustomSkin: true,
        explicitTextPrimary: '#1a1a1a',
      });
      expect(darkGuarded).not.toBeNull();
      expect(darkGuarded?.isDarkBg).toBe(true);
      expect(typeof darkGuarded?.isDarkBg).toBe('boolean');
      expect(darkGuarded?.textPrimary).toBe('hsl(0, 0%, 94%)');
      expect(darkGuarded?.textSecondary).toBe('hsl(0, 0%, 72%)');
      expect(darkGuarded?.textTertiary).toBe('hsl(0, 0%, 50%)');

      // 极白自定义背景 -> 纯布尔 isDarkBg 判定为 false，高对比深灰文字
      const lightGuarded = computeContrastGuardedTokens('#ffffff', false, {
        isCustomSkin: true,
        explicitTextPrimary: '#e0e0e0',
      });
      expect(lightGuarded).not.toBeNull();
      expect(lightGuarded?.isDarkBg).toBe(false);
      expect(typeof lightGuarded?.isDarkBg).toBe('boolean');
      expect(lightGuarded?.textPrimary).toBe('hsl(35, 12%, 11%)');
      expect(lightGuarded?.textSecondary).toBe('hsl(35, 8%, 34%)');
      expect(lightGuarded?.textTertiary).toBe('hsl(35, 6%, 52%)');
    });

    it('官方预设且提供字色时不作侵入式覆盖', () => {
      const nonOverridden = computeContrastGuardedTokens('#ffffff', false, {
        isCustomSkin: false,
        explicitTextPrimary: '#1a1a1a',
      });
      expect(nonOverridden).toBeNull();
    });
  });

  describe('4. 全局事件派发通知 Canvas 与终端重上色', () => {
    it('applyTokens 派发 crish-theme-changed、crish-tokens-updated 与 crish-canvas-recolor 事件', () => {
      const themeChangedSpy = vi.fn();
      const tokensUpdatedSpy = vi.fn();
      const canvasRecolorSpy = vi.fn();

      window.addEventListener('crish-theme-changed', themeChangedSpy);
      window.addEventListener('crish-tokens-updated', tokensUpdatedSpy);
      window.addEventListener('crish-canvas-recolor', canvasRecolorSpy);

      applyTokens(
        {
          skin: 'warm-gray',
          fontSizeAdjust: 0,
        },
        'default'
      );

      expect(themeChangedSpy).toHaveBeenCalledTimes(1);
      expect(tokensUpdatedSpy).toHaveBeenCalledTimes(1);
      expect(canvasRecolorSpy).toHaveBeenCalledTimes(1);

      const updateEvent = tokensUpdatedSpy.mock.calls[0][0] as CustomEvent;
      expect(updateEvent.detail.isDark).toBe(false);
      expect(updateEvent.detail.theme).toBe('default');
      expect(updateEvent.detail.tokens['--bg-primary']).toBeDefined();

      const canvasEvent = canvasRecolorSpy.mock.calls[0][0] as CustomEvent;
      expect(canvasEvent.detail.isDark).toBe(false);
      expect(canvasEvent.detail.tokens).toBeDefined();

      window.removeEventListener('crish-theme-changed', themeChangedSpy);
      window.removeEventListener('crish-tokens-updated', tokensUpdatedSpy);
      window.removeEventListener('crish-canvas-recolor', canvasRecolorSpy);
    });
  });

  describe('5. visualThemeController 布局尺寸 Token 统一接管', () => {
    it('setUiScale 正确更新 --ui-scale 变量', () => {
      tokenRuntimeController.setUiScale('small');
      expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('0.9');

      tokenRuntimeController.setUiScale('medium');
      expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.0');

      tokenRuntimeController.setUiScale('large');
      expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.1');
    });
  });

  describe('6. 自定义颜色派生', () => {
    it('在自定义皮肤下正确派生双层背景与边界色', () => {
      const result = applyTokens(
        {
          skin: 'custom',
          customBg: '#223344',
          customFg: '#ffffff',
          fontSizeAdjust: 0,
        },
        'dark'
      );

      expect(result.isDark).toBe(true);
      expect(result.tokens['--bg-primary']).toBe('#223344');
      // 自定义极端暗色背景触发对比度防崩安全算法，派生高对比度亮白
      expect(result.tokens['--text-primary']).toBe('hsl(0, 0%, 94%)');
      expect(result.tokens['--bg-secondary']).toContain('color-mix(');
      expect(document.documentElement.style.getPropertyValue('--bg-primary')).toBe('#223344');
    });
  });

  describe('7. 静态契约默认值与杜绝 localStorage 依赖', () => {
    it('在缺省 preferences 时统一回退到 DEFAULT_PERSONALIZATION 且完全不读取 localStorage', () => {
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
      const result = applyTokens(null, 'default');
      expect(getItemSpy).not.toHaveBeenCalled();
      expect(result.preferences).toEqual(DEFAULT_PERSONALIZATION);
    });
  });
});

