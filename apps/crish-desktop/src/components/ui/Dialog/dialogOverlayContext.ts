/**
 * Dialog 遮罩壳层叠上下文：设置全屏等 modal 内的 Menu/Select
 * portal 进 overlay，用局部 z 压过面板，而不抬高全仓 --z-dropdown。
 */
import { createContext } from 'react';

export const DialogOverlayContext = createContext<HTMLElement | null>(null);
