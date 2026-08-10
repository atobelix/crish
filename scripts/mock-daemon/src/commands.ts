// =======================================================================
// mock daemon v0（R0-06）——命令处理器（remote.* → result.* / error）
//
// 对齐 M6 §4 命令清单（37 条 remote.*）。v0 实现范围（移动端 R2 首期联调
// 必需面）：
//   - 审批域：approve / deny（含 msgId 幂等回显、I-02 冲突语义）/
//     listPendingApprovals / approvalHistory / checkCommand
//   - 监控域：getStatus / getRunSnapshot / readSessionEvents / readRunEvents /
//     listSessions / listCommands / getSearchIndex
//   - 会话域：runControl / cancelRun
//   - 设置/设备域：getSettings / queryPresence / listDevices / getPairState
//   - 其余命令（runTask/searchSessions/文件面等）→ cmd.unknown（诚实报未实现，
//     移动端据此走「能力未开」分支；绝不伪造成功）
//
// 响应形状：result.<name> body = CommandResult {reqMsgId, ok, result?}；
// 错误一律回 `error` kind（ErrorBody {code, message, retryable, reqMsgId}）。
// =======================================================================

import type { JsonValue } from '../../../packages/shared-types/src/primitive-types';
import type { DeviceKind } from '../../../packages/shared-types/src/generated/device/kinds';
import type { CommandResult, ErrorBody, ApproveResult, ManifestEntry, PendingApproval, SessionIndexEntry, ApprovalHistoryItem, StatusResult, RunSnapshotResult, EventPageResult, ListSessionsResult, ListCommandsResult, CheckCommandResult, RunControlResult, CancelRunResult, GetSettingsResult, PresenceResult, ListDevicesResult, DeviceEntry, PairStateResult, GenericOkResult, ListPendingApprovalsResult, ApprovalHistoryResult, SearchIndexResult } from '../../../packages/shared-types/src/generated/device/types';
import type { MockState } from './state.js';
import { approvalResolved } from './fixtures/events.js';
import { debug, warn } from './util.js';

/** 命令处理上下文（server 为每个连接构造） */
export interface CommandContext {
  state: MockState;
  /** 会话期客户端 deviceId（来自握手/订阅时登记） */
  deviceId: string;
  /** 请求 msgId（幂等键） */
  msgId: string;
  /** 发射持久化事件（审批决策广播等） */
  emitEvent(sessionId: string, event: JsonValue): Promise<number>;
}

export type CommandOutcome =
  | { ok: true; replyKind: DeviceKind; replyBody: CommandResult }
  | { ok: false; replyKind: 'error'; replyBody: ErrorBody };

/** 命令参数对象访问器（params 为 JsonValue） */
function paramsOf(body: { params: JsonValue }): Record<string, unknown> {
  if (typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)) {
    return body.params as Record<string, unknown>;
  }
  return {};
}

/** 构造 result.<name> 响应（ok=true；result 统一经 JsonValue 转写） */
function okResult(command: string, result: unknown): CommandOutcome {
  return {
    ok: true,
    replyKind: `result.${command}` as DeviceKind,
    replyBody: { reqMsgId: '', ok: true, result: result as JsonValue },
  };
}

/** 构造 error 响应（带 reqMsgId 关联） */
function errOutcome(code: string, message: string, retryable: boolean): CommandOutcome {
  return {
    ok: false,
    replyKind: 'error',
    replyBody: { code, message, retryable, reqMsgId: '' },
  };
}

/** 命令清单夹具（listCommands；与注册表 C01-C37 的子集对齐，供能力发现联调） */
const FIXTURE_MANIFEST: ManifestEntry[] = [
  { name: 'getStatus', family: 'core', surface: 'engine', registered: true },
  { name: 'getRunSnapshot', family: 'core', surface: 'engine', registered: true },
  { name: 'readSessionEvents', family: 'core', surface: 'engine', registered: true },
  { name: 'readRunEvents', family: 'core', surface: 'engine', registered: true },
  { name: 'listSessions', family: 'session', surface: 'engine', registered: true },
  { name: 'listCommands', family: 'core', surface: 'engine', registered: true },
  { name: 'getSearchIndex', family: 'core', surface: 'engine', registered: true },
  { name: 'approve', family: 'core', surface: 'engine', registered: true },
  { name: 'deny', family: 'core', surface: 'engine', registered: true },
  { name: 'listPendingApprovals', family: 'core', surface: 'engine', registered: true },
  { name: 'approvalHistory', family: 'core', surface: 'engine', registered: true },
  { name: 'checkCommand', family: 'core', surface: 'engine', registered: true },
  { name: 'runControl', family: 'session', surface: 'engine', registered: true },
  { name: 'cancelRun', family: 'session', surface: 'engine', registered: true },
  { name: 'getSettings', family: 'config', surface: 'engine', registered: true },
  { name: 'queryPresence', family: 'core', surface: 'engine', registered: true },
  { name: 'listDevices', family: 'core', surface: 'engine', registered: true },
  { name: 'getPairState', family: 'core', surface: 'engine', registered: true },
];

