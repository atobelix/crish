import { dirname } from 'node:path';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import type {
  JsonObject,
  JsonValue,
  ToolArtifact,
  ToolExecutionContext,
} from '@crish/shared-types';
import { decodeTextBuffer, encodeTextBuffer } from '@crish/agent-context';
import { defineTool } from '../../tools';
import type { AgentTool } from '@crish/shared-types';
import {
  createPreMutationCheckpoint,
  withPreMutationCheckpointOutput,
} from '../pre-mutation';
import {
  computeSnapshotTag,
  displayPath,
  ensureParentDirectoryForWrite,
  errorToString,
  isJsonObject,
  normalizeForCompare,
  recordReadSnapshot,
  requireString,
  resolveWorkspacePath,
  stringField,
  withLocalMutationLease,
} from '../shared';
import type { LocalToolOptions } from '../types';
import type {
  WorkspaceEditFileRequest,
  PreparedWorkspaceEditFile,
  AppliedWorkspaceEditFile,
  WorkspaceEditRollbackState,
  ApplyPreparedWorkspaceEditFilesResult,
} from './types';
import { applyEditOperations } from './edit-tool';
import {
  resolveWriteEncoding,
  writeBytesAtomically,
  createUnifiedDiffPreview,
  textReplaceFields,
  editOperationsField,
} from './utils';

export function createApplyWorkspaceEditsTool(
  options: LocalToolOptions & { name?: string }
): AgentTool {
  const toolName = options.name ?? 'apply_workspace_edits';
  return defineTool({
    name: toolName,
    label: 'Apply workspace edits',
    description:
      'Apply a validated multi-file text edit transaction with snapshotTag checks, one mutation lease, and a Git checkpoint before changes.',
    category: 'filesystem',
    concurrency: 'exclusive',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              snapshotTag: {
                type: 'string',
                description:
                  'Snapshot tag returned by read. If omitted, the latest recorded read snapshot for this session is used when available.',
              },
              content: {
                type: 'string',
                description: 'Full replacement content for this file.',
              },
              old_string: {
                type: 'string',
                description:
                  'Text to find via 4-pass seek. Unique match required. Alternative to edits[].op=replace_text.',
              },
              new_string: {
                type: 'string',
                description: 'Replacement for old_string (may be empty).',
              },
              oldString: {
                type: 'string',
                description: 'CamelCase alias of old_string.',
              },
              newString: {
                type: 'string',
                description: 'CamelCase alias of new_string.',
              },
              edits: {
                type: 'array',
                items: { type: 'object' },
              },
              encoding: {
                type: 'string',
                enum: ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'],
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    summarize(input) {
      const files = workspaceEditFileInputs(input);
      return `apply workspace edits to ${files.length} file${files.length === 1 ? '' : 's'}`;
    },
    async execute(input, context) {
      const files = parseWorkspaceEditFileRequests(
        options.workspaceRoot,
        input
      );
      const targetSummary = summarizeWorkspaceEditTargets(files);
      return withLocalMutationLease(
        options,
        context,
        {
          scope: { type: 'files', paths: files.map((file) => file.filePath) },
          toolName,
          cwd: options.workspaceRoot,
          targetSummary,
        },
        async () => {
          const prepared = await prepareWorkspaceEditFiles(
            options,
            context,
            files
          );
          const changed = prepared.filter((file) => file.changed);
          if (changed.length === 0) {
            return {
              text: `No workspace edit changes for ${prepared.length} file(s)`,
              json: {
                ok: true,
                changed: false,
                fileCount: prepared.length,
                changedFileCount: 0,
                files: prepared.map(
                  preparedWorkspaceEditFileToJson
                ) as unknown as JsonValue,
              } as JsonObject,
            };
          }

          const mutationCheckpoint = await createPreMutationCheckpoint(
            options,
            {
              workspaceRoot: options.workspaceRoot,
              cwd: options.workspaceRoot,
              sessionId: context.sessionId,
              toolCallId: context.toolCallId,
              toolName,
              targetSummary,
              input,
            }
          );

          const applied = await applyPreparedWorkspaceEditFiles(changed);
          if (!applied.ok) {
            return withPreMutationCheckpointOutput(
              {
                text: [
                  `Workspace edit transaction failed and rollback was attempted.`,
                  `Failed path: ${applied.failedPath ?? 'unknown'}`,
                  `Error: ${applied.error}`,
                  `Rollback restored: ${applied.rollback.restored.length}`,
                  `Rollback deleted: ${applied.rollback.deleted.length}`,
                  `Rollback failures: ${applied.rollback.failed.length}`,
                ].join('\n'),
                json: {
                  ok: false,
                  changed: false,
                  reason: 'apply-failed',
                  error: applied.error,
                  failedPath: applied.failedPath ?? null,
                  fileCount: prepared.length,
                  changedFileCount: changed.length,
                  files: prepared.map(
                    preparedWorkspaceEditFileToJson
                  ) as unknown as JsonValue,
                  rollback: applied.rollback as unknown as JsonValue,
                } as JsonObject,
              },
              mutationCheckpoint
            );
          }

          for (const file of applied.files) {
            recordReadSnapshot(
              options,
              context,
              file.filePath,
              file.newSnapshotTag
            );
          }

          const diffArtifacts = changed.map((file): ToolArtifact => ({
            kind: 'diff',
            title: `Diff: ${file.relativePath}`,
            text: createUnifiedDiffPreview(file.beforeText, file.afterText),
            metadata: {
              artifactKind: 'workspace-edit-diff-preview',
              path: file.relativePath,
            },
          }));

          const createdParentNotes = applied.files
            .filter((file) => file.createdParentDirectories)
            .map(
              (file) =>
                `Created parent directories for ${file.relativePath}: ${file.parentDirectory}`
            );
          return withPreMutationCheckpointOutput(
            {
              text: [
                `Applied workspace edits to ${changed.length} of ${prepared.length} file(s)`,
                ...createdParentNotes,
                ...applied.files.map(
                  (file) =>
                    `${file.relativePath}: ${file.charsBefore} -> ${file.charsAfter} chars, snapshotTag ${file.newSnapshotTag}`
                ),
              ].join('\n'),
              artifacts: diffArtifacts,
              json: {
                ok: true,
                changed: true,
                fileCount: prepared.length,
                changedFileCount: changed.length,
                files: workspaceEditResultFilesJson(prepared, applied.files),
              } as JsonObject,
            },
            mutationCheckpoint
          );
        }
      );
    },
  });
}

function workspaceEditFileInputs(input: JsonObject): JsonObject[] {
  const value = input.files;
  if (!Array.isArray(value)) {
    throw new Error('files must be an array of workspace edit file objects');
  }
  if (value.length === 0) {
    throw new Error('files must contain at least one workspace edit');
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new Error(`files[${index}] must be an object`);
    }
    return item;
  });
}

