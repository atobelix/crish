import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deletePreference,
  deserializePreferenceValue,
  getAllPreferences,
  getPreference,
  serializePreferenceValue,
  setPreference,
} from '../preferencesClient';
import {
  getDefaultPreferences,
  isKnownPreferenceKey,
  normalizePreferenceKey,
  PREFERENCES_SCHEMA,
  validatePreferenceValue,
  type PreferenceKey,
} from '../preferencesSchema';
import * as transportModule from '../../transport';

describe('preferencesSchema', () => {
  it('默认值快照完整且符合各字段类型与校验约束', () => {
    const defaults = getDefaultPreferences();
    const schemaKeys = Object.keys(PREFERENCES_SCHEMA) as PreferenceKey[];

    expect(Object.keys(defaults).sort()).toEqual(schemaKeys.sort());

    for (const key of schemaKeys) {
      const entry = PREFERENCES_SCHEMA[key];
      expect(defaults[key]).toEqual(entry.defaultValue);
      expect(() => validatePreferenceValue(key, entry.defaultValue)).not.toThrow();
    }
  });

  it('isKnownPreferenceKey 识别权威键与别名', () => {
    expect(isKnownPreferenceKey('theme')).toBe(true);
    expect(isKnownPreferenceKey('ui_size')).toBe(true);
    expect(isKnownPreferenceKey('crish_theme')).toBe(true);
    expect(isKnownPreferenceKey('crish_sidebar_width')).toBe(true);
    expect(isKnownPreferenceKey('unknown_key')).toBe(false);
    expect(isKnownPreferenceKey('')).toBe(false);
  });

  it('normalizePreferenceKey 规范化别名并拦截未知 key', () => {
    expect(normalizePreferenceKey('theme')).toBe('theme');
    expect(normalizePreferenceKey('crish_theme')).toBe('theme');
    expect(normalizePreferenceKey('crish_fonts')).toBe('fonts');
    expect(() => normalizePreferenceKey('not_exist')).toThrow(/Unknown preference key/);
  });

  it('validatePreferenceValue 严格拦截类型不符与越界数值', () => {
    expect(() => validatePreferenceValue('theme', 'dark')).not.toThrow();
    expect(() => validatePreferenceValue('theme', 'invalid_theme' as any)).toThrow(
      /expected one of/
    );
    expect(() => validatePreferenceValue('theme', 123 as any)).toThrow(
      /expected string, got number/
    );

    expect(() => validatePreferenceValue('font_size_adjust', 2)).not.toThrow();
    expect(() => validatePreferenceValue('font_size_adjust', '2' as any)).toThrow(
      /expected number, got string/
    );
    expect(() => validatePreferenceValue('font_size_adjust', 999 as any)).toThrow(
      /validation failed/
    );

    expect(() => validatePreferenceValue('sidebar_collapsed', true)).not.toThrow();
    expect(() => validatePreferenceValue('sidebar_collapsed', 'true' as any)).toThrow(
      /expected boolean, got string/
    );

    expect(() =>
      validatePreferenceValue('fonts', {
        uiFont: 'inter',
        monoFont: 'jetbrains-mono',
        monoLigatures: true,
        v: 1,
      })
    ).not.toThrow();
    expect(() => validatePreferenceValue('fonts', 'invalid' as any)).toThrow(
      /expected object, got string/
    );
    expect(() => validatePreferenceValue('fonts', [] as any)).toThrow(
      /expected object, got array/
    );
  });
});

