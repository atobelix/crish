import {
  EMPTY_SESSION_VISIT_STACK,
  SESSION_VISIT_STACK_LIMIT,
  normalizeSessionRoute,
  popSessionVisit,
  recordSessionVisit,
} from './sessionVisitStack';

describe('normalizeSessionRoute', () => {
  it('会话类路由原样保留（远端 /session 与本地 /thread、含 (main) 前缀）', () => {
    expect(normalizeSessionRoute('/session/s-1')).toBe('/session/s-1');
    expect(normalizeSessionRoute('/thread/lth-1')).toBe('/thread/lth-1');
    expect(normalizeSessionRoute('/(main)/session/s-1')).toBe(
      '/(main)/session/s-1'
    );
    expect(normalizeSessionRoute('/session/s-1/')).toBe('/session/s-1');
  });

  it('非会话路由返回 null', () => {
    expect(normalizeSessionRoute('/')).toBeNull();
    expect(normalizeSessionRoute('/settings')).toBeNull();
    expect(normalizeSessionRoute('')).toBeNull();
  });
});

describe('recordSessionVisit', () => {
  it('会话 A→会话 B：记录被替换者 A', () => {
    const next = recordSessionVisit(
      EMPTY_SESSION_VISIT_STACK,
      '/session/a',
      '/session/b'
    );
    expect(next).toEqual(['/session/a']);
  });

  it('题 9 核心链：A→B→C 依次记录，栈为 [A, B]（末尾最近）', () => {
    let stack = recordSessionVisit(
      EMPTY_SESSION_VISIT_STACK,
      '/session/a',
      '/session/b'
    );
    stack = recordSessionVisit(stack, '/session/b', '/thread/c');
    expect(stack).toEqual(['/session/a', '/session/b']);
  });

  it('从主页进入会话不记录（被离开者不是会话）', () => {
    expect(
      recordSessionVisit(EMPTY_SESSION_VISIT_STACK, '/', '/session/a')
    ).toEqual([]);
  });

  it('离开会话去非会话页也记录（最近会话语义）', () => {
    expect(
      recordSessionVisit(EMPTY_SESSION_VISIT_STACK, '/session/a', '/settings')
    ).toEqual(['/session/a']);
  });

  it('同路由自切换不记录', () => {
    expect(
      recordSessionVisit(EMPTY_SESSION_VISIT_STACK, '/session/a', '/session/a')
    ).toEqual([]);
  });

  it('重复访问同一会话走 MRU：旧位置摘除、压到栈顶、全栈不重复', () => {
    let stack = recordSessionVisit(
      EMPTY_SESSION_VISIT_STACK,
      '/session/a',
      '/session/b'
    );
    stack = recordSessionVisit(stack, '/session/b', '/session/a');
    stack = recordSessionVisit(stack, '/session/a', '/session/c');
    expect(stack).toEqual(['/session/b', '/session/a']);
  });

  it('超上限淘汰最旧，只保留最近 10 条', () => {
    let stack: readonly string[] = EMPTY_SESSION_VISIT_STACK;
    for (let i = 0; i < SESSION_VISIT_STACK_LIMIT + 3; i += 1) {
      stack = recordSessionVisit(
        stack,
        `/session/s-${i}`,
        `/session/s-${i + 1}`
      );
    }
    expect(stack).toHaveLength(SESSION_VISIT_STACK_LIMIT);
    expect(stack[0]).toBe('/session/s-3');
    expect(stack[stack.length - 1]).toBe('/session/s-12');
  });

  it('不修改入参（纯函数）', () => {
    const before: readonly string[] = ['/session/a'];
    const after = recordSessionVisit(before, '/session/b', '/session/c');
    expect(before).toEqual(['/session/a']);
    expect(after).toEqual(['/session/a', '/session/b']);
  });
});

describe('popSessionVisit', () => {
  it('题 9 核心场景：在 B 返回先回 A，栈耗尽后 href = null', () => {
    const stack: readonly string[] = ['/session/a'];
    const first = popSessionVisit(stack, '/session/b');
    expect(first.href).toBe('/session/a');
    expect(first.nextStack).toEqual([]);
    const second = popSessionVisit(first.nextStack, '/session/a');
    expect(second.href).toBeNull();
  });

  it('逆序逐个回退：[A, B] 在 C 返回先 B 后 A', () => {
    const stack: readonly string[] = ['/session/a', '/session/b'];
    const toB = popSessionVisit(stack, '/thread/c');
    expect(toB.href).toBe('/session/b');
    const toA = popSessionVisit(toB.nextStack, '/session/b');
    expect(toA.href).toBe('/session/a');
  });

  it('空栈返回 null 且栈不变', () => {
    const result = popSessionVisit(EMPTY_SESSION_VISIT_STACK, '/session/a');
    expect(result.href).toBeNull();
    expect(result.nextStack).toEqual([]);
  });

  it('防御：栈顶恰为当前路由时跳过它取下一条', () => {
    const stack: readonly string[] = ['/session/a', '/session/b'];
    const result = popSessionVisit(stack, '/session/b');
    expect(result.href).toBe('/session/a');
    expect(result.nextStack).toEqual([]);
  });

  it('当前不在会话页（兜底误调）也能弹出最近会话', () => {
    const result = popSessionVisit(['/session/a'], '/');
    expect(result.href).toBe('/session/a');
  });
});
