import { describe, expect, it } from 'vitest';
import {
  allowButtonLabel,
  approvalCardClassName,
  approvalDockLabel,
  approvalRenderMode,
  assertApprovalUiNoDoubleRender,
  buildApprovalRiskChips,
  clampApprovalCounts,
  collectPendingApprovals,
  isSingleMainTimelineApproval,
  nextAllowConfirmPhase,
  plainApprovalQuestion,
  planApprovalUi,
  resolveApprovalDockVisible,
  shouldResetAllowConfirmArmed,
  shouldShowApprovalDock,
  totalPendingApproval,
} from './chatApprovalUi';

describe('shouldShowApprovalDock / approvalRenderMode', () => {
  it('hides dock when no pending', () => {
    expect(shouldShowApprovalDock({ mainCount: 0, agentCount: 0 })).toBe(false);
    expect(approvalRenderMode({ mainCount: 0, agentCount: 0 })).toBe('none');
  });

  it('hides dock for single main timeline pending (inline card only — no double render)', () => {
    expect(shouldShowApprovalDock({ mainCount: 1, agentCount: 0 })).toBe(false);
    expect(resolveApprovalDockVisible({ mainCount: 1, agentCount: 0 })).toBe(false);
    expect(isSingleMainTimelineApproval({ mainCount: 1, agentCount: 0 })).toBe(true);
    expect(approvalRenderMode({ mainCount: 1, agentCount: 0 })).toBe('inline-only');
  });

  it('shows dock for multiple main pending (queue)', () => {
    expect(shouldShowApprovalDock({ mainCount: 2, agentCount: 0 })).toBe(true);
    expect(resolveApprovalDockVisible({ mainCount: 2, agentCount: 0 })).toBe(true);
    expect(approvalRenderMode({ mainCount: 2, agentCount: 0 })).toBe('dock');
  });

  it('shows dock when agent has pending even if main is 0 or 1', () => {
    expect(shouldShowApprovalDock({ mainCount: 0, agentCount: 1 })).toBe(true);
    expect(shouldShowApprovalDock({ mainCount: 1, agentCount: 1 })).toBe(true);
    expect(resolveApprovalDockVisible({ mainCount: 0, agentCount: 1 })).toBe(true);
    expect(resolveApprovalDockVisible({ mainCount: 1, agentCount: 1 })).toBe(true);
    expect(approvalRenderMode({ mainCount: 0, agentCount: 1 })).toBe('dock');
  });

  it('resolveApprovalDockVisible forces off for single main even if counts look odd', () => {
    // 与 shouldShow 一致：单条主列永远不挂 dock（防双份）
    expect(resolveApprovalDockVisible({ mainCount: 1, agentCount: 0 })).toBe(false);
    expect(resolveApprovalDockVisible({ mainCount: 1.2, agentCount: 0 })).toBe(false);
    expect(resolveApprovalDockVisible({ mainCount: 0, agentCount: 0 })).toBe(false);
  });

  it('clamps negative / NaN / Infinity counts so dock never false-positive double-render', () => {
    expect(clampApprovalCounts({ mainCount: -1, agentCount: Number.NaN })).toEqual({
      mainCount: 0,
      agentCount: 0,
    });
    expect(clampApprovalCounts({ mainCount: Number.POSITIVE_INFINITY, agentCount: -0.5 })).toEqual({
      mainCount: 0,
      agentCount: 0,
    });
    expect(shouldShowApprovalDock({ mainCount: -3, agentCount: 0 })).toBe(false);
    expect(approvalRenderMode({ mainCount: 1.9, agentCount: 0 })).toBe('inline-only');
    expect(resolveApprovalDockVisible({ mainCount: Number.POSITIVE_INFINITY, agentCount: 0 })).toBe(
      false,
    );
  });

  it('invariant: inline-only never shows dock', () => {
    const cases = [
      { mainCount: 0, agentCount: 0 },
      { mainCount: 1, agentCount: 0 },
      { mainCount: 2, agentCount: 0 },
      { mainCount: 0, agentCount: 1 },
      { mainCount: 1, agentCount: 2 },
      { mainCount: -1, agentCount: 5 },
      { mainCount: 3, agentCount: 3 },
      { mainCount: Number.NaN, agentCount: 1 },
    ];
    for (const c of cases) {
      expect(assertApprovalUiNoDoubleRender(c)).toBe(true);
      if (isSingleMainTimelineApproval(c)) {
        expect(shouldShowApprovalDock(c)).toBe(false);
        expect(resolveApprovalDockVisible(c)).toBe(false);
        expect(planApprovalUi(c).showDock).toBe(false);
      }
    }
  });
});

