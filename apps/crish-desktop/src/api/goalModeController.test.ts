import { describe, expect, it } from 'vitest';
import {
  appendGoalProgressMessage,
  applyGoalUpdate,
  buildGoalModePrefix,
  computeGoalTaskProgress,
  createActiveGoalLifecycle,
  createIdleGoalLifecycle,
  createInitialGoalMode,
  decideGoalContinuation,
  enterGoalMode,
  exitGoalMode,
  formatGoalProgressMessage,
  formatOpenGoalTasksForPrompt,
  goalLifecycleToSessionMode,
  goalStopAllowsToast,
  markAllGoalTasksDone,
  mergeGoalTasksFromAssistantText,
  parseChecklistTasks,
  pauseGoalMode,
  replyLooksGoalDone,
  resumeGoalMode,
  sessionModeToGoalLifecycle,
  transitionGoalLifecycle,
  validateGoalUpdateExclusivity,
  type GoalLifecycleEvent,
  type GoalLifecyclePhase,
  type GoalLifecycleState,
} from './goalModeController';
import type { SessionState } from '../store/types';

function session(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    title: 't',
    folder: 'general',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    messages: [],
    ...partial,
  };
}

function running(): GoalLifecycleState {
  return createActiveGoalLifecycle('ship feature', 5);
}

