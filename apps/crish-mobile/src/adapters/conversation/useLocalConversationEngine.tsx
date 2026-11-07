// 本地线程引擎适配（移动界面统一方案 §2.1 / U2）：把本地对话的
// 数据面（localChatSessionStore 线程运行时 + localChatEngine 发送
// 编排 + localChatStore 供应商配置）收进 ConversationEngine 接口，
// 与远端引擎共用同一 ConversationScreen，界面零分叉。
//
// 能力面如实声明（界面按能力渲染，不按模式写 if）：
// - 供：blocks（buildLocalTimeline 投影）、busy（线程 streaming）、
//   available（恒 true——离线可用是本地对话的本质）、error（线程
//   error 槽：message + detail + onDismiss 全量透传，宿主以常驻
//   错误条形态呈现）、stop（本地现成）、composer.submitText（语音
//   直发）、composer.voice（端侧 ASR，两引擎一致）、modelControl
//   （本地模型 → LocalModelSheet）、menuEntries（供应商设置 /
//   清空对话）、emptyState（未配置 = 标题 + 去配置动作的诚实
//   空态；已配置 = 就绪标题；均不带旁白句——内容净化普查口径）、
//   renderSheets（LocalModelSheet）。
// - 不供：composer.contextBar（工作区 / 权限是连上电脑才有的概念，
//   用户裁决：本地不显示）、composer.submitWithAttachments（宿主级
//   富提交形态不供；附件经 onAttachPress 选取后随 submit 发送、
//   生成中随排队条目携带，组装在 sendLocalChatMessage 内完成）。
// 批 C ② 补项：草稿按 `local:<threadId>` 键控（composerDraftStore，
// 切线程不串稿、杀进程恢复）；生成中再发送进本线程发送队列
// （sendQueueStore 持久化、逐条可撤、生成结束自动续发），呈现走
// renderComposerLead 的共用排队行；生成中输入不再锁定（打字与发送
// 入队是排队的前提，停止钮与发送钮在宿主屏并存）。
// 旧本地对话 VM 的视图绑定语义平移至此（绑线程 / 挂载激活 /
// 多线程隔离的选择器口径逐项一致）；VM 本体已在 U5 随旧界面删除。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useStore } from 'zustand';
import { DEFAULT_COMPOSER_PLACEHOLDER, useToast } from '@/presentation/ui';
import { localChatStore } from '@/domain/store/localChatStore';
import {
  loadComposerDraft,
  peekComposerDraft,
  saveComposerDraft,
} from '@/domain/store/composerDraftStore';
import { useSendQueue } from '@/adapters/viewmodels/useSendQueue';
import type { SendQueueItem } from '@/domain/store/sendQueueStore';
import { SendQueueRows } from '@/presentation/components/chat/SendQueueRows';
import {
  localChatSessionStore,
  type LocalChatSessionState,
} from '@/domain/store/localChatSessionStore';
import { resolveActiveSelection } from '@/domain/pure/localChatProtocol';
import {
  abortLocalThread,
  resolveThreadSelection,
  sendLocalChatMessage,
  stopLocalChatMessage,
} from '@/adapters/localChat/localChatEngine';
import { useVoiceInput } from '@/adapters/asr/useVoiceInput';
import { useComposerAttachments } from '@/adapters/viewmodels/useComposerAttachments';
import { AttachmentSheet } from '@/presentation/components/chat/AttachmentSheet';
import { AttachmentStrip } from '@/presentation/components/chat/AttachmentStrip';
import { useState as useAttachmentOpenState } from 'react';
import { buildLocalTimeline } from '@/presentation/timeline/buildLocalTimeline';
import { LocalModelSheet } from '@/presentation/components/chat/LocalModelSheet';
import type { DropdownMenuEntry } from '@/presentation/ui/DropdownMenu';
import type {
  LocalChatError,
  LocalChatMessage,
} from '@/domain/types/localChat';
import type { ConversationEngine } from './types';

