// @vitest-environment jsdom
/**
 * ChatToolStack 结构稳定性契约（方案 B · 审批快完成竞态）：
 * single→group 结构翻转时，行不重挂、退场走完。
 *
 * 背景：审批工具的 groupId 迟到——approval-requested 事件不带分组身份，
 * 工具以 kind:'single' 落库并挂载审批卡；用户批准后 tool-start 带回
 * groupId，投影层改判 kind:'group'，行外包一层 grp 容器 div，旧
 * CompactToolRow 实例被卸载，S4 退场宿主（useClosingFlag，200ms 窗）
 * 随实例死亡，卡片在退场中途脱离 DOM（诊断报告
 * ~/workspace/approval-card-design-20261106/快完成竞态诊断.md，C2
 * 复现：closing 起 5.4ms、detach 与 remount 同刻 60.3ms）。
 *
 * 契约（方案 B → B-STRUCT-04 逐行包装展平）：每行包一层 .toolGroup
 * div，该 div 本身就是 .toolStack 的直接子级，key 只取行 id（两形态同
 * 源）；组容器 div 不再渲染。翻转只改变包装的 props（data-group-id 由
 * 无到有），不改变行在树中的父级与 key。组头不在此渲染（UX-03：组头由
 * 外层 FoldableToolGroup 统一渲染），故 .toolStack 子级数在单工具组首
 * 翻转前后恒为 1。
 *
 * 用例来源：诊断批复现台（竞态诊断-work/diag_approval_race.test.tsx）
 * 的 B2/C2 观测版改写为常驻断言——C2 场景在 B 落地后应与 B2 同口径
 * 走完宿主窗（detach−closing ≥170ms、无重挂）。时序用例沿用诊断台的
 * 真实链（MessageToolCallsSection → FoldableToolGroup → ChatToolStack
 * → CompactToolRow → ApprovalAskCard）+ 真实 buildToolRenderItems。
 *
 * B-STRUCT-04（非首工具并入既有组）已由逐行包装展平修复（2026-11-07，
 * 提交见施工 B04 报告）：04a 结构级手工构造 items（双树有效）、04b
 * 投影级保留 buildToolRenderItems 探针写法（仅 groupId 成组树有效，
 * 即当前工作树）、04c 时序级沿 02 台架。B 的段包装 key 机制
 * （toolStackSegmentKey）已随展平删除。
 *
 * 双树兼容（2026-11-07 00:27 第三轮验证确认）：投影层分组裁决正在他线
 * 重构中（工作树按 groupId 成组、HEAD 按并行/inspect 成组，签名亦由
 * 一参改为可选二参），故 B-STRUCT-01 手工构造 items、时序台架单参调
 * 用投影——本文件在 HEAD 树与工作树下均可编、均可绿；B-STRUCT-02
 * 在 HEAD 树下因无 groupId 成组而不触发翻转（按正常退场通过），在
 * 工作树下真实翻转。投影分组规则本身由 toolRenderItems.test.ts 覆盖。
 */
import React, { useMemo, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MessageToolCallsSection } from '../chat-message-row/MessageToolCallsSection';
import { buildToolRenderItems } from '../../api/toolPresentation';
import type { ToolRenderItem } from '../../api/toolPresentation';
import {
  ChatToolStack,
  type ChatToolStackSharedProps,
} from './ChatToolCallBlock';
import type { MessageToolCall } from '../../store/types';

/* ── 台架（改写自诊断复现台） ─────────────────────────────────── */

function makeTc(partial: Partial<MessageToolCall>): MessageToolCall {
  return {
    id: 'tool-x',
    name: 'write_file',
    status: 'pending_approval',
    arguments: JSON.stringify({ path: 'reference/probe.txt', content: 'x' }),
    intent: '写入探针文件',
    startedAt: Date.now(),
    ...partial,
  } as MessageToolCall;
}

