// @vitest-environment jsdom
/**
 * previewCardLib 纯函数层测试（拾取辅助工具）：
 * 1. buildInspectorElementLabel：tag#id.class 标签组装；
 * 2. buildInspectorAiSnippet：发送到 AI 的结构化 Prompt；
 * 3. hasInspectorComputedStyles：computedStyles 摘要有效性判断；
 * 4. legacyToSelectPayload：旧协议载荷收敛为新契约。
 * 遵循测试资产保护铁律（UTF-8 无 BOM，中文注释）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildInspectorAiSnippet,
  buildInspectorElementLabel,
  hasInspectorComputedStyles,
  convertInspectedElementPayload,
} from './previewCardLib';

describe('previewCardLib 拾取辅助工具', () => {
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

  describe('convertInspectedElementPayload', () => {
    it('将 InspectedElementPayload 收敛为规范载荷字段', () => {
      const input = {
        tagName: 'button',
        id: 'btn-1',
        className: 'btn primary',
        selector: 'button.btn.primary',
        xpath: '/html/body/button[1]',
        outerHtml: '<button class="btn primary">Click</button>',
        textContent: 'Click',
        rect: { x: 1, y: 2, width: 80, height: 30, top: 2, left: 1 },
        attributes: { id: 'btn-1' },
      };
      const out = convertInspectedElementPayload(input as never);
      expect(out).not.toBeNull();
      expect(out?.tagName).toBe('button');
      expect(out?.classes).toEqual(['btn', 'primary']);
      expect(out?.bestSelector).toBe('button.btn.primary');
      expect(out?.computedStyles).toEqual({
        display: '',
        position: '',
        color: '',
        backgroundColor: '',
        fontSize: '',
        margin: '',
        padding: '',
      });
    });

    it('null 输入返回 null', () => {
      expect(convertInspectedElementPayload(null)).toBeNull();
    });
  });
});