describe('preferencesClient', () => {
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRequest = vi.fn();
    vi.spyOn(transportModule, 'getTransport').mockReturnValue({
      request: mockRequest,
      send: vi.fn(),
      call: vi.fn(),
      onMessage: vi.fn(),
      waitUntilConnected: vi.fn(),
      onStatus: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
    } as any);
  });

  describe('getPreference', () => {
    it('合法 key 发起 prefs_get 请求并正确反序列化', async () => {
      mockRequest.mockResolvedValueOnce({ value: 'dark' });

      const theme = await getPreference('theme');
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('prefs_get', { key: 'theme' });
      expect(theme).toBe('dark');
    });

    it('数值型与布尔型偏好能正确反序列化', async () => {
      mockRequest.mockResolvedValueOnce({ value: '4' });
      const fs = await getPreference('font_size_adjust');
      expect(fs).toBe(4);

      mockRequest.mockResolvedValueOnce({ value: 'true' });
      const vibrant = await getPreference('theme_brightness_vibrant');
      expect(vibrant).toBe(true);
    });

    it('对象型偏好（如 fonts）能正确反序列化 JSON 字符串', async () => {
      const fontObj = {
        uiFont: 'inter',
        monoFont: 'ibm-plex-mono',
        monoLigatures: true,
        v: 1,
      };
      mockRequest.mockResolvedValueOnce({ value: JSON.stringify(fontObj) });

      const fonts = await getPreference('fonts');
      expect(fonts).toEqual(fontObj);
    });

    it('返回值为空时平滑回退到该 key 的权威默认值', async () => {
      mockRequest.mockResolvedValueOnce(null);

      const theme = await getPreference('theme');
      expect(theme).toBe('default');
    });

    it('未知 key 坚决拦截并抛错，不发起任何跨层请求', async () => {
      await expect(getPreference('invalid_key' as any)).rejects.toThrow(
        /Unknown preference key/
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('支持历史别名并转为权威键发起请求', async () => {
      mockRequest.mockResolvedValueOnce({ value: 'oled' });

      const theme = await getPreference('crish_theme' as any);
      expect(mockRequest).toHaveBeenCalledWith('prefs_get', { key: 'theme' });
      expect(theme).toBe('oled');
    });
  });

  describe('setPreference', () => {
    it('合法 key 与合法值发起 prefs_set 请求并序列化存储', async () => {
      mockRequest.mockResolvedValueOnce({ success: true });

      await setPreference('theme', 'nord');
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('prefs_set', {
        key: 'theme',
        value: 'nord',
      });
    });

    it('数值与布尔值等能正确序列化', async () => {
      mockRequest.mockResolvedValueOnce({ success: true });
      await setPreference('sidebar_width', 300);
      expect(mockRequest).toHaveBeenCalledWith('prefs_set', {
        key: 'sidebar_width',
        value: '300',
      });

      mockRequest.mockResolvedValueOnce({ success: true });
      await setPreference('tab_mode_enabled', true);
      expect(mockRequest).toHaveBeenCalledWith('prefs_set', {
        key: 'tab_mode_enabled',
        value: 'true',
      });
    });

    it('复杂对象正确转为 JSON 字符串保存', async () => {
      mockRequest.mockResolvedValueOnce({ success: true });
      const customFonts = {
        uiFont: 'system-ui',
        monoFont: 'jetbrains-mono',
        monoLigatures: true,
        v: 1,
      };
      await setPreference('fonts', customFonts);
      expect(mockRequest).toHaveBeenCalledWith('prefs_set', {
        key: 'fonts',
        value: JSON.stringify(customFonts),
      });
    });

    it('未知 key 强拦截，不发起任何请求', async () => {
      await expect(setPreference('unknown_key' as any, 'val' as any)).rejects.toThrow(
        /Unknown preference key/
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('非法枚举值强拦截，不发起任何请求', async () => {
      await expect(setPreference('ui_size', 'ultra_huge' as any)).rejects.toThrow(
        /expected one of/
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('非法数值类型或越界强拦截，不发起任何请求', async () => {
      await expect(
        setPreference('font_size_adjust', 'invalid' as any)
      ).rejects.toThrow(/expected number/);
      await expect(
        setPreference('font_size_adjust', 9999 as any)
      ).rejects.toThrow(/validation failed/);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('deletePreference', () => {
    it('合法 key 发起 prefs_delete 请求', async () => {
      mockRequest.mockResolvedValueOnce({ success: true });

      await deletePreference('theme_custom_bg');
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('prefs_delete', {
        key: 'theme_custom_bg',
      });
    });

    it('未知 key 强拦截，不发起任何请求', async () => {
      await expect(deletePreference('unknown' as any)).rejects.toThrow(
        /Unknown preference key/
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('getAllPreferences', () => {
    it('正确解析数组形态全量偏好并补齐默认值', async () => {
      mockRequest.mockResolvedValueOnce([
        { key: 'theme', value: 'dark' },
        { key: 'sidebar_width', value: '320' },
      ]);

      const all = await getAllPreferences();
      expect(mockRequest).toHaveBeenCalledWith('prefs_get', {});
      expect(all.theme).toBe('dark');
      expect(all.sidebar_width).toBe(320);
      expect(all.ui_size).toBe('normal');
      expect(all.shell_chrome_mode).toBe('frameless');
    });

    it('正确解析对象键值对形态全量偏好', async () => {
      mockRequest.mockResolvedValueOnce({
        theme: 'sepia',
        font_size_adjust: '2',
      });

      const all = await getAllPreferences();
      expect(all.theme).toBe('sepia');
      expect(all.font_size_adjust).toBe(2);
      expect(all.theme_skin).toBe('warm-gray');
    });
  });
});
