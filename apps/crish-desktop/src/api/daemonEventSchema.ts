/**
 * Daemon 事件桥层轻量 schema（不引入 zod 依赖时的 safeParse 等价物）。
 * 协议不匹配时返回 { ok:false, error }，便于日志可见。
 */

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type DaemonToolCallFields = {
  id: string;
  name: string;
  args: string;
  explanation: string;
};

/** 解析 tool-call 载荷；缺 id/name 视为协议失败 */
export function parseToolCallFields(call: unknown): ParseResult<DaemonToolCallFields> {
  if (!isRecord(call)) {
    return { ok: false, error: 'tool-call payload is not an object' };
  }
  const id = String(call.id ?? call.toolCallId ?? call.tool_call_id ?? '').trim();
  const name = String(call.name ?? call.toolName ?? call.tool_name ?? '').trim();
  if (!id) return { ok: false, error: 'tool-call missing id' };
  if (!name) return { ok: false, error: 'tool-call missing name' };

  let args = '';
  if (typeof call.arguments === 'string') args = call.arguments;
  else if (typeof call.args === 'string') args = call.args;
  else if (call.arguments != null) {
    try {
      args = JSON.stringify(call.arguments);
    } catch {
      args = String(call.arguments);
    }
  } else if (call.input != null) {
    try {
      args = typeof call.input === 'string' ? call.input : JSON.stringify(call.input);
    } catch {
      args = String(call.input);
    }
  }

  const explanation = String(
    call.explanation ?? call.description ?? call.summary ?? '',
  ).trim();

  return { ok: true, data: { id, name, args, explanation } };
}

export type DaemonEnvelope = {
  type: string;
  raw: Record<string, unknown>;
};

/** 事件信封：至少要有 type 字符串 */
export function parseDaemonEnvelope(event: unknown): ParseResult<DaemonEnvelope> {
  if (!isRecord(event)) {
    return { ok: false, error: 'daemon event is not an object' };
  }
  const type = String(event.type ?? event.event ?? event.kind ?? '').trim();
  if (!type) {
    return { ok: false, error: 'daemon event missing type' };
  }
  return { ok: true, data: { type, raw: event } };
}

/** 审批请求里猜 command 字段（集中一处，避免散落） */
export function extractApprovalCommandArgs(req: Record<string, unknown>): string {
  const keys = [
    'command',
    'cmd',
    'shell',
    'script',
    'arguments',
    'args',
    'input',
  ];
  for (const k of keys) {
    const v = req[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      try {
        return JSON.stringify(v);
      } catch {
        /* continue */
      }
    }
  }
  return '';
}
