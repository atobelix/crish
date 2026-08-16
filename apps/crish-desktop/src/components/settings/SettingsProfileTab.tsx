/**
 * 设置 · 账户：本机环境、数据备份、导入外部对话；成功静默，仅错误提示。
 *
 * Stream D 改造后：磁盘镜像已删除，存储位置统一显示「本机 SQLite 数据库」。
 * 外部对话：点击扫描 Claude Code / Codex → 勾选 → 导入所选（禁止自动导入）。
 */
import React, { useId, useState } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi } from '../../api/clientApi';
import { ensureEngineConnected } from '../../api/chatBridge';
import { getTransport } from '../../api/transport';
import { isDeveloperEngineUiEnabled } from '../../api/productMode';
import { getWorkspacePath } from '../../api/projectStore';
import { networkUserMessage } from '../../api/userFacingErrors';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button, Tooltip } from '../ui';
import { ExternalSessionImport } from './ExternalSessionImport';
import styles from './SettingsProfileTab.module.css';

type Props = {
  onShowToast: (msg: string) => void;
};

/** 路径短名 */
function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const SettingsProfileTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const headMetaId = useId();
  const engineStatusId = useId();

  const [engineConnHint, setDaemonConnHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const hasWorkspace = cwd !== '__global__' && Boolean(cwd);
  // Stream D 改造后：存储统一为 SQLite（本机数据库），不再有磁盘镜像 / localStorage 分支
  const dataLocation = '本机 SQLite 数据库';

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
      // 成功静默（用户裁决：导出/导入成功提示不必每次说）
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
            parsed as Parameters<typeof clientApi.saveSettingsEx>[2]
          );
          // 成功静默（用户裁决：导出/导入成功提示不必每次说）
        } catch (err) {
          onShowToast('导入失败：' + String(err));
        } finally {
          setImporting(false);
        }
      })();
    };
    input.click();
  };

  const handleTestDaemon = () => {
    if (busy) return;
    setBusy(true);
    setDaemonConnHint('连接中…');
    void ensureEngineConnected()
      .then((r) => {
        setDaemonConnHint(
          r.ok ? '已连接' : networkUserMessage(r.error) || '未连接'
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
  const storageDisplay = 'SQLite';
  const storageIsPath = false;

  const engineOnline = getTransport().isReady();
  const engineStatus = engineConnHint || (engineOnline ? '在线' : '离线');
  const showDeveloper = isDeveloperEngineUiEnabled();
  const engineMeta =
    showDeveloper && !engineOnline
      ? '服务未连接'
      : showDeveloper && engineConnHint
        ? engineConnHint
        : null;

  return (
    <SettingsPage
      title="账户"
      meta={
        engineMeta ? (
          <Tooltip content="连接异常">
            <span
              id={headMetaId}
              className={`${styles.settingsHeadMeta} ${styles.settingsHeadMetaError}`}
              role="status"
              aria-live="polite"
            >
              {engineMeta}
            </span>
          </Tooltip>
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
                <Tooltip content={cwd}>
                  <span className={styles.settingsPathEllipsis}>
                    {workspaceDisplay}
                  </span>
                </Tooltip>
              ) : (
                <Tooltip content={workspaceTitle}>
                  <span className={styles.settingsListEmpty} role="status">
                    {workspaceDisplay}
                  </span>
                </Tooltip>
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
            control={
              <Tooltip content="不上传云端">
                <span className={styles.settingsListMeta}>本机</span>
              </Tooltip>
            }
          />
          <SettingsRow
            title="存储位置"
            desc="应用数据目录"
            control={
              <Tooltip content={dataLocation}>
                <span
                  className={
                    storageIsPath
                      ? styles.settingsPathEllipsis
                      : styles.settingsListMeta
                  }
                >
                  {storageDisplay}
                </span>
              </Tooltip>
            }
          />
          <SettingsRow
            title="设置备份"
            desc="导出或导入配置"
            control={
              <>
                <Tooltip content={exporting ? '正在导出…' : '导出备份'}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={exporting}
                    onClick={() => handleExportSettings()}
                  >
                    {exporting ? '导出中…' : '导出'}
                  </Button>
                </Tooltip>
                <Tooltip content={importing ? '正在导入…' : '从备份导入'}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={importing}
                    onClick={() => handleImportSettings()}
                  >
                    {importing ? '导入中…' : '导入'}
                  </Button>
                </Tooltip>
              </>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="导入外部对话">
        <SettingsCard>
          <div className={styles.settingsImportBody}>
            <ExternalSessionImport
              variant="settings"
              onShowToast={onShowToast}
            />
          </div>
        </SettingsCard>
      </SettingsSection>

      {showDeveloper ? (
        <SettingsSection title="高级">
          <SettingsCard>
            <SettingsRow
              title={<label htmlFor={engineStatusId}>核心连接</label>}
              desc="Tauri IPC 进程内核心（无 WS 地址）；可测试「核心已初始化」"
              control={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={handleTestDaemon}
                  >
                    {busy ? '测试中…' : '测试'}
                  </Button>
                  <span
                    id={engineStatusId}
                    className={styles.settingsListMeta}
                    role="status"
                    aria-live="polite"
                  >
                    {engineStatus}
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
