import React, { useMemo, useState } from 'react';
import { Dialog, Button } from '../ui';
import { AppIcon } from '../ui/icons';
import { useToast } from '../../services/toast/ToastContext';
import {
  generatePluginSharePayload,
  type CustomPluginItem,
} from './customPluginStorage';
import styles from './PluginShareModal.module.css';

export interface PluginShareModalProps {
  open: boolean;
  onClose: () => void;
  plugin:
    | CustomPluginItem
    | { id: string; name: string; description: string; version?: string }
    | null;
}

export const PluginShareModal: React.FC<PluginShareModalProps> = ({
  open,
  onClose,
  plugin,
}) => {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);

  const jsonPayload = useMemo(() => {
    if (!plugin) return '';
    return generatePluginSharePayload(plugin);
  }, [plugin]);

  const handleCopy = async () => {
    if (!jsonPayload) return;
    try {
      await navigator.clipboard.writeText(jsonPayload);
      setCopied(true);
      showToast('已复制插件分享配置到剪贴板！');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      showToast(
        `复制失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleDownload = () => {
    if (!jsonPayload || !plugin) return;
    try {
      const blob = new Blob([jsonPayload], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${plugin.id || 'plugin'}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`已开始下载「${plugin.name}」配置文件`);
    } catch (err) {
      showToast(
        `下载配置文件失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return (
    <Dialog
      size="md"
      open={open}
      onClose={onClose}
      title="分享插件"
      description="导出或复制标准插件规格定义，便于在其他设备与工作区共享"
      classNames={{
        panel: styles.modalPanel,
        body: styles.modalBody,
      }}
      footer={
        <div className={styles.modalFooter}>
          <div className={styles.footerLeft}>
            <Button
              variant="secondary"
              size="sm"
              icon={<AppIcon name="file-download" size={14} />}
              onClick={handleDownload}
              disabled={!plugin}
            >
              下载插件配置 (JSON)
            </Button>
          </div>
          <div className={styles.footerRight}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              关闭
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<AppIcon name={copied ? 'check' : 'copy'} size={14} />}
              onClick={handleCopy}
              disabled={!plugin}
            >
              {copied ? '已复制' : '复制分享配置'}
            </Button>
          </div>
        </div>
      }
    >
      {plugin && (
        <div className={styles.pluginMetaHeader}>
          <div className={styles.pluginInfo}>
            <AppIcon name="puzzle" size={16} />
            <span className={styles.pluginName}>{plugin.name}</span>
            <span className={styles.pluginVersion}>
              v{('version' in plugin && plugin.version) || '1.0.0'}
            </span>
          </div>
        </div>
      )}

      <div className={styles.jsonViewerWrapper}>
        <pre className={styles.jsonViewer}>
          <code>{jsonPayload || '暂无可用插件配置'}</code>
        </pre>
      </div>
    </Dialog>
  );
};