function parseWorkspaceEditFileRequests(
  workspaceRoot: string,
  input: JsonObject
): WorkspaceEditFileRequest[] {
  const files = workspaceEditFileInputs(input);
  const seen = new Map<string, string>();
  return files.map((fileInput, index) => {
    const filePath = resolveWorkspacePath(
      workspaceRoot,
      requireString(fileInput, 'path')
    );
    const relativePath = displayPath(workspaceRoot, filePath);
    const normalizedPath = normalizeForCompare(filePath);
    const previous = seen.get(normalizedPath);
    if (previous) {
      throw new Error(
        `Duplicate workspace edit target: ${previous} and ${relativePath}`
      );
    }
    seen.set(normalizedPath, relativePath);

    const fullContent = stringField(fileInput, 'content');
    const topLevelReplace = textReplaceFields(fileInput);
    const edits = editOperationsField(fileInput, 'edits');
    const preparedEdits =
      topLevelReplace !== undefined
        ? [
            {
              op: 'replace_text' as const,
              oldString: topLevelReplace.oldString,
              newString: topLevelReplace.newString,
            },
            ...edits,
          ]
        : edits;
    const modeCount =
      (fullContent !== undefined ? 1 : 0) +
      (topLevelReplace !== undefined ? 1 : 0) +
      (edits.length > 0 ? 1 : 0);
    if (modeCount > 1) {
      throw new Error(
        `files[${index}] accepts only one of: content, old_string/new_string, or edits`
      );
    }
    if (fullContent === undefined && preparedEdits.length === 0) {
      throw new Error(
        `files[${index}] requires content for a full write, old_string/new_string for content seek, or at least one edit`
      );
    }
    const encodingField = stringField(fileInput, 'encoding');
    return {
      input: fileInput,
      filePath,
      relativePath,
      ...(fullContent !== undefined ? { fullContent } : {}),
      edits: preparedEdits,
      ...(encodingField !== undefined ? { encoding: encodingField } : {}),
    };
  });
}

