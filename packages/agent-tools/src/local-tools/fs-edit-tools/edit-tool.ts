import { stat, readFile, writeFile } from 'node:fs/promises';
import type { JsonObject, ToolArtifact } from '@crish/shared-types';
import { replaceViaSeekSequence, type SeekPass } from '@crish/shared-utils';
import { decodeTextBuffer, encodeTextBuffer } from '@crish/agent-context';
import { createFileSnapshot } from '@crish/agent-context';
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
  requireString,
  resolveWorkspacePath,
  stringField,
  withLocalMutationLease,
  splitTextLines,
  detectLineEnding,
} from '../shared';
import type { LocalToolOptions } from '../types';
import type { EditOperation } from './types';
import {
  resolveWriteEncoding,
  createUnifiedDiffPreview,
  createEditResultPreview,
  textReplaceFields,
  editOperationsField,
} from './utils';

export function createEditTool(
  options: LocalToolOptions & { name?: string }
): AgentTool {
  const toolName = options.name ?? 'edit';
  return defineTool({
    name: toolName,
    label: 'Edit',
    description:
      'Apply safe workspace edits with optional snapshotTag stale-read checks. Prefer replace_text (old_string/new_string content seek) or small line edits; use full content only for short files.',
    category: 'filesystem',
    concurrency: 'exclusive',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        snapshotTag: {
          type: 'string',
          description:
            'Snapshot tag returned by read. If stale, the edit is rejected so the file can be re-read.',
        },
        content: {
          type: 'string',
          description:
            'Full replacement content. Use instead of edits for creating or overwriting a file.',
        },
        old_string: {
          type: 'string',
          description:
            'Text to find via 4-pass seek (exact->rstrip->trim->unicode). Unique match required. Alternative to edits[].op=replace_text.',
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
    isReadOnly: () => false,
    summarize(input) {
      return `edit ${stringField(input, 'path') ?? '<missing path>'}`;
    },
    async execute(input, context) {
      const filePath = resolveWorkspacePath(
        options.workspaceRoot,
        requireString(input, 'path')
      );
      const relativePath = displayPath(options.workspaceRoot, filePath);
      return withLocalMutationLease(
        options,
        context,
        {
          scope: { type: 'files', paths: [filePath] },
          toolName,
          cwd: options.workspaceRoot,
          targetSummary: relativePath,
        },
        async () => {
          const fileStat = await stat(filePath).catch(() => null);
          if (fileStat && !fileStat.isFile()) {
            throw new Error(
              `Edit target must be a file or missing file: ${relativePath}`
            );
          }

          const fullContent = stringField(input, 'content');
          const topLevelReplace = textReplaceFields(input);
          const edits = editOperationsField(input, 'edits');
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
              'edit accepts only one of: content, old_string/new_string, or edits'
            );
          }
          if (fullContent === undefined && preparedEdits.length === 0) {
            throw new Error(
              'edit requires content for a full write, old_string/new_string for content seek, or at least one edit'
            );
          }
          if (
            !fileStat &&
            preparedEdits.length > 0 &&
            !preparedEdits.every(isBoundaryInsertOperation)
          ) {
            throw new Error(
              `Cannot apply line edits to a missing file: ${relativePath}. Use content, insert_head, or insert_tail to create it.`
            );
          }

          const beforeBytes = fileStat ? await readFile(filePath) : null;
          const beforeDecoded = beforeBytes
            ? decodeTextBuffer(beforeBytes)
            : null;
          if (beforeDecoded?.encoding === 'binary') {
            throw new Error(
              `File is binary and cannot be edited as text: ${relativePath}`
            );
          }

          const currentSnapshotTag = beforeBytes
            ? computeSnapshotTag(beforeBytes)
            : undefined;
          const requestedSnapshotTag = stringField(input, 'snapshotTag');
          if (
            requestedSnapshotTag &&
            currentSnapshotTag &&
            requestedSnapshotTag !== currentSnapshotTag
          ) {
            throw new Error(
              `Stale snapshotTag for ${relativePath}: expected ${requestedSnapshotTag}, current ${currentSnapshotTag}. Re-read with read before editing.`
            );
          }

          const beforeText = beforeDecoded?.text ?? '';
          const afterText =
            fullContent !== undefined
              ? fullContent
              : applyEditOperations(beforeText, preparedEdits);
          if (fileStat && beforeText === afterText) {
            return {
              text: `No changes for ${relativePath}`,
              json: {
                path: relativePath,
                changed: false,
                snapshotTag: currentSnapshotTag ?? null,
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
              targetSummary: summarizeEditTarget(
                relativePath,
                fullContent,
                preparedEdits
              ),
              input,
            }
          );
          const snapshot = await createFileSnapshot({
            workspaceRoot: options.workspaceRoot,
            filePath,
            sessionId: context.sessionId,
            toolCallId: context.toolCallId,
            ...(options.snapshot ? { options: options.snapshot } : {}),
          });
          const parentInfo = await ensureParentDirectoryForWrite(filePath, {
            existed: !!fileStat,
            relativePath,
            workspaceRoot: options.workspaceRoot,
          });
          const encoding = await resolveWriteEncoding(
            filePath,
            stringField(input, 'encoding')
          );
          const afterBytes = encodeTextBuffer(afterText, encoding);
          await writeFile(filePath, afterBytes);
          const newSnapshotTag = computeSnapshotTag(afterBytes);
          const diffPreview = createUnifiedDiffPreview(beforeText, afterText);
          const resultPreview = createEditResultPreview(
            beforeText,
            afterText,
            fullContent !== undefined
          );
          const diffArtifact: ToolArtifact = {
            kind: 'diff',
            title: `Diff: ${relativePath}`,
            text: diffPreview,
            metadata: {
              artifactKind: 'edit-diff-preview',
              path: relativePath,
            },
          };

          return withPreMutationCheckpointOutput(
            {
              text: [
                `Edited ${relativePath}`,
                parentInfo.created
                  ? `Created parent directories: ${parentInfo.parentDisplay}`
                  : undefined,
                `Encoding: ${encoding}`,
                `Snapshot tag: ${newSnapshotTag}`,
                resultPreview.summary,
                resultPreview.text,
                `Diff preview:`,
                diffPreview,
              ]
                .filter((line): line is string => typeof line === 'string')
                .join('\n'),
              artifacts: [snapshot, diffArtifact].filter(
                (artifact): artifact is ToolArtifact => artifact !== null
              ),
              json: {
                path: relativePath,
                changed: true,
                encoding,
                charsBefore: beforeText.length,
                charsAfter: afterText.length,
                snapshotTag: currentSnapshotTag ?? null,
                newSnapshotTag,
                createdParentDirectories: parentInfo.created,
                parentDirectory: parentInfo.parentDisplay,
                snapshot: snapshot?.metadata ?? null,
                resultPreview: {
                  mode: resultPreview.mode,
                  summary: resultPreview.summary,
                  text: resultPreview.text,
                  startLine: resultPreview.startLine,
                  endLine: resultPreview.endLine,
                  totalLines: resultPreview.totalLines,
                  truncated: resultPreview.truncated,
                  omittedLines: resultPreview.omittedLines,
                },
                diffPreview,
              } as JsonObject,
            },
            mutationCheckpoint
          );
        }
      );
    },
  });
}

