/**
 * 诊断日志弹窗（PE-05 T05.2 #1）
 *
 * 已收敛到 ui/Dialog 基座：遮罩/Esc/焦点圈定/焦点归还/动画全部由基座接管；
 * 原内联 style 对象下沉为本组件 module（TelemetryDialog.module.css，样式不变）。
 * 行为保持：backdrop/Esc 关闭、清空后关闭、下载日志。
 */
import { useMemo } from 'react';
import { telemetry } from '../../services/TelemetryService';
import { Button, Dialog } from '@/components/ui';
import styles from './TelemetryDialog.module.css';

interface TelemetryDialogProps {
  onClose: () => void;
  isOpen?: boolean;
}

export function TelemetryDialog({
  onClose,
  isOpen = true,
}: TelemetryDialogProps) {
  const stats = useMemo(() => {
    const entries = telemetry.getEntries();
    const errors = entries.filter((e) => e.level === 'error').length;
    const warns = entries.filter((e) => e.level === 'warn').length;
    return { total: entries.length, errors, warns };
  }, []);

  const handleDownload = () => {
    telemetry.downloadLog();
  };

  const handleClear = () => {
    telemetry.clear();
    onClose();
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title="诊断日志"
      size="md"
      footer={
        <div className={styles.actions}>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={handleClear}
            aria-label="清空日志"
          >
            清空日志
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            aria-label="关闭"
          >
            关闭
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleDownload}
            aria-label="下载诊断日志"
          >
            下载诊断日志
          </Button>
        </div>
      }
    >
      <div className={styles.row}>
        <span className={styles.label}>会话 ID</span>
        <span className={styles.value}>
          {telemetry.getSessionId().slice(0, 8)}…
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>记录总数</span>
        <span className={styles.value}>{stats.total}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>错误</span>
        <span>
          <span className={`${styles.badge} ${styles.badgeError}`}>
            {stats.errors}
          </span>
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>警告</span>
        <span>
          <span className={`${styles.badge} ${styles.badgeWarn}`}>
            {stats.warns}
          </span>
        </span>
      </div>
    </Dialog>
  );
}
