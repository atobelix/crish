/**
 * useRevealEntrance（AN4）：兼容垫片。
 *
 * 实现已收敛至统一入场通道 components/motion/useEntranceReveal
 * （判定核心仍为本目录 toolRevealState，语义逐项不变：呈现记忆、
 * 实况时间窗、批次交错、保底定时器口径）。本文件只保留 AN4 既有
 * 消费方（CompactToolRow / FoldableToolGroup / SubagentDispatchCard）
 * 的导入路径与类型名，禁止在此再写任何入场逻辑——新表面一律直接
 * 用 useEntranceReveal / EntranceReveal。
 */
export { useEntranceReveal as useRevealEntrance } from '../motion/useEntranceReveal';
export type {
  EntranceRevealInput as RevealEntranceInput,
  EntranceRevealResult as RevealEntranceResult,
} from '../motion/useEntranceReveal';
