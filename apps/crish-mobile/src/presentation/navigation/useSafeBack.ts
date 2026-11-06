// 安全返回与 Android 返回键双击防抖退出守卫（实现波方案 01）
// 统一返回入口 + Android 物理返回键全局智能守卫。
import { useCallback, useEffect, useRef } from 'react';
import { BackHandler, Platform, ToastAndroid } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { isAppAuthenticated } from '@/domain/pure/authSelectors';
import {
  evaluateBackPressExit,
  isRouteCurrentRoot,
  isSessionSubRoute,
  INITIAL_BACK_PRESS_EXIT_STATE,
  type BackPressExitState,
} from '@/domain/pure/backPressExit';
import {
  EMPTY_SESSION_VISIT_STACK,
  normalizeSessionRoute,
  popSessionVisit,
  recordSessionVisit,
  type SessionVisitStackState,
} from '@/domain/pure/sessionVisitStack';

/** 无返回栈时的兜底落点 */
export const SAFE_BACK_FALLBACK_HREF = '/' as const;
export const AUTH_BACK_FALLBACK_HREF = '/welcome' as const;

/**
 * 渲染期安全读取"栈内是否可回退"（2026-11-05 导航语义矩阵配套原语）：
 * expo-router 的 canGoBack 在导航容器未挂载（单测 / 极端脱水时序）时直接
 * 抛错——渲染期消费（如会话头栏返回钮的显隐）必须经本口零异常降级为
 * "无栈可回"；按下时机的消费仍走 useSafeBack（容器必然已挂载）。
 */
export function safeCanGoBack(): boolean {
  try {
    return router.canGoBack();
  } catch {
    return false;
  }
}

// ── 最近会话访问栈（题 9）────────────────────────────────────────
// (main) 单槽位壳里会话间切换是同名 screen 换 params，被替换的会话
// 不进任何路由历史（A→抽屉→B 后 B 的路由栈只剩 [主页, 会话]），
// 返回只能直落主页。纯逻辑在 domain/pure/sessionVisitStack，本层只
// 做状态持有（模块单例：useSafeBack 与 Android 守卫两个消费方必须
// 共享同一栈）与路由接线。
let sessionVisitStack: SessionVisitStackState = EMPTY_SESSION_VISIT_STACK;
/** 经访问栈返回的落点 href：该次落地是「回到最近会话」而非一次新访问 */
let visitBackLandingHref: string | null = null;

/**
 * 访问栈复位：测试隔离与账号生命周期（登出/换号，经
 * useSessionVisitStackAccountReset）共用此口。栈的生产写入只经
 * 记录器与返回消费两处。
 */
export function resetSessionVisitStack(): void {
  sessionVisitStack = EMPTY_SESSION_VISIT_STACK;
  visitBackLandingHref = null;
}

/**
 * 账号生命周期复位（收口裁定）：访问栈只存会话 href、不含账号维度——
 * 登出（含删号、会话失效等一切落到 loggedOut 的路径）或换号（user.id
 * 变化）时必须整栈清空，否则新账号在会话页按返回会导航到旧账号的
 * 会话 href（虽有缺失态承接，语义错误）。根布局与记录器同挂一处，
 * 一次覆盖全部账号终局路径，不逐个登出入口接线。
 */
export function useSessionVisitStackAccountReset(): void {
  const status = useAccountStore((s) => s.status);
  const userId = useAccountStore((s) => s.user?.id ?? null);
  const prevRef = useRef<{ status: string; userId: string | null } | null>(
    null
  );

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { status, userId };
    if (prev === null) return;
    const becameLoggedOut =
      status === 'loggedOut' && prev.status !== 'loggedOut';
    const switchedUser =
      prev.userId !== null && userId !== null && prev.userId !== userId;
    if (becameLoggedOut || switchedUser) {
      resetSessionVisitStack();
    }
  }, [status, userId]);
}

/**
 * 会话访问记录器（根布局挂载一次）：pathname 每次变化时，把被离开的
 * 会话路由压入访问栈（recordSessionVisit 的 MRU / 上限语义）。经访
 * 问栈返回的落地跳过记录——否则 B→返回→A 会把 B 再压栈，来回弹跳
 * 永不达底。落点与置位预期不符（导航被打断等）时照常记录，不吞访问。
 */
