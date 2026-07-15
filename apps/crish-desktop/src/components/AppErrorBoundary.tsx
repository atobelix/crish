/**
 * 顶层错误边界：避免未捕获渲染错误导致整窗空白。
 */
import React from 'react';

type Props = { children: React.ReactNode };

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
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error.message || String(this.state.error);
    return (
      <div className="app-error-boundary">
        <div className="app-error-card">
          <div className="app-error-title">界面出错了</div>
          <div className="app-error-msg">{msg}</div>
          <div className="app-error-actions">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={this.reload}>
              重新加载
            </button>
            <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={this.dismiss}>
              尝试恢复
            </button>
          </div>
        </div>
      </div>
    );
  }
}