async function prepareWorkspaceEditFiles(
  options: LocalToolOptions,
  context: ToolExecutionContext,
  files: WorkspaceEditFileRequest[]
): Promise<PreparedWorkspaceEditFile[]> {
  const prepared: PreparedWorkspaceEditFile[] = [];
  for (const file of files) {
    const fileStat = await stat(file.filePath).catch(() => null);
    if (fileStat && !fileStat.isFile()) {
      throw new Error(
        `Workspace edit target must be a file or missing file: ${file.relativePath}`
      );
    }
    if (
      !fileStat &&
      file.edits.length > 0 &&
      !file.edits.every(
        (op) => op.op === 'insert_head' || op.op === 'insert_tail'
      )
    ) {
      throw new Error(
        `Cannot apply line edits to a missing file: ${file.relativePath}. Use content, insert_head, or insert_tail to create it.`
      );
    }

    const beforeBytes = fileStat ? await readFile(file.filePath) : null;
    const beforeDecoded = beforeBytes ? decodeTextBuffer(beforeBytes) : null;
    if (beforeDecoded?.encoding === 'binary') {
      throw new Error(
        `File is binary and cannot be edited as text: ${file.relativePath}`
      );
    }

    const snapshotTag = beforeBytes ? computeSnapshotTag(beforeBytes) : null;
    const inputSnapshotTag = stringField(file.input, 'snapshotTag');
    const latestReadSnapshotTag = inputSnapshotTag
      ? undefined
      : options.mutationCoordinator?.latestReadSnapshot(
          context.sessionId,
          file.filePath
        );
    const requestedSnapshotTag =
      inputSnapshotTag ?? latestReadSnapshotTag ?? null;
    const snapshotTagSource: 'input' | 'latest-read' | 'none' = inputSnapshotTag
      ? 'input'
      : latestReadSnapshotTag
        ? 'latest-read'
        : 'none';
    if (requestedSnapshotTag && snapshotTag !== requestedSnapshotTag) {
      throw new Error(
        `Stale snapshotTag for ${file.relativePath}: expected ${requestedSnapshotTag}, current ${snapshotTag ?? 'missing'}. Re-read with read before editing.`
      );
    }

    const beforeText = beforeDecoded?.text ?? '';
    const afterText =
      file.fullContent !== undefined
        ? file.fullContent
        : applyEditOperations(beforeText, file.edits);
    const changed = beforeText !== afterText;
    const writeEncoding = changed
      ? await resolveWriteEncoding(file.filePath, file.encoding)
      : beforeDecoded &&
          (beforeDecoded.encoding === 'utf-8' ||
            beforeDecoded.encoding === 'utf-8-bom' ||
            beforeDecoded.encoding === 'utf-16le' ||
            beforeDecoded.encoding === 'utf-16be')
        ? beforeDecoded.encoding
        : 'utf-8';
    prepared.push({
      ...file,
      existed: !!fileStat,
      beforeBytes,
      beforeText,
      afterText,
      changed,
      writeEncoding,
      snapshotTag,
      requestedSnapshotTag,
      snapshotTagSource,
      createdParentDirectories: false,
      parentDirectory: displayPath(
        options.workspaceRoot,
        dirname(file.filePath)
      ),
    });
  }
  return prepared;
}

