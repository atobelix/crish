// 审批事件消费映射（F2 §2.4 事件协议 → store 动作）：纯函数、可单测
// 输入 = generated/engine 的 parseEngineEvent 严格解析产物（M5 §1.4：事件解析一律走生成面）
// 职责：ApprovalRequested（事件流入）→ ApprovalItem（upsert）；ApprovalResolved（含 expired）→ 移除/状态记录
import type {
  EngineApprovalRequestedEvent,
  EngineApprovalResolvedEvent,
  EngineEvent,
} from '../../../../../packages/shared-types/src/generated/engine/events';
// 与 ApprovalItem.request 同源：引擎生成契约的 PermissionRequest（parameters 为宽容 JsonValue）
import type { PermissionRequest } from '../../../../../packages/shared-types/src/generated/engine/types';
import type { ApprovalItem, ApprovalRiskMeta } from '../types/domain';
import { APPROVAL_TIMEOUT_MS } from './approvalReducers';

/** 危险标记：命令门禁越界（F2 §2.2 表：git push --force 等） */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\bgit\s+push\b[\s\S]*--force/,
  /\brm\s+-[a-z]*r[a-z]*f/,
  /--force/,
  /--no-verify/,
  /\bdrop\s+table\b/i,
  /\bmkfs\b/,
];

/** 删除类工具名前缀（F2 §2.2 表：删除影响面 → L2） */
const DELETE_TOOL_PATTERNS: RegExp[] = [
  /^(delete|remove|unlink|rm)/i,
  /^file\b.*\b(delete|remove)/i,
];

/** 命令类工具名（参数包内命令抽取与危险判定对象） */
const COMMAND_TOOL_PATTERNS: RegExp[] = [
  /^(command|shell|terminal|exec|bash|sh|powershell|pwsh|cmd|run_command)/i,
];

/** 宽容读取 metadata 字符串字段（metadata 为宽容 JsonValue：缺失/非对象/类型错 → undefined） */
function metaString(
  meta: PermissionRequest['metadata'],
  key: string
): string | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta))
    return undefined;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** 宽容读取 metadata 布尔字段 */
function metaBool(
  meta: PermissionRequest['metadata'],
  key: string
): boolean | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta))
    return undefined;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** 参数包转为可索引对象（parameters/metadata 为宽容 JsonValue，非法形状 → undefined） */
function paramsRecord(
  parameters: unknown
): Record<string, unknown> | undefined {
  if (
    typeof parameters !== 'object' ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    return undefined;
  }
  return parameters as Record<string, unknown>;
}

/**
 * 命令行抽取（对齐桌面 extractApprovalCommandArgs，F2 §2.2 riskMeta.command）：
 * 命令类工具从参数包取 command/cmd/script/args 字段；其余工具返回 undefined。
 */
export function extractCommand(request: PermissionRequest): string | undefined {
  if (!COMMAND_TOOL_PATTERNS.some((re) => re.test(request.toolName)))
    return undefined;
  const params = paramsRecord(request.parameters);
  if (!params) return undefined;
  for (const key of ['command', 'cmd', 'script', 'args'] as const) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (Array.isArray(v)) {
      const joined = v
        .filter((x): x is string => typeof x === 'string')
        .join(' ');
      if (joined.length > 0) return joined;
    }
  }
  return undefined;
}

/** 危险级别推导（F2 §2.2 表，本地展示层不改变引擎语义）：L2 = 删除类 / C3 大面积回退 / 命令门禁越界 */
export function deriveDangerLevel(request: PermissionRequest): 1 | 2 {
  // C3 回退护栏命中（F2 §2.2：revertGate 面积）→ L2
  if (
    metaBool(request.metadata, 'revertGate') ||
    metaBool(request.metadata, 'requiresApproval')
  ) {
    return 2;
  }
  const metadata = paramsRecord(request.metadata);
  if (metadata && metadata['revertArea'] !== undefined) {
    return 2;
  }
  // 删除类工具 → L2（删除影响面）
  if (DELETE_TOOL_PATTERNS.some((re) => re.test(request.toolName))) {
    return 2;
  }
  // 命令门禁越界（危险标记）→ L2
  const command = extractCommand(request);
  if (command && DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command))) {
    return 2;
  }
  return 1;
}

