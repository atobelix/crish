import React, { useState, useEffect, useMemo } from 'react';
import { Dialog, Button, Input, Switch } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useToast } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/storeAccess';
import { cleanAllImportedExternalSessions } from '../../api/import/importSessions';
import {
  getPersistedImportRoots,
  setPersistedClaudeImportRoot,
  setPersistedCodexImportRoot,
  getImportAutoSyncEnabled,
  setImportAutoSyncEnabled,
  getImportSuggestionEnabled,
  setImportSuggestionEnabled,
} from '../../api/import/importRootSettings';
import styles from './ImportPluginSettingsModal.module.css';

export interface ImportPluginSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onScanNeeded?: () => void;
}

export const ImportPluginSettingsModal: React.FC<
  ImportPluginSettingsModalProps
> = ({ open, onClose, onScanNeeded }) => {
  const { showToast } = useToast();
  const sessions = useSessionStore((s) => s.sessions);

  const [autoDetectEnabled, setAutoDetectEnabled] = useState(true);
  const [claudeCustomPath, setClaudeCustomPath] = useState('');
  const [codexCustomPath, setCodexCustomPath] = useState('');
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [confirmCleanOpen, setConfirmCleanOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const importedCount = useMemo(() => {
    return sessions.filter((s) => Boolean(s.importMeta?.source)).length;
  }, [sessions]);

  const handleCleanAll = async () => {
    setCleaning(true);
    try {
      const count = await cleanAllImportedExternalSessions();
      showToast(`已清空并移除 ${count} 个外部导入的会话`);
      setConfirmCleanOpen(false);
      onScanNeeded?.();
    } catch (err) {
      showToast('清空失败: ' + String(err));
    } finally {
      setCleaning(false);
    }
  };

  useEffect(() => {
    if (open) {
      const roots = getPersistedImportRoots();
      setClaudeCustomPath(roots.claudeConfigDir || '');
      setCodexCustomPath(roots.codexHome || '');
      setAutoSyncEnabled(getImportAutoSyncEnabled());
      setAutoDetectEnabled(getImportSuggestionEnabled());
      setConfirmCleanOpen(false);
    }
  }, [open]);

  const handleToggleAutoDetect = (checked: boolean) => {
    setAutoDetectEnabled(checked);
    setImportSuggestionEnabled(checked);
    showToast(
      checked ? '已开启启动时长对话自动探测' : '已关闭启动时长对话探测'
    );
  };

  const handleToggleAutoSync = (checked: boolean) => {
    setAutoSyncEnabled(checked);
    setImportAutoSyncEnabled(checked);
    showToast(
      checked ? '已开启检测后自动接续' : '已关闭自动接续（推荐手动选择导入）'
    );
  };

  const handleSaveClaudePath = () => {
    setPersistedClaudeImportRoot(claudeCustomPath.trim() || null);
    onScanNeeded?.();
    showToast('已更新 Claude 配置路径');
  };

  const handleResetClaudePath = () => {
    setPersistedClaudeImportRoot(null);
    setClaudeCustomPath('');
    onScanNeeded?.();
    showToast('已重置 Claude 默认配置路径');
  };

  const handleSaveCodexPath = () => {
    setPersistedCodexImportRoot(codexCustomPath.trim() || null);
    onScanNeeded?.();
    showToast('已更新 Codex 主目录路径');
  };

  const handleResetCodexPath = () => {
    setPersistedCodexImportRoot(null);
    setCodexCustomPath('');
    onScanNeeded?.();
    showToast('已重置 Codex 默认路径');
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={
        <div className={styles.modalTitle}>
          <AppIcon name="settings" size={16} />
          <span>外部对话导入设置</span>
        </div>
      }
      description="配置 Claude Code 与 OpenAI Codex 的本地扫描根目录与自动接续策略"
      classNames={{
        panel: styles.modalPanel,
        body: styles.modalBody,
      }}
      footer={
        <div className={styles.modalFooter}>
          <Button variant="primary" size="sm" onClick={onClose}>
            完成
          </Button>
        </div>
      }
    >
      {/* 启动时长对话智能探测开关卡片 */}
      <div className={`${styles.settingCard} ${styles.settingSwitchCard}`}>
        <div className={styles.settingMain}>
          <div className={styles.settingTitle}>启动时自动检测外部长对话</div>
          <div className={styles.settingDesc}>
            启动时自动检测并呈现外部活跃长对话预览，支持一键导入接续
          </div>
        </div>
        <Switch
          checked={autoDetectEnabled}
          onCheckedChange={handleToggleAutoDetect}
          aria-label="启动时自动检测并呈现外部活跃长对话开关"
        />
      </div>

      {/* 自动导入开关卡片 */}
      <div className={`${styles.settingCard} ${styles.settingSwitchCard}`}>
        <div className={styles.settingMain}>
          <div className={styles.settingTitle}>自动导入新对话</div>
          <div className={styles.settingDesc}>
            检测到新对话时自动接续（默认关闭，推荐手动选择导入）
          </div>
        </div>
        <Switch
          checked={autoSyncEnabled}
          onCheckedChange={handleToggleAutoSync}
          aria-label="自动导入新对话开关"
        />
      </div>

      {/* Claude 配置根目录卡片 */}
      <div className={`${styles.settingCard} ${styles.settingFieldCard}`}>
        <div className={styles.settingHeader}>
          <span className={styles.settingTitle}>Claude 配置根目录</span>
          <span className={styles.settingHint}>
            留空则自动检测 ~/.claude/ 或 %USERPROFILE%\.claude
          </span>
        </div>
        <div className={styles.inputActionRow}>
          <Input
            value={claudeCustomPath}
            onChange={(e) => setClaudeCustomPath(e.target.value)}
            placeholder="如：C:\Users\用户名\.claude"
            className={styles.pathInput}
          />
          <Button variant="secondary" size="sm" onClick={handleSaveClaudePath}>
            保存
          </Button>
          <Button variant="ghost" size="sm" onClick={handleResetClaudePath}>
            重置
          </Button>
        </div>
      </div>

      {/* Codex 主目录卡片 */}
      <div className={`${styles.settingCard} ${styles.settingFieldCard}`}>
        <div className={styles.settingHeader}>
          <span className={styles.settingTitle}>Codex 主目录</span>
          <span className={styles.settingHint}>
            留空则自动检测 ~/.codex/ 或 %USERPROFILE%\.codex
          </span>
        </div>
        <div className={styles.inputActionRow}>
          <Input
            value={codexCustomPath}
            onChange={(e) => setCodexCustomPath(e.target.value)}
            placeholder="如：C:\Users\用户名\.codex"
            className={styles.pathInput}
          />
          <Button variant="secondary" size="sm" onClick={handleSaveCodexPath}>
            保存
          </Button>
          <Button variant="ghost" size="sm" onClick={handleResetCodexPath}>
            重置
          </Button>
        </div>
      </div>

      {/* 已导入外部对话管理卡片 */}
      <div className={`${styles.settingCard} ${styles.settingFieldCard}`}>
        <div className={styles.settingHeader}>
          <div className={styles.settingMain}>
            <div className={styles.settingTitle}>已导入外部对话管理</div>
            <div className={styles.settingDesc}>
              当前系统内共有 {importedCount}{' '}
              个已导入的外部对话。若早期版本曾误导入大量无用空记录，可在此一键彻底清空并加入防静默墓碑。
            </div>
          </div>
        </div>
        {confirmCleanOpen ? (
          <div className={styles.cleanConfirmBox}>
            <span className={styles.cleanConfirmPrompt}>
              确定清空全部 {importedCount} 个已导入外部对话？
            </span>
            <div className={styles.cleanConfirmActions}>
              <Button
                variant="danger"
                size="sm"
                loading={cleaning}
                disabled={cleaning}
                onClick={() => void handleCleanAll()}
              >
                确认清空
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={cleaning}
                onClick={() => setConfirmCleanOpen(false)}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.cleanActionRow}>
            <Button
              variant="danger"
              size="sm"
              disabled={importedCount === 0 || cleaning}
              onClick={() => setConfirmCleanOpen(true)}
            >
              <AppIcon name="trash" size={13} />
              <span>清空所有已导入对话</span>
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
};
