import { useState, useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { appState } from '../../core/app-state';
import { tauriBridge } from '../../core/tauri-bridge';
import { IconShield, IconSpinner } from '../icons';
import { showToast } from '../ToastContainer';

export default function ApprovalsTab() {
  const [approvalQueue, setApprovalQueue] = useState(appState.getState().approvalQueue);
  const [approvalHistory, setApprovalHistory] = useState(appState.getState().approvalHistory);
  const [subTab, setSubTab] = useState<'pending' | 'history'>('pending');
  const [confirm, setConfirm] = useState<{ id: string; scope?: 'once' | 'project' | 'always' } | null>(null);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'approved' | 'denied'>('all');


  useEffect(() => {
    const u1 = appState.subscribe('approvalQueue', setApprovalQueue);
    const u2 = appState.subscribe('approvalHistory', setApprovalHistory);
    return () => { u1(); u2(); };
  }, []);

  async function handleApprove(toolCallId: string, scope?: 'once' | 'project' | 'always') {
    const tc = approvalQueue.find(t => t.id === toolCallId);
    if (tc?.requiresDoubleConfirm && !(confirm && confirm.id === toolCallId && confirm.scope === scope)) {
      setConfirm({ id: toolCallId, scope });
      return;
    }
    setConfirm(null);
    try {
      await tauriBridge.approveToolCall(toolCallId, scope === 'project' ? 'project' : scope === 'always' ? 'always' : undefined);
    } catch (error) {
      showToast('审批失败', 'error', 4500);
    }
  }

  async function handleDeny(toolCallId: string) {
    try {
      await tauriBridge.denyToolCall(toolCallId);
    } catch (error) {
      showToast('拒绝失败', 'error', 4500);
    }
  }

  const riskLevelLabel = (level?: string) => {
    const map: Record<string, string> = {
      low: '低风险', medium: '中风险', high: '高风险', critical: '严重', unknown: '未知风险',
    };
    return map[level ?? ''] ?? level ?? '未知风险';
  };

  const riskLevelClass = (level?: string) => {
    const map: Record<string, string> = {
      low: 'low', medium: 'medium', high: 'high', critical: 'critical', unknown: 'unknown',
    };
    return map[level ?? ''] ?? 'unknown';
  };

  return (
    <div class="repl-rs-tab-content-inner">
      <div class="repl-rs-sub-tabs">
        <button class={`repl-rs-sub-tab ${subTab === 'pending' ? 'active' : ''}`} onClick={() => setSubTab('pending')}>
          待审批
          {approvalQueue.length > 0 && <span class="repl-rs-badge">{approvalQueue.length}</span>}
        </button>
        <button class={`repl-rs-sub-tab ${subTab === 'history' ? 'active' : ''}`} onClick={() => setSubTab('history')}>
          历史
        </button>
      </div>

      {subTab === 'pending' && (
        <div class="repl-rs-section">
          {approvalQueue.length === 0 ? (
            <div class="repl-rs-empty-center">
              <span class="repl-rs-item-icon"><IconShield /></span>
              <span class="repl-rs-item-meta">无待审批操作</span>
            </div>
          ) : (
            <div class="repl-rs-approval-list">
              {approvalQueue.map(tc => (
                <div key={tc.id} class={`repl-rs-approval-card ${riskLevelClass(tc.riskLevel)}`}>
                  <div class="repl-rs-approval-header">
                    <span class="repl-rs-approval-tool-name">{tc.name}</span>
                    {tc.riskLevel && (
                      <span class={`repl-rs-risk-badge ${riskLevelClass(tc.riskLevel)}`}>
                        {riskLevelLabel(tc.riskLevel)}
                      </span>
                    )}
                  </div>
                  {tc.riskRule && <div class="repl-rs-approval-rule">规则: {tc.riskRule}</div>}
                  {tc.riskDetail && <div class="repl-rs-approval-detail">{tc.riskDetail}</div>}
                  {tc.riskSource === 'unknown' && !tc.riskDetail && (
                    <div class="repl-rs-approval-detail">后端未提供风险元数据</div>
                  )}
                  <div class="repl-rs-approval-input">
                    <pre class="repl-rs-approval-input-pre">{typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2)}</pre>
                  </div>
                  <div class="repl-rs-approval-actions">
                    {confirm && confirm.id === tc.id ? (
                      <>
                        <span class="repl-rs-item-meta">确认{confirm.scope === 'project' ? '项目内允许' : '允许一次'}此高风险操作？</span>
                        <button class="repl-rs-btn-sm" onClick={() => setConfirm(null)}>取消</button>
                        <button class="repl-rs-btn-sm primary" onClick={() => void handleApprove(tc.id, confirm.scope)}>确认允许</button>
                      </>
                    ) : (
                      <>
                        <button class="repl-rs-btn-sm primary" onClick={() => void handleApprove(tc.id, 'once')}>允许一次</button>
                        <button class="repl-rs-btn-sm" onClick={() => void handleApprove(tc.id, 'project')}>项目内允许</button>
                        <button class="repl-rs-btn-sm danger" onClick={() => void handleDeny(tc.id)}>拒绝</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {subTab === 'history' && (
        <div class="repl-rs-section">
          <div class="repl-rs-sub-tabs">
            <button class={`repl-rs-sub-tab ${historyFilter === 'all' ? 'active' : ''}`} onClick={() => setHistoryFilter('all')}>全部</button>
            <button class={`repl-rs-sub-tab ${historyFilter === 'approved' ? 'active' : ''}`} onClick={() => setHistoryFilter('approved')}>已允许</button>
            <button class={`repl-rs-sub-tab ${historyFilter === 'denied' ? 'active' : ''}`} onClick={() => setHistoryFilter('denied')}>已拒绝</button>
          </div>
          {(() => {
            const visible = approvalHistory.filter(r => historyFilter === 'all' || r.decision === historyFilter);
            if (visible.length === 0) {
              return (
                <div class="repl-rs-empty-inline">
                  <span class="repl-rs-item-meta">{approvalHistory.length === 0 ? '暂无审批记录' : '无匹配记录'}</span>
                </div>
              );
            }
            return (
              <div class="repl-rs-approval-history">
                {visible.map(record => (
                  <div key={record.id} class={`repl-rs-approval-history-item ${record.decision}`}>
                    <span class={`repl-rs-approval-decision ${record.decision}`}>
                      {record.decision === 'approved' ? '已允许' : '已拒绝'}
                    </span>
                    <span class="repl-rs-approval-tool">{record.toolName}</span>
                    {record.riskLevel && (
                      <span class={`repl-rs-risk-badge ${riskLevelClass(record.riskLevel)}`}>
                        {riskLevelLabel(record.riskLevel)}
                      </span>
                    )}
                    {record.rule && <span class="repl-rs-rule-tag">{record.rule}</span>}
                    <span class="repl-rs-approval-time">{new Date(record.decidedAt).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}