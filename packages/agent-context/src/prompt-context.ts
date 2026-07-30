import { createHash } from 'node:crypto';
import type { PromptAssemblyContextBlock } from './prompt-assembly';
import type {
  ProjectProgressLedger,
  ProjectProgressSnapshot,
} from './project-progress-ledger';
import type {
  ScopedContextCandidate,
  ScopedContextDiagnostic,
  ScopedContextResolution,
} from './scoped-context';
import type { JsonObject, JsonValue } from '@crish/shared-types';

export const PROMPT_CONTEXT_COMPOSER_VERSION = 1;

export interface PromptContextProgressInput {
  stableLines?: string[];
  recentTaskLines?: string[];
}

export interface PromptContextComposerInput {
  scopedContext?: ScopedContextResolution;
  projectProgress?:
    | ProjectProgressLedger
    | ProjectProgressSnapshot
    | PromptContextProgressInput;
  stableContext?: PromptAssemblyContextBlock[];
  volatileContext?: PromptAssemblyContextBlock[];
}

export interface PromptContextComposerMetadata {
  version: typeof PROMPT_CONTEXT_COMPOSER_VERSION;
  stableContextHash: string;
  volatileContextHash: string;
  stableBlockIds: string[];
  volatileBlockIds: string[];
  boundary: {
    stable: {
      globalProjectRules: string[];
      enabledSkills: string[];
      sharedProjectProgress: string[];
      custom: string[];
    };
    volatile: {
      parentRuntimeIds: string[];
      cwd: string[];
      taskCard: string[];
      recentChildTaskRecords: string[];
      currentUserTurn: string[];
      custom: string[];
    };
  };
}

export interface PromptContextComposition {
  stableContext: PromptAssemblyContextBlock[];
  volatileContext: PromptAssemblyContextBlock[];
  recommended: ScopedContextCandidate[];
  diagnostics: ScopedContextDiagnostic[];
  metadata: PromptContextComposerMetadata;
}

export function composePromptContext(
  input: PromptContextComposerInput
): PromptContextComposition {
  const progress = normalizeProgress(input.projectProgress);
  const stableContext = compactContextBlocks([
    ...(input.scopedContext?.stableContext ?? []),
    ...progressStableBlocks(progress),
    ...(input.stableContext ?? []),
  ]);
  const volatileContext = compactContextBlocks([
    ...progressVolatileBlocks(progress),
    ...(input.volatileContext ?? []),
  ]);
  return {
    stableContext,
    volatileContext,
    recommended: [...(input.scopedContext?.recommended ?? [])],
    diagnostics: [...(input.scopedContext?.diagnostics ?? [])],
    metadata: {
      version: PROMPT_CONTEXT_COMPOSER_VERSION,
      stableContextHash: hashJson({
        version: PROMPT_CONTEXT_COMPOSER_VERSION,
        stableContext,
      }),
      volatileContextHash: hashJson({
        version: PROMPT_CONTEXT_COMPOSER_VERSION,
        volatileContext,
      }),
      stableBlockIds: stableContext.map((block) => block.id),
      volatileBlockIds: volatileContext.map((block) => block.id),
      boundary: classifyPromptContextBoundary(stableContext, volatileContext),
    },
  };
}

