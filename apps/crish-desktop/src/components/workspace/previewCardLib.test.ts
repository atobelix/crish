// @vitest-environment jsdom
/**
 * previewCardLib 纯函数层测试（拾取辅助工具）：
 * 1. buildInspectorElementLabel：tag#id.class 标签组装；
 * 2. buildInspectorAiSnippet：发送到 AI 的结构化 Prompt；
 * 3. hasInspectorComputedStyles：computedStyles 摘要有效性判断。
 * （audit-repair-202609 T19：convertInspectedElementPayload 随 legacy
 *   crish:dom-inspected 协议清退而删除，对应用例一并移除。）
 * 遵循测试资产保护铁律（UTF-8 无 BOM，中文注释）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildInspectorAiSnippet,
  buildInspectorElementLabel,
  hasInspectorComputedStyles,
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
});
