import { describe, expect, it } from 'vitest';
import {
  buildGoalModePrefix,
  createInitialGoalMode,
  decideGoalContinuation,
  formatOpenGoalTasksForPrompt,
  parseChecklistTasks,
  replyLooksGoalDone,
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

  it('buildGoalModePrefix includes open tasks', () => {
    const p = buildGoalModePrefix('g', 1, 5, [
      { id: '1', text: 'open', done: false },
      { id: '2', text: 'done', done: true },
    ]);
    expect(p).toContain('open');
    expect(formatOpenGoalTasksForPrompt([
      { id: '1', text: 'open', done: false },
      { id: '2', text: 'done', done: true },
    ])).toContain('open');
    expect(formatOpenGoalTasksForPrompt([
      { id: '1', text: 'open', done: false },
      { id: '2', text: 'done', done: true },
    ])).not.toContain('- [ ] done');
  });
});
