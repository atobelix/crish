/**
 * 右侧默认总览：计划、改动文件、Agent、上下文摘要（可折叠，长任务友好）
 */
import React, { useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';

type Props = {
  wsId: string;
  onOpenPanel: (id: string) => void;
  onShowToast?: (msg: string) => void;
};

export const OverviewCard: React.FC<Props> = ({ onOpenPanel, onShowToast }) => {
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const [openSec, setOpenSec] = useState({
    plan: true,
    agents: true,
    files: true,
    ctx: true,
  });

  const session = sessions.find((s) => s.id === activeSessionId);
  const agents = session?.agents || [];
  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      const ar = a.status === 'running' ? 0 : 1;
      const br = b.status === 'running' ? 0 : 1;
      if (ar !== br) return ar - br;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
  }, [agents]);

  const files = diffFiles?.length
    ? diffFiles
    : activeDiffSource
      ? [activeDiffSource]
      : [];

  const runningTools =
    session?.messages
      ?.flatMap((m) => m.toolCalls || [])
      .filter((t) => t.status === 'running' || t.status === 'pending_approval') || [];

  const toggle = (k: keyof typeof openSec) =>
    setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div className="overview-card">
      <div className="overview-head">
        <div>
          <div className="overview-title">工作总览</div>
          <div className="overview-sub">
            {session?.title || '当前会话'} · 权限{' '}
            {permissionMode === 'full'
              ? '完全访问'
              : permissionMode === 'plan'
                ? '计划'
                : permissionMode === 'deep'
                  ? '深入分析'
                  : '需确认'}
          </div>
        </div>
      </div>

      <section className="overview-sec">
        <button type="button" className="overview-sec-h" onClick={() => toggle('plan')}>
          <Lucide.ListTodo size={15} strokeWidth={1.75} />
          <span>计划与进度</span>
          <Lucide.ChevronDown
            size={14}
            className={`overview-chev ${openSec.plan ? 'open' : ''}`}
          />
        </button>
        {openSec.plan ? (
          <div className="overview-sec-b">
            {runningTools.length > 0 ? (
              <ul className="overview-list">
                {runningTools.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    <span className="overview-dot live" />
                    {t.status === 'pending_approval' ? '待确认' : '进行中'} · {t.name || '工具'}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="overview-empty">暂无进行中的计划步骤</p>
            )}
            <button
              type="button"
              className="overview-link"
              onClick={() => onOpenPanel('tasks')}
            >
              打开任务面板
            </button>
          </div>
        ) : null}
      </section>

      <section className="overview-sec">
        <button type="button" className="overview-sec-h" onClick={() => toggle('agents')}>
          <Lucide.Bot size={15} strokeWidth={1.75} />
          <span>Agent</span>
          {sortedAgents.some((a) => a.status === 'running') ? (
            <span className="overview-pill">运行中</span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`overview-chev ${openSec.agents ? 'open' : ''}`}
          />
        </button>
        {openSec.agents ? (
          <div className="overview-sec-b">
            {sortedAgents.length === 0 ? (
              <p className="overview-empty">暂无子 Agent</p>
            ) : (
              <ul className="overview-list">
                {sortedAgents.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="overview-item-btn"
                      onClick={() => {
                        useLayoutStore.getState().setPanelAgentId(a.id);
                        useLayoutStore.getState().setActiveAgentId(a.id);
                        onOpenPanel('agent');
                        window.dispatchEvent(
                          new CustomEvent('crish-open-agent-panel', {
                            detail: { agentId: a.id },
                          }),
                        );
                      }}
                    >
                      <span
                        className={`overview-dot ${a.status === 'running' ? 'live' : ''}`}
                      />
                      <span className="overview-item-main">
                        {a.description || a.id}
                        <em>
                          {a.status === 'running'
                            ? '运行中'
                            : a.status === 'failed'
                              ? '失败'
                              : '完成'}
                        </em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      <section className="overview-sec">
        <button type="button" className="overview-sec-h" onClick={() => toggle('files')}>
          <Lucide.GitBranch size={15} strokeWidth={1.75} />
          <span>改动文件</span>
          {files.length > 0 ? <span className="overview-pill">{files.length}</span> : null}
          <Lucide.ChevronDown
            size={14}
            className={`overview-chev ${openSec.files ? 'open' : ''}`}
          />
        </button>
        {openSec.files ? (
          <div className="overview-sec-b">
            {files.length === 0 ? (
              <p className="overview-empty">暂无记录的改动（对话中产生的 diff 会出现在这里）</p>
            ) : (
              <ul className="overview-list">
                {files.slice(0, 12).map((f) => (
                  <li key={f.filePath}>
                    <button
                      type="button"
                      className="overview-item-btn"
                      onClick={() => {
                        useLayoutStore.getState().setActiveDiffSource(f);
                        onOpenPanel('diff');
                      }}
                    >
                      <Lucide.FileCode2 size={14} strokeWidth={1.75} />
                      <span className="overview-item-main mono">
                        {f.filePath.replace(/^.*[\\/]/, '')}
                        <em>{f.filePath}</em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="overview-link" onClick={() => onOpenPanel('diff')}>
              打开变更面板
            </button>
          </div>
        ) : null}
      </section>

      <section className="overview-sec">
        <button type="button" className="overview-sec-h" onClick={() => toggle('ctx')}>
          <Lucide.Layers size={15} strokeWidth={1.75} />
          <span>上下文</span>
          <Lucide.ChevronDown
            size={14}
            className={`overview-chev ${openSec.ctx ? 'open' : ''}`}
          />
        </button>
        {openSec.ctx ? (
          <div className="overview-sec-b">
            <ul className="overview-list static">
              <li>
                消息 {(session?.messages || []).length} 条
              </li>
              <li>
                工具调用{' '}
                {(session?.messages || []).reduce(
                  (n, m) => n + (m.toolCalls?.length || 0),
                  0,
                )}{' '}
                次
              </li>
              <li>
                工作区 {useLayoutStore.getState().workspaces.length ? '已打开' : '—'}
              </li>
            </ul>
            <div className="overview-quick">
              <button type="button" className="overview-chip" onClick={() => onOpenPanel('files')}>
                文件
              </button>
              <button type="button" className="overview-chip" onClick={() => onOpenPanel('terminal')}>
                终端
              </button>
              <button type="button" className="overview-chip" onClick={() => onOpenPanel('runtime')}>
                运行状态
              </button>
              <button
                type="button"
                className="overview-chip"
                onClick={() => {
                  useLayoutStore.getState().openSettings('skills');
                  onShowToast?.('已打开设置 · 技能');
                }}
              >
                技能
              </button>
              <button
                type="button"
                className="overview-chip"
                onClick={() => {
                  useLayoutStore.getState().openSettings('mcp');
                  onShowToast?.('已打开设置 · 扩展服务');
                }}
              >
                MCP
              </button>
              <button
                type="button"
                className="overview-chip"
                onClick={() => {
                  useLayoutStore.getState().openSettings('rules');
                  onShowToast?.('已打开设置 · 规则');
                }}
              >
                规则
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
};