/**
 * 统一命令入口。已实现命令返回 result/error；未实现命令返回 cmd.unknown
 * （retryable=false：mock 不自动重试，避免移动端误判网络问题）。
 */
export function handleCommand(kind: DeviceKind, body: { params: JsonValue }, ctx: CommandContext): CommandOutcome {
  // kind 形如 remote.<name>，提取命令名
  const command = kind.startsWith('remote.') ? kind.slice('remote.'.length) : '';
  if (command === '') {
    return errOutcome('cmd.invalid', `非命令 kind：${kind}`, false);
  }

  switch (command) {
    case 'approve':
      return handleApprove(body, ctx);
    case 'deny':
      return handleDeny(body, ctx);
    case 'listPendingApprovals':
      return handleListPendingApprovals(ctx);
    case 'approvalHistory':
      return handleApprovalHistory(body, ctx);
    case 'checkCommand':
      return handleCheckCommand(body);
    case 'getStatus':
      return okResult('getStatus', statusResult(ctx.state));
    case 'getRunSnapshot':
      return handleGetRunSnapshot(body, ctx.state);
    case 'readSessionEvents':
      return handleReadSessionEvents(body, ctx.state);
    case 'readRunEvents':
      return handleReadRunEvents(body, ctx.state);
    case 'listSessions':
      return handleListSessions(body, ctx.state);
    case 'listCommands':
      return okResult('listCommands', { contractVersion: '1.0.0', commands: FIXTURE_MANIFEST } satisfies ListCommandsResult);
    case 'getSearchIndex':
      return okResult('getSearchIndex', { ready: true, state: { totalFiles: 1200, lastBuiltAt: Date.now() } } satisfies SearchIndexResult);
    case 'runControl':
      return handleRunControl(body, ctx.state);
    case 'cancelRun':
      return handleCancelRun(body, ctx.state);
    case 'getSettings':
      return okResult('getSettings', {
        settings: {
          responseStyle: 'balanced',
          enableAnalytics: true,
          enableCrashTelemetry: false,
          permissionMode: 'ask',
          trustedCommandCount: 12,
          activeProfileId: 'p-main',
          defaultModel: 'deepseek-v4',
        },
      } satisfies GetSettingsResult);
    case 'queryPresence':
      return okResult('queryPresence', { desktopOnline: true, lastInteractionAt: Date.now() } satisfies PresenceResult);
    case 'listDevices':
      return handleListDevices(ctx);
    case 'getPairState':
      return okResult('getPairState', {
        state: ctx.state.pairMode ? 'done' : 'none',
        desktopId: ctx.state.desktopId,
      } satisfies PairStateResult);
    case 'renameDevice':
      return handleRenameDevice(body, ctx);
    case 'revokeDevice':
      return errOutcome('cmd.denied', 'mock v0：撤销设备为桌面侧操作，移动端联调不模拟', false);
    case 'unlink':
      return errOutcome('cmd.denied', 'mock v0：解除配对请直接断开连接（夹具不做设备表清理）', false);
    case 'writeFile':
      return handleWriteFile(body, ctx);
    default:
      warn(`命令未实现（mock v0）：${kind}`);
      return errOutcome('cmd.unknown', `mock v0 未实现命令 ${kind}（真实桌面 R1 后可用）`, false);
  }
}

// ── 审批域 ─────────────────────────────────────────────────────────────

