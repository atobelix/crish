/**
 * exitChannel.contract.test.ts — 退场通道守卫（2026-11-06 S4 退场基础设施）
 *
 * 背景：入场通道（AN4 判定核心 + useEntranceReveal + 共享呈现类）只有
 * 入场一侧；退场曾是直接卸载（附件 chip、审批卡、错误条、流内状态行、
 * 各类浮层菜单均硬消失）。S4 补退场判定对偶 + 宿主契约：
 * 判定核心 = chat-tool-call/toolRevealState.decideExit（decideEntrance
 * 的对偶）；宿主 = components/motion/useExitReveal（useClosingFlag /
 * useClosingValue + useExitReveal 力学）；呈现 = 全局类 .crish-exit-fade /
 * .crish-exit-popover（design-system.css 内定义，免 CSS Modules
 * keyframes 改名悬空）。
 *
 * 本守卫钉住防回潮的五件事：
 * 1. decideExit 是 decideEntrance 的对偶（空键/disabled/减动效/
 *    从未入场/虚拟窗口一律拒绝；已入场或 entered 显式覆盖才放行）；
 * 2. 退场时长档位 TS/CSS 双向同步（150ms 主档 / 120ms 浮层档）；
 * 3. 入场钩子在退场接管时让位（data-exiting 三处守卫）；
 * 4. 11 项首批集成确实接线（摘掉即红）；
 * 5. 本批触及的 CSS 模块不新增 keyframes 悬空（S 波收口 43 处教训：
 *    模块内引用的 animation 名必须在本文件内定义）。
 *
 * S5b 弹层收敛（2026-11-06，接 S4）：Menu 入场死选择器修复
 * （[data-state='open'] 对 Base UI 永远不匹配，改走 data-starting-style
 * + 过渡）；SettingsQuickMenu 死规则删除（入场/退场改走 menuContent）；
 * 私有退场 keyframes 名收敛为正典名（值不变）；TiptapSlashMenu /
 * ModelBadgePickerMenu 的父级早退修复（退场宿主保活）；ProjectPickerMenu
 * 死级联规则删除。新增断言见末尾 describe('S5b 弹层收敛')。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideExit,
  markEntered,
} from '../chat-tool-call/toolRevealState';
import {
  DURATION_EXIT_MS,
  DURATION_POPOVER_EXIT_MS,
  EXIT_SETTLE_BUFFER_MS,
} from '../../utils/motionTokens';

const SRC = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

let keySeq = 0;
const freshKey = () => `exit-contract-${++keySeq}-${Date.now()}`;

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 找出模块 CSS 中引用了却未在本文件定义的 keyframes 名（S 波收口模式）。 */
function danglingKeyframes(css: string): string[] {
  // 先去注释（注释里的 animation: 文字不算引用），再逐层剥括号内容
  // （var()/cubic-bezier() 里的逗号不是多动画分隔符）。
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const defined = new Set(
    [...clean.matchAll(/@keyframes\s+([A-Za-z][\w-]*)/g)].map((m) => m[1])
  );
  const referenced = new Set<string>();
  const stripParens = (v: string) => {
    let prev = '';
    let cur = v;
    while (prev !== cur) {
      prev = cur;
      cur = cur.replace(/\([^()]*\)/g, '');
    }
    return cur;
  };
  for (const m of clean.matchAll(/animation\s*:([^;]+);/g)) {
    for (const part of stripParens(m[1]).split(',')) {
      const name = part.trim().match(/^([A-Za-z][\w-]*)/)?.[1];
      if (name && !['none', 'var', 'inherit', 'initial', 'unset'].includes(name)) {
        referenced.add(name);
      }
    }
  }
  for (const m of clean.matchAll(/animation-name\s*:([^;]+);/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (n && n !== 'none') referenced.add(n);
    }
  }
  return [...referenced].filter((n) => !defined.has(n));
}

