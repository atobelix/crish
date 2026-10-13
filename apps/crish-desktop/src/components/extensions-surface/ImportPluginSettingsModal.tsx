import React, { useState, useEffect } from 'react';
import { Dialog, Button, Input, Switch } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useToast } from '../../services/toast/ToastContext';
import {
  getPersistedImportRoots,
  setPersistedClaudeImportRoot,
  setPersistedCodexImportRoot,
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

  const [claudeCustomPath, setClaudeCustomPath] = useState('');
  const [codexCustomPath, setCodexCustomPath] = useState('');
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);

  useEffect(() => {
    if (open) {
      const roots = getPersistedImportRoots();
      setClaudeCustomPath(roots.claudeConfigDir || '');
      setCodexCustomPath(roots.codexHome || '');
      const savedAutoSync =
        localStorage.getItem('crish_auto_sync_external_sessions') === 'true';
      setAutoSyncEnabled(savedAutoSync);
    }
  }, [open]);

  const handleToggleAutoSync = (checked: boolean) => {
    setAutoSyncEnabled(checked);
    localStorage.setItem(
      'crish_auto_sync_external_sessions',
      checked ? 'true' : 'false'
    );
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
    </Dialog>
  );
};
