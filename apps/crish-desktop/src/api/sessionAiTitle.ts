/**
 * 首条助手回复完成后，异步向模型要一个不超过 12 字的会话标题。
 *
 * 不阻塞界面，每个会话最多请求一次（进程内 Set，不落盘）。
 * 偏好 aiSessionTitle 关闭时不请求，也不占用这一次。
 * 结果回来时若会话已不在或 titleSource 为 user，丢弃结果。
 * 失败、离线、超时、空标题都保留 6b 的现有标题，并经 logInternalError 留下记录。
 */
import { getCompositionRoot } from '../app/compositionRoot';
import { getPreference } from './preferences/preferencesClient';
import { effectiveTitleSource } from './sessionTitleSource';
import { invokeTyped } from './tauriInvoke';
import { logInternalError } from './userFacingErrors';
import { getSessionById } from '../store';

export const AI_SESSION_TITLE_MAX_CHARS = 12;
const AI_SESSION_TITLE_INPUT_CAP = 400;
const AI_SESSION_TITLE_SCOPE = 'ai-session-title';

const attemptedSessionIds = new Set<string>();

type TitleMessage = {
  id?: string;
  sender?: string;
  text?: string | null;
};

export type AiTitleSession = {
  titleSource?: 'auto-trivial' | 'auto' | 'user' | null;
  messages?: readonly TitleMessage[] | null;
};

export type AiSessionTitleInvokeResult =
  { status: 'ok'; title: string } | { status: 'error'; message: string };

export interface AiSessionTitleDeps {
  getSession: (sessionId: string) => AiTitleSession | undefined;
  getAiTitleEnabled: () => Promise<boolean>;
  invokeGenerate: (args: {
    sessionId: string;
    userText: string;
    assistantText: string;
  }) => Promise<AiSessionTitleInvokeResult>;
  applyTitle: (sessionId: string, title: string) => void;
  logError: (scope: string, input: unknown) => void;
  attempted: Set<string>;
}

/** 去掉引号、标点和换行，再留下最多 12 个 Unicode 码点。 */
export function sanitizeAiSessionTitle(raw: string | null | undefined): string {
  const stripped = String(raw ?? '')
    .replace(/[\r\n\u2028\u2029]/g, '')
    .replace(/\p{P}/gu, '')
    .trim();
  return Array.from(stripped).slice(0, AI_SESSION_TITLE_MAX_CHARS).join('');
}

function capCodePoints(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

function visibleText(message: TitleMessage | undefined): string {
  return (message?.text ?? '').trim();
}

function firstNonEmptyUserText(
  messages: readonly TitleMessage[] | null | undefined
): string {
  if (!messages) return '';
  for (const message of messages) {
    if (message?.sender !== 'user') continue;
    const text = visibleText(message);
    if (text) return text;
  }
  return '';
}

/** 这条助手消息是会话里第一条有正文的助手回复。更早的空助手消息不算。 */
export function isFirstNonEmptyAssistantReply(
  messages: readonly TitleMessage[] | null | undefined,
  assistantMsgId: string
): boolean {
  if (!messages || !assistantMsgId) return false;
  for (const message of messages) {
    if (message?.sender !== 'assistant') continue;
    if (!visibleText(message)) continue;
    return message.id === assistantMsgId;
  }
  return false;
}

function defaultDeps(): AiSessionTitleDeps {
  return {
    getSession: (sessionId) => getSessionById(sessionId),
    getAiTitleEnabled: async () =>
      (await getPreference('aiSessionTitle')) === true,
    invokeGenerate: async (args) => {
      const res = await invokeTyped<{ title?: unknown }>(
        'core_generate_session_title',
        {
          sessionId: args.sessionId,
          userText: args.userText,
          assistantText: args.assistantText,
        }
      );
      if (res.status === 'ok') {
        return {
          status: 'ok',
          title: typeof res.data?.title === 'string' ? res.data.title : '',
        };
      }
      if (res.status === 'missing') {
        return {
          status: 'error',
          message: 'core_generate_session_title missing',
        };
      }
      return {
        status: 'error',
        message: res.message || res.kind || 'title request failed',
      };
    },
    applyTitle: (sessionId, title) => {
      getCompositionRoot()
        .session.getState()
        .applyGeneratedSessionTitle(sessionId, title);
    },
    logError: (scope, input) => {
      logInternalError(scope, input);
    },
    attempted: attemptedSessionIds,
  };
}

/**
 * 在助手回复收口后调用。不是第一条、用户已改名、或偏好关闭时直接返回。
 * 偏好关闭不写入 attempted，但收口钩子不会再次为同一条回复触发。
 */
export async function maybeRequestAiSessionTitle(
  sessionId: string,
  assistantMsgId: string,
  overrides: Partial<AiSessionTitleDeps> = {}
): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };
  const sid = sessionId.trim();
  if (!sid || !assistantMsgId) return;
  if (deps.attempted.has(sid)) return;

  let session: AiTitleSession | undefined;
  try {
    session = deps.getSession(sid);
  } catch (err) {
    deps.logError(AI_SESSION_TITLE_SCOPE, { sessionId: sid, err });
    return;
  }
  if (!session) return;
  if (effectiveTitleSource(session.titleSource) === 'user') return;
  if (!isFirstNonEmptyAssistantReply(session.messages, assistantMsgId)) return;

  let enabled = false;
  try {
    enabled = await deps.getAiTitleEnabled();
  } catch (err) {
    deps.logError(AI_SESSION_TITLE_SCOPE, { sessionId: sid, err });
    return;
  }
  if (!enabled) return;
  if (deps.attempted.has(sid)) return;
  deps.attempted.add(sid);

  const messages = deps.getSession(sid)?.messages ?? session.messages;
  const userText = capCodePoints(
    firstNonEmptyUserText(messages),
    AI_SESSION_TITLE_INPUT_CAP
  );
  const assistant = messages?.find((message) => message.id === assistantMsgId);
  const assistantText = capCodePoints(
    visibleText(assistant),
    AI_SESSION_TITLE_INPUT_CAP
  );
  if (!userText && !assistantText) {
    deps.logError(AI_SESSION_TITLE_SCOPE, {
      sessionId: sid,
      err: 'empty title inputs',
    });
    return;
  }

  try {
    const res = await deps.invokeGenerate({
      sessionId: sid,
      userText,
      assistantText,
    });
    if (res.status !== 'ok') {
      deps.logError(AI_SESSION_TITLE_SCOPE, {
        sessionId: sid,
        err: res.message,
      });
      return;
    }
    const title = sanitizeAiSessionTitle(res.title);
    if (!title) {
      deps.logError(AI_SESSION_TITLE_SCOPE, {
        sessionId: sid,
        err: 'empty title after sanitize',
      });
      return;
    }
    const latest = deps.getSession(sid);
    if (!latest || effectiveTitleSource(latest.titleSource) === 'user') return;
    deps.applyTitle(sid, title);
  } catch (err) {
    deps.logError(AI_SESSION_TITLE_SCOPE, { sessionId: sid, err });
  }
}
