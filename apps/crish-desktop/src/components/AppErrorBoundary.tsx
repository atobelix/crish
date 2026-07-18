/**
 * 顶层错误边界：避免未捕获渲染错误导致整窗空白。
 * compact 模式用于工作区/面板内嵌，避免 min-height:100vh 撑破布局。
 */
import React from 'react';
import styles from './AppErrorBoundary.module.css';

type Props = {
  children: React.ReactNode;
  /** 标题；compact 默认「此面板出错」，否则「界面出错了」 */
  title?: string;
  /** 自定义恢复：不刷新整页时调用（如重开设置） */
  onReset?: () => void;
  /** 紧凑模式：面板内嵌，主按钮为重试 */
  compact?: boolean;
};

type State = {
  error: Error | null;
};

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/** 展示真实错误文案（含 ReferenceError 名），避免空白「出错了」 */
function formatErrorMessage(error: Error): string {
  const msg = (error.message || String(error)).trim() || '未知渲染错误';
  const name = error.name && error.name !== 'Error' ? error.name : '';
  // ReferenceError: activeLabel is not defined 等需完整可见
  if (name && !msg.startsWith(name)) return `${name}: ${msg}`;
  return msg;
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: toError(error) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[crish] render crash', error, info.componentStack);
  }

  private reload = () => {
    this.setState({ error: null });
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  };

  private dismiss = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = formatErrorMessage(this.state.error);
    const compact = !!this.props.compact;
    const title =
      this.props.title || (compact ? '此面板出错' : '界面出错了');

    return (
      <div
        className={
          compact ? `${styles.appErrorBoundary} ${styles.appErrorBoundaryCompact}` : styles.appErrorBoundary
        }
      >
        <div className={compact ? `${styles.appErrorCard} ${styles.appErrorCardCompact}` : styles.appErrorCard}>
          <div className={styles.appErrorTitle}>{title}</div>
          <div className={styles.appErrorMsg} role="alert" title={msg}>
            {msg}
          </div>
          <div className={styles.appErrorActions}>
            {compact ? (
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn-primary ui-btn-sm"
                  onClick={this.dismiss}
                >
                  重试
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={this.reload}
                >
                  重新加载
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn-primary ui-btn-sm"
                  onClick={this.reload}
                >
                  重新加载
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={this.dismiss}
                >
                  {this.props.onReset ? '重试' : '尝试恢复'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
}
