import { useLayoutStore } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import { isPendingDraft } from '../../store/draftSession';
import {
  addMessage,
  commitDraftIfNeeded,
  openSettings,
  patchSession,
  setPermissionMode,
} from '../../api/storeAccess';
import { generateMessageId } from '../../utils/generateMessageId';
import type { ChatContentPart, StreamRequestOptions } from '../../api/chatApi';
import { clientApi } from '../../api/clientApi';
import { getWorkspacePath } from '../../api/projectStore';
import {
  buildGoalModePrefix,
  createInitialGoalMode,
  GOAL_DEFAULT_MAX_ITERATIONS,
} from '../../api/goalModeController';
import { isNavigationSlash, resolveSlashCommand, slashMissingArg } from '../../api/resolveSlashCommand';
import { emitUiEvent } from '../../api/uiEvents';
import { deriveSessionTitle, isDefaultSessionTitle } from '../../api/sessionTitle';
import { formatAnnotationsForModel, takePendingFileAnnotations } from '../../api/workspaceFsApi';
import { GRILL_ME_PREFIX } from './slash-prefixes';
import { buildMultimodalFromAttachments } from './multimodal';
import {
  resolveStreamSessionId,
  canStreamLocalSession,
  decideSendWhileRunning,
  isSessionAiBusy,
} from './helpers';
import { getCompositionRoot } from '../../app/compositionRoot';
import type { UseChatStreamOptions, ChatAttachment } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import type { SessionMessage } from '../../store/layoutStore';