interface Ctl {
  setTools: (t: MessageToolCall[]) => void;
  setBusy: (v: boolean) => void;
  setPendingMsg: (v: string | undefined) => void;
  allowCalls: number;
}

function Harness({
  ctl,
  sessionId,
  initial,
}: {
  ctl: React.MutableRefObject<Ctl | null>;
  sessionId: string;
  initial: MessageToolCall[];
}) {
  const [tools, setTools] = useState<MessageToolCall[]>(initial);
  const [busy, setBusy] = useState(false);
  const [pendingMsg, setPendingMsg] = useState<string | undefined>('m1');
  const allowRef = useRef(0);

  // 单参调用：投影层第二参 options 可省（工作树默认值 isTurnLive 按
  // running 推导、isFollowedByNonTool=false）；单参在 HEAD 的一参签名
  // 下同样合法，本文件因此双树可编。
  const items = useMemo(() => buildToolRenderItems(tools), [tools]);

  const toolStackProps: ChatToolStackSharedProps = useMemo(
    () => ({
      agents: [],
      activeSessionId: sessionId,
      expandedTools: {},
      onToggleTool: () => {},
      approvalBusy: busy,
      pendingApprovalMsgId: pendingMsg,
      actions: {
        // 模拟 useChatApprovalExecutor 的乐观写：决策即把 base 状态
        // 翻为 running（关闭由此开始），引擎稍后才回完成事件。
        onApprovalAllow: () => {
          allowRef.current += 1;
          setBusy(true);
          setTools((prev) =>
            prev.map((t) =>
              t.status === 'pending_approval'
                ? { ...t, status: 'running', output: '执行中…' }
                : t
            )
          );
        },
        onApprovalDeny: () => {},
      },
    }),
    [sessionId, busy, pendingMsg]
  );

  ctl.current = {
    setTools,
    setBusy,
    setPendingMsg,
    allowCalls: allowRef.current,
  };

  return (
    <MessageToolCallsSection
      items={items}
      msgId="m1"
      toolStackProps={toolStackProps}
    />
  );
}

/* ── 采样 ───────────────────────────────────────────────────────── */

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

function findCard(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-msg="m1"]');
}

function clickAllow(container: HTMLElement) {
  const card = findCard(container);
  if (!card) throw new Error('card not mounted before click');
  const buttons = Array.from(card.querySelectorAll('button'));
  const allowBtn =
    buttons.find((b) => /允许|allow/i.test(b.textContent || '')) ||
    buttons[0];
  if (!allowBtn) throw new Error('no button in card');
  fireEvent.click(allowBtn);
}

const RUNNING_TO_SUCCESS = (
  ctl: Ctl,
  base: MessageToolCall[],
  extra?: Partial<MessageToolCall>
) => {
  ctl.setTools(
    base.map((t) => ({
      ...t,
      status: 'success',
      output: 'probe-ok',
      ...(extra || {}),
    }))
  );
  ctl.setBusy(false);
  ctl.setPendingMsg(undefined);
};

interface ObsTrace {
  allowCalls: number;
  closingStartMs: number | null;
  detachMs: number | null;
  remountMs: number | null;
}

/**
 * 观测版时序（改写自诊断台 runObserved）：渲染 pending → 等卡挂载 →
 * 点击允许（关闭开始，t=0）→ +30ms 施加完成突变 → 观测 600ms。
 * 健康口径：detach − closing ≥170ms（宿主 200ms 窗跑满），且无重挂。
 */
