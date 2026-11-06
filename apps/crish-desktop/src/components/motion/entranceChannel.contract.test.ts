/**
 * entranceChannel.contract.test.ts — 统一入场通道守卫（2026-11-06 动效统一封装批）
 *
 * 背景：AI 工作期间的新增 DOM 曾多轨入场（AN4 判定核心只覆盖 3 面、
 * 若干面自带私有 keyframes、若干面完全无入场）。统一通道收敛为：
 * 判定核心 = chat-tool-call/toolRevealState（单轨）；通用钩子 =
 * components/motion/useEntranceReveal（+ 组件形态 EntranceReveal）；
 * 呈现 = 共享 keyframes crish-row-enter + 全局类 .crish-entrance-fade。
 *
 * 本守卫钉住防回潮的四件事：
 * 1. AN4 旧钩子只剩 re-export 垫片，不许再长出第二份判定实现；
 * 2. 已登记接入面确实 import 通道（摘掉即红）；
 * 3. 已删除的私有入场 keyframes（errorBarIn / chipFadeIn）不许复活；
 * 4. 共享呈现类存在且只引用 crish-row-enter。
 *
 * 注：FoldableToolGroup 的 grow 变体接入曾因过程组打磨批并行施工
 * 延后，已于 2026-11-06 合并收口落地（组根 grow + .groupEnter 补
 * animation-delay 消费 --reveal-delay)，下述断言已升级为检查
 * variant: 'grow'。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const CHANNEL_IMPORT = "from '../motion/useEntranceReveal'";

describe('统一入场通道守卫', () => {
  it('共享呈现类 .crish-entrance-fade 存在且只引用 crish-row-enter', () => {
    const css = read('styles/design-system.css');
    expect(css).toContain('.crish-entrance-fade');
    expect(css).toContain('@keyframes crish-row-enter');
  });

  it('通道钩子复用 AN4 判定核心（单轨），不另起判定', () => {
    const hook = read('components/motion/useEntranceReveal.ts');
    expect(hook).toContain("from '../chat-tool-call/toolRevealState'");
    expect(hook).toContain('decideEntrance');
  });

  it('入场钩子在退场接管时让位（S4：data-exiting 三处守卫）', () => {
    const hook = read('components/motion/useEntranceReveal.ts');
    const guards = hook.match(/dataset\.exiting === 'true'/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
    const exitHook = read('components/motion/useExitReveal.ts');
    expect(exitHook).toContain("el.dataset.exiting = 'true'");
  });

  it('AN4 旧钩子文件只剩 re-export 垫片（无第二份实现）', () => {
    const shim = read('components/chat-tool-call/useRevealEntrance.ts');
    expect(shim).toContain('useEntranceReveal as useRevealEntrance');
    expect(shim).not.toContain('claimEntranceDelay(');
    expect(shim).not.toContain('useLayoutEffect');
  });

  it.each([
    'components/chat-message-row/InFlowStatusLine.tsx',
    'components/chat-message-row/WorkingStatusIndicator.tsx',
    'components/chat-message-row/ReasoningRow.tsx',
    'components/chat-card/ComposerErrorBar.tsx',
    'components/chat-card/ApprovalDock.tsx',
    'components/agent-card/ApprovalAskCard.tsx',
    'components/chat-message/ContextStateNotice.tsx',
    'components/chat-message/ProcessItemRenderer.tsx',
    'components/chat-message-list/ScheduledTaskExecutionCard.tsx',
  ])('接入面 %s import 统一通道', (rel) => {
    expect(read(rel)).toContain(CHANNEL_IMPORT);
  });

  it('工具组经 AN4 垫片走通道核心（grow 变体）', () => {
    const group = read('components/chat-tool-call/FoldableToolGroup.tsx');
    expect(group).toContain('useRevealEntrance');
    expect(group).toContain("variant: 'grow'");
  });

  it('私有入场 keyframes 不复活（errorBarIn / chipFadeIn）', () => {
    expect(read('components/chat-card/ComposerErrorBar.module.css')).not.toContain(
      'errorBarIn'
    );
    const ribbons = read('components/chat-card/ChatStatusRibbons.module.css');
    expect(ribbons).not.toContain('chipFadeIn');
    expect(ribbons).toContain('crish-row-enter');
  });

  it('停止钮 CSS-only 消费共享 keyframes', () => {
    expect(
      read('components/chat-composer/ComposerSendControls.module.css')
    ).toContain('crish-fade-in');
  });
});
