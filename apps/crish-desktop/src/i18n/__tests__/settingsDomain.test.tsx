// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { dictionaries } from '../locales';
import { I18nProvider } from '../I18nContext';
import { useI18n } from '../useI18n';
import {
  getLoadedSettingsDomain,
  loadSettingsDomain,
  useSettingsDomain,
} from '../settingsDomain';
import { settingsFull as zhSettingsFull } from '../locales/zh-CN/settings-domain/settingsFull';
import { settingsFull as enSettingsFull } from '../locales/en-US/settings-domain/settingsFull';

describe('settingsDomain 设置域词典懒加载', () => {
  it('静态词典的 settings 仅含核心子集（懒加载域词条不在首屏词典内）', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      const core = dictionaries[lang].settings;
      // 核心键：兼容键与设置中心之外的引用面
      expect(core.title).toBeTruthy();
      expect(core['security.modeAskLabel']).toBeTruthy();
      expect(core['account.signedOut']).toBeTruthy();
      // 懒加载域词条不出现在静态词典中
      expect(core['frame.title']).toBeUndefined();
      expect(core['schedule.taskName']).toBeUndefined();
      expect(core['models.profileList.title']).toBeUndefined();
    }
  });

  it('loadSettingsDomain 返回全量设置词典且幂等缓存', async () => {
    const zh = await loadSettingsDomain('zh-CN');
    expect(zh).toBe(zhSettingsFull);
    expect(zh['frame.title']).toBe(zhSettingsFull['frame.title']);
    expect(getLoadedSettingsDomain('zh-CN')).toBe(zh);
    await expect(loadSettingsDomain('zh-CN')).resolves.toBe(zh);

    const en = await loadSettingsDomain('en-US');
    expect(en).toBe(enSettingsFull);
    expect(en['frame.title']).toBe(enSettingsFull['frame.title']);
    // 双语全量键集一致（与 check-i18n-symmetry 的口径互为印证）
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('Provider 在设置域加载完成后能解析懒加载词条（与全量词典一致）', async () => {
    let seen = '';
    function Probe() {
      const { t, language } = useI18n();
      useSettingsDomain(language);
      seen = t('settings.frame.title');
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider initialLanguage="zh-CN">
          <Probe />
        </I18nProvider>
      );
    });
    await act(async () => {
      await loadSettingsDomain('zh-CN');
    });
    expect(seen).toBe(zhSettingsFull['frame.title']);
    expect(seen).not.toBe('settings.frame.title');
    await act(async () => {
      root.unmount();
    });
  });
});
