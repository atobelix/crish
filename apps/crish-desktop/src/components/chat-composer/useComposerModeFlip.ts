/**
* apps/crish-desktop/src/components/chat-composer/useComposerModeFlip.ts
*
* S9 高度族 H-02：单行 ↔ 多行模式切换的平移补偿（FLIP）。
*
* 模式判定（useComposerMultiline，施密特迟滞 + 振荡熔断）翻转时，
*.inputMainLayout 的 grid-template-areas/columns 整排重构：左侧控制组与
* 右侧动作组从输入框两侧瞬移到第二行（反之亦然），布局重排本身零过渡，
* 两组控件肉眼可见地「瞬移」。判定侧口径不动，本 hook 只补呈现侧。
*
* FLIP（First-Last-Invert-Play）：
* - 每帧布局提交后记录两组控件的落定位置（动画进行中的组跳过记录）；
* - isMultiline 翻转的同一提交内，先读旧位置、再读新布局位置，
* 以 transform 把两组瞬时逆位移到旧位置，随后以高度族时长
* （calcAccordionDuration 按位移距离推导）+ EASE_DECELERATE 曲线
* 过渡回 identity——控件是「滑」到新行的，不是跳过去的；
* - 动画中途再次翻转（连删/连输跨门限）时，从元素当前视觉位置
* （含 transform 的包围盒）重新逆位移，不跳回起点重播；
* - 字段槽（文本区）宽度随模式整行重排，属布局重排而非平移，
* 不做 transform 补偿（其高度变化由卡片高度滑翔同批覆盖）。
* - 减动效时不补偿，直接落位。
*/

import { useEffect, useLayoutEffect, useRef} from 'react';
import {
calcAccordionDuration,
EASE_DECELERATE,
} from '../../utils/motionTokens';

export interface FlipPoint {
left: number;
top: number;
}

/** FLIP 位移：从旧位置逆位移到新布局位置所需的 translate 量 */
export function computeFlipDelta(
prev: FlipPoint,
next: FlipPoint
): { dx: number; dy: number} {
return { dx: prev.left - next.left, dy: prev.top - next.top};
}

const FLIP_GRID_KEYS = ['left', 'right'] as const;

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

function queryGridPart(
layout: HTMLElement,
key: (typeof FLIP_GRID_KEYS)[number]
): HTMLElement | null {
return layout.querySelector<HTMLElement>(`[data-composer-grid="${key}"]`);
}

function rectPoint(el: HTMLElement): FlipPoint {
const r = el.getBoundingClientRect();
return { left: r.left, top: r.top};
}

export function useComposerModeFlip(
layoutRef: React.RefObject<HTMLElement | null>,
isMultiline: boolean
): void {
const prevModeRef = useRef<boolean | null>(null);
const lastRectsRef = useRef(new Map<string, FlipPoint>());
const flippingRef = useRef(new Set<string>());
const timersRef = useRef(new Map<string, number>());

// 翻转处理（须先于下方的位置记录 effect 声明：同一提交内先消费旧位置，
// 再由记录 effect 跳过动画中的组）
useLayoutEffect(() => {
const layout = layoutRef.current;
if (!layout) return;
if (prevModeRef.current === null) {
prevModeRef.current = isMultiline;
return;
}
if (prevModeRef.current === isMultiline) return;
prevModeRef.current = isMultiline;
if (prefersReducedMotion()) return;

for (const key of FLIP_GRID_KEYS) {
const el = queryGridPart(layout, key);
if (!el) continue;

let prevVisual: FlipPoint;
const pendingTimer = timersRef.current.get(key);
if (flippingRef.current.has(key)) {
// 中途反向：先取当前视觉位置（含 transform），再清 transform
// 读纯布局位置，逆位移量 = 视觉位置 - 布局位置，不跳回起点
if (pendingTimer!== undefined) {
window.clearTimeout(pendingTimer);
timersRef.current.delete(key);
}
prevVisual = rectPoint(el);
el.style.transition = '';
el.style.transform = '';
void el.offsetWidth;
flippingRef.current.delete(key);
} else {
prevVisual = lastRectsRef.current.get(key)?? rectPoint(el);
}

const layoutPoint = rectPoint(el);
const { dx, dy} = computeFlipDelta(prevVisual, layoutPoint);
if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
lastRectsRef.current.set(key, layoutPoint);
continue;
}

const distance = Math.round(Math.hypot(dx, dy));
const duration = calcAccordionDuration(distance, true);
flippingRef.current.add(key);
el.style.transition = 'none';
el.style.transform = `translate(${dx}px, ${dy}px)`;
void el.offsetWidth; // 强制回流，确保逆位移先落定再启过渡
el.style.transition = `transform ${duration}ms ${EASE_DECELERATE}`;
el.style.transform = '';

const timer = window.setTimeout(() => {
timersRef.current.delete(key);
flippingRef.current.delete(key);
el.style.transition = '';
el.style.transform = '';
lastRectsRef.current.set(key, rectPoint(el));
}, duration + 40);
timersRef.current.set(key, timer);
}
}, [isMultiline, layoutRef]);

// 落定位置记录：每次布局提交后更新（动画中的组跳过，避免把
// transform 后的视觉位置误记为布局位置）
useLayoutEffect(() => {
const layout = layoutRef.current;
if (!layout) return;
for (const key of FLIP_GRID_KEYS) {
if (flippingRef.current.has(key)) continue;
const el = queryGridPart(layout, key);
if (el) lastRectsRef.current.set(key, rectPoint(el));
}
});

// 卸载清理
useEffect(() => {
const timers = timersRef.current;
return () => {
for (const timer of timers.values()) window.clearTimeout(timer);
timers.clear();
};
}, []);
}
