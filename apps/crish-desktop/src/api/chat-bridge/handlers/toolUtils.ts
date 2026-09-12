/**
 * 工具事件字段宽容抽取（T7：双 zod 合并后仅保留最小防御解析）。
 *
 * toolCallFields / toolResultFields 保留原 zod 层的等价语义
 * （id/name 别名、output/input/parameters 归一、error 真值判定），
 * 但不再依赖 zod 解析模块，字段抽取直接内联，供 tool-start / tool-end handler 使用。
 */
import type { FileDiff } from '../../../store/types';
import { parseToolCallFields } from '../../engineEventSchema';
import { parseUnifiedDiffs } from '../../toolFeedback';
import { logInternalError } from '../../userFacingErrors';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringifyUnknown(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** tool-result 基础字段：id（toolCallId 优先）、isError（含 error 真值）、text、filePath、durationMs */
function toolResultBasics(result: unknown): {
  id: string;
  text: string;
  isError: boolean;
  filePath?: string;
  durationMs?: number;
} {
  const r = isRecord(result) ? result : {};
  const id = String(r.toolCallId ?? r.id ?? r.tool_call_id ?? '').trim();
  const isError = Boolean(r.isError) || (r.error != null && r.error !== false);
  const durationMs =
    typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms)
      ? r.duration_ms
      : typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
        ? r.durationMs
        : undefined;
  let text = '';
  if (typeof r.output === 'string') {
    text = r.output;
  } else if (isRecord(r.output)) {
    text =
      typeof r.output.text === 'string' ? r.output.text : stringifyUnknown(r.output);
  } else if (typeof r.text === 'string') {
    text = r.text;
  } else if (r.error != null && r.error !== false) {
    text = stringifyUnknown(r.error);
  }
  let filePath: string | undefined;
  if (typeof r.path === 'string' && r.path.trim()) filePath = r.path.trim();
  else if (typeof r.filePath === 'string' && r.filePath.trim())
    filePath = r.filePath.trim();
  else if (isRecord(r.output)) {
    const o = r.output;
    if (typeof o.path === 'string' && o.path.trim()) filePath = o.path.trim();
    else if (typeof o.filePath === 'string' && o.filePath.trim())
      filePath = o.filePath.trim();
  }
  return {
    id,
    text,
    isError,
    ...(filePath ? { filePath } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function toolCallFields(call: unknown): {
  id: string;
  name: string;
  args: string;
  explanation: string;
} {
  const parsed = parseToolCallFields(call);
  if (parsed.ok === true) return parsed.data;

  logInternalError('engine-protocol', parsed.error);
  return { id: `tc-${Date.now()}`, name: 'tool', args: '', explanation: '' };
}

export function toolCallFieldsFromEvent(event: Record<string, unknown>): {
  id: string;
  name: string;
  args: string;
  explanation: string;
} {
  if (event.call != null) {
    const fromCall = toolCallFields(event.call);
    if (fromCall.id && fromCall.name && fromCall.name !== 'tool')
      return fromCall;
    const fromTop = toolCallFields(event);
    if (fromTop.id && fromTop.name && fromTop.name !== 'tool') return fromTop;
    return fromCall;
  }
  return toolCallFields(event);
}

export function toolResultFields(result: unknown): {
  id: string;
  text: string;
  isError: boolean;
  diffs?: FileDiff[];
  filePath?: string;
  durationMs?: number;
} {
  const basics = toolResultBasics(result);
  const { id, text, isError, durationMs } = basics;
  let filePath = basics.filePath;

  const r = isRecord(result) ? result : ({} as Record<string, unknown>);

  let diffs: FileDiff[] | undefined;
  if (Array.isArray(r.diffs)) {
    diffs = r.diffs as FileDiff[];
  } else if (isRecord(r.output)) {
    const o = r.output;
    if (Array.isArray(o.diffs)) diffs = o.diffs as FileDiff[];
  }

  if (!filePath) {
    filePath =
      (typeof r.path === 'string' && r.path.trim() ? r.path.trim() : '') ||
      (typeof r.filePath === 'string' && r.filePath.trim()
        ? r.filePath.trim()
        : '') ||
      (isRecord(r.output) &&
      typeof r.output.path === 'string' &&
      String(r.output.path).trim()
        ? String(r.output.path).trim()
        : '') ||
      undefined;
    if (filePath === '') filePath = undefined;
  }

  if (
    !diffs &&
    text &&
    !isError &&
    (/\bdiff --git\b/.test(text) || /^@@\s+-\d/m.test(text))
  ) {
    const parsed = parseUnifiedDiffs(text);
    if (parsed.length) diffs = parsed;
  }

  return {
    id,
    text,
    isError,
    diffs,
    filePath,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