describe('planApprovalUi', () => {
  it('none: no dock, not inline-only', () => {
    expect(planApprovalUi({ mainCount: 0, agentCount: 0 })).toEqual({
      mode: 'none',
      showDock: false,
      inlineOnly: false,
      total: 0,
      mainCount: 0,
      agentCount: 0,
    });
  });

  it('single main → inlineOnly + showDock false (no double dock)', () => {
    const plan = planApprovalUi({ mainCount: 1, agentCount: 0 });
    expect(plan.mode).toBe('inline-only');
    expect(plan.inlineOnly).toBe(true);
    expect(plan.showDock).toBe(false);
    expect(plan.total).toBe(1);
  });

  it('queue / agent → dock', () => {
    expect(planApprovalUi({ mainCount: 2, agentCount: 0 }).showDock).toBe(true);
    expect(planApprovalUi({ mainCount: 0, agentCount: 2 }).mode).toBe('dock');
    expect(planApprovalUi({ mainCount: 1, agentCount: 1 }).inlineOnly).toBe(false);
  });
});

describe('collectPendingApprovals', () => {
  it('dedupes same toolId across messages (no double count)', () => {
    const { counts, uniqueToolIds, first } = collectPendingApprovals(
      [
        {
          id: 'm1',
          toolCalls: [
            { id: 'tc-1', status: 'pending_approval', name: 'edit' },
            { id: 'tc-1', status: 'pending_approval', name: 'edit' },
          ],
        },
        {
          id: 'm2',
          toolCalls: [{ id: 'tc-1', status: 'pending_approval', name: 'edit' }],
        },
      ],
      [],
    );
    expect(counts).toEqual({ mainCount: 1, agentCount: 0 });
    expect(uniqueToolIds).toEqual(['tc-1']);
    expect(first?.msgId).toBe('m1');
    expect(shouldShowApprovalDock(counts)).toBe(false);
    expect(approvalRenderMode(counts)).toBe('inline-only');
  });

  it('counts distinct main + agent tools', () => {
    const { counts } = collectPendingApprovals(
      [{ id: 'm1', toolCalls: [{ id: 'a', status: 'pending_approval' }] }],
      [[{ id: 'ag1', toolCalls: [{ id: 'b', status: 'pending_approval' }] }]],
    );
    expect(counts).toEqual({ mainCount: 1, agentCount: 1 });
    expect(shouldShowApprovalDock(counts)).toBe(true);
  });

  it('prefers main bucket when same toolId appears in agent (no double count / no double render)', () => {
    const { counts, first, uniqueToolIds } = collectPendingApprovals(
      [
        {
          id: 'm1',
          toolCalls: [{ id: 'shared', status: 'pending_approval', name: 'shell' }],
        },
      ],
      [
        [
          {
            id: 'ag1',
            toolCalls: [{ id: 'shared', status: 'pending_approval', name: 'shell' }],
          },
        ],
      ],
    );
    expect(counts).toEqual({ mainCount: 1, agentCount: 0 });
    expect(uniqueToolIds).toEqual(['shared']);
    expect(first?.bucket).toBe('main');
    // 单条主列 → 仅内联，禁止 dock
    expect(shouldShowApprovalDock(counts)).toBe(false);
    expect(assertApprovalUiNoDoubleRender(counts)).toBe(true);
  });

  it('skips empty / whitespace tool ids', () => {
    const { counts, uniqueToolIds } = collectPendingApprovals(
      [
        {
          id: 'm1',
          toolCalls: [
            { id: '  ', status: 'pending_approval' },
            { id: '', status: 'pending_approval' },
            { id: 'real', status: 'pending_approval' },
          ],
        },
      ],
      [],
    );
    expect(counts.mainCount).toBe(1);
    expect(uniqueToolIds).toEqual(['real']);
  });

  it('ignores non-pending statuses', () => {
    const { counts } = collectPendingApprovals(
      [
        {
          id: 'm1',
          toolCalls: [
            { id: 'a', status: 'running' },
            { id: 'b', status: 'success' },
            { id: 'c', status: 'pending_approval' },
          ],
        },
      ],
      [],
    );
    expect(counts).toEqual({ mainCount: 1, agentCount: 0 });
  });

  it('tolerates null/undefined messages, toolCalls, and agent lists (stream half-packets)', () => {
    const { counts, uniqueToolIds, first } = collectPendingApprovals(
      [
        null,
        undefined,
        { id: 'm1', toolCalls: null },
        {
          id: 'm2',
          toolCalls: [
            null,
            undefined,
            { id: 'ok', status: 'pending_approval', explanation: '跑一下' },
          ],
        },
      ],
      [null, undefined, []],
    );
    expect(counts).toEqual({ mainCount: 1, agentCount: 0 });
    expect(uniqueToolIds).toEqual(['ok']);
    expect(first?.summary).toBe('跑一下');
    expect(resolveApprovalDockVisible(counts)).toBe(false);
  });

  it('null mainMessages / agentLists → empty scan', () => {
    expect(collectPendingApprovals(null, null).counts).toEqual({
      mainCount: 0,
      agentCount: 0,
    });
    expect(collectPendingApprovals(undefined).first).toBeNull();
  });

  it('falls back msgId to toolId when message id missing', () => {
    const { first } = collectPendingApprovals(
      [{ toolCalls: [{ id: 'tc-x', status: 'pending_approval' }] }],
      [],
    );
    expect(first?.msgId).toBe('tc-x');
    expect(first?.toolId).toBe('tc-x');
  });

  it('multi-agent lists accumulate distinct agent pending', () => {
    const { counts, uniqueToolIds } = collectPendingApprovals(
      [],
      [
        [{ id: 'a1', toolCalls: [{ id: 't1', status: 'pending_approval' }] }],
        [{ id: 'a2', toolCalls: [{ id: 't2', status: 'pending_approval' }] }],
      ],
    );
    expect(counts).toEqual({ mainCount: 0, agentCount: 2 });
    expect(uniqueToolIds).toEqual(['t1', 't2']);
    expect(planApprovalUi(counts).showDock).toBe(true);
  });
});

