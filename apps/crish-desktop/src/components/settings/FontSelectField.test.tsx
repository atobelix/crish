import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FontSelectField, type FontSelectOption } from './FontSelectField';
import {
  extractPinyin,
  indexFontOptions,
  filterAndSortIndexedOptions,
  sanitizeFontFamily,
  sanitizeFontFamilyNameStrict,
} from './internal/fontPinyinMatcher';
import {
  canQueryLocalFonts,
  scanViaCanvasChunked,
  scanSystemFonts,
  clearMemoryFontCache,
} from './internal/fontStoreScan';

const MOCK_OPTIONS: FontSelectOption[] = [
  { value: 'auto', label: '自动（系统优化）', group: '预设' },
  { value: 'system-ui', label: '系统 UI', group: '预设' },
  { value: 'inter', label: 'Inter（内嵌）', group: '预设', previewFamily: 'Inter' },
  { value: 'local:Microsoft YaHei', label: 'Microsoft YaHei', group: '本机', previewFamily: 'Microsoft YaHei' },
  { value: 'local:PingFang SC', label: 'PingFang SC', group: '本机', previewFamily: 'PingFang SC' },
  { value: 'local:JetBrains Mono', label: 'JetBrains Mono', group: '本机', previewFamily: 'JetBrains Mono' },
  { value: 'local:Cascadia Code', label: 'Cascadia Code', group: '本机', previewFamily: 'Cascadia Code' },
];

