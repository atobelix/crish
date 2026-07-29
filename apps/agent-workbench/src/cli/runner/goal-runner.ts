import type {
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ToolBatchResult
} from "@crish/shared-types";
import {
  applyRuntimeEvidenceInference,
  isVerificationCommandText,
  type RuntimeEvidenceSignal
} from "../../shared/progress-inference";
import type { WorkbenchCommandDiagnosticInput } from "../../shared/disclosure-diagnostics";
import type {
  WorkbenchChangeItem,
  WorkbenchTaskSnapshot
} from "../../shared/workbench-contract";
import { numberField } from "./token-budget";

export function recordToolEvidence(snapshot: WorkbenchTaskSnapshot, result: ToolBatchResult): WorkbenchTaskSnapshot {
  const now = new Date().toISOString();
  const evidenceId = `tool-${result.id}`;
  const diagnostic = commandDiagnosticFromToolResult(result);
  const detail = result.output.text?.slice(0, 1_000);
  const withEvidence = {
    ...snapshot,
    evidence: [
      ...snapshot.evidence,
      {
        id: evidenceId,
        kind: evidenceKindForTool(result),
        title: `${result.toolName}${result.isError ? " 执行失败" : " 执行完成"}`,
        ...(detail !== undefined ? { detail } : {}),
        metadata: {
          toolName: result.toolName,
          isError: result.isError,
          durationMs: result.durationMs,
          command: diagnostic?.command ?? null,
          exitCode: diagnostic?.exitCode ?? null,
          timedOut: booleanRecordField(result.output.json, "timedOut") ?? null,
          truncated: booleanRecordField(result.output.json, "truncated") ?? null
        },
        createdAt: now
      }
    ].slice(-80)
  };
  return applyRuntimeEvidenceInference(withEvidence, {
    signals: evidenceSignalsForToolResult(result),
    evidenceIds: [evidenceId]
  });
}

export function evidenceSignalsForToolResult(result: ToolBatchResult): RuntimeEvidenceSignal[] {
  const signals = new Set<RuntimeEvidenceSignal>();
  const toolName = result.toolName.toLowerCase();
  if (isInspectionTool(toolName)) signals.add("inspect");
  if (!result.isError && isExecutionTool(toolName)) signals.add("execute");
  const diagnostic = commandDiagnosticFromToolResult(result);
  if (!result.isError && diagnostic?.command && diagnostic.exitCode === 0) {
    signals.add("execute");
    if (isVerificationCommandText(diagnostic.command)) signals.add("check");
  }
  return [...signals];
}

export function isInspectionTool(toolName: string): boolean {
  return (
    toolName === "read" ||
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "search_files" ||
    toolName.includes("search") ||
    toolName.includes("read") ||
    toolName.includes("list")
  );
}

export function isExecutionTool(toolName: string): boolean {
  return (
    toolName === "edit" ||
    toolName === "write_file" ||
    toolName === "shell_command" ||
    toolName === "create_workspace_checkpoint" ||
    toolName === "restore_workspace_checkpoint" ||
    toolName.includes("command") ||
    toolName.includes("write") ||
    toolName.includes("edit")
  );
}

export function recordToolChangeStats(snapshot: WorkbenchTaskSnapshot, result: ToolBatchResult): WorkbenchTaskSnapshot {
  const changes = diffChangesFromToolResult(result);
  if (changes.length === 0) return snapshot;
  return {
    ...snapshot,
    changes: upsertChanges(
      snapshot.changes,
      changes.map((change) => change.path),
      {
        state: "draft",
        additionsByPath: new Map(changes.map((change) => [change.path, change.additions])),
        deletionsByPath: new Map(changes.map((change) => [change.path, change.deletions]))
      }
    )
  };
}

export function recordCheckpointChange(snapshot: WorkbenchTaskSnapshot, checkpoint: RuntimeCheckpointRecord): WorkbenchTaskSnapshot {
  const paths = checkpointFilePaths(checkpoint);
  if (paths.length === 0) return snapshot;

  const evidenceId = `checkpoint-${checkpoint.id}`;
  const nextEvidence =
    snapshot.evidence.some((item) => item.id === evidenceId)
      ? snapshot.evidence
      : [
          ...snapshot.evidence,
          {
            id: evidenceId,
            kind: "file" as const,
            title: `检查点 ${checkpoint.id}`,
            detail: paths.join("\n"),
            createdAt: new Date().toISOString()
          }
        ].slice(-80);

  const withCheckpoint = {
    ...snapshot,
    changes: upsertChanges(snapshot.changes, paths, {
      checkpointId: checkpoint.id,
      state: "draft"
    }),
    evidence: nextEvidence,
    acceptance: snapshot.acceptance.map((item) =>
      item.id === "changes-tracked"
        ? {
            ...item,
            passed: true,
            evidenceIds: [...new Set([...item.evidenceIds, evidenceId])]
          }
        : item
    )
  };
  return applyRuntimeEvidenceInference(withCheckpoint, {
    signals: ["change-tracked"],
    evidenceIds: [evidenceId]
  });
}

