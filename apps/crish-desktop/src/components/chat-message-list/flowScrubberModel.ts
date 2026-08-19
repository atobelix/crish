/**
 * FlowScrubber 纯逻辑：VSM 高度映射、滚动目标、tooltip 文案。
 * 刻度高度按真实消息块占文档比，不用等高校。
 */
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { formatMsgTime } from '../chat-message-row/chatMessageRowUtils';
import { pinSnippet } from './useScrollAnchor';

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
}

export type ScrubberSegment =
  | { type: 'gap'; key: string; flex: number }
  | { type: 'tick'; tick: ScrubberTick };

export type ScrubberLayoutManager = Pick<
  VirtualScrollManager,
  'getOffset' | 'getHeight' | 'getOrder'
>;

export function snippetFromUserText(text?: string): string {
  return pinSnippet(text, 80);
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
  if (userCount === 0 || total <= 0) return [];

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
      for (let j = i + 1; j < messages.length; j++) {
        const later = messages[j]!;
        if (later.sender === 'assistant') {
          nextAssistantId = later.id;
          break;
        }
        if (later.sender === 'user') break;
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

/** DOM 在视口内用 scrollIntoView；虚拟窗外用 VSM offset 居中。 */
export function scrollToScrubberTarget(
  scroller: HTMLElement,
  messageId: string,
  manager: ScrubberLayoutManager
): void {
  const inView = scroller.querySelector(
    `[data-msg-id="${CSS.escape(messageId)}"]`
  );
  if (inView instanceof HTMLElement) {
    inView.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const order = manager.getOrder();
  const index = order.indexOf(messageId);
  if (index < 0) return;
  const offset = manager.getOffset(index);
  const height = manager.getHeight(messageId);
  const viewH = scroller.clientHeight || 0;
  const top = Math.max(0, offset - Math.max(0, viewH - height) / 2);
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: 'smooth' });
  } else {
    scroller.scrollTop = top;
  }
}
