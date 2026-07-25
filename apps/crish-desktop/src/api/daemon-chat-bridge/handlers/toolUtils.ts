import type { FileDiff } from '../../../store/types';
import {
  parseToolCallFields,
} from '../../daemonEventSchema';
import {
  safeParseToolCall,
  safeParseToolResult,
} from '../../daemonEventZod';
import { parseUnifiedDiffs } from '../../toolFeedback';
import { logInternalError } from '../../userFacingErrors';

export function toolCallFields(call: unknown): {
  id: string;
  name: string;
  args: string;
  explanation: string;
} {
  const zodParsed = safeParseToolCall(call);
  if (zodParsed.ok === true) return zodParsed.data;

  const light = parseToolCallFields(call);
  if (light.ok === true) return light.data;

  const err =
    (zodParsed.ok === false ? zodParsed.error : '') ||
    (light.ok === false ? light.error : 'tool-call parse failed');
  logInternalError('daemon-protocol', err);
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
} {
  const basics = safeParseToolResult(result);
  const id = basics.ok === true ? basics.data.id : '';
  const isError = basics.ok === true ? basics.data.isError : false;
  const text = basics.ok === true ? basics.data.text : '';
  let filePath = basics.ok === true ? basics.data.filePath : undefined;

  const r =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  let diffs: FileDiff[] | undefined;
  if (Array.isArray(r.diffs)) {
    diffs = r.diffs as FileDiff[];
  } else if (
    r.output &&
    typeof r.output === 'object' &&
    !Array.isArray(r.output)
  ) {
    const o = r.output as Record<string, unknown>;
    if (Array.isArray(o.diffs)) diffs = o.diffs as FileDiff[];
  }

  if (!filePath) {
    filePath =
      (typeof r.path === 'string' && r.path.trim() ? r.path.trim() : '') ||
      (typeof r.filePath === 'string' && r.filePath.trim()
        ? r.filePath.trim()
        : '') ||
      (r.output &&
      typeof r.output === 'object' &&
      !Array.isArray(r.output) &&
      typeof (r.output as { path?: string }).path === 'string' &&
      String((r.output as { path: string }).path).trim()
        ? String((r.output as { path: string }).path).trim()
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

  return { id, text, isError, diffs, filePath };
}
