/**
 * apps/crish-desktop/src/hooks/chat-stream/slashSendPreflight.ts
 * 负责发送前置校验、本地斜杠命令路由与多模态 Payload 组装（单一职责叶）
 */
import { checkEngineReadyRealtime } from '../../api/chat-bridge/ConnectionLifecycle';
import { domainUserMessage } from '../../api/userFacingErrors';
import {
  addMessage,
  openSettings,
  patchSession,
  setPermissionMode,
} from '../../api/storeAccess';
import {
  resolveSlashCommand,
  isNavigationSlash,
  slashMissingArg,
} from '../../api/resolveSlashCommand';
import { emitUiEvent } from '../../api/uiEvents';
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
import { GRILL_ME_PREFIX } from './slash-prefixes';
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
    if (slash.kind === 'schedule') {
      emitUiEvent('open-scheduled');
    } else if (slash.kind === 'teamwork-preview') {
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
    modelText,
    attachments
  );
  const fileAnns = takePendingFileAnnotations();
  const annBlock = formatAnnotationsForModel(fileAnns);
  const input =
    (annBlock ? `${annBlock}\n\n` : '') + modelText + promptAttachBlock;

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

  if (fileAnns.length) {
    displayText = displayText
      ? `${displayText}\n\n（含 ${fileAnns.length} 条文件批注）`
      : `（${fileAnns.length} 条文件批注）`;
  }
  if (attachments.length > 0) {
    displayText = `${displayText}${displayText ? '\n\n' : ''}📎 ${attachments.map((a: ChatAttachment) => a.name).join('、')}`;
  }

  return { input, displayText, finalStreamOptions };
}
