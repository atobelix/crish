/**
 * apps/crish-desktop/src/api/session-persistence/sessionHydrationTokens.ts
 *
 * 单调递增 Generation Token 与懒会话壳判定
 */

import type { SessionState } from '../../store/types';

/**
 * 判断是否为未水合的远程懒壳（未访问、未水合、无消息）。
 * 仅对此类真实未水合懒壳跳过 save_session_body，避免覆盖底层历史。
 */
export function isLazySessionShell(
  session: Pick<
    SessionState,
    'id' | 'messages' | 'messagesHydrated' | 'hydratedFromEngine'
  >,
  activeSessionId?: string | null
): boolean {
  if (session.messages && session.messages.length > 0) return false;
  if (session.messagesHydrated === false) return true;
  if (session.messagesHydrated === true) return false;
  if (session.hydratedFromEngine === true) return false;
  if (activeSessionId && session.id === activeSessionId) return false;
  return true;
}

/**
 * 单调递增 Generation Token（AAI-03 / ACT-502）：会话切换 / 懒水合竞态防线。
 * 每次显式切换自增；过期异步响应对比 token 不一致即丢弃，严禁写主视口。
 */
let activeSwitchGeneration = 0;

/** 领取新一代切换 token（单调递增） */
export function bumpHydrateGeneration(): number {
  activeSwitchGeneration += 1;
  return activeSwitchGeneration;
}

/** 当前最新 token（测试钩子 / 调用方对账用） */
export function currentHydrateGeneration(): number {
  return activeSwitchGeneration;
}

/** token 是否仍是最新（true=可提交；false=过期响应必须丢弃） */
export function isHydrateGenerationCurrent(gen: number): boolean {
  return gen === activeSwitchGeneration;
}
