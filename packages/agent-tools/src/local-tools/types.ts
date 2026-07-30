import type { BackgroundCommandManager } from '../background-command';
import type {
  GitCheckpoint,
  GitCheckpointStrategy,
  GitVersioningService,
} from '../git-versioning';
import type { ProcessGuardOptions, ProcessShell } from '../process-lifecycle';
import type { WorkspaceSnapshotOptions } from '@crish/agent-context';
import type { JsonObject, ToolArtifact } from '@crish/shared-types';
import type { WorkspaceMutationCoordinator } from '../workspace-mutation-coordinator';

export interface LocalToolOptions {
  workspaceRoot: string;
  snapshot?: WorkspaceSnapshotOptions | false;
  preMutationCheckpoint?:
    LocalPreMutationCheckpointOptions | LocalPreMutationCheckpointHook | false;
  mutationCoordinator?: WorkspaceMutationCoordinator;
}

export interface LocalPreMutationCheckpointOptions {
  enabled?: boolean;
  service?: GitVersioningService;
  strategy?: GitCheckpointStrategy;
  includeUntracked?: boolean;
  refNamespace?: string;
  onFailure?: 'continue' | 'throw';
  hook?: LocalPreMutationCheckpointHook;
}

export interface LocalPreMutationCheckpointRequest {
  workspaceRoot: string;
  cwd: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  targetSummary: string;
  input: JsonObject;
}

export interface LocalPreMutationCheckpointResult {
  status: 'created' | 'skipped' | 'failed';
  checkpoint?: GitCheckpoint;
  reason?: string;
  error?: string;
  metadata?: JsonObject;
  artifacts?: ToolArtifact[];
}

export type NormalizedPreMutationCheckpointResult =
  LocalPreMutationCheckpointResult;

export type LocalPreMutationCheckpointHook = (
  request: LocalPreMutationCheckpointRequest
) =>
  | Promise<LocalPreMutationCheckpointResult | null | undefined>
  | LocalPreMutationCheckpointResult
  | null
  | undefined;

export interface TerminalToolOptions extends LocalToolOptions {
  name?: string;
  defaultTimeoutMs?: number;
  backgroundDefaultTimeoutMs?: number;
  backgroundHeartbeatIntervalMs?: number;
  backgroundManager?: BackgroundCommandManager;
  maxOutputBytes?: number;
  shell?: TerminalShell;
  guard?: LocalExecutionGuardOptions | false;
}

export type TerminalShell = ProcessShell;

export type LocalExecutionGuardOptions = ProcessGuardOptions;
