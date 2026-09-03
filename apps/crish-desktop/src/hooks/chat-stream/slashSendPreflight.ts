/**
 * apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts
 * 负责发送前置校验、本地斜杠命令路由与多模态 Payload 组装（单一职责叶）
 */
import { checkEngineReadyRealtime } from '../../api/chat-bridge/ConnectionLifecycle';
import { domainUserMessage } from '../../api/userFacingErrors';
import { useSessionStore } from '../../store/sessionStore';
import { navigateToNewDraft } from '../../store/storeAccess';
import {
  openSettings,
  patchSession,
  setPermissionMode,
} from '../../api/storeAccess';
import {
  resolveSlashCommand,
  isNavigationSlash,
  slashMissingArg,
} from '../../api/resolveSlashCommand';
import { clientApi } from '../../api/clientApi';
import { getWorkspacePath } from '../../api/projectStore';
import {
  buildGoalModePrefix,
  createInitialGoalMode,
  GOAL_DEFAULT_MAX_ITERATIONS,
} from '../../api/goalModeController';
import {
  formatAnnotationsForModel,
  takePendingFileAnnotations,
} from '../../api/workspaceFsApi';
import { GRILL_ME_PROMPT } from '../../prompts';
import { contextInjectionDispatcher } from '../../api/contextInjectionDispatcher';
import { estimateTextTokens } from '../../utils/tokenEstimator';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import {
  buildWorkflowAssistantContext,
  dispatchWorkflowAssistantCard,
  WORKFLOW_CREATE_TEMPLATE,
} from '../../api/workflow-api/workflowAssistantCard';
import { buildMultimodalFromAttachments } from './multimodal';
import { canStreamLocalSession } from './helpers';
import { getSessionById } from '../../store/sessionStore';
import { generateMessageId } from '../../utils/generateMessageId';
import { invokeTyped } from '../../api/tauriInvoke';
import { resolveTargetSessionId } from './slashSendDraftManager';
import type { ChatAttachment } from './types';
import type { ChatContentPart, StreamRequestOptions } from '../../api/chatApi';

import { toast } from '../../services/toast/ToastContext';

export interface PreflightCheckOptions {
  rawInput: string;
  activeSessionId?: string | null;
  wsId: string;
  attachments: ChatAttachment[];
  skillCommandsEnabled?: boolean;
  needsKeySetup?: boolean;
  needsModelSetup?: boolean;
  setPickerInlineError: (msg: string) => void;
  onOpenModelPicker?: () => void;
  handleGlobalTabClick: (tab: string) => void;
  setChatInput: (val: string) => void;
  setSlashMenuOpen: (open: boolean) => void;
}

export type PreflightResult =
  | { status: 'abort' }
  | { status: 'handled' }
  | {
      status: 'proceed';
      slash: ReturnType<typeof resolveSlashCommand>;
      modelText: string;
      displayText: string;
    };

/**
 * 运行前置安全检查与本地/导航类斜杠命令分发
 */
