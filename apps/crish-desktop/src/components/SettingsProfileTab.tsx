/**
 * 设置 · 账户：本机环境、数据备份；成功静默，仅错误提示。
 */
import React, { useEffect, useId, useState } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi } from '../api/clientApi';
import { ensureDaemonConnected } from '../api/daemonChatBridge';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { isDeveloperEngineUiEnabled } from '../api/productMode';
import { getWorkspacePath } from '../api/projectStore';
import { loadMirrorMeta } from '../api/sessionDiskMirror';
import { networkUserMessage } from '../api/userFacingErrors';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './settings/SettingsUI';

type Props = {
  onShowToast: (msg: string) => void;
};

const DEFAULT_DAEMON_WS = 'ws://127.0.0.1:8765';

/** 路径短名 */
function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function readDaemonWsStored(): string {
  try {
    return localStorage.getItem('crish_daemon_ws') || DEFAULT_DAEMON_WS;
  } catch {
    return DEFAULT_DAEMON_WS;
  }
}

export const SettingsProfileTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const identityLabelId = useId();
  const dataLabelId = useId();
  const devLabelId = useId();
  const headMetaId = useId();
  const daemonWsInputId = useId();
  const daemonStatusId = useId();

  const [diskMeta, setDiskMeta] = useState(() => loadMirrorMeta());
  const [daemonWsDraft, setDaemonWsDraft] = useState(readDaemonWsStored);
  const [daemonWsSaved, setDaemonWsSaved] = useState(readDaemonWsStored);
  const [daemonConnHint, setDaemonConnHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    setDiskMeta(loadMirrorMeta());
  }, [cwd]);

  const hasWorkspace = cwd !== '__global__' && Boolean(cwd);
  const diskPath =
    diskMeta.mode === 'tauri' && diskMeta.lastPath ? diskMeta.lastPath : '';
  const dataLocation = diskPath
    ? diskPath
    : diskMeta.mode === 'localStorage-only'
      ? '本机浏览器存储'
      : '本机浏览器存储';

  const handleExportSettings = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const settings = await clientApi.getSettings();
      const blob = new Blob([JSON.stringify(settings ?? {}, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `crish-settings-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 浏览器下载即反馈；成功不 toast
    } catch (err) {
      onShowToast('导出失败：' + String(err));
    } finally {
      setExporting(false);
    }
  };

  /** 选择 JSON 后合并写入本机设置；成功静默，失败 toast */
  const handleImportSettings = () => {
    if (importing) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void (async () => {
        setImporting(true);
        try {
          const text = await file.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            onShowToast('导入失败：不是合法 JSON');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            onShowToast('导入失败：根节点须为对象');
            return;
          }
          await clientApi.saveSettingsEx(
            cwd === '__global__' ? '__global__' : cwd,
            'global',
            parsed as Parameters<typeof clientApi.saveSettingsEx>[2],
          );
          // 成功静默
        } catch (err) {
          onShowToast('导入失败：' + String(err));
        } finally {
          setImporting(false);
        }
      })();
    };
    input.click();
  };

  const daemonWsTrimmed = daemonWsDraft.trim();
  const daemonWsDirty = daemonWsTrimmed !== daemonWsSaved.trim();
  const canSaveDaemonWs = Boolean(daemonWsTrimmed) && daemonWsDirty && !busy;

  const handleSaveDaemonWs = () => {
    const next = daemonWsDraft.trim();
    if (!next) {
      onShowToast('请填写服务地址');
      return;
    }
    // 未改动：静默跳过（无成功 toast）
    if (next === daemonWsSaved.trim()) return;
    try {
      localStorage.setItem('crish_daemon_ws', next);
      setDaemonWsSaved(next);
      setDaemonWsDraft(next);
      // 保存成功静默；重启后生效（title 已说明）
    } catch {
      onShowToast('保存失败');
    }
  };

  const handleTestDaemon = () => {
    if (busy) return;
    setBusy(true);
    setDaemonConnHint('连接中…');
    void ensureDaemonConnected()
      .then((r) => {
        setDaemonConnHint(
          r.ok
            ? `已连接 ${r.url || ''}`.trim()
            : networkUserMessage(r.error) || '未连接',
        );
        // 失败结果行内展示；成功也行内，均不 toast
      })
      .catch((err) => {
        const msg = networkUserMessage(err) || '未连接';
        setDaemonConnHint(msg);
        onShowToast('连接失败：' + msg);
      })
      .finally(() => setBusy(false));
  };

  const workspaceDisplay = hasWorkspace ? pathLeaf(cwd) : '未选择工作区';
  const workspaceTitle = hasWorkspace
    ? cwd
    : '可在空对话页选择项目；工具与 shell 将以该目录为工作区';
  /** 短显示：路径叶名 / 本机；长说明进 title */
  const storageDisplay = diskPath
    ? pathLeaf(diskPath)
    : diskMeta.mode === 'localStorage-only'
      ? '浏览器'
      : '本机';
  const storageIsPath = Boolean(diskPath);

  const daemonOnline = getDesktopDaemonClient().isConnected();
  const daemonStatus = daemonConnHint || (daemonOnline ? '在线' : '离线');
  const showDeveloper = isDeveloperEngineUiEnabled();
  const engineMeta =
    showDeveloper && !daemonOnline
      ? '服务未连接'
      : showDeveloper && daemonConnHint
        ? daemonConnHint
        : null;

  return (
    <SettingsPage
      title="账户"
      meta={
        engineMeta ? (
          <span
            id={headMetaId}
            className="settings-head-meta settings-head-meta--error"
            title="连接异常"
            role="status"
            aria-live="polite"
          >
            {engineMeta}
          </span>
        ) : null
      }
    >

      <SettingsSection title="当前环境">
        <SettingsCard>
          <SettingsRow
            icon={<Lucide.User size={18} strokeWidth={1.75} />}
            title="当前项目"
            desc={hasWorkspace ? '本机工作区' : '尚未打开项目'}
            control={
              hasWorkspace ? (
                <span className="settings-path-ellipsis" title={cwd}>
                  {workspaceDisplay}
                </span>
              ) : (
                <span className="settings-list-empty" title={workspaceTitle} role="status">
                  {workspaceDisplay}
                </span>
              )
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="数据">
        <SettingsCard>
          <SettingsRow
            title="会话数据"
            desc="仅保存在本机"
            control={<span className="settings-list-meta" title="不上传云端">本机</span>}
          />
          <SettingsRow
            title="存储位置"
            desc="应用数据目录"
            control={
              <span
                className={storageIsPath ? 'settings-path-ellipsis' : 'settings-list-meta'}
                title={dataLocation}
              >
                {storageDisplay}
              </span>
            }
          />
          <SettingsRow
            title="设置备份"
            desc="导出或导入配置"
            control={
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={exporting}
                  title={exporting ? '正在导出…' : '导出备份'}
                  onClick={() => handleExportSettings()}
                >
                  {exporting ? '导出中…' : '导出'}
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={importing}
                  title={importing ? '正在导入…' : '从备份导入'}
                  onClick={() => handleImportSettings()}
                >
                  {importing ? '导入中…' : '导入'}
                </button>
              </>
            }
          />
        </SettingsCard>
      </SettingsSection>

      {showDeveloper ? (
        <SettingsSection title="高级">
          <SettingsCard>
            <SettingsRow
              title={<label htmlFor={daemonWsInputId}>服务地址</label>}
              desc="高级连接设置"
              control={
                <>
                  <input
                    id={daemonWsInputId}
                    type="text"
                    className="settings-field-input settings-field-input--sm settings-field-input--w220"
                    value={daemonWsDraft}
                    onChange={(e) => setDaemonWsDraft(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    title="服务地址；保存后重启生效"
                    placeholder={DEFAULT_DAEMON_WS}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSaveDaemonWs();
                      } else if (e.key === 'Escape' && daemonWsDirty) {
                        e.preventDefault();
                        setDaemonWsDraft(daemonWsSaved);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    disabled={!canSaveDaemonWs}
                    onClick={handleSaveDaemonWs}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    disabled={busy}
                    onClick={handleTestDaemon}
                  >
                    {busy ? '测试中…' : '测试'}
                  </button>
                  <span
                    id={daemonStatusId}
                    className="settings-list-meta"
                    role="status"
                    aria-live="polite"
                  >
                    {daemonStatus}
                  </span>
                </>
              }
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
};
