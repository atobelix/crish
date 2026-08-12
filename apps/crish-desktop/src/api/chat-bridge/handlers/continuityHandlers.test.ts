/**
 * D8 §3.7.1/§3.7.2 continuityHandlers：goal-* 投影 → session.goalMode；
 * recovery-escalated（detail=circuit-trip）→ 熔断横幅。
 */
import { describe, expect, it } from 'vitest';
import {
  applyGoalRoundEventToGoalMode,
  goalDecisionToStatus,
  isGoalDecisionTerminal,
} from '../../../hooks/chat-stream/useGoalMode';
import type { SessionGoalMode } from '../../../store/types';

/** 前端 0-based iteration 语义：round=1 → iteration=0（第一轮） */
const baseGm: SessionGoalMode = {
  active: true,
  goal: '修复构建',
  iteration: 0,
  maxIterations: 12,
};

describe('applyGoalRoundEventToGoalMode（goal 投影过渡）', () => {
  it('goal-round-started → active + iteration=round-1 + maxIterations=maxRounds', () => {
    const next = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-round-started',
      round: 2,
      maxRounds: 12,
      goal: '修复构建',
    });
    expect(next!.active).toBe(true);
    expect(next!.iteration).toBe(1);
    expect(next!.maxIterations).toBe(12);
    expect(next!.status).toBe('active');
  });

  it('goal-round-completed（decision=Continue）→ iteration 推进、无终态 status', () => {
    const next = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-round-completed',
      round: 1,
      decision: 'Continue',
    });
    expect(next!.iteration).toBe(0);
    expect(next!.status).toBeUndefined();
  });

  it('goal-round-completed（decision=Completed）→ status=completed', () => {
    const next = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-round-completed',
      round: 3,
      decision: 'Completed',
    });
    expect(next!.status).toBe('completed');
    expect(next!.iteration).toBe(2);
  });

  it('goal-round-completed（decision=Blocked/NoProgress）→ status=blocked', () => {
    const blocked = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-round-completed',
      round: 2,
      decision: 'Blocked',
    });
    expect(blocked!.status).toBe('blocked');
    const noProgress = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-round-completed',
      round: 2,
      decision: 'NoProgress',
    });
    expect(noProgress!.status).toBe('blocked');
  });

  it('goal-continuation-decided（action=complete）→ status=completed', () => {
    const next = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-continuation-decided',
      action: 'complete',
      reason: 'done',
    });
    expect(next!.status).toBe('completed');
  });

  it('goal-continuation-decided（action=block）→ status=blocked', () => {
    const next = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-continuation-decided',
      action: 'block',
      reason: 'no-progress',
    });
    expect(next!.status).toBe('blocked');
  });

  it('goal-continuation-decided（action=continue）→ status=active（引擎权威续轮）', () => {
    const next = applyGoalRoundEventToGoalMode(baseGm, {
      type: 'goal-continuation-decided',
      action: 'continue',
      reason: 'in-progress',
    });
    expect(next!.status).toBe('active');
  });

  it('无 goalMode（非 goal 会话）→ 不投影（返回 null）', () => {
    expect(
      applyGoalRoundEventToGoalMode(undefined, {
        type: 'goal-round-started',
        round: 1,
        maxRounds: 12,
        goal: 'x',
      })
    ).toBeNull();
    expect(
      applyGoalRoundEventToGoalMode(null, {
        type: 'goal-continuation-decided',
        action: 'continue',
        reason: 'x',
      })
    ).toBeNull();
  });
});

describe('goal 终态判定辅助', () => {
  it('isGoalDecisionTerminal：Completed/NoProgress/Blocked/NoGoal 为终态', () => {
    expect(isGoalDecisionTerminal('Completed')).toBe(true);
    expect(isGoalDecisionTerminal('NoProgress')).toBe(true);
    expect(isGoalDecisionTerminal('Blocked')).toBe(true);
    expect(isGoalDecisionTerminal('NoGoal')).toBe(true);
    expect(isGoalDecisionTerminal('Continue')).toBe(false);
  });

  it('goalDecisionToStatus：Completed → completed；阻塞类 → blocked；Continue → undefined', () => {
    expect(goalDecisionToStatus('Completed')).toBe('completed');
    expect(goalDecisionToStatus('Blocked')).toBe('blocked');
    expect(goalDecisionToStatus('NoProgress')).toBe('blocked');
    expect(goalDecisionToStatus('Continue')).toBeUndefined();
  });
});