/** approve：I-02 语义——命中待审批集合才放行；同 msgId 重发回显首次结果 */
function handleApprove(body: { params: JsonValue }, ctx: CommandContext): CommandOutcome {
  const params = paramsOf(body);
  const toolCallId = typeof params['toolCallId'] === 'string' ? params['toolCallId'] : '';
  if (toolCallId === '') return errOutcome('cmd.invalid', 'approve：toolCallId 缺失', false);

  const cached = ctx.state.replayIfCached(ctx.deviceId, ctx.msgId);
  if (cached) return okResult('approve', cached);

  const resolved = ctx.state.resolveApproval(toolCallId, 'approved', undefined);
  if (!resolved.ok) {
    return errOutcome('cmd.approval_mismatch', '该请求已被其他设备处理或已过期（I-02）', false);
  }
  const result: ApproveResult = { ok: true, toolCallId, decision: 'approved' };
  ctx.state.cacheResult(ctx.deviceId, ctx.msgId, result);
  // 决策广播：approval-resolved 事件（真实桌面同语义：事件是收敛的唯一裁决）
  if (resolved.request.sessionId && resolved.request.runId) {
    void ctx.emitEvent(
      resolved.request.sessionId,
      approvalResolved(resolved.request.sessionId, resolved.request.runId, toolCallId, 'approved', resolved.request.requestId),
    );
  } else {
    warn(`approve：待审批项缺少 sessionId/runId，跳过决策事件广播（toolCallId=${toolCallId}）`);
  }
  return okResult('approve', result);
}

/** deny：同上；reason 缺省 user denied（F2 §5.2） */
function handleDeny(body: { params: JsonValue }, ctx: CommandContext): CommandOutcome {
  const params = paramsOf(body);
  const toolCallId = typeof params['toolCallId'] === 'string' ? params['toolCallId'] : '';
  if (toolCallId === '') return errOutcome('cmd.invalid', 'deny：toolCallId 缺失', false);

  const cached = ctx.state.replayIfCached(ctx.deviceId, ctx.msgId);
  if (cached) return okResult('deny', cached);

  const reason = typeof params['reason'] === 'string' && params['reason'].length > 0 ? params['reason'] : 'user denied';
  const resolved = ctx.state.resolveApproval(toolCallId, 'denied', reason);
  if (!resolved.ok) {
    return errOutcome('cmd.approval_mismatch', '该请求已被其他设备处理或已过期（I-02）', false);
  }
  const result: ApproveResult = { ok: true, toolCallId, decision: 'denied' };
  ctx.state.cacheResult(ctx.deviceId, ctx.msgId, result);
  if (resolved.request.sessionId && resolved.request.runId) {
    void ctx.emitEvent(
      resolved.request.sessionId,
      approvalResolved(resolved.request.sessionId, resolved.request.runId, toolCallId, 'denied', resolved.request.requestId),
    );
  } else {
    warn(`deny：待审批项缺少 sessionId/runId，跳过决策事件广播（toolCallId=${toolCallId}）`);
  }
  return okResult('deny', result);
}

/** listPendingApprovals：启动对账（F2 §4.1），parameters 不下发（隐私红线） */
function handleListPendingApprovals(ctx: CommandContext): CommandOutcome {
  const approvals: PendingApproval[] = ctx.state.listPendingApprovals();
  const maxSeq = Math.max(0, ...ctx.state.approvalHistory.map((h) => h.sequence));
  return okResult('listPendingApprovals', { approvals, latestSequence: maxSeq } satisfies ListPendingApprovalsResult);
}

/** approvalHistory：approval-resolved 白名单投影（按 sequence 水位） */
function handleApprovalHistory(body: { params: JsonValue }, ctx: CommandContext): CommandOutcome {
  const params = paramsOf(body);
  const afterSequence = typeof params['afterSequence'] === 'number' ? params['afterSequence'] : 0;
  const limit = typeof params['limit'] === 'number' ? Math.min(params['limit'], 200) : 100;
  const page = ctx.state.approvalHistorySince(afterSequence, limit);
  const items: ApprovalHistoryItem[] = page.items.map((it) => ({
    sequence: it.sequence,
    toolCallId: it.toolCallId,
    ...(it.toolName !== undefined ? { toolName: it.toolName } : {}),
    decision: it.decision,
    ...(it.reason !== undefined ? { reason: it.reason } : {}),
    ...(it.channel !== undefined ? { channel: it.channel } : {}),
    ...(it.resolvedAt !== undefined ? { resolvedAt: it.resolvedAt } : {}),
    ...(it.sessionId !== undefined ? { sessionId: it.sessionId } : {}),
    ...(it.runId !== undefined ? { runId: it.runId } : {}),
  }));
  return okResult('approvalHistory', { items, nextAfterSequence: page.nextAfterSequence, hasMore: page.hasMore } satisfies ApprovalHistoryResult);
}

