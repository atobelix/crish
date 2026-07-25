import React, { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import styles from '../ChatCard.module.css';
import type { FileDiff } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import { addMessage, archiveSession, branchSession, enterDraftMode, getSessionStoreState, openSettings, patchSession, setActiveDiffSource as setActiveDiffSourceAccess, setActiveSessionId, setSessionMessageStatus } from '../../api/storeAccess';
import { formatBranchUndoToast } from '../../hooks/useToastQueue';
import { isDemoMode } from '../../api/appMode';
import { fetchEngineStatus, type EngineStatus } from '../../api/engineConfig';
import { anyProfileHasKey, getActiveModelId, getActiveProfileId, getProviderSetupStatus, resolveDisplayModelId, resolvePreferredModelSelection } from '../../api/providerProfiles';
import { ChatMessageList } from '../ChatMessageList';
import { ChatEmptyState } from '../ChatEmptyState';
import { ChatComposer } from '../ChatComposer';
import { ChatStatusRibbons } from '../ChatStatusRibbons';
import { ChatMsgFilterBar } from '../ChatMsgFilterBar';
import { useChatStream, type ChatAttachment } from '../../hooks/useChatStream';
import { useChatAutoScroll } from '../../hooks/useChatAutoScroll';
import { useThinkingTimer } from '../../hooks/useThinkingTimer';
import { onUiEvent } from '../../api/uiEvents';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { isPendingDraft } from '../../store/draftSession';
import { isFirstRunOverlayOpen } from '../FirstRunWizard';
import { resolveChatEmptyKind, chatEmptyKindAriaLabel } from '../../api/chatEmptyState';
import { openFileInPanel } from '../../api/workspaceFsApi';
import { useChatCardSelectors } from './hooks/useChatCardSelectors';
import { useChatApproval } from './hooks/useChatApproval';
import { useChatComposerProps } from './hooks/useChatComposerProps';
import { ChatHeader } from './ChatHeader';

const ChatDemoChrome = lazy(() => import('../ChatDemoChrome').then((m) => ({ default: m.ChatDemoChrome })));
const ScheduledTasksPanel = lazy(() => import('../ScheduledTasksPanel').then((m) => ({ default: m.ScheduledTasksPanel })));

interface ChatCardProps {
  wsId: string; colIdx: number; groupIdx: number;
  onShowToast: (message: string) => void;
  handleGlobalTabClick: (cardId: string) => void;
}

export const ChatCard: React.FC<ChatCardProps> = React.memo(({ wsId, onShowToast, handleGlobalTabClick }) => {
  const { activeSessionId, messages, agents, goalMode, hydratedFromEngine, engineCursor, engineLastRunId, activeSessionTitle, withdrawMessage, appSettings, diffFiles, permissionMode, setPermissionMode, planApproved, setPlanApproved, inPlanMode, mainSurface, setMainSurface, setComposerDraft, composerDrafts } = useChatCardSelectors();
  const [engineHint, setEngineHint] = useState<EngineStatus | null>(null);
  const [engineModel, setEngineModel] = useState('');
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const { chatInput, setChatInput, isComposing, setIsComposing, slashMenuOpen, setSlashMenuOpen, slashSelectedIndex, setSlashSelectedIndex, attachments, setAttachments, fileInputRef, canSend, handlePasteImage, addAttachments, modelSelectorRef, showModelDropdown, setShowModelDropdown, showPlusMenu, setShowPlusMenu, pickerInlineError, setPickerInlineError, localMsgFilter, setLocalMsgFilter, showMsgFilter, setShowMsgFilter, msgFilterInputRef, projectTick, setProjectTick, showProjectPicker, setShowProjectPicker, filteredCommands, loadSkillSlash, skillCommandsEnabled } = useChatComposerProps(activeSessionId, setComposerDraft, composerDrafts);
  const { approvalBusy, pendingApprovalMsgId, pendingApprovalToolId, approvalUiPlan, pendingApprovalCount, pendingApprovalSummary, approvalDockVisible, pendingApprovalDockLabel, handleApprovalAllow, handleApprovalDeny, handleBatchApprove, handleBatchDeny } = useChatApproval(activeSessionId, messages, agents, onShowToast);

  const applyResolvedModelLabel = (engineHintModel?: string | null) => {
    const resolved = resolvePreferredModelSelection({ engineModel: engineHintModel });
    if (resolved) { setEngineModel(resolved.model); setActiveProfileId(resolved.profileId); return; }
    const settingsDefault = (appSettings?.defaultModel || '').trim();
    const localActive = (getActiveModelId() || '').trim();
    const display = resolveDisplayModelId(engineHintModel) || localActive || settingsDefault || '';
    setEngineModel(display); setActiveProfileId(getActiveProfileId());
  };
  useEffect(() => { void fetchEngineStatus().then((s) => { setEngineHint(s); applyResolvedModelLabel(s.model); }); }, [projectTick, appSettings?.defaultModel]);
  useEffect(() => { return onUiEvent('model-changed', (d) => { if (d?.model) setEngineModel(d.model); if (d?.profileId) setActiveProfileId(d.profileId); void fetchEngineStatus().then(setEngineHint); }); }, []);

  const setupStatus = getProviderSetupStatus({ engineOk: engineHint?.ok, engineHasApiKey: engineHint?.hasApiKey, engineModel: engineHint?.model ?? engineModel });
  const needsKeySetup = setupStatus.needsKeySetup;
  const needsModelSetup = setupStatus.needsModelSetup;
  const showModelPicker = setupStatus.showModelPicker;
  const engineOk: boolean | null = engineHint == null ? null : engineHint.ok;
  const goalModeActive = Boolean(goalMode?.active);
  const { runNotice, setRunNotice, runStreamingAssistant, handleSendChat, handleStopGeneration } = useChatStream({ wsId, onShowToast, handleGlobalTabClick, chatInput, setChatInput, setSlashMenuOpen, attachments, setAttachments, skillCommandsEnabled, needsKeySetup, needsModelSetup, setPickerInlineError, onOpenModelPicker: () => setShowModelDropdown(true) });

  useEffect(() => { if (pickerInlineError) { onShowToast(pickerInlineError); setPickerInlineError(''); } }, [pickerInlineError, onShowToast]);
  useEffect(() => { return onUiEvent('stop-generation', () => { handleStopGeneration(); }); }, [handleStopGeneration]);

  const handleExportMarkdown = useCallback(() => {
    const session = getSessionStoreState().sessionsById[activeSessionId ?? ''];
    if (!session) return;
    void (async () => {
      try { const { tryDownloadSessionMarkdown } = await import('../../api/sessionExport'); const r = tryDownloadSessionMarkdown(session, new Date(), { sessionsById: getSessionStoreState().sessionsById }); if (r.ok === false) onShowToast(r.error || '导出失败'); } catch { onShowToast('导出失败'); }
    })();
  }, [activeSessionId, onShowToast]);
  useEffect(() => { return onUiEvent('export-session-md', () => { handleExportMarkdown(); }); }, [handleExportMarkdown]);
  // TODO: implement checkpoint/rollback functionality (stub ChatCheckpointActions removed)
  useEffect(() => {
    return onUiEvent('open-conversation-rewind', () => {
      void (async () => {
        const sid = activeSessionId;
        if (!sid || sid.startsWith('__pending')) { onShowToast('当前无可用会话，无法回溯'); return; }
        try {
          const { previewConversationRewind } = await import('../../api/conversationRewindApi');
          const preview = await previewConversationRewind({ sessionId: sid });
          if (!preview.ok) { onShowToast(preview.error ? `回溯预览失败：${preview.error}` : '回溯预览失败：引擎未返回边界事实'); return; }
          onShowToast('已收到回溯预览。确认应用请使用引擎 apply-conversation-rewind');
        } catch (e) { onShowToast(`回溯不可用：${e instanceof Error ? e.message : String(e)}`); }
      })();
    });
  }, [activeSessionId, onShowToast]);

  const isProcessing = messages.some((m) => m.status === 'processing');
  const { chatFlowRef, showScrollToBottom, scrollToBottom } = useChatAutoScroll(messages, isProcessing);
  const thinkingSeconds = useThinkingTimer(isProcessing);
  const openSidePanel = (panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files') => { handleGlobalTabClick(panelId); };
  const openDiffInRightPanel = useCallback((diff: FileDiff) => { setActiveDiffSourceAccess(diff); handleGlobalTabClick('diff'); }, [handleGlobalTabClick]);
  const openPathInFilesPanel = useCallback((filePath: string) => { openSidePanel('files'); openFileInPanel(filePath); }, []);
  const displayMessages = useMemo(() => { const q = localMsgFilter.trim(); if (!q) return messages; return messages.filter((m) => messageMatchesSearch(m, q)); }, [messages, localMsgFilter]);
  const isFiltering = Boolean(localMsgFilter.trim());
  const firstRunOpen = !isDemoMode() && isFirstRunOverlayOpen();
  const messagesLoadingCandidate = useMemo(() => {
    if (isDemoMode()) return false; if (!activeSessionId) return false; if (messages.length > 0) return false;
    if (hydratedFromEngine === true) return false; const isLocalMintId = /^sess-(branch-)?\d+$/i.test(activeSessionId);
    if (isLocalMintId && typeof engineCursor !== 'number' && !engineLastRunId) return false; return true;
  }, [activeSessionId, messages.length, hydratedFromEngine, engineCursor, engineLastRunId]);
  const [hydrateTimedOut, setHydrateTimedOut] = useState(false);
  useEffect(() => { if (!messagesLoadingCandidate) { setHydrateTimedOut(false); return; } setHydrateTimedOut(false); const t = window.setTimeout(() => setHydrateTimedOut(true), 3000); return () => window.clearTimeout(t); }, [activeSessionId, messagesLoadingCandidate]);
  const messagesLoading = messagesLoadingCandidate && !hydrateTimedOut;
  const emptyKind = resolveChatEmptyKind({ hasActiveSession: Boolean(activeSessionId) && !isPendingDraft(activeSessionId), messageCount: messages.length, displayCount: displayMessages.length, filterQuery: localMsgFilter, mainSurface, messagesLoading });
  const onEmptySurface = emptyKind != null;
  const chatRegionAria = mainSurface === 'scheduled' ? '定时任务' : emptyKind ? chatEmptyKindAriaLabel(emptyKind) : messagesLoading ? '正在加载会话消息' : '对话主区';
  const handleCreateSessionFromEmpty = useCallback(() => { enterDraftMode(); }, []);

  const prevActiveSessionRef = React.useRef(activeSessionId);
  useEffect(() => { if (prevActiveSessionRef.current !== activeSessionId) { prevActiveSessionRef.current = activeSessionId; setMainSurface('chat'); } }, [activeSessionId, setMainSurface]);

  const composerElement = (
    <ChatComposer chatInput={chatInput} setChatInput={setChatInput} isComposing={isComposing} setIsComposing={setIsComposing}
      slashMenuOpen={slashMenuOpen} setSlashMenuOpen={setSlashMenuOpen} slashSelectedIndex={slashSelectedIndex} setSlashSelectedIndex={setSlashSelectedIndex}
      filteredCommands={filteredCommands} loadSkillSlash={loadSkillSlash} onPasteImage={handlePasteImage}
      onSend={() => { void handleSendChat(false); }} onStop={handleStopGeneration} canSend={canSend} isProcessing={isProcessing}
      attachments={attachments} setAttachments={setAttachments} fileInputRef={fileInputRef}
      onFilesSelected={async (files) => {
        const next: ChatAttachment[] = []; let b: ((blob: Blob, n?: string) => Promise<ChatAttachment>) | null = null;
        for (const f of files) {
          if (f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name)) {
            try { if (!b) ({ blobToImageAttachment: b } = await import('../../api/imageProcessing')); next.push(await b(f, f.name)); } catch { next.push({ name: f.name, mime: f.type || undefined }); }
          } else if ((f.type.startsWith('text/') || /\.(txt|md|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|yml|yaml|toml|xml|csv|log|sh|ps1)$/i.test(f.name)) && f.size < 512_000) {
            try { next.push({ name: f.name, text: await f.text() }); } catch { next.push({ name: f.name }); }
          } else { next.push({ name: f.name }); }
        }
        addAttachments(next);
      }}
      showPlusMenu={showPlusMenu} setShowPlusMenu={setShowPlusMenu} permissionMode={permissionMode}
      onPermissionChange={(m) => { setPermissionMode(m); }} onOpenSchedule={() => { setMainSurface('scheduled'); }} onCloseSiblingMenus={() => setShowPlusMenu(false)}
      rightActions={<ChatHeader engineModel={engineModel} needsModelSetup={needsModelSetup} showModelPicker={showModelPicker}
        showModelDropdown={showModelDropdown} onToggleModelDropdown={() => setShowModelDropdown((v) => !v)} onCloseModelDropdown={() => setShowModelDropdown(false)} modelSelectorRef={modelSelectorRef} />}
    />
  );

  return (
    <div className={styles.chatBody} role="region" aria-label={chatRegionAria} aria-busy={messagesLoading || undefined}
      data-main-surface={mainSurface} data-empty-kind={emptyKind ?? undefined} data-messages-loading={messagesLoading ? 'true' : undefined}
      data-engine-ok={engineOk === false ? 'false' : engineOk === true ? 'true' : 'unknown'} data-approval-mode={approvalUiPlan.mode}>
      {mainSurface === 'chat' && showMsgFilter ? <ChatMsgFilterBar localMsgFilter={localMsgFilter} setLocalMsgFilter={setLocalMsgFilter} setShowMsgFilter={setShowMsgFilter} displayCount={displayMessages.length} totalCount={messages.length} inputRef={msgFilterInputRef} /> : null}
      <div className={styles.chatDocFlow} ref={chatFlowRef} aria-busy={messagesLoading || undefined}>
        {mainSurface === 'scheduled' ? (
          <Suspense fallback={null}><ScheduledTasksPanel onShowToast={onShowToast} onBackToChat={() => setMainSurface('chat')} /></Suspense>
        ) : emptyKind != null ? (
          <ChatEmptyState kind={emptyKind} filterQuery={localMsgFilter} needsKeySetup={needsKeySetup} needsModelSetup={needsModelSetup}
            firstRunOpen={firstRunOpen} engineOk={engineOk} messagesLoading={messagesLoading} showProjectPicker={showProjectPicker}
            onShowProjectPicker={setShowProjectPicker} onProjectChanged={() => setProjectTick((n) => n + 1)} onSetChatInput={setChatInput}
            onCreateSession={handleCreateSessionFromEmpty} onClearFilter={() => setLocalMsgFilter('')}
            composer={emptyKind === 'session-empty' ? React.cloneElement(composerElement, { className: styles.emptyComposer }) : undefined} />
        ) : (
          <ChatMessageList messages={displayMessages} agents={agents} activeSessionId={activeSessionId || ''} thinkingSeconds={thinkingSeconds}
            showAllMessages={isFiltering} showProjectPicker={showProjectPicker} onShowProjectPicker={setShowProjectPicker}
            onProjectChanged={() => setProjectTick((n) => n + 1)} onSetChatInput={setChatInput}
            onSendFollowUp={(p) => { void handleSendChat(false, p); }}
            onWithdraw={(msgId, text) => { handleStopGeneration(); setChatInput(text); withdrawMessage(wsId, activeSessionId, msgId); }}
            onRegenerate={(userText, assistantMsgId) => {
              handleStopGeneration(); withdrawMessage(wsId, activeSessionId, assistantMsgId);
              const msgs = getSessionById(activeSessionId)?.messages || [];
              let userMsgId = msgs.findLast((m) => m.sender === 'user')?.id;
              if (!userMsgId) { userMsgId = `user-msg-${Date.now()}`; addMessage(wsId, activeSessionId, { id: userMsgId, sender: 'user', text: userText, timestamp: Date.now(), status: 'processing' }); }
              else { setSessionMessageStatus(activeSessionId, userMsgId, 'processing'); }
              runStreamingAssistant(userText, userMsgId);
            }}
            onBranch={() => { if (!activeSessionId) return; const oldId = activeSessionId; const base = activeSessionTitle || '会话'; branchSession(activeSessionId, `${base} - 分支`); const newBranchId = getSessionStoreState().activeSessionId; onShowToast(formatBranchUndoToast(base), () => { if (newBranchId && newBranchId !== oldId) archiveSession(newBranchId); setActiveSessionId(oldId); }); }}
            onShowToast={onShowToast} approvalBusy={approvalBusy} pendingApprovalMsgId={pendingApprovalMsgId}
            onOpenDiff={openDiffInRightPanel} onOpenPath={openPathInFilesPanel} onOpenTerminal={() => openSidePanel('terminal')} onOpenDiffPanel={() => openSidePanel('diff')}
            onApprovalAllow={handleApprovalAllow} onApprovalDeny={handleApprovalDeny} onBatchApprove={handleBatchApprove} onBatchDeny={handleBatchDeny} />
        )}
      </div>
      <div className={styles.chatFooter} style={{ display: mainSurface === 'scheduled' ? 'none' : undefined }}>
        <ChatStatusRibbons onOpenTerminal={() => openSidePanel('terminal')} onOpenDiff={() => openSidePanel('diff')} diffCount={diffFiles.length}
          engineHint={engineHint} needsKeySetup={needsKeySetup} needsModelSetup={needsModelSetup} onEmptySurface={onEmptySurface} localHasKey={anyProfileHasKey()}
          onOpenModelSettings={() => openSettings('models')} onOpenModelDropdown={() => setShowModelDropdown(true)} inPlanMode={inPlanMode}
          planApproved={planApproved} onApprovePlan={() => { setPermissionMode('ask'); setPlanApproved(true); }}
          goalModeActive={goalModeActive && Boolean(goalMode)} goalText={goalMode?.goal || ''} goalIteration={goalMode?.iteration ?? 0}
          goalTasksDone={(goalMode?.tasks || []).filter((t) => t.done).length} goalTasksTotal={(goalMode?.tasks || []).length}
          onStopGoal={() => { handleStopGeneration(); if (activeSessionId) patchSession(activeSessionId, { goalMode: null }); }}
          showScrollToBottom={showScrollToBottom} onScrollToBottom={scrollToBottom} runNotice={runNotice} onDismissRunNotice={() => setRunNotice(null)}
          pendingApprovalCount={pendingApprovalCount} showApprovalDock={approvalDockVisible} pendingApprovalSummary={pendingApprovalDockLabel}
          pendingApprovalToolId={pendingApprovalToolId} pendingApprovalMsgId={pendingApprovalMsgId} activeSessionId={activeSessionId}
          onShowToast={onShowToast} between={isDemoMode() ? <Suspense fallback={null}><ChatDemoChrome handleGlobalTabClick={handleGlobalTabClick} /></Suspense> : null} />
        {emptyKind !== 'session-empty' && composerElement}
      </div>
    </div>
  );
});

ChatCard.displayName = 'ChatCard';
