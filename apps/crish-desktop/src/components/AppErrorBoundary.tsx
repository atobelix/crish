/**
 * 顶层错误边界：避免未捕获渲染错误导致整窗空白。
 * compact 模式用于工作区/面板内嵌，避免 min-height:100vh 撑破布局。
 */
import React from 'react';

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

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
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

    const msg = this.state.error.message || String(this.state.error);
    const compact = !!this.props.compact;
    const title =
      this.props.title || (compact ? '此面板出错' : '界面出错了');

    return (
      <div
        className={
          compact ? 'app-error-boundary app-error-boundary--compact' : 'app-error-boundary'
        }
      >
        <div className={compact ? 'app-error-card app-error-card--compact' : 'app-error-card'}>
          <div className="app-error-title">{title}</div>
          <div className="app-error-msg">{msg}</div>
          <div className="app-error-actions">
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