describe('decideExit 判定对偶', () => {
  it('空键拒绝', () => {
    expect(decideExit({ key: '' })).toBe(false);
    expect(decideExit({})).toBe(false);
  });

  it('disabled 拒绝', () => {
    expect(decideExit({ key: freshKey(), disabled: true, entered: true })).toBe(
      false
    );
  });

  it('虚拟窗口拒绝（即使已入场）', () => {
    expect(
      decideExit({ key: freshKey(), inVirtualWindow: true, entered: true })
    ).toBe(false);
  });

  it('系统减动效直落（matchMedia 命中 reduce）', () => {
    mockReducedMotion(true);
    expect(decideExit({ key: freshKey(), entered: true })).toBe(false);
  });

  it('从未入场拒绝', () => {
    expect(decideExit({ key: freshKey() })).toBe(false);
  });

  it('已入场放行（markEntered 登记）', () => {
    const key = freshKey();
    markEntered(key);
    expect(decideExit({ key })).toBe(true);
  });

  it('entered 显式覆盖放行（不走入场通道的引擎/浮层宿主）', () => {
    expect(decideExit({ key: freshKey(), entered: true })).toBe(true);
    expect(decideExit({ key: freshKey(), entered: false })).toBe(false);
  });

  it('返回值恒为 boolean', () => {
    expect(typeof decideExit({ key: freshKey(), entered: true })).toBe(
      'boolean'
    );
  });
});

describe('退场时长档位', () => {
  it('TS 常量：主档 150ms / 浮层档 120ms / 卸载余量 50ms', () => {
    expect(DURATION_EXIT_MS).toBe(150);
    expect(DURATION_POPOVER_EXIT_MS).toBe(120);
    expect(EXIT_SETTLE_BUFFER_MS).toBe(50);
  });

  it('TS 常量进 MOTION_DURATION（EXIT_MS / POPOVER_EXIT_MS）', () => {
    const motionTs = read('utils/motionTokens.ts');
    expect(motionTs).toContain('DURATION_EXIT_MS = 150');
    expect(motionTs).toContain('DURATION_POPOVER_EXIT_MS = 120');
    expect(motionTs).toContain('EXIT_SETTLE_BUFFER_MS = 50');
    expect(motionTs).toContain('EXIT_MS: DURATION_EXIT_MS');
    expect(motionTs).toContain('POPOVER_EXIT_MS: DURATION_POPOVER_EXIT_MS');
  });

  it('CSS token 与 TS 常量同步（tokens-base.css）', () => {
    const tokensBase = read('styles/tokens-base.css');
    expect(tokensBase).toContain('--duration-exit: 150ms');
    expect(tokensBase).toContain(
      '--transition-popover-exit: 120ms var(--ease-accelerate)'
    );
  });
});

describe('退场全局呈现类', () => {
  it('design-system.css 含 .crish-exit-fade / .crish-exit-popover 及本地 keyframes', () => {
    const css = read('styles/design-system.css');
    expect(css).toContain('@keyframes crish-row-exit');
    expect(css).toContain('.crish-exit-fade');
    expect(css).toContain('@keyframes crish-popover-exit');
    expect(css).toContain('.crish-exit-popover');
  });

  it('减动效档关闭退场动画', () => {
    const css = read('styles/design-system.css');
    // 入场与退场各有独立的 @media (prefers-reduced-motion) 块——全量收集
    const reduced = [...css.matchAll(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g
    )]
      .map((m) => m[1])
      .join('\n');
    expect(reduced).toContain('.crish-exit-fade');
    expect(reduced).toContain('.crish-exit-popover');
    expect(reduced).toContain('animation: none');
  });
});