export function useSessionVisitRecorder(): void {
  const pathname = usePathname() ?? '';
  const prevPathnameRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevPathnameRef.current;
    prevPathnameRef.current = pathname;
    if (prev === null || prev === pathname) return;
    if (visitBackLandingHref !== null) {
      const landing = visitBackLandingHref;
      visitBackLandingHref = null;
      if (normalizeSessionRoute(pathname) === landing) return;
    }
    sessionVisitStack = recordSessionVisit(sessionVisitStack, prev, pathname);
  }, [pathname]);
}

/**
 * 尝试以访问栈处理一次返回（调用方已判定当前在会话页）：命中则弹栈
 * 并导航去最近会话、返回 true；栈耗尽返回 false，调用方走既有兜底。
 */
function trySessionVisitBack(currentPathname: string): boolean {
  const { href, nextStack } = popSessionVisit(
    sessionVisitStack,
    currentPathname
  );
  if (href === null) return false;
  sessionVisitStack = nextStack;
  visitBackLandingHref = href;
  router.navigate(href as '/session/[sessionId]' | '/thread/[threadId]');
  return true;
}

/**
 * 安全返回 Hook（UI 按钮消费点）：
 * - 会话页且有会话访问记录：先回最近访问的会话（题 9）
 * - 有返回栈：正常 router.back()
 * - 无返回栈：根据登录态安全 replace 回根页面，杜绝静默失效
 */
export function useSafeBack(): () => void {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  const authenticated = isAppAuthenticated(pairState, accountStatus);
  const pathname = usePathname() ?? '';

  return useCallback(() => {
    if (isSessionSubRoute(pathname) && trySessionVisitBack(pathname)) {
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(
      authenticated ? SAFE_BACK_FALLBACK_HREF : AUTH_BACK_FALLBACK_HREF
    );
  }, [authenticated, pathname]);
}

/**
 * Android 物理返回键全局智能守卫（在根布局 _layout.tsx 挂载一次）：
 * 1. 根页面（未登录 /welcome 与已登录 /）：2000ms 双击退出到系统桌面（moveTaskToBack）；
 * 2. 会话单页（/session/*, /thread/*）：先回最近会话访问栈（题 9）；栈空
 *    且路由栈底为空时，安全 replace 回主对话界面；
 * 3. 普通子页面（/settings, /account/* 等）：正常 pop 回上一级；
 * 4. 严禁已登录状态退回任何 (auth) 栈。
 */
export function useAndroidBackGuard(): void {
  const pathname = usePathname();
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  const authenticated = isAppAuthenticated(pairState, accountStatus);

  const exitStateRef = useRef<BackPressExitState>(
    INITIAL_BACK_PRESS_EXIT_STATE
  );

  // 路由变化时重置退出计时状态，避免跨页面误触退出
  useEffect(() => {
    exitStateRef.current = INITIAL_BACK_PRESS_EXIT_STATE;
  }, [pathname]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        const currentPath = pathname ?? '';
        const isRoot = isRouteCurrentRoot(currentPath, authenticated);

        // 场景 A：当前处于根页面（未登录 /welcome 或已登录 /）
        if (isRoot) {
          const decision = evaluateBackPressExit(
            exitStateRef.current,
            Date.now()
          );
          exitStateRef.current = decision.nextState;

          if (decision.action === 'toast') {
            // 原生 Android Toast 具有最高可见度且不依赖复杂 UI 挂载
            ToastAndroid.show(decision.message, ToastAndroid.SHORT);
            return true; // 拦截事件，等待下一次点击
          }

          if (decision.action === 'exit') {
            // 连击生效：返回 false 放行给原生 MainActivity.invokeDefaultOnBackPressed
            // 该原生方法会调用 moveTaskToBack(false)，退至系统桌面且保留后台进程
            return false;
          }
        }

        // 场景 B0（题 9）：当前处于会话页且有会话访问记录 → 先回最近会话
        if (
          authenticated &&
          isSessionSubRoute(currentPath) &&
          trySessionVisitBack(currentPath)
        ) {
          return true; // 消费事件
        }

        // 场景 B：当前处于会话页，且不可常规回退（因为进入时使用了 replace）
        if (
          authenticated &&
          isSessionSubRoute(currentPath) &&
          !router.canGoBack()
        ) {
          router.replace('/');
          return true; // 消费事件
        }

        // 场景 C：其他子页面且原生栈可正常回退
        if (router.canGoBack()) {
          // 放行给 React Navigation 正常退栈
          return false;
        }

        // 场景 D：冷启动深链单屏或异常脱水栈兜底
        router.replace(authenticated ? '/' : '/welcome');
        return true;
      }
    );

    return () => subscription.remove();
  }, [pathname, authenticated]);
}

export default useSafeBack;
