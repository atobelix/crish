/**
 * 连续性与控制中控事件宽容归一器（Continuity / Steering / Recovery / Goal / Hook / Observation）。
 */
import type {
  EngineRecoveryEscalatedEvent,
  EngineRecoverySteeringEvent,
  EngineRecoveryForkEvent,
  EngineRecoveryReportEvent,
  EngineRecoveryBudgetDeniedEvent,
  EngineGoalRoundStartedEvent,
  EngineGoalRoundCompletedEvent,
  EngineGoalContinuationDecidedEvent,
  EngineSteeringEvaluatedEvent,
  EngineControlIntentEvent,
  EngineHookOutcomeEvent,
  EngineSummaryBackgroundEvent,
  EngineStageSummaryMilestoneEvent,
  EngineNudgeEnqueuedEvent,
  EngineRecoveryAcknowledgedEvent,
  EngineRecoveryRetryAttemptedEvent,
} from '../../../../../../packages/shared-types/src/generated/engine';
import {
  alt,
  num,
  str,
  strArray,
  withEnvelopeRunId,
  type Normalizer,
} from './eventParserShared';

export const CONTINUITY_NORMALIZERS: Record<string, Normalizer> = {
  'recovery-escalated': (raw): EngineRecoveryEscalatedEvent => {
    const event: EngineRecoveryEscalatedEvent = {
      type: 'recovery-escalated',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      kind: str(raw.kind),
      retries: num(raw.retries) ?? 0,
      elapsedMs: num(alt(raw, 'elapsedMs', 'elapsed_ms')) ?? 0,
    };
    const subagentRunId = str(alt(raw, 'subagentRunId', 'subagent_run_id'));
    if (subagentRunId) event.subagentRunId = subagentRunId;
    const detail = str(raw.detail);
    if (detail) event.detail = detail;
    return withEnvelopeRunId(event, raw);
  },
  'recovery-steering': (raw): EngineRecoverySteeringEvent =>
    withEnvelopeRunId(
      {
        type: 'recovery-steering',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        subagentId: str(alt(raw, 'subagentId', 'subagent_id')),
        subagentRunId: str(alt(raw, 'subagentRunId', 'subagent_run_id')),
        fingerprint: str(raw.fingerprint),
        retries: num(raw.retries) ?? 0,
        remainingStatus: str(alt(raw, 'remainingStatus', 'remaining_status')),
        pending: raw.pending === true,
        createdAtMs: num(alt(raw, 'createdAtMs', 'created_at_ms')) ?? 0,
      },
      raw
    ),
  'recovery-fork': (raw): EngineRecoveryForkEvent =>
    withEnvelopeRunId(
      {
        type: 'recovery-fork',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        fingerprint: str(raw.fingerprint),
        subagentId: str(alt(raw, 'subagentId', 'subagent_id')),
        fromRunId: str(alt(raw, 'fromRunId', 'from_run_id')),
        fromLeafId: str(alt(raw, 'fromLeafId', 'from_leaf_id')),
        newRunId: str(alt(raw, 'newRunId', 'new_run_id')),
        newLeafId: str(alt(raw, 'newLeafId', 'new_leaf_id')),
        contextMode: str(alt(raw, 'contextMode', 'context_mode')),
      },
      raw
    ),
  'recovery-report': (raw): EngineRecoveryReportEvent =>
    withEnvelopeRunId(
      {
        type: 'recovery-report',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        subagentId: str(alt(raw, 'subagentId', 'subagent_id')),
        subagentRunId: str(alt(raw, 'subagentRunId', 'subagent_run_id')),
        stuckAtMs: num(alt(raw, 'stuckAtMs', 'stuck_at_ms')) ?? 0,
        suggestion: str(raw.suggestion),
      },
      raw
    ),
  'recovery-budget-denied': (raw): EngineRecoveryBudgetDeniedEvent => {
    const event: EngineRecoveryBudgetDeniedEvent = {
      type: 'recovery-budget-denied',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      fingerprint: str(raw.fingerprint),
      count: num(raw.count) ?? 0,
      max: num(raw.max) ?? 0,
    };
    const subagentRunId = str(alt(raw, 'subagentRunId', 'subagent_run_id'));
    if (subagentRunId) event.subagentRunId = subagentRunId;
    return withEnvelopeRunId(event, raw);
  },
  'goal-round-started': (raw): EngineGoalRoundStartedEvent => ({
    type: 'goal-round-started',
    round: num(raw.round) ?? 0,
    maxRounds: num(alt(raw, 'maxRounds', 'max_rounds')) ?? 0,
    goal: str(raw.goal),
  }),
  'goal-round-completed': (raw): EngineGoalRoundCompletedEvent => ({
    type: 'goal-round-completed',
    round: num(raw.round) ?? 0,
    toolCallCount: num(alt(raw, 'toolCallCount', 'tool_call_count')) ?? 0,
    toolSuccessCount:
      num(alt(raw, 'toolSuccessCount', 'tool_success_count')) ?? 0,
    messageCount: num(alt(raw, 'messageCount', 'message_count')) ?? 0,
    decision: str(raw.decision),
    reasonDetail: str(alt(raw, 'reasonDetail', 'reason_detail')),
    stalledDelta: num(alt(raw, 'stalledDelta', 'stalled_delta')) ?? 0,
    evidence: str(raw.evidence),
  }),
  'goal-continuation-decided': (raw): EngineGoalContinuationDecidedEvent => {
    const event: EngineGoalContinuationDecidedEvent = {
      type: 'goal-continuation-decided',
      action: str(raw.action),
      reason: str(raw.reason),
    };
    const prompt = str(raw.prompt);
    if (prompt) event.prompt = prompt;
    const progressSignature = str(
      alt(raw, 'progressSignature', 'progress_signature')
    );
    if (progressSignature) event.progressSignature = progressSignature;
    const detail = str(raw.detail);
    if (detail) event.detail = detail;
    return event;
  },
  'steering-evaluated': (raw): EngineSteeringEvaluatedEvent => {
    const event: EngineSteeringEvaluatedEvent = {
      type: 'steering-evaluated',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      phase: str(raw.phase),
      hitStrategies: strArray(alt(raw, 'hitStrategies', 'hit_strategies')),
      steeringCountBefore:
        num(alt(raw, 'steeringCountBefore', 'steering_count_before')) ?? 0,
      steeringCountAfter:
        num(alt(raw, 'steeringCountAfter', 'steering_count_after')) ?? 0,
      reset: raw.reset === true,
    };
    const budgetRemaining = num(
      alt(raw, 'budgetRemaining', 'budget_remaining')
    );
    if (budgetRemaining !== undefined) event.budgetRemaining = budgetRemaining;
    return withEnvelopeRunId(event, raw);
  },
  'control-intent': (raw): EngineControlIntentEvent => {
    const event: EngineControlIntentEvent = {
      type: 'control-intent',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      kind: str(raw.kind),
      intentId: str(alt(raw, 'intentId', 'intent_id')),
      state: str(raw.state),
    };
    const source = str(raw.source);
    if (source) event.source = source;
    const reason = str(raw.reason);
    if (reason) event.reason = reason;
    return withEnvelopeRunId(event, raw);
  },
  'hook-outcome': (raw): EngineHookOutcomeEvent => {
    const event: EngineHookOutcomeEvent = {
      type: 'hook-outcome',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      hookType: str(alt(raw, 'hookType', 'hook_type')),
      outcome: str(raw.outcome),
    };
    const hookName = str(alt(raw, 'hookName', 'hook_name'));
    if (hookName) event.hookName = hookName;
    const blockedReason = str(alt(raw, 'blockedReason', 'blocked_reason'));
    if (blockedReason) event.blockedReason = blockedReason;
    return withEnvelopeRunId(event, raw);
  },
  'summary-background': (raw): EngineSummaryBackgroundEvent => {
    const event: EngineSummaryBackgroundEvent = {
      type: 'summary-background',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      phase: str(raw.phase),
      attempt: num(raw.attempt) ?? 0,
    };
    const reason = str(raw.reason);
    if (reason) event.reason = reason;
    const messageId = str(alt(raw, 'messageId', 'message_id'));
    if (messageId) event.messageId = messageId;
    return withEnvelopeRunId(event, raw);
  },
  'stage-summary-milestone': (raw): EngineStageSummaryMilestoneEvent => {
    const event: EngineStageSummaryMilestoneEvent = {
      type: 'stage-summary-milestone',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      milestoneType: str(alt(raw, 'milestoneType', 'milestone_type')),
    };
    const tier = str(raw.tier);
    if (tier) event.tier = tier;
    const milestoneIndex = num(alt(raw, 'milestoneIndex', 'milestone_index'));
    if (milestoneIndex !== undefined) event.milestoneIndex = milestoneIndex;
    return withEnvelopeRunId(event, raw);
  },
  'nudge-enqueued': (raw): EngineNudgeEnqueuedEvent =>
    withEnvelopeRunId(
      {
        type: 'nudge-enqueued',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        timestamp: str(raw.timestamp),
        reason: str(raw.reason),
        targetRing: str(alt(raw, 'targetRing', 'target_ring')),
        overwrote: raw.overwrote === true,
      },
      raw
    ),
  'recovery-acknowledged': (raw): EngineRecoveryAcknowledgedEvent => {
    const event: EngineRecoveryAcknowledgedEvent = {
      type: 'recovery-acknowledged',
      sessionId: str(alt(raw, 'sessionId', 'session_id')),
      timestamp: str(raw.timestamp),
      subagentRunId: str(alt(raw, 'subagentRunId', 'subagent_run_id')),
    };
    const notificationId = str(alt(raw, 'notificationId', 'notification_id'));
    if (notificationId) event.notificationId = notificationId;
    return withEnvelopeRunId(event, raw);
  },
  'recovery-retry-attempted': (raw): EngineRecoveryRetryAttemptedEvent =>
    withEnvelopeRunId(
      {
        type: 'recovery-retry-attempted',
        sessionId: str(alt(raw, 'sessionId', 'session_id')),
        timestamp: str(raw.timestamp),
        attempt: num(raw.attempt) ?? 0,
        delayMs: num(alt(raw, 'delayMs', 'delay_ms')) ?? 0,
        budgetRemaining:
          num(alt(raw, 'budgetRemaining', 'budget_remaining')) ?? 0,
        fromRunId: str(alt(raw, 'fromRunId', 'from_run_id')),
        newRunId: str(alt(raw, 'newRunId', 'new_run_id')),
      },
      raw
    ),
};
