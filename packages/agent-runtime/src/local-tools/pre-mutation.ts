import { GitCliVersioningService, type GitCheckpoint } from "../git-versioning";
import type { JsonObject, JsonValue, ToolArtifact, ToolOutput } from "@crish/shared-types";
import {
  displayPath,
  errorToString,
  isJsonObject,
  truncateForMetadata
} from "./shared";
import type {
  LocalPreMutationCheckpointOptions,
  LocalPreMutationCheckpointRequest,
  LocalPreMutationCheckpointResult,
  LocalToolOptions,
  NormalizedPreMutationCheckpointResult
} from "./types";

export async function createPreMutationCheckpoint(
  options: LocalToolOptions,
  request: LocalPreMutationCheckpointRequest
): Promise<NormalizedPreMutationCheckpointResult | null> {
  if (options.preMutationCheckpoint === false) return null;

  const checkpointOptions =
    typeof options.preMutationCheckpoint === "function"
      ? { hook: options.preMutationCheckpoint }
      : options.preMutationCheckpoint ?? {};
  if (checkpointOptions.enabled === false) return null;

  try {
    const result = checkpointOptions.hook
      ? await checkpointOptions.hook(request)
      : await createGitPreMutationCheckpoint(checkpointOptions, request);
    const normalized = normalizePreMutationCheckpointResult(result);
    if (normalized?.status === "failed" && checkpointOptions.onFailure === "throw") {
      throw new Error(normalized.error ?? normalized.reason ?? "Pre-mutation checkpoint failed");
    }
    return normalized;
  } catch (error) {
    if (checkpointOptions.onFailure === "throw") throw error;
    const message = errorToString(error);
    return {
      status: "failed",
      reason: "checkpoint-failed",
      error: message,
      metadata: {
        diagnostic: `Pre-mutation Git checkpoint failed: ${message}`,
        toolName: request.toolName,
        targetSummary: request.targetSummary
      }
    };
  }
}

async function createGitPreMutationCheckpoint(
  options: LocalPreMutationCheckpointOptions,
  request: LocalPreMutationCheckpointRequest
): Promise<NormalizedPreMutationCheckpointResult> {
  const service = options.service ?? new GitCliVersioningService();
  const detected = await service.detectRepository({ cwd: request.cwd });
  if (detected.found === false) {
    return {
      status: "skipped",
      reason: "not-a-git-repository",
      metadata: {
        cwd: detected.cwd,
        diagnostic: `Pre-mutation Git checkpoint skipped: ${detected.reason}`
      }
    };
  }

  const strategy = options.strategy ?? "snapshot";
  if (strategy === "snapshot" && !detected.head) {
    return {
      status: "skipped",
      reason: "repository-has-no-head",
      metadata: {
        repositoryRoot: detected.root,
        diagnostic: "Pre-mutation Git checkpoint skipped: repository has no HEAD commit"
      }
    };
  }

  const checkpoint = await service.createCheckpoint({
    cwd: detected.root,
    label: `Before ${request.toolName}: ${request.targetSummary}`,
    strategy,
    includeUntracked: options.includeUntracked ?? true,
    refNamespace: options.refNamespace,
    toolCall: {
      id: request.toolCallId,
      toolName: request.toolName,
      sessionId: request.sessionId,
      targetSummary: request.targetSummary
    }
  });

  return {
    status: "created",
    checkpoint,
    artifacts: [gitCheckpointToArtifact(checkpoint)],
    metadata: {
      diagnostic: `Pre-mutation Git checkpoint created: ${checkpoint.id}`,
      repositoryRoot: checkpoint.repositoryRoot,
      refName: checkpoint.refName,
      strategy: checkpoint.strategy
    }
  };
}

function normalizePreMutationCheckpointResult(
  result: LocalPreMutationCheckpointResult | null | undefined
): NormalizedPreMutationCheckpointResult | null {
  return result ?? null;
}

export function summarizeTerminalTarget(workspaceRoot: string, cwd: string, command: string): string {
  const location = displayPath(workspaceRoot, cwd);
  return `${location}: ${truncateForMetadata(command, 140)}`;
}