/** checkCommand：只读判定预览（真实判定在引擎 gatekeeper，mock 给固定策略） */
function handleCheckCommand(body: { params: JsonValue }): CommandOutcome {
  const params = paramsOf(body);
  const command = typeof params['command'] === 'string' ? params['command'] : '';
  if (command === '') return errOutcome('cmd.invalid', 'checkCommand：command 缺失', false);
  if (command.startsWith('shell:') || command === 'workbench_write_file_content') {
    return okResult('checkCommand', { decision: 'requires-approval', reason: `${command} 需要审批（mock 策略）` } satisfies CheckCommandResult);
  }
  return okResult('checkCommand', { decision: 'allowed' } satisfies CheckCommandResult);
}

// ── 监控域 ─────────────────────────────────────────────────────────────

/** getStatus：状态卡夹具（字段裁剪对齐 M6 §4.1.1 StatusResult） */
function statusResult(state: MockState): StatusResult {
  const pending = state.listPendingApprovals();
  const activeRuns = pending.map((p) => ({
    runId: p.runId,
    sessionId: p.sessionId,
    status: 'awaiting-approval',
    startedAt: p.requestedAt,
    prompt: p.summary,
  }));
  return {
    initialized: true,
    version: '1.4.2',
    engineReady: true,
    dbReady: true,
    searchIndexReady: true,
    compactionReady: false,
    providerStatus: { hasApiKey: true, model: 'deepseek-v4', credentialMode: 'direct' },
    logLevel: 'info',
    diagnostics: [],
    restore: { state: 'done', mode: 'snapshot-incremental', interruptedCount: 0 },
    backgroundTasks: { activeCount: 0, daemonCount: 0 },
    activeRuns: activeRuns as unknown as JsonValue[],
    pendingApprovals: pending.map((p) => ({
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      runId: p.runId,
      summary: p.summary,
    })) as unknown as JsonValue[],
  };
}

/** getRunSnapshot：按会话存储最新事件派生 run 状态（找不到 → cmd.not_found） */
function handleGetRunSnapshot(body: { params: JsonValue }, state: MockState): CommandOutcome {
  const params = paramsOf(body);
  const runId = typeof params['runId'] === 'string' ? params['runId'] : '';
  if (runId === '') return errOutcome('cmd.invalid', 'getRunSnapshot：runId 缺失', false);
  const snapshot = deriveRunSnapshot(state, runId);
  if (!snapshot) return errOutcome('cmd.not_found', `run 不存在：${runId}`, false);
  return okResult('getRunSnapshot', { snapshot } satisfies RunSnapshotResult);
}

/** 从会话事件存储推导 run 快照（序列最新事件类型 → 状态；与桌面 runs 表语义对齐） */
function deriveRunSnapshot(state: MockState, runId: string): JsonValue | null {
  let sessionId: string | undefined;
  let status = 'running';
  let cursor = 0;
  let terminal: string | undefined;
  let pending: PendingApproval | undefined;

  for (const store of state.sessions.values()) {
    for (const item of store.all()) {
      const e = item.event as Record<string, unknown>;
      if (e['runId'] !== runId) continue;
      sessionId = store.sessionId;
      cursor = Math.max(cursor, item.sequence);
      if (e['type'] === 'run-terminal') {
        terminal = typeof e['terminal'] === 'string' ? e['terminal'] : undefined;
      }
      if (e['type'] === 'approval-requested') {
        const req = e['request'] as Record<string, unknown> | undefined;
        const toolCallId = typeof req?.['toolCallId'] === 'string' ? req['toolCallId'] : '';
        if (toolCallId !== '' && !state.pendingApprovals.get(toolCallId)?.resolved) {
          pending = state.pendingApprovals.get(toolCallId)?.request;
        }
      }
    }
  }
  if (sessionId === undefined) return null;
  if (terminal) {
    status = terminal;
  } else if (pending) {
    status = 'awaiting-approval';
  }
  return {
    runId,
    sessionId,
    status,
    cursor,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    endReason: terminal ? terminal : null,
    error: null,
    usage: { promptTokens: 2100, completionTokens: 1400, totalTokens: 3500, sampleCount: 3, cacheReadTokens: 1800, cacheWriteTokens: 120, cacheMissTokens: 300, hitRatio: 0.81 },
  };
}

