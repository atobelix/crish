// 本地对话发送引擎（CON-4/L2）：流式编排归引擎持有，页面只是视图——
// - 句柄按 threadId 注册：某线程生成中切走/页面卸载都不影响生成，切回
//   即可看到最新状态（v1 的「卸载断流」在多线程形态下废止）；
// - 回调按消息 id 写入 store（appendAssistantDelta/finishAssistant 内部
//   定位归属线程），多线程并发互不串话；
// - 发送瞬间才从 SecureStore 读密钥（经 localChatStore.readApiKey），
//   密钥不进引擎状态、不进 store、不落盘。
// - 本地多轮自主 Agent Loop 循环（Wave 3）：支持端侧工具调用（web_search、
//   web_fetch、run_js_sandbox 等）、级联 AbortSignal、单轮幂等缓存与最多 6 轮防死锁硬熔断。
import { localChatStore } from '@/domain/store/localChatStore';
import {
  localChatSessionStore,
  threadRuntimeSnapshot,
} from '@/domain/store/localChatSessionStore';
import {
  buildLocalChatSystemPrompt,
  buildWireMessages,
  localModelVisionSupported,
  notConfiguredError,
  resolveActiveSelection,
  resolveEffectiveThinkingFormat,
  sanitizeAiTitle,
  withErrorMessage,
} from '@/domain/pure/localChatProtocol';
import {
  buildRunPayload,
  checkRunPayloadSizes,
  type BuiltRunPayload,
  type ComposerAttachment,
} from '@/domain/pure/attachments';
import { nextId } from '@/domain/pure/id';
import type {
  LocalChatMessage,
  LocalModelsConfig,
  LocalThreadMeta,
} from '@/domain/types/localChat';
import type { LocalToolCall } from '@/db/dao/localThreadsDao';
import type { StreamHandle } from './localChatClient';
import { getLocalChatClient } from './localChatWiring';
import { haptics } from '@/adapters/platform/haptics';
import { notifyLocalThreadTerminal } from '@/notifications/localProducer';
import { mobileToolRegistry, type ToolExecutionResult } from '@/adapters/tools';

/** 工具执行上下文 */
export interface MobileToolExecutionContext {
  runId: string;
  signal: AbortSignal;
}

/** 工具执行结果 */
export interface MobileToolExecutionResult {
  success: boolean;
  content: string;
  durationMs?: number;
}

/** 工具执行器契约 */
export type MobileToolExecutor = (
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    parsedArgs?: Record<string, unknown>;
  },
  context: MobileToolExecutionContext
) => Promise<MobileToolExecutionResult | string>;

/** 最大多轮自主 Agent 迭代轮数（硬性防死锁护栏） */
export const MAX_AGENT_ROUNDS = 6;

/** 最大轮数超限熔断提示词 */
export const CIRCUIT_BREAKER_MAX_ROUNDS_PROMPT =
  '已达到最大推理轮数，请立即根据已掌握的所有信息，整理出最完整、最准确的最终答案，禁止再申请任何工具。';

/** 进行中的流式句柄（threadId → handle；同线程同时至多一条流） */
const handles = new Map<string, StreamHandle>();

/** AI 标题已尝试的线程（进程内标记：一线程至多触发一次，失败不重试） */
const aiTitleAttempted = new Set<string>();

/** AI 标题生成指令（只输出标题本身；消毒侧另有 sanitizeAiTitle 兜底） */
const AI_TITLE_SYSTEM_PROMPT =
  '你负责为一段对话起标题。只输出标题本身：不要引号、不要 markdown、不要标点收尾、不要任何解释；不超过 14 个字；用对话的语言概括主题。';

/** AI 标题输入截断（首问/首答各取前段即可判主题，控制额外调用成本） */
const AI_TITLE_INPUT_MAX_CHARS = 500;

let customToolsSupplier: (() => readonly unknown[]) | null = null;
let customToolExecutor: MobileToolExecutor | null = null;

export function setLocalChatToolsSupplierForTest(
  supplier: (() => readonly unknown[]) | null
): void {
  customToolsSupplier = supplier;
}