describe('goalModeController', () => {
  it('replyLooksGoalDone detects DONE markers', () => {
    expect(replyLooksGoalDone('all good DONE')).toBe(true);
    expect(replyLooksGoalDone('目标已完成。')).toBe(true);
    expect(replyLooksGoalDone('还在做')).toBe(false);
  });

  it('parseChecklistTasks reads markdown tasks', () => {
    const tasks = parseChecklistTasks('- [ ] one\n- [x] two\n* [ ] three');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].done).toBe(false);
    expect(tasks[1].done).toBe(true);
    expect(tasks[1].text).toBe('two');
  });

  it('parseChecklistTasks drops 本轮总结 noise (TasksCard aligned)', () => {
    const tasks = parseChecklistTasks(
      '- [ ] 实现工具行\n- [x] 本轮总结：已完成若干命令\n- [ ] 写测试',
    );
    expect(tasks.map((t) => t.text)).toEqual(['实现工具行', '写测试']);
  });

  it('computeGoalTaskProgress matches TasksCard math', () => {
    expect(computeGoalTaskProgress([])).toEqual({ total: 0, done: 0, pct: 0 });
    expect(
      computeGoalTaskProgress([
        { id: '1', text: 'a', done: true },
        { id: '2', text: 'b', done: false },
        { id: '3', text: 'c', done: true },
      ]),
    ).toEqual({ total: 3, done: 2, pct: 67 });
  });

  it('decideGoalContinuation stops when cancelled or inactive', () => {
    expect(
      decideGoalContinuation({
        cancelled: true,
        session: session({ id: 's', goalMode: createInitialGoalMode('g') }),
        assistantText: 'x',
      }).action,
    ).toBe('stop');
    const inactive = decideGoalContinuation({
      cancelled: false,
      session: session({ id: 's' }),
      assistantText: 'x',
    });
    expect(inactive.action).toBe('stop');
    if (inactive.action === 'stop') expect(inactive.reason).toBe('inactive');
  });

  it('decideGoalContinuation continues with next iteration', () => {
    const d = decideGoalContinuation({
      cancelled: false,
      session: session({
        id: 's',
        goalMode: { active: true, goal: 'fix bug', iteration: 0, maxIterations: 5 },
        messages: [],
      }),
      assistantText: 'still working on it',
    });
    expect(d.action).toBe('continue');
    if (d.action === 'continue') {
      expect(d.goalMode.iteration).toBe(1);
      expect(d.modelText).toContain('fix bug');
      expect(d.displayText).toContain('DONE');
    }
  });

  it('decideGoalContinuation done: no toast, marks tasks done', () => {
    const d = decideGoalContinuation({
      cancelled: false,
      session: session({
        id: 's',
        goalMode: {
          active: true,
          goal: 'ship',
          iteration: 1,
          maxIterations: 5,
          tasks: [
            { id: '1', text: 'a', done: true },
            { id: '2', text: 'b', done: false },
          ],
        },
      }),
      assistantText: '全部搞定 DONE',
    });
    expect(d.action).toBe('stop');
    if (d.action === 'stop') {
      expect(d.reason).toBe('done');
      expect(d.toast).toBeUndefined();
      expect(d.goalMode?.active).toBe(false);
      expect(d.goalMode?.tasks?.every((t) => t.done)).toBe(true);
    }
  });

  it('decideGoalContinuation all checklist done stops without toast', () => {
    const d = decideGoalContinuation({
      cancelled: false,
      session: session({
        id: 's',
        goalMode: {
          active: true,
          goal: 'ship',
          iteration: 0,
          maxIterations: 5,
          tasks: [{ id: '1', text: 'only', done: false }],
        },
      }),
      assistantText: '- [x] only',
    });
    expect(d.action).toBe('stop');
    if (d.action === 'stop') {
      expect(d.reason).toBe('done');
      expect(d.toast).toBeUndefined();
    }
  });

  it('decideGoalContinuation max_iter toasts once (not success spam)', () => {
    const d = decideGoalContinuation({
      cancelled: false,
      session: session({
        id: 's',
        goalMode: {
          active: true,
          goal: 'g',
          iteration: 4,
          maxIterations: 5,
          tasks: [{ id: '1', text: 'open', done: false }],
        },
      }),
      assistantText: 'still going\n- [ ] open',
    });
    expect(d.action).toBe('stop');
    if (d.action === 'stop') {
      expect(d.reason).toBe('max_iter');
      expect(d.toast).toMatch(/上限/);
      // 达上限仍保留 tasks，便于 TasksCard 显示缺口
      expect(d.goalMode?.tasks?.some((t) => !t.done)).toBe(true);
      expect(goalStopAllowsToast(d.reason)).toBe(true);
    }
  });

  it('goalStopAllowsToast only max_iter (成功/取消不 toast)', () => {
    expect(goalStopAllowsToast('max_iter')).toBe(true);
    expect(goalStopAllowsToast('done')).toBe(false);
    expect(goalStopAllowsToast('cancelled')).toBe(false);
    expect(goalStopAllowsToast('inactive')).toBe(false);
    expect(goalStopAllowsToast('queued')).toBe(false);
  });

  it('decideGoalContinuation queued/cancelled never toast', () => {
    const cancelled = decideGoalContinuation({
      cancelled: true,
      session: session({
        id: 's',
        goalMode: createInitialGoalMode('g'),
      }),
      assistantText: 'x',
    });
    expect(cancelled.action).toBe('stop');
    if (cancelled.action === 'stop') {
      expect(cancelled.reason).toBe('cancelled');
      expect(cancelled.toast).toBeUndefined();
    }

    const queued = decideGoalContinuation({
      cancelled: false,
      session: session({
        id: 's',
        goalMode: createInitialGoalMode('g'),
        messages: [
          {
            id: 'u1',
            sender: 'user',
            text: 'next',
            timestamp: 1,
            status: 'queued',
          },
        ],
      }),
      assistantText: 'mid',
    });
    expect(queued.action).toBe('stop');
    if (queued.action === 'stop') {
      expect(queued.reason).toBe('queued');
      expect(queued.toast).toBeUndefined();
    }
  });

  it('markAllGoalTasksDone / mergeGoalTasksFromAssistantText', () => {
    const gm = createInitialGoalMode('root');
    const merged = mergeGoalTasksFromAssistantText(
      gm,
      '- [x] a\n- [ ] b\n- [x] 本轮小结：忽略',
    );
    expect(merged.tasks?.map((t) => t.text)).toEqual(['a', 'b']);
    const done = markAllGoalTasksDone(merged);
    expect(done.active).toBe(false);
    expect(done.tasks?.every((t) => t.done)).toBe(true);
  });

  it('buildGoalModePrefix includes open tasks', () => {
    const p = buildGoalModePrefix('g', 1, 5, [
      { id: '1', text: 'open', done: false },
      { id: '2', text: 'done', done: true },
    ]);
    expect(p).toContain('open');
    expect(
      formatOpenGoalTasksForPrompt([
        { id: '1', text: 'open', done: false },
        { id: '2', text: 'done', done: true },
      ]),
    ).toContain('open');
    expect(
      formatOpenGoalTasksForPrompt([
        { id: '1', text: 'open', done: false },
        { id: '2', text: 'done', done: true },
      ]),
    ).not.toContain('- [ ] done');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: enter / exit / pause / resume / progress / complete / exclusivity
// ---------------------------------------------------------------------------

describe('goal lifecycle pure helpers', () => {
  describe('enter / exit / pause / resume', () => {
    it('enter from idle applies active lifecycle', () => {
      const r = enterGoalMode(createIdleGoalLifecycle(), '  fix flaky tests  ', 8);
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('entered');
      expect(r.changed).toBe(true);
      expect(r.state.phase).toBe('active');
      expect(r.state.goal).toBe('fix flaky tests');
      expect(r.state.maxIterations).toBe(8);
      expect(r.state.completed).toBe(false);
      expect(r.state.blockedReason).toBeNull();
      expect(r.state.tasks?.[0]?.text).toBe('fix flaky tests');
    });

    it('enter empty goal is illegal', () => {
      const r = enterGoalMode(createIdleGoalLifecycle(), '   ');
      expect(r.outcome).toBe('illegal');
      expect(r.reason).toBe('empty_goal');
      expect(r.changed).toBe(false);
      expect(r.state.phase).toBe('idle');
    });

    it('enter while active/paused/blocked is illegal (must exit first)', () => {
      const active = running();
      expect(enterGoalMode(active, 'other').reason).toBe('already_running');
      expect(enterGoalMode(active, 'other').outcome).toBe('illegal');

      const paused = pauseGoalMode(active).state;
      expect(enterGoalMode(paused, 'other').outcome).toBe('illegal');

      const blocked = applyGoalUpdate(active, { blocked_reason: 'stuck' }).state;
      expect(enterGoalMode(blocked, 'other').outcome).toBe('illegal');
    });

    it('enter after completed is allowed (fresh goal)', () => {
      const done = transitionGoalLifecycle(running(), { type: 'complete' }).state;
      expect(done.phase).toBe('completed');
      const r = enterGoalMode(done, 'next goal');
      expect(r.outcome).toBe('applied');
      expect(r.state.phase).toBe('active');
      expect(r.state.goal).toBe('next goal');
      expect(r.state.completed).toBe(false);
    });

    it('exit clears to idle; exit idle is noop', () => {
      const r = exitGoalMode(running());
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('exited');
      expect(r.state.phase).toBe('idle');
      expect(r.state.goal).toBe('');

      const noop = exitGoalMode(createIdleGoalLifecycle());
      expect(noop.outcome).toBe('noop');
      expect(noop.reason).toBe('already_idle');
    });

    it('exit completed clears to idle for re-enter', () => {
      const done = transitionGoalLifecycle(running(), { type: 'complete' }).state;
      const r = exitGoalMode(done);
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('cleared_completed');
      expect(r.state.phase).toBe('idle');
    });

    it('pause active → paused; double pause noop; pause idle illegal', () => {
      const r = pauseGoalMode(running(), 'waiting on review');
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('paused');
      expect(r.state.phase).toBe('paused');
      expect(r.state.lastMessage).toBe('waiting on review');
      expect(r.state.completed).toBe(false);
      expect(r.state.blockedReason).toBeNull();

      const again = pauseGoalMode(r.state);
      expect(again.outcome).toBe('noop');
      expect(again.reason).toBe('already_paused');

      const fromIdle = pauseGoalMode(createIdleGoalLifecycle());
      expect(fromIdle.outcome).toBe('illegal');
      expect(fromIdle.reason).toBe('not_running');
    });

    it('pause completed is illegal; pause blocked is noop', () => {
      const done = transitionGoalLifecycle(running(), { type: 'complete' }).state;
      expect(pauseGoalMode(done).outcome).toBe('illegal');
      expect(pauseGoalMode(done).reason).toBe('already_completed');

      const blocked = applyGoalUpdate(running(), { blocked_reason: 'no access' }).state;
      const p = pauseGoalMode(blocked);
      expect(p.outcome).toBe('noop');
      expect(p.reason).toBe('already_blocked');
      expect(p.state.phase).toBe('blocked');
    });

    it('resume paused/blocked → active; resume active noop; resume idle/completed illegal', () => {
      const paused = pauseGoalMode(running()).state;
      const r1 = resumeGoalMode(paused);
      expect(r1.outcome).toBe('applied');
      expect(r1.reason).toBe('resumed');
      expect(r1.state.phase).toBe('active');

      const blocked = applyGoalUpdate(running(), { blocked_reason: 'env broken' }).state;
      const r2 = resumeGoalMode(blocked);
      expect(r2.outcome).toBe('applied');
      expect(r2.state.phase).toBe('active');
      expect(r2.state.blockedReason).toBeNull();

      expect(resumeGoalMode(running()).outcome).toBe('noop');
      expect(resumeGoalMode(running()).reason).toBe('already_active');

      expect(resumeGoalMode(createIdleGoalLifecycle()).outcome).toBe('illegal');
      const done = transitionGoalLifecycle(running(), { type: 'complete' }).state;
      expect(resumeGoalMode(done).outcome).toBe('illegal');
      expect(resumeGoalMode(done).reason).toBe('already_completed');
    });
  });

  describe('progress messaging', () => {
    it('progress event logs message while running', () => {
      const r = transitionGoalLifecycle(running(), {
        type: 'progress',
        message: '  wired auth flow  ',
      });
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('progress_logged');
      expect(r.state.progressMessages).toEqual(['wired auth flow']);
      expect(r.state.lastMessage).toBe('wired auth flow');
      expect(r.state.phase).toBe('active');
    });

    it('empty progress is noop; progress from idle/completed illegal', () => {
      expect(
        transitionGoalLifecycle(running(), { type: 'progress', message: '  ' }).outcome,
      ).toBe('noop');
      expect(
        transitionGoalLifecycle(createIdleGoalLifecycle(), {
          type: 'progress',
          message: 'x',
        }).reason,
      ).toBe('not_running');
      const done = transitionGoalLifecycle(running(), { type: 'complete' }).state;
      expect(
        transitionGoalLifecycle(done, { type: 'progress', message: 'x' }).reason,
      ).toBe('already_completed');
    });

    it('appendGoalProgressMessage caps and skips blanks', () => {
      let s = running();
      s = appendGoalProgressMessage(s, '');
      expect(s.progressMessages).toEqual([]);
      s = appendGoalProgressMessage(s, 'a');
      s = appendGoalProgressMessage(s, 'b');
      expect(s.progressMessages).toEqual(['a', 'b']);
      expect(s.lastMessage).toBe('b');
    });

    it('formatGoalProgressMessage prefers explicit message', () => {
      expect(
        formatGoalProgressMessage({
          phase: 'active',
          goal: 'g',
          iteration: 0,
          maxIterations: 5,
          message: 'custom note',
        }),
      ).toBe('custom note');
    });

    it('formatGoalProgressMessage synthesizes per phase', () => {
      const tasks = [
        { id: '1', text: 'a', done: true },
        { id: '2', text: 'b', done: false },
      ];
      const base = {
        goal: 'ship',
        iteration: 1,
        maxIterations: 5,
        tasks,
      };
      expect(formatGoalProgressMessage({ ...base, phase: 'idle' })).toContain('未启动');
      expect(formatGoalProgressMessage({ ...base, phase: 'active' })).toMatch(
        /推进中.*第 2\/5 轮.*任务 1\/2/,
      );
      expect(formatGoalProgressMessage({ ...base, phase: 'paused' })).toContain('已暂停');
      expect(
        formatGoalProgressMessage({
          ...base,
          phase: 'blocked',
          blockedReason: 'missing API key',
        }),
      ).toMatch(/受阻.*missing API key/);
      expect(
        formatGoalProgressMessage({
          ...base,
          phase: 'completed',
          tasks: tasks.map((t) => ({ ...t, done: true })),
        }),
      ).toContain('已完成');
    });
  });

  describe('blocked_reason vs completed exclusivity', () => {
    it('validateGoalUpdateExclusivity rejects both', () => {
      expect(
        validateGoalUpdateExclusivity({
          completed: true,
          blocked_reason: 'stuck',
        }),
      ).toEqual({ ok: false, reason: 'completed_and_blocked' });
      expect(validateGoalUpdateExclusivity({ completed: true })).toEqual({ ok: true });
      expect(validateGoalUpdateExclusivity({ blocked_reason: 'x' })).toEqual({ ok: true });
      expect(
        validateGoalUpdateExclusivity({
          completed: true,
          blocked_reason: '   ',
        }),
      ).toEqual({ ok: true }); // whitespace blocked is absent
    });

    it('applyGoalUpdate with both completed and blocked_reason is illegal (no residual)', () => {
      const before = running();
      const r = applyGoalUpdate(before, {
        completed: true,
        blocked_reason: 'cannot proceed',
        message: 'should not apply',
      });
      expect(r.outcome).toBe('illegal');
      expect(r.reason).toBe('completed_and_blocked');
      expect(r.changed).toBe(false);
      expect(r.state).toEqual(before);
      expect(r.state.phase).toBe('active');
      expect(r.state.completed).toBe(false);
      expect(r.state.blockedReason).toBeNull();
    });

    it('completed clears blockedReason and marks tasks done', () => {
      const blocked = applyGoalUpdate(running(), { blocked_reason: 'tmp' }).state;
      expect(blocked.phase).toBe('blocked');
      const r = applyGoalUpdate(blocked, {
        completed: true,
        message: 'resolved and done',
      });
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('completed');
      expect(r.state.phase).toBe('completed');
      expect(r.state.completed).toBe(true);
      expect(r.state.blockedReason).toBeNull();
      expect(r.state.tasks.every((t) => t.done)).toBe(true);
      expect(r.state.lastMessage).toBe('resolved and done');
    });

    it('blocked_reason sets phase blocked and clears completed flag', () => {
      const r = applyGoalUpdate(running(), {
        blocked_reason: 'need credentials',
        message: 'waiting on vault',
      });
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('blocked');
      expect(r.state.phase).toBe('blocked');
      expect(r.state.completed).toBe(false);
      expect(r.state.blockedReason).toBe('need credentials');
      expect(r.state.progressMessages).toContain('waiting on vault');
      expect(r.state.progressMessages.some((m) => m.includes('need credentials'))).toBe(
        true,
      );
    });

    it('complete event also enforces exclusivity (clears blocked)', () => {
      const blocked = applyGoalUpdate(running(), { blocked_reason: 'x' }).state;
      const r = transitionGoalLifecycle(blocked, {
        type: 'complete',
        message: 'DONE via complete',
      });
      expect(r.state.completed).toBe(true);
      expect(r.state.blockedReason).toBeNull();
      expect(r.state.phase).toBe('completed');
    });

    it('update with only message is progress; empty update is noop', () => {
      const r = applyGoalUpdate(running(), { message: 'halfway' });
      expect(r.outcome).toBe('applied');
      expect(r.reason).toBe('progress_logged');
      expect(r.state.phase).toBe('active');
      expect(r.state.lastMessage).toBe('halfway');

      expect(applyGoalUpdate(running(), {}).outcome).toBe('noop');
      expect(applyGoalUpdate(running(), {}).reason).toBe('empty_update');
    });
  });

  describe('full phase × event matrix', () => {
    type Expect = { outcome: 'applied' | 'noop' | 'illegal'; reason?: string };

    function seed(phase: GoalLifecyclePhase): GoalLifecycleState {
      const base = createActiveGoalLifecycle('matrix goal', 5);
      switch (phase) {
        case 'idle':
          return createIdleGoalLifecycle();
        case 'active':
          return base;
        case 'paused':
          return pauseGoalMode(base).state;
        case 'blocked':
          return applyGoalUpdate(base, { blocked_reason: 'matrix block' }).state;
        case 'completed':
          return transitionGoalLifecycle(base, { type: 'complete' }).state;
        default: {
          const _n: never = phase;
          return _n;
        }
      }
    }

    const events: { name: string; event: GoalLifecycleEvent }[] = [
      { name: 'enter', event: { type: 'enter', goal: 'new goal' } },
      { name: 'exit', event: { type: 'exit' } },
      { name: 'pause', event: { type: 'pause' } },
      { name: 'resume', event: { type: 'resume' } },
      { name: 'progress', event: { type: 'progress', message: 'note' } },
      { name: 'complete', event: { type: 'complete' } },
      {
        name: 'update_progress',
        event: { type: 'update', message: 'tick' },
      },
      {
        name: 'update_complete',
        event: { type: 'update', completed: true, message: 'ok' },
      },
      {
        name: 'update_block',
        event: { type: 'update', blocked_reason: 'stuck' },
      },
      {
        name: 'update_both',
        event: {
          type: 'update',
          completed: true,
          blocked_reason: 'illegal both',
        },
      },
    ];

    /** Expected outcome matrix: phase → eventName → Expect */
    const matrix: Record<GoalLifecyclePhase, Record<string, Expect>> = {
      idle: {
        enter: { outcome: 'applied', reason: 'entered' },
        exit: { outcome: 'noop', reason: 'already_idle' },
        pause: { outcome: 'illegal', reason: 'not_running' },
        resume: { outcome: 'illegal', reason: 'not_running' },
        progress: { outcome: 'illegal', reason: 'not_running' },
        complete: { outcome: 'illegal', reason: 'not_running' },
        update_progress: { outcome: 'illegal', reason: 'not_running' },
        update_complete: { outcome: 'illegal', reason: 'not_running' },
        update_block: { outcome: 'illegal', reason: 'not_running' },
        update_both: { outcome: 'illegal', reason: 'completed_and_blocked' },
      },
      active: {
        enter: { outcome: 'illegal', reason: 'already_running' },
        exit: { outcome: 'applied', reason: 'exited' },
        pause: { outcome: 'applied', reason: 'paused' },
        resume: { outcome: 'noop', reason: 'already_active' },
        progress: { outcome: 'applied', reason: 'progress_logged' },
        complete: { outcome: 'applied', reason: 'completed' },
        update_progress: { outcome: 'applied', reason: 'progress_logged' },
        update_complete: { outcome: 'applied', reason: 'completed' },
        update_block: { outcome: 'applied', reason: 'blocked' },
        update_both: { outcome: 'illegal', reason: 'completed_and_blocked' },
      },
      paused: {
        enter: { outcome: 'illegal', reason: 'already_running' },
        exit: { outcome: 'applied', reason: 'exited' },
        pause: { outcome: 'noop', reason: 'already_paused' },
        resume: { outcome: 'applied', reason: 'resumed' },
        progress: { outcome: 'applied', reason: 'progress_logged' },
        complete: { outcome: 'applied', reason: 'completed' },
        update_progress: { outcome: 'applied', reason: 'progress_logged' },
        update_complete: { outcome: 'applied', reason: 'completed' },
        update_block: { outcome: 'applied', reason: 'blocked' },
        update_both: { outcome: 'illegal', reason: 'completed_and_blocked' },
      },
      blocked: {
        enter: { outcome: 'illegal', reason: 'already_running' },
        exit: { outcome: 'applied', reason: 'exited' },
        pause: { outcome: 'noop', reason: 'already_blocked' },
        resume: { outcome: 'applied', reason: 'resumed' },
        progress: { outcome: 'applied', reason: 'progress_logged' },
        complete: { outcome: 'applied', reason: 'completed' },
        update_progress: { outcome: 'applied', reason: 'progress_logged' },
        update_complete: { outcome: 'applied', reason: 'completed' },
        update_block: { outcome: 'applied', reason: 'blocked' },
        update_both: { outcome: 'illegal', reason: 'completed_and_blocked' },
      },
      completed: {
        enter: { outcome: 'applied', reason: 'entered' },
        exit: { outcome: 'applied', reason: 'cleared_completed' },
        pause: { outcome: 'illegal', reason: 'already_completed' },
        resume: { outcome: 'illegal', reason: 'already_completed' },
        progress: { outcome: 'illegal', reason: 'already_completed' },
        complete: { outcome: 'noop', reason: 'already_completed' },
        update_progress: { outcome: 'illegal', reason: 'already_completed' },
        update_complete: { outcome: 'applied', reason: 'progress_on_completed' },
        update_block: { outcome: 'illegal', reason: 'already_completed' },
        update_both: { outcome: 'illegal', reason: 'completed_and_blocked' },
      },
    };

    const phases: GoalLifecyclePhase[] = [
      'idle',
      'active',
      'paused',
      'blocked',
      'completed',
    ];

    for (const phase of phases) {
      for (const { name, event } of events) {
        it(`${phase} × ${name} → ${matrix[phase][name].outcome}`, () => {
          const before = seed(phase);
          const r = transitionGoalLifecycle(before, event);
          const exp = matrix[phase][name];
          expect(r.outcome).toBe(exp.outcome);
          if (exp.reason) expect(r.reason).toBe(exp.reason);
          expect(r.changed).toBe(exp.outcome === 'applied');
          // Illegal / noop must not leave residual success+blocked
          if (r.outcome !== 'applied') {
            expect(r.state.completed && r.state.blockedReason).toBeFalsy();
            if (exp.outcome === 'illegal' || exp.outcome === 'noop') {
              // No residual mutation on illegal/noop except we compare key exclusivity
              expect(r.state.phase).toBe(before.phase);
            }
          }
          // Applied complete never keeps blockedReason
          if (r.outcome === 'applied' && r.state.phase === 'completed') {
            expect(r.state.completed).toBe(true);
            expect(r.state.blockedReason).toBeNull();
          }
          // Applied block never keeps completed
          if (r.outcome === 'applied' && r.state.phase === 'blocked') {
            expect(r.state.completed).toBe(false);
            expect(r.state.blockedReason).toBeTruthy();
          }
        });
      }
    }
  });

  describe('session bridge', () => {
    it('goalLifecycleToSessionMode maps active/idle/paused correctly', () => {
      expect(goalLifecycleToSessionMode(createIdleGoalLifecycle())).toBeNull();
      const active = running();
      const gm = goalLifecycleToSessionMode(active);
      expect(gm?.active).toBe(true);
      expect(gm?.goal).toBe('ship feature');

      const paused = pauseGoalMode(active).state;
      expect(goalLifecycleToSessionMode(paused)?.active).toBe(false);

      const done = transitionGoalLifecycle(active, { type: 'complete' }).state;
      expect(goalLifecycleToSessionMode(done)?.active).toBe(false);
    });

    it('sessionModeToGoalLifecycle round-trips active and completed', () => {
      const gm = createInitialGoalMode('bridge goal');
      const life = sessionModeToGoalLifecycle(gm);
      expect(life.phase).toBe('active');
      expect(life.goal).toBe('bridge goal');

      const finished = markAllGoalTasksDone(gm);
      const lifeDone = sessionModeToGoalLifecycle(finished);
      expect(lifeDone.phase).toBe('completed');
      expect(lifeDone.completed).toBe(true);

      expect(sessionModeToGoalLifecycle(null).phase).toBe('idle');
      expect(sessionModeToGoalLifecycle(undefined).phase).toBe('idle');
    });

    it('createActiveGoalLifecycle aligns with createInitialGoalMode tasks', () => {
      const a = createActiveGoalLifecycle('same', 5);
      const b = createInitialGoalMode('same', 5);
      expect(a.goal).toBe(b.goal);
      expect(a.iteration).toBe(b.iteration);
      expect(a.tasks[0]?.text).toBe(b.tasks?.[0]?.text);
      expect(goalLifecycleToSessionMode(a)?.active).toBe(b.active);
    });
  });
});