describe('退场宿主封装', () => {
  it('useExitReveal 导出三件套并复用 decideExit', () => {
    const hook = read('components/motion/useExitReveal.ts');
    expect(hook).toContain('export function useExitReveal');
    expect(hook).toContain('export function useClosingFlag');
    expect(hook).toContain('export function useClosingValue');
    expect(hook).toContain('decideExit');
    expect(hook).toContain("el.dataset.exiting = 'true'");
  });

  it('motion/index.ts 导出退场宿主', () => {
    const index = read('components/motion/index.ts');
    expect(index).toContain('useExitReveal');
    expect(index).toContain('useClosingFlag');
    expect(index).toContain('useClosingValue');
  });

  it('入场钩子在退场接管时让位（三处 dataset.exiting 守卫）', () => {
    const hook = read('components/motion/useEntranceReveal.ts');
    const guards = hook.match(/dataset\.exiting === 'true'/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });
});

describe('首批集成接线', () => {
  it('ApprovalAskCard：closing prop + 退场力学 + 全局退场类', () => {
    const card = read('components/agent-card/ApprovalAskCard.tsx');
    expect(card).toContain('closing');
    expect(card).toContain('useExitReveal');
    expect(card).toContain('crish-exit-fade');
  });

  it('CompactToolRow：审批卡由 useClosingFlag 宿主保活', () => {
    const row = read('components/chat-tool-call/CompactToolRow.tsx');
    expect(row).toContain('useClosingFlag');
    expect(row).toContain('approvalExit');
    expect(row).toContain('renderApprovalCard');
  });

  it('ApprovalDock：closing prop + 自宿主（ChatComposerWrapper 路径）', () => {
    const dock = read('components/chat-card/ApprovalDock.tsx');
    expect(dock).toContain('closing');
    expect(dock).toContain('useClosingValue');
    expect(dock).toContain('crish-exit-fade');
  });

  it('ChatStatusRibbons：dock 与 errorBar 均经宿主保活（单缎带纪律保留）', () => {
    const ribbons = read('components/chat-card/ChatStatusRibbons.tsx');
    expect(ribbons).toContain('useClosingFlag');
    expect(ribbons).toContain('useClosingValue');
    expect(ribbons).toContain('errorBarClosing');
    expect(ribbons).toContain('dockClosing');
  });

  it('ComposerErrorBar：closing prop + 快照宿主', () => {
    const bar = read('components/chat-card/ComposerErrorBar.tsx');
    expect(bar).toContain('closing');
    expect(bar).toContain('useClosingValue');
    expect(bar).toContain('crish-exit-fade');
  });

  it('InFlowStatusLine + MessageContent：retry 值由 useClosingValue 保活', () => {
    const line = read('components/chat-message-row/InFlowStatusLine.tsx');
    expect(line).toContain('closing');
    expect(line).toContain('useExitReveal');
    const content = read('components/chat-message/MessageContent.tsx');
    expect(content).toContain('useClosingValue');
    expect(content).toContain('closingRetry');
    expect(content).toContain('closing={closingRetry.closing}');
  });

  it('附件条：退场槽 + 包裹 + 移除拦截', () => {
    const bar = read('components/chat-composer/ComposerAttachmentBar.tsx');
    expect(bar).toContain('closingEntries');
    expect(bar).toContain('ClosingAttachWrap');
    expect(bar).toContain('handleRemove');
  });

  it('AnnotationChipItem：chip 退场 + popover 保活 + 本地退场 keyframes', () => {
    const chip = read('components/chat-composer/AnnotationChipItem.tsx');
    expect(chip).toContain('closing');
    expect(chip).toContain('useExitReveal');
    expect(chip).toContain('useClosingFlag');
    const css = read('components/chat-composer/AnnotationChipItem.module.css');
    expect(css).toContain('@keyframes crish-popover-exit-top');
    expect(css).toContain(".annPopoverCard[data-closing='true']");
  });

  it('PermissionModeMenu：条件渲染已删（常渲染 Menu，退场由 Base UI Presence 保活）', () => {
    const menu = read('components/chat-composer/PermissionModeMenu.tsx');
    // 注释里会提到 {open &&} 的典故，故只钉代码形态：不再以 {open && <Menu 包裹
    expect(menu).not.toContain('{open && <Menu');
  });

  it('Menu.tsx：anchor 早退已删（关闭态由 menuContent[data-state] 接管）', () => {
    const menuTsx = read('components/ui/Menu/Menu.tsx');
    expect(menuTsx).not.toContain('if (anchor && !isOpen)');
  });

  it('Menu.module.css：退场选择器须覆盖 Base UI 与 Radix 两引擎（Popup 无 data-state，Radix 有）', () => {
    const css = read('components/ui/Menu/Menu.module.css');
    // Base UI v1：data-ending-style（实机证伪：Popup 无 data-state）
    expect(css).toContain('.menuContent[data-ending-style]');
    expect(css).toContain('.popup[data-ending-style]');
    // Radix：data-state='closed'（SEP 主面板 Popover.Content 确实写 data-state，须保留）
    expect(css).toContain(".menuContent[data-state='closed']");
    expect(css).toContain(".popup[data-state='closed']");
  });

  it('PermissionModeMenu.module.css：压过退场规则的死 animation 已删', () => {
    const css = read('components/chat-composer/PermissionModeMenu.module.css');
    expect(css).not.toContain('animation: crish-popover-enter');
  });

  it('SmartExpandablePanel：级联子菜单由 useClosingValue 保活', () => {
    const sep = read(
      'components/ui/SmartExpandablePanel/SmartExpandablePanel.tsx'
    );
    expect(sep).toContain('useClosingValue');
    expect(sep).toContain('closingSubmenu');
    expect(sep).toContain('closing={closingSubmenu.closing}');
    const submenu = read(
      'components/ui/SmartExpandablePanel/SmartPanelCascadeSubmenu.tsx'
    );
    expect(submenu).toContain('closing');
    expect(submenu).toContain("data-state={closing ? 'closed' : 'open'}");
    const css = read(
      'components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css'
    );
    expect(css).toContain('@keyframes crish-popover-exit');
    expect(css).toContain(".cascadeSubmenu[data-state='closed']");
  });

  it('ComposePlusMenu：父级早退已删，SEP 由 useClosingFlag 保活（Radix Presence 可播退场）', () => {
    const plus = read('components/chat-composer/ComposePlusMenu.tsx');
    expect(plus).toContain('useClosingFlag');
    expect(plus).toContain('plusClosing');
    // 注释里会提到该早退的典故，故只钉行首的实际语句形态
    expect(plus).not.toMatch(/^\s*if \(!open\) return null;/m);
    expect(plus).toContain('if (!plusClosing.visible) return null;');
  });

  it('NewTabLauncherPopover：本地退场 keyframes + closed 态规则', () => {
    const css = read(
      'components/binary-tree/NewTabLauncherPopover.module.css'
    );
    // S5b：私有 keyframes 名 launcherExit 已收敛为正典名（值不变）
    expect(css).toContain('@keyframes crish-popover-exit');
    expect(css).not.toContain('@keyframes launcherExit');
    expect(css).not.toContain('launcherExit');
    expect(css).toContain(".popoverContent[data-state='closed']");
  });

  it('SlashMenuOverlay：snap 快照宿主 + 全局浮层退场类', () => {
    const overlay = read('components/note-paper/SlashMenuOverlay.tsx');
    expect(overlay).toContain('useClosingValue');
    expect(overlay).toContain('closingSnap');
    expect(overlay).toContain('crish-exit-popover');
  });

  it('FileAnnotationPopover：快照宿主 + 本地退场 keyframes', () => {
    const pop = read('components/files/FileAnnotationPopover.tsx');
    expect(pop).toContain('useClosingValue');
    expect(pop).toContain('closingPop');
    expect(pop).toContain('data-closing');
    const css = read('components/files/FileAnnotationPopover.module.css');
    // S5b：私有 keyframes 名 popoverFadeOut 已收敛为正典名（值不变）
    expect(css).toContain('@keyframes crish-popover-exit');
    expect(css).not.toContain('popoverFadeOut');
    expect(css).toContain(".popover[data-closing='true']");
  });

  it('DraftUndoToast：closing 宿主 + 本地退场 keyframes', () => {
    const toast = read('components/chat-composer/DraftUndoToast.tsx');
    expect(toast).toContain('useClosingFlag');
    expect(toast).toContain('toastClosing');
    expect(toast).toContain('data-closing');
    const css = read('components/chat-composer/DraftUndoToast.module.css');
    // S5b：私有 keyframes 名 undoToastOut 已收敛为正典名 -top 变体（值不变）
    expect(css).toContain('@keyframes crish-popover-exit-top');
    expect(css).not.toContain('undoToastOut');
    expect(css).toContain(".undoToast[data-closing='true']");
  });
});

describe('S5b 弹层收敛', () => {
  it('Menu 入场：Base UI 走 data-starting-style + 过渡（[data-state=open] 仍留给 Radix）', () => {
    const css = read('components/ui/Menu/Menu.module.css');
    // 基类带入场过渡（减动效档归零）
    expect(css).toContain(
      'transition:\n      opacity var(--transition-popover-enter),\n      transform var(--transition-popover-enter);'
    );
    expect(css).toContain('.menuContent[data-starting-style]');
    expect(css).toContain('.popup[data-starting-style]');
    expect(css).toContain(
      ".menuContent[data-starting-style][data-side='top']"
    );
    // Radix 面仍走关键帧入场（SEP 主面板），不得误删
    expect(css).toContain(".menuContent[data-state='open']");
    expect(css).toContain('@keyframes crish-popover-enter');
    // 减动效档须同时关掉过渡（本文件 media 块在 @layer 内缩进，
    // 故不用 design-system 式 \n} 锚定，改以块内匹配）
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?transition: none;/
    );
  });

  it('SettingsQuickMenu：死 data-state 规则与本地 keyframes 已删，入场/退场改走 menuContent', () => {
    const css = read('components/settings/SettingsQuickMenu.module.css');
    expect(css).not.toContain(".sbQuickMenu[data-state='open']");
    expect(css).not.toContain(".sbQuickMenu[data-state='closed']");
    expect(css).not.toContain('@keyframes crish-popover-enter-top');
    expect(css).not.toContain('@keyframes crish-popover-exit-top');
    // 交接注释须写明接管方（防后人误以为本文件漏了动画）
    expect(css).toContain('menuContent');
    // 子菜单自有机制不动（其 popup 不挂 menuContent）
    expect(css).toContain('@starting-style');
    expect(css).toContain('.sbQuickSubmenu[data-ending-style]');
  });

  it('TiptapSlashMenu：父级早退已修（退场宿主保活）+ 本地 keyframes 已补', () => {
    const tsx = read('components/chat-composer/TiptapSlashMenu.tsx');
    expect(tsx).toContain('useClosingFlag');
    expect(tsx).toContain('tiptap-slash-menu');
    expect(tsx).toContain('slashClosing.visible');
    expect(tsx).not.toMatch(/^\s*if \(!isOpen\) return null;/m);
    const css = read('components/chat-composer/TiptapSlashMenu.module.css');
    expect(css).toContain('@keyframes crish-popover-enter');
    expect(css).toContain('@keyframes crish-popover-enter-top');
    expect(css).toContain('@keyframes crish-popover-exit');
    expect(css).toContain('@keyframes crish-popover-exit-top');
  });

  it('ModelBadgePickerMenu：父级早退已修（退场宿主保活），死类 .mbMenuExit 已删', () => {
    const tsx = read('components/provider/ModelBadgePickerMenu.tsx');
    expect(tsx).toContain('useClosingFlag');
    expect(tsx).toContain('model-badge-picker');
    expect(tsx).toContain('pickerClosing.visible');
    expect(tsx).not.toMatch(/^\s*if \(!open\) return null;/m);
    const css = read('components/provider/ModelBadgePickerMenu.module.css');
    // 死类规则已删（注释里仍会提到该类名的典故，故只钉规则形态）
    expect(css).not.toContain('.mbMenuExit {');
    expect(css).not.toContain('@keyframes crish-popover-exit');
    // 层遮挡棘轮：.mbMenu 不得挂未分层的 animation（会压过 @layer
    // components 内的 menuContent [data-ending-style] 退场规则，退场
    // 动画接管不上、Presence 约 5ms 即卸载；S4 的 .permMenu 同类缺陷
    // 前例）。入场改走 menuContent 过渡。
    const mbMenuBlock = css.match(/\.mbMenu \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(mbMenuBlock).not.toContain('animation:');
    // 本文件仅剩 .advancedContent 一处引用入场关键帧
    expect(css.match(/animation: crish-popover-enter/g)?.length).toBe(1);
  });

  it('ProjectPickerMenu：死级联规则已删（无 TSX 消费、悬空引用随之消除）', () => {
    const css = read('components/chat-card/ProjectPickerMenu.module.css');
    expect(css).not.toContain('.cascadeSubmenu');
    expect(css).not.toContain('crish-popover-enter');
  });

  it('私有 keyframes 名收敛：popover 族进/退场只剩正典名', () => {
    for (const rel of [
      'components/binary-tree/NewTabLauncherPopover.module.css',
      'components/files/FileAnnotationPopover.module.css',
      'components/chat-composer/DraftUndoToast.module.css',
      'components/chat-composer/AnnotationChipItem.module.css',
    ]) {
      const css = read(rel);
      expect(css).not.toContain('launcherEnter');
      expect(css).not.toContain('launcherExit');
      expect(css).not.toContain('popoverFadeIn');
      expect(css).not.toContain('popoverFadeOut');
      expect(css).not.toContain('undoToastIn');
      expect(css).not.toContain('undoToastOut');
      expect(css).not.toContain('annPopoverFadeIn');
      expect(css).not.toContain('annPopoverFadeOut');
    }
  });
});

describe('S5b 父级保活（实机发现的第二层早退）', () => {
  it('SlashExtension：关闭路径一律延迟销毁（先 isOpen=false 再 170ms 销毁）', () => {
    const ts = read('components/chat-composer/SlashExtension.ts');
    // 延迟销毁机制存在
    expect(ts).toContain('scheduleDestroy');
    expect(ts).toContain('destroyTimer');
    expect(ts).toContain('DURATION_POPOVER_EXIT_MS + EXIT_SETTLE_BUFFER_MS');
    // 关闭三路（菜单 onClose / 扩展 Esc / 建议 onExit）都不再直接销毁
    expect(ts).toContain('onClose: () => {\n        scheduleDestroy();');
    expect(ts).toMatch(/onKeyDown\(props: any\) \{[\s\S]*?scheduleDestroy\(\);/);
    // 销毁本体清定时器并统一清理引用（退场窗内保锚引用不得提前置空）
    expect(ts).toContain('clearTimeout(destroyTimer)');
    expect(ts).toMatch(
      /const destroyComponent = \(\) => \{[\s\S]*?propsRef = null;[\s\S]*?lastCachedBox = null;/
    );
    // 退场窗内重开：取消定时、就地复用
    expect(ts).toContain('if (component) {');
    expect(ts).toContain('component.updateProps(buildProps(props));');
  });

  it('ChatHeaderControls：父级宿主把 ModelBadgePickerMenu 多留一个退场窗', () => {
    const tsx = read('components/chat-card/ChatHeaderControls.tsx');
    expect(tsx).toContain('useClosingFlag');
    expect(tsx).toContain('model-badge-picker');
    expect(tsx).toContain('badgeClosing.visible');
    expect(tsx).toContain('badgeShownRef');
    // 条件渲染不再是 showModelDropdown 单条件（否则子级宿主同提交被卸载）
    expect(tsx).toContain('showModelDropdown || badgeClosing.visible');
    expect(tsx).not.toMatch(
      /\{showModelDropdown && !isUnconfigured \? \(/
    );
  });
});

describe('本批不新增 keyframes 悬空', () => {
  it.each([
    'styles/design-system.css',
    'components/chat-composer/AnnotationChipItem.module.css',
    'components/chat-composer/PermissionModeMenu.module.css',
    'components/chat-composer/DraftUndoToast.module.css',
    'components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css',
    'components/binary-tree/NewTabLauncherPopover.module.css',
    'components/files/FileAnnotationPopover.module.css',
    // S5b 新增：本批触及的其余 CSS 模块（Menu 入场过渡不引用 keyframes 名）
    'components/ui/Menu/Menu.module.css',
    'components/settings/SettingsQuickMenu.module.css',
    'components/chat-composer/TiptapSlashMenu.module.css',
    'components/chat-card/ProjectPickerMenu.module.css',
    'components/provider/ModelBadgePickerMenu.module.css',
  ])('%s 引用的 animation 名均在本文件内定义', (rel) => {
    expect(danglingKeyframes(read(rel))).toEqual([]);
  });
});
