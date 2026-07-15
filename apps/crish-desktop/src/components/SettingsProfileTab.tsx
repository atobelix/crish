/**
 * 设置 · 账户：本地身份、会话数据位置、开发者引擎地址
 */
import React, { useEffect, useState } from 'react';
import { clientApi } from '../api/clientApi';
import { ensureDaemonConnected } from '../api/daemonChatBridge';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { isDeveloperEngineUiEnabled } from '../api/productMode';
import { getWorkspacePath } from '../api/projectStore';
import { loadMirrorMeta } from '../api/sessionDiskMirror';
import { networkUserMessage } from '../api/userFacingErrors';

type Props = {
  onShowToast: (msg: string) => void;
};

export const SettingsProfileTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const [diskMeta, setDiskMeta] = useState(() => loadMirrorMeta());
  const [httpProxy, setHttpProxy] = useState('');
  const [daemonWsDraft, setDaemonWsDraft] = useState(() => {
    try {
      return localStorage.getItem('crish_daemon_ws') || 'ws://127.0.0.1:8765';
    } catch {
      return 'ws://127.0.0.1:8765';
    }
  });
  const [daemonConnHint, setDaemonConnHint] = useState('');

  useEffect(() => {
    setDiskMeta(loadMirrorMeta());
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (!cancelled && sets) setHttpProxy(sets.httpProxy || '');
      } catch {
        // 只读展示，失败时保持空
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return (
    <div className="settings-pane">
      <div className="settings-section-header" style={{ marginBottom: 8 }}>
        <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>账户</h4>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
          本地身份与数据存放位置
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0 16px' }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: 'var(--bg-tertiary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            fontSize: 14,
          }}
        >
          O
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            本机用户
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{cwd}</div>
        </div>
      </div>

      <div className="settings-fields-stack" style={{ gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="settings-field-label">会话数据</label>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            本机浏览器存储始终保存。
            {diskMeta.mode === 'tauri' && diskMeta.lastPath
              ? ` 另已镜像到：${diskMeta.lastPath}`
              : diskMeta.mode === 'localStorage-only'
                ? ' 当前环境未启用磁盘镜像（桌面壳下会写入应用数据目录）。'
                : ' 磁盘镜像状态未知。'}
          </div>
        </div>
        {/* Product: engine is internal — hide from consumers. Dev only via localStorage flag. */}
        {isDeveloperEngineUiEnabled() && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="settings-field-label">开发者：引擎地址</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={daemonWsDraft}
                onChange={(e) => setDaemonWsDraft(e.target.value)}
                className="settings-field-input"
                placeholder="ws://127.0.0.1:8765"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                onClick={async () => {
                  try {
                    localStorage.setItem('crish_daemon_ws', daemonWsDraft.trim());
                    const client = getDesktopDaemonClient();
                    client.disconnect();
                    client.startKeepAlive();
                    const res = await ensureDaemonConnected();
                    if (res.ok) {
                      setDaemonConnHint(`ok · ${res.url || daemonWsDraft}`);
                      onShowToast('引擎已就绪');
                    } else {
                      setDaemonConnHint(networkUserMessage());
                      onShowToast(networkUserMessage());
                    }
                  } catch {
                    setDaemonConnHint(networkUserMessage());
                    onShowToast(networkUserMessage());
                  }
                }}
              >
                测试
              </button>
            </div>
            {daemonConnHint ? (
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: 0 }}>
                {daemonConnHint}
              </p>
            ) : null}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="settings-field-label">会话数据位置</label>
          <input
            type="text"
            readOnly
            value={
              diskMeta?.lastPath ||
              (diskMeta?.mode === 'localStorage-only'
                ? '浏览器 localStorage（桌面壳可镜像到应用数据目录）'
                : '本机应用数据目录（自动管理）')
            }
            className="settings-field-input"
            title="自定义目录尚未接入引擎；当前为只读展示"
          />
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
            会话正文由本机保存；自定义路径尚未接入，故不可编辑以免无效配置。
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="settings-field-label">网络代理</label>
          <input
            type="text"
            disabled
            placeholder="尚未接入引擎代理配置"
            value={httpProxy || ''}
            className="settings-field-input"
          />
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
            代理需在系统或引擎侧配置；此处暂不提供无效输入。
          </p>
        </div>
      </div>
    </div>
  );
};
