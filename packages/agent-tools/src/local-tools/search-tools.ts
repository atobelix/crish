import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { JsonValue, ToolExecutionContext } from '@crish/shared-types';
import { decodeTextBuffer } from '@crish/agent-context';
import { defineTool } from '../tools';
import type { AgentTool } from '@crish/shared-types';
import {
  booleanField,
  displayPath,
  requireString,
  resolveWorkspacePath,
  stringField,
} from './shared';
import type { LocalToolOptions } from './types';

export function createSearchFilesTool(
  options: LocalToolOptions & {
    name?: string;
    maxFiles?: number;
    maxMatches?: number;
    maxFileBytes?: number;
  }
): AgentTool {
  const maxFiles = options.maxFiles ?? 2_000;
  const maxMatches = options.maxMatches ?? 200;
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  return defineTool({
    name: options.name ?? 'search_files',
    label: 'Search files',
    description:
      'Search text files in the workspace by substring or regular expression.',
    category: 'filesystem',
    concurrency: 'parallel',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        regex: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    summarize(input) {
      return `search ${requireString(input, 'query')}`;
    },
    async execute(input, context) {
      const query = requireString(input, 'query');
      const root = resolveWorkspacePath(
        options.workspaceRoot,
        stringField(input, 'path') ?? '.'
      );
      const matcher = booleanField(input, 'regex') ? new RegExp(query) : null;
      const matches: SearchMatch[] = [];
      let visitedFiles = 0;

      for await (const filePath of walkFiles(root, context, maxFiles)) {
        visitedFiles += 1;
        const fileStat = await stat(filePath);
        if (fileStat.size > maxFileBytes) continue;
        const raw = await readFile(filePath).catch(() => new Uint8Array(0));
        if (raw.byteLength === 0) continue;
        const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        const decoded = decodeTextBuffer(bytes);
        if (decoded.encoding === 'binary' || !decoded.text) continue;
        const text = decoded.text;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (matcher ? matcher.test(line) : line.includes(query)) {
            matches.push({
              path: displayPath(options.workspaceRoot, filePath),
              line: index + 1,
              preview: line.trim(),
            });
            if (matches.length >= maxMatches) break;
          }
        }
        if (matches.length >= maxMatches) break;
      }

      const rootDisplay = displayPath(options.workspaceRoot, root);
      const truncated = matches.length >= maxMatches;
      const header = [
        `query: ${query}`,
        `root: ${rootDisplay}`,
        `matches: ${matches.length}`,
        `visitedFiles: ${visitedFiles}`,
        truncated ? 'truncated: true' : undefined,
        '---',
      ]
        .filter((line): line is string => typeof line === 'string')
        .join('\n');
      const body =
        matches.length === 0
          ? '(no matches)'
          : matches
              .map((match) => `${match.path}:${match.line}: ${match.preview}`)
              .join('\n');
      return {
        text: `${header}\n${body}`,
        json: {
          query,
          root: rootDisplay,
          visitedFiles,
          matchCount: matches.length,
          truncated,
          matches: matches as unknown as JsonValue,
        },
      };
    },
  });
}

interface SearchMatch {
  path: string;
  line: number;
  preview: string;
}

async function* walkFiles(
  root: string,
  context: ToolExecutionContext,
  maxFiles: number
): AsyncIterable<string> {
  const stack = [root];
  let yielded = 0;
  while (stack.length > 0 && yielded < maxFiles) {
    if (context.signal.aborted) return;
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue;
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        yielded += 1;
        yield fullPath;
        if (yielded >= maxFiles) return;
      }
    }
  }
}

function shouldSkip(name: string): boolean {
  return [
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    '.turbo',
    '.cache',
  ].includes(name);
}
