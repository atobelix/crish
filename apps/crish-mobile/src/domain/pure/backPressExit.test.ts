import {
  evaluateBackPressExit,
  isRouteCurrentRoot,
  isSessionSubRoute,
  DOUBLE_BACK_EXIT_INTERVAL_MS,
} from './backPressExit';

describe('evaluateBackPressExit', () => {
  it('初次触发应提示 Toast 并记录当前时间戳', () => {
    const now = 10000;
    const result = evaluateBackPressExit({ lastPressTimeMs: null }, now);

    expect(result.action).toBe('toast');
    if (result.action === 'toast') {
      expect(result.message).toBe('再按一次退出应用');
    }
    expect(result.nextState.lastPressTimeMs).toBe(now);
  });

  it('2000ms 内再次触发应判定为退出，并重置时间戳', () => {
    const t1 = 10000;
    const t2 = t1 + 1200; // 1.2 秒后连击
    const first = evaluateBackPressExit({ lastPressTimeMs: null }, t1);
    const second = evaluateBackPressExit(first.nextState, t2);

    expect(second.action).toBe('exit');
    expect(second.nextState.lastPressTimeMs).toBeNull();
  });

  it('恰好 2000ms 触发应判定为退出', () => {
    const t1 = 10000;
    const t2 = t1 + DOUBLE_BACK_EXIT_INTERVAL_MS;
    const first = evaluateBackPressExit({ lastPressTimeMs: null }, t1);
    const second = evaluateBackPressExit(first.nextState, t2);

    expect(second.action).toBe('exit');
    expect(second.nextState.lastPressTimeMs).toBeNull();
  });

  it('超过 2000ms 后再次触发应重新提示 Toast，不退出', () => {
    const t1 = 10000;
    const t2 = t1 + 2500; // 2.5 秒后点击（已超时）
    const first = evaluateBackPressExit({ lastPressTimeMs: null }, t1);
    const second = evaluateBackPressExit(first.nextState, t2);

    expect(second.action).toBe('toast');
    expect(second.nextState.lastPressTimeMs).toBe(t2);
  });

  it('时钟回退等极端异常时稳健提示 Toast', () => {
    const t1 = 10000;
    const t2 = 9000; // 时钟回拨
    const first = evaluateBackPressExit({ lastPressTimeMs: null }, t1);
    const second = evaluateBackPressExit(first.nextState, t2);

    expect(second.action).toBe('toast');
    expect(second.nextState.lastPressTimeMs).toBe(t2);
  });
});

describe('isRouteCurrentRoot', () => {
  it('已登录态下，仅 "/" 判定为根路由', () => {
    expect(isRouteCurrentRoot('/', true)).toBe(true);
    expect(isRouteCurrentRoot('', true)).toBe(true);
    expect(isRouteCurrentRoot('/(main)', true)).toBe(true);
    expect(isRouteCurrentRoot('/(main)/index', true)).toBe(true);
    expect(isRouteCurrentRoot('/welcome', true)).toBe(false);
    expect(isRouteCurrentRoot('/settings', true)).toBe(false);
    expect(isRouteCurrentRoot('/session/s1', true)).toBe(false);
  });

  it('未登录态下，仅 "/welcome" 判定为根路由', () => {
    expect(isRouteCurrentRoot('/welcome', false)).toBe(true);
    expect(isRouteCurrentRoot('/welcome/', false)).toBe(true);
    expect(isRouteCurrentRoot('/', false)).toBe(false);
    expect(isRouteCurrentRoot('/account/login', false)).toBe(false);
  });
});

describe('isSessionSubRoute', () => {
  it('精准识别远端会话与本地线程路由', () => {
    expect(isSessionSubRoute('/session/123')).toBe(true);
    expect(isSessionSubRoute('/thread/local-1')).toBe(true);
    expect(isSessionSubRoute('/(main)/session/123')).toBe(true);
    expect(isSessionSubRoute('/(main)/thread/local-1')).toBe(true);
    expect(isSessionSubRoute('/settings')).toBe(false);
    expect(isSessionSubRoute('/')).toBe(false);
  });
});