export function setLocalChatToolExecutorForTest(
  executor: MobileToolExecutor | null
): void {
  customToolExecutor = executor;
}

/**
 * 默认端侧工具执行器：对接通用端侧工具注册表 mobileToolRegistry
 */
async function defaultMobileToolExecutor(
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    parsedArgs?: Record<string, unknown>;
  },
  context: MobileToolExecutionContext
): Promise<MobileToolExecutionResult | string> {
  const started = Date.now();
  if (context.signal.aborted) {
    throw new Error('Aborted');
  }

  const result: ToolExecutionResult = await mobileToolRegistry.executeToolCall(
    {
      id: toolCall.id,
      name: toolCall.name,
      arguments:
        typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : JSON.stringify(toolCall.parsedArgs ?? {}),
    },
    {
      signal: context.signal,
    }
  );

  return {
    success: result.ok,
    content: result.output,
    durationMs: Date.now() - started,
  };
}

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
 * 向指定线程发送一条用户消息并启动多轮 Agent 循环。
 * 附件（可选）：与远端同一组装口径（buildRunPayload）——视觉能力读
 * 本地模型 spec 的 modalities（fail-closed：未声明/不支持 → 图片降级
 * 为元数据文本，绝不直发、绝不静默丢弃）；发送前总量预检，超限
 * 拒收并把具体原因写入线程 error 槽。纯附件（空文本）可发送。
 * @returns 是否真正发出（空文本且无附件/线程不存在/该线程生成中/
 *          未配置/附件超限 → false，未配置与超限时错误已写入该线程
 *          的 error 槽供页面横幅呈现）
 */
