import { useMemo } from 'react';
import { telemetry } from '../services/TelemetryService';
import { FocusTrap } from './FocusTrap';
import { useAnimatedPresence } from '../hooks/useAnimatedPresence';
import { useRestoreFocus } from '../hooks/useRestoreFocus';

const dialogStyle: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.4)',
  },
  modal: {
    background: 'var(--bg-surface, #1e1e2e)',
    borderRadius: 12, padding: 24, minWidth: 420, maxWidth: 520,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    color: 'var(--fg-default, #e0e0e0)',
    fontFamily: 'system-ui, sans-serif',
  },
  title: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0' },
  row: { display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 14 },
  label: { color: 'var(--fg-muted, #999)' },
  value: { fontWeight: 500 },
  actions: { display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' },
  btn: {
    padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
    fontSize: 14, fontWeight: 500,
  },
  btnPrimary: {
    background: 'var(--accent-color, #4a9eff)', color: '#fff',
  },
  btnDanger: {
    background: 'var(--bg-danger, rgba(239,68,68,0.2))', color: 'var(--fg-danger, #ef4444)',
  },
  btnSecondary: {
    background: 'var(--bg-muted, rgba(255,255,255,0.08))', color: 'var(--fg-default, #e0e0e0)',
  },
  badge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4,
    fontSize: 12, fontWeight: 600,
  },
  badgeError: { background: 'rgba(239,68,68,0.2)', color: '#ef4444' },
  badgeWarn: { background: 'rgba(234,179,8,0.2)', color: '#eab308' },
};

interface TelemetryDialogProps {
  onClose: () => void;
  isOpen?: boolean;
}

export function TelemetryDialog({ onClose, isOpen = true }: TelemetryDialogProps) {
  const { state, isMounted } = useAnimatedPresence({ visible: isOpen, exitDurationMs: 200 });
  useRestoreFocus(isOpen);

  const stats = useMemo(() => {
    const entries = telemetry.getEntries();
    const errors = entries.filter(e => e.level === 'error').length;
    const warns = entries.filter(e => e.level === 'warn').length;
    return { total: entries.length, errors, warns };
  }, []);

  const handleDownload = () => {
    telemetry.downloadLog();
  };

  const handleClear = () => {
    telemetry.clear();
    onClose();
  };

  if (!isMounted) return null;

  return (
    <FocusTrap active={isOpen}>
      <div
        style={dialogStyle.overlay}
        role="presentation"
        onClick={onClose}
      >
        <div
          style={dialogStyle.modal}
          role="dialog"
          aria-modal="true"
          aria-label="诊断日志"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 style={dialogStyle.title}>诊断日志</h3>

          <div style={dialogStyle.row}>
            <span style={dialogStyle.label}>会话 ID</span>
            <span style={dialogStyle.value}>{telemetry.getSessionId().slice(0, 8)}…</span>
          </div>
          <div style={dialogStyle.row}>
            <span style={dialogStyle.label}>记录总数</span>
            <span style={dialogStyle.value}>{stats.total}</span>
          </div>
          <div style={dialogStyle.row}>
            <span style={dialogStyle.label}>错误</span>
            <span>
              <span style={{ ...dialogStyle.badge, ...dialogStyle.badgeError } as React.CSSProperties}>
                {stats.errors}
              </span>
            </span>
          </div>
          <div style={dialogStyle.row}>
            <span style={dialogStyle.label}>警告</span>
            <span>
              <span style={{ ...dialogStyle.badge, ...dialogStyle.badgeWarn } as React.CSSProperties}>
                {stats.warns}
              </span>
            </span>
          </div>

          <div style={dialogStyle.actions}>
            <button
              style={{ ...dialogStyle.btn, ...dialogStyle.btnDanger } as React.CSSProperties}
              onClick={handleClear}
              aria-label="清空日志"
            >
              清空日志
            </button>
            <button
              style={{ ...dialogStyle.btn, ...dialogStyle.btnSecondary } as React.CSSProperties}
              onClick={onClose}
              aria-label="关闭"
            >
              关闭
            </button>
            <button
              style={{ ...dialogStyle.btn, ...dialogStyle.btnPrimary } as React.CSSProperties}
              onClick={handleDownload}
              aria-label="下载诊断日志"
            >
              下载诊断日志
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
}
