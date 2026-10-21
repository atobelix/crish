/**
 * 输入框高度只在「形态真的变了」时减速到位：
 * 单行与多行切换、附件条出现或消失。
 * 多行里继续换行不锁高度，避免把刚打出来的字裁掉。
 */
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import { DURATION_ACCORDION_MS } from '../../utils/motionTokens';

const HEIGHT_EPSILON_PX = 1;
const WIDTH_EPSILON_PX = 0.5;

export function prefersReducedComposerMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.hasAttribute('data-reduced-motion')) return true;
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function shouldSettleComposerHeight(input: {
  previousHeight: number;
  nextHeight: number;
  previousWidth: number;
  nextWidth: number;
  previousMultiline: string | null;
  nextMultiline: string | null;
  previousAttached: boolean;
  nextAttached: boolean;
  reducedMotion: boolean;
}): boolean {
  if (input.reducedMotion) return false;
  if (input.previousHeight <= 0) return false;
  if (Math.abs(input.nextWidth - input.previousWidth) > WIDTH_EPSILON_PX) {
    return false;
  }
  if (Math.abs(input.nextHeight - input.previousHeight) <= HEIGHT_EPSILON_PX) {
    return false;
  }
  return (
    input.previousMultiline !== input.nextMultiline ||
    input.previousAttached !== input.nextAttached
  );
}

function readAttach(card: HTMLElement): boolean {
  return card.querySelector('[data-testid="composer-attach-strip"]') != null;
}

/**
 * 把边框从上一帧高度收到新高度。过渡曲线写在样式表的 height 上。
 * 返回取消函数。
 */
export function bindComposerHeightSettle(card: HTMLElement): () => void {
  let paintedHeight = card.offsetHeight;
  let paintedWidth = card.offsetWidth;
  let multiline = card.getAttribute('data-multiline');
  let attached = readAttach(card);
  let locking = false;
  let timer = 0;

  const release = () => {
    if (!locking) return;
    locking = false;
    window.clearTimeout(timer);
    card.style.transition = 'none';
    card.style.height = '';
    card.style.overflow = '';
    card.getBoundingClientRect();
    card.style.transition = '';
    paintedHeight = card.offsetHeight;
    paintedWidth = card.offsetWidth;
  };

  const onEnd = (event: TransitionEvent) => {
    if (event.target !== card || event.propertyName !== 'height') return;
    card.removeEventListener('transitionend', onEnd);
    release();
  };

  const tween = (from: number, to: number) => {
    locking = true;
    card.style.overflow = 'hidden';
    card.style.transition = 'none';
    card.style.height = `${from}px`;
    card.getBoundingClientRect();
    card.style.transition = '';
    card.style.height = `${to}px`;
    card.addEventListener('transitionend', onEnd);
    timer = window.setTimeout(() => {
      card.removeEventListener('transitionend', onEnd);
      release();
    }, DURATION_ACCORDION_MS + 80);
  };

  const onResize = () => {
    if (locking) return;
    const nextHeight = card.offsetHeight;
    const nextWidth = card.offsetWidth;
    const nextMultiline = card.getAttribute('data-multiline');
    const nextAttached = readAttach(card);
    const settle = shouldSettleComposerHeight({
      previousHeight: paintedHeight,
      nextHeight,
      previousWidth: paintedWidth,
      nextWidth,
      previousMultiline: multiline,
      nextMultiline,
      previousAttached: attached,
      nextAttached,
      reducedMotion: prefersReducedComposerMotion(),
    });
    multiline = nextMultiline;
    attached = nextAttached;
    if (!settle) {
      paintedHeight = nextHeight;
      paintedWidth = nextWidth;
      return;
    }
    const from = paintedHeight;
    paintedHeight = nextHeight;
    paintedWidth = nextWidth;
    tween(from, nextHeight);
  };

  const observer = ResizeObserverManager.getInstance();
  observer.observe(card, onResize);
  return () => {
    card.removeEventListener('transitionend', onEnd);
    window.clearTimeout(timer);
    observer.unobserve(card, onResize);
    card.style.height = '';
    card.style.overflow = '';
    card.style.transition = '';
  };
}
