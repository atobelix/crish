import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

function read(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

describe('FlowScrubber 源码钉', () => {
  it('产品文件无 position:fixed / DemoData / FlowTimelineRail', () => {
    const files = [
      'FlowScrubber.tsx',
      'FlowScrubber.module.css',
      'flowScrubberModel.ts',
      'MessageVirtualizer.tsx',
      'ChatMessageList.tsx',
    ];
    for (const name of files) {
      const src = stripComments(read(name));
      expect(src, name).not.toMatch(/position\s*:\s*fixed/);
      expect(src, name).not.toMatch(/DemoData/);
      expect(src, name).not.toMatch(/FlowTimelineRail/);
      expect(src, name).not.toMatch(/100vw/);
      expect(src, name).not.toMatch(/flow-msg--user/);
    }
  });

  it('相对叶 scroller 绝对定位，hitbox 不侵入滚动条', () => {
    const css = read('FlowScrubber.module.css');
    expect(css).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/right:\s*0/);
    expect(css).toMatch(/scrollbar-thumb-width/);
    expect(css).not.toMatch(/calc\(50%/);
    const tsx = read('FlowScrubber.tsx');
    expect(tsx).toMatch(/data-flow-scrubber/);
    expect(tsx).toMatch(/from '(?:\.\.\/ui|@\/components\/ui)'/);
    expect(tsx).not.toMatch(/\btitle=/);
  });

  it('不破坏 ChatMessageList 撤回 / 虚拟列表 / stream 槽', () => {
    const list = read('ChatMessageList.tsx');
    const virt = read('MessageVirtualizer.tsx');
    const slot = read('workspaceChatStream.slot.ts');
    const card = readFileSync(join(DIR, '../chat-card/ChatCard.tsx'), 'utf8');
    expect(list).toMatch(/onRetract/);
    expect(list).toMatch(/MessageVirtualizer/);
    expect(list).toMatch(/NarrativeRenderSlotsContext/);
    expect(virt).toMatch(/onRetract/);
    expect(virt).toMatch(/data-virtual-scroll/);
    expect(virt).toMatch(/FlowScrubber/);
    expect(slot).toMatch(/workspace\.chat\.stream/);
    expect(card).toMatch(/workspace\.chat\.stream/);
    expect(card).toMatch(/fallback=\{<ChatMessageList/);
  });

  it('FlowScrubber 无 emoji，固定提示无文字硬编码「已固定」', () => {
    const tsx = read('FlowScrubber.tsx');
    expect(tsx).not.toMatch(/\u{1F4CC}/u);
    expect(tsx).not.toMatch(/已固定/);
  });
});
