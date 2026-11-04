// 本地对话发送引擎（CON-4/L2）：流式编排归引擎持有，页面只是视图——
// - 句柄按 threadId 注册：某线程生成中切走/页面卸载都不影响生成，切回
//   即可看到最新状态（v1 的「卸载断流」在多线程形态下废止）；
// - 回调按消息 id 写入 store（appendAssistantDelta/finishAssistant 内部
//   定位归属线程），多线程并发互不串话；
// - 发送瞬间才从 SecureStore 读密钥（经 localChatStore.readApiKey），
//   密钥不进引擎状态、不进 store、不落盘。
import { localChatStore } from '@/domain/store/localChatStore';
import {
  localChatSessionStore,
  threadRuntimeSnapshot,
} from '@/domain/store/localChatSessionStore';
import {
  buildWireMessages,
  notConfiguredError,
  resolveActiveSelection,
  sanitizeAiTitle,
  withErrorMessage,
} from '@/domain/pure/localChatProtocol';
import { nextId } from '@/domain/pure/id';
import type {
  LocalChatMessage,
  LocalModelsConfig,
  LocalThreadMeta,
} from '@/domain/types/localChat';
import type { StreamHandle } from './localChatClient';
import { getLocalChatClient } from './localChatWiring';
import { haptics } from '@/adapters/platform/haptics';
import { notifyLocalThreadTerminal } from '@/notifications/localProducer';

/** 进行中的流式句柄（threadId → handle；同线程同时至多一条流） */
const handles = new Map<string, StreamHandle>();

/** AI 标题已尝试的线程（进程内标记：一线程至多触发一次，失败不重试） */
const aiTitleAttempted = new Set<string>();

/** AI 标题生成指令（只输出标题本身；消毒侧另有 sanitizeAiTitle 兜底） */
const AI_TITLE_SYSTEM_PROMPT =
  '你负责为一段对话起标题。只输出标题本身：不要引号、不要 markdown、不要标点收尾、不要任何解释；不超过 14 个字；用对话的语言概括主题。';

/** AI 标题输入截断（首问/首答各取前段即可判主题，控制额外调用成本） */
const AI_TITLE_INPUT_MAX_CHARS = 500;

/**
 * 首轮回复完成后异步尝试 AI 标题（U4，fire-and-forget）：
 * - 守卫：线程存在、来源仍为 placeholder/derived（ai/user 不再碰）、
 *   恰为首轮（一问一答齐备）、本进程未尝试过——触发即标记，失败不重试；
 * - 通道：线程自己的供应商/模型（resolveThreadSelection），密钥发送瞬间
 *   从 SecureStore 现取（同发送路径，不进任何持久层/日志）；
 * - 结果经 sanitizeAiTitle 消毒后走 store.setThreadTitle('ai') 落盘，
 *   来源阶梯在 store 侧兜底（迟到结果撞上用户改名会被丢弃）；
 * - 一切失败（未配置/网络/超时/空结果）静默保留 derived 截断标题：
 *   不写线程 error 槽、不弹错——标题是锦上添花，不占错误面。
 */
function maybeGenerateAiTitle(threadId: string): void {
  if (aiTitleAttempted.has(threadId)) return;
  const session = localChatSessionStore.getState();
  const thread = session.threads.find((t) => t.id === threadId);
  if (!thread) return;
  if (
    thread.titleSource !== 'placeholder' &&
    thread.titleSource !== 'derived'
  ) {
    return;
  }
  const snapshot = threadRuntimeSnapshot(threadId);
  if (!snapshot) return;
  const userMessages = snapshot.messages.filter((m) => m.role === 'user');
  const firstAssistant = snapshot.messages.find(
    (m) => m.role === 'assistant' && m.content.trim() !== ''
  );
  if (userMessages.length !== 1 || !firstAssistant) return;
  const firstUser = userMessages[0]!;
  aiTitleAttempted.add(threadId);
  const sel = resolveThreadSelection(localChatStore.getState().config, thread);
  if (!sel) return;
  void (async () => {
    try {
      const apiKey = await localChatStore.getState().readApiKey(sel.providerId);
      const raw = await getLocalChatClient().completeChatCompletion({
        baseUrl: sel.provider.baseUrl ?? '',
        apiKey,
        model: sel.modelId,
        messages: [
          { role: 'system', content: AI_TITLE_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `用户：${firstUser.content.slice(0, AI_TITLE_INPUT_MAX_CHARS)}\n` +
              `助手：${firstAssistant.content.slice(0, AI_TITLE_INPUT_MAX_CHARS)}`,
          },
        ],
      });
      const title = sanitizeAiTitle(raw);
      if (title === null) return;
      localChatSessionStore.getState().setThreadTitle(threadId, title, 'ai');
    } catch {
      // 静默回退：保留 derived 截断标题（口径见函数头注）
    }
  })();
}

