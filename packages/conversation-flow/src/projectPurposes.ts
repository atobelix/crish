/**
 * Phase A Purpose 投影：explanation 归一 + 30s 窗启发式合并。
 * 无 purpose_id；pending_approval 在此跳过。
 */

import {
  actionKind,
  extractCommand,
  extractPath,
  fallbackLabel,
  isSearchName,
  isShellName,
  normalizePurpose,
  tensedVerb,
  toolObjectLabel,
  toolVerbBase,
  verbFamily,
} from './humanize';
import type {
  ActionNode,
  HumanizeHooks,
  ProjectOptions,
  ProjectToolCallInput,
  PurposeNode,
  PurposeStatus,
} from './types';
import { DEFAULT_PURPOSE_WINDOW_MS } from './types';

function toolTimeMs(tc: ProjectToolCallInput): number {
  if (typeof tc.startedAt === 'number') return tc.startedAt;
  if (typeof tc.completedAt === 'number') return tc.completedAt;
  if (typeof tc.finishedAt === 'number') return tc.finishedAt;
  return 0;
}

/**
 * 前端派生：合并键。
 * 有有效 explanation → 归一文本；否则回退动词族（两笔同窗 inspect 可合成 1 个）。
 */
function purposeKeyFor(
  tc: ProjectToolCallInput,
  hooks?: HumanizeHooks,
): string {
  const fromExp = normalizePurpose(tc.explanation);
  if (fromExp) return fromExp;
  return verbFamily(toolVerbBase(tc, hooks));
}

function resolvePrimary(
  tc: ProjectToolCallInput,
  hooks?: HumanizeHooks,
): string {
  const fromExp = normalizePurpose(tc.explanation);
  if (fromExp) return fromExp;
  return fallbackLabel(tc, hooks) || tc.name || '执行工具调用';
}

interface OpenPurpose {
  id: string;
  purposeKey: string;
  primary: string;
  normalizedExplanation: string;
  actions: ActionNode[];
  verbFamily: string;
  firstTime: number;
  lastTime: number;
}

function shouldMergeIntoCurrent(
  current: OpenPurpose,
  tc: ProjectToolCallInput,
  purposeKey: string,
  windowMs: number,
  hooks?: HumanizeHooks,
): boolean {
  const t = toolTimeMs(tc);
  const lastT = current.lastTime || current.firstTime || 0;
  if (t && lastT && Math.abs(t - lastT) > windowMs) return false;

  if (current.purposeKey === purposeKey) return true;

  const fam = verbFamily(toolVerbBase(tc, hooks));
  if (fam !== current.verbFamily) return false;

  const normA = normalizePurpose(tc.explanation);
  const normB = current.normalizedExplanation;
  return Boolean(normA && normB && normA === normB);
}

function aggregatePurposeStatus(actions: ActionNode[]): PurposeStatus {
  if (!actions.length) return 'success';
  let hasRunning = false;
  let hasError = false;
  let hasSuccess = false;
  for (const action of actions) {
    if (action.status === 'running') hasRunning = true;
    else if (action.status === 'error') hasError = true;
    else if (action.status === 'success') hasSuccess = true;
  }
  if (hasRunning) return 'running';
  if (hasError && hasSuccess) return 'partial';
  if (hasError) return 'error';
  return 'success';
}

/** 前端派生：单条 tool → ActionNode */
export function toActionNode(
  tc: ProjectToolCallInput,
  hooks?: HumanizeHooks,
): ActionNode {
  const name = tc.name || 'tool';
  const base = toolVerbBase(tc, hooks);
  const kind = actionKind(name);
  const path = extractPath(tc.arguments);
  const command = extractCommand(tc.arguments);

  const node: ActionNode = {
    id: tc.id,
    toolName: name,
    verb: tensedVerb(base, tc.status),
    objectLabel: toolObjectLabel(tc),
    status: tc.status,
    kind,
    expandable: Boolean(tc.output && String(tc.output).trim()),
  };

  if (path && !isSearchName(name)) node.path = path;
  if (kind === 'search' && path && !node.objectLabel) {
    node.objectLabel = path;
  }
  if (command && isShellName(name)) node.command = command;
  if (tc.output != null) node.output = tc.output;
  if (tc.explanation) node.explanation = tc.explanation;
  if (typeof tc.startedAt === 'number') node.startedAt = tc.startedAt;
  if (typeof tc.completedAt === 'number') node.completedAt = tc.completedAt;
  if (tc.turnId) node.turnId = tc.turnId;
  return node;
}

/**
 * `MessageToolCall[]` → Purpose 节点。
 * pending_approval 不进树。
 */
export function projectPurposes(
  toolCalls: readonly ProjectToolCallInput[] | undefined,
  options?: ProjectOptions,
): PurposeNode[] {
  const windowMs =
    typeof options?.purposeWindowMs === 'number'
      ? options.purposeWindowMs
      : DEFAULT_PURPOSE_WINDOW_MS;
  const hooks = options?.humanize;
  const list = toolCalls ?? [];
  const purposes: PurposeNode[] = [];
  let current: OpenPurpose | null = null;
  const turnGroupMap = new Map<string, string>();
  let groupSeq = 0;

  const emit = (open: OpenPurpose): void => {
    purposes.push({
      kind: 'purpose',
      id: open.id,
      primary: open.primary,
      status: aggregatePurposeStatus(open.actions),
      actions: open.actions,
    });
  };

  for (const tc of list) {
    if (!tc) continue;
    if (tc.status === 'pending_approval') continue;

    const purposeKey = purposeKeyFor(tc, hooks);
    let open: OpenPurpose;
    if (
      current === null ||
      !shouldMergeIntoCurrent(current, tc, purposeKey, windowMs, hooks)
    ) {
      if (current !== null) emit(current);
      open = {
        id: `p-${tc.id}`,
        purposeKey,
        primary: resolvePrimary(tc, hooks),
        normalizedExplanation: normalizePurpose(tc.explanation),
        actions: [],
        verbFamily: verbFamily(toolVerbBase(tc, hooks)),
        firstTime: toolTimeMs(tc),
        lastTime: toolTimeMs(tc),
      };
    } else {
      open = current;
      const stronger = normalizePurpose(tc.explanation);
      if (stronger && stronger.length >= open.primary.length) {
        open.primary = stronger;
        open.normalizedExplanation = stronger;
      }
    }
    current = open;

    const action = toActionNode(tc, hooks);
    if (tc.turnId) {
      let gid = turnGroupMap.get(tc.turnId);
      if (!gid) {
        groupSeq += 1;
        gid = `pg-${groupSeq}`;
        turnGroupMap.set(tc.turnId, gid);
      }
      action.parallelGroupId = gid;
    }

    open.actions.push(action);
    const t = toolTimeMs(tc);
    if (t) open.lastTime = t;
  }

  if (current) emit(current);
  return purposes;
}
