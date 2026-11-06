/**
* apps/crish-desktop/src/components/chat-composer/useComposerCardHeightGlide.ts
*
* S9 高度族 H-01/H-03：输入卡实际高度同钟滑翔。
*
* 编辑器逐行生长 / 发送后回落时，卡片只有 min-height 与圆角有
* 过渡，内容驱动的实际高度（field-sizing: content / ProseMirror 自然高）
* 无过渡——卡片外框逐行阶梯跳变，上方消息列被一格一格顶动。
*
* 以 ResizeObserver 监听卡片子元素（主输入网格 / 附件条 / 内嵌
* 顶槽）的尺寸变化，测得卡片自然高（scrollHeight + 边框）后，用 WAAPI
* 把卡片显式 height 从「当前动画值」滑翔到目标高：
* - 时长走高度族单一时长源 calcAccordionDuration（按高度差推导）；
* - 曲线用 --ease-decelerate 对应的 EASE_DECELERATE token；
* - 动画中途目标再变（连续打字逐行生长）时，从当前动画值重靶向，
* 不跳回起点、不排队——文本回显本身零延迟，只有卡片外框在滑翔
* （H 册反例 3：高度动画绝不许拖住输入回显，本方案不触碰编辑器
* 本体高度与内容布局，编辑器自然高即时生效，仅外框追赶）。
* - 减动效（系统 prefers-reduced-motion 或应用 [data-reduced-motion]）
* 时直接落位，不播动画。
*
* 高度只写卡片自身的 height 一个属性；卡内布局（网格 / 顶槽 / 附件条）
* 全部保持自然流，动画期间内容不裁剪、不重排。
*/

import { useEffect, useRef} from 'react';
import { ResizeObserverManager} from '../../utils/ResizeObserverManager';
import {
calcAccordionDuration,
EASE_DECELERATE,
} from '../../utils/motionTokens';

function prefersReducedMotion(): boolean {
if (typeof window === 'undefined') return false;
try {
if (
typeof window.matchMedia === 'function' &&
window.matchMedia('(prefers-reduced-motion: reduce)').matches
) {
return true;
}
} catch {
/* matchMedia 不可用时按非减动效处理 */
}
return Boolean(
typeof document!== 'undefined' &&
document.documentElement?.hasAttribute('data-reduced-motion')
);
}

/**
* 卡片高度滑翔引擎（框架无关，便于单测）。
* sync() 由外部在内容尺寸变化时调用；首次 sync 直接落位（挂载不播动画）。
*/
export class ComposerCardHeightGlide {
private readonly el: HTMLElement;
private anim: Animation | null = null;
private settledHeight: number | null = null;
private disposed = false;

constructor(el: HTMLElement) {
this.el = el;
}

/** 卡片自然高（内容 + 内边距 + 边框），测不到时返回 null */
measureNaturalHeight(): number | null {
const el = this.el;
if (!el || typeof window === 'undefined') return null;
const cs = window.getComputedStyle(el);
const borderY =
(Number.parseFloat(cs.borderTopWidth) || 0) +
(Number.parseFloat(cs.borderBottomWidth) || 0);
const natural = el.scrollHeight + borderY;
if (!Number.isFinite(natural) || natural <= 0) return null;
const minH = Number.parseFloat(cs.minHeight) || 0;
return Math.max(natural, minH);
}

/** 当前呈现高度：动画中取动画实时值，否则取上次落定值 / 实测盒高 */
private currentHeight(target: number): number {
if (this.anim) {
const live = Number.parseFloat(
window.getComputedStyle(this.el).height
);
if (Number.isFinite(live) && live > 0) return live;
}
if (this.settledHeight!== null) return this.settledHeight;
const box = this.el.getBoundingClientRect().height;
return box > 0? box: target;
}

private cancelAnim(): void {
if (this.anim) {
this.anim.cancel();
this.anim = null;
}
}

/** 把卡片高度同步到当前自然高；target 变化时滑翔过去 */
sync(): void {
if (this.disposed) return;
const el = this.el;
const target = this.measureNaturalHeight();
if (target === null) return;

// 首次接管：直接落位，挂载不播动画
if (this.settledHeight === null) {
el.style.height = `${target}px`;
this.settledHeight = target;
return;
}

const from = this.currentHeight(target);
const delta = target - from;
if (Math.abs(delta) < 0.5) {
this.cancelAnim();
el.style.height = `${target}px`;
this.settledHeight = target;
return;
}

if (prefersReducedMotion() || typeof el.animate!== 'function') {
this.cancelAnim();
el.style.height = `${target}px`;
this.settledHeight = target;
return;
}

const duration = calcAccordionDuration(Math.abs(delta), delta > 0);
this.cancelAnim();
const anim = el.animate(
[{ height: `${from}px`}, { height: `${target}px`}],
{ duration, easing: EASE_DECELERATE, fill: 'forwards'}
);
this.anim = anim;
this.settledHeight = target;
anim.onfinish = () => {
if (this.anim!== anim) return; // 已被更新的动画接替
this.anim = null;
el.style.height = `${target}px`;
};
}

dispose(): void {
this.disposed = true;
this.cancelAnim();
this.el.style.height = '';
this.settledHeight = null;
}
}

/**
* React 绑定：监听卡片全部子元素的尺寸变化（主输入网格随编辑器逐行
* 生长而变高、模式切换而重构；附件条 / 顶槽挂卸走 MutationObserver
* 重绑），任一变化即让引擎向新自然高滑翔。
*/
export function useComposerCardHeightGlide(
cardRef: React.RefObject<HTMLElement | null>
): void {
const glideRef = useRef<ComposerCardHeightGlide | null>(null);

useEffect(() => {
const el = cardRef.current;
if (!el) return undefined;

const glide = new ComposerCardHeightGlide(el);
glideRef.current = glide;
glide.sync();

const roManager = ResizeObserverManager.getInstance();
const observed = new Set<Element>();
const onResize = () => glide.sync();
const observeChildren = () => {
for (const child of Array.from(el.children)) {
if (!observed.has(child)) {
observed.add(child);
roManager.observe(child, onResize);
}
}
};
observeChildren();

let mo: MutationObserver | null = null;
if (typeof MutationObserver!== 'undefined') {
mo = new MutationObserver(() => {
observeChildren();
glide.sync();
});
mo.observe(el, { childList: true});
}

return () => {
mo?.disconnect();
for (const child of observed) {
roManager.unobserve(child, onResize);
}
observed.clear();
glide.dispose();
if (glideRef.current === glide) glideRef.current = null;
};
}, [cardRef]);
}
