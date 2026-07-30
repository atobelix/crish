import type { JsonObject, JsonValue } from '@crish/shared-types';
import { decodeTextBuffer } from '@crish/agent-context';
import { defineTool } from '../tools';
import type { AgentTool } from '@crish/shared-types';
import {
  computeSnapshotTag,
  displayPath,
  formatListingText,
  formatNumberedLines,
  numberField,
  positiveNumberField,
  booleanField,
  readFileOrThrow,
  readdirOrThrow,
  recordReadSnapshot,
  requireString,
  resolveWorkspacePath,
  splitTextLines,
  statOrThrow,
  stringField,
  type ListingEntryKind,
} from './shared';
import type { LocalToolOptions } from './types';

export function createReadFileTool(
  options: LocalToolOptions & { maxBytes?: number; name?: string }
): AgentTool {
  const maxBytes = options.maxBytes ?? 256_000;
  return defineTool({
    name: options.name ?? 'read_file',
    label: 'Legacy read file',
    description:
      'Explicit legacy read_file factory for tests and migration scripts. Product runtimes should use the unified read tool.',
    category: 'filesystem',
    concurrency: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxBytes: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    summarize(input) {
      return `read ${stringField(input, 'path') ?? '<missing path>'}`;
    },
    async execute(input, context) {
      const relativePath = requireString(input, 'path');
      const filePath = resolveWorkspacePath(
        options.workspaceRoot,
        relativePath
      );
      const limit = Math.max(
        1,
        positiveNumberField(input, 'maxBytes') ?? maxBytes
      );
      const bytes = await readFileOrThrow(
        filePath,
        displayPath(options.workspaceRoot, filePath)
      );
      const decoded = decodeTextBuffer(bytes);
      if (decoded.encoding === 'binary') {
        throw new Error(
          `File is binary and cannot be read as text: ${displayPath(options.workspaceRoot, filePath)}`
        );
      }
      const totalChars = decoded.text.length;
      const truncated = totalChars > limit || bytes.byteLength > limit;
      const shown = truncated ? decoded.text.slice(0, limit) : decoded.text;
      const snapshotTag = computeSnapshotTag(bytes);
      recordReadSnapshot(options, context, filePath, snapshotTag);
      const text = truncated
        ? `${shown}\n... truncated: showing ${shown.length} of ${totalChars} chars (${bytes.byteLength} bytes) ...`
        : shown;
      return {
        text,
        json: {
          path: displayPath(options.workspaceRoot, filePath),
          bytes: bytes.byteLength,
          encoding: decoded.encoding,
          hasBom: decoded.hasBom,
          snapshotTag,
          truncated,
          totalChars,
          shownChars: shown.length,
        },
      };
    },
  });
}

export function createReadTool(
  options: LocalToolOptions & { maxBytes?: number; name?: string }
): AgentTool {
  const maxBytes = options.maxBytes ?? 256_000;
  return defineTool({
    name: options.name ?? 'read',
    label: 'Read',
    description:
      'Read a workspace file or list a directory. File reads include line numbers and a snapshot tag for safe edits.',
    category: 'filesystem',
    concurrency: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Workspace path. Supports file selectors like src/app.ts:10, src/app.ts:10-25, or src/app.ts:10+5.',
        },
        maxBytes: { type: 'number' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
        numbered: { type: 'boolean' },
        format: {
          type: 'string',
          enum: ['numbered', 'plain'],
          description: 'Output format for text reads.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    summarize(input) {
      return `read ${stringField(input, 'path') ?? '<missing path>'}`;
    },
    async execute(input, context) {
      const selector = parseReadPathSelector(requireString(input, 'path'));
      const explicitStartLine = numberField(input, 'startLine');
      const explicitEndLine = numberField(input, 'endLine');
      const selectedStartLine = explicitStartLine ?? selector.startLine;
      const selectedEndLine = explicitEndLine ?? selector.endLine;
      const targetPath = resolveWorkspacePath(
        options.workspaceRoot,
        selector.path
      );
      const relativeDisplay = displayPath(options.workspaceRoot, targetPath);
      const targetStat = await statOrThrow(targetPath, relativeDisplay);

      if (targetStat.isDirectory()) {
        const entries = await readdirOrThrow(targetPath, relativeDisplay);
        const items = entries
          .map((entry) => ({
            name: entry.name,
            kind: (entry.isDirectory()
              ? 'directory'
              : entry.isFile()
                ? 'file'
                : 'other') as ListingEntryKind,
          }))
          .sort((left, right) =>
            `${left.kind}:${left.name}`.localeCompare(
              `${right.kind}:${right.name}`
            )
          );
        return {
          text: formatListingText(items),
          json: {
            path: relativeDisplay,
            kind: 'directory',
            items: items as unknown as JsonValue,
          } as JsonObject,
        };
      }

      if (!targetStat.isFile()) {
        throw new Error(`Path is not a file or directory: ${relativeDisplay}`);
      }

      const bytes = await readFileOrThrow(targetPath, relativeDisplay);
      const decoded = decodeTextBuffer(bytes);
      if (decoded.encoding === 'binary') {
        throw new Error(
          `File is binary and cannot be read as text: ${relativeDisplay}`
        );
      }

      const lines = splitTextLines(decoded.text);
      const selection = selectLineRange(
        lines,
        selectedStartLine,
        selectedEndLine
      );
      const lineFormat = readLineFormat(input);
      const selectedText = formatReadLines(
        selection.lines,
        selection.startLine,
        lineFormat
      );
      const limit = Math.max(
        1,
        positiveNumberField(input, 'maxBytes') ?? maxBytes
      );
      const totalSelectedChars = selectedText.length;
      const truncated = totalSelectedChars > limit;
      const shownText = truncated ? selectedText.slice(0, limit) : selectedText;
      const snapshotTag = computeSnapshotTag(bytes);
      recordReadSnapshot(options, context, targetPath, snapshotTag);
      const header = [
        `path: ${relativeDisplay}`,
        `snapshotTag: ${snapshotTag}`,
        `encoding: ${decoded.encoding}`,
        `lines: ${lines.length}`,
        `selectedLines: ${selection.startLine}-${selection.endLine}`,
        truncated
          ? `truncated: true (showing ${shownText.length} of ${totalSelectedChars} chars; file has ${lines.length} lines, ${decoded.text.length} chars, ${bytes.byteLength} bytes)`
          : undefined,
        '---',
      ]
        .filter((line): line is string => typeof line === 'string')
        .join('\n');

      return {
        text: `${header}\n${truncated ? `${shownText}\n... truncated ...` : shownText}`,
        json: {
          path: relativeDisplay,
          kind: 'file',
          bytes: bytes.byteLength,
          encoding: decoded.encoding,
          hasBom: decoded.hasBom,
          lineCount: lines.length,
          totalChars: decoded.text.length,
          selectedStartLine: selection.startLine,
          selectedEndLine: selection.endLine,
          selectedChars: totalSelectedChars,
          shownChars: shownText.length,
          lineFormat,
          snapshotTag,
          truncated,
        } as JsonObject,
      };
    },
  });
}

