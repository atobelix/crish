import { useLayoutStore } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import { isPendingDraft } from '../../store/draftSession';
import {
  commitDraftIfNeeded,
  createSession as createSessionCmd,
  openSettings,
  patchSession,
  setPermissionMode,
} from '../../api/storeAccess';
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
  ensureSessionMessages,
} from './helpers';
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
  handleSendChat: (isInsert?: boolean, textOverride?: string) => Promise<void>;
} {
  const {
    wsId: _wsId,
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

  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const renameSession = useLayoutStore((s) => s.renameSession);
  const { streamManagerRef } = refs;

  const handleSendChat = async (
    isInsert: boolean = false,
    textOverride?: string
  ) => {
    void isInsert;
    const fromOverride = typeof textOverride === 'string';
    const rawInput = (fromOverride ? textOverride : chatInput).trim();
    const activeAttachments = fromOverride ? [] : attachments;
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

        let learnSid = '';
        if (isPendingDraft(activeSessionId)) {
          learnSid = commitDraftIfNeeded({
            title: (rawInput ? deriveSessionTitle(rawInput) : undefined) as string | undefined,
          }) || '';
        } else {
          learnSid = resolveStreamSessionId(null, activeSessionId) || '';
          if (!learnSid) {
            learnSid = commitDraftIfNeeded() || createSessionCmd({ title: '新会话' }) || '';
          }
        }
        learnSid = resolveStreamSessionId(learnSid, null) || '';
        if (!learnSid || !canStreamLocalSession(learnSid, !!getSessionById(learnSid))) {
          onShowToast('会话不可用，规则已保存但未写入时间线');
          return;
        }
        const validLearnSid = learnSid;
        const userMsgId = `user-msg-${Date.now()}`;
        const asstMsgId = `assistant-msg-${Date.now()}-learn`;
        useLayoutStore.setState((state) => {
          const sess = state.sessionsById[validLearnSid];
          if (!ensureSessionMessages(sess)) return;
          sess.messages.push({
            id: userMsgId,
            sender: 'user',
            text: `/learn ${ruleText}`,
            timestamp: Date.now(),
            status: 'completed',
          });
          sess.messages.push({
            id: asstMsgId,
            sender: 'assistant',
            text: `已记录用户偏好：${ruleText}`,
            timestamp: Date.now() + 1,
            status: 'completed',
          });
        });
      } catch (e) {
        onShowToast(`记住规则失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    let sessionId = '';
    if (isPendingDraft(activeSessionId)) {
      sessionId = commitDraftIfNeeded({
        title: (rawInput ? deriveSessionTitle(rawInput) : undefined) as string | undefined,
      }) || '';
    } else {
      sessionId = resolveStreamSessionId(null, activeSessionId) || '';
      if (!sessionId) {
        sessionId = commitDraftIfNeeded() || createSessionCmd({ title: '新会话' }) || '';
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

    const userMsgId = `user-msg-${Date.now()}`;
    const sessLookup = getSessionById(sessionId);
    if (!sessLookup) {
      setPickerInlineError('会话不可用，请新建会话后重试');
      return;
    }
    const sessMsgs = Array.isArray(sessLookup.messages) ? sessLookup.messages : [];
    const isAiBusy = streamManagerRef.current?.hasStream(sessionId) ?? false;

    {
      const sess = sessLookup;
      if (sess && isDefaultSessionTitle(sess.title)) {
        const priorUser = sessMsgs.find(
          (m: SessionMessage) => m.sender === 'user' && (m.text || '').trim()
        );
        const seed = (priorUser?.text || rawInput).trim();
        const nextTitle = deriveSessionTitle(seed);
        if (!isDefaultSessionTitle(nextTitle)) {
          renameSession(sessionId, nextTitle);
        }
      }
    }

    let enqueued = false;
    try {
      useLayoutStore.setState((state) => {
        const sess = state.sessionsById[sessionId];
        if (!ensureSessionMessages(sess)) return;
        const newMsg: SessionMessage = {
          id: userMsgId,
          sender: 'user',
          text: displayText,
          timestamp: Date.now(),
          status: isAiBusy ? 'queued' : 'processing',
        };
        sess.messages.push(newMsg);
        enqueued = true;
      });
    } catch (err) {
      console.error('Failed to enqueue user message:', err);
    }

    if (!enqueued) {
      setPickerInlineError('会话消息发送失败，已为您保留输入内容');
      return;
    }

    setChatInput('');
    useLayoutStore.getState().setComposerDraft(sessionId, '');
    setSlashMenuOpen(false);
    if (!fromOverride) setAttachments([]);
    setPickerInlineError('');

    if (!isAiBusy) {
      const store = useLayoutStore.getState();
      if (store.activeSessionId !== sessionId) {
        store.setActiveSessionId(sessionId);
      }
      runStreamingAssistant(input, userMsgId, sessionId, finalStreamOptions);
    }
  };

  return { handleSendChat };
}
