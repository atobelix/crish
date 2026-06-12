/**
 * ApprovalDeck - 批量审批面板
 *
 * 展示待审批的工具调用队列，支持单次/项目级/始终允许以及拒绝操作。
 * 高风险操作需要二次确认。
 */

import { useState, useEffect } from 'preact/hooks';
import type { ToolCall } from '../../core/app-state';
import { appState } from '../../core/app-state';
import { tauriBridge } from '../../core/tauri-bridge';
import { approvalRiskLabel, approvalRiskTitle } from './ToolCallCard';

export function ToolApprovalDeck() {
  const [approvalQueue, setApprovalQueue] = useState<ToolCall[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<{ id: string; scope: 'project' | 'always' } | null>(null);

  useEffect(() => {
    const unsubscribe = appState.subscribe('approvalQueue', (queue) => setApprovalQueue([...queue]));
    setApprovalQueue([...appState.getState().approvalQueue]);
    return unsubscribe;
  }, []);

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
      console.error('批准失败:', error);
    }
  };

  const handleDeny = async (toolCallId: string) => {
    try {
      const tool = approvalQueue.find(t => t.id === toolCallId);
      await tauriBridge.denyToolCall(toolCallId, { runId: tool?.runId, sessionId: tool?.sessionId });
      appState.resolveApproval(toolCallId, 'denied', 'once');
    } catch (error) {
      console.error('拒绝失败:', error);
    }
  };

  if (approvalQueue.length === 0) return null;

  const pendingTool = approvalQueue[0]!;
  const pendingRiskLabel = approvalRiskLabel(pendingTool.riskLevel);
  const pendingRiskTitle = approvalRiskTitle(pendingTool);

  return (
    <div class="repl-chat-tool-approval-deck" id="tool-approval-deck">
      <div class="repl-chat-tool-deck-header">
        <div class="repl-chat-tool-deck-status">
          <span class="repl-deck-status-dot warn-amber" />
          <span class="repl-deck-status-text">系统工具运行请求</span>
          {approvalQueue.length > 1 && <span class="repl-deck-queue-count">({approvalQueue.length} 个待审批)</span>}
        </div>
        <div class="repl-chat-tool-deck-meta" id="tool-deck-meta">工具: {pendingTool.name}</div>
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