async function runObserved(opts: {
  sessionId: string;
  initial: MessageToolCall[];
  complete: (ctl: Ctl, base: MessageToolCall[]) => void;
}): Promise<ObsTrace> {
  const ctl: React.MutableRefObject<Ctl | null> = { current: null };
  const { container } = render(
    <Harness ctl={ctl} sessionId={opts.sessionId} initial={opts.initial} />
  );
  for (let i = 0; i < 50 && !findCard(container); i++) await sleep(10);
  const card0 = findCard(container);
  if (!card0) throw new Error('card not mounted');
  await sleep(30);

  let t0 = 0;
  let closingStartMs: number | null = null;
  let detachMs: number | null = null;
  let remountMs: number | null = null;
  const mo = new MutationObserver(() => {
    const now = performance.now() - t0;
    const node = findCard(container);
    if (
      closingStartMs === null &&
      card0.isConnected &&
      (card0.getAttribute('data-exiting') === 'true' ||
        (card0.className || '').includes('crish-exit-fade'))
    ) {
      closingStartMs = now;
    }
    if (detachMs === null && !card0.isConnected) {
      detachMs = now;
    }
    if (detachMs !== null && remountMs === null && node && node !== card0) {
      remountMs = now;
    }
  });
  mo.observe(container, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-exiting', 'class'],
  });

  t0 = performance.now();
  clickAllow(container);
  await sleep(30);
  const allowCalls = ctl.current ? ctl.current.allowCalls : -1;
  act(() => {
    opts.complete(ctl.current!, opts.initial);
  });
  await sleep(600);
  mo.disconnect();
  return { allowCalls, closingStartMs, detachMs, remountMs };
}

function stackProps() {
  return {
    agents: [],
    activeSessionId: 's1',
    expandedTools: {},
    onToggleTool: vi.fn(),
    approvalBusy: false,
    pendingApprovalMsgId: 'm1' as string | undefined,
    actions: {
      onApprovalAllow: vi.fn(),
      onApprovalDeny: vi.fn(),
    },
  };
}

/* ── 契约 ───────────────────────────────────────────────────────── */

