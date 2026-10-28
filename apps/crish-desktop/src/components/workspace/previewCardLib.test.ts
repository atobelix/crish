// @vitest-environment jsdom
/**
 * previewCardLib 纯函数层测试（安全 URL 判定与拾取辅助工具）：
 * 1. safeIframeSrc / safeNativeUrl：公网与本地合法 URL 直接放行，危险 scheme 返回 null；
 * 2. buildInspectorElementLabel：tag#id.class 标签组装；
 * 3. buildInspectorAiSnippet：发送到 AI 的结构化 Prompt；
 * 4. hasInspectorComputedStyles：computedStyles 摘要有效性判断。
 * 遵循测试资产保护铁律（UTF-8 无 BOM，中文注释）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildInspectorAiSnippet,
  buildInspectorElementLabel,
  hasInspectorComputedStyles,
  isLocalDevUrl,
  safeIframeSrc,
  safeNativeUrl,
} from './previewCardLib';

describe('previewCardLib 安全 URL 判定与拾取辅助', () => {
  describe('safeIframeSrc / safeNativeUrl 安全判定', () => {
    it('外部合法 HTTP/HTTPS URL：直接返回原始地址，绝不带代理前缀', () => {
      const targets = [
        'https://google.com',
        'https://github.com',
        'https://example.com/docs?id=123',
      ];
      for (const target of targets) {
        expect(safeIframeSrc(target)).toBe(target);
        expect(safeNativeUrl(target)).toBe(target);
      }
    });

    it('本地合法开发服务 URL：直接放行原始地址', () => {
      expect(safeIframeSrc('http://localhost:5173')).toBe(
        'http://localhost:5173'
      );
      expect(safeNativeUrl('http://127.0.0.1:3000')).toBe(
        'http://127.0.0.1:3000'
      );
    });

    it('空白与空串返回 null', () => {
      expect(safeIframeSrc('')).toBeNull();
      expect(safeIframeSrc('about:blank')).toBeNull();
      expect(safeNativeUrl('')).toBeNull();
      expect(safeNativeUrl('about:blank')).toBeNull();
    });

    it('非法与危险 scheme 必须严格阻断返回 null', () => {
      expect(safeIframeSrc('javascript:alert(1)')).toBeNull();
      expect(safeIframeSrc('vbscript:msgbox(1)')).toBeNull();
      expect(safeNativeUrl('javascript:void(0)')).toBeNull();
      expect(safeNativeUrl('vbscript:run()')).toBeNull();
    });

    it('合法 data: URL 直接原样放行', () => {
      const dataUrl = 'data:text/html,<h1>Hello</h1>';
      expect(safeIframeSrc(dataUrl)).toBe(dataUrl);
      expect(safeNativeUrl(dataUrl)).toBe(dataUrl);
    });
  });

  describe('isLocalDevUrl', () => {
    it('精确识别 localhost 与各类环回/内网开发地址', () => {
      expect(isLocalDevUrl('http://localhost:5173')).toBe(true);
      expect(isLocalDevUrl('http://127.0.0.1:3000')).toBe(true);
      expect(isLocalDevUrl('http://0.0.0.0:8000')).toBe(true);
      expect(isLocalDevUrl('http://[::1]:8080')).toBe(true);
      expect(isLocalDevUrl('http://app.localhost')).toBe(true);
      expect(isLocalDevUrl('http://my-service.local:4000')).toBe(true);
      expect(isLocalDevUrl('http://corp.internal')).toBe(true);
      expect(isLocalDevUrl('http://dev.lan')).toBe(true);

      expect(isLocalDevUrl('https://google.com')).toBe(false);
      expect(isLocalDevUrl('https://github.com')).toBe(false);
      expect(isLocalDevUrl('')).toBe(false);
    });
  });

  describe('buildInspectorElementLabel', () => {
    it('按 tag#id.class1.class2 组装标签', () => {
      expect(
        buildInspectorElementLabel('button', 'submit-btn', [
          'submit',
          'primary',
        ])
      ).toBe('button#submit-btn.submit.primary');
    });

    it('无 id / 无类时只保留 tag（小写归一）', () => {
      expect(buildInspectorElementLabel('DIV', null, [])).toBe('div');
      expect(buildInspectorElementLabel('A', 'link', [])).toBe('a#link');
    });
  });

  describe('buildInspectorAiSnippet', () => {
    it('生成含标签、尺寸与选择器的结构化 Prompt', () => {
      const snippet = buildInspectorAiSnippet(
        'button',
        'submit-btn',
        ['submit'],
        { width: 100, height: 40 },
        'button#submit-btn.submit'
      );
      expect(snippet).toBe(
        '请分析并优化这个元素 [@DOM: button#submit-btn.submit (100×40)]，选择器：button#submit-btn.submit'
      );
    });
  });

  describe('hasInspectorComputedStyles', () => {
    it('存在任一有效样式键时返回 true', () => {
      const el = {
        computedStyles: {
          display: 'block',
          position: 'relative',
          color: '',
          backgroundColor: '',
          fontSize: '',
          margin: '',
          padding: '',
        },
      };
      expect(hasInspectorComputedStyles(el)).toBe(true);
    });

    it('全空 / null / 缺字段返回 false', () => {
      expect(hasInspectorComputedStyles(null)).toBe(false);
      expect(
        hasInspectorComputedStyles({
          computedStyles: {
            display: '',
            position: '',
            color: '',
            backgroundColor: '',
            fontSize: '',
            margin: '',
            padding: '',
          },
        })
      ).toBe(false);
    });
  });
});
