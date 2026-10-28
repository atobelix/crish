import { describe, expect, it } from 'vitest';
import {
  isLifecycleAbortReason,
  formatFriendlyBrowserError,
} from './nativeBrowserError';

describe('nativeBrowserError', () => {
  describe('isLifecycleAbortReason', () => {
    it('识别 lease released 等内部生命周期释放信号', () => {
      expect(
        isLifecycleAbortReason(
          'Browser lifecycle lease released before create for tab preview'
        )
      ).toBe(true);
      expect(
        isLifecycleAbortReason(
          'Navigation cancelled because tab preview is closing'
        )
      ).toBe(true);
      expect(
        isLifecycleAbortReason(
          'Navigation cancelled because tab tab_1 has no active owner'
        )
      ).toBe(true);
      expect(isLifecycleAbortReason('AbortError')).toBe(true);
    });

    it('对真实网络/超时/协议错误返回 false', () => {
      expect(isLifecycleAbortReason('Failed to fetch')).toBe(false);
      expect(isLifecycleAbortReason('ERR_NAME_NOT_RESOLVED')).toBe(false);
      expect(isLifecycleAbortReason('Operation timed out')).toBe(false);
      expect(isLifecycleAbortReason('')).toBe(false);
      expect(isLifecycleAbortReason(null)).toBe(false);
    });
  });

  describe('formatFriendlyBrowserError', () => {
    it('将网络错误映射为中文网络错误提示', () => {
      expect(formatFriendlyBrowserError('Failed to fetch')).toBe(
        '网络连接失败，请检查网址或网络'
      );
      expect(formatFriendlyBrowserError('net::ERR_NAME_NOT_RESOLVED')).toBe(
        '网络连接失败，请检查网址或网络'
      );
    });

    it('将超时错误映射为中文超时提示', () => {
      expect(
        formatFriendlyBrowserError('Navigation timed out after 30000ms')
      ).toBe('页面加载超时，请稍后重试');
    });

    it('将安全/格式错误映射为中文提示', () => {
      expect(formatFriendlyBrowserError('disallowed scheme file://')).toBe(
        '网址格式无效或受安全限制'
      );
    });

    it('将 Tauri 不可用映射为引擎未就绪', () => {
      expect(
        formatFriendlyBrowserError(
          'Tauri command is unavailable: browser_webview_create'
        )
      ).toBe('桌面端浏览器引擎暂未就绪');
    });

    it('未知英文技术错误给出通用网页加载失败中文提示，不泄露裸英文', () => {
      expect(
        formatFriendlyBrowserError('Some random internal crash 0x80004005')
      ).toBe('网页加载失败，请检查网址或稍后重试');
    });

    it('支持注入 i18n t 函数', () => {
      const mockT = (key: string) => `[T] ${key}`;
      expect(formatFriendlyBrowserError('Failed to fetch', mockT)).toBe(
        '[T] workspace.browser.errorNetwork'
      );
    });
  });
});
