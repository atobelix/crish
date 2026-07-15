/**
 * 右侧默认总览：计划、改动文件（git + 对话 diff）、Agent、上下文摘要
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import {
  fetchGitDiff,
  fetchGitStatus,
  gitStatusBadgeClass,
  gitStatusLabel,
  type GitStatusFile,
  type GitStatusResult,
} from '../api/gitApi';
import { getWorkspacePath } from '../api/projectStore';
import { toolHumanLabel } from '../api/toolPresentation';

type Props = {
  wsId: string;
  onOpenPanel: (id: string) => void;
  onShowToast?: (msg: string) => void;
};

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

const OverviewCardInner: React.FC<Props> = ({ onOpenPanel, onShowToast }) => {
  const sessions = useLayoutStore((s) => s.sessions);
  const activeSessionId = useLayoutStore((s) => s.activeSessionId);
  const diffFiles = useLayoutStore((s) => s.diffFiles);
  const activeDiffSource = useLayoutStore((s) => s.activeDiffSource);
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const workspacesLen = useLayoutStore((s) => s.workspaces.length);

  const [openSec, setOpenSec] = useState({
    plan: true,
    agents: true,
    files: true,
    ctx: true,
  });
  const [git, setGit] = useState<GitStatusResult | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitErr, setGitErr] = useState<string | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);

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

  const convoFiles = useMemo(() => {
    if (diffFiles?.length) return diffFiles;
    return activeDiffSource ? [activeDiffSource] : [];
  }, [diffFiles, activeDiffSource]);

  const refreshGit = useCallback(async () => {
    setGitLoading(true);
    setGitErr(null);
    try {
      const res = await fetchGitStatus();
      setGit(res);
      if (!res.found && res.reason === 'daemon-offline') {
        setGitErr('引擎未连接，无法读取 Git 状态');
      } else if (!res.found && res.reason === 'error') {
        setGitErr('Git 状态查询失败');
      }
    } catch {
      setGitErr('Git 状态查询失败');
      setGit(null);
    } finally {
      setGitLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGit();
    const onProject = () => {
      void refreshGit();
    };
    window.addEventListener('crish-project-changed', onProject);
    // 工具结束或会话推进时轻量刷新（节流由调用方控制频率）
    const onFocus = () => {
      void refreshGit();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('crish-project-changed', onProject);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshGit]);

  const allSessionTools = useMemo(() => {
    const main = session?.messages?.flatMap((m) => m.toolCalls || []) || [];
    const agents =
      session?.agents?.flatMap((a) => (a.messages || []).flatMap((m) => m.toolCalls || [])) || [];
    return [...main, ...agents];
  }, [session?.messages, session?.agents]);

  const runningTools = allSessionTools.filter(
    (t) => t.status === 'running' || t.status === 'pending_approval',
  );

  const completedToolsRecent = useMemo(() => {
    const all = allSessionTools.filter((t) => t.status === 'success' || t.status === 'error');
    return all.slice(-6).reverse();
  }, [allSessionTools]);

  const toggle = (k: keyof typeof openSec) =>
    setOpenSec((s) => ({ ...s, [k]: !s[k] }));

  const openGitFile = async (f: GitStatusFile) => {
    setOpeningPath(f.path);
    try {
      const diff = await fetchGitDiff({ path: f.path });
      if (diff.files.length > 0) {
        const first = diff.files[0];
        // 保证路径与 status 一致
        const merged = { ...first, filePath: first.filePath || f.path };
        useLayoutStore.getState().pushDiffFile(merged);
        useLayoutStore.getState().setActiveDiffSource(merged);
        onOpenPanel('diff');
        return;
      }
      // 无 diff 时仍打开变更面板并占位
      const placeholder = {
        filePath: f.path,
        additions: 0,
        deletions: 0,
        changes: [
          {
            type: 'normal' as const,
            content: `（${gitStatusLabel(f.status)}）暂无行级差异可显示`,
          },
        ],
      };
      useLayoutStore.getState().pushDiffFile(placeholder);
      useLayoutStore.getState().setActiveDiffSource(placeholder);
      onOpenPanel('diff');
    } catch {
      onShowToast?.('打开变更失败');
    } finally {
      setOpeningPath(null);
    }
  };

  const gitFiles = git?.found ? git.files : [];
  const fileCount = Math.max(gitFiles.length, convoFiles.length);
  const wsPath = getWorkspacePath();

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
            {git?.found && git.branch ? ` · ${git.branch}` : ''}
          </div>
        </div>
      </div>

      <section className="overview-sec">
        <button type="button" className="overview-sec-h" onClick={() => toggle('plan')}>
          <Lucide.ListTodo size={15} strokeWidth={1.75} />
          <span>计划与进度</span>
          {planModeEnabled || runningTools.length > 0 ? (
            <span className="overview-pill">{planModeEnabled ? '计划模式' : '进行中'}</span>
          ) : null}
          <Lucide.ChevronDown
            size={14}
            className={`overview-chev ${openSec.plan ? 'open' : ''}`}
          />
        </button>
        {openSec.plan ? (
          <div className="overview-sec-b">
            {planModeEnabled ? (
              <div className="overview-plan-banner">
                <div className="overview-plan-banner-t">
                  当前为<strong>计划模式</strong>：只读分析，不改项目文件。
                </div>
                <div className="overview-plan-actions">
                  <button
                    type="button"
                    className={`overview-chip ${planApproved ? 'active' : ''}`}
                    onClick={() => {
                      setPlanApproved(!planApproved);
                      onShowToast?.(
                        planApproved ? '已取消计划确认' : '已标记计划确认（演示进度）',
                      );
                    }}
                  >
                    {planApproved ? '已确认计划' : '确认计划'}
                  </button>
                  <button
                    type="button"
                    className="overview-chip"
                    onClick={() => {
                      useLayoutStore.getState().setPermissionMode('ask');
                      onShowToast?.('已切回需确认模式');
                    }}
                  >
                    退出计划模式
                  </button>
                </div>
              </div>
            ) : null}

            {runningTools.length > 0 ? (
              <ul className="overview-list">
                {runningTools.slice(0, 6).map((t) => {
                  const label = toolHumanLabel(t);
                  return (
                    <li key={t.id} title={label}>
                      <span className="overview-dot live" />
                      {t.status === 'pending_approval' ? '待确认' : '进行中'} · {label}
                    </li>
                  );
                })}
              </ul>
            ) : completedToolsRecent.length > 0 ? (
              <ul className="overview-list">
                {completedToolsRecent.map((t) => {
                  const label = toolHumanLabel(t);
                  return (
                    <li key={t.id} title={label}>
                      <span className={`overview-dot ${t.status === 'error' ? '' : 'live'}`} />
                      {t.status === 'error' ? '失败' : '完成'} · {label}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="overview-empty">
                {planModeEnabled
                  ? '计划模式下暂无工具步骤；可在对话中让助手拆解任务。'
                  : '暂无进行中的步骤；工具调用会出现在这里。'}
              </p>
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
          {fileCount > 0 ? <span className="overview-pill">{fileCount}</span> : null}
          <Lucide.ChevronDown
            size={14}
            className={`overview-chev ${openSec.files ? 'open' : ''}`}
          />
        </button>
        {openSec.files ? (
          <div className="overview-sec-b">
            <div className="overview-files-toolbar">
              <span className="overview-files-meta">
                {gitLoading
                  ? '读取 Git…'
                  : git?.found
                    ? git.clean
                      ? '工作区干净'
                      : `${gitFiles.length} 个变更`
                    : gitErr || (wsPath ? '非 Git 目录或不可用' : '未打开工作区')}
              </span>
              <button
                type="button"
                className="overview-icon-btn"
                title="刷新 Git 状态"
                disabled={gitLoading}
                onClick={() => void refreshGit()}
              >
                <Lucide.RefreshCw size={14} strokeWidth={1.75} className={gitLoading ? 'spin' : ''} />
              </button>
            </div>

            {gitFiles.length > 0 ? (
              <ul className="overview-list">
                {gitFiles.slice(0, 16).map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="overview-item-btn"
                      disabled={openingPath === f.path}
                      onClick={() => void openGitFile(f)}
                    >
                      <span className={gitStatusBadgeClass(f.status)} title={gitStatusLabel(f.status)}>
                        {String(f.status).slice(0, 1)}
                      </span>
                      <span className="overview-item-main mono">
                        {basename(f.path)}
                        <em>
                          {gitStatusLabel(f.status)}
                          {f.conflicted ? ' · 冲突' : ''}
                          {f.staged && !f.untracked ? ' · 已暂存' : ''}
                          {' · '}
                          {f.path}
                        </em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : convoFiles.length > 0 ? (
              <ul className="overview-list">
                {convoFiles.slice(0, 12).map((f) => (
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
                        {basename(f.filePath)}
                        <em>
                          +{f.additions} -{f.deletions} · {f.filePath}
                        </em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="overview-empty">
                暂无改动。打开 Git 仓库工作区后，未提交变更会显示在这里；对话产生的 diff 也会列出。
              </p>
            )}

            {convoFiles.length > 0 && gitFiles.length > 0 ? (
              <p className="overview-hint">
                另有对话记录的 {convoFiles.length} 个 diff 文件
              </p>
            ) : null}

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
              <li>消息 {(session?.messages || []).length} 条</li>
              <li>
                工具调用{' '}
                {(session?.messages || []).reduce(
                  (n, m) => n + (m.toolCalls?.length || 0),
                  0,
                )}{' '}
                次
              </li>
              <li>
                工作区 {wsPath ? basename(wsPath) : workspacesLen ? '已打开' : '—'}
              </li>
              {git?.found ? (
                <li>
                  Git {git.clean ? '干净' : '有改动'}
                  {typeof git.conflictedCount === 'number' && git.conflictedCount > 0
                    ? ` · ${git.conflictedCount} 冲突`
                    : ''}
                </li>
              ) : null}
            </ul>
            <div className="overview-quick" role="toolbar" aria-label="快捷入口">
              <button
                type="button"
                className="overview-icon-btn"
                title="文件"
                aria-label="文件"
                onClick={() => onOpenPanel('files')}
              >
                <Lucide.FolderTree size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="overview-icon-btn"
                title="终端"
                aria-label="终端"
                onClick={() => onOpenPanel('terminal')}
              >
                <Lucide.Terminal size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="overview-icon-btn"
                title="运行状态"
                aria-label="运行状态"
                onClick={() => onOpenPanel('runtime')}
              >
                <Lucide.Gauge size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="overview-icon-btn"
                title="技能"
                aria-label="技能"
                onClick={() => {
                  useLayoutStore.getState().openSettings('skills');
                  onShowToast?.('已打开设置 · 技能');
                }}
              >
                <Lucide.GraduationCap size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="overview-icon-btn"
                title="MCP"
                aria-label="MCP"
                onClick={() => {
                  useLayoutStore.getState().openSettings('mcp');
                  onShowToast?.('已打开设置 · 扩展服务');
                }}
              >
                <Lucide.Server size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="overview-icon-btn"
                title="规则"
                aria-label="规则"
                onClick={() => {
                  useLayoutStore.getState().openSettings('rules');
                  onShowToast?.('已打开设置 · 规则');
                }}
              >
                <Lucide.FileText size={14} strokeWidth={1.75} />
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
};

export const OverviewCard = React.memo(OverviewCardInner);
