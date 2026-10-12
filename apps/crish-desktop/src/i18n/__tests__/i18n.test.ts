// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import {
  DEFAULT_LANGUAGE,
  STORAGE_KEY_LOCALE,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from '../types';
import { zhCN, enUS, dictionaries } from '../locales';
import {
  interpolate,
  resolveDictionaryKey,
  createTranslateFunction,
  getInitialLanguage,
  persistLanguage,
  I18nProvider,
} from '../I18nContext';
import { useI18n, t } from '../useI18n';
import {
  toUserVisibleError,
  registerErrorTranslateFn,
} from '../../utils/error-translation';
import type { CrishErrorPayload } from '@crish/shared-types';

/**
 * 递归收集对象所有点号路径 key
 */
function collectAllKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectAllKeys(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

describe('i18n 国际化子系统', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('lang');
    registerErrorTranslateFn(null);
  });

  // ── 1. 字典完整性与键对齐（Zero Missing Keys）──
  describe('字典键对齐与完整性 (Key Parity)', () => {
    it('zh-CN 与 en-US 拥有完全一致的键集合 (零缺失)', () => {
      const zhKeys = collectAllKeys(zhCN as unknown as Record<string, unknown>);
      const enKeys = collectAllKeys(enUS as unknown as Record<string, unknown>);

      const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
      const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));

      expect(
        missingInEn,
        `en-US 缺失翻译键: ${missingInEn.join(', ')}`
      ).toEqual([]);
      expect(
        missingInZh,
        `zh-CN 缺失翻译键: ${missingInZh.join(', ')}`
      ).toEqual([]);
      expect(zhKeys).toEqual(enKeys);
    });

    it('必须覆盖需求规范中全部 common 强类型键', () => {
      const requiredCommonKeys = [
        'ok',
        'cancel',
        'save',
        'delete',
        'confirm',
        'close',
        'copy',
        'copied',
        'retry',
        'loading',
        'search',
        'error',
        'success',
        'refresh',
        'back',
        'next',
      ] as const;

      for (const key of requiredCommonKeys) {
        expect(zhCN.common[key]).toBeDefined();
        expect(zhCN.common[key].length).toBeGreaterThan(0);
        expect(enUS.common[key]).toBeDefined();
        expect(enUS.common[key].length).toBeGreaterThan(0);
      }
    });

    it('必须覆盖需求规范中全部 nav 强类型键', () => {
      const requiredNavKeys = [
        'sessions',
        'models',
        'settings',
        'profile',
        'extensions',
        'appearance',
        'shortcuts',
        'security',
        'about',
        'diagnostics',
      ] as const;

      for (const key of requiredNavKeys) {
        expect(zhCN.nav[key]).toBeDefined();
        expect(zhCN.nav[key].length).toBeGreaterThan(0);
        expect(enUS.nav[key]).toBeDefined();
        expect(enUS.nav[key].length).toBeGreaterThan(0);
      }
    });

    it('必须覆盖需求规范中全部 chat 强类型键', () => {
      const requiredChatKeys = [
        'newSession',
        'emptyStateTitle',
        'emptyStateSubtitle',
        'placeholder',
        'send',
        'stop',
        'attach',
        'systemPrompt',
        'clearHistory',
      ] as const;

      for (const key of requiredChatKeys) {
        expect(zhCN.chat[key]).toBeDefined();
        expect(zhCN.chat[key].length).toBeGreaterThan(0);
        expect(enUS.chat[key]).toBeDefined();
        expect(enUS.chat[key].length).toBeGreaterThan(0);
      }
    });

    it('必须覆盖需求规范中全部 chat 扩展强类型键 (prompts, welcome, quickActions, importChat, newProject)', () => {
      const expandedChatKeys = [
        'prompts',
        'welcome',
        'quickActions',
        'importChat',
        'newProject',
      ] as const;

      for (const key of expandedChatKeys) {
        expect(zhCN.chat[key]).toBeDefined();
        expect(zhCN.chat[key].length).toBeGreaterThan(0);
        expect(enUS.chat[key]).toBeDefined();
        expect(enUS.chat[key].length).toBeGreaterThan(0);
      }
    });

    it('必须覆盖需求规范中全部 workspace 强类型键 (switchWorkspace, currentWorkspace, guestUser, settingsNav)', () => {
      const requiredWorkspaceKeys = [
        'switchWorkspace',
        'currentWorkspace',
        'guestUser',
        'settingsNav',
      ] as const;

      for (const key of requiredWorkspaceKeys) {
        expect(zhCN.workspace[key]).toBeDefined();
        expect(zhCN.workspace[key].length).toBeGreaterThan(0);
        expect(enUS.workspace[key]).toBeDefined();
        expect(enUS.workspace[key].length).toBeGreaterThan(0);
      }
    });

    it('必须覆盖需求规范中全部 settings 强类型键', () => {
      const requiredSettingsKeys = [
        'title',
        'general',
        'language',
        'theme',
        'dark',
        'light',
        'system',
        'fontSize',
        'aboutTitle',
        'license',
        'version',
      ] as const;

      for (const key of requiredSettingsKeys) {
        expect(zhCN.settings[key]).toBeDefined();
        expect(zhCN.settings[key].length).toBeGreaterThan(0);
        expect(enUS.settings[key]).toBeDefined();
        expect(enUS.settings[key].length).toBeGreaterThan(0);
      }
    });

    it('必须覆盖需求规范中全部 about 强类型键', () => {
      const requiredAboutKeys = [
        'appVersion',
        'kernelVersion',
        'openSourceLicense',
        'viewLicense',
        'viewThirdParty',
        'noticeTitle',
        'copySysInfo',
        'sysInfoCopied',
      ] as const;

      for (const key of requiredAboutKeys) {
        expect(zhCN.about[key]).toBeDefined();
        expect(zhCN.about[key].length).toBeGreaterThan(0);
        expect(enUS.about[key]).toBeDefined();
        expect(enUS.about[key].length).toBeGreaterThan(0);
      }
    });

    it('支持的语言包含 zh-CN (默认) 与 en-US', () => {
      expect(DEFAULT_LANGUAGE).toBe('zh-CN');
      expect(SUPPORTED_LANGUAGES).toContain('zh-CN');
      expect(SUPPORTED_LANGUAGES).toContain('en-US');
      expect(dictionaries['zh-CN']).toBe(zhCN);
      expect(dictionaries['en-US']).toBe(enUS);
    });
  });

  // ── 2. 键解析与参数插值 (Parameter Interpolation & Resolution) ──
  describe('参数插值与键解析 (Interpolation & Resolution)', () => {
    it('resolveDictionaryKey 正确解析命名空间与多级路径', () => {
      expect(resolveDictionaryKey(zhCN, 'common.ok')).toBe('确定');
      expect(resolveDictionaryKey(enUS, 'common.ok')).toBe('OK');
      expect(resolveDictionaryKey(zhCN, 'chat.send')).toBe('发送');
      expect(resolveDictionaryKey(zhCN, 'chat.welcome')).toBe('欢迎');
      expect(resolveDictionaryKey(enUS, 'chat.welcome')).toBe('Welcome');
      expect(resolveDictionaryKey(zhCN, 'workspace.guestUser')).toBe(
        '访客用户'
      );
      expect(resolveDictionaryKey(enUS, 'workspace.guestUser')).toBe(
        'Guest User'
      );
      expect(resolveDictionaryKey(enUS, 'settings.language')).toBe('Language');
      expect(resolveDictionaryKey(zhCN, 'error.provider.network.title')).toBe(
        '网络错误'
      );
      expect(resolveDictionaryKey(enUS, 'error.provider.network.title')).toBe(
        'Network error'
      );
      expect(resolveDictionaryKey(zhCN, 'nonexistent.key')).toBeUndefined();
    });

    it('interpolate 支持单变量与多变量字符串替换', () => {
      expect(interpolate('Hello, {name}!', { name: 'Crish' })).toBe(
        'Hello, Crish!'
      );
      expect(interpolate('{min} 到 {max} 条记录', { min: 1, max: 100 })).toBe(
        '1 到 100 条记录'
      );
      expect(interpolate('进度: {count}%', { count: 85 })).toBe('进度: 85%');
    });

    it('interpolate 未匹配的变量占位符原样保留', () => {
      expect(interpolate('用户 {user}: {action}', { user: 'Alice' })).toBe(
        '用户 Alice: {action}'
      );
      expect(interpolate('无变量文本')).toBe('无变量文本');
    });

    it('t() 结合 fallback 与 params 完成插值', () => {
      const zhT = createTranslateFunction(zhCN);
      const enT = createTranslateFunction(enUS);

      expect(zhT('common.ok')).toBe('确定');
      expect(enT('common.ok')).toBe('OK');

      // key 不存在时使用 fallback
      expect(zhT('custom.welcome', '欢迎 {name}！', { name: '小明' })).toBe(
        '欢迎 小明！'
      );
      expect(enT('custom.welcome', 'Welcome, {name}!', { name: 'Alice' })).toBe(
        'Welcome, Alice!'
      );

      // params 作为第二参数传入
      expect(zhT('missing.key', { name: '测试' })).toBe('missing.key');
    });
  });

  // ── 3. 语言切换与 localStorage 持久化 (Persistence & Switching) ──
  describe('语言切换与 localStorage 持久化', () => {
    it('localStorage 初始为空时默认采用 zh-CN', () => {
      expect(getInitialLanguage()).toBe('zh-CN');
    });

    it('localStorage 存在 en-US 时正确读取', () => {
      localStorage.setItem(STORAGE_KEY_LOCALE, 'en-US');
      expect(getInitialLanguage()).toBe('en-US');
    });

    it('persistLanguage 写入 localStorage 并更新 html lang 属性', () => {
      persistLanguage('en-US');
      expect(localStorage.getItem(STORAGE_KEY_LOCALE)).toBe('en-US');
      expect(document.documentElement.getAttribute('lang')).toBe('en-US');

      persistLanguage('zh-CN');
      expect(localStorage.getItem(STORAGE_KEY_LOCALE)).toBe('zh-CN');
      expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    });

    it('I18nProvider 支持在 React 组件中即时切换语言并响应渲染', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      let currentLang: SupportedLanguage = 'zh-CN';
      let switchLang: (l: SupportedLanguage) => void = () => {};

      function TestConsumer() {
        const { language, setLanguage, t } = useI18n();
        currentLang = language;
        switchLang = setLanguage;
        return React.createElement(
          'div',
          null,
          React.createElement('span', { id: 'title' }, t('common.ok')),
          React.createElement('span', { id: 'lang' }, language)
        );
      }

      await act(async () => {
        root.render(
          React.createElement(
            I18nProvider,
            { initialLanguage: 'zh-CN' },
            React.createElement(TestConsumer)
          )
        );
      });

      expect(currentLang).toBe('zh-CN');
      expect(container.querySelector('#title')?.textContent).toBe('确定');
      expect(container.querySelector('#lang')?.textContent).toBe('zh-CN');

      // 切换为 en-US
      await act(async () => {
        switchLang('en-US');
      });

      expect(currentLang).toBe('en-US');
      expect(container.querySelector('#title')?.textContent).toBe('OK');
      expect(container.querySelector('#lang')?.textContent).toBe('en-US');
      expect(localStorage.getItem(STORAGE_KEY_LOCALE)).toBe('en-US');

      // 清理 DOM
      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it('全局 t helper 在组件外也可执行翻译', () => {
      expect(t('common.ok')).toBeDefined();
    });
  });

  // ── 4. 与 error-translation.ts 的协同联动 (Error Translation Integration) ──
  describe('与 error-translation.ts 的协同联动', () => {
    const makePayload = (
      overrides: Partial<CrishErrorPayload> = {}
    ): CrishErrorPayload => ({
      code: 'provider.network',
      message: 'Connection refused',
      category: 'transient',
      retryable: true,
      public: true,
      action: 'action.provider.check_network',
      timestamp: 1700000000000,
      ...overrides,
    });

    it('useI18n().translateError 根据语言解析本地化 title 与 action', () => {
      const zhT = createTranslateFunction(zhCN);
      const enT = createTranslateFunction(enUS);

      const payload = makePayload({
        code: 'provider.network',
        action: 'action.provider.check_network',
      });

      // 中文翻译
      const zhError = toUserVisibleError(payload, (key, fallback) =>
        zhT(key, fallback)
      );
      expect(zhError.title).toBe('网络错误');
      expect(zhError.action).toBe('服务暂时不可用，请稍后重试。');

      // 英文翻译
      const enError = toUserVisibleError(payload, (key, fallback) =>
        enT(key, fallback)
      );
      expect(enError.title).toBe('Network error');
      expect(enError.action).toBe(
        'Service is temporarily unavailable. Please try again later.'
      );
    });

    it('registerErrorTranslateFn 允许 toUserVisibleError 免显式传参自动使用当前语言', () => {
      const payload = makePayload({
        code: 'store.corrupted',
        action: 'store.corrupted',
      });

      // 注册中文全局翻译
      const zhT = createTranslateFunction(zhCN);
      registerErrorTranslateFn((k, f) => zhT(k, f));

      const visibleZh = toUserVisibleError(payload);
      expect(visibleZh.title).toBe('存储已损坏');

      // 注册英文全局翻译
      const enT = createTranslateFunction(enUS);
      registerErrorTranslateFn((k, f) => enT(k, f));

      const visibleEn = toUserVisibleError(payload);
      expect(visibleEn.title).toBe('Storage corrupted');
    });
  });
});