function classifyPromptContextBoundary(
  stableContext: PromptAssemblyContextBlock[],
  volatileContext: PromptAssemblyContextBlock[]
): PromptContextComposerMetadata['boundary'] {
  return {
    stable: {
      globalProjectRules: stableContext
        .filter((block) => block.id === 'scoped-context:rules')
        .map((block) => block.id),
      enabledSkills: stableContext
        .filter(
          (block) => block.id.includes('skill') || block.kind === 'skills-hook'
        )
        .map((block) => block.id),
      sharedProjectProgress: stableContext
        .filter((block) => block.id === 'project-progress:stable')
        .map((block) => block.id),
      custom: stableContext
        .filter(
          (block) =>
            block.id !== 'scoped-context:rules' &&
            block.id !== 'project-progress:stable' &&
            !block.id.includes('skill') &&
            block.kind !== 'skills-hook'
        )
        .map((block) => block.id),
    },
    volatile: {
      parentRuntimeIds: volatileContext
        .filter(
          (block) =>
            block.id.includes('parent-runtime') ||
            block.id.includes('parent-run')
        )
        .map((block) => block.id),
      cwd: volatileContext
        .filter((block) => block.id.includes('cwd'))
        .map((block) => block.id),
      taskCard: volatileContext
        .filter((block) => block.id.includes('task-card'))
        .map((block) => block.id),
      recentChildTaskRecords: volatileContext
        .filter(
          (block) =>
            block.id === 'project-progress:recent-tasks' ||
            block.id.includes('child-task')
        )
        .map((block) => block.id),
      currentUserTurn: volatileContext
        .filter((block) => block.id.includes('current-user-turn'))
        .map((block) => block.id),
      custom: volatileContext
        .filter(
          (block) =>
            !block.id.includes('parent-runtime') &&
            !block.id.includes('parent-run') &&
            !block.id.includes('cwd') &&
            !block.id.includes('task-card') &&
            block.id !== 'project-progress:recent-tasks' &&
            !block.id.includes('child-task') &&
            !block.id.includes('current-user-turn')
        )
        .map((block) => block.id),
    },
  };
}

function normalizeProgress(
  input:
    | ProjectProgressLedger
    | ProjectProgressSnapshot
    | PromptContextProgressInput
    | undefined
): PromptContextProgressInput {
  if (!input) {
    return {};
  }
  if (isProjectProgressLedger(input)) {
    const snapshot = input.snapshotForSubagentContext();
    return {
      stableLines: snapshot.stableLines,
      recentTaskLines: snapshot.recentTaskLines,
    };
  }
  return {
    stableLines: normalizeLines(input.stableLines),
    recentTaskLines: normalizeLines(input.recentTaskLines),
  };
}

function progressStableBlocks(
  progress: PromptContextProgressInput
): PromptAssemblyContextBlock[] {
  const lines = normalizeLines(progress.stableLines);
  if (lines.length === 0) {
    return [];
  }
  return [
    {
      id: 'project-progress:stable',
      kind: 'project-profile',
      label: 'Stable Project Progress',
      content: {
        version: PROMPT_CONTEXT_COMPOSER_VERSION,
        lines,
      },
    },
  ];
}

function progressVolatileBlocks(
  progress: PromptContextProgressInput
): PromptAssemblyContextBlock[] {
  const lines = normalizeLines(progress.recentTaskLines);
  if (lines.length === 0) {
    return [];
  }
  return [
    {
      id: 'project-progress:recent-tasks',
      kind: 'custom-volatile',
      label: 'Recent Subagent Tasks',
      content: {
        version: PROMPT_CONTEXT_COMPOSER_VERSION,
        lines,
      },
    },
  ];
}

function compactContextBlocks(
  blocks: PromptAssemblyContextBlock[]
): PromptAssemblyContextBlock[] {
  const result = new Map<string, PromptAssemblyContextBlock>();
  for (const block of blocks) {
    if (!block.id.trim()) {
      continue;
    }
    result.set(block.id, block);
  }
  return [...result.values()];
}

function normalizeLines(lines: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines ?? []) {
    const normalized = line.trim().replace(/\s+/g, ' ');
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isProjectProgressLedger(
  input: unknown
): input is ProjectProgressLedger {
  return (
    typeof (input as ProjectProgressLedger).snapshotForSubagentContext ===
    'function'
  );
}

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
}

export function promptContextMetadataJson(
  metadata: PromptContextComposerMetadata
): JsonObject {
  return {
    version: metadata.version,
    stableContextHash: metadata.stableContextHash,
    volatileContextHash: metadata.volatileContextHash,
    stableBlockIds: metadata.stableBlockIds as unknown as JsonValue,
    volatileBlockIds: metadata.volatileBlockIds as unknown as JsonValue,
  };
}