describe('totalPendingApproval', () => {
  it('sums main + agent', () => {
    expect(totalPendingApproval({ mainCount: 2, agentCount: 3 })).toBe(5);
  });

  it('clamps before sum', () => {
    expect(totalPendingApproval({ mainCount: -2, agentCount: 3 })).toBe(3);
  });
});

describe('approvalDockLabel', () => {
  it('returns empty when none', () => {
    expect(approvalDockLabel({ mainCount: 0, agentCount: 0 })).toBe('');
  });

  it('marks agent-only as 协作任务', () => {
    expect(approvalDockLabel({ mainCount: 0, agentCount: 1 }, '运行命令')).toBe(
      '1 待审批 · 协作任务 · 运行命令',
    );
  });

  it('marks multi-main as 队列', () => {
    expect(approvalDockLabel({ mainCount: 3, agentCount: 0 }, '写文件')).toBe(
      '3 待审批 · 队列 · 写文件',
    );
  });

  it('marks mixed main+agent as 队列', () => {
    expect(approvalDockLabel({ mainCount: 1, agentCount: 2 }, 'shell')).toBe(
      '3 待审批 · 队列 · shell',
    );
  });

  it('omits empty summary segment', () => {
    expect(approvalDockLabel({ mainCount: 2, agentCount: 0 }, '  ')).toBe(
      '2 待审批 · 队列',
    );
  });

  it('single main without summary is bare count (dock hidden by shouldShow)', () => {
    expect(approvalDockLabel({ mainCount: 1, agentCount: 0 })).toBe('1 待审批');
  });
});