/** 与宿主 ConversationScreen 的跟随态同步面（与远端引擎同形） */
export interface LocalConversationSync {
  /** 发送成功回调（宿主据此恢复跟随，与远端 handleSent 同义） */
  onSendSuccess?: () => void;
}

const EMPTY_MESSAGES: readonly LocalChatMessage[] = [];

/** 绑定线程的消息选择（活动线程读投影；未激活读 inactive 表） */
function messagesOf(
  s: LocalChatSessionState,
  threadId: string
): readonly LocalChatMessage[] {
  if (threadId === s.activeThreadId) return s.messages;
  return s.inactive[threadId]?.messages ?? EMPTY_MESSAGES;
}

function streamingOf(s: LocalChatSessionState, threadId: string): boolean {
  if (threadId === s.activeThreadId) return s.streaming;
  return s.inactive[threadId]?.streaming ?? false;
}

function errorOf(
  s: LocalChatSessionState,
  threadId: string
): LocalChatError | null {
  if (threadId === s.activeThreadId) return s.error;
  return s.inactive[threadId]?.error ?? null;
}

export function useLocalConversationEngine(
  threadId: string,
  sync?: LocalConversationSync
): ConversationEngine {
  const onSendSuccess = sync?.onSendSuccess;
  const router = useRouter();
  const { showToast } = useToast();
  // 草稿键控（批 C ②）：按线程键存取，切线程不串稿、杀进程恢复
  const draftKey = `local:${threadId}`;
  const [prompt, setPromptState] = useState(() => peekComposerDraft(draftKey));
  const touchedRef = useRef(false);
  const setPrompt = useCallback(
    (text: string) => {
      touchedRef.current = true;
      setPromptState(text);
      saveComposerDraft(draftKey, text);
    },
    [draftKey]
  );
  // 持久草稿回填（挂载一次）：内存面已有则首帧命中，本回填只补
  // 冷启动后首次进本线程的落盘稿；用户已键入时不覆盖
  useEffect(() => {
    let cancelled = false;
    void loadComposerDraft(draftKey).then((draft) => {
      if (cancelled || touchedRef.current || draft === '') return;
      setPromptState(draft);
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // 附件（2026-11-05 加号解锁）：本地对话与主页同一选取管线——图片/文档
  // 经 useComposerAttachments 选取，发送随 sendLocalChatMessage 组装
  // （buildRunPayload 按 local model spec 的 modalities fail-closed）
  const [attachOpen, setAttachOpen] = useAttachmentOpenState(false);
  const attachmentsApi = useComposerAttachments({ notify: showToast });
  const attachments = attachmentsApi.attachments;
  // 发送受理回调需读最新已选区：经 ref 桥（避免 submit 依赖链抖动）
  const attachmentsRef = useRef(attachmentsApi);
  attachmentsRef.current = attachmentsApi;

  const config = useStore(localChatStore, (s) => s.config);
  const messages = useStore(localChatSessionStore, (s) =>
    messagesOf(s, threadId)
  );
  const streaming = useStore(localChatSessionStore, (s) =>
    streamingOf(s, threadId)
  );
  const error = useStore(localChatSessionStore, (s) => errorOf(s, threadId));
  const threadMeta = useStore(
    localChatSessionStore,
    (s) => s.threads.find((t) => t.id === threadId) ?? null
  );

  // 配置可能在 App 启动后才水合：挂载时若尚未水合，主动补一次
  // （与旧本地对话 VM 同口径；hydrate 幂等）。
  useEffect(() => {
    if (!localChatStore.getState().hydrated) {
      void localChatStore.getState().hydrate();
    }
  }, []);

  // 挂载激活所绑线程（运行时整表切换在 store 内完成；页面卸载不
  // 断流，生成句柄由 localChatEngine 按线程持有）。
  useEffect(() => {
    if (threadId) localChatSessionStore.getState().openThread(threadId);
  }, [threadId]);

  const selection = useMemo(
    () =>
      threadMeta
        ? resolveThreadSelection(config, threadMeta)
        : resolveActiveSelection(config),
    [config, threadMeta]
  );
  const configured = selection !== null;
  const activeLabel = selection
    ? `${selection.provider.displayName ?? selection.providerId} · ${selection.modelId}`
    : null;

  const blocks = useMemo(() => buildLocalTimeline(messages), [messages]);

  // 发送队列（批 C ②）：生成中再发送先进本线程队列（持久化、逐条
  // 可撤），生成结束由排空状态机逐条经既有 sendLocalChatMessage
  // 续发，不另设第二条发送链；未配置时排空硬门关闭（错误走线程
  // error 槽的既有面，不把消息静默囤在队列里）。
  const sendQueuedItem = useCallback(
    (item: SendQueueItem): boolean => {
      const ok = sendLocalChatMessage(threadId, item.text, item.attachments);
      if (ok) onSendSuccess?.();
      return ok;
    },
    [threadId, onSendSuccess]
  );
  const queue = useSendQueue(draftKey, {
    active: streaming,
    blocked: !configured,
    send: sendQueuedItem,
  });

  const submit = useCallback(
    (explicit?: string) => {
      const text = explicit ?? prompt;
      if (text.trim() === '' && attachments.length === 0) return;
      // 生成中发送 = 入队（批 C ②）：入队成功才清输入框与已选附件
      // （稿面转入队列行呈现）；队列已满则原文与附件一并保留并给
      // 诚实提示。附件以快照随条目入队，排空时 sendQueuedItem 经
      // sendLocalChatMessage 的附件组装链真实发送（2026-11-05 返工
      // 修复：此前只入队文本、已选附件被静默清掉）。
      if (streaming) {
        if (queue.enqueue(text, attachments)) {
          setPrompt('');
          attachmentsRef.current.clear();
        } else {
          showToast('排队消息已达上限，请等前面的消息发出', 'error');
        }
        return;
      }
      // 发送被受理才清输入框：未配置等失败保留原文，用户补好配置
      // 后可直接重发（错误已由引擎写进线程 error 槽呈现）。
      // 显式文本优先于父级 prompt：输入框不再逐字抬升父级状态。
      // 附件（2026-11-05 加号解锁）：随文本经本地引擎组装发送
      // （buildRunPayload 视觉 fail-closed），受理才清已选区。
      if (sendLocalChatMessage(threadId, text, attachments)) {
        setPrompt('');
        attachmentsRef.current.clear();
        onSendSuccess?.();
      }
    },
    [
      prompt,
      attachments,
      streaming,
      threadId,
      onSendSuccess,
      queue,
      setPrompt,
      showToast,
    ]
  );

  // 显式文本提交（语音直发）：生成中 → 入队（受理 = 进队列）；
  // 否则受理与否由引擎裁定（未配置 → false，错误同样进 error 槽），
  // 不另设第二条分发路径。受理裁定本身是同步的，以 Promise 形态
  // 对齐接口（与远端 submitText 同形：void | Promise<boolean>）。
  const submitText = useCallback(
    (text: string): Promise<boolean> => {
      if (streaming) {
        if (text.trim() === '') return Promise.resolve(false);
        return Promise.resolve(queue.enqueue(text));
      }
      const ok = sendLocalChatMessage(threadId, text);
      if (ok) onSendSuccess?.();
      return Promise.resolve(ok);
    },
    [threadId, onSendSuccess, streaming, queue]
  );

  // 端侧语音输入（与远端同一接线形态）：松开直发，回填走输入框。
  const voice = useVoiceInput({
    onFillText: setPrompt,
    onSubmitText: submitText,
    notify: showToast,
  });

  const stop = useCallback(() => {
    stopLocalChatMessage(threadId);
  }, [threadId]);

  const clearThread = useCallback(() => {
    abortLocalThread(threadId);
    localChatSessionStore.getState().clearThread(threadId);
  }, [threadId]);

  const dismissError = useCallback(() => {
    localChatSessionStore.getState().setError(null, threadId);
  }, [threadId]);

  const openProviders = useCallback(() => {
    router.push('/settings-local-providers');
  }, [router]);

  // 清空只在有内容且不在生成中时在场（旧视图呈现口径平移）。
  const canClear = messages.length > 0 && !streaming;
  const menuEntries = useMemo<DropdownMenuEntry[]>(
    () => [
      {
        key: 'providers',
        label: '供应商设置',
        onPress: openProviders,
      },
      ...(canClear
        ? [
            { key: 'ops-divider', divider: true as const },
            {
              key: 'clear',
              label: '清空对话',
              danger: true,
              onPress: clearThread,
            },
          ]
        : []),
    ],
    [canClear, clearThread, openProviders]
  );

  // 引擎专属浮层宿主：对话内「选择模型」Sheet（传入线程上下文：
  // 作用域「仅此对话」写线程 modelRef、「设为默认」写本地活动选择；
  // 线程快照模型优先的解析口径见 resolveThreadSelection）。
  const renderSheets = () => (
    <LocalModelSheet
      visible={modelSheetOpen}
      threadId={threadId}
      onClose={() => setModelSheetOpen(false)}
      onOpenProviders={() => {
        setModelSheetOpen(false);
        openProviders();
      }}
      testID="thread-model-sheet"
    />
  );

  return {
    kind: 'local',
    id: threadId,
    title: threadMeta?.title?.trim() || null,
    blocks,
    busy: streaming,
    available: true,
    error: error
      ? {
          message: error.message,
          detail: error.detail,
          onDismiss: dismissError,
        }
      : null,
    stop,
    composer: {
      prompt,
      setPrompt,
      submit,
      submitText,
      draftKey,
      // 生成中也可提交（= 入队，批 C ②）；输入不再随生成锁定——
      // 停止钮（宿主屏 busy && stop）与发送钮并存
      canSubmit: prompt.trim() !== '',
      editable: true,
      locked: false,
      placeholder: configured
        ? DEFAULT_COMPOSER_PLACEHOLDER
        : '先配置供应商后即可发送',
      // contextBar 不供：工作区 / 权限是远端概念，本地不渲染。
      modelControl: {
        label: activeLabel ?? '未配置供应商',
        onPress: () => setModelSheetOpen(true),
      },
      // 加号附件（2026-11-05 解锁）：与主页同一 AttachmentSheet 管线
      onAttachPress: () => setAttachOpen((v) => !v),
      hasAttachments: attachments.length > 0,
      voice,
    },
    menuEntries,
    emptyState: configured
      ? { title: '本地助手已就绪' }
      : {
          title: '尚未配置本地供应商',
          actionLabel: '去配置供应商',
          onAction: openProviders,
        },
    renderSheets,
    // Composer 上方专属行（批 C ②）：本线程的排队行（无排队时
    // 组件自守为空，不占位）
    renderComposerLead: () => (
      <>
        {/* 已选附件条（2026-11-05 加号解锁）：与主页同组件，发送受理清空 */}
        <AttachmentStrip
          attachments={attachments}
          onRemove={attachmentsApi.remove}
          picking={attachmentsApi.picking}
        />
        <SendQueueRows items={queue.items} onWithdraw={queue.withdraw} />
        {/* 附件选取面板（toggle 开合，与主页批 A 锚定 Popover 同口径） */}
        <AttachmentSheet
          visible={attachOpen}
          onClose={() => setAttachOpen(false)}
          onTakePhoto={attachmentsApi.pickFromCamera}
          onPickImage={attachmentsApi.pickFromLibrary}
          onPickFile={attachmentsApi.pickFromFiles}
        />
      </>
    ),
  };
}

export default useLocalConversationEngine;