/**
 * 风险元数据抽取（对齐桌面 parseApprovalPayload 的 S9 宽容解析，approvalHandlers.ts:50-54）：
 * deleteImpact.pathCount 取参数包路径类字段数量；revertArea 透传 metadata；command 抽取命令行。
 */
export function deriveRiskMeta(
  request: PermissionRequest
): ApprovalRiskMeta | undefined {
  const command = extractCommand(request);
  let deleteImpact: ApprovalRiskMeta['deleteImpact'];
  if (DELETE_TOOL_PATTERNS.some((re) => re.test(request.toolName))) {
    const params = paramsRecord(request.parameters);
    const pathCount = params
      ? Object.values(params).filter((v) => typeof v === 'string').length
      : 0;
    deleteImpact = { pathCount };
  }
  const metadata = paramsRecord(request.metadata);
  const revertMeta = metadata?.['revertArea'];
  const revertArea =
    typeof revertMeta === 'object' && revertMeta !== null
      ? (revertMeta as Record<string, unknown>)
      : undefined;
  const riskMeta: ApprovalRiskMeta = {};
  if (deleteImpact) riskMeta.deleteImpact = deleteImpact;
  if (revertArea) {
    riskMeta.revertArea = {
      fileCount:
        typeof revertArea['fileCount'] === 'number'
          ? revertArea['fileCount']
          : undefined,
      lineCount:
        typeof revertArea['lineCount'] === 'number'
          ? revertArea['lineCount']
          : undefined,
      crossDirectory:
        typeof revertArea['crossDirectory'] === 'boolean'
          ? revertArea['crossDirectory']
          : undefined,
      refAgeSeconds:
        typeof revertArea['refAgeSeconds'] === 'number'
          ? revertArea['refAgeSeconds']
          : undefined,
    };
  }
  if (command) riskMeta.command = command;
  return deleteImpact || revertArea || command ? riskMeta : undefined;
}

/** ApprovalRequested 事件体 → ApprovalItem（runId 来自信封，F2 §2.4；receivedAtMs = 本地收达时间） */
export function mapApprovalRequested(
  event: EngineApprovalRequestedEvent,
  runId: string | null,
  nowMs: number
): ApprovalItem {
  const request = event.request;
  const arbiter =
    metaString(request.metadata, 'arbiter') === 'main-agent'
      ? 'main-agent'
      : 'user';
  const requesterRunId = metaString(request.metadata, 'requesterRunId');
  const reason = metaString(request.metadata, 'reason');
  return {
    request,
    runId,
    arbiter,
    dangerLevel: deriveDangerLevel(request),
    riskMeta: deriveRiskMeta(request),
    receivedAtMs: nowMs,
    // 本地倒计时（F2 §8.3：expiresAt = 收达时间 + 120s，引擎 APPROVAL_TIMEOUT 对齐）
    expiresAt: nowMs + APPROVAL_TIMEOUT_MS,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...(requesterRunId !== undefined ? { requesterRunId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

export interface ResolvedEventView {
  toolCallId: string;
  decision: EngineApprovalResolvedEvent['decision'];
  /** 事件到达本地时刻（由调用方注入，测试可加速） */
  resolvedAtMs: number;
}

/**
 * ApprovalResolved 事件体 → 收敛视图（F2 §2.4 / §11.2）：
 * - decision='expired'（引擎补发/对账，F2 §8.3 / R1）与 approved/denied 同语义收敛；
 * - store 消费：handleResolved(toolCallId, decision, resolvedAtMs) → 移除 + 历史入档。
 */
export function mapApprovalResolved(
  event: EngineApprovalResolvedEvent,
  resolvedAtMs: number
): ResolvedEventView {
  return {
    toolCallId: event.toolCallId,
    decision: event.decision,
    resolvedAtMs,
  };
}

/** 审批事件判定（事件分类器白名单子集，F2 §2.4 事件对） */
export function isApprovalEvent(event: EngineEvent): boolean {
  return (
    event.type === 'approval-requested' || event.type === 'approval-resolved'
  );
}