export function sendLocalChatMessage(
  threadId: string,
  rawText: string,
  attachments?: readonly ComposerAttachment[]
): boolean {
  const text = rawText.trim();
  const atts = attachments ?? [];
  if (text === '' && atts.length === 0) return false;
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
  const currentSel = sel;

  // 提取模型完整配置以确定思考参数与输出上限
  const modelSpec = currentSel.provider.models.find(
    (m) => m.id === currentSel.modelId
  );
  const thinkingTier = modelSpec?.thinking?.supported
    ? modelSpec.thinking.defaultTier
    : undefined;
  const thinkingFormat = resolveEffectiveThinkingFormat(
    currentSel.provider,
    modelSpec
  );
  const maxTokens = modelSpec?.maxOutputTokens;

  const vision = localModelVisionSupported(
    currentSel.provider,
    currentSel.modelId
  );
  const payload: BuiltRunPayload | null =
    atts.length > 0 ? buildRunPayload(text, atts, vision) : null;
  if (payload !== null) {
    const sizeCheck = checkRunPayloadSizes(payload);
    if (!sizeCheck.ok) {
      session.setError(
        withErrorMessage({
          kind: 'payloadTooLarge',
          status: null,
          message: sizeCheck.message,
          retryable: false,
        }),
        threadId
      );
      return false;
    }
  }
  const userMessage: LocalChatMessage = {
    id: nextId('lcm'),
    role: 'user',
    content: payload !== null ? payload.prompt : text,
    ...(payload?.hasImages
      ? {
          attachments: atts.filter(
            (a) => a.kind === 'image' && typeof a.dataUrl === 'string'
          ),
        }
      : {}),
  };
  session.appendUser(userMessage, threadId);

  const initialAssistantId = nextId('lcm');
  session.beginAssistant(
    { id: initialAssistantId, role: 'assistant', content: '' },
    threadId
  );

  // 初始化多轮 Agent Loop 控制块与级联 AbortController
  const runAbortController = new AbortController();
  let currentStreamHandle: StreamHandle | null = null;
  const activeHandle: StreamHandle = {
    abort: () => {
      runAbortController.abort();
      if (currentStreamHandle) {
        currentStreamHandle.abort();
        currentStreamHandle = null;
      }
    },
  };
  handles.set(threadId, activeHandle);

  // 单次 Agent Run 幂等缓存（同 query / 同 url / 同 code 缓存 Promise）
  const runCache = new Map<
    string,
    Promise<MobileToolExecutionResult | string>
  >();

  void localChatStore
    .getState()
    .readApiKey(currentSel.providerId)
    .then(async (apiKey) => {
      try {
        const client = getLocalChatClient();

        async function executeRound(
          round: number,
          assistantId: string
        ): Promise<void> {
          if (runAbortController.signal.aborted) {
            handles.delete(threadId);
            return;
          }

          const snap = threadRuntimeSnapshot(threadId);
          const stillStreaming = snap?.messages.some(
            (m) => m.id === assistantId && m.streaming === true
          );
          if (!stillStreaming) {
            handles.delete(threadId);
            return;
          }

          const isMaxRound = round >= MAX_AGENT_ROUNDS;

          // 解析当前轮次启用的工具清单
          const rawTools = customToolsSupplier
            ? customToolsSupplier()
            : mobileToolRegistry.toOpenAiFunctionSchemas({ threadId });
          const tools = isMaxRound
            ? undefined
            : rawTools && rawTools.length > 0
              ? (rawTools as readonly unknown[])
              : undefined;

          const enabledToolsSummary =
            tools && tools.length > 0
              ? (tools as any[]).map((t) => ({
                  name: t.function?.name ?? t.name ?? '',
                  description: t.function?.description ?? t.description ?? '',
                }))
              : undefined;

          let systemPrompt = buildLocalChatSystemPrompt({
            enabledTools: enabledToolsSummary,
          });

          if (isMaxRound) {
            systemPrompt += `\n\n【注意】：${CIRCUIT_BREAKER_MAX_ROUNDS_PROMPT}`;
          }

          const currentHistory =
            threadRuntimeSnapshot(threadId)?.messages ?? [];
          const wire = buildWireMessages(currentHistory, {
            visionSupported: vision,
            systemPrompt,
          });

          currentStreamHandle = client.streamChatCompletion(
            {
              baseUrl: currentSel.provider.baseUrl ?? '',
              apiKey,
              model: currentSel.modelId,
              messages: wire,
              thinkingTier,
              thinkingFormat,
              maxTokens,
              ...(tools ? { tools, toolChoice: 'auto' } : {}),
            },
            {
              onTextDelta: (delta) => {
                localChatSessionStore
                  .getState()
                  .appendAssistantDelta(assistantId, delta);
              },
              onReasoningDelta: (delta) => {
                localChatSessionStore
                  .getState()
                  .appendAssistantReasoningDelta(assistantId, delta);
              },
              onComplete: async ({ toolCallCount, toolCalls }) => {
                currentStreamHandle = null;
                if (runAbortController.signal.aborted) {
                  handles.delete(threadId);
                  return;
                }

                const validToolCalls =
                  !isMaxRound &&
                  Array.isArray(toolCalls) &&
                  toolCalls.length > 0
                    ? toolCalls
                    : [];

                if (validToolCalls.length === 0) {
                  // 终态结束（纯文本收敛或达到第 6 轮强制总结）
                  handles.delete(threadId);
                  localChatSessionStore
                    .getState()
                    .finishAssistant(assistantId, {
                      ...(toolCallCount > 0 ? { toolCallCount } : {}),
                    });
                  notifyLocalThreadTerminal({
                    threadId,
                    assistantId,
                    outcome: 'completed',
                  });
                  maybeGenerateAiTitle(threadId);
                  return;
                }

                // 拦截收尾：将 Assistant tool_calls 存入历史并持久化
                const messageToolCalls: LocalToolCall[] = validToolCalls.map(
                  (tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                      name: tc.name,
                      arguments: tc.arguments ?? tc.argumentsString ?? '{}',
                    },
                    name: tc.name,
                    arguments: tc.arguments ?? tc.argumentsString ?? '{}',
                    parsedArgs: tc.parsedArgs ?? tc.parsedArguments,
                    status: 'running' as const,
                    state: 'executing' as const,
                  })
                );

                localChatSessionStore.getState().finishAssistant(assistantId, {
                  toolCalls: messageToolCalls,
                  toolCallCount: validToolCalls.length,
                });

                // 执行端侧工具并构造 role: 'tool' 消息回填
                try {
                  const executor =
                    customToolExecutor ?? defaultMobileToolExecutor;

                  for (const tc of validToolCalls) {
                    if (runAbortController.signal.aborted) break;

                    const argsStr = tc.arguments ?? tc.argumentsString ?? '{}';
                    const cacheKey = `${tc.name}:${argsStr}`;
                    let execPromise = runCache.get(cacheKey);
                    if (!execPromise) {
                      execPromise = executor(
                        {
                          id: tc.id,
                          name: tc.name,
                          arguments: argsStr,
                          parsedArgs: tc.parsedArgs ?? tc.parsedArguments,
                        },
                        {
                          runId: assistantId,
                          signal: runAbortController.signal,
                        }
                      );
                      runCache.set(cacheKey, execPromise);
                    }

                    let resultOutput: string;
                    try {
                      const res = await execPromise;
                      resultOutput =
                        typeof res === 'string' ? res : res.content;
                    } catch (err: any) {
                      resultOutput = JSON.stringify({
                        status: 'error',
                        error: err?.message ?? 'Tool execution failed',
                        system_note:
                          '工具调用发生异常。禁止使用相同参数重复调用该工具！请向用户说明原因或直接根据已有信息回答。',
                      });
                    }

                    if (runAbortController.signal.aborted) break;

                    const toolMsg: LocalChatMessage = {
                      id: nextId('lcm'),
                      role: 'tool',
                      toolCallId: tc.id,
                      content: resultOutput,
                    };
                    const store = localChatSessionStore.getState() as any;
                    if (typeof store.appendToolMessage === 'function') {
                      store.appendToolMessage(toolMsg, threadId);
                    } else {
                      localChatSessionStore
                        .getState()
                        .appendUser(toolMsg, threadId);
                    }
                  }

                  if (runAbortController.signal.aborted) {
                    handles.delete(threadId);
                    return;
                  }

                  // 发起下一轮 Agent 循环
                  const nextAssistantId = nextId('lcm');
                  localChatSessionStore
                    .getState()
                    .beginAssistant(
                      { id: nextAssistantId, role: 'assistant', content: '' },
                      threadId
                    );
                  await executeRound(round + 1, nextAssistantId);
                } catch (err: any) {
                  handles.delete(threadId);
                  const state = localChatSessionStore.getState();
                  state.setError(
                    withErrorMessage({
                      kind: 'unknown',
                      status: null,
                      message: err?.message ?? '端侧工具调用执行异常',
                      retryable: false,
                    }),
                    threadId
                  );
                }
              },
              onError: (err) => {
                currentStreamHandle = null;
                handles.delete(threadId);
                const state = localChatSessionStore.getState();
                state.finishAssistant(assistantId);
                state.setError(err, threadId);
                notifyLocalThreadTerminal({
                  threadId,
                  assistantId,
                  outcome: 'failed',
                  errorMessage: err.message,
                });
              },
            }
          );
        }

        await executeRound(1, initialAssistantId);
      } catch (err: any) {
        handles.delete(threadId);
        const state = localChatSessionStore.getState();
        state.finishAssistant(initialAssistantId);
        state.setError(
          withErrorMessage({
            kind: 'unknown',
            status: null,
            message: err?.message ?? '发送流式请求失败，请稍后重试',
            retryable: true,
          }),
          threadId
        );
      }
    })
    .catch((err: any) => {
      handles.delete(threadId);
      const state = localChatSessionStore.getState();
      state.finishAssistant(initialAssistantId);
      state.setError(
        withErrorMessage({
          kind: 'unknown',
          status: null,
          message: err?.message ?? '读取密钥失败，请检查配置后重试',
          retryable: true,
        }),
        threadId
      );
    });

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

/** 测试隔离：清空全部句柄、工具 mock 与 AI 标题尝试标记（不中止底层流，测试以假传输替换） */
export function resetLocalChatEngineForTest(): void {
  handles.clear();
  aiTitleAttempted.clear();
  customToolsSupplier = null;
  customToolExecutor = null;
}