export function useSlashSend(
  options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  runStreamingAssistant: (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => void,
): {
  handleSendChat: (
    isInsert?: boolean,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => Promise<void>;
} {
  const {
    wsId,
    onShowToast,
    handleGlobalTabClick,
    chatInput,
    setChatInput,
    setSlashMenuOpen,
    attachments,
    setAttachments,
    skillCommandsEnabled,
    needsKeySetup,
    needsModelSetup = false,
    setPickerInlineError,
    onOpenModelPicker,
  } = options;

  // 渲染订阅：仅 activeSessionId（rename 等命令走 compositionRoot.session）
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const { streamManagerRef } = refs;

  const handleSendChat = async (
    isInsert: boolean = false,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => {
    void isInsert;
    const fromOverride = typeof textOverride === 'string';
    const rawInput = (fromOverride ? textOverride : chatInput).trim();
    const activeAttachments =
      attachmentsOverride ?? (fromOverride ? [] : attachments);
    if (!rawInput && activeAttachments.length === 0) return;

    if (needsKeySetup) {
      setPickerInlineError('请先在设置中配置服务商密钥与模型');
      openSettings('models');
      return;
    }
    if (needsModelSetup) {
      setPickerInlineError('请手填或选择模型 id 后再发送');
      onOpenModelPicker?.();
      return;
    }

    const slash = resolveSlashCommand(rawInput);

    if (isNavigationSlash(slash.kind)) {
      setChatInput('');
      setSlashMenuOpen(false);
      if (slash.kind === 'schedule') {
        emitUiEvent('open-scheduled');
        return;
      }
      if (slash.kind === 'teamwork-preview') {
        void import('../../api/openAgentPanel').then(({ openAgentPanelBrowse }) => {
          openAgentPanelBrowse({ sessionId: activeSessionId || undefined });
        });
        return;
      }
      handleGlobalTabClick('preview');
      if (slash.kind === 'browser' && slash.url) {
        void import('../../api/previewBrowserStore').then(({ normalizeBrowseUrl, setPreviewUrl }) => {
          setPreviewUrl(normalizeBrowseUrl(slash.url));
        });
      }
      return;
    }

    if (slashMissingArg(slash)) {
      setChatInput('');
      setSlashMenuOpen(false);
      if (slash.kind === 'learn') onShowToast('用法：/learn <要记住的规则>');
      else if (slash.kind === 'goal') onShowToast('用法：/goal <要完成的目标>');
      else if (slash.kind === 'grill-me') onShowToast('用法：/grill-me <要对齐的主题>');
      return;
    }

    // 草稿 → 真会话：commit 后补建 shell tab + 绑 chat leaf。
    // openNewDraftTab 解绑了 chat leaf.sessionId 且 draft 不进 openTabs；
    // 若不补 openOrFocusSession，顶栏工具按钮找不到 tab、右侧坞无法展开。
    const commitDraftAndOpenShell = (
      opts?: { title?: string; folder?: string }
    ): string => {
      const newId = commitDraftIfNeeded(opts);
      if (!newId || isPendingDraft(newId)) return newId;
      const shell = getCompositionRoot().shell.getState();
      if (!shell.openTabs.some((t) => t.sessionId === newId)) {
        const sess = getSessionById(newId);
        getCompositionRoot().session.openOrFocusSession(newId, {
          title: sess?.title,
        });
      }
      return newId;
    };

    let modelText = rawInput;
    let displayText = rawInput;
    if (slash.kind === 'skill') {
      if (!skillCommandsEnabled) {
        setChatInput('');
        setSlashMenuOpen(false);
        onShowToast('技能斜杠命令已关闭（设置 → 技能）');
        return;
      }
      try {
        const { resolveSkillSlash, formatSkillInjection } = await import('../../api/skillsApi');
        const resolved = await resolveSkillSlash(slash.raw);
        if (!resolved) {
          setChatInput('');
          setSlashMenuOpen(false);
          onShowToast('未找到该技能，请在设置 → 技能 中确认名称与启用状态');
          return;
        }
        modelText = formatSkillInjection(resolved.skill, resolved.rest);
        displayText = resolved.rest
          ? `/skill:${resolved.skill.name} ${resolved.rest}`
          : `使用技能：${resolved.skill.name}`;
      } catch (e) {
        setChatInput('');
        setSlashMenuOpen(false);
        onShowToast(`加载技能失败：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    if (slash.kind === 'learn') {
      setChatInput('');
      setSlashMenuOpen(false);
      const ruleText = slash.rule;
      if (!ruleText) {
        onShowToast('用法：/learn <要记住的规则>');
        return;
      }
      try {
        const cwd = getWorkspacePath() || '__global__';
        const sets = await clientApi.getSettingsEx(cwd);
        const prev = Array.isArray(sets.customRules) ? sets.customRules : [];
        if (prev.includes(ruleText)) {
          onShowToast('该规则已存在');
          return;
        }
        const next = [...prev, ruleText];
        await clientApi.saveSettingsEx(cwd, 'global', { customRules: next });
        const { rulesLinesToText, syncRulesToDaemon } = await import('../../api/rulesApi');
        const globalText = rulesLinesToText(next, '# 全局规则');
        void syncRulesToDaemon({ globalText });

        // 真 session id 仅经 commitDraftAndOpenShell（草稿/脏 active → mint + 补 shell tab；已有真 active → 原样）
        let learnSid = '';
        if (isPendingDraft(activeSessionId)) {
          learnSid = commitDraftAndOpenShell({
            title: rawInput ? deriveSessionTitle(rawInput) : undefined,
          });
        } else {
          learnSid = resolveStreamSessionId(null, activeSessionId) || '';
          if (!learnSid) {
            learnSid = commitDraftAndOpenShell();
          }
        }
        learnSid = resolveStreamSessionId(learnSid, null) || '';
        if (!learnSid || !canStreamLocalSession(learnSid, !!getSessionById(learnSid))) {
          onShowToast('会话不可用，规则已保存但未写入时间线');
          return;
        }
        const validLearnSid = learnSid;
        // 发送前固定 clientMessageId，回显/重放按 id upsert
        const userMsgId = generateMessageId('user');
        const asstMsgId = generateMessageId('assistant');
        addMessage(wsId, validLearnSid, {
          id: userMsgId,
          sender: 'user',
          text: `/learn ${ruleText}`,
          timestamp: Date.now(),
          status: 'completed',
        });
        addMessage(wsId, validLearnSid, {
          id: asstMsgId,
          sender: 'assistant',
          text: `已记录用户偏好：${ruleText}`,
          timestamp: Date.now() + 1,
          status: 'completed',
        });
      } catch (e) {
        onShowToast(`记住规则失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    // 用户首条 / 缺 sid：只 commitDraftAndOpenShell，禁止 createSession 默认空壳 mint
    let sessionId = '';
    if (isPendingDraft(activeSessionId)) {
      sessionId = commitDraftAndOpenShell({
        title: rawInput ? deriveSessionTitle(rawInput) : undefined,
      });
    } else {
      sessionId = resolveStreamSessionId(null, activeSessionId) || '';
      if (!sessionId) {
        sessionId = commitDraftAndOpenShell();
      }
    }
    if (!sessionId || !canStreamLocalSession(sessionId, !!getSessionById(sessionId))) {
      setPickerInlineError('会话不可用，请新建会话后重试');
      return;
    }

    if (slash.kind === 'goal') {
      const goalText = slash.goal;
      streamManagerRef.current?.clearGoalCancelled(sessionId);
      const gm = createInitialGoalMode(goalText, GOAL_DEFAULT_MAX_ITERATIONS);
      patchSession(sessionId, { goalMode: gm });
      displayText = `/goal ${goalText}`;
      modelText = `${buildGoalModePrefix(goalText, 0, gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS, gm.tasks)}${goalText}`;
    }

    if (slash.kind === 'grill-me') {
      setPermissionMode('plan');
      displayText = `/grill-me ${slash.topic}`;
      modelText = `${GRILL_ME_PREFIX}主题：${slash.topic}`;
    }

    if (rawInput && slash.kind !== 'goal') {
      const liveGm = getSessionById(sessionId)?.goalMode;
      if (liveGm?.active && liveGm.goal) {
        const maxIter = liveGm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
        modelText = `${buildGoalModePrefix(liveGm.goal, liveGm.iteration ?? 0, maxIter, liveGm.tasks)}${modelText}`;
      }
    }

    const { promptAttachBlock, streamOptions } = buildMultimodalFromAttachments(
      modelText, activeAttachments
    );
    const fileAnns = takePendingFileAnnotations();
    const annBlock = formatAnnotationsForModel(fileAnns);
    const input = (annBlock ? `${annBlock}\n\n` : '') + modelText + promptAttachBlock;
    let finalStreamOptions = streamOptions;
    if (finalStreamOptions?.content?.length && annBlock) {
      const parts = [...finalStreamOptions.content];
      const firstText = parts.findIndex((p: ChatContentPart) => p.type === 'text');
      const head = firstText >= 0 ? parts[firstText] : undefined;
      if (head && head.type === 'text') {
        parts[firstText] = { type: 'text', text: `${annBlock}\n\n${head.text}` };
      } else {
        parts.unshift({ type: 'text', text: annBlock });
      }
      finalStreamOptions = { ...finalStreamOptions, content: parts };
    } else if (!finalStreamOptions && annBlock) {
      finalStreamOptions = {
        content: [{ type: 'text', text: `${annBlock}\n\n${modelText}` }],
        hasImages: false,
      };
    }
    if (fileAnns.length) {
      displayText = displayText
        ? `${displayText}\n\n（含 ${fileAnns.length} 条文件批注）`
        : `（${fileAnns.length} 条文件批注）`;
    }
    if (activeAttachments.length > 0) {
      displayText = `${displayText}${displayText ? '\n\n' : ''}📎 ${activeAttachments.map((a: ChatAttachment) => a.name).join('、')}`;
    }

    // 发送前固定 clientMessageId（= message.id），daemon/hydrate 回显按 id upsert 不双写
    const userMsgId = generateMessageId('user');
    // 透传用户幂等键到 run-task（助手 id 在 runStreamingAssistant 内 mint 并下发）
    finalStreamOptions = {
      ...(finalStreamOptions ?? {}),
      clientMessageId: userMsgId,
    };
    const sessLookup = getSessionById(sessionId);
    if (!sessLookup) {
      setPickerInlineError('会话不可用，请新建会话后重试');
      return;
    }
    const sessMsgs = Array.isArray(sessLookup.messages) ? sessLookup.messages : [];
    // L1 follow_up（pi）：运行中再发送 → 入队 status=queued，不 abort 当前 stream
    // （composer queueMode 同源；drainQueuedAfterComplete 在 idle 时再开 stream）
    const liveHandle = streamManagerRef.current?.get(sessionId);
    const isAiBusy = isSessionAiBusy({
      hasLiveStream: streamManagerRef.current?.hasStream(sessionId) ?? false,
      messages: sessMsgs,
    });
    const sendAction = decideSendWhileRunning(isAiBusy);
    const isFollowUp = sendAction === 'follow_up';

    {
      const sess = sessLookup;
      if (sess && isDefaultSessionTitle(sess.title)) {
        const priorUser = sessMsgs.find(
          (m: SessionMessage) => m.sender === 'user' && (m.text || '').trim()
        );
        const seed = (priorUser?.text || rawInput).trim();
        const nextTitle = deriveSessionTitle(seed);
        if (!isDefaultSessionTitle(nextTitle)) {
          getCompositionRoot().session.getState().renameSession(sessionId, nextTitle);
        }
      }
    }

    let enqueued = false;
    try {
      // 经 store.addMessage upsert：同 id 回显只 update（action 内会初始化 messages）
      addMessage(wsId, sessionId, {
        id: userMsgId,
        sender: 'user',
        text: displayText,
        timestamp: Date.now(),
        // follow_up：queued 待 idle drain；start：processing 并立刻 stream
        status: isFollowUp ? 'queued' : 'processing',
      });
      enqueued = !!getSessionById(sessionId)?.messages?.some(
        (m: SessionMessage) => m.id === userMsgId
      );
    } catch (err) {
      console.error('Failed to enqueue user message:', err);
    }

    if (!enqueued) {
      setPickerInlineError('会话消息发送失败，已为您保留输入内容');
      return;
    }

    setChatInput('');
    // 命令式 session 写：经 compositionRoot.session（勿散落 useLayoutStore.getState）
    const sessionFacade = getCompositionRoot().session.getState();
    sessionFacade.setComposerDraft(sessionId, '');
    setSlashMenuOpen(false);
    if (!fromOverride) setAttachments([]);
    setPickerInlineError('');

    if (isFollowUp) {
      // 观测 + 可选 daemon 接线：L1 经 compositionRoot.runControl（不 cancel）
      void getCompositionRoot().runControl.followUp({
        runId: liveHandle?.runId ?? null,
        sessionId,
        text: displayText,
        clientMessageId: userMsgId,
        reason: 'ui-send-while-running',
      });
      return;
    }

    // 仅空闲时启动 stream；激活经 session facade（send 路径，非 shell open/focus 手势）
    if (sessionFacade.activeSessionId !== sessionId) {
      sessionFacade.setActiveSessionId(sessionId);
    }
    runStreamingAssistant(input, userMsgId, sessionId, finalStreamOptions);
  };

  return { handleSendChat };
}
