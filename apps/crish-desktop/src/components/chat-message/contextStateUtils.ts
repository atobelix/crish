import type {
  ContextStateMetadata,
  MessageContextInjection,
  SessionMessage,
} from '../../store/types';

/**
 * 判定注入项是否为 context-state 纯状态微提示
 */
export function isContextStateInjection(
  injection: Partial<MessageContextInjection> | undefined
): boolean {
  if (!injection) return false;
  const meta = injection.metadata as Record<string, unknown> | undefined;
  if (meta?.mode === 'context-state') {
    return true;
  }
  const title = injection.title || '';
  return title === '上下文状态切换' || title === '状态切换';
}

/**
 * 判定消息是否为纯上下文状态切换载体消息（PureCarrier）。
 */
export function isContextStateCarrierMessage(
  msg: SessionMessage | undefined | null
): boolean {
  if (!msg || msg.sender !== 'assistant') return false;

  if ((msg.text || '').trim().length > 0) return false;
  if (msg.toolCalls && msg.toolCalls.length > 0) return false;
  if ((msg.thinking || '').trim().length > 0) return false;
  if (msg.thinkingTurns && msg.thinkingTurns.length > 0) return false;
  if (msg.images && msg.images.length > 0) return false;
  if (msg.attachments && msg.attachments.length > 0) return false;
  if (msg.errorDetail) return false;

  const blocks = msg.blocks || [];
  const injections = msg.injections || [];
  const hasBlocks = blocks.length > 0;
  const hasInjections = injections.length > 0;

  if (!hasBlocks && !hasInjections) return false;
  if (hasBlocks && !blocks.every((b) => b.type === 'context_injection')) {
    return false;
  }

  const allInjectionsState =
    !hasInjections || injections.every((inj) => isContextStateInjection(inj));

  const allBlocksState =
    !hasBlocks ||
    blocks.every((b) => {
      const inj = b.injection || injections.find((i) => i.id === b.id);
      return isContextStateInjection(inj);
    });

  return allBlocksState && allInjectionsState;
}

/**
 * 过滤消息列表中连续堆叠的状态切换微提示消息
 */
export function dedupeStateCarrierMessages<
  T extends {
    sender?: string;
    text?: string;
    toolCalls?: unknown[];
    thinking?: string;
    blocks?: Array<{ type: string; injection?: Partial<MessageContextInjection> }>;
    injections?: Array<Partial<MessageContextInjection>>;
  },
>(messages: T[]): T[] {
  if (messages.length <= 1) return messages;
  const result: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (!current) continue;
    if (isContextStateCarrierMessage(current as unknown as SessionMessage)) {
      const next = messages[i + 1];
      if (next && isContextStateCarrierMessage(next as unknown as SessionMessage)) {
        continue;
      }
    }
    result.push(current);
  }
  return result;
}

/**
 * 格式化上下文状态切换在对话流中的展示文案（极简纯文字打样，零 emoji）。
 */
export function formatContextStateDisplayText(
  input?: Partial<MessageContextInjection> | ContextStateMetadata | string,
  fallbackText?: string
): string {
  let metadata: ContextStateMetadata | undefined;
  let fallback = fallbackText || '';

  if (typeof input === 'string') {
    fallback = input;
  } else if (input && typeof input === 'object') {
    const inputObj = input as Record<string, unknown>;
    const nestedMeta = inputObj.metadata as Record<string, unknown> | undefined;
    if (inputObj.mode === 'context-state') {
      metadata = inputObj as unknown as ContextStateMetadata;
    } else if (nestedMeta && nestedMeta.mode === 'context-state') {
      metadata = nestedMeta as unknown as ContextStateMetadata;
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
    const parts: string[] = [];
    if (metadata.model) {
      parts.push(`切换到${metadata.model}`);
    } else if (metadata.profile) {
      parts.push(`切换到服务商 ${metadata.profile}`);
    }
    if (metadata.permission) {
      parts.push(`权限模式：${metadata.permission}`);
    }
    if (metadata.thinking) {
      parts.push(`思考档位：${metadata.thinking}`);
    }
    if (parts.length > 0) {
      return `系统 · ${parts.join('。 ')}。`;
    }
  }

  if (!fallback) return '系统 · 状态切换';

  let text = fallback.trim();
  text = text.replace(/^\[系统上下文注入\s*[·\-_]\s*状态切换\]\s*/i, '').trim();
  text = text.replace(/[(（](?:服务商|服务端)\s*[^)）]+[)）]\s*/g, '');
  text = text.replace(/(?:当前)?已切换到模型\s*/g, '切换到');
  text = text.replace(/\s+([。！？:：])/g, '$1');
  text = text.replace(/权限模式\s*[:：]\s*/g, '权限模式：');
  text = text.replace(/思考档位\s*[:：]\s*/g, '思考档位：');
  text = text.replace(/([。！？])\s*([^\s。！？])/g, '$1 $2');
  text = text.replace(/^系统\s*[·\-_]\s*/, '');
  text = `系统 · ${text.trim()}`;

  return text;
}
