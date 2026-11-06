/**
 * AN4 契约钉（用户 2026-11-02 裁决：工具内容伪流式显现）：
 * 1) 共享入场关键帧 crish-row-enter 在 design-system.css 全局层只定义
 *    一次，本体与消息行入场同参（opacity .6→1 + translateY 4px→0）；
 * 2) toolIndicatorFlip（rotateY 翻转）全树消亡，代之以 150ms opacity
 *    交叉淡化 toolIndicatorCrossfade（duration-fast token 驱动）；
 * 3) 工具行/组头入场类引用共享关键帧与 --reveal-delay 交错变量；
 * 4) 节律常数单源：toolRevealState / toolTextDrain 只消费
 *    utils/revealPacing，不出现第二套 2600/5200 速率字面量；
 * 5) 协调接线在位：FoldableToolGroup 订阅排空 settle + 900ms 硬顶；
 *    CompactToolRow 接入场 hook 与让位 settle。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('AN4 · 共享入场关键帧单源', () => {
  const ds = read('styles/design-system.css');

  it('crish-row-enter 在 design-system.css 只定义一次', () => {
    expect(countOccurrences(ds, '@keyframes crish-row-enter')).toBe(1);
  });

  it('本体与消息行入场同参（opacity .6 / translateY(4px)）', () => {
    const idx = ds.indexOf('@keyframes crish-row-enter');
    const body = ds.slice(idx, idx + 400);
    expect(body).toContain('opacity: 0.6');
    expect(body).toContain('translateY(4px)');
    expect(body).toContain('opacity: 1');
    expect(body).toContain('translateY(0)');
  });
});

describe('AN4 · toolIndicatorFlip 废除 → opacity 交叉淡化', () => {
  const blockCss = read(
    'components/chat-tool-call/ChatToolCallBlock.module.css'
  );
  const dir = path.join(SRC, 'components/chat-tool-call');
  const cssFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'));

  it('chat-tool-call 全部 CSS 中 toolIndicatorFlip 消亡', () => {
    for (const css of cssFiles) {
      expect(css).not.toContain('toolIndicatorFlip');
    }
  });

  it('toolIndicatorCrossfade 在位且由 duration-fast（150ms）驱动、无 rotateY', () => {
    expect(blockCss).toContain('@keyframes toolIndicatorCrossfade');
    const flipRule = blockCss.match(
      /\[data-in-place-flipping='true'\][^{]*\{([^}]*)\}/
    )?.[1];
    expect(flipRule).toBeTruthy();
    expect(flipRule).toContain('toolIndicatorCrossfade');
    expect(flipRule).toContain('var(--duration-fast)');
    expect(flipRule).not.toContain('rotateY');
  });

  it('就地翻转状态窗与交叉淡化同为 150ms（常量对齐）', () => {
    const state = read('components/chat-tool-call/toolExpansionState.ts');
    expect(state).toContain('IN_PLACE_FLIP_DURATION_MS = 150');
  });
});

describe('AN4 · 入场类与交错变量', () => {
  const blockCss = read(
    'components/chat-tool-call/ChatToolCallBlock.module.css'
  );
  const groupCss = read(
    'components/chat-tool-call/FoldableToolGroup.module.css'
  );
  const cardCss = read('components/agent-card/SubagentDispatchCard.module.css');

  it('.toolRowEnter 经全局类 .crish-entrance-fade 消费共享关键帧（时长/交错在全局类体内）', () => {
    // keyframes 悬空修复批：模块按名引用改 composes 全局通道类；
    // duration-fast 与 --reveal-delay 交错随通道类本体在 design-system.css 钉。
    const body = blockCss.match(/\.toolRowEnter\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toContain('crish-entrance-fade');
    const dsCss = read('styles/design-system.css');
    const channel = dsCss.match(/\.crish-entrance-fade\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(channel).toContain('crish-row-enter');
    expect(channel).toContain('var(--duration-fast)');
    expect(channel).toContain('var(--reveal-delay, 0ms)');
  });

  it('.outputRevealFade 引用 crish-fade-in + accordion-fade 时长', () => {
    const body = blockCss.match(/\.outputRevealFade\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toContain('crish-anim-fade-in');
    expect(body).toContain('var(--duration-accordion-fade)');
  });

  it('组头 .groupEnter 与分派卡 .cardEnter 同语言入场', () => {
    const g = groupCss.match(/\.groupEnter\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(g).toContain('crish-entrance-fade');
    const c = cardCss.match(/\.cardEnter\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(c).toContain('crish-entrance-fade');
    const t = cardCss.match(/\.traceFade\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(t).toContain('crish-anim-fade-in');
  });
});

describe('AN4 · 节律常数单源（禁第二套速率）', () => {
  it('toolRevealState / toolTextDrain 消费 revealPacing 且无 2600/5200 字面量', () => {
    const state = read('components/chat-tool-call/toolRevealState.ts');
    const drain = read('components/chat-tool-call/toolTextDrain.ts');
    expect(state).toContain("from '../../utils/revealPacing'");
    expect(drain).toContain('frameHardCapChars');
    for (const src of [state, drain]) {
      expect(src).not.toMatch(/\b2600\b/);
      expect(src).not.toMatch(/\b5200\b/);
    }
  });

  it('排空带与硬顶常量在 toolRevealState 单点声明', () => {
    const state = read('components/chat-tool-call/toolRevealState.ts');
    expect(state).toContain('DRAIN_BAND_MAX_CHARS = 4600');
    expect(state).toContain('DRAIN_MAX_DURATION_MS = 900');
    expect(state).toContain(
      'AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS = DRAIN_MAX_DURATION_MS'
    );
    expect(state).toContain('REVEAL_STAGGER_STEP_MS = 50');
  });
});

describe('AN4 · 协调接线在位', () => {
  it('FoldableToolGroup：自动折叠订阅排空 settle + 硬顶常量', () => {
    const group = read('components/chat-tool-call/FoldableToolGroup.tsx');
    expect(group).toContain('onAllToolDrainsSettled');
    expect(group).toContain('AUTO_COLLAPSE_DRAIN_WAIT_CAP_MS');
    expect(group).toContain('hasActiveToolDrain');
  });

  it('CompactToolRow：入场 hook + 让位 settle 接线', () => {
    const row = read('components/chat-tool-call/CompactToolRow.tsx');
    expect(row).toContain('useRevealEntrance');
    expect(row).toContain('settleToolReveal');
    expect(row).toContain('onPointerDownCapture');
    expect(row).toContain('onFocusCapture');
  });

  it('ToolCallOutputPane：揭示 hook 接入且保留 HC1 fade 接线（F1 后经 ScrollFadeRegion）', () => {
    const pane = read('components/chat-tool-call/ToolCallOutputPane.tsx');
    expect(pane).toContain('useToolOutputReveal');
    expect(pane).toContain('ScrollFadeRegion');
    expect(pane).toContain('onInnerAnimationEnd={reveal.handleFadeEnd}');
    expect(pane).toContain('reveal.displayText');
  });
});