describe('FontSelectField & Pinyin / Scan Infrastructure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryFontCache();
    localStorage.clear();
  });

  describe('1. 拼音模糊过滤与安全净化单元测试', () => {
    it('正确提取中文字符的拼音首字母与全拼', () => {
      const yahei = extractPinyin('微软雅黑');
      expect(yahei.acronym).toBe('wryh');
      expect(yahei.full).toBe('weiruanyahei');

      const pingfang = extractPinyin('苹方');
      expect(pingfang.acronym).toBe('pf');
      expect(pingfang.full).toBe('pingfang');

      const mixed = extractPinyin('思源黑体 Pro');
      expect(mixed.acronym).toBe('syht pro');
    });

    it('基于别名与拼音多维加权过滤已索引选项', () => {
      const indexed = indexFontOptions(MOCK_OPTIONS);

      // 别名测试: wryh 命中 Microsoft YaHei
      const resYahei = filterAndSortIndexedOptions(indexed, 'wryh');
      expect(resYahei.length).toBeGreaterThan(0);
      expect(resYahei[0].label).toBe('Microsoft YaHei');

      // 别名测试: pf 命中 PingFang SC
      const resPf = filterAndSortIndexedOptions(indexed, 'pf');
      expect(resPf.length).toBeGreaterThan(0);
      expect(resPf[0].label).toBe('PingFang SC');

      // 别名测试: jb 命中 JetBrains Mono
      const resJb = filterAndSortIndexedOptions(indexed, 'jb');
      expect(resJb.length).toBeGreaterThan(0);
      expect(resJb[0].label).toBe('JetBrains Mono');

      // 前缀与子串测试: cas 命中 Cascadia Code
      const resCas = filterAndSortIndexedOptions(indexed, 'cas');
      expect(resCas.length).toBeGreaterThan(0);
      expect(resCas[0].label).toBe('Cascadia Code');
    });

    it('严苛净化 CSS 注入与危险字符', () => {
      expect(sanitizeFontFamily('Segoe UI; color: red;')).toBe('Segoe UI color: red');
      expect(sanitizeFontFamily('Foo<script>alert(1)</script>')).toBe('Fooscriptalert1/script');
      expect(sanitizeFontFamily("Font'Name\"With\\Escapes")).toBe('FontNameWithEscapes');

      // strict 模式校验
      const valid = sanitizeFontFamilyNameStrict('Fira Code');
      expect(valid.ok).toBe(true);
      if (valid.ok) expect(valid.name).toBe('Fira Code');

      const validChinese = sanitizeFontFamilyNameStrict('霞鹜文楷');
      expect(validChinese.ok).toBe(true);

      const invalidInject = sanitizeFontFamilyNameStrict("Font'; --bad: '");
      expect(invalidInject.ok).toBe(false);

      const invalidHtml = sanitizeFontFamilyNameStrict('<bad>');
      expect(invalidHtml.ok).toBe(false);

      const empty = sanitizeFontFamilyNameStrict('   ');
      expect(empty.ok).toBe(false);
    });
  });

  describe('2. 双引擎字体扫描与缓存机制测试', () => {
    it('在不支持 queryLocalFonts 时 canQueryLocalFonts 返回 false', async () => {
      const orig = (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;
      delete (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts;

      const can = await canQueryLocalFonts();
      expect(can).toBe(false);

      if (orig) {
        (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts = orig;
      }
    });

    it('Canvas 分片测宽降级探测执行并让出主线程', async () => {
      const fonts = await scanViaCanvasChunked(['Segoe UI', 'Consolas', 'NonExistentFont123'], 2);
      expect(Array.isArray(fonts)).toBe(true);
    });

    it('scanSystemFonts 优先命中内存与 LocalStorage 瘦身缓存', async () => {
      // 预先写入瘦身缓存
      localStorage.setItem(
        'crish_local_fonts_cache_v1',
        JSON.stringify({
          v: 1,
          t: Date.now(),
          f: ['Custom Cached Font SC'],
        })
      );

      const res = await scanSystemFonts(false);
      expect(res.engine).toBe('none');
      expect(res.fonts.some((f) => f.family === 'Custom Cached Font SC')).toBe(true);
      expect(res.durationMs).toBe(0);
    });
  });

  describe('3. FontSelectField 组件渲染与交互测试', () => {
    it('正确渲染当前选中值与触发器', () => {
      render(
        <FontSelectField
          value="local:Microsoft YaHei"
          options={MOCK_OPTIONS}
          onChange={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: 'Microsoft YaHei' })).toBeInTheDocument();
    });

    it('展开下拉面板并显示内嵌搜索输入框与操作栏', async () => {
      const user = userEvent.setup();
      const onScan = vi.fn();
      const onReset = vi.fn();

      render(
        <FontSelectField
          value="auto"
          options={MOCK_OPTIONS}
          onChange={vi.fn()}
          onScanLocal={onScan}
          onResetDefault={onReset}
        />
      );

      const trigger = screen.getByRole('button', { name: '自动（系统优化）' });
      await user.click(trigger);

      const searchInput = screen.getByRole('combobox', { name: '搜索或输入自定义字体名称' });
      expect(searchInput).toBeInTheDocument();

      // 点击扫描与重置按钮
      const scanBtn = screen.getByRole('button', { name: '全量扫描本机系统字体' });
      await user.click(scanBtn);
      expect(onScan).toHaveBeenCalledTimes(1);

      const resetBtn = screen.getByRole('button', { name: '恢复系统优化默认字体' });
      await user.click(resetBtn);
      expect(onReset).toHaveBeenCalledTimes(1);
    });

    it('在内嵌搜索框键入拼音实时过滤并在 Enter 时选择匹配项', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <FontSelectField
          value="auto"
          options={MOCK_OPTIONS}
          onChange={onChange}
        />
      );

      const trigger = screen.getByRole('button', { name: '自动（系统优化）' });
      await user.click(trigger);

      const searchInput = screen.getByRole('combobox', { name: '搜索或输入自定义字体名称' });
      await user.type(searchInput, 'wryh');

      // 回车选择当前高亮首项 (Microsoft YaHei)
      await user.keyboard('{Enter}');
      expect(onChange).toHaveBeenCalledWith('local:Microsoft YaHei');
    });

    it('键盘上下导航 ArrowDown / ArrowUp 循环漫游', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();

      render(
        <FontSelectField
          value="auto"
          options={MOCK_OPTIONS}
          onChange={onChange}
        />
      );

      const trigger = screen.getByRole('button', { name: '自动（系统优化）' });
      await user.click(trigger);

      const searchInput = screen.getByRole('combobox', { name: '搜索或输入自定义字体名称' });
      // 向下漫游一次并回车
      await user.type(searchInput, '{arrowdown}{enter}');
      expect(onChange).toHaveBeenCalled();
    });

    it('IME 拼音合成阶段坚决拦截 Enter 误提交', async () => {
      const onChange = vi.fn();
      const onApplyCustom = vi.fn();

      render(
        <FontSelectField
          value="auto"
          options={MOCK_OPTIONS}
          onChange={onChange}
          onApplyCustom={onApplyCustom}
        />
      );

      const trigger = screen.getByRole('button', { name: '自动（系统优化）' });
      fireEvent.click(trigger);

      const searchInput = screen.getByRole('combobox', { name: '搜索或输入自定义字体名称' });

      // 触发 compositionstart
      fireEvent.compositionStart(searchInput);

      // 在合成态下敲击 Enter
      fireEvent.keyDown(searchInput, { key: 'Enter', keyCode: 13 });

      expect(onChange).not.toHaveBeenCalled();
      expect(onApplyCustom).not.toHaveBeenCalled();

      // 触发 compositionend
      fireEvent.compositionEnd(searchInput);

      // 立即敲击（50ms / 160ms 保护窗口内）
      fireEvent.keyDown(searchInput, { key: 'Enter', keyCode: 13 });
      expect(onChange).not.toHaveBeenCalled();
      expect(onApplyCustom).not.toHaveBeenCalled();
    });

    it('当搜索无匹配时按 Enter 触发 onApplyCustom 自定义字体应用', async () => {
      const user = userEvent.setup();
      const onApplyCustom = vi.fn();

      render(
        <FontSelectField
          value="auto"
          options={MOCK_OPTIONS}
          onChange={vi.fn()}
          onApplyCustom={onApplyCustom}
        />
      );

      const trigger = screen.getByRole('button', { name: '自动（系统优化）' });
      await user.click(trigger);

      const searchInput = screen.getByRole('combobox', { name: '搜索或输入自定义字体名称' });
      await user.type(searchInput, 'MyCustomSpecialFont');

      await user.keyboard('{Enter}');
      expect(onApplyCustom).toHaveBeenCalledWith('MyCustomSpecialFont');
    });
  });
});