describe('ChatToolStack 结构稳定性契约（方案 B）', () => {
  afterEach(() => {
    cleanup();
  });

  it('B-STRUCT-01 single→group 翻转：行节点与包装 div 均为同一 DOM 节点', () => {
    const tc0 = makeTc({ id: 'tool-x', status: 'success', output: 'ok' });
    // 手工构造两形态 items（不经过投影层）：投影层的分组裁决正在他线
    // 重构中——工作树按 groupId 成组（组 id=`grp-${groupId}`），HEAD 按
    // 并行/inspect 成组（组 id=`grp-${首工具 id}`）——同一翻转在两树下
    // 投影输出不同；本用例钉的是组件层 key 行为，与投影规则无关，故直
    // 接构造。投影分组本身由 toolRenderItems.test.ts 覆盖。
    const itemsSingle: ToolRenderItem[] = [{ kind: 'single', tc: tc0 }];
    const props = stackProps();
    const { container, rerender } = render(
      <ChatToolStack items={itemsSingle} msgId="m1" {...props} />
    );
    const row0 = container.querySelector('[data-tool-id="tool-x"]');
    const wrapper0 = row0?.parentElement;
    expect(row0).not.toBeNull();
    // single 同样包一层与 group 同型的 .toolGroup 容器，但无组身份：
    expect(wrapper0?.className).toContain('toolGroup');
    expect(wrapper0?.getAttribute('data-group-id')).toBeNull();
    expect(wrapper0?.getAttribute('data-expanded')).toBe('true');
    // 展平后 .toolStack 子级恒为逐行包装：组头不在此渲染（UX-03：组头由
    // 外层 FoldableToolGroup 统一渲染），单工具组翻转前后子级数恒为 1。
    expect(container.querySelector('.tool-stack')?.children.length).toBe(1);

    const itemsGroup: ToolRenderItem[] = [
      {
        kind: 'group',
        id: 'grp-tool-x',
        tools: [{ ...tc0, groupId: 'grp-late', group: '写入' }],
        label: '写入',
      },
    ];
    rerender(<ChatToolStack items={itemsGroup} msgId="m1" {...props} />);
    const row1 = container.querySelector('[data-tool-id="tool-x"]');
    const wrapper1 = row1?.parentElement;
    // 翻转只换内容、不换行在树中的位置：行与包装均为同一节点：
    expect(row1).toBe(row0);
    expect(wrapper1).toBe(wrapper0);
    expect(wrapper1?.getAttribute('data-group-id')).toBe('grp-tool-x');
    expect(container.querySelector('.tool-stack')?.children.length).toBe(1);
  });

  it('B-STRUCT-02 快完成 · groupId 迟到（C2 场景）：退场走完宿主窗、无重挂', async () => {
    const tr = await runObserved({
      sessionId: 'sess-b-struct-c2',
      initial: [makeTc({ id: 'tool-c2' })],
      complete: (ctl, base) =>
        RUNNING_TO_SUCCESS(ctl, base, { groupId: 'grp-late', group: '写入' }),
    });
    expect(tr.allowCalls).toBe(1);
    expect(tr.closingStartMs).not.toBeNull();
    expect(tr.detachMs).not.toBeNull();
    expect(tr.detachMs! - tr.closingStartMs!).toBeGreaterThanOrEqual(170);
    expect(tr.remountMs).toBeNull();
  }, 20000);

  it('B-STRUCT-03 快完成 · 仅状态突变（B2 对照）：退场走完宿主窗、无重挂', async () => {
    const tr = await runObserved({
      sessionId: 'sess-b-struct-b2',
      initial: [makeTc({ id: 'tool-b2' })],
      complete: (ctl, base) => RUNNING_TO_SUCCESS(ctl, base),
    });
    expect(tr.allowCalls).toBe(1);
    expect(tr.closingStartMs).not.toBeNull();
    expect(tr.detachMs).not.toBeNull();
    expect(tr.detachMs! - tr.closingStartMs!).toBeGreaterThanOrEqual(170);
    expect(tr.remountMs).toBeNull();
  }, 20000);

  // B-STRUCT-04（2026-11-07 逐行包装展平修复；原 it.skip 已恢复）：
  // 非首工具 A 并入既有组 [B, A] 时，行包装 key 只取行 id（grp-tool-a），
  // 不再派生自组首工具 id，翻转仅给 A 的包装加上 data-group-id，行与包
  // 装均为同一节点。04a 结构级手工构造 items（不经过投影层，双树有效，
  // 主回归钉）；04b 投影级保留 buildToolRenderItems 探针写法——仅
  // groupId 成组树（当前工作树）有效，HEAD 树下 kind 不随 groupId 翻转，
  // 前提断言不成立；04c 时序级沿 02 台架，初始 [B running 带 groupId，
  // A pending]，complete 为 A 获 groupId + success。
  it('B-STRUCT-04a 组内非首工具并入既有组：行与逐行包装均为同一节点（结构级）', () => {
    const b = makeTc({
      id: 'tool-b',
      status: 'running',
      groupId: 'grp-g',
      group: '写入',
    });
    const a = makeTc({ id: 'tool-a', status: 'pending_approval' });
    // 手工构造两形态 items（不经过投影层，仿 B-STRUCT-01）：组 id 取
    // `grp-${groupId}`，与工作树投影的 flushGroup 口径一致。
    const items0: ToolRenderItem[] = [
      { kind: 'group', id: 'grp-grp-g', label: '写入', tools: [b] },
      { kind: 'single', tc: a },
    ];
    const props = stackProps();
    const { container, rerender } = render(
      <ChatToolStack items={items0} msgId="m1" {...props} />
    );
    const rowA0 = container.querySelector('[data-tool-id="tool-a"]');
    const wrapperA0 = rowA0?.parentElement;
    expect(rowA0).not.toBeNull();
    expect(wrapperA0?.className).toContain('toolGroup');
    expect(wrapperA0?.getAttribute('data-group-id')).toBeNull();
    expect(container.querySelector('.tool-stack')?.children.length).toBe(2);

    const a1 = { ...a, status: 'running' as const, groupId: 'grp-g', group: '写入' };
    const items1: ToolRenderItem[] = [
      { kind: 'group', id: 'grp-grp-g', label: '写入', tools: [b, a1] },
    ];
    rerender(<ChatToolStack items={items1} msgId="m1" {...props} />);
    const rowA1 = container.querySelector('[data-tool-id="tool-a"]');
    const wrapperA1 = rowA1?.parentElement;
    // 翻转前后 .toolStack 子级逐 key 同一：行与包装均为同一节点，仅
    // 包装的 data-group-id 由无到有。
    expect(rowA1).toBe(rowA0);
    expect(wrapperA1).toBe(wrapperA0);
    expect(wrapperA1?.getAttribute('data-group-id')).toBe('grp-grp-g');
    expect(container.querySelector('.tool-stack')?.children.length).toBe(2);
    const order = [...container.querySelectorAll('.tool-stack .tool-row')].map(
      (el) => el.getAttribute('data-tool-id')
    );
    // 注：不能用 '.tool-stack [data-tool-id]'——ApprovalAskCard 根节点也带
    // 同名属性（退场窗内仍挂载），每行会命中两次；.tool-row 每行恰一个。
    expect(order).toEqual(['tool-b', 'tool-a']);
  });

  it('B-STRUCT-04b 组内非首工具并入既有组：行与逐行包装均为同一节点（投影级，仅 groupId 成组树有效）', () => {
    // 探针：时间线上先行的同组工具 B 已带 groupId（已执行），待审批的
    // 后行工具 A 在批准后才带回 groupId 并入同一组——此时 A 不是组首。
    const b = makeTc({
      id: 'tool-b',
      status: 'running',
      groupId: 'grp-g',
      group: '写入',
    });
    const a = makeTc({ id: 'tool-a', status: 'pending_approval' });
    const items0 = buildToolRenderItems([b, a]);
    expect(items0.map((i) => i.kind)).toEqual(['group', 'single']);
    const props = stackProps();
    const { container, rerender } = render(
      <ChatToolStack items={items0} msgId="m1" {...props} />
    );
    const rowA0 = container.querySelector('[data-tool-id="tool-a"]');
    const wrapperA0 = rowA0?.parentElement;
    expect(rowA0).not.toBeNull();
    expect(wrapperA0?.getAttribute('data-group-id')).toBeNull();

    const a1 = { ...a, status: 'running' as const, groupId: 'grp-g', group: '写入' };
    const items1 = buildToolRenderItems([b, a1]);
    expect(items1.map((i) => i.kind)).toEqual(['group']);
    rerender(<ChatToolStack items={items1} msgId="m1" {...props} />);
    const rowA1 = container.querySelector('[data-tool-id="tool-a"]');
    const wrapperA1 = rowA1?.parentElement;
    expect(rowA1).toBe(rowA0);
    expect(wrapperA1).toBe(wrapperA0);
    expect(wrapperA1?.getAttribute('data-group-id')).toBe('grp-grp-g');
  });

  it('B-STRUCT-04c 组内非首工具并入既有组：退场走完宿主窗、无重挂（时序级）', async () => {
    const tr = await runObserved({
      sessionId: 'sess-b-struct-04c',
      initial: [
        makeTc({
          id: 'tool-b',
          status: 'running',
          groupId: 'grp-g',
          group: '写入',
        }),
        makeTc({ id: 'tool-a', status: 'pending_approval' }),
      ],
      // 批准后 30ms：A 获 groupId 并入 [B, A] 组并完成——翻转发生在
      // A 的 200ms 退场窗内，行与包装须为同一节点，宿主窗跑满。
      complete: (ctl, base) =>
        RUNNING_TO_SUCCESS(ctl, base, { groupId: 'grp-g', group: '写入' }),
    });
    expect(tr.allowCalls).toBe(1);
    expect(tr.closingStartMs).not.toBeNull();
    expect(tr.detachMs).not.toBeNull();
    expect(tr.detachMs! - tr.closingStartMs!).toBeGreaterThanOrEqual(170);
    expect(tr.remountMs).toBeNull();
  }, 20000);
});