/** readSessionEvents：EventPage 契约（开区间分页；direction 仅支持 forward） */
function handleReadSessionEvents(body: { params: JsonValue }, state: MockState): CommandOutcome {
  const params = paramsOf(body);
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : '';
  if (sessionId === '') return errOutcome('cmd.invalid', 'readSessionEvents：sessionId 缺失', false);
  const direction = params['direction'];
  if (direction !== undefined && direction !== 'forward') {
    return errOutcome('cmd.invalid', 'mock v0 仅支持 forward 分页（backward 为 M6 §4.1.3.1 待实现面）', false);
  }
  const store = state.store(sessionId);
  const afterSequence = typeof params['afterSequence'] === 'number' ? params['afterSequence'] : 0;
  const maxEvents = typeof params['maxEvents'] === 'number' ? Math.min(params['maxEvents'], 1000) : 200;
  const page = store.since(afterSequence, maxEvents);
  const result: EventPageResult = {
    sessionId,
    events: page.events.map((it) => it.event),
    nextAfterSequence: page.nextAfterSequence,
    hasMore: page.hasMore,
    latestSequence: store.maxSequence(),
  };
  return okResult('readSessionEvents', result);
}

/** readRunEvents：run 事件是会话事件子集（按 runId 过滤） */
function handleReadRunEvents(body: { params: JsonValue }, state: MockState): CommandOutcome {
  const params = paramsOf(body);
  const runId = typeof params['runId'] === 'string' ? params['runId'] : '';
  if (runId === '') return errOutcome('cmd.invalid', 'readRunEvents：runId 缺失', false);
  const afterSequence = typeof params['afterSequence'] === 'number' ? params['afterSequence'] : 0;
  const maxEvents = typeof params['maxEvents'] === 'number' ? Math.min(params['maxEvents'], 1000) : 200;
  let sessionId: string | undefined;
  const matched: { sequence: number; event: JsonValue }[] = [];
  for (const store of state.sessions.values()) {
    for (const item of store.all()) {
      const e = item.event as Record<string, unknown>;
      if (e['runId'] === runId && item.sequence > afterSequence) {
        if (sessionId === undefined) sessionId = store.sessionId;
        matched.push({ sequence: item.sequence, event: item.event });
      }
    }
  }
  if (sessionId === undefined) return errOutcome('cmd.not_found', `run 不存在：${runId}`, false);
  const slice = matched.slice(0, maxEvents);
  const result: EventPageResult = {
    sessionId,
    events: slice.map((it) => it.event),
    nextAfterSequence: slice.length === 0 ? afterSequence : slice[slice.length - 1]!.sequence,
    hasMore: matched.length > maxEvents,
  };
  return okResult('readRunEvents', result);
}

/** listSessions：会话索引（includeLastMessage 时附最后事件摘要 ≤80 字符） */
function handleListSessions(body: { params: JsonValue }, state: MockState): CommandOutcome {
  const params = paramsOf(body);
  const includeLastMessage = params['includeLastMessage'] === true;
  const sessions: SessionIndexEntry[] = state.sessionIndex();
  if (includeLastMessage) {
    for (const s of sessions) {
      const store = state.store(s.id);
      const last = store.all().at(-1);
      if (last) {
        const e = last.event as Record<string, unknown>;
        (s as SessionIndexEntry & { lastMessagePreview: string }).lastMessagePreview = String(e['type'] ?? '').slice(0, 80);
      }
    }
  }
  return okResult('listSessions', { sessions } satisfies ListSessionsResult);
}

// ── 会话域 ─────────────────────────────────────────────────────────────

/** runControl：L0-L3 控制（level 枚举校验；run 不存在 → cmd.not_found） */
function handleRunControl(body: { params: JsonValue }, state: MockState): CommandOutcome {
  const params = paramsOf(body);
  const level = params['level'];
  const validLevels = ['continue', 'soft_inject', 'cooperative_stop', 'force_cancel'];
  if (typeof level !== 'string' || !validLevels.includes(level)) {
    return errOutcome('cmd.invalid', `runControl：level 非法（${String(level)}）`, false);
  }
  const runId = typeof params['runId'] === 'string' ? params['runId'] : '';
  if (runId === '' || !runExists(state, runId)) {
    return errOutcome('cmd.not_found', `run 不存在：${runId}`, false);
  }
  debug(`runControl 收到 level=${level}（mock 仅记录，不改变状态）`);
  return okResult('runControl', { ok: true } satisfies RunControlResult);
}