function summarizeEditTarget(
  relativePath: string,
  fullContent: string | undefined,
  edits: EditOperation[]
): string {
  if (fullContent !== undefined)
    return `${relativePath} full write (${fullContent.length} chars)`;
  const operations = edits.map((edit) => edit.op).join(', ');
  return `${relativePath} ${edits.length} edit${edits.length === 1 ? '' : 's'}${operations ? ` (${operations})` : ''}`;
}

export function applyEditOperations(
  text: string,
  operations: EditOperation[]
): string {
  const replaceTextOps = operations.filter(
    (operation) => operation.op === 'replace_text'
  );
  const lineOps = operations.filter(
    (operation) => operation.op !== 'replace_text'
  );

  let current = text;
  for (let i = 0; i < replaceTextOps.length; i++) {
    current = applyReplaceTextOperation(current, replaceTextOps[i]!, i);
  }
  if (lineOps.length === 0) return current;
  return applyLineEditOperations(current, lineOps);
}

function applyReplaceTextOperation(
  text: string,
  operation: EditOperation,
  index: number
): string {
  const oldString = operation.oldString ?? '';
  const newString = operation.newString ?? '';
  const result = replaceViaSeekSequence(text, oldString, newString);
  if ('error' in result) {
    throw new Error(formatReplaceTextSeekError(result, index));
  }
  return result.content;
}