describe('nextAllowConfirmPhase / allowButtonLabel (二次确认)', () => {
  it('commits immediately when double-confirm not required', () => {
    expect(nextAllowConfirmPhase(false, false)).toBe('commit');
    expect(nextAllowConfirmPhase(false, true)).toBe('commit');
  });

  it('arms first then commits when double-confirm required', () => {
    expect(nextAllowConfirmPhase(true, false)).toBe('armed');
    expect(nextAllowConfirmPhase(true, true)).toBe('commit');
  });

  it('labels match arm / commit states', () => {
    expect(allowButtonLabel(false, false, false)).toBe('允许');
    expect(allowButtonLabel(false, false, true)).toBe('允许并记住');
    expect(allowButtonLabel(true, false, false)).toBe('允许…');
    expect(allowButtonLabel(true, false, true)).toBe('记住并准备允许');
    expect(allowButtonLabel(true, true, false)).toBe('再次确认允许');
    expect(allowButtonLabel(true, true, true)).toBe('再次确认并记住');
  });
});

describe('shouldResetAllowConfirmArmed', () => {
  it('never resets when not armed', () => {
    expect(
      shouldResetAllowConfirmArmed({
        confirmArmed: false,
        needsDouble: true,
        prevToolId: 'a',
        nextToolId: 'b',
      }),
    ).toBe(false);
  });

  it('resets when needsDouble becomes false', () => {
    expect(
      shouldResetAllowConfirmArmed({
        confirmArmed: true,
        needsDouble: false,
        prevToolId: 'a',
        nextToolId: 'a',
      }),
    ).toBe(true);
  });

  it('resets when toolId switches', () => {
    expect(
      shouldResetAllowConfirmArmed({
        confirmArmed: true,
        needsDouble: true,
        prevToolId: 'tc-1',
        nextToolId: 'tc-2',
      }),
    ).toBe(true);
  });

  it('keeps armed for same tool + still needs double', () => {
    expect(
      shouldResetAllowConfirmArmed({
        confirmArmed: true,
        needsDouble: true,
        prevToolId: 'tc-1',
        nextToolId: 'tc-1',
      }),
    ).toBe(false);
  });
});

describe('plainApprovalQuestion', () => {
  it('keeps already-phrased Chinese questions', () => {
    expect(plainApprovalQuestion('是否允许删除缓存？')).toBe('是否允许删除缓存？');
  });

  it('wraps Chinese action summary', () => {
    expect(plainApprovalQuestion('正在修改登录页')).toBe('是否允许：修改登录页？');
  });

  it('classifies read / write / delete / git / package heuristics', () => {
    expect(plainApprovalQuestion('read package.json')).toBe('是否允许查看相关文件或信息？');
    expect(plainApprovalQuestion('edit App.tsx')).toBe('是否允许修改项目中的文件？');
    expect(plainApprovalQuestion('rm -rf dist', 'rm -rf dist')).toBe(
      '是否允许删除文件或执行有风险的清理？',
    );
    expect(plainApprovalQuestion('Git commit', 'git commit -m x')).toBe(
      '是否允许执行 Git 相关操作？',
    );
    expect(plainApprovalQuestion('install', 'npm install lodash')).toBe(
      '是否允许运行安装或构建类命令？',
    );
  });

  it('falls back to command / generic when no signal', () => {
    expect(plainApprovalQuestion('', 'some-binary --flag')).toBe(
      '是否允许运行下面这条命令？',
    );
    expect(plainApprovalQuestion('')).toBe('是否允许继续这项操作？');
  });
});

