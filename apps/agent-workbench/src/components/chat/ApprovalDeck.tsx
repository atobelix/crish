/**
 * ApprovalDeck - 批量审批面板
 *
 * 展示待审批的工具调用队列，支持单次/项目级/始终允许以及拒绝操作。
 * 高风险操作需要二次确认。
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import type { ToolCall } from '../../core/app-state';
import { appState } from '../../core/app-state';
import { tauriBridge } from '../../core/tauri-bridge';
import { approvalRiskLabel, approvalRiskTitle } from './ToolCallCard';
import { showToast } from '../ToastContainer';

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 60;

export function ToolApprovalDeck() {
  const [approvalQueue, setApprovalQueue] = useState<ToolCall[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{ id: string; scope: 'project' | 'always' } | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number>(DEFAULT_APPROVAL_TIMEOUT_SECONDS);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = appState.subscribe('approvalQueue', (queue) => setApprovalQueue([...queue]));
    setApprovalQueue([...appState.getState().approvalQueue]);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (approvalQueue.length === 0) return;
    setTimeRemaining(DEFAULT_APPROVAL_TIMEOUT_SECONDS);
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    timerRef.current = window.setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          if (timerRef.current) {
            window.clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [approvalQueue.length > 0 ? approvalQueue[0]!.id : null]);

  useEffect(() => {
    if (timeRemaining === 0 && approvalQueue.length > 0) {
      const tool = approvalQueue[0];
      if (tool) {
        showToast('审批超时，已自动拒绝', 'warning', 4000);
        handleDeny(tool.id);
      }
    }
  }, [timeRemaining]);

  const handleApprove = async (toolCallId: string, scope: 'project' | 'always' = 'project') => {
    const tool = approvalQueue.find(t => t.id === toolCallId);
    if (tool?.requiresDoubleConfirm && !(pendingConfirm && pendingConfirm.id === toolCallId && pendingConfirm.scope === scope)) {
      setPendingConfirm({ id: toolCallId, scope });
      return;
    }
    setPendingConfirm(null);
    try {
      await tauriBridge.approveToolCall(toolCallId, scope, { runId: tool?.runId, sessionId: tool?.sessionId });
      appState.resolveApproval(toolCallId, 'approved', scope === 'always' ? 'always' : 'project');
      if (scope === 'always' && tool) {
        appState.addMessage({ role: 'assistant', content: `[权限] 已将 ${tool.name} 添加到始终允许列表` }, tool.sessionId);
      }
    } catch (error) {
      showToast('批准失败', 'error', 4500);
    }
  };

  const handleDeny = async (toolCallId: string) => {
    try {
      const tool = approvalQueue.find(t => t.id === toolCallId);
      await tauriBridge.denyToolCall(toolCallId, { runId: tool?.runId, sessionId: tool?.sessionId });
      appState.resolveApproval(toolCallId, 'denied', 'once');
    } catch (error) {
      showToast('拒绝失败', 'error', 4500);
    }
  };

  if (approvalQueue.length === 0) return null;

  const pendingTool = approvalQueue[0]!;
  const pendingRiskLabel = approvalRiskLabel(pendingTool.riskLevel);
  const pendingRiskTitle = approvalRiskTitle(pendingTool);
  const timerProgress = timeRemaining / DEFAULT_APPROVAL_TIMEOUT_SECONDS;
  const timerUrgency = timerProgress > 0.5 ? 'normal' : timerProgress > 0.16 ? 'warning' : 'critical';

  return (
    <div class="repl-chat-tool-approval-deck" id="tool-approval-deck">
      <div class="repl-chat-tool-deck-timer" role="timer" aria-label={`审批剩余时间 ${timeRemaining} 秒`}>
        <div
          class={`repl-chat-tool-deck-timer-bar ${timerUrgency}`}
          style={{ width: `${timerProgress * 100}%` }}
        />
      </div>
      <div class="repl-chat-tool-deck-header">
        <div class="repl-chat-tool-deck-status">
          <span class="repl-deck-status-dot warn-amber" />
          <span class="repl-deck-status-text">系统工具运行请求</span>
          {approvalQueue.length > 1 && <span class="repl-deck-queue-count">({approvalQueue.length} 个待审批)</span>}
        </div>
        <div class="repl-chat-tool-deck-meta" id="tool-deck-meta">工具: {pendingTool.name}</div>
        <span class={`repl-deck-timer-badge ${timerUrgency}`}>{timeRemaining}s</span>
        {pendingTool.riskLevel && (
          <div class={`repl-deck-risk-badge ${pendingTool.riskLevel}`} title={pendingRiskTitle}>
            {pendingRiskLabel}
            {pendingTool.riskRule && <span class="repl-deck-risk-rule"> - {pendingTool.riskRule}</span>}
          </div>
        )}
        {pendingTool.riskSource === 'unknown' && <div class="repl-deck-risk-diagnostic">后端未提供风险元数据</div>}
      </div>
      <div class="repl-chat-tool-deck-body">
        {pendingTool.input && typeof pendingTool.input === 'string' && pendingTool.input.includes('\n\n') && (
          <div class="repl-chat-tool-deck-summary">{pendingTool.input.split('\n\n')[0]}</div>
        )}
        <div class="repl-chat-tool-deck-code-pane" id="tool-deck-code-view">
          <pre><code id="tool-deck-command">{typeof pendingTool.input === 'string' ? pendingTool.input : JSON.stringify(pendingTool.input, null, 2)}</code></pre>
        </div>
      </div>
      <div class="repl-chat-tool-deck-actions">
        {pendingConfirm && pendingConfirm.id === pendingTool.id ? (
          <>
            <span class="repl-chat-tool-deck-meta">确认{pendingConfirm.scope === 'always' ? '始终允许' : '在项目中允许'}此操作？</span>
            <button class="repl-deck-btn btn-modify" onClick={() => setPendingConfirm(null)}><span>取消</span></button>
            <button class="repl-deck-btn btn-approve" onClick={() => handleApprove(pendingTool.id, pendingConfirm.scope)}><span>确认允许</span></button>
          </>
        ) : (
          <>
            <button class="repl-deck-btn btn-deny" onClick={() => handleDeny(pendingTool.id)}><span>拒绝</span></button>
            <button class="repl-deck-btn btn-approve" onClick={() => handleApprove(pendingTool.id, 'project')}><span>在项目中允许</span></button>
            <button class="repl-deck-btn btn-modify" onClick={() => handleApprove(pendingTool.id, 'always')}><span>始终允许</span></button>
          </>
        )}
      </div>
    </div>
  );
}