/**
 * Daemon 事件桥层轻量 schema（不引入 zod 依赖时的 safeParse 等价物）。
 * 协议不匹配时返回 { ok:false, error }，便于日志可见。
 *
 * ParseResult 判别联合 + 收窄守卫与 engineEventZod 共用，避免两处分叉。
 */

/** 成功支路：调用方经 isParseOk 收窄后可读 data */
export type ParseOk<T> = { readonly ok: true; readonly data: T };
/** 失败支路：调用方经 isParseErr 收窄后可读 error */
export type ParseErr = { readonly ok: false; readonly error: string };
/** 解析结果判别联合（ok 字面量区分支路） */
export type ParseResult<T> = ParseOk<T> | ParseErr;

/** 类型守卫：成功路径安全读 result.data */
export function isParseOk<T>(result: ParseResult<T>): result is ParseOk<T> {
  return result.ok === true;
}

/** 类型守卫：失败路径安全读 result.error */
export function isParseErr<T>(result: ParseResult<T>): result is ParseErr {
  return result.ok === false;
}

/** 构造成功结果（ok 恒为 true 字面量，利于收窄） */
export function parseOk<T>(data: T): ParseOk<T> {
  return { ok: true, data };
}

/** 构造失败结果（error 归一为非空字符串） */
export function parseErr(error: string): ParseErr {
  const msg = typeof error === 'string' ? error.trim() : '';
  return { ok: false, error: msg || 'parse failed' };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type EngineToolCallFields = {
  id: string;
  name: string;
  args: string;
  explanation: string;
};

/** 解析 tool-call 载荷；缺 id/name 视为协议失败 */
export function parseToolCallFields(call: unknown): ParseResult<EngineToolCallFields> {
  if (!isRecord(call)) {
    return parseErr('tool-call payload is not an object');
  }
  const id = String(call.id ?? call.toolCallId ?? call.tool_call_id ?? '').trim();
  const name = String(call.name ?? call.toolName ?? call.tool_name ?? '').trim();
  if (!id) return parseErr('tool-call missing id');
  if (!name) return parseErr('tool-call missing name');

  let args = '';
  if (typeof call.arguments === 'string') args = call.arguments;
  else if (typeof call.args === 'string') args = call.args;
  else if (call.arguments != null) {
    try {
      args = JSON.stringify(call.arguments);
    } catch {
      args = String(call.arguments);
    }
  } else {
    // Align with ToolBatchCall.input / PermissionRequest.parameters
    for (const k of ['parameters', 'input', 'args'] as const) {
      const v = call[k];
      if (v == null) continue;
      if (typeof v === 'string') {
        args = v;
        break;
      }
      try {
        args = JSON.stringify(v);
      } catch {
        args = String(v);
      }
      break;
    }
  }

  const explanation = String(
    call.explanation ?? call.description ?? call.summary ?? '',
  ).trim();

  return parseOk({ id, name, args, explanation });
}

export type EngineEnvelope = {
  type: string;
  raw: Record<string, unknown>;
};

/** 事件信封：至少要有 type 字符串 */
export function parseEngineEnvelope(event: unknown): ParseResult<EngineEnvelope> {
  if (!isRecord(event)) {
    return parseErr('engine event is not an object');
  }
  const type = String(event.type ?? event.event ?? event.kind ?? '').trim();
  if (!type) {
    return parseErr('engine event missing type');
  }
  return parseOk({ type, raw: event });
}

/**
 * 审批请求里提取可展示/可匹配的 command 参数。
 * 协议主路径：
 * - nested runtime: `parameters: { command }`（PermissionRequest）
 * - flat daemon WS: `input: { command }`（ApprovalRequestedMessage）
 * 兼容顶层 command/args 与嵌套对象。
 */
export function extractApprovalCommandArgs(req: Record<string, unknown>): string {
  // 1) 协议字段 parameters | input（勿整包 JSON 化成审批卡正文）
  for (const key of ['parameters', 'input'] as const) {
    const bag = req[key];
    if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
      const nested = extractCommandLikeFromRecord(bag as Record<string, unknown>);
      if (nested) return nested;
      try {
        return JSON.stringify(bag);
      } catch {
        /* try next key */
      }
    } else if (typeof bag === 'string' && bag.trim()) {
      return bag.trim();
    }
  }

  // 2) 顶层 command-like 键
  const top = extractCommandLikeFromRecord(req);
  if (top) return top;

  // 3) 兼容 arguments / args 整段（input 已在步骤 1 处理）
  for (const k of ['arguments', 'args'] as const) {
    const v = req[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      if (!Array.isArray(v)) {
        const nested = extractCommandLikeFromRecord(v as Record<string, unknown>);
        if (nested) return nested;
      }
      try {
        return JSON.stringify(v);
      } catch {
        /* continue */
      }
    }
  }
  return '';
}

function extractCommandLikeFromRecord(obj: Record<string, unknown>): string {
  for (const k of ['command', 'cmd', 'shell', 'script'] as const) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const argv = obj.argv;
  if (Array.isArray(argv) && argv.every((x) => typeof x === 'string') && argv.length > 0) {
    return (argv as string[]).join(' ');
  }
  return '';
}
