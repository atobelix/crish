/**
 * apps/crish-desktop/src/components/chat-message/messageImageRadius.contract.test.ts
 *
 * 裁决 #7（2026-11-06）：消息图片圆角统一 16（R16 档）。
 * 四个定义点同值 16——排版层流内图（markdown-typography.css）、
 * 条带图（MessageContent.module.css .mdImg）、工具结果图
 * （ChatToolCallBlock.module.css .toolResultImg），另 ChatMessageRow
 * 的 .mdImg / .inlineImages 是与条带同规的死副本（零 TSX 引用，
 * 随 #7 删除，不得复活）。排版层其余「块元素 8px 档」成员
 * （数学块 / callout / details）仍为 --radius-m，图片离开块档
 * 不牵连它们。
 *
 * 注：推理摘要内联代码 4→6 的钉点（ReasoningRow.module.css
 * .summaryText code）随留置单元（ReasoningRow.module.css 另载
 * 他线未提交增量）后补进本文件，不在本批提交内。
 *
 * 本文件只做源码级断言，不渲染组件。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT_MESSAGE = resolve(__dirname, '.');
const CHAT_ROW = resolve(__dirname, '../chat-message-row');
const CHAT_TOOL_CALL = resolve(__dirname, '../chat-tool-call');
const STYLES = resolve(__dirname, '../../styles');

/** 读取 CSS 并剥离注释（注释内的反例文本不得被误判为真实声明） */
function readCss(...segments: string[]): string {
  const raw = readFileSync(resolve(...segments), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 提取「独立平铺选择器」的声明块；未命中返回空串（由调用方断言非空） */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? '';
}

const mdCss = readCss(STYLES, 'markdown-typography.css');
const messageCss = readCss(CHAT_MESSAGE, 'MessageContent.module.css');
const toolCss = readCss(CHAT_TOOL_CALL, 'ChatToolCallBlock.module.css');
const rowCss = readCss(CHAT_ROW, 'ChatMessageRow.module.css');
const tokensRadius = readCss(STYLES, 'tokens-radius.css');

describe('裁决 #7 · 消息图片圆角统一 16', () => {
  it('token 真值：--radius-xl = 16px', () => {
    expect(tokensRadius).toMatch(/--radius-xl:\s*16px/);
  });

  it('流内 markdown 图（排版层）取 --radius-xl', () => {
    const rule = block(
      mdCss,
      ':is(.conex-markdown, .md-rendered) :is(img, .md-img)'
    );
    expect(rule).not.toBe('');
    expect(rule).toMatch(/border-radius:\s*var\(--radius-xl\)/);
    expect(rule).not.toMatch(/--radius-m/);
  });

  it('块档其余成员仍为 --radius-m（图片离开块档不牵连它们）', () => {
    const hits = mdCss.match(/border-radius:\s*var\(--radius-m\)/g) ?? [];
    // 数学块 :271、callout :513、details :934 三处；图片 :476 已迁出
    expect(hits).toHaveLength(3);
  });

  it('条带图（MessageContent .mdImg）取 --radius-xl', () => {
    const rule = block(messageCss, '.mdImg');
    expect(rule).not.toBe('');
    expect(rule).toMatch(/border-radius:\s*var\(--radius-xl\)/);
  });

  it('工具结果图（ChatToolCallBlock .toolResultImg）取 --radius-xl', () => {
    const rule = block(toolCss, '.toolResultImg');
    expect(rule).not.toBe('');
    expect(rule).toMatch(/border-radius:\s*var\(--radius-xl\)/);
  });

  it('ChatMessageRow 死副本 .mdImg / .inlineImages 已删除，不得复活', () => {
    expect(rowCss).not.toMatch(/\.mdImg\s*\{/);
    expect(rowCss).not.toMatch(/\.inlineImages\s*\{/);
  });
});
