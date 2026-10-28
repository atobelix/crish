/**
 * P2-a / P2-b-1（FINAL-PLAN §4.1）契约：行距 token 化 + 操作栏行内浮层（变体 ①）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CRLF 检出（core.autocrlf=true）下多行选择器含 \r\n，统一成 \n 再匹配
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(
    /\r\n/g,
    '\n'
  );
const rowCss = read('../ChatMessageRow.module.css');
const noticeCss = read('../../chat-message/ContextStateNotice.module.css');
const tokens = read('../../../styles/tokens-space.css');
const bar = read('../AssistantMessageActionsBar.tsx');

function block(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`missing ${selector}`);
  return m[1];
}

describe('行距 token', () => {
  it('三档 tokens-space.css 都声明 --chat-row-gap / --chat-row-gap-compact', () => {
    expect(tokens.match(/--chat-row-gap:\s*\d+px;/g)).toHaveLength(3);
    expect(tokens.match(/--chat-row-gap-compact:\s*\d+px;/g)).toHaveLength(3);
  });
  it('.row / .rowCarrier 引用 token；ContextStateNotice 不再叠加 margin', () => {
    expect(block(rowCss, '.row')).toMatch(
      /padding-bottom:\s*var\(--chat-row-gap,/
    );
    expect(block(rowCss, '.rowCarrier')).toMatch(
      /var\(--chat-row-gap-compact,/
    );
    expect(noticeCss).not.toMatch(/margin:\s*var\(--space-1, 4px\) 0;/);
  });
});

/** 合并同一选择器的所有规则体（后写的覆盖先写的由用例按需判断）。 */
function allBlocks(css: string, selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const sels = m[1]!
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]!);
  }
  return out.join('\n');
}

/*
 * 2026-10-10 修正：P2-b-1 变体 ① 的行内浮层会盖住气泡 / 正文最后一行，
 * 且让 .userStack 只按气泡收缩、气泡 max-width 85% 二次打折（「你好啊」折成两行）。
 * 新契约：操作栏在正文下方文档流内固定槽位（不重叠），每行槽位相同（行距均匀），只切 opacity。
 */
describe('操作栏在正文下方占位，不与气泡 / 正文重叠', () => {
  it('.userMeta / .assistantMeta 不绝对定位、不浮层，在文档流中预留固定高度槽位', () => {
    for (const sel of ['.userMeta', '.assistantMeta']) {
      const css = allBlocks(rowCss, sel);
      expect(css).not.toMatch(/position:\s*(absolute|fixed)/);
      expect(css).not.toMatch(/bottom:/);
      expect(css).toMatch(/min-height:\s*28px/);
      expect(css).toMatch(/margin-top:\s*var\(--space-1, 4px\)/);
    }
    // 全文件不再出现「非常显 meta 绝对定位」的浮层规则
    expect(rowCss).not.toMatch(
      /\.(userMeta|assistantMeta):not\(\.metaAlways\)[^{]*\{[^}]*position:\s*absolute/
    );
  });

  it('默认透明、hover / focus-within 只改 opacity 与 pointer-events，不切 display / visibility', () => {
    const base = allBlocks(rowCss, '.userMeta');
    expect(base).toMatch(/opacity:\s*0/);
    expect(base).toMatch(/pointer-events:\s*none/);
    for (const sel of [
      '.rowUser:hover .userMeta',
      '.rowAssistant:hover .assistantMeta',
    ]) {
      const hover = allBlocks(rowCss, sel);
      expect(hover).toMatch(/opacity:\s*1/);
      expect(hover).not.toMatch(/display|visibility|height|margin|padding/);
    }
  });

  it('常显行（metaAlways）只是常亮，几何与其他行一致（行距均匀）', () => {
    expect(bar).toMatch(/isLastAssistant \? ` \$\{styles\.metaAlways\}`/);
    const always = allBlocks(rowCss, '.userMeta.metaAlways');
    expect(always).toMatch(/opacity:\s*1/);
    expect(always).not.toMatch(/margin|height|padding|position/);
  });

  it('估高把操作栏槽位计入（与 CSS 的 4 + 28 一致）', () => {
    const est = read('../../../api/virtualScrollEstimate.ts');
    expect(est).toMatch(/export const META_SLOT_PX = 32;/);
    expect(est).toMatch(/META_SLOT_PX \+ CHAT_ROW_GAP_PX/);
    expect(est).toMatch(/let h = CHAT_ROW_GAP_PX \+ META_SLOT_PX;/);
  });
});

describe('用户气泡不被压窄', () => {
  it('气泡不再用百分比 max-width（避免相对已收缩的 .userStack 二次打折）', () => {
    const bubble = allBlocks(rowCss, '.userBubble');
    expect(bubble).toMatch(/width:\s*fit-content/);
    expect(bubble).toMatch(/max-width:\s*100%/);
    expect(bubble).not.toMatch(/max-width:\s*min\(\s*\d+%/);
    expect(bubble).not.toMatch(/min-width:\s*min-content/);
  });
  it('宽度上限只在 .userStack（85% / 720px），且不被 min-content 撑破', () => {
    const stack = allBlocks(rowCss, '.userStack');
    expect(stack).toMatch(/max-width:\s*min\(85%, 720px\)/);
    expect(stack).not.toMatch(/min-width:\s*min-content/);
  });
  it('中文不逐字断行：不用 break-all，长串用 overflow-wrap: anywhere', () => {
    const bubble = allBlocks(rowCss, '.userBubble');
    expect(bubble).not.toMatch(/word-break:\s*break-all/);
    expect(bubble).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
