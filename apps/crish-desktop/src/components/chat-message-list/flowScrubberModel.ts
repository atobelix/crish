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

/**
 * 轨道刻度的像素节距 = 刻度本体 2px（`FlowScrubber.module.css` 的
 * `.tick { height: 2px }`）+ 轨道列间距 8px（`.root { gap: 8px }`）。
 * 用于由轨道可用高度反推「最多能排下多少枚刻度」。
 */
export const SCRUBBER_TICK_PITCH_PX = 10;

/**
 * 有界刻度渲染：按轨道可用容量聚合刻度。
 *
 * 存在理由（缺陷修复，2026-09-15）：
 * 轨道是**固定高度条带**（`.wrapper` 绝对定位 top:0/bottom:0，`.root` 竖直
 * flex 居中堆叠固定 2px 高的 `.tick`），并不按文档高度比例布局——
 * `buildScrubberSegments` 算出的 `flex` / `heightPercent` 在 DOM 中无消费方
 * （`.gap { display: none }`、`.tickSlot { flex: 0 0 auto }`、
 * `data-height-percent` 无 CSS 引用）。因此轨道可容纳的刻度数由**轨道像素
 * 高度**决定，与消息数无关。
 *
 * 不做聚合的后果（实测，N=6000 条消息）：
 *   ① 轨道产出 ~1.5×N 个 DOM 节点，而每次滚动提交都要协调它们
 *      ⇒ 单次提交渲染 49ms、每帧 189ms（是 16.7ms 帧预算的 11 倍）；
 *      短路轨道渲染后每帧回落到 25ms 且**与 N 无关**（300→6000 持平）；
 *   ② 刻度总高（N×10px）远超轨道高度，溢出到视口之外（`.root` 为
 *      `overflow: visible`）⇒ 超出容量的刻度既看不见也点不到。
 *
 * 聚合语义：每桶取**首个**刻度为代表（跳转与悬停预览均指向该轮次）；
 * **已固定（pinned）的刻度一律保留**——固定标记是显式用户资产，不得因
 * 降采样丢失。gap 段在 DOM 中 `display: none`、无布局作用，聚合路径不再保留。
 *
 * @param segments 原始分段
 * @param maxTicks 轨道可容纳的刻度上限（由像素高度 / 节距推得）
 * @param isPinned 判断某刻度是否必须保留（默认不保留额外刻度）
 */
export function capScrubberSegments(
  segments: readonly ScrubberSegment[],
  maxTicks: number,
  isPinned?: (id: string) => boolean
): ScrubberSegment[] {
  const tickTotal = countScrubberTicks(segments);
  if (maxTicks < 1 || tickTotal <= maxTicks) return segments.slice();
  const stride = Math.ceil(tickTotal / maxTicks);
  const out: ScrubberSegment[] = [];
  let seen = 0;
  for (const seg of segments) {
    if (seg.type !== 'tick') continue;
    const keep = seen % stride === 0 || Boolean(isPinned?.(seg.tick.id));
    seen += 1;
    if (keep) out.push(seg);
  }
  return out;
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