function formatReplaceTextSeekError(
  result: {
    error: 'missing' | 'ambiguous';
    matchCount: number;
    passTried: SeekPass[];
  },
  index: number
): string {
  const tried =
    result.passTried.length > 0
      ? result.passTried
          .map((pass) => (pass === 'normalized' ? 'unicode' : pass))
          .join('+')
      : 'none';
  const where = `replace_text${typeof index === 'number' ? `[${index}]` : ''}`;
  if (result.error === 'ambiguous') {
    return (
      `${where} seek failed: old_string matched ${result.matchCount} times (ambiguous) ` +
      `after trying ${tried}. Provide more surrounding context so the match is unique.`
    );
  }
  return (
    `${where} seek failed: old_string not found after trying ${tried}. ` +
    `Re-read the file and use an exact unique snippet (or line-number ops with snapshotTag).`
  );
}

function applyLineEditOperations(
  text: string,
  operations: EditOperation[]
): string {
  const lineEnding = detectLineEnding(text);
  const lines = splitTextLines(text);
  const sorted = [...operations].sort(
    (left, right) => operationSortLine(right) - operationSortLine(left)
  );

  for (const operation of sorted) {
    applyLineEditOperation(lines, operation);
  }

  return lines.join(lineEnding);
}

function isBoundaryInsertOperation(operation: EditOperation): boolean {
  return operation.op === 'insert_head' || operation.op === 'insert_tail';
}

function operationSortLine(operation: EditOperation): number {
  if (operation.op === 'insert_tail') return Number.MAX_SAFE_INTEGER;
  if (operation.op === 'insert_head') return 0;
  if (operation.op === 'replace_text') return 0;
  return operation.startLine ?? operation.line ?? 1;
}

function applyLineEditOperation(
  lines: string[],
  operation: EditOperation
): void {
  if (operation.op === 'replace_text') {
    throw new Error(
      'replace_text must be applied via content seek, not line-number ops'
    );
  }

  const contentLines =
    operation.content !== undefined ? splitTextLines(operation.content) : [];

  if (operation.op === 'insert_head') {
    if (isEmptyLineBuffer(lines)) {
      lines.splice(0, lines.length, ...contentLines);
      return;
    }
    lines.splice(0, 0, ...contentLines);
    return;
  }

  if (operation.op === 'insert_tail') {
    if (isEmptyLineBuffer(lines)) {
      lines.splice(0, lines.length, ...contentLines);
      return;
    }
    const fileHasTrailingEmpty =
      lines.length > 0 && lines[lines.length - 1] === '';
    let insertLines = contentLines;
    const contentHasTrailingEmpty =
      insertLines.length > 0 && insertLines[insertLines.length - 1] === '';
    if (fileHasTrailingEmpty && contentHasTrailingEmpty) {
      insertLines = insertLines.slice(0, -1);
    }
    const insertIndex = fileHasTrailingEmpty ? lines.length - 1 : lines.length;
    lines.splice(insertIndex, 0, ...insertLines);
    return;
  }

  const lineCount = lines.length;
  if (operation.op === 'insert_before' || operation.op === 'insert_after') {
    const rawLine = operation.line ?? operation.startLine;
    if (rawLine === undefined) {
      throw new Error(`${operation.op} requires line or startLine`);
    }
    const line = requireLineInRange(rawLine, lineCount, 'line');
    const insertIndex = operation.op === 'insert_before' ? line - 1 : line;
    lines.splice(insertIndex, 0, ...contentLines);
    return;
  }

  const rawStart = operation.startLine ?? operation.line;
  if (rawStart === undefined) {
    throw new Error(`${operation.op} requires startLine or line`);
  }
  const startLine = requireLineInRange(rawStart, lineCount, 'startLine');
  const rawEnd =
    operation.endLine ?? operation.line ?? operation.startLine ?? startLine;
  const endLine = requireLineInRange(rawEnd, lineCount, 'endLine');
  if (endLine < startLine) {
    throw new Error(`endLine ${endLine} must be >= startLine ${startLine}`);
  }
  const deleteCount = endLine - startLine + 1;
  if (operation.op === 'delete') {
    lines.splice(startLine - 1, deleteCount);
    return;
  }
  lines.splice(startLine - 1, deleteCount, ...contentLines);
}

function isEmptyLineBuffer(lines: string[]): boolean {
  return lines.length === 0 || (lines.length === 1 && lines[0] === '');
}

function requireLineInRange(
  line: number,
  lineCount: number,
  label: string
): number {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (lineCount < 1) {
    throw new Error(`${label} ${line} is out of range for an empty file`);
  }
  if (line > lineCount) {
    throw new Error(
      `${label} ${line} is out of range (file has ${lineCount} line${lineCount === 1 ? '' : 's'})`
    );
  }
  return line;
}
