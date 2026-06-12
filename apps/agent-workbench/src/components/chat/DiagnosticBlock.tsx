/**
 * DiagnosticBlock - 后台/传输错误诊断展现组件
 */

import { useState } from 'preact/hooks';
import { tauriBridge } from '../../core/tauri-bridge';
import { showToast } from '../ToastContainer';
import { IconAlertTriangle, IconRefresh, IconSpinner } from '../icons';

export function DiagnosticBlock({ content, title = '后台或传输错误' }: { content: string; title?: string }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'failed'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleRestart = async () => {
    setLoading(true);
    setStatus('idle');
    try {
      await tauriBridge.restartDaemon();
      setStatus('success');
      showToast('后台服务已重新启动！', 'success');
    } catch (e: unknown) {
      console.error(e);
      setStatus('failed');
      setErrorMessage((e as Error)?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="repl-daemon-error-card">
      <div class="repl-daemon-error-header">
        <IconAlertTriangle class="repl-daemon-error-icon" />
        <div class="repl-daemon-error-title">{title}</div>
      </div>
      <div class="repl-daemon-error-body">
        <p>Crish 收到了后台、模型网关或传输层错误。详细内容已收进诊断块，避免挤占消息流。</p>
        <details class="repl-daemon-error-details">
          <summary>查看详细诊断日志 (Diagnostic Logs)</summary>
          <pre class="repl-daemon-error-pre"><code>{content}</code></pre>
        </details>
        <div class="repl-daemon-error-actions">
          <button class="repl-daemon-restart-btn" onClick={handleRestart} disabled={loading}>
            {loading ? (
              <><IconSpinner class="spin-icon repl-mr-sm" />正在启动...</>
            ) : (
              <><IconRefresh class="repl-mr-sm" />重新启动后台 (Restart Daemon)</>
            )}
          </button>
          {status === 'success' && <span class="repl-daemon-status-text success">启动成功！请尝试发送消息。</span>}
          {status === 'failed' && <span class="repl-daemon-status-text error">启动失败: {errorMessage}</span>}
        </div>
      </div>
    </div>
  );
}