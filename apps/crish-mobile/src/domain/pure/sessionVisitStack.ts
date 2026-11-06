// 最近会话访问栈纯逻辑（题 9 / 波 3 裁决 3）：返回兜底层的一层有界
// 历史状态——(main) 单槽位壳里会话间切换是同名 screen 换 params，被
// 替换的会话不进任何路由历史，A→抽屉→B→返回只能直落主页。本栈在
// 兜底层记录「被替换的会话」，返回时先回最近会话、耗尽才回主页。
// 零 React 依赖、零 Native 依赖，与 backPressExit 同层，纯 Jest 直测。
import { isSessionSubRoute } from './backPressExit';

/** 访问栈上限：只保留最近 10 个被替换的会话，超出淘汰最旧 */
export const SESSION_VISIT_STACK_LIMIT = 10;

/** 访问栈状态：会话路由 href 序列，末尾为最近（栈顶），全栈不重复 */
export type SessionVisitStackState = readonly string[];

export const EMPTY_SESSION_VISIT_STACK: SessionVisitStackState = [];

/**
 * 归一化一条路径为会话路由 href：仅会话类路由（/session/*、/thread/*，
 * 含 (main) 组前缀形态）入栈，其余返回 null。尾部多余斜杠去除。
 */
export function normalizeSessionRoute(pathname: string): string | null {
  const normalized = pathname.trim().replace(/\/+$/, '');
  if (normalized === '' || !isSessionSubRoute(normalized)) return null;
  return normalized;
}

/**
 * 记录一次离开会话的切换：从 prevPathname 离开、进入 nextPathname 时，
 * 若被离开者是会话路由且与落点不同，把它压栈（会话间切换时记录被
 * 替换者；离开会话去非会话页同样记录——栈的语义是「最近访问过的
 * 会话」，与落点类型无关）。已在栈中的同一会话先摘除再压入（MRU
 * 序、全栈不重复），超限淘汰最旧。落点与被离开者相同（同屏参数
 * 微调不产生 pathname 变化时调用方不会触发；此处再兜一层）不记录。
 * 返回导航的落地不经本函数（接线层以抑制标记跳过，见 useSafeBack）。
 */
export function recordSessionVisit(
  stack: SessionVisitStackState,
  prevPathname: string,
  nextPathname: string
): SessionVisitStackState {
  const prev = normalizeSessionRoute(prevPathname);
  if (prev === null) return stack;
  const next = normalizeSessionRoute(nextPathname);
  if (prev === next) return stack;
  const rest = stack.filter((href) => href !== prev);
  const appended = [...rest, prev];
  return appended.length > SESSION_VISIT_STACK_LIMIT
    ? appended.slice(appended.length - SESSION_VISIT_STACK_LIMIT)
    : appended;
}

/**
 * 返回消费：给出当前路由，弹出「最近访问且不是当前页」的会话 href。
 * 防御性跳过栈顶与当前路由相同的残留项（正常记录规则下不会出现：
 * 压栈的永远是被离开者，与当时落点不同）。栈耗尽返回 href = null，
 * 调用方走既有兜底（回主页 / 双击退出链）。
 */
export function popSessionVisit(
  stack: SessionVisitStackState,
  currentPathname: string
): { href: string | null; nextStack: SessionVisitStackState } {
  const current = normalizeSessionRoute(currentPathname);
  let rest = stack;
  while (rest.length > 0 && rest[rest.length - 1] === current) {
    rest = rest.slice(0, -1);
  }
  if (rest.length === 0) return { href: null, nextStack: rest };
  return {
    href: rest[rest.length - 1]!,
    nextStack: rest.slice(0, -1),
  };
}
