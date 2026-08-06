import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import { slugifyHeading, CustomHeading } from '../extensions/foundation/HeadingAnchor';
import { CalloutExtension, CALLOUT_ICONS } from '../extensions/foundation/CalloutExtension';
import { TagExtension } from '../extensions/foundation/TagExtension';
import { DEFAULT_SLASH_ITEMS } from '../extensions/foundation/SlashCommands';
import { DefaultMarkdownService } from '../services/io/markdownService';
import { Tooltip } from '../components/ui/Tooltip';
import { TEXT_COLORS, HIGHLIGHT_COLORS } from '../types/editor';

describe('Milestone 1: Core Foundation & Block Engine', () => {
  describe('Feature 1: Commercial Light-Mode Typography & Color Tokens', () => {
    it('defines text and highlight color option palettes', () => {
      expect(TEXT_COLORS.length).toBeGreaterThan(5);
      expect(HIGHLIGHT_COLORS.length).toBeGreaterThan(5);
      expect(TEXT_COLORS.some((c) => c.value === '#2563EB')).toBe(true);
      expect(HIGHLIGHT_COLORS.some((c) => c.bgValue === '#FEF9C3')).toBe(true);
    });
  });

  describe('Feature 2 & 3: Headings H1-H6 with Section Anchors & Tags', () => {
    it('slugifies heading text accurately for anchor IDs', () => {
      expect(slugifyHeading('Hello World')).toBe('hello-world');
      expect(slugifyHeading('  Notion 渲染 引擎  ')).toBe('notion-渲染-引擎');
      expect(slugifyHeading('---')).toBe('section');
    });

    it('configures CustomHeading node with levels 1 to 6', () => {
      expect(CustomHeading.name).toBe('heading');
      expect(CustomHeading.config.addLevels?.()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('configures TagExtension mark', () => {
      expect(TagExtension.name).toBe('tag');
    });
  });

  describe('Feature 6: Callouts & Alert Blocks', () => {
    it('provides correct default icons for Warning, Note, Info, Tip callout types', () => {
      expect(CALLOUT_ICONS.warning).toBe('⚠️');
      expect(CALLOUT_ICONS.note).toBe('💡');
      expect(CALLOUT_ICONS.info).toBe('ℹ️');
      expect(CALLOUT_ICONS.tip).toBe('🚀');
    });

    it('configures CalloutExtension with block group and attributes', () => {
      expect(CalloutExtension.name).toBe('callout');
      expect(CalloutExtension.config.group).toBe('block');
    });
  });

  describe('Features 11 & 12: Slash Command Catalog & Keyboard Handling', () => {
    it('contains comprehensive command list for H1-H6, Lists, Callouts, Quote, Divider', () => {
      const ids = DEFAULT_SLASH_ITEMS.map((item) => item.id);
      expect(ids).toContain('h1');
      expect(ids).toContain('h6');
      expect(ids).toContain('bullet-list');
      expect(ids).toContain('ordered-list');
      expect(ids).toContain('task-list');
      expect(ids).toContain('callout-warning');
      expect(ids).toContain('blockquote');
      expect(ids).toContain('divider');
    });
  });

  describe('Markdown Serialization (Bi-directional)', () => {
    it('serializes headings, paragraphs, blockquotes, lists, and callouts back to markdown', () => {
      const service = new DefaultMarkdownService();
      const ast = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: '主标题' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '基础文本 ' },
              { type: 'text', marks: [{ type: 'bold' }], text: '粗体' },
            ],
          },
          {
            type: 'callout',
            attrs: { type: 'warning' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '警告内容' }] }],
          },
          {
            type: 'horizontalRule',
          },
        ],
      };

      const md = service.serializeASTToMarkdown(ast);
      expect(md).toContain('# 主标题');
      expect(md).toContain('基础文本 **粗体**');
      expect(md).toContain('> [!WARNING]');
      expect(md).toContain('---');
    });
  });

  describe('Custom Tooltip Component (Rule 2)', () => {
    it('renders child element and displays tooltip content on hover', async () => {
      render(
        <Tooltip content="Tooltip Hint Test" delay={0}>
          <button type="button">Hover Me</button>
        </Tooltip>
      );

      const btn = screen.getByRole('button', { name: 'Hover Me' });
      expect(screen.queryByText('Tooltip Hint Test')).toBeNull();

      fireEvent.mouseEnter(btn);
      // Wait for delayed state set or tick
      const tooltipEl = await screen.findByText('Tooltip Hint Test');
      expect(tooltipEl).toBeInTheDocument();
    });
  });
});