async function applyPreparedWorkspaceEditFiles(
  files: PreparedWorkspaceEditFile[]
): Promise<ApplyPreparedWorkspaceEditFilesResult> {
  const rollbackStates = files.map(workspaceEditRollbackState);
  const applied: AppliedWorkspaceEditFile[] = [];
  let activeFile: PreparedWorkspaceEditFile | undefined;

  try {
    for (const file of files) {
      activeFile = file;
      const parentInfo = await ensureParentDirectoryForWrite(file.filePath, {
        existed: file.existed,
        relativePath: file.relativePath,
      });
      const afterBytes = encodeTextBuffer(file.afterText, file.writeEncoding);
      await writeBytesAtomically(file.filePath, afterBytes, {
        createParents: false,
      });
      applied.push({
        ...file,
        createdParentDirectories: parentInfo.created,
        parentDirectory: parentInfo.parentDisplay,
        newSnapshotTag: computeSnapshotTag(afterBytes),
        charsBefore: file.beforeText.length,
        charsAfter: file.afterText.length,
      });
    }
    return { ok: true, files: applied };
  } catch (error) {
    const rollback = await rollbackWorkspaceEditFiles(rollbackStates);
    const failedPathValue = activeFile?.relativePath;
    return {
      ok: false,
      error: errorToString(error),
      ...(failedPathValue !== undefined ? { failedPath: failedPathValue } : {}),
      rollback,
    };
  }
}

function workspaceEditRollbackState(
  file: PreparedWorkspaceEditFile
): WorkspaceEditRollbackState {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    existed: file.existed,
    bytes: file.beforeBytes ? Buffer.from(file.beforeBytes) : null,
  };
}

async function rollbackWorkspaceEditFiles(
  states: WorkspaceEditRollbackState[]
): Promise<{
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}> {
  const summary: {
    restored: string[];
    deleted: string[];
    failed: Array<{ path: string; error: string }>;
  } = { restored: [], deleted: [], failed: [] };
  for (const state of states) {
    try {
      if (state.existed) {
        if (!state.bytes) {
          throw new Error('Rollback state is missing original bytes');
        }
        await mkdir(dirname(state.filePath), { recursive: true });
        await rm(state.filePath, { recursive: true, force: true }).catch(
          () => undefined
        );
        await writeBytesAtomically(state.filePath, state.bytes);
        summary.restored.push(state.relativePath);
      } else {
        await rm(state.filePath, { recursive: true, force: true });
        summary.deleted.push(state.relativePath);
      }
    } catch (error) {
      summary.failed.push({
        path: state.relativePath,
        error: errorToString(error),
      });
    }
  }
  return summary;
}

function summarizeWorkspaceEditTargets(
  files: WorkspaceEditFileRequest[]
): string {
  const paths = files.map((file) => file.relativePath);
  const preview = paths.slice(0, 5).join(', ');
  return `${files.length} file${files.length === 1 ? '' : 's'}: ${preview}${paths.length > 5 ? ', ...' : ''}`;
}

function preparedWorkspaceEditFileToJson(
  file: PreparedWorkspaceEditFile
): JsonObject {
  return {
    path: file.relativePath,
    changed: file.changed,
    existed: file.existed,
    operationCount: file.fullContent !== undefined ? 1 : file.edits.length,
    snapshotTag: file.snapshotTag,
    requestedSnapshotTag: file.requestedSnapshotTag,
    snapshotTagSource: file.snapshotTagSource,
    encoding: file.writeEncoding,
    charsBefore: file.beforeText.length,
    charsAfter: file.afterText.length,
    createdParentDirectories: file.createdParentDirectories,
    parentDirectory: file.parentDirectory,
  };
}

function appliedWorkspaceEditFileToJson(
  file: AppliedWorkspaceEditFile
): JsonObject {
  return {
    ...preparedWorkspaceEditFileToJson(file),
    newSnapshotTag: file.newSnapshotTag,
    charsBefore: file.charsBefore,
    charsAfter: file.charsAfter,
  };
}

function workspaceEditResultFilesJson(
  prepared: PreparedWorkspaceEditFile[],
  applied: AppliedWorkspaceEditFile[]
): JsonValue {
  const appliedByPath = new Map(
    applied.map((file) => [normalizeForCompare(file.filePath), file])
  );
  return prepared.map((file) => {
    const appliedFile = appliedByPath.get(normalizeForCompare(file.filePath));
    return appliedFile
      ? appliedWorkspaceEditFileToJson(appliedFile)
      : preparedWorkspaceEditFileToJson(file);
  }) as unknown as JsonValue;
}