describe('buildApprovalRiskChips / approvalCardClassName (风险元数据)', () => {
  it('returns empty for null / empty meta', () => {
    expect(buildApprovalRiskChips(null)).toEqual([]);
    expect(buildApprovalRiskChips(undefined)).toEqual([]);
    expect(buildApprovalRiskChips({})).toEqual([]);
  });

  it('surfaces trustZone, risk, double-confirm and snapshot chips', () => {
    const chips = buildApprovalRiskChips({
      trustZone: 'T3',
      risk: 'destructive',
      riskLevel: 'high',
      requiresDoubleConfirm: true,
      recommendSnapshot: true,
    });
    const labels = chips.map((c) => c.label);
    expect(labels).toContain('T3');
    expect(labels).toContain('destructive');
    expect(labels).toContain('high');
    expect(labels).toContain('需二次确认');
    expect(labels).toContain('建议快照');
    expect(chips.find((c) => c.key === 'double')?.tone).toBe('danger');
  });

  it('T4 zone is danger tone; skips unknown level', () => {
    const chips = buildApprovalRiskChips({
      trustZone: 'T4',
      riskLevel: 'unknown',
    });
    expect(chips).toEqual([{ key: 'zone', label: 'T4', tone: 'danger' }]);
  });

  it('dedupes risk label against zone (case-insensitive)', () => {
    const chips = buildApprovalRiskChips({
      trustZone: 'T2',
      risk: 't2',
      riskLevel: 'medium',
    });
    // risk === zone → skip risk chip; level medium matches no existing label
    expect(chips.map((c) => c.key)).toEqual(['zone', 'level']);
  });

  it('approvalCardClassName joins elevated + armed', () => {
    expect(approvalCardClassName({})).toBe('approval-card');
    expect(approvalCardClassName({ needsDouble: true })).toBe(
      'approval-card approval-card--elevated',
    );
    expect(approvalCardClassName({ needsDouble: true, confirmArmed: true })).toBe(
      'approval-card approval-card--elevated is-confirm-armed',
    );
    expect(approvalCardClassName({ confirmArmed: true })).toBe(
      'approval-card is-confirm-armed',
    );
  });
});

describe('single main: no double dock (resolve + mode 联立)', () => {
  it('collect one main pending → inline-only and dock forced off', () => {
    const { counts } = collectPendingApprovals(
      [
        {
          id: 'm1',
          toolCalls: [{ id: 'only', status: 'pending_approval', name: 'shell' }],
        },
      ],
      [],
    );
    expect(counts).toEqual({ mainCount: 1, agentCount: 0 });
    expect(approvalRenderMode(counts)).toBe('inline-only');
    expect(shouldShowApprovalDock(counts)).toBe(false);
    expect(resolveApprovalDockVisible(counts)).toBe(false);
    expect(isSingleMainTimelineApproval(counts)).toBe(true);
    expect(assertApprovalUiNoDoubleRender(counts)).toBe(true);
    expect(planApprovalUi(counts).showDock).toBe(false);
    // 文案可生成，但 UI 不得挂 dock
    expect(approvalDockLabel(counts, 'shell')).toBe('1 待审批 · shell');
  });

  it('matrix: every count pair either dock XOR inline-only, never both', () => {
    const mains = [0, 1, 2, 3, -1, 1.7, Number.NaN];
    const agents = [0, 1, 2, -2, Number.POSITIVE_INFINITY];
    for (const mainCount of mains) {
      for (const agentCount of agents) {
        const c = { mainCount, agentCount };
        expect(assertApprovalUiNoDoubleRender(c)).toBe(true);
        const plan = planApprovalUi(c);
        // 单条主列：禁止 dock（双渲染）
        if (plan.mainCount === 1 && plan.agentCount === 0) {
          expect(plan.showDock).toBe(false);
          expect(plan.inlineOnly).toBe(true);
          expect(plan.mode).toBe('inline-only');
        }
        // dock 与 inlineOnly 互斥
        expect(plan.showDock && plan.inlineOnly).toBe(false);
        // mode=none ⇒ 全关
        if (plan.mode === 'none') {
          expect(plan.showDock).toBe(false);
          expect(plan.inlineOnly).toBe(false);
        }
      }
    }
  });

  it('duplicate main tool across stream rewrite still single inline (no double dock)', () => {
    const { counts } = collectPendingApprovals(
      [
        {
          id: 'm-stream-1',
          toolCalls: [{ id: 'shell-1', status: 'pending_approval', name: 'bash' }],
        },
        {
          id: 'm-stream-1b',
          toolCalls: [{ id: 'shell-1', status: 'pending_approval', name: 'bash' }],
        },
      ],
      [[{ id: 'ag', toolCalls: [{ id: 'shell-1', status: 'pending_approval' }] }]],
    );
    expect(counts).toEqual({ mainCount: 1, agentCount: 0 });
    expect(planApprovalUi(counts)).toMatchObject({
      mode: 'inline-only',
      showDock: false,
      inlineOnly: true,
      total: 1,
    });
  });
});