export async function runPreflightChecks(
  opts: PreflightCheckOptions
): Promise<PreflightResult> {
  const {
    rawInput,
    activeSessionId,
    wsId,
    attachments,
    skillCommandsEnabled,
    needsKeySetup,
    needsModelSetup,
    setPickerInlineError,
    onOpenModelPicker,
    handleGlobalTabClick,
    setChatInput,
    setSlashMenuOpen,
  } = opts;

  const showToast = (msg: string) => toast.show(msg);

  if (!rawInput && attachments.length === 0) return { status: 'abort' };

  if (needsKeySetup) {
    setPickerInlineError('请先在设置中配置服务商密钥与模型');
    openSettings('models');
    return { status: 'abort' };
  }
  if (needsModelSetup) {
    setPickerInlineError('请手填或选择模型 id 后再发送');
    onOpenModelPicker?.();
    return { status: 'abort' };
  }

  const readiness = await checkEngineReadyRealtime();
  if (!readiness.ok && readiness.domain) {
    setPickerInlineError(domainUserMessage(readiness.domain));
    return { status: 'abort' };
  }

  const slash = resolveSlashCommand(rawInput);

  if (isNavigationSlash(slash.kind)) {
    setChatInput('');
    setSlashMenuOpen(false);
    if (slash.kind === 'teamwork-preview') {
      void import('../../api/openAgentPanel').then(
        ({ openAgentPanelBrowse }) => {
          openAgentPanelBrowse({ sessionId: activeSessionId || undefined });
        }
      );
    } else {
      handleGlobalTabClick('preview');
      if (slash.kind === 'browser' && slash.url) {
        void import('../../api/previewBrowserStore').then(
          ({ normalizeBrowseUrl, setPreviewUrl }) => {
            setPreviewUrl(normalizeBrowseUrl(slash.url));
          }
        );
      }
    }
    return { status: 'handled' };
  }

  // /schedule：对话流编排助手（维度三 §2.6 / 维度五 TC-WG-01/02——绝不跳转设置页）
  if (slash.kind === 'schedule') {
    setSlashMenuOpen(false);
    const restText = rawInput
      .replace(/^\/(schedule|定时任务|定时)\s*/i, '')
      .trim();
    if (!restText) {
      // 无参：确保存在会话（草稿态则新建）→ 预填四要素模板（可撤销）→
      // 派发助手卡片，停留在输入框补全（被动直接注入，零 AI 轮次）
      navigateToNewDraft();
      const sid = useSessionStore.getState().activeSessionId;
      if (!sid) {
        showToast('会话不可用，请重试');
        return { status: 'handled' };
      }
      sessionDraftManager.injectSeed({
        targetSessionId: sid,
        content: WORKFLOW_CREATE_TEMPLATE,
        mode: 'safe_seed',
        metadata: { source: 'slash_command', title: '/schedule 编排模板' },
      });
      dispatchWorkflowAssistantCard(
        sid,
        getWorkspacePath() || '',
        'slash_command'
      );
      return { status: 'handled' };
    }
    // 带参：助手卡片可见派发 + wire 投影文本随消息下发（模型按卡片指令进入编排对齐）
    dispatchWorkflowAssistantCard(
      activeSessionId || '',
      getWorkspacePath() || '',
      'slash_command',
      restText
    );
    return {
      status: 'proceed',
      slash,
      modelText: buildWorkflowAssistantContext(
        getWorkspacePath() || '',
        restText
      ),
      displayText: rawInput,
    };
  }

  if (slashMissingArg(slash)) {
    setChatInput('');
    setSlashMenuOpen(false);
    if (slash.kind === 'learn') showToast('用法：/learn <要记住的规则>');
    else if (slash.kind === 'goal') showToast('用法：/goal <要完成的目标>');
    else if (slash.kind === 'grill-me')
      showToast('用法：/grill-me <要对齐的主题>');
    return { status: 'handled' };
  }

  let modelText = rawInput;
  let displayText = rawInput;

  if (slash.kind === 'skill') {
    if (!skillCommandsEnabled) {
      setChatInput('');
      setSlashMenuOpen(false);
      showToast('技能斜杠命令已关闭（设置 → 技能）');
      return { status: 'handled' };
    }
    try {
      const { resolveSkillSlash, formatSkillInjection } =
        await import('../../api/skillsApi');
      const resolved = await resolveSkillSlash(slash.raw);
      if (!resolved) {
        setChatInput('');
        setSlashMenuOpen(false);
        showToast('未找到该技能，请在设置 → 技能 中确认名称与启用状态');
        return { status: 'handled' };
      }
      modelText = formatSkillInjection(resolved.skill, resolved.rest);
      displayText = resolved.rest
        ? `/skill:${resolved.skill.name} ${resolved.rest}`
        : `使用技能：${resolved.skill.name}`;
      // 技能上下文可见卡片（WYSIWYG：卡片正文 = wire 注入文本，单一来源）
      contextInjectionDispatcher.inject(activeSessionId || '', {
        kind: 'skill',
        title: `🛠️ 技能上下文：${resolved.skill.name}`,
        summary: resolved.skill.description || undefined,
        status: 'active',
        source: 'slash_command',
        content: modelText,
        tokenEstimate: estimateTextTokens(modelText),
        metadata: { skillId: resolved.skill.id, scope: resolved.skill.scope },
      });
    } catch (e) {
      setChatInput('');
      setSlashMenuOpen(false);
      showToast(
        `加载技能失败：${e instanceof Error ? e.message : String(e)}`
      );
      return { status: 'handled' };
    }
  }

  if (slash.kind === 'learn') {
    setChatInput('');
    setSlashMenuOpen(false);
    const ruleText = slash.rule;
    if (!ruleText) {
      showToast('用法：/learn <要记住的规则>');
      return { status: 'handled' };
    }
    try {
      const cwd = getWorkspacePath() || '__global__';
      const sets = await clientApi.getSettingsEx(cwd);
      const prev = Array.isArray(sets.customRules) ? sets.customRules : [];
      if (prev.includes(ruleText)) {
        showToast('该规则已存在');
        return { status: 'handled' };
      }
      const next = [...prev, ruleText];
      await clientApi.saveSettingsEx(cwd, 'global', { customRules: next });
      const { rulesLinesToText, syncRulesToDaemon } =
        await import('../../api/rulesApi');
      void syncRulesToDaemon({
        globalText: rulesLinesToText(next, '# 全局规则'),
      });

      showToast(`已成功记住规则：${ruleText}`);
    } catch (e) {
      showToast(
        `记住规则失败：${e instanceof Error ? e.message : String(e)}`
      );
    }
    return { status: 'handled' };
  }

  if (slash.kind === 'compact') {
    setChatInput('');
    setSlashMenuOpen(false);
    if (slash.invalidArg) {
      showToast('用法：/compact [目标 token 数]（正整数）');
      return { status: 'handled' };
    }
    const compactSid = resolveTargetSessionId(activeSessionId);
    if (!compactSid) {
      showToast('会话不可用，请新建会话后重试');
      return { status: 'handled' };
    }
    try {
      const res = await invokeTyped<{
        tokensBefore: number;
        tokensAfter: number;
        dropped: number;
        summaryState: string;
      }>('core_compact_now', {
        sessionId: compactSid,
        targetTokens: slash.tokens ?? null,
      });
      if (res.status === 'ok') {
        const fmt = (n: number) => n.toLocaleString();
        const stateLabel =
          res.data.summaryState === 'committed'
            ? '摘要已生成'
            : '摘要后台生成中';
        showToast(
          `压缩完成：${fmt(res.data.tokensBefore)} → ${fmt(res.data.tokensAfter)} token（丢弃 ${res.data.dropped} 条，${stateLabel}）`
        );
      } else if (res.status === 'missing') {
        showToast('压缩命令未接线（引擎未注册 core_compact_now）');
      } else {
        showToast(res.message || '压缩失败');
      }
    } catch (e) {
      showToast(`压缩失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return { status: 'handled' };
  }

  return { status: 'proceed', slash, modelText, displayText };
}

export interface AssembleChatPayloadOptions {
  sessionId: string;
  rawInput: string;
  slash: ReturnType<typeof resolveSlashCommand>;
  modelText: string;
  displayText: string;
  attachments: ChatAttachment[];
  onClearGoalCancelled?: () => void;
}

/**
 * 组装多模态/批注/目标模式 Payload
 */
export function assembleChatPayload(opts: AssembleChatPayloadOptions): {
  input: string;
  displayText: string;
  finalStreamOptions: StreamRequestOptions | undefined;
} {
  let { modelText, displayText } = opts;
  const { sessionId, rawInput, slash, attachments, onClearGoalCancelled } =
    opts;

  if (slash.kind === 'goal') {
    const goalText = slash.goal;
    onClearGoalCancelled?.();
    const gm = createInitialGoalMode(goalText, GOAL_DEFAULT_MAX_ITERATIONS);
    patchSession(sessionId, { goalMode: gm });
    displayText = `/goal ${goalText}`;
    const directive = buildGoalModePrefix(
      goalText,
      0,
      gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS,
      gm.tasks
    );
    // 首次进入目标模式：派发可见目标卡片（后续轮次经 goalModeContinuation
    // 续期 wire 前缀，不重复派卡刷屏）
    const goalCard = `[系统上下文注入 · 目标推进模式]\n\n${directive}`;
    contextInjectionDispatcher.inject(sessionId, {
      kind: 'runtime_steering',
      title: '🎯 目标推进模式 (Goal Mode)',
      summary: goalText,
      status: 'active',
      source: 'slash_command',
      content: goalCard,
      tokenEstimate: estimateTextTokens(goalCard),
      metadata: {
        mode: 'goal',
        iteration: 0,
        maxIterations: gm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS,
      },
    });
    modelText = `${directive}${goalText}`;
  }

  if (slash.kind === 'grill-me') {
    setPermissionMode('plan');
    displayText = `/grill-me ${slash.topic}`;
    // 需求对齐模式可见卡片（WYSIWYG：卡片正文 = wire 注入文本，单一来源；
    // GRILL_ME_PREFIX 隐式前缀已清退——slash-prefixes.ts 物理删除）
    const alignmentCard = `[系统上下文注入 · 需求对齐模式]\n\n${GRILL_ME_PROMPT.render({ topic: slash.topic })}`;
    contextInjectionDispatcher.inject(sessionId, {
      kind: 'runtime_steering',
      title: '🤝 需求对齐模式 (Grill-Me)',
      summary: slash.topic,
      status: 'active',
      source: 'slash_command',
      content: alignmentCard,
      tokenEstimate: estimateTextTokens(alignmentCard),
      metadata: { mode: 'grill-me', permissionMode: 'plan' },
    });
    modelText = alignmentCard;
  }

  if (rawInput && slash.kind !== 'goal') {
    const liveGm = getSessionById(sessionId)?.goalMode;
    if (liveGm?.active && liveGm.goal) {
      const maxIter = liveGm.maxIterations ?? GOAL_DEFAULT_MAX_ITERATIONS;
      modelText = `${buildGoalModePrefix(liveGm.goal, liveGm.iteration ?? 0, maxIter, liveGm.tasks)}${modelText}`;
    }
  }

  const { promptAttachBlock, streamOptions } = buildMultimodalFromAttachments(
    modelText,
    attachments
  );
  // 批注按当前会话取走（会话隔离暂存池，详案 02 §3.2——跨会话串扰根除）
  const fileAnns = takePendingFileAnnotations(sessionId);
  const annBlock = formatAnnotationsForModel(fileAnns);
  const input =
    (annBlock ? `${annBlock}\n\n` : '') + modelText + promptAttachBlock;

  // 附件可见卡片（被动直接注入）：图片/文本附件以 file_context 卡片进入
  // 时间线（所见即所知），wire 仍走既有 content parts / promptAttachBlock
  for (const a of attachments) {
    const isImage = Boolean(a.dataUrl);
    const content = isImage
      ? `[图片附件 · ${a.name}]\n已通过结构化 image_url 部分下发视觉分析。`
      : `[文件附件 · ${a.name}]\n${a.text ? a.text.slice(0, 800) : ''}`;
    contextInjectionDispatcher.inject(sessionId, {
      kind: 'file_context',
      title: `${isImage ? '🖼️' : '📎'} 附件：${a.name}`,
      summary: isImage ? '图片（结构化下发）' : (a.text || '').slice(0, 80),
      status: 'injected',
      source: 'user_mention',
      content,
      tokenEstimate: estimateTextTokens(content),
      targetPaths: [a.name],
      metadata: isImage ? { kind: 'image' } : { kind: 'text-attachment' },
    });
  }

  let finalStreamOptions = streamOptions;
  if (finalStreamOptions?.content?.length && annBlock) {
    const parts = [...finalStreamOptions.content];
    const firstText = parts.findIndex(
      (p: ChatContentPart) => p.type === 'text'
    );
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

  return { input, displayText, finalStreamOptions };
}
