/**
 * apps/crish-desktop/src/components/chat-message/processTypographyContract.test.ts
 *
 * 【过程区排版统一契约】2026-09-11 用户裁决的自动化固化。
 *
 * 裁决原文要点：
 *   ① 「可以去掉工具调用或者是工作时间下的那根细线了，带上了这个影响排版了」
 *      → 过程区任何容器（控制栏 / 顶层工作状态头 / 工具面板）不得携带横向发丝分割线；
 *   ② 「思考和终端的文字大小不一样，边距感觉也是不一样……左边看上去不够统一」
 *      → 思考行 / 工具行 / 折叠控制栏必须同构：24px 行高、14px 字号、4px 左右内边距；
 *   ③ 「除了正文内容，其他的都是默认浅色的」
 *      → 过程区默认色恒为 --text-tertiary，悬停才提升到 --text-primary；
 *   ④ 「工具调用容器里面的元素颜色文字粗细也不一样，花了字体还偏小」
 *      → 字重恒 400（--font-weight-normal），字号恒 14px，禁止 12px / 11px 回流。
 *
 * 本文件只做「源码级负向断言 + 正向契约断言」，不渲染组件——
 * 目的是让上述任何一条被改回去时，CI 立即红。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT_MESSAGE = resolve(__dirname, '.');
const CHAT_ROW = resolve(__dirname, '../chat-message-row');
const CHAT_TOOL = resolve(__dirname, '../chat-tool-call');

/** 读取 CSS 并剥离注释（注释内的反例文本不得被误判为真实声明） */
function readCss(...segments: string[]): string {
  const raw = readFileSync(resolve(...segments), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 提取「独立平铺选择器」的声明块；未命中返回空串（由调用方断言非空）。
 * 锚定行首：避免误命中 `.toolRowHead:hover .toolRowSummary` 这类复合选择器，
 * 防止悬停态覆写被误判为基础契约。
 */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? '';
}

const reasoningCss = readCss(CHAT_ROW, 'ReasoningRow.module.css');
const toolCss = readCss(CHAT_TOOL, 'ChatToolCallBlock.module.css');
const foldCss = readCss(CHAT_MESSAGE, 'FoldableProcessSection.module.css');
const contentCss = readCss(CHAT_MESSAGE, 'MessageContent.module.css');

/* ═══════════════════════════════════════════════════════════════════════════
 * 一、思考行（ReasoningRow）基线
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('思考行排版基线', () => {
  it('行容器：24px 行高 / 14px 字号 / 默认浅色（--text-tertiary）', () => {
    const b = block(reasoningCss, '.reasoningRow');
    expect(b).not.toBe('');
    expect(b).toMatch(/height:\s*24px/);
    expect(b).toMatch(/line-height:\s*24px/);
    expect(b).toMatch(/font-size:\s*14px/);
    expect(b).toMatch(/color:\s*var\(--text-tertiary\)/);
    expect(b).toMatch(/padding:\s*0/);
  });

  it('语义标签「思考」：字重 400 + 颜色继承行状态机，严禁独立硬编码', () => {
    const b = block(reasoningCss, '.reasoningLabel');
    expect(b).not.toBe('');
    expect(b).toMatch(/font-size:\s*14px/);
    expect(b).toMatch(/font-weight:\s*var\(--font-weight-normal/);
    expect(b).toMatch(/color:\s*inherit/);
  });

  it('负向断言：语义标签不得回潮 500 字重或 --text-secondary 硬编码', () => {
    const b = block(reasoningCss, '.reasoningLabel');
    expect(b).not.toMatch(/font-weight:\s*var\(--font-weight-medium/);
    expect(b).not.toMatch(/font-weight:\s*(500|600|700)/);
    expect(b).not.toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it('负向断言：不得再存在 .isLive .reasoningLabel 冗余状态覆写（状态机已由行容器驱动）', () => {
    expect(reasoningCss).not.toMatch(/\.isLive\s+\.reasoningLabel/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 二、工具调用行（ChatToolCallBlock）与思考行同构
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('工具调用行与思考行同构', () => {
  it('行头：24px 行高 / 14px 字号 / 字重 400 / 默认浅色，与思考行完全一致', () => {
    const b = block(toolCss, '.toolRowHead');
    expect(b).not.toBe('');
    expect(b).toMatch(/height:\s*24px/);
    expect(b).toMatch(/line-height:\s*24px/);
    expect(b).toMatch(/font-size:\s*14px/);
    expect(b).toMatch(/font-weight:\s*var\(--font-weight-normal/);
    expect(b).toMatch(/color:\s*var\(--text-tertiary\)/);
    expect(b).toMatch(/padding:\s*0/);
  });

  it('悬停态与思考行一致：提升到 --text-primary（而非次级色）', () => {
    const b = block(toolCss, '.toolRowHead:hover');
    expect(b).toMatch(/color:\s*var\(--text-primary\)/);
    // 负向断言：悬停不得停留在次级色（与思考行割裂）
    expect(b).not.toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it('工具行内所有文本元素字号统一为 14px', () => {
    for (const sel of [
      '.toolRowSummary',
      '.toolActionText',
      '.dotSeparator',
      '.toolParamText',
      '.toolSecondaryMetaInline',
      '.toolSecondaryMeta',
    ]) {
      const b = block(toolCss, sel);
      expect(b, `${sel} 声明块必须存在`).not.toBe('');
      expect(b, `${sel} 字号必须为 14px`).toMatch(/font-size:\s*14px/);
    }
  });

  it('负向断言：工具行内不得回潮小字号 token（12px / 11px / 10px）', () => {
    for (const sel of [
      '.toolRowSummary',
      '.toolActionText',
      '.dotSeparator',
      '.toolParamText',
      '.toolSecondaryMetaInline',
      '.toolSecondaryMeta',
    ]) {
      const b = block(toolCss, sel);
      expect(b, `${sel} 不得使用小字号`).not.toMatch(
        /font-size:\s*var\(--font-size-(xs|micro|xxs)/
      );
      expect(b, `${sel} 不得使用小字号字面量`).not.toMatch(
        /font-size:\s*(9|10|11|12|13)px/
      );
    }
  });

  it('负向断言：工具行动作文案不得回潮 500 字重', () => {
    const b = block(toolCss, '.toolActionText');
    expect(b).toMatch(/font-weight:\s*var\(--font-weight-normal/);
    expect(b).not.toMatch(/font-weight:\s*(500|600|700)/);
  });

  it('工具栈与工具行的外边距归零（杜绝行间额外留白）', () => {
    const stack = block(toolCss, '.toolStack');
    expect(stack).toMatch(/padding:\s*0/);
    const row = block(toolCss, '.toolRow');
    expect(row).toMatch(/margin:\s*0/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 三、折叠控制栏与顶层工作状态头：零发丝分割线
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('过程区零发丝分割线（用户裁决 · 2026-09-11）', () => {
  it('负向断言：折叠控制栏不得携带任何横向分割线', () => {
    const b = block(foldCss, '.controlBar');
    expect(b).not.toBe('');
    expect(b).not.toMatch(/border-bottom/);
    expect(b).not.toMatch(/border-top/);
  });

  it('负向断言：控制栏悬停态不得回潮分割线', () => {
    const b = block(foldCss, '.controlBar:hover');
    expect(b).not.toMatch(/border/);
  });

  it('负向断言：顶层工作状态头（工作时间区）不得携带发丝底线', () => {
    const b = block(contentCss, '.topProcessHeader');
    expect(b).not.toBe('');
    expect(b).not.toMatch(/border-bottom/);
    expect(b).not.toMatch(/border-top/);
  });

  it('负向断言：工具调用面板底部不得携带发丝底线', () => {
    const b = block(toolCss, '.toolSectionInput');
    expect(b).not.toBe('');
    expect(b).toMatch(/border-bottom:\s*none/);
  });

  it('负向断言：折叠容器样式中时间胶囊已彻底物理消失', () => {
    expect(foldCss).not.toMatch(/\.timeCapsule/);
    expect(foldCss).not.toMatch(/dashed/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 四、折叠控制栏文案与过程行同构
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('折叠控制栏文案同构', () => {
  it('控制栏默认浅色，文案 14px / 字重 400 / 继承色', () => {
    const bar = block(foldCss, '.controlBar');
    expect(bar).toMatch(/color:\s*var\(--text-tertiary\)/);
    const label = block(foldCss, '.summaryLabel');
    expect(label).toMatch(/font-size:\s*14px/);
    expect(label).toMatch(/font-weight:\s*var\(--font-weight-normal/);
    expect(label).toMatch(/color:\s*inherit/);
  });

  it('负向断言：控制栏文案不得回潮小字号与重字重', () => {
    const label = block(foldCss, '.summaryLabel');
    expect(label).not.toMatch(/font-size:\s*var\(--font-size-(xs|micro|xxs)/);
    expect(label).not.toMatch(/font-size:\s*(9|10|11|12|13)px/);
    expect(label).not.toMatch(/font-weight:\s*(500|600|700)/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 五、Design Token 纪律：折叠容器零裸 Hex
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('Design Token 纪律', () => {
  it('负向断言：折叠容器样式零裸 Hex', () => {
    expect(foldCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('负向断言：折叠容器所有颜色均走 token（不得出现 rgb(/hsl( 硬编码）', () => {
    expect(foldCss).not.toMatch(/\brgba?\(/);
    expect(foldCss).not.toMatch(/\bhsla?\(/);
  });
});
