import { describe, expect, it, vi } from 'vitest';
import {
  isFirstNonEmptyAssistantReply,
  maybeRequestAiSessionTitle,
  sanitizeAiSessionTitle,
  type AiSessionTitleDeps,
  type AiTitleSession,
} from './sessionAiTitle';

const SCOPE = 'ai-session-title';

function session(
  titleSource: AiTitleSession['titleSource'],
  messages: AiTitleSession['messages']
): AiTitleSession {
  return { titleSource, messages };
}

function firstReplySession(
  titleSource: AiTitleSession['titleSource'] = 'auto-trivial'
): AiTitleSession {
  return session(titleSource, [
    { id: 'u1', sender: 'user', text: '帮我看登录失败' },
    { id: 'a0', sender: 'assistant', text: '   ' },
    { id: 'a1', sender: 'assistant', text: '先看服务日志里的报错。' },
  ]);
}

function depsFor(
  current: AiTitleSession | undefined,
  patch: Partial<AiSessionTitleDeps> = {}
): AiSessionTitleDeps {
  const attempted = new Set<string>();
  return {
    getSession: () => current,
    getAiTitleEnabled: async () => true,
    invokeGenerate: async () => ({ status: 'ok', title: '「登录失败排查」' }),
    applyTitle: vi.fn(),
    logError: vi.fn(),
    attempted,
    ...patch,
  };
}

describe('sanitizeAiSessionTitle', () => {
  it('strips quotes, punctuation, and newlines, then keeps 12 code points', () => {
    expect(sanitizeAiSessionTitle('"登录问题"')).toBe('登录问题');
    expect(sanitizeAiSessionTitle('「你好，世界！」')).toBe('你好世界');
    expect(sanitizeAiSessionTitle('第一行\n第二行')).toBe('第一行第二行');
    expect(sanitizeAiSessionTitle('  ‘一二三四五六七八九十甲乙丙’  ')).toBe(
      '一二三四五六七八九十甲乙'
    );
    expect(sanitizeAiSessionTitle('！！！')).toBe('');
    expect(sanitizeAiSessionTitle(' \n\t ')).toBe('');
  });
});

describe('maybeRequestAiSessionTitle', () => {
  it('does not overwrite a user title and does not call the model', async () => {
    const invokeGenerate = vi.fn();
    const applyTitle = vi.fn();
    const deps = depsFor(firstReplySession('user'), { invokeGenerate, applyTitle });

    await maybeRequestAiSessionTitle('s1', 'a1', deps);

    expect(invokeGenerate).not.toHaveBeenCalled();
    expect(applyTitle).not.toHaveBeenCalled();
    expect(deps.attempted.size).toBe(0);
  });

  it('drops the result when the user renames before it arrives', async () => {
    let current = firstReplySession('auto');
    const applyTitle = vi.fn();
    const deps = depsFor(current, {
      getSession: () => current,
      invokeGenerate: async () => {
        current = { ...current, titleSource: 'user' };
        return { status: 'ok', title: '登录失败排查' };
      },
      applyTitle,
    });

    await maybeRequestAiSessionTitle('s1', 'a1', deps);

    expect(applyTitle).not.toHaveBeenCalled();
  });

  it('keeps the existing title when generation fails', async () => {
    const applyTitle = vi.fn();
    const logError = vi.fn();
    const deps = depsFor(firstReplySession(), {
      invokeGenerate: async () => ({ status: 'error', message: 'offline' }),
      applyTitle,
      logError,
    });

    await maybeRequestAiSessionTitle('s1', 'a1', deps);

    expect(applyTitle).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(SCOPE, {
      sessionId: 's1',
      err: 'offline',
    });
    expect(deps.attempted.has('s1')).toBe(true);
  });

  it('keeps the existing title when the model returns only punctuation', async () => {
    const applyTitle = vi.fn();
    const logError = vi.fn();
    const deps = depsFor(firstReplySession(), {
      invokeGenerate: async () => ({ status: 'ok', title: '「！！」' }),
      applyTitle,
      logError,
    });

    await maybeRequestAiSessionTitle('s1', 'a1', deps);

    expect(applyTitle).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(SCOPE, {
      sessionId: 's1',
      err: 'empty title after sanitize',
    });
  });

  it('does not call the model when the preference is off', async () => {
    const invokeGenerate = vi.fn();
    const deps = depsFor(firstReplySession(), {
      getAiTitleEnabled: async () => false,
      invokeGenerate,
    });

    await maybeRequestAiSessionTitle('s1', 'a1', deps);

    expect(invokeGenerate).not.toHaveBeenCalled();
    expect(deps.attempted.size).toBe(0);
  });

  it('requests only for the first non-empty assistant reply', async () => {
    const invokeGenerate = vi.fn(async () => ({
      status: 'ok' as const,
      title: '登录失败排查',
    }));
    const applyTitle = vi.fn();
    const messages = [
      { id: 'u1', sender: 'user', text: '帮我看登录失败' },
      { id: 'a0', sender: 'assistant', text: '' },
      { id: 'a1', sender: 'assistant', text: '先看日志' },
      { id: 'a2', sender: 'assistant', text: '第二轮补充' },
    ];
    const deps = depsFor(session('auto-trivial', messages), {
      invokeGenerate,
      applyTitle,
    });

    await maybeRequestAiSessionTitle('s1', 'a1', deps);
    await maybeRequestAiSessionTitle('s1', 'a2', deps);
    await maybeRequestAiSessionTitle('s1', 'a1', deps);

    expect(invokeGenerate).toHaveBeenCalledTimes(1);
    expect(invokeGenerate).toHaveBeenCalledWith({
      sessionId: 's1',
      userText: '帮我看登录失败',
      assistantText: '先看日志',
    });
    expect(applyTitle).toHaveBeenCalledTimes(1);
    expect(applyTitle).toHaveBeenCalledWith('s1', '登录失败排查');

    const laterOnly = depsFor(
      session('auto', [
        { id: 'u1', sender: 'user', text: '你好' },
        { id: 'a1', sender: 'assistant', text: '先看日志' },
        { id: 'a2', sender: 'assistant', text: '第二轮补充' },
      ]),
      { invokeGenerate: vi.fn() }
    );
    await maybeRequestAiSessionTitle('s2', 'a2', laterOnly);
    expect(laterOnly.invokeGenerate).not.toHaveBeenCalled();
    expect(laterOnly.attempted.size).toBe(0);
  });

  it('does not treat an earlier empty assistant message as the first reply', () => {
    const messages = [
      { id: 'a0', sender: 'assistant', text: '  ' },
      { id: 'a1', sender: 'assistant', text: '正文' },
    ];
    expect(isFirstNonEmptyAssistantReply(messages, 'a1')).toBe(true);
    expect(isFirstNonEmptyAssistantReply(messages, 'a0')).toBe(false);
  });
});
