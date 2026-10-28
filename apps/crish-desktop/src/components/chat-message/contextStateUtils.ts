import { permissionModeLabel } from '../../api/permissionModes';
import { isContextStateCarrierMessage } from '../../store/storeAccess';
import type {
  ContextStateMetadata,
  MessageContextInjection,
  SessionMessage,
} from '../../store/types';

const CONTEXT_STATE_FIELD_ORDER = [
  'model',
  'profile',
  'permission',
  'thinking',
] as const;

// S-4（FINAL-PLAN §2）：载体 / 注入判定唯一定义在 store/sessionInjectionMount，
// 此处仅 re-export（经 storeAccess 门面），禁止再写平行实现（门禁 G-17）。
export {
  isContextStateCarrierMessage,
  isContextStateInjection,
} from '../../store/storeAccess';

/**
 * S-5：context-state 折叠（展示层唯一实现，列表间与消息内两处共用）。
 *
 * 输入为已按显示顺序排好、且已滤掉不可渲染项的序列；`isState(item)` 判定是否
 * 为状态提示，`stateKey(item)` 给出用于「相邻相同则折叠」的键（null = 不比较
 * 键，相邻状态项一律只保留最后一条）。非状态项会打断折叠：
 * - 列表层：相邻的纯载体消息只保留最后一条（中间隔着用户气泡的不合并）；
 * - 消息内：相邻的同文案状态注入只保留第一条（与原 MessageContent 语义一致）。
 */
export function collapseContextState<T>(
  items: readonly T[],
  isState: (item: T) => boolean,
  opts: { keep: 'last' | 'first-same-key'; stateKey?: (item: T) => string } = {
    keep: 'last',
  }
): T[] {
  if (items.length <= 1) return items.slice();
  const out: T[] = [];
  let prevWasState = false;
  let prevKey: string | null = null;
  for (const item of items) {
    if (!isState(item)) {
      out.push(item);
      prevWasState = false;
      prevKey = null;
      continue;
    }
    if (opts.keep === 'last') {
      if (prevWasState) out[out.length - 1] = item;
      else out.push(item);
    } else {
      const key = opts.stateKey ? opts.stateKey(item) : '';
      if (!(prevWasState && prevKey === key)) out.push(item);
      prevKey = key;
    }
    prevWasState = true;
  }
  return out;
}

/**
 * 过滤消息列表中连续堆叠的状态切换微提示消息（相邻载体只保留最后一条）。
 * 委托 S-5 collapseContextState。
 */
export function dedupeStateCarrierMessages<T>(messages: T[]): T[] {
  if (messages.length <= 1) return messages;
  return collapseContextState(messages, (m) =>
    isContextStateCarrierMessage(m as unknown as SessionMessage)
  );
}

function readChangedKeys(metadata: Record<string, unknown>): string[] | null {
  if (!Object.prototype.hasOwnProperty.call(metadata, 'changed')) return null;
  const raw = metadata.changed;
  if (!Array.isArray(raw)) return null;
  return raw.filter((item): item is string => typeof item === 'string');
}

function fieldText(
  key: string,
  value: string,
  withModel: boolean
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (key === 'model') return `已切换到 ${trimmed}`;
  if (key === 'profile') {
    return withModel ? `服务商 ${trimmed}` : `已切换到服务商 ${trimmed}`;
  }
  if (key === 'permission') return `权限 ${permissionModeLabel(trimmed)}`;
  if (key === 'thinking') return `思考 ${trimmed}`;
  return null;
}

/**
 * 结构化字段 → `已切换到 ornith-1.5-9b · 思考 High`。
 * 有 `changed` 时只渲染这些字段；没有 `changed`（历史消息）渲染全部已有字段。
 * 无「系统 ·」前缀，无句号。权限值走 permissionModeLabel（full → 完全允许）。
 */
function formatStructuredContextState(
  metadata: Record<string, unknown>
): string {
  const changed = readChangedKeys(metadata);
  const explicit = changed != null;
  let keys: readonly string[] = explicit
    ? CONTEXT_STATE_FIELD_ORDER.filter((key) => changed.includes(key))
    : CONTEXT_STATE_FIELD_ORDER;
  const modelValue =
    typeof metadata.model === 'string' ? metadata.model.trim() : '';
  // 历史消息没有 changed：沿用「有模型就不单列服务商」
  if (!explicit && modelValue) {
    keys = keys.filter((key) => key !== 'profile');
  }
  const parts: string[] = [];
  for (const key of keys) {
    const raw = metadata[key];
    if (typeof raw !== 'string') continue;
    const part = fieldText(key, raw, Boolean(modelValue));
    if (part) parts.push(part);
  }
  return parts.join(' · ');
}

/** 旧版纯文本回退，收成同一套短句（无「系统 ·」、无句号）。 */
function formatLegacyContextStateText(raw: string): string {
  let text = raw.trim();
  if (!text) return '状态切换';
  text = text.replace(/^\[系统上下文注入\s*[·\-_]\s*状态切换\]\s*/i, '').trim();
  text = text.replace(/[(（](?:服务商|服务端)\s*[^)）]+[)）]\s*/g, '');
  text = text.replace(/^系统\s*[·\-_]\s*/, '').trim();

  const model = text.match(/(?:当前)?已切换到模型\s*([^\s。！？]+)/)?.[1];
  const permission = text.match(/权限模式\s*[:：]\s*([^\s。]+)/)?.[1];
  const thinking = text.match(/思考档位\s*[:：]\s*([^\s。]+)/)?.[1];
  const parts: string[] = [];
  if (model) parts.push(`已切换到 ${model}`);
  if (permission) parts.push(`权限 ${permissionModeLabel(permission)}`);
  if (thinking) parts.push(`思考 ${thinking}`);
  if (parts.length > 0) return parts.join(' · ');

  text = text.replace(/[。．.\s]+$/g, '').trim();
  return text || '状态切换';
}

/**
 * 格式化上下文状态切换在对话流中的展示文案（极简纯文字，零 emoji）。
 */
export function formatContextStateDisplayText(
  input?: Partial<MessageContextInjection> | ContextStateMetadata | string,
  fallbackText?: string
): string {
  let metadata: Record<string, unknown> | undefined;
  let fallback = fallbackText || '';

  if (typeof input === 'string') {
    fallback = input;
  } else if (input && typeof input === 'object') {
    const inputObj = input as Record<string, unknown>;
    const nestedMeta = inputObj.metadata as Record<string, unknown> | undefined;
    if (inputObj.mode === 'context-state') {
      metadata = inputObj;
    } else if (nestedMeta && nestedMeta.mode === 'context-state') {
      metadata = nestedMeta;
      fallback =
        fallback ||
        (typeof inputObj.summary === 'string' ? inputObj.summary : '') ||
        (typeof inputObj.content === 'string' ? inputObj.content : '') ||
        '';
    } else if (
      typeof inputObj.summary === 'string' ||
      typeof inputObj.content === 'string'
    ) {
      fallback =
        fallback ||
        (typeof inputObj.summary === 'string' ? inputObj.summary : '') ||
        (typeof inputObj.content === 'string' ? inputObj.content : '') ||
        '';
    }
  }

  if (metadata) {
    const structured = formatStructuredContextState(metadata);
    if (structured) return structured;
  }

  if (!fallback) return '状态切换';
  return formatLegacyContextStateText(fallback);
}
