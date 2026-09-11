/**
 * FlowScrubber 纯逻辑：VSM 高度映射、滚动目标、tooltip 文案。
 * 刻度高度按真实消息块占文档比，不用等高校。
 */
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { formatMsgTime } from '../chat-message-row/chatMessageRowUtils';
import { pinSnippet } from './useScrollAnchor';
import { CHAT_SCROLL_PAD_TOP } from './chatScrollGeometry';

/** 产品用户气泡（不要抄参考 .flow-msg--user） */
export const USER_BUBBLE_SELECTOR = '[data-role="user"][data-msg-id]';

export interface ScrubberMessage {
  id: string;
  sender: string;
  text?: string;
  timestamp: number;
}

export interface ScrubberTick {
  id: string;
  /** 用于 flex-grow 的绝对高度（VSM 像素） */
  flex: number;
  /** 该用户块占整份文档高度比 */
  heightPercent: number;
  snippet: string;
  timestamp: number;
  nextAssistantId?: string;
  assistantSnippet?: string;
}

export type ScrubberSegment =
  | { type: 'gap'; key: string; flex: number }
  | { type: 'tick'; tick: ScrubberTick };

export type ScrubberLayoutManager = Pick<
  VirtualScrollManager,
  'getOffset' | 'getHeight' | 'getOrder'
>;

export function cleanMarkdownForSnippet(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^>\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function snippetFromUserText(text?: string): string {
  return pinSnippet(cleanMarkdownForSnippet(text), 48);
}

export function snippetFromAssistantText(text?: string): string {
  return pinSnippet(cleanMarkdownForSnippet(text), 160);
}

/**
 * 按文档真实高度比拆 spacer + 用户刻度。
 * 无用户气泡返回空数组（调用方不得画空柱）。
 */
export function buildScrubberSegments(
  messages: ReadonlyArray<ScrubberMessage>,
  getHeight: (id: string) => number
): ScrubberSegment[] {
  if (!messages.length) return [];

  const heights: number[] = [];
  let total = 0;
  let userCount = 0;
  for (const msg of messages) {
    const h = getHeight(msg.id);
    const safe = Number.isFinite(h) && h > 0 ? h : 0;
    heights.push(safe);
    total += safe;
    if (msg.sender === 'user') userCount += 1;
  }
  if (userCount === 0) return [];
  if (total <= 0) {
    total = messages.length * 100;
    for (let i = 0; i < heights.length; i++) {
      heights[i] = 100;
    }
  }

  const segs: ScrubberSegment[] = [];
  let pendingGap = 0;
  let gapIndex = 0;

  const flushGap = () => {
    if (pendingGap <= 0) return;
    segs.push({ type: 'gap', key: `gap-${gapIndex}`, flex: pendingGap });
    gapIndex += 1;
    pendingGap = 0;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const h = heights[i]!;
    if (msg.sender === 'user') {
      flushGap();
      let nextAssistantId: string | undefined;
      let assistantSnippet: string | undefined;
      for (let j = i + 1; j < messages.length; j++) {
        const later = messages[j]!;
        if (later.sender === 'user') break;
        if (later.sender === 'assistant') {
          if (!nextAssistantId) {
            nextAssistantId = later.id;
          }
          if (later.text && later.text.trim()) {
            assistantSnippet = snippetFromAssistantText(later.text);
            nextAssistantId = later.id;
            break;
          }
        }
      }
      segs.push({
        type: 'tick',
        tick: {
          id: msg.id,
          flex: h,
          heightPercent: h / total,
          snippet: snippetFromUserText(msg.text),
          timestamp: msg.timestamp,
          nextAssistantId,
          assistantSnippet,
        },
      });
    } else {
      pendingGap += h;
    }
  }
  flushGap();
  return segs;
}

export function countScrubberTicks(segments: readonly ScrubberSegment[]): number {
  let n = 0;
  for (const seg of segments) {
    if (seg.type === 'tick') n += 1;
  }
  return n;
}

export function formatTickTooltip(opts: {
  snippet: string;
  flowOn: boolean;
  timeLabel?: string;
  purpose?: string;
}): string {
  const snippet = (opts.snippet || '').trim();
  if (!opts.flowOn) return snippet;
  const title = (opts.purpose || opts.timeLabel || '').trim();
  if (!title) return snippet;
  if (!snippet || snippet === title) return title;
  return `${title} · ${snippet}`;
}

export function timeLabelFromTimestamp(ts?: number): string {
  return formatMsgTime(ts);
}

export function isConversationFlowOn(el: Element | null): boolean {
  return Boolean(el?.closest('[data-conversation-flow="on"]'));
}

export function readPurposeLabel(
  root: ParentNode | null,
  assistantId?: string
): string | undefined {
  if (!root || !assistantId) return undefined;
  const node = root.querySelector(
    `[data-msg-id="${CSS.escape(assistantId)}"] [data-flow-purpose]`
  );
  if (!node) return undefined;
  const raw = (
    node.getAttribute('aria-label') ||
    node.textContent ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  return raw ? raw.slice(0, 80) : undefined;
}

export function wheelDeltaY(
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>
): number {
  return e.deltaMode === 1 ? e.deltaY * 36 : e.deltaY;
}

/** DOM 在视口内用 scrollIntoView；长消息顶部对齐防裁切（受 .row scroll-margin-top: 56px 保护）；虚拟窗外用 VSM offset。 */
export function scrollToScrubberTarget(
  scroller: HTMLElement,
  messageId: string,
  manager: ScrubberLayoutManager
): void {
  const inView = scroller.querySelector(
    `[data-msg-id="${CSS.escape(messageId)}"]`
  );
  if (inView instanceof HTMLElement) {
    const viewH = scroller.clientHeight || 0;
    const targetH = inView.offsetHeight || 0;
    // 目标消息高度超过视口 50% 时顶部对齐，避免长助手回复居中导致开头被向上顶出视口裁切
    if (targetH > viewH * 0.5 && viewH > 0) {
      inView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      inView.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }
  const order = manager.getOrder();
  const index = order.indexOf(messageId);
  if (index < 0) return;
  const offset = manager.getOffset(index);
  const height = manager.getHeight(messageId);
  const viewH = scroller.clientHeight || 0;
  // 文档坐标 = PAD_TOP + VSM offset（与 MessageVirtualizer 切片定位一致）
  const docOffset = CHAT_SCROLL_PAD_TOP + offset;
  const top =
    height > viewH * 0.5 && viewH > 0
      ? Math.max(0, docOffset - 24)
      : Math.max(0, docOffset - Math.max(0, viewH - height) / 2);
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: 'smooth' });
  } else {
    scroller.scrollTop = top;
  }
}
