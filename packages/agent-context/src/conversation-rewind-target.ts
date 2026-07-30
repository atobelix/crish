import { resolve } from 'node:path';
import type { CheckpointManifestRecord } from './checkpoint-manifest';
import {
  conversationBoundaryManifestRecordToRewindTargetFacts,
  type ConversationBoundaryCheckpointSource,
  type ConversationBoundaryManifestRecord,
  type ConversationRewindBoundaryTargetMode,
} from './conversation-boundary-manifest';
import type { JsonObject } from '@crish/shared-types';

export type ConversationRewindMissingFact =
  'session-tree-target-leaf' | 'runtime-target-leaf' | 'workspace-checkpoint';

export interface ConversationRewindWorkspaceCheckpointFacts {
  checkpointId: string;
  checkpointRef: string;
  checkpointSource: ConversationBoundaryCheckpointSource;
  workspaceRoot: string;
  changedPaths: string[];
  createdAt: string;
}

export interface ResolveConversationRewindTargetFactsInput {
  boundary: ConversationBoundaryManifestRecord;
  checkpoint?: CheckpointManifestRecord;
  mode?: ConversationRewindBoundaryTargetMode;
  requireSessionTreeLeaf?: boolean;
  requireRuntimeLeaf?: boolean;
  requireCheckpoint?: boolean;
}

export interface ConversationRewindTargetFacts {
  sessionId: string;
  runId: string;
  userMessageId: string;
  mode: ConversationRewindBoundaryTargetMode;
  eventSequence: number;
  workspaceRoot: string;
  changedPaths: string[];
  createdAt: string;
  sessionTreeTargetLeafId?: string;
  runtimeTargetLeafId?: string;
  checkpoint?: ConversationRewindWorkspaceCheckpointFacts;
  missingFacts: ConversationRewindMissingFact[];
  metadata?: JsonObject;
}

export function resolveConversationRewindTargetFacts(
  input: ResolveConversationRewindTargetFactsInput
): ConversationRewindTargetFacts {
  assertMatchingCheckpoint(input.boundary, input.checkpoint);

  const boundaryTarget = conversationBoundaryManifestRecordToRewindTargetFacts(
    input.boundary,
    input.mode ?? 'keep-user-message'
  );
  const checkpoint = workspaceCheckpointFacts(input.boundary, input.checkpoint);
  const missingFacts: ConversationRewindMissingFact[] = [];

  if (!boundaryTarget.sessionTreeTargetLeafId)
    missingFacts.push('session-tree-target-leaf');
  if (!boundaryTarget.runtimeTargetLeafId)
    missingFacts.push('runtime-target-leaf');
  if (!checkpoint) missingFacts.push('workspace-checkpoint');

  assertRequiredFacts(missingFacts, input);

  return {
    sessionId: boundaryTarget.sessionId,
    runId: boundaryTarget.runId,
    userMessageId: boundaryTarget.userMessageId,
    mode: boundaryTarget.mode,
    eventSequence: boundaryTarget.eventSequence,
    workspaceRoot: boundaryTarget.workspaceRoot,
    changedPaths: boundaryTarget.changedPaths,
    createdAt: boundaryTarget.createdAt,
    ...(boundaryTarget.sessionTreeTargetLeafId !== undefined
      ? { sessionTreeTargetLeafId: boundaryTarget.sessionTreeTargetLeafId }
      : {}),
    ...(boundaryTarget.runtimeTargetLeafId !== undefined
      ? { runtimeTargetLeafId: boundaryTarget.runtimeTargetLeafId }
      : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    missingFacts,
    ...(boundaryTarget.metadata !== undefined
      ? { metadata: boundaryTarget.metadata }
      : {}),
  };
}

function workspaceCheckpointFacts(
  boundary: ConversationBoundaryManifestRecord,
  checkpoint: CheckpointManifestRecord | undefined
): ConversationRewindWorkspaceCheckpointFacts | undefined {
  if (checkpoint) {
    return {
      checkpointId: checkpoint.checkpointId,
      checkpointRef: checkpoint.checkpointRef,
      checkpointSource: checkpoint.source,
      workspaceRoot: checkpoint.workspaceRoot,
      changedPaths: [...checkpoint.changedPaths],
      createdAt: checkpoint.createdAt,
    };
  }

  if (!boundary.checkpointId || !boundary.checkpointRef) {
    return undefined;
  }

  return {
    checkpointId: boundary.checkpointId,
    checkpointRef: boundary.checkpointRef,
    checkpointSource: boundary.checkpointSource ?? 'unknown',
    workspaceRoot: boundary.workspaceRoot,
    changedPaths: [...boundary.changedPaths],
    createdAt: boundary.createdAt,
  };
}

function assertMatchingCheckpoint(
  boundary: ConversationBoundaryManifestRecord,
  checkpoint: CheckpointManifestRecord | undefined
): void {
  if (!checkpoint) return;
  if (checkpoint.sessionId !== boundary.sessionId) {
    throw new Error(
      `Checkpoint session ${checkpoint.sessionId} does not match boundary session ${boundary.sessionId}`
    );
  }
  if (checkpoint.runId !== boundary.runId) {
    throw new Error(
      `Checkpoint run ${checkpoint.runId} does not match boundary run ${boundary.runId}`
    );
  }
  if (checkpoint.userMessageId !== boundary.userMessageId) {
    throw new Error(
      `Checkpoint user message ${checkpoint.userMessageId} does not match boundary user message ${boundary.userMessageId}`
    );
  }
  if (
    normalizePath(checkpoint.workspaceRoot) !==
    normalizePath(boundary.workspaceRoot)
  ) {
    throw new Error(
      `Checkpoint workspace ${checkpoint.workspaceRoot} does not match boundary workspace ${boundary.workspaceRoot}`
    );
  }
}

function assertRequiredFacts(
  missingFacts: ConversationRewindMissingFact[],
  input: ResolveConversationRewindTargetFactsInput
): void {
  const requiredMissing = missingFacts.filter(
    (fact) =>
      (fact === 'session-tree-target-leaf' && input.requireSessionTreeLeaf) ||
      (fact === 'runtime-target-leaf' && input.requireRuntimeLeaf) ||
      (fact === 'workspace-checkpoint' && input.requireCheckpoint)
  );
  if (requiredMissing.length > 0) {
    throw new Error(
      `Conversation rewind target is missing required facts: ${requiredMissing.join(', ')}`
    );
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