/** cancelRun：终态拒绝（TerminalImmutable）；重复 cancel 无副作用 */
function handleCancelRun(body: { params: JsonValue }, state: MockState): CommandOutcome {
  const params = paramsOf(body);
  const runId = typeof params['runId'] === 'string' ? params['runId'] : '';
  if (runId === '' || !runExists(state, runId)) {
    return errOutcome('cmd.not_found', `run 不存在：${runId}`, false);
  }
  const store = findRunStore(state, runId);
  if (store && latestEventOf(store.store)?.type === 'run-terminal') {
    return errOutcome('cmd.invalid', 'run 已进入终态，不可取消（TerminalImmutable）', false);
  }
  debug(`cancelRun 收到 runId=${runId}（mock 仅记录，不改变状态）`);
  return okResult('cancelRun', { ok: true, runId } satisfies CancelRunResult);
}

// ── 设置/设备域 ────────────────────────────────────────────────────────

/** listDevices：本机 + 当前会话设备（deviceId 短显前 4 后 2，F6 §6.2 口径） */
function handleListDevices(ctx: CommandContext): CommandOutcome {
  const devices: DeviceEntry[] = [
    {
      deviceId: shortDeviceId(ctx.state.desktopId),
      name: '桌面 Hub（mock）',
      role: 'this',
      type: 'desktop',
      channel: 'lan',
      online: true,
      lastActiveAt: Date.now(),
      pairedAt: new Date().toISOString(),
    },
  ];
  const record = ctx.state.devices.get(ctx.deviceId);
  if (record) {
    devices.push({
      deviceId: shortDeviceId(ctx.deviceId),
      name: record.deviceName,
      role: 'peer',
      type: 'phone',
      channel: 'lan',
      online: true,
      lastActiveAt: record.lastSeenAt,
      pairedAt: new Date(record.pairedAt).toISOString(),
    });
  }
  return okResult('listDevices', { devices } satisfies ListDevicesResult);
}

/** renameDevice：更新设备名（name ≤ 64） */
function handleRenameDevice(body: { params: JsonValue }, ctx: CommandContext): CommandOutcome {
  const params = paramsOf(body);
  const deviceId = typeof params['deviceId'] === 'string' ? params['deviceId'] : '';
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  if (deviceId === '' || name === '' || name.length > 64) {
    return errOutcome('cmd.invalid', 'renameDevice：deviceId/name 非法（name ≤ 64）', false);
  }
  const record = ctx.state.devices.get(deviceId);
  if (!record) return errOutcome('cmd.not_found', `设备不存在：${deviceId}`, false);
  record.deviceName = name;
  return okResult('renameDevice', { ok: true } satisfies GenericOkResult);
}

/** writeFile：本域唯一写命令（msgId 幂等回显；overwrite 语义夹具） */
function handleWriteFile(body: { params: JsonValue }, ctx: CommandContext): CommandOutcome {
  const params = paramsOf(body);
  const path = typeof params['path'] === 'string' ? params['path'] : '';
  if (path === '') return errOutcome('cmd.invalid', 'writeFile：path 缺失', false);
  if (path.length > 1_048_576) return errOutcome('file.too_large', '文件超过 1MB 上限', false);
  const cached = ctx.state.replayIfCached(ctx.deviceId, ctx.msgId);
  if (cached) return okResult('writeFile', cached);
  const result = { ok: true, path };
  ctx.state.cacheResult(ctx.deviceId, ctx.msgId, result);
  debug(`writeFile 收到写入请求（mock 不落盘）：${path}`);
  return okResult('writeFile', result);
}

// ── 内部辅助 ───────────────────────────────────────────────────────────

function runExists(state: MockState, runId: string): boolean {
  return findRunStore(state, runId) !== undefined;
}

function findRunStore(state: MockState, runId: string): { sessionId: string; store: ReturnType<MockState['store']> } | undefined {
  for (const store of state.sessions.values()) {
    for (const item of store.all()) {
      if ((item.event as Record<string, unknown>)['runId'] === runId) {
        return { sessionId: store.sessionId, store };
      }
    }
  }
  return undefined;
}

function latestEventOf(store: ReturnType<MockState['store']>): { type: string } | undefined {
  const last = store.all().at(-1);
  if (!last) return undefined;
  return { type: String((last.event as Record<string, unknown>)['type'] ?? '') };
}

function shortDeviceId(deviceId: string): string {
  if (deviceId.length <= 8) return deviceId;
  return `${deviceId.slice(0, 4)}…${deviceId.slice(-2)}`;
}
