/**
 * 设置 · 账户（现代化列表：身份卡片 + 数据位置 + 可选开发者引擎）
 */
import React, { useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
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
  const [daemonWsDraft, setDaemonWsDraft] = useState(() => {
    try {
      return localStorage.getItem('crish_daemon_ws') || 'ws://127.0.0.1:8765';
    } catch {
      return 'ws://127.0.0.1:8765';
    }
  });
  const [daemonConnHint, setDaemonConnHint] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDiskMeta(loadMirrorMeta());
  }, [cwd]);

  const dataLocation =
    diskMeta.mode === 'tauri' && diskMeta.lastPath
      ? diskMeta.lastPath
      : diskMeta.mode === 'localStorage-only'
        ? '本机浏览器存储（当前环境未启用磁盘镜像）'
        : '本机浏览器存储';

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">账户</h2>
        <p className="settings-page-desc">本地身份、会话数据位置与开发者连接（产品默认不暴露引擎细节）。</p>
      </header>

      <section className="settings-group" aria-label="身份">
        <div className="settings-group-label">身份</div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--profile">
            <div className="settings-profile-avatar-lg" aria-hidden>
              <Lucide.User size={22} strokeWidth={1.75} />
            </div>
            <div className="settings-list-copy">
              <div className="settings-list-title">本机用户</div>
              <div className="settings-list-sub">
                {cwd === '__global__' ? '尚未选择工作区' : cwd}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-label="数据">
        <div className="settings-group-label">数据</div>
        <div className="settings-list">
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">会话数据</div>
              <div className="settings-list-sub">始终保存在本机；桌面壳下会额外镜像到应用数据目录。</div>
            </div>
          </div>
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">存储位置</div>
              <div className="settings-list-sub settings-list-sub--mono" title={dataLocation}>
                {dataLocation}
              </div>
            </div>
          </div>
        </div>
      </section>

      {isDeveloperEngineUiEnabled() ? (
        <section className="settings-group" aria-label="开发者">
          <div className="settings-group-label">开发者</div>
          <div className="settings-list">
            <div className="settings-list-row settings-list-row--stack">
              <div className="settings-list-copy">
                <div className="settings-list-title">引擎 WebSocket</div>
                <div className="settings-list-sub">仅开发调试使用</div>
              </div>
              <div className="settings-list-stack-controls">
                <input
                  type="text"
                  className="settings-field-input"
                  value={daemonWsDraft}
                  onChange={(e) => setDaemonWsDraft(e.target.value)}
                  spellCheck={false}
                />
                <div className="settings-list-stack-actions">
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    disabled={busy}
                    onClick={() => {
                      try {
                        localStorage.setItem('crish_daemon_ws', daemonWsDraft.trim());
                        onShowToast('已保存引擎地址，重启后生效');
                      } catch {
                        onShowToast('保存失败');
                      }
                    }}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setDaemonConnHint('连接中…');
                      void ensureDaemonConnected()
                        .then((r) => {
                          setDaemonConnHint(
                            r.ok
                              ? `已连接 ${r.url || ''}`.trim()
                              : networkUserMessage(r.error) || '未连接',
                          );
                        })
                        .finally(() => setBusy(false));
                    }}
                  >
                    测试连接
                  </button>
                </div>
                {daemonConnHint ? (
                  <div className="settings-list-sub">{daemonConnHint}</div>
                ) : null}
                <div className="settings-list-sub">
                  当前：
                  {getDesktopDaemonClient().isConnected() ? '在线' : '离线'}
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
};
