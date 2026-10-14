// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import {
  DEFAULT_LANGUAGE,
  STORAGE_KEY_LOCALE,
  type SupportedLanguage,
  type I18nDictionary,
} from '../types';
import { zhCN, enUS, dictionaries } from '../locales';
import {
  interpolate,
  humanizeKeyFallback,
  resolveDictionaryKey,
  createTranslateFunction,
  getSessionLanguageEpoch,
  __resetSessionLanguageEpochForTest,
  getGlobalActiveTranslator,
  getGlobalActiveLanguage,
  persistLanguage,
  I18nProvider,
} from '../I18nContext';
import { useI18n } from '../useI18n';

describe('I18nContext 加固、Session Epoch 与四级平滑降级漏斗', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('lang');
    __resetSessionLanguageEpochForTest(0);
    // 恢复全局语言为 zh-CN 初始状态
    persistLanguage('zh-CN');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. 四级平滑降级漏斗测试 (Four-Level Disaster Recovery Funnel)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('四级平滑降级漏斗 (Disaster Recovery Funnel)', () => {
    // Level 1: 目标语言命中
    it('Level 1: 当前目标语言字典命中时优先返回对应翻译', () => {
      const enT = createTranslateFunction(enUS);
      const zhT = createTranslateFunction(zhCN);

      expect(enT('common.ok')).toBe('OK');
      expect(zhT('common.ok')).toBe('确定');
      expect(enT('settings.title')).toBe('Settings');
      expect(zhT('settings.title')).toBe('设置');
    });

    // Level 2: 目标语言未命中，自动回退至权威 zh-CN 字典
    it('Level 2: 目标语言缺失词条时自动回退至权威 zh-CN 字典 (保证中文兜底)', () => {
      // 构造一个缺失 common.ok 的不完整语言字典
      const incompleteEnDict = {
        ...enUS,
        common: {
          ...enUS.common,
        },
      } as Record<string, unknown>;
      delete (incompleteEnDict.common as Record<string, unknown>).ok;

      const t = createTranslateFunction(
        incompleteEnDict as unknown as I18nDictionary
      );
      // common.ok 在当前字典不存在，但权威 zh-CN 存在，应自动回退至中文 '确定'
      expect(t('common.ok')).toBe('确定');
    });

    it('Level 2: resolveDictionaryKey 支持在目标字典未命中时回退至 zh-CN', () => {
      const incompleteDict = {
        common: {
          cancel: 'Cancel',
        },
      } as unknown as I18nDictionary;

      // 命中自身
      expect(resolveDictionaryKey(incompleteDict, 'common.cancel')).toBe(
        'Cancel'
      );
      // 自身缺失，回退 zh-CN
      expect(resolveDictionaryKey(incompleteDict, 'common.ok')).toBe('确定');
      // 若显式传入 null 禁用回退，则返回 undefined
      expect(
        resolveDictionaryKey(incompleteDict, 'common.ok', null)
      ).toBeUndefined();
    });

    // Level 3: 词条在当前字典和 zh-CN 均未命中，使用调用方传入的 fallback 字符串
    it('Level 3: 字典全未命中时，使用调用方传入的 fallback 字符串与插值参数', () => {
      const enT = createTranslateFunction(enUS);

      const resultWithFallback = enT(
        'custom.nonexistent.action',
        '默认操作引导：点击 {btn}',
        { btn: '下一步' }
      );
      expect(resultWithFallback).toBe('默认操作引导：点击 下一步');

      const simpleFallback = enT('another.missing.key', '兜底文本');
      expect(simpleFallback).toBe('兜底文本');
    });

    // Level 4: 全未命中，严禁向用户暴露点分裸 key
    it('Level 4: 生产环境或配置 suppressBareKey 时，严禁暴露裸点分 key，安全转换为语义化文本', () => {
      const prodT = createTranslateFunction(zhCN, { suppressBareKey: true });

      // 测试多段点分 key
      expect(prodT('settings.unknown.item')).toBe('Item');
      expect(prodT('settings.appearance.themeTitle')).toBe('Theme Title');
      expect(prodT('nav.user_profile')).toBe('User Profile');
      expect(prodT('action.retry-all-failed-tasks')).toBe(
        'Retry All Failed Tasks'
      );
      expect(prodT('simpleKey')).toBe('Simple Key');
      // 绝对不应包含原始点号路径
      expect(prodT('settings.nested.unknown.action')).not.toContain('.');
      expect(prodT('settings.nested.unknown.action')).toBe('Action');
    });

    it('Level 4: humanizeKeyFallback 健壮美化测试', () => {
      expect(humanizeKeyFallback('')).toBe('');
      expect(humanizeKeyFallback('   ')).toBe('');
      expect(humanizeKeyFallback('item')).toBe('Item');
      expect(humanizeKeyFallback('settings.theme')).toBe('Theme');
      expect(humanizeKeyFallback('settings.themeName')).toBe('Theme Name');
      expect(humanizeKeyFallback('action.retry_all')).toBe('Retry All');
      expect(humanizeKeyFallback('action.retry-once')).toBe('Retry Once');
      expect(humanizeKeyFallback('a.b.c.trailingDot.')).toBe('Trailing Dot');
    });

    it('Level 4: 开发/测试环境下未配置 suppressBareKey 时附带警告并保留 key', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const devT = createTranslateFunction(zhCN, {
        suppressBareKey: false,
        isProduction: false,
      });

      const res = devT('debug.missing.key');
      expect(res).toBe('debug.missing.key');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing translation key: "debug.missing.key"')
      );
      warnSpy.mockRestore();
    });

    it('Level 4: 在 React I18nProvider 中通过 suppressBareKey 保证 UI 渲染安全', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      function TestView() {
        const { t } = useI18n();
        return (
          <div>
            <span id="label">{t('settings.unknown.customSetting')}</span>
          </div>
        );
      }

      await act(async () => {
        root.render(
          <I18nProvider initialLanguage="zh-CN" suppressBareKey={true}>
            <TestView />
          </I18nProvider>
        );
      });

      const text = container.querySelector('#label')?.textContent;
      expect(text).toBe('Custom Setting');
      expect(text).not.toContain('settings.');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Session Language Epoch 令牌与竞态防护测试
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Session Language Epoch 令牌', () => {
    it('语言切换时 epoch 单调自增，相同语言重复设置不递增', async () => {
      __resetSessionLanguageEpochForTest(0);
      expect(getSessionLanguageEpoch()).toBe(0);

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      let contextEpoch = -1;
      let switchLang: (lang: SupportedLanguage) => void = () => {};

      function EpochConsumer() {
        const { sessionEpoch, setLanguage } = useI18n();
        contextEpoch = sessionEpoch;
        switchLang = setLanguage;
        return <div>epoch: {sessionEpoch}</div>;
      }

      await act(async () => {
        root.render(
          <I18nProvider initialLanguage="zh-CN">
            <EpochConsumer />
          </I18nProvider>
        );
      });

      // 初始渲染
      const initialEpoch = getSessionLanguageEpoch();
      expect(contextEpoch).toBe(initialEpoch);

      // 切换为 en-US：epoch 必须严格递增 1
      await act(async () => {
        switchLang('en-US');
      });
      expect(getSessionLanguageEpoch()).toBe(initialEpoch + 1);
      expect(contextEpoch).toBe(initialEpoch + 1);

      // 再次切换为相同语言 en-US：epoch 严禁递增（保持幂等）
      await act(async () => {
        switchLang('en-US');
      });
      expect(getSessionLanguageEpoch()).toBe(initialEpoch + 1);
      expect(contextEpoch).toBe(initialEpoch + 1);

      // 切换回 zh-CN：epoch 再次严格递增 1
      await act(async () => {
        switchLang('zh-CN');
      });
      expect(getSessionLanguageEpoch()).toBe(initialEpoch + 2);
      expect(contextEpoch).toBe(initialEpoch + 2);

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it('利用 sessionEpoch 防御异步 IPC/流式回调旧语言回写竞态', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      let switchLang: (lang: SupportedLanguage) => void = () => {};
      let renderedText = '';

      function RaceView() {
        const { t, setLanguage } = useI18n();
        switchLang = setLanguage;
        renderedText = t('common.ok');
        return <div>{renderedText}</div>;
      }

      await act(async () => {
        root.render(
          <I18nProvider initialLanguage="zh-CN">
            <RaceView />
          </I18nProvider>
        );
      });

      expect(renderedText).toBe('确定');

      // 模拟异步 IPC 动作：发起时记录此时的 epoch
      const requestEpoch = getSessionLanguageEpoch();
      let lateResponseReceived = false;
      let lateResponseApplied = false;

      // 模拟用户在异步响应返回前切换了语言
      await act(async () => {
        switchLang('en-US');
      });
      expect(renderedText).toBe('OK');

      // 模拟异步响应迟滞返回：进行 epoch 比对
      const onAsyncIpcResponse = (data: { textZh: string }) => {
        lateResponseReceived = true;
        // 核心安全守卫：若响应时的 epoch 与当前 epoch 不一致，忽略旧数据
        if (requestEpoch !== getSessionLanguageEpoch()) {
          // 拒绝回退
          return;
        }
        lateResponseApplied = true;
        renderedText = data.textZh;
      };

      onAsyncIpcResponse({ textZh: '旧语言数据' });

      expect(lateResponseReceived).toBe(true);
      expect(lateResponseApplied).toBe(false); // 成功拦截回退！
      expect(renderedText).toBe('OK'); // 保持当前新语言呈现

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. interpolate 健壮性与安全防注入测试
  // ─────────────────────────────────────────────────────────────────────────────
  describe('interpolate 健壮性与防注入攻击', () => {
    it('正确替换合法参数且支持数字 0 保护', () => {
      expect(interpolate('未读消息 {count} 条', { count: 0 })).toBe(
        '未读消息 0 条'
      );
      expect(
        interpolate('欢迎 {user} (等级 {level})', { user: 'Alice', level: 1 })
      ).toBe('欢迎 Alice (等级 1)');
    });

    it('安全消解 null 与 undefined 为可读空串', () => {
      expect(interpolate('用户: {name}!', { name: null })).toBe('用户: !');
      expect(interpolate('状态: {status}!', { status: undefined })).toBe(
        '状态: !'
      );
    });

    it('安全消解 NaN 与 Infinity，杜绝在 UI 渲染非法数值', () => {
      expect(interpolate('进度: {pct}%', { pct: NaN })).toBe('进度: -%');
      expect(interpolate('耗时: {sec}s', { sec: Infinity })).toBe('耗时: -s');
      expect(interpolate('耗时: {sec}s', { sec: -Infinity })).toBe('耗时: -s');
    });

    it('严格防御原型链属性注入 (__proto__, constructor, prototype)', () => {
      // 1. params 内部包含恶意字段
      const evilParams = JSON.parse('{"evil": "__proto__", "user": "Admin"}');
      expect(interpolate('User: {user}, Evil: {evil}', evilParams)).toBe(
        'User: Admin, Evil: __proto__'
      );

      // 2. 模板试图访问原型链属性
      expect(interpolate('Proto: {__proto__}', {})).toBe('Proto: {__proto__}');
      expect(interpolate('Ctor: {constructor}', {})).toBe(
        'Ctor: {constructor}'
      );
      expect(interpolate('Proto: {prototype}', {})).toBe('Proto: {prototype}');

      // 3. 使用无原型对象 Object.create(null) 作为 params
      const nullProtoParams = Object.create(null);
      nullProtoParams.key = 'safe';
      expect(interpolate('Value: {key}', nullProtoParams)).toBe('Value: safe');
    });

    it('对非字符串模板与非对象参数具备容错防御', () => {
      expect(interpolate(null as unknown as string)).toBe('');
      expect(interpolate(undefined as unknown as string)).toBe('');
      expect(interpolate(12345 as unknown as string)).toBe('');
      expect(interpolate('原样文本', null)).toBe('原样文本');
      expect(interpolate('原样文本', undefined)).toBe('原样文本');
      expect(
        interpolate(
          '原样文本',
          '非对象参数' as unknown as Record<string, unknown>
        )
      ).toBe('原样文本');
    });

    it('对复杂对象和函数参数进行 JSON 序列化或空消解，防止出现 [object Object]', () => {
      const res = interpolate('数据: {payload}', {
        payload: { id: 1, name: 'test' },
      });
      expect(res).toBe('数据: {"id":1,"name":"test"}');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. 全局翻译器与全局语言同步响应测试
  // ─────────────────────────────────────────────────────────────────────────────
  describe('全局翻译单例响应与同步机制', () => {
    it('I18nProvider 切换语言时，getGlobalActiveTranslator 与 getGlobalActiveLanguage 同步更新', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      let switchLang: (lang: SupportedLanguage) => void = () => {};

      function GlobalSyncTestComponent() {
        const { setLanguage } = useI18n();
        switchLang = setLanguage;
        return <div>sync test</div>;
      }

      await act(async () => {
        root.render(
          <I18nProvider initialLanguage="zh-CN">
            <GlobalSyncTestComponent />
          </I18nProvider>
        );
      });

      // 验证初始全局状态
      expect(getGlobalActiveLanguage()).toBe('zh-CN');
      expect(getGlobalActiveTranslator()('common.ok')).toBe('确定');

      // 切换为 en-US
      await act(async () => {
        switchLang('en-US');
      });

      // 验证全局状态已即时同步为 en-US
      expect(getGlobalActiveLanguage()).toBe('en-US');
      expect(getGlobalActiveTranslator()('common.ok')).toBe('OK');

      // 再次切换回 zh-CN
      await act(async () => {
        switchLang('zh-CN');
      });

      expect(getGlobalActiveLanguage()).toBe('zh-CN');
      expect(getGlobalActiveTranslator()('common.ok')).toBe('确定');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  });
});
