export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  blocks: readonly LLMMessageBlock[];
  [key: string]: unknown;
}

export type LLMMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool-call'; id: string; toolName?: string; input?: Record<string, unknown> }
  | { type: 'tool-result'; toolCallId: string; toolName?: string; isError?: boolean; output?: unknown };

export interface SliceResult {
  messages: LLMMessage[];
  foldedCount: number;
  foldedTokens: number;
  foldedSummary?: string;
}

function collectToolCallIds(messages: LLMMessage[], fromIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let i = fromIndex; i < messages.length; i++) {
    for (const block of messages[i]!.blocks) {
      if (block.type === 'tool-call' && block.id) {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

function hasOrphanedToolResult(messages: LLMMessage[], cutIndex: number): boolean {
  const keptIds = collectToolCallIds(messages, cutIndex);
  for (let i = cutIndex; i < messages.length; i++) {
    for (const block of messages[i]!.blocks) {
      if (block.type === 'tool-result') {
        if (!keptIds.has(block.toolCallId)) {
          return true;
        }
      }
    }
  }
  return false;
}

function removeOrphanedToolResults(message: LLMMessage, keptCallIds: Set<string>): LLMMessage {
  const filteredBlocks = message.blocks.filter((block) => {
    if (block.type !== 'tool-result') return true;
    return keptCallIds.has(block.toolCallId);
  });
  if (filteredBlocks.length === message.blocks.length) return message;
  return { ...message, blocks: filteredBlocks };
}

function stripOrphanedToolResultsFromSuffix(
  messages: LLMMessage[],
  cutIndex: number
): LLMMessage[] {
  const keptCallIds = collectToolCallIds(messages, cutIndex);
  return messages.map((msg, i) => {
    if (i < cutIndex) return msg;
    return removeOrphanedToolResults(msg, keptCallIds);
  });
}

export function sliceContextAtValidBoundary(
  messages: LLMMessage[],
  maxTokens: number,
  tokenEstimator: (msg: LLMMessage) => number
): SliceResult {
  const n = messages.length;
  if (n === 0) {
    return { messages: [], foldedCount: 0, foldedTokens: 0 };
  }

  const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;
  const effectiveMessages = systemMessage ? messages.slice(1) : messages;

  if (effectiveMessages.length === 0) {
    return { messages: [systemMessage!], foldedCount: 0, foldedTokens: 0 };
  }

  let total = 0;
  let firstExceedIndex = -1;
  try {
    for (let i = effectiveMessages.length - 1; i >= 0; i--) {
      total += tokenEstimator(effectiveMessages[i]!);
      if (total > maxTokens) {
        firstExceedIndex = i;
        break;
      }
    }
  } catch {
    return {
      messages: systemMessage ? [systemMessage, ...effectiveMessages] : [...effectiveMessages],
      foldedCount: 0,
      foldedTokens: 0,
    };
  }

  if (firstExceedIndex === -1) {
    return {
      messages: systemMessage ? [systemMessage, ...effectiveMessages] : [...effectiveMessages],
      foldedCount: 0,
      foldedTokens: 0,
    };
  }

  let cutIndex = findNearestUserBoundary(effectiveMessages, firstExceedIndex);

  if (cutIndex === -1) {
    return degradedSlice(effectiveMessages, maxTokens, tokenEstimator, systemMessage);
  }

  if (hasOrphanedToolResult(effectiveMessages, cutIndex)) {
    cutIndex = findEarlierSafeBoundary(effectiveMessages, cutIndex);
  }

  if (cutIndex === -1) {
    return degradedSlice(effectiveMessages, maxTokens, tokenEstimator, systemMessage);
  }

  const kept = effectiveMessages.slice(cutIndex);
  const folded = effectiveMessages.slice(0, cutIndex);

  return {
    messages: systemMessage ? [systemMessage, ...kept] : kept,
    foldedCount: folded.length,
    foldedTokens: folded.reduce((s, m) => s + tokenEstimator(m), 0),
  };
}

function findNearestUserBoundary(messages: LLMMessage[], startIndex: number): number {
  for (let i = startIndex; i >= 0; i--) {
    if (messages[i]!.role === 'user' || messages[i]!.role === 'system') {
      return i;
    }
  }
  return -1;
}

function findEarlierSafeBoundary(messages: LLMMessage[], fromIndex: number): number {
  // Search from fromIndex - 1 backwards for next user boundary
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user' || messages[i]!.role === 'system') {
      if (!hasOrphanedToolResult(messages, i)) {
        return i;
      }
    }
  }
  return -1;
}

function degradedSlice(
  messages: LLMMessage[],
  maxTokens: number,
  tokenEstimator: (msg: LLMMessage) => number,
  systemMessage: LLMMessage | null
): SliceResult {
  // L1: Find nearest user boundary, strip orphaned tool_results
  const l1Cut = findNearestUserBoundary(messages, messages.length - 1);
  if (l1Cut !== -1) {
    const cleaned = stripOrphanedToolResultsFromSuffix(messages, l1Cut);
    if (!hasOrphanedToolResult(cleaned, l1Cut)) {
      const kept = cleaned.slice(l1Cut);
      const folded = cleaned.slice(0, l1Cut);
      return {
        messages: systemMessage ? [systemMessage, ...kept] : kept,
        foldedCount: folded.length,
        foldedTokens: folded.reduce((s, m) => s + tokenEstimator(m), 0),
      };
    }
  }

  // L2: Force cut at nearest user boundary with warning
  console.warn(
    '[context-slicer] L2 degradation: forcing cut at user boundary with potentially dangling tool pairs'
  );
  if (l1Cut !== -1) {
    const kept = messages.slice(l1Cut);
    const folded = messages.slice(0, l1Cut);
    return {
      messages: systemMessage ? [systemMessage, ...kept] : kept,
      foldedCount: folded.length,
      foldedTokens: folded.reduce((s, m) => s + tokenEstimator(m), 0),
    };
  }

  // L3: Compress — fold all messages into a summary, keep the last message
  // Since we can't find any user boundary, return everything with a folded summary of older messages
  const summaryMessages: LLMMessage[] = [];
  let foldedTokens = 0;
  // Keep at minimum the last message, fold everything else
  const keepCount = Math.min(2, messages.length);
  const foldCount = messages.length - keepCount;

  if (foldCount > 0) {
    const folded = messages.slice(0, foldCount);
    foldedTokens = folded.reduce((s, m) => s + tokenEstimator(m), 0);
    const summaryText = folded
      .reverse()
      .slice(0, 3)
      .map((m) => roleLabel(m.role))
      .join(', ');
    const summaryMsg: LLMMessage = {
      role: 'user',
      blocks: [{ type: 'text', text: `[context slice summary: ${foldCount} earlier messages (${foldedTokens} tokens): ${summaryText}]` }],
    };
    summaryMessages.push(summaryMsg);
  }

  const kept = messages.slice(foldCount);

  return {
    messages: systemMessage ? [systemMessage, ...summaryMessages, ...kept] : [...summaryMessages, ...kept],
    foldedCount: foldCount,
    foldedTokens,
    foldedSummary: summaryTextFromMessages(messages.slice(0, foldCount)),
  };
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    case 'system': return 'system';
    default: return role;
  }
}

function summaryTextFromMessages(messages: LLMMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const texts: string[] = [];
    for (const block of msg.blocks) {
      if (block.type === 'text') texts.push(block.text.slice(0, 200));
      if (block.type === 'tool-call') texts.push(`[tool-call: ${block.toolName ?? 'unknown'}]`);
      if (block.type === 'tool-result') texts.push(`[tool-result: ${block.toolName ?? 'unknown'}]`);
    }
    const content = texts.join(' ').slice(0, 300);
    if (content) lines.push(`[${msg.role}]: ${content}`);
  }
  return lines.join('\n');
}
