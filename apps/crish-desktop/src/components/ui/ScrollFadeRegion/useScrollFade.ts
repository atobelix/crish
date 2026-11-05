/**
 * useScrollFade — 内部滚动区边缘渐隐四态状态机（HC1 · 容器治理）。
 *
 * 宿主元素（滚动容器本体）挂 `data-fade` 属性，渐隐由全局 scroll-fade.css 的
 * mask-image 作用于宿主的内容内层（.scroll-fade-inner / 代码块的 <code>），
 * 滚动条绘制在宿主本体、不受淡化。状态只取决于宿主自身三值：
 *
 *   none   —— scrollHeight 不超过 clientHeight（不可滚），无渐变；
 *   bottom —— 可滚且在顶（scrollTop ≤ 1），只显底部渐变；
 *   both   —— 中间位置，上下都显；
 *   top    —— 在底（scrollTop + clientHeight ≥ scrollHeight − 1），只显顶部。
 *
 * 纪律（防测高反馈回路，与 R2 同源）：
 * - 只读宿主自身三值、只写自身 data 属性，不进入虚拟列表状态；
 * - scroll + ResizeObserver 一律节流到 rAF 合帧写回；
 * - 状态切换不做过渡动画（滚动中的离散翻转带时长会拖影，定案口径）；
 * - 宿主 computed overflow-y 非 auto/scroll 时（如组内被降格的工具视口）
 *   恒 'none'——滚动层级唯一化由 CSS 决定，状态机以 CSS 为准不自作主张。
 * - 尺寸观察统一经 ResizeObserverManager 单例批处理（G-03 收敛，
 *   2026-11-02 整波收口迁移；jsdom 等无 ResizeObserver 环境保持不观察，
 *   与迁移前的守卫口径一致）。
 */
import { useEffect, type RefObject } from 'react';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';

export type ScrollFadeState = 'none' | 'bottom' | 'both' | 'top';

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * 滚动渐隐状态判定（纯函数）：
 * - 不可滚（scrollHeight - clientHeight <= 1）→ 'none'
 * - 在顶（scrollTop <= 2）→ 'bottom'（顶端 100% 实色不遮挡首行，底部展示平滑渐隐）
 * - 在底（scrollTop + clientHeight >= scrollHeight - 2）→ 'top'（底部 100% 实色不遮挡末行，顶端展示平滑渐隐）
 * - 滚动中（其他）→ 'both'（顶端与底端均展示平滑 Ease 渐变，内容穿行两端自然淡入淡出）
 */
export function computeScrollFadeState(m: ScrollMetrics): ScrollFadeState {
  if (m.scrollHeight - m.clientHeight <= 1) return 'none';
  if (m.scrollTop <= 2) return 'bottom';
  if (m.scrollTop + m.clientHeight >= m.scrollHeight - 2) return 'top';
  return 'both';
}

/**
 * 为任意滚动宿主挂载状态机，返回卸载函数。
 * 内容流式生长改变 scrollHeight 而宿主尺寸不变，故同时观察宿主与其直接子元素
 * （内层 wrapper / code）的尺寸变化兜底重算。
 */
export function attachScrollFade(host: HTMLElement): () => void {
  let raf = 0;
  let disposed = false;
  // G-03：观察统一经 ResizeObserverManager（单例内部持唯一 RO 并批处理
  // 分发）；无 ResizeObserver 的环境（jsdom）不观察，与原守卫口径一致。
  const manager =
    typeof ResizeObserver !== 'undefined'
      ? ResizeObserverManager.getInstance()
      : null;
  const observed: Element[] = [host, ...Array.from(host.children)];

  let isScrollable = true;
  const checkOverflow = () => {
    if (!host.isConnected) return false;
    const overflowY = window.getComputedStyle(host).overflowY;
    isScrollable = overflowY === 'auto' || overflowY === 'scroll';
    return isScrollable;
  };

  const update = () => {
    raf = 0;
    if (disposed) return;
    if (!host.isConnected) {
      detach();
      return;
    }
    const next: ScrollFadeState = isScrollable
      ? computeScrollFadeState(host)
      : 'none';
    if (host.dataset.fade !== next) {
      host.dataset.fade = next;
    }
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };
  const onResize = () => {
    checkOverflow();
    schedule();
  };
  const detach = () => {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    host.removeEventListener('scroll', schedule);
    if (manager) {
      for (const el of observed) manager.unobserve(el, onResize);
    }
  };

  checkOverflow();
  update();
  host.addEventListener('scroll', schedule, { passive: true });
  if (manager) {
    for (const el of observed) manager.observe(el, onResize);
  }
  return detach;
}

/** React 宿主接线：ref 指向滚动容器；active=false 时不挂载（如折叠段）。 */
export function useScrollFade<T extends HTMLElement>(
  hostRef: RefObject<T | null>,
  active: boolean = true
): void {
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    return attachScrollFade(host);
  }, [hostRef, active]);
}

const boundFadeHosts = new WeakSet<HTMLElement>();

/**
 * innerHTML 渲染面（MarkdownSurface）的代码块批量绑定：
 * 对 root 内尚未绑定的 .md-code-pre 挂状态机。R5 增量补丁保留未变子树节点身份，
 * 已绑定节点跨帧复用；节点被替换后新节点在下一次同步时补绑，被弃节点随
 * attachScrollFade 的 isConnected 自检自行卸载。
 */
export function bindScrollFadesIn(root: ParentNode): void {
  const pres = root.querySelectorAll<HTMLElement>('.md-code-pre');
  pres.forEach((pre) => {
    if (boundFadeHosts.has(pre)) return;
    boundFadeHosts.add(pre);
    attachScrollFade(pre);
  });
}
