import { describe, expect, it } from 'vitest';
import { ProjectProgressLedger } from './project-progress-ledger';

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

describe('project progress ledger', () => {
  it('deduplicates stable principles and progress items by normalized text', () => {
    const ledger = new ProjectProgressLedger({ now: fixedClock() });

    ledger.addStablePrinciple({
      text: ' Single track backend only ',
      order: 2,
    });
    ledger.addStablePrinciple({
      text: 'single   track backend only',
      order: 1,
    });
    ledger.upsertProgressItem({
      title: 'Runtime ledger foundation',
      status: 'pending',
      summary: 'first',
    });
    ledger.upsertProgressItem({
      title: ' runtime   ledger foundation ',
      status: 'completed',
      summary: 'done',
    });

    expect(ledger.getStablePrinciples()).toMatchObject([
      { text: 'single track backend only', order: 1 },
    ]);
    expect(ledger.getProgressItems()).toMatchObject([
      {
        title: 'runtime ledger foundation',
        status: 'completed',
        summary: 'done',
      },
    ]);
  });

  it('separates cache-stable project progress from volatile recent task records', () => {
    const ledger = new ProjectProgressLedger({ now: fixedClock() });

    ledger.addStablePrinciple({
      id: 'p_later',
      text: 'Later principle',
      order: 10,
    });
    ledger.addStablePrinciple({
      id: 'p_first',
      text: 'First principle',
      order: 0,
    });
    ledger.upsertProgressItem({
      id: 'progress_done',
      title: 'Done item',
      status: 'completed',
      order: 0,
    });
    ledger.upsertProgressItem({
      id: 'progress_active',
      title: 'Active item',
      status: 'in_progress',
      order: 10,
    });
    ledger.upsertProgressItem({
      id: 'progress_blocked',
      title: 'Blocked item',
      status: 'blocked',
      order: 5,
    });
    ledger.recordSubagentTask({
      id: 'task_old',
      agentId: 'agent-b',
      title: 'Older task',
      status: 'completed',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    ledger.recordSubagentTask({
      id: 'task_new',
      agentId: 'agent-a',
      title: 'Newer task',
      status: 'in_progress',
      updatedAt: '2026-01-01T00:00:02.000Z',
    });

    expect(ledger.renderStableProgressLines()).toEqual([
      'Principle: First principle',
      'Principle: Later principle',
      'Progress[in_progress]: Active item',
      'Progress[blocked]: Blocked item',
      'Progress[completed]: Done item',
    ]);
    expect(ledger.renderRecentTaskLines()).toEqual([
      'Task[in_progress]: agent-a/task_new - Newer task',
      'Task[completed]: agent-b/task_old - Older task',
    ]);
    expect(ledger.snapshotForSubagentContext().lines).toEqual([
      'Principle: First principle',
      'Principle: Later principle',
      'Progress[in_progress]: Active item',
      'Progress[blocked]: Blocked item',
      'Progress[completed]: Done item',
      'Task[in_progress]: agent-a/task_new - Newer task',
      'Task[completed]: agent-b/task_old - Older task',
    ]);
  });

  it('limits volatile task records to the most recently updated entries', () => {
    const ledger = new ProjectProgressLedger({ now: fixedClock() });

    ledger.recordSubagentTask({
      id: 'task_1',
      agentId: 'agent',
      title: 'Task 1',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    ledger.recordSubagentTask({
      id: 'task_2',
      agentId: 'agent',
      title: 'Task 2',
      updatedAt: '2026-01-01T00:00:02.000Z',
    });
    ledger.recordSubagentTask({
      id: 'task_3',
      agentId: 'agent',
      title: 'Task 3',
      updatedAt: '2026-01-01T00:00:03.000Z',
    });

    const snapshot = ledger.snapshotForSubagentContext({ maxRecentTasks: 2 });

    expect(snapshot.recentTasks.map((task) => task.id)).toEqual([
      'task_3',
      'task_2',
    ]);
    expect(snapshot.stableLines).toEqual([]);
    expect(snapshot.recentTaskLines).toEqual([
      'Task[pending]: agent/task_3 - Task 3',
      'Task[pending]: agent/task_2 - Task 2',
    ]);
    expect(snapshot.lines).toEqual(snapshot.recentTaskLines);
  });

  it('keeps snapshots stable across repeated renders and clamps long summaries', () => {
    const ledger = new ProjectProgressLedger({ now: fixedClock() });

    ledger.addStablePrinciple({ text: 'Cache friendly stable context first' });
    ledger.upsertProgressItem({
      title: 'Long project item',
      status: 'in_progress',
      summary:
        'This summary is deliberately too long for the compact context budget.',
    });

    const first = ledger.snapshotForSubagentContext({ maxLineLength: 64 });
    const second = ledger.snapshotForSubagentContext({ maxLineLength: 64 });

    expect(second.lines).toEqual(first.lines);
    expect(first.lines).toEqual([
      'Principle: Cache friendly stable context first',
      'Progress[in_progress]: Long project item - This summary is deli...',
    ]);
  });
});