export function createListDirectoryTool(
  options: LocalToolOptions & { name?: string }
): AgentTool {
  return defineTool({
    name: options.name ?? 'list_directory',
    label: 'List directory',
    description: 'List files and folders in a workspace directory.',
    category: 'filesystem',
    concurrency: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
    isReadOnly: () => true,
    summarize(input) {
      return `list ${stringField(input, 'path') ?? '.'}`;
    },
    async execute(input) {
      const inputPath = stringField(input, 'path') ?? '.';
      const directory = resolveWorkspacePath(options.workspaceRoot, inputPath);
      const relativeDisplay = displayPath(options.workspaceRoot, directory);
      await statOrThrow(directory, relativeDisplay);
      const entries = await readdirOrThrow(directory, relativeDisplay);
      const items = entries
        .map((entry) => ({
          name: entry.name,
          kind: (entry.isDirectory()
            ? 'directory'
            : entry.isFile()
              ? 'file'
              : 'other') as ListingEntryKind,
        }))
        .sort((left, right) =>
          `${left.kind}:${left.name}`.localeCompare(
            `${right.kind}:${right.name}`
          )
        );
      return {
        text: formatListingText(items),
        json: {
          path: relativeDisplay,
          items: items as unknown as JsonValue,
        },
      };
    },
  });
}

function parseReadPathSelector(inputPath: string): {
  path: string;
  startLine?: number;
  endLine?: number;
} {
  const match = inputPath.match(/^(.+):(\d+)(?:-(\d+)|\+(\d+))?$/);
  if (!match) return { path: inputPath };

  const startLine = Number(match[2]);
  const explicitEnd = match[3] ? Number(match[3]) : undefined;
  const length = match[4] ? Number(match[4]) : undefined;
  if (!Number.isSafeInteger(startLine) || startLine < 1)
    return { path: inputPath };
  if (
    explicitEnd !== undefined &&
    (!Number.isSafeInteger(explicitEnd) || explicitEnd < startLine)
  )
    return { path: inputPath };
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 1))
    return { path: inputPath };

  return {
    path: match[1]!,
    startLine,
    endLine:
      explicitEnd ??
      (length !== undefined ? startLine + length - 1 : startLine),
  };
}

function selectLineRange(
  lines: string[],
  startLine: number | undefined,
  endLine: number | undefined
): { lines: string[]; startLine: number; endLine: number } {
  const lineCount = Math.max(1, lines.length);
  const start = clampLine(startLine ?? 1, lineCount);
  const end = clampLine(endLine ?? lineCount, lineCount);
  const normalizedEnd = Math.max(start, end);
  return {
    lines: lines.slice(start - 1, normalizedEnd),
    startLine: start,
    endLine: normalizedEnd,
  };
}

function clampLine(value: number, lineCount: number): number {
  if (!Number.isSafeInteger(value)) return 1;
  return Math.min(Math.max(1, value), lineCount);
}

type ReadLineFormat = 'numbered' | 'plain';

function readLineFormat(input: JsonObject): ReadLineFormat {
  const value = stringField(input, 'format');
  if (value === 'numbered' || value === 'plain') return value;
  return booleanField(input, 'numbered') === false ? 'plain' : 'numbered';
}

function formatReadLines(
  lines: string[],
  startLine: number,
  format: ReadLineFormat
): string {
  if (format === 'plain') return lines.join('\n');
  return formatNumberedLines(lines, startLine);
}