/** 线程有效选择解析：线程快照的 modelRef 优先，缺省跟随全局活动模型 */
export function resolveThreadSelection(
  config: LocalModelsConfig,
  thread: Pick<LocalThreadMeta, 'modelRef'> | null
) {
  if (thread?.modelRef) {
    return resolveActiveSelection({ ...config, activeModel: thread.modelRef });
  }
  return resolveActiveSelection(config);
}

/**
 * 向指定线程发送一条用户消息并流式生成回复。
 * @returns 是否真正发出（空文本/线程不存在/该线程生成中/未配置 → false，
 *          未配置时错误已写入该线程的 error 槽供页面横幅呈现）
 */
export function sendLocalChatMessage(
  threadId: string,
  rawText: string
): boolean {
  const text = rawText.trim();
  if (text === '') return false;
  const session = localChatSessionStore.getState();
  const snapshot = threadRuntimeSnapshot(threadId);
  if (!snapshot || snapshot.streaming) return false;
  const thread = session.threads.find((t) => t.id === threadId);
  if (!thread) return false;
  const sel = resolveThreadSelection(localChatStore.getState().config, thread);
  if (!sel) {
    session.setError(withErrorMessage(notConfiguredError()), threadId);
    return false;
  }
  const userMessage: LocalChatMessage = {
    id: nextId('lcm'),
    role: 'user',
    content: text,
  };
  session.appendUser(userMessage, threadId);
  const assistantId = nextId('lcm');
  session.beginAssistant(
    { id: assistantId, role: 'assistant', content: '' },
    threadId
  );
  const history = threadRuntimeSnapshot(threadId)?.messages ?? [];
  const wire = buildWireMessages(history);
  void localChatStore
    .getState()
    .readApiKey(sel.providerId)
    .then((apiKey) => {
      // 密钥读取期间线程被删、或占位消息已被停止收尾 → 不再起流
      const snap = threadRuntimeSnapshot(threadId);
      const stillStreaming = snap?.messages.some(
        (m) => m.id === assistantId && m.streaming === true
      );
      if (!stillStreaming) return;
      const client = getLocalChatClient();
      const handle = client.streamChatCompletion(
        {
          baseUrl: sel.provider.baseUrl ?? '',
          apiKey,
          model: sel.modelId,
          messages: wire,
        },
        {
          onTextDelta: (delta) => {
            localChatSessionStore
              .getState()
              .appendAssistantDelta(assistantId, delta);
          },
          onComplete: ({ toolCallCount }) => {
            handles.delete(threadId);
            localChatSessionStore.getState().finishAssistant(assistantId, {
              ...(toolCallCount > 0 ? { toolCallCount } : {}),
            });
            // 本地终态通知（通知分寸批）：App 在后台时完成也要有着落——
            // 产生器内按 AppState/门禁分流（前台仅入通知中心，不弹系统通知）
            notifyLocalThreadTerminal({
              threadId,
              assistantId,
              outcome: 'completed',
            });
            // 首轮完成点：异步尝试 AI 标题升级（不阻塞收尾主流程与完成打点）
            maybeGenerateAiTitle(threadId);
          },
          onError: (err) => {
            handles.delete(threadId);
            const state = localChatSessionStore.getState();
            // 已生成部分保留在消息里，错误以横幅呈现（不吞内容）
            state.finishAssistant(assistantId);
            state.setError(err, threadId);
            // 本地终态通知（失败必达）：同完成路，失败经门禁 error 恒放行
            notifyLocalThreadTerminal({
              threadId,
              assistantId,
              outcome: 'failed',
              errorMessage: err.message,
            });
          },
        }
      );
      handles.set(threadId, handle);
    });
  // 本地发送被受理 → 成功触感（触觉门面，手感基建批；与远程发送口径一致）
  haptics.success();
  return true;
}

/** 停止指定线程的生成（保留已生成部分并标注 stopped；不产生错误） */
export function stopLocalChatMessage(threadId: string): void {
  const handle = handles.get(threadId);
  if (handle) {
    handle.abort();
    handles.delete(threadId);
  }
  const state = localChatSessionStore.getState();
  const snapshot = threadRuntimeSnapshot(threadId);
  const streamingMessage = snapshot?.messages.find((m) => m.streaming);
  if (streamingMessage) {
    state.finishAssistant(streamingMessage.id, { stopped: true });
  } else if (snapshot?.streaming) {
    // 句柄尚未就位（密钥读取中）但生成态已置位 → 直接收尾生成态
    state.setStreaming(false, threadId);
  }
}

/** 中止指定线程的流（删线程前调用；不写收尾，线程数据随即整体移除） */
export function abortLocalThread(threadId: string): void {
  const handle = handles.get(threadId);
  if (handle) {
    handle.abort();
    handles.delete(threadId);
  }
}

/** 指定线程是否生成中（引擎侧真值：句柄在册） */
export function isLocalThreadStreaming(threadId: string): boolean {
  return handles.has(threadId);
}

/** 测试隔离：清空全部句柄与 AI 标题尝试标记（不中止底层流，测试以假传输替换） */
export function resetLocalChatEngineForTest(): void {
  handles.clear();
  aiTitleAttempted.clear();
}
