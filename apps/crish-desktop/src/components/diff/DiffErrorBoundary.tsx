import React, { Component, type ReactNode } from 'react';
import { Button } from '../ui';

interface Props {
  children: ReactNode;
  title?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class DiffErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[DiffErrorBoundary] Error in diff render:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '16px', color: 'var(--text-secondary)' }}>
          <div>{this.props.title || 'Diff Error'}</div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => this.setState({ hasError: false })}
            style={{ marginTop: '8px' }}
          >
            Retry
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