export function withPreMutationCheckpointOutput(
  output: ToolOutput,
  checkpoint: NormalizedPreMutationCheckpointResult | null | undefined
): ToolOutput {
  if (!checkpoint) return output;
  // Skipped checkpoints stay in json for debug; omit noisy diagnostic line from tool text.
  const diagnosticLine = formatPreMutationCheckpointLine(checkpoint);
  const checkpointArtifacts =
    checkpoint.status === "created"
      ? (checkpoint.artifacts ?? (checkpoint.checkpoint ? [gitCheckpointToArtifact(checkpoint.checkpoint)] : []))
      : [];
  return {
    ...output,
    text: diagnosticLine ? [diagnosticLine, output.text].filter(Boolean).join("\n") : output.text,
    artifacts: [...(output.artifacts ?? []), ...checkpointArtifacts],
    json: mergePreMutationCheckpointJson(output.json, checkpoint)
  };
}

function mergePreMutationCheckpointJson(
  json: JsonValue | undefined,
  checkpoint: NormalizedPreMutationCheckpointResult
): JsonObject {
  const checkpointJson = preMutationCheckpointToJson(checkpoint);
  if (isJsonObject(json)) {
    return {
      ...json,
      preMutationCheckpoint: checkpointJson
    };
  }
  return {
    result: json ?? null,
    preMutationCheckpoint: checkpointJson
  };
}

function preMutationCheckpointToJson(checkpoint: NormalizedPreMutationCheckpointResult): JsonObject {
  const json: JsonObject = {
    status: checkpoint.status
  };
  if (checkpoint.reason) json.reason = checkpoint.reason;
  if (checkpoint.error) json.error = checkpoint.error;
  if (checkpoint.metadata) json.metadata = checkpoint.metadata;
  if (checkpoint.checkpoint) json.checkpoint = gitCheckpointToJson(checkpoint.checkpoint);
  return json;
}

function gitCheckpointToArtifact(checkpoint: GitCheckpoint): ToolArtifact {
  return {
    kind: "log",
    title: `Git checkpoint: ${checkpoint.label}`,
    uri: checkpoint.refName,
    text: `Git checkpoint ${checkpoint.id} at ${checkpoint.refName}`,
    metadata: {
      artifactKind: "git-checkpoint",
      checkpointId: checkpoint.id,
      label: checkpoint.label,
      refName: checkpoint.refName,
      commit: checkpoint.commit,
      strategy: checkpoint.strategy,
      repositoryRoot: checkpoint.repositoryRoot,
      includeUntracked: checkpoint.includeUntracked
    }
  };
}

function gitCheckpointToJson(checkpoint: GitCheckpoint): JsonObject {
  const json: JsonObject = {
    id: checkpoint.id,
    label: checkpoint.label,
    strategy: checkpoint.strategy,
    refName: checkpoint.refName,
    commit: checkpoint.commit,
    baseCommit: checkpoint.baseCommit,
    createdAt: checkpoint.createdAt,
    repositoryRoot: checkpoint.repositoryRoot,
    includeUntracked: checkpoint.includeUntracked
  };
  if (checkpoint.toolCall) {
    json.toolCall = {
      id: checkpoint.toolCall.id ?? null,
      toolName: checkpoint.toolCall.toolName ?? null,
      actor: checkpoint.toolCall.actor ?? null,
      sessionId: checkpoint.toolCall.sessionId ?? null,
      targetSummary: checkpoint.toolCall.targetSummary ?? null
    };
  }
  return json;
}

/** Text diagnostic for tool output; null when skipped (json still carries status). */
function formatPreMutationCheckpointLine(checkpoint: NormalizedPreMutationCheckpointResult): string | null {
  if (checkpoint.status === "created" && checkpoint.checkpoint) {
    return `Pre-mutation Git checkpoint: ${checkpoint.checkpoint.id} (${checkpoint.checkpoint.strategy}, ${checkpoint.checkpoint.refName})`;
  }
  if (checkpoint.status === "failed") {
    return `Pre-mutation Git checkpoint failed: ${checkpoint.error ?? checkpoint.reason ?? "unknown error"}`;
  }
  // skipped → omit from tool text (prefer quiet; details remain in json.preMutationCheckpoint)
  return null;
}