export function recordCheckpointRestore(snapshot: WorkbenchTaskSnapshot, restore: RuntimeCheckpointRestoreRecord): WorkbenchTaskSnapshot {
  const restoredPaths = restore.restored.map(normalizeChangePath).filter(Boolean);
  const deletedPaths = restore.deleted.map(normalizeChangePath).filter(Boolean);
  const skippedPaths = restore.skipped.map(skippedRestorePath).filter(Boolean);
  const successfulPaths = [...restoredPaths, ...deletedPaths];
  const nextChanges =
    successfulPaths.length > 0
      ? upsertChanges(snapshot.changes, successfulPaths, {
          checkpointId: restore.checkpointId,
          state: "checked"
        })
      : snapshot.changes;
  return {
    ...snapshot,
    changes:
      skippedPaths.length > 0
        ? upsertChanges(nextChanges, skippedPaths, {
            checkpointId: restore.checkpointId,
            state: "needs-review"
          })
        : nextChanges
  };
}

export function checkpointFilePaths(checkpoint: RuntimeCheckpointRecord): string[] {
  const paths = new Set<string>();
  if (checkpoint.sourcePath) paths.add(normalizeChangePath(checkpoint.sourcePath));
  for (const path of stringArrayValue(checkpoint.metadata?.filePaths)) {
    paths.add(normalizeChangePath(path));
  }
  for (const path of stringArrayValue(checkpoint.metadata?.files)) {
    paths.add(normalizeChangePath(path));
  }
  return [...paths].filter(Boolean);
}

export function upsertChanges(
  changes: WorkbenchChangeItem[],
  paths: string[],
  patch: Pick<WorkbenchChangeItem, "state"> & {
    checkpointId?: string;
    additionsByPath?: ReadonlyMap<string, number>;
    deletionsByPath?: ReadonlyMap<string, number>;
  }
): WorkbenchChangeItem[] {
  const next = [...changes];
  for (const path of paths) {
    const normalized = normalizeChangePath(path);
    if (!normalized) continue;
    const additions = patch.additionsByPath?.get(normalized);
    const deletions = patch.deletionsByPath?.get(normalized);
    const existingIndex = next.findIndex((item) => normalizeChangePath(item.path) === normalized);
    if (existingIndex >= 0) {
      const existing = next[existingIndex]!;
      const resolvedCheckpointId = patch.checkpointId ?? existing.checkpointId;
      next[existingIndex] = {
        ...existing,
        path: existing.path || normalized,
        additions: additions ?? existing.additions,
        deletions: deletions ?? existing.deletions,
        ...(resolvedCheckpointId !== undefined ? { checkpointId: resolvedCheckpointId } : {}),
        state: patch.state
      };
      continue;
    }
    next.push({
      path: normalized,
      additions: additions ?? 0,
      deletions: deletions ?? 0,
      ...(patch.checkpointId !== undefined ? { checkpointId: patch.checkpointId } : {}),
      state: patch.state
    });
  }
  return next.slice(-200);
}

export function diffChangesFromToolResult(result: ToolBatchResult): Array<{ path: string; additions: number; deletions: number }> {
  const changes: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const artifact of result.output.artifacts ?? []) {
    if (artifact.kind !== "diff") continue;
    const path = normalizeChangePath(stringField(artifact.metadata?.path) ?? artifact.title.replace(/^Diff:\s*/i, ""));
    if (!path || !artifact.text) continue;
    const stats = diffStats(artifact.text);
    changes.push({ path, additions: stats.additions, deletions: stats.deletions });
  }
  return changes;
}

export function diffStats(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split(/\r\n|\n|\r/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function skippedRestorePath(input: string): string {
  return normalizeChangePath(input.split(":")[0] ?? input);
}

export function normalizeChangePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function booleanRecordField(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

export function commandDiagnosticFromToolResult(result: ToolBatchResult): WorkbenchCommandDiagnosticInput | undefined {
  const json = result.output.json;
  const record = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const exitCode = numberField(record.exitCode) ?? numberField(record.exit_code) ?? exitCodeFromText(result.output.text);
  const command = stringField(record.command) ?? result.toolName;
  const commandLike = /(?:command|shell|terminal)/i.test(result.toolName) || typeof record.command === "string" || exitCode !== undefined;
  if (!commandLike) return undefined;
  const resolvedExitCode = result.isError && exitCode === undefined ? 1 : exitCode;
  const resolvedOutput = typeof record.stdout === "string" ? record.stdout : undefined;
  const resolvedError = typeof record.stderr === "string" ? record.stderr : result.isError ? result.output.text : undefined;
  return {
    id: result.id,
    command,
    ...(resolvedExitCode !== undefined ? { exitCode: resolvedExitCode } : {}),
    ...(resolvedOutput !== undefined ? { output: resolvedOutput } : {}),
    ...(resolvedError !== undefined ? { error: resolvedError } : {})
  };
}

export function acceptanceIsPassed(snapshot: WorkbenchTaskSnapshot, id: string): boolean {
  return snapshot.acceptance.some((item) => item.id === id && item.passed);
}

export function exitCodeFromText(text: string | undefined): number | undefined {
  const match = text?.match(/Exit code:\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export function evidenceKindForTool(result: ToolBatchResult): "command" | "check" | "decision" {
  if (result.toolName.includes("command")) return "command";
  if (result.isError) return "check";
  return "decision";
}